import {
  arrayOf,
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  HTTP2STREAM_T,
  HTTPCLIENTREQ_T,
  HTTPREQ_T,
  HTTPRES_T,
  NETSERVER_T,
  NETSOCKET_T,
  STRING,
  VOID,
} from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The http builtin call slots. */
export const httpSignatures = defineLibFnSignatures({
  // node:http (scr_http.c over scr_net.c). The handler and the data
  // listeners are program-dependent closures (null slots, checked in the
  // libCall case); reqHeader's result is the interned string|undefined
  // union, checked like process.envGet.
  /** node:http, the server slice (scr_http.c over scr_net.c — linked
   * only when these appear on the IR; moduleUsesHttpServer is the
   * switch, and any http.* libCall also counts as net use so scr_net.c
   * links and installs). http.createServer's handler MOVES in and takes
   * the runtime adapters for its (req, res) / (req) / () shapes; req
   * body listeners follow the net.sockOnData story (bytes chunks, once
   * flags); reqHeader answers the interned `string | undefined` union
   * exactly like process.envGet; the res writers are borrowed-argument
   * voids with Node's framing decided in the runtime (Content-Length
   * for end-before-head, chunked after an explicit writeHead/write). */
  "http.createServer": { argTypes: [null], result: NETSERVER_T },
  /** http.createServer() / http.Server() with no handler — the
   * on("request") route; option helpers set parser behavior on a fresh
   * server before the constructor/factory result is returned. */
  "http.createServerEmpty": { argTypes: [], result: NETSERVER_T },
  "http.validateHeaderName": { argTypes: [STRING, STRING], result: VOID },
  "http.validateHeaderValue": { argTypes: [STRING, DYN], result: VOID },
  /** http.setMaxIdleHTTPParsers(max): Node's argument validation. */
  "http.setMaxIdleParsers": { argTypes: [DYN], result: VOID },
  /** The typed createConnection rewrite's secure-agent check. */
  "http.agentCreateConnectionCheck": { argTypes: [DYN], result: VOID },
  "http.serverJoinDupHeaders": { argTypes: [NETSERVER_T], result: VOID },
  "http.serverAllowMissingHostHeader": { argTypes: [NETSERVER_T], result: VOID },
  /** The five writable numeric http.Server timeout fields use one
   * selector ABI: 0 timeout, 1 keepAliveTimeout, 2 headersTimeout,
   * 3 requestTimeout, 4 keepAliveTimeoutBuffer. These calls store/read
   * the property values; timer enforcement remains outside this surface.
   * The constructor-option setter takes dyn so explicit undefined remains
   * distinguishable from a numeric value until its Node validation ladder. */
  "http.serverTimeoutGet": { argTypes: [NETSERVER_T, F64], result: F64 },
  "http.serverSetTimeout": { argTypes: [NETSERVER_T, F64], result: VOID },
  "http.serverSetTimeoutCb": { argTypes: [NETSERVER_T, F64, null], result: VOID },
  "http.serverOnTimeout": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http.serverCloseAllConnections": { argTypes: [NETSERVER_T], result: VOID },
  "http.serverCloseIdleConnections": { argTypes: [NETSERVER_T], result: VOID },
  "http.serverTimeoutSet": { argTypes: [NETSERVER_T, F64, F64], result: VOID },
  "http.serverTimeoutOptionSet": { argTypes: [NETSERVER_T, F64, DYN], result: VOID },
  /** headersTimeout's constructor default (min(60000, requestTimeout))
   * and Node's headersTimeout <= requestTimeout check. MAY THROW. */
  "http.serverHeadersTimeoutDefault": { argTypes: [NETSERVER_T, DYN], result: VOID },
  /** createServer({ connectionsCheckingInterval }): Node's validateInteger
   * and the stored check interval. MAY THROW. */
  "http.serverConnectionsCheckingInterval": { argTypes: [NETSERVER_T, DYN], result: VOID },
  /** createServer({ rejectNonStandardBodyWrites }): body writes on HEAD,
   * 204 and 304 responses throw ERR_HTTP_BODY_NOT_ALLOWED. */
  "http.serverRejectNonStandardBodyWrites": { argTypes: [NETSERVER_T, DYN], result: VOID },
  /** The ServerResponse member surface: statusCode/statusMessage reads
   * and assignments (Node's writable properties), the header CRUD trio
   * (getHeader answers `string | undefined` like reqHeader), and
   * end(cb)'s callback slot (resOnEndCallback registers, the end call
   * follows — the callback fires deferred, just before Node's 'finish'
   * emit; resOnFinish is the 'finish' listener slot). writeHead's
   * statusMessage forms compose in interned helpers: resStatusMsgSet
   * then the ordinary writeHead entry. */
  "http.resStatusGet": { argTypes: [HTTPRES_T], result: F64 },
  "http.resStatusSet": { argTypes: [HTTPRES_T, F64], result: VOID },
  "http.resStatusMsgGet": { argTypes: [HTTPRES_T], result: VOID },
  "http.resStatusMsgSet": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resRequest": { argTypes: [HTTPRES_T], result: HTTPREQ_T },
  "http.resSocket": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWritableFinished": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resSendDateGet": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resSendDateSet": { argTypes: [HTTPRES_T, BOOL], result: VOID },
  "http.resStrictContentLengthGet": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resStrictContentLengthSet": { argTypes: [HTTPRES_T, BOOL], result: VOID },
  "http.resSetTimeout": { argTypes: [HTTPRES_T, F64], result: VOID },
  "http.resSetTimeoutCb": {
    argTypes: [HTTPRES_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  // resGetHeader answers the interned `string | undefined` union — the
  // reqHeader/envGet sentinel pattern (VOID here, checked specially).
  "http.resGetHeader": { argTypes: [HTTPRES_T, STRING], result: VOID },
  /** getHeader as Node answers it: the number, string or string[] that was
   * set, or undefined, as a checked-dynamic value. */
  "http.resGetHeaderDyn": { argTypes: [HTTPRES_T, STRING], result: DYN },
  "http.resGetHeaderNames": { argTypes: [HTTPRES_T], result: arrayOf(STRING) },
  "http.resGetRawHeaderNames": { argTypes: [HTTPRES_T], result: arrayOf(STRING) },
  "http.resGetHeaders": { argTypes: [HTTPRES_T], result: DYN },
  "http.resHasHeader": { argTypes: [HTTPRES_T, STRING], result: BOOL },
  "http.resRemoveHeader": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resOnFinish": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  /** write(chunk, cb)'s callback slot: fires once the data is flushed. */
  "http.resOnWriteFlush": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.resOnEndCallback": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.reqUrl": { argTypes: [HTTPREQ_T], result: STRING },
  /** message.signal: the request's AbortSignal handle (checked-dynamic). */
  "http.reqSignal": { argTypes: [HTTPREQ_T], result: DYN },
  "http.reqMethod": { argTypes: [HTTPREQ_T], result: STRING },
  "http.reqHeader": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqTrailer": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqHeaderValues": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqTrailerValues": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  "http.reqOnData": { argTypes: [HTTPREQ_T, null, BOOL], result: VOID },
  /** The for-await bridge: the request body as a Readable fed by its data
   * and end events. */
  "http.reqBodyStream": {
    argTypes: [HTTPREQ_T],
    result: { kind: "object", className: "%Readable" },
  },
  "http.reqOnEnd": {
    argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.resSetHeader": { argTypes: [HTTPRES_T, STRING, STRING], result: VOID },
  /** setHeader / appendHeader with a number, string or array value; the
   * stored value keeps its type for getHeader/getHeaders. MAY THROW. */
  "http.resSetHeaderDyn": { argTypes: [HTTPRES_T, STRING, DYN], result: VOID },
  "http.resAppendHeader": { argTypes: [HTTPRES_T, STRING, DYN], result: VOID },
  "http.resWriteHead": { argTypes: [HTTPRES_T, F64], result: VOID },
  "http.resWriteHeadN": {
    argTypes: [HTTPRES_T, F64, arrayOf(STRING), arrayOf(STRING)],
    result: VOID,
  },
  /** HTTP/1.1 informational heads; early hints takes flat string pairs,
   * with a lowercase `link` key required to send anything. */
  "http.resWriteContinue": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWriteProcessing": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWriteEarlyHints": { argTypes: [HTTPRES_T, arrayOf(STRING)], result: VOID },
  /* writeInformation(status[, headers]): the generic informational
   * response, answering write()'s backpressure boolean. */
  "http.resWriteInformation": { argTypes: [HTTPRES_T, F64, arrayOf(STRING)], result: BOOL },
  "http.resWriteInformationCb": {
    argTypes: [HTTPRES_T, F64, arrayOf(STRING), { kind: "func", params: [], ret: VOID }],
    result: BOOL,
  },
  /** The callback forms: the callback fires once the head is written. */
  "http.resWriteContinueCb": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.resWriteProcessingCb": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.resWriteEarlyHintsCb": {
    argTypes: [HTTPRES_T, arrayOf(STRING), { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.resWrite": { argTypes: [HTTPRES_T, STRING], result: BOOL },
  "http.resWriteBytes": { argTypes: [HTTPRES_T, BYTES_U8], result: BOOL },
  "http.resEnd": { argTypes: [HTTPRES_T], result: VOID },
  "http.resEndStr": { argTypes: [HTTPRES_T, STRING], result: VOID },
  "http.resEndBytes": { argTypes: [HTTPRES_T, BYTES_U8], result: VOID },
  /** The checked-dynamic chunk twins (the net.sockWriteDyn story). */
  "http.resWriteDyn": { argTypes: [HTTPRES_T, DYN], result: BOOL },
  /* write/end with an encoding or a callback: the extra arguments cross as
   * checked-dynamic values (undefined when the call omits them). */
  "http.resWriteArgs": { argTypes: [HTTPRES_T, DYN, DYN, DYN], result: BOOL },
  "http.resEndArgs": { argTypes: [HTTPRES_T, DYN, DYN, DYN], result: VOID },
  "http.resEndDyn": { argTypes: [HTTPRES_T, DYN], result: VOID },
  "http.resHeadersSent": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resWritableEnded": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resFlushHeaders": { argTypes: [HTTPRES_T], result: VOID },
  "http.resAddTrailers": { argTypes: [HTTPRES_T, arrayOf(STRING)], result: VOID },
  "http.resCork": { argTypes: [HTTPRES_T], result: VOID },
  "http.resUncork": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWritableCorked": { argTypes: [HTTPRES_T], result: F64 },
  /* write()'s answer and the OutgoingMessage state behind it: Node's
   * writableLength (corked bytes + chunk framing + held head + the
   * socket's unsent bytes), writableNeedDrain, the 'drain' event, and
   * setHeaders/pipe. */
  "http.resWritableLength": { argTypes: [HTTPRES_T], result: F64 },
  "http.resWritableNeedDrain": { argTypes: [HTTPRES_T], result: BOOL },
  "http.resOnDrain": { argTypes: [HTTPRES_T, null, BOOL], result: VOID },
  "http.resSetHeaders": { argTypes: [HTTPRES_T, DYN], result: VOID },
  "http.resPipe": { argTypes: [HTTPRES_T], result: VOID },
  "http.resWritableHighWaterMark": { argTypes: [HTTPRES_T], result: F64 },
  "http.resWritableObjectMode": { argTypes: [HTTPRES_T], result: BOOL },
  /** res.on("prefinish", cb): fires inside end(). Throws for the HTTP/2
   * compatibility response. */
  "http.resOnPrefinish": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  // The member follow-ups: reqStatusCode's `number | undefined` and
  // sockRemoteAddress's `string | undefined` results are shape-checked in
  // the special cases in validate.ts (like reqHeader/columns).
  /** The server-surface member follow-ups: reqStatusCode answers the
   * interned `number | undefined` union (negative = the undefined arm —
   * a SERVER request, where Node's statusCode is undefined; every client
   * response carries a real status); reqSocket is the underlying
   * connection (+1, the same handle net.connect would give);
   * sockRemoteAddress answers `string | undefined` (NULL after the fd
   * closed, Node's destroyed-socket undefined; a dual-stack accept of an
   * IPv4 peer reads "::ffff:a.b.c.d" like Node). reqResume/reqPause/reqDestroy and
   * the req error/close listener slots complete the IncomingMessage
   * surface portless's client responses use; resDestroy/resOnClose and
   * resWriteHeadPairs ([k0,v0,k1,v1,...] — the env.pairs helper's flat
   * shape) complete ServerResponse. sockSetTimeout arms the idle
   * EVFILT_TIMER ('timeout' fires after ms of inactivity, once per idle
   * period, never destroying the socket — Node's semantics). */
  "http.reqStatusCode": { argTypes: [HTTPREQ_T], result: VOID },
  // reqStatusMessage's `string | undefined` is program-interned like
  // reqHeader's (the VOID here is the envGet sentinel).
  "http.reqStatusMessage": { argTypes: [HTTPREQ_T], result: VOID },
  /** req.rawHeaders — [name, value, name, value, ...] in arrival order,
   * names in their ORIGINAL case (Node's shape); a fresh string[] per
   * read. reqStatusMessage answers the interned `string | undefined`
   * union — the reason phrase on client responses ("" when the status
   * line carried none), the undefined arm on server requests (the
   * statusCode split). sockDestroyed is socket.destroyed — true once the
   * fd is gone (destroy() or full close). */
  "http.reqRawHeaders": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  /** The `{ ...req.headers }` snapshot feed: [lowercased name, value,
   * ...] pairs in arrival order — the interned %headers.snapshot helper
   * builds the record over it, exactly the process.envPairs pattern. */
  "http.reqHeaderPairs": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  /** Every value of one header in arrival order (empty when absent): the
   * set-cookie array of a `{ ...req.headers }` snapshot. */
  "http.reqHeaderList": { argTypes: [HTTPREQ_T, STRING], result: arrayOf(STRING) },
  "http.reqRawTrailers": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  "http.reqTrailerPairs": { argTypes: [HTTPREQ_T], result: arrayOf(STRING) },
  // The 'upgrade' registrations: the callback shapes are program-typed
  // ((req, socket, head) and shorter prefixes — the libCall case checks).
  /** The 'upgrade' events, both sides (SEMANTICS.md — the WebSocket
   * proxying surface): serverOnUpgrade registers (req, socket, head)
   * listeners fired INSTEAD of 'request' for Connection: upgrade
   * requests (the parser steps aside; the socket is raw; `head` carries
   * bytes past the request head; no listener = the socket destroys,
   * Node's default). clientOnUpgrade is the client twin: a 101 response
   * fires (res, socket, head) INSTEAD of 'response'. */
  "http.serverOnUpgrade": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** server.on("connect", ...) — HTTP CONNECT tunneling, the 'upgrade'
   * machinery's twin: (req, socket, head) fired INSTEAD of 'request' for
   * CONNECT-method requests (no listener = the socket destroys, Node's
   * default). The h2 compat server's 'connect' (portless's RFC 8441
   * handler) only ever sees the HTTP/1.1 arm under the allowHTTP1
   * lowering, so a listener whose second parameter is a UNION with a
   * netSocket arm takes the socket wrapped at that arm (an emitted
   * per-shape adapter — the tags are program data). */
  "http.serverOnConnect": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http.clientOnUpgrade": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  /** The response to a CONNECT request: the same (res, socket, head)
   * handover, whatever the status. */
  "http.clientOnConnect": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  /** server.on("clientError", (err, socket) => ...): a request the parser
   * rejects, or a connection error, goes to the listeners instead of the
   * default 400/413/431 answer, as in Node. (err, socket) and shorter
   * prefixes (the libCall case checks). */
  "http.serverOnClientError": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** server.on("dropRequest", (req, socket) => ...): a request past
   * maxRequestsPerSocket, answered by the server with 503. */
  "http.serverOnDropRequest": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http.reqSocket": { argTypes: [HTTPREQ_T], result: NETSOCKET_T },
  // reqH2Stream's program-interned Http2Stream | undefined result is
  // checked in the special libCall cases in validate.ts.
  "http.reqH2Stream": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqH2StreamOrThrow": { argTypes: [HTTPREQ_T, STRING], result: HTTP2STREAM_T },
  /** req.pipe(dest) — the IncomingMessage body streaming into a
   * ServerResponse (the proxy's response leg), a ClientRequest (the
   * request-body forward), or a raw socket (the upgrade-rejection leg);
   * chunk-for-chunk, natural end ends the destination (Node's pipe
   * default; no backpressure — divergence 54's stream model). */
  "http.reqPipeRes": { argTypes: [HTTPREQ_T, HTTPRES_T], result: VOID },
  "http.reqPipeClient": { argTypes: [HTTPREQ_T, HTTPCLIENTREQ_T], result: VOID },
  "http.reqPipeSock": { argTypes: [HTTPREQ_T, NETSOCKET_T], result: VOID },
  /** req.unpipe(dest): that destination stops receiving the body; a
   * destination the request is not piping to changes nothing. */
  "http.reqUnpipeRes": { argTypes: [HTTPREQ_T, HTTPRES_T], result: VOID },
  "http.reqUnpipeClient": { argTypes: [HTTPREQ_T, HTTPCLIENTREQ_T], result: VOID },
  "http.reqUnpipeSock": { argTypes: [HTTPREQ_T, NETSOCKET_T], result: VOID },
  /** req.off(event, listener) / removeListener: [message, listener
   * closure, list kind]. The kind selects the event's registry (1 data,
   * 2 end, 3 error, 4 close, 5 aborted — the scr_http.h
   * SCR_HTTP_REQ_OFF_* values); Node removes the most recently added
   * matching listener. Never throws. */
  "http.reqOff": { argTypes: [HTTPREQ_T, null, F64], result: VOID },
  /** res.off(event, listener) / removeListener, the ServerResponse twin
   * (1 close, 2 finish, 3 prefinish, 4 drain). */
  "http.resOff": { argTypes: [HTTPRES_T, null, F64], result: VOID },
  "http.reqResume": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqPause": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqDestroy": { argTypes: [HTTPREQ_T], result: VOID },
  "http.reqOnError": { argTypes: [HTTPREQ_T, null, BOOL], result: VOID },
  "http.reqOnClose": {
    argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.reqOnAborted": {
    argTypes: [HTTPREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.reqHttpVersion": { argTypes: [HTTPREQ_T], result: STRING },
  "http.reqHttpVersionMajor": { argTypes: [HTTPREQ_T], result: F64 },
  "http.reqHttpVersionMinor": { argTypes: [HTTPREQ_T], result: F64 },
  "http.reqAborted": { argTypes: [HTTPREQ_T], result: BOOL },
  /* req.signal: the message's AbortSignal (built on first read). */
  "http.reqDestroyed": { argTypes: [HTTPREQ_T], result: BOOL },
  "http.resDestroyed": { argTypes: [HTTPRES_T], result: BOOL },
  "http.reqComplete": { argTypes: [HTTPREQ_T], result: BOOL },
  "http.resDestroy": { argTypes: [HTTPRES_T], result: VOID },
  "http.resOnClose": {
    argTypes: [HTTPRES_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.resWriteHeadPairs": { argTypes: [HTTPRES_T, F64, arrayOf(STRING)], result: VOID },
  /** writeHead(status, object): parallel names and dyn values, Node's
   * fast and progressive paths. MAY THROW. */
  "http.resWriteHeadObject": {
    argTypes: [HTTPRES_T, F64, arrayOf(STRING), arrayOf(DYN)],
    result: VOID,
  },
  /** writeHead(status, headers) with a checked-dynamic headers value —
   * the runtime OBJ walk (string/number values; other values throw
   * Node's invalid-argument TypeError; may throw). */
  "http.resWriteHeadDyn": { argTypes: [HTTPRES_T, F64, DYN], result: VOID },
  "http.reqSetEncoding": { argTypes: [HTTPREQ_T, STRING], result: VOID },
  // node:http, the client slice. The response callback shapes are
  // program-dependent (checked by validate.ts); header pairs arrive flat.
  /** node:http, the CLIENT slice (http.request/http.get over the net
   * client machinery): request/requestCb take (host, port, path, method,
   * timeoutMs, headerPairs, autoEnd[, responseCb]) — headerPairs is the
   * flat [k0,v0,...] array (empty for none), autoEnd true is http.get's
   * eager end(). The handle owns one dialed connection (NO pooling — the
   * wire still carries Node's exact head: user headers, then Host,
   * Connection: keep-alive, and the framing header; the socket closes
   * when the response completes). The response delivered to responseCb /
   * 'response' listeners IS an httpReq (IncomingMessage), status and
   * headers parsed from the wire, body via reqOnData/reqOnEnd. Errors are
   * Node-shaped ('connect ECONNREFUSED ip:port', 'socket hang up') and
   * fire 'error' then 'close'; an unhandled 'error' exits 1 like every
   * net handle. clientWrite before end commits to chunked framing unless
   * the caller set content-length; clientEnd(data) before any write sends
   * Content-Length exactly like Node. */
  "http.request": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL],
    result: HTTPCLIENTREQ_T,
  },
  "http.requestCb": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
  /** new http.Agent(opts) / new https.Agent(opts): (secure, keepAlive,
   * keepAliveMsecs, maxSockets, maxFreeSockets, timeoutMs, port) — the
   * numeric options arrive < 0 for "unset" (Infinity/256/none; port
   * seeds the settable defaultPort, Node's option merge). Returns the
   * Agent as a checked-dynamic HANDLE (getName/destroy and the
   * sockets/requests/freeSockets counters dispatch through the dyn
   * handle ops). keepAlive: true THROWS the named construction fence —
   * socket POOLING is not modeled (one dial per request); maxSockets
   * accounting is real: over-limit requests defer their dial and queue.
   * MAY THROW. */
  "http.agentNew": {
    argTypes: [BOOL, BOOL, F64, F64, F64, BOOL, F64, F64, F64, DYN],
    result: DYN,
  },
  /** http.globalAgent / https.globalAgent (true): Node's keepAlive global
   * agent, the one requests without an agent option use. */
  "http.globalAgent": { argTypes: [BOOL], result: DYN },
  /** http.request's `signal` option over the fresh request: an aborted
   * signal destroys it with Node's AbortError now, a later abort event
   * does the same. A falsy value is ignored; a non-signal throws
   * ERR_INVALID_ARG_TYPE. */
  "http.clientSignal": { argTypes: [HTTPCLIENTREQ_T, DYN], result: VOID },
  /** options.signal checked before the request is built (ERR_INVALID_ARG_TYPE). */
  "http.clientSignalCheck": { argTypes: [DYN], result: VOID },
  /** options.protocol checked before the request is built: the declared
   * scheme against the agent's (the calling module's when the options
   * carry no Agent value). MAY THROW ERR_INVALID_PROTOCOL. */
  "http.clientProtocolCheck": { argTypes: [DYN, BOOL], result: VOID },
  "http.clientProtocolCheckAgent": { argTypes: [DYN, BOOL, DYN], result: VOID },
  /** The maxHeaderSize option of createServer / http.request: Node's
   * validateInteger (ERR_OUT_OF_RANGE) then the header size bound.
   * MAY THROW. */
  "http.serverMaxHeaderSize": { argTypes: [NETSERVER_T, F64], result: VOID },
  "http.clientMaxHeaderSize": { argTypes: [HTTPCLIENTREQ_T, F64], result: VOID },
  /** request.maxHeadersCount — the client's header-line budget. */
  "http.clientMaxHeadersCountGet": { argTypes: [HTTPCLIENTREQ_T], result: DYN },
  "http.clientMaxHeadersCountSet": { argTypes: [HTTPCLIENTREQ_T, DYN], result: VOID },
  /** req.destroy(err): err becomes the request's 'error'. */
  "http.clientDestroyError": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "object", className: "%Error" }],
    result: VOID,
  },
  /** The agent-threaded request rows: the http.request/https.request
   * shape with a trailing `agent` dyn argument (an Agent handle, false —
   * the one-shot Connection: close dial — or null/undefined for the
   * default path). port < 0 means "no port option": the agent's settable
   * defaultPort, then the scheme's. MAY THROW (a non-Agent value is
   * Node's ERR_INVALID_ARG_TYPE). */
  "http.requestAgent": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, DYN],
    result: HTTPCLIENTREQ_T,
  },
  "http.requestAgentCb": {
    argTypes: [STRING, F64, STRING, STRING, F64, arrayOf(STRING), BOOL, DYN, null],
    result: HTTPCLIENTREQ_T,
  },
  /** request/get with a URL-STRING first argument: the runtime parses it
   * (WHATWG) and dials — throws catchably on an unparsable input or a
   * non-http scheme. */
  "http.requestUrl": { argTypes: [STRING, STRING, BOOL], result: HTTPCLIENTREQ_T },
  "http.requestUrlCb": { argTypes: [STRING, STRING, BOOL, null], result: HTTPCLIENTREQ_T },
  /** request/get with a runtime options record: a RequestOptions
   * variable, or a literal that spreads one or sets socketPath. Args
   * (options, autoEnd[, cb]). The runtime reads the record in the
   * ClientRequest constructor's order (host/port or socketPath, path,
   * method, headers, timeout, agent, signal, maxHeaderSize) with Node's
   * errors, and documented options it does not implement throw the
   * runtime fence. The "https." pair adds the TLS options. MAY THROW. */
  "http.requestDyn": { argTypes: [DYN, BOOL], result: HTTPCLIENTREQ_T },
  "http.requestDynCb": { argTypes: [DYN, BOOL, null], result: HTTPCLIENTREQ_T },
  /** request/get with a URL and an options record: Node's
   * `{...urlToHttpOptions(new URL(url)), ...options}` merge at run time,
   * then the walk above. Args (url, options, autoEnd[, cb]). MAY THROW. */
  "http.requestUrlDyn": { argTypes: [STRING, DYN, BOOL], result: HTTPCLIENTREQ_T },
  "http.requestUrlDynCb": { argTypes: [STRING, DYN, BOOL, null], result: HTTPCLIENTREQ_T },
  "http.serverOnRequest": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** server.on('checkContinue' | 'checkExpectation', (req, res)): the
   * 'request' listener shape; the last argument picks checkExpectation. */
  "http.serverOnCheck": { argTypes: [NETSERVER_T, null, BOOL, BOOL], result: VOID },
  /** server.off/removeListener and server.listeners for the HTTP
   * request-side events: [server, listener closure or nothing, list kind]
   * with the scr_http.h SCR_HTTP_OFF_* kind (1 request, 2 checkContinue,
   * 3 checkExpectation, 4 upgrade, 5 connect, 6 clientError). Off
   * removes the most recently added matching listener; listeners answers
   * a +1 closure array in registration order. */
  "http.serverOff": { argTypes: [NETSERVER_T, null, F64], result: VOID },
  "http.serverListeners": { argTypes: [NETSERVER_T, F64], result: VOID },
  // The createConnection forms: arg 0 is the dialer closure (() =>
  // Socket — the libCall case checks), then path/method/timeout/headers/
  // autoEnd like http.request.
  /** The createConnection form (the proxy's own dialer): args are
   * (connCb, path, method, timeout, headers, autoEnd[, cb]) — connCb is
   * a `() => net.Socket` closure the runtime invokes ONCE, synchronously
   * (Node's onSocket timing); everything else matches http.request. The
   * Host header defaults to "localhost" — a headers.host entry wins
   * verbatim, the proxy shape. */
  "http.requestConn": {
    argTypes: [null, STRING, STRING, F64, arrayOf(STRING), BOOL],
    result: HTTPCLIENTREQ_T,
  },
  "http.requestConnCb": {
    argTypes: [null, STRING, STRING, F64, arrayOf(STRING), BOOL, null],
    result: HTTPCLIENTREQ_T,
  },
  "http.clientWrite": { argTypes: [HTTPCLIENTREQ_T, STRING], result: BOOL },
  "http.clientSetHeader": { argTypes: [HTTPCLIENTREQ_T, STRING, STRING], result: VOID },
  /** setHeader / appendHeader with a string, number, null or array value;
   * the stored value keeps its type for getHeader/getHeaders. MAY THROW. */
  "http.clientSetHeaderDyn": { argTypes: [HTTPCLIENTREQ_T, STRING, DYN], result: VOID },
  "http.clientAppendHeaderDyn": { argTypes: [HTTPCLIENTREQ_T, STRING, DYN], result: VOID },
  "http.clientGetHeader": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  /** getHeader as Node answers it: the number, string or string[] that was
   * set, or undefined, as a checked-dynamic value. */
  "http.clientGetHeaderDyn": { argTypes: [HTTPCLIENTREQ_T, STRING], result: DYN },
  "http.clientHasHeader": { argTypes: [HTTPCLIENTREQ_T, STRING], result: BOOL },
  "http.clientRemoveHeader": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  "http.clientGetHeaderNames": { argTypes: [HTTPCLIENTREQ_T], result: arrayOf(STRING) },
  "http.clientGetRawHeaderNames": { argTypes: [HTTPCLIENTREQ_T], result: arrayOf(STRING) },
  "http.clientGetHeaders": { argTypes: [HTTPCLIENTREQ_T], result: DYN },
  "http.clientWriteBytes": { argTypes: [HTTPCLIENTREQ_T, BYTES_U8], result: BOOL },
  "http.clientEnd": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientEndStr": { argTypes: [HTTPCLIENTREQ_T, STRING], result: VOID },
  "http.clientEndBytes": { argTypes: [HTTPCLIENTREQ_T, BYTES_U8], result: VOID },
  /** The checked-dynamic chunk twins (the net.sockWriteDyn story). */
  "http.clientWriteDyn": { argTypes: [HTTPCLIENTREQ_T, DYN], result: BOOL },
  "http.clientWriteArgs": { argTypes: [HTTPCLIENTREQ_T, DYN, DYN, DYN], result: BOOL },
  "http.clientEndArgs": { argTypes: [HTTPCLIENTREQ_T, DYN, DYN, DYN], result: VOID },
  "http.clientEndDyn": { argTypes: [HTTPCLIENTREQ_T, DYN], result: VOID },
  "http.clientFlushHeaders": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientAddTrailers": { argTypes: [HTTPCLIENTREQ_T, arrayOf(STRING)], result: VOID },
  "http.clientCork": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientUncork": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientWritableCorked": { argTypes: [HTTPCLIENTREQ_T], result: F64 },
  "http.clientWritableLength": { argTypes: [HTTPCLIENTREQ_T], result: F64 },
  "http.clientWritableNeedDrain": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientOnDrain": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientPipe": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientMethod": { argTypes: [HTTPCLIENTREQ_T], result: STRING },
  "http.clientPath": { argTypes: [HTTPCLIENTREQ_T], result: STRING },
  "http.clientHost": { argTypes: [HTTPCLIENTREQ_T], result: STRING },
  "http.clientProtocol": { argTypes: [HTTPCLIENTREQ_T], result: STRING },
  "http.clientHeadersSent": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientWritableEnded": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientWritableFinished": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientSocket": { argTypes: [HTTPCLIENTREQ_T], result: NETSOCKET_T },
  "http.clientReusedSocket": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientSetNoDelay": { argTypes: [HTTPCLIENTREQ_T, BOOL], result: VOID },
  "http.clientSetSocketKeepAlive": { argTypes: [HTTPCLIENTREQ_T, BOOL, F64], result: VOID },
  "http.clientSetTimeout": { argTypes: [HTTPCLIENTREQ_T, F64], result: VOID },
  "http.clientSetTimeoutCb": {
    argTypes: [HTTPCLIENTREQ_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.statusCodes": { argTypes: [], result: DYN },
  "http.methods": { argTypes: [], result: arrayOf(STRING) },
  "http.reqSetTimeout": { argTypes: [HTTPREQ_T, F64], result: VOID },
  "http.reqSetTimeoutCb": {
    argTypes: [HTTPREQ_T, F64, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http.clientDestroy": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientAbort": { argTypes: [HTTPCLIENTREQ_T], result: VOID },
  "http.clientAborted": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientDestroyed": { argTypes: [HTTPCLIENTREQ_T], result: BOOL },
  "http.clientOnResponse": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientOnSocket": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientOnFinish": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.clientOnError": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  "http.clientOnTimeout": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.clientOnClose": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.clientOnAbort": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  "http.clientOnContinue": {
    argTypes: [HTTPCLIENTREQ_T, { kind: "func", params: [], ret: VOID }, BOOL],
    result: VOID,
  },
  /** request.on("information", (info) => ...): every 1xx response but
   * 101. The listener is void with no parameter or one checked-dynamic
   * parameter, Node's event object. */
  "http.clientOnInformation": { argTypes: [HTTPCLIENTREQ_T, null, BOOL], result: VOID },
  /** http.setGlobalProxyFromEnv(proxyEnv?): Node 24 configures the module's
   * environment proxy; the default agent resolves it per target. */
  "http.setGlobalProxyFromEnv": { argTypes: [DYN], result: VOID },
});
