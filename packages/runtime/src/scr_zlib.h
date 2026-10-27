/* scriptc runtime — zlib (scr_zlib.c). Included by scr_runtime.h, which says
 * where new declarations go. */
#ifndef SCR_ZLIB_H
#define SCR_ZLIB_H

#include "scr_bytes.h"

/* ── zlib (scr_zlib.c — compiled and linked with -lz only when the
 * program uses zlib, like scr_regex.c/libregexp; see native-toolchain.ts) ──────────
 * deflateSync/inflateSync over u8 bytes with Node's default options
 * (zlib format, default level/windowBits). deflate never throws (OOM
 * aborts); inflate of corrupt input THROWS Node's error catchably
 * ("incorrect header check", ...). Borrow their input; results +1. */
ScrBytes *scr_zlib_deflate(const ScrBytes *data);
ScrBytes *scr_zlib_inflate(const ScrBytes *data);

ScrBytes *scr_zlib_deflate_mode(const ScrBytes *data, double mode, double level);
ScrBytes *scr_zlib_inflate_mode(const ScrBytes *data, double mode);
double scr_zlib_crc32(const ScrBytes *data, double value);
typedef void (*ScrZlibBytesFn)(ScrClosure *cb, ScrError *err,
                              ScrBytes *value /* moves, NULL on error */);
void scr_zlib_codec_async(const ScrBytes *data, double mode, bool compressing,
                          ScrClosure *cb /* moves */, ScrZlibBytesFn fn);
/* The stream engine (Node's ZlibContext): one z_stream per zlib stream
 * object, initialized on its first step. scr_zlib_engine_work runs on a
 * worker thread and touches only the engine; every other entry runs on the
 * main thread. The error entries answer true and fill *out (static or
 * engine-owned strings) when Node would emit an error. */
typedef struct ScrZlibEngine ScrZlibEngine;
typedef struct {
  const char *message;
  const char *code;
  int err;
} ScrZlibError;
ScrZlibEngine *scr_zlib_engine_new(int mode, int level, int window_bits, int mem_level,
                                   int strategy, const unsigned char *dict, size_t dict_len,
                                   bool reject_garbage);
void scr_zlib_engine_work(ScrZlibEngine *e, int flush, const unsigned char *in, uint32_t in_len,
                          unsigned char *out, uint32_t out_len);
void scr_zlib_engine_offsets(const ScrZlibEngine *e, uint32_t *avail_in, uint32_t *avail_out);
bool scr_zlib_engine_error(const ScrZlibEngine *e, ScrZlibError *out);
bool scr_zlib_engine_reset(ScrZlibEngine *e, ScrZlibError *out);
bool scr_zlib_engine_params(ScrZlibEngine *e, int level, int strategy, ScrZlibError *out);
void scr_zlib_engine_free(ScrZlibEngine *e);
/* Another codec behind the same engine (Brotli, scr_brotli.c): the engine
 * entries above call these on its state. work runs on a worker thread and
 * reports the unused input and output; error and reset fill *out as the
 * zlib entries do. free releases the state. */
typedef struct {
  void (*work)(void *state, int flush, const unsigned char *in, uint32_t in_len, unsigned char *out,
               uint32_t out_len, uint32_t *avail_in, uint32_t *avail_out);
  bool (*error)(const void *state, ScrZlibError *out);
  bool (*reset)(void *state, ScrZlibError *out);
  void (*free)(void *state);
} ScrZlibCodec;
ScrZlibEngine *scr_zlib_engine_codec(int mode, const ScrZlibCodec *codec, void *state /* moves */,
                                     bool reject_garbage);
/* Node's Zlib() and ZlibBase() option ladder, shared by the stream classes
 * and the one-shot forms with options: false with Node's error pending.
 * `dict` is a +1 view (or NULL) that scr_zlib_options_drop releases.
 * scr_zlib_check_range is checkRangesOrGetDefault (`prop` picks the
 * "property" message flavor over "argument"). */
typedef struct {
  double window_bits, level, mem_level, strategy;
  ScrBytes *dict;
  bool reject_garbage, info;
  double chunk_size, flush, finish_flush, max_output;
  /* Another codec's prepared state (a Brotli instance with its parameters
   * set), which scr_zlib_engine_from_options moves into the engine and
   * scr_zlib_options_drop frees otherwise. */
  void *codec_state;
  void (*codec_state_free)(void *state);
} ScrZlibOptions;
bool scr_zlib_options_parse(int mode, const ScrDyn *opts, ScrZlibOptions *out);
void scr_zlib_options_drop(ScrZlibOptions *o);
/* ZlibBase's reads over a truthy options object, after the codec's own:
 * chunkSize, flush and finishFlush (within 0..flush_max), maxOutputLength,
 * rejectGarbageAfterEnd and info. False with Node's error pending, *out
 * dropped. */
bool scr_zlib_base_options(const ScrDyn *opts, double flush_max, ScrZlibOptions *out);
/* Brotli's option ladder and engine (scr_brotli.c), installed when the
 * program uses Brotli: scr_zlib_options_parse and
 * scr_zlib_engine_from_options call them for Node's BROTLI_DECODE (8) and
 * BROTLI_ENCODE (9) modes. */
typedef struct {
  bool (*options)(int mode, const ScrDyn *opts, ScrZlibOptions *out);
  ScrZlibEngine *(*engine)(int mode, ScrZlibOptions *o);
} ScrZlibBrotliHooks;
extern const ScrZlibBrotliHooks *scr_zlib_brotli_hooks;
void scr_brotli_install(void);
bool scr_zlib_check_range(const ScrDyn *v, const char *name, bool prop, double lower, double upper,
                          double def, double *out);
ScrZlibEngine *scr_zlib_engine_from_options(int mode, ScrZlibOptions *o);
ScrError *scr_zlib_error_new(const ScrZlibError *ze); /* +1 */
/* deflateSync(data, options) and the other one-shot forms with an options
 * value (undefined for none): Node's processChunkSync over the engine,
 * throwing Node's errors (errno and code, ERR_BUFFER_TOO_LARGE,
 * ERR_TRAILING_JUNK_AFTER_STREAM_END). The callback twin validates the
 * options synchronously, runs on the worker pool, and moves cb. */
ScrBytes *scr_zlib_sync_opts(double mode, const ScrBytes *data, ScrDyn *opts);
void scr_zlib_codec_async_opts(const ScrBytes *data, double mode, ScrDyn *opts,
                               ScrClosure *cb /* moves */, ScrZlibBytesFn fn);
/* The checked-dynamic input twins (the JS lane's untyped data): after the
 * options, strings encode as UTF-8, TypedArrays, DataViews and ArrayBuffers
 * contribute their bytes, and other values throw Node's
 * ERR_INVALID_ARG_TYPE ("buffer", or "chunk" for the callback forms). */
ScrBytes *scr_zlib_sync_opts_dyn(double mode, ScrDyn *data, ScrDyn *opts);
void scr_zlib_codec_async_opts_dyn(ScrDyn *data, double mode, ScrDyn *opts,
                                   ScrClosure *cb /* moves */, ScrZlibBytesFn fn);
/* util.promisify over the callback one-shots: the callback forms' work,
 * answering a +1 promise instead of calling back. An options or input
 * error rejects the promise (the throw Node's promisify turns into a
 * rejection); otherwise the worker-pool run fulfills it with the Buffer or
 * rejects it with the callback form's Error, where that callback would
 * run. Never throws. */
typedef struct ScrPromise ScrPromise;
ScrPromise *scr_zlib_codec_promise(const ScrBytes *data, double mode, ScrDyn *opts);
ScrPromise *scr_zlib_codec_promise_dyn(ScrDyn *data, double mode, ScrDyn *opts);
/* zlib.Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw and Unzip
 * (scr_zlib_stream.c — linked when the program uses both zlib and the
 * stream surface): Transform streams over the engine. mode is Node's
 * node_zlib_mode, opts the options value (undefined for none), validated
 * with Node's ladder. The callbacks MOVE in and may be NULL. */
ScrStream *scr_zlib_stream_new(double mode, ScrDyn *opts);
double scr_zlib_stream_bytes_written(ScrStream *s);
/* `s instanceof zlib.Gzip` (and the other classes): true when s is a zlib
 * stream built with that mode. s is borrowed. */
bool scr_zlib_stream_is(ScrStream *s, double mode);
void scr_zlib_stream_flush(ScrStream *s, ScrDyn *kind, ScrClosure *cb);
void scr_zlib_stream_params(ScrStream *s, ScrDyn *level, ScrDyn *strategy, ScrClosure *cb);
void scr_zlib_stream_close(ScrStream *s, ScrClosure *cb);
void scr_zlib_stream_reset(ScrStream *s);

#endif /* SCR_ZLIB_H */
