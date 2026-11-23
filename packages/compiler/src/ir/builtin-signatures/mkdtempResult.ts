import { MKDTEMPRESULT_T, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The mkdtempResult builtin call slots. */
export const mkdtempResultSignatures = defineLibFnSignatures({
  "mkdtempResult.path": { argTypes: [MKDTEMPRESULT_T], result: STRING },
  "mkdtempResult.remove": {
    argTypes: [MKDTEMPRESULT_T],
    result: { kind: "promise", inner: VOID },
  },
  "mkdtempResult.removeSync": { argTypes: [MKDTEMPRESULT_T], result: VOID },
  "mkdtempResult.asyncDispose": {
    argTypes: [MKDTEMPRESULT_T],
    result: { kind: "promise", inner: VOID },
  },
  "mkdtempResult.dispose": { argTypes: [MKDTEMPRESULT_T], result: VOID },
});
