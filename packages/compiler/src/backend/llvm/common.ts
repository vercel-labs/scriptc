import { commentText, unsignedHex } from "../literals.js";
import { InternalCompilerError } from "../../errors.js";
import type { BlockBuilder } from "./blocks.js";
import type {
  IrBytesElem,
  IrFfiCallbackParamClass,
  IrFfiReturnClass,
  IrFfiValueParamClass,
} from "../../ir/ir.js";
import type { LlvmEmitterContext } from "./expr-context.js";

/** Field numbers of %ScrArr, which mirrors scr_runtime.h's ScrArr field for
 * field (its static assertions pin `len`, `cap`, `cyc`, `spare`, `filled`
 * and `data`). `len` and `cap` are i32 on every target; the dense states of
 * an array with states (SCR_ARR_STATES in `spare`) end the allocation after
 * the `cap` value slots at `data` (scrArrStates). */
export const SCR_ARR_FIELD = {
  rc: 0,
  len: 1,
  cap: 2,
  elem: 3,
  cyc: 4,
  spare: 5,
  filled: 6,
  data: 7,
} as const;

/** The `spare` flag of a %ScrArr whose dense slots carry state bytes
 * (SCR_ARR_STATES in scr_array.h). */
export const SCR_ARR_STATES = 16;

/** The `spare` flag of a frozen %ScrArr (SCR_ARR_FROZEN in scr_array.h). */
export const SCR_ARR_FROZEN = 32;

/** The bits of ScrClosure.function_kind (SCR_CLOSURE_KIND_* in
 * scr_closure.h; runtime-registries.test.ts checks they agree). */
export const CLOSURE_KIND = {
  GENERATOR: 1,
  ASYNC: 2,
  OWN_PROTOTYPE: 4,
  CHECKED_ADAPTER: 8,
  RECEIVER_FREE: 16,
} as const;

/** Loads the i32 `len` or `cap` of a %ScrArr at `ptr` into `dest` as a
 * size-type count. */
export function loadArrCount(
  host: Pick<LlvmEmitterContext, "B" | "sizeType">,
  dest: string,
  ptr: string,
  attach = "",
): void {
  const B = host.B;
  if (host.sizeType === "i32") {
    B.line(`${dest} = load i32, ptr ${ptr}${attach}`);
    return;
  }
  const raw = B.tmp();
  B.line(`${raw} = load i32, ptr ${ptr}${attach}`);
  B.line(`${dest} = zext i32 ${raw} to ${host.sizeType}`);
}

/** Stores the size-type count `value` (at most 2^32 - 1) into the i32 `len`
 * or `cap` of a %ScrArr at `ptr`. */
export function storeArrCount(
  host: Pick<LlvmEmitterContext, "B" | "sizeType">,
  value: string,
  ptr: string,
  attach = "",
): void {
  const B = host.B;
  let narrow = value;
  if (host.sizeType !== "i32") {
    narrow = B.tmp();
    B.line(`${narrow} = trunc ${host.sizeType} ${value} to i32`);
  }
  B.line(`store i32 ${narrow}, ptr ${ptr}${attach}`);
}

/** The end of the dense state bytes of a %ScrArr into `dest`
 * (scr_arr_states_end): `cap` value slots of `width` bytes at `data`, then
 * one state byte per slot in reverse slot order. `cap` is a size-type count. */
export function scrArrStates(
  host: Pick<LlvmEmitterContext, "B" | "sizeType">,
  dest: string,
  data: string,
  cap: string,
  width: number,
): void {
  host.B.line(
    `${dest} = getelementptr inbounds [${width + 1} x i8], ptr ${data}, ${host.sizeType} ${cap}`,
  );
}

/** The state byte of dense slot `offset` into `dest`, given the end of the
 * states (scrArrStates): `end - 1 - offset`. */
export function scrArrStatePtr(
  host: Pick<LlvmEmitterContext, "B" | "sizeType">,
  dest: string,
  end: string,
  offset: string,
): void {
  const B = host.B;
  const back = B.tmp();
  B.line(`${back} = xor ${host.sizeType} ${offset}, -1`);
  B.line(`${dest} = getelementptr inbounds i8, ptr ${end}, ${host.sizeType} ${back}`);
}

/** The state byte of dense slot `offset` of a %ScrArr into `dest`, from its
 * `data` and size-type `cap`: scrArrStates and scrArrStatePtr in one
 * address computation, for paths that read a single state. */
export function scrArrStateAt(
  host: Pick<LlvmEmitterContext, "B" | "sizeType">,
  dest: string,
  data: string,
  cap: string,
  width: number,
  offset: string,
): void {
  const B = host.B;
  const back = B.tmp();
  B.line(`${back} = xor ${host.sizeType} ${offset}, -1`);
  B.line(
    `${dest} = getelementptr inbounds [${width + 1} x i8], ptr ${data}, ${host.sizeType} ${cap}, ${host.sizeType} ${back}`,
  );
}

/** Lines that decide whether the double `index` is an integer in
 * `[0, length)`, where `length` is an unsigned `sizeType` count, and give
 * that integer as an i64. `%{ok}` is the answer; `%{wide}` is meaningful
 * only when it holds.
 *
 * A signed round trip replaces the unsigned one (`fptoui`/`uitofp` expand
 * to long sequences on x86-64), and an integer compare replaces two float
 * compares against the converted length. `freeze` makes an out-of-range or
 * NaN conversion an arbitrary integer instead of poison; such an integer
 * never converts back to the index, or else is not below the length. Below
 * the length (far under 2^53) the round trip is exact, so equality means the
 * index is that integer. -0 converts to 0, as ToPropertyKey(-0) is "0". */
export function exactIndexLines(
  index: string,
  length: string,
  sizeType: string,
  tmp: () => string,
): { lines: string[]; ok: string; wide: string } {
  const raw = tmp(),
    wide = tmp(),
    back = tmp(),
    integral = tmp(),
    below = tmp(),
    ok = tmp();
  const lines = [
    `${raw} = fptosi double ${index} to i64`,
    `${wide} = freeze i64 ${raw}`,
    `${back} = sitofp i64 ${wide} to double`,
    `${integral} = fcmp oeq double ${back}, ${index}`,
  ];
  let len64 = length;
  if (sizeType !== "i64") {
    len64 = tmp();
    lines.push(`${len64} = zext ${sizeType} ${length} to i64`);
  }
  lines.push(`${below} = icmp ult i64 ${wide}, ${len64}`, `${ok} = and i1 ${integral}, ${below}`);
  return { lines, ok, wide };
}

/** exactIndexLines for the index `base + offset`, where `offset` is an
 * integer of magnitude below 2^31: the round trip converts `base` instead of
 * the sum, so accesses at several offsets from one base share the
 * conversion. When `base` is an integer, the sum is in range exactly when
 * the integer sum is (a length is at most 2^52, and a sum of 2^52 or more is
 * out of range either way). A fractional `base` can still give an integer
 * sum, as `1e-20 + 1` is 1, so `integral` false leaves the index to an
 * exact check of the sum itself. */
export function exactOffsetIndexLines(
  base: string,
  offset: number,
  length: string,
  sizeType: string,
  tmp: () => string,
): { lines: string[]; ok: string; wide: string; integral: string } {
  const raw = tmp(),
    integer = tmp(),
    back = tmp(),
    integral = tmp(),
    wide = tmp(),
    below = tmp(),
    ok = tmp();
  const lines = [
    `${raw} = fptosi double ${base} to i64`,
    `${integer} = freeze i64 ${raw}`,
    `${back} = sitofp i64 ${integer} to double`,
    `${integral} = fcmp oeq double ${back}, ${base}`,
    `${wide} = add i64 ${integer}, ${offset}`,
  ];
  let len64 = length;
  if (sizeType !== "i64") {
    len64 = tmp();
    lines.push(`${len64} = zext ${sizeType} ${length} to i64`);
  }
  lines.push(`${below} = icmp ult i64 ${wide}, ${len64}`, `${ok} = and i1 ${integral}, ${below}`);
  return { lines, ok, wide, integral };
}

/** User-controlled text embedded after an LLVM `;` comment marker. Preserve
 * ordinary output unchanged, but encode control and line-separator code
 * units so a property name can never inject a line or invalid source byte. */
/** The conversion of a size_t (a length, a count or an in-range index) to
 * a number. Array lengths reach 2^32 - 1, past a 32-bit size_t's sign bit,
 * so wasm32 converts unsigned; a 64-bit size_t never reaches its sign bit
 * and keeps the signed conversion, which x86-64 does in one instruction. */
export function sizeToDouble(sizeType: string): "uitofp" | "sitofp" {
  return sizeType === "i32" ? "uitofp" : "sitofp";
}

export function llvmCommentText(text: string): string {
  return commentText(text);
}

export function ffiNativeTypeLl(
  cls: IrFfiCallbackParamClass | IrFfiValueParamClass | IrFfiReturnClass,
): string {
  switch (cls) {
    case "f64":
      return "double";
    case "f32":
      return "float";
    case "bool":
    case "u8":
    case "i8":
      return "i8";
    case "u16":
    case "i16":
      return "i16";
    case "u32":
    case "i32":
      return "i32";
    case "i64":
    case "u64":
      return "i64";
    case "pointer":
    case "cstring":
      return "ptr";
    case "string":
    case "bytes":
    case "mutable-bytes":
      throw new InternalCompilerError(
        `llvm emitter bug: span class '${cls}' has no scalar LLVM type`,
      );
    case "void":
      return "void";
  }
}

export function ffiNativeParamLl(
  cls: Parameters<typeof ffiNativeTypeLl>[0],
  extend: boolean,
): string {
  const attr = ffiExtensionLl(cls, extend);
  return `${ffiNativeTypeLl(cls)}${attr ? ` ${attr}` : ""}`;
}

export function ffiNativeReturnLl(
  cls: Parameters<typeof ffiNativeTypeLl>[0],
  extend: boolean,
): string {
  const attr = ffiExtensionLl(cls, extend);
  return `${attr ? `${attr} ` : ""}${ffiNativeTypeLl(cls)}`;
}

function ffiExtensionLl(cls: Parameters<typeof ffiNativeTypeLl>[0], extend: boolean): string {
  if (!extend) return "";
  if (cls === "i8" || cls === "i16") return "signext";
  if (cls === "bool" || cls === "u8" || cls === "u16") return "zeroext";
  return "";
}

export function f64Lit(n: number): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, n);
  return `0x${[...bytes]
    .map((b) => unsignedHex(b).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

export const F64_INF = f64Lit(Infinity);

/** Stable ScrBytesElem tags from scr_runtime.h. */
export const BYTES_ELEM_NUM: Record<IrBytesElem, number> = {
  u8: 0,
  u32: 1,
  f32: 2,
  i32: 3,
  f64: 4,
  i8: 5,
  u16: 6,
  i16: 7,
  u8c: 8,
  f16: 9,
};

/** The payload marker of an ABSENT record field slot (IR fieldAbsent): the
 * union's undefined-arm tag with payload 1, where ordinary unit instances
 * carry 0. Tests compare tag and payload, never the address, so separately
 * compiled units agree. */
export const ABSENT_FIELD_PAYLOAD = 1;

/** Emits the i1 "this field-slot union value is ABSENT" test. */
export function emitFieldAbsentTest(B: BlockBuilder, value: string, undefinedTag: number): string {
  const tp = B.tmp();
  const tag = B.tmp();
  const isUndef = B.tmp();
  const sp = B.tmp();
  const payload = B.tmp();
  const marked = B.tmp();
  const absent = B.tmp();
  B.line(`${tp} = getelementptr inbounds %ScrUnion, ptr ${value}, i64 0, i32 1`);
  B.line(`${tag} = load i32, ptr ${tp}`);
  B.line(`${isUndef} = icmp eq i32 ${tag}, ${undefinedTag}`);
  B.line(`${sp} = getelementptr inbounds %ScrUnion, ptr ${value}, i64 0, i32 5`);
  B.line(`${payload} = load i64, ptr ${sp}`);
  B.line(`${marked} = icmp eq i64 ${payload}, ${ABSENT_FIELD_PAYLOAD}`);
  B.line(`${absent} = and i1 ${isUndef}, ${marked}`);
  return absent;
}

/** The right-hand side of a JS function-identity comparison: two closures
 * are one function when their identity roots match (a signature adapter
 * stands for the function it adapts). Both operands must be closures. */
export function closureIdentityEqual(
  host: LlvmEmitterContext,
  left: string,
  right: string,
): string {
  host.declare(`declare zeroext i1 @scr_closure_identity_equal(ptr, ptr)`);
  return `call zeroext i1 @scr_closure_identity_equal(ptr ${left}, ptr ${right})`;
}
