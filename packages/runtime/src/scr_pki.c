/* node:crypto asymmetric keys and signatures over the vendored mbedTLS
 * public-key layer: createPrivateKey, createPublicKey, generateKeyPairSync
 * and generateKeyPair for "rsa", "rsa-pss", "ec", "ed25519" and "x25519"
 * keys, crypto.diffieHellman (ECDH and X25519), the PrivateKeyObject and
 * PublicKeyObject handles (type, asymmetricKeyType,
 * asymmetricKeyDetails, export(), equals()), crypto.sign and crypto.verify,
 * and the Sign and Verify objects of createSign and createVerify. Keys read
 * and write PEM and DER as PKCS#1, SEC1, PKCS#8 and SubjectPublicKeyInfo,
 * JWK, and the raw-public and raw-private encodings; the EC curves are
 * prime256v1, secp384r1, secp521r1 and secp256k1, and the Ed25519
 * arithmetic is scr_ed25519.c. Argument checks
 * and errors follow Node 24's lib/internal/crypto/keys.js, keygen.js and
 * sig.js. Private keys export and import encrypted as PBES2 PKCS#8 and as
 * traditional PEM. Other key types throw a coded SC2020 error.
 * All arguments are borrowed. */
#include "scr_runtime.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/asn1.h"
#include "mbedtls/asn1write.h"
#include "mbedtls/base64.h"
#include "mbedtls/cipher.h"
#include "mbedtls/bignum.h"
#include "mbedtls/ecdh.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/ecp.h"
#include "mbedtls/md.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/pkcs5.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/rsa.h"
#include "mbedtls/x509_crt.h"

#include "scr_pki.h"
#include "scr_cipher_names.h"

/* ── errors ───────────────────────────────────────────────────────────── */

/* Set while a callback-style operation runs: Node hands its job callbacks
 * the OpenSSL error without the library, reason and code properties. */
static SCR_TL bool sp_job_error = false;

static void sp_throw(int kind, const char *code, const char *message) {
  /* A crypto job's callback gets the error without its code property. */
  if (code && !sp_job_error) scr_throw_error_msg_code(kind, message, strlen(message), code);
  else scr_throw_error_msg(kind, message, strlen(message));
}

/* An OpenSSL error as Node's ThrowCryptoError reports it,
 * "error:<packed>:<library>::<reason>", with own library, reason and code
 * properties in Node's key order. A crypto job's callback gets the error
 * without them, as from Node's async jobs. */
static void sp_throw_openssl(const char *packed, const char *library, const char *reason, const char *code,
                             bool props) {
  char message[160];
  snprintf(message, sizeof message, "error:%s:%s::%s", packed, library, reason);
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  if (props && !sp_job_error) {
    const char *keys[] = {"library", "reason", "code"};
    const char *values[] = {library, reason, code};
    for (size_t i = 0; i < 3; i++) {
      if (i == 2) scr_error_set_code(e, code);
      ScrStr *value = scr_str_new(values[i], strlen(values[i]));
      scr_error_set_prop(e, keys[i], strlen(keys[i]), scr_dyn_new_str(value));
      scr_str_release(value);
    }
  }
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

void scr_pki_throw_fmt(int kind, const char *code, const char *fmt, ...) {
  va_list ap, sized;
  va_start(ap, fmt);
  va_copy(sized, ap);
  int n = vsnprintf(NULL, 0, fmt, sized);
  va_end(sized);
  if (n < 0) n = 0;
  char *message = malloc((size_t)n + 1);
  if (!message) scr_trap("scriptc: out of memory\n");
  vsnprintf(message, (size_t)n + 1, fmt, ap);
  va_end(ap);
  if (code && !sp_job_error) scr_throw_error_msg_code(kind, message, (size_t)n, code);
  else scr_throw_error_msg(kind, message, (size_t)n);
  free(message);
}

/* The "Received" text of Node's ERR_INVALID_ARG_VALUE and ERR_OUT_OF_RANGE
 * messages: a string as util.inspect quotes it (cut at 128 UTF-16 units
 * plus "..."), a number as ERR_OUT_OF_RANGE prints it when `range`, any
 * other value as its sketch. +1. */
static ScrStr *sp_received(const ScrDyn *got, bool range) {
  if (got->kind == SCR_DYN_STR) return scr_str_inspect_quoted(got->v.str, true);
  char text[96];
  if (range && got->kind == SCR_DYN_NUM) return scr_str_new(text, scr_num_received(got->v.num, text));
  const char *lite = scr_dyn_inspect_lite(got, text, sizeof text);
  return scr_str_new(lite, strlen(lite));
}

/* Node's normalizeEncoding: the canonical name, or NULL. */
static const char *sp_normalize_encoding(const ScrStr *name) {
  static const struct {
    const char *from;
    const char *to;
  } map[] = {
      {"utf8", "utf8"},       {"utf-8", "utf8"},          {"hex", "hex"},
      {"base64", "base64"},   {"base64url", "base64url"}, {"latin1", "latin1"},
      {"binary", "latin1"},   {"ascii", "ascii"},         {"utf16le", "utf16le"},
      {"utf-16le", "utf16le"}, {"ucs2", "utf16le"},       {"ucs-2", "utf16le"},
  };
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
    size_t from_len = strlen(map[i].from);
    if (name->len != from_len) continue;
    bool same = true;
    for (size_t j = 0; same && j < from_len; j++) {
      char c = name->data[j];
      if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
      same = c == map[i].from[j];
    }
    if (same) return map[i].to;
  }
  return NULL;
}

/* ERR_INVALID_ARG_VALUE for an option ("The property 'options.type' is
 * invalid. Received 'spki'"), with another reason than "is invalid". */
static void sp_property_invalid_because(const char *name, const ScrDyn *got, const char *reason) {
  ScrStr *received = sp_received(got, false);
  scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", "The property '%s' %s. Received %.*s", name, reason,
                    (int)received->len, received->data);
  scr_str_release(received);
}

static void sp_property_invalid(const char *name, const ScrDyn *got) {
  sp_property_invalid_because(name, got, "is invalid");
}

/* ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS ("The selected key encoding pkcs1
 * can only be used for RSA keys."). */
static void sp_incompatible(const char *encoding, const char *reason) {
  scr_pki_throw_fmt(SCR_ERR_ERROR, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding %s %s.", encoding,
                    reason);
}

static void sp_unsupported_input(void) {
  sp_throw(SCR_ERR_ERROR, "ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported");
}

/* The coded refusal for a form this runtime does not implement. */
static void sp_not_supported(const char *what) {
  scr_pki_throw_fmt(SCR_ERR_ERROR, "SC2020", "'%s' is part of the standard library types but has no scriptc lowering yet",
                    what);
}

static int sp_random(void *state, unsigned char *out, size_t len) {
  (void)state;
  arc4random_buf(out, len);
  return 0;
}

/* ── Ed25519 ──────────────────────────────────────────────────────────
 * The arithmetic is scr_ed25519.c, which links only into programs that
 * name Ed25519 and installs itself here at startup. Keys are the 32-byte
 * seed and the 32-byte encoded public point. */
const ScrPkiEd25519 *scr_pki_ed25519 = NULL;

/* The Ed25519 arithmetic, or NULL with a coded SC2020 error pending. */
static const ScrPkiEd25519 *sp_ed(void) {
  if (!scr_pki_ed25519)
    sp_throw(SCR_ERR_ERROR, "SC2020",
             "Ed25519 keys are supported when a string literal in the program names 'ed25519'");
  return scr_pki_ed25519;
}

bool scr_pki_ed25519_ready(void) { return sp_ed() != NULL; }

static bool sp_ed_verify(const ScrPkiEd25519 *ed, const uint8_t pub[32], const uint8_t *m, size_t n,
                         const uint8_t *sig, size_t sig_len) {
  return sig_len == 64 && ed->verify(pub, m, n, sig);
}

/* ── option bags ──────────────────────────────────────────────────────── */

static bool sp_is_object(const ScrDyn *v) { return v != NULL && v->kind == SCR_DYN_OBJ; }

/* A statically typed object argument (a record or class instance) as a
 * plain object: +1, or NULL with the error pending. Other values are
 * retained as they are. */
static ScrDyn *sp_plain(const ScrDyn *v) {
  if (v != NULL && v->kind == SCR_DYN_TYPED_REF) return scr_dyn_typed_ref_materialize(v);
  return scr_dyn_retain((ScrDyn *)(v ? v : scr_dyn_undefined()));
}

/* A borrowed option, or the undefined singleton. */
static const ScrDyn *sp_opt(const ScrDyn *obj, const char *key) {
  const ScrDyn *v = sp_is_object(obj) ? scr_dyn_obj_get(obj, key, strlen(key)) : NULL;
  return v ? v : scr_dyn_undefined();
}

static bool sp_is_str(const ScrDyn *v, const char *text) {
  size_t n = strlen(text);
  return v->kind == SCR_DYN_STR && v->v.str->len == n && memcmp(v->v.str->data, text, n) == 0;
}

static bool sp_absent(const ScrDyn *v) { return v->kind == SCR_DYN_UNDEF; }

/* ── keys ─────────────────────────────────────────────────────────────── */

typedef struct SpKey {
  size_t rc;
  mbedtls_pk_context pk; /* RSA and EC keys */
  bool private_key;
  bool ed25519; /* an Ed25519 key: ed_seed (private keys) and ed_pub */
  bool x25519;  /* an X25519 key, in the same two fields: the private key's
                 * bytes as given, before clamping, and the public key */
  uint8_t ed_seed[32];
  uint8_t ed_pub[32];
  /* An RSA-PSS key (id-RSASSA-PSS): signatures only, with PSS padding.
   * With RSASSA-PSS-params it signs only with pss_md and MGF1 over
   * pss_mgf1, and salts of at least pss_salt bytes. */
  bool rsa_pss;
  bool pss_params;
  mbedtls_md_type_t pss_md, pss_mgf1;
  int pss_salt;
} SpKey;

static void *sp_key_retain(void *h) {
  SpKey *k = h;
  if (k->rc != SIZE_MAX) k->rc++;
  return h;
}

static void sp_key_release(void *h) {
  SpKey *k = h;
  if (!k || k->rc == SIZE_MAX || --k->rc != 0) return;
  mbedtls_pk_free(&k->pk);
  mbedtls_platform_zeroize(k, sizeof *k);
  free(k);
}

static SpKey *sp_key_alloc(bool private_key) {
  SpKey *k = calloc(1, sizeof *k);
  if (!k) scr_trap("scriptc: out of memory\n");
  k->rc = 1;
  k->private_key = private_key;
  mbedtls_pk_init(&k->pk);
  return k;
}

static void sp_key_install(void);

/* Boxes the key (consuming the caller's reference). */
static ScrDyn *sp_key_box(SpKey *k) {
  sp_key_install();
  ScrDyn *box = scr_dyn_new_handle(k, k->private_key ? SCR_DYNH_PRIVATE_KEY : SCR_DYNH_PUBLIC_KEY);
  sp_key_release(k);
  return box;
}

static SpKey *sp_key_of(const ScrDyn *v) {
  if (v == NULL || v->kind != SCR_DYN_HANDLE) return NULL;
  if (v->v.handle.tag != SCR_DYNH_PRIVATE_KEY && v->v.handle.tag != SCR_DYNH_PUBLIC_KEY) return NULL;
  return v->v.handle.ptr;
}

bool scr_crypto_is_asymmetric_key(const ScrDyn *value) { return sp_key_of(value) != NULL; }

/* The type getter of a KeyObject value: "private", "public", or NULL for
 * anything else. */
const char *scr_crypto_asymmetric_key_type(const ScrDyn *value) {
  SpKey *k = sp_key_of(value);
  return k ? (k->private_key ? "private" : "public") : NULL;
}

static bool sp_is_rsa(const SpKey *k) { return mbedtls_pk_get_type(&k->pk) == MBEDTLS_PK_RSA; }

static bool sp_is_ec(const SpKey *k) { return mbedtls_pk_get_type(&k->pk) == MBEDTLS_PK_ECKEY; }

static bool sp_is_ed(const SpKey *k) { return k->ed25519; }

static bool sp_is_x(const SpKey *k) { return k->x25519; }

/* The PSS fields of `from` on `to`. */
static void sp_pss_copy(SpKey *to, const SpKey *from) {
  to->rsa_pss = from->rsa_pss;
  to->pss_params = from->pss_params;
  to->pss_md = from->pss_md;
  to->pss_mgf1 = from->pss_mgf1;
  to->pss_salt = from->pss_salt;
}

/* Node's name for a digest RSASSA-PSS-params can name. */
static const char *sp_pss_md_name(mbedtls_md_type_t md) {
  switch (md) {
  case MBEDTLS_MD_SHA1: return "sha1";
  case MBEDTLS_MD_SHA224: return "sha224";
  case MBEDTLS_MD_SHA256: return "sha256";
  case MBEDTLS_MD_SHA384: return "sha384";
  case MBEDTLS_MD_SHA512: return "sha512";
  default: return NULL;
  }
}

/* An Ed25519 or X25519 key: 32-byte private and public keys, no details. */
static bool sp_is_okp(const SpKey *k) { return k->ed25519 || k->x25519; }

/* X25519(scalar, point) per RFC 7748 over mbedTLS's Curve25519 group, or
 * of the base point when point is NULL. False when the result is the
 * all-zero value (a small-order point), which OpenSSL refuses. */
static bool sp_x25519(const uint8_t scalar[32], const uint8_t *point, uint8_t out[32]) {
  mbedtls_ecp_group grp;
  mbedtls_ecp_point P, R;
  mbedtls_mpi d;
  mbedtls_ecp_group_init(&grp);
  mbedtls_ecp_point_init(&P);
  mbedtls_ecp_point_init(&R);
  mbedtls_mpi_init(&d);
  uint8_t k[32];
  memcpy(k, scalar, 32);
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;
  size_t n = 0;
  bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_CURVE25519) == 0 &&
            mbedtls_mpi_read_binary_le(&d, k, 32) == 0 &&
            (point ? mbedtls_ecp_point_read_binary(&grp, &P, point, 32) : mbedtls_ecp_copy(&P, &grp.G)) == 0 &&
            mbedtls_ecp_mul(&grp, &R, &d, &P, sp_random, NULL) == 0 &&
            mbedtls_ecp_point_write_binary(&grp, &R, MBEDTLS_ECP_PF_UNCOMPRESSED, &n, out, 32) == 0 && n == 32;
  uint8_t any = 0;
  for (size_t i = 0; ok && i < 32; i++) any |= out[i];
  mbedtls_platform_zeroize(k, sizeof k);
  mbedtls_mpi_free(&d);
  mbedtls_ecp_point_free(&R);
  mbedtls_ecp_point_free(&P);
  mbedtls_ecp_group_free(&grp);
  return ok && any != 0;
}

typedef struct {
  const char *name;  /* OpenSSL short name (namedCurve) */
  const char *nist;  /* EC_curve_nist2nid alias, or NULL */
  const char *jwk;   /* JWK crv */
  mbedtls_ecp_group_id id;
} SpCurve;

static const SpCurve sp_curves[] = {
    {"prime256v1", "P-256", "P-256", MBEDTLS_ECP_DP_SECP256R1},
    {"secp384r1", "P-384", "P-384", MBEDTLS_ECP_DP_SECP384R1},
    {"secp521r1", "P-521", "P-521", MBEDTLS_ECP_DP_SECP521R1},
    {"secp256k1", NULL, "secp256k1", MBEDTLS_ECP_DP_SECP256K1},
};

static const SpCurve *sp_curve_by_id(mbedtls_ecp_group_id id) {
  for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
    if (sp_curves[i].id == id) return &sp_curves[i];
  return NULL;
}

static const SpCurve *sp_curve_of(const SpKey *k) {
  return sp_is_ec(k) ? sp_curve_by_id(mbedtls_pk_ec(k->pk)->MBEDTLS_PRIVATE(grp).id) : NULL;
}

/* A parsed key is usable when it is RSA or EC on a curve above. */
static bool sp_key_supported(const SpKey *k) {
  return sp_is_okp(k) || sp_is_rsa(k) || (sp_is_ec(k) && sp_curve_of(k) != NULL);
}

/* ── DER writing ──────────────────────────────────────────────────────── */

/* mbedtls writes DER backwards into the end of a buffer; these helpers
 * answer the written length or a negative error. */
#define SP_DER_MAX 8192

static int sp_write_private_der(SpKey *k, unsigned char *buf, size_t size) {
  return mbedtls_pk_write_key_der(&k->pk, buf, size);
}

/* Ed25519's PKCS#8 and SubjectPublicKeyInfo prefixes (RFC 8410): the
 * 32-byte seed or public key follows. */
static const uint8_t sp_ed_pkcs8_prefix[16] = {0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
                                               0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20};
static const uint8_t sp_ed_spki_prefix[12] = {0x30, 0x2a, 0x30, 0x05, 0x06, 0x03,
                                              0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};
/* X25519's, which differ in the OID's last byte (1.3.101.110). */
static const uint8_t sp_x_pkcs8_prefix[16] = {0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
                                              0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20};
static const uint8_t sp_x_spki_prefix[12] = {0x30, 0x2a, 0x30, 0x05, 0x06, 0x03,
                                             0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00};

/* Writes prefix || 32 bytes at the end of buf, as the mbedtls writers do. */
static int sp_write_ed_der(const uint8_t *prefix, size_t prefix_len, const uint8_t key[32],
                           unsigned char *buf, size_t size) {
  size_t n = prefix_len + 32;
  if (size < n) return MBEDTLS_ERR_ASN1_BUF_TOO_SMALL;
  memcpy(buf + size - n, prefix, prefix_len);
  memcpy(buf + size - 32, key, 32);
  return (int)n;
}

/* A digest AlgorithmIdentifier with NULL parameters, written backwards
 * at *c; the written length or a negative error. */
static int sp_write_md_alg(unsigned char **c, unsigned char *start, mbedtls_md_type_t md) {
  const char *oid;
  size_t oid_len;
  int r, len = 0;
  if ((r = mbedtls_oid_get_oid_by_md(md, &oid, &oid_len)) != 0) return r;
  if ((r = mbedtls_asn1_write_null(c, start)) < 0) return r;
  len += r;
  if ((r = mbedtls_asn1_write_oid(c, start, oid, oid_len)) < 0) return r;
  len += r;
  if ((r = mbedtls_asn1_write_len(c, start, (size_t)len)) < 0) return r;
  len += r;
  if ((r = mbedtls_asn1_write_tag(c, start, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0) return r;
  return len + r;
}

/* An RSA-PSS key's AlgorithmIdentifier, as OpenSSL writes it: id-RSASSA-PSS
 * with no parameters for a key without restrictions, or RSASSA-PSS-params
 * omitting the fields at their defaults (SHA-1, MGF1 with SHA-1, salt 20). */
static int sp_write_pss_alg(unsigned char **c, unsigned char *start, const SpKey *k) {
  int r, len = 0;
  if (k->pss_params) {
    int params = 0;
    if (k->pss_salt != 20) {
      int field = 0;
      if ((r = mbedtls_asn1_write_int(c, start, k->pss_salt)) < 0) return r;
      field += r;
      if ((r = mbedtls_asn1_write_len(c, start, (size_t)field)) < 0) return r;
      field += r;
      if ((r = mbedtls_asn1_write_tag(c, start, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 2)) < 0)
        return r;
      params += field + r;
    }
    if (k->pss_mgf1 != MBEDTLS_MD_SHA1) {
      int field = 0;
      if ((r = sp_write_md_alg(c, start, k->pss_mgf1)) < 0) return r;
      field += r;
      if ((r = mbedtls_asn1_write_oid(c, start, MBEDTLS_OID_MGF1, MBEDTLS_OID_SIZE(MBEDTLS_OID_MGF1))) < 0)
        return r;
      field += r;
      if ((r = mbedtls_asn1_write_len(c, start, (size_t)field)) < 0) return r;
      field += r;
      if ((r = mbedtls_asn1_write_tag(c, start, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0) return r;
      field += r;
      if ((r = mbedtls_asn1_write_len(c, start, (size_t)field)) < 0) return r;
      field += r;
      if ((r = mbedtls_asn1_write_tag(c, start, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1)) < 0)
        return r;
      params += field + r;
    }
    if (k->pss_md != MBEDTLS_MD_SHA1) {
      int field = 0;
      if ((r = sp_write_md_alg(c, start, k->pss_md)) < 0) return r;
      field += r;
      if ((r = mbedtls_asn1_write_len(c, start, (size_t)field)) < 0) return r;
      field += r;
      if ((r = mbedtls_asn1_write_tag(c, start, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0)) < 0)
        return r;
      params += field + r;
    }
    if ((r = mbedtls_asn1_write_len(c, start, (size_t)params)) < 0) return r;
    params += r;
    if ((r = mbedtls_asn1_write_tag(c, start, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0) return r;
    len += params + r;
  }
  if ((r = mbedtls_asn1_write_oid(c, start, MBEDTLS_OID_RSASSA_PSS, MBEDTLS_OID_SIZE(MBEDTLS_OID_RSASSA_PSS))) < 0)
    return r;
  len += r;
  if ((r = mbedtls_asn1_write_len(c, start, (size_t)len)) < 0) return r;
  len += r;
  if ((r = mbedtls_asn1_write_tag(c, start, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0) return r;
  return len + r;
}

static int sp_write_pkcs1_public_der(SpKey *k, unsigned char *buf, size_t size);

static int sp_write_spki_der(SpKey *k, unsigned char *buf, size_t size) {
  if (sp_is_okp(k))
    return sp_write_ed_der(sp_is_x(k) ? sp_x_spki_prefix : sp_ed_spki_prefix, 12, k->ed_pub, buf, size);
  if (!k->rsa_pss) return mbedtls_pk_write_pubkey_der(&k->pk, buf, size);
  /* SubjectPublicKeyInfo ::= SEQUENCE { AlgorithmIdentifier, BIT STRING
   * RSAPublicKey } */
  unsigned char inner[SP_DER_MAX];
  int n = sp_write_pkcs1_public_der(k, inner, sizeof inner);
  if (n < 0) return n;
  unsigned char *c = buf + size;
  int r, len = 0;
  if ((r = mbedtls_asn1_write_bitstring(&c, buf, inner + sizeof inner - n, (size_t)n * 8)) < 0) return r;
  len += r;
  if ((r = sp_write_pss_alg(&c, buf, k)) < 0) return r;
  len += r;
  if ((r = mbedtls_asn1_write_len(&c, buf, (size_t)len)) < 0) return r;
  len += r;
  if ((r = mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0) return r;
  return len + r;
}

/* RSAPublicKey (PKCS#1) DER. */
static int sp_write_pkcs1_public_der(SpKey *k, unsigned char *buf, size_t size) {
  unsigned char *p = buf + size;
  return mbedtls_pk_write_pubkey(&p, buf, &k->pk);
}

/* PKCS#8 PrivateKeyInfo around the PKCS#1 or SEC1 key, as OpenSSL writes
 * it: version 0, the AlgorithmIdentifier (rsaEncryption with NULL
 * parameters, or id-ecPublicKey with the curve OID), and the inner key,
 * which for EC omits the parameters field. */
static int sp_write_pkcs8_der(SpKey *k, unsigned char *buf, size_t size) {
  if (sp_is_okp(k))
    return sp_write_ed_der(sp_is_x(k) ? sp_x_pkcs8_prefix : sp_ed_pkcs8_prefix, 16, k->ed_seed, buf, size);
  unsigned char inner[SP_DER_MAX];
  size_t inner_len;
  if (sp_is_rsa(k)) {
    int n = sp_write_private_der(k, inner, sizeof inner);
    if (n < 0) return n;
    inner_len = (size_t)n;
    memmove(inner, inner + sizeof inner - inner_len, inner_len);
  } else {
    /* ECPrivateKey ::= SEQUENCE { version 1, privateKey OCTET STRING,
     * [1] publicKey BIT STRING } */
    const mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
    unsigned char *c = inner + sizeof inner;
    size_t len = 0;
    int r;
    unsigned char point[160];
    size_t point_len;
    if ((r = mbedtls_ecp_point_write_binary(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q),
                                            MBEDTLS_ECP_PF_UNCOMPRESSED, &point_len, point,
                                            sizeof point)) != 0)
      return r;
    size_t pub_len = 0;
    if ((r = mbedtls_asn1_write_bitstring(&c, inner, point, point_len * 8)) < 0) return r;
    pub_len += (size_t)r;
    if ((r = mbedtls_asn1_write_len(&c, inner, pub_len)) < 0) return r;
    pub_len += (size_t)r;
    if ((r = mbedtls_asn1_write_tag(&c, inner, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1)) < 0)
      return r;
    pub_len += (size_t)r;
    len += pub_len;
    size_t d_len = (ec->MBEDTLS_PRIVATE(grp).nbits + 7) / 8;
    unsigned char d[72];
    if ((r = mbedtls_mpi_write_binary(&ec->MBEDTLS_PRIVATE(d), d, d_len)) != 0) return r;
    if ((r = mbedtls_asn1_write_octet_string(&c, inner, d, d_len)) < 0) return r;
    len += (size_t)r;
    mbedtls_platform_zeroize(d, sizeof d);
    if ((r = mbedtls_asn1_write_int(&c, inner, 1)) < 0) return r;
    len += (size_t)r;
    if ((r = mbedtls_asn1_write_len(&c, inner, len)) < 0) return r;
    len += (size_t)r;
    if ((r = mbedtls_asn1_write_tag(&c, inner, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0)
      return r;
    len += (size_t)r;
    inner_len = len;
    memmove(inner, c, inner_len);
  }
  unsigned char *c = buf + size;
  size_t len = 0;
  int r;
  if ((r = mbedtls_asn1_write_octet_string(&c, buf, inner, inner_len)) < 0) goto done;
  len += (size_t)r;
  {
    const char *oid;
    size_t oid_len;
    size_t alg_len = 0;
    if (k->rsa_pss) {
      if ((r = sp_write_pss_alg(&c, buf, k)) < 0) goto done;
      len += (size_t)r;
      goto version;
    }
    if (sp_is_rsa(k)) {
      if ((r = mbedtls_asn1_write_null(&c, buf)) < 0) goto done;
      alg_len += (size_t)r;
      oid = MBEDTLS_OID_PKCS1_RSA;
      oid_len = MBEDTLS_OID_SIZE(MBEDTLS_OID_PKCS1_RSA);
    } else {
      const char *curve_oid;
      size_t curve_oid_len;
      if ((r = mbedtls_oid_get_oid_by_ec_grp(mbedtls_pk_ec(k->pk)->MBEDTLS_PRIVATE(grp).id, &curve_oid,
                                             &curve_oid_len)) != 0)
        goto done;
      if ((r = mbedtls_asn1_write_oid(&c, buf, curve_oid, curve_oid_len)) < 0) goto done;
      alg_len += (size_t)r;
      oid = MBEDTLS_OID_EC_ALG_UNRESTRICTED;
      oid_len = MBEDTLS_OID_SIZE(MBEDTLS_OID_EC_ALG_UNRESTRICTED);
    }
    if ((r = mbedtls_asn1_write_oid(&c, buf, oid, oid_len)) < 0) goto done;
    alg_len += (size_t)r;
    if ((r = mbedtls_asn1_write_len(&c, buf, alg_len)) < 0) goto done;
    alg_len += (size_t)r;
    if ((r = mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0)
      goto done;
    alg_len += (size_t)r;
    len += alg_len;
  }
version:
  if ((r = mbedtls_asn1_write_int(&c, buf, 0)) < 0) goto done;
  len += (size_t)r;
  if ((r = mbedtls_asn1_write_len(&c, buf, len)) < 0) goto done;
  len += (size_t)r;
  if ((r = mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) < 0)
    goto done;
  len += (size_t)r;
  r = (int)len;
done:
  mbedtls_platform_zeroize(inner, sizeof inner);
  return r;
}

/* PEM armor with 64-character base64 lines and a final newline. */
static ScrStr *sp_pem(const char *label, const unsigned char *der, size_t len) {
  size_t b64_len = 0;
  mbedtls_base64_encode(NULL, 0, &b64_len, der, len);
  unsigned char *b64 = malloc(b64_len + 1);
  char *out = malloc(b64_len + b64_len / 64 + 2 * strlen(label) + 64);
  if (!b64 || !out) scr_trap("scriptc: out of memory\n");
  mbedtls_base64_encode(b64, b64_len + 1, &b64_len, der, len);
  size_t o = (size_t)sprintf(out, "-----BEGIN %s-----\n", label);
  for (size_t i = 0; i < b64_len; i += 64) {
    size_t n = b64_len - i < 64 ? b64_len - i : 64;
    memcpy(out + o, b64 + i, n);
    o += n;
    out[o++] = '\n';
  }
  o += (size_t)sprintf(out + o, "-----END %s-----\n", label);
  ScrStr *s = scr_str_new(out, o);
  mbedtls_platform_zeroize(b64, b64_len);
  mbedtls_platform_zeroize(out, o);
  free(b64);
  free(out);
  return s;
}

/* ── encrypted private keys ───────────────────────────────────────────
 * PKCS#8 EncryptedPrivateKeyInfo as OpenSSL 3 writes it (PBES2 with
 * PBKDF2-HMAC-SHA256 over a 16-byte salt and 2048 iterations), and the
 * traditional PEM encryption of PKCS#1 and SEC1 keys (Proc-Type and
 * DEK-Info headers, the key from EVP_BytesToKey with MD5), for the ciphers
 * below. Reading takes PBES2 with any HMAC-SHA PRF and these ciphers, and
 * traditional PEM with the CBC ciphers through mbedTLS. */

typedef struct {
  const char *name; /* OpenSSL's name */
  const char *pem;  /* its DEK-Info name */
  mbedtls_cipher_type_t type;
  const char *oid;
  size_t oid_len, key_len, iv_len;
  bool ecb;
  /* What OpenSSL does when PKCS#8 or traditional PEM encryption takes
   * the cipher, an SpKeyCipherError. */
  unsigned char pkcs8_error, traditional_error;
} SpKeyCipher;

typedef enum {
  SP_KC_OK, /* it encrypts */
  SP_KC_NO_OID,
  SP_KC_EVP_CIPHER,
  SP_KC_PARAMETER,
  SP_KC_INPUT_LENGTH,
  SP_KC_ZERO_CONTENT,
  SP_KC_OPERATION,
  SP_KC_PEM_CIPHER,
  SP_KC_UNSUPPORTED,
} SpKeyCipherError;

static const struct {
  const char *packed, *library, *reason, *code;
} sp_key_cipher_errors[] = {
  [SP_KC_NO_OID] = {"0680006C", "asn1 encoding routines", "cipher has no object identifier",
                    "ERR_OSSL_ASN1_CIPHER_HAS_NO_OBJECT_IDENTIFIER"},
  [SP_KC_EVP_CIPHER] = {"0300006B", "digital envelope routines", "unsupported cipher",
                        "ERR_OSSL_EVP_UNSUPPORTED_CIPHER"},
  [SP_KC_PARAMETER] = {"0300007A", "digital envelope routines", "cipher parameter error",
                       "ERR_OSSL_EVP_CIPHER_PARAMETER_ERROR"},
  [SP_KC_INPUT_LENGTH] = {"1C8000E6", "Provider routines", "invalid input length", "ERR_OSSL_INVALID_INPUT_LENGTH"},
  [SP_KC_ZERO_CONTENT] = {"068000DE", "asn1 encoding routines", "illegal zero content",
                          "ERR_OSSL_ASN1_ILLEGAL_ZERO_CONTENT"},
  [SP_KC_OPERATION] = {"1C800066", "Provider routines", "cipher operation failed",
                       "ERR_OSSL_CIPHER_OPERATION_FAILED"},
  [SP_KC_PEM_CIPHER] = {"04800071", "PEM routines", "unsupported cipher", "ERR_OSSL_PEM_UNSUPPORTED_CIPHER"},
  [SP_KC_UNSUPPORTED] = {"0308010C", "digital envelope routines", "unsupported", "ERR_OSSL_EVP_UNSUPPORTED"},
};

#define SP_AES_OID(last) "\x60\x86\x48\x01\x65\x03\x04\x01" last, 9
static const SpKeyCipher sp_key_ciphers[] = {
  {"aes-128-cbc", "AES-128-CBC", MBEDTLS_CIPHER_AES_128_CBC, SP_AES_OID("\x02"), 16, 16, false},
  {"aes-192-cbc", "AES-192-CBC", MBEDTLS_CIPHER_AES_192_CBC, SP_AES_OID("\x16"), 24, 16, false},
  {"aes-256-cbc", "AES-256-CBC", MBEDTLS_CIPHER_AES_256_CBC, SP_AES_OID("\x2a"), 32, 16, false},
  {"aes-128-ecb", "AES-128-ECB", MBEDTLS_CIPHER_AES_128_ECB, SP_AES_OID("\x01"), 16, 0, true, SP_KC_OK, SP_KC_PEM_CIPHER},
  {"aes-192-ecb", "AES-192-ECB", MBEDTLS_CIPHER_AES_192_ECB, SP_AES_OID("\x15"), 24, 0, true, SP_KC_OK, SP_KC_PEM_CIPHER},
  {"aes-256-ecb", "AES-256-ECB", MBEDTLS_CIPHER_AES_256_ECB, SP_AES_OID("\x29"), 32, 0, true, SP_KC_OK, SP_KC_PEM_CIPHER},
  {"des-ede3-cbc", "DES-EDE3-CBC", MBEDTLS_CIPHER_DES_EDE3_CBC, "\x2a\x86\x48\x86\xf7\x0d\x03\x07", 8, 24, 8, false},
};
static const struct {
  const char *alias, *name;
} sp_key_cipher_aliases[] = {
  {"aes128", "aes-128-cbc"}, {"aes192", "aes-192-cbc"}, {"aes256", "aes-256-cbc"}, {"des3", "des-ede3-cbc"},
};

/* The names OpenSSL 3.5 refuses to encrypt a private key with in one form
 * or both, from Node 24 (the legacy-provider names fail in both). Other
 * names Node knows encrypt there and are refused here. */
#define SP_KC_FAIL(name, pkcs8, traditional) \
  {name, NULL, MBEDTLS_CIPHER_NONE, NULL, 0, 0, 0, false, SP_KC_##pkcs8, SP_KC_##traditional}
static const SpKeyCipher sp_key_cipher_failures[] = {
  SP_KC_FAIL("aes-128-cbc-cts", NO_OID, OK), SP_KC_FAIL("aes-128-ccm", EVP_CIPHER, OK),
  SP_KC_FAIL("aes-128-ctr", NO_OID, OK), SP_KC_FAIL("aes-128-gcm", PARAMETER, OK),
  SP_KC_FAIL("aes-128-gcm-siv", NO_OID, OK), SP_KC_FAIL("aes-128-ocb", NO_OID, OK),
  SP_KC_FAIL("aes-128-siv", NO_OID, PEM_CIPHER),
  SP_KC_FAIL("aes-128-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("aes-128-wrap-inv", NO_OID, INPUT_LENGTH),
  SP_KC_FAIL("aes-128-wrap-pad-inv", NO_OID, OK), SP_KC_FAIL("aes-128-xts", EVP_CIPHER, OK),
  SP_KC_FAIL("aes-192-cbc-cts", NO_OID, OK), SP_KC_FAIL("aes-192-ccm", EVP_CIPHER, OK),
  SP_KC_FAIL("aes-192-ctr", NO_OID, OK), SP_KC_FAIL("aes-192-gcm", PARAMETER, OK),
  SP_KC_FAIL("aes-192-gcm-siv", NO_OID, OK), SP_KC_FAIL("aes-192-ocb", NO_OID, OK),
  SP_KC_FAIL("aes-192-siv", NO_OID, PEM_CIPHER),
  SP_KC_FAIL("aes-192-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("aes-192-wrap-inv", NO_OID, INPUT_LENGTH),
  SP_KC_FAIL("aes-192-wrap-pad-inv", NO_OID, OK), SP_KC_FAIL("aes-256-cbc-cts", NO_OID, OK),
  SP_KC_FAIL("aes-256-ccm", EVP_CIPHER, OK), SP_KC_FAIL("aes-256-ctr", NO_OID, OK),
  SP_KC_FAIL("aes-256-gcm", PARAMETER, OK), SP_KC_FAIL("aes-256-gcm-siv", NO_OID, OK),
  SP_KC_FAIL("aes-256-ocb", NO_OID, OK), SP_KC_FAIL("aes-256-siv", NO_OID, PEM_CIPHER),
  SP_KC_FAIL("aes-256-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("aes-256-wrap-inv", NO_OID, INPUT_LENGTH),
  SP_KC_FAIL("aes-256-wrap-pad-inv", NO_OID, OK), SP_KC_FAIL("aes-256-xts", EVP_CIPHER, OK),
  SP_KC_FAIL("aes128-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("aes128-wrap-inv", NO_OID, INPUT_LENGTH),
  SP_KC_FAIL("aes128-wrap-pad-inv", NO_OID, OK),
  SP_KC_FAIL("aes192-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("aes192-wrap-inv", NO_OID, INPUT_LENGTH),
  SP_KC_FAIL("aes192-wrap-pad-inv", NO_OID, OK),
  SP_KC_FAIL("aes256-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("aes256-wrap-inv", NO_OID, INPUT_LENGTH),
  SP_KC_FAIL("aes256-wrap-pad-inv", NO_OID, OK), SP_KC_FAIL("aria-128-ccm", EVP_CIPHER, OK),
  SP_KC_FAIL("aria-128-cfb1", NO_OID, OK), SP_KC_FAIL("aria-128-cfb8", NO_OID, OK),
  SP_KC_FAIL("aria-128-ecb", OK, PEM_CIPHER), SP_KC_FAIL("aria-128-gcm", PARAMETER, OK),
  SP_KC_FAIL("aria-192-ccm", EVP_CIPHER, OK), SP_KC_FAIL("aria-192-cfb1", NO_OID, OK),
  SP_KC_FAIL("aria-192-cfb8", NO_OID, OK), SP_KC_FAIL("aria-192-ecb", OK, PEM_CIPHER),
  SP_KC_FAIL("aria-192-gcm", PARAMETER, OK), SP_KC_FAIL("aria-256-ccm", EVP_CIPHER, OK),
  SP_KC_FAIL("aria-256-cfb1", NO_OID, OK), SP_KC_FAIL("aria-256-cfb8", NO_OID, OK),
  SP_KC_FAIL("aria-256-ecb", OK, PEM_CIPHER), SP_KC_FAIL("aria-256-gcm", PARAMETER, OK),
  SP_KC_FAIL("camellia-128-cbc-cts", NO_OID, OK), SP_KC_FAIL("camellia-128-cfb1", NO_OID, OK),
  SP_KC_FAIL("camellia-128-cfb8", NO_OID, OK), SP_KC_FAIL("camellia-128-ecb", OK, PEM_CIPHER),
  SP_KC_FAIL("camellia-192-cbc-cts", NO_OID, OK), SP_KC_FAIL("camellia-192-cfb1", NO_OID, OK),
  SP_KC_FAIL("camellia-192-cfb8", NO_OID, OK), SP_KC_FAIL("camellia-192-ecb", OK, PEM_CIPHER),
  SP_KC_FAIL("camellia-256-cbc-cts", NO_OID, OK), SP_KC_FAIL("camellia-256-cfb1", NO_OID, OK),
  SP_KC_FAIL("camellia-256-cfb8", NO_OID, OK), SP_KC_FAIL("camellia-256-ecb", OK, PEM_CIPHER),
  SP_KC_FAIL("chacha20", NO_OID, OK), SP_KC_FAIL("chacha20-poly1305", NO_OID, OK),
  SP_KC_FAIL("des-ede", OK, PEM_CIPHER), SP_KC_FAIL("des-ede-cbc", NO_OID, OK),
  SP_KC_FAIL("des-ede-cfb", NO_OID, OK), SP_KC_FAIL("des-ede-ecb", OK, PEM_CIPHER),
  SP_KC_FAIL("des-ede-ofb", NO_OID, OK), SP_KC_FAIL("des-ede3", NO_OID, PEM_CIPHER),
  SP_KC_FAIL("des-ede3-cfb", ZERO_CONTENT, OK), SP_KC_FAIL("des-ede3-cfb1", ZERO_CONTENT, OK),
  SP_KC_FAIL("des-ede3-cfb8", ZERO_CONTENT, OK), SP_KC_FAIL("des-ede3-ecb", NO_OID, PEM_CIPHER),
  SP_KC_FAIL("des-ede3-ofb", NO_OID, OK), SP_KC_FAIL("des3-wrap", OPERATION, PEM_CIPHER),
  SP_KC_FAIL("id-aes128-ccm", EVP_CIPHER, OK), SP_KC_FAIL("id-aes128-gcm", PARAMETER, OK),
  SP_KC_FAIL("id-aes128-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("id-aes192-ccm", EVP_CIPHER, OK), SP_KC_FAIL("id-aes192-gcm", PARAMETER, OK),
  SP_KC_FAIL("id-aes192-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("id-aes256-ccm", EVP_CIPHER, OK), SP_KC_FAIL("id-aes256-gcm", PARAMETER, OK),
  SP_KC_FAIL("id-aes256-wrap", INPUT_LENGTH, INPUT_LENGTH),
  SP_KC_FAIL("id-smime-alg-cms3deswrap", OPERATION, PEM_CIPHER), SP_KC_FAIL("sm4-ccm", NO_OID, OK),
  SP_KC_FAIL("sm4-ecb", OK, PEM_CIPHER), SP_KC_FAIL("sm4-gcm", NO_OID, OK),
  SP_KC_FAIL("sm4-xts", NO_OID, OK), SP_KC_FAIL("des", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("des-cbc", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("des-ecb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("des-cfb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("des-cfb1", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("des-cfb8", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("des-ofb", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("desx", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("desx-cbc", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("bf", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("bf-cbc", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("bf-ecb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("bf-cfb", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("bf-ofb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("blowfish", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("cast", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("cast-cbc", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("cast5-cbc", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("cast5-ecb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("cast5-cfb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("cast5-ofb", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("rc2", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("rc2-cbc", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("rc2-ecb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("rc2-cfb", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("rc2-ofb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("rc2-40-cbc", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("rc2-64-cbc", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("rc4", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("rc4-40", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("rc4-hmac-md5", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("seed", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("seed-cbc", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("seed-ecb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("seed-cfb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("seed-ofb", UNSUPPORTED, UNSUPPORTED), SP_KC_FAIL("idea", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("idea-cbc", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("idea-ecb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("idea-cfb", UNSUPPORTED, UNSUPPORTED),
  SP_KC_FAIL("idea-ofb", UNSUPPORTED, UNSUPPORTED),
};
#undef SP_KC_FAIL

static bool sp_ascii_eq_ci(const char *a, size_t len, const char *b) {
  if (strlen(b) != len) return false;
  for (size_t i = 0; i < len; i++) {
    char c = a[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != b[i]) return false;
  }
  return true;
}

/* The cipher an export names, by a name or the OID text of one: true with
 * *out set (an entry of sp_key_ciphers, or of sp_key_cipher_failures);
 * false with Node's
 * ERR_CRYPTO_UNKNOWN_CIPHER pending, or the SC2020 refusal for a cipher
 * Node encrypts with that keys here do not. */
static bool sp_key_cipher(const ScrStr *name, const SpKeyCipher **out) {
  const char *data = name->data;
  size_t len = name->len;
  static const struct {
    const char *oid, *name;
  } oids[] = {SCR_CIPHER_OID_ALIASES};
  for (size_t i = 0; i < sizeof oids / sizeof oids[0]; i++) {
    if (strlen(oids[i].oid) == len && memcmp(data, oids[i].oid, len) == 0) {
      data = oids[i].name;
      len = strlen(data);
    }
  }
  const char *wanted = NULL;
  for (size_t i = 0; i < sizeof sp_key_cipher_aliases / sizeof sp_key_cipher_aliases[0]; i++)
    if (sp_ascii_eq_ci(data, len, sp_key_cipher_aliases[i].alias)) wanted = sp_key_cipher_aliases[i].name;
  for (size_t i = 0; i < sizeof sp_key_ciphers / sizeof sp_key_ciphers[0]; i++) {
    if (wanted ? strcmp(wanted, sp_key_ciphers[i].name) == 0 : sp_ascii_eq_ci(data, len, sp_key_ciphers[i].name)) {
      *out = &sp_key_ciphers[i];
      return true;
    }
  }
  for (size_t i = 0; i < sizeof sp_key_cipher_failures / sizeof sp_key_cipher_failures[0]; i++) {
    if (sp_ascii_eq_ci(data, len, sp_key_cipher_failures[i].name)) {
      *out = &sp_key_cipher_failures[i];
      return true;
    }
  }
  static const char *const known[] = {SCR_CIPHER_KNOWN_NAMES};
  for (size_t i = 0; i < sizeof known / sizeof known[0]; i++) {
    if (sp_ascii_eq_ci(data, len, known[i])) {
      sp_not_supported("private keys encrypted with this cipher");
      return false;
    }
  }
  sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
  return false;
}

/* Whether encryption in the form (PKCS#8, or traditional PEM) can take
 * the cipher for `len` bytes of key: false with OpenSSL's error pending,
 * or the SC2020 refusal for a cipher OpenSSL encrypts with that keys here
 * do not. The key wrap ciphers fail only on a length that is not a
 * multiple of 8; AES key wrap then encrypts, and Node's 3DES key wrap
 * corrupts its heap. */
static bool sp_key_cipher_ready(const SpKeyCipher *ci, bool pkcs8, size_t len) {
  unsigned char error = pkcs8 ? ci->pkcs8_error : ci->traditional_error;
  if ((error == SP_KC_INPUT_LENGTH || error == SP_KC_OPERATION) && len % 8 == 0) error = SP_KC_OK;
  if (error != SP_KC_OK) {
    sp_throw_openssl(sp_key_cipher_errors[error].packed, sp_key_cipher_errors[error].library,
                     sp_key_cipher_errors[error].reason, sp_key_cipher_errors[error].code, true);
    return false;
  }
  if (ci->type == MBEDTLS_CIPHER_NONE) {
    sp_not_supported("private keys encrypted with this cipher");
    return false;
  }
  return true;
}

/* `in` through the cipher with PKCS#7 padding, as OpenSSL's EVP layer
 * pads CBC and ECB: the output (+1 malloc'd, *out_len), or NULL when
 * decryption finds bad padding. */
static unsigned char *sp_key_cipher_run(const SpKeyCipher *ci, bool encrypt, const unsigned char *key,
                                        const unsigned char *iv, const unsigned char *in, size_t in_len,
                                        size_t *out_len) {
  const mbedtls_cipher_info_t *info = mbedtls_cipher_info_from_type(ci->type);
  size_t block = mbedtls_cipher_info_get_block_size(info);
  size_t padded = encrypt ? (in_len / block + 1) * block : in_len;
  if (!encrypt && (in_len == 0 || in_len % block != 0)) return NULL;
  unsigned char *src = malloc(padded ? padded : 1), *out = malloc(padded ? padded : 1);
  if (!src || !out) scr_trap("scriptc: out of memory\n");
  memcpy(src, in, in_len);
  if (encrypt) memset(src + in_len, (int)(padded - in_len), padded - in_len);
  mbedtls_cipher_context_t ctx;
  mbedtls_cipher_init(&ctx);
  int r = mbedtls_cipher_setup(&ctx, info);
  if (r == 0) r = mbedtls_cipher_setkey(&ctx, key, (int)ci->key_len * 8, encrypt ? MBEDTLS_ENCRYPT : MBEDTLS_DECRYPT);
  if (r == 0 && !ci->ecb) r = mbedtls_cipher_set_padding_mode(&ctx, MBEDTLS_PADDING_NONE);
  if (r == 0 && !ci->ecb) r = mbedtls_cipher_set_iv(&ctx, iv, ci->iv_len);
  size_t written = 0;
  for (size_t i = 0; r == 0 && i < padded; i += block) {
    size_t n = 0;
    r = mbedtls_cipher_update(&ctx, src + i, block, out + written, &n);
    written += n;
  }
  if (r == 0 && !ci->ecb) {
    size_t n = 0;
    r = mbedtls_cipher_finish(&ctx, out + written, &n);
    written += n;
  }
  mbedtls_cipher_free(&ctx);
  mbedtls_platform_zeroize(src, padded);
  free(src);
  if (r == 0 && !encrypt) {
    unsigned char pad = written ? out[written - 1] : 0;
    bool ok = pad >= 1 && pad <= block && pad <= written;
    for (size_t i = 0; ok && i < pad; i++) ok = out[written - 1 - i] == pad;
    if (ok) written -= pad;
    else r = -1;
  }
  if (r != 0) {
    mbedtls_platform_zeroize(out, padded);
    free(out);
    return NULL;
  }
  *out_len = written;
  return out;
}

/* EncryptedPrivateKeyInfo DER of the PKCS#8 `plain` (+1 malloc'd,
 * *out_len), as OpenSSL 3 writes it; NULL on failure. */
static unsigned char *sp_encrypt_pkcs8(const unsigned char *plain, size_t plain_len, const SpKeyCipher *ci,
                                       const unsigned char *pass, size_t pass_len, size_t *out_len) {
  unsigned char salt[16], iv[16], key[32];
  sp_random(NULL, salt, sizeof salt);
  sp_random(NULL, iv, ci->iv_len);
  if (mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256, pass, pass_len, salt, sizeof salt, 2048,
                                    (uint32_t)ci->key_len, key) != 0)
    return NULL;
  size_t enc_len;
  unsigned char *enc = sp_key_cipher_run(ci, true, key, iv, plain, plain_len, &enc_len);
  mbedtls_platform_zeroize(key, sizeof key);
  if (!enc) return NULL;
  size_t size = enc_len + 256;
  unsigned char *buf = malloc(size);
  if (!buf) scr_trap("scriptc: out of memory\n");
  unsigned char *c = buf + size;
  int r, len = 0, w;
#define SP_W(call) do { if ((w = (call)) < 0) { r = w; goto fail; } } while (0)
  SP_W(mbedtls_asn1_write_octet_string(&c, buf, enc, enc_len));
  len += w;
  /* encryptionScheme: the cipher with its IV (empty for ECB) */
  int scheme = 0;
  SP_W(mbedtls_asn1_write_octet_string(&c, buf, iv, ci->iv_len));
  scheme += w;
  SP_W(mbedtls_asn1_write_oid(&c, buf, ci->oid, ci->oid_len));
  scheme += w;
  SP_W(mbedtls_asn1_write_len(&c, buf, (size_t)scheme));
  scheme += w;
  SP_W(mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE));
  scheme += w;
  /* keyDerivationFunc: PBKDF2 { salt, 2048, hmacWithSHA256 } */
  int kdf = 0, prf = 0;
  SP_W(mbedtls_asn1_write_null(&c, buf));
  prf += w;
  SP_W(mbedtls_asn1_write_oid(&c, buf, MBEDTLS_OID_HMAC_SHA256, MBEDTLS_OID_SIZE(MBEDTLS_OID_HMAC_SHA256)));
  prf += w;
  SP_W(mbedtls_asn1_write_len(&c, buf, (size_t)prf));
  prf += w;
  SP_W(mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE));
  prf += w;
  kdf += prf;
  SP_W(mbedtls_asn1_write_int(&c, buf, 2048));
  kdf += w;
  SP_W(mbedtls_asn1_write_octet_string(&c, buf, salt, sizeof salt));
  kdf += w;
  SP_W(mbedtls_asn1_write_len(&c, buf, (size_t)kdf));
  kdf += w;
  SP_W(mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE));
  kdf += w;
  SP_W(mbedtls_asn1_write_oid(&c, buf, MBEDTLS_OID_PKCS5_PBKDF2, MBEDTLS_OID_SIZE(MBEDTLS_OID_PKCS5_PBKDF2)));
  kdf += w;
  SP_W(mbedtls_asn1_write_len(&c, buf, (size_t)kdf));
  kdf += w;
  SP_W(mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE));
  kdf += w;
  int params = kdf + scheme;
  SP_W(mbedtls_asn1_write_len(&c, buf, (size_t)params));
  params += w;
  SP_W(mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE));
  params += w;
  SP_W(mbedtls_asn1_write_oid(&c, buf, MBEDTLS_OID_PKCS5_PBES2, MBEDTLS_OID_SIZE(MBEDTLS_OID_PKCS5_PBES2)));
  params += w;
  SP_W(mbedtls_asn1_write_len(&c, buf, (size_t)params));
  params += w;
  SP_W(mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE));
  params += w;
  len += params;
  SP_W(mbedtls_asn1_write_len(&c, buf, (size_t)len));
  len += w;
  SP_W(mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE));
  len += w;
#undef SP_W
  memmove(buf, c, (size_t)len);
  mbedtls_platform_zeroize(enc, enc_len);
  free(enc);
  *out_len = (size_t)len;
  return buf;
fail:
  (void)r;
  mbedtls_platform_zeroize(enc, enc_len);
  free(enc);
  free(buf);
  return NULL;
}

/* OpenSSL's EVP_BytesToKey with MD5 and one round over the first 8 IV
 * bytes, as traditional PEM encryption derives its key. */
static void sp_bytes_to_key(const unsigned char *pass, size_t pass_len, const unsigned char *salt, unsigned char *key,
                            size_t key_len) {
  const mbedtls_md_info_t *md5 = mbedtls_md_info_from_type(MBEDTLS_MD_MD5);
  unsigned char digest[16];
  size_t done = 0;
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, md5, 0);
  for (bool first = true; done < key_len; first = false) {
    mbedtls_md_starts(&ctx);
    if (!first) mbedtls_md_update(&ctx, digest, sizeof digest);
    mbedtls_md_update(&ctx, pass, pass_len);
    mbedtls_md_update(&ctx, salt, 8);
    mbedtls_md_finish(&ctx, digest);
    size_t n = key_len - done < sizeof digest ? key_len - done : sizeof digest;
    memcpy(key + done, digest, n);
    done += n;
  }
  mbedtls_md_free(&ctx);
  mbedtls_platform_zeroize(digest, sizeof digest);
}

/* The traditional encrypted PEM of a PKCS#1 or SEC1 key (+1), or NULL. */
static ScrStr *sp_encrypted_pem(const char *label, const unsigned char *der, size_t len, const SpKeyCipher *ci,
                                const unsigned char *pass, size_t pass_len) {
  unsigned char iv[16], key[32];
  sp_random(NULL, iv, ci->iv_len);
  sp_bytes_to_key(pass, pass_len, iv, key, ci->key_len);
  size_t enc_len;
  unsigned char *enc = sp_key_cipher_run(ci, true, key, iv, der, len, &enc_len);
  mbedtls_platform_zeroize(key, sizeof key);
  if (!enc) return NULL;
  ScrStr *body = sp_pem(label, enc, enc_len);
  mbedtls_platform_zeroize(enc, enc_len);
  free(enc);
  /* The headers follow the BEGIN line, then a blank line. */
  const char *nl = memchr(body->data, '\n', body->len);
  size_t head = (size_t)(nl - body->data) + 1;
  ScrJsonBuf out;
  scr_jb_init(&out);
  for (size_t i = 0; i < head; i++) scr_jb_putc(&out, body->data[i]);
  scr_jb_puts(&out, "Proc-Type: 4,ENCRYPTED\nDEK-Info: ");
  scr_jb_puts(&out, ci->pem);
  scr_jb_putc(&out, ',');
  static const char hex[] = "0123456789ABCDEF";
  for (size_t i = 0; i < ci->iv_len; i++) {
    scr_jb_putc(&out, hex[iv[i] >> 4]);
    scr_jb_putc(&out, hex[iv[i] & 15]);
  }
  scr_jb_puts(&out, "\n\n");
  for (size_t i = head; i < body->len; i++) scr_jb_putc(&out, body->data[i]);
  scr_str_release(body);
  return scr_jb_finish(&out);
}

/* OpenSSL's errors for an encrypted private key: the message, Node's
 * code, and the error stack OpenSSL leaves for the input's form. */
static void sp_throw_key_decrypt(const char *message, const char *library, const char *reason, const char *code,
                                 const char *const *stack, size_t stack_len) {
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  ScrDyn *list = scr_dyn_new_arr();
  for (size_t i = 0; i < stack_len; i++) {
    ScrStr *entry = scr_str_new(stack[i], strlen(stack[i]));
    scr_dyn_arr_push(list, scr_dyn_new_str(entry));
    scr_str_release(entry);
  }
  scr_error_set_prop(e, "opensslErrorStack", 17, list);
  const char *keys[] = {"library", "reason", "code"};
  const char *values[] = {library, reason, code};
  for (size_t i = 0; i < 3; i++) {
    if (i == 2) scr_error_set_code(e, code);
    ScrStr *value = scr_str_new(values[i], strlen(values[i]));
    scr_error_set_prop(e, keys[i], strlen(keys[i]), scr_dyn_new_str(value));
    scr_str_release(value);
  }
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

static const char sp_err_interrupted[] = "error:07880109:common libcrypto routines::interrupted or cancelled";
static const char sp_err_bad_decrypt[] = "error:1C800064:Provider routines::bad decrypt";

/* No passphrase for an encrypted PEM key (pkcs8: whether it is PKCS#8). */
static void sp_throw_passphrase_missing(bool pkcs8) {
  static const char *const pkcs8_stack[] = {"error:04800068:PEM routines::bad password read", sp_err_interrupted,
                                            "error:1C80009F:Provider routines::unable to get passphrase",
                                            sp_err_interrupted, sp_err_interrupted};
  static const char *const pem_stack[] = {"error:04800068:PEM routines::bad password read", sp_err_interrupted,
                                          sp_err_interrupted};
  sp_throw_key_decrypt(sp_err_interrupted, "common libcrypto routines", "interrupted or cancelled",
                       "ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED", pkcs8 ? pkcs8_stack : pem_stack, pkcs8 ? 5 : 3);
}

/* A passphrase that does not decrypt the key: PKCS#8 in PEM, PKCS#8 in
 * DER, or traditional PEM. */
static void sp_throw_bad_decrypt(int form) {
  static const char cipherfinal[] = "error:11800074:PKCS12 routines::pkcs12 cipherfinal error";
  static const char *const stacks[][4] = {
    {cipherfinal, sp_err_bad_decrypt, cipherfinal, sp_err_bad_decrypt},
    {cipherfinal, sp_err_bad_decrypt},
    {"error:04800065:PEM routines::bad decrypt", sp_err_bad_decrypt},
  };
  sp_throw_key_decrypt(sp_err_bad_decrypt, "Provider routines", "bad decrypt", "ERR_OSSL_BAD_DECRYPT", stacks[form],
                       form == 0 ? 4 : 2);
}

/* The cipher name of an encrypted traditional PEM key's DEK-Info header
 * into `name` (NUL-terminated), or false for other input. */
static bool sp_pem_dek_info(const unsigned char *data, size_t len, char *name, size_t cap) {
  const char *text = (const char *)data;
  const char *begin = NULL;
  for (size_t i = 0; i + 11 <= len && !begin; i++)
    if (memcmp(text + i, "-----BEGIN ", 11) == 0) begin = text + i;
  if (!begin) return false;
  const char *end = text + len, *line = memchr(begin, '\n', (size_t)(end - begin));
  bool encrypted = false;
  while (line && ++line < end) {
    const char *eol = memchr(line, '\n', (size_t)(end - line));
    size_t n = (size_t)((eol ? eol : end) - line);
    if (n && line[n - 1] == '\r') n--;
    if (n >= 10 && memcmp(line, "Proc-Type:", 10) == 0) {
      for (size_t i = 10; i + 9 <= n; i++)
        if (memcmp(line + i, "ENCRYPTED", 9) == 0) encrypted = true;
    } else if (n >= 9 && memcmp(line, "DEK-Info:", 9) == 0) {
      if (!encrypted) return false;
      size_t i = 9;
      while (i < n && line[i] == ' ') i++;
      size_t o = 0;
      while (i < n && line[i] != ',' && o + 1 < cap) name[o++] = line[i++];
      name[o] = 0;
      return true;
    } else if (n == 0 || memchr(line, ':', n) == NULL) {
      return false;
    }
    line = eol;
  }
  return false;
}

/* Before mbedTLS reads an encrypted traditional PEM key: false with
 * OpenSSL's error pending for a DEK-Info cipher it does not know, a
 * missing passphrase, or a legacy-provider cipher, or the SC2020 refusal
 * for a cipher mbedTLS does not decrypt; true for other input. */
static bool sp_pem_dek_check(const unsigned char *data, size_t len, const ScrBytes *pass) {
  char name[64];
  if (!sp_pem_dek_info(data, len, name, sizeof name)) return true;
  size_t n = strlen(name);
  static const char *const known[] = {SCR_CIPHER_KNOWN_NAMES};
  static const struct {
    const char *name;
    unsigned iv_len;
  } legacy[] = {SCR_CIPHER_LEGACY_ENTRIES};
  bool is_known = false, is_legacy = false;
  for (size_t i = 0; i < sizeof known / sizeof known[0]; i++)
    if (sp_ascii_eq_ci(name, n, known[i])) is_known = true;
  for (size_t i = 0; i < sizeof legacy / sizeof legacy[0]; i++)
    if (sp_ascii_eq_ci(name, n, legacy[i].name)) is_legacy = true;
  if (!is_known && !is_legacy) {
    static const char *const stack[] = {"error:04800072:PEM routines::unsupported encryption"};
    sp_throw_key_decrypt(stack[0], "PEM routines", "unsupported encryption", "ERR_OSSL_PEM_UNSUPPORTED_ENCRYPTION",
                         stack, 1);
    return false;
  }
  if (!pass) {
    sp_throw_passphrase_missing(false);
    return false;
  }
  if (is_legacy) {
    static const char unsupported[] = "error:0308010C:digital envelope routines::unsupported";
    static const char *const stack[] = {"error:04800065:PEM routines::bad decrypt", unsupported};
    sp_throw_key_decrypt(unsupported, "digital envelope routines", "unsupported", "ERR_OSSL_EVP_UNSUPPORTED", stack,
                         2);
    return false;
  }
  /* mbedTLS decrypts these names, as OpenSSL writes them. */
  static const char *const read[] = {"AES-128-CBC", "AES-192-CBC", "AES-256-CBC", "DES-EDE3-CBC"};
  for (size_t i = 0; i < sizeof read / sizeof read[0]; i++)
    if (strcmp(name, read[i]) == 0) return true;
  sp_not_supported("private keys encrypted with this cipher");
  return false;
}

/* The PKCS#8 inside a PBES2 EncryptedPrivateKeyInfo `der` (+1 malloc'd,
 * *out_len): 1 decrypted, 0 another scheme or cipher, -1 a passphrase
 * that does not decrypt it. */
static int sp_decrypt_pkcs8(const unsigned char *der, size_t len, const unsigned char *pass, size_t pass_len,
                            unsigned char **out, size_t *out_len) {
  unsigned char *p = (unsigned char *)der;
  const unsigned char *end = der + len;
  size_t n;
  mbedtls_asn1_buf alg, params;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return 0;
  end = p + n;
  if (mbedtls_asn1_get_alg(&p, end, &alg, &params) != 0 || alg.len != MBEDTLS_OID_SIZE(MBEDTLS_OID_PKCS5_PBES2) ||
      memcmp(alg.p, MBEDTLS_OID_PKCS5_PBES2, alg.len) != 0 ||
      params.tag != (MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE))
    return 0;
  unsigned char *q = params.p;
  const unsigned char *params_end = params.p + params.len;
  mbedtls_asn1_buf kdf, kdf_params, scheme, scheme_params;
  if (mbedtls_asn1_get_alg(&q, params_end, &kdf, &kdf_params) != 0 ||
      kdf.len != MBEDTLS_OID_SIZE(MBEDTLS_OID_PKCS5_PBKDF2) || memcmp(kdf.p, MBEDTLS_OID_PKCS5_PBKDF2, kdf.len) != 0 ||
      mbedtls_asn1_get_alg(&q, params_end, &scheme, &scheme_params) != 0)
    return 0;
  const SpKeyCipher *ci = NULL;
  for (size_t i = 0; i < sizeof sp_key_ciphers / sizeof sp_key_ciphers[0]; i++)
    if (scheme.len == sp_key_ciphers[i].oid_len && memcmp(scheme.p, sp_key_ciphers[i].oid, scheme.len) == 0)
      ci = &sp_key_ciphers[i];
  if (!ci || scheme_params.tag != MBEDTLS_ASN1_OCTET_STRING || scheme_params.len != ci->iv_len) return 0;
  /* PBKDF2-params ::= SEQUENCE { salt OCTET STRING, iterationCount
   * INTEGER, keyLength INTEGER OPTIONAL, prf AlgorithmIdentifier DEFAULT
   * hmacWithSHA1 } */
  unsigned char *k = kdf_params.p;
  const unsigned char *k_end = kdf_params.p + kdf_params.len;
  size_t salt_len;
  int iterations, key_len = (int)ci->key_len;
  if (kdf_params.tag != (MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) ||
      mbedtls_asn1_get_tag(&k, k_end, &salt_len, MBEDTLS_ASN1_OCTET_STRING) != 0)
    return 0;
  const unsigned char *salt = k;
  k += salt_len;
  if (mbedtls_asn1_get_int(&k, k_end, &iterations) != 0 || iterations < 1) return 0;
  if (k < k_end && *k == MBEDTLS_ASN1_INTEGER && (mbedtls_asn1_get_int(&k, k_end, &key_len) != 0 ||
                                                  key_len != (int)ci->key_len))
    return 0;
  mbedtls_md_type_t prf = MBEDTLS_MD_SHA1;
  if (k < k_end) {
    mbedtls_asn1_buf prf_oid, prf_params;
    if (mbedtls_asn1_get_alg(&k, k_end, &prf_oid, &prf_params) != 0 || mbedtls_oid_get_md_hmac(&prf_oid, &prf) != 0)
      return 0;
  }
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_OCTET_STRING) != 0) return 0;
  unsigned char key[32];
  if (mbedtls_pkcs5_pbkdf2_hmac_ext(prf, pass, pass_len, salt, salt_len, (unsigned)iterations,
                                    (uint32_t)ci->key_len, key) != 0)
    return 0;
  *out = sp_key_cipher_run(ci, false, key, scheme_params.p, p, n, out_len);
  mbedtls_platform_zeroize(key, sizeof key);
  return *out ? 1 : -1;
}

static ScrDyn *sp_dyn_buffer(const unsigned char *data, size_t len) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)len);
  bytes->is_buffer = true;
  if (len) memcpy(bytes->data, data, len);
  ScrDyn *d = scr_dyn_new_buffer(bytes);
  scr_bytes_release(bytes);
  return d;
}

static ScrDyn *sp_dyn_str(ScrStr *s) {
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

/* ── JWK ──────────────────────────────────────────────────────────────── */

/* base64url without padding of the big-endian integer `x` in `len` bytes
 * (0 = its minimal length). */
static ScrDyn *sp_jwk_int(const mbedtls_mpi *x, size_t len) {
  if (len == 0) len = mbedtls_mpi_size(x);
  if (len == 0) len = 1;
  unsigned char *raw = malloc(len);
  size_t b64_len = 0;
  if (!raw) scr_trap("scriptc: out of memory\n");
  mbedtls_mpi_write_binary(x, raw, len);
  mbedtls_base64_encode(NULL, 0, &b64_len, raw, len);
  unsigned char *b64 = malloc(b64_len + 1);
  if (!b64) scr_trap("scriptc: out of memory\n");
  mbedtls_base64_encode(b64, b64_len + 1, &b64_len, raw, len);
  size_t o = 0;
  for (size_t i = 0; i < b64_len; i++) {
    unsigned char c = b64[i];
    if (c == '=') break;
    b64[o++] = c == '+' ? '-' : c == '/' ? '_' : c;
  }
  ScrDyn *d = sp_dyn_str(scr_str_new((const char *)b64, o));
  mbedtls_platform_zeroize(raw, len);
  free(raw);
  free(b64);
  return d;
}

static void sp_set(ScrDyn *obj, const char *key, ScrDyn *value) {
  scr_dyn_obj_set(obj, key, strlen(key), value);
}

/* base64url without padding of raw bytes. */
static ScrDyn *sp_b64url(const uint8_t *raw, size_t len) {
  size_t b64_len = 0;
  mbedtls_base64_encode(NULL, 0, &b64_len, raw, len);
  unsigned char *b64 = malloc(b64_len + 1);
  if (!b64) scr_trap("scriptc: out of memory\n");
  mbedtls_base64_encode(b64, b64_len + 1, &b64_len, raw, len);
  size_t o = 0;
  for (size_t i = 0; i < b64_len; i++) {
    unsigned char c = b64[i];
    if (c == '=') break;
    b64[o++] = c == '+' ? '-' : c == '/' ? '_' : c;
  }
  ScrDyn *d = sp_dyn_str(scr_str_new((const char *)b64, o));
  mbedtls_platform_zeroize(b64, b64_len);
  free(b64);
  return d;
}

static ScrDyn *sp_export_jwk(SpKey *k) {
  ScrDyn *jwk = scr_dyn_new_obj();
  if (sp_is_okp(k)) {
    sp_set(jwk, "kty", sp_dyn_str(scr_str_new("OKP", 3)));
    sp_set(jwk, "crv", sp_dyn_str(sp_is_x(k) ? scr_str_new("X25519", 6) : scr_str_new("Ed25519", 7)));
    sp_set(jwk, "x", sp_b64url(k->ed_pub, 32));
    if (k->private_key) sp_set(jwk, "d", sp_b64url(k->ed_seed, 32));
    return jwk;
  }
  if (sp_is_rsa(k)) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(k->pk);
    mbedtls_mpi n, e, d, p, q, dp, dq, qi;
    mbedtls_mpi *all[] = {&n, &e, &d, &p, &q, &dp, &dq, &qi};
    for (size_t i = 0; i < 8; i++) mbedtls_mpi_init(all[i]);
    mbedtls_rsa_export(rsa, &n, k->private_key ? &p : NULL, k->private_key ? &q : NULL,
                       k->private_key ? &d : NULL, &e);
    sp_set(jwk, "kty", sp_dyn_str(scr_str_new("RSA", 3)));
    sp_set(jwk, "n", sp_jwk_int(&n, 0));
    sp_set(jwk, "e", sp_jwk_int(&e, 0));
    if (k->private_key) {
      mbedtls_rsa_export_crt(rsa, &dp, &dq, &qi);
      sp_set(jwk, "d", sp_jwk_int(&d, 0));
      sp_set(jwk, "p", sp_jwk_int(&p, 0));
      sp_set(jwk, "q", sp_jwk_int(&q, 0));
      sp_set(jwk, "dp", sp_jwk_int(&dp, 0));
      sp_set(jwk, "dq", sp_jwk_int(&dq, 0));
      sp_set(jwk, "qi", sp_jwk_int(&qi, 0));
    }
    for (size_t i = 0; i < 8; i++) mbedtls_mpi_free(all[i]);
  } else {
    const mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
    const SpCurve *curve = sp_curve_of(k);
    size_t size = (ec->MBEDTLS_PRIVATE(grp).nbits + 7) / 8;
    sp_set(jwk, "kty", sp_dyn_str(scr_str_new("EC", 2)));
    sp_set(jwk, "x", sp_jwk_int(&ec->MBEDTLS_PRIVATE(Q).MBEDTLS_PRIVATE(X), size));
    sp_set(jwk, "y", sp_jwk_int(&ec->MBEDTLS_PRIVATE(Q).MBEDTLS_PRIVATE(Y), size));
    sp_set(jwk, "crv", sp_dyn_str(scr_str_new(curve->jwk, strlen(curve->jwk))));
    if (k->private_key) sp_set(jwk, "d", sp_jwk_int(&ec->MBEDTLS_PRIVATE(d), size));
  }
  return jwk;
}

/* Decodes a JWK base64url member into `x`; false when it is missing or
 * not a string. */
static bool sp_jwk_read(const ScrDyn *jwk, const char *key, mbedtls_mpi *x) {
  const ScrDyn *v = sp_opt(jwk, key);
  if (v->kind != SCR_DYN_STR) return false;
  size_t n = v->v.str->len;
  unsigned char *b64 = malloc(n + 4);
  unsigned char *raw = malloc(n + 4);
  if (!b64 || !raw) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < n; i++) {
    char c = v->v.str->data[i];
    b64[i] = (unsigned char)(c == '-' ? '+' : c == '_' ? '/' : c);
  }
  while (n % 4) b64[n++] = '=';
  size_t raw_len = 0;
  bool ok = mbedtls_base64_decode(raw, n, &raw_len, b64, n) == 0 &&
            mbedtls_mpi_read_binary(x, raw, raw_len) == 0;
  mbedtls_platform_zeroize(raw, n);
  free(b64);
  free(raw);
  return ok;
}

/* Decodes a 32-byte JWK base64url member; false when it is missing, not a
 * string, or another length. */
static bool sp_jwk_bytes(const ScrDyn *jwk, const char *key, uint8_t out[32]) {
  const ScrDyn *v = sp_opt(jwk, key);
  if (v->kind != SCR_DYN_STR || v->v.str->len != 43) return false;
  unsigned char b64[44];
  for (size_t i = 0; i < 43; i++) {
    char c = v->v.str->data[i];
    b64[i] = (unsigned char)(c == '-' ? '+' : c == '_' ? '/' : c);
  }
  b64[43] = '=';
  size_t n = 0;
  return mbedtls_base64_decode(out, 32, &n, b64, 44) == 0 && n == 32;
}

static void sp_invalid_jwk(void) {
  sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK data");
}

/* A JWK whose members do not make a key of its type: Node names the type
 * ("Invalid JWK RSA key"). */
static void sp_invalid_jwk_key(const char *kty) {
  scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK %s key", kty);
}

/* A key from a JWK object: RSA (n, e, and d, p, q for a private key) or EC
 * (crv, x, y, and d). NULL with the error pending. */
static SpKey *sp_key_from_jwk_plain(const ScrDyn *jwk, bool want_private);

static SpKey *sp_key_from_jwk(const ScrDyn *jwk, bool want_private) {
  ScrDyn *plain = sp_plain(jwk);
  if (!plain) return NULL;
  SpKey *k = sp_key_from_jwk_plain(plain, want_private);
  scr_dyn_release(plain);
  return k;
}

static SpKey *sp_key_from_jwk_plain(const ScrDyn *jwk, bool want_private) {
  if (!sp_is_object(jwk)) {
    scr_dyn_prop_type_fail("key.key", "of type object", jwk);
    return NULL;
  }
  const ScrDyn *kty = sp_opt(jwk, "kty");
  if (kty->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("key.kty", "of type string", kty);
    return NULL;
  }
  bool has_d = !sp_absent(sp_opt(jwk, "d"));
  if (want_private && !has_d) {
    sp_invalid_jwk();
    return NULL;
  }
  bool private_key = want_private;
  SpKey *k = sp_key_alloc(private_key);
  bool ok = false;
  if (sp_is_str(kty, "OKP")) {
    const ScrDyn *crv = sp_opt(jwk, "crv");
    bool x = sp_is_str(crv, "X25519");
    if (!x && !sp_is_str(crv, "Ed25519")) {
      sp_key_release(k);
      if (crv->kind != SCR_DYN_STR) {
        scr_dyn_prop_type_fail("key.crv", "of type string", crv);
        return NULL;
      }
      sp_not_supported("JWK keys of this crv");
      return NULL;
    }
    k->ed25519 = !x;
    k->x25519 = x;
    if (private_key) {
      ok = sp_jwk_bytes(jwk, "d", k->ed_seed);
      if (ok && x) {
        ok = sp_x25519(k->ed_seed, NULL, k->ed_pub);
      } else if (ok) {
        const ScrPkiEd25519 *ed = sp_ed();
        if (!ed) {
          sp_key_release(k);
          return NULL;
        }
        ed->public_key(k->ed_pub, k->ed_seed);
      }
    } else {
      ok = sp_jwk_bytes(jwk, "x", k->ed_pub);
    }
  } else if (sp_is_str(kty, "RSA")) {
    mbedtls_mpi n, e, d, p, q;
    mbedtls_mpi_init(&n);
    mbedtls_mpi_init(&e);
    mbedtls_mpi_init(&d);
    mbedtls_mpi_init(&p);
    mbedtls_mpi_init(&q);
    if (sp_jwk_read(jwk, "n", &n) && sp_jwk_read(jwk, "e", &e) &&
        mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) == 0) {
      mbedtls_rsa_context *rsa = mbedtls_pk_rsa(k->pk);
      if (private_key) {
        ok = sp_jwk_read(jwk, "d", &d) && sp_jwk_read(jwk, "p", &p) && sp_jwk_read(jwk, "q", &q) &&
             mbedtls_rsa_import(rsa, &n, &p, &q, &d, &e) == 0 && mbedtls_rsa_complete(rsa) == 0 &&
             mbedtls_rsa_check_privkey(rsa) == 0;
      } else {
        ok = mbedtls_rsa_import(rsa, &n, NULL, NULL, NULL, &e) == 0 &&
             mbedtls_rsa_complete(rsa) == 0 && mbedtls_rsa_check_pubkey(rsa) == 0;
      }
    }
    mbedtls_mpi_free(&n);
    mbedtls_mpi_free(&e);
    mbedtls_mpi_free(&d);
    mbedtls_mpi_free(&p);
    mbedtls_mpi_free(&q);
  } else if (sp_is_str(kty, "EC")) {
    const ScrDyn *crv = sp_opt(jwk, "crv");
    if (crv->kind != SCR_DYN_STR) {
      sp_key_release(k);
      scr_dyn_prop_type_fail("key.crv", "of type string", crv);
      return NULL;
    }
    const SpCurve *curve = NULL;
    for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
      if (sp_is_str(crv, sp_curves[i].jwk)) curve = &sp_curves[i];
    if (!curve) {
      sp_key_release(k);
      sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
      return NULL;
    }
    if (mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) == 0) {
      mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
      mbedtls_ecp_point *Q = &ec->MBEDTLS_PRIVATE(Q);
      ok = mbedtls_ecp_group_load(&ec->MBEDTLS_PRIVATE(grp), curve->id) == 0 &&
           sp_jwk_read(jwk, "x", &Q->MBEDTLS_PRIVATE(X)) &&
           sp_jwk_read(jwk, "y", &Q->MBEDTLS_PRIVATE(Y)) &&
           mbedtls_mpi_lset(&Q->MBEDTLS_PRIVATE(Z), 1) == 0 &&
           mbedtls_ecp_check_pubkey(&ec->MBEDTLS_PRIVATE(grp), Q) == 0;
      if (ok && private_key)
        ok = sp_jwk_read(jwk, "d", &ec->MBEDTLS_PRIVATE(d)) &&
             mbedtls_ecp_check_privkey(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(d)) == 0;
    }
  } else {
    sp_key_release(k);
    sp_not_supported("JWK keys of this kty");
    return NULL;
  }
  if (!ok) {
    sp_key_release(k);
    sp_invalid_jwk_key(sp_is_str(kty, "OKP") ? "OKP" : sp_is_str(kty, "RSA") ? "RSA" : "EC");
    return NULL;
  }
  return k;
}

/* ── parsing ──────────────────────────────────────────────────────────── */

/* The private key of a public SpKey derived from `k`. */
static SpKey *sp_public_of(SpKey *k) {
  if (sp_is_okp(k)) {
    SpKey *pub = sp_key_alloc(false);
    pub->ed25519 = k->ed25519;
    pub->x25519 = k->x25519;
    memcpy(pub->ed_pub, k->ed_pub, 32);
    return pub;
  }
  unsigned char der[SP_DER_MAX];
  int n = k->rsa_pss ? mbedtls_pk_write_pubkey_der(&k->pk, der, sizeof der) : sp_write_spki_der(k, der, sizeof der);
  SpKey *pub = sp_key_alloc(false);
  if (n < 0 || mbedtls_pk_parse_public_key(&pub->pk, der + sizeof der - n, (size_t)n) != 0) {
    sp_key_release(pub);
    return NULL;
  }
  sp_pss_copy(pub, k);
  return pub;
}

/* Parses key material (PEM or DER bytes). `private_key` selects
 * createPrivateKey's parse (PKCS#1, SEC1, PKCS#8) or createPublicKey's
 * (SubjectPublicKeyInfo, PKCS#1 RSAPublicKey, then a private key or an
 * X.509 certificate, whose public key it takes). NULL with Node's
 * decoder error pending. */
/* The DER of the first PEM block in data (+1 malloc'd in *out), or the
 * data itself when it has no PEM armor (*out NULL). */
static bool sp_der_of(const unsigned char *data, size_t len, unsigned char **out, const unsigned char **der,
                      size_t *der_len) {
  *out = NULL;
  const unsigned char *begin = NULL;
  for (size_t i = 0; i + 11 <= len; i++) {
    if (memcmp(data + i, "-----BEGIN ", 11) == 0) {
      begin = data + i;
      break;
    }
  }
  if (!begin) {
    *der = data;
    *der_len = len;
    return true;
  }
  const unsigned char *end = data + len;
  const unsigned char *body = memchr(begin, '\n', (size_t)(end - begin));
  if (!body) return false;
  body++;
  unsigned char *b64 = malloc((size_t)(end - body) + 1);
  unsigned char *raw = malloc((size_t)(end - body) + 1);
  if (!b64 || !raw) scr_trap("scriptc: out of memory\n");
  size_t n = 0;
  for (const unsigned char *p = body; p < end && *p != '-'; p++)
    if (*p != '\n' && *p != '\r' && *p != ' ' && *p != '\t') b64[n++] = *p;
  size_t raw_len = 0;
  bool ok = mbedtls_base64_decode(raw, (size_t)(end - body) + 1, &raw_len, b64, n) == 0;
  free(b64);
  if (!ok) {
    free(raw);
    return false;
  }
  *out = raw;
  *der = raw;
  *der_len = raw_len;
  return true;
}

/* The SubjectPublicKeyInfo element of an X.509 certificate's DER. */
static bool sp_cert_spki(const unsigned char *der, size_t len, const unsigned char **spki, size_t *spki_len) {
  unsigned char *p = (unsigned char *)der;
  const unsigned char *end = der + len;
  size_t n;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return false;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return false;
  const unsigned char *tbs_end = p + n;
  /* [0] version, serialNumber, signature, issuer, validity, subject */
  if (mbedtls_asn1_get_tag(&p, tbs_end, &n, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0) == 0)
    p += n;
  int tags[] = {MBEDTLS_ASN1_INTEGER, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE,
                MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE,
                MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE};
  for (size_t i = 0; i < 5; i++) {
    if (mbedtls_asn1_get_tag(&p, tbs_end, &n, tags[i]) != 0) return false;
    p += n;
  }
  const unsigned char *start = p;
  if (mbedtls_asn1_get_tag(&p, tbs_end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return false;
  *spki = start;
  *spki_len = (size_t)(p + n - start);
  return true;
}

/* An Ed25519 key from PKCS#8 or SubjectPublicKeyInfo DER, or (for a public
 * key) the key of an X.509 certificate; NULL when the DER is none of
 * these, or with *failed set and an error pending. A private key wanted
 * as public answers its public key. */
static SpKey *sp_ed_from_der(const unsigned char *der, size_t len, bool private_key, bool *failed) {
  *failed = false;
  /* X25519 keys, which need no other unit. */
  if (len == 48 && memcmp(der, sp_x_pkcs8_prefix, 16) == 0) {
    SpKey *k = sp_key_alloc(private_key);
    k->x25519 = true;
    memcpy(k->ed_seed, der + 16, 32);
    if (!sp_x25519(k->ed_seed, NULL, k->ed_pub)) {
      sp_key_release(k);
      return NULL;
    }
    if (!private_key) mbedtls_platform_zeroize(k->ed_seed, 32);
    return k;
  }
  if (!private_key && len == 44 && memcmp(der, sp_x_spki_prefix, 12) == 0) {
    SpKey *k = sp_key_alloc(false);
    k->x25519 = true;
    memcpy(k->ed_pub, der + 12, 32);
    return k;
  }
  if (len == 48 && memcmp(der, sp_ed_pkcs8_prefix, 16) == 0) {
    const ScrPkiEd25519 *ed = sp_ed();
    if (!ed) {
      *failed = true;
      return NULL;
    }
    SpKey *k = sp_key_alloc(private_key);
    k->ed25519 = true;
    ed->public_key(k->ed_pub, der + 16);
    if (private_key) memcpy(k->ed_seed, der + 16, 32);
    return k;
  }
  if (private_key) return NULL;
  const unsigned char *spki = der;
  size_t spki_len = len;
  if (!(len == 44 && memcmp(der, sp_ed_spki_prefix, 12) == 0) && !sp_cert_spki(der, len, &spki, &spki_len))
    return NULL;
  if (spki_len != 44 || memcmp(spki, sp_ed_spki_prefix, 12) != 0) return NULL;
  SpKey *k = sp_key_alloc(false);
  k->ed25519 = true;
  memcpy(k->ed_pub, spki + 12, 32);
  return k;
}

/* The name of a digest OID that RSASSA-PSS-params can hold and this
 * runtime does not sign with, for its refusal. */
static const char *sp_pss_other_digest(const mbedtls_asn1_buf *oid) {
  /* 2.16.840.1.101.3.4.2.x, the NIST hash arc */
  static const unsigned char nist[] = {0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02};
  if (oid->len == sizeof nist + 1 && memcmp(oid->p, nist, sizeof nist) == 0) {
    switch (oid->p[sizeof nist]) {
    case 0x05: return "sha512-224";
    case 0x06: return "sha512-256";
    case 0x07: return "sha3-224";
    case 0x08: return "sha3-256";
    case 0x09: return "sha3-384";
    case 0x0a: return "sha3-512";
    }
  }
  mbedtls_md_type_t md;
  if (mbedtls_oid_get_md_alg(oid, &md) == 0) {
    if (md == MBEDTLS_MD_MD5) return "md5";
    if (md == MBEDTLS_MD_RIPEMD160) return "ripemd160";
  }
  return "this digest";
}

/* RSASSA-PSS-params at *p (RFC 4055): 1 with the restrictions set on `k`;
 * 0 when they are malformed, which leaves the key without restrictions, as
 * OpenSSL reads a negative or oversized salt; -1 with *digest named when a
 * hash or MGF1 digest is one this runtime does not sign with, so that the
 * key is refused rather than imported without the restrictions it carries. */
static int sp_pss_params_read(unsigned char **p, const unsigned char *end, SpKey *k, const char **digest) {
  size_t n;
  if (mbedtls_asn1_get_tag(p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return 0;
  const unsigned char *params_end = *p + n;
  mbedtls_md_type_t md = MBEDTLS_MD_SHA1, mgf1 = MBEDTLS_MD_SHA1;
  int salt = 20;
  if (*p < params_end && **p == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0)) {
    mbedtls_asn1_buf oid, params;
    if (mbedtls_asn1_get_tag(p, params_end, &n, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0) != 0 ||
        mbedtls_asn1_get_alg(p, *p + n, &oid, &params) != 0)
      return 0;
    if (mbedtls_oid_get_md_alg(&oid, &md) != 0 || !sp_pss_md_name(md)) {
      *digest = sp_pss_other_digest(&oid);
      return -1;
    }
  }
  if (*p < params_end && **p == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1)) {
    mbedtls_asn1_buf oid, params;
    if (mbedtls_asn1_get_tag(p, params_end, &n, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1) != 0 ||
        mbedtls_asn1_get_alg(p, *p + n, &oid, &params) != 0 || oid.len != MBEDTLS_OID_SIZE(MBEDTLS_OID_MGF1) ||
        memcmp(oid.p, MBEDTLS_OID_MGF1, oid.len) != 0)
      return 0;
    /* MGF1's parameters are the hash's AlgorithmIdentifier, whose
     * content starts with the hash's OID. */
    if (params.tag != (MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) return 0;
    unsigned char *alg = params.p;
    mbedtls_asn1_buf hash_oid = {.tag = MBEDTLS_ASN1_OID};
    if (mbedtls_asn1_get_tag(&alg, params.p + params.len, &hash_oid.len, MBEDTLS_ASN1_OID) != 0) return 0;
    hash_oid.p = alg;
    if (mbedtls_oid_get_md_alg(&hash_oid, &mgf1) != 0 || !sp_pss_md_name(mgf1)) {
      *digest = sp_pss_other_digest(&hash_oid);
      return -1;
    }
  }
  if (*p < params_end && **p == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 2)) {
    if (mbedtls_asn1_get_tag(p, params_end, &n, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 2) != 0 ||
        mbedtls_asn1_get_int(p, *p + n, &salt) != 0 || salt < 0)
      return 0;
  }
  *p = (unsigned char *)params_end;
  k->pss_params = true;
  k->pss_md = md;
  k->pss_mgf1 = mgf1;
  k->pss_salt = salt;
  return 1;
}

/* An RSA-PSS key from PKCS#8 or SubjectPublicKeyInfo DER whose algorithm
 * is id-RSASSA-PSS; NULL when the DER is neither, or with *failed set and
 * Node's decoder error pending. A private key wanted as public answers its
 * public key. */
static SpKey *sp_public_of(SpKey *k);

static SpKey *sp_pss_from_der(const unsigned char *der, size_t len, bool private_key, bool *failed) {
  *failed = false;
  unsigned char *p = (unsigned char *)der;
  const unsigned char *end = der + len;
  size_t n;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return NULL;
  end = p + n;
  bool pkcs8 = p < end && *p == MBEDTLS_ASN1_INTEGER;
  if (pkcs8) {
    int version;
    if (mbedtls_asn1_get_int(&p, end, &version) != 0 || version != 0) return NULL;
  }
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return NULL;
  const unsigned char *alg_end = p + n;
  size_t oid_len;
  if (mbedtls_asn1_get_tag(&p, alg_end, &oid_len, MBEDTLS_ASN1_OID) != 0 ||
      oid_len != MBEDTLS_OID_SIZE(MBEDTLS_OID_RSASSA_PSS) || memcmp(p, MBEDTLS_OID_RSASSA_PSS, oid_len) != 0)
    return NULL;
  p += oid_len;
  SpKey *k = sp_key_alloc(pkcs8);
  k->rsa_pss = true;
  const char *digest = NULL;
  if (p < alg_end) {
    int read = sp_pss_params_read(&p, alg_end, k, &digest);
    if (read < 0) {
      sp_key_release(k);
      *failed = true;
      char what[96];
      snprintf(what, sizeof what, "RSA-PSS keys restricted to %s", digest);
      sp_not_supported(what);
      return NULL;
    }
    if (read == 0) k->pss_params = false;
  }
  p = (unsigned char *)alg_end;
  int r;
  if (pkcs8) {
    r = mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_OCTET_STRING);
    if (r == 0) r = mbedtls_pk_parse_key(&k->pk, p, n, NULL, 0, sp_random, NULL);
  } else {
    r = private_key ? -1 : mbedtls_asn1_get_bitstring_null(&p, end, &n);
    if (r == 0) r = mbedtls_pk_parse_public_key(&k->pk, p, n);
  }
  if (r != 0 || !sp_is_rsa(k)) {
    sp_key_release(k);
    *failed = true;
    sp_unsupported_input();
    return NULL;
  }
  if (pkcs8 && !private_key) {
    SpKey *pub = sp_public_of(k);
    sp_key_release(k);
    return pub;
  }
  return k;
}

/* Whether `der` is a PKCS#8 EncryptedPrivateKeyInfo: a SEQUENCE of a PKCS#5
 * or PKCS#12 password-based AlgorithmIdentifier and an OCTET STRING. */
static bool sp_is_encrypted_pkcs8(const unsigned char *der, size_t len) {
  unsigned char *p = (unsigned char *)der;
  const unsigned char *end = der + len;
  size_t n;
  mbedtls_asn1_buf alg, params;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return false;
  end = p + n;
  if (mbedtls_asn1_get_alg(&p, end, &alg, &params) != 0) return false;
  static const char pkcs5[] = MBEDTLS_OID_PKCS5, pkcs12[] = MBEDTLS_OID_PKCS12_PBE;
  bool password = (alg.len > sizeof pkcs5 - 1 && memcmp(alg.p, pkcs5, sizeof pkcs5 - 1) == 0) ||
                  (alg.len > sizeof pkcs12 - 1 && memcmp(alg.p, pkcs12, sizeof pkcs12 - 1) == 0);
  return password && mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_OCTET_STRING) == 0 && p + n == end;
}

static SpKey *sp_parse_with(const unsigned char *data, size_t len, bool private_key, const ScrBytes *pass);

static SpKey *sp_parse(const unsigned char *data, size_t len, bool private_key) {
  return sp_parse_with(data, len, private_key, NULL);
}

/* How many decoders OpenSSL runs over the body of an armored private key
 * before it gives up: one for the PKCS#8 labels, two for the traditional
 * RSA and EC labels (the type's decoder, then PKCS#8). 0 for input without
 * armor and for a label no private-key decoder takes. */
static size_t sp_pem_private_decoders(const unsigned char *data, size_t len) {
  static const struct { const char *label; size_t decoders; } labels[] = {
    {"PRIVATE KEY", 1}, {"ENCRYPTED PRIVATE KEY", 1}, {"RSA PRIVATE KEY", 2}, {"EC PRIVATE KEY", 2},
  };
  for (size_t at = 0; at + 11 <= len; at++) {
    if (memcmp(data + at, "-----BEGIN ", 11) != 0) continue;
    const unsigned char *label = data + at + 11;
    size_t rest = len - at - 11;
    for (size_t i = 0; i < sizeof labels / sizeof labels[0]; i++) {
      size_t n = strlen(labels[i].label);
      if (rest >= n + 5 && memcmp(label, labels[i].label, n) == 0 && memcmp(label + n, "-----", 5) == 0)
        return labels[i].decoders;
    }
    return 0;
  }
  return 0;
}

/* How OpenSSL's ASN.1 reader fails on the outer element of a DER body
 * that is not a key, as far as the element's header decides it: a header
 * whose length field cannot be read, a length that runs past the data, or
 * a complete element that is not a SEQUENCE. SP_OUTER_INSIDE for anything
 * else (a SEQUENCE that fails further in, an indefinite length, a
 * multi-byte tag): what OpenSSL reports there depends on where its parser
 * stops. */
enum { SP_OUTER_INSIDE, SP_OUTER_WRONG_TAG, SP_OUTER_HEADER_TOO_LONG, SP_OUTER_TOO_LONG };

static int sp_der_outer_failure(const unsigned char *der, size_t len) {
  if (len == 0 || (der[0] & 0x1f) == 0x1f) return SP_OUTER_INSIDE;
  if (len == 1) return SP_OUTER_HEADER_TOO_LONG; /* a tag and no length */
  size_t at = 2;
  size_t length = der[1];
  if (der[1] & 0x80) {
    size_t count = der[1] & 0x7f;
    if (count == 0) return SP_OUTER_INSIDE;
    if (count > len - at) return SP_OUTER_HEADER_TOO_LONG;
    while (count > 0 && der[at] == 0) {
      at++;
      count--;
    }
    if (count > sizeof(long)) return SP_OUTER_HEADER_TOO_LONG;
    length = 0;
    while (count-- > 0) length = (length << 8) | der[at++];
  }
  if (length > len - at) return SP_OUTER_TOO_LONG;
  return (der[0] & 0x1f) != 0x10 ? SP_OUTER_WRONG_TAG : SP_OUTER_INSIDE;
}

/* OpenSSL's "unsupported" for key material no decoder takes, as Node
 * reports it: library, reason and code, and the error stack. The stack
 * ends with the reported error. Before it come the errors of each decoder
 * that ran over an armored private key, when the outer element's header
 * decides them (sp_der_outer_failure); for a body that fails further in
 * they are left out. */
static void sp_unsupported_key_input(const unsigned char *data, size_t len) {
  static const char unsupported[] = "error:1E08010C:DECODER routines::unsupported";
  static const char nested[] = "error:0688010A:asn1 encoding routines::nested asn1 error";
  static const char wrong_tag[] = "error:068000A8:asn1 encoding routines::wrong tag";
  static const char bad_header[] = "error:06800066:asn1 encoding routines::bad object header";
  static const char header_too_long[] = "error:0680007B:asn1 encoding routines::header too long";
  static const char too_long[] = "error:0680009B:asn1 encoding routines::too long";
  const char *stack[7];
  size_t n = 0;
  size_t decoders = sp_pem_private_decoders(data, len);
  int failure = SP_OUTER_INSIDE;
  if (decoders > 0) {
    unsigned char *decoded;
    const unsigned char *der;
    size_t der_len;
    if (sp_der_of(data, len, &decoded, &der, &der_len)) {
      failure = sp_der_outer_failure(der, der_len);
      free(decoded);
    }
  }
  for (; failure != SP_OUTER_INSIDE && decoders > 0; decoders--) {
    stack[n++] = nested;
    if (failure == SP_OUTER_WRONG_TAG) {
      stack[n++] = wrong_tag;
    } else {
      stack[n++] = bad_header;
      stack[n++] = failure == SP_OUTER_HEADER_TOO_LONG ? header_too_long : too_long;
    }
  }
  stack[n++] = unsupported;
  sp_throw_key_decrypt(unsupported, "DECODER routines", "unsupported", "ERR_OSSL_UNSUPPORTED", stack, n);
}

/* sp_parse with a passphrase for an encrypted private key (NULL: none). */
static SpKey *sp_parse_with(const unsigned char *data, size_t len, bool private_key, const ScrBytes *pass) {
  {
    unsigned char *decoded;
    const unsigned char *der;
    size_t der_len;
    if (sp_der_of(data, len, &decoded, &der, &der_len) && sp_is_encrypted_pkcs8(der, der_len)) {
      bool from_pem = decoded != NULL;
      SpKey *k = NULL;
      unsigned char *plain = NULL;
      size_t plain_len = 0;
      int r = 0;
      if (!pass) {
        if (from_pem) sp_throw_passphrase_missing(true);
        else sp_throw(SCR_ERR_TYPE, "ERR_MISSING_PASSPHRASE", "Passphrase required for encrypted key");
      } else {
        r = sp_decrypt_pkcs8(der, der_len, pass->data, (size_t)scr_bytes_byte_len(pass), &plain, &plain_len);
        if (r < 0) sp_throw_bad_decrypt(from_pem ? 0 : 1);
      }
      if (r > 0) {
        k = sp_parse_with(plain, plain_len, private_key, NULL);
        mbedtls_platform_zeroize(plain, plain_len);
        free(plain);
      }
      if (decoded) {
        mbedtls_platform_zeroize(decoded, der_len);
        free(decoded);
      }
      if (r == 0 && pass) sp_not_supported("private keys encrypted with this scheme or cipher");
      return k;
    } else if (decoded) {
      mbedtls_platform_zeroize(decoded, der_len);
      free(decoded);
    }
  }
  {
    unsigned char *decoded;
    const unsigned char *der;
    size_t der_len;
    if (sp_der_of(data, len, &decoded, &der, &der_len)) {
      bool failed;
      SpKey *ed = sp_ed_from_der(der, der_len, private_key, &failed);
      if (!ed && !failed) ed = sp_pss_from_der(der, der_len, private_key, &failed);
      if (decoded) {
        mbedtls_platform_zeroize(decoded, der_len);
        free(decoded);
      }
      if (ed || failed) return ed;
    }
  }
  /* mbedtls reads PEM from a NUL-terminated buffer whose length counts the
   * NUL. */
  bool pem = false;
  for (size_t i = 0; i + 11 <= len; i++) {
    if (memcmp(data + i, "-----BEGIN ", 11) == 0) {
      pem = true;
      break;
    }
  }
  if (pem && !sp_pem_dek_check(data, len, pass)) return NULL;
  unsigned char *buf = malloc(len + 1);
  if (!buf) scr_trap("scriptc: out of memory\n");
  memcpy(buf, data, len);
  buf[len] = 0;
  size_t n = pem ? len + 1 : len;
  SpKey *k = sp_key_alloc(private_key);
  bool ok;
  const unsigned char *pwd = pass ? pass->data : NULL;
  size_t pwd_len = pass ? (size_t)scr_bytes_byte_len(pass) : 0;
  int private_rc = 0;
  if (private_key) {
    private_rc = mbedtls_pk_parse_key(&k->pk, buf, n, pwd, pwd_len, sp_random, NULL);
    ok = private_rc == 0;
  } else {
    ok = mbedtls_pk_parse_public_key(&k->pk, buf, n) == 0;
    if (!ok) {
      SpKey *priv = sp_key_alloc(true);
      mbedtls_pk_free(&k->pk);
      mbedtls_pk_init(&k->pk);
      if ((private_rc = mbedtls_pk_parse_key(&priv->pk, buf, n, pwd, pwd_len, sp_random, NULL)) == 0) {
        sp_key_release(k);
        k = sp_public_of(priv);
        ok = k != NULL;
        if (!k) k = sp_key_alloc(false);
      } else {
        mbedtls_x509_crt crt;
        mbedtls_x509_crt_init(&crt);
        if (mbedtls_x509_crt_parse(&crt, buf, n) == 0) {
          unsigned char der[SP_DER_MAX];
          int w = mbedtls_pk_write_pubkey_der(&crt.pk, der, sizeof der);
          ok = w > 0 && mbedtls_pk_parse_public_key(&k->pk, der + sizeof der - w, (size_t)w) == 0;
        }
        mbedtls_x509_crt_free(&crt);
      }
      sp_key_release(priv);
    }
  }
  mbedtls_platform_zeroize(buf, len);
  free(buf);
  if (!ok) {
    sp_key_release(k);
    /* An encrypted traditional PEM key mbedTLS read. */
    if (private_rc == MBEDTLS_ERR_PK_PASSWORD_REQUIRED) sp_throw_passphrase_missing(false);
    else if (private_rc == MBEDTLS_ERR_PK_PASSWORD_MISMATCH) sp_throw_bad_decrypt(2);
    else sp_unsupported_key_input(data, len);
    return NULL;
  }
  if (!sp_key_supported(k)) {
    sp_key_release(k);
    sp_not_supported("crypto keys of this type");
    return NULL;
  }
  return k;
}

/* The bytes of a string or buffer source, +1; NULL when `v` is neither. */
static ScrBytes *sp_source_bytes(const ScrDyn *v, const ScrDyn *encoding) {
  if (v->kind == SCR_DYN_STR) {
    bool named = encoding != NULL && encoding->kind == SCR_DYN_STR;
    ScrStr *utf8 = named ? NULL : scr_str_new("utf8", 4);
    ScrBytes *b = scr_bytes_from_str_checked(v->v.str, named ? encoding->v.str : utf8);
    if (utf8) scr_str_release(utf8);
    return b;
  }
  if (v->kind == SCR_DYN_BYTES || scr_buffer_storage_is(v)) return scr_bytes_buffer_source(v);
  return NULL;
}

static SpKey *sp_key_from_raw(const ScrDyn *input, const ScrDyn *data, const ScrDyn *format, bool private_input);

/* Which API reads a key: each has its own argument name, type list and
 * KeyObject rules, as Node's prepareAsymmetricKey passes them. */
typedef enum { SP_KEY_SIGN, SP_KEY_VERIFY, SP_KEY_CREATE_PRIVATE, SP_KEY_CREATE_PUBLIC } SpKeyContext;

/* Node's key type lists per API (lib/internal/crypto/keys.js). */
static const char *sp_key_types(SpKeyContext ctx) {
  switch (ctx) {
    case SP_KEY_SIGN:
      return "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, CryptoKey, or URL";
    case SP_KEY_VERIFY:
    case SP_KEY_CREATE_PUBLIC:
      return "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey";
    case SP_KEY_CREATE_PRIVATE:
    default:
      return "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, or URL";
  }
}

static bool sp_key_private_context(SpKeyContext ctx) {
  return ctx == SP_KEY_SIGN || ctx == SP_KEY_CREATE_PRIVATE;
}

/* Node's ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE. */
static void sp_invalid_key_object(const char *got, const char *expected) {
  scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
                    "Invalid key object type %s, expected %s.", got, expected);
}

/* The KeyObject rules of a context: createPrivateKey takes none,
 * createPublicKey and signing need a private key, and verification takes
 * either a private or a public one. */
static bool sp_key_object_ok(const ScrDyn *value, SpKeyContext ctx, const char *name) {
  if (ctx == SP_KEY_CREATE_PRIVATE) {
    scr_dyn_arg_type_fail(name, sp_key_types(ctx), value);
    return false;
  }
  const char *expected = ctx == SP_KEY_VERIFY ? "private or public" : "private";
  SpKey *object = sp_key_of(value);
  if (!object) {
    sp_invalid_key_object("secret", expected);
    return false;
  }
  if (!object->private_key && ctx != SP_KEY_VERIFY) {
    sp_invalid_key_object("public", expected);
    return false;
  }
  return true;
}

/* prepareAsymmetricKey's shape checks without decoding: the context's
 * KeyObject rules, null's destructuring error, and the type list for
 * anything that is neither key material nor an options object. */
static bool sp_key_shape_ok(const ScrDyn *value, SpKeyContext ctx, const char *name) {
  if (sp_key_of(value) || scr_crypto_is_key_object(value)) return sp_key_object_ok(value, ctx, name);
  if (value->kind == SCR_DYN_STR || value->kind == SCR_DYN_BYTES || scr_buffer_storage_is(value)) return true;
  if (value->kind == SCR_DYN_NULL) {
    scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "Cannot destructure property 'key' of '%s' as it is null.", name);
    return false;
  }
  if (value->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail(name, sp_key_types(ctx), value);
    return false;
  }
  const ScrDyn *data = sp_opt(value, "key");
  if (sp_key_of(data) || scr_crypto_is_key_object(data)) return sp_key_object_ok(data, ctx, name);
  const ScrDyn *format = sp_opt(value, "format");
  bool special = sp_is_str(format, "jwk") || sp_is_str(format, "raw-public") ||
                 sp_is_str(format, "raw-private") || sp_is_str(format, "raw-seed");
  if (!special && data->kind != SCR_DYN_STR && data->kind != SCR_DYN_BYTES && !scr_buffer_storage_is(data)) {
    char inner[96];
    snprintf(inner, sizeof inner, "%s.key", name);
    scr_dyn_arg_type_fail(inner, sp_key_types(ctx), data);
    return false;
  }
  return true;
}

/* createPrivateKey / createPublicKey, and the key preparation of signing
 * operations: a PEM string or buffer, or { key, format, type, encoding,
 * passphrase }; createPublicKey also takes a private KeyObject. The
 * default format is PEM, which rejects unarmored input, DER included;
 * `{ format: 'der', type }` reads DER. */
static ScrDyn *sp_create_key(ScrDyn *input, SpKeyContext ctx, const char *name) {
  bool private_key = sp_key_private_context(ctx);
  if (input->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(input);
    if (!value) return NULL;
    ScrDyn *result = sp_create_key(value, ctx, name);
    scr_dyn_release(value);
    return result;
  }
  if (input->kind == SCR_DYN_NULL) {
    scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "Cannot destructure property 'key' of '%s' as it is null.", name);
    return NULL;
  }
  if (sp_key_of(input) || scr_crypto_is_key_object(input)) {
    if (!sp_key_object_ok(input, ctx, name)) return NULL;
    SpKey *object = sp_key_of(input);
    if (ctx == SP_KEY_CREATE_PUBLIC) {
      SpKey *pub = sp_public_of(object);
      if (!pub) {
        sp_unsupported_input();
        return NULL;
      }
      return sp_key_box(pub);
    }
    return sp_key_box(sp_key_retain(object));
  }
  const ScrDyn *data = input;
  const ScrDyn *format = scr_dyn_undefined();
  const ScrDyn *type = scr_dyn_undefined();
  const ScrDyn *encoding = NULL;
  const ScrDyn *passphrase = NULL;
  if (sp_is_object(input) && !scr_buffer_storage_is(input)) {
    data = sp_opt(input, "key");
    format = sp_opt(input, "format");
    type = sp_opt(input, "type");
    encoding = sp_opt(input, "encoding");
    passphrase = sp_opt(input, "passphrase");
    if (!sp_absent(passphrase) && passphrase->kind != SCR_DYN_STR && passphrase->kind != SCR_DYN_BYTES &&
        !scr_buffer_storage_is(passphrase)) {
      sp_property_invalid("key.passphrase", passphrase);
      return NULL;
    }
    if (sp_key_of(data) || scr_crypto_is_key_object(data)) return sp_create_key((ScrDyn *)data, ctx, name);
    if (sp_is_str(format, "jwk")) {
      SpKey *k = sp_key_from_jwk(data, private_key);
      return k ? sp_key_box(k) : NULL;
    }
    if (sp_is_str(format, "raw-public") || sp_is_str(format, "raw-private") || sp_is_str(format, "raw-seed")) {
      SpKey *k = sp_key_from_raw(input, data, format, private_key);
      if (!k || private_key || !k->private_key) return k ? sp_key_box(k) : NULL;
      SpKey *pub = sp_public_of(k);
      sp_key_release(k);
      if (!pub) sp_unsupported_input();
      return pub ? sp_key_box(pub) : NULL;
    }
    if (!sp_absent(format) && !sp_is_str(format, "pem") && !sp_is_str(format, "der")) {
      sp_property_invalid("key.format", format);
      return NULL;
    }
    if (sp_is_str(format, "der")) {
      /* createPublicKey also reads a private key's encodings. */
      bool valid = sp_is_str(type, "pkcs1") || sp_is_str(type, "pkcs8") || sp_is_str(type, "sec1") ||
                   (!private_key && sp_is_str(type, "spki"));
      if (!valid) {
        sp_property_invalid("key.type", type);
        return NULL;
      }
    }
  }
  ScrBytes *bytes = sp_source_bytes(data, encoding);
  if (!bytes) {
    if (data->kind == SCR_DYN_STR || data->kind == SCR_DYN_BYTES || scr_buffer_storage_is(data))
      return NULL; /* the decoder threw */
    if (data == input) scr_dyn_arg_type_fail(name, sp_key_types(ctx), data);
    else {
      char inner[96];
      snprintf(inner, sizeof inner, "%s.key", name);
      scr_dyn_arg_type_fail(inner, sp_key_types(ctx), data);
    }
    return NULL;
  }
  /* The default format is PEM: OpenSSL's PEM decoder rejects input
   * without armor, DER bytes included. */
  bool armored = sp_is_str(format, "der");
  for (size_t i = 0; !armored && i + 11 <= (size_t)scr_bytes_byte_len(bytes); i++)
    if (memcmp(bytes->data + i, "-----BEGIN ", 11) == 0) armored = true;
  if (!armored) {
    /* The PEM decoder's own error: the unsupported reason with its stack. */
    sp_unsupported_key_input(bytes->data, (size_t)scr_bytes_byte_len(bytes));
    scr_bytes_release(bytes);
    return NULL;
  }
  ScrBytes *pass = NULL;
  if (passphrase && !sp_absent(passphrase)) {
    /* Node decodes a string passphrase with the key's encoding. */
    pass = sp_source_bytes(passphrase, encoding);
    if (!pass) {
      scr_bytes_release(bytes);
      return NULL;
    }
  }
  SpKey *k = sp_parse_with(bytes->data, (size_t)scr_bytes_byte_len(bytes), private_key, pass);
  if (pass) scr_bytes_release(pass);
  scr_bytes_release(bytes);
  return k ? sp_key_box(k) : NULL;
}

ScrDyn *scr_crypto_create_private_key(ScrDyn *key) { return sp_create_key(key, SP_KEY_CREATE_PRIVATE, "key"); }

ScrDyn *scr_crypto_create_public_key(ScrDyn *key) { return sp_create_key(key, SP_KEY_CREATE_PUBLIC, "key"); }

/* ── raw keys ─────────────────────────────────────────────────────────── */

/* A namedCurve as Node reads it: the OpenSSL short name or the NIST name,
 * matched exactly. NULL for other names. */
static const SpCurve *sp_curve_named(const ScrDyn *name) {
  for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
    if (sp_is_str(name, sp_curves[i].name) || (sp_curves[i].nist && sp_is_str(name, sp_curves[i].nist)))
      return &sp_curves[i];
  return NULL;
}

static void sp_incompatible_key_type(void) {
  sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS",
           "The selected key encoding is incompatible with the key type");
}

static void sp_invalid_key_data(void) { sp_throw(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", "Invalid key data"); }

/* A key's raw encoding: an EC public point, compressed when asked, or the
 * private scalar at the curve's size, or an Ed25519 public key or seed.
 * raw-seed, and every encoding of an RSA key, throw
 * ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS. NULL with the error pending. */
static ScrDyn *sp_export_raw(SpKey *k, bool private_part, bool seed, bool compressed) {
  if (seed || sp_is_rsa(k)) {
    sp_incompatible_key_type();
    return NULL;
  }
  if (sp_is_okp(k)) return sp_dyn_buffer(private_part ? k->ed_seed : k->ed_pub, 32);
  mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
  const mbedtls_ecp_group *grp = &ec->MBEDTLS_PRIVATE(grp);
  unsigned char buf[1 + 2 * 66];
  size_t n = (grp->nbits + 7) / 8;
  int form = compressed ? MBEDTLS_ECP_PF_COMPRESSED : MBEDTLS_ECP_PF_UNCOMPRESSED;
  int rc = private_part ? mbedtls_mpi_write_binary(&ec->MBEDTLS_PRIVATE(d), buf, n)
                        : mbedtls_ecp_point_write_binary(grp, &ec->MBEDTLS_PRIVATE(Q), form, &n, buf, sizeof buf);
  ScrDyn *out = rc == 0 ? sp_dyn_buffer(buf, n) : NULL;
  mbedtls_platform_zeroize(buf, sizeof buf);
  if (!out) sp_unsupported_input();
  return out;
}

/* Node's named key types that this runtime does not generate or read:
 * X448, Ed448 and the post-quantum types. */
static const char *const sp_other_named_types[] = {
    "ed448",
    "x448",
    "ml-dsa-44",
    "ml-dsa-65",
    "ml-dsa-87",
    "ml-kem-512",
    "ml-kem-768",
    "ml-kem-1024",
    "slh-dsa-sha2-128f",
    "slh-dsa-sha2-128s",
    "slh-dsa-sha2-192f",
    "slh-dsa-sha2-192s",
    "slh-dsa-sha2-256f",
    "slh-dsa-sha2-256s",
    "slh-dsa-shake-128f",
    "slh-dsa-shake-128s",
    "slh-dsa-shake-192f",
    "slh-dsa-shake-192s",
    "slh-dsa-shake-256f",
    "slh-dsa-shake-256s",
};

/* createPrivateKey / createPublicKey of { key, format: "raw-public" |
 * "raw-private" | "raw-seed", asymmetricKeyType, namedCurve }: an EC point
 * (uncompressed or compressed) or scalar, or an Ed25519 public key or
 * seed. The argument checks are Node's prepareAsymmetricKey order, then
 * the key type, the seed format, the curve and the data. NULL with the
 * error pending. */
static SpKey *sp_key_from_raw(const ScrDyn *input, const ScrDyn *data, const ScrDyn *format, bool private_input) {
  bool raw_public = sp_is_str(format, "raw-public");
  bool seed = sp_is_str(format, "raw-seed");
  if (private_input && raw_public) {
    sp_property_invalid("key.format", format);
    return NULL;
  }
  if (data->kind != SCR_DYN_BYTES && !scr_buffer_storage_is(data)) {
    scr_dyn_arg_type_fail("key.key", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", data);
    return NULL;
  }
  const ScrDyn *type = sp_opt(input, "asymmetricKeyType");
  if (type->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("key.asymmetricKeyType", "of type string", type);
    return NULL;
  }
  bool ec = sp_is_str(type, "ec");
  bool ed = sp_is_str(type, "ed25519");
  const ScrDyn *curve_name = sp_opt(input, "namedCurve");
  if (ec && curve_name->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("key.namedCurve", "of type string", curve_name);
    return NULL;
  }
  if (sp_is_str(type, "rsa") || sp_is_str(type, "rsa-pss") || sp_is_str(type, "dsa") || sp_is_str(type, "dh")) {
    sp_incompatible_key_type();
    return NULL;
  }
  bool x = sp_is_str(type, "x25519");
  bool other = false;
  for (size_t i = 0; i < sizeof sp_other_named_types / sizeof sp_other_named_types[0]; i++)
    other = other || sp_is_str(type, sp_other_named_types[i]);
  if (!ec && !ed && !x && !other) {
    ScrStr *s = type->v.str;
    scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", "Invalid asymmetricKeyType: %.*s", (int)s->len, s->data);
    return NULL;
  }
  bool ml = other && type->v.str->len > 3 && memcmp(type->v.str->data, "ml-", 3) == 0;
  if (seed && !ml) {
    sp_incompatible_key_type();
    return NULL;
  }
  if (other) {
    sp_not_supported("raw keys of this asymmetricKeyType");
    return NULL;
  }
  const SpCurve *curve = NULL;
  if (ec && !(curve = sp_curve_named(curve_name))) {
    sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
    return NULL;
  }
  ScrBytes *bytes = scr_bytes_buffer_source(data);
  if (!bytes) return NULL;
  const unsigned char *p = bytes->data;
  size_t len = (size_t)scr_bytes_byte_len(bytes);
  SpKey *k = sp_key_alloc(!raw_public);
  bool ok = false;
  if (x) {
    k->x25519 = true;
    if (len == 32 && raw_public) {
      memcpy(k->ed_pub, p, 32);
      ok = true;
    } else if (len == 32) {
      memcpy(k->ed_seed, p, 32);
      ok = sp_x25519(k->ed_seed, NULL, k->ed_pub);
    }
  } else if (ed) {
    k->ed25519 = true;
    if (len == 32 && raw_public) {
      memcpy(k->ed_pub, p, 32);
      ok = true;
    } else if (len == 32) {
      const ScrPkiEd25519 *eds = sp_ed();
      if (!eds) {
        sp_key_release(k);
        scr_bytes_release(bytes);
        return NULL;
      }
      memcpy(k->ed_seed, p, 32);
      eds->public_key(k->ed_pub, k->ed_seed);
      ok = true;
    }
  } else if (raw_public && len == 1 && p[0] == 0) {
    sp_key_release(k);
    scr_bytes_release(bytes);
    sp_not_supported("EC public keys at the point at infinity");
    return NULL;
  } else if (mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) == 0) {
    mbedtls_ecp_keypair *kp = mbedtls_pk_ec(k->pk);
    mbedtls_ecp_group *grp = &kp->MBEDTLS_PRIVATE(grp);
    ok = mbedtls_ecp_group_load(grp, curve->id) == 0;
    if (ok && raw_public) {
      ok = mbedtls_ecp_point_read_binary(grp, &kp->MBEDTLS_PRIVATE(Q), p, len) == 0 &&
           mbedtls_ecp_check_pubkey(grp, &kp->MBEDTLS_PRIVATE(Q)) == 0;
    } else if (ok) {
      ok = len == (grp->nbits + 7) / 8 && mbedtls_mpi_read_binary(&kp->MBEDTLS_PRIVATE(d), p, len) == 0;
      if (ok && mbedtls_ecp_check_privkey(grp, &kp->MBEDTLS_PRIVATE(d)) != 0) {
        sp_key_release(k);
        scr_bytes_release(bytes);
        sp_not_supported("EC private keys outside 1 to n - 1");
        return NULL;
      }
      ok = ok && mbedtls_ecp_mul(grp, &kp->MBEDTLS_PRIVATE(Q), &kp->MBEDTLS_PRIVATE(d), &grp->G, sp_random, NULL) == 0;
    }
  }
  scr_bytes_release(bytes);
  if (!ok) {
    sp_key_release(k);
    sp_invalid_key_data();
    return NULL;
  }
  return k;
}

/* ── export ───────────────────────────────────────────────────────────── */

/* export({ format, type }) per Node's parseKeyEncoding: format "pem",
 * "der" or "jwk"; type pkcs1/pkcs8/sec1 for private keys and pkcs1/spki
 * for public keys, where pkcs1 needs an RSA key and sec1 an EC key. */
static ScrDyn *sp_export_plain(SpKey *k, const ScrDyn *options);

static ScrDyn *sp_export(SpKey *k, const ScrDyn *options) {
  ScrDyn *plain = sp_plain(options);
  if (!plain) return NULL;
  ScrDyn *result = sp_export_plain(k, plain);
  scr_dyn_release(plain);
  return result;
}

static ScrDyn *sp_export_plain(SpKey *k, const ScrDyn *options) {
  const ScrDyn *format = sp_opt(options, "format");
  /* A private key's passphrase applies only to PEM and DER. */
  if (k->private_key && !sp_absent(sp_opt(options, "passphrase")) && !sp_is_str(format, "pem") &&
      !sp_is_str(format, "der")) {
    ScrStr *text = scr_dyn_string_coerce_js(format);
    if (!text) return NULL;
    scr_pki_throw_fmt(SCR_ERR_ERROR, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS",
                      "The selected key encoding %.*s does not support encryption.", (int)text->len, text->data);
    scr_str_release(text);
    return NULL;
  }
  if (!k->private_key && sp_is_str(format, "raw-public")) {
    const ScrDyn *type = sp_opt(options, "type");
    bool compressed = sp_is_str(type, "compressed");
    /* Only an EC point has a compressed form. */
    if (sp_is_ec(k) && !sp_absent(type) && !compressed && !sp_is_str(type, "uncompressed")) {
      ScrStr *received = sp_received(type, false);
      scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE",
                        "The property 'options.type' must be one of: 'compressed', 'uncompressed'. Received %.*s",
                        (int)received->len, received->data);
      scr_str_release(received);
      return NULL;
    }
    return sp_export_raw(k, false, false, sp_is_ec(k) && compressed);
  }
  if (k->private_key && (sp_is_str(format, "raw-private") || sp_is_str(format, "raw-seed")))
    return sp_export_raw(k, true, sp_is_str(format, "raw-seed"), false);
  if (options == NULL || !sp_is_object(options)) {
    scr_dyn_arg_type_fail("options", "of type object", options ? options : scr_dyn_undefined());
    return NULL;
  }
  if (sp_is_str(format, "jwk")) {
    if (k->rsa_pss) {
      sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", "Unsupported JWK Key Type.");
      return NULL;
    }
    return sp_export_jwk(k);
  }
  bool pem = sp_is_str(format, "pem");
  if (!pem && !sp_is_str(format, "der")) {
    sp_property_invalid("options.format", format);
    return NULL;
  }
  const ScrDyn *type = sp_opt(options, "type");
  bool pkcs1 = sp_is_str(type, "pkcs1");
  bool pkcs8 = k->private_key && sp_is_str(type, "pkcs8");
  bool sec1 = k->private_key && sp_is_str(type, "sec1");
  bool spki = !k->private_key && sp_is_str(type, "spki");
  if (!pkcs1 && !pkcs8 && !sec1 && !spki) {
    sp_property_invalid("options.type", type);
    return NULL;
  }
  if (pkcs1 && (!sp_is_rsa(k) || k->rsa_pss)) {
    sp_incompatible("pkcs1", "can only be used for RSA keys");
    return NULL;
  }
  if (sec1 && !sp_is_ec(k)) {
    sp_incompatible("sec1", "can only be used for EC keys");
    return NULL;
  }
  /* parseKeyEncoding's cipher and passphrase checks, then the cipher. */
  const ScrDyn *cipher = sp_opt(options, "cipher"), *passphrase = sp_opt(options, "passphrase");
  const SpKeyCipher *ci = NULL;
  if (k->private_key) {
    bool encrypted = !sp_absent(cipher) && cipher->kind != SCR_DYN_NULL;
    if (encrypted) {
      if (cipher->kind != SCR_DYN_STR) {
        sp_property_invalid("options.cipher", cipher);
        return NULL;
      }
      if (!pem && (pkcs1 || sec1)) {
        sp_incompatible(pkcs1 ? "pkcs1" : "sec1", "does not support encryption");
        return NULL;
      }
      if (passphrase->kind != SCR_DYN_STR && passphrase->kind != SCR_DYN_BYTES && !scr_buffer_storage_is(passphrase)) {
        sp_property_invalid("options.passphrase", passphrase);
        return NULL;
      }
      if (!sp_key_cipher(cipher->v.str, &ci)) return NULL;
    } else if (!sp_absent(passphrase)) {
      sp_property_invalid_because("options.cipher", cipher, "is required when a passphrase is specified");
      return NULL;
    }
  }
  unsigned char *der = malloc(SP_DER_MAX);
  if (!der) scr_trap("scriptc: out of memory\n");
  int n;
  const char *label;
  if (pkcs8) {
    n = sp_write_pkcs8_der(k, der, SP_DER_MAX);
    label = "PRIVATE KEY";
  } else if (spki) {
    n = sp_write_spki_der(k, der, SP_DER_MAX);
    label = "PUBLIC KEY";
  } else if (k->private_key) {
    n = sp_write_private_der(k, der, SP_DER_MAX);
    label = pkcs1 ? "RSA PRIVATE KEY" : "EC PRIVATE KEY";
  } else {
    n = sp_write_pkcs1_public_der(k, der, SP_DER_MAX);
    label = "RSA PUBLIC KEY";
  }
  ScrDyn *result = NULL;
  if (n < 0) {
    sp_unsupported_input();
  } else if (ci && !sp_key_cipher_ready(ci, pkcs8, (size_t)n)) {
    /* OpenSSL's error, raised once the key is encoded. */
  } else if (ci) {
    const unsigned char *start = der + SP_DER_MAX - n;
    ScrBytes *pass = sp_source_bytes(passphrase, sp_opt(options, "encoding"));
    const unsigned char *pass_data = pass ? pass->data : (const unsigned char *)"";
    size_t pass_len = pass ? (size_t)scr_bytes_byte_len(pass) : 0;
    if (pkcs8) {
      size_t enc_len;
      unsigned char *enc = sp_encrypt_pkcs8(start, (size_t)n, ci, pass_data, pass_len, &enc_len);
      if (enc) {
        result = pem ? sp_dyn_str(sp_pem("ENCRYPTED PRIVATE KEY", enc, enc_len)) : sp_dyn_buffer(enc, enc_len);
        free(enc);
      }
    } else {
      ScrStr *text = sp_encrypted_pem(label, start, (size_t)n, ci, pass_data, pass_len);
      if (text) result = sp_dyn_str(text);
    }
    if (pass) scr_bytes_release(pass);
    if (!result) sp_unsupported_input();
  } else {
    const unsigned char *start = der + SP_DER_MAX - n;
    result = pem ? sp_dyn_str(sp_pem(label, start, (size_t)n)) : sp_dyn_buffer(start, (size_t)n);
  }
  mbedtls_platform_zeroize(der, SP_DER_MAX);
  free(der);
  return result;
}

/* ── the KeyObject handles ────────────────────────────────────────────── */

static ScrDyn *sp_key_details(SpKey *k) {
  ScrDyn *details = scr_dyn_new_obj();
  if (sp_is_okp(k)) return details;
  if (sp_is_rsa(k)) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(k->pk);
    mbedtls_mpi e;
    mbedtls_mpi_init(&e);
    mbedtls_rsa_export(rsa, NULL, NULL, NULL, NULL, &e);
    uint64_t exponent = 0;
    size_t bytes = mbedtls_mpi_size(&e);
    unsigned char raw[8] = {0};
    if (bytes <= 8) mbedtls_mpi_write_binary(&e, raw, 8);
    for (size_t i = 0; i < 8; i++) exponent = (exponent << 8) | raw[i];
    mbedtls_mpi_free(&e);
    sp_set(details, "modulusLength", scr_dyn_new_num((double)mbedtls_pk_get_bitlen(&k->pk)));
    ScrBigInt *big = scr_bigint_from_u64(exponent);
    sp_set(details, "publicExponent", scr_dyn_new_bigint(big));
    scr_bigint_release(big);
    if (k->pss_params) {
      const char *md = sp_pss_md_name(k->pss_md), *mgf1 = sp_pss_md_name(k->pss_mgf1);
      sp_set(details, "hashAlgorithm", sp_dyn_str(scr_str_new(md, strlen(md))));
      sp_set(details, "mgf1HashAlgorithm", sp_dyn_str(scr_str_new(mgf1, strlen(mgf1))));
      sp_set(details, "saltLength", scr_dyn_new_num(k->pss_salt));
    }
  } else {
    const SpCurve *curve = sp_curve_of(k);
    sp_set(details, "namedCurve", sp_dyn_str(scr_str_new(curve->name, strlen(curve->name))));
  }
  return details;
}

/* The DER that identifies a key for equals(): its private encoding for a
 * private key, its SubjectPublicKeyInfo otherwise. */
static int sp_identity_der(SpKey *k, unsigned char *buf, size_t size) {
  if (sp_is_okp(k)) return k->private_key ? sp_write_pkcs8_der(k, buf, size) : sp_write_spki_der(k, buf, size);
  return k->private_key ? sp_write_private_der(k, buf, size) : sp_write_spki_der(k, buf, size);
}

static ScrDyn *sp_key_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what) {
  (void)self;
  SpKey *k = h;
  if (strcmp(method, "export") == 0) return sp_export(k, argc ? args[0] : NULL);
  if (strcmp(method, "equals") == 0) {
    const ScrDyn *other_value = argc ? args[0] : scr_dyn_undefined();
    SpKey *other = sp_key_of(other_value);
    if (!other) {
      size_t len;
      if (scr_key_object_bytes(other_value, &len)) return scr_dyn_new_bool(false);
      scr_dyn_arg_type_fail("otherKeyObject", "an instance of KeyObject", other_value);
      return NULL;
    }
    if (other->private_key != k->private_key ||
        mbedtls_pk_get_type(&other->pk) != mbedtls_pk_get_type(&k->pk))
      return scr_dyn_new_bool(false);
    unsigned char *a = malloc(SP_DER_MAX), *b = malloc(SP_DER_MAX);
    if (!a || !b) scr_trap("scriptc: out of memory\n");
    int na = sp_identity_der(k, a, SP_DER_MAX);
    int nb = sp_identity_der(other, b, SP_DER_MAX);
    bool same = na > 0 && na == nb && memcmp(a + SP_DER_MAX - na, b + SP_DER_MAX - nb, (size_t)na) == 0;
    mbedtls_platform_zeroize(a, SP_DER_MAX);
    mbedtls_platform_zeroize(b, SP_DER_MAX);
    free(a);
    free(b);
    return scr_dyn_new_bool(same);
  }
  if (strcmp(method, "toCryptoKey") == 0) {
    sp_not_supported("KeyObject.toCryptoKey");
    return NULL;
  }
  scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "%s is not a function", what);
  return NULL;
}

static ScrDyn *sp_key_get(void *h, const char *name, size_t len) {
  SpKey *k = h;
  if (len == 4 && memcmp(name, "type", 4) == 0)
    return k->private_key ? sp_dyn_str(scr_str_new("private", 7)) : sp_dyn_str(scr_str_new("public", 6));
  if (len == 17 && memcmp(name, "asymmetricKeyType", 17) == 0)
    return sp_is_ed(k)    ? sp_dyn_str(scr_str_new("ed25519", 7))
           : sp_is_x(k)   ? sp_dyn_str(scr_str_new("x25519", 6))
           : k->rsa_pss   ? sp_dyn_str(scr_str_new("rsa-pss", 7))
           : sp_is_rsa(k) ? sp_dyn_str(scr_str_new("rsa", 3))
                          : sp_dyn_str(scr_str_new("ec", 2));
  if (len == 20 && memcmp(name, "asymmetricKeyDetails", 20) == 0) return sp_key_details(k);
  return NULL;
}

static bool sp_key_set(void *h, const char *name, size_t len, const ScrDyn *value) {
  (void)h;
  (void)value;
  const char *holder = len == 4 && memcmp(name, "type", 4) == 0 ? "KeyObject"
                       : (len == 17 && memcmp(name, "asymmetricKeyType", 17) == 0) ||
                               (len == 20 && memcmp(name, "asymmetricKeyDetails", 20) == 0)
                           ? "AsymmetricKeyObject"
                           : NULL;
  if (!holder) return false;
  scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "Cannot set property %.*s of #<%s> which has only a getter", (int)len, name,
                    holder);
  return true;
}

static ScrDyn *sp_key_inspect_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

static const ScrDynHandleOps sp_private_ops = {
    .cls = "PrivateKeyObject",
    .retain = sp_key_retain,
    .release = sp_key_release,
    .invoke = sp_key_invoke,
    .get = sp_key_get,
    .set = sp_key_set,
    .inspect_view = sp_key_inspect_view,
    .json_empty_object = true,
    .to_string_tag = "KeyObject",
    .inspect_view_empty = true,
};

static const ScrDynHandleOps sp_public_ops = {
    .cls = "PublicKeyObject",
    .retain = sp_key_retain,
    .release = sp_key_release,
    .invoke = sp_key_invoke,
    .get = sp_key_get,
    .set = sp_key_set,
    .inspect_view = sp_key_inspect_view,
    .json_empty_object = true,
    .to_string_tag = "KeyObject",
    .inspect_view_empty = true,
};

/* createHmac with a private or public key (scr_crypto_reject_asymmetric_secret). */
static void sp_reject_as_secret(const ScrDyn *key) {
  scr_crypto_invalid_key_object_type(key->v.handle.tag == SCR_DYNH_PRIVATE_KEY);
}

static void sp_key_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_PRIVATE_KEY, &sp_private_ops);
  scr_dyn_handle_install(SCR_DYNH_PUBLIC_KEY, &sp_public_ops);
  scr_crypto_reject_asymmetric_secret = sp_reject_as_secret;
}

/* ── generateKeyPairSync ──────────────────────────────────────────────── */

/* A key in the encoding an options.publicKeyEncoding/privateKeyEncoding
 * object asks for, or the KeyObject when it is undefined or null.
 * Consumes `k`. */
static ScrDyn *sp_encoded(SpKey *k, const ScrDyn *encoding) {
  if (sp_absent(encoding) || encoding->kind == SCR_DYN_NULL) return sp_key_box(k);
  ScrDyn *result = sp_export(k, encoding);
  sp_key_release(k);
  return result;
}

/* validateObject: an object other than null or an array (typeof
 * "object"); false with ERR_INVALID_ARG_TYPE pending. */
static bool sp_check_object(const ScrDyn *v, const char *name) {
  if (v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_ARR && scr_dyn_is_object(v)) return true;
  scr_dyn_arg_type_fail(name, "of type object", v);
  return false;
}

/* validateUint32 for an option: a number, then an integer, then the
 * range; -0 reads as 0. False with the error pending. */
static bool sp_check_uint32(const ScrDyn *v, const char *name, double *out) {
  if (v->kind != SCR_DYN_NUM) {
    scr_dyn_prop_type_fail(name, "of type number", v);
    return false;
  }
  double x = v->v.num;
  bool integer = isfinite(x) && trunc(x) == x;
  if (!integer || x < 0 || x > 4294967295.0) {
    ScrStr *received = sp_received(v, true);
    scr_pki_throw_fmt(SCR_ERR_RANGE, "ERR_OUT_OF_RANGE",
                      "The value of \"%s\" is out of range. It must be %s. Received %.*s", name,
                      integer ? ">= 0 && <= 4294967295" : "an integer", (int)received->len, received->data);
    scr_str_release(received);
    return false;
  }
  *out = x + 0.0;
  return true;
}

static bool sp_check_encoding_plain(const ScrDyn *enc, const char *name, const ScrDyn *type, bool private_key,
                                    const char **refusal);

/* Node's parseKeyEncoding for options.publicKeyEncoding or
 * options.privateKeyEncoding of a `type` key: true when the encoding is
 * undefined, null or valid, false with the error pending. A valid
 * encrypted encoding, which this runtime does not write, sets *refusal
 * when it is unset. */
static bool sp_check_encoding(const ScrDyn *options, const char *key, const ScrDyn *type, bool private_key,
                              const char **refusal) {
  ScrDyn *enc = sp_plain(sp_opt(options, key));
  if (!enc) return false;
  char name[64];
  snprintf(name, sizeof name, "options.%s", key);
  bool ok = sp_check_encoding_plain(enc, name, type, private_key, refusal);
  scr_dyn_release(enc);
  return ok;
}

static bool sp_check_encoding_plain(const ScrDyn *enc, const char *name, const ScrDyn *type, bool private_key,
                                    const char **refusal) {
  if (sp_absent(enc) || enc->kind == SCR_DYN_NULL) return true;
  if (!scr_dyn_is_object(enc)) {
    sp_property_invalid(name, enc);
    return false;
  }
  if (!sp_check_object(enc, "options")) return false;
  /* Node's isPublic: true for a public key encoding of a non-empty type,
   * false for a private key encoding, and unset otherwise. */
  bool is_public = !private_key && type->v.str->len > 0;
  char full[96];
  const ScrDyn *format = sp_opt(enc, "format");
  const ScrDyn *kind = sp_opt(enc, "type");
  bool raw_public = sp_is_str(format, "raw-public");
  bool raw_private = sp_is_str(format, "raw-private") || sp_is_str(format, "raw-seed");
  bool jwk = sp_is_str(format, "jwk");
  bool der = sp_is_str(format, "der");
  if ((!raw_public && !raw_private && !jwk && !der && !sp_is_str(format, "pem")) || (raw_public && private_key) ||
      (raw_private && is_public)) {
    snprintf(full, sizeof full, "%s.format", name);
    sp_property_invalid(full, format);
    return false;
  }
  bool pkcs1 = false, sec1 = false;
  if (raw_public || raw_private) {
    if (!sp_absent(kind) &&
        !(raw_public && (sp_is_str(kind, "uncompressed") || sp_is_str(kind, "compressed")))) {
      snprintf(full, sizeof full, "%s.type", name);
      sp_property_invalid(full, kind);
      return false;
    }
  } else {
    pkcs1 = sp_is_str(kind, "pkcs1");
    sec1 = !is_public && sp_is_str(kind, "sec1");
    bool valid = (jwk && sp_absent(kind)) || pkcs1 || sec1 || (!private_key && sp_is_str(kind, "spki")) ||
                 (!is_public && sp_is_str(kind, "pkcs8"));
    if (!valid) {
      snprintf(full, sizeof full, "%s.type", name);
      sp_property_invalid(full, kind);
      return false;
    }
    if (pkcs1 && !sp_is_str(type, "rsa")) {
      sp_incompatible("pkcs1", "can only be used for RSA keys");
      return false;
    }
    if (sec1 && !sp_is_str(type, "ec")) {
      sp_incompatible("sec1", "can only be used for EC keys");
      return false;
    }
  }
  bool encrypted = false;
  if (!is_public) {
    const ScrDyn *cipher = sp_opt(enc, "cipher");
    const ScrDyn *passphrase = sp_opt(enc, "passphrase");
    encrypted = !sp_absent(cipher) && cipher->kind != SCR_DYN_NULL;
    if (raw_private) {
      if (encrypted || !sp_absent(passphrase)) {
        sp_incompatible("raw format", "does not support encryption");
        return false;
      }
    } else if (encrypted) {
      if (cipher->kind != SCR_DYN_STR) {
        snprintf(full, sizeof full, "%s.cipher", name);
        sp_property_invalid(full, cipher);
        return false;
      }
      if (der && (pkcs1 || sec1)) {
        sp_incompatible(pkcs1 ? "pkcs1" : "sec1", "does not support encryption");
        return false;
      }
      if (passphrase->kind != SCR_DYN_STR && passphrase->kind != SCR_DYN_BYTES && !scr_buffer_storage_is(passphrase)) {
        snprintf(full, sizeof full, "%s.passphrase", name);
        sp_property_invalid(full, passphrase);
        return false;
      }
    } else if (!sp_absent(passphrase)) {
      snprintf(full, sizeof full, "%s.cipher", name);
      sp_property_invalid_because(full, cipher, "is required when a passphrase is specified");
      return false;
    }
  }
  (void)encrypted;
  return true;
}

/* The key generateKeyPair makes, as sp_keygen_check reads it. */
typedef struct {
  enum { SP_GEN_RSA, SP_GEN_EC, SP_GEN_ED25519, SP_GEN_X25519 } kind;
  double bits, exponent; /* RSA */
  bool pss;              /* an RSA-PSS key, restricted when pss_params */
  bool pss_params, md_set, mgf1_set, salt_set;
  mbedtls_md_type_t md, mgf1;
  int salt;
  const SpCurve *curve;  /* EC */
} SpKeyGen;


static bool sp_digest_of(const ScrStr *name, mbedtls_md_type_t *md);

/* A digest name of rsa-pss's options: true with *md set, or false with
 * Node's ERR_CRYPTO_INVALID_DIGEST pending ("Invalid digest: x" or "Invalid
 * MGF1 digest: x"), or the SC2020 refusal for a digest OpenSSL has and
 * RSASSA-PSS-params here cannot name. */
static bool sp_pss_digest(const ScrDyn *name, bool mgf1, mbedtls_md_type_t *md) {
  if (sp_digest_of(name->v.str, md) && sp_pss_md_name(*md)) return true;
  if (scr_digest_known(name->v.str->data, name->v.str->len)) {
    sp_not_supported("generateKeyPair rsa-pss with this digest");
    return false;
  }
  scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_DIGEST", "Invalid %sdigest: %.*s", mgf1 ? "MGF1 " : "",
                    (int)name->v.str->len, name->v.str->data);
  return false;
}

/* rsa-pss's options after the modulus and exponent, in Node's order
 * (lib/internal/crypto/keygen.js): saltLength, hashAlgorithm,
 * mgf1HashAlgorithm, and the deprecated hash and mgf1Hash with their
 * DEP0154 warnings, then the digest lookups of RsaKeyGenTraits. */
static bool sp_pss_keygen_options(const ScrDyn *options, SpKeyGen *gen) {
  const ScrDyn *salt = sp_opt(options, "saltLength");
  const ScrDyn *hash_alg = sp_opt(options, "hashAlgorithm"), *mgf1_alg = sp_opt(options, "mgf1HashAlgorithm");
  const ScrDyn *hash = sp_opt(options, "hash"), *mgf1_hash = sp_opt(options, "mgf1Hash");
  if (!sp_absent(salt)) {
    if (salt->kind != SCR_DYN_NUM) {
      scr_dyn_prop_type_fail("options.saltLength", "of type number", salt);
      return false;
    }
    double x = salt->v.num;
    bool integer = isfinite(x) && trunc(x) == x;
    if (!integer || x < 0 || x > 2147483647.0) {
      ScrStr *received = sp_received(salt, true);
      scr_pki_throw_fmt(SCR_ERR_RANGE, "ERR_OUT_OF_RANGE",
                        "The value of \"options.saltLength\" is out of range. It must be %s. Received %.*s",
                        integer ? ">= 0 && <= 2147483647" : "an integer", (int)received->len, received->data);
      scr_str_release(received);
      return false;
    }
    gen->salt_set = true;
    gen->salt = (int)x;
  }
  if (!sp_absent(hash_alg) && hash_alg->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("options.hashAlgorithm", "of type string", hash_alg);
    return false;
  }
  if (!sp_absent(mgf1_alg) && mgf1_alg->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("options.mgf1HashAlgorithm", "of type string", mgf1_alg);
    return false;
  }
  const struct {
    const ScrDyn *value, *preferred;
    const char *name, *preferred_name;
  } deprecated[] = {
    {hash, hash_alg, "options.hash", "options.hashAlgorithm"},
    {mgf1_hash, mgf1_alg, "options.mgf1Hash", "options.mgf1HashAlgorithm"},
  };
  for (size_t i = 0; i < 2; i++) {
    if (sp_absent(deprecated[i].value)) continue;
    ScrJsonBuf text;
    scr_jb_init(&text);
    scr_jb_puts(&text, "\"");
    scr_jb_puts(&text, deprecated[i].name);
    scr_jb_puts(&text, "\" is deprecated, use \"");
    scr_jb_puts(&text, deprecated[i].preferred_name);
    scr_jb_puts(&text, "\" instead.");
    /* process.emitWarning: reported on the next tick, dropped under
     * process.noDeprecation, and thrown from its own tick under
     * process.throwDeprecation. */
    ScrStr *message = scr_jb_finish(&text);
    ScrStr *code = scr_str_new("DEP0154", 7);
    ScrDyn *warning = scr_warning_new(message, "DeprecationWarning", code);
    scr_str_release(code);
    scr_str_release(message);
    scr_warning_emit_deferred(warning);
    scr_dyn_release(warning);
    if (deprecated[i].value->kind != SCR_DYN_STR) {
      scr_dyn_prop_type_fail(deprecated[i].name, "of type string", deprecated[i].value);
      return false;
    }
    const ScrDyn *preferred = deprecated[i].preferred;
    if (preferred->kind == SCR_DYN_STR && preferred->v.str->len > 0 &&
        !scr_str_eq(preferred->v.str, deprecated[i].value->v.str)) {
      sp_property_invalid(deprecated[i].name, deprecated[i].value);
      return false;
    }
  }
  /* `hashAlgorithm || hash`: an empty string reads as absent. */
  const ScrDyn *md = hash_alg->kind == SCR_DYN_STR && hash_alg->v.str->len > 0 ? hash_alg : hash;
  const ScrDyn *mgf1 = mgf1_alg->kind == SCR_DYN_STR && mgf1_alg->v.str->len > 0 ? mgf1_alg : mgf1_hash;
  if (md->kind == SCR_DYN_STR) {
    if (!sp_pss_digest(md, false, &gen->md)) return false;
    gen->md_set = true;
  }
  if (mgf1->kind == SCR_DYN_STR) {
    if (!sp_pss_digest(mgf1, true, &gen->mgf1)) return false;
    gen->mgf1_set = true;
  }
  /* OpenSSL's defaults: MGF1 over the digest and a salt of the digest's
   * length once a digest is given, SHA-1 and 20 otherwise. */
  gen->pss_params = gen->md_set || gen->mgf1_set || gen->salt_set;
  if (!gen->md_set) gen->md = MBEDTLS_MD_SHA1;
  if (!gen->mgf1_set) gen->mgf1 = gen->md;
  if (!gen->salt_set) gen->salt = gen->md_set ? (int)mbedtls_md_get_size(mbedtls_md_info_from_type(gen->md)) : 20;
  return true;
}

/* createJob's checks for generateKeyPair(Sync)(type, options) in Node's
 * order: the type, the options object, the public and private key
 * encodings, then the options of the type. False with the error pending.
 * The forms this runtime does not generate throw a coded SC2020 error
 * after all of these checks. */
static bool sp_keygen_check(const ScrDyn *type, const ScrDyn *options, SpKeyGen *gen) {
  if (type->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("type", "of type string", type);
    return false;
  }
  if (!sp_absent(options) && !sp_check_object(options, "options")) return false;
  const char *refusal = NULL;
  if (!sp_check_encoding(options, "publicKeyEncoding", type, false, &refusal) ||
      !sp_check_encoding(options, "privateKeyEncoding", type, true, &refusal))
    return false;
  bool pss = sp_is_str(type, "rsa-pss");
  if (sp_is_str(type, "rsa") || pss) {
    if (!sp_check_object(options, "options")) return false;
    gen->kind = SP_GEN_RSA;
    if (!sp_check_uint32(sp_opt(options, "modulusLength"), "options.modulusLength", &gen->bits)) return false;
    const ScrDyn *exponent = sp_opt(options, "publicExponent");
    gen->exponent = 65537;
    if (!sp_absent(exponent) && exponent->kind != SCR_DYN_NULL &&
        !sp_check_uint32(exponent, "options.publicExponent", &gen->exponent))
      return false;
    gen->pss = pss;
    if (pss && !sp_pss_keygen_options(options, gen)) return false;
  } else if (sp_is_str(type, "dsa") || sp_is_str(type, "dh")) {
    if (!sp_check_object(options, "options")) return false;
    if (!refusal) refusal = "generateKeyPairSync for this key type";
  } else if (sp_is_str(type, "ec")) {
    if (!sp_check_object(options, "options")) return false;
    gen->kind = SP_GEN_EC;
    const ScrDyn *curve_name = sp_opt(options, "namedCurve");
    if (curve_name->kind != SCR_DYN_STR) {
      scr_dyn_prop_type_fail("options.namedCurve", "of type string", curve_name);
      return false;
    }
    const ScrDyn *param = sp_opt(options, "paramEncoding");
    if (sp_is_str(param, "explicit")) {
      if (!refusal) refusal = "generateKeyPair with paramEncoding 'explicit'";
    } else if (!sp_absent(param) && param->kind != SCR_DYN_NULL && !sp_is_str(param, "named")) {
      sp_property_invalid("options.paramEncoding", param);
      return false;
    }
    gen->curve = NULL;
    for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
      if (sp_is_str(curve_name, sp_curves[i].name) ||
          (sp_curves[i].nist && sp_is_str(curve_name, sp_curves[i].nist)))
        gen->curve = &sp_curves[i];
    if (!gen->curve) {
      sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
      return false;
    }
  } else if (sp_is_str(type, "ed25519")) {
    gen->kind = SP_GEN_ED25519;
  } else if (sp_is_str(type, "x25519")) {
    gen->kind = SP_GEN_X25519;
  } else {
    bool named = false;
    for (size_t i = 0; i < sizeof sp_other_named_types / sizeof sp_other_named_types[0]; i++)
      named = named || sp_is_str(type, sp_other_named_types[i]);
    if (!named) {
      ScrStr *received = sp_received(type, false);
      scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE",
                        "The argument 'type' must be a supported key type. Received %.*s", (int)received->len,
                        received->data);
      scr_str_release(received);
      return false;
    }
    if (!refusal) refusal = "generateKeyPairSync for this key type";
  }
  /* The job's private key cipher, which Node looks up once the options
   * of the type are read. */
  {
    const ScrDyn *enc = sp_opt(options, "privateKeyEncoding");
    const ScrDyn *cipher = sp_is_object(enc) ? sp_opt(enc, "cipher") : scr_dyn_undefined();
    const SpKeyCipher *ci;
    if (cipher->kind == SCR_DYN_STR) {
      if (!sp_key_cipher(cipher->v.str, &ci)) return false;
      /* OpenSSL's errors for the cipher come from the export once the
       * key is generated; a cipher it encrypts with and keys here do not
       * is refused first. */
      bool pkcs8 = sp_is_str(sp_opt(enc, "type"), "pkcs8");
      if (ci->type == MBEDTLS_CIPHER_NONE && (pkcs8 ? ci->pkcs8_error : ci->traditional_error) == SP_KC_OK &&
          !refusal)
        refusal = "private keys encrypted with this cipher";
    }
  }
  if (refusal) {
    sp_not_supported(refusal);
    return false;
  }
  return gen->kind != SP_GEN_ED25519 || sp_ed() != NULL;
}

/* An RSA key of `bits` bits with public exponent `exponent`, within
 * OpenSSL's limits rather than mbedtls_rsa_gen_key's (even lengths from
 * 1024 bits, exponents up to INT_MAX): any length from 512 bits and odd
 * exponents up to 2^32 - 1. From 2048 bits OpenSSL generates two primes
 * of equal length (SP 800-56B), so an odd length yields one bit less.
 * The primes have (bits + 1) / 2 and bits / 2 bits, each with its top
 * bits set (mbedtls_mpi_gen_prime's FIPS 186-4 bound), so their product
 * has exactly `bits` bits; each prime minus one is coprime to the
 * exponent. 0 on success. */
static int sp_rsa_generate(mbedtls_rsa_context *rsa, unsigned bits, uint64_t exponent) {
  if (bits >= 2048) bits &= ~1u;
  mbedtls_mpi P, Q, E, N, T, G;
  mbedtls_mpi_init(&P);
  mbedtls_mpi_init(&Q);
  mbedtls_mpi_init(&E);
  mbedtls_mpi_init(&N);
  mbedtls_mpi_init(&T);
  mbedtls_mpi_init(&G);
  unsigned char e_bytes[8];
  for (int i = 0; i < 8; i++) e_bytes[i] = (unsigned char)(exponent >> (56 - 8 * i));
  int r = mbedtls_mpi_read_binary(&E, e_bytes, sizeof e_bytes);
  const int flags = MBEDTLS_MPI_GEN_PRIME_FLAG_LOW_ERR;
  while (r == 0) {
    r = mbedtls_mpi_gen_prime(&P, (bits + 1) / 2, flags, sp_random, NULL);
    if (r == 0) r = mbedtls_mpi_sub_int(&T, &P, 1);
    if (r == 0) r = mbedtls_mpi_gcd(&G, &E, &T);
    if (r != 0 || mbedtls_mpi_cmp_int(&G, 1) != 0) continue;
    r = mbedtls_mpi_gen_prime(&Q, bits / 2, flags, sp_random, NULL);
    if (r == 0) r = mbedtls_mpi_sub_int(&T, &Q, 1);
    if (r == 0) r = mbedtls_mpi_gcd(&G, &E, &T);
    if (r != 0 || mbedtls_mpi_cmp_int(&G, 1) != 0 || mbedtls_mpi_cmp_mpi(&P, &Q) == 0) continue;
    r = mbedtls_mpi_mul_mpi(&N, &P, &Q);
    if (r == 0 && mbedtls_mpi_bitlen(&N) == bits) break;
  }
  /* The larger prime is p, as OpenSSL orders them. */
  if (r == 0 && mbedtls_mpi_cmp_mpi(&P, &Q) < 0) mbedtls_mpi_swap(&P, &Q);
  if (r == 0) r = mbedtls_rsa_import(rsa, &N, &P, &Q, NULL, &E);
  if (r == 0) r = mbedtls_rsa_complete(rsa);
  if (r == 0) r = mbedtls_rsa_check_privkey(rsa);
  mbedtls_mpi_free(&P);
  mbedtls_mpi_free(&Q);
  mbedtls_mpi_free(&E);
  mbedtls_mpi_free(&N);
  mbedtls_mpi_free(&T);
  mbedtls_mpi_free(&G);
  return r;
}

/* OpenSSL's error for an RSA modulus length or public exponent it does not
 * generate, as Node reports it, or NULL. */
static const char *sp_rsa_keygen_failure(double bits, double exponent) {
  if (bits < 512) return "error:1C8000AB:Provider routines::key size too small";
  if (exponent == 0) return "Key generation job failed";
  if (bits > 2147483647.0) return "error:02000078:rsa routines::key size too small";
  if (exponent == 1 || fmod(exponent, 2) == 0) return "error:020000B2:rsa routines::pub exponent out of range";
  return NULL;
}

/* Generates the key `gen` describes: NULL with the error pending, and
 * *job_error set for the errors generateKeyPair passes to its callback. */
static SpKey *sp_keygen_run(const SpKeyGen *gen, bool *job_error) {
  *job_error = false;
  SpKey *k = sp_key_alloc(true);
  if (gen->kind == SP_GEN_ED25519) {
    k->ed25519 = true;
    sp_random(NULL, k->ed_seed, 32);
    scr_pki_ed25519->public_key(k->ed_pub, k->ed_seed);
    return k;
  }
  if (gen->kind == SP_GEN_X25519) {
    /* OpenSSL stores a generated X25519 key clamped. */
    k->x25519 = true;
    sp_random(NULL, k->ed_seed, 32);
    k->ed_seed[0] &= 248;
    k->ed_seed[31] &= 127;
    k->ed_seed[31] |= 64;
    if (!sp_x25519(k->ed_seed, NULL, k->ed_pub)) {
      sp_key_release(k);
      sp_unsupported_input();
      return NULL;
    }
    return k;
  }
  if (gen->kind == SP_GEN_RSA) {
    const char *failure = sp_rsa_keygen_failure(gen->bits, gen->exponent);
    if (failure) {
      sp_key_release(k);
      *job_error = true;
      scr_pki_throw_fmt(SCR_ERR_ERROR, NULL, "%s", failure);
      return NULL;
    }
    /* Moduli past mbedTLS's 8192-bit numbers stay unsupported (OpenSSL
     * generates up to 16384 bits). */
    double b = gen->bits, e = gen->exponent;
    if (b > MBEDTLS_MPI_MAX_BITS || mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) != 0 ||
        sp_rsa_generate(mbedtls_pk_rsa(k->pk), (unsigned)b, (uint64_t)e) != 0) {
      sp_key_release(k);
      sp_not_supported("generateKeyPairSync with this RSA modulus length or exponent");
      return NULL;
    }
    if (gen->pss) {
      k->rsa_pss = true;
      k->pss_params = gen->pss_params;
      k->pss_md = gen->md;
      k->pss_mgf1 = gen->mgf1;
      k->pss_salt = gen->salt;
    }
    return k;
  }
  if (mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) != 0 ||
      mbedtls_ecp_gen_key(gen->curve->id, mbedtls_pk_ec(k->pk), sp_random, NULL) != 0) {
    sp_key_release(k);
    sp_unsupported_input();
    return NULL;
  }
  return k;
}

/* The { publicKey, privateKey } pair for (type, options), each a
 * KeyObject or the encoding the options ask for; NULL with the error
 * pending, and *job_error as sp_keygen_run sets it. */
static ScrDyn *sp_key_pair(const ScrDyn *type, const ScrDyn *options, bool *job_error) {
  *job_error = false;
  SpKeyGen gen = {0};
  if (!sp_keygen_check(type, options, &gen)) return NULL;
  SpKey *k = sp_keygen_run(&gen, job_error);
  if (!k) return NULL;
  SpKey *pub = sp_public_of(k);
  if (!pub) {
    sp_key_release(k);
    sp_unsupported_input();
    return NULL;
  }
  /* An encoding the key type has no form for (a raw encoding of an RSA
   * key, raw-seed) fails the job, as in Node. */
  ScrDyn *public_value = sp_encoded(pub, sp_opt(options, "publicKeyEncoding"));
  if (!public_value) {
    sp_key_release(k);
    *job_error = true;
    return NULL;
  }
  ScrDyn *private_value = sp_encoded(k, sp_opt(options, "privateKeyEncoding"));
  if (!private_value) {
    scr_dyn_release(public_value);
    *job_error = true;
    return NULL;
  }
  ScrDyn *pair = scr_dyn_new_obj();
  sp_set(pair, "publicKey", public_value);
  sp_set(pair, "privateKey", private_value);
  return pair;
}

/* generateKeyPairSync(type, options). */
ScrDyn *scr_crypto_generate_key_pair_sync(ScrDyn *type, ScrDyn *options) {
  ScrDyn *plain = sp_plain(options);
  if (!plain) return NULL;
  bool job_error;
  ScrDyn *pair = sp_key_pair(type, plain, &job_error);
  scr_dyn_release(plain);
  return pair;
}

/* ── sign and verify ──────────────────────────────────────────────────── */

typedef struct {
  const char *name;
  mbedtls_md_type_t md;
} SpDigest;

/* Digest names as OpenSSL's EVP_get_digestbyname takes them for
 * signatures, matched without regard to case. */
static const SpDigest sp_digests[] = {
    {"sha1", MBEDTLS_MD_SHA1},           {"rsa-sha1", MBEDTLS_MD_SHA1},
    {"sha1withrsaencryption", MBEDTLS_MD_SHA1}, {"ecdsa-with-sha1", MBEDTLS_MD_SHA1},
    {"sha224", MBEDTLS_MD_SHA224},       {"rsa-sha224", MBEDTLS_MD_SHA224},
    {"sha224withrsaencryption", MBEDTLS_MD_SHA224},
    {"sha256", MBEDTLS_MD_SHA256},       {"rsa-sha256", MBEDTLS_MD_SHA256},
    {"sha256withrsaencryption", MBEDTLS_MD_SHA256},
    {"sha384", MBEDTLS_MD_SHA384},       {"rsa-sha384", MBEDTLS_MD_SHA384},
    {"sha384withrsaencryption", MBEDTLS_MD_SHA384},
    {"sha512", MBEDTLS_MD_SHA512},       {"rsa-sha512", MBEDTLS_MD_SHA512},
    {"sha512withrsaencryption", MBEDTLS_MD_SHA512},
    {"sha2-256", MBEDTLS_MD_SHA256},     {"sha2-384", MBEDTLS_MD_SHA384},
    {"sha2-512", MBEDTLS_MD_SHA512},     {"sha2-224", MBEDTLS_MD_SHA224},
};

static bool sp_digest_of(const ScrStr *name, mbedtls_md_type_t *md) {
  for (size_t i = 0; i < sizeof sp_digests / sizeof sp_digests[0]; i++) {
    size_t n = strlen(sp_digests[i].name);
    if (name->len != n) continue;
    bool same = true;
    for (size_t j = 0; j < n && same; j++) {
      char c = name->data[j];
      if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
      same = c == sp_digests[i].name[j];
    }
    if (same) {
      *md = sp_digests[i].md;
      return true;
    }
  }
  return false;
}

/* The algorithm argument of crypto.sign/verify: its type is checked
 * first, its digest name only after the key is read. */
static bool sp_algorithm_arg(const ScrDyn *alg) {
  if (alg->kind == SCR_DYN_UNDEF || alg->kind == SCR_DYN_NULL) return true;
  if (alg->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("algorithm", "of type string", alg);
    return false;
  }
  return true;
}

/* A digest name, or null/undefined for the key type's default (SHA-256). */
static bool sp_algorithm_digest(const ScrDyn *alg, mbedtls_md_type_t *md) {
  if (alg->kind == SCR_DYN_UNDEF || alg->kind == SCR_DYN_NULL) {
    *md = MBEDTLS_MD_SHA256;
    return true;
  }
  if (alg->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("algorithm", "of type string", alg);
    return false;
  }
  if (!sp_digest_of(alg->v.str, md)) {
    /* The whole name, at any length and with any bytes, as in Node. */
    static const char prefix[] = "Invalid digest: ";
    size_t len = sizeof prefix - 1 + alg->v.str->len;
    char *message = malloc(len);
    if (!message) scr_trap("scriptc: out of memory\n");
    memcpy(message, prefix, sizeof prefix - 1);
    memcpy(message + sizeof prefix - 1, alg->v.str->data, alg->v.str->len);
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, len, "ERR_CRYPTO_INVALID_DIGEST");
    free(message);
    return false;
  }
  return true;
}

typedef struct {
  SpKey *key;   /* +1 */
  int padding;  /* the EVP padding mode once resolved */
  int salt;     /* Node's saltLength: a length, or -1 digest, -2 max/auto,
                 * -3 max, -4 digest-or-max */
  bool p1363;   /* dsaEncoding: "ieee-p1363" */
  bool padding_given, salt_given;
  bool context; /* a non-empty options.context, which OpenSSL rejects */
  mbedtls_md_type_t mgf1; /* PSS's MGF1 digest; NONE for the message's */
} SpSigKey;

/* The signing API a key argument comes from: its context rules and the
 * argument name its type errors use ("key" for crypto.sign, "privateKey"
 * for Sign.prototype.sign). */
typedef struct {
  bool sign;
  SpKeyContext key;
  const char *name;
} SpSigContext;

/* Node's getIntOption: an option read as a C++ int32 (V8's `value ===
 * value >> 0`). An int32 value passes, including the negative sentinels
 * saltLength uses; a bigint throws V8's mixing TypeError; anything else
 * throws ERR_INVALID_ARG_VALUE. -0 compares equal but is not an int32
 * value, so the binding ignores it, as it does any other value it does
 * not convert. */
static bool sp_int_option(const ScrDyn *options, const char *name, bool *given, int *value) {
  /* The property is the last segment of the display name ("options.padding"
   * names the padding property). */
  const char *dot = strrchr(name, '.');
  const ScrDyn *v = sp_opt(options, dot ? dot + 1 : name);
  *given = false;
  if (v->kind == SCR_DYN_UNDEF) return true;
  if (v->kind == SCR_DYN_BIGINT) {
    sp_throw(SCR_ERR_TYPE, NULL, "Cannot mix BigInt and other types, use explicit conversions");
    return false;
  }
  if (v->kind != SCR_DYN_NUM || !isfinite(v->v.num) || v->v.num != trunc(v->v.num) ||
      v->v.num < -2147483648.0 || v->v.num > 2147483647.0) {
    sp_property_invalid(name, v);
    return false;
  }
  *given = !(v->v.num == 0 && signbit(v->v.num));
  *value = (int)v->v.num;
  return true;
}

/* Node's getSignVerifyOptions: padding, saltLength, dsaEncoding and the
 * context, in that order, read from the key/options argument before the
 * key is decoded. A null or undefined argument throws where Node reads
 * options.padding first. */
static bool sp_sig_options(const ScrDyn *value, SpSigKey *out, bool sign) {
  (void)sign;
  if (value->kind == SCR_DYN_NULL) {
    sp_throw(SCR_ERR_TYPE, NULL, "Cannot read properties of null (reading 'padding')");
    return false;
  }
  if (value->kind == SCR_DYN_UNDEF) {
    sp_throw(SCR_ERR_TYPE, NULL, "Cannot read properties of undefined (reading 'padding')");
    return false;
  }
  int number = 0;
  bool given = false;
  const ScrDyn *raw_padding = sp_opt(value, "padding");
  if (!sp_int_option(value, "options.padding", &given, &number)) return false;
  /* The binding's IsUint32 ignores negative values. */
  out->padding_given = given && number >= 0;
  out->padding = out->padding_given ? number : 1;
  const ScrDyn *raw_salt = sp_opt(value, "saltLength");
  bool salt_defined = raw_salt->kind != SCR_DYN_UNDEF;
  if (!sp_int_option(value, "options.saltLength", &given, &number)) return false;
  out->salt_given = given;
  out->salt = given ? number : -1;
  /* getSaltLength: an unset saltLength under padding: 6 is MAX_SIGN. */
  if (!salt_defined && raw_padding->kind == SCR_DYN_NUM && raw_padding->v.num == 6) {
    out->salt = -2;
    out->salt_given = true;
  }
  if (sp_is_object(value)) {
    const ScrDyn *dsa = sp_opt(value, "dsaEncoding");
    if (sp_is_str(dsa, "ieee-p1363")) out->p1363 = true;
    else if (!sp_absent(dsa) && !sp_is_str(dsa, "der")) {
      sp_property_invalid("options.dsaEncoding", dsa);
      return false;
    }
  }
  const ScrDyn *context = sp_opt(value, "context");
  if (!sp_absent(context)) {
    if (context->kind != SCR_DYN_BYTES && !scr_buffer_storage_is(context)) {
      scr_dyn_prop_type_fail("options.context", "an instance of Buffer, TypedArray, or DataView", context);
      return false;
    }
    ScrBytes *bytes = scr_bytes_buffer_source(context);
    out->context = scr_bytes_byte_len(bytes) > 0;
    scr_bytes_release(bytes);
  }
  return true;
}

static void sp_sig_init(SpSigKey *out) {
  out->key = NULL;
  out->padding = 1;
  out->salt = -1;
  out->p1363 = false;
  out->padding_given = false;
  out->salt_given = false;
  out->context = false;
  out->mgf1 = MBEDTLS_MD_NONE;
}

/* Resolves and decodes the key material of a signing operation. */
static bool sp_sig_decode(const ScrDyn *value, const SpSigContext *ctx, SpSigKey *out) {
  ScrDyn *created = sp_create_key((ScrDyn *)value, ctx->key, ctx->name);
  if (!created) return false;
  out->key = sp_key_retain(sp_key_of(created));
  scr_dyn_release(created);
  return true;
}

/* A key argument read whole: its options, then its key material. */
static bool sp_sig_key_plain(const ScrDyn *value, const SpSigContext *ctx, SpSigKey *out) {
  sp_sig_init(out);
  if (!sp_sig_options(value, out, ctx->sign)) return false;
  return sp_sig_decode(value, ctx, out);
}

static bool sp_sig_key(const ScrDyn *value, const SpSigContext *ctx, SpSigKey *out) {
  out->key = NULL;
  ScrDyn *plain = sp_plain(value);
  if (!plain) return false;
  bool ok = sp_sig_key_plain(plain, ctx, out);
  scr_dyn_release(plain);
  return ok;
}

/* DER ECDSA-Sig-Value ⇄ IEEE P1363 r || s. */
static bool sp_der_to_p1363(const unsigned char *der, size_t len, size_t size, unsigned char *out) {
  unsigned char *p = (unsigned char *)der;
  const unsigned char *end = der + len;
  size_t seq;
  mbedtls_mpi r, s;
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  bool ok = mbedtls_asn1_get_tag(&p, end, &seq, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) == 0 &&
            mbedtls_asn1_get_mpi(&p, end, &r) == 0 && mbedtls_asn1_get_mpi(&p, end, &s) == 0 &&
            mbedtls_mpi_write_binary(&r, out, size) == 0 &&
            mbedtls_mpi_write_binary(&s, out + size, size) == 0;
  mbedtls_mpi_free(&r);
  mbedtls_mpi_free(&s);
  return ok;
}

static int sp_p1363_to_der(const unsigned char *sig, size_t len, unsigned char *buf, size_t size) {
  mbedtls_mpi r, s;
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  int out = -1;
  if (len % 2 == 0 && mbedtls_mpi_read_binary(&r, sig, len / 2) == 0 &&
      mbedtls_mpi_read_binary(&s, sig + len / 2, len / 2) == 0) {
    unsigned char *c = buf + size;
    size_t n = 0;
    int w;
    if ((w = mbedtls_asn1_write_mpi(&c, buf, &s)) >= 0) {
      n += (size_t)w;
      if ((w = mbedtls_asn1_write_mpi(&c, buf, &r)) >= 0) {
        n += (size_t)w;
        if ((w = mbedtls_asn1_write_len(&c, buf, n)) >= 0) {
          n += (size_t)w;
          if ((w = mbedtls_asn1_write_tag(&c, buf, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) >= 0)
            out = (int)(n + (size_t)w);
        }
      }
    }
  }
  mbedtls_mpi_free(&r);
  mbedtls_mpi_free(&s);
  return out;
}

static size_t sp_ec_size(SpKey *k) { return (mbedtls_pk_ec(k->pk)->MBEDTLS_PRIVATE(grp).nbits + 7) / 8; }

/* The most salt a PSS signature over a `hash_len` digest can hold,
 * negative when the digest alone overflows the key. */
static int sp_rsa_max_salt(mbedtls_rsa_context *rsa, size_t hash_len) {
  size_t bytes = mbedtls_rsa_get_len(rsa);
  size_t bits = mbedtls_rsa_get_bitlen(rsa);
  return (int)(bytes - hash_len - 2 - ((bits - 1) % 8 == 0 ? 1 : 0));
}

static void sp_invalid_salt_length(void) {
  sp_throw_openssl("1C800070", "Provider routines", "invalid salt length", "ERR_OSSL_INVALID_SALT_LENGTH", true);
}

static void sp_pss_salt_too_small(void) {
  sp_throw_openssl("1C8000AC", "Provider routines", "pss saltlen too small", "ERR_OSSL_PSS_SALTLEN_TOO_SMALL", true);
}

static void sp_data_too_large(void) {
  sp_throw_openssl("0200006E", "rsa routines", "data too large for key size",
                   "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE", true);
}

/* Resolves the RSA padding mode from Node's padding option and the key
 * type, as OpenSSL's provider does: EC, Ed and X25519 keys ignore it; a
 * plain RSA key takes PKCS#1 v1.5 (the default), PSS or X9.31; an
 * RSA-PSS key takes PSS only. */
static bool sp_sig_padding(SpSigKey *key) {
  if (!sp_is_rsa(key->key)) return true;
  if (key->key->rsa_pss) {
    if (key->padding_given && key->padding != 0 && key->padding != 6) {
      sp_throw_openssl("1C8000A5", "Provider routines", "illegal or unsupported padding mode",
                       "ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE", true);
      return false;
    }
    key->padding = 6;
    return true;
  }
  if (!key->padding_given) {
    key->padding = 1;
    return true;
  }
  if (key->padding == 1 || key->padding == 5 || key->padding == 6) return true;
  if (key->padding == 3) {
    sp_throw_openssl("1C8000A8", "Provider routines", "invalid padding mode", "ERR_OSSL_INVALID_PADDING_MODE", true);
    return false;
  }
  sp_throw_openssl("1C8000A5", "Provider routines", "illegal or unsupported padding mode",
                   "ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE", true);
  return false;
}

/* An RSA-PSS key with RSASSA-PSS-params admits one digest, and applies its
 * own MGF1 digest to the signature. */
static bool sp_pss_key_digest(SpSigKey *key, mbedtls_md_type_t md) {
  const SpKey *k = key->key;
  if (!k->pss_params) return true;
  if (md != k->pss_md) {
    sp_throw_openssl("1C8000AE", "Provider routines", "digest not allowed", "ERR_OSSL_DIGEST_NOT_ALLOWED", true);
    return false;
  }
  key->mgf1 = k->pss_mgf1;
  return true;
}

/* The salt length a PSS signature uses while signing, or verifies against
 * (-1 for "any"), from Node's saltLength and the key. OpenSSL's
 * sentinels: -1 the digest length, -2 the maximum while signing, -3 the
 * maximum, -4 the smaller of the digest length and the maximum. A key
 * with parameters signs with its own salt length by default and requires
 * at least that much; signing with -2 or -4 is an invalid salt length
 * there. False with OpenSSL's error pending. */
static bool sp_pss_salt(SpSigKey *key, size_t hash_len, int max, bool sign, int *salt) {
  const SpKey *k = key->key;
  int minimum = k->pss_params ? k->pss_salt : 0;
  int value = key->salt;
  if (!key->salt_given) {
    if (k->pss_params) value = k->pss_salt;
    else if (!sign) value = -2;
    else value = k->rsa_pss ? -4 : -1;
  }
  if (value <= -5) {
    sp_invalid_salt_length();
    return false;
  }
  int resolved;
  switch (value) {
    case -1:
      resolved = (int)hash_len;
      break;
    case -2:
      if (!sign) {
        *salt = -1;
        return true;
      }
      if (k->pss_params) {
        sp_invalid_salt_length();
        return false;
      }
      resolved = max;
      break;
    case -3:
      resolved = max;
      break;
    case -4:
      if (!sign) {
        *salt = -1;
        return true;
      }
      if (k->pss_params) {
        sp_invalid_salt_length();
        return false;
      }
      resolved = hash_len < (size_t)max ? (int)hash_len : max;
      break;
    default:
      resolved = value;
      break;
  }
  if (sign && (resolved < 0 || resolved > max)) {
    sp_data_too_large();
    return false;
  }
  if (resolved < minimum) {
    sp_pss_salt_too_small();
    return false;
  }
  *salt = resolved;
  return true;
}

/* X9.31 accepts only the SHA-1 and SHA-2 digests up to SHA-512. */
static bool sp_x931_digest(mbedtls_md_type_t md) {
  if (md == MBEDTLS_MD_SHA1 || md == MBEDTLS_MD_SHA256 || md == MBEDTLS_MD_SHA384 || md == MBEDTLS_MD_SHA512)
    return true;
  sp_throw_openssl("1C8000AA", "Provider routines", "invalid x931 digest", "ERR_OSSL_INVALID_X931_DIGEST", true);
  return false;
}

/* Applies the RSA padding of a signature operation. */
static bool sp_rsa_padding(SpSigKey *key, mbedtls_md_type_t md) {
  if (!sp_is_rsa(key->key)) return true;
  mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
  if (key->padding == 6) return mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V21, md) == 0;
  return mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V15, MBEDTLS_MD_NONE) == 0;
}

/* MGF1 over `mgf1` (RFC 8017 B.2.1), XORed into mask[0, len). */
static int sp_mgf1_xor(mbedtls_md_type_t mgf1, const unsigned char *seed, size_t seed_len, unsigned char *mask,
                       size_t len) {
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(mgf1);
  size_t h = mbedtls_md_get_size(info);
  unsigned char block[MBEDTLS_MD_MAX_SIZE];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  int r = mbedtls_md_setup(&ctx, info, 0);
  for (uint32_t counter = 0; r == 0 && (size_t)counter * h < len; counter++) {
    unsigned char c[4] = {(unsigned char)(counter >> 24), (unsigned char)(counter >> 16),
                          (unsigned char)(counter >> 8), (unsigned char)counter};
    if ((r = mbedtls_md_starts(&ctx)) == 0 && (r = mbedtls_md_update(&ctx, seed, seed_len)) == 0 &&
        (r = mbedtls_md_update(&ctx, c, 4)) == 0 && (r = mbedtls_md_finish(&ctx, block)) == 0) {
      for (size_t i = 0; i < h && (size_t)counter * h + i < len; i++) mask[(size_t)counter * h + i] ^= block[i];
    }
  }
  mbedtls_md_free(&ctx);
  mbedtls_platform_zeroize(block, sizeof block);
  return r;
}

/* An RSASSA-PSS signature whose MGF1 digest differs from the message's
 * (RFC 8017 9.1.1 and 8.1.1), which mbedtls_rsa_rsassa_pss_sign_ext
 * cannot make: the encoding here, then the private-key operation. */
static int sp_pss_sign_mgf1(mbedtls_rsa_context *rsa, mbedtls_md_type_t md, mbedtls_md_type_t mgf1,
                            const unsigned char *hash, size_t hash_len, int salt_len, unsigned char *sig) {
  size_t bytes = mbedtls_rsa_get_len(rsa);
  size_t em_bits = mbedtls_rsa_get_bitlen(rsa) - 1;
  size_t em_len = (em_bits + 7) / 8;
  size_t salt = (size_t)salt_len;
  if (em_len < hash_len + salt + 2) return MBEDTLS_ERR_RSA_BAD_INPUT_DATA;
  unsigned char em[MBEDTLS_MPI_MAX_SIZE] = {0};
  unsigned char *db = em, *h = em + em_len - hash_len - 1;
  size_t db_len = em_len - hash_len - 1;
  unsigned char salt_bytes[MBEDTLS_MPI_MAX_SIZE];
  int r = sp_random(NULL, salt_bytes, salt);
  /* H = Hash(0x00 * 8 || mHash || salt) */
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  static const unsigned char zeros[8] = {0};
  if (r == 0 && (r = mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(md), 0)) == 0 &&
      (r = mbedtls_md_starts(&ctx)) == 0 && (r = mbedtls_md_update(&ctx, zeros, 8)) == 0 &&
      (r = mbedtls_md_update(&ctx, hash, hash_len)) == 0 && (r = mbedtls_md_update(&ctx, salt_bytes, salt)) == 0)
    r = mbedtls_md_finish(&ctx, h);
  mbedtls_md_free(&ctx);
  if (r == 0) {
    /* DB = PS || 0x01 || salt, masked with MGF1(H). */
    db[db_len - salt - 1] = 0x01;
    memcpy(db + db_len - salt, salt_bytes, salt);
    r = sp_mgf1_xor(mgf1, h, hash_len, db, db_len);
  }
  if (r == 0) {
    db[0] &= (unsigned char)(0xff >> (8 * em_len - em_bits));
    em[em_len - 1] = 0xbc;
    unsigned char block[MBEDTLS_MPI_MAX_SIZE] = {0};
    memcpy(block + bytes - em_len, em, em_len);
    r = mbedtls_rsa_private(rsa, sp_random, NULL, block, sig);
    mbedtls_platform_zeroize(block, sizeof block);
  }
  mbedtls_platform_zeroize(em, sizeof em);
  mbedtls_platform_zeroize(salt_bytes, sizeof salt_bytes);
  return r;
}

/* Verifies an RSASSA-PSS signature whose MGF1 digest differs from the
 * message's (RFC 8017 9.1.2), which mbedtls_rsa_rsassa_pss_verify_ext
 * cannot: it hashes M' with the MGF1 digest too. `salt_len` -2 accepts any
 * salt length. */
static bool sp_pss_verify_mgf1(mbedtls_rsa_context *rsa, mbedtls_md_type_t md, mbedtls_md_type_t mgf1,
                               const unsigned char *hash, size_t hash_len, int salt_len,
                               const unsigned char *sig, size_t sig_len) {
  size_t bytes = mbedtls_rsa_get_len(rsa);
  if (sig_len != bytes) return false;
  unsigned char decoded[MBEDTLS_MPI_MAX_SIZE];
  if (mbedtls_rsa_public(rsa, sig, decoded) != 0) return false;
  size_t em_bits = mbedtls_rsa_get_bitlen(rsa) - 1;
  size_t em_len = (em_bits + 7) / 8;
  if (bytes > em_len && decoded[0] != 0) return false;
  unsigned char *em = decoded + (bytes - em_len);
  if (em_len < hash_len + 2 || em[em_len - 1] != 0xbc) return false;
  size_t db_len = em_len - hash_len - 1;
  unsigned char *h = em + db_len;
  unsigned char top = (unsigned char)(0xff >> (8 * em_len - em_bits));
  if (em[0] & (unsigned char)~top) return false;
  unsigned char db[MBEDTLS_MPI_MAX_SIZE];
  memcpy(db, em, db_len);
  if (sp_mgf1_xor(mgf1, h, hash_len, db, db_len) != 0) return false;
  db[0] &= top;
  size_t i = 0;
  while (i < db_len && db[i] == 0) i++;
  if (i == db_len || db[i] != 0x01) return false;
  size_t salt = db_len - i - 1;
  if (salt_len >= 0 && salt != (size_t)salt_len) return false;
  static const unsigned char zeros[8] = {0};
  unsigned char check[MBEDTLS_MD_MAX_SIZE];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  int r;
  if ((r = mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(md), 0)) == 0 && (r = mbedtls_md_starts(&ctx)) == 0 &&
      (r = mbedtls_md_update(&ctx, zeros, 8)) == 0 && (r = mbedtls_md_update(&ctx, hash, hash_len)) == 0 &&
      (r = mbedtls_md_update(&ctx, db + i + 1, salt)) == 0)
    r = mbedtls_md_finish(&ctx, check);
  mbedtls_md_free(&ctx);
  return r == 0 && memcmp(check, h, hash_len) == 0;
}

/* Signs a digest: +1 Buffer or NULL with the error pending. */
static ScrDyn *sp_sign_hash(SpSigKey *key, mbedtls_md_type_t md, const unsigned char *hash, size_t hash_len) {
  unsigned char sig[MBEDTLS_PK_SIGNATURE_MAX_SIZE];
  size_t sig_len = 0;
  int r;
  /* EVP_PKEY_CTX_set1_id comes before the padding, and the provider has
   * no context for these operations. */
  if (key->context) {
    if (sp_job_error) sp_throw(SCR_ERR_ERROR, NULL, "Deriving bits failed");
    else sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_OPERATION_FAILED", "Context parameter is unsupported");
    return NULL;
  }
  if (!sp_pss_key_digest(key, md)) return NULL;
  if (!sp_sig_padding(key)) return NULL;
  if (!sp_rsa_padding(key, md)) {
    sp_unsupported_input();
    return NULL;
  }
  if (sp_is_rsa(key->key) && key->padding == 6) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
    size_t bytes = mbedtls_rsa_get_len(rsa);
    int max = sp_rsa_max_salt(rsa, hash_len);
    int salt;
    if (!sp_pss_salt(key, hash_len, max, true, &salt)) return NULL;
    r = key->mgf1 != MBEDTLS_MD_NONE && key->mgf1 != md
            ? sp_pss_sign_mgf1(rsa, md, key->mgf1, hash, hash_len, salt, sig)
            : mbedtls_rsa_rsassa_pss_sign_ext(rsa, sp_random, NULL, md, (unsigned)hash_len, hash, salt, sig);
    sig_len = bytes;
  } else if (sp_is_rsa(key->key) && key->padding == 5) {
    /* X9.31: 0x6A || 0xBB... || 0xBA || H, then the private operation. */
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
    size_t bytes = mbedtls_rsa_get_len(rsa);
    if (!sp_x931_digest(md)) return NULL;
    if (hash_len + 2 > bytes) {
      sp_throw_openssl("1C8000AB", "Provider routines", "key size too small", "ERR_OSSL_KEY_SIZE_TOO_SMALL", true);
      return NULL;
    }
    unsigned char em[MBEDTLS_MPI_MAX_SIZE];
    memset(em, 0xBB, bytes);
    em[0] = 0x6A;
    em[bytes - hash_len - 1] = 0xBA;
    memcpy(em + bytes - hash_len, hash, hash_len);
    r = mbedtls_rsa_private(rsa, sp_random, NULL, em, sig);
    mbedtls_platform_zeroize(em, sizeof em);
    sig_len = bytes;
  } else {
    if (sp_is_rsa(key->key) && key->padding == 1 &&
        mbedtls_rsa_get_len(mbedtls_pk_rsa(key->key->pk)) < hash_len + 11) {
      sp_throw_openssl("02000070", "rsa routines", "digest too big for rsa key",
                       "ERR_OSSL_RSA_DIGEST_TOO_BIG_FOR_RSA_KEY", true);
      return NULL;
    }
    r = mbedtls_pk_sign(&key->key->pk, md, hash, hash_len, sig, sizeof sig, &sig_len, sp_random, NULL);
  }
  if (r != 0) {
    sp_unsupported_input();
    return NULL;
  }
  if (sp_is_ec(key->key) && key->p1363) {
    size_t size = sp_ec_size(key->key);
    unsigned char raw[2 * 66];
    if (!sp_der_to_p1363(sig, sig_len, size, raw)) {
      sp_unsupported_input();
      return NULL;
    }
    return sp_dyn_buffer(raw, 2 * size);
  }
  return sp_dyn_buffer(sig, sig_len);
}

/* Verifies a digest against a signature; false for a signature that does
 * not verify or does not parse. */
static bool sp_verify_hash(SpSigKey *key, mbedtls_md_type_t md, const unsigned char *hash, size_t hash_len,
                           const unsigned char *sig, size_t sig_len) {
  if (key->context) {
    if (sp_job_error) sp_throw(SCR_ERR_ERROR, NULL, "Deriving bits failed");
    else sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_OPERATION_FAILED", "Context parameter is unsupported");
    return false;
  }
  if (!sp_pss_key_digest(key, md)) return false;
  if (!sp_sig_padding(key)) return false;
  if (!sp_rsa_padding(key, md)) return false;
  if (sp_is_rsa(key->key) && key->padding == 6) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
    if (sig_len != mbedtls_rsa_get_len(rsa)) return false;
    int salt;
    if (!sp_pss_salt(key, hash_len, sp_rsa_max_salt(rsa, hash_len), false, &salt)) return false;
    if (key->mgf1 != MBEDTLS_MD_NONE && key->mgf1 != md)
      return sp_pss_verify_mgf1(rsa, md, key->mgf1, hash, hash_len, salt, sig, sig_len);
    int any = salt < 0 ? MBEDTLS_RSA_SALT_LEN_ANY : salt;
    return mbedtls_rsa_rsassa_pss_verify_ext(rsa, md, (unsigned)hash_len, hash, md, any, sig) == 0;
  }
  if (sp_is_rsa(key->key) && key->padding == 5) {
    /* X9.31: recover the encoding and check its shape and digest. */
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
    size_t bytes = mbedtls_rsa_get_len(rsa);
    if (!sp_x931_digest(md)) return false;
    if (sig_len != bytes || hash_len + 2 > bytes) return false;
    unsigned char em[MBEDTLS_MPI_MAX_SIZE];
    if (mbedtls_rsa_public(rsa, sig, em) != 0) return false;
    bool ok = em[0] == 0x6A && em[bytes - hash_len - 1] == 0xBA &&
              memcmp(em + bytes - hash_len, hash, hash_len) == 0;
    for (size_t i = 1; ok && i < bytes - hash_len - 1; i++) ok = em[i] == 0xBB;
    mbedtls_platform_zeroize(em, sizeof em);
    return ok;
  }
  if (sp_is_ec(key->key) && key->p1363) {
    unsigned char der[2 * 66 + 16];
    if (sig_len != 2 * sp_ec_size(key->key)) return false;
    int n = sp_p1363_to_der(sig, sig_len, der, sizeof der);
    if (n < 0) return false;
    return mbedtls_pk_verify(&key->key->pk, md, hash, hash_len, der + sizeof der - n, (size_t)n) == 0;
  }
  return mbedtls_pk_verify(&key->key->pk, md, hash, hash_len, sig, sig_len) == 0;
}

/* X25519 keys neither sign nor verify: OpenSSL's error, after the key
 * checks. Releases the key and answers true when it rejects. */
static bool sp_reject_x25519(SpSigKey *k) {
  if (!sp_is_x(k->key)) return false;
  sp_key_release(k->key);
  sp_throw_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                   "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", true);
  return true;
}

/* Node's getArrayBufferOrView type list for data and signatures. */
static const char sp_data_types[] = "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView";

/* getArrayBufferOrView(value, name, 'utf8'): a string's UTF-8 bytes, or a
 * view's or ArrayBuffer's. +1, or NULL with Node's arg-type error. */
static ScrBytes *sp_arg_bytes(const ScrDyn *value, const char *name) {
  if (value->kind == SCR_DYN_STR) {
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *bytes = scr_bytes_from_str(value->v.str, utf8);
    scr_str_release(utf8);
    return bytes;
  }
  if (value->kind == SCR_DYN_BYTES || scr_buffer_storage_is(value)) return scr_bytes_buffer_source(value);
  scr_dyn_arg_type_fail(name, sp_data_types, value);
  return NULL;
}

/* Ed25519 signs the message itself: an algorithm other than null or
 * undefined is OpenSSL's invalid digest (false, error pending). */
static bool sp_ed_digest_given(const ScrDyn *algorithm) {
  if (algorithm->kind == SCR_DYN_UNDEF || algorithm->kind == SCR_DYN_NULL) return true;
  sp_throw(SCR_ERR_ERROR, "ERR_OSSL_INVALID_DIGEST", "error:1C80007A:Provider routines::invalid digest");
  return false;
}

/* The state of a one-shot signature operation after its synchronous
 * argument checks. */
typedef struct {
  SpSigKey key;
  mbedtls_md_type_t md;
  ScrBytes *bytes;       /* +1 */
  const ScrDyn *algorithm; /* borrowed */
} SpSignOp;

typedef struct {
  SpSigKey key;
  mbedtls_md_type_t md;
  ScrBytes *bytes;       /* +1 */
  ScrBytes *signature;   /* +1 */
  const ScrDyn *algorithm; /* borrowed */
} SpVerifyOp;

/* crypto.sign's argument checks, in Node's order: data, the key's
 * truthiness, its options, the key itself and its digest. The algorithm's
 * type was checked by the caller. */
static bool sp_sign_prepare(const ScrDyn *algorithm, const ScrDyn *data, const ScrDyn *key, SpSignOp *op) {
  static const SpSigContext ctx = {true, SP_KEY_SIGN, "key"};
  op->bytes = sp_arg_bytes(data, "data");
  if (!op->bytes) return false;
  ScrDyn *plain = sp_plain(key);
  if (!plain) {
    scr_bytes_release(op->bytes);
    op->bytes = NULL;
    return false;
  }
  sp_sig_init(&op->key);
  bool ok = false;
  if (!scr_dyn_truthy(plain)) {
    sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_SIGN_KEY_REQUIRED", "No key provided to sign");
  } else if (sp_sig_options(plain, &op->key, true) && sp_sig_decode(plain, &ctx, &op->key) &&
             sp_algorithm_digest(algorithm, &op->md)) {
    ok = true;
  }
  scr_dyn_release(plain);
  if (ok) {
    /* A null algorithm signs with an RSA-PSS key's own digest. */
    if ((algorithm->kind == SCR_DYN_UNDEF || algorithm->kind == SCR_DYN_NULL) && op->key.key->pss_params)
      op->md = op->key.key->pss_md;
    op->algorithm = algorithm;
  } else {
    scr_bytes_release(op->bytes);
    op->bytes = NULL;
    if (op->key.key) {
      sp_key_release(op->key.key);
      op->key.key = NULL;
    }
  }
  return ok;
}

/* The operation itself, where OpenSSL's errors arise. */
static ScrDyn *sp_sign_run(SpSignOp *op) {
  ScrBytes *bytes = op->bytes;
  op->bytes = NULL;
  if (sp_is_x(op->key.key)) {
    sp_key_release(op->key.key);
    scr_bytes_release(bytes);
    sp_throw_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                     "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", true);
    return NULL;
  }
  if (sp_is_ed(op->key.key)) {
    ScrDyn *result = NULL;
    const ScrPkiEd25519 *ed = sp_ed_digest_given(op->algorithm) ? sp_ed() : NULL;
    if (ed) {
      uint8_t sig[64];
      ed->sign(sig, op->key.key->ed_seed, op->key.key->ed_pub, bytes->data, (size_t)scr_bytes_byte_len(bytes));
      result = sp_dyn_buffer(sig, 64);
    }
    scr_bytes_release(bytes);
    sp_key_release(op->key.key);
    return result;
  }
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(op->md);
  mbedtls_md(info, bytes->data, (size_t)scr_bytes_byte_len(bytes), hash);
  scr_bytes_release(bytes);
  ScrDyn *result = sp_sign_hash(&op->key, op->md, hash, mbedtls_md_get_size(info));
  sp_key_release(op->key.key);
  return result;
}

/* crypto.sign(algorithm, data, key): the signature Buffer. */
ScrDyn *scr_crypto_sign_oneshot(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key) {
  if (!sp_algorithm_arg(algorithm)) return NULL;
  SpSignOp op;
  if (!sp_sign_prepare(algorithm, data, key, &op)) return NULL;
  return sp_sign_run(&op);
}

/* crypto.verify's argument checks, in Node's order: data, the key's
 * options (before its truthiness, so a null or undefined key throws the
 * options read), the signature, the key itself and its digest. */
static bool sp_verify_prepare(const ScrDyn *algorithm, const ScrDyn *data, const ScrDyn *key,
                              const ScrDyn *signature, SpVerifyOp *op) {
  static const SpSigContext ctx = {false, SP_KEY_VERIFY, "key"};
  op->bytes = sp_arg_bytes(data, "data");
  if (!op->bytes) return false;
  op->signature = NULL;
  ScrDyn *plain = sp_plain(key);
  if (!plain) {
    scr_bytes_release(op->bytes);
    op->bytes = NULL;
    return false;
  }
  sp_sig_init(&op->key);
  bool ok = false;
  if (sp_sig_options(plain, &op->key, false)) {
    op->signature = sp_arg_bytes(signature, "signature");
    if (op->signature && sp_sig_decode(plain, &ctx, &op->key) && sp_algorithm_digest(algorithm, &op->md)) ok = true;
  }
  scr_dyn_release(plain);
  if (ok) {
    if ((algorithm->kind == SCR_DYN_UNDEF || algorithm->kind == SCR_DYN_NULL) && op->key.key->pss_params)
      op->md = op->key.key->pss_md;
    op->algorithm = algorithm;
  } else {
    scr_bytes_release(op->bytes);
    op->bytes = NULL;
    if (op->signature) scr_bytes_release(op->signature);
    op->signature = NULL;
    if (op->key.key) {
      sp_key_release(op->key.key);
      op->key.key = NULL;
    }
  }
  return ok;
}

static ScrDyn *sp_verify_run(SpVerifyOp *op) {
  ScrBytes *bytes = op->bytes, *sig = op->signature;
  op->bytes = op->signature = NULL;
  if (sp_is_x(op->key.key)) {
    sp_key_release(op->key.key);
    scr_bytes_release(bytes);
    scr_bytes_release(sig);
    sp_throw_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                     "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", true);
    return NULL;
  }
  if (sp_is_ed(op->key.key)) {
    ScrDyn *result = NULL;
    const ScrPkiEd25519 *ed = sp_ed_digest_given(op->algorithm) ? sp_ed() : NULL;
    if (ed)
      result = scr_dyn_new_bool(sp_ed_verify(ed, op->key.key->ed_pub, bytes->data, (size_t)scr_bytes_byte_len(bytes),
                                             sig->data, (size_t)scr_bytes_byte_len(sig)));
    scr_bytes_release(bytes);
    scr_bytes_release(sig);
    sp_key_release(op->key.key);
    return result;
  }
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(op->md);
  mbedtls_md(info, bytes->data, (size_t)scr_bytes_byte_len(bytes), hash);
  bool ok = sp_verify_hash(&op->key, op->md, hash, mbedtls_md_get_size(info), sig->data,
                           (size_t)scr_bytes_byte_len(sig));
  scr_bytes_release(bytes);
  scr_bytes_release(sig);
  sp_key_release(op->key.key);
  return scr_exc_pending() ? NULL : scr_dyn_new_bool(ok);
}

/* crypto.verify(algorithm, data, key, signature): a boolean. */
ScrDyn *scr_crypto_verify_oneshot(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key, ScrDyn *signature) {
  if (!sp_algorithm_arg(algorithm)) return NULL;
  SpVerifyOp op;
  if (!sp_verify_prepare(algorithm, data, key, signature, &op)) return NULL;
  return sp_verify_run(&op);
}

/* The operation of a callback-style call: its result, or the error it
 * raised, which Node's job completion passes to the callback as a plain
 * Error without the OpenSSL properties. */
static ScrDyn *sp_callback_error(void) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *error = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  return error;
}

/* crypto.sign(algorithm, data, key, callback); crypto.verify(...,
 * signature, callback): argument errors throw, and the callback receives
 * (null, result) or (error) in a later macrotask. */
void scr_crypto_sign_oneshot_async(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key, ScrDyn *callback) {
  if (!sp_algorithm_arg(algorithm)) return;
  if (!scr_dyn_is_callable(callback)) {
    scr_dyn_arg_type_fail("callback", "of type function", callback);
    return;
  }
  SpSignOp op;
  if (!sp_sign_prepare(algorithm, data, key, &op)) return;
  sp_job_error = true;
  ScrDyn *result = sp_sign_run(&op);
  sp_job_error = false;
  if (!result) {
    scr_crypto_defer_dyn_callback(scr_dyn_retain(callback), sp_callback_error(), NULL);
    return;
  }
  scr_crypto_defer_dyn_callback(scr_dyn_retain(callback), scr_dyn_new_null(), result);
}

void scr_crypto_verify_oneshot_async(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key, ScrDyn *signature,
                                     ScrDyn *callback) {
  if (!sp_algorithm_arg(algorithm)) return;
  if (!scr_dyn_is_callable(callback)) {
    scr_dyn_arg_type_fail("callback", "of type function", callback);
    return;
  }
  SpVerifyOp op;
  if (!sp_verify_prepare(algorithm, data, key, signature, &op)) return;
  sp_job_error = true;
  ScrDyn *result = sp_verify_run(&op);
  sp_job_error = false;
  if (!result) {
    scr_crypto_defer_dyn_callback(scr_dyn_retain(callback), sp_callback_error(), NULL);
    return;
  }
  scr_crypto_defer_dyn_callback(scr_dyn_retain(callback), scr_dyn_new_null(), result);
}

/* crypto.sign(algorithm, data, key, callback) and crypto.verify(...,
 * signature, callback) where the callback is a value whose type is known
 * only at run time. Node reads a function as the asynchronous form, an
 * undefined as the synchronous one, and anything else as an argument
 * error; the synchronous form answers its result, the asynchronous one
 * undefined. */
ScrDyn *scr_crypto_sign_oneshot_maybe(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key, ScrDyn *callback) {
  if (callback && callback->kind == SCR_DYN_UNDEF) return scr_crypto_sign_oneshot(algorithm, data, key);
  scr_crypto_sign_oneshot_async(algorithm, data, key, callback);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_crypto_verify_oneshot_maybe(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key, ScrDyn *signature,
                                        ScrDyn *callback) {
  if (callback && callback->kind == SCR_DYN_UNDEF)
    return scr_crypto_verify_oneshot(algorithm, data, key, signature);
  scr_crypto_verify_oneshot_async(algorithm, data, key, signature, callback);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

/* ── RSA public-key encryption ─────────────────────────────────────────
 * publicEncrypt, privateDecrypt, privateEncrypt and publicDecrypt: the RSA
 * operation with the key's public half (encrypt and recover) or its private
 * half (decrypt and sign), padded as PKCS#1 v1.5, OAEP, or not at all.
 * Node runs these through EVP_PKEY_encrypt, EVP_PKEY_decrypt,
 * EVP_PKEY_sign and EVP_PKEY_verify_recover with OpenSSL's provider, so
 * the padding and length checks, the errors it reports, and its implicit
 * rejection of badly padded PKCS#1 v1.5 ciphertexts are reproduced here. */

/* EVP's padding modes (RSA_PKCS1_* in openssl/rsa.h). */
enum {
  SP_PAD_PKCS1 = 1,
  SP_PAD_NONE = 3,
  SP_PAD_OAEP = 4,
  SP_PAD_X931 = 5,
  SP_PAD_PSS = 6,
  SP_PAD_TLS = 7,
};

/* The four calls, which decide the key's half and the defaults. */
enum {
  SP_RSA_ENCRYPT,
  SP_RSA_DECRYPT,
  SP_RSA_SIGN,
  SP_RSA_RECOVER,
};

/* Node's key type lists: a private operation takes a URL too (an OpenSSL
 * STORE reference), and its option names are "privateKey". */
static const char sp_rsa_public_types[] =
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey";
static const char sp_rsa_private_types[] =
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, CryptoKey, or URL";
static const char sp_rsa_buffer_types[] =
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView";

typedef struct {
  SpKey *key;              /* +1 */
  int padding;
  mbedtls_md_type_t md;    /* OAEP's digest; SHA-1 unless oaepHash */
  mbedtls_md_type_t mgf1;  /* OAEP's MGF1 digest; md unless mgf1Hash */
  ScrBytes *label;         /* +1, or NULL for OAEP's empty label */
} SpRsaOp;

/* An OpenSSL error as Node prints these: "error:<packed>:<library>::<reason>". */
static void sp_rsa_openssl(const char *packed, const char *library, const char *reason, const char *code) {
  sp_throw_openssl(packed, library, reason, code, true);
}

/* One from the RSA implementation itself. */
static void sp_rsa_error(const char *packed, const char *reason, const char *code) {
  sp_rsa_openssl(packed, "rsa routines", reason, code);
}

/* One from the provider layer above it. */
static void sp_rsa_provider(const char *packed, const char *reason, const char *code) {
  sp_rsa_openssl(packed, "Provider routines", reason, code);
}

/* What Node reports when the provider raised nothing at all (an operation
 * its init refused without pushing an error): a bare error with no code. */
static void sp_rsa_opaque(void) {
  scr_pki_throw_fmt(SCR_ERR_ERROR, NULL, "error:00000000:lib(0)::reason(0)");
}

/* The lengths of names OpenSSL sees as C strings end at a NUL byte. */
static size_t sp_rsa_name_len(const ScrStr *name) {
  size_t len = 0;
  while (len < name->len && name->data[len] != '\0') len++;
  return len;
}

/* Is `name` the C string `text`, without regard to case? */
static bool sp_rsa_name_is(const ScrStr *name, const char *text) {
  size_t len = sp_rsa_name_len(name);
  size_t n = strlen(text);
  if (len != n) return false;
  for (size_t i = 0; i < n; i++) {
    char c = name->data[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != text[i]) return false;
  }
  return true;
}

/* The digest names EVP_get_digestbyname resolves for oaepHash and
 * mgf1Hash, with the aliases its name database holds for them: the digest
 * names, the dashed SHA-2 spellings, and the signature names, which share
 * the digest's object. */
static const SpDigest sp_oaep_digests[] = {
    {"md5", MBEDTLS_MD_MD5},
    {"rsa-md5", MBEDTLS_MD_MD5},
    {"md5withrsaencryption", MBEDTLS_MD_MD5},
    {"sha1", MBEDTLS_MD_SHA1},
    {"sha-1", MBEDTLS_MD_SHA1},
    {"rsa-sha1", MBEDTLS_MD_SHA1},
    {"sha1withrsaencryption", MBEDTLS_MD_SHA1},
    {"sha224", MBEDTLS_MD_SHA224},
    {"sha-224", MBEDTLS_MD_SHA224},
    {"sha2-224", MBEDTLS_MD_SHA224},
    {"rsa-sha224", MBEDTLS_MD_SHA224},
    {"sha224withrsaencryption", MBEDTLS_MD_SHA224},
    {"sha256", MBEDTLS_MD_SHA256},
    {"sha-256", MBEDTLS_MD_SHA256},
    {"sha2-256", MBEDTLS_MD_SHA256},
    {"rsa-sha256", MBEDTLS_MD_SHA256},
    {"sha256withrsaencryption", MBEDTLS_MD_SHA256},
    {"sha384", MBEDTLS_MD_SHA384},
    {"sha-384", MBEDTLS_MD_SHA384},
    {"sha2-384", MBEDTLS_MD_SHA384},
    {"rsa-sha384", MBEDTLS_MD_SHA384},
    {"sha384withrsaencryption", MBEDTLS_MD_SHA384},
    {"sha512", MBEDTLS_MD_SHA512},
    {"sha-512", MBEDTLS_MD_SHA512},
    {"sha2-512", MBEDTLS_MD_SHA512},
    {"rsa-sha512", MBEDTLS_MD_SHA512},
    {"sha512withrsaencryption", MBEDTLS_MD_SHA512},
    {"ripemd160", MBEDTLS_MD_RIPEMD160},
    {"ripemd", MBEDTLS_MD_RIPEMD160},
    {"rmd160", MBEDTLS_MD_RIPEMD160},
    {"sha3-224", MBEDTLS_MD_SHA3_224},
    {"sha3-256", MBEDTLS_MD_SHA3_256},
    {"sha3-384", MBEDTLS_MD_SHA3_384},
    {"sha3-512", MBEDTLS_MD_SHA3_512},
};

/* The message digest `name` resolves to, or NULL with the error Node
 * reports for it pending. */
static const mbedtls_md_info_t *sp_oaep_md(const ScrStr *name) {
  for (size_t i = 0; i < sizeof sp_oaep_digests / sizeof sp_oaep_digests[0]; i++) {
    if (!sp_rsa_name_is(name, sp_oaep_digests[i].name)) continue;
    return mbedtls_md_info_from_type(sp_oaep_digests[i].md);
  }
  /* A digest OpenSSL knows whose size the provider cannot use: the XOFs,
     which have no single size. */
  if (sp_rsa_name_is(name, "shake128") || sp_rsa_name_is(name, "shake-128") || sp_rsa_name_is(name, "shake256") ||
      sp_rsa_name_is(name, "shake-256")) {
    sp_rsa_error("020000B5", "invalid length", "ERR_OSSL_RSA_INVALID_LENGTH");
    return NULL;
  }
  /* Digests only the legacy provider offers, which this build does not
     load. */
  if (sp_rsa_name_is(name, "md4") || sp_rsa_name_is(name, "md4withrsaencryption") ||
      sp_rsa_name_is(name, "whirlpool")) {
    sp_rsa_openssl("0308010C", "digital envelope routines", "unsupported", "ERR_OSSL_EVP_UNSUPPORTED");
    return NULL;
  }
  sp_throw(SCR_ERR_ERROR, "ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest used");
  return NULL;
}

/* Node's `key.padding || defaultPadding`, then Uint32Value: a falsy value
 * keeps the default, and any other converts with ToNumber and truncates
 * modulo 2^32 (a NaN, as an object gives, is 0). */
static bool sp_rsa_padding_of(const ScrDyn *value, int fallback, int *out) {
  *out = fallback;
  if (!scr_dyn_truthy(value)) return true;
  double n = scr_dyn_number_coerce(value);
  if (scr_exc_pending()) return false;
  if (!isfinite(n)) {
    n = 0;
  } else {
    n = fmod(trunc(n), 4294967296.0);
    if (n < 0) n += 4294967296.0;
  }
  *out = (int)(uint32_t)n;
  return true;
}

static void sp_rsa_release(SpRsaOp *op) {
  sp_key_release(op->key);
  op->key = NULL;
  if (op->label) scr_bytes_release(op->label);
  op->label = NULL;
}

/* createPrivateKey & co. for a private operation, which Node's decoder
 * also feeds a public key: the operation itself then reports that the key
 * has no private half. A failure that is not a missing private half is
 * the key's own error, and stays. */
static ScrDyn *sp_create_key_either(ScrDyn *input, bool private_key) {
  const char *name = private_key ? "privateKey" : "key";
  ScrDyn *k = sp_create_key(input, private_key ? SP_KEY_CREATE_PRIVATE : SP_KEY_CREATE_PUBLIC, name);
  if (k || !private_key || !scr_exc_pending()) return k;
  ScrCaught *first = scr_exc_take();
  ScrDyn *pub = sp_create_key(input, SP_KEY_CREATE_PUBLIC, name);
  bool failed = scr_exc_pending();
  if (pub && !failed) {
    scr_caught_release(first);
    return pub;
  }
  if (pub) scr_dyn_release(pub);
  if (failed) scr_caught_release(scr_exc_take());
  scr_rethrow(first);
  scr_caught_release(first);
  return NULL;
}

/* The key argument of the four calls: Node's rsaFunctionFor reads padding,
 * oaepHash, mgf1Hash, oaepLabel and encoding off it, and
 * prepareAsymmetricKey resolves the key (a KeyObject, key material, or an
 * options object, whose own `key` may be a KeyObject again). The buffer
 * becomes *data, +1. */
static bool sp_rsa_prepare(const ScrDyn *key_arg, const ScrDyn *buffer, int operation, SpRsaOp *op,
                           ScrBytes **data) {
  op->key = NULL;
  op->label = NULL;
  op->padding = operation == SP_RSA_ENCRYPT || operation == SP_RSA_DECRYPT ? SP_PAD_OAEP : SP_PAD_PKCS1;
  op->md = MBEDTLS_MD_SHA1;
  op->mgf1 = MBEDTLS_MD_SHA1;
  *data = NULL;
  bool private_op = operation == SP_RSA_DECRYPT || operation == SP_RSA_SIGN;
  const char *name = private_op ? "privateKey" : "key";
  const char *types = private_op ? sp_rsa_private_types : sp_rsa_public_types;

  ScrDyn *plain = sp_plain(key_arg);
  if (!plain) return false;

  SpKey *direct = sp_key_of(plain);
  if (direct) {
    /* validateAsymmetricKeyType: a private operation needs a private key. */
    if (private_op && !direct->private_key) {
      sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
               "Invalid key object type public, expected private.");
      scr_dyn_release(plain);
      return false;
    }
    sp_key_retain(direct);
    op->key = direct;
  } else if (plain->kind == SCR_DYN_HANDLE && plain->v.handle.tag == SCR_DYNH_KEY_OBJECT) {
    /* A secret KeyObject is not a key these calls take. */
    sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
             private_op ? "Invalid key object type secret, expected private."
                        : "Invalid key object type secret, expected private or public.");
    scr_dyn_release(plain);
    return false;
  }

  bool options = false;
  const ScrDyn *encoding = scr_dyn_undefined();
  if (!op->key) {
    bool material = plain->kind == SCR_DYN_STR || plain->kind == SCR_DYN_BYTES || scr_buffer_storage_is(plain);
    if (!material) {
      if (plain->kind == SCR_DYN_NULL) {
        scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "Cannot destructure property 'key' of '%s' as it is null.", name);
        scr_dyn_release(plain);
        return false;
      }
      if (plain->kind != SCR_DYN_OBJ && plain->kind != SCR_DYN_ARR) {
        scr_dyn_arg_type_fail(name, types, plain);
        scr_dyn_release(plain);
        return false;
      }
      /* An options object. Its `key` may be a KeyObject, whose type Node
         validates before it reads anything else, and which stands in for
         the key material. */
      options = true;
      const ScrDyn *inner = sp_opt(plain, "key");
      SpKey *inner_key = sp_key_of(inner);
      if (inner_key) {
        if (private_op && !inner_key->private_key) {
          sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
                   "Invalid key object type public, expected private.");
          scr_dyn_release(plain);
          return false;
        }
        sp_key_retain(inner_key);
        op->key = inner_key;
      } else if (inner->kind == SCR_DYN_HANDLE && inner->v.handle.tag == SCR_DYNH_KEY_OBJECT) {
        sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
                 private_op ? "Invalid key object type secret, expected private."
                            : "Invalid key object type secret, expected private or public.");
        scr_dyn_release(plain);
        return false;
      } else {
        /* Key material. Node's own object-form checks (the JWK and raw
           format paths, and the decoder) follow. */
        const ScrDyn *format = sp_opt(plain, "format");
        bool special = sp_is_str(format, "jwk") || sp_is_str(format, "raw-public") ||
                       sp_is_str(format, "raw-private") || sp_is_str(format, "raw-seed");
        bool material = inner->kind == SCR_DYN_STR || inner->kind == SCR_DYN_BYTES || scr_buffer_storage_is(inner);
        if (!special && !material) {
          char key_name[32];
          snprintf(key_name, sizeof key_name, "%s.key", name);
          scr_dyn_arg_type_fail(key_name, types, inner);
          scr_dyn_release(plain);
          return false;
        }
      }
      encoding = sp_opt(plain, "encoding");
    }
    if (!op->key) {
      ScrDyn *created = sp_create_key_either(plain, private_op);
      if (!created) {
        scr_dyn_release(plain);
        return false;
      }
      op->key = sp_key_of(created);
      sp_key_retain(op->key);
      scr_dyn_release(created);
    }
  }

  const ScrDyn *padding = options ? sp_opt(plain, "padding") : scr_dyn_undefined();
  const ScrDyn *oaep_hash = options ? sp_opt(plain, "oaepHash") : scr_dyn_undefined();
  const ScrDyn *mgf1_hash = options ? sp_opt(plain, "mgf1Hash") : scr_dyn_undefined();
  const ScrDyn *oaep_label = options ? sp_opt(plain, "oaepLabel") : scr_dyn_undefined();
  bool ok = sp_rsa_padding_of(padding, op->padding, &op->padding);
  /* Node validates the option strings, and converts the label with the
     key's encoding, before it looks at the buffer. */
  if (ok && !sp_absent(oaep_hash) && oaep_hash->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("key.oaepHash", "of type string", oaep_hash);
    ok = false;
  }
  if (ok && !sp_absent(mgf1_hash) && mgf1_hash->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("key.mgf1Hash", "of type string", mgf1_hash);
    ok = false;
  }
  if (ok && !sp_absent(oaep_label)) {
    op->label = sp_source_bytes(oaep_label, encoding);
    if (!op->label) {
      if (!scr_exc_pending()) scr_dyn_arg_type_fail("key.oaepLabel", sp_rsa_buffer_types, oaep_label);
      ok = false;
    }
  }
  if (ok) {
    *data = sp_source_bytes(buffer, encoding);
    if (!*data) {
      if (!scr_exc_pending()) scr_dyn_arg_type_fail("buffer", sp_rsa_buffer_types, buffer);
      ok = false;
    }
  }
  /* A PKCS#1 v1.5 decryption sets its implicit rejection up before the
     digests resolve, so its key type is the first thing that can fail. */
  if (ok && operation == SP_RSA_DECRYPT && op->padding == SP_PAD_PKCS1 && !sp_is_rsa(op->key)) {
    if (op->key->rsa_pss)
      sp_rsa_provider("1C8000B2", "operation not supported for this keytype",
                      "ERR_OSSL_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    else
      sp_rsa_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                     "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    ok = false;
  }
  /* The digests resolve after the key is decoded, and the MGF1 digest
     follows the message digest unless it names its own. */
  if (ok && !sp_absent(oaep_hash)) {
    const mbedtls_md_info_t *md = sp_oaep_md(oaep_hash->v.str);
    if (md) op->md = mbedtls_md_get_type(md);
    else ok = false;
  }
  if (ok && !sp_absent(mgf1_hash)) {
    const mbedtls_md_info_t *md = sp_oaep_md(mgf1_hash->v.str);
    if (md) op->mgf1 = mbedtls_md_get_type(md);
    else ok = false;
  } else if (ok) {
    op->mgf1 = op->md;
  }
  scr_dyn_release(plain);
  if (!ok) {
    if (*data) scr_bytes_release(*data);
    *data = NULL;
    sp_rsa_release(op);
    return false;
  }
  return true;
}

/* The k-byte big-endian block of `in`, which is no longer than k. */
static void sp_rsa_block_of(const ScrBytes *in, unsigned char *block, size_t k) {
  size_t len = (size_t)scr_bytes_byte_len(in);
  memset(block, 0, k);
  if (len) memcpy(block + k - len, in->data, len);
}

/* Is the block at least the modulus? (OpenSSL's RSA_R_DATA_TOO_LARGE_FOR_MODULUS.) */
static bool sp_rsa_block_too_large(mbedtls_rsa_context *rsa, const unsigned char *block, size_t k) {
  mbedtls_mpi v;
  mbedtls_mpi_init(&v);
  bool ge = mbedtls_mpi_read_binary(&v, block, k) == 0 &&
            mbedtls_mpi_cmp_mpi(&v, &rsa->MBEDTLS_PRIVATE(N)) >= 0;
  mbedtls_mpi_free(&v);
  return ge;
}

/* The private-key operation on a block, or the missing-private-key error
 * when the key has only its public half. */
static bool sp_rsa_private_op(const SpKey *key, const unsigned char *block, unsigned char *out) {
  if (!key->private_key) {
    sp_rsa_error("020000B3", "missing private key", "ERR_OSSL_RSA_MISSING_PRIVATE_KEY");
    return false;
  }
  if (mbedtls_rsa_private(mbedtls_pk_rsa(key->pk), sp_random, NULL, block, out) != 0) {
    sp_rsa_opaque();
    return false;
  }
  return true;
}

/* The public-key operation on a block. */
static bool sp_rsa_public_op(mbedtls_rsa_context *rsa, const unsigned char *block, unsigned char *out) {
  if (mbedtls_rsa_public(rsa, block, out) != 0) {
    sp_rsa_opaque();
    return false;
  }
  return true;
}

/* OAEP's encoding (RFC 8017 7.1.1), whose checks the provider makes before
 * the public-key operation. */
static bool sp_oaep_encode(const SpRsaOp *op, const ScrBytes *in, unsigned char *em, size_t k) {
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(op->md);
  size_t h = mbedtls_md_get_size(info);
  size_t len = (size_t)scr_bytes_byte_len(in);
  if ((int64_t)len > (int64_t)(k - 1) - 2 * (int64_t)h - 1) {
    sp_rsa_error("0200006E", "data too large for key size", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE");
    return false;
  }
  memset(em, 0, k);
  unsigned char *seed = em + 1;
  unsigned char *db = em + 1 + h;
  size_t db_len = k - h - 1;
  /* DB = lHash || PS || 0x01 || M, with PS the zeros above. */
  mbedtls_md(info, op->label ? op->label->data : NULL,
             op->label ? (size_t)scr_bytes_byte_len(op->label) : 0, db);
  db[db_len - len - 1] = 0x01;
  if (len) memcpy(db + db_len - len, in->data, len);
  sp_random(NULL, seed, h);
  if (sp_mgf1_xor(op->mgf1, seed, h, db, db_len) != 0) return false;
  if (sp_mgf1_xor(op->mgf1, db, db_len, seed, h) != 0) return false;
  return true;
}

/* OpenSSL's constant-time building blocks (crypto/constant_time.c): the
 * padding checks below run on values derived from a secret, so the masks are
 * computed without branches and a select keeps both operands live. */
static unsigned int sp_ct_barrier(unsigned int a) {
#if defined(__GNUC__)
  unsigned int r;
  __asm__("" : "=r"(r) : "0"(a));
#else
  volatile unsigned int r = a;
#endif
  return r;
}

static unsigned int sp_ct_msb(unsigned int a) { return 0 - (a >> (sizeof(a) * 8 - 1)); }

static unsigned int sp_ct_lt(unsigned int a, unsigned int b) {
  return sp_ct_msb(a ^ ((a ^ b) | ((a - b) ^ b)));
}

static unsigned int sp_ct_ge(unsigned int a, unsigned int b) { return ~sp_ct_lt(a, b); }

static unsigned int sp_ct_is_zero(unsigned int a) { return sp_ct_msb(~a & (a - 1)); }

static unsigned int sp_ct_select(unsigned int mask, unsigned int a, unsigned int b) {
  return (sp_ct_barrier(mask) & a) | (sp_ct_barrier(~mask) & b);
}

static unsigned char sp_ct_select_8(unsigned int mask, unsigned char a, unsigned char b) {
  return (unsigned char)sp_ct_select(mask, a, b);
}

/* OAEP's decoding (RFC 8017 7.1.2) of the k-byte message. Every check that
 * fails is the provider's one decoding error, and the checks are made the way
 * OpenSSL's RSA_padding_check_PKCS1_OAEP_mgf1 makes them: a rejected block
 * takes the same time as an accepted one. */
static ScrDyn *sp_oaep_decode(const SpRsaOp *op, const unsigned char *em, size_t k) {
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(op->md);
  size_t h = mbedtls_md_get_size(info);
  if (k < 2 * h + 2) {
    sp_rsa_error("02000079", "oaep decoding error", "ERR_OSSL_RSA_OAEP_DECODING_ERROR");
    return NULL;
  }
  size_t db_len = k - h - 1;
  size_t limit = db_len - h - 1; /* the longest message the block can hold */
  unsigned char *work = malloc(h + db_len);
  if (!work) scr_trap("scriptc: out of memory\n");
  unsigned char *seed = work;
  unsigned char *db = work + h;
  memcpy(seed, em + 1, h);
  memcpy(db, em + 1 + h, db_len);
  /* seed ^= MGF1(maskedDB); DB ^= MGF1(seed) */
  sp_mgf1_xor(op->mgf1, db, db_len, seed, h);
  sp_mgf1_xor(op->mgf1, seed, h, db, db_len);

  /* Manger's attack reads a branch on the leading byte, so it is compared
   * without one, as is the label hash. */
  unsigned int good = sp_ct_is_zero(em[0]);
  unsigned char lhash[MBEDTLS_MD_MAX_SIZE];
  mbedtls_md(info, op->label ? op->label->data : NULL,
             op->label ? (size_t)scr_bytes_byte_len(op->label) : 0, lhash);
  unsigned int diff = 0;
  for (size_t i = 0; i < h; i++) diff |= (unsigned int)(db[i] ^ lhash[i]);
  good &= sp_ct_is_zero(diff);
  mbedtls_platform_zeroize(lhash, sizeof lhash);

  /* DB = lHash || PS || 0x01 || M. The separator is the first byte that is
   * not a zero of the padding and not the 0x01, and every byte of DB is
   * read for it. */
  unsigned int found_one_byte = 0;
  unsigned int one_index = 0;
  for (size_t i = h; i < db_len; i++) {
    unsigned int equals_one = sp_ct_is_zero((unsigned int)db[i] ^ 0x01);
    unsigned int equals_zero = sp_ct_is_zero(db[i]);
    one_index = sp_ct_select(~found_one_byte & equals_one, (unsigned int)i, one_index);
    found_one_byte |= equals_one;
    good &= found_one_byte | equals_zero;
  }
  good &= found_one_byte;

  unsigned int msg_index = one_index + 1;
  unsigned int mlen = (unsigned int)db_len - msg_index;
  good &= sp_ct_ge((unsigned int)limit, mlen); /* the message fits output */

  /* Move the message to the offset the copy below reads with a barrel shift,
   * so that neither does the copy address depend on the separator found. A
   * rejected block does not move anything, which the masks make no faster. */
  unsigned int shift = sp_ct_select(good, (unsigned int)(db_len - h - 1) - mlen, 0);
  for (size_t step = 1; step < limit; step <<= 1) {
    unsigned int mask = ~sp_ct_is_zero((unsigned int)step & shift);
    for (size_t i = h + 1; i < db_len - step; i++) db[i] = sp_ct_select_8(mask, db[i + step], db[i]);
  }

  /* Copy the message in place; the bytes past its end are selected away, so
   * the copy reads and writes the same bytes whichever way the check went. */
  size_t room = limit ? limit : 1;
  unsigned char *message = malloc(room);
  if (!message) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < limit; i++)
    message[i] = sp_ct_select_8(good & sp_ct_lt((unsigned int)i, mlen), db[h + 1 + i], 0);
  mbedtls_platform_zeroize(work, h + db_len);
  free(work);
  if (!good) {
    mbedtls_platform_zeroize(message, room);
    free(message);
    sp_rsa_error("02000079", "oaep decoding error", "ERR_OSSL_RSA_OAEP_DECODING_ERROR");
    return NULL;
  }
  ScrDyn *out = sp_dyn_buffer(message, mlen);
  mbedtls_platform_zeroize(message, room);
  free(message);
  return out;
}

/* PKCS#1 v1.5 type 2 padding (encryption): 00 || 02 || PS || 00 || M. */
static bool sp_pkcs1_encrypt(const ScrBytes *in, unsigned char *em, size_t k) {
  size_t len = (size_t)scr_bytes_byte_len(in);
  if ((int64_t)len > (int64_t)k - 11) {
    sp_rsa_error("0200006E", "data too large for key size", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE");
    return false;
  }
  size_t ps = k - len - 3;
  em[0] = 0x00;
  em[1] = 0x02;
  for (size_t i = 0; i < ps; i++) {
    unsigned char b = 0;
    while (b == 0) sp_random(NULL, &b, 1);
    em[2 + i] = b;
  }
  em[2 + ps] = 0x00;
  if (len) memcpy(em + 3 + ps, in->data, len);
  return true;
}

/* PKCS#1 v1.5 type 1 padding (signing): 00 || 01 || PS || 00 || M. */
static bool sp_pkcs1_sign(const ScrBytes *in, unsigned char *em, size_t k) {
  size_t len = (size_t)scr_bytes_byte_len(in);
  if ((int64_t)len > (int64_t)k - 11) {
    sp_rsa_error("0200006E", "data too large for key size", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE");
    return false;
  }
  size_t ps = k - len - 3;
  memset(em, 0xff, k);
  em[0] = 0x00;
  em[1] = 0x01;
  em[2 + ps] = 0x00;
  if (len) memcpy(em + 3 + ps, in->data, len);
  return true;
}

/* PKCS#1 v1.5 type 1's check (recovery): the message, or the error the
 * recovery reports for the first check that fails. */
static ScrDyn *sp_pkcs1_recover(const unsigned char *buf, size_t k) {
  size_t p = 0;
  size_t flen = k;
  if (k < 11) {
    /* The type 1 check's shortest answer: no message disappears. */
    sp_rsa_error("02000065", "padding check failed", "ERR_OSSL_RSA_PADDING_CHECK_FAILED");
    return NULL;
  }
  /* Accept inputs with and without the leading 0 byte; a recovered block
     always has it. */
  if (buf[p] != 0x00) {
    sp_rsa_error("0200008A", "invalid padding", "ERR_OSSL_RSA_INVALID_PADDING");
    return NULL;
  }
  p++;
  flen--;
  if (flen + 1 != k || buf[p] != 0x01) {
    sp_rsa_error("0200006A", "block type is not 01", "ERR_OSSL_RSA_BLOCK_TYPE_IS_NOT_01");
    return NULL;
  }
  p++;
  size_t j = flen - 1; /* one for the type */
  size_t i = 0;
  for (; i < j; i++, p++) {
    if (buf[p] != 0xff) {
      if (buf[p] == 0x00) {
        p++;
        break;
      }
      sp_rsa_error("02000066", "bad fixed header decrypt", "ERR_OSSL_RSA_BAD_FIXED_HEADER_DECRYPT");
      return NULL;
    }
  }
  if (i == j) {
    sp_rsa_error("02000068", "null before block missing", "ERR_OSSL_RSA_NULL_BEFORE_BLOCK_MISSING");
    return NULL;
  }
  if (i < 8) {
    sp_rsa_error("02000067", "bad pad byte count", "ERR_OSSL_RSA_BAD_PAD_BYTE_COUNT");
    return NULL;
  }
  i++; /* the separator */
  j -= i;
  if (j > k) {
    sp_rsa_error("02000069", "data too large", "ERR_OSSL_RSA_DATA_TOO_LARGE");
    return NULL;
  }
  return sp_dyn_buffer(buf + p, j);
}

/* The HMAC-SHA256 stream OpenSSL's implicit rejection draws from (its
 * ossl_rsa_prf): be16(iter) || label || be16(bitlen) per block. */
static int sp_rsa_prf(const unsigned char kdk[32], const char *label, size_t llen, unsigned char *out, size_t len,
                      uint16_t bitlen) {
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  int r = mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  unsigned char block[32];
  unsigned char bits[2] = {(unsigned char)(bitlen >> 8), (unsigned char)bitlen};
  for (size_t iter = 0; r == 0 && iter * 32 < len; iter++) {
    unsigned char be[2] = {(unsigned char)(iter >> 8), (unsigned char)iter};
    if ((r = mbedtls_md_hmac_starts(&ctx, kdk, 32)) == 0 &&
        (r = mbedtls_md_hmac_update(&ctx, be, 2)) == 0 &&
        (r = mbedtls_md_hmac_update(&ctx, (const unsigned char *)label, llen)) == 0 &&
        (r = mbedtls_md_hmac_update(&ctx, bits, 2)) == 0)
      r = mbedtls_md_hmac_finish(&ctx, block);
    if (r != 0) break;
    size_t pos = iter * 32;
    size_t n = len - pos < 32 ? len - pos : 32;
    memcpy(out + pos, block, n);
  }
  mbedtls_platform_zeroize(block, sizeof block);
  mbedtls_md_free(&ctx);
  return r;
}

/* OpenSSL's implicit rejection key derivation: HMAC-SHA256 keyed by
 * SHA-256 of the private exponent over the ciphertext zero-padded to the
 * modulus length. False when the key carries no private exponent, which
 * does not depend on the ciphertext. */
static bool sp_rsa_kdk(mbedtls_rsa_context *rsa, const unsigned char *ct, size_t ct_len, size_t k,
                       unsigned char kdk[32]) {
  unsigned char d[MBEDTLS_MPI_MAX_SIZE];
  if (mbedtls_mpi_write_binary(&rsa->MBEDTLS_PRIVATE(D), d, k) != 0) {
    sp_rsa_error("020000B3", "missing private key", "ERR_OSSL_RSA_MISSING_PRIVATE_KEY");
    return false;
  }
  unsigned char d_hash[32];
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), d, k, d_hash);
  mbedtls_platform_zeroize(d, k);
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  int r = mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  if (r == 0) r = mbedtls_md_hmac_starts(&ctx, d_hash, 32);
  if (r == 0 && ct_len < k) {
    static const unsigned char zeros[MBEDTLS_MPI_MAX_SIZE] = {0};
    r = mbedtls_md_hmac_update(&ctx, zeros, k - ct_len);
  }
  if (r == 0) r = mbedtls_md_hmac_update(&ctx, ct, ct_len);
  if (r == 0) r = mbedtls_md_hmac_finish(&ctx, kdk);
  mbedtls_md_free(&ctx);
  mbedtls_platform_zeroize(d_hash, sizeof d_hash);
  if (r != 0) scr_trap("scriptc: crypto: PKCS#1 v1.5 key derivation failed\n");
  return true;
}

/* PKCS#1 v1.5 type 2's check of a decrypted block, with the implicit
 * rejection a failure ends in: a synthetic plaintext, always the same for a
 * given ciphertext, derived from the private exponent and the ciphertext so
 * that a caller cannot tell the padding failed. The synthetic message is
 * generated for every call, the check reads the whole block without
 * branching, and the message, its start and its length are chosen with
 * masks, so a decryption takes the same time whichever way the padding
 * checks (OpenSSL's ossl_rsa_padding_check_PKCS1_type_2). */
static ScrDyn *sp_pkcs1_decrypt(mbedtls_rsa_context *rsa, const unsigned char *buf, size_t k, const ScrBytes *ct) {
  unsigned char kdk[32];
  if (!sp_rsa_kdk(rsa, ct->data, (size_t)scr_bytes_byte_len(ct), k, kdk)) return NULL;

  unsigned char *synthetic = malloc(k);
  unsigned char *candidates = malloc(256);
  if (!synthetic || !candidates) scr_trap("scriptc: out of memory\n");
  if (sp_rsa_prf(kdk, "message", 7, synthetic, k, (uint16_t)(k * 8)) != 0 ||
      sp_rsa_prf(kdk, "length", 6, candidates, 256, 256 * 8) != 0)
    scr_trap("scriptc: crypto: PKCS#1 v1.5 rejection stream failed\n");
  mbedtls_platform_zeroize(kdk, sizeof kdk);

  /* The synthetic message ends at the last generated length below k - 10. */
  uint16_t max_sep_offset = (uint16_t)(k - 10);
  uint16_t length_mask = max_sep_offset;
  length_mask |= length_mask >> 1;
  length_mask |= length_mask >> 2;
  length_mask |= length_mask >> 4;
  length_mask |= length_mask >> 8;
  unsigned int synthetic_length = 0;
  for (size_t i = 0; i < 256; i += 2) {
    uint16_t candidate = (uint16_t)((candidates[i] << 8) | candidates[i + 1]) & length_mask;
    synthetic_length = sp_ct_select(sp_ct_lt(candidate, max_sep_offset), candidate, synthetic_length);
  }
  free(candidates);

  /* 00 || 02 || PS || 00, with at least eight bytes of PS. */
  unsigned int good = sp_ct_is_zero(buf[0]);
  good &= sp_ct_is_zero((unsigned int)buf[1] ^ 0x02);
  unsigned int found_zero_byte = 0;
  unsigned int zero_index = 0;
  for (size_t i = 2; i < k; i++) {
    unsigned int equals_zero = sp_ct_is_zero(buf[i]);
    zero_index = sp_ct_select(~found_zero_byte & equals_zero, (unsigned int)i, zero_index);
    found_zero_byte |= equals_zero;
  }
  good &= sp_ct_ge(zero_index, 2 + 8);
  unsigned int msg_index = zero_index + 1;
  /* The message has to fit the output, which is as long as the modulus. */
  good &= sp_ct_ge((unsigned int)k, (unsigned int)k - msg_index);
  msg_index = sp_ct_select(good, msg_index, (unsigned int)k - synthetic_length);

  /* Every output byte reads the real block and the synthetic message, so
   * neither the padding's validity nor the message's content decides a
   * branch or a cache access. */
  unsigned char *message = malloc(k);
  if (!message) scr_trap("scriptc: out of memory\n");
  size_t length = 0;
  for (size_t i = msg_index; i < k && length < k; i++, length++)
    message[length] = sp_ct_select_8(good, buf[i], synthetic[i]);
  free(synthetic);
  ScrDyn *out = sp_dyn_buffer(message, length);
  free(message);
  return out;
}

/* publicEncrypt: EVP_PKEY_encrypt. */
static ScrDyn *sp_rsa_encrypt(SpRsaOp *op, const ScrBytes *in) {
  if (op->key->rsa_pss) {
    sp_rsa_provider("1C8000B2", "operation not supported for this keytype",
                    "ERR_OSSL_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    return NULL;
  }
  if (!sp_is_rsa(op->key)) {
    sp_rsa_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                   "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    return NULL;
  }
  if (op->padding == SP_PAD_PSS) {
    /* The provider's init refuses to set up a PSS encryption without
       raising anything. */
    sp_rsa_opaque();
    return NULL;
  }
  mbedtls_rsa_context *rsa = mbedtls_pk_rsa(op->key->pk);
  size_t k = mbedtls_rsa_get_len(rsa);
  size_t len = (size_t)scr_bytes_byte_len(in);
  unsigned char *em = malloc(k);
  unsigned char *out = malloc(k);
  if (!em || !out) scr_trap("scriptc: out of memory\n");
  bool ok = true;
  switch (op->padding) {
  case SP_PAD_OAEP:
    ok = sp_oaep_encode(op, in, em, k);
    break;
  case SP_PAD_PKCS1:
    ok = sp_pkcs1_encrypt(in, em, k);
    break;
  case SP_PAD_NONE:
    if (len > k) {
      sp_rsa_error("0200006E", "data too large for key size", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE");
      ok = false;
    } else if (len < k) {
      sp_rsa_error("0200007A", "data too small for key size", "ERR_OSSL_RSA_DATA_TOO_SMALL_FOR_KEY_SIZE");
      ok = false;
    } else {
      memcpy(em, in->data, k);
    }
    break;
  default:
    sp_rsa_error("02000076", "unknown padding type", "ERR_OSSL_RSA_UNKNOWN_PADDING_TYPE");
    ok = false;
    break;
  }
  ScrDyn *result = NULL;
  if (ok) {
    if (sp_rsa_block_too_large(rsa, em, k)) {
      sp_rsa_error("02000084", "data too large for modulus", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS");
    } else if (sp_rsa_public_op(rsa, em, out)) {
      result = sp_dyn_buffer(out, k);
    }
  }
  free(em);
  free(out);
  return result;
}

/* privateDecrypt: EVP_PKEY_decrypt. */
static ScrDyn *sp_rsa_decrypt(SpRsaOp *op, const ScrBytes *in) {
  if (op->key->rsa_pss) {
    sp_rsa_provider("1C8000B2", "operation not supported for this keytype",
                    "ERR_OSSL_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    return NULL;
  }
  if (!sp_is_rsa(op->key)) {
    sp_rsa_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                   "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    return NULL;
  }
  if (op->padding == SP_PAD_PSS) {
    sp_rsa_opaque();
    return NULL;
  }
  mbedtls_rsa_context *rsa = mbedtls_pk_rsa(op->key->pk);
  size_t k = mbedtls_rsa_get_len(rsa);
  size_t len = (size_t)scr_bytes_byte_len(in);
  /* The raw private operation's checks come before the padding. */
  if (len > k) {
    sp_rsa_error("0200006C", "data greater than mod len", "ERR_OSSL_RSA_DATA_GREATER_THAN_MOD_LEN");
    return NULL;
  }
  if (len < 1) {
    sp_rsa_error("0200006F", "data too small", "ERR_OSSL_RSA_DATA_TOO_SMALL");
    return NULL;
  }
  unsigned char *block = malloc(k);
  unsigned char *out = malloc(k);
  if (!block || !out) scr_trap("scriptc: out of memory\n");
  ScrDyn *result = NULL;
  sp_rsa_block_of(in, block, k);
  if (!sp_rsa_block_too_large(rsa, block, k)) {
    if (sp_rsa_private_op(op->key, block, out)) {
      switch (op->padding) {
      case SP_PAD_OAEP:
        result = sp_oaep_decode(op, out, k);
        break;
      case SP_PAD_PKCS1:
        result = sp_pkcs1_decrypt(rsa, out, k, in);
        break;
      case SP_PAD_NONE:
        result = sp_dyn_buffer(out, k);
        break;
      case SP_PAD_TLS:
        sp_rsa_provider("1C8000A1", "bad tls client version", "ERR_OSSL_BAD_TLS_CLIENT_VERSION");
        break;
      default:
        sp_rsa_error("02000076", "unknown padding type", "ERR_OSSL_RSA_UNKNOWN_PADDING_TYPE");
        break;
      }
    }
  } else {
    sp_rsa_error("02000084", "data too large for modulus", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS");
  }
  free(block);
  free(out);
  return result;
}

/* privateEncrypt: EVP_PKEY_sign, the raw private operation with a type 1
 * padding. */
static ScrDyn *sp_rsa_sign(SpRsaOp *op, const ScrBytes *in) {
  if (op->key->rsa_pss) {
    if (op->padding == SP_PAD_PSS)
      sp_rsa_provider("1C8000A6", "invalid digest length", "ERR_OSSL_INVALID_DIGEST_LENGTH");
    else
      sp_rsa_provider("1C8000A5", "illegal or unsupported padding mode",
                      "ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE");
    return NULL;
  }
  if (!sp_is_rsa(op->key)) {
    /* X25519 keys have no signature operation at all; the other key
       types' init then refuses the RSA padding without raising. */
    if (sp_is_x(op->key))
      sp_rsa_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                     "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    else
      sp_rsa_opaque();
    return NULL;
  }
  mbedtls_rsa_context *rsa = mbedtls_pk_rsa(op->key->pk);
  size_t k = mbedtls_rsa_get_len(rsa);
  size_t len = (size_t)scr_bytes_byte_len(in);
  unsigned char *em = malloc(k);
  unsigned char *out = malloc(k);
  if (!em || !out) scr_trap("scriptc: out of memory\n");
  bool ok = true;
  switch (op->padding) {
  case SP_PAD_PKCS1:
    ok = sp_pkcs1_sign(in, em, k);
    break;
  case SP_PAD_NONE:
    if (len > k) {
      sp_rsa_error("0200006E", "data too large for key size", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE");
      ok = false;
    } else if (len < k) {
      sp_rsa_error("0200007A", "data too small for key size", "ERR_OSSL_RSA_DATA_TOO_SMALL_FOR_KEY_SIZE");
      ok = false;
    } else {
      memcpy(em, in->data, k);
    }
    break;
  case SP_PAD_X931:
    sp_rsa_provider("1C8000AA", "invalid x931 digest", "ERR_OSSL_INVALID_X931_DIGEST");
    ok = false;
    break;
  case SP_PAD_PSS:
    sp_rsa_provider("1C8000A6", "invalid digest length", "ERR_OSSL_INVALID_DIGEST_LENGTH");
    ok = false;
    break;
  default:
    sp_rsa_provider("1C8000A5", "illegal or unsupported padding mode",
                    "ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE");
    ok = false;
    break;
  }
  ScrDyn *result = NULL;
  if (ok) {
    if (sp_rsa_block_too_large(rsa, em, k)) {
      sp_rsa_error("02000084", "data too large for modulus", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS");
    } else if (sp_rsa_private_op(op->key, em, out)) {
      result = sp_dyn_buffer(out, k);
    }
  }
  free(em);
  free(out);
  return result;
}

/* publicDecrypt: EVP_PKEY_verify_recover, the public-key operation whose
 * result is the padded message. */
static ScrDyn *sp_rsa_recover(SpRsaOp *op, const ScrBytes *in) {
  if (op->key->rsa_pss) {
    sp_rsa_provider("1C8000B2", "operation not supported for this keytype",
                    "ERR_OSSL_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    return NULL;
  }
  if (!sp_is_rsa(op->key)) {
    if (sp_is_x(op->key))
      sp_rsa_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                     "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE");
    else
      sp_rsa_openssl("030000ED", "digital envelope routines", "provider signature not supported",
                     "ERR_OSSL_EVP_PROVIDER_SIGNATURE_NOT_SUPPORTED");
    return NULL;
  }
  if (op->padding == SP_PAD_X931) {
    sp_rsa_provider("1C8000AA", "invalid x931 digest", "ERR_OSSL_INVALID_X931_DIGEST");
    return NULL;
  }
  if (op->padding != SP_PAD_PKCS1 && op->padding != SP_PAD_NONE) {
    sp_rsa_provider("1C8000A5", "illegal or unsupported padding mode",
                    "ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE");
    return NULL;
  }
  mbedtls_rsa_context *rsa = mbedtls_pk_rsa(op->key->pk);
  size_t k = mbedtls_rsa_get_len(rsa);
  size_t len = (size_t)scr_bytes_byte_len(in);
  if (len > k) {
    sp_rsa_error("0200006C", "data greater than mod len", "ERR_OSSL_RSA_DATA_GREATER_THAN_MOD_LEN");
    return NULL;
  }
  unsigned char *block = malloc(k);
  unsigned char *out = malloc(k);
  if (!block || !out) scr_trap("scriptc: out of memory\n");
  ScrDyn *result = NULL;
  sp_rsa_block_of(in, block, k);
  if (sp_rsa_block_too_large(rsa, block, k)) {
    sp_rsa_error("02000084", "data too large for modulus", "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS");
  } else if (sp_rsa_public_op(rsa, block, out)) {
    if (op->padding == SP_PAD_PKCS1)
      result = sp_pkcs1_recover(out, k);
    else
      result = sp_dyn_buffer(out, k);
  }
  free(block);
  free(out);
  return result;
}

/* The four crypto functions, which differ only in the operation and its
 * default padding. */
static ScrDyn *sp_rsa_call(const ScrDyn *key, const ScrDyn *buffer, int operation) {
  SpRsaOp op;
  ScrBytes *data = NULL;
  if (!sp_rsa_prepare(key, buffer, operation, &op, &data)) return NULL;
  ScrDyn *result = NULL;
  switch (operation) {
  case SP_RSA_ENCRYPT:
    result = sp_rsa_encrypt(&op, data);
    break;
  case SP_RSA_DECRYPT:
    result = sp_rsa_decrypt(&op, data);
    break;
  case SP_RSA_SIGN:
    result = sp_rsa_sign(&op, data);
    break;
  default:
    result = sp_rsa_recover(&op, data);
    break;
  }
  scr_bytes_release(data);
  sp_rsa_release(&op);
  return result;
}

ScrDyn *scr_crypto_public_encrypt(ScrDyn *key, ScrDyn *buffer) {
  return sp_rsa_call(key, buffer, SP_RSA_ENCRYPT);
}

ScrDyn *scr_crypto_private_decrypt(ScrDyn *key, ScrDyn *buffer) {
  return sp_rsa_call(key, buffer, SP_RSA_DECRYPT);
}

ScrDyn *scr_crypto_private_encrypt(ScrDyn *key, ScrDyn *buffer) {
  return sp_rsa_call(key, buffer, SP_RSA_SIGN);
}

ScrDyn *scr_crypto_public_decrypt(ScrDyn *key, ScrDyn *buffer) {
  return sp_rsa_call(key, buffer, SP_RSA_RECOVER);
}

/* ── The introspection statics ────────────────────────────────────────── */

/* Node answers the libuv secure heap's counters; a compiled binary never
 * opens one, so the record is 0/0/Min(0)/2 with utilization 0/0. */
ScrDyn *scr_crypto_secure_heap_used(void) {
  ScrDyn *usage = scr_dyn_new_obj();
  scr_dyn_obj_set(usage, "total", 5, scr_dyn_new_num(0));
  scr_dyn_obj_set(usage, "used", 4, scr_dyn_new_num(0));
  scr_dyn_obj_set(usage, "utilization", 11, scr_dyn_new_num(NAN));
  scr_dyn_obj_set(usage, "min", 3, scr_dyn_new_num(2));
  return usage;
}

/* ERR_CRYPTO_ENGINE_UNKNOWN's message carries the id verbatim, NUL bytes
 * included (Node's template literal does). */
static void sp_throw_engine_unknown(const ScrStr *id) {
  static const char prefix[] = "Engine \"";
  static const char suffix[] = "\" was not found";
  size_t head = sizeof prefix - 1, tail = sizeof suffix - 1;
  size_t length = head + id->len + tail;
  char *message = malloc(length + 1);
  if (!message) scr_trap("scriptc: out of memory\n");
  memcpy(message, prefix, head);
  if (id->len > 0) memcpy(message + head, id->data, id->len);
  memcpy(message + head + id->len, suffix, tail + 1);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, length, "ERR_CRYPTO_ENGINE_UNKNOWN");
  free(message);
}

/* lib/internal/crypto/util.js setEngine: validateString(id), a truthy
 * flags validates as a number, flags >>> 0, and ENGINE_by_id(id) — which
 * is case-sensitive and stops at the first NUL. OpenSSL 3 registers only
 * the "dynamic" engine in this runtime, so that id answers undefined and
 * every other id reports ERR_CRYPTO_ENGINE_UNKNOWN. */
void scr_crypto_set_engine(ScrDyn *engine, ScrDyn *flags) {
  if (engine == NULL || engine->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("id", "of type string", engine);
    return;
  }
  if (flags != NULL && scr_dyn_truthy(flags) && flags->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("flags", "of type number", flags);
    return;
  }
  const ScrStr *id = engine->v.str;
  size_t length = 0;
  while (length < id->len && id->data[length] != '\0') length++;
  if (length == 7 && memcmp(id->data, "dynamic", 7) == 0) return;
  sp_throw_engine_unknown(id);
}

/* crypto.fips is getFips() behind a deprecation wrapper: the DEP0093
 * report is emitted once per process, at the first read. */
double scr_crypto_fips_get(void) {
  static bool reported = false;
  if (!reported) {
    reported = true;
    static const char text[] = "The crypto.fips is deprecated. Please use crypto.getFips()";
    ScrStr *message = scr_str_new(text, sizeof text - 1);
    scr_emit_warning("DeprecationWarning", "DEP0093", message);
    scr_str_release(message);
  }
  return 0;
}

/* ── Sign and Verify objects ──────────────────────────────────────────── */

typedef struct SpSigner {
  size_t rc;
  mbedtls_md_context_t md;
  mbedtls_md_type_t type;
  bool done; /* sign()/verify() ran: Node's "Not initialised" afterwards */
  bool verifier; /* createVerify rather than createSign */
  /* The Writable of a Sign or Verify used as a stream (+1) and its release
   * (scr_stream.c). Its step holds the signer, so the signer is a
   * collector-headered object behind a traced handle, and the pair is
   * reclaimed as a cycle. */
  void *stream;
  void (*stream_release)(void *);
} SpSigner;

static void *sp_signer_retain(void *h) {
  ((SpSigner *)h)->rc++;
  return h;
}

static void sp_signer_trace(void *h, ScrTraceVisit visit, void *ctx) {
  SpSigner *s = h;
  if (s->stream) visit(s->stream, ctx);
}

/* The collector frees the stream itself; the rest is released here. */
static void sp_signer_gcfree(void *h) {
  SpSigner *s = h;
  mbedtls_md_free(&s->md);
  mbedtls_platform_zeroize(s, sizeof *s);
  scr_obj_free_note();
  scr_cyc_free(s);
}

static void sp_signer_destroy(void *h) {
  SpSigner *s = h;
  void *stream = s->stream;
  s->stream = NULL;
  if (stream) s->stream_release(stream);
  sp_signer_gcfree(s);
}

static void sp_signer_release(void *h) {
  SpSigner *s = h;
  if (--s->rc == 0) {
    scr_cyc_dead(s);
    scr_rc_destroy(s, sp_signer_destroy);
  } else scr_cyc_released(s);
}

static void sp_not_initialised(void) {
  sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INVALID_STATE", "Not initialised");
}

/* An object's toString the program defined, as an own or inherited
 * function property. */
static bool sp_custom_to_string(ScrDyn *value) {
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_TYPED_REF) return false;
  ScrDyn *member = scr_dyn_obj_read(value, "toString", 8);
  bool custom = member && member->kind == SCR_DYN_FUNC;
  scr_dyn_release(member);
  return custom;
}

/* Whether value is a class instance whose class defines toString. */
static bool sp_class_to_string(const ScrDyn *value) {
  ScrStr *name = scr_str_new("toString", 8);
  bool method = scr_dyn_typed_ref_class_has(value, name);
  scr_str_release(name);
  return method;
}

/* ERR_UNKNOWN_ENCODING for an encoding value that is not a string:
 * util.format's %s shape, which reads a program-defined toString and
 * inspects anything else. */
static void sp_unknown_encoding(const ScrDyn *value) {
  ScrStr *rendered = NULL;
  char sketch[160];
  const char *text;
  if (sp_custom_to_string((ScrDyn *)value)) rendered = scr_dyn_string_coerce_js(value);
  size_t text_len;
  if (rendered) {
    text = rendered->data;
    text_len = rendered->len;
  } else if (value->kind == SCR_DYN_STR) {
    text = value->v.str->data;
    text_len = value->v.str->len;
  } else if (value->kind == SCR_DYN_NUM) {
    scr_num_received(value->v.num, sketch);
    text = sketch;
    text_len = strlen(text);
  } else {
    text = scr_dyn_inspect_lite(value, sketch, sizeof sketch);
    text_len = strlen(text);
  }
  char *message = malloc(text_len + 19);
  if (!message) scr_trap("scriptc: out of memory\n");
  memcpy(message, "Unknown encoding: ", 18);
  memcpy(message + 18, text, text_len);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, text_len + 18, "ERR_UNKNOWN_ENCODING");
  free(message);
  if (rendered) scr_str_release(rendered);
}

/* Buffer.from(text, encoding), for a signature argument: an encoding that
 * is not a string, is empty, or is 'buffer' reads as UTF-8, and an unknown
 * name throws ERR_UNKNOWN_ENCODING. +1, or NULL after throwing. */
static ScrBytes *sp_string_bytes(const ScrStr *text, const ScrDyn *encoding) {
  const char *name = "utf8";
  ScrStr *normalized = NULL;
  if (encoding->kind == SCR_DYN_STR && encoding->v.str->len > 0 && !sp_is_str(encoding, "buffer")) {
    normalized = scr_bytes_normalize_encoding(encoding->v.str);
    if (!normalized) {
      sp_unknown_encoding(encoding);
      return NULL;
    }
    name = normalized->data;
  }
  ScrStr *canonical = scr_str_new(name, strlen(name));
  ScrBytes *bytes = scr_bytes_from_str(text, canonical);
  scr_str_release(canonical);
  if (normalized) scr_str_release(normalized);
  return bytes;
}

/* encode(buffer, encoding): the Buffer, or buffer.toString(encoding) for
 * a truthy encoding other than 'buffer'. Consumes bytes. */
static ScrDyn *sp_encode(ScrBytes *bytes, const ScrDyn *encoding) {
  if (!scr_dyn_truthy(encoding) || (encoding->kind == SCR_DYN_STR && sp_is_str(encoding, "buffer"))) {
    ScrDyn *result = scr_dyn_new_buffer(bytes);
    scr_bytes_release(bytes);
    return result;
  }
  /* toString answers "" for no bytes before it reads the encoding. */
  if (scr_bytes_byte_len(bytes) == 0) {
    scr_bytes_release(bytes);
    return sp_dyn_str(scr_str_new("", 0));
  }
  ScrStr *name = NULL;
  if (encoding->kind == SCR_DYN_STR) {
    name = scr_str_retain(encoding->v.str);
  } else if (encoding->kind == SCR_DYN_FUNC || sp_class_to_string(encoding)) {
    /* toString of a function or class instance has no lowering. */
    scr_bytes_release(bytes);
    static const char message[] =
        "encoding that is a function or an instance of a class defining toString has no lowering; "
        "pass the name as a string";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  } else if (!sp_custom_to_string((ScrDyn *)encoding)) {
    scr_bytes_release(bytes);
    sp_unknown_encoding(encoding);
    return NULL;
  } else {
    name = scr_dyn_string_coerce_js(encoding);
  }
  if (!name) {
    scr_bytes_release(bytes);
    return NULL;
  }
  ScrStr *normalized = scr_bytes_normalize_encoding(name);
  scr_str_release(name);
  if (!normalized) {
    scr_bytes_release(bytes);
    sp_unknown_encoding(encoding);
    return NULL;
  }
  ScrStr *text = scr_bytes_to_str(bytes, normalized);
  scr_str_release(normalized);
  scr_bytes_release(bytes);
  if (!text) return NULL;
  ScrDyn *result = sp_dyn_str(text);
  scr_str_release(text);
  return result;
}

/* update(data[, inputEncoding]): strings encode with the encoding, which
 * reads as UTF-8 when it is not a string or not a known name, as Node's
 * C++ Update does. */
static bool sp_signer_update(SpSigner *s, ScrDyn *const *args, size_t argc) {
  if (s->done) {
    sp_not_initialised();
    return false;
  }
  const ScrDyn *data = argc ? args[0] : scr_dyn_undefined();
  ScrBytes *bytes = NULL;
  if (data->kind == SCR_DYN_STR) {
    const ScrDyn *encoding = argc > 1 ? args[1] : NULL;
    const char *name =
        encoding && encoding->kind == SCR_DYN_STR ? sp_normalize_encoding(encoding->v.str) : NULL;
    /* validateEncoding: hex input must have an even length. */
    if (name && strcmp(name, "hex") == 0 && (unsigned long)scr_str_utf16_len(data->v.str) % 2 != 0) {
      char rendered[160];
      const char *text = scr_dyn_inspect_lite(encoding, rendered, sizeof rendered);
      char message[256];
      snprintf(message, sizeof message, "The argument 'encoding' is invalid for data of length %lu. Received %s",
               (unsigned long)scr_str_utf16_len(data->v.str), text);
      sp_throw(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", message);
      return false;
    }
    ScrStr *canonical = scr_str_new(name ? name : "utf8", strlen(name ? name : "utf8"));
    bytes = scr_bytes_from_str(data->v.str, canonical);
    scr_str_release(canonical);
  } else if (data->kind == SCR_DYN_BYTES) {
    bytes = scr_bytes_buffer_source(data);
  } else {
    scr_dyn_arg_type_fail("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
    return false;
  }
  if (!bytes) return false;
  mbedtls_md_update(&s->md, bytes->data, (size_t)scr_bytes_byte_len(bytes));
  scr_bytes_release(bytes);
  return true;
}

/* ── Sign and Verify as streams ─────────────────────────────────────────
 * The stream unit builds a signer's Writable from these operations
 * (ScrDynHandleWritable): each chunk goes through update(), as Node's
 * Sign.prototype._write does. There is no final step, so ending the stream
 * finishes it as soon as the last write completes. */

static void *sp_signer_stream_get(void *h) {
  return ((SpSigner *)h)->stream;
}

static void sp_signer_stream_set(void *h, void *stream, void (*release)(void *)) {
  SpSigner *s = h;
  s->stream = stream;
  s->stream_release = release;
}

/* The handle's write(): the chunk's bytes go through update(). A sign() or
 * verify() that already ran refuses as update() does ("Not initialised"),
 * throwing out of the write. */
static void sp_signer_stream_write(void *h, ScrBytes *chunk) {
  SpSigner *s = h;
  if (s->done) {
    sp_not_initialised();
    return;
  }
  SCR_BYTES_SNAPSHOT(chunk);
  mbedtls_md_update(&s->md, chunk->data, (size_t)scr_bytes_byte_len(chunk));
}

static const ScrDynHandleWritable sp_writable_ops = {
  sp_signer_stream_get, sp_signer_stream_set, sp_signer_stream_write, sp_signer_trace,
};

static const ScrDynHandleOps sp_sign_ops;
static const ScrDynHandleOps sp_verify_ops;

static const ScrDynHandleOps *sp_signer_ops_of(const SpSigner *s) {
  return s->verifier ? &sp_verify_ops : &sp_sign_ops;
}

/* Writable stream members a Sign or Verify inherits. */
static bool sp_stream_member(const char *name) {
  static const char *const members[] = {
    "write", "end", "cork", "uncork", "setDefaultEncoding", "destroy",
    "on", "once", "off", "addListener", "removeListener", "removeAllListeners",
    "emit", "prependListener", "prependOnceListener", "listeners", "listenerCount",
    "eventNames", "setMaxListeners", "getMaxListeners", "rawListeners",
  };
  for (size_t i = 0; i < sizeof members / sizeof *members; i++)
    if (strcmp(name, members[i]) == 0) return true;
  return false;
}

static void sp_stream_fence(void) {
  static const char message[] =
    "This Sign or Verify stream member has no lowering when called through an untyped value";
  static const char streamless[] =
    "Sign and Verify stream members called through an untyped value have no lowering in a program "
    "that uses no streams";
  if (scr_handle_stream_hooks) scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  else scr_throw_error_msg_code(SCR_ERR_ERROR, streamless, sizeof streamless - 1, "SC2020");
}

static ScrDyn *sp_signer_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what, bool verifier) {
  SpSigner *s = h;
  if (strcmp(method, "update") == 0) return sp_signer_update(s, args, argc) ? scr_dyn_retain(self) : NULL;
  if (!verifier && strcmp(method, "sign") == 0) {
    if (s->done) {
      sp_not_initialised();
      return NULL;
    }
    /* Sign.sign: the key's truthiness, its shape as privateKey, its
     * options, then its material. */
    const ScrDyn *key_arg = argc ? args[0] : scr_dyn_undefined();
    ScrDyn *plain = sp_plain(key_arg);
    if (!plain) return NULL;
    static const SpSigContext ctx = {true, SP_KEY_SIGN, "privateKey"};
    SpSigKey k;
    sp_sig_init(&k);
    bool ok = false;
    if (!scr_dyn_truthy(plain)) {
      sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_SIGN_KEY_REQUIRED", "No key provided to sign");
    } else if (sp_key_shape_ok(plain, SP_KEY_SIGN, "privateKey") && sp_sig_options(plain, &k, true) &&
               sp_sig_decode(plain, &ctx, &k)) {
      ok = true;
    }
    scr_dyn_release(plain);
    if (!ok) {
      if (k.key) sp_key_release(k.key);
      return NULL;
    }
    if (sp_reject_x25519(&k)) return NULL;
    if (sp_is_ed(k.key)) {
      sp_key_release(k.key);
      sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
      return NULL;
    }
    unsigned char hash[MBEDTLS_MD_MAX_SIZE];
    mbedtls_md_finish(&s->md, hash);
    s->done = true;
    ScrDyn *sig = sp_sign_hash(&k, s->type, hash, mbedtls_md_get_size(mbedtls_md_info_from_type(s->type)));
    sp_key_release(k.key);
    if (!sig) return NULL;
    /* encode(buffer, encoding): a truthy encoding other than 'buffer'
     * renders the signature as a string. */
    ScrBytes *bytes = scr_bytes_buffer_source(sig);
    scr_dyn_release(sig);
    return sp_encode(bytes, argc > 1 ? args[1] : scr_dyn_undefined());
  }
  if (verifier && strcmp(method, "verify") == 0) {
    if (s->done) {
      sp_not_initialised();
      return NULL;
    }
    /* Verify.verify: the key's shape, its options, the signature's bytes,
     * then the key's material. */
    const ScrDyn *key_arg = argc ? args[0] : scr_dyn_undefined();
    ScrDyn *plain = sp_plain(key_arg);
    if (!plain) return NULL;
    static const SpSigContext ctx = {false, SP_KEY_VERIFY, "key"};
    SpSigKey k;
    sp_sig_init(&k);
    bool ok = sp_key_shape_ok(plain, SP_KEY_VERIFY, "key") && sp_sig_options(plain, &k, false);
    ScrBytes *sig = NULL;
    if (ok) {
      const ScrDyn *signature = argc > 1 ? args[1] : scr_dyn_undefined();
      if (signature->kind == SCR_DYN_STR) {
        sig = sp_string_bytes(signature->v.str, argc > 2 ? args[2] : scr_dyn_undefined());
      } else if (signature->kind == SCR_DYN_BYTES || scr_buffer_storage_is(signature)) {
        sig = scr_bytes_buffer_source(signature);
      } else {
        scr_dyn_arg_type_fail("signature", sp_data_types, signature);
      }
      /* A rejected signature leaves its error pending. */
      if (!sig) ok = false;
    }
    if (ok && sig) ok = sp_sig_decode(plain, &ctx, &k);
    scr_dyn_release(plain);
    if (!ok) {
      if (sig) scr_bytes_release(sig);
      if (k.key) sp_key_release(k.key);
      return NULL;
    }
    if (sp_reject_x25519(&k)) {
      scr_bytes_release(sig);
      return NULL;
    }
    if (sp_is_ed(k.key)) {
      sp_key_release(k.key);
      scr_bytes_release(sig);
      sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
      return NULL;
    }
    unsigned char hash[MBEDTLS_MD_MAX_SIZE];
    mbedtls_md_finish(&s->md, hash);
    s->done = true;
    bool valid = sp_verify_hash(&k, s->type, hash, mbedtls_md_get_size(mbedtls_md_info_from_type(s->type)),
                                sig->data, (size_t)scr_bytes_byte_len(sig));
    scr_bytes_release(sig);
    sp_key_release(k.key);
    return scr_exc_pending() ? NULL : scr_dyn_new_bool(valid);
  }
  if (sp_stream_member(method)) {
    /* The members a native stream answers run on the signer's Writable;
     * the others have no lowering. */
    ScrDyn *result = NULL;
    if (scr_handle_stream_hooks &&
        scr_handle_stream_hooks->call(sp_signer_ops_of(s), s, self, method, args, argc, &result))
      return result;
    sp_stream_fence();
    return NULL;
  }
  scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "%s is not a function", what);
  return NULL;
}

static ScrDyn *sp_sign_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                              const char *what) {
  return sp_signer_invoke(h, self, method, args, argc, what, false);
}

static ScrDyn *sp_verify_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                const char *what) {
  return sp_signer_invoke(h, self, method, args, argc, what, true);
}

/* Sign and Verify model the stream properties of their Writable. */
static ScrDyn *sp_signer_get(void *h, const char *name, size_t len) {
  if (scr_handle_stream_hooks) {
    ScrDyn *value = scr_handle_stream_hooks->get(sp_signer_ops_of(h), h, name, len);
    if (value || scr_exc_pending()) return value;
  }
  (void)name;
  (void)len;
  return NULL;
}

static bool sp_signer_set(void *h, const char *name, size_t len, const ScrDyn *value) {
  (void)h;
  (void)name;
  (void)len;
  (void)value;
  return false;
}

static ScrDyn *sp_signer_inspect_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

static const ScrDynHandleOps sp_sign_ops = {
    .cls = "Sign",
    .retain = sp_signer_retain,
    .release = sp_signer_release,
    .invoke = sp_sign_invoke,
    .get = sp_signer_get,
    .set = sp_signer_set,
    .inspect_view = sp_signer_inspect_view,
    .writable = &sp_writable_ops,
};

static const ScrDynHandleOps sp_verify_ops = {
    .cls = "Verify",
    .retain = sp_signer_retain,
    .release = sp_signer_release,
    .invoke = sp_verify_invoke,
    .get = sp_signer_get,
    .set = sp_signer_set,
    .inspect_view = sp_signer_inspect_view,
    .writable = &sp_writable_ops,
};

/* createSign(algorithm[, options]) / createVerify(algorithm[, options]):
 * the options an untyped call passes are ignored, as Node ignores them
 * outside SHAKE digests. */
static ScrDyn *sp_signer_new(ScrDyn *algorithm, bool verifier) {
  if (algorithm->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("algorithm", "of type string", algorithm);
    return NULL;
  }
  mbedtls_md_type_t md;
  if (!sp_digest_of(algorithm->v.str, &md)) {
    sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_DIGEST", "Invalid digest");
    return NULL;
  }
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_SIGN, &sp_sign_ops);
    scr_dyn_handle_install(SCR_DYNH_VERIFY, &sp_verify_ops);
  }
  static ScrCycType cyc_type = {&sp_signer_trace, &sp_signer_gcfree, SCR_CYC_KIND_NONE, 0};
  SpSigner *s = scr_cyc_alloc(sizeof *s, &cyc_type);
  s->rc = 1;
  scr_obj_alloc_note();
  s->type = md;
  s->verifier = verifier;
  mbedtls_md_init(&s->md);
  mbedtls_md_setup(&s->md, mbedtls_md_info_from_type(md), 0);
  mbedtls_md_starts(&s->md);
  ScrDyn *box = scr_dyn_new_handle(s, verifier ? SCR_DYNH_VERIFY : SCR_DYNH_SIGN);
  sp_signer_release(s);
  return box;
}

ScrDyn *scr_crypto_create_sign(ScrDyn *algorithm, ScrDyn *options) {
  (void)options;
  return sp_signer_new(algorithm, false);
}

ScrDyn *scr_crypto_create_verify(ScrDyn *algorithm, ScrDyn *options) {
  (void)options;
  return sp_signer_new(algorithm, true);
}

/* ── generateKeyPair ──────────────────────────────────────────────────── */

static ScrDyn *sp_cap(ScrClosure *c, size_t i) { return scr_box_get_ref(c->caps[i]); }

static void sp_key_pair_deliver(ScrClosure *self) {
  ScrDyn *callback = sp_cap(self, 0);
  ScrDyn *pair = sp_cap(self, 1);
  ScrDyn *args[3] = {scr_dyn_new_null(), scr_dyn_retain(scr_dyn_obj_get(pair, "publicKey", 9)),
                     scr_dyn_retain(scr_dyn_obj_get(pair, "privateKey", 10))};
  ScrDyn *result = scr_dyn_call(callback, args, 3, "callback");
  if (result) scr_dyn_release(result);
  for (size_t i = 0; i < 3; i++) scr_dyn_release(args[i]);
  scr_dyn_release(pair);
  scr_dyn_release(callback);
}

/* Calls the callback with the error alone, as Node does for a key
 * generation that fails. */
static void sp_key_pair_fail(ScrClosure *self) {
  ScrDyn *callback = sp_cap(self, 0);
  ScrDyn *error = sp_cap(self, 1);
  ScrDyn *result = scr_dyn_call(callback, &error, 1, "callback");
  if (result) scr_dyn_release(result);
  scr_dyn_release(error);
  scr_dyn_release(callback);
}

/* generateKeyPair(type, options, callback): a function in the options
 * position is the callback. Argument errors throw; the callback receives
 * (null, publicKey, privateKey), or the error of a key generation that
 * fails, in a later macrotask. */
void scr_crypto_generate_key_pair_async(ScrDyn *type, ScrDyn *options, ScrDyn *callback) {
  if (scr_dyn_is_callable(options)) {
    callback = options;
    options = scr_dyn_undefined();
  }
  if (!scr_dyn_is_callable(callback)) {
    scr_dyn_arg_type_fail("callback", "of type function", callback);
    return;
  }
  ScrDyn *plain = sp_plain(options);
  if (!plain) return;
  bool job_error;
  ScrDyn *pair = sp_key_pair(type, plain, &job_error);
  scr_dyn_release(plain);
  if (!pair && !job_error) return;
  void *deliver = (void *)sp_key_pair_deliver;
  if (!pair) {
    ScrCaught *caught = scr_exc_take();
    pair = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    deliver = (void *)sp_key_pair_fail;
  }
  ScrClosure *c = scr_closure_new(deliver, 2);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_dyn_retain(callback));
  c->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[1], pair);
  scr_loop_defer(c);
}

/* ── diffieHellman ────────────────────────────────────────────────────── */

/* The keys an options.privateKey or options.publicKey value can be. */
static const char sp_dh_private_types[] =
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, CryptoKey, or URL";
static const char sp_dh_public_types[] =
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey";

/* Node's message names: a KeyObject's asymmetricKeyType. */
static const char *sp_type_name(const SpKey *k) {
  return sp_is_ed(k)   ? "ed25519"
         : sp_is_x(k)   ? "x25519"
         : k->rsa_pss   ? "rsa-pss"
         : sp_is_rsa(k) ? "rsa"
                        : "ec";
}

/* A key input of diffieHellman's options: a primitive other than a string
 * throws Node's ERR_INVALID_ARG_TYPE for `name`; other values read as
 * sign and verify read their keys. */
static bool sp_dh_key(const ScrDyn *value, const char *name, bool private_key, SpSigKey *out) {
  out->key = NULL;
  /* Node's key preparation destructures the value before it checks it. */
  if (value->kind == SCR_DYN_NULL) {
    scr_pki_throw_fmt(SCR_ERR_TYPE, NULL, "Cannot destructure property 'key' of 'key' as it is null.");
    return false;
  }
  bool keyish = value->kind == SCR_DYN_STR || value->kind == SCR_DYN_BYTES || scr_buffer_storage_is(value) ||
                (value->kind != SCR_DYN_NULL && value->kind != SCR_DYN_FUNC && scr_dyn_is_object(value));
  if (!keyish) {
    scr_dyn_prop_type_fail(name, private_key ? sp_dh_private_types : sp_dh_public_types, value);
    return false;
  }
  /* DH's private slot needs a private key; its public slot takes either,
   * as verify does. */
  SpSigContext ctx = {private_key, private_key ? SP_KEY_SIGN : SP_KEY_VERIFY, "key"};
  return sp_sig_key(value, &ctx, out);
}

/* The shared secret of two keys of one type: X25519, or ECDH's x
 * coordinate at the field's size. NULL with OpenSSL's error pending. */
static void sp_dh_failed(bool props) {
  sp_throw_openssl("1C8000A4", "Provider routines", "failed during derivation", "ERR_OSSL_FAILED_DURING_DERIVATION",
                   props);
}

static ScrDyn *sp_dh_compute(SpKey *priv, SpKey *pub, bool props) {
  if (sp_is_x(priv) && sp_is_x(pub)) {
    uint8_t out[32];
    if (!sp_x25519(priv->ed_seed, pub->ed_pub, out)) {
      sp_dh_failed(props);
      return NULL;
    }
    ScrDyn *secret = sp_dyn_buffer(out, 32);
    mbedtls_platform_zeroize(out, sizeof out);
    return secret;
  }
  if (!sp_is_ec(priv) || !sp_is_ec(pub)) {
    sp_throw_openssl("03000096", "digital envelope routines", "operation not supported for this keytype",
                     "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", props);
    return NULL;
  }
  mbedtls_ecp_keypair *a = mbedtls_pk_ec(priv->pk);
  const mbedtls_ecp_keypair *b = mbedtls_pk_ec(pub->pk);
  if (a->MBEDTLS_PRIVATE(grp).id != b->MBEDTLS_PRIVATE(grp).id) {
    sp_throw_openssl("1C8000CB", "Provider routines", "mismatching domain parameters",
                     "ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS", props);
    return NULL;
  }
  mbedtls_mpi z;
  mbedtls_mpi_init(&z);
  unsigned char out[66];
  size_t n = (a->MBEDTLS_PRIVATE(grp).pbits + 7) / 8;
  bool ok = mbedtls_ecdh_compute_shared(&a->MBEDTLS_PRIVATE(grp), &z, &b->MBEDTLS_PRIVATE(Q),
                                        &a->MBEDTLS_PRIVATE(d), sp_random, NULL) == 0 &&
            mbedtls_mpi_write_binary(&z, out, n) == 0;
  mbedtls_mpi_free(&z);
  ScrDyn *secret = ok ? sp_dyn_buffer(out, n) : NULL;
  mbedtls_platform_zeroize(out, sizeof out);
  if (!secret) sp_dh_failed(props);
  return secret;
}

static void sp_dh_deliver(ScrClosure *self) {
  ScrDyn *callback = sp_cap(self, 0);
  ScrDyn *secret = sp_cap(self, 1);
  ScrDyn *args[2] = {scr_dyn_new_null(), secret};
  ScrDyn *result = scr_dyn_call(callback, args, 2, "callback");
  if (result) scr_dyn_release(result);
  scr_dyn_release(args[0]);
  scr_dyn_release(secret);
  scr_dyn_release(callback);
}

/* crypto.diffieHellman(options[, callback]) in Node's order: the options
 * object, the callback, both keys present, the key types when both are
 * KeyObjects, then the public and private key inputs. With a callback,
 * the secret, or the error of computing it, arrives in a later macrotask. */
ScrDyn *scr_crypto_diffie_hellman(ScrDyn *options, ScrDyn *callback) {
  ScrDyn *plain = sp_plain(options);
  if (!plain) return NULL;
  ScrDyn *result = NULL;
  SpSigKey pub = {0}, priv = {0};
  if (!sp_check_object(plain, "options")) goto done;
  bool async = !sp_absent(callback);
  if (async && !scr_dyn_is_callable(callback)) {
    scr_dyn_arg_type_fail("callback", "of type function", callback);
    goto done;
  }
  const ScrDyn *private_value = sp_opt(plain, "privateKey");
  const ScrDyn *public_value = sp_opt(plain, "publicKey");
  if (sp_absent(private_value)) {
    sp_property_invalid("options.privateKey", private_value);
    goto done;
  }
  if (sp_absent(public_value)) {
    sp_property_invalid("options.publicKey", public_value);
    goto done;
  }
  SpKey *a = sp_key_of(private_value), *b = sp_key_of(public_value);
  if (a && b && a->private_key) {
    const char *ta = sp_type_name(a), *tb = sp_type_name(b);
    if (strcmp(ta, tb) != 0 || (!sp_is_ec(a) && !sp_is_x(a))) {
      scr_pki_throw_fmt(SCR_ERR_ERROR, "ERR_CRYPTO_INCOMPATIBLE_KEY",
                        "Incompatible key types for Diffie-Hellman: %s and %s", ta, tb);
      goto done;
    }
  }
  if (!sp_dh_key(public_value, "options.publicKey", false, &pub) ||
      !sp_dh_key(private_value, "options.privateKey", true, &priv))
    goto done;
  ScrDyn *secret = sp_dh_compute(priv.key, pub.key, !async);
  if (!async) {
    result = secret;
    goto done;
  }
  void *deliver = (void *)sp_dh_deliver;
  if (!secret) {
    ScrCaught *caught = scr_exc_take();
    secret = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    deliver = (void *)sp_key_pair_fail;
  }
  ScrClosure *c = scr_closure_new(deliver, 2);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_dyn_retain(callback));
  c->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[1], secret);
  scr_loop_defer(c);
  result = scr_dyn_retain(scr_dyn_undefined());
done:
  if (pub.key) sp_key_release(pub.key);
  if (priv.key) sp_key_release(priv.key);
  scr_dyn_release(plain);
  return result;
}

/* ── the core for the WebCrypto layer (scr_pki.h) ─────────────────────── */

ScrPkiKey *scr_pki_key_retain(ScrPkiKey *key) { return sp_key_retain(key); }

void scr_pki_key_release(ScrPkiKey *key) { sp_key_release(key); }

bool scr_pki_key_is_private(const ScrPkiKey *key) { return key->private_key; }

bool scr_pki_key_is_rsa(const ScrPkiKey *key) { return sp_is_rsa(key); }

bool scr_pki_key_is_ed25519(const ScrPkiKey *key) { return sp_is_ed(key); }

const char *scr_pki_key_curve(const ScrPkiKey *key) {
  const SpCurve *curve = sp_curve_of(key);
  return curve ? curve->jwk : NULL;
}

size_t scr_pki_key_bits(const ScrPkiKey *key) { return mbedtls_pk_get_bitlen(&key->pk); }

ScrBytes *scr_pki_key_exponent(const ScrPkiKey *key) {
  mbedtls_mpi e;
  mbedtls_mpi_init(&e);
  mbedtls_rsa_export(mbedtls_pk_rsa(key->pk), NULL, NULL, NULL, NULL, &e);
  size_t n = mbedtls_mpi_size(&e);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)n);
  if (n) mbedtls_mpi_write_binary(&e, out->data, n);
  mbedtls_mpi_free(&e);
  return out;
}

ScrPkiKey *scr_pki_key_parse_der(const uint8_t *der, size_t len, bool private_key) {
  if ((private_key && len == 48 && memcmp(der, sp_ed_pkcs8_prefix, 16) == 0) ||
      (!private_key && len == 44 && memcmp(der, sp_ed_spki_prefix, 12) == 0))
  {
    bool failed;
    return sp_ed_from_der(der, len, private_key, &failed);
  }
  SpKey *k = sp_key_alloc(private_key);
  int r = private_key ? mbedtls_pk_parse_key(&k->pk, der, len, NULL, 0, sp_random, NULL)
                      : mbedtls_pk_parse_public_key(&k->pk, der, len);
  if (r != 0 || !sp_key_supported(k)) {
    sp_key_release(k);
    return NULL;
  }
  return k;
}

ScrPkiKey *scr_pki_key_from_jwk(const ScrDyn *jwk, bool private_key) {
  SpKey *k = sp_key_from_jwk(jwk, private_key);
  if (!k) scr_exc_clear();
  return k;
}

ScrPkiKey *scr_pki_key_from_point(const char *curve_name, const uint8_t *point, size_t len) {
  const SpCurve *curve = NULL;
  for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
    if (strcmp(sp_curves[i].jwk, curve_name) == 0) curve = &sp_curves[i];
  if (!curve) return NULL;
  SpKey *k = sp_key_alloc(false);
  bool ok = false;
  if (mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) == 0) {
    mbedtls_ecp_keypair *ec = mbedtls_pk_ec(k->pk);
    ok = mbedtls_ecp_group_load(&ec->MBEDTLS_PRIVATE(grp), curve->id) == 0 &&
         mbedtls_ecp_point_read_binary(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q), point, len) == 0 &&
         mbedtls_ecp_check_pubkey(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q)) == 0;
  }
  if (!ok) {
    sp_key_release(k);
    return NULL;
  }
  return k;
}

ScrPkiKey *scr_pki_key_public_of(ScrPkiKey *key) { return sp_public_of(key); }

ScrPkiKey *scr_pki_generate_rsa(unsigned bits, uint64_t exponent) {
  SpKey *k = sp_key_alloc(true);
  if (bits < 512 || bits > MBEDTLS_MPI_MAX_BITS || exponent < 3 || exponent % 2 == 0 ||
      exponent > 4294967295u || mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_RSA)) != 0 ||
      sp_rsa_generate(mbedtls_pk_rsa(k->pk), bits, exponent) != 0) {
    sp_key_release(k);
    return NULL;
  }
  return k;
}

ScrPkiKey *scr_pki_generate_ec(const char *curve_name) {
  const SpCurve *curve = NULL;
  for (size_t i = 0; i < sizeof sp_curves / sizeof sp_curves[0]; i++)
    if (strcmp(sp_curves[i].jwk, curve_name) == 0) curve = &sp_curves[i];
  SpKey *k = sp_key_alloc(true);
  if (!curve || mbedtls_pk_setup(&k->pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) != 0 ||
      mbedtls_ecp_gen_key(curve->id, mbedtls_pk_ec(k->pk), sp_random, NULL) != 0) {
    sp_key_release(k);
    return NULL;
  }
  return k;
}

ScrPkiKey *scr_pki_generate_ed25519(void) {
  const ScrPkiEd25519 *ed = sp_ed();
  if (!ed) return NULL;
  SpKey *k = sp_key_alloc(true);
  k->ed25519 = true;
  sp_random(NULL, k->ed_seed, 32);
  ed->public_key(k->ed_pub, k->ed_seed);
  return k;
}

ScrPkiKey *scr_pki_key_from_ed25519_raw(const uint8_t *raw, size_t len) {
  if (len != 32) return NULL;
  SpKey *k = sp_key_alloc(false);
  k->ed25519 = true;
  memcpy(k->ed_pub, raw, 32);
  return k;
}

ScrBytes *scr_pki_export_ed25519_raw(ScrPkiKey *key) {
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, 32);
  memcpy(out->data, key->ed_pub, 32);
  return out;
}

ScrBytes *scr_pki_export_der(ScrPkiKey *key) {
  unsigned char *der = malloc(SP_DER_MAX);
  if (!der) scr_trap("scriptc: out of memory\n");
  int n = key->private_key ? sp_write_pkcs8_der(key, der, SP_DER_MAX) : sp_write_spki_der(key, der, SP_DER_MAX);
  ScrBytes *out = NULL;
  if (n > 0) {
    out = scr_bytes_new(SCR_BYTES_U8, (double)n);
    memcpy(out->data, der + SP_DER_MAX - n, (size_t)n);
  }
  mbedtls_platform_zeroize(der, SP_DER_MAX);
  free(der);
  return out;
}

ScrBytes *scr_pki_export_point(ScrPkiKey *key) {
  const mbedtls_ecp_keypair *ec = mbedtls_pk_ec(key->pk);
  unsigned char point[160];
  size_t n;
  if (mbedtls_ecp_point_write_binary(&ec->MBEDTLS_PRIVATE(grp), &ec->MBEDTLS_PRIVATE(Q),
                                     MBEDTLS_ECP_PF_UNCOMPRESSED, &n, point, sizeof point) != 0)
    return NULL;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)n);
  memcpy(out->data, point, n);
  return out;
}

ScrDyn *scr_pki_export_jwk(ScrPkiKey *key) { return sp_export_jwk(key); }

static bool sp_webcrypto_md(const char *hash, mbedtls_md_type_t *md) {
  if (strcmp(hash, "SHA-1") == 0) *md = MBEDTLS_MD_SHA1;
  else if (strcmp(hash, "SHA-256") == 0) *md = MBEDTLS_MD_SHA256;
  else if (strcmp(hash, "SHA-384") == 0) *md = MBEDTLS_MD_SHA384;
  else if (strcmp(hash, "SHA-512") == 0) *md = MBEDTLS_MD_SHA512;
  else return false;
  return true;
}

ScrBytes *scr_pki_sign(ScrPkiKey *key, const char *hash, bool pss, int salt, const uint8_t *data,
                       size_t len) {
  if (sp_is_ed(key)) {
    const ScrPkiEd25519 *ed = sp_ed();
    if (!ed) return NULL;
    ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, 64);
    ed->sign(out->data, key->ed_seed, key->ed_pub, data, len);
    return out;
  }
  mbedtls_md_type_t md;
  if (!sp_webcrypto_md(hash, &md)) return NULL;
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
  unsigned char digest[MBEDTLS_MD_MAX_SIZE];
  mbedtls_md(info, data, len, digest);
  /* WebCrypto's RSA-PSS names its padding and salt length. */
  SpSigKey k = {.key = key, .padding = pss ? 6 : 1, .padding_given = pss, .salt = salt, .salt_given = pss,
                .p1363 = true};
  ScrDyn *sig = sp_sign_hash(&k, md, digest, mbedtls_md_get_size(info));
  if (!sig) {
    scr_exc_clear();
    return NULL;
  }
  ScrBytes *out = scr_bytes_buffer_source(sig);
  scr_dyn_release(sig);
  return out;
}

bool scr_pki_verify(ScrPkiKey *key, const char *hash, bool pss, int salt, const uint8_t *data,
                    size_t len, const uint8_t *signature, size_t signature_len) {
  if (sp_is_ed(key)) {
    const ScrPkiEd25519 *ed = sp_ed();
    return ed && sp_ed_verify(ed, key->ed_pub, data, len, signature, signature_len);
  }
  mbedtls_md_type_t md;
  if (!sp_webcrypto_md(hash, &md)) return false;
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
  unsigned char digest[MBEDTLS_MD_MAX_SIZE];
  mbedtls_md(info, data, len, digest);
  SpSigKey k = {.key = key, .padding = pss ? 6 : 1, .padding_given = pss, .salt = salt, .salt_given = pss,
                .p1363 = true};
  return sp_verify_hash(&k, md, digest, mbedtls_md_get_size(info), signature, signature_len);
}

/* ── X509Certificate members over keys ───────────────────────────────── */

/* The certificate's public key, +1; NULL with the error pending. */
static SpKey *sp_x509_key(ScrBytes *der) {
  ScrBytes *view = der;
  SCR_BYTES_SNAPSHOT(view);
  const unsigned char *spki;
  size_t spki_len;
  if (!sp_cert_spki(view->data, (size_t)scr_bytes_byte_len(view), &spki, &spki_len)) {
    sp_unsupported_input();
    return NULL;
  }
  return sp_parse(spki, spki_len, false);
}

/* x509.publicKey: the certificate's public key as a new KeyObject. */
ScrDyn *scr_crypto_x509_public_key(ScrBytes *der) {
  SpKey *k = sp_x509_key(der);
  return k ? sp_key_box(k) : NULL;
}

/* The pkey argument of verify (a public key) and checkPrivateKey (a
 * private key), borrowed; NULL with Node's TypeError pending. */
static SpKey *sp_x509_pkey(const ScrDyn *value, bool private_key) {
  SpKey *k = sp_key_of(value);
  size_t len;
  if (!k && !scr_key_object_bytes(value, &len)) {
    scr_dyn_arg_type_fail("pkey", "an instance of KeyObject", value);
    return NULL;
  }
  if (!k || k->private_key != private_key) {
    const char *cls = !k ? "SecretKeyObject" : k->private_key ? "PrivateKeyObject" : "PublicKeyObject";
    scr_pki_throw_fmt(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", "The argument 'pkey' is invalid. Received %s [KeyObject] {}",
                      cls);
    return NULL;
  }
  return k;
}

/* The digest of a signature algorithm OID's last arc (RSA and ECDSA). */
static mbedtls_md_type_t sp_x509_rsa_md(unsigned char arc) {
  switch (arc) {
    case 5: return MBEDTLS_MD_SHA1;
    case 11: return MBEDTLS_MD_SHA256;
    case 12: return MBEDTLS_MD_SHA384;
    case 13: return MBEDTLS_MD_SHA512;
    case 14: return MBEDTLS_MD_SHA224;
    default: return MBEDTLS_MD_NONE;
  }
}

/* A hash AlgorithmIdentifier inside RSASSA-PSS-params. */
static mbedtls_md_type_t sp_x509_hash_alg(unsigned char *p, const unsigned char *end) {
  size_t n;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
    return MBEDTLS_MD_NONE;
  mbedtls_asn1_buf oid = {0};
  oid.tag = MBEDTLS_ASN1_OID;
  if (mbedtls_asn1_get_tag(&p, end, &oid.len, MBEDTLS_ASN1_OID) != 0) return MBEDTLS_MD_NONE;
  oid.p = p;
  mbedtls_md_type_t md;
  return mbedtls_oid_get_md_alg(&oid, &md) == 0 ? md : MBEDTLS_MD_NONE;
}

/* x509.verify(publicKey): whether publicKey verifies the certificate's
 * signature. An algorithm the key cannot verify answers false. */
bool scr_crypto_x509_verify(ScrBytes *der, ScrDyn *key) {
  SpKey *k = sp_x509_pkey(key, false);
  if (!k) return false;
  ScrBytes *view = der;
  SCR_BYTES_SNAPSHOT(view);
  unsigned char *p = view->data;
  const unsigned char *end = p + (size_t)scr_bytes_byte_len(view);
  size_t n;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
    return false;
  end = p + n;
  const unsigned char *tbs = p;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
    return false;
  p += n;
  size_t tbs_len = (size_t)(p - tbs);
  const unsigned char *outer_alg = p;
  if (mbedtls_asn1_get_tag(&p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
    return false;
  const unsigned char *alg_end = p + n;
  /* As in OpenSSL's X509_verify, the TBSCertificate's signature field must
   * be the same AlgorithmIdentifier as the outer one. */
  {
    unsigned char *q = (unsigned char *)tbs;
    const unsigned char *tbs_end = tbs + tbs_len;
    size_t len;
    if (mbedtls_asn1_get_tag(&q, tbs_end, &len, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
      return false;
    if (q < tbs_end && *q == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0)) {
      if (mbedtls_asn1_get_tag(&q, tbs_end, &len, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0) != 0)
        return false;
      q += len;
    }
    if (mbedtls_asn1_get_tag(&q, tbs_end, &len, MBEDTLS_ASN1_INTEGER) != 0) return false;
    q += len;
    const unsigned char *inner_alg = q;
    if (mbedtls_asn1_get_tag(&q, tbs_end, &len, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0)
      return false;
    size_t inner_len = (size_t)(q + len - inner_alg);
    if (inner_len != (size_t)(alg_end - outer_alg) || memcmp(inner_alg, outer_alg, inner_len) != 0) return false;
  }
  size_t oid_len;
  if (mbedtls_asn1_get_tag(&p, alg_end, &oid_len, MBEDTLS_ASN1_OID) != 0) return false;
  const unsigned char *oid = p;
  unsigned char *params = p + oid_len;
  p = (unsigned char *)alg_end;
  size_t sig_len;
  if (mbedtls_asn1_get_tag(&p, end, &sig_len, MBEDTLS_ASN1_BIT_STRING) != 0 || sig_len < 1 || *p != 0)
    return false;
  const unsigned char *sig = p + 1;
  sig_len -= 1;
  static const unsigned char rsa_prefix[] = {0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01};
  static const unsigned char ecdsa_prefix[] = {0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04};
  static const unsigned char ed25519_oid[] = {0x2B, 0x65, 0x70};
  if (oid_len == sizeof ed25519_oid && memcmp(oid, ed25519_oid, oid_len) == 0) {
    if (!sp_is_ed(k)) return false;
    const ScrPkiEd25519 *ed = sp_ed();
    return ed != NULL && sp_ed_verify(ed, k->ed_pub, tbs, tbs_len, sig, sig_len);
  }
  if (sp_is_ed(k)) return false;
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  if (oid_len == sizeof rsa_prefix + 1 && memcmp(oid, rsa_prefix, sizeof rsa_prefix) == 0) {
    if (!sp_is_rsa(k)) return false;
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(k->pk);
    if (oid[sizeof rsa_prefix] == 10) { /* RSASSA-PSS with its parameters */
      mbedtls_md_type_t md = MBEDTLS_MD_SHA1, mgf = MBEDTLS_MD_SHA1;
      int salt = 20;
      unsigned char *q = params;
      size_t plen;
      if (mbedtls_asn1_get_tag(&q, alg_end, &plen, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) == 0) {
        const unsigned char *pend = q + plen;
        while (q < pend) {
          unsigned char tag = *q;
          size_t len;
          if (mbedtls_asn1_get_tag(&q, pend, &len, tag) != 0) return false;
          unsigned char *field = q;
          q += len;
          if (tag == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0)) {
            md = sp_x509_hash_alg(field, q);
          } else if (tag == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1)) {
            /* MGF1 with its hash: SEQUENCE { id-mgf1, AlgorithmIdentifier } */
            size_t mlen, ilen;
            unsigned char *m = field;
            if (mbedtls_asn1_get_tag(&m, q, &mlen, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0 ||
                mbedtls_asn1_get_tag(&m, q, &ilen, MBEDTLS_ASN1_OID) != 0)
              return false;
            mgf = sp_x509_hash_alg(m + ilen, q);
          } else if (tag == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 2)) {
            if (mbedtls_asn1_get_int(&field, q, &salt) != 0) return false;
          }
        }
      }
      if (md == MBEDTLS_MD_NONE || mgf == MBEDTLS_MD_NONE || sig_len != mbedtls_rsa_get_len(rsa))
        return false;
      const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
      mbedtls_md(info, tbs, tbs_len, hash);
      return mbedtls_rsa_rsassa_pss_verify_ext(rsa, md, mbedtls_md_get_size(info), hash, mgf, salt,
                                               sig) == 0;
    }
    mbedtls_md_type_t md = sp_x509_rsa_md(oid[sizeof rsa_prefix]);
    if (md == MBEDTLS_MD_NONE) return false;
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
    mbedtls_md(info, tbs, tbs_len, hash);
    /* PKCS#1 v1.5, whatever padding the key's last signature used */
    if (mbedtls_rsa_set_padding(rsa, MBEDTLS_RSA_PKCS_V15, MBEDTLS_MD_NONE) != 0) return false;
    return mbedtls_pk_verify(&k->pk, md, hash, mbedtls_md_get_size(info), sig, sig_len) == 0;
  }
  if (oid_len >= sizeof ecdsa_prefix + 1 && memcmp(oid, ecdsa_prefix, sizeof ecdsa_prefix) == 0) {
    if (!sp_is_ec(k)) return false;
    mbedtls_md_type_t md = MBEDTLS_MD_NONE;
    if (oid_len == 7 && oid[6] == 0x01) md = MBEDTLS_MD_SHA1;
    else if (oid_len == 8 && oid[6] == 0x03) {
      static const mbedtls_md_type_t sha2[] = {MBEDTLS_MD_NONE, MBEDTLS_MD_SHA224, MBEDTLS_MD_SHA256,
                                               MBEDTLS_MD_SHA384, MBEDTLS_MD_SHA512};
      if (oid[7] >= 1 && oid[7] <= 4) md = sha2[oid[7]];
    }
    if (md == MBEDTLS_MD_NONE) return false;
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
    mbedtls_md(info, tbs, tbs_len, hash);
    return mbedtls_pk_verify(&k->pk, md, hash, mbedtls_md_get_size(info), sig, sig_len) == 0;
  }
  return false;
}

/* x509.checkPrivateKey(privateKey): whether privateKey is the private half
 * of the certificate's public key. */
bool scr_crypto_x509_check_private_key(ScrBytes *der, ScrDyn *key) {
  SpKey *k = sp_x509_pkey(key, true);
  if (!k) return false;
  SpKey *cert = sp_x509_key(der);
  if (!cert) return false;
  bool same = false;
  if (sp_is_ed(k) || sp_is_ed(cert)) {
    same = sp_is_ed(k) && sp_is_ed(cert) && memcmp(k->ed_pub, cert->ed_pub, 32) == 0;
  } else if (mbedtls_pk_get_type(&k->pk) == mbedtls_pk_get_type(&cert->pk)) {
    SpKey *pub = sp_public_of(k);
    if (pub) {
      unsigned char *a = malloc(SP_DER_MAX), *b = malloc(SP_DER_MAX);
      if (!a || !b) scr_trap("scriptc: out of memory\n");
      int na = sp_write_spki_der(pub, a, SP_DER_MAX);
      int nb = sp_write_spki_der(cert, b, SP_DER_MAX);
      same = na > 0 && na == nb && memcmp(a + SP_DER_MAX - na, b + SP_DER_MAX - nb, (size_t)na) == 0;
      free(a);
      free(b);
      sp_key_release(pub);
    }
  }
  sp_key_release(cert);
  return same;
}
