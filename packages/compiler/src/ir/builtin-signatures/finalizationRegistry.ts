import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The finalizationRegistry builtin call slots. */
export const finalizationRegistrySignatures = defineLibFnSignatures({
  "finalizationRegistry.new": { argTypes: [DYN], result: DYN },
  "finalizationRegistry.is": { argTypes: [DYN], result: BOOL },
});
