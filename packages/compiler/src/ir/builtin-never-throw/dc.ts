import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the dc module decided never to throw. */
export const dcNeverThrow: readonly IrLibFn[] = [
  // publish runs every subscriber and catches its throw: like Node's
  // process.nextTick(triggerUncaughtException), the exception is delivered
  // on a later tick instead of leaving the call, so publish itself raises
  // nothing.
  "dc.publish",
  // scr_dc_has_subscribers answers false for a name that is neither a string
  // nor a symbol and compares its registry by name identity; no program code
  // runs.
  "dc.hasSubscribers",
  // scr_dc_chan_name retains the interned name string.
  "dc.chanName",
  // The tracing handles' reads compare registry entries and dispatch the
  // hasSubscribers conjunction.
  "dc.tcChannel",
  "dc.tcHasSubscribers",
  "dc.chanHasSubscribers",
];
