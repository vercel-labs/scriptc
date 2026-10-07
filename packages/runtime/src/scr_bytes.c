/* Typed arrays / Buffer: ONE runtime representation (ScrBytes — see the
 * header contract). An ScrBytes either OWNS its storage or is a VIEW into
 * an owner's (backing set, chain depth exactly 1): DataView, subarray(),
 * and Buffer's slice() all alias JS-exactly; only the plain typed arrays'
 * slice() copies. Coercions are JS-exact
 * (ToUint8/ToUint32 modular truncation, double→float rounding); the
 * encoding conversions (utf8 with WHATWG replacement, hex, base64) match
 * Node byte-for-byte — the differential corpus holds them to it. */
#include "scr_runtime.h"
#include "scr_numeric.h"
#include "scr_text_decoder_labels.h"
#ifdef SCR_TEXT_DECODER_LEGACY
#include "scr_text_decoder_data.h"
#endif

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool scr_td_label_space(unsigned char c) {
  return c == 9 || c == 10 || c == 12 || c == 13 || c == 32;
}

double scr_text_decoder_encoding(const ScrDyn *label) {
  if (!label || label->kind == SCR_DYN_UNDEF) return -1;
  ScrStr *text = scr_dyn_string_coerce_js(label);
  if (!text) return -1;
  size_t start = 0, end = text->len;
  while (start < end && scr_td_label_space((unsigned char)text->data[start])) start++;
  while (end > start && scr_td_label_space((unsigned char)text->data[end - 1])) end--;
  for (size_t i = 0; i < sizeof scr_td_labels / sizeof scr_td_labels[0]; i++) {
    const char *candidate = scr_td_labels[i].label;
    if (strlen(candidate) != end - start) continue;
    bool matches = true;
    for (size_t j = start; j < end; j++) {
      unsigned char c = (unsigned char)text->data[j];
      if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
      if (c != (unsigned char)candidate[j - start]) { matches = false; break; }
    }
    if (matches) {
      double result = scr_td_labels[i].encoding;
      scr_str_release(text);
      return result;
    }
  }
  static const char prefix[] = "The \"";
  static const char suffix[] = "\" encoding is not supported";
  size_t length = sizeof prefix - 1 + text->len + sizeof suffix - 1;
  char *message = malloc(length + 1);
  if (!message) scr_trap("scriptc: out of memory\n");
  memcpy(message, prefix, sizeof prefix - 1);
  memcpy(message + sizeof prefix - 1, text->data, text->len);
  memcpy(message + sizeof prefix - 1 + text->len, suffix, sizeof suffix);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message, length, "ERR_ENCODING_NOT_SUPPORTED");
  free(message);
  scr_str_release(text);
  return -1;
}

ScrStr *scr_text_decoder_name(double encoding) {
  static const char *names[] = {
    "ibm866", "iso-8859-2", "iso-8859-3", "iso-8859-4", "iso-8859-5",
    "iso-8859-6", "iso-8859-7", "iso-8859-8", "iso-8859-10", "iso-8859-13",
    "iso-8859-14", "iso-8859-15", "iso-8859-16", "koi8-r", "koi8-u",
    "macintosh", "windows-874", "windows-1250", "windows-1251", "windows-1252",
    "windows-1253", "windows-1254", "windows-1255", "windows-1256", "windows-1257",
    "windows-1258", "x-mac-cyrillic", "x-user-defined", "utf-16le", "utf-16be",
    "gb18030", "big5", "euc-jp", "iso-2022-jp", "shift_jis", "euc-kr",
    "iso-8859-8-i", "gbk",
  };
  const char *name = encoding < 0 ? "utf-8" : names[(unsigned)encoding];
  return scr_str_new(name, strlen(name));
}

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_bytes = 0;
long scr_bytes_live_count(void) { return scr_live_bytes; }
#endif

static void scr_bytes_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

size_t scr_bytes_elem_size(ScrBytesElem elem) {
  switch (elem) {
    case SCR_BYTES_U8: case SCR_BYTES_U8C: case SCR_BYTES_I8: return 1;
    case SCR_BYTES_U16: case SCR_BYTES_I16: return 2;
    case SCR_BYTES_U32: case SCR_BYTES_I32: case SCR_BYTES_F32: return 4;
    case SCR_BYTES_F64: return 8;
  }
  scr_trap("scriptc: invalid typed array element kind\n");
}

const char *scr_bytes_elem_name(ScrBytesElem elem) {
  switch (elem) {
    case SCR_BYTES_U8: return "Uint8Array";
    case SCR_BYTES_U8C: return "Uint8ClampedArray";
    case SCR_BYTES_I8: return "Int8Array";
    case SCR_BYTES_U16: return "Uint16Array";
    case SCR_BYTES_I16: return "Int16Array";
    case SCR_BYTES_U32: return "Uint32Array";
    case SCR_BYTES_I32: return "Int32Array";
    case SCR_BYTES_F32: return "Float32Array";
    case SCR_BYTES_F64: return "Float64Array";
  }
  scr_trap("scriptc: invalid typed array element kind\n");
}

double scr_bytes_to_u8_clamp(double value) {
  if (!(value > 0)) return 0;
  if (value >= 255) return 255;
  double lower = floor(value);
  double fraction = value - lower;
  return fraction > 0.5 || (fraction == 0.5 && ((unsigned)lower & 1)) ? lower + 1 : lower;
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

/* Adopt private malloc storage without clearing or copying its contents. The
 * caller transfers ownership; views keep it alive through the usual owner. */
ScrBytes *scr_bytes_take_data(uint8_t *data, size_t len) {
  if (!data && len) scr_trap("scriptc: NULL owned byte storage\n");
  ScrBytes *b = malloc(sizeof(ScrBytes));
  if (!b) scr_bytes_oom();
  b->rc = 1;
  b->len = len;
  b->elem = SCR_BYTES_U8;
  b->data = data ? data : malloc(1);
  if (!b->data) scr_bytes_oom();
  b->backing = NULL;
  b->is_buffer = false;
  b->is_data_view = false;
  b->external = false;
  b->shared = NULL;
#ifdef SCR_RC_AUDIT
  scr_live_bytes++;
#endif
  return b;
}

/* Only complete, non-observable initialization may use private storage. */
static ScrBytes *scr_bytes_alloc_private(ScrBytesElem elem, size_t len) {
  size_t width = scr_bytes_elem_size(elem);
  if (len > SIZE_MAX / width) scr_bytes_oom();
  uint8_t *data = malloc(len ? len * width : 1);
  if (!data) scr_bytes_oom();
  ScrBytes *b = scr_bytes_take_data(data, len);
  b->elem = elem;
  return b;
}

static ScrBytes *scr_bytes_alloc(ScrBytesElem elem, size_t len) {
  size_t width = scr_bytes_elem_size(elem);
  if (len > SIZE_MAX / width) scr_bytes_oom();
  uint8_t *data = calloc(len ? len : 1, width);
  if (!data) scr_bytes_oom();
  ScrBytes *b = scr_bytes_take_data(data, len);
  b->elem = elem;
  return b;
}

ScrBytes *scr_bytes_from_external(void *data, size_t length) {
  ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, 0);
  /* Keep the owned empty allocation for NULL/zero-length views: existing
   * view operations may add zero to the data pointer. */
  if (data) {
    free(b->data);
    b->data = data;
    b->external = true;
  }
  b->len = length;
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
  ScrBytes *b = scr_bytes_alloc_private(SCR_BYTES_U8, len);
  if (len != 0) memcpy(b->data, data, len);
  return b;
}

ScrBytes *scr_bytes_copy(const ScrBytes *src) {
  SCR_SHARED_GUARD(src, NULL);
  ScrBytes *b = scr_bytes_alloc_private(src->elem, src->len);
  memcpy(b->data, src->data, src->len * scr_bytes_elem_size(src->elem));
  return b;
}

ScrBytes *scr_bytes_raw_view(ScrBytes *bytes) {
  if (bytes->elem == SCR_BYTES_U8) return scr_bytes_retain(bytes);
  return scr_dataview_new(bytes, scr_bytes_byte_offset(bytes), true, scr_bytes_byte_len(bytes));
}

ScrBytes *scr_bytes_as_buffer(ScrBytes *bytes) {
  bytes->is_buffer = true;
  bytes->is_data_view = false;
  return scr_bytes_retain(bytes);
}

void scr_bytes_release(ScrBytes *b) {
  if (!b || b->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--b->rc == 0) {
    scr_weak_dispose(b);
    if (b->backing) {
      scr_bytes_release(b->backing); /* a view: data points into the owner */
    } else if (b->shared) {
      scr_shared_release(b->shared);
    } else if (!b->external) {
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
  SCR_SHARED_GUARD(dst, src);
  if (dst->elem != src->elem || dst->len != src->len) {
    scr_trap("scriptc: typed array snapshot shape changed\n");
  }
  memcpy(dst->data, src->data, dst->len * scr_bytes_elem_size(dst->elem));
}

double scr_bytes_byte_len(const ScrBytes *b) {
  return (double)(b->len * scr_bytes_elem_size(b->elem));
}

/* ── element access ────────────────────────────────────────────────────
 * Invalid writes are ignored. Typed numeric reads cannot represent
 * undefined, so invalid reads trap; checked reads return undefined. */

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
  return scr_numeric_to_u32(v);
}

double scr_bytes_get(const ScrBytes *b, double i) {
  SCR_SHARED_GUARD(b, NULL);
  size_t idx = scr_bytes_check_index(b, i);
  switch (b->elem) {
    case SCR_BYTES_U8: case SCR_BYTES_U8C:
      return (double)b->data[idx];
    case SCR_BYTES_I8: {
      int8_t v;
      memcpy(&v, b->data + idx, 1);
      return (double)v;
    }
    case SCR_BYTES_U16: {
      uint16_t v;
      memcpy(&v, b->data + idx * 2, 2);
      return (double)v;
    }
    case SCR_BYTES_I16: {
      int16_t v;
      memcpy(&v, b->data + idx * 2, 2);
      return (double)v;
    }
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
    case SCR_BYTES_F64: {
      double v;
      memcpy(&v, b->data + idx * 8, 8);
      return v;
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
  SCR_SHARED_GUARD(b, NULL);
  if (!(i >= 0) || i != trunc(i) || i >= (double)b->len) return;
  size_t idx = (size_t)i;
  switch (b->elem) {
    case SCR_BYTES_U8: case SCR_BYTES_I8:
      b->data[idx] = (uint8_t)scr_bytes_to_u32(v);
      break;
    case SCR_BYTES_U8C:
      b->data[idx] = (uint8_t)scr_bytes_to_u8_clamp(v);
      break;
    case SCR_BYTES_U16: case SCR_BYTES_I16: {
      uint16_t u = (uint16_t)scr_bytes_to_u32(v);
      memcpy(b->data + idx * 2, &u, 2);
      break;
    }
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
    case SCR_BYTES_F64:
      memcpy(b->data + idx * 8, &v, 8);
      break;
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

/* Dispatch once per bounded block, not once per element. Loads and stores
 * use memcpy so views and external storage need no stronger alignment or
 * aliasing promise. A bounded scratch block avoids a kind-pair code matrix. */
static void scr_bytes_read_numbers(double *out, const uint8_t *src, ScrBytesElem elem, size_t count) {
#define SCR_READ_NUMBERS(kind, type) \
  case kind: \
    for (size_t i = 0; i < count; i++) { \
      type value; \
      memcpy(&value, src + i * sizeof value, sizeof value); \
      out[i] = (double)value; \
    } \
    return
  switch (elem) {
    case SCR_BYTES_U8C:
    SCR_READ_NUMBERS(SCR_BYTES_U8, uint8_t);
    SCR_READ_NUMBERS(SCR_BYTES_I8, int8_t);
    SCR_READ_NUMBERS(SCR_BYTES_U16, uint16_t);
    SCR_READ_NUMBERS(SCR_BYTES_I16, int16_t);
    SCR_READ_NUMBERS(SCR_BYTES_U32, uint32_t);
    SCR_READ_NUMBERS(SCR_BYTES_I32, int32_t);
    SCR_READ_NUMBERS(SCR_BYTES_F32, float);
    SCR_READ_NUMBERS(SCR_BYTES_F64, double);
  }
#undef SCR_READ_NUMBERS
}

static void scr_bytes_write_numbers(uint8_t *dst, ScrBytesElem elem, const double *src, size_t count) {
#define SCR_WRITE_NUMBERS(type, expression) \
  for (size_t i = 0; i < count; i++) { \
    type value = (expression); \
    memcpy(dst + i * sizeof value, &value, sizeof value); \
  } \
  return
  switch (elem) {
    case SCR_BYTES_U8: case SCR_BYTES_I8: {
      SCR_WRITE_NUMBERS(uint8_t, (uint8_t)scr_numeric_to_u32(src[i]));
    }
    case SCR_BYTES_U8C: {
      SCR_WRITE_NUMBERS(uint8_t, (uint8_t)scr_bytes_to_u8_clamp(src[i]));
    }
    case SCR_BYTES_U16: case SCR_BYTES_I16: {
      SCR_WRITE_NUMBERS(uint16_t, (uint16_t)scr_numeric_to_u32(src[i]));
    }
    case SCR_BYTES_U32: case SCR_BYTES_I32: {
      SCR_WRITE_NUMBERS(uint32_t, scr_numeric_to_u32(src[i]));
    }
    case SCR_BYTES_F32: {
      SCR_WRITE_NUMBERS(float, (float)src[i]);
    }
    case SCR_BYTES_F64: {
      memcpy(dst, src, count * sizeof(double));
      return;
    }
  }
#undef SCR_WRITE_NUMBERS
}

/* Caller guarantees disjoint spans, or snapshots the source before entry. */
static void scr_bytes_convert_span(uint8_t *dst, ScrBytesElem dest_elem,
                                    const uint8_t *src, ScrBytesElem src_elem, size_t count) {
  size_t source_width = scr_bytes_elem_size(src_elem);
  size_t dest_width = scr_bytes_elem_size(dest_elem);
  double values[128];
  while (count) {
    size_t block = count < 128 ? count : 128;
    scr_bytes_read_numbers(values, src, src_elem, block);
    scr_bytes_write_numbers(dst, dest_elem, values, block);
    src += block * source_width;
    dst += block * dest_width;
    count -= block;
  }
}

ScrBytes *scr_bytes_convert(ScrBytesElem elem, const ScrBytes *src) {
  SCR_SHARED_GUARD(src, NULL);
  if (elem == src->elem) return scr_bytes_copy(src);
  ScrBytes *out = scr_bytes_alloc_private(elem, src->len);
  scr_bytes_convert_span(out->data, elem, src->data, src->elem, src->len);
  return out;
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
  SCR_SHARED_GUARD(b, NULL);
  size_t s = scr_bytes_rel_index(start, b->len);
  size_t e = scr_bytes_rel_index(end, b->len);
  size_t count = e > s ? e - s : 0;
  size_t esize = scr_bytes_elem_size(b->elem);
  ScrBytes *out = scr_bytes_alloc_private(b->elem, count);
  memcpy(out->data, b->data + s * esize, count * esize);
  return out;
}

ScrBytes *scr_bytes_copy_within(ScrBytes *b, double target, double start, double end) {
  SCR_SHARED_GUARD(b, NULL);
  size_t t = scr_bytes_rel_index(target, b->len);
  size_t s = scr_bytes_rel_index(start, b->len);
  size_t e = scr_bytes_rel_index(end, b->len);
  size_t count = e > s ? e - s : 0;
  if (count > b->len - t) count = b->len - t;
  size_t width = scr_bytes_elem_size(b->elem);
  memmove(b->data + t * width, b->data + s * width, count * width);
  return scr_bytes_retain(b);
}

/* TypedArray.prototype.fill on non-u8 receivers: per-ELEMENT fill with
 * the element write's JS-exact coercion (ToUint32/ToInt32 wrap, f32
 * rounding), slice-clamped relative indices; answers the receiver +1
 * (chaining). Never throws — Buffer's throwing fill family is separate. */
ScrBytes *scr_bytes_fill_elem(ScrBytes *b, double v, double start, double end) {
  SCR_SHARED_GUARD(b, NULL);
  size_t s = scr_bytes_rel_index(start, b->len);
  size_t e = scr_bytes_rel_index(end, b->len);
  if (e > s) {
    size_t width = scr_bytes_elem_size(b->elem);
    uint8_t pattern[8];
    scr_bytes_write_numbers(pattern, b->elem, &v, 1);
    uint8_t *dst = b->data + s * width;
    size_t bytes = (e - s) * width;
    if (width == 1) memset(dst, pattern[0], bytes);
    else {
      memcpy(dst, pattern, width);
      size_t filled = width;
      while (filled < bytes) {
        size_t copy = filled < bytes - filled ? filled : bytes - filled;
        memcpy(dst + filled, dst, copy);
        filled += copy;
      }
    }
  }
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
  v->is_buffer = b->is_buffer;
  v->is_data_view = false;
  v->external = false;
  v->shared = owner->shared;
#ifdef SCR_RC_AUDIT
  scr_live_bytes++;
#endif
  return v;
}

void scr_bytes_set_from(ScrBytes *dst, const ScrBytes *src, double offset) {
  SCR_SHARED_GUARD(dst, src);
  double t = (offset != offset) ? 0 : trunc(offset);
  if (!(t >= 0) || (double)src->len + t > (double)dst->len) {
    static const char msg[] = "offset is out of bounds";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return;
  }
  size_t width = scr_bytes_elem_size(dst->elem);
  uint8_t *target = dst->data + (size_t)t * width;
  if (dst->elem == src->elem) {
    memmove(target, src->data, src->len * width);
    return;
  }
  size_t source_bytes = src->len * scr_bytes_elem_size(src->elem);
  size_t dest_bytes = src->len * width;
  uintptr_t to = (uintptr_t)target, from = (uintptr_t)src->data;
  bool overlap = to <= from ? from - to < dest_bytes : to - from < source_bytes;
  if (overlap) {
    /* Snapshot raw source bytes before cross-kind writes. Distinct external
     * wrappers can alias even without a shared backing identity. */
    uint8_t *copy = malloc(source_bytes ? source_bytes : 1);
    if (!copy) scr_bytes_oom();
    memcpy(copy, src->data, source_bytes);
    scr_bytes_convert_span(target, dst->elem, copy, src->elem, src->len);
    free(copy);
  } else {
    scr_bytes_convert_span(target, dst->elem, src->data, src->elem, src->len);
  }
}

/* Checked-native array-like sources. Runtime objects with an unsupported
 * prototype/iterator keep a catchable refusal instead of losing hooks. */
static bool scr_bytes_source_refusal(void) {
  static const char msg[] = "typed-array conversion of an opaque reference is not supported yet";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  return false;
}

static bool scr_bytes_source_length(const ScrDyn *value, double *length) {
  switch (value->kind) {
  case SCR_DYN_ARR: *length = (double)value->v.arr.len; return true;
  case SCR_DYN_STR: *length = scr_str_utf16_len(value->v.str); return true;
  case SCR_DYN_OBJ: {
    ScrDyn *v = scr_dyn_obj_read(value, "length", 6);
    if (!v) return false;
    double n;
    bool ok = scr_dyn_number_coerce_js(v, &n);
    scr_dyn_release(v);
    if (!ok) return false;
    *length = !(n > 0) ? 0 : fmin(floor(n), 9007199254740991.0);
    return true;
  }
  case SCR_DYN_NULL:
  case SCR_DYN_UNDEF: {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return false;
  }
  case SCR_DYN_NUM:
  case SCR_DYN_BOOL: *length = 0; return true;
  default: return scr_bytes_source_refusal();
  }
}

static ScrDyn *scr_bytes_source_at(const ScrDyn *value, size_t i) {
  if (value->kind == SCR_DYN_ARR) return scr_dyn_arr_at(value, (double)i);
  if (value->kind == SCR_DYN_STR) {
    ScrStr *s = scr_str_char_at(value->v.str, (double)i);
    ScrDyn *out = scr_dyn_new_str(s);
    scr_str_release(s);
    return out;
  }
  char key[32];
  int n = snprintf(key, sizeof key, "%zu", i);
  return scr_dyn_obj_read(value, key, (size_t)n);
}

static bool scr_bytes_copy_array_like(ScrBytes *dst, const ScrDyn *src, size_t offset, size_t count) {
  for (size_t i = 0; i < count; i++) {
    ScrDyn *value = scr_bytes_source_at(src, i);
    if (!value) return false;
    double number;
    bool ok = scr_dyn_number_coerce_js(value, &number);
    scr_dyn_release(value);
    if (!ok) return false;
    scr_bytes_set(dst, (double)(offset + i), number);
  }
  return true;
}

ScrBytes *scr_bytes_from_dyn(ScrBytesElem elem, const ScrDyn *value, bool from) {
  if (from && (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF)) {
    const char *msg = value->kind == SCR_DYN_NULL
        ? "object null is not iterable (cannot read property Symbol(Symbol.iterator))"
        : "undefined is not iterable (cannot read property Symbol(Symbol.iterator))";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, strlen(msg));
    return NULL;
  }
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    // Class snapshots omit prototypes, so do not interpret them as plain objects.
    ScrBytes *out = NULL;
    if (view->kind == SCR_DYN_BYTES || view->kind == SCR_DYN_ARR) out = scr_bytes_from_dyn(elem, view, from);
    else scr_bytes_source_refusal();
    scr_dyn_release(view);
    return out;
  }
  if (value->kind == SCR_DYN_BYTES) return scr_bytes_convert(elem, value->v.bytes);
  if (!from && scr_buffer_storage_is(value)) return scr_array_buffer_view(elem, value, scr_dyn_undefined(), scr_dyn_undefined());
  if (!from && (value->kind == SCR_DYN_NUM || value->kind == SCR_DYN_BOOL ||
                value->kind == SCR_DYN_STR || value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF)) {
    double number;
    if (!scr_dyn_number_coerce_js(value, &number)) return NULL;
    return scr_bytes_new(elem, number);
  }
  // Constructors drain array iterators before element coercion. Node's .from
  // fast path reads ordinary array elements during conversion instead. Strings
  // supplied to .from iterate by code point (set reads UTF-16 code units).
  if ((!from && value->kind == SCR_DYN_ARR) || (from && value->kind == SCR_DYN_STR)) {
    ScrDyn *items = scr_dyn_iter_pack(value, NULL);
    if (!items) return NULL;
    ScrBytes *out = scr_bytes_new(elem, (double)items->v.arr.len);
    if (out && !scr_bytes_copy_array_like(out, items, 0, out->len)) {
      scr_bytes_release(out);
      out = NULL;
    }
    scr_dyn_release(items);
    return out;
  }
  double length;
  if (!scr_bytes_source_length(value, &length)) return NULL;
  if (length >= 9007199254740991.0 || length >= (double)(SIZE_MAX / scr_bytes_elem_size(elem))) {
    static const char msg[] = "Array buffer allocation failed";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  ScrBytes *out = scr_bytes_new(elem, length);
  if (out && !scr_bytes_copy_array_like(out, value, 0, out->len)) {
    scr_bytes_release(out);
    return NULL;
  }
  return out;
}

void scr_bytes_set_from_dyn(ScrBytes *dst, const ScrDyn *src, double offset) {
  double t = isnan(offset) ? 0 : trunc(offset);
  if (!(t >= 0)) {
    static const char msg[] = "offset is out of bounds";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return;
  }
  if (src->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(src);
    if (view->kind == SCR_DYN_BYTES || view->kind == SCR_DYN_ARR) scr_bytes_set_from_dyn(dst, view, t);
    else scr_bytes_source_refusal();
    scr_dyn_release(view);
    return;
  }
  if (src->kind == SCR_DYN_BYTES) {
    scr_bytes_set_from(dst, src->v.bytes, t);
    return;
  }
  double length;
  if (!scr_bytes_source_length(src, &length)) return;
  if (t > (double)dst->len || length > (double)dst->len - t) {
    static const char msg[] = "offset is out of bounds";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return;
  }
  scr_bytes_copy_array_like(dst, src, (size_t)t, (size_t)length);
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
  v->is_buffer = false;
  v->is_data_view = true;
  v->external = false;
  v->shared = owner->shared;
#ifdef SCR_RC_AUDIT
  scr_live_bytes++;
#endif
  return v;
}

ScrBytes *scr_bytes_buffer_view(ScrBytes *src, ScrBytesElem elem,
                               double offset, bool has_len, double length) {
  ScrBytes *owner = src->backing ? src->backing : src;
  size_t width = scr_bytes_elem_size(elem);
  double available = scr_bytes_byte_len(owner);
  double off = isnan(offset) ? 0 : trunc(offset);
  double count = isnan(length) ? 0 : trunc(length);
  if (off < 0 || off > 9007199254740991.0 || off > available ||
      fmod(off, (double)width) != 0 ||
      (has_len && (count < 0 || count > 9007199254740991.0 || count > (available - off) / (double)width)) ||
      (!has_len && fmod(available - off, (double)width) != 0)) {
    static const char msg[] = "Invalid typed array buffer range";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  ScrBytes *view = scr_dataview_new(owner, off, true,
      has_len ? count * (double)width : available - off);
  if (!view) return NULL;
  view->elem = elem;
  view->len /= width;
  view->is_data_view = false;
  return view;
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
  SCR_SHARED_GUARD(b, NULL);
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
  SCR_SHARED_GUARD(b, NULL);
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
      return; /* BigInt setters use scr_dataview_write_u64_raw. */
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
static void scr_td_invalid(const char *encoding) {
  char message[160];
  int n = snprintf(message, sizeof message, "The encoded data was not valid for encoding %s", encoding);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, "ERR_ENCODING_INVALID_ENCODED_DATA");
}

/* Stop before the first non-ASCII byte; every word load stays in the span. */
static size_t scr_bytes_ascii_prefix(const uint8_t *data, size_t len) {
  size_t i = 0;
  while (len - i >= sizeof(uint64_t)) {
    uint64_t word;
    memcpy(&word, data + i, sizeof word);
    if (word & UINT64_C(0x8080808080808080)) break;
    i += sizeof word;
  }
  while (i < len && data[i] < 0x80) i++;
  return i;
}

/* Length of the well-formed prefix. On failure, next skips exactly the
 * maximal invalid subpart; an offending continuation is reprocessed. */
static size_t scr_bytes_utf8_prefix(const uint8_t *data, size_t len, size_t *next) {
  size_t i = 0;
  while (i < len) {
    i += scr_bytes_ascii_prefix(data + i, len - i);
    if (i == len) break;
    size_t start = i;
    unsigned byte = data[i++], count;
    unsigned low = 0x80, high = 0xbf;
    if (byte < 0x80) continue;
    if (byte >= 0xc2 && byte <= 0xdf) count = 1;
    else if (byte >= 0xe0 && byte <= 0xef) {
      count = 2;
      if (byte == 0xe0) low = 0xa0;
      if (byte == 0xed) high = 0x9f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      count = 3;
      if (byte == 0xf0) low = 0x90;
      if (byte == 0xf4) high = 0x8f;
    } else { *next = i; return start; }
    for (unsigned j = 0; j < count; j++) {
      if (i == len || data[i] < low || data[i] > high) {
        *next = i;
        return start;
      }
      i++;
      low = 0x80;
      high = 0xbf;
    }
  }
  *next = len;
  return len;
}

/* Measure first, then write into final string storage. Invalid input can
 * expand, but neither valid prefixes nor retained output need a 3x buffer. */
static size_t scr_bytes_utf8_repair(const uint8_t *in, size_t n,
                                  size_t prefix, size_t next, char *out) {
  size_t written = 0, offset = 0;
  for (;;) {
    if (prefix > SIZE_MAX - written) scr_bytes_oom();
    if (out && prefix) memcpy(out + written, in + offset, prefix);
    written += prefix;
    if (prefix == n - offset) return written;
    if (written > SIZE_MAX - 3) scr_bytes_oom();
    if (out) memcpy(out + written, "\xef\xbf\xbd", 3);
    written += 3;
    offset += next;
    prefix = scr_bytes_utf8_prefix(in + offset, n - offset, &next);
  }
}

static ScrStr *scr_bytes_decode_utf8_options(const uint8_t *in, size_t n, bool fatal) {
  if (in == NULL && n != 0) {
    scr_trap("scriptc: native callback passed a NULL span with nonzero length\n");
  }
  if (n == 0) return scr_str_new("", 0);
  size_t next;
  size_t prefix = scr_bytes_utf8_prefix(in, n, &next);
  if (prefix == n) return scr_str_new((const char *)in, n);
  if (fatal) { scr_td_invalid("utf-8"); return NULL; }
  size_t length = scr_bytes_utf8_repair(in, n, prefix, next, NULL);
  ScrStr *s = scr_str_alloc_raw(length, length);
  scr_bytes_utf8_repair(in, n, prefix, next, s->data);
  s->data[length] = '\0';
  return s;
}

static ScrStr *scr_bytes_decode_utf8(const uint8_t *in, size_t n) {
  return scr_bytes_decode_utf8_options(in, n, false);
}

ScrStr *scr_str_from_utf8_lossy(const uint8_t *bytes, size_t len) {
  return scr_bytes_decode_utf8(bytes, len);
}

/* WHATWG TextDecoder.decode (utf-8, default options): the SAME maximal-
 * subpart replacement decode as toString("utf8") above, with one
 * difference — a leading UTF-8 BOM is stripped (ignoreBOM defaults to
 * false in the spec; Buffer.toString keeps the BOM as U+FEFF). */
ScrStr *scr_text_decode_options(const ScrBytes *b, bool fatal, bool ignore_bom) {
  SCR_SHARED_GUARD(b, NULL);
  const uint8_t *in = b->data;
  size_t n = b->len;
  if (!ignore_bom && n >= 3 && in[0] == 0xef && in[1] == 0xbb && in[2] == 0xbf) {
    in += 3;
    n -= 3;
  }
  return scr_bytes_decode_utf8_options(in, n, fatal);
}

ScrBytes *scr_bytes_buffer_source(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(value);
    if (!materialized) return NULL;
    ScrBytes *result = scr_bytes_buffer_source(materialized);
    scr_dyn_release(materialized);
    return result;
  }
  if (value->kind == SCR_DYN_UNDEF) return scr_bytes_new(SCR_BYTES_U8, 0);
  if (value->kind == SCR_DYN_BYTES) {
    ScrBytes *bytes = value->v.bytes;
    return scr_bytes_buffer_view(bytes, SCR_BYTES_U8, scr_bytes_byte_offset(bytes), true, scr_bytes_byte_len(bytes));
  }
  if (scr_buffer_storage_is(value)) {
    return scr_array_buffer_view(SCR_BYTES_U8, value, scr_dyn_undefined(), scr_dyn_undefined());
  }
  static const char message[] = "The input argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.";
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
  return NULL;
}

ScrStr *scr_text_decode_buffer_source(const ScrDyn *value) {
  ScrBytes *view = scr_bytes_buffer_source(value);
  if (!view) return NULL;
  ScrStr *out = scr_text_decode(view);
  scr_bytes_release(view);
  return out;
}

ScrStr *scr_text_decode(const ScrBytes *b) {
  return scr_text_decode_options(b, false, false);
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
  SCR_SHARED_GUARD(chunk, NULL);
  double hold;
  return scr_strdec_step(enc, pending, chunk, true, &hold);
}

/* The decoder state AFTER a write: the packed trailing partial sequence. */
double scr_strdec_next(const ScrStr *enc, double pending, const ScrBytes *chunk) {
  SCR_SHARED_GUARD(chunk, NULL);
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
  SCR_SHARED_GUARD(b, NULL);
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
  size_t groups = n / 3, tail = n % 3;
  size_t suffix = tail ? (url ? tail + 1 : 4) : 0;
  if (groups > (SIZE_MAX - suffix) / 4) scr_bytes_oom();
  size_t outlen = groups * 4 + suffix;
  ScrStr *s = scr_str_alloc_raw(outlen, outlen);
  char *out = s->data;
  size_t i = 0, o = 0;
  for (; i < groups * 3; i += 3) {
    unsigned v = ((unsigned)in[i] << 16) | ((unsigned)in[i + 1] << 8) | in[i + 2];
    out[o++] = abc[v >> 18];
    out[o++] = abc[(v >> 12) & 63];
    out[o++] = abc[(v >> 6) & 63];
    out[o++] = abc[v & 63];
  }
  if (tail) {
    unsigned v = (unsigned)in[i] << 16;
    if (tail == 2) v |= (unsigned)in[i + 1] << 8;
    out[o++] = abc[v >> 18];
    out[o++] = abc[(v >> 12) & 63];
    if (tail == 2) out[o++] = abc[(v >> 6) & 63];
    else if (!url) out[o++] = '=';
    if (!url) out[o++] = '=';
  }
  out[outlen] = '\0';
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
  bool failed;
} ScrTdOut;

static ScrTdOut scr_td_out_new(size_t input_len) {
  if (input_len > (SIZE_MAX - 8) / 3) scr_bytes_oom();
  ScrTdOut out = { malloc(input_len * 3 + 8), 0, false };
  if (!out.data) scr_bytes_oom();
  return out;
}

static void scr_td_put(ScrTdOut *out, uint32_t cp) {
  out->len = scr_bytes_put_cp(out->data, out->len, cp);
}

static void scr_td_error(ScrTdOut *out) {
  out->failed = true;
  scr_td_put(out, 0xfffd);
}

static ScrStr *scr_td_finish(ScrTdOut *out, bool fatal) {
  if (fatal && out->failed) { free(out->data); scr_td_invalid("legacy encoding"); return NULL; }
  ScrStr *str = scr_str_new(out->data, out->len);
  free(out->data);
  return str;
}

static ScrStr *scr_td_single_byte(const ScrBytes *b, unsigned encoding, bool fatal) {
  ScrTdOut out = scr_td_out_new(b->len);
  for (size_t i = 0; i < b->len; i++) {
    uint8_t byte = b->data[i];
    uint32_t cp = byte < 0x80 ? byte : scr_td_single[encoding][byte - 0x80];
    if (cp == 0xfffd) scr_td_error(&out); else scr_td_put(&out, cp);
  }
  return scr_td_finish(&out, fatal);
}

static ScrStr *scr_td_x_user_defined(const ScrBytes *b, bool fatal) {
  ScrTdOut out = scr_td_out_new(b->len);
  for (size_t i = 0; i < b->len; i++) {
    uint8_t byte = b->data[i];
    scr_td_put(&out, byte < 0x80 ? byte : 0xf780 + byte - 0x80);
  }
  return scr_td_finish(&out, fatal);
}

static ScrStr *scr_td_utf16(const ScrBytes *b, bool be, bool fatal, bool ignore_bom) {
  const uint8_t *in = b->data;
  size_t n = b->len;
  /* TextDecoder's BOM handling strips only the BOM matching the selected
   * endian decoder. The opposite BOM decodes to U+FFFE and remains. */
  if (!ignore_bom && n >= 2 && ((!be && in[0] == 0xff && in[1] == 0xfe) ||
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
  return scr_td_finish(&out, fatal);
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
static ScrStr *scr_td_gb18030_decode(const ScrBytes *b, bool fatal) {
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
  return scr_td_finish(&out, fatal);
}

static ScrStr *scr_td_big5_decode(const ScrBytes *b, bool fatal) {
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
  return scr_td_finish(&out, fatal);
}

static ScrStr *scr_td_euc_jp_decode(const ScrBytes *b, bool fatal) {
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
  return scr_td_finish(&out, fatal);
}

static ScrStr *scr_td_shift_jis_decode(const ScrBytes *b, bool fatal) {
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
  return scr_td_finish(&out, fatal);
}

static ScrStr *scr_td_euc_kr_decode(const ScrBytes *b, bool fatal) {
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
  return scr_td_finish(&out, fatal);
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

static ScrStr *scr_td_iso_2022_jp_decode(const ScrBytes *b, bool fatal) {
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
  return scr_td_finish(&out, fatal);
}

ScrStr *scr_text_decode_legacy_options(const ScrBytes *b, double encoding_value, bool fatal, bool ignore_bom) {
  SCR_SHARED_GUARD(b, NULL);
  unsigned encoding = (unsigned)encoding_value;
  if (encoding == 36) encoding = 7; /* ISO-8859-8-I */
  if (encoding == 37) encoding = SCR_TD_GB18030; /* GBK */
  if (encoding < SCR_TD_SINGLE_COUNT) return scr_td_single_byte(b, encoding, fatal);
  switch (encoding) {
    case SCR_TD_X_USER_DEFINED: return scr_td_x_user_defined(b, fatal);
    case SCR_TD_UTF16LE: return scr_td_utf16(b, false, fatal, ignore_bom);
    case SCR_TD_UTF16BE: return scr_td_utf16(b, true, fatal, ignore_bom);
    case SCR_TD_GB18030: return scr_td_gb18030_decode(b, fatal);
    case SCR_TD_BIG5: return scr_td_big5_decode(b, fatal);
    case SCR_TD_EUC_JP: return scr_td_euc_jp_decode(b, fatal);
    case SCR_TD_ISO_2022_JP: return scr_td_iso_2022_jp_decode(b, fatal);
    case SCR_TD_SHIFT_JIS: return scr_td_shift_jis_decode(b, fatal);
    case SCR_TD_EUC_KR: return scr_td_euc_kr_decode(b, fatal);
    default: return scr_str_new("", 0); /* compiler invariant */
  }
}
ScrStr *scr_text_decode_legacy(const ScrBytes *b, double encoding_value) {
  return scr_text_decode_legacy_options(b, encoding_value, false, false);
}
#endif /* SCR_TEXT_DECODER_LEGACY */

/* Streaming decoders retain only an incomplete character and whether the
 * initial BOM has been handled. The state object belongs to the codec's
 * private record, so aliases and closure captures share the same decoder. */
static size_t scr_td_utf8_tail(const uint8_t *bytes, size_t n) {
  size_t tail = scr_strdec_tail(bytes, n);
  if (!tail) return 0;
  uint8_t lead = bytes[n - tail];
  if (lead < 0xc2 || lead > 0xf4) return 0;
  if (tail > 1) {
    uint8_t second = bytes[n - tail + 1];
    if ((lead == 0xe0 && second < 0xa0) || (lead == 0xed && second > 0x9f) ||
        (lead == 0xf0 && second < 0x90) || (lead == 0xf4 && second > 0x8f)) return 0;
  }
  return tail;
}

ScrStr *scr_text_decode_stream(ScrDyn *state, const ScrBytes *input,
    double encoding, bool fatal, bool ignore_bom, bool stream) {
  SCR_SHARED_GUARD(input, NULL);
  if (encoding == 36) encoding = 7; /* ISO-8859-8-I is a single-byte decoder. */
  ScrDyn *saved = scr_dyn_obj_read(state, "pending", 7);
  size_t pending = saved->kind == SCR_DYN_BYTES ? saved->v.bytes->len : 0;
  if (input->len > SIZE_MAX - pending) scr_bytes_oom();
  ScrBytes *combined = scr_bytes_new(SCR_BYTES_U8, (double)(pending + input->len));
  if (pending) memcpy(combined->data, saved->v.bytes->data, pending);
  if (input->len) memcpy(combined->data + pending, input->data, input->len);
  scr_dyn_release(saved);
  ScrDyn *bom = scr_dyn_obj_read(state, "bom", 3);
  bool seen_bom = scr_dyn_truthy(bom);
  scr_dyn_release(bom);
  size_t hold = stream && encoding < 0 ? scr_td_utf8_tail(combined->data, combined->len) : 0;
#ifdef SCR_TEXT_DECODER_LEGACY
  if (stream && ((unsigned)encoding == SCR_TD_UTF16LE || (unsigned)encoding == SCR_TD_UTF16BE)) {
    size_t complete = combined->len & ~(size_t)1;
    hold = combined->len - complete;
    if (complete >= 2) {
      const uint8_t *last = combined->data + complete - 2;
      uint16_t unit = (unsigned)encoding == SCR_TD_UTF16BE
        ? ((uint16_t)last[0] << 8) | last[1] : last[0] | ((uint16_t)last[1] << 8);
      if (unit >= 0xd800 && unit <= 0xdbff) hold += 2;
    }
  }
  if (stream && encoding >= SCR_TD_GB18030) {
    scr_bytes_release(combined);
    static const char message[] = "Streaming TextDecoder for this legacy encoding has no native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
#endif
  size_t complete = combined->len - hold;
  ScrBytes *tail = scr_bytes_new(SCR_BYTES_U8, (double)hold);
  if (hold) memcpy(tail->data, combined->data + complete, hold);
  scr_dyn_obj_set(state, "pending", 7, scr_dyn_new_bytes(tail));
  scr_bytes_release(tail);
  scr_dyn_obj_set(state, "bom", 3, scr_dyn_new_bool(stream && (seen_bom || complete > 0)));
  combined->len = complete;
  ScrStr *result;
  if (encoding < 0) result = scr_text_decode_options(combined, fatal, ignore_bom || seen_bom);
#ifdef SCR_TEXT_DECODER_LEGACY
  else result = scr_text_decode_legacy_options(combined, encoding, fatal, ignore_bom || seen_bom);
#else
  else { result = NULL; scr_trap("legacy TextDecoder requires its runtime pack variant"); }
#endif
  scr_bytes_release(combined);
  return result;
}

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

/* encodeInto consumes complete Unicode scalars while counting UTF-16 units.
 * Borrow the destination so writes through a subarray retain their aliasing. */
ScrDyn *scr_text_encode_into(const ScrDyn *source, const ScrDyn *destination) {
  if (source->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("src", "of type string", source);
    return NULL;
  }
  if (destination->kind != SCR_DYN_BYTES || destination->v.bytes->elem != SCR_BYTES_U8 || destination->v.bytes->is_data_view) {
    scr_dyn_arg_type_fail("dest", "an instance of Uint8Array", destination);
    return NULL;
  }
  const ScrStr *text = source->v.str;
  ScrBytes *dest = destination->v.bytes;
  SCR_SHARED_GUARD(dest, NULL);
  size_t read = 0, written = 0;
  size_t limit = text->len < dest->len ? text->len : dest->len;
  while (written < limit) {
    size_t ascii = scr_bytes_ascii_prefix((const uint8_t *)text->data + written, limit - written);
    written += ascii;
    read += ascii;
    if (written == limit) break;
    size_t end = written;
    uint32_t cp = scr_bytes_next_cp((const uint8_t *)text->data, &end);
    if (end > dest->len) break;
    read += cp > 0xffff ? 2 : 1;
    written = end;
  }
  if (written) memcpy(dest->data, text->data, written);
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "read", 4, scr_dyn_new_num((double)read));
  scr_dyn_obj_set(result, "written", 7, scr_dyn_new_num((double)written));
  return result;
}

static ScrBytes *scr_buffer_validation_input(const ScrDyn *input) {
  if ((input->kind == SCR_DYN_BYTES && !input->v.bytes->is_data_view) || scr_buffer_storage_is(input)) {
    return scr_bytes_buffer_source(input);
  }
  scr_dyn_arg_type_fail("input", "an instance of ArrayBuffer, Buffer, or TypedArray", input);
  return NULL;
}

static bool scr_buffer_utf8_valid(const uint8_t *data, size_t len) {
  size_t next;
  return scr_bytes_utf8_prefix(data, len, &next) == len;
}

bool scr_buffer_is_ascii(const ScrDyn *input) {
  ScrBytes *bytes = scr_buffer_validation_input(input);
  if (!bytes) return false;
  SCR_SHARED_GUARD(bytes, NULL);
  bool result = scr_bytes_ascii_prefix(bytes->data, bytes->len) == bytes->len;
  scr_bytes_release(bytes);
  return result;
}

bool scr_buffer_is_utf8(const ScrDyn *input) {
  ScrBytes *bytes = scr_buffer_validation_input(input);
  if (!bytes) return false;
  SCR_SHARED_GUARD(bytes, NULL);
  bool result = scr_buffer_utf8_valid(bytes->data, bytes->len);
  scr_bytes_release(bytes);
  return result;
}

/* Node's ICU wrapper recognizes Buffer encoding aliases. Empty inputs return
 * before resolving either encoding. The four actual converter families are
 * implemented here without adding an ICU dependency to a native binary. */
enum { SCR_TC_UTF8, SCR_TC_ASCII, SCR_TC_LATIN1, SCR_TC_UTF16 };

static int scr_transcode_encoding(const ScrDyn *value) {
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF ||
      (value->kind == SCR_DYN_STR && value->v.str->len == 0)) return SCR_TC_UTF8;
  if (value->kind != SCR_DYN_STR) return -1;
  const ScrStr *name = value->v.str;
  static const struct { const char *name; int encoding; } aliases[] = {
    {"utf8", SCR_TC_UTF8}, {"utf-8", SCR_TC_UTF8}, {"ascii", SCR_TC_ASCII},
    {"latin1", SCR_TC_LATIN1}, {"binary", SCR_TC_LATIN1},
    {"utf16le", SCR_TC_UTF16}, {"utf-16le", SCR_TC_UTF16},
    {"ucs2", SCR_TC_UTF16}, {"ucs-2", SCR_TC_UTF16},
  };
  for (size_t i = 0; i < sizeof aliases / sizeof aliases[0]; i++) {
    if (strlen(aliases[i].name) != name->len) continue;
    bool match = true;
    for (size_t j = 0; j < name->len; j++) {
      unsigned char c = (unsigned char)name->data[j];
      if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
      if (c != (unsigned char)aliases[i].name[j]) { match = false; break; }
    }
    if (match) return aliases[i].encoding;
  }
  return -1;
}

static ScrBytes *scr_transcode_error(bool invalid_data) {
  const char *code = invalid_data ? "U_INVALID_CHAR_FOUND" : "U_ILLEGAL_ARGUMENT_ERROR";
  char message[100];
  int length = snprintf(message, sizeof message, "Unable to transcode Buffer [%s]", code);
  ScrStr *text = scr_str_new(message, (size_t)length);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_code(error, code);
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  return NULL;
}

/* ICU's pinned substitute callback skips unmappable default-ignorable code
 * points. Mappable Latin-1 characters (including soft hyphen) still survive. */
static bool scr_transcode_ignorable(uint32_t cp) {
  return cp == 0xad || cp == 0x34f || cp == 0x61c || cp == 0x115f || cp == 0x1160 ||
    (cp >= 0x17b4 && cp <= 0x17b5) || (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) || cp == 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || cp == 0xfeff || cp == 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfff8) || (cp >= 0x1bca0 && cp <= 0x1bca3) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff);
}

static size_t scr_transcode_put(uint8_t *out, size_t index, uint32_t cp, int encoding) {
  if (encoding == SCR_TC_ASCII || encoding == SCR_TC_LATIN1) {
    unsigned limit = encoding == SCR_TC_ASCII ? 0x7f : 0xff;
    if (cp <= limit) out[index++] = (uint8_t)cp;
    else if (!scr_transcode_ignorable(cp)) out[index++] = '?';
  } else if (encoding == SCR_TC_UTF16) {
    if (cp > 0xffff) {
      uint32_t high = 0xd800 + ((cp - 0x10000) >> 10);
      out[index++] = (uint8_t)high;
      out[index++] = (uint8_t)(high >> 8);
      cp = 0xdc00 + ((cp - 0x10000) & 0x3ff);
    }
    out[index++] = (uint8_t)cp;
    out[index++] = (uint8_t)(cp >> 8);
  } else if (cp < 0x80) out[index++] = (uint8_t)cp;
  else if (cp < 0x800) {
    out[index++] = 0xc0 | (cp >> 6); out[index++] = 0x80 | (cp & 63);
  } else if (cp < 0x10000) {
    out[index++] = 0xe0 | (cp >> 12); out[index++] = 0x80 | ((cp >> 6) & 63); out[index++] = 0x80 | (cp & 63);
  } else {
    out[index++] = 0xf0 | (cp >> 18); out[index++] = 0x80 | ((cp >> 12) & 63);
    out[index++] = 0x80 | ((cp >> 6) & 63); out[index++] = 0x80 | (cp & 63);
  }
  return index;
}

ScrBytes *scr_buffer_transcode(const ScrDyn *source, const ScrDyn *from, const ScrDyn *to) {
  if (source->kind != SCR_DYN_BYTES || source->v.bytes->elem != SCR_BYTES_U8 || source->v.bytes->is_data_view) {
    scr_dyn_arg_type_fail("source", "an instance of Buffer or Uint8Array", source);
    return NULL;
  }
  const ScrBytes *input = source->v.bytes;
  SCR_BYTES_SNAPSHOT(input);
  size_t len = input->len;
  if (!len) { ScrBytes *empty = scr_bytes_alloc(SCR_BYTES_U8, 0); empty->is_buffer = true; return empty; }
  int from_encoding = scr_transcode_encoding(from), to_encoding = scr_transcode_encoding(to);
  if (from_encoding < 0 || to_encoding < 0) return scr_transcode_error(false);
  if (len > (SIZE_MAX - 4) / 4) scr_bytes_oom();
  ScrBytes *result = scr_bytes_alloc(SCR_BYTES_U8, len * 4 + 4);
  result->is_buffer = true;
  size_t written = 0;
  if (from_encoding == SCR_TC_UTF8) {
    if (to_encoding == SCR_TC_UTF16 && !scr_buffer_utf8_valid(input->data, len)) {
      scr_bytes_release(result); return scr_transcode_error(true);
    }
    ScrStr *text = scr_str_from_utf8_lossy(input->data, len);
    for (size_t i = 0; i < text->len;) {
      uint32_t cp = scr_bytes_next_cp((const uint8_t *)text->data, &i);
      written = scr_transcode_put(result->data, written, cp, to_encoding);
    }
    scr_str_release(text);
  } else if (from_encoding == SCR_TC_UTF16) {
    size_t end = to_encoding == SCR_TC_UTF16 ? len : len & ~(size_t)1;
    if (to_encoding == SCR_TC_UTF8 && end == 0) { scr_bytes_release(result); return scr_transcode_error(true); }
    for (size_t i = 0; i < end;) {
      uint32_t cp = 0xfffd;
      bool invalid = false;
      if (i + 1 < end) {
        cp = input->data[i] | ((uint32_t)input->data[i + 1] << 8);
        i += 2;
        if (cp >= 0xd800 && cp <= 0xdbff) {
          uint32_t next = i + 1 < end ? input->data[i] | ((uint32_t)input->data[i + 1] << 8) : 0;
          if (next >= 0xdc00 && next <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + next - 0xdc00; i += 2; }
          else { cp = 0xfffd; invalid = true; }
        } else if (cp >= 0xdc00 && cp <= 0xdfff) { cp = 0xfffd; invalid = true; }
      } else { i++; invalid = true; }
      if (invalid && to_encoding == SCR_TC_UTF8) { scr_bytes_release(result); return scr_transcode_error(true); }
      written = scr_transcode_put(result->data, written, cp, to_encoding);
    }
  } else {
    for (size_t i = 0; i < len; i++) {
      uint32_t cp = input->data[i];
      if (from_encoding == SCR_TC_ASCII && cp > 0x7f && to_encoding != SCR_TC_UTF16) cp = 0xfffd;
      written = scr_transcode_put(result->data, written, cp, to_encoding);
    }
  }
  result->len = written;
  return result;
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
/* Consume one scalar, replacing an unpaired surrogate at the storage boundary. */
static uint32_t scr_bytes_utf16le_cp(const uint8_t *in, size_t units, size_t *u) {
  uint32_t cu = (uint32_t)in[*u * 2] | ((uint32_t)in[*u * 2 + 1] << 8);
  (*u)++;
  if (cu >= 0xd800 && cu <= 0xdbff && *u < units) {
    uint32_t lo = (uint32_t)in[*u * 2] | ((uint32_t)in[*u * 2 + 1] << 8);
    if (lo >= 0xdc00 && lo <= 0xdfff) {
      (*u)++;
      return 0x10000 + ((cu - 0xd800) << 10) + (lo - 0xdc00);
    }
  }
  return cu >= 0xd800 && cu <= 0xdfff ? 0xfffd : cu;
}

static ScrStr *scr_bytes_decode_utf16le(const uint8_t *in, size_t n) {
  size_t units = n / 2;
  if (units > SIZE_MAX / 3) scr_bytes_oom();
  ScrStr *s = scr_str_alloc_raw(0, units * 3);
  size_t o = 0;
  for (size_t u = 0; u < units;) o = scr_bytes_put_cp(s->data, o, scr_bytes_utf16le_cp(in, units, &u));
  s->len = o;
  s->data[o] = '\0';
  return s;
}

ScrStr *scr_bytes_to_str(const ScrBytes *b, const ScrStr *enc) {
  SCR_SHARED_GUARD(b, NULL);
  const uint8_t *in = b->data;
  size_t n = b->len; /* u8: len == byte length */
  /* Implicit native string/number coercions have no encoding argument. */
  if (!enc) return scr_bytes_decode_utf8(in, n);
  if (scr_enc_is(enc, "hex")) {
    if (n > SIZE_MAX / 2) scr_bytes_oom();
    ScrStr *s = scr_str_alloc_raw(n * 2, n * 2);
    char *out = s->data;
    for (size_t i = 0; i < n; i++) {
      out[i * 2] = scr_hex_digits[in[i] >> 4];
      out[i * 2 + 1] = scr_hex_digits[in[i] & 0xf];
    }
    out[n * 2] = '\0';
    return s;
  }
  if (scr_enc_is(enc, "base64")) return scr_bytes_encode_b64(in, n, false);
  if (scr_enc_is(enc, "base64url")) return scr_bytes_encode_b64(in, n, true);
  if (scr_enc_is(enc, "latin1")) {
    /* Each byte is U+00XX ("binary" normalizes here upstream). */
    size_t high = 0;
    for (size_t i = 0; i < n; i++) high += in[i] >> 7;
    if (n > SIZE_MAX - high) scr_bytes_oom();
    ScrStr *s = scr_str_alloc_raw(n + high, n + high);
    size_t o = 0;
    for (size_t i = 0; i < n; i++) o = scr_bytes_put_cp(s->data, o, in[i]);
    s->data[o] = '\0';
    return s;
  }
  if (scr_enc_is(enc, "ascii")) {
    /* Node's ascii decode masks the high bit: byte & 0x7f. */
    ScrStr *s = scr_str_alloc_raw(n, n);
    for (size_t i = 0; i < n; i++) s->data[i] = (char)(in[i] & 0x7f);
    s->data[n] = '\0';
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

/* Both alphabets are accepted by both Buffer base64 encoding names. */
static const int8_t scr_b64_values[256] = {
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, 62, -1, 63,
  52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1,
  -1,  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14,
  15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1, -1, 63,
  -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
};

/* Conversion destinations are private until their initialized length is set.
 * General typed-array allocation must remain zero-filled. */
static ScrBytes *scr_bytes_conversion_storage(size_t capacity) {
  uint8_t *data = malloc(capacity ? capacity : 1);
  if (!data) scr_bytes_oom();
  return scr_bytes_take_data(data, 0);
}

static ScrBytes *scr_bytes_decode_b64(const uint8_t *in, size_t n) {
  ScrBytes *b = scr_bytes_conversion_storage(n / 4 * 3 + 2);
  size_t i = 0, o = 0;
  unsigned acc = 0, have = 0;
  while (i < n) {
    /* Common complete groups need neither per-character branches nor state. */
    if (have == 0 && n - i >= 4) {
      int a = scr_b64_values[in[i]], c = scr_b64_values[in[i + 1]];
      int d = scr_b64_values[in[i + 2]], e = scr_b64_values[in[i + 3]];
      if ((a | c | d | e) >= 0) {
        unsigned v = ((unsigned)a << 18) | ((unsigned)c << 12) | ((unsigned)d << 6) | (unsigned)e;
        b->data[o++] = (uint8_t)(v >> 16);
        b->data[o++] = (uint8_t)(v >> 8);
        b->data[o++] = (uint8_t)v;
        i += 4;
        continue;
      }
    }
    uint8_t byte = in[i++];
    if (byte == '=') break;
    int v = scr_b64_values[byte];
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

ScrBytes *scr_bytes_from_str(const ScrStr *s, const ScrStr *enc) {
  const uint8_t *in = (const uint8_t *)s->data;
  size_t n = s->len;
  if (scr_enc_is(enc, "latin1") || scr_enc_is(enc, "ascii")) {
    /* Node writes charCodeAt(i) & 0xFF for BOTH spellings — an astral
     * code point contributes its two surrogates' low bytes. */
    ScrBytes *b = scr_bytes_conversion_storage(n);
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
    if (n > SIZE_MAX / 2) scr_bytes_oom();
    ScrBytes *b = scr_bytes_conversion_storage(n * 2);
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
  bool hex = scr_enc_is(enc, "hex");
  if (hex || scr_enc_is(enc, "base64") || scr_enc_is(enc, "base64url")) {
    /* Node interprets encoded text as the low byte of each UTF-16 unit.
     * ASCII can borrow storage; non-ASCII must preserve that truncation. */
    ScrBytes *narrowed = NULL;
    if (scr_bytes_ascii_prefix(in, n) != n) {
      ScrStr *latin1 = scr_str_new("latin1", 6);
      narrowed = scr_bytes_from_str(s, latin1);
      scr_str_release(latin1);
      in = narrowed->data;
      n = narrowed->len;
    }
    ScrBytes *b;
    if (hex) {
      /* Stop at the first invalid pair, discarding an odd tail. */
      b = scr_bytes_conversion_storage(n / 2);
      size_t o = 0;
      for (size_t i = 0; i + 1 < n; i += 2) {
        int hi = scr_hex_val(in[i]), lo = scr_hex_val(in[i + 1]);
        if (hi < 0 || lo < 0) break;
        b->data[o++] = (uint8_t)((hi << 4) | lo);
      }
      b->len = o;
    } else {
      b = scr_bytes_decode_b64(in, n);
    }
    scr_bytes_release(narrowed);
    return b;
  }
  /* utf8: ScrStr storage IS the bytes */
  ScrBytes *b = scr_bytes_conversion_storage(n);
  memcpy(b->data, in, n);
  b->len = n;
  return b;
}

/* Runtime encoding variables share the output conversion alias/error table.
 * Buffer.from treats an empty encoding as utf8, even for an empty source. */
ScrBytes *scr_bytes_from_str_checked(const ScrStr *s, const ScrStr *enc) {
  ScrStr *normalized = enc->len ? scr_bytes_normalize_encoding(enc) : scr_str_new("utf8", 4);
  if (!normalized) return NULL;
  ScrBytes *out = scr_bytes_from_str(s, normalized);
  scr_str_release(normalized);
  return out;
}

ScrBytes *scr_bytes_from_arr(ScrBytesElem elem, const ScrArr *arr) {
  ScrBytes *b = scr_bytes_alloc_private(elem, arr->len);
  size_t width = scr_bytes_elem_size(elem);
  double values[128];
  for (size_t start = 0; start < arr->len;) {
    size_t count = arr->len - start < 128 ? arr->len - start : 128;
    for (size_t i = 0; i < count; i++) {
      size_t index = start + i;
      /* Sparse tails and explicit undefined retain ordinary iteration
       * semantics. Numeric array slots own no conversion callbacks. */
      if (index < arr->cap) {
        if (arr->present[index] == SCR_ARR_VALUE)
          memcpy(&values[i], &arr->data[index], sizeof(double));
        else values[i] = NAN;
      } else values[i] = scr_arr_get_number(arr, (double)index);
    }
    scr_bytes_write_numbers(b->data + start * width, elem, values, count);
    start += count;
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
  SCR_SHARED_GUARD(a, b);
  return a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
}

/* src.compare(target, targetStart?, targetEnd?, sourceStart?, sourceEnd?)
 * — nargs counts the PRESENT index args (defaults skip validation, like
 * Node). Empty-range shortcuts and the memcmp-with-length-tiebreak are
 * Node's exactly. */
double scr_bytes_compare(const ScrBytes *src, const ScrBytes *target, double nargs,
                         double ts, double te, double ss, double se) {
  SCR_SHARED_GUARD(src, target);
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
  SCR_SHARED_GUARD(b, needle);
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
  SCR_SHARED_GUARD(b, NULL);
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
  SCR_SHARED_GUARD(b, pattern);
  return scr_bytes_fill_core(b, pattern->data, pattern->len, false, nargs, offset, end);
}

ScrBytes *scr_bytes_fill_num(ScrBytes *b, double v, double nargs, double offset, double end) {
  SCR_SHARED_GUARD(b, NULL);
  uint8_t byte = (uint8_t)scr_bytes_to_u32(v);
  return scr_bytes_fill_core(b, &byte, 1, false, nargs, offset, end);
}

ScrBytes *scr_bytes_fill_str(ScrBytes *b, const ScrStr *s, const ScrStr *enc,
                             double nargs, double offset, double end) {
  SCR_SHARED_GUARD(b, NULL);
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
  SCR_SHARED_GUARD(src, dst);
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
  SCR_SHARED_GUARD(b, NULL);
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
  SCR_SHARED_GUARD(b, NULL);
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
  /* UTF-8 already has its final representation. Copy only the requested
   * prefix, backing off when the destination ends inside a scalar. */
  if (scr_enc_is(enc, "utf8")) {
    size_t k = s->len < budget ? s->len : budget;
    if (k < s->len) {
      while (k > 0 && ((uint8_t)s->data[k] & 0xc0) == 0x80) k--;
    }
    if (k) memcpy(b->data + o, s->data, k);
    return (double)k;
  }
  bool utf16 = scr_enc_is(enc, "utf16le");
  if (utf16 || scr_enc_is(enc, "latin1") || scr_enc_is(enc, "ascii")) {
    size_t i = 0, written = 0, width = utf16 ? 2 : 1;
    while (i < s->len && budget - written >= width) {
      uint32_t cp = scr_bytes_next_cp((const uint8_t *)s->data, &i);
      uint32_t first = cp, second = 0;
      if (cp > 0xffff) {
        cp -= 0x10000;
        first = 0xd800 + (cp >> 10);
        second = 0xdc00 + (cp & 0x3ff);
      }
      b->data[o + written++] = (uint8_t)first;
      if (utf16) b->data[o + written++] = (uint8_t)(first >> 8);
      if (second && budget - written >= width) {
        b->data[o + written++] = (uint8_t)second;
        if (utf16) b->data[o + written++] = (uint8_t)(second >> 8);
      }
    }
    return (double)written;
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
static ScrBytes *scr_bytes_concat_item(const ScrArr *list, size_t i) {
  if (!scr_arr_has(list, (double)i)) {
    char msg[160];
    int n = snprintf(
        msg, sizeof msg,
        "The \"list[%zu]\" argument must be an instance of Buffer or Uint8Array. Received undefined",
        i);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, n < 0 ? 0 : (size_t)n,
                             "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  ScrBytes *part = (ScrBytes *)scr_arr_get_ref((ScrArr *)list, (double)i);
  if (!part) {
    char msg[160];
    int n = snprintf(
        msg, sizeof msg,
        "The \"list[%zu]\" argument must be an instance of Buffer or Uint8Array. Received undefined",
        i);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, n < 0 ? 0 : (size_t)n,
                             "ERR_INVALID_ARG_TYPE");
  }
  return part;
}

ScrBytes *scr_bytes_concat_len(const ScrArr *list, double total) {
  /* An empty list short-circuits BEFORE the total validates — Node's
   * own `if (list.length === 0) return new FastBuffer()`. */
  if (list->len == 0) return scr_bytes_alloc(SCR_BYTES_U8, 0);
  if (!scr_bytes_validate_off("length", total, 9007199254740991.0)) return NULL;
  ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, (size_t)total);
  size_t o = 0;
  for (size_t i = 0; i < list->len && o < b->len; i++) {
    ScrBytes *part = scr_bytes_concat_item(list, i);
    if (!part) {
      scr_bytes_release(b);
      return NULL;
    }
    size_t take = part->len < b->len - o ? part->len : b->len - o;
    scr_bytes_read(part, 0, b->data + o, take);
    o += take;
    scr_bytes_release(part);
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
    ScrBytes *part = scr_bytes_concat_item(list, i);
    if (!part) return NULL;
    total += part->len;
    scr_bytes_release(part);
  }
  ScrBytes *b = scr_bytes_alloc(SCR_BYTES_U8, total);
  size_t o = 0;
  for (size_t i = 0; i < list->len; i++) {
    ScrBytes *part = scr_bytes_concat_item(list, i);
    if (!part) {
      scr_bytes_release(b);
      return NULL;
    }
    scr_bytes_read(part, 0, b->data + o, part->len);
    o += part->len;
    scr_bytes_release(part);
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
  SCR_SHARED_GUARD(b, NULL);
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
  SCR_SHARED_GUARD(b, NULL);
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
  SCR_SHARED_GUARD(b, NULL);
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
  SCR_SHARED_GUARD(b, NULL);
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

bool scr_bytes_read_u64_raw(const ScrBytes *b, double offset, bool le, uint64_t *out) {
  SCR_SHARED_GUARD(b, NULL);
  if (!scr_bytes_rw_check(b, offset, 8)) return false;
  const uint8_t *p = b->data + (size_t)offset;
  uint64_t value = 0;
  for (size_t i = 0; i < 8; i++) value |= (uint64_t)p[le ? i : 7 - i] << (8 * i);
  *out = value;
  return true;
}

bool scr_bytes_write_u64_raw(ScrBytes *b, double offset, bool le, uint64_t value) {
  SCR_SHARED_GUARD(b, NULL);
  if (!scr_bytes_rw_check(b, offset, 8)) return false;
  uint8_t *p = b->data + (size_t)offset;
  for (size_t i = 0; i < 8; i++) p[le ? i : 7 - i] = (uint8_t)(value >> (8 * i));
  return true;
}

static bool scr_dataview_u64_check(const ScrBytes *b, double byte_off) {
  double off = (byte_off != byte_off) ? 0 : trunc(byte_off);
  if (!(off >= 0) || off > 9007199254740991.0 || off + 8 > (double)b->len) {
    static const char msg[] = "Offset is outside the bounds of the DataView";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return false;
  }
  return true;
}

bool scr_dataview_read_u64_raw(const ScrBytes *b, double offset, bool le, uint64_t *out) {
  SCR_SHARED_GUARD(b, NULL);
  double off = (offset != offset) ? 0 : trunc(offset);
  if (!scr_dataview_u64_check(b, offset)) return false;
  const uint8_t *p = b->data + (size_t)off;
  uint64_t value = 0;
  for (size_t i = 0; i < 8; i++) value |= (uint64_t)p[le ? i : 7 - i] << (8 * i);
  *out = value;
  return true;
}

bool scr_dataview_write_u64_raw(ScrBytes *b, double offset, bool le, uint64_t value) {
  SCR_SHARED_GUARD(b, NULL);
  double off = (offset != offset) ? 0 : trunc(offset);
  if (!scr_dataview_u64_check(b, offset)) return false;
  uint8_t *p = b->data + (size_t)off;
  for (size_t i = 0; i < 8; i++) p[le ? i : 7 - i] = (uint8_t)(value >> (8 * i));
  return true;
}

ScrArr *scr_bytes_to_arr(const ScrBytes *b) {
  ScrArr *out = scr_arr_new(SCR_ELEM_F64, b->len ? b->len : 1);
  for (size_t i = 0; i < b->len; i++) {
    scr_arr_push_f64(out, scr_bytes_get(b, (double)i));
  }
  return out;
}

ScrStr *scr_bytes_join(const ScrBytes *b, const ScrStr *separator) {
  ScrArr *values = scr_bytes_to_arr(b);
  ScrStr *out = scr_arr_join(values, (ScrStr *)separator);
  scr_arr_release(values);
  return out;
}
