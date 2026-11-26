/* The Web IDL and error helpers of scr_webcrypto.c that the asymmetric
 * algorithms (scr_webcrypto_pki.c) share, and the table through which
 * scr_webcrypto.c reaches them when that unit is linked. */
#ifndef SCR_WEBCRYPTO_H
#define SCR_WEBCRYPTO_H

#include <stdbool.h>
#include <stddef.h>

#define SCR_WC_COUNT(names) (sizeof(names) / sizeof((names)[0]))

enum {
  SCR_WC_USAGE_ENCRYPT = 1u << 0,
  SCR_WC_USAGE_DECRYPT = 1u << 1,
  SCR_WC_USAGE_SIGN = 1u << 2,
  SCR_WC_USAGE_VERIFY = 1u << 3,
  SCR_WC_USAGE_DERIVE_KEY = 1u << 4,
  SCR_WC_USAGE_DERIVE_BITS = 1u << 5,
  SCR_WC_USAGE_WRAP_KEY = 1u << 6,
  SCR_WC_USAGE_UNWRAP_KEY = 1u << 7,
  SCR_WC_USAGE_ENCAPSULATE_KEY = 1u << 8,
  SCR_WC_USAGE_ENCAPSULATE_BITS = 1u << 9,
  SCR_WC_USAGE_DECAPSULATE_KEY = 1u << 10,
  SCR_WC_USAGE_DECAPSULATE_BITS = 1u << 11,
};

/* Node's canonical usage order; the bit is the index. */
extern const char *const scr_wc_usages[12];
extern const char *const scr_wc_ordinals[5];
extern const char scr_wc_normalize_prefix[];
extern const char *const scr_wc_digest_names[13];

typedef struct {
  ScrDyn *v[5];
} ScrWcArgs;

void scr_wc_type_error(const char *code, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
/* Node's once-per-process ExperimentalWarning for an experimental algorithm
 * (ML-KEM's parameter sets among them). */
void scr_wc_warn_experimental_algorithm(const char *canonical);
void scr_wc_unsupported(const char *method, const char *what);
void scr_wc_unsupported_algorithm(const char *method, const char *name);
bool scr_wc_is_object(const ScrDyn *v);
ScrDyn *scr_wc_plain(ScrDyn *v);
ScrBytes *scr_wc_buffer_source(const char *prefix, size_t index, ScrDyn *value);
ScrStr *scr_wc_dom_string(const ScrDyn *value);
const char *scr_wc_key_format(const char *prefix, ScrDyn *value);
long scr_wc_key_usages(const char *prefix, size_t index, ScrDyn *value);
/* The keyUsages sequence KeyObject.toCryptoKey takes, whose messages name
 * the value "Value": a usage mask, or -1 with the TypeError pending. */
long scr_wc_value_usages(ScrDyn *value);
void scr_wc_missing_member(const char *dict, const char *member);
ScrDyn *scr_wc_member(const ScrDyn *dict, const char *key);
/* A BufferSource member of an algorithm dictionary: false with the error
 * pending; *out stays NULL when an optional member is absent. */
bool scr_wc_dictionary_buffer(const ScrDyn *dict, const char *dict_name, const char *key,
                              bool required, ScrBytes **out);
ScrStr *scr_wc_algorithm_name(ScrDyn *identifier, const char *dict);
const char *scr_wc_digest_algorithm(ScrDyn *identifier, const char *method);
const char *scr_wc_lookup(const char *const *names, size_t count, const ScrStr *name);
ScrDyn *scr_wc_cstr(const char *s);
ScrPromise *scr_wc_rejected(void);
bool scr_wc_required(const char *prefix, const ScrDyn *args, size_t required);
void scr_wc_args_take(ScrWcArgs *a, const ScrDyn *args, size_t n);
void scr_wc_args_drop(ScrWcArgs *a, size_t n);

/* ECDSA, RSASSA-PKCS1-v1_5, RSA-PSS, Ed25519, ECDH, RSA-OAEP and X25519
 * (scr_webcrypto_pki.c, linked with the pki unit): each takes the method's
 * argument vector (borrowed) and answers a +1 promise, except derive_bits,
 * which answers +1 bytes or NULL with the DOMException pending. NULL until
 * that unit installs it. */
typedef struct {
  ScrPromise *(*generate_key)(const ScrDyn *args);
  ScrPromise *(*import_key)(const ScrDyn *args);
  ScrPromise *(*export_key)(const ScrDyn *args);
  /* The synchronous halves wrapKey and unwrapKey use: exportKey(format, key)
   * and importKey(format, keyData, algorithm, extractable, keyUsages), both
   * +1 or NULL with the DOMException pending. */
  ScrDyn *(*export_sync)(ScrDyn *format, ScrDyn *key);
  ScrDyn *(*import_sync)(const ScrDyn *args);
  /* RSA-OAEP as wrapKey/unwrapKey's algorithm: the wrapping key must be an
   * RSA-OAEP key with the wrapKey usage (its public half) or the unwrapKey
   * usage (its private half), then the exported payload is encrypted or the
   * wrapped bytes decrypted. usable answers true or false with the
   * DOMException pending; wrap answers +1 bytes or NULL likewise. */
  bool (*oaep_wrap_usable)(const ScrDyn *key, bool decrypt);
  ScrBytes *(*oaep_wrap)(const ScrDyn *algorithm, const ScrDyn *key, ScrBytes *data, bool decrypt);
  ScrPromise *(*sign)(const ScrDyn *args);
  ScrPromise *(*verify)(const ScrDyn *args);
  ScrPromise *(*encrypt)(const ScrDyn *args);
  ScrPromise *(*decrypt)(const ScrDyn *args);
  ScrBytes *(*derive_bits)(ScrDyn *algorithm, ScrDyn *base_key, bool null_length, double length,
                           const char *method);
  /* KeyObject.toCryptoKey for an asymmetric KeyObject (its method
   * arguments are borrowed), and KeyObject.from for a CryptoKey. */
  ScrDyn *(*to_crypto_key)(const ScrDyn *key, const ScrDyn *const *args, size_t argc);
  ScrDyn *(*key_object_from)(const ScrDyn *crypto_key);
  /* The public CryptoKey derived from a private one (getPublicKey), or NULL
   * with the DOMException pending. */
  ScrDyn *(*get_public_key)(ScrDyn *key, long usages);
  /* ML-KEM (FIPS 203) key encapsulation: the algorithm names one of the
   * parameter sets the key must belong to; `method` names the operation for
   * Node's usage error. encapsulate answers the 32-byte shared key and
   * *ciphertext (+1 each); decapsulate answers the shared key. NULL with
   * the DOMException pending. */
  ScrBytes *(*kem_encapsulate)(const ScrDyn *algorithm, const ScrDyn *key, const char *method,
                               ScrBytes **ciphertext);
  ScrBytes *(*kem_decapsulate)(const ScrDyn *algorithm, const ScrDyn *key, const char *method,
                               ScrBytes *ciphertext);
  bool (*is_key)(const ScrDyn *value);
  /* An asymmetric key's private/public pair member: true for the private
   * key. node:crypto's key type error names the member. */
  bool (*key_is_private)(const ScrDyn *value);
} ScrWcAsymmetric;

extern const ScrWcAsymmetric *scr_wc_asymmetric;

#endif
