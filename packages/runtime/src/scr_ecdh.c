/* node:crypto ECDH over the vendored mbedTLS elliptic-curve arithmetic:
 * crypto.createECDH(curveName) and ECDH.convertKey on the prime curves
 * mbedTLS implements (prime192v1, secp224r1, prime256v1, secp384r1,
 * secp521r1, secp192k1, secp224k1, secp256k1, brainpoolP256r1,
 * brainpoolP384r1 and brainpoolP512r1). An ECDH is a native dyn handle;
 * its generateKeys(), computeSecret(), getPublicKey(), getPrivateKey(),
 * setPrivateKey() and setPublicKey() methods follow Node 24's
 * lib/internal/crypto/diffiehellman.js argument handling and
 * src/crypto/crypto_ec.cc, and points are read and written as OpenSSL's
 * EC_POINT_oct2point and EC_POINT_point2oct do (compressed, uncompressed,
 * hybrid, and the one-byte point at infinity). Other curves Node knows
 * throw a coded SC2020 error. All arguments are borrowed. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/bignum.h"
#include "mbedtls/ecdh.h"
#include "mbedtls/ecp.h"
#include "mbedtls/platform_util.h"

#include "scr_crypto_args.h"
#include "scr_ecdh_names.h"

typedef struct {
  const char *name;
  mbedtls_ecp_group_id id;
} ScEcCurve;

/* The implemented curves by their OpenSSL short names. Lookup is
 * case-sensitive, like OBJ_sn2nid. */
static const ScEcCurve se_curves[] = {
  {"prime192v1", MBEDTLS_ECP_DP_SECP192R1},     {"secp224r1", MBEDTLS_ECP_DP_SECP224R1},
  {"prime256v1", MBEDTLS_ECP_DP_SECP256R1},     {"secp384r1", MBEDTLS_ECP_DP_SECP384R1},
  {"secp521r1", MBEDTLS_ECP_DP_SECP521R1},      {"secp192k1", MBEDTLS_ECP_DP_SECP192K1},
  {"secp224k1", MBEDTLS_ECP_DP_SECP224K1},      {"secp256k1", MBEDTLS_ECP_DP_SECP256K1},
  {"brainpoolP256r1", MBEDTLS_ECP_DP_BP256R1},  {"brainpoolP384r1", MBEDTLS_ECP_DP_BP384R1},
  {"brainpoolP512r1", MBEDTLS_ECP_DP_BP512R1},
};

/* POINT_CONVERSION_* as getFormat answers them. */
typedef enum { SE_COMPRESSED = 2, SE_UNCOMPRESSED = 4, SE_HYBRID = 6 } ScEcForm;

typedef struct ScEcdh {
  size_t rc;
  mbedtls_ecp_group grp;
  mbedtls_mpi d;        /* the private key when has_private */
  mbedtls_ecp_point q;  /* the public key when has_public; Z = 0 is the point at infinity */
  bool has_private;
  bool has_public;
  bool pair_checked; /* q = d·G was verified since the last change */
} ScEcdh;

static void *se_retain(void *h) {
  ((ScEcdh *)h)->rc++;
  return h;
}

static void se_release(void *h) {
  ScEcdh *e = h;
  if (--e->rc) return;
  mbedtls_ecp_group_free(&e->grp);
  mbedtls_mpi_free(&e->d);
  mbedtls_ecp_point_free(&e->q);
  mbedtls_platform_zeroize(e, sizeof *e);
  free(e);
}

static int se_random(void *state, unsigned char *out, size_t len) {
  (void)state;
  arc4random_buf(out, len);
  return 0;
}

/* The value the SC2020 error for an unlowered encoding or format names. */
#define SE_SUBJECT "An ECDH encoding or format"

/* ── errors ───────────────────────────────────────────────────────────── */

static void se_throw(int kind, const char *code, const char *message) {
  scr_throw_error_msg_code(kind, message, strlen(message), code);
}

static void se_operation_failed(const char *message) {
  se_throw(SCR_ERR_ERROR, "ERR_CRYPTO_OPERATION_FAILED", message);
}

/* ── names and encodings ──────────────────────────────────────────────── */

static int se_name_cmp(const void *key, const void *entry) {
  return strcmp((const char *)key, *(const char *const *)entry);
}

static bool se_listed(const char *name, const char *const *list, size_t count) {
  return bsearch(name, list, count, sizeof list[0], se_name_cmp) != NULL;
}

typedef enum { SE_NAME_CURVE, SE_NAME_UNSUPPORTED, SE_NAME_NOT_CURVE, SE_NAME_INVALID } ScEcNameKind;

/* OBJ_sn2nid and the curve lookup after it. A name with an embedded NUL
 * reads as the text before it, as Utf8Value's C string does. */
static ScEcNameKind se_curve_kind(const ScrStr *name, mbedtls_ecp_group_id *id) {
  char *text = malloc(name->len + 1);
  if (!text) scr_trap("scriptc: out of memory\n");
  memcpy(text, name->data, name->len);
  text[name->len] = '\0';
  ScEcNameKind kind = SE_NAME_INVALID;
  for (size_t i = 0; i < sizeof se_curves / sizeof se_curves[0]; i++)
    if (strcmp(text, se_curves[i].name) == 0) {
      *id = se_curves[i].id;
      kind = SE_NAME_CURVE;
    }
  if (kind == SE_NAME_INVALID) {
    if (se_listed(text, scr_ecdh_curve_names, sizeof scr_ecdh_curve_names / sizeof scr_ecdh_curve_names[0]))
      kind = SE_NAME_UNSUPPORTED;
    else if (se_listed(text, scr_ecdh_other_names, sizeof scr_ecdh_other_names / sizeof scr_ecdh_other_names[0]))
      kind = SE_NAME_NOT_CURVE;
  }
  free(text);
  return kind;
}

static void se_unsupported_curve(const ScrStr *name) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The curve '");
  scr_jb_put_str(&b, name);
  scr_jb_puts(&b, "' has no native implementation; the supported curves are prime192v1, secp224r1, "
                  "prime256v1, secp384r1, secp521r1, secp192k1, secp224k1, secp256k1, brainpoolP256r1, "
                  "brainpoolP384r1 and brainpoolP512r1");
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
}

/* The group of a curve name, after Node's checks; `not_curve` is the
 * message for a short name that is not a curve. False after throwing. */
static bool se_load_group(const ScrStr *name, mbedtls_ecp_group *grp, const char *not_curve) {
  mbedtls_ecp_group_id id = MBEDTLS_ECP_DP_NONE;
  switch (se_curve_kind(name, &id)) {
  case SE_NAME_CURVE:
    if (mbedtls_ecp_group_load(grp, id) == 0) return true;
    se_operation_failed(not_curve);
    return false;
  case SE_NAME_UNSUPPORTED:
    se_unsupported_curve(name);
    return false;
  case SE_NAME_NOT_CURVE:
    se_operation_failed(not_curve);
    return false;
  case SE_NAME_INVALID:
    break;
  }
  se_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
  return false;
}

/* getFormat: a falsy format is uncompressed; other values must be
 * 'compressed', 'hybrid' or 'uncompressed'. 0 after throwing. */
static int se_format(const ScrDyn *format) {
  if (!scr_dyn_truthy(format)) return SE_UNCOMPRESSED;
  if (format->kind == SCR_DYN_STR) {
    if (ca_str_is(format->v.str, "compressed")) return SE_COMPRESSED;
    if (ca_str_is(format->v.str, "hybrid")) return SE_HYBRID;
    if (ca_str_is(format->v.str, "uncompressed")) return SE_UNCOMPRESSED;
  }
  ca_throw_formatted(SE_SUBJECT, "ERR_CRYPTO_ECDH_INVALID_FORMAT", "Invalid ECDH format: ", format);
  return 0;
}

/* ── points ───────────────────────────────────────────────────────────── */

/* y = sqrt(w) mod p: w^((p+1)/4) when p ≡ 3 (mod 4), Tonelli-Shanks for
 * the curves whose p ≡ 1 (mod 4) (secp224r1 and secp224k1), which
 * mbedTLS's own point reader does not decompress.
 * MBEDTLS_ERR_ECP_INVALID_KEY when w has no square root. */
static int se_sqrt_mod(mbedtls_mpi *y, const mbedtls_mpi *w, const mbedtls_mpi *p) {
  int ret = 0;
  mbedtls_mpi q, z, c, t, r, b, e, tmp;
  mbedtls_mpi_init(&q); mbedtls_mpi_init(&z); mbedtls_mpi_init(&c); mbedtls_mpi_init(&t);
  mbedtls_mpi_init(&r); mbedtls_mpi_init(&b); mbedtls_mpi_init(&e); mbedtls_mpi_init(&tmp);
  if (mbedtls_mpi_cmp_int(w, 0) == 0) {
    MBEDTLS_MPI_CHK(mbedtls_mpi_lset(y, 0));
    goto cleanup;
  }
  if (mbedtls_mpi_get_bit(p, 1) == 1) {
    /* p ≡ 3 (mod 4): y = w^((p+1)/4), a root when y² = w. */
    MBEDTLS_MPI_CHK(mbedtls_mpi_add_int(&e, p, 1));
    MBEDTLS_MPI_CHK(mbedtls_mpi_shift_r(&e, 2));
    MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&r, w, &e, p, NULL));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&tmp, &r, &r));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&tmp, &tmp, p));
    if (mbedtls_mpi_cmp_mpi(&tmp, w) != 0) {
      ret = MBEDTLS_ERR_ECP_INVALID_KEY;
      goto cleanup;
    }
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(y, &r));
    goto cleanup;
  }
  /* Euler's criterion: w^((p-1)/2) = 1 for a square. */
  MBEDTLS_MPI_CHK(mbedtls_mpi_sub_int(&e, p, 1));
  MBEDTLS_MPI_CHK(mbedtls_mpi_shift_r(&e, 1));
  MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&tmp, w, &e, p, NULL));
  if (mbedtls_mpi_cmp_int(&tmp, 1) != 0) {
    ret = MBEDTLS_ERR_ECP_INVALID_KEY;
    goto cleanup;
  }
  /* p - 1 = q · 2^s with q odd. */
  MBEDTLS_MPI_CHK(mbedtls_mpi_sub_int(&q, p, 1));
  size_t s = mbedtls_mpi_lsb(&q);
  MBEDTLS_MPI_CHK(mbedtls_mpi_shift_r(&q, s));
  /* z: the first non-square. */
  MBEDTLS_MPI_CHK(mbedtls_mpi_lset(&z, 2));
  for (;;) {
    MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&tmp, &z, &e, p, NULL));
    if (mbedtls_mpi_cmp_int(&tmp, 1) != 0) break;
    MBEDTLS_MPI_CHK(mbedtls_mpi_add_int(&z, &z, 1));
  }
  MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&c, &z, &q, p, NULL));
  MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&t, w, &q, p, NULL));
  MBEDTLS_MPI_CHK(mbedtls_mpi_add_int(&tmp, &q, 1));
  MBEDTLS_MPI_CHK(mbedtls_mpi_shift_r(&tmp, 1));
  MBEDTLS_MPI_CHK(mbedtls_mpi_exp_mod(&r, w, &tmp, p, NULL));
  size_t m = s;
  while (mbedtls_mpi_cmp_int(&t, 1) != 0) {
    /* The least i with t^(2^i) = 1. */
    size_t i = 0;
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&tmp, &t));
    while (mbedtls_mpi_cmp_int(&tmp, 1) != 0) {
      MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&tmp, &tmp, &tmp));
      MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&tmp, &tmp, p));
      if (++i == m) {
        ret = MBEDTLS_ERR_ECP_INVALID_KEY;
        goto cleanup;
      }
    }
    /* b = c^(2^(m-i-1)) */
    MBEDTLS_MPI_CHK(mbedtls_mpi_copy(&b, &c));
    for (size_t k = 0; k + i + 1 < m; k++) {
      MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&b, &b, &b));
      MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&b, &b, p));
    }
    m = i;
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&r, &r, &b));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&r, &r, p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&c, &b, &b));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&c, &c, p));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&t, &t, &c));
    MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&t, &t, p));
  }
  MBEDTLS_MPI_CHK(mbedtls_mpi_copy(y, &r));
cleanup:
  mbedtls_mpi_free(&q); mbedtls_mpi_free(&z); mbedtls_mpi_free(&c); mbedtls_mpi_free(&t);
  mbedtls_mpi_free(&r); mbedtls_mpi_free(&b); mbedtls_mpi_free(&e); mbedtls_mpi_free(&tmp);
  return ret;
}

/* y from x and its parity on y² = x³ + ax + b. False when x has no point
 * with that parity. */
static bool se_derive_y(const mbedtls_ecp_group *grp, const mbedtls_mpi *x, int parity, mbedtls_mpi *y) {
  int ret = 0;
  mbedtls_mpi w;
  mbedtls_mpi_init(&w);
  /* w = (x² + a)·x + b, with a = -3 where mbedTLS leaves A unset. */
  MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&w, x, x));
  if (mbedtls_ecp_group_a_is_minus_3(grp)) MBEDTLS_MPI_CHK(mbedtls_mpi_sub_int(&w, &w, 3));
  else MBEDTLS_MPI_CHK(mbedtls_mpi_add_mpi(&w, &w, &grp->A));
  MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&w, &w, &grp->P));
  MBEDTLS_MPI_CHK(mbedtls_mpi_mul_mpi(&w, &w, x));
  MBEDTLS_MPI_CHK(mbedtls_mpi_add_mpi(&w, &w, &grp->B));
  MBEDTLS_MPI_CHK(mbedtls_mpi_mod_mpi(&w, &w, &grp->P));
  MBEDTLS_MPI_CHK(se_sqrt_mod(y, &w, &grp->P));
  if (mbedtls_mpi_cmp_int(y, 0) == 0) {
    if (parity) ret = MBEDTLS_ERR_ECP_INVALID_KEY;
  } else if ((int)mbedtls_mpi_get_bit(y, 0) != parity) {
    MBEDTLS_MPI_CHK(mbedtls_mpi_sub_mpi(y, &grp->P, y));
  }
cleanup:
  mbedtls_mpi_free(&w);
  return ret == 0;
}

/* EC_POINT_oct2point: a compressed (02/03), uncompressed (04) or hybrid
 * (06/07) point on the curve, or the point at infinity as the single byte
 * 00. Coordinates must be below p. */
static bool se_read_point(const mbedtls_ecp_group *grp, mbedtls_ecp_point *pt, const unsigned char *buf,
                          size_t len) {
  if (len == 0) return false;
  unsigned form = buf[0] & ~1u;
  int y_bit = buf[0] & 1;
  if (form != 0 && form != SE_COMPRESSED && form != SE_UNCOMPRESSED && form != SE_HYBRID) return false;
  if ((form == 0 || form == SE_UNCOMPRESSED) && y_bit) return false;
  if (form == 0) return len == 1 && mbedtls_ecp_set_zero(pt) == 0;
  size_t plen = mbedtls_mpi_size(&grp->P);
  unsigned char point[1 + 2 * MBEDTLS_ECP_MAX_BYTES];
  if (form == SE_COMPRESSED) {
    if (len != 1 + plen) return false;
    mbedtls_mpi x, y;
    mbedtls_mpi_init(&x);
    mbedtls_mpi_init(&y);
    bool ok = mbedtls_mpi_read_binary(&x, buf + 1, plen) == 0 && mbedtls_mpi_cmp_mpi(&x, &grp->P) < 0 &&
              se_derive_y(grp, &x, y_bit, &y) && mbedtls_mpi_write_binary(&y, point + 1 + plen, plen) == 0;
    mbedtls_mpi_free(&x);
    mbedtls_mpi_free(&y);
    if (!ok) return false;
    point[0] = SE_UNCOMPRESSED;
    memcpy(point + 1, buf + 1, plen);
  } else {
    if (len != 1 + 2 * plen) return false;
    /* A hybrid point's prefix repeats the parity of y. */
    if (form == SE_HYBRID && (buf[len - 1] & 1) != y_bit) return false;
    memcpy(point, buf, len);
    point[0] = SE_UNCOMPRESSED;
  }
  return mbedtls_ecp_point_read_binary(grp, pt, point, 1 + 2 * plen) == 0 && mbedtls_ecp_check_pubkey(grp, pt) == 0;
}

/* EC_POINT_point2oct in `form` (+1). The point at infinity is the single
 * byte 00. */
static ScrBytes *se_write_point(const mbedtls_ecp_group *grp, const mbedtls_ecp_point *pt, int form) {
  if (mbedtls_ecp_is_zero((mbedtls_ecp_point *)pt)) {
    ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, 1);
    out->data[0] = 0;
    return out;
  }
  size_t olen = 0;
  unsigned char buf[1 + 2 * MBEDTLS_ECP_MAX_BYTES];
  int ec_format = form == SE_COMPRESSED ? MBEDTLS_ECP_PF_COMPRESSED : MBEDTLS_ECP_PF_UNCOMPRESSED;
  if (mbedtls_ecp_point_write_binary(grp, pt, ec_format, &olen, buf, sizeof buf) != 0) return NULL;
  if (form == SE_HYBRID) buf[0] = (unsigned char)(SE_HYBRID | (buf[olen - 1] & 1));
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)olen);
  memcpy(out->data, buf, olen);
  return out;
}

/* ── construction ─────────────────────────────────────────────────────── */

static ScrDynHandleOps se_ops;

/* new ECDH(curve): validateString, then the curve lookup of ECDH::New. */
static ScrDyn *se_new(const ScrDyn *curve) {
  if (curve->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("curve", "of type string", curve);
    return NULL;
  }
  ScEcdh *e = calloc(1, sizeof *e);
  if (!e) scr_trap("scriptc: out of memory\n");
  e->rc = 1;
  mbedtls_ecp_group_init(&e->grp);
  mbedtls_mpi_init(&e->d);
  mbedtls_ecp_point_init(&e->q);
  if (!se_load_group(curve->v.str, &e->grp, "Failed to create key using named curve")) {
    se_release(e);
    return NULL;
  }
  scr_dyn_handle_install(SCR_DYNH_ECDH, &se_ops);
  ScrDyn *result = scr_dyn_new_handle(e, SCR_DYNH_ECDH); /* retains */
  se_release(e);
  return result;
}

ScrDyn *scr_crypto_ecdh_new(ScrDyn *curve) {
  ScrDyn *unboxed = ca_unbox(curve);
  if (!unboxed) return NULL;
  ScrDyn *result = se_new(unboxed);
  scr_dyn_release(unboxed);
  return result;
}

/* ECDH.convertKey(key, curve, inputEncoding, outputEncoding, format). */
static ScrDyn *se_convert_key(const ScrDyn *key, const ScrDyn *curve, const ScrDyn *in_enc, const ScrDyn *out_enc,
                              const ScrDyn *format) {
  if (curve->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("curve", "of type string", curve);
    return NULL;
  }
  ScrBytes *bytes = ca_key_bytes(SE_SUBJECT, key, in_enc);
  if (!bytes) return NULL;
  int form = se_format(format);
  if (!form) {
    scr_bytes_release(bytes);
    return NULL;
  }
  /* An empty key answers the empty string before the curve is read;
   * encode() leaves a string as it is. */
  if (bytes->len == 0) {
    scr_bytes_release(bytes);
    ScrStr *empty = scr_str_new("", 0);
    ScrDyn *result = scr_dyn_new_str(empty);
    scr_str_release(empty);
    return result;
  }
  ScrDyn *result = NULL;
  mbedtls_ecp_group grp;
  mbedtls_ecp_point pt;
  mbedtls_ecp_group_init(&grp);
  mbedtls_ecp_point_init(&pt);
  if (se_load_group(curve->v.str, &grp, "Failed to get EC_GROUP")) {
    if (!se_read_point(&grp, &pt, bytes->data, bytes->len)) {
      se_operation_failed("Failed to convert Buffer to EC_POINT");
    } else {
      ScrBytes *out = se_write_point(&grp, &pt, form);
      if (!out) se_operation_failed("Failed to convert EC_POINT to Buffer");
      else result = ca_encode(SE_SUBJECT, out, out_enc);
    }
  }
  mbedtls_ecp_point_free(&pt);
  mbedtls_ecp_group_free(&grp);
  scr_bytes_release(bytes);
  return result;
}

ScrDyn *scr_crypto_ecdh_convert_key(ScrDyn *key, ScrDyn *curve, ScrDyn *in_enc, ScrDyn *out_enc, ScrDyn *format) {
  ScrDyn *args[5] = {key, curve, in_enc, out_enc, format};
  ScrDyn *unboxed[5] = {NULL, NULL, NULL, NULL, NULL};
  ScrDyn *result = NULL;
  for (size_t i = 0; i < 5; i++)
    if (!(unboxed[i] = ca_unbox(args[i]))) goto done;
  result = se_convert_key(unboxed[0], unboxed[1], unboxed[2], unboxed[3], unboxed[4]);
done:
  for (size_t i = 0; i < 5; i++) scr_dyn_release(unboxed[i]);
  return result;
}

/* ── methods ──────────────────────────────────────────────────────────── */

static ScrDyn *se_arg(ScrDyn *const *args, size_t argc, size_t index) {
  return index < argc ? args[index] : scr_dyn_undefined();
}

/* The public key as getPublicKey(encoding, format) answers it. */
static ScrDyn *se_get_public_key(ScEcdh *e, const ScrDyn *encoding, const ScrDyn *format) {
  int form = se_format(format);
  if (!form) return NULL;
  if (!e->has_public) {
    se_operation_failed("Failed to get ECDH public key");
    return NULL;
  }
  ScrBytes *out = se_write_point(&e->grp, &e->q, form);
  if (!out) {
    se_operation_failed("Failed to get ECDH public key");
    return NULL;
  }
  return ca_encode(SE_SUBJECT, out, encoding);
}

static ScrDyn *se_generate_keys(ScEcdh *e, const ScrDyn *encoding, const ScrDyn *format) {
  e->pair_checked = false;
  if (mbedtls_ecp_gen_keypair(&e->grp, &e->d, &e->q, se_random, NULL) != 0) {
    e->has_private = false;
    e->has_public = false;
    se_operation_failed("Failed to generate key");
    return NULL;
  }
  e->has_private = true;
  e->has_public = true;
  e->pair_checked = true;
  return se_get_public_key(e, encoding, format);
}

/* The minimal big-endian bytes of the private key, as BN_bn2bin writes
 * them. */
static ScrDyn *se_get_private_key(ScEcdh *e, const ScrDyn *encoding) {
  if (!e->has_private) {
    se_operation_failed("Failed to get ECDH private key");
    return NULL;
  }
  size_t len = mbedtls_mpi_size(&e->d);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (mbedtls_mpi_write_binary(&e->d, out->data, len) != 0) {
    scr_bytes_release(out);
    se_operation_failed("Failed to get ECDH private key");
    return NULL;
  }
  return ca_encode(SE_SUBJECT, out, encoding);
}

/* setPrivateKey(key, encoding): 1 <= d < n, and the public key d·G. */
static ScrDyn *se_set_private_key(ScEcdh *e, ScrDyn *self, const ScrDyn *key, const ScrDyn *encoding) {
  ScrBytes *bytes = ca_key_bytes(SE_SUBJECT, key, encoding);
  if (!bytes) return NULL;
  mbedtls_mpi d;
  mbedtls_ecp_point q;
  mbedtls_mpi_init(&d);
  mbedtls_ecp_point_init(&q);
  ScrDyn *result = NULL;
  if (mbedtls_mpi_read_binary(&d, bytes->data, bytes->len) != 0) {
    se_operation_failed("Failed to convert Buffer to BN");
  } else if (mbedtls_mpi_cmp_int(&d, 1) < 0 || mbedtls_mpi_cmp_mpi(&d, &e->grp.N) >= 0) {
    se_throw(SCR_ERR_RANGE, "ERR_CRYPTO_INVALID_KEYTYPE", "Private key is not valid for specified curve.");
  } else if (mbedtls_ecp_mul(&e->grp, &q, &d, &e->grp.G, se_random, NULL) != 0) {
    se_operation_failed("Failed to generate ECDH public key");
  } else {
    mbedtls_mpi_swap(&e->d, &d);
    mbedtls_ecp_point_free(&e->q);
    mbedtls_ecp_point_init(&e->q);
    mbedtls_ecp_copy(&e->q, &q);
    e->has_private = true;
    e->has_public = true;
    e->pair_checked = true;
    result = scr_dyn_retain(self);
  }
  scr_bytes_release(bytes);
  mbedtls_mpi_free(&d);
  mbedtls_ecp_point_free(&q);
  return result;
}

static SCR_TL bool se_dep0031_emitted = false;

static void se_dep0031_tick(void) {
  ScrStr *text = scr_str_new("ecdh.setPublicKey() is deprecated.", 34);
  scr_emit_warning("DeprecationWarning", "DEP0031", text);
  scr_str_release(text);
}

/* deprecate() reports DEP0031 on the first call, on the next tick as
 * process.emitWarning does. */
static void se_dep0031(void) {
  if (se_dep0031_emitted) return;
  se_dep0031_emitted = true;
  scr_next_tick_raw(se_dep0031_tick);
}

static ScrDyn *se_set_public_key(ScEcdh *e, ScrDyn *self, const ScrDyn *key, const ScrDyn *encoding) {
  se_dep0031();
  ScrBytes *bytes = ca_key_bytes(SE_SUBJECT, key, encoding);
  if (!bytes) return NULL;
  mbedtls_ecp_point q;
  mbedtls_ecp_point_init(&q);
  ScrDyn *result = NULL;
  if (!se_read_point(&e->grp, &q, bytes->data, bytes->len)) {
    se_operation_failed("Failed to convert Buffer to EC_POINT");
  } else {
    mbedtls_ecp_copy(&e->q, &q);
    e->has_public = true;
    e->pair_checked = false;
    result = scr_dyn_retain(self);
  }
  scr_bytes_release(bytes);
  mbedtls_ecp_point_free(&q);
  return result;
}

/* EC_KEY_check_key for a key with a private part: the public key is not
 * the point at infinity and equals d·G. */
static bool se_pair_valid(ScEcdh *e) {
  if (!e->has_private || e->pair_checked) return true;
  bool valid = false;
  mbedtls_ecp_point expected;
  mbedtls_ecp_point_init(&expected);
  if (!mbedtls_ecp_is_zero(&e->q) &&
      mbedtls_ecp_mul(&e->grp, &expected, &e->d, &e->grp.G, se_random, NULL) == 0)
    valid = mbedtls_ecp_point_cmp(&expected, &e->q) == 0;
  mbedtls_ecp_point_free(&expected);
  e->pair_checked = valid;
  return valid;
}

/* computeSecret(key, inputEncoding, outputEncoding): the x coordinate of
 * d·P, padded to the field size as ECDH_compute_key writes it. */
static ScrDyn *se_compute_secret(ScEcdh *e, const ScrDyn *key, const ScrDyn *in_enc, const ScrDyn *out_enc) {
  ScrBytes *bytes = ca_key_bytes(SE_SUBJECT, key, in_enc);
  if (!bytes) return NULL;
  ScrDyn *result = NULL;
  mbedtls_ecp_point pub;
  mbedtls_mpi z;
  mbedtls_ecp_point_init(&pub);
  mbedtls_mpi_init(&z);
  if (!se_pair_valid(e)) {
    se_throw(SCR_ERR_RANGE, "ERR_CRYPTO_INVALID_KEYPAIR", "Invalid key pair");
  } else if (!se_read_point(&e->grp, &pub, bytes->data, bytes->len)) {
    se_throw(SCR_ERR_ERROR, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Public key is not valid for specified curve");
  } else if (!e->has_private || mbedtls_ecp_is_zero(&pub) ||
             mbedtls_ecdh_compute_shared(&e->grp, &z, &pub, &e->d, se_random, NULL) != 0) {
    se_operation_failed("Failed to compute ECDH key");
  } else {
    size_t plen = mbedtls_mpi_size(&e->grp.P);
    ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)plen);
    if (mbedtls_mpi_write_binary(&z, out->data, plen) != 0) {
      scr_bytes_release(out);
      se_operation_failed("Failed to compute ECDH key");
    } else {
      result = ca_encode(SE_SUBJECT, out, out_enc);
    }
  }
  mbedtls_mpi_free(&z);
  mbedtls_ecp_point_free(&pub);
  scr_bytes_release(bytes);
  return result;
}

static bool se_name_is(const char *method, const char *name) {
  return strcmp(method, name) == 0;
}

static ScrDyn *se_dispatch(ScEcdh *e, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                           const char *what) {
  if (se_name_is(method, "generateKeys")) return se_generate_keys(e, se_arg(args, argc, 0), se_arg(args, argc, 1));
  if (se_name_is(method, "computeSecret"))
    return se_compute_secret(e, se_arg(args, argc, 0), se_arg(args, argc, 1), se_arg(args, argc, 2));
  if (se_name_is(method, "getPublicKey")) return se_get_public_key(e, se_arg(args, argc, 0), se_arg(args, argc, 1));
  if (se_name_is(method, "getPrivateKey")) return se_get_private_key(e, se_arg(args, argc, 0));
  if (se_name_is(method, "setPrivateKey"))
    return se_set_private_key(e, self, se_arg(args, argc, 0), se_arg(args, argc, 1));
  if (se_name_is(method, "setPublicKey"))
    return se_set_public_key(e, self, se_arg(args, argc, 0), se_arg(args, argc, 1));
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

/* Every method reads at most three arguments. */
static ScrDyn *se_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                         const char *what) {
  ScrDyn *unboxed[3] = {NULL, NULL, NULL};
  size_t count = argc < 3 ? argc : 3;
  ScrDyn *result = NULL;
  for (size_t i = 0; i < count; i++)
    if (!(unboxed[i] = ca_unbox(args[i]))) goto done;
  result = se_dispatch(h, self, method, unboxed, count, what);
done:
  for (size_t i = 0; i < count; i++) scr_dyn_release(unboxed[i]);
  return result;
}

static ScrDyn *se_get(void *h, const char *key, size_t key_len) {
  (void)h; (void)key; (void)key_len;
  static const char message[] =
    "ECDH property reads have no lowering; call generateKeys(), computeSecret(), getPublicKey(), "
    "getPrivateKey(), setPrivateKey() or setPublicKey()";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static bool se_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  static const char message[] = "Writing ECDH properties has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return true;
}

static ScrDynHandleOps se_ops = {"ECDH", se_retain, se_release, se_invoke, se_get, se_set, NULL, NULL, NULL};
