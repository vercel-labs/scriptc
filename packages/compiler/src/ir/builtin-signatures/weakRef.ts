import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The weakRef builtin call slots. */
export const weakRefSignatures = defineLibFnSignatures({
  "weakRef.new": { argTypes: [DYN], result: DYN },
  "weakRef.is": { argTypes: [DYN], result: BOOL },
});
