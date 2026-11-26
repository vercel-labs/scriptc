import { BOOL, BYTES_U8, DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The text builtin call slots. */
export const textSignatures = defineLibFnSignatures({
  /** WHATWG TextDecoder.decode over u8 bytes (scr_bytes.c): utf-8 with
   * default options — the same maximal-subpart replacement decode as
   * Buffer.toString("utf8"), with the leading BOM stripped (the one
   * behavioral difference; ignoreBOM defaults to false). Inline calls
   * lower directly; stored decoder records dispatch by encoding id.
   * TextEncoder.encode needs no libFn: its matching forms
   * lower to buffer.fromStr(s, "utf8") (identical bytes — both write each
   * lone surrogate as U+FFFD). Borrowed arg; owned (+1) string; never throws. */
  "text.decode": { argTypes: [BYTES_U8], result: STRING },
  "text.decoderInput": { argTypes: [DYN, F64, DYN, BOOL], result: BYTES_U8 },
  "text.decoderFlag": { argTypes: [DYN, STRING], result: BOOL },
  "text.decodeStreamOption": { argTypes: [DYN], result: BOOL },
  "text.encodeInput": { argTypes: [DYN], result: STRING },
  "text.decoderEncodingOptions": { argTypes: [DYN, DYN], result: F64 },
  "text.decodeBufferSource": { argTypes: [DYN], result: STRING },
  "text.decodeOptions": { argTypes: [BYTES_U8, BOOL, BOOL], result: STRING },
  "text.decodeStream": { argTypes: [DYN, BYTES_U8, F64, BOOL, BOOL, BOOL], result: STRING },
  "text.decodeLegacyOptions": { argTypes: [BYTES_U8, F64, BOOL, BOOL], result: STRING },
  /** TextDecoder.decode for a compile-time non-UTF-8 WHATWG label. The
   * second f64 is the frontend-owned encoding id consumed by scr_bytes.c;
   * label aliases/case/ASCII whitespace are canonicalized before IR. The
   * mapping tables are generated from the pinned Node 24 oracle, keeping
   * output portable without an ICU/iconv dependency. Borrowed args; owned
   * (+1) string; never throws. */
  "text.decodeLegacy": { argTypes: [BYTES_U8, F64], result: STRING },
  "text.decoderEncoding": { argTypes: [DYN], result: F64 },
  "text.decoderName": { argTypes: [F64], result: STRING },
  "text.encodeInto": { argTypes: [DYN, DYN], result: DYN },
  /** TextEncoder.encodeInto over a statically typed string and Uint8Array:
   * scr_bytes.c's typed entry, which boxes nothing. Borrowed args; the
   * result is the call site's own `{ read, written }` record (the backend
   * fills it from two slots), so the signature names none. */
  "text.encodeIntoStr": { argTypes: [STRING, BYTES_U8], result: DYN },
  /** `value instanceof TextDecoder` (true) or `TextEncoder` (false) on a
   * checked-dynamic value: a codec record's handle box (scr_text_codec_dyn.c).
   * Borrowed; never throws. */
  "text.codecIs": { argTypes: [DYN, BOOL], result: BOOL },
});
