import { BOOL, BYTES_U8, bytesOf, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The arrayBuffer builtin call slots. */
export const arrayBufferSignatures = defineLibFnSignatures({
  "arrayBuffer.constructor": { argTypes: [], result: DYN },
  "arrayBuffer.new": { argTypes: [DYN], result: DYN },
  /** `new ArrayBuffer(len, { maxByteLength })` in a JavaScript source
   * (t262-dc C2): the maxByteLength reserved up front, the visible length
   * len. */
  "arrayBuffer.newResizable": { argTypes: [DYN, DYN], result: DYN },
  /** The %main prologue call that arms scr_js_buffers's views registry
   * (buffers.ts): never throws, never answers. */
  "arrayBuffer.armMutable": { argTypes: [], result: VOID },
  "arrayBuffer.is": { argTypes: [DYN], result: BOOL },
  "arrayBuffer.isView": { argTypes: [DYN], result: BOOL },
  "arrayBuffer.byteLengthGetter": { argTypes: [], result: F64 },
  "arrayBuffer.byteLengthDescriptor": { argTypes: [DYN], result: DYN },
  "arrayBuffer.viewU8C": { argTypes: [DYN, DYN, DYN], result: bytesOf("u8c") },
  "arrayBuffer.viewI8": { argTypes: [DYN, DYN, DYN], result: bytesOf("i8") },
  "arrayBuffer.viewU16": { argTypes: [DYN, DYN, DYN], result: bytesOf("u16") },
  "arrayBuffer.viewI16": { argTypes: [DYN, DYN, DYN], result: bytesOf("i16") },
  "arrayBuffer.viewU8": { argTypes: [DYN, DYN, DYN], result: BYTES_U8 },
  "arrayBuffer.viewU32": { argTypes: [DYN, DYN, DYN], result: bytesOf("u32") },
  "arrayBuffer.viewI32": { argTypes: [DYN, DYN, DYN], result: bytesOf("i32") },
  "arrayBuffer.viewF16": { argTypes: [DYN, DYN, DYN], result: bytesOf("f16") },
  "arrayBuffer.viewF32": { argTypes: [DYN, DYN, DYN], result: bytesOf("f32") },
  "arrayBuffer.viewF64": { argTypes: [DYN, DYN, DYN], result: bytesOf("f64") },
  "arrayBuffer.viewDV": { argTypes: [DYN, DYN, DYN], result: BYTES_U8 },
});
