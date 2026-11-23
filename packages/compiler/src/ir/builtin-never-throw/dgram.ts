import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the dgram module decided never to throw. */
export const dgramNeverThrow: readonly IrLibFn[] = [
  // scr_dgram_async_dispose allocates the promise and registers the close
  // listener; the only failure is allocation, which aborts.
  "dgram.asyncDispose",
  // socket.type and `instanceof dgram.Socket`: pure reads, never throw.
  "dgram.type",
  "dgram.isSocket",
];
