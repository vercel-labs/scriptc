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

/** User-controlled text embedded after an LLVM `;` comment marker. Preserve
 * ordinary output byte-for-byte, but encode control and line-separator code
 * units so a property name can never inject a line or invalid source byte. */
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
