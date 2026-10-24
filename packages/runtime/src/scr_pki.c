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

static void sp_throw(int kind, const char *code, const char *message) {
  scr_throw_error_msg_code(kind, message, strlen(message), code);
}

/* An OpenSSL error as Node's ThrowCryptoError reports it,
 * "error:<packed>:<library>::<reason>", with own library, reason and code
 * properties in Node's key order. A crypto job's callback gets the error
 * without them (`props` false), as from Node's async jobs. */
static void sp_throw_openssl(const char *packed, const char *library, const char *reason, const char *code,
                             bool props) {
  char message[160];
  snprintf(message, sizeof message, "error:%s:%s::%s", packed, library, reason);
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  if (props) {
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
  if (code) scr_throw_error_msg_code(kind, message, (size_t)n, code);
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
    sp_invalid_jwk();
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

/* RSASSA-PSS-params at *p (RFC 4055): true with the restrictions set on
 * `k`, false when they are malformed or unsupported, which leaves the key
 * without restrictions, as OpenSSL reads a negative or oversized salt. */
static bool sp_pss_params_read(unsigned char **p, const unsigned char *end, SpKey *k) {
  size_t n;
  if (mbedtls_asn1_get_tag(p, end, &n, MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE) != 0) return false;
  const unsigned char *params_end = *p + n;
  mbedtls_md_type_t md = MBEDTLS_MD_SHA1, mgf1 = MBEDTLS_MD_SHA1;
  int salt = 20;
  if (*p < params_end && **p == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0)) {
    mbedtls_asn1_buf oid, params;
    if (mbedtls_asn1_get_tag(p, params_end, &n, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 0) != 0 ||
        mbedtls_asn1_get_alg(p, *p + n, &oid, &params) != 0 || mbedtls_oid_get_md_alg(&oid, &md) != 0 ||
        !sp_pss_md_name(md))
      return false;
  }
  if (*p < params_end && **p == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1)) {
    mbedtls_asn1_buf oid, params;
    if (mbedtls_asn1_get_tag(p, params_end, &n, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 1) != 0 ||
        mbedtls_asn1_get_alg(p, *p + n, &oid, &params) != 0 || oid.len != MBEDTLS_OID_SIZE(MBEDTLS_OID_MGF1) ||
        memcmp(oid.p, MBEDTLS_OID_MGF1, oid.len) != 0)
      return false;
    /* MGF1's parameters are the hash's AlgorithmIdentifier, whose
     * content starts with the hash's OID. */
    if (params.tag != (MBEDTLS_ASN1_CONSTRUCTED | MBEDTLS_ASN1_SEQUENCE)) return false;
    unsigned char *alg = params.p;
    mbedtls_asn1_buf hash_oid = {.tag = MBEDTLS_ASN1_OID};
    if (mbedtls_asn1_get_tag(&alg, params.p + params.len, &hash_oid.len, MBEDTLS_ASN1_OID) != 0) return false;
    hash_oid.p = alg;
    if (mbedtls_oid_get_md_alg(&hash_oid, &mgf1) != 0 || !sp_pss_md_name(mgf1)) return false;
  }
  if (*p < params_end && **p == (MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 2)) {
    if (mbedtls_asn1_get_tag(p, params_end, &n, MBEDTLS_ASN1_CONTEXT_SPECIFIC | MBEDTLS_ASN1_CONSTRUCTED | 2) != 0 ||
        mbedtls_asn1_get_int(p, *p + n, &salt) != 0 || salt < 0)
      return false;
  }
  *p = (unsigned char *)params_end;
  k->pss_params = true;
  k->pss_md = md;
  k->pss_mgf1 = mgf1;
  k->pss_salt = salt;
  return true;
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
  if (p < alg_end && !sp_pss_params_read(&p, alg_end, k)) k->pss_params = false;
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
    else sp_unsupported_input();
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

static const char sp_key_input_types[] =
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, or URL";

/* createPrivateKey / createPublicKey: a PEM string or buffer, or
 * { key, format, type, encoding, passphrase }; createPublicKey also takes
 * a private KeyObject. */
static ScrDyn *sp_create_key(ScrDyn *input, bool private_key) {
  if (input->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(input);
    if (!value) return NULL;
    ScrDyn *result = sp_create_key(value, private_key);
    scr_dyn_release(value);
    return result;
  }
  SpKey *object = sp_key_of(input);
  if (object) {
    if (private_key) {
      scr_dyn_arg_type_fail("key", sp_key_input_types, input);
      return NULL;
    }
    if (!object->private_key) {
      sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
               "Invalid key object type public, expected private.");
      return NULL;
    }
    SpKey *pub = sp_public_of(object);
    if (!pub) {
      sp_unsupported_input();
      return NULL;
    }
    return sp_key_box(pub);
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
    SpKey *inner = sp_key_of(data);
    if (inner) return sp_create_key((ScrDyn *)data, private_key);
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
    scr_dyn_arg_type_fail(data == input ? "key" : "key.key", sp_key_input_types, data);
    return NULL;
  }
  ScrBytes *pass = NULL;
  if (passphrase && !sp_absent(passphrase)) {
    pass = sp_source_bytes(passphrase, NULL);
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

ScrDyn *scr_crypto_create_private_key(ScrDyn *key) { return sp_create_key(key, true); }

ScrDyn *scr_crypto_create_public_key(ScrDyn *key) { return sp_create_key(key, false); }

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
    ScrBytes *pass = sp_source_bytes(passphrase, NULL);
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
  bool private_key = key->v.handle.tag == SCR_DYNH_PRIVATE_KEY;
  scr_throw_error_msg_code(SCR_ERR_TYPE,
                           private_key ? "Invalid key object type private, expected secret."
                                       : "Invalid key object type public, expected secret.",
                           private_key ? 49 : 48, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
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

/* The algorithm argument of crypto.sign/verify: a digest name, or
 * null/undefined for the key type's default (SHA-256). */
static bool sp_algorithm(const ScrDyn *alg, mbedtls_md_type_t *md) {
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
  int padding;  /* RSA_PKCS1_PADDING (1) or RSA_PKCS1_PSS_PADDING (6) */
  int salt;     /* -1 digest length, -2 maximum (sign) or auto (verify),
                 * -4 the digest length or the maximum, if smaller */
  bool p1363;   /* dsaEncoding: "ieee-p1363" */
  bool padding_given, salt_given;
  mbedtls_md_type_t mgf1; /* PSS's MGF1 digest; NONE for the message's */
} SpSigKey;

/* The key argument of a signing operation: a KeyObject, key material, or
 * { key, dsaEncoding, padding, saltLength, ...createKey options }. */
static bool sp_sig_key_plain(const ScrDyn *value, bool sign, SpSigKey *out);

static bool sp_sig_key(const ScrDyn *value, bool sign, SpSigKey *out) {
  out->key = NULL;
  ScrDyn *plain = sp_plain(value);
  if (!plain) return false;
  bool ok = sp_sig_key_plain(plain, sign, out);
  scr_dyn_release(plain);
  return ok;
}

static bool sp_sig_key_plain(const ScrDyn *value, bool sign, SpSigKey *out) {
  out->key = NULL;
  out->padding = 1;
  out->salt = sign ? -2 : -2;
  out->p1363 = false;
  out->padding_given = false;
  out->salt_given = false;
  out->mgf1 = MBEDTLS_MD_NONE;
  const ScrDyn *options = NULL;
  if (sp_is_object(value) && !sp_key_of(value) && !scr_buffer_storage_is(value)) {
    options = value;
    const ScrDyn *dsa = sp_opt(value, "dsaEncoding");
    if (sp_is_str(dsa, "ieee-p1363")) out->p1363 = true;
    else if (!sp_absent(dsa) && !sp_is_str(dsa, "der")) {
      sp_property_invalid("options.dsaEncoding", dsa);
      return false;
    }
    const ScrDyn *padding = sp_opt(value, "padding");
    if (!sp_absent(padding)) {
      if (padding->kind != SCR_DYN_NUM || (padding->v.num != 1 && padding->v.num != 6)) {
        sp_not_supported("signatures with this padding");
        return false;
      }
      out->padding = (int)padding->v.num;
      out->padding_given = true;
    }
    const ScrDyn *salt = sp_opt(value, "saltLength");
    if (!sp_absent(salt)) {
      if (salt->kind != SCR_DYN_NUM || salt->v.num != (double)(int)salt->v.num || salt->v.num < -2) {
        sp_not_supported("signatures with this saltLength");
        return false;
      }
      out->salt = (int)salt->v.num;
      out->salt_given = true;
    }
  }
  SpKey *direct = sp_key_of(options ? sp_opt(options, "key") : value);
  if (direct) {
    if (sign && !direct->private_key) {
      sp_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
               "Invalid key object type public, expected private.");
      return false;
    }
    sp_key_retain(direct);
    out->key = direct;
    return true;
  }
  ScrDyn *created = sp_create_key((ScrDyn *)value, sign);
  if (!created) return false;
  out->key = sp_key_retain(sp_key_of(created));
  scr_dyn_release(created);
  return true;
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

/* An RSA-PSS key's restrictions on a signature over a `md` digest, as
 * OpenSSL's provider applies them: PSS padding only (the default), and
 * for a key with RSASSA-PSS-params its digest, its MGF1 digest and salts
 * of at least its own (the default). Without parameters a signature
 * salts with the digest's length, or the most the key holds when that is
 * less (RSA_PSS_SALTLEN_AUTO_DIGEST_MAX). False with OpenSSL's error
 * pending. */
static bool sp_pss_key_rules(SpSigKey *key, mbedtls_md_type_t md, size_t hash_len, bool sign) {
  const SpKey *k = key->key;
  if (!k->rsa_pss) return true;
  if (key->padding_given && key->padding != 6) {
    sp_throw_openssl("1C8000A5", "Provider routines", "illegal or unsupported padding mode",
                     "ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE", true);
    return false;
  }
  key->padding = 6;
  if (!k->pss_params) {
    if (!key->salt_given) key->salt = sign ? -4 : -2;
    return true;
  }
  if (md != k->pss_md) {
    sp_throw_openssl("1C8000AE", "Provider routines", "digest not allowed", "ERR_OSSL_DIGEST_NOT_ALLOWED", true);
    return false;
  }
  key->mgf1 = k->pss_mgf1;
  if (!key->salt_given) {
    key->salt = k->pss_salt;
  } else if (key->salt != -2 && (key->salt == -1 ? (int)hash_len : key->salt) < k->pss_salt) {
    sp_throw_openssl("1C8000AC", "Provider routines", "pss saltlen too small", "ERR_OSSL_PSS_SALTLEN_TOO_SMALL", true);
    return false;
  }
  return true;
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
  if (!sp_pss_key_rules(key, md, hash_len, true)) return NULL;
  if (!sp_rsa_padding(key, md)) {
    sp_unsupported_input();
    return NULL;
  }
  if (sp_is_rsa(key->key) && key->padding == 6) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
    int salt = key->salt;
    size_t bytes = mbedtls_rsa_get_len(rsa);
    size_t bits = mbedtls_pk_get_bitlen(&key->key->pk);
    size_t max = bytes - hash_len - 2 - ((bits - 1) % 8 == 0 ? 1 : 0);
    if (salt == -1) salt = (int)hash_len;
    else if (salt == -2) salt = (int)max;
    else if (salt == -4) salt = (int)(hash_len < max ? hash_len : max);
    if (salt < 0 || (size_t)salt > max) {
      sp_throw(SCR_ERR_ERROR, "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE",
               "error:1C8000A5:Provider routines::data too large for key size");
      return NULL;
    }
    r = key->mgf1 != MBEDTLS_MD_NONE && key->mgf1 != md
            ? sp_pss_sign_mgf1(rsa, md, key->mgf1, hash, hash_len, salt, sig)
            : mbedtls_rsa_rsassa_pss_sign_ext(rsa, sp_random, NULL, md, (unsigned)hash_len, hash, salt, sig);
    sig_len = bytes;
  } else {
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
  if (!sp_pss_key_rules(key, md, hash_len, false)) return false;
  if (!sp_rsa_padding(key, md)) return false;
  if (sp_is_rsa(key->key) && key->padding == 6) {
    mbedtls_rsa_context *rsa = mbedtls_pk_rsa(key->key->pk);
    if (sig_len != mbedtls_rsa_get_len(rsa)) return false;
    int salt = key->salt;
    if (salt == -1) salt = (int)hash_len;
    else if (salt == -2) salt = MBEDTLS_RSA_SALT_LEN_ANY;
    if (key->mgf1 != MBEDTLS_MD_NONE && key->mgf1 != md)
      return sp_pss_verify_mgf1(rsa, md, key->mgf1, hash, hash_len, salt == MBEDTLS_RSA_SALT_LEN_ANY ? -2 : salt,
                                sig, sig_len);
    return mbedtls_rsa_rsassa_pss_verify_ext(rsa, md, (unsigned)hash_len, hash, md, salt, sig) == 0;
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

static const char sp_data_types[] = "an instance of Buffer, TypedArray, or DataView";

/* Ed25519 signs the message itself: an algorithm other than null or
 * undefined is OpenSSL's invalid digest (false, error pending). */
static bool sp_ed_digest_given(const ScrDyn *algorithm) {
  if (algorithm->kind == SCR_DYN_UNDEF || algorithm->kind == SCR_DYN_NULL) return true;
  sp_throw(SCR_ERR_ERROR, "ERR_OSSL_INVALID_DIGEST", "error:1C80007A:Provider routines::invalid digest");
  return false;
}

/* crypto.sign(algorithm, data, key): the signature Buffer. */
ScrDyn *scr_crypto_sign_oneshot(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key) {
  mbedtls_md_type_t md;
  if (!sp_algorithm(algorithm, &md)) return NULL;
  if (data->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("data", sp_data_types, data);
    return NULL;
  }
  SpSigKey k;
  if (!sp_sig_key(key, true, &k)) return NULL;
  if (sp_reject_x25519(&k)) return NULL;
  /* A null algorithm signs with an RSA-PSS key's own digest. */
  if ((algorithm->kind == SCR_DYN_UNDEF || algorithm->kind == SCR_DYN_NULL) && k.key->pss_params)
    md = k.key->pss_md;
  ScrBytes *bytes = scr_bytes_buffer_source(data);
  if (sp_is_ed(k.key)) {
    ScrDyn *result = NULL;
    const ScrPkiEd25519 *ed = sp_ed_digest_given(algorithm) ? sp_ed() : NULL;
    if (ed) {
      uint8_t sig[64];
      ed->sign(sig, k.key->ed_seed, k.key->ed_pub, bytes->data, (size_t)scr_bytes_byte_len(bytes));
      result = sp_dyn_buffer(sig, 64);
    }
    scr_bytes_release(bytes);
    sp_key_release(k.key);
    return result;
  }
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
  mbedtls_md(info, bytes->data, (size_t)scr_bytes_byte_len(bytes), hash);
  scr_bytes_release(bytes);
  ScrDyn *result = sp_sign_hash(&k, md, hash, mbedtls_md_get_size(info));
  sp_key_release(k.key);
  return result;
}

/* crypto.verify(algorithm, data, key, signature): a boolean. */
ScrDyn *scr_crypto_verify_oneshot(ScrDyn *algorithm, ScrDyn *data, ScrDyn *key, ScrDyn *signature) {
  mbedtls_md_type_t md;
  if (!sp_algorithm(algorithm, &md)) return NULL;
  if (data->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("data", sp_data_types, data);
    return NULL;
  }
  SpSigKey k;
  if (!sp_sig_key(key, false, &k)) return NULL;
  if (signature->kind != SCR_DYN_BYTES) {
    sp_key_release(k.key);
    scr_dyn_arg_type_fail("signature", sp_data_types, signature);
    return NULL;
  }
  if (sp_reject_x25519(&k)) return NULL;
  if ((algorithm->kind == SCR_DYN_UNDEF || algorithm->kind == SCR_DYN_NULL) && k.key->pss_params)
    md = k.key->pss_md;
  ScrBytes *bytes = scr_bytes_buffer_source(data);
  ScrBytes *sig = scr_bytes_buffer_source(signature);
  if (sp_is_ed(k.key)) {
    ScrDyn *result = NULL;
    const ScrPkiEd25519 *ed = sp_ed_digest_given(algorithm) ? sp_ed() : NULL;
    if (ed)
      result = scr_dyn_new_bool(sp_ed_verify(ed, k.key->ed_pub, bytes->data,
                                             (size_t)scr_bytes_byte_len(bytes), sig->data,
                                             (size_t)scr_bytes_byte_len(sig)));
    scr_bytes_release(bytes);
    scr_bytes_release(sig);
    sp_key_release(k.key);
    return result;
  }
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md);
  mbedtls_md(info, bytes->data, (size_t)scr_bytes_byte_len(bytes), hash);
  bool ok = sp_verify_hash(&k, md, hash, mbedtls_md_get_size(info), sig->data, (size_t)scr_bytes_byte_len(sig));
  scr_bytes_release(bytes);
  scr_bytes_release(sig);
  sp_key_release(k.key);
  return scr_exc_pending() ? NULL : scr_dyn_new_bool(ok);
}

/* ── Sign and Verify objects ──────────────────────────────────────────── */

typedef struct SpSigner {
  size_t rc;
  mbedtls_md_context_t md;
  mbedtls_md_type_t type;
  bool done; /* sign()/verify() ran: Node's "Not initialised" afterwards */
} SpSigner;

static void *sp_signer_retain(void *h) {
  ((SpSigner *)h)->rc++;
  return h;
}

static void sp_signer_release(void *h) {
  SpSigner *s = h;
  if (--s->rc) return;
  mbedtls_md_free(&s->md);
  free(s);
}

static void sp_not_initialised(void) {
  sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INVALID_STATE", "Not initialised");
}

/* update(data[, inputEncoding]): strings encode with the encoding (UTF-8
 * by default). */
static bool sp_signer_update(SpSigner *s, ScrDyn *const *args, size_t argc) {
  if (s->done) {
    sp_not_initialised();
    return false;
  }
  const ScrDyn *data = argc ? args[0] : scr_dyn_undefined();
  if (data->kind != SCR_DYN_STR && data->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
    return false;
  }
  ScrBytes *bytes = sp_source_bytes(data, argc > 1 ? args[1] : NULL);
  if (!bytes) return false;
  mbedtls_md_update(&s->md, bytes->data, (size_t)scr_bytes_byte_len(bytes));
  scr_bytes_release(bytes);
  return true;
}

/* An output or signature encoding argument: a string encoding, or the
 * Buffer form for undefined, null and "buffer". */
static const ScrStr *sp_encoding_arg(const ScrDyn *v) {
  if (v == NULL || v->kind != SCR_DYN_STR || sp_is_str(v, "buffer")) return NULL;
  return v->v.str;
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
    SpSigKey k;
    if (!sp_sig_key(argc ? args[0] : scr_dyn_undefined(), true, &k)) return NULL;
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
    const ScrStr *encoding = sp_encoding_arg(argc > 1 ? args[1] : NULL);
    if (!sig || !encoding) return sig;
    ScrBytes *bytes = scr_bytes_buffer_source(sig);
    ScrStr *text = scr_bytes_to_str_checked(bytes, encoding);
    scr_bytes_release(bytes);
    scr_dyn_release(sig);
    return text ? sp_dyn_str(text) : NULL;
  }
  if (verifier && strcmp(method, "verify") == 0) {
    if (s->done) {
      sp_not_initialised();
      return NULL;
    }
    SpSigKey k;
    if (!sp_sig_key(argc ? args[0] : scr_dyn_undefined(), false, &k)) return NULL;
    if (sp_is_ed(k.key)) {
      sp_key_release(k.key);
      sp_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
      return NULL;
    }
    const ScrDyn *signature = argc > 1 ? args[1] : scr_dyn_undefined();
    if (signature->kind != SCR_DYN_STR && signature->kind != SCR_DYN_BYTES) {
      sp_key_release(k.key);
      scr_dyn_arg_type_fail("signature", "of type string or an instance of Buffer, TypedArray, or DataView",
                            signature);
      return NULL;
    }
    if (sp_reject_x25519(&k)) return NULL;
    const ScrStr *encoding = sp_encoding_arg(argc > 2 ? args[2] : NULL);
    ScrDyn *encoding_value = encoding ? scr_dyn_new_str((ScrStr *)encoding) : NULL;
    ScrBytes *sig = sp_source_bytes(signature, encoding_value);
    if (encoding_value) scr_dyn_release(encoding_value);
    if (!sig) {
      sp_key_release(k.key);
      return NULL;
    }
    unsigned char hash[MBEDTLS_MD_MAX_SIZE];
    mbedtls_md_finish(&s->md, hash);
    s->done = true;
    bool ok = sp_verify_hash(&k, s->type, hash, mbedtls_md_get_size(mbedtls_md_info_from_type(s->type)),
                             sig->data, (size_t)scr_bytes_byte_len(sig));
    scr_bytes_release(sig);
    sp_key_release(k.key);
    return scr_exc_pending() ? NULL : scr_dyn_new_bool(ok);
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

/* Sign and Verify have no modeled properties. */
static ScrDyn *sp_signer_get(void *h, const char *name, size_t len) {
  (void)h;
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
};

static const ScrDynHandleOps sp_verify_ops = {
    .cls = "Verify",
    .retain = sp_signer_retain,
    .release = sp_signer_release,
    .invoke = sp_verify_invoke,
    .get = sp_signer_get,
    .set = sp_signer_set,
    .inspect_view = sp_signer_inspect_view,
};

/* createSign(algorithm) / createVerify(algorithm). */
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
  SpSigner *s = calloc(1, sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  s->rc = 1;
  s->type = md;
  mbedtls_md_init(&s->md);
  mbedtls_md_setup(&s->md, mbedtls_md_info_from_type(md), 0);
  mbedtls_md_starts(&s->md);
  ScrDyn *box = scr_dyn_new_handle(s, verifier ? SCR_DYNH_VERIFY : SCR_DYNH_SIGN);
  sp_signer_release(s);
  return box;
}

ScrDyn *scr_crypto_create_sign(ScrDyn *algorithm) { return sp_signer_new(algorithm, false); }

ScrDyn *scr_crypto_create_verify(ScrDyn *algorithm) { return sp_signer_new(algorithm, true); }

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
  return sp_sig_key(value, private_key, out);
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
  SpSigKey k = {.key = key, .padding = pss ? 6 : 1, .salt = salt, .p1363 = true};
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
  SpSigKey k = {.key = key, .padding = pss ? 6 : 1, .salt = salt, .p1363 = true};
  return sp_verify_hash(&k, md, digest, mbedtls_md_get_size(info), signature, signature_len);
}
