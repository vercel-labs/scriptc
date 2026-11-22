import { BOOL, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The duplex builtin call slots. */
export const duplexSignatures = defineLibFnSignatures({
  "duplex.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "duplex.newDyn": { argTypes: [DYN], result: VOID },
  "duplex.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "duplex.init": { argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
});
