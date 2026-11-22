import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the statWatcher module decided never to throw. */
export const statWatcherNeverThrow: readonly IrLibFn[] = [
  // scr_stat_watcher_ref / scr_stat_watcher_unref move one registration's
  // liveness flag; a registration fs.unwatchFile already removed is a no-op.
  "statWatcher.ref",
  "statWatcher.unref",
];
