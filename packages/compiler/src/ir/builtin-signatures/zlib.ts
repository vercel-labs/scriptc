import { BOOL, BYTES_U8, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The zlib builtin call slots. */
export const zlibSignatures = defineLibFnSignatures({
  /** node:zlib (scr_zlib.c — native-toolchain.ts compiles/links it ONLY when these
   * appear on the IR, the regex/libcurl gating precedent): one-shot zlib,
   * raw-DEFLATE, gzip, and auto-detect codecs over u8 bytes with Node's
   * default options, or a validated literal compression level from -1 to 9.
   * Compression never throws (OOM aborts); decompression
   * of corrupt input THROWS Node's error catchably. */
  "zlib.deflateSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.inflateSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.deflateRawSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  /** bytes, mode (0 zlib / 1 raw / 2 gzip), validated compression level. */
  "zlib.deflateLevelSync": { argTypes: [BYTES_U8, F64, F64], result: BYTES_U8 },
  "zlib.inflateRawSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.gzipSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.gunzipSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  "zlib.unzipSync": { argTypes: [BYTES_U8], result: BYTES_U8 },
  /** The default-options callback twins run on the executable's shared
   * native work pool and deliver (Error | null, Buffer) on a later loop
   * turn. crc32 validates its optional uint32 seed synchronously. */
  "zlib.deflateCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.inflateCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.deflateRawCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.inflateRawCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.gzipCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.gunzipCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.unzipCb": { argTypes: [BYTES_U8, null], result: VOID },
  "zlib.crc32": { argTypes: [BYTES_U8, F64], result: F64 },
  /** The one-shot forms with an options value: node_zlib_mode, the input,
   * the options (validated at runtime with Node's ladder). The Cb form
   * takes the program-shaped (Error | null, Buffer) callback, which moves. */
  "zlib.syncOpts": { argTypes: [F64, BYTES_U8, DYN], result: BYTES_U8 },
  "zlib.cbOpts": { argTypes: [F64, BYTES_U8, DYN, null], result: VOID },
  /** The checked-dynamic input twins (the JS lane's untyped data). */
  "zlib.syncOptsDyn": { argTypes: [F64, DYN, DYN], result: BYTES_U8 },
  "zlib.cbOptsDyn": { argTypes: [F64, DYN, DYN, null], result: VOID },
  /** util.promisify over the callback one-shots: [mode, data, options]
   * like zlib.cbOpts → a promise the worker-pool run settles with the
   * Buffer or the callback form's Error. An options or input error rejects
   * it; never throws. The Dyn twin takes the JS lane's untyped data. */
  "zlib.promise": {
    argTypes: [F64, BYTES_U8, DYN],
    result: { kind: "promise", inner: BYTES_U8 },
  },
  "zlib.promiseDyn": { argTypes: [F64, DYN, DYN], result: { kind: "promise", inner: BYTES_U8 } },
  /** Node's `info: true` results: the same one-shot runs, answering the
   * { buffer, engine } checked object instead of the Buffer. The Cb form
   * hands its (Error | null, { buffer, engine }) callback the checked
   * value; the promise form settles with it. The Dyn twins take the JS
   * lane's untyped data. */
  "zlib.infoSync": { argTypes: [F64, BYTES_U8, DYN], result: DYN },
  "zlib.infoCb": { argTypes: [F64, BYTES_U8, DYN, null], result: VOID },
  "zlib.infoSyncDyn": { argTypes: [F64, DYN, DYN], result: DYN },
  "zlib.infoCbDyn": { argTypes: [F64, DYN, DYN, null], result: VOID },
  "zlib.infoPromise": { argTypes: [F64, BYTES_U8, DYN], result: { kind: "promise", inner: DYN } },
  "zlib.infoPromiseDyn": { argTypes: [F64, DYN, DYN], result: { kind: "promise", inner: DYN } },
  /** The stream classes (scr_zlib_stream.c, linked with the stream unit):
   * streamNew takes Node's node_zlib_mode number and the options value
   * (undefined when absent), validates it with Node's ladder, and answers
   * the +1 %Transform stream. flush takes the kind value, params the level
   * and strategy values; the Cb forms move their () => void callback. The
   * receivers are borrowed. */
  /** Connects scr_brotli.c to the zlib engine (%main, before any module). */
  "zlib.brotliInstall": { argTypes: [], result: VOID },
  /** Connects scr_zstd.c the same way. */
  "zlib.zstdInstall": { argTypes: [], result: VOID },
  "zlib.streamNew": { argTypes: [F64, DYN], result: VOID },
  "zlib.streamBytesWritten": { argTypes: [null], result: F64 },
  /** `stream instanceof zlib.Gzip`: the borrowed stream and the class's
   * node_zlib_mode; true when the stream is a zlib stream of that mode. */
  "zlib.streamIs": { argTypes: [null, F64], result: BOOL },
  "zlib.streamFlush": { argTypes: [null, DYN], result: VOID },
  "zlib.streamFlushCb": { argTypes: [null, DYN, null], result: VOID },
  "zlib.streamParams": { argTypes: [null, DYN, DYN], result: VOID },
  "zlib.streamParamsCb": { argTypes: [null, DYN, DYN, null], result: VOID },
  "zlib.streamClose": { argTypes: [null], result: VOID },
  "zlib.streamCloseCb": { argTypes: [null, null], result: VOID },
  "zlib.streamReset": { argTypes: [null], result: VOID },
});
