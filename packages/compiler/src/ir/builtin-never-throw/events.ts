import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the events module decided never to throw. */
export const eventsNeverThrow: readonly IrLibFn[] = [
  // scr_events_once_any turns every failure into the result promise's
  // rejection: an invalid options object or signal, an aborted signal, a
  // name that cannot key the registry, a throwing 'newListener' listener
  // (which it takes off the cell) and the awaited event's own 'error'. It
  // throws nothing to its caller.
  "events.onceAny",
];
