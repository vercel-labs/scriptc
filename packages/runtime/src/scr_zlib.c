/* node:zlib, the lowered slice: the one-shot zlib/raw-DEFLATE/gzip codecs
 * over u8 bytes with Node's DEFAULT options. Compiled ONLY when the program
 * uses zlib (native-toolchain.ts gates it exactly like scr_regex.c/libregexp),
 * so zlib-free binaries keep their historical link line. Host builds link
 * the system -lz; cross targets link the vendored zlib built per target
 * (ensureZlibObjects in native-toolchain.ts).
 *
 * Compressed OUTPUT bytes are zlib-version-dependent — the differential
 * corpus tests round-trips and fixed-blob inflation, never raw deflate
 * output. deflate of valid input cannot fail (OOM aborts); inflate of
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
  memcpy(out->data, buf, outLen);
  free(buf);
  return out;
}

ScrBytes *scr_zlib_inflate(const ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit(&zs) != Z_OK) scr_zlib_oom();
  size_t cap = data->len > 64 ? data->len * 4 : 256;
  uint8_t *buf = malloc(cap);
  if (!buf) scr_zlib_oom();
  zs.next_in = data->data;
  zs.avail_in = (uInt)data->len;
  size_t len = 0;
  for (;;) {
    zs.next_out = buf + len;
    zs.avail_out = (uInt)(cap - len);
    int rc = inflate(&zs, Z_NO_FLUSH);
    len = cap - zs.avail_out;
    if (rc == Z_STREAM_END) break;
    if (rc == Z_OK || rc == Z_BUF_ERROR) {
      if (rc == Z_BUF_ERROR && zs.avail_in == 0 && zs.avail_out > 0) {
        /* Truncated input: Node throws "unexpected end of file". */
        inflateEnd(&zs);
        free(buf);
        static const char msg[] = "unexpected end of file";
        scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
        return NULL;
      }
      if (cap - len < 64) {
        cap *= 2;
        uint8_t *grown = realloc(buf, cap);
        if (!grown) scr_zlib_oom();
        buf = grown;
      }
      continue;
    }
    /* Corrupt data: zlib's msg is exactly Node's error message text. */
    const char *msg = zs.msg ? zs.msg : "zlib error";
    size_t mlen = strlen(msg);
    inflateEnd(&zs);
    free(buf);
    scr_throw_error_msg(SCR_ERR_ERROR, msg, mlen);
    return NULL;
  }
  inflateEnd(&zs);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
  memcpy(out->data, buf, len);
  free(buf);
  return out;
}

/* ── format-mode variants (static raw/gzip/unzip calls use these directly;
 * scr_zlib_island.c also bridges them into the embedded engine's node:zlib
 * shim) ───────────────────────────────────────────────────────────────
 * mode: 0 zlib (windowBits 15), 1 raw (-15), 2 gzip (15+16); inflate
 * additionally takes 3 = auto-detect zlib/gzip (15+32, Node's unzip). */

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
  memcpy(out->data, buf, len);
  free(buf);
  return out;
}

ScrBytes *scr_zlib_inflate_mode(const ScrBytes *data, double mode) {
  SCR_BYTES_SNAPSHOT(data);
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, scr_zlib_window_bits((int)mode, true)) != Z_OK) scr_zlib_oom();
  size_t cap = data->len > 64 ? data->len * 4 : 256;
  uint8_t *buf = malloc(cap);
  if (!buf) scr_zlib_oom();
  zs.next_in = data->data;
  zs.avail_in = (uInt)data->len;
  size_t len = 0;
  for (;;) {
    zs.next_out = buf + len;
    zs.avail_out = (uInt)(cap - len);
    int rc = inflate(&zs, Z_NO_FLUSH);
    len = cap - zs.avail_out;
    if (rc == Z_STREAM_END) break;
    if (rc == Z_OK || rc == Z_BUF_ERROR) {
      if (rc == Z_BUF_ERROR && zs.avail_in == 0 && zs.avail_out > 0) {
        inflateEnd(&zs);
        free(buf);
        static const char msg[] = "unexpected end of file";
        scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "Z_BUF_ERROR");
        return NULL;
      }
      if (cap - len < 64) {
        cap *= 2;
        uint8_t *grown = realloc(buf, cap);
        if (!grown) scr_zlib_oom();
        buf = grown;
      }
      continue;
    }
    const char *msg = zs.msg ? zs.msg : "zlib error";
    size_t mlen = strlen(msg);
    /* Node stamps the zlib return code's name (err.code) */
    const char *code = rc == Z_DATA_ERROR ? "Z_DATA_ERROR"
                       : rc == Z_NEED_DICT ? "Z_NEED_DICT"
                       : rc == Z_MEM_ERROR ? "Z_MEM_ERROR"
                                           : "Z_STREAM_ERROR";
    inflateEnd(&zs);
    free(buf);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, mlen, code);
    return NULL;
  }
  inflateEnd(&zs);
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)len);
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
 * pool with fs.rename. Only copied raw bytes and malloc-owned result state
 * cross threads; runtime RC, exceptions, Buffer/Error construction, and
 * callback execution stay on the main thread. */
#ifndef SCR_LIB
typedef struct {
  unsigned char *data;
  size_t len;
  int mode;
  bool compressing;
  unsigned char *result;
  size_t result_len;
  int error;
  char message[128];
  ScrClosure *cb;
  ScrZlibBytesFn fn;
} ScrZlibAsyncOp;

static const char *scr_zlib_error_code(int error) {
  switch (error) {
  case Z_BUF_ERROR: return "Z_BUF_ERROR";
  case Z_DATA_ERROR: return "Z_DATA_ERROR";
  case Z_NEED_DICT: return "Z_NEED_DICT";
  case Z_MEM_ERROR: return "Z_MEM_ERROR";
  default: return "Z_STREAM_ERROR";
  }
}

static void scr_zlib_async_deflate(ScrZlibAsyncOp *op) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (deflateInit2(&zs, Z_DEFAULT_COMPRESSION, Z_DEFLATED,
                   scr_zlib_window_bits(op->mode, false), 8,
                   Z_DEFAULT_STRATEGY) != Z_OK) {
    scr_zlib_oom();
  }
  uLong cap = deflateBound(&zs, (uLong)op->len);
  op->result = malloc(cap ? cap : 1);
  if (!op->result) scr_zlib_oom();
  zs.next_in = op->data;
  zs.avail_in = (uInt)op->len;
  zs.next_out = op->result;
  zs.avail_out = (uInt)cap;
  int rc = deflate(&zs, Z_FINISH);
  if (rc != Z_STREAM_END) scr_zlib_oom();
  op->result_len = cap - zs.avail_out;
  deflateEnd(&zs);
}

static void scr_zlib_async_inflate(ScrZlibAsyncOp *op) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, scr_zlib_window_bits(op->mode, true)) != Z_OK) {
    scr_zlib_oom();
  }
  size_t cap = op->len > 64 ? op->len * 4 : 256;
  op->result = malloc(cap);
  if (!op->result) scr_zlib_oom();
  zs.next_in = op->data;
  zs.avail_in = (uInt)op->len;
  size_t len = 0;
  for (;;) {
    zs.next_out = op->result + len;
    zs.avail_out = (uInt)(cap - len);
    int rc = inflate(&zs, Z_NO_FLUSH);
    len = cap - zs.avail_out;
    if (rc == Z_STREAM_END) {
      op->result_len = len;
      break;
    }
    if (rc == Z_OK || rc == Z_BUF_ERROR) {
      if (rc == Z_BUF_ERROR && zs.avail_in == 0 && zs.avail_out > 0) {
        op->error = Z_BUF_ERROR;
        memcpy(op->message, "unexpected end of file", sizeof "unexpected end of file");
        break;
      }
      if (cap - len < 64) {
        cap *= 2;
        unsigned char *grown = realloc(op->result, cap);
        if (!grown) scr_zlib_oom();
        op->result = grown;
      }
      continue;
    }
    op->error = rc;
    snprintf(op->message, sizeof op->message, "%s", zs.msg ? zs.msg : "zlib error");
    break;
  }
  inflateEnd(&zs);
}

static void scr_zlib_async_work(void *payload) {
  ScrZlibAsyncOp *op = payload;
  if (op->compressing) scr_zlib_async_deflate(op);
  else scr_zlib_async_inflate(op);
}

static void scr_zlib_async_after(void *payload) {
  ScrZlibAsyncOp *op = payload;
  if (op->error == Z_OK) {
    ScrBytes *value = scr_bytes_new(SCR_BYTES_U8, (double)op->result_len);
    memcpy(value->data, op->result, op->result_len);
    op->fn(op->cb, NULL, value);
    return;
  }
  scr_throw_error_msg_code(SCR_ERR_ERROR, op->message, strlen(op->message),
                           scr_zlib_error_code(op->error));
  ScrCaught *caught = scr_exc_take();
  ScrError *error = caught && caught->kind == SCR_EXC_OBJ && scr_error_is(caught->payload)
      ? (ScrError *)caught->payload
      : NULL;
  op->fn(op->cb, error, NULL);
  scr_caught_release(caught);
}

static void scr_zlib_async_destroy(void *payload) {
  ScrZlibAsyncOp *op = payload;
  free(op->data);
  free(op->result);
  scr_closure_release(op->cb);
  free(op);
}

void scr_zlib_codec_async(const ScrBytes *data, double mode, bool compressing,
                          ScrClosure *cb, ScrZlibBytesFn fn) {
  SCR_BYTES_SNAPSHOT(data);
  ScrZlibAsyncOp *op = calloc(1, sizeof *op);
  if (!op) scr_zlib_oom();
  op->data = malloc(data->len ? data->len : 1);
  if (!op->data) scr_zlib_oom();
  memcpy(op->data, data->data, data->len);
  op->len = data->len;
  op->mode = (int)mode;
  op->compressing = compressing;
  op->cb = cb;
  op->fn = fn;
  scr_work_submit(op, &scr_zlib_async_work, &scr_zlib_async_after,
                  &scr_zlib_async_destroy);
}
#endif

/* One-shot raw-DEFLATE inflate into a caller-sized buffer: the island's
 * compressed embedded module text (the emitter stores big npm sources
 * deflated and their exact inflated length in the table row — the emitted
 * main installs this through scr_island_set_inflate). True only when the
 * stream ends exactly at dst_len; any mismatch is a build/runtime bug the
 * caller surfaces, never a silent truncation. */
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
