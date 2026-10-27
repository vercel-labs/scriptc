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
void scr_wc_unsupported(const char *method, const char *what);
void scr_wc_unsupported_algorithm(const char *method, const char *name);
bool scr_wc_is_object(const ScrDyn *v);
ScrDyn *scr_wc_plain(ScrDyn *v);
ScrBytes *scr_wc_buffer_source(const char *prefix, size_t index, ScrDyn *value);
ScrStr *scr_wc_dom_string(const ScrDyn *value);
const char *scr_wc_key_format(const char *prefix, ScrDyn *value);
long scr_wc_key_usages(const char *prefix, size_t index, ScrDyn *value);
void scr_wc_missing_member(const char *dict, const char *member);
ScrDyn *scr_wc_member(const ScrDyn *dict, const char *key);
ScrStr *scr_wc_algorithm_name(ScrDyn *identifier, const char *dict);
const char *scr_wc_digest_algorithm(ScrDyn *identifier, const char *method);
const char *scr_wc_lookup(const char *const *names, size_t count, const ScrStr *name);
ScrDyn *scr_wc_cstr(const char *s);
ScrPromise *scr_wc_rejected(void);
bool scr_wc_required(const char *prefix, const ScrDyn *args, size_t required);
void scr_wc_args_take(ScrWcArgs *a, const ScrDyn *args, size_t n);
void scr_wc_args_drop(ScrWcArgs *a, size_t n);

/* ECDSA, RSASSA-PKCS1-v1_5 and RSA-PSS (scr_webcrypto_pki.c, linked with
 * the pki unit): each takes the method's argument vector (borrowed) and
 * answers a +1 promise. NULL until that unit installs it. */
typedef struct {
  ScrPromise *(*generate_key)(const ScrDyn *args);
  ScrPromise *(*import_key)(const ScrDyn *args);
  ScrPromise *(*export_key)(const ScrDyn *args);
  ScrPromise *(*sign)(const ScrDyn *args);
  ScrPromise *(*verify)(const ScrDyn *args);
  bool (*is_key)(const ScrDyn *value);
} ScrWcAsymmetric;

extern const ScrWcAsymmetric *scr_wc_asymmetric;

#endif
