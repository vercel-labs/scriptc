import type { IrClassDef, IrExpr, IrFunction, IrGlobal, IrModule, IrStmt, IrType } from "./ir.js";
import {
  analyzeIntegerRanges,
  INT32_RANGE,
  NON_NEGATIVE_INT32_RANGE,
  withinInt32,
  type IntegerRange,
  type IntegerRanges,
  type IntegerSlotFacts,
} from "./integer-ranges.js";
import {
  exprFunctionReference,
  FUNCTION_REFERENCE_KINDS,
  moduleFunctionReferences,
} from "./function-references.js";
import {
  eachNodeOfKinds,
  type IrKindScan,
  type IrNodeIndex,
  type IrNodeKind,
} from "./node-index.js";
import { findInitializerBindings, withInitializerBindings } from "./initializer-bindings.js";
import {
  checkableInt32Allocations,
  int32ArrayGroups,
  int32ArrayKey,
  int32ArraySlot,
  int32ArrayStores,
} from "./int32-arrays.js";
import { everyExprChild, everyStmtChild, everyStmtList, everyTypeChild } from "./traverse.js";

/** The storage slot an array-valued expression reads, as an
 * IrContracts.int32Elements key: a local or parameter
 * (`l:${function}\0${localId}`), a module global (`g:${globalId}`), a class
 * field family (`f:${family}`), a record field of every record of its shape
 * (`s:${shapeId}\0${field}`) or a direct call's result (`r:${callee}`),
 * looking through retypings of the same value. Null for anything else. */
export function int32ElementSlot(
  fnName: string,
  e: IrExpr,
  family: (className: string, field: string) => string | null,
): string | null {
  for (;;) {
    switch (e.kind) {
      case "upcast":
      case "downcast":
      case "unionNarrow":
      case "unionRetype":
        e = e.value;
        continue;
      case "varRef":
        return e.localId.startsWith("%g.") ? `g:${e.localId}` : `l:${fnName}\0${e.localId}`;
      case "fieldGet": {
        const key = family(e.className, e.field);
        return key === null ? null : `f:${key}`;
      }
      case "recordGet":
        return `s:${e.shapeId}\0${e.field}`;
      case "call":
        return `r:${e.callee}`;
      default:
        return null;
    }
  }
}

/** Whole-program int32 specialization of numeric storage.
 *
 * A class field typed `number` whose every write provably stores an int32
 * (never -0, never NaN, never a fraction or an out-of-range integer) can be
 * stored as an i32: reading it back as a double is exact, so every program
 * observation is unchanged. The same proof seeds parameters of functions
 * that are only ever called directly (every call site passes an int32) and
 * results of functions whose every return is an int32. The LLVM backend
 * passes those parameters and results as i32 on direct calls
 * (backend/llvm/int32-abi.ts); every other entry keeps the double ABI.
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
 * property, every other store any property). Classes
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
  /** Results narrowed below their level (narrowSlotRanges). */
  private readonly returnRanges = new Map<string, IntegerRange>();
  /** Captured-binding groups (one shared box) that hold an int32, and the
   * group of each `function\0local` member. */
  private readonly boxes = new Set<string>();
  private readonly boxGroupOf = new Map<string, string>();
  /** Field write values proven int32 by the final analysis. */
  readonly provenWrites = new Set<IrExpr>();
  /** Functions some IR `call` or `new` reaches directly. */
  readonly called = new Set<string>();
  /** Disqualified candidates and the first reason, for tests. */
  readonly reasons = new Map<string, string>();
  /** Slots an Int32 contract pins (`field:`, `param:`, `ret:`, `box:` keys):
   * the contract check proved every write, so they are never dropped. */
  private readonly pinned = new Set<string>();
  /** Int32 contract locals (`function\0localId`) and globals (`\0id`). */
  private readonly int32Locals = new Set<string>();
  /** Module globals of type number whose every write the fixpoint proved
   * an int32 (`global:` keys). */
  private readonly globals = new Set<string>();
  /** Number-array slots whose arrays hold only int32 elements (Int32[]
   * contracts, IrContracts.int32Elements keys). */
  private readonly int32Elements = new Set<string>();
  /** Drops the analysis attempted on pinned slots. The contract check and
   * this analysis use the same range proofs, so this stays empty. */
  readonly pinViolations: string[] = [];
  /** Parameter, return and box candidates (`param:`, `ret:`, `box:` keys)
   * still assumed to hold only non-negative int32s. The optimistic fixpoint
   * starts every unpinned candidate here and demotes it to int32 when a
   * write is an int32 that may be negative: `(x * 31 + n) % m` only proves
   * a result when x and n are known not to be negative. */
  private readonly nonNegative = new Set<string>();

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
      this.boxes.size === 0 &&
      this.int32Locals.size === 0 &&
      this.globals.size === 0 &&
      this.int32Elements.size === 0
    )
      return {};
    const level = (key: string): IntegerRange =>
      this.nonNegative.has(key) ? NON_NEGATIVE_INT32_RANGE : INT32_RANGE;
    const result: IntegerSlotFacts = {
      field: (className, field) => (this.isField(className, field) ? INT32_RANGE : null),
      call: (callee) =>
        this.returns.has(callee) ? (this.returnRanges.get(callee) ?? level(`ret:${callee}`)) : null,
      boxed: (localId) => {
        const group = this.boxGroup(fnName, localId);
        return group !== null && this.boxes.has(group) ? level(`box:${group}`) : null;
      },
    };
    if (this.int32Locals.size > 0 || this.globals.size > 0)
      result.locals = (localId) =>
        this.int32Locals.has(`${fnName}\0${localId}`) || this.int32Locals.has(`\0${localId}`)
          ? INT32_RANGE
          : this.globals.has(localId)
            ? level(`global:${localId}`)
            : null;
    if (this.int32Elements.size > 0) {
      result.elements = (arr) => this.hasInt32Elements(fnName, arr);
      if (this.narrowedReads) result.narrowedReads = true;
    }
    const params = this.paramFacts.get(fnName);
    if (params)
      result.params =
        this.nonNegative.size === 0
          ? params
          : new Map(
              [...params].map(([id, range]) => {
                const key = `param:${fnName}\0${id}`;
                return [id, this.nonNegative.has(key) ? NON_NEGATIVE_INT32_RANGE : range];
              }),
            );
    return result;
  }

  /** Assume an unpinned candidate holds only non-negative int32s. */
  assumeNonNegative(key: string): void {
    if (!this.pinned.has(key)) this.nonNegative.add(key);
  }
  isNonNegative(key: string): boolean {
    return this.nonNegative.has(key);
  }
  /** Widen a non-negative candidate to int32; whether it was one. */
  demote(key: string): boolean {
    return this.nonNegative.delete(key);
  }
  isPinned(key: string): boolean {
    return this.pinned.has(key);
  }
  /** The range a parameter fact currently asserts, if it has one. */
  paramRange(fnName: string, localId: string): IntegerRange | null {
    return this.facts(fnName).params?.get(localId) ?? null;
  }
  /** The range a result fact currently asserts, if it has one. */
  returnRange(fnName: string): IntegerRange | null {
    return this.facts(fnName).call?.(fnName) ?? null;
  }
  /** Replace a parameter fact with a narrower proven range. */
  narrowParam(fnName: string, localId: string, range: IntegerRange): void {
    this.nonNegative.delete(`param:${fnName}\0${localId}`);
    this.addParam(fnName, localId, range);
  }
  /** Replace a result fact with a narrower proven range. */
  narrowReturn(fnName: string, range: IntegerRange): void {
    this.returnRanges.set(fnName, range);
  }

  boxGroup(fnName: string, localId: string): string | null {
    return this.boxGroupOf.get(`${fnName}\0${localId}`) ?? null;
  }

  /* ── construction (analyzeInt32Slots only) ── */

  pin(key: string): void {
    this.pinned.add(key);
  }
  isPinnedField(family: string): boolean {
    return this.pinned.has(`field:${family}`);
  }
  addInt32Local(key: string): void {
    this.int32Locals.add(key);
  }
  addGlobal(id: string): void {
    this.globals.add(id);
  }
  hasGlobal(id: string): boolean {
    return this.globals.has(id);
  }
  dropGlobal(id: string): boolean {
    this.nonNegative.delete(`global:${id}`);
    return this.globals.delete(id);
  }
  addInt32Elements(key: string): void {
    this.int32Elements.add(key);
  }
  dropInt32Elements(key: string): boolean {
    return this.int32Elements.delete(key);
  }
  hasInt32ElementSlot(key: string): boolean {
    return this.int32Elements.has(key);
  }
  /** Whether the module has int32 array candidates (the narrowedReads
   * range fact). */
  narrowedReads = false;
  /** Number arrays stored as int32 slots (int32ArrayKey keys: locals and
   * parameters as `function\0local`, globals as `\0global`): the module's
   * int32 array candidates whose every stored element, through every
   * binding that can hold the same array, the fixpoint proved an int32. */
  readonly int32Arrays = new Set<string>();
  /** Local number arrays that may hold int32 slots with checked stores: the
   * candidates whose element stores the fixpoint proved exact integers but
   * not int32s, allocated only by fills that may be long. A fill of at least
   * CHECKED_INT32_MIN_LENGTH elements creates one with int32 slots and a
   * shorter one with doubles. Their elements give no int32 facts; compiled
   * accesses test the array's kind (once per innermost loop where they can,
   * backend/llvm/int32-kind-loops.ts), and a store that is not an int32
   * widens it first (scr_arr_widen_i32). */
  readonly checkedInt32Arrays = new Set<string>();
  /** Whether every present element of the number array `arr` evaluates to
   * (read inside `fnName`) is an int32. */
  hasInt32Elements(fnName: string, arr: IrExpr): boolean {
    if (this.int32Elements.size === 0) return false;
    const key = int32ElementSlot(fnName, arr, (cls, field) => this.family(cls, field));
    return key !== null && this.int32Elements.has(key);
  }
  private refusePinned(key: string): boolean {
    if (!this.pinned.has(key)) return false;
    this.pinViolations.push(key);
    return true;
  }

  addBox(group: string, members: readonly string[]): void {
    this.boxes.add(group);
    for (const member of members) this.boxGroupOf.set(member, group);
  }
  dropBox(group: string): boolean {
    if (this.refusePinned(`box:${group}`)) return false;
    this.nonNegative.delete(`box:${group}`);
    return this.boxes.delete(group);
  }
  hasBox(group: string | null): boolean {
    return group !== null && this.boxes.has(group);
  }

  addField(family: string): void {
    this.fields.add(family);
  }
  dropField(family: string): boolean {
    if (this.refusePinned(`field:${family}`)) return false;
    return this.fields.delete(family);
  }
  hasFamily(family: string): boolean {
    return this.fields.has(family);
  }
  addParam(fnName: string, localId: string, range: IntegerRange = INT32_RANGE): void {
    let params = this.paramFacts.get(fnName);
    if (!params) this.paramFacts.set(fnName, (params = new Map()));
    params.set(localId, range);
  }
  dropParam(fnName: string, localId: string): boolean {
    if (this.refusePinned(`param:${fnName}\0${localId}`)) return false;
    this.nonNegative.delete(`param:${fnName}\0${localId}`);
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
    if (this.refusePinned(`ret:${fnName}`)) return false;
    this.nonNegative.delete(`ret:${fnName}`);
    this.returnRanges.delete(fnName);
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

  /** The analysis as JSON, for a process that shares this module and its
   * node index (a forked one). Proven writes are numbered by their position
   * in `nodes`. Null when a proven write is not in the index. */
  encode(nodes: IrNodeIndex): string | null {
    const proven = nodes.expressionPositions(this.provenWrites);
    if (proven === null) return null;
    const data: Int32SlotsData = {
      fields: [...this.fields],
      familyOf: [...this.familyOf],
      paramFacts: [...this.paramFacts].map(([fn, params]) => [fn, [...params]]),
      returns: [...this.returns],
      returnRanges: [...this.returnRanges],
      boxes: [...this.boxes],
      boxGroupOf: [...this.boxGroupOf],
      provenWrites: proven,
      called: [...this.called],
      reasons: [...this.reasons],
      pinned: [...this.pinned],
      int32Locals: [...this.int32Locals],
      globals: [...this.globals],
      int32Elements: [...this.int32Elements],
      pinViolations: this.pinViolations,
      nonNegative: [...this.nonNegative],
      narrowedReads: this.narrowedReads,
      int32Arrays: [...this.int32Arrays],
      checkedInt32Arrays: [...this.checkedInt32Arrays],
    };
    return JSON.stringify(data);
  }

  /** The analysis `encode` wrote for `mod`, whose node index is `nodes`. */
  static decode(text: string, mod: IrModule, nodes: IrNodeIndex): Int32Slots {
    const data = JSON.parse(text) as Int32SlotsData;
    const slots = new Int32Slots(new Map((mod.classes ?? []).map((c) => [c.name, c])));
    for (const family of data.fields) slots.fields.add(family);
    for (const [key, family] of data.familyOf) slots.familyOf.set(key, family);
    for (const [fn, params] of data.paramFacts) slots.paramFacts.set(fn, new Map(params));
    for (const fn of data.returns) slots.returns.add(fn);
    for (const [fn, range] of data.returnRanges) slots.returnRanges.set(fn, range);
    for (const group of data.boxes) slots.boxes.add(group);
    for (const [member, group] of data.boxGroupOf) slots.boxGroupOf.set(member, group);
    for (const node of nodes.expressionsAt(data.provenWrites)) slots.provenWrites.add(node);
    for (const fn of data.called) slots.called.add(fn);
    for (const [key, why] of data.reasons) slots.reasons.set(key, why);
    for (const key of data.pinned) slots.pinned.add(key);
    for (const key of data.int32Locals) slots.int32Locals.add(key);
    for (const id of data.globals) slots.globals.add(id);
    for (const key of data.int32Elements) slots.int32Elements.add(key);
    slots.pinViolations.push(...data.pinViolations);
    for (const key of data.nonNegative) slots.nonNegative.add(key);
    slots.narrowedReads = data.narrowedReads;
    for (const key of data.int32Arrays) slots.int32Arrays.add(key);
    for (const key of data.checkedInt32Arrays) slots.checkedInt32Arrays.add(key);
    return slots;
  }

  /** Every fact, in a canonical order, with each proven write as its
   * position in `mod` (function index, then walk order): two analyses of
   * equal modules hold the same facts when their summaries are equal. */
  summary(mod: IrModule): string {
    const sorted = (values: Iterable<string>): string => [...values].sort().join(",");
    const lines = [
      `fields ${sorted(this.fields)}`,
      `params ${sorted([...this.paramFacts].flatMap(([fn, params]) => [...params].map(([id, r]) => `${fn}\0${id}=${r.min}:${r.max}`)))}`,
      `returns ${sorted(this.returns)}`,
      `returnRanges ${sorted([...this.returnRanges].map(([fn, r]) => `${fn}=${r.min}:${r.max}`))}`,
      `boxes ${sorted(this.boxes)}`,
      `boxGroups ${sorted([...this.boxGroupOf].map(([member, group]) => `${member}=${group}`))}`,
      `called ${sorted(this.called)}`,
      `pinned ${sorted(this.pinned)}`,
      `int32Locals ${sorted(this.int32Locals)}`,
      `globals ${sorted(this.globals)}`,
      `int32Elements ${sorted(this.int32Elements)}`,
      `nonNegative ${sorted(this.nonNegative)}`,
      `pinViolations ${sorted(this.pinViolations)}`,
      `narrowedReads ${this.narrowedReads}`,
      `int32Arrays ${sorted(this.int32Arrays)}`,
      `checkedInt32Arrays ${sorted(this.checkedInt32Arrays)}`,
    ];
    const positions: string[] = [];
    mod.functions.forEach((fn, f) => {
      let at = 0;
      everyStmtList(fn.body, {
        expr: (e) => {
          if (this.provenWrites.has(e)) positions.push(`${f}:${at}`);
          at++;
          return true;
        },
        stmt: () => {
          at++;
          return true;
        },
      });
    });
    lines.push(`provenWrites ${this.provenWrites.size} ${positions.join(",")}`);
    return lines.join("\n");
  }
}

/** Int32Slots as plain data (Int32Slots.encode). */
interface Int32SlotsData {
  fields: string[];
  familyOf: [string, string | null][];
  paramFacts: [string, [string, IntegerRange][]][];
  returns: string[];
  returnRanges: [string, IntegerRange][];
  boxes: string[];
  boxGroupOf: [string, string][];
  provenWrites: number[];
  called: string[];
  reasons: [string, string][];
  pinned: string[];
  int32Locals: string[];
  globals: string[];
  int32Elements: string[];
  pinViolations: string[];
  nonNegative: string[];
  narrowedReads: boolean;
  int32Arrays: string[];
  checkedInt32Arrays: string[];
}

const DYN_KINDS = new Set<IrType["kind"]>(["dyn", "jsval", "caught"]);
/** Expressions that hand their operands (or produce results) to runtime
 * helpers, reflection, promises or other code the IR does not show. */
const BOUNDARY_KINDS = new Set<IrExpr["kind"]>([
  "libCall",
  "intrinsic",
  "jsonStringify",
  "ffiCall",
  "dynCall",
  "dynInvoke",
  "dynFrom",
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
  "arrayBuffer.viewF16",
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
  "date.nativeNewFields",
  "date.nativeNewValue",
  "date.argumentsTime",
  // The dynamic operators run the ToPrimitive and coercion helpers of
  // dyn.compare, dyn.numberConstructor and dyn.toStringCoerce, then build a
  // fresh number, string or bigint. dyn.increment steps dyn.toNumeric's result.
  "dyn.add",
  "dyn.arithmetic",
  "dyn.arrAt",
  "dyn.arrLen",
  "dyn.bagGet",
  "dyn.bitwise",
  "dyn.compare",
  // Adoption reads the native value it was built into and turns shared
  // source nodes into capsules of it; it stores no property into a capsule.
  "dyn.declAdopt",
  "dyn.adoptShared",
  "dyn.forInKeyStrings",
  "dyn.forInKeys",
  "dyn.forInStable",
  "dyn.getOwnPropertyNames",
  "dyn.getPrototype",
  "dyn.getPrototypeForIdentity",
  "dyn.hasKey",
  "dyn.hasOwn",
  "dyn.in",
  "dyn.increment",
  "dyn.iterator",
  "dyn.iteratorCanStep",
  "dyn.iteratorResult",
  "dyn.iteratorStep",
  "dyn.iteratorStepDone",
  "dyn.collectionIteratorIndex",
  "dyn.mapSeedEntries",
  "dyn.mapSeedEntry",
  "dyn.nameClassPrototype",
  "dyn.numberConstructor",
  "dyn.objCreate",
  "dyn.objEntries",
  "dyn.objEntryPairs",
  "dyn.objKeyStrings",
  "dyn.objKeys",
  "dyn.objValues",
  "dyn.objectTag",
  "dyn.ownKeys",
  "dyn.packPush",
  "dyn.packPushSpread",
  "dyn.stringConstructor",
  "dyn.this",
  "dyn.toNumberCoerce",
  "dyn.toNumeric",
  "dyn.toString",
  "dyn.toStringCoerce",
  "dyn.typedRefIs",
  "dyn.typedRefKeyIs",
  "dyn.typeof",
  // error.ctorOptions runs scr_error_init_options, the initializer
  // error.newOptions also runs: it stamps the receiver's runtime-owned
  // error prefix and reads `options.cause`.
  "error.ctorOptions",
  "error.new",
  "error.newOptions",
  "fs.utimesSync",
  // Buffer.prototype members read as values: a lookup by key.
  "buffer.prototypeMember",
  // Buffer.from(value, offset[, length]) over checked values: an
  // ArrayBuffer's view after Node's offset and length conversions, or a copy
  // of a string, array-like or typed array's values.
  "buffer.poolFromDynOffset",
  "buffer.poolFromDynRange",
  "insp.dyn",
  "insp.dynS",
  // util.format and util.inspect over checked values: the inspect walk and
  // the format conversions read them; insp.registerCustom keeps a class's
  // custom inspect thunk in the runtime's registry.
  "insp.customIsSelf",
  "insp.customResult",
  "insp.format",
  "insp.formatList",
  "insp.formatPrimitives",
  "insp.formatSpecifiesDyn",
  "insp.formatWithOptions",
  "insp.inspect",
  "insp.registerCustom",
  "insp.dynFormatS",
  "insp.dynHidden",
  // The dynamic-tier operators run their dyn twins (scr_js_value.c); the
  // conversions move a value between dyn and jsval, and js.toF64 is
  // dynCheck's number check.
  "js.add",
  "js.arithmetic",
  "js.bitwise",
  "js.compare",
  "js.fromDyn",
  "js.increment",
  "js.toDyn",
  "js.toF64",
  "js.toNumberCoerce",
  "js.toNumeric",
  "json.stringifyReplacer",
  "json.stringifyValue",
  "num.toStringRadix",
  // Process event listeners (signals, uncaughtException, unhandledRejection,
  // rejectionHandled, warning): the runtime keeps the callback and calls it
  // with fresh event values; off compares callbacks by identity.
  "process.offRejectionHandled",
  "process.offSignal",
  "process.offUncaughtException",
  "process.offUnhandledRejection",
  "process.offWarning",
  "process.onRejectionHandled",
  "process.onSignal",
  "process.onUncaughtException",
  "process.onUnhandledRejection",
  "process.onWarning",
  "sharedArrayBuffer.new",
  "text.decodeStream",
  "worker.new",
]);
/** The node kinds each walk below reads. */
const LIB_CALL_KINDS: readonly IrNodeKind[] = ["libCall"];
const CALL_FACT_KINDS: readonly IrNodeKind[] = [
  ...FUNCTION_REFERENCE_KINDS,
  "virtualCall",
  "instanceOfValue",
  "varRef",
  "assignExpr",
  "incDec",
  "classRef",
  "varDecl",
  "assign",
  "forOf",
];
const CENSUS_KINDS: readonly IrNodeKind[] = [
  "call",
  "new",
  "varRef",
  "fieldGet",
  "fieldIncDec",
  "closure",
  "classRef",
  "incDec",
  "forOf",
  "tryCatch",
];
const DECLARATION_KINDS: readonly IrNodeKind[] = ["varDecl"];
const CANDIDATE_WRITE_KINDS: readonly IrNodeKind[] = [
  "assign",
  "varDecl",
  "fieldSet",
  "return",
  "call",
  "new",
  "assignExpr",
];
const CALL_KINDS: readonly IrNodeKind[] = ["call", "new"];
const SLOT_WRITE_KINDS: readonly IrNodeKind[] = ["return", "call", "new"];
const NARROW_WRITE_KINDS: readonly IrNodeKind[] = ["assign", "varDecl", "fieldSet", "assignExpr"];

/** Visits the nodes of `fn` in walk order; with `scan`, only those of its
 * kinds, read from the module's node index (the visitors must ignore the
 * other kinds). */
function walkFunction(
  fn: IrFunction,
  scan: IrKindScan | undefined,
  visit: { expr?: (e: IrExpr) => void; stmt?: (s: IrStmt) => void },
): void {
  if (scan !== undefined) {
    eachNodeOfKinds(fn, scan, (node, statement) => {
      if (statement) visit.stmt?.(node as IrStmt);
      else visit.expr?.(node as IrExpr);
    });
    return;
  }
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

/** The class field names that runtime stores through live dynamic views
 * (typed-ref capsules) can write: every name when `all` (a dynamic store
 * whose key is not a literal), otherwise the
 * literal keys of `dyn.keySet`/`dyn.keyDelete`. A view commits a store back
 * into the instance's native field slots, which the IR does not show. */
export interface DynamicFieldStores {
  all: boolean;
  names: Set<string>;
}

/** Computes DynamicFieldStores with one walk of every function. Analyses of
 * the same module accept the result so the emitter walks the module once. */
export function dynamicFieldStores(
  mod: IrModule,
  records = new Map((mod.records ?? []).map((r) => [r.id, r])),
  unions = new Map((mod.unions ?? []).map((u) => [u.id, u])),
  nodes?: IrNodeIndex,
): DynamicFieldStores {
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
  // A store whose key is not a literal names every field: later stores add
  // nothing, so the walk stops there.
  const scan = nodes?.scan(LIB_CALL_KINDS);
  for (const fn of mod.functions) {
    if (dynWritesAll) break;
    walkFunction(fn, scan, {
      expr: (e) => {
        if (dynWritesAll) return;
        if (
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
  }
  return { all: dynWritesAll, names: dynWritten };
}

/** The f64 class field families a runtime store through a live dynamic view
 * can write: the class reaches checked-dynamic code (directly or through
 * another exposed type), and some dynamic store in the program can name the
 * field. */
export function dynamicallyStoredFamilies(
  mod: IrModule,
  slots: Int32Slots,
  stores?: DynamicFieldStores,
): Set<string> {
  const records = new Map((mod.records ?? []).map((r) => [r.id, r]));
  const unions = new Map((mod.unions ?? []).map((u) => [u.id, u]));
  // A live dyn view (typed-ref capsule) of an instance writes back into
  // its fields only after a runtime store into the capsule; the commit then
  // writes every field from the view, which holds the exact snapshot value
  // of any property no store named. So reaching dynamic code disqualifies
  // exactly the field names some dynamic store in the program can name.
  const { all: dynWritesAll, names: dynWritten } =
    stores ?? dynamicFieldStores(mod, records, unions);
  const storable = (field: { name: string; type: IrType }): boolean =>
    field.type.kind === "f64" &&
    !field.name.startsWith("%") &&
    (dynWritesAll || dynWritten.has(field.name));
  const families = new Set<string>();
  // Without a field some store can name, no class is worth exposing.
  if (!(mod.classes ?? []).some((cls) => cls.fields.some(storable))) return families;
  const classes = new Map((mod.classes ?? []).map((c) => [c.name, c]));
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
  for (const fn of mod.functions)
    walkFunction(fn, undefined, {
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
      if (storable(field)) families.add(slots.family(cls.name, field.name)!);
  }
  return families;
}

/** How functions can be reached besides direct calls: as values (closures,
 * the entry, constructors behind class values: `valueEscaped`), through
 * virtual dispatch (`virtualTargets`), or as vtable entries the runtime
 * calls (`runtimeVirtual`: methods of runtime-rooted hierarchies). */
export function functionCallFacts(
  mod: IrModule,
  classes: ReadonlyMap<string, IrClassDef>,
  subtree: (className: string) => string[],
  nodes?: IrNodeIndex,
): {
  valueEscaped: Set<string>;
  virtualTargets: Set<string>;
  runtimeVirtual: (name: string) => boolean;
} {
  const escaped = new Set<string>(moduleFunctionReferences(mod));
  const virtualTargets = new Set<string>();
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
  // A class value can reach `new` through its construct thunk; one that
  // only feeds an instanceof interval check cannot. Class references are
  // checked once every function has contributed its tested-only ones.
  const testedOnly = new Set<IrExpr>();
  const classRefs: (IrExpr & { kind: "classRef" })[] = [];
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
    walkFunction(fn, nodes?.scan(CALL_FACT_KINDS), {
      expr: (e) => {
        const referenced = exprFunctionReference(e);
        if (referenced !== undefined) escaped.add(referenced);
        if (e.kind === "virtualCall") {
          for (const name of subtree(e.className)) virtualTargets.add(`%${name}.${e.method}`);
          for (let c = classes.get(e.className); c; c = c.base ? classes.get(c.base) : undefined)
            virtualTargets.add(`%${c.name}.${e.method}`);
        } else if (e.kind === "instanceOfValue") {
          if (e.classValue.kind === "classRef") testedOnly.add(e.classValue);
          else if (e.classValue.kind === "varRef") count(tests, e.classValue.localId);
        } else if (e.kind === "varRef") count(reads, e.localId);
        else if (e.kind === "assignExpr" || e.kind === "incDec") count(writes, e.localId);
        else if (e.kind === "classRef") classRefs.push(e);
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
  for (const e of classRefs) if (!testedOnly.has(e)) escaped.add(`%${e.className}.constructor`);
  const runtimeVirtual = (name: string): boolean =>
    runtimePrefixes.some((prefix) => name.startsWith(prefix));
  return { valueEscaped: escaped, virtualTargets, runtimeVirtual };
}

/** Facts about the same module that a caller has already computed. */
export interface Int32SlotInputs {
  dynamicStores?: DynamicFieldStores;
  initializerBindings?: ReadonlyMap<string, IrGlobal[]>;
  /** The module's node index, read instead of walking the bodies. */
  nodes?: IrNodeIndex;
  /** Revises a function of a module marked for int32 array candidates when
   * candidates drop (int32-arrays.ts Int32ArrayRevision): the function
   * marked without the `dropped` candidates. With it, a candidate that drops
   * (and keeps no checked stores) takes its sites back to the element-reader
   * calls the marking inlined, and the fixpoint goes on over the revised
   * functions, so its result is the analysis of the module marked for the
   * candidates it keeps. A revision that changes more of a function than
   * those sites throws Int32RevisionConflict. */
  revise?: (fnName: string, dropped: ReadonlySet<string>) => IrFunction;
}

/** A revision (Int32SlotInputs.revise) changed a function in a way the
 * fixpoint cannot follow: a call of a function no other call reaches, or
 * any change besides element-reader calls taking the place of their
 * inlined reads. The module needs an analysis of its own. */
export class Int32RevisionConflict extends Error {}

/** What the analysis's setup reads from a function body, besides direct
 * calls: a revision must leave all of it unchanged. */
function revisionStructure(fn: IrFunction): {
  calls: { callee: string; args: number }[];
  rest: string;
} {
  const calls: { callee: string; args: number }[] = [];
  const rest: string[] = [];
  const boxed = new Set(fn.locals.filter((local) => local.boxed).map((local) => local.id));
  const expr = (e: IrExpr): boolean => {
    const referenced = exprFunctionReference(e);
    if (referenced !== undefined) rest.push(`ref:${referenced}`);
    switch (e.kind) {
      case "call":
        calls.push({ callee: e.callee, args: e.args.length });
        break;
      case "new":
        rest.push(`new:${e.className}:${e.args.length}`);
        break;
      case "varRef":
        if (boxed.has(e.localId)) rest.push(`read:${e.localId}`);
        break;
      case "assignExpr":
      case "incDec":
        rest.push(`${e.kind}:${e.localId}`);
        break;
      case "fieldGet":
      case "fieldIncDec":
        rest.push(`${e.kind}:${e.className}\0${e.field}`);
        break;
      case "closure":
        rest.push(`closure:${e.fnName}:${e.captures.join(",")}`);
        break;
      case "classRef":
        rest.push(`classRef:${e.className}:${(e.captures ?? []).join(",")}`);
        break;
      case "virtualCall":
        rest.push(`virtualCall:${e.className}.${e.method}`);
        break;
      case "instanceOfValue":
        rest.push(`instanceOf:${e.classValue.kind}`);
        break;
    }
    if (BOUNDARY_KINDS.has(e.kind)) rest.push(`boundary:${e.kind}`);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "forOf":
        rest.push(`forOf:${s.localId}`);
        break;
      case "tryCatch":
        if (s.catchLocalId) rest.push(`catch:${s.catchLocalId}`);
        break;
      case "assign":
      case "varDecl":
        if (boxed.has(s.localId)) rest.push(`${s.kind}:${s.localId}`);
        break;
      case "throw":
        rest.push("throw");
        break;
    }
    return everyStmtChild(s, expr, stmt);
  };
  for (const s of fn.body) stmt(s);
  rest.sort();
  for (const local of fn.locals)
    if (local.boxed || local.tdz)
      rest.push(`local:${local.id}:${local.boxed === true}:${local.tdz === true}`);
  for (const capture of fn.captures ?? []) rest.push(`capture:${capture.localId}`);
  for (const capture of fn.classCaptures ?? []) rest.push(`classCapture:${capture.localId}`);
  return { calls, rest: rest.join("\n") };
}

export function analyzeInt32Slots(mod: IrModule, inputs: Int32SlotInputs = {}): Int32Slots {
  const nodes = inputs.nodes;
  const classes = new Map((mod.classes ?? []).map((c) => [c.name, c]));
  const slots = new Int32Slots(classes);
  if (mod.lib) return slots;
  const reason = (key: string, why: string): void => {
    if (!slots.reasons.has(key)) slots.reasons.set(key, why);
  };
  // Int32 contracts (ir/contract-check.ts proved every write): pinned
  // candidates the fixpoint below never drops, plus local facts.
  const contracts = mod.contracts;
  for (const family of contracts?.int32Fields ?? []) {
    slots.pin(`field:${family}`);
    slots.addField(family);
  }
  for (const key of contracts?.int32Params ?? []) {
    const cut = key.indexOf("\0");
    slots.pin(`param:${key}`);
    slots.addParam(key.slice(0, cut), key.slice(cut + 1));
  }
  for (const fnName of contracts?.int32Returns ?? []) {
    slots.pin(`ret:${fnName}`);
    slots.addReturn(fnName);
  }
  for (const key of contracts?.int32Locals ?? []) slots.addInt32Local(key);
  for (const key of contracts?.int32Elements ?? []) slots.addInt32Elements(key);
  // Int32 array candidates (ir/int32-arrays.ts): assumed to hold int32
  // elements until a store the fixpoint cannot prove drops one, with every
  // candidate the same array can reach (its group).
  const arrayCandidates = new Map<string, Set<string>>();
  const globalArrays = new Set<string>();
  const arrayKeys = new Set(mod.int32ArrayCandidates ?? []);
  slots.narrowedReads = arrayKeys.size > 0;
  for (const key of arrayKeys) {
    const cut = key.indexOf("\0");
    if (cut === 0) globalArrays.add(key.slice(1));
    else {
      const fnName = key.slice(0, cut);
      const set = arrayCandidates.get(fnName) ?? new Set<string>();
      set.add(key.slice(cut + 1));
      arrayCandidates.set(fnName, set);
    }
    slots.addInt32Elements(int32ArraySlot(key));
  }
  const arrayGroups = arrayKeys.size > 0 ? int32ArrayGroups(mod, arrayKeys) : null;
  // Functions that read or write a candidate global.
  const globalArrayFunctions = new Set<string>();
  if (arrayGroups)
    for (const names of arrayGroups.globalReaders.values())
      for (const name of names) globalArrayFunctions.add(name);

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
  for (const family of dynamicallyStoredFamilies(mod, slots, inputs.dynamicStores)) {
    if (slots.isPinnedField(family)) continue;
    dropFamily(family, "dynamic stores can name the field");
  }

  /* ── functions: escapes, parameter and return candidates ── */
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const calls = functionCallFacts(mod, classes, subtree, nodes);
  const escaped = new Set([...calls.valueEscaped, ...calls.virtualTargets]);
  const virtual = calls.runtimeVirtual;

  const paramKey = (fnName: string, localId: string): string => `param:${fnName}\0${localId}`;
  const dropParam = (fnName: string, localId: string, why: string): boolean => {
    reason(paramKey(fnName, localId), why);
    return slots.dropParam(fnName, localId);
  };
  const dropAllParams = (fn: IrFunction, why: string): void => {
    for (const param of fn.params) dropParam(fn.name, param.localId, why);
  };
  // One walk of every function collects what the steps below need: the
  // functions IR calls reach directly, calls whose arity differs from their
  // callee's, the captured bindings' boxes, and which functions read which
  // slot facts. Facts that depend on earlier steps are applied in walk order
  // where those steps complete.
  const called = slots.called;
  const arityMismatches: IrFunction[] = [];
  const arityChecked = (fn: IrFunction | undefined, args: number, offset: number): void => {
    if (fn && fn.params.length !== args + offset) arityMismatches.push(fn);
  };
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
  // Readers: which functions depend on which slot facts. Reads of a boxed
  // local resolve to its box once the boxes are known.
  const readers = new Map<string, Set<string>>();
  const reads = (slot: string, fnName: string): void => {
    const set = readers.get(slot);
    if (set) set.add(fnName);
    else readers.set(slot, new Set([fnName]));
  };
  const boxedReads: [IrFunction, Set<string>][] = [];
  const incrementedFamilies: string[] = [];
  // Bindings written by `++`/`--` or bound by for-of and catch: a module
  // global among them is no candidate.
  const unstableGlobals = new Set<string>();
  for (const fn of mod.functions) {
    for (const local of fn.locals)
      if (local.boxed) {
        const key = boxKey(fn.name, local.id);
        boxMembers.add(key);
        if (local.type.kind !== "f64" || local.tdz) unstableBoxes.add(key);
      }
    for (const capture of fn.classCaptures ?? [])
      unstableBoxes.add(boxKey(fn.name, capture.localId));
    const read = new Set<string>();
    walkFunction(fn, nodes?.scan(CENSUS_KINDS), {
      expr: (e) => {
        if (e.kind === "call") {
          called.add(e.callee);
          arityChecked(functions.get(e.callee), e.args.length, 0);
          reads(`ret:${e.callee}`, fn.name);
        } else if (e.kind === "new") {
          const constructor = `%${e.className}.constructor`;
          called.add(constructor);
          arityChecked(functions.get(constructor), e.args.length, 1);
          // Constructors return nothing: this only records their callers.
          reads(`ret:${constructor}`, fn.name);
        } else if (e.kind === "varRef") read.add(e.localId);
        else if (e.kind === "fieldGet") {
          const family = slots.family(e.className, e.field);
          if (family) reads(`field:${family}`, fn.name);
        } else if (e.kind === "fieldIncDec") {
          const family = slots.family(e.className, e.field);
          if (family) incrementedFamilies.push(family);
        } else if (e.kind === "closure") {
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
        else if (e.kind === "incDec") {
          unstableBoxes.add(boxKey(fn.name, e.localId));
          unstableGlobals.add(e.localId);
        }
      },
      stmt: (s) => {
        if (s.kind === "forOf") {
          unstableBoxes.add(boxKey(fn.name, s.localId));
          unstableGlobals.add(s.localId);
        }
        if (s.kind === "tryCatch" && s.catchLocalId) {
          unstableBoxes.add(boxKey(fn.name, s.catchLocalId));
          unstableGlobals.add(s.catchLocalId);
        }
      },
    });
    if (read.size > 0) boxedReads.push([fn, read]);
  }

  // Only functions some IR call reaches directly get parameter facts: one
  // the backend invokes by convention has no call site to prove against.
  for (const fn of mod.functions) {
    if (fn.returnType.kind === "f64" && !fn.async && !fn.generator) {
      slots.addReturn(fn.name);
      slots.assumeNonNegative(`ret:${fn.name}`);
    }
    if (
      fn.async ||
      fn.generator ||
      !called.has(fn.name) ||
      escaped.has(fn.name) ||
      virtual(fn.name)
    )
      continue;
    for (const param of fn.params)
      if (param.type.kind === "f64" && !slots.isPinned(paramKey(fn.name, param.localId))) {
        slots.addParam(fn.name, param.localId);
        slots.assumeNonNegative(paramKey(fn.name, param.localId));
      }
  }
  for (const fn of arityMismatches) dropAllParams(fn, "call arity differs");

  // Candidates the fixpoint may drop; rangedParameters retries some.
  const candidates = new Map<string, string[]>();
  const retry = new Set<string>();
  for (const fn of mod.functions) {
    const ids = fn.params.filter((p) => slots.hasParam(fn.name, p.localId)).map((p) => p.localId);
    if (ids.length > 0) candidates.set(fn.name, ids);
  }

  /* ── captured bindings ── */
  const groups = new Map<string, string[]>();
  for (const key of boxMembers) {
    const root = boxRoot(key);
    const list = groups.get(root);
    if (list) list.push(key);
    else groups.set(root, [key]);
  }
  const boxOrigin = new Map<string, string>();
  // Per function, computed on first use: its capture ids and the locals an
  // initialized declaration binds (one body walk each, not one per box).
  const captureIds = new Map<string, Set<string>>();
  const capturedIn = (fnName: string, localId: string): boolean => {
    let ids = captureIds.get(fnName);
    if (ids === undefined) {
      ids = new Set((functions.get(fnName)?.captures ?? []).map((c) => c.localId));
      captureIds.set(fnName, ids);
    }
    return ids.has(localId);
  };
  const initializedDeclarations = new Map<string, Set<string>>();
  const initializedIn = (fn: IrFunction, localId: string): boolean => {
    let ids = initializedDeclarations.get(fn.name);
    if (ids === undefined) {
      const found = new Set<string>();
      walkFunction(fn, nodes?.scan(DECLARATION_KINDS), {
        stmt: (s) => {
          if (s.kind === "varDecl" && s.init) found.add(s.localId);
        },
      });
      initializedDeclarations.set(fn.name, (ids = found));
    }
    return ids.has(localId);
  };
  for (const [group, members] of groups) {
    if (members.some((key) => unstableBoxes.has(key))) continue;
    // The origin is the one member that is not a capture of its function.
    const origins = members.filter((key) => {
      const [fnName, localId] = key.split("\0") as [string, string];
      return !capturedIn(fnName, localId);
    });
    if (origins.length !== 1) continue;
    const [fnName, localId] = origins[0]!.split("\0") as [string, string];
    const origin = functions.get(fnName)!;
    if (origin.params.some((p) => p.localId === localId)) {
      if (!slots.hasParam(fnName, localId)) continue;
    } else if (!initializedIn(origin, localId)) continue;
    boxOrigin.set(`param:${fnName}\0${localId}`, group);
    slots.addBox(group, members);
    // A box starts from its origin parameter's value: it can only be
    // non-negative while that parameter is.
    if (
      !origin.params.some((p) => p.localId === localId) ||
      slots.isNonNegative(paramKey(fnName, localId))
    )
      slots.assumeNonNegative(`box:${group}`);
  }
  const dropBox = (group: string | null, why: string): boolean => {
    if (group === null) return false;
    reason(`box:${group}`, why);
    return slots.dropBox(group);
  };

  for (const [fn, read] of boxedReads)
    for (const localId of read) {
      const group = slots.boxGroup(fn.name, localId);
      if (group !== null) reads(`box:${group}`, fn.name);
    }

  /* ── module globals ── */
  // A module global of type number is a candidate when its module's
  // initializer assigns it at its top level or in an unlabeled block there
  // (the declaration's initializer, which runs before any read that does
  // not throw) and no other write is outside the assignments the fixpoint
  // checks. Globals with a TDZ sentinel or a cycle's initialization flag,
  // and globals an Int32 contract already covers, keep their ordinary facts.
  const initialized = new Set<string>();
  const initializers = (body: readonly IrStmt[]): void => {
    for (const s of body) {
      if (s.kind === "assign") initialized.add(s.localId);
      else if (s.kind === "block" && !s.labels?.length) initializers(s.body);
    }
  };
  for (const fn of mod.functions) if (fn.name.startsWith("%init")) initializers(fn.body);
  for (const global of mod.globals ?? []) {
    if (
      global.type.kind !== "f64" ||
      global.tdz ||
      global.initFlag !== undefined ||
      !initialized.has(global.id) ||
      unstableGlobals.has(global.id) ||
      contracts?.int32Locals?.includes(`\0${global.id}`)
    )
      continue;
    slots.addGlobal(global.id);
    slots.assumeNonNegative(`global:${global.id}`);
  }
  const dropGlobal = (id: string, why: string): boolean => {
    reason(`global:${id}`, why);
    return slots.dropGlobal(id);
  };
  for (const [fn, read] of boxedReads)
    for (const localId of read) if (slots.hasGlobal(localId)) reads(`global:${localId}`, fn.name);
  for (const family of incrementedFamilies) dropFamily(family, "++/-- on the field");

  /* ── the optimistic fixpoint ── */
  const bindings = inputs.initializerBindings ?? findInitializerBindings(mod);
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
  const candidateArgs = (callee: IrFunction | undefined, args: number, offset: number): boolean => {
    if (!callee) return false;
    for (let i = 0; i < args; i++) {
      const param = callee.params[i + offset];
      if (param && slots.hasParam(callee.name, param.localId)) return true;
    }
    return false;
  };
  const candidateWrites = nodes?.scan(CANDIDATE_WRITE_KINDS);
  const hasCandidateWrite = (fn: IrFunction): boolean => {
    if (arrayCandidates.has(fn.name)) return true;
    if (globalArrayFunctions.has(fn.name)) return true;
    const box = (localId: string): boolean => slots.hasBox(slots.boxGroup(fn.name, localId));
    const returns = slots.hasReturn(fn.name);
    let found = false;
    eachNodeOfKinds(fn, candidateWrites, (node) => {
      switch (node.kind) {
        case "assign":
          found = box(node.localId) || slots.hasGlobal(node.localId);
          break;
        case "varDecl":
          found = node.init !== null && box(node.localId);
          break;
        case "fieldSet": {
          const family = slots.family(node.className, node.field);
          found = !!family && slots.hasFamily(family);
          break;
        }
        case "return":
          found = returns;
          break;
        case "call":
          found = candidateArgs(functions.get(node.callee), node.args.length, 0);
          break;
        case "new":
          found = candidateArgs(
            functions.get(`%${node.className}.constructor`),
            node.args.length,
            1,
          );
          break;
        case "assignExpr":
          found = box(node.localId) || slots.hasGlobal(node.localId);
          break;
      }
      return !found;
    });
    return found;
  };
  // Candidates dropped without checked stores, and the revision of the
  // functions that hold them (Int32SlotInputs.revise).
  const dropped = new Set<string>();
  const revise = (names: ReadonlySet<string>): void => {
    for (const name of names) {
      const previous = functions.get(name)!;
      const next = inputs.revise!(name, dropped);
      if (next === previous) continue;
      const before = revisionStructure(previous);
      const after = revisionStructure(next);
      if (before.rest !== after.rest) throw new Int32RevisionConflict(name);
      // The revision adds the element-reader calls back: each must be of a
      // function other calls already reach, with its arity.
      const counts = new Map<string, number>();
      for (const { callee } of before.calls) counts.set(callee, (counts.get(callee) ?? 0) + 1);
      for (const { callee, args } of after.calls) {
        const left = counts.get(callee) ?? 0;
        if (left > 0) {
          counts.set(callee, left - 1);
          continue;
        }
        const target = functions.get(callee);
        if (!called.has(callee) || target === undefined || target.params.length !== args)
          throw new Int32RevisionConflict(name);
        reads(`ret:${callee}`, name);
      }
      for (const left of counts.values()) if (left > 0) throw new Int32RevisionConflict(name);
      functions.set(name, next);
    }
  };
  const provenByFunction = new Map<string, IrExpr[]>();
  // Each function's parameter and result writes under its latest analysis:
  // at the fixpoint, the ranges of every write under the final facts.
  const lastWrites = new Map<string, Map<string, IntegerRange | null>>();
  // First in, first out: a function whose slots change while others wait
  // goes after them, so a caller of many callees is analyzed again once
  // for all of their changes, not once for each.
  for (let head = 0; head < queue.length; head++) {
    const fn = functions.get(queue[head]!)!;
    queued.delete(fn.name);
    const params = slots.facts(fn.name).params;
    if (params) for (const id of params.keys()) reads(`param:${fn.name}\0${id}`, fn.name);
    // Range facts are consulted only at writes into candidate slots; slots
    // are only ever dropped, so a body without such a write needs none.
    const candidate = hasCandidateWrite(fn);
    const ranges: IntegerRanges = candidate
      ? analyzeIntegerRanges(numeric(fn), slots.facts(fn.name))
      : new Map();
    if (ranges.size > 0) lastWrites.set(fn.name, slotWrites(fn, ranges, functions, nodes));
    else lastWrites.delete(fn.name);
    const proven: IrExpr[] = [];
    // The walk below acts only at writes into candidate slots.
    if (!candidate) {
      provenByFunction.set(fn.name, proven);
      continue;
    }
    const int32 = (e: IrExpr): boolean => withinInt32(ranges.get(e));
    // The range of an exact integer that may also be NaN: an element read
    // of a candidate through `getNumber` (`a[k]!` in arithmetic, NaN for a
    // missing element), and `+`, `-` and `*` over such values and integers.
    // A checked store widens the array at a NaN like at any value that is
    // not an int32.
    const integerOrNaN = (e: IrExpr): IntegerRange | null => {
      const range = ranges.get(e);
      if (range) return range;
      if (e.kind === "numLit")
        return Number.isInteger(e.value) ? { min: e.value, max: e.value } : null;
      if (e.kind === "arrIntrinsic" && e.method === "getNumber" && e.receiver.kind === "varRef")
        return slots.hasInt32ElementSlot(int32ArraySlot(int32ArrayKey(fn.name, e.receiver.localId)))
          ? INT32_RANGE
          : null;
      if (e.kind !== "bin" || (e.op !== "+" && e.op !== "-" && e.op !== "*")) return null;
      const left = integerOrNaN(e.left);
      const right = left && integerOrNaN(e.right);
      if (!left || !right) return null;
      const bounds =
        e.op === "+"
          ? [left.min + right.min, left.max + right.max]
          : e.op === "-"
            ? [left.min - right.max, left.max - right.min]
            : [
                left.min * right.min,
                left.min * right.max,
                left.max * right.min,
                left.max * right.max,
              ];
      const min = Math.min(...bounds);
      const max = Math.max(...bounds);
      return Math.abs(min) < 2 ** 53 && Math.abs(max) < 2 ** 53 ? { min, max } : null;
    };
    // Every element stored into an int32 array candidate must be an int32
    // under the facts that assume the candidates' own elements are; a
    // failing store drops its array's element facts, and the function is
    // analyzed again without them. When every failing store is still an
    // exact integer under those facts (a counter, `a[i]! + 1`) and the array
    // is only ever allocated by a fill that may be long
    // (checkableInt32Allocations), it keeps int32 slots with checked stores
    // (checkedInt32Arrays), which widen it to doubles in place at the first
    // store that is not an int32.
    const locals = arrayCandidates.get(fn.name);
    let arrays = locals;
    if (globalArrayFunctions.has(fn.name)) {
      const both = new Set<string>();
      if (locals) for (const id of locals) both.add(id);
      for (const id of globalArrays) both.add(id);
      arrays = both;
    }
    // Functions whose candidates this visit drops, revised after it.
    const revised = new Set<string>();
    if (arrays && arrayGroups) {
      const requeue = (name: string): void => {
        if (queued.has(name)) return;
        queued.add(name);
        queue.push(name);
      };
      const params = new Set(fn.params.map((param) => param.localId));
      for (const [id, values] of int32ArrayStores(fn, arrays)) {
        const key = int32ArrayKey(fn.name, id);
        if (!slots.hasInt32ElementSlot(int32ArraySlot(key)) || values.every(int32)) continue;
        // Checked stores serve a lone local: its allocations are the only
        // arrays it holds. Its stores are judged under the element facts
        // the ranges were computed with.
        const checkable = values.every((value) => int32(value) || integerOrNaN(value) !== null);
        // The array's group drops together: every function reading a
        // member is analyzed again without its facts.
        const group = arrayGroups.group.get(key) ?? [key];
        for (const member of group) {
          slots.dropInt32Elements(int32ArraySlot(member));
          if (member.startsWith("\0")) {
            const names = arrayGroups.globalReaders.get(member);
            if (names) for (const name of names) requeue(name);
          } else requeue(member.slice(0, member.indexOf("\0")));
        }
        if (
          group.length === 1 &&
          !key.startsWith("\0") &&
          !params.has(id) &&
          checkable &&
          checkableInt32Allocations(fn, id)
        )
          slots.checkedInt32Arrays.add(key);
        else {
          for (const member of group) reason(`array:${member}`, "an element store is not int32");
          if (inputs.revise !== undefined) {
            // The revised module no longer marks the group: its functions
            // leave the candidate sets the visits below consult.
            for (const member of group) {
              dropped.add(member);
              if (member.startsWith("\0")) {
                globalArrays.delete(member.slice(1));
                const names = arrayGroups.globalReaders.get(member);
                if (names) for (const name of names) revised.add(name);
              } else {
                const cut = member.indexOf("\0");
                const owner = member.slice(0, cut);
                const ids = arrayCandidates.get(owner);
                ids?.delete(member.slice(cut + 1));
                if (ids?.size === 0) arrayCandidates.delete(owner);
                revised.add(owner);
              }
            }
            globalArrayFunctions.clear();
            for (const [member, names] of arrayGroups.globalReaders)
              if (!dropped.has(member)) for (const name of names) globalArrayFunctions.add(name);
          }
        }
      }
    }
    if (revised.size > 0) {
      revise(revised);
      // A revised body is analyzed again (it was queued with its readers);
      // the writes of the body it replaces no longer count.
      if (functions.get(fn.name) !== fn) continue;
    }
    // An int32 written into a slot still assumed non-negative: widen the
    // assumption when the value may be negative, and reanalyze its readers.
    const settle = (slot: string, e: IrExpr): void => {
      if (!slots.isNonNegative(slot) || (ranges.get(e)?.min ?? -1) >= 0) return;
      slots.demote(slot);
      invalidate(slot);
      const group = boxOrigin.get(slot);
      if (group !== undefined && slots.demote(`box:${group}`)) invalidate(`box:${group}`);
    };
    const args = (callee: IrFunction | undefined, list: IrExpr[], offset: number): void => {
      if (!callee) return;
      list.forEach((arg, i) => {
        const param = callee.params[i + offset];
        if (!param || !slots.hasParam(callee.name, param.localId)) return;
        const slot = `param:${callee.name}\0${param.localId}`;
        if (int32(arg)) {
          settle(slot, arg);
          return;
        }
        if (dropParam(callee.name, param.localId, `argument in ${fn.name} is not int32`)) {
          invalidate(slot);
          // An argument computed where the caller's own parameters were
          // (or are no longer) assumed int32: ranges from the call sites
          // may still prove it (rangedParameters).
          if (candidates.has(fn.name)) retry.add(`${callee.name}\0${param.localId}`);
        }
        const group = boxOrigin.get(slot) ?? null;
        if (dropBox(group, `parameter ${param.localId} is not int32`)) invalidate(`box:${group}`);
      });
    };
    const boxWrite = (localId: string, value: IrExpr): void => {
      const group = slots.boxGroup(fn.name, localId);
      if (!slots.hasBox(group)) return;
      if (int32(value)) settle(`box:${group}`, value);
      else if (dropBox(group, `write in ${fn.name} is not int32`)) invalidate(`box:${group}`);
    };
    // An integer literal is its own range, also where the analysis proves
    // nothing (an async module initializer).
    const globalWrite = (localId: string, value: IrExpr): void => {
      if (!slots.hasGlobal(localId)) return;
      const key = `global:${localId}`;
      const range =
        ranges.get(value) ??
        (value.kind === "numLit" && Number.isSafeInteger(value.value) && !Object.is(value.value, -0)
          ? { min: value.value, max: value.value }
          : null);
      if (!withinInt32(range)) {
        if (dropGlobal(localId, `write in ${fn.name} is not int32`)) invalidate(key);
      } else if (range!.min < 0 && slots.demote(key)) invalidate(key);
    };
    walkFunction(fn, nodes?.scan(CANDIDATE_WRITE_KINDS), {
      stmt: (s) => {
        if (s.kind === "assign") {
          boxWrite(s.localId, s.value);
          globalWrite(s.localId, s.value);
        } else if (s.kind === "varDecl" && s.init) boxWrite(s.localId, s.init);
        if (s.kind === "fieldSet") {
          const family = slots.family(s.className, s.field);
          if (!family || !slots.hasFamily(family)) return;
          if (int32(s.value)) proven.push(s.value);
          else {
            dropFamily(family, `write in ${fn.name} is not int32`);
            invalidate(`field:${family}`);
          }
        } else if (s.kind === "return" && slots.hasReturn(fn.name)) {
          if (s.value && int32(s.value)) {
            settle(`ret:${fn.name}`, s.value);
            return;
          }
          reason(`ret:${fn.name}`, "return is not int32");
          slots.dropReturn(fn.name);
          invalidate(`ret:${fn.name}`);
        }
      },
      expr: (e) => {
        if (e.kind === "call") args(functions.get(e.callee), e.args, 0);
        else if (e.kind === "new") args(functions.get(`%${e.className}.constructor`), e.args, 1);
        else if (e.kind === "assignExpr") {
          boxWrite(e.localId, e.value);
          globalWrite(e.localId, e.value);
        }
      },
    });
    provenByFunction.set(fn.name, proven);
  }
  for (const proven of provenByFunction.values())
    for (const value of proven) slots.provenWrites.add(value);
  for (const key of arrayKeys)
    if (slots.hasInt32ElementSlot(int32ArraySlot(key))) slots.int32Arrays.add(key);
  const ranged = rangedParameters(
    slots,
    functions,
    retry,
    numeric,
    (callee) => readers.get(`ret:${callee}`),
    nodes,
  );
  narrowSlotRanges(
    slots,
    functions,
    numeric,
    lastWrites,
    ranged,
    (slot) => readers.get(slot),
    nodes,
  );
  return slots;
}

/** Bounds a widened parameter range jumps to: the int32 limits, and the
 * small values recursion usually counts down to. */
const WIDEN_MIN = [1, 0, -1, INT32_RANGE.min];
const WIDEN_MAX = [-1, 0, 1, INT32_RANGE.max];
const widenMin = (min: number): number => WIDEN_MIN.find((bound) => bound <= min) ?? -Infinity;
const widenMax = (max: number): number => WIDEN_MAX.find((bound) => bound >= max) ?? Infinity;

/** Retries the parameters the INT32 assumption could not prove with
 * ranges inferred from their call sites. Recursion that counts down, as in
 * `f(n - 1)` under `n !== 0` or `n > 0`, leaves int32 only when `n` may be
 * the smallest int32; the call sites show it never is. Only parameters
 * dropped for an argument computed in a function that had int32 parameter
 * candidates itself are retried (`retry`).
 *
 * An ascending fixpoint: a parameter's range is the union of its argument
 * ranges at every call site, each analyzed under the ranges its own
 * function's parameters have so far. A function is analyzed once every
 * retried parameter of it has a range, so its body sees only values some
 * caller passes. A range that grows again widens to the bounds above, so
 * the iteration ends; an argument without an int32 range fails its
 * parameter for good (no fact, which only weakens later analyses). When
 * nothing is left to analyze, functions still waiting (reached only from
 * other waiting functions) fail their parameters and are analyzed too, so
 * every call site is checked under the final ranges. The facts the main
 * fixpoint proved are fixed here: these ranges only add precision. */
function rangedParameters(
  slots: Int32Slots,
  functions: ReadonlyMap<string, IrFunction>,
  retry: ReadonlySet<string>,
  numeric: (fn: IrFunction) => IrFunction,
  callersOf: (callee: string) => ReadonlySet<string> | undefined,
  nodes: IrNodeIndex | undefined,
): Set<string> {
  const changed = new Set<string>();
  if (retry.size === 0) return changed;
  // Per function: retried parameter → its range so far (absent: no call
  // site analyzed yet; null: failed).
  const retried = new Map<string, Map<string, IntegerRange | null>>();
  for (const key of retry) retried.set(key.slice(0, key.indexOf("\0")), new Map());
  const isRetried = (fnName: string, localId: string): boolean =>
    retry.has(`${fnName}\0${localId}`);
  // Callers: functions whose bodies pass arguments to retried parameters.
  const callerNames = new Set<string>();
  for (const callee of retried.keys()) {
    const names = callersOf(callee);
    if (names) for (const name of names) callerNames.add(name);
  }
  const callers = [...callerNames].map((name) => functions.get(name)!);
  const ready = (fn: IrFunction): boolean => {
    const ranges = retried.get(fn.name);
    if (!ranges) return true;
    return fn.params.every((p) => !isRetried(fn.name, p.localId) || ranges.has(p.localId));
  };
  const queue: IrFunction[] = [];
  const queued = new Set<string>();
  const enqueue = (fn: IrFunction): void => {
    if (callerNames.has(fn.name) && !queued.has(fn.name) && ready(fn)) {
      queued.add(fn.name);
      queue.push(fn);
    }
  };
  const factsOf = (fn: IrFunction): IntegerSlotFacts => {
    const base = slots.facts(fn.name);
    const ranges = retried.get(fn.name);
    if (!ranges) return base;
    const params = new Map(base.params ?? []);
    for (const [id, range] of ranges) if (range) params.set(id, range);
    return { ...base, params };
  };
  const contribute = (callee: IrFunction, localId: string, range: IntegerRange | null): void => {
    const ranges = retried.get(callee.name)!;
    const previous = ranges.get(localId);
    if (previous === null) return;
    let next: IntegerRange | null;
    if (!withinInt32(range)) next = null;
    else if (previous === undefined) next = range;
    else if (range!.min >= previous.min && range!.max <= previous.max) return;
    else {
      next = {
        min: range!.min < previous.min ? widenMin(range!.min) : previous.min,
        max: range!.max > previous.max ? widenMax(range!.max) : previous.max,
      };
      if (!withinInt32(next)) next = null;
    }
    ranges.set(localId, next);
    // The callee's body now sees other values: analyze it (again).
    queued.delete(callee.name);
    const index = queue.indexOf(callee);
    if (index >= 0) queue.splice(index, 1);
    enqueue(callee);
  };
  const analyze = (fn: IrFunction): void => {
    const ranges = analyzeIntegerRanges(numeric(fn), factsOf(fn));
    const args = (callee: IrFunction | undefined, list: IrExpr[], offset: number): void => {
      if (!callee || !retried.has(callee.name)) return;
      list.forEach((arg, i) => {
        const param = callee.params[i + offset];
        if (param && isRetried(callee.name, param.localId))
          contribute(callee, param.localId, ranges.get(arg) ?? null);
      });
    };
    walkFunction(fn, nodes?.scan(CALL_KINDS), {
      expr: (e) => {
        if (e.kind === "call") args(functions.get(e.callee), e.args, 0);
        else if (e.kind === "new") args(functions.get(`%${e.className}.constructor`), e.args, 1);
      },
    });
  };
  for (const fn of callers) enqueue(fn);
  for (;;) {
    while (queue.length) {
      const fn = queue.shift()!;
      queued.delete(fn.name);
      analyze(fn);
    }
    // Functions only waiting callers reach: fail their missing ranges.
    const waiting = callers.filter((fn) => !ready(fn));
    if (waiting.length === 0) break;
    for (const fn of waiting) {
      const ranges = retried.get(fn.name)!;
      for (const p of fn.params)
        if (isRetried(fn.name, p.localId) && !ranges.has(p.localId)) ranges.set(p.localId, null);
      enqueue(fn);
    }
  }
  for (const [fnName, ranges] of retried)
    for (const [id, range] of ranges)
      if (range) {
        slots.addParam(fnName, id, range);
        changed.add(fnName);
      }
  return changed;
}

const joinRanges = (a: IntegerRange | null, b: IntegerRange | null): IntegerRange | null =>
  a && b ? { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) } : null;
const rangeWithin = (inner: IntegerRange | null, outer: IntegerRange): boolean =>
  inner !== null && inner.min >= outer.min && inner.max <= outer.max;
const sameRange = (a: IntegerRange, b: IntegerRange): boolean => a.min === b.min && a.max === b.max;

/** The values one analysis of a function writes into parameter slots of
 * its direct callees and into its own result slot (`param:` and `ret:`
 * keys), joined per slot; null when some write has no proven range. */
function slotWrites(
  fn: IrFunction,
  ranges: IntegerRanges,
  functions: ReadonlyMap<string, IrFunction>,
  nodes: IrNodeIndex | undefined,
): Map<string, IntegerRange | null> {
  const writes = new Map<string, IntegerRange | null>();
  const write = (key: string, value: IrExpr | null): void => {
    const range = value ? (ranges.get(value) ?? null) : null;
    const previous = writes.get(key);
    writes.set(key, previous === undefined ? range : joinRanges(previous, range));
  };
  const args = (callee: IrFunction | undefined, list: IrExpr[], offset: number): void => {
    if (!callee) return;
    list.forEach((arg, i) => {
      const param = callee.params[i + offset];
      if (param) write(`param:${callee.name}\0${param.localId}`, arg);
    });
  };
  walkFunction(fn, nodes?.scan(SLOT_WRITE_KINDS), {
    stmt: (s) => {
      if (s.kind === "return") write(`ret:${fn.name}`, s.value);
    },
    expr: (e) => {
      if (e.kind === "call") args(functions.get(e.callee), e.args, 0);
      else if (e.kind === "new") args(functions.get(`%${e.className}.constructor`), e.args, 1);
    },
  });
  return writes;
}

/** Rounds after which narrowSlotRanges keeps its last verified ranges. */
const NARROW_ROUNDS = 6;

/** Narrows parameter and result facts from their proven level (int32 or
 * non-negative int32, or a call-site range) to the values actually written
 * into them, and revives results the level could not prove. `(x * 31 + n)
 * % m` proves its result only under a positive divisor, and keeps i32
 * arithmetic only when `x` is known to be small; the levels know neither,
 * the values passed and returned do.
 *
 * A descending iteration from the fixpoint's facts: each round assumes a
 * range for every slot, reanalyzes the functions that read a slot whose
 * assumption changed, and joins the ranges of every write into each slot.
 * The assumptions are verified (inductive) when every slot's writes land
 * inside its assumed range: then, by induction over the execution, every
 * slot holds only values in its range. A verified round adopts the joined
 * writes as the next assumptions (each bound moves at most once, so the
 * iteration ends), and a reanalyzed function whose every return is now an
 * int32 joins with that range as a result candidate. A slot whose writes
 * leave its assumption falls back to its last verified range (a revived
 * result to none). Only verified assumptions are kept, and a reanalyzed
 * function must still prove every write into a field or box slot (whose
 * facts do not change here), or the narrowing is abandoned. Pinned
 * (contract) slots keep their contract range. */
function narrowSlotRanges(
  slots: Int32Slots,
  functions: ReadonlyMap<string, IrFunction>,
  numeric: (fn: IrFunction) => IrFunction,
  lastWrites: ReadonlyMap<string, ReadonlyMap<string, IntegerRange | null>>,
  changed: ReadonlySet<string>,
  readersOf: (slot: string) => ReadonlySet<string> | undefined,
  nodes: IrNodeIndex | undefined,
): void {
  // Every parameter and result slot with a fact, and that fact.
  const proven = new Map<string, IntegerRange>();
  const fixed = new Set<string>();
  // Results the fixpoint dropped (a return was not an int32 at the level).
  const revivable = new Set<string>();
  for (const fn of functions.values()) {
    const result = slots.hasReturn(fn.name) ? slots.returnRange(fn.name) : null;
    if (result) proven.set(`ret:${fn.name}`, result);
    else if (fn.returnType.kind === "f64" && !fn.async && !fn.generator)
      revivable.add(`ret:${fn.name}`);
    for (const param of fn.params) {
      const range = slots.hasParam(fn.name, param.localId)
        ? slots.paramRange(fn.name, param.localId)
        : null;
      if (range) proven.set(`param:${fn.name}\0${param.localId}`, range);
    }
  }
  for (const key of proven.keys()) if (slots.isPinned(key)) fixed.add(key);
  if (proven.size === fixed.size) return;
  // The readers of a slot: a parameter's function, a result's callers.
  const readersOfKey = (key: string): string[] => {
    if (key.startsWith("param:")) return [key.slice(6, key.indexOf("\0"))];
    const readers = readersOf(key);
    return readers ? [...readers] : [];
  };
  const factsUnder = (
    fn: IrFunction,
    assumed: ReadonlyMap<string, IntegerRange>,
  ): IntegerSlotFacts => {
    const base = slots.facts(fn.name);
    const params = new Map(base.params ?? []);
    for (const param of fn.params) {
      const range = assumed.get(`param:${fn.name}\0${param.localId}`);
      if (range) params.set(param.localId, range);
    }
    const call = base.call;
    return {
      ...base,
      params,
      call: (callee) => assumed.get(`ret:${callee}`) ?? (call ? call(callee) : null),
    };
  };
  // Reanalyze one function: its slot writes, and whether it still proves
  // every write into field and box slots.
  const observe = (
    fn: IrFunction,
    assumed: ReadonlyMap<string, IntegerRange>,
  ): { writes: Map<string, IntegerRange | null>; sound: boolean } => {
    const ranges = analyzeIntegerRanges(numeric(fn), factsUnder(fn, assumed));
    let sound = true;
    const box = (localId: string, value: IrExpr): void => {
      const group = slots.boxGroup(fn.name, localId);
      if (!slots.hasBox(group)) return;
      const range = ranges.get(value) ?? null;
      const level = slots.isNonNegative(`box:${group}`) ? NON_NEGATIVE_INT32_RANGE : INT32_RANGE;
      if (!rangeWithin(range, level)) sound = false;
    };
    walkFunction(fn, nodes?.scan(NARROW_WRITE_KINDS), {
      stmt: (s) => {
        if (s.kind === "assign") box(s.localId, s.value);
        else if (s.kind === "varDecl" && s.init) box(s.localId, s.init);
        else if (s.kind === "fieldSet" && slots.isField(s.className, s.field))
          if (!withinInt32(ranges.get(s.value))) sound = false;
      },
      expr: (e) => {
        if (e.kind === "assignExpr") box(e.localId, e.value);
      },
    });
    return { writes: slotWrites(fn, ranges, functions, nodes), sound };
  };
  const writesByFunction = new Map(lastWrites);
  const join = (): Map<string, IntegerRange | null> => {
    const joined = new Map<string, IntegerRange | null>();
    for (const writes of writesByFunction.values())
      for (const [key, range] of writes) {
        if (!proven.has(key) && !revivable.has(key)) continue;
        const previous = joined.get(key);
        joined.set(key, previous === undefined ? range : joinRanges(previous, range));
      }
    return joined;
  };
  // The ranges every function was last analyzed under.
  let analyzed: Map<string, IntegerRange> = new Map(proven);
  let verified: Map<string, IntegerRange> = new Map(proven);
  // Functions whose recorded writes predate their current facts: those
  // whose parameters rangedParameters proved, and their callers, which
  // wrote nothing into those parameters while they had no fact.
  const dirty = new Set(changed);
  for (const name of changed) {
    const callers = readersOf(`ret:${name}`);
    if (callers) for (const caller of callers) dirty.add(caller);
  }
  // The narrowing operator: a bound moves at most once from its proven
  // value (a revived result's from int32), so recursion that shifts its
  // argument (`f(d - 1)`) cannot walk a bound down one step per round.
  const narrowed = (
    joined: ReadonlyMap<string, IntegerRange | null>,
  ): Map<string, IntegerRange> => {
    const next = new Map(verified);
    for (const [key, range] of joined) {
      const current = verified.get(key);
      if (!current || fixed.has(key) || !range || !rangeWithin(range, current)) continue;
      const original = proven.get(key) ?? INT32_RANGE;
      next.set(key, {
        min: current.min === original.min ? range.min : current.min,
        max: current.max === original.max ? range.max : current.max,
      });
    }
    return next;
  };
  let assumed = dirty.size > 0 ? new Map(proven) : narrowed(join());
  for (let round = 0; round < NARROW_ROUNDS; round++) {
    for (const [key, range] of assumed) {
      const before = analyzed.get(key);
      if (!before || !sameRange(range, before))
        for (const name of readersOfKey(key)) dirty.add(name);
    }
    for (const key of analyzed.keys())
      if (!assumed.has(key)) for (const name of readersOfKey(key)) dirty.add(name);
    const observedNow = new Set<string>();
    for (const name of dirty) {
      const fn = functions.get(name);
      if (!fn) continue;
      const observed = observe(fn, assumed);
      if (!observed.sound) return;
      writesByFunction.set(name, observed.writes);
      observedNow.add(name);
    }
    dirty.clear();
    analyzed = assumed;
    const joined = join();
    let inductive = true;
    const next = new Map(assumed);
    for (const [key, range] of assumed) {
      const written = joined.get(key);
      if (written === undefined || rangeWithin(written, range)) continue;
      inductive = false;
      const fallback = verified.get(key);
      if (fallback) next.set(key, fallback);
      else next.delete(key);
    }
    if (inductive) {
      verified = assumed;
      const tighter = narrowed(joined);
      // Results that reanalysis under the narrowed facts proves now.
      for (const key of revivable) {
        const range = joined.get(key);
        if (!tighter.has(key) && observedNow.has(key.slice(4)) && withinInt32(range))
          tighter.set(key, range!);
      }
      if (
        tighter.size === assumed.size &&
        [...tighter].every(([key, range]) => sameRange(range, assumed.get(key)!))
      )
        break;
      assumed = tighter;
    } else if (
      next.size !== assumed.size ||
      [...next].some(([key, range]) => !sameRange(range, assumed.get(key)!))
    ) {
      assumed = next;
    } else break; // narrowing other slots broke a verified one: keep `verified`
  }
  for (const [key, range] of verified) {
    if (fixed.has(key)) continue;
    const original = proven.get(key);
    if (original && sameRange(range, original)) continue;
    if (key.startsWith("ret:")) {
      const fnName = key.slice(4);
      if (!original) {
        slots.addReturn(fnName);
        slots.reasons.delete(key);
      }
      slots.narrowReturn(fnName, range);
    } else {
      const cut = key.indexOf("\0");
      slots.narrowParam(key.slice(6, cut), key.slice(cut + 1), range);
    }
  }
}
