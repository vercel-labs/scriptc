import { BOOL, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The passthrough builtin call slots. */
export const passthroughSignatures = defineLibFnSignatures({
  "passthrough.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "passthrough.newDyn": { argTypes: [DYN], result: VOID },
  "passthrough.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "passthrough.init": {
    argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64],
    result: VOID,
  },
});
