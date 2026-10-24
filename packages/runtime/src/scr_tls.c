/* node:tls + node:https — the TLS transport under the socket kind,
 * layered exactly the way scr_http.c layers on scr_net.c: the socket
 * surface (ScrNetSocket, and the http req/res/client handles above it)
 * is unchanged, and this unit plugs the ScrNetTransportOps table into
 * the socket so reads decrypt, writes encrypt, and readiness drives the
 * handshake. Link-gated like every optional unit: TLS-free binaries
 * never compile this file or the vendored library.
 *
 * ── Design note (the TLS provider decision) ──────────────────────────
 *
 * The provider is VENDORED mbedTLS (3.6 LTS, Apache-2.0, ~1.2MB
 * archive, see vendor/README.md). The alternatives and why they lost:
 *
 * - Security.framework / SecureTransport: zero vendoring and present on
 *   every macOS, but (a) deprecated since 10.15 with no non-deprecated
 *   replacement below Network.framework's connection model, (b) macOS-
 *   only — the queued Linux port would need a second backend behind the
 *   same ops table, and (c) DISQUALIFYING for this program: a server
 *   identity must be a SecIdentity, which public API only mints through
 *   a keychain import — portless mints per-hostname cert/key PEM FILES
 *   with openssl and loads them headlessly; a temp-keychain dance per
 *   certificate is exactly the fragility this compiler avoids.
 * - BoringSSL: no releases/versioning to pin, a CMake+Go build, and an
 *   order of magnitude more code than the slice needs.
 * - LibreSSL libtls: the cleanest API of the four, but macOS ships no
 *   linkable libtls (the system LibreSSL is the CLI only) — it would be
 *   a brew dependency whose availability varies, weaker than the
 *   libcurl precedent (libcurl is a macOS SYSTEM library).
 *
 * mbedTLS wins on the two axes that matter here: PEM cert/key/CA
 * loading is first-class (mbedtls_x509_crt_parse / pk_parse_key over
 * bytes — the portless local-CA flow needs nothing else), and the same
 * vendored tree compiles unchanged on Linux, so the port pays zero
 * extra. It builds as plain C11 with the stock config (no generator
 * scripts, no CMake — the libregexp cache precedent), and its
 * nonblocking BIO contract (WANT_READ/WANT_WRITE) maps 1:1 onto the
 * kqueue readiness loop. Migration cost if ever needed: everything
 * mbedTLS-specific lives behind ScrNetTransportOps in this one file.
 *
 * ── The wiring ────────────────────────────────────────────────────────
 *
 * Server: tls.createServer(cert, key, handler) is an ordinary
 * ScrNetServer whose native-connection hook installs the transport on
 * each accepted socket and whose 'connection' listeners are DEFERRED to
 * handshake completion — the handler is Node's 'secureConnection', fired
 * with a socket that then behaves exactly like a net socket.
 * https.createServer is scr_http_create_server with its parser hook
 * WRAPPED: the TLS hook installs the transport first and attaches the
 * http parser from on_established, so the parser only ever sees
 * plaintext. Handshake failures on the server side tear the socket down
 * without an error event — Node's default for 'tlsClientError' with no
 * listener, which is what portless observes (it registers none).
 *
 * Client: https.request is scr_http_request_ex with a wrap hook that
 * installs a client transport on the freshly dialed socket; the request
 * head buffers in the socket's write buffer until the handshake
 * establishes (the mid-connect buffering path, reused verbatim).
 * rejectUnauthorized:false maps to VERIFY_NONE; `ca` replaces the trust
 * anchors; with neither, the host trust store stands in for Node's bundled
 * Mozilla roots (SEMANTICS.md documents the divergence). Verify
 * failures surface as Node-shaped 'error' messages on the request
 * ("self-signed certificate", "self-signed certificate in certificate
 * chain", "unable to verify the first certificate", "certificate has
 * expired") through the socket's pending-error sweep — then 'close',
 * Node's order, exactly like ECONNREFUSED.
 *
 * Client certificates: servers take requestCert, rejectUnauthorized and
 * ca and report socket.authorized/authorizationError as Node does;
 * clients send a cert and key when asked. A `ca` also completes the
 * chain its owner sends, as OpenSSL's automatic chain does.
 *
 * Bounds (SEMANTICS.md divergence 55): no session resumption or
 * tickets, no renegotiation/post-handshake auth, and non-verify client
 * handshake failures carry a generic message where Node prints an
 * OpenSSL one.
 *
 * Certificate names: a client always checks the leaf against one name,
 * the servername when it is non-empty and the host otherwise. SNI carries
 * the same name, except that an IP literal or servername: "" sends none
 * (Node's tls.connect). When no SNI goes out, mbedTLS is told to skip its
 * own name check and the verify callback runs it: an IP literal must be
 * one of the certificate's IP SANs (Node's checkServerIdentity), any other
 * name follows mbedTLS's DNS SAN / CN rules. */
#include "scr_runtime.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>
#include <string.h>
#include <unistd.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h> /* inet_pton, in6_addr */
#else
#include <arpa/inet.h>
#endif

#include "mbedtls/ctr_drbg.h"
#include "mbedtls/entropy.h"
#include "mbedtls/error.h"
#include "mbedtls/net_sockets.h" /* the MBEDTLS_ERR_NET_* codes the BIOs answer */
#include "mbedtls/pk.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"

static void scr_tls_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

#ifdef _WIN32
/* ── the winsock arm (scr_net.c's respelling, the two calls this unit
 * makes) ──────────────────────────────────────────────────────────────
 * The BIOs and the SNI pre-parse do raw fd I/O beside the socket's own
 * transport plumbing, so the same one-time respelling applies: socket
 * reads are recv, writes are send (ReadFile/_read do not apply to
 * winsock handles), and failures land their WSA code in errno TRANSLATED
 * to the POSIX constant the call sites test. WSAECONNABORTED joins the
 * reset arm deliberately: at the TLS layer both spell "the peer died",
 * and the reset arms (CONN_RESET → server teardown without an error
 * event / the client's socket-hang-up classification) are Node's
 * rendering for each. Winsock
 * is already started whenever this unit runs — every TLS socket is an
 * ScrNetSocket, and scr_net.c initializes the poller (WSAStartup) before
 * any socket exists. */
static int scr_tls_w32_map_err(int e) {
  switch (e) {
  case WSAEWOULDBLOCK: return EAGAIN;
  case WSAEINTR: return EINTR;
  case WSAECONNRESET: return ECONNRESET;
  case WSAECONNABORTED: return ECONNRESET;
  case WSAESHUTDOWN: return EPIPE; /* libuv's map: send-after-shutdown is EPIPE */
  default: return e;
  }
}

static ssize_t scr_tls_w32_read(int fd, void *buf, size_t len) {
  int n = recv((SOCKET)fd, (char *)buf, len > 0x40000000 ? 0x40000000 : (int)len, 0);
  if (n < 0) errno = scr_tls_w32_map_err((int)WSAGetLastError());
  return n;
}

static ssize_t scr_tls_w32_write(int fd, const void *buf, size_t len) {
  int n = send((SOCKET)fd, (const char *)buf, len > 0x40000000 ? 0x40000000 : (int)len, 0);
  if (n < 0) errno = scr_tls_w32_map_err((int)WSAGetLastError());
  return n;
}

#define read(fd, buf, len) scr_tls_w32_read((fd), (buf), (len))
#define write(fd, buf, len) scr_tls_w32_write((fd), (buf), (len))
#endif /* _WIN32 */

/* ── the unit RNG (one CTR_DRBG, lazily seeded) ──────────────────────── */

static SCR_TL mbedtls_entropy_context scr_tls_entropy;
static SCR_TL mbedtls_ctr_drbg_context scr_tls_drbg;
static SCR_TL bool scr_tls_rng_ready = false;

/* Defined with the dyn-member hooks at the tail of this file; registered
 * from rng_init so every TLS entry point installs the TLSSocket member
 * dispatch before any TLS socket can reach a dyn binding. */
static const ScrNetDynhTlsHooks SCR_TLS_DYNH;

static void scr_tls_rng_init(void) {
  if (scr_tls_rng_ready) return;
  mbedtls_entropy_init(&scr_tls_entropy);
  mbedtls_ctr_drbg_init(&scr_tls_drbg);
  if (mbedtls_ctr_drbg_seed(&scr_tls_drbg, mbedtls_entropy_func, &scr_tls_entropy,
                            (const unsigned char *)"scriptc-tls", 11) != 0) {
    fputs("scriptc: tls: RNG seeding failed\n", stderr);
    abort();
  }
  scr_net_set_dynh_tls(&SCR_TLS_DYNH);
  scr_tls_rng_ready = true;
}

/* PEM parsers want a NUL-terminated buffer with the NUL counted. */
static int scr_tls_parse_crt(mbedtls_x509_crt *crt, const char *pem, size_t len) {
  unsigned char *buf = malloc(len + 1);
  if (!buf) scr_tls_oom();
  memcpy(buf, pem, len);
  buf[len] = 0;
  int r = mbedtls_x509_crt_parse(crt, buf, len + 1);
  free(buf);
  return r;
}

static int scr_tls_parse_key(mbedtls_pk_context *pk, const char *pem, size_t len) {
  unsigned char *buf = malloc(len + 1);
  if (!buf) scr_tls_oom();
  memcpy(buf, pem, len);
  buf[len] = 0;
  int r = mbedtls_pk_parse_key(pk, buf, len + 1, NULL, 0, mbedtls_ctr_drbg_random,
                               &scr_tls_drbg);
  free(buf);
  return r;
}

/* Bad cert/key material is a construction-time crash in Node (createServer
 * throws); this runtime's shape for it is the print-and-die trap. */
static void scr_tls_bad_material(const char *what, int err) {
  char detail[128];
  mbedtls_strerror(err, detail, sizeof detail);
  fflush(stdout);
  fprintf(stderr, "scriptc: tls: failed to parse %s (%s)\n", what, detail);
  _Exit(1);
}

/* OpenSSL's automatic chain (ssl_add_cert_chain): a certificate option
 * that holds only the leaf is sent with the issuers `store` holds, up to
 * a self-issued one, as far as they are found. A chain given in the
 * option is sent as it is. */
static void scr_tls_auto_chain(mbedtls_x509_crt *own, const mbedtls_x509_crt *store) {
  if (own->raw.len == 0 || own->next != NULL) return;
  const mbedtls_x509_crt *at = own;
  for (int depth = 0; depth < 8; depth++) {
    if (at->issuer_raw.len == at->subject_raw.len &&
        memcmp(at->issuer_raw.p, at->subject_raw.p, at->subject_raw.len) == 0)
      return;
    const mbedtls_x509_crt *issuer = NULL;
    for (const mbedtls_x509_crt *c = store; c != NULL && c->raw.len > 0 && issuer == NULL; c = c->next) {
      if (c->subject_raw.len == at->issuer_raw.len &&
          memcmp(c->subject_raw.p, at->issuer_raw.p, c->subject_raw.len) == 0)
        issuer = c;
    }
    if (issuer == NULL) return;
    for (const mbedtls_x509_crt *c = own; c != NULL; c = c->next) {
      if (c->raw.len == issuer->raw.len && memcmp(c->raw.p, issuer->raw.p, c->raw.len) == 0) return;
    }
    if (mbedtls_x509_crt_parse_der(own, issuer->raw.p, issuer->raw.len) != 0) return;
    while (at->next != NULL) at = at->next;
  }
}

/* A copy of a certificate chain, completed from `store` as the automatic
 * chain does, for a use that must leave the original as it is. */
static void scr_tls_chained_copy(mbedtls_x509_crt *out, const mbedtls_x509_crt *chain,
                                 const mbedtls_x509_crt *store) {
  for (const mbedtls_x509_crt *c = chain; c != NULL && c->raw.len > 0; c = c->next) {
    if (mbedtls_x509_crt_parse_der(out, c->raw.p, c->raw.len) != 0) scr_tls_bad_material("certificate", 0);
  }
  scr_tls_auto_chain(out, store);
}

/* ── SecureContext (tls.createSecureContext) ─────────────────────────── */

/* An opaque refcounted parsed cert/key pair — what an SNI callback
 * answers with; the handshake serves it via mbedtls_ssl_set_hs_own_cert. */
struct ScrSecureCtx {
  size_t rc;
  mbedtls_x509_crt cert;
  mbedtls_pk_context pk;
  /* the ca option: a socket created from this context (a TLSSocket's
   * secureContext) sends the chain it completes, and a server that serves
   * the context verifies client certificates against it. has_ca tells an
   * empty ca (an empty trust store) from none (the default store). */
  bool has_ca;
  mbedtls_x509_crt ca;
};

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_secure_ctx = 0;
long scr_secure_ctx_live_count(void) { return scr_live_secure_ctx; }
#endif

ScrSecureCtx *scr_tls_create_secure_context(const char *cert, size_t cert_len,
                                             const char *key, size_t key_len) {
  scr_tls_rng_init();
  ScrSecureCtx *c = calloc(1, sizeof *c);
  if (!c) scr_tls_oom();
  c->rc = 1;
  mbedtls_x509_crt_init(&c->cert);
  mbedtls_x509_crt_init(&c->ca);
  mbedtls_pk_init(&c->pk);
  int r = scr_tls_parse_crt(&c->cert, cert, cert_len);
  if (r != 0) scr_tls_bad_material("certificate", r);
  r = scr_tls_parse_key(&c->pk, key, key_len);
  if (r != 0) scr_tls_bad_material("private key", r);
#ifdef SCR_RC_AUDIT
  scr_live_secure_ctx++;
#endif
  return c;
}

ScrSecureCtx *scr_secure_ctx_retain(ScrSecureCtx *c) {
  if (c) c->rc++;
  return c;
}

void scr_secure_ctx_release(ScrSecureCtx *c) {
  if (!c || --c->rc != 0) return;
  mbedtls_x509_crt_free(&c->cert);
  mbedtls_x509_crt_free(&c->ca);
  mbedtls_pk_free(&c->pk);
  free(c);
#ifdef SCR_RC_AUDIT
  scr_live_secure_ctx--;
#endif
}

void *scr_secure_ctx_retain_v(void *p) { return scr_secure_ctx_retain((ScrSecureCtx *)p); }
void scr_secure_ctx_release_v(void *p) { scr_secure_ctx_release((ScrSecureCtx *)p); }

/* ── the server config (one per created server, rc'd) ────────────────── */

/* An owned ALPN name list (NULL-terminated; NULL frees nothing). */
static void scr_tls_alpn_free(char **names) {
  if (names == NULL) return;
  for (char **n = names; *n != NULL; n++) free(*n);
  free(names);
}

static bool scr_tls_alpn_dyn(const ScrDyn *v, char ***out);
static void scr_tls_opt_fence(const char *api, const char *key, const char *hint);
static bool scr_tls_dyn_truthy(const ScrDyn *v);

/* Node's toV over a minVersion/maxVersion value: 'TLSv1' through 'TLSv1.3'
 * as 10 through 13, null or undefined as `def`. Anything else throws
 * ERR_TLS_INVALID_PROTOCOL_VERSION ("%j is not a valid <which> TLS protocol
 * version"). False with the exception pending. */
static bool scr_tls_version_dyn(const ScrDyn *v, const char *which, int def, int *out) {
  if (v == NULL || v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) {
    *out = def;
    return true;
  }
  if (v->kind == SCR_DYN_STR) {
    static const struct { const char *name; int version; } names[] = {
      { "TLSv1", 10 }, { "TLSv1.1", 11 }, { "TLSv1.2", 12 }, { "TLSv1.3", 13 },
    };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
      if (v->v.str->len == strlen(names[i].name) &&
          memcmp(v->v.str->data, names[i].name, v->v.str->len) == 0) {
        *out = names[i].version;
        return true;
      }
    }
  }
  ScrStr *shown = scr_util_format_j(v);
  if (shown == NULL) return false;
  char msg[300];
  int m = snprintf(msg, sizeof msg, "%.*s is not a valid %s TLS protocol version",
                   (int)(shown->len < 200 ? shown->len : 200), shown->data, which);
  scr_str_release(shown);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)m, "ERR_TLS_INVALID_PROTOCOL_VERSION");
  return false;
}

/* The version range on an mbedTLS config. mbedTLS implements TLS 1.2 and
 * 1.3, so a minimum of TLSv1 or TLSv1.1 offers from 1.2, the lowest version
 * Node's default security level allows too. Answers false when no version
 * in [min, max] is available (a maximum below 1.2, or min above max), which
 * Node reports as ERR_SSL_NO_PROTOCOLS_AVAILABLE when the handshake starts. */
static bool scr_tls_conf_versions(mbedtls_ssl_config *conf, int min, int max) {
  if (min < 12) min = 12;
  if (max < min) return false;
  mbedtls_ssl_conf_min_tls_version(conf, min == 13 ? MBEDTLS_SSL_VERSION_TLS1_3 : MBEDTLS_SSL_VERSION_TLS1_2);
  mbedtls_ssl_conf_max_tls_version(conf, max == 13 ? MBEDTLS_SSL_VERSION_TLS1_3 : MBEDTLS_SSL_VERSION_TLS1_2);
  return true;
}

/* Node's SecureContext checks, in its order: secureProtocol conflicts with
 * an explicit minVersion or maxVersion, then each version. The range lands
 * in *min / *max (Node's defaults TLSv1.2 and TLSv1.3). False with the
 * exception pending. */
static bool scr_tls_versions_dyn(const ScrDyn *opts, int *min, int *max) {
  const ScrDyn *vmin = opts != NULL && opts->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(opts, "minVersion", 10) : NULL;
  const ScrDyn *vmax = opts != NULL && opts->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(opts, "maxVersion", 10) : NULL;
  const ScrDyn *proto = opts != NULL && opts->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(opts, "secureProtocol", 14) : NULL;
  if (proto != NULL && scr_tls_dyn_truthy(proto)) {
    const ScrDyn *version = vmin != NULL && vmin->kind != SCR_DYN_UNDEF && vmin->kind != SCR_DYN_NULL ? vmin
                            : vmax != NULL && vmax->kind != SCR_DYN_UNDEF && vmax->kind != SCR_DYN_NULL ? vmax
                                                                                                        : NULL;
    if (version != NULL) {
      ScrStr *a = scr_util_format_j(version);
      if (a == NULL) return false;
      ScrStr *b = scr_util_format_j(proto);
      if (b == NULL) {
        scr_str_release(a);
        return false;
      }
      char msg[400];
      int m = snprintf(msg, sizeof msg, "TLS protocol version %.*s conflicts with secureProtocol %.*s",
                       (int)(a->len < 150 ? a->len : 150), a->data, (int)(b->len < 150 ? b->len : 150), b->data);
      scr_str_release(a);
      scr_str_release(b);
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)m, "ERR_TLS_PROTOCOL_VERSION_CONFLICT");
      return false;
    }
  }
  return scr_tls_version_dyn(vmin, "minimum", 12, min) && scr_tls_version_dyn(vmax, "maximum", 13, max);
}

typedef struct ScrTlsSrv {
  size_t rc;
  mbedtls_ssl_config conf;
  mbedtls_x509_crt cert;
  mbedtls_pk_context pk;
  /* https: the wrapped http-parser connection hook, attached from
   * on_established so it only ever sees plaintext */
  ScrNetNativeConnFn inner_conn;
  void *inner_ctx;
  void (*inner_ctx_free)(void *);
  /* h2 over TLS (http2.createSecureServer): the h2 session attach —
   * on_established dispatches on the NEGOTIATED protocol (h2 → this
   * hook; http/1.1 → inner_conn; no answer → teardown). */
  ScrNetNativeConnFn h2_conn;
  void *h2_ctx;
  void (*h2_ctx_free)(void *);
  /* SNI: the JS SNICallback (owned, nullable) and the emitted answer
   * thunk that becomes each minted answer closure's fn */
  ScrClosure *sni_cb;
  void *sni_answer_fn;
  /* tls.createServer's ALPNProtocols (owned; NULL when none), in the
   * server's preference order. */
  char **alpn;
  /* maxVersion TLSv1.2: the ClientHello is pre-parsed so a hello that
   * offers only later versions gets OpenSSL's protocol_version alert. */
  bool max_tls12;
  /* new tls.TLSSocket(socket, { secureContext }): the context whose
   * certificate and key this config serves (+1; NULL when cert/key are the
   * config's own) */
  ScrSecureCtx *ctx;
  /* client certificates: requestCert asks for one and verifies it against
   * `ca` (the default store without one); with rejectUnauthorized a client
   * that sends none fails the handshake and one that fails verification
   * is dropped before 'secureConnection', as in Node */
  bool request_cert;
  bool reject_unauthorized;
  bool has_ca;
  mbedtls_x509_crt ca;
  /* new tls.TLSSocket(socket, { isServer }): Node verifies client
   * certificates only in tls.Server, so a standalone socket reports no
   * verdict (authorized false, authorizationError null) and drops no
   * client for one; rejectUnauthorized there only requires a certificate */
  bool standalone;
  /* server.addContext(servername, context): lowercased name patterns
   * ('*' matches within one label) with their contexts (+1), newest
   * last; server.setSecureContext's replacement default (+1, NULL for the
   * server's own). Both serve through scr_tls_f_cert. */
  struct ScrTlsNamedCtx {
    char *pattern;
    ScrSecureCtx *ctx;
  } *contexts;
  size_t ncontexts;
  ScrSecureCtx *default_ctx;
} ScrTlsSrv;

/* The ALPN answers (static storage — mbedTLS keeps the pointers). Plain
 * tls servers configure none, like Node; https advertises http/1.1; the
 * h2 secure server advertises h2 alone (an http/1.1-only client fails
 * the handshake with no_application_protocol — Node's h2-only split). */
static const char *SCR_TLS_ALPN_HTTP11[] = {"http/1.1", NULL};
static const char *SCR_TLS_ALPN_H2[] = {"h2", NULL};
static const char *SCR_TLS_ALPN_H2_HTTP11[] = {"h2", "http/1.1", NULL};

static ScrTlsSrv *scr_tls_srv_new(const char *cert, size_t cert_len, const char *key,
                                   size_t key_len, bool alpn_http11) {
  scr_tls_rng_init();
  ScrTlsSrv *s = calloc(1, sizeof *s);
  if (!s) scr_tls_oom();
  s->rc = 1;
  mbedtls_x509_crt_init(&s->cert);
  mbedtls_x509_crt_init(&s->ca);
  mbedtls_pk_init(&s->pk);
  mbedtls_ssl_config_init(&s->conf);
  int r = scr_tls_parse_crt(&s->cert, cert, cert_len);
  if (r != 0) scr_tls_bad_material("certificate", r);
  r = scr_tls_parse_key(&s->pk, key, key_len);
  if (r != 0) scr_tls_bad_material("private key", r);
  if (mbedtls_ssl_config_defaults(&s->conf, MBEDTLS_SSL_IS_SERVER,
                                  MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
    scr_tls_oom();
  }
  mbedtls_ssl_conf_rng(&s->conf, mbedtls_ctr_drbg_random, &scr_tls_drbg);
  /* no client certificate unless requestCert asks (scr_tls_srv_client_auth) */
  mbedtls_ssl_conf_authmode(&s->conf, MBEDTLS_SSL_VERIFY_NONE);
  if (mbedtls_ssl_conf_own_cert(&s->conf, &s->cert, &s->pk) != 0) {
    scr_tls_bad_material("certificate/key pair", 0);
  }
  if (alpn_http11) mbedtls_ssl_conf_alpn_protocols(&s->conf, SCR_TLS_ALPN_HTTP11);
  return s;
}

/* A server config that serves a SecureContext's certificate and key. */
static ScrTlsSrv *scr_tls_srv_from_ctx(ScrSecureCtx *ctx /*borrowed*/) {
  scr_tls_rng_init();
  ScrTlsSrv *s = calloc(1, sizeof *s);
  if (!s) scr_tls_oom();
  s->rc = 1;
  mbedtls_x509_crt_init(&s->cert);
  mbedtls_x509_crt_init(&s->ca);
  mbedtls_pk_init(&s->pk);
  mbedtls_ssl_config_init(&s->conf);
  if (mbedtls_ssl_config_defaults(&s->conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
    scr_tls_oom();
  }
  mbedtls_ssl_conf_rng(&s->conf, mbedtls_ctr_drbg_random, &scr_tls_drbg);
  mbedtls_ssl_conf_authmode(&s->conf, MBEDTLS_SSL_VERIFY_NONE);
  s->ctx = scr_secure_ctx_retain(ctx);
  /* the context's ca completes the chain a socket created from it sends */
  const mbedtls_x509_crt *own = &ctx->cert;
  if (ctx->ca.raw.len > 0) {
    scr_tls_chained_copy(&s->cert, &ctx->cert, &ctx->ca);
    own = &s->cert;
  }
  if (mbedtls_ssl_conf_own_cert(&s->conf, (mbedtls_x509_crt *)own, &ctx->pk) != 0) {
    scr_tls_bad_material("certificate/key pair", 0);
  }
  return s;
}

static ScrTlsSrv *scr_tls_srv_retain(ScrTlsSrv *s) {
  s->rc++;
  return s;
}

static void scr_tls_srv_release(ScrTlsSrv *s) {
  if (!s || --s->rc != 0) return;
  if (s->inner_ctx_free) s->inner_ctx_free(s->inner_ctx);
  if (s->h2_ctx_free) s->h2_ctx_free(s->h2_ctx);
  scr_closure_release(s->sni_cb);
  mbedtls_ssl_config_free(&s->conf);
  mbedtls_x509_crt_free(&s->cert);
  mbedtls_x509_crt_free(&s->ca);
  mbedtls_pk_free(&s->pk);
  scr_tls_alpn_free(s->alpn);
  scr_secure_ctx_release(s->ctx);
  for (size_t i = 0; i < s->ncontexts; i++) {
    free(s->contexts[i].pattern);
    scr_secure_ctx_release(s->contexts[i].ctx);
  }
  free(s->contexts);
  scr_secure_ctx_release(s->default_ctx);
  free(s);
}

static void scr_tls_srv_release_v(void *p) { scr_tls_srv_release((ScrTlsSrv *)p); }

/* The client-certificate options of a server: requestCert, rejectUnauthorized
 * (Node's true default) and ca (+1, NULL for none). */
typedef struct {
  bool request;
  bool reject;
  ScrBytes *ca;
} ScrTlsClientAuth;

static mbedtls_x509_crt *scr_tls_system_ca(void);

/* Applies a server's client-certificate options. A `ca` also completes the
 * server's own chain, as OpenSSL's automatic chain sends it. */
static void scr_tls_srv_client_auth(ScrTlsSrv *s, const ScrTlsClientAuth *auth) {
  if (auth == NULL) return;
  /* An empty ca Buffer is an empty trust store, not the default one. */
  if (auth->ca != NULL) {
    if (auth->ca->len > 0) {
      int r = scr_tls_parse_crt(&s->ca, (const char *)auth->ca->data, auth->ca->len);
      if (r != 0) scr_tls_bad_material("ca certificate", r);
      if (s->ctx == NULL) scr_tls_auto_chain(&s->cert, &s->ca);
    }
    s->has_ca = true;
  }
  if (!auth->request) return;
  s->request_cert = true;
  s->reject_unauthorized = auth->reject;
  /* OPTIONAL: the handshake records the verdict and goes on, as Node's
   * verify callback does; scr_tls_handshake applies rejectUnauthorized */
  mbedtls_ssl_conf_authmode(&s->conf, MBEDTLS_SSL_VERIFY_OPTIONAL);
  mbedtls_ssl_conf_ca_chain(&s->conf, s->has_ca ? &s->ca : scr_tls_system_ca(), NULL);
}

/* ── the client config (one per https.request, owned by its tctx) ────── */

typedef struct ScrTlsCli {
  mbedtls_ssl_config conf;
  /* the ca option, which replaces the default store; has_ca tells an
   * empty ca (an empty trust store) from none */
  bool has_ca;
  mbedtls_x509_crt ca;
  char *hostname;    /* the SNI name; NULL sends none (an IP literal, servername: "") */
  char *verify_name; /* the name the leaf is checked against; NULL fails the check */
  /* true when the handshake RECORDS verification (VERIFY_OPTIONAL /
   * VERIFY_REQUIRED) — socket.authorized answers from the result; a
   * VERIFY_NONE socket (the https client's rejectUnauthorized:false)
   * never verified, so authorized answers false like Node's. */
  bool verify_recorded;
  bool reject; /* rejectUnauthorized: a verification failure fails the handshake */
  /* The ALPNProtocols option's names, NULL-terminated, in the caller's
   * order (mbedtls_ssl_conf_alpn_protocols keeps the pointer); NULL when
   * none are offered. */
  char **alpn;
  /* No TLS version is in the configured range: the handshake fails as
   * soon as it starts (Node's ERR_SSL_NO_PROTOCOLS_AVAILABLE). */
  bool no_protocols;
  /* the client certificate (cert and key options), sent when the server
   * asks for one */
  bool has_own;
  mbedtls_x509_crt own;
  mbedtls_pk_context own_pk;
} ScrTlsCli;

/* The default trust anchors when no `ca` option is given: the host trust
 * store, standing in for Node's compiled-in Mozilla roots, plus
 * NODE_EXTRA_CA_CERTS. Windows certificates live as DER entries across the
 * machine, enterprise, current-user, and policy ROOT/CA/TrustedPeople store
 * locations; mbedTLS copies each successfully parsed entry into its own chain.
 * POSIX hosts probe the established bundle spellings — /etc/ssl/cert.pem
 * first (macOS ships it; Alpine links it), then Debian/Ubuntu's
 * ca-certificates.crt, Fedora/RHEL's ca-bundle.crt, and openSUSE's
 * ca-bundle.pem. */
static SCR_TL mbedtls_x509_crt scr_tls_system_roots;
static SCR_TL bool scr_tls_system_roots_loaded = false;

/* setDefaultCACertificates' replacement anchors (scr_tls_ca.c — always
 * compiled alongside this unit): parsed lazily per generation, so each
 * set re-parses once and every later dial reuses the chain. An EMPTY
 * replacement keeps an initialized, certificate-free chain — every
 * verification fails, Node's own consequence of trusting nothing. */
static SCR_TL mbedtls_x509_crt scr_tls_override_roots;
static SCR_TL uint64_t scr_tls_override_parsed_gen = 0;

#ifdef _WIN32
static void scr_tls_add_windows_ca(void *ctx, const unsigned char *der, size_t len) {
  (void)mbedtls_x509_crt_parse_der((mbedtls_x509_crt *)ctx, der, len);
}
#endif

static mbedtls_x509_crt *scr_tls_system_ca(void) {
  const char *pem = NULL;
  size_t pem_len = 0;
  uint64_t gen = 0;
  if (scr_tls_ca_default_override(&pem, &pem_len, &gen)) {
    if (gen != scr_tls_override_parsed_gen) {
      if (scr_tls_override_parsed_gen != 0) mbedtls_x509_crt_free(&scr_tls_override_roots);
      mbedtls_x509_crt_init(&scr_tls_override_roots);
      /* +1 for the NUL — mbedTLS's PEM mode wants it counted. A parse
       * failure inside one block leaves the chain with the blocks that
       * did parse (the scr_tls_ca.c divergence note). */
      if (pem_len > 0) (void)mbedtls_x509_crt_parse(&scr_tls_override_roots, (const unsigned char *)pem, pem_len + 1);
      scr_tls_override_parsed_gen = gen;
    }
    return &scr_tls_override_roots;
  }
  if (!scr_tls_system_roots_loaded) {
    scr_tls_system_roots_loaded = true;
    mbedtls_x509_crt_init(&scr_tls_system_roots);
#ifdef _WIN32
    /* The shared enumerator applies Windows' effective server-auth EKU
     * policy before yielding DER. mbedTLS copies every successfully parsed
     * entry, so the store contexts may die immediately after each callback. */
    scr_tls_ca_windows_certs(scr_tls_add_windows_ca, &scr_tls_system_roots);
#else
    static const char *const bundles[] = {
        "/etc/ssl/cert.pem",                  /* macOS, Alpine */
        "/etc/ssl/certs/ca-certificates.crt", /* Debian/Ubuntu */
        "/etc/pki/tls/certs/ca-bundle.crt",   /* Fedora/RHEL */
        "/etc/ssl/ca-bundle.pem",             /* openSUSE */
    };
    for (size_t i = 0; i < sizeof bundles / sizeof bundles[0]; i++) {
      if (mbedtls_x509_crt_parse_file(&scr_tls_system_roots, bundles[i]) == 0) break;
    }
#endif
    const char *extra = NULL;
    size_t extra_len = 0;
    if (scr_tls_ca_extra_pem(&extra, &extra_len) && extra_len > 0) {
      (void)mbedtls_x509_crt_parse(
          &scr_tls_system_roots, (const unsigned char *)extra,
          extra_len + 1);
    }
  }
  return &scr_tls_system_roots;
}

/* `verify_optional` is tls.connect's rejectUnauthorized:false: the
 * handshake proceeds regardless of the verdict but verification still
 * RUNS and records (socket.authorized / authorizationError answer
 * Node's split); the https client's historical false keeps VERIFY_NONE
 * (verify_optional false there — nothing recorded, nothing read). */
static bool scr_tls_is_ip(const char *h) {
  struct in_addr a4;
  struct in6_addr a6;
  return inet_pton(AF_INET, h, &a4) == 1 || inet_pton(AF_INET6, h, &a6) == 1;
}

static ScrTlsCli *scr_tls_cli_new2(ScrStr *host, bool reject_unauthorized, const char *ca,
                                    size_t ca_len, bool verify_optional) {
  scr_tls_rng_init();
  ScrTlsCli *c = calloc(1, sizeof *c);
  if (!c) scr_tls_oom();
  mbedtls_ssl_config_init(&c->conf);
  mbedtls_x509_crt_init(&c->ca);
  mbedtls_x509_crt_init(&c->own);
  mbedtls_pk_init(&c->own_pk);
  if (mbedtls_ssl_config_defaults(&c->conf, MBEDTLS_SSL_IS_CLIENT,
                                  MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
    scr_tls_oom();
  }
  mbedtls_ssl_conf_rng(&c->conf, mbedtls_ctr_drbg_random, &scr_tls_drbg);
  c->verify_recorded = reject_unauthorized || verify_optional;
  c->reject = reject_unauthorized;
  c->has_ca = ca != NULL;
  if (ca_len > 0) {
    int r = scr_tls_parse_crt(&c->ca, ca, ca_len);
    if (r != 0) scr_tls_bad_material("ca certificate", r);
  }
  if (!reject_unauthorized && !verify_optional) {
    mbedtls_ssl_conf_authmode(&c->conf, MBEDTLS_SSL_VERIFY_NONE);
  } else {
    mbedtls_ssl_conf_authmode(&c->conf, reject_unauthorized ? MBEDTLS_SSL_VERIFY_REQUIRED
                                                            : MBEDTLS_SSL_VERIFY_OPTIONAL);
    mbedtls_ssl_conf_ca_chain(&c->conf, c->has_ca ? &c->ca : scr_tls_system_ca(), NULL);
  }
  /* The host is the verified name; it is also the SNI name unless it is
   * an IP literal. */
  const char *h = host->len > 0 ? host->data : "localhost";
  c->verify_name = strdup(h);
  if (!c->verify_name) scr_tls_oom();
  if (!scr_tls_is_ip(h)) {
    c->hostname = strdup(h);
    if (!c->hostname) scr_tls_oom();
  }
  return c;
}

/* The servername option: a non-empty name is both the SNI name and the
 * verified name; "" sends no SNI and keeps the host as the verified name,
 * as in Node. */
static void scr_tls_cli_set_servername(ScrTlsCli *c, const ScrStr *servername) {
  free(c->hostname);
  c->hostname = NULL;
  if (servername->len == 0) return;
  char *z = malloc(servername->len + 1);
  if (!z) scr_tls_oom();
  memcpy(z, servername->data, servername->len);
  z[servername->len] = '\0';
  free(c->verify_name);
  c->verify_name = z;
  if (!scr_tls_is_ip(z)) {
    c->hostname = strdup(z);
    if (!c->hostname) scr_tls_oom();
  }
}

static ScrTlsCli *scr_tls_cli_new(ScrStr *host, bool reject_unauthorized, const char *ca,
                                   size_t ca_len) {
  return scr_tls_cli_new2(host, reject_unauthorized, ca, ca_len, false);
}

static void scr_tls_cli_free(ScrTlsCli *c) {
  mbedtls_ssl_config_free(&c->conf);
  scr_tls_alpn_free(c->alpn);
  mbedtls_x509_crt_free(&c->ca);
  mbedtls_x509_crt_free(&c->own);
  mbedtls_pk_free(&c->own_pk);
  free(c->hostname);
  free(c->verify_name);
  free(c);
}

/* The cert and key options of a client: the certificate (with the issuers
 * its `ca` holds, OpenSSL's automatic chain) is sent when the server asks
 * for one. */
static void scr_tls_cli_set_own(ScrTlsCli *c, const ScrBytes *cert, const ScrBytes *key) {
  int r = scr_tls_parse_crt(&c->own, (const char *)cert->data, cert->len);
  if (r != 0) scr_tls_bad_material("certificate", r);
  r = scr_tls_parse_key(&c->own_pk, (const char *)key->data, key->len);
  if (r != 0) scr_tls_bad_material("private key", r);
  if (c->ca.raw.len > 0) scr_tls_auto_chain(&c->own, &c->ca);
  if (mbedtls_ssl_conf_own_cert(&c->conf, &c->own, &c->own_pk) != 0)
    scr_tls_bad_material("certificate/key pair", 0);
  c->has_own = true;
}

/* ── the per-socket transport ────────────────────────────────────────── */

/* The SNI pre-parse states: NONE (no callback on the server — the
 * handshake runs directly), COLLECT (buffering the ClientHello),
 * WAIT (the JS callback is deciding), DONE (answered/skipped — the
 * hello replayed into the bio; the handshake runs). */
enum { SCR_SNI_NONE = 0, SCR_SNI_COLLECT, SCR_SNI_WAIT, SCR_SNI_DONE };

typedef struct ScrTlsSock {
  mbedtls_ssl_context ssl;
  ScrNetSocket *sock; /* BORROWED: the tctx lives and dies with the socket */
  ScrTlsSrv *srv;     /* +1 server side, NULL client side */
  ScrTlsCli *cli;     /* owned client side, NULL server side */
  bool notify_sent;
  bool established; /* the handshake stood — socket.authorized reads gate on it */
  /* the client 'session' event: listeners + the fired-once latch (Node
   * fires per received ticket; this surface fires once per socket) */
  ScrNetLs session_ls;
  bool session_fired;
  /* what the verify callback saw (the peer chain is gone once the
   * handshake has failed, so the shape is recorded as it verifies) */
  bool vrfy_leaf_self;
  bool vrfy_chain_self;
  bool vrfy_expired;
  bool vrfy_cn_mismatch;
  /* SNI pre-parse state (server side with an SNI callback only) */
  int sni_state;
  bool in_handshake;   /* a synchronous cb answer must not re-pump */
  unsigned char *hello; /* the raw ClientHello flight, replayed at DONE */
  size_t hello_len, hello_cap;
  ScrSecureCtx *sni_ctx; /* owned; the answer (NULL = default cert) */
  /* scr_tls_f_cert verified client certificates against sni_ctx's ca
   * (or the default store without one), not the server's */
  bool ctx_verifies;
  /* new tls.TLSSocket(socket, { isServer: true }): the program holds this
   * socket before the handshake, so a failed handshake is its 'error'
   * (tls.createServer's sockets fail without one) */
  bool wrapped;
  unsigned char head[5]; /* the first bytes the peer sent (the error's wording) */
  size_t head_len;
  /* the 'secure' event's listeners */
  ScrNetLs secure_ls;
  bool settled; /* the socket closed: listeners added later never fire */
  /* a TLS 1.3 client sent no certificate to a server that requires one;
   * the alert goes out once the handshake is over */
  bool cert_missing;
  /* a fatal alert was reported without closing: reads end the stream */
  bool alert_reported;
  /* a server socket: the accepting server (+1), which 'tlsClientError'
   * fires on, and a hang-up waiting for the socket to close (Node emits
   * ECONNRESET 'socket hang up' from the socket's 'close') */
  ScrNetServer *server;
  bool hang_up_pending;
  /* a client whose verification failed: like Node's, it closes without
   * sending the alert, so later writes are dropped */
  bool quiet_failure;
  /* the served context's chain completed from the server's ca */
  mbedtls_x509_crt served_chain;
  /* what the handshake's last step and the established callbacks write:
   * Node flushes it after the nextTick queue and before the immediates
   * queued in those callbacks, so a destroy() there drops it. `holding`
   * collects; held[held_off..held_len) waits for the fd. */
  bool holding;
  unsigned char *held;
  size_t held_len, held_off, held_cap;
} ScrTlsSock;

static bool scr_tls_alert_error(ScrTlsSock *t, unsigned char alert);

/* checkServerIdentity for an IP literal: the address must be one of the
 * certificate's IP SANs (no DNS SAN or CN applies). */
static bool scr_tls_leaf_has_ip(const mbedtls_x509_crt *crt, const char *ip) {
  unsigned char addr[16];
  size_t len = 0;
  if (inet_pton(AF_INET, ip, addr) == 1) len = 4;
  else if (inet_pton(AF_INET6, ip, addr) == 1) len = 16;
  else return false;
  /* without the extension the sequence is empty (no buffer) */
  for (const mbedtls_x509_sequence *cur = &crt->subject_alt_names; cur != NULL; cur = cur->next) {
    if (cur->buf.p == NULL) continue;
    unsigned char tag = (unsigned char)cur->buf.tag & MBEDTLS_ASN1_TAG_VALUE_MASK;
    if (tag == MBEDTLS_X509_SAN_IP_ADDRESS && cur->buf.len == len &&
        memcmp(cur->buf.p, addr, len) == 0)
      return true;
  }
  return false;
}

/* The client verify callback: records WHERE verification failed and how
 * the presented chain is shaped, per certificate (depth 0 = leaf), so
 * the failure message can be Node's exact split. The verdict stays
 * mbedTLS's, except that a client sending no SNI (mbedTLS was told to
 * skip its name check) checks the leaf against cli->verify_name here: an
 * IP literal against the IP SANs, another name with mbedtls_x509_crt_verify
 * on the leaf alone, keeping only its CN_MISMATCH bit. No name to check is
 * a mismatch. */
static int scr_tls_vrfy_cb(void *ctx, mbedtls_x509_crt *crt, int depth, uint32_t *flags) {
  ScrTlsSock *t = (ScrTlsSock *)ctx;
  if (depth == 0 && t->cli != NULL && t->cli->hostname == NULL) {
    const char *name = t->cli->verify_name;
    if (name == NULL || name[0] == '\0') {
      *flags |= MBEDTLS_X509_BADCERT_CN_MISMATCH;
    } else if (scr_tls_is_ip(name)) {
      if (!scr_tls_leaf_has_ip(crt, name)) *flags |= MBEDTLS_X509_BADCERT_CN_MISMATCH;
    } else {
      mbedtls_x509_crt *chain = crt->next;
      uint32_t name_flags = 0;
      crt->next = NULL; /* the name check needs the leaf only */
      (void)mbedtls_x509_crt_verify(crt, NULL, NULL, name, &name_flags, NULL, NULL);
      crt->next = chain;
      *flags |= name_flags & MBEDTLS_X509_BADCERT_CN_MISMATCH;
    }
  }
  /* a rejecting client fails the handshake on any flag; Node's client
   * then closes without sending an alert (its Finished is discarded) */
  if (*flags != 0 && t->cli != NULL && t->cli->reject) t->quiet_failure = true;
  bool self = crt->issuer_raw.len == crt->subject_raw.len &&
              memcmp(crt->issuer_raw.p, crt->subject_raw.p, crt->subject_raw.len) == 0;
  if (*flags & MBEDTLS_X509_BADCERT_EXPIRED) t->vrfy_expired = true;
  if (*flags & MBEDTLS_X509_BADCERT_CN_MISMATCH) t->vrfy_cn_mismatch = true;
  if (*flags & MBEDTLS_X509_BADCERT_NOT_TRUSTED) {
    if (depth == 0 && self) t->vrfy_leaf_self = true;
    if (depth > 0 && self) t->vrfy_chain_self = true;
  }
  return 0;
}

/* The BIOs: nonblocking fd I/O in mbedTLS's own convention. A send that
 * would block arms the socket's write filter so the handshake resumes on
 * writability. */
static void scr_tls_hold(ScrTlsSock *t, const unsigned char *buf, size_t len) {
  if (t->held_len + len > t->held_cap) {
    size_t cap = t->held_cap ? t->held_cap : 4096;
    while (cap < t->held_len + len) cap *= 2;
    unsigned char *grown = realloc(t->held, cap);
    if (grown == NULL) scr_tls_oom();
    t->held = grown;
    t->held_cap = cap;
  }
  memcpy(t->held + t->held_len, buf, len);
  t->held_len += len;
}

/* Writes what is held: 1 once it is all out, 0 when the fd would block
 * (the write filter is armed for the rest), -1 when the connection is
 * gone (the bytes are dropped). */
static int scr_tls_flush_held(ScrTlsSock *t) {
  int fd = scr_net_sock_fd(t->sock);
  while (t->held_off < t->held_len) {
    if (fd < 0) break;
    ssize_t n = write(fd, t->held + t->held_off, t->held_len - t->held_off);
    if (n > 0) {
      t->held_off += (size_t)n;
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      scr_net_sock_transport_want_write(t->sock);
      return 0;
    }
    break;
  }
  bool out = t->held_off == t->held_len;
  t->held_off = t->held_len = 0;
  return out ? 1 : -1;
}

static int scr_tls_bio_send(void *ctx, const unsigned char *buf, size_t len) {
  ScrTlsSock *t = (ScrTlsSock *)ctx;
  if (t->quiet_failure) return (int)len;
  if (t->holding) {
    scr_tls_hold(t, buf, len);
    return (int)len;
  }
  /* held bytes go first; mbedTLS retries this record once they are out */
  if (t->held_len > t->held_off && scr_tls_flush_held(t) == 0) return MBEDTLS_ERR_SSL_WANT_WRITE;
  int fd = scr_net_sock_fd(t->sock);
  if (fd < 0) return MBEDTLS_ERR_NET_CONN_RESET;
  ssize_t n = write(fd, buf, len);
  if (n >= 0) return (int)n;
  if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
    scr_net_sock_transport_want_write(t->sock);
    return MBEDTLS_ERR_SSL_WANT_WRITE;
  }
  if (errno == EPIPE || errno == ECONNRESET) return MBEDTLS_ERR_NET_CONN_RESET;
  return MBEDTLS_ERR_NET_SEND_FAILED;
}

/* Keeps the first bytes a wrapped socket's peer sends: a handshake that
 * fails on them reports what they looked like, as OpenSSL does. */
static void scr_tls_note_head(ScrTlsSock *t, const unsigned char *buf, size_t n) {
  if (t->srv == NULL || t->head_len == sizeof t->head) return;
  size_t take = sizeof t->head - t->head_len;
  if (take > n) take = n;
  memcpy(t->head + t->head_len, buf, take);
  t->head_len += take;
}

static int scr_tls_bio_recv(void *ctx, unsigned char *buf, size_t len) {
  ScrTlsSock *t = (ScrTlsSock *)ctx;
  int fd = scr_net_sock_fd(t->sock);
  if (fd < 0) return MBEDTLS_ERR_NET_CONN_RESET;
  /* bytes a consumer peeked and unshifted (the demux path) re-enter the
   * stream here, ahead of the kernel's */
  size_t took = scr_net_sock_take_buffered(t->sock, (char *)buf, len);
  if (took > 0) {
    scr_tls_note_head(t, buf, took);
    return (int)took;
  }
  ssize_t n = read(fd, buf, len);
  if (n > 0) scr_tls_note_head(t, buf, (size_t)n);
  if (n >= 0) return (int)n; /* 0 = EOF; mbedTLS maps it to CONN_EOF */
  if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
    return MBEDTLS_ERR_SSL_WANT_READ;
  }
  if (errno == ECONNRESET) return MBEDTLS_ERR_NET_CONN_RESET;
  return MBEDTLS_ERR_NET_RECV_FAILED;
}

/* Node reads what the kernel holds (one 64 KiB libuv read) before
 * OpenSSL sees the records, so a failed handshake closes with nothing
 * unread and the peer gets a FIN. Closing with the rest of, say, an HTTP
 * request still queued would make the kernel send a reset instead. */
static void scr_tls_drain_unread(ScrTlsSock *t) {
  int fd = scr_net_sock_fd(t->sock);
  if (fd < 0) return;
  unsigned char sink[4096];
  for (size_t total = 0; total < 65536; ) {
    ssize_t n = read(fd, sink, sizeof sink);
    if (n <= 0) break;
    total += (size_t)n;
  }
}

/* ── the transport ops ───────────────────────────────────────────────── */

static void scr_tls_fire_session(ScrTlsSock *t);

static ssize_t scr_tls_xread(void *tctx, char *buf, size_t n) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  for (;;) {
    int r = mbedtls_ssl_read(&t->ssl, (unsigned char *)buf, n);
    if (r > 0) return r;
    if (r == 0 || r == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || r == MBEDTLS_ERR_SSL_CONN_EOF) {
      return 0; /* orderly (or abrupt-but-quiet) EOF — Node's 'end' either way */
    }
#if defined(MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET)
    if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) {
      /* a 1.3 ticket, not app data: the client 'session' event's moment */
      if (!scr_exc_pending()) scr_tls_fire_session(t);
      continue;
    }
#endif
    if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) {
      errno = EAGAIN;
      return -1;
    }
    if (t->alert_reported) return 0; /* the server closing after its alert */
    /* a TLS 1.3 server rejects a missing client certificate after the
     * client finished its handshake */
    if (r == MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE && t->cli != NULL &&
        t->ssl.MBEDTLS_PRIVATE(in_msg) != NULL && scr_tls_alert_error(t, t->ssl.MBEDTLS_PRIVATE(in_msg)[1])) {
      errno = EAGAIN;
      return -1;
    }
    errno = ECONNRESET; /* protocol-level death reads as a reset */
    return -1;
  }
}

static ssize_t scr_tls_xwrite(void *tctx, const char *buf, size_t n) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  int r = mbedtls_ssl_write(&t->ssl, (const unsigned char *)buf, n);
  if (r >= 0) return r;
  if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) {
    errno = EAGAIN;
    return -1;
  }
  errno = EPIPE;
  return -1;
}

/* Node's message for the verify failures the local-CA flows can meet.
 * The split mirrors Node's openssl-error mapping: a self-signed LEAF is
 * "self-signed certificate"; a chain that carries its own (self-signed)
 * root is "self-signed certificate in certificate chain"; a chain whose
 * issuer never arrived is "unable to verify the first certificate". The
 * shape comes from the verify callback's records — the peer chain is
 * already gone once the handshake has failed. */
static void scr_tls_verify_msg(ScrTlsSock *t, char *out, size_t n) {
  if (t->vrfy_expired) {
    snprintf(out, n, "certificate has expired");
    return;
  }
  /* Node appends the --use-system-ca hint for exactly these two codes
   * (src/crypto/crypto_common.cc: DEPTH_ZERO_SELF_SIGNED_CERT and
   * UNABLE_TO_VERIFY_LEAF_SIGNATURE) — and NOT for the in-chain one. */
  static const char hint[] =
      "; if the root CA is installed locally, try running Node.js with --use-system-ca";
  if (t->vrfy_leaf_self) {
    snprintf(out, n, "self-signed certificate%s", hint);
    return;
  }
  if (t->vrfy_chain_self) {
    snprintf(out, n, "self-signed certificate in certificate chain");
    return;
  }
  /* the identity check only decides on a TRUSTED chain — Node's order
   * (checkServerIdentity runs after verification succeeds) */
  if (t->vrfy_cn_mismatch &&
      (mbedtls_ssl_get_verify_result(&t->ssl) & MBEDTLS_X509_BADCERT_NOT_TRUSTED) == 0) {
    snprintf(out, n, "Hostname/IP does not match certificate's altnames");
    return;
  }
  snprintf(out, n, "unable to verify the first certificate%s", hint);
}

/* ── the SNI pre-parse ────────────────────────────────────────────────
 * mbedTLS's f_sni must answer synchronously from inside the handshake,
 * but the JS SNICallback is asynchronous (per-hostname certs generate on
 * demand — the portless flow). So a callback-carrying server resolves
 * the name FIRST: it buffers the raw ClientHello flight off the socket,
 * parses the server_name extension itself, parks the handshake while the
 * JS callback decides, then replays the buffered bytes into the bio and
 * runs the real handshake — whose f_sni serves the answered context. */

/* The socket whose handshake this unit is driving — f_sni's route back
 * to the answered context (single-threaded runtime; set around
 * mbedtls_ssl_handshake). */
static SCR_TL ScrTlsSock *scr_tls_current = NULL;

/* Defined with the other transport ops below; the answer path needs the
 * table's identity to re-find its engine from the boxed socket. */
static const ScrNetTransportOps SCR_TLS_OPS;

static int scr_tls_f_sni(void *p, mbedtls_ssl_context *ssl, const unsigned char *name,
                          size_t len) {
  (void)p; (void)name; (void)len;
  ScrTlsSock *t = scr_tls_current;
  if (t != NULL && t->sni_ctx != NULL) {
    return mbedtls_ssl_set_hs_own_cert(ssl, &t->sni_ctx->cert, &t->sni_ctx->pk);
  }
  return 0; /* default cert (no answer / cb passed no context) */
}

/* The ClientHello body walk (past the 4-byte handshake header): version +
 * random, session id, cipher suites, compression, then the extension list
 * — server_name (type 0) holds one host_name (type 0) entry. Answers 1
 * with `out` set, 2 for a well-formed hello without SNI or anything
 * malformed (the real handshake will judge it). *offers12 answers whether
 * the hello offers TLS 1.2: true without a supported_versions extension
 * (type 43), else whether its list holds 0x0303. */
static int scr_tls_parse_ch_body(const unsigned char *b, size_t n, char *out, size_t out_cap,
                                 bool *offers12) {
  *offers12 = true;
  int found = 2;
  size_t i = 34; /* version(2) + random(32) */
  if (i + 1 > n) return 2;
  i += 1 + b[i]; /* session id: length byte + body */
  if (i + 2 > n) return 2;
  size_t cs = ((size_t)b[i] << 8) | b[i + 1];
  i += 2 + cs;
  if (i + 1 > n) return 2;
  i += 1 + b[i];
  if (i + 2 > n) return 2;
  size_t ext_total = ((size_t)b[i] << 8) | b[i + 1];
  i += 2;
  size_t end = i + ext_total <= n ? i + ext_total : n;
  while (i + 4 <= end) {
    size_t et = ((size_t)b[i] << 8) | b[i + 1];
    size_t el = ((size_t)b[i + 2] << 8) | b[i + 3];
    i += 4;
    if (i + el > end) return 2;
    if (et == 0 && found == 2) {
      /* server_name: list length(2), then entry type(1) + length(2) + name */
      if (el >= 5 && b[i + 2] == 0) {
        size_t nl = ((size_t)b[i + 3] << 8) | b[i + 4];
        if (nl > 0 && nl + 5 <= el && nl + 1 <= out_cap) {
          memcpy(out, b + i + 5, nl);
          out[nl] = 0;
          found = 1;
        }
      }
    } else if (et == 43 && el >= 1) {
      /* supported_versions: list length(1), then 2-byte versions */
      size_t vl = b[i] < el - 1 ? b[i] : el - 1;
      *offers12 = false;
      for (size_t v = 0; v + 1 < vl; v += 2) {
        if (b[i + 1 + v] == 0x03 && b[i + 2 + v] == 0x03) *offers12 = true;
      }
    }
    i += el;
  }
  return found;
}

/* Reassemble the handshake stream from the raw record flight and look for
 * the server_name extension. 0 = need more bytes; 1 = found (out set);
 * 2 = no SNI / not parseable (serve the default cert). */
static int scr_tls_parse_sni(const unsigned char *buf, size_t len, char *out, size_t out_cap,
                             bool *offers12) {
  *offers12 = true;
  unsigned char *hs = NULL;
  size_t hs_len = 0, hs_cap = 0;
  size_t off = 0;
  for (;;) {
    if (off + 5 > len) { free(hs); return 0; }
    if (buf[off] != 0x16) { free(hs); return 2; } /* not a handshake record */
    size_t rlen = ((size_t)buf[off + 3] << 8) | buf[off + 4];
    if (rlen == 0 || rlen > 16640) { free(hs); return 2; }
    if (off + 5 + rlen > len) { free(hs); return 0; }
    if (hs_len + rlen > hs_cap) {
      hs_cap = hs_cap ? hs_cap * 2 : 4096;
      while (hs_cap < hs_len + rlen) hs_cap *= 2;
      hs = realloc(hs, hs_cap);
      if (!hs) scr_tls_oom();
    }
    memcpy(hs + hs_len, buf + off + 5, rlen);
    hs_len += rlen;
    off += 5 + rlen;
    if (hs_len >= 4) {
      if (hs[0] != 0x01) { free(hs); return 2; } /* not a ClientHello */
      size_t chlen = ((size_t)hs[1] << 16) | ((size_t)hs[2] << 8) | hs[3];
      if (chlen > 131072) { free(hs); return 2; }
      if (hs_len >= 4 + chlen) {
        int r = scr_tls_parse_ch_body(hs + 4, chlen, out, out_cap, offers12);
        free(hs);
        return r;
      }
    }
  }
}

/* Hand the buffered flight back: the bio reads it ahead of the kernel. */
static void scr_tls_sni_replay(ScrTlsSock *t) {
  if (t->hello_len > 0) {
    scr_net_sock_replay(t->sock, (const char *)t->hello, t->hello_len);
  }
  free(t->hello);
  t->hello = NULL;
  t->hello_len = t->hello_cap = 0;
}

/* The COLLECT step: buffer what the socket has, decide, invoke the JS
 * callback. Answers like the transport handshake contract: 1 = proceed
 * to the real handshake, 0 = parked (more bytes, or the callback is
 * deciding), -1 = the socket died (already torn down). */
static int scr_tls_sni_collect(ScrTlsSock *t) {
  char servername[256];
  for (;;) {
    if (t->hello_len > 0) {
      bool offers12;
      int r = scr_tls_parse_sni(t->hello, t->hello_len, servername, sizeof servername, &offers12);
      if (r != 0 && t->srv->max_tls12 && !offers12) {
        /* A TLS 1.2 server and a hello offering only later versions:
         * OpenSSL answers with a fatal protocol_version alert, which the
         * client reports as ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION. */
        static const unsigned char alert[] = { 0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x46 };
        int fd = scr_net_sock_fd(t->sock);
        if (fd >= 0) (void)!write(fd, alert, sizeof alert);
        scr_net_sock_transport_error(t->sock, NULL);
        return -1;
      }
      if (r == 2 || t->hello_len > 65536 || (r == 1 && t->srv->sni_cb == NULL)) {
        /* no SNI (or unparseable): skip the callback, serve the default
         * pair — Node's SNICallback never fires without a server_name */
        t->sni_state = SCR_SNI_DONE;
        scr_tls_sni_replay(t);
        return 1;
      }
      if (r == 1) {
        t->sni_state = SCR_SNI_WAIT;
        ScrClosure *cb = scr_closure_retain(t->srv->sni_cb);
        ScrClosure *ans = scr_closure_new(t->srv->sni_answer_fn, 1);
        ScrBox *box = scr_box_new_obj(scr_net_sock_retain_v, scr_net_sock_release_v, NULL);
        scr_box_set_ref(box, scr_net_sock_retain(t->sock));
        ans->caps[0] = box;
        ScrStr *name = scr_str_new(servername, strlen(servername));
        /* the callback owns its +1 params per the universal convention */
        ((void (*)(ScrClosure *, ScrStr *, ScrClosure *))cb->fn)(cb, name, ans);
        scr_closure_release(cb);
        if (scr_net_sock_fd(t->sock) < 0) return -1; /* a sync cb(err) tore it down */
        if (t->sni_state == SCR_SNI_WAIT) return 0;   /* asynchronous answer */
        return 1; /* a synchronous answer already replayed the flight */
      }
    }
    /* need more bytes: buffered (unshifted demux peeks) first, then the fd */
    if (t->hello_len + 4096 > t->hello_cap) {
      t->hello_cap = t->hello_cap ? t->hello_cap * 2 : 8192;
      t->hello = realloc(t->hello, t->hello_cap);
      if (!t->hello) scr_tls_oom();
    }
    size_t room = t->hello_cap - t->hello_len;
    size_t took = scr_net_sock_take_buffered(t->sock, (char *)t->hello + t->hello_len, room);
    if (took == 0) {
      int fd = scr_net_sock_fd(t->sock);
      if (fd < 0) return -1;
      ssize_t n = read(fd, t->hello + t->hello_len, room);
      if (n < 0) {
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0; /* readiness re-drives */
        scr_net_sock_transport_error(t->sock, NULL);
        return -1;
      }
      if (n == 0) { /* the peer died mid-hello: server-side teardown without an error event */
        scr_net_sock_transport_error(t->sock, NULL);
        return -1;
      }
      took = (size_t)n;
    }
    t->hello_len += took;
  }
}

/* The answer closure's runtime half (its fn is the emitted per-shape
 * thunk; caps[0] boxes the socket). Late, repeated, or dead-socket
 * answers are ignored — the first answer decides, like Node. */
void scr_tls_sni_answer(ScrClosure *self, bool has_err, ScrSecureCtx *ctx /*moves, nullable*/) {
  ScrNetSocket *sock = (ScrNetSocket *)scr_box_get_ref(self->caps[0]);
  ScrTlsSock *t =
      sock != NULL ? (ScrTlsSock *)scr_net_sock_transport_ctx_for(sock, &SCR_TLS_OPS) : NULL;
  if (t == NULL || t->sni_state != SCR_SNI_WAIT) {
    scr_secure_ctx_release(ctx);
    scr_net_sock_release(sock);
    return;
  }
  t->sni_state = SCR_SNI_DONE;
  if (has_err) {
    /* Node destroys the socket ('tlsClientError'; nothing is reported with
     * no listener — what portless observes). */
    scr_secure_ctx_release(ctx);
    free(t->hello);
    t->hello = NULL;
    t->hello_len = t->hello_cap = 0;
    scr_net_sock_transport_error(t->sock, NULL);
    scr_net_sock_release(sock);
    return;
  }
  t->sni_ctx = ctx; /* moves; NULL = the default pair */
  scr_tls_sni_replay(t);
  /* An asynchronous answer must re-drive the parked handshake itself —
   * the client is waiting for the ServerHello, so no readiness comes. A
   * SYNCHRONOUS answer (cache hit) returns into the running collect
   * step, which proceeds directly. */
  if (!t->in_handshake) scr_net_sock_transport_resume(sock);
  scr_net_sock_release(sock);
}

/* A wrapped server socket's failed handshake, reported as Node reports it
 * on the TLSSocket: a peer that closed first ends the stream, a reset is
 * ECONNRESET, and bytes that are not a TLS record name what they were
 * (OpenSSL's reasons without the per-process prefix and source location,
 * SEMANTICS.md divergence 55). */
/* The OpenSSL reason (without its per-process prefix and source location,
 * SEMANTICS.md divergence 55) and Node's code for a server handshake that
 * failed with mbedTLS error `r`; false when the peer closed or reset the
 * connection instead. A failure mbedTLS reports without a reason OpenSSL
 * would give answers a coded SC2020 refusal. */
static bool scr_tls_server_reason(ScrTlsSock *t, int r, const char **msg, const char **code) {
  if (r == MBEDTLS_ERR_SSL_CONN_EOF || r == MBEDTLS_ERR_NET_CONN_RESET) return false;
  if (r == MBEDTLS_ERR_SSL_NO_CLIENT_CERTIFICATE) {
    *msg = "error:0A0000C7:SSL routines:tls_process_client_certificate:peer did not return a certificate";
    *code = "ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE";
    return true;
  }
  const unsigned char *h = t->head;
  bool record = t->head_len >= 3 && h[0] >= 20 && h[0] <= 23 && h[1] == 3;
  if (t->head_len >= 5 && !record) {
    static const char *const http[] = { "GET ", "POST ", "HEAD ", "PATCH", "OPTIO",
                                        "DELET", "TRACE", "PUT ", NULL };
    *msg = "error:0A00010B:SSL routines:tls_validate_record_header:wrong version number";
    *code = "ERR_SSL_WRONG_VERSION_NUMBER";
    for (size_t i = 0; http[i] != NULL; i++) {
      if (memcmp(h, http[i], strlen(http[i])) == 0) {
        *msg = "error:0A00009C:SSL routines:tls_validate_record_header:http request";
        *code = "ERR_SSL_HTTP_REQUEST";
      }
    }
    if (memcmp(h, "CONNE", 5) == 0) {
      *msg = "error:0A00009B:SSL routines:tls_validate_record_header:https proxy request";
      *code = "ERR_SSL_HTTPS_PROXY_REQUEST";
    }
    return true;
  }
  if (r == MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE && t->ssl.MBEDTLS_PRIVATE(in_msg) != NULL) {
    /* an alert the client sent: OpenSSL's reason is 1000 + its number */
    static const struct { unsigned char alert; const char *msg, *code; } alerts[] = {
      { 40, "error:0A000410:SSL routines:ssl3_read_bytes:ssl/tls alert handshake failure",
        "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE" },
      { 42, "error:0A000412:SSL routines:ssl3_read_bytes:sslv3 alert bad certificate",
        "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE" },
      { 45, "error:0A000415:SSL routines:ssl3_read_bytes:sslv3 alert certificate expired",
        "ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED" },
      { 46, "error:0A000416:SSL routines:ssl3_read_bytes:sslv3 alert certificate unknown",
        "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN" },
      { 48, "error:0A000418:SSL routines:ssl3_read_bytes:tlsv1 alert unknown ca",
        "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA" },
      { 49, "error:0A000419:SSL routines:ssl3_read_bytes:tlsv1 alert access denied",
        "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED" },
      { 51, "error:0A00041B:SSL routines:ssl3_read_bytes:tlsv1 alert decrypt error",
        "ERR_SSL_TLSV1_ALERT_DECRYPT_ERROR" },
      { 70, "error:0A00042E:SSL routines:ssl3_read_bytes:tlsv1 alert protocol version",
        "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION" },
      { 80, "error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error",
        "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" },
    };
    unsigned char alert = t->ssl.MBEDTLS_PRIVATE(in_msg)[1];
    for (size_t i = 0; i < sizeof alerts / sizeof alerts[0]; i++) {
      if (alerts[i].alert == alert) {
        *msg = alerts[i].msg;
        *code = alerts[i].code;
        return true;
      }
    }
  }
  if (r == MBEDTLS_ERR_SSL_BAD_PROTOCOL_VERSION) {
    *msg = "error:0A000102:SSL routines:tls_early_post_process_client_hello:unsupported protocol";
    *code = "ERR_SSL_UNSUPPORTED_PROTOCOL";
    return true;
  }
  if (r == MBEDTLS_ERR_SSL_NO_APPLICATION_PROTOCOL) {
    *msg = "error:0A0000EB:SSL routines:tls_handle_alpn:no application protocol";
    *code = "ERR_SSL_NO_APPLICATION_PROTOCOL";
    return true;
  }
  static SCR_TL char refusal[128];
  snprintf(refusal, sizeof refusal,
           "a TLS handshake failure (mbedTLS error -0x%04X) without the reason OpenSSL gives is not supported yet",
           (unsigned)-r);
  *msg = refusal;
  *code = "SC2020";
  return true;
}

/* 'tlsClientError' on the accepting server: Node's Error with `code`, and
 * the socket. Without a listener the socket is only destroyed. */
static void scr_tls_client_error(ScrTlsSock *t, const char *msg, const char *code) {
  if (t->server == NULL) return;
  ScrStr *m = scr_str_new(msg, strlen(msg));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, m);
  scr_str_release(m);
  scr_error_set_code(e, code);
  scr_net_server_fire_client_error(t->server, e, t->sock);
  scr_error_release(e);
}

static void scr_tls_wrapped_failure(ScrTlsSock *t, int r) {
  if (r == MBEDTLS_ERR_SSL_CONN_EOF) {
    scr_net_sock_transport_eof(t->sock);
    return;
  }
  if (r == MBEDTLS_ERR_NET_CONN_RESET) {
    scr_net_sock_transport_error(t->sock, "read ECONNRESET");
    return;
  }
  const char *msg, *code;
  (void)scr_tls_server_reason(t, r, &msg, &code);
  scr_net_sock_transport_error_code(t->sock, msg, code);
}

/* A fatal alert a server sends a client without the certificate it
 * requires: the client's error is OpenSSL's reason (without its
 * per-process prefix and source location, SEMANTICS.md divergence 55) and
 * Node's code. False for other alerts. */
static bool scr_tls_alert_error(ScrTlsSock *t, unsigned char alert) {
  if (alert == MBEDTLS_SSL_ALERT_MSG_CERT_REQUIRED) {
    /* after the client's handshake: Node emits 'error' and the socket
     * then ends when the server closes, with close(false) */
    scr_net_sock_transport_report(t->sock,
                                  "error:0A00045C:SSL routines:ssl3_read_bytes:tlsv13 alert certificate required",
                                  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED");
    t->alert_reported = true;
    return true;
  }
  if (alert == MBEDTLS_SSL_ALERT_MSG_HANDSHAKE_FAILURE) {
    scr_net_sock_transport_error_code(t->sock,
                                      "error:0A000410:SSL routines:ssl3_read_bytes:ssl/tls alert handshake failure",
                                      "ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE");
    return true;
  }
  return false;
}

/* A server that requires a client certificate (requestCert with
 * rejectUnauthorized) runs its handshake a step at a time, so a client
 * that sends none fails as soon as its empty Certificate is read, before
 * the server's Finished in TLS 1.2, with OpenSSL's alert: certificate
 * required in TLS 1.3, handshake failure in TLS 1.2. */
static int scr_tls_handshake_requiring_cert(ScrTlsSock *t) {
  while (!mbedtls_ssl_is_handshake_over(&t->ssl)) {
    int r = mbedtls_ssl_handshake_step(&t->ssl);
    if (r != 0) return r;
    if (t->cert_missing) continue;
    /* all ones until the client's Certificate is read */
    uint32_t verdict = mbedtls_ssl_get_verify_result(&t->ssl);
    if (verdict == UINT32_MAX || !(verdict & MBEDTLS_X509_BADCERT_MISSING)) continue;
    if (mbedtls_ssl_get_version_number(&t->ssl) != MBEDTLS_SSL_VERSION_TLS1_3) {
      (void)mbedtls_ssl_send_alert_message(&t->ssl, MBEDTLS_SSL_ALERT_LEVEL_FATAL,
                                           MBEDTLS_SSL_ALERT_MSG_HANDSHAKE_FAILURE);
      return MBEDTLS_ERR_SSL_NO_CLIENT_CERTIFICATE;
    }
    /* TLS 1.3: the client has finished and reads under the server's
     * application keys, which mbedTLS writes with only once the handshake
     * is over, so the alert waits for that */
    t->cert_missing = true;
  }
  if (t->cert_missing) {
    (void)mbedtls_ssl_send_alert_message(&t->ssl, MBEDTLS_SSL_ALERT_LEVEL_FATAL,
                                         MBEDTLS_SSL_ALERT_MSG_CERT_REQUIRED);
    return MBEDTLS_ERR_SSL_NO_CLIENT_CERTIFICATE;
  }
  return 0;
}

static ScrTlsSock *scr_tls_sock_of(ScrNetSocket *s);

/* The immediate that ends the hold: queued as the handshake finishes,
 * before the established callbacks run, so it comes ahead of any
 * immediate they queue. A socket destroyed by then has no fd, and what
 * was held is dropped. */
static void scr_tls_release_hold(ScrClosure *self) {
  ScrNetSocket *s = scr_box_get_ref(self->caps[0]); /* +1 */
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t != NULL && t->holding) {
    t->holding = false;
    if (t->held_len > t->held_off) (void)scr_tls_flush_held(t);
  }
  scr_net_sock_release(s);
}

static void scr_tls_hold_until_immediate(ScrTlsSock *t) {
  ScrClosure *cb = scr_closure_new((void *)&scr_tls_release_hold, 1);
  cb->caps[0] = scr_box_new_obj(&scr_net_sock_retain_v, &scr_net_sock_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_net_sock_retain(t->sock));
  (void)scr_set_immediate(cb);
}

static int scr_tls_handshake(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  if (t->cli != NULL && t->cli->no_protocols) {
    /* OpenSSL's reason without its per-process prefix (SEMANTICS.md
     * divergence 55); scr_error_message_code gives Node's code. */
    scr_net_sock_transport_error(t->sock, "error:0A0000BF:SSL routines::no protocols available");
    return -1;
  }
  if (t->sni_state == SCR_SNI_COLLECT) {
    t->in_handshake = true;
    int c = scr_tls_sni_collect(t);
    t->in_handshake = false;
    if (c <= 0) return c;
  }
  if (t->sni_state == SCR_SNI_WAIT) return 0; /* the callback is deciding */
  scr_tls_current = t;
  t->holding = true;
  int r = t->srv != NULL && t->srv->request_cert && t->srv->reject_unauthorized
              ? scr_tls_handshake_requiring_cert(t)
              : mbedtls_ssl_handshake(&t->ssl);
  scr_tls_current = NULL;
  if (r == 0) {
    scr_tls_hold_until_immediate(t);
  } else {
    /* a step that did not finish the handshake sends what it wrote now */
    t->holding = false;
    if (t->held_len > t->held_off) (void)scr_tls_flush_held(t);
  }
  if (r == 0 && t->srv != NULL && t->srv->request_cert && t->srv->reject_unauthorized &&
      !t->srv->standalone && mbedtls_ssl_get_verify_result(&t->ssl) != 0) {
    /* a client certificate that fails verification: Node's server
     * destroys the socket before 'secureConnection', and its
     * 'tlsClientError' is the hang-up */
    scr_net_sock_transport_error(t->sock, NULL);
    t->hang_up_pending = true;
    return -1;
  }
  if (r == 0) return 1;
  if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return 0;
  if (t->srv != NULL && t->wrapped) {
    scr_tls_wrapped_failure(t, r);
    return -1;
  }
  if (t->srv != NULL) {
    /* the socket is destroyed without an error event, and the server's
     * 'tlsClientError' gets the failure: now, before the socket closes,
     * for an OpenSSL reason; once it closes for a hang-up, as Node
     * emits ECONNRESET from the socket's 'close' */
    const char *msg, *code;
    bool reason = scr_tls_server_reason(t, r, &msg, &code);
    /* Node's socket still has its handle when an OpenSSL reason is
     * emitted, so remoteAddress answers; the address is cached before
     * the fd closes */
    if (reason) scr_str_release(scr_net_sock_remote_address(t->sock));
    scr_tls_drain_unread(t);
    scr_net_sock_transport_error(t->sock, NULL);
    if (reason) scr_tls_client_error(t, msg, code);
    else t->hang_up_pending = true;
    return -1;
  }
  char msg[160];
  if (r == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED) {
    scr_tls_verify_msg(t, msg, sizeof msg);
  } else if (r == MBEDTLS_ERR_SSL_CONN_EOF) {
    /* The peer closed the connection mid-handshake: Node's socket ends,
     * then fails with ECONNRESET, for tls.connect and https.request
     * alike. */
    scr_net_sock_transport_ended(t->sock);
    if (scr_exc_pending()) return -1;
    scr_net_sock_transport_error(
        t->sock, "Client network socket disconnected before secure TLS connection was established");
    return -1;
  } else if (r == MBEDTLS_ERR_NET_CONN_RESET) {
    /* a reset is the read's own error, as in Node */
    scr_net_sock_transport_error(t->sock, "read ECONNRESET");
    return -1;
  } else if (r == MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE &&
             t->ssl.MBEDTLS_PRIVATE(in_msg) != NULL &&
             t->ssl.MBEDTLS_PRIVATE(in_msg)[1] == MBEDTLS_SSL_ALERT_MSG_NO_APPLICATION_PROTOCOL) {
    /* The server shares none of the ALPNProtocols: OpenSSL's reason, which
     * Node reports as ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL
     * (scr_error_message_code), without its per-process prefix and source
     * location (SEMANTICS.md divergence 55). */
    snprintf(msg, sizeof msg,
             "error:0A000460:SSL routines:ssl3_read_bytes:tlsv1 alert no application protocol");
  } else if (r == MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE &&
             t->ssl.MBEDTLS_PRIVATE(in_msg) != NULL &&
             t->ssl.MBEDTLS_PRIVATE(in_msg)[1] == MBEDTLS_SSL_ALERT_MSG_PROTOCOL_VERSION) {
    /* The server accepts none of the offered versions. */
    snprintf(msg, sizeof msg, "error:0A00042E:SSL routines:ssl3_read_bytes:tlsv1 alert protocol version");
  } else if (r == MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE && t->ssl.MBEDTLS_PRIVATE(in_msg) != NULL &&
             scr_tls_alert_error(t, t->ssl.MBEDTLS_PRIVATE(in_msg)[1])) {
    return -1;
  } else {
    /* non-verify handshake failures: honest but not Node's exact openssl
     * string (SEMANTICS.md divergence 55) */
    snprintf(msg, sizeof msg, "client TLS handshake failed");
  }
  scr_net_sock_transport_error(t->sock, msg);
  return -1;
}

static void scr_tls_on_established(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  t->established = true;
  if (t->cli != NULL) scr_tls_fire_session(t); /* the 1.2 arm; 1.3 fires on ticket receipt */
  if (t->srv != NULL && t->srv->h2_conn != NULL) {
    /* the h2 secure server: dispatch on the NEGOTIATED protocol — the
     * h2 session attaches as the socket's native reader (it reads
     * plaintext through this transport, exactly like the https parser);
     * an http/1.1 answer routes to the wrapped parser when one exists;
     * a client that answered nothing tears down (Node parks it as
     * 'unknownProtocol' and destroys at the timeout — this surface
     * destroys now; SEMANTICS.md). */
    const char *alpn = mbedtls_ssl_get_alpn_protocol(&t->ssl);
    if (alpn != NULL && strcmp(alpn, "h2") == 0) {
      t->srv->h2_conn(t->srv->h2_ctx, t->sock);
    } else if (t->srv->inner_conn != NULL &&
               (alpn == NULL || strcmp(alpn, "http/1.1") == 0)) {
      t->srv->inner_conn(t->srv->inner_ctx, t->sock);
    } else {
      scr_net_sock_transport_error(t->sock, NULL);
    }
    return;
  }
  if (t->srv != NULL && t->srv->inner_conn != NULL) {
    /* https: the http parser attaches now, over plaintext only */
    t->srv->inner_conn(t->srv->inner_ctx, t->sock);
  }
}

static bool scr_tls_pending(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  return mbedtls_ssl_check_pending(&t->ssl) != 0 ||
         mbedtls_ssl_get_bytes_avail(&t->ssl) > 0;
}

static void scr_tls_shutdown_write(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  if (t->notify_sent) return;
  t->notify_sent = true;
  /* end() sends what is held, then the close_notify, ahead of the FIN */
  t->holding = false;
  if (t->held_len > t->held_off) (void)scr_tls_flush_held(t);
  (void)mbedtls_ssl_close_notify(&t->ssl); /* best effort; EAGAIN drops it */
}

static void scr_tls_free(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  mbedtls_ssl_free(&t->ssl);
  if (t->srv) scr_tls_srv_release(t->srv);
  if (t->cli) scr_tls_cli_free(t->cli);
  scr_net_ls_drop(&t->session_ls);
  scr_net_ls_drop(&t->secure_ls);
  free(t->hello);
  scr_secure_ctx_release(t->sni_ctx);
  mbedtls_x509_crt_free(&t->served_chain);
  if (t->server) scr_net_server_release(t->server);
  free(t->held);
  free(t);
}

/* The fd is writable again: the rest of what was held goes out. */
static void scr_tls_drain(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  if (!t->holding && t->held_len > t->held_off) (void)scr_tls_flush_held(t);
}

/* The 'secure' event: after a client's secureConnect listeners, as Node
 * emits it. */
static void scr_tls_after_established(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  scr_net_fire0_this(&t->secure_ls, t->sock, SCR_DYNH_NET_SOCKET);
  scr_net_ls_drop(&t->secure_ls);
}

/* The closed socket settles: its 'secure' and 'session' listeners can no
 * longer fire, and a listener that captures the socket would otherwise
 * keep it, and this transport, alive (a handshake that fails never fires
 * 'secure'). */
static void scr_tls_settle(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  t->settled = true;
  scr_net_ls_drop(&t->secure_ls);
  scr_net_ls_drop(&t->session_ls);
  if (t->hang_up_pending) {
    t->hang_up_pending = false;
    scr_tls_client_error(t, "socket hang up", "ECONNRESET");
  }
}

static const ScrNetTransportOps SCR_TLS_OPS = {
  .xread = scr_tls_xread,
  .xwrite = scr_tls_xwrite,
  .handshake = scr_tls_handshake,
  .on_established = scr_tls_on_established,
  .pending = scr_tls_pending,
  .shutdown_write = scr_tls_shutdown_write,
  .free = scr_tls_free,
  .settle = scr_tls_settle,
  .after_established = scr_tls_after_established,
  .drain = scr_tls_drain,
};

/* ── the server surface ──────────────────────────────────────────────── */

/* The server's native-connection hook: one TLS engine per accepted
 * socket; the deferred 'connection' fires from the net pump once the
 * handshake stands. */
static void scr_tls_srv_on_conn(void *ctx, ScrNetSocket *sock) {
  ScrTlsSrv *srv = (ScrTlsSrv *)ctx;
  ScrTlsSock *t = calloc(1, sizeof *t);
  if (!t) scr_tls_oom();
  mbedtls_ssl_init(&t->ssl);
  if (mbedtls_ssl_setup(&t->ssl, &srv->conf) != 0) scr_tls_oom();
  if (srv->request_cert) mbedtls_ssl_set_verify(&t->ssl, &scr_tls_vrfy_cb, t);
  t->sock = sock;
  t->srv = scr_tls_srv_retain(srv);
  ScrNetServer *server = scr_net_sock_server(sock);
  t->server = server != NULL ? scr_net_server_retain(server) : NULL;
  if (srv->sni_cb != NULL || srv->max_tls12) t->sni_state = SCR_SNI_COLLECT; /* pre-parse the hello */
  mbedtls_ssl_set_bio(&t->ssl, t, scr_tls_bio_send, scr_tls_bio_recv, NULL);
  scr_net_sock_set_transport(sock, &SCR_TLS_OPS, t);
}

static ScrNetServer *scr_tls_create_server_alpn(const char *cert, size_t cert_len,
                                                const char *key, size_t key_len,
                                                ScrClosure *handler /*moves, nullable*/,
                                                ScrNetConnFn fn, char **alpn /*moves, nullable*/,
                                                int min_version, int max_version,
                                                ScrClosure *sni_cb /*moves, nullable*/,
                                                void *sni_answer_fn,
                                                const ScrTlsClientAuth *auth /*nullable*/) {
  ScrTlsSrv *srv = scr_tls_srv_new(cert, cert_len, key, key_len, false);
  scr_tls_srv_client_auth(srv, auth);
  if (sni_cb != NULL) {
    srv->sni_cb = sni_cb; /* moves; released with srv */
    srv->sni_answer_fn = sni_answer_fn;
    mbedtls_ssl_conf_sni(&srv->conf, &scr_tls_f_sni, NULL);
  }
  srv->max_tls12 = max_version == 12;
  if (!scr_tls_conf_versions(&srv->conf, min_version, max_version)) {
    /* Node's server then fails every handshake; nothing here models
     * that, so it stays a refusal. */
    scr_tls_srv_release(srv);
    scr_closure_release(handler);
    scr_tls_alpn_free(alpn);
    scr_tls_opt_fence("tls.createServer", "maxVersion",
                      "a version range with neither TLSv1.2 nor TLSv1.3 has no lowering");
    return NULL;
  }
  if (alpn != NULL) {
    /* mbedTLS picks the first of these the client offers (Node's server
     * preference) and sends no_application_protocol when it offers none. */
    srv->alpn = alpn;
    mbedtls_ssl_conf_alpn_protocols(&srv->conf, (const char **)srv->alpn);
  }
  ScrNetServer *s = scr_net_create_server(handler, fn);
  scr_net_server_set_native_conn(s, &scr_tls_srv_on_conn, srv, &scr_tls_srv_release_v);
  scr_net_server_defer_connections(s); /* the handler is 'secureConnection' */
  return s;
}

ScrNetServer *scr_tls_create_server(const char *cert, size_t cert_len, const char *key,
                                     size_t key_len, ScrClosure *handler /*moves, nullable*/,
                                     ScrNetConnFn fn) {
  return scr_tls_create_server_alpn(cert, cert_len, key, key_len, handler, fn, NULL, 12, 13, NULL,
                                    NULL, NULL);
}

/* tls.createServer({ cert, key, SNICallback }): the pre-parse machinery
 * (design note atop the SNI section) hands each ClientHello's servername
 * to the callback and serves the context it answers, or the default pair
 * for none. A NULL sni_cb (the callback union's undefined arm) is
 * scr_tls_create_server. */
ScrNetServer *scr_tls_create_server_sni(const char *cert, size_t cert_len, const char *key,
                                         size_t key_len, ScrClosure *handler /*moves, nullable*/,
                                         ScrNetConnFn fn, ScrClosure *sni_cb /*moves, nullable*/,
                                         void *sni_answer_fn) {
  return scr_tls_create_server_alpn(cert, cert_len, key, key_len, handler, fn, NULL, 12, 13, sni_cb,
                                    sni_answer_fn, NULL);
}

static ScrNetServer *scr_https_create_server_auth(const char *cert, size_t cert_len, const char *key,
                                                  size_t key_len, ScrClosure *handler /*moves*/,
                                                  ScrHttpReqFn fn, const ScrTlsClientAuth *auth /*nullable*/) {
  ScrNetServer *s = scr_http_create_server(handler, fn);
  ScrTlsSrv *srv = scr_tls_srv_new(cert, cert_len, key, key_len, true /* ALPN http/1.1 */);
  scr_tls_srv_client_auth(srv, auth);
  /* wrap the parser hook: TLS first, parser at establishment */
  scr_net_server_get_native_conn(s, &srv->inner_conn, &srv->inner_ctx, &srv->inner_ctx_free);
  scr_net_server_set_native_conn(s, &scr_tls_srv_on_conn, srv, &scr_tls_srv_release_v);
  scr_net_server_defer_connections(s);
  return s;
}

ScrNetServer *scr_https_create_server(const char *cert, size_t cert_len, const char *key,
                                       size_t key_len, ScrClosure *handler /*moves*/,
                                       ScrHttpReqFn fn) {
  return scr_https_create_server_auth(cert, cert_len, key, key_len, handler, fn, NULL);
}

/* The SNI-callback form of the allowHTTP1 compatibility server: the same
 * handler-less https server, plus the pre-parse machinery (design note
 * atop the SNI section). A NULL sni_cb — the conditional spread's
 * undefined arm — is exactly scr_https_create_server(…, NULL, NULL). */
ScrNetServer *scr_https_create_server_sni(const char *cert, size_t cert_len, const char *key,
                                           size_t key_len, ScrClosure *sni_cb /*moves, nullable*/,
                                           void *answer_fn) {
  ScrNetServer *s = scr_http_create_server(NULL, NULL);
  ScrTlsSrv *srv = scr_tls_srv_new(cert, cert_len, key, key_len, true /* ALPN http/1.1 */);
  if (sni_cb != NULL) {
    srv->sni_cb = sni_cb; /* moves */
    srv->sni_answer_fn = answer_fn;
    mbedtls_ssl_conf_sni(&srv->conf, &scr_tls_f_sni, NULL);
  }
  scr_net_server_get_native_conn(s, &srv->inner_conn, &srv->inner_ctx, &srv->inner_ctx_free);
  scr_net_server_set_native_conn(s, &scr_tls_srv_on_conn, srv, &scr_tls_srv_release_v);
  scr_net_server_defer_connections(s);
  return s;
}

/* ── the client surface (https.request) ──────────────────────────────── */

static void scr_tls_cli_wrap(ScrNetSocket *sock, void *ctx) {
  ScrTlsCli *cli = (ScrTlsCli *)ctx;
  ScrTlsSock *t = calloc(1, sizeof *t);
  if (!t) scr_tls_oom();
  mbedtls_ssl_init(&t->ssl);
  if (mbedtls_ssl_setup(&t->ssl, &cli->conf) != 0) scr_tls_oom();
  /* NULL sends no SNI and skips mbedTLS's name check; the verify callback
   * checks cli->verify_name instead */
  (void)mbedtls_ssl_set_hostname(&t->ssl, cli->hostname);
  mbedtls_ssl_set_verify(&t->ssl, &scr_tls_vrfy_cb, t);
  t->sock = sock;
  t->cli = cli; /* the tctx owns the per-request config now */
  mbedtls_ssl_set_bio(&t->ssl, t, scr_tls_bio_send, scr_tls_bio_recv, NULL);
  scr_net_sock_set_transport(sock, &SCR_TLS_OPS, t);
}

/* The fetch unit's https leg: the same per-request client config +
 * transport wrap https.request uses, split apart because fetch dials a
 * RESOLVED IP while SNI and certificate verification must see the URL
 * hostname. The ctx moves into the socket's transport at wrap time. */
void *scr_tls_fetch_client_ctx(ScrStr *host /*borrowed*/, bool reject_unauthorized) {
  return scr_tls_cli_new(host, reject_unauthorized, NULL, 0);
}

void scr_tls_fetch_client_wrap(ScrNetSocket *sock, void *ctx) {
  scr_tls_cli_wrap(sock, ctx);
}

/* https.request's `servername` option: the request's lowering stores it
 * just before the construction call, which takes it (+1, NULL = none). */
static SCR_TL ScrStr *scr_https_next_servername = NULL;

void scr_https_set_next_servername(ScrStr *name /*borrowed*/) {
  scr_str_release(scr_https_next_servername);
  scr_https_next_servername = scr_str_retain(name);
}

static ScrStr *scr_https_take_servername(void) {
  ScrStr *name = scr_https_next_servername;
  scr_https_next_servername = NULL;
  return name;
}

/* The client config with the servername (when given) as the name the
 * handshake sends and verifies, in place of the host. "" sends no SNI,
 * and the certificate is still checked against the host, as Node's
 * checkServerIdentity does. */
static ScrTlsCli *scr_tls_cli_for(ScrStr *host, bool reject_unauthorized, const char *ca,
                                  size_t ca_len, const ScrStr *servername) {
  ScrTlsCli *cli = scr_tls_cli_new(host, reject_unauthorized, ca, ca_len);
  if (servername != NULL) scr_tls_cli_set_servername(cli, servername);
  return cli;
}

/* The TLS options a pooled https socket was set up with: an agent reuses
 * the socket only for a request with the same verification settings and
 * servername, as Node's https getName keys them (a servername that is
 * empty or equal to the host keys like none). +1. */
static ScrStr *scr_tls_pool_key(ScrStr *host, bool reject_unauthorized, const char *ca,
                                size_t ca_len, ScrStr *servername) {
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < ca_len; i++) h = (h ^ (unsigned char)ca[i]) * 1099511628211ull;
  char buf[64];
  int n = snprintf(buf, sizeof buf, "%d:%s%zu:%016llx:", reject_unauthorized ? 1 : 0,
                   ca != NULL ? "" : "-", ca_len, (unsigned long long)h);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_write(&b, buf, (size_t)n);
  if (servername != NULL && servername->len > 0 && !scr_str_eq(servername, host)) {
    scr_jb_putc(&b, 's');
    scr_jb_write(&b, servername->data, servername->len);
  }
  return scr_jb_finish(&b);
}

/* ── the fetch tunnel through an https:// proxy ───────────────────────
 * One transport carries three stages over the proxy socket: the TLS
 * session to the proxy (verified against the proxy host), the CONNECT
 * exchange inside it, then the target's TLS session (verified against
 * the target host) inside the tunnel. An http:// target uses the
 * tunnel's plaintext directly. */

enum { SCR_TUN_OUTER = 0, SCR_TUN_SEND, SCR_TUN_HEAD, SCR_TUN_INNER, SCR_TUN_UP };

typedef struct {
  ScrTlsSock *outer; /* the session to the proxy */
  ScrTlsSock *inner; /* the session to the target; NULL for http:// */
  int stage;
  char *req; /* the CONNECT head */
  size_t req_len, req_off;
  char *head; /* the proxy's response head as it arrives */
  size_t head_len;
  char *extra; /* tunnel bytes that arrived with the response head */
  size_t extra_len, extra_off;
} ScrTlsTunnel;

static ScrTlsSock *scr_tls_cli_sock(ScrNetSocket *sock, ScrTlsCli *cli) {
  ScrTlsSock *t = calloc(1, sizeof *t);
  if (!t) scr_tls_oom();
  mbedtls_ssl_init(&t->ssl);
  if (mbedtls_ssl_setup(&t->ssl, &cli->conf) != 0) scr_tls_oom();
  (void)mbedtls_ssl_set_hostname(&t->ssl, cli->hostname);
  mbedtls_ssl_set_verify(&t->ssl, &scr_tls_vrfy_cb, t);
  t->sock = sock;
  t->cli = cli;
  return t;
}

/* Reads tunnel plaintext: bytes that arrived with the proxy's head
 * first, then the proxy session. mbedTLS return conventions. */
static int scr_tls_tunnel_read(ScrTlsTunnel *tun, unsigned char *buf, size_t len) {
  if (tun->extra_off < tun->extra_len) {
    size_t n = tun->extra_len - tun->extra_off;
    if (n > len) n = len;
    memcpy(buf, tun->extra + tun->extra_off, n);
    tun->extra_off += n;
    return (int)n;
  }
  int r = mbedtls_ssl_read(&tun->outer->ssl, buf, len);
  if (r == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) return 0;
#if defined(MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET)
  if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) return MBEDTLS_ERR_SSL_WANT_READ;
#endif
  return r;
}

/* The target session's BIOs: records travel inside the proxy session. */
static int scr_tls_tunnel_bio_send(void *ctx, const unsigned char *buf, size_t len) {
  ScrTlsTunnel *tun = (ScrTlsTunnel *)ctx;
  return mbedtls_ssl_write(&tun->outer->ssl, buf, len);
}

static int scr_tls_tunnel_bio_recv(void *ctx, unsigned char *buf, size_t len) {
  return scr_tls_tunnel_read((ScrTlsTunnel *)ctx, buf, len);
}

/* A tunnel leg's handshake has finished. The tunnel runs no established
 * callbacks before it writes the CONNECT request or the request itself, so
 * the last flight goes out now instead of waiting for the immediate that
 * ends a socket's hold (which does not see the tunnel's legs). */
static void scr_tls_tunnel_end_hold(ScrTlsSock *t) {
  t->holding = false;
  if (t->held_len > t->held_off) (void)scr_tls_flush_held(t);
}

static int scr_tls_tunnel_handshake(void *tctx) {
  ScrTlsTunnel *tun = (ScrTlsTunnel *)tctx;
  ScrNetSocket *sock = tun->outer->sock;
  if (tun->stage == SCR_TUN_OUTER) {
    int r = scr_tls_handshake(tun->outer);
    if (r <= 0) return r;
    scr_tls_tunnel_end_hold(tun->outer);
    tun->outer->established = true;
    tun->stage = SCR_TUN_SEND;
  }
  if (tun->stage == SCR_TUN_SEND) {
    while (tun->req_off < tun->req_len) {
      int r = mbedtls_ssl_write(&tun->outer->ssl, (const unsigned char *)tun->req + tun->req_off,
                                tun->req_len - tun->req_off);
      if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return 0;
      if (r < 0) {
        scr_net_sock_transport_error(sock, "write EPIPE");
        return -1;
      }
      tun->req_off += (size_t)r;
    }
    tun->stage = SCR_TUN_HEAD;
  }
  if (tun->stage == SCR_TUN_HEAD) {
    for (;;) {
      unsigned char buf[4096];
      int r = scr_tls_tunnel_read(tun, buf, sizeof buf);
      if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return 0;
      if (r < 0 && r != MBEDTLS_ERR_SSL_CONN_EOF) {
        scr_net_sock_transport_error(sock, "read ECONNRESET");
        return -1;
      }
      if (r <= 0) {
        scr_net_sock_transport_error(sock, "socket hang up");
        return -1;
      }
      if (tun->head_len + (size_t)r > 16384) {
        scr_net_sock_transport_error(sock, "Proxy response head is too large");
        return -1;
      }
      char *grown = realloc(tun->head, tun->head_len + (size_t)r);
      if (!grown) scr_tls_oom();
      tun->head = grown;
      memcpy(tun->head + tun->head_len, buf, (size_t)r);
      tun->head_len += (size_t)r;
      size_t end = 0;
      for (size_t i = 3; i < tun->head_len; i++) {
        if (memcmp(tun->head + i - 3, "\r\n\r\n", 4) == 0) {
          end = i + 1;
          break;
        }
      }
      if (end == 0) continue;
      int status = scr_net_tunnel_status(tun->head, end);
      if (status != 200) {
        char msg[128];
        scr_net_tunnel_failure(status, msg, sizeof msg);
        scr_net_sock_transport_error(sock, msg);
        return -1;
      }
      tun->extra = malloc(tun->head_len - end + 1);
      if (!tun->extra) scr_tls_oom();
      memcpy(tun->extra, tun->head + end, tun->head_len - end);
      tun->extra_len = tun->head_len - end;
      tun->extra_off = 0;
      free(tun->head);
      tun->head = NULL;
      tun->head_len = 0;
      tun->stage = tun->inner != NULL ? SCR_TUN_INNER : SCR_TUN_UP;
      break;
    }
  }
  if (tun->stage == SCR_TUN_INNER) {
    int r = scr_tls_handshake(tun->inner);
    if (r <= 0) return r;
    scr_tls_tunnel_end_hold(tun->inner);
    tun->stage = SCR_TUN_UP;
  }
  return 1;
}

static ssize_t scr_tls_tunnel_xread(void *tctx, char *buf, size_t n) {
  ScrTlsTunnel *tun = (ScrTlsTunnel *)tctx;
  if (tun->inner != NULL) return scr_tls_xread(tun->inner, buf, n);
  if (tun->extra_off < tun->extra_len) {
    return scr_tls_tunnel_read(tun, (unsigned char *)buf, n);
  }
  return scr_tls_xread(tun->outer, buf, n);
}

static ssize_t scr_tls_tunnel_xwrite(void *tctx, const char *buf, size_t n) {
  ScrTlsTunnel *tun = (ScrTlsTunnel *)tctx;
  return scr_tls_xwrite(tun->inner != NULL ? tun->inner : tun->outer, buf, n);
}

static void scr_tls_tunnel_on_established(void *tctx) {
  ScrTlsTunnel *tun = (ScrTlsTunnel *)tctx;
  if (tun->inner != NULL) tun->inner->established = true;
}

static bool scr_tls_tunnel_pending(void *tctx) {
  ScrTlsTunnel *tun = (ScrTlsTunnel *)tctx;
  return tun->extra_off < tun->extra_len || (tun->inner != NULL && scr_tls_pending(tun->inner)) ||
         scr_tls_pending(tun->outer);
}

static void scr_tls_tunnel_shutdown_write(void *tctx) {
  ScrTlsTunnel *tun = (ScrTlsTunnel *)tctx;
  if (tun->inner != NULL) scr_tls_shutdown_write(tun->inner);
  scr_tls_shutdown_write(tun->outer);
}

static void scr_tls_tunnel_free(void *tctx) {
  ScrTlsTunnel *tun = (ScrTlsTunnel *)tctx;
  if (tun->inner != NULL) scr_tls_free(tun->inner);
  scr_tls_free(tun->outer);
  free(tun->req);
  free(tun->head);
  free(tun->extra);
  free(tun);
}

/* The fd is writable again: the rest of what the outer leg held. */
static void scr_tls_tunnel_drain(void *tctx) { scr_tls_drain(((ScrTlsTunnel *)tctx)->outer); }

static const ScrNetTransportOps SCR_TLS_TUNNEL_OPS = {
  .xread = scr_tls_tunnel_xread,
  .xwrite = scr_tls_tunnel_xwrite,
  .handshake = scr_tls_tunnel_handshake,
  .on_established = scr_tls_tunnel_on_established,
  .pending = scr_tls_tunnel_pending,
  .drain = scr_tls_tunnel_drain,
  .shutdown_write = scr_tls_tunnel_shutdown_write,
  .free = scr_tls_tunnel_free,
};

typedef struct {
  ScrTlsCli *proxy;  /* moves into the transport */
  ScrTlsCli *target; /* NULL for an http:// target */
  char *req;
  size_t req_len;
} ScrTlsTunnelCtx;

void *scr_tls_fetch_tunnel_ctx(ScrStr *proxy_host /*borrowed*/, ScrStr *target_host /*borrowed, nullable*/,
                               const char *request, size_t len) {
  ScrTlsTunnelCtx *ctx = calloc(1, sizeof *ctx);
  if (!ctx) scr_tls_oom();
  ctx->proxy = scr_tls_cli_new(proxy_host, true, NULL, 0);
  ctx->target = target_host != NULL ? scr_tls_cli_new(target_host, true, NULL, 0) : NULL;
  ctx->req = malloc(len);
  if (!ctx->req) scr_tls_oom();
  memcpy(ctx->req, request, len);
  ctx->req_len = len;
  return ctx;
}

void scr_tls_fetch_tunnel_wrap(ScrNetSocket *sock, void *vctx) {
  ScrTlsTunnelCtx *ctx = (ScrTlsTunnelCtx *)vctx;
  ScrTlsTunnel *tun = calloc(1, sizeof *tun);
  if (!tun) scr_tls_oom();
  tun->outer = scr_tls_cli_sock(sock, ctx->proxy);
  mbedtls_ssl_set_bio(&tun->outer->ssl, tun->outer, scr_tls_bio_send, scr_tls_bio_recv, NULL);
  if (ctx->target != NULL) {
    tun->inner = scr_tls_cli_sock(sock, ctx->target);
    mbedtls_ssl_set_bio(&tun->inner->ssl, tun, scr_tls_tunnel_bio_send, scr_tls_tunnel_bio_recv,
                        NULL);
  }
  tun->req = ctx->req;
  tun->req_len = ctx->req_len;
  free(ctx);
  scr_net_sock_set_transport(sock, &SCR_TLS_TUNNEL_OPS, tun);
}

ScrHttpClientReq *scr_https_request(ScrStr *host /*borrowed*/, double port,
                                     ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                     double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                     bool auto_end, bool reject_unauthorized,
                                     const char *ca /*borrowed, NULL = none*/, size_t ca_len,
                                     ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn) {
  ScrStr *servername = scr_https_take_servername();
  ScrTlsCli *cli = scr_tls_cli_for(host, reject_unauthorized, ca, ca_len, servername);
  ScrStr *key = scr_tls_pool_key(host, reject_unauthorized, ca, ca_len, servername);
  scr_str_release(servername);
  ScrHttpClientReq *c = scr_http_request_agent_ex(host, port, path, method, timeout_ms, header_pairs,
                                                  auto_end, NULL, cb, fn, 443, &scr_tls_cli_wrap,
                                                  cli, key);
  scr_str_release(key);
  return c;
}

/* https.get('https://host/path') — the URL-string spelling, sharing
 * scr_http.c's parse (which rejects a non-https scheme here with Node's
 * ERR_INVALID_PROTOCOL) and dialing through the same per-request client
 * config as the options form. No options means Node's defaults: the
 * certificate is verified against the default trust anchors. */
ScrHttpClientReq *scr_https_request_url(ScrStr *url /*borrowed*/, ScrStr *method /*borrowed*/,
                                         bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                         ScrHttpRespFn fn) {
  ScrStr *host;
  ScrStr *path;
  double port;
  if (!scr_http_url_parts(url, true, &host, &port, &path)) {
    if (cb) scr_closure_release(cb);
    return NULL; /* Invalid URL / ERR_INVALID_PROTOCOL pending */
  }
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, 0);
  ScrHttpClientReq *c = scr_https_request(host, port, path, method, 0, pairs, auto_end,
                                           true /* rejectUnauthorized */, NULL, 0, cb, fn);
  scr_arr_release(pairs);
  scr_str_release(host);
  scr_str_release(path);
  return c;
}

ScrHttpClientReq *scr_https_request_agent(ScrStr *host /*borrowed*/, double port,
                                           ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                           double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                           bool auto_end, bool reject_unauthorized,
                                           const char *ca /*borrowed, NULL = none*/, size_t ca_len,
                                           const ScrDyn *agent /*borrowed*/,
                                           ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn) {
  ScrStr *servername = scr_https_take_servername();
  ScrTlsCli *cli = scr_tls_cli_for(host, reject_unauthorized, ca, ca_len, servername);
  ScrStr *key = scr_tls_pool_key(host, reject_unauthorized, ca, ca_len, servername);
  scr_str_release(servername);
  ScrHttpClientReq *c = scr_http_request_agent_ex(host, port, path, method, timeout_ms, header_pairs,
                                                  auto_end, agent, cb, fn, 443, &scr_tls_cli_wrap,
                                                  cli, key);
  scr_str_release(key);
  return c;
}

/* ── RUNTIME options records (the divergence-66 stance) ────────────────
 * A non-literal options value — the checked-dynamic JS lane's dyn record
 * — reads its members at RUNTIME. Members the literal path lowers take
 * the same lowering; members whose literal forms are compile fences
 * become runtime gates that THROW the catchable fence instead of
 * behaving differently; undocumented keys drop exactly like Node drops
 * them (the value already evaluated, so dropping is always safe). */

static void scr_tls_opt_fence(const char *api, const char *key, const char *hint) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, api);
  scr_jb_puts(&b, " option '");
  scr_jb_puts(&b, key);
  scr_jb_puts(&b, "' has no static lowering — ");
  scr_jb_puts(&b, hint);
  scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
}

/* JS truthiness over the dyn kinds — Node reads requestCert /
 * rejectUnauthorized through `if (options.x)`. */
static bool scr_tls_dyn_truthy(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL: return false;
  case SCR_DYN_BOOL: return v->v.b;
  case SCR_DYN_NUM: return v->v.num != 0 && v->v.num == v->v.num;
  case SCR_DYN_STR: return v->v.str->len > 0;
  default: return true; /* objects, arrays, functions, handles, bytes */
  }
}

/* PEM material from a runtime option value: a string, a Buffer/Uint8Array,
 * or an array of those. `concat` (the client `ca` bundle) joins array
 * entries; cert/key arrays accept exactly one entry (one identity per
 * server here — multi-key servers fence). Returns +1 bytes, or NULL with
 * the exception pending. `what` names the fence ("a tls.createServer
 * 'cert' option"). */
static ScrBytes *scr_tls_pem_dyn(const ScrDyn *v, const char *what, bool concat) {
  if (v->kind == SCR_DYN_TYPED_REF) {
    /* a typed array (an array literal in a typed record): its entries */
    ScrDyn *plain = scr_dyn_typed_ref_materialize(v);
    if (plain == NULL) return NULL;
    ScrBytes *b = scr_tls_pem_dyn(plain, what, concat);
    scr_dyn_release(plain);
    return b;
  }
  if (v->kind == SCR_DYN_STR) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)v->v.str->len);
    memcpy(b->data, v->v.str->data, v->v.str->len);
    return b;
  }
  if (scr_dyn_bytes_is(v, SCR_BYTES_U8)) return v->v.bytes->shared ? scr_bytes_copy(v->v.bytes) : scr_dyn_bytes_unbox(v);
  if (v->kind == SCR_DYN_ARR) {
    if (v->v.arr.len == 0) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, what);
      scr_jb_puts(&b, " holding an empty array has no static lowering — pass PEM material");
      scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
      return NULL;
    }
    if (v->v.arr.len > 1 && !concat) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, what);
      scr_jb_puts(&b, " with more than one array entry has no static lowering — one cert/key pair per server here");
      scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
      return NULL;
    }
    /* concatenate (mbedTLS parses concatenated PEM — the ca-bundle shape) */
    size_t total = 0;
    for (size_t i = 0; i < v->v.arr.len; i++) {
      const ScrDyn *e = v->v.arr.items[i];
      if (e->kind == SCR_DYN_STR) total += e->v.str->len + 1;
      else if (scr_dyn_bytes_is(e, SCR_BYTES_U8)) total += e->v.bytes->len + 1;
      else {
        scr_dyn_arg_type_fail(what, "of type string or an instance of Buffer or Uint8Array", e);
        return NULL;
      }
    }
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)total);
    size_t off = 0;
    for (size_t i = 0; i < v->v.arr.len; i++) {
      const ScrDyn *e = v->v.arr.items[i];
      size_t n = e->kind == SCR_DYN_STR ? e->v.str->len : e->v.bytes->len;
      if (e->kind == SCR_DYN_STR) memcpy(b->data + off, e->v.str->data, n);
      else scr_bytes_read(e->v.bytes, 0, b->data + off, n);
      off += n;
      b->data[off++] = '\n'; /* PEM blocks join on line boundaries */
    }
    return b;
  }
  scr_dyn_arg_type_fail(what, "of type string or an instance of Buffer or Uint8Array", v);
  return NULL;
}

/* A `ca` option from a runtime value: NULL for none (an empty string,
 * which Node reads as no ca), empty bytes for an empty Buffer or array
 * (an empty trust store), else the PEM bundle (+1). False with the
 * exception pending. */
static bool scr_tls_ca_dyn(const ScrDyn *v, const char *what, ScrBytes **out) {
  *out = NULL;
  ScrDyn *plain = v->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(v) : NULL;
  if (v->kind == SCR_DYN_TYPED_REF && plain == NULL) return false;
  const ScrDyn *ca = plain != NULL ? plain : v;
  bool ok = true;
  if (ca->kind == SCR_DYN_ARR && ca->v.arr.len == 0) {
    *out = scr_bytes_new(SCR_BYTES_U8, 0);
  } else if (ca->kind != SCR_DYN_STR || ca->v.str->len > 0) {
    *out = scr_tls_pem_dyn(ca, what, true);
    ok = *out != NULL;
  }
  scr_dyn_release(plain);
  return ok;
}

/* A client's ca for scr_tls_cli_new2: NULL for none, and never NULL for a
 * given ca, even an empty one. */
static const char *scr_tls_ca_data(const ScrBytes *ca) {
  if (ca == NULL) return NULL;
  return ca->data != NULL ? (const char *)ca->data : "";
}

/* https.request/get with a runtime options record: the http walk, then
 * the TLS options the literal https path lowers (rejectUnauthorized, ca,
 * servername) and a client certificate (cert and key). Other tls.connect
 * options fence when they carry a value. */
static const char *const SCR_HTTPS_REQ_FENCED_OPTIONS[] = {
  "ALPNProtocols", "checkServerIdentity", "ciphers", "crl", "dhparam", "ecdhCurve",
  "honorCipherOrder", "maxVersion", "minVersion", "passphrase", "pfx", "secureContext",
  "secureOptions", "secureProtocol", "session", "sessionIdContext", "sigalgs", NULL,
};

ScrHttpClientReq *scr_https_request_dyn(const ScrDyn *opts /*borrowed*/, bool auto_end,
                                        ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn,
                                        ScrDyn *(*add_abort)(ScrDyn *signal, ScrDyn *listener)) {
  ScrHttpReqOpts o;
  if (!scr_http_req_opts_read(opts, true, "https.request", &o)) {
    if (cb) scr_closure_release(cb);
    return NULL;
  }
  const ScrDyn *rec = o.view != NULL ? o.view : opts;
  bool reject = true;
  ScrBytes *ca = NULL;
  ScrBytes *own_cert = NULL, *own_key = NULL;
  ScrStr *servername = NULL;
  bool ok = true;
  if (rec != NULL && rec->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; ok && SCR_HTTPS_REQ_FENCED_OPTIONS[i] != NULL; i++) {
      const char *key = SCR_HTTPS_REQ_FENCED_OPTIONS[i];
      const ScrDyn *v = scr_dyn_obj_get(rec, key, strlen(key));
      if (v != NULL && scr_tls_dyn_truthy(v)) {
        scr_http_req_opts_fence("https.request", key,
                                "rejectUnauthorized, ca, servername, cert, and key are the supported TLS options");
        ok = false;
      }
    }
    const ScrDyn *r = ok ? scr_dyn_obj_get(rec, "rejectUnauthorized", 18) : NULL;
    if (r != NULL && r->kind == SCR_DYN_BOOL && !r->v.b) reject = false;
    const ScrDyn *c = ok ? scr_dyn_obj_get(rec, "ca", 2) : NULL;
    if (c != NULL && c->kind != SCR_DYN_UNDEF && c->kind != SCR_DYN_NULL) {
      ok = scr_tls_ca_dyn(c, "an https.request 'ca' option", &ca);
    }
    const ScrDyn *oc = ok ? scr_dyn_obj_get(rec, "cert", 4) : NULL;
    if (oc != NULL && oc->kind != SCR_DYN_UNDEF && oc->kind != SCR_DYN_NULL) {
      own_cert = scr_tls_pem_dyn(oc, "an https.request 'cert' option", false);
      if (own_cert == NULL) ok = false;
    }
    const ScrDyn *ok_ = ok ? scr_dyn_obj_get(rec, "key", 3) : NULL;
    if (ok_ != NULL && ok_->kind != SCR_DYN_UNDEF && ok_->kind != SCR_DYN_NULL) {
      own_key = scr_tls_pem_dyn(ok_, "an https.request 'key' option", false);
      if (own_key == NULL) ok = false;
    }
    if (ok && (own_cert == NULL) != (own_key == NULL)) {
      scr_http_req_opts_fence("https.request", own_cert != NULL ? "cert" : "key",
                              "a client certificate lowers with both cert and key");
      ok = false;
    }
    const ScrDyn *sn = ok ? scr_dyn_obj_get(rec, "servername", 10) : NULL;
    if (sn != NULL && sn->kind != SCR_DYN_UNDEF && sn->kind != SCR_DYN_NULL) {
      if (sn->kind != SCR_DYN_STR) {
        scr_dyn_prop_type_fail("options.servername", "of type string", sn);
        ok = false;
      } else {
        servername = scr_str_retain(sn->v.str);
      }
    }
  }
  if (!ok) {
    if (ca) scr_bytes_release(ca);
    scr_bytes_release(own_cert);
    scr_bytes_release(own_key);
    scr_http_req_opts_free(&o);
    if (cb) scr_closure_release(cb);
    return NULL;
  }
  const char *ca_data = scr_tls_ca_data(ca);
  size_t ca_len = ca ? ca->len : 0;
  ScrTlsCli *cli = scr_tls_cli_for(o.host, reject, ca_data, ca_len, servername);
  ScrStr *key = scr_tls_pool_key(o.host, reject, ca_data, ca_len, servername);
  if (own_cert != NULL) {
    /* Node's agent keys pooled sockets by the client certificate too */
    scr_tls_cli_set_own(cli, own_cert, own_key);
    uint64_t h = 1469598103934665603ull;
    for (size_t i = 0; i < own_cert->len; i++) h = (h ^ own_cert->data[i]) * 1099511628211ull;
    for (size_t i = 0; i < own_key->len; i++) h = (h ^ own_key->data[i]) * 1099511628211ull;
    char suffix[24];
    int n = snprintf(suffix, sizeof suffix, ":c%016llx", (unsigned long long)h);
    ScrStr *tail = scr_str_new(suffix, (size_t)n);
    ScrStr *keyed = scr_str_concat(key, tail);
    scr_str_release(tail);
    scr_str_release(key);
    key = keyed;
    scr_bytes_release(own_cert);
    scr_bytes_release(own_key);
  }
  scr_str_release(servername);
  ScrHttpClientReq *req = scr_http_req_opts_send(&o, auto_end, cb, fn, add_abort,
                                                 &scr_tls_cli_wrap, cli, key);
  scr_str_release(key);
  if (ca) scr_bytes_release(ca);
  scr_http_req_opts_free(&o);
  return req;
}

/* The literal path's runtime-valued cert/key extraction (the compiler's
 * tls.pemDyn libCall): `what` arrives precomposed. undefined throws — the
 * literal walk required the member's presence — and so does an empty
 * string, which Node reads as no material while empty bytes here are an
 * empty ca. */
ScrBytes *scr_tls_pem_from_dyn(const ScrDyn *v, const char *what) {
  bool empty = v->kind == SCR_DYN_STR && v->v.str->len == 0;
  if (v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL || empty) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, what);
    scr_jb_puts(&b, empty ? " holding an empty string" : " holding undefined");
    scr_jb_puts(&b, " has no static lowering — pass PEM material (a string or a Buffer)");
    scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
    return NULL;
  }
  return scr_tls_pem_dyn(v, what, false);
}

/* The tls/https createServer documented keys OUTSIDE the implemented set
 * (cert/key/ca/requestCert/rejectUnauthorized/SNICallback walk their own
 * arms below): present-with-a-value throws the runtime fence — an option
 * that changes Node-observable behavior must work or fence instead of
 * being dropped without an error. Undocumented keys drop, exactly Node. */
static const char *const SCR_TLS_SRV_FENCED_OPTIONS[] = {
  "ALPNProtocols", "ALPNCallback", "allowHalfOpen", "certificateCompression", "ciphers",
  "clientCertEngine", "crl", "dhparam", "ecdhCurve", "enableTrace",
  "handshakeTimeout", "highWaterMark", "honorCipherOrder", "keepAlive",
  "keepAliveInitialDelay", "maxVersion", "minVersion", "noDelay",
  "passphrase", "pauseOnConnect", "pfx", "privateKeyEngine",
  "privateKeyIdentifier", "pskCallback", "pskIdentityHint", "requestOCSP",
  "secureContext", "secureOptions", "secureProtocol", "sessionIdContext",
  "sessionTimeout", "sigalgs", "ticketKeys", NULL,
};

/* ── the typed option-validation ladders (checked-dynamic lane) ────────
 * Node's configSecureContext / Server-constructor argument contracts over
 * every PRESENT validated key, run BEFORE the pem walk and its fences so
 * Node's typed errors always come first (the invalid-input probes isolate
 * one bad option per call, so the fixed order below matches each).
 * false = exception pending. */
static bool scr_tls_opts_validate(const ScrDyn *opts) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return true;
  static const char *const STR_OPTS[] = { "ciphers", "passphrase", "ecdhCurve", "sessionIdContext", NULL };
  for (size_t i = 0; STR_OPTS[i] != NULL; i++) {
    const ScrDyn *v = scr_dyn_obj_get(opts, STR_OPTS[i], strlen(STR_OPTS[i]));
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_STR) {
      char name[48];
      snprintf(name, sizeof name, "options.%s", STR_OPTS[i]);
      scr_dyn_prop_type_fail(name, "of type string", v);
      return false;
    }
  }
  static const char *const ENGINE_OPTS[] = { "clientCertEngine", "privateKeyEngine", "privateKeyIdentifier", NULL };
  for (size_t i = 0; ENGINE_OPTS[i] != NULL; i++) {
    const ScrDyn *v = scr_dyn_obj_get(opts, ENGINE_OPTS[i], strlen(ENGINE_OPTS[i]));
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_STR) {
      char name[48];
      snprintf(name, sizeof name, "options.%s", ENGINE_OPTS[i]);
      scr_dyn_prop_type_fail(name, "of type string or one of null or undefined", v);
      return false;
    }
  }
  /* Node's toV: null and undefined select the default bound. */
  int version;
  if (!scr_tls_version_dyn(scr_dyn_obj_get(opts, "minVersion", 10), "minimum", 12, &version) ||
      !scr_tls_version_dyn(scr_dyn_obj_get(opts, "maxVersion", 10), "maximum", 13, &version))
    return false;
  static const char *const NUM_OPTS[] = { "handshakeTimeout", "keepAliveInitialDelay", NULL };
  for (size_t i = 0; NUM_OPTS[i] != NULL; i++) {
    const ScrDyn *v = scr_dyn_obj_get(opts, NUM_OPTS[i], strlen(NUM_OPTS[i]));
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_NUM) {
      char name[48];
      snprintf(name, sizeof name, "options.%s", NUM_OPTS[i]);
      scr_dyn_prop_type_fail(name, "of type number", v);
      return false;
    }
  }
  {
    const ScrDyn *v = scr_dyn_obj_get(opts, "sessionTimeout", 14);
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL) {
      if (v->kind != SCR_DYN_NUM) {
        scr_dyn_prop_type_fail("options.sessionTimeout", "of type number", v);
        return false;
      }
      double n = v->v.num;
      char recv[48], msg[192];
      if (!(isfinite(n) && trunc(n) == n)) {
        scr_num_received(n, recv);
        int len = snprintf(msg, sizeof msg,
                           "The value of \"options.sessionTimeout\" is out of range. It must be an integer. Received %s", recv);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
        return false;
      }
      if (n < 0 || n > 2147483647.0) {
        scr_num_received(n, recv);
        int len = snprintf(msg, sizeof msg,
                           "The value of \"options.sessionTimeout\" is out of range. It must be >= 0 && <= 2147483647. Received %s", recv);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
        return false;
      }
    }
  }
  {
    const ScrDyn *v = scr_dyn_obj_get(opts, "ticketKeys", 10);
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL) {
      if (v->kind != SCR_DYN_BYTES) {
        scr_dyn_prop_type_fail("options.ticketKeys", "an instance of Buffer, TypedArray, or DataView", v);
        return false;
      }
      double bytelen = scr_bytes_byte_len(v->v.bytes);
      if (bytelen != 48) {
        char msg[160];
        int len = snprintf(msg, sizeof msg,
                           "The property 'options.ticketKeys' must be exactly 48 bytes. Received %.0f", bytelen);
        scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_VALUE");
        return false;
      }
    }
  }
  return true;
}

/* The server-options walk. Fills the cert/key out-params (+1 each) from a
 * dyn options record; false = exception pending (partial results released).
 * Exported runtime-internally: scr_http2.c's createSecureServerDyn rides
 * the same walk (scr_http2.c always links alongside this unit). */
/* `server_ok`: tls.createServer reads ALPNProtocols, minVersion and
 * maxVersion itself; the walk's other callers keep their fences. */
static bool scr_tls_srv_opts_walk_ex(const ScrDyn *opts, const char *api, ScrBytes **cert_out,
                                     ScrBytes **key_out, bool server_ok, ScrTlsClientAuth *auth) {
  if (opts != NULL && opts->kind == SCR_DYN_TYPED_REF) {
    /* a typed record (an options binding): its fields, as a plain object */
    ScrDyn *plain = scr_dyn_typed_ref_materialize(opts);
    if (plain == NULL) {
      *cert_out = NULL;
      *key_out = NULL;
      return false;
    }
    bool ok = scr_tls_srv_opts_walk_ex(plain, api, cert_out, key_out, server_ok, auth);
    scr_dyn_release(plain);
    return ok;
  }
  *cert_out = NULL;
  *key_out = NULL;
  if (auth != NULL) *auth = (ScrTlsClientAuth){.request = false, .reject = true, .ca = NULL};
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object", opts ? opts : scr_dyn_undefined());
    return false;
  }
  if (!scr_tls_opts_validate(opts)) return false; /* Node's typed errors first */
  bool ok = true;
  for (size_t i = 0; ok && i < opts->v.obj.len; i++) {
    const ScrDynEntry *e = &opts->v.obj.entries[i];
    const ScrDyn *v = e->value;
    if (v->kind == SCR_DYN_UNDEF) continue; /* an undefined member reads as absent, like Node */
    if (strcmp(e->key, "cert") == 0 || strcmp(e->key, "key") == 0) {
      char what[96];
      snprintf(what, sizeof what, "a %s '%s' option", api, e->key);
      ScrBytes *b = scr_tls_pem_dyn(v, what, false);
      if (b == NULL) { ok = false; break; }
      ScrBytes **slot = e->key[0] == 'c' ? cert_out : key_out;
      scr_bytes_release(*slot);
      *slot = b;
      continue;
    }
    if (strcmp(e->key, "ca") == 0) {
      /* the server's `ca` verifies client certificates and completes the
       * server's own chain (scr_tls_srv_client_auth); a walk without
       * client certificates drops it */
      if (auth != NULL) {
        char what[96];
        snprintf(what, sizeof what, "a %s 'ca' option", api);
        scr_bytes_release(auth->ca);
        if (!scr_tls_ca_dyn(v, what, &auth->ca)) ok = false;
      }
      continue;
    }
    if (strcmp(e->key, "requestCert") == 0) {
      if (auth != NULL) {
        auth->request = scr_tls_dyn_truthy(v);
        continue;
      }
      if (scr_tls_dyn_truthy(v)) {
        scr_tls_opt_fence(api, "requestCert",
                          "requestCert lowers on tls.createServer, https.createServer and new tls.TLSSocket");
        ok = false;
      }
      continue;
    }
    if (strcmp(e->key, "rejectUnauthorized") == 0) {
      if (auth != NULL) auth->reject = scr_tls_dyn_truthy(v);
      continue; /* without client certificates it has no effect */
    }
    if (server_ok && (strcmp(e->key, "ALPNProtocols") == 0 || strcmp(e->key, "minVersion") == 0 ||
                      strcmp(e->key, "maxVersion") == 0))
      continue;
    if (strcmp(e->key, "SNICallback") == 0) {
      scr_tls_opt_fence(api, "SNICallback",
                        "SNICallback lowers only on http2.createSecureServer({ allowHTTP1: true, ... }) with a literal options object");
      ok = false;
      continue;
    }
    for (size_t k = 0; SCR_TLS_SRV_FENCED_OPTIONS[k] != NULL; k++) {
      if (strcmp(e->key, SCR_TLS_SRV_FENCED_OPTIONS[k]) == 0) {
        scr_tls_opt_fence(api, e->key,
                          "cert and key (PEM strings or Buffers) are the honestly-implemented members of a runtime options record");
        ok = false;
        break;
      }
    }
    /* anything else: an undocumented key, dropped like Node drops it */
  }
  if (ok && (*cert_out == NULL || *key_out == NULL)) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, api);
    scr_jb_puts(&b, " without both cert and key has no static lowering — the supported options are { cert, key } (PEM strings or Buffers)");
    scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
    ok = false;
  }
  if (!ok) {
    scr_bytes_release(*cert_out);
    scr_bytes_release(*key_out);
    *cert_out = NULL;
    *key_out = NULL;
    if (auth != NULL) {
      scr_bytes_release(auth->ca);
      auth->ca = NULL;
    }
  }
  return ok;
}

bool scr_tls_srv_opts_walk(const ScrDyn *opts, const char *api, ScrBytes **cert_out,
                            ScrBytes **key_out) {
  return scr_tls_srv_opts_walk_ex(opts, api, cert_out, key_out, false, NULL);
}

/* createSecureContext over a RUNTIME options record: Node's typed
 * validations first (scr_tls_opts_validate), then the pem walk — a bag
 * that validates AND carries both cert and key builds the real context;
 * everything else met its ladder error or the walk's per-key fence.
 * +1, or NULL with the exception pending. */
ScrSecureCtx *scr_tls_create_secure_context_dyn(const ScrDyn *opts /*borrowed*/) {
  ScrBytes *cert, *key;
  /* requestCert and rejectUnauthorized are no context options: Node's
   * createSecureContext ignores them */
  ScrTlsClientAuth auth;
  if (!scr_tls_srv_opts_walk_ex(opts, "tls.createSecureContext", &cert, &key, false, &auth)) return NULL;
  ScrSecureCtx *c = scr_tls_create_secure_context((const char *)cert->data, cert->len,
                                                   (const char *)key->data, key->len);
  if (auth.ca != NULL) {
    /* kept for sockets created from the context (a TLSSocket's
     * secureContext); an SNI answer's chain comes from the server's
     * context in OpenSSL, so the answer's ca is not used there */
    if (auth.ca->len > 0) {
      int r = scr_tls_parse_crt(&c->ca, (const char *)auth.ca->data, auth.ca->len);
      if (r != 0) scr_tls_bad_material("ca certificate", r);
    }
    c->has_ca = true;
    scr_bytes_release(auth.ca);
  }
  scr_bytes_release(cert);
  scr_bytes_release(key);
  return c;
}

/* tls.getCACertificates(type): validateString, then the documented name
 * set — an unknown name answers ERR_INVALID_ARG_VALUE; the real CA list
 * has no lowering, so a valid name meets the fence. Always throws. */
void scr_tls_ca_certs_chk(const ScrDyn *type, const ScrStr *fence) {
  if (type->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("type", "of type string", type);
    return;
  }
  static const char *const KNOWN[] = { "default", "system", "bundled", "extra", NULL };
  bool valid = false;
  for (size_t i = 0; KNOWN[i] != NULL; i++) {
    if (type->v.str->len == strlen(KNOWN[i]) &&
        memcmp(type->v.str->data, KNOWN[i], type->v.str->len) == 0) {
      valid = true;
      break;
    }
  }
  if (!valid) {
    scr_dyn_arg_value_fail("type", NULL, type);
    return;
  }
  scr_throw_lowering_fence(fence);
}

ScrNetServer *scr_tls_create_server_dyn(const ScrDyn *opts /*borrowed*/,
                                         ScrClosure *handler /*moves, nullable*/,
                                         ScrNetConnFn fn) {
  int min_version = 12, max_version = 13;
  if (!scr_tls_versions_dyn(opts, &min_version, &max_version)) {
    scr_closure_release(handler);
    return NULL;
  }
  ScrBytes *cert, *key;
  ScrTlsClientAuth auth;
  if (!scr_tls_srv_opts_walk_ex(opts, "tls.createServer", &cert, &key, true, &auth)) {
    scr_closure_release(handler);
    return NULL;
  }
  /* The Server constructor converts ALPNProtocols after the secure
   * context validates (Node's order). */
  char **alpn = NULL;
  const ScrDyn *protocols = scr_dyn_obj_get(opts, "ALPNProtocols", 13);
  if (protocols != NULL && !scr_tls_alpn_dyn(protocols, &alpn)) {
    scr_bytes_release(cert);
    scr_bytes_release(key);
    scr_bytes_release(auth.ca);
    scr_closure_release(handler);
    return NULL;
  }
  ScrNetServer *s = scr_tls_create_server_alpn((const char *)cert->data, cert->len,
                                                (const char *)key->data, key->len, handler, fn,
                                                alpn, min_version, max_version, NULL, NULL, &auth);
  scr_bytes_release(auth.ca);
  scr_bytes_release(cert);
  scr_bytes_release(key);
  return s;
}

ScrNetServer *scr_https_create_server_dyn(const ScrDyn *opts /*borrowed*/,
                                           ScrClosure *handler /*moves, nullable*/,
                                           ScrHttpReqFn fn) {
  /* HTTPS ServerOptions extends http.ServerOptions. Consume the one HTTP
   * constructor field this runtime models before the shared TLS walker;
   * that walker deliberately owns only the TLS-side option surface. */
  bool has_timeout_buffer = false;
  double timeout_buffer = 0;
  if (opts != NULL && opts->kind == SCR_DYN_OBJ) {
    const ScrDyn *v = scr_dyn_obj_get(opts, "keepAliveTimeoutBuffer", 22);
    if (v != NULL && v->kind != SCR_DYN_UNDEF) {
      if (v->kind != SCR_DYN_NUM) {
        scr_dyn_arg_type_fail("keepAliveTimeoutBuffer", "of type number", v);
        scr_closure_release(handler);
        return NULL;
      }
      timeout_buffer = v->v.num;
      if (!scr_net_server_timeout_option_check(4, timeout_buffer)) {
        scr_closure_release(handler);
        return NULL;
      }
      has_timeout_buffer = true;
    }
  }
  ScrBytes *cert, *key;
  ScrTlsClientAuth auth;
  if (!scr_tls_srv_opts_walk_ex(opts, "https.createServer", &cert, &key, false, &auth)) {
    scr_closure_release(handler);
    return NULL;
  }
  ScrNetServer *s = scr_https_create_server_auth((const char *)cert->data, cert->len,
                                                  (const char *)key->data, key->len, handler, fn, &auth);
  scr_bytes_release(auth.ca);
  if (has_timeout_buffer) scr_net_server_timeout_set(s, 4, timeout_buffer);
  scr_bytes_release(cert);
  scr_bytes_release(key);
  return s;
}

/* ── server.addContext and server.setSecureContext ───────────────────── */

/* Node's addContext pattern: the name with '*' as [^.]* (any run within a
 * label, empty too), matched without regard to case. */
static bool scr_tls_name_match(const char *pattern, const unsigned char *name, size_t len) {
  if (*pattern == '\0') return len == 0;
  if (*pattern == '*') {
    for (size_t k = 0;; k++) {
      if (scr_tls_name_match(pattern + 1, name + k, len - k)) return true;
      if (k == len || name[k] == '.') return false;
    }
  }
  return len > 0 && (unsigned char)tolower(name[0]) == (unsigned char)*pattern &&
         scr_tls_name_match(pattern + 1, name + 1, len - 1);
}

/* The certificate a server handshake serves when the server has contexts
 * (mbedTLS's certificate callback, after the SNI name is read): the
 * newest addContext entry whose pattern matches the name, else the
 * setSecureContext default, else the server's own. An SNICallback answer
 * (or a server with an SNICallback, whose contexts Node does not read)
 * keeps its own path. OpenSSL completes the served chain from the store
 * of the connection's context, the server's current default, and verifies
 * client certificates against the served context's. */
static int scr_tls_f_cert(mbedtls_ssl_context *ssl) {
  ScrTlsSock *t = scr_tls_current;
  if (t == NULL || t->srv == NULL || t->sni_ctx != NULL) return 0;
  ScrTlsSrv *s = t->srv;
  ScrSecureCtx *pick = NULL;
  if (s->sni_cb == NULL) {
    size_t len = 0;
    const unsigned char *name = mbedtls_ssl_get_hs_sni(ssl, &len);
    for (size_t i = s->ncontexts; name != NULL && i-- > 0;) {
      if (scr_tls_name_match(s->contexts[i].pattern, name, len)) {
        pick = s->contexts[i].ctx;
        break;
      }
    }
  }
  if (pick == NULL) pick = s->default_ctx;
  if (pick == NULL) return 0;
  t->sni_ctx = scr_secure_ctx_retain(pick);
  const mbedtls_x509_crt *store = s->default_ctx != NULL ? &s->default_ctx->ca : &s->ca;
  mbedtls_x509_crt *own = &pick->cert;
  if (store->raw.len > 0 && pick->cert.next == NULL) {
    scr_tls_chained_copy(&t->served_chain, &pick->cert, store);
    own = &t->served_chain;
  }
  if (s->request_cert) {
    t->ctx_verifies = true;
    mbedtls_ssl_set_hs_ca_chain(ssl, pick->has_ca ? &pick->ca : scr_tls_system_ca(), NULL);
  }
  return mbedtls_ssl_set_hs_own_cert(ssl, own, &pick->pk);
}

/* The TLS config of a tls or https server, or NULL with the fence thrown. */
static ScrTlsSrv *scr_tls_srv_of_server(ScrNetServer *server, const char *what) {
  ScrNetNativeConnFn fn = NULL;
  void *ctx = NULL;
  void (*ctx_free)(void *) = NULL;
  scr_net_server_get_native_conn(server, &fn, &ctx, &ctx_free);
  if (fn == &scr_tls_srv_on_conn && ctx != NULL) return (ScrTlsSrv *)ctx;
  char msg[160];
  int n = snprintf(msg, sizeof msg, "%s on a server that is not a tls or https server is not supported yet", what);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)(n < (int)sizeof msg ? n : (int)sizeof msg - 1), "SC2020");
  return NULL;
}

/* server.addContext(servername, context): `context` is a SecureContext
 * (borrowed, nullable) or the options createSecureContext reads. Node
 * builds a RegExp from the name, so a name with regular-expression groups
 * or alternation throws the fence. */
void scr_tls_server_add_context(ScrNetServer *server, const ScrDyn *servername,
                                const ScrDyn *options /*nullable*/, ScrSecureCtx *ctx /*nullable*/) {
  ScrTlsSrv *s = scr_tls_srv_of_server(server, "server.addContext");
  if (s == NULL) return;
  if (!scr_tls_dyn_truthy(servername)) {
    static const char msg[] = "\"servername\" is required parameter for Server.addContext";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_TLS_REQUIRED_SERVER_NAME");
    return;
  }
  if (servername->kind != SCR_DYN_STR) {
    scr_tls_opt_fence("server.addContext", "servername", "the servername lowers as a string");
    return;
  }
  const ScrStr *name = servername->v.str;
  for (size_t i = 0; i < name->len; i++) {
    if (name->data[i] == '(' || name->data[i] == ')' || name->data[i] == '|') {
      scr_tls_opt_fence("server.addContext", "servername",
                        "a servername with regular-expression groups or alternation has no lowering");
      return;
    }
    /* the RegExp's case folding beyond ASCII differs from tolower's */
    if ((unsigned char)name->data[i] >= 0x80) {
      scr_tls_opt_fence("server.addContext", "servername", "a servername outside ASCII has no lowering");
      return;
    }
  }
  ScrSecureCtx *c = ctx != NULL ? scr_secure_ctx_retain(ctx) : scr_tls_create_secure_context_dyn(options);
  if (c == NULL) return;
  char *pattern = malloc(name->len + 1);
  struct ScrTlsNamedCtx *grown = realloc(s->contexts, (s->ncontexts + 1) * sizeof *s->contexts);
  if (pattern == NULL || grown == NULL) scr_tls_oom();
  for (size_t i = 0; i < name->len; i++) pattern[i] = (char)tolower((unsigned char)name->data[i]);
  pattern[name->len] = '\0';
  s->contexts = grown;
  s->contexts[s->ncontexts].pattern = pattern;
  s->contexts[s->ncontexts].ctx = c;
  s->ncontexts++;
  mbedtls_ssl_conf_cert_cb(&s->conf, &scr_tls_f_cert);
}

/* server.setSecureContext(options): new connections serve a context made
 * from `options`; open ones keep theirs. */
void scr_tls_server_set_secure_context(ScrNetServer *server, const ScrDyn *options) {
  ScrTlsSrv *s = scr_tls_srv_of_server(server, "server.setSecureContext");
  if (s == NULL) return;
  if (options == NULL || (options->kind != SCR_DYN_OBJ && options->kind != SCR_DYN_TYPED_REF)) {
    scr_dyn_arg_type_fail("options", "of type object", options != NULL ? options : scr_dyn_undefined());
    return;
  }
  ScrSecureCtx *c = scr_tls_create_secure_context_dyn(options);
  if (c == NULL) return;
  scr_secure_ctx_release(s->default_ctx);
  s->default_ctx = c;
  mbedtls_ssl_conf_cert_cb(&s->conf, &scr_tls_f_cert);
}

/* ── new tls.TLSSocket(socket, options) ───────────────────────────────── */

/* The server-mode wrap: a fresh TLS socket takes over raw's connection
 * (scr_net_sock_adopt) and runs the server handshake over it. It serves
 * `ctx` (options.secureContext, which the lowering passes apart from the
 * record; borrowed, nullable) or the record's cert and key. The record
 * reads at runtime like tls.createServer's: ALPNProtocols, minVersion and
 * maxVersion apply, and options without a lowering throw the fence. Node
 * never starts the handshake of a client-mode TLSSocket (no isServer), so
 * that form throws the fence too. +1, or NULL with the exception pending. */
static const char *const SCR_TLS_WRAP_FENCED_OPTIONS[] = {
  "server", "session", "requestOCSP", "pskCallback", "enableTrace", NULL,
};

/* The socket-level options of a wrap that serves a secureContext, which
 * the server-options walk would otherwise check: requestCert (client
 * certificates are not modeled), SNICallback and ALPNCallback fence.
 * False with the exception pending. */
static bool scr_tls_wrap_socket_opts_check(const ScrDyn *record, const char *api) {
  for (size_t i = 0; record != NULL && i < record->v.obj.len; i++) {
    const ScrDynEntry *e = &record->v.obj.entries[i];
    if (e->value->kind == SCR_DYN_UNDEF) continue;
    if (strcmp(e->key, "requestCert") == 0) {
      if (!scr_tls_dyn_truthy(e->value)) continue;
      scr_tls_opt_fence(api, "requestCert",
                        "requestCert lowers with cert and key options, not beside a secureContext");
      return false;
    }
    if (strcmp(e->key, "SNICallback") == 0 || strcmp(e->key, "ALPNCallback") == 0) {
      scr_tls_opt_fence(api, e->key,
                        "isServer, cert, key, secureContext, ALPNProtocols, minVersion and maxVersion are the implemented members");
      return false;
    }
  }
  return true;
}

ScrNetSocket *scr_tls_wrap_socket(ScrNetSocket *raw, const ScrDyn *opts /*borrowed*/,
                                  ScrSecureCtx *ctx /*borrowed, nullable*/) {
  static const char api[] = "new tls.TLSSocket";
  bool is_server = false;
  const ScrDyn *record = opts != NULL && opts->kind == SCR_DYN_OBJ ? opts : NULL;
  for (size_t i = 0; record != NULL && i < record->v.obj.len; i++) {
    const ScrDynEntry *e = &record->v.obj.entries[i];
    if (e->value->kind == SCR_DYN_UNDEF) continue;
    if (strcmp(e->key, "isServer") == 0) {
      is_server = scr_tls_dyn_truthy(e->value);
      continue;
    }
    if (strcmp(e->key, "secureContext") == 0) {
      scr_tls_opt_fence(api, "secureContext",
                        "secureContext lowers as a member of an options object literal");
      return NULL;
    }
    for (size_t k = 0; SCR_TLS_WRAP_FENCED_OPTIONS[k] != NULL; k++) {
      if (strcmp(e->key, SCR_TLS_WRAP_FENCED_OPTIONS[k]) == 0) {
        scr_tls_opt_fence(api, e->key,
                          "isServer, cert, key, secureContext, ALPNProtocols, minVersion and maxVersion are the implemented members");
        return NULL;
      }
    }
  }
  if (!is_server) {
    scr_tls_opt_fence(api, "isServer",
                      "Node starts no handshake for a client-mode TLSSocket; tls.connect({ socket }) runs the client handshake over an open socket");
    return NULL;
  }
  /* Node serves a secureContext as it is: the record's cert, key and
   * other context options are not read then. The socket's own options
   * still apply, so the ones without a lowering fence either way:
   * requestCert lowers with cert and key, whose ca the walk reads. */
  int min_version = 12, max_version = 13;
  ScrBytes *cert = NULL, *key = NULL;
  ScrTlsClientAuth auth = {.request = false, .reject = false, .ca = NULL};
  if (ctx == NULL) {
    if (!scr_tls_versions_dyn(record, &min_version, &max_version)) return NULL;
    if (!scr_tls_srv_opts_walk_ex(record, api, &cert, &key, true, &auth)) return NULL;
    /* a standalone socket requires a certificate only for a truthy
     * rejectUnauthorized; tls.Server's true default does not apply */
    const ScrDyn *reject = scr_dyn_obj_get(record, "rejectUnauthorized", 18);
    auth.reject = reject != NULL && scr_tls_dyn_truthy(reject);
  } else if (!scr_tls_wrap_socket_opts_check(record, api)) {
    return NULL;
  }
  char **alpn = NULL;
  const ScrDyn *protocols = record != NULL ? scr_dyn_obj_get(record, "ALPNProtocols", 13) : NULL;
  if (protocols != NULL && protocols->kind != SCR_DYN_UNDEF && !scr_tls_alpn_dyn(protocols, &alpn)) {
    scr_bytes_release(cert);
    scr_bytes_release(key);
    scr_bytes_release(auth.ca);
    return NULL;
  }
  ScrTlsSrv *srv = ctx != NULL ? scr_tls_srv_from_ctx(ctx)
                               : scr_tls_srv_new((const char *)cert->data, cert->len,
                                                 (const char *)key->data, key->len, false);
  scr_bytes_release(cert);
  scr_bytes_release(key);
  srv->standalone = true;
  scr_tls_srv_client_auth(srv, ctx == NULL ? &auth : NULL);
  scr_bytes_release(auth.ca);
  srv->alpn = alpn; /* moves */
  if (alpn != NULL) mbedtls_ssl_conf_alpn_protocols(&srv->conf, (const char **)srv->alpn);
  if (!scr_tls_conf_versions(&srv->conf, min_version, max_version)) {
    scr_tls_srv_release(srv);
    scr_tls_opt_fence(api, "maxVersion",
                      "a version range with neither TLSv1.2 nor TLSv1.3 has no lowering");
    return NULL;
  }
  srv->max_tls12 = max_version == 12;
  ScrNetSocket *t = scr_net_sock_adopt(raw);
  if (t == NULL) {
    scr_tls_srv_release(srv);
    static const char msg[] =
        "new tls.TLSSocket over a socket that is not connected, or is already wrapped, is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return NULL;
  }
  ScrTlsSock *ts = calloc(1, sizeof *ts);
  if (!ts) scr_tls_oom();
  mbedtls_ssl_init(&ts->ssl);
  if (mbedtls_ssl_setup(&ts->ssl, &srv->conf) != 0) scr_tls_oom();
  if (srv->request_cert) mbedtls_ssl_set_verify(&ts->ssl, &scr_tls_vrfy_cb, ts);
  ts->sock = t;
  ts->srv = srv; /* moves */
  ts->wrapped = true;
  if (srv->max_tls12) ts->sni_state = SCR_SNI_COLLECT; /* pre-parse the hello */
  mbedtls_ssl_set_bio(&ts->ssl, ts, scr_tls_bio_send, scr_tls_bio_recv, NULL);
  scr_net_sock_set_transport(t, &SCR_TLS_OPS, ts);
  scr_net_sock_adopt_start(t);
  return t;
}

/* ── tls.connect (the TLS client socket) ──────────────────────────────── */

/* Node's inspect of a Buffer inside ERR_INVALID_ARG_VALUE's message:
 * "<Buffer 00 01 ...>" with at most 50 bytes, the whole rendering cut at
 * 128 characters with "...". */
static void scr_tls_alpn_value_fail(const char *reason, const uint8_t *data, size_t len) {
  char inspected[400];
  size_t n = (size_t)snprintf(inspected, sizeof inspected, "<Buffer");
  size_t shown = len < 50 ? len : 50;
  for (size_t i = 0; i < shown; i++) n += (size_t)snprintf(inspected + n, sizeof inspected - n, " %02x", data[i]);
  if (len > shown) n += (size_t)snprintf(inspected + n, sizeof inspected - n, " ... %zu more byte%s", len - shown, len - shown == 1 ? "" : "s");
  snprintf(inspected + n, sizeof inspected - n, ">");
  if (strlen(inspected) > 128) strcpy(inspected + 128, "...");
  char msg[600];
  int m = snprintf(msg, sizeof msg, "The argument 'ALPNProtocols' %s. Received %s", reason, inspected);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)m, "ERR_INVALID_ARG_VALUE");
}

/* The wire list (<len><name>...) as mbedTLS's NULL-terminated names, after
 * Node's validateALPNBuffer. An empty list offers nothing (*out stays
 * NULL). False with the exception pending. */
static bool scr_tls_alpn_from_wire(const uint8_t *data, size_t len, char ***out) {
  size_t count = 0;
  for (size_t at = 0; at < len;) {
    size_t n = data[at];
    if (n == 0) {
      scr_tls_alpn_value_fail("must not contain zero-length protocol", data, len);
      return false;
    }
    if (at + 1 + n > len) {
      scr_tls_alpn_value_fail("contains truncated protocol", data, len);
      return false;
    }
    at += 1 + n;
    count++;
  }
  if (count == 0) return true;
  char **names = calloc(count + 1, sizeof *names);
  if (!names) scr_tls_oom();
  size_t k = 0;
  for (size_t at = 0; at < len; at += 1 + data[at]) {
    names[k] = malloc((size_t)data[at] + 1);
    if (!names[k]) scr_tls_oom();
    memcpy(names[k], data + at + 1, data[at]);
    names[k][data[at]] = '\0';
    k++;
  }
  *out = names;
  return true;
}

/* tls.connect's ALPNProtocols (Node's convertALPNProtocols, then
 * setALPNProtocols): an array of non-empty strings of at most 255 bytes, a
 * Uint8Array or other ArrayBufferView in the wire format, or a falsy value
 * (no ALPN). Any other truthy value is the binding's TypeError. False with
 * the exception pending. */
static bool scr_tls_alpn_dyn(const ScrDyn *v, char ***out) {
  *out = NULL;
  ScrDyn *own = NULL;
  if (v->kind == SCR_DYN_TYPED_REF) {
    own = scr_dyn_typed_ref_materialize(v);
    if (own == NULL) return false;
    v = own;
  }
  bool ok = true;
  if (v->kind == SCR_DYN_ARR) {
    /* convertProtocols: Buffer.byteLength of every entry first (strings,
     * or the ArrayBuffer and view entries byteLength also measures), then
     * each length's checks, then buff.write, which takes strings only. */
    size_t count = v->v.arr.len;
    size_t total = 0;
    for (size_t i = 0; ok && i < count; i++) {
      const ScrDyn *e = v->v.arr.items[i];
      size_t n;
      if (e->kind == SCR_DYN_STR) {
        n = e->v.str->len;
      } else if (e->kind == SCR_DYN_BYTES || scr_buffer_storage_is(e)) {
        ScrBytes *view = scr_bytes_buffer_source(e);
        if (view == NULL) {
          ok = false;
          break;
        }
        n = view->len;
        scr_bytes_release(view);
      } else {
        scr_dyn_arg_type_fail("string", "of type string or an instance of Buffer or ArrayBuffer", e);
        ok = false;
        break;
      }
      if (n == 0) {
        char name[32];
        snprintf(name, sizeof name, "protocols[%zu]", i);
        scr_dyn_arg_value_fail(name, "must be a non-empty string", e);
        ok = false;
        break;
      }
      if (n > 255) {
        char msg[160];
        int m = snprintf(msg, sizeof msg,
                         "The byte length of the protocol at index %zu exceeds the maximum length. It must be <= 255. Received %zu",
                         i, n);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)m, "ERR_OUT_OF_RANGE");
        ok = false;
        break;
      }
      total += 1 + n;
    }
    uint8_t *wire = ok ? malloc(total + 1) : NULL;
    if (ok && !wire) scr_tls_oom();
    size_t at = 0;
    for (size_t i = 0; ok && i < count; i++) {
      const ScrDyn *e = v->v.arr.items[i];
      if (e->kind != SCR_DYN_STR) {
        static const char msg[] = "argument must be a string";
        scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
        ok = false;
        break;
      }
      wire[at++] = (uint8_t)e->v.str->len;
      memcpy(wire + at, e->v.str->data, e->v.str->len);
      at += e->v.str->len;
    }
    if (ok) ok = scr_tls_alpn_from_wire(wire, at, out);
    free(wire);
  } else if (v->kind == SCR_DYN_BYTES) {
    ScrBytes *view = scr_bytes_buffer_source(v);
    if (view == NULL) ok = false;
    else {
      ok = scr_tls_alpn_from_wire(view->data, view->len, out);
      scr_bytes_release(view);
    }
  } else if (scr_tls_dyn_truthy(v)) {
    static const char msg[] = "Must give a Buffer as first argument";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    ok = false;
  }
  scr_dyn_release(own);
  return ok;
}

/* tls.connect's documented keys outside the implemented set: present
 * throws (the server walk's stance). */
static const char *const SCR_TLS_CONNECT_FENCED_OPTIONS[] = {
  "allowHalfOpen", "autoSelectFamily",
  "autoSelectFamilyAttemptTimeout", "certificateCompression", "checkServerIdentity",
  "ciphers", "clientCertEngine", "crl", "dhparam", "ecdhCurve",
  "enableTrace", "family", "fd", "hints", "highWaterMark",
  "honorCipherOrder", "keepAlive", "keepAliveInitialDelay",
  "localAddress", "localPort", "lookup", "minDHSize", "noDelay", "onread", "passphrase", "path", "pfx",
  "privateKeyEngine", "privateKeyIdentifier", "pskCallback", "readable",
  "secureContext", "secureOptions", "secureProtocol", "session",
  "sessionIdContext", "sigalgs", "signal", "ticketKeys",
  "writable", NULL,
};

static ScrNetSocket *scr_tls_connect_plain(double port, ScrStr *host /*borrowed, nullable*/,
                                           const ScrDyn *opts /*borrowed, nullable*/,
                                           ScrClosure *cb /*moves, nullable*/);

ScrNetSocket *scr_tls_connect_dyn(double port, ScrStr *host /*borrowed, nullable*/,
                                   const ScrDyn *opts /*borrowed, nullable*/,
                                   ScrClosure *cb /*moves, nullable*/) {
  if (opts == NULL || opts->kind != SCR_DYN_TYPED_REF) return scr_tls_connect_plain(port, host, opts, cb);
  /* a typed record (an options binding): its fields, as a plain object */
  ScrDyn *plain = scr_dyn_typed_ref_materialize(opts);
  if (plain == NULL) {
    scr_closure_release(cb);
    return NULL;
  }
  ScrNetSocket *s = scr_tls_connect_plain(port, host, plain, cb);
  scr_dyn_release(plain);
  return s;
}

static ScrNetSocket *scr_tls_connect_plain(double port, ScrStr *host /*borrowed, nullable*/,
                                           const ScrDyn *opts /*borrowed, nullable*/,
                                           ScrClosure *cb /*moves, nullable*/) {
  scr_tls_rng_init();
  bool reject = true;
  ScrBytes *ca = NULL;
  ScrBytes *own_cert = NULL, *own_key = NULL; /* the client certificate */
  const ScrStr *servername = NULL;
  const ScrStr *opt_host = NULL;
  char **alpn = NULL;
  const ScrDyn *alpn_value = NULL;
  const ScrDyn *timeout_value = NULL;
  int min_version = 12, max_version = 13;
  ScrNetSocket *wrap = NULL; /* options.socket: the open socket to take over */
  bool ok = true;
  if (opts != NULL && opts->kind != SCR_DYN_UNDEF && opts->kind != SCR_DYN_NULL) {
    if (opts->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "of type object", opts);
      ok = false;
    }
    /* createSecureContext's version checks come before its other options
     * (Node's SecureContext constructor). */
    if (ok && !scr_tls_versions_dyn(opts, &min_version, &max_version)) ok = false;
    for (size_t i = 0; ok && i < opts->v.obj.len; i++) {
      const ScrDynEntry *e = &opts->v.obj.entries[i];
      const ScrDyn *v = e->value;
      if (strcmp(e->key, "checkServerIdentity") == 0) {
        /* Node spreads user options over the defaults, so a PRESENT key
         * replaces the builtin verifier even when its value is undefined
         * — validateFunction then throws for anything non-callable. A
         * real function keeps the fence (custom verification has no
         * lowering). */
        if (v->kind != SCR_DYN_FUNC) {
          scr_dyn_prop_type_fail("options.checkServerIdentity", "of type function", v);
          ok = false;
        } else {
          scr_tls_opt_fence("tls.connect", "checkServerIdentity",
                            "custom identity verification has no lowering — the runtime verifies against the servername/host");
          ok = false;
        }
        continue;
      }
      if (v->kind == SCR_DYN_UNDEF) continue;
      if (strcmp(e->key, "port") == 0) {
        if (port >= 0) continue; /* the argument form wins, like Node */
        if (v->kind == SCR_DYN_NUM) port = v->v.num;
        else if (v->kind == SCR_DYN_STR) port = strtod(v->v.str->data, NULL); /* Node coerces numeric strings */
        else {
          scr_dyn_arg_type_fail("options.port", "of type number", v);
          ok = false;
        }
        continue;
      }
      if (strcmp(e->key, "host") == 0) {
        if (v->kind == SCR_DYN_STR) opt_host = v->v.str;
        else {
          scr_dyn_arg_type_fail("options.host", "of type string", v);
          ok = false;
        }
        continue;
      }
      if (strcmp(e->key, "rejectUnauthorized") == 0) {
        reject = scr_tls_dyn_truthy(v);
        continue;
      }
      if (strcmp(e->key, "ca") == 0) {
        scr_bytes_release(ca);
        if (!scr_tls_ca_dyn(v, "a tls.connect 'ca' option", &ca)) ok = false;
        continue;
      }
      if (strcmp(e->key, "cert") == 0 || strcmp(e->key, "key") == 0) {
        ScrBytes **slot = e->key[0] == 'c' ? &own_cert : &own_key;
        scr_bytes_release(*slot);
        *slot = scr_tls_pem_dyn(v, e->key[0] == 'c' ? "a tls.connect 'cert' option" : "a tls.connect 'key' option",
                                false);
        if (*slot == NULL) ok = false;
        continue;
      }
      if (strcmp(e->key, "ALPNProtocols") == 0) {
        alpn_value = v; /* converted after the context options, as TLSSocket does */
        continue;
      }
      if (strcmp(e->key, "minVersion") == 0 || strcmp(e->key, "maxVersion") == 0) continue;
      if (strcmp(e->key, "timeout") == 0) {
        /* `if (options.timeout) tlssock.setTimeout(options.timeout)` */
        timeout_value = scr_tls_dyn_truthy(v) ? v : NULL;
        continue;
      }
      if (strcmp(e->key, "socket") == 0) {
        if (v->kind == SCR_DYN_HANDLE && v->v.handle.tag == SCR_DYNH_NET_SOCKET) {
          wrap = (ScrNetSocket *)v->v.handle.ptr;
        } else {
          scr_tls_opt_fence("tls.connect", "socket", "a net.Socket is the implemented socket value");
          ok = false;
        }
        continue;
      }
      if (strcmp(e->key, "servername") == 0) {
        if (v->kind == SCR_DYN_STR) servername = v->v.str;
        else {
          scr_dyn_arg_type_fail("options.servername", "of type string", v);
          ok = false;
        }
        continue;
      }
      for (size_t k = 0; SCR_TLS_CONNECT_FENCED_OPTIONS[k] != NULL; k++) {
        if (strcmp(e->key, SCR_TLS_CONNECT_FENCED_OPTIONS[k]) == 0) {
          scr_tls_opt_fence("tls.connect", e->key,
                            "port/host/socket/rejectUnauthorized/ca/servername/ALPNProtocols/minVersion/maxVersion/timeout are the implemented members of a runtime options record");
          ok = false;
          break;
        }
      }
      /* anything else: an undocumented key, dropped like Node drops it */
    }
  }
  if (ok && alpn_value != NULL && !scr_tls_alpn_dyn(alpn_value, &alpn)) ok = false;
  /* socket.setTimeout(msecs) runs after the TLSSocket exists and before it
   * connects: Node's msecs checks, then the inactivity timer below. */
  double timeout_ms = 0;
  if (ok && timeout_value != NULL) {
    if (timeout_value->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("msecs", "of type number", timeout_value);
      ok = false;
    } else if (!isfinite(timeout_value->v.num) || timeout_value->v.num < 0) {
      char recv[48], msg[160];
      scr_num_received(timeout_value->v.num, recv);
      int m = snprintf(msg, sizeof msg,
                       "The value of \"msecs\" is out of range. It must be a non-negative finite number. Received %s",
                       recv);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)m, "ERR_OUT_OF_RANGE");
      ok = false;
    } else {
      timeout_ms = timeout_value->v.num;
    }
  }
  if (ok && (own_cert == NULL) != (own_key == NULL)) {
    scr_tls_opt_fence("tls.connect", own_cert != NULL ? "cert" : "key",
                      "a client certificate lowers with both cert and key");
    ok = false;
  }
  if (ok && port < 0 && wrap == NULL) {
    scr_dyn_arg_type_fail("options.port", "of type number", scr_dyn_undefined());
    ok = false;
  }
  ScrStr *dial_host = (ScrStr *)(host != NULL && host->len > 0 ? host : opt_host);
  if (ok && !scr_net_host_chk(dial_host)) ok = false;
  if (!ok) {
    scr_tls_alpn_free(alpn);
    scr_bytes_release(ca);
    scr_bytes_release(own_cert);
    scr_bytes_release(own_key);
    scr_closure_release(cb);
    return NULL;
  }
  /* SNI + verification see a non-empty servername when given, the host
   * name otherwise (Node's servername default); "" sends no SNI. */
  ScrStr *verify_host = dial_host;
  ScrStr *localhost_fallback = NULL;
  /* over options.socket, the host that socket dialed (Node's socket._host) */
  ScrStr *socket_host = verify_host == NULL && wrap != NULL ? scr_net_sock_dial_name(wrap) : NULL;
  if (socket_host != NULL) verify_host = socket_host;
  if (verify_host == NULL) {
    localhost_fallback = scr_str_new("localhost", 9);
    verify_host = localhost_fallback;
  }
  /* Resolve for the dial only (the http client's rule): verify_host above
   * already holds the NAME, which is what SNI and certificate verification
   * must see. A null dial_host stays null — scr_net_connect's own arm. */
  ScrNetSocket *s;
  if (wrap != NULL) {
    s = scr_net_sock_adopt(wrap);
    if (s == NULL) {
      scr_tls_alpn_free(alpn);
      scr_bytes_release(ca);
      scr_bytes_release(own_cert);
      scr_bytes_release(own_key);
      scr_closure_release(cb);
      scr_str_release(localhost_fallback);
      scr_str_release(socket_host);
      static const char msg[] =
          "tls.connect over a socket that is not connected, or is already wrapped, is not supported yet";
      scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
      return NULL;
    }
  } else {
    ScrStr *dial_addr = dial_host != NULL ? scr_net_blocking_lookup(dial_host) : NULL;
    s = scr_net_connect(port, dial_addr, cb); /* cb fires post-handshake — secureConnect */
    if (dial_addr) scr_str_release(dial_addr);
  }
  ScrTlsCli *cli = scr_tls_cli_new2(verify_host, reject,
                                     scr_tls_ca_data(ca), ca != NULL ? ca->len : 0, !reject);
  if (servername != NULL) scr_tls_cli_set_servername(cli, servername);
  if (own_cert != NULL) scr_tls_cli_set_own(cli, own_cert, own_key);
  scr_bytes_release(own_cert);
  scr_bytes_release(own_key);
  if (alpn != NULL) {
    cli->alpn = alpn; /* moves */
    mbedtls_ssl_conf_alpn_protocols(&cli->conf, (const char **)cli->alpn);
  }
  cli->no_protocols = !scr_tls_conf_versions(&cli->conf, min_version, max_version);
  scr_tls_cli_wrap(s, cli);
  if (wrap != NULL) {
    if (cb != NULL) scr_net_sock_on_established(s, cb, true); /* secureConnect */
    scr_net_sock_adopt_start(s);
  }
  if (timeout_ms > 0) scr_net_sock_set_timeout(s, timeout_ms);
  scr_str_release(localhost_fallback);
  scr_str_release(socket_host);
  scr_bytes_release(ca);
  return s;
}

/* ── h2 over TLS (http2.createSecureServer / the https-authority client)
 * — the mbedTLS half: scr_http2.c owns the sessions and calls these two
 * (every http2-using binary links this unit — the moduleUsesTls switch
 * counts http2 libCalls). */

/* Wrap an h2 server: the TLS engine installs per accepted socket, ALPN
 * advertises h2 (plus http/1.1 when the caller wired an inner parser
 * hook first — none today), and on_established attaches the h2 session
 * via `h2_conn` (the ctx moves in with its release fn). */
void scr_tls_server_wrap_h2(ScrNetServer *s, const char *cert, size_t cert_len,
                             const char *key, size_t key_len,
                             ScrNetNativeConnFn h2_conn, void *h2_ctx /*moves*/,
                             void (*h2_ctx_free)(void *),
                             ScrClosure *sni_cb /*moves, nullable*/, void *sni_answer_fn) {
  ScrTlsSrv *srv = scr_tls_srv_new(cert, cert_len, key, key_len, false);
  srv->h2_conn = h2_conn;
  srv->h2_ctx = h2_ctx;
  srv->h2_ctx_free = h2_ctx_free;
  scr_net_server_get_native_conn(s, &srv->inner_conn, &srv->inner_ctx, &srv->inner_ctx_free);
  mbedtls_ssl_conf_alpn_protocols(
      &srv->conf, srv->inner_conn != NULL ? SCR_TLS_ALPN_H2_HTTP11 : SCR_TLS_ALPN_H2);
  if (sni_cb != NULL) {
    srv->sni_cb = sni_cb;
    srv->sni_answer_fn = sni_answer_fn;
    mbedtls_ssl_conf_sni(&srv->conf, &scr_tls_f_sni, NULL);
  }
  scr_net_server_set_native_conn(s, &scr_tls_srv_on_conn, srv, &scr_tls_srv_release_v);
  scr_net_server_defer_connections(s); /* 'connection'/'secureConnection' wait for the handshake */
}

/* The h2-over-TLS CLIENT wrap (http2.connect with an https authority):
 * a client transport offering ALPN ["h2"] — SNI/verification against
 * the authority host; `ca` replaces the trust anchors (NULL = none) and
 * reject_unauthorized false records like tls.connect's. The session's
 * preface/SETTINGS ride the socket's write buffer until establishment. */
void scr_tls_h2_client_wrap(ScrNetSocket *sock, ScrStr *host /*borrowed*/,
                             bool reject_unauthorized, const char *ca, size_t ca_len) {
  ScrTlsCli *cli = scr_tls_cli_new2(host, reject_unauthorized, ca, ca_len, !reject_unauthorized);
  mbedtls_ssl_conf_alpn_protocols(&cli->conf, SCR_TLS_ALPN_H2);
  scr_tls_cli_wrap(sock, cli);
}

/* ── the checked-dynamic TLSSocket members (scr_net.c's hook table) ──── */

/* Node's authorizationError: the verify-failure CODE string (null when
 * authorized). Chain errors dominate the identity check — Node records
 * ssl.verifyError() first and only reaches checkServerIdentity's
 * ERR_TLS_CERT_ALTNAME_INVALID on a VERIFIED chain. */
static const char *scr_tls_auth_code(ScrTlsSock *t) {
  uint32_t vr = mbedtls_ssl_get_verify_result(&t->ssl);
  if (t->vrfy_expired) return "CERT_HAS_EXPIRED";
  if (t->vrfy_leaf_self) return "DEPTH_ZERO_SELF_SIGNED_CERT";
  if (t->vrfy_chain_self) return "SELF_SIGNED_CERT_IN_CHAIN";
  if (vr & MBEDTLS_X509_BADCERT_NOT_TRUSTED) return "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
  if (t->vrfy_cn_mismatch) return "ERR_TLS_CERT_ALTNAME_INVALID";
  return "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
}

/* A server's authorizationError for the client certificate. OpenSSL
 * keeps the last error its verification met: the validity period is
 * checked last, the purpose (clientAuth) before it, the chain first. A
 * client that sent none is UNABLE_TO_GET_ISSUER_CERT, as Node reports it. */
static const char *scr_tls_client_cert_code(ScrTlsSock *t) {
  uint32_t vr = mbedtls_ssl_get_verify_result(&t->ssl);
  if (vr & MBEDTLS_X509_BADCERT_MISSING) return "UNABLE_TO_GET_ISSUER_CERT";
  if (t->vrfy_expired) return "CERT_HAS_EXPIRED";
  if (vr & (MBEDTLS_X509_BADCERT_EXT_KEY_USAGE | MBEDTLS_X509_BADCERT_KEY_USAGE)) return "INVALID_PURPOSE";
  if (t->vrfy_leaf_self) return "DEPTH_ZERO_SELF_SIGNED_CERT";
  if (t->vrfy_chain_self) return "SELF_SIGNED_CERT_IN_CHAIN";
  return "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
}

static ScrTlsSock *scr_tls_sock_of(ScrNetSocket *s) {
  return (ScrTlsSock *)scr_net_sock_transport_ctx_for(s, &SCR_TLS_OPS);
}


/* The client 'session' event: fires ONCE per socket with the serialized
 * mbedTLS session — a real ticket where one arrived (the 1.3 receipt
 * path), the established session otherwise (1.2). Node fires per
 * received ticket; the once-latch satisfies the suite's once-listener
 * shapes, and resumption itself stays out (divergence 55). */
static void scr_tls_fire_session(ScrTlsSock *t) {
  if (t->session_fired || t->session_ls.n == 0 || t->cli == NULL) return;
  mbedtls_ssl_session sess;
  mbedtls_ssl_session_init(&sess);
  if (mbedtls_ssl_get_session(&t->ssl, &sess) != 0) {
    mbedtls_ssl_session_free(&sess); /* no resumable session yet (1.3 pre-ticket) */
    return;
  }
  size_t need = 0;
  (void)mbedtls_ssl_session_save(&sess, NULL, 0, &need);
  ScrBytes *buf = scr_bytes_new(SCR_BYTES_U8, (double)need);
  buf->is_buffer = true; /* the session is a Buffer */
  size_t used = 0;
  int ok = mbedtls_ssl_session_save(&sess, buf->data, need, &used) == 0;
  mbedtls_ssl_session_free(&sess);
  if (!ok) {
    scr_bytes_release(buf);
    return;
  }
  t->session_fired = true;
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(&t->session_ls, &snap);
  scr_dyn_this_push(t->sock, SCR_DYNH_NET_SOCKET);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((ScrNetDataFn)snap[i].fn)(snap[i].cb, buf);
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
  scr_bytes_release(buf);
}

/* The STATIC-lane TLSSocket members (the lowered socket surface). */

/* Whether the socket verified its peer: a client against its trust
 * anchors, a server that requested a client certificate against its. */
static bool scr_tls_sock_verifies(const ScrTlsSock *t) {
  return t->established && ((t->cli != NULL && t->cli->verify_recorded) ||
                            (t->srv != NULL && t->srv->request_cert && !t->srv->standalone));
}

bool scr_tls_sock_authorized(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  return t != NULL && scr_tls_sock_verifies(t) && mbedtls_ssl_get_verify_result(&t->ssl) == 0;
}

ScrStr *scr_tls_sock_auth_error(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !scr_tls_sock_verifies(t) || mbedtls_ssl_get_verify_result(&t->ssl) == 0) {
    return NULL; /* the null arm — authorized, or never verified */
  }
  const char *code = t->srv != NULL ? scr_tls_client_cert_code(t) : scr_tls_auth_code(t);
  return scr_str_new(code, strlen(code));
}

/* ── certificates for the X509Certificate accessors ──────────────────
 *
 * getPeerCertificate, getCertificate and their X509Certificate forms read
 * the DER below (scr_tls_x509.c builds the objects, so this unit needs no
 * X.509 code). Node answers from the socket's handle, which a destroyed
 * socket no longer has. */

bool scr_tls_sock_has_handle(ScrNetSocket *s) {
  return scr_tls_sock_of(s) != NULL && !scr_net_sock_destroyed(s);
}

/* The certificates the peer sent, leaf first (borrowed DER), up to `max`;
 * none before the handshake. Answers the count. */
size_t scr_tls_sock_peer_chain(ScrNetSocket *s, const uint8_t **der, size_t *len, size_t max) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !t->established) return 0;
  size_t n = 0;
  for (const mbedtls_x509_crt *c = mbedtls_ssl_get_peer_cert(&t->ssl); c != NULL && c->raw.len > 0 && n < max;
       c = c->next) {
    der[n] = c->raw.p;
    len[n] = c->raw.len;
    n++;
  }
  return n;
}

/* The certificate the socket serves (borrowed DER), or NULL: a server's
 * SNI answer, secureContext or own certificate. Clients send none. */
const uint8_t *scr_tls_sock_own_cert(ScrNetSocket *s, size_t *len) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t != NULL && t->cli != NULL && t->cli->has_own) {
    *len = t->cli->own.raw.len;
    return t->cli->own.raw.p;
  }
  if (t == NULL || t->srv == NULL) return NULL;
  const mbedtls_x509_crt *c = t->sni_ctx != NULL ? &t->sni_ctx->cert
                              : t->srv->ctx != NULL ? &t->srv->ctx->cert
                                                    : &t->srv->cert;
  if (c->raw.len == 0) return NULL;
  *len = c->raw.len;
  return c->raw.p;
}

/* Visits the trust anchors the socket verified its peer against (its
 * `ca`, or the default store) until `visit` answers true. */
void scr_tls_sock_each_trusted(ScrNetSocket *s, bool (*visit)(void *ctx, const uint8_t *der, size_t len),
                               void *ctx) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || (t->cli == NULL && t->srv == NULL)) return;
  const mbedtls_x509_crt *c = t->cli != NULL ? (t->cli->has_ca ? &t->cli->ca : scr_tls_system_ca())
                              : t->ctx_verifies ? (t->sni_ctx->has_ca ? &t->sni_ctx->ca : scr_tls_system_ca())
                              : t->srv->has_ca ? &t->srv->ca
                                               : scr_tls_system_ca();
  for (; c != NULL && c->raw.len > 0; c = c->next)
    if (visit(ctx, c->raw.p, c->raw.len)) return;
}

static ScrBytes *scr_tls_der_buffer(const uint8_t *der, size_t len) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  b->is_buffer = true;
  if (len) memcpy(b->data, der, len);
  return b;
}

/* getPeerX509Certificate() and getX509Certificate(): the certificate's
 * DER (+1 Buffer), empty when there is none (undefined in Node). */
ScrBytes *scr_tls_sock_peer_cert_der(ScrNetSocket *s) {
  const uint8_t *der;
  size_t len;
  if (!scr_tls_sock_has_handle(s) || scr_tls_sock_peer_chain(s, &der, &len, 1) == 0)
    return scr_tls_der_buffer(NULL, 0);
  return scr_tls_der_buffer(der, len);
}

ScrBytes *scr_tls_sock_own_cert_der(ScrNetSocket *s) {
  size_t len = 0;
  const uint8_t *der = scr_tls_sock_has_handle(s) ? scr_tls_sock_own_cert(s, &len) : NULL;
  return scr_tls_der_buffer(der, der ? len : 0);
}

/* tlsSocket.getProtocol(): the negotiated version ("TLSv1.2",
 * "TLSv1.3"); before the handshake the highest version on offer, as
 * OpenSSL answers, and null after close. +1. */
ScrDyn *scr_tls_sock_get_protocol(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || scr_net_sock_destroyed(s)) return scr_dyn_new_null();
  const char *v = t->established ? mbedtls_ssl_get_version(&t->ssl) : "TLSv1.3";
  ScrStr *str = scr_str_new(v, strlen(v));
  ScrDyn *d = scr_dyn_new_str(str);
  scr_str_release(str);
  return d;
}

/* OpenSSL's names for the suites mbedTLS negotiates, keyed by the IANA
 * name. TLS 1.3 suites share theirs. */
static const char *scr_tls_openssl_cipher_name(const char *iana) {
  static const char *const map[][2] = {
    { "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "ECDHE-RSA-AES128-GCM-SHA256" },
    { "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384", "ECDHE-RSA-AES256-GCM-SHA384" },
    { "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", "ECDHE-ECDSA-AES128-GCM-SHA256" },
    { "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384", "ECDHE-ECDSA-AES256-GCM-SHA384" },
    { "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256", "ECDHE-RSA-CHACHA20-POLY1305" },
    { "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256", "ECDHE-ECDSA-CHACHA20-POLY1305" },
    { "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256", "ECDHE-RSA-AES128-SHA256" },
    { "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384", "ECDHE-RSA-AES256-SHA384" },
    { "TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256", "ECDHE-ECDSA-AES128-SHA256" },
    { "TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA384", "ECDHE-ECDSA-AES256-SHA384" },
  };
  if (strncmp(iana, "TLS_AES_", 8) == 0 || strncmp(iana, "TLS_CHACHA20_", 13) == 0) return iana;
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
    if (strcmp(map[i][0], iana) == 0) return map[i][1];
  }
  return NULL;
}

/* tlsSocket.getCipher(): { name, standardName, version } for the
 * negotiated suite (OpenSSL's name, the IANA name, and the suite's
 * minimum protocol version as OpenSSL reports it), undefined before the
 * handshake and null after close. A suite without a known OpenSSL name
 * throws the "not supported yet" error. +1. */
ScrDyn *scr_tls_sock_get_cipher(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || scr_net_sock_destroyed(s)) return scr_dyn_new_null();
  if (!t->established) return scr_dyn_retain(scr_dyn_undefined());
  const char *suite = mbedtls_ssl_get_ciphersuite(&t->ssl);
  if (suite == NULL) return scr_dyn_retain(scr_dyn_undefined());
  /* mbedTLS spells "TLS1-3-AES-128-GCM-SHA256" and
   * "TLS-ECDHE-RSA-WITH-AES-128-GCM-SHA256"; the IANA names use '_' */
  char iana[128];
  const char *src = strncmp(suite, "TLS1-3-", 7) == 0 ? suite + 7 : suite;
  int n = snprintf(iana, sizeof iana, "%s%s", src == suite ? "" : "TLS_", src);
  for (int i = 0; i < n; i++)
    if (iana[i] == '-') iana[i] = '_';
  const char *name = scr_tls_openssl_cipher_name(iana);
  if (name == NULL) {
    char msg[192];
    int len = snprintf(msg, sizeof msg, "tlsSocket.getCipher() for %s is not supported yet", iana);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, "SC2020");
    return NULL;
  }
  bool v13 = strncmp(suite, "TLS1-3-", 7) == 0;
  ScrDyn *out = scr_dyn_new_obj();
  ScrStr *a = scr_str_new(name, strlen(name));
  scr_dyn_obj_set(out, "name", 4, scr_dyn_new_str(a));
  scr_str_release(a);
  ScrStr *b = scr_str_new(iana, strlen(iana));
  scr_dyn_obj_set(out, "standardName", 12, scr_dyn_new_str(b));
  scr_str_release(b);
  /* OpenSSL's SSL_CIPHER_get_version: the suite's minimum protocol */
  const char *version = v13 ? "TLSv1.3" : "TLSv1.2";
  ScrStr *c = scr_str_new(version, strlen(version));
  scr_dyn_obj_set(out, "version", 7, scr_dyn_new_str(c));
  scr_str_release(c);
  return out;
}

/* tlsSocket.alpnProtocol: null before the handshake, then the
 * negotiated protocol or false. +1. */
ScrDyn *scr_tls_sock_alpn_protocol(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !t->established) return scr_dyn_new_null();
  const char *p = mbedtls_ssl_get_alpn_protocol(&t->ssl);
  if (p == NULL) return scr_dyn_new_bool(false);
  ScrStr *str = scr_str_new(p, strlen(p));
  ScrDyn *d = scr_dyn_new_str(str);
  scr_str_release(str);
  return d;
}

/* secureConnect: a client socket's 'connect' list fires at establishment
 * (scr_net.c's transport pump), Node's secureConnect timing. Once TCP is up
 * (a socket tls.connect({ socket }) took over is up from the start) the
 * listener waits for the handshake instead. Server-side sockets never emit
 * it. */
static void scr_tls_add_secure_connect(ScrNetSocket *s, ScrTlsSock *t, ScrClosure *cb, bool once) {
  if (t->srv != NULL) {
    scr_closure_release(cb);
    return;
  }
  if (scr_net_sock_connecting(s)) scr_net_sock_on_connect(s, cb, once);
  else scr_net_sock_on_established(s, cb, once);
}

void scr_tls_sock_on_secure_connect(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL) {
    scr_closure_release(cb); /* a plain socket never fires it, like Node */
    return;
  }
  scr_tls_add_secure_connect(s, t, cb, once);
}

/* The 'secure' event: the handshake completed (after secureConnect on a
 * client). A plain socket never emits it, and a registration after the
 * handshake comes too late, as in Node. */
void scr_tls_sock_on_secure(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || t->established || t->settled) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&t->secure_ls, cb, NULL, once);
}

void scr_tls_sock_on_session(ScrNetSocket *s, ScrClosure *cb /*moves*/, void *fn, bool once) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL) {
    scr_closure_release(cb); /* a plain socket never fires it, like Node */
    return;
  }
  if (t->settled) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&t->session_ls, cb, fn, once);
  if (t->established) scr_tls_fire_session(t); /* the ticket already arrived */
}

static bool scr_tls_dynh_get(ScrNetSocket *s, const char *key, ScrDyn **out) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL) return false; /* a plain socket: the net dispatch answers */
  if (strcmp(key, "authorized") == 0) {
    bool a = t->established && t->cli != NULL && t->cli->verify_recorded &&
             mbedtls_ssl_get_verify_result(&t->ssl) == 0;
    *out = scr_dyn_new_bool(a);
    return true;
  }
  if (strcmp(key, "alpnProtocol") == 0) {
    *out = scr_tls_sock_alpn_protocol(s);
    return true;
  }
  if (strcmp(key, "authorizationError") == 0) {
    if (!t->established || t->cli == NULL || !t->cli->verify_recorded ||
        mbedtls_ssl_get_verify_result(&t->ssl) == 0) {
      *out = scr_dyn_new_null();
      return true;
    }
    const char *code = scr_tls_auth_code(t);
    ScrStr *str = scr_str_new(code, strlen(code));
    *out = scr_dyn_new_str(str);
    scr_str_release(str);
    return true;
  }
  return false;
}

static bool scr_tls_dynh_on(ScrNetSocket *s, const char *event, const ScrDyn *cb, bool once) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL) return false;
  if (strcmp(event, "secureConnect") == 0) {
    scr_tls_add_secure_connect(s, t, scr_dyn_listener_closure0(cb), once);
    return true;
  }
  if (strcmp(event, "secure") == 0) {
    scr_tls_sock_on_secure(s, scr_dyn_listener_closure0(cb), once);
    return true;
  }
  if (strcmp(event, "session") == 0) {
    scr_net_ls_add(&t->session_ls, scr_dyn_listener_closure_data(cb),
                   (void *)&scr_dyn_listener_fire_data, once);
    /* a late registration on an established socket fires directly (the
     * ticket already arrived — nothing further would trigger it) */
    if (t->established) scr_tls_fire_session(t);
    return true;
  }
  return false;
}

static bool scr_tls_dynh_invoke(ScrNetSocket *s, const char *method, ScrDyn *const *args,
                                 size_t argc, ScrDyn **out) {
  (void)args;
  (void)argc;
  if (scr_tls_sock_of(s) == NULL) return false;
  if (strcmp(method, "getProtocol") == 0) {
    *out = scr_tls_sock_get_protocol(s);
    return true;
  }
  if (strcmp(method, "getCipher") == 0) {
    *out = scr_tls_sock_get_cipher(s);
    return true;
  }
  static const char *const tls_methods[] = {
    "getPeerCertificate", "getCertificate", "getSession",
    "getTLSTicket", "getEphemeralKeyInfo", "getFinished", "getPeerFinished",
    "getSharedSigalgs", "getPeerX509Certificate", "getX509Certificate",
    "exportKeyingMaterial", "isSessionReused", "renegotiate", "setMaxSendFragment",
    "enableTrace", "disableRenegotiation", "setServername", "setSession", NULL,
  };
  for (size_t i = 0; tls_methods[i] != NULL; i++) {
    if (strcmp(method, tls_methods[i]) == 0) {
      char msg[160];
      int n = snprintf(msg, sizeof msg,
                       "'TLSSocket.prototype.%s' on a dynamic value is not supported yet", method);
      scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
      *out = NULL;
      return true;
    }
  }
  return false;
}

static const ScrNetDynhTlsHooks SCR_TLS_DYNH = {
  &scr_tls_dynh_get,
  &scr_tls_dynh_on,
  &scr_tls_dynh_invoke,
};
