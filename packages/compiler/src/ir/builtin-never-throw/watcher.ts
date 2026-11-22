import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the watcher module decided never to throw. */
export const watcherNeverThrow: readonly IrLibFn[] = [
  // scr_watcher_ref / scr_watcher_unref move one open watcher's loop-liveness
  // flag; a closed watcher ignores them, and nothing user-visible runs.
  "watcher.ref",
  "watcher.unref",
];
