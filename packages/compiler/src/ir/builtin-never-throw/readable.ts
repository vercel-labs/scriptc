import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the readable module decided never to throw. */
export const readableNeverThrow: readonly IrLibFn[] = [
  // Stores the encoding's spelling beside the decoder setEncoding installed.
  // readable.iterator builds the async iterator object; its members run later.
  "readable.iterator",
  "readable.encodingName",
];
