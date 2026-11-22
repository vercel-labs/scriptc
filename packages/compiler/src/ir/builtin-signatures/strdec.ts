import { BYTES_U8, DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The strdec builtin call slots. */
export const strdecSignatures = defineLibFnSignatures({
  /** node:string_decoder's utf8 StringDecoder (scr_string.c): the decoder
   * value is a one-field record whose f64 PACKS the pending partial
   * sequence (count + up to 3 raw bytes — Node buffers at most 3 for
   * every encoding); the frontend's interned %strdec helpers thread it,
   * with the decoder's CANONICAL encoding name first, through these pure
   * functions. write: (enc, pending, chunk) → the decoded complete
   * prefix of pending+chunk (+1); next: (enc, pending, chunk) → the
   * packed NEW pending; end: (enc, pending) → the buffered partial's
   * flush (+1). Node-exact per encoding (oracle-pinned); none throws. */
  "strdec.write": { argTypes: [STRING, F64, BYTES_U8], result: STRING },
  /** The checked-dynamic chunk forms (a stream "data" payload): a string
   * passes through unchanged without touching the buffered state, an
   * ArrayBufferView decodes, anything else throws ERR_INVALID_ARG_TYPE. */
  "strdec.writeDyn": { argTypes: [STRING, F64, DYN], result: STRING },
  "strdec.nextDyn": { argTypes: [STRING, F64, DYN], result: F64 },
  "strdec.next": { argTypes: [STRING, F64, BYTES_U8], result: F64 },
  "strdec.end": { argTypes: [STRING, F64], result: STRING },
  /** A runtime encoding argument's canonical name (Node's normalizeEncoding:
   * nullish and "" are utf8); an unknown name throws ERR_UNKNOWN_ENCODING. */
  "strdec.encoding": { argTypes: [DYN], result: STRING },
  /** The same for an encoding that may not be a string (scr_inspect.c):
   * an object whose `length` is 3 to 9 matches by its string in lower
   * case; other values throw ERR_UNKNOWN_ENCODING formatted with %s. */
  "strdec.encodingValue": { argTypes: [DYN], result: STRING },
});
