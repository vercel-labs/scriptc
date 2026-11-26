import { arrayOf, BOOL, BYTES_U8, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The fetch builtin call slots. */
export const fetchSignatures = defineLibFnSignatures({
  /** Native static fetch and its Web-platform companions. fetch.start
   * answers once the response head arrives; the response body readers
   * consume the native body stream. AbortSignal and ReadableStream values
   * are opaque checked-dynamic handles. */
  "fetch.start": { argTypes: [STRING, DYN], result: { kind: "promise", inner: DYN } },
  "fetch.responseNew": { argTypes: [DYN, DYN], result: DYN },
  "fetch.responseJsonStatic": { argTypes: [DYN, DYN], result: DYN },
  "fetch.responseLight": { argTypes: [DYN], result: arrayOf(STRING) },
  "fetch.responseError": { argTypes: [], result: DYN },
  "fetch.responseRedirect": { argTypes: [DYN, DYN], result: DYN },
  "fetch.input": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "fetch.function": { argTypes: [], result: DYN },
  "fetch.requestNew": { argTypes: [DYN, DYN], result: DYN },
  "fetch.headersNew": { argTypes: [DYN], result: DYN },
  "fetch.responseArrayBuffer": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "fetch.responseJson": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "fetch.responseText": { argTypes: [DYN], result: { kind: "promise", inner: STRING } },
  "fetch.responseBytes": { argTypes: [DYN], result: { kind: "promise", inner: BYTES_U8 } },
  "fetch.streamNew": { argTypes: [DYN], result: DYN },
  "fetch.transformNew": { argTypes: [], result: DYN },
  // Program-dependent iterable: typed arrays/bytes/string stay intact so
  // the native stream can pull lazily; checked-dynamic values are the
  // fallback. The libCall validator in validate.ts checks the closed set.
  "fetch.webIs": { argTypes: [DYN, STRING], result: BOOL },
  "fetch.streamIs": { argTypes: [DYN], result: BOOL },
  "fetch.streamFrom": { argTypes: [null], result: DYN },
  // The chunk/result record depends on ReadableStream<T>; validated by validate.ts.
  "fetch.readerRead": { argTypes: [DYN], result: VOID },
  /** Readable.fromWeb (scr_stream_from_web.c): the stream, objectMode,
   * highWaterMark (< 0: the mode's default) and encoding ("": none). */
  "fetch.readableFromWeb": { argTypes: [DYN, BOOL, F64, STRING], result: VOID },
});
