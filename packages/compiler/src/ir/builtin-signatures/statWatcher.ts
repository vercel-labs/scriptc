import { STATWATCHER_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The statWatcher builtin call slots. */
export const statWatcherSignatures = defineLibFnSignatures({
  "statWatcher.ref": { argTypes: [STATWATCHER_T], result: VOID },
  "statWatcher.unref": { argTypes: [STATWATCHER_T], result: VOID },
});
