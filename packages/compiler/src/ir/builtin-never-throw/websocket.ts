import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the websocket module decided never to throw. */
export const websocketNeverThrow: readonly IrLibFn[] = [
  // The handle tag test answers false for every value that is not a
  // WebSocket handle and runs no program code.
  "websocket.is",
];
