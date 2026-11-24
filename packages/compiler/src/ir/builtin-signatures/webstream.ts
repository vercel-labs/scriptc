import { BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The webstream builtin call slots. */
export const webstreamSignatures = defineLibFnSignatures({
  /** Readable.toWeb (scr_stream_to_web.c): the readable and the option
   * flags (< 0: none); a web ReadableStream. */
  "webstream.toWebReadable": { argTypes: [null, F64], result: DYN },
  /** Readable.toWeb with an options strategy (scr_stream_to_web.c): the
   * readable, the option flags, and the strategy (undefined for none). */
  "webstream.toWebReadableOpts": { argTypes: [null, F64, DYN], result: DYN },
  /** Readable.toWeb over a checked-dynamic value: a boxed native stream
   * unwraps, anything else throws the not-supported Error. */
  "webstream.toWebReadableDyn": { argTypes: [DYN, F64], result: DYN },
  "webstream.toWebReadableDynOpts": { argTypes: [DYN, F64, DYN], result: DYN },
  /** Writable.fromWeb (scr_stream_from_web_writable.c): the web
   * WritableStream and the option flags; a Writable. */
  "webstream.writableFromWeb": { argTypes: [DYN, F64], result: VOID },
  /** Writable.fromWeb with options (scr_stream_from_web_writable.c): the web
   * stream, the option flags, the highWaterMark (-1 default), and the
   * signal (undefined when absent); a Writable. */
  "webstream.writableFromWebOpts": { argTypes: [DYN, F64, F64, DYN], result: VOID },
  /** Writable.toWeb (scr_stream_writable_to_web.c): the writable and the
   * option flags; a web WritableStream. */
  "webstream.writableToWeb": { argTypes: [null, F64], result: DYN },
  /** Duplex.fromWeb (scr_stream_duplex_from_web.c): the { readable,
   * writable } pair and the option flags; a Duplex. */
  "webstream.duplexFromWeb": { argTypes: [DYN, F64], result: VOID },
  /** Duplex.fromWeb with options (scr_stream_duplex_from_web.c): the pair,
   * the option flags, the highWaterMark (-1 default), the signal (undefined
   * when absent) and the encoding name ("" when absent); a Duplex. */
  "webstream.duplexFromWebOpts": { argTypes: [DYN, F64, F64, DYN, STRING], result: VOID },
  /** Duplex.toWeb (scr_stream_to_web_pair.c): the duplex and the option
   * flags; the { writable, readable } pair. */
  "webstream.toWebDuplex": { argTypes: [null, F64], result: DYN },
  /** Duplex.toWeb over a checked-dynamic value: a boxed native duplex
   * unwraps, anything else throws ERR_INVALID_ARG_TYPE. */
  "webstream.toWebDuplexDyn": { argTypes: [DYN, F64], result: DYN },
  "webstream.class": { argTypes: [F64], result: DYN },
  "webstream.from": { argTypes: [DYN], result: DYN },
  /** ReadableStreamTee(stream, cloneForBranch2) (scr_webstreams.c): the
   * two branches as an array (dyn), the second reading a structuredClone
   * of each chunk when cloneForBranch2 is truthy (undefined for absent). */
  "webstream.tee": { argTypes: [DYN, DYN], result: DYN },
  "webstream.instanceOf": { argTypes: [DYN, F64], result: BOOL },
  "webstream.install": { argTypes: [], result: VOID },
});
