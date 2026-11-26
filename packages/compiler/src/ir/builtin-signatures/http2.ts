import {
  arrayOf,
  BOOL,
  BYTES_U8,
  DYN,
  F64,
  HTTP2SESSION_T,
  HTTP2STREAM_T,
  HTTPREQ_T,
  HTTPRES_T,
  NETSERVER_T,
  NETSOCKET_T,
  STRING,
  VOID,
} from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The http2 builtin call slots. */
export const http2Signatures = defineLibFnSignatures({
  /** createSecureServer(options, handler) — the eager COMPAT handler as
   * the first 'request' listener (Node's exact route), on both literal
   * flavors: Req is the dual ALPN allowHTTP1 server, H2Req the ALPN=h2-only
   * server (both use compat handles over h2 streams). Args are
   * (cert, key, cb, enableConnectProtocol). */
  "http2.createSecureServerReq": { argTypes: [null, null, null, BOOL], result: NETSERVER_T },
  "http2.createSecureServerH2Req": { argTypes: [null, null, null, BOOL], result: NETSERVER_T },
  /** createSecureServer with a RUNTIME options record (the divergence-66
   * stance): allowHTTP1/cert/key read at runtime — allowHTTP1 picks the
   * flavor, the TLS server walk fences its out-of-bounds members with
   * the catchable runtime fence, and h2 session-tuning keys drop exactly
   * like the literal walk ignores them. May throw. The Cb form carries
   * the eager compat handler. */
  "http2.createSecureServerDyn": { argTypes: [DYN], result: NETSERVER_T },
  "http2.createSecureServerDynCb": { argTypes: [DYN, null], result: NETSERVER_T },
  // http2's allowHTTP1 compatibility server (divergence 57): cert/key
  // like tls.createServer; the 'request' handler arrives separately via
  // http.serverOnRequest (shape checked in the libCall case, like
  // http.createServer's). sessionError callback shape is checked by validate.ts.
  /** node:http2 allowHTTP1: one TLS server advertises h2 + http/1.1 and
   * dispatches to the matching parser after ALPN. Request listeners mirror
   * into both compatibility lists; the remaining session/req.stream rows
   * below retain their explicitly limited behavior. */
  "http2.createSecureServer": { argTypes: [null, null, BOOL], result: NETSERVER_T },
  // The SNI-callback form: arg 2 is the JS SNICallback closure — a
  // `(servername, cb) => void` func, or its `| undefined` union from the
  // conditional-spread spelling (the libCall case checks the shape).
  /** createSecureServer with an SNI callback: args are (cert, key, sniCb)
   * where sniCb is the JS SNICallback — a `(servername, cb) => void`
   * closure, or the `SNICallback | undefined` union from the conditional-
   * spread spelling (`...(x ? { SNICallback: x } : {})`; the emitter
   * unwraps the union — the undefined arm means "no callback", exactly
   * the no-SNI server). The runtime parses each connection's ClientHello
   * for the server_name extension BEFORE the TLS handshake begins, calls
   * the callback with (servername, answer-closure), and resumes the
   * handshake when the answer arrives — cb(err) tears the socket down
   * without an error event (Node's 'tlsClientError' default), cb(null, ctx) serves
   * ctx's cert/key, cb(null, undefined) serves the default pair. */
  "http2.createSecureServerSni": { argTypes: [null, null, null, BOOL], result: NETSERVER_T },
  // The ALPN=h2 server (createSecureServer without allowHTTP1): the real
  // h2 session machinery behind the TLS handshake.
  /** The REAL h2-over-TLS server (createSecureServer WITHOUT allowHTTP1):
   * scr_http2_create_secure_server — the h2c session machinery behind an
   * mbedTLS handshake whose ALPN advertises h2 alone (an http/1.1-only
   * client fails the handshake with no_application_protocol, Node's
   * h2-only split). args are (cert, key) — PEM strings or Buffers. */
  "http2.createSecureServerH2": { argTypes: [null, null, BOOL], result: NETSERVER_T },
  "http2.serverOnSessionError": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  /** The guarded absent-session compatibility call remains a no-op. */
  "http2.streamNoop": { argTypes: [], result: VOID },
  /** The UNGUARDED h2-only stream call (`req.stream.on(...)`): stream is
   * undefined on every connection the allowHTTP1 lowering accepts — and
   * on every HTTP/1.1 connection of Node's own allowHTTP1 server — so the
   * call IS Node's member read on undefined: throws the exact catchable
   * TypeError ("Cannot read properties of undefined (reading 'on')").
   * One arg: the read member's name (a string literal). Never returns. */
  "http2.streamUndefCall": { argTypes: [STRING], result: VOID },
  // The REAL h2c surface (scr_http2.c). Callback slots are null (the
  // emitter picks the thunk); pairs slots are string arrays; the
  // endStream tri-state and event flags ride as f64.
  /** node:http2, the REAL h2c surface (scr_http2.c — frame codec + HPACK
   * over the net loop; the design note atop that file has the story).
   * Sessions and streams are first-class handle kinds; 'stream'/'response'
   * payloads cross as flat [name, value, ...] pairs arrays and an EMITTED
   * adapter closure builds the program-side headers record (the response
   * :status rides separately as a number). */
  "http2.createServer": { argTypes: [], result: NETSERVER_T },
  "http2.createServerReq": { argTypes: [null], result: NETSERVER_T },
  /** createServer(options...): only settings.enableConnectProtocol is
   * honored (the RFC 8441 advertisement); the rest stay at defaults. */
  "http2.createServerOpts": { argTypes: [BOOL], result: NETSERVER_T },
  "http2.createServerReqOpts": { argTypes: [null, BOOL], result: NETSERVER_T },
  "http2.serverOnStream": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http2.serverOnSession": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  // connect(authority, reject, ca[, cb]): the TLS client knobs an https
  // authority reads (inert on http ones, exactly Node); ca is a PEM
  // string/Buffer ("" = the system anchors).
  /** connect(authority[, listener]) — h2c prior knowledge; the listener
   * closure (if any) is the 'connect' once-listener. */
  "http2.connect": { argTypes: [STRING, BOOL, null], result: HTTP2SESSION_T },
  "http2.performServerHandshake": { argTypes: [NETSOCKET_T], result: HTTP2SESSION_T },
  /** performServerHandshake(socket, options): the options literal still
   * evaluates (its calls and spreads run); the value is inert here. */
  "http2.performServerHandshakeOpts": {
    argTypes: [NETSOCKET_T, DYN],
    result: HTTP2SESSION_T,
  },
  "http2.connectCb": { argTypes: [STRING, BOOL, null, null], result: HTTP2SESSION_T },
  /** session.request(pairs?, endStream) — endStream is a tri-state f64:
   * -1 the method's payload-meaningless default, 0/1 explicit. */
  "http2.sessionRequest": {
    argTypes: [HTTP2SESSION_T, arrayOf(STRING), F64, BOOL],
    result: HTTP2STREAM_T,
  },
  "http2.sessionClose": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionCloseCb": { argTypes: [HTTP2SESSION_T, null], result: VOID },
  "http2.sessionDestroy": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionSetLocalWindowSize": { argTypes: [HTTP2SESSION_T, F64], result: VOID },
  "http2.sessionOnClose": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnError": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnConnect": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnStream": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionOnGoaway": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  // session.ping([payload, ]callback): the (err, duration, payload)
  // callback crosses the checked-dynamic boundary.
  "http2.sessionPing": { argTypes: [HTTP2SESSION_T, DYN], result: VOID },
  "http2.sessionPingPayload": { argTypes: [HTTP2SESSION_T, BYTES_U8, DYN], result: VOID },
  "http2.sessionOnPing": { argTypes: [HTTP2SESSION_T, null, BOOL], result: VOID },
  "http2.sessionConnecting": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionClosed": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionDestroyed": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionEncrypted": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.sessionType": { argTypes: [HTTP2SESSION_T], result: F64 },
  "http2.sessionAlpn": { argTypes: [HTTP2SESSION_T], result: STRING },
  "http2.sessionSocket": { argTypes: [HTTP2SESSION_T], result: NETSOCKET_T },
  /** stream.respond(pairs?, endStream) — the server answer. */
  "http2.streamRespond": { argTypes: [HTTP2STREAM_T, arrayOf(STRING), BOOL], result: VOID },
  /** respond(headers, { endStream, waitForTrailers }). */
  "http2.streamRespondWait": {
    argTypes: [HTTP2STREAM_T, arrayOf(STRING), BOOL, BOOL],
    result: VOID,
  },
  /** sendTrailers(headers) and additionalHeaders(headers). */
  "http2.streamSendTrailers": { argTypes: [HTTP2STREAM_T, arrayOf(STRING)], result: VOID },
  "http2.streamAdditionalHeaders": { argTypes: [HTTP2STREAM_T, arrayOf(STRING)], result: VOID },
  "http2.streamOnTrailers": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnHeaders": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnWantTrailers": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnContinue": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnReady": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnTimeout": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  /** setTimeout(msecs[, callback]) — the stream's own idle timer. */
  "http2.streamSetTimeout": { argTypes: [HTTP2STREAM_T, F64], result: VOID },
  "http2.streamSetTimeoutCb": { argTypes: [HTTP2STREAM_T, F64, null], result: VOID },
  /** priority(options) — deprecated by RFC 9113; accepted and ignored. */
  "http2.streamPriority": { argTypes: [HTTP2STREAM_T, DYN], result: VOID },
  "http2.streamPriority0": { argTypes: [HTTP2STREAM_T], result: VOID },
  /** res.writeInformation(statusCode[, headers]) on a compat response. */
  "http2.responseWriteInformation": {
    argTypes: [HTTPRES_T, F64, arrayOf(STRING)],
    result: BOOL,
  },
  "http2.streamWrite": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamWriteBytes": { argTypes: [HTTP2STREAM_T, BYTES_U8], result: VOID },
  "http2.streamEnd": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamEndStr": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamEndBytes": { argTypes: [HTTP2STREAM_T, BYTES_U8], result: VOID },
  "http2.streamClose": { argTypes: [HTTP2STREAM_T, F64], result: VOID },
  "http2.streamCloseCb": { argTypes: [HTTP2STREAM_T, F64, null], result: VOID },
  "http2.streamDestroy": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.sessionSettings0": { argTypes: [HTTP2SESSION_T], result: VOID },
  "http2.sessionSettings": { argTypes: [HTTP2SESSION_T, DYN], result: VOID },
  "http2.sessionSettingsDynCb": { argTypes: [HTTP2SESSION_T, DYN, DYN], result: VOID },
  "http2.sessionSettingsCb0": {
    argTypes: [HTTP2SESSION_T, DYN, { kind: "func", params: [], ret: VOID }],
    result: VOID,
  },
  "http2.sessionOnSettingsDyn": { argTypes: [HTTP2SESSION_T, DYN, BOOL, BOOL], result: VOID },
  "http2.sessionOnSettings0": {
    argTypes: [HTTP2SESSION_T, { kind: "func", params: [], ret: VOID }, BOOL, BOOL],
    result: VOID,
  },
  "http2.sessionSettingsGet": { argTypes: [HTTP2SESSION_T, BOOL], result: DYN },
  "http2.sessionPendingSettingsAck": { argTypes: [HTTP2SESSION_T], result: BOOL },
  "http2.getDefaultSettings": { argTypes: [], result: DYN },
  "http2.getPackedSettings0": { argTypes: [], result: BYTES_U8 },
  "http2.getPackedSettings": { argTypes: [DYN], result: BYTES_U8 },
  "http2.getUnpackedSettings": { argTypes: [BYTES_U8], result: DYN },
  "http2.streamSetEncoding": { argTypes: [HTTP2STREAM_T, STRING], result: VOID },
  "http2.streamSetEncodingRet": { argTypes: [HTTP2STREAM_T, STRING], result: HTTP2STREAM_T },
  "http2.streamResume": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamPause": { argTypes: [HTTP2STREAM_T], result: VOID },
  "http2.streamOnData": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnEnd": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnClose": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnAborted": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnError": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamOnResponse": { argTypes: [HTTP2STREAM_T, null, BOOL], result: VOID },
  "http2.streamId": { argTypes: [HTTP2STREAM_T], result: F64 },
  "http2.streamRstCode": { argTypes: [HTTP2STREAM_T], result: F64 },
  "http2.streamDestroyed": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamClosed": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamAborted": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamPending": { argTypes: [HTTP2STREAM_T], result: BOOL },
  /** ...statCheck: the trailing slot is the (stat, headers) callback. */
  "http2.streamRespondWithFile": {
    argTypes: [HTTP2STREAM_T, STRING, arrayOf(STRING), F64, F64, BOOL, DYN, DYN],
    result: VOID,
  },
  "http2.streamRespondWithFD": {
    argTypes: [HTTP2STREAM_T, F64, arrayOf(STRING), F64, F64, BOOL, DYN, DYN],
    result: VOID,
  },
  "http2.streamHeadersSent": { argTypes: [HTTP2STREAM_T], result: BOOL },
  // Http2ServerRequest.complete: true once aborted, ended or closed.
  "http2.reqComplete": { argTypes: [HTTPREQ_T], result: BOOL },
  /** Http2ServerRequest.url: the frame's :path, and Node's undefined when
   * the block carries none (CONNECT). The VOID is the nullable-string
   * sentinel (the interned `string | undefined` union; shape-checked in
   * validate.ts like net.sockRemoteAddress). */
  "http2.reqUrl": { argTypes: [HTTPREQ_T], result: VOID },
  // Every value a name has in a received [name, value, ...] pairs array:
  // the string[] a headers object holds for set-cookie.
  "http2.pairsValues": { argTypes: [arrayOf(STRING), STRING], result: arrayOf(STRING) },
  "http2.streamSession": { argTypes: [HTTP2STREAM_T], result: HTTP2SESSION_T },
  // Http2ServerResponse.statusMessage writes: evaluate the value, warn once.
  "http2.statusMessageUnsupported": { argTypes: [HTTPRES_T, DYN], result: VOID },
  "http2.statusMessageRead": { argTypes: [HTTPRES_T], result: VOID },
  "http2.streamEndAfterHeaders": { argTypes: [HTTP2STREAM_T], result: BOOL },
  "http2.streamBufferSize": { argTypes: [HTTP2STREAM_T], result: F64 },
  "http2.reqAuthority": { argTypes: [HTTPREQ_T], result: STRING },
  "http2.reqScheme": { argTypes: [HTTPREQ_T], result: STRING },
  /** The h2 server's Expect: 100-continue listeners (req, res). */
  "http2.serverOnCheckContinue": { argTypes: [NETSERVER_T, null, BOOL], result: VOID },
  "http2.streamSentHeaders": { argTypes: [HTTP2STREAM_T], result: DYN },
  "http2.streamSentInfoHeaders": { argTypes: [HTTP2STREAM_T], result: DYN },
  "http2.streamSentTrailers": { argTypes: [HTTP2STREAM_T], result: DYN },
  "http2.streamState": { argTypes: [HTTP2STREAM_T], result: DYN },
});
