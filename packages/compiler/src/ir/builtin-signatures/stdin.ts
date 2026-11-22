import { BOOL, BYTES_U8, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The stdin builtin call slots. */
export const stdinSignatures = defineLibFnSignatures({
  /** process.stdin listener registration — stdin.on/once("data" | "end" |
   * "error", cb). args: [cb, once bool]. data callbacks: () => void or
   * (chunk: Uint8Array) => void; end: () => void; error: () => void or
   * (err: Error) => void (the child error adapters are reused). While a
   * data listener (or a parked for-await chunk promise) exists, stdin
   * keeps the loop alive — Node's flowing-stdin keep-alive. Never
   * throw. */
  "stdin.onData": { argTypes: [null, BOOL], result: VOID },
  "stdin.onEnd": { argTypes: [{ kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  "stdin.onError": { argTypes: [null, BOOL], result: VOID },
  /** process.stdin.on/once('keypress', cb) (scr_readline_tty.c): cb is the
   * listener as a checked-dynamic function, called with (str, key). */
  "stdin.onKeypress": { argTypes: [DYN, BOOL], result: VOID },
  /** process.stdin.on/once("readable", cb): the paused-mode event —
   * input stays buffered for read(), and the listener (no parameters)
   * runs on the next tick when input arrives while a read wanted more,
   * and once at EOF. Like a 'data' listener it keeps the loop alive
   * until EOF. Never throws. */
  "stdin.onReadable": { argTypes: [{ kind: "func", params: [], ret: VOID }, BOOL], result: VOID },
  /** process.stdin.pause()/resume(): Node's flowing flag. Buffered
   * input stops reaching 'data' listeners while paused and flows again
   * on resume. */
  "stdin.pause": { argTypes: [], result: VOID },
  "stdin.resume": { argTypes: [], result: VOID },
  /** process.stdin.isPaused() — true in paused mode, which a 'readable'
   * listener pins. */
  "stdin.isPaused": { argTypes: [], result: BOOL },
  /** process.stdin.readableLength — bytes buffered for read(). */
  "stdin.readableLength": { argTypes: [], result: F64 },
  /** process.stdin.read([size]): args [all bool, size]. Readable#read's
   * size coercion (parseInt, NaN reads everything held, non-positive
   * reads nothing) and its ERR_OUT_OF_RANGE above 1 GiB; the result is
   * the `Uint8Array | null` union (the emitter constructs it). */
  "stdin.read": { argTypes: [BOOL, F64], result: VOID },
  /** The for-await chunk source over process.stdin: no args, result
   * Promise<Uint8Array> (+1). Fulfills with the next arrived chunk; the
   * EMPTY bytes value is the done sentinel (POSIX reads never deliver
   * empty data chunks), which the for-await desugar turns into loop
   * exit. Never throws itself; awaiting it re-throws nothing (stdin
   * errors surface through 'error' listeners, not the iterator). */
  "stdin.nextChunk": { argTypes: [], result: { kind: "promise", inner: BYTES_U8 } },
});
