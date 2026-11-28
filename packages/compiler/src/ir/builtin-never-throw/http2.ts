import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the http2 module decided never to throw. */
export const http2NeverThrow: readonly IrLibFn[] = [
  "http2.sessionOnPing",
  // createServer with the connect-protocol setting already lowered to a
  // bool: the server is allocated and the flag stored, nothing validates
  // and no program code runs; the eager-handler form adds the handler to
  // the request list the same way.
  "http2.createServerOpts",
  "http2.createServerReqOpts",
  // A header-record listener registration: no listener runs inside the
  // call, and a registered callback cannot raise.
  "http2.streamOnTrailers",
  "http2.streamOnHeaders",
  "http2.streamOnWantTrailers",
  "http2.streamOnContinue",
  // The 'ready'/'timeout' registrations: no listener runs inside the call,
  // and a destroyed stream just releases the callback.
  "http2.streamOnReady",
  "http2.streamOnTimeout",
  // Arming the stream's idle timer: no value is validated and no program
  // code runs inside the call (the callback runs when the timer fires).
  "http2.streamSetTimeout",
  "http2.streamSetTimeoutCb",
  // priority() only schedules the one-time DEP0194 warning a tick later.
  "http2.streamPriority",
  "http2.streamPriority0",
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
  // The connect-protocol server constructors: they create the server and
  // put the eager handler into internal lists; no listener runs inside the
  // call, and a failed allocation ends the process.
  "http2.createServerOpts",
  "http2.createServerReqOpts",
  // The stream's ready/timeout listeners and its idle timer: internal list
  // inserts and a timer arm, no user code inside the call.
  "http2.streamOnReady",
  "http2.streamOnTimeout",
  "http2.streamSetTimeout",
  "http2.streamSetTimeoutCb",
  // DEP0194 is scheduled on the next tick, so the warning, and any
  // 'warning' listener it reaches, runs after the call returned.
  "http2.streamPriority",
  "http2.streamPriority0",
  // The session's timeout listener and its ref state: an internal list
  // insert and a refcount change — no user code runs inside the call, and a
  // failed allocation ends the process.
  "http2.sessionOnTimeout",
  "http2.sessionRef",
  "http2.sessionUnref",
];
