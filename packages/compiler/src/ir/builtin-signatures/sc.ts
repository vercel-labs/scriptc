import { BYTES_U8, DYN, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The sc builtin call slots. */
export const scSignatures = defineLibFnSignatures({
  /** node:stream/consumers — the promise consumers over the readable
   * machinery: (s) → a pending promise settled at the terminal point
   * with the accumulated result (sc.text: the utf8 decode, sc.json: the
   * parsed dyn — malformed input rejects with the parse's SyntaxError,
   * sc.buffer: the concatenated bytes, sc.arrayBuffer: an ArrayBuffer
   * dyn over them) or rejected with the stream's
   * error / ERR_STREAM_PREMATURE_CLOSE. */
  "sc.text": { argTypes: [null], result: { kind: "promise", inner: STRING } },
  "sc.json": { argTypes: [null], result: { kind: "promise", inner: DYN } },
  "sc.buffer": { argTypes: [null], result: { kind: "promise", inner: BYTES_U8 } },
  /** blob(stream): the concatenated chunks as a Blob (dyn). */
  "sc.blob": { argTypes: [null], result: { kind: "promise", inner: DYN } },
  /** bytes(stream): sc.buffer's bytes as a plain Uint8Array. */
  "sc.bytes": { argTypes: [null], result: { kind: "promise", inner: BYTES_U8 } },
  "sc.arrayBuffer": { argTypes: [null], result: { kind: "promise", inner: DYN } },
});
