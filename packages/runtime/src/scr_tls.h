/* scriptc runtime — node:tls and node:https (scr_tls.c, scr_tls_ca.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_TLS_H
#define SCR_TLS_H

#include "scr_net.h"

/* ── node:tls + node:https (scr_tls.c — compiled and linked, with the
 * vendored mbedTLS archive, only when the program uses them; design
 * note atop the file). tls.createServer returns an ORDINARY
 * ScrNetServer whose handler fires as 'secureConnection' (post-
 * handshake) with a socket that behaves exactly like a net socket;
 * https.createServer is http.createServer over the same transport;
 * https.request is the http client dialed through a client transport
 * (port 443 default, `ca` / rejectUnauthorized for local-CA flows —
 * cert/key/ca all arrive as borrowed PEM bytes). */
ScrNetServer *scr_tls_create_server(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves, nullable*/, ScrNetConnFn fn); /* +1 */
/* The SNICallback form: sni_cb (moves, nullable) receives (servername, answer), and
 * sni_answer_fn is the emitted thunk that hands the answer to scr_tls_sni_answer. */
ScrNetServer *scr_tls_create_server_sni(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *handler /*moves, nullable*/, ScrNetConnFn fn, ScrClosure *sni_cb /*moves, nullable*/, void *sni_answer_fn); /* +1 */

/* ── RUNTIME tls/https options records (the divergence-66 stance: a
 * non-literal options value reads its members at runtime; members whose
 * literal forms are compile fences become runtime gates that THROW the
 * catchable fence instead of behaving differently; undocumented keys
 * drop exactly like Node drops them). cert/key values are PEM strings,
 * Buffers, or one-element arrays of those; `ca` (client side)
 * concatenates array entries into one trust-anchor bundle. The *_dyn
 * creators walk a dyn options record (the checked-dynamic JS lane's
 * shape) and mint the same servers the literal path mints; NULL returns
 * carry a pending exception. scr_tls_pem_from_dyn is the literal path's
 * runtime-valued cert/key extraction (`what` names the fence). */
ScrBytes *scr_tls_pem_from_dyn(const struct ScrDyn *v, const char *what); /* +1 or NULL+pending */
ScrNetServer *scr_tls_create_server_dyn(const struct ScrDyn *opts /*borrowed*/, ScrClosure *handler /*moves, nullable*/, ScrNetConnFn fn); /* +1 or NULL+pending */
/* The https twin (its ScrHttpReqFn parameter is declared with the http
 * section below): scr_https_create_server_dyn. */

/* ── tls.connect (scr_tls.c): the TLS client socket. Dials TCP like
 * net.connect and installs the client transport; the callback (and the
 * socket's 'connect'/'secureConnect' listeners) fires post-handshake —
 * Node's secureConnect timing. `port` < 0 reads the port from the
 * options record; `host` NULL/empty reads host (default "localhost").
 * Implemented option members: port, host, rejectUnauthorized (default
 * true; false runs the handshake with verification RECORDED, so
 * socket.authorized / authorizationError answer Node's split), ca,
 * servername (the SNI + verify name). Every other documented member
 * throws the runtime fence when present; unknown keys drop. */
ScrNetSocket *scr_tls_connect_dyn(double port, ScrStr *host /*borrowed, nullable*/, const struct ScrDyn *opts /*borrowed, nullable*/, ScrClosure *cb /*moves, nullable*/); /* +1 or NULL+pending */

/* The TLSSocket member surface on the socket kind (all no-ops / honest
 * defaults on plain sockets): authorized answers Node's verify verdict
 * (false on servers and unverified clients), auth_error the verify-
 * failure CODE STRING (+1; NULL = Node's null), on_secure_connect
 * registers at the establishment-fired conn list (released unread on a
 * plain socket — the event never fires there, like Node), on_session
 * registers the received-ticket event (fires once with the serialized
 * session as a Buffer; `fn` is the data-listener adapter ABI). */
bool scr_tls_sock_authorized(ScrNetSocket *s);
ScrStr *scr_tls_sock_auth_error(ScrNetSocket *s); /* +1 or NULL */
ScrDyn *scr_tls_sock_get_protocol(ScrNetSocket *s);  /* +1: string or null */
/* The certificates behind getPeerCertificate, getCertificate and their
 * X509Certificate forms (scr_tls_x509.c reads them). */
bool scr_tls_sock_has_handle(ScrNetSocket *s);
size_t scr_tls_sock_peer_chain(ScrNetSocket *s, const uint8_t **der, size_t *len, size_t max);
const uint8_t *scr_tls_sock_own_cert(ScrNetSocket *s, size_t *len);
void scr_tls_sock_each_trusted(ScrNetSocket *s, bool (*visit)(void *ctx, const uint8_t *der, size_t len),
                               void *ctx);
ScrBytes *scr_tls_sock_peer_cert_der(ScrNetSocket *s); /* +1 Buffer, empty for none */
ScrBytes *scr_tls_sock_own_cert_der(ScrNetSocket *s);  /* +1 Buffer, empty for none */
/* scr_tls_x509.c: getPeerCertificate([detailed]) and getCertificate(), +1
 * (an object, {} or null). */
ScrDyn *scr_tls_sock_get_peer_certificate(ScrNetSocket *s, const ScrDyn *detailed);
ScrDyn *scr_tls_sock_get_certificate(ScrNetSocket *s);
ScrDyn *scr_tls_sock_get_cipher(ScrNetSocket *s);    /* +1: object, undefined or null */
ScrDyn *scr_tls_sock_alpn_protocol(ScrNetSocket *s); /* +1: string, false or null */
void scr_tls_sock_on_secure_connect(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_tls_sock_on_session(ScrNetSocket *s, ScrClosure *cb /*moves*/, void *fn, bool once);
/* The 'secure' event: fires when the handshake completes (after the
 * secureConnect listeners on a client); released unread on a plain socket
 * or after the handshake. */
void scr_tls_sock_on_secure(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once);

/* ── h2 over TLS (scr_tls.c ↔ scr_http2.c): the ALPN=h2 server wrap and
 * the https-authority client wrap. scr_http2.c calls both directly —
 * every http2-using binary links the TLS unit (the moduleUsesTls
 * switch), so no registration indirection is needed. */
void scr_tls_server_wrap_h2(ScrNetServer *s, const char *cert, size_t cert_len, const char *key, size_t key_len, ScrNetNativeConnFn h2_conn, void *h2_ctx /*moves*/, void (*h2_ctx_free)(void *), ScrClosure *sni_cb /*moves, nullable*/, void *sni_answer_fn);
void scr_tls_h2_client_wrap(ScrNetSocket *sock, ScrStr *host /*borrowed*/, bool reject_unauthorized, const char *ca /*borrowed, NULL = none*/, size_t ca_len);

/* ── tls.SecureContext + the SNI callback (scr_tls.c) ─────────────────
 * A SecureContext is an opaque refcounted parsed cert/key pair
 * (tls.createSecureContext({ cert, key })). A server created with an
 * SNI callback parses each connection's ClientHello for the server_name
 * extension BEFORE the mbedTLS handshake begins (the callback may answer
 * asynchronously — cert generation on demand is the portless flow — and
 * mbedTLS's own f_sni must answer synchronously, so the runtime resolves
 * the name first and replays the hello bytes into the bio), invokes the
 * JS callback with (servername, answer-closure), and resumes the
 * handshake when scr_tls_sni_answer arrives: has_err tears the socket
 * down without an 'error' event (Node's 'tlsClientError' default), a ctx serves its
 * cert/key via mbedtls_ssl_set_hs_own_cert, NULL serves the default
 * pair. `answer_fn` is the emitted per-shape thunk that decodes the
 * callback's program-interned unions down to this call — it becomes the
 * minted answer closure's fn (caps[0] boxes the socket). Connections
 * whose ClientHello carries no server_name skip the callback and serve
 * the default pair, exactly Node. */
typedef struct ScrSecureCtx ScrSecureCtx;
ScrSecureCtx *scr_tls_create_secure_context(const char *cert, size_t cert_len, const char *key, size_t key_len); /* +1 */
/* createSecureContext over a RUNTIME options record: Node's typed option
 * validations first, then the pem walk (+1, or NULL with the exception
 * pending). Borrowed. */
ScrSecureCtx *scr_tls_create_secure_context_dyn(const ScrDyn *opts);
/* server.addContext(servername, context) (a SecureContext, or options when
 * NULL) and server.setSecureContext(options) on a tls or https server;
 * Node's errors pending on failure. */
void scr_tls_server_add_context(ScrNetServer *server, const ScrDyn *servername,
                                const ScrDyn *options /*nullable*/, ScrSecureCtx *ctx /*nullable*/);
void scr_tls_server_set_secure_context(ScrNetServer *server, const ScrDyn *options);
/* new tls.TLSSocket(socket, options) in server mode: a fresh TLS socket
 * takes over socket's connection and runs the server handshake, serving
 * ctx (options.secureContext; borrowed, nullable) or the options record's
 * cert and key. +1, or NULL with the exception pending. */
ScrNetSocket *scr_tls_wrap_socket(ScrNetSocket *raw, const ScrDyn *opts /*borrowed*/, ScrSecureCtx *ctx /*borrowed, nullable*/);
/* tls.getCACertificates(type): validateString + the documented name set,
 * then the compiler-rendered fence — always leaves an exception pending. */
void scr_tls_ca_certs_chk(const ScrDyn *type, const ScrStr *fence);
ScrSecureCtx *scr_secure_ctx_retain(ScrSecureCtx *c);
void scr_secure_ctx_release(ScrSecureCtx *c);
void *scr_secure_ctx_retain_v(void *p);
void scr_secure_ctx_release_v(void *p);
ScrNetServer *scr_https_create_server_sni(const char *cert, size_t cert_len, const char *key, size_t key_len, ScrClosure *sni_cb /*moves, nullable*/, void *answer_fn); /* +1 */
void scr_tls_sni_answer(ScrClosure *self, bool has_err, ScrSecureCtx *ctx /*moves, nullable*/);
#ifdef SCR_RC_AUDIT
long scr_secure_ctx_live_count(void);
#endif

/* ── node:tls, the CA-store introspection slice (scr_tls_ca.c — its own
 * unit and link gate; NO mbedTLS, so a getCACertificates-only binary never
 * builds the archive; native-toolchain.ts also compiles it whenever scr_tls.c does). The
 * HOST roots (Windows' system certificate stores, the established bundle probe on
 * POSIX) stand in for both Node's compiled-in Mozilla roots ('bundled',
 * rootCertificates) and the platform store ('system') — the established
 * SEMANTICS divergence, extended to introspection; 'extra' uses the
 * NODE_EXTRA_CA_CERTS file captured before user code runs. Arrays are cached
 * per type (+1 retained answers each call — Node's own caching, and the
 * identity the suite pins with strictEqual). */
void scr_tls_ca_install(void); /* snapshots NODE_EXTRA_CA_CERTS + file bytes */
bool scr_tls_ca_extra_pem(const char **pem, size_t *len); /* borrowed launch snapshot */
#ifdef _WIN32
/* Enumerates Windows' trusted ROOT, intermediate CA, and TrustedPeople store
 * locations, yielding only certificates whose effective Windows EKU policy
 * permits TLS server authentication. DER is borrowed for the call. */
typedef void (*ScrTlsCaWindowsCertFn)(void *ctx, const unsigned char *der, size_t len);
bool scr_tls_ca_windows_cert_server_auth(const void *cert_context);
void scr_tls_ca_windows_certs(ScrTlsCaWindowsCertFn fn, void *ctx);
#endif
ScrArr *scr_tls_ca_get(ScrStr *type); /* +1; throws ERR_INVALID_ARG_VALUE on unknown types */
ScrArr *scr_tls_ca_root(void);        /* +1; === getCACertificates("bundled") */
/* Replaces the 'default' set: entries filter to their PEM certificate
 * blocks (deduped byte-exactly — Node dedupes by X509 identity); a
 * non-empty array yielding no blocks throws Node's
 * ERR_CRYPTO_OPERATION_FAILED and leaves the set unchanged. Borrows. */
void scr_tls_ca_set_default(ScrArr *certs);
/* scr_tls.c's anchor consult: true iff setDefaultCACertificates ran;
 * *pem and *len then carry the concatenated NUL-terminated blocks (len 0 =
 * the empty set — verification fails, Node's own consequence), and *gen
 * a counter that bumps per set so the parsed chain re-parses on change. */
bool scr_tls_ca_default_override(const char **pem, size_t *len, uint64_t *gen);

#endif /* SCR_TLS_H */
