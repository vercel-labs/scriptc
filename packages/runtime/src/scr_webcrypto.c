/* WebCrypto's secret-key slice: crypto.subtle.importKey, generateKey and
 * exportKey for HMAC and AES keys (importKey also for PBKDF2 and HKDF
 * keys), HMAC sign and verify, the SHA-1/SHA-2 digests, PBKDF2 and HKDF
 * deriveBits and deriveKey, the argument and key handling of AES encrypt
 * and decrypt (whose cipher runs in scr_webcrypto_aes.c), and the
 * CryptoKey values those methods answer.
 *
 * This unit is only the WebCrypto layer, modeled on Node 24's
 * lib/internal/crypto/webcrypto.js, mac.js, aes.js and keys.js: Web IDL
 * argument conversion, algorithm normalization, the CryptoKey handle, the
 * JSON Web Key forms, promise wrapping and Node's error shapes. The MACs
 * and digests themselves come from node:crypto's digest core
 * (scr_crypto_hmac_raw and scr_crypto_digest_raw in scr_lib.c), and
 * results settle through the deferred crypto queue that node:crypto's
 * callback forms use, so sign, verify, digest and generateKey settle on a
 * later loop turn like Node's thread-pool jobs while importKey and
 * exportKey settle at once.
 *
 * Every argument and validation failure rejects the returned promise.
 * Algorithms Node recognizes but this slice does not implement (RSA,
 * ECDSA, AES-OCB, SHA-3, ...) and the key formats of asymmetric keys
 * reject with a coded SC2020 Error instead of silently diverging. The
 * compiler links the unit only into programs that call these methods
 * (the webcrypto feature). */
#include "scr_runtime.h"
#include "scr_webcrypto.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── algorithm registry ───────────────────────────────────────────────
 * The names Node 24 registers per operation (util.js's
 * kAlgorithmDefinitions with the conditional algorithms its OpenSSL
 * build enables), matched case-insensitively. HMAC, AES-CBC/CTR/GCM/KW
 * keys, PBKDF2 and HKDF key imports and the SHA-1/SHA-2 digests are
 * implemented. */
static const char *const scr_wc_import_names[] = {
    "AES-CBC",       "AES-CTR",         "AES-GCM",        "AES-KW",       "AES-OCB",
    "Argon2d",       "Argon2i",         "Argon2id",       "ChaCha20-Poly1305",
    "ECDH",          "ECDSA",           "Ed25519",        "Ed448",        "HKDF",
    "HMAC",          "KMAC128",         "KMAC256",        "ML-DSA-44",    "ML-DSA-65",
    "ML-DSA-87",     "ML-KEM-512",      "ML-KEM-768",     "ML-KEM-1024",  "MLKEM768-P256",
    "MLKEM768-X25519", "MLKEM1024-P384", "PBKDF2",        "RSA-OAEP",     "RSA-PSS",
    "RSASSA-PKCS1-v1_5", "X25519",      "X448",
};
static const char *const scr_wc_sign_names[] = {
    "ECDSA",     "Ed25519",   "Ed448",   "HMAC",    "KMAC128",           "KMAC256",
    "ML-DSA-44", "ML-DSA-65", "ML-DSA-87", "RSA-PSS", "RSASSA-PKCS1-v1_5",
};
/* generateKey and exportKey register the same algorithms. */
static const char *const scr_wc_key_names[] = {
    "AES-CBC",     "AES-CTR",     "AES-GCM",     "AES-KW",        "AES-OCB",
    "ChaCha20-Poly1305", "ECDH",  "ECDSA",       "Ed25519",       "Ed448",
    "HMAC",        "KMAC128",     "KMAC256",     "ML-DSA-44",     "ML-DSA-65",
    "ML-DSA-87",   "ML-KEM-512",  "ML-KEM-768",  "ML-KEM-1024",   "MLKEM768-P256",
    "MLKEM768-X25519", "MLKEM1024-P384", "RSA-OAEP", "RSA-PSS",   "RSASSA-PKCS1-v1_5",
    "X25519",      "X448",
};
const char *const scr_wc_digest_names[] = {
    "SHA-1",     "SHA-256",   "SHA-384",   "SHA-512",   "SHA3-256",      "SHA3-384",
    "SHA3-512",  "cSHAKE128", "cSHAKE256", "KT128",     "KT256",         "TurboSHAKE128",
    "TurboSHAKE256",
};


/* The implemented hashes: WebCrypto name and node:crypto digest name. */
static const struct {
  const char *name;
  const char *native;
} scr_wc_hashes[] = {
    {"SHA-1", "sha1"},
    {"SHA-256", "sha256"},
    {"SHA-384", "sha384"},
    {"SHA-512", "sha512"},
};

static bool scr_wc_ascii_ieq(const ScrStr *s, const char *name) {
  size_t n = strlen(name);
  if (s->len != n) return false;
  for (size_t i = 0; i < n; i++) {
    unsigned char a = (unsigned char)s->data[i], b = (unsigned char)name[i];
    if (a >= 'a' && a <= 'z') a = (unsigned char)(a - 32);
    if (b >= 'a' && b <= 'z') b = (unsigned char)(b - 32);
    if (a != b) return false;
  }
  return true;
}

/* The canonical registered spelling of `name`, or NULL. */
const char *scr_wc_lookup(const char *const *names, size_t count, const ScrStr *name) {
  for (size_t i = 0; i < count; i++)
    if (scr_wc_ascii_ieq(name, names[i])) return names[i];
  return NULL;
}

static const char *scr_wc_native_hash(const char *name) {
  for (size_t i = 0; i < SCR_WC_COUNT(scr_wc_hashes); i++)
    if (strcmp(scr_wc_hashes[i].name, name) == 0) return scr_wc_hashes[i].native;
  return NULL;
}

/* ── errors ────────────────────────────────────────────────────────── */

const char *const scr_wc_ordinals[] = {"1st", "2nd", "3rd", "4th", "5th"};

/* An argument's ordinal: unwrapKey's seven arguments run past the shared
 * table. */
static const char *scr_wc_ordinal(size_t index) {
  static const char *const later[] = {"6th", "7th"};
  size_t shared = SCR_WC_COUNT(scr_wc_ordinals);
  return index < shared ? scr_wc_ordinals[index] : later[index - shared];
}

void scr_wc_type_error(const char *code, const char *fmt, ...) {
  char message[512];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(message, sizeof message, fmt, ap);
  va_end(ap);
  if (n < 0) n = 0;
  if ((size_t)n >= sizeof message) n = (int)sizeof message - 1;
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, code);
}

/* An operation or algorithm Node supports that this slice does not. */
void scr_wc_unsupported(const char *method, const char *what) {
  char message[256];
  int n = snprintf(message, sizeof message, "crypto.subtle.%s with %s is not supported yet", method,
                   what);
  if ((size_t)n >= sizeof message) n = (int)sizeof message - 1;
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)n, "SC2020");
}

void scr_wc_unsupported_algorithm(const char *method, const char *name) {
  char what[96];
  snprintf(what, sizeof what, "the %s algorithm", name);
  scr_wc_unsupported(method, what);
}

/* ── Web IDL conversions ──────────────────────────────────────────────
 * Each answers NULL/false with the TypeError pending. `prefix` is
 * "Failed to execute '<method>' on 'SubtleCrypto'". */

bool scr_wc_is_object(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_BIGINT:
  case SCR_DYN_SYMBOL:
    return false;
  default:
    return true;
  }
}

/* A typed reference capsule as its plain view; other values retained. */
ScrDyn *scr_wc_plain(ScrDyn *v) {
  if (v->kind == SCR_DYN_TYPED_REF) return scr_dyn_typed_ref_materialize(v);
  return scr_dyn_retain(v);
}

/* BufferSource: the bytes of a TypedArray, DataView, Buffer or
 * ArrayBuffer as a u8 view (+1). */
ScrBytes *scr_wc_buffer_source(const char *prefix, size_t index, ScrDyn *value) {
  ScrDyn *plain = scr_wc_plain(value);
  if (!plain) return NULL;
  ScrBytes *view = NULL;
  if (plain->kind == SCR_DYN_BYTES || scr_array_buffer_is(plain)) {
    view = scr_bytes_buffer_source(plain);
  } else {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE",
                      "%s: %s argument is not instance of ArrayBuffer, Buffer, TypedArray, or "
                      "DataView.",
                      prefix, scr_wc_ordinal(index));
  }
  scr_dyn_release(plain);
  return view;
}

/* DOMString conversion (+1). */
ScrStr *scr_wc_dom_string(const ScrDyn *value) { return scr_dyn_string_coerce_js(value); }

static const char *const scr_wc_key_formats[] = {
    "raw", "raw-public", "raw-seed", "raw-secret", "raw-private", "pkcs8", "spki", "jwk",
};

/* KeyFormat: the canonical enum spelling, or NULL. */
const char *scr_wc_key_format(const char *prefix, ScrDyn *value) {
  ScrStr *s = scr_wc_dom_string(value);
  if (!s) return NULL;
  for (size_t i = 0; i < SCR_WC_COUNT(scr_wc_key_formats); i++) {
    if (s->len == strlen(scr_wc_key_formats[i]) &&
        memcmp(s->data, scr_wc_key_formats[i], s->len) == 0) {
      scr_str_release(s);
      return scr_wc_key_formats[i];
    }
  }
  scr_wc_type_error("ERR_INVALID_ARG_VALUE",
                    "%s: 1st argument '%.*s' is not a valid enum value of type KeyFormat.", prefix,
                    (int)(s->len > 200 ? 200 : s->len), s->data);
  scr_str_release(s);
  return NULL;
}

/* Node's canonical usage order; the bit is the index. */
const char *const scr_wc_usages[] = {
    "encrypt",        "decrypt",         "sign",           "verify",
    "deriveKey",      "deriveBits",      "wrapKey",        "unwrapKey",
    "encapsulateKey", "encapsulateBits", "decapsulateKey", "decapsulateBits",
};
/* The usage index of a KeyUsage string, or -1. */
static int scr_wc_usage_index(const ScrStr *s) {
  for (size_t k = 0; k < SCR_WC_COUNT(scr_wc_usages); k++)
    if (s->len == strlen(scr_wc_usages[k]) && memcmp(s->data, scr_wc_usages[k], s->len) == 0)
      return (int)k;
  return -1;
}

/* sequence<KeyUsage> over an array: the usage mask (-1 on failure). */
long scr_wc_key_usages(const char *prefix, size_t index, ScrDyn *value) {
  ScrDyn *plain = scr_wc_plain(value);
  if (!plain) return -1;
  if (plain->kind != SCR_DYN_ARR) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: %s argument cannot be converted to sequence.",
                      prefix, scr_wc_ordinal(index));
    scr_dyn_release(plain);
    return -1;
  }
  long mask = 0;
  double n = scr_dyn_arr_len(plain);
  for (double i = 0; i < n; i++) {
    ScrDyn *item = scr_dyn_arr_at(plain, i);
    ScrStr *s = scr_wc_dom_string(item);
    scr_dyn_release(item);
    if (!s) {
      scr_dyn_release(plain);
      return -1;
    }
    int k = scr_wc_usage_index(s);
    if (k < 0) {
      scr_wc_type_error("ERR_INVALID_ARG_VALUE",
                        "%s: %s argument[%.0f] '%.*s' is not a valid enum value of type KeyUsage.",
                        prefix, scr_wc_ordinal(index), i, (int)(s->len > 200 ? 200 : s->len),
                        s->data);
      scr_str_release(s);
      scr_dyn_release(plain);
      return -1;
    }
    scr_str_release(s);
    mask |= 1L << k;
  }
  scr_dyn_release(plain);
  return mask;
}

/* ── algorithm normalization ──────────────────────────────────────────
 * normalizeAlgorithm(algorithm, op) for the members this slice reads:
 * the canonical name, the HMAC hash and length, and AES key lengths. */
typedef struct {
  const char *name;   /* canonical registered name */
  const char *hash;   /* HMAC: the normalized hash name */
  bool has_length;
  double length;
} ScrWcAlgorithm;

const char scr_wc_normalize_prefix[] = "Failed to normalize algorithm";

void scr_wc_missing_member(const char *dict, const char *member) {
  scr_wc_type_error("ERR_MISSING_OPTION",
                    "%s: passed algorithm cannot be converted to '%s' because '%s' is required in "
                    "'%s'.",
                    scr_wc_normalize_prefix, dict, member, dict);
}

/* Reads `key` off an algorithm dictionary (+1; undefined when absent). */
ScrDyn *scr_wc_member(const ScrDyn *dict, const char *key) {
  if (dict->kind != SCR_DYN_OBJ) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *v = scr_dyn_obj_read(dict, key, strlen(key));
  return v ? v : scr_dyn_retain(scr_dyn_undefined());
}

/* An [EnforceRange] integer conversion: the truncated value in [0, max],
 * or false with Node's TypeError pending. `context` names the value
 * ("length in passed algorithm", "3rd argument"). */
static bool scr_wc_enforce_range(const char *prefix, const char *context, const ScrDyn *value,
                                 double max, double *out) {
  double x;
  if (!scr_dyn_number_coerce_js(value, &x)) return false;
  if (x != x || x == 1.0 / 0.0 || x == -1.0 / 0.0) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: %s is not a finite number.", prefix, context);
    return false;
  }
  x = trunc(x);
  if (x == 0) x = 0;
  if (x < 0 || x > max) {
    scr_wc_type_error("ERR_OUT_OF_RANGE", "%s: %s is outside the expected range of 0 to %.0f.",
                      prefix, context, max);
    return false;
  }
  *out = x;
  return true;
}

/* The name an AlgorithmIdentifier carries (+1), with the Algorithm
 * dictionary's missing-name TypeError. `dict` names the dictionary the
 * value converts to. */
ScrStr *scr_wc_algorithm_name(ScrDyn *identifier, const char *dict) {
  if (!scr_wc_is_object(identifier)) return scr_wc_dom_string(identifier);
  ScrDyn *plain = scr_wc_plain(identifier);
  if (!plain) return NULL;
  ScrDyn *name = scr_wc_member(plain, "name");
  scr_dyn_release(plain);
  ScrStr *out = NULL;
  if (name->kind == SCR_DYN_UNDEF) scr_wc_missing_member(dict, "name");
  else out = scr_wc_dom_string(name);
  scr_dyn_release(name);
  return out;
}

/* The digest a HashAlgorithmIdentifier names: canonical name, or NULL
 * with NotSupportedError / the SC2020 refusal pending. */
const char *scr_wc_digest_algorithm(ScrDyn *identifier, const char *method) {
  ScrStr *name = scr_wc_algorithm_name(identifier, "Algorithm");
  if (!name) return NULL;
  const char *canonical = scr_wc_lookup(scr_wc_digest_names, SCR_WC_COUNT(scr_wc_digest_names), name);
  scr_str_release(name);
  if (!canonical) {
    scr_throw_domex("NotSupportedError", "Unrecognized algorithm name");
    return NULL;
  }
  if (!scr_wc_native_hash(canonical)) {
    scr_wc_unsupported_algorithm(method, canonical);
    return NULL;
  }
  return canonical;
}

/* HmacImportParams / HmacKeyGenParams (`dict`) over an object: hash
 * (required, a SHA name), then the optional [EnforceRange] unsigned long
 * length, which cannot be 0 (`zero_error` names that DOMException). */
static bool scr_wc_hmac_params(ScrDyn *identifier, const char *dict, const char *zero_error,
                               const char *method, ScrWcAlgorithm *out) {
  if (!scr_wc_is_object(identifier)) {
    scr_wc_missing_member(dict, "hash");
    return false;
  }
  ScrDyn *plain = scr_wc_plain(identifier);
  if (!plain) return false;
  ScrDyn *hash = scr_wc_member(plain, "hash");
  bool ok = true;
  if (hash->kind == SCR_DYN_UNDEF) {
    scr_wc_missing_member(dict, "hash");
    ok = false;
  }
  ScrDyn *hash_value = NULL;
  if (ok) {
    /* HashAlgorithmIdentifier converts to an object or a DOMString, then
     * ensureSHA reads the name: a string, or the object's name member. */
    ScrStr *hash_name = NULL;
    if (scr_wc_is_object(hash)) {
      hash_value = scr_dyn_retain(hash);
      ScrDyn *hp = scr_wc_plain(hash);
      ScrDyn *member = hp ? scr_wc_member(hp, "name") : NULL;
      if (hp) scr_dyn_release(hp);
      if (!member) ok = false;
      else {
        if (member->kind == SCR_DYN_STR) hash_name = scr_str_retain(member->v.str);
        scr_dyn_release(member);
      }
    } else {
      hash_name = scr_wc_dom_string(hash);
      if (!hash_name) ok = false;
      else hash_value = scr_dyn_new_str(hash_name);
    }
    bool sha = hash_name && hash_name->len >= 3 &&
               (hash_name->data[0] | 32) == 's' && (hash_name->data[1] | 32) == 'h' &&
               (hash_name->data[2] | 32) == 'a';
    if (hash_name) scr_str_release(hash_name);
    if (ok && !sha) {
      char message[96];
      snprintf(message, sizeof message, "Only SHA hashes are supported in %s", dict);
      scr_throw_domex("NotSupportedError", message);
      ok = false;
    }
  }
  if (ok) {
    ScrDyn *length = scr_wc_member(plain, "length");
    if (length->kind != SCR_DYN_UNDEF) {
      double x;
      if (!scr_wc_enforce_range(scr_wc_normalize_prefix, "length in passed algorithm", length,
                                4294967295.0, &x))
        ok = false;
      else if (x == 0) {
        char message[96];
        snprintf(message, sizeof message, "%s.length cannot be 0", dict);
        scr_throw_domex(zero_error, message);
        ok = false;
      } else {
        out->has_length = true;
        out->length = x;
      }
    }
    scr_dyn_release(length);
  }
  if (ok) {
    out->hash = scr_wc_digest_algorithm(hash_value, method);
    if (!out->hash) ok = false;
  }
  if (hash_value) scr_dyn_release(hash_value);
  scr_dyn_release(hash);
  scr_dyn_release(plain);
  return ok;
}

/* AesKeyGenParams / AesDerivedKeyParams (`dict`): the required
 * [EnforceRange] unsigned short length, 128, 192 or 256. */
static bool scr_wc_aes_length_params(ScrDyn *identifier, const char *dict, ScrWcAlgorithm *out) {
  ScrDyn *plain = scr_wc_plain(identifier);
  if (!plain) return false;
  ScrDyn *length = scr_wc_member(plain, "length");
  bool ok = false;
  double x;
  if (length->kind == SCR_DYN_UNDEF) scr_wc_missing_member(dict, "length");
  else if (scr_wc_enforce_range(scr_wc_normalize_prefix, "length in passed algorithm", length,
                                65535.0, &x)) {
    if (x != 128 && x != 192 && x != 256) {
      scr_throw_domex("OperationError", "AES key length must be 128, 192, or 256 bits");
    } else {
      out->has_length = true;
      out->length = x;
      ok = true;
    }
  }
  scr_dyn_release(length);
  scr_dyn_release(plain);
  return ok;
}

static bool scr_wc_is_aes(const char *name) {
  return strcmp(name, "AES-CBC") == 0 || strcmp(name, "AES-CTR") == 0 ||
         strcmp(name, "AES-GCM") == 0 || strcmp(name, "AES-KW") == 0;
}

static bool scr_wc_is_kdf(const char *name) {
  return strcmp(name, "PBKDF2") == 0 || strcmp(name, "HKDF") == 0;
}

typedef enum {
  SCR_WC_OP_IMPORT,
  SCR_WC_OP_SIGN,
  SCR_WC_OP_GENERATE,
} ScrWcOp;

/* normalizeAlgorithm for importKey, sign/verify and generateKey (`names`)
 * — false with the error pending. Only the dictionaries of the
 * implemented algorithms are read; any other recognized algorithm is
 * refused by the caller. */
static bool scr_wc_normalize(ScrDyn *identifier, const char *const *names, size_t count, ScrWcOp op,
                             ScrWcAlgorithm *out) {
  memset(out, 0, sizeof *out);
  ScrStr *name = scr_wc_algorithm_name(identifier, "Algorithm");
  if (!name) return false;
  out->name = scr_wc_lookup(names, count, name);
  scr_str_release(name);
  if (!out->name) {
    scr_throw_domex("NotSupportedError", "Unrecognized algorithm name");
    return false;
  }
  bool hmac = strcmp(out->name, "HMAC") == 0;
  if (op == SCR_WC_OP_IMPORT && hmac)
    return scr_wc_hmac_params(identifier, "HmacImportParams", "DataError", "importKey", out);
  if (op == SCR_WC_OP_GENERATE && hmac)
    return scr_wc_hmac_params(identifier, "HmacKeyGenParams", "OperationError", "generateKey", out);
  if (op == SCR_WC_OP_GENERATE && scr_wc_is_aes(out->name))
    return scr_wc_aes_length_params(identifier, "AesKeyGenParams", out);
  return true;
}

/* ── CryptoKey ─────────────────────────────────────────────────────────
 * A secret key: the algorithm name, the bytes, the HMAC hash, the bit
 * length (HMAC and AES keys), the usage mask and the extractable flag.
 * The algorithm and usages getters answer the same object on every read
 * (Node caches its clones), built on first read. The bytes are cleared
 * when the last reference goes. */
typedef struct ScrCryptoKey {
  size_t rc;
  const char *name; /* canonical algorithm name */
  const char *hash; /* HMAC: WebCrypto hash name */
  double length;    /* HMAC and AES: bits */
  unsigned usages;
  bool extractable;
  ScrDyn *algorithm; /* cached getter results, or NULL */
  ScrDyn *usage_list;
  size_t len;
  unsigned char data[];
} ScrCryptoKey;

static void *scr_crypto_key_retain(void *p) {
  ((ScrCryptoKey *)p)->rc++;
  return p;
}

static void scr_crypto_key_release(void *p) {
  ScrCryptoKey *key = p;
  if (!key || --key->rc != 0) return;
  volatile unsigned char *bytes = key->data;
  for (size_t i = 0; i < key->len; i++) bytes[i] = 0;
  if (key->algorithm) scr_dyn_release(key->algorithm);
  if (key->usage_list) scr_dyn_release(key->usage_list);
  free(key);
}

static ScrCryptoKey *scr_crypto_key_of(const ScrDyn *value) {
  if (value->kind != SCR_DYN_HANDLE || value->v.handle.tag != SCR_DYNH_CRYPTO_KEY) return NULL;
  return value->v.handle.ptr;
}

bool scr_webcrypto_is_crypto_key(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) return false;
  return scr_crypto_key_of(value) != NULL || (scr_wc_asymmetric && scr_wc_asymmetric->is_key(value));
}

ScrDyn *scr_wc_cstr(const char *s) {
  ScrStr *str = scr_str_new(s, strlen(s));
  ScrDyn *out = scr_dyn_new_str(str);
  scr_str_release(str);
  return out;
}

/* Node's algorithm objects: { name, length, hash } for HMAC keys,
 * { name, length } for AES keys and { name } for PBKDF2 and HKDF keys. */
static ScrDyn *scr_crypto_key_algorithm(ScrCryptoKey *key) {
  if (!key->algorithm) {
    ScrDyn *algorithm = scr_dyn_new_obj();
    scr_dyn_obj_set(algorithm, "name", 4, scr_wc_cstr(key->name));
    if (!scr_wc_is_kdf(key->name))
      scr_dyn_obj_set(algorithm, "length", 6, scr_dyn_new_num(key->length));
    if (key->hash) {
      ScrDyn *hash = scr_dyn_new_obj();
      scr_dyn_obj_set(hash, "name", 4, scr_wc_cstr(key->hash));
      scr_dyn_obj_set(algorithm, "hash", 4, hash);
    }
    key->algorithm = algorithm;
  }
  return scr_dyn_retain(key->algorithm);
}

/* The usages as a fresh array in Node's canonical order (+1). */
static ScrDyn *scr_wc_usage_array(unsigned usages) {
  ScrDyn *list = scr_dyn_new_arr();
  for (size_t i = 0; i < SCR_WC_COUNT(scr_wc_usages); i++)
    if (usages & (1u << i)) scr_dyn_arr_push(list, scr_wc_cstr(scr_wc_usages[i]));
  return list;
}

static ScrDyn *scr_crypto_key_usages(ScrCryptoKey *key) {
  if (!key->usage_list) key->usage_list = scr_wc_usage_array(key->usages);
  return scr_dyn_retain(key->usage_list);
}

static bool scr_wc_name_is(const char *name, size_t len, const char *literal) {
  return len == strlen(literal) && memcmp(name, literal, len) == 0;
}

static ScrDyn *scr_crypto_key_get(void *h, const char *name, size_t len) {
  ScrCryptoKey *key = h;
  if (scr_wc_name_is(name, len, "type")) return scr_wc_cstr("secret");
  if (scr_wc_name_is(name, len, "extractable")) return scr_dyn_new_bool(key->extractable);
  if (scr_wc_name_is(name, len, "algorithm")) return scr_crypto_key_algorithm(key);
  if (scr_wc_name_is(name, len, "usages")) return scr_crypto_key_usages(key);
  return NULL;
}

/* The four members are prototype getters without setters: an assignment
 * in strict code throws Node's TypeError. */
static bool scr_crypto_key_set(void *h, const char *name, size_t len, const ScrDyn *value) {
  (void)h;
  (void)value;
  if (!scr_wc_name_is(name, len, "type") && !scr_wc_name_is(name, len, "extractable") &&
      !scr_wc_name_is(name, len, "algorithm") && !scr_wc_name_is(name, len, "usages"))
    return false;
  char message[128];
  int n = snprintf(message, sizeof message,
                   "Cannot set property %.*s of #<CryptoKey> which has only a getter", (int)len,
                   name);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)n);
  return true;
}

static ScrDyn *scr_crypto_key_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what) {
  (void)h;
  (void)self;
  (void)args;
  (void)argc;
  if (strcmp(method, "toString") == 0) return scr_wc_cstr("[object CryptoKey]");
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

/* key[Symbol.toStringTag] answers "CryptoKey". */
static ScrDyn *scr_crypto_key_symbol_get(void *h, const ScrDyn *key) {
  (void)h;
  if (key->kind != SCR_DYN_SYMBOL || !key->v.symbol.description) return NULL;
  ScrStr *description = key->v.symbol.description(key->v.symbol.value);
  bool tag = description && description->len == 18 &&
             memcmp(description->data, "Symbol.toStringTag", 18) == 0;
  if (description) scr_str_release(description);
  return tag ? scr_wc_cstr("CryptoKey") : NULL;
}

/* No inspect_view: Node's custom inspector prints the members one level
 * deeper than a plain object would, which the shared handle inspection
 * cannot reproduce, so util.inspect refuses a CryptoKey ('not supported
 * yet') rather than printing a different shape. */
static const ScrDynHandleOps scr_crypto_key_ops = {
    .cls = "CryptoKey",
    .retain = scr_crypto_key_retain,
    .release = scr_crypto_key_release,
    .invoke = scr_crypto_key_invoke,
    .get = scr_crypto_key_get,
    .set = scr_crypto_key_set,
    .json_empty_object = true,
    .to_string_tag = "CryptoKey",
    .symbol_get = scr_crypto_key_symbol_get,
};

static ScrDyn *scr_crypto_key_new(const unsigned char *data, size_t len, const char *name,
                                  const char *hash, double length, unsigned usages,
                                  bool extractable) {
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_CRYPTO_KEY, &scr_crypto_key_ops);
  }
  ScrCryptoKey *key = malloc(sizeof *key + (len ? len : 1));
  if (!key) scr_trap("scriptc: out of memory\n");
  key->rc = 1;
  key->name = name;
  key->hash = hash;
  key->length = length;
  key->usages = usages;
  key->extractable = extractable;
  key->algorithm = NULL;
  key->usage_list = NULL;
  key->len = len;
  if (len) memcpy(key->data, data, len);
  ScrDyn *box = scr_dyn_new_handle(key, SCR_DYNH_CRYPTO_KEY);
  scr_crypto_key_release(key);
  return box;
}

/* numBitsToBytes: whole bytes for `bits`, rounding up. */
static size_t scr_wc_bits_to_bytes(double bits) {
  return (size_t)(floor(bits / 8) + floor((7 + fmod(bits, 8)) / 8));
}

/* Clears the unused low bits of the final byte of a `bits`-long key
 * (truncateToBitLength). */
static void scr_wc_truncate_bits(unsigned char *data, size_t len, double bits) {
  int extra = (int)fmod(bits, 8);
  if (extra && len) data[len - 1] = (unsigned char)(data[len - 1] & (0xff << (8 - extra)));
}

/* The usages each key algorithm accepts. */
static unsigned scr_wc_allowed_usages(const char *name) {
  if (strcmp(name, "HMAC") == 0) return SCR_WC_USAGE_SIGN | SCR_WC_USAGE_VERIFY;
  if (strcmp(name, "AES-KW") == 0) return SCR_WC_USAGE_WRAP_KEY | SCR_WC_USAGE_UNWRAP_KEY;
  if (scr_wc_is_kdf(name)) return SCR_WC_USAGE_DERIVE_KEY | SCR_WC_USAGE_DERIVE_BITS;
  return SCR_WC_USAGE_ENCRYPT | SCR_WC_USAGE_DECRYPT | SCR_WC_USAGE_WRAP_KEY |
         SCR_WC_USAGE_UNWRAP_KEY;
}

/* validateKeyUsages: SyntaxError for a usage outside the algorithm's. */
static bool scr_wc_check_usages(const char *name, long usages) {
  if (!(usages & ~(long)scr_wc_allowed_usages(name))) return true;
  char message[96];
  snprintf(message, sizeof message, "Unsupported key usage for %s%s key",
           scr_wc_is_kdf(name) ? "a " : "", name);
  scr_throw_domex("SyntaxError", message);
  return false;
}

/* The JWK "alg" of an HMAC hash or an AES key, or NULL. */
static const char *scr_wc_jwk_alg(const char *name, const char *hash, double length, char *buf,
                                  size_t size) {
  if (strcmp(name, "HMAC") == 0) {
    if (strcmp(hash, "SHA-1") == 0) return "HS1";
    if (strcmp(hash, "SHA-256") == 0) return "HS256";
    if (strcmp(hash, "SHA-384") == 0) return "HS384";
    if (strcmp(hash, "SHA-512") == 0) return "HS512";
    return NULL;
  }
  if (!scr_wc_is_aes(name)) return NULL;
  snprintf(buf, size, "A%.0f%s", length, name + 4);
  return buf;
}

/* ── JSON Web Keys ─────────────────────────────────────────────────────
 * The JsonWebKey dictionary members a secret key reads, converted in Web
 * IDL's member order (every DOMString member converts, so a Symbol or a
 * throwing toString in any of them rejects like Node). */
typedef struct {
  ScrStr *alg, *k, *kty, *use;
  bool has_ext, ext;
  ScrDyn *key_ops; /* array of strings, or NULL */
} ScrWcJwk;

static void scr_wc_jwk_drop(ScrWcJwk *jwk) {
  if (jwk->alg) scr_str_release(jwk->alg);
  if (jwk->k) scr_str_release(jwk->k);
  if (jwk->kty) scr_str_release(jwk->kty);
  if (jwk->use) scr_str_release(jwk->use);
  if (jwk->key_ops) scr_dyn_release(jwk->key_ops);
  memset(jwk, 0, sizeof *jwk);
}

/* A DOMString dictionary member: NULL with *ok when absent; NULL with
 * !*ok and the TypeError pending on failure. */
static ScrStr *scr_wc_jwk_string(const char *prefix, const ScrDyn *dict, const char *key, bool *ok) {
  ScrDyn *value = scr_wc_member(dict, key);
  ScrStr *out = NULL;
  if (value->kind == SCR_DYN_SYMBOL) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE",
                      "%s: %s in 2nd argument is a Symbol and cannot be converted to a string.",
                      prefix, key);
    *ok = false;
  } else if (value->kind != SCR_DYN_UNDEF) {
    out = scr_wc_dom_string(value);
    if (!out) *ok = false;
  }
  scr_dyn_release(value);
  return out;
}

static bool scr_wc_jwk_convert(const char *prefix, ScrDyn *value, ScrWcJwk *out) {
  memset(out, 0, sizeof *out);
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) return true;
  if (!scr_wc_is_object(value)) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 2nd argument cannot be converted to a dictionary",
                      prefix);
    return false;
  }
  ScrDyn *dict = scr_wc_plain(value);
  if (!dict) return false;
  static const char *const members[] = {"alg", "crv", "d",  "dp", "dq", "e",  "ext",
                                        "k",   "key_ops", "kty", "n", "p", "priv", "pub",
                                        "q",   "qi",  "use", "x",  "y"};
  bool ok = true;
  for (size_t i = 0; ok && i < SCR_WC_COUNT(members); i++) {
    const char *key = members[i];
    if (strcmp(key, "ext") == 0) {
      ScrDyn *ext = scr_wc_member(dict, key);
      if (ext->kind != SCR_DYN_UNDEF) {
        out->has_ext = true;
        out->ext = scr_dyn_truthy(ext);
      }
      scr_dyn_release(ext);
    } else if (strcmp(key, "key_ops") == 0) {
      ScrDyn *ops = scr_wc_member(dict, key);
      if (ops->kind != SCR_DYN_UNDEF) {
        ScrDyn *list = scr_wc_plain(ops);
        if (!list) ok = false;
        else if (list->kind != SCR_DYN_ARR) {
          scr_wc_type_error("ERR_INVALID_ARG_TYPE",
                            "%s: key_ops in 2nd argument cannot be converted to sequence.", prefix);
          scr_dyn_release(list);
          ok = false;
        } else {
          ScrDyn *strings = scr_dyn_new_arr();
          double n = scr_dyn_arr_len(list);
          for (double j = 0; ok && j < n; j++) {
            ScrDyn *item = scr_dyn_arr_at(list, j);
            ScrStr *s = scr_wc_dom_string(item);
            scr_dyn_release(item);
            if (!s) ok = false;
            else {
              scr_dyn_arr_push(strings, scr_dyn_new_str(s));
              scr_str_release(s);
            }
          }
          scr_dyn_release(list);
          if (ok) out->key_ops = strings;
          else scr_dyn_release(strings);
        }
      }
      scr_dyn_release(ops);
    } else {
      ScrStr *s = scr_wc_jwk_string(prefix, dict, key, &ok);
      if (strcmp(key, "alg") == 0) out->alg = s;
      else if (strcmp(key, "k") == 0) out->k = s;
      else if (strcmp(key, "kty") == 0) out->kty = s;
      else if (strcmp(key, "use") == 0) out->use = s;
      else if (s) scr_str_release(s);
    }
  }
  scr_dyn_release(dict);
  if (!ok) scr_wc_jwk_drop(out);
  return ok;
}

static bool scr_wc_str_is(const ScrStr *s, const char *literal) {
  return s && s->len == strlen(literal) && memcmp(s->data, literal, s->len) == 0;
}

/* validateJwk for an oct key, then the key bytes (+1): k decodes with
 * Node's lenient base64 decoder, so any string answers bytes. */
static ScrBytes *scr_wc_jwk_secret(const ScrWcJwk *jwk, bool extractable, long usages,
                                   const char *expected_use) {
  if (!jwk->kty) {
    scr_throw_domex("DataError", "Invalid keyData");
    return NULL;
  }
  if (!scr_wc_str_is(jwk->kty, "oct")) {
    scr_throw_domex("DataError", "Invalid JWK \"kty\" Parameter");
    return NULL;
  }
  if (!jwk->k) {
    scr_throw_domex("DataError", "Invalid keyData");
    return NULL;
  }
  if (usages != 0 && jwk->use && !scr_wc_str_is(jwk->use, expected_use)) {
    scr_throw_domex("DataError", "Invalid JWK \"use\" Parameter");
    return NULL;
  }
  if (jwk->key_ops) {
    long seen = 0;
    double n = scr_dyn_arr_len(jwk->key_ops);
    for (double i = 0; i < n; i++) {
      ScrDyn *op = scr_dyn_arr_at(jwk->key_ops, i);
      int k = scr_wc_usage_index(op->v.str);
      scr_dyn_release(op);
      if (k < 0) continue;
      if (seen & (1L << k)) {
        scr_throw_domex("DataError", "Duplicate key operation");
        return NULL;
      }
      seen |= 1L << k;
    }
    if ((seen & usages) != usages) {
      scr_throw_domex("DataError", "Key operations and usage mismatch");
      return NULL;
    }
  }
  if (jwk->has_ext && !jwk->ext && extractable) {
    scr_throw_domex("DataError", "JWK \"ext\" Parameter and extractable mismatch");
    return NULL;
  }
  ScrStr *encoding = scr_str_new("base64url", 9);
  ScrBytes *bytes = scr_bytes_from_str(jwk->k, encoding);
  scr_str_release(encoding);
  return bytes;
}

/* ── the operations ───────────────────────────────────────────────────
 * Each takes its argument vector as one dyn array (borrowed) and answers
 * a +1 promise. */

const ScrWcAsymmetric *scr_wc_asymmetric = NULL;

static const char *const scr_wc_asymmetric_names[] = {"ECDSA", "Ed25519", "RSA-PSS", "RSASSA-PKCS1-v1_5"};

/* Whether the AlgorithmIdentifier at args[index] names ECDSA,
 * RSASSA-PKCS1-v1_5, RSA-PSS or Ed25519, read without side effects or errors: a
 * string, or the name member of an object (a statically typed one through
 * its plain view). A value that does not read cleanly takes the HMAC path,
 * which reports its errors. */
static const char *scr_wc_asymmetric_name(const ScrDyn *args, size_t index) {
  if ((size_t)scr_dyn_arr_len(args) <= index) return NULL;
  ScrDyn *identifier = scr_dyn_arr_at(args, (double)index);
  ScrDyn *plain = scr_wc_plain(identifier);
  if (!plain) scr_exc_clear();
  const char *found = NULL;
  if (plain) {
    const ScrDyn *name = plain;
    if (plain->kind == SCR_DYN_OBJ) name = scr_dyn_obj_get(plain, "name", 4);
    if (name && name->kind == SCR_DYN_STR)
      found = scr_wc_lookup(scr_wc_asymmetric_names, SCR_WC_COUNT(scr_wc_asymmetric_names),
                            name->v.str);
    scr_dyn_release(plain);
  }
  scr_dyn_release(identifier);
  return found;
}

/* Whether `value` is an ECDSA, Ed25519 or RSA CryptoKey, which
 * scr_webcrypto_pki.c holds; wrapKey and unwrapKey wrap secret keys only. */
static bool scr_wc_is_asymmetric_key(const ScrDyn *value) {
  return scr_wc_asymmetric && scr_wc_asymmetric->is_key(value);
}

static bool scr_wc_is_asymmetric_algorithm(const char *name) {
  for (size_t i = 0; i < SCR_WC_COUNT(scr_wc_asymmetric_names); i++)
    if (strcmp(name, scr_wc_asymmetric_names[i]) == 0) return true;
  return false;
}

/* The asymmetric algorithms run in scr_webcrypto_pki.c, which the compiler
 * links when a string literal in the program names one of them. */
static ScrPromise *scr_wc_asymmetric_missing(const char *method, const char *name) {
  char what[160];
  snprintf(what, sizeof what, "the %s algorithm named only by a computed string", name);
  scr_wc_unsupported(method, what);
  return scr_wc_rejected();
}

ScrPromise *scr_wc_rejected(void) {
  ScrPromise *p = scr_promise_new();
  scr_promise_reject_pending(p);
  return p;
}

/* A promise already fulfilled with `value` (moves). */
static ScrPromise *scr_wc_resolved(ScrDyn *value) {
  return scr_promise_settled_ref(value, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
}

/* A promise that fulfills with `value` (moves) on a later loop turn, like
 * Node's crypto jobs. */
static ScrPromise *scr_wc_deferred(ScrDyn *value) {
  ScrPromise *p = scr_promise_new();
  scr_crypto_defer_dyn(value, NULL, scr_crypto_promise_callback(p), scr_crypto_promise_settle_dyn);
  return p;
}

/* The argument count check every method starts with (after the receiver
 * check the compiler's call shape already guarantees). */
bool scr_wc_required(const char *prefix, const ScrDyn *args, size_t required) {
  size_t argc = (size_t)scr_dyn_arr_len(args);
  if (argc >= required) return true;
  scr_wc_type_error("ERR_MISSING_ARGS", "%s: %zu arguments required, but only %zu present.", prefix,
                    required, argc);
  return false;
}


void scr_wc_args_take(ScrWcArgs *a, const ScrDyn *args, size_t n) {
  for (size_t i = 0; i < n; i++) a->v[i] = scr_dyn_arr_at(args, (double)i);
}

void scr_wc_args_drop(ScrWcArgs *a, size_t n) {
  for (size_t i = 0; i < n; i++) scr_dyn_release(a->v[i]);
}

/* AlgorithmIdentifier: an object, or a value converted to a DOMString. */
static bool scr_wc_algorithm_identifier(ScrDyn *value) {
  if (scr_wc_is_object(value)) return true;
  ScrStr *s = scr_wc_dom_string(value);
  if (!s) return false;
  scr_str_release(s);
  return true;
}

/* macImportKey: the usage check, the format, then normalizeKeyLength. */
static ScrDyn *scr_wc_import_hmac(const char *format, ScrBytes *data, const ScrWcJwk *jwk,
                                  const ScrWcAlgorithm *algorithm, bool extractable, long usages,
                                  bool *unsupported) {
  if (!scr_wc_check_usages("HMAC", usages)) return NULL;
  ScrBytes *bytes = NULL;
  if (strcmp(format, "raw") == 0 || strcmp(format, "raw-secret") == 0) {
    bytes = scr_bytes_retain(data);
  } else if (strcmp(format, "jwk") == 0) {
    bytes = scr_wc_jwk_secret(jwk, extractable, usages, "sig");
    if (!bytes) return NULL;
    char buf[16];
    const char *expected = scr_wc_jwk_alg("HMAC", algorithm->hash, 0, buf, sizeof buf);
    if (jwk->alg && expected && !scr_wc_str_is(jwk->alg, expected)) {
      scr_bytes_release(bytes);
      scr_throw_domex("DataError", "JWK \"alg\" does not match the requested algorithm");
      return NULL;
    }
  } else {
    *unsupported = true;
    return NULL;
  }
  ScrDyn *result = NULL;
  {
    ScrBytes *view = bytes;
    SCR_BYTES_SNAPSHOT(view);
    size_t len = (size_t)scr_bytes_byte_len(view);
    double length = (double)len * 8;
    if (len == 0) {
      scr_throw_domex("DataError", "Zero-length key is not supported");
      goto done;
    }
    if (algorithm->has_length) {
      if (scr_wc_bits_to_bytes(algorithm->length) != len) {
        scr_throw_domex("DataError", "Invalid key length");
        goto done;
      }
      length = algorithm->length;
    }
    result = scr_crypto_key_new(view->data, len, "HMAC", algorithm->hash, length,
                                (unsigned)usages, extractable);
    ScrCryptoKey *key = scr_crypto_key_of(result);
    scr_wc_truncate_bits(key->data, key->len, length);
  }
done:
  scr_bytes_release(bytes);
  return result;
}

/* aesImportKey: the usage check, then the format and the key length. */
static ScrDyn *scr_wc_import_aes(const char *format, ScrBytes *data, const ScrWcJwk *jwk,
                                 const char *name, bool extractable, long usages,
                                 bool *unsupported) {
  if (!scr_wc_check_usages(name, usages)) return NULL;
  ScrBytes *bytes = NULL;
  bool from_jwk = strcmp(format, "jwk") == 0;
  if (strcmp(format, "raw") == 0 || strcmp(format, "raw-secret") == 0) {
    bytes = scr_bytes_retain(data);
  } else if (from_jwk) {
    bytes = scr_wc_jwk_secret(jwk, extractable, usages, "enc");
    if (!bytes) return NULL;
  } else {
    *unsupported = true;
    return NULL;
  }
  ScrDyn *result = NULL;
  {
    ScrBytes *view = bytes;
    SCR_BYTES_SNAPSHOT(view);
    size_t len = (size_t)scr_bytes_byte_len(view);
    double length = (double)len * 8;
    if (length != 128 && length != 192 && length != 256) {
      scr_throw_domex("DataError", "Invalid key length");
      goto done;
    }
    char buf[16];
    if (from_jwk && jwk->alg &&
        !scr_wc_str_is(jwk->alg, scr_wc_jwk_alg(name, NULL, length, buf, sizeof buf))) {
      scr_throw_domex("DataError", "JWK \"alg\" does not match the requested algorithm");
      goto done;
    }
    result = scr_crypto_key_new(view->data, len, name, NULL, length, (unsigned)usages, extractable);
  }
done:
  scr_bytes_release(bytes);
  return result;
}

/* importGenericSecretKey (PBKDF2, HKDF): never extractable, derivation
 * usages only, raw bytes of any length. */
static ScrDyn *scr_wc_import_kdf(const char *format, ScrBytes *data, const char *name,
                                 bool extractable, long usages, bool *unsupported) {
  if (extractable) {
    char message[64];
    snprintf(message, sizeof message, "%s keys are not extractable", name);
    scr_throw_domex("SyntaxError", message);
    return NULL;
  }
  if (!scr_wc_check_usages(name, usages)) return NULL;
  if (strcmp(format, "raw") != 0 && strcmp(format, "raw-secret") != 0) {
    *unsupported = true;
    return NULL;
  }
  ScrBytes *view = data;
  SCR_BYTES_SNAPSHOT(view);
  return scr_crypto_key_new(view->data, (size_t)scr_bytes_byte_len(view), name, NULL, 0,
                            (unsigned)usages, false);
}

/* importKeySync over converted arguments: the per-algorithm import, the
 * unsupported-format NotSupportedError, then the empty-usages check. */
static ScrDyn *scr_wc_import_key_sync(const char *format, ScrBytes *data, const ScrWcJwk *jwk,
                                      const ScrWcAlgorithm *algorithm, bool extractable,
                                      long usages) {
  bool unsupported = false;
  ScrDyn *key;
  if (strcmp(algorithm->name, "HMAC") == 0)
    key = scr_wc_import_hmac(format, data, jwk, algorithm, extractable, usages, &unsupported);
  else if (scr_wc_is_aes(algorithm->name))
    key = scr_wc_import_aes(format, data, jwk, algorithm->name, extractable, usages, &unsupported);
  else if (scr_wc_is_kdf(algorithm->name))
    key = scr_wc_import_kdf(format, data, algorithm->name, extractable, usages, &unsupported);
  else {
    scr_wc_unsupported_algorithm("importKey", algorithm->name);
    return NULL;
  }
  if (unsupported) {
    char message[96];
    snprintf(message, sizeof message, "Unable to import %s using %s format", algorithm->name,
             format);
    scr_throw_domex("NotSupportedError", message);
    return NULL;
  }
  if (key && usages == 0) {
    scr_dyn_release(key);
    scr_throw_domex("SyntaxError", "Usages cannot be empty when importing a secret key.");
    return NULL;
  }
  return key;
}

/* importKey(format, keyData, algorithm, extractable, keyUsages): Node's
 * conversion order, then normalization and importKeySync. */
static ScrDyn *scr_wc_import(const ScrDyn *args) {
  static const char prefix[] = "Failed to execute 'importKey' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 5)) return NULL;
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 5);
  ScrDyn *result = NULL;
  ScrBytes *data = NULL;
  ScrWcJwk jwk;
  memset(&jwk, 0, sizeof jwk);
  const char *format = scr_wc_key_format(prefix, a.v[0]);
  if (!format) goto done;
  if (strcmp(format, "jwk") == 0) {
    if (!scr_wc_jwk_convert(prefix, a.v[1], &jwk)) goto done;
  } else {
    data = scr_wc_buffer_source(prefix, 1, a.v[1]);
    if (!data) goto done;
  }
  if (!scr_wc_algorithm_identifier(a.v[2])) goto done;
  bool extractable = scr_dyn_truthy(a.v[3]);
  long usages = scr_wc_key_usages(prefix, 4, a.v[4]);
  if (usages < 0) goto done;
  ScrWcAlgorithm algorithm;
  if (!scr_wc_normalize(a.v[2], scr_wc_import_names, SCR_WC_COUNT(scr_wc_import_names),
                        SCR_WC_OP_IMPORT, &algorithm))
    goto done;
  result = scr_wc_import_key_sync(format, data, &jwk, &algorithm, extractable, usages);
done:
  if (data) scr_bytes_release(data);
  scr_wc_jwk_drop(&jwk);
  scr_wc_args_drop(&a, 5);
  return result;
}

ScrPromise *scr_webcrypto_import_key(ScrDyn *args) {
  const char *asymmetric = scr_wc_asymmetric_name(args, 2);
  if (asymmetric) {
    return scr_wc_asymmetric ? scr_wc_asymmetric->import_key(args)
                             : scr_wc_asymmetric_missing("importKey", asymmetric);
  }
  ScrDyn *key = scr_wc_import(args);
  if (!key) return scr_wc_rejected();
  return scr_wc_resolved(key);
}

/* generateKey(algorithm, extractable, keyUsages) for HMAC and AES keys:
 * random bytes of the requested length (an HMAC key defaults to its
 * hash's block size; a length that is not a whole number of bytes clears
 * the final byte's unused low bits). ECDSA, Ed25519, RSASSA-PKCS1-v1_5 and
 * RSA-PSS key pairs generate in scr_webcrypto_pki.c. */
ScrPromise *scr_webcrypto_generate_key(ScrDyn *args) {
  const char *asymmetric = scr_wc_asymmetric_name(args, 0);
  if (asymmetric) {
    return scr_wc_asymmetric ? scr_wc_asymmetric->generate_key(args)
                             : scr_wc_asymmetric_missing("generateKey", asymmetric);
  }
  static const char prefix[] = "Failed to execute 'generateKey' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 3)) return scr_wc_rejected();
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 3);
  ScrDyn *key = NULL;
  if (!scr_wc_algorithm_identifier(a.v[0])) goto done;
  bool extractable = scr_dyn_truthy(a.v[1]);
  long usages = scr_wc_key_usages(prefix, 2, a.v[2]);
  if (usages < 0) goto done;
  ScrWcAlgorithm algorithm;
  if (!scr_wc_normalize(a.v[0], scr_wc_key_names, SCR_WC_COUNT(scr_wc_key_names),
                        SCR_WC_OP_GENERATE, &algorithm))
    goto done;
  bool hmac = strcmp(algorithm.name, "HMAC") == 0;
  if (!hmac && !scr_wc_is_aes(algorithm.name)) {
    scr_wc_unsupported_algorithm("generateKey", algorithm.name);
    goto done;
  }
  if (!scr_wc_check_usages(algorithm.name, usages)) goto done;
  if (usages == 0) {
    scr_throw_domex("SyntaxError", "Usages cannot be empty when creating a key.");
    goto done;
  }
  double length = algorithm.has_length ? algorithm.length
                  : strcmp(algorithm.hash, "SHA-384") == 0 || strcmp(algorithm.hash, "SHA-512") == 0
                      ? 1024
                      : 512;
  size_t len = scr_wc_bits_to_bytes(length);
  unsigned char *bytes = malloc(len ? len : 1);
  if (!bytes) scr_trap("scriptc: out of memory\n");
  arc4random_buf(bytes, len);
  scr_wc_truncate_bits(bytes, len, length);
  key = scr_crypto_key_new(bytes, len, algorithm.name, hmac ? algorithm.hash : NULL, length,
                           (unsigned)usages, extractable);
  volatile unsigned char *wipe = bytes;
  for (size_t i = 0; i < len; i++) wipe[i] = 0;
  free(bytes);
done:
  scr_wc_args_drop(&a, 3);
  if (!key) return scr_wc_rejected();
  return scr_wc_deferred(key);
}

/* exportKeySync's checks for a secret key: false with Node's error
 * pending. raw, raw-secret and jwk are the formats a secret key exports. */
static bool scr_wc_exportable(const char *format, const ScrCryptoKey *key) {
  if (scr_wc_is_kdf(key->name)) {
    char message[64];
    snprintf(message, sizeof message, "%s key export is not supported", key->name);
    scr_throw_domex("NotSupportedError", message);
    return false;
  }
  if (!key->extractable) {
    scr_throw_domex("InvalidAccessError", "key is not extractable");
    return false;
  }
  if (strcmp(format, "raw") != 0 && strcmp(format, "raw-secret") != 0 &&
      strcmp(format, "jwk") != 0) {
    char message[96];
    snprintf(message, sizeof message, "Unable to export %s secret key using %s format", key->name,
             format);
    scr_throw_domex("NotSupportedError", message);
    return false;
  }
  return true;
}

/* The key bytes as a fresh u8 view (+1). */
static ScrBytes *scr_wc_key_bytes(const ScrCryptoKey *key) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)key->len);
  if (key->len) memcpy(bytes->data, key->data, key->len);
  return bytes;
}

/* A JWK's k: the key bytes in unpadded base64url (+1). */
static ScrStr *scr_wc_jwk_k(const ScrCryptoKey *key) {
  ScrBytes *bytes = scr_wc_key_bytes(key);
  ScrStr *encoding = scr_str_new("base64url", 9);
  ScrStr *k = scr_bytes_to_str(bytes, encoding);
  scr_str_release(encoding);
  scr_bytes_release(bytes);
  return k;
}

/* exportKeySync for secret keys: raw and raw-secret answer an ArrayBuffer
 * of the key bytes, jwk an object { key_ops, ext, alg, kty, k }. An ECDSA,
 * Ed25519 or RSA key sets *asymmetric after the format check instead
 * (scr_webcrypto_pki.c exports it). */
static ScrDyn *scr_wc_export(const ScrDyn *args, bool *asymmetric) {
  static const char prefix[] = "Failed to execute 'exportKey' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 2)) return NULL;
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 2);
  ScrDyn *result = NULL;
  const char *format = scr_wc_key_format(prefix, a.v[0]);
  if (!format) goto done;
  ScrCryptoKey *key = scr_crypto_key_of(a.v[1]);
  if (!key && scr_wc_asymmetric && scr_wc_asymmetric->is_key(a.v[1])) {
    *asymmetric = true;
    goto done;
  }
  if (!key) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 2nd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  if (!scr_wc_exportable(format, key)) goto done;
  if (strcmp(format, "jwk") == 0) {
    char buf[16];
    const char *alg = scr_wc_jwk_alg(key->name, key->hash, key->length, buf, sizeof buf);
    ScrStr *k = scr_wc_jwk_k(key);
    result = scr_dyn_new_obj();
    scr_dyn_obj_set(result, "key_ops", 7, scr_wc_usage_array(key->usages));
    scr_dyn_obj_set(result, "ext", 3, scr_dyn_new_bool(key->extractable));
    if (alg) scr_dyn_obj_set(result, "alg", 3, scr_wc_cstr(alg));
    scr_dyn_obj_set(result, "kty", 3, scr_wc_cstr("oct"));
    scr_dyn_obj_set(result, "k", 1, scr_dyn_new_str(k));
    scr_str_release(k);
  } else {
    ScrBytes *bytes = scr_wc_key_bytes(key);
    result = scr_array_buffer_from_bytes(bytes);
    scr_bytes_release(bytes);
  }
done:
  scr_wc_args_drop(&a, 2);
  return result;
}

ScrPromise *scr_webcrypto_export_key(ScrDyn *args) {
  bool asymmetric = false;
  ScrDyn *result = scr_wc_export(args, &asymmetric);
  if (asymmetric) return scr_wc_asymmetric->export_key(args);
  if (!result) return scr_wc_rejected();
  return scr_wc_resolved(result);
}

/* sign(algorithm, key, data) / verify(algorithm, key, signature, data):
 * the HMAC over `data`, or NULL with the error pending. *mac_len is the
 * digest length. */
static bool scr_wc_sign_verify(const ScrDyn *args, bool verify, unsigned char mac[64],
                               size_t *mac_len, ScrBytes **signature) {
  const char *prefix = verify ? "Failed to execute 'verify' on 'SubtleCrypto'"
                              : "Failed to execute 'sign' on 'SubtleCrypto'";
  const char *method = verify ? "verify" : "sign";
  size_t n = verify ? 4 : 3;
  if (!scr_wc_required(prefix, args, n)) return false;
  ScrWcArgs a;
  scr_wc_args_take(&a, args, n);
  bool ok = false;
  ScrBytes *data = NULL;
  if (!scr_wc_is_object(a.v[0])) {
    ScrStr *s = scr_wc_dom_string(a.v[0]);
    if (!s) goto done;
    scr_str_release(s);
  }
  ScrCryptoKey *key = scr_crypto_key_of(a.v[1]);
  bool asymmetric_key = !key && scr_wc_asymmetric && scr_wc_asymmetric->is_key(a.v[1]);
  if (!key && !asymmetric_key) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 2nd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  if (verify) {
    *signature = scr_wc_buffer_source(prefix, 2, a.v[2]);
    if (!*signature) goto done;
  }
  data = scr_wc_buffer_source(prefix, verify ? 3 : 2, a.v[verify ? 3 : 2]);
  if (!data) goto done;
  ScrWcAlgorithm algorithm;
  if (!scr_wc_normalize(a.v[0], scr_wc_sign_names, SCR_WC_COUNT(scr_wc_sign_names),
                        SCR_WC_OP_SIGN, &algorithm))
    goto done;
  if (strcmp(algorithm.name, "HMAC") != 0) {
    scr_wc_unsupported_algorithm(method, algorithm.name);
    goto done;
  }
  if (asymmetric_key || strcmp(key->name, algorithm.name) != 0) {
    scr_throw_domex("InvalidAccessError", "Key algorithm mismatch");
    goto done;
  }
  if (!(key->usages & (verify ? SCR_WC_USAGE_VERIFY : SCR_WC_USAGE_SIGN))) {
    char message[64];
    snprintf(message, sizeof message, "Unable to use this key to %s", method);
    scr_throw_domex("InvalidAccessError", message);
    goto done;
  }
  {
    ScrBytes *view = data;
    SCR_BYTES_SNAPSHOT(view);
    *mac_len = scr_crypto_hmac_raw(scr_wc_native_hash(key->hash), key->data, key->len, view->data,
                                   (size_t)scr_bytes_byte_len(view), mac);
  }
  ok = true;
done:
  if (data) scr_bytes_release(data);
  scr_wc_args_drop(&a, n);
  return ok;
}

ScrPromise *scr_webcrypto_sign(ScrDyn *args) {
  const char *asymmetric = scr_wc_asymmetric_name(args, 0);
  if (asymmetric) {
    return scr_wc_asymmetric ? scr_wc_asymmetric->sign(args)
                             : scr_wc_asymmetric_missing("sign", asymmetric);
  }
  unsigned char mac[64];
  size_t mac_len = 0;
  if (!scr_wc_sign_verify(args, false, mac, &mac_len, NULL)) return scr_wc_rejected();
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)mac_len);
  memcpy(out->data, mac, mac_len);
  ScrPromise *p = scr_promise_new();
  scr_crypto_defer_bytes(out, NULL, scr_crypto_promise_callback(p),
                         scr_crypto_promise_settle_array_buffer);
  return p;
}

/* The verify result's adapter: the deferred value is a dyn boolean. */
static void scr_wc_settle_verified(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  (void)error;
  ScrPromise *p;
  memcpy(&p, &cb->caps[0]->slot, sizeof p);
  ScrDyn *verified = (ScrDyn *)value;
  scr_promise_fulfill_bool(p, scr_dyn_truthy(verified));
  scr_dyn_release(verified);
}

ScrPromise *scr_webcrypto_verify(ScrDyn *args) {
  const char *asymmetric = scr_wc_asymmetric_name(args, 0);
  if (asymmetric) {
    return scr_wc_asymmetric ? scr_wc_asymmetric->verify(args)
                             : scr_wc_asymmetric_missing("verify", asymmetric);
  }
  unsigned char mac[64];
  size_t mac_len = 0;
  ScrBytes *signature = NULL;
  if (!scr_wc_sign_verify(args, true, mac, &mac_len, &signature)) {
    if (signature) scr_bytes_release(signature);
    return scr_wc_rejected();
  }
  bool equal;
  {
    ScrBytes *view = signature;
    SCR_BYTES_SNAPSHOT(view);
    /* A signature of another length is simply not valid; equal lengths
     * compare in constant time. */
    size_t sig_len = (size_t)scr_bytes_byte_len(view);
    equal = sig_len == mac_len;
    unsigned char diff = 0;
    for (size_t i = 0; equal && i < mac_len; i++) diff |= (unsigned char)(view->data[i] ^ mac[i]);
    equal = equal && diff == 0;
  }
  scr_bytes_release(signature);
  ScrPromise *p = scr_promise_new();
  scr_crypto_defer_dyn(scr_dyn_new_bool(equal), NULL, scr_crypto_promise_callback(p),
                       scr_wc_settle_verified);
  return p;
}

/* digest(algorithm, data). */
ScrPromise *scr_webcrypto_digest(ScrDyn *args) {
  static const char prefix[] = "Failed to execute 'digest' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 2)) return scr_wc_rejected();
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 2);
  ScrBytes *data = NULL;
  ScrBytes *out = NULL;
  if (!scr_wc_is_object(a.v[0])) {
    ScrStr *s = scr_wc_dom_string(a.v[0]);
    if (!s) goto done;
    scr_str_release(s);
  }
  data = scr_wc_buffer_source(prefix, 1, a.v[1]);
  if (!data) goto done;
  const char *hash = scr_wc_digest_algorithm(a.v[0], "digest");
  if (!hash) goto done;
  {
    ScrBytes *view = data;
    SCR_BYTES_SNAPSHOT(view);
    unsigned char digest[64];
    size_t len = scr_crypto_digest_raw(scr_wc_native_hash(hash), view->data,
                                       (size_t)scr_bytes_byte_len(view), digest);
    out = scr_bytes_new(SCR_BYTES_U8, (double)len);
    memcpy(out->data, digest, len);
  }
done:
  if (data) scr_bytes_release(data);
  scr_wc_args_drop(&a, 2);
  if (!out) return scr_wc_rejected();
  ScrPromise *p = scr_promise_new();
  scr_crypto_defer_bytes(out, NULL, scr_crypto_promise_callback(p),
                         scr_crypto_promise_settle_array_buffer);
  return p;
}

/* ── encrypt and decrypt ──────────────────────────────────────────────
 * The WebCrypto half of encrypt and decrypt: argument conversion, the
 * AesCbcParams, AesCtrParams and AeadParams dictionaries, and the key
 * checks. The cipher itself runs in scr_webcrypto_aes.c, which links
 * with the mbedTLS archive and passes it in. */
static const char *const scr_wc_cipher_names[] = {
    "AES-CBC", "AES-CTR", "AES-GCM", "AES-OCB", "ChaCha20-Poly1305", "RSA-OAEP",
};

/* Node's limit on the data, IV and additional data (kMaxBufferLength). */
static const double scr_wc_max_buffer = 2147483647.0;

/* A BufferSource member of an algorithm dictionary: false with the error
 * pending; *out stays NULL when an optional member is absent. */
static bool scr_wc_member_buffer(const ScrDyn *dict, const char *dict_name, const char *key,
                                 bool required, ScrBytes **out) {
  ScrDyn *value = scr_wc_member(dict, key);
  bool ok = true;
  if (value->kind == SCR_DYN_UNDEF) {
    if (required) {
      scr_wc_missing_member(dict_name, key);
      ok = false;
    }
  } else {
    ScrDyn *plain = scr_wc_plain(value);
    if (!plain) ok = false;
    else if (plain->kind == SCR_DYN_BYTES || scr_array_buffer_is(plain)) {
      *out = scr_bytes_buffer_source(plain);
    } else {
      scr_wc_type_error("ERR_INVALID_ARG_TYPE",
                        "%s: %s in passed algorithm is not instance of ArrayBuffer, Buffer, "
                        "TypedArray, or DataView.",
                        scr_wc_normalize_prefix, key);
      ok = false;
    }
    if (plain) scr_dyn_release(plain);
  }
  scr_dyn_release(value);
  return ok;
}

/* validateByteLength / validateMaxBufferLength over a converted member. */
static bool scr_wc_exact_length(const ScrBytes *bytes, const char *name, double length) {
  if (scr_bytes_byte_len(bytes) == length) return true;
  char message[96];
  snprintf(message, sizeof message, "%s must contain exactly %.0f bytes", name, length);
  scr_throw_domex("OperationError", message);
  return false;
}

static bool scr_wc_max_length(const ScrBytes *bytes, const char *name) {
  if (scr_bytes_byte_len(bytes) <= scr_wc_max_buffer) return true;
  char message[96];
  snprintf(message, sizeof message, "%s must be at most %.0f bytes", name, scr_wc_max_buffer);
  scr_throw_domex("OperationError", message);
  return false;
}

typedef struct {
  ScrBytes *iv; /* the IV or the CTR counter block */
  ScrBytes *aad;
  double tag_bits;
  double counter_bits;
} ScrWcCipherParams;

static void scr_wc_cipher_params_drop(ScrWcCipherParams *params) {
  if (params->iv) scr_bytes_release(params->iv);
  if (params->aad) scr_bytes_release(params->aad);
  params->iv = params->aad = NULL;
}

/* An optional or required [EnforceRange] octet member: false with the
 * error pending; *present says whether it was given. */
static bool scr_wc_member_octet(const ScrDyn *dict, const char *dict_name, const char *key,
                                bool required, bool *present, double *out) {
  ScrDyn *value = scr_wc_member(dict, key);
  bool ok = true;
  *present = value->kind != SCR_DYN_UNDEF;
  if (!*present) {
    if (required) {
      scr_wc_missing_member(dict_name, key);
      ok = false;
    }
  } else {
    char context[48];
    snprintf(context, sizeof context, "%s in passed algorithm", key);
    ok = scr_wc_enforce_range(scr_wc_normalize_prefix, context, value, 255, out);
  }
  scr_dyn_release(value);
  return ok;
}

/* normalizeAlgorithm(algorithm, 'encrypt' / 'decrypt'): the canonical
 * name and the AES dictionaries' members, in Web IDL member order with
 * each member's validator right after its conversion. */
static const char *scr_wc_normalize_cipher(ScrDyn *identifier, const char *method,
                                           ScrWcCipherParams *params) {
  memset(params, 0, sizeof *params);
  params->tag_bits = 128;
  ScrStr *name = scr_wc_algorithm_name(identifier, "Algorithm");
  if (!name) return NULL;
  const char *canonical =
      scr_wc_lookup(scr_wc_cipher_names, SCR_WC_COUNT(scr_wc_cipher_names), name);
  scr_str_release(name);
  if (!canonical) {
    scr_throw_domex("NotSupportedError", "Unrecognized algorithm name");
    return NULL;
  }
  if (!scr_wc_is_aes(canonical)) {
    scr_wc_unsupported_algorithm(method, canonical);
    return NULL;
  }
  ScrDyn *dict = scr_wc_is_object(identifier) ? scr_wc_plain(identifier)
                                              : scr_dyn_retain(scr_dyn_undefined());
  if (!dict) return NULL;
  bool ok = true;
  bool present;
  if (strcmp(canonical, "AES-CBC") == 0) {
    ok = scr_wc_member_buffer(dict, "AesCbcParams", "iv", true, &params->iv) &&
         scr_wc_exact_length(params->iv, "algorithm.iv", 16);
  } else if (strcmp(canonical, "AES-CTR") == 0) {
    ok = scr_wc_member_buffer(dict, "AesCtrParams", "counter", true, &params->iv) &&
         scr_wc_exact_length(params->iv, "algorithm.counter", 16) &&
         scr_wc_member_octet(dict, "AesCtrParams", "length", true, &present,
                             &params->counter_bits);
    if (ok && (params->counter_bits == 0 || params->counter_bits > 128)) {
      scr_throw_domex("OperationError", "AES-CTR algorithm.length must be between 1 and 128");
      ok = false;
    }
  } else {
    ok = scr_wc_member_buffer(dict, "AeadParams", "additionalData", false, &params->aad) &&
         (!params->aad || scr_wc_max_length(params->aad, "algorithm.additionalData")) &&
         scr_wc_member_buffer(dict, "AeadParams", "iv", true, &params->iv) &&
         scr_wc_max_length(params->iv, "algorithm.iv") &&
         scr_wc_member_octet(dict, "AeadParams", "tagLength", false, &present, &params->tag_bits);
    if (ok && !present) params->tag_bits = 128;
    double t = params->tag_bits;
    if (ok && t != 32 && t != 64 && t != 96 && t != 104 && t != 112 && t != 120 && t != 128) {
      char message[64];
      snprintf(message, sizeof message, "%.0f is not a valid AES-GCM tag length", t);
      scr_throw_domex("OperationError", message);
      ok = false;
    }
  }
  scr_dyn_release(dict);
  if (!ok) {
    scr_wc_cipher_params_drop(params);
    return NULL;
  }
  return canonical;
}

static void *scr_wc_caught_retain(void *c) { return scr_caught_retain(c); }
static void scr_wc_caught_release(void *c) { scr_caught_release(c); }

static void scr_wc_settle_rethrow(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  (void)error;
  (void)value;
  ScrPromise *p;
  ScrCaught *caught;
  memcpy(&p, &cb->caps[0]->slot, sizeof p);
  memcpy(&caught, &cb->caps[1]->slot, sizeof caught);
  scr_rethrow(caught);
  scr_promise_reject_pending(p);
}

/* A job failure: a fresh promise that rejects with the pending exception
 * on a later loop turn, as Node's job promises do (+1). */
static ScrPromise *scr_wc_deferred_rejection(void) {
  ScrPromise *p = scr_promise_new();
  ScrClosure *cb = scr_closure_new(NULL, 2);
  cb->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_promise_retain(p));
  cb->caps[1] = scr_box_new_obj(scr_wc_caught_retain, scr_wc_caught_release, scr_caught_trace_v);
  scr_box_set_ref(cb->caps[1], scr_exc_take());
  scr_crypto_defer_bytes(NULL, NULL, cb, scr_wc_settle_rethrow);
  return p;
}

/* A promise that fulfills with an ArrayBuffer of `bytes` (moves) on a
 * later loop turn. */
static ScrPromise *scr_wc_deferred_buffer(ScrBytes *bytes) {
  ScrPromise *p = scr_promise_new();
  scr_crypto_defer_bytes(bytes, NULL, scr_crypto_promise_callback(p),
                         scr_crypto_promise_settle_array_buffer);
  return p;
}

/* The cipher over `data` (cipherOrWrap's job): +1 output bytes, or NULL
 * with Node's OperationError pending. */
static ScrBytes *scr_wc_cipher_bytes(ScrWebCryptoAesFn aes, const char *name, bool decrypt,
                                     const ScrCryptoKey *key, ScrWcCipherParams *params,
                                     ScrBytes *data) {
  if (!params->iv) params->iv = scr_bytes_new(SCR_BYTES_U8, 0);
  if (!params->aad) params->aad = scr_bytes_new(SCR_BYTES_U8, 0);
  ScrBytes *view = data;
  SCR_BYTES_SNAPSHOT(view);
  ScrBytes *iv = params->iv;
  SCR_BYTES_SNAPSHOT(iv);
  ScrBytes *aad = params->aad;
  SCR_BYTES_SNAPSHOT(aad);
  ScrWebCryptoAesParams run = {
      .iv = iv->data,
      .iv_len = (size_t)scr_bytes_byte_len(iv),
      .aad = aad->data,
      .aad_len = (size_t)scr_bytes_byte_len(aad),
      .tag_len = (size_t)(params->tag_bits / 8),
      .counter_bits = (unsigned)params->counter_bits,
  };
  ScrBytes *out =
      aes(name, decrypt, key->data, key->len, &run, view->data, (size_t)scr_bytes_byte_len(view));
  if (!out)
    scr_throw_domex("OperationError", "The operation failed for an operation-specific reason");
  return out;
}

/* The cipher's promise: an ArrayBuffer of the output, or the job's
 * OperationError, on a later loop turn. */
static ScrPromise *scr_wc_run_cipher(ScrWebCryptoAesFn aes, const char *name, bool decrypt,
                                     const ScrCryptoKey *key, ScrWcCipherParams *params,
                                     ScrBytes *data) {
  ScrBytes *out = scr_wc_cipher_bytes(aes, name, decrypt, key, params, data);
  return out ? scr_wc_deferred_buffer(out) : scr_wc_deferred_rejection();
}

ScrPromise *scr_webcrypto_cipher(ScrDyn *args, bool decrypt, ScrWebCryptoAesFn aes) {
  const char *method = decrypt ? "decrypt" : "encrypt";
  const char *prefix = decrypt ? "Failed to execute 'decrypt' on 'SubtleCrypto'"
                               : "Failed to execute 'encrypt' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 3)) return scr_wc_rejected();
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 3);
  ScrBytes *data = NULL;
  ScrWcCipherParams params;
  memset(&params, 0, sizeof params);
  ScrPromise *result = NULL;
  if (!scr_wc_algorithm_identifier(a.v[0])) goto done;
  ScrCryptoKey *key = scr_crypto_key_of(a.v[1]);
  /* an ECDSA, Ed25519 or RSA key (scr_webcrypto_pki.c) is no cipher key */
  bool asymmetric_key = !key && scr_wc_asymmetric && scr_wc_asymmetric->is_key(a.v[1]);
  if (!key && !asymmetric_key) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 2nd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  data = scr_wc_buffer_source(prefix, 2, a.v[2]);
  if (!data) goto done;
  const char *name = scr_wc_normalize_cipher(a.v[0], method, &params);
  if (!name) goto done;
  if (asymmetric_key || strcmp(key->name, name) != 0) {
    scr_throw_domex("InvalidAccessError", "Key algorithm mismatch");
    goto done;
  }
  if (!(key->usages & (decrypt ? SCR_WC_USAGE_DECRYPT : SCR_WC_USAGE_ENCRYPT))) {
    char message[64];
    snprintf(message, sizeof message, "Unable to use this key to %s", method);
    scr_throw_domex("InvalidAccessError", message);
    goto done;
  }
  if (!scr_wc_max_length(data, "data")) goto done;
  result = scr_wc_run_cipher(aes, name, decrypt, key, &params, data);
done:
  if (data) scr_bytes_release(data);
  scr_wc_cipher_params_drop(&params);
  scr_wc_args_drop(&a, 3);
  return result ? result : scr_wc_rejected();
}

/* ── wrapKey and unwrapKey ────────────────────────────────────────────
 * wrapKey is exportKey followed by encrypt (or AES-KW's wrap), and
 * unwrapKey is decrypt (or AES-KW's unwrap) followed by importKey, as in
 * Node's webcrypto.js. The cipher runs in scr_webcrypto_aes.c. */

/* normalizeAlgorithm(algorithm, 'wrapKey' / 'unwrapKey'), falling back to
 * the 'encrypt' / 'decrypt' registry as Node does: AES-KW (no
 * parameters), or the AES ciphers with their dictionaries. */
static const char *scr_wc_normalize_wrap(ScrDyn *identifier, const char *method,
                                         ScrWcCipherParams *params) {
  memset(params, 0, sizeof *params);
  ScrStr *name = scr_wc_algorithm_name(identifier, "Algorithm");
  if (!name) return NULL;
  bool kw = scr_wc_ascii_ieq(name, "AES-KW");
  scr_str_release(name);
  if (kw) return "AES-KW";
  return scr_wc_normalize_cipher(identifier, method, params);
}

/* The bytes wrapKey encrypts (+1): the raw key, or the JWK's JSON text,
 * padded with spaces to a multiple of 8 bytes for AES-KW. */
static ScrBytes *scr_wc_wrap_payload(const char *format, const ScrCryptoKey *key, bool kw) {
  if (strcmp(format, "jwk") != 0) return scr_wc_key_bytes(key);
  char buf[16];
  const char *alg = scr_wc_jwk_alg(key->name, key->hash, key->length, buf, sizeof buf);
  ScrStr *k = scr_wc_jwk_k(key);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "{\"key_ops\":[");
  bool first = true;
  for (size_t i = 0; i < SCR_WC_COUNT(scr_wc_usages); i++) {
    if (!(key->usages & (1u << i))) continue;
    if (!first) scr_jb_puts(&b, ",");
    first = false;
    scr_jb_puts(&b, "\"");
    scr_jb_puts(&b, scr_wc_usages[i]);
    scr_jb_puts(&b, "\"");
  }
  scr_jb_puts(&b, key->extractable ? "],\"ext\":true" : "],\"ext\":false");
  if (alg) {
    scr_jb_puts(&b, ",\"alg\":\"");
    scr_jb_puts(&b, alg);
    scr_jb_puts(&b, "\"");
  }
  scr_jb_puts(&b, ",\"kty\":\"oct\",\"k\":\"");
  ScrStr *json_prefix = scr_jb_finish(&b);
  size_t len = json_prefix->len + k->len + 2;
  size_t padded = kw && len % 8 ? len + 8 - len % 8 : len;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)padded);
  memcpy(out->data, json_prefix->data, json_prefix->len);
  memcpy(out->data + json_prefix->len, k->data, k->len);
  memcpy(out->data + json_prefix->len + k->len, "\"}", 2);
  memset(out->data + len, ' ', padded - len);
  scr_str_release(json_prefix);
  scr_str_release(k);
  return out;
}

/* wrapKey(format, key, wrappingKey, wrapAlgorithm). */
ScrPromise *scr_webcrypto_wrap(ScrDyn *args, ScrWebCryptoAesFn aes) {
  static const char prefix[] = "Failed to execute 'wrapKey' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 4)) return scr_wc_rejected();
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 4);
  ScrWcCipherParams params;
  memset(&params, 0, sizeof params);
  ScrBytes *payload = NULL;
  ScrPromise *result = NULL;
  const char *format = scr_wc_key_format(prefix, a.v[0]);
  if (!format) goto done;
  ScrCryptoKey *key = scr_crypto_key_of(a.v[1]);
  if (!key && !scr_wc_is_asymmetric_key(a.v[1])) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 2nd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  ScrCryptoKey *wrapping = scr_crypto_key_of(a.v[2]);
  if (!wrapping && !scr_wc_is_asymmetric_key(a.v[2])) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 3rd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  if (!scr_wc_algorithm_identifier(a.v[3])) goto done;
  const char *name = scr_wc_normalize_wrap(a.v[3], "wrapKey", &params);
  if (!name) goto done;
  /* An ECDSA, Ed25519 or RSA key never has an AES algorithm. */
  if (!wrapping || strcmp(wrapping->name, name) != 0) {
    scr_throw_domex("InvalidAccessError", "Key algorithm mismatch");
    goto done;
  }
  if (!(wrapping->usages & SCR_WC_USAGE_WRAP_KEY)) {
    scr_throw_domex("InvalidAccessError", "Unable to use this key to wrapKey");
    goto done;
  }
  if (!key) {
    scr_wc_unsupported("wrapKey", "an ECDSA, Ed25519 or RSA key");
    goto done;
  }
  if (!scr_wc_exportable(format, key)) goto done;
  payload = scr_wc_wrap_payload(format, key, strcmp(name, "AES-KW") == 0);
  result = scr_wc_run_cipher(aes, name, false, wrapping, &params, payload);
done:
  if (payload) scr_bytes_release(payload);
  scr_wc_cipher_params_drop(&params);
  scr_wc_args_drop(&a, 4);
  return result ? result : scr_wc_rejected();
}

/* parseJwk: the unwrapped bytes as UTF-8 JSON converted to a JsonWebKey
 * with a kty member, or DataError "Invalid wrapped JWK key". */
static bool scr_wc_parse_wrapped_jwk(ScrBytes *bytes, ScrWcJwk *jwk) {
  static const char prefix[] = "Failed to execute 'unwrapKey' on 'SubtleCrypto'";
  ScrStr *text = scr_text_decode_options(bytes, true, false);
  ScrDyn *parsed = text ? scr_json_parse(text) : NULL;
  if (text) scr_str_release(text);
  bool ok = parsed && scr_wc_is_object(parsed) && scr_wc_jwk_convert(prefix, parsed, jwk) && jwk->kty;
  if (parsed) scr_dyn_release(parsed);
  if (!ok) {
    if (scr_exc_pending()) scr_caught_release(scr_exc_take());
    scr_wc_jwk_drop(jwk);
    scr_throw_domex("DataError", "Invalid wrapped JWK key");
  }
  return ok;
}

/* unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm,
 * unwrappedKeyAlgorithm, extractable, keyUsages): argument and key errors
 * reject at once; the cipher's failure and the import's errors reject on
 * a later loop turn, after Node's job. */
ScrPromise *scr_webcrypto_unwrap(ScrDyn *args, ScrWebCryptoAesFn aes) {
  static const char prefix[] = "Failed to execute 'unwrapKey' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 7)) return scr_wc_rejected();
  ScrDyn *v[7];
  for (size_t i = 0; i < 7; i++) v[i] = scr_dyn_arr_at(args, (double)i);
  ScrWcCipherParams params;
  memset(&params, 0, sizeof params);
  ScrBytes *wrapped = NULL;
  ScrPromise *result = NULL;
  const char *format = scr_wc_key_format(prefix, v[0]);
  if (!format) goto done;
  wrapped = scr_wc_buffer_source(prefix, 1, v[1]);
  if (!wrapped) goto done;
  ScrCryptoKey *unwrapping = scr_crypto_key_of(v[2]);
  if (!unwrapping && !scr_wc_is_asymmetric_key(v[2])) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 3rd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  if (!scr_wc_algorithm_identifier(v[3]) || !scr_wc_algorithm_identifier(v[4])) goto done;
  bool extractable = scr_dyn_truthy(v[5]);
  long usages = scr_wc_key_usages(prefix, 6, v[6]);
  if (usages < 0) goto done;
  const char *name = scr_wc_normalize_wrap(v[3], "unwrapKey", &params);
  if (!name) goto done;
  ScrWcAlgorithm imported;
  if (!scr_wc_normalize(v[4], scr_wc_import_names, SCR_WC_COUNT(scr_wc_import_names),
                        SCR_WC_OP_IMPORT, &imported))
    goto done;
  if (!unwrapping || strcmp(unwrapping->name, name) != 0) {
    scr_throw_domex("InvalidAccessError", "Key algorithm mismatch");
    goto done;
  }
  if (!(unwrapping->usages & SCR_WC_USAGE_UNWRAP_KEY)) {
    scr_throw_domex("InvalidAccessError", "Unable to use this key to unwrapKey");
    goto done;
  }
  if (scr_wc_is_asymmetric_algorithm(imported.name)) {
    scr_wc_unsupported_algorithm("unwrapKey", imported.name);
    goto done;
  }
  if (!scr_wc_max_length(wrapped, "data")) goto done;
  ScrBytes *bytes = scr_wc_cipher_bytes(aes, name, true, unwrapping, &params, wrapped);
  if (!bytes) {
    result = scr_wc_deferred_rejection();
    goto done;
  }
  ScrWcJwk jwk;
  memset(&jwk, 0, sizeof jwk);
  ScrDyn *key = NULL;
  if (strcmp(format, "jwk") != 0 || scr_wc_parse_wrapped_jwk(bytes, &jwk))
    key = scr_wc_import_key_sync(format, bytes, &jwk, &imported, extractable, usages);
  scr_wc_jwk_drop(&jwk);
  scr_bytes_release(bytes);
  result = key ? scr_wc_deferred(key) : scr_wc_deferred_rejection();
done:
  if (wrapped) scr_bytes_release(wrapped);
  scr_wc_cipher_params_drop(&params);
  for (size_t i = 0; i < 7; i++) scr_dyn_release(v[i]);
  return result ? result : scr_wc_rejected();
}

/* ── deriveBits and deriveKey ─────────────────────────────────────────
 * PBKDF2 and HKDF over node:crypto's KDF core (scr_crypto_pbkdf2 and
 * scr_crypto_hkdf_bytes in scr_lib.c), with Node's Pbkdf2Params and
 * HkdfParams dictionaries, length rules and key checks. deriveKey derives
 * the bits the derived key type needs and imports them as a raw-secret
 * key of that type. */
static const char *const scr_wc_derive_names[] = {
    "Argon2d", "Argon2i", "Argon2id", "ECDH", "HKDF", "PBKDF2", "X25519", "X448",
};
/* The algorithms 'get key length' registers. */
static const char *const scr_wc_length_names[] = {
    "AES-CBC",  "AES-CTR",  "AES-GCM", "AES-KW",  "AES-OCB", "Argon2d", "Argon2i",
    "Argon2id", "ChaCha20-Poly1305",   "HKDF",    "HMAC",    "KMAC128", "KMAC256", "PBKDF2",
};

typedef struct {
  const char *name;
  const char *hash;
  double iterations;
  ScrBytes *salt;
  ScrBytes *info;
} ScrWcKdfParams;

static void scr_wc_kdf_params_drop(ScrWcKdfParams *params) {
  if (params->salt) scr_bytes_release(params->salt);
  if (params->info) scr_bytes_release(params->info);
  params->salt = params->info = NULL;
}

/* A HashAlgorithmIdentifier member with ensureSHA (`dict` names the
 * dictionary); *hash is the member value for the later digest
 * normalization (+1). */
static bool scr_wc_member_hash(const ScrDyn *dict, const char *dict_name, ScrDyn **hash) {
  ScrDyn *value = scr_wc_member(dict, "hash");
  if (value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    scr_wc_missing_member(dict_name, "hash");
    return false;
  }
  ScrStr *name = NULL;
  bool ok = true;
  if (scr_wc_is_object(value)) {
    ScrDyn *plain = scr_wc_plain(value);
    ScrDyn *member = plain ? scr_wc_member(plain, "name") : NULL;
    if (plain) scr_dyn_release(plain);
    if (!member) ok = false;
    else {
      if (member->kind == SCR_DYN_STR) name = scr_str_retain(member->v.str);
      scr_dyn_release(member);
    }
    *hash = scr_dyn_retain(value);
  } else {
    name = scr_wc_dom_string(value);
    if (!name) ok = false;
    *hash = name ? scr_dyn_new_str(name) : NULL;
  }
  scr_dyn_release(value);
  bool sha = name && name->len >= 3 && (name->data[0] | 32) == 's' &&
             (name->data[1] | 32) == 'h' && (name->data[2] | 32) == 'a';
  if (name) scr_str_release(name);
  if (ok && !sha) {
    char message[96];
    snprintf(message, sizeof message, "Only SHA hashes are supported in %s", dict_name);
    scr_throw_domex("NotSupportedError", message);
    ok = false;
  }
  if (!ok && *hash) {
    scr_dyn_release(*hash);
    *hash = NULL;
  }
  return ok;
}

/* normalizeAlgorithm(algorithm, 'deriveBits') for PBKDF2 and HKDF. */
static bool scr_wc_normalize_kdf(ScrDyn *identifier, const char *method, ScrWcKdfParams *params) {
  memset(params, 0, sizeof *params);
  ScrStr *name = scr_wc_algorithm_name(identifier, "Algorithm");
  if (!name) return false;
  params->name = scr_wc_lookup(scr_wc_derive_names, SCR_WC_COUNT(scr_wc_derive_names), name);
  scr_str_release(name);
  if (!params->name) {
    scr_throw_domex("NotSupportedError", "Unrecognized algorithm name");
    return false;
  }
  if (!scr_wc_is_kdf(params->name)) {
    scr_wc_unsupported_algorithm(method, params->name);
    return false;
  }
  bool pbkdf2 = strcmp(params->name, "PBKDF2") == 0;
  const char *dict_name = pbkdf2 ? "Pbkdf2Params" : "HkdfParams";
  ScrDyn *dict = scr_wc_is_object(identifier) ? scr_wc_plain(identifier)
                                              : scr_dyn_retain(scr_dyn_undefined());
  if (!dict) return false;
  ScrDyn *hash = NULL;
  bool ok = scr_wc_member_hash(dict, dict_name, &hash);
  if (ok && pbkdf2) {
    ScrDyn *iterations = scr_wc_member(dict, "iterations");
    if (iterations->kind == SCR_DYN_UNDEF) {
      scr_wc_missing_member(dict_name, "iterations");
      ok = false;
    } else if (!scr_wc_enforce_range(scr_wc_normalize_prefix, "iterations in passed algorithm",
                                     iterations, 4294967295.0, &params->iterations)) {
      ok = false;
    } else if (params->iterations == 0) {
      scr_throw_domex("OperationError", "iterations cannot be zero");
      ok = false;
    } else if (params->iterations > 2147483647.0) {
      scr_throw_domex("NotSupportedError", "iterations exceeds the implementation limit");
      ok = false;
    }
    scr_dyn_release(iterations);
    ok = ok && scr_wc_member_buffer(dict, dict_name, "salt", true, &params->salt);
  } else if (ok) {
    ok = scr_wc_member_buffer(dict, dict_name, "info", true, &params->info);
    if (ok && scr_bytes_byte_len(params->info) > 1024) {
      scr_throw_domex("OperationError", "algorithm.info must be at most 1024 bytes");
      ok = false;
    }
    ok = ok && scr_wc_member_buffer(dict, dict_name, "salt", true, &params->salt);
  }
  scr_dyn_release(dict);
  if (ok) {
    params->hash = scr_wc_digest_algorithm(hash, method);
    if (!params->hash) ok = false;
  }
  if (hash) scr_dyn_release(hash);
  if (!ok) scr_wc_kdf_params_drop(params);
  return ok;
}

/* The length rules of pbkdf2DeriveBits and hkdfDeriveBits; `null_length`
 * says the length was null. */
static bool scr_wc_kdf_length(const ScrWcKdfParams *params, bool null_length, double length) {
  if (null_length) {
    scr_throw_domex("OperationError", "length cannot be null");
    return false;
  }
  if (fmod(length, 8) != 0) {
    scr_throw_domex("OperationError", "length must be a multiple of 8");
    return false;
  }
  if (strcmp(params->name, "HKDF") == 0) {
    double digest = strcmp(params->hash, "SHA-1") == 0     ? 20
                    : strcmp(params->hash, "SHA-256") == 0 ? 32
                    : strcmp(params->hash, "SHA-384") == 0 ? 48
                                                           : 64;
    if (length > 255 * digest * 8) {
      scr_throw_domex("OperationError", "length exceeds the maximum derived bit length");
      return false;
    }
  }
  return true;
}

/* The derived bytes (+1); length is a nonzero multiple of 8. */
static ScrBytes *scr_wc_kdf_derive(const ScrWcKdfParams *params, const ScrCryptoKey *key,
                                   double length) {
  ScrBytes *secret = scr_bytes_new(SCR_BYTES_U8, (double)key->len);
  if (key->len) memcpy(secret->data, key->data, key->len);
  const char *native = scr_wc_native_hash(params->hash);
  ScrStr *digest = scr_str_new(native, strlen(native));
  ScrBytes *out;
  if (strcmp(params->name, "PBKDF2") == 0) {
    out = scr_crypto_pbkdf2(secret, params->salt, params->iterations, length / 8, digest);
  } else {
    out = scr_crypto_hkdf_bytes(digest, secret, params->salt, params->info, length / 8);
  }
  scr_str_release(digest);
  volatile unsigned char *wipe = secret->data;
  for (size_t i = 0; i < key->len; i++) wipe[i] = 0;
  scr_bytes_release(secret);
  return out;
}

/* The base key checks deriveBits and deriveKey share. */
static bool scr_wc_check_base_key(const ScrCryptoKey *key, const char *algorithm, unsigned usage,
                                  const char *usage_name) {
  /* NULL: an asymmetric key, which never has a derive usage */
  if (key == NULL || !(key->usages & usage)) {
    char message[64];
    snprintf(message, sizeof message, "baseKey does not have %s usage", usage_name);
    scr_throw_domex("InvalidAccessError", message);
    return false;
  }
  if (strcmp(key->name, algorithm) != 0) {
    scr_throw_domex("InvalidAccessError", "Key algorithm mismatch");
    return false;
  }
  return true;
}

/* deriveBits(algorithm, baseKey[, length]). */
ScrPromise *scr_webcrypto_derive_bits(ScrDyn *args) {
  static const char prefix[] = "Failed to execute 'deriveBits' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 2)) return scr_wc_rejected();
  size_t argc = (size_t)scr_dyn_arr_len(args);
  ScrWcArgs a;
  size_t n = argc > 3 ? 3 : argc;
  scr_wc_args_take(&a, args, n);
  ScrWcKdfParams params;
  memset(&params, 0, sizeof params);
  ScrPromise *result = NULL;
  if (!scr_wc_algorithm_identifier(a.v[0])) goto done;
  ScrCryptoKey *key = scr_crypto_key_of(a.v[1]);
  /* an ECDSA, Ed25519 or RSA key (scr_webcrypto_pki.c) has no derive usage */
  bool asymmetric_key = !key && scr_wc_asymmetric && scr_wc_asymmetric->is_key(a.v[1]);
  if (!key && !asymmetric_key) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 2nd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  /* length defaults to null when absent or undefined. */
  bool null_length = n < 3 || a.v[2]->kind == SCR_DYN_UNDEF || a.v[2]->kind == SCR_DYN_NULL;
  double length = 0;
  if (!null_length && !scr_wc_enforce_range(prefix, "3rd argument", a.v[2], 4294967295.0, &length))
    goto done;
  if (!scr_wc_normalize_kdf(a.v[0], "deriveBits", &params)) goto done;
  if (!scr_wc_check_base_key(asymmetric_key ? NULL : key, params.name, SCR_WC_USAGE_DERIVE_BITS,
                             "deriveBits"))
    goto done;
  if (!scr_wc_kdf_length(&params, null_length, length)) goto done;
  if (length == 0) {
    ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);
    result = scr_wc_resolved(scr_array_buffer_from_bytes(empty));
    scr_bytes_release(empty);
    goto done;
  }
  ScrBytes *bits = scr_wc_kdf_derive(&params, key, length);
  if (bits) result = scr_wc_deferred_buffer(bits);
done:
  scr_wc_kdf_params_drop(&params);
  scr_wc_args_drop(&a, n);
  return result ? result : scr_wc_rejected();
}

/* getKeyLength for the derived key type: the bits to derive, or *null
 * for the KDF types (whose derivation then rejects). */
static bool scr_wc_derived_length(ScrDyn *identifier, const ScrWcAlgorithm *imported,
                                  bool *null_length, double *length) {
  ScrStr *name = scr_wc_algorithm_name(identifier, "Algorithm");
  if (!name) return false;
  const char *canonical =
      scr_wc_lookup(scr_wc_length_names, SCR_WC_COUNT(scr_wc_length_names), name);
  scr_str_release(name);
  if (!canonical) {
    scr_throw_domex("NotSupportedError", "Unrecognized algorithm name");
    return false;
  }
  *null_length = false;
  if (scr_wc_is_aes(canonical)) {
    ScrWcAlgorithm aes;
    memset(&aes, 0, sizeof aes);
    if (!scr_wc_aes_length_params(identifier, "AesDerivedKeyParams", &aes)) return false;
    *length = aes.length;
    return true;
  }
  if (strcmp(canonical, "HMAC") == 0 && imported->hash) {
    *length = imported->has_length ? imported->length
              : strcmp(imported->hash, "SHA-384") == 0 || strcmp(imported->hash, "SHA-512") == 0
                  ? 1024
                  : 512;
    return true;
  }
  *null_length = true;
  return true;
}

/* deriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages):
 * the derivation's errors reject at once; the import of the derived bits
 * settles, or rejects, on a later loop turn. */
ScrPromise *scr_webcrypto_derive_key(ScrDyn *args) {
  static const char prefix[] = "Failed to execute 'deriveKey' on 'SubtleCrypto'";
  if (!scr_wc_required(prefix, args, 5)) return scr_wc_rejected();
  ScrWcArgs a;
  scr_wc_args_take(&a, args, 5);
  ScrWcKdfParams params;
  memset(&params, 0, sizeof params);
  ScrPromise *result = NULL;
  if (!scr_wc_algorithm_identifier(a.v[0])) goto done;
  ScrCryptoKey *key = scr_crypto_key_of(a.v[1]);
  /* an ECDSA, Ed25519 or RSA key (scr_webcrypto_pki.c) has no derive usage */
  bool asymmetric_key = !key && scr_wc_asymmetric && scr_wc_asymmetric->is_key(a.v[1]);
  if (!key && !asymmetric_key) {
    scr_wc_type_error("ERR_INVALID_ARG_TYPE", "%s: 2nd argument is not of type CryptoKey.", prefix);
    goto done;
  }
  if (!scr_wc_algorithm_identifier(a.v[2])) goto done;
  bool extractable = scr_dyn_truthy(a.v[3]);
  long usages = scr_wc_key_usages(prefix, 4, a.v[4]);
  if (usages < 0) goto done;
  if (!scr_wc_normalize_kdf(a.v[0], "deriveKey", &params)) goto done;
  ScrWcAlgorithm imported;
  if (!scr_wc_normalize(a.v[2], scr_wc_import_names, SCR_WC_COUNT(scr_wc_import_names),
                        SCR_WC_OP_IMPORT, &imported))
    goto done;
  bool null_length;
  double length;
  if (!scr_wc_derived_length(a.v[2], &imported, &null_length, &length)) goto done;
  if (strcmp(imported.name, "HMAC") != 0 && !scr_wc_is_aes(imported.name) &&
      !scr_wc_is_kdf(imported.name)) {
    scr_wc_unsupported_algorithm("deriveKey", imported.name);
    goto done;
  }
  if (!scr_wc_check_base_key(asymmetric_key ? NULL : key, params.name, SCR_WC_USAGE_DERIVE_KEY,
                             "deriveKey"))
    goto done;
  if (!scr_wc_kdf_length(&params, null_length, length)) goto done;
  ScrBytes *bits = scr_wc_kdf_derive(&params, key, length);
  if (!bits) goto done;
  ScrDyn *derived = scr_wc_import_key_sync("raw-secret", bits, NULL, &imported, extractable, usages);
  scr_bytes_release(bits);
  result = derived ? scr_wc_deferred(derived) : scr_wc_deferred_rejection();
done:
  scr_wc_kdf_params_drop(&params);
  scr_wc_args_drop(&a, 5);
  return result ? result : scr_wc_rejected();
}
