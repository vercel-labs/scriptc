/* Only this translation unit's policy hash is interposed. The separately
 * compiled mbedTLS library still signs, verifies, and hashes real handshakes. */
#include "mbedtls/sha256.h"
static int test_spki_sha256(const unsigned char *, size_t, unsigned char *, int);
#define mbedtls_sha256 test_spki_sha256
#include "../src/scr_tls.c"
#undef mbedtls_sha256

#include <assert.h>
#include <signal.h>
#include <unistd.h>

static const char *const LEAF = "4e67befd553901ada168f6b46965400e2bdb91588e3b6231e551ab8adb0010ba";
static const char *const ROOT = "f1191d558a1c1aea6bddf6b3cfa58b49485ade30be879cab442bdf32f3bf1ea5";
static const char *const OTHER = "850dc45a9170e9ba136c30f39ebf43869e482178d05e371c1b1447c6853f5d23";
static const char *const CLIENT = "6e6650a2b64735957732454872d3df1b981f46c8c483eedb26b5c8a8b5492d52";
static const char *blocked, *hash_error;
static unsigned policy_hashes, remaps, hash_errors;

static void check(bool ok, const char *why) {
  if (!ok) { fprintf(stderr, "FAIL: %s\n", why); abort(); }
}

static bool digest_is(const unsigned char *digest, const char *hex) {
  if (hex == NULL) return false;
  char actual[65];
  for (size_t i = 0; i < 32; i++) snprintf(actual + i * 2, 3, "%02x", digest[i]);
  return strcmp(actual, hex) == 0;
}

static int test_spki_sha256(const unsigned char *input, size_t len,
                            unsigned char *output, int is224) {
  policy_hashes++;
  int r = mbedtls_sha256(input, len, output, is224);
  if (r != 0) return r;
  if (digest_is(output, hash_error)) { hash_errors++; return -1; }
  if (digest_is(output, blocked)) {
    /* Independent literal: do not let a changed policy table change the test. */
    static const unsigned char compromised[32] = {
      0x49,0xdd,0x35,0x3d,0xc2,0xb9,0x19,0xa3,0x77,0x06,0x45,0x11,0x7d,0x0e,0x60,0xc1,
      0x61,0x15,0xe7,0xd1,0xbc,0x25,0x9e,0xef,0xe7,0x34,0xb0,0x0e,0xa4,0x34,0xfe,0x5f,
    };
    memcpy(output, compromised, sizeof compromised);
    remaps++;
  }
  return 0;
}

static char *load(const char *dir, const char *name) {
  char path[1024];
  check(snprintf(path, sizeof path, "%s/%s", dir, name) < (int)sizeof path, "fixture path");
  FILE *f = fopen(path, "rb");
  check(f != NULL, "open fixture");
  check(fseek(f, 0, SEEK_END) == 0, "seek fixture");
  long len = ftell(f);
  check(len > 0 && len < 16384, "bounded fixture");
  rewind(f);
  char *text = malloc((size_t)len + 1);
  check(text != NULL && fread(text, 1, (size_t)len, f) == (size_t)len, "read fixture");
  text[len] = 0;
  check(fclose(f) == 0, "close fixture");
  return text;
}

static char *concat(const char *a, const char *b) {
  char *out = malloc(strlen(a) + strlen(b) + 1);
  check(out != NULL, "allocate chain");
  strcpy(out, a); strcat(out, b);
  return out;
}

static ScrBytes *bytes(const char *text) {
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)strlen(text));
  memcpy(out->data, text, out->len);
  return out;
}

static bool str_is(const ScrStr *s, const char *text) {
  return text == NULL ? s == NULL :
      s != NULL && s->len == strlen(text) && memcmp(s->data, text, s->len) == 0;
}

static void fixture_spki(const char *pem, const char *expected) {
  mbedtls_x509_crt crt;
  mbedtls_x509_crt_init(&crt);
  check(scr_tls_parse_crt(&crt, pem, strlen(pem)) == 0, "parse fixture certificate");
  unsigned char digest[32];
  check(mbedtls_sha256(crt.pk_raw.p, crt.pk_raw.len, digest, 0) == 0 &&
        digest_is(digest, expected), "exact fixture SPKI");
  check(scr_tls_check_spki(&crt) == SCR_TLS_SPKI_ALLOWED, "unmapped fixture allowed");
  mbedtls_x509_crt_free(&crt);
}

static void policy_controls(const char *leaf, const char *root) {
  unsigned char digest[32];
  check(mbedtls_sha256((const unsigned char *)"abc", 3, digest, 0) == 0 &&
        digest_is(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
        "real SHA-256 known vector");
  /* Concatenated bytes of all eight rows at Node's immutable source commit. */
  check(sizeof SCR_TLS_BLOCKED_SPKIS == 8 * 32, "complete upstream policy table");
  check(mbedtls_sha256((const unsigned char *)SCR_TLS_BLOCKED_SPKIS,
                      sizeof SCR_TLS_BLOCKED_SPKIS, digest, 0) == 0 &&
        digest_is(digest, "91892d9c629d00a1241f7c9909f483b2ae31e0b2b60eba9c8ed64398dc8983c8"),
        "all upstream SPKI policy bytes");
  mbedtls_x509_crt missing = {0};
  check(scr_tls_check_spki(&missing) == SCR_TLS_SPKI_ERROR, "missing SPKI never allowed");
  char *chain = concat(leaf, root);
  mbedtls_x509_crt crt;
  mbedtls_x509_crt_init(&crt);
  check(scr_tls_parse_crt(&crt, chain, strlen(chain)) == 0 && crt.next != NULL, "precedence chain");
  free(chain);
  for (unsigned i = 0; i < 2; i++) {
    blocked = i == 0 ? LEAF : ROOT;
    hash_error = i == 0 ? ROOT : LEAF;
    ScrTlsSock t = {0};
    uint32_t root_flags = 0, leaf_flags = 0;
    check(scr_tls_vrfy_cb(&t, crt.next, 1, &root_flags) == 0 && root_flags == 0,
          "root policy is deferred until leaf");
    check(scr_tls_vrfy_cb(&t, &crt, 0, &leaf_flags) == 0, "leaf callback");
    ScrTlsSpki expected = i == 0 ? SCR_TLS_SPKI_BLOCKED : SCR_TLS_SPKI_ERROR;
    check(t.vrfy_spki == expected && leaf_flags == scr_tls_spki_flags(expected),
          "leaf-first selected error replaces root outcome");
    check(t.vrfy_peer_spki == expected, "leaf-first peer precedence");
    /* A selected error must win over a different peer-list error. */
    t.vrfy_peer_spki = i == 0 ? SCR_TLS_SPKI_ERROR : SCR_TLS_SPKI_BLOCKED;
    mbedtls_ssl_init(&t.ssl);
    check(scr_tls_verify_result(&t) == scr_tls_spki_flags(expected), "selected beats peer");
    t.vrfy_spki = SCR_TLS_SPKI_ALLOWED;
    check(scr_tls_verify_result(&t) == UINT32_MAX, "no-result sentinel does not admit peer fallback");
    mbedtls_ssl_free(&t.ssl);
  }
  mbedtls_x509_crt_free(&crt);
  blocked = hash_error = NULL;
}

enum {
  VALID, LEAF_REQUIRED, LEAF_OPTIONAL, INTERMEDIATE, SELECTED_ROOT, UNUSED_ANCHOR,
  EXTRA_VALID, EXTRA_INVALID_REQUIRED, EXTRA_INVALID_OPTIONAL, SERVER_SECONDARY, SERVER_SECONDARY_REQUIRED,
  HOSTNAME_ONLY, VALID_CLIENT, CLIENT_REQUIRED, CLIENT_OPTIONAL, HASH_ERROR, CLIENT_SECONDARY,
  VERIFY_NONE, CASE_COUNT,
};
static const char *const names[] = {
  "valid", "blocked-leaf-required", "blocked-leaf-optional", "blocked-intermediate",
  "blocked-selected-root", "blocked-unused-anchor", "unrelated-blocked-peer-valid",
  "unrelated-blocked-peer-invalid-required", "unrelated-blocked-peer-invalid-optional",
  "server-secondary-eku", "server-secondary-eku-required", "hostname-only", "valid-client", "blocked-client-required",
  "blocked-client-optional", "hash-error", "client-secondary-eku", "verify-none",
};
static int selected, version;
static ScrNetServer *server;
static ScrNetSocket *client, *accepted;
static unsigned client_secure, server_secure, client_closed, server_closed, listener_closed;
static unsigned client_errors, server_errors;
static char client_code[80], server_code[80], client_message[256];
static size_t late_held_bytes;
static bool stopped;

static void check_properties(ScrNetSocket *sock, bool authorized, const char *error) {
  check(scr_tls_sock_authorized(sock) == authorized, "typed authorized");
  ScrStr *text = scr_tls_sock_auth_error(sock);
  check(str_is(text, error), "typed authorizationError");
  scr_str_release(text);
  ScrDyn *value = NULL;
  check(scr_tls_dynh_get(sock, "authorized", &value) && value != NULL &&
        value->kind == SCR_DYN_BOOL && value->v.b == authorized, "dynamic authorized");
  scr_dyn_release(value);
  check(scr_tls_dynh_get(sock, "authorizationError", &value) && value != NULL,
        "dynamic authorizationError present");
  check(error == NULL ? value->kind == SCR_DYN_NULL :
        value->kind == SCR_DYN_STR && str_is(value->v.str, error), "dynamic authorizationError");
  scr_dyn_release(value);
}

static void stop(void) {
  if (stopped) return;
  stopped = true;
  scr_net_sock_destroy(client);
  if (accepted != NULL) scr_net_sock_destroy(accepted);
  scr_net_server_close(server, NULL);
}

static void maybe_done(void) { if (client_secure && server_secure) stop(); }
static void on_listener_close(ScrClosure *cb) { (void)cb; listener_closed++; }
static void on_server_close(ScrClosure *cb) {
  (void)cb;
  server_closed++;
  /* The client must consume Finished or EOF before its own close event. */
  scr_net_server_close(server, NULL);
}
static void on_client_close(ScrClosure *cb) {
  (void)cb;
  client_closed++;
  /* Let the peer observe EOF itself; destroying it here could hide an alert. */
  scr_net_server_close(server, NULL);
}

static void on_client_error(ScrClosure *cb, ScrStr *msg) {
  (void)cb;
  client_errors++;
  snprintf(client_message, sizeof client_message, "%.*s", (int)msg->len, msg->data);
  const char *code = scr_error_message_code(msg);
  snprintf(client_code, sizeof client_code, "%s", code ? code : "(none)");
  ScrTlsSock *t = scr_tls_sock_of(client);
  if (selected != CLIENT_REQUIRED && selected != SERVER_SECONDARY_REQUIRED) {
    check(t != NULL && t->quiet_failure && t->held_len == 0 && t->held_off == 0,
          "rejecting client discards held flight");
    check_properties(client, false, NULL);
  }
}

static void on_server_error(ScrClosure *cb, ScrError *error, ScrNetSocket *sock) {
  (void)cb;
  server_errors++;
  snprintf(server_code, sizeof server_code, "%.*s", error->code ? (int)error->code->len : 0,
           error->code ? error->code->data : "");
  scr_error_release(error);
  scr_net_sock_release(sock);
}

static void on_client_secure(ScrClosure *cb) {
  (void)cb; client_secure++;
  bool bad = selected == LEAF_OPTIONAL || selected == EXTRA_INVALID_OPTIONAL;
  check_properties(client, !bad && selected != VERIFY_NONE, bad ? "CERT_REVOKED" : NULL);
  maybe_done();
}

static void on_server_secure(ScrClosure *cb, ScrNetSocket *sock) {
  (void)cb; server_secure++;
  bool verifies = selected == SERVER_SECONDARY || selected == CLIENT_REQUIRED || selected == CLIENT_OPTIONAL;
  check_properties(sock, selected == VALID_CLIENT, verifies ? "CERT_REVOKED" : NULL);
  scr_net_sock_release(sock);
  maybe_done();
}

static void on_accept(void *ctx, ScrNetSocket *sock) {
  check(accepted == NULL, "one accepted socket");
  accepted = scr_net_sock_retain(sock);
  scr_tls_srv_on_conn(ctx, sock);
  scr_net_sock_on_close(sock, scr_closure_new((void *)&on_server_close, 0), true);
}

static int observe_client_send(void *ctx, const unsigned char *buf, size_t len) {
  ScrTlsSock *t = ctx;
  if (t->holding && !t->quiet_failure && t->vrfy_spki == SCR_TLS_SPKI_ALLOWED &&
      t->vrfy_peer_spki == SCR_TLS_SPKI_BLOCKED) late_held_bytes += len;
  return scr_tls_bio_send(ctx, buf, len);
}

static void handshake(const char *dir) {
  char *leaf = load(dir, "localhost.pem"), *key = load(dir, "localhost-key.pem");
  char *ca = load(dir, "ca.pem"), *other = load(dir, "ca2.pem");
  char *client_pem = load(dir, "client.pem"), *client_key = load(dir, "client-key.pem");
  char *intermediate = load(dir, "intermediate.pem"), *intermediate_leaf = load(dir, "intermediate-localhost.pem");
  fixture_spki(leaf, LEAF); fixture_spki(ca, ROOT); fixture_spki(other, OTHER);
  fixture_spki(client_pem, CLIENT); fixture_spki(intermediate, OTHER); fixture_spki(intermediate_leaf, LEAF);
  policy_hashes = remaps = hash_errors = 0;
  bool request = selected == SERVER_SECONDARY || selected == SERVER_SECONDARY_REQUIRED || selected == VALID_CLIENT ||
                 selected == CLIENT_REQUIRED || selected == CLIENT_OPTIONAL;
  bool reject = selected != LEAF_OPTIONAL && selected != EXTRA_INVALID_OPTIONAL && selected != VERIFY_NONE;
  bool extra = selected == EXTRA_VALID || selected == EXTRA_INVALID_REQUIRED ||
               selected == EXTRA_INVALID_OPTIONAL || selected == HOSTNAME_ONLY || selected == CLIENT_SECONDARY;
  char *served = selected == INTERMEDIATE ? concat(intermediate_leaf, intermediate) :
                 extra ? concat(selected == CLIENT_SECONDARY ? client_pem : leaf, other) : strdup(leaf);
  const char *served_key = selected == CLIENT_SECONDARY ? client_key : key;
  char *trust = selected == UNUSED_ANCHOR ? concat(ca, other) :
                strdup(selected == EXTRA_INVALID_REQUIRED || selected == EXTRA_INVALID_OPTIONAL ? other : ca);
  blocked = selected == VALID || selected == VALID_CLIENT || selected == HASH_ERROR ? NULL :
            selected == SELECTED_ROOT ? ROOT :
            selected == CLIENT_REQUIRED || selected == CLIENT_OPTIONAL ? CLIENT :
            selected == LEAF_REQUIRED || selected == LEAF_OPTIONAL || selected == VERIFY_NONE ? LEAF : OTHER;
  hash_error = selected == HASH_ERROR ? LEAF : NULL;

  ScrTlsSrv *srv = scr_tls_srv_new(served, strlen(served), served_key, strlen(served_key), false);
  ScrBytes *server_ca = bytes(ca);
  ScrTlsClientAuth auth = {
    .request = request,
    .reject = selected == CLIENT_REQUIRED || selected == SERVER_SECONDARY_REQUIRED,
    .ca = server_ca,
  };
  scr_tls_srv_client_auth(srv, request ? &auth : NULL);
  scr_bytes_release(server_ca);
  check(scr_tls_conf_versions(&srv->conf, version, version), "server TLS version");
  srv->max_tls12 = version == 12;
  server = scr_net_create_server(scr_closure_new((void *)&on_server_secure, 0), &on_server_secure);
  scr_net_server_set_native_conn(server, &on_accept, srv, &scr_tls_srv_release_v);
  scr_net_server_defer_connections(server);
  scr_net_server_on_client_error(server, scr_closure_new((void *)&on_server_error, 0),
                                 (void *)&scr_net_client_error_thunk2, false);
  scr_net_server_on_close(server, scr_closure_new((void *)&on_listener_close, 0), true);
  ScrStr *host = scr_str_new("127.0.0.1", 9);
  scr_net_listen_opts(server, 0, host, false, NULL);
  check(!scr_exc_pending() && scr_net_server_port(server) > 0, "listen on loopback ephemeral port");
  client = scr_net_connect(scr_net_server_port(server), host, NULL);
  scr_str_release(host);
  const char *verify_name = selected == HOSTNAME_ONLY ? "wrong.example" :
                            selected == CLIENT_SECONDARY ? "scriptc test client" : "localhost";
  ScrStr *name = scr_str_new(verify_name, strlen(verify_name));
  ScrTlsCli *cli = scr_tls_cli_new2(name, reject, trust, strlen(trust), selected != VERIFY_NONE);
  scr_str_release(name);
  check(scr_tls_conf_versions(&cli->conf, version, version), "client TLS version");
  if (request) {
    bool secondary = selected == SERVER_SECONDARY || selected == SERVER_SECONDARY_REQUIRED;
    char *own = secondary ? concat(leaf, other) : strdup(client_pem);
    ScrBytes *cert = bytes(own), *private_key = bytes(secondary ? key : client_key);
    scr_tls_cli_set_own(cli, cert, private_key);
    scr_bytes_release(cert); scr_bytes_release(private_key); free(own);
  }
  scr_tls_cli_wrap(client, cli);
  if (selected == CLIENT_SECONDARY) {
    ScrTlsSock *t = scr_tls_sock_of(client);
    mbedtls_ssl_set_bio(&t->ssl, t, &observe_client_send, &scr_tls_bio_recv, NULL);
  }
  scr_tls_sock_on_secure_connect(client, scr_closure_new((void *)&on_client_secure, 0), true);
  scr_net_sock_on_error(client, scr_closure_new((void *)&on_client_error, 0), &on_client_error, false);
  scr_net_sock_on_close(client, scr_closure_new((void *)&on_client_close, 0), true);
  check(!scr_exc_pending(), "socket construction");
  (void)scr_loop_run(NULL);
  check(!scr_exc_pending(), "event loop has no pending exception");
  bool client_reject = selected == LEAF_REQUIRED || selected == INTERMEDIATE || selected == SELECTED_ROOT ||
                       selected == EXTRA_INVALID_REQUIRED || selected == HOSTNAME_ONLY ||
                       selected == HASH_ERROR || selected == CLIENT_SECONDARY;
  if (client_reject) {
    check(client_secure == 0 && server_secure == 0 && client_errors == 1, "client rejection event counts");
    const char *expected = selected == HOSTNAME_ONLY ? "ERR_TLS_CERT_ALTNAME_INVALID" :
                           selected == HASH_ERROR ? "UNSPECIFIED" : "CERT_REVOKED";
    check(strcmp(client_code, expected) == 0, "client rejection code");
    if (selected != HOSTNAME_ONLY)
      check(strcmp(client_message, selected == HASH_ERROR ? "unspecified certificate verification error" :
                   "certificate revoked") == 0, "client rejection message");
  } else if (selected == CLIENT_REQUIRED || selected == SERVER_SECONDARY_REQUIRED) {
    check(server_secure == 0 && server_errors == 1, "server required verification rejects before secureConnection");
    check(client_secure == (unsigned)(version == 13) && client_errors == (unsigned)(version == 12),
          "required-server rejection preserves protocol-specific client events");
    check(strcmp(server_code, "ECONNRESET") == 0, "required server emits hang-up after closure");
    check(scr_tls_verify_result(scr_tls_sock_of(accepted)) == MBEDTLS_X509_BADCERT_REVOKED,
          "server rejection retains effective verdict");
    check_properties(accepted, false, NULL);
  } else {
    check(client_secure == 1 && server_secure == 1 && client_errors == 0 && server_errors == 0,
          "successful handshake event counts");
  }
  if (selected == CLIENT_SECONDARY) {
    check(late_held_bytes > 0, "secondary failure buffered an alert before final policy");
    check(server_errors == 1 && strcmp(server_code, "ECONNRESET") == 0,
          "peer observes closure, not the buffered fatal alert");
  }
  if (selected == CLIENT_SECONDARY || selected == SERVER_SECONDARY || selected == SERVER_SECONDARY_REQUIRED) {
    ScrTlsSock *t = scr_tls_sock_of(selected == CLIENT_SECONDARY ? client : accepted);
    check(t->vrfy_spki == SCR_TLS_SPKI_ALLOWED && t->vrfy_peer_spki == SCR_TLS_SPKI_BLOCKED &&
          (mbedtls_ssl_get_verify_result(&t->ssl) & MBEDTLS_X509_BADCERT_EXT_KEY_USAGE) != 0,
          "post-callback EKU failure admits original peer fallback");
  }
  if (selected == SELECTED_ROOT) {
    ScrTlsSock *t = scr_tls_sock_of(client);
    check(t->vrfy_spki == SCR_TLS_SPKI_BLOCKED && t->vrfy_peer_spki == SCR_TLS_SPKI_ALLOWED,
          "selected blocked trust anchor was not peer-sent");
  }
  if (selected == UNUSED_ANCHOR) check(remaps == 0, "unused trust anchor is not checked");
  if (selected == VERIFY_NONE) check(policy_hashes == 0 && remaps == 0, "VERIFY_NONE does not enforce policy");
  else check(policy_hashes > 0, "real handshake invoked SPKI policy");
  if (selected == HASH_ERROR) check(hash_errors > 0, "hash failure was injected");
  if (selected != VALID && selected != VALID_CLIENT && selected != HASH_ERROR &&
      selected != UNUSED_ANCHOR && selected != VERIFY_NONE)
    check(remaps > 0, "owned fixture matched interposer");
  check(client_closed == 1 && server_closed == 1 && listener_closed == 1, "each handle closes once");
  scr_net_sock_release(client); scr_net_sock_release(accepted); scr_net_server_release(server);
#ifdef SCR_RC_AUDIT
  check(scr_net_live_count() == 0 && scr_secure_ctx_live_count() == 0, "TLS/network owners released");
#endif
  free(served); free(trust); free(leaf); free(key); free(ca); free(other);
  free(client_pem); free(client_key); free(intermediate); free(intermediate_leaf);
}

int main(int argc, char **argv) {
  check(argc == 4, "case, TLS version, certificate directory required");
  if (strcmp(argv[1], "policy-controls") == 0) {
    char *leaf = load(argv[3], "localhost.pem"), *root = load(argv[3], "ca.pem");
    policy_controls(leaf, root);
    free(leaf); free(root);
    fputs("PASS policy-controls\n", stderr);
    return 0;
  }
  selected = -1;
  for (int i = 0; i < CASE_COUNT; i++) if (strcmp(argv[1], names[i]) == 0) selected = i;
  version = atoi(argv[2]);
  check(selected >= 0 && (version == 12 || version == 13), "named test invocation");
  alarm(20); /* A deadlocked handshake fails; elapsed time never proves success. */
  scr_init(); scr_net_install();
  handshake(argv[3]);
  alarm(0);
  fprintf(stderr, "PASS %s TLS1.%d\n", names[selected], version - 10);
  return 0;
}
