/* The Buffer.prototype methods of a Buffer held as a checked-dynamic value:
 * a JavaScript dependency's `buf.writeUInt32LE(v, 0)` on a buffer it got back
 * untyped (yazl), or `this.buf.write(s)` on a buffer a constructor function
 * stored. The compiler routes only the dyn method calls that name one of
 * these methods here, so programs without them link nothing new; any other
 * receiver takes the ordinary dispatch. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static const struct {
  const char *name;
  ScrBytesNumKind kind;
  bool le;
} scr_bytes_dyn_names[] = {
  { "UInt8", SCR_BN_U8, false },     { "Uint8", SCR_BN_U8, false },
  { "Int8", SCR_BN_I8, false },      { "UInt16LE", SCR_BN_U16, true },
  { "Uint16LE", SCR_BN_U16, true },  { "UInt16BE", SCR_BN_U16, false },
  { "Uint16BE", SCR_BN_U16, false }, { "Int16LE", SCR_BN_I16, true },
  { "Int16BE", SCR_BN_I16, false },  { "UInt32LE", SCR_BN_U32, true },
  { "Uint32LE", SCR_BN_U32, true },  { "UInt32BE", SCR_BN_U32, false },
  { "Uint32BE", SCR_BN_U32, false }, { "Int32LE", SCR_BN_I32, true },
  { "Int32BE", SCR_BN_I32, false },  { "FloatLE", SCR_BN_F32, true },
  { "FloatBE", SCR_BN_F32, false },  { "DoubleLE", SCR_BN_F64, true },
  { "DoubleBE", SCR_BN_F64, false },
};

static size_t scr_bytes_dyn_width(ScrBytesNumKind kind) {
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
      return 4;
  }
}

/* Node's checkInt range test and message, before the offset is looked at:
 * widths past 4 bytes render the "2 ** N" range form. */
static bool scr_bytes_dyn_value_in_range(double value, size_t width, bool sign) {
  double max = sign ? ldexp(1.0, (int)(8 * width - 1)) - 1 : ldexp(1.0, (int)(8 * width)) - 1;
  double min = sign ? -ldexp(1.0, (int)(8 * width - 1)) : 0;
  if (!(value > max || value < min)) return true;
  char recv[48];
  scr_num_received(value, recv);
  char msg[160];
  int mlen;
  if (width > 4 && sign) {
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"value\" is out of range. It must be >= -(2 ** %zu) and < 2 ** %zu. Received %s",
                    8 * width - 1, 8 * width - 1, recv);
  } else if (width > 4) {
    mlen = snprintf(msg, sizeof msg, "The value of \"value\" is out of range. It must be >= 0 and < 2 ** %zu. Received %s",
                    8 * width, recv);
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

/* Node's order: a write converts the value with ToNumber and checks its
 * range, then the offset must be a number (absent means 0), then the
 * bounds. +1, or NULL with the exception pending. */
static ScrDyn *scr_bytes_dyn_num_method(ScrBytes *b, bool read, size_t at, ScrDyn *const *args,
                                        size_t argc) {
  ScrBytesNumKind kind = scr_bytes_dyn_names[at].kind;
  double value = 0;
  if (!read) {
    if (!scr_dyn_number_coerce_js(argc > 0 ? args[0] : scr_dyn_undefined(), &value)) return NULL;
    if (kind != SCR_BN_F32 && kind != SCR_BN_F64) {
      bool sign = kind == SCR_BN_I8 || kind == SCR_BN_I16 || kind == SCR_BN_I32;
      if (!scr_bytes_dyn_value_in_range(value, scr_bytes_dyn_width(kind), sign)) return NULL;
    }
  }
  size_t offset_at = read ? 0 : 1;
  double offset = 0;
  if (argc > offset_at && args[offset_at]->kind != SCR_DYN_UNDEF) {
    if (args[offset_at]->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("offset", "of type number", args[offset_at]);
      return NULL;
    }
    offset = args[offset_at]->v.num;
  }
  bool le = scr_bytes_dyn_names[at].le;
  double out = read ? scr_bytes_read_num(b, offset, kind, le) : scr_bytes_write_num(b, value, offset, kind, le);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(out);
}

static const ScrDyn *scr_bytes_dyn_arg(ScrDyn *const *args, size_t argc, size_t i) {
  return i < argc ? args[i] : scr_dyn_undefined();
}

static bool scr_bytes_dyn_undef(const ScrDyn *d) { return d->kind == SCR_DYN_UNDEF; }

static ScrDyn *scr_bytes_dyn_str(const char *text, size_t len) {
  ScrStr *s = scr_str_new(text, len);
  ScrDyn *out = scr_dyn_new_str(s);
  scr_str_release(s);
  return out;
}

/* Node's validateOffset: a number (ERR_INVALID_ARG_TYPE otherwise), then an
 * integer in [0, max] (ERR_OUT_OF_RANGE). */
static bool scr_bytes_dyn_offset(const ScrDyn *v, const char *name, double max, double *out) {
  if (v->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", v);
    return false;
  }
  if (!scr_bytes_validate_off(name, v->v.num, max)) return false;
  *out = v->v.num;
  return true;
}

/* getEncodingOps over an argument: ToString (`encoding += ''`), then the
 * canonical name in any ASCII case. +1, or NULL with the exception pending. */
static ScrStr *scr_bytes_dyn_encoding(const ScrDyn *v) {
  ScrStr *raw = scr_dyn_string_coerce_js(v);
  if (!raw) return NULL;
  ScrStr *out = scr_bytes_normalize_encoding(raw);
  scr_str_release(raw);
  return out;
}

/* Node's toInteger(n, 0) for copy's offsets: an integer stays, other finite
 * numbers in the safe range floor, everything else (NaN, ±Infinity) is 0. */
static bool scr_bytes_dyn_to_integer(const ScrDyn *v, double *out) {
  double n;
  if (!scr_dyn_number_coerce_js(v, &n)) return false;
  *out = n == n && n >= -9007199254740991.0 && n <= 9007199254740991.0 ? floor(n) : 0;
  return true;
}

/* buf.write(string[, offset[, length]][, encoding]): buffer.js's overload
 * resolution and offset checks, then the encoding, then the string type. */
static ScrDyn *scr_bytes_dyn_write(ScrBytes *b, ScrDyn *const *args, size_t argc) {
  const ScrDyn *string = scr_bytes_dyn_arg(args, argc, 0);
  const ScrDyn *offset = scr_bytes_dyn_arg(args, argc, 1);
  const ScrDyn *length = scr_bytes_dyn_arg(args, argc, 2);
  const ScrDyn *encoding = scr_bytes_dyn_arg(args, argc, 3);
  double at = 0, budget = (double)b->len;
  ScrStr *enc = NULL;
  if (scr_bytes_dyn_undef(offset)) {
    encoding = scr_dyn_undefined();
  } else if (scr_bytes_dyn_undef(length) && offset->kind == SCR_DYN_STR) {
    encoding = offset;
  } else {
    if (!scr_bytes_dyn_offset(offset, "offset", (double)b->len, &at)) return NULL;
    budget = (double)b->len - at;
    if (length->kind == SCR_DYN_STR) {
      encoding = length;
    } else if (!scr_bytes_dyn_undef(length)) {
      double n;
      if (!scr_bytes_dyn_offset(length, "length", (double)b->len, &n)) return NULL;
      if (n < budget) budget = n;
    }
  }
  if (!scr_dyn_truthy(encoding)) {
    enc = scr_str_new("utf8", 4);
  } else {
    enc = scr_bytes_dyn_encoding(encoding);
    if (!enc) return NULL;
  }
  if (string->kind != SCR_DYN_STR) {
    scr_str_release(enc);
    static const char message[] = "argument must be a string";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  double written = scr_bytes_write_str(b, string->v.str, enc, at, budget, true);
  scr_str_release(enc);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(written);
}

/* Node's inspect quoting for the ERR_INVALID_ARG_VALUE render of a string:
 * single quotes unless the text has one, then double, then backticks. */
static ScrStr *scr_bytes_dyn_quoted(const ScrStr *text) {
  char quote = '\'';
  if (memchr(text->data, '\'', text->len)) quote = memchr(text->data, '"', text->len) ? '`' : '"';
  ScrJsonBuf jb;
  scr_jb_init(&jb);
  scr_jb_puts(&jb, "The argument 'value' is invalid. Received ");
  scr_jb_putc(&jb, quote);
  scr_jb_put_str(&jb, text);
  scr_jb_putc(&jb, quote);
  return scr_jb_finish(&jb);
}

/* Appends Node's inspect of an ArrayBuffer at indentation level `indent`:
 * the first 100 bytes as hex pairs, on one line when it fits the 80-column
 * break length (reduceToSingleString), one entry per line otherwise. */
static void scr_bytes_dyn_inspect_array_buffer(ScrJsonBuf *jb, const ScrBytes *owner, size_t indent) {
  static const char digits[] = "0123456789abcdef";
  size_t len = owner->len * scr_bytes_elem_size(owner->elem);
  size_t shown = len < 100 ? len : 100;
  ScrJsonBuf contents;
  scr_jb_init(&contents);
  scr_jb_puts(&contents, "[Uint8Contents]: <");
  for (size_t i = 0; i < shown; i++) {
    uint8_t byte;
    scr_bytes_read(owner, i, &byte, 1);
    if (i) scr_jb_putc(&contents, ' ');
    scr_jb_putc(&contents, digits[byte >> 4]);
    scr_jb_putc(&contents, digits[byte & 15]);
  }
  if (len > shown) {
    char more[48];
    snprintf(more, sizeof more, " ... %zu more byte%s", len - shown, len - shown > 1 ? "s" : "");
    scr_jb_puts(&contents, more);
  }
  scr_jb_putc(&contents, '>');
  ScrStr *first = scr_jb_finish(&contents);
  char second[40];
  int second_len = snprintf(second, sizeof second, "[byteLength]: %zu", len);
  /* isBelowBreakLength with two entries, start = 2 + indentation + "ArrayBuffer {" + 10. */
  size_t total = 2 + (2 + indent + 13 + 10) + first->len + (size_t)second_len;
  if (total <= 80) {
    scr_jb_puts(jb, "ArrayBuffer { ");
    scr_jb_put_str(jb, first);
    scr_jb_puts(jb, ", ");
    scr_jb_puts(jb, second);
    scr_jb_puts(jb, " }");
  } else {
    scr_jb_puts(jb, "ArrayBuffer {\n");
    for (size_t i = 0; i < indent + 2; i++) scr_jb_putc(jb, ' ');
    scr_jb_put_str(jb, first);
    scr_jb_puts(jb, ",\n");
    for (size_t i = 0; i < indent + 2; i++) scr_jb_putc(jb, ' ');
    scr_jb_puts(jb, second);
    scr_jb_putc(jb, '\n');
    for (size_t i = 0; i < indent; i++) scr_jb_putc(jb, ' ');
    scr_jb_putc(jb, '}');
  }
  scr_str_release(first);
}

/* ERR_INVALID_ARG_VALUE for an empty ArrayBufferView fill value: Node's
 * inspect of the view (a Buffer, an empty typed array, or a DataView with
 * its buffer), cut to 128 characters followed by "...". */
static ScrStr *scr_bytes_dyn_empty_view_message(const ScrDyn *value) {
  const ScrBytes *view = value->v.bytes;
  ScrJsonBuf jb;
  scr_jb_init(&jb);
  if (value->buffer) {
    scr_jb_puts(&jb, "<Buffer >");
  } else if (!view->is_data_view) {
    scr_jb_puts(&jb, scr_bytes_elem_name(view->elem));
    scr_jb_puts(&jb, "(0) []");
  } else {
    const ScrBytes *owner = view->backing ? view->backing : view;
    char line[64];
    snprintf(line, sizeof line, "DataView {\n  [byteLength]: 0,\n  [byteOffset]: %zu,\n  [buffer]: ",
             (size_t)(view->data - owner->data));
    scr_jb_puts(&jb, line);
    scr_bytes_dyn_inspect_array_buffer(&jb, owner, 2);
    scr_jb_puts(&jb, "\n}");
  }
  ScrStr *inspected = scr_jb_finish(&jb);
  ScrJsonBuf out;
  scr_jb_init(&out);
  scr_jb_puts(&out, "The argument 'value' is invalid. Received ");
  if (inspected->len > 128) {
    ScrStr *head = scr_str_new(inspected->data, 128);
    scr_jb_put_str(&out, head);
    scr_str_release(head);
    scr_jb_puts(&out, "...");
  } else {
    scr_jb_put_str(&out, inspected);
  }
  scr_str_release(inspected);
  return scr_jb_finish(&out);
}

/* buf.fill(value[, offset[, end]][, encoding]): buffer.js's _fill. A string
 * takes its encoding from the first string among offset and end; numbers and
 * other non-view values fill with ToUint32(value) & 255. Answers the receiver. */
static ScrDyn *scr_bytes_dyn_fill(ScrDyn *recv, ScrDyn *const *args, size_t argc) {
  ScrBytes *b = recv->v.bytes;
  const ScrDyn *value = scr_bytes_dyn_arg(args, argc, 0);
  const ScrDyn *offset = scr_bytes_dyn_arg(args, argc, 1);
  const ScrDyn *end = scr_bytes_dyn_arg(args, argc, 2);
  ScrStr *enc = NULL;
  bool whole = false;
  if (value->kind == SCR_DYN_STR) {
    const ScrDyn *encoding = scr_bytes_dyn_arg(args, argc, 3);
    if (scr_bytes_dyn_undef(offset) || offset->kind == SCR_DYN_STR) {
      encoding = offset;
      whole = true;
    } else if (end->kind == SCR_DYN_STR) {
      encoding = end;
      end = scr_dyn_undefined();
    }
    if (encoding->kind == SCR_DYN_UNDEF || encoding->kind == SCR_DYN_NULL ||
        (encoding->kind == SCR_DYN_STR && encoding->v.str->len == 0)) {
      enc = scr_str_new("utf8", 4);
    } else if (encoding->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("encoding", "of type string", encoding);
      return NULL;
    } else {
      enc = scr_bytes_normalize_encoding(encoding->v.str);
      if (!enc) return NULL;
    }
  }
  double from = 0, to = (double)b->len;
  if (!whole && !scr_bytes_dyn_undef(offset)) {
    if (!scr_bytes_dyn_offset(offset, "offset", 9007199254740991.0, &from) ||
        (!scr_bytes_dyn_undef(end) && !scr_bytes_dyn_offset(end, "end", (double)b->len, &to))) {
      scr_str_release(enc);
      return NULL;
    }
    if (from >= to) {
      scr_str_release(enc);
      return scr_dyn_retain(recv);
    }
  }
  ScrBytes *out;
  if (enc) {
    const ScrStr *text = value->v.str;
    ScrBytes *pattern = scr_bytes_from_str(text, enc);
    scr_str_release(enc);
    if (text->len > 0 && pattern->len == 0) {
      scr_bytes_release(pattern);
      ScrStr *message = scr_bytes_dyn_quoted(text);
      scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_VALUE");
      scr_str_release(message);
      return NULL;
    }
    /* An empty string fills with zeros. */
    out = text->len == 0 ? scr_bytes_fill_num(b, 0, 2, from, to) : scr_bytes_fill(b, pattern, 2, from, to);
    scr_bytes_release(pattern);
  } else if (value->kind == SCR_DYN_BYTES) {
    /* Any ArrayBufferView repeats its raw bytes: a byte view over the
     * value's storage (a typed array of wider elements, or a DataView). */
    const ScrBytes *view = value->v.bytes;
    if (view->len == 0) {
      ScrStr *message = scr_bytes_dyn_empty_view_message(value);
      scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_VALUE");
      scr_str_release(message);
      return NULL;
    }
    ScrBytes pattern = { .rc = 1,
                         .len = view->len * scr_bytes_elem_size(view->elem),
                         .elem = SCR_BYTES_U8,
                         .data = view->data,
                         .backing = NULL,
                         .shared = view->shared };
    out = scr_bytes_fill(b, &pattern, 2, from, to);
  } else {
    double n;
    if (!scr_dyn_number_coerce_js(value, &n)) return NULL;
    out = scr_bytes_fill_num(b, n, 2, from, to);
  }
  if (!out) return NULL;
  scr_bytes_release(out);
  return scr_dyn_retain(recv);
}
/* buf.toString(encoding, start, end): the window clamps to [0, length]
 * with NaN as 0 (infinite and out-of-range values included), an empty
 * window answers "" before the encoding resolves, and an undefined encoding
 * is utf8. */
static ScrDyn *scr_bytes_dyn_to_string(ScrBytes *b, ScrDyn *const *args, size_t argc) {
  const ScrDyn *encoding = scr_bytes_dyn_arg(args, argc, 0);
  const ScrDyn *start = scr_bytes_dyn_arg(args, argc, 1);
  const ScrDyn *end = scr_bytes_dyn_arg(args, argc, 2);
  const double len = (double)b->len;
  double from = NAN, to = len;
  if (!scr_bytes_dyn_undef(start) && !scr_dyn_number_coerce_js(start, &from)) return NULL;
  if (!scr_bytes_dyn_undef(end) && !scr_dyn_number_coerce_js(end, &to)) return NULL;
  /* `if (start <= 0) start = 0; else if (start >= len) return ''; else
   * start = MathTrunc(start) || 0`, then `end > len` clamps to the length
   * and other ends truncate (NaN as 0), so both stay within [0, len]. */
  if (from <= 0) from = 0;
  else if (from >= len) return scr_bytes_dyn_str("", 0);
  else from = from == from ? trunc(from) : 0;
  if (to > len) to = len;
  else to = to == to ? trunc(to) : 0;
  if (to <= from) return scr_bytes_dyn_str("", 0);
  ScrStr *enc = scr_bytes_dyn_undef(encoding) ? scr_str_new("utf8", 4) : scr_bytes_dyn_encoding(encoding);
  if (!enc) return NULL;
  ScrStr *text = scr_bytes_to_str_range(b, enc, from, to);
  scr_str_release(enc);
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}

/* buf.toJSON(): { type: 'Buffer', data: [...bytes] }. */
static ScrDyn *scr_bytes_dyn_to_json(const ScrBytes *b) {
  ScrDyn *data = scr_dyn_new_arr();
  for (size_t i = 0; i < b->len; i++) scr_dyn_arr_push(data, scr_dyn_new_num(scr_bytes_get(b, (double)i)));
  ScrDyn *out = scr_dyn_new_obj();
  scr_dyn_obj_set(out, "type", 4, scr_bytes_dyn_str("Buffer", 6));
  scr_dyn_obj_set(out, "data", 4, data);
  return out;
}

/* Whether a bytes view is a Uint8Array or Buffer (not a DataView or a wider
 * typed array). */
static bool scr_bytes_dyn_u8(const ScrBytes *b) { return !b->is_data_view && b->elem == SCR_BYTES_U8; }

/* buf.copy(target[, targetStart[, sourceStart[, sourceEnd]]]): Node's
 * copyImpl offsets (toInteger, then the >= 0 and source-length checks) over
 * the bytes of any ArrayBufferView source and target, so a Uint16Array
 * target receives the bytes packed into its elements. */
static ScrDyn *scr_bytes_dyn_copy(ScrBytes *b, ScrDyn *const *args, size_t argc) {
  const ScrDyn *target = scr_bytes_dyn_arg(args, argc, 0);
  if (target->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("target", "an instance of Buffer or Uint8Array", target);
    return NULL;
  }
  double offsets[3] = { 0, 0, 0 };
  bool given[3] = { false, false, false };
  for (size_t i = 0; i < 3; i++) {
    const ScrDyn *v = scr_bytes_dyn_arg(args, argc, i + 1);
    if (scr_bytes_dyn_undef(v)) continue;
    if (!scr_bytes_dyn_to_integer(v, &offsets[i])) return NULL;
    given[i] = true;
  }
  ScrBytes *source = scr_bytes_dyn_u8(b) ? scr_bytes_retain(b) : scr_bytes_raw_view(b);
  ScrBytes *into = scr_bytes_dyn_u8(target->v.bytes) ? scr_bytes_retain(target->v.bytes) : scr_bytes_raw_view(target->v.bytes);
  if (!given[2]) offsets[2] = (double)source->len;
  double copied = scr_bytes_copy_into(source, into, 3, offsets[0], offsets[1], offsets[2]);
  scr_bytes_release(source);
  scr_bytes_release(into);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(copied);
}

/* Whether an encoding name is one of the utf16le spellings, in any ASCII case. */
static bool scr_bytes_dyn_is_ucs2(const ScrStr *raw) {
  static const char *const names[] = { "utf16le", "utf-16le", "ucs2", "ucs-2" };
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    size_t n = strlen(names[i]);
    if (raw->len != n) continue;
    size_t k = 0;
    for (; k < n; k++) {
      char c = raw->data[k];
      if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
      if (c != names[i][k]) break;
    }
    if (k == n) return true;
  }
  return false;
}

/* buf.indexOf/lastIndexOf/includes(value[, byteOffset][, encoding]):
 * buffer.js's bidirectionalIndexOf. A string byteOffset is the encoding;
 * the offset clamps to the int32 range, and NaN searches everything. */
static ScrDyn *scr_bytes_dyn_index_of(const ScrBytes *b, ScrDyn *const *args, size_t argc, bool fwd,
                                      bool includes) {
  const ScrDyn *value = scr_bytes_dyn_arg(args, argc, 0);
  const ScrDyn *offset = scr_bytes_dyn_arg(args, argc, 1);
  const ScrDyn *encoding = scr_bytes_dyn_arg(args, argc, 2);
  double at = NAN;
  if (offset->kind == SCR_DYN_STR) {
    encoding = offset;
  } else if (!scr_bytes_dyn_undef(offset)) {
    if (!scr_dyn_number_coerce_js(offset, &at)) return NULL;
    if (at > 2147483647.0) at = 2147483647.0;
    else if (at < -2147483648.0) at = -2147483648.0;
  }
  double found;
  if (value->kind == SCR_DYN_NUM) {
    found = scr_bytes_index_of_num(b, value->v.num, at, fwd);
  } else {
    ScrStr *raw = NULL;
    if (!scr_bytes_dyn_undef(encoding)) {
      raw = scr_dyn_string_coerce_js(encoding);
      if (!raw) return NULL;
    }
    if (value->kind == SCR_DYN_STR) {
      /* An unknown encoding throws for a string needle. */
      ScrStr *enc = raw ? scr_bytes_normalize_encoding(raw) : scr_str_new("utf8", 4);
      if (raw) scr_str_release(raw);
      if (!enc) return NULL;
      bool ucs2 = enc->len == 7 && !memcmp(enc->data, "utf16le", 7);
      ScrBytes *needle = scr_bytes_from_str(value->v.str, enc);
      found = scr_bytes_index_of(b, needle, at, ucs2 ? 2 : 1, fwd);
      scr_bytes_release(needle);
      scr_str_release(enc);
    } else if (value->kind == SCR_DYN_BYTES && !value->v.bytes->is_data_view &&
               value->v.bytes->elem == SCR_BYTES_U8) {
      /* A Buffer needle searches 2-byte units under a utf16le encoding and
       * bytes under any other, an unknown name included. */
      bool ucs2 = raw && scr_bytes_dyn_is_ucs2(raw);
      if (raw) scr_str_release(raw);
      found = scr_bytes_index_of(b, value->v.bytes, at, ucs2 ? 2 : 1, fwd);
    } else {
      if (raw) scr_str_release(raw);
      scr_dyn_arg_type_fail("value", "one of type number or string or an instance of Buffer or Uint8Array", value);
      return NULL;
    }
  }
  return includes ? scr_dyn_new_bool(found != -1) : scr_dyn_new_num(found);
}

/* read/write(U)Int(LE|BE)(..., byteLength): the variable-width family.
 * Node checks byteLength first (`byteLength === 1..6`, else boundsError,
 * which reports a non-number as ERR_INVALID_ARG_TYPE); a read then needs a
 * defined offset before that, and a write converts and range-checks the
 * value before the offset. +1, or NULL with the exception pending. */
static ScrDyn *scr_bytes_dyn_var_method(ScrBytes *b, bool read, bool sign, bool le, ScrDyn *const *args,
                                        size_t argc) {
  const ScrDyn *offset = scr_bytes_dyn_arg(args, argc, read ? 0 : 1);
  const ScrDyn *byte_length = scr_bytes_dyn_arg(args, argc, read ? 1 : 2);
  if (read && scr_bytes_dyn_undef(offset)) {
    scr_dyn_arg_type_fail("offset", "of type number", offset);
    return NULL;
  }
  if (byte_length->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("byteLength", "of type number", byte_length);
    return NULL;
  }
  double width = byte_length->v.num;
  if (!(width == 1 || width == 2 || width == 3 || width == 4 || width == 5 || width == 6)) {
    /* The byteLength ladder of scr_bytes_read_var throws before it looks at
     * the offset. */
    (void)scr_bytes_read_var(b, 0, width, sign, le);
    return NULL;
  }
  double value = 0;
  if (!read) {
    if (!scr_dyn_number_coerce_js(scr_bytes_dyn_arg(args, argc, 0), &value)) return NULL;
    if (!scr_bytes_dyn_value_in_range(value, (size_t)width, sign)) return NULL;
  }
  if (offset->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("offset", "of type number", offset);
    return NULL;
  }
  double out = read ? scr_bytes_read_var(b, offset->v.num, width, sign, le)
                    : scr_bytes_write_var(b, value, offset->v.num, width, sign, le);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(out);
}

/* Whether `text`, compared as Node's `value > max || value < min` against
 * writeBig(U)Int64's bigint bounds, is out of range: a string compares as
 * StringToBigInt (no comparison when it is not one). */
static bool scr_bytes_dyn_big_string_out(ScrStr *text, bool sign) {
  ScrBigInt *max = sign ? scr_bigint_from_i64(INT64_MAX) : scr_bigint_from_u64(UINT64_MAX);
  ScrBigInt *min = sign ? scr_bigint_from_i64(INT64_MIN) : scr_bigint_from_u64(0);
  double above = scr_bigint_cmp_string(max, text); /* max <=> text: -1 when text > max */
  double below = scr_bigint_cmp_string(min, text);
  scr_bigint_release(max);
  scr_bigint_release(min);
  return above == -1 || below == 1;
}

/* writeBig(U)Int64's ERR_OUT_OF_RANGE for a value that is not a bigint. */
static void scr_bytes_dyn_big_range_error(const char *received, bool sign) {
  const char *range = sign ? ">= -(2n ** 63n) and < 2n ** 63n" : ">= 0n and < 2n ** 64n";
  ScrJsonBuf jb;
  scr_jb_init(&jb);
  scr_jb_puts(&jb, "The value of \"value\" is out of range. It must be ");
  scr_jb_puts(&jb, range);
  scr_jb_puts(&jb, ". Received ");
  scr_jb_puts(&jb, received);
  ScrStr *message = scr_jb_finish(&jb);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message->data, message->len, "ERR_OUT_OF_RANGE");
  scr_str_release(message);
}

/* read/writeBig(U)Int64(LE|BE): the offset defaults to 0 and must be a
 * number. A write checks the value's range against the bigint bounds
 * first, then the offset and bounds; a value in range that is not a bigint
 * then fails the bigint arithmetic with V8's TypeError, as in Node. +1, or
 * NULL with the exception pending. */
static ScrDyn *scr_bytes_dyn_big_method(ScrBytes *b, bool read, bool sign, bool le, ScrDyn *const *args,
                                        size_t argc) {
  const ScrDyn *value = scr_bytes_dyn_arg(args, argc, 0);
  if (!read) {
    if (value->kind == SCR_DYN_BIGINT) {
      if (!scr_bigint_buffer_check(value->v.bigint, sign)) return NULL;
    } else if (value->kind == SCR_DYN_NUM) {
      double v = value->v.num;
      double limit = sign ? 9223372036854775808.0 : 18446744073709551616.0;
      if (v >= limit || v < (sign ? -limit : 0)) {
        char recv[48];
        scr_num_received(v, recv);
        scr_bytes_dyn_big_range_error(recv, sign);
        return NULL;
      }
    } else if (value->kind == SCR_DYN_STR && scr_bytes_dyn_big_string_out(value->v.str, sign)) {
      ScrStr *quoted = scr_str_inspect_quoted(value->v.str, false);
      scr_bytes_dyn_big_range_error(quoted->data, sign);
      scr_str_release(quoted);
      return NULL;
    } else if (value->kind == SCR_DYN_SYMBOL) {
      static const char message[] = "Cannot convert a Symbol value to a number";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
  }
  const ScrDyn *offset_arg = scr_bytes_dyn_arg(args, argc, read ? 0 : 1);
  double offset = 0;
  if (!scr_bytes_dyn_undef(offset_arg)) {
    if (offset_arg->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("offset", "of type number", offset_arg);
      return NULL;
    }
    offset = offset_arg->v.num;
  }
  if (read) {
    ScrBigInt *out = scr_bigint_buffer_read(b, offset, sign, le);
    if (!out) return NULL;
    ScrDyn *result = scr_dyn_new_bigint(out);
    scr_bigint_release(out);
    return result;
  }
  if (value->kind != SCR_DYN_BIGINT) {
    uint64_t unused;
    if (!scr_bytes_read_u64_raw(b, offset, le, &unused)) return NULL; /* checkBounds */
    static const char message[] = "Cannot mix BigInt and other types, use explicit conversions";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  double out = scr_bigint_buffer_write(b, value->v.bigint, offset, sign, le);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(out);
}

/* The variable-width and BigInt names: read or write, then the family
 * suffix; sets read, sign and le. */
static bool scr_bytes_dyn_family(const char *method, const char *const *names, size_t count, bool *read,
                                 bool *sign, bool *le) {
  *read = !strncmp(method, "read", 4);
  if (!*read && strncmp(method, "write", 5)) return false;
  const char *rest = method + (*read ? 4 : 5);
  for (size_t i = 0; i < count; i++) {
    if (strcmp(rest, names[i])) continue;
    size_t len = strlen(rest);
    *le = rest[len - 2] == 'L';
    *sign = strncmp(rest, "UInt", 4) && strncmp(rest, "Uint", 4) && strncmp(rest, "BigUInt", 7) &&
            strncmp(rest, "BigUint", 7);
    return true;
  }
  return false;
}

static const char *const scr_bytes_dyn_var_names[] = { "UIntLE", "UIntBE", "UintLE", "UintBE", "IntLE", "IntBE" };
static const char *const scr_bytes_dyn_big_names[] = { "BigUInt64LE", "BigUInt64BE", "BigUint64LE",
                                                       "BigUint64BE", "BigInt64LE",  "BigInt64BE" };

/* Buffer.prototype members this dispatch does not run: an explicit refusal
 * instead of the "is not a function" a missing method would give. */
static bool scr_bytes_dyn_refused(const char *method) {
  static const char *const prefixes[] = { "readBig", "writeBig", "readUInt", "readUint", "readInt", "writeUInt",
                                          "writeUint", "writeInt", "readFloat", "readDouble", "writeFloat",
                                          "writeDouble" };
  static const char *const names[] = { "asciiSlice", "base64Slice", "base64urlSlice", "latin1Slice", "hexSlice",
                                       "ucs2Slice", "utf8Slice", "asciiWrite", "base64Write", "base64urlWrite",
                                       "latin1Write", "hexWrite", "ucs2Write", "utf8Write", "inspect" };
  for (size_t i = 0; i < sizeof prefixes / sizeof prefixes[0]; i++)
    if (!strncmp(method, prefixes[i], strlen(prefixes[i]))) return true;
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
    if (!strcmp(method, names[i])) return true;
  return false;
}

static bool scr_bytes_dyn_buffer(const ScrDyn *recv) {
  return recv->kind == SCR_DYN_BYTES && recv->buffer && !recv->v.bytes->is_data_view;
}

/* One entry per method family, so a program links only the families it
 * names: each runs its methods on a Buffer receiver and gives any other
 * receiver the ordinary dispatch. */
/* A fixed-width read or write on a Buffer receiver; *handled false when
 * `method` names none. */
static ScrDyn *scr_bytes_dyn_num_named(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc,
                                       bool *handled) {
  *handled = true;
  bool read = !strncmp(method, "read", 4);
  const char *rest = method + (read ? 4 : 5);
  for (size_t at = 0; at < sizeof scr_bytes_dyn_names / sizeof scr_bytes_dyn_names[0]; at++) {
    if (!strcmp(rest, scr_bytes_dyn_names[at].name)) return scr_bytes_dyn_num_method(recv->v.bytes, read, at, args, argc);
  }
  *handled = false;
  return NULL;
}

ScrDyn *scr_dyn_invoke_buffer_num(ScrDyn *recv, ScrDyn *callee, const char *method,
                                  int32_t *mid_slot, ScrDyn *const *args, size_t argc,
                                  const char *what) {
  if (scr_bytes_dyn_buffer(recv)) {
    bool handled;
    ScrDyn *result = scr_bytes_dyn_num_named(recv, method, args, argc, &handled);
    if (handled) return result;
  }
  return scr_dyn_invoke_prepared_id(recv, callee, method, mid_slot, args, argc, what);
}

ScrDyn *scr_dyn_invoke_buffer_write(ScrDyn *recv, ScrDyn *callee, const char *method,
                                    int32_t *mid_slot, ScrDyn *const *args, size_t argc,
                                    const char *what) {
  if (scr_bytes_dyn_buffer(recv)) return scr_bytes_dyn_write(recv->v.bytes, args, argc);
  return scr_dyn_invoke_prepared_id(recv, callee, method, mid_slot, args, argc, what);
}

ScrDyn *scr_dyn_invoke_buffer_fill(ScrDyn *recv, ScrDyn *callee, const char *method,
                                   int32_t *mid_slot, ScrDyn *const *args, size_t argc,
                                   const char *what) {
  if (scr_bytes_dyn_buffer(recv)) return scr_bytes_dyn_fill(recv, args, argc);
  return scr_dyn_invoke_prepared_id(recv, callee, method, mid_slot, args, argc, what);
}

ScrDyn *scr_dyn_invoke_buffer_to_string(ScrDyn *recv, ScrDyn *callee, const char *method,
                                        int32_t *mid_slot, ScrDyn *const *args, size_t argc,
                                        const char *what) {
  if (scr_bytes_dyn_buffer(recv)) return scr_bytes_dyn_to_string(recv->v.bytes, args, argc);
  return scr_dyn_invoke_prepared_id(recv, callee, method, mid_slot, args, argc, what);
}

/* indexOf, lastIndexOf and includes. */
ScrDyn *scr_dyn_invoke_buffer_search(ScrDyn *recv, ScrDyn *callee, const char *method,
                                     int32_t *mid_slot, ScrDyn *const *args, size_t argc,
                                     const char *what) {
  if (scr_bytes_dyn_buffer(recv)) {
    bool includes = !strcmp(method, "includes");
    return scr_bytes_dyn_index_of(recv->v.bytes, args, argc, strcmp(method, "lastIndexOf") != 0, includes);
  }
  return scr_dyn_invoke_prepared_id(recv, callee, method, mid_slot, args, argc, what);
}

/* The variable-width and BigInt families on a Buffer receiver; *handled
 * false when `method` names neither. */
static ScrDyn *scr_bytes_dyn_wide_member(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc,
                                         bool *handled) {
  *handled = true;
  ScrBytes *b = recv->v.bytes;
  bool read, sign, le;
  if (scr_bytes_dyn_family(method, scr_bytes_dyn_var_names, 6, &read, &sign, &le))
    return scr_bytes_dyn_var_method(b, read, sign, le, args, argc);
  if (scr_bytes_dyn_family(method, scr_bytes_dyn_big_names, 6, &read, &sign, &le))
    return scr_bytes_dyn_big_method(b, read, sign, le, args, argc);
  *handled = false;
  return NULL;
}

/* toJSON, equals, compare, copy, swap16/32/64, and the refused members on a
 * Buffer receiver; *handled false when `method` names none. */
static ScrDyn *scr_bytes_dyn_buffer_member(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc,
                                           bool *handled) {
  *handled = true;
  ScrBytes *b = recv->v.bytes;
  if (!strcmp(method, "toJSON")) return scr_bytes_dyn_to_json(b);
  if (!strcmp(method, "equals")) {
    bool same = scr_bytes_equals_chk(b, scr_bytes_dyn_arg(args, argc, 0));
    return scr_exc_pending() ? NULL : scr_dyn_new_bool(same);
  }
  if (!strcmp(method, "compare")) {
    double order = scr_bytes_compare_chk(b, scr_bytes_dyn_arg(args, argc, 0), scr_bytes_dyn_arg(args, argc, 1),
                                         scr_bytes_dyn_arg(args, argc, 2), scr_bytes_dyn_arg(args, argc, 3),
                                         scr_bytes_dyn_arg(args, argc, 4));
    return scr_exc_pending() ? NULL : scr_dyn_new_num(order);
  }
  if (!strcmp(method, "copy")) return scr_bytes_dyn_copy(b, args, argc);
  if (!strcmp(method, "swap16") || !strcmp(method, "swap32") || !strcmp(method, "swap64")) {
    ScrBytes *swapped = scr_bytes_swap(b, method[4] == '1' ? 2 : method[4] == '3' ? 4 : 8);
    if (!swapped) return NULL;
    scr_bytes_release(swapped);
    return scr_dyn_retain(recv);
  }
  if (scr_bytes_dyn_refused(method)) {
    ScrJsonBuf jb;
    scr_jb_init(&jb);
    scr_jb_puts(&jb, "'Buffer.prototype.");
    scr_jb_puts(&jb, method);
    scr_jb_puts(&jb, "' on a dynamic value is not supported yet");
    ScrStr *message = scr_jb_finish(&jb);
    scr_throw_error_msg(SCR_ERR_ERROR, message->data, message->len);
    scr_str_release(message);
    return NULL;
  }
  *handled = false;
  return NULL;
}

/* toJSON, equals, compare, copy, swap16/32/64, and the refused members. */
ScrDyn *scr_dyn_invoke_buffer(ScrDyn *recv, ScrDyn *callee, const char *method,
                              int32_t *mid_slot, ScrDyn *const *args, size_t argc,
                              const char *what) {
  if (scr_bytes_dyn_buffer(recv)) {
    bool handled;
    ScrDyn *result = scr_bytes_dyn_buffer_member(recv, method, args, argc, &handled);
    if (handled) return result;
  }
  return scr_dyn_invoke_prepared_id(recv, callee, method, mid_slot, args, argc, what);
}

/* The variable-width (readUIntLE, writeIntBE, ...) and BigInt
 * (readBigUInt64LE, writeBigInt64BE, ...) families, apart from
 * scr_dyn_invoke_buffer so its other members do not link them. */
ScrDyn *scr_dyn_invoke_buffer_wide(ScrDyn *recv, ScrDyn *callee, const char *method,
                                   int32_t *mid_slot, ScrDyn *const *args, size_t argc,
                                   const char *what) {
  if (scr_bytes_dyn_buffer(recv)) {
    bool handled;
    ScrDyn *result = scr_bytes_dyn_wide_member(recv, method, args, argc, &handled);
    if (handled) return result;
  }
  return scr_dyn_invoke_prepared_id(recv, callee, method, mid_slot, args, argc, what);
}

/* A fixed-width read or write name (readUInt8, writeDoubleLE, ...). */
static bool scr_bytes_dyn_num_method_name(const char *method) {
  bool read = !strncmp(method, "read", 4);
  if (!read && strncmp(method, "write", 5)) return false;
  const char *rest = method + (read ? 4 : 5);
  for (size_t at = 0; at < sizeof scr_bytes_dyn_names / sizeof scr_bytes_dyn_names[0]; at++)
    if (!strcmp(rest, scr_bytes_dyn_names[at].name)) return true;
  return false;
}

/* ── Buffer.prototype members read as values ────────────────────────────
 * `Buffer.prototype[name]` (smart-buffer's typeof probe for the BigInt
 * methods): an own member answers one function per name, with the name and
 * length Node's function has; the parent and offset getters, read on the
 * prototype itself, answer undefined; constructor is the Buffer value.
 * Members inherited from Uint8Array.prototype and Object.prototype, symbol
 * keys and object keys throw SC2020, and other keys answer undefined. The
 * functions run the method on a Buffer receiver (`.call(buf, ...)`); other
 * receivers throw SC2020. */
static const struct { const char *key; const char *name; uint32_t length; } scr_buffer_proto_own[] = {
  {"readBigUInt64LE", "readBigUInt64LE", 0},
  {"readBigUInt64BE", "readBigUInt64BE", 0},
  {"readBigUint64LE", "readBigUInt64LE", 0},
  {"readBigUint64BE", "readBigUInt64BE", 0},
  {"readBigInt64LE", "readBigInt64LE", 0},
  {"readBigInt64BE", "readBigInt64BE", 0},
  {"writeBigUInt64LE", "writeBigUInt64LE", 1},
  {"writeBigUInt64BE", "writeBigUInt64BE", 1},
  {"writeBigUint64LE", "writeBigUInt64LE", 1},
  {"writeBigUint64BE", "writeBigUInt64BE", 1},
  {"writeBigInt64LE", "writeBigInt64LE", 1},
  {"writeBigInt64BE", "writeBigInt64BE", 1},
  {"readUIntLE", "readUIntLE", 2},
  {"readUInt32LE", "", 1},
  {"readUInt16LE", "", 1},
  {"readUInt8", "", 1},
  {"readUIntBE", "readUIntBE", 2},
  {"readUInt32BE", "", 1},
  {"readUInt16BE", "", 1},
  {"readUintLE", "readUIntLE", 2},
  {"readUint32LE", "", 1},
  {"readUint16LE", "", 1},
  {"readUint8", "", 1},
  {"readUintBE", "readUIntBE", 2},
  {"readUint32BE", "", 1},
  {"readUint16BE", "", 1},
  {"readIntLE", "readIntLE", 2},
  {"readInt32LE", "", 1},
  {"readInt16LE", "", 1},
  {"readInt8", "", 1},
  {"readIntBE", "readIntBE", 2},
  {"readInt32BE", "", 1},
  {"readInt16BE", "", 1},
  {"writeUIntLE", "writeUIntLE", 3},
  {"writeUInt32LE", "writeUInt32LE", 1},
  {"writeUInt16LE", "writeUInt16LE", 1},
  {"writeUInt8", "writeUInt8", 1},
  {"writeUIntBE", "writeUIntBE", 3},
  {"writeUInt32BE", "writeUInt32BE", 1},
  {"writeUInt16BE", "writeUInt16BE", 1},
  {"writeUintLE", "writeUIntLE", 3},
  {"writeUint32LE", "writeUInt32LE", 1},
  {"writeUint16LE", "writeUInt16LE", 1},
  {"writeUint8", "writeUInt8", 1},
  {"writeUintBE", "writeUIntBE", 3},
  {"writeUint32BE", "writeUInt32BE", 1},
  {"writeUint16BE", "writeUInt16BE", 1},
  {"writeIntLE", "writeIntLE", 3},
  {"writeInt32LE", "writeInt32LE", 1},
  {"writeInt16LE", "writeInt16LE", 1},
  {"writeInt8", "writeInt8", 1},
  {"writeIntBE", "writeIntBE", 3},
  {"writeInt32BE", "writeInt32BE", 1},
  {"writeInt16BE", "writeInt16BE", 1},
  {"readFloatLE", "readFloatForwards", 0},
  {"readFloatBE", "readFloatBackwards", 0},
  {"readDoubleLE", "readDoubleForwards", 0},
  {"readDoubleBE", "readDoubleBackwards", 0},
  {"writeFloatLE", "writeFloatForwards", 1},
  {"writeFloatBE", "writeFloatBackwards", 1},
  {"writeDoubleLE", "writeDoubleForwards", 1},
  {"writeDoubleBE", "writeDoubleBackwards", 1},
  {"asciiSlice", "", 2},
  {"base64Slice", "", 2},
  {"base64urlSlice", "", 2},
  {"latin1Slice", "", 2},
  {"hexSlice", "", 2},
  {"ucs2Slice", "", 2},
  {"utf8Slice", "", 2},
  {"asciiWrite", "", 3},
  {"base64Write", "", 3},
  {"base64urlWrite", "", 3},
  {"latin1Write", "", 3},
  {"hexWrite", "", 3},
  {"ucs2Write", "", 3},
  {"utf8Write", "", 3},
  {"parent", NULL, 0},
  {"offset", NULL, 0},
  {"copy", "copy", 4},
  {"toString", "toString", 3},
  {"equals", "equals", 1},
  {"inspect", "inspect", 2},
  {"compare", "compare", 5},
  {"indexOf", "indexOf", 4},
  {"lastIndexOf", "lastIndexOf", 4},
  {"includes", "includes", 4},
  {"fill", "fill", 4},
  {"write", "write", 4},
  {"toJSON", "toJSON", 0},
  {"subarray", "subarray", 2},
  {"slice", "slice", 2},
  {"swap16", "swap16", 0},
  {"swap32", "swap32", 0},
  {"swap64", "swap64", 0},
  {"toLocaleString", "toString", 3},
};

static const char *const scr_buffer_proto_inherited[] = {
  "BYTES_PER_ELEMENT", "buffer", "byteLength", "byteOffset", "length", "entries", "keys", "values",
  "at", "copyWithin", "every", "filter", "find", "findIndex", "findLast", "findLastIndex",
  "forEach", "join", "map", "reverse", "reduce", "reduceRight", "set", "some", "sort", "toReversed",
  "toSorted", "with", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__",
  "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "valueOf", "__proto__",
};

static SCR_TL ScrDyn *scr_buffer_proto_fns;
static SCR_TL ScrDyn *scr_buffer_proto_object;

static void scr_buffer_proto_cleanup(void) {
  scr_dyn_release(scr_buffer_proto_fns);
  scr_buffer_proto_fns = NULL;
}

static void scr_buffer_proto_object_cleanup(void) {
  scr_dyn_release(scr_buffer_proto_object);
  scr_buffer_proto_object = NULL;
}

static ScrDyn *scr_buffer_proto_unsupported(const char *format, const char *name) {
  char message[200];
  int n = snprintf(message, sizeof message, format, name);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)n, "SC2020");
  return NULL;
}

/* Buffer.prototype.inspect called without an inspection context:
 * `<${this.constructor.name} 01 02 ...>` over the first 50 bytes
 * (INSPECT_MAX_BYTES), then " ... N more bytes". With a context object Node
 * also renders the view's extra properties, which this does not. */
static ScrDyn *scr_buffer_proto_inspect(const ScrBytes *b, const char *name, ScrDyn *const *args, size_t argc) {
  if (argc >= 2 && scr_dyn_is_object(args[1]))
    return scr_buffer_proto_unsupported("Buffer.prototype.%s with an inspection context through a stored value is not supported yet",
                                        "inspect");
  ScrJsonBuf jb;
  scr_jb_init(&jb);
  scr_jb_putc(&jb, '<');
  scr_jb_puts(&jb, name);
  scr_jb_putc(&jb, ' ');
  size_t shown = b->len < 50 ? b->len : 50;
  for (size_t i = 0; i < shown; i++) {
    char hex[4];
    snprintf(hex, sizeof hex, "%02x", (unsigned)scr_bytes_get(b, (double)i));
    if (i) scr_jb_putc(&jb, ' ');
    scr_jb_puts(&jb, hex);
  }
  if (b->len > 50) {
    char more[48];
    size_t remaining = b->len - 50;
    snprintf(more, sizeof more, " ... %zu more byte%s", remaining, remaining > 1 ? "s" : "");
    scr_jb_puts(&jb, more);
  }
  scr_jb_putc(&jb, '>');
  ScrStr *text = scr_jb_finish(&jb);
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}

/* `this.subarray(...)` or `this.slice(...)` on a byte view, as scr_dyn_invoke
 * runs it: an own property of the view shadows the prototype's method.
 * Calling scr_dyn_bytes_method directly keeps the dynamic invoke unit out of
 * programs that only read Buffer.prototype members. */
static ScrDyn *scr_buffer_proto_view_call(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc,
                                          const char *what) {
  ScrDyn *member = recv->v.bytes->properties ? scr_bytes_named_get(recv, method, strlen(method)) : NULL;
  if (!member && scr_exc_pending()) return NULL;
  if (member) {
    ScrDyn *result = NULL;
    if (!scr_dyn_is_callable(member)) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, what);
      scr_jb_puts(&b, " is not a function");
      scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    } else {
      scr_dyn_this_push_dyn(recv);
      result = scr_dyn_call(member, args, argc, what);
      scr_dyn_this_pop();
    }
    scr_dyn_release(member);
    return result;
  }
  bool handled;
  return scr_dyn_bytes_method(recv, method, args, argc, &handled);
}

static ScrDyn *scr_buffer_proto_run(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc) {
  if (!scr_bytes_dyn_buffer(recv)) {
    /* Node's methods run on any Uint8Array (Buffer.prototype.toString.call(
     * new Uint8Array(...))): the receiver runs as a Buffer over the same
     * storage. copy's _copy rejects any other source with
     * ERR_INVALID_ARG_TYPE; other receivers are refused. */
    if (recv->kind == SCR_DYN_BYTES && !recv->v.bytes->is_data_view && recv->v.bytes->elem == SCR_BYTES_U8) {
      if (!strcmp(method, "inspect")) return scr_buffer_proto_inspect(recv->v.bytes, "Uint8Array", args, argc);
      /* slice is this.subarray(start, end): a Uint8Array receiver's own. */
      if (!strcmp(method, "slice")) return scr_buffer_proto_view_call(recv, "subarray", args, argc, "Buffer.prototype.slice");
      ScrDyn *as_buffer = scr_dyn_new_buffer(recv->v.bytes);
      ScrDyn *result = scr_buffer_proto_run(as_buffer, method, args, argc);
      /* A method that answers its receiver (fill, swap16) answers the
       * Uint8Array it was called on. */
      if (result && result->kind == SCR_DYN_BYTES && result->v.bytes == as_buffer->v.bytes) {
        scr_dyn_release(result);
        result = scr_dyn_retain(recv);
      }
      scr_dyn_release(as_buffer);
      return result;
    }
    if (!strcmp(method, "copy")) {
      if (recv->kind == SCR_DYN_BYTES) return scr_bytes_dyn_copy(recv->v.bytes, args, argc);
      scr_dyn_arg_type_fail("source", "an instance of Buffer or Uint8Array", recv);
      return NULL;
    }
    return scr_buffer_proto_unsupported("Buffer.prototype.%s on a receiver that is not a Buffer is not supported yet",
                                        method);
  }
  /* The Buffer-only bodies of the scr_dyn_invoke_buffer entries, without
   * their fallback to the dynamic invoke unit. */
  bool handled;
  ScrDyn *result;
  if (scr_bytes_dyn_num_method_name(method)) {
    result = scr_bytes_dyn_num_named(recv, method, args, argc, &handled);
    if (handled) return result;
  }
  if (!strcmp(method, "write")) return scr_bytes_dyn_write(recv->v.bytes, args, argc);
  if (!strcmp(method, "fill")) return scr_bytes_dyn_fill(recv, args, argc);
  if (!strcmp(method, "toString") || !strcmp(method, "toLocaleString"))
    return scr_bytes_dyn_to_string(recv->v.bytes, args, argc);
  if (!strcmp(method, "indexOf") || !strcmp(method, "lastIndexOf") || !strcmp(method, "includes"))
    return scr_bytes_dyn_index_of(recv->v.bytes, args, argc, strcmp(method, "lastIndexOf") != 0,
                                  !strcmp(method, "includes"));
  if (!strcmp(method, "subarray") || !strcmp(method, "slice"))
    return scr_buffer_proto_view_call(recv, method, args, argc, "Buffer.prototype method");
  if (!strcmp(method, "inspect")) return scr_buffer_proto_inspect(recv->v.bytes, "Buffer", args, argc);
  result = scr_bytes_dyn_wide_member(recv, method, args, argc, &handled);
  if (handled) return result;
  result = scr_bytes_dyn_buffer_member(recv, method, args, argc, &handled);
  if (handled) return result;
  return scr_buffer_proto_unsupported("Buffer.prototype.%s is not supported yet", method);
}

static ScrDyn *scr_buffer_proto_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *recv = scr_dyn_this_get();
  ScrDyn *result = scr_buffer_proto_run(recv, closure->fn, args, argc);
  scr_dyn_release(recv);
  return result;
}

static ptrdiff_t scr_buffer_proto_own_index(const ScrStr *name);

/* The own member at `at` of scr_buffer_proto_own as a function value, one
 * per function per thread: a "Uint" spelling (readUint8, writeBigUint64LE)
 * answers the function of its "UInt" spelling, and toLocaleString the
 * toString function, as in Node. +1. */
static ScrDyn *scr_buffer_proto_fn(size_t at) {
  if (!strcmp(scr_buffer_proto_own[at].key, "toLocaleString")) {
    /* Buffer.prototype.toLocaleString is Buffer.prototype.toString. */
    ScrStr *key = scr_str_new("toString", 8);
    ptrdiff_t target = scr_buffer_proto_own_index(key);
    scr_str_release(key);
    if (target >= 0) at = (size_t)target;
  }
  const char *alias = strstr(scr_buffer_proto_own[at].key, "Uint");
  if (alias) {
    char canonical[32];
    size_t len = strlen(scr_buffer_proto_own[at].key);
    memcpy(canonical, scr_buffer_proto_own[at].key, len + 1);
    canonical[alias - scr_buffer_proto_own[at].key + 1] = 'I';
    ScrStr *key = scr_str_new(canonical, len);
    ptrdiff_t target = scr_buffer_proto_own_index(key);
    scr_str_release(key);
    if (target >= 0) at = (size_t)target;
  }
  const char *own = scr_buffer_proto_own[at].key;
  size_t len = strlen(own);
  if (!scr_buffer_proto_fns) {
    scr_buffer_proto_fns = scr_dyn_new_obj_null_proto();
    scr_atexit(scr_buffer_proto_cleanup);
  }
  ScrDyn *fn = scr_dyn_obj_get(scr_buffer_proto_fns, own, len);
  if (!fn) {
    fn = scr_dyn_new_func(scr_closure_new((void *)own, 0), scr_buffer_proto_call, scr_buffer_proto_own[at].length,
                          "native:function", scr_buffer_proto_own[at].name);
    scr_dyn_obj_set(scr_buffer_proto_fns, own, len, fn);
  }
  return scr_dyn_retain(fn);
}

/* The index of `name` in scr_buffer_proto_own, or -1. */
static ptrdiff_t scr_buffer_proto_own_index(const ScrStr *name) {
  for (size_t i = 0; i < sizeof scr_buffer_proto_own / sizeof scr_buffer_proto_own[0]; i++) {
    const char *own = scr_buffer_proto_own[i].key;
    if (strlen(own) == name->len && memcmp(own, name->data, name->len) == 0) return (ptrdiff_t)i;
  }
  return -1;
}

/* `buf[name]` with a key computed at run time (scr_bytes_buffer_member_fn):
 * an own Buffer.prototype method answers the function
 * `Buffer.prototype[name]` answers. Other keys, and the parent and offset
 * getters scr_dyn_bytes_key_get answers itself, answer NULL. */
static ScrDyn *scr_buffer_instance_member(const ScrDyn *value, const ScrStr *key) {
  (void)value;
  ptrdiff_t at = scr_buffer_proto_own_index(key);
  if (at < 0 || !scr_buffer_proto_own[at].name) return NULL;
  return scr_buffer_proto_fn((size_t)at);
}

void scr_bytes_buffer_members_install(void) {
  scr_bytes_buffer_member_fn = scr_buffer_instance_member;
}

/* Buffer.prototype's parent and offset getters (both named "get", as
 * Node's are): a Buffer receiver answers its ArrayBuffer or byteOffset, any
 * other receiver undefined. The closure's fn tells which. */
static const char scr_buffer_proto_parent[] = "parent";
static const char scr_buffer_proto_offset[] = "offset";

static ScrDyn *scr_buffer_proto_getter_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *recv = scr_dyn_this_get();
  ScrDyn *result;
  if (!scr_bytes_dyn_buffer(recv)) result = scr_dyn_retain(scr_dyn_undefined());
  else if (closure->fn == (void *)scr_buffer_proto_parent) result = scr_array_buffer_from_bytes(recv->v.bytes);
  else result = scr_dyn_new_num(scr_bytes_byte_offset(recv->v.bytes));
  scr_dyn_release(recv);
  return result;
}

/* `Buffer.prototype` as a value: constructor (not enumerable), then every
 * own member in Node's order (the functions `Buffer.prototype[name]`
 * answers, so each keeps one identity, and the parent and offset getters),
 * enumerable as in Node, and Symbol(nodejs.util.inspect.custom), the inspect
 * function. %TypedArray%.prototype is not modeled, so its prototype is
 * Object.prototype. */
ScrDyn *scr_buffer_prototype_object(void) {
  if (scr_buffer_proto_object) return scr_dyn_retain(scr_buffer_proto_object);
  ScrDyn *object = scr_dyn_new_obj();
  ScrStr *name = scr_str_new("constructor", 11);
  ScrDyn *key = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *constructor = scr_buffer_prototype_member(key);
  scr_dyn_release(key);
  if (!constructor) {
    scr_dyn_release(object);
    return NULL;
  }
  scr_dyn_obj_set(object, "constructor", 11, constructor);
  scr_dyn_obj_set_attrs_at(object, scr_dyn_obj_index_of(object, "constructor", 11), true, false, true);
  for (size_t i = 0; i < sizeof scr_buffer_proto_own / sizeof scr_buffer_proto_own[0]; i++) {
    const char *own = scr_buffer_proto_own[i].key;
    size_t len = strlen(own);
    if (scr_buffer_proto_own[i].name) {
      scr_dyn_obj_set(object, own, len, scr_buffer_proto_fn(i));
      continue;
    }
    const char *getter_name = own[0] == 'p' ? scr_buffer_proto_parent : scr_buffer_proto_offset;
    ScrDyn *getter = scr_dyn_new_func(scr_closure_new((void *)getter_name, 0), scr_buffer_proto_getter_call, 0,
                                      "native:function", "get");
    scr_dyn_obj_set_accessor(object, own, len, getter, NULL);
  }
  /* The symbol unit links with Buffer.prototype as a value; creating the
   * registered symbol installs scr_dyn_inspect_custom_symbol. */
  if (scr_sym_for_fn) {
    ScrStr *description = scr_str_new("nodejs.util.inspect.custom", 26);
    ScrSym *symbol = scr_sym_for_fn(description);
    scr_str_release(description);
    ScrDyn *custom = scr_dyn_inspect_custom_symbol();
    custom->v.symbol.release(symbol);
    ScrStr *inspect_name = scr_str_new("inspect", 7);
    ptrdiff_t inspect_at = scr_buffer_proto_own_index(inspect_name);
    scr_str_release(inspect_name);
    ScrDyn *inspect = scr_buffer_proto_fn((size_t)inspect_at);
    scr_dyn_symbol_key_set(object, custom, inspect);
    scr_dyn_release(inspect);
  }
  scr_buffer_proto_object = object;
  scr_atexit(scr_buffer_proto_object_cleanup);
  return scr_dyn_retain(object);
}

ScrDyn *scr_buffer_prototype_member(const ScrDyn *key) {
  if (key->kind == SCR_DYN_SYMBOL) {
    /* Symbol(nodejs.util.inspect.custom) is the inspect function; symbols
     * inherited from %TypedArray%.prototype are not modeled. */
    const ScrDyn *custom = scr_dyn_inspect_custom_symbol();
    if (custom && key->v.symbol.value == custom->v.symbol.value) {
      ScrStr *name = scr_str_new("inspect", 7);
      ptrdiff_t at = scr_buffer_proto_own_index(name);
      scr_str_release(name);
      return scr_buffer_proto_fn((size_t)at);
    }
    return scr_buffer_proto_unsupported("Buffer.prototype members keyed by %s are not supported yet", "symbols");
  }
  if (key->kind != SCR_DYN_STR) {
    if (key->kind == SCR_DYN_NUM || key->kind == SCR_DYN_BOOL || key->kind == SCR_DYN_UNDEF ||
        key->kind == SCR_DYN_NULL || key->kind == SCR_DYN_BIGINT)
      return scr_dyn_retain(scr_dyn_undefined());
    return scr_buffer_proto_unsupported("Buffer.prototype members keyed by %s are not supported yet", "objects");
  }
  const ScrStr *name = key->v.str;
  if (name->len == 11 && memcmp(name->data, "constructor", 11) == 0) {
    /* A program that reads the Buffer function's value answers it (the
     * builtin-values unit installs the hook); otherwise Buffer keeps its
     * builtin identity token, as typed array reads do (scr_json.c). */
    if (scr_bytes_buffer_constructor_fn) return scr_bytes_buffer_constructor_fn();
    ScrStr *token = scr_str_new("[builtin Buffer]", 16);
    ScrDyn *result = scr_dyn_new_str(token);
    scr_str_release(token);
    return result;
  }
  for (size_t i = 0; i < sizeof scr_buffer_proto_inherited / sizeof scr_buffer_proto_inherited[0]; i++) {
    const char *inherited = scr_buffer_proto_inherited[i];
    if (strlen(inherited) == name->len && memcmp(inherited, name->data, name->len) == 0)
      return scr_buffer_proto_unsupported("Buffer.prototype.%s is not supported yet", inherited);
  }
  ptrdiff_t at = scr_buffer_proto_own_index(name);
  if (at < 0 || !scr_buffer_proto_own[at].name) return scr_dyn_retain(scr_dyn_undefined());
  return scr_buffer_proto_fn((size_t)at);
}
