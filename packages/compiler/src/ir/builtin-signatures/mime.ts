import { BOOL, DYN, F64 } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The mime builtin call slots. */
export const mimeSignatures = defineLibFnSignatures({
  "mime.typeNew": { argTypes: [DYN, DYN], result: DYN },
  "mime.typeParse": { argTypes: [DYN], result: DYN },
  "mime.paramsNew": { argTypes: [], result: DYN },
  "mime.is": { argTypes: [DYN, F64], result: BOOL },
});
