import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the http2 module decided never to throw. */
export const http2NeverThrow: readonly IrLibFn[] = [
  "http2.sessionOnPing",
  // A header-record listener registration: no listener runs inside the
  // call, and a registered callback cannot raise.
  "http2.streamOnTrailers",
  "http2.streamOnHeaders",
  "http2.streamOnWantTrailers",
  "http2.streamOnContinue",
  // Reads of the session's, the stream's or the request's state bits.
  "http2.sessionConnecting",
  "http2.streamHeadersSent",
  "http2.reqComplete",
  "http2.reqUrl",
  // The default settings packed: there is no record to validate.
  "http2.getPackedSettings0",
  // Copies the values a name has in a string pairs array.
  "http2.pairsValues",
  "http2.statusMessageUnsupported",
  "http2.statusMessageRead",
  "http2.streamEndAfterHeaders",
  "http2.streamBufferSize",
  "http2.reqAuthority",
  "http2.reqScheme",
  "http2.streamSentHeaders",
  "http2.streamSentInfoHeaders",
  "http2.streamSentTrailers",
  "http2.streamState",
];
