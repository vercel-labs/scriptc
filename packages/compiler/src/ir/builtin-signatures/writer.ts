import { BOOL, BYTES_U8, CHILDWRITER_T, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The writer builtin call slots. */
export const writerSignatures = defineLibFnSignatures({
  "writer.writeString": { argTypes: [CHILDWRITER_T, STRING], result: BOOL },
  "writer.writeBytes": { argTypes: [CHILDWRITER_T, BYTES_U8], result: BOOL },
  "writer.end": { argTypes: [CHILDWRITER_T], result: VOID },
  "writer.destroy": { argTypes: [CHILDWRITER_T], result: VOID },
  "writer.writable": { argTypes: [CHILDWRITER_T], result: BOOL },
  "writer.onDrain": { argTypes: [CHILDWRITER_T, null, BOOL], result: VOID },
  "writer.onFinish": { argTypes: [CHILDWRITER_T, null, BOOL], result: VOID },
  "writer.onError": { argTypes: [CHILDWRITER_T, null, BOOL], result: VOID },
});
