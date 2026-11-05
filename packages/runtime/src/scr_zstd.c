/* node:zlib's zstd codec over the vendored zstd 1.5.7 (the version Node
 * v24.22.1 bundles, so compressed bytes match Node's). Node's
 * ZstdCompressContext and ZstdDecompressContext (src/node_zlib.cc) plug into
 * scr_zlib.c's engine as a codec, so the one-shot, callback, promise and
 * stream forms run exactly as their zlib counterparts do. The option ladder
 * is lib/zlib.js's Zstd() (params, dictionary, pledgedSrcSize,
 * rejectGarbageAfterEnd) followed by ZlibBase(). Linked only when the
 * program uses zstd; scr_zstd_install, which %main calls first, connects it
 * to scr_zlib.c. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zstd.h>
#include <zstd_errors.h>

enum { SCR_ZSTD_COMPRESS = 10, SCR_ZSTD_DECOMPRESS = 11 };
/* ZlibBase's flush bound for a zstd stream: ZSTD_e_continue..ZSTD_e_end. */
#define SCR_ZSTD_FLUSH_MAX 2.0

typedef struct {
  bool compress;
  ZSTD_CCtx *cctx;
  ZSTD_DCtx *dctx;
  /* The dictionary stays alive for the context's lifetime. */
  unsigned char *dict;
  size_t dict_len;
  uint64_t pledged_src_size;
  /* ZstdCompressContext's consumed_src_size_, absent unless a pledge was
   * given with the frame. */
  bool have_consumed;
  uint64_t consumed_src_size;
  bool reject_garbage;
  /* ZstdDecompressContext's frame tracking: where the next frame's magic
   * stands, and whether trailing input is being ignored. */
  bool frame_complete;
  bool decoding_frame_after_complete;
  bool ignoring_trailing_input;
  size_t frame_prefix_size;
  uint8_t possible_frame_types;
  /* The last step's unused input and output, for GetErrorInfo. */
  uint32_t in_left, out_left;
  int flush;
  ZSTD_ErrorCode error;
  const char *error_message;
  const char *error_code;
} ScrZstd;

static void scr_zstd_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

static bool scr_zstd_fail(ScrZlibError *out, const char *message, const char *code, int err) {
  out->message = message;
  out->code = code;
  out->err = err;
  return true;
}

/* Node's ZSTD_ERROR_CODES table: the enumerator's own spelling, which is
 * the error's code string. */
static const char *scr_zstd_strerror(ZSTD_ErrorCode err) {
  switch (err) {
  case ZSTD_error_no_error: return "ZSTD_error_no_error";
  case ZSTD_error_GENERIC: return "ZSTD_error_GENERIC";
  case ZSTD_error_prefix_unknown: return "ZSTD_error_prefix_unknown";
  case ZSTD_error_version_unsupported: return "ZSTD_error_version_unsupported";
  case ZSTD_error_frameParameter_unsupported: return "ZSTD_error_frameParameter_unsupported";
  case ZSTD_error_frameParameter_windowTooLarge:
    return "ZSTD_error_frameParameter_windowTooLarge";
  case ZSTD_error_corruption_detected: return "ZSTD_error_corruption_detected";
  case ZSTD_error_checksum_wrong: return "ZSTD_error_checksum_wrong";
  case ZSTD_error_literals_headerWrong: return "ZSTD_error_literals_headerWrong";
  case ZSTD_error_dictionary_corrupted: return "ZSTD_error_dictionary_corrupted";
  case ZSTD_error_dictionary_wrong: return "ZSTD_error_dictionary_wrong";
  case ZSTD_error_dictionaryCreation_failed: return "ZSTD_error_dictionaryCreation_failed";
  case ZSTD_error_parameter_unsupported: return "ZSTD_error_parameter_unsupported";
  case ZSTD_error_parameter_combination_unsupported:
    return "ZSTD_error_parameter_combination_unsupported";
  case ZSTD_error_parameter_outOfBound: return "ZSTD_error_parameter_outOfBound";
  case ZSTD_error_tableLog_tooLarge: return "ZSTD_error_tableLog_tooLarge";
  case ZSTD_error_maxSymbolValue_tooLarge: return "ZSTD_error_maxSymbolValue_tooLarge";
  case ZSTD_error_maxSymbolValue_tooSmall: return "ZSTD_error_maxSymbolValue_tooSmall";
  case ZSTD_error_stabilityCondition_notRespected:
    return "ZSTD_error_stabilityCondition_notRespected";
  case ZSTD_error_stage_wrong: return "ZSTD_error_stage_wrong";
  case ZSTD_error_init_missing: return "ZSTD_error_init_missing";
  case ZSTD_error_memory_allocation: return "ZSTD_error_memory_allocation";
  case ZSTD_error_workSpace_tooSmall: return "ZSTD_error_workSpace_tooSmall";
  case ZSTD_error_dstSize_tooSmall: return "ZSTD_error_dstSize_tooSmall";
  case ZSTD_error_srcSize_wrong: return "ZSTD_error_srcSize_wrong";
  case ZSTD_error_dstBuffer_null: return "ZSTD_error_dstBuffer_null";
  case ZSTD_error_noForwardProgress_destFull: return "ZSTD_error_noForwardProgress_destFull";
  case ZSTD_error_noForwardProgress_inputEmpty:
    return "ZSTD_error_noForwardProgress_inputEmpty";
  default: return "ZSTD_error_GENERIC";
  }
}

/* Records a zstd error the way Node's CompressionError carries it: the
 * library's message, its code string and its numeric code. */
static void scr_zstd_record(ScrZstd *z, size_t code) {
  z->error = ZSTD_getErrorCode(code);
  z->error_message = ZSTD_getErrorString(z->error);
  z->error_code = scr_zstd_strerror(z->error);
}

static void scr_zstd_close(ScrZstd *z) {
  if (z->cctx) ZSTD_freeCCtx(z->cctx);
  if (z->dctx) ZSTD_freeDCtx(z->dctx);
  z->cctx = NULL;
  z->dctx = NULL;
}

/* Init(): a fresh context with the dictionary loaded; the compressor also
 * takes the pledged source size. As in Node, the decoder's frame tracking
 * restarts and the compressor's consumed count restarts from the pledge.
 * True with *out filled on failure. */
static bool scr_zstd_init(ScrZstd *z, ScrZlibError *out) {
  scr_zstd_close(z);
  if (z->compress) {
    z->cctx = ZSTD_createCCtx();
    if (!z->cctx)
      return scr_zstd_fail(out, "Could not initialize zstd instance", "ERR_ZLIB_INITIALIZATION_FAILED",
                           -1);
    if (z->dict_len != 0 && ZSTD_isError(ZSTD_CCtx_loadDictionary(z->cctx, z->dict, z->dict_len)))
      return scr_zstd_fail(out, "Failed to load zstd dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED",
                           -1);
    if (ZSTD_isError(ZSTD_CCtx_setPledgedSrcSize(z->cctx, z->pledged_src_size)))
      return scr_zstd_fail(out, "Could not set pledged src size", "ERR_ZLIB_INITIALIZATION_FAILED",
                           -1);
    z->have_consumed = z->pledged_src_size != ZSTD_CONTENTSIZE_UNKNOWN;
    z->consumed_src_size = 0;
    return false;
  }
  z->frame_complete = false;
  z->decoding_frame_after_complete = false;
  z->ignoring_trailing_input = false;
  z->frame_prefix_size = 0;
  z->possible_frame_types = 0;
  z->dctx = ZSTD_createDCtx();
  if (!z->dctx)
    return scr_zstd_fail(out, "Could not initialize zstd instance", "ERR_ZLIB_INITIALIZATION_FAILED",
                         -1);
  if (z->dict_len != 0 && ZSTD_isError(ZSTD_DCtx_loadDictionary(z->dctx, z->dict, z->dict_len)))
    return scr_zstd_fail(out, "Failed to load zstd dictionary", "ERR_ZLIB_DICTIONARY_LOAD_FAILED",
                         -1);
  return false;
}

static void scr_zstd_free(void *state) {
  ScrZstd *z = state;
  if (!z) return;
  scr_zstd_close(z);
  free(z->dict);
  free(z);
}

/* DoThreadPoolWork: runs on a worker thread and touches only the state. The
 * decompressor follows ZstdDecompressContext::DoThreadPoolWork: it keeps
 * decoding frames while the input lasts and the output has room, sniffs the
 * next frame's magic after a complete frame, and either ignores what follows
 * (trailing junk) or reports Node's error. */
static void scr_zstd_work(void *state, int flush, const unsigned char *in, uint32_t in_len,
                          unsigned char *out, uint32_t out_len, uint32_t *avail_in,
                          uint32_t *avail_out) {
  ScrZstd *z = state;
  ZSTD_inBuffer input = {in, in_len, 0};
  ZSTD_outBuffer output = {out, out_len, 0};
  z->flush = flush;
  if (z->compress) {
    size_t const in_pos = input.pos;
    size_t const remaining = ZSTD_compressStream2(z->cctx, &output, &input, (ZSTD_EndDirective)flush);
    if (z->have_consumed) z->consumed_src_size += input.pos - in_pos;
    if (ZSTD_isError(remaining)) {
      scr_zstd_record(z, remaining);
    } else if (remaining == 0 && flush == ZSTD_e_end && z->have_consumed) {
      uint64_t const consumed = z->consumed_src_size;
      z->have_consumed = false;
      if (consumed != z->pledged_src_size) {
        z->error = ZSTD_error_srcSize_wrong;
        z->error_message = ZSTD_getErrorString(z->error);
        z->error_code = scr_zstd_strerror(z->error);
      }
    }
  } else if (!z->ignoring_trailing_input) {
    /* The processing loop retries with an empty input buffer when the
     * previous call filled the output buffer; that retry is not the start
     * of a new, incomplete frame. */
    if (!(z->frame_complete && input.size == 0)) {
      do {
        if (z->frame_complete) {
          z->decoding_frame_after_complete = true;
          z->frame_prefix_size = 0;
          z->possible_frame_types = 0x03;
        }
        if (z->decoding_frame_after_complete && z->frame_prefix_size < 4) {
          static const uint8_t zstd_magic[] = {0x28, 0xb5, 0x2f, 0xfd};
          static const uint8_t skippable_magic[] = {0x50, 0x2a, 0x4d, 0x18};
          const uint8_t *data = input.src;
          size_t prefix_offset = 0;
          while (z->frame_prefix_size < 4 && input.pos + prefix_offset < input.size) {
            size_t const index = z->frame_prefix_size;
            uint8_t const byte = data[input.pos + prefix_offset];
            if (byte != zstd_magic[index]) z->possible_frame_types &= (uint8_t)~0x01;
            if ((index == 0 && (byte & 0xf0) != skippable_magic[0]) ||
                (index != 0 && byte != skippable_magic[index]))
              z->possible_frame_types &= (uint8_t)~0x02;
            z->frame_prefix_size++;
            prefix_offset++;
          }
          if (z->possible_frame_types == 0) {
            z->frame_complete = true;
            z->decoding_frame_after_complete = false;
            if (z->reject_garbage) {
              z->error = ZSTD_error_GENERIC;
              z->error_code = "ERR_TRAILING_JUNK_AFTER_STREAM_END";
              z->error_message =
                  "Trailing junk found after the end of the compressed stream";
            } else {
              z->ignoring_trailing_input = true;
            }
            break;
          }
        }
        size_t const ret = ZSTD_decompressStream(z->dctx, &output, &input);
        if (ZSTD_isError(ret)) {
          z->frame_complete = false;
          scr_zstd_record(z, ret);
          break;
        }
        z->frame_complete = ret == 0;
        if (z->frame_complete) z->decoding_frame_after_complete = false;
      } while (z->frame_complete && input.pos < input.size && output.pos < output.size);
    }
  }
  z->in_left = (uint32_t)(input.size - input.pos);
  z->out_left = (uint32_t)(output.size - output.pos);
  *avail_in = z->in_left;
  *avail_out = z->out_left;
}

/* GetErrorInfo. */
static bool scr_zstd_error(const void *state, ScrZlibError *out) {
  const ScrZstd *z = state;
  if (z->error != ZSTD_error_no_error)
    return scr_zstd_fail(out, z->error_message, z->error_code, (int)z->error);
  /* A frame that ended with junk still in the buffer, or a stream that ran
   * out of input before its frame ended. */
  if (!z->compress && z->flush == ZSTD_e_end && !z->frame_complete && z->in_left == 0 &&
      z->out_left > 0) {
    if (z->decoding_frame_after_complete && z->frame_prefix_size < 4) {
      if (z->reject_garbage)
        return scr_zstd_fail(out, "Trailing junk found after the end of the compressed stream",
                             "ERR_TRAILING_JUNK_AFTER_STREAM_END", -1);
      return false;
    }
    /* Z_BUF_ERROR, the zlib code Node reports for a truncated zstd frame. */
    return scr_zstd_fail(out, "unexpected end of file", "Z_BUF_ERROR", -5);
  }
  return false;
}

/* ResetStream: a new session over the same context, parameters and
 * dictionary; the compressor re-takes its pledge, the decoder restarts its
 * frame tracking, and both clear the last error. */
static bool scr_zstd_reset(void *state, ScrZlibError *out) {
  ScrZstd *z = state;
  if (z->compress) {
    size_t const result = ZSTD_CCtx_reset(z->cctx, ZSTD_reset_session_only);
    if (ZSTD_isError(result)) {
      z->error_message = ZSTD_getErrorString(ZSTD_getErrorCode(result));
      z->error_code = scr_zstd_strerror(ZSTD_getErrorCode(result));
      z->error = ZSTD_getErrorCode(result);
      return scr_zstd_fail(out, z->error_message, z->error_code, (int)z->error);
    }
    if (ZSTD_isError(ZSTD_CCtx_setPledgedSrcSize(z->cctx, z->pledged_src_size))) {
      z->error = ZSTD_getErrorCode(ZSTD_CCtx_setPledgedSrcSize(z->cctx, z->pledged_src_size));
      z->error_message = ZSTD_getErrorString(z->error);
      z->error_code = scr_zstd_strerror(z->error);
      return scr_zstd_fail(out, z->error_message, z->error_code, (int)z->error);
    }
    z->have_consumed = z->pledged_src_size != ZSTD_CONTENTSIZE_UNKNOWN;
    z->consumed_src_size = 0;
  } else {
    size_t const result = ZSTD_DCtx_reset(z->dctx, ZSTD_reset_session_only);
    if (ZSTD_isError(result)) {
      z->error = ZSTD_getErrorCode(result);
      z->error_message = ZSTD_getErrorString(z->error);
      z->error_code = scr_zstd_strerror(z->error);
      return scr_zstd_fail(out, z->error_message, z->error_code, (int)z->error);
    }
    z->frame_complete = false;
    z->decoding_frame_after_complete = false;
    z->ignoring_trailing_input = false;
    z->frame_prefix_size = 0;
    z->possible_frame_types = 0;
  }
  z->error = ZSTD_error_no_error;
  z->error_message = NULL;
  z->error_code = NULL;
  return false;
}

static const ScrZlibCodec scr_zstd_codec = {
    scr_zstd_work,
    scr_zstd_error,
    scr_zstd_reset,
    scr_zstd_free,
};

/* ── lib/zlib.js Zstd() ─────────────────────────────────────────────── */

static const ScrDyn *scr_zstd_opt(const ScrDyn *opts, const char *key) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return NULL;
  return scr_dyn_obj_get((ScrDyn *)opts, key, strlen(key));
}

/* Uint32Array element assignment: ToUint32 of a number or boolean. */
static uint32_t scr_zstd_uint32(const ScrDyn *v) {
  if (v->kind == SCR_DYN_BOOL) return v->v.b ? 1 : 0;
  double d = v->v.num;
  if (!isfinite(d)) return 0;
  double m = fmod(trunc(d), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (uint32_t)m;
}

/* ERR_ZSTD_INVALID_PARAM: the whole key, then Node's text. */
static void scr_zstd_invalid_param(const ScrStr *key) {
  static const char suffix[] = " is not a valid zstd parameter";
  size_t len = key->len + sizeof suffix - 1;
  char *message = malloc(len);
  if (!message) scr_zstd_oom();
  memcpy(message, key->data, key->len);
  memcpy(message + key->len, suffix, sizeof suffix - 1);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message, len, "ERR_ZSTD_INVALID_PARAM");
  free(message);
}

/* opts.params: each own key must name a parameter (0..max) once, and each
 * value must be a number or boolean. The array comes back caller-freed,
 * with 0xFFFFFFFF in every slot Node leaves unfilled. */
static bool scr_zstd_params(const ScrDyn *params, int max, uint32_t **out) {
  size_t const count = (size_t)max + 1;
  uint32_t *values = malloc(count * sizeof *values);
  if (!values) scr_zstd_oom();
  for (size_t i = 0; i < count; i++) values[i] = 0xFFFFFFFFu;
  *out = values;
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
  size_t const key_count = ok && keys->kind == SCR_DYN_ARR ? keys->v.arr.len : 0;
  for (size_t i = 0; ok && i < key_count; i++) {
    const ScrDyn *key = keys->v.arr.items[i];
    if (key->kind != SCR_DYN_STR) continue;
    double index = NAN;
    if (!scr_dyn_number_coerce_js(key, &index)) {
      ok = false;
      break;
    }
    if (isnan(index) || index < 0 || index > max || trunc(index) != index ||
        values[(int)index] != 0xFFFFFFFFu) {
      scr_zstd_invalid_param(key->v.str);
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
    values[(int)index] = scr_zstd_uint32(value);
    scr_dyn_release(value);
  }
  scr_dyn_release(keys);
  scr_dyn_release(view);
  return ok;
}

/* opts.dictionary: an ArrayBufferView, or an ArrayBuffer read as a Buffer.
 * A copy (or NULL for none) in *dict. */
static bool scr_zstd_dictionary(const ScrDyn *d, unsigned char **dict, size_t *dict_len) {
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
    if (!*dict) scr_zstd_oom();
    memcpy(*dict, bytes->data, bytes->len);
    *dict_len = bytes->len;
  }
  scr_bytes_release(bytes);
  return true;
}

/* opts.pledgedSrcSize: the binding's checks, in its order. True with the
 * value in *pledged (ZSTD_CONTENTSIZE_UNKNOWN when absent). */
static bool scr_zstd_pledged(const ScrDyn *v, uint64_t *pledged) {
  *pledged = ZSTD_CONTENTSIZE_UNKNOWN;
  if (v == NULL || v->kind == SCR_DYN_UNDEF) return true;
  static const char not_number[] = "pledgedSrcSize must be a number";
  static const char not_safe[] = "pledgedSrcSize must be a safe integer";
  static const char negative[] = "pledgedSrcSize must be non-negative";
  if (v->kind != SCR_DYN_NUM) {
    scr_throw_error_msg_code(SCR_ERR_TYPE, not_number, sizeof not_number - 1, "ERR_INVALID_ARG_TYPE");
    return false;
  }
  double const d = v->v.num;
  if (!isfinite(d) || trunc(d) != d || fabs(d) > 9007199254740991.0) {
    scr_throw_error_msg_code(SCR_ERR_RANGE, not_safe, sizeof not_safe - 1, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (d < 0) {
    scr_throw_error_msg_code(SCR_ERR_RANGE, negative, sizeof negative - 1, "ERR_OUT_OF_RANGE");
    return false;
  }
  *pledged = (uint64_t)d;
  return true;
}

static void scr_zstd_init_failed(void) {
  static const char message[] = "Setting parameter failed";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1,
                           "ERR_ZLIB_INITIALIZATION_FAILED");
}

/* The node_zlib_mode's parameter space: Node's kMaxZstdCParam and
 * kMaxZstdDParam are the largest ZSTD_c_* and ZSTD_d_* constants. */
static int scr_zstd_param_max(int mode) {
  return mode == SCR_ZSTD_COMPRESS ? (int)ZSTD_c_overlapLog : (int)ZSTD_d_windowLogMax;
}

static bool scr_zstd_options_object(int mode, const ScrDyn *opts, ScrZlibOptions *out) {
  memset(out, 0, sizeof *out);
  out->chunk_size = 16384;
  out->flush = ZSTD_e_continue;
  out->finish_flush = ZSTD_e_end;
  out->max_output = 9007199254740991.0;
  int const max = scr_zstd_param_max(mode);
  uint32_t *params = NULL;
  if (!scr_zstd_params(scr_zstd_opt(opts, "params"), max, &params)) {
    free(params);
    return false;
  }
  unsigned char *dict;
  size_t dict_len;
  if (!scr_zstd_dictionary(scr_zstd_opt(opts, "dictionary"), &dict, &dict_len)) {
    free(params);
    return false;
  }
  uint64_t pledged;
  if (!scr_zstd_pledged(scr_zstd_opt(opts, "pledgedSrcSize"), &pledged)) {
    free(dict);
    free(params);
    return false;
  }
  const ScrDyn *rg = scr_zstd_opt(opts, "rejectGarbageAfterEnd");
  ScrZstd *z = calloc(1, sizeof *z);
  if (!z) scr_zstd_oom();
  z->compress = mode == SCR_ZSTD_COMPRESS;
  z->dict = dict;
  z->dict_len = dict_len;
  z->pledged_src_size = pledged;
  z->reject_garbage = rg != NULL && rg->kind == SCR_DYN_BOOL && rg->v.b;
  ScrZlibError err;
  bool failed = scr_zstd_init(z, &err);
  for (size_t i = 0; !failed && i <= (size_t)max; i++) {
    if (params[i] == 0xFFFFFFFFu) continue;
    size_t const result = z->compress
                              ? ZSTD_CCtx_setParameter(z->cctx, (ZSTD_cParameter)i, (int)params[i])
                              : ZSTD_DCtx_setParameter(z->dctx, (ZSTD_dParameter)i, (int)params[i]);
    failed = ZSTD_isError(result);
  }
  free(params);
  if (failed) {
    scr_zstd_free(z);
    scr_zstd_init_failed();
    return false;
  }
  out->codec_state = z;
  out->codec_state_free = scr_zstd_free;
  /* ZlibBase's `if (opts)`: a falsy value reads no more options. */
  if (opts == NULL || !scr_dyn_truthy(opts)) return true;
  return scr_zlib_base_options(opts, SCR_ZSTD_FLUSH_MAX, out);
}

/* A typed options object is read through its materialized view. */
static bool scr_zstd_options(int mode, const ScrDyn *opts, ScrZlibOptions *out) {
  if (opts == NULL || opts->kind != SCR_DYN_TYPED_REF) return scr_zstd_options_object(mode, opts, out);
  ScrDyn *view = scr_dyn_typed_ref_materialize(opts);
  bool ok = false;
  if (scr_exc_pending()) memset(out, 0, sizeof *out);
  else ok = scr_zstd_options_object(mode, view, out);
  scr_dyn_release(view);
  return ok;
}

/* Moves the prepared state out of the options. */
static ScrZlibEngine *scr_zstd_engine(int mode, ScrZlibOptions *o) {
  ScrZstd *z = o->codec_state;
  o->codec_state = NULL;
  return scr_zlib_engine_codec(mode, &scr_zstd_codec, z, o->reject_garbage);
}

static const ScrZlibCodecHooks scr_zstd_hooks = {scr_zstd_options, scr_zstd_engine};

void scr_zstd_install(void) {
  scr_zlib_zstd_hooks = &scr_zstd_hooks;
}
