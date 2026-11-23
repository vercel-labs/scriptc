import { F64, FSWATCHER_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The watcher builtin call slots. */
export const watcherSignatures = defineLibFnSignatures({
  "watcher.close": { argTypes: [FSWATCHER_T], result: VOID },
  "watcher.ref": { argTypes: [FSWATCHER_T], result: VOID },
  "watcher.unref": { argTypes: [FSWATCHER_T], result: VOID },
  // FSWatcher's EventEmitter surface: (receiver, event code, once|prepend
  // flags, listener) for on/once/addListener/prependListener/
  // prependOnceListener, and (receiver, event code, listener) for
  // off/removeListener. The listener's func type is program-dependent;
  // the null slot pins the arity and the receiver.
  "watcher.on": { argTypes: [FSWATCHER_T, F64, F64, null], result: VOID },
  "watcher.off": { argTypes: [FSWATCHER_T, F64, null], result: VOID },
});
