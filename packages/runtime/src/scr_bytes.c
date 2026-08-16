/* Typed arrays / Buffer: ONE runtime representation (ScrBytes — see the
 * header contract). An ScrBytes either OWNS its storage or is a VIEW into
 * an owner's (backing set, chain depth exactly 1): DataView, subarray(),
 * and Buffer's slice() all alias JS-exactly; only the plain typed arrays'
 * slice() copies. Coercions are JS-exact
 * (ToUint8/ToUint32 modular truncation, double→float rounding); the
 * encoding conversions (utf8 with WHATWG replacement, hex, base64) match
 * Node byte-for-byte — the differential corpus holds them to it. */
#include "scr_runtime.h"
#ifdef SCR_TEXT_DECODER_LEGACY
#include "scr_text_decoder_data.h"
#endif

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_bytes = 0;
long scr_bytes_live_count(void) { return scr_live_bytes; }
#endif

static void scr_bytes_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

size_t scr_bytes_elem_size(ScrBytesElem elem) {
  return elem == SCR_BYTES_U8 ? 1 : 4;
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

static ScrBytes *scr_bytes_alloc(ScrBytesElem elem, size_t len) {
  ScrBytes *b = malloc(sizeof(ScrBytes));
  if (!b) scr_bytes_oom();
  b->rc = 1;
  b->len = len;
  b->elem = elem;
  b->data = calloc(len ? len : 1, scr_bytes_elem_size(elem));
  if (!b->data) scr_bytes_oom();
  b->backing = NULL;
#ifdef SCR_RC_AUDIT
  scr_live_bytes++;
#endif
  return b;
}

ScrBytes *scr_bytes_new(ScrBytesElem elem, double n) {
  /* ToIndex: NaN → 0, truncate toward zero; a negative or > 2^53-1 result
   * throws Node's RangeError ("Invalid typed array length: -1"). A
   * fractional 3.5 is length 3 — ToIndex never compares back. */
  double t = (n != n) ? 0 : trunc(n);
  if (!(t >= 0) || t > 9007199254740991.0 || t > (double)(SIZE_MAX / 8)) {
    char num[32];
    size_t numlen = scr_f64_to_str(t, num);
    char msg[80];
    int mlen = snprintf(msg, sizeof msg, "Invalid typed array length: %.*s",
                        (int)numlen, num);
    scr_throw_error_msg(SCR_ERR_RANGE, msg, (size_t)mlen);
    return NULL;
  }
  return scr_bytes_alloc(elem, (size_t)t);
}

ScrBytes *scr_bytes_from_data(const uint8_t *data, size_t len) {
  if (data == NULL && len != 0) {
    scr_trap("scriptc: native callback passed a NULL span with nonzero length\n");
  }
  ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, len);
  if (len != 0) memcpy(b->data, data, len);
  return b;
}

ScrBytes *scr_bytes_copy(const ScrBytes *src) {
  ScrBytes *b = scr_bytes_alloc(src->elem, src->len);
  memcpy(b->data, src->data, src->len * scr_bytes_elem_size(src->elem));
  return b;
}

void scr_bytes_release(ScrBytes *b) {
  if (!b || b->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--b->rc == 0) {
    if (b->backing) {
      scr_bytes_release(b->backing); /* a view: data points into the owner */
    } else {
      free(b->data);
    }
#ifdef SCR_RC_AUDIT
    scr_live_bytes--;
#endif
    free(b);
  }
}

void *scr_bytes_retain_v(void *b) { return scr_bytes_retain((ScrBytes *)b); }
void scr_bytes_release_v(void *b) { scr_bytes_release((ScrBytes *)b); }

double scr_bytes_len(const ScrBytes *b) { return (double)b->len; }

void scr_bytes_copy_contents(ScrBytes *dst, const ScrBytes *src) {
  if (dst->elem != src->elem || dst->len != src->len) {
    scr_trap("scriptc: typed array snapshot shape changed\n");
  }
  memcpy(dst->data, src->data, dst->len * scr_bytes_elem_size(dst->elem));
}

double scr_bytes_byte_len(const ScrBytes *b) {
  return (double)(b->len * scr_bytes_elem_size(b->elem));
}

/* ── element access ────────────────────────────────────────────────────
 * JS reads undefined and IGNORES writes out of bounds on typed arrays;
 * both are unrepresentable here, so any invalid index traps — the array
 * runtime's exact discipline (SEMANTICS.md). */

static size_t scr_bytes_check_index(const ScrBytes *b, double i) {
  if (!(i >= 0) || i != trunc(i) || i >= (double)b->len) {
    char buf[32];
    scr_f64_to_str(i, buf);
    scr_trap_fmt("scriptc: RangeError: typed array index %s out of bounds (length %zu)\n",
                 buf, b->len);
  }
  return (size_t)i;
}

/* ToUint32: NaN/±Infinity → 0, truncate toward zero, wrap mod 2^32.
 * ToUint8 is its low byte (2^8 divides 2^32, so the residues agree). */
static uint32_t scr_bytes_to_u32(double v) {
  if (v != v || isinf(v)) return 0;
  double t = trunc(v);
  t = fmod(t, 4294967296.0);
  if (t < 0) t += 4294967296.0;
  return (uint32_t)t;
}

double scr_bytes_get(const ScrBytes *b, double i) {
  size_t idx = scr_bytes_check_index(b, i);
  switch (b->elem) {
    case SCR_BYTES_U8:
      return (double)b->data[idx];
    case SCR_BYTES_U32: {
      uint32_t v;
      memcpy(&v, b->data + idx * 4, 4);
      return (double)v;
    }
    case SCR_BYTES_F32: {
      float v;
      memcpy(&v, b->data + idx * 4, 4);
      return (double)v;
    }
    case SCR_BYTES_I32: {
      int32_t v;
      memcpy(&v, b->data + idx * 4, 4);
      return (double)v;
    }
  }
  return 0; /* unreachable */
}

void scr_bytes_set(ScrBytes *b, double i, double v) {
  size_t idx = scr_bytes_check_index(b, i);
  switch (b->elem) {
    case SCR_BYTES_U8:
      b->data[idx] = (uint8_t)scr_bytes_to_u32(v);
      break;
    case SCR_BYTES_U32: {
      uint32_t u = scr_bytes_to_u32(v);
      memcpy(b->data + idx * 4, &u, 4);
      break;
    }
    case SCR_BYTES_F32: {
      float f = (float)v; /* round-to-nearest-even, exactly Float32Array */
      memcpy(b->data + idx * 4, &f, 4);
      break;
    }
    case SCR_BYTES_I32: {
      /* ToInt32 is ToUint32 reinterpreted signed (same 2^32 residue). */
      uint32_t u = scr_bytes_to_u32(v);
      int32_t s;
      memcpy(&s, &u, 4);
      memcpy(b->data + idx * 4, &s, 4);
      break;
    }
  }
}

/* ── slice (copy) / subarray (view) ────────────────────────────────────── */

/* Relative index: ToIntegerOrInfinity, negatives from the end, clamped. */
static size_t scr_bytes_rel_index(double i, size_t len) {
  if (i != i) return 0;
  double t = trunc(i);
  if (t < 0) t += (double)len;
  if (t < 0) return 0;
  if (t > (double)len) return len;
  return (size_t)t;
}

ScrBytes *scr_bytes_slice(const ScrBytes *b, double start, double end) {
  size_t s = scr_bytes_rel_index(start, b->len);
  size_t e = scr_bytes_rel_index(end, b->len);
  size_t count = e > s ? e - s : 0;
  size_t esize = scr_bytes_elem_size(b->elem);
  ScrBytes *out = scr_bytes_alloc(b->elem, count);
  memcpy(out->data, b->data + s * esize, count * esize);
  return out;
}

/* TypedArray.prototype.fill on non-u8 receivers: per-ELEMENT fill with
 * the element write's JS-exact coercion (ToUint32/ToInt32 wrap, f32
 * rounding), slice-clamped relative indices; answers the receiver +1
 * (chaining). Never throws — Buffer's throwing fill family is separate. */
ScrBytes *scr_bytes_fill_elem(ScrBytes *b, double v, double start, double end) {
  size_t s = scr_bytes_rel_index(start, b->len);
  size_t e = scr_bytes_rel_index(end, b->len);
  for (size_t i = s; i < e; i++) scr_bytes_set(b, (double)i, v);
  return scr_bytes_retain(b);
}

/* subarray(start, end): a same-elem VIEW over the receiver's storage —
 * TypedArray.prototype.subarray and Buffer's slice()/subarray() all alias
 * in JS (mutations are visible both ways; buffer-swap through a slice is
 * the canonical Node use). Chain depth stays exactly 1: a subarray of a
 * view retains the OWNER, offsets composed here (the DataView rule).
 * Relative indices clamp like slice; never throws. */
ScrBytes *scr_bytes_subarray(ScrBytes *b, double start, double end) {
  size_t s = scr_bytes_rel_index(start, b->len);
  size_t e = scr_bytes_rel_index(end, b->len);
  size_t count = e > s ? e - s : 0;
  ScrBytes *owner = b->backing ? b->backing : b;
  ScrBytes *v = malloc(sizeof(ScrBytes));
  if (!v) scr_bytes_oom();
  v->rc = 1;
  v->len = count;
  v->elem = b->elem;
  v->data = b->data + s * scr_bytes_elem_size(b->elem);
  v->backing = scr_bytes_retain(owner);
#ifdef SCR_RC_AUDIT
  scr_live_bytes++;
#endif
  return v;
}

void scr_bytes_set_from(ScrBytes *dst, const ScrBytes *src, double offset) {
  double t = (offset != offset) ? 0 : trunc(offset);
  if (!(t >= 0) || (double)src->len + t > (double)dst->len) {
    static const char msg[] = "offset is out of bounds";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return;
  }
  size_t esize = scr_bytes_elem_size(dst->elem);
  memmove(dst->data + (size_t)t * esize, src->data, src->len * esize);
}

/* ── DataView (the ONE view kind — see the header contract) ────────────── */

double scr_bytes_byte_offset(const ScrBytes *b) {
  return b->backing ? (double)(size_t)(b->data - b->backing->data) : 0;
}

ScrBytes *scr_dataview_new(ScrBytes *src, double byte_off, bool has_len, double byte_len) {
  /* `x.buffer` names the ONE buffer behind x — for a view src that is its
   * owner's storage, so indices stay buffer-relative exactly like JS. */
  ScrBytes *owner = src->backing ? src->backing : src;
  double buf_bytes = (double)(owner->len * scr_bytes_elem_size(owner->elem));
  /* ToIndex on the offset; every bad value takes Node's ONE message
   * (negative, > 2^53-1, Infinity, and past-the-end alike). */
  double off = (byte_off != byte_off) ? 0 : trunc(byte_off);
  if (!(off >= 0) || off > 9007199254740991.0 || off > buf_bytes) {
    char num[32];
    size_t numlen = scr_f64_to_str(off, num);
    char msg[96];
    int mlen = snprintf(msg, sizeof msg, "Start offset %.*s is outside the bounds of the buffer",
                        (int)numlen, num);
    scr_throw_error_msg(SCR_ERR_RANGE, msg, (size_t)mlen);
    return NULL;
  }
  double len;
  if (has_len) {
    len = (byte_len != byte_len) ? 0 : trunc(byte_len);
    if (!(len >= 0) || len > 9007199254740991.0 || off + len > buf_bytes) {
      char num[32];
      size_t numlen = scr_f64_to_str(len, num);
      char msg[64];
      int mlen = snprintf(msg, sizeof msg, "Invalid DataView length %.*s", (int)numlen, num);
      scr_throw_error_msg(SCR_ERR_RANGE, msg, (size_t)mlen);
      return NULL;
    }
  } else {
    len = buf_bytes - off;
  }
  ScrBytes *v = malloc(sizeof(ScrBytes));
  if (!v) scr_bytes_oom();
  v->rc = 1;
  v->len = (size_t)len; /* elem u8 — len IS the byte length */
  v->elem = SCR_BYTES_U8;
  v->data = owner->data + (size_t)off;
  v->backing = scr_bytes_retain(owner);
#ifdef SCR_RC_AUDIT
  scr_live_bytes++;
#endif
  return v;
}

static size_t scr_dataview_get_size(ScrDataViewGet kind) {
  switch (kind) {
    case SCR_DV_U8:
    case SCR_DV_I8:
      return 1;
    case SCR_DV_U16:
    case SCR_DV_I16:
      return 2;
    case SCR_DV_U32:
    case SCR_DV_I32:
    case SCR_DV_F32:
      return 4;
    default:
      return 8;
  }
}

double scr_dataview_get(const ScrBytes *b, double byte_off, ScrDataViewGet kind, bool le) {
  size_t width = scr_dataview_get_size(kind);
  /* ToIndex, then the view-relative bounds check — Node's ONE constant
   * message for every failure mode (negative, NaN is fine, too large). */
  double off = (byte_off != byte_off) ? 0 : trunc(byte_off);
  if (!(off >= 0) || off > 9007199254740991.0 || off + (double)width > (double)b->len) {
    static const char msg[] = "Offset is outside the bounds of the DataView";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return 0;
  }
  const uint8_t *p = b->data + (size_t)off;
  /* Assemble host-independently; le false is the JS big-endian default. */
  uint64_t u = 0;
  for (size_t i = 0; i < width; i++) {
    u |= (uint64_t)p[le ? i : width - 1 - i] << (8 * i);
  }
  switch (kind) {
    case SCR_DV_U8:
    case SCR_DV_U16:
    case SCR_DV_U32:
      return (double)u;
    case SCR_DV_I8:
      return (double)(int8_t)u;
    case SCR_DV_I16:
      return (double)(int16_t)u;
    case SCR_DV_I32:
      return (double)(int32_t)u;
    case SCR_DV_F32: {
      uint32_t bits = (uint32_t)u;
      float f;
      memcpy(&f, &bits, 4);
      return (double)f;
    }
    case SCR_DV_F64: {
      double d;
      memcpy(&d, &u, 8);
      return d;
    }
    case SCR_DV_BIGU64:
      /* Number(view.getBigUint64(...)): u64 → double rounds to nearest
       * even — the same conversion Number(bigint) performs. */
      return (double)u;
    case SCR_DV_BIGI64:
      return (double)(int64_t)u;
  }
  return 0; /* unreachable */
}

void scr_dataview_set(ScrBytes *b, double byte_off, double value, ScrDataViewGet kind, bool le) {
  size_t width = scr_dataview_get_size(kind);
  /* ToIndex + the view-relative bounds check — the getters' ONE message. */
  double off = (byte_off != byte_off) ? 0 : trunc(byte_off);
  if (!(off >= 0) || off > 9007199254740991.0 || off + (double)width > (double)b->len) {
    static const char msg[] = "Offset is outside the bounds of the DataView";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return;
  }
  /* Coerce to the stored bit pattern. The integer kinds share ToUint32's
   * 2^32 residue (signed/unsigned store the same bits; narrower widths
   * take the low bytes — 2^width divides 2^32, so the residues agree);
   * F32 rounds double→float to nearest even, exactly the spec. */
  uint64_t u = 0;
  switch (kind) {
    case SCR_DV_U8:
    case SCR_DV_I8:
    case SCR_DV_U16:
    case SCR_DV_I16:
    case SCR_DV_U32:
    case SCR_DV_I32:
      u = (uint64_t)scr_bytes_to_u32(value);
      break;
    case SCR_DV_F32: {
      float f = (float)value;
      uint32_t bits;
      memcpy(&bits, &f, 4);
      u = bits;
      break;
    }
    case SCR_DV_F64:
      memcpy(&u, &value, 8);
      break;
    default:
      return; /* BIG kinds never lower (bigint arguments) */
  }
  /* Scatter host-independently; le false is the JS big-endian default. */
  uint8_t *p = b->data + (size_t)off;
  for (size_t i = 0; i < width; i++) {
    p[le ? i : width - 1 - i] = (uint8_t)(u >> (8 * i));
  }
}

/* ── encodings (u8 only — the compiler routes only u8 receivers here) ──── */

static const char scr_hex_digits[] = "0123456789abcdef";

/* WHATWG UTF-8 decode with U+FFFD replacement per maximal invalid subpart
 * — what Buffer.prototype.toString("utf8") does. Output re-encodes as
 * (now valid) UTF-8: worst case 3 bytes per input byte. */
static ScrStr *scr_bytes_decode_utf8(const uint8_t *in, size_t n) {
  if (in == NULL && n != 0) {
    scr_trap("scriptc: native callback passed a NULL span with nonzero length\n");
  }
  if (n > (SIZE_MAX - 1) / 3) scr_bytes_oom();
  char *out = malloc(n * 3 + 1);
  if (!out) scr_bytes_oom();
  size_t o = 0;
  uint32_t cp = 0;
  int needed = 0;
  uint8_t lower = 0x80, upper = 0xbf;
  for (size_t i = 0; i <= n; i++) {
    if (i == n) {
      if (needed > 0) { /* EOF inside a sequence: one replacement */
        memcpy(out + o, "\xef\xbf\xbd", 3);
        o += 3;
      }
      break;
    }
    uint8_t byte = in[i];
    if (needed == 0) {
      if (byte <= 0x7f) {
        out[o++] = (char)byte;
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1; cp = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte == 0xe0) lower = 0xa0;
        if (byte == 0xed) upper = 0x9f;
        needed = 2; cp = byte & 0xf;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte == 0xf0) lower = 0x90;
        if (byte == 0xf4) upper = 0x8f;
        needed = 3; cp = byte & 0x7;
      } else {
        memcpy(out + o, "\xef\xbf\xbd", 3);
        o += 3;
      }
      continue;
    }
    if (byte < lower || byte > upper) {
      /* Invalid continuation: replace the subpart, REPROCESS this byte. */
      memcpy(out + o, "\xef\xbf\xbd", 3);
      o += 3;
      needed = 0; lower = 0x80; upper = 0xbf;
      i--;
      continue;
    }
    lower = 0x80; upper = 0xbf;
    cp = (cp << 6) | (byte & 0x3f);
    if (--needed == 0) {
      /* Re-encode the (valid, non-surrogate, <= 10FFFF) code point. */
      if (cp <= 0x7f) {
        out[o++] = (char)cp;
      } else if (cp <= 0x7ff) {
        out[o++] = (char)(0xc0 | (cp >> 6));
        out[o++] = (char)(0x80 | (cp & 0x3f));
      } else if (cp <= 0xffff) {
        out[o++] = (char)(0xe0 | (cp >> 12));
        out[o++] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[o++] = (char)(0x80 | (cp & 0x3f));
      } else {
        out[o++] = (char)(0xf0 | (cp >> 18));
        out[o++] = (char)(0x80 | ((cp >> 12) & 0x3f));
        out[o++] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[o++] = (char)(0x80 | (cp & 0x3f));
      }
    }
  }
  ScrStr *s = scr_str_new(out, o);
  free(out);
  return s;
}

ScrStr *scr_str_from_utf8_lossy(const uint8_t *bytes, size_t len) {
  return scr_bytes_decode_utf8(bytes, len);
}

/* WHATWG TextDecoder.decode (utf-8, default options): the SAME maximal-
 * subpart replacement decode as toString("utf8") above, with one
 * difference — a leading UTF-8 BOM is stripped (ignoreBOM defaults to
 * false in the spec; Buffer.toString keeps the BOM as U+FEFF). */
ScrStr *scr_text_decode(const ScrBytes *b) {
  const uint8_t *in = b->data;
  size_t n = b->len;
  if (n >= 3 && in[0] == 0xef && in[1] == 0xbb && in[2] == 0xbf) {
    in += 3;
    n -= 3;
  }
  return scr_bytes_decode_utf8(in, n);
}

/* ── node:string_decoder, the utf8 StringDecoder ─────────────────────────
 * The decoder VALUE is a one-field record holding the pending partial
 * sequence PACKED into an f64 (count in the low byte, then up to three
 * raw bytes — at most 3 pend, so 32 bits): the compiler's interned
 * %strdec helpers thread it through these three pure functions. The
 * algorithm is Node's utf8 StringDecoder pinned by oracle (corpus 1474):
 * write() decodes pending+chunk minus the trailing INCOMPLETE sequence
 * (the decode above — invalid bytes become U+FFFD immediately, only a
 * truncated valid lead buffers), end() flushes the buffered partial as
 * its replacement chars. */

/* Encoding helpers defined beside toString below (the strdec steps share
 * them). */
static ScrStr *scr_bytes_encode_b64(const uint8_t *in, size_t n, bool url);
static ScrStr *scr_bytes_decode_utf16le(const uint8_t *in, size_t n);
static bool scr_enc_is(const ScrStr *enc, const char *name);

static size_t scr_strdec_unpack(double pending, uint8_t out[3]) {
  uint32_t p = (uint32_t)pending;
  size_t n = p & 0xff;
  if (n > 3) n = 3;
  out[0] = (uint8_t)((p >> 8) & 0xff);
  out[1] = (uint8_t)((p >> 16) & 0xff);
  out[2] = (uint8_t)((p >> 24) & 0xff);
  return n;
}

static double scr_strdec_pack(const uint8_t *bytes, size_t n) {
  uint32_t p = (uint32_t)n;
  if (n > 0) p |= (uint32_t)bytes[0] << 8;
  if (n > 1) p |= (uint32_t)bytes[1] << 16;
  if (n > 2) p |= (uint32_t)bytes[2] << 24;
  return (double)p;
}

/* Node's utf8CheckIncomplete over the COMBINED tail: the length (0-3) of
 * a trailing truncated-but-valid sequence prefix. Bare continuations and
 * invalid leads are NOT incomplete — they decode (to U+FFFD) now. */
static size_t scr_strdec_tail(const uint8_t *buf, size_t n) {
  size_t scan = n < 3 ? n : 3;
  for (size_t back = 1; back <= scan; back++) {
    uint8_t b = buf[n - back];
    if ((b & 0xc0) == 0x80) continue; /* continuation: keep walking */
    size_t need = 0;
    if ((b & 0xe0) == 0xc0) need = 2;
    else if ((b & 0xf0) == 0xe0) need = 3;
    else if ((b & 0xf8) == 0xf0) need = 4;
    else return 0; /* ascii or invalid lead: nothing buffers */
    return back < need ? back : 0; /* complete: decode now */
  }
  return 0; /* 3 continuations (or empty): invalid, decode now */
}

/* The combined pending+chunk buffer (malloc'd; *out_n set). */
static uint8_t *scr_strdec_combined(double pending, const ScrBytes *chunk, size_t *out_n) {
  uint8_t pend[3];
  size_t np = scr_strdec_unpack(pending, pend);
  size_t n = np + chunk->len;
  uint8_t *buf = malloc(n > 0 ? n : 1);
  if (!buf) scr_bytes_oom();
  memcpy(buf, pend, np);
  memcpy(buf + np, chunk->data, chunk->len);
  *out_n = n;
  return buf;
}

/* The utf16le step, Node's utf16Text/fillLast: a pending partial fills
 * first (an odd byte completes its unit; a held LEAD surrogate completes
 * its pair — 4 bytes total), then the rest holds back an odd tail byte
 * (with NO surrogate check — Node's own quirk emits a lead surrogate
 * before an odd boundary) or a trailing lead surrogate's 2 bytes. The
 * emitted bytes decode JOINTLY, so pair halves split across the fill
 * boundary reassemble exactly like Node's string concatenation. */
static ScrStr *scr_strdec_u16(double pending, const ScrBytes *chunk, bool want_str, double *out_hold) {
  uint8_t held[3];
  size_t k = scr_strdec_unpack(pending, held);
  const uint8_t *c = chunk->data;
  size_t cn = chunk->len;
  uint8_t complete[4];
  size_t comp_n = 0;
  if (k > 0) {
    size_t total = k == 1 ? 2 : 4; /* 1 = odd byte; 2 or 3 = lead-surrogate hold */
    size_t need = total - k;
    if (cn < need) {
      uint8_t nh[3];
      memcpy(nh, held, k);
      memcpy(nh + k, c, cn);
      *out_hold = scr_strdec_pack(nh, k + cn);
      return want_str ? scr_str_new("", 0) : NULL;
    }
    memcpy(complete, held, k);
    memcpy(complete + k, c, need);
    comp_n = total;
    c += need;
    cn -= need;
  }
  size_t keep = cn;
  if (cn % 2 == 1) {
    keep = cn - 1;
  } else if (cn >= 2) {
    uint32_t last = (uint32_t)c[cn - 2] | ((uint32_t)c[cn - 1] << 8);
    if (last >= 0xd800 && last <= 0xdbff) keep = cn - 2;
  }
  *out_hold = scr_strdec_pack(c + keep, cn - keep);
  if (!want_str) return NULL;
  size_t n = comp_n + keep;
  uint8_t *buf = malloc(n > 0 ? n : 1);
  if (!buf) scr_bytes_oom();
  memcpy(buf, complete, comp_n);
  memcpy(buf + comp_n, c, keep);
  ScrStr *s = scr_bytes_decode_utf16le(buf, n);
  free(buf);
  return s;
}

/* The base64/base64url step: complete 3-byte groups encode now, the
 * 1-2-byte remainder buffers (the combined walk is Node's fillLast+text
 * exactly — base64 of a concatenation splits at group boundaries). */
static ScrStr *scr_strdec_b64(double pending, const ScrBytes *chunk, bool url, bool want_str, double *out_hold) {
  size_t n;
  uint8_t *buf = scr_strdec_combined(pending, chunk, &n);
  size_t tail = n % 3;
  *out_hold = scr_strdec_pack(buf + (n - tail), tail);
  ScrStr *s = want_str ? scr_bytes_encode_b64(buf, n - tail, url) : NULL;
  free(buf);
  return s;
}

/* One dispatcher computes the decoded string (when wanted) and the new
 * packed pending for a write. latin1/ascii/hex are stateless (write IS
 * toString); utf8 keeps the oracle-pinned combined walk. */
static ScrStr *scr_strdec_step(const ScrStr *enc, double pending, const ScrBytes *chunk,
                               bool want_str, double *out_hold) {
  if (scr_enc_is(enc, "utf16le")) return scr_strdec_u16(pending, chunk, want_str, out_hold);
  if (scr_enc_is(enc, "base64")) return scr_strdec_b64(pending, chunk, false, want_str, out_hold);
  if (scr_enc_is(enc, "base64url")) return scr_strdec_b64(pending, chunk, true, want_str, out_hold);
  if (scr_enc_is(enc, "latin1") || scr_enc_is(enc, "ascii") || scr_enc_is(enc, "hex")) {
    *out_hold = 0;
    return want_str ? scr_bytes_to_str(chunk, enc) : NULL;
  }
  size_t n;
  uint8_t *buf = scr_strdec_combined(pending, chunk, &n);
  size_t tail = scr_strdec_tail(buf, n);
  *out_hold = scr_strdec_pack(buf + (n - tail), tail);
  ScrStr *s = want_str ? scr_bytes_decode_utf8(buf, n - tail) : NULL;
  free(buf);
  return s;
}

/* decoder.write(chunk): the decoded complete prefix (+1). */
ScrStr *scr_strdec_write(const ScrStr *enc, double pending, const ScrBytes *chunk) {
  double hold;
  return scr_strdec_step(enc, pending, chunk, true, &hold);
}

/* The decoder state AFTER a write: the packed trailing partial sequence. */
double scr_strdec_next(const ScrStr *enc, double pending, const ScrBytes *chunk) {
  double hold = 0;
  scr_strdec_step(enc, pending, chunk, false, &hold);
  return hold;
}

/* decoder.end(): the buffered partial flushes — utf8's truncated sequence
 * becomes its replacement chars (the maximal-subpart rule), base64's
 * remainder encodes (padded; unpadded for base64url), utf16le's held
 * bytes decode as they stand (an odd byte drops; a held lead surrogate is
 * the documented U+FFFD divergence), and the stateless encodings flush
 * nothing. +1. */
ScrStr *scr_strdec_end(const ScrStr *enc, double pending) {
  uint8_t pend[3];
  size_t np = scr_strdec_unpack(pending, pend);
  if (scr_enc_is(enc, "base64")) return scr_bytes_encode_b64(pend, np, false);
  if (scr_enc_is(enc, "base64url")) return scr_bytes_encode_b64(pend, np, true);
  if (scr_enc_is(enc, "utf16le")) return scr_bytes_decode_utf16le(pend, np);
  if (scr_enc_is(enc, "latin1") || scr_enc_is(enc, "ascii") || scr_enc_is(enc, "hex")) {
    return scr_str_new("", 0);
  }
  return scr_bytes_decode_utf8(pend, np);
}

static void scr_bytes_to_str_bounds(const ScrBytes *b, double start, double end,
                                    size_t *s0_out, size_t *e0_out) {
  size_t len = b->len;
  size_t s0 = start <= 0 ? 0 : ((size_t)start > len ? len : (size_t)start);
  size_t e0 = end <= 0 ? 0 : ((size_t)end > len ? len : (size_t)end);
  if (e0 < s0) e0 = s0;
  *s0_out = s0;
  *e0_out = e0;
}

/* toString(enc, start, end): Node slices then decodes — start/end clamp
 * to [0, len] with start > end collapsing to empty and negative ends
 * clamping to 0 (Node's slice-then-decode; an OMITTED end never reaches
 * here — the emitter supplies the receiver's length for the 2-arg
 * form). Delegates to the whole-buffer decoder
 * through a stack view — no allocation, no rc traffic. */
ScrStr *scr_bytes_to_str_range(const ScrBytes *b, const ScrStr *enc, double start, double end) {
  size_t s0, e0;
  scr_bytes_to_str_bounds(b, start, end, &s0, &e0);
  ScrBytes view = { .rc = 1, .len = e0 - s0, .elem = b->elem, .data = b->data + s0, .backing = NULL };
  return scr_bytes_to_str(&view, enc);
}

/* The base64 encoder behind toString("base64") and toString("base64url"):
 * the url flavor swaps the alphabet's last two chars for -_ and drops the
 * padding, exactly Node. */
static ScrStr *scr_bytes_encode_b64(const uint8_t *in, size_t n, bool url) {
  static const char std_abc[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  static const char url_abc[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const char *abc = url ? url_abc : std_abc;
  size_t outlen = (n + 2) / 3 * 4;
  char *out = malloc(outlen + 1);
  if (!out) scr_bytes_oom();
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = (unsigned)in[i] << 16;
    if (i + 1 < n) v |= (unsigned)in[i + 1] << 8;
    if (i + 2 < n) v |= (unsigned)in[i + 2];
    out[o++] = abc[(v >> 18) & 63];
    out[o++] = abc[(v >> 12) & 63];
    if (i + 1 < n) out[o++] = abc[(v >> 6) & 63];
    else if (!url) out[o++] = '=';
    if (i + 2 < n) out[o++] = abc[v & 63];
    else if (!url) out[o++] = '=';
  }
  ScrStr *s = scr_str_new(out, o);
  free(out);
  return s;
}

/* Append one code point as UTF-8 (the caller sized the buffer). */
static size_t scr_bytes_put_cp(char *out, size_t o, uint32_t cp) {
  if (cp <= 0x7f) {
    out[o++] = (char)cp;
  } else if (cp <= 0x7ff) {
    out[o++] = (char)(0xc0 | (cp >> 6));
    out[o++] = (char)(0x80 | (cp & 0x3f));
  } else if (cp <= 0xffff) {
    out[o++] = (char)(0xe0 | (cp >> 12));
    out[o++] = (char)(0x80 | ((cp >> 6) & 0x3f));
    out[o++] = (char)(0x80 | (cp & 0x3f));
  } else {
    out[o++] = (char)(0xf0 | (cp >> 18));
    out[o++] = (char)(0x80 | ((cp >> 12) & 0x3f));
    out[o++] = (char)(0x80 | ((cp >> 6) & 0x3f));
    out[o++] = (char)(0x80 | (cp & 0x3f));
  }
  return o;
}

/* ── WHATWG/Node TextDecoder legacy encodings ──────────────────────────
 *
 * The frontend only calls this entry with a compile-time encoding id. The
 * lookup data is generated from the repository's pinned Node 24 oracle, so
 * the resulting binary has no ICU/iconv dependency and behaves identically
 * on Darwin, Linux, and Windows. UTF-8 keeps its older dedicated entry above:
 * programs using only the default decoder do not retain these legacy tables.
 */
#ifdef SCR_TEXT_DECODER_LEGACY

enum {
  SCR_TD_X_USER_DEFINED = SCR_TD_SINGLE_COUNT,
  SCR_TD_UTF16LE,
  SCR_TD_UTF16BE,
  SCR_TD_GB18030,
  SCR_TD_BIG5,
  SCR_TD_EUC_JP,
  SCR_TD_ISO_2022_JP,
  SCR_TD_SHIFT_JIS,
  SCR_TD_EUC_KR,
};

typedef struct {
  char *data;
  size_t len;
} ScrTdOut;

static ScrTdOut scr_td_out_new(size_t input_len) {
  if (input_len > (SIZE_MAX - 8) / 3) scr_bytes_oom();
  ScrTdOut out = { malloc(input_len * 3 + 8), 0 };
  if (!out.data) scr_bytes_oom();
  return out;
}

static void scr_td_put(ScrTdOut *out, uint32_t cp) {
  out->len = scr_bytes_put_cp(out->data, out->len, cp);
}

static void scr_td_error(ScrTdOut *out) {
  scr_td_put(out, 0xfffd);
}

static ScrStr *scr_td_finish(ScrTdOut *out) {
  ScrStr *str = scr_str_new(out->data, out->len);
  free(out->data);
  return str;
}

static ScrStr *scr_td_single_byte(const ScrBytes *b, unsigned encoding) {
  ScrTdOut out = scr_td_out_new(b->len);
  for (size_t i = 0; i < b->len; i++) {
    uint8_t byte = b->data[i];
    scr_td_put(&out, byte < 0x80 ? byte : scr_td_single[encoding][byte - 0x80]);
  }
  return scr_td_finish(&out);
}

static ScrStr *scr_td_x_user_defined(const ScrBytes *b) {
  ScrTdOut out = scr_td_out_new(b->len);
  for (size_t i = 0; i < b->len; i++) {
    uint8_t byte = b->data[i];
    scr_td_put(&out, byte < 0x80 ? byte : 0xf780 + byte - 0x80);
  }
  return scr_td_finish(&out);
}

static ScrStr *scr_td_utf16(const ScrBytes *b, bool be) {
  const uint8_t *in = b->data;
  size_t n = b->len;
  /* TextDecoder's BOM handling strips only the BOM matching the selected
   * endian decoder. The opposite BOM decodes to U+FFFE and remains. */
  if (n >= 2 && ((!be && in[0] == 0xff && in[1] == 0xfe) ||
                 (be && in[0] == 0xfe && in[1] == 0xff))) {
    in += 2;
    n -= 2;
  }
  ScrTdOut out = scr_td_out_new(n);
  size_t i = 0;
  while (i + 1 < n) {
    uint32_t cu = be ? ((uint32_t)in[i] << 8) | in[i + 1]
                     : (uint32_t)in[i] | ((uint32_t)in[i + 1] << 8);
    i += 2;
    if (cu >= 0xd800 && cu <= 0xdbff) {
      if (i + 1 < n) {
        uint32_t lo = be ? ((uint32_t)in[i] << 8) | in[i + 1]
                         : (uint32_t)in[i] | ((uint32_t)in[i + 1] << 8);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          i += 2;
          scr_td_put(&out, 0x10000 + ((cu - 0xd800) << 10) + (lo - 0xdc00));
          continue;
        }
      } else if (i < n) {
        /* ICU treats a lead surrogate plus one final byte as one malformed
         * UTF-16 subsequence. Consume that byte here so the odd-tail path
         * below does not emit a second replacement. */
        i++;
      }
      scr_td_error(&out);
      continue;
    }
    if (cu >= 0xdc00 && cu <= 0xdfff) scr_td_error(&out);
    else scr_td_put(&out, cu);
  }
  if (i < n) scr_td_error(&out); /* odd trailing byte */
  return scr_td_finish(&out);
}

static uint32_t scr_td_gb_range(uint32_t pointer) {
  size_t lo = 0;
  size_t hi = sizeof scr_td_gb_ranges / sizeof scr_td_gb_ranges[0];
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    const ScrTdGbRange *range = &scr_td_gb_ranges[mid];
    if (pointer < range->start) hi = mid;
    else if (pointer > range->end) lo = mid + 1;
    else return range->code_point + pointer - range->start;
  }
  return 0;
}

/* A tiny prepend stack models the Encoding Standard's I/O queue restore.
 * The gb18030 decoder is the only legacy decoder which can restore three
 * bytes after discovering a malformed four-byte sequence. */
static ScrStr *scr_td_gb18030_decode(const ScrBytes *b) {
  ScrTdOut out = scr_td_out_new(b->len);
  uint8_t first = 0, second = 0, third = 0;
  uint8_t replay[3];
  size_t replay_len = 0;
  size_t i = 0;
  while (i < b->len || replay_len > 0) {
    uint8_t byte = replay_len ? replay[--replay_len] : b->data[i++];
    if (third) {
      uint32_t cp = 0;
      bool valid_fourth = byte >= 0x30 && byte <= 0x39;
      if (valid_fourth) {
        uint32_t pointer = (((uint32_t)(first - 0x81) * 10 + second - 0x30) * 126 +
                            third - 0x81) * 10 + byte - 0x30;
        cp = scr_td_gb_range(pointer);
      }
      uint8_t old_second = second, old_third = third;
      first = second = third = 0;
      if (cp) {
        scr_td_put(&out, cp);
      } else {
        scr_td_error(&out);
        /* A structurally valid four-byte sequence with an unmapped pointer
         * is consumed as one error. Only a malformed fourth byte restores
         * the preceding payload bytes to Node's input queue. */
        if (!valid_fourth) {
          replay[replay_len++] = byte;
          replay[replay_len++] = old_third;
          replay[replay_len++] = old_second;
        }
      }
      continue;
    }
    if (second) {
      if (byte >= 0x81 && byte <= 0xfe) {
        third = byte;
      } else {
        uint8_t old_second = second;
        first = second = 0;
        scr_td_error(&out);
        replay[replay_len++] = byte;
        replay[replay_len++] = old_second;
      }
      continue;
    }
    if (first) {
      if (byte >= 0x30 && byte <= 0x39) {
        second = byte;
        continue;
      }
      uint8_t lead = first;
      first = 0;
      uint32_t cp = 0;
      bool valid_trail = (byte >= 0x40 && byte <= 0x7e) ||
                         (byte >= 0x80 && byte <= 0xfe);
      if (valid_trail) {
        unsigned offset = byte < 0x7f ? 0x40 : 0x41;
        cp = scr_td_gb18030[(lead - 0x81) * 190 + byte - offset];
      }
      if (cp) scr_td_put(&out, cp);
      else {
        scr_td_error(&out);
        /* Non-ASCII invalid trails are consumed; ASCII is restored. */
        if (!valid_trail && byte < 0x80) replay[replay_len++] = byte;
      }
      continue;
    }
    if (byte < 0x80) scr_td_put(&out, byte);
    else if (byte == 0x80) scr_td_put(&out, 0x20ac);
    else if (byte >= 0x81 && byte <= 0xfe) first = byte;
    else scr_td_error(&out);
  }
  if (first || second || third) scr_td_error(&out);
  return scr_td_finish(&out);
}

static ScrStr *scr_td_big5_decode(const ScrBytes *b) {
  ScrTdOut out = scr_td_out_new(b->len);
  uint8_t lead = 0;
  for (size_t i = 0; i < b->len; i++) {
    uint8_t byte = b->data[i];
    if (lead) {
      uint32_t cp = 0;
      if ((byte >= 0x40 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xfe)) {
        unsigned offset = byte < 0x7f ? 0x40 : 0x62;
        cp = scr_td_big5[(lead - 0x81) * 157 + byte - offset];
      }
      lead = 0;
      if (cp) scr_td_put(&out, cp);
      else {
        scr_td_error(&out);
        /* 0xff has a standalone ICU/Node mapping and is restored too. */
        if (byte < 0x80 || byte == 0xff) i--;
      }
      continue;
    }
    if (byte < 0x80 || byte == 0x80) scr_td_put(&out, byte);
    else if (byte >= 0x81 && byte <= 0xfe) lead = byte;
    else if (byte == 0xff) scr_td_put(&out, 0xf8f8); /* ICU/Node mapping */
    else scr_td_error(&out);
  }
  if (lead) scr_td_error(&out);
  return scr_td_finish(&out);
}

static ScrStr *scr_td_euc_jp_decode(const ScrBytes *b) {
  ScrTdOut out = scr_td_out_new(b->len);
  uint8_t lead = 0;
  bool jis0212 = false;
  for (size_t i = 0; i < b->len; i++) {
    uint8_t byte = b->data[i];
    if (lead == 0x8e && byte >= 0xa1 && byte <= 0xdf) {
      lead = 0;
      scr_td_put(&out, 0xff61 + byte - 0xa1);
      continue;
    }
    /* Node's pinned ICU EUC-JP converter exposes three NEC extensions just
     * above the half-width katakana trail range. */
    if (lead == 0x8e && byte >= 0xe0 && byte <= 0xe2) {
      static const uint16_t extensions[] = { 0x00a2, 0x00a3, 0x00ac };
      lead = 0;
      scr_td_put(&out, extensions[byte - 0xe0]);
      continue;
    }
    if (lead == 0x8f && byte >= 0xa1 && byte <= 0xfe) {
      jis0212 = true;
      lead = byte;
      continue;
    }
    if (lead) {
      uint8_t old_lead = lead;
      lead = 0;
      uint32_t cp = 0;
      bool valid_trail = old_lead >= 0xa1 && old_lead <= 0xfe &&
                         byte >= 0xa1 && byte <= 0xfe;
      if (valid_trail) {
        unsigned pointer = (old_lead - 0xa1) * 94 + byte - 0xa1;
        cp = jis0212 ? scr_td_jis0212[pointer] : scr_td_jis0208[pointer];
      }
      /* When the third byte of an 0x8f JIS-0212 sequence is malformed,
       * ICU reports the prefix and restores both following bytes. Model the
       * saved second byte as the next ordinary EUC-JP lead. */
      if (jis0212 && !valid_trail) {
        jis0212 = false;
        lead = old_lead;
        scr_td_error(&out);
        i--;
        continue;
      }
      jis0212 = false;
      if (cp) scr_td_put(&out, cp);
      else {
        scr_td_error(&out);
        /* C0/C1 bytes are restored; 0xa0 and 0xff are consumed with the
         * malformed sequence rather than producing a second error. The
         * 0x8e extension converter additionally restores 0xe5..0xfe. */
        if (byte < 0xa0 || (old_lead == 0x8e && byte >= 0xe5 && byte <= 0xfe)) i--;
      }
      continue;
    }
    if (byte < 0xa0 && byte != 0x8e && byte != 0x8f) scr_td_put(&out, byte);
    else if (byte == 0x8e || byte == 0x8f || (byte >= 0xa1 && byte <= 0xfe)) lead = byte;
    else scr_td_error(&out);
  }
  if (lead) scr_td_error(&out);
  return scr_td_finish(&out);
}

static ScrStr *scr_td_shift_jis_decode(const ScrBytes *b) {
  ScrTdOut out = scr_td_out_new(b->len);
  uint8_t lead = 0;
  for (size_t i = 0; i < b->len; i++) {
    uint8_t byte = b->data[i];
    if (lead) {
      uint32_t cp = 0;
      bool valid_trail = (byte >= 0x40 && byte <= 0x7e) ||
                         (byte >= 0x80 && byte <= 0xfc);
      if (valid_trail) {
        unsigned offset = byte < 0x7f ? 0x40 : 0x41;
        unsigned lead_offset = lead < 0xa0 ? 0x81 : 0xc1;
        unsigned pointer = (lead - lead_offset) * 188 + byte - offset;
        cp = scr_td_shift_jis[pointer];
      }
      lead = 0;
      if (cp) scr_td_put(&out, cp);
      else {
        scr_td_error(&out);
        if (!valid_trail) i--;
      }
      continue;
    }
    /* ICU's ibm-943_P15A-2003 converter (Node's Shift_JIS backend) has
     * three historical C0/DEL swaps which its TextDecoder exposes. */
    if (byte == 0x1a) scr_td_put(&out, 0x1c);
    else if (byte == 0x1c) scr_td_put(&out, 0x7f);
    else if (byte == 0x7f) scr_td_put(&out, 0x1a);
    else if (byte < 0x80) scr_td_put(&out, byte);
    else if (byte >= 0xa1 && byte <= 0xdf) scr_td_put(&out, 0xff61 + byte - 0xa1);
    else if ((byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc)) lead = byte;
    else scr_td_error(&out);
  }
  if (lead) scr_td_error(&out);
  return scr_td_finish(&out);
}

static ScrStr *scr_td_euc_kr_decode(const ScrBytes *b) {
  ScrTdOut out = scr_td_out_new(b->len);
  uint8_t lead = 0;
  for (size_t i = 0; i < b->len; i++) {
    uint8_t byte = b->data[i];
    if (lead) {
      uint32_t cp = 0;
      if (lead >= 0xa1 && lead <= 0xfe && byte >= 0xa1 && byte <= 0xfe) {
        cp = scr_td_euc_kr[(lead - 0xa1) * 94 + byte - 0xa1];
      }
      lead = 0;
      if (cp) scr_td_put(&out, cp);
      else {
        scr_td_error(&out);
        if (byte < 0xa0) i--;
      }
      continue;
    }
    if (byte < 0xa0 && byte != 0x8e && byte != 0x8f) scr_td_put(&out, byte);
    else if (byte >= 0xa1 && byte <= 0xfe) lead = byte;
    else scr_td_error(&out);
  }
  if (lead) scr_td_error(&out);
  return scr_td_finish(&out);
}

enum ScrTdIsoState {
  SCR_TD_ISO_ASCII,
  SCR_TD_ISO_ROMAN,
  SCR_TD_ISO_KATAKANA,
  SCR_TD_ISO_LEAD,
  SCR_TD_ISO_TRAIL,
  SCR_TD_ISO_ESCAPE_START,
  SCR_TD_ISO_ESCAPE,
};

static ScrStr *scr_td_iso_2022_jp_decode(const ScrBytes *b) {
  ScrTdOut out = scr_td_out_new(b->len);
  enum ScrTdIsoState state = SCR_TD_ISO_ASCII;
  enum ScrTdIsoState output_state = SCR_TD_ISO_ASCII;
  uint8_t lead = 0;
  int replay = -1;
  bool output_flag = false;
  size_t i = 0;
  bool at_eof = false;
  while (!at_eof) {
    int item;
    if (replay >= 0) {
      item = replay;
      replay = -1;
    } else {
      item = i < b->len ? b->data[i++] : -1;
    }
    uint8_t byte = item < 0 ? 0 : (uint8_t)item;
    /* ICU treats CR/LF as line boundaries while a non-ASCII designation is
     * active: emit the separator and resume in ASCII. A pending JIS lead is
     * different (TRAIL state below) — there the line break completes an
     * ill-formed pair and remains a replacement, matching Node. */
    if (item >= 0 && (byte == 0x0a || byte == 0x0d) &&
        (state == SCR_TD_ISO_KATAKANA || state == SCR_TD_ISO_LEAD)) {
      output_flag = false;
      state = output_state = SCR_TD_ISO_ASCII;
      scr_td_put(&out, byte);
      continue;
    }
    switch (state) {
      case SCR_TD_ISO_ASCII:
      case SCR_TD_ISO_ROMAN:
      case SCR_TD_ISO_KATAKANA:
        if (item < 0) { at_eof = true; break; }
        if (byte == 0x1b) { state = SCR_TD_ISO_ESCAPE_START; break; }
        if (state == SCR_TD_ISO_ROMAN && byte == 0x5c) {
          output_flag = false; scr_td_put(&out, 0x00a5); break;
        }
        if (state == SCR_TD_ISO_ROMAN && byte == 0x7e) {
          output_flag = false; scr_td_put(&out, 0x203e); break;
        }
        if (state == SCR_TD_ISO_KATAKANA && byte >= 0x21 && byte <= 0x5f) {
          output_flag = false; scr_td_put(&out, 0xff61 + byte - 0x21); break;
        }
        if (state != SCR_TD_ISO_KATAKANA && byte < 0x80 && byte != 0x0e && byte != 0x0f) {
          output_flag = false; scr_td_put(&out, byte); break;
        }
        output_flag = false; scr_td_error(&out); break;

      case SCR_TD_ISO_LEAD:
        if (item < 0) { at_eof = true; break; }
        if (byte == 0x1b) { state = SCR_TD_ISO_ESCAPE_START; break; }
        if (byte >= 0x21 && byte <= 0x7e) {
          output_flag = false; lead = byte; state = SCR_TD_ISO_TRAIL; break;
        }
        /* ICU's fixed-width JIS converter folds two adjacent non-starter
         * bytes into one malformed subsequence. A valid lead, ESC, and the
         * SO/SI controls begin their own item and must remain queued; CR/LF
         * following an invalid byte is payload here rather than the line
         * reset handled above. */
        if (byte != 0x0e && byte != 0x0f && i < b->len) {
          uint8_t next = b->data[i];
          bool starts_item = next == 0x0e || next == 0x0f || next == 0x1b ||
                             (next >= 0x21 && next <= 0x7e);
          if (!starts_item) i++;
        }
        output_flag = false; scr_td_error(&out); break;

      case SCR_TD_ISO_TRAIL:
        if (item < 0) { state = SCR_TD_ISO_LEAD; scr_td_error(&out); at_eof = true; break; }
        if (byte == 0x1b) { state = SCR_TD_ISO_ESCAPE_START; scr_td_error(&out); break; }
        state = SCR_TD_ISO_LEAD;
        if (byte >= 0x21 && byte <= 0x7e) {
          uint32_t cp = scr_td_jis0208[(lead - 0x21) * 94 + byte - 0x21];
          if (cp) scr_td_put(&out, cp); else scr_td_error(&out);
        } else {
          scr_td_error(&out);
          /* SO/SI are standalone illegal items in ICU's JIS state rather
           * than trails consumed with the pending lead. Replay them so they
           * each contribute their own replacement. */
          if (byte == 0x0e || byte == 0x0f) i--;
        }
        break;

      case SCR_TD_ISO_ESCAPE_START:
        if (item >= 0 && (byte == 0x24 || byte == 0x25 || byte == 0x26 ||
                          byte == 0x28 || byte == 0x2e)) {
          lead = byte; state = SCR_TD_ISO_ESCAPE; break;
        }
        /* ICU recognizes ESC O as a complete but unsupported single-shift
         * escape, consuming the O with the replacement. */
        if (item >= 0 && byte == 0x4f) {
          output_flag = false; state = output_state; scr_td_error(&out); break;
        }
        if (item >= 0) i--;
        output_flag = false; state = output_state; scr_td_error(&out);
        if (item < 0) at_eof = true;
        break;

      case SCR_TD_ISO_ESCAPE: {
        enum ScrTdIsoState next = (enum ScrTdIsoState)-1;
        if (item >= 0 && lead == 0x28 && byte == 0x42) next = SCR_TD_ISO_ASCII;
        else if (item >= 0 && lead == 0x28 && (byte == 0x48 || byte == 0x4a)) next = SCR_TD_ISO_ROMAN;
        else if (item >= 0 && lead == 0x28 && byte == 0x49) next = SCR_TD_ISO_KATAKANA;
        else if (item >= 0 && lead == 0x24 && (byte == 0x40 || byte == 0x42)) next = SCR_TD_ISO_LEAD;
        if ((int)next >= 0) {
          state = output_state = next;
          bool repeated = output_flag;
          output_flag = !repeated;
          if (repeated) scr_td_error(&out);
          break;
        }
        /* Some ICU designation families need one more final byte. A known
         * final consumes the whole four-byte escape as one error; an unknown
         * final restores both payload bytes and leaves that final queued. */
        bool extended_prefix =
          (lead == 0x24 && (byte == 0x28 || byte == 0x29 || byte == 0x2a || byte == 0x2b)) ||
          (lead == 0x25 && byte == 0x2f);
        if (extended_prefix) {
          if (i == b->len) {
            output_flag = false; state = output_state; scr_td_error(&out);
            break;
          }
          uint8_t final = b->data[i];
          bool known_final =
            (lead == 0x24 && byte == 0x28 &&
              ((final >= 0x40 && final <= 0x45) || (final >= 0x47 && final <= 0x4d))) ||
            (lead == 0x24 && byte == 0x29 &&
              (final == 0x41 || final == 0x43 || final == 0x45 || final == 0x47)) ||
            (lead == 0x24 && byte == 0x2a && final == 0x48) ||
            (lead == 0x24 && byte == 0x2b && final >= 0x49 && final <= 0x4d) ||
            (lead == 0x25 && byte == 0x2f &&
              ((final >= 0x40 && final <= 0x41) || (final >= 0x43 && final <= 0x46)));
          if (known_final) {
            i++;
            output_flag = false; state = output_state; scr_td_error(&out);
            break;
          }
        }
        /* ICU consumes the complete unsupported designations it recognizes,
         * while other malformed payloads are restored to the input queue. */
        bool consume_error =
          (lead == 0x24 && byte == 0x41) ||
          (lead == 0x28 && ((byte >= 0x40 && byte <= 0x47) || byte == 0x4b || byte == 0x52)) ||
          (lead == 0x25 && byte == 0x42) ||
          (lead == 0x2e && (byte == 0x41 || byte == 0x46));
        if (item >= 0 && lead == 0x26 && byte == 0x40) {
          state = output_state = SCR_TD_ISO_LEAD;
          bool repeated = output_flag;
          output_flag = !repeated;
          if (repeated) scr_td_error(&out);
          break;
        }
        if (item < 0 || consume_error) {
          output_flag = false; state = output_state; scr_td_error(&out);
          if (item < 0) at_eof = true;
          break;
        }
        i--;
        /* The first escape payload byte is restored before the current
         * byte. Replay it through the full prior state machine: in JIS
         * mode it can become the lead paired with the current byte. */
        replay = lead;
        output_flag = false; state = output_state; scr_td_error(&out);
        break;
      }
    }
  }
  return scr_td_finish(&out);
}

ScrStr *scr_text_decode_legacy(const ScrBytes *b, double encoding_value) {
  unsigned encoding = (unsigned)encoding_value;
  if (encoding < SCR_TD_SINGLE_COUNT) return scr_td_single_byte(b, encoding);
  switch (encoding) {
    case SCR_TD_X_USER_DEFINED: return scr_td_x_user_defined(b);
    case SCR_TD_UTF16LE: return scr_td_utf16(b, false);
    case SCR_TD_UTF16BE: return scr_td_utf16(b, true);
    case SCR_TD_GB18030: return scr_td_gb18030_decode(b);
    case SCR_TD_BIG5: return scr_td_big5_decode(b);
    case SCR_TD_EUC_JP: return scr_td_euc_jp_decode(b);
    case SCR_TD_ISO_2022_JP: return scr_td_iso_2022_jp_decode(b);
    case SCR_TD_SHIFT_JIS: return scr_td_shift_jis_decode(b);
    case SCR_TD_EUC_KR: return scr_td_euc_kr_decode(b);
    default: return scr_str_new("", 0); /* compiler invariant */
  }
}
#endif /* SCR_TEXT_DECODER_LEGACY */

/* Decode the next code point from an ScrStr's storage — ALWAYS valid
 * UTF-8 (the string runtime never stores ill-formed sequences), so no
 * validation re-runs here. */
static uint32_t scr_bytes_next_cp(const uint8_t *in, size_t *ip) {
  uint8_t b = in[*ip];
  if (b < 0x80) {
    *ip += 1;
    return b;
  }
  if ((b & 0xe0) == 0xc0) {
    uint32_t cp = ((uint32_t)(b & 0x1f) << 6) | (in[*ip + 1] & 0x3f);
    *ip += 2;
    return cp;
  }
  if ((b & 0xf0) == 0xe0) {
    uint32_t cp = ((uint32_t)(b & 0xf) << 12) | ((uint32_t)(in[*ip + 1] & 0x3f) << 6) |
                  (in[*ip + 2] & 0x3f);
    *ip += 3;
    return cp;
  }
  uint32_t cp = ((uint32_t)(b & 0x7) << 18) | ((uint32_t)(in[*ip + 1] & 0x3f) << 12) |
                ((uint32_t)(in[*ip + 2] & 0x3f) << 6) | (in[*ip + 3] & 0x3f);
  *ip += 4;
  return cp;
}

static bool scr_enc_is(const ScrStr *enc, const char *name) {
  size_t n = strlen(name);
  return enc->len == n && memcmp(enc->data, name, n) == 0;
}

/* toString("utf16le"): LE code-unit pairs (an odd tail byte drops, like
 * Node). Valid surrogate pairs combine into their code point; a LONE
 * surrogate becomes U+FFFD — Node keeps it as a lone UTF-16 unit, which
 * UTF-8 string storage cannot hold (SEMANTICS.md divergence; stdout
 * agrees byte-for-byte because Node's own write replaces it there too). */
static ScrStr *scr_bytes_decode_utf16le(const uint8_t *in, size_t n) {
  size_t units = n / 2;
  char *out = malloc(units * 3 + 2);
  if (!out) scr_bytes_oom();
  size_t o = 0;
  for (size_t u = 0; u < units; u++) {
    uint32_t cu = (uint32_t)in[u * 2] | ((uint32_t)in[u * 2 + 1] << 8);
    if (cu >= 0xd800 && cu <= 0xdbff && u + 1 < units) {
      uint32_t lo = (uint32_t)in[(u + 1) * 2] | ((uint32_t)in[(u + 1) * 2 + 1] << 8);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        o = scr_bytes_put_cp(out, o, 0x10000 + ((cu - 0xd800) << 10) + (lo - 0xdc00));
        u++;
        continue;
      }
    }
    o = scr_bytes_put_cp(out, o, cu >= 0xd800 && cu <= 0xdfff ? 0xfffd : cu);
  }
  ScrStr *s = scr_str_new(out, o);
  free(out);
  return s;
}

ScrStr *scr_bytes_to_str(const ScrBytes *b, const ScrStr *enc) {
  const uint8_t *in = b->data;
  size_t n = b->len; /* u8: len == byte length */
  if (scr_enc_is(enc, "hex")) {
    char *out = malloc(n * 2 + 1);
    if (!out) scr_bytes_oom();
    for (size_t i = 0; i < n; i++) {
      out[i * 2] = scr_hex_digits[in[i] >> 4];
      out[i * 2 + 1] = scr_hex_digits[in[i] & 0xf];
    }
    ScrStr *s = scr_str_new(out, n * 2);
    free(out);
    return s;
  }
  if (scr_enc_is(enc, "base64")) return scr_bytes_encode_b64(in, n, false);
  if (scr_enc_is(enc, "base64url")) return scr_bytes_encode_b64(in, n, true);
  if (scr_enc_is(enc, "latin1")) {
    /* Each byte is U+00XX ("binary" normalizes here upstream). */
    char *out = malloc(n * 2 + 1);
    if (!out) scr_bytes_oom();
    size_t o = 0;
    for (size_t i = 0; i < n; i++) o = scr_bytes_put_cp(out, o, in[i]);
    ScrStr *s = scr_str_new(out, o);
    free(out);
    return s;
  }
  if (scr_enc_is(enc, "ascii")) {
    /* Node's ascii decode masks the high bit: byte & 0x7f. */
    char *out = malloc(n + 1);
    if (!out) scr_bytes_oom();
    for (size_t i = 0; i < n; i++) out[i] = (char)(in[i] & 0x7f);
    ScrStr *s = scr_str_new(out, n);
    free(out);
    return s;
  }
  if (scr_enc_is(enc, "utf16le")) return scr_bytes_decode_utf16le(in, n);
  /* utf8 (the compiler completes an omitted encoding to "utf8") */
  return scr_bytes_decode_utf8(in, n);
}

/* Buffer.toString with a runtime-valued encoding. Literal call sites fold
 * this same alias table in the frontend; variables arrive here, where Node
 * also accepts ASCII case variants and rejects unknown names catchably. */
static bool scr_enc_eq_ci(const ScrStr *raw, const char *name) {
  size_t n = strlen(name);
  if (raw->len != n) return false;
  for (size_t i = 0; i < n; i++) {
    char c = raw->data[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
    if (c != name[i]) return false;
  }
  return true;
}

static ScrStr *scr_bytes_normalize_encoding(const ScrStr *raw) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"},
    {"base64", "base64"}, {"base64url", "base64url"},
    {"latin1", "latin1"}, {"binary", "latin1"}, {"ascii", "ascii"},
    {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"},
  };
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
    if (scr_enc_eq_ci(raw, map[i].from)) {
      return scr_str_new(map[i].to, strlen(map[i].to));
    }
  }
  static const char prefix[] = "Unknown encoding: ";
  const size_t prefix_len = sizeof prefix - 1;
  if (raw->len > SIZE_MAX - prefix_len) scr_bytes_oom();
  const size_t msg_len = prefix_len + raw->len;
  char *msg = malloc(msg_len);
  if (!msg) scr_bytes_oom();
  memcpy(msg, prefix, prefix_len);
  memcpy(msg + prefix_len, raw->data, raw->len);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, msg_len,
                           "ERR_UNKNOWN_ENCODING");
  free(msg);
  return NULL;
}

ScrStr *scr_bytes_to_str_checked(const ScrBytes *b, const ScrStr *enc) {
  /* Node returns before resolving the encoding when there are no bytes
   * to decode, so even an unknown runtime name answers the empty string. */
  if (b->len == 0) return scr_str_new("", 0);
  ScrStr *normalized = scr_bytes_normalize_encoding(enc);
  if (!normalized) return NULL;
  ScrStr *out = scr_bytes_to_str(b, normalized);
  scr_str_release(normalized);
  return out;
}

ScrStr *scr_bytes_to_str_checked_range(const ScrBytes *b, const ScrStr *enc,
                                       double start, double end) {
  /* The range is selected before Node resolves the encoding. A clamped
   * empty window therefore answers "" even for an unknown name. */
  size_t s0, e0;
  scr_bytes_to_str_bounds(b, start, end, &s0, &e0);
  if (s0 == e0) return scr_str_new("", 0);
  ScrStr *normalized = scr_bytes_normalize_encoding(enc);
  if (!normalized) return NULL;
  ScrStr *out = scr_bytes_to_str_range(b, normalized, start, end);
  scr_str_release(normalized);
  return out;
}

static int scr_hex_val(uint8_t c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static int scr_b64_val(uint8_t c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+' || c == '-') return 62; /* '-': base64url, accepted like Node */
  if (c == '/' || c == '_') return 63; /* '_': base64url */
  return -1;
}

ScrBytes *scr_bytes_from_str(const ScrStr *s, const ScrStr *enc) {
  const uint8_t *in = (const uint8_t *)s->data;
  size_t n = s->len;
  if (scr_enc_is(enc, "latin1") || scr_enc_is(enc, "ascii")) {
    /* Node writes charCodeAt(i) & 0xFF for BOTH spellings — an astral
     * code point contributes its two surrogates' low bytes. */
    ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, n);
    size_t o = 0, i = 0;
    while (i < n) {
      uint32_t cp = scr_bytes_next_cp(in, &i);
      if (cp > 0xffff) {
        cp -= 0x10000;
        b->data[o++] = (uint8_t)(0xd800 + (cp >> 10));
        b->data[o++] = (uint8_t)(0xdc00 + (cp & 0x3ff));
      } else {
        b->data[o++] = (uint8_t)cp;
      }
    }
    b->len = o; /* never grows past n: multi-byte cps shrink */
    return b;
  }
  if (scr_enc_is(enc, "utf16le")) {
    ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, n * 2);
    size_t o = 0, i = 0;
    while (i < n) {
      uint32_t cp = scr_bytes_next_cp(in, &i);
      if (cp > 0xffff) {
        cp -= 0x10000;
        uint32_t hi = 0xd800 + (cp >> 10), lo = 0xdc00 + (cp & 0x3ff);
        b->data[o++] = (uint8_t)hi;
        b->data[o++] = (uint8_t)(hi >> 8);
        b->data[o++] = (uint8_t)lo;
        b->data[o++] = (uint8_t)(lo >> 8);
      } else {
        b->data[o++] = (uint8_t)cp;
        b->data[o++] = (uint8_t)(cp >> 8);
      }
    }
    b->len = o;
    return b;
  }
  if (enc->len == 3 && memcmp(enc->data, "hex", 3) == 0) {
    /* Node-lenient: parse pairs, stop at the first invalid pair or the
     * odd tail (Buffer.from("a1g2", "hex") is <Buffer a1>). */
    ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, n / 2);
    size_t o = 0;
    for (size_t i = 0; i + 1 < n; i += 2) {
      int hi = scr_hex_val(in[i]);
      int lo = scr_hex_val(in[i + 1]);
      if (hi < 0 || lo < 0) break;
      b->data[o++] = (uint8_t)((hi << 4) | lo);
    }
    b->len = o; /* never grows: shrinking the count is safe */
    return b;
  }
  if (scr_enc_is(enc, "base64") || scr_enc_is(enc, "base64url")) {
    /* Node-lenient: skip bytes outside the (standard + url-safe)
     * alphabets — whitespace, '=', stray punctuation; decode 4-char
     * groups, and a 2/3-char tail into 1/2 bytes. Both spellings share
     * the decoder (Node accepts either alphabet under either name). */
    ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, n / 4 * 3 + 2);
    size_t o = 0;
    unsigned acc = 0;
    int have = 0;
    for (size_t i = 0; i < n; i++) {
      int v = scr_b64_val(in[i]);
      if (v < 0) continue;
      acc = (acc << 6) | (unsigned)v;
      if (++have == 4) {
        b->data[o++] = (uint8_t)(acc >> 16);
        b->data[o++] = (uint8_t)(acc >> 8);
        b->data[o++] = (uint8_t)acc;
        acc = 0;
        have = 0;
      }
    }
    if (have == 2) b->data[o++] = (uint8_t)(acc >> 4);
    else if (have == 3) {
      b->data[o++] = (uint8_t)(acc >> 10);
      b->data[o++] = (uint8_t)(acc >> 2);
    }
    b->len = o;
    return b;
  }
  /* utf8: ScrStr storage IS the bytes */
  ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, n);
  memcpy(b->data, in, n);
  return b;
}

ScrBytes *scr_bytes_from_arr(ScrBytesElem elem, const ScrArr *arr) {
  ScrBytes *b = scr_bytes_alloc(elem, arr->len);
  for (size_t i = 0; i < arr->len; i++) {
    double v;
    memcpy(&v, &arr->data[i], sizeof v); /* SCR_ELEM_F64 slots hold doubles */
    switch (elem) {
      case SCR_BYTES_U8:
        b->data[i] = (uint8_t)scr_bytes_to_u32(v);
        break;
      case SCR_BYTES_U32: {
        uint32_t u = scr_bytes_to_u32(v);
        memcpy(b->data + i * 4, &u, 4);
        break;
      }
      case SCR_BYTES_F32: {
        float f = (float)v;
        memcpy(b->data + i * 4, &f, 4);
        break;
      }
      case SCR_BYTES_I32: {
        uint32_t u = scr_bytes_to_u32(v);
        memcpy(b->data + i * 4, &u, 4); /* same residue reinterpreted */
        break;
      }
    }
  }
  return b;
}

/* ── equals / compare / indexOf / fill / copy / swap / write (u8; the
 * error ladders mirror Node's validateOffset — 'an integer' first, then
 * the '>= 0 && <= max' render, ERR_OUT_OF_RANGE's Received rules — and
 * copy's C++-side ladder; pinned by corpus 1663) ─────────────────────── */

size_t scr_num_received(double v, char out[48]); /* the numeric section below */

/* validateOffset(name, 0, max): non-integers are 'an integer' (Number.
 * isInteger — ±Infinity render 'an integer' too), the rest '>= 0 && <=
 * max' (Node spells '&&' here, unlike the read/write families' 'and').
 * max < 0 means copy's no-upper-bound '>= 0' render. Exported: the
 * checked-dynamic compare/equals validators (scr_bytes_io.c) run the
 * same ladder after their own type gate. */
bool scr_bytes_validate_off(const char *name, double value, double max) {
  if (isfinite(value) && floor(value) == value && value >= 0 && (max < 0 || value <= max)) return true;
  char recv[48];
  scr_num_received(value, recv);
  char msg[160];
  int mlen;
  if (floor(value) != value || !isfinite(value)) {
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"%s\" is out of range. It must be an integer. Received %s",
                    name, recv);
  } else if (max < 0) {
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"%s\" is out of range. It must be >= 0. Received %s", name, recv);
  } else {
    char maxb[32];
    scr_f64_to_str(max, maxb);
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"%s\" is out of range. It must be >= 0 && <= %s. Received %s",
                    name, maxb, recv);
  }
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
  return false;
}

bool scr_bytes_equals(const ScrBytes *a, const ScrBytes *b) {
  return a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
}

/* src.compare(target, targetStart?, targetEnd?, sourceStart?, sourceEnd?)
 * — nargs counts the PRESENT index args (defaults skip validation, like
 * Node). Empty-range shortcuts and the memcmp-with-length-tiebreak are
 * Node's exactly. */
double scr_bytes_compare(const ScrBytes *src, const ScrBytes *target, double nargs,
                         double ts, double te, double ss, double se) {
  size_t n = (size_t)nargs;
  if (n < 1) ts = 0;
  else if (!scr_bytes_validate_off("targetStart", ts, 9007199254740991.0)) return 0;
  if (n < 2) te = (double)target->len;
  else if (!scr_bytes_validate_off("targetEnd", te, (double)target->len)) return 0;
  if (n < 3) ss = 0;
  else if (!scr_bytes_validate_off("sourceStart", ss, 9007199254740991.0)) return 0;
  if (n < 4) se = (double)src->len;
  else if (!scr_bytes_validate_off("sourceEnd", se, (double)src->len)) return 0;
  if (ts >= te) return ss >= se ? 0 : 1;
  if (ss >= se) return -1;
  /* Clamp the starts into range (a start past the length reads empty —
   * handled above; here both windows are non-empty). */
  size_t t0 = ts > (double)target->len ? target->len : (size_t)ts;
  size_t s0 = ss > (double)src->len ? src->len : (size_t)ss;
  size_t tn = (size_t)te - t0, sn = (size_t)se - s0;
  size_t m = sn < tn ? sn : tn;
  int c = memcmp(src->data + s0, target->data + t0, m);
  if (c != 0) return c < 0 ? -1 : 1;
  if (sn == tn) return 0;
  return sn < tn ? -1 : 1;
}

/* The shared search core: needle bytes, a coerced byteOffset (trunc; NaN
 * means 'search everything' — 0 forward, the end backward; negatives
 * count from the end, and a still-negative backward search answers -1),
 * and the utf16le alignment stride. */
double scr_bytes_index_of(const ScrBytes *b, const ScrBytes *needle, double off, double align, bool fwd) {
  size_t len = b->len, nlen = needle->len;
  size_t step = align == 2 ? 2 : 1;
  double o = (off != off) ? (fwd ? 0 : (double)len) : trunc(off);
  if (o < 0) {
    o += (double)len;
    if (o < 0) {
      if (!fwd) return -1;
      o = 0;
    }
  }
  if (nlen == 0) return o > (double)len ? (double)len : o; /* '' matches at the clamp */
  if (nlen > len) return -1;
  if (fwd) {
    size_t start = o > (double)len ? len : (size_t)o;
    if (step == 2) start += start % 2;
    for (size_t i = start; i + nlen <= len; i += step) {
      if (memcmp(b->data + i, needle->data, nlen) == 0) return (double)i;
    }
    return -1;
  }
  size_t start = o > (double)(len - nlen) ? len - nlen : (size_t)o;
  if (step == 2) start -= start % 2;
  for (size_t i = start;; i -= step) {
    if (memcmp(b->data + i, needle->data, nlen) == 0) return (double)i;
    if (i < step) break;
  }
  return -1;
}

double scr_bytes_index_of_num(const ScrBytes *b, double v, double off, bool fwd) {
  uint8_t byte = (uint8_t)scr_bytes_to_u32(v);
  ScrBytes needle = { .rc = 1, .len = 1, .elem = SCR_BYTES_U8, .data = &byte, .backing = NULL };
  return scr_bytes_index_of(b, &needle, off, 1, fwd);
}

/* fill's shared core over a normalized byte pattern. nargs counts the
 * present offset/end args. An EMPTY pattern zero-fills when zero_ok
 * (Node's '' string) and is the constant TypeError otherwise (an empty
 * Uint8Array value). Returns the receiver (+1) — fill chains. */
static ScrBytes *scr_bytes_fill_core(ScrBytes *b, const uint8_t *pat, size_t patn,
                                     bool zero_ok, double nargs, double offset, double end) {
  if (patn == 0 && !zero_ok) {
    static const char msg[] = "The argument 'value' is invalid. Received <Buffer >";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  size_t n = (size_t)nargs;
  if (n < 1) offset = 0;
  else if (!scr_bytes_validate_off("offset", offset, 9007199254740991.0)) return NULL;
  if (n < 2) end = (double)b->len;
  else if (!scr_bytes_validate_off("end", end, (double)b->len)) return NULL;
  if (offset < end) {
    size_t o = (size_t)offset > b->len ? b->len : (size_t)offset;
    size_t e = (size_t)end;
    if (patn == 0) {
      memset(b->data + o, 0, e - o);
    } else if (patn == 1) {
      memset(b->data + o, pat[0], e - o);
    } else {
      for (size_t i = o; i < e; i++) b->data[i] = pat[(i - o) % patn];
    }
  }
  return scr_bytes_retain(b);
}

ScrBytes *scr_bytes_fill(ScrBytes *b, const ScrBytes *pattern, double nargs, double offset, double end) {
  return scr_bytes_fill_core(b, pattern->data, pattern->len, false, nargs, offset, end);
}

ScrBytes *scr_bytes_fill_num(ScrBytes *b, double v, double nargs, double offset, double end) {
  uint8_t byte = (uint8_t)scr_bytes_to_u32(v);
  return scr_bytes_fill_core(b, &byte, 1, false, nargs, offset, end);
}

ScrBytes *scr_bytes_fill_str(ScrBytes *b, const ScrStr *s, const ScrStr *enc,
                             double nargs, double offset, double end) {
  ScrBytes *pat = scr_bytes_from_str(s, enc);
  ScrBytes *r = scr_bytes_fill_core(b, pat->data, pat->len, true, nargs, offset, end);
  scr_bytes_release(pat);
  return r;
}

/* src.copy(dst, targetStart?, sourceStart?, sourceEnd?): Node's C++-side
 * ladder — fractional indices TRUNCATE silently, targetStart/sourceEnd
 * check only >= 0 (past-the-end clamps to nothing), sourceStart is
 * bounded by the source length. Returns the byte count copied. */
double scr_bytes_copy_into(const ScrBytes *src, ScrBytes *dst, double nargs,
                           double ts, double ss, double se) {
  size_t n = (size_t)nargs;
  ts = n < 1 ? 0 : trunc(ts);
  ss = n < 2 ? 0 : trunc(ss);
  se = n < 3 ? (double)src->len : trunc(se);
  if (!scr_bytes_validate_off("targetStart", ts, -1)) return 0;
  if (!scr_bytes_validate_off("sourceStart", ss, (double)src->len)) return 0;
  if (!scr_bytes_validate_off("sourceEnd", se, -1)) return 0;
  if (ts >= (double)dst->len) return 0;
  size_t t0 = (size_t)ts;
  size_t s0 = (size_t)ss;
  size_t e0 = se > (double)src->len ? src->len : (size_t)se;
  if (s0 >= e0) return 0;
  size_t count = e0 - s0;
  if (count > dst->len - t0) count = dst->len - t0;
  memmove(dst->data + t0, src->data + s0, count);
  return (double)count;
}

/* swap16/32/64: in-place byte reversal per group; the receiver answers
 * (+1, chaining like fill). A length off the width is Node's constant
 * ERR_INVALID_BUFFER_SIZE RangeError. */
ScrBytes *scr_bytes_swap(ScrBytes *b, double width) {
  size_t w = (size_t)width;
  if (b->len % w != 0) {
    char msg[64];
    int mlen = snprintf(msg, sizeof msg, "Buffer size must be a multiple of %zu-bits", w * 8);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_INVALID_BUFFER_SIZE");
    return NULL;
  }
  for (size_t g = 0; g < b->len; g += w) {
    for (size_t i = 0; i < w / 2; i++) {
      uint8_t t = b->data[g + i];
      b->data[g + i] = b->data[g + w - 1 - i];
      b->data[g + w - 1 - i] = t;
    }
  }
  return scr_bytes_retain(b);
}

/* buf.write(string, offset?, length?, enc): encodes, clamps the byte
 * budget (offset and an explicit length validate against the buffer
 * length with Node's '&&' render; the length then clamps to the space
 * left), and truncates at a UNIT boundary — whole UTF-8 code points,
 * whole utf16le code units (a surrogate pair CAN split — Node writes the
 * lone lead), byte-level for the rest. Returns the bytes written. */
double scr_bytes_write_str(ScrBytes *b, const ScrStr *s, const ScrStr *enc,
                           double offset, double len, bool has_len) {
  if (!scr_bytes_validate_off("offset", offset, (double)b->len)) return 0;
  size_t o = (size_t)offset;
  size_t remaining = b->len - o;
  size_t budget;
  if (has_len) {
    if (!scr_bytes_validate_off("length", len, (double)b->len)) return 0;
    budget = (size_t)len > remaining ? remaining : (size_t)len;
  } else {
    budget = remaining;
  }
  ScrBytes *encd = scr_bytes_from_str(s, enc);
  size_t k = encd->len < budget ? encd->len : budget;
  if (k < encd->len) {
    if (scr_enc_is(enc, "utf16le")) {
      k -= k % 2;
    } else if (!scr_enc_is(enc, "hex") && !scr_enc_is(enc, "base64") &&
               !scr_enc_is(enc, "base64url") && !scr_enc_is(enc, "latin1") &&
               !scr_enc_is(enc, "ascii")) {
      /* utf8: back off a split multi-byte sequence (whole chars only). */
      size_t lead = k;
      while (lead > 0 && (encd->data[lead] & 0xc0) == 0x80) lead--;
      if (lead < k) {
        uint8_t l = encd->data[lead];
        size_t need = (l & 0xf8) == 0xf0 ? 4 : (l & 0xf0) == 0xe0 ? 3 : (l & 0xe0) == 0xc0 ? 2 : 1;
        if (lead + need > k) k = lead;
      }
    }
  }
  memcpy(b->data + o, encd->data, k);
  scr_bytes_release(encd);
  return (double)k;
}

/* Buffer.concat(list, totalLength): the same concatenation truncated or
 * zero-padded to the validated total. */
ScrBytes *scr_bytes_concat_len(const ScrArr *list, double total) {
  /* An empty list short-circuits BEFORE the total validates — Node's
   * own `if (list.length === 0) return new FastBuffer()`. */
  if (list->len == 0) return scr_bytes_alloc(SCR_BYTES_U8, 0);
  if (!scr_bytes_validate_off("length", total, 9007199254740991.0)) return NULL;
  ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, (size_t)total);
  size_t o = 0;
  for (size_t i = 0; i < list->len && o < b->len; i++) {
    const ScrBytes *part = (const ScrBytes *)(uintptr_t)list->data[i];
    size_t take = part->len < b->len - o ? part->len : b->len - o;
    memcpy(b->data + o, part->data, take);
    o += take;
  }
  return b;
}

/* Buffer.byteLength(string, enc): utf8 is the storage length (ScrStr IS
 * utf8 bytes), latin1/ascii count UTF-16 units, utf16le doubles them,
 * hex halves the length, base64/base64url use Node's padding-trimmed
 * (len * 3) >>> 2. The enc arrives NORMALIZED (the compiler folds
 * aliases). */
double scr_bytes_byte_length_str(ScrStr *s, const ScrStr *enc) {
  if (scr_enc_is(enc, "latin1") || scr_enc_is(enc, "ascii")) {
    return scr_str_utf16_len(s);
  }
  if (scr_enc_is(enc, "utf16le")) return 2 * scr_str_utf16_len(s);
  if (scr_enc_is(enc, "hex")) {
    return floor(scr_str_utf16_len(s) / 2);
  }
  if (scr_enc_is(enc, "base64") || scr_enc_is(enc, "base64url")) {
    size_t units = (size_t)scr_str_utf16_len(s);
    /* Trailing '=' padding trims (at most two) — checked on the raw
     * bytes: '=' is ASCII, so the last byte IS the last unit. */
    if (units > 0 && s->len >= 1 && s->data[s->len - 1] == '=') units--;
    if (units > 1 && s->len >= 2 && s->data[s->len - 2] == '=') units--;
    return (double)((units * 3) >> 2);
  }
  return (double)s->len; /* utf8 */
}

/* Buffer.isEncoding(name): case-insensitive over Node's alias set. */
bool scr_bytes_is_encoding(const ScrStr *s) {
  static const char *const names[] = {
      "utf8", "utf-8", "ascii", "latin1", "binary",   "base64",
      "hex",  "ucs2",  "ucs-2", "utf16le", "utf-16le", "base64url",
  };
  if (s->len < 3 || s->len > 9) return false;
  char low[10];
  for (size_t i = 0; i < s->len; i++) {
    char c = s->data[i];
    low[i] = c >= 'A' && c <= 'Z' ? (char)(c + 32) : c;
  }
  low[s->len] = 0;
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    if (strlen(names[i]) == s->len && memcmp(low, names[i], s->len) == 0) return true;
  }
  return false;
}

ScrBytes *scr_bytes_concat(const ScrArr *list) {
  size_t total = 0;
  for (size_t i = 0; i < list->len; i++) {
    const ScrBytes *part = (const ScrBytes *)(uintptr_t)list->data[i];
    total += part->len;
  }
  ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, total);
  size_t o = 0;
  for (size_t i = 0; i < list->len; i++) {
    const ScrBytes *part = (const ScrBytes *)(uintptr_t)list->data[i];
    memcpy(b->data + o, part->data, part->len);
    o += part->len;
  }
  return b;
}

/* ── the buf.read* / buf.write* numeric families (Node's exact bounds
 * discipline; the error ladders below mirror lib/internal/buffer.js's
 * boundsError/checkInt/checkBounds byte-for-byte — pinned by corpus
 * 1660 against the live Node oracle) ───────────────────────────────── */

/* ERR_OUT_OF_RANGE's "Received" rendering: integers with |v| > 2^32 get
 * Node's addNumericalSeparator underscores applied to the plain String()
 * form — INCLUDING its quirks on exponent renderings ("1e_+21",
 * "1e+_300"); everything else is the shortest-roundtrip number. Shared
 * with the fs/net option-ladder validators (scr_num_received). */
size_t scr_num_received(double v, char out[48]) {
  char plain[32];
  size_t n = scr_f64_to_str(v, plain);
  if (!(isfinite(v) && trunc(v) == v && fabs(v) > 4294967296.0)) {
    memcpy(out, plain, n + 1);
    return n;
  }
  /* addNumericalSeparator: head of 1-3 chars (past a leading '-'), then
   * '_'-joined groups of 3 — walked over the STRING, exactly Node. */
  size_t start = plain[0] == '-' ? 1 : 0;
  size_t head = n;
  while (head >= start + 4) head -= 3;
  memcpy(out, plain, head);
  size_t o = head;
  for (size_t p = head; p < n; p += 3) {
    out[o++] = '_';
    memcpy(out + o, plain + p, 3);
    o += 3;
  }
  out[o] = 0;
  return o;
}

/* Node's boundsError: a non-integer index is "an integer" first, a
 * negative capacity (buffer shorter than the read/write width) is the
 * constant ERR_BUFFER_OUT_OF_BOUNDS text, and everything else renders
 * the ">= min and <= max" range. type NULL means "offset" (min 0);
 * "byteLength" renders min 1. All catchable RangeErrors. */
static void scr_bytes_bounds_error(double value, double length, const char *type) {
  char recv[48];
  scr_num_received(value, recv);
  char msg[160];
  int mlen;
  if (floor(value) != value) {
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"%s\" is out of range. It must be an integer. Received %s",
                    type ? type : "offset", recv);
  } else if (length < 0) {
    static const char oob[] = "Attempt to access memory outside buffer bounds";
    scr_throw_error_msg_code(SCR_ERR_RANGE, oob, sizeof oob - 1, "ERR_BUFFER_OUT_OF_BOUNDS");
    return;
  } else {
    char lenbuf[32];
    scr_f64_to_str(length, lenbuf);
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"%s\" is out of range. It must be >= %d and <= %s. Received %s",
                    type ? type : "offset", type ? 1 : 0, lenbuf, recv);
  }
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
}

/* The shared offset gate: width bytes at offset must lie inside b. */
static bool scr_bytes_rw_check(const ScrBytes *b, double offset, size_t width) {
  double cap = (double)b->len - (double)width;
  if (floor(offset) != offset || cap < 0 || offset < 0 || offset > cap) {
    scr_bytes_bounds_error(offset, cap, NULL);
    return false;
  }
  return true;
}

/* Node's checkInt for the integer writes: the VALUE range throws before
 * any offset check; widths past 4 bytes render the "2 ** N" range form
 * (checkInt's byteLength > 3 branch). NaN passes both comparisons —
 * exactly Node — and writes zeros downstream. */
static bool scr_bytes_check_int(const ScrBytes *b, double value, double offset,
                                size_t width, bool sign) {
  double max = sign ? exp2((double)(8 * width - 1)) - 1 : exp2((double)(8 * width)) - 1;
  double min = sign ? -exp2((double)(8 * width - 1)) : 0;
  if (value > max || value < min) {
    char recv[48];
    scr_num_received(value, recv);
    char msg[160];
    int mlen;
    if (width > 4) {
      if (sign) {
        mlen = snprintf(msg, sizeof msg,
                        "The value of \"value\" is out of range. It must be >= -(2 ** %zu) and < 2 ** %zu. Received %s",
                        8 * width - 1, 8 * width - 1, recv);
      } else {
        mlen = snprintf(msg, sizeof msg,
                        "The value of \"value\" is out of range. It must be >= 0 and < 2 ** %zu. Received %s",
                        8 * width, recv);
      }
    } else {
      char minb[32], maxb[32];
      scr_f64_to_str(min, minb);
      scr_f64_to_str(max, maxb);
      mlen = snprintf(msg, sizeof msg,
                      "The value of \"value\" is out of range. It must be >= %s and <= %s. Received %s",
                      minb, maxb, recv);
    }
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return false;
  }
  return scr_bytes_rw_check(b, offset, width);
}

static size_t scr_bytes_num_width(ScrBytesNumKind kind) {
  switch (kind) {
    case SCR_BN_U8:
    case SCR_BN_I8:
      return 1;
    case SCR_BN_U16:
    case SCR_BN_I16:
      return 2;
    case SCR_BN_F64:
      return 8;
    default:
      return 4; /* u32 / i32 / f32 */
  }
}

double scr_bytes_read_num(const ScrBytes *b, double offset, ScrBytesNumKind kind, bool le) {
  size_t width = scr_bytes_num_width(kind);
  if (!scr_bytes_rw_check(b, offset, width)) return 0;
  const uint8_t *p = b->data + (size_t)offset;
  uint64_t u = 0;
  for (size_t i = 0; i < width; i++) {
    u |= (uint64_t)p[le ? i : width - 1 - i] << (8 * i);
  }
  switch (kind) {
    case SCR_BN_U8:
    case SCR_BN_U16:
    case SCR_BN_U32:
      return (double)u;
    case SCR_BN_I8:
      return (double)(int8_t)u;
    case SCR_BN_I16:
      return (double)(int16_t)u;
    case SCR_BN_I32:
      return (double)(int32_t)u;
    case SCR_BN_F32: {
      uint32_t bits = (uint32_t)u;
      float f;
      memcpy(&f, &bits, 4);
      return (double)f;
    }
    case SCR_BN_F64: {
      double d;
      memcpy(&d, &u, 8);
      return d;
    }
  }
  return 0; /* unreachable */
}

double scr_bytes_write_num(ScrBytes *b, double value, double offset, ScrBytesNumKind kind, bool le) {
  size_t width = scr_bytes_num_width(kind);
  uint64_t u;
  if (kind == SCR_BN_F32 || kind == SCR_BN_F64) {
    /* Float writes carry no value check (any double stores; the float
     * cast rounds to nearest exactly like Float32Array assignment). */
    if (!scr_bytes_rw_check(b, offset, width)) return 0;
    if (kind == SCR_BN_F32) {
      float f = (float)value;
      uint32_t bits;
      memcpy(&bits, &f, 4);
      u = bits;
    } else {
      memcpy(&u, &value, 8);
    }
  } else {
    bool sign = kind == SCR_BN_I8 || kind == SCR_BN_I16 || kind == SCR_BN_I32;
    if (!scr_bytes_check_int(b, value, offset, width, sign)) return 0;
    double t = trunc(value);
    if (t != t) t = 0; /* NaN passed the range gate: zeros, like Node */
    u = (uint64_t)(int64_t)t; /* two's complement of the truncation */
  }
  uint8_t *p = b->data + (size_t)offset;
  for (size_t i = 0; i < width; i++) {
    p[le ? i : width - 1 - i] = (uint8_t)(u >> (8 * i));
  }
  return offset + (double)width;
}

/* readUIntLE/BE / readIntLE/BE — the variable-width family: byteLength
 * validates FIRST (1-6, its own error ladder), then the offset gate. */
double scr_bytes_read_var(const ScrBytes *b, double offset, double byte_length, bool sign, bool le) {
  if (floor(byte_length) != byte_length || byte_length < 1 || byte_length > 6) {
    scr_bytes_bounds_error(byte_length, 6, "byteLength");
    return 0;
  }
  size_t width = (size_t)byte_length;
  if (!scr_bytes_rw_check(b, offset, width)) return 0;
  const uint8_t *p = b->data + (size_t)offset;
  uint64_t u = 0;
  for (size_t i = 0; i < width; i++) {
    u |= (uint64_t)p[le ? i : width - 1 - i] << (8 * i);
  }
  if (sign && (u & ((uint64_t)1 << (8 * width - 1)))) {
    return (double)(int64_t)(u - ((uint64_t)1 << (8 * width)));
  }
  return (double)u;
}

/* writeUIntLE/BE / writeIntLE/BE: byteLength, then value, then offset —
 * Node's exact check order. Returns offset + byteLength. */
double scr_bytes_write_var(ScrBytes *b, double value, double offset, double byte_length, bool sign, bool le) {
  if (floor(byte_length) != byte_length || byte_length < 1 || byte_length > 6) {
    scr_bytes_bounds_error(byte_length, 6, "byteLength");
    return 0;
  }
  size_t width = (size_t)byte_length;
  if (!scr_bytes_check_int(b, value, offset, width, sign)) return 0;
  double t = trunc(value);
  if (t != t) t = 0;
  uint64_t u = (uint64_t)(int64_t)t;
  uint8_t *p = b->data + (size_t)offset;
  for (size_t i = 0; i < width; i++) {
    p[le ? i : width - 1 - i] = (uint8_t)(u >> (8 * i));
  }
  return offset + (double)width;
}
