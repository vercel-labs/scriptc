import {
  typeEquals,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

/** Captures by value.
 *
 * A captured binding lives in a box so that the declaring function and
 * every closure share one mutable variable. A binding that is filled once,
 * before a closure over it is created, and that nothing rebinds afterwards
 * needs no shared cell: the closure can hold a copy of the value, because
 * no code can observe the difference. The environment slot of such a
 * capture holds the value itself (scr_closure.h, "captured values"), and a
 * binding whose every capture is of that kind has no box at all.
 *
 * The IR is unchanged: `boxed` keeps meaning shared-binding semantics, and
 * every IR analysis keeps excluding those locals. This is a storage choice
 * of the backend, beside lazy parameter boxes (lazy-captures.ts) and frame
 * boxes (stack-captures.ts).
 *
 * A local of function F is a stable source when it is boxed, is not a
 * temporal-dead-zone binding, no local class captures it, nothing rebinds
 * it in a body that reaches it through closure captures, and F fills it in
 * one of these ways:
 *
 * - it is a parameter that F never rebinds;
 * - its only declaration has an initializer and is a statement of a list
 *   reached from the body through ordinary nesting (blocks, branches, loop
 *   and try bodies), and F never rebinds it;
 * - its only declaration is empty, in such a list, and its only rebinding
 *   is an assignment that is a later statement of the same list (a nested
 *   function declaration, or `let x; … x = v;`);
 * - it is declared in the head of a `for` and rebound only by that loop's
 *   update clause: each iteration has its own binding, and the update runs
 *   on the next iteration's copy;
 * - it is the binding of a `for … of` statement and nothing else rebinds
 *   it.
 *
 * A closure creation site can copy such a source when the fill has run:
 * the site lies in a statement after the fill statement in that list, or
 * in the loop body for the two loop forms. A site inside the initializer,
 * in the head of the loop, or before the assignment keeps the box (a
 * closure that captures the binding it is stored in, mutually recursive
 * function declarations). Declarations in switch cases and in statements
 * nested in expressions are not sources: dispatch can skip them.
 *
 * Capture `i` of a lifted function G arrives by value when every creation
 * site of G supplies a source that is ready there (a stable local as
 * above, or a capture its creator itself received by value), no site is a
 * signature adapter (the runtime reads an adapter's first capture as a
 * box), and nothing rebinds the capture in G, in the jsval twin that
 * shares G's environment, or below. */
export class ValueCaptures {
  private readonly facts = new Map<string, Facts>();
  private readonly slotMemo = new Map<string, ReadonlySet<number>>();
  private readonly quietMemo = new Map<string, boolean>();
  private readonly plainMemo = new Map<string, ReadonlySet<string>>();
  private sites: Map<string, Site[]> | null = null;
  /** A jsval twin (IrFunction.jsEntry) to the closure body it copies. */
  private primaries: Map<string, string> | null = null;

  constructor(
    private readonly functions: ReadonlyMap<string, IrFunction>,
    /** Debug builds keep every binding in its box for the debugger. */
    private readonly enabled: boolean,
  ) {}

  /** The capture indexes of lifted function `fnName` whose environment
   * slot holds the value. */
  slots(fnName: string): ReadonlySet<number> {
    if (!this.enabled) return NONE;
    const primary = this.primaryOf(fnName);
    const known = this.slotMemo.get(primary);
    if (known !== undefined) return known;
    // Capture chains follow lexical nesting and cannot cycle; the empty
    // provisional entry only bounds work on malformed input.
    this.slotMemo.set(primary, NONE);
    const result = this.computeSlots(primary);
    this.slotMemo.set(primary, result);
    return result;
  }

  /** The environment of lifted function `fnName`, or null when it holds
   * only boxes. */
  layout(fnName: string): EnvironmentLayout | null {
    const slots = this.slots(fnName);
    if (slots.size === 0) return null;
    const captures = this.functions.get(this.primaryOf(fnName))!.captures!;
    const layout: EnvironmentLayout = { boxes: 0, references: [], scalars: [], slots: [] };
    captures.forEach((capture, index) => {
      if (!slots.has(index)) {
        layout.slots.push({ kind: "box", index: layout.boxes++ });
      } else if (capture.type.kind === "bool") {
        layout.slots.push({ kind: "bool", index: layout.scalars.length });
        layout.scalars.push("i8");
      } else if (capture.type.kind === "f64" || capture.type.kind === "procStream") {
        layout.slots.push({ kind: "f64", index: layout.scalars.length });
        layout.scalars.push("double");
      } else {
        layout.slots.push({ kind: "reference", index: layout.references.length });
        layout.references.push(capture.type);
      }
    });
    return layout;
  }

  /** The bindings of `fn` that need no box: its stable parameters and
   * declared locals whose every capture is by value. A `for … of` binding
   * keeps the box its loop allocates. */
  plain(fn: IrFunction): ReadonlySet<string> {
    if (!this.enabled) return NO_IDS;
    const known = this.plainMemo.get(fn.name);
    if (known !== undefined) return known;
    const facts = this.factsOf(fn);
    const result = new Set<string>();
    for (const local of fn.locals) {
      if (local.boxed !== true || local.tdz === true) continue;
      const kind = this.stableKind(fn, facts, local);
      if (kind === null || kind === "forOf") continue;
      const edges = facts.edges.get(local.id);
      if (edges?.every((edge) => this.slots(edge.target).has(edge.index)) === false) continue;
      result.add(local.id);
    }
    const plain = result.size > 0 ? result : NO_IDS;
    this.plainMemo.set(fn.name, plain);
    return plain;
  }

  /** The captures of `fn` it receives by value and hands on as a box: a
   * nested closure whose own slot is a box needs one made from the value. */
  boxedOnDemand(fn: IrFunction): string[] {
    const slots = this.slots(fn.name);
    if (slots.size === 0) return [];
    const facts = this.factsOf(fn);
    const ids: string[] = [];
    (fn.captures ?? []).forEach((capture, index) => {
      if (!slots.has(index)) return;
      const edges = facts.edges.get(capture.localId);
      if (edges?.some((edge) => !this.slots(edge.target).has(edge.index)) === true)
        ids.push(capture.localId);
    });
    return ids;
  }

  private primaryOf(fnName: string): string {
    if (this.primaries === null) {
      this.primaries = new Map();
      for (const fn of this.functions.values())
        if (fn.jsEntry !== undefined) this.primaries.set(fn.jsEntry, fn.name);
    }
    return this.primaries.get(fnName) ?? fnName;
  }

  private creationSites(): Map<string, Site[]> {
    if (this.sites !== null) return this.sites;
    const sites = new Map<string, Site[]>();
    for (const fn of this.functions.values()) {
      for (const site of this.factsOf(fn).sites) {
        let list = sites.get(site.target);
        if (list === undefined) sites.set(site.target, (list = []));
        list.push(site);
      }
    }
    this.sites = sites;
    return sites;
  }

  private computeSlots(fnName: string): ReadonlySet<number> {
    const fn = this.functions.get(fnName);
    const captures = fn?.captures;
    if (fn === undefined || captures === undefined || captures.length === 0) return NONE;
    const sites = this.creationSites().get(fnName);
    if (sites === undefined || sites.some((site) => site.adapts)) return NONE;
    // One local per environment slot: two slots feeding one local would
    // need one storage form for both.
    if (new Set(captures.map((c) => c.localId)).size !== captures.length) return NONE;
    const twin = fn.jsEntry === undefined ? undefined : this.functions.get(fn.jsEntry);
    if (fn.jsEntry !== undefined && twin?.captures?.length !== captures.length) return NONE;
    const locals = new Map(fn.locals.map((local) => [local.id, local]));
    const classCaptures = new Set((fn.classCaptures ?? []).map((c) => c.localId));
    const result = new Set<number>();
    captures.forEach((capture, index) => {
      const local = locals.get(capture.localId);
      if (local === undefined || local.tdz === true || classCaptures.has(capture.localId)) return;
      if (capture.type.kind === "caught" || !typeEquals(local.type, capture.type)) return;
      if (!this.quiet(fnName, capture.localId)) return;
      if (twin !== undefined && !this.quiet(twin.name, twin.captures![index]!.localId)) return;
      for (const site of sites) {
        const source = site.captures[index];
        if (source === undefined || !this.ready(site, source, capture)) return;
      }
      result.add(index);
    });
    return result.size > 0 ? result : NONE;
  }

  /** Whether `site` can copy binding `source` of its owner into a slot of
   * `capture`'s type. */
  private ready(site: Site, source: string, capture: { type: IrLocal["type"] }): boolean {
    const owner = this.functions.get(site.owner);
    if (owner === undefined) return false;
    const facts = this.factsOf(owner);
    const received = facts.captureIndex.get(source);
    if (received !== undefined) {
      const type = facts.locals.get(source)?.type;
      return (
        type !== undefined && typeEquals(type, capture.type) && this.slots(site.owner).has(received)
      );
    }
    if (site.early?.has(source) === true) return false;
    const local = facts.locals.get(source);
    if (local === undefined || local.boxed !== true || local.tdz === true) return false;
    if (!typeEquals(local.type, capture.type)) return false;
    return this.stableKind(owner, facts, local) !== null;
  }

  /** How `fn` fills its stable local `local`, or null when it is not one. */
  private stableKind(fn: IrFunction, facts: Facts, local: IrLocal): Fill | null {
    const id = local.id;
    if (facts.captureIndex.has(id) || facts.classCaptures.has(id) || facts.classCaptured.has(id))
      return null;
    if (local.type.kind === "caught") return null;
    const rebinds = facts.rebinds.get(id) ?? 0;
    const declaration = facts.declarations.get(id);
    let kind: Fill;
    if (facts.params.has(id)) {
      if (declaration !== undefined || rebinds !== 0) return null;
      kind = "parameter";
    } else if (declaration === undefined) {
      if (rebinds !== 1 || facts.forOfBindings.get(id) !== 1) return null;
      kind = "forOf";
    } else if (declaration.count !== 1) {
      return null;
    } else if (declaration.head) {
      if (rebinds !== (facts.headUpdates.get(id) ?? 0)) return null;
      kind = "head";
    } else if (!declaration.ordinary) {
      return null;
    } else if (declaration.initialized) {
      if (rebinds !== 0) return null;
      kind = "declaration";
    } else {
      if (rebinds !== 1 || !facts.assigned.has(id)) return null;
      kind = "assignment";
    }
    const edges = facts.edges.get(id);
    if (edges !== undefined)
      for (const edge of edges) {
        const capture = this.functions.get(edge.target)?.captures?.[edge.index];
        if (capture === undefined || !this.quiet(edge.target, capture.localId)) return null;
      }
    return kind;
  }

  /** Nothing rebinds capture `id` of `fnName`, there or in any body that
   * receives it through further closures, and no local class captures it. */
  private quiet(fnName: string, id: string): boolean {
    const key = `${fnName}\0${id}`;
    const known = this.quietMemo.get(key);
    if (known !== undefined) return known;
    this.quietMemo.set(key, false);
    const fn = this.functions.get(fnName);
    let result = false;
    if (fn !== undefined) {
      const facts = this.factsOf(fn);
      result =
        (facts.rebinds.get(id) ?? 0) === 0 &&
        !facts.classCaptured.has(id) &&
        (facts.edges.get(id) ?? []).every((edge) => {
          const capture = this.functions.get(edge.target)?.captures?.[edge.index];
          return capture !== undefined && this.quiet(edge.target, capture.localId);
        });
    }
    this.quietMemo.set(key, result);
    return result;
  }

  private factsOf(fn: IrFunction): Facts {
    const known = this.facts.get(fn.name);
    if (known !== undefined) return known;
    // A closure captures boxed locals of its creator: a body without one
    // creates no environment and has nothing to decide.
    const facts = fn.locals.some((local) => local.boxed === true) ? collect(fn) : NO_FACTS;
    this.facts.set(fn.name, facts);
    return facts;
  }
}

/** Where a capture lives in its closure's environment: among the boxes
 * (`caps[index]`), the reference values or the scalar values. */
export type EnvironmentSlot =
  | { kind: "box"; index: number }
  | { kind: "reference"; index: number }
  | { kind: "f64"; index: number }
  | { kind: "bool"; index: number };

export interface EnvironmentLayout {
  boxes: number;
  /** The types of the reference values, in slot order. */
  references: IrLocal["type"][];
  /** The storage types of the scalar values, in slot order. */
  scalars: ("double" | "i8")[];
  /** By capture index. */
  slots: EnvironmentSlot[];
}

const NONE: ReadonlySet<number> = new Set<number>();
const NO_IDS: ReadonlySet<string> = new Set<string>();

type Fill = "parameter" | "declaration" | "assignment" | "head" | "forOf";

interface Site {
  owner: string;
  target: string;
  captures: string[];
  adapts: boolean;
  /** Captured locals of the owner whose fill has not run at this site. */
  early: Set<string> | null;
}

interface Facts {
  locals: Map<string, IrLocal>;
  params: Set<string>;
  captureIndex: Map<string, number>;
  classCaptures: Set<string>;
  declarations: Map<
    string,
    { count: number; initialized: boolean; ordinary: boolean; head: boolean }
  >;
  /** Rebindings per local: assignments, increments, loop, catch and
   * rethrow bindings. */
  rebinds: Map<string, number>;
  /** Of those, the ones in the update clause of the `for` that declares
   * the local, and the ones that are a `for … of` statement's binding. */
  headUpdates: Map<string, number>;
  forOfBindings: Map<string, number>;
  /** Locals declared empty and assigned by a later statement of the same
   * ordinary statement list. */
  assigned: Set<string>;
  classCaptured: Set<string>;
  sites: Site[];
  /** The closure captures of each local: slot `index` of `target`. */
  edges: Map<string, { target: string; index: number }[]>;
}

const NO_FACTS: Facts = {
  locals: new Map(),
  params: new Set(),
  captureIndex: new Map(),
  classCaptures: new Set(),
  declarations: new Map(),
  rebinds: new Map(),
  headUpdates: new Map(),
  forOfBindings: new Map(),
  assigned: new Set(),
  classCaptured: new Set(),
  sites: [],
  edges: new Map(),
};

function bump(counts: Map<string, number>, id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

/** One walk of `fn`'s body. `filled` holds the locals whose fill statement
 * lies before the node being visited, in a statement list that encloses
 * it. */
function collect(fn: IrFunction): Facts {
  const facts: Facts = {
    locals: new Map(fn.locals.map((local) => [local.id, local])),
    params: new Set(fn.params.map((p) => p.localId)),
    captureIndex: new Map(),
    classCaptures: new Set((fn.classCaptures ?? []).map((c) => c.localId)),
    declarations: new Map(),
    rebinds: new Map(),
    headUpdates: new Map(),
    forOfBindings: new Map(),
    assigned: new Set(),
    classCaptured: new Set(),
    sites: [],
    edges: new Map(),
  };
  (fn.captures ?? []).forEach((capture, index) => {
    if (!facts.captureIndex.has(capture.localId)) facts.captureIndex.set(capture.localId, index);
  });
  const filled = new Set<string>();
  /** The head bindings of the `for` whose update clause is being walked. */
  let updating: ReadonlySet<string> | null = null;
  const rebind = (id: string): void => {
    bump(facts.rebinds, id);
    if (updating?.has(id) === true) bump(facts.headUpdates, id);
  };
  const declare = (s: IrStmt & { kind: "varDecl" }, ordinary: boolean, head: boolean): void => {
    const entry = facts.declarations.get(s.localId);
    if (entry === undefined)
      facts.declarations.set(s.localId, { count: 1, initialized: s.init !== null, ordinary, head });
    else entry.count++;
  };
  const expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "assignExpr":
      case "incDec":
        rebind(e.localId);
        break;
      case "closure": {
        if (e.captures.length === 0) break;
        const early = new Set<string>();
        e.captures.forEach((id, index) => {
          let edges = facts.edges.get(id);
          if (edges === undefined) facts.edges.set(id, (edges = []));
          edges.push({ target: e.fnName, index });
          if (!filled.has(id) && !facts.params.has(id) && !facts.captureIndex.has(id))
            early.add(id);
        });
        facts.sites.push({
          owner: fn.name,
          target: e.fnName,
          captures: e.captures,
          adapts: e.adapts === true,
          early: early.size > 0 ? early : null,
        });
        break;
      }
      case "classRef":
        for (const id of e.captures ?? []) facts.classCaptured.add(id);
        break;
    }
    return everyExprChild(e, expr, nested);
  };
  const list = (body: readonly IrStmt[], ordinary: boolean): boolean => {
    const marked: string[] = [];
    // The bindings this list declared empty and has not assigned yet.
    const empty: string[] = [];
    for (const s of body) {
      stmt(s, ordinary, false);
      if (!ordinary) continue;
      let fill: string | null = null;
      if (s.kind === "varDecl") {
        if (s.init !== null) fill = s.localId;
        else empty.push(s.localId);
      } else if (s.kind === "assign" && s.initializes !== true) {
        const at = empty.indexOf(s.localId);
        if (at >= 0) {
          // Only the first one can be the binding's single rebinding.
          empty.splice(at, 1);
          facts.assigned.add(s.localId);
          fill = s.localId;
        }
      }
      if (fill !== null && !filled.has(fill)) {
        filled.add(fill);
        marked.push(fill);
      }
    }
    for (const id of marked) filled.delete(id);
    return true;
  };
  /** The statements of `body` with `ids` filled. */
  const within = (ids: readonly string[], body: readonly IrStmt[], ordinary: boolean): void => {
    const added = ids.filter((id) => !filled.has(id));
    for (const id of added) filled.add(id);
    list(body, ordinary);
    for (const id of added) filled.delete(id);
  };
  const stmt = (s: IrStmt, ordinary: boolean, head: boolean): boolean => {
    switch (s.kind) {
      case "varDecl":
        declare(s, ordinary, head);
        return s.init === null || expr(s.init);
      case "assign":
        rebind(s.localId);
        return expr(s.value);
      case "rethrow":
        rebind(s.localId);
        break;
      case "block":
        return list(s.body, ordinary);
      case "if":
        expr(s.cond);
        list(s.then, ordinary);
        if (s.else_ !== null) list(s.else_, ordinary);
        return true;
      case "while":
        expr(s.cond);
        return list(s.body, ordinary);
      case "doWhile":
        list(s.body, ordinary);
        return expr(s.cond);
      case "tryCatch":
        if (s.catchLocalId !== null) rebind(s.catchLocalId);
        list(s.tryBody, ordinary);
        if (s.catchBody !== null) list(s.catchBody, ordinary);
        if (s.finallyBody !== null) list(s.finallyBody, ordinary);
        return true;
      case "forOf":
        rebind(s.localId);
        bump(facts.forOfBindings, s.localId);
        expr(s.iterable);
        within([s.localId], s.body, ordinary);
        return true;
      case "for": {
        // The head's bindings are not filled for closures in the head: the
        // update clause runs on the next iteration's binding.
        const initializers =
          s.init === null ? [] : s.init.kind === "block" ? s.init.body : [s.init];
        const heads: string[] = [];
        for (const initializer of initializers) {
          stmt(initializer, false, true);
          if (initializer.kind === "varDecl" && initializer.init !== null)
            heads.push(initializer.localId);
        }
        if (s.cond !== null) expr(s.cond);
        if (s.update !== null) {
          const outer = updating;
          updating = new Set(heads);
          stmt(s.update, false, false);
          updating = outer;
        }
        within(heads, s.body, ordinary);
        return true;
      }
    }
    return everyStmtChild(s, expr, nested);
  };
  // Statements nested in expressions, and the bodies of switch cases.
  const nested = (s: IrStmt): boolean => stmt(s, false, false);
  list(fn.body, true);
  return facts;
}
