import { BOOL, PROCSTREAM_T, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The procStream builtin call slots. */
export const procStreamSignatures = defineLibFnSignatures({
  /** The first-class WritableStream write (`output.write(line)` — the
   * prefixStream idiom): the receiver IS the fd scalar (process.stdout/
   * stderr reads mint 1/2), dispatched onto the exact stdoutWrite/
   * stderrWrite paths so buffering and ordering stay identical. Data
   * borrowed; the bool is Node's always-true backpressure signal. */
  "procStream.write": { argTypes: [PROCSTREAM_T, STRING], result: BOOL },
});
