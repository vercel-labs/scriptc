/* scriptc runtime — node:http2 (scr_http2.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_HTTP2_H
#define SCR_HTTP2_H

#include "scr_http.h"

/* ── node:http2 (scr_http2.c — REAL HTTP/2: h2c server + client over
 * the net loop, with an in-tree RFC 7540 frame codec and RFC 7541 HPACK;
 * the design note atop scr_http2.c has the full story). Sessions and
 * streams are refcounted handles like the net pair; 'stream'/'response'
 * payloads cross as flat [name, value, ...] pairs arrays and the EMITTED
 * adapter closure builds the program-side headers record (the response
 * :status rides separately as a number — no string→number conversion
 * exists program-side). The srv-ctx `proto` tags (SCR_NET_PROTO_*) keep
 * the two parser families apart on the shared http_ctx alias slot. */
enum { SCR_NET_PROTO_HTTP1 = 1, SCR_NET_PROTO_H2 = 2 };

typedef struct ScrH2Session ScrH2Session;
typedef struct ScrH2Stream ScrH2Stream;
typedef void (*ScrH2SessionErrorFn)(ScrClosure *cb, ScrStr *msg,
                                    ScrH2Session *session); /* session +1 */

typedef void (*ScrH2StreamFn)(ScrClosure *cb, ScrH2Stream *st, ScrArr *pairs, double flags); /* st, pairs +1 */
typedef void (*ScrH2RespFn)(ScrClosure *cb, ScrArr *pairs, double status, double flags);     /* pairs +1 */
typedef void (*ScrH2SessionFn)(ScrClosure *cb, ScrH2Session *sess);                          /* sess +1 */
typedef void (*ScrH2ConnectFn)(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock);      /* both +1; sock nullable */
typedef void (*ScrH2GoawayFn)(ScrClosure *cb, double code, double last);
typedef void (*ScrH2SettingsFn)(ScrClosure *cb, ScrDyn *settings /*+1*/);

ScrH2Session *scr_http2_session_retain(ScrH2Session *s);
void scr_http2_session_release(ScrH2Session *s);
void *scr_http2_session_retain_v(void *p);
void scr_http2_session_release_v(void *p);
ScrH2Stream *scr_http2_stream_retain(ScrH2Stream *st);
void scr_http2_stream_release(ScrH2Stream *st);
void *scr_http2_stream_retain_v(void *p);
void scr_http2_stream_release_v(void *p);

/* server (an ordinary net server handle; listen/close/address/'error'
 * ride the net surface — the scr_http.c shape) */
ScrNetServer *scr_http2_create_server(void); /* +1 */
/* createServer(handler): the eager (req, res) COMPAT handler — the first
 * 'request' listener (Http2ServerRequest/Response over h2 streams). */
ScrNetServer *scr_http2_create_server_req(ScrClosure *handler /*moves*/, ScrHttpReqFn fn); /* +1 */
/* The REAL h2-over-TLS server (http2.createSecureServer({ cert, key })):
 * the same session machinery behind an mbedTLS handshake whose ALPN
 * advertises h2 alone — protocol-identical after establishment. */
ScrNetServer *scr_http2_create_secure_server(const char *cert, size_t cert_len, const char *key, size_t key_len, bool enable_connect_protocol); /* +1 */
ScrNetServer *scr_http2_create_secure_server_allow_http1(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn, ScrClosure *sni_cb /*moves, nullable*/, void *sni_answer_fn, bool enable_connect_protocol); /* +1 */
/* createSecureServer(options, handler): the eager COMPAT handler as the
 * first 'request' listener over the ALPN=h2 server (the createServerReq
 * route, secured). */
ScrNetServer *scr_http2_create_secure_server_req(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn, bool enable_connect_protocol); /* +1 */
/* createSecureServer with a RUNTIME options record (the divergence-66
 * stance): allowHTTP1 picks the flavor at runtime, cert/key ride the
 * shared TLS server walk (out-of-bounds members throw the catchable
 * fence), h2 session-tuning keys drop like the literal walk ignores
 * them. +1, or NULL with the exception pending. */
ScrNetServer *scr_http2_create_secure_server_dyn(const struct ScrDyn *opts /*borrowed*/, ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn);
/* The TLS server-options walk (scr_tls.c) — runtime-internal, shared
 * with scr_http2.c's createSecureServerDyn. */
bool scr_tls_srv_opts_walk(const struct ScrDyn *opts, const char *api, ScrBytes **cert_out, ScrBytes **key_out);
void scr_http2_server_on_stream(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrH2StreamFn fn, bool once);
void scr_http2_server_on_session(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrH2SessionFn fn, bool once);

/* client — h2c prior knowledge for http authorities, the TLS transport
 * with ALPN ["h2"] for https ones (ca len 0 = the system anchors;
 * reject_unauthorized false disables the verify gate — the local-CA
 * self-connect shapes); throws catchably on bad input */
ScrH2Session *scr_http2_connect(ScrStr *url /*borrowed*/, bool reject_unauthorized,
                                 const char *ca /*borrowed, NULL = none*/, size_t ca_len,
                                 ScrClosure *cb /*moves, nullable*/,
                                 ScrH2ConnectFn fn); /* +1 */
/* end_stream: -1 = the method's payload-meaningless default, 0/1 explicit */
ScrH2Stream *scr_http2_session_request(ScrH2Session *s, ScrArr *pairs /*borrowed, nullable*/,
                                        double end_stream); /* +1; may throw */

/* session */
void scr_http2_session_close(ScrH2Session *s, ScrClosure *cb /*moves, nullable*/);
void scr_http2_session_destroy(ScrH2Session *s);
void scr_http2_session_on_close(ScrH2Session *s, ScrClosure *cb /*moves*/, bool once);
void scr_http2_session_on_error(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_http2_server_on_session_error(ScrNetServer *s, ScrClosure *cb /*moves*/,
                                       ScrH2SessionErrorFn fn, bool once);
void scr_http2_session_error_thunk0(ScrClosure *cb, ScrStr *msg, ScrH2Session *session);
void scr_http2_session_error_thunk1(ScrClosure *cb, ScrStr *msg, ScrH2Session *session);
void scr_http2_session_error_thunk2(ScrClosure *cb, ScrStr *msg, ScrH2Session *session);
void scr_http2_session_on_connect(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2ConnectFn fn, bool once);
void scr_http2_session_on_stream(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2StreamFn fn, bool once);
void scr_http2_session_on_goaway(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2GoawayFn fn, bool once);
/* The settings surface: session.settings(obj[, cb]) sends a SETTINGS
 * frame; local/remote listener lists fire with the settings record on
 * ACK/receipt; the property reads answer the tracked records. */
void scr_http2_session_settings(ScrH2Session *s, const ScrDyn *settings /*borrowed, nullable*/,
                                 ScrClosure *cb /*moves, nullable*/, ScrH2SettingsFn cbfn);
void scr_http2_session_on_settings(ScrH2Session *s, ScrClosure *cb /*moves*/, ScrH2SettingsFn fn,
                                    bool once, bool local);
ScrDyn *scr_http2_session_settings_get(ScrH2Session *s, bool local); /* +1 */
bool scr_http2_session_pending_settings_ack(ScrH2Session *s);
ScrDyn *scr_http2_get_default_settings(void); /* +1 */
void scr_http2_settings_thunk(ScrClosure *cb, ScrDyn *settings);
void scr_http2_settings_thunk0(ScrClosure *cb, ScrDyn *settings);
void scr_http2_session_settings_dyncb(ScrH2Session *s, const ScrDyn *settings /*borrowed*/,
                                       const ScrDyn *cb /*borrowed*/);
void scr_http2_session_on_settings_dyn(ScrH2Session *s, const ScrDyn *cb /*borrowed*/,
                                        bool once, bool local);
bool scr_http2_session_closed(ScrH2Session *s);
bool scr_http2_session_destroyed(ScrH2Session *s);
bool scr_http2_session_encrypted(ScrH2Session *s);
double scr_http2_session_type(ScrH2Session *s); /* 0 server / 1 client */
ScrStr *scr_http2_session_alpn(ScrH2Session *s); /* +1 */
ScrNetSocket *scr_http2_session_socket(ScrH2Session *s); /* +1, NULL after teardown */

/* stream */
void scr_http2_stream_respond(ScrH2Stream *st, ScrArr *pairs /*borrowed, nullable*/, bool end_stream);
void scr_http2_stream_write_str(ScrH2Stream *st, ScrStr *data /*borrowed*/);
void scr_http2_stream_write_bytes(ScrH2Stream *st, ScrBytes *data /*borrowed*/);
void scr_http2_stream_end(ScrH2Stream *st);
void scr_http2_stream_end_str(ScrH2Stream *st, ScrStr *data /*borrowed*/);
void scr_http2_stream_end_bytes(ScrH2Stream *st, ScrBytes *data /*borrowed*/);
void scr_http2_stream_close(ScrH2Stream *st, double code, ScrClosure *cb /*moves, nullable*/);
void scr_http2_stream_destroy(ScrH2Stream *st);
void scr_http2_stream_set_encoding(ScrH2Stream *st, ScrStr *enc /*borrowed*/); /* may throw */
ScrH2Stream *scr_http2_stream_set_encoding_ret(ScrH2Stream *st, ScrStr *enc /*borrowed*/); /* +1; may throw */
void scr_http2_stream_resume(ScrH2Stream *st);
void scr_http2_stream_pause(ScrH2Stream *st);
void scr_http2_stream_on_data(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once);
void scr_http2_stream_on_end(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once);
void scr_http2_stream_on_close(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once);
void scr_http2_stream_on_aborted(ScrH2Stream *st, ScrClosure *cb /*moves*/, bool once);
void scr_http2_stream_on_error(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_http2_stream_on_response(ScrH2Stream *st, ScrClosure *cb /*moves*/, ScrH2RespFn fn, bool once);
double scr_http2_stream_id(ScrH2Stream *st);
double scr_http2_stream_rst_code(ScrH2Stream *st);
bool scr_http2_stream_destroyed(ScrH2Stream *st);
bool scr_http2_stream_closed(ScrH2Stream *st);
bool scr_http2_stream_aborted(ScrH2Stream *st);
bool scr_http2_stream_pending(ScrH2Stream *st);
ScrH2Session *scr_http2_stream_session(ScrH2Stream *st); /* +1 */

/* the emitted-adapter thunks (arity + record-building live program-side) */
void scr_http2_stream_thunk(ScrClosure *cb, ScrH2Stream *st, ScrArr *pairs, double flags);
void scr_http2_resp_thunk(ScrClosure *cb, ScrArr *pairs, double status, double flags);
void scr_http2_session_thunk(ScrClosure *cb, ScrH2Session *sess);
void scr_http2_session_thunk0(ScrClosure *cb, ScrH2Session *sess);
void scr_http2_connect_thunk2(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock);
void scr_http2_connect_thunk1(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock);
void scr_http2_connect_thunk0(ScrClosure *cb, ScrH2Session *sess, ScrNetSocket *sock);
void scr_http2_goaway_thunk2(ScrClosure *cb, double code, double last);
void scr_http2_goaway_thunk1(ScrClosure *cb, double code, double last);
void scr_http2_goaway_thunk0(ScrClosure *cb, double code, double last);

void scr_net_sock_set_native_established(ScrNetSocket *s, ScrNetNativeEventFn fn);

/* Registers the h2 session/stream dyn handle ops (the emitted main()
 * calls it when the unit is linked — the scr_net_dyn_install story). */
void scr_http2_dyn_install(void);

#ifdef SCR_RC_AUDIT
long scr_http2_live_count(void);
#endif

/* node:https (scr_tls.c — the http server/client over the TLS
 * transport; see the tls block above for the ownership story). */
ScrNetServer *scr_https_create_server(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves*/, ScrHttpReqFn fn); /* +1 */
/* The runtime-options-record twin (the tls block's divergence-66 walk). */
ScrNetServer *scr_https_create_server_dyn(const struct ScrDyn *opts /*borrowed*/, ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn); /* +1 or NULL+pending */
/* https.request's servername option (borrowed), stored for the next
 * https request construction call. */
void scr_https_set_next_servername(ScrStr *name);
ScrHttpClientReq *scr_https_request(ScrStr *host /*borrowed*/, double port,
                                     ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                     double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                     bool auto_end, bool reject_unauthorized,
                                     const char *ca /*borrowed, NULL = none*/, size_t ca_len,
                                     ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn); /* +1 */
/* The URL-string form (https.get('https://host/path')): scr_http.c's
 * shared parse, then the options form's dial with Node's no-options
 * defaults (verification on, the default trust anchors). Throws
 * catchably on an unparsable input or a non-https scheme. */
ScrHttpClientReq *scr_https_request_url(ScrStr *url /*borrowed*/, ScrStr *method /*borrowed*/,
                                         bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                         ScrHttpRespFn fn); /* +1 */
/* The agent-threaded twin (the scr_http_request_agent story over TLS). */
ScrHttpClientReq *scr_https_request_agent(ScrStr *host /*borrowed*/, double port,
                                           ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                           double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                           bool auto_end, bool reject_unauthorized,
                                           const char *ca /*borrowed, NULL = none*/, size_t ca_len,
                                           const struct ScrDyn *agent /*borrowed*/,
                                           ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn); /* +1 */
/* The fetch unit's https leg (defined in scr_tls.c): a client transport
 * context (SNI/verify against the URL hostname — the DIALED address may
 * be a resolved IP) plus the wrap hook scr_http_request_ex installs on
 * the fresh socket. The ctx moves into the transport at wrap time. */
void *scr_tls_fetch_client_ctx(ScrStr *host /*borrowed*/, bool reject_unauthorized);
void scr_tls_fetch_client_wrap(ScrNetSocket *sock, void *ctx);
/* The fetch tunnel through an https:// proxy: TLS to the proxy, the
 * CONNECT head (copied) inside it, then TLS to target_host inside the
 * tunnel (NULL target_host: an http:// target's plaintext). The ctx moves
 * into the socket's transport at wrap time. */
void *scr_tls_fetch_tunnel_ctx(ScrStr *proxy_host /*borrowed*/, ScrStr *target_host /*borrowed, nullable*/,
                               const char *request, size_t len);
void scr_tls_fetch_tunnel_wrap(ScrNetSocket *sock, void *ctx);
/* The loop-side registration (scr_async.c, always linked): `pending`
 * joins the exhaustion test (a live handle keeps the process alive, like
 * Node's active TCP handles), `dispatch` runs at every turn top like the
 * events hook, and `pollfd` exposes the unit's poller fd so the idle
 * poll(2) sleep wakes on socket readiness (-1 = no fd yet). */
void scr_loop_set_net(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void));
void scr_loop_set_net_io(bool (*io)(void));
/* True when process.nextTick callbacks or microtask fibers are queued —
 * dispatch hooks use it to yield between event batches so ticks and
 * promise jobs interleave (net's sweep/drain alternation). */
bool scr_loop_has_ready(void);

#endif /* SCR_HTTP2_H */
