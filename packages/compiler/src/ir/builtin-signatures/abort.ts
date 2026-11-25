import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The abort builtin call slots. */
export const abortSignatures = defineLibFnSignatures({
  "abort.controllerNew": { argTypes: [], result: DYN },
  "abort.signalIs": { argTypes: [DYN], result: BOOL },
  "abort.timeout": { argTypes: [DYN], result: DYN },
  "abort.now": { argTypes: [DYN], result: DYN },
  "abort.any": { argTypes: [DYN], result: DYN },
});
