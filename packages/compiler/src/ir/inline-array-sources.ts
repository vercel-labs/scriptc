/* Where the arrays of InlineArray fields come from, and who writes them
 * (ir/inline-arrays.ts plans the layout; contracts/check.ts reports).
 *
 * The constructor copies the elements of the array it is passed into the
 * instance, and other reads of the field give a new array over them. Under
 * Node.js the field holds that array itself. The two agree as long as no
 * write ever reaches an array a field holds, either through a read of the
 * field or through another reference to the array the constructor stored:
 *
 * - every array that may be (a read of) an inline field is never written,
 *   and never reaches code whose writes this analysis cannot see (dynamic
 *   values, calls through function values, the runtime library). A
 *   whole-program graph of where arrays are held (see "Arrays fields
 *   hold") follows them from the field reads;
 * - the array passed to a constructor where the field takes its length is
 *   one nothing else keeps: a fresh array (a literal, a copy, the result of
 *   a function that returns only such arrays or its arguments), a local
 *   array at its last use (a local built here, moved into the constructor;
 *   calls that only read or write it in place may come first), a parameter
 *   that is itself moved (its every caller passes such an array), an array
 *   that is already a field's, or a `const` array that is never written,
 *   which is then followed like a field's array.
 *
 * Arrays are followed shallowly: only the array objects matter, not the
 * elements, which stay ordinary mutable instances. */

import type {
  IrClassDef,
  IrExpr,
  IrFunction,
  IrGlobal,
  IrModule,
  IrStmt,
  IrType,
  SrcLoc,
} from "./ir.js";
import { typeKey } from "./ir.js";
import { readsArguments, type InlineArrayPlan } from "./inline-arrays.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

/** A use that breaks an InlineArray field's contract. */
export interface InlineArraySourceIssue extends Issue {
  readonly declaringClass: string;
  readonly field: string;
}

interface Issue {
  readonly loc: SrcLoc;
  readonly reason: string;
  /** The read of the field whose array the use may reach. */
  readonly origin?: SrcLoc;
}

/** Array methods that leave their receiver unchanged. */
const ARR_READS: ReadonlySet<string> = new Set([
  "length",
  "getNumber",
  "indexEq",
  "indexOf",
  "includes",
  "nextPresent",
  "join",
  "slice",
  "flatCopy",
  "flatOne",
  "toReversed",
  "toSpliced",
  "toSortedPrimitive",
  "concatSpread",
  "with",
  "withUndefined",
]);

/** Array methods whose arguments are arrays of the receiver's type, whose
 * elements they add. */
const SPREADS: ReadonlySet<string> = new Set(["pushSpread", "unshiftSpread", "concatSpread"]);

/** Array methods whose result is a new array. */
const ARR_COPIES: ReadonlySet<string> = new Set([
  "slice",
  "flatCopy",
  "flatOne",
  "toReversed",
  "toSpliced",
  "toSortedPrimitive",
  "concatSpread",
  "with",
  "withUndefined",
]);

/** Array methods that write their receiver and return it. */
const RETURNS_RECEIVER: ReadonlySet<string> = new Set([
  "reverse",
  "sortPrimitive",
  "fill",
  "fillUndefined",
  "copyWithin",
]);

/** Expressions whose value is one of their children's. */
const PASS_THROUGH: ReadonlySet<IrExpr["kind"]> = new Set([
  "upcast",
  "downcast",
  "unionWrap",
  "unionRetype",
  "unionNarrow",
  "ternary",
  "logical",
  "nullish",
  "orDefault",
  "seqExpr",
  "chainRecv",
  "optChain",
]);

/** Expressions that only look at their children. */
const OBSERVE: ReadonlySet<IrExpr["kind"]> = new Set([
  "toBool",
  "strEq",
  "unionEq",
  "unionFuncEq",
  "unionIsTag",
  "unionDisc",
  "instanceOf",
  "instanceOfValue",
  "dynScalarEq",
  "fieldAbsent",
  "recordHas",
  "recordOvfHas",
  "bin",
  "unary",
]);

/** Expressions this analysis follows: reads, the stores and calls it
 * tracks, and the escapes it reports. */
const MODELLED: ReadonlySet<IrExpr["kind"]> = new Set<IrExpr["kind"]>([
  ...PASS_THROUGH,
  ...OBSERVE,
  "varRef",
  "assignExpr",
  "call",
  "new",
  "virtualCall",
  "arrIntrinsic",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "fieldGet",
  "recordGet",
  "mapIntrinsic",
  "setIntrinsic",
  "setNew",
  "mapNew",
  "arrayLit",
  "recordLit",
  "closure",
  "dynFrom",
  "caughtToDyn",
  "callValue",
  "libCall",
  "intrinsic",
]);

/** Array methods that compare their arguments with the elements by
 * identity. */
const IDENTITY_SEARCHES: ReadonlySet<string> = new Set(["indexOf", "includes"]);

/** Each read of an inline field may give another array, where Node.js
 * gives the field's one array every time. */
const IDENTITY_REASON =
  "an array that may be an InlineArray field's is compared by identity, and each read of the field may give another array (compare a copy made with slice(), or compare the elements)";

/** Map and Set methods whose first argument is a key (or a Set element). */
const KEYED: ReadonlySet<string> = new Set(["get", "set", "has", "delete", "add"]);

const NO_SLOTS: ReadonlySet<string> = new Set();
const NO_INDEXES: ReadonlySet<number> = new Set();

interface Occurrence {
  readonly index: FunctionIndex;
  readonly ref: IrExpr & { kind: "varRef" };
  readonly parent: IrExpr | IrStmt;
  /** The innermost statement the occurrence is in. */
  readonly stmt: IrStmt | undefined;
  /** Evaluation order in the function. */
  readonly order: number;
  /** The loops around the occurrence, innermost last. */
  readonly loops: readonly IrStmt[];
  /** The arms of conditionals the occurrence is in (`id:arm`), outermost
   * first: occurrences in different arms of one conditional never both
   * run. */
  readonly branches: readonly string[];
}

/** Whether two occurrences sit in different arms of one conditional. */
function exclusive(a: Occurrence, b: Occurrence): boolean {
  const n = Math.min(a.branches.length, b.branches.length);
  for (let i = 0; i < n; i++) {
    const x = a.branches[i]!,
      y = b.branches[i]!;
    if (x === y) continue;
    return x.slice(0, x.indexOf(":")) === y.slice(0, y.indexOf(":"));
  }
  return false;
}

/** Whether a statement list always leaves the block it ends (return, throw,
 * break or continue on every path). */
function exits(stmts: readonly IrStmt[]): boolean {
  const last = stmts[stmts.length - 1];
  if (last === undefined) return false;
  switch (last.kind) {
    case "return":
    case "throw":
    case "break":
    case "continue":
      return true;
    case "if":
      return last.else_ !== null && exits(last.then) && exits(last.else_);
    case "block":
      return exits(last.body);
    default:
      return false;
  }
}

type Definition = { stmt: IrStmt; loops: readonly IrStmt[] };

/** Every local's occurrences in a function, with each node's parent. */
class FunctionIndex {
  readonly occurrences = new Map<string, Occurrence[]>();
  readonly declarations = new Map<string, Definition[]>();
  /** Assignment statements, by local (globals are defined by these). */
  readonly assignments = new Map<string, Definition[]>();
  readonly assigned = new Set<string>();
  readonly assignedByExpr = new Set<string>();
  /** The parent of every expression. */
  readonly parents = new Map<IrExpr, IrExpr | IrStmt>();
  /** The statement after each statement of a block. */
  readonly next = new Map<IrStmt, IrStmt>();
  /** The position of each statement among the occurrences. */
  readonly positions = new Map<IrStmt, number>();
  readonly captured = new Set<string>();

  constructor(readonly fn: IrFunction) {
    let order = 0;
    let conditionals = 0;
    const loops: IrStmt[] = [];
    // The statements being visited, innermost last.
    const enclosing: IrStmt[] = [];
    const branches: string[] = [];
    const define = (map: Map<string, Definition[]>, id: string, stmt: IrStmt): void => {
      let list = map.get(id);
      if (!list) map.set(id, (list = []));
      list.push({ stmt, loops: [...loops] });
    };
    const arm = (id: number, which: string, visit: () => void): void => {
      branches.push(`${id}:${which}`);
      visit();
      branches.pop();
    };
    const visitExpr = (e: IrExpr, parent: IrExpr | IrStmt): void => {
      this.parents.set(e, parent);
      if (e.kind === "varRef") {
        let list = this.occurrences.get(e.localId);
        if (!list) this.occurrences.set(e.localId, (list = []));
        list.push({
          index: this,
          ref: e,
          parent,
          stmt: enclosing[enclosing.length - 1],
          order: order++,
          loops: [...loops],
          branches: [...branches],
        });
        return;
      }
      if (e.kind === "assignExpr" || e.kind === "incDec") {
        this.assigned.add(e.localId);
        this.assignedByExpr.add(e.localId);
      }
      if (e.kind === "closure") for (const id of e.captures) this.captured.add(id);
      if (e.kind === "ternary") {
        const id = conditionals++;
        visitExpr(e.cond, e);
        arm(id, "t", () => visitExpr(e.then, e));
        arm(id, "e", () => visitExpr(e.else_, e));
        return;
      }
      everyExprChild(
        e,
        (child) => {
          visitExpr(child, e);
          return true;
        },
        (child) => {
          visitStmt(child);
          return true;
        },
      );
    };
    // The statements of a block after an `if` whose one arm always leaves
    // the block run only when the other arm ran.
    const visitBlock = (stmts: readonly IrStmt[]): void => {
      const depth = branches.length;
      for (let i = 0; i + 1 < stmts.length; i++) this.next.set(stmts[i]!, stmts[i + 1]!);
      for (const s of stmts) {
        const id = visitStmt(s);
        if (s.kind !== "if" || id === null) continue;
        if (exits(s.then)) branches.push(`${id}:e`);
        else if (s.else_ !== null && exits(s.else_)) branches.push(`${id}:t`);
      }
      branches.length = depth;
    };
    const inLoop = (s: IrStmt, visit: () => void): void => {
      loops.push(s);
      visit();
      loops.pop();
    };
    /** Visits `s`; returns the conditional id of an `if`. */
    const visitStmt = (s: IrStmt): number | null => {
      enclosing.push(s);
      const id = visitStmtIn(s);
      enclosing.pop();
      return id;
    };
    const visitStmtIn = (s: IrStmt): number | null => {
      this.positions.set(s, order);
      switch (s.kind) {
        case "varDecl":
          define(this.declarations, s.localId, s);
          break;
        case "assign":
          this.assigned.add(s.localId);
          define(this.assignments, s.localId, s);
          break;
        case "if": {
          visitExpr(s.cond, s);
          const id = conditionals++;
          arm(id, "t", () => visitBlock(s.then));
          arm(id, "e", () => visitBlock(s.else_ ?? []));
          return id;
        }
        case "switch": {
          // Case tests run in order until one matches; a case's body runs
          // after it, or after the case before falls through into it.
          visitExpr(s.disc, s);
          for (const c of s.cases) if (c.test) visitExpr(c.test, s);
          const id = conditionals++;
          let entry = 0;
          s.cases.forEach((c, i) => {
            if (i > 0 && exits(s.cases[i - 1]!.body)) entry = i;
            arm(id, String(entry), () => visitBlock(c.body));
          });
          return null;
        }
        case "block":
          visitBlock(s.body);
          return null;
        case "while":
          inLoop(s, () => {
            visitExpr(s.cond, s);
            visitBlock(s.body);
          });
          return null;
        case "doWhile":
          inLoop(s, () => {
            visitBlock(s.body);
            visitExpr(s.cond, s);
          });
          return null;
        case "for":
          if (s.init) visitStmt(s.init);
          inLoop(s, () => {
            if (s.cond) visitExpr(s.cond, s);
            visitBlock(s.body);
            if (s.update) visitStmt(s.update);
          });
          return null;
        case "forOf":
          this.assigned.add(s.localId);
          visitExpr(s.iterable, s);
          inLoop(s, () => visitBlock(s.body));
          return null;
      }
      everyStmtChild(
        s,
        (child) => {
          visitExpr(child, s);
          return true;
        },
        (child) => {
          visitStmt(child);
          return true;
        },
      );
      return null;
    };
    visitBlock(fn.body);
  }
}

/** Where the value of an occurrence goes: up through the expressions whose
 * value it may be. */
function valueUse(o: Occurrence): { parent: IrExpr | IrStmt | undefined; child: IrExpr } {
  let child: IrExpr = o.ref;
  let parent: IrExpr | IrStmt | undefined = o.parent;
  while (parent !== undefined && givesValueOf(parent, child)) {
    child = parent as IrExpr;
    parent = o.index.parents.get(child);
  }
  return { parent, child };
}

/** Whether `e` is `undefined` or `null`, as itself or as a union arm. */
function isUndefined(e: IrExpr): boolean {
  while (e.kind === "unionWrap" || e.kind === "upcast") e = e.value;
  return e.kind === "unitLit";
}

/** Whether an occurrence is (the value of) a returned expression. */
function returned(o: Occurrence): boolean {
  return valueUse(o).parent?.kind === "return";
}

/** Whether the value of `parent` may be that of its child `child`. */
function givesValueOf(parent: IrExpr | IrStmt, child: IrExpr): boolean {
  switch (parent.kind) {
    case "ternary":
      return parent.then === child || parent.else_ === child;
    case "seqExpr":
      return parent.result === child;
    case "upcast":
    case "downcast":
    case "unionWrap":
    case "unionRetype":
    case "unionNarrow":
      return parent.value === child;
    case "logical":
    case "nullish":
    case "orDefault":
      return true;
    default:
      return false;
  }
}

/** Whether `parent` only reads its array child `ref` without keeping or
 * writing it. */
function readsOnly(parent: IrExpr | IrStmt, ref: IrExpr): boolean {
  switch (parent.kind) {
    case "arrayGet":
    case "arrayHas":
    case "arrayState":
      return parent.arr === ref;
    case "arrIntrinsic":
      if (parent.receiver === ref) return ARR_READS.has(parent.method);
      // A spread argument gives its elements.
      return SPREADS.has(parent.method) && typeKey(ref.type) === typeKey(parent.receiver.type);
    case "forOf":
      return parent.iterable === ref;
    default:
      return OBSERVE.has(parent.kind as IrExpr["kind"]);
  }
}

/** Whether `parent` writes its array child `ref` in place (and keeps no
 * reference to it). */
function writesInPlace(parent: IrExpr | IrStmt, ref: IrExpr): boolean {
  switch (parent.kind) {
    case "arraySet":
    case "arraySetLength":
    case "arraySetUndefined":
    case "arrayDelete":
      return parent.arr === ref;
    case "arrIntrinsic":
      return parent.receiver === ref && !ARR_READS.has(parent.method);
    default:
      return false;
  }
}

export function checkInlineArraySources(
  mod: IrModule,
  plan: InlineArrayPlan,
): InlineArraySourceIssue[] {
  if (plan.classes.size === 0) return [];
  return new SourceAnalysis(mod, plan).run();
}

class SourceAnalysis {
  private readonly functions = new Map<string, IrFunction>();
  private readonly indexes = new Map<string, FunctionIndex>();
  /** Functions that are called other than directly (function values,
   * library exports): their callers are not all known. */
  private readonly escapedFunctions = new Set<string>();
  private readonly methodImpls = new Map<string, string[]>();
  /** The hierarchy roots of the planned fields' element classes: arrays of
   * any class in those hierarchies may be a field's (a cast can retype
   * one). */
  private readonly elementRoots = new Set<string>();
  private readonly bases = new Map<string, string | undefined>();
  private readonly classDefs = new Map<string, IrClassDef>();
  private readonly subclasses = new Map<string, string[]>();
  private readonly globals = new Map<string, IrGlobal>();
  /** The slot graph (see "Arrays fields hold"). */
  private readonly edges = new Map<string, Set<string>>();
  private readonly sites = new Map<IrExpr, string>();
  /** The slots of inline field reads, with the reads' locations. */
  private readonly seeds = new Map<string, SrcLoc>();
  /** The field each read reads. */
  private readonly origins = new Map<SrcLoc, { declaringClass: string; field: string }>();
  /** Slots that may hold an inline field's array, with the field read it
   * may come from. */
  private readonly pinned = new Map<string, SrcLoc>();
  /** `followed` by type key. */
  private readonly followedTypes = new Map<string, boolean>();
  /** Parameters (`fn\0index`) whose array moves into an inline field. */
  private readonly moved = new Set<string>();
  /** Functions whose every result is an array nothing else keeps, a
   * field's, or one of the `passed` parameters. */
  private readonly factories = new Set<string>();
  private readonly passed = new Map<string, Set<number>>();
  /** The locals `freshLocal` is answering for. */
  private readonly inProgress = new Set<string>();
  /** Where `share` records the slots it shares, with their definitions;
   * null when sharing is not allowed. */
  private shareSink: Map<string, SrcLoc> | null = null;
  /** The slots each factory's results may share. */
  private readonly factoryShares = new Map<string, Map<string, SrcLoc>>();
  /** Parameters (by index) a function may return as they came: a call's
   * value may be the array passed there. */
  private readonly returnedParams = new Map<string, Set<number>>();
  /** The slots that carry a returned parameter to a function's returns:
   * the parameter's own and the locals between. Their other values reach
   * the function's result slot directly. */
  private readonly returnCarriers = new Map<string, Set<string>>();
  private readonly issues: InlineArraySourceIssue[] = [];
  private readonly reported = new Set<string>();

  constructor(
    private readonly mod: IrModule,
    private readonly plan: InlineArrayPlan,
  ) {
    for (const fn of mod.functions) this.functions.set(fn.name, fn);
    for (const cls of mod.classes ?? [])
      for (const m of cls.methods ?? []) {
        let list = this.methodImpls.get(m);
        if (!list) this.methodImpls.set(m, (list = []));
        list.push(`%${cls.name}.${m}`);
      }
    for (const cls of mod.classes ?? []) {
      this.bases.set(cls.name, cls.base);
      this.classDefs.set(cls.name, cls);
      if (cls.base !== undefined) {
        const list = this.subclasses.get(cls.base);
        if (list === undefined) this.subclasses.set(cls.base, [cls.name]);
        else list.push(cls.name);
      }
    }
    for (const g of mod.globals ?? []) this.globals.set(g.id, g);
    for (const cls of plan.classes.values()) this.elementRoots.add(this.rootOf(cls.elemClass));
  }

  private rootOf(className: string): string {
    let name = className;
    for (let base = this.bases.get(name); base !== undefined; base = this.bases.get(name))
      name = base;
    return name;
  }

  private index(fn: IrFunction): FunctionIndex {
    let index = this.indexes.get(fn.name);
    if (!index) this.indexes.set(fn.name, (index = new FunctionIndex(fn)));
    return index;
  }

  run(): InlineArraySourceIssue[] {
    this.collectCalls();
    this.computeLent();
    this.computeMoves();
    this.computeFactories();
    this.computePinned();
    this.checkSources();
    this.checkWrites();
    return this.issues;
  }

  /** The planned class of the first hierarchy, for issues not tied to one. */
  private anyField(): { declaringClass: string; field: string } {
    const cls = this.plan.classes.values().next().value!;
    return { declaringClass: cls.declaringClass, field: cls.field };
  }

  private report(
    issue: Issue,
    owner = (issue.origin && this.origins.get(issue.origin)) ?? this.anyField(),
  ): void {
    // One issue per site.
    const key = `${issue.loc.file}:${issue.loc.start}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.issues.push({ ...owner, ...issue });
  }

  // ── Calls ──

  private collectCalls(): void {
    for (const e of this.mod.lib?.exports ?? []) this.escapedFunctions.add(e.fnName);
    for (const fn of this.mod.functions)
      this.eachExpr(fn, (e) => {
        if (e.kind === "closure") this.escapedFunctions.add(e.fnName);
      });
  }

  /** The functions a call, construction or method call may run, with the
   * offset of its first argument in their parameters (a construction's
   * arguments follow `this`). */
  private callees(e: IrExpr): { callee: string; offset: number }[] {
    switch (e.kind) {
      case "call":
        return [{ callee: e.callee, offset: 0 }];
      case "new":
        return [{ callee: `%${e.className}.constructor`, offset: 1 }];
      case "virtualCall": {
        // `targets` are the classes whose own declaration may run.
        const method = e.method;
        const targets = e.targets;
        const impls =
          targets !== undefined
            ? targets.map((c) => `%${c}.${method}`)
            : (this.methodImpls.get(method) ?? []);
        return impls.map((callee) => ({ callee, offset: 0 }));
      }
      default:
        return [];
    }
  }

  private eachExpr(fn: IrFunction, visit: (e: IrExpr) => void): void {
    const expr = (e: IrExpr): boolean => {
      visit(e);
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => everyStmtChild(s, expr, stmt);
    for (const s of fn.body) stmt(s);
  }

  /** The planned class an inline `new` constructs, with the argument the
   * field takes its length from. */
  private inlineNew(e: IrExpr): { arg: number } | null {
    if (e.kind !== "new") return null;
    const cls = this.plan.classes.get(e.className);
    return cls === undefined ? null : { arg: cls.lengthArg };
  }

  /** Whether passing `arg` in `call` hands it to a parameter that moves it
   * into an inline field. */
  private consumes(call: IrExpr, index: number): boolean {
    const inline = this.inlineNew(call);
    if (inline !== null) return index === inline.arg;
    return this.callees(call).some(({ callee, offset }) =>
      this.moved.has(`${callee}\0${index + offset}`),
    );
  }

  // ── Lent arrays ──

  /** Array parameters (`fn\0index`) whose function reads the array or
   * writes it in place and keeps no reference to it: passing an array there
   * lends it for the call. */
  private readonly lent = new Set<string>();
  /** The lent parameters whose function only reads the array. */
  private readonly readParams = new Set<string>();

  /** How an occurrence uses its array: it only reads it, writes it in
   * place, or does something else (keeps it, hands it on). */
  private use(o: Occurrence, depth = 0): "read" | "write" | "other" {
    // The expression whose value it is, such as a narrowing of it.
    const { parent: p, child } = valueUse(o);
    if (p === undefined) return "other";
    if (readsOnly(p, child)) return "read";
    if (writesInPlace(p, child)) return "write";
    // A `const` copy of the reference (as `for...of` makes) uses the array
    // as its own uses do.
    const copy = this.copyUses(o, depth);
    if (copy !== null) {
      const uses = copy.map((u) => this.use(u, depth + 1));
      if (uses.includes("other")) return "other";
      return uses.includes("write") ? "write" : "read";
    }
    if (p.kind !== "call" && p.kind !== "new" && p.kind !== "virtualCall") return "other";
    const i = p.args.indexOf(child);
    const params = this.callees(p).map(({ callee, offset }) => `${callee}\0${i + offset}`);
    if (i < 0 || params.length === 0) return "other";
    if (params.every((k) => this.readParams.has(k))) return "read";
    if (params.every((k) => this.lent.has(k))) return "write";
    return "other";
  }

  /** The occurrences of the `const` local an occurrence initializes, or
   * null when it initializes none (or one written again). */
  private copyUses(o: Occurrence, depth: number): Occurrence[] | null {
    const { parent: p, child } = valueUse(o);
    if (p?.kind !== "varDecl" || p.init !== child || depth >= 4) return null;
    const index = o.index;
    if (index.assigned.has(p.localId) || index.captured.has(p.localId)) return null;
    if ((index.declarations.get(p.localId) ?? []).length !== 1) return null;
    return index.occurrences.get(p.localId) ?? [];
  }

  /** The position of the last use an occurrence makes, through `const`
   * copies. */
  private lastPosition(o: Occurrence, depth = 0): number {
    const copy = this.copyUses(o, depth);
    if (copy === null) return o.order;
    return Math.max(o.order, ...copy.map((u) => this.lastPosition(u, depth + 1)));
  }

  /** Whether `last` hands the array on for good: every other occurrence that
   * can run with it only reads the array, or writes it in place before. */
  private lastUse(occurrences: readonly Occurrence[], last: Occurrence): boolean {
    for (const o of occurrences) {
      if (o === last || exclusive(o, last)) continue;
      const use = this.use(o);
      if (use === "other" || (use === "write" && this.lastPosition(o) > last.order)) return false;
    }
    return true;
  }

  /** The largest sets of lent and read-only parameters: start from every
   * array parameter and drop those with another use, to a fixpoint. */
  private computeLent(): void {
    for (const fn of this.mod.functions)
      fn.params.forEach((p, i) => {
        if (!this.holdsFieldArray(p.type)) return;
        const index = this.index(fn);
        const local = fn.locals.find((l) => l.id === p.localId);
        if (index.assigned.has(p.localId) || index.captured.has(p.localId) || local?.boxed === true)
          return;
        this.lent.add(`${fn.name}\0${i}`);
        this.readParams.add(`${fn.name}\0${i}`);
      });
    for (let changed = true; changed;) {
      changed = false;
      for (const fn of this.mod.functions)
        fn.params.forEach((p, i) => {
          const key = `${fn.name}\0${i}`;
          if (!this.lent.has(key)) return;
          const uses = (this.index(fn).occurrences.get(p.localId) ?? []).map((o) => this.use(o));
          if (uses.includes("other")) {
            this.lent.delete(key);
            this.readParams.delete(key);
            changed = true;
          } else if (uses.includes("write") && this.readParams.delete(key)) changed = true;
        });
    }
  }

  // ── Moves ──

  /** Parameters that only reach an inline field: each is used only to be
   * read, written in place, and finally passed where an inline field takes
   * its array; every caller then passes an array nothing else keeps. */
  private computeMoves(): void {
    // Subclass constructors forward their parameter to the base's: start
    // from the constructors' own length parameters.
    for (const [name, cls] of this.plan.classes)
      this.moved.add(`%${name}.constructor\0${cls.lengthArg + 1}`);
    // Grow: parameters whose last use moves them.
    for (let changed = true; changed;) {
      changed = false;
      for (const fn of this.mod.functions) {
        if (this.escapedFunctions.has(fn.name)) continue;
        fn.params.forEach((p, i) => {
          const key = `${fn.name}\0${i}`;
          if (this.moved.has(key)) return;
          if (this.movedAtLastUse(fn, p.localId)) {
            this.moved.add(key);
            changed = true;
          }
        });
      }
    }
  }

  /** Whether the parameter `localId` moves into an inline field: every use
   * reads it, writes it in place, or passes it on where an inline field
   * takes its array as its last use on that path, outside any loop. */
  private movedAtLastUse(fn: IrFunction, localId: string): boolean {
    const index = this.index(fn);
    if (index.assigned.has(localId) || index.captured.has(localId)) return false;
    const local = fn.locals.find((l) => l.id === localId);
    if (local === undefined || local.boxed === true) return false;
    const occurrences = index.occurrences.get(localId) ?? [];
    const moves = occurrences.filter((o) => this.isMove(o));
    if (moves.length === 0) return false;
    return moves.every((m) => m.loops.length === 0 && this.lastUse(occurrences, m));
  }

  /** Whether the occurrence hands the array on to an inline field. */
  private isMove(o: Occurrence): boolean {
    const { parent: p, child } = valueUse(o);
    if (p === undefined || (p.kind !== "new" && p.kind !== "call" && p.kind !== "virtualCall"))
      return false;
    const i = p.args.indexOf(child);
    return i >= 0 && this.consumes(p, i);
  }

  // ── Fresh values ──

  /** Whether `e` (in `fn`) is an array nothing else keeps, or one an
   * inline field already holds. */
  private fresh(fn: IrFunction, e: IrExpr): boolean {
    switch (e.kind) {
      case "arrayLit":
        return true;
      case "arrIntrinsic":
        if (RETURNS_RECEIVER.has(e.method)) return this.fresh(fn, e.receiver);
        return ARR_COPIES.has(e.method);
      case "call":
      case "virtualCall": {
        // A factory's result, and the arrays it may give back as they came.
        const callees = this.callees(e);
        return (
          callees.length > 0 &&
          callees.every(
            ({ callee, offset }) =>
              this.factories.has(callee) &&
              this.shareAll(this.factoryShares.get(callee)) &&
              [...(this.passed.get(callee) ?? NO_INDEXES)].every((i) => {
                const arg = e.args[i - offset];
                return arg !== undefined && this.fresh(fn, arg);
              }),
          )
        );
      }
      case "varRef": {
        if (e.localId.startsWith("%g."))
          return this.fieldArray(fn, e) || this.freshGlobal(fn, e) || this.share(fn, e);
        const param = fn.params.findIndex((p) => p.localId === e.localId);
        if (param >= 0) return this.moved.has(`${fn.name}\0${param}`);
        return this.fieldArray(fn, e) || this.freshLocal(fn, e) || this.share(fn, e);
      }
      case "fieldGet":
        return this.isFieldRead(e);
      case "seqExpr":
        return this.fresh(fn, e.result);
      case "ternary":
        return this.fresh(fn, e.then) && this.fresh(fn, e.else_);
      case "logical":
      case "nullish":
      case "orDefault":
        return everyExprChild(
          e,
          (child) => this.fresh(fn, child),
          () => false,
        );
      case "upcast":
      case "downcast":
      case "unionWrap":
      case "unionRetype":
      case "unionNarrow":
        return this.fresh(fn, e.value);
      default:
        return false;
    }
  }

  /** A local whose only definition is a fresh array and whose occurrence
   * `ref` is its last use on every path, outside any loop the declaration
   * is not in. */
  private freshLocal(fn: IrFunction, ref: IrExpr & { kind: "varRef" }): boolean {
    const id = ref.localId;
    const index = this.index(fn);
    if (index.assignedByExpr.has(id) || index.captured.has(id)) return false;
    const declarations = index.declarations.get(id) ?? [];
    if (declarations.length !== 1 || !this.movedAt(index, ref, declarations[0]!)) return false;
    // Every value the local takes (a `let` may be assigned again) is fresh,
    // or undefined.
    const key = `${fn.name}\0${id}`;
    if (this.inProgress.has(key)) return false;
    this.inProgress.add(key);
    try {
      const init = (declarations[0]!.stmt as IrStmt & { kind: "varDecl" }).init;
      const values = [
        init,
        ...(index.assignments.get(id) ?? []).map(
          (d) => (d.stmt as IrStmt & { kind: "assign" }).value,
        ),
      ];
      return values.every((v) =>
        v === null ? index.assignments.has(id) : isUndefined(v) || this.fresh(fn, v),
      );
    } finally {
      this.inProgress.delete(key);
    }
  }

  /** Whether `ref` is the last use of its local or global on every path,
   * outside any loop its definition is not in. */
  private movedAt(
    index: FunctionIndex,
    ref: IrExpr & { kind: "varRef" },
    def: Definition,
  ): boolean {
    const occurrences = index.occurrences.get(ref.localId) ?? [];
    const at = occurrences.find((o) => o.ref === ref);
    if (at === undefined) return false;
    // A move followed by a fresh value for the local (in a loop that builds
    // one array per pass): later uses see the new array.
    const kill = this.killAfter(at);
    if (kill !== null)
      return this.lastUse(
        occurrences.filter((o) => o.order < kill),
        at,
      );
    return at.loops.length <= def.loops.length && this.lastUse(occurrences, at);
  }

  /** The position of an assignment of a fresh array (or undefined) to the
   * occurrence's local by the statement right after the occurrence's. */
  private killAfter(at: Occurrence): number | null {
    const index = at.index;
    const next = at.stmt === undefined ? undefined : index.next.get(at.stmt);
    if (next?.kind !== "assign" || next.localId !== at.ref.localId) return null;
    if (!isUndefined(next.value) && !this.fresh(index.fn, next.value)) return null;
    return index.positions.get(next) ?? null;
  }

  /** Whether `ref` is a `const` local or global from a fresh array that is
   * only read or passed where an inline field takes it: such an array may
   * be shared, and is followed like a field's, so that writes to it through
   * other references are reported. Only while `shareSink` collects them. */
  private share(fn: IrFunction, ref: IrExpr & { kind: "varRef" }): boolean {
    if (this.shareSink === null) return false;
    const id = ref.localId;
    let def: { fn: IrFunction; value: IrExpr; loc: SrcLoc };
    if (id.startsWith("%g.")) {
      const source = this.globalSource(id);
      if (source === null) return false;
      def = {
        fn: source.fn,
        value: (source.def.stmt as IrStmt & { kind: "assign" }).value,
        loc: source.def.stmt.loc,
      };
    } else {
      const index = this.index(fn);
      if (index.assigned.has(id) || index.captured.has(id)) return false;
      const declarations = index.declarations.get(id) ?? [];
      const decl = declarations[0]?.stmt as (IrStmt & { kind: "varDecl" }) | undefined;
      if (declarations.length !== 1 || !decl?.init) return false;
      def = { fn, value: decl.init, loc: decl.loc };
    }
    const slot = this.localSlot(fn, id);
    if (!this.shareSink.has(slot)) {
      const functions = id.startsWith("%g.") ? this.mod.functions : [fn];
      const constant = functions.every((f) =>
        (this.index(f).occurrences.get(id) ?? []).every(
          (o) => this.use(o) === "read" || this.isMove(o) || returned(o),
        ),
      );
      if (!constant || !this.fresh(def.fn, def.value)) return false;
    }
    this.shareSink.set(slot, def.loc);
    return true;
  }

  /** Shares the arrays a factory's results may be (see `share`). */
  private shareAll(shares: ReadonlyMap<string, SrcLoc> | undefined): boolean {
    if (shares === undefined) return true;
    if (this.shareSink === null) return false;
    for (const [slot, loc] of shares) this.shareSink.set(slot, loc);
    return true;
  }

  /** Whether `e` is always an array a field already holds: a read of an
   * inline field, or a `const` local or global initialized from one. Such
   * an array may be shared: every reference to it is followed. */
  private fieldArray(fn: IrFunction, e: IrExpr, depth = 0): boolean {
    if (depth > 16) return false;
    switch (e.kind) {
      case "fieldGet":
        return this.isFieldRead(e);
      case "varRef": {
        if (e.localId.startsWith("%g.")) {
          const source = this.globalSource(e.localId);
          if (source === null) return false;
          const value = (source.def.stmt as IrStmt & { kind: "assign" }).value;
          return this.fieldArray(source.fn, value, depth + 1);
        }
        if (fn.params.some((p) => p.localId === e.localId)) return false;
        const index = this.index(fn);
        if (index.assigned.has(e.localId) || index.captured.has(e.localId)) return false;
        const declarations = index.declarations.get(e.localId) ?? [];
        if (declarations.length !== 1) return false;
        const init = (declarations[0]!.stmt as IrStmt & { kind: "varDecl" }).init;
        return init !== null && this.fieldArray(fn, init, depth + 1);
      }
      case "seqExpr":
        return this.fieldArray(fn, e.result, depth + 1);
      case "ternary":
        return this.fieldArray(fn, e.then, depth + 1) && this.fieldArray(fn, e.else_, depth + 1);
      case "upcast":
      case "downcast":
      case "unionWrap":
      case "unionRetype":
      case "unionNarrow":
        return this.fieldArray(fn, e.value, depth + 1);
      default:
        return false;
    }
  }

  /** A `const` global from a fresh array, read here for the last time, in
   * the function that defines it, and only read elsewhere. */
  private freshGlobal(fn: IrFunction, ref: IrExpr & { kind: "varRef" }): boolean {
    const source = this.globalSource(ref.localId);
    if (source === null) return false;
    const value = (source.def.stmt as IrStmt & { kind: "assign" }).value;
    if (!this.fresh(source.fn, value)) return false;
    if (fn !== source.fn || !this.movedAt(this.index(fn), ref, source.def)) return false;
    return this.mod.functions.every(
      (other) =>
        other === fn ||
        (this.index(other).occurrences.get(ref.localId) ?? []).every((o) => this.use(o) === "read"),
    );
  }

  /** The one assignment of an immutable global. */
  private globalSource(id: string): { fn: IrFunction; def: Definition } | null {
    if (this.globals.get(id)?.mutable !== false) return null;
    let source: { fn: IrFunction; def: Definition } | null = null;
    for (const fn of this.mod.functions) {
      const index = this.index(fn);
      if (index.assignedByExpr.has(id)) return null;
      for (const def of index.assignments.get(id) ?? []) {
        if (source !== null) return null;
        source = { fn, def };
      }
    }
    return source;
  }

  private isFieldRead(e: IrExpr): boolean {
    if (e.kind !== "fieldGet") return false;
    const cls = this.plan.classes.get(e.className);
    return cls !== undefined && cls.field === e.field;
  }

  // ── Arrays fields hold ──
  //
  // A whole-program graph of slots: locals and parameters (`l:fn\0local`),
  // globals (`g:global`), results (`r:fn`), the fields of a class hierarchy
  // (`f:root\0field`), record fields (`s:shape\0field`), arrays, Maps and
  // Sets made at one expression (`a:fn\0n`), and reads of an inline field
  // (`v:n`). An edge says that a value in one slot may reach another.
  // `c:<slot>` is the elements (keys and values) of the arrays, Maps and
  // Sets in a slot: an edge from one slot to another is one between their
  // elements too. The slots a field read reaches may hold a field's array.

  /** A field of every class in a hierarchy. */
  private fieldSlot(className: string, field: string): string {
    return `f:${this.rootOf(className)}\0${field}`;
  }

  private localSlot(fn: IrFunction, id: string): string {
    return id.startsWith("%g.") ? `g:${id}` : `l:${fn.name}\0${id}`;
  }

  /** The slot of the array, Map or Set an expression makes. */
  private site(fn: IrFunction, e: IrExpr): string {
    let slot = this.sites.get(e);
    if (slot === undefined) this.sites.set(e, (slot = `a:${fn.name}\0${this.sites.size}`));
    return slot;
  }

  /** Whether values of `t` can be arrays a planned field holds: arrays of
   * a class in the element classes' hierarchies, directly or as a union
   * arm. */
  private holdsFieldArray(t: IrType): boolean {
    if (t.kind === "array")
      return t.elem.kind === "object" && this.elementRoots.has(this.rootOf(t.elem.className));
    if (t.kind === "union") return this.arms(t).some((arm) => this.holdsFieldArray(arm));
    return false;
  }

  /** Whether values of `t` can be, or be arrays, Maps or Sets that contain,
   * arrays a planned field holds: the values the graph follows. */
  private followed(t: IrType, depth = 0): boolean {
    if (depth > 4) return false;
    const key = typeKey(t);
    const known = this.followedTypes.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    switch (t.kind) {
      case "array":
        result = this.holdsFieldArray(t) || this.followed(t.elem, depth + 1);
        break;
      case "set":
        result = this.followed(t.elem, depth + 1);
        break;
      case "map":
        result = this.followed(t.key, depth + 1) || this.followed(t.value, depth + 1);
        break;
      case "union":
        result = this.arms(t).some((arm) => this.followed(arm, depth + 1));
        break;
      default:
        result = false;
    }
    this.followedTypes.set(key, result);
    return result;
  }

  private arms(t: IrType & { kind: "union" }): readonly IrType[] {
    return (this.mod.unions ?? []).find((u) => u.id === t.unionId)?.arms ?? [];
  }

  /** The slots the value of `e` may come from. */
  private slotsOf(fn: IrFunction, e: IrExpr): string[] {
    const contents = (inner: IrExpr): string[] => this.slotsOf(fn, inner).map((s) => `c:${s}`);
    const children = (): string[] => {
      const out: string[] = [];
      everyExprChild(
        e,
        (child) => {
          out.push(...this.slotsOf(fn, child));
          return true;
        },
        () => true,
      );
      return out;
    };
    switch (e.kind) {
      case "fieldGet":
        if (!this.isFieldRead(e)) return [this.fieldSlot(e.className, e.field)];
        return [this.seed(fn, e)];
      case "varRef":
        return [this.localSlot(fn, e.localId)];
      case "call":
      case "virtualCall": {
        const slots: string[] = [];
        for (const { callee, offset } of this.callees(e)) {
          slots.push(`r:${callee}`);
          for (const i of this.returnedParams.get(callee) ?? NO_INDEXES) {
            const arg = e.args[i - offset];
            if (arg !== undefined) slots.push(...this.slotsOf(fn, arg));
          }
        }
        return slots;
      }
      case "recordGet":
        return e.obj.type.kind === "record" ? [`s:${e.obj.type.shapeId}\0${e.field}`] : [];
      case "arrayGet":
        return contents(e.arr);
      case "mapIntrinsic":
      case "setIntrinsic":
        if (e.method === "set" || e.method === "add") return this.slotsOf(fn, e.receiver);
        if (e.method === "clone" || e.method === "keySet" || e.method === "valueSet")
          return [this.site(fn, e)];
        return contents(e.receiver);
      case "arrIntrinsic":
        if (RETURNS_RECEIVER.has(e.method)) return this.slotsOf(fn, e.receiver);
        if (e.method === "pop" || e.method === "shift") return contents(e.receiver);
        if (ARR_COPIES.has(e.method) || e.method === "splice" || e.method === "spliceInsert")
          return [this.site(fn, e)];
        return [];
      case "arrayLit":
      case "setNew":
      case "mapNew":
        return [this.site(fn, e)];
      case "callValue":
        return ["r:*"];
      case "seqExpr":
        return this.slotsOf(fn, e.result);
      case "ternary":
        return [...this.slotsOf(fn, e.then), ...this.slotsOf(fn, e.else_)];
      case "logical":
      case "nullish":
      case "orDefault":
        return children();
      default:
        return PASS_THROUGH.has(e.kind) ? children() : [];
    }
  }

  /** The slot of a read of an inline field. */
  private seed(fn: IrFunction, e: IrExpr): string {
    const slot = this.site(fn, e).replace(/^a:/, "v:");
    if (!this.seeds.has(slot)) {
      this.seeds.set(slot, e.loc);
      this.pinned.set(slot, e.loc);
      if (e.kind === "fieldGet") this.origins.set(e.loc, this.ownerOf(e.className));
    }
    return slot;
  }

  private edge(from: string, to: string): void {
    let list = this.edges.get(from);
    if (!list) this.edges.set(from, (list = new Set()));
    list.add(to);
  }

  /** Whether `e` may evaluate to an array an inline field holds. */
  private pinnedExpr(fn: IrFunction, e: IrExpr): boolean {
    return this.origin(fn, e) !== undefined;
  }

  /** The field read whose array `e` may be. */
  private origin(fn: IrFunction, e: IrExpr): SrcLoc | undefined {
    if (!this.holdsFieldArray(e.type)) return undefined;
    for (const slot of this.slotsOf(fn, e)) {
      const origin = this.pinned.get(slot);
      if (origin !== undefined) return origin;
    }
    return undefined;
  }

  /** The field read whose array values of type `t` in `slots`, or the
   * arrays, Maps, Sets and records inside them, may hold. */
  private originWithin(
    slots: readonly string[],
    t: IrType,
    objects: boolean,
    depth = 0,
  ): SrcLoc | undefined {
    if (depth > 4) return undefined;
    if (depth > 0 && this.holdsFieldArray(t))
      for (const slot of slots) {
        const origin = this.pinned.get(slot);
        if (origin !== undefined) return origin;
      }
    const elements = slots.map((s) => `c:${s}`);
    switch (t.kind) {
      case "array":
      case "set":
        return this.originWithin(elements, t.elem, objects, depth + 1);
      case "map":
        return (
          this.originWithin(elements, t.key, objects, depth + 1) ??
          this.originWithin(elements, t.value, objects, depth + 1)
        );
      case "union":
        for (const arm of this.arms(t)) {
          const origin = this.originWithin(slots, arm, objects, depth + 1);
          if (origin !== undefined) return origin;
        }
        return undefined;
      case "record":
        for (const f of (this.mod.records ?? []).find((r) => r.id === t.shapeId)?.fields ?? []) {
          const origin = this.originWithin(
            [`s:${t.shapeId}\0${f.name}`],
            f.type,
            objects,
            depth + 1,
          );
          if (origin !== undefined) return origin;
        }
        return undefined;
      // Code that reads an instance's fields by name (a dynamic view) can
      // reach the arrays they hold. Other code reads them through field
      // reads, which the graph follows.
      case "object":
        return objects ? this.objectOrigin(t.className, depth) : undefined;
      default:
        return undefined;
    }
  }

  /** `originWithin` through objects for an instance of `className` or of a
   * subclass: the arrays its fields may hold. An inline field is left out: its reads are
   * followed where they are. By `className\0depth`. */
  private readonly objectOrigins = new Map<string, SrcLoc | null>();

  private objectOrigin(className: string, depth: number): SrcLoc | undefined {
    const key = `${className}\0${depth}`;
    const known = this.objectOrigins.get(key);
    if (known !== undefined) return known ?? undefined;
    // A cycle through fields finds nothing new.
    this.objectOrigins.set(key, null);
    let found: SrcLoc | undefined;
    const visit = (name: string): void => {
      const cls = this.classDefs.get(name);
      if (cls === undefined) return;
      const inline = this.plan.classes.get(name)?.field;
      for (const f of cls.fields) {
        if (found !== undefined) return;
        if (f.name === inline) continue;
        found = this.originWithin([this.fieldSlot(name, f.name)], f.type, true, depth + 1);
      }
      for (const sub of this.subclasses.get(name) ?? []) if (found === undefined) visit(sub);
    };
    visit(className);
    this.objectOrigins.set(key, found ?? null);
    return found;
  }

  /** The slots of the parameters of `fn` that only ever hold the caller's
   * arguments (never assigned or captured), by index. */
  private ownParams(fn: IrFunction): Map<string, number> {
    const index = this.index(fn);
    const own = new Map<string, number>();
    if (fn.async || fn.generator) return own;
    fn.params.forEach((p, i) => {
      if (!index.assigned.has(p.localId) && !index.captured.has(p.localId))
        own.set(this.localSlot(fn, p.localId), i);
    });
    return own;
  }

  /** The parameters each function may return as they came, directly or
   * through its locals, to a fixpoint (a returned call gives back what its
   * callee does). A call's value is then the arguments passed there, not a
   * result every caller shares. */
  private computeReturnedParams(): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const fn of this.mod.functions) {
        const own = this.ownParams(fn);
        if (own.size === 0 || !this.followed(fn.returnType)) continue;
        // The function's locals that take a value from another of them.
        const local = `l:${fn.name}\0`;
        const aliases = new Map<string, Set<string>>();
        const returned = new Set<string>();
        const alias = (to: string, value: IrExpr): void => {
          for (const from of this.slotsOf(fn, value)) {
            if (!from.startsWith(local)) continue;
            let set = aliases.get(from);
            if (!set) aliases.set(from, (set = new Set()));
            set.add(to);
          }
        };
        const expr = (e: IrExpr): boolean => {
          if (e.kind === "assignExpr") alias(this.localSlot(fn, e.localId), e.value);
          return everyExprChild(e, expr, stmt);
        };
        const stmt = (s: IrStmt): boolean => {
          if (s.kind === "varDecl" && s.init) alias(this.localSlot(fn, s.localId), s.init);
          else if (s.kind === "assign") alias(this.localSlot(fn, s.localId), s.value);
          else if (s.kind === "return" && s.value)
            for (const slot of this.slotsOf(fn, s.value)) returned.add(slot);
          return everyStmtChild(s, expr, stmt);
        };
        for (const s of fn.body) stmt(s);
        // From each parameter, the locals it reaches; those that reach a
        // return carry it back to the caller.
        const carriers = new Set<string>();
        let set = this.returnedParams.get(fn.name);
        for (const [param, i] of own) {
          const reached = new Map<string, string | null>([[param, null]]);
          const queue = [param];
          while (queue.length > 0)
            for (const to of aliases.get(queue.pop()!) ?? NO_SLOTS)
              if (!reached.has(to)) {
                reached.set(to, null);
                queue.push(to);
              }
          const back = [...reached.keys()].filter((slot) => returned.has(slot));
          if (back.length === 0) continue;
          if (!set?.has(i)) {
            if (!set) this.returnedParams.set(fn.name, (set = new Set()));
            set.add(i);
            changed = true;
          }
          // The locals on the way from the parameter to a return.
          for (const slot of reached.keys())
            if (slot === param || this.reaches(aliases, slot, back)) carriers.add(slot);
        }
        if (carriers.size > 0) this.returnCarriers.set(fn.name, carriers);
      }
    }
  }

  private reaches(
    aliases: ReadonlyMap<string, ReadonlySet<string>>,
    from: string,
    targets: readonly string[],
  ): boolean {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const slot = queue.pop()!;
      if (targets.includes(slot)) return true;
      for (const to of aliases.get(slot) ?? NO_SLOTS)
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
    }
    return false;
  }

  /** Builds the graph and marks every slot a field read reaches. */
  private computePinned(): void {
    this.computeReturnedParams();
    for (const fn of this.mod.functions) this.flow(fn, null);
    this.propagate([...this.seeds.keys()]);
  }

  /** Marks the slots the queued pinned slots reach. */
  private propagate(queue: string[]): void {
    const pin = (slot: string, origin: SrcLoc): void => {
      if (this.pinned.has(slot)) return;
      this.pinned.set(slot, origin);
      queue.push(slot);
    };
    while (queue.length > 0) {
      const slot = queue.pop()!;
      const origin = this.pinned.get(slot)!;
      // The edges of the slot, and those of the slots whose elements it is.
      let prefix = "";
      for (let inner = slot; ; inner = inner.slice(2)) {
        for (const to of this.edges.get(inner) ?? NO_SLOTS) pin(prefix + to, origin);
        if (!inner.startsWith("c:")) break;
        prefix += "c:";
      }
    }
  }

  /** Functions whose every result is an array nothing else keeps, or one
   * of their parameters (`passed`) that they only read, write in place and
   * return. */
  private computeFactories(): void {
    for (let changed = true; changed;) {
      changed = false;
      for (const fn of this.mod.functions) {
        if (this.factories.has(fn.name) || fn.async || fn.generator) continue;
        if (!this.holdsFieldArray(fn.returnType)) continue;
        let returns = 0;
        let ok = true;
        const passed = new Set<number>();
        const shares = new Map<string, SrcLoc>();
        this.shareSink = shares;
        const visit = (s: IrStmt): boolean => {
          if (s.kind === "return") {
            returns++;
            const local = s.value?.kind === "varRef" ? s.value.localId : null;
            const param = local !== null ? this.passedParam(fn, local) : -1;
            const carried = local !== null && param < 0 ? this.carrier(fn, local) : null;
            if (param >= 0) passed.add(param);
            else if (carried !== null && carried.size > 0)
              for (const i of carried) {
                if (this.passedParam(fn, fn.params[i]!.localId) < 0) ok = false;
                passed.add(i);
              }
            else if (!s.value || !this.fresh(fn, s.value)) ok = false;
          }
          return ok && everyStmtChild(s, () => true, visit);
        };
        for (const s of fn.body) visit(s);
        this.shareSink = null;
        if (ok && returns > 0) {
          this.factories.add(fn.name);
          if (passed.size > 0) this.passed.set(fn.name, passed);
          if (shares.size > 0) this.factoryShares.set(fn.name, shares);
          changed = true;
        }
      }
    }
  }

  /** The index of the parameter `localId` when `fn` only reads it, writes
   * it in place and returns it, directly or through `carrier` locals; -1
   * otherwise. */
  private passedParam(fn: IrFunction, localId: string): number {
    const i = fn.params.findIndex((p) => p.localId === localId);
    if (i < 0) return -1;
    const index = this.index(fn);
    if (index.assigned.has(localId) || index.captured.has(localId)) return -1;
    const uses = index.occurrences.get(localId) ?? [];
    const carried = (o: Occurrence): boolean => {
      const { parent: p, child } = valueUse(o);
      if (p?.kind === "varDecl" && p.init === child) return this.carrier(fn, p.localId) !== null;
      if (p?.kind === "assign" && p.value === child) return this.carrier(fn, p.localId) !== null;
      return false;
    };
    return uses.every((o) => returned(o) || this.use(o) !== "other" || carried(o)) ? i : -1;
  }

  /** The parameters a local carries to a return when its values are fresh
   * arrays and parameters, and it is only read, written in place and
   * returned; null otherwise. */
  private carrier(fn: IrFunction, localId: string): Set<number> | null {
    if (fn.params.some((p) => p.localId === localId)) return null;
    const index = this.index(fn);
    if (index.assignedByExpr.has(localId) || index.captured.has(localId)) return null;
    const declarations = index.declarations.get(localId) ?? [];
    if (declarations.length !== 1) return null;
    const key = `carrier:${fn.name}\0${localId}`;
    if (this.inProgress.has(key)) return null;
    this.inProgress.add(key);
    try {
      const init = (declarations[0]!.stmt as IrStmt & { kind: "varDecl" }).init;
      const values = [
        init,
        ...(index.assignments.get(localId) ?? []).map(
          (d) => (d.stmt as IrStmt & { kind: "assign" }).value,
        ),
      ];
      const params = new Set<number>();
      for (const v of values) {
        if (v === null || isUndefined(v)) continue;
        const param =
          v.kind === "varRef" ? fn.params.findIndex((p) => p.localId === v.localId) : -1;
        if (param >= 0) params.add(param);
        else if (!this.fresh(fn, v)) return null;
      }
      const uses = index.occurrences.get(localId) ?? [];
      return uses.every((o) => returned(o) || this.use(o) !== "other") ? params : null;
    } finally {
      this.inProgress.delete(key);
    }
  }

  /** One pass over `fn`: without `check`, the graph's edges; with it, the
   * writes and escapes of arrays fields may hold. */
  private flow(fn: IrFunction, check: ((issue: Issue) => void) | null): void {
    const carriers = this.returnCarriers.get(fn.name);
    const hold = (to: string, value: IrExpr): void => {
      if (check !== null || !this.followed(value.type)) return;
      for (const from of this.slotsOf(fn, value)) {
        this.edge(from, to);
        if (carriers?.has(to) && !carriers.has(from)) this.edge(from, `r:${fn.name}`);
      }
    };
    // Into the elements of the arrays, Maps or Sets `container` may be.
    const store = (container: IrExpr | string, value: IrExpr): void => {
      const slots = typeof container === "string" ? [container] : this.slotsOf(fn, container);
      for (const slot of slots) hold(`c:${slot}`, value);
    };
    // The elements of `from` join those of `to`.
    const spread = (from: IrExpr, to: IrExpr | string): void => {
      if (check !== null) return;
      const targets = typeof to === "string" ? [to] : this.slotsOf(fn, to);
      for (const a of this.slotsOf(fn, from))
        for (const b of targets) this.edge(`c:${a}`, `c:${b}`);
    };
    const write = (target: IrExpr, loc: SrcLoc, what: string): void => {
      if (check === null) return;
      const origin = this.origin(fn, target);
      if (origin !== undefined)
        check({
          loc,
          origin,
          reason: `${what} writes to an array that may be an InlineArray field's`,
        });
    };
    // `deep`: arrays inside the value escape too (dynamic and library code
    // reads them other than through the reads this pass follows).
    // `objects`: through the fields of class instances too (a dynamic view
    // reads them by name).
    const escape = (
      value: IrExpr,
      loc: SrcLoc,
      what: string,
      deep = true,
      objects = false,
    ): void => {
      if (check === null) return;
      const origin =
        this.origin(fn, value) ??
        (deep ? this.originWithin(this.slotsOf(fn, value), value.type, objects) : undefined);
      if (origin !== undefined)
        check({
          loc,
          origin,
          reason: `an array that may be an InlineArray field's reaches ${what}, where writes are not checked`,
        });
    };
    // Comparisons by identity of an array a field read may give.
    const identity = (value: IrExpr, loc: SrcLoc): void => {
      if (check === null) return;
      const origin = this.origin(fn, value);
      if (origin !== undefined)
        check({
          loc,
          origin,
          reason: IDENTITY_REASON,
        });
    };
    // The same for the elements of an array or Set, or the values of a Map,
    // that become a new Set's elements.
    const elementIdentity = (container: IrExpr, loc: SrcLoc): void => {
      if (check === null) return;
      const t = container.type;
      const elem =
        t.kind === "array" || t.kind === "set" ? t.elem : t.kind === "map" ? t.value : null;
      if (elem === null || !this.holdsFieldArray(elem)) return;
      for (const slot of this.slotsOf(fn, container)) {
        const origin = this.pinned.get(`c:${slot}`);
        if (origin === undefined) continue;
        check({
          loc,
          origin,
          reason: IDENTITY_REASON,
        });
        return;
      }
    };
    const args = (call: IrExpr & { args: IrExpr[] }): void => {
      const callees = this.callees(call);
      for (const { callee, offset } of callees) {
        const target = this.functions.get(callee);
        call.args.forEach((arg, i) => {
          const param = target?.params[i + offset];
          if (!target || !param) return escape(arg, call.loc, `a call to ${callee}`);
          hold(`l:${callee}\0${param.localId}`, arg);
        });
      }
      if (callees.length === 0) for (const arg of call.args) escape(arg, call.loc, "a method call");
    };
    // Dynamic values a library call that only reads them makes for it.
    const readSinks = new Set<IrExpr>();
    const expr = (e: IrExpr): boolean => {
      switch (e.kind) {
        case "assignExpr":
          hold(this.localSlot(fn, e.localId), e.value);
          break;
        case "call":
        case "new":
        case "virtualCall":
          args(e);
          break;
        case "bin":
          if (e.op === "===" || e.op === "!==") {
            identity(e.left, e.loc);
            identity(e.right, e.loc);
          }
          break;
        case "unionEq":
          identity(e.left, e.loc);
          identity(e.right, e.loc);
          break;
        case "arrIntrinsic": {
          if (!ARR_READS.has(e.method)) write(e.receiver, e.loc, `'${e.method}'`);
          if (IDENTITY_SEARCHES.has(e.method)) for (const a of e.args) identity(a, e.loc);
          // Copies hold the receiver's elements, and the arguments they add.
          const copy =
            ARR_COPIES.has(e.method) || e.method === "splice" || e.method === "spliceInsert";
          const into = copy ? this.site(fn, e) : e.receiver;
          if (copy) spread(e.receiver, into);
          for (const a of e.args)
            if (SPREADS.has(e.method) && typeKey(a.type) === typeKey(e.receiver.type))
              spread(a, into);
            else store(into, a);
          break;
        }
        case "mapIntrinsic":
        case "setIntrinsic":
          // Keys and Set elements are compared by identity, and so are a
          // Map's values when they become a Set's elements.
          if (e.args[0] !== undefined && KEYED.has(e.method)) identity(e.args[0], e.loc);
          if (e.method === "valueSet") elementIdentity(e.receiver, e.loc);
          if (e.method === "set" || e.method === "add")
            for (const a of e.args) store(e.receiver, a);
          else if (e.method === "clone" || e.method === "keySet" || e.method === "valueSet")
            spread(e.receiver, this.site(fn, e));
          break;
        case "arrayLit":
          e.elems.forEach((x, i) => {
            if (e.spreads?.includes(i)) spread(x, this.site(fn, e));
            else store(this.site(fn, e), x);
          });
          break;
        case "setNew":
          if (e.seed) {
            // The seed's elements become Set elements.
            elementIdentity(e.seed, e.loc);
            spread(e.seed, this.site(fn, e));
          }
          break;
        case "mapNew":
          for (const { key, value } of e.seed ?? []) {
            identity(key, e.loc);
            store(this.site(fn, e), key);
            store(this.site(fn, e), value);
          }
          break;
        case "recordLit":
          if (e.type.kind === "record") {
            const shape = e.type.shapeId;
            for (const f of e.fields) hold(`s:${shape}\0${f.name}`, f.value);
          }
          break;
        case "closure": {
          const lifted = this.functions.get(e.fnName);
          // A captured local is one binding on both sides.
          if (check === null)
            e.captures.forEach((id, i) => {
              const inner = lifted?.captures?.[i];
              if (inner === undefined) return;
              const outer = this.localSlot(fn, id);
              const captured = `l:${lifted!.name}\0${inner.localId}`;
              this.edge(outer, captured);
              this.edge(captured, outer);
            });
          break;
        }
        case "dynFrom":
        case "caughtToDyn":
          // Generic code reads no member of a viewed boxing by an unknown
          // name (inline-array-views.ts): its fields' arrays are read
          // through the members the dynamic value's code names.
          if (!readSinks.has(e))
            escape(e.value, e.loc, "a dynamic value", true, !this.plan.viewed.has(e));
          break;
        case "callValue":
          for (const a of e.args) escape(a, e.loc, "a call through a function value");
          break;
        case "intrinsic":
          // Printing reads its arguments; publishing freezes them.
          if (e.name.startsWith("console.") || e.name === "threads.publish") {
            for (const a of e.args) if (a.kind === "dynFrom") readSinks.add(a);
          } else for (const a of e.args) escape(a, e.loc, `'${e.name}'`);
          break;
        case "libCall":
          if (readsArguments(e)) {
            for (const a of e.args) if (a.kind === "dynFrom") readSinks.add(a);
          } else for (const a of e.args) escape(a, e.loc, `the library call ${e.fn}`);
          break;
        default:
          // Any other parent takes its child somewhere this pass does not
          // follow.
          if (!MODELLED.has(e.kind))
            everyExprChild(
              e,
              (child) => {
                escape(child, e.loc, `a '${e.kind}' expression`);
                return true;
              },
              () => true,
            );
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      switch (s.kind) {
        case "varDecl":
          if (s.init) hold(this.localSlot(fn, s.localId), s.init);
          break;
        case "assign":
          hold(this.localSlot(fn, s.localId), s.value);
          break;
        case "return":
          if (s.value === null) break;
          // A promise or iterator holds the value.
          if (fn.async || fn.generator)
            escape(s.value, s.loc, "the result of an async function or generator");
          // A parameter returned as it came is the caller's argument. The
          // result of a function value may be any such function's.
          else if (check === null && this.followed(s.value.type))
            for (const from of this.slotsOf(fn, s.value)) {
              if (carriers?.has(from)) continue;
              this.edge(from, `r:${fn.name}`);
              if (this.escapedFunctions.has(fn.name)) this.edge(from, "r:*");
            }
          break;
        case "fieldSet":
          hold(this.fieldSlot(s.className, s.field), s.value);
          break;
        case "recordSet":
          hold(`s:${s.shapeId}\0${s.field}`, s.value);
          break;
        case "arraySet":
          write(s.arr, s.loc, "an element assignment");
          store(s.arr, s.value);
          break;
        case "arraySetLength":
          write(s.arr, s.loc, "a 'length' assignment");
          break;
        case "arraySetUndefined":
        case "arrayDelete":
          write(s.arr, s.loc, "an element assignment");
          break;
        case "forOf":
          // The binding takes the elements of an array, Map or Set.
          if (check === null)
            for (const from of this.slotsOf(fn, s.iterable))
              this.edge(`c:${from}`, this.localSlot(fn, s.localId));
          break;
        case "throw":
          escape(s.value, s.loc, "a throw");
          break;
        case "recordKeySet":
          escape(s.value, s.loc, "a dynamically keyed property");
          break;
      }
      return everyStmtChild(s, expr, stmt);
    };
    for (const s of fn.body) stmt(s);
  }

  // ── Checks ──

  /** Every inline `new` passes an array nothing else keeps (or a field's). */
  private checkSources(): void {
    const shared = new Map<string, SrcLoc>();
    this.shareSink = shared;
    this.checkConstructions();
    this.shareSink = null;
    // The shared arrays are followed from their definitions.
    const queue: string[] = [];
    for (const [slot, loc] of shared)
      if (!this.pinned.has(slot)) {
        this.pinned.set(slot, loc);
        queue.push(slot);
      }
    this.propagate(queue);
  }

  private checkConstructions(): void {
    for (const fn of this.mod.functions)
      this.eachExpr(fn, (e) => {
        const inline = this.inlineNew(e);
        if (inline !== null && e.kind === "new") {
          const arg = e.args[inline.arg];
          if (arg !== undefined && !this.fresh(fn, arg))
            this.report(
              {
                loc: arg.loc,
                reason:
                  "the array passed to the constructor may be kept elsewhere (pass a new array, a copy, or a local array's last use)",
              },
              this.ownerOf(e.className),
            );
        }
        if (inline !== null || (e.kind !== "call" && e.kind !== "new" && e.kind !== "virtualCall"))
          return;
        e.args.forEach((arg, i) => {
          if (!this.consumes(e, i) || this.fresh(fn, arg)) return;
          this.report({
            loc: arg.loc,
            reason:
              "the array passed here moves into an InlineArray field but may be kept elsewhere (pass a new array, a copy, or a local array's last use)",
          });
        });
      });
  }

  private checkWrites(): void {
    for (const fn of this.mod.functions) this.flow(fn, (issue) => this.report(issue));
  }

  private ownerOf(className: string): { declaringClass: string; field: string } {
    const cls = this.plan.classes.get(className)!;
    return { declaringClass: cls.declaringClass, field: cls.field };
  }
}
