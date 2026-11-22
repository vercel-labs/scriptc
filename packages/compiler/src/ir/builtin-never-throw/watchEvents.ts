import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the watchEvents module decided never to throw. */
export const watchEventsNeverThrow: readonly IrLibFn[] = [
  // watchEvents.wait builds a promise or answers a settled one, and
  // scr_watch_events_close closes an already-open watcher (a closed one
  // returns at once). Neither runs program code. watchEvents.take and
  // fsp.watch are deliberately absent: a queue over its bound raises
  // ERR_FS_WATCH_QUEUE_OVERFLOW, and opening the path throws Node's fs
  // error.
  "watchEvents.wait",
  "watchEvents.close",
];
