import { DYN, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The navigator builtin call slots. */
export const navigatorSignatures = defineLibFnSignatures({
  /** Node's navigator global (scr_node_builtin.c). */
  "navigator.object": { argTypes: [], result: DYN },
  "navigator.language": { argTypes: [], result: STRING },
  "navigator.languages": { argTypes: [], result: DYN },
  "navigator.platform": { argTypes: [], result: STRING },
});
