import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the util module decided never to throw. */
export const utilNeverThrow: readonly IrLibFn[] = [
  // scr_util_transferable_abort_controller allocates a controller and its
  // signal state; running out of memory ends the process, and no argument
  // is read (surplus arguments are evaluated by the call site).
  "util.transferableAbortController",
  // scr_util_set_trace_sig_int reads no argument and answers undefined; it
  // has no observable effect in a compiled program (the hook it toggles
  // feeds Node's --trace-sigint diagnostics).
  "util.setTraceSigInt",
];
