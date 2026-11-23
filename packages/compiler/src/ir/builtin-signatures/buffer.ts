import { arrayOf, BOOL, BYTES_U8, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The buffer builtin call slots. */
export const bufferSignatures = defineLibFnSignatures({
  /** buffer.resolveObjectURL(id): the id arrives as a checked value and
   * the runtime applies Node's ToString (a symbol throws), then answers
   * the registered Blob as a handle, or undefined when it names nothing. */
  "buffer.resolveObjectURL": { argTypes: [DYN], result: DYN },
  // The Buffer statics and the fs/zlib Buffer forms: fixed always-u8
  // signatures (Buffer IS a Uint8Array — one bytes kind).
  /** The Buffer statics with fixed (always-u8) signatures. fromStr is
   * `Buffer.from(string, enc)` — the frontend completes an omitted
   * encoding to "utf8" and fences non-literal/unsupported ones; hex and
   * base64 decode Node-leniently, so it never throws. concat takes ONE
   * bytes<u8>[] arg (the list) and returns a fresh copy. `Buffer.from(u8)`
   * and `Buffer.alloc(n)` need no libFn — they lower to bytesNew. */
  "buffer.fromStr": { argTypes: [STRING, STRING], result: BYTES_U8 },
  "buffer.fromStrChecked": { argTypes: [STRING, STRING], result: BYTES_U8 },
  "buffer.brand": { argTypes: [BYTES_U8], result: BYTES_U8 },
  /** Buffer.isBuffer over a typed view: whether the view carries the
   * Buffer brand (any element kind; only Buffers do). Never throws. */
  "buffer.isBranded": { argTypes: [null], result: BOOL },
  /** Buffer.from on checked-native strings, bytes, arrays and data-only
   * array-like/Buffer-JSON objects. The encoding is a normalized literal;
   * non-string inputs ignore it. Copies the input and may throw during
   * element coercion or argument validation. Custom object valueOf and
   * opaque reference inputs retain explicit runtime refusals. */
  "buffer.fromDyn": { argTypes: [DYN, STRING], result: BYTES_U8 },
  "buffer.concat": { argTypes: [arrayOf(BYTES_U8)], result: BYTES_U8 },
  "buffer.concatDyn": { argTypes: [DYN], result: BYTES_U8 },
  /** The pooled Buffer factories (Node's allocate/fromStringFast/
   * fromArrayLike): allocUnsafe, Buffer.from of strings, Uint8Arrays,
   * number[] and checked values, and concat return views into the
   * per-thread pool slab below Buffer.poolSize >>> 1 bytes. alloc and
   * allocUnsafeSlow never pool. The size forms validate like Node
   * (ERR_OUT_OF_RANGE). poolSize reads and writes Buffer.poolSize. */
  "buffer.alloc": { argTypes: [F64], result: BYTES_U8 },
  /** Buffer.alloc as a function value: the size, fill and encoding arrive
   * unchecked, and the runtime fills as Node's alloc does. */
  "buffer.allocValue": { argTypes: [DYN, DYN, DYN], result: BYTES_U8 },
  "buffer.allocUnsafe": { argTypes: [F64], result: BYTES_U8 },
  "buffer.allocUnsafeSlow": { argTypes: [F64], result: BYTES_U8 },
  "buffer.poolFromStr": { argTypes: [STRING, STRING], result: BYTES_U8 },
  "buffer.poolFromStrChecked": { argTypes: [STRING, STRING], result: BYTES_U8 },
  "buffer.poolFromBytes": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "buffer.poolFromArray": { argTypes: [arrayOf(F64)], result: BYTES_U8 },
  "buffer.poolFromDyn": { argTypes: [DYN, STRING], result: BYTES_U8 },
  /** poolFromDyn that also copies an array crossing by reference. */
  "buffer.poolFromDynRef": { argTypes: [DYN, STRING], result: BYTES_U8 },
  "buffer.poolFromDynOffset": { argTypes: [DYN, DYN], result: BYTES_U8 },
  /** Buffer.from(value, byteOffset, length): an ArrayBuffer's range with
   * Node's fromArrayBuffer checks; other values as poolFromDynOffset. */
  "buffer.poolFromDynRange": { argTypes: [DYN, DYN, DYN], result: BYTES_U8 },
  /** Buffer.copyBytesFrom(view[, offset[, length]]): a pooled Buffer
   * holding a copy of the view's underlying bytes over the element window
   * [offset, offset + length). The view is any typed array — its element
   * kind travels in the ScrBytes header and decides the byte count, so the
   * slot takes a program-dependent type. `mask` bit 0 marks a supplied
   * offset and bit 1 a supplied length; the runtime runs Node's
   * validation. */
  "buffer.copyBytesFrom": { argTypes: [null, F64, F64, F64], result: BYTES_U8 },
  "buffer.poolSize": { argTypes: [], result: F64 },
  "buffer.setPoolSize": { argTypes: [F64], result: VOID },
  /** Buffer.byteLength(string, enc) — enc a NORMALIZED literal like
   * fromStr's — and Buffer.isEncoding(name) over a runtime string
   * (case-insensitive against Node's alias set). Pure; never throw. */
  "buffer.byteLenDyn": { argTypes: [DYN, STRING], result: F64 },
  /** Buffer.byteLength as a function value: the encoding arrives at run time. */
  "buffer.byteLenValue": { argTypes: [DYN, DYN], result: F64 },
  "buffer.byteLenStr": { argTypes: [STRING, STRING], result: F64 },
  /** A run-time Buffer encoding name, normalized the way the method's
   * owner reads it. normalizeEncoding is Node's getEncodingOps (empty and
   * unknown names throw ERR_UNKNOWN_ENCODING); normalizeEncodingEmptyUtf8
   * is Node's normalizeEncoding (an empty name reads as utf8, unknown
   * names throw); normalizeEncodingOrUtf8 is Buffer.byteLength's read (an
   * unknown name counts as utf8, nothing throws). */
  "buffer.normalizeEncoding": { argTypes: [STRING], result: STRING },
  "buffer.normalizeEncodingEmptyUtf8": { argTypes: [STRING], result: STRING },
  "buffer.normalizeEncodingOrUtf8": { argTypes: [STRING], result: STRING },
  /** buf.write with an encoding name known only at run time: Node checks
   * the offset and length BEFORE it reads the name, so the raw value goes
   * to the runtime and the range errors win over an unknown name. */
  "buffer.writeStrDyn": { argTypes: [BYTES_U8, STRING, STRING, F64], result: F64 },
  "buffer.writeStrDynLen": { argTypes: [BYTES_U8, STRING, STRING, F64, F64], result: F64 },
  "buffer.isEncoding": { argTypes: [STRING], result: BOOL },
  /** Buffer.concat(list, totalLength): the concatenation truncated or
   * zero-padded to the total. THROWS Node's 'length' RangeError on a
   * negative/non-integer total (may-throw seed). */
  "buffer.concatLen": { argTypes: [arrayOf(BYTES_U8), F64], result: BYTES_U8 },
  "buffer.concatLenDyn": { argTypes: [DYN, F64], result: BYTES_U8 },
  "buffer.concatLenDynOpt": { argTypes: [DYN, DYN], result: BYTES_U8 },
  // The checked-dynamic compare/equals validators (Node's argument
  // ladders over dyn-boxed invalid-input probes).
  /** The checked-dynamic compare/equals validators (scr_bytes_io.c) —
   * the lowered form when an argument is NOT statically bytes<u8> (the
   * invalid-input probes; a dyn from an untyped JS helper): Node's own
   * argument ladders run at runtime — ERR_INVALID_ARG_TYPE with the
   * API's argument name ("buf1"/"buf2", "otherBuffer", "target"; offsets
   * "of type number"), validateOffset's ERR_OUT_OF_RANGE for bad
   * numbers, undefined offsets taking their Node defaults — and a
   * well-typed value still computes the real answer. All args borrowed
   * dyn; compareChk's four offset slots pass the undefined dyn when
   * syntactically absent. May-throw seeds. */
  "buffer.compareChk": { argTypes: [DYN, DYN], result: F64 },
  /** The deprecated `new Buffer(number, 'enc')` string-arm rejection:
   * always throws Node's ERR_INVALID_ARG_TYPE ("The \"string\" argument
   * must be of type string. Received ..."). Borrowed dyn; may-throw. */
  "buffer.newStringFail": { argTypes: [DYN], result: BYTES_U8 },
  "buffer.deprecation": { argTypes: [], result: VOID },
  "buffer.deprecationCount": { argTypes: [], result: VOID },
  "buffer.constructor": { argTypes: [], result: DYN },
  "buffer.installValue": { argTypes: [], result: VOID },
  "buffer.staticValue": { argTypes: [STRING], result: DYN },
  "buffer.prototypeMember": { argTypes: [DYN], result: DYN },
  "buffer.prototypeObject": { argTypes: [], result: DYN },
  "buffer.slowBuffer": { argTypes: [DYN], result: BYTES_U8 },
  "buffer.isAscii": { argTypes: [DYN], result: BOOL },
  "buffer.isUtf8": { argTypes: [DYN], result: BOOL },
  "buffer.transcode": { argTypes: [DYN, DYN, DYN], result: BYTES_U8 },
});
