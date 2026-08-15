/* node:tls — the CA-store introspection slice: getCACertificates,
 * rootCertificates, and setDefaultCACertificates (scr_runtime.h has the
 * contracts). Its own link gate ("tlsca." libCalls), deliberately free
 * of mbedTLS: everything here is PEM-BLOCK bookkeeping over the host
 * roots (plus crypt32 store access on Windows), so a program that only
 * inspects the CA store never builds the TLS archive. scr_tls.c (when it
 * links — cc.ts compiles this unit alongside it) consults
 * scr_tls_ca_default_override for its client trust anchors, which is what
 * makes setDefaultCACertificates LIVE semantics: the next https/tls dial
 * verifies against the replaced set.
 *
 * Divergences, documented: the host bundle stands in for Node's
 * compiled-in Mozilla roots ('bundled' and rootCertificates) AND for the
 * platform store ('system') — Windows' system ROOT stores and the POSIX
 * bundle probe are the same sources scr_tls.c's anchors use; and set-time
 * validation is PEM-BLOCK shaped (a well-formed block with corrupt DER
 * inside is kept here where Node's X509 parse would drop it — such a cert
 * then fails verification instead, the same observable outcome one step
 * later). Deduplication is byte-exact over the extracted block where Node
 * compares parsed X509 identities; re-encoded duplicates of one certificate
 * stay distinct entries, which no equality the tests observe can distinguish
 * without a parser. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#include <wincrypt.h>
#endif

/* The per-type caches: +1 held here for the process lifetime (an atexit
 * teardown releases them so the RC audit stays clean). 'default' also
 * keeps the concatenated PEM buffer scr_tls.c parses into anchors. */
static ScrArr *scr_ca_bundled = NULL;
static ScrArr *scr_ca_system = NULL;
static ScrArr *scr_ca_extra = NULL;
static ScrArr *scr_ca_default = NULL;
static char *scr_ca_extra_buf = NULL;
static size_t scr_ca_extra_len = 0;
static bool scr_ca_installed = false;
static char *scr_ca_override_buf = NULL;
static size_t scr_ca_override_len = 0;
static uint64_t scr_ca_override_gen = 0; /* 0 = never set */

static void scr_ca_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void scr_ca_teardown(void) {
  if (scr_ca_bundled != NULL) scr_arr_release(scr_ca_bundled);
  if (scr_ca_system != NULL) scr_arr_release(scr_ca_system);
  if (scr_ca_extra != NULL) scr_arr_release(scr_ca_extra);
  if (scr_ca_default != NULL) scr_arr_release(scr_ca_default);
  scr_ca_bundled = scr_ca_system = scr_ca_extra = scr_ca_default = NULL;
  free(scr_ca_extra_buf);
  scr_ca_extra_buf = NULL;
  scr_ca_extra_len = 0;
  free(scr_ca_override_buf);
  scr_ca_override_buf = NULL;
}

static bool scr_ca_teardown_armed = false;

static void scr_ca_arm_teardown(void) {
  if (!scr_ca_teardown_armed) {
    scr_ca_teardown_armed = true;
    atexit(scr_ca_teardown);
  }
}

/* Portable bounded substring search (memmem is GNU/BSD-only; win32 has
 * neither). Needles here are short constant markers — the naive scan is
 * plenty. */
static const char *scr_ca_find(const char *hay, size_t hay_len, const char *needle, size_t needle_len) {
  if (needle_len == 0 || hay_len < needle_len) return NULL;
  for (size_t i = 0; i + needle_len <= hay_len; i++) {
    if (hay[i] == needle[0] && memcmp(hay + i, needle, needle_len) == 0) return hay + i;
  }
  return NULL;
}

/* Every "-----BEGIN CERTIFICATE-----" ... "-----END CERTIFICATE-----"
 * block of `text` (other PEM kinds — keys, CRLs — skip, like Node's CA
 * loaders), pushed onto `arr` as one string each, END line included.
 * Returns the number of blocks found. */
static size_t scr_ca_push_pem_blocks(ScrArr *arr, const char *text, size_t len) {
  static const char BEGIN[] = "-----BEGIN CERTIFICATE-----";
  static const char END[] = "-----END CERTIFICATE-----";
  size_t found = 0;
  const char *p = text;
  const char *limit = text + len;
  while (p < limit) {
    const char *b = scr_ca_find(p, (size_t)(limit - p), BEGIN, sizeof BEGIN - 1);
    if (b == NULL) break;
    const char *e = scr_ca_find(b, (size_t)(limit - b), END, sizeof END - 1);
    if (e == NULL) break;
    const char *stop = e + (sizeof END - 1);
    /* Node's entries carry the block's trailing newline when the source
     * had one — keep it so round-trips through writeFileSync + parse
     * stay concatenation-safe. */
    if (stop < limit && *stop == '\r') stop++;
    if (stop < limit && *stop == '\n') stop++;
    scr_arr_push_ref(arr, scr_str_new(b, (size_t)(stop - b)));
    found++;
    p = stop;
  }
  return found;
}

/* One whole file, malloc'd (NULL on any failure — absent bundles answer
 * empty stores, the same silence Node has on hosts without the file). */
static char *scr_ca_read_file(const char *path, size_t *out_len) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) return NULL;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return NULL;
  }
  long sz = ftell(f);
  if (sz < 0) {
    fclose(f);
    return NULL;
  }
  rewind(f);
  char *buf = malloc((size_t)sz + 1);
  if (buf == NULL) scr_ca_oom();
  size_t got = fread(buf, 1, (size_t)sz, f);
  fclose(f);
  buf[got] = '\0';
  *out_len = got;
  return buf;
}

/*
 * Node consumes NODE_EXTRA_CA_CERTS while the process is initialized:
 * changing process.env or replacing the referenced file later does not
 * alter either TLS trust or getCACertificates("extra"). Generated main
 * calls this install hook before user code; the lazy fallback only serves
 * library/direct-runtime callers that have no executable startup hook.
 */
void scr_tls_ca_install(void) {
  if (scr_ca_installed) return;
  scr_ca_installed = true;
  scr_ca_arm_teardown();
  const char *path = getenv("NODE_EXTRA_CA_CERTS");
  if (path != NULL && path[0] != '\0') {
    scr_ca_extra_buf = scr_ca_read_file(path, &scr_ca_extra_len);
  }
}

bool scr_tls_ca_extra_pem(const char **pem, size_t *len) {
  scr_tls_ca_install();
  if (scr_ca_extra_buf == NULL) return false;
  *pem = scr_ca_extra_buf;
  *len = scr_ca_extra_len;
  return true;
}

#ifdef _WIN32
/* Windows can restrict a certificate's purposes in a store property that is
 * not part of its DER. CertGetEnhancedKeyUsage with flags 0 intersects that
 * property with the encoded EKU extension. An empty result means either all
 * purposes (CRYPT_E_NOT_FOUND) or no purposes (ERROR_SUCCESS); every other
 * API failure is fail-closed too. */
bool scr_tls_ca_windows_cert_server_auth(const void *cert_context) {
  PCCERT_CONTEXT cert = (PCCERT_CONTEXT)cert_context;
  DWORD usage_len = 0;
  if (!CertGetEnhancedKeyUsage(cert, 0, NULL, &usage_len) || usage_len == 0) {
    return false;
  }
  CERT_ENHKEY_USAGE *usage = malloc((size_t)usage_len);
  if (usage == NULL) scr_ca_oom();
  if (!CertGetEnhancedKeyUsage(cert, 0, usage, &usage_len)) {
    free(usage);
    return false;
  }
  DWORD usage_error = GetLastError();
  bool allowed = usage->cUsageIdentifier == 0 &&
      usage_error == CRYPT_E_NOT_FOUND;
  for (DWORD i = 0; !allowed && usage->rgpszUsageIdentifier != NULL &&
       i < usage->cUsageIdentifier; i++) {
    const char *oid = usage->rgpszUsageIdentifier[i];
    allowed = oid != NULL &&
        (strcmp(oid, szOID_PKIX_KP_SERVER_AUTH) == 0 ||
         strcmp(oid, szOID_ANY_ENHANCED_KEY_USAGE) == 0);
  }
  free(usage);
  return allowed;
}

static void scr_tls_ca_windows_roots_at(
    DWORD location, ScrTlsCaWindowsRootFn fn, void *ctx) {
  HCERTSTORE store = CertOpenStore(
      CERT_STORE_PROV_SYSTEM_A, 0, 0,
      location | CERT_STORE_OPEN_EXISTING_FLAG | CERT_STORE_READONLY_FLAG,
      "ROOT");
  if (store == NULL) return;
  PCCERT_CONTEXT cert = NULL;
  /* CertEnumCertificatesInStore frees the previous context on every call,
   * including the final NULL result. Each callback must copy DER it keeps. */
  while ((cert = CertEnumCertificatesInStore(store, cert)) != NULL) {
    if (scr_tls_ca_windows_cert_server_auth(cert)) {
      fn(ctx, cert->pbCertEncoded, (size_t)cert->cbCertEncoded);
    }
  }
  (void)CertCloseStore(store, 0);
}

void scr_tls_ca_windows_roots(ScrTlsCaWindowsRootFn fn, void *ctx) {
  /* Windows keeps policy and enterprise roots in distinct store locations;
   * the ordinary current-user ROOT collection does not include the
   * current-user Group Policy store. Match Node's ROOT-location coverage so
   * organization-managed roots reach both TLS verification and CA-store
   * introspection. Duplicate entries are harmless and match Node's gather. */
  static const DWORD locations[] = {
      CERT_SYSTEM_STORE_LOCAL_MACHINE,
      CERT_SYSTEM_STORE_LOCAL_MACHINE_GROUP_POLICY,
      CERT_SYSTEM_STORE_LOCAL_MACHINE_ENTERPRISE,
      CERT_SYSTEM_STORE_CURRENT_USER,
      CERT_SYSTEM_STORE_CURRENT_USER_GROUP_POLICY,
  };
  for (size_t i = 0; i < sizeof locations / sizeof locations[0]; i++) {
    scr_tls_ca_windows_roots_at(locations[i], fn, ctx);
  }
}

static void scr_ca_push_windows_root(void *ctx, const unsigned char *der, size_t len) {
  if (len > UINT32_MAX) return;
  DWORD pem_cap = 0;
  DWORD flags = CRYPT_STRING_BASE64HEADER | CRYPT_STRING_NOCR;
  if (!CryptBinaryToStringA(der, (DWORD)len, flags, NULL, &pem_cap) ||
      pem_cap == 0) {
    return;
  }
  char *pem = malloc((size_t)pem_cap);
  if (pem == NULL) scr_ca_oom();
  DWORD pem_len = pem_cap;
  if (CryptBinaryToStringA(der, (DWORD)len, flags, pem, &pem_len)) {
    scr_arr_push_ref((ScrArr *)ctx, scr_str_new(pem, (size_t)pem_len));
  }
  free(pem);
}
#endif

/* The host roots, from the Windows logical store or the POSIX bundle probe
 * shared with scr_tls.c. */
static ScrArr *scr_ca_load_host_bundle(void) {
  ScrArr *arr = scr_arr_new(SCR_ELEM_STR, 128);
#ifdef _WIN32
  scr_tls_ca_windows_roots(scr_ca_push_windows_root, arr);
#else
  static const char *const bundles[] = {
      "/etc/ssl/cert.pem",                  /* macOS, Alpine */
      "/etc/ssl/certs/ca-certificates.crt", /* Debian/Ubuntu */
      "/etc/pki/tls/certs/ca-bundle.crt",   /* Fedora/RHEL */
      "/etc/ssl/ca-bundle.pem",             /* openSUSE */
  };
  for (size_t i = 0; i < sizeof bundles / sizeof bundles[0]; i++) {
    size_t len = 0;
    char *text = scr_ca_read_file(bundles[i], &len);
    if (text == NULL) continue;
    scr_ca_push_pem_blocks(arr, text, len);
    free(text);
    break; /* first bundle wins, like the anchor probe */
  }
#endif
  return arr;
}

static ScrArr *scr_ca_bundled_arr(void) {
  if (scr_ca_bundled == NULL) {
    scr_ca_arm_teardown();
    scr_ca_bundled = scr_ca_load_host_bundle();
  }
  return scr_ca_bundled;
}

static ScrArr *scr_ca_system_arr(void) {
  if (scr_ca_system == NULL) {
    scr_ca_arm_teardown();
    scr_ca_system = scr_ca_load_host_bundle();
  }
  return scr_ca_system;
}

static ScrArr *scr_ca_extra_arr(void) {
  if (scr_ca_extra == NULL) {
    scr_ca_arm_teardown();
    scr_ca_extra = scr_arr_new(SCR_ELEM_STR, 4);
    const char *pem = NULL;
    size_t len = 0;
    if (scr_tls_ca_extra_pem(&pem, &len)) {
      scr_ca_push_pem_blocks(scr_ca_extra, pem, len);
    }
  }
  return scr_ca_extra;
}

/* 'default' with no override: bundled ∪ extra (Node's own composition
 * when no --use-*-ca flag redirects it). */
static ScrArr *scr_ca_default_arr(void) {
  if (scr_ca_default == NULL) {
    scr_ca_arm_teardown();
    ScrArr *bundled = scr_ca_bundled_arr();
    ScrArr *extra = scr_ca_extra_arr();
    size_t nb = (size_t)scr_arr_len(bundled);
    size_t ne = (size_t)scr_arr_len(extra);
    scr_ca_default = scr_arr_new(SCR_ELEM_STR, nb + ne > 0 ? nb + ne : 1);
    for (size_t i = 0; i < nb; i++) scr_arr_push_ref(scr_ca_default, scr_arr_get_ref(bundled, (double)i));
    for (size_t i = 0; i < ne; i++) scr_arr_push_ref(scr_ca_default, scr_arr_get_ref(extra, (double)i));
  }
  return scr_ca_default;
}

ScrArr *scr_tls_ca_get(ScrStr *type) {
  ScrArr *arr = NULL;
  if (strcmp(type->data, "default") == 0) arr = scr_ca_default_arr();
  else if (strcmp(type->data, "bundled") == 0) arr = scr_ca_bundled_arr();
  else if (strcmp(type->data, "system") == 0) arr = scr_ca_system_arr();
  else if (strcmp(type->data, "extra") == 0) arr = scr_ca_extra_arr();
  if (arr == NULL) {
    /* Node's ERR_INVALID_ARG_VALUE TypeError, message-exact. */
    char msg[256];
    int n = snprintf(msg, sizeof msg, "The argument 'type' is invalid. Received '%s'", type->data);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, n < 0 ? 0 : (size_t)n, "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  return scr_arr_retain(arr);
}

ScrArr *scr_tls_ca_root(void) { return scr_arr_retain(scr_ca_bundled_arr()); }

void scr_tls_ca_set_default(ScrArr *certs) {
  size_t n = (size_t)scr_arr_len(certs);
  /* Extract + dedupe first — a throw must leave the current set intact
   * (Node's own error contract, pinned by the suite's error test). */
  ScrArr *next = scr_arr_new(SCR_ELEM_STR, n > 0 ? n : 1);
  size_t blocks = 0;
  for (size_t i = 0; i < n; i++) {
    ScrStr *entry = scr_arr_get_ref(certs, (double)i); /* +1 */
    size_t before = (size_t)scr_arr_len(next);
    blocks += scr_ca_push_pem_blocks(next, entry->data, entry->len);
    /* Dedupe the freshly pushed blocks against everything before them. */
    size_t after = (size_t)scr_arr_len(next);
    for (size_t j = after; j > before; j--) {
      ScrStr *cand = scr_arr_get_ref(next, (double)(j - 1)); /* +1 */
      bool dup = false;
      for (size_t k = 0; k + 1 < j && !dup; k++) {
        ScrStr *prev = scr_arr_get_ref(next, (double)k); /* +1 */
        dup = prev->len == cand->len && memcmp(prev->data, cand->data, cand->len) == 0;
        scr_str_release(prev);
      }
      scr_str_release(cand);
      if (dup) {
        /* Drop the duplicate: rebuild without index j-1 (rare path —
         * a simple splice via slice would copy anyway; do it in place). */
        ScrArr *trimmed = scr_arr_new(SCR_ELEM_STR, after);
        for (size_t k = 0; k < (size_t)scr_arr_len(next); k++) {
          if (k == j - 1) continue;
          scr_arr_push_ref(trimmed, scr_arr_get_ref(next, (double)k));
        }
        scr_arr_release(next);
        next = trimmed;
      }
    }
    scr_str_release(entry);
  }
  if (n > 0 && blocks == 0) {
    scr_arr_release(next);
    static const char MSG[] = "No valid certificates found in the provided array";
    scr_throw_error_msg_code(SCR_ERR_ERROR, MSG, sizeof MSG - 1, "ERR_CRYPTO_OPERATION_FAILED");
    return;
  }
  /* Commit: the cached 'default' array and the concatenated anchor
   * buffer scr_tls.c parses (NUL-terminated for mbedTLS's PEM mode). */
  scr_ca_arm_teardown();
  if (scr_ca_default != NULL) scr_arr_release(scr_ca_default);
  scr_ca_default = next;
  size_t total = 0;
  size_t count = (size_t)scr_arr_len(next);
  for (size_t i = 0; i < count; i++) {
    ScrStr *s = scr_arr_get_ref(next, (double)i);
    total += s->len;
    scr_str_release(s);
  }
  char *buf = malloc(total + 1);
  if (buf == NULL) scr_ca_oom();
  size_t off = 0;
  for (size_t i = 0; i < count; i++) {
    ScrStr *s = scr_arr_get_ref(next, (double)i);
    memcpy(buf + off, s->data, s->len);
    off += s->len;
    scr_str_release(s);
  }
  buf[off] = '\0';
  free(scr_ca_override_buf);
  scr_ca_override_buf = buf;
  scr_ca_override_len = off;
  scr_ca_override_gen++;
}

bool scr_tls_ca_default_override(const char **pem, size_t *len, uint64_t *gen) {
  if (scr_ca_override_gen == 0) return false;
  *pem = scr_ca_override_buf;
  *len = scr_ca_override_len;
  *gen = scr_ca_override_gen;
  return true;
}
