/* node:zlib, the lowered slice: the one-shot zlib/raw-DEFLATE/gzip codecs
 * over u8 bytes with Node's DEFAULT options. Compiled ONLY when the program
 * uses zlib (native-toolchain.ts gates it exactly like scr_regex.c/libregexp),
 * so zlib-free binaries keep their historical link line. Every build links
 * the vendored zlib (packages/runtime/vendor/zlib), the copy Node bundles,
 * so compressed bytes match Node's for the same parameters. deflate of valid
 * input cannot fail (OOM aborts); inflate of
 * corrupt input THROWS Node's catchable Error (zlib's own msg text:
 * "incorrect header check", ...). */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static void scr_zlib_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

ScrBytes *scr_zlib_deflate(const ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  uLong srcLen = (uLong)data->len;
  uLong cap = compressBound(srcLen);
  uint8_t *buf = malloc(cap ? cap : 1);
  if (!buf) scr_zlib_oom();
  uLongf outLen = cap;
  int rc = compress2(buf, &outLen, data->data, srcLen, Z_DEFAULT_COMPRESSION);
  if (rc != Z_OK) scr_zlib_oom(); /* Z_MEM_ERROR is the only reachable code */
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)outLen);
  out->is_buffer = true; /* Node returns a Buffer */
  memcpy(out->data, buf, outLen);
  free(buf);
  return out;
}

static int scr_zlib_window_bits(int mode, bool inflating) {
  switch (mode) {
  case 1: return -15;
  case 2: return 15 + 16;
  case 3: return inflating ? 15 + 32 : 15;
  default: return 15;
  }
}

ScrBytes *scr_zlib_deflate_mode(const ScrBytes *data, double mode, double level) {
  SCR_BYTES_SNAPSHOT(data);
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  int lvl = (int)level;
  if (lvl < -1 || lvl > 9) lvl = Z_DEFAULT_COMPRESSION;
  if (deflateInit2(&zs, lvl, Z_DEFLATED, scr_zlib_window_bits((int)mode, false), 8,
                   Z_DEFAULT_STRATEGY) != Z_OK) {
    scr_zlib_oom();
  }
  uLong cap = deflateBound(&zs, (uLong)data->len);
  uint8_t *buf = malloc(cap ? cap : 1);
  if (!buf) scr_zlib_oom();
  zs.next_in = data->data;
  zs.avail_in = (uInt)data->len;
  zs.next_out = buf;
  zs.avail_out = (uInt)cap;
  int rc = deflate(&zs, Z_FINISH);
  if (rc != Z_STREAM_END) scr_zlib_oom(); /* bound guarantees completion */
  size_t len = cap - zs.avail_out;
  deflateEnd(&zs);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
  out->is_buffer = true; /* Node returns a Buffer */
  memcpy(out->data, buf, len);
  free(buf);
  return out;
}

double scr_zlib_crc32(const ScrBytes *data, double value) {
  SCR_BYTES_SNAPSHOT(data);
  char recv[48], msg[160];
  scr_num_received(value, recv);
  if (!(isfinite(value) && trunc(value) == value)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"value\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (value < 0 || value > 4294967295.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"value\" is out of range. It must be >= 0 && <= 4294967295. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  return (double)(uint32_t)crc32_z((uLong)value, data->data, data->len);
}

/* The callback convenience methods share the executable's four-worker
 * pool with fs.rename (scr_zlib_codec_async_opts below). Only copied raw
 * bytes and malloc-owned result state cross threads; runtime RC,
 * exceptions, Buffer/Error construction, and callback execution stay on
 * the main thread. The lowering's mode numbers are 0 zlib, 1 raw, 2 gzip
 * and (decoding) 3 unzip. */
#ifndef SCR_LIB
static int scr_zlib_codec_mode_of(double mode, bool compressing);

void scr_zlib_codec_async(const ScrBytes *data, double mode, bool compressing,
                          ScrClosure *cb, ScrZlibBytesFn fn) {
  scr_zlib_codec_async_opts(data, scr_zlib_codec_mode_of(mode, compressing), NULL, cb, fn);
}
#endif

bool scr_zlib_inflate_exact(const unsigned char *src, size_t src_len,
                            unsigned char *dst, size_t dst_len) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, -15) != Z_OK) return false; /* raw DEFLATE */
  zs.next_in = (Bytef *)(uintptr_t)src;
  zs.avail_in = (uInt)src_len;
  zs.next_out = dst;
  zs.avail_out = (uInt)dst_len;
  int rc = inflate(&zs, Z_FINISH);
  bool ok = rc == Z_STREAM_END && zs.total_out == dst_len;
  inflateEnd(&zs);
  return ok;
}

/* ── the stream engine (Node's ZlibContext, node_zlib.cc) ───────────────
 * One z_stream per zlib.Gzip/Deflate/... instance. scr_zlib_stream.c owns
 * the Transform side and submits every write step to the worker pool;
 * scr_zlib_engine_work runs on the worker and touches only the z_stream.
 * Modes are Node's node_zlib_mode numbers (DEFLATE 1 ... UNZIP 7). */
struct ScrZlibEngine {
  z_stream strm;
  /* Another codec's engine (scr_zlib_engine_codec): its state answers the
   * entries below, which skip the z_stream. */
  const ScrZlibCodec *codec;
  void *codec_state;
  uint32_t codec_avail_in, codec_avail_out;
  int mode;
  int level, window_bits, mem_level, strategy;
  int flush;
  int err;
  int gzip_id_bytes_read;
  bool init_done;
  bool reject_garbage;
  unsigned char *dict;
  size_t dict_len;
};

enum { SCR_Z_DEFLATE = 1, SCR_Z_INFLATE, SCR_Z_GZIP, SCR_Z_GUNZIP, SCR_Z_DEFLATERAW,
       SCR_Z_INFLATERAW, SCR_Z_UNZIP };

ScrZlibEngine *scr_zlib_engine_new(int mode, int level, int window_bits, int mem_level,
                                   int strategy, const unsigned char *dict, size_t dict_len,
                                   bool reject_garbage) {
  ScrZlibEngine *e = calloc(1, sizeof *e);
  if (!e) scr_zlib_oom();
  e->mode = mode;
  e->level = level;
  e->mem_level = mem_level;
  e->strategy = strategy;
  e->reject_garbage = reject_garbage;
  e->flush = Z_NO_FLUSH;
  e->err = Z_OK;
  e->window_bits = window_bits;
  if (mode == SCR_Z_GZIP || mode == SCR_Z_GUNZIP) e->window_bits += 16;
  if (mode == SCR_Z_UNZIP) e->window_bits += 32;
  if (mode == SCR_Z_DEFLATERAW || mode == SCR_Z_INFLATERAW) e->window_bits *= -1;
  if (dict && dict_len > 0) {
    e->dict = malloc(dict_len);
    if (!e->dict) scr_zlib_oom();
    memcpy(e->dict, dict, dict_len);
    e->dict_len = dict_len;
  }
  return e;
}

ScrZlibEngine *scr_zlib_engine_codec(int mode, const ScrZlibCodec *codec, void *state,
                                     bool reject_garbage) {
  ScrZlibEngine *e = calloc(1, sizeof *e);
  if (!e) scr_zlib_oom();
  e->mode = mode;
  e->codec = codec;
  e->codec_state = state;
  e->reject_garbage = reject_garbage;
  return e;
}

static bool scr_zlib_engine_deflating(const ScrZlibEngine *e) {
  return e->mode == SCR_Z_DEFLATE || e->mode == SCR_Z_GZIP || e->mode == SCR_Z_DEFLATERAW;
}

/* SetDictionary: deflate modes and raw inflate load it up front; the
 * other inflate modes load it when inflate() asks (Z_NEED_DICT). */
static bool scr_zlib_engine_set_dict(ScrZlibEngine *e) {
  if (!e->dict) return true;
  e->err = Z_OK;
  if (e->mode == SCR_Z_DEFLATE || e->mode == SCR_Z_DEFLATERAW) {
    e->err = deflateSetDictionary(&e->strm, e->dict, (uInt)e->dict_len);
  } else if (e->mode == SCR_Z_INFLATERAW) {
    e->err = inflateSetDictionary(&e->strm, e->dict, (uInt)e->dict_len);
  }
  return e->err == Z_OK;
}

/* InitZlib: lazy, on the first step. True when this call initialized. */
static bool scr_zlib_engine_init(ScrZlibEngine *e) {
  if (e->init_done) return false;
  e->strm.msg = NULL;
  if (scr_zlib_engine_deflating(e)) {
    e->err = deflateInit2(&e->strm, e->level, Z_DEFLATED, e->window_bits, e->mem_level,
                          e->strategy);
  } else {
    e->err = inflateInit2(&e->strm, e->window_bits);
  }
  if (e->err != Z_OK) {
    free(e->dict);
    e->dict = NULL;
    e->dict_len = 0;
    e->mode = 0;
    return true;
  }
  scr_zlib_engine_set_dict(e);
  e->init_done = true;
  return true;
}

static int scr_zlib_engine_reset_stream(ScrZlibEngine *e) {
  if (scr_zlib_engine_init(e) && e->err != Z_OK) return 1;
  e->err = Z_OK;
  switch (e->mode) {
  case SCR_Z_DEFLATE:
  case SCR_Z_DEFLATERAW:
  case SCR_Z_GZIP: e->err = deflateReset(&e->strm); break;
  case SCR_Z_INFLATE:
  case SCR_Z_INFLATERAW:
  case SCR_Z_GUNZIP: e->err = inflateReset(&e->strm); break;
  default: break;
  }
  if (e->err != Z_OK) return 2;
  return scr_zlib_engine_set_dict(e) ? 0 : 3;
}

void scr_zlib_engine_work(ScrZlibEngine *e, int flush, const unsigned char *in, uint32_t in_len,
                          unsigned char *out, uint32_t out_len) {
  if (e->codec) {
    e->codec->work(e->codec_state, flush, in, in_len, out, out_len, &e->codec_avail_in,
                   &e->codec_avail_out);
    return;
  }
  e->strm.avail_in = in_len;
  e->strm.next_in = (Bytef *)(uintptr_t)in;
  e->strm.avail_out = out_len;
  e->strm.next_out = out;
  e->flush = flush;
  if (scr_zlib_engine_init(e) && e->err != Z_OK) return;
  switch (e->mode) {
  case SCR_Z_DEFLATE:
  case SCR_Z_GZIP:
  case SCR_Z_DEFLATERAW:
    e->err = deflate(&e->strm, flush);
    return;
  case SCR_Z_UNZIP: {
    /* The gzip magic decides GUNZIP vs INFLATE, possibly across steps. */
    const Bytef *next = e->strm.avail_in > 0 ? e->strm.next_in : NULL;
    if (e->gzip_id_bytes_read == 0 && next != NULL) {
      if (*next == 0x1f) {
        e->gzip_id_bytes_read = 1;
        next++;
        if (e->strm.avail_in == 1) next = NULL;
      } else {
        e->mode = SCR_Z_INFLATE;
        next = NULL;
      }
    }
    if (e->gzip_id_bytes_read == 1 && next != NULL && e->mode == SCR_Z_UNZIP) {
      if (*next == 0x8b) {
        e->gzip_id_bytes_read = 2;
        e->mode = SCR_Z_GUNZIP;
      } else {
        e->mode = SCR_Z_INFLATE;
      }
    }
  }
  /* fallthrough */
  case SCR_Z_INFLATE:
  case SCR_Z_GUNZIP:
  case SCR_Z_INFLATERAW:
    e->err = inflate(&e->strm, flush);
    if (e->mode != SCR_Z_INFLATERAW && e->err == Z_NEED_DICT && e->dict) {
      e->err = inflateSetDictionary(&e->strm, e->dict, (uInt)e->dict_len);
      if (e->err == Z_OK) e->err = inflate(&e->strm, flush);
      else if (e->err == Z_DATA_ERROR) e->err = Z_NEED_DICT;
    }
    /* Another gzip member may follow; trailing zero bytes are padding. */
    while (e->strm.avail_in > 0 && e->mode == SCR_Z_GUNZIP && e->err == Z_STREAM_END &&
           !e->reject_garbage && e->strm.next_in[0] != 0x00) {
      scr_zlib_engine_reset_stream(e);
      e->err = inflate(&e->strm, flush);
    }
    return;
  default:
    return;
  }
}

void scr_zlib_engine_offsets(const ScrZlibEngine *e, uint32_t *avail_in, uint32_t *avail_out) {
  if (e->codec) {
    *avail_in = e->codec_avail_in;
    *avail_out = e->codec_avail_out;
    return;
  }
  *avail_in = e->strm.avail_in;
  *avail_out = e->strm.avail_out;
}

static const char *scr_zlib_strerror(int err) {
  switch (err) {
  case Z_OK: return "Z_OK";
  case Z_STREAM_END: return "Z_STREAM_END";
  case Z_NEED_DICT: return "Z_NEED_DICT";
  case Z_ERRNO: return "Z_ERRNO";
  case Z_STREAM_ERROR: return "Z_STREAM_ERROR";
  case Z_DATA_ERROR: return "Z_DATA_ERROR";
  case Z_MEM_ERROR: return "Z_MEM_ERROR";
  case Z_BUF_ERROR: return "Z_BUF_ERROR";
  case Z_VERSION_ERROR: return "Z_VERSION_ERROR";
  default: return "Z_UNKNOWN_ERROR";
  }
}

static bool scr_zlib_engine_fail(const ScrZlibEngine *e, const char *message, ScrZlibError *out) {
  out->message = e->strm.msg ? e->strm.msg : message;
  out->code = scr_zlib_strerror(e->err);
  out->err = e->err;
  return true;
}

bool scr_zlib_engine_error(const ScrZlibEngine *e, ScrZlibError *out) {
  if (e->codec) return e->codec->error(e->codec_state, out);
  switch (e->err) {
  case Z_OK:
  case Z_BUF_ERROR:
    if (e->strm.avail_out != 0 && e->flush == Z_FINISH)
      return scr_zlib_engine_fail(e, "unexpected end of file", out);
    return false;
  case Z_STREAM_END: return false;
  case Z_NEED_DICT:
    return scr_zlib_engine_fail(e, e->dict ? "Bad dictionary" : "Missing dictionary", out);
  default: return scr_zlib_engine_fail(e, "Zlib error", out);
  }
}

bool scr_zlib_engine_reset(ScrZlibEngine *e, ScrZlibError *out) {
  if (e->codec) return e->codec->reset(e->codec_state, out);
  switch (scr_zlib_engine_reset_stream(e)) {
  case 0: return false;
  case 1: return scr_zlib_engine_fail(e, "Failed to init stream before reset", out);
  case 2: return scr_zlib_engine_fail(e, "Failed to reset stream", out);
  default: return scr_zlib_engine_fail(e, "Failed to set dictionary", out);
  }
}

/* SetParams: deflateParams for DEFLATE and DEFLATERAW only (Node's
 * switch leaves GZIP's level and strategy unchanged). */
bool scr_zlib_engine_params(ScrZlibEngine *e, int level, int strategy, ScrZlibError *out) {
  if (e->codec) return false; /* Node's Brotli streams have no params() */
  if (scr_zlib_engine_init(e) && e->err != Z_OK)
    return scr_zlib_engine_fail(e, "Failed to init stream before set parameters", out);
  e->err = Z_OK;
  if (e->mode == SCR_Z_DEFLATE || e->mode == SCR_Z_DEFLATERAW)
    e->err = deflateParams(&e->strm, level, strategy);
  if (e->err != Z_OK && e->err != Z_BUF_ERROR)
    return scr_zlib_engine_fail(e, "Failed to set parameters", out);
  return false;
}

void scr_zlib_engine_free(ScrZlibEngine *e) {
  if (!e) return;
  if (e->codec) {
    e->codec->free(e->codec_state);
    free(e);
    return;
  }
  if (e->init_done) {
    if (scr_zlib_engine_deflating(e)) deflateEnd(&e->strm);
    else inflateEnd(&e->strm);
  }
  free(e->dict);
  free(e);
}

/* ── the option ladder (lib/zlib.js Zlib() and ZlibBase()) ───────────────
 * Shared by the stream classes and the one-shot forms with options: the
 * Zlib reads (windowBits, level, memLevel, strategy, dictionary), then the
 * ZlibBase reads (chunkSize, flush, finishFlush, maxOutputLength,
 * rejectGarbageAfterEnd), with lib/internal/validators.js's messages. */
static void scr_zlib_range_fail(const char *name, const char *range, double v) {
  char recv[48], msg[256];
  scr_num_received(v, recv);
  int len = snprintf(msg, sizeof msg, "The value of \"%s\" is out of range. It must be %s. Received %s",
                     name, range, recv);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
}

/* validateFiniteNumber: false for undefined/NaN, true for finite numbers,
 * throws otherwise. `prop` picks the property/argument message flavor. */
static bool scr_zlib_finite(const ScrDyn *v, const char *name, bool prop, bool *ok) {
  *ok = true;
  if (v == NULL || v->kind == SCR_DYN_UNDEF) return false;
  if (v->kind == SCR_DYN_NUM) {
    if (isfinite(v->v.num)) return true;
    if (isnan(v->v.num)) return false;
    scr_zlib_range_fail(name, "a finite number", v->v.num);
    *ok = false;
    return false;
  }
  if (prop) scr_dyn_prop_type_fail(name, "of type number", v);
  else scr_dyn_arg_type_fail(name, "of type number", v);
  *ok = false;
  return false;
}

bool scr_zlib_check_range(const ScrDyn *v, const char *name, bool prop, double lower, double upper,
                          double def, double *out) {
  bool ok;
  if (!scr_zlib_finite(v, name, prop, &ok)) {
    *out = def;
    return ok;
  }
  if (v->v.num < lower || v->v.num > upper) {
    char range[96];
    snprintf(range, sizeof range, ">= %.17g and <= %.17g", lower, upper);
    scr_zlib_range_fail(name, range, v->v.num);
    return false;
  }
  *out = v->v.num;
  return true;
}

static const ScrDyn *scr_zlib_opt(const ScrDyn *opts, const char *key) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return NULL;
  return scr_dyn_obj_get((ScrDyn *)opts, key, strlen(key));
}

static bool scr_zlib_is_null(const ScrDyn *v) {
  return v == NULL || v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL;
}

void scr_zlib_options_drop(ScrZlibOptions *o) {
  if (o->dict) scr_bytes_release(o->dict);
  o->dict = NULL;
  if (o->codec_state) o->codec_state_free(o->codec_state);
  o->codec_state = NULL;
}

const ScrZlibBrotliHooks *scr_zlib_brotli_hooks = NULL;

/* Node's BROTLI_DECODE and BROTLI_ENCODE modes. */
static bool scr_zlib_brotli_mode(int mode) {
  return mode == 8 || mode == 9;
}

static bool scr_zlib_options_parse_object(int mode, const ScrDyn *opts, ScrZlibOptions *out);

/* A typed options object (a record that crossed into a checked-dynamic
 * slot by reference) is read through its materialized view, as a plain
 * object is. */
bool scr_zlib_options_parse(int mode, const ScrDyn *opts, ScrZlibOptions *out) {
  if (scr_zlib_brotli_mode(mode)) {
    if (!scr_zlib_brotli_hooks) scr_trap("scriptc: the Brotli codec is not linked\n");
    return scr_zlib_brotli_hooks->options(mode, opts, out);
  }
  if (opts == NULL || opts->kind != SCR_DYN_TYPED_REF) return scr_zlib_options_parse_object(mode, opts, out);
  ScrDyn *view = scr_dyn_typed_ref_materialize(opts);
  bool ok = false;
  if (scr_exc_pending()) memset(out, 0, sizeof *out);
  else ok = scr_zlib_options_parse_object(mode, view, out);
  scr_dyn_release(view);
  return ok;
}

static bool scr_zlib_options_parse_object(int mode, const ScrDyn *opts, ScrZlibOptions *out) {
  memset(out, 0, sizeof *out);
  out->window_bits = 15;
  out->level = Z_DEFAULT_COMPRESSION;
  out->mem_level = 8;
  out->strategy = Z_DEFAULT_STRATEGY;
  out->chunk_size = 16384;
  out->flush = Z_NO_FLUSH;
  out->finish_flush = Z_FINISH;
  out->max_output = 9007199254740991.0;
  /* Node's `if (opts)`: a falsy value reads no options. */
  const ScrDyn *o = opts != NULL && scr_dyn_truthy(opts) ? opts : NULL;
  if (o == NULL) return true;
  const ScrDyn *wb = scr_zlib_opt(o, "windowBits");
  if (mode == SCR_Z_DEFLATERAW && wb != NULL && wb->kind == SCR_DYN_NUM && wb->v.num == 8) {
    out->window_bits = 9; /* DeflateRaw rewrites windowBits 8 as 9 */
  } else if ((scr_zlib_is_null(wb) || (wb->kind == SCR_DYN_NUM && wb->v.num == 0)) &&
             (mode == SCR_Z_INFLATE || mode == SCR_Z_GUNZIP || mode == SCR_Z_UNZIP)) {
    out->window_bits = 0;
  } else if (!scr_zlib_check_range(wb, "options.windowBits", true, mode == SCR_Z_GZIP ? 9 : 8, 15,
                                   15, &out->window_bits)) {
    return false;
  }
  if (!scr_zlib_check_range(scr_zlib_opt(o, "level"), "options.level", true, -1, 9, -1,
                            &out->level) ||
      !scr_zlib_check_range(scr_zlib_opt(o, "memLevel"), "options.memLevel", true, 1, 9, 8,
                            &out->mem_level) ||
      !scr_zlib_check_range(scr_zlib_opt(o, "strategy"), "options.strategy", true, 0, 4, 0,
                            &out->strategy)) {
    return false;
  }
  const ScrDyn *d = scr_zlib_opt(o, "dictionary");
  if (d != NULL && d->kind != SCR_DYN_UNDEF) {
    if (d->kind != SCR_DYN_BYTES) {
      scr_dyn_prop_type_fail("options.dictionary",
                             "an instance of Buffer, TypedArray, DataView, or ArrayBuffer", d);
      return false;
    }
    out->dict = scr_bytes_raw_view(d->v.bytes);
  }
  return scr_zlib_base_options(o, 5, out);
}

bool scr_zlib_base_options(const ScrDyn *o, double flush_max, ScrZlibOptions *out) {
  const ScrDyn *rg = scr_zlib_opt(o, "rejectGarbageAfterEnd");
  out->reject_garbage = rg != NULL && rg->kind == SCR_DYN_BOOL && rg->v.b;
  const ScrDyn *cs = scr_zlib_opt(o, "chunkSize");
  bool ok;
  if (scr_zlib_finite(cs, "options.chunkSize", true, &ok)) {
    if (cs->v.num < 64) {
      scr_zlib_range_fail("options.chunkSize", ">= 64", cs->v.num);
      ok = false;
    } else {
      out->chunk_size = floor(cs->v.num);
    }
  }
  if (!ok ||
      !scr_zlib_check_range(scr_zlib_opt(o, "flush"), "options.flush", true, 0, flush_max,
                            out->flush, &out->flush) ||
      !scr_zlib_check_range(scr_zlib_opt(o, "finishFlush"), "options.finishFlush", true, 0,
                            flush_max, out->finish_flush, &out->finish_flush) ||
      !scr_zlib_check_range(scr_zlib_opt(o, "maxOutputLength"), "options.maxOutputLength", true, 1,
                            9007199254740991.0, 9007199254740991.0, &out->max_output)) {
    scr_zlib_options_drop(out);
    return false;
  }
  if (rg != NULL && rg->kind != SCR_DYN_UNDEF && rg->kind != SCR_DYN_BOOL) {
    scr_zlib_options_drop(out);
    scr_dyn_prop_type_fail("options.rejectGarbageAfterEnd", "of type boolean", rg);
    return false;
  }
  if (out->chunk_size > 4294967295.0) {
    scr_zlib_options_drop(out);
    static const char msg[] = "a zlib chunkSize above 4294967295 is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return false;
  }
  const ScrDyn *info = scr_zlib_opt(o, "info");
  out->info = info != NULL && scr_dyn_truthy(info);
  return true;
}

ScrZlibEngine *scr_zlib_engine_from_options(int mode, ScrZlibOptions *o) {
  if (scr_zlib_brotli_mode(mode)) return scr_zlib_brotli_hooks->engine(mode, o);
  return scr_zlib_engine_new(mode, (int)o->level, (int)o->window_bits, (int)o->mem_level,
                             (int)o->strategy, o->dict ? o->dict->data : NULL,
                             o->dict ? o->dict->len : 0, o->reject_garbage);
}

/* Node's error for an engine failure: Error(message) with errno and code. */
ScrError *scr_zlib_error_new(const ScrZlibError *ze) {
  ScrStr *message = scr_str_new(ze->message, strlen(ze->message));
  ScrError *err = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  err->system_errno = ze->err;
  scr_error_set_code(err, ze->code);
  return err;
}

/* ── the one-shot forms with options (processChunkSync / zlibBuffer) ────
 * One run over the whole input with the finish flush, the output filling
 * chunkSize steps; worker-safe (no runtime calls). */
typedef struct {
  unsigned char *data;
  size_t len, cap;
  int status; /* 0 ok, 1 engine error, 2 past maxOutputLength, 3 trailing data */
  ScrZlibError err;
} ScrZlibRun;

static void scr_zlib_run(ScrZlibEngine *e, const unsigned char *in, size_t in_len, uint32_t chunk,
                         int flush, double max_output, bool reject, ScrZlibRun *out) {
  uint32_t in_off = 0, avail_in_before = (uint32_t)in_len, avail_out_before = chunk;
  uint32_t offset = 0, avail_in_after = 0, avail_out_after = 0;
  for (;;) {
    if (out->len + avail_out_before > out->cap) {
      size_t cap = out->cap ? out->cap : chunk;
      while (cap < out->len + avail_out_before) cap *= 2;
      unsigned char *grown = realloc(out->data, cap);
      if (!grown) scr_zlib_oom();
      out->data = grown;
      out->cap = cap;
    }
    scr_zlib_engine_work(e, flush, in + in_off, avail_in_before, out->data + out->len,
                         avail_out_before);
    if (scr_zlib_engine_error(e, &out->err)) {
      out->status = 1;
      return;
    }
    scr_zlib_engine_offsets(e, &avail_in_after, &avail_out_after);
    uint32_t in_delta = avail_in_before - avail_in_after;
    uint32_t have = avail_out_before - avail_out_after;
    out->len += have;
    offset += have;
    if ((double)out->len > max_output) {
      out->status = 2;
      return;
    }
    if (avail_out_after == 0 || offset >= chunk) {
      avail_out_before = chunk;
      offset = 0;
    } else {
      avail_out_before = chunk - offset;
    }
    if (avail_out_after != 0) break;
    in_off += in_delta;
    avail_in_before = avail_in_after;
  }
  if (avail_in_after > 0 && reject) out->status = 3;
}

static ScrError *scr_zlib_run_error(const ScrZlibRun *run, double max_output) {
  if (run->status == 1) return scr_zlib_error_new(&run->err);
  char msg[96];
  int type = SCR_ERR_TYPE;
  const char *code = "ERR_TRAILING_JUNK_AFTER_STREAM_END";
  if (run->status == 2) {
    char num[32];
    scr_f64_to_str(max_output, num);
    snprintf(msg, sizeof msg, "Cannot create a Buffer larger than %s bytes", num);
    type = SCR_ERR_RANGE;
    code = "ERR_BUFFER_TOO_LARGE";
  } else {
    snprintf(msg, sizeof msg, "Trailing junk found after the end of the compressed stream");
  }
  ScrStr *message = scr_str_new(msg, strlen(msg));
  ScrError *err = scr_error_new(type, message);
  scr_str_release(message);
  scr_error_set_code(err, code);
  return err;
}

static bool scr_zlib_refuse_info(const ScrZlibOptions *o) {
  if (!o->info) return false;
  static const char msg[] =
      "the zlib option 'info' is not supported yet (it returns the engine object)";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  return true;
}

/* A checked-dynamic input (the JS lane): strings encode as UTF-8, any
 * TypedArray, DataView or ArrayBuffer contributes its bytes, and anything
 * else throws Node's ERR_INVALID_ARG_TYPE — zlibBufferSync's "buffer"
 * check, or the stream write's "chunk" check for the callback forms. */
static ScrBytes *scr_zlib_input_dyn(const ScrDyn *v, bool callback) {
  if (v->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(v);
    if (!materialized) return NULL;
    ScrBytes *out = scr_zlib_input_dyn(materialized, callback);
    scr_dyn_release(materialized);
    return out;
  }
  if (v->kind == SCR_DYN_STR) {
    ScrStr *str = v->v.str;
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)str->len);
    memcpy(b->data, str->data, str->len);
    if (!str->ascii) scr_wtf8_to_utf8((char *)b->data, str->len);
    return b;
  }
  if (v->kind == SCR_DYN_BYTES) return scr_bytes_raw_view(v->v.bytes);
  if (scr_buffer_storage_is(v))
    return scr_array_buffer_view(SCR_BYTES_U8, (ScrDyn *)v, scr_dyn_undefined(), scr_dyn_undefined());
  if (callback)
    scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", v);
  else
    scr_dyn_arg_type_fail(
        "buffer", "of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer", v);
  return NULL;
}

static ScrBytes *scr_zlib_sync_run(int mode, const ScrBytes *data, ScrZlibOptions *o);

ScrBytes *scr_zlib_sync_opts_dyn(double mode_d, ScrDyn *data, ScrDyn *opts) {
  int mode = (int)mode_d;
  ScrZlibOptions o;
  if (!scr_zlib_options_parse(mode, opts, &o)) return NULL;
  if (scr_zlib_refuse_info(&o)) {
    scr_zlib_options_drop(&o);
    return NULL;
  }
  ScrBytes *input = scr_zlib_input_dyn(data, false);
  if (!input) {
    scr_zlib_options_drop(&o);
    return NULL;
  }
  ScrBytes *out = scr_zlib_sync_run(mode, input, &o);
  scr_bytes_release(input);
  return out;
}

ScrBytes *scr_zlib_sync_opts(double mode_d, const ScrBytes *data, ScrDyn *opts) {
  int mode = (int)mode_d;
  ScrZlibOptions o;
  if (!scr_zlib_options_parse(mode, opts, &o)) return NULL;
  if (scr_zlib_refuse_info(&o)) {
    scr_zlib_options_drop(&o);
    return NULL;
  }
  return scr_zlib_sync_run(mode, data, &o);
}

/* Runs the whole input and drops *o. */
static ScrBytes *scr_zlib_sync_run(int mode, const ScrBytes *data, ScrZlibOptions *o_) {
  SCR_BYTES_SNAPSHOT(data);
  ScrZlibOptions o = *o_;
  ScrZlibEngine *e = scr_zlib_engine_from_options(mode, &o);
  ScrZlibRun run = {NULL, 0, 0, 0, {NULL, NULL, 0}};
  scr_zlib_run(e, data->data, data->len, (uint32_t)o.chunk_size, (int)o.finish_flush, o.max_output,
               o.reject_garbage, &run);
  ScrBytes *result = NULL;
  if (run.status != 0) {
    ScrError *err = scr_zlib_run_error(&run, o.max_output);
    scr_throw_obj(err, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  } else {
    result = scr_bytes_new(SCR_BYTES_U8, (double)run.len);
    result->is_buffer = true; /* Node returns a Buffer */
    if (run.len) memcpy(result->data, run.data, run.len);
  }
  free(run.data);
  scr_zlib_engine_free(e);
  scr_zlib_options_drop(&o);
  return result;
}

#ifndef SCR_LIB
typedef struct {
  ScrZlibEngine *eng;
  unsigned char *data;
  size_t len;
  uint32_t chunk;
  int flush;
  double max_output;
  bool reject;
  ScrZlibRun run;
  ScrClosure *cb;
  ScrZlibBytesFn fn;
  ScrPromise *promise; /* the promise form settles this instead of calling cb */
} ScrZlibOptsOp;

static void scr_zlib_opts_work(void *payload) {
  ScrZlibOptsOp *op = payload;
  scr_zlib_run(op->eng, op->data, op->len, op->chunk, op->flush, op->max_output, op->reject,
               &op->run);
}

static void scr_zlib_opts_after(void *payload) {
  ScrZlibOptsOp *op = payload;
  if (op->run.status == 0) {
    ScrBytes *value = scr_bytes_new(SCR_BYTES_U8, (double)op->run.len);
    value->is_buffer = true; /* Node returns a Buffer */
    if (op->run.len) memcpy(value->data, op->run.data, op->run.len);
    if (op->promise) {
      /* moves value */
      scr_promise_fulfill_ref(op->promise, value, &scr_bytes_retain_v, &scr_bytes_release_v, NULL);
      return;
    }
    op->fn(op->cb, NULL, value);
    return;
  }
  ScrError *err = scr_zlib_run_error(&op->run, op->max_output);
  if (op->promise) {
    scr_throw_obj(err, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
    scr_promise_reject_pending(op->promise);
    return;
  }
  op->fn(op->cb, err, NULL);
  scr_error_release(err);
}

static void scr_zlib_opts_destroy(void *payload) {
  ScrZlibOptsOp *op = payload;
  scr_zlib_engine_free(op->eng);
  free(op->data);
  free(op->run.data);
  if (op->cb) scr_closure_release(op->cb);
  if (op->promise) scr_promise_release(op->promise);
  free(op);
}

static void scr_zlib_async_submit(int mode, const ScrBytes *data, ScrZlibOptions *o_,
                                  ScrClosure *cb, ScrZlibBytesFn fn, ScrPromise *promise);

static bool scr_zlib_async_options(int mode, ScrDyn *opts, ScrZlibOptions *o, ScrClosure *cb) {
  if (!scr_zlib_options_parse(mode, opts, o)) {
    scr_closure_release(cb);
    return false;
  }
  if (scr_zlib_refuse_info(o)) {
    scr_zlib_options_drop(o);
    scr_closure_release(cb);
    return false;
  }
  return true;
}

void scr_zlib_codec_async_opts(const ScrBytes *data, double mode_d, ScrDyn *opts, ScrClosure *cb,
                               ScrZlibBytesFn fn) {
  int mode = (int)mode_d;
  ScrZlibOptions o;
  if (scr_zlib_async_options(mode, opts, &o, cb)) scr_zlib_async_submit(mode, data, &o, cb, fn, NULL);
}

void scr_zlib_codec_async_opts_dyn(ScrDyn *data, double mode_d, ScrDyn *opts, ScrClosure *cb,
                                   ScrZlibBytesFn fn) {
  int mode = (int)mode_d;
  ScrZlibOptions o;
  if (!scr_zlib_async_options(mode, opts, &o, cb)) return;
  ScrBytes *input = scr_zlib_input_dyn(data, true);
  if (!input) {
    scr_zlib_options_drop(&o);
    scr_closure_release(cb);
    return;
  }
  scr_zlib_async_submit(mode, input, &o, cb, fn, NULL);
  scr_bytes_release(input);
}

/* The promise forms: a refused option or input rejects the promise. */
ScrPromise *scr_zlib_codec_promise(const ScrBytes *data, double mode_d, ScrDyn *opts) {
  int mode = (int)mode_d;
  ScrPromise *promise = scr_promise_new();
  ScrZlibOptions o;
  if (!scr_zlib_async_options(mode, opts, &o, NULL)) {
    scr_promise_reject_pending(promise);
    return promise;
  }
  scr_zlib_async_submit(mode, data, &o, NULL, NULL, scr_promise_retain(promise));
  return promise;
}

ScrPromise *scr_zlib_codec_promise_dyn(ScrDyn *data, double mode_d, ScrDyn *opts) {
  int mode = (int)mode_d;
  ScrPromise *promise = scr_promise_new();
  ScrZlibOptions o;
  if (!scr_zlib_async_options(mode, opts, &o, NULL)) {
    scr_promise_reject_pending(promise);
    return promise;
  }
  ScrBytes *input = scr_zlib_input_dyn(data, true);
  if (!input) {
    scr_zlib_options_drop(&o);
    scr_promise_reject_pending(promise);
    return promise;
  }
  scr_zlib_async_submit(mode, input, &o, NULL, NULL, scr_promise_retain(promise));
  scr_bytes_release(input);
  return promise;
}

/* Moves cb (or the +1 promise) and drops *o_. */
static void scr_zlib_async_submit(int mode, const ScrBytes *data, ScrZlibOptions *o_,
                                  ScrClosure *cb, ScrZlibBytesFn fn, ScrPromise *promise) {
  SCR_BYTES_SNAPSHOT(data);
  ScrZlibOptions o = *o_;
  ScrZlibOptsOp *op = calloc(1, sizeof *op);
  if (!op) scr_zlib_oom();
  op->eng = scr_zlib_engine_from_options(mode, &o);
  op->data = malloc(data->len ? data->len : 1);
  if (!op->data) scr_zlib_oom();
  if (data->len) memcpy(op->data, data->data, data->len);
  op->len = data->len;
  op->chunk = (uint32_t)o.chunk_size;
  op->flush = (int)o.finish_flush;
  op->max_output = o.max_output;
  op->reject = o.reject_garbage;
  op->cb = cb;
  op->fn = fn;
  op->promise = promise; /* +1, moves */
  scr_zlib_options_drop(&o);
  scr_work_submit(op, &scr_zlib_opts_work, &scr_zlib_opts_after, &scr_zlib_opts_destroy);
}
#endif

/* The default-options forms run Node's engine too: the decoders read
 * every gzip member and their errors carry errno and code. */
static int scr_zlib_codec_mode_of(double mode, bool compressing) {
  switch ((int)mode) {
  case 1: return compressing ? SCR_Z_DEFLATERAW : SCR_Z_INFLATERAW;
  case 2: return compressing ? SCR_Z_GZIP : SCR_Z_GUNZIP;
  case 3: return SCR_Z_UNZIP;
  default: return compressing ? SCR_Z_DEFLATE : SCR_Z_INFLATE;
  }
}

ScrBytes *scr_zlib_inflate(const ScrBytes *data) {
  return scr_zlib_sync_opts(SCR_Z_INFLATE, data, NULL);
}

ScrBytes *scr_zlib_inflate_mode(const ScrBytes *data, double mode) {
  return scr_zlib_sync_opts(scr_zlib_codec_mode_of(mode, false), data, NULL);
}
