import type { IrLibFn } from "./builtin-signatures.js";

/** Builtins decided never to throw: the runtime function behind the call
 * cannot raise an error and cannot run program code (a getter, `toJSON`,
 * `valueOf`, `toString`, a proxy trap or a callback), under any argument.
 *
 * Every builtin states its answer once: a row in MAY_THROW_LIB_FNS
 * (builtin-effects.ts) or a row here. A builtin in neither is compiled
 * without the check that delivers its error, so the error is lost and the
 * caller reads a placeholder result. The compiler does not read this set;
 * packages/compiler/test/builtin-attributes.test.ts holds every builtin to
 * the rule, and builtin-throw-undecided.txt lists the builtins that
 * predate it. */
export const NEVER_THROW_LIB_FNS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  // scr_closure_adopt_identity writes two fields of the adapter.
  "closure.shareIdentity",
  // Emitted as the constant false; there is no runtime call.
  "sea.isSea",
  // Constants of the response's writable side (65536, false).
  "http.resWritableHighWaterMark",
  "http.resWritableObjectMode",
  // A listener is added to the request's or the session's list, or dropped
  // when the request or session is past the event; no listener runs.
  "http.clientOnConnect",
  "http.clientOnInformation",
  "http2.sessionOnPing",
  // Reads of the session's, the stream's or the request's state bits.
  "http2.sessionConnecting",
  "http2.streamHeadersSent",
  "http2.reqComplete",
  // The default settings packed: there is no record to validate.
  "http2.getPackedSettings0",
  // Copies the values a name has in a string pairs array.
  "http2.pairsValues",
  // The child stream's flowing state is set or read; held chunks go to the
  // listeners on a later tick, never inside the call.
  "stream.childPause",
  "stream.childResume",
  "stream.childIsPaused",
  "stream.childFlowing",
  // Builds the flags object once from constants and retains it.
  "process.features",
  // Stores the encoding's spelling beside the decoder setEncoding installed.
  "readable.encodingName",
  // scr_fs_exists_bytes turns the path bytes into a string and probes it; a
  // path that is not there is the answer false, and the probe reports no
  // error.
  "fs.existsSyncBytes",
]);
