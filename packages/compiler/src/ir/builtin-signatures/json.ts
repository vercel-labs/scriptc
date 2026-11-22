import { DYN, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The json builtin call slots. */
export const jsonSignatures = defineLibFnSignatures({
  "json.parse": { argTypes: [STRING], result: DYN },
  "json.parseReviver": { argTypes: [STRING, DYN], result: DYN },
  "json.stringifyReplacer": { argTypes: [DYN, DYN, STRING], result: DYN },
  "json.stringifyValue": { argTypes: [DYN, DYN, DYN], result: DYN },
});
