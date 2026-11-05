/* Dynamic values of instances that may hold an InlineArray field
 * (ir/inline-arrays.ts).
 *
 * Boxing an instance into a dynamic value (dynFrom, caughtToDyn) keeps the
 * instance: a checked cast or a class test on the value gives the instance
 * back, and the compiler's class dispatch for a dynamic member read or
 * method call is IR that uses the instance as typed code does (a read of the
 * inline field there is followed by inline-array-sources.ts like any
 * other). Generic dynamic operations instead read the fields through a view
 * of the instance, where the inline field gives a new array over the
 * elements each time, and Node.js gives the field's one array. The two agree
 * as long as no such operation reads the field by name, enumerates the
 * instance's properties for code that can keep or write them, or writes the
 * field.
 *
 * This pass follows the dynamic values that may hold such an instance from
 * the boxings, through the slots that hold dynamic values (locals,
 * parameters, results, globals, class and record fields, the elements of
 * arrays, Maps and Sets, the members of dynamic objects and arrays, and the
 * receivers and arguments of calls through function values and of the
 * callbacks of array methods, whose callees it follows from the closures
 * that reach them), and reports the first operation on one of them that is
 * not known to keep those reads away from the field: a keyed read or write
 * whose key is the field's name or not a literal, a checked cast to a type
 * that has a record member of the field's name or holds a dynamic value, a
 * call through a value no compiled function reaches, or a library call
 * other than printing, JSON.stringify without a replacer, publishing,
 * cloning for a worker, and the class tests and checked casts that give the
 * instance back. */

import type { IrExpr, IrFunction, IrModule, IrStmt, IrType, SrcLoc } from "./ir.js";
import { readsArguments } from "./inline-arrays.js";
import { everyExprChild, everyStmtChild } from "./traverse.js";

/** Why a dynamic value that may hold an instance breaks the contract, and
 * where. */
export interface InlineArrayViewIssue {
  readonly reason: string;
  readonly loc: SrcLoc;
}

/** The class dispatch's normalization of a capsule (class-dynamic-dispatch.ts):
 * its result holds the instance its argument holds. */
export const NORMALIZE = "%dyn.class.normalize";

const DYN_KINDS: ReadonlySet<IrType["kind"]> = new Set(["dyn", "jsval", "caught"]);

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
  "dynDestrCheck",
]);

/** Expressions that only look at a dynamic value: kind tests and
 * comparisons. */
const OBSERVE: ReadonlySet<IrExpr["kind"]> = new Set([
  "dynTest",
  "dynScalarEq",
  "dynHasKey",
  "toBool",
  "strEq",
  "unionEq",
  "unionIsTag",
  "unionDisc",
  "instanceOf",
  "instanceOfValue",
  "bin",
  "unary",
]);

/** Library calls that look at a dynamic value without handing its members
 * to other code, or give the instance back. */
const READS: ReadonlySet<string> = new Set([
  "js.fromDyn",
  "js.toDyn",
  "dyn.this",
  "dyn.typedRefIs",
  "dyn.typedRefKeyIs",
  "dyn.classHash",
  "dyn.getPrototypeForIdentity",
  "dyn.hasKey",
  "dyn.hasOwn",
  "dyn.in",
  "dyn.arrLen",
  "dyn.typeof",
  "dyn.objectTag",
  // Keys alone.
  "dyn.forInKeyStrings",
  "dyn.forInKeys",
  "dyn.forInStable",
  "dyn.objKeys",
  "dyn.objKeyStrings",
  "dyn.ownKeys",
  "dyn.getOwnPropertyNames",
  // The operators and conversions that make a number, string or bigint of
  // a value: an instance converts through its class's own methods.
  "js.add",
  "js.arithmetic",
  "js.bitwise",
  "js.compare",
  "js.increment",
  "js.toF64",
  "js.toNumberCoerce",
  "js.toNumeric",
  "dyn.add",
  "dyn.abstractEq",
  "dyn.arithmetic",
  "dyn.bitwise",
  "dyn.compare",
  "dyn.increment",
  "dyn.numberConstructor",
  "dyn.stringConstructor",
  "dyn.toNumberCoerce",
  "dyn.toNumeric",
  "dyn.toString",
  "dyn.toStringCoerce",
  // Adoption turns shared source nodes into capsules of the native value;
  // it reads nothing the program sees.
  "dyn.adoptShared",
  // A worker's data is a structured clone, as in Node.js: the clone holds
  // the elements, not the field.
  "worker.new",
]);

/** Library calls that read a member of a dynamic value by the key in their
 * second argument: the member is followed as the value's. */
const KEYED_READS: ReadonlySet<string> = new Set(["dyn.bagGet", "dyn.arrAt"]);

/** Library calls that iterate their first argument: an array's elements, or
 * what an iterable class's own iterator gives. Their results are followed as
 * the argument's members. */
const ITERATES: ReadonlySet<string> = new Set([
  "dyn.iterator",
  "dyn.iteratorStep",
  "dyn.iteratorStepDone",
  "dyn.iteratorResult",
  "dyn.iteratorCanStep",
]);

/** Library calls that store their third argument into a member of their
 * first, keyed by their second. */
const KEYED_WRITES: ReadonlySet<string> = new Set(["dyn.keySet", "dyn.keyDelete"]);

/** The callee name of the iterator protocol's calls the lowering makes for
 * `for...of`, spreads and `yield*` over a dynamic iterable: the iterator's
 * `next`, `return` and `throw`. */
const ITERATOR_METHOD = "iterator method";

/** Methods of arrays, Maps and Sets a dynamic call may run that give the
 * receiver's elements, or iterators over them, without keeping or writing
 * them: their results are followed as the receiver's members. */
const ELEMENT_METHODS: ReadonlySet<string> = new Set([
  "values",
  "keys",
  "entries",
  "get",
  "has",
  "at",
  "indexOf",
  "includes",
  "slice",
]);

/** Methods of arrays, Maps and Sets a dynamic call may run that call their
 * first argument with each element (or value and key), its index (or key)
 * and the receiver, and what their results hold: the receiver's members,
 * the callback's results, or neither. */
const CALLBACK_METHODS: ReadonlyMap<string, "members" | "results" | "none"> = new Map([
  ["forEach", "none"],
  ["some", "none"],
  ["every", "none"],
  ["findIndex", "none"],
  ["findLastIndex", "none"],
  ["filter", "members"],
  ["find", "members"],
  ["findLast", "members"],
  ["map", "results"],
]);

/** Methods a dynamic call may run on a dynamic receiver whose arguments it
 * only copies as a structured clone or publishes. */
const CLONING_METHODS: ReadonlySet<string> = new Set(["postMessage"]);

/** The first operation that may let generic dynamic code read or write the
 * inline field `field` of an instance boxed at one of `boxings`, or null. */
export function inlineArrayViewIssue(
  mod: IrModule,
  boxings: ReadonlySet<IrExpr>,
  field: string,
): InlineArrayViewIssue | null {
  if (boxings.size === 0) return null;
  return new ViewAnalysis(mod, boxings, field).run();
}

/** A call through a function value or a dynamic value. */
interface ValueCall {
  readonly fn: IrFunction;
  readonly call: IrExpr & { kind: "callValue" | "dynCall" };
}

/** A dynamic call of one of CALLBACK_METHODS. */
interface CallbackCall {
  readonly fn: IrFunction;
  readonly call: IrExpr & { kind: "dynInvoke" };
}

class ViewAnalysis {
  private readonly functions = new Map<string, IrFunction>();
  private readonly methodImpls = new Map<string, string[]>();
  private readonly bases = new Map<string, string | undefined>();
  private readonly recordFields = new Map<string, readonly string[]>();
  private readonly unions = new Map<string, readonly IrType[]>();
  private readonly edges = new Map<string, Set<string>>();
  /** `edges` reversed: where a slot's values come from. */
  private readonly sources = new Map<string, Set<string>>();
  private readonly sites = new Map<IrExpr, string>();
  /** The function each closure's site makes. */
  private readonly closures = new Map<string, string>();
  private readonly valueCalls: ValueCall[] = [];
  private readonly callbackCalls: CallbackCall[] = [];
  /** The compiled functions each value call, or each callback method call's
   * callback, may run. */
  private readonly targets = new Map<IrExpr, Set<string>>();
  private readonly held = new Set<string>();
  /** Whether values of each record shape and union (`r:` and `u:` keys)
   * hold dynamic values (`dynish`), and whether checked casts to them
   * recover (`recovers`). */
  private readonly dynParts = new Map<string, boolean>();
  private readonly recoveringParts = new Map<string, boolean>();
  /** The slots each function's return statements return. */
  private readonly returns = new Map<string, string[][]>();
  /** The parameters (by index) a function may return as they came. */
  private readonly returnedParams = new Map<string, Set<number>>();
  private edgeCount = 0;

  constructor(
    private readonly mod: IrModule,
    private readonly boxings: ReadonlySet<IrExpr>,
    private readonly field: string,
  ) {
    for (const fn of mod.functions) this.functions.set(fn.name, fn);
    for (const cls of mod.classes ?? []) {
      this.bases.set(cls.name, cls.base);
      for (const m of cls.methods ?? []) {
        let list = this.methodImpls.get(m);
        if (!list) this.methodImpls.set(m, (list = []));
        list.push(`%${cls.name}.${m}`);
      }
    }
    for (const r of mod.records ?? [])
      this.recordFields.set(
        r.id,
        r.fields.map((f) => f.name),
      );
    for (const u of mod.unions ?? []) this.unions.set(u.id, u.arms);
  }

  run(): InlineArrayViewIssue | null {
    // A function that returns one of its parameters as it came gives each
    // caller that caller's argument back, so one call's argument does not
    // reach every caller's result. Which parameters a function returns
    // depends on the graph, which depends on the calls' results: the graph
    // grows until both settle.
    for (let changed = true; changed;) {
      this.returns.clear();
      this.valueCalls.length = 0;
      this.callbackCalls.length = 0;
      const before = this.edgeCount;
      for (const fn of this.mod.functions) this.flow(fn, null);
      // Calls through values run the closures that reach their callees; the
      // edges to their parameters can bring more closures to other calls.
      for (let resolved = true; resolved;) {
        resolved = false;
        for (const { fn, call } of this.valueCalls) resolved = this.resolve(fn, call) || resolved;
        for (const { fn, call } of this.callbackCalls)
          resolved = this.resolveCallback(fn, call) || resolved;
      }
      changed = this.settleReturns() || this.edgeCount !== before;
    }
    const queue = [...this.boxings].map((e) => this.site(e));
    for (const slot of queue) this.held.add(slot);
    while (queue.length > 0) {
      const slot = queue.pop()!;
      for (const next of this.edges.get(slot) ?? [])
        if (!this.held.has(next)) {
          this.held.add(next);
          queue.push(next);
        }
    }
    let issue: InlineArrayViewIssue | null = null;
    for (const fn of this.mod.functions) {
      this.flow(fn, (found) => (issue ??= found));
      if (issue !== null) return issue;
    }
    return null;
  }

  // ── Types and slots ──

  /** Whether values of `t` are, or contain, dynamic values. */
  private dynish(t: IrType, depth = 0, within: ReadonlySet<string> = new Set()): boolean {
    if (DYN_KINDS.has(t.kind)) return true;
    // A type too deep to look through counts as one that holds them.
    if (depth > 32) return true;
    const part = (p: IrType, inside = within): boolean => this.dynish(p, depth + 1, inside);
    switch (t.kind) {
      case "array":
      case "set":
        return part(t.elem);
      case "map":
        return part(t.key) || part(t.value);
      case "union":
      case "record": {
        // A record or union type that holds itself holds dynamic values
        // when its other parts do. Only a result that assumed nothing about
        // an enclosing type is kept.
        const key = t.kind === "union" ? `u:${t.unionId}` : `r:${t.shapeId}`;
        if (within.has(key)) return false;
        const known = this.dynParts.get(key);
        if (known !== undefined) return known;
        const inside = new Set(within).add(key);
        const result =
          t.kind === "union"
            ? (this.unions.get(t.unionId) ?? []).some((arm) => part(arm, inside))
            : ((this.mod.records ?? [])
                .find((r) => r.id === t.shapeId)
                ?.fields.some((f) => part(f.type, inside)) ?? false);
        if (within.size === 0) this.dynParts.set(key, result);
        return result;
      }
      default:
        return false;
    }
  }

  /** Whether a checked cast to `t` takes no member of the value that can
   * hold the field's array: a class instance comes back as itself, a scalar
   * or a function is converted, and a dynamic value stays one; a record is
   * built from the members its fields name, and an array, Map or Set from
   * the elements, each converted by its own type. The members and elements
   * convert this way too, the field's name names none, and none holds a
   * dynamic value, which would not be followed. A record or union type that
   * holds itself recovers when its other parts do. */
  private recovers(t: IrType, depth = 0, within: ReadonlySet<string> = new Set()): boolean {
    if (depth > 32) return false;
    const part = (p: IrType, inside = within): boolean =>
      !this.dynish(p) && this.recovers(p, depth + 1, inside);
    switch (t.kind) {
      case "array":
      case "set":
        return part(t.elem);
      case "map":
        return part(t.key) && part(t.value);
      case "union":
      case "record": {
        // Only a result that assumed nothing about an enclosing type is
        // kept.
        const key = t.kind === "union" ? `u:${t.unionId}` : `r:${t.shapeId}`;
        if (within.has(key)) return true;
        const known = this.recoveringParts.get(key);
        if (known !== undefined) return known;
        const inside = new Set(within).add(key);
        let result: boolean;
        if (t.kind === "union")
          result = (this.unions.get(t.unionId) ?? []).every((arm) =>
            this.recovers(arm, depth + 1, inside),
          );
        else {
          const shape = (this.mod.records ?? []).find((r) => r.id === t.shapeId);
          result =
            shape !== undefined &&
            shape.fields.every((f) => f.name !== this.field && part(f.type, inside));
        }
        if (within.size === 0) this.recoveringParts.set(key, result);
        return result;
      }
      default:
        return true;
    }
  }

  /** Whether the graph follows values of `t`: dynamic values, and function
   * values, which calls through values need. */
  private followed(t: IrType): boolean {
    return t.kind === "func" || this.dynish(t);
  }

  private rootOf(className: string): string {
    let name = className;
    for (let base = this.bases.get(name); base !== undefined; base = this.bases.get(name))
      name = base;
    return name;
  }

  private localSlot(fn: IrFunction, id: string): string {
    return id.startsWith("%g.") ? `g:${id}` : `l:${fn.name}\0${id}`;
  }

  private site(e: IrExpr): string {
    let slot = this.sites.get(e);
    if (slot === undefined) this.sites.set(e, (slot = `x:${this.sites.size}`));
    return slot;
  }

  /** A dynamic value's slots and the slots of what it holds: a member read
   * from it may be any of them. */
  private deep(slots: readonly string[]): string[] {
    return [...slots, ...slots.map((s) => `c:${s}`)];
  }

  private recordSlots(t: IrType): string[] {
    if (t.kind !== "record") return [];
    return (this.recordFields.get(t.shapeId) ?? []).map((f) => `s:${t.shapeId}\0${f}`);
  }

  /** The slots the value of `e` may come from. */
  private slotsOf(fn: IrFunction, e: IrExpr): string[] {
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
      case "varRef":
        return [this.localSlot(fn, e.localId)];
      case "dynFrom":
      case "caughtToDyn":
        if (this.boxings.has(e)) return [this.site(e)];
        return [...this.slotsOf(fn, e.value), ...this.recordSlots(e.value.type)];
      case "closure":
        return [this.site(e)];
      case "call":
        // Normalization boxes the instance of a capsule at its own class.
        if (e.callee === NORMALIZE && e.args[0] !== undefined) return this.slotsOf(fn, e.args[0]);
        return this.results(fn, e);
      case "virtualCall":
        return this.results(fn, e);
      case "callValue":
        return [this.site(e)];
      case "dynCall":
        // An iterator step gives what the iterator iterates.
        return e.calleeName === ITERATOR_METHOD && e.receiver !== undefined
          ? [this.site(e), ...this.deep(this.slotsOf(fn, e.receiver))]
          : [this.site(e)];
      case "fieldGet":
        return [`f:${this.rootOf(e.className)}\0${e.field}`];
      case "recordGet":
        return e.obj.type.kind === "record" ? [`s:${e.obj.type.shapeId}\0${e.field}`] : [];
      case "arrayGet":
        return this.slotsOf(fn, e.arr).map((s) => `c:${s}`);
      case "mapIntrinsic":
      case "setIntrinsic":
      case "arrIntrinsic":
        return this.slotsOf(fn, e.receiver).map((s) => `c:${s}`);
      case "dynKeyGet":
      case "dynIterN":
        return this.deep(this.slotsOf(fn, e.value));
      case "dynInvoke":
        if (ELEMENT_METHODS.has(e.method) || CALLBACK_METHODS.get(e.method) === "members")
          return this.deep(this.slotsOf(fn, e.recv));
        return CALLBACK_METHODS.get(e.method) === "results" ? [this.site(e)] : [];
      case "dynCheck":
        return this.followed(e.type) ? this.deep(this.slotsOf(fn, e.value)) : [];
      case "libCall":
        if (e.fn === "dyn.this") return [`t:${fn.name}`];
        if ((KEYED_READS.has(e.fn) || ITERATES.has(e.fn)) && e.args[0] !== undefined)
          return this.deep(this.slotsOf(fn, e.args[0]));
        if ((e.fn === "js.toDyn" || e.fn === "js.fromDyn") && e.args[0] !== undefined)
          return this.slotsOf(fn, e.args[0]);
        return [];
      case "arrayLit":
      case "dynObjLit":
      case "dynArrLit":
      case "recordLit":
      case "setNew":
      case "mapNew":
        return [this.site(e)];
      default:
        return PASS_THROUGH.has(e.kind) ? children() : [];
    }
  }

  /** The slots a call's value may come from: its callees' results, and the
   * arguments at the parameters they return. */
  private results(fn: IrFunction, e: IrExpr & { kind: "call" | "virtualCall" }): string[] {
    const slots: string[] = [];
    for (const { callee, offset } of this.callees(e)) {
      slots.push(`r:${callee}`);
      for (const i of this.returnedParams.get(callee) ?? [])
        if (e.args[i - offset] !== undefined) slots.push(...this.slotsOf(fn, e.args[i - offset]!));
    }
    return slots;
  }

  /** Decides each function's returns: a returned slot that holds only what
   * the function's parameters came with (a parameter, or a local every
   * value of which comes from such slots) makes those parameters returned;
   * any other returned slot flows to the function's result. Returns whether
   * a parameter became returned. */
  private settleReturns(): boolean {
    let changed = false;
    for (const [name, returned] of this.returns) {
      const fn = this.functions.get(name)!;
      const params = new Map(fn.params.map((p, i) => [this.localSlot(fn, p.localId), i]));
      const own = new Set(fn.locals.map((l) => this.localSlot(fn, l.id)));
      // The carriers: parameters, and locals all of whose sources are
      // carriers.
      const carriers = new Set(params.keys());
      for (let grew = true; grew;) {
        grew = false;
        for (const slot of own) {
          if (carriers.has(slot)) continue;
          const sources = this.sources.get(slot);
          if (
            sources !== undefined &&
            sources.size > 0 &&
            [...sources].every((s) => carriers.has(s))
          ) {
            carriers.add(slot);
            grew = true;
          }
        }
      }
      let set = this.returnedParams.get(name);
      for (const slots of returned)
        for (const slot of slots) {
          if (!carriers.has(slot)) {
            this.edge(slot, `r:${name}`);
            continue;
          }
          // The parameters the carrier's values come from.
          const queue = [slot];
          const seen = new Set(queue);
          while (queue.length > 0) {
            const at = queue.pop()!;
            const index = params.get(at);
            if (index !== undefined) {
              if (set === undefined) this.returnedParams.set(name, (set = new Set()));
              if (!set.has(index)) {
                set.add(index);
                changed = true;
              }
            }
            for (const from of this.sources.get(at) ?? [])
              if (carriers.has(from) && !seen.has(from)) {
                seen.add(from);
                queue.push(from);
              }
          }
        }
    }
    return changed;
  }

  private edge(from: string, to: string): boolean {
    let list = this.edges.get(from);
    if (!list) this.edges.set(from, (list = new Set()));
    if (list.has(to)) return false;
    list.add(to);
    this.edgeCount++;
    let back = this.sources.get(to);
    if (!back) this.sources.set(to, (back = new Set()));
    back.add(from);
    return true;
  }

  private holds(fn: IrFunction, e: IrExpr): boolean {
    return this.slotsOf(fn, e).some((s) => this.held.has(s));
  }

  /** Whether `e`, or a member of it, may be a closure's value: a method
   * call on it may run that closure with it as `this`. */
  private mayHoldFunction(fn: IrFunction, e: IrExpr): boolean {
    return this.closuresAt(this.deep(this.slotsOf(fn, e)));
  }

  // ── Calls ──

  /** The functions a call, construction or method call may run, with the
   * offset of its first argument in their parameters. */
  private callees(e: IrExpr): { callee: string; offset: number }[] {
    switch (e.kind) {
      case "call":
        return [{ callee: e.callee, offset: 0 }];
      case "new":
        return [{ callee: `%${e.className}.constructor`, offset: 1 }];
      case "virtualCall": {
        const impls =
          e.targets !== undefined
            ? e.targets.map((c) => `%${c}.${e.method}`)
            : (this.methodImpls.get(e.method) ?? []);
        return impls.map((callee) => ({ callee, offset: 0 }));
      }
      default:
        return [];
    }
  }

  /** Connects a call through a value to the closures that reach its
   * callee: its receiver to their `this`, its arguments to their
   * parameters that take dynamic or function values (a typed parameter
   * takes its argument through a checked cast), and their results to the
   * call's. Returns whether it added an edge. */
  private resolve(fn: IrFunction, call: IrExpr & { kind: "callValue" | "dynCall" }): boolean {
    let targets = this.targets.get(call);
    if (targets === undefined) this.targets.set(call, (targets = new Set()));
    this.closuresAt(this.slotsOf(fn, call.callee), targets);
    let changed = false;
    const site = this.site(call);
    for (const name of targets) {
      const target = this.functions.get(name);
      if (target === undefined) continue;
      changed = this.edge(`r:${name}`, site) || changed;
      if (call.kind === "dynCall" && call.receiver !== undefined)
        for (const from of this.slotsOf(fn, call.receiver))
          changed = this.edge(from, `t:${name}`) || changed;
      call.args.forEach((arg, i) => {
        const param = target.params[i];
        if (param === undefined || !this.followed(param.type) || !this.followed(arg.type)) return;
        for (const from of this.slotsOf(fn, arg))
          changed = this.edge(from, this.localSlot(target, param.localId)) || changed;
      });
    }
    return changed;
  }

  /** Adds to `into` the functions of the closures whose values may reach
   * `slots`; returns whether there is one. */
  private closuresAt(slots: readonly string[], into?: Set<string>): boolean {
    const seen = new Set(slots);
    const queue = [...slots];
    let found = false;
    while (queue.length > 0) {
      const slot = queue.pop()!;
      const closure = this.closures.get(slot);
      if (closure !== undefined) {
        found = true;
        if (into === undefined) return true;
        into.add(closure);
      }
      for (const from of this.sources.get(slot) ?? [])
        if (!seen.has(from)) {
          seen.add(from);
          queue.push(from);
        }
    }
    return found;
  }

  /** Connects a callback method call to the closures that reach its first
   * argument: the receiver's members to their first two parameters, the
   * receiver to their third, and for `map` their results to the call's.
   * Returns whether it added an edge. */
  private resolveCallback(fn: IrFunction, call: IrExpr & { kind: "dynInvoke" }): boolean {
    let targets = this.targets.get(call);
    if (targets === undefined) this.targets.set(call, (targets = new Set()));
    const callback = call.args[0];
    if (callback === undefined) return false;
    this.closuresAt(this.slotsOf(fn, callback), targets);
    const receiver = this.slotsOf(fn, call.recv);
    const members = this.deep(receiver);
    let changed = false;
    for (const name of targets) {
      const target = this.functions.get(name);
      if (target === undefined) continue;
      if (CALLBACK_METHODS.get(call.method) === "results")
        changed = this.edge(`r:${name}`, this.site(call)) || changed;
      [members, members, receiver].forEach((slots, i) => {
        const param = target.params[i];
        if (param === undefined || !this.followed(param.type)) return;
        for (const from of slots)
          changed = this.edge(from, this.localSlot(target, param.localId)) || changed;
      });
    }
    return changed;
  }

  // ── The walk ──

  /** Builds the slot graph (`check` null), or reports the first operation
   * that takes a held dynamic value where generic code may read or write the
   * field. */
  private flow(fn: IrFunction, check: ((issue: InlineArrayViewIssue) => void) | null): void {
    const hold = (to: string, value: IrExpr): void => {
      if (check !== null || (!this.followed(value.type) && !this.boxings.has(value))) return;
      for (const from of this.slotsOf(fn, value)) this.edge(from, to);
    };
    const holdIn = (container: IrExpr, value: IrExpr): void => {
      for (const slot of this.slotsOf(fn, container)) hold(`c:${slot}`, value);
    };
    const report = (value: IrExpr, loc: SrcLoc, what: string): void => {
      if (check !== null && this.holds(fn, value))
        check({
          loc,
          reason: `an instance, or a value that can hold one, becomes a dynamic value that reaches ${what}, where a dynamic view of an inline field would read it as a new array each time`,
        });
    };
    // A keyed read or write names the field, or any member when its key is
    // not a literal.
    const keyed = (receiver: IrExpr, key: IrExpr | undefined, loc: SrcLoc, what: string): void => {
      if (key === undefined || key.kind !== "strLit" || key.value === this.field)
        report(receiver, loc, `${what} of a member that may be the field`);
    };
    // A write may also be an array's: an element, or its length.
    const keyedWrite = (
      receiver: IrExpr,
      key: IrExpr | undefined,
      loc: SrcLoc,
      what: string,
    ): void => {
      keyed(receiver, key, loc, what);
      if (key?.kind === "strLit" && (key.value === "length" || /^(0|[1-9][0-9]*)$/.test(key.value)))
        report(receiver, loc, `${what} of an array element or length`);
    };
    const args = (call: IrExpr & { args: IrExpr[] }): void => {
      const callees = this.callees(call);
      for (const { callee, offset } of callees) {
        const target = this.functions.get(callee);
        call.args.forEach((arg, i) => {
          const param = target?.params[i + offset];
          if (target === undefined || param === undefined)
            return report(arg, call.loc, `a call to ${callee}`);
          hold(this.localSlot(target, param.localId), arg);
        });
      }
      if (callees.length === 0) for (const arg of call.args) report(arg, call.loc, "a method call");
    };
    // A call through a value no compiled function reaches may run library
    // code.
    const valueCall = (call: IrExpr & { kind: "callValue" | "dynCall" }): void => {
      if (check === null) {
        this.valueCalls.push({ fn, call });
        return;
      }
      if ((this.targets.get(call)?.size ?? 0) > 0) return;
      // An iterator that is no compiled function's is the runtime's, over
      // an array, a string or a collection.
      if (call.kind === "dynCall" && call.calleeName === ITERATOR_METHOD) return;
      const what = "a call through a value no compiled function reaches";
      for (const a of call.args) report(a, call.loc, what);
      if (call.kind === "dynCall" && call.receiver !== undefined)
        report(call.receiver, call.loc, what);
    };
    // A callback method of an array, Map or Set runs its callback, which a
    // compiled function must be; the receiver's own method of that name
    // instead, a function it holds, may be any code.
    const callbackCall = (call: IrExpr & { kind: "dynInvoke" }): void => {
      if (check === null) {
        this.callbackCalls.push({ fn, call });
        return;
      }
      const what = `the dynamic method call '${call.method}'`;
      if ((this.targets.get(call)?.size ?? 0) === 0)
        report(call.recv, call.loc, `${what} with a callback no compiled function reaches`);
      else if (this.mayHoldFunction(fn, call.recv))
        report(call.recv, call.loc, `${what} on a value that may hold a function`);
      for (const a of call.args.slice(1)) report(a, call.loc, what);
    };
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
        case "callValue":
        case "dynCall":
          valueCall(e);
          break;
        case "closure": {
          if (check !== null) break;
          this.closures.set(this.site(e), e.fnName);
          const lifted = this.functions.get(e.fnName);
          // A captured local is one binding on both sides.
          e.captures.forEach((id, i) => {
            const inner = lifted?.captures?.[i];
            if (inner === undefined) return;
            const outer = this.localSlot(fn, id);
            const captured = this.localSlot(lifted!, inner.localId);
            this.edge(outer, captured);
            this.edge(captured, outer);
          });
          break;
        }
        case "recordLit":
          if (e.type.kind === "record") {
            const shape = e.type.shapeId;
            for (const f of e.fields) hold(`s:${shape}\0${f.name}`, f.value);
          }
          break;
        case "arrayLit":
          for (const x of e.elems) hold(`c:${this.site(e)}`, x);
          break;
        case "dynArrLit":
          for (const x of e.elems) hold(this.site(e), x);
          break;
        case "dynObjLit":
          for (const f of e.fields ?? []) hold(this.site(e), f.value);
          break;
        case "mapNew":
          for (const { key, value } of e.seed ?? []) {
            hold(`c:${this.site(e)}`, key);
            hold(`c:${this.site(e)}`, value);
          }
          break;
        case "setNew":
          // The seed's elements become the Set's.
          if (e.seed && check === null)
            for (const from of this.slotsOf(fn, e.seed))
              this.edge(`c:${from}`, `c:${this.site(e)}`);
          break;
        case "arrIntrinsic":
        case "mapIntrinsic":
        case "setIntrinsic":
          for (const a of e.args) holdIn(e.receiver, a);
          break;
        case "dynKeyGet":
          keyed(e.value, e.key, e.loc, "a keyed read");
          break;
        case "dynCheck":
          // A cast to a class gives the instance back; a cast to a record,
          // array or collection type builds it from the members it names
          // or the elements.
          if (!this.recovers(e.type)) report(e.value, e.loc, "a checked cast to a structured type");
          break;
        case "dynInvoke":
          if (CALLBACK_METHODS.has(e.method)) {
            callbackCall(e);
            break;
          }
          if (!ELEMENT_METHODS.has(e.method))
            report(e.recv, e.loc, `the dynamic method call '${e.method}'`);
          else if (check !== null && this.mayHoldFunction(fn, e.recv))
            report(
              e.recv,
              e.loc,
              `the dynamic method call '${e.method}' on a value that may hold a function`,
            );
          if (!CLONING_METHODS.has(e.method))
            for (const a of e.args) report(a, e.loc, `the dynamic method call '${e.method}'`);
          break;
        case "libCall":
          if (KEYED_READS.has(e.fn))
            keyed(e.args[0]!, e.args[1], e.loc, `the library call ${e.fn}`);
          else if (KEYED_WRITES.has(e.fn)) {
            keyedWrite(e.args[0]!, e.args[1], e.loc, `the library call ${e.fn}`);
            if (e.args[2] !== undefined)
              for (const slot of this.slotsOf(fn, e.args[0]!)) hold(slot, e.args[2]);
          } else if (!READS.has(e.fn) && !ITERATES.has(e.fn) && !readsArguments(e))
            for (const a of e.args) report(a, e.loc, `the library call ${e.fn}`);
          break;
        case "intrinsic":
          // Printing reads its arguments; publishing freezes them.
          if (!e.name.startsWith("console.") && e.name !== "threads.publish")
            for (const a of e.args) report(a, e.loc, `'${e.name}'`);
          break;
        default:
          if (!PASS_THROUGH.has(e.kind) && !OBSERVE.has(e.kind) && !MODELLED.has(e.kind))
            everyExprChild(
              e,
              (child) => {
                report(child, e.loc, `a '${e.kind}' expression`);
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
          if (
            s.value !== null &&
            check === null &&
            (this.followed(s.value.type) || this.boxings.has(s.value))
          ) {
            let list = this.returns.get(fn.name);
            if (!list) this.returns.set(fn.name, (list = []));
            list.push(this.slotsOf(fn, s.value));
          }
          break;
        case "fieldSet":
          hold(`f:${this.rootOf(s.className)}\0${s.field}`, s.value);
          break;
        case "recordSet":
          hold(`s:${s.shapeId}\0${s.field}`, s.value);
          break;
        case "arraySet":
          holdIn(s.arr, s.value);
          break;
        case "forOf":
          if (check === null)
            for (const from of this.slotsOf(fn, s.iterable))
              for (const slot of [from, `c:${from}`])
                this.edge(slot, this.localSlot(fn, s.localId));
          break;
        case "throw":
          hold("e:", s.value);
          break;
        case "tryCatch":
          if (check === null && s.catchLocalId !== null)
            this.edge("e:", this.localSlot(fn, s.catchLocalId));
          break;
        case "recordKeySet":
          report(s.value, s.loc, "a dynamically keyed property");
          break;
      }
      return everyStmtChild(s, expr, stmt);
    };
    for (const s of fn.body) stmt(s);
  }
}

/** Expressions the walk follows or checks itself. */
const MODELLED: ReadonlySet<IrExpr["kind"]> = new Set<IrExpr["kind"]>([
  "varRef",
  "assignExpr",
  "call",
  "new",
  "virtualCall",
  "callValue",
  "closure",
  "recordLit",
  "arrayLit",
  "dynArrLit",
  "dynObjLit",
  "mapNew",
  "setNew",
  "arrIntrinsic",
  "mapIntrinsic",
  "setIntrinsic",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "fieldGet",
  "recordGet",
  "dynKeyGet",
  "dynIterN",
  "dynCheck",
  "dynCall",
  "dynInvoke",
  "dynFrom",
  "caughtToDyn",
  "libCall",
  "intrinsic",
]);
