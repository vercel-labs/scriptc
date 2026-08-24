import { InternalCompilerError } from "../../errors.js";
import type { IrFfiCallbackParamClass, IrFfiReturnClass, IrFfiValueParamClass } from "../../ir/ir.js";

export function ffiNativeTypeLl(
  cls: IrFfiCallbackParamClass | IrFfiValueParamClass | IrFfiReturnClass,
): string {
  switch (cls) {
    case "f64":
      return "double";
    case "bool":
    case "u8":
      return "i8";
    case "u32":
    case "i32":
      return "i32";
    case "cstring":
      return "ptr";
    case "string":
    case "bytes":
      throw new InternalCompilerError(`llvm emitter bug: span class '${cls}' has no scalar LLVM type`);
    case "void":
      return "void";
  }
}

export function f64Lit(n: number): string {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, n);
  return `0x${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export const F64_INF = f64Lit(Infinity);
