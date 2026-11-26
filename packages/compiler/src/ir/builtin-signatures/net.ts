import {
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  HTTPRES_T,
  NETSERVER_T,
  NETSOCKET_T,
  STRING,
  VOID,
} from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The net builtin call slots. */
export const netSignatures = defineLibFnSignatures({
  /** net's process-wide happy-eyeballs attempt budget (Node's default
   * 250ms): one runtime double in the core unit, so reading/writing it
   * never forces the net unit into the link. setDefaultAutoSelectFamily
   * throws Node's ERR_INVALID_ARG_TYPE for a non-boolean value. */
  "net.getAutoSelTimeout": { argTypes: [], result: F64 },
  /** setDefaultAutoSelectFamilyAttemptTimeout(value): Node's
   * validateInt32 ladder runs over the checked-dynamic value, so a
   * non-number throws ERR_INVALID_ARG_TYPE instead of a lowering
   * refusal (the validateBoolean twin above). */
  "net.setAutoSelTimeout": { argTypes: [DYN], result: VOID },
  /** net.getDefaultAutoSelectFamily()/setDefaultAutoSelectFamily(value):
   * Node's process-wide boolean (true by default). The value crosses as a
   * dyn so the runtime can raise the same TypeError Node does. */
  "net.getDefaultAutoSel": { argTypes: [], result: BOOL },
  "net.setDefaultAutoSel": { argTypes: [DYN], result: VOID },
  // node:net (scr_net.c). Listener slots are program-dependent closures —
  // null slots, checked in the libCall case (the child.onExit precedent);
  // the zero-param callbacks pin the exact func type here. The trailing
  // BOOL on registrations is the once flag.
  /** node:net (scr_net.c — linked, and scr_net_install() emitted, only
   * when one of these appears on the IR; moduleUsesNet is the switch).
   * Receivers are borrowed; CALLBACKS MOVE into the handle's listener
   * registry and are released at settlement (the child.onExit story).
   * All listener registrations carry a trailing BOOL once-flag (`on` vs
   * `once`) and are void — chaining is fenced. None of these throw:
   * listen/connect failures are the async 'error' event, like Node.
   *
   * net.createServer's optional connection handler and the
   * serverOnConnection listeners take the runtime-provided adapters
   * (zero-param, or the one-param socket shape); sockOnData's adapters
   * are the stdin pair's shapes (zero-param / bytes chunk); the error
   * events reuse the child %Error adapters. net.listen/net.listenCb bind
   * NOW and defer 'listening' to the next loop turn (Node's next-tick
   * emit); net.serverPort is the composed `server.address().port` read.
   * net.connect's host argument is a string ("localhost" pins to
   * 127.0.0.1 — SEMANTICS.md); the connect callback is once('connect'). */
  "net.createServer": { argTypes: [], result: NETSERVER_T },
  "net.createServerCb": { argTypes: [null], result: NETSERVER_T },
  /** net.createServer(options[, listener]): Node's ServerOpts over every
   * accepted socket (allowHalfOpen, pauseOnConnect, noDelay, keepAlive,
   * keepAliveInitialDelay, highWaterMark, blockList). The record crosses
   * as a checked-dynamic value; the option ladders throw Node's errors.
   * MAY THROW. */
  "net.createServerOpts": { argTypes: [DYN], result: NETSERVER_T },
  "net.createServerOptsCb": { argTypes: [DYN, null], result: NETSERVER_T },
  "net.listen": { argTypes: [NETSERVER_T, F64], result: VOID },
  /** listen(path[, cb]): a Unix-socket server; the socket file is removed
   * when the server closes. Failures are the async 'error'. */
  "net.listenPath": { argTypes: [NETSERVER_T, STRING], result: VOID },
  "net.listenPathCb": {
    argTypes: [NETSERVER_T, STRING, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.listenCb": {
    argTypes: [NETSERVER_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  /** listen({ port, host, ipv6Only }[, cb]) — the explicit-interface bind
   * (portless's listenOnProxyInterface): args [server, port, host,
   * ipv6Only]. host is an IP literal string ("" = the host-less
   * dual-stack any default); ipv6Only sets IPV6_V6ONLY before the bind.
   * These are the old-shaped calls, retained for omitted reusePort so
   * serialized IR remains compatible. Failures are the async 'error',
   * message in Node's listen shape with the requested host. Never throws. */
  "net.listenOpts": { argTypes: [NETSERVER_T, F64, STRING, BOOL], result: VOID },
  // The callback slot is a zero-param void closure OR its
  // `(() => void) | undefined` optional-binding union (checked specially).
  "net.listenOptsCb": { argTypes: [NETSERVER_T, F64, STRING, BOOL, null], result: VOID },
  /** Additive ABI for listen({ ..., reusePort }) — args
   * [server, port, host, ipv6Only, reusePort], with the callback following
   * those values in the callback form. The final BOOL is the requested
   * kernel connection-distribution option; old spellings remain
   * four/five-argument calls so serialized IR stays compatible. */
  "net.listenOptsReusePort": { argTypes: [NETSERVER_T, F64, STRING, BOOL, BOOL], result: VOID },
  // The callback is a zero-param void closure OR its optional-binding union;
  // the callback follows the reusePort BOOL in this additive ABI.
  "net.listenOptsReusePortCb": {
    argTypes: [NETSERVER_T, F64, STRING, BOOL, BOOL, null],
    result: VOID,
  },
  /** Server.prototype.listen over dynamic arguments: args [server, arg0,
   * arg1, arg2, fence]. The runtime runs Node's normalizeArgs (a function,
   * null or undefined port binds an unused one; a pipe-name string is the
   * path; an object is the option bag), the already-listening check, the
   * callback registration, the bound-socket adoption, then the bag's
   * signal, fd, port and path in Node's order (with backlog, ipv6Only and
   * reusePort). An adopted TCP handle or an unmodeled form reaches the
   * compiler-rendered fence after its validation. May-throw seed. */
  "net.listenDyn": { argTypes: [NETSERVER_T, DYN, DYN, DYN, STRING], result: VOID },
  // The same with a statically function-typed listen callback peeled off.
  "net.listenDynCb": {
    argTypes: [NETSERVER_T, DYN, DYN, DYN, { kind: "func", params: [], ret: VOID }, STRING],
    result: VOID,
  },
  "net.serverPort": { argTypes: [NETSERVER_T], result: F64 },
  "net.serverListening": { argTypes: [NETSERVER_T], result: BOOL },
  /** socket.ref()/unref() and server.ref()/unref(): whether the handle
   * keeps the event loop alive. */
  "net.sockSetRef": { argTypes: [NETSOCKET_T, BOOL], result: VOID },
  "net.serverSetRef": { argTypes: [NETSERVER_T, BOOL], result: VOID },
  // net.serverAddress's record result is shape-checked in the libCall case
  // (the dgram.address sentinel pattern).
  /** server.address() as the full AddressInfo record (the dgram.address
   * materialization pattern: the emitter builds the record from the three
   * runtime reads; the frontend pinned the shape). Never throws — before
   * listen it answers the any-form defaults with port 0 where Node
   * answers null (the serverPort stance). */
  "net.serverAddress": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverClose": { argTypes: [NETSERVER_T], result: VOID },
  /** server.close((err) => ...): the callback (a dyn function) gets
   * undefined once the server closes, or Node's ERR_SERVER_NOT_RUNNING
   * when it was not listening. */
  "net.serverCloseDyn": { argTypes: [NETSERVER_T, DYN], result: VOID },
  /** server.address() in programs that may listen on a Unix socket: the
   * path a listening server answers ("" for a TCP server), and the check
   * a record-typed address() makes first (throws for a Unix server). */
  "net.serverUnixPath": { argTypes: [NETSERVER_T], result: STRING },
  "net.serverAddressCheck": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverCloseCb": {
    argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.serverOnError": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "net.serverOnClose": {
    argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.serverOnConnection": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** server.off(event, listener) / removeListener: [server, listener
   * closure, list kind]. The kind selects the event's registry (1 error,
   * 2 close, 3 listening, 4 connection/secureConnection, 5 timeout,
   * 6 drop, 7 newListener — the scr_net.h SCR_NET_OFF_* values); Node
   * removes the most recently added matching listener. Never throws. */
  "net.serverOff": { argTypes: [NETSERVER_T, null, F64], result: VOID },
  /** server.listeners(event): [server, list kind] — a +1 closure array
   * of the event's listeners in registration order (the same kinds as
   * net.serverOff). */
  "net.serverListeners": { argTypes: [NETSERVER_T, F64], result: VOID },
  /** server.on('newListener', listener): Node's meta event, fired with
   * the event name BEFORE a listener joins its list; a throwing handler
   * abandons the add. */
  "net.serverOnNewListener": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** 'secureConnection' — the TLS server's deferred 'connection' list
   * (handshake-completion timing); on a server without deferred
   * connections (a plain net server) the registration never fires,
   * exactly Node's split. */
  "net.serverOnSecureConnection": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "net.connect": { argTypes: [F64, STRING], result: NETSOCKET_T },
  /** connect with a validated autoSelectFamilyAttemptTimeout option (the
   * budget runs Node's validateInt32-from-1 ladder and is then inert —
   * the single dial has nothing to time). May-throw. */
  "net.connectAttempt": { argTypes: [F64, STRING, DYN], result: NETSOCKET_T },
  /** new net.Socket([options]): an unconnected socket. args [options,
   * fence]; allowHalfOpen and signal lower, a descriptor (a number
   * argument or options.fd) and the readable/writable sides throw the
   * caller-rendered fence. May-throw seed. */
  "net.socketNew": { argTypes: [DYN, STRING, BOOL], result: NETSOCKET_T },
  /** net.connect/createConnection over dynamic arguments (a runtime
   * option bag, or positional values whose kinds only the run decides):
   * args [arg0, arg1, arg2, fence]. The runtime runs Node's normalizeArgs
   * — the Socket constructor's option ladder, net.connect's timeout, the
   * missing-argument check and lookupAndConnect's validation — then dials
   * with the options it models; a caller-supplied lookup or an adopted
   * handle reaches the compiler-rendered fence after its validation.
   * May-throw seed. */
  "net.connectDyn": { argTypes: [DYN, DYN, DYN, STRING], result: NETSOCKET_T },
  // The same with a statically function-typed connect listener peeled off
  // (Node's normalizeArgs takes the last argument as the callback).
  "net.connectDynCb": {
    argTypes: [DYN, DYN, DYN, { kind: "func", params: [], ret: VOID }, STRING],
    result: NETSOCKET_T,
  },
  "net.listenPortDyn": { argTypes: [DYN, STRING], result: F64 },
  "net.connectCb": {
    argTypes: [F64, STRING, { kind: "func", params: [], ret: VOID }],
    result: NETSOCKET_T,
  },
  /** net.connect/createConnection(path[, connectListener]) and the
   * `path` option: a client of the Unix socket at `path`. With the flag
   * (a positional string), Node's isPipeName applies first: a string that
   * reads as a non-negative number is a localhost port. */
  "net.connectPath": { argTypes: [STRING, BOOL], result: NETSOCKET_T },
  "net.connectPathCb": {
    argTypes: [STRING, BOOL, { kind: "func", params: [], ret: VOID }],
    result: NETSOCKET_T,
  },
  // The lookup's exact func shape is program data (its answer callback's
  // union/record types) — checked specially in the libCall case.
  /** connect({ port, host, autoSelectFamily: true, lookup }) — the
   * caller-resolver dial (portless's createLoopbackConnection): args
   * [port, host, lookup]. The runtime creates the (connecting) socket
   * handle, invokes the lookup as Node does — lookup(hostname, options,
   * callback), options crossing as the dyn undefined — and the answer
   * closure (an emitter-synthesized per-shape thunk over a boxed socket,
   * the SNI-answer pattern) dials the answered addresses IN ORDER: each
   * connect failure tries the next, the LAST failure's message is the
   * socket's 'error' (Node's autoSelectFamily aggregate is a documented
   * divergence), and a lookup error surfaces as the deferred socket
   * 'error'. A synchronous throw INSIDE the lookup propagates out of the
   * connect call (may-throw seed). */
  "net.connectLookup": { argTypes: [F64, STRING, null, DYN], result: NETSOCKET_T },
  /** connect({ host, port, lookup }) with a lookup of Node's own type, as
   * a checked-dynamic function: the runtime calls it with { hints, all:
   * true } and a callback taking an address string or list, then dials
   * the answers in order. MAY THROW (host validation, a lookup throw). */
  "net.connectLookupDyn": { argTypes: [F64, STRING, DYN, DYN], result: NETSOCKET_T },
  /** socket.write: Node's Writable answer — false when the writes not yet
   * completely sent, each counted in full, reach the 65536-byte
   * high-water mark ('drain' follows), and on an ended or closed socket. */
  "net.sockWrite": { argTypes: [NETSOCKET_T, STRING], result: BOOL },
  "net.sockWriteBytes": { argTypes: [NETSOCKET_T, BYTES_U8], result: BOOL },
  "net.sockEnd": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockEndStr": { argTypes: [NETSOCKET_T, STRING], result: VOID },
  "net.sockEndBytes": { argTypes: [NETSOCKET_T, BYTES_U8], result: VOID },
  /** write/end with a CHECKED-DYNAMIC chunk (an untyped JS payload into a
   * typed socket): the runtime dispatches STR/BYTES and throws Node's
   * ERR_INVALID_ARG_TYPE chunk TypeError on any other kind. */
  "net.sockWriteDyn": { argTypes: [NETSOCKET_T, DYN], result: BOOL },
  "net.sockEndDyn": { argTypes: [NETSOCKET_T, DYN], result: VOID },
  "net.sockDestroy": { argTypes: [NETSOCKET_T], result: VOID },
  "net.sockPipe": { argTypes: [NETSOCKET_T, NETSOCKET_T], result: VOID },
  /** socket.pipe(res) — raw socket chunks into a ServerResponse body
   * (the extended-CONNECT bridge leg): each chunk is a body write (the
   * response's own framing applies); source EOF end()s the response,
   * pipe's default. Borrows both. Never throws. */
  "net.sockPipeRes": { argTypes: [NETSOCKET_T, HTTPRES_T], result: VOID },
  "net.sockOnData": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  "net.sockOnEnd": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.sockOnClose": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.sockOnError": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  "net.sockOnConnect": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  /** server.maxHeadersCount / server.maxRequestsPerSocket — ordinary
   * writable properties (any value is kept as assigned; only a number
   * counts), so reads and writes cross the dyn tier. */
  "net.serverMaxHeadersCountGet": { argTypes: [NETSERVER_T], result: DYN },
  "net.serverMaxHeadersCountSet": { argTypes: [NETSERVER_T, DYN], result: VOID },
  "net.serverMaxRequestsPerSocketGet": { argTypes: [NETSERVER_T], result: DYN },
  "net.serverMaxRequestsPerSocketSet": { argTypes: [NETSERVER_T, DYN], result: VOID },
  /** server.on("listening", cb) — the deferred listen-callback list. */
  "net.serverOnListening": {
    argTypes: [NETSERVER_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.sockDestroyed": { argTypes: [NETSOCKET_T], result: BOOL },
  /** socket.writable — the write half is open: no end() yet, no FIN sent,
   * fd alive (connecting sockets answer true; writes queue). Node's
   * stream flag. Borrows; never throws. */
  "net.sockWritable": { argTypes: [NETSOCKET_T], result: BOOL },
  "net.sockSetTimeout": { argTypes: [NETSOCKET_T, F64], result: VOID },
  /** setEncoding('utf8') — 'data' delivers strings inside the chunk-encoding window; other real encodings throw the "not supported yet" Error, unknown names throw ERR_UNKNOWN_ENCODING (may throw). */
  "net.sockSetEncoding": { argTypes: [NETSOCKET_T, STRING], result: VOID },
  /** The untyped argument: a missing or undefined encoding means utf8, a
   * non-string throws Node's argument TypeError (may throw). */
  "net.sockSetEncodingDyn": { argTypes: [NETSOCKET_T, DYN], result: VOID },
  "net.sockOnTimeout": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  /** on('drain') / once('drain'): fires after a write answered false, once
   * the write buffer empties. */
  "net.sockOnDrain": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "net.sockRemoteAddress": { argTypes: [NETSOCKET_T], result: VOID },
  /** socket.encrypted — `boolean | undefined`: the true arm iff the
   * socket carries a TLS transport (Node types `encrypted: true` on
   * TLSSocket; plain sockets answer undefined — the proxy.ts isEncrypted
   * idiom reads it through a cast). */
  "net.sockEncrypted": { argTypes: [NETSOCKET_T], result: VOID },
  /** The paused-mode demux surface (portless's first-byte TLS peek:
   * once('readable') + read(1) + unshift + emit('connection')).
   * sockOnReadable registers a zero-param listener (a consumer: arrived
   * bytes buffer instead of flowing, and EOF announces too); sockRead
   * answers `Buffer | null` (exactly n buffered bytes, or null — Node's
   * less-than-n answer; n <= 0 drains everything); sockUnshift returns
   * bytes to the front of the stream; serverEmitConnection routes a
   * socket into another server's protocol layer (a TLS target's
   * 'connection' waits for its handshake). */
  "net.sockOnReadable": { argTypes: [NETSOCKET_T, null, BOOL], result: VOID },
  // sockRead's result is the interned `Buffer | null` union — checked
  // specially in validate.ts (the reqHeader/envGet pattern; VOID here is a
  // placeholder the special case overrides).
  "net.sockRead": { argTypes: [NETSOCKET_T, F64], result: VOID },
  "net.sockUnshift": { argTypes: [NETSOCKET_T, BYTES_U8], result: VOID },
  /** Socket flow control and the compat surface: pause/resume (reads
   * gate off/on — kernel backpressure holds paused bytes; resume flows
   * and discards sans listeners) and setNoDelay answer the SOCKET (+1,
   * Node's chaining); destroySoon ends now and destroys once the FIN
   * flushed; bytesWritten counts accepted bytes; readable is true until
   * the read half ends. */
  "net.sockPause": { argTypes: [NETSOCKET_T], result: NETSOCKET_T },
  "net.sockResume": { argTypes: [NETSOCKET_T], result: NETSOCKET_T },
  /** setNoDelay(enable): the argument as written (undefined means true);
   * answers the socket. */
  "net.sockSetNoDelay": { argTypes: [NETSOCKET_T, DYN], result: NETSOCKET_T },
  /** socket.connect(port[, host][, connectListener]): an idle socket
   * starts the dial net.connect's port form performs (port and host run
   * the validation ladder first); answers the socket. */
  "net.sockConnect": { argTypes: [NETSOCKET_T, F64, STRING], result: VOID },
  "net.sockConnectCb": {
    argTypes: [NETSOCKET_T, F64, STRING, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.sockDestroySoon": { argTypes: [NETSOCKET_T], result: VOID },
  /** RST close, answers the socket; throws ERR_INVALID_HANDLE_TYPE on TLS. */
  "net.sockResetAndDestroy": { argTypes: [NETSOCKET_T], result: NETSOCKET_T },
  /** socket.address(): { address, family, port } or {} as a dyn. */
  "net.sockAddress": { argTypes: [NETSOCKET_T], result: DYN },
  /** socket.timeout: the idle timeout setTimeout set (undefined until
   * one was set, 0 once disabled). */
  "net.sockTimeoutGet": { argTypes: [NETSOCKET_T], result: DYN },
  /** socket.allowHalfOpen: the constructor's stream option. */
  "net.sockAllowHalfOpen": { argTypes: [NETSOCKET_T], result: BOOL },
  "net.sockBytesWritten": { argTypes: [NETSOCKET_T], result: F64 },
  /** socket.writableLength: Node's state.length, the length of every
   * write not yet completely sent. */
  "net.sockWritableLength": { argTypes: [NETSOCKET_T], result: F64 },
  /** socket.writableNeedDrain: a write answered false and 'drain' has not
   * fired, with the write half open. */
  "net.sockWritableNeedDrain": { argTypes: [NETSOCKET_T], result: BOOL },
  /** remotePort (0), remoteFamily (1), localAddress (2), localPort (3),
   * localFamily (4): dyn values, undefined when unknown. */
  "net.sockAddrField": { argTypes: [NETSOCKET_T, F64], result: DYN },
  "net.sockBytesRead": { argTypes: [NETSOCKET_T], result: F64 },
  "net.sockConnecting": { argTypes: [NETSOCKET_T], result: BOOL },
  "net.sockPending": { argTypes: [NETSOCKET_T], result: BOOL },
  "net.sockReadyState": { argTypes: [NETSOCKET_T], result: STRING },
  /** setKeepAlive(enable, initialDelay, interval, count): the arguments
   * as written (a missing one is the dyn undefined value); answers the
   * socket. */
  "net.sockSetKeepAlive": {
    argTypes: [NETSOCKET_T, DYN, DYN, DYN, DYN],
    result: NETSOCKET_T,
  },
  "net.sockOnReady": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  /** Listeners with a parameter, as dyn functions: close(hadError),
   * write's cb(err) and end's cb. */
  "net.sockOnCloseDyn": { argTypes: [NETSOCKET_T, DYN, BOOL], result: VOID },
  /** socket.on/once('lookup', listener): the listener (a dyn function)
   * gets (err, address, family, host) once per resolved address, or once
   * with the lookup error, before the connect. */
  "net.sockOnLookup": { argTypes: [NETSOCKET_T, DYN, BOOL], result: VOID },
  /** socket.on/once of the happy-eyeballs attempt events: the dyn
   * listener gets (ip, port, family), plus the error for Failed. `which`
   * is 0 (connectionAttempt), 1 (Failed) or 2 (Timeout). */
  "net.sockOnAttempt": { argTypes: [NETSOCKET_T, DYN, F64, BOOL], result: VOID },
  /** socket.bufferSize: the unsent bytes, or a dyn undefined before the
   * socket has a handle (Node's deprecated writableLength alias). */
  "net.sockBufferSize": { argTypes: [NETSOCKET_T], result: DYN },
  /** socket.autoSelectFamilyAttemptedAddresses: the "$ip:$port" strings
   * of a multi-address dial, a dyn undefined when the dial took the
   * single-address path. */
  "net.sockAttemptedAddresses": { argTypes: [NETSOCKET_T], result: DYN },
  "net.sockOnWriteFlush": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.sockOnWriteFlushDyn": { argTypes: [NETSOCKET_T, DYN], result: VOID },
  "net.sockOnFinishDyn": { argTypes: [NETSOCKET_T, DYN], result: VOID },
  "net.sockSetTimeoutCb": {
    argTypes: [NETSOCKET_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.isIP": { argTypes: [DYN], result: F64 },
  "net.isIPv4": { argTypes: [DYN], result: BOOL },
  "net.isIPv6": { argTypes: [DYN], result: BOOL },
  "net.serverMaxConnectionsGet": { argTypes: [NETSERVER_T], result: DYN },
  "net.serverMaxConnectionsSet": { argTypes: [NETSERVER_T, DYN], result: VOID },
  "net.serverDropMaxConnectionGet": { argTypes: [NETSERVER_T], result: DYN },
  "net.serverDropMaxConnectionSet": { argTypes: [NETSERVER_T, DYN], result: VOID },
  /** net.SocketAddress and net.BlockList (scr_net.c): the constructors
   * take the argument array; the handles are dyn values. */
  "net.socketAddressNew": { argTypes: [DYN], result: DYN },
  "net.socketAddressParse": { argTypes: [DYN], result: DYN },
  "net.isSocketAddress": { argTypes: [DYN], result: BOOL },
  "net.blockListNew": { argTypes: [DYN], result: DYN },
  "net.isBlockList": { argTypes: [DYN], result: BOOL },
  "net.blockListPrivateRanges": { argTypes: [], result: DYN },
  /** net.BoundSocket: construction validates its options and binds;
   * server.listen(bound[, cb]) adopts the bound descriptor. */
  "net.boundSocketNew": { argTypes: [DYN], result: DYN },
  "net.isBoundSocket": { argTypes: [DYN], result: BOOL },
  "net.listenBound": { argTypes: [NETSERVER_T, DYN], result: VOID },
  "net.listenBoundCb": {
    argTypes: [NETSERVER_T, DYN, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.serverOnDrop": { argTypes: [NETSERVER_T, DYN, BOOL], result: VOID },
  /** server[Symbol.asyncDispose](): a void promise that fulfills at
   * 'close' (at once for a server that never listened). */
  "net.serverAsyncDispose": {
    argTypes: [NETSERVER_T],
    result: { kind: "promise", inner: VOID },
  },
  "net.serverGetConnections": { argTypes: [NETSERVER_T, DYN], result: VOID },
  "net.sockReadable": { argTypes: [NETSOCKET_T], result: BOOL },
  /** socket.on('finish', cb) / end(cb): fires once when the FIN goes out
   * (sweep-deferred, never the registering stack). */
  "net.sockOnFinish": {
    argTypes: [NETSOCKET_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "net.serverEmitConnection": { argTypes: [NETSERVER_T, NETSOCKET_T], result: VOID },
  // The close-override pair: the bound close's result func type and the
  // override's func argument are program-dependent (the callback union's
  // tags) — the slots pin the server receiver; the libCall case checks
  // the bound value's shape.
  /** The close-override pair (the portless close-proxy idiom).
   * serverCloseBind is `wrapper.close.bind(wrapper)` as a VALUE: a
   * compiler-emitted closure over the server whose invocation runs the
   * REAL close (scr_net_server_close_direct — never the override), so
   * the override body's `origClose(cb)` cannot recurse; its callback
   * argument (the `((err?: Error) => void) | undefined` union) registers
   * as a once-'close' listener, a one-param callback wrapped by an
   * emitted zero-arg trampoline firing the undefined arm (a clean close
   * carries no error). serverSetCloseOverride is `wrapper.close = fn`:
   * the override MOVES in behind an emitted zero-arg wrapper (it invokes
   * the user function with the undefined-arm callback — tags are program
   * data), and server.close() consults it before closing. */
  "net.serverCloseBind": { argTypes: [NETSERVER_T], result: VOID },
  "net.serverSetCloseOverride": { argTypes: [NETSERVER_T, null], result: VOID },
});
