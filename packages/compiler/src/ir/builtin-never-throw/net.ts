import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the net module decided never to throw. */
export const netNeverThrow: readonly IrLibFn[] = [
  // scr_net_server_listeners and scr_http_server_listeners copy the event's
  // listener list into a new array of the registered functions; running out
  // of memory ends the process.
  "net.serverListeners",
  // scr_net_is_bound_socket reads a dyn value's tag and handle pointer: a
  // value of another kind answers false. It runs no code.
  "net.isBoundSocket",
  // The header-limit properties are plain storage: the getters retain the
  // stored value (or answer null / 0) and the setters retain the new value
  // and release the old one. No accessor, coercion or listener runs, and
  // the HTTP layer reads the stored value when it parses a message.
  "net.serverMaxHeadersCountGet",
  "net.serverMaxHeadersCountSet",
  "net.serverMaxRequestsPerSocketGet",
  "net.serverMaxRequestsPerSocketSet",
  // The autoSelectFamily default is plain storage in the core unit: the
  // getter answers the stored boolean and runs nothing else.
  "net.getDefaultAutoSel",
  // socket.connect(path[, cb]): the idle socket starts the Unix dial; every
  // failure (a refused path included) is the async 'error' event, and the
  // connect listener is registered without running.
  "net.sockConnectPath",
  "net.sockConnectPathCb",
  // scr_net_sock_on_attempt adds the listener to the socket's attempt list
  // (or drops it past 'close'); no listener runs.
  "net.sockOnAttempt",
  // scr_net_sock_buffer_size and scr_net_sock_attempted_addresses read the
  // socket's write buffer and attempted-address list: no accessor runs.
  "net.sockBufferSize",
  "net.sockAttemptedAddresses",
  // scr_net_server_async_dispose allocates the promise, adds a close
  // listener and starts the close; a later close failure is a rejection.
  "net.serverAsyncDispose",
  // socket.timeout and socket.allowHalfOpen (scr_net.c): both getters read
  // the socket's own state — the stored timeout and the constructor's
  // half-open option — running no program code and raising nothing.
  "net.sockTimeoutGet",
  "net.sockAllowHalfOpen",
];
