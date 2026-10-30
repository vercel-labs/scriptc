/* node:crypto Cipheriv and Decipheriv over the vendored mbedTLS block
 * ciphers: aes-128/192/256 in CBC, CTR and GCM modes and
 * chacha20-poly1305. A cipher is a native dyn handle; its update(),
 * final(), setAAD(), setAutoPadding(), getAuthTag() and setAuthTag()
 * methods follow Node 24's lib/internal/crypto/cipher.js argument handling
 * and src/crypto/crypto_cipher.cc state machine. CBC buffering and PKCS#7
 * padding follow OpenSSL 3's generic block provider, so every update()
 * returns the same number of bytes as Node's. String output goes through
 * the runtime StringDecoder, which carries partial characters and base64
 * groups between calls as Node's does. chacha20-poly1305 follows OpenSSL's
 * construction, which also accepts AAD after data. Authentication tags are
 * compared in constant time. All arguments are borrowed. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/aes.h"
#include "mbedtls/chacha20.h"
#include "mbedtls/gcm.h"
#include "mbedtls/poly1305.h"
#include "mbedtls/platform_util.h"

typedef enum { SC_CBC, SC_CTR, SC_GCM, SC_CHACHA } ScCipherMode;

typedef struct {
  const char *name;
  ScCipherMode mode;
  unsigned key_len;
} ScCipherSpec;

/* Node's names for the implemented ciphers, including OpenSSL's aliases.
 * Lookup is case-insensitive, like OpenSSL's. */
static const ScCipherSpec sc_specs[] = {
  {"aes-128-cbc", SC_CBC, 16},       {"aes-192-cbc", SC_CBC, 24},       {"aes-256-cbc", SC_CBC, 32},
  {"aes128", SC_CBC, 16},            {"aes192", SC_CBC, 24},            {"aes256", SC_CBC, 32},
  {"aes-128-ctr", SC_CTR, 16},       {"aes-192-ctr", SC_CTR, 24},       {"aes-256-ctr", SC_CTR, 32},
  {"aes-128-gcm", SC_GCM, 16},       {"aes-192-gcm", SC_GCM, 24},       {"aes-256-gcm", SC_GCM, 32},
  {"id-aes128-gcm", SC_GCM, 16},     {"id-aes192-gcm", SC_GCM, 24},     {"id-aes256-gcm", SC_GCM, 32},
  {"chacha20-poly1305", SC_CHACHA, 32},
};

/* crypto.getCiphers() on Node 24.22 (OpenSSL 3.5). Names in this list that
 * have no implementation throw a coded SC2020 error instead of Node's
 * ERR_CRYPTO_UNKNOWN_CIPHER. */
static const char *const sc_known[] = {
  "aes-128-cbc", "aes-128-cbc-cts", "aes-128-ccm", "aes-128-cfb", "aes-128-cfb1", "aes-128-cfb8",
  "aes-128-ctr", "aes-128-ecb", "aes-128-gcm", "aes-128-gcm-siv", "aes-128-ocb", "aes-128-ofb",
  "aes-128-siv", "aes-128-wrap", "aes-128-wrap-inv", "aes-128-wrap-pad", "aes-128-wrap-pad-inv",
  "aes-128-xts", "aes-192-cbc", "aes-192-cbc-cts", "aes-192-ccm", "aes-192-cfb", "aes-192-cfb1",
  "aes-192-cfb8", "aes-192-ctr", "aes-192-ecb", "aes-192-gcm", "aes-192-gcm-siv", "aes-192-ocb",
  "aes-192-ofb", "aes-192-siv", "aes-192-wrap", "aes-192-wrap-inv", "aes-192-wrap-pad",
  "aes-192-wrap-pad-inv", "aes-256-cbc", "aes-256-cbc-cts", "aes-256-ccm", "aes-256-cfb",
  "aes-256-cfb1", "aes-256-cfb8", "aes-256-ctr", "aes-256-ecb", "aes-256-gcm", "aes-256-gcm-siv",
  "aes-256-ocb", "aes-256-ofb", "aes-256-siv", "aes-256-wrap", "aes-256-wrap-inv",
  "aes-256-wrap-pad", "aes-256-wrap-pad-inv", "aes-256-xts", "aes128", "aes128-wrap",
  "aes128-wrap-inv", "aes128-wrap-pad", "aes128-wrap-pad-inv", "aes192", "aes192-wrap",
  "aes192-wrap-inv", "aes192-wrap-pad", "aes192-wrap-pad-inv", "aes256", "aes256-wrap",
  "aes256-wrap-inv", "aes256-wrap-pad", "aes256-wrap-pad-inv", "aria-128-cbc", "aria-128-ccm",
  "aria-128-cfb", "aria-128-cfb1", "aria-128-cfb8", "aria-128-ctr", "aria-128-ecb", "aria-128-gcm",
  "aria-128-ofb", "aria-192-cbc", "aria-192-ccm", "aria-192-cfb", "aria-192-cfb1", "aria-192-cfb8",
  "aria-192-ctr", "aria-192-ecb", "aria-192-gcm", "aria-192-ofb", "aria-256-cbc", "aria-256-ccm",
  "aria-256-cfb", "aria-256-cfb1", "aria-256-cfb8", "aria-256-ctr", "aria-256-ecb", "aria-256-gcm",
  "aria-256-ofb", "aria128", "aria192", "aria256", "camellia-128-cbc", "camellia-128-cbc-cts",
  "camellia-128-cfb", "camellia-128-cfb1", "camellia-128-cfb8", "camellia-128-ctr",
  "camellia-128-ecb", "camellia-128-ofb", "camellia-192-cbc", "camellia-192-cbc-cts",
  "camellia-192-cfb", "camellia-192-cfb1", "camellia-192-cfb8", "camellia-192-ctr",
  "camellia-192-ecb", "camellia-192-ofb", "camellia-256-cbc", "camellia-256-cbc-cts",
  "camellia-256-cfb", "camellia-256-cfb1", "camellia-256-cfb8", "camellia-256-ctr",
  "camellia-256-ecb", "camellia-256-ofb", "camellia128", "camellia192", "camellia256", "chacha20",
  "chacha20-poly1305", "des-ede", "des-ede-cbc", "des-ede-cfb", "des-ede-ecb", "des-ede-ofb",
  "des-ede3", "des-ede3-cbc", "des-ede3-cfb", "des-ede3-cfb1", "des-ede3-cfb8", "des-ede3-ecb",
  "des-ede3-ofb", "des3", "des3-wrap", "id-aes128-ccm", "id-aes128-gcm", "id-aes128-wrap",
  "id-aes128-wrap-pad", "id-aes192-ccm", "id-aes192-gcm", "id-aes192-wrap", "id-aes192-wrap-pad",
  "id-aes256-ccm", "id-aes256-gcm", "id-aes256-wrap", "id-aes256-wrap-pad",
  "id-smime-alg-cms3deswrap", "sm4", "sm4-cbc", "sm4-ccm", "sm4-cfb", "sm4-cfb128", "sm4-ctr",
  "sm4-ecb", "sm4-gcm", "sm4-ofb", "sm4-ofb128", "sm4-xts",
};

enum { SC_NO_TAG = -1 };
enum { SC_TAG_UNKNOWN, SC_TAG_SET_BY_USER, SC_TAG_COMPUTED };

typedef struct ScCipher {
  size_t rc;
  ScCipherMode mode;
  bool decrypt;
  bool active;       /* false after final() or a failed backend call */
  bool pad;          /* CBC automatic padding */
  bool data_started; /* a non-empty update() ran, so non-empty AAD is refused */
  int tag_len;       /* SC_NO_TAG until known */
  int tag_state;
  unsigned char tag[16];
  unsigned char block[16]; /* CBC: chaining value; CTR: counter block */
  unsigned char buf[16];   /* CBC: buffered input; CTR: keystream block */
  size_t bufsz;            /* CBC: buffered bytes; CTR: keystream offset */
  mbedtls_aes_context aes;
  mbedtls_gcm_context gcm;
  mbedtls_chacha20_context chacha;
  mbedtls_poly1305_context poly;
  uint64_t aad_len;  /* chacha20-poly1305 AAD bytes */
  uint64_t text_len; /* chacha20-poly1305 data bytes */
  bool aad_open;     /* AAD was added since the last data or padding */
  ScrStr *decoder; /* the StringDecoder encoding once string output starts */
  double pending;  /* the decoder's carried bytes */
} ScCipher;

static void *sc_retain(void *h) {
  ((ScCipher *)h)->rc++;
  return h;
}

static void sc_release(void *h) {
  ScCipher *c = h;
  if (--c->rc) return;
  mbedtls_aes_free(&c->aes);
  mbedtls_gcm_free(&c->gcm);
  mbedtls_chacha20_free(&c->chacha);
  mbedtls_poly1305_free(&c->poly);
  scr_str_release(c->decoder);
  mbedtls_platform_zeroize(c, sizeof *c);
  free(c);
}

/* ── errors ───────────────────────────────────────────────────────────── */

static void sc_throw(int kind, const char *code, const char *message) {
  if (code) scr_throw_error_msg_code(kind, message, strlen(message), code);
  else scr_throw_error_msg(kind, message, strlen(message));
}

static void sc_invalid_state(const char *operation) {
  char message[64];
  snprintf(message, sizeof message, "Invalid state for operation %s", operation);
  sc_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INVALID_STATE", message);
}

/* A backend call failed. The context is retired, like Node's after
 * final(): later calls throw, and no output or tag is returned. */
static void sc_fail(ScCipher *c) {
  c->active = false;
  c->tag_state = SC_TAG_UNKNOWN;
  mbedtls_platform_zeroize(c->tag, sizeof c->tag);
  mbedtls_platform_zeroize(c->buf, sizeof c->buf);
  c->bufsz = 0;
}

static void sc_invalid_tag(unsigned long length) {
  char message[80];
  snprintf(message, sizeof message, "Invalid authentication tag length: %lu", length);
  sc_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_AUTH_TAG", message);
}

/* An OpenSSL provider error as Node reports it: the formatted message plus
 * own opensslErrorStack, library, reason and code properties, in Node's
 * key order. */
static void sc_throw_openssl(const char *packed, const char *reason, const char *code) {
  char message[128];
  snprintf(message, sizeof message, "error:%s:Provider routines::%s", packed, reason);
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  ScrDyn *view = scr_dyn_from_error(e);
  ScrDyn *stack = scr_dyn_new_arr();
  scr_dyn_arr_push(stack, scr_dyn_new_str(text));
  scr_str_release(text);
  scr_dyn_obj_set(view, "opensslErrorStack", 17, stack);
  ScrStr *library = scr_str_new("Provider routines", 17);
  scr_dyn_obj_set(view, "library", 7, scr_dyn_new_str(library));
  scr_str_release(library);
  ScrStr *reason_text = scr_str_new(reason, strlen(reason));
  scr_dyn_obj_set(view, "reason", 6, scr_dyn_new_str(reason_text));
  scr_str_release(reason_text);
  scr_error_set_code(e, code);
  ScrStr *code_text = scr_str_new(code, strlen(code));
  scr_dyn_obj_set(view, "code", 4, scr_dyn_new_str(code_text));
  scr_str_release(code_text);
  scr_dyn_release(view);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* ERR_INVALID_ARG_VALUE's property flavor: "The property 'options.x' is
 * invalid. Received <value>". */
static void sc_invalid_property(const char *name, const ScrDyn *value) {
  char rendered[160];
  const char *text = scr_dyn_inspect_lite(value, rendered, sizeof rendered);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The property '");
  scr_jb_puts(&b, name);
  scr_jb_puts(&b, "' is invalid. Received ");
  scr_jb_puts(&b, text);
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(message);
}

/* validateOneOf: "The property 'options.x' must be one of: 'A', 'B'.
 * Received <value>". */
static void sc_not_one_of(const char *name, const char *allowed, const ScrDyn *value) {
  char rendered[160];
  const char *text = scr_dyn_inspect_lite(value, rendered, sizeof rendered);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The property '");
  scr_jb_puts(&b, name);
  scr_jb_puts(&b, "' must be one of: ");
  scr_jb_puts(&b, allowed);
  scr_jb_puts(&b, ". Received ");
  scr_jb_puts(&b, text);
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(message);
}

/* An object's toString the program defined, as an own or inherited
 * function property. */
static bool sc_custom_to_string(ScrDyn *value) {
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_TYPED_REF) return false;
  ScrDyn *member = scr_dyn_obj_read(value, "toString", 8);
  bool custom = member && member->kind == SCR_DYN_FUNC;
  scr_dyn_release(member);
  return custom;
}

/* Whether value is a class instance whose class defines toString. */
static bool sc_class_to_string(const ScrDyn *value) {
  ScrStr *name = scr_str_new("toString", 8);
  bool method = scr_dyn_typed_ref_class_has(value, name);
  scr_str_release(name);
  return method;
}

/* ERR_UNKNOWN_ENCODING formats the encoding with %s: objects without a
 * program-defined toString are inspected at depth 0. */
static void sc_unknown_encoding(const ScrDyn *encoding) {
  ScrDyn *value = (ScrDyn *)encoding;
  ScrStr *text;
  bool class_to_string = sc_class_to_string(value);
  if (scr_exc_pending()) return;
  /* Node prints a function's source text and calls a class's toString. */
  if (value->kind == SCR_DYN_FUNC || class_to_string) {
    static const char message[] = "An output encoding that is a function or an instance of a class defining "
                                  "toString has no lowering; pass the encoding name as a string";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return;
  }
  if (value->kind == SCR_DYN_STR || sc_custom_to_string(value)) {
    text = scr_dyn_string_coerce_js(value);
  } else if (value->kind == SCR_DYN_NUM) {
    text = scr_insp_f64(value->v.num);
  } else {
    text = scr_insp_dyn_s(value, 0);
  }
  if (!text) return;
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Unknown encoding: ");
  scr_jb_put_str(&b, text);
  scr_str_release(text);
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_UNKNOWN_ENCODING");
  scr_str_release(message);
}

/* ── argument conversion ──────────────────────────────────────────────── */

static bool sc_ascii_eq_ci(const char *a, size_t a_len, const char *b) {
  size_t b_len = strlen(b);
  if (a_len != b_len) return false;
  for (size_t i = 0; i < a_len; i++) {
    char x = a[i], y = b[i];
    if (x >= 'A' && x <= 'Z') x = (char)(x - 'A' + 'a');
    if (x != y) return false;
  }
  return true;
}

static bool sc_str_is(const ScrStr *text, const char *literal) {
  size_t len = strlen(literal);
  return text->len == len && memcmp(text->data, literal, len) == 0;
}

/* Node's normalizeEncoding: the canonical name, or NULL. */
static const char *sc_normalize_encoding(const ScrStr *name) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"},       {"utf-8", "utf8"},       {"hex", "hex"},
    {"base64", "base64"},   {"base64url", "base64url"}, {"latin1", "latin1"},
    {"binary", "latin1"},   {"ascii", "ascii"},      {"utf16le", "utf16le"},
    {"utf-16le", "utf16le"}, {"ucs2", "utf16le"},    {"ucs-2", "utf16le"},
  };
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++)
    if (sc_ascii_eq_ci(name->data, name->len, map[i].from)) return map[i].to;
  return NULL;
}

static bool sc_is_view(const ScrDyn *value) {
  return value->kind == SCR_DYN_BYTES;
}

/* A u8 view of an ArrayBuffer, Buffer, TypedArray or DataView (+1). */
static ScrBytes *sc_bytes_of(const ScrDyn *value) {
  return scr_bytes_buffer_source(value);
}

/* Buffer.from(string, encoding) with Node's encoding rules: a missing or
 * non-string encoding reads as utf8, an unknown name throws
 * ERR_UNKNOWN_ENCODING. "buffer" reads as utf8. +1 or NULL. */
static ScrBytes *sc_string_bytes(const ScrStr *text, const ScrDyn *encoding) {
  const char *name = "utf8";
  if (encoding && encoding->kind == SCR_DYN_STR && encoding->v.str->len > 0 &&
      !sc_ascii_eq_ci(encoding->v.str->data, encoding->v.str->len, "buffer")) {
    name = sc_normalize_encoding(encoding->v.str);
    if (!name) {
      sc_unknown_encoding(encoding);
      return NULL;
    }
  }
  ScrStr *canonical = scr_str_new(name, strlen(name));
  ScrBytes *bytes = scr_bytes_from_str(text, canonical);
  scr_str_release(canonical);
  return bytes;
}

/* getArrayBufferOrView(value, name, encoding). +1 or NULL. */
static ScrBytes *sc_buffer_or_view(const ScrDyn *value, const char *name, const ScrDyn *encoding) {
  if (value->kind == SCR_DYN_STR) return sc_string_bytes(value->v.str, encoding);
  if (sc_is_view(value) || scr_buffer_storage_is(value)) return sc_bytes_of(value);
  scr_dyn_arg_type_fail(name, "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
  return NULL;
}

/* The value a typed-ref box holds when it is a string, view, ArrayBuffer
 * or native handle such as a KeyObject (+1). Other values are retained
 * as passed, so argument errors describe the original value. NULL after
 * throwing. */
static ScrDyn *sc_unbox(ScrDyn *value) {
  if (value->kind != SCR_DYN_TYPED_REF) return scr_dyn_retain(value);
  /* Class arguments keep their identity and declaration metadata. A snapshot
   * can be unavailable even when the encoding refusal needs no field values. */
  if (value->v.typed_ref.klass) return scr_dyn_retain(value);
  ScrDyn *view = scr_dyn_typed_ref_materialize(value);
  if (!view) return NULL;
  if (view->kind == SCR_DYN_STR || sc_is_view(view) || view->kind == SCR_DYN_HANDLE || scr_buffer_storage_is(view))
    return view;
  scr_dyn_release(view);
  return scr_dyn_retain(value);
}

/* options[key] when options is an object, else undefined (+1 or NULL). */
static ScrDyn *sc_option(const ScrDyn *options, const char *key) {
  if (options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_TYPED_REF || options->kind == SCR_DYN_PROXY) {
    ScrDyn *view = options->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(options) : scr_dyn_retain((ScrDyn *)options);
    if (scr_exc_pending()) {
      scr_dyn_release(view);
      return NULL;
    }
    ScrDyn *value = scr_dyn_obj_read(view, key, strlen(key));
    scr_dyn_release(view);
    if (!value && !scr_exc_pending()) value = scr_dyn_retain(scr_dyn_undefined());
    return value;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

/* getStringOption: the option when it is a string, NULL for nullish, and
 * ERR_INVALID_ARG_TYPE otherwise. *failed reports a pending exception. */
static ScrDyn *sc_string_option(const ScrDyn *options, const char *key, bool *failed) {
  *failed = false;
  ScrDyn *value = sc_option(options, key);
  if (!value) {
    *failed = true;
    return NULL;
  }
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    scr_dyn_release(value);
    return NULL;
  }
  if (value->kind != SCR_DYN_STR) {
    char name[48];
    snprintf(name, sizeof name, "options.%s", key);
    scr_dyn_prop_type_fail(name, "of type string", value);
    scr_dyn_release(value);
    *failed = true;
    return NULL;
  }
  return value;
}

/* getUIntOption: the uint32 value, -1 when nullish, -2 after throwing
 * ERR_INVALID_ARG_VALUE. */
static double sc_uint_option(const ScrDyn *options, const char *key) {
  if (options->kind == SCR_DYN_UNDEF || options->kind == SCR_DYN_NULL || !scr_dyn_truthy(options)) return -1;
  ScrDyn *value = sc_option(options, key);
  if (!value) return -2;
  double result = -1;
  if (value->kind != SCR_DYN_UNDEF && value->kind != SCR_DYN_NULL) {
    /* value >>> 0 === value: -0 passes as 0. */
    if (value->kind == SCR_DYN_NUM && value->v.num >= 0 && value->v.num <= 4294967295.0 &&
        value->v.num == (double)(uint32_t)value->v.num) {
      result = value->v.num + 0.0;
    } else {
      char name[48];
      snprintf(name, sizeof name, "options.%s", key);
      sc_invalid_property(name, value);
      result = -2;
    }
  }
  scr_dyn_release(value);
  return result;
}

/* ── construction ─────────────────────────────────────────────────────── */

static const ScCipherSpec *sc_lookup(const ScrStr *name) {
  for (size_t i = 0; i < sizeof sc_specs / sizeof sc_specs[0]; i++)
    if (sc_ascii_eq_ci(name->data, name->len, sc_specs[i].name)) return &sc_specs[i];
  return NULL;
}

static bool sc_known_name(const ScrStr *name) {
  for (size_t i = 0; i < sizeof sc_known / sizeof sc_known[0]; i++)
    if (sc_ascii_eq_ci(name->data, name->len, sc_known[i])) return true;
  return false;
}

static void sc_unsupported_cipher(const ScrStr *name) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The cipher '");
  scr_jb_put_str(&b, name);
  scr_jb_puts(&b, "' has no native implementation; the supported ciphers are aes-128-cbc, aes-192-cbc, "
                  "aes-256-cbc, aes-128-ctr, aes-192-ctr, aes-256-ctr, aes-128-gcm, aes-192-gcm, "
                  "aes-256-gcm and chacha20-poly1305");
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
}

static bool sc_valid_gcm_tag(unsigned long length) {
  return length == 4 || length == 8 || (length >= 12 && length <= 16);
}

static ScrDynHandleOps sc_ops_cipher, sc_ops_decipher;
static ScrDyn *sc_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                         const char *what);
static ScrDyn *sc_get(void *h, const char *key, size_t key_len);
static bool sc_set(void *h, const char *key, size_t key_len, const ScrDyn *value);

/* createCipheriv/createDecipheriv(cipher, key, iv, options): the argument
 * checks of createCipherWithIV and the cipher, IV, tag-length and key
 * checks of CipherBase::InitIv, in Node's order. +1 handle or NULL. */
static ScrDyn *sc_cipher_new(bool decrypt, ScrDyn *cipher, ScrDyn *key, ScrDyn *iv, ScrDyn *options) {
  if (cipher->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("cipher", "of type string", cipher);
    return NULL;
  }
  bool failed;
  ScrDyn *encoding = sc_string_option(options, "encoding", &failed);
  if (failed) return NULL;
  ScrBytes *key_bytes = NULL;
  size_t key_object_len;
  const unsigned char *key_object = scr_key_object_bytes(key, &key_object_len);
  if (key_object) {
    /* prepareSecretKey: a secret KeyObject supplies its bytes. */
    key_bytes = scr_bytes_new(SCR_BYTES_U8, (double)key_object_len);
    if (key_object_len) memcpy(key_bytes->data, key_object, key_object_len);
  } else if (key->kind == SCR_DYN_STR || sc_is_view(key) || scr_buffer_storage_is(key)) {
    key_bytes = sc_buffer_or_view(key, "key", encoding);
  } else {
    scr_dyn_arg_type_fail("key",
                          "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey",
                          key);
  }
  scr_dyn_release(encoding);
  if (!key_bytes) return NULL;
  ScrBytes *iv_bytes = NULL;
  if (iv->kind != SCR_DYN_NULL) {
    iv_bytes = sc_buffer_or_view(iv, "iv", NULL);
    if (!iv_bytes) {
      scr_bytes_release(key_bytes);
      return NULL;
    }
  }
  double tag_option = sc_uint_option(options, "authTagLength");
  ScrDyn *result = NULL;
  ScrDyn *cts_mode = NULL, *xts_standard = NULL;
  if (tag_option == -2) goto done;
  cts_mode = sc_string_option(options, "ctsMode", &failed);
  if (failed) goto done;
  xts_standard = sc_string_option(options, "xtsStandard", &failed);
  if (failed) goto done;
  if (cts_mode && !sc_str_is(cts_mode->v.str, "CS1") && !sc_str_is(cts_mode->v.str, "CS2") &&
      !sc_str_is(cts_mode->v.str, "CS3")) {
    sc_not_one_of("options.ctsMode", "'CS1', 'CS2', 'CS3'", cts_mode);
    goto done;
  }
  if (xts_standard && !sc_str_is(xts_standard->v.str, "GB") && !sc_str_is(xts_standard->v.str, "IEEE")) {
    sc_not_one_of("options.xtsStandard", "'GB', 'IEEE'", xts_standard);
    goto done;
  }
  const ScCipherSpec *spec = sc_lookup(cipher->v.str);
  if (!spec) {
    if (sc_known_name(cipher->v.str)) sc_unsupported_cipher(cipher->v.str);
    else sc_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
    goto done;
  }
  size_t iv_len = iv_bytes ? iv_bytes->len : 0;
  bool aead = spec->mode == SC_GCM || spec->mode == SC_CHACHA;
  if (iv_len == 0 || (!aead && iv_len != 16) || (spec->mode == SC_CHACHA && iv_len != 12)) {
    sc_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_IV", "Invalid initialization vector");
    goto done;
  }
  /* None of the implemented ciphers is a CTS or XTS mode. */
  if (cts_mode || xts_standard) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_put_str(&b, cipher->v.str);
    scr_jb_puts(&b, cts_mode ? " does not support the ctsMode option" : " does not support the xtsStandard option");
    ScrStr *message = scr_jb_finish(&b);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "ERR_CRYPTO_UNSUPPORTED_OPERATION");
    scr_str_release(message);
    goto done;
  }
  int tag_len = SC_NO_TAG;
  if (spec->mode == SC_GCM && tag_option >= 0) {
    if (!sc_valid_gcm_tag((unsigned long)tag_option)) {
      sc_invalid_tag((unsigned long)tag_option);
      goto done;
    }
    tag_len = (int)tag_option;
  } else if (spec->mode == SC_CHACHA) {
    tag_len = tag_option < 0 ? 16 : (int)(tag_option > 16 ? 17 : tag_option);
    if (tag_len < 1 || tag_len > 16) {
      sc_invalid_tag((unsigned long)tag_option);
      goto done;
    }
  }
  if (key_bytes->len != spec->key_len) {
    sc_throw(SCR_ERR_RANGE, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
    goto done;
  }
  ScCipher *c = calloc(1, sizeof *c);
  if (!c) scr_trap("scriptc: out of memory\n");
  c->rc = 1;
  c->mode = spec->mode;
  c->decrypt = decrypt;
  c->active = true;
  c->pad = true;
  c->tag_len = tag_len;
  mbedtls_aes_init(&c->aes);
  mbedtls_gcm_init(&c->gcm);
  mbedtls_chacha20_init(&c->chacha);
  mbedtls_poly1305_init(&c->poly);
  int rc = 0;
  unsigned bits = spec->key_len * 8;
  switch (spec->mode) {
  case SC_CBC:
    rc = decrypt ? mbedtls_aes_setkey_dec(&c->aes, key_bytes->data, bits)
                 : mbedtls_aes_setkey_enc(&c->aes, key_bytes->data, bits);
    memcpy(c->block, iv_bytes->data, 16);
    break;
  case SC_CTR:
    rc = mbedtls_aes_setkey_enc(&c->aes, key_bytes->data, bits);
    memcpy(c->block, iv_bytes->data, 16);
    break;
  case SC_GCM:
    rc = mbedtls_gcm_setkey(&c->gcm, MBEDTLS_CIPHER_ID_AES, key_bytes->data, bits);
    if (rc == 0)
      rc = mbedtls_gcm_starts(&c->gcm, decrypt ? MBEDTLS_GCM_DECRYPT : MBEDTLS_GCM_ENCRYPT, iv_bytes->data, iv_len);
    break;
  case SC_CHACHA: {
    /* RFC 8439: block 0 of the keystream is the Poly1305 key; data starts
     * at block 1. */
    unsigned char poly_key[64] = {0};
    rc = mbedtls_chacha20_setkey(&c->chacha, key_bytes->data);
    if (rc == 0) rc = mbedtls_chacha20_starts(&c->chacha, iv_bytes->data, 0);
    if (rc == 0) rc = mbedtls_chacha20_update(&c->chacha, sizeof poly_key, poly_key, poly_key);
    if (rc == 0) rc = mbedtls_poly1305_starts(&c->poly, poly_key);
    mbedtls_platform_zeroize(poly_key, sizeof poly_key);
    break;
  }
  }
  if (rc != 0) {
    sc_release(c);
    sc_throw(SCR_ERR_ERROR, NULL, "Failed to initialize cipher");
    goto done;
  }
  ScrDynHandleTag tag = decrypt ? SCR_DYNH_DECIPHER : SCR_DYNH_CIPHER;
  scr_dyn_handle_install(tag, decrypt ? &sc_ops_decipher : &sc_ops_cipher);
  result = scr_dyn_new_handle(c, tag); /* retains */
  sc_release(c);
done:
  scr_dyn_release(cts_mode);
  scr_dyn_release(xts_standard);
  scr_bytes_release(iv_bytes);
  scr_bytes_release(key_bytes);
  return result;
}

ScrDyn *scr_crypto_cipher_new(bool decrypt, ScrDyn *cipher, ScrDyn *key, ScrDyn *iv, ScrDyn *options) {
  ScrDyn *args[3] = {cipher, key, iv};
  ScrDyn *unboxed[3] = {NULL, NULL, NULL};
  ScrDyn *result = NULL;
  for (size_t i = 0; i < 3; i++)
    if (!(unboxed[i] = sc_unbox(args[i]))) goto done;
  result = sc_cipher_new(decrypt, unboxed[0], unboxed[1], unboxed[2], options);
done:
  for (size_t i = 0; i < 3; i++) scr_dyn_release(unboxed[i]);
  return result;
}

/* ── the cipher transforms ────────────────────────────────────────────── */

/* Raw CBC over whole blocks. */
static bool sc_cbc_blocks(ScCipher *c, const unsigned char *in, size_t len, unsigned char *out) {
  return mbedtls_aes_crypt_cbc(&c->aes, c->decrypt ? MBEDTLS_AES_DECRYPT : MBEDTLS_AES_ENCRYPT, len, c->block, in,
                               out) == 0;
}

/* OpenSSL's ossl_cipher_generic_block_update for CBC: complete blocks
 * are processed, the remainder is buffered, and a decryption that ends on
 * a block boundary holds the last block back for padding removal. Returns
 * the output length, or -1 when the backend fails; out has room for
 * len + 16 bytes. */
static long sc_cbc_update(ScCipher *c, const unsigned char *in, size_t inl, unsigned char *out) {
  size_t outl = 0;
  size_t nextblocks;
  if (c->bufsz != 0) {
    size_t remain = 16 - c->bufsz;
    if (inl < remain) remain = inl;
    memcpy(c->buf + c->bufsz, in, remain);
    in += remain;
    inl -= remain;
    c->bufsz += remain;
    nextblocks = inl & ~(size_t)15;
  } else {
    nextblocks = inl & ~(size_t)15;
  }
  if (c->bufsz == 16 && (!c->decrypt || inl > 0 || !c->pad)) {
    if (!sc_cbc_blocks(c, c->buf, 16, out)) return -1;
    c->bufsz = 0;
    outl = 16;
    out += 16;
  }
  if (nextblocks > 0) {
    if (c->decrypt && c->pad && nextblocks == inl) nextblocks -= 16;
    if (nextblocks > 0) {
      if (!sc_cbc_blocks(c, in, nextblocks, out)) return -1;
      outl += nextblocks;
      in += nextblocks;
      inl -= nextblocks;
    }
  }
  if (inl != 0) {
    memcpy(c->buf + c->bufsz, in, inl);
    c->bufsz += inl;
  }
  return (long)outl;
}

/* ossl_cipher_generic_block_final for CBC. Returns the output length, -1
 * after throwing OpenSSL's error, or -2 when the backend fails. */
static long sc_cbc_final(ScCipher *c, unsigned char out[16]) {
  if (!c->decrypt) {
    if (c->pad) {
      unsigned char fill = (unsigned char)(16 - c->bufsz);
      for (size_t i = c->bufsz; i < 16; i++) c->buf[i] = fill;
    } else if (c->bufsz == 0) {
      return 0;
    } else if (c->bufsz != 16) {
      sc_throw_openssl("1C80006B", "wrong final block length", "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH");
      return -1;
    }
    if (!sc_cbc_blocks(c, c->buf, 16, out)) return -2;
    c->bufsz = 0;
    return 16;
  }
  if (c->bufsz != 16) {
    if (c->bufsz == 0 && !c->pad) return 0;
    sc_throw_openssl("1C80006B", "wrong final block length", "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH");
    return -1;
  }
  if (!sc_cbc_blocks(c, c->buf, 16, c->buf)) return -2;
  size_t len = 16;
  if (c->pad) {
    unsigned char fill = c->buf[15];
    bool bad = fill == 0 || fill > 16;
    for (size_t i = 0; !bad && i < fill; i++) bad = c->buf[--len] != fill;
    if (bad) {
      sc_throw_openssl("1C800064", "bad decrypt", "ERR_OSSL_BAD_DECRYPT");
      return -1;
    }
  }
  memcpy(out, c->buf, len);
  c->bufsz = 0;
  return (long)len;
}

/* Constant-time comparison of the first len bytes. */
static bool sc_tag_equal(const unsigned char *a, const unsigned char *b, size_t len) {
  unsigned char diff = 0;
  for (size_t i = 0; i < len; i++) diff |= (unsigned char)(a[i] ^ b[i]);
  return diff == 0;
}

/* Poly1305 zero padding to the next 16-byte boundary of `length`. */
static bool sc_poly_pad(ScCipher *c, uint64_t length) {
  static const unsigned char zero[16] = {0};
  size_t rem = (size_t)(length % 16);
  return rem == 0 || mbedtls_poly1305_update(&c->poly, zero, 16 - rem) == 0;
}

/* OpenSSL's chacha20-poly1305 data step: pending AAD is padded first, and
 * the ciphertext feeds Poly1305 unpadded until final(). */
static bool sc_chacha_update(ScCipher *c, const unsigned char *in, size_t len, unsigned char *out) {
  if (c->aad_open) {
    if (!sc_poly_pad(c, c->aad_len)) return false;
    c->aad_open = false;
  }
  if (c->decrypt && mbedtls_poly1305_update(&c->poly, in, len) != 0) return false;
  if (mbedtls_chacha20_update(&c->chacha, len, in, out) != 0) return false;
  if (!c->decrypt && mbedtls_poly1305_update(&c->poly, out, len) != 0) return false;
  c->text_len += len;
  return true;
}

static bool sc_chacha_finish(ScCipher *c, unsigned char tag[16]) {
  if (c->aad_open && !sc_poly_pad(c, c->aad_len)) return false;
  if (!sc_poly_pad(c, c->text_len)) return false;
  unsigned char lengths[16];
  for (size_t i = 0; i < 8; i++) {
    lengths[i] = (unsigned char)(c->aad_len >> (8 * i));
    lengths[8 + i] = (unsigned char)(c->text_len >> (8 * i));
  }
  return mbedtls_poly1305_update(&c->poly, lengths, sizeof lengths) == 0 && mbedtls_poly1305_finish(&c->poly, tag) == 0;
}

/* The cipher output of an update over len bytes (+1 Buffer), or NULL
 * after a backend failure (for example AES-GCM's 2^36 - 32 byte message
 * limit) has retired the context and thrown Node's update error. */
static ScrBytes *sc_transform(ScCipher *c, const unsigned char *in, size_t len) {
  size_t room = len + 16;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)room);
  out->is_buffer = true;
  size_t produced = 0;
  bool ok = true;
  switch (c->mode) {
  case SC_CBC: {
    long n = sc_cbc_update(c, in, len, out->data);
    ok = n >= 0;
    produced = ok ? (size_t)n : 0;
    break;
  }
  case SC_CTR:
    ok = len == 0 || mbedtls_aes_crypt_ctr(&c->aes, len, &c->bufsz, c->block, c->buf, in, out->data) == 0;
    produced = len;
    break;
  case SC_GCM:
    ok = len == 0 || mbedtls_gcm_update(&c->gcm, in, len, out->data, room, &produced) == 0;
    break;
  case SC_CHACHA:
    ok = len == 0 || sc_chacha_update(c, in, len, out->data);
    produced = len;
    break;
  }
  if (!ok) {
    mbedtls_platform_zeroize(out->data, room);
    scr_bytes_release(out);
    sc_fail(c);
    sc_throw(SCR_ERR_ERROR, NULL, "Trying to add data in unsupported state");
    return NULL;
  }
  out->len = produced;
  if (len) c->data_started = true;
  return out;
}

/* ── output encodings ─────────────────────────────────────────────────── */

/* Node's getDecoder: the StringDecoder for this encoding, created on first
 * string output; a different encoding later throws ERR_INVALID_ARG_VALUE. */
static bool sc_decoder(ScCipher *c, const ScrDyn *encoding) {
  const char *name = encoding->kind == SCR_DYN_STR ? sc_normalize_encoding(encoding->v.str) : NULL;
  if (!c->decoder) {
    if (!name) {
      sc_unknown_encoding(encoding);
      return false;
    }
    c->decoder = scr_str_new(name, strlen(name));
    c->pending = 0;
    return true;
  }
  if (name && strcmp(c->decoder->data, name) == 0) return true;
  if (!name) {
    sc_unknown_encoding(encoding);
    return false;
  }
  char rendered[160];
  const char *text = scr_dyn_inspect_lite(encoding, rendered, sizeof rendered);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The argument 'outputEncoding' cannot be changed from '");
  scr_jb_put_str(&b, c->decoder);
  scr_jb_puts(&b, "'. Received ");
  scr_jb_puts(&b, text);
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(message);
  return false;
}

static bool sc_wants_string(const ScrDyn *encoding) {
  if (!scr_dyn_truthy(encoding)) return false;
  return !(encoding->kind == SCR_DYN_STR && encoding->v.str->len == 6 && memcmp(encoding->v.str->data, "buffer", 6) == 0);
}

/* The method result: the Buffer, or its StringDecoder text. Consumes out. */
static ScrDyn *sc_output(ScCipher *c, ScrBytes *out, const ScrDyn *encoding, bool end) {
  if (!sc_wants_string(encoding)) {
    ScrDyn *result = scr_dyn_new_buffer(out);
    scr_bytes_release(out);
    return result;
  }
  if (!sc_decoder(c, encoding)) {
    scr_bytes_release(out);
    return NULL;
  }
  ScrStr *text;
  if (end) {
    ScrStr *head = scr_strdec_write(c->decoder, c->pending, out);
    double next = scr_strdec_next(c->decoder, c->pending, out);
    ScrStr *tail = scr_strdec_end(c->decoder, next);
    text = scr_str_concat(head, tail);
    scr_str_release(head);
    scr_str_release(tail);
    c->pending = 0;
  } else {
    text = scr_strdec_write(c->decoder, c->pending, out);
    c->pending = scr_strdec_next(c->decoder, c->pending, out);
  }
  scr_bytes_release(out);
  ScrDyn *result = scr_dyn_new_str(text);
  scr_str_release(text);
  return result;
}

/* ── methods ──────────────────────────────────────────────────────────── */

static ScrDyn *sc_arg(ScrDyn *const *args, size_t argc, size_t index) {
  return index < argc ? args[index] : scr_dyn_undefined();
}

static ScrDyn *sc_update(ScCipher *c, ScrDyn *data, ScrDyn *input_encoding, ScrDyn *output_encoding) {
  ScrBytes *in = NULL;
  if (data->kind == SCR_DYN_STR) {
    /* validateEncoding: hex input must have an even length. */
    const char *name = input_encoding->kind == SCR_DYN_STR ? sc_normalize_encoding(input_encoding->v.str) : NULL;
    if (name && strcmp(name, "hex") == 0 && (unsigned long)scr_str_utf16_len(data->v.str) % 2 != 0) {
      char rendered[160];
      const char *text = scr_dyn_inspect_lite(input_encoding, rendered, sizeof rendered);
      char message[256];
      snprintf(message, sizeof message, "The argument 'encoding' is invalid for data of length %lu. Received %s",
               (unsigned long)scr_str_utf16_len(data->v.str), text);
      sc_throw(SCR_ERR_TYPE, "ERR_INVALID_ARG_VALUE", message);
      return NULL;
    }
    /* C++ ParseEncoding: unknown names read as utf8. */
    ScrStr *canonical = scr_str_new(name ? name : "utf8", strlen(name ? name : "utf8"));
    in = scr_bytes_from_str(data->v.str, canonical);
    scr_str_release(canonical);
  } else if (sc_is_view(data)) {
    in = sc_bytes_of(data);
  } else {
    scr_dyn_arg_type_fail("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
    return NULL;
  }
  if (!in) return NULL;
  if (!c->active) {
    scr_bytes_release(in);
    sc_throw(SCR_ERR_ERROR, NULL, "Trying to add data in unsupported state");
    return NULL;
  }
  ScrBytes *out = sc_transform(c, in->data, in->len);
  scr_bytes_release(in);
  if (!out) return NULL;
  return sc_output(c, out, output_encoding, false);
}

static bool sc_aead(const ScCipher *c) {
  return c->mode == SC_GCM || c->mode == SC_CHACHA;
}

static ScrDyn *sc_final(ScCipher *c, ScrDyn *output_encoding) {
  if (!c->active) {
    sc_throw(SCR_ERR_ERROR, "ERR_CRYPTO_INVALID_STATE", "Invalid state");
    return NULL;
  }
  c->active = false;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, 16);
  out->is_buffer = true;
  out->len = 0;
  bool ok = true, backend = true;
  switch (c->mode) {
  case SC_CBC: {
    long produced = sc_cbc_final(c, out->data);
    if (produced == -1) {
      scr_bytes_release(out);
      return NULL;
    }
    backend = produced >= 0;
    out->len = backend ? (size_t)produced : 0;
    break;
  }
  case SC_CTR:
    break;
  case SC_GCM: {
    unsigned char full[16];
    size_t ignored;
    backend = mbedtls_gcm_finish(&c->gcm, NULL, 0, &ignored, full, 16) == 0;
    if (!backend) {
      /* No tag is computed or compared. */
    } else if (c->decrypt) {
      ok = c->tag_state == SC_TAG_SET_BY_USER && sc_tag_equal(full, c->tag, (size_t)c->tag_len);
    } else {
      if (c->tag_len == SC_NO_TAG) c->tag_len = 16;
      memcpy(c->tag, full, (size_t)c->tag_len);
      c->tag_state = SC_TAG_COMPUTED;
    }
    mbedtls_platform_zeroize(full, sizeof full);
    break;
  }
  case SC_CHACHA: {
    unsigned char full[16];
    backend = sc_chacha_finish(c, full);
    if (!backend) {
      /* No tag is computed or compared. */
    } else if (c->decrypt) {
      /* Decryption without setAuthTag() fails. Node 24.22 skips the check
       * when authTagLength was not passed either and returns unverified
       * plaintext; this keeps Node 24.15's behavior. */
      ok = c->tag_state == SC_TAG_SET_BY_USER && sc_tag_equal(full, c->tag, (size_t)c->tag_len);
    } else {
      memcpy(c->tag, full, (size_t)c->tag_len);
      c->tag_state = SC_TAG_COMPUTED;
    }
    mbedtls_platform_zeroize(full, sizeof full);
    break;
  }
  }
  if (!backend) {
    mbedtls_platform_zeroize(out->data, 16);
    scr_bytes_release(out);
    sc_fail(c);
    sc_throw(SCR_ERR_ERROR, NULL,
             sc_aead(c) ? "Unsupported state or unable to authenticate data" : "Unsupported state");
    return NULL;
  }
  if (!ok) {
    scr_bytes_release(out);
    sc_throw(SCR_ERR_ERROR, NULL, "Unsupported state or unable to authenticate data");
    return NULL;
  }
  return sc_output(c, out, output_encoding, true);
}

static ScrDyn *sc_set_aad(ScCipher *c, ScrDyn *self, ScrDyn *buffer, ScrDyn *options) {
  bool failed;
  ScrDyn *encoding = sc_string_option(options, "encoding", &failed);
  if (failed) return NULL;
  double plaintext_length = sc_uint_option(options, "plaintextLength");
  if (plaintext_length == -2) {
    scr_dyn_release(encoding);
    return NULL;
  }
  ScrBytes *aad = sc_buffer_or_view(buffer, "aadbuf", encoding);
  scr_dyn_release(encoding);
  if (!aad) return NULL;
  /* After data, GCM refuses any AAD and chacha20-poly1305 refuses
   * non-empty AAD. */
  bool ok = c->active && sc_aead(c) && !(c->data_started && (c->mode == SC_GCM || aad->len > 0));
  bool backend = true;
  if (ok && c->mode == SC_GCM) backend = mbedtls_gcm_update_ad(&c->gcm, aad->data, aad->len) == 0;
  if (ok && c->mode == SC_CHACHA && aad->len > 0) {
    backend = mbedtls_poly1305_update(&c->poly, aad->data, aad->len) == 0;
    c->aad_len += aad->len;
    c->aad_open = true;
  }
  scr_bytes_release(aad);
  if (!backend) {
    sc_fail(c);
    ok = false;
  }
  if (!ok) {
    sc_invalid_state("setAAD");
    return NULL;
  }
  return scr_dyn_retain(self);
}

static ScrDyn *sc_set_auto_padding(ScCipher *c, ScrDyn *self, ScrDyn *const *args, size_t argc) {
  /* The JavaScript wrapper passes !!autoPadding, so a call without an
   * argument turns padding off. */
  bool pad = argc > 0 && scr_dyn_truthy(args[0]);
  if (!c->active) {
    sc_invalid_state("setAutoPadding");
    return NULL;
  }
  c->pad = pad;
  return scr_dyn_retain(self);
}

static ScrDyn *sc_get_auth_tag(ScCipher *c) {
  if (c->active || !sc_aead(c) || c->tag_state != SC_TAG_COMPUTED) {
    sc_invalid_state("getAuthTag");
    return NULL;
  }
  ScrBytes *tag = scr_bytes_new(SCR_BYTES_U8, (double)c->tag_len);
  tag->is_buffer = true;
  memcpy(tag->data, c->tag, (size_t)c->tag_len);
  ScrDyn *result = scr_dyn_new_buffer(tag);
  scr_bytes_release(tag);
  return result;
}

/* DEP0182 is emitted through process.emitWarning, so it reports on the
 * next tick. Node gates it on a one-shot environment flag, so a process
 * reports it at most once. */
static SCR_TL bool sc_dep0182_emitted = false;

static void sc_dep0182_tick(void) {
  static const char message[] = "Using AES-GCM authentication tags of less than 128 bits without specifying "
                                "the authTagLength option when initializing decryption is deprecated.";
  ScrStr *text = scr_str_new(message, sizeof message - 1);
  scr_emit_warning("DeprecationWarning", "DEP0182", text);
  scr_str_release(text);
}

static ScrDyn *sc_set_auth_tag(ScCipher *c, ScrDyn *self, ScrDyn *buffer, ScrDyn *encoding) {
  ScrBytes *tag = sc_buffer_or_view(buffer, "buffer", encoding);
  if (!tag) return NULL;
  if (!c->active || !sc_aead(c) || c->tag_state != SC_TAG_UNKNOWN) {
    scr_bytes_release(tag);
    sc_invalid_state("setAuthTag");
    return NULL;
  }
  size_t len = tag->len;
  bool valid = c->mode == SC_GCM ? (c->tag_len == SC_NO_TAG || (size_t)c->tag_len == len) && sc_valid_gcm_tag(len)
                                 : (size_t)c->tag_len == len;
  if (!valid) {
    scr_bytes_release(tag);
    sc_invalid_tag((unsigned long)len);
    return NULL;
  }
  if (c->mode == SC_GCM && c->tag_len == SC_NO_TAG && len != 16 && !sc_dep0182_emitted) {
    sc_dep0182_emitted = true;
    scr_next_tick_raw(sc_dep0182_tick);
  }
  c->tag_len = (int)len;
  memcpy(c->tag, tag->data, len);
  c->tag_state = SC_TAG_SET_BY_USER;
  scr_bytes_release(tag);
  return scr_dyn_retain(self);
}

static bool sc_name_is(const char *method, const char *name) {
  return strcmp(method, name) == 0;
}

/* stream.Transform members a Cipheriv inherits. */
static bool sc_stream_member(const char *name) {
  static const char *const members[] = {
    "write", "end", "pipe", "unpipe", "on", "once", "off", "addListener", "removeListener",
    "removeAllListeners", "emit", "read", "push", "unshift", "pause", "resume", "destroy",
    "setEncoding", "cork", "uncork", "setDefaultEncoding", "wrap", "prependListener",
    "prependOnceListener", "listeners", "listenerCount", "eventNames", "_transform", "_flush",
    "isPaused", "compose", "toArray", "forEach", "map", "filter", "reduce", "some", "every",
    "find", "drop", "take", "flatMap", "asIndexedPairs", "iterator",
  };
  for (size_t i = 0; i < sizeof members / sizeof members[0]; i++)
    if (strcmp(name, members[i]) == 0) return true;
  return false;
}

static void sc_stream_fence(void) {
  static const char message[] =
    "Cipheriv and Decipheriv stream members have no lowering; call update() and final()";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
}

static ScrDyn *sc_dispatch(ScCipher *c, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                           const char *what) {
  if (sc_name_is(method, "update"))
    return sc_update(c, sc_arg(args, argc, 0), sc_arg(args, argc, 1), sc_arg(args, argc, 2));
  if (sc_name_is(method, "final")) return sc_final(c, sc_arg(args, argc, 0));
  if (sc_name_is(method, "setAAD")) return sc_set_aad(c, self, sc_arg(args, argc, 0), sc_arg(args, argc, 1));
  if (sc_name_is(method, "setAutoPadding")) return sc_set_auto_padding(c, self, args, argc);
  if (!c->decrypt && sc_name_is(method, "getAuthTag")) return sc_get_auth_tag(c);
  if (c->decrypt && sc_name_is(method, "setAuthTag"))
    return sc_set_auth_tag(c, self, sc_arg(args, argc, 0), sc_arg(args, argc, 1));
  if (sc_stream_member(method)) {
    sc_stream_fence();
    return NULL;
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

/* Every method reads at most three arguments. */
static ScrDyn *sc_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                         const char *what) {
  ScrDyn *unboxed[3] = {NULL, NULL, NULL};
  size_t count = argc < 3 ? argc : 3;
  ScrDyn *result = NULL;
  for (size_t i = 0; i < count; i++)
    if (!(unboxed[i] = sc_unbox(args[i]))) goto done;
  result = sc_dispatch(h, self, method, unboxed, count, what);
done:
  for (size_t i = 0; i < count; i++) scr_dyn_release(unboxed[i]);
  return result;
}

static ScrDyn *sc_get(void *h, const char *key, size_t key_len) {
  (void)h; (void)key; (void)key_len;
  static const char message[] =
    "Cipheriv and Decipheriv property reads have no lowering; call update(), final(), setAAD(), "
    "setAutoPadding(), getAuthTag() or setAuthTag()";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static bool sc_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  static const char message[] = "Writing Cipheriv and Decipheriv properties has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return true;
}

static ScrDynHandleOps sc_ops_cipher = {"Cipheriv", sc_retain, sc_release, sc_invoke, sc_get, sc_set, NULL, NULL, NULL};
static ScrDynHandleOps sc_ops_decipher = {"Decipheriv", sc_retain, sc_release, sc_invoke, sc_get, sc_set, NULL, NULL, NULL};
