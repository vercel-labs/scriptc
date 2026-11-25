import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The weakSet builtin call slots. */
export const weakSetSignatures = defineLibFnSignatures({
  "weakSet.is": { argTypes: [DYN], result: BOOL },
  "weakSet.new": { argTypes: [DYN], result: DYN },
});
