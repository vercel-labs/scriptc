import { DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The constants builtin call slots. */
export const constantsSignatures = defineLibFnSignatures({
  /** The deprecated node:constants object (scr_os.c): the os groups and
   * fs.constants merged with the borrowed baked crypto.constants table,
   * frozen, one per thread. */
  "constants.object": { argTypes: [DYN], result: DYN },
});
