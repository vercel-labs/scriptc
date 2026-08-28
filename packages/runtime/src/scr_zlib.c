/* node:zlib, the lowered slice: deflateSync/inflateSync over u8 bytes with
 * Node's DEFAULT options (zlib format, Z_DEFAULT_COMPRESSION, windowBits
 * 15). Compiled ONLY when the program uses zlib (native-toolchain.ts gates it exactly
 * like scr_regex.c/libregexp), so zlib-free binaries keep their
 * historical link line. Host builds link the system -lz; cross targets
 * link the vendored zlib built per target (ensureZlibObjects in native-toolchain.ts).
 *
 * Compressed OUTPUT bytes are zlib-version-dependent — the differential
 * corpus tests round-trips and fixed-blob inflation, never raw deflate
 * output. deflate of valid input cannot fail (OOM aborts); inflate of
 * corrupt input THROWS Node's catchable Error (zlib's own msg text:
 * "incorrect header check", ...). */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static void scr_zlib_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

ScrBytes *scr_zlib_deflate(const ScrBytes *data) {
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

/* ── the island's mode variants (scr_zlib_island.c bridges these into
 * the embedded engine's node:zlib shim) ───────────────────────────────
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
