/* Which classes can drop their reference-count word (see
 * out/unique-ownership/DESIGN.md).
 *
 * An instance of a TREE CLASS is a node of a graph that is
 *   - acyclic: no node reaches itself;
 *   - untraced: no cycle analysis unit holding it is on a potential cycle;
 *   - singly owned: one field, local or caller holds the node, and every
 *     other reference to it is a borrow that outlives nothing; and
 *   - unobserved: no published, dynamic, threaded or global slot can see it.
 *
 * Such a node needs no reference count: its retain is a no-op and the single
 * owner's release destroys the whole subtree it reaches, iteratively. The
 * layout then costs only the payload, and an immutable leaf-heavy graph --
 * binary trees, ASTs, cons lists -- drops one word per node.
 *
 * The backend lowers a class this way only when BOTH analyses below accept
 * it. Analysis A is local and structural; analysis B is whole-program and
 * linear. Every rule fails toward keeping the ordinary counted layout, so a
 * program the analysis does not understand compiles exactly as it does
 * today.
 *
 * Analysis B is deliberately small: it recognizes the ownership vocabulary
 * of the IR (allocation, owning call, move into a field, move out through a
 * return, borrow for a read) and rejects every other position that could
 * produce or duplicate a reference. Wrappers that do not change ownership
 * (union boxing, upcasts) are transparent. */
import type {
  IrExpr,
  IrFunction,
  IrLocal,
  IrModule,
  IrStmt,
  IrType,
  IrUnionDef,
} from "../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../ir/traverse.js";
import { computeTraced } from "./cycle-analysis.js";
import { constructorEscapePoint } from "./cycle-mutability.js";
import { computeImmutableFields, type ImmutableFields } from "./immutability.js";
import { computePublishedTypes, type PublishedTypes } from "./publication.js";

export interface TreeClassPlan {
  /** Classes lowered without a reference-count word, in module order. */
  classes: ReadonlySet<string>;
  /** The varRef expressions that transfer a node out of its local: the
   * emitter stores null in the source slot and takes the value without a
   * retain (llvm/emitter.ts takeLastUseMove), exactly as its own last-use
   * move does. */
  moves: ReadonlySet<IrExpr>;
  /** Why each rejected class kept the counted layout, in module order.
   * Diagnostics and tests only: the lowering never reads them. */
  rejected: ReadonlyMap<string, readonly string[]>;
}

/** Facts the emitter already computes for the ordinary ownership
 * discipline; the linear-use analysis must agree with them or it is wrong. */
export interface TreeClassFacts {
  /** analyzeCallLifetimes(...).borrowed: the parameters a callee reads
   * without ever releasing, so callers pass a borrow. A parameter absent
   * from a callee's set is consumed by the callee. */
  borrowed: ReadonlyMap<string, ReadonlySet<number>>;
  /** Functions whose result is borrowed from an argument rather than
   * owned (receivers.ts). A tree class they return would have an alias, so
   * the class keeps the counted layout. */
  borrowedReturns?: ReadonlySet<string>;
  /** computeTraced(mod): the callers that have it pass it in. */
  traced?: { shapes: ReadonlySet<string>; unions: ReadonlySet<string> };
  /** computeImmutableFields(mod). */
  immutable?: ImmutableFields | null;
  /** computePublishedTypes(mod). */
  published?: PublishedTypes | null;
}

/** Every class name that passes both analyses, plus one rejection reason
 * list per class name that was considered. Pure: reads `mod` only. */
export function planTreeClasses(mod: IrModule, facts: TreeClassFacts): TreeClassPlan {
  const rejected = new Map<string, string[]>();
  const classes = new Set<string>();
  const moves = new Set<IrExpr>();
  if (mod.lib !== undefined) return { classes, moves, rejected };
  const defs = mod.classes ?? [];
  const unions = new Map<string, IrUnionDef>((mod.unions ?? []).map((u) => [u.id, u] as const));
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn] as const));
  const traced = facts.traced ?? computeTraced(mod);
  const immutable = facts.immutable !== undefined ? facts.immutable : computeImmutableFields(mod);
  const published = facts.published !== undefined ? facts.published : computePublishedTypes(mod);
  const lifetime = new Set(mod.contracts?.programLifetime ?? []);
  const bases = new Set(defs.flatMap((d) => (d.base === undefined ? [] : [d.base])));
  // The slots and functions that mention each class, found in one walk of
  // the module when the first class asks. Asking every slot about every
  // class instead is a walk of the module per class: 30 s of the compiler's
  // own build. A module none of whose classes gets that far is not walked.
  const reach = new MentionedClasses(unions);
  let index: MentionIndex | null = null;
  const mentioned = (): MentionIndex => (index ??= indexMentions(mod, reach));

  for (const def of defs) {
    if (def.runtime === true) continue;
    const name = def.name;
    const reasons: string[] = [];
    const reject = (why: string): void => {
      if (reasons.length < 4) reasons.push(why);
    };
    const finish = (): void => {
      if (reasons.length === 0) classes.add(name);
      else rejected.set(name, reasons);
    };

    // ── Analysis A: the shape of the class itself ───────────────────────
    if (def.base !== undefined || bases.has(name)) reject("is part of a hierarchy");
    if (def.arrayElem !== undefined) reject("extends Array");
    if (def.localCaptures !== undefined) reject("is declared inside a function");
    if (lifetime.has(name)) reject("implements ProgramLifetime");
    if (def.fields.length === 0) reject("declares no fields");
    if (traced.shapes.has(`object:${name}`)) reject("is on a cycle or reaches one");
    if (published?.classGuarded(name) === true) reject("is published to package code");
    if (mod.declBoundary === true) reject("the module boxes values at declaration boundaries");
    if (reasons.length > 0) {
      finish();
      continue;
    }

    // Reference fields must be written by the constructor alone: a node
    // that can be rewired after construction can gain a second owner.
    for (const field of def.fields) {
      if (!reach.mentions(field.type, name)) continue;
      if (immutable?.classField(name, field.name) !== true)
        reject(`field ${field.name} is written after construction`);
    }

    // Only a constructor that never lets `this` out can be a node: every
    // other path out of it would give the object a second owner.
    const ctor = functions.get(`%${name}.constructor`);
    if (ctor === undefined) reject("has no constructor body");
    else {
      const thisId = ctor.params[0]?.localId;
      if (thisId === undefined) reject("has a constructor without this");
      else if (constructorEscaped(ctor, thisId, null)) reject("its constructor lets this escape");
      // A constructor whose body owns its `this` releases it on exit, which
      // would destroy an instance its `new` expression still owns.
      if (facts.borrowed.get(`%${name}.constructor`)?.has(0) !== true)
        reject("its constructor body owns this");
    }

    // ── Analysis A: every type in the module that mentions the class ────
    for (const slot of mentioned().slots.get(name) ?? []) {
      const shape = treeShape(slot.type, name, unions);
      if (shape === null) {
        reject(`${slot.where} holds it in a type that is neither the class nor null or it`);
        continue;
      }
      if (shape === "nullable" && traced.unions.has(unionIdOf(slot.type))) {
        reject(`${slot.where} boxes it in a union that can reach a cycle`);
        continue;
      }
      if (!treeSlot(slot, name))
        reject(`${slot.where} lets a reference escape the tree discipline`);
    }
    if (reasons.length > 0) {
      finish();
      continue;
    }

    // ── Analysis B: whole-program linear use ───────────────────────────
    // A function none of whose slots mentions the class has no tree local,
    // no tree result and no expression that holds a node, which is where
    // the linear-use check of a function returns before it looks further.
    const check = new LinearUse(name, reach, functions, facts);
    for (const fn of mentioned().functions.get(name) ?? []) check.function(fn);
    for (const why of check.reasons()) reject(why);
    finish();
    if (classes.has(name)) for (const move of check.moves()) moves.add(move);
  }
  return { classes, moves, rejected };
}

/** The position a type occupies in the module. Only the slots in
 * `treeSlot` may mention a tree class. */
interface TypeSlot {
  type: IrType;
  where: string;
  slot: "expr" | "classField" | "recordField" | "global" | "param" | "local" | "result" | "capture";
  /** The class declaring a classField slot. */
  owner?: string;
}

function treeSlot(slot: TypeSlot, name: string): boolean {
  switch (slot.slot) {
    // Values in flight: parameters arrive owned or borrowed, locals hold an
    // owner for their scope, and a result leaves through a move.
    case "expr":
    case "param":
    case "local":
    case "result":
      return true;
    // Only the class's own fields may point at its nodes. Another class or
    // record field would be a second owner the destroy walk cannot follow
    // (it walks one shape), so the class stays counted.
    case "classField":
      return slot.owner === name;
    case "recordField":
    case "global":
    case "capture":
      return false;
  }
}

/** `object:C`, `C | null`, or null when the type is anything else. */
function treeShape(
  type: IrType,
  name: string,
  unions: ReadonlyMap<string, IrUnionDef>,
): "object" | "nullable" | null {
  if (type.kind === "object") return type.className === name ? "object" : null;
  if (type.kind !== "union") return null;
  const arms = unions.get(type.unionId)?.arms;
  if (arms === undefined || arms.length !== 2) return null;
  let object = false;
  let nulled = false;
  for (const arm of arms) {
    if (arm.kind === "nullT") nulled = true;
    else if (arm.kind === "object" && arm.className === name) object = true;
    else return null;
  }
  return object && nulled ? "nullable" : null;
}

function unionIdOf(type: IrType): string {
  return type.kind === "union" ? type.unionId : "";
}

const NO_CLASSES: ReadonlySet<string> = new Set();

/** The classes a value of a type can lead to: directly, through a union
 * arm, or through a container, closure or generator slot. A record is not
 * looked into: its fields are slots of their own. A union's answer is kept
 * by its id and a class's by its name, so most types cost a lookup.
 *
 * A union can reach itself through a container (`type Json = string |
 * Json[]`). The walk of a union does not enter a union it is already inside,
 * which is being collected by the same walk. What it then returns for an
 * inner union lacks whatever the enclosing union adds, so such an answer is
 * not kept: only the union the walk started from, or one whose walk met no
 * union it was inside, is complete.
 *
 * Every question the planner asks about a type goes through one instance,
 * so no walk of a type is left that could follow such a union forever. */
class MentionedClasses {
  private readonly ofUnion = new Map<string, ReadonlySet<string>>();
  private readonly ofClass = new Map<string, ReadonlySet<string>>();
  /** The unions the current walk is inside. */
  private readonly inside = new Set<string>();
  /** How often a walk skipped a union it was inside. */
  private skipped = 0;

  constructor(private readonly unions: ReadonlyMap<string, IrUnionDef>) {}

  /** Whether a value of this type can lead to an instance of `name`. */
  mentions(type: IrType, name: string): boolean {
    if (type.kind === "object" || type.kind === "classval") return type.className === name;
    return this.of(type).has(name);
  }

  of(type: IrType): ReadonlySet<string> {
    switch (type.kind) {
      case "object":
      case "classval": {
        let only = this.ofClass.get(type.className);
        if (only === undefined) {
          only = new Set([type.className]);
          this.ofClass.set(type.className, only);
        }
        return only;
      }
      case "union": {
        const known = this.ofUnion.get(type.unionId);
        if (known !== undefined) return known;
        if (this.inside.has(type.unionId)) {
          this.skipped++;
          return NO_CLASSES;
        }
        const arms = this.unions.get(type.unionId)?.arms;
        if (arms === undefined) {
          this.ofUnion.set(type.unionId, NO_CLASSES);
          return NO_CLASSES;
        }
        const outermost = this.inside.size === 0;
        const skippedBefore = this.skipped;
        this.inside.add(type.unionId);
        const found = this.ofAll(arms);
        this.inside.delete(type.unionId);
        if (outermost || this.skipped === skippedBefore) this.ofUnion.set(type.unionId, found);
        return found;
      }
      case "array":
        return this.of(type.elem);
      case "map":
        return eitherClasses(this.of(type.key), this.of(type.value));
      case "set":
        return this.of(type.elem);
      case "promise":
        return this.of(type.inner);
      case "func":
        return eitherClasses(this.ofAll(type.params), this.of(type.ret));
      case "generator":
        return eitherClasses(
          eitherClasses(this.of(type.yieldT), this.of(type.retT)),
          this.of(type.nextT),
        );
      default:
        return NO_CLASSES;
    }
  }

  private ofAll(types: readonly IrType[]): ReadonlySet<string> {
    let found = NO_CLASSES;
    for (const type of types) found = eitherClasses(found, this.of(type));
    return found;
  }
}

/** The classes of both sets, as one of them when the other adds nothing. */
function eitherClasses(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  if (b.size === 0 || a === b) return a;
  if (a.size === 0) return b;
  let grown: Set<string> | null = null;
  for (const name of b) {
    if (a.has(name)) continue;
    grown ??= new Set(a);
    grown.add(name);
  }
  return grown ?? a;
}

/** Whether `this` leaves the constructor for anywhere but a field of the
 * object under construction. cycle-mutability's escape point is the index
 * of the first body statement after which it did, so only a whole-body
 * answer means it never did. */
function constructorEscaped(fn: IrFunction, thisId: string, baseCtor: string | null): boolean {
  return constructorEscapePoint(fn, thisId, baseCtor) < fn.body.length;
}

/** A fresh value: allocated here or returned owned by a call. It has no
 * owner yet, so it may be moved, or destroyed when the statement ends. */
type Provenance = "fresh" | "owned" | "borrowed" | "pending" | "none";

/** What a local holds. `pending` is a constructor parameter: the call that
 * created the object owns it until the body stores it in a field. */
type LocalState = "owned" | "borrowed" | "pending" | "moved";

const MAX_REASONS = 4;

/** Linear use, one class at a time, over every function in the module.
 * State is per local and per straight-line region; branch and loop bodies
 * must leave the state of the locals they did not declare unchanged. */
class LinearUse {
  private readonly found: string[] = [];
  private readonly treeLocals = new Map<string, IrLocal>();
  private readonly moved: IrExpr[] = [];
  private fn: IrFunction | null = null;

  constructor(
    private readonly cls: string,
    private readonly reach: MentionedClasses,
    private readonly functions: ReadonlyMap<string, IrFunction>,
    private readonly facts: TreeClassFacts,
  ) {}

  reasons(): readonly string[] {
    return this.found;
  }

  /** The varRef reads that took a node out of a local (see TreeClassPlan). */
  moves(): readonly IrExpr[] {
    return this.moved;
  }

  private fail(what: string): null {
    if (this.found.length < MAX_REASONS) {
      this.found.push(`${this.fn?.name ?? "module"}: ${what}`);
    }
    return null;
  }

  private tree(type: IrType): boolean {
    return this.reach.mentions(type, this.cls);
  }

  function(fn: IrFunction): void {
    this.fn = fn;
    this.treeLocals.clear();
    for (const local of fn.locals) if (this.tree(local.type)) this.treeLocals.set(local.id, local);
    // A function with no tree local and no tree result can still build or
    // read a node inside an expression; walk it when the body mentions the
    // class so the temporary rules reject the class instead of letting the
    // lowering copy a value this analysis never saw moved.
    if (
      this.treeLocals.size === 0 &&
      !this.tree(fn.returnType) &&
      !fn.body.some((stmt) => this.holdsTree(stmt))
    )
      return;
    if (fn.generator !== undefined) {
      this.fail("a generator holds it");
      return;
    }
    if (this.tree(fn.returnType)) {
      const borrowed = this.facts.borrowedReturns;
      if (borrowed?.has(fn.name) === true) this.fail("returns a node it only borrows");
    }
    for (const capture of [...(fn.captures ?? []), ...(fn.classCaptures ?? [])])
      if (this.tree(capture.type)) this.fail("a closure captures it");
    const params = new Set(fn.params.map((param) => param.localId));
    const ctorThis = fn.name === `%${this.cls}.constructor` ? fn.params[0]?.localId : undefined;
    // A tree local that a later assignment could rebind needs the store
    // path the lowering does not have; parameters are the exception, since
    // their binding never changes.
    for (const local of this.treeLocals.values())
      if (!params.has(local.id) && local.mutable) this.fail(`local ${local.id} is rebound`);
    const state = new Map<string, LocalState>();
    const borrowedParams = this.facts.borrowed.get(fn.name);
    for (const [index, param] of fn.params.entries()) {
      if (!this.tree(param.type)) continue;
      // A parameter the callee borrows is a read-only view; one it owns is
      // released at exit unless the body moves it on.
      state.set(
        param.localId,
        param.localId === ctorThis
          ? "borrowed"
          : this.pending(param, fn)
            ? "pending"
            : borrowedParams?.has(index) === true
              ? "borrowed"
              : "owned",
      );
    }
    if (!this.statements(fn.body, state)) return;
    // The `new` expression hands each constructor argument over as an
    // owned child; a parameter the body never stores in a field would leak
    // the subtree it points at.
    for (const [id, held] of state)
      if (held === "pending") this.fail(`constructor parameter ${id} is never stored`);
  }

  /** A constructor parameter other than `this` arrives owned by the new
   * object: the body stores it in a field or destroys it. */
  private pending(param: IrFunction["params"][number], fn: IrFunction): boolean {
    return fn.name === `%${this.cls}.constructor` && param.localId !== fn.params[0]?.localId;
  }

  private statements(list: IrStmt[], state: Map<string, LocalState>): boolean {
    for (const stmt of list) if (!this.statement(stmt, state)) return false;
    return true;
  }

  private statement(stmt: IrStmt, state: Map<string, LocalState>): boolean {
    switch (stmt.kind) {
      case "varDecl": {
        if (!this.tree(this.treeLocals.get(stmt.localId)?.type ?? NO_TYPE)) {
          return stmt.init === null ? true : this.expr(stmt.init, "borrow", state) !== null;
        }
        if (stmt.init === null)
          return this.fail(`local ${stmt.localId} is declared without a value`) !== null;
        const provenance = this.expr(stmt.init, "move", state);
        if (provenance === null) return false;
        if (provenance === "borrowed")
          return this.fail(`local ${stmt.localId} aliases a node it does not own`) !== null;
        state.set(stmt.localId, "owned");
        return true;
      }
      case "assign": {
        if (this.treeLocals.has(stmt.localId) || this.tree(stmt.value.type))
          return this.fail("a tree local is assigned a second value") !== null;
        return this.expr(stmt.value, "borrow", state) !== null;
      }
      case "exprStmt": {
        // A statement that drops its value keeps only what it allocated;
        // a node read out of a local or a field would be destroyed while
        // its owner still holds it.
        const provenance = this.expr(stmt.expr, "borrow", state);
        if (provenance === null) return false;
        if (provenance === "fresh" || provenance === "none") return true;
        return this.fail("drops a node it does not own") !== null;
      }
      case "if": {
        if (!this.borrowOnly(stmt.cond, state)) return false;
        const then = new Map(state);
        if (!this.statements(stmt.then, then)) return false;
        const otherwise = stmt.else_ === null ? state : new Map(state);
        if (stmt.else_ !== null && !this.statements(stmt.else_, otherwise)) return false;
        return this.join(state, then, otherwise);
      }
      case "block":
        return this.statements(stmt.body, state);
      case "while":
      case "doWhile": {
        if (stmt.kind === "while" && !this.borrowOnly(stmt.cond, state)) return false;
        const body = new Map(state);
        if (!this.statements(stmt.body, body)) return false;
        if (stmt.kind === "doWhile" && !this.borrowOnly(stmt.cond, body)) return false;
        return this.join(state, state, body);
      }
      case "for": {
        const body = new Map(state);
        if (stmt.init !== null && !this.statement(stmt.init, body)) return false;
        if (stmt.cond !== null && !this.borrowOnly(stmt.cond, body)) return false;
        if (stmt.update !== null && !this.statement(stmt.update, body)) return false;
        if (!this.statements(stmt.body, body)) return false;
        return this.join(state, state, body);
      }
      case "switch": {
        // A discriminant is compared by value; a node has no such compare.
        if (this.tree(stmt.disc.type)) return this.fail("switches on a node") !== null;
        if (!this.borrowOnly(stmt.disc, state)) return false;
        for (const arm of stmt.cases) {
          if (arm.test !== null && this.tree(arm.test.type))
            return this.fail("compares a node in a case label") !== null;
          if (arm.test !== null && !this.borrowOnly(arm.test, state)) return false;
          const body = new Map(state);
          if (!this.statements(arm.body, body)) return false;
          if (!this.join(state, state, body)) return false;
        }
        return true;
      }
      case "forOf": {
        if (this.tree(stmt.iterable.type))
          return this.fail("iterates a value that holds it") !== null;
        if (!this.expr(stmt.iterable, "borrow", state)) return false;
        const body = new Map(state);
        if (!this.statements(stmt.body, body)) return false;
        return this.join(state, state, body);
      }
      case "fieldSet": {
        if (!this.expr(stmt.obj, "borrow", state)) return false;
        if (!this.tree(stmt.value.type)) return this.expr(stmt.value, "borrow", state) !== null;
        const provenance = this.expr(stmt.value, "move", state);
        if (provenance === null) return false;
        if (provenance === "borrowed")
          return (
            this.fail(`field ${stmt.field} takes a node from a field it does not own`) !== null
          );
        return true;
      }
      case "return": {
        if (stmt.value === null || !this.tree(stmt.value.type))
          return stmt.value === null || this.expr(stmt.value, "borrow", state) !== null;
        if (!this.tree(this.fn?.returnType ?? NO_TYPE))
          return this.fail("returns a node from a function that does not declare one") !== null;
        const provenance = this.expr(stmt.value, "move", state);
        if (provenance === null) return false;
        if (provenance === "borrowed") return this.fail("returns a node it only borrows") !== null;
        return true;
      }
      case "throw":
        if (this.tree(stmt.value.type)) return this.fail("throws a node") !== null;
        return this.expr(stmt.value, "borrow", state) !== null;
      case "tryCatch":
        // A catch, a finally or a disposal can run with a partially
        // transferred owner; the store path the lowering adds does not
        // unwind. Keep the class counted instead.
        if (this.holdsTree(stmt)) return this.fail("a try statement holds one") !== null;
        return true;
      case "recordSet":
      case "recordKeySet":
      case "recordKeyDelete":
      case "arraySet":
      case "arraySetLength":
      case "arraySetUndefined":
      case "arrayDelete":
      case "bytesSet":
        if (this.holdsTree(stmt)) return this.fail(`a ${stmt.kind} holds one`) !== null;
        return true;
      default:
        // Everything else either touches no tree value or does so in a
        // position this analysis does not model.
        return this.holdsTree(stmt)
          ? this.fail(`a ${stmt.kind} statement holds one`) !== null
          : true;
    }
  }

  /** Branch or loop merge: the state of every local that existed before the
   * region must be the same on every path out of it. The agreed state becomes
   * the state after the region, so a local both branches moved stays moved.
   * Locals the region declared are scoped to it (each iteration allocates a
   * fresh object). */
  private join(
    before: Map<string, LocalState>,
    a: Map<string, LocalState>,
    b: Map<string, LocalState>,
  ): boolean {
    for (const [id, was] of before) {
      const left = a.get(id) ?? was;
      const right = b.get(id) ?? was;
      if (left === right) {
        before.set(id, left);
        continue;
      }
      return this.fail(`local ${id} is transferred on only one path`) !== null;
    }
    return true;
  }

  private borrowOnly(expr: IrExpr, state: Map<string, LocalState>): boolean {
    return this.expr(expr, "borrow", state) !== null;
  }

  private expr(
    expr: IrExpr,
    mode: "move" | "borrow",
    state: Map<string, LocalState>,
  ): Provenance | null {
    switch (expr.kind) {
      case "varRef": {
        if (!this.tree(expr.type)) return "none";
        const held = state.get(expr.localId);
        if (held === undefined || held === "moved")
          return this.fail(`local ${expr.localId} is used after it was moved`);
        if (mode === "borrow") return held === "pending" ? "borrowed" : held;
        if (held === "borrowed")
          return this.fail(`local ${expr.localId} is moved but only borrowed`);
        this.moved.push(expr);
        state.set(expr.localId, "moved");
        return held === "pending" ? "pending" : "owned";
      }
      case "new": {
        const involves = this.tree(expr.type) || expr.args.some((arg) => this.tree(arg.type));
        if (!involves) {
          for (const arg of expr.args) if (!this.borrowOnly(arg, state)) return null;
          return "none";
        }
        if (expr.className !== this.cls)
          return this.fail(`another class's constructor, ${expr.className}, holds it`);
        for (const arg of expr.args) {
          if (!this.tree(arg.type)) {
            if (!this.borrowOnly(arg, state)) return null;
            continue;
          }
          const provenance = this.expr(arg, "move", state);
          if (provenance === null) return null;
          if (provenance === "borrowed")
            return this.fail(`an argument from a field becomes a second owner`);
        }
        return "fresh";
      }
      case "call": {
        const consumes = expr.args.some((arg) => this.tree(arg.type));
        if (!this.tree(expr.type) && !consumes) {
          for (const arg of expr.args) if (!this.borrowOnly(arg, state)) return null;
          return "none";
        }
        const callee = this.functions.get(expr.callee);
        if (callee === undefined)
          return this.fail(`callee ${expr.callee} is not a module function`);
        // A borrowed-return helper hands back a reference it does not own;
        // the caller would treat it as a fresh node.
        if (this.tree(expr.type) && this.facts.borrowedReturns?.has(expr.callee) === true)
          return this.fail(`callee ${expr.callee} lends the node it returns`);
        const borrowed = this.facts.borrowed.get(expr.callee);
        for (let i = 0; i < expr.args.length; i++) {
          const arg = expr.args[i]!;
          if (!this.tree(arg.type)) {
            if (!this.borrowOnly(arg, state)) return null;
            continue;
          }
          const borrows = borrowed?.has(i) === true;
          const provenance = this.expr(arg, borrows ? "borrow" : "move", state);
          if (provenance === null) return null;
          if (!borrows && provenance === "borrowed")
            return this.fail(`callee ${expr.callee} consumes a node that comes from a field`);
        }
        return this.tree(expr.type) ? "fresh" : "none";
      }
      case "fieldGet": {
        if (this.tree(expr.obj.type)) {
          const provenance = this.expr(expr.obj, "borrow", state);
          if (provenance === null) return null;
          if (provenance === "fresh")
            return this.fail(`field ${expr.field} is read from a node the statement owns`);
        } else if (!this.borrowOnly(expr.obj, state)) return null;
        return this.tree(expr.type) ? "borrowed" : "none";
      }
      // Wrappers that move no ownership: unboxing, narrowing, upcasts and
      // the tag test of a nullable slot.
      case "unionWrap":
      case "unionNarrow":
      case "upcast":
        if (expr.value.kind === "unitLit") return "none";
        return this.expr(expr.value, mode, state);
      case "unionIsTag": {
        const provenance = this.expr(expr.value, "borrow", state);
        return provenance === null ? null : "none";
      }
      // Arithmetic and condition combining: the operands are read, never
      // moved, and the result is a scalar.
      case "logical":
        if (!this.borrowOnly(expr.left, state) || !this.borrowOnly(expr.right, state)) return null;
        return "none";
      case "bin":
        if (this.tree(expr.type)) return this.fail("an operator produces it");
        if (!this.borrowOnly(expr.left, state) || !this.borrowOnly(expr.right, state)) return null;
        return "none";
      // Scalar operations over values that may be computed from a node
      // (`nodeCount(build(d))`): the operands are read and the result is a
      // number, a string or a bool. None of these can retain a node.
      case "toString":
        if (this.tree(expr.operand.type)) return this.fail("converts a node to text");
        return this.borrowOnly(expr.operand, state) ? "none" : null;
      case "strConcat":
      case "strEq":
      case "strCmp":
        if (!this.borrowOnly(expr.left, state) || !this.borrowOnly(expr.right, state)) return null;
        return "none";
      case "intrinsic":
      case "libCall":
        for (const arg of expr.args) {
          if (this.tree(arg.type)) return this.fail(`a ${expr.kind} takes a node by value`);
          if (!this.borrowOnly(arg, state)) return null;
        }
        return this.tree(expr.type) ? this.fail(`a ${expr.kind} produces one`) : "none";
      case "seqExpr": {
        for (const stmt of expr.stmts) if (!this.statement(stmt, state)) return null;
        return this.expr(expr.result, mode, state);
      }
      case "unitLit":
        return "none";
      default:
        return this.holdsTree(expr) ? this.fail(`a ${expr.kind} expression holds one`) : "none";
    }
  }

  /** Whether the value or any value inside it can reach a node. */
  private holdsTree(node: IrExpr | IrStmt): boolean {
    let found = false;
    const exprVisitor = (e: IrExpr): boolean => {
      if (this.tree(e.type)) {
        found = true;
        return false;
      }
      return everyExprChild(e, exprVisitor, stmtVisitor);
    };
    const stmtVisitor = (s: IrStmt): boolean =>
      !found && everyStmtChild(s, exprVisitor, stmtVisitor);
    if (isExpr(node)) exprVisitor(node);
    else everyStmtChild(node, exprVisitor, stmtVisitor);
    return found;
  }
}

const NO_TYPE: IrType = { kind: "void" };

/** Every kind of the IR's statement union, which is the only list of them:
 * the traversal walks anything else as an expression, so a statement kind
 * missing here reaches `everyExprChild` as an expression and throws. */
const STATEMENT_KINDS: ReadonlySet<string> = new Set([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "while",
  "doWhile",
  "for",
  "forOf",
  "switch",
  "block",
  "return",
  "throw",
  "tryCatch",
  "break",
  "continue",
  "genBindBarrier",
  "rethrow",
  "runtimeFence",
  "fieldSet",
  "recordSet",
  "recordKeySet",
  "recordKeyDelete",
  "arraySet",
  "arraySetLength",
  "arraySetUndefined",
  "arrayDelete",
  "bytesSet",
]);

function isExpr(node: IrExpr | IrStmt): node is IrExpr {
  return !STATEMENT_KINDS.has(node.kind);
}

/** What mentions each class: its typed slots with where they sit, in module
 * order, and the functions that hold one of them, in module order. Root
 * types only: `MentionedClasses` looks through the containers itself. */
interface MentionIndex {
  slots: ReadonlyMap<string, readonly TypeSlot[]>;
  functions: ReadonlyMap<string, readonly IrFunction[]>;
}

function indexMentions(mod: IrModule, classes: MentionedClasses): MentionIndex {
  const slots = new Map<string, TypeSlot[]>();
  const functions = new Map<string, IrFunction[]>();
  let holder: IrFunction | null = null;
  // `where` arrives in parts and is joined only for a slot that mentions a
  // class: most of a module's slots are expressions that mention none.
  const add: AddSlot = (type, subject, role, detail, slot, owner) => {
    const names = classes.of(type);
    if (names.size === 0) return;
    const where = subject + role + detail;
    const entry: TypeSlot =
      owner === undefined ? { type, where, slot } : { type, where, slot, owner };
    for (const name of names) {
      const list = slots.get(name);
      if (list === undefined) slots.set(name, [entry]);
      else list.push(entry);
      if (holder === null) continue;
      const holders = functions.get(name);
      if (holders === undefined) functions.set(name, [holder]);
      else if (holders[holders.length - 1] !== holder) holders.push(holder);
    }
  };
  for (const fn of mod.functions) {
    holder = fn;
    for (const param of fn.params) add(param.type, fn.name, " parameter ", param.name, "param");
    add(fn.returnType, fn.name, " result", "", "result");
    for (const local of fn.locals) add(local.type, fn.name, " local ", local.name, "local");
    for (const capture of fn.captures ?? [])
      add(capture.type, fn.name, " capture ", capture.name, "capture");
    for (const capture of fn.classCaptures ?? [])
      add(capture.type, fn.name, " class capture ", capture.name, "capture");
    if (fn.generator !== undefined) {
      add(fn.generator.yieldT, fn.name, " yield", "", "capture");
      add(fn.generator.nextT, fn.name, " next", "", "capture");
      add(fn.generator.resultType, fn.name, " generator result", "", "capture");
    }
    for (const stmt of fn.body) exprSlots(stmt, fn.name, add);
  }
  holder = null;
  for (const def of mod.classes ?? []) {
    for (const field of def.fields)
      add(field.type, def.name, " field ", field.name, "classField", def.name);
    for (const capture of def.localCaptures ?? [])
      add(capture.type, def.name, " capture ", capture.name, "capture");
    if (def.arrayElem !== undefined) add(def.arrayElem, def.name, " element", "", "capture");
  }
  for (const record of mod.records ?? [])
    for (const field of record.fields)
      add(field.type, `record ${record.id}`, " field ", field.name, "recordField");
  for (const global of mod.globals ?? []) add(global.type, "global ", global.name, "", "global");
  for (const union of mod.unions ?? [])
    for (const arm of union.arms) add(arm, "union ", union.id, "", "expr");
  return { slots, functions };
}

/** Records one slot: its type, the three parts of where it sits, its kind,
 * and the class declaring a classField slot. */
type AddSlot = (
  type: IrType,
  subject: string,
  role: string,
  detail: string,
  slot: TypeSlot["slot"],
  owner?: string,
) => void;

/** Expression types inside a statement, which must stay in the in-flight
 * forms (the class itself or `C | null`). */
function exprSlots(stmt: IrStmt, where: string, add: AddSlot): boolean {
  const expr = (e: IrExpr): boolean => {
    add(e.type, where, " expression ", e.kind, "expr");
    return everyExprChild(e, expr, stmtVisitor);
  };
  const stmtVisitor = (s: IrStmt): boolean => everyStmtChild(s, expr, stmtVisitor);
  return everyStmtChild(stmt, expr, stmtVisitor);
}
