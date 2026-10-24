/* scriptc runtime — node:net (scr_net.c) and the socket transport hooks.
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_NET_H
#define SCR_NET_H

#include "scr_bytes.h"

/* ── node:net (scr_net.c — compiled and linked ONLY when the program
 * uses the net surface, like scr_events.c; see native-toolchain.ts) ─────────────────
 * TCP servers and sockets over the unit's own readiness poller
 * (scr_platform.h: kqueue on macOS/BSD, epoll on Linux): refcounted handles
 * whose listeners MOVE in and drop at settlement (the ScrChild ownership
 * story), consumer-driven reads (the stdin discipline), deferred
 * 'listening'/'error'/'close' emits delivered by the loop's dispatch
 * hook. The emitted main calls scr_net_install() before %main; net-free
 * builds keep their exact link line. Full design note atop scr_net.c. */
typedef struct ScrNetServer ScrNetServer;
typedef struct ScrNetSocket ScrNetSocket;
typedef void (*ScrNetConnFn)(ScrClosure *cb, ScrNetSocket *sock); /* sock +1 */
typedef void (*ScrNetDataFn)(ScrClosure *cb, ScrBytes *chunk);    /* borrowed */

/* The listener-list family (snapshot firing, once-before-run): owned by
 * scr_net.c, reused by scr_http.c for the request-body event lists. */
typedef struct ScrNetOnce ScrNetOnce;

typedef struct {
  ScrClosure *cb; /* owned */
  void *fn;       /* adapter with the event's firing ABI */
  bool once;
  ScrNetOnce *shared_once; /* owned, nullable: one once registration mirrored across lists */
} ScrNetL;

typedef struct {
  ScrNetL *ls;
  size_t n, cap;
} ScrNetLs;

void scr_net_ls_add(ScrNetLs *l, ScrClosure *cb, void *fn, bool once);
/* The AsyncLocalStorage context a socket's events run in from now on
 * (borrowed; scr_net.c keeps the creation context otherwise). */
struct ScrAlsCtx;
void scr_net_sock_set_context(ScrNetSocket *s, struct ScrAlsCtx *ctx);
ScrNetOnce *scr_net_once_new(void); /* +1 */
ScrNetOnce *scr_net_once_retain(ScrNetOnce *once); /* +1 */
void scr_net_once_release(ScrNetOnce *once);
void scr_net_ls_add_shared_once(ScrNetLs *l, ScrClosure *cb, void *fn,
                                ScrNetOnce *once /*moves*/);
bool scr_net_ls_has_live(const ScrNetLs *l);
void scr_net_ls_drop(ScrNetLs *l);
size_t scr_net_ls_snapshot(ScrNetLs *l, ScrNetL **out);
void scr_net_fire0(ScrNetLs *l);
/* The receiver-binding twins: the emitting handle rides the pass as the
 * ambient receiver (scr_dyn_this_push — `this` in listener bodies).
 * `self` BORROWED; NULL binds undefined (= the plain spellings above). */
void scr_net_fire0_this(ScrNetLs *l, void *self, ScrDynHandleTag tag);
void scr_net_fire_err_this(ScrNetLs *l, ScrStr *msg, void *self, ScrDynHandleTag tag);

/* Protocol-layer (scr_http.c) hooks: a C-level connection consumer on
 * servers, and a C-level reader on sockets (counts as a consumer for
 * read-arming; the context BORROWS its socket and is freed with it). */
typedef void (*ScrNetNativeConnFn)(void *ctx, ScrNetSocket *sock);
typedef void (*ScrNetNativeDataFn)(void *ctx, const char *buf, size_t n);
typedef void (*ScrNetNativeEventFn)(void *ctx);
typedef bool (*ScrNetNativeTimeoutHandledFn)(void *ctx);
typedef bool (*ScrNetNativeErrFn)(void *ctx, ScrStr *msg); /* true = consumed */
void scr_net_server_set_native_conn(ScrNetServer *s, ScrNetNativeConnFn fn, void *ctx, void (*ctx_free)(void *));
/* The HTTP-parser ctx ALIAS: scr_http.c stamps its server ctx here so
 * late 'request' listener installs (scr_http_server_on_request) can
 * reach it even after a TLS wrap replaced the native-conn hook (the
 * https/http2 servers: scr_tls.c owns the native ctx, the http ctx sits
 * inside it). BORROWED — owned via the native-conn chain, valid while
 * the server lives; NULL on servers with no HTTP parser. */
void scr_net_server_set_http_ctx(ScrNetServer *s, void *ctx);
void *scr_net_server_get_http_ctx(ScrNetServer *s);
/* The protocol layer's settle hook: called once when the server settles
 * ('close' emitted, lists dropped) with the http_ctx alias — scr_http.c
 * drops its own request/upgrade/connect lists there (the settle-releases-
 * listeners story across the layer seam). */
void scr_net_server_set_proto_settle(ScrNetServer *s, void (*fn)(void *));
bool scr_net_server_settled(ScrNetServer *s); /* 'close' already emitted */
/* The dyn-dispatch hook for HTTP server events: scr_http.c registers it
 * at scr_http_dyn_install, and the netServer handle ops route
 * on('request', ...) (and future http events) through it — link gating
 * keeps scr_net.c from naming http entry points. Returns false for an
 * event the http layer does not model (the caller throws the "not
 * supported yet" Error). */
void scr_net_set_dynh_http_on(bool (*fn)(ScrNetServer *, const char *, const ScrDyn *, bool));
void scr_net_sock_set_native_reader(ScrNetSocket *s, ScrNetNativeDataFn data, ScrNetNativeEventFn eof, ScrNetNativeEventFn closed, void *ctx, void (*ctx_free)(void *));
void scr_net_sock_set_native_idle_checker(ScrNetSocket *s, bool (*fn)(void *));
/* The upgrade handover: clear the reader's fn pointers, keep the ctx. */
void scr_net_sock_clear_native_reader(ScrNetSocket *s);
/* The accepting server (BORROWED; NULL on client sockets) — the protocol
 * layer's receiver for server-level fires ('request': this === server). */
ScrNetServer *scr_net_sock_server(ScrNetSocket *s);
/* socket.setEncoding(enc): utf8 flips 'data' delivery to strings (the
 * chunk-encoding window); real-but-unsupported encodings throw the "not
 * supported yet" Error;
 * unknown names throw Node's ERR_UNKNOWN_ENCODING. May throw. */
void scr_net_sock_set_encoding(ScrNetSocket *s, ScrStr *enc /*borrowed*/);
bool scr_net_sock_destroyed(ScrNetSocket *s); /* socket.destroyed */
bool scr_net_sock_writable(ScrNetSocket *s);  /* socket.writable */
bool scr_net_sock_established(ScrNetSocket *s); /* connected, including TLS handshake */
void scr_net_sock_set_native_events(ScrNetSocket *s, ScrNetNativeEventFn timeout, ScrNetNativeErrFn err);
void scr_net_sock_set_native_http_timeout(ScrNetSocket *s, ScrNetNativeTimeoutHandledFn fn);
void scr_net_sock_write_native(ScrNetSocket *s, const char *buf, size_t n);
/* Several protocol-layer slices in order as one write: a single vectored
 * syscall when the bytes can go out immediately, else the same buffering
 * as consecutive scr_net_sock_write_native calls. */
typedef struct {
  const char *data;
  size_t len;
} ScrNetSlice;
void scr_net_sock_writev_native(ScrNetSocket *s, const ScrNetSlice *slices, size_t n);
/* The protocol layer's deferred-emit hook: `pending` joins the loop's
 * liveness test, `sweep` runs at every net sweep top. */
void scr_net_set_proto_sweep(bool (*pending)(void), void (*sweep)(void));
void scr_net_fire_err(ScrNetLs *l, ScrStr *msg); /* unhandled => exit(1) */

ScrNetServer *scr_net_server_retain(ScrNetServer *s);
void scr_net_server_release(ScrNetServer *s);
void *scr_net_server_retain_v(void *p);
void scr_net_server_release_v(void *p);
ScrNetSocket *scr_net_sock_retain(ScrNetSocket *s);
void scr_net_sock_release(ScrNetSocket *s);
void *scr_net_sock_retain_v(void *p);
void scr_net_sock_release_v(void *p);

ScrNetServer *scr_net_create_server(ScrClosure *handler /*moves, nullable*/, ScrNetConnFn fn); /* +1 */
void scr_net_listen(ScrNetServer *s, double port, ScrClosure *cb /*moves, nullable*/);
/* listen({ port, host, ipv6Only, reusePort }): host is an IP literal ("" =
 * the dual-stack any default); ipv6Only sets IPV6_V6ONLY before the bind.
 * The old entry point ignores reusePort and is retained for old IR. */
void scr_net_listen_opts(ScrNetServer *s, double port, ScrStr *host /*borrowed*/,
                          bool ipv6_only, ScrClosure *cb /*moves, nullable*/);
/* Additive ABI for listen({ port, host, ipv6Only, reusePort }): reuse_port
 * requests the platform matrix documented in scr_net.c. Unsupported
 * platforms and kernels fail asynchronously; they never fall back to an
 * ordinary single listener. */
void scr_net_listen_opts_reuse_port(ScrNetServer *s, double port, ScrStr *host /*borrowed*/,
                                    bool ipv6_only, bool reuse_port,
                                    ScrClosure *cb /*moves, nullable*/);
double scr_net_server_port(ScrNetServer *s); /* address().port */
bool scr_net_server_listening(ScrNetServer *s);
void scr_net_sock_set_ref(ScrNetSocket *s, bool ref);
void scr_net_sock_move_writes(ScrNetSocket *from, ScrNetSocket *to);
void scr_net_server_set_ref(ScrNetServer *s, bool ref);
bool scr_net_sock_has_ref(ScrNetSocket *s);
double scr_net_server_keep_alive_ms(ScrNetServer *s);
double scr_net_server_keep_alive_timeout(ScrNetServer *s);
double scr_net_server_idle_ms(ScrNetServer *s);
/* Writable http.Server timeout property storage. `field` is the compiler
 * ABI selector: timeout, keepAliveTimeout, headersTimeout, requestTimeout,
 * keepAliveTimeoutBuffer. Typed reads validate that no dynamic write left
 * a non-number in the ordinary JS property slot. */
double scr_net_server_timeout_get(ScrNetServer *s, double field);
void scr_net_server_timeout_set(ScrNetServer *s, double field, double value);
void scr_net_server_set_timeout_plain(ScrNetServer *s, double ms);
void scr_net_server_set_timeout_cb(ScrNetServer *s, double ms, ScrClosure *cb /*moves*/, ScrNetConnFn fn);
void scr_net_server_on_timeout(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrNetConnFn fn, bool once);
/* Marks the shared net-server handle as an HTTP/1 or HTTPS server. The
 * dynamic handle uses this to keep HTTP-only fields off net/TLS/H2. */
void scr_net_server_enable_http_timeout_surface(ScrNetServer *s);
/* Constructor-option twin: undefined is absent; otherwise validates type
 * and a non-negative safe integer before storing, matching Node's option
 * ladder (plain property writes do not validate). */
bool scr_net_server_timeout_option_check(double field, double value);
void scr_net_server_timeout_option_set(ScrNetServer *s, double field, const struct ScrDyn *value);
ScrStr *scr_net_server_addr_ip(ScrNetServer *s);     /* +1 — address().address */
ScrStr *scr_net_server_addr_family(ScrNetServer *s); /* +1 — address().family */
void scr_net_server_close(ScrNetServer *s, ScrClosure *cb /*moves, nullable*/);
void scr_net_server_close_dyn(ScrNetServer *s, const ScrDyn *listener /*borrowed*/);
void scr_net_sock_on_lookup(ScrNetSocket *s, const ScrDyn *listener /*borrowed*/, bool once);
void scr_net_lookup_install(void);
ScrStr *scr_net_server_unix_path(ScrNetServer *s); /* +1, "" unless listening on a path */
void scr_net_server_address_check(ScrNetServer *s);  /* throws for a Unix-socket server */
void scr_net_server_close_all_connections(ScrNetServer *s);
void scr_net_server_close_idle_connections(ScrNetServer *s);
ScrDyn *scr_net_server_max_connections_get(ScrNetServer *s); /* +1 */
void scr_net_server_max_connections_set(ScrNetServer *s, const ScrDyn *value /*borrowed*/);
void scr_net_server_on_drop(ScrNetServer *s, const ScrDyn *listener /*borrowed*/, bool once);
void scr_net_server_get_connections(ScrNetServer *s, const ScrDyn *callback /*borrowed*/);
/* The REAL close behind `wrapper.close.bind(wrapper)` — never consults
 * the override (the proxy-through idiom cannot recurse). */
void scr_net_server_close_direct(ScrNetServer *s, ScrClosure *cb /*moves, nullable*/);
/* wrapper.close = fn — the override MOVES in (a compiler-emitted
 * zero-arg wrapper); reassignment releases the old one. */
void scr_net_server_set_close_override(ScrNetServer *s, ScrClosure *ov /*moves*/);
void scr_net_server_on_error(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
/* tls/https servers' 'tlsClientError': registration (fn is one of the
 * thunks below, by the listener's arity) and the TLS unit's fire. */
void scr_net_server_on_client_error(ScrNetServer *s, ScrClosure *cb /*moves*/, void *fn, bool once);
void scr_net_server_fire_client_error(ScrNetServer *s, ScrError *err /*borrowed*/,
                                      ScrNetSocket *sock /*borrowed*/);
void scr_net_client_error_thunk0(ScrClosure *cb, ScrError *err, ScrNetSocket *sock);
void scr_net_client_error_thunk1(ScrClosure *cb, ScrError *err, ScrNetSocket *sock);
void scr_net_client_error_thunk2(ScrClosure *cb, ScrError *err, ScrNetSocket *sock);
void scr_net_server_on_close(ScrNetServer *s, ScrClosure *cb /*moves*/, bool once);
/* server.on('listening', cb): the deferred 'listening' list listen(port,
 * cb) rides — fires once per successful bind; late registrations on an
 * already-listening server never fire (Node's once-per-listen emit). */
void scr_net_server_on_listening(ScrNetServer *s, ScrClosure *cb /*moves*/, bool once);
void scr_net_server_on_connection(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrNetConnFn fn, bool once);
/* 'secureConnection' — the deferred-connection list (TLS handshake
 * timing); released unread on a server without deferral (a plain net
 * server never fires it, like Node). */
void scr_net_server_on_secure_connection(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrNetConnFn fn, bool once);
ScrNetSocket *scr_net_connect(double port, ScrStr *host /*borrowed, nullable*/, ScrClosure *cb /*moves, nullable*/); /* +1 */
ScrNetSocket *scr_net_connect_checked(double port, ScrStr *host /*borrowed, nullable*/, ScrClosure *cb /*moves, nullable*/); /* +1 */
bool scr_net_host_chk(const ScrStr *host /*borrowed, nullable*/);
/* connect with a validated autoSelectFamilyAttemptTimeout option: the
 * budget runs Node's validateInt32-from-1 ladder (ERR_OUT_OF_RANGE /
 * ERR_INVALID_ARG_TYPE) and is then inert — the single dial has nothing
 * to time. +1, or NULL with the throw pending. */
ScrNetSocket *scr_net_connect_attempt(double port, ScrStr *host /*borrowed*/, const ScrDyn *t /*borrowed*/);
/* net.connect/createConnection over a RUNTIME option bag (computed
 * keys): Node-order validation (objectMode trio, port, host,
 * autoSelectFamily, attempt budget), then the compiler-rendered fence —
 * always leaves an exception pending. Borrowed. */
void scr_net_connect_opts_chk(const ScrDyn *opts, const ScrStr *fence);
/* connect with a caller lookup (net.connect({ ..., lookup })): invokes
 * lookup(hostname, options, answer-closure) synchronously; answer_fn is
 * the emitted per-shape thunk that decodes the answer down to
 * scr_net_lookup_answer. Dials the answered addresses in order. */

ScrStr *scr_net_blocking_lookup(ScrStr *host /*borrowed*/);
ScrNetSocket *scr_net_connect_lookup(double port, ScrStr *host /*borrowed*/,
                                      ScrClosure *lookup /*moves*/, void *answer_fn); /* +1 */
void scr_net_lookup_answer(ScrClosure *self, bool has_err, ScrStr *msg /*borrowed, nullable*/,
                            ScrArr *ips /*borrowed, nullable*/);
void scr_net_sock_write_str(ScrNetSocket *s, ScrStr *data /*borrowed*/);
void scr_net_sock_write_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/);
void scr_net_sock_end(ScrNetSocket *s);
void scr_net_sock_end_str(ScrNetSocket *s, ScrStr *data /*borrowed*/);
void scr_net_sock_end_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/);
/* Checked-dynamic chunk forms (an untyped JS payload into a typed
 * socket): STR/BYTES dispatch; end() takes undefined/null as no chunk;
 * anything else throws Node's ERR_INVALID_ARG_TYPE chunk TypeError. */
void scr_net_sock_write_dynv(ScrNetSocket *s, const ScrDyn *d /*borrowed*/);
void scr_net_sock_end_dynv(ScrNetSocket *s, const ScrDyn *d /*borrowed*/);
void scr_net_sock_destroy(ScrNetSocket *s);
/* Flow control (pause/resume — see the struct's flag comments), the
 * FIN-flushed destroy (destroySoon), TCP_NODELAY, the deferred write/
 * finish callbacks (write(chunk, cb) / end(cb) — sweep-fired), and the
 * counters/flags the compat surface reads. */
ScrNetSocket *scr_net_sock_pause(ScrNetSocket *s);            /* +1: chaining */
ScrNetSocket *scr_net_sock_resume(ScrNetSocket *s);           /* +1: chaining */
void scr_net_sock_hold(ScrNetSocket *s, bool hold); /* protocol read hold (not pause) */
ScrNetSocket *scr_net_sock_set_nodelay(ScrNetSocket *s, bool enable); /* +1: chaining */
void scr_net_sock_set_keepalive(ScrNetSocket *s, bool enable, double delay_ms);
void scr_net_sock_destroy_soon(ScrNetSocket *s);
void scr_net_sock_on_finish(ScrNetSocket *s, ScrClosure *cb /*moves*/);
void scr_net_sock_on_write_flush(ScrNetSocket *s, ScrClosure *cb /*moves*/);
double scr_net_sock_bytes_written(ScrNetSocket *s);
bool scr_net_sock_readable(ScrNetSocket *s);
/* The deferred dial (the http agent's maxSockets queue): the socket
 * registers "connecting" and buffers writes; dial_start runs the dial. */
ScrNetSocket *scr_net_connect_deferred(double port, ScrStr *host /*borrowed, nullable*/); /* +1 */
ScrNetSocket *scr_net_connect_lookup_dyn(double port, ScrStr *host /*borrowed*/, const ScrDyn *lookup /*borrowed*/); /* +1, NULL on throw */
/* A client socket for the Unix socket at `path`, dialed now or (deferred)
 * by scr_net_sock_dial_start. A failure is the deferred 'error'. */
ScrNetSocket *scr_net_connect_path(ScrStr *path /*borrowed*/, bool deferred); /* +1 */
/* server.listen(path[, cb]): a Unix-socket server, its file removed at close. */
void scr_net_listen_path(ScrNetServer *s, ScrStr *path /*borrowed*/, ScrClosure *cb /*moves, nullable*/);
void scr_net_sock_dial_start(ScrNetSocket *s);
void scr_net_sock_set_timeout(ScrNetSocket *s, double ms);
void scr_net_sock_on_timeout(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
ScrStr *scr_net_sock_remote_address(ScrNetSocket *s); /* +1 or NULL (undefined arm) */
double scr_net_sock_remote_port(ScrNetSocket *s);    /* NaN = undefined */
ScrStr *scr_net_sock_remote_family(ScrNetSocket *s); /* +1 or NULL */
ScrStr *scr_net_sock_local_address(ScrNetSocket *s); /* +1 or NULL */
double scr_net_sock_local_port(ScrNetSocket *s);     /* NaN = undefined */
ScrStr *scr_net_sock_local_family(ScrNetSocket *s);  /* +1 or NULL */
ScrDyn *scr_net_sock_address(ScrNetSocket *s);       /* +1: socket.address() */
/* socket.resetAndDestroy(): RST close (deferred to 'connect' while
 * connecting); throws ERR_INVALID_HANDLE_TYPE on TLS. +1: chaining. */
ScrNetSocket *scr_net_sock_reset_and_destroy(ScrNetSocket *s);
/* net.SocketAddress and net.BlockList: native handles. The constructors
 * take the argument array; parse answers undefined when the input is not
 * a socket address. All +1, borrowed arguments; may throw. */
ScrDyn *scr_net_socket_address_new(const ScrDyn *args);
ScrDyn *scr_net_socket_address_parse(const ScrDyn *input);
bool scr_net_is_socket_address(const ScrDyn *value);
ScrDyn *scr_net_block_list_new(const ScrDyn *args);
bool scr_net_is_block_list(const ScrDyn *value);
ScrDyn *scr_net_block_list_private_ranges(void);
/* server.dropMaxConnection: a stored value (+1 get, borrowed set). */
ScrDyn *scr_net_server_drop_max_connection_get(ScrNetServer *s);
void scr_net_server_drop_max_connection_set(ScrNetServer *s, const ScrDyn *value);
ScrDyn *scr_net_sock_addr_field(ScrNetSocket *s, double field); /* +1 */
double scr_net_sock_bytes_read(ScrNetSocket *s);
bool scr_net_sock_connecting(ScrNetSocket *s);
bool scr_net_sock_pending(ScrNetSocket *s);
ScrStr *scr_net_sock_ready_state(ScrNetSocket *s); /* +1 */
void scr_net_sock_on_ready(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_net_sock_on_close_dyn(ScrNetSocket *s, const ScrDyn *listener /*borrowed*/, bool once);
void scr_net_sock_on_write_flush_dyn(ScrNetSocket *s, const ScrDyn *listener /*borrowed*/);
void scr_net_sock_on_finish_dyn(ScrNetSocket *s, const ScrDyn *listener /*borrowed*/);
ScrNetSocket *scr_net_sock_set_keepalive_ret(ScrNetSocket *s, bool enable, double delay_ms); /* +1 */
void scr_net_sock_set_timeout_checked(ScrNetSocket *s, double ms);
void scr_net_sock_set_timeout_cb(ScrNetSocket *s, double ms, ScrClosure *cb /*moves*/);
double scr_net_is_ip(const ScrDyn *input);
bool scr_net_is_ipv4(const ScrDyn *input);
bool scr_net_is_ipv6(const ScrDyn *input);
bool scr_net_sock_encrypted(ScrNetSocket *s); /* true = TLS transport (false maps to the undefined arm) */
void scr_net_sock_pipe(ScrNetSocket *src, ScrNetSocket *dst);
void scr_net_sock_on_data(ScrNetSocket *s, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once);
void scr_net_sock_on_end(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_net_sock_on_close(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_net_sock_on_error(ScrNetSocket *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_net_sock_on_connect(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
/* The paused-mode surface (the demux path: once('readable') + read(1) +
 * unshift + emit('connection')). 'readable' listeners are consumers —
 * arrived bytes buffer in the receive buffer and the event announces
 * them (and EOF, where read answers NULL). read(n) answers exactly n
 * buffered bytes (+1) or NULL — Node's less-than-n answer; n <= 0 drains
 * everything. unshift returns bytes to the FRONT of the stream, ahead of
 * anything still in the kernel. emit('connection', sock) routes a socket
 * into another server's protocol layer — the TLS target's 'connection'
 * defers to its handshake, the http target's parser drains the buffered
 * peek first. */
void scr_net_sock_on_readable(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
ScrBytes *scr_net_sock_read_bytes(ScrNetSocket *s, double n); /* +1 or NULL */
void scr_net_sock_unshift_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/);
void scr_net_server_emit_connection(ScrNetServer *srv, ScrNetSocket *sock /*borrowed*/);
void scr_net_data_thunk0(ScrClosure *cb, ScrBytes *chunk);
void scr_net_data_thunk_bytes(ScrClosure *cb, ScrBytes *chunk);
void scr_net_data_thunk_str(ScrClosure *cb, ScrBytes *chunk);
/* The dynCheck-adapted listener's flavor: boxes the chunk as a
 * Buffer-flavored dyn (toString decodes utf8, Node's 'data' payload). */
void scr_net_data_thunk_dyn(ScrClosure *cb, ScrBytes *chunk);
void scr_net_conn_thunk0(ScrClosure *cb, ScrNetSocket *sock);
void scr_net_conn_thunk_sock(ScrClosure *cb, ScrNetSocket *sock);
void scr_net_install(void);
/* Registers the netSocket handle-dispatch ops (SCR_DYNH_NET_SOCKET) —
 * emitted main() calls this alongside scr_net_install exactly when the
 * net unit is linked, so the always-linked dyn core never references
 * this unit's entry points. */
void scr_net_dyn_install(void);
#ifdef SCR_RC_AUDIT
long scr_net_live_count(void);
#endif

/* ── the socket TRANSPORT hooks (scr_tls.c — compiled only into
 * TLS-using binaries; scr_net.c stays transport-agnostic through this
 * ops table). A transport sits UNDER the socket kind: reads and writes
 * redirect through xread/xwrite once installed (read(2)/write(2) shapes —
 * >0 bytes, 0 EOF, -1 with errno, EAGAIN meaning retry on readiness),
 * writes buffer until the handshake establishes, and readiness events
 * drive `handshake` until it answers done (1) or failed (-1 — the
 * transport reports the failure itself via scr_net_sock_transport_error
 * first, Node-shaped message or NULL for the server's tlsClientError
 * default, which tears down without an 'error' event). `on_established`
 * (nullable) lets a protocol layer attach AFTER the handshake (the https
 * parser); `pending` answers whether decrypted bytes sit buffered inside
 * the transport (the sweep drains them — the poller can't see bytes that
 * already left the kernel); `shutdown_write` sends the close_notify
 * before the FIN. The ops table is static storage in the transport unit;
 * tctx is freed via `free` when the socket handle dies. */
typedef struct ScrNetTransportOps {
  ssize_t (*xread)(void *tctx, char *buf, size_t n);
  ssize_t (*xwrite)(void *tctx, const char *buf, size_t n);
  int (*handshake)(void *tctx);
  void (*on_established)(void *tctx);
  bool (*pending)(void *tctx);
  void (*shutdown_write)(void *tctx);
  void (*free)(void *tctx);
  /* nullable: runs after the established socket's 'connect' listeners
   * (the TLS 'secure' event, which Node emits after secureConnect) */
  void (*after_established)(void *tctx);
  /* nullable: runs when the closed socket settles, after its own
   * listeners drop; the transport drops the listeners it holds */
  void (*settle)(void *tctx);
  /* nullable: the established socket's fd is writable; the transport
   * writes what it holds back (TLS holds its final handshake flight) */
  void (*drain)(void *tctx);
} ScrNetTransportOps;
void scr_net_sock_set_transport(ScrNetSocket *s, const ScrNetTransportOps *ops, void *tctx);
/* new tls.TLSSocket(socket) and tls.connect({ socket }): a fresh socket
 * takes over an open connection (fd, buffered bytes, peer identity); the
 * old socket stays open without I/O, forwards end() and destroy(), and
 * fires 'close' just before the new one. +1, or NULL when the socket has
 * no open, idle connection to give. Set the transport on the result, then
 * call scr_net_sock_adopt_start. */
ScrNetSocket *scr_net_sock_adopt(ScrNetSocket *raw);
void scr_net_sock_adopt_start(ScrNetSocket *t);
/* Routes a client socket through an HTTP CONNECT proxy. Call it right
 * after the dial (scr_net_connect to the proxy) and before any transport
 * is set: once TCP is up, `request` (the CONNECT head, copied) is sent
 * and the proxy's response head is read. A 200 status starts the
 * transport handshake, or fires 'connect'; any other status fails the
 * socket with "Proxy response (<status>) !== 200 when HTTP Tunneling". */
void scr_net_sock_set_tunnel(ScrNetSocket *s, const char *request, size_t len);
/* The status code of a CONNECT response head (head[0..len) ends with the
 * blank line), or -1 when it does not start with an HTTP/1.x status
 * line; and undici's message for a status other than 200 (or -1). */
int scr_net_tunnel_status(const char *head, size_t len);
void scr_net_tunnel_failure(int status, char *msg, size_t cap);
int scr_net_sock_fd(ScrNetSocket *s);
/* The host a client socket was told to dial (Node's socket._host). +1;
 * NULL on server sockets. */
ScrStr *scr_net_sock_dial_name(ScrNetSocket *s);
/* Drain up to n bytes of the socket's receive buffer (peeked/unshifted
 * bytes — the demux path); consumers call it before the fd. */
size_t scr_net_sock_take_buffered(ScrNetSocket *s, char *buf, size_t n);
/* Arm the write filter for a handshake send that hit EAGAIN. */
void scr_net_sock_transport_want_write(ScrNetSocket *s);
/* The socket's transport context, guarded by the ops table identity —
 * NULL when the socket carries no transport or a different one (the SNI
 * answer path re-finds its engine from the boxed socket). */
void *scr_net_sock_transport_ctx_for(ScrNetSocket *s, const ScrNetTransportOps *ops);
/* Re-drive a parked handshake (the asynchronous SNI answer arrived —
 * no fd readiness is coming: the client is waiting for the ServerHello). */
void scr_net_sock_transport_resume(ScrNetSocket *s);
/* Replay raw bytes at the FRONT of the receive buffer — the SNI
 * pre-parse handing the consumed ClientHello back to the TLS bio. */
void scr_net_sock_replay(ScrNetSocket *s, const char *data, size_t len);
/* Transport-level failure: msg (borrowed, Node's message shape) defers
 * 'error' + teardown to the sweep; NULL tears down without an 'error'
 * event, Node's default for an unhandled server-side handshake failure. */
/* The peer ended the stream before the transport's handshake finished:
 * 'end' fires now, ahead of the failure the transport reports next. */
void scr_net_sock_transport_ended(ScrNetSocket *s);
void scr_net_sock_transport_error(ScrNetSocket *s, const char *msg);
/* An error that leaves the socket open: 'error' fires from the sweep with
 * `code` (static storage), and the socket ends when the peer closes, as
 * Node's TLS socket reports a fatal alert after its handshake. */
void scr_net_sock_transport_report(ScrNetSocket *s, const char *msg, const char *code);
/* The same with the error's code given (static storage), for messages
 * whose text does not name it. */
void scr_net_sock_transport_error_code(ScrNetSocket *s, const char *msg, const char *code);
/* The peer closed before the handshake finished on a wrapped socket:
 * 'end', then 'close' without an error. */
void scr_net_sock_transport_eof(ScrNetSocket *s);
/* Registers a listener that fires when the transport establishes, once
 * TCP is up (a socket that took over an open connection is up from the
 * start). */
void scr_net_sock_on_established(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
/* Defer the server's 'connection' listeners to handshake completion —
 * tls.createServer's handler is the 'secureConnection' event, fired with
 * the socket only once the TLS layer stands (Node's timing). */
void scr_net_server_defer_connections(ScrNetServer *s);
/* The current native-connection hook (the https wrapper reads the http
 * parser installer it is about to wrap). */
void scr_net_server_get_native_conn(ScrNetServer *s, ScrNetNativeConnFn *fn, void **ctx, void (**ctx_free)(void *));

/* ── the checked-dynamic TLS-member hooks (scr_tls.c registers them when
 * linked — scr_net.c stays TLS-agnostic, the dynh_http_on precedent).
 * Each answers whether it HANDLED the member: `get` fills *out (+1, or
 * NULL for the undefined arm) for TLSSocket property reads (authorized,
 * authorizationError); `on` registers TLS event names ('secureConnect');
 * `invoke` claims TLSSocket method names (the honest per-member fences
 * for the not-yet-modeled surface). Unhandled members fall through to
 * the plain-socket dispatch unchanged. */
typedef struct ScrNetDynhTlsHooks {
  bool (*get)(ScrNetSocket *s, const char *key, struct ScrDyn **out);
  bool (*on)(ScrNetSocket *s, const char *event, const struct ScrDyn *cb, bool once);
  bool (*invoke)(ScrNetSocket *s, const char *method, struct ScrDyn *const *args, size_t argc,
                 struct ScrDyn **out);
} ScrNetDynhTlsHooks;
void scr_net_set_dynh_tls(const ScrNetDynhTlsHooks *hooks);

#endif /* SCR_NET_H */
