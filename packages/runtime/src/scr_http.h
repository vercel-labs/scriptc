/* scriptc runtime — node:http (scr_http.c). Included by scr_runtime.h, which
 * says where new declarations go. */
#ifndef SCR_HTTP_H
#define SCR_HTTP_H

#include "scr_tls.h"

/* ── node:http, the server slice (scr_http.c — compiled only when the
 * program uses it; rides scr_net.c wholesale, design note atop the
 * file). http.createServer returns an ORDINARY ScrNetServer (listen/
 * close/address/'error' reuse the net surface); req/res are lean
 * refcounted handles, listeners dropping at settlement like sockets. */
typedef struct ScrHttpReq ScrHttpReq;
typedef struct ScrHttpRes ScrHttpRes;
typedef void (*ScrHttpReqFn)(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res); /* both +1 */
typedef void (*ScrHttpConnectH2Fn)(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res); /* both +1 */
/* 'upgrade' listeners, both sides: (req-or-res, socket, head) — all +1.
 * The parser steps aside (native reader cleared) and the socket is the
 * listener's raw stream; `head` carries bytes read past the 101/request
 * head. Requests with Connection: upgrade + an Upgrade header fire the
 * server list INSTEAD of 'request'; a 101 response fires the client list
 * INSTEAD of 'response'; either side with NO listener destroys the
 * socket, Node's default. */
typedef void (*ScrHttpUpgradeFn)(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);

ScrHttpReq *scr_http_req_retain(ScrHttpReq *r);
void scr_http_req_release(ScrHttpReq *r);
void *scr_http_req_retain_v(void *p);
void scr_http_req_release_v(void *p);
ScrHttpRes *scr_http_res_retain(ScrHttpRes *r);
void scr_http_res_release(ScrHttpRes *r);
void *scr_http_res_retain_v(void *p);
void scr_http_res_release_v(void *p);

/* ── the h2 compat seam (scr_http.c ⇄ scr_http2.c) ─────────────────────
 * Http2ServerRequest/Http2ServerResponse ARE the req/res handles above;
 * scr_http2.c (linked only when the real h2 surface is used) installs
 * the transport vtable — response write paths become HEADERS/DATA
 * frames — and the request-registration hook that routes
 * server.on("request", ...) on an h2-tagged server ctx to the h2
 * request list. scr_http.c links WITHOUT scr_http2.c, so the seam is a
 * pointer pair, never a hard symbol reference in that direction. */
typedef struct ScrHttpH2Ops {
  void *(*retain)(void *stream);
  void (*release)(void *stream);
  /* Serialize + send the response HEADERS frame: :status first, then the
   * set headers (connection-specific names dropped, h2's rule), then the
   * implicit date unless add_date is false (res.sendDate = false). */
  void (*respond)(void *stream, double status, ScrStr *const *names,
                  ScrStr *const *values, size_t nheaders, bool add_date);
  void (*write)(void *stream, const char *data, size_t n);
  void (*end)(void *stream, const char *data, size_t n); /* DATA + END_STREAM */
  void (*destroy)(void *stream);                          /* res.destroy: RST */
} ScrHttpH2Ops;

void scr_http_set_h2_ops(const ScrHttpH2Ops *ops);
void scr_http_set_h2_request_hook(void (*hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                               void *fn, bool once));
void scr_http_set_h2_connect_hook(void (*hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                               void *h1_fn, void *h2_fn, bool once));
void scr_http_set_h2_upgrade_hook(void (*hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                               void *fn, bool once));

/* The compat pair, built by scr_http2.c per server stream. */
ScrHttpReq *scr_http_h2_req_new(ScrNetSocket *sock /*borrowed, nullable*/,
                                 void *stream /*borrowed, nullable*/); /* +1 */
void *scr_http_req_h2_stream(ScrHttpReq *r); /* +1 or NULL */
void *scr_http_req_h2_stream_or_throw(ScrHttpReq *r, ScrStr *member /*borrowed*/); /* +1 */
void scr_http_h2_req_line(ScrHttpReq *r, ScrStr *method /*borrowed, nullable*/,
                           ScrStr *url /*borrowed, nullable*/);
void scr_http_h2_req_header(ScrHttpReq *r, ScrStr *name /*borrowed*/, ScrStr *value /*borrowed*/);
void scr_http_h2_req_data(ScrHttpReq *r, const char *data, size_t n);
void scr_http_h2_req_end(ScrHttpReq *r);
void scr_http_h2_req_aborted(ScrHttpReq *r);
void scr_http_h2_req_close(ScrHttpReq *r);
ScrHttpRes *scr_http_h2_res_new(ScrNetSocket *sock /*borrowed, nullable*/,
                                 void *stream /*borrowed*/); /* +1 */
void scr_http_h2_res_close(ScrHttpRes *r);
bool scr_http_h2_res_finished(ScrHttpRes *r);
void scr_http_req_on_aborted(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once);
ScrStr *scr_http_req_http_version(ScrHttpReq *r); /* +1 — "1.0"/"1.1"/"2.0" */
double scr_http_req_http_version_major(ScrHttpReq *r);
double scr_http_req_http_version_minor(ScrHttpReq *r);
bool scr_http_req_aborted_flag(ScrHttpReq *r);
bool scr_http_req_complete(ScrHttpReq *r);

/* Registers the httpReq/httpRes handle-dispatch ops (SCR_DYNH_HTTP_REQ /
 * SCR_DYNH_HTTP_RES) — emitted main() calls this exactly when the http
 * unit is linked (the scr_net_dyn_install story). */
void scr_http_dyn_install(void);
void scr_http_validate_header_name(ScrStr *name /*borrowed*/, ScrStr *label /*borrowed*/);
void scr_http_validate_header_value(ScrStr *name /*borrowed*/, const ScrDyn *value /*borrowed*/);
ScrDyn *scr_http_status_codes(void); /* +1, shared mutable Node v24 table */
ScrArr *scr_http_methods(void); /* +1, shared mutable Node v24 array */

ScrNetServer *scr_http_create_server(ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn); /* +1 */
/* The unguarded h2-only stream call: throws Node's exact catchable
 * TypeError (member read on undefined). Borrows; never returns. */
void scr_http2_stream_undef_call(ScrStr *member);
/* Late 'request' listener install (server.on/once("request", ...)) — the
 * http2 allowHTTP1 server's handler route (created handler-less), and
 * http.Server's 'request' event. Listeners resolve at REQUEST time (the
 * emit), Node's dispatch. On a server with no HTTP parser (a plain net
 * server) the closure releases unregistered: 'request' never fires
 * there, like Node. */
void scr_http_server_on_request(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrHttpReqFn fn, bool once);
void scr_http1_ctx_on_request(void *ctx, ScrClosure *cb /*moves*/, ScrHttpReqFn fn, bool once,
                              ScrNetOnce *shared_once /*moves, nullable*/);
void scr_http1_ctx_on_connect(void *ctx, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once,
                              ScrNetOnce *shared_once /*moves, nullable*/);
void scr_http1_ctx_on_upgrade(void *ctx, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once);
void scr_http1_ctx_settle(void *ctx);
ScrStr *scr_http_req_url(ScrHttpReq *r);      /* +1 */
ScrStr *scr_http_req_method(ScrHttpReq *r);   /* +1 */
ScrStr *scr_http_req_header(ScrHttpReq *r, ScrStr *name /*borrowed*/); /* +1 or NULL (undefined arm) */
ScrStr *scr_http_req_trailer(ScrHttpReq *r, ScrStr *name /*borrowed*/); /* +1 or NULL */
ScrArr *scr_http_req_header_values(ScrHttpReq *r, ScrStr *name /*borrowed*/); /* +1 or NULL */
ScrArr *scr_http_req_header_list(ScrHttpReq *r, ScrStr *name /*borrowed*/); /* +1, empty when absent */
ScrArr *scr_http_req_trailer_values(ScrHttpReq *r, ScrStr *name /*borrowed*/); /* +1 or NULL */
void scr_http_req_on_data(ScrHttpReq *r, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once);
/* req.pipe(dest): the IncomingMessage body streams into the destination;
 * natural end ends it (Node's pipe default). Declared below the client
 * typedef for the ClientRequest leg. */
void scr_http_req_pipe_res(ScrHttpReq *r, ScrHttpRes *dst /*borrowed*/);
void scr_http_req_pipe_sock(ScrHttpReq *r, ScrNetSocket *dst /*borrowed*/);
void scr_http_req_on_end(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once);
void scr_http_res_set_header(ScrHttpRes *r, ScrStr *name /*borrowed*/, ScrStr *value /*borrowed*/);
/* setHeader/appendHeader with a number, string or array value (borrowed);
 * may throw ERR_HTTP_INVALID_HEADER_VALUE. */
void scr_http_res_set_header_dyn(ScrHttpRes *r, ScrStr *name /*borrowed*/, ScrDyn *value /*borrowed*/);
void scr_http_res_append_header_dyn(ScrHttpRes *r, ScrStr *name /*borrowed*/, ScrDyn *value /*borrowed*/);
void scr_http_res_write_head(ScrHttpRes *r, double status);
void scr_http_res_write_head_n(ScrHttpRes *r, double status, ScrArr *names /*borrowed*/, ScrArr *values /*borrowed*/);
void scr_http_res_write_continue(ScrHttpRes *r);
void scr_http_res_write_processing(ScrHttpRes *r);
void scr_http_res_write_early_hints(ScrHttpRes *r, ScrArr *pairs /*borrowed: [name, value, ...] */);
/* writeHead with a CHECKED-DYNAMIC headers object (borrowed): OBJ
 * entries setHeader in insertion order (string/number values), then the
 * head goes out; undefined/null = the plain head; may throw. */
void scr_http_res_write_head_dyn(ScrHttpRes *r, double status, const ScrDyn *headers);
void scr_http_res_write_str(ScrHttpRes *r, ScrStr *data /*borrowed*/);
void scr_http_res_write_bytes(ScrHttpRes *r, ScrBytes *data /*borrowed*/);
void scr_http_res_end(ScrHttpRes *r);
/* socket.pipe(res): raw source chunks become response body writes; EOF
 * ends the response (the extended-CONNECT bridge leg). Borrows both. */
void scr_http_sock_pipe_res(ScrNetSocket *src, ScrHttpRes *dst /*borrowed*/);
void scr_http_res_end_str(ScrHttpRes *r, ScrStr *data /*borrowed*/);
void scr_http_res_end_bytes(ScrHttpRes *r, ScrBytes *data /*borrowed*/);
void scr_http_res_add_trailers(ScrHttpRes *r, ScrArr *pairs /*borrowed: [name, value, ...] */);
/* Checked-dynamic chunk forms (the scr_net_sock_write_dynv story). */
void scr_http_res_write_dynv(ScrHttpRes *r, const ScrDyn *d /*borrowed*/);
void scr_http_res_end_dynv(ScrHttpRes *r, const ScrDyn *d /*borrowed*/);
bool scr_http_res_headers_sent(ScrHttpRes *r);
bool scr_http_res_writable_ended(ScrHttpRes *r);
bool scr_http_res_send_date(ScrHttpRes *r);
void scr_http_res_set_send_date(ScrHttpRes *r, bool value);
bool scr_http_res_strict_content_length(ScrHttpRes *r);
void scr_http_res_set_strict_content_length(ScrHttpRes *r, bool value);
ScrHttpReq *scr_http_res_request(ScrHttpRes *r); /* +1 */
ScrNetSocket *scr_http_res_socket(ScrHttpRes *r); /* +1 or NULL after finish */
bool scr_http_res_writable_finished(ScrHttpRes *r);
/* The res member surface: statusCode (200 until assigned; inert once the
 * head went out), statusMessage (the reason phrase — assigned value, or
 * the code's default), the header CRUD trio, and end(cb)'s finish slot
 * (fires deferred once the body went out — the res 'close' precedent). */
double scr_http_res_status_get(ScrHttpRes *r);
void scr_http_res_status_set(ScrHttpRes *r, double status);
ScrStr *scr_http_res_status_msg_get(ScrHttpRes *r); /* +1 */
void scr_http_res_status_msg_set(ScrHttpRes *r, ScrStr *msg /*borrowed*/);
ScrStr *scr_http_res_get_header(ScrHttpRes *r, ScrStr *name /*borrowed*/); /* +1 or NULL */
ScrDyn *scr_http_res_get_header_dyn(ScrHttpRes *r, ScrStr *name /*borrowed*/); /* +1, undefined when absent */
ScrArr *scr_http_res_get_header_names(ScrHttpRes *r); /* +1 */
ScrArr *scr_http_res_get_raw_header_names(ScrHttpRes *r); /* +1 */
ScrDyn *scr_http_res_get_headers(ScrHttpRes *r); /* +1 */
bool scr_http_res_has_header_named(ScrHttpRes *r, ScrStr *name /*borrowed*/);
void scr_http_res_remove_header(ScrHttpRes *r, ScrStr *name /*borrowed*/);
void scr_http_res_on_finish(ScrHttpRes *r, ScrClosure *cb /*moves*/);
void scr_http_res_on_end_callback(ScrHttpRes *r, ScrClosure *cb /*moves*/);
/* createServer({ joinDuplicateHeaders: true }): repeated request-header
 * names read back joined ", " (Node's option; the default keeps first). */
void scr_http_server_join_duplicate_headers(ScrNetServer *s);
/* createServer({ requireHostHeader: false }): allow HTTP/1.1 without Host. */
void scr_http_server_allow_missing_host_header(ScrNetServer *s);
void scr_http_handler_thunk0(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res);
void scr_http_handler_thunk1(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res);
void scr_http_handler_thunk2(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res);
/* server.on("connect", ...) — fired instead of 'request' for CONNECT.
 * HTTP/1 uses (req, socket, head); HTTP/2 compatibility uses (req, res). */
void scr_http_server_on_connect(ScrNetServer *s, ScrClosure *cb /*moves*/,
                                 ScrHttpUpgradeFn h1_fn, ScrHttpConnectH2Fn h2_fn,
                                 bool once);
void scr_http_server_on_upgrade(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once);
/* server.on('checkContinue' | 'checkExpectation', listener). */
void scr_http_server_on_check(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrHttpReqFn fn, bool once,
                              bool expectation);
/* The maxHeaderSize option of createServer / http.request; throws Node's
 * ERR_OUT_OF_RANGE for a negative or non-integer value. */
void scr_http_server_max_header_size(ScrNetServer *s, double value);
ScrArr *scr_http_req_raw_headers(ScrHttpReq *r); /* +1 — [name, value, ...], arrival order/case */
ScrArr *scr_http_req_header_pairs(ScrHttpReq *r); /* +1 — lowercased names, the headers snapshot */
ScrArr *scr_http_req_header_lines(ScrHttpReq *r); /* +1 — every line, lowercased names */
ScrArr *scr_http_req_raw_trailers(ScrHttpReq *r); /* +1 — wire order/case after end */
ScrArr *scr_http_req_trailer_pairs(ScrHttpReq *r); /* +1 — lowercased, joined snapshot after end */
ScrStr *scr_http_req_status_message(ScrHttpReq *r); /* +1 or NULL (undefined arm: server request) */
void scr_http_upgrade_thunk0(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);
void scr_http_upgrade_thunk1(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);
void scr_http_upgrade_thunk2(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);
void scr_http_upgrade_thunk3(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head);

/* The member follow-ups (statusCode / socket / resume / destroy / the
 * error+close listener slots on requests; destroy / close / the
 * flat-pairs writeHead on responses). */
double scr_http_req_status(ScrHttpReq *r); /* < 0 = the undefined arm (server request) */
ScrNetSocket *scr_http_req_socket(ScrHttpReq *r); /* +1 */
void scr_http_req_resume(ScrHttpReq *r);
/* pause()/resume() hold and drain 'data'/'end' delivery (the parser keeps
 * consuming; the drain rides the emit queue); setTimeout delegates to the
 * socket's idle timer; the flags back req.destroyed/req.readable. */
void scr_http_req_pause(ScrHttpReq *r);
void scr_http_req_set_timeout(ScrHttpReq *r, double ms, ScrClosure *cb /*moves, nullable*/);
void scr_http_req_set_timeout_plain(ScrHttpReq *r, double ms);
bool scr_http_req_destroyed_flag(ScrHttpReq *r);
bool scr_http_req_readable(ScrHttpReq *r);
/* flushHeaders/cork/uncork/writableCorked, the res.req backref, the
 * socket-delegated setTimeout, and write(chunk, cb)'s deferred callback. */
void scr_http_res_flush_headers(ScrHttpRes *r);
void scr_http_res_cork(ScrHttpRes *r);
void scr_http_res_uncork(ScrHttpRes *r);
double scr_http_res_writable_corked(ScrHttpRes *r);
bool scr_http_res_destroyed_flag(ScrHttpRes *r);
void scr_http_res_set_req(ScrHttpRes *r, ScrHttpReq *req /*borrowed, nullable*/);
void scr_http_res_set_timeout(ScrHttpRes *r, double ms, ScrClosure *cb /*moves, nullable*/);
void scr_http_res_set_timeout_plain(ScrHttpRes *r, double ms);
void scr_http_res_on_write_flush(ScrHttpRes *r, ScrClosure *cb /*moves*/);
/* req.setEncoding(enc) — the socket twin's contract; may throw. */
void scr_http_req_set_encoding(ScrHttpReq *r, ScrStr *enc /*borrowed*/);
void scr_http_req_destroy(ScrHttpReq *r);
void scr_http_req_on_error(ScrHttpReq *r, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_http_req_on_close(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once);
void scr_http_res_destroy(ScrHttpRes *r);
void scr_http_res_on_close(ScrHttpRes *r, ScrClosure *cb /*moves*/, bool once);
void scr_http_res_write_head_pairs(ScrHttpRes *r, double status, ScrArr *pairs /*borrowed*/);

/* node:http, the CLIENT slice (http.request/http.get over the net client
 * machinery — one dialed connection per request, no agent pooling; the
 * wire head is Node's exactly). The response arrives as a ScrHttpReq. */
typedef struct ScrHttpClientReq ScrHttpClientReq;
typedef void (*ScrHttpRespFn)(ScrClosure *cb, ScrHttpReq *res); /* res +1 */
ScrHttpClientReq *scr_http_client_retain(ScrHttpClientReq *c);
void scr_http_client_release(ScrHttpClientReq *c);
void *scr_http_client_retain_v(void *p);
void scr_http_client_release_v(void *p);
ScrHttpClientReq *scr_http_request(ScrStr *host /*borrowed*/, double port,
                                    ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                    double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                    bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                    ScrHttpRespFn fn); /* +1 */
/* The createConnection form: conn_cb (a `() => net.Socket` closure) runs
 * once, synchronously, and supplies the exchange's socket. */
ScrHttpClientReq *scr_http_request_conn(ScrClosure *conn_cb /*moves*/, ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/, double timeout_ms, ScrArr *header_pairs /*borrowed*/, bool auto_end, ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn); /* +1 */
void scr_http_client_write_str(ScrHttpClientReq *c, ScrStr *data /*borrowed*/);
void scr_http_client_write_bytes(ScrHttpClientReq *c, ScrBytes *data /*borrowed*/);
void scr_http_client_end(ScrHttpClientReq *c);
void scr_http_client_end_str(ScrHttpClientReq *c, ScrStr *data /*borrowed*/);
void scr_http_client_end_bytes(ScrHttpClientReq *c, ScrBytes *data /*borrowed*/);
void scr_http_client_flush_headers(ScrHttpClientReq *c);
void scr_http_client_set_header(ScrHttpClientReq *c, ScrStr *name /*borrowed*/, ScrStr *value /*borrowed*/);
ScrStr *scr_http_client_get_header(ScrHttpClientReq *c, ScrStr *name /*borrowed*/); /* +1 or NULL */
bool scr_http_client_has_header_named(ScrHttpClientReq *c, ScrStr *name /*borrowed*/);
void scr_http_client_remove_header(ScrHttpClientReq *c, ScrStr *name /*borrowed*/);
ScrArr *scr_http_client_get_header_names(ScrHttpClientReq *c); /* +1 */
ScrArr *scr_http_client_get_raw_header_names(ScrHttpClientReq *c); /* +1 */
ScrDyn *scr_http_client_get_headers(ScrHttpClientReq *c); /* +1 */
ScrStr *scr_http_client_method(ScrHttpClientReq *c); /* +1 */
ScrStr *scr_http_client_path(ScrHttpClientReq *c); /* +1 */
ScrStr *scr_http_client_host(ScrHttpClientReq *c); /* +1 */
ScrStr *scr_http_client_protocol(ScrHttpClientReq *c); /* +1 */
bool scr_http_client_headers_sent(ScrHttpClientReq *c);
bool scr_http_client_writable_ended(ScrHttpClientReq *c);
bool scr_http_client_writable_finished(ScrHttpClientReq *c);
ScrNetSocket *scr_http_client_socket(ScrHttpClientReq *c); /* +1 */
bool scr_http_client_reused_socket(ScrHttpClientReq *c);
void scr_http_client_set_nodelay(ScrHttpClientReq *c, bool enable);
void scr_http_client_set_socket_keepalive(ScrHttpClientReq *c, bool enable, double delay_ms);
void scr_http_client_set_timeout_cb(ScrHttpClientReq *c, double ms, ScrClosure *cb /*moves*/);
void scr_http_client_add_trailers(ScrHttpClientReq *c, ScrArr *pairs /*borrowed*/);
void scr_http_client_cork(ScrHttpClientReq *c);
void scr_http_client_uncork(ScrHttpClientReq *c);
double scr_http_client_writable_corked(ScrHttpClientReq *c);
/* Checked-dynamic chunk forms (the scr_net_sock_write_dynv story). */
void scr_http_client_write_dynv(ScrHttpClientReq *c, const ScrDyn *d /*borrowed*/);
void scr_http_client_end_dynv(ScrHttpClientReq *c, const ScrDyn *d /*borrowed*/);
void scr_http_client_set_timeout(ScrHttpClientReq *c, double ms);
void scr_http_client_destroy(ScrHttpClientReq *c);
/* req.destroy(err): err (borrowed) becomes the request's 'error'. */
void scr_http_client_destroy_error(ScrHttpClientReq *c, ScrError *err);
void scr_http_client_max_header_size(ScrHttpClientReq *c, double value); /* see the server form */
/* http.request's `signal` option (borrowed), checked before the request
 * is built. May throw ERR_INVALID_ARG_TYPE. */
void scr_http_client_signal_check(const ScrDyn *signal);
/* http.request's `signal` option (borrowed); `add` is
 * events.addAbortListener. May throw ERR_INVALID_ARG_TYPE. */
void scr_http_client_add_abort_signal(ScrHttpClientReq *c, ScrDyn *signal,
                                      ScrDyn *(*add)(ScrDyn *signal, ScrDyn *listener));
void scr_http_client_abort(ScrHttpClientReq *c);
bool scr_http_client_aborted(ScrHttpClientReq *c);
bool scr_http_client_destroyed(ScrHttpClientReq *c);
void scr_http_client_on_response(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrHttpRespFn fn, bool once);
void scr_http_client_on_socket(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrNetConnFn fn, bool once);
void scr_http_client_on_finish(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once);
void scr_http_client_on_abort(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once);
void scr_http_client_on_continue(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once);
void scr_http_client_on_error(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_http_client_on_timeout(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once);
void scr_http_client_on_close(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once);
void scr_http_client_on_upgrade(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once);
void scr_http_req_pipe_client(ScrHttpReq *r, ScrHttpClientReq *dst /*borrowed*/);
void scr_http_resp_thunk0(ScrClosure *cb, ScrHttpReq *res);
void scr_http_resp_thunk_res(ScrClosure *cb, ScrHttpReq *res);
/* The transport-parameterized client constructor (scr_tls.c's https
 * entry): `wrap` (nullable) installs a transport on the freshly dialed
 * socket before any bytes go out (they buffer until the handshake
 * establishes), and `default_port` is the port the Host header omits
 * (80 for http, 443 for https — Node's rule). scr_http_request is this
 * with no wrap and port 80. */
ScrHttpClientReq *scr_http_request_ex(ScrStr *host /*borrowed*/, double port,
                                       ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                       double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                       bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                       ScrHttpRespFn fn, int default_port,
                                       void (*wrap)(ScrNetSocket *, void *), void *wrap_ctx); /* +1 */
/* The URL-string client form (http.get('http://host:port/path')): parses
 * through the WHATWG unit; throws catchably on an unparsable input
 * ("Invalid URL") or a non-http scheme (ERR_INVALID_PROTOCOL) and
 * returns NULL with the exception pending. cb MOVES (nullable). */
ScrHttpClientReq *scr_http_request_url(ScrStr *url /*borrowed*/, ScrStr *method /*borrowed*/,
                                        bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                        ScrHttpRespFn fn); /* +1 */
/* Its parse half, shared with scr_tls.c's https spelling: the scheme is
 * checked against `secure` (the calling module), so a mismatch is Node's
 * ERR_INVALID_PROTOCOL rather than an implicit scheme switch. false = the
 * exception is pending and no out-parameter was written. */
bool scr_http_url_parts(ScrStr *url /*borrowed*/, bool secure, ScrStr **host_out /*+1*/,
                         double *port_out, ScrStr **path_out /*+1*/);
/* ── the http Agent (new http.Agent(opts) — option surface, getName, and
 * the maxSockets queue over one-dial-per-request connections; keep-alive
 * POOLING is not modeled: keepAlive: true fences at construction).
 * agent_new answers the SCR_DYNH_HTTP_AGENT handle (+1 dyn) or throws.
 * max_sockets/max_free arrive < 0 for "unset" (Infinity / 256);
 * timeout_ms < 0 = no idle timer. request_agent_ex threads the agent dyn
 * (undefined/null = the default path; false = one-shot with Connection:
 * close; an Agent handle = queue accounting); port < 0 means "no port
 * option" — the agent's (settable) defaultPort, then the scheme's. */
ScrDyn *scr_http_agent_new(bool secure, bool keep_alive, double ka_msecs,
                            double max_sockets, double max_free, double timeout_ms,
                            double port /* < 0 = unset: the option-merge default */,
                            const ScrDyn *scheduling /* borrowed; NULL = 'lifo' */); /* +1 */
ScrHttpClientReq *scr_http_request_agent_ex(ScrStr *host /*borrowed*/, double port,
                                             ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                             double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                             bool auto_end, const ScrDyn *agent /*borrowed*/,
                                             ScrClosure *cb /*moves, nullable*/,
                                             ScrHttpRespFn fn, int default_port,
                                             void (*wrap)(ScrNetSocket *, void *), void *wrap_ctx,
                                             ScrStr *pool_key /*borrowed, nullable: https TLS options*/); /* +1 */
/* http.globalAgent / https.globalAgent: borrowed, and as a +1 value. */
const ScrDyn *scr_http_global_agent(bool secure);
ScrDyn *scr_http_global_agent_value(bool secure);
ScrHttpClientReq *scr_http_request_agent(ScrStr *host /*borrowed*/, double port,
                                          ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                          double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                          bool auto_end, const ScrDyn *agent /*borrowed*/,
                                          ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn); /* +1 */
/* http.request/get with a runtime options record (a RequestOptions
 * variable, or a literal spreading one or setting socketPath). The walk
 * reads the record in the ClientRequest constructor's order; https adds
 * its TLS options (scr_tls.c) and sends through the same path. */
typedef struct ScrHttpReqOpts {
  ScrStr *host;          /* +1: hostname || host || "localhost" */
  double port;           /* < 0: no port option */
  int default_port;      /* defaultPort, the agent's, or the scheme's */
  ScrStr *path;          /* +1 */
  ScrStr *method;        /* +1, upper-cased */
  double timeout;        /* 0 = none */
  ScrArr *headers;       /* +1 name/value pairs */
  ScrDyn *agent;         /* +1, NULL = the global agent */
  ScrDyn *signal;        /* +1, NULL = none */
  ScrStr *socket_path;   /* +1, NULL = dial host:port */
  double max_header_size;
  bool has_max_header_size;
  ScrDyn *view;          /* +1 materialized typed record, if any */
} ScrHttpReqOpts;
bool scr_http_req_opts_read(const ScrDyn *opts /*borrowed*/, bool secure, const char *api,
                            ScrHttpReqOpts *o); /* false = exception pending */
void scr_http_req_opts_free(ScrHttpReqOpts *o);
void scr_http_req_opts_fence(const char *api, const char *key, const char *hint); /* throws */
ScrHttpClientReq *scr_http_req_opts_send(ScrHttpReqOpts *o, bool auto_end,
                                         ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn,
                                         ScrDyn *(*add_abort)(ScrDyn *signal, ScrDyn *listener),
                                         void (*wrap)(ScrNetSocket *, void *), void *wrap_ctx,
                                         ScrStr *pool_key /*borrowed, nullable*/); /* +1 */
ScrHttpClientReq *scr_http_request_dyn(const ScrDyn *opts /*borrowed*/, bool auto_end,
                                       ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn,
                                       ScrDyn *(*add_abort)(ScrDyn *signal, ScrDyn *listener)); /* +1 */
ScrHttpClientReq *scr_https_request_dyn(const ScrDyn *opts /*borrowed*/, bool auto_end,
                                        ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn,
                                        ScrDyn *(*add_abort)(ScrDyn *signal, ScrDyn *listener)); /* +1 */
#ifdef SCR_RC_AUDIT
long scr_http_live_count(void);
#endif

#endif /* SCR_HTTP_H */
