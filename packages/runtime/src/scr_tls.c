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
 * Bounds (SEMANTICS.md divergence 55): no renegotiation/post-handshake
 * auth, and non-verify client handshake failures carry a generic message
 * where Node prints an OpenSSL one. Sessions resume through tickets in
 * both versions — tls.connect's session option and isSessionReused — and a
 * session Buffer is the engine's own serialization, not OpenSSL's bytes.
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
#include "mbedtls/md.h"
#include "mbedtls/net_sockets.h" /* the MBEDTLS_ERR_NET_* codes the BIOs answer */
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"
#include "mbedtls/ssl.h"
#include "mbedtls/ssl_ticket.h"
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

/* A bounded substring search over a PEM bundle that is not NUL-terminated. */
static const char *scr_tls_find_bytes(const char *hay, size_t hay_len, const char *needle) {
  size_t n = strlen(needle);
  if (n == 0 || hay_len < n) return NULL;
  for (size_t i = 0; i + n <= hay_len; i++)
    if (memcmp(hay + i, needle, n) == 0) return hay + i;
  return NULL;
}

/* A CA bundle entry: OpenSSL reads the PEM blocks in order and stops at the
 * first one it cannot parse, keeping the blocks before it. mbedTLS skips a
 * bad block and keeps parsing later ones, so the blocks are fed one at a
 * time. */
static int scr_tls_parse_ca_segment(mbedtls_x509_crt *crt, const char *pem, size_t len) {
  static const char begin[] = "-----BEGIN CERTIFICATE-----";
  static const char end[] = "-----END CERTIFICATE-----";
  const char *at = pem;
  const char *limit = pem + len;
  bool any = false;
  for (;;) {
    const char *b = scr_tls_find_bytes(at, (size_t)(limit - at), begin);
    if (b == NULL) break;
    const char *e = scr_tls_find_bytes(b, (size_t)(limit - b), end);
    if (e == NULL) break;
    e += sizeof end - 1;
    int one = scr_tls_parse_crt(crt, b, (size_t)(e - b));
    if (one != 0) return any ? 0 : one;
    any = true;
    at = e;
  }
  if (any) return 0;
  return scr_tls_parse_crt(crt, pem, len); /* a bare DER certificate */
}

/* CA array entries are added separately by Node: a malformed entry must not
 * stop the entries after it, while one entry's string still stops at its
 * first malformed block (scr_tls_parse_ca_segment). A `ca` array is read
 * into a framed buffer — magic, entry count, then each entry's length and
 * bytes — so the boundaries survive the trip through one ScrBytes. Framing
 * that does not consume the buffer exactly is not ours and is read as one
 * bundle. */
#define SCR_TLS_CA_ARRAY_MAGIC "\x01" "SCRIPTC_CA_ARRAY" "\x01"
#define SCR_TLS_CA_ARRAY_MAGIC_LEN (sizeof SCR_TLS_CA_ARRAY_MAGIC - 1)
#define SCR_TLS_CA_ARRAY_LEN_BYTES 8u
static int scr_tls_parse_ca_bundle(mbedtls_x509_crt *crt, const char *pem, size_t len) {
  if (len >= SCR_TLS_CA_ARRAY_MAGIC_LEN + SCR_TLS_CA_ARRAY_LEN_BYTES &&
      memcmp(pem, SCR_TLS_CA_ARRAY_MAGIC, SCR_TLS_CA_ARRAY_MAGIC_LEN) == 0) {
    const char *p = pem + SCR_TLS_CA_ARRAY_MAGIC_LEN;
    const char *limit = pem + len;
    uint64_t count;
    memcpy(&count, p, SCR_TLS_CA_ARRAY_LEN_BYTES);
    p += SCR_TLS_CA_ARRAY_LEN_BYTES;
    bool any = false, framed = true;
    int last_error = 0;
    for (uint64_t i = 0; i < count; i++) {
      if ((size_t)(limit - p) < SCR_TLS_CA_ARRAY_LEN_BYTES) { framed = false; break; }
      uint64_t n;
      memcpy(&n, p, SCR_TLS_CA_ARRAY_LEN_BYTES);
      p += SCR_TLS_CA_ARRAY_LEN_BYTES;
      if (n > (uint64_t)(limit - p)) { framed = false; break; }
      int r = scr_tls_parse_ca_segment(crt, p, (size_t)n);
      if (r == 0) any = true;
      else if (last_error == 0) last_error = r;
      p += n;
    }
    if (framed && p == limit)
      return any ? 0 : last_error != 0 ? last_error : MBEDTLS_ERR_X509_CERT_UNKNOWN_FORMAT;
  }
  return scr_tls_parse_ca_segment(crt, pem, len);
}

/* tls.connect's crl option (one PEM/DER CRL, or an array whose PEM blocks
 * join on line boundaries): mbedTLS parses the whole PEM bundle. */
static bool scr_tls_crl_same_issuer(const mbedtls_x509_crl *a, const mbedtls_x509_crl *b) {
  return a->issuer_raw.len == b->issuer_raw.len &&
         (a->issuer_raw.len == 0 ||
          memcmp(a->issuer_raw.p, b->issuer_raw.p, a->issuer_raw.len) == 0);
}

static int scr_tls_parse_crl(mbedtls_x509_crl *crl, const char *pem, size_t len) {
  unsigned char *buf = malloc(len + 1);
  if (!buf) scr_tls_oom();
  memcpy(buf, pem, len);
  buf[len] = 0;
  int r = mbedtls_x509_crl_parse(crl, buf, len + 1);
  free(buf);
  if (r != 0) return r;
  /* Every CRL in the bundle is kept. OpenSSL's store can hold several CRLs
   * with one issuer name (a key-rollover CA and its predecessor share a DN
   * but not a key), and it selects the one whose signature verifies under
   * the issuer it is checking; reducing a name to one CRL here would drop
   * the root's CRL when a self-issued intermediate's CRL came first. The
   * selection lives in scr_tls_crl_check_chain. */
  return 0;
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
  scr_stdout_settle();
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
  /* the secureProtocol/minVersion/maxVersion range the context was built
   * with; a socket created from it uses the same range */
  int min_version;
  int max_version;
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
  c->min_version = 12;
  c->max_version = 13;
  /* An absent cert or key (the empty context createSecureContext() makes)
   * is not parsed: the PEM parser rejects zero-length input. */
  int r = 0;
  if (cert_len > 0) {
    r = scr_tls_parse_crt(&c->cert, cert, cert_len);
    if (r != 0) scr_tls_bad_material("certificate", r);
  }
  if (key_len > 0) {
    r = scr_tls_parse_key(&c->pk, key, key_len);
    if (r != 0) scr_tls_bad_material("private key", r);
  }
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
/* the certificate-selection callback every server config carries: it
 * serves the context setKeyCert installed for a wrapped socket's handshake
 * (and the addContext/setSecureContext contexts of a tls.Server) */
static int scr_tls_f_cert(mbedtls_ssl_context *ssl);

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
static bool scr_tls_versions_available(int min, int max) {
  if (min < 12) min = 12;
  return max >= min;
}

static bool scr_tls_conf_versions(mbedtls_ssl_config *conf, int min, int max) {
  if (!scr_tls_versions_available(min, max)) return false;
  if (min < 12) min = 12;
  mbedtls_ssl_conf_min_tls_version(conf, min == 13 ? MBEDTLS_SSL_VERSION_TLS1_3 : MBEDTLS_SSL_VERSION_TLS1_2);
  mbedtls_ssl_conf_max_tls_version(conf, max == 13 ? MBEDTLS_SSL_VERSION_TLS1_3 : MBEDTLS_SSL_VERSION_TLS1_2);
  return true;
}

/* Node's SecureContext checks over the three version options as ordinary
 * property reads answered them, in its order: secureProtocol conflicts with
 * an explicit minVersion or maxVersion, then each version. The range lands
 * in *min / *max (Node's defaults TLSv1.2 and TLSv1.3). False with the
 * exception pending. */
static bool scr_tls_versions_values(const ScrDyn *vmin, const ScrDyn *vmax, const ScrDyn *proto,
                                    int *min, int *max, const char *api) {
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
  /* Node maps a string secureProtocol to an OpenSSL method before it reads
   * the versions; an unknown name and the disabled SSLv2/SSLv3 families
   * are ERR_TLS_INVALID_PROTOCOL_METHOD. Non-string values are ignored by
   * that map (they only take part in the conflict check above). */
  if (proto != NULL && proto->kind == SCR_DYN_STR) {
    static const char *const known[] = {
      "SSLv23_method", "SSLv23_server_method", "SSLv23_client_method",
      "TLS_method", "TLS_server_method", "TLS_client_method",
      "TLSv1_method", "TLSv1_server_method", "TLSv1_client_method",
      "TLSv1_1_method", "TLSv1_1_server_method", "TLSv1_1_client_method",
      "TLSv1_2_method", "TLSv1_2_server_method", "TLSv1_2_client_method", NULL,
    };
    const char *value = proto->v.str->data;
    size_t len = proto->v.str->len;
    bool matched = false;
    for (size_t i = 0; known[i] != NULL; i++) {
      if (strlen(known[i]) == len && memcmp(known[i], value, len) == 0) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      char msg[300];
      size_t m;
      if (len >= 6 && memcmp(value, "SSLv2_", 6) == 0) {
        m = sizeof "SSLv2 methods disabled" - 1;
        memcpy(msg, "SSLv2 methods disabled", m);
      } else if (len >= 6 && memcmp(value, "SSLv3_", 6) == 0) {
        m = sizeof "SSLv3 methods disabled" - 1;
        memcpy(msg, "SSLv3 methods disabled", m);
      } else {
        /* copy the value by length: Node's message keeps a NUL byte the
         * option string carries, which a %s conversion would stop at */
        static const char prefix[] = "Unknown method: ";
        size_t take = len < 200 ? len : 200;
        m = sizeof prefix - 1 + take;
        memcpy(msg, prefix, sizeof prefix - 1);
        memcpy(msg + sizeof prefix - 1, value, take);
      }
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, m, "ERR_TLS_INVALID_PROTOCOL_METHOD");
      return false;
    }
  }
  /* A whitelisted method still fixes a version. The generic families keep
   * Node's default 1.2-1.3 range; TLSv1_2_* fixes 1.2. TLS 1.0/1.1
   * methods have no lowering here, so they keep the by-name refusal
   * instead of silently negotiating a wider range. */
  if (proto != NULL && proto->kind == SCR_DYN_STR) {
    const char *value = proto->v.str->data;
    size_t len = proto->v.str->len;
    bool v12 = len >= 10 && memcmp(value, "TLSv1_2_", 8) == 0;
    bool sslv23 = len >= 8 && memcmp(value, "SSLv23_", 7) == 0;
    bool legacy = (len >= 9 && memcmp(value, "TLSv1_1_", 8) == 0) ||
                  (len >= 9 && memcmp(value, "TLSv1_", 6) == 0 && !v12);
    if (legacy) {
      scr_tls_opt_fence(api, "secureProtocol",
                        "TLS 1.0/1.1 methods have no lowering — configure TLSv1.2/TLSv1.3 instead");
      return false;
    }
    if (v12 || sslv23) {
      *min = 12;
      *max = 12;
      return true;
    }
  }
  return scr_tls_version_dyn(vmin, "minimum", 12, min) && scr_tls_version_dyn(vmax, "maximum", 13, max);
}

/* The version options of one options record, read as Node's ordinary
 * property access reads them: a getter runs and may throw, and a
 * secureProtocol it answers takes part in the checks. A plain read of the
 * data property alone would accept an accessor without ever seeing its
 * method. Owned reads are released here. */
static bool scr_tls_versions_record(const ScrDyn *opts, int *min, int *max, const char *api) {
  ScrDyn *vmin = NULL, *vmax = NULL, *proto = NULL;
  bool ok = true;
  if (opts != NULL && opts->kind == SCR_DYN_OBJ) {
    vmin = scr_dyn_obj_read(opts, "minVersion", 10);
    if (vmin == NULL) ok = false;
    if (ok) {
      vmax = scr_dyn_obj_read(opts, "maxVersion", 10);
      if (vmax == NULL) ok = false;
    }
    if (ok) {
      proto = scr_dyn_obj_read(opts, "secureProtocol", 14);
      if (proto == NULL) ok = false;
    }
  }
  if (ok) ok = scr_tls_versions_values(vmin, vmax, proto, min, max, api);
  scr_dyn_release(vmin);
  scr_dyn_release(vmax);
  scr_dyn_release(proto);
  return ok;
}

/* A typed reference (a record kept as its capsule, or a class instance)
 * carries the same members; the checks read its materialized plain view. */
static bool scr_tls_versions_dyn(const ScrDyn *opts, int *min, int *max, const char *api) {
  if (opts == NULL || opts->kind != SCR_DYN_TYPED_REF)
    return scr_tls_versions_record(opts, min, max, api);
  ScrDyn *plain = scr_dyn_typed_ref_materialize(opts);
  if (plain == NULL) return false;
  bool ok = scr_tls_versions_record(plain, min, max, api);
  scr_dyn_release(plain);
  return ok;
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
  /* session tickets: Node's servers mint them (a TLS 1.2 client gets its
   * ticket in the handshake, a TLS 1.3 client receives NewSessionTicket
   * records), and a client's getTLSTicket()/'session' event read them.
   * The engine's ticket callbacks keep their key context here. */
  mbedtls_ssl_ticket_context ticket_ctx;
  bool ticket_ready;
  /* server.getTicketKeys()/setTicketKeys(): the 48 bytes of random key
   * material this server answers (Node's contract). The engine's ticket
   * keys are derived from them, and a new set re-keys the server so
   * tickets minted under the old material no longer resume. */
  unsigned char ticket_keys[48];
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
  /* the server's rejectUnauthorized even when it requests no certificate
   * (Node's `options.rejectUnauthorized !== false` default, which every
   * socket seeds its policy with): renegotiate({ requestCert: true })
   * inherits it */
  bool client_reject;
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
  /* tls.Server's 'keylog' listeners: Node attaches the SSL_CTX keylog
   * callback for the server's connections, so every secret line reaches
   * them whether or not the socket has a listener of its own. */
  ScrNetLs keylog_ls;
} ScrTlsSrv;

/* The ALPN answers (static storage — mbedTLS keeps the pointers). Plain
 * tls servers configure none, like Node; https advertises http/1.1; the
 * h2 secure server advertises h2 alone (an http/1.1-only client fails
 * the handshake with no_application_protocol — Node's h2-only split). */
static const char *SCR_TLS_ALPN_HTTP11[] = {"http/1.1", NULL};
static const char *SCR_TLS_ALPN_H2[] = {"h2", NULL};
static const char *SCR_TLS_ALPN_H2_HTTP11[] = {"h2", "http/1.1", NULL};

/* Derives the engine's ticket keys from `s->ticket_keys` and writes BOTH
 * key slots, so tickets minted under the previous material no longer parse
 * (Node's setTicketKeys invalidates them) and every ticket carries a name
 * for the current material. */
#if defined(MBEDTLS_SSL_TICKET_C)
static void scr_tls_ticket_install(ScrTlsSrv *s) {
  if (!s->ticket_ready) return;
  unsigned char digest[32];
  if (mbedtls_sha256(s->ticket_keys, sizeof s->ticket_keys, digest, 0) != 0) return;
  /* rotate writes the inactive slot and flips it active: twice leaves
   * both slots holding this material */
  (void)mbedtls_ssl_ticket_rotate(&s->ticket_ctx, digest, sizeof digest, digest, sizeof digest,
                                  86400);
  (void)mbedtls_ssl_ticket_rotate(&s->ticket_ctx, digest, sizeof digest, digest, sizeof digest,
                                  86400);
}
#endif

/* The ticket key context every server config needs: the engine's own
 * ticket module writes and parses them, minted under a key kept here. */
/* The socket whose handshake this unit is driving (defined with the SNI
 * pre-parse below): the ticket callbacks record a resumed session on it. */
typedef struct ScrTlsSock ScrTlsSock;
static SCR_TL ScrTlsSock *scr_tls_current;
/* A server resumes a connection when the ticket its peer offers parses:
 * the engine's ticket callback runs during the handshake, so the socket
 * being driven records it (isSessionReused answers it, and a resumed
 * handshake re-sends no certificate). Defined after the socket struct. */
static int scr_tls_ticket_parse(void *ticket_ctx, mbedtls_ssl_session *session,
                                unsigned char *buf, size_t len);

static void scr_tls_srv_session_tickets(ScrTlsSrv *s) {
#if defined(MBEDTLS_SSL_TICKET_C)
  /* Node answers 48 bytes of random key material per server; the engine
   * keys derive from them. */
  if (mbedtls_ctr_drbg_random(&scr_tls_drbg, s->ticket_keys, sizeof s->ticket_keys) != 0) {
    memset(s->ticket_keys, 0, sizeof s->ticket_keys);
  }
  mbedtls_ssl_ticket_init(&s->ticket_ctx);
  if (mbedtls_ssl_ticket_setup(&s->ticket_ctx, mbedtls_ctr_drbg_random, &scr_tls_drbg,
                               MBEDTLS_CIPHER_AES_256_GCM, 86400) != 0) {
    return;
  }
  s->ticket_ready = true;
  scr_tls_ticket_install(s);
  /* tickets: Node's servers issue them and resume from them (the engine
   * enables them for clients only by default) */
  mbedtls_ssl_conf_session_tickets(&s->conf, MBEDTLS_SSL_SESSION_TICKETS_ENABLED);
#if defined(MBEDTLS_SSL_PROTO_TLS1_3)
  /* Node's TLS 1.3 server sends two NewSessionTickets after a full
   * handshake and none after a resumed one (the engine's count is zero by
   * default; it zeroes it on a resumed handshake itself) */
  mbedtls_ssl_conf_new_session_tickets(&s->conf, 2);
#endif
  mbedtls_ssl_conf_session_tickets_cb(&s->conf, mbedtls_ssl_ticket_write,
                                      scr_tls_ticket_parse, &s->ticket_ctx);
#else
  (void)s;
#endif
}

static ScrTlsSrv *scr_tls_srv_new(const char *cert, size_t cert_len, const char *key,
                                   size_t key_len, bool alpn_http11) {
  scr_tls_rng_init();
  ScrTlsSrv *s = calloc(1, sizeof *s);
  if (!s) scr_tls_oom();
  s->rc = 1;
  s->client_reject = true; /* Node's default; a walk may turn it off */
  mbedtls_x509_crt_init(&s->cert);
  mbedtls_x509_crt_init(&s->ca);
  mbedtls_pk_init(&s->pk);
  mbedtls_ssl_config_init(&s->conf);
  /* Node accepts a server whose options carry neither key nor cert (or
   * only one of them): the default context then has no pair, and an
   * SNICallback answer supplies the handshake's certificate. Absent
   * material is not parsed, and only a complete pair is configured as the
   * default. */
  const bool have_cert = cert != NULL && cert_len > 0;
  const bool have_key = key != NULL && key_len > 0;
  if (have_cert) {
    int r = scr_tls_parse_crt(&s->cert, cert, cert_len);
    if (r != 0) scr_tls_bad_material("certificate", r);
  }
  if (have_key) {
    int r = scr_tls_parse_key(&s->pk, key, key_len);
    if (r != 0) scr_tls_bad_material("private key", r);
  }
  if (mbedtls_ssl_config_defaults(&s->conf, MBEDTLS_SSL_IS_SERVER,
                                  MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
    scr_tls_oom();
  }
  scr_tls_srv_session_tickets(s);
  mbedtls_ssl_conf_rng(&s->conf, mbedtls_ctr_drbg_random, &scr_tls_drbg);
  /* no client certificate unless requestCert asks (scr_tls_srv_client_auth) */
  mbedtls_ssl_conf_authmode(&s->conf, MBEDTLS_SSL_VERIFY_NONE);
  mbedtls_ssl_conf_renegotiation(&s->conf, MBEDTLS_SSL_RENEGOTIATION_ENABLED);
  /* the selection callback serves setKeyCert's pair; without one it answers
   * the config's own certificate as before */
  mbedtls_ssl_conf_cert_cb(&s->conf, &scr_tls_f_cert);
  if (have_cert && have_key) {
    if (mbedtls_ssl_conf_own_cert(&s->conf, &s->cert, &s->pk) != 0) {
      scr_tls_bad_material("certificate/key pair", 0);
    }
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
  s->client_reject = true; /* Node's default; a walk may turn it off */
  mbedtls_x509_crt_init(&s->cert);
  mbedtls_x509_crt_init(&s->ca);
  mbedtls_pk_init(&s->pk);
  mbedtls_ssl_config_init(&s->conf);
  if (mbedtls_ssl_config_defaults(&s->conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
    scr_tls_oom();
  }
  scr_tls_srv_session_tickets(s);
  mbedtls_ssl_conf_rng(&s->conf, mbedtls_ctr_drbg_random, &scr_tls_drbg);
  mbedtls_ssl_conf_authmode(&s->conf, MBEDTLS_SSL_VERIFY_NONE);
  mbedtls_ssl_conf_renegotiation(&s->conf, MBEDTLS_SSL_RENEGOTIATION_ENABLED);
  mbedtls_ssl_conf_cert_cb(&s->conf, &scr_tls_f_cert);
  (void)scr_tls_conf_versions(&s->conf, ctx->min_version, ctx->max_version);
  s->max_tls12 = ctx->max_version == 12;
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
#if defined(MBEDTLS_SSL_TICKET_C)
  mbedtls_ssl_ticket_free(&s->ticket_ctx);
#endif
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
  scr_net_ls_drop(&s->keylog_ls);
  free(s);
}

static void scr_tls_srv_release_v(void *p) { scr_tls_srv_release((ScrTlsSrv *)p); }

/* The server settled: its 'keylog' listeners can no longer fire, and one
 * that captures the server must not keep it alive through the TLS context
 * (scr_net.c calls this at settlement). */
static void scr_tls_srv_settle(void *ctx) {
  ScrTlsSrv *s = (ScrTlsSrv *)ctx;
  scr_net_ls_drop(&s->keylog_ls);
}

/* The client-certificate options of a server: requestCert, rejectUnauthorized
 * (Node's true default) and ca (+1, NULL for none). */
typedef struct {
  bool request;
  bool reject;
  bool reject_seen;   /* the record supplied rejectUnauthorized */
  bool reject_truthy; /* its JS truthiness: a standalone socket's rule */
  ScrBytes *ca;
} ScrTlsClientAuth;

static mbedtls_x509_crt *scr_tls_system_ca(void);


/* Applies a server's client-certificate options. A `ca` also completes the
 * server's own chain, as OpenSSL's automatic chain sends it. */
static void scr_tls_srv_client_auth(ScrTlsSrv *s, const ScrTlsClientAuth *auth) {
  if (auth == NULL) return;
  /* the server's rejectUnauthorized applies to every socket it accepts,
   * including one that asks for a certificate only later */
  s->client_reject = auth->reject;
  /* An empty ca Buffer is an empty trust store, not the default one. */
  if (auth->ca != NULL) {
    if (auth->ca->len > 0) {
      int r = scr_tls_parse_ca_bundle(&s->ca, (const char *)auth->ca->data, auth->ca->len);
      /* Node ignores a CA certificate OpenSSL cannot parse; mbedTLS
       * reports a positive count when it kept the other certificates, so
       * only a hard failure clears the store. */
      if (r < 0) {
        mbedtls_x509_crt_free(&s->ca);
        mbedtls_x509_crt_init(&s->ca);
      } else if (s->ctx == NULL) {
        scr_tls_auto_chain(&s->cert, &s->ca);
      }
    }
    s->has_ca = true;
  }
  if (!auth->request) return;
  s->request_cert = true;
  s->reject_unauthorized = auth->reject;
  /* A resumed handshake carries no peer certificate, and this engine's
   * ticket restores the session without the peer identity or its
   * verification result. A server that requires client certificates
   * therefore issues and accepts no tickets: a resumption attempt becomes
   * a full handshake that re-runs the requirement, and one ticket key can
   * never carry a trust decision across contexts that verify differently. */
#if defined(MBEDTLS_SSL_SESSION_TICKETS)
  mbedtls_ssl_conf_session_tickets_cb(&s->conf, NULL, NULL, NULL);
  mbedtls_ssl_conf_session_tickets(&s->conf, MBEDTLS_SSL_SESSION_TICKETS_DISABLED);
#endif
  /* OPTIONAL: the handshake records the verdict and goes on, as Node's
   * verify callback does; scr_tls_handshake applies rejectUnauthorized */
  mbedtls_ssl_conf_authmode(&s->conf, MBEDTLS_SSL_VERIFY_OPTIONAL);
  /* a client-initiated renegotiation is accepted, as Node's server does */
  mbedtls_ssl_conf_renegotiation(&s->conf, MBEDTLS_SSL_RENEGOTIATION_ENABLED);
  mbedtls_ssl_conf_ca_chain(&s->conf, s->has_ca ? &s->ca : scr_tls_system_ca(), NULL);
}

/* ── the client config (one per https.request, owned by its tctx) ────── */

typedef struct ScrTlsCli {
  mbedtls_ssl_config conf;
  /* the ca option, which replaces the default store; has_ca tells an
   * empty ca (an empty trust store) from none */
  bool has_ca;
  mbedtls_x509_crt ca;
  /* tls.connect's crl option: the CRL bundle mbedTLS checks the chain
   * against. has_crl tells a provided CRL (even an empty one) from none. */
  bool has_crl;
  mbedtls_x509_crl crl;
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
  /* tls.connect's session option: the serialized session (getSession's
   * Buffer, mbedTLS's own format) the handshake offers for resumption.
   * A session the engine cannot load is ignored, as Node's engine ignores
   * what it cannot decode. */
  bool has_resume;
  mbedtls_ssl_session resume;
  /* the verification result the offered session was captured with: a resumed
   * handshake verifies no certificate, so this verdict stands, and a session
   * captured unverified is not offered to a connection that now verifies */
  uint32_t resume_verify;
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
                                    size_t ca_len, const char *crl, size_t crl_len,
                                    bool verify_optional) {
  scr_tls_rng_init();
  ScrTlsCli *c = calloc(1, sizeof *c);
  if (!c) scr_tls_oom();
  mbedtls_ssl_config_init(&c->conf);
  mbedtls_x509_crt_init(&c->ca);
  mbedtls_x509_crl_init(&c->crl);
  mbedtls_x509_crt_init(&c->own);
  mbedtls_pk_init(&c->own_pk);
  mbedtls_ssl_session_init(&c->resume);
  if (mbedtls_ssl_config_defaults(&c->conf, MBEDTLS_SSL_IS_CLIENT,
                                  MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0) {
    scr_tls_oom();
  }
  mbedtls_ssl_conf_rng(&c->conf, mbedtls_ctr_drbg_random, &scr_tls_drbg);
#if defined(MBEDTLS_SSL_PROTO_TLS1_3)
  /* Node's client surfaces every ticket it receives (the 'session' event);
   * the engine reports the receipt instead of swallowing it */
  mbedtls_ssl_conf_tls13_enable_signal_new_session_tickets(
      &c->conf, MBEDTLS_SSL_TLS1_3_SIGNAL_NEW_SESSION_TICKETS_ENABLED);
#endif
  /* Node refuses a server's finite-field Diffie-Hellman group under 2048
   * bits (OpenSSL's default security level: "dh key too small"); the
   * mbedTLS default accepts 1024. Every client configuration is built
   * here, so this is the one place the floor is set. */
  mbedtls_ssl_conf_dhm_min_bitlen(&c->conf, 2048);
  /* TLS 1.2 renegotiation: the surface starts one on request (Node's
   * tlsSocket.renegotiate) and answers the peer's when it asks. */
  mbedtls_ssl_conf_renegotiation(&c->conf, MBEDTLS_SSL_RENEGOTIATION_ENABLED);
  c->verify_recorded = reject_unauthorized || verify_optional;
  c->reject = reject_unauthorized;
  c->has_ca = ca != NULL;
  if (ca_len > 0) {
    int r = scr_tls_parse_ca_bundle(&c->ca, ca, ca_len);
    /* Node ignores a CA certificate OpenSSL cannot parse; keep the
     * certificates mbedTLS parsed (a positive count), clear only on a hard
     * failure. */
    if (r < 0) {
      mbedtls_x509_crt_free(&c->ca);
      mbedtls_x509_crt_init(&c->ca);
    }
  }
  c->has_crl = crl != NULL;
  if (crl_len > 0) {
    int r = scr_tls_parse_crl(&c->crl, crl, crl_len);
    if (r != 0) scr_tls_bad_material("CRL", r);
  }
  if (!reject_unauthorized && !verify_optional) {
    mbedtls_ssl_conf_authmode(&c->conf, MBEDTLS_SSL_VERIFY_NONE);
  } else {
    mbedtls_ssl_conf_authmode(&c->conf, reject_unauthorized ? MBEDTLS_SSL_VERIFY_REQUIRED
                                                            : MBEDTLS_SSL_VERIFY_OPTIONAL);
    /* The crl option's CRLs are checked by scr_tls_crl_check_chain, not by
     * mbedTLS: a bundle may hold several CRLs with one issuer name (a
     * key-rollover CA and its predecessor share a DN but not a key), and
     * mbedTLS's check would take a signature mismatch on the inapplicable
     * one for a failure. The custom check selects the CRL that verifies
     * under the issuer it is checking, as OpenSSL's store does. */
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
  return scr_tls_cli_new2(host, reject_unauthorized, ca, ca_len, NULL, 0, false);
}

static void scr_tls_cli_free(ScrTlsCli *c) {
  mbedtls_ssl_config_free(&c->conf);
  mbedtls_ssl_session_free(&c->resume);
  scr_tls_alpn_free(c->alpn);
  mbedtls_x509_crt_free(&c->ca);
  mbedtls_x509_crl_free(&c->crl);
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

/* tls.connect's session option: the serialized session the handshake
 * offers for resumption. A session the engine cannot load is ignored, as
 * Node's engine ignores bytes it cannot decode. */
static void scr_tls_cli_set_session(ScrTlsCli *c, const ScrBytes *session) {
  if (session == NULL || session->len == 0) return;
  if (mbedtls_ssl_session_load(&c->resume, (const unsigned char *)session->data, session->len) != 0) {
    mbedtls_ssl_session_free(&c->resume);
    mbedtls_ssl_session_init(&c->resume);
    c->has_resume = false;
    return;
  }
  if (c->resume.MBEDTLS_PRIVATE(tls_version) == MBEDTLS_SSL_VERSION_TLS1_3) {
    /* the 1.3 format carries no verification result: the marker an
     * unverified origin set is the only trace of it */
    c->resume_verify = (c->resume.MBEDTLS_PRIVATE(ticket_flags) & 0x80u)
                           ? MBEDTLS_X509_BADCERT_NOT_TRUSTED
                           : 0;
  } else {
    c->resume_verify = c->resume.MBEDTLS_PRIVATE(verify_result);
  }
  c->has_resume = true;
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
  /* the 'secure' event has fired (a later registration comes too late, as in
   * Node; a listener added during secureConnect still catches it) */
  bool secure_emitted;
  /* the handshake that stood resumed the session its peer offered (a server's
   * ticket parse ran successfully): isSessionReused answers it */
  bool session_resumed;
  /* the handshake has begun (set when a client socket is created — Node's
   * tls.connect starts it at once — and when the driver first runs): a
   * session set after this point is not offered */
  bool handshake_started;
  /* the verification result that describes the standing handshake, captured
   * when it completes (a later ticket exchange replaces the engine's session
   * object, whose own field is then 'not available'). Until then the
   * snapshot does not exist and the engine's live result is the answer. */
  uint32_t standing_verify;
  bool standing_verify_set;
  /* the connection's handshake presented a certificate: a resumed handshake
   * presents none, which is how a client knows its offered session was taken
   * (the engine keeps the resumed session's certificate). Set when the chain
   * is parsed and never cleared for the connection — the handshake driver
   * runs step by step, so clearing per call would lose the fact after the
   * final step. */
  bool peer_cert_parsed;
  /* the client 'session' event: listeners + the fired-once latch (Node
   * fires per received ticket; this surface fires once per socket) */
  ScrNetLs session_ls;
  /* the engine exports a session once: the first reader captures the
   * serialized session and the ticket it carries, and getSession(),
   * 'session' and getTLSTicket() all read that copy afterwards */
  ScrBytes *session_cached;
  ScrBytes *ticket_cached;
  ScrNetLs keylog_ls; /* TLSSocket.on('keylog') */
  bool session_fired;
  /* a 'session' listener existed when the handshake completed: Node's TLS
   * 1.2 ticket rides the handshake, so only a listener that was already
   * there when it arrived sees the event (a later one is never replayed) */
  bool session_armed;
  /* what the verify callback saw (the peer chain is gone once the
   * handshake has failed, so the shape is recorded as it verifies) */
  bool vrfy_leaf_self;
  bool vrfy_chain_self;
  bool vrfy_expired;
  bool vrfy_future;
  bool vrfy_bad_sig;
  bool vrfy_pathlen;
  bool vrfy_cn_mismatch;
  /* the crl option's outcome: a CRL revoked a certificate (CERT_REVOKED),
   * its validity window or signature failed, or the option held no CRL for
   * a trusted issuer (Node's UNABLE_TO_GET_CRL) */
  bool vrfy_crl_revoked;
  bool vrfy_crl_expired;
  bool vrfy_crl_future;
  bool vrfy_crl_sig_fail;
  /* the CRL's issuer may not sign CRLs (its key usage excludes cRLSign) */
  bool vrfy_crl_key_usage;
  bool vrfy_crl_missing;
  /* the leaf's subjectAltName rendered the way OpenSSL prints it, recorded
   * while the peer chain is alive for Node's altname-failure message */
  char *vrfy_altnames;
  /* a certificate of the chain carried a blocked public key: the failure
   * Node reports as CERT_REVOKED, ahead of every other verification error */
  bool vrfy_blocked;
  /* the verify callback ran at least once: a peer certificate arrived and
   * was examined, so a verdict exists even if the handshake then failed */
  bool vrfy_seen;
  /* the walk finished (the leaf's turn ran): the next callback belongs to a
   * new handshake and resets first */
  bool vrfy_walk_done;
  /* disableRenegotiation(): a peer's later handshake fails the socket */
  bool reneg_disabled;
  /* renegotiations accepted on this connection (OpenSSL reports a session
   * attack from the fourth on) */
  unsigned renegotiations;
  /* the last mbedTLS renegotiation status seen (0 initial, 1 in progress,
   * 2 done, 3 pending on a server): a transition into 2 is a completed
   * handshake, whether the caller or the peer started it */
  int renego_phase;
  /* The client-certificate policy of the NEXT handshake, which
   * renegotiate(options) updates from the socket's current values (Node's
   * per-socket _requestCert/_rejectUnauthorized, seeded from the server's
   * options at accept). A renegotiation that asks for a client certificate
   * the peer does not present is accepted by the engine, then reported as
   * UNABLE_TO_GET_ISSUER_CERT and, with rejectUnauthorized, ended. */
  bool req_cert;
  bool reject_unauth;
  /* the last completed handshake requested a client certificate and the
   * peer sent none: authorized stays false, authorizationError answers */
  bool client_cert_missing;
  /* the policy the last handshake ran under (taken when it starts): the
   * authorization answers read this, not the live flag, so a renegotiate
   * call that changes the socket's policy cannot change a verdict before
   * a handshake actually completes under it */
  bool verdict_req_cert;
  /* setKeyCert(context): the certificate pair the application installed
   * for this socket's server handshake (+1, NULL when none) */
  ScrSecureCtx *pending_cert_ctx;
  /* a renegotiation whose policy failed ends the socket once the
   * handshake's own flight (held until the immediate) has gone out */
  bool close_after_hold;
  /* the completed renegotiation whose 'secure' and verdicts have already
   * been reported: the pump's detector and the read path's can both see
   * the same handshake, and Node reports each one once */
  bool renego_reported;
  /* the flags every certificate of the chain raised so far: the callback
   * runs depth-descending, so the leaf's turn holds the whole verdict */
  uint32_t vrfy_flags;
  /* the trust list this connection verifies against (borrowed from the
   * client or server config, or the system store): the chain is continued
   * through it past the certificate mbedTLS stopped at */
  mbedtls_x509_crt *vrfy_trust;
  /* the topmost certificate the verification walked — the callback runs
   * depth-descending, the leaf last, so the leaf's turn closes the walk */
  mbedtls_x509_crt *vrfy_top;
  /* the chain mbedTLS actually built, by depth (leaf at 0), recorded by the
   * callback: the CRL check walks the verified chain, never the presented
   * list, so a peer cannot shadow the issuer it selected with an extra
   * certificate */
  mbedtls_x509_crt *vrfy_chain[16];
  size_t vrfy_chain_len;
  /* SNI pre-parse state (server side with an SNI callback only) */
  int sni_state;
  bool in_handshake;   /* a synchronous cb answer must not re-pump */
  unsigned char *hello; /* the raw ClientHello flight, replayed at DONE */
  size_t hello_len, hello_cap;
  ScrSecureCtx *sni_ctx; /* owned; the answer (NULL = default cert) */
  /* the server_name a client sent (a server socket): Node's
   * tlsSocket.servername (+1, NULL without one) */
  ScrStr *sni_name;
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
  /* 'secure' listeners registered after the handshake's own emission has
   * begun: they miss that one and join the live list for later emissions */
  ScrNetLs secure_next_ls;
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

/* A server resumes a connection when the ticket its peer offers parses: the
 * engine's ticket callback runs during the handshake (scr_tls_current names
 * the socket being driven), so the socket records it. */
static int scr_tls_ticket_parse(void *ticket_ctx, mbedtls_ssl_session *session,
                                unsigned char *buf, size_t len) {
  int r = mbedtls_ssl_ticket_parse(ticket_ctx, session, buf, len);
  if (r == 0 && scr_tls_current != NULL) scr_tls_current->session_resumed = true;
  return r;
}

static bool scr_tls_alert_error(ScrTlsSock *t, unsigned char alert);

/* ── the blocked-SPKI policy ────────────────────────────────────────────
 *
 * Node 24.22.1 refuses a certificate chain that contains a public key from
 * a fixed blocklist (src/crypto/crypto_context.cc, kBlockedSPKIs): the
 * SHA-256 digest of the DER SubjectPublicKeyInfo. The check runs at the
 * verification boundary over the chain the verification selected, trust
 * anchor included, and, when that chain did not verify, over every
 * certificate the peer sent. A hit is CERT_REVOKED ("certificate
 * revoked"), which outranks the error the verification itself found.
 *
 * mbedTLS's walk ends at the first certificate it trusts, which may be an
 * intermediate; the chain Node keeps building there, through every issuer
 * the trust list can resolve, is continued by scr_tls_spki_anchor_blocked,
 * and the peer's whole list is scanned on the leaf's turn when the chain did
 * not verify, because mbedTLS releases it with the handshake. */

#define SCR_TLS_SPKI_LEN 32

/* Node v24.22.1's list, unchanged: the eMudhra/emSign intermediates whose
 * private keys were reported compromised in October 2026 (Go and Electron
 * ship the same entries). */
static const unsigned char scr_tls_blocked_spki[][SCR_TLS_SPKI_LEN] = {
  {0x49, 0xdd, 0x35, 0x3d, 0xc2, 0xb9, 0x19, 0xa3, 0x77, 0x06, 0x45, 0x11, 0x7d, 0x0e, 0x60, 0xc1,
   0x61, 0x15, 0xe7, 0xd1, 0xbc, 0x25, 0x9e, 0xef, 0xe7, 0x34, 0xb0, 0x0e, 0xa4, 0x34, 0xfe, 0x5f},
  {0x5c, 0x06, 0x60, 0xa2, 0xb1, 0x64, 0x91, 0x0d, 0x8f, 0xf5, 0x89, 0xc1, 0x8e, 0x14, 0x55, 0x2e,
   0x9e, 0x0e, 0xc2, 0x37, 0xdc, 0xef, 0xe2, 0xcb, 0x73, 0x6d, 0x41, 0xa4, 0x81, 0x1f, 0x81, 0xa0},
  {0x63, 0xec, 0xef, 0xee, 0x43, 0x1d, 0x49, 0x52, 0x3b, 0xc1, 0x13, 0x6c, 0x4e, 0x72, 0xd0, 0x20,
   0x6a, 0x47, 0x70, 0x86, 0xca, 0xf6, 0x06, 0xcd, 0x5c, 0xf0, 0x25, 0x68, 0x6c, 0x10, 0x9c, 0xf8},
  {0x92, 0xc0, 0x63, 0xd6, 0x7e, 0x8f, 0x14, 0xdb, 0x71, 0xd2, 0x88, 0xe1, 0x12, 0x66, 0xff, 0xda,
   0xf6, 0x9c, 0xbf, 0x11, 0x5f, 0x7b, 0xab, 0x14, 0xf3, 0xbc, 0x2f, 0x68, 0xd2, 0x5e, 0x0e, 0x30},
  {0xeb, 0xed, 0x64, 0x75, 0xc2, 0xc2, 0xd8, 0x0f, 0xcb, 0x19, 0x9f, 0x3f, 0xe8, 0xdd, 0x6e, 0x6b,
   0x3c, 0xe6, 0x0b, 0x77, 0xeb, 0x15, 0xd4, 0xe4, 0x2c, 0x3d, 0xec, 0x0c, 0x6f, 0x5b, 0x51, 0x05},
  {0xec, 0x4f, 0xfa, 0x1a, 0xd0, 0xac, 0x88, 0x08, 0x13, 0x14, 0xb7, 0xaa, 0xff, 0xef, 0x6a, 0x91,
   0xf9, 0x7c, 0xd5, 0x72, 0x91, 0xbb, 0x5b, 0xa6, 0x86, 0xc5, 0x41, 0x5f, 0x5e, 0xb4, 0xf6, 0xb6},
  {0x43, 0xbf, 0xfa, 0x19, 0xd6, 0xef, 0x65, 0x14, 0x51, 0xf6, 0x84, 0x1e, 0x01, 0x99, 0x31, 0xe9,
   0x6f, 0x6f, 0x2e, 0xae, 0xff, 0x28, 0xab, 0x4b, 0x6f, 0x1c, 0xe4, 0x57, 0x6d, 0xe2, 0x71, 0x7b},
  {0xe0, 0x25, 0x4c, 0x7f, 0xcd, 0xc2, 0x65, 0xe2, 0xf0, 0xf8, 0xa4, 0x28, 0xda, 0xbb, 0x75, 0xab,
   0x4a, 0xe0, 0x39, 0xb4, 0x87, 0x2d, 0x62, 0xf5, 0xee, 0x57, 0xf0, 0x87, 0x7d, 0x5a, 0x8a, 0x41},
};

/* Test-only extra entries, Node's addBlockedSPKIForTesting: 64-hex-digit
 * digests separated by commas in SCRIPTC_TLS_BLOCKED_SPKI. The hook only
 * ever ADDS a key, which can make verification stricter but never weaker,
 * so it ships the way Node ships its binding hook. */
enum { SCR_TLS_SPKI_EXTRA_MAX = 16 };
static unsigned char scr_tls_spki_extra[SCR_TLS_SPKI_EXTRA_MAX][SCR_TLS_SPKI_LEN];
static size_t scr_tls_spki_extra_n;
static bool scr_tls_spki_extra_loaded;

static int scr_tls_hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static void scr_tls_spki_extra_load(void) {
  if (scr_tls_spki_extra_loaded) return;
  scr_tls_spki_extra_loaded = true;
  const char *env = scr_getenv("SCRIPTC_TLS_BLOCKED_SPKI");
  while (env != NULL && *env != '\0' && scr_tls_spki_extra_n < SCR_TLS_SPKI_EXTRA_MAX) {
    const char *comma = strchr(env, ',');
    size_t len = comma != NULL ? (size_t)(comma - env) : strlen(env);
    if (len == 2 * SCR_TLS_SPKI_LEN) {
      unsigned char digest[SCR_TLS_SPKI_LEN];
      bool ok = true;
      for (size_t i = 0; i < SCR_TLS_SPKI_LEN; i++) {
        int hi = scr_tls_hex_value(env[2 * i]);
        int lo = scr_tls_hex_value(env[2 * i + 1]);
        if (hi < 0 || lo < 0) {
          ok = false;
          break;
        }
        digest[i] = (unsigned char)((hi << 4) | lo);
      }
      if (ok) memcpy(scr_tls_spki_extra[scr_tls_spki_extra_n++], digest, SCR_TLS_SPKI_LEN);
    }
    env = comma != NULL ? comma + 1 : NULL;
  }
}

/* 1 when the certificate's public key is blocked, 0 when it is not, -1
 * when the SPKI cannot be hashed. Node answers that last case with
 * X509_V_ERR_UNSPECIFIED rather than letting the chain through; a parsed
 * mbedTLS certificate always keeps its SPKI, so it is defensive only and
 * scr_tls_vrfy_cb fails it closed. */
static int scr_tls_spki_check(const mbedtls_x509_crt *crt) {
  if (crt == NULL || crt->pk_raw.p == NULL || crt->pk_raw.len == 0) return -1;
  unsigned char digest[SCR_TLS_SPKI_LEN];
  if (mbedtls_sha256(crt->pk_raw.p, crt->pk_raw.len, digest, 0) != 0) return -1;
  for (size_t i = 0; i < sizeof scr_tls_blocked_spki / SCR_TLS_SPKI_LEN; i++)
    if (memcmp(digest, scr_tls_blocked_spki[i], SCR_TLS_SPKI_LEN) == 0) return 1;
  scr_tls_spki_extra_load();
  for (size_t i = 0; i < scr_tls_spki_extra_n; i++)
    if (memcmp(digest, scr_tls_spki_extra[i], SCR_TLS_SPKI_LEN) == 0) return 1;
  return 0;
}

/* Whether `crt`'s signature is `ca`'s: the parent-search test mbedTLS applies
 * before it accepts a trusted certificate. */
static bool scr_tls_cert_signed_by(const mbedtls_x509_crt *crt, mbedtls_x509_crt *ca) {
  mbedtls_md_type_t sig_md = crt->MBEDTLS_PRIVATE(sig_md);
  const mbedtls_md_info_t *md = mbedtls_md_info_from_type(sig_md);
  const unsigned char *sig = crt->MBEDTLS_PRIVATE(sig).p;
  size_t sig_len = crt->MBEDTLS_PRIVATE(sig).len;
  if (md == NULL || sig == NULL || sig_len == 0) return false;
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  if (mbedtls_md(md, crt->tbs.p, crt->tbs.len, hash) != 0) return false;
  return mbedtls_pk_verify(&ca->pk, sig_md, hash, mbedtls_md_get_size(md), sig, sig_len) == 0;
}

/* The certificates Node's chain gains past the one mbedTLS stopped at: each
 * time the trusted certificate whose subject is the current certificate's
 * issuer and whose key verifies it, until the trust list supplies no further
 * issuer. OpenSSL builds that continuation, so CheckSPKIs sees a blocked key
 * along any of it and rejects a chain mbedTLS alone would accept. */
static bool scr_tls_spki_anchor_blocked(const ScrTlsSock *t, const mbedtls_x509_crt *top) {
  if (t->vrfy_trust == NULL || top == NULL) return false;
  const mbedtls_x509_crt *cur = top;
  /* the bound ends a certificate that names itself and a trust list whose
   * issuers circle back; a longer chain is not one mbedTLS would accept */
  for (size_t hop = 0; hop <= MBEDTLS_X509_MAX_INTERMEDIATE_CA; hop++) {
    const mbedtls_x509_crt *issuer = NULL;
    for (mbedtls_x509_crt *ca = t->vrfy_trust; ca != NULL && ca->raw.len > 0; ca = ca->next) {
      if (ca->subject_raw.len != cur->issuer_raw.len || ca->subject_raw.p == NULL) continue;
      if (memcmp(ca->subject_raw.p, cur->issuer_raw.p, ca->subject_raw.len) != 0) continue;
      if (!scr_tls_cert_signed_by(cur, ca)) continue;
      issuer = ca;
      break;
    }
    if (issuer == NULL) return false;
    if (scr_tls_spki_check(issuer) != 0) return true;
    if (issuer == cur) return false; /* a self-signed certificate ends the chain */
    cur = issuer;
  }
  return false;
}

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
/* mbedTLS folds every chain failure into BADCERT_NOT_TRUSTED, while
 * OpenSSL separates a leaf whose signature does not verify
 * (CERT_SIGNATURE_FAILURE) from one whose issuer never arrived. When the
 * leaf names an issuer the trust list holds, verify the leaf's signature
 * against that issuer's key: a failure is Node's CERT_SIGNATURE_FAILURE. */
/* Whether one of the crl option's CRLs is issued by a trusted CA: an
 * untrusted issuer is Node's UNABLE_TO_GET_CRL, not a signature failure. */
static bool scr_tls_crl_issuer_trusted(ScrTlsSock *t) {
  if (t->cli == NULL || !t->cli->has_crl || t->vrfy_trust == NULL) return false;
  for (const mbedtls_x509_crl *crl = &t->cli->crl; crl != NULL && crl->raw.len > 0;
       crl = crl->next) {
    for (mbedtls_x509_crt *ca = t->vrfy_trust; ca != NULL && ca->raw.len > 0; ca = ca->next) {
      if (ca->subject_raw.len == crl->issuer_raw.len &&
          memcmp(ca->subject_raw.p, crl->issuer_raw.p, crl->issuer_raw.len) == 0)
        return true;
    }
  }
  return false;
}

/* The crl option's CRLs on a client socket (NULL when none). */
static const mbedtls_x509_crl *scr_tls_client_crls(ScrTlsSock *t) {
  if (t->cli == NULL || !t->cli->has_crl) return NULL;
  return &t->cli->crl;
}

/* Whether a CRL's signature verifies under the key of the certificate its
 * issuer field names. */
static bool scr_tls_crl_signed_by(const mbedtls_x509_crl *crl,
                                  const mbedtls_x509_crt *issuer) {
  const mbedtls_md_info_t *md = mbedtls_md_info_from_type(crl->MBEDTLS_PRIVATE(sig_md));
  if (md == NULL || !mbedtls_pk_can_do(&issuer->pk, crl->MBEDTLS_PRIVATE(sig_pk))) return false;
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  if (mbedtls_md(md, crl->tbs.p, crl->tbs.len, hash) != 0) return false;
  return mbedtls_pk_verify_ext(crl->MBEDTLS_PRIVATE(sig_pk), crl->MBEDTLS_PRIVATE(sig_opts),
                               (mbedtls_pk_context *)&issuer->pk, crl->MBEDTLS_PRIVATE(sig_md),
                               hash, mbedtls_md_get_size(md), crl->MBEDTLS_PRIVATE(sig).p,
                               crl->MBEDTLS_PRIVATE(sig).len) == 0;
}

/* Whether a CRL lists the certificate's serial. */
static bool scr_tls_crl_lists(const mbedtls_x509_crl *crl, const mbedtls_x509_crt *cert) {
  if (cert->serial.p == NULL) return false;
  for (const mbedtls_x509_crl_entry *e = &crl->entry; e != NULL; e = e->next) {
    if (e->serial.p == NULL) break;
    if (e->serial.len == cert->serial.len &&
        memcmp(e->serial.p, cert->serial.p, e->serial.len) == 0)
      return true;
  }
  return false;
}



/* Whether the certificate signed itself: the chain's true root. A
 * key-rollover CA can carry the same issuer and subject DN as the root it
 * replaced while another key signed it, so equal names alone do not make a
 * certificate the chain's end. */
static bool scr_tls_cert_self_signed(const mbedtls_x509_crt *cert) {
  return cert->issuer_raw.len == cert->subject_raw.len &&
         memcmp(cert->issuer_raw.p, cert->subject_raw.p, cert->issuer_raw.len) == 0 &&
         scr_tls_cert_signed_by(cert, (mbedtls_x509_crt *)cert);
}

/* The built chain for CRL checking: the certificates mbedTLS verified,
 * completed through the trust list to the self-signed root. */
static size_t scr_tls_crl_chain(ScrTlsSock *t, const mbedtls_x509_crt *chain[16]) {
  size_t n = 0;
  /* The chain mbedTLS verified, leaf first. Its entries are the certificates
   * that signed each other, not the peer's presented list: an extra
   * certificate the peer sends (a self-issued decoy carrying an issuer's
   * public key, say) is never verified into the chain, so it cannot stand in
   * for an issuer whose CRL would revoke it. */
  for (size_t depth = 0; depth < t->vrfy_chain_len && n < 16; depth++)
    chain[n++] = t->vrfy_chain[depth];
  while (n > 0 && n < 16) {
    const mbedtls_x509_crt *top = chain[n - 1];
    if (scr_tls_cert_self_signed(top)) break;
    const mbedtls_x509_crt *issuer = NULL;
    if (t->vrfy_trust != NULL && top->issuer_raw.len > 0) {
      /* Prefer the trust entry whose key verifies the child: a key-rollover
       * CA and its predecessor can share a subject DN while differing in
       * key, and the predecessor's key is the one that signed the rollover
       * certificate (and the one that issued its CRL). */
      for (mbedtls_x509_crt *ca = t->vrfy_trust; ca != NULL && ca->raw.len > 0; ca = ca->next) {
        if (ca->subject_raw.len == top->issuer_raw.len &&
            memcmp(ca->subject_raw.p, top->issuer_raw.p, top->issuer_raw.len) == 0 &&
            scr_tls_cert_signed_by(top, ca)) {
          issuer = ca;
          break;
        }
      }
      if (issuer == NULL) {
        /* No candidate verifies (an unsupported signature algorithm stops
         * the check above): keep the name match, as before. */
        for (mbedtls_x509_crt *ca = t->vrfy_trust; ca != NULL && ca->raw.len > 0; ca = ca->next) {
          if (ca->subject_raw.len == top->issuer_raw.len &&
              memcmp(ca->subject_raw.p, top->issuer_raw.p, top->issuer_raw.len) == 0) {
            issuer = ca;
            break;
          }
        }
      }
    }
    if (issuer == NULL) break;
    chain[n++] = issuer;
  }
  /* A chain beyond the fixed array cannot be checked completely; report it
   * as uncovered rather than accepting a revocation that was not looked
   * at. */
  if (n == 16 && !scr_tls_cert_self_signed(chain[n - 1])) return 0;
  return n;
}

/* OpenSSL's CRL checking runs over the whole built chain, including
 * intermediates that are themselves in `ca` (where mbedTLS stops at the
 * first trusted certificate and never asks the root's CRL about them).
 * Every certificate with an issuer needs a CRL from that issuer; the first
 * valid CRL per issuer decides. A revocation outranks a missing CRL, as
 * Node reports it. */
static void scr_tls_crl_check_chain(ScrTlsSock *t) {
  const mbedtls_x509_crl *crls = scr_tls_client_crls(t);
  if (crls == NULL) return;
  const mbedtls_x509_crt *chain[16];
  size_t n = scr_tls_crl_chain(t, chain);
  bool revoked = false, missing = n == 0, sig_fail = false, expired = false, future = false;
  bool key_usage = false;
  for (size_t i = 0; i < n; i++) {
    const mbedtls_x509_crt *cert = chain[i];
    const mbedtls_x509_crt *issuer;
    if (i + 1 < n) {
      issuer = chain[i + 1];
    } else {
      /* The top of the chain has no issuer of its own unless it is the
       * self-signed root, and OpenSSL still checks a root's CRL: a CRL the
       * root issued may revoke the root itself. */
      if (!scr_tls_cert_self_signed(cert)) break;
      issuer = cert;
    }
    /* OpenSSL's store keeps the first CRL for an issuer name that is
     * inside its validity window and ignores later ones for that issuer; an
     * expired or not-yet-valid CRL is skipped when a current one follows,
     * while a CRL with a bad signature still blocks when it is the selected
     * one. A key-rollover CA's CRL and the root's can share the issuer DN
     * while only one verifies under the issuer being checked, so the
     * selected CRL's signature is checked here, not at parse time. */
    const mbedtls_x509_crl *match = NULL;
    const mbedtls_x509_crl *first = NULL;
    for (const mbedtls_x509_crl *crl = crls; crl != NULL && crl->raw.len > 0; crl = crl->next) {
      if (crl->issuer_raw.len != cert->issuer_raw.len ||
          memcmp(crl->issuer_raw.p, cert->issuer_raw.p, crl->issuer_raw.len) != 0)
        continue;
      if (first == NULL) first = crl;
      if (match == NULL && !mbedtls_x509_time_is_past(&crl->next_update) &&
          !mbedtls_x509_time_is_future(&crl->this_update))
        match = crl;
    }
    if (first == NULL) {
      missing = true;
      continue;
    }
    if (match == NULL) match = first; /* none current: the first reports why */
    if (!scr_tls_crl_signed_by(match, issuer)) {
      sig_fail = true;
      continue;
    }
    /* OpenSSL checks the CRL signer's key usage as soon as the signature
     * verifies: a CA whose keyUsage extension is present without cRLSign
     * may not revoke (or vouch for) anything. */
    if (issuer->MBEDTLS_PRIVATE(key_usage) != 0 &&
        (issuer->MBEDTLS_PRIVATE(key_usage) & MBEDTLS_X509_KU_CRL_SIGN) == 0) {
      key_usage = true;
      continue;
    }
    if (mbedtls_x509_time_is_past(&match->next_update)) {
      expired = true;
      continue;
    }
    if (mbedtls_x509_time_is_future(&match->this_update)) {
      future = true;
      continue;
    }
    if (scr_tls_crl_lists(match, cert)) revoked = true;
  }
  if (revoked) {
    t->vrfy_crl_revoked = true;
  } else if (missing) {
    t->vrfy_crl_missing = true;
  } else {
    if (key_usage) t->vrfy_crl_key_usage = true;
    if (sig_fail) t->vrfy_crl_sig_fail = true;
    if (expired) t->vrfy_crl_expired = true;
    if (future) t->vrfy_crl_future = true;
  }
}

static bool scr_tls_leaf_bad_sig(ScrTlsSock *t, mbedtls_x509_crt *leaf) {
  if (t->vrfy_trust == NULL || leaf->MBEDTLS_PRIVATE(sig).len == 0) return false;
  const mbedtls_md_info_t *md = mbedtls_md_info_from_type(leaf->MBEDTLS_PRIVATE(sig_md));
  if (md == NULL) return false;
  for (mbedtls_x509_crt *ca = t->vrfy_trust; ca != NULL && ca->raw.len > 0; ca = ca->next) {
    if (ca->subject_raw.len != leaf->issuer_raw.len ||
        memcmp(ca->subject_raw.p, leaf->issuer_raw.p, leaf->issuer_raw.len) != 0)
      continue;
    if (!mbedtls_pk_can_do(&ca->pk, leaf->MBEDTLS_PRIVATE(sig_pk))) return false;
    unsigned char hash[MBEDTLS_MD_MAX_SIZE];
    if (mbedtls_md(md, leaf->tbs.p, leaf->tbs.len, hash) != 0) return false;
    int rc = mbedtls_pk_verify_ext(leaf->MBEDTLS_PRIVATE(sig_pk), leaf->MBEDTLS_PRIVATE(sig_opts),
                                   &ca->pk, leaf->MBEDTLS_PRIVATE(sig_md), hash,
                                   mbedtls_md_get_size(md), leaf->MBEDTLS_PRIVATE(sig).p,
                                   leaf->MBEDTLS_PRIVATE(sig).len);
    return rc != 0;
  }
  return false;
}

/* Node's ERR_TLS_CERT_ALTNAME_INVALID message carries the leaf's
 * subjectAltName as OpenSSL renders it ("DNS:a, IP Address:1.2.3.4"). The
 * peer chain is gone once the handshake has failed, so render it on the
 * leaf's turn in the verify callback. */
static void scr_tls_record_altnames(ScrTlsSock *t, mbedtls_x509_crt *leaf) {
  free(t->vrfy_altnames);
  t->vrfy_altnames = NULL;
  /* Two passes over the SANs: size the exact rendering, then write it.
   * Nothing is copied from a fixed-size temporary, so a SAN longer than a
   * small stack buffer cannot turn a truncated snprintf result into an
   * out-of-bounds read. Sizing and writing read the same mbedTLS sequence. */
  size_t total = 0;
  size_t items = 0;
  for (const mbedtls_x509_sequence *cur = &leaf->subject_alt_names; cur != NULL; cur = cur->next) {
    if (cur->buf.p == NULL) continue;
    unsigned char tag = (unsigned char)cur->buf.tag & MBEDTLS_ASN1_TAG_VALUE_MASK;
    size_t prefix;
    size_t value;
    if (tag == MBEDTLS_X509_SAN_DNS_NAME) {
      prefix = sizeof "DNS:" - 1;
      value = cur->buf.len;
    } else if (tag == MBEDTLS_X509_SAN_IP_ADDRESS) {
      if (cur->buf.len != 4 && cur->buf.len != 16) continue;
      prefix = sizeof "IP Address:" - 1;
      value = 64; /* an IPv6 address in eight uncompressed groups at most */
    } else if (tag == MBEDTLS_X509_SAN_RFC822_NAME) {
      prefix = sizeof "email:" - 1;
      value = cur->buf.len;
    } else if (tag == MBEDTLS_X509_SAN_UNIFORM_RESOURCE_IDENTIFIER) {
      prefix = sizeof "URI:" - 1;
      value = cur->buf.len;
    } else {
      continue;
    }
    if (value > SIZE_MAX - prefix || prefix + value > SIZE_MAX - total) scr_tls_oom();
    total += prefix + value;
    items++;
  }
  if (items > 1) {
    if (items - 1 > SIZE_MAX / 2 || 2 * (items - 1) > SIZE_MAX - total) scr_tls_oom();
    total += 2 * (items - 1);
  }
  if (total == SIZE_MAX) scr_tls_oom();
  char *out = malloc(total + 1); /* the terminator sits after the content */
  if (out == NULL) scr_tls_oom();
  size_t used = 0;
  bool first = true;
  for (const mbedtls_x509_sequence *cur = &leaf->subject_alt_names; cur != NULL; cur = cur->next) {
    if (cur->buf.p == NULL) continue;
    unsigned char tag = (unsigned char)cur->buf.tag & MBEDTLS_ASN1_TAG_VALUE_MASK;
    const char *prefix;
    char ip[64];
    const unsigned char *payload = cur->buf.p;
    size_t len = cur->buf.len;
    if (tag == MBEDTLS_X509_SAN_DNS_NAME) {
      prefix = "DNS:";
    } else if (tag == MBEDTLS_X509_SAN_IP_ADDRESS) {
      prefix = "IP Address:";
      if (len == 4) {
        snprintf(ip, sizeof ip, "%u.%u.%u.%u", payload[0], payload[1], payload[2], payload[3]);
      } else if (len == 16) {
        /* OpenSSL prints an iPAddress SAN as eight uncompressed groups */
        const unsigned char *b = payload;
        snprintf(ip, sizeof ip, "%x:%x:%x:%x:%x:%x:%x:%x", (b[0] << 8) | b[1],
                 (b[2] << 8) | b[3], (b[4] << 8) | b[5], (b[6] << 8) | b[7],
                 (b[8] << 8) | b[9], (b[10] << 8) | b[11], (b[12] << 8) | b[13],
                 (b[14] << 8) | b[15]);
      } else {
        continue;
      }
      payload = (const unsigned char *)ip;
      len = strlen(ip);
    } else if (tag == MBEDTLS_X509_SAN_RFC822_NAME) {
      prefix = "email:";
    } else if (tag == MBEDTLS_X509_SAN_UNIFORM_RESOURCE_IDENTIFIER) {
      prefix = "URI:";
    } else {
      continue;
    }
    if (!first) {
      out[used++] = ',';
      out[used++] = ' ';
    }
    size_t prefix_len = strlen(prefix);
    memcpy(out + used, prefix, prefix_len);
    used += prefix_len;
    memcpy(out + used, payload, len);
    used += len;
    first = false;
  }
  out[used] = '\0';
  t->vrfy_altnames = out;
}

/* OpenSSL's path length check: a CA certificate's basicConstraints
 * pathlen caps the number of non-self-issued CA certificates below it.
 * mbedTLS refuses the over-long parent as a candidate and reports the
 * chain as untrusted, and its callback runs top-down, so the constraint is
 * checked per certificate against the depth mbedTLS reports (stored
 * pathlen is one higher than the limit; the trust anchor sits one level
 * above the topmost presented certificate). */
static bool scr_tls_pathlen_exceeded(ScrTlsSock *t, mbedtls_x509_crt *crt, int depth) {
  const mbedtls_x509_crt *anchor = NULL;
  if (crt->next == NULL && t->vrfy_trust != NULL && crt->issuer_raw.len > 0) {
    for (mbedtls_x509_crt *ca = t->vrfy_trust; ca != NULL && ca->raw.len > 0; ca = ca->next) {
      if (ca->subject_raw.len == crt->issuer_raw.len &&
          memcmp(ca->subject_raw.p, crt->issuer_raw.p, crt->issuer_raw.len) == 0) {
        anchor = ca;
        break;
      }
    }
  }
  if (crt->MBEDTLS_PRIVATE(ca_istrue) && crt->MBEDTLS_PRIVATE(max_pathlen) > 0 &&
      depth > crt->MBEDTLS_PRIVATE(max_pathlen))
    return true;
  if (anchor != NULL && anchor->MBEDTLS_PRIVATE(max_pathlen) > 0 &&
      depth + 1 > anchor->MBEDTLS_PRIVATE(max_pathlen))
    return true;
  return false;
}

static void scr_tls_reset_verify_state(ScrTlsSock *t);
/* The detector for a renegotiation that completed inside the engine's own
 * read: the events it owes and the verdicts it must satisfy. */
static void scr_tls_peer_renegotiated(ScrTlsSock *t);

static int scr_tls_vrfy_cb(void *ctx, mbedtls_x509_crt *crt, int depth, uint32_t *flags) {
  ScrTlsSock *t = (ScrTlsSock *)ctx;
  /* A new handshake — a caller- or peer-initiated renegotiation — walks a
   * NEW peer chain: the previous walk's recorded pointers belong to state
   * mbedTLS frees when it restarts, so they are dropped before this walk
   * records anything. */
  if (t->vrfy_walk_done) {
    scr_tls_reset_verify_state(t);
    t->vrfy_walk_done = false;
  }
  t->peer_cert_parsed = true;
  t->vrfy_seen = true;
  /* Keep the chain mbedTLS built: the CRL check walks these certificates,
   * not the peer's presented list, whose extra entries it never verified. */
  if (depth >= 0 && (size_t)depth < 16) {
    t->vrfy_chain[depth] = crt;
    if ((size_t)depth + 1 > t->vrfy_chain_len) t->vrfy_chain_len = (size_t)depth + 1;
  }
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
  /* Node's blocked-SPKI policy (crypto_context.cc CertVerifyCallback) runs
   * over the selected chain before the verification verdict is reported,
   * and its CERT_REVOKED outranks whatever that verdict found. The walk
   * runs depth-descending, so its first call is the chain's top. */
  if (t->vrfy_top == NULL) t->vrfy_top = crt;
  if (scr_tls_spki_check(crt) != 0) {
    *flags |= MBEDTLS_X509_BADCERT_REVOKED;
    t->vrfy_blocked = true;
  }
  /* the chain Node selects continues past a trusted certificate through
   * every issuer the trust list can supply, which mbedTLS never walks; the
   * leaf's turn, which closes the walk, adds those certificates to the chain
   * under the same policy */
  if (depth == 0 && !t->vrfy_blocked && scr_tls_spki_anchor_blocked(t, t->vrfy_top)) {
    *flags |= MBEDTLS_X509_BADCERT_REVOKED;
    t->vrfy_blocked = true;
  }
  /* The crl option checks the whole built chain (the leaf's issuer CRL,
   * every intermediate's issuer CRL, up to the root). Any outcome fails
   * the handshake like another verification error; rejectUnauthorized:
   * false still records it for authorizationError. */
  if (depth == 0 && !t->vrfy_blocked && scr_tls_client_crls(t) != NULL) {
    scr_tls_crl_check_chain(t);
    if (t->vrfy_crl_revoked || t->vrfy_crl_missing || t->vrfy_crl_key_usage ||
        t->vrfy_crl_sig_fail ||
        t->vrfy_crl_expired || t->vrfy_crl_future)
      *flags |= MBEDTLS_X509_BADCERT_OTHER;
  }
  /* Node checks every certificate the peer sent when the chain did not
   * verify, the leaf and X509_STORE_CTX_get0_untrusted after it, so a
   * blocked key the chain did not select still reports CERT_REVOKED ahead
   * of the chain's own error. The parsed peer list hangs off the leaf and
   * is released once the handshake call returns (a failed TLS 1.2 chain is
   * gone by then), so the scan runs here, on the leaf's turn, which has
   * seen every flag of the walk. The hostname check runs outside Node's
   * X509_verify_cert, so a name mismatch alone leaves the chain verified and
   * the peer list unread: the name error stands. */
  t->vrfy_flags |= *flags;
  if (depth == 0 && !t->vrfy_blocked && (t->vrfy_flags & ~(uint32_t) MBEDTLS_X509_BADCERT_CN_MISMATCH) != 0) {
    for (const mbedtls_x509_crt *c = crt->next; c != NULL; c = c->next) {
      if (scr_tls_spki_check(c) != 0) {
        t->vrfy_blocked = true;
        *flags |= MBEDTLS_X509_BADCERT_REVOKED;
        break;
      }
    }
  }
  /* a rejecting client fails the handshake on any flag; Node's client
   * then closes without sending an alert (its Finished is discarded) */
  if (*flags != 0 && t->cli != NULL && t->cli->reject) t->quiet_failure = true;
  bool self = crt->issuer_raw.len == crt->subject_raw.len &&
              memcmp(crt->issuer_raw.p, crt->subject_raw.p, crt->subject_raw.len) == 0;
  if (depth == 0) {
    t->vrfy_walk_done = true; /* the leaf's turn closes the walk */
    /* a walked chain means a handshake is completing: its report (if a
     * renegotiation) has not been made yet */
    t->renego_reported = false;
  }
  if (*flags & MBEDTLS_X509_BADCERT_EXPIRED) t->vrfy_expired = true;
  if (*flags & MBEDTLS_X509_BADCERT_FUTURE) t->vrfy_future = true;
  if (*flags & MBEDTLS_X509_BADCERT_CN_MISMATCH) {
    t->vrfy_cn_mismatch = true;
    scr_tls_record_altnames(t, crt);
  }
  if (*flags & MBEDTLS_X509_BADCERT_NOT_TRUSTED) {
    if (depth == 0 && self) t->vrfy_leaf_self = true;
    if (depth > 0 && self) t->vrfy_chain_self = true;
    if (depth == 0 && !self && scr_tls_leaf_bad_sig(t, crt)) t->vrfy_bad_sig = true;
    if ((*flags & MBEDTLS_X509_BADCERT_NOT_TRUSTED) != 0 && !self &&
      scr_tls_pathlen_exceeded(t, crt, depth))
    t->vrfy_pathlen = true;
  }
  /* the crl option's verdict; the blocked-SPKI policy's own
   * BADCERT_REVOKED is the same Node code and already recorded */
  /* a CRL that failed its signature or window reports that instead of its
   * entries, so its revocation result does not stand (Node's precedence) */
  if ((*flags & MBEDTLS_X509_BADCERT_REVOKED) != 0 && !t->vrfy_blocked &&
      (*flags & (MBEDTLS_X509_BADCRL_EXPIRED | MBEDTLS_X509_BADCRL_FUTURE |
                 MBEDTLS_X509_BADCRL_NOT_TRUSTED | MBEDTLS_X509_BADCRL_BAD_MD |
                 MBEDTLS_X509_BADCRL_BAD_PK | MBEDTLS_X509_BADCRL_BAD_KEY)) == 0)
    t->vrfy_crl_revoked = true;
  if (*flags & MBEDTLS_X509_BADCRL_EXPIRED) t->vrfy_crl_expired = true;
  if (*flags & MBEDTLS_X509_BADCRL_FUTURE) t->vrfy_crl_future = true;
  if (*flags & (MBEDTLS_X509_BADCRL_NOT_TRUSTED | MBEDTLS_X509_BADCRL_BAD_MD |
                MBEDTLS_X509_BADCRL_BAD_PK | MBEDTLS_X509_BADCRL_BAD_KEY)) {
    if (scr_tls_crl_issuer_trusted(t)) t->vrfy_crl_sig_fail = true;
    else t->vrfy_crl_missing = true;
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
static void scr_tls_fire_ticket_session(ScrTlsSock *t);
static uint32_t scr_tls_read_verdict(const ScrTlsSock *t);

static ssize_t scr_tls_xread(void *tctx, char *buf, size_t n) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  for (;;) {
    int r = mbedtls_ssl_read(&t->ssl, (unsigned char *)buf, n);
    /* mbedTLS drives a peer-initiated renegotiation inside the read: the
     * events and verdicts the handshake path owes are settled here */
    scr_tls_peer_renegotiated(t);
    if (scr_exc_pending()) return -1;
    if (r > 0) return r;
    if (r == 0 || r == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || r == MBEDTLS_ERR_SSL_CONN_EOF) {
      return 0; /* orderly (or abrupt-but-quiet) EOF — Node's 'end' either way */
    }
#if defined(MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET)
    if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) {
      /* a 1.3 ticket, not app data: the client 'session' event's moment */
      if (!scr_exc_pending()) scr_tls_fire_ticket_session(t);
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
  /* a peer's renegotiation can complete on the write path too (mbedTLS
   * processes handshake records while it writes): the events it owes */
  scr_tls_peer_renegotiated(t);
  if (r >= 0) return r;
#if defined(MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET)
  if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) {
    /* a ticket read while writing: its 'session' event fires now, and the
     * write retries once the engine is ready */
    if (!scr_exc_pending()) scr_tls_fire_ticket_session(t);
    errno = EAGAIN;
    return -1;
  }
#endif
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
  /* Node checks the blocked list before it looks at the verification's
   * own error, so CERT_REVOKED takes precedence */
  if (t->vrfy_blocked) {
    snprintf(out, n, "certificate revoked");
    return;
  }
  /* A revocation outranks a missing CRL (Node reports a revoked
   * intermediate even when the leaf's issuer CRL was not supplied); a
   * CRL that fails its signature or window reports that instead of its
   * entries. */
  if (t->vrfy_crl_revoked) {
    snprintf(out, n, "certificate revoked");
    return;
  }
  if (t->vrfy_crl_missing) {
    snprintf(out, n, "unable to get certificate CRL");
    return;
  }
  if (t->vrfy_crl_key_usage) {
    snprintf(out, n, "key usage does not include CRL signing");
    return;
  }
  if (t->vrfy_crl_sig_fail) {
    snprintf(out, n, "CRL signature failure");
    return;
  }
  if (t->vrfy_crl_expired) {
    snprintf(out, n, "CRL has expired");
    return;
  }
  if (t->vrfy_crl_future) {
    snprintf(out, n, "CRL is not yet valid");
    return;
  }
  if (t->vrfy_expired) {
    snprintf(out, n, "certificate has expired");
    return;
  }
  if (t->vrfy_future) {
    snprintf(out, n, "certificate is not yet valid");
    return;
  }
  if (t->vrfy_bad_sig) {
    snprintf(out, n, "certificate signature failure");
    return;
  }
  if (t->vrfy_pathlen) {
    snprintf(out, n, "path length constraint exceeded");
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
    const char *name = t->cli != NULL ? t->cli->verify_name : NULL;
    const char *names = t->vrfy_altnames != NULL ? t->vrfy_altnames : "";
    if (name != NULL && scr_tls_is_ip(name)) {
      /* Node lists only the certificate's IP entries for an IP request */
      char ips[1024];
      size_t used = 0;
      const char *at = names;
      while (*at != '\0') {
        const char *comma = strstr(at, ", ");
        size_t len = comma != NULL ? (size_t)(comma - at) : strlen(at);
        if (len >= 11 && memcmp(at, "IP Address:", 11) == 0) {
          if (used != 0 && used + 2 < sizeof ips) {
            memcpy(ips + used, ", ", 2);
            used += 2;
          }
          if (used + len < sizeof ips) {
            memcpy(ips + used, at, len);
            used += len;
          }
        }
        if (comma == NULL) break;
        at = comma + 2;
      }
      ips[used] = '\0';
      snprintf(out, n, "Hostname/IP does not match certificate's altnames: IP: %s is not in the cert's list: %s",
               name, ips);
    } else {
      snprintf(out, n,
               "Hostname/IP does not match certificate's altnames: Host: %s. is not in the cert's altnames: %s",
               name != NULL ? name : "", names);
    }
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
  (void)p;
  ScrTlsSock *t = scr_tls_current;
  /* Node records the requested name on the socket (tlsSocket.servername) */
  if (t != NULL && t->sni_name == NULL && name != NULL && len > 0 && len < 256)
    t->sni_name = scr_str_new((const char *)name, len);
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
  /* a renegotiation the policy ended is destroyed once its flight is out */
  if (t != NULL && t->close_after_hold) {
    t->close_after_hold = false;
    scr_net_sock_destroy(s);
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
  /* the policy this handshake runs under, for the authorization answers */
  t->verdict_req_cert = t->req_cert;
  t->handshake_started = true;
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
#if defined(MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET)
  if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) {
    /* a TLS 1.3 ticket that rode the final handshake flight: its 'session'
     * event is owed now (the read path was not the caller that saw it, and
     * waiting for another read stalls when nothing more arrives) */
    if (!scr_exc_pending()) scr_tls_fire_ticket_session(t);
    r = MBEDTLS_ERR_SSL_WANT_READ;
  }
#endif
  if (r == 0) {
    /* A server's renegotiation starts with a HelloRequest: the engine
     * answers that call successfully while the peer's hello has not
     * arrived, so for an established server socket only the DONE status
     * means the handshake is over. Until then the peer's hello drives the
     * handshake through the read path, which writes its flights as it
     * goes. */
    if (t->srv != NULL && t->established && t->ssl.MBEDTLS_PRIVATE(renego_status) != 2) {
      t->holding = false;
      if (t->held_len > t->held_off) (void)scr_tls_flush_held(t);
      return 0;
    }
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
  char msg[512];
  const char *err = msg;
  char *heap_msg = NULL;
  if (r == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED) {
    /* the altname rendering can be longer than the fixed buffer: size the
     * message to it rather than truncating a certificate's SAN list */
    size_t cap = sizeof msg;
    if (t->vrfy_altnames != NULL) {
      size_t alt = strlen(t->vrfy_altnames);
      if (alt > SIZE_MAX - sizeof msg) scr_tls_oom();
      cap = alt + sizeof msg;
    }
    if (cap > sizeof msg) {
      heap_msg = malloc(cap);
      if (heap_msg == NULL) scr_tls_oom();
      err = heap_msg;
    }
    scr_tls_verify_msg(t, heap_msg != NULL ? heap_msg : msg, cap);
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
  scr_net_sock_transport_error(t->sock, err);
  free(heap_msg);
  return -1;
}

static void scr_tls_on_established(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  t->established = true;
  /* sampled before secureConnect's listeners run: the 1.2 session belongs
   * to the listeners the handshake found */
  t->session_armed = t->cli != NULL && t->session_ls.n > 0;
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
  scr_bytes_release(t->session_cached);
  scr_bytes_release(t->ticket_cached);
  scr_net_ls_drop(&t->keylog_ls);
  scr_net_ls_drop(&t->secure_ls);
  scr_net_ls_drop(&t->secure_next_ls);
  free(t->hello);
  scr_secure_ctx_release(t->sni_ctx);
  scr_secure_ctx_release(t->pending_cert_ctx);
  scr_str_release(t->sni_name);
  mbedtls_x509_crt_free(&t->served_chain);
  if (t->server) scr_net_server_release(t->server);
  free(t->held);
  free(t->vrfy_altnames);
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
  /* the verdict this handshake stands on: recorded now, before a TLS 1.3
   * ticket exchange swaps the engine's session object. A resumed handshake
   * verified nothing, so the verdict the offered session carries stands. */
  t->standing_verify = t->cli != NULL && t->cli->has_resume && !t->peer_cert_parsed
                           ? t->cli->resume_verify
                           : mbedtls_ssl_get_verify_result(&t->ssl);
  t->standing_verify_set = true;
  /* The 1.2 session arrives after secureConnect and before 'secure', as
   * Node emits it. A 1.3 ticket comes after the handshake, so a listener
   * added during secureConnect still sees that session. */
  if (t->cli != NULL && !scr_exc_pending()) {
    const char *ver = mbedtls_ssl_get_version(&t->ssl);
    bool tls13 = ver != NULL && strcmp(ver, "TLSv1.3") == 0;
    bool resumed = t->srv != NULL ? t->session_resumed
                  : (t->cli != NULL && t->cli->has_resume && !t->peer_cert_parsed);
    /* TLS 1.2's session rides the handshake; a TLS 1.3 ticket arrives
     * later and fires the event when it does */
    if (!resumed && !tls13 && t->session_armed) scr_tls_fire_session(t);
  }
  if (scr_exc_pending()) return;
  /* the listeners stay: a TLS 1.2 renegotiation re-fires 'secure' (the
   * settle path drops them with the socket's other lists) */
  t->secure_emitted = true;
  scr_net_fire0_this(&t->secure_ls, t->sock, SCR_DYNH_NET_SOCKET);
  if (scr_exc_pending()) return;
  /* the registrations that arrived during the connect listeners join the
   * live list for the next emission */
  if (t->secure_next_ls.n > 0) {
    ScrNetL *snap;
    size_t n = scr_net_ls_snapshot(&t->secure_next_ls, &snap);
    for (size_t i = 0; i < n; i++)
      /* the snapshot owns a reference per entry: moving it into the live
       * list balances the temp list's drop */
      scr_net_ls_add(&t->secure_ls, snap[i].cb, snap[i].fn, snap[i].once);
    free(snap);
    scr_net_ls_drop(&t->secure_next_ls);
  }
}

/* The closed socket settles: its 'secure' and 'session' listeners can no
 * longer fire, and a listener that captures the socket would otherwise
 * keep it, and this transport, alive (a handshake that fails never fires
 * 'secure'). */
static void scr_tls_settle(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  t->settled = true;
  scr_net_ls_drop(&t->secure_ls);
  scr_net_ls_drop(&t->secure_next_ls);
  scr_net_ls_drop(&t->session_ls);
  scr_net_ls_drop(&t->keylog_ls);
  if (t->hang_up_pending) {
    t->hang_up_pending = false;
    scr_tls_client_error(t, "socket hang up", "ECONNRESET");
  }
}

static int scr_tls_renegotiate(void *tctx);
static void scr_tls_on_renegotiated(void *tctx);
static bool scr_tls_renegotiation_ready(void *tctx);

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
  .renegotiate = scr_tls_renegotiate,
  .on_renegotiated = scr_tls_on_renegotiated,
  .renegotiation_ready = scr_tls_renegotiation_ready,
  .drain = scr_tls_drain,
};

/* ── the server surface ──────────────────────────────────────────────── */

/* The 'keylog' export callback (defined with the event surface below): the
 * engine exports each handshake secret through it. */
static void scr_tls_keylog_cb(void *ctx, mbedtls_ssl_key_export_type type,
                              const unsigned char *secret, size_t secret_len,
                              const unsigned char client_random[32],
                              const unsigned char server_random[32],
                              mbedtls_tls_prf_types tls_prf_type);

/* The server's native-connection hook: one TLS engine per accepted
 * socket; the deferred 'connection' fires from the net pump once the
 * handshake stands. */
static void scr_tls_srv_on_conn(void *ctx, ScrNetSocket *sock) {
  ScrTlsSrv *srv = (ScrTlsSrv *)ctx;
  ScrTlsSock *t = calloc(1, sizeof *t);
  if (!t) scr_tls_oom();
  mbedtls_ssl_init(&t->ssl);
  if (mbedtls_ssl_setup(&t->ssl, &srv->conf) != 0) scr_tls_oom();
  mbedtls_ssl_set_export_keys_cb(&t->ssl, &scr_tls_keylog_cb, t);
  if (srv->request_cert) {
    mbedtls_ssl_set_verify(&t->ssl, &scr_tls_vrfy_cb, t);
    t->vrfy_trust = srv->has_ca ? &srv->ca : scr_tls_system_ca();
  }
  t->sock = sock;
  t->srv = scr_tls_srv_retain(srv);
  /* the socket's own policy starts as the server's (Node's _requestCert /
   * _rejectUnauthorized); renegotiate(options) may change it */
  t->req_cert = srv->request_cert;
  t->reject_unauth = srv->client_reject;
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
  }
  /* The SNI callback runs for every server: it records the requested name
   * (tlsSocket.servername) and hands the context an SNI answer replaces
   * the default certificate only when one is configured. */
  mbedtls_ssl_conf_sni(&srv->conf, &scr_tls_f_sni, NULL);
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
  /* The handler is Node's 'secureConnection': it rides the handshake's
   * own list, so the server's 'connection' listeners still fire at
   * accept. */
  ScrNetServer *s = scr_net_create_server(NULL, NULL);
  scr_net_server_set_native_conn(s, &scr_tls_srv_on_conn, srv, &scr_tls_srv_release_v);
  scr_net_server_set_native_settle(s, &scr_tls_srv_settle);
  scr_net_server_defer_connections(s);
  if (handler != NULL) scr_net_server_on_secure_connection(s, handler, fn, false);
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
                                                  ScrHttpReqFn fn, const ScrTlsClientAuth *auth /*nullable*/,
                                                  int min_version, int max_version) {
  ScrNetServer *s = scr_http_create_server(handler, fn);
  ScrTlsSrv *srv = scr_tls_srv_new(cert, cert_len, key, key_len, true /* ALPN http/1.1 */);
  (void)scr_tls_conf_versions(&srv->conf, min_version, max_version);
  srv->max_tls12 = max_version == 12;
  scr_tls_srv_client_auth(srv, auth);
  /* wrap the parser hook: TLS first, parser at establishment */
  scr_net_server_get_native_conn(s, &srv->inner_conn, &srv->inner_ctx, &srv->inner_ctx_free);
  scr_net_server_set_native_conn(s, &scr_tls_srv_on_conn, srv, &scr_tls_srv_release_v);
  scr_net_server_set_native_settle(s, &scr_tls_srv_settle);
  scr_net_server_defer_connections(s);
  return s;
}

ScrNetServer *scr_https_create_server(const char *cert, size_t cert_len, const char *key,
                                       size_t key_len, ScrClosure *handler /*moves*/,
                                       ScrHttpReqFn fn) {
  return scr_https_create_server_auth(cert, cert_len, key, key_len, handler, fn, NULL, 12, 13);
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
  scr_net_server_set_native_settle(s, &scr_tls_srv_settle);
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
  /* the session option: offered for resumption from the first handshake. A
   * session captured before its peer verified is not offered under settings
   * that now verify: the full handshake re-checks the chain and fails the way
   * the original verification did (Node/OpenSSL does not carry an unverified
   * session into a verifying connection). */
  if (cli->has_resume && !(cli->reject && cli->resume_verify != 0))
    (void)mbedtls_ssl_set_session(&t->ssl, &cli->resume);
  t->handshake_started = true; /* tls.connect starts the handshake at once */
  mbedtls_ssl_set_export_keys_cb(&t->ssl, &scr_tls_keylog_cb, t);
  /* NULL sends no SNI and skips mbedTLS's name check; the verify callback
   * checks cli->verify_name instead */
  (void)mbedtls_ssl_set_hostname(&t->ssl, cli->hostname);
  mbedtls_ssl_set_verify(&t->ssl, &scr_tls_vrfy_cb, t);
  if (cli->verify_recorded)
    t->vrfy_trust = cli->has_ca ? &cli->ca : scr_tls_system_ca();
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
  /* the session option: offered for resumption from the first handshake. A
   * session captured before its peer verified is not offered under settings
   * that now verify: the full handshake re-checks the chain and fails the way
   * the original verification did (Node/OpenSSL does not carry an unverified
   * session into a verifying connection). */
  if (cli->has_resume && !(cli->reject && cli->resume_verify != 0))
    (void)mbedtls_ssl_set_session(&t->ssl, &cli->resume);
  t->handshake_started = true; /* tls.connect starts the handshake at once */
  mbedtls_ssl_set_export_keys_cb(&t->ssl, &scr_tls_keylog_cb, t);
  (void)mbedtls_ssl_set_hostname(&t->ssl, cli->hostname);
  mbedtls_ssl_set_verify(&t->ssl, &scr_tls_vrfy_cb, t);
  if (cli->verify_recorded)
    t->vrfy_trust = cli->has_ca ? &cli->ca : scr_tls_system_ca();
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

/* A fetch transport context the request never wrapped: the fetch unit owns
 * it until the socket takes it in the wrap hook, and gives it back here when
 * the request stops before wrapping. */
void scr_tls_fetch_ctx_release(void *vctx) {
  if (vctx != NULL) scr_tls_cli_free(vctx);
}

void scr_tls_fetch_tunnel_ctx_release(void *vctx) {
  ScrTlsTunnelCtx *ctx = vctx;
  if (ctx == NULL) return;
  if (ctx->proxy != NULL) scr_tls_cli_free(ctx->proxy);
  if (ctx->target != NULL) scr_tls_cli_free(ctx->target);
  free(ctx->req);
  free(ctx);
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
  /* a constructor check threw before any socket took the config */
  if (c == NULL) scr_tls_cli_free(cli);
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
  if (!scr_http_url_parts(url, true, "https.request", &host, &port, &path)) {
    if (cb) scr_closure_release(cb);
    return NULL; /* Invalid URL / ERR_INVALID_PROTOCOL / credentials pending */
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
  /* a constructor check threw before any socket took the config */
  if (c == NULL) scr_tls_cli_free(cli);
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
  { ScrStr *refused = scr_jb_finish(&b); scr_throw_error_msg_code(SCR_ERR_ERROR, refused->data, refused->len, "SC2020"); scr_str_release(refused); }
}

/* JS truthiness over the dyn kinds — Node reads requestCert (and a
 * standalone TLSSocket's rejectUnauthorized) through `if (options.x)`. */
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

/* tls.Server and tls.connect read rejectUnauthorized as
 * `options.rejectUnauthorized !== false`: null, 0 and "" keep it on. */
static bool scr_tls_dyn_not_false(const ScrDyn *v) {
  return v->kind != SCR_DYN_BOOL || v->v.b;
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
      { ScrStr *refused = scr_jb_finish(&b); scr_throw_error_msg_code(SCR_ERR_ERROR, refused->data, refused->len, "SC2020"); scr_str_release(refused); }
      return NULL;
    }
    if (v->v.arr.len > 1 && !concat) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, what);
      scr_jb_puts(&b, " with more than one array entry has no static lowering — one cert/key pair per server here");
      { ScrStr *refused = scr_jb_finish(&b); scr_throw_error_msg_code(SCR_ERR_ERROR, refused->data, refused->len, "SC2020"); scr_str_release(refused); }
      return NULL;
    }
    /* concatenate (mbedTLS parses concatenated PEM — the ca-bundle shape).
     * Snapshot every entry once: a SharedArrayBuffer-backed view can change
     * between passes, and sizing from one read then copying from another
     * could overflow the allocation. The sizing keeps the old worst-case
     * budget (one separator per entry); the copy inserts a separator only
     * between entries and only when the snapshot does not already end its
     * line: a trailing newline after the last block leaves mbedTLS a
     * non-empty buffer it tries to parse as another PEM, which fails. */
    const size_t count = v->v.arr.len;
    unsigned char **snap = calloc(count, sizeof *snap);
    size_t *snap_len = calloc(count, sizeof *snap_len);
    if (snap == NULL || snap_len == NULL) {
      free(snap);
      free(snap_len);
      scr_tls_oom();
    }
    size_t budget = 0;
    for (size_t i = 0; i < count; i++) {
      const ScrDyn *e = v->v.arr.items[i];
      size_t n;
      if (e->kind == SCR_DYN_STR) n = e->v.str->len;
      else if (scr_dyn_bytes_is(e, SCR_BYTES_U8)) n = e->v.bytes->len;
      else {
        scr_dyn_arg_type_fail(what, "of type string or an instance of Buffer or Uint8Array", e);
        for (size_t k = 0; k < i; k++) free(snap[k]);
        free(snap);
        free(snap_len);
        return NULL;
      }
      unsigned char *copy = malloc(n > 0 ? n : 1);
      if (copy == NULL) scr_tls_oom();
      if (e->kind == SCR_DYN_STR) memcpy(copy, e->v.str->data, n);
      else scr_bytes_read(e->v.bytes, 0, copy, n);
      snap[i] = copy;
      snap_len[i] = n;
      if (n > SIZE_MAX - budget - 1) { /* worst-case separator budget overflow */
        for (size_t k = 0; k <= i; k++) free(snap[k]);
        free(snap);
        free(snap_len);
        scr_tls_oom();
      }
      budget += n + 1; /* worst case: one separator after every entry */
    }
    unsigned char *joined = malloc(budget > 0 ? budget : 1);
    if (joined == NULL) scr_tls_oom();
    size_t off = 0;
    for (size_t i = 0; i < count; i++) {
      size_t n = snap_len[i];
      memcpy(joined + off, snap[i], n);
      off += n;
      if (i + 1 < count && (n == 0 || snap[i][n - 1] != '\n'))
        joined[off++] = '\n'; /* PEM blocks join on line boundaries */
    }
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)off);
    memcpy(b->data, joined, off);
    free(joined);
    for (size_t i = 0; i < count; i++) free(snap[i]);
    free(snap);
    free(snap_len);
    return b;
  }
  scr_dyn_arg_type_fail(what, "of type string or an instance of Buffer or Uint8Array", v);
  return NULL;
}

/* A ca array: each entry is kept separate in the framed buffer above. */
static ScrBytes *scr_tls_ca_array_dyn(const ScrDyn *ca, const char *what) {
  size_t count = ca->v.arr.len;
  size_t total = SCR_TLS_CA_ARRAY_MAGIC_LEN + SCR_TLS_CA_ARRAY_LEN_BYTES;
  for (size_t i = 0; i < count; i++) {
    const ScrDyn *e = ca->v.arr.items[i];
    size_t n;
    if (e->kind == SCR_DYN_STR) n = e->v.str->len;
    else if (scr_dyn_bytes_is(e, SCR_BYTES_U8)) n = e->v.bytes->len;
    else {
      scr_dyn_arg_type_fail(what, "of type string or an instance of Buffer or Uint8Array", e);
      return NULL;
    }
    if (n > SIZE_MAX - total - SCR_TLS_CA_ARRAY_LEN_BYTES) scr_tls_oom();
    total += SCR_TLS_CA_ARRAY_LEN_BYTES + n;
  }
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)total);
  memcpy(b->data, SCR_TLS_CA_ARRAY_MAGIC, SCR_TLS_CA_ARRAY_MAGIC_LEN);
  size_t off = SCR_TLS_CA_ARRAY_MAGIC_LEN;
  uint64_t n64 = (uint64_t)count;
  memcpy(b->data + off, &n64, SCR_TLS_CA_ARRAY_LEN_BYTES);
  off += SCR_TLS_CA_ARRAY_LEN_BYTES;
  for (size_t i = 0; i < count; i++) {
    const ScrDyn *e = ca->v.arr.items[i];
    size_t n = e->kind == SCR_DYN_STR ? e->v.str->len : e->v.bytes->len;
    n64 = (uint64_t)n;
    memcpy(b->data + off, &n64, SCR_TLS_CA_ARRAY_LEN_BYTES);
    off += SCR_TLS_CA_ARRAY_LEN_BYTES;
    if (e->kind == SCR_DYN_STR) memcpy(b->data + off, e->v.str->data, n);
    else scr_bytes_read(e->v.bytes, 0, b->data + off, n);
    off += n;
  }
  return b;
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
  } else if (ca->kind == SCR_DYN_ARR) {
    *out = scr_tls_ca_array_dyn(ca, what);
    ok = *out != NULL;
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

/* A client's crl for scr_tls_cli_new2, on the same rule as the ca. */
static const char *scr_tls_crl_data(const ScrBytes *crl) {
  if (crl == NULL) return NULL;
  return crl->data != NULL ? (const char *)crl->data : "";
}

/* Whether the crl option carries at least one parseable CRL; Node throws
 * ERR_CRYPTO_OPERATION_FAILED ("Failed to parse CRL") when it does not. */
static bool scr_tls_crl_valid(const ScrBytes *crl) {
  mbedtls_x509_crl parsed;
  mbedtls_x509_crl_init(&parsed);
  int r = scr_tls_parse_crl(&parsed, scr_tls_crl_data(crl), crl->len);
  mbedtls_x509_crl_free(&parsed);
  return r == 0;
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
  /* a constructor check threw before any socket took the config */
  if (req == NULL) scr_tls_cli_free(cli);
  if (ca) scr_bytes_release(ca);
  scr_http_req_opts_free(&o);
  return req;
}

/* The options form of a client chosen at runtime (`const fn = c ?
 * https.request : http.request`): the same walk, with the dial and the
 * TLS options following `secure` — false is exactly http.request, whose
 * options walk ignores TLS members like Node does. */
ScrHttpClientReq *scr_http_request_dyn_secure(const ScrDyn *opts /*borrowed*/, bool auto_end,
                                              bool secure, ScrClosure *cb /*moves, nullable*/,
                                              ScrHttpRespFn fn,
                                              ScrDyn *(*add_abort)(ScrDyn *signal,
                                                                  ScrDyn *listener)) {
  if (secure) return scr_https_request_dyn(opts, auto_end, cb, fn, add_abort);
  return scr_http_request_dyn(opts, auto_end, cb, fn, add_abort);
}

/* https.request/get(url[, options][, cb]) — the URL's fields merged under
 * the options value (scr_http.c's merge), then the same runtime walk,
 * TLS options included, as the options form. */
ScrHttpClientReq *scr_https_request_url_dyn(ScrStr *url /*borrowed*/,
                                            const ScrDyn *opts /*borrowed*/, bool auto_end,
                                            ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn,
                                            ScrDyn *(*add_abort)(ScrDyn *signal, ScrDyn *listener)) {
  ScrDyn *merged = scr_http_url_req_options(url, opts, "https.request");
  if (merged == NULL) {
    if (cb) scr_closure_release(cb);
    return NULL;
  }
  ScrHttpClientReq *req = scr_https_request_dyn(merged, auto_end, cb, fn, add_abort);
  scr_dyn_release(merged);
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
    { ScrStr *refused = scr_jb_finish(&b); scr_throw_error_msg_code(SCR_ERR_ERROR, refused->data, refused->len, "SC2020"); scr_str_release(refused); }
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
/* An option value as Node's ordinary property read sees it (+1 for a
 * present, defined value; NULL when absent or undefined). False when an
 * accessor threw: the exception is pending. */
static bool scr_tls_opt_read(const ScrDyn *opts, const char *key, size_t key_len, ScrDyn **out) {
  *out = NULL;
  ScrDyn *v = scr_dyn_obj_read(opts, key, key_len);
  if (v == NULL) return !scr_exc_pending();
  if (v->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(v);
    return true;
  }
  *out = v;
  return true;
}

static bool scr_tls_opts_validate(const ScrDyn *opts) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return true;
  static const char *const STR_OPTS[] = { "ciphers", "passphrase", "ecdhCurve", "sessionIdContext", NULL };
  for (size_t i = 0; STR_OPTS[i] != NULL; i++) {
    ScrDyn *v = NULL;
    if (!scr_tls_opt_read(opts, STR_OPTS[i], strlen(STR_OPTS[i]), &v)) return false;
    if (v != NULL && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_STR) {
      char name[48];
      snprintf(name, sizeof name, "options.%s", STR_OPTS[i]);
      scr_dyn_prop_type_fail(name, "of type string", v);
      scr_dyn_release(v);
      return false;
    }
    scr_dyn_release(v);
  }
  static const char *const ENGINE_OPTS[] = { "clientCertEngine", "privateKeyEngine", "privateKeyIdentifier", NULL };
  for (size_t i = 0; ENGINE_OPTS[i] != NULL; i++) {
    ScrDyn *v = NULL;
    if (!scr_tls_opt_read(opts, ENGINE_OPTS[i], strlen(ENGINE_OPTS[i]), &v)) return false;
    if (v != NULL && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_STR) {
      char name[48];
      snprintf(name, sizeof name, "options.%s", ENGINE_OPTS[i]);
      scr_dyn_prop_type_fail(name, "of type string or one of null or undefined", v);
      scr_dyn_release(v);
      return false;
    }
    scr_dyn_release(v);
  }
  /* Node's toV: null and undefined select the default bound. */
  int version;
  ScrDyn *vmin = NULL, *vmax = NULL;
  if (!scr_tls_opt_read(opts, "minVersion", 10, &vmin) ||
      !scr_tls_opt_read(opts, "maxVersion", 10, &vmax)) {
    scr_dyn_release(vmin);
    scr_dyn_release(vmax);
    return false;
  }
  bool versions_ok = scr_tls_version_dyn(vmin, "minimum", 12, &version) &&
                     scr_tls_version_dyn(vmax, "maximum", 13, &version);
  scr_dyn_release(vmin);
  scr_dyn_release(vmax);
  if (!versions_ok) return false;
  static const char *const NUM_OPTS[] = { "handshakeTimeout", "keepAliveInitialDelay", NULL };
  for (size_t i = 0; NUM_OPTS[i] != NULL; i++) {
    ScrDyn *v = NULL;
    if (!scr_tls_opt_read(opts, NUM_OPTS[i], strlen(NUM_OPTS[i]), &v)) return false;
    if (v != NULL && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_NUM) {
      char name[48];
      snprintf(name, sizeof name, "options.%s", NUM_OPTS[i]);
      scr_dyn_prop_type_fail(name, "of type number", v);
      scr_dyn_release(v);
      return false;
    }
    scr_dyn_release(v);
  }
  {
    ScrDyn *v = NULL;
    if (!scr_tls_opt_read(opts, "sessionTimeout", 14, &v)) return false;
    if (v != NULL && v->kind != SCR_DYN_NULL) {
      if (v->kind != SCR_DYN_NUM) {
        scr_dyn_prop_type_fail("options.sessionTimeout", "of type number", v);
        scr_dyn_release(v);
        return false;
      }
      double n = v->v.num;
      char recv[48], msg[192];
      if (!(isfinite(n) && trunc(n) == n)) {
        scr_num_received(n, recv);
        int len = snprintf(msg, sizeof msg,
                           "The value of \"options.sessionTimeout\" is out of range. It must be an integer. Received %s", recv);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
        scr_dyn_release(v);
        return false;
      }
      if (n < 0 || n > 2147483647.0) {
        scr_num_received(n, recv);
        int len = snprintf(msg, sizeof msg,
                           "The value of \"options.sessionTimeout\" is out of range. It must be >= 0 && <= 2147483647. Received %s", recv);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
        scr_dyn_release(v);
        return false;
      }
    }
    scr_dyn_release(v);
  }
  {
    ScrDyn *v = NULL;
    if (!scr_tls_opt_read(opts, "ticketKeys", 10, &v)) return false;
    if (v != NULL && v->kind != SCR_DYN_NULL) {
      if (v->kind != SCR_DYN_BYTES) {
        scr_dyn_prop_type_fail("options.ticketKeys", "an instance of Buffer, TypedArray, or DataView", v);
        scr_dyn_release(v);
        return false;
      }
      double bytelen = scr_bytes_byte_len(v->v.bytes);
      if (bytelen != 48) {
        char msg[160];
        int len = snprintf(msg, sizeof msg,
                           "The property 'options.ticketKeys' must be exactly 48 bytes. Received %.0f", bytelen);
        scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_VALUE");
        scr_dyn_release(v);
        return false;
      }
    }
    scr_dyn_release(v);
  }
  return true;
}

/* The server-options walk. Fills the cert/key out-params (+1 each) from a
 * dyn options record; false = exception pending (partial results released).
 * Exported runtime-internally: scr_http2.c's createSecureServerDyn rides
 * the same walk (scr_http2.c always links alongside this unit). */
/* `server_ok`: tls.createServer reads ALPNProtocols, minVersion and
 * maxVersion itself; the walk's other callers keep their fences. */
/* One walked TLS server option (`v` is Node's property read, owned by the
 * caller, or NULL when the member's value is not read; `defined` is false
 * for a member that reads as absent). False when the member is refused (the
 * caller stops the walk). */
static bool scr_tls_srv_opt_member(const ScrDynProp *e, const ScrDyn *v, bool defined,
                                   const char *api, bool server_ok, ScrBytes **cert_out,
                                   ScrBytes **key_out, ScrTlsClientAuth *auth) {
  if (!defined) return true; /* absent, like Node */
  if (strcmp(e->key, "cert") == 0 || strcmp(e->key, "key") == 0) {
    char what[96];
    snprintf(what, sizeof what, "a %s '%s' option", api, e->key);
    ScrBytes *b = scr_tls_pem_dyn(v, what, false);
    if (b == NULL) return false;
    ScrBytes **slot = e->key[0] == 'c' ? cert_out : key_out;
    scr_bytes_release(*slot);
    *slot = b;
    return true;
  }
  if (strcmp(e->key, "ca") == 0) {
    /* the server's `ca` verifies client certificates and completes the
     * server's own chain (scr_tls_srv_client_auth); a walk without client
     * certificates drops it */
    if (auth != NULL) {
      char what[96];
      snprintf(what, sizeof what, "a %s 'ca' option", api);
      scr_bytes_release(auth->ca);
      if (!scr_tls_ca_dyn(v, what, &auth->ca)) return false;
    }
    return true;
  }
  if (strcmp(e->key, "requestCert") == 0) {
    if (auth != NULL) {
      auth->request = scr_tls_dyn_truthy(v);
      return true;
    }
    if (scr_tls_dyn_truthy(v)) {
      scr_tls_opt_fence(api, "requestCert",
                        "requestCert lowers on tls.createServer, https.createServer and new tls.TLSSocket");
      return false;
    }
    return true;
  }
  if (strcmp(e->key, "rejectUnauthorized") == 0) {
    if (auth != NULL) {
      auth->reject = scr_tls_dyn_not_false(v);
      auth->reject_seen = true;
      auth->reject_truthy = scr_tls_dyn_truthy(v);
    }
    return true; /* without client certificates it has no effect */
  }
  if (server_ok && (strcmp(e->key, "ALPNProtocols") == 0 || strcmp(e->key, "minVersion") == 0 ||
                    strcmp(e->key, "maxVersion") == 0))
    return true;
  /* scr_tls_versions_dyn validated secureProtocol (and its conflict with a
   * version) for these APIs; other walks (http2.createSecureServer) do not
   * read or apply the method, so they keep the by-name fence below. */
  if (strcmp(e->key, "secureProtocol") == 0) {
    if (strcmp(api, "tls.createServer") == 0 || strcmp(api, "https.createServer") == 0 ||
        strcmp(api, "tls.createSecureContext") == 0 || strcmp(api, "new tls.TLSSocket") == 0)
      return true;
  }
  if (strcmp(e->key, "SNICallback") == 0) {
    scr_tls_opt_fence(api, "SNICallback",
                      "SNICallback lowers only on http2.createSecureServer({ allowHTTP1: true, ... }) with a literal options object");
    return false;
  }
  for (size_t k = 0; SCR_TLS_SRV_FENCED_OPTIONS[k] != NULL; k++) {
    if (strcmp(e->key, SCR_TLS_SRV_FENCED_OPTIONS[k]) == 0) {
      scr_tls_opt_fence(api, e->key,
                        "cert and key (PEM strings or Buffers) are the honestly-implemented members of a runtime options record");
      return false;
    }
  }
  /* anything else: an undocumented key, dropped like Node drops it */
  return true;
}

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
  if (auth != NULL)
    *auth = (ScrTlsClientAuth){.request = false, .reject = true, .reject_seen = false,
                               .reject_truthy = false, .ca = NULL};
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object", opts ? opts : scr_dyn_undefined());
    return false;
  }
  if (!scr_tls_opts_validate(opts)) return false; /* Node's typed errors first */
  /* Node's Server constructor rejects the ALPN callback and protocol list
   * together before it builds its own context. */
  if (server_ok) {
    const ScrDyn *alpn_cb = scr_dyn_obj_get(opts, "ALPNCallback", 12);
    const ScrDyn *alpn_protocols = scr_dyn_obj_get(opts, "ALPNProtocols", 13);
    if (alpn_cb != NULL && alpn_cb->kind != SCR_DYN_UNDEF && scr_tls_dyn_truthy(alpn_cb) &&
        alpn_protocols != NULL && alpn_protocols->kind != SCR_DYN_UNDEF &&
        scr_tls_dyn_truthy(alpn_protocols)) {
      static const char msg[] =
          "The ALPNCallback and ALPNProtocols TLS options are mutually exclusive";
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1,
                               "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS");
      return false;
    }
  }
  /* Snapshot the member names before any getter runs. A getter may delete an
   * earlier member, and the delete compacts the record: an index taken
   * across the getter calls would then skip the member that slid into place
   * (a requestCert could go unread). The walk classifies the snapshot, reads
   * the value-bearing members by name in Node's order, and refuses the
   * construction when a getter removed one of them. */
  size_t member_count = scr_dyn_obj_count(opts);
  char **member_keys = NULL;
  size_t *member_lens = NULL;
  bool *member_defined = NULL;
  if (member_count > 0) {
    member_keys = calloc(member_count, sizeof *member_keys);
    member_lens = calloc(member_count, sizeof *member_lens);
    member_defined = calloc(member_count, sizeof *member_defined);
    if (member_keys == NULL || member_lens == NULL || member_defined == NULL) scr_tls_oom();
    for (size_t i = 0; i < member_count; i++) {
      ScrDynProp p = scr_dyn_obj_prop_at(opts, i);
      size_t len = 0;
      const char *key = scr_dyn_obj_key_at(opts, i, &len);
      member_keys[i] = malloc(len + 1);
      if (member_keys[i] == NULL) scr_tls_oom();
      memcpy(member_keys[i], key, len);
      member_keys[i][len] = '\0';
      member_lens[i] = len;
      /* an accessor may answer anything; a data property set to undefined
       * reads as absent, like Node */
      member_defined[i] = p.accessor || (p.value != NULL && p.value->kind != SCR_DYN_UNDEF);
    }
  }
  static const char *const VALUE_OPTS[] = { "ca", "cert", "key", "requestCert",
                                            "rejectUnauthorized", NULL };
  bool ok = true;
  for (size_t i = 0; ok && i < member_count; i++) {
    bool value_opt = false;
    for (size_t k = 0; VALUE_OPTS[k] != NULL; k++)
      if (strcmp(member_keys[i], VALUE_OPTS[k]) == 0) value_opt = true;
    if (value_opt) continue; /* read by name below, in Node's order */
    ScrDynProp e = {.key = member_keys[i], .key_len = member_lens[i]};
    if (!scr_tls_srv_opt_member(&e, NULL, member_defined[i], api, server_ok, cert_out, key_out,
                                auth))
      ok = false;
  }
  for (size_t i = 0; ok && VALUE_OPTS[i] != NULL; i++) {
    ScrDyn *v = scr_dyn_obj_read(opts, VALUE_OPTS[i], strlen(VALUE_OPTS[i]));
    if (v == NULL) { ok = false; break; } /* a getter threw */
    ScrDynProp e = {.key = VALUE_OPTS[i], .key_len = strlen(VALUE_OPTS[i])};
    if (!scr_tls_srv_opt_member(&e, v, v->kind != SCR_DYN_UNDEF, api, server_ok, cert_out,
                                key_out, auth))
      ok = false;
    scr_dyn_release(v);
  }
  /* A getter that deletes one of the certificate members while the walk runs
   * would weaken the server (an unread requestCert reads as absent): refuse
   * the construction instead of quietly changing it. */
  if (ok) {
    for (size_t i = 0; ok && VALUE_OPTS[i] != NULL; i++) {
      bool listed = false;
      for (size_t k = 0; k < member_count; k++)
        if (member_lens[k] == strlen(VALUE_OPTS[i]) &&
            memcmp(member_keys[k], VALUE_OPTS[i], member_lens[k]) == 0)
          listed = true;
      if (listed && scr_dyn_obj_index_of(opts, VALUE_OPTS[i], strlen(VALUE_OPTS[i])) == SIZE_MAX) {
        static const char msg[] =
            "the https.createServer options record changed while its members were read";
        scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
        ok = false;
      }
    }
  }
  /* A documented TLS option inherited from the record's prototype is
   * supported only for the certificate members read by name above; an
   * unsupported one (an inherited `crl`, say) would otherwise be ignored.
   * Refuse those instead. */
  if (ok && opts->prototype != NULL) {
    for (size_t k = 0; ok && SCR_TLS_SRV_FENCED_OPTIONS[k] != NULL; k++) {
      const char *name = SCR_TLS_SRV_FENCED_OPTIONS[k];
      size_t len = strlen(name);
      if (scr_dyn_obj_index_of(opts, name, len) != SIZE_MAX) continue; /* own: classified above */
      ScrDyn *v = scr_dyn_obj_read(opts, name, len);
      if (v == NULL) { ok = false; break; } /* a getter threw */
      if (v->kind != SCR_DYN_UNDEF) {
        scr_tls_opt_fence(api, name,
                          "cert and key (PEM strings or Buffers) are the honestly-implemented members of a runtime options record");
        ok = false;
      }
      scr_dyn_release(v);
    }
    if (ok && scr_dyn_obj_index_of(opts, "SNICallback", 11) == SIZE_MAX) {
      ScrDyn *v = scr_dyn_obj_read(opts, "SNICallback", 11);
      if (v == NULL) {
        ok = false;
      } else {
        if (v->kind != SCR_DYN_UNDEF) {
          scr_tls_opt_fence(api, "SNICallback",
                            "SNICallback lowers only on http2.createSecureServer({ allowHTTP1: true, ... }) with a literal options object");
          ok = false;
        }
        scr_dyn_release(v);
      }
    }
  }
  for (size_t i = 0; i < member_count; i++) free(member_keys[i]);
  free(member_keys);
  free(member_lens);
  free(member_defined);
  if (ok && strcmp(api, "tls.createSecureContext") != 0 &&
      (*cert_out == NULL || *key_out == NULL)) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, api);
    scr_jb_puts(&b, " without both cert and key has no static lowering — the supported options are { cert, key } (PEM strings or Buffers)");
    { ScrStr *refused = scr_jb_finish(&b); scr_throw_error_msg_code(SCR_ERR_ERROR, refused->data, refused->len, "SC2020"); scr_str_release(refused); }
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
  int min_version = 12, max_version = 13;
  if (!scr_tls_versions_dyn(opts, &min_version, &max_version, "tls.createSecureContext"))
    return NULL;
  ScrBytes *cert, *key;
  /* requestCert and rejectUnauthorized are no context options: Node's
   * createSecureContext ignores them */
  ScrTlsClientAuth auth;
  if (!scr_tls_srv_opts_walk_ex(opts, "tls.createSecureContext", &cert, &key, false, &auth)) return NULL;
  ScrSecureCtx *c = scr_tls_create_secure_context(
      cert != NULL ? (const char *)cert->data : NULL, cert != NULL ? cert->len : 0,
      key != NULL ? (const char *)key->data : NULL, key != NULL ? key->len : 0);
  c->min_version = min_version;
  c->max_version = max_version;
  if (auth.ca != NULL) {
    /* kept for sockets created from the context (a TLSSocket's
     * secureContext); an SNI answer's chain comes from the server's
     * context in OpenSSL, so the answer's ca is not used there */
    if (auth.ca->len > 0) {
      int r = scr_tls_parse_ca_bundle(&c->ca, (const char *)auth.ca->data, auth.ca->len);
      /* Node's secure-context CA store ignores a certificate OpenSSL cannot
       * parse; mbedTLS keeps the ones it parsed and reports a positive
       * count, so only a hard failure clears the store. */
      if (r < 0) {
        mbedtls_x509_crt_free(&c->ca);
        mbedtls_x509_crt_init(&c->ca);
      }
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
  if (!scr_tls_versions_dyn(opts, &min_version, &max_version, "tls.createServer")) {
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

/* HTTPS ServerOptions extends http.ServerOptions: the record's HTTP-side
 * members go through the same setters (and the same validation ladders) as
 * the literal createServer lowering, in Node's storeHTTPOptions order. The
 * shared TLS walker above deliberately owns only the TLS surface. */
/* The https.createServer options bag's HTTP-side members: read up front so
 * an accessor's getter runs once in Node's order — storeHTTPOptions reads
 * these before the secure context does the TLS fields — then applied to the
 * server once it exists. An undefined member reads as absent. */
typedef struct ScrHttpsHttpOpts {
  ScrDyn *max_header_size;
  ScrDyn *request_timeout;
  ScrDyn *headers_timeout;
  ScrDyn *keep_alive_timeout;
  ScrDyn *keep_alive_timeout_buffer;
  ScrDyn *connections_checking_interval;
  ScrDyn *join_duplicate_headers;
  ScrDyn *require_host_header;
  ScrDyn *reject_non_standard_body_writes;
} ScrHttpsHttpOpts;

/* Reads each modeled HTTP option and runs the check Node's constructor
 * performs on it before it reads the next one, so an invalid early option
 * throws before the rest of the record's getters run. False when a getter
 * threw or a check failed (the exception is pending). */
static bool scr_https_read_http_options(const ScrDyn *opts /*OBJ, borrowed*/,
                                        ScrHttpsHttpOpts *out) {
  out->max_header_size = scr_dyn_obj_read(opts, "maxHeaderSize", sizeof "maxHeaderSize" - 1);
  if (out->max_header_size == NULL) return false; /* a getter threw */
  if (out->max_header_size->kind == SCR_DYN_NUM) {
    if (!scr_http_server_max_header_size_check(out->max_header_size->v.num)) return false;
  } else if (out->max_header_size->kind != SCR_DYN_UNDEF) {
    scr_dyn_arg_type_fail("maxHeaderSize", "of type number", out->max_header_size);
    return false;
  }
  out->request_timeout = scr_dyn_obj_read(opts, "requestTimeout", sizeof "requestTimeout" - 1);
  if (out->request_timeout == NULL) return false;
  scr_http_server_timeout_option_check(3, out->request_timeout);
  if (scr_exc_pending()) return false;
  out->headers_timeout = scr_dyn_obj_read(opts, "headersTimeout", sizeof "headersTimeout" - 1);
  if (out->headers_timeout == NULL) return false;
  scr_http_server_timeout_option_check(2, out->headers_timeout);
  if (scr_exc_pending()) return false;
  scr_http_server_headers_timeout_check(out->request_timeout, out->headers_timeout);
  if (scr_exc_pending()) return false;
  out->keep_alive_timeout =
      scr_dyn_obj_read(opts, "keepAliveTimeout", sizeof "keepAliveTimeout" - 1);
  if (out->keep_alive_timeout == NULL) return false;
  scr_http_server_timeout_option_check(1, out->keep_alive_timeout);
  if (scr_exc_pending()) return false;
  out->keep_alive_timeout_buffer =
      scr_dyn_obj_read(opts, "keepAliveTimeoutBuffer", sizeof "keepAliveTimeoutBuffer" - 1);
  if (out->keep_alive_timeout_buffer == NULL) return false;
  scr_http_server_timeout_option_check(4, out->keep_alive_timeout_buffer);
  if (scr_exc_pending()) return false;
  out->connections_checking_interval = scr_dyn_obj_read(
      opts, "connectionsCheckingInterval", sizeof "connectionsCheckingInterval" - 1);
  if (out->connections_checking_interval == NULL) return false;
  scr_http_server_connections_checking_interval_check(out->connections_checking_interval);
  if (scr_exc_pending()) return false;
  out->join_duplicate_headers =
      scr_dyn_obj_read(opts, "joinDuplicateHeaders", sizeof "joinDuplicateHeaders" - 1);
  if (out->join_duplicate_headers == NULL) return false;
  scr_http_server_boolean_option_check("options.joinDuplicateHeaders",
                                       out->join_duplicate_headers);
  if (scr_exc_pending()) return false;
  out->require_host_header =
      scr_dyn_obj_read(opts, "requireHostHeader", sizeof "requireHostHeader" - 1);
  if (out->require_host_header == NULL) return false;
  scr_http_server_boolean_option_check("options.requireHostHeader", out->require_host_header);
  if (scr_exc_pending()) return false;
  out->reject_non_standard_body_writes = scr_dyn_obj_read(
      opts, "rejectNonStandardBodyWrites", sizeof "rejectNonStandardBodyWrites" - 1);
  if (out->reject_non_standard_body_writes == NULL) return false;
  scr_http_server_boolean_option_check("options.rejectNonStandardBodyWrites",
                                       out->reject_non_standard_body_writes);
  return !scr_exc_pending();
}


static void scr_https_release_http_options(ScrHttpsHttpOpts *o) {
  scr_dyn_release(o->max_header_size);
  scr_dyn_release(o->request_timeout);
  scr_dyn_release(o->headers_timeout);
  scr_dyn_release(o->keep_alive_timeout);
  scr_dyn_release(o->keep_alive_timeout_buffer);
  scr_dyn_release(o->connections_checking_interval);
  scr_dyn_release(o->join_duplicate_headers);
  scr_dyn_release(o->require_host_header);
  scr_dyn_release(o->reject_non_standard_body_writes);
  memset(o, 0, sizeof *o);
}

/* Each step stops at its first throwing validation, so the first bad option
 * in Node's order is the one the call reports. */
static void scr_https_apply_http_options(ScrNetServer *s, const ScrHttpsHttpOpts *o) {
  ScrDyn *v = o->max_header_size;
  if (v->kind != SCR_DYN_UNDEF) {
    if (v->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("maxHeaderSize", "of type number", v);
      return;
    }
    scr_http_server_max_header_size(s, v->v.num);
    if (scr_exc_pending()) return;
  }
  /* requestTimeout, then headersTimeout (the default derives from the
   * request timeout), then their range relation. */
  v = o->request_timeout;
  if (v->kind != SCR_DYN_UNDEF) {
    scr_net_server_timeout_option_set(s, 3, v);
    if (scr_exc_pending()) return;
  }
  v = o->headers_timeout;
  if (v->kind != SCR_DYN_UNDEF) {
    scr_net_server_timeout_option_set(s, 2, v);
    if (scr_exc_pending()) return;
  }
  scr_http_server_headers_timeout_default(s, v->kind == SCR_DYN_UNDEF ? NULL : v);
  if (scr_exc_pending()) return;
  v = o->keep_alive_timeout;
  if (v->kind != SCR_DYN_UNDEF) {
    scr_net_server_timeout_option_set(s, 1, v);
    if (scr_exc_pending()) return;
  }
  v = o->keep_alive_timeout_buffer;
  if (v->kind != SCR_DYN_UNDEF) {
    scr_net_server_timeout_option_set(s, 4, v);
    if (scr_exc_pending()) return;
  }
  scr_http_server_connections_checking_interval(s, o->connections_checking_interval);
  if (scr_exc_pending()) return;
  v = o->join_duplicate_headers;
  if (v->kind != SCR_DYN_UNDEF) {
    if (v->kind != SCR_DYN_BOOL) {
      scr_dyn_arg_type_fail("options.joinDuplicateHeaders", "of type boolean", v);
      return;
    }
    if (v->v.b) scr_http_server_join_duplicate_headers(s);
  }
  v = o->require_host_header;
  if (v->kind != SCR_DYN_UNDEF) {
    if (v->kind != SCR_DYN_BOOL) {
      scr_dyn_arg_type_fail("options.requireHostHeader", "of type boolean", v);
      return;
    }
    if (!v->v.b) scr_http_server_allow_missing_host_header(s);
  }
  scr_http_server_reject_non_standard_body_writes(s, o->reject_non_standard_body_writes);
}

ScrNetServer *scr_https_create_server_dyn(const ScrDyn *opts /*borrowed*/,
                                           ScrClosure *handler /*moves, nullable*/,
                                           ScrHttpReqFn fn) {
  ScrBytes *cert, *key;
  ScrTlsClientAuth auth;
  /* Node reads the HTTP options before the TLS fields (storeHTTPOptions
   * runs ahead of the secure context), so capture them first; the TLS
   * walk's getters then see those reads already made. */
  ScrDyn *plain = NULL;
  const ScrDyn *obj = opts;
  if (opts != NULL && opts->kind == SCR_DYN_TYPED_REF) {
    plain = scr_dyn_typed_ref_materialize(opts);
    if (plain == NULL) {
      scr_closure_release(handler);
      return NULL;
    }
    obj = plain;
  }
  ScrHttpsHttpOpts http;
  memset(&http, 0, sizeof http);
  bool has_http = obj != NULL && obj->kind == SCR_DYN_OBJ;
  if (has_http && !scr_https_read_http_options(obj, &http)) {
    scr_https_release_http_options(&http);
    scr_dyn_release(plain);
    scr_closure_release(handler);
    return NULL;
  }
  int min_version = 12, max_version = 13;
  if (!scr_tls_versions_dyn(opts, &min_version, &max_version, "https.createServer")) {
    scr_https_release_http_options(&http);
    scr_dyn_release(plain);
    scr_closure_release(handler);
    return NULL;
  }
  if (!scr_tls_srv_opts_walk_ex(opts, "https.createServer", &cert, &key, false, &auth)) {
    scr_https_release_http_options(&http);
    scr_dyn_release(plain);
    scr_closure_release(handler);
    return NULL;
  }
  if (!scr_tls_versions_available(min_version, max_version)) {
    scr_bytes_release(cert);
    scr_bytes_release(key);
    scr_bytes_release(auth.ca);
    scr_https_release_http_options(&http);
    scr_dyn_release(plain);
    scr_closure_release(handler);
    scr_tls_opt_fence("https.createServer", "maxVersion",
                      "a version range with neither TLSv1.2 nor TLSv1.3 has no lowering");
    return NULL;
  }
  ScrNetServer *s = scr_https_create_server_auth((const char *)cert->data, cert->len,
                                                  (const char *)key->data, key->len, handler, fn, &auth,
                                                  min_version, max_version);
  scr_bytes_release(auth.ca);
  if (has_http) scr_https_apply_http_options(s, &http);
  scr_https_release_http_options(&http);
  scr_dyn_release(plain);
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
  /* tlsSocket.setKeyCert(context): the pair the application installed on a
   * socket whose handshake it holds (a wrapped TLSSocket) replaces the
   * config's own for every handshake it serves */
  if (t->pending_cert_ctx != NULL)
    return mbedtls_ssl_set_hs_own_cert(ssl, &t->pending_cert_ctx->cert, &t->pending_cert_ctx->pk);
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
    t->vrfy_trust = pick->has_ca ? &pick->ca : scr_tls_system_ca();
    mbedtls_ssl_set_hs_ca_chain(ssl, pick->has_ca ? &pick->ca : scr_tls_system_ca(), NULL);
  }
  return mbedtls_ssl_set_hs_own_cert(ssl, own, &pick->pk);
}

/* The TLS config of a tls or https server, or NULL with the fence thrown. */
/* The TLS server behind a server handle, or NULL without throwing (a plain
 * server registration stays inert, as Node's EventEmitter keeps it). */
static ScrTlsSrv *scr_tls_srv_of_server_or_null(ScrNetServer *server) {
  ScrNetNativeConnFn fn = NULL;
  void *ctx = NULL;
  void (*ctx_free)(void *) = NULL;
  scr_net_server_get_native_conn(server, &fn, &ctx, &ctx_free);
  return fn == &scr_tls_srv_on_conn && ctx != NULL ? (ScrTlsSrv *)ctx : NULL;
}

static ScrTlsSrv *scr_tls_srv_of_server(ScrNetServer *server, const char *what) {
  ScrTlsSrv *found = scr_tls_srv_of_server_or_null(server);
  if (found != NULL) return found;
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
  /* New connections use the replacement context's version bounds. */
  (void)scr_tls_conf_versions(&s->conf, c->min_version, c->max_version);
  mbedtls_ssl_conf_cert_cb(&s->conf, &scr_tls_f_cert);
}

/* server.getTicketKeys(): the 48 bytes of key material this server mints
 * its tickets under, as a fresh Buffer (+1 dyn): Node's getter answers
 * independent copies, so mutating one never changes the next answer. */
ScrDyn *scr_tls_server_get_ticket_keys(ScrNetServer *server) {
  ScrTlsSrv *s = scr_tls_srv_of_server(server, "server.getTicketKeys");
  if (s == NULL) return NULL;
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)sizeof s->ticket_keys);
  b->is_buffer = true;
  memcpy(b->data, s->ticket_keys, sizeof s->ticket_keys);
  ScrDyn *d = scr_dyn_new_bytes(b);
  scr_bytes_release(b);
  return d;
}

/* server.setTicketKeys(keys): Node's validation ladder — a Buffer,
 * TypedArray or DataView whose BYTE length is 48 — then re-keys the
 * server, so tickets minted under the previous material no longer resume
 * and the next connection gets a full handshake. */
void scr_tls_server_set_ticket_keys(ScrNetServer *server, const ScrDyn *keys) {
  ScrTlsSrv *s = scr_tls_srv_of_server(server, "server.setTicketKeys");
  if (s == NULL) return;
  const ScrDyn *v = keys != NULL ? keys : scr_dyn_undefined();
  if (v->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", v);
    return;
  }
  const ScrBytes *b = v->v.bytes;
  if ((size_t)scr_bytes_byte_len(b) != sizeof s->ticket_keys) {
    static const char msg[] =
        "Session ticket keys must be a 48-byte buffer\n"
        "This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\n"
        "Please open an issue with this stack trace at https://github.com/nodejs/node/issues\n";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_INTERNAL_ASSERTION");
    return;
  }
  memcpy(s->ticket_keys, b->data, sizeof s->ticket_keys);
#if defined(MBEDTLS_SSL_TICKET_C)
  scr_tls_ticket_install(s);
#endif
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
  for (size_t i = 0; record != NULL && i < scr_dyn_obj_count(record); i++) {
    ScrDynProp e = scr_dyn_obj_prop_at(record, i);
    if (e.value->kind == SCR_DYN_UNDEF) continue;
    if (strcmp(e.key, "requestCert") == 0) {
      if (!scr_tls_dyn_truthy(e.value)) continue;
      scr_tls_opt_fence(api, "requestCert",
                        "requestCert lowers with cert and key options, not beside a secureContext");
      return false;
    }
    if (strcmp(e.key, "SNICallback") == 0 || strcmp(e.key, "ALPNCallback") == 0) {
      scr_tls_opt_fence(api, e.key,
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
  for (size_t i = 0; record != NULL && i < scr_dyn_obj_count(record); i++) {
    ScrDynProp e = scr_dyn_obj_prop_at(record, i);
    if (e.value->kind == SCR_DYN_UNDEF) continue;
    if (strcmp(e.key, "isServer") == 0) {
      is_server = scr_tls_dyn_truthy(e.value);
      continue;
    }
    if (strcmp(e.key, "secureContext") == 0) {
      /* A checked-dynamic record cannot carry a SecureContext handle;
       * Node rejects any other value with ERR_TLS_INVALID_CONTEXT (null
       * and undefined read as absent). */
      if (e.value->kind == SCR_DYN_NULL || e.value->kind == SCR_DYN_UNDEF) continue;
      static const char msg[] = "context must be a SecureContext";
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_TLS_INVALID_CONTEXT");
      return NULL;
    }
    for (size_t k = 0; SCR_TLS_WRAP_FENCED_OPTIONS[k] != NULL; k++) {
      if (strcmp(e.key, SCR_TLS_WRAP_FENCED_OPTIONS[k]) == 0) {
        scr_tls_opt_fence(api, e.key,
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
    if (!scr_tls_versions_dyn(record, &min_version, &max_version, api)) return NULL;
    if (!scr_tls_srv_opts_walk_ex(record, api, &cert, &key, true, &auth)) return NULL;
    /* a standalone socket requires a certificate only for a truthy
     * rejectUnauthorized (null, 0, '' and false all allow); tls.Server's
     * true default does not apply. The walk read the member through
     * ordinary property access, accessors included. */
    auth.reject = auth.reject_seen && auth.reject_truthy;
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
  /* a context carries its own version bounds */
  if (ctx != NULL) {
    min_version = ctx->min_version;
    max_version = ctx->max_version;
  }
  if (!scr_tls_conf_versions(&srv->conf, min_version, max_version)) {
    scr_tls_srv_release(srv);
    scr_tls_opt_fence(api, "maxVersion",
                      "a version range with neither TLSv1.2 nor TLSv1.3 has no lowering");
    return NULL;
  }
  srv->max_tls12 = max_version == 12;
  /* record the client's SNI name (tlsSocket.servername) */
  mbedtls_ssl_conf_sni(&srv->conf, &scr_tls_f_sni, NULL);
  ScrNetSocket *t = scr_net_sock_adopt(raw);
  if (t == NULL) {
    scr_tls_srv_release(srv);
    static const char msg[] =
        "new tls.TLSSocket over a socket that is not connected, or is already wrapped, is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
    return NULL;
  }
  ScrTlsSock *ts = calloc(1, sizeof *ts);
  if (!ts) scr_tls_oom();
  mbedtls_ssl_init(&ts->ssl);
  if (mbedtls_ssl_setup(&ts->ssl, &srv->conf) != 0) scr_tls_oom();
  mbedtls_ssl_set_export_keys_cb(&ts->ssl, &scr_tls_keylog_cb, ts);
  if (srv->request_cert) {
    mbedtls_ssl_set_verify(&ts->ssl, &scr_tls_vrfy_cb, ts);
    ts->vrfy_trust = srv->has_ca ? &srv->ca : scr_tls_system_ca();
  }
  ts->sock = t;
  ts->srv = srv; /* moves */
  ts->wrapped = true;
  /* a standalone socket's policy is its options', with no tls.Server
   * defaults behind it (Node's _init) */
  ts->req_cert = auth.request;
  ts->reject_unauth = auth.reject;
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
  "ciphers", "clientCertEngine", "dhparam", "ecdhCurve",
  "enableTrace", "family", "fd", "hints", "highWaterMark",
  "honorCipherOrder", "keepAlive", "keepAliveInitialDelay",
  "localAddress", "localPort", "lookup", "minDHSize", "noDelay", "onread", "passphrase", "pfx",
  "privateKeyEngine", "privateKeyIdentifier", "pskCallback", "readable",
  "secureContext", "secureOptions", "secureProtocol",
  "sessionIdContext", "sigalgs", "signal", "ticketKeys",
  "writable", NULL,
};

static ScrNetSocket *scr_tls_connect_plain(double port, ScrStr *host /*borrowed, nullable*/,
                                           const ScrDyn *opts /*borrowed, nullable*/,
                                           ScrClosure *cb /*moves, nullable*/,
                                           ScrStr *unix_path /*borrowed, nullable*/);

/* Every tls.connect form's options ride this: a typed record (an options
 * binding, SCR_DYN_TYPED_REF) materializes into the plain object the walk
 * reads; a dyn object passes as it is. */
static ScrNetSocket *scr_tls_connect_materialized(double port, ScrStr *host /*borrowed, nullable*/,
                                                  const ScrDyn *opts /*borrowed, nullable*/,
                                                  ScrClosure *cb /*moves, nullable*/,
                                                  ScrStr *unix_path /*borrowed, nullable*/) {
  if (opts == NULL || opts->kind != SCR_DYN_TYPED_REF)
    return scr_tls_connect_plain(port, host, opts, cb, unix_path);
  ScrDyn *plain = scr_dyn_typed_ref_materialize(opts);
  if (plain == NULL) {
    scr_closure_release(cb);
    return NULL;
  }
  ScrNetSocket *s = scr_tls_connect_plain(port, host, plain, cb, unix_path);
  scr_dyn_release(plain);
  return s;
}

ScrNetSocket *scr_tls_connect_dyn(double port, ScrStr *host /*borrowed, nullable*/,
                                   const ScrDyn *opts /*borrowed, nullable*/,
                                   ScrClosure *cb /*moves, nullable*/) {
  return scr_tls_connect_materialized(port, host, opts, cb, NULL);
}

/* tls.connect(path[, options][, callback]): the Unix-socket client. */
ScrNetSocket *scr_tls_connect_path(ScrStr *path /*borrowed*/, const ScrDyn *opts /*borrowed*/,
                                   ScrClosure *cb /*moves, nullable*/) {
  return scr_tls_connect_materialized(-1, NULL, opts, cb, path);
}

static ScrNetSocket *scr_tls_connect_plain(double port, ScrStr *host /*borrowed, nullable*/,
                                           const ScrDyn *opts /*borrowed, nullable*/,
                                           ScrClosure *cb /*moves, nullable*/,
                                           ScrStr *unix_path /*borrowed, nullable*/) {
  scr_tls_rng_init();
  bool reject = true;
  ScrBytes *ca = NULL;
  ScrBytes *crl = NULL;
  ScrBytes *own_cert = NULL, *own_key = NULL; /* the client certificate */
  ScrBytes *session_opt = NULL; /* options.session: the session to resume */
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
    if (ok && !scr_tls_versions_dyn(opts, &min_version, &max_version, "tls.connect")) ok = false;
    for (size_t i = 0; ok && i < scr_dyn_obj_count(opts); i++) {
      ScrDynProp e = scr_dyn_obj_prop_at(opts, i);
      const ScrDyn *v = e.value;
      if (strcmp(e.key, "checkServerIdentity") == 0) {
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
      if (strcmp(e.key, "path") == 0) {
        /* a Unix-socket client (tls.connect({ path })) */
        if (v->kind != SCR_DYN_STR) {
          scr_dyn_prop_type_fail("options.path", "of type string", v);
          ok = false;
        } else {
          unix_path = v->v.str;
        }
        continue;
      }
      if (strcmp(e.key, "port") == 0) {
        if (port >= 0) continue; /* the argument form wins, like Node */
        if (v->kind == SCR_DYN_NUM) port = v->v.num;
        else if (v->kind == SCR_DYN_STR) port = strtod(v->v.str->data, NULL); /* Node coerces numeric strings */
        else {
          scr_dyn_arg_type_fail("options.port", "of type number", v);
          ok = false;
        }
        continue;
      }
      if (strcmp(e.key, "host") == 0) {
        if (v->kind == SCR_DYN_STR) opt_host = v->v.str;
        else {
          scr_dyn_arg_type_fail("options.host", "of type string", v);
          ok = false;
        }
        continue;
      }
      if (strcmp(e.key, "rejectUnauthorized") == 0) {
        reject = scr_tls_dyn_not_false(v);
        continue;
      }
      if (strcmp(e.key, "ca") == 0) {
        scr_bytes_release(ca);
        if (!scr_tls_ca_dyn(v, "a tls.connect 'ca' option", &ca)) ok = false;
        continue;
      }
      if (strcmp(e.key, "crl") == 0) {
        /* Node parses the option whatever its shape: an empty string or
         * Buffer is a parse failure, not "no CRL". */
        scr_bytes_release(crl);
        crl = v->kind == SCR_DYN_STR && v->v.str->len == 0
                  ? NULL
                  : scr_tls_pem_dyn(v, "a tls.connect 'crl' option", true);
        if (crl == NULL || !scr_tls_crl_valid(crl)) {
          static const char msg[] = "Failed to parse CRL";
          scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1,
                                   "ERR_CRYPTO_OPERATION_FAILED");
          ok = false;
        }
        continue;
      }
      if (strcmp(e.key, "cert") == 0 || strcmp(e.key, "key") == 0) {
        ScrBytes **slot = e.key[0] == 'c' ? &own_cert : &own_key;
        scr_bytes_release(*slot);
        *slot = scr_tls_pem_dyn(v, e.key[0] == 'c' ? "a tls.connect 'cert' option" : "a tls.connect 'key' option",
                                false);
        if (*slot == NULL) ok = false;
        continue;
      }
      if (strcmp(e.key, "ALPNProtocols") == 0) {
        alpn_value = v; /* converted after the context options, as TLSSocket does */
        continue;
      }
      if (strcmp(e.key, "minVersion") == 0 || strcmp(e.key, "maxVersion") == 0) continue;
      if (strcmp(e.key, "timeout") == 0) {
        /* `if (options.timeout) tlssock.setTimeout(options.timeout)` */
        timeout_value = scr_tls_dyn_truthy(v) ? v : NULL;
        continue;
      }
      if (strcmp(e.key, "socket") == 0) {
        if (v->kind == SCR_DYN_HANDLE && v->v.handle.tag == SCR_DYNH_NET_SOCKET) {
          wrap = (ScrNetSocket *)v->v.handle.ptr;
        } else {
          scr_tls_opt_fence("tls.connect", "socket", "a net.Socket is the implemented socket value");
          ok = false;
        }
        continue;
      }
      if (strcmp(e.key, "session") == 0) {
        /* Node hands the option to the engine as-is: a Buffer that decodes
         * resumes the handshake, anything else is ignored */
        scr_bytes_release(session_opt);
        session_opt = scr_dyn_bytes_is(v, SCR_BYTES_U8)
                          ? (v->v.bytes->shared ? scr_bytes_copy(v->v.bytes) : scr_dyn_bytes_unbox(v))
                          : NULL;
        continue;
      }
      if (strcmp(e.key, "servername") == 0) {
        if (v->kind == SCR_DYN_STR) servername = v->v.str;
        else {
          scr_dyn_arg_type_fail("options.servername", "of type string", v);
          ok = false;
        }
        continue;
      }
      for (size_t k = 0; SCR_TLS_CONNECT_FENCED_OPTIONS[k] != NULL; k++) {
        if (strcmp(e.key, SCR_TLS_CONNECT_FENCED_OPTIONS[k]) == 0) {
          scr_tls_opt_fence("tls.connect", e.key,
                            "port/host/socket/rejectUnauthorized/ca/crl/cert/key/servername/ALPNProtocols/minVersion/maxVersion/timeout/session are the implemented members of a runtime options record");
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
  if (ok && port < 0 && wrap == NULL && unix_path == NULL) {
    scr_dyn_arg_type_fail("options.port", "of type number", scr_dyn_undefined());
    ok = false;
  }
  ScrStr *dial_host = (ScrStr *)(host != NULL && host->len > 0 ? host : opt_host);
  if (ok && !scr_net_host_chk(dial_host)) ok = false;
  if (!ok) {
    scr_tls_alpn_free(alpn);
    scr_bytes_release(ca);
    scr_bytes_release(crl);
    scr_bytes_release(own_cert);
    scr_bytes_release(own_key);
    scr_bytes_release(session_opt);
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
      scr_bytes_release(session_opt);
      scr_closure_release(cb);
      scr_str_release(localhost_fallback);
      scr_str_release(socket_host);
      static const char msg[] =
          "tls.connect over a socket that is not connected, or is already wrapped, is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
      return NULL;
    }
  } else if (unix_path != NULL) {
    /* the Unix-socket TLS client: the same wrap over a path dial */
    s = scr_net_connect_path(unix_path, false);
    if (cb) scr_net_sock_on_connect(s, cb, true); /* post-handshake */
  } else {
    ScrStr *dial_addr = dial_host != NULL ? scr_net_blocking_lookup(dial_host) : NULL;
    s = scr_net_connect(port, dial_addr, cb); /* cb fires post-handshake — secureConnect */
    if (dial_addr) scr_str_release(dial_addr);
  }
  ScrTlsCli *cli = scr_tls_cli_new2(verify_host, reject, scr_tls_ca_data(ca),
                                     ca != NULL ? ca->len : 0, scr_tls_crl_data(crl),
                                     crl != NULL ? crl->len : 0, !reject);
  if (servername != NULL) scr_tls_cli_set_servername(cli, servername);
  if (session_opt != NULL) scr_tls_cli_set_session(cli, session_opt);
  scr_bytes_release(session_opt);
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
  scr_bytes_release(crl);
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
  scr_net_server_set_native_settle(s, &scr_tls_srv_settle);
  scr_net_server_defer_connections(s); /* 'connection'/'secureConnection' wait for the handshake */
}

/* The h2-over-TLS CLIENT wrap (http2.connect with an https authority):
 * a client transport offering ALPN ["h2"] — SNI/verification against
 * the authority host; `ca` replaces the trust anchors (NULL = none) and
 * reject_unauthorized false records like tls.connect's. The session's
 * preface/SETTINGS ride the socket's write buffer until establishment. */
void scr_tls_h2_client_wrap(ScrNetSocket *sock, ScrStr *host /*borrowed*/,
                             bool reject_unauthorized, const char *ca, size_t ca_len) {
  ScrTlsCli *cli =
      scr_tls_cli_new2(host, reject_unauthorized, ca, ca_len, NULL, 0, !reject_unauthorized);
  mbedtls_ssl_conf_alpn_protocols(&cli->conf, SCR_TLS_ALPN_H2);
  scr_tls_cli_wrap(sock, cli);
}

/* ── tls.checkServerIdentity: Node's standalone hostname verification ──
 * lib/tls.js's checkServerIdentity over a legacy certificate object
 * (subjectaltname and subject.CN): SAN DNS names match with RFC 6125
 * wildcard rules, IP SANs compare canonicalized, and the CN is the
 * fallback only when the certificate carries no DNS SAN. A failure is
 * ERR_TLS_CERT_ALTNAME_INVALID carrying Node's reason text, `host` and
 * `cert`; a malformed quoted alt-name string throws
 * ERR_TLS_CERT_ALTNAME_FORMAT as Node's splitEscapedAltNames does. */

typedef struct {
  char **v;
  size_t n, cap;
} ScrTlsIdentList;

typedef struct {
  char *p;
  size_t n, cap;
} ScrTlsIdentBuf;

static void scr_tls_ident_buf_put(ScrTlsIdentBuf *b, const char *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    size_t cap = b->cap == 0 ? 64 : b->cap;
    while (b->n + n + 1 > cap) cap *= 2;
    char *p = realloc(b->p, cap);
    if (!p) scr_tls_oom();
    b->p = p;
    b->cap = cap;
  }
  if (n != 0) memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = 0;
}

static void scr_tls_ident_list_push(ScrTlsIdentList *l, const char *s, size_t n) {
  if (l->n == l->cap) {
    size_t cap = l->cap == 0 ? 8 : l->cap * 2;
    char **v = realloc(l->v, cap * sizeof *v);
    if (!v) scr_tls_oom();
    l->v = v;
    l->cap = cap;
  }
  char *copy = malloc(n + 1);
  if (!copy) scr_tls_oom();
  if (n != 0) memcpy(copy, s, n);
  copy[n] = 0;
  l->v[l->n++] = copy;
}

static void scr_tls_ident_list_free(ScrTlsIdentList *l) {
  for (size_t i = 0; i < l->n; i++) free(l->v[i]);
  free(l->v);
  l->v = NULL;
  l->n = l->cap = 0;
}

/* One JSON string literal at s[0] (a quote), decoded into `out` as a JS
 * JSON.parse would: the standard escapes, \uXXXX as UTF-8. Answers the
 * bytes consumed, or (size_t)-1 for a malformed literal. */
static size_t scr_tls_ident_json_string(const char *s, size_t n, ScrTlsIdentBuf *out) {
  if (n < 1 || s[0] != '"') return (size_t)-1;
  size_t i = 1;
  while (i < n) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"') return i + 1;
    if (c < 0x20) return (size_t)-1;
    if (c != '\\') {
      scr_tls_ident_buf_put(out, s + i, 1);
      i++;
      continue;
    }
    if (++i >= n) return (size_t)-1;
    switch (s[i]) {
      case '"': scr_tls_ident_buf_put(out, "\"", 1); break;
      case '\\': scr_tls_ident_buf_put(out, "\\", 1); break;
      case '/': scr_tls_ident_buf_put(out, "/", 1); break;
      case 'b': scr_tls_ident_buf_put(out, "\b", 1); break;
      case 'f': scr_tls_ident_buf_put(out, "\f", 1); break;
      case 'n': scr_tls_ident_buf_put(out, "\n", 1); break;
      case 'r': scr_tls_ident_buf_put(out, "\r", 1); break;
      case 't': scr_tls_ident_buf_put(out, "\t", 1); break;
      case 'u': {
        if (i + 4 >= n) return (size_t)-1;
        unsigned cp = 0;
        for (int k = 1; k <= 4; k++) {
          char h = s[i + (size_t)k];
          unsigned d;
          if (h >= '0' && h <= '9') d = (unsigned)(h - '0');
          else if (h >= 'a' && h <= 'f') d = (unsigned)(h - 'a' + 10);
          else if (h >= 'A' && h <= 'F') d = (unsigned)(h - 'A' + 10);
          else return (size_t)-1;
          cp = (cp << 4) | d;
        }
        i += 4;
        char utf8[3];
        size_t m;
        if (cp < 0x80) {
          utf8[0] = (char)cp;
          m = 1;
        } else if (cp < 0x800) {
          utf8[0] = (char)(0xC0u | (cp >> 6));
          utf8[1] = (char)(0x80u | (cp & 0x3Fu));
          m = 2;
        } else {
          utf8[0] = (char)(0xE0u | (cp >> 12));
          utf8[1] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
          utf8[2] = (char)(0x80u | (cp & 0x3Fu));
          m = 3;
        }
        scr_tls_ident_buf_put(out, utf8, m);
        break;
      }
      default: return (size_t)-1;
    }
    i++;
  }
  return (size_t)-1;
}

/* Node's split(", ") / splitEscapedAltNames splitter: the quoted form is
 * taken when the string holds a quote; malformed JSON answers false (the
 * caller throws ERR_TLS_CERT_ALTNAME_FORMAT). */
static bool scr_tls_ident_alt_split(const char *alt, size_t len,
                                    void (*emit)(const char *, size_t, void *), void *ctx) {
  if (memchr(alt, '"', len) == NULL) {
    size_t start = 0;
    for (size_t i = 0; i <= len; i++) {
      if (i == len || (alt[i] == ',' && i + 1 < len && alt[i + 1] == ' ')) {
        emit(alt + start, i - start, ctx);
        start = i + 2;
        i++;
      }
    }
    return true;
  }
  ScrTlsIdentBuf cur = {0};
  size_t offset = 0;
  while (offset != len) {
    const char *base = alt + offset;
    size_t remain = len - offset;
    const char *sep = memchr(base, ',', remain);
    const char *quote = memchr(base, '"', remain);
    if (quote != NULL && (sep == NULL || quote < sep)) {
      scr_tls_ident_buf_put(&cur, base, (size_t)(quote - base));
      size_t used = scr_tls_ident_json_string(quote, remain - (size_t)(quote - base), &cur);
      if (used == (size_t)-1) {
        free(cur.p);
        return false;
      }
      offset = (size_t)(quote - alt) + used;
    } else if (sep != NULL) {
      scr_tls_ident_buf_put(&cur, base, (size_t)(sep - base));
      emit(cur.p != NULL ? cur.p : "", cur.n, ctx);
      cur.n = 0;
      if (cur.p != NULL) cur.p[0] = 0;
      /* the separator skips the comma and the byte after it; a trailing
       * comma has no such byte, so the cursor stops at the end */
      size_t next = (size_t)(sep - alt) + 2;
      if (next > len) next = len;
      offset = next;
    } else {
      scr_tls_ident_buf_put(&cur, base, remain);
      offset = len;
    }
  }
  emit(cur.p != NULL ? cur.p : "", cur.n, ctx);
  free(cur.p);
  return true;
}

/* Node's canonicalizeIP: inet_ntop's canonical spelling for an IP literal
 * (anything else crosses as written). */
static void scr_tls_ident_canon_ip(const char *s, size_t n, char *out, size_t cap) {
  char tmp[128];
  if (n >= sizeof tmp) n = sizeof tmp - 1;
  if (n != 0) memcpy(tmp, s, n);
  tmp[n] = 0;
  unsigned char addr[16];
  if (inet_pton(AF_INET, tmp, addr) == 1) {
    inet_ntop(AF_INET, addr, out, (socklen_t)cap);
    return;
  }
  if (inet_pton(AF_INET6, tmp, addr) == 1) {
    inet_ntop(AF_INET6, addr, out, (socklen_t)cap);
    return;
  }
  snprintf(out, cap, "%s", tmp);
}

static bool scr_tls_ident_is_ip(const char *s) {
  unsigned char addr[16];
  return inet_pton(AF_INET, s, addr) == 1 || inet_pton(AF_INET6, s, addr) == 1;
}

/* Node's splitHost: A-Z lowercased, one trailing dot dropped. */
static void scr_tls_ident_normalize(const char *s, size_t n, char *out, size_t cap) {
  if (n > 0 && s[n - 1] == '.') n--;
  size_t k = 0;
  for (size_t i = 0; i < n && k + 1 < cap; i++) {
    char c = s[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
    out[k++] = c;
  }
  out[k] = 0;
}

/* lib/tls.js's check(hostParts, pattern, wildcards). */
static bool scr_tls_ident_check(const char *host_lc, const char *pattern, bool wildcards) {
  if (pattern == NULL || pattern[0] == 0) return false;
  char hbuf[512], pbuf[512];
  scr_tls_ident_normalize(host_lc, strlen(host_lc), hbuf, sizeof hbuf);
  scr_tls_ident_normalize(pattern, strlen(pattern), pbuf, sizeof pbuf);
  char *hp[64], *pp[64];
  size_t hn = 0, pn = 0;
  hp[hn++] = hbuf;
  for (char *c = hbuf; *c != 0; c++) {
    if (*c != '.') continue;
    *c = 0;
    if (hn == 64) return false;
    hp[hn++] = c + 1;
  }
  pp[pn++] = pbuf;
  for (char *c = pbuf; *c != 0; c++) {
    if (*c != '.') continue;
    *c = 0;
    if (pn == 64) return false;
    pp[pn++] = c + 1;
  }
  if (hn != pn) return false;
  for (size_t i = 0; i < pn; i++) {
    if (pp[i][0] == 0) return false; /* "bad..example.com" */
    for (const unsigned char *c = (const unsigned char *)pp[i]; *c != 0; c++)
      if (*c < 0x21 || *c > 0x7f) return false; /* IDNA U-labels, blanks, controls */
  }
  for (size_t i = hn - 1; i > 0; i--)
    if (strcmp(hp[i], pp[i]) != 0) return false;
  const char *hsub = hp[0];
  const char *psub = pp[0];
  const char *star = strchr(psub, '*');
  if (star == NULL || strstr(psub, "xn--") != NULL) return strcmp(hsub, psub) == 0;
  if (!wildcards) return false;
  if (strchr(star + 1, '*') != NULL) return false; /* more than one wildcard */
  if (pn <= 2) return false;                       /* "*.tld" is not allowed */
  size_t plen = strlen(psub), hlen = strlen(hsub);
  size_t pre = (size_t)(star - psub), suf = plen - pre - 1;
  if (pre + suf > hlen) return false;
  if (pre != 0 && strncmp(hsub, psub, pre) != 0) return false;
  if (suf != 0 && strcmp(hsub + hlen - suf, star + 1) != 0) return false;
  return true;
}

/* A field that crossed as a typed record keeps its checked-dynamic ref
 * until something reads it: materialize it into the plain object shape. */
static const ScrDyn *scr_tls_ident_plain(const ScrDyn *v, ScrDyn **owned) {
  if (v != NULL && v->kind == SCR_DYN_TYPED_REF) {
    *owned = scr_dyn_typed_ref_materialize(v);
    if (scr_exc_pending()) {
      scr_dyn_release(*owned);
      *owned = NULL;
      return NULL;
    }
    return *owned;
  }
  return v;
}

struct ScrTlsIdentCtx {
  ScrTlsIdentList dns, ips;
};

static void scr_tls_ident_token(const char *tok, size_t n, void *ctx) {
  struct ScrTlsIdentCtx *c = ctx;
  /* an embedded NUL cannot appear in a name Node's matching accepts (its
   * label check rejects bytes below 0x21) and would truncate a C-string
   * comparison: the entry is kept — Node still counts it — with every NUL
   * turned into a byte no label check accepts */
  char stack[256];
  char *copy = NULL;
  if (memchr(tok, '\0', n) != NULL) {
    copy = n <= sizeof stack ? stack : malloc(n);
    if (copy == NULL) return;
    memcpy(copy, tok, n);
    for (size_t i = 0; i < n; i++)
      if (copy[i] == '\0') copy[i] = 0x01;
    tok = copy;
  }
  if (n >= 4 && memcmp(tok, "DNS:", 4) == 0) {
    scr_tls_ident_list_push(&c->dns, tok + 4, n - 4);
  } else if (n >= 11 && memcmp(tok, "IP Address:", 11) == 0) {
    char canon[INET6_ADDRSTRLEN + 8];
    scr_tls_ident_canon_ip(tok + 11, n - 11, canon, sizeof canon);
    scr_tls_ident_list_push(&c->ips, canon, strlen(canon));
  }
  if (copy != NULL && copy != stack) free(copy);
}

/* The failure object: Node's ERR_TLS_CERT_ALTNAME_INVALID with `host` and
 * `cert` own properties and the "Hostname/IP does not match certificate's
 * altnames: <reason>" message. */
static ScrDyn *scr_tls_ident_fail(const char *reason, size_t reason_n, const ScrStr *host,
                                  const ScrDyn *cert) {
  static const char prefix[] = "Hostname/IP does not match certificate's altnames: ";
  size_t plen = sizeof prefix - 1;
  char *text = malloc(plen + reason_n + 1);
  if (!text) scr_tls_oom();
  memcpy(text, prefix, plen);
  memcpy(text + plen, reason, reason_n);
  text[plen + reason_n] = 0;
  ScrStr *msg = scr_str_new(text, plen + reason_n);
  free(text);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, "ERR_TLS_CERT_ALTNAME_INVALID");
  ScrDyn *view = scr_dyn_from_error(e);
  scr_dyn_obj_set(view, "host", 4, scr_dyn_new_str((ScrStr *)host));
  scr_dyn_obj_set(view, "cert", 4, scr_dyn_retain((ScrDyn *)cert));
  scr_error_release(e);
  return view;
}

ScrDyn *scr_tls_check_server_identity(ScrStr *hostname /*borrowed*/, const ScrDyn *cert /*borrowed*/) {
  ScrDyn *owned = NULL;
  if (cert != NULL && cert->kind == SCR_DYN_TYPED_REF) {
    owned = scr_dyn_typed_ref_materialize(cert);
    if (scr_exc_pending()) {
      scr_dyn_release(owned);
      /* the caller boxes the answer before its pending check: answer a
       * valid value, not NULL */
      return scr_dyn_retain(scr_dyn_undefined());
    }
    cert = owned;
  }
  const ScrDyn *alt = NULL;
  const ScrDyn *subject = NULL;
  const ScrDyn *cn = NULL;
  ScrDyn *owned_alt = NULL, *owned_subject = NULL, *owned_cn = NULL;
  if (cert != NULL && cert->kind == SCR_DYN_OBJ) {
    alt = scr_tls_ident_plain(scr_dyn_obj_get(cert, "subjectaltname", 14), &owned_alt);
    subject = scr_tls_ident_plain(scr_dyn_obj_get(cert, "subject", 7), &owned_subject);
    if (subject != NULL && subject->kind == SCR_DYN_OBJ)
      cn = scr_tls_ident_plain(scr_dyn_obj_get(subject, "CN", 2), &owned_cn);
  }
  if (scr_exc_pending()) {
    scr_dyn_release(owned_alt);
    scr_dyn_release(owned_subject);
    scr_dyn_release(owned_cn);
    scr_dyn_release(owned);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  struct ScrTlsIdentCtx ctx = {{0}, {0}};
  char *alt_owned = NULL;
  const char *alt_text = NULL;
  size_t alt_len = 0;
  if (alt != NULL && alt->kind == SCR_DYN_STR) {
    alt_text = scr_str_utf8(alt->v.str, &alt_owned);
    alt_len = alt->v.str->len;
    if (!scr_tls_ident_alt_split(alt_text, alt_len, scr_tls_ident_token, &ctx)) {
      static const char msg[] = "Invalid subject alternative name string";
      scr_str_utf8_end(alt_owned);
      scr_tls_ident_list_free(&ctx.dns);
      scr_tls_ident_list_free(&ctx.ips);
      /* The certificate's altnames, subject and CN may have been
       * materialized from typed references at the top of this function;
       * the malformed-SAN answer must let them go like every other path. */
      scr_dyn_release(owned_alt);
      scr_dyn_release(owned_subject);
      scr_dyn_release(owned_cn);
      scr_dyn_release(owned);
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_TLS_CERT_ALTNAME_FORMAT");
      /* the caller boxes the answer before its pending check: a valid
       * value keeps that boxing from dereferencing NULL */
      return scr_dyn_retain(scr_dyn_undefined());
    }
  }
  char *host_owned = NULL;
  const char *host = scr_str_utf8(hostname, &host_owned);
  /* Node's unfqdn for matching and for the reason text. */
  char hostbuf[512];
  size_t hlen = hostname->len;
  if (hlen >= sizeof hostbuf) hlen = sizeof hostbuf - 1;
  if (hlen != 0) memcpy(hostbuf, host, hlen);
  hostbuf[hlen] = 0;
  if (hlen > 0 && hostbuf[hlen - 1] == '.') hostbuf[--hlen] = 0;
  /* an embedded NUL makes the host un-matchable (Node's checks reject such
   * bytes) and would truncate every C-string comparison below */
  bool host_has_nul = memchr(hostbuf, '\0', hlen) != NULL;

  ScrDyn *result = NULL;
  if (!host_has_nul && scr_tls_ident_is_ip(hostbuf)) {
    char canon[INET6_ADDRSTRLEN + 8];
    scr_tls_ident_canon_ip(hostbuf, strlen(hostbuf), canon, sizeof canon);
    bool valid = false;
    for (size_t i = 0; i < ctx.ips.n; i++) {
      if (strcmp(ctx.ips.v[i], canon) == 0) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      ScrTlsIdentBuf reason = {0};
      scr_tls_ident_buf_put(&reason, "IP: ", 4);
      scr_tls_ident_buf_put(&reason, hostbuf, hlen);
      scr_tls_ident_buf_put(&reason, " is not in the cert's list: ", 28);
      for (size_t i = 0; i < ctx.ips.n; i++) {
        if (i != 0) scr_tls_ident_buf_put(&reason, ", ", 2);
        scr_tls_ident_buf_put(&reason, ctx.ips.v[i], strlen(ctx.ips.v[i]));
      }
      result = scr_tls_ident_fail(reason.p != NULL ? reason.p : "", reason.n, hostname, cert);
      free(reason.p);
    }
  } else if (ctx.dns.n > 0 || cn != NULL) {
    char host_lc[512];
    scr_tls_ident_normalize(hostbuf, hlen, host_lc, sizeof host_lc);
    bool valid = false;
    if (!host_has_nul) {
      if (ctx.dns.n > 0) {
        for (size_t i = 0; i < ctx.dns.n && !valid; i++)
          valid = scr_tls_ident_check(host_lc, ctx.dns.v[i], true);
      } else if (cn->kind == SCR_DYN_ARR) {
        for (size_t i = 0; i < scr_dyn_arr_len(cn) && !valid; i++) {
          const ScrDyn *item = cn->v.arr.items[i];
          if (item != NULL && item->kind == SCR_DYN_STR &&
              memchr(item->v.str->data, '\0', item->v.str->len) == NULL) {
            char *item_owned = NULL;
            const char *text = scr_str_utf8(item->v.str, &item_owned);
            valid = scr_tls_ident_check(host_lc, text, true);
            scr_str_utf8_end(item_owned);
          }
        }
      } else if (cn->kind == SCR_DYN_STR &&
                 memchr(cn->v.str->data, '\0', cn->v.str->len) == NULL) {
        char *cn_owned = NULL;
        const char *text = scr_str_utf8(cn->v.str, &cn_owned);
        valid = scr_tls_ident_check(host_lc, text, true);
        scr_str_utf8_end(cn_owned);
      }
    }
    if (!valid) {
      ScrTlsIdentBuf reason = {0};
      scr_tls_ident_buf_put(&reason, "Host: ", 6);
      scr_tls_ident_buf_put(&reason, hostbuf, hlen);
      if (ctx.dns.n > 0) {
        scr_tls_ident_buf_put(&reason, ". is not in the cert's altnames: ", 33);
        scr_tls_ident_buf_put(&reason, alt_text != NULL ? alt_text : "", alt_len);
      } else {
        scr_tls_ident_buf_put(&reason, ". is not cert's CN: ", 20);
        if (cn->kind == SCR_DYN_ARR) {
          for (size_t i = 0; i < scr_dyn_arr_len(cn); i++) {
            const ScrDyn *item = cn->v.arr.items[i];
            if (i != 0) scr_tls_ident_buf_put(&reason, ",", 1);
            if (item != NULL && item->kind == SCR_DYN_STR) {
              char *item_owned = NULL;
              const char *text = scr_str_utf8(item->v.str, &item_owned);
              scr_tls_ident_buf_put(&reason, text, item->v.str->len);
              scr_str_utf8_end(item_owned);
            }
          }
        } else if (cn->kind == SCR_DYN_STR) {
          char *cn_owned = NULL;
          const char *text = scr_str_utf8(cn->v.str, &cn_owned);
          scr_tls_ident_buf_put(&reason, text, cn->v.str->len);
          scr_str_utf8_end(cn_owned);
        }
      }
      result = scr_tls_ident_fail(reason.p != NULL ? reason.p : "", reason.n, hostname, cert);
      free(reason.p);
    }
  } else {
    static const char none[] = "Cert does not contain a DNS name";
    result = scr_tls_ident_fail(none, sizeof none - 1, hostname, cert);
  }
  scr_str_utf8_end(host_owned);
  scr_str_utf8_end(alt_owned);
  scr_tls_ident_list_free(&ctx.dns);
  scr_tls_ident_list_free(&ctx.ips);
  scr_dyn_release(owned_alt);
  scr_dyn_release(owned_subject);
  scr_dyn_release(owned_cn);
  if (result == NULL) result = scr_dyn_retain(scr_dyn_undefined());
  scr_dyn_release(owned);
  return result;
}

/* ── the checked-dynamic TLSSocket members (scr_net.c's hook table) ──── */

/* The verdict the socket's authorization answers read: the standing
 * handshake's own result, or, for a resumed handshake (which verifies no
 * certificate and reads as success from the engine), the verdict the offered
 * session was captured with. */
static uint32_t scr_tls_read_verdict(const ScrTlsSock *t) {
  if (t->established && t->cli != NULL && t->cli->has_resume && !t->peer_cert_parsed)
    return t->cli->resume_verify;
  return mbedtls_ssl_get_verify_result(&t->ssl);
}

/* The verdict a saved session carries. A TLS 1.3 ticket exchange swaps the
 * engine's session object after the handshake, so the engine's live result
 * no longer describes it: the value recorded when the handshake completed
 * stands instead. */
static uint32_t scr_tls_saved_verdict(const ScrTlsSock *t) {
  if (t->cli != NULL && t->cli->has_resume && !t->peer_cert_parsed)
    return t->cli->resume_verify;
  /* the connection's ACTUAL result: the snapshot once the handshake has
   * completed, the engine's live result before that (getSession() inside
   * secureConnect runs before the snapshot exists), and "not available"
   * when neither has one — which the resumption filter counts as unverified */
  if (t->standing_verify_set) return t->standing_verify;
  return mbedtls_ssl_get_verify_result(&t->ssl);
}

/* Node's authorizationError: the verify-failure CODE string (null when
 * authorized). Chain errors dominate the identity check — Node records
 * ssl.verifyError() first and only reaches checkServerIdentity's
 * ERR_TLS_CERT_ALTNAME_INVALID on a VERIFIED chain. */
static const char *scr_tls_auth_code(ScrTlsSock *t) {
  uint32_t vr = scr_tls_read_verdict(t);
  if (t->vrfy_blocked) return "CERT_REVOKED";
  if (t->vrfy_crl_revoked) return "CERT_REVOKED";
  if (t->vrfy_crl_missing) return "UNABLE_TO_GET_CRL";
  if (t->vrfy_crl_key_usage) return "UNSPECIFIED";
  if (t->vrfy_crl_sig_fail) return "CRL_SIGNATURE_FAILURE";
  if (t->vrfy_crl_expired) return "CRL_HAS_EXPIRED";
  if (t->vrfy_crl_future) return "CRL_NOT_YET_VALID";
  if (t->vrfy_crl_revoked) return "CERT_REVOKED";
  if (t->vrfy_expired) return "CERT_HAS_EXPIRED";
  if (t->vrfy_future) return "CERT_NOT_YET_VALID";
  if (t->vrfy_bad_sig) return "CERT_SIGNATURE_FAILURE";
  if (t->vrfy_pathlen) return "PATH_LENGTH_EXCEEDED";
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
  if (t->vrfy_blocked) return "CERT_REVOKED";
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


/* An independent Buffer holding `b`'s bytes (+1): every getter answers a
 * copy, so mutating a returned Buffer never changes the next answer (Node's
 * session and ticket Buffers are independent too). */
static ScrBytes *scr_tls_bytes_copy(const ScrBytes *b) {
  ScrBytes *copy = scr_bytes_new(SCR_BYTES_U8, (double)b->len);
  copy->is_buffer = true;
  if (b->len > 0) memcpy(copy->data, b->data, b->len);
  return copy;
}

/* The client 'session' event with the serialized session: TLS 1.2 fires
 * it once (its ticket rides the handshake), TLS 1.3 once per received
 * ticket (Node's server sends two after a full handshake and none after a
 * resumed one), and a resumed handshake fires none. Later listeners see no
 * replay, as in Node. */
/* The current session as a Buffer (+1), NULL when the handshake has no
 * resumable session yet (a TLS 1.3 client before its ticket). */
static ScrBytes *scr_tls_session_bytes(ScrTlsSock *t) {
  if (t->session_cached != NULL) return scr_tls_bytes_copy(t->session_cached);
  mbedtls_ssl_session sess;
  mbedtls_ssl_session_init(&sess);
  if (mbedtls_ssl_get_session(&t->ssl, &sess) != 0) {
    mbedtls_ssl_session_free(&sess);
    return NULL;
  }
  if (sess.MBEDTLS_PRIVATE(ticket_len) > 0 && sess.MBEDTLS_PRIVATE(ticket) != NULL &&
      t->ticket_cached == NULL) {
    ScrBytes *tk = scr_bytes_new(SCR_BYTES_U8, (double)sess.MBEDTLS_PRIVATE(ticket_len));
    tk->is_buffer = true;
    memcpy(tk->data, sess.MBEDTLS_PRIVATE(ticket), sess.MBEDTLS_PRIVATE(ticket_len));
    t->ticket_cached = tk;
  }
  /* the session carries the connection's verdict, so a later connection can
   * tell whether resuming it is safe under its own settings. mbedTLS's TLS
   * 1.3 session format has no verification field: an unverified origin rides
   * a ticket flag bit the engine's own mask ignores. */
  sess.MBEDTLS_PRIVATE(verify_result) = scr_tls_saved_verdict(t);
  if (sess.MBEDTLS_PRIVATE(tls_version) == MBEDTLS_SSL_VERSION_TLS1_3 &&
      scr_tls_saved_verdict(t) != 0)
    sess.MBEDTLS_PRIVATE(ticket_flags) |= 0x80u;
  size_t need = 0;
  (void)mbedtls_ssl_session_save(&sess, NULL, 0, &need);
  ScrBytes *buf = scr_bytes_new(SCR_BYTES_U8, (double)need);
  buf->is_buffer = true; /* the session is a Buffer */
  size_t used = 0;
  int ok = mbedtls_ssl_session_save(&sess, buf->data, need, &used) == 0;
  mbedtls_ssl_session_free(&sess);
  if (!ok) {
    scr_bytes_release(buf);
    return NULL;
  }
  t->session_cached = scr_tls_bytes_copy(buf);
  return buf;
}

/* ── the 'keylog' event: Node's NSS key-log lines ──────────────────────
 * mbedTLS hands the exported secrets to scr_tls_keylog_cb — the master
 * secret for TLS 1.2 and the TLS 1.3 handshake/application traffic secrets
 * — and each line is emitted as Node's is: a Buffer holding
 * "<LABEL> <client_random hex> <secret hex>\n", to the socket's listeners
 * and to the server's. mbedTLS exports no TLS 1.3 exporter secret, so a
 * TLS 1.3 handshake emits no EXPORTER_SECRET line (see the ledger row). */

static void scr_tls_keylog_fire(ScrTlsSock *t, ScrBytes *line) {
  if (t->keylog_ls.n > 0) {
    ScrNetL *snap;
    size_t n = scr_net_ls_snapshot(&t->keylog_ls, &snap);
    scr_dyn_this_push(t->sock, SCR_DYNH_NET_SOCKET);
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) ((ScrNetDataFn)snap[i].fn)(snap[i].cb, line);
      scr_closure_release(snap[i].cb);
    }
    scr_dyn_this_pop();
    free(snap);
  }
  if (t->srv != NULL && t->srv->keylog_ls.n > 0 && !scr_exc_pending()) {
    ScrNetL *snap;
    size_t n = scr_net_ls_snapshot(&t->srv->keylog_ls, &snap);
    /* the server-level listener runs with `this` = the server, as Node's
     * EventEmitter calls it */
    if (t->server != NULL) scr_dyn_this_push(t->server, SCR_DYNH_NET_SERVER);
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) ((ScrNetDataFn)snap[i].fn)(snap[i].cb, line);
      scr_closure_release(snap[i].cb);
    }
    if (t->server != NULL) scr_dyn_this_pop();
    free(snap);
  }
}

static void scr_tls_keylog_line(ScrTlsSock *t, const char *label, const unsigned char *secret,
                                size_t secret_len, const unsigned char client_random[32]) {
  static const char hex[] = "0123456789abcdef";
  size_t label_len = strlen(label);
  size_t len = label_len + 1 + 64 + 1 + secret_len * 2 + 1;
  ScrBytes *line = scr_bytes_new(SCR_BYTES_U8, (double)len);
  line->is_buffer = true; /* the event carries a Buffer */
  char *p = (char *)line->data;
  memcpy(p, label, label_len);
  p += label_len;
  *p++ = ' ';
  for (size_t i = 0; i < 32; i++) {
    *p++ = hex[client_random[i] >> 4];
    *p++ = hex[client_random[i] & 0x0f];
  }
  *p++ = ' ';
  for (size_t i = 0; i < secret_len; i++) {
    *p++ = hex[secret[i] >> 4];
    *p++ = hex[secret[i] & 0x0f];
  }
  *p = '\n';
  scr_tls_keylog_fire(t, line);
  scr_bytes_release(line);
}

static void scr_tls_keylog_cb(void *ctx, mbedtls_ssl_key_export_type type,
                              const unsigned char *secret, size_t secret_len,
                              const unsigned char client_random[32],
                              const unsigned char server_random[32],
                              mbedtls_tls_prf_types tls_prf_type) {
  (void)server_random;
  (void)tls_prf_type;
  ScrTlsSock *t = ctx;
  const char *label = NULL;
  switch (type) {
    case MBEDTLS_SSL_KEY_EXPORT_TLS12_MASTER_SECRET:
      label = "CLIENT_RANDOM";
      break;
#if defined(MBEDTLS_SSL_PROTO_TLS1_3)
    case MBEDTLS_SSL_KEY_EXPORT_TLS1_3_CLIENT_EARLY_SECRET:
      label = "CLIENT_EARLY_TRAFFIC_SECRET";
      break;
    case MBEDTLS_SSL_KEY_EXPORT_TLS1_3_EARLY_EXPORTER_SECRET:
      label = "EARLY_EXPORTER_SECRET";
      break;
    case MBEDTLS_SSL_KEY_EXPORT_TLS1_3_CLIENT_HANDSHAKE_TRAFFIC_SECRET:
      label = "CLIENT_HANDSHAKE_TRAFFIC_SECRET";
      break;
    case MBEDTLS_SSL_KEY_EXPORT_TLS1_3_SERVER_HANDSHAKE_TRAFFIC_SECRET:
      label = "SERVER_HANDSHAKE_TRAFFIC_SECRET";
      break;
    case MBEDTLS_SSL_KEY_EXPORT_TLS1_3_CLIENT_APPLICATION_TRAFFIC_SECRET:
      label = "CLIENT_TRAFFIC_SECRET_0";
      break;
    case MBEDTLS_SSL_KEY_EXPORT_TLS1_3_SERVER_APPLICATION_TRAFFIC_SECRET:
      label = "SERVER_TRAFFIC_SECRET_0";
      break;
#endif
    default:
      return;
  }
  scr_tls_keylog_line(t, label, secret, secret_len, client_random);
}

/* Emits the 'session' event with the socket's current session. */
static void scr_tls_session_emit(ScrTlsSock *t) {
  ScrBytes *buf = scr_tls_session_bytes(t);
  if (buf == NULL) return; /* no resumable session yet (1.3 pre-ticket) */
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

/* TLS 1.2's session rides the handshake: one 'session' event per socket. */
static void scr_tls_fire_session(ScrTlsSock *t) {
  if (t->session_fired || t->session_ls.n == 0 || t->cli == NULL) return;
  t->session_fired = true;
  scr_tls_session_emit(t);
}

/* TLS 1.3 tickets arrive one by one: Node fires 'session' for each and
 * getSession() then answers the latest. A handshake that resumed fires
 * none (Node's engine issues no ticket a program sees there), though the
 * ticket it carries is kept for the next connection. */
static void scr_tls_fire_ticket_session(ScrTlsSock *t) {
  if (t->cli == NULL) return;
  bool resumed = t->cli->has_resume && !t->peer_cert_parsed;
  /* the newest ticket replaces both caches whether or not a listener is
   * there: getSession()/getTLSTicket() answer it on the next call (Node's
   * getters read the connection's current session) */
  scr_bytes_release(t->session_cached);
  t->session_cached = NULL;
  scr_bytes_release(t->ticket_cached);
  t->ticket_cached = NULL;
  if (resumed || t->session_ls.n == 0) return;
  scr_tls_session_emit(t);
}

/* The STATIC-lane TLSSocket members (the lowered socket surface). */

/* Whether the socket verified its peer: a client against its trust
 * anchors, a server that requested a client certificate against its. */
static bool scr_tls_sock_verifies(const ScrTlsSock *t) {
  return t->established && ((t->cli != NULL && t->cli->verify_recorded) ||
                            (t->srv != NULL && t->verdict_req_cert && !t->srv->standalone));
}

/* Whether a verification verdict exists at all. Node reads
 * authorizationError from the socket's handle, so a server that ended
 * the handshake on a failed client certificate still answers there —
 * 'tlsClientError' carries that socket (the 'secureConnection' gate
 * above keeps 'authorized' at false). A server whose client left before
 * its certificate arrived has no verdict: mbedTLS still records a
 * missing-certificate failure for it, which Node does not report. */
static bool scr_tls_sock_verdict(const ScrTlsSock *t) {
  if (t->cli != NULL) return t->established && t->cli->verify_recorded;
  return t->srv != NULL && t->verdict_req_cert && !t->srv->standalone &&
         (t->established || t->vrfy_seen);
}

/* tlsSocket.servername: the client's SNI name on a server socket, the
 * name this client offered otherwise; false when there is none. +1. */
ScrDyn *scr_tls_sock_servername(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  ScrStr *name = NULL;
  if (t != NULL) {
    if (t->cli != NULL) {
      if (t->cli->hostname != NULL)
        name = scr_str_new(t->cli->hostname, strlen(t->cli->hostname));
    } else if (t->sni_name != NULL) {
      name = scr_str_retain(t->sni_name);
    }
  }
  if (name == NULL) return scr_dyn_new_bool(false);
  /* the dyn owns its own reference; the one taken here is released now */
  ScrDyn *answer = scr_dyn_new_str(name);
  scr_str_release(name);
  return answer;
}

/* Whether `label` begins with one of the PRF labels RFC 5705 reserves for
 * the handshake ("client finished", "server finished", "master secret",
 * "extended master secret", "key expansion"): the provider compares the
 * PRF argument's leading bytes, so the label's own prefix decides. */
static bool scr_tls_reserved_exporter_label(const ScrStr *label) {
  static const char *const reserved[] = {
    "client finished",
    "server finished",
    "master secret",
    "extended master secret",
    "key expansion",
  };
  for (size_t i = 0; i < sizeof reserved / sizeof reserved[0]; i++) {
    size_t n = strlen(reserved[i]);
    if (label->len >= n && memcmp(label->data, reserved[i], n) == 0) return true;
  }
  return false;
}

/* The error OpenSSL raises for an exporter label it refuses (a TLS 1.2
 * connection's reserved PRF names, a TLS 1.3 connection's over-long label),
 * as Node reports it: "error:0A00016F:SSL routines::tls illegal exporter
 * label" with own library, reason and code properties in Node's key order. */
static void scr_tls_throw_illegal_exporter_label(void) {
  static const char text[] = "error:0A00016F:SSL routines::tls illegal exporter label";
  static const char library[] = "SSL routines";
  static const char reason[] = "tls illegal exporter label";
  static const char code[] = "ERR_SSL_TLS_ILLEGAL_EXPORTER_LABEL";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  const char *keys[] = { "library", "reason", "code" };
  const char *values[] = { library, reason, code };
  for (size_t i = 0; i < 3; i++) {
    if (i == 2) scr_error_set_code(e, code);
    ScrStr *value = scr_str_new(values[i], strlen(values[i]));
    scr_error_set_prop(e, keys[i], strlen(keys[i]), scr_dyn_new_str(value));
    scr_str_release(value);
  }
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* tlsSocket.exportKeyingMaterial(length, label[, context]): Node's
 * validation ladder (validateInteger length 1..4294967295, a string label,
 * a Buffer/TypedArray context) then the provider's TLS exporter. +1
 * Buffer, NULL with an exception pending. */
ScrBytes *scr_tls_sock_export_keying_material(ScrNetSocket *s, const ScrDyn *length,
                                              const ScrDyn *label, const ScrDyn *context,
                                              bool has_context) {
  if (length->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("length", "of type number", length);
    return NULL;
  }
  double len = length->v.num;
  if (floor(len) != len || len < 1 || len > 4294967295.0) {
    char recv[48];
    char msg[192];
    int n;
    scr_num_received(len, recv);
    if (floor(len) != len) {
      n = snprintf(msg, sizeof msg,
                   "The value of \"length\" is out of range. It must be an integer. Received %s", recv);
    } else {
      n = snprintf(msg, sizeof msg,
                   "The value of \"length\" is out of range. It must be >= 1 && <= 4294967295. Received %s",
                   recv);
    }
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  if (label->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("label", "of type string", label);
    return NULL;
  }
  const ScrBytes *ctx = NULL;
  if (has_context && context->kind != SCR_DYN_UNDEF && context->kind != SCR_DYN_NULL) {
    if (context->kind != SCR_DYN_BYTES) {
      scr_dyn_arg_type_fail("context", "an instance of Buffer, TypedArray, or DataView", context);
      return NULL;
    }
    ctx = context->v.bytes;
  }
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !scr_net_sock_established(s)) {
    static const char msg[] = "TLS socket connection must be securely established";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_TLS_INVALID_STATE");
    return NULL;
  }
  /* RFC 5705's reserved names: a TLS 1.2 exporter builds its PRF argument
   * from the label, so a label that begins with one of the handshake's own
   * PRF labels is refused; TLS 1.3 exporters have no such names. */
  bool tls13 = strcmp(mbedtls_ssl_get_version(&t->ssl), "TLSv1.3") == 0;
  if (!tls13 && scr_tls_reserved_exporter_label(label->v.str)) {
    scr_tls_throw_illegal_exporter_label();
    return NULL;
  }
  /* RFC 8446's 255-byte label ceiling less the provider's "tls13 " prefix:
   * a TLS 1.3 connection refuses a longer label where a TLS 1.2 connection
   * exports any label. */
  if (tls13 && label->v.str->len > 249) {
    scr_tls_throw_illegal_exporter_label();
    return NULL;
  }
  size_t key_len = (size_t)len;
  /* A typed-array context counts bytes, not elements: a Uint16Array view's
   * suffix reaches the provider, so distinct contexts stay distinct. */
  size_t context_len = ctx != NULL ? (size_t)scr_bytes_byte_len(ctx) : 0;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)key_len);
  out->is_buffer = true;
  int rc = mbedtls_ssl_export_keying_material(
    &t->ssl, out->data, key_len, (const char *)label->v.str->data, label->v.str->len,
    ctx != NULL ? ctx->data : NULL, context_len, ctx != NULL ? 1 : 0);
  if (rc != 0) {
    scr_bytes_release(out);
    static const char msg[] =
      "the TLS provider cannot export keying material for these parameters";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_SSL_TLS_ILLEGAL_EXPORTER_LABEL");
    return NULL;
  }
  return out;
}

/* tlsSocket.getSession(): the session a resumption would use. +1 dyn
 * (a Buffer, or null when the handshake has no resumable session yet). */
ScrDyn *scr_tls_sock_get_session(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  ScrBytes *b = t != NULL ? scr_tls_session_bytes(t) : NULL;
  if (b == NULL) return scr_dyn_new_null();
  ScrDyn *d = scr_dyn_new_bytes(b);
  scr_bytes_release(b);
  return d;
}

/* tlsSocket.getTLSTicket(): the session ticket the client received, as a
 * Buffer, or undefined. TLS 1.2 carries the ticket in its handshake
 * session; a TLS 1.3 ticket arrives later (the 'session' event), so the
 * answer is undefined until one is in hand. A server socket never has a
 * client's ticket. +1. */
ScrDyn *scr_tls_sock_get_tls_ticket(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || t->cli == NULL || !t->established || scr_net_sock_destroyed(s))
    return scr_dyn_undefined();
  if (t->ticket_cached == NULL) {
    /* the engine surfaces a TLS 1.3 ticket through the session event only;
     * exporting the session here would spend the one export before it */
    const char *ver = mbedtls_ssl_get_version(&t->ssl);
    if (ver != NULL && strcmp(ver, "TLSv1.3") == 0) return scr_dyn_undefined();
    /* the first reader captures the session (and its ticket); the engine
     * exports a session only once */
    ScrBytes *b = scr_tls_session_bytes(t);
    if (b != NULL) scr_bytes_release(b);
  }
  if (t->ticket_cached == NULL) return scr_dyn_undefined();
  ScrBytes *copy = scr_tls_bytes_copy(t->ticket_cached);
  ScrDyn *d = scr_dyn_new_bytes(copy);
  scr_bytes_release(copy);
  return d;
}

/* tlsSocket.isSessionReused(): whether the handshake that stands resumed a
 * session. A server answers the ticket its peer's handshake parsed; a client
 * answers true when it offered a session and the server resumed it (a
 * resumed handshake presents no certificate). */
bool scr_tls_sock_is_session_reused(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !t->established) return false;
  if (t->srv != NULL) return t->session_resumed;
  return t->cli != NULL && t->cli->has_resume && !t->peer_cert_parsed;
}

/* tlsSocket.setSession(session): Node converts a string from latin1 and
 * hands the rest to the engine, which uses it only if the handshake has not
 * started and ignores bytes it cannot decode; a raw session Buffer is
 * ignored on a verified client (Node's reuse filter). Every socket a
 * program can hold here has already started its handshake — tls.connect
 * starts it at once, as Node's does — so the call validates and answers
 * nothing, exactly like Node's (measured). */
void scr_tls_sock_set_session(ScrNetSocket *s, const ScrDyn *session) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (s == NULL || t == NULL || scr_net_sock_destroyed(s)) return;
  if (t->handshake_started) return;
  if (t->cli != NULL && t->cli->reject) return; /* the raw-session rule */
  const ScrDyn *v = session != NULL ? session : scr_dyn_undefined();
  ScrBytes *bytes = NULL;
  if (v->kind == SCR_DYN_STR) {
    ScrStr *latin1 = scr_str_new("latin1", 6);
    bytes = scr_bytes_from_str_checked(v->v.str, latin1);
    scr_str_release(latin1);
  } else if (scr_dyn_bytes_is(v, SCR_BYTES_U8)) {
    bytes = v->v.bytes->shared ? scr_bytes_copy(v->v.bytes) : scr_dyn_bytes_unbox(v);
  }
  if (bytes == NULL) return; /* ignored, as the engine ignores it */
  if (t->cli != NULL) scr_tls_cli_set_session(t->cli, bytes);
  scr_bytes_release(bytes);
}

/* tlsSocket.getEphemeralKeyInfo(): Node answers the negotiated ephemeral
 * key's facts (null on a server-side socket, before the handshake and
 * after destroy). The bundled provider does not surface the negotiated
 * group, so a client answers an empty object — Node's shape without the
 * provider-specific members. */
ScrDyn *scr_tls_sock_ephemeral_key_info(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || scr_net_sock_destroyed(s)) return scr_dyn_new_null();
  if (!t->established || t->srv != NULL) return scr_dyn_new_null();
  return scr_dyn_new_obj();
}

/* tlsSocket.setMaxSendFragment(size): Node's ladder over the C++ call.
 * NaN, an infinity or a fraction throws ERR_OUT_OF_RANGE with Node's text;
 * an integer answers true inside 512..16384 and false outside it (what the
 * native call answers when the provider refuses the size). The bundled
 * provider cannot change the record size after setup, so the accepted
 * value's effect on fragments is a documented divergence. */
bool scr_tls_sock_set_max_fragment(ScrNetSocket *s, double size) {
  if (!(isfinite(size) && trunc(size) == size)) {
    char received[48];
    scr_num_received(size, received);
    char text[192];
    int n = snprintf(text, sizeof text,
                     "The value of \"size\" is out of range. It must be an integer. Received %s",
                     received);
    scr_throw_error_msg_code(SCR_ERR_RANGE, text, n < 0 ? 0 : (size_t)n, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (s == NULL || scr_net_sock_destroyed(s)) return false;
  return size >= 512 && size <= 16384;
}

/* tlsSocket.disableRenegotiation(): Node's SSL_OP_NO_RENEGOTIATION. The
 * engine's switch is per-config, so the refusal is enforced per socket: a
 * later handshake that a peer starts fails the connection. */
void scr_tls_sock_disable_renegotiation(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t != NULL) t->reneg_disabled = true;
}

/* tlsSocket.setKeyCert(context): Node builds a SecureContext from the
 * argument (a SecureContext passes as it is) and hands its pair to the
 * socket's SSL object, where the next handshake serves it. The context is
 * installed as the pending certificate a server handshake selects; a client
 * keeps its connect-time configuration (its handshake has already begun by
 * the time the call can run), so the call only validates there, exactly as
 * Node's own client path does. */
static void scr_tls_sock_install_key_cert(ScrNetSocket *s, ScrSecureCtx *c /*moves*/) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || t->srv == NULL) {
    scr_secure_ctx_release(c);
    return;
  }
  if (c->cert.raw.len == 0) {
    /* Node's native call answers a context without a certificate as a
     * plain Error whose message is the call's name */
    scr_secure_ctx_release(c);
    static const char text[] = "SetKeyCert";
    scr_throw_error_msg(SCR_ERR_ERROR, text, sizeof text - 1);
    return;
  }
  if (mbedtls_pk_get_type(&c->pk) == MBEDTLS_PK_NONE) {
    /* a certificate without its key fails in the engine, whose reason Node
     * surfaces as the OSSL error */
    scr_secure_ctx_release(c);
    static const char text[] = "error:0A0C0102:SSL routines::passed a null parameter";
    scr_throw_error_msg_code(SCR_ERR_ERROR, text, sizeof text - 1,
                             "ERR_SSL_PASSED_A_NULL_PARAMETER");
    return;
  }
  scr_secure_ctx_release(t->pending_cert_ctx);
  t->pending_cert_ctx = c;
}

void scr_tls_sock_set_key_cert(ScrNetSocket *s, const ScrDyn *context) {
  /* Node's method returns silently once the socket has no handle left */
  if (s == NULL || scr_net_sock_destroyed(s)) return;
  const ScrDyn *v = context != NULL ? context : scr_dyn_undefined();
  ScrSecureCtx *c = NULL;
  if (v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) {
    /* createSecureContext() over an absent options bag: an empty context */
    c = scr_tls_create_secure_context(NULL, 0, NULL, 0);
  } else if (v->kind == SCR_DYN_OBJ || v->kind == SCR_DYN_ARR || v->kind == SCR_DYN_PROXY ||
             v->kind == SCR_DYN_HANDLE || v->kind == SCR_DYN_TYPED_REF) {
    c = scr_tls_create_secure_context_dyn(v);
    if (c == NULL) return;
  } else {
    scr_dyn_arg_type_fail("options", "of type object", v);
    return;
  }
  scr_tls_sock_install_key_cert(s, c);
}

/* The same call with a tls.createSecureContext() result, which Node takes
 * as it is (no options walk runs then). */
void scr_tls_sock_set_key_cert_ctx(ScrNetSocket *s, ScrSecureCtx *ctx /*borrowed*/) {
  if (s == NULL || ctx == NULL || scr_net_sock_destroyed(s)) return;
  scr_tls_sock_install_key_cert(s, scr_secure_ctx_retain(ctx));
}

/* The TLS 1.3 refusal's deferred callback: Node answers false and still calls
 * back with the OpenSSL error. */
static void scr_tls_reneg_refuse_tick(ScrClosure *self) {
  ScrDyn *cb = scr_box_get_ref(self->caps[0]); /* +1 */
  if (cb == NULL) return;
  static const char text[] = "error:0A00010A:SSL routines::wrong ssl version";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_error_set_code(e, "ERR_SSL_WRONG_SSL_VERSION");
  ScrDyn *err = scr_dyn_from_error(e);
  scr_error_release(e);
  if (err != NULL) {
    ScrDyn *answer = scr_dyn_call(cb, &err, 1, "renegotiate callback");
    scr_dyn_release(err);
    scr_dyn_release(answer);
  }
  scr_dyn_release(cb);
}

/* tlsSocket.renegotiate(options[, callback]): Node's ladder over the option
 * and callback types, false with ERR_SSL_WRONG_SSL_VERSION on TLS 1.3 (the
 * callback scheduled), and a real renegotiation on TLS 1.2 whose completion
 * answers the callback with null. */
bool scr_tls_sock_renegotiate(ScrNetSocket *s, const ScrDyn *options,
                              const ScrDyn *callback) {
  const ScrDyn *o = options != NULL ? options : scr_dyn_undefined();
  if (!(o->kind == SCR_DYN_OBJ || o->kind == SCR_DYN_ARR || o->kind == SCR_DYN_PROXY ||
        o->kind == SCR_DYN_HANDLE || o->kind == SCR_DYN_TYPED_REF)) {
    scr_dyn_arg_type_fail("options", "of type object", o);
    return false;
  }
  const ScrDyn *cb = callback != NULL ? callback : scr_dyn_undefined();
  if (cb->kind != SCR_DYN_UNDEF && cb->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("callback", "of type function", cb);
    return false;
  }
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !t->established) return true; /* Node answers true here */
  const char *version = mbedtls_ssl_get_version(&t->ssl);
  if (version != NULL && strcmp(version, "TLSv1.3") == 0) {
    /* TLS 1.3 cannot renegotiate: the call is refused before anything about
     * the socket changes, so its authorization answers stand */
    if (cb->kind == SCR_DYN_FUNC) {
      ScrClosure *c = scr_closure_new((void *)&scr_tls_reneg_refuse_tick, 1);
      /* the box traces its dyn value like every other dyn box (the RC
       * audit's cycle walk needs the trace function) */
      c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      scr_box_set_ref(c->caps[0], scr_dyn_retain((ScrDyn *)cb));
      scr_next_tick(c);
    }
    return false;
  }
  /* The options' policy applies to the handshake that starts here (Node's
   * setVerifyMode): a server asks for a client certificate when
   * requestCert is on and rejects a failed or missing one only with
   * rejectUnauthorized. It is merged for a renegotiation that starts, and
   * a refused start restores it. */
  bool old_cert = t->req_cert, old_reject = t->reject_unauth;
  if (t->srv != NULL && (o->kind == SCR_DYN_OBJ || o->kind == SCR_DYN_TYPED_REF)) {
    ScrDyn *plain = o->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(o) : NULL;
    if (o->kind == SCR_DYN_TYPED_REF && plain == NULL) return false;
    const ScrDyn *want_cert = scr_dyn_obj_get(plain != NULL ? plain : o, "requestCert",
                                              sizeof "requestCert" - 1);
    if (want_cert != NULL && want_cert->kind != SCR_DYN_UNDEF)
      t->req_cert = scr_tls_dyn_truthy(want_cert);
    const ScrDyn *want_reject = scr_dyn_obj_get(plain != NULL ? plain : o, "rejectUnauthorized",
                                                sizeof "rejectUnauthorized" - 1);
    if (want_reject != NULL && want_reject->kind != SCR_DYN_UNDEF)
      t->reject_unauth = scr_tls_dyn_truthy(want_reject);
    scr_dyn_release(plain);
  }
  bool started = scr_net_sock_renegotiate(
      s, cb->kind == SCR_DYN_FUNC ? scr_dyn_retain((ScrDyn *)cb) : NULL);
  if (!started) {
    t->req_cert = old_cert;
    t->reject_unauth = old_reject;
  }
  return started;
}

/* One completed renegotiation, whichever side started it: Node fires
 * 'secure' for it, and every verdict the first handshake enforced applies
 * again. A socket whose application disabled renegotiation fails it. */
static void scr_tls_renegotiation_completed(ScrTlsSock *t) {
  /* one report per handshake: the pump reports the renegotiation this side
   * started, the read path reports the one mbedTLS completed inside a read,
   * and both can observe the same completed handshake */
  if (t->renego_reported) return;
  t->renego_reported = true;
  t->renego_phase = t->ssl.MBEDTLS_PRIVATE(renego_status);
  /* the policy this completed handshake ran under: the answers the
   * 'secure' listeners and the callback read below are its verdicts */
  t->verdict_req_cert = t->req_cert;
  if (t->reneg_disabled) {
    scr_net_sock_transport_error(t->sock, NULL);
    t->hang_up_pending = true;
    return;
  }
  /* Node's server re-checks the client certificate on every 'secure': a
   * verify failure or a missing certificate sets authorizationError, and
   * with rejectUnauthorized the socket ends — from inside the 'secure'
   * emit, so the response arrives before the close and the peer sees a
   * clean end (no 'error' on either side). The policy is the socket's own,
   * which renegotiate(options) may have changed. */
  bool end_after_secure = false;
  if (t->srv != NULL && !t->srv->standalone && t->req_cert) {
    bool missing = mbedtls_ssl_get_peer_cert(&t->ssl) == NULL;
    t->client_cert_missing = missing;
    if ((missing || mbedtls_ssl_get_verify_result(&t->ssl) != 0) && t->reject_unauth)
      end_after_secure = true;
  }
  if (t->srv != NULL && ++t->renegotiations > 3)
    /* OpenSSL's session-attack guard: the fourth and later renegotiations
     * report ERR_TLS_SESSION_ATTACK on the server socket (non-fatal) */
    scr_net_sock_emit_error_code(t->sock, "TLS session renegotiation attack detected",
                                 "ERR_TLS_SESSION_ATTACK");
  /* Node's server destroys the socket from its own 'secure' listener, which
   * runs before the application's: everything the listeners then read from
   * the socket — its peer certificate above all — is what a destroyed socket
   * answers, so a certificate the policy rejected is never handed out. The
   * handshake's own flight is already on the wire. */
  if (end_after_secure) {
    if (t->holding) t->close_after_hold = true; /* after the flight goes out */
    else scr_net_sock_destroy(t->sock);
  }
  scr_net_fire0_this(&t->secure_ls, t->sock, SCR_DYNH_NET_SOCKET);
}

/* A renegotiation completed inside mbedTLS's own read: the engine records
 * every handshake in its status field — a caller's or a peer's, and a
 * resumed one that re-sends no certificate, which a verify walk cannot
 * see. 2 = MBEDTLS_SSL_RENEGOTIATION_DONE; the status leaving it starts
 * the next handshake. */
static void scr_tls_peer_renegotiated(ScrTlsSock *t) {
  int status = t->ssl.MBEDTLS_PRIVATE(renego_status);
  /* a new handshake is under way: whatever was reported before does not
   * cover it */
  if (status != 2 && t->renego_phase == 2) t->renego_reported = false;
  bool completed = status == 2 && t->renego_phase != 2 && t->established;
  t->renego_phase = status;
  if (completed) scr_tls_renegotiation_completed(t);
}

/* A renegotiation runs the verify callback again over a NEW peer chain: the
 * previous walk's pointers and verdicts point at state mbedTLS clears
 * (ssl_clear_peer_cert), so they are dropped before the handshake restarts. */
static void scr_tls_reset_verify_state(ScrTlsSock *t) {
  t->vrfy_seen = false;
  t->vrfy_walk_done = false;
  t->vrfy_flags = 0;
  t->vrfy_trust = NULL;
  t->vrfy_top = NULL;
  t->vrfy_chain_len = 0;
  memset(t->vrfy_chain, 0, sizeof t->vrfy_chain);
  t->vrfy_leaf_self = false;
  t->vrfy_chain_self = false;
  t->vrfy_expired = false;
  t->vrfy_future = false;
  t->vrfy_bad_sig = false;
  t->vrfy_pathlen = false;
  t->vrfy_cn_mismatch = false;
  t->vrfy_crl_revoked = false;
  t->vrfy_crl_expired = false;
  t->vrfy_crl_future = false;
  t->vrfy_crl_sig_fail = false;
  t->vrfy_crl_key_usage = false;
  t->vrfy_crl_missing = false;
  t->vrfy_blocked = false;
  free(t->vrfy_altnames);
  t->vrfy_altnames = NULL;
}

/* The renegotiation ops: mbedtls_ssl_renegotiate drives the handshake loop
 * again, and its completion re-fires 'secure' as Node does. */
static int scr_tls_renegotiate(void *tctx) {
  ScrTlsSock *t = (ScrTlsSock *)tctx;
  scr_tls_reset_verify_state(t);
  /* a handshake this side starts has not been reported yet */
  t->renego_reported = false;
  int r = mbedtls_ssl_renegotiate(&t->ssl);
  if (r == 0) return 1; /* finished at once */
  if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return 0;
  return -1;
}

static void scr_tls_on_renegotiated(void *tctx) {
  /* a renegotiation THIS side started completes through the handshake
   * driver or, when the peer's hello drives it, the read path; the
   * completion is idempotent per handshake */
  scr_tls_renegotiation_completed((ScrTlsSock *)tctx);
}

/* Whether the renegotiation has completed and its events were reported:
 * a server's own renegotiation advances in the read path, where the net
 * layer still owes the caller its callback. */
static bool scr_tls_renegotiation_ready(void *tctx) {
  return ((ScrTlsSock *)tctx)->renego_reported;
}

/* `x instanceof tls.Server` over a checked-dynamic value: false for every
 * non-server value (a null, another handle, a plain object). */
bool scr_tls_server_is_dyn(const ScrDyn *v) {
  if (v->kind != SCR_DYN_HANDLE || v->v.handle.tag != SCR_DYNH_NET_SERVER) return false;
  return scr_net_server_is_tls((const ScrNetServer *)v->v.handle.ptr);
}

/* tlsSocket.servername (which == 0) and getSession (1) over the shared
 * checked-dynamic member entry. */
ScrDyn *scr_tls_sock_dyn_member(ScrNetSocket *s, double which) {
  return (int)which == 1 ? scr_tls_sock_get_session(s) : scr_tls_sock_servername(s);
}

bool scr_tls_sock_authorized(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !scr_tls_sock_verifies(t) || t->client_cert_missing) return false;
  /* a server authorizes a client only on a certificate it actually
   * examined: a handshake that asked for one and verified nothing (a
   * resumed session, say) authorizes nobody */
  if (t->srv != NULL && mbedtls_ssl_get_peer_cert(&t->ssl) == NULL) return false;
  return scr_tls_read_verdict(t) == 0;
}

ScrStr *scr_tls_sock_auth_error(ScrNetSocket *s) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || !scr_tls_sock_verdict(t)) return NULL;
  /* a handshake that asked for a client certificate and got none: Node's
   * onServerSocketSecure reports the missing issuer itself */
  if (t->srv != NULL && t->client_cert_missing)
    return scr_str_new("UNABLE_TO_GET_ISSUER_CERT", sizeof "UNABLE_TO_GET_ISSUER_CERT" - 1);
  if (scr_tls_read_verdict(t) == 0) {
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
  if (t == NULL || t->settled) {
    scr_closure_release(cb); /* a plain socket never emits it, like Node */
    return;
  }
  /* Node emits 'secure' to the set registered when the handshake completed:
   * a registration made while the connect listeners run misses that one but
   * still sees later emissions (a renegotiation's). */
  if (t->established && !t->secure_emitted)
    scr_net_ls_add(&t->secure_next_ls, cb, NULL, once);
  else scr_net_ls_add(&t->secure_ls, cb, NULL, once);
}

void scr_tls_sock_on_keylog(ScrNetSocket *s, ScrClosure *cb /*moves*/, void *fn, bool once) {
  ScrTlsSock *t = scr_tls_sock_of(s);
  if (t == NULL || t->settled) {
    scr_closure_release(cb); /* a plain socket never fires it, like Node */
    return;
  }
  scr_net_ls_add(&t->keylog_ls, cb, fn, once);
}

void scr_tls_server_on_keylog(ScrNetServer *server, ScrClosure *cb /*moves*/, void *fn, bool once) {
  ScrTlsSrv *s = scr_tls_srv_of_server_or_null(server);
  if (s == NULL) {
    /* Node's EventEmitter keeps a listener for any event name: a plain net
     * or HTTP server's 'keylog' listener is registered and never fires */
    scr_net_server_on_inert(server, cb, fn, once);
    return;
  }
  scr_net_ls_add(&s->keylog_ls, cb, fn, once);
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
  if (strcmp(event, "keylog") == 0) {
    scr_net_ls_add(&t->keylog_ls, scr_dyn_listener_closure_data(cb),
                   (void *)&scr_dyn_listener_fire_data, once);
    return true;
  }
  if (strcmp(event, "session") == 0) {
    scr_net_ls_add(&t->session_ls, scr_dyn_listener_closure_data(cb),
                   (void *)&scr_dyn_listener_fire_data, once);
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
  if (strcmp(method, "getTLSTicket") == 0) {
    *out = scr_tls_sock_get_tls_ticket(s);
    return true;
  }
  if (strcmp(method, "setServername") == 0) {
    ScrTlsSock *t = scr_tls_sock_of(s);
    if (argc < 1 || args[0]->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("name", "of type string", argc < 1 ? scr_dyn_undefined() : args[0]);
      *out = NULL;
      return true;
    }
    if (t->srv != NULL) {
      static const char msg[] = "Cannot issue SNI from a TLS server-side socket";
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_TLS_SNI_FROM_SERVER");
      *out = NULL;
      return true;
    }
    /* a client's SNI is fixed when the socket starts its handshake */
    static const char msg[] =
        "changing the SNI of a started client socket has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
    *out = NULL;
    return true;
  }
  static const char *const tls_methods[] = {
    "getPeerCertificate", "getCertificate", "getSession",
    "getEphemeralKeyInfo", "getFinished", "getPeerFinished",
    "getSharedSigalgs", "getPeerX509Certificate", "getX509Certificate",
    "exportKeyingMaterial", "isSessionReused", "renegotiate", "setMaxSendFragment",
    "enableTrace", "disableRenegotiation", "setSession", NULL,
  };
  for (size_t i = 0; tls_methods[i] != NULL; i++) {
    if (strcmp(method, tls_methods[i]) == 0) {
      char msg[160];
      int n = snprintf(msg, sizeof msg,
                       "'TLSSocket.prototype.%s' on a dynamic value is not supported yet", method);
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)n, "SC2020");
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
