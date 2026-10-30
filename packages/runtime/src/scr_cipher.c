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
 * compared in constant time. A cipher used as a stream reads and writes
 * through its own native Transform, which the stream unit builds on first
 * use, as Node's LazyTransform is. All arguments are borrowed. */
#include "scr_cipher_names.h"
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/aes.h"
#include "mbedtls/chacha20.h"
#include "mbedtls/des.h"
#include "mbedtls/gcm.h"
#include "mbedtls/poly1305.h"
#include "mbedtls/platform_util.h"

/* SC_CHACHA is chacha20-poly1305; SC_CHACHA20 the bare stream cipher. */
typedef enum {
  SC_CBC,
  SC_CTR,
  SC_GCM,
  SC_CHACHA,
  SC_ECB,
  SC_CFB,
  SC_CFB8,
  SC_CFB1,
  SC_OFB,
  SC_CHACHA20,
  /* CCM and the key wraps stay last: sc_transform tests mode >= SC_CCM. */
  SC_CCM,
  SC_WRAP,     /* RFC 3394 AES key wrap */
  SC_WRAP_PAD, /* RFC 5649 AES key wrap with padding */
} ScCipherMode;

typedef struct {
  const char *name;
  ScCipherMode mode;
  unsigned key_len;
  bool des;     /* triple DES (two- or three-key) rather than AES */
  bool inverse; /* key wrap with the inverse cipher (the -inv names) */
} ScCipherSpec;

/* Node's names for the implemented ciphers, including OpenSSL's aliases.
 * Lookup is case-insensitive, like OpenSSL's, and scans in order, so the
 * CCM and key wrap names follow the others. */
static const ScCipherSpec sc_specs[] = {
  {"aes-128-cbc", SC_CBC, 16},       {"aes-192-cbc", SC_CBC, 24},       {"aes-256-cbc", SC_CBC, 32},
  {"aes128", SC_CBC, 16},            {"aes192", SC_CBC, 24},            {"aes256", SC_CBC, 32},
  {"aes-128-ctr", SC_CTR, 16},       {"aes-192-ctr", SC_CTR, 24},       {"aes-256-ctr", SC_CTR, 32},
  {"aes-128-gcm", SC_GCM, 16},       {"aes-192-gcm", SC_GCM, 24},       {"aes-256-gcm", SC_GCM, 32},
  {"id-aes128-gcm", SC_GCM, 16},     {"id-aes192-gcm", SC_GCM, 24},     {"id-aes256-gcm", SC_GCM, 32},
  {"chacha20-poly1305", SC_CHACHA, 32},
  {"aes-128-ecb", SC_ECB, 16},       {"aes-192-ecb", SC_ECB, 24},       {"aes-256-ecb", SC_ECB, 32},
  {"aes-128-cfb", SC_CFB, 16},       {"aes-192-cfb", SC_CFB, 24},       {"aes-256-cfb", SC_CFB, 32},
  {"aes-128-cfb8", SC_CFB8, 16},     {"aes-192-cfb8", SC_CFB8, 24},     {"aes-256-cfb8", SC_CFB8, 32},
  {"aes-128-cfb1", SC_CFB1, 16},     {"aes-192-cfb1", SC_CFB1, 24},     {"aes-256-cfb1", SC_CFB1, 32},
  {"aes-128-ofb", SC_OFB, 16},       {"aes-192-ofb", SC_OFB, 24},       {"aes-256-ofb", SC_OFB, 32},
  {"des-ede3-cbc", SC_CBC, 24, true}, {"des3", SC_CBC, 24, true},
  {"des-ede3", SC_ECB, 24, true},     {"des-ede3-ecb", SC_ECB, 24, true},
  {"des-ede3-cfb", SC_CFB, 24, true}, {"des-ede3-cfb8", SC_CFB8, 24, true},
  {"des-ede3-cfb1", SC_CFB1, 24, true}, {"des-ede3-ofb", SC_OFB, 24, true},
  {"des-ede-cbc", SC_CBC, 16, true},  {"des-ede", SC_ECB, 16, true},
  {"des-ede-ecb", SC_ECB, 16, true},  {"des-ede-cfb", SC_CFB, 16, true},
  {"des-ede-ofb", SC_OFB, 16, true},
  {"chacha20", SC_CHACHA20, 32},
  {"aes-128-ccm", SC_CCM, 16},       {"aes-192-ccm", SC_CCM, 24},       {"aes-256-ccm", SC_CCM, 32},
  {"id-aes128-ccm", SC_CCM, 16},     {"id-aes192-ccm", SC_CCM, 24},     {"id-aes256-ccm", SC_CCM, 32},
  {"aes-128-wrap", SC_WRAP, 16, false, false},
  {"aes128-wrap", SC_WRAP, 16, false, false},
  {"id-aes128-wrap", SC_WRAP, 16, false, false},
  {"aes-128-wrap-inv", SC_WRAP, 16, false, true},
  {"aes128-wrap-inv", SC_WRAP, 16, false, true},
  {"aes-128-wrap-pad", SC_WRAP_PAD, 16, false, false},
  {"aes128-wrap-pad", SC_WRAP_PAD, 16, false, false},
  {"id-aes128-wrap-pad", SC_WRAP_PAD, 16, false, false},
  {"aes-128-wrap-pad-inv", SC_WRAP_PAD, 16, false, true},
  {"aes128-wrap-pad-inv", SC_WRAP_PAD, 16, false, true},
  {"aes-192-wrap", SC_WRAP, 24, false, false},
  {"aes192-wrap", SC_WRAP, 24, false, false},
  {"id-aes192-wrap", SC_WRAP, 24, false, false},
  {"aes-192-wrap-inv", SC_WRAP, 24, false, true},
  {"aes192-wrap-inv", SC_WRAP, 24, false, true},
  {"aes-192-wrap-pad", SC_WRAP_PAD, 24, false, false},
  {"aes192-wrap-pad", SC_WRAP_PAD, 24, false, false},
  {"id-aes192-wrap-pad", SC_WRAP_PAD, 24, false, false},
  {"aes-192-wrap-pad-inv", SC_WRAP_PAD, 24, false, true},
  {"aes192-wrap-pad-inv", SC_WRAP_PAD, 24, false, true},
  {"aes-256-wrap", SC_WRAP, 32, false, false},
  {"aes256-wrap", SC_WRAP, 32, false, false},
  {"id-aes256-wrap", SC_WRAP, 32, false, false},
  {"aes-256-wrap-inv", SC_WRAP, 32, false, true},
  {"aes256-wrap-inv", SC_WRAP, 32, false, true},
  {"aes-256-wrap-pad", SC_WRAP_PAD, 32, false, false},
  {"aes256-wrap-pad", SC_WRAP_PAD, 32, false, false},
  {"id-aes256-wrap-pad", SC_WRAP_PAD, 32, false, false},
  {"aes-256-wrap-pad-inv", SC_WRAP_PAD, 32, false, true},
  {"aes256-wrap-pad-inv", SC_WRAP_PAD, 32, false, true},
};

/* Ciphers OpenSSL 3 keeps in its legacy provider, which Node 24 does not
 * load: crypto.getCipherInfo() knows them, and createCipheriv checks their
 * IV length, then fails with OpenSSL's "unsupported" error. */
static const struct {
  const char *name;
  unsigned iv_len;
} sc_legacy[] = {SCR_CIPHER_LEGACY_ENTRIES};

/* crypto.getCiphers() on Node 24.22 (OpenSSL 3.5). Names in this list that
 * have no implementation throw a coded SC2020 error instead of Node's
 * ERR_CRYPTO_UNKNOWN_CIPHER. */
static const char *const sc_known[] = {SCR_CIPHER_KNOWN_NAMES};

enum { SC_NO_TAG = -1 };
enum { SC_TAG_UNKNOWN, SC_TAG_SET_BY_USER, SC_TAG_COMPUTED };

typedef struct ScCipher {
  size_t rc;
  ScCipherMode mode;
  bool decrypt;
  bool active;       /* false after final() or a failed backend call */
  bool pad;          /* CBC and ECB automatic padding */
  bool des;          /* triple DES rather than AES */
  unsigned bs;       /* the block size: 16 for AES, 8 for triple DES */
  bool data_started; /* a non-empty update() ran, so non-empty AAD is refused */
  int tag_len;       /* SC_NO_TAG until known */
  int tag_state;
  unsigned char tag[16];
  unsigned char block[16]; /* CBC: chaining value; CTR: counter block; CFB, OFB:
                              shift register; chacha20, CCM: the IV; key wrap:
                              the integrity check value */
  unsigned char buf[16];   /* CBC, ECB: buffered input; CTR: keystream block */
  size_t bufsz;            /* CBC, ECB: buffered bytes; CTR, CFB, OFB: keystream
                              offset */
  uint64_t chacha_left;    /* chacha20: bytes before the low counter word wraps */
  mbedtls_aes_context aes;
  mbedtls_des3_context des3;
  mbedtls_gcm_context gcm;
  mbedtls_chacha20_context chacha;
  mbedtls_poly1305_context poly;
  uint64_t aad_len;  /* chacha20-poly1305 AAD bytes */
  uint64_t text_len; /* chacha20-poly1305 data bytes */
  bool aad_open;     /* AAD was added since the last data or padding */
  /* CCM: OpenSSL's ccm128 state (the counter block, whose first byte holds
   * the L and M parameters and the Adata flag, and the CBC-MAC), its
   * provider's flags, and Node's one-update rule. A decipher's expected
   * tag is `tag`. */
  size_t ccm_iv_len;
  unsigned char ccm_nonce[16];
  unsigned char ccm_cmac[16];
  bool ccm_iv_set, ccm_len_set, ccm_tag_set;
  bool ccm_updated;      /* a decipher's one update() ran; key wrap: the one update() */
  bool ccm_auth_failed;  /* that update failed to authenticate */
  bool ccm_verified;     /* a decipher's tag matched the one it computed */
  double ccm_max_message;
  bool wrap_decrypt_block; /* key wrap: the AES key schedule decrypts */
  ScrStr *decoder; /* the StringDecoder encoding once string output starts */
  double pending;  /* the decoder's carried bytes */
  /* The Transform of a cipher used as a stream (+1) and its release
   * (scr_stream.c). Its steps hold the cipher, so the cipher is a
   * collector-headered object behind a traced handle, and the pair is
   * reclaimed as a cycle. */
  void *stream;
  void (*stream_release)(void *);
} ScCipher;

static void *sc_retain(void *h) {
  ((ScCipher *)h)->rc++;
  return h;
}

static void sc_trace(void *h, ScrTraceVisit visit, void *ctx) {
  ScCipher *c = h;
  if (c->stream) visit(c->stream, ctx);
}

/* The collector frees the stream itself; the rest is released here. */
static void sc_gcfree(void *h) {
  ScCipher *c = h;
  mbedtls_aes_free(&c->aes);
  mbedtls_des3_free(&c->des3);
  mbedtls_gcm_free(&c->gcm);
  mbedtls_chacha20_free(&c->chacha);
  mbedtls_poly1305_free(&c->poly);
  scr_str_release(c->decoder);
  mbedtls_platform_zeroize(c, sizeof *c);
  scr_obj_free_note();
  scr_cyc_free(c);
}

static void sc_destroy(void *h) {
  ScCipher *c = h;
  void *stream = c->stream;
  c->stream = NULL;
  if (stream) c->stream_release(stream);
  sc_gcfree(c);
}

static void sc_release(void *h) {
  ScCipher *c = h;
  if (--c->rc == 0) {
    scr_cyc_dead(c);
    scr_rc_destroy(c, sc_destroy);
  } else scr_cyc_released(c);
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
/* OpenSSL's error with its library, reason and error stack; Node's
 * code. */
static void sc_throw_openssl_in(const char *packed, const char *library, const char *reason,
                                const char *code) {
  char message[128];
  snprintf(message, sizeof message, "error:%s:%s::%s", packed, library, reason);
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  ScrDyn *stack = scr_dyn_new_arr();
  scr_dyn_arr_push(stack, scr_dyn_new_str(text));
  scr_str_release(text);
  scr_error_set_prop(e, "opensslErrorStack", 17, stack);
  ScrStr *library_text = scr_str_new(library, strlen(library));
  scr_error_set_prop(e, "library", 7, scr_dyn_new_str(library_text));
  scr_str_release(library_text);
  ScrStr *reason_text = scr_str_new(reason, strlen(reason));
  scr_error_set_prop(e, "reason", 6, scr_dyn_new_str(reason_text));
  scr_str_release(reason_text);
  scr_error_set_code(e, code);
  ScrStr *code_text = scr_str_new(code, strlen(code));
  scr_error_set_prop(e, "code", 4, scr_dyn_new_str(code_text));
  scr_str_release(code_text);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

static void sc_throw_openssl(const char *packed, const char *reason, const char *code) {
  sc_throw_openssl_in(packed, "Provider routines", reason, code);
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
  /* Node prints a function's source text and calls a class's toString. */
  if (value->kind == SCR_DYN_FUNC || sc_class_to_string(value)) {
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

/* The legacy-provider IV length of `name`, or -1 for other names. */
static int sc_legacy_iv(const ScrStr *name) {
  for (size_t i = 0; i < sizeof sc_legacy / sizeof sc_legacy[0]; i++)
    if (sc_ascii_eq_ci(name->data, name->len, sc_legacy[i].name)) return (int)sc_legacy[i].iv_len;
  return -1;
}

/* The IV length a mode takes; SC_GCM takes any nonzero length. */
static size_t sc_iv_length(ScCipherMode mode, bool des) {
  switch (mode) {
  case SC_ECB:
    return 0;
  case SC_CHACHA:
    return 12;
  case SC_CHACHA20:
    return 16;
  case SC_WRAP:
    return 8;
  case SC_WRAP_PAD:
    return 4;
  default:
    return des ? 8 : 16;
  }
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
  scr_jb_puts(&b, "' has no native implementation; the supported ciphers are aes-128, aes-192 and "
                  "aes-256 in cbc, ctr, gcm, ccm, ecb, cfb, cfb8, cfb1 and ofb modes and their wrap, "
                  "wrap-pad, wrap-inv and wrap-pad-inv key wraps, des-ede3 in cbc, ecb, cfb, cfb8, cfb1 "
                  "and ofb modes, des-ede in cbc, ecb, cfb and ofb modes, chacha20 and chacha20-poly1305");
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
  size_t iv_len = iv_bytes ? iv_bytes->len : 0;
  if (!spec) {
    int legacy_iv = sc_legacy_iv(cipher->v.str);
    if (legacy_iv >= 0) {
      if (iv_len != (size_t)legacy_iv || (legacy_iv > 0 && !iv_bytes))
        sc_throw(SCR_ERR_TYPE, "ERR_CRYPTO_INVALID_IV", "Invalid initialization vector");
      else
        sc_throw_openssl_in("0308010C", "digital envelope routines", "unsupported",
                            "ERR_OSSL_EVP_UNSUPPORTED");
    } else if (sc_known_name(cipher->v.str)) {
      sc_unsupported_cipher(cipher->v.str);
    } else {
      sc_throw(SCR_ERR_ERROR, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
    }
    goto done;
  }
  size_t expected_iv = sc_iv_length(spec->mode, spec->des);
  bool iv_ok = spec->mode == SC_GCM   ? iv_len > 0
               : spec->mode == SC_CCM ? iv_len >= 7 && iv_len <= 13
                                      : iv_len == expected_iv && (expected_iv == 0 || iv_bytes);
  if (!iv_ok) {
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
  } else if (spec->mode == SC_CCM) {
    /* InitAuthenticated: CCM needs the tag length, which OpenSSL takes when
     * it is even and 4 to 16 bytes. */
    if (tag_option < 0) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "authTagLength required for ");
      scr_jb_put_str(&b, cipher->v.str);
      ScrStr *message = scr_jb_finish(&b);
      scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_CRYPTO_INVALID_AUTH_TAG");
      scr_str_release(message);
      goto done;
    }
    if (tag_option < 4 || tag_option > 16 || (unsigned long)tag_option % 2 != 0) {
      sc_invalid_tag((unsigned long)tag_option);
      goto done;
    }
    tag_len = (int)tag_option;
  }
  if (key_bytes->len != spec->key_len) {
    sc_throw(SCR_ERR_RANGE, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
    goto done;
  }
  static ScrCycType cyc_type = {&sc_trace, &sc_gcfree, SCR_CYC_KIND_NONE, 0};
  ScCipher *c = scr_cyc_alloc(sizeof *c, &cyc_type);
  c->rc = 1;
  scr_obj_alloc_note();
  c->mode = spec->mode;
  c->decrypt = decrypt;
  c->active = true;
  c->pad = true;
  c->des = spec->des;
  c->bs = spec->des ? 8 : 16;
  c->tag_len = tag_len;
  mbedtls_aes_init(&c->aes);
  mbedtls_des3_init(&c->des3);
  mbedtls_gcm_init(&c->gcm);
  mbedtls_chacha20_init(&c->chacha);
  mbedtls_poly1305_init(&c->poly);
  int rc = 0;
  unsigned bits = spec->key_len * 8;
  switch (spec->mode) {
  case SC_CBC:
  case SC_ECB:
  case SC_CFB:
  case SC_CFB8:
  case SC_CFB1:
  case SC_OFB: {
    /* CBC and ECB decrypt with the inverse cipher; the feedback modes run
     * the forward cipher both ways. */
    bool inverse = decrypt && (spec->mode == SC_CBC || spec->mode == SC_ECB);
    if (spec->des && spec->key_len == 24)
      rc = inverse ? mbedtls_des3_set3key_dec(&c->des3, key_bytes->data)
                   : mbedtls_des3_set3key_enc(&c->des3, key_bytes->data);
    else if (spec->des)
      rc = inverse ? mbedtls_des3_set2key_dec(&c->des3, key_bytes->data)
                   : mbedtls_des3_set2key_enc(&c->des3, key_bytes->data);
    else
      rc = inverse ? mbedtls_aes_setkey_dec(&c->aes, key_bytes->data, bits)
                   : mbedtls_aes_setkey_enc(&c->aes, key_bytes->data, bits);
    if (expected_iv) memcpy(c->block, iv_bytes->data, expected_iv);
    break;
  }
  case SC_CHACHA20:
    /* OpenSSL's IV is a 64-bit little-endian block counter and an 8-byte
     * nonce; mbedTLS takes a 32-bit counter and a 12-byte nonce, so the
     * stream restarts each time the low counter word wraps. */
    memcpy(c->block, iv_bytes->data, 16);
    rc = mbedtls_chacha20_setkey(&c->chacha, key_bytes->data);
    if (rc == 0) {
      uint32_t low = (uint32_t)c->block[0] | (uint32_t)c->block[1] << 8 |
                     (uint32_t)c->block[2] << 16 | (uint32_t)c->block[3] << 24;
      c->chacha_left = ((uint64_t)1 << 32) - low;
      c->chacha_left *= 64;
      rc = mbedtls_chacha20_starts(&c->chacha, c->block + 4, low);
    }
    break;
  case SC_CTR:
    rc = mbedtls_aes_setkey_enc(&c->aes, key_bytes->data, bits);
    memcpy(c->block, iv_bytes->data, 16);
    break;
  case SC_WRAP:
  case SC_WRAP_PAD:
    /* SP 800-38F: wrapping is the forward transformation (encryption) and
     * unwrapping the inverse, and the -inv ciphers swap the two. The IV is
     * the wrap's integrity check value. */
    rc = decrypt != spec->inverse ? mbedtls_aes_setkey_dec(&c->aes, key_bytes->data, bits)
                                  : mbedtls_aes_setkey_enc(&c->aes, key_bytes->data, bits);
    c->wrap_decrypt_block = decrypt != spec->inverse;
    memcpy(c->block, iv_bytes->data, iv_len);
    break;
  case SC_CCM: {
    /* CRYPTO_ccm128_init with M = the tag length and L = 15 - the IV
     * length; Node caps the message at what a 12- or 13-byte IV's length
     * field holds, and at INT_MAX otherwise. */
    rc = mbedtls_aes_setkey_enc(&c->aes, key_bytes->data, bits);
    unsigned L = 15 - (unsigned)iv_len;
    c->ccm_nonce[0] = (unsigned char)(((L - 1) & 7) | ((((unsigned)tag_len - 2) / 2) & 7) << 3);
    memcpy(c->block, iv_bytes->data, iv_len);
    c->ccm_iv_len = iv_len;
    c->ccm_iv_set = true;
    c->ccm_max_message = iv_len == 13 ? 65535 : iv_len == 12 ? 16777215 : 2147483647;
    break;
  }
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

/* Raw CBC or ECB over whole blocks. */
static bool sc_cbc_blocks(ScCipher *c, const unsigned char *in, size_t len, unsigned char *out) {
  if (c->mode == SC_ECB) {
    for (size_t off = 0; off < len; off += c->bs) {
      int rc = c->des ? mbedtls_des3_crypt_ecb(&c->des3, in + off, out + off)
                      : mbedtls_aes_crypt_ecb(&c->aes, c->decrypt ? MBEDTLS_AES_DECRYPT : MBEDTLS_AES_ENCRYPT,
                                              in + off, out + off);
      if (rc != 0) return false;
    }
    return true;
  }
  if (c->des)
    return mbedtls_des3_crypt_cbc(&c->des3, c->decrypt ? MBEDTLS_DES_DECRYPT : MBEDTLS_DES_ENCRYPT, len, c->block,
                                  in, out) == 0;
  return mbedtls_aes_crypt_cbc(&c->aes, c->decrypt ? MBEDTLS_AES_DECRYPT : MBEDTLS_AES_ENCRYPT, len, c->block, in,
                               out) == 0;
}

/* One forward block of the feedback modes' cipher. */
static bool sc_forward(ScCipher *c, const unsigned char *in, unsigned char *out) {
  return (c->des ? mbedtls_des3_crypt_ecb(&c->des3, in, out)
                 : mbedtls_aes_crypt_ecb(&c->aes, MBEDTLS_AES_ENCRYPT, in, out)) == 0;
}

/* CFB (full-block feedback), CFB8, CFB1 and OFB, as OpenSSL's
 * CRYPTO_cfb128_encrypt, CRYPTO_cfb128_8_encrypt, CRYPTO_cfb128_1_encrypt
 * and CRYPTO_ofb128_encrypt: CFB and OFB keep their keystream offset across
 * updates; CFB1 feeds back one bit at a time, most significant first. */
static bool sc_feedback(ScCipher *c, const unsigned char *in, size_t len, unsigned char *out) {
  unsigned char stream[16];
  size_t bs = c->bs;
  for (size_t i = 0; i < len; i++) {
    switch (c->mode) {
    case SC_CFB:
    case SC_OFB:
      if (c->bufsz == 0 && !sc_forward(c, c->block, c->block)) return false;
      out[i] = (unsigned char)(in[i] ^ c->block[c->bufsz]);
      if (c->mode == SC_CFB) c->block[c->bufsz] = c->decrypt ? in[i] : out[i];
      c->bufsz = (c->bufsz + 1) % bs;
      break;
    case SC_CFB8: {
      if (!sc_forward(c, c->block, stream)) return false;
      unsigned char byte = (unsigned char)(in[i] ^ stream[0]);
      memmove(c->block, c->block + 1, bs - 1);
      c->block[bs - 1] = c->decrypt ? in[i] : byte;
      out[i] = byte;
      break;
    }
    default: {
      unsigned char result = 0;
      for (int bit = 7; bit >= 0; bit--) {
        if (!sc_forward(c, c->block, stream)) return false;
        unsigned in_bit = (in[i] >> bit) & 1u;
        unsigned out_bit = in_bit ^ (stream[0] >> 7);
        unsigned feed = c->decrypt ? in_bit : out_bit;
        for (size_t k = 0; k + 1 < bs; k++)
          c->block[k] = (unsigned char)(c->block[k] << 1 | c->block[k + 1] >> 7);
        c->block[bs - 1] = (unsigned char)(c->block[bs - 1] << 1 | feed);
        result |= (unsigned char)(out_bit << bit);
      }
      out[i] = result;
      break;
    }
    }
  }
  mbedtls_platform_zeroize(stream, sizeof stream);
  return true;
}

/* chacha20 over len bytes: when the 64-bit counter's low word wraps, the
 * high word steps (and wraps itself, as OpenSSL's does) and the stream
 * restarts from block 0 of the next word. */
static bool sc_chacha20_update(ScCipher *c, const unsigned char *in, size_t len, unsigned char *out) {
  while (len > 0) {
    size_t n = len < c->chacha_left ? len : (size_t)c->chacha_left;
    if (mbedtls_chacha20_update(&c->chacha, n, in, out) != 0) return false;
    in += n;
    out += n;
    len -= n;
    c->chacha_left -= n;
    if (c->chacha_left == 0) {
      for (int k = 4; k < 8 && ++c->block[k] == 0; k++) {
      }
      memset(c->block, 0, 4);
      c->chacha_left = (uint64_t)1 << 38;
      if (mbedtls_chacha20_starts(&c->chacha, c->block + 4, 0) != 0) return false;
    }
  }
  return true;
}

/* OpenSSL's ossl_cipher_generic_block_update for CBC and ECB: complete
 * blocks are processed, the remainder is buffered, and a decryption that
 * ends on a block boundary holds the last block back for padding removal.
 * Returns the output length, or -1 when the backend fails; out has room
 * for len + 16 bytes. */
static long sc_cbc_update(ScCipher *c, const unsigned char *in, size_t inl, unsigned char *out) {
  size_t bs = c->bs;
  size_t outl = 0;
  size_t nextblocks;
  if (c->bufsz != 0) {
    size_t remain = bs - c->bufsz;
    if (inl < remain) remain = inl;
    memcpy(c->buf + c->bufsz, in, remain);
    in += remain;
    inl -= remain;
    c->bufsz += remain;
  }
  nextblocks = inl - inl % bs;
  if (c->bufsz == bs && (!c->decrypt || inl > 0 || !c->pad)) {
    if (!sc_cbc_blocks(c, c->buf, bs, out)) return -1;
    c->bufsz = 0;
    outl = bs;
    out += bs;
  }
  if (nextblocks > 0) {
    if (c->decrypt && c->pad && nextblocks == inl) nextblocks -= bs;
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

/* ossl_cipher_generic_block_final for CBC and ECB. Returns the output
 * length, -1 after throwing OpenSSL's error, or -2 when the backend
 * fails. */
static long sc_cbc_final(ScCipher *c, unsigned char out[16]) {
  size_t bs = c->bs;
  if (!c->decrypt) {
    if (c->pad) {
      unsigned char fill = (unsigned char)(bs - c->bufsz);
      for (size_t i = c->bufsz; i < bs; i++) c->buf[i] = fill;
    } else if (c->bufsz == 0) {
      return 0;
    } else if (c->bufsz != bs) {
      sc_throw_openssl("1C80006B", "wrong final block length", "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH");
      return -1;
    }
    if (!sc_cbc_blocks(c, c->buf, bs, out)) return -2;
    c->bufsz = 0;
    return (long)bs;
  }
  if (c->bufsz != bs) {
    if (c->bufsz == 0 && !c->pad) return 0;
    sc_throw_openssl("1C80006B", "wrong final block length", "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH");
    return -1;
  }
  if (!sc_cbc_blocks(c, c->buf, bs, c->buf)) return -2;
  size_t len = bs;
  if (c->pad) {
    unsigned char fill = c->buf[bs - 1];
    bool bad = fill == 0 || fill > bs;
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
static ScrBytes *sc_ccm_update(ScCipher *c, const unsigned char *in, size_t len);
static ScrBytes *sc_wrap_update(ScCipher *c, const unsigned char *in, size_t len);

static ScrBytes *sc_transform(ScCipher *c, const unsigned char *in, size_t len) {
  /* CCM and the key wraps, the last modes, take their own update. */
  if (c->mode >= SC_CCM) return c->mode == SC_CCM ? sc_ccm_update(c, in, len) : sc_wrap_update(c, in, len);
  size_t room = len + 16;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)room);
  out->is_buffer = true;
  size_t produced = 0;
  bool ok = true;
  switch (c->mode) {
  case SC_CBC:
  case SC_ECB: {
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
  case SC_CFB:
  case SC_CFB8:
  case SC_CFB1:
  case SC_OFB:
    ok = sc_feedback(c, in, len, out->data);
    produced = len;
    break;
  case SC_CHACHA20:
    ok = len == 0 || sc_chacha20_update(c, in, len, out->data);
    produced = len;
    break;
  case SC_CCM:
  case SC_WRAP:
  case SC_WRAP_PAD:
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

/* ── CCM ──────────────────────────────────────────────────────────────
 * OpenSSL's ccm128 (crypto/modes/ccm128.c) over the AES block, step for
 * step, with its provider's flags (ciphercommon_ccm.c) and Node's rules
 * (one update, the message-length cap, a decipher's failure reported by
 * final()), so every call sequence answers as Node's does. */

static void sc_ccm_block(ScCipher *c, const unsigned char in[16], unsigned char out[16]) {
  mbedtls_aes_crypt_ecb(&c->aes, MBEDTLS_AES_ENCRYPT, in, out);
}

/* CRYPTO_ccm128_setiv: the nonce and the message length. */
static void sc_ccm_setiv(ScCipher *c, uint64_t mlen) {
  unsigned L = c->ccm_nonce[0] & 7;
  if (L >= 3) {
    c->ccm_nonce[8] = (unsigned char)(mlen >> 56);
    c->ccm_nonce[9] = (unsigned char)(mlen >> 48);
    c->ccm_nonce[10] = (unsigned char)(mlen >> 40);
    c->ccm_nonce[11] = (unsigned char)(mlen >> 32);
  } else {
    memset(c->ccm_nonce + 8, 0, 8);
  }
  c->ccm_nonce[12] = (unsigned char)(mlen >> 24);
  c->ccm_nonce[13] = (unsigned char)(mlen >> 16);
  c->ccm_nonce[14] = (unsigned char)(mlen >> 8);
  c->ccm_nonce[15] = (unsigned char)mlen;
  c->ccm_nonce[0] &= (unsigned char)~0x40;
  memcpy(c->ccm_nonce + 1, c->block, 14 - L);
}

/* CRYPTO_ccm128_aad. */
static void sc_ccm_aad(ScCipher *c, const unsigned char *aad, size_t alen) {
  if (alen == 0) return;
  c->ccm_nonce[0] |= 0x40;
  sc_ccm_block(c, c->ccm_nonce, c->ccm_cmac);
  size_t i;
  if (alen < 0x10000 - 0x100) {
    c->ccm_cmac[0] ^= (unsigned char)(alen >> 8);
    c->ccm_cmac[1] ^= (unsigned char)alen;
    i = 2;
  } else if ((uint64_t)alen >= (uint64_t)1 << 32) {
    c->ccm_cmac[0] ^= 0xFF;
    c->ccm_cmac[1] ^= 0xFF;
    for (int k = 0; k < 8; k++) c->ccm_cmac[2 + k] ^= (unsigned char)((uint64_t)alen >> (56 - 8 * k));
    i = 10;
  } else {
    c->ccm_cmac[0] ^= 0xFF;
    c->ccm_cmac[1] ^= 0xFE;
    for (int k = 0; k < 4; k++) c->ccm_cmac[2 + k] ^= (unsigned char)((uint64_t)alen >> (24 - 8 * k));
    i = 6;
  }
  do {
    for (; i < 16 && alen; ++i, ++aad, --alen) c->ccm_cmac[i] ^= *aad;
    sc_ccm_block(c, c->ccm_cmac, c->ccm_cmac);
    i = 0;
  } while (alen);
}

/* ctr64_inc: the counter block's low eight bytes, big-endian. */
static void sc_ccm_ctr_inc(unsigned char *counter) {
  for (int n = 15; n >= 8; n--)
    if (++counter[n]) return;
}

/* CRYPTO_ccm128_encrypt and CRYPTO_ccm128_decrypt: false (-1) for a
 * length that differs from the one the counter block holds. */
static bool sc_ccm_crypt(ScCipher *c, const unsigned char *in, unsigned char *out, size_t len, bool decrypt) {
  unsigned char flags0 = c->ccm_nonce[0];
  unsigned char scratch[16];
  if (!(flags0 & 0x40)) sc_ccm_block(c, c->ccm_nonce, c->ccm_cmac);
  unsigned L = flags0 & 7;
  c->ccm_nonce[0] = (unsigned char)L;
  uint64_t n = 0;
  for (unsigned i = 15 - L; i < 15; ++i) {
    n |= c->ccm_nonce[i];
    c->ccm_nonce[i] = 0;
    n <<= 8;
  }
  n |= c->ccm_nonce[15];
  c->ccm_nonce[15] = 1;
  if (n != (uint64_t)len) return false;
  /* Each full block runs the counter block's encryption before the
   * CBC-MAC's, in both directions, and XORs in 64-bit words, so the two
   * AES operations of a block overlap. `out` may be `in`. */
  while (len >= 16) {
    uint64_t data[2], mac[2], pad[2];
    sc_ccm_block(c, c->ccm_nonce, scratch);
    sc_ccm_ctr_inc(c->ccm_nonce);
    memcpy(data, in, 16);
    memcpy(mac, c->ccm_cmac, 16);
    memcpy(pad, scratch, 16);
    pad[0] ^= data[0];
    pad[1] ^= data[1];
    /* The MAC covers the plaintext: the input when encrypting, the output
     * when decrypting. */
    mac[0] ^= decrypt ? pad[0] : data[0];
    mac[1] ^= decrypt ? pad[1] : data[1];
    memcpy(out, pad, 16);
    memcpy(c->ccm_cmac, mac, 16);
    sc_ccm_block(c, c->ccm_cmac, c->ccm_cmac);
    in += 16;
    out += 16;
    len -= 16;
  }
  if (len) {
    if (decrypt) {
      sc_ccm_block(c, c->ccm_nonce, scratch);
      for (size_t i = 0; i < len; ++i) c->ccm_cmac[i] ^= (out[i] = (unsigned char)(scratch[i] ^ in[i]));
      sc_ccm_block(c, c->ccm_cmac, c->ccm_cmac);
    } else {
      for (size_t i = 0; i < len; ++i) c->ccm_cmac[i] ^= in[i];
      sc_ccm_block(c, c->ccm_cmac, c->ccm_cmac);
      sc_ccm_block(c, c->ccm_nonce, scratch);
      for (size_t i = 0; i < len; ++i) out[i] = (unsigned char)(scratch[i] ^ in[i]);
    }
  }
  for (unsigned i = 15 - L; i < 16; ++i) c->ccm_nonce[i] = 0;
  sc_ccm_block(c, c->ccm_nonce, scratch);
  for (int i = 0; i < 16; i++) c->ccm_cmac[i] ^= scratch[i];
  c->ccm_nonce[0] = flags0;
  mbedtls_platform_zeroize(scratch, sizeof scratch);
  return true;
}

/* CRYPTO_ccm128_tag: the MAC, when the counter block still holds the
 * tag length M (a failed call clears it). */
static bool sc_ccm_tag(const ScCipher *c, unsigned char *tag) {
  unsigned M = ((c->ccm_nonce[0] >> 3) & 7) * 2 + 2;
  if (M != (unsigned)c->tag_len) return false;
  memcpy(tag, c->ccm_cmac, M);
  return true;
}

/* The provider's ccm_cipher_internal for data (`out` given): the length
 * is set by the first data unless setAAD set it; encryption marks the tag
 * computed; decryption needs the tag and checks it, and on success clears
 * the flags so a second call fails. */
static bool sc_ccm_data(ScCipher *c, const unsigned char *in, unsigned char *out, size_t len) {
  if (!c->ccm_iv_set) return false;
  if (!c->ccm_len_set) {
    sc_ccm_setiv(c, len);
    c->ccm_len_set = true;
  }
  if (!c->decrypt) {
    if (!sc_ccm_crypt(c, in, out, len, false)) return false;
    c->ccm_tag_set = true;
    return true;
  }
  if (!c->ccm_tag_set) return false;
  unsigned char computed[16];
  bool ok = sc_ccm_crypt(c, in, out, len, true) && sc_ccm_tag(c, computed) &&
            sc_tag_equal(computed, c->tag, (size_t)c->tag_len);
  mbedtls_platform_zeroize(computed, sizeof computed);
  if (!ok) {
    if (len) mbedtls_platform_zeroize(out, len);
    return false;
  }
  c->ccm_iv_set = c->ccm_tag_set = c->ccm_len_set = false;
  c->ccm_verified = true;
  return true;
}

static bool sc_ccm_length_ok(const ScCipher *c, double len) {
  if (len <= c->ccm_max_message) return true;
  sc_throw(SCR_ERR_RANGE, "ERR_CRYPTO_INVALID_MESSAGELEN", "Invalid message length");
  return false;
}

/* update(): a decipher takes one, and its authentication failure leaves
 * empty output for final() to report. A decipher authenticates even an
 * empty message, as OpenSSL does: its tag still covers the nonce, the AAD
 * and the length. A cipher's empty update is skipped, and final() then
 * runs the empty message. */
static ScrBytes *sc_ccm_update(ScCipher *c, const unsigned char *in, size_t len) {
  if (!sc_ccm_length_ok(c, (double)len)) return NULL;
  if (c->decrypt && c->ccm_updated) {
    sc_throw(SCR_ERR_ERROR, NULL, "Trying to add data in unsupported state");
    return NULL;
  }
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)(len ? len : 1));
  out->is_buffer = true;
  bool ok = (len == 0 && !c->decrypt) || sc_ccm_data(c, len ? in : out->data, out->data, len);
  if (c->decrypt) {
    c->ccm_updated = true;
    if (!ok) c->ccm_auth_failed = true;
    out->len = ok ? len : 0;
    return out;
  }
  if (!ok) {
    mbedtls_platform_zeroize(out->data, len);
    scr_bytes_release(out);
    sc_throw(SCR_ERR_ERROR, NULL, "Trying to add data in unsupported state");
    return NULL;
  }
  out->len = len;
  return out;
}

/* final(): a decipher succeeds only when its update verified the tag; a
 * cipher runs the provider's final (an empty message when no data was
 * encrypted) and reads the tag, which retires the provider's state. */
static bool sc_ccm_final(ScCipher *c) {
  if (c->decrypt) return c->tag_state == SC_TAG_SET_BY_USER && c->ccm_verified;
  unsigned char dummy = 0, sink = 0;
  if (c->ccm_iv_set && !c->ccm_tag_set && !sc_ccm_data(c, &dummy, &sink, 0)) return false;
  if (!c->ccm_tag_set || !sc_ccm_tag(c, c->tag)) return false;
  c->tag_state = SC_TAG_COMPUTED;
  c->ccm_tag_set = c->ccm_iv_set = c->ccm_len_set = false;
  return true;
}

/* setAAD(buffer, { plaintextLength }): the length goes first, as Node
 * passes it to OpenSSL, then the AAD. False when the provider refuses. */
static bool sc_ccm_set_aad(ScCipher *c, const ScrBytes *aad, double plaintext_length) {
  if (!c->ccm_iv_set) return false;
  sc_ccm_setiv(c, (uint64_t)plaintext_length);
  c->ccm_len_set = true;
  sc_ccm_aad(c, aad->data, aad->len);
  return true;
}

/* ── key wrap ─────────────────────────────────────────────────────────
 * OpenSSL's CRYPTO_128_wrap, CRYPTO_128_unwrap and their RFC 5649
 * padded forms (crypto/modes/wrap128.c) over the key's AES transform, and
 * Node's one-update rule: a failed update() leaves the cipher usable, an
 * empty one counts, and final() without one fails. */

static void sc_wrap_block(ScCipher *c, const unsigned char in[16], unsigned char out[16]) {
  mbedtls_aes_crypt_ecb(&c->aes, c->wrap_decrypt_block ? MBEDTLS_AES_DECRYPT : MBEDTLS_AES_ENCRYPT, in, out);
}

static void sc_wrap_xor_t(unsigned char *a, size_t t) {
  a[7] ^= (unsigned char)(t & 0xff);
  if (t > 0xff) {
    a[6] ^= (unsigned char)((t >> 8) & 0xff);
    a[5] ^= (unsigned char)((t >> 16) & 0xff);
    a[4] ^= (unsigned char)((t >> 24) & 0xff);
  }
}

/* CRYPTO_128_wrap: 0 unless the input is at least 16 bytes in 8-byte
 * blocks. `out` may be `in`. */
static size_t sc_wrap(ScCipher *c, const unsigned char *iv, unsigned char *out, const unsigned char *in, size_t inlen) {
  if ((inlen & 7) || inlen < 16) return 0;
  unsigned char b[16];
  size_t t = 1;
  memmove(out + 8, in, inlen);
  memcpy(b, iv, 8);
  for (int j = 0; j < 6; j++) {
    unsigned char *r = out + 8;
    for (size_t i = 0; i < inlen; i += 8, t++, r += 8) {
      memcpy(b + 8, r, 8);
      sc_wrap_block(c, b, b);
      sc_wrap_xor_t(b, t);
      memcpy(r, b + 8, 8);
    }
  }
  memcpy(out, b, 8);
  mbedtls_platform_zeroize(b, sizeof b);
  return inlen + 8;
}

/* crypto_128_unwrap_raw: the plaintext into `out` and the recovered
 * integrity check value into `aiv`. */
static size_t sc_unwrap_raw(ScCipher *c, unsigned char aiv[8], unsigned char *out, const unsigned char *in, size_t inlen) {
  inlen -= 8;
  if ((inlen & 7) || inlen < 16) return 0;
  unsigned char b[16];
  size_t t = 6 * (inlen >> 3);
  memcpy(b, in, 8);
  memmove(out, in + 8, inlen);
  for (int j = 0; j < 6; j++) {
    unsigned char *r = out + inlen - 8;
    for (size_t i = 0; i < inlen; i += 8, t--, r -= 8) {
      sc_wrap_xor_t(b, t);
      memcpy(b + 8, r, 8);
      sc_wrap_block(c, b, b);
      memcpy(r, b + 8, 8);
    }
  }
  memcpy(aiv, b, 8);
  mbedtls_platform_zeroize(b, sizeof b);
  return inlen;
}

static size_t sc_unwrap(ScCipher *c, const unsigned char *iv, unsigned char *out, const unsigned char *in, size_t inlen) {
  unsigned char got[8];
  size_t ret = sc_unwrap_raw(c, got, out, in, inlen);
  if (!ret) return 0;
  if (!sc_tag_equal(got, iv, 8)) {
    mbedtls_platform_zeroize(out, ret);
    return 0;
  }
  return ret;
}

/* CRYPTO_128_wrap_pad: the 4-byte ICV and the 32-bit length, then the
 * data padded with zeros to 8 bytes; one block is a single encryption. */
static size_t sc_wrap_pad(ScCipher *c, const unsigned char *icv, unsigned char *out, const unsigned char *in, size_t inlen) {
  size_t padded = (inlen + 7) / 8 * 8;
  if (inlen == 0 || inlen >= ((size_t)1 << 31)) return 0;
  unsigned char aiv[8];
  memcpy(aiv, icv, 4);
  aiv[4] = (unsigned char)((inlen >> 24) & 0xFF);
  aiv[5] = (unsigned char)((inlen >> 16) & 0xFF);
  aiv[6] = (unsigned char)((inlen >> 8) & 0xFF);
  aiv[7] = (unsigned char)(inlen & 0xFF);
  if (padded == 8) {
    memmove(out + 8, in, inlen);
    memcpy(out, aiv, 8);
    memset(out + 8 + inlen, 0, padded - inlen);
    sc_wrap_block(c, out, out);
    return 16;
  }
  memmove(out, in, inlen);
  memset(out + inlen, 0, padded - inlen);
  return sc_wrap(c, aiv, out, out, padded);
}

/* CRYPTO_128_unwrap_pad: the ICV, the length within the last 8 bytes and
 * zero padding must all check. */
static size_t sc_unwrap_pad(ScCipher *c, const unsigned char *icv, unsigned char *out, const unsigned char *in, size_t inlen) {
  if ((inlen & 7) || inlen < 16) return 0;
  size_t n = inlen / 8 - 1, padded;
  unsigned char aiv[8];
  if (inlen == 16) {
    unsigned char buff[16];
    sc_wrap_block(c, in, buff);
    memcpy(aiv, buff, 8);
    memcpy(out, buff + 8, 8);
    padded = 8;
    mbedtls_platform_zeroize(buff, sizeof buff);
  } else {
    padded = inlen - 8;
    if (sc_unwrap_raw(c, aiv, out, in, inlen) != padded) {
      mbedtls_platform_zeroize(out, inlen);
      return 0;
    }
  }
  size_t plain = (size_t)aiv[4] << 24 | (size_t)aiv[5] << 16 | (size_t)aiv[6] << 8 | aiv[7];
  static const unsigned char zeros[8] = {0};
  if (!sc_tag_equal(aiv, icv, 4) || 8 * (n - 1) >= plain || plain > 8 * n ||
      !sc_tag_equal(out + plain, zeros, padded - plain)) {
    mbedtls_platform_zeroize(out, padded);
    return 0;
  }
  return plain;
}

static ScrBytes *sc_wrap_update(ScCipher *c, const unsigned char *in, size_t len) {
  if (c->ccm_updated) {
    sc_throw(SCR_ERR_ERROR, NULL, "Trying to add data in unsupported state");
    return NULL;
  }
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)(len + 16));
  out->is_buffer = true;
  size_t produced = 0;
  if (len > 0) {
    bool pad = c->mode == SC_WRAP_PAD;
    produced = !c->decrypt ? (pad ? sc_wrap_pad(c, c->block, out->data, in, len) : sc_wrap(c, c->block, out->data, in, len))
                           : (pad ? sc_unwrap_pad(c, c->block, out->data, in, len)
                                  : sc_unwrap(c, c->block, out->data, in, len));
    if (produced == 0) {
      mbedtls_platform_zeroize(out->data, len + 16);
      scr_bytes_release(out);
      sc_throw(SCR_ERR_ERROR, NULL, "Trying to add data in unsupported state");
      return NULL;
    }
  }
  c->ccm_updated = true;
  out->len = produced;
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
  return c->mode == SC_GCM || c->mode == SC_CHACHA || c->mode == SC_CCM;
}

/* final()'s output bytes (+1 Buffer), or NULL with the error thrown. */
static ScrBytes *sc_final_bytes(ScCipher *c) {
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
  case SC_CBC:
  case SC_ECB: {
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
  case SC_CFB:
  case SC_CFB8:
  case SC_CFB1:
  case SC_OFB:
  case SC_CHACHA20:
    break;
  case SC_CCM:
    ok = sc_ccm_final(c);
    break;
  case SC_WRAP:
  case SC_WRAP_PAD:
    backend = c->ccm_updated;
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
  return out;
}

static ScrDyn *sc_final(ScCipher *c, ScrDyn *output_encoding) {
  ScrBytes *out = sc_final_bytes(c);
  return out ? sc_output(c, out, output_encoding, true) : NULL;
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
  if (c->mode == SC_CCM && c->active) {
    bool ok = true;
    if (plaintext_length < 0) {
      sc_throw(SCR_ERR_TYPE, "ERR_MISSING_ARGS", "options.plaintextLength required for CCM mode with AAD");
      ok = false;
    } else if (!sc_ccm_length_ok(c, plaintext_length)) {
      ok = false;
    } else if (!sc_ccm_set_aad(c, aad, plaintext_length)) {
      sc_invalid_state("setAAD");
      ok = false;
    }
    scr_bytes_release(aad);
    return ok ? scr_dyn_retain(self) : NULL;
  }
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
  if (c->mode == SC_CCM) c->ccm_tag_set = true;
  scr_bytes_release(tag);
  return scr_dyn_retain(self);
}

/* ── Cipheriv and Decipheriv as streams ───────────────────────────────
 * The stream unit builds a cipher's Transform from these operations
 * (ScrDynHandleTransform): each chunk goes through the handle's update(),
 * and the end pushes final() or reports its error, as Node's cipher.js
 * _transform and _flush do. */

static void *sc_stream_get(void *h) {
  return ((ScCipher *)h)->stream;
}

static void sc_stream_set(void *h, void *stream, void (*release)(void *)) {
  ScCipher *c = h;
  c->stream = stream;
  c->stream_release = release;
}

/* The handle's update(): it throws out of the write, as in Node, once
 * the cipher has finished. */
static ScrBytes *sc_stream_update(void *h, ScrBytes *chunk) {
  ScCipher *c = h;
  if (!c->active) {
    sc_throw(SCR_ERR_ERROR, NULL, "Trying to add data in unsupported state");
    return NULL;
  }
  SCR_BYTES_SNAPSHOT(chunk);
  return sc_transform(c, chunk->data, chunk->len * scr_bytes_elem_size(chunk->elem));
}

static ScrBytes *sc_stream_final(void *h) {
  return sc_final_bytes(h);
}

static const ScrDynHandleTransform sc_transform_ops = {
  sc_stream_get, sc_stream_set, sc_stream_update, sc_stream_final, sc_trace,
};

static ScrDynHandleOps sc_ops_cipher;
static ScrDynHandleOps sc_ops_decipher;

static const ScrDynHandleOps *sc_ops_of(const ScCipher *c) {
  return c->decrypt ? &sc_ops_decipher : &sc_ops_cipher;
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
    "This Cipheriv and Decipheriv stream member has no lowering when called through an untyped value";
  static const char streamless[] =
    "Cipheriv and Decipheriv stream members called through an untyped value have no lowering in a "
    "program that uses no streams";
  if (scr_handle_stream_hooks) scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  else scr_throw_error_msg_code(SCR_ERR_ERROR, streamless, sizeof streamless - 1, "SC2020");
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
    /* The members a native stream answers to checked-dynamic calls run
     * on the cipher's Transform; the others have no lowering. */
    ScrDyn *result = NULL;
    if (scr_handle_stream_hooks &&
        scr_handle_stream_hooks->call(sc_ops_of(c), c, self, method, args, argc, &result))
      return result;
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
  /* The stream properties read the cipher's Transform. */
  if (scr_handle_stream_hooks) {
    ScrDyn *value = scr_handle_stream_hooks->get(sc_ops_of(h), h, key, key_len);
    if (value || scr_exc_pending()) return value;
  }
  static const char message[] =
    "Cipheriv and Decipheriv property reads have no lowering other than the stream properties; call "
    "update(), final(), setAAD(), setAutoPadding(), getAuthTag() or setAuthTag()";
  static const char streamless[] =
    "Cipheriv and Decipheriv property reads through an untyped value have no lowering in a program "
    "that uses no streams";
  if (scr_handle_stream_hooks) scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  else scr_throw_error_msg_code(SCR_ERR_ERROR, streamless, sizeof streamless - 1, "SC2020");
  return NULL;
}

static bool sc_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  static const char message[] = "Writing Cipheriv and Decipheriv properties has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return true;
}

static ScrDynHandleOps sc_ops_cipher = {"Cipheriv", sc_retain, sc_release, sc_invoke, sc_get, sc_set, NULL, NULL, NULL,
                                       .transform = &sc_transform_ops};
static ScrDynHandleOps sc_ops_decipher = {"Decipheriv", sc_retain, sc_release, sc_invoke, sc_get, sc_set, NULL, NULL, NULL,
                                         .transform = &sc_transform_ops};
