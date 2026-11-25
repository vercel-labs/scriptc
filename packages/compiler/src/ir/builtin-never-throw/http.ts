import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the http module decided never to throw. */
export const httpNeverThrow: readonly IrLibFn[] = [
  // The OutgoingMessage write-buffer readers compare and sum stored byte
  // counts (the corked buffer's length, the held head's, the socket's
  // pending bytes) and a boolean flag; registering a 'drain' listener
  // appends to a list. None of them runs program code.
  // Appends a name and a string per element to the pair array; no program
  // code runs.
  "http.pairsAddList",
  "http.resWritableLength",
  "http.resWritableNeedDrain",
  "http.clientWritableLength",
  "http.clientWritableNeedDrain",
  "http.resOnDrain",
  "http.clientOnDrain",
  // Constants of the response's writable side (65536, false).
  "http.resWritableHighWaterMark",
  "http.resWritableObjectMode",
  // A listener is added to the request's or the session's list, or dropped
  // when the request or session is past the event; no listener runs.
  "http.clientOnConnect",
  "http.clientOnInformation",
  // scr_http_server_off drops the last entry of the event's listener list
  // that stands for the function; a function that is not in the list, or a
  // closed server, leaves the list as it is. No 'removeListener' event runs.
  "http.serverOff",
  "http.serverListeners",
  "http.clientMaxHeadersCountGet",
  "http.clientMaxHeadersCountSet",
];
