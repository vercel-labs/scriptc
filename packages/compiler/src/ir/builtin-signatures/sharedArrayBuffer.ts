import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The sharedArrayBuffer builtin call slots. */
export const sharedArrayBufferSignatures = defineLibFnSignatures({
  "sharedArrayBuffer.new": { argTypes: [DYN], result: DYN },
  "sharedArrayBuffer.is": { argTypes: [DYN], result: BOOL },
  /** `new SharedArrayBuffer(len, { maxByteLength })`: the same, growable. */
  "sharedArrayBuffer.newGrowable": { argTypes: [DYN, DYN], result: DYN },
});
