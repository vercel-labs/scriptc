import { BOOL, BYTES_U8, DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The blob builtin call slots. */
export const blobSignatures = defineLibFnSignatures({
  /** Blob / File (scr_blob.c): the constructors and slice() take their
   * argument vector as one dyn array and throw Node's validation errors;
   * the readers settle on Node's microtask turn for the Blob's parts.
   * `blob.is` is `v instanceof Blob` (kind 0) or `File` (1). */
  "blob.new": { argTypes: [DYN], result: DYN },
  "blob.fileNew": { argTypes: [DYN], result: DYN },
  "blob.slice": { argTypes: [DYN, DYN], result: DYN },
  "blob.text": { argTypes: [DYN], result: { kind: "promise", inner: STRING } },
  "blob.bytes": { argTypes: [DYN], result: { kind: "promise", inner: BYTES_U8 } },
  "blob.arrayBuffer": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "blob.is": { argTypes: [DYN, F64], result: BOOL },
});
