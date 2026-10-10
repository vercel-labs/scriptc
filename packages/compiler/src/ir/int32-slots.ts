import type { IrClassDef, IrExpr, IrFunction, IrModule, IrStmt, IrType } from "./ir.js";
import {
  analyzeIntegerRanges,
  INT32_RANGE,
  withinInt32,
  type IntegerRange,
  type IntegerRanges,
  type IntegerSlotFacts,
} from "./integer-ranges.js";
import { findInitializerBindings, withInitializerBindings } from "./initializer-bindings.js";
import { everyExprChild, everyStmtChild, everyTypeChild } from "./traverse.js";

/** Whole-program int32 specialization of numeric storage.
 *
 * A class field typed `number` whose every write provably stores an int32
 * (never -0, never NaN, never a fraction or an out-of-range integer) can be
 * stored as an i32: reading it back as a double is exact, so every program
 * observation is unchanged. The same proof seeds parameters of functions
 * that are only ever called directly (every call site passes an int32) and
 * results of functions whose every return is an int32. Parameter and result
 * ABIs stay double; only the facts reach the callee and the call sites.
 *
 * The analysis is optimistic: every candidate slot starts as int32, each
 * function is analyzed by analyzeIntegerRanges under the current facts, and
 * any write the analysis cannot prove disqualifies its slot. Functions that
 * read a disqualified slot are analyzed again, until no write fails. At the
 * fixpoint every assumption was proven against every write.
 *
 * Writes the IR does not show disqualify a slot up front. Instances that
 * reach checked-dynamic code get live views whose runtime stores commit
 * back into the fields; a field of such a class stays a double when any
 * dynamic store in the program can name it (literal-keyed stores name one
 * property, every other store any property, islands everything). Classes
 * with runtime-provided ancestors, generic families, fields under
 * `++`/`--`, and parameters of functions that escape as values, are
 * constructed through class values, or are virtual-dispatch targets are
 * excluded as well. Library builds keep ordinary storage: their instances
 * cross a native boundary. Worker builds do not: instances reach another
 * thread only through postMessage/workerData, whose dyn views read (and
 * commit) fields like every other dynamic reader. Reads are never
 * restricted: every reader (static code, dyn views, JSON, inspect) widens
 * the i32 exactly. */
export class Int32Slots {
  /** Field families (topmost declaring class and field) stored as i32. */
  private readonly fields = new Set<string>();
  private readonly familyOf = new Map<string, string | null>();
  private readonly paramFacts = new Map<string, Map<string, IntegerRange>>();
  private readonly returns = new Set<string>();
  /** Captured-binding groups (one shared box) that hold an int32, and the
   * group of each `function\0local` member. */
  private readonly boxes = new Set<string>();
  private readonly boxGroupOf = new Map<string, string>();
  /** Field write values proven int32 by the final analysis. */
  readonly provenWrites = new Set<IrExpr>();
  /** Disqualified candidates and the first reason, for tests. */
  readonly reasons = new Map<string, string>();

  constructor(private readonly classes: ReadonlyMap<string, IrClassDef> = new Map()) {}

  /** The family key of a class field: the topmost class in the base chain
   * that declares a field of that name (all subclasses share its slot). */
  family(className: string, field: string): string | null {
    const key = `${className}\0${field}`;
    const cached = this.familyOf.get(key);
    if (cached !== undefined) return cached;
    let owner: IrClassDef | undefined = this.classes.get(className);
    let result: string | null = null;
    if (owner?.fields.some((f) => f.name === field)) {
      for (;;) {
        const base: IrClassDef | undefined = owner.base ? this.classes.get(owner.base) : undefined;
        if (!base?.fields.some((f) => f.name === field)) break;
        owner = base;
      }
      result = `${owner.name}\0${field}`;
    }
    this.familyOf.set(key, result);
    return result;
  }

  isField(className: string, field: string): boolean {
    if (this.fields.size === 0) return false;
    const family = this.family(className, field);
    return family !== null && this.fields.has(family);
  }

  /** The facts analyzeIntegerRanges may assume inside one function. */
  facts(fnName: string): IntegerSlotFacts {
    if (
      this.fields.size === 0 &&
      this.returns.size === 0 &&
      this.paramFacts.size === 0 &&
      this.boxes.size === 0
    )
      return {};
    const result: IntegerSlotFacts = {
      field: (className, field) => (this.isField(className, field) ? INT32_RANGE : null),
      call: (callee) => (this.returns.has(callee) ? INT32_RANGE : null),
      boxed: (localId) => (this.hasBox(this.boxGroup(fnName, localId)) ? INT32_RANGE : null),
    };
    const params = this.paramFacts.get(fnName);
    if (params) result.params = params;
    return result;
  }

  boxGroup(fnName: string, localId: string): string | null {
    return this.boxGroupOf.get(`${fnName}\0${localId}`) ?? null;
  }

  /* ── construction (analyzeInt32Slots only) ── */

  addBox(group: string, members: readonly string[]): void {
    this.boxes.add(group);
    for (const member of members) this.boxGroupOf.set(member, group);
  }
  dropBox(group: string): boolean {
    return this.boxes.delete(group);
  }
  hasBox(group: string | null): boolean {
    return group !== null && this.boxes.has(group);
  }

  addField(family: string): void {
    this.fields.add(family);
  }
  dropField(family: string): boolean {
    return this.fields.delete(family);
  }
  hasFamily(family: string): boolean {
    return this.fields.has(family);
  }
  addParam(fnName: string, localId: string): void {
    let params = this.paramFacts.get(fnName);
    if (!params) this.paramFacts.set(fnName, (params = new Map()));
    params.set(localId, INT32_RANGE);
  }
  dropParam(fnName: string, localId: string): boolean {
    const params = this.paramFacts.get(fnName);
    if (!params?.delete(localId)) return false;
    if (params.size === 0) this.paramFacts.delete(fnName);
    return true;
  }
  hasParam(fnName: string, localId: string): boolean {
    return this.paramFacts.get(fnName)?.has(localId) ?? false;
  }
  addReturn(fnName: string): void {
    this.returns.add(fnName);
  }
  dropReturn(fnName: string): boolean {
    return this.returns.delete(fnName);
  }
  hasReturn(fnName: string): boolean {
    return this.returns.has(fnName);
  }
  get fieldCount(): number {
    return this.fields.size;
  }
  get returnCount(): number {
    return this.returns.size;
  }
  get paramCount(): number {
    let count = 0;
    for (const params of this.paramFacts.values()) count += params.size;
    return count;
  }
}

const DYN_KINDS = new Set<IrType["kind"]>(["dyn", "jsval", "caught"]);
/** Expressions that hand their operands (or produce results) to runtime
 * helpers, reflection, promises or other code the IR does not show. */
const BOUNDARY_KINDS = new Set<IrExpr["kind"]>([
  "libCall",
  "intrinsic",
  "jsonStringify",
  "ffiCall",
  "jsOp",
  "jsExit",
  "jsBridgePromise",
  "jsMarshal",
  "dynCall",
  "dynInvoke",
  "dynFrom",
  "dynFromJsval",
  "dynCheck",
  "dynObjLit",
  "dynArrLit",
  "caughtToDyn",
  "caughtNarrow",
  "caughtCheck",
]);
/** Runtime helpers that receive dynamic values but never store a property
 * into a live class capsule (verified against the runtime's call graph:
 * none of them reaches scr_dyn_typed_ref_commit with a caller-supplied
 * target). Any other helper that receives a dynamic value may store any
 * property, except literal-keyed `dyn.keySet`/`dyn.keyDelete`. */
const DYN_READ_ONLY = new Set<string>([
  "arrayBuffer.new",
  "arrayBuffer.viewF32",
  "arrayBuffer.viewF64",
  "arrayBuffer.viewI16",
  "arrayBuffer.viewI32",
  "arrayBuffer.viewI8",
  "arrayBuffer.viewU16",
  "arrayBuffer.viewU32",
  "arrayBuffer.viewU8",
  "arrayBuffer.viewU8C",
  "date.nativeNew",
  "dyn.arrAt",
  "dyn.arrLen",
  "dyn.bagGet",
  "dyn.compare",
  "dyn.hasKey",
  "dyn.iterator",
  "dyn.iteratorCanStep",
  "dyn.iteratorResult",
  "dyn.iteratorStep",
  "dyn.iteratorStepDone",
  "dyn.mapSeedEntries",
  "dyn.mapSeedEntry",
  "dyn.numberConstructor",
  "dyn.packPush",
  "dyn.packPushSpread",
  "dyn.stringConstructor",
  "dyn.this",
  "dyn.toStringCoerce",
  "dyn.typedRefIs",
  // error.ctorOptions runs scr_error_init_options, the initializer
  // error.newOptions also runs: it stamps the receiver's runtime-owned
  // error prefix and reads `options.cause`.
  "error.ctorOptions",
  "error.new",
  "error.newOptions",
  "fs.utimesSync",
  "json.stringifyReplacer",
  "json.stringifyValue",
  "num.toStringRadix",
  "sharedArrayBuffer.new",
  "text.decodeStream",
  "worker.new",
]);
const ISLAND_KINDS = new Set<IrExpr["kind"]>([
  "jsOp",
  "jsMarshal",
  "jsExit",
  "jsBridgePromise",
  "dynFromJsval",
]);
/** IR metadata keys whose strings never name a function. */
const NON_REFERENCE_KEYS = new Set([
  "loc",
  "source",
  "name",
  "sourceName",
  "jsName",
  "localId",
  "type",
  "returnType",
]);

function walkFunction(
  fn: IrFunction,
  visit: { expr?: (e: IrExpr) => void; stmt?: (s: IrStmt) => void },
): void {
  const expr = (e: IrExpr): boolean => {
    visit.expr?.(e);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    visit.stmt?.(s);
    return everyStmtChild(s, expr, stmt);
  };
  for (const s of fn.body) stmt(s);
}

export function analyzeInt32Slots(mod: IrModule): Int32Slots {
  const classes = new Map((mod.classes ?? []).map((c) => [c.name, c]));
  const slots = new Int32Slots(classes);
  if (mod.lib) return slots;
  const reason = (key: string, why: string): void => {
    if (!slots.reasons.has(key)) slots.reasons.set(key, why);
  };

  /* ── candidate fields ── */
  const children = new Map<string, string[]>();
  for (const cls of classes.values())
    if (cls.base) {
      const list = children.get(cls.base);
      if (list) list.push(cls.name);
      else children.set(cls.base, [cls.name]);
    }
  const subtree = (name: string): string[] => {
    const out: string[] = [];
    const stack = [name];
    while (stack.length) {
      const next = stack.pop()!;
      out.push(next);
      for (const child of children.get(next) ?? []) stack.push(child);
    }
    return out;
  };
  const genericFamilies = new Set<string>();
  for (const cls of classes.values())
    if (cls.genericOf !== undefined) {
      genericFamilies.add(cls.name);
      genericFamilies.add(cls.genericOf);
    }
  const plainClass = (cls: IrClassDef): boolean => {
    for (let c: IrClassDef | undefined = cls; c; c = c.base ? classes.get(c.base) : undefined) {
      if (c.runtime || genericFamilies.has(c.name)) return false;
      if (c.base && !classes.has(c.base)) return false;
    }
    return true;
  };
  const dropFamily = (family: string, why: string): void => {
    reason(`field:${family}`, why);
    slots.dropField(family);
  };
  for (const cls of classes.values())
    for (const field of cls.fields) {
      if (field.type.kind !== "f64" || field.name.startsWith("%")) continue;
      const family = slots.family(cls.name, field.name)!;
      if (plainClass(cls)) {
        if (!slots.reasons.has(`field:${family}`)) slots.addField(family);
      } else dropFamily(family, "runtime-provided or generic class");
    }

  /* ── dynamic, reflective and runtime exposure ── */
  const records = new Map((mod.records ?? []).map((r) => [r.id, r]));
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, u]));
  const exposedClasses = new Set<string>();
  const seenNamed = new Set<string>();
  let exposeAll = false;
  const expose = (type: IrType): void => {
    if (exposeAll) return;
    switch (type.kind) {
      case "object":
      case "classval":
        // A live dyn view of an instance materializes its fields as live
        // views in turn: everything reachable from an exposed class is exposed.
        for (const name of subtree(type.className)) {
          if (exposedClasses.has(name)) continue;
          exposedClasses.add(name);
          for (const field of classes.get(name)?.fields ?? []) expose(field.type);
        }
        return;
      case "moduleNs":
        exposeAll = true;
        return;
      case "record": {
        if (seenNamed.has(`r:${type.shapeId}`)) return;
        seenNamed.add(`r:${type.shapeId}`);
        const shape = records.get(type.shapeId);
        for (const field of shape?.fields ?? []) expose(field.type);
        if (shape?.indexValue) expose(shape.indexValue);
        return;
      }
      case "union": {
        if (seenNamed.has(`u:${type.unionId}`)) return;
        seenNamed.add(`u:${type.unionId}`);
        for (const arm of unions.get(type.unionId)?.arms ?? []) expose(arm);
        return;
      }
      default:
        everyTypeChild(type, (child) => {
          expose(child);
          return true;
        });
    }
  };
  // A live dyn view (typed-ref capsule) of an instance writes back into
  // its fields only after a runtime store into the capsule; the commit then
  // writes every field from the view, which holds the exact snapshot value
  // of any property no store named. So reaching dynamic code disqualifies
  // exactly the field names some dynamic store in the program can name.
  const dynTypes = new Map<IrType, boolean>();
  const dynNamed = new Map<string, boolean>();
  const dynish = (type: IrType): boolean => {
    if (DYN_KINDS.has(type.kind)) return true;
    const cached = dynTypes.get(type);
    if (cached !== undefined) return cached;
    let result = false;
    const named =
      type.kind === "record"
        ? `r:${type.shapeId}`
        : type.kind === "union"
          ? `u:${type.unionId}`
          : null;
    if (named) {
      const known = dynNamed.get(named);
      if (known !== undefined) return known;
      dynNamed.set(named, false);
      const members =
        type.kind === "record"
          ? [
              ...(records.get(type.shapeId)?.fields.map((f) => f.type) ?? []),
              ...(records.get(type.shapeId)?.indexValue
                ? [records.get(type.shapeId)!.indexValue!]
                : []),
            ]
          : type.kind === "union"
            ? (unions.get(type.unionId)?.arms ?? [])
            : [];
      result = members.some(dynish);
      dynNamed.set(named, result);
    } else everyTypeChild(type, (child) => !(result = dynish(child)));
    dynTypes.set(type, result);
    return result;
  };
  const dynWritten = new Set<string>();
  let dynWritesAll = false;
  for (const fn of mod.functions)
    walkFunction(fn, {
      expr: (e) => {
        if (dynWritesAll) return;
        if (ISLAND_KINDS.has(e.kind) || e.type.kind === "jsval") dynWritesAll = true;
        else if (
          e.kind === "libCall" &&
          !DYN_READ_ONLY.has(e.fn) &&
          e.args.some((a) => dynish(a.type))
        ) {
          const key = e.args[1];
          if ((e.fn === "dyn.keySet" || e.fn === "dyn.keyDelete") && key?.kind === "strLit")
            dynWritten.add(key.value);
          else dynWritesAll = true;
        }
      },
    });
  for (const fn of mod.functions)
    walkFunction(fn, {
      expr: (e) => {
        const dynResult = DYN_KINDS.has(e.type.kind);
        const boundary = BOUNDARY_KINDS.has(e.kind);
        let dynChild = false;
        everyExprChild(
          e,
          (child) => {
            const dyn = DYN_KINDS.has(child.type.kind);
            dynChild ||= dyn;
            if (boundary || (dynResult && !dyn)) expose(child.type);
            return true;
          },
          () => true,
        );
        // Error helpers construct runtime errors or always throw: their
        // class-typed result is an Error instance or an unreachable dummy.
        const errorHelper = e.kind === "libCall" && e.fn.startsWith("error.");
        if ((boundary && !errorHelper) || (dynChild && !dynResult)) expose(e.type);
      },
      stmt: (s) => {
        if (s.kind === "throw") expose(s.value.type);
      },
    });
  for (const cls of classes.values()) {
    if (!exposeAll && !exposedClasses.has(cls.name)) continue;
    for (const field of cls.fields)
      if (
        field.type.kind === "f64" &&
        !field.name.startsWith("%") &&
        (dynWritesAll || dynWritten.has(field.name))
      )
        dropFamily(slots.family(cls.name, field.name)!, "dynamic stores can name the field");
  }

  /* ── functions: escapes, parameter and return candidates ── */
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const escaped = new Set<string>();
  const seenObjects = new Set<object>();
  const scan = (
    value: unknown,
    key: string | null,
    parent: Record<string, unknown> | null,
  ): void => {
    if (typeof value === "string") {
      if (functions.has(value)) {
        const direct =
          key === "callee" && parent?.kind === "call"
            ? true
            : key === "value" && parent?.kind === "strLit";
        if (!direct) escaped.add(value);
      }
      return;
    }
    if (value === null || typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) scan(item, null, null);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) if (!NON_REFERENCE_KEYS.has(k)) scan(v, k, record);
  };
  scan(mod, null, null);
  if (typeof mod.entry === "string") escaped.add(mod.entry);
  // Virtual dispatch: a `virtualCall` can reach the method's implementation
  // in any class of the receiver's subtree or the one it inherits. Classes
  // under a runtime-provided root keep every method escaped: the runtime
  // calls their vtable entries directly.
  const runtimeRooted = (name: string): boolean => {
    for (let c = classes.get(name); c; c = c.base ? classes.get(c.base) : undefined)
      if (c.runtime || (c.base && !classes.has(c.base))) return true;
    return false;
  };
  const runtimePrefixes: string[] = [];
  for (const cls of classes.values())
    if (runtimeRooted(cls.name)) runtimePrefixes.push(`%${cls.name}.`);
  for (const fn of mod.functions)
    walkFunction(fn, {
      expr: (e) => {
        if (e.kind !== "virtualCall") return;
        for (const name of subtree(e.className)) escaped.add(`%${name}.${e.method}`);
        for (let c = classes.get(e.className); c; c = c.base ? classes.get(c.base) : undefined)
          escaped.add(`%${c.name}.${e.method}`);
      },
    });
  // A class value can reach `new` through its construct thunk; one that
  // only feeds an instanceof interval check cannot.
  const testedOnly = new Set<IrExpr>();
  for (const fn of mod.functions) {
    // Direct operands, and unboxed locals bound once to a class reference
    // and read only as instanceof operands (the lowering's temporary).
    const bound = new Map<string, IrExpr>();
    const reads = new Map<string, number>();
    const tests = new Map<string, number>();
    const writes = new Map<string, number>();
    const count = (map: Map<string, number>, id: string): void => {
      map.set(id, (map.get(id) ?? 0) + 1);
    };
    walkFunction(fn, {
      expr: (e) => {
        if (e.kind === "instanceOfValue") {
          if (e.classValue.kind === "classRef") testedOnly.add(e.classValue);
          else if (e.classValue.kind === "varRef") count(tests, e.classValue.localId);
        } else if (e.kind === "varRef") count(reads, e.localId);
        else if (e.kind === "assignExpr" || e.kind === "incDec") count(writes, e.localId);
      },
      stmt: (s) => {
        if (s.kind === "varDecl" && s.init?.kind === "classRef") bound.set(s.localId, s.init);
        if (s.kind === "assign" || s.kind === "forOf" || s.kind === "varDecl")
          count(writes, s.localId);
      },
    });
    const boxed = new Set(fn.locals.filter((l) => l.boxed).map((l) => l.id));
    for (const [id, ref] of bound)
      if (!boxed.has(id) && writes.get(id) === 1 && reads.get(id) === tests.get(id))
        testedOnly.add(ref);
  }
  for (const fn of mod.functions)
    walkFunction(fn, {
      expr: (e) => {
        if (e.kind === "classRef" && !testedOnly.has(e)) escaped.add(`%${e.className}.constructor`);
      },
    });
  const virtual = (name: string): boolean =>
    runtimePrefixes.some((prefix) => name.startsWith(prefix));

  const paramKey = (fnName: string, localId: string): string => `param:${fnName}\0${localId}`;
  const dropParam = (fnName: string, localId: string, why: string): boolean => {
    reason(paramKey(fnName, localId), why);
    return slots.dropParam(fnName, localId);
  };
  const dropAllParams = (fn: IrFunction, why: string): void => {
    for (const param of fn.params) dropParam(fn.name, param.localId, why);
  };
  // Only functions some IR call reaches directly get parameter facts: one
  // the backend invokes by convention has no call site to prove against.
  const called = new Set<string>();
  for (const fn of mod.functions)
    walkFunction(fn, {
      expr: (e) => {
        if (e.kind === "call") called.add(e.callee);
        else if (e.kind === "new") called.add(`%${e.className}.constructor`);
      },
    });
  for (const fn of mod.functions) {
    if (fn.returnType.kind === "f64" && !fn.async && !fn.generator) slots.addReturn(fn.name);
    if (
      fn.async ||
      fn.generator ||
      !called.has(fn.name) ||
      escaped.has(fn.name) ||
      virtual(fn.name)
    )
      continue;
    for (const param of fn.params)
      if (param.type.kind === "f64") slots.addParam(fn.name, param.localId);
  }
  const arityChecked = (fn: IrFunction | undefined, args: number, offset: number): void => {
    if (fn && fn.params.length !== args + offset) dropAllParams(fn, "call arity differs");
  };
  for (const fn of mod.functions)
    walkFunction(fn, {
      expr: (e) => {
        if (e.kind === "call") arityChecked(functions.get(e.callee), e.args.length, 0);
        else if (e.kind === "new")
          arityChecked(functions.get(`%${e.className}.constructor`), e.args.length, 1);
      },
    });

  /* ── captured bindings ── */
  // A captured local lives in one box shared by its declaring function and
  // every closure that captures it (closure.captures[i] is the lifted
  // function's captures[i]). The box holds an int32 when every write to it
  // anywhere is proven and it starts from a proven parameter or an
  // initialized declaration. Class-captured bindings stay unknown.
  const boxParent = new Map<string, string>();
  const boxRoot = (key: string): string => {
    let root = key;
    while (boxParent.has(root)) root = boxParent.get(root)!;
    if (root !== key) boxParent.set(key, root);
    return root;
  };
  const boxKey = (fnName: string, localId: string): string => `${fnName}\0${localId}`;
  const boxMembers = new Set<string>();
  const unstableBoxes = new Set<string>();
  for (const fn of mod.functions) {
    for (const local of fn.locals)
      if (local.boxed) {
        const key = boxKey(fn.name, local.id);
        boxMembers.add(key);
        if (local.type.kind !== "f64" || local.tdz) unstableBoxes.add(key);
      }
    for (const capture of fn.classCaptures ?? [])
      unstableBoxes.add(boxKey(fn.name, capture.localId));
    walkFunction(fn, {
      expr: (e) => {
        if (e.kind === "closure") {
          const lifted = functions.get(e.fnName);
          e.captures.forEach((id, i) => {
            const inner = lifted?.captures?.[i];
            const outer = boxKey(fn.name, id);
            if (!inner) unstableBoxes.add(outer);
            else {
              const a = boxRoot(outer),
                b = boxRoot(boxKey(lifted!.name, inner.localId));
              if (a !== b) boxParent.set(a, b);
            }
          });
        } else if (e.kind === "classRef")
          for (const id of e.captures ?? []) unstableBoxes.add(boxKey(fn.name, id));
        else if (e.kind === "incDec") unstableBoxes.add(boxKey(fn.name, e.localId));
      },
      stmt: (s) => {
        if (s.kind === "forOf") unstableBoxes.add(boxKey(fn.name, s.localId));
        if (s.kind === "tryCatch" && s.catchLocalId)
          unstableBoxes.add(boxKey(fn.name, s.catchLocalId));
      },
    });
  }
  const groups = new Map<string, string[]>();
  for (const key of boxMembers) {
    const root = boxRoot(key);
    const list = groups.get(root);
    if (list) list.push(key);
    else groups.set(root, [key]);
  }
  const boxOrigin = new Map<string, string>();
  for (const [group, members] of groups) {
    if (members.some((key) => unstableBoxes.has(key))) continue;
    // The origin is the one member that is not a capture of its function.
    const origins = members.filter((key) => {
      const [fnName, localId] = key.split("\0") as [string, string];
      return !functions.get(fnName)?.captures?.some((c) => c.localId === localId);
    });
    if (origins.length !== 1) continue;
    const [fnName, localId] = origins[0]!.split("\0") as [string, string];
    const origin = functions.get(fnName)!;
    if (origin.params.some((p) => p.localId === localId)) {
      if (!slots.hasParam(fnName, localId)) continue;
    } else {
      let initialized = false;
      walkFunction(origin, {
        stmt: (s) => {
          if (s.kind === "varDecl" && s.localId === localId && s.init) initialized = true;
        },
      });
      if (!initialized) continue;
    }
    boxOrigin.set(`param:${fnName}\0${localId}`, group);
    slots.addBox(group, members);
  }
  const dropBox = (group: string | null, why: string): boolean => {
    if (group === null) return false;
    reason(`box:${group}`, why);
    return slots.dropBox(group);
  };

  /* ── readers: which functions depend on which slot facts ── */
  const readers = new Map<string, Set<string>>();
  const reads = (slot: string, fnName: string): void => {
    const set = readers.get(slot);
    if (set) set.add(fnName);
    else readers.set(slot, new Set([fnName]));
  };
  for (const fn of mod.functions)
    walkFunction(fn, {
      expr: (e) => {
        if (e.kind === "fieldGet") {
          const family = slots.family(e.className, e.field);
          if (family) reads(`field:${family}`, fn.name);
        } else if (e.kind === "call") reads(`ret:${e.callee}`, fn.name);
        else if (e.kind === "varRef") {
          const group = slots.boxGroup(fn.name, e.localId);
          if (group !== null) reads(`box:${group}`, fn.name);
        } else if (e.kind === "fieldIncDec") {
          const family = slots.family(e.className, e.field);
          if (family) dropFamily(family, "++/-- on the field");
        }
      },
    });

  /* ── the optimistic fixpoint ── */
  const bindings = findInitializerBindings(mod);
  const numeric = (fn: IrFunction): IrFunction =>
    withInitializerBindings(fn, bindings.get(fn.name) ?? []);
  const queue: string[] = mod.functions.map((fn) => fn.name);
  const queued = new Set(queue);
  const invalidate = (slot: string): void => {
    const dependents = readers.get(slot);
    if (dependents)
      for (const fnName of dependents)
        if (!queued.has(fnName)) {
          queued.add(fnName);
          queue.push(fnName);
        }
  };
  const provenByFunction = new Map<string, IrExpr[]>();
  while (queue.length) {
    const fn = functions.get(queue.pop()!)!;
    queued.delete(fn.name);
    const params = slots.facts(fn.name).params;
    if (params) for (const id of params.keys()) reads(`param:${fn.name}\0${id}`, fn.name);
    const ranges: IntegerRanges = analyzeIntegerRanges(numeric(fn), slots.facts(fn.name));
    const proven: IrExpr[] = [];
    const int32 = (e: IrExpr): boolean => withinInt32(ranges.get(e));
    const args = (callee: IrFunction | undefined, list: IrExpr[], offset: number): void => {
      if (!callee) return;
      list.forEach((arg, i) => {
        const param = callee.params[i + offset];
        if (!param || !slots.hasParam(callee.name, param.localId) || int32(arg)) return;
        const slot = `param:${callee.name}\0${param.localId}`;
        if (dropParam(callee.name, param.localId, `argument in ${fn.name} is not int32`))
          invalidate(slot);
        const group = boxOrigin.get(slot) ?? null;
        if (dropBox(group, `parameter ${param.localId} is not int32`)) invalidate(`box:${group}`);
      });
    };
    const boxWrite = (localId: string, value: IrExpr): void => {
      const group = slots.boxGroup(fn.name, localId);
      if (!slots.hasBox(group) || int32(value)) return;
      if (dropBox(group, `write in ${fn.name} is not int32`)) invalidate(`box:${group}`);
    };
    walkFunction(fn, {
      stmt: (s) => {
        if (s.kind === "assign") boxWrite(s.localId, s.value);
        else if (s.kind === "varDecl" && s.init) boxWrite(s.localId, s.init);
        if (s.kind === "fieldSet") {
          const family = slots.family(s.className, s.field);
          if (!family || !slots.hasFamily(family)) return;
          if (int32(s.value)) proven.push(s.value);
          else {
            dropFamily(family, `write in ${fn.name} is not int32`);
            invalidate(`field:${family}`);
          }
        } else if (s.kind === "return" && slots.hasReturn(fn.name)) {
          if (s.value && int32(s.value)) return;
          reason(`ret:${fn.name}`, "return is not int32");
          slots.dropReturn(fn.name);
          invalidate(`ret:${fn.name}`);
        }
      },
      expr: (e) => {
        if (e.kind === "call") args(functions.get(e.callee), e.args, 0);
        else if (e.kind === "new") args(functions.get(`%${e.className}.constructor`), e.args, 1);
        else if (e.kind === "assignExpr") boxWrite(e.localId, e.value);
      },
    });
    provenByFunction.set(fn.name, proven);
  }
  for (const proven of provenByFunction.values())
    for (const value of proven) slots.provenWrites.add(value);
  return slots;
}
