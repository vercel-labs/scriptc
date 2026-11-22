import { bytesOf, DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The atomics builtin call slots. */
export const atomicsSignatures = defineLibFnSignatures({
  "atomics.wait": { argTypes: [bytesOf("i32"), F64, F64, F64], result: STRING },
  "atomics.notify": { argTypes: [bytesOf("i32"), F64, F64], result: F64 },
  "atomics.op": { argTypes: [null, F64, F64, F64, F64], result: F64 },
  "atomics.opDyn": { argTypes: [DYN, F64, F64, F64, F64], result: F64 },
  "atomics.waitDyn": { argTypes: [DYN, F64, F64, F64], result: STRING },
  "atomics.notifyDyn": { argTypes: [DYN, F64, F64], result: F64 },
});
