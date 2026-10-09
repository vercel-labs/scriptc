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
 * match the C layout in scr_runtime.h: len 1, cap 2, data 7, present 8. */

import { isRefCounted, type IrExpr, type IrType } from "../../ir/ir.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { exactInteger, widenInteger } from "./integer-values.js";

const SCR_ARR_VALUE = 1;

/** Call-site effects of the non-retaining read fallbacks: they only read
 * module-visible memory, or trap without returning to the caller (the trap
 * writes runtime-private stderr/TLS state). Declaring this lets LLVM keep
 * array header loads out of loops whose only calls are these cold paths. */
const READ_FALLBACK = " cold memory(read, inaccessiblemem: readwrite)";

interface DenseGuard {
  /** The checked dense offset, in the target's size type. */
  offset: string;
  /** The array length loaded by the guard, in the target's size type. */
  len: string;
  /** Dense value and state storage base pointers. */
  data: string;
  states: string;
}

/** Branch to `slow` unless `index` names a canonical array index inside
 * dense storage. Reads also require it below the length; writes may land
 * at or past the length while still inside the dense capacity (the runtime
 * then extends the length over hole states exactly the same way). */
function emitDenseGuard(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  slow: string,
  requireBelowLen: boolean,
): DenseGuard {
  const B = host.B;
  const size = host.sizeType;
  const integer = exactInteger(host, index, indexExpr);
  let wide: string;
  let integral: string | null = null;
  if (integer) {
    // A proven integer needs no double round-trip. Negative signed values
    // compare above any length or capacity as unsigned 64-bit integers.
    wide = widenInteger(host, integer);
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
    cap = B.tmp();
  B.line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 1`);
  host.markMemoryPointer(lenPtr, "array:header");
  B.line(`${len} = load ${size}, ptr ${lenPtr}${host.fieldAliasAttachment(lenPtr)}`);
  B.line(`${capPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 2`);
  host.markMemoryPointer(capPtr, "array:header");
  B.line(`${cap} = load ${size}, ptr ${capPtr}${host.fieldAliasAttachment(capPtr)}`);
  // Load the storage bases before branching: the header of a live array is
  // always readable, and unconditional loads let LLVM hoist them out of
  // loops whose only calls are read-only fallbacks.
  const dataPtr = B.tmp(),
    data = B.tmp(),
    statesPtr = B.tmp(),
    states = B.tmp();
  B.line(`${dataPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 7`);
  host.markMemoryPointer(dataPtr, "array:header");
  B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
  B.line(`${statesPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 8`);
  host.markMemoryPointer(statesPtr, "array:header");
  B.line(`${states} = load ptr, ptr ${statesPtr}${host.fieldAliasAttachment(statesPtr)}`);
  const widen = (value: string): string => {
    if (size === "i64") return value;
    const t = B.tmp();
    B.line(`${t} = zext i32 ${value} to i64`);
    return t;
  };
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
  let offset = wide;
  if (size !== "i64") {
    offset = B.tmp();
    B.line(`${offset} = trunc i64 ${wide} to i32`);
  }
  return { offset, len, data, states };
}

function statePointer(host: LlvmEmitterContext, guard: DenseGuard): string {
  const B = host.B;
  const statePtr = B.tmp();
  B.line(
    `${statePtr} = getelementptr inbounds i8, ptr ${guard.states}, ${host.sizeType} ${guard.offset}`,
  );
  host.markMemoryPointer(statePtr, "array:present");
  return statePtr;
}

function valuePointer(host: LlvmEmitterContext, guard: DenseGuard): string {
  const B = host.B;
  const valuePtr = B.tmp();
  B.line(
    `${valuePtr} = getelementptr inbounds i64, ptr ${guard.data}, ${host.sizeType} ${guard.offset}`,
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

export type ArrayAccess = "f64" | "bool" | "ref";

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
): string {
  const B = host.B;
  const ty = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
  const ret = acc === "bool" ? "zeroext i1" : ty;
  host.declare(`declare ${ret} @${getter}(ptr, double)`);
  if (acc === "ref" && retain && !isRefCounted(element)) {
    const t = B.tmp();
    B.line(`${t} = call ${ty} @${getter}(ptr ${array}, double ${index.name})`);
    return t;
  }
  const slow = B.newLabel("arr.get.slow"),
    join = B.newLabel("arr.get.join");
  const guard = emitDenseGuard(host, array, index, indexExpr, slow, true);
  const state = loadState(host, guard);
  const present = B.tmp();
  B.line(`${present} = icmp eq i8 ${state}, ${SCR_ARR_VALUE}`);
  const valueLabel = B.newLabel("arr.get.value");
  B.condBr(present, valueLabel, slow);
  B.startBlock(valueLabel);
  const ptr = valuePointer(host, guard);
  let fast: string;
  let fastLabel = valueLabel;
  if (acc === "f64") {
    fast = B.tmp();
    B.line(`${fast} = load double, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
  } else if (acc === "bool") {
    const raw = B.tmp();
    fast = B.tmp();
    B.line(`${raw} = load i64, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
    B.line(`${fast} = icmp ne i64 ${raw}, 0`);
  } else {
    const raw = B.tmp(),
      nonnull = B.tmp();
    B.line(`${raw} = load ptr, ptr ${ptr}${host.fieldAliasAttachment(ptr)}`);
    B.line(`${nonnull} = icmp ne ptr ${raw}, null`);
    fastLabel = B.newLabel("arr.get.ref");
    B.condBr(nonnull, fastLabel, slow);
    B.startBlock(fastLabel);
    fast = retain ? host.retainValue(raw, element) : raw;
  }
  B.br(join);
  B.startBlock(slow);
  const slowValue = B.tmp();
  const attrs = acc === "ref" && retain ? " cold" : READ_FALLBACK;
  B.line(`${slowValue} = call ${ty} @${getter}(ptr ${array}, double ${index.name})${attrs}`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ${ty} [ ${fast}, %${fastLabel} ], [ ${slowValue}, %${slow} ]`);
  return result;
}

/** `scr_arr_get_number`: a numeric element, or NaN for every missing,
 * hole, or present-undefined slot (answered by the runtime). */
export function emitDenseArrayNumber(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
): string {
  return emitDenseArrayGet(
    host,
    array,
    index,
    indexExpr,
    "f64",
    { kind: "f64" },
    "scr_arr_get_number",
    false,
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
): string {
  const B = host.B;
  const fn = kind === "state" ? "scr_arr_state" : "scr_arr_has";
  const ty = kind === "state" ? "double" : "i1";
  host.declare(`declare ${kind === "state" ? "double" : "zeroext i1"} @${fn}(ptr, double)`);
  const slow = B.newLabel("arr.state.slow"),
    join = B.newLabel("arr.state.join");
  const guard = emitDenseGuard(host, array, index, indexExpr, slow, true);
  const state = loadState(host, guard);
  const fast = B.tmp();
  if (kind === "state") B.line(`${fast} = uitofp i8 ${state} to double`);
  else B.line(`${fast} = icmp ne i8 ${state}, 0`);
  const fastLabel = B.newLabel("arr.state.fast");
  B.br(fastLabel);
  B.startBlock(fastLabel);
  B.br(join);
  B.startBlock(slow);
  const slowValue = B.tmp();
  B.line(`${slowValue} = call ${ty} @${fn}(ptr ${array}, double ${index.name})${READ_FALLBACK}`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi ${ty} [ ${fast}, %${fastLabel} ], [ ${slowValue}, %${slow} ]`);
  return result;
}

/** Element write with `scr_arr_set_*` semantics: the array takes the
 * value's reference. A dense index stores the slot, marks it present, and
 * extends the length when it lands at or past it; a replaced present
 * reference is released after the new edge is published (a release can
 * collect cycles). Every other index takes the unchanged runtime call. */
export function emitDenseArraySet(
  host: LlvmEmitterContext,
  array: string,
  index: LlValue,
  indexExpr: IrExpr | undefined,
  acc: ArrayAccess,
  element: IrType,
  value: string,
): void {
  const B = host.B;
  const ty = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
  const setter = `scr_arr_set_${acc}`;
  host.declare(`declare void @${setter}(ptr, double, ${acc === "bool" ? "i1 zeroext" : ty})`);
  const call = (attrs: string): void =>
    B.line(`call void @${setter}(ptr ${array}, double ${index.name}, ${ty} ${value})${attrs}`);
  if (acc === "ref" && !isRefCounted(element)) {
    call("");
    return;
  }
  const slow = B.newLabel("arr.set.slow"),
    join = B.newLabel("arr.set.join");
  const guard = emitDenseGuard(host, array, index, indexExpr, slow, false);
  const { offset, len } = guard;
  const statePtr = statePointer(host, guard);
  const valuePtr = valuePointer(host, guard);
  let oldState: string | null = null;
  let old: string | null = null;
  if (acc === "ref") {
    oldState = B.tmp();
    old = B.tmp();
    B.line(`${oldState} = load i8, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
    B.line(`${old} = load ptr, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  }
  if (acc === "f64") {
    B.line(`store double ${value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  } else if (acc === "bool") {
    const bits = B.tmp();
    B.line(`${bits} = zext i1 ${value} to i64`);
    B.line(`store i64 ${bits}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  } else {
    B.line(`store ptr ${value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  }
  B.line(`store i8 ${SCR_ARR_VALUE}, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
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
  B.line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 1`);
  host.markMemoryPointer(lenPtr, "array:header");
  B.line(`store ${host.sizeType} ${nextLen}, ptr ${lenPtr}${host.fieldAliasAttachment(lenPtr)}`);
  B.br(storedLabel);
  B.startBlock(storedLabel);
  if (acc === "ref" && oldState && old) {
    const hadValue = B.tmp();
    B.line(`${hadValue} = icmp eq i8 ${oldState}, ${SCR_ARR_VALUE}`);
    const releaseLabel = B.newLabel("arr.set.release");
    B.condBr(hadValue, releaseLabel, join);
    B.startBlock(releaseLabel);
    host.releaseValue(old, element);
  }
  B.br(join);
  B.startBlock(slow);
  call(" cold");
  B.br(join);
  B.startBlock(join);
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
  value: string,
): string {
  const B = host.B;
  const size = host.sizeType;
  const ty = acc === "f64" ? "double" : acc === "bool" ? "i1" : "ptr";
  const pusher = `scr_arr_push_${acc}`;
  host.declare(`declare double @${pusher}(ptr, ${acc === "bool" ? "i1 zeroext" : ty})`);
  const header = (field: number): string => {
    const ptr = B.tmp();
    B.line(`${ptr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${field}`);
    host.markMemoryPointer(ptr, "array:header");
    return ptr;
  };
  const lenPtr = header(1),
    len = B.tmp(),
    cap = B.tmp(),
    room = B.tmp();
  B.line(`${len} = load ${size}, ptr ${lenPtr}${host.fieldAliasAttachment(lenPtr)}`);
  const capPtr = header(2);
  B.line(`${cap} = load ${size}, ptr ${capPtr}${host.fieldAliasAttachment(capPtr)}`);
  B.line(`${room} = icmp ult ${size} ${len}, ${cap}`);
  const fast = B.newLabel("arr.push.dense"),
    slow = B.newLabel("arr.push.slow"),
    join = B.newLabel("arr.push.join");
  B.condBr(room, fast, slow);
  B.startBlock(fast);
  const dataPtr = header(7),
    data = B.tmp(),
    statesPtr = header(8),
    states = B.tmp();
  B.line(`${data} = load ptr, ptr ${dataPtr}${host.fieldAliasAttachment(dataPtr)}`);
  B.line(`${states} = load ptr, ptr ${statesPtr}${host.fieldAliasAttachment(statesPtr)}`);
  const statePtr = statePointer(host, { offset: len, len, data, states });
  const valuePtr = valuePointer(host, { offset: len, len, data, states });
  if (acc === "f64") {
    B.line(`store double ${value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  } else if (acc === "bool") {
    const bits = B.tmp();
    B.line(`${bits} = zext i1 ${value} to i64`);
    B.line(`store i64 ${bits}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  } else {
    B.line(`store ptr ${value}, ptr ${valuePtr}${host.fieldAliasAttachment(valuePtr)}`);
  }
  B.line(`store i8 ${SCR_ARR_VALUE}, ptr ${statePtr}${host.fieldAliasAttachment(statePtr)}`);
  const next = B.tmp(),
    fastValue = B.tmp();
  B.line(`${next} = add nuw ${size} ${len}, 1`);
  B.line(`store ${size} ${next}, ptr ${lenPtr}${host.fieldAliasAttachment(lenPtr)}`);
  B.line(`${fastValue} = uitofp ${size} ${next} to double`);
  B.br(join);
  B.startBlock(slow);
  const slowValue = B.tmp();
  B.line(`${slowValue} = call double @${pusher}(ptr ${array}, ${ty} ${value}) cold`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi double [ ${fastValue}, %${fast} ], [ ${slowValue}, %${slow} ]`);
  return result;
}
