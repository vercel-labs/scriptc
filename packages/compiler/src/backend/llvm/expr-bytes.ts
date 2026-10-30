/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { emitBorrowedInput } from "./borrowed-inputs.js";
import type { BytesHeader } from "./bytes-headers.js";
import { BYTES_ELEMENT_SIZE, F64, type IrBytesElem, type IrExpr } from "../../ir/ir.js";
import type { LlvmEmitterContext, LlValue, OffsetIndex } from "./expr-context.js";
import { F64_INF, exactIndexLines, exactOffsetIndexLines, f64Lit, sizeToDouble } from "./common.js";
import { alwaysExactInteger, exactInteger } from "./integer-values.js";
import { byteNumberAccess } from "../../ir/byte-numbers.js";
import { emitByteNumber } from "./byte-numbers.js";
import { integerOrNaNIndex, integerOrNaNRange } from "./wrapping-sums.js";
import { bytesElementAlias, bytesHeaderAlias, bytesHeaderValueAlias } from "./bytes-alias.js";

const BYTES_NUM_KIND: Record<string, { kind: number; le: boolean } | undefined> = {
  u8: { kind: 0, le: false },
  i8: { kind: 1, le: false },
  u16be: { kind: 2, le: false },
  u16le: { kind: 2, le: true },
  i16be: { kind: 3, le: false },
  i16le: { kind: 3, le: true },
  u32be: { kind: 4, le: false },
  u32le: { kind: 4, le: true },
  i32be: { kind: 5, le: false },
  i32le: { kind: 5, le: true },
  f32be: { kind: 6, le: false },
  f32le: { kind: 6, le: true },
  f64be: { kind: 7, le: false },
  f64le: { kind: 7, le: true },
};

const BYTES_NUM_VAR: Record<string, { sign: boolean; le: boolean } | undefined> = {
  ube: { sign: false, le: false },
  ule: { sign: false, le: true },
  ibe: { sign: true, le: false },
  ile: { sign: true, le: true },
};

const DV_GET_KIND: Record<string, number> = {
  dvGetUint8: 0,
  dvGetInt8: 1,
  dvGetUint16: 2,
  dvGetInt16: 3,
  dvGetUint32: 4,
  dvGetInt32: 5,
  dvGetFloat32: 6,
  dvGetFloat64: 7,
  dvGetBigUint64Number: 8,
  dvGetBigInt64Number: 9,
  dvGetFloat16: 10,
};

const DV_SET_KIND: Record<string, number> = {
  dvSetUint8: 0,
  dvSetInt8: 1,
  dvSetUint16: 2,
  dvSetInt16: 3,
  dvSetUint32: 4,
  dvSetInt32: 5,
  dvSetFloat32: 6,
  dvSetFloat64: 7,
  dvSetFloat16: 10,
};

export function emitIntegerLoopIndex(host: LlvmEmitterContext, expr: IrExpr): string | null {
  if (expr.kind !== "varRef") return null;
  const slot = host.integerLoopBindings.get(expr.localId);
  // A wide counter must not wrap into an in-bounds index on a 32-bit
  // target. Use the ordinary checked double path when widths differ.
  if (
    slot === undefined ||
    slot.type !== host.sizeType ||
    (slot.signed && (!slot.range || slot.range.min < 0))
  )
    return null;
  const index = host.B.tmp();
  host.B.line(`${index} = load ${host.sizeType}, ptr ${slot.slot}`);
  return index;
}

/** The base and offset of a sum `base + c`, `c + base` or `base - c`,
 * where `base` is a number local and `c` an integer literal of magnitude
 * below 2^31, given the operand values the sum was computed from. Null for
 * other sums. */
export function offsetIndex(expr: IrExpr, left: LlValue, right: LlValue): OffsetIndex | null {
  if (expr.kind !== "bin" || expr.type.kind !== "f64" || (expr.op !== "+" && expr.op !== "-"))
    return null;
  const literal = (e: IrExpr): number | null =>
    e.kind === "numLit" && Number.isInteger(e.value) && Math.abs(e.value) < 2 ** 31
      ? e.value
      : null;
  const local = (e: IrExpr): boolean => e.kind === "varRef" && e.type.kind === "f64";
  const constant = literal(expr.right);
  if (constant !== null && local(expr.left))
    return { base: left.name, offset: expr.op === "+" ? constant : -constant };
  const leading = literal(expr.left);
  if (expr.op === "+" && leading !== null && local(expr.right))
    return { base: right.name, offset: leading };
  return null;
}

export function emitBytesIndex(
  host: LlvmEmitterContext,
  receiver: string,
  value: LlValue,
  expr?: IrExpr,
  skipInvalid?: string,
  inBounds = false,
): string {
  const B = host.B;
  const index = value.name;
  // The exact integer, or a wide view that always equals the double (such
  // as `i + 1` of a speculated counter).
  const exact = alwaysExactInteger(host, value, exactInteger(host, value, expr));
  if (inBounds && exact !== null) {
    if (host.sizeType === "i64") return exact;
    const narrow = B.tmp();
    B.line(`${narrow} = trunc i64 ${exact} to ${host.sizeType}`);
    return narrow;
  }
  const len = emitBytesHeaderLength(host, receiver);
  if (exact !== null) {
    const wideIndex = exact;
    const wideLength = host.sizeType === "i64" ? len : B.tmp();
    if (host.sizeType !== "i64") B.line(`${wideLength} = zext ${host.sizeType} ${len} to i64`);
    const inRange = B.tmp();
    // Negative signed values compare above any length as unsigned. Keep
    // the full index until after this guard on 32-bit targets as well.
    B.line(`${inRange} = icmp ult i64 ${wideIndex}, ${wideLength}`);
    const invalid = B.newLabel("bytes.index.invalid");
    const valid = B.newLabel("bytes.index.valid");
    B.condBr(inRange, valid, invalid);
    B.startBlock(invalid);
    if (skipInvalid) B.br(skipInvalid);
    else {
      host.declare(`declare double @scr_bytes_get(ptr, double)`);
      B.line(`call double @scr_bytes_get(ptr ${receiver}, double ${index})`);
      B.terminate("unreachable");
    }
    B.startBlock(valid);
    if (host.sizeType === "i64") return wideIndex;
    const narrow = B.tmp();
    B.line(`${narrow} = trunc i64 ${wideIndex} to ${host.sizeType}`);
    return narrow;
  }
  let ok: string;
  let wide: string;
  const nanIndex = integerOrNaNIndex(host, value, expr);
  if (nanIndex) {
    // An exact integer or NaN: in range when ordered and below the length.
    const wideLength = host.sizeType === "i64" ? len : B.tmp();
    if (host.sizeType !== "i64") B.line(`${wideLength} = zext ${host.sizeType} ${len} to i64`);
    const below = B.tmp();
    ok = B.tmp();
    B.line(`${below} = icmp ult i64 ${nanIndex.wide}, ${wideLength}`);
    B.line(`${ok} = and i1 ${nanIndex.ordered}, ${below}`);
    wide = nanIndex.wide;
  } else {
    const offset = value.offsetIndex;
    if (offset) {
      const exact = exactOffsetIndexLines(offset.base, offset.offset, len, host.sizeType, () =>
        B.tmp(),
      );
      for (const line of exact.lines) B.line(line);
      // A fractional base: the sum itself decides, as it would without the
      // base's conversion.
      const from = B.currentLabel();
      const sum = B.newLabel("bytes.index.sum");
      const join = B.newLabel("bytes.index.join");
      B.condBr(exact.integral, join, sum);
      B.startBlock(sum);
      const whole = exactIndexLines(index, len, host.sizeType, () => B.tmp());
      for (const line of whole.lines) B.line(line);
      B.br(join);
      B.startBlock(join);
      ok = B.tmp();
      wide = B.tmp();
      B.line(`${ok} = phi i1 [ ${exact.ok}, %${from} ], [ ${whole.ok}, %${sum} ]`);
      B.line(`${wide} = phi i64 [ ${exact.wide}, %${from} ], [ ${whole.wide}, %${sum} ]`);
    } else {
      const exact = exactIndexLines(index, len, host.sizeType, () => B.tmp());
      for (const line of exact.lines) B.line(line);
      ok = exact.ok;
      wide = exact.wide;
    }
  }
  const invalid = B.newLabel("bytes.index.invalid");
  const valid = B.newLabel("bytes.index.valid");
  B.condBr(ok, valid, invalid);
  let idx = wide;

  B.startBlock(invalid);
  if (skipInvalid) B.br(skipInvalid);
  else {
    // No caller-supplied invalid path: never touch storage.
    host.declare(`declare void @llvm.trap()`);
    B.line(`call void @llvm.trap()`);
    B.terminate("unreachable");
  }

  B.startBlock(valid);
  if (host.sizeType !== "i64") {
    idx = B.tmp();
    B.line(`${idx} = trunc i64 ${wide} to ${host.sizeType}`);
  }
  return idx;
}

/** Records that `value` is the view `receiver` reads, so the header reads of
 * an access through it use the values a loop entry read (bytes-headers.ts). */
export function noteBytesReceiver(host: LlvmEmitterContext, receiver: IrExpr, value: string): void {
  const scope = host.bytesHeaders;
  if (scope === null || receiver.kind !== "varRef" || scope.fn !== host.currentFunctionName) return;
  const header = scope.locals.get(receiver.localId);
  if (header !== undefined) scope.values.set(value, header);
}

/** The header fields a loop entry read for the view `receiver`, if any. */
function cachedHeader(host: LlvmEmitterContext, receiver: string): BytesHeader | undefined {
  const scope = host.bytesHeaders;
  if (scope === null || scope.fn !== host.currentFunctionName) return undefined;
  return scope.values.get(receiver);
}

/** The element count of a typed array, in the target's size type. `value`:
 * the program reads the count itself (bytesHeaderValueAlias), rather than
 * only bounding an access. */
export function emitBytesHeaderLength(
  host: LlvmEmitterContext,
  receiver: string,
  value = false,
): string {
  const cached = cachedHeader(host, receiver);
  if (cached !== undefined) return cached.length;
  const p = host.B.tmp();
  const len = host.B.tmp();
  const alias = value ? bytesHeaderValueAlias(host) : bytesHeaderAlias(host);
  host.B.line(`${p} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 1`);
  host.B.line(`${len} = load ${host.sizeType}, ptr ${p}${alias}`);
  return len;
}

export function emitBytesData(host: LlvmEmitterContext, receiver: string): string {
  const cached = cachedHeader(host, receiver);
  if (cached !== undefined) return cached.data;
  const p = host.B.tmp();
  const data = host.B.tmp();
  host.B.line(`${p} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 3`);
  host.B.line(`${data} = load ptr, ptr ${p}${bytesHeaderAlias(host)}`);
  return data;
}

export function emitBytesLength(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  receiver: string,
  bytes: boolean,
): LlValue {
  const B = host.B;
  const len = emitBytesHeaderLength(host, receiver, true);
  const size = BYTES_ELEMENT_SIZE[elem];
  const count = bytes && size !== 1 ? B.tmp() : len;
  if (count !== len) B.line(`${count} = shl ${host.sizeType} ${len}, ${Math.log2(size)}`);
  const out = B.tmp();
  B.line(`${out} = ${sizeToDouble(host.sizeType)} ${host.sizeType} ${count} to double`);
  return { name: out, type: F64 };
}

/** A view's shared backing (null for a buffer this thread owns). It is
 * set at construction, before script code can see the view. */
export function emitBytesSharedStorage(host: LlvmEmitterContext, receiver: string): string {
  const cached = cachedHeader(host, receiver)?.shared;
  if (cached !== undefined && cached !== null) return cached;
  const B = host.B;
  const slot = B.tmp(),
    storage = B.tmp();
  B.line(`${slot} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 9`);
  B.line(`${storage} = load ptr, ptr ${slot}${bytesHeaderAlias(host)}`);
  return storage;
}

/** Worker programs: an element of a view of a SharedArrayBuffer (`shared` is
 * fixed before script code can see the view) is read and written with one
 * relaxed atomic access of its width, as the runtime's shared accessors do;
 * every other buffer belongs to this thread and takes the ordinary path. The test follows the index check: a
 * view's length never changes, so both paths use the one checked integer
 * index. Branches to the returned label for a thread-owned buffer and
 * continues in the shared block. */
function emitSharedBytesSplit(host: LlvmEmitterContext, receiver: string): string {
  const B = host.B;
  host.declare(`declare i1 @llvm.expect.i1(i1, i1)`);
  const storage = emitBytesSharedStorage(host, receiver),
    isShared = B.tmp(),
    expected = B.tmp();
  B.line(`${isShared} = icmp ne ptr ${storage}, null`);
  B.line(`${expected} = call i1 @llvm.expect.i1(i1 ${isShared}, i1 false)`);
  const shared = B.newLabel("bytes.shared"),
    local = B.newLabel("bytes.local");
  B.condBr(expected, shared, local);
  B.startBlock(shared);
  return local;
}

export function emitBytesGet(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  receiver: string,
  index: LlValue,
  expr?: IrExpr,
  inBounds = false,
  invalidNaN = false,
  owned = false,
  scope = "",
): LlValue {
  const outer = host.bytesAccessScope;
  host.bytesAccessScope = scope;
  try {
    return emitScopedBytesGet(host, elem, receiver, index, expr, inBounds, invalidNaN, owned);
  } finally {
    host.bytesAccessScope = outer;
  }
}

function emitScopedBytesGet(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  receiver: string,
  index: LlValue,
  expr: IrExpr | undefined,
  inBounds: boolean,
  invalidNaN: boolean,
  owned: boolean,
): LlValue {
  const B = host.B;
  // Any invalid index traps (the array runtime's discipline).
  if (!invalidNaN)
    return emitBytesLoad(host, elem, receiver, index, expr, inBounds, undefined, owned);
  // The numeric view of an ordinary read: an invalid index never touches
  // storage and reads as NaN — ToNumber of Node's undefined.
  const invalid = B.newLabel("bytes.read.invalid");
  const done = B.newLabel("bytes.read.done");
  const loaded = emitBytesLoad(host, elem, receiver, index, expr, inBounds, invalid, owned);
  const ok = B.newLabel("bytes.read.ok");
  B.br(ok);
  B.startBlock(ok);
  B.br(done);
  B.startBlock(invalid);
  B.br(done);
  B.startBlock(done);
  const out = B.tmp();
  if (loaded.uint32 === undefined) {
    B.line(`${out} = phi double [ ${loaded.name}, %${ok} ], [ ${f64Lit(NaN)}, %${invalid} ]`);
    return { name: out, type: F64 };
  }
  // The hint is ToUint32 of the value, and ToUint32(NaN) is 0, so it holds
  // for an invalid index too. Integer ranges (which would claim more) are
  // never derived for NaN-coded reads.
  //
  // An integer element joins as an integer and a validity bit, and the
  // number converts after the join. A join of the numbers, `phi [sitofp x,
  // NaN]`, hides the integer from LLVM: compares of the number stay floating,
  // and once `| 0` makes the NaN arm 0, InstCombine moves the conversion into
  // that join (`phi [sitofp x, 0.0]`) and never folds it back. Converting
  // the joined integer gives it two users (this conversion and the ToUint32
  // consumers), so a compare of `x | 0` stays an integer compare.
  const u32 = B.tmp(),
    valid = B.tmp(),
    number = B.tmp();
  B.line(`${u32} = phi i32 [ ${loaded.uint32}, %${ok} ], [ 0, %${invalid} ]`);
  B.line(`${valid} = phi i1 [ true, %${ok} ], [ false, %${invalid} ]`);
  const signed = elem === "i8" || elem === "i16" || elem === "i32";
  B.line(`${number} = ${signed ? "sitofp" : "uitofp"} i32 ${u32} to double`);
  B.line(`${out} = select i1 ${valid}, double ${number}, double ${f64Lit(NaN)}`);
  const integer = B.tmp();
  B.line(`${integer} = ${signed ? "sext" : "zext"} i32 ${u32} to i64`);
  return { name: out, type: F64, uint32: u32, ordered: valid, nanInteger: integer };
}

function emitBytesLoad(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  receiver: string,
  index: LlValue,
  expr: IrExpr | undefined,
  inBounds: boolean,
  invalid: string | undefined,
  owned: boolean,
): LlValue {
  // `owned`: an enclosing version guard proved the view thread-owned.
  if (host.mod.workers && !owned && !plainSharedElement(host, elem, expr)) {
    const idx = emitBytesIndex(host, receiver, index, expr, invalid, inBounds);
    return emitSharedOrLocalLoad(host, elem, receiver, idx);
  }
  // The header is immutable, so the data pointer loads beside the length,
  // ahead of the bounds branch: an unconditional load LICM can hoist.
  const data = host.emitBytesData(receiver);
  const idx = emitBytesIndex(host, receiver, index, expr, invalid, inBounds);
  return emitBytesLoadAt(host, elem, data, idx);
}

/** Worker programs: whether an element access at `index` of a view that
 * may be shared is a plain load or store, like a thread-owned view's. It is
 * when the index is the counter of the strip-mined counted loop whose body
 * holds the access, outside any loop nested in that body (its condition and
 * update included: a nested loop that waits on the element reads it on
 * every iteration, so the read stays atomic): every iteration then reaches
 * a different element, so LLVM cannot merge an element's reads across
 * iterations or move them out of the loop, and the loop can be vectorized. A racing write from another thread can still be seen or
 * missed within one iteration, the documented gap of non-atomic shared
 * accesses. Float16 elements keep their runtime path. */
function plainSharedElement(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  index: IrExpr | undefined,
): boolean {
  const loop = host.plainSharedLoop;
  if (loop === null || elem === "f16" || index?.kind !== "varRef") return false;
  // A nested loop raises loopDepth before its condition is emitted.
  if (index.localId !== loop.counter || host.loopDepth !== loop.depth) return false;
  let innermost: (typeof host.jumpTargets)[number] | undefined;
  for (let i = host.jumpTargets.length - 1; i >= 0 && innermost === undefined; i--)
    if (host.jumpTargets[i]!.kind === "loop") innermost = host.jumpTargets[i];
  return innermost === loop.target;
}

/** Worker programs: the element at a checked index of a view that may be
 * shared. An integer element joins as its 32-bit value and converts to a
 * number after the join, as the local load does, so compares and
 * ToInt32/ToUint32 of the result stay integer operations. The shared read
 * is a monotonic atomic load, which LLVM neither hoists nor merges: another
 * thread's write stays visible to a loop that reads the same element again.
 * Float16 elements read through the runtime. */
function emitSharedOrLocalLoad(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  receiver: string,
  idx: string,
): LlValue {
  const B = host.B;
  const floating = elem === "f16" || elem === "f32" || elem === "f64";
  const local = emitSharedBytesSplit(host, receiver);
  let shared: string;
  if (elem === "f16") {
    host.declare(`declare double @scr_bytes_shared_get_f64(ptr, ${host.sizeType})`);
    shared = B.tmp();
    B.line(
      `${shared} = call double @scr_bytes_shared_get_f64(ptr ${receiver}, ${host.sizeType} ${idx}) cold`,
    );
  } else {
    const loaded = emitSharedLoadAt(host, elem, host.emitBytesData(receiver), idx);
    shared = loaded.uint32 ?? loaded.name;
  }
  const sharedDone = B.newLabel("bytes.shared.done");
  B.br(sharedDone);
  B.startBlock(local);
  const own = emitBytesLoadAt(host, elem, host.emitBytesData(receiver), idx);
  const localDone = B.newLabel("bytes.local.done");
  B.br(localDone);
  B.startBlock(localDone);
  const join = B.newLabel("bytes.join");
  B.br(join);
  B.startBlock(sharedDone);
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  if (floating) {
    B.line(`${out} = phi double [ ${own.name}, %${localDone} ], [ ${shared}, %${sharedDone} ]`);
    return { name: out, type: F64 };
  }
  const u32 = B.tmp();
  B.line(`${u32} = phi i32 [ ${own.uint32!}, %${localDone} ], [ ${shared}, %${sharedDone} ]`);
  const signed = elem === "i8" || elem === "i16" || elem === "i32";
  B.line(`${out} = ${signed ? "sitofp" : "uitofp"} i32 ${u32} to double`);
  return { name: out, type: F64, uint32: u32 };
}

/** The element at a checked index of a shared view, given its data pointer:
 * a relaxed atomic load of the element's width, aligned as shared views
 * are. Not for Float16 elements. */
function emitSharedLoadAt(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  data: string,
  idx: string,
): LlValue {
  const B = host.B;
  const size = BYTES_ELEMENT_SIZE[elem];
  const p = B.tmp();
  if (elem === "f32" || elem === "f64") {
    const ty = elem === "f32" ? "float" : "double";
    const raw = B.tmp();
    B.line(`${p} = getelementptr inbounds ${ty}, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`${raw} = load atomic ${ty}, ptr ${p} monotonic, align ${size}`);
    if (elem === "f64") return { name: raw, type: F64 };
    const out = B.tmp();
    B.line(`${out} = fpext float ${raw} to double`);
    return { name: out, type: F64 };
  }
  const bits = size * 8;
  const raw = B.tmp();
  B.line(`${p} = getelementptr inbounds i${bits}, ptr ${data}, ${host.sizeType} ${idx}`);
  B.line(`${raw} = load atomic i${bits}, ptr ${p} monotonic, align ${size}`);
  const signed = elem === "i8" || elem === "i16" || elem === "i32";
  let wide = raw;
  if (bits < 32) {
    wide = B.tmp();
    B.line(`${wide} = ${signed ? "sext" : "zext"} i${bits} ${raw} to i32`);
  }
  const out = B.tmp();
  B.line(`${out} = ${signed ? "sitofp" : "uitofp"} i32 ${wide} to double`);
  return { name: out, type: F64, uint32: wide };
}

/** The element at a checked index of a thread-owned view, given its data
 * pointer. */
function emitBytesLoadAt(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  data: string,
  idx: string,
): LlValue {
  const B = host.B;
  const p = B.tmp();
  if (elem === "f16") {
    // Half-precision bits widen exactly; the runtime converts them.
    host.declare(`declare double @scr_f16_to_f64(i16 zeroext)`);
    const raw = B.tmp();
    const out = B.tmp();
    B.line(`${p} = getelementptr inbounds i16, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`${raw} = load i16, ptr ${p}, align 1${bytesElementAlias(host)}`);
    B.line(`${out} = call double @scr_f16_to_f64(i16 zeroext ${raw})`);
    return { name: out, type: F64 };
  }
  if (BYTES_ELEMENT_SIZE[elem] < 4) {
    const bits = BYTES_ELEMENT_SIZE[elem] * 8;
    const signed = elem === "i8" || elem === "i16";
    const raw = B.tmp();
    const wide = B.tmp();
    const out = B.tmp();
    B.line(`${p} = getelementptr inbounds i${bits}, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`${raw} = load i${bits}, ptr ${p}, align 1${bytesElementAlias(host)}`);
    B.line(`${wide} = ${signed ? "sext" : "zext"} i${bits} ${raw} to i32`);
    B.line(`${out} = ${signed ? "sitofp" : "uitofp"} i32 ${wide} to double`);
    return { name: out, type: F64, uint32: wide };
  }
  if (elem === "f32") {
    const raw = B.tmp();
    const out = B.tmp();
    B.line(`${p} = getelementptr inbounds float, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`${raw} = load float, ptr ${p}, align 1${bytesElementAlias(host)}`);
    B.line(`${out} = fpext float ${raw} to double`);
    return { name: out, type: F64 };
  }
  if (elem === "f64") {
    const out = B.tmp();
    B.line(`${p} = getelementptr inbounds double, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`${out} = load double, ptr ${p}, align 1${bytesElementAlias(host)}`);
    return { name: out, type: F64 };
  }
  const raw = B.tmp();
  const out = B.tmp();
  B.line(`${p} = getelementptr inbounds i32, ptr ${data}, ${host.sizeType} ${idx}`);
  B.line(`${raw} = load i32, ptr ${p}, align 1${bytesElementAlias(host)}`);
  B.line(`${out} = ${elem === "i32" ? "sitofp" : "uitofp"} i32 ${raw} to double`);
  return { name: out, type: F64, uint32: raw };
}

export function emitToUint32(
  host: LlvmEmitterContext,
  value: string,
  expr?: IrExpr,
  uint32?: string,
): string {
  if (uint32 !== undefined) return uint32;
  const B = host.B;
  if (expr && host.integerRanges.get(expr)) {
    const integer = B.tmp();
    const out = B.tmp();
    B.line(`${integer} = fptosi double ${value} to i64`);
    B.line(`${out} = trunc i64 ${integer} to i32`);
    return out;
  }
  if (expr && integerOrNaNRange(host, expr)) {
    // An exact integer or NaN (an Int32[] or typed-array element read that
    // may miss, `charCodeAt`): the integer's low 32 bits, or 0 for NaN. The
    // conversion of NaN is poison, but the select then picks 0.
    const integer = B.tmp();
    const low = B.tmp();
    const ordered = B.tmp();
    const out = B.tmp();
    B.line(`${integer} = fptosi double ${value} to i64`);
    B.line(`${low} = trunc i64 ${integer} to i32`);
    B.line(`${ordered} = fcmp ord double ${value}, 0.0`);
    B.line(`${out} = select i1 ${ordered}, i32 ${low}, i32 0`);
    return out;
  }
  // Below 2^63 in magnitude, the i64 conversion truncates exactly (every
  // double above 2^53 is an integer), and its low 32 bits are ToUint32.
  const aboveMin = B.tmp();
  const belowMax = B.tmp();
  const fast = B.tmp();
  B.line(`${aboveMin} = fcmp oge double ${value}, ${f64Lit(-9223372036854775808)}`);
  B.line(`${belowMax} = fcmp olt double ${value}, ${f64Lit(9223372036854775808)}`);
  B.line(`${fast} = and i1 ${aboveMin}, ${belowMax}`);

  const fastLabel = B.newLabel("uint32.coerce.fast");
  const slowLabel = B.newLabel("uint32.coerce.slow");
  const done = B.newLabel("uint32.coerce.done");
  B.condBr(fast, fastLabel, slowLabel);

  B.startBlock(fastLabel);
  const signed = B.tmp();
  const fastU32 = B.tmp();
  B.line(`${signed} = fptosi double ${value} to i64`);
  B.line(`${fastU32} = trunc i64 ${signed} to i32`);
  B.br(done);

  B.startBlock(slowLabel);
  // Only NaN, the infinities and magnitudes from 2^63 reach this block.
  // Such a finite double is the integer mantissa * 2^shift with shift >= 11,
  // so its low 32 bits are the shifted mantissa's (none once shift >= 64),
  // negated for a negative value. NaN and the infinities have the maximum
  // exponent, a shift of 972, and convert to 0 like ToUint32. Integer
  // arithmetic only: the former `frem` became an `fmod` call that LLVM
  // could hoist above the range test, onto the fast path.
  const bits = B.tmp();
  const exponentBits = B.tmp();
  const exponent = B.tmp();
  const fraction = B.tmp();
  const mantissa = B.tmp();
  const shift = B.tmp();
  const inWord = B.tmp();
  const safeShift = B.tmp();
  const shifted = B.tmp();
  const magnitude = B.tmp();
  const low = B.tmp();
  const negative = B.tmp();
  const negated = B.tmp();
  const slowU32 = B.tmp();
  B.line(`${bits} = bitcast double ${value} to i64`);
  B.line(`${exponentBits} = lshr i64 ${bits}, 52`);
  B.line(`${exponent} = and i64 ${exponentBits}, 2047`);
  B.line(`${fraction} = and i64 ${bits}, 4503599627370495`);
  B.line(`${mantissa} = or i64 ${fraction}, 4503599627370496`);
  B.line(`${shift} = sub i64 ${exponent}, 1075`);
  B.line(`${inWord} = icmp ult i64 ${shift}, 64`);
  B.line(`${safeShift} = select i1 ${inWord}, i64 ${shift}, i64 0`);
  B.line(`${shifted} = shl i64 ${mantissa}, ${safeShift}`);
  B.line(`${magnitude} = select i1 ${inWord}, i64 ${shifted}, i64 0`);
  B.line(`${low} = trunc i64 ${magnitude} to i32`);
  B.line(`${negative} = icmp slt i64 ${bits}, 0`);
  B.line(`${negated} = sub i32 0, ${low}`);
  B.line(`${slowU32} = select i1 ${negative}, i32 ${negated}, i32 ${low}`);
  B.br(done);

  B.startBlock(done);
  const out = B.tmp();
  B.line(`${out} = phi i32 [ ${fastU32}, %${fastLabel} ], [ ${slowU32}, %${slowLabel} ]`);
  return out;
}

export function emitBytesSet(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  receiver: string,
  index: LlValue,
  value: LlValue,
  indexExpr?: IrExpr,
  expr?: IrExpr,
  inBounds = false,
  owned = false,
  scope = "",
): void {
  const outer = host.bytesAccessScope;
  host.bytesAccessScope = scope;
  try {
    emitScopedBytesSet(host, elem, receiver, index, value, indexExpr, expr, inBounds, owned);
  } finally {
    host.bytesAccessScope = outer;
  }
}

function emitScopedBytesSet(
  host: LlvmEmitterContext,
  elem: IrBytesElem,
  receiver: string,
  index: LlValue,
  value: LlValue,
  indexExpr: IrExpr | undefined,
  expr: IrExpr | undefined,
  inBounds: boolean,
  owned: boolean,
): void {
  const B = host.B;
  // Invalid integer-indexed writes are ignored after evaluating the RHS.
  const done = B.newLabel("bytes.store.done");
  const data = host.emitBytesData(receiver);
  const idx = emitBytesIndex(host, receiver, index, indexExpr, done, inBounds);
  if (host.mod.workers && !owned && elem === "f16") {
    host.declare(`declare void @scr_bytes_shared_set(ptr, ${host.sizeType}, double)`);
    const local = emitSharedBytesSplit(host, receiver);
    B.line(
      `call void @scr_bytes_shared_set(ptr ${receiver}, ${host.sizeType} ${idx}, double ${value.name})`,
    );
    B.br(done);
    B.startBlock(local);
  }
  let stored: string | null;
  if (elem === "u8c") {
    // ToUint8Clamp, as scr_bytes_to_u8_clamp computes it: NaN and values
    // at most 0 store 0, values at least 255 store 255, and values between
    // round to the nearest integer, ties to even. Adding and subtracting
    // 2^52 rounds a value in (0, 255) that way in the default rounding mode,
    // with no call or branch, so loops of clamped stores can vectorize.
    const positive = B.tmp(),
      high = B.tmp(),
      shifted = B.tmp(),
      rounded = B.tmp(),
      upper = B.tmp(),
      clamped = B.tmp();
    stored = B.tmp();
    B.line(`${positive} = fcmp ogt double ${value.name}, 0.0`);
    B.line(`${high} = fcmp oge double ${value.name}, 255.0`);
    B.line(`${shifted} = fadd double ${value.name}, 0x4330000000000000`);
    B.line(`${rounded} = fsub double ${shifted}, 0x4330000000000000`);
    B.line(`${upper} = select i1 ${high}, double 255.0, double ${rounded}`);
    B.line(`${clamped} = select i1 ${positive}, double ${upper}, double 0.0`);
    B.line(`${stored} = fptoui double ${clamped} to i32`);
  } else
    stored =
      elem === "f16" || elem === "f32" || elem === "f64"
        ? null
        : host.emitToUint32(value.name, expr, value.uint32);
  if (elem === "f16") {
    // One round-to-nearest-even step from the double, in the runtime.
    host.declare(`declare zeroext i16 @scr_f16_from_f64(double)`);
    const narrowed = B.tmp();
    const p = B.tmp();
    B.line(`${narrowed} = call zeroext i16 @scr_f16_from_f64(double ${value.name})`);
    B.line(`${p} = getelementptr inbounds i16, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`store i16 ${narrowed}, ptr ${p}, align 1${bytesElementAlias(host)}`);
    B.br(done);
    B.startBlock(done);
    return;
  }
  // The element's bits as an LLVM value of the element's width.
  let ty: string;
  let operand: string;
  if (BYTES_ELEMENT_SIZE[elem] < 4) {
    ty = `i${BYTES_ELEMENT_SIZE[elem] * 8}`;
    operand = B.tmp();
    B.line(`${operand} = trunc i32 ${stored!} to ${ty}`);
  } else if (elem === "f32") {
    ty = "float";
    operand = B.tmp();
    B.line(`${operand} = fptrunc double ${value.name} to float`);
  } else if (elem === "f64") {
    ty = "double";
    operand = value.name;
  } else {
    ty = "i32";
    operand = stored!;
  }
  if (host.mod.workers && !owned && !plainSharedElement(host, elem, indexExpr)) {
    // A shared view's element takes a relaxed atomic store of its width.
    const local = emitSharedBytesSplit(host, receiver);
    const p = B.tmp();
    B.line(`${p} = getelementptr inbounds ${ty}, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`store atomic ${ty} ${operand}, ptr ${p} monotonic, align ${BYTES_ELEMENT_SIZE[elem]}`);
    B.br(done);
    B.startBlock(local);
  }
  const p = B.tmp();
  B.line(`${p} = getelementptr inbounds ${ty}, ptr ${data}, ${host.sizeType} ${idx}`);
  B.line(`store ${ty} ${operand}, ptr ${p}, align 1${bytesElementAlias(host)}`);
  B.br(done);
  B.startBlock(done);
}

export function emitBytesIntrinsic(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "bytesIntrinsic" },
): LlValue {
  const B = host.B;
  const call = (
    sym: string,
    sig: string,
    argText: string,
    owned: boolean,
    fallible: boolean,
  ): LlValue => {
    const m = /^(.+?) \((.*)\)$/.exec(sig);
    if (!m) throw new InternalCompilerError(`llvm emitter bug: bad bytesIntrinsic sig ${sig}`);
    host.declare(`declare ${m[1]} @${sym}(${m[2]})`);
    const retTy = m[1] === "zeroext i1" ? "i1" : m[1]!;
    if (retTy === "void") {
      B.line(`call void @${sym}(${argText})`);
      if (fallible) host.emitPendingCheck();
      return { name: "", type: e.type };
    }
    const t = B.tmp();
    B.line(`${t} = call ${retTy} @${sym}(${argText})`);
    const out = owned ? host.own({ name: t, type: e.type }) : { name: t, type: e.type };
    if (fallible) host.emitPendingCheck();
    return out;
  };
  if (
    e.method === "readNum" ||
    e.method === "writeNum" ||
    e.method === "readNumVar" ||
    e.method === "writeNumVar"
  ) {
    const tok = e.args[0]!;
    if (tok.kind !== "strLit")
      throw new InternalCompilerError(
        `llvm emitter bug: bytesIntrinsic ${e.method} kind must be a strLit`,
      );
    const r0 = host.emitStableReceiver(e.receiver, e.args.slice(1));
    const rest = e.args.slice(1).map((a) => host.emitExpr(a));
    const access = byteNumberAccess(e);
    const numeric = (fallback: () => LlValue): LlValue =>
      access
        ? emitByteNumber(
            host,
            e,
            access,
            r0,
            rest[access.offsetArg - 1]!,
            access.write ? rest[access.valueArg - 1]! : null,
            String(access.littleEndian),
            fallback,
          )
        : fallback();
    if (e.method === "readNum" || e.method === "writeNum") {
      const spec = BYTES_NUM_KIND[tok.value];
      if (!spec)
        throw new InternalCompilerError(`llvm emitter bug: bytes numeric kind '${tok.value}'`);
      return numeric(() =>
        e.method === "readNum"
          ? call(
              "scr_bytes_read_num",
              "double (ptr, double, i32, i1 zeroext)",
              `ptr ${r0.name}, double ${rest[0]!.name}, i32 ${spec.kind}, i1 ${spec.le}`,
              false,
              true,
            )
          : call(
              "scr_bytes_write_num",
              "double (ptr, double, double, i32, i1 zeroext)",
              `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, i32 ${spec.kind}, i1 ${spec.le}`,
              false,
              true,
            ),
      );
    }
    const spec = BYTES_NUM_VAR[tok.value];
    if (!spec)
      throw new InternalCompilerError(`llvm emitter bug: bytes variable-width kind '${tok.value}'`);
    return numeric(() =>
      e.method === "readNumVar"
        ? call(
            "scr_bytes_read_var",
            "double (ptr, double, double, i1 zeroext, i1 zeroext)",
            `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, i1 ${spec.sign}, i1 ${spec.le}`,
            false,
            true,
          )
        : call(
            "scr_bytes_write_var",
            "double (ptr, double, double, double, i1 zeroext, i1 zeroext)",
            `ptr ${r0.name}, double ${rest[0]!.name}, double ${rest[1]!.name}, double ${rest[2]!.name}, i1 ${spec.sign}, i1 ${spec.le}`,
            false,
            true,
          ),
    );
  }
  const method = e.method;
  const directElementAccess =
    method === "length" ||
    method === "byteLength" ||
    method === "get" ||
    byteNumberAccess(e) !== null;
  const r = directElementAccess
    ? host.emitStableReceiver(e.receiver, e.args)
    : emitBorrowedInput(host, e.receiver);
  if (directElementAccess) noteBytesReceiver(host, e.receiver, r.name);
  // Byte operations borrow every input; views and identity results return
  // independent owners, while writes retain no operand beyond the call.
  const args = e.args.map((a) => emitBorrowedInput(host, a));
  const NAN = f64Lit(NaN);
  switch (method) {
    case "length":
      if (e.receiver.type.kind !== "bytes") {
        throw new InternalCompilerError("llvm emitter bug: bytesIntrinsic length on non-bytes");
      }
      return host.emitBytesLength(e.receiver.type.elem, r.name, false);
    case "byteLength":
      if (e.receiver.type.kind !== "bytes") {
        throw new InternalCompilerError("llvm emitter bug: bytesIntrinsic byteLength on non-bytes");
      }
      return host.emitBytesLength(e.receiver.type.elem, r.name, true);
    case "get":
      // Any invalid index traps (the array runtime's discipline).
      if (e.receiver.type.kind !== "bytes") {
        throw new InternalCompilerError("llvm emitter bug: bytesIntrinsic get on non-bytes");
      }
      return host.emitBytesGet(
        e.receiver.type.elem,
        r.name,
        args[0]!,
        e.args[0],
        host.bytesBounds.has(e),
        e.invalidNaN === true,
        host.bytesOwned.has(e),
        host.bytesAliasScopes.get(e),
      );
    case "slice":
      return call(
        "scr_bytes_slice",
        "ptr (ptr, double, double)",
        `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
        true,
        false,
      );
    case "subarray":
      // A +1 VIEW aliasing the receiver's storage (subarray / Buffer's
      // slice); same index defaults as slice.
      return call(
        "scr_bytes_subarray",
        "ptr (ptr, double, double)",
        `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, double ${args[1]?.name ?? F64_INF}`,
        true,
        false,
      );
    case "toReversed":
      return call("scr_bytes_to_reversed", "ptr (ptr)", `ptr ${r.name}`, true, false);
    case "sortCompare": {
      // The runtime invokes the borrowed comparator with the callValue ABI
      // and stops at the first pending exception.
      const cmp = e.args[0]!.type;
      const arity = cmp.kind === "func" ? cmp.params.length : 0;
      return call(
        "scr_bytes_sort_compare",
        "void (ptr, ptr, i32)",
        `ptr ${r.name}, ptr ${args[0]!.name}, i32 ${arity}`,
        false,
        true,
      );
    }
    case "sortNumeric": {
      const order = e.args[0]?.kind === "numLit" ? e.args[0].value : 0;
      return call(
        "scr_bytes_sort_numeric",
        "zeroext i1 (ptr, i32)",
        `ptr ${r.name}, i32 ${order}`,
        false,
        false,
      );
    }
    case "copyWithin":
      return call(
        "scr_bytes_copy_within",
        "ptr (ptr, double, double, double)",
        `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}, double ${args[2]!.name}`,
        true,
        false,
      );
    case "with":
      return call(
        "scr_bytes_with",
        "ptr (ptr, double, double)",
        `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}`,
        true,
        true,
      );
    case "join":
      return call(
        "scr_bytes_join",
        "ptr (ptr, ptr)",
        `ptr ${r.name}, ptr ${args[0]!.name}`,
        true,
        false,
      );
    case "toArray":
      return call("scr_bytes_to_arr", "ptr (ptr)", `ptr ${r.name}`, true, false);
    case "setFrom":
    case "setFromDyn":
      // dst.set(src, offset?) — void; throws Node's RangeError on
      // overflow.
      return call(
        method === "setFromDyn" ? "scr_bytes_set_from_dyn" : "scr_bytes_set_from",
        "void (ptr, ptr, double)",
        `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}`,
        false,
        true,
      );
    case "toString":
    case "toStringVar": {
      // The encoding arg is always present (the frontend completes an
      // omitted one to "utf8"). The runtime-valued form validates and
      // may throw ERR_UNKNOWN_ENCODING; the literal form is canonical
      // and cannot throw. Both return +1. Range forms: [enc, start]
      // decode to the buffer's end (the element count — r->len in the C
      // spelling); [enc, start, end] clamps.
      const checked = method === "toStringVar";
      const stem = checked ? "scr_bytes_to_str_checked" : "scr_bytes_to_str";
      if (e.args.length === 3) {
        return call(
          `${stem}_range`,
          "ptr (ptr, ptr, double, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}, double ${args[2]!.name}`,
          true,
          checked,
        );
      }
      if (e.args.length === 2) {
        host.declare(`declare double @scr_bytes_len(ptr)`);
        const len = B.tmp();
        B.line(`${len} = call double @scr_bytes_len(ptr ${r.name})`);
        return call(
          `${stem}_range`,
          "ptr (ptr, ptr, double, double)",
          `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[1]!.name}, double ${len}`,
          true,
          checked,
        );
      }
      return call(stem, "ptr (ptr, ptr)", `ptr ${r.name}, ptr ${args[0]!.name}`, true, checked);
    }
    case "equals":
      return call(
        "scr_bytes_equals",
        "zeroext i1 (ptr, ptr)",
        `ptr ${r.name}, ptr ${args[0]!.name}`,
        false,
        false,
      );
    case "compareBuf": {
      // nargs = the PRESENT index args (omitted ones skip Node's
      // validation); the 0 placeholders are never read past nargs.
      const n = e.args.length - 1;
      const idx = [1, 2, 3, 4].map((i) => args[i]?.name ?? f64Lit(0));
      return call(
        "scr_bytes_compare",
        "double (ptr, ptr, double, double, double, double, double)",
        `ptr ${r.name}, ptr ${args[0]!.name}, double ${f64Lit(n)}, ${idx.map((x) => `double ${x}`).join(", ")}`,
        false,
        true,
      );
    }
    case "indexOf":
    case "lastIndexOf":
    case "includes": {
      // args = [needle, align, byteOffset?]; an omitted byteOffset is
      // NaN — the runtime's search-everything default.
      const fwd = method !== "lastIndexOf";
      const idx = call(
        "scr_bytes_index_of",
        "double (ptr, ptr, double, double, i1 zeroext)",
        `ptr ${r.name}, ptr ${args[0]!.name}, double ${args[2]?.name ?? NAN}, double ${args[1]!.name}, i1 ${fwd}`,
        false,
        false,
      );
      if (method !== "includes") return idx;
      const t = B.tmp();
      B.line(`${t} = fcmp one double ${idx.name}, ${f64Lit(-1)}`);
      return { name: t, type: e.type };
    }
    case "indexOfNum":
    case "lastIndexOfNum":
    case "includesNum": {
      const fwd = method !== "lastIndexOfNum";
      const idx = call(
        "scr_bytes_index_of_num",
        "double (ptr, double, double, i1 zeroext)",
        `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? NAN}, i1 ${fwd}`,
        false,
        false,
      );
      if (method !== "includesNum") return idx;
      const t = B.tmp();
      B.line(`${t} = fcmp one double ${idx.name}, ${f64Lit(-1)}`);
      return { name: t, type: e.type };
    }
    case "indexOfElem":
    case "lastIndexOfElem":
      return call(
        "scr_bytes_index_of_elem",
        "double (ptr, double, double, i1 zeroext)",
        `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}, i1 ${method === "lastIndexOfElem"}`,
        false,
        false,
      );
    case "includesElem":
      return call(
        "scr_bytes_includes_elem",
        "zeroext i1 (ptr, double, double)",
        `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}`,
        false,
        false,
      );
    case "fillElem":
      // Per-element TypedArray fill (non-u8): slice-style index
      // defaults, never throws; the receiver comes back +1.
      return call(
        "scr_bytes_fill_elem",
        "ptr (ptr, double, double, double)",
        `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? F64_INF}`,
        true,
        false,
      );
    case "fill":
    case "fillNum": {
      const sym = method === "fill" ? "scr_bytes_fill" : "scr_bytes_fill_num";
      const vTy = method === "fill" ? "ptr" : "double";
      const n = e.args.length - 1;
      return call(
        sym,
        `ptr (ptr, ${vTy}, double, double, double)`,
        `ptr ${r.name}, ${vTy} ${args[0]!.name}, double ${f64Lit(n)}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? f64Lit(0)}`,
        true,
        true,
      );
    }
    case "fillStr": {
      const n = e.args.length - 2;
      return call(
        "scr_bytes_fill_str",
        "ptr (ptr, ptr, ptr, double, double, double)",
        `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${f64Lit(n)}, double ${args[2]?.name ?? f64Lit(0)}, double ${args[3]?.name ?? f64Lit(0)}`,
        true,
        true,
      );
    }
    case "copy": {
      const n = e.args.length - 1;
      return call(
        "scr_bytes_copy_into",
        "double (ptr, ptr, double, double, double, double)",
        `ptr ${r.name}, ptr ${args[0]!.name}, double ${f64Lit(n)}, double ${args[1]?.name ?? f64Lit(0)}, double ${args[2]?.name ?? f64Lit(0)}, double ${args[3]?.name ?? f64Lit(0)}`,
        false,
        true,
      );
    }
    case "swap16":
    case "swap32":
    case "swap64": {
      const w = method === "swap16" ? 2 : method === "swap32" ? 4 : 8;
      return call(
        "scr_bytes_swap",
        "ptr (ptr, double)",
        `ptr ${r.name}, double ${f64Lit(w)}`,
        true,
        true,
      );
    }
    case "writeStr":
      return call(
        "scr_bytes_write_str",
        "double (ptr, ptr, ptr, double, double, i1 zeroext)",
        `ptr ${r.name}, ptr ${args[0]!.name}, ptr ${args[1]!.name}, double ${args[2]!.name}, double ${args[3]?.name ?? f64Lit(0)}, i1 ${args[3] ? "true" : "false"}`,
        false,
        true,
      );
    case "buffer":
      return call("scr_array_buffer_from_bytes", "ptr (ptr)", `ptr ${r.name}`, true, false);
    case "byteOffset":
      return call("scr_bytes_byte_offset", "double (ptr)", `ptr ${r.name}`, false, false);
    case "dataViewNew":
      // new DataView(x.buffer, byteOffset?, byteLength?) — the has_len
      // flag keeps an omitted length distinct from every numeric value.
      return call(
        "scr_dataview_new",
        "ptr (ptr, double, i1 zeroext, double)",
        `ptr ${r.name}, double ${args[0]?.name ?? f64Lit(0)}, i1 ${args[1] ? "true" : "false"}, double ${args[1]?.name ?? f64Lit(0)}`,
        true,
        true,
      );
    case "dvGetUint8":
    case "dvGetInt8":
    case "dvGetUint16":
    case "dvGetInt16":
    case "dvGetUint32":
    case "dvGetInt32":
    case "dvGetFloat16":
    case "dvGetFloat32":
    case "dvGetFloat64":
    case "dvGetBigUint64Number":
    case "dvGetBigInt64Number": {
      // DataView getters: an omitted littleEndian is big-endian (the JS
      // default). Throw Node's constant RangeError on a bad offset.
      return emitByteNumber(
        host,
        e,
        byteNumberAccess(e)!,
        r,
        args[0]!,
        null,
        args[1]?.name ?? "false",
        () =>
          call(
            "scr_dataview_get",
            "double (ptr, double, i32, i1 zeroext)",
            `ptr ${r.name}, double ${args[0]!.name}, i32 ${DV_GET_KIND[method]}, i1 ${args[1]?.name ?? "false"}`,
            false,
            true,
          ),
      );
    }
    case "dvSetUint8":
    case "dvSetInt8":
    case "dvSetUint16":
    case "dvSetInt16":
    case "dvSetUint32":
    case "dvSetInt32":
    case "dvSetFloat16":
    case "dvSetFloat32":
    case "dvSetFloat64": {
      // DataView setters: [offset, value, littleEndian?] — void; throw
      // the getters' constant RangeError on a bad offset.
      return emitByteNumber(
        host,
        e,
        byteNumberAccess(e)!,
        r,
        args[0]!,
        args[1]!,
        args[2]?.name ?? "false",
        () =>
          call(
            "scr_dataview_set",
            "void (ptr, double, double, i32, i1 zeroext)",
            `ptr ${r.name}, double ${args[0]!.name}, double ${args[1]!.name}, ` +
              `i32 ${DV_SET_KIND[method]}, i1 ${args[2]?.name ?? "false"}`,
            false,
            true,
          ),
      );
    }
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** The `atomicrmw` operation of each Atomics read-modify-write
 * (frontend/lowering/builtins/atomics.ts numbering). */
const ATOMIC_RMW: Readonly<Record<number, string>> = {
  2: "xchg",
  4: "add",
  5: "sub",
  6: "and",
  7: "or",
  8: "xor",
};

/** `Atomics.load/store/exchange/compareExchange/add/sub/and/or/xor` on an
 * integer typed array as one sequentially consistent atomic instruction on
 * the element. Arguments evaluate first, in order, as for the runtime call.
 * An index that is not an integer in [0, length) takes scr_atomics_op,
 * which applies ToIndex and raises its errors. Returns null for forms the
 * runtime handles. */
export function emitInlineAtomicsOp(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "libCall" },
): LlValue | null {
  const [array, index, value, replacement, operation] = e.args;
  if (
    !array ||
    !index ||
    !value ||
    !replacement ||
    operation?.kind !== "numLit" ||
    array.type.kind !== "bytes" ||
    !["i8", "u8", "i16", "u16", "i32", "u32"].includes(array.type.elem)
  )
    return null;
  const op = operation.value;
  if (op !== 0 && op !== 1 && op !== 3 && ATOMIC_RMW[op] === undefined) return null;
  const elem = array.type.elem;
  const B = host.B;
  // The instruction and scr_atomics_op borrow the array: an unchanged local
  // owns it across the later operands and the operation.
  const receiver = emitBorrowedInput(host, array).name;
  const idxValue = host.emitExpr(index);
  const operand = host.emitExpr(value);
  const swap = host.emitExpr(replacement);
  const slow = B.newLabel("atomics.slow");
  const idx = emitBytesIndex(host, receiver, idxValue, index, slow);
  const size = BYTES_ELEMENT_SIZE[elem];
  const ty = `i${size * 8}`;
  const signed = elem === "i8" || elem === "i16" || elem === "i32";
  const p = B.tmp();
  B.line(
    `${p} = getelementptr inbounds ${ty}, ptr ${host.emitBytesData(receiver)}, ${host.sizeType} ${idx}`,
  );
  const narrow = (v: LlValue, expr: IrExpr): string => {
    const u32 = emitToUint32(host, v.name, expr, v.uint32);
    if (size === 4) return u32;
    const t = B.tmp();
    B.line(`${t} = trunc i32 ${u32} to ${ty}`);
    return t;
  };
  let fast: string;
  let fastU32: string | undefined;
  if (op === 1) {
    B.line(`store atomic ${ty} ${narrow(operand, value)}, ptr ${p} seq_cst, align ${size}`);
    // store answers ToIntegerOrInfinity of the value (NaN and -0 are 0).
    const whole = B.tmp(),
      nonzero = B.tmp();
    fast = B.tmp();
    host.declare(`declare double @llvm.trunc.f64(double)`);
    B.line(`${whole} = call double @llvm.trunc.f64(double ${operand.name})`);
    B.line(`${nonzero} = fcmp one double ${whole}, ${f64Lit(0)}`);
    B.line(`${fast} = select i1 ${nonzero}, double ${whole}, double ${f64Lit(0)}`);
  } else {
    const old = B.tmp();
    if (op === 0) B.line(`${old} = load atomic ${ty}, ptr ${p} seq_cst, align ${size}`);
    else if (op === 3) {
      const pair = B.tmp();
      B.line(
        `${pair} = cmpxchg ptr ${p}, ${ty} ${narrow(operand, value)}, ${ty} ${narrow(swap, replacement)} seq_cst seq_cst, align ${size}`,
      );
      B.line(`${old} = extractvalue { ${ty}, i1 } ${pair}, 0`);
    } else
      B.line(
        `${old} = atomicrmw ${ATOMIC_RMW[op]} ptr ${p}, ${ty} ${narrow(operand, value)} seq_cst, align ${size}`,
      );
    fastU32 = old;
    if (size < 4) {
      fastU32 = B.tmp();
      B.line(`${fastU32} = ${signed ? "sext" : "zext"} ${ty} ${old} to i32`);
    }
    fast = B.tmp();
    B.line(`${fast} = ${signed ? "sitofp" : "uitofp"} i32 ${fastU32} to double`);
  }
  const fastDone = B.newLabel("atomics.fast.done");
  B.br(fastDone);
  B.startBlock(fastDone);
  const join = B.newLabel("atomics.join");
  B.br(join);
  B.startBlock(slow);
  host.declare(`declare double @scr_atomics_op(ptr, double, double, double, double)`);
  const called = B.tmp();
  B.line(
    `${called} = call double @scr_atomics_op(ptr ${receiver}, double ${idxValue.name}, double ${operand.name}, double ${swap.name}, double ${f64Lit(op)}) cold`,
  );
  host.emitPendingCheck();
  const slowDone = B.newLabel("atomics.slow.done");
  B.br(slowDone);
  B.startBlock(slowDone);
  B.br(join);
  B.startBlock(join);
  const out = B.tmp();
  B.line(`${out} = phi double [ ${fast}, %${fastDone} ], [ ${called}, %${slowDone} ]`);
  return { name: out, type: F64 };
}
