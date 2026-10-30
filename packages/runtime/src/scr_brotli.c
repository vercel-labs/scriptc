/* node:zlib's Brotli codec over the vendored brotli 1.2.0 (the version Node
 * v24.22.0 bundles, so compressed bytes match Node's). Node's
 * BrotliEncoderContext and BrotliDecoderContext (src/node_zlib.cc) plug into
 * scr_zlib.c's engine as a codec, so the one-shot, callback, promise and
 * stream forms run exactly as their zlib counterparts do. The option ladder
 * is lib/zlib.js's Brotli() followed by ZlibBase(). Linked only when the
 * program uses Brotli; scr_brotli_install, which %main calls first,
 * connects it to scr_zlib.c. */
#include "scr_runtime.h"

#include <brotli/decode.h>
#include <brotli/encode.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { SCR_BROTLI_DECODE = 8, SCR_BROTLI_ENCODE = 9 };
/* kMaxBrotliParam + 1: the largest BROTLI_PARAM_* value is
 * BROTLI_PARAM_NDIRECT (8). An unset slot holds 0xFFFFFFFF, as Node's
 * Uint32Array filled with -1 does. */
#define SCR_BROTLI_PARAMS 9
#define SCR_BROTLI_UNSET 0xFFFFFFFFu

typedef struct {
  bool encode;
  BrotliEncoderState *enc;
  BrotliEncoderPreparedDictionary *prepared;
  BrotliDecoderState *dec;
  /* The dictionary stays alive while the encoder's prepared dictionary or
   * the decoder holds it. */
  unsigned char *dict;
  size_t dict_len;
  int flush;
  bool enc_ok;
  BrotliDecoderResult dec_result;
  BrotliDecoderErrorCode dec_error;
  char dec_code[64];
} ScrBrotli;

static void scr_brotli_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

static bool scr_brotli_fail(ScrZlibError *out, const char *message, const char *code, int err) {
  out->message = message;
  out->code = code;
  out->err = err;
  return true;
}

static void scr_brotli_close(ScrBrotli *b) {
  if (b->enc) BrotliEncoderDestroyInstance(b->enc);
  if (b->prepared) BrotliEncoderDestroyPreparedDictionary(b->prepared);
  if (b->dec) BrotliDecoderDestroyInstance(b->dec);
  b->enc = NULL;
  b->prepared = NULL;
  b->dec = NULL;
}

/* Init(dictionary): a fresh instance with the dictionary attached. As in
 * Node, the decoder's last error survives a re-initialization. True with
 * *out filled on failure. */
static bool scr_brotli_init(ScrBrotli *b, ScrZlibError *out) {
  scr_brotli_close(b);
  if (b->encode) {
    b->enc = BrotliEncoderCreateInstance(NULL, NULL, NULL);
    b->enc_ok = false;
    if (!b->enc) return scr_brotli_fail(out, "Could not initialize Brotli instance", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
    if (b->dict_len == 0) return false;
    b->prepared = BrotliEncoderPrepareDictionary(BROTLI_SHARED_DICTIONARY_RAW, b->dict_len, b->dict, BROTLI_MAX_QUALITY,
                                                 NULL, NULL, NULL);
    if (!b->prepared) return scr_brotli_fail(out, "Failed to prepare brotli dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED", -1);
    if (!BrotliEncoderAttachPreparedDictionary(b->enc, b->prepared))
      return scr_brotli_fail(out, "Failed to attach brotli dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED", -1);
    return false;
  }
  b->dec = BrotliDecoderCreateInstance(NULL, NULL, NULL);
  if (!b->dec) return scr_brotli_fail(out, "Could not initialize Brotli instance", "ERR_ZLIB_INITIALIZATION_FAILED", -1);
  if (b->dict_len != 0 && !BrotliDecoderAttachDictionary(b->dec, BROTLI_SHARED_DICTIONARY_RAW, b->dict_len, b->dict))
    return scr_brotli_fail(out, "Failed to attach brotli dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED", -1);
  return false;
}

static void scr_brotli_free(void *state) {
  ScrBrotli *b = state;
  if (!b) return;
  scr_brotli_close(b);
  free(b->dict);
  free(b);
}

/* DoThreadPoolWork: runs on a worker thread and touches only the state. */
static void scr_brotli_work(void *state, int flush, const unsigned char *in, uint32_t in_len, unsigned char *out,
                            uint32_t out_len, uint32_t *avail_in, uint32_t *avail_out) {
  ScrBrotli *b = state;
  size_t in_left = in_len, out_left = out_len;
  const uint8_t *next_in = in;
  uint8_t *next_out = out;
  b->flush = flush;
  if (b->encode) {
    b->enc_ok = BrotliEncoderCompressStream(b->enc, (BrotliEncoderOperation)flush, &in_left, &next_in, &out_left,
                                            &next_out, NULL) != BROTLI_FALSE;
  } else {
    b->dec_result = BrotliDecoderDecompressStream(b->dec, &in_left, &next_in, &out_left, &next_out, NULL);
    if (b->dec_result == BROTLI_DECODER_RESULT_ERROR) {
      b->dec_error = BrotliDecoderGetErrorCode(b->dec);
      snprintf(b->dec_code, sizeof b->dec_code, "ERR_%s", BrotliDecoderErrorString(b->dec_error));
    }
  }
  *avail_in = (uint32_t)in_left;
  *avail_out = (uint32_t)out_left;
}

/* GetErrorInfo. */
static bool scr_brotli_error(const void *state, ScrZlibError *out) {
  const ScrBrotli *b = state;
  if (b->encode) {
    if (!b->enc_ok) return scr_brotli_fail(out, "Compression failed", "ERR_BROTLI_COMPRESSION_FAILED", -1);
    return false;
  }
  if (b->dec_error != BROTLI_DECODER_NO_ERROR)
    return scr_brotli_fail(out, "Decompression failed", b->dec_code, (int)b->dec_error);
  /* zlib's answer for a truncated stream; Brotli has no code of its own. */
  if (b->flush == BROTLI_OPERATION_FINISH && b->dec_result == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT)
    return scr_brotli_fail(out, "unexpected end of file", "Z_BUF_ERROR", -5);
  return false;
}

/* ResetStream is Init() without a dictionary: as in Node, the reset
 * instance drops the dictionary and the parameters. */
static bool scr_brotli_reset(void *state, ScrZlibError *out) {
  ScrBrotli *b = state;
  free(b->dict);
  b->dict = NULL;
  b->dict_len = 0;
  return scr_brotli_init(b, out);
}

static const ScrZlibCodec scr_brotli_codec = {
    scr_brotli_work,
    scr_brotli_error,
    scr_brotli_reset,
    scr_brotli_free,
};

/* ── lib/zlib.js Brotli() ──────────────────────────────────────────── */

static const ScrDyn *scr_brotli_opt(const ScrDyn *opts, const char *key) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return NULL;
  return scr_dyn_obj_get((ScrDyn *)opts, key, strlen(key));
}

/* Uint32Array element assignment: ToUint32 of a number or boolean. */
static uint32_t scr_brotli_uint32(const ScrDyn *v) {
  if (v->kind == SCR_DYN_BOOL) return v->v.b ? 1 : 0;
  double d = v->v.num;
  if (!isfinite(d)) return 0;
  double m = fmod(trunc(d), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (uint32_t)m;
}

/* ERR_BROTLI_INVALID_PARAM: the whole key, then Node's text. */
static void scr_brotli_invalid_param(const ScrStr *key) {
  static const char suffix[] = " is not a valid Brotli parameter";
  size_t len = key->len + sizeof suffix - 1;
  char *message = malloc(len);
  if (!message) scr_brotli_oom();
  memcpy(message, key->data, key->len);
  memcpy(message + key->len, suffix, sizeof suffix - 1);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message, len, "ERR_BROTLI_INVALID_PARAM");
  free(message);
}

/* opts.params: each own key must name a parameter (0..8) once, and each
 * value must be a number or boolean. */
static bool scr_brotli_params(const ScrDyn *params, uint32_t values[SCR_BROTLI_PARAMS]) {
  for (size_t i = 0; i < SCR_BROTLI_PARAMS; i++) values[i] = SCR_BROTLI_UNSET;
  if (params == NULL || !scr_dyn_truthy(params)) return true;
  ScrDyn *view = params->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(params) : NULL;
  if (scr_exc_pending()) return false;
  const ScrDyn *p = view ? view : params;
  if (p->kind == SCR_DYN_STR) {
    /* Object.keys of a string names its indices; the first value is a
     * one-character string, which the type check rejects. */
    ScrStr *first = scr_str_new(p->v.str->data, 1);
    ScrDyn *value = scr_dyn_new_str(first);
    scr_str_release(first);
    scr_dyn_prop_type_fail("options.params[key]", "of type number", value);
    scr_dyn_release(value);
    scr_dyn_release(view);
    return false;
  }
  if (p->kind != SCR_DYN_OBJ && p->kind != SCR_DYN_ARR) {
    scr_dyn_release(view);
    return true;
  }
  ScrDyn *keys = scr_dyn_own_keys(p);
  bool ok = keys != NULL;
  size_t count = ok && keys->kind == SCR_DYN_ARR ? keys->v.arr.len : 0;
  for (size_t i = 0; ok && i < count; i++) {
    const ScrDyn *key = keys->v.arr.items[i];
    if (key->kind != SCR_DYN_STR) continue;
    double index = NAN;
    if (!scr_dyn_number_coerce_js(key, &index)) {
      ok = false;
      break;
    }
    if (isnan(index) || index < 0 || index > SCR_BROTLI_PARAMS - 1 || trunc(index) != index ||
        values[(int)index] != SCR_BROTLI_UNSET) {
      scr_brotli_invalid_param(key->v.str);
      ok = false;
      break;
    }
    ScrDyn *value = scr_dyn_obj_read(p, key->v.str->data, key->v.str->len);
    if (!value) {
      ok = false;
      break;
    }
    if (value->kind != SCR_DYN_NUM && value->kind != SCR_DYN_BOOL) {
      scr_dyn_prop_type_fail("options.params[key]", "of type number", value);
      scr_dyn_release(value);
      ok = false;
      break;
    }
    values[(int)index] = scr_brotli_uint32(value);
    scr_dyn_release(value);
  }
  scr_dyn_release(keys);
  scr_dyn_release(view);
  return ok;
}

/* opts.dictionary: an ArrayBufferView, or an ArrayBuffer read as a Buffer.
 * A copy (or NULL for none) in *dict. */
static bool scr_brotli_dictionary(const ScrDyn *d, unsigned char **dict, size_t *dict_len) {
  *dict = NULL;
  *dict_len = 0;
  if (d == NULL || d->kind == SCR_DYN_UNDEF) return true;
  ScrBytes *bytes = NULL;
  if (d->kind == SCR_DYN_BYTES) {
    bytes = scr_bytes_raw_view(d->v.bytes);
  } else if (scr_buffer_storage_is(d)) {
    bytes = scr_array_buffer_view(SCR_BYTES_U8, (ScrDyn *)d, scr_dyn_undefined(), scr_dyn_undefined());
    if (!bytes) return false;
  } else {
    scr_dyn_prop_type_fail("options.dictionary", "an instance of Buffer, TypedArray, DataView, or ArrayBuffer", d);
    return false;
  }
  if (bytes->len) {
    *dict = malloc(bytes->len);
    if (!*dict) scr_brotli_oom();
    memcpy(*dict, bytes->data, bytes->len);
    *dict_len = bytes->len;
  }
  scr_bytes_release(bytes);
  return true;
}

static void scr_brotli_init_failed(void) {
  static const char message[] = "Initialization failed";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_ZLIB_INITIALIZATION_FAILED");
}

static bool scr_brotli_options_object(int mode, const ScrDyn *opts, ScrZlibOptions *out) {
  memset(out, 0, sizeof *out);
  out->chunk_size = 16384;
  out->flush = BROTLI_OPERATION_PROCESS;
  out->finish_flush = BROTLI_OPERATION_FINISH;
  out->max_output = 9007199254740991.0;
  uint32_t params[SCR_BROTLI_PARAMS];
  if (!scr_brotli_params(scr_brotli_opt(opts, "params"), params)) return false;
  unsigned char *dict;
  size_t dict_len;
  if (!scr_brotli_dictionary(scr_brotli_opt(opts, "dictionary"), &dict, &dict_len)) return false;
  ScrBrotli *b = calloc(1, sizeof *b);
  if (!b) scr_brotli_oom();
  b->encode = mode == SCR_BROTLI_ENCODE;
  b->dict = dict;
  b->dict_len = dict_len;
  ScrZlibError err;
  bool failed = scr_brotli_init(b, &err);
  for (int i = 0; !failed && i < SCR_BROTLI_PARAMS; i++) {
    if (params[i] == SCR_BROTLI_UNSET) continue;
    failed = b->encode ? !BrotliEncoderSetParameter(b->enc, (BrotliEncoderParameter)i, params[i])
                       : !BrotliDecoderSetParameter(b->dec, (BrotliDecoderParameter)i, params[i]);
  }
  if (failed) {
    scr_brotli_free(b);
    scr_brotli_init_failed();
    return false;
  }
  out->codec_state = b;
  out->codec_state_free = scr_brotli_free;
  /* ZlibBase's `if (opts)`: a falsy value reads no more options. */
  if (opts == NULL || !scr_dyn_truthy(opts)) return true;
  return scr_zlib_base_options(opts, BROTLI_OPERATION_EMIT_METADATA, out);
}

/* A typed options object is read through its materialized view. */
static bool scr_brotli_options(int mode, const ScrDyn *opts, ScrZlibOptions *out) {
  if (opts == NULL || opts->kind != SCR_DYN_TYPED_REF) return scr_brotli_options_object(mode, opts, out);
  ScrDyn *view = scr_dyn_typed_ref_materialize(opts);
  bool ok = false;
  if (scr_exc_pending()) memset(out, 0, sizeof *out);
  else ok = scr_brotli_options_object(mode, view, out);
  scr_dyn_release(view);
  return ok;
}

/* Moves the prepared instance out of the options. */
static ScrZlibEngine *scr_brotli_engine(int mode, ScrZlibOptions *o) {
  ScrBrotli *b = o->codec_state;
  o->codec_state = NULL;
  return scr_zlib_engine_codec(mode, &scr_brotli_codec, b, o->reject_garbage);
}

static const ScrZlibBrotliHooks scr_brotli_hooks = {scr_brotli_options, scr_brotli_engine};

void scr_brotli_install(void) {
  scr_zlib_brotli_hooks = &scr_brotli_hooks;
}
