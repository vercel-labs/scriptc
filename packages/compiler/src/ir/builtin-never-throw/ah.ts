import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the ah module decided never to throw. */
export const ahNeverThrow: readonly IrLibFn[] = [
  // The AsyncHook flips and the execution-id reads touch the core's own
  // thread-local state; no program code runs and nothing raises.
  "ah.disable",
  "ah.enable",
  "ah.providers",
  "ah.executionId",
  "ah.executionResource",
  "ah.triggerId",
];
