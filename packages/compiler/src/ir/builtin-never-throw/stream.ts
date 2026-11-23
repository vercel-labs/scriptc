import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the stream module decided never to throw. */
export const streamNeverThrow: readonly IrLibFn[] = [
  // Duplex.fromWeb's pair constructs the Duplexify and stores the flag.
  "stream.duplexifyPairHalf",
  // stream.getDefaultHighWaterMark reads the runtime's default for the mode:
  // no allocation, no coercion and no program code.
  "stream.getDefaultHwm",
  // The child stream's flowing state is set or read; held chunks go to the
  // listeners on a later tick, never inside the call.
  "stream.childPause",
  "stream.childResume",
  "stream.childIsPaused",
  "stream.childFlowing",
];
