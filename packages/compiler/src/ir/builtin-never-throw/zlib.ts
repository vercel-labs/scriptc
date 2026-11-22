import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the zlib module decided never to throw. */
export const zlibNeverThrow: readonly IrLibFn[] = [
  // scr_zlib_codec_promise_info and its dyn twin answer a promise: a
  // refused option or input is moved into it as a rejection, and running
  // out of memory ends the process, so no error escapes the call.
  "zlib.infoPromise",
  "zlib.infoPromiseDyn",
];
