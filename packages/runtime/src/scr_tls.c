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
 * SILENTLY — Node's default for 'tlsClientError' with no listener, which
 * is what portless observes (it registers none).
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
 * Bounds (SEMANTICS.md divergence 55): no session resumption or
 * tickets, no renegotiation/post-handshake auth, no client
 * certificates, hostname verification is skipped for IP-literal peers
 * (mbedTLS has no IP-SAN matching in 3.6), and non-verify client
 * handshake failures carry a generic message where Node prints an
 * OpenSSL one. */
#include "scr_runtime.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
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
 * and the reset arms (CONN_RESET → silent server teardown / the client's
 * socket-hang-up classification) are Node's rendering for each. Winsock
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

static mbedtls_entropy_context scr_tls_entropy;
static mbedtls_ctr_drbg_context scr_tls_drbg;
static bool scr_tls_rng_ready = false;

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

/* ── SecureContext (tls.createSecureContext) ─────────────────────────── */

/* An opaque refcounted parsed cert/key pair — what an SNI callback
 * answers with; the handshake serves it via mbedtls_ssl_set_hs_own_cert. */
struct ScrSecureCtx {
  size_t rc;
  mbedtls_x509_crt cert;
  mbedtls_pk_context pk;
};

#ifdef SCR_RC_AUDIT
static long scr_live_secure_ctx = 0;
long scr_secure_ctx_live_count(void) { return scr_live_secure_ctx; }
#endif

ScrSecureCtx *scr_tls_create_secure_context(const char *cert, size_t cert_len,
                                             const char *key, size_t key_len) {
  scr_tls_rng_init();
  ScrSecureCtx *c = calloc(1, sizeof *c);
  if (!c) scr_tls_oom();
  c->rc = 1;
  mbedtls_x509_crt_init(&c->cert);
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
  mbedtls_pk_free(&c->pk);
  free(c);
#ifdef SCR_RC_AUDIT
  scr_live_secure_ctx--;
#endif
}

void *scr_secure_ctx_retain_v(void *p) { return scr_secure_ctx_retain((ScrSecureCtx *)p); }
void scr_secure_ctx_release_v(void *p) { scr_secure_ctx_release((ScrSecureCtx *)p); }

/* ── the server config (one per created server, rc'd) ────────────────── */

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
  mbedtls_ssl_conf_authmode(&s->conf, MBEDTLS_SSL_VERIFY_NONE); /* no client certs, Node's default */
  if (mbedtls_ssl_conf_own_cert(&s->conf, &s->cert, &s->pk) != 0) {
    scr_tls_bad_material("certificate/key pair", 0);
  }
  if (alpn_http11) mbedtls_ssl_conf_alpn_protocols(&s->conf, SCR_TLS_ALPN_HTTP11);
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
  mbedtls_pk_free(&s->pk);
  free(s);
}

static void scr_tls_srv_release_v(void *p) { scr_tls_srv_release((ScrTlsSrv *)p); }

/* ── the client config (one per https.request, owned by its tctx) ────── */

typedef struct ScrTlsCli {
  mbedtls_ssl_config conf;
  mbedtls_x509_crt ca;
  char *hostname; /* NULL for IP-literal peers (no SNI, no name check) */
  /* true when the handshake RECORDS verification (VERIFY_OPTIONAL /
   * VERIFY_REQUIRED) — socket.authorized answers from the result; a
   * VERIFY_NONE socket (the https client's rejectUnauthorized:false)
   * never verified, so authorized answers false like Node's. */
  bool verify_recorded;
} ScrTlsCli;

/* The default trust anchors when no `ca` option is given: the host trust
 * store, standing in for Node's compiled-in Mozilla roots, plus
 * NODE_EXTRA_CA_CERTS. Windows certificates live as DER entries in the
 * current user's logical ROOT store, which includes the inherited machine
 * roots; mbedTLS copies each successfully parsed entry into its own chain.
 * POSIX hosts probe the established bundle spellings — /etc/ssl/cert.pem
 * first (macOS ships it; Alpine links it), then Debian/Ubuntu's
 * ca-certificates.crt, Fedora/RHEL's ca-bundle.crt, and openSUSE's
 * ca-bundle.pem. */
static mbedtls_x509_crt scr_tls_system_roots;
static bool scr_tls_system_roots_loaded = false;

/* setDefaultCACertificates' replacement anchors (scr_tls_ca.c — always
 * compiled alongside this unit): parsed lazily per generation, so each
 * set re-parses once and every later dial reuses the chain. An EMPTY
 * replacement keeps an initialized, certificate-free chain — every
 * verification fails, Node's own consequence of trusting nothing. */
static mbedtls_x509_crt scr_tls_override_roots;
static uint64_t scr_tls_override_parsed_gen = 0;

#ifdef _WIN32
static void scr_tls_add_windows_root(void *ctx, const unsigned char *der, size_t len) {
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
    scr_tls_ca_windows_roots(scr_tls_add_windows_root, &scr_tls_system_roots);
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
static ScrTlsCli *scr_tls_cli_new2(ScrStr *host, bool reject_unauthorized, const char *ca,
                                    size_t ca_len, bool verify_optional) {
  scr_tls_rng_init();
  ScrTlsCli *c = calloc(1, sizeof *c);
  if (!c) scr_tls_oom();
  mbedtls_ssl_config_init(&c->conf);
  mbedtls_x509_crt_init(&c->ca);
  if (mbedtls_ssl_config_defaults(&c->conf, MBEDTLS_SSL_IS_CLIENT,
                                  MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
    scr_tls_oom();
  }
  mbedtls_ssl_conf_rng(&c->conf, mbedtls_ctr_drbg_random, &scr_tls_drbg);
  c->verify_recorded = reject_unauthorized || verify_optional;
  if (ca_len > 0) {
    int r = scr_tls_parse_crt(&c->ca, ca, ca_len);
    if (r != 0) scr_tls_bad_material("ca certificate", r);
  }
  if (!reject_unauthorized && !verify_optional) {
    mbedtls_ssl_conf_authmode(&c->conf, MBEDTLS_SSL_VERIFY_NONE);
  } else {
    mbedtls_ssl_conf_authmode(&c->conf, reject_unauthorized ? MBEDTLS_SSL_VERIFY_REQUIRED
                                                            : MBEDTLS_SSL_VERIFY_OPTIONAL);
    mbedtls_ssl_conf_ca_chain(&c->conf, ca_len > 0 ? &c->ca : scr_tls_system_ca(), NULL);
  }
  /* SNI + name verification want the DNS name; an IP literal gets
   * neither (mbedTLS 3.6 has no IP-SAN matching — SEMANTICS.md). */
  struct in_addr a4;
  struct in6_addr a6;
  const char *h = host->len > 0 ? host->data : "localhost";
  if (inet_pton(AF_INET, h, &a4) != 1 && inet_pton(AF_INET6, h, &a6) != 1) {
    c->hostname = strdup(h);
    if (!c->hostname) scr_tls_oom();
  }
  return c;
}

static ScrTlsCli *scr_tls_cli_new(ScrStr *host, bool reject_unauthorized, const char *ca,
                                   size_t ca_len) {
  return scr_tls_cli_new2(host, reject_unauthorized, ca, ca_len, false);
}

static void scr_tls_cli_free(ScrTlsCli *c) {
  mbedtls_ssl_config_free(&c->conf);
  mbedtls_x509_crt_free(&c->ca);
  free(c->hostname);
  free(c);
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
} ScrTlsSock;

/* The client verify callback: records WHERE verification failed and how
 * the presented chain is shaped, per certificate (depth 0 = leaf), so
 * the failure message can be Node's exact split. Never overrides flags —
 * the verdict stays mbedTLS's. */
static int scr_tls_vrfy_cb(void *ctx, mbedtls_x509_crt *crt, int depth, uint32_t *flags) {
  ScrTlsSock *t = (ScrTlsSock *)ctx;
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
static int scr_tls_bio_send(void *ctx, const unsigned char *buf, size_t len) {
  ScrTlsSock *t = (ScrTlsSock *)ctx;
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

static int scr_tls_bio_recv(void *ctx, unsigned char *buf, size_t len) {
  ScrTlsSock *t = (ScrTlsSock *)ctx;
  int fd = scr_net_sock_fd(t->sock);
  if (fd < 0) return MBEDTLS_ERR_NET_CONN_RESET;
  /* bytes a consumer peeked and unshifted (the demux path) re-enter the
   * stream here, ahead of the kernel's */
  size_t took = scr_net_sock_take_buffered(t->sock, (char *)buf, len);
  if (took > 0) return (int)took;
  ssize_t n = read(fd, buf, len);
  if (n >= 0) return (int)n; /* 0 = EOF; mbedTLS maps it to CONN_EOF */
  if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
    return MBEDTLS_ERR_SSL_WANT_READ;
  }
  if (errno == ECONNRESET) return MBEDTLS_ERR_NET_CONN_RESET;
  return MBEDTLS_ERR_NET_RECV_FAILED;
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
static ScrTlsSock *scr_tls_current = NULL;

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
 * malformed (the real handshake will judge it). */
static int scr_tls_parse_ch_body(const unsigned char *b, size_t n, char *out, size_t out_cap) {
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
    if (et == 0) {
      /* server_name: list length(2), then entry type(1) + length(2) + name */
      if (el < 5 || b[i + 2] != 0) return 2;
      size_t nl = ((size_t)b[i + 3] << 8) | b[i + 4];
      if (nl == 0 || nl + 5 > el || nl + 1 > out_cap) return 2;
      memcpy(out, b + i + 5, nl);
      out[nl] = 0;
      return 1;
    }
    i += el;
  }
  return 2;
}

/* Reassemble the handshake stream from the raw record flight and look for
 * the server_name extension. 0 = need more bytes; 1 = found (out set);
 * 2 = no SNI / not parseable (serve the default cert). */
static int scr_tls_parse_sni(const unsigned char *buf, size_t len, char *out, size_t out_cap) {
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
        int r = scr_tls_parse_ch_body(hs + 4, chlen, out, out_cap);
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
      int r = scr_tls_parse_sni(t->hello, t->hello_len, servername, sizeof servername);
      if (r == 2 || t->hello_len > 65536) {
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
      if (n == 0) { /* the peer died mid-hello: silent server-side teardown */
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
    /* Node destroys the socket ('tlsClientError'; silent with no
     * listener — what portless observes). */
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

static int scr_tls_handshake(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  if (t->sni_state == SCR_SNI_COLLECT) {
    t->in_handshake = true;
    int c = scr_tls_sni_collect(t);
    t->in_handshake = false;
    if (c <= 0) return c;
  }
  if (t->sni_state == SCR_SNI_WAIT) return 0; /* the callback is deciding */
  scr_tls_current = t;
  int r = mbedtls_ssl_handshake(&t->ssl);
  scr_tls_current = NULL;
  if (r == 0) return 1;
  if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return 0;
  if (t->srv != NULL) {
    /* Node's server default: 'tlsClientError' with no listener destroys
     * the socket silently — exactly what portless (no listener) sees. */
    scr_net_sock_transport_error(t->sock, NULL);
    return -1;
  }
  char msg[160];
  if (r == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED) {
    scr_tls_verify_msg(t, msg, sizeof msg);
  } else if (r == MBEDTLS_ERR_SSL_CONN_EOF || r == MBEDTLS_ERR_NET_CONN_RESET) {
    /* the peer died mid-handshake: the http layer's own premature-close
     * shape ('socket hang up') is Node's message — teardown silently at
     * this level and let the closed hook classify it */
    scr_net_sock_transport_error(t->sock, NULL);
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
  (void)mbedtls_ssl_close_notify(&t->ssl); /* best effort; EAGAIN drops it */
}

static void scr_tls_free(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  mbedtls_ssl_free(&t->ssl);
  if (t->srv) scr_tls_srv_release(t->srv);
  if (t->cli) scr_tls_cli_free(t->cli);
  scr_net_ls_drop(&t->session_ls);
  free(t->hello);
  scr_secure_ctx_release(t->sni_ctx);
  free(t);
}

static const ScrNetTransportOps SCR_TLS_OPS = {
  .xread = scr_tls_xread,
  .xwrite = scr_tls_xwrite,
  .handshake = scr_tls_handshake,
  .on_established = scr_tls_on_established,
  .pending = scr_tls_pending,
  .shutdown_write = scr_tls_shutdown_write,
  .free = scr_tls_free,
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
  t->sock = sock;
  t->srv = scr_tls_srv_retain(srv);
  if (srv->sni_cb != NULL) t->sni_state = SCR_SNI_COLLECT; /* pre-parse the hello */
  mbedtls_ssl_set_bio(&t->ssl, t, scr_tls_bio_send, scr_tls_bio_recv, NULL);
  scr_net_sock_set_transport(sock, &SCR_TLS_OPS, t);
}

ScrNetServer *scr_tls_create_server(const char *cert, size_t cert_len, const char *key,
                                     size_t key_len, ScrClosure *handler /*moves, nullable*/,
                                     ScrNetConnFn fn) {
  ScrTlsSrv *srv = scr_tls_srv_new(cert, cert_len, key, key_len, false);
  ScrNetServer *s = scr_net_create_server(handler, fn);
  scr_net_server_set_native_conn(s, &scr_tls_srv_on_conn, srv, &scr_tls_srv_release_v);
  scr_net_server_defer_connections(s); /* the handler is 'secureConnection' */
  return s;
}

ScrNetServer *scr_https_create_server(const char *cert, size_t cert_len, const char *key,
                                       size_t key_len, ScrClosure *handler /*moves*/,
                                       ScrHttpReqFn fn) {
  ScrNetServer *s = scr_http_create_server(handler, fn);
  ScrTlsSrv *srv = scr_tls_srv_new(cert, cert_len, key, key_len, true /* ALPN http/1.1 */);
  /* wrap the parser hook: TLS first, parser at establishment */
  scr_net_server_get_native_conn(s, &srv->inner_conn, &srv->inner_ctx, &srv->inner_ctx_free);
  scr_net_server_set_native_conn(s, &scr_tls_srv_on_conn, srv, &scr_tls_srv_release_v);
  scr_net_server_defer_connections(s);
  return s;
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
  if (cli->hostname != NULL) (void)mbedtls_ssl_set_hostname(&t->ssl, cli->hostname);
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

ScrHttpClientReq *scr_https_request(ScrStr *host /*borrowed*/, double port,
                                     ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                     double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                     bool auto_end, bool reject_unauthorized,
                                     const char *ca /*borrowed, len 0 = none*/, size_t ca_len,
                                     ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn) {
  ScrTlsCli *cli = scr_tls_cli_new(host, reject_unauthorized, ca, ca_len);
  return scr_http_request_ex(host, port, path, method, timeout_ms, header_pairs, auto_end, cb,
                              fn, 443, &scr_tls_cli_wrap, cli);
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
                                           const char *ca /*borrowed, len 0 = none*/, size_t ca_len,
                                           const ScrDyn *agent /*borrowed*/,
                                           ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn) {
  ScrTlsCli *cli = scr_tls_cli_new(host, reject_unauthorized, ca, ca_len);
  return scr_http_request_agent_ex(host, port, path, method, timeout_ms, header_pairs, auto_end,
                                    agent, cb, fn, 443, &scr_tls_cli_wrap, cli);
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
  if (v->kind == SCR_DYN_STR) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)v->v.str->len);
    memcpy(b->data, v->v.str->data, v->v.str->len);
    return b;
  }
  if (v->kind == SCR_DYN_BYTES) return scr_dyn_bytes_copy_out(v);
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
      else if (e->kind == SCR_DYN_BYTES) total += e->v.bytes->len + 1;
      else {
        scr_dyn_arg_type_fail(what, "of type string or an instance of Buffer or Uint8Array", e);
        return NULL;
      }
    }
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)total);
    size_t off = 0;
    for (size_t i = 0; i < v->v.arr.len; i++) {
      const ScrDyn *e = v->v.arr.items[i];
      const char *p = e->kind == SCR_DYN_STR ? e->v.str->data : (const char *)e->v.bytes->data;
      size_t n = e->kind == SCR_DYN_STR ? e->v.str->len : e->v.bytes->len;
      memcpy(b->data + off, p, n);
      off += n;
      b->data[off++] = '\n'; /* PEM blocks join on line boundaries */
    }
    return b;
  }
  scr_dyn_arg_type_fail(what, "of type string or an instance of Buffer or Uint8Array", v);
  return NULL;
}

/* The literal path's runtime-valued cert/key extraction (the compiler's
 * tls.pemDyn libCall): `what` arrives precomposed. undefined throws — the
 * literal walk required the member's presence. */
ScrBytes *scr_tls_pem_from_dyn(const ScrDyn *v, const char *what) {
  if (v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, what);
    scr_jb_puts(&b, " holding undefined has no static lowering — pass PEM material (a string or a Buffer)");
    scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
    return NULL;
  }
  return scr_tls_pem_dyn(v, what, false);
}

/* The tls/https createServer documented keys OUTSIDE the implemented set
 * (cert/key/ca/requestCert/rejectUnauthorized/SNICallback walk their own
 * arms below): present-with-a-value throws the runtime fence — an option
 * that changes Node-observable behavior must work or fence, never
 * silently drop. Undocumented keys drop, exactly Node. */
static const char *const SCR_TLS_SRV_FENCED_OPTIONS[] = {
  "ALPNProtocols", "ALPNCallback", "allowHalfOpen", "ciphers",
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
  static const char *const VERSION_OPTS[] = { "minVersion", "maxVersion", NULL };
  for (size_t i = 0; VERSION_OPTS[i] != NULL; i++) {
    const ScrDyn *v = scr_dyn_obj_get(opts, VERSION_OPTS[i], strlen(VERSION_OPTS[i]));
    if (v == NULL || v->kind == SCR_DYN_UNDEF) continue;
    bool valid = false;
    if (v->kind == SCR_DYN_STR) {
      static const char *const KNOWN[] = { "TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3", NULL };
      for (size_t k = 0; KNOWN[k] != NULL; k++) {
        if (v->v.str->len == strlen(KNOWN[k]) && memcmp(v->v.str->data, KNOWN[k], v->v.str->len) == 0) {
          valid = true;
          break;
        }
      }
    }
    if (!valid) {
      /* %j: strings render JSON-quoted, everything else inspect-lite. */
      char rendered[96];
      if (v->kind == SCR_DYN_STR) {
        snprintf(rendered, sizeof rendered, "\"%.*s\"",
                 (int)(v->v.str->len < 80 ? v->v.str->len : 80), v->v.str->data);
      } else {
        /* %j over non-strings: JSON.stringify's scalar renderings. */
        char lite[64];
        snprintf(rendered, sizeof rendered, "%s", scr_dyn_inspect_lite(v, lite, sizeof lite));
      }
      char msg[192];
      int len = snprintf(msg, sizeof msg, "%s is not a valid %s TLS protocol version",
                         rendered, VERSION_OPTS[i][2] == 'n' ? "minimum" : "maximum");
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_TLS_INVALID_PROTOCOL_VERSION");
      return false;
    }
  }
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
bool scr_tls_srv_opts_walk(const ScrDyn *opts, const char *api, ScrBytes **cert_out,
                            ScrBytes **key_out) {
  *cert_out = NULL;
  *key_out = NULL;
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
      /* the server's `ca` verifies CLIENT certificates — inert without
       * requestCert (which fences below), so Node-observably droppable */
      continue;
    }
    if (strcmp(e->key, "requestCert") == 0) {
      if (scr_tls_dyn_truthy(v)) {
        scr_tls_opt_fence(api, "requestCert",
                          "client-certificate handshakes are not modeled (SEMANTICS.md divergence 55) — requestCert stays at Node's false default");
        ok = false;
      }
      continue;
    }
    if (strcmp(e->key, "rejectUnauthorized") == 0) {
      continue; /* meaningful only with requestCert, which fences */
    }
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
  }
  return ok;
}

/* createSecureContext over a RUNTIME options record: Node's typed
 * validations first (scr_tls_opts_validate), then the pem walk — a bag
 * that validates AND carries both cert and key builds the real context;
 * everything else met its ladder error or the walk's per-key fence.
 * +1, or NULL with the exception pending. */
ScrSecureCtx *scr_tls_create_secure_context_dyn(const ScrDyn *opts /*borrowed*/) {
  ScrBytes *cert, *key;
  if (!scr_tls_srv_opts_walk(opts, "tls.createSecureContext", &cert, &key)) return NULL;
  ScrSecureCtx *c = scr_tls_create_secure_context((const char *)cert->data, cert->len,
                                                   (const char *)key->data, key->len);
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
  ScrBytes *cert, *key;
  if (!scr_tls_srv_opts_walk(opts, "tls.createServer", &cert, &key)) {
    scr_closure_release(handler);
    return NULL;
  }
  ScrNetServer *s = scr_tls_create_server((const char *)cert->data, cert->len,
                                           (const char *)key->data, key->len, handler, fn);
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
  if (!scr_tls_srv_opts_walk(opts, "https.createServer", &cert, &key)) {
    scr_closure_release(handler);
    return NULL;
  }
  ScrNetServer *s = scr_https_create_server((const char *)cert->data, cert->len,
                                             (const char *)key->data, key->len, handler, fn);
  if (has_timeout_buffer) scr_net_server_timeout_set(s, 4, timeout_buffer);
  scr_bytes_release(cert);
  scr_bytes_release(key);
  return s;
}

/* ── tls.connect (the TLS client socket) ──────────────────────────────── */

/* tls.connect's documented keys outside the implemented set: present
 * throws (the server walk's stance). */
static const char *const SCR_TLS_CONNECT_FENCED_OPTIONS[] = {
  "ALPNProtocols", "allowHalfOpen", "autoSelectFamily",
  "autoSelectFamilyAttemptTimeout", "cert", "checkServerIdentity",
  "ciphers", "clientCertEngine", "crl", "dhparam", "ecdhCurve",
  "enableTrace", "family", "fd", "hints", "highWaterMark",
  "honorCipherOrder", "keepAlive", "keepAliveInitialDelay", "key",
  "localAddress", "localPort", "lookup", "maxVersion", "minDHSize",
  "minVersion", "noDelay", "onread", "passphrase", "path", "pfx",
  "privateKeyEngine", "privateKeyIdentifier", "pskCallback", "readable",
  "secureContext", "secureOptions", "secureProtocol", "session",
  "sessionIdContext", "sigalgs", "signal", "socket", "ticketKeys",
  "timeout", "writable", NULL,
};

ScrNetSocket *scr_tls_connect_dyn(double port, ScrStr *host /*borrowed, nullable*/,
                                   const ScrDyn *opts /*borrowed, nullable*/,
                                   ScrClosure *cb /*moves, nullable*/) {
  scr_tls_rng_init();
  bool reject = true;
  ScrBytes *ca = NULL;
  const ScrStr *servername = NULL;
  const ScrStr *opt_host = NULL;
  bool ok = true;
  if (opts != NULL && opts->kind != SCR_DYN_UNDEF && opts->kind != SCR_DYN_NULL) {
    if (opts->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "of type object", opts);
      ok = false;
    }
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
        ca = scr_tls_pem_dyn(v, "a tls.connect 'ca' option", true);
        if (ca == NULL) ok = false;
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
                            "port/host/rejectUnauthorized/ca/servername are the honestly-implemented members of a runtime options record");
          ok = false;
          break;
        }
      }
      /* anything else: an undocumented key, dropped like Node drops it */
    }
  }
  if (ok && port < 0) {
    scr_dyn_arg_type_fail("options.port", "of type number", scr_dyn_undefined());
    ok = false;
  }
  if (!ok) {
    scr_bytes_release(ca);
    scr_closure_release(cb);
    return NULL;
  }
  ScrStr *dial_host = (ScrStr *)(host != NULL && host->len > 0 ? host : opt_host);
  /* SNI + verification see the servername when given, the host name
   * otherwise (Node's servername default). */
  ScrStr *verify_host = (ScrStr *)(servername != NULL ? servername : dial_host);
  ScrStr *localhost_fallback = NULL;
  if (verify_host == NULL) {
    localhost_fallback = scr_str_new("localhost", 9);
    verify_host = localhost_fallback;
  }
  /* Resolve for the dial only (the http client's rule): verify_host above
   * already holds the NAME, which is what SNI and certificate verification
   * must see. A null dial_host stays null — scr_net_connect's own arm. */
  ScrStr *dial_addr = dial_host != NULL ? scr_net_blocking_lookup(dial_host) : NULL;
  ScrNetSocket *s = scr_net_connect(port, dial_addr, cb); /* cb fires post-handshake — secureConnect */
  if (dial_addr) scr_str_release(dial_addr);
  ScrTlsCli *cli = scr_tls_cli_new2(verify_host, reject,
                                     ca != NULL ? (const char *)ca->data : NULL,
                                     ca != NULL ? ca->len : 0, !reject);
  scr_tls_cli_wrap(s, cli);
  scr_str_release(localhost_fallback);
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
 * the authority host; `ca` replaces the trust anchors ("" = none) and
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

bool scr_tls_sock_authorized(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  return t != NULL && t->established && t->cli != NULL && t->cli->verify_recorded &&
         mbedtls_ssl_get_verify_result(&t->ssl) == 0;
}

ScrStr *scr_tls_sock_auth_error(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !t->established || t->cli == NULL || !t->cli->verify_recorded ||
      mbedtls_ssl_get_verify_result(&t->ssl) == 0) {
    return NULL; /* the null arm — authorized, or never verified */
  }
  const char *code = scr_tls_auth_code(t);
  return scr_str_new(code, strlen(code));
}

void scr_tls_sock_on_secure_connect(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  if (scr_tls_sock_of(s) == NULL) {
    scr_closure_release(cb); /* a plain socket never fires it, like Node */
    return;
  }
  scr_net_sock_on_connect(s, cb, once); /* fires at establishment — secureConnect timing */
}

void scr_tls_sock_on_session(ScrNetSocket *s, ScrClosure *cb /*moves*/, void *fn, bool once) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL) {
    scr_closure_release(cb); /* a plain socket never fires it, like Node */
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
    /* a TLS socket's 'connect' list fires at establishment — exactly
     * Node's secureConnect timing (scr_net.c's transport pump) */
    scr_net_sock_on_connect(s, scr_dyn_listener_closure0(cb), once);
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
  static const char *const tls_methods[] = {
    "getPeerCertificate", "getCertificate", "getCipher", "getProtocol", "getSession",
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
