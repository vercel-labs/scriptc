import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the fs module decided never to throw. */
export const fsNeverThrow: readonly IrLibFn[] = [
  // scr_fs_exists_bytes turns the path bytes into a string and probes it; a
  // path that is not there is the answer false, and the probe reports no
  // error.
  "fs.existsSyncBytes",
];
