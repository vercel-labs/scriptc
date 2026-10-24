/* Inline dense-storage fast paths for ordinary array element access.
 *
 * Every strict and optional element operation keeps its runtime entry as
 * the authority: the inline path only answers the case the runtime itself
 * answers from dense storage without side effects — a canonical integer
 * index below both the array length and the dense capacity (and, for
 * strict reads, a slot whose state is a present value). Holes, present
 * `undefined`, sparse indices, noncanonical numeric properties (negative,
 * fractional, NaN, infinite, 2^32-1), and out-of-range reads branch to the
 * unchanged runtime call, which is marked cold. The ScrArr field indices
 * (SCR_ARR_FIELD) match the C layout in scr_runtime.h.
 *
 * Indices below the array's hole-free prefix bound (`filled`) skip the
 * state bytes altogether: the runtime keeps every state below it a present
 * value, so reads load the slot directly and writes replace it without
 * touching its state. Other dense indices take the state-checked path,
 * whose writes extend the bound when they continue it. An array without
 * state bytes (SCR_ARR_STATES clear in `spare`) keeps its bound at its
 * length, so reads never reach the state check for it; a write past the
 * bound tests the flag and, without states, appends at the length. */

import { isRefCounted, type IrExpr, type IrType } from "../../ir/ir.js";
import {
  f64Lit,
  loadArrCount,
  SCR_ARR_FIELD,
  SCR_ARR_STATES,
  scrArrStatePtr,
  scrArrStates,
  sizeToDouble,
  storeArrCount,
} from "./common.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { compactRefLoadLines, compactRefStoreLines } from "./classes.js";
import { elemAccess } from "./shapes.js";
import { indexInteger } from "./integer-values.js";
import { integerOrNaNIndex } from "./wrapping-sums.js";

const SCR_ARR_VALUE = 1;

/** Whether the array at `array` has state bytes, as an i1. `spare` changes
 * only in runtime calls, so its loads take their own alias tag. */
export function emitArrayHasStates(host: LlvmEmitterContext, array: string): string {
  const B = host.B;
  const sparePtr = B.tmp(),
    spare = B.tmp(),
    bit = B.tmp(),
    has = B.tmp();
  B.line(
    `${sparePtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${SCR_ARR_FIELD.spare}`,
  );
  host.markMemoryPointer(sparePtr, "array:spare");
  B.line(`${spare} = load i16, ptr ${sparePtr}${host.fieldAliasAttachment(sparePtr)}`);
  B.line(`${bit} = and i16 ${spare}, ${SCR_ARR_STATES}`);
  B.line(`${has} = icmp ne i16 ${bit}, 0`);
  return has;
}

/** Call-site effects of the non-retaining read fallbacks: they only read
 * module-visible memory, or trap without returning to the caller (the trap
 * writes runtime-private stderr/TLS state). Declaring this lets LLVM keep
 * array header loads out of loops whose only calls are these cold paths. */
export const READ_FALLBACK = " cold memory(read, inaccessiblemem: readwrite)";

interface DenseGuard {
  /** The checked dense offset, in the target's size type. */
  offset: string;
  /** The array length loaded by the guard, in the target's size type. */
  len: string;
  /** The hole-free prefix bound loaded by the guard (i32). */
  filled: string;
  /** The dense value storage base pointer, and the end of the states
   * (scrArrStates). */
  data: string;
  states: string;
}

/** Branch to `slow` unless `index` names a canonical array index inside
 * dense storage. Reads also require it below the length; writes may land
 * at or past the length while still inside the dense capacity (the runtime
 * then extends the length over hole states exactly the same way). An index
 * below the hole-free prefix bound branches to `filledLabel` first; both
 * that block and the returned (state-checked) dense block may use the
 * guard's values. A `proven` index is known to lie below the bound (a dense
 * array loop's fast copy, dense-array-loops.ts) and always takes it. With
 * `prefixOnly`, every other index branches to `slow` and no block is left
 * open: only `offset` and `data` are meaningful. */
function emitDenseGuard(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  slow: string,
  requireBelowLen: boolean,
  filledLabel: string,
  width: number,
  proven = false,
  prefixOnly = false,
): DenseGuard {
  const B = host.B;
  const size = host.sizeType;
  const integer = indexInteger(host, index, indexExpr);
  const nanIndex = integer === null ? integerOrNaNIndex(host, index, indexExpr) : null;
  let wide: string;
  let integral: string | null = null;
  if (integer !== null) {
    // A proven integer, or a wide view that equals the double at every
    // index below a length, needs no double round-trip. Negative signed
    // values compare above any length or capacity as unsigned 64-bit
    // integers, and every index that fails the comparisons takes the
    // double's path.
    wide = integer;
  } else if (nanIndex) {
    // An exact integer or NaN is an index exactly when it is ordered.
    wide = nanIndex.wide;
    integral = nanIndex.ordered;
  } else {
    // freeze keeps NaN/out-of-range conversions from producing poison; the
    // exact round-trip comparison then rejects every value that is not an
    // integer, and -0 converts to index 0 exactly like the runtime's check.
    // Any frozen value that passes the round-trip and the unsigned capacity
    // comparison below is the exact index.
    const raw = B.tmp(),
      back = B.tmp();
    wide = B.tmp();
    integral = B.tmp();
    B.line(`${raw} = fptosi double ${index.name} to i64`);
    B.line(`${wide} = freeze i64 ${raw}`);
    B.line(`${back} = sitofp i64 ${wide} to double`);
    B.line(`${integral} = fcmp oeq double ${back}, ${index.name}`);
  }
  const lenPtr = B.tmp(),
    len = B.tmp(),
    capPtr = B.tmp(),
    cap = B.tmp(),
    dataPtr = B.tmp(),
    data = B.tmp(),
    states = B.tmp();
  B.line(
    `${dataPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${SCR_ARR_FIELD.data}`,
  );
  host.markMemoryPointer(dataPtr, "array:header");
  B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
  const loadChecked = (): void => {
    B.line(
      `${lenPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${SCR_ARR_FIELD.len}`,
    );
    host.markMemoryPointer(lenPtr, "array:header");
    loadArrCount(host, len, lenPtr, host.fieldAliasAttachment(lenPtr));
    B.line(
      `${capPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${SCR_ARR_FIELD.cap}`,
    );
    host.markMemoryPointer(capPtr, "array:header");
    loadArrCount(host, cap, capPtr, host.fieldAliasAttachment(capPtr));
  };
  // Reads load the storage bases before branching: the header of a live
  // array is always readable, and unconditional loads let LLVM hoist them
  // out of loops whose only calls are read-only fallbacks. Writes load the
  // fields that only the state-checked path needs inside it, which keeps
  // them off a hot loop of prefix stores (that path stores to the header).
  const eagerHeader = requireBelowLen && !prefixOnly;
  if (eagerHeader) loadChecked();
  const filledPtr = B.tmp(),
    filled = B.tmp(),
    filledWide = B.tmp();
  B.line(
    `${filledPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${SCR_ARR_FIELD.filled}`,
  );
  host.markMemoryPointer(filledPtr, "array:header");
  B.line(`${filled} = load i32, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
  B.line(`${filledWide} = zext i32 ${filled} to i64`);
  const widen = (value: string): string => {
    if (size === "i64") return value;
    const t = B.tmp();
    B.line(`${t} = zext i32 ${value} to i64`);
    return t;
  };
  let offset = wide;
  if (size !== "i64") {
    offset = B.tmp();
    B.line(`${offset} = trunc i64 ${wide} to i32`);
  }
  // The bound never exceeds the length or the dense capacity.
  // The proof covers the counter's integer value only.
  const below = proven && integral === null;
  let inFilled = below ? "true" : B.tmp();
  if (!below) B.line(`${inFilled} = icmp ult i64 ${wide}, ${filledWide}`);
  if (integral) {
    const t = B.tmp();
    B.line(`${t} = and i1 ${integral}, ${inFilled}`);
    inFilled = t;
  }
  if (prefixOnly) {
    B.condBr(inFilled, filledLabel, slow);
    return { offset, len, filled, data, states };
  }
  const check = B.newLabel("arr.check");
  B.condBr(inFilled, filledLabel, check);
  B.startBlock(check);
  if (!eagerHeader) loadChecked();
  const conditions: string[] = [];
  if (integral) conditions.push(integral);
  const belowCap = B.tmp();
  B.line(`${belowCap} = icmp ult i64 ${wide}, ${widen(cap)}`);
  conditions.push(belowCap);
  if (requireBelowLen) {
    const belowLen = B.tmp();
    B.line(`${belowLen} = icmp ult i64 ${wide}, ${widen(len)}`);
    conditions.push(belowLen);
  }
  let ok = conditions[0]!;
  for (const c of conditions.slice(1)) {
    const t = B.tmp();
    B.line(`${t} = and i1 ${ok}, ${c}`);
    ok = t;
  }
  const dense = B.newLabel("arr.dense");
  B.condBr(ok, dense, slow);
  B.startBlock(dense);
  // Only the state-checked block needs the states: the address is pure
  // arithmetic on loaded fields, so computing it here keeps it off the
  // prefix path.
  scrArrStates(host, states, data, cap, width);
  return { offset, len, filled, data, states };
}

/** The i32 prefix bound in the target's size type. */
function sizedFilled(host: LlvmEmitterContext, filled: string): string {
  if (host.sizeType !== "i64") return filled;
  const t = host.B.tmp();
  host.B.line(`${t} = zext i32 ${filled} to i64`);
  return t;
}

function statePointer(
  host: LlvmEmitterContext,
  guard: Pick<DenseGuard, "offset" | "states">,
): string {
  const statePtr = host.B.tmp();
  scrArrStatePtr(host, statePtr, guard.states, guard.offset);
  host.markMemoryPointer(statePtr, "array:present");
  return statePtr;
}

/** How an array's dense slots hold its elements: the access kind (`i32`
 * for int32 arrays, ir/int32-arrays.ts), or `cref` for references to compact
 * class instances (SCR_ELEM_CREF: a 4-byte slot holding the address over 8;
 * LlEmitter.compactArrayElem). */
type SlotKind = ArrayAccess | "cref";

function slotKind(host: LlvmEmitterContext, acc: ArrayAccess, element: IrType): SlotKind {
  return acc === "ref" && host.compactArrayElem(element) ? "cref" : acc;
}

/** The dense slot type: boolean arrays store one byte per element, compact
 * references and int32 arrays four, every other element kind an 8-byte slot. */
function slotType(kind: SlotKind): "i8" | "i32" | "i64" {
  return kind === "bool" ? "i8" : kind === "cref" || kind === "i32" ? "i32" : "i64";
}

/** Bytes per dense slot (scr_arr_slot_width). */
export function slotWidth(kind: SlotKind): number {
  return kind === "bool" ? 1 : kind === "cref" || kind === "i32" ? 4 : 8;
}

/** Bytes per dense slot of an array of `element` (scr_arr_slot_width). */
export function denseSlotWidth(host: LlvmEmitterContext, element: IrType): number {
  return slotWidth(slotKind(host, elemAccess(element), element));
}

/** The runtime accessor family of an access: int32 arrays answer through
 * the double-valued entry points, which convert their slots. */
export function runtimeAccess(acc: ArrayAccess): "f64" | "bool" | "ref" {
  return acc === "i32" ? "f64" : acc;
}

/** The LLVM type of an access's values at the emitter's interface. */
function valueType(acc: ArrayAccess): "double" | "i1" | "ptr" {
  return acc === "f64" || acc === "i32" ? "double" : acc === "bool" ? "i1" : "ptr";
}

function valuePointer(
  host: LlvmEmitterContext,
  guard: Pick<DenseGuard, "offset" | "data">,
  kind: SlotKind,
): string {
  const B = host.B;
  const valuePtr = B.tmp();
  B.line(
    `${valuePtr} = getelementptr inbounds ${slotType(kind)}, ptr ${guard.data}, ${host.sizeType} ${guard.offset}`,
  );
  host.markMemoryPointer(valuePtr, "array:elements");
  return valuePtr;
}

function loadState(host: LlvmEmitterContext, guard: DenseGuard): string {
  const ptr = statePointer(host, guard);
  const state = host.B.tmp();
  host.B.line(`${state} = load i8, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
  return state;
}

/** The ScrElemKind of int32 arrays (scr_array.h). */
export const SCR_ELEM_I32 = 7;

/** How a dense array's slots are read and written: doubles, booleans,
 * references, or the int32 slots of SCR_ELEM_I32 arrays (ir/int32-arrays.ts),
 * whose values are doubles at the emitter's interface. */
export type ArrayAccess = "f64" | "bool" | "ref" | "i32";

/** Before a self-append (`a[i] = a[i] + suffix`) replaces a reference
 * element: when `index` lies in the hole-free prefix and the slot still
 * holds `expected` (the caller's owned snapshot of the old element), the
 * slot takes `placeholder` (an immortal value of the element type) and the
 * array's reference is released, so a snapshot nobody else holds becomes
 * unique and the append can extend it in place. The caller must store into
 * the same slot before any code can observe the array again. Every other
 * index leaves the array untouched. */
export function emitDenseSlotUnlink(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  expected: string,
  placeholder: string,
  element: IrType,
): void {
  const B = host.B;
  const unlink = B.newLabel("arr.unlink"),
    swap = B.newLabel("arr.unlink.swap"),
    done = B.newLabel("arr.unlink.done");
  const guard = emitDenseGuard(host, array, index, indexExpr, done, true, unlink, 8);
  // The state-checked dense block: leave holes and the tail to the store.
  B.br(done);
  B.startBlock(unlink);
  const valuePtr = valuePointer(host, guard, "ref");
  const current = B.tmp(),
    same = B.tmp();
  B.line(`${current} = load ptr, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  B.line(`${same} = icmp eq ptr ${current}, ${expected}`);
  B.condBr(same, swap, done);
  B.startBlock(swap);
  B.line(`store ptr ${placeholder}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  host.releaseHeap(current, element);
  B.br(done);
  B.startBlock(done);
}

/** Strict element read with the runtime getter's result contract: a
 * double, an i1, or a pointer that is +1 (`retain`) or borrowed. The
 * runtime getter keeps the trap for holes, present undefined, and missing
 * properties; it also answers sparse indices. Null reference slots take
 * the runtime path, which returns them without a retain. */
export function emitDenseArrayGet(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  acc: ArrayAccess,
  element: IrType,
  getter: string,
  retain: boolean,
  proven = false,
): string {
  return emitDenseArrayRead(host, array, index, indexExpr, acc, element, getter, retain, proven)
    .value;
}

/** emitDenseArrayGet, with the int32 of an int32 array's element: the
 * slot itself on the dense path, the runtime getter's double converted
 * (exactly: the element is an int32) on the other. */
export function emitDenseArrayRead(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  acc: ArrayAccess,
  element: IrType,
  getter: string,
  retain: boolean,
  proven = false,
): { value: string; int32: string | null } {
  const B = host.B;
  const ty = valueType(acc);
  const ret = acc === "bool" ? "zeroext i1" : ty;
  const kind = slotKind(host, acc, element);
  host.declare(`declare ${ret} @${getter}(ptr, double)`);
  if (acc === "ref" && retain && !isRefCounted(element)) {
    const t = B.tmp();
    B.line(`${t} = call ${ty} @${getter}(ptr ${array}, double ${index.name})`);
    return { value: t, int32: null };
  }
  const slow = B.newLabel("arr.get.slow"),
    join = B.newLabel("arr.get.join"),
    valueLabel = B.newLabel("arr.get.value");
  // The state of slot i is at data + cap * (width + 1) - 1 - i: an inline
  // state check indexed by a loop's induction variable makes LLVM keep
  // -1 - i as a second induction variable, so above the prefix the runtime
  // getter reads the slot.
  const induction = indexExpr?.kind === "varRef" && host.integerLoopBindings.has(indexExpr.localId);
  const guard = emitDenseGuard(
    host,
    array,
    index,
    indexExpr,
    slow,
    true,
    valueLabel,
    slotWidth(kind),
    proven,
    induction,
  );
  if (!induction) {
    const state = loadState(host, guard);
    const present = B.tmp();
    B.line(`${present} = icmp eq i8 ${state}, ${SCR_ARR_VALUE}`);
    B.condBr(present, valueLabel, slow);
  }
  B.startBlock(valueLabel);
  const ptr = valuePointer(host, guard, kind);
  let fast: string;
  let fastInt: string | null = null;
  let fastLabel = valueLabel;
  if (acc === "f64") {
    fast = B.tmp();
    B.line(`${fast} = load double, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
  } else if (acc === "i32") {
    fastInt = B.tmp();
    fast = B.tmp();
    B.line(`${fastInt} = load i32, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
    B.line(`${fast} = sitofp i32 ${fastInt} to double`);
  } else if (acc === "bool") {
    const raw = B.tmp();
    fast = B.tmp();
    B.line(`${raw} = load i8, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
    B.line(`${fast} = icmp ne i8 ${raw}, 0`);
  } else {
    const raw = B.tmp(),
      nonnull = B.tmp();
    if (kind === "cref") {
      const ref = B.tmp();
      B.line(`${ref} = load i32, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
      for (const line of compactRefLoadLines(ref, raw, `${raw}.r`)) B.line(line.trimStart());
    } else {
      B.line(`${raw} = load ptr, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
    }
    B.line(`${nonnull} = icmp ne ptr ${raw}, null`);
    fastLabel = B.newLabel("arr.get.ref");
    B.condBr(nonnull, fastLabel, slow);
    B.startBlock(fastLabel);
    fast = retain ? host.retainFrame(raw, element) : raw;
  }
  B.br(join);
  B.startBlock(slow);
  const slowValue = B.tmp();
  // ToNumber of a foreign element (SCR_ARR_FOREIGN) can run user code.
  const attrs =
    (acc === "ref" && retain) || (getter === "scr_arr_get_number" && host.mayHoldForeign(element))
      ? " cold"
      : READ_FALLBACK;
  B.line(`${slowValue} = call ${ty} @${getter}(ptr ${array}, double ${index.name})${attrs}`);
  let slowInt: string | null = null;
  if (fastInt !== null) {
    slowInt = B.tmp();
    B.line(`${slowInt} = fptosi double ${slowValue} to i32`);
  }
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ${ty} [ ${fast}, %${fastLabel} ], [ ${slowValue}, %${slow} ]`);
  let int32: string | null = null;
  if (fastInt !== null && slowInt !== null) {
    int32 = B.tmp();
    B.line(`${int32} = phi i32 [ ${fastInt}, %${fastLabel} ], [ ${slowInt}, %${slow} ]`);
  }
  return { value: result, int32 };
}

/** `scr_arr_get_number`: a numeric element, or NaN for every missing,
 * hole, or present-undefined slot (answered by the runtime). */
export function emitDenseArrayNumber(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  proven = false,
  acc: "f64" | "i32" = "f64",
): string {
  return emitDenseArrayGet(
    host,
    array,
    index,
    indexExpr,
    acc,
    { kind: "f64" },
    "scr_arr_get_number",
    false,
    proven,
  );
}

/** `scr_arr_state` (as a double) or `scr_arr_has` (as an i1). Dense
 * in-range indices answer from the state byte; everything else keeps the
 * runtime query, including canonical indices at or past the length. */
export function emitDenseArrayState(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  kind: "state" | "has",
  width: number,
  /** The index is a dense array loop counter its entry test proved below
   * the hole-free prefix (provenDenseIndex): the slot is a present value. */
  proven = false,
): string {
  const B = host.B;
  if (proven) return kind === "state" ? f64Lit(SCR_ARR_VALUE) : "true";
  const fn = kind === "state" ? "scr_arr_state" : "scr_arr_has";
  const ty = kind === "state" ? "double" : "i1";
  host.declare(`declare ${kind === "state" ? "double" : "zeroext i1"} @${fn}(ptr, double)`);
  const slow = B.newLabel("arr.state.slow"),
    join = B.newLabel("arr.state.join"),
    filledLabel = B.newLabel("arr.state.filled");
  const guard = emitDenseGuard(host, array, index, indexExpr, slow, true, filledLabel, width);
  const state = loadState(host, guard);
  const fast = B.tmp();
  if (kind === "state") B.line(`${fast} = uitofp i8 ${state} to double`);
  else B.line(`${fast} = icmp ne i8 ${state}, 0`);
  const fastLabel = B.newLabel("arr.state.fast");
  B.br(fastLabel);
  B.startBlock(fastLabel);
  B.br(join);
  // Below the bound every state is a present value.
  B.startBlock(filledLabel);
  B.br(join);
  B.startBlock(slow);
  const slowValue = B.tmp();
  B.line(`${slowValue} = call ${ty} @${fn}(ptr ${array}, double ${index.name})${READ_FALLBACK}`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  const filledValue = kind === "state" ? f64Lit(SCR_ARR_VALUE) : "true";
  B.line(
    `${result} = phi ${ty} [ ${fast}, %${fastLabel} ], [ ${filledValue}, %${filledLabel} ], [ ${slowValue}, %${slow} ]`,
  );
  return result;
}

/** Element write with `scr_arr_set_*` semantics: the array takes the
 * value's reference. A dense index stores the slot, marks it present, and
 * extends the length when it lands at or past it; a replaced present
 * reference is released after the new edge is published (a release can
 * collect cycles). Every other index takes the unchanged runtime call.
 * `int32`, for an int32 array, is the value as an i32 when the caller has
 * it at hand. */
export function emitDenseArraySet(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  acc: ArrayAccess,
  element: IrType,
  value: string,
  proven = false,
  int32: string | null = null,
): void {
  const B = host.B;
  const ty = valueType(acc);
  const kind = slotKind(host, acc, element);
  const setter = `scr_arr_set_${runtimeAccess(acc)}`;
  host.declare(`declare void @${setter}(ptr, double, ${acc === "bool" ? "i1 zeroext" : ty})`);
  const call = (attrs: string): void =>
    B.line(`call void @${setter}(ptr ${array}, double ${index.name}, ${ty} ${value})${attrs}`);
  if (acc === "ref" && !isRefCounted(element)) {
    call("");
    return;
  }
  // An int32 array's stores are proven int32s (ir/int32-arrays.ts); both
  // dense paths below store the converted value.
  let int32Value: string | null = int32;
  if (acc === "i32" && int32Value === null) {
    int32Value = B.tmp();
    B.line(`${int32Value} = fptosi double ${value} to i32`);
  }
  const slow = B.newLabel("arr.set.slow"),
    join = B.newLabel("arr.set.join"),
    filledLabel = B.newLabel("arr.set.filled");
  const guard = emitDenseGuard(
    host,
    array,
    index,
    indexExpr,
    slow,
    false,
    filledLabel,
    slotWidth(kind),
    proven,
  );
  const { offset, len } = guard;
  const storeValue = (valuePtr: string): void => {
    if (acc === "f64") {
      B.line(`store double ${value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    } else if (acc === "i32") {
      B.line(`store i32 ${int32Value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    } else if (acc === "bool") {
      const bits = B.tmp();
      B.line(`${bits} = zext i1 ${value} to i8`);
      B.line(`store i8 ${bits}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    } else if (kind === "cref") {
      const ref = B.tmp();
      for (const line of compactRefStoreLines(value, ref, `${ref}.r`)) B.line(line.trimStart());
      B.line(`store i32 ${ref}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    } else {
      B.line(`store ptr ${value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    }
  };
  if ((acc === "f64" || kind === "ref") && host.mayHoldForeign(element)) {
    // Past the hole-free prefix a slot may hold a foreign element, whose
    // value the runtime setter releases; below it every slot is a value.
    B.br(slow);
    B.startBlock(filledLabel);
    const filledValuePtr = valuePointer(host, guard, kind);
    let filledOld: string | null = null;
    if (kind === "ref") {
      filledOld = B.tmp();
      B.line(
        `${filledOld} = load ptr, ptr ${filledValuePtr}${host.fieldAliasAttachment(filledValuePtr)}`,
      );
    }
    storeValue(filledValuePtr);
    if (filledOld) host.releaseHeap(filledOld, element);
    B.br(join);
    B.startBlock(slow);
    call(" cold");
    B.br(join);
    B.startBlock(join);
    return;
  }
  const stated = B.newLabel("arr.set.states"),
    plain = B.newLabel("arr.set.plain"),
    plainStore = B.newLabel("arr.set.values"),
    stored = B.newLabel("arr.set.stored.slot");
  B.condBr(emitArrayHasStates(host, array), stated, plain);
  B.startBlock(stated);
  const statePtr = statePointer(host, guard);
  const valuePtr = valuePointer(host, guard, kind);
  let statedOld: string | null = null;
  let statedHad: string | null = null;
  // Compact instances are never released: a replaced one needs nothing.
  if (kind === "ref") {
    const oldState = B.tmp();
    statedOld = B.tmp();
    statedHad = B.tmp();
    B.line(`${oldState} = load i8, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
    B.line(`${statedOld} = load ptr, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
    B.line(`${statedHad} = icmp eq i8 ${oldState}, ${SCR_ARR_VALUE}`);
  }
  storeValue(valuePtr);
  B.line(`store i8 ${SCR_ARR_VALUE}, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
  const statedEnd = B.currentLabel();
  B.br(stored);
  // Without states the bound is the length, so a store here appends at
  // the length (it replaces no value) or leaves holes, which the runtime
  // gives states.
  B.startBlock(plain);
  const appends = B.tmp();
  B.line(`${appends} = icmp eq ${host.sizeType} ${offset}, ${len}`);
  B.condBr(appends, plainStore, slow);
  B.startBlock(plainStore);
  storeValue(valuePointer(host, guard, kind));
  const plainEnd = B.currentLabel();
  B.br(stored);
  B.startBlock(stored);
  let old: string | null = null;
  let hadValue: string | null = null;
  if (kind === "ref") {
    old = B.tmp();
    hadValue = B.tmp();
    B.line(`${old} = phi ptr [ ${statedOld}, %${statedEnd} ], [ null, %${plainEnd} ]`);
    B.line(`${hadValue} = phi i1 [ ${statedHad}, %${statedEnd} ], [ false, %${plainEnd} ]`);
  }
  // A store at the bound continues the hole-free prefix.
  const filledWide = sizedFilled(host, guard.filled),
    continues = B.tmp();
  B.line(`${continues} = icmp eq ${host.sizeType} ${offset}, ${filledWide}`);
  const bumpLabel = B.newLabel("arr.set.bump"),
    afterBump = B.newLabel("arr.set.state");
  B.condBr(continues, bumpLabel, afterBump);
  B.startBlock(bumpLabel);
  // The new bound comes from the index, not from the loaded bound: a loop
  // of appending stores then carries no store-to-load chain through it.
  let index32 = offset;
  if (host.sizeType === "i64") {
    index32 = B.tmp();
    B.line(`${index32} = trunc i64 ${offset} to i32`);
  }
  const nextFilled = B.tmp(),
    filledPtr = B.tmp();
  B.line(`${nextFilled} = add i32 ${index32}, 1`);
  B.line(
    `${filledPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${SCR_ARR_FIELD.filled}`,
  );
  host.markMemoryPointer(filledPtr, "array:header");
  B.line(`store i32 ${nextFilled}, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
  B.br(afterBump);
  B.startBlock(afterBump);
  // Writes at or past the length extend it over the (hole) gap, exactly
  // like the runtime's dense store.
  const grows = B.tmp();
  B.line(`${grows} = icmp uge ${host.sizeType} ${offset}, ${len}`);
  const growLabel = B.newLabel("arr.set.grow"),
    storedLabel = B.newLabel("arr.set.stored");
  B.condBr(grows, growLabel, storedLabel);
  B.startBlock(growLabel);
  const nextLen = B.tmp(),
    lenPtr = B.tmp();
  B.line(`${nextLen} = add ${host.sizeType} ${offset}, 1`);
  B.line(
    `${lenPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${SCR_ARR_FIELD.len}`,
  );
  host.markMemoryPointer(lenPtr, "array:header");
  storeArrCount(host, nextLen, lenPtr, host.fieldAliasAttachment(lenPtr));
  B.br(storedLabel);
  B.startBlock(storedLabel);
  if (kind === "ref" && hadValue && old) {
    const releaseLabel = B.newLabel("arr.set.release");
    B.condBr(hadValue, releaseLabel, join);
    B.startBlock(releaseLabel);
    host.releaseHeap(old, element);
  }
  B.br(join);
  // Below the bound the slot holds a present value: replace it, leaving
  // the state alone, and release a replaced reference after the store.
  B.startBlock(filledLabel);
  const filledValuePtr = valuePointer(host, guard, kind);
  let filledOld: string | null = null;
  if (kind === "ref") {
    filledOld = B.tmp();
    B.line(
      `${filledOld} = load ptr, ptr ${filledValuePtr}${host.fieldAliasAttachment(filledValuePtr)}`,
    );
  }
  storeValue(filledValuePtr);
  if (filledOld) host.releaseHeap(filledOld, element);
  B.br(join);
  B.startBlock(slow);
  call(" cold");
  B.br(join);
  B.startBlock(join);
}

/** The dense half of `pop`. An empty array branches to `empty` (the
 * runtime's pop returns a hole state there and changes nothing). When the
 * hole-free prefix bound equals the length, the last element is a present
 * value in dense storage, and the runtime's pop is exactly: clear its slot
 * and state, lower the bound and the length to its index, and move the
 * slot out. That block is left open and its slot bits are returned as an
 * i64 (a boolean's 0 or 1, zero-extended); every other array branches to
 * `slow`, which keeps the runtime call. */
export function emitDenseArrayPop(
  host: LlvmEmitterContext,
  array: string,
  acc: ArrayAccess,
  element: IrType,
  empty: string,
  slow: string,
): string {
  const B = host.B;
  const kind = slotKind(host, acc, element);
  const size = host.sizeType;
  const header = (field: number): string => {
    const ptr = B.tmp();
    B.line(`${ptr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${field}`);
    host.markMemoryPointer(ptr, "array:header");
    return ptr;
  };
  const lenPtr = header(SCR_ARR_FIELD.len),
    len = B.tmp(),
    none = B.tmp();
  loadArrCount(host, len, lenPtr, host.fieldAliasAttachment(lenPtr));
  B.line(`${none} = icmp eq ${size} ${len}, 0`);
  const check = B.newLabel("arr.pop.check"),
    dense = B.newLabel("arr.pop.dense");
  B.condBr(none, empty, check);
  B.startBlock(check);
  const filledPtr = header(SCR_ARR_FIELD.filled),
    filled = B.tmp(),
    packed = B.tmp();
  B.line(`${filled} = load i32, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
  B.line(`${packed} = icmp eq ${size} ${sizedFilled(host, filled)}, ${len}`);
  B.condBr(packed, dense, slow);
  B.startBlock(dense);
  const last = B.tmp();
  B.line(`${last} = sub nuw ${size} ${len}, 1`);
  // A packed array's last index is below its capacity (filled <= cap).
  const dataPtr = header(SCR_ARR_FIELD.data),
    data = B.tmp(),
    capPtr = header(SCR_ARR_FIELD.cap),
    cap = B.tmp(),
    states = B.tmp();
  B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
  loadArrCount(host, cap, capPtr, host.fieldAliasAttachment(capPtr));
  scrArrStates(host, states, data, cap, slotWidth(kind));
  const valuePtr = valuePointer(host, { offset: last, data }, kind);
  const statePtr = statePointer(host, { offset: last, states });
  const slotTy = slotType(kind);
  let raw = B.tmp();
  B.line(`${raw} = load ${slotTy}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  if (slotTy === "i8") {
    const wide = B.tmp();
    B.line(`${wide} = zext i8 ${raw} to i64`);
    raw = wide;
  } else if (slotTy === "i32") {
    if (kind === "cref") {
      // The 8-byte slot of a compact reference is its address.
      const wide = B.tmp(),
        address = B.tmp();
      B.line(`${wide} = zext i32 ${raw} to i64`);
      B.line(`${address} = shl nuw nsw i64 ${wide}, 3`);
      raw = address;
    } else {
      // The slot bits of an int32 element's double, as the f64 path returns them.
      const number = B.tmp(),
        bits = B.tmp();
      B.line(`${number} = sitofp i32 ${raw} to double`);
      B.line(`${bits} = bitcast double ${number} to i64`);
      raw = bits;
    }
  }
  B.line(`store ${slotTy} 0, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  // Only an array with states has a state byte to clear.
  const clear = B.newLabel("arr.pop.state"),
    cleared = B.newLabel("arr.pop.cleared");
  B.condBr(emitArrayHasStates(host, array), clear, cleared);
  B.startBlock(clear);
  B.line(`store i8 0, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
  B.br(cleared);
  B.startBlock(cleared);
  let last32 = last;
  if (size === "i64") {
    last32 = B.tmp();
    B.line(`${last32} = trunc i64 ${last} to i32`);
  }
  B.line(`store i32 ${last32}, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
  B.line(`store i32 ${last32}, ptr ${lenPtr}${host.fieldAliasAttachment(lenPtr)}`);
  return raw;
}

/** `scr_arr_push_*` (the array takes the value's reference) returning the
 * new length as a double. When `len < cap` the runtime's append is exactly
 * a dense store at `len` plus `len + 1`: no sparse entry can exist past the
 * length, nothing is released, and the dense capacity never exceeds the
 * maximum index. A full array takes the unchanged (cold) runtime call,
 * which grows storage. */
export function emitDenseArrayPush(
  host: LlvmEmitterContext,
  array: string,
  acc: ArrayAccess,
  element: IrType | null,
  value: string,
): string {
  const B = host.B;
  const size = host.sizeType;
  const kind = element === null ? acc : slotKind(host, acc, element);
  const ty = valueType(acc);
  const pusher = `scr_arr_push_${runtimeAccess(acc)}`;
  host.declare(`declare double @${pusher}(ptr, ${acc === "bool" ? "i1 zeroext" : ty})`);
  const header = (field: number): string => {
    const ptr = B.tmp();
    B.line(`${ptr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${field}`);
    host.markMemoryPointer(ptr, "array:header");
    return ptr;
  };
  const lenPtr = header(SCR_ARR_FIELD.len),
    len = B.tmp(),
    cap = B.tmp(),
    room = B.tmp();
  loadArrCount(host, len, lenPtr, host.fieldAliasAttachment(lenPtr));
  const capPtr = header(SCR_ARR_FIELD.cap);
  loadArrCount(host, cap, capPtr, host.fieldAliasAttachment(capPtr));
  B.line(`${room} = icmp ult ${size} ${len}, ${cap}`);
  const fast = B.newLabel("arr.push.dense"),
    slow = B.newLabel("arr.push.slow"),
    join = B.newLabel("arr.push.join");
  B.condBr(room, fast, slow);
  B.startBlock(fast);
  const dataPtr = header(SCR_ARR_FIELD.data),
    data = B.tmp(),
    spare = B.tmp(),
    near = B.tmp(),
    statePtr = B.tmp();
  B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
  // The state of slot `len` is data + width * cap + (cap - len) - 1. With
  // `cap - len` formed first, the store addresses it from one register sum.
  B.line(`${spare} = sub nuw ${size} ${cap}, ${len}`);
  B.line(`${near} = getelementptr inbounds i8, ptr ${data}, ${size} ${spare}`);
  B.line(
    `${statePtr} = getelementptr inbounds [${slotWidth(kind)} x i8], ptr ${near}, ${size} ${cap}, ${size} -1`,
  );
  host.markMemoryPointer(statePtr, "array:present");
  const valuePtr = valuePointer(host, { offset: len, data }, kind);
  if (acc === "f64") {
    B.line(`store double ${value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  } else if (acc === "i32") {
    const int32 = B.tmp();
    B.line(`${int32} = fptosi double ${value} to i32`);
    B.line(`store i32 ${int32}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  } else if (acc === "bool") {
    const bits = B.tmp();
    B.line(`${bits} = zext i1 ${value} to i8`);
    B.line(`store i8 ${bits}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  } else if (kind === "cref") {
    const ref = B.tmp();
    for (const line of compactRefStoreLines(value, ref, `${ref}.r`)) B.line(line.trimStart());
    B.line(`store i32 ${ref}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  } else {
    B.line(`store ptr ${value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  }
  // Only an array with states has a state byte to mark.
  const mark = B.newLabel("arr.push.state"),
    marked = B.newLabel("arr.push.marked");
  B.condBr(emitArrayHasStates(host, array), mark, marked);
  B.startBlock(mark);
  B.line(`store i8 ${SCR_ARR_VALUE}, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
  B.br(marked);
  B.startBlock(marked);
  const next = B.tmp(),
    fastValue = B.tmp();
  B.line(`${next} = add nuw ${size} ${len}, 1`);
  storeArrCount(host, next, lenPtr, host.fieldAliasAttachment(lenPtr));
  // An append to a hole-free array keeps it hole-free.
  const filledPtr = header(SCR_ARR_FIELD.filled),
    filled = B.tmp(),
    packed = B.tmp(),
    nextFilled = B.tmp(),
    bumped = B.tmp();
  B.line(`${filled} = load i32, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
  const filledWide = sizedFilled(host, filled);
  B.line(`${packed} = icmp eq ${size} ${filledWide}, ${len}`);
  B.line(`${nextFilled} = add i32 ${filled}, 1`);
  B.line(`${bumped} = select i1 ${packed}, i32 ${nextFilled}, i32 ${filled}`);
  B.line(`store i32 ${bumped}, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
  B.line(`${fastValue} = ${sizeToDouble(size)} ${size} ${next} to double`);
  const fastEnd = B.currentLabel();
  B.br(join);
  B.startBlock(slow);
  const slowValue = B.tmp();
  B.line(`${slowValue} = call double @${pusher}(ptr ${array}, ${ty} ${value}) cold`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi double [ ${fastValue}, %${fastEnd} ], [ ${slowValue}, %${slow} ]`);
  return result;
}
