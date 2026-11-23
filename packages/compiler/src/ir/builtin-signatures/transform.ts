import { BOOL, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The transform builtin call slots. */
export const transformSignatures = defineLibFnSignatures({
  "transform.new": { argTypes: [F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64], result: VOID },
  "transform.newDyn": { argTypes: [DYN], result: VOID },
  "transform.initDyn": { argTypes: [null, DYN, F64], result: VOID },
  "transform.init": {
    argTypes: [null, F64, F64, BOOL, BOOL, BOOL, BOOL, BOOL, F64],
    result: VOID,
  },
});
