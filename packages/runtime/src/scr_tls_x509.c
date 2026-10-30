/* tlsSocket.getPeerCertificate([detailed]) and getCertificate(): Node's
 * legacy certificate objects, built by scr_x509.c's toLegacyObject over
 * the certificates scr_tls.c keeps. Linked into programs that use both
 * units, so neither unit depends on the other. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

/* The peer chain entries read; a longer chain is cut, as no real chain is
 * this long. */
enum { SCR_TLS_X509_MAX_CHAIN = 16 };

static ScrBytes *scr_tls_x509_bytes(const uint8_t *der, size_t len) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (len) memcpy(b->data, der, len);
  return b;
}

static bool scr_tls_x509_same(const ScrBytes *a, const ScrBytes *b) {
  return a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
}

/* tlsSocket.getCertificate(): the certificate the socket serves, {}
 * without one, null once the socket is destroyed. +1. */
ScrDyn *scr_tls_sock_get_certificate(ScrNetSocket *s) {
  if (!scr_tls_sock_has_handle(s)) return scr_dyn_new_null();
  size_t len = 0;
  const uint8_t *der = scr_tls_sock_own_cert(s, &len);
  if (der == NULL) return scr_dyn_new_obj();
  ScrBytes *cert = scr_tls_x509_bytes(der, len);
  ScrDyn *result = scr_crypto_x509_legacy_object(cert);
  scr_bytes_release(cert);
  return result;
}

typedef struct {
  ScrBytes *subject; /* borrowed */
  ScrBytes *found;   /* +1, NULL until found */
} ScrTlsX509Lookup;

/* SSL_CTX_get_issuer: the first trust anchor that issued the subject. */
static bool scr_tls_x509_issuer_visit(void *ctx, const uint8_t *der, size_t len) {
  ScrTlsX509Lookup *lookup = ctx;
  ScrBytes *candidate = scr_tls_x509_bytes(der, len);
  if (scr_crypto_x509_check_issued(lookup->subject, candidate)) {
    lookup->found = candidate;
    return true;
  }
  scr_bytes_release(candidate);
  return false;
}

/* Sets `chain`'s issuerCertificate to the legacy object of `issuer`
 * (borrowed) and answers that object (borrowed; `chain` holds it). */
static ScrDyn *scr_tls_x509_link(ScrDyn *chain, ScrBytes *issuer) {
  ScrDyn *object = scr_crypto_x509_legacy_object(issuer);
  scr_dyn_obj_set(chain, "issuerCertificate", 17, object);
  return object;
}

/* tlsSocket.getPeerCertificate([detailed]): the peer's certificate, {}
 * before the handshake or without one, null once the socket is destroyed.
 * With `detailed`, issuerCertificate links each certificate to its issuer
 * as Node's GetPeerCert does: first from the certificates the peer sent,
 * in their order of issue, then from the trust anchors; a self-issued
 * last certificate is its own issuerCertificate. +1. */
ScrDyn *scr_tls_sock_get_peer_certificate(ScrNetSocket *s, const ScrDyn *detailed_arg) {
  /* Node reads the argument with IsTrue(): only true itself. */
  bool detailed = detailed_arg->kind == SCR_DYN_BOOL && detailed_arg->v.b;
  if (!scr_tls_sock_has_handle(s)) return scr_dyn_new_null();
  const uint8_t *der[SCR_TLS_X509_MAX_CHAIN];
  size_t len[SCR_TLS_X509_MAX_CHAIN];
  size_t n = scr_tls_sock_peer_chain(s, der, len, SCR_TLS_X509_MAX_CHAIN);
  if (n == 0) return scr_dyn_new_obj();
  ScrBytes *cert = scr_tls_x509_bytes(der[0], len[0]);
  ScrDyn *result = scr_crypto_x509_legacy_object(cert);
  if (!detailed) {
    scr_bytes_release(cert);
    return result;
  }
  ScrBytes *pool[SCR_TLS_X509_MAX_CHAIN];
  size_t pooled = 0;
  for (size_t i = 1; i < n; i++) pool[pooled++] = scr_tls_x509_bytes(der[i], len[i]);
  ScrDyn *chain = result;
  /* AddIssuerChainToObject: take the issuer out of the peer's list, and
   * stop when none issued the current certificate or the issuer taken was
   * the list's last entry. */
  for (;;) {
    size_t i;
    for (i = 0; i < pooled; i++) {
      if (!scr_crypto_x509_check_issued(cert, pool[i])) continue;
      chain = scr_tls_x509_link(chain, pool[i]);
      scr_bytes_release(cert);
      cert = pool[i];
      memmove(pool + i, pool + i + 1, (pooled - i - 1) * sizeof pool[0]);
      pooled--;
      break;
    }
    if (i == pooled) break;
  }
  for (size_t i = 0; i < pooled; i++) scr_bytes_release(pool[i]);
  /* GetLastIssuedCert: then the trust anchors, until a self-issued one
   * (bounded, for anchors that issued each other). */
  for (size_t step = 0; step < SCR_TLS_X509_MAX_CHAIN && !scr_crypto_x509_check_issued(cert, cert); step++) {
    ScrTlsX509Lookup lookup = {cert, NULL};
    scr_tls_sock_each_trusted(s, scr_tls_x509_issuer_visit, &lookup);
    if (lookup.found == NULL) break;
    chain = scr_tls_x509_link(chain, lookup.found);
    bool same = scr_tls_x509_same(cert, lookup.found);
    scr_bytes_release(cert);
    cert = lookup.found;
    if (same) break;
  }
  if (scr_crypto_x509_check_issued(cert, cert))
    scr_dyn_obj_set(chain, "issuerCertificate", 17, scr_dyn_retain(chain));
  scr_bytes_release(cert);
  return result;
}
