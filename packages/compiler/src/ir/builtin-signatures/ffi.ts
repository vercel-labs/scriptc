import { DYN, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The ffi builtin call slots. */
export const ffiSignatures = defineLibFnSignatures({
  "ffi.argument": { argTypes: [DYN, STRING], result: DYN },
  "ffi.memoryModule": { argTypes: [DYN], result: DYN },
});
