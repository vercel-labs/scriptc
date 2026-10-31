/* node:querystring (scr_runtime.h has the API contract): Node v24's
 * legacy query-string codec — NOT URLSearchParams (the escaping and '+'
 * rules differ; that surface lives in scr_url_params.c). LINK-GATED:
 * compiled into the binary only when the IR uses the qs surface
 * (moduleUsesQs — the scr_url_params gating precedent), so qs-free
 * programs pay zero bytes. querystring.escape never reaches this unit at
 * all: Node's qsEscape encodes exactly the component unreserved set, so
 * the frontend lowers it to the always-linked scr_qs_escape.
 *
 * Everything here is a quirk-faithful port of lib/querystring.js (Node is
 * the oracle): parse's interleaved sep/eq scan with its naive
 * partial-match resets and the encodeCheck fast path, unescapeBuffer's
 * UTF-16-code-unit byte truncation, and stringify's encodeStringified
 * value rules. The scans run byte-wise over the runtime's UTF-8 storage —
 * equivalent to Node's code-unit scans for well-formed input, because the
 * machine only assigns meaning to ASCII ('%', '+', hex, and the sep/eq
 * sequences positionally) and UTF-8 multibyte alignment mirrors UTF-16
 * unit alignment. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── a tiny growable byte buffer (scr_url_params.c's, redeclared) ────── */

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} QsBuf;

static void qb_init(QsBuf *b) {
  b->cap = 64;
  b->len = 0;
  b->data = malloc(b->cap);
  if (!b->data) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
}

static void qb_append(QsBuf *b, const char *bytes, size_t n) {
  if (b->len + n > b->cap) {
    while (b->len + n > b->cap) b->cap *= 2;
    char *grown = realloc(b->data, b->cap);
    if (!grown) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
    b->data = grown;
  }
  memcpy(b->data + b->len, bytes, n);
  b->len += n;
}

static void qb_push(QsBuf *b, char c) { qb_append(b, &c, 1); }

static void qb_append_str(QsBuf *b, const ScrStr *s) {
  qb_append(b, s->data, s->len);
}

static ScrStr *qb_take(QsBuf *b) {
  ScrStr *s = scr_str_new(b->data, b->len);
  free(b->data);
  return s;
}

/* ── shared scan helpers ─────────────────────────────────────────────── */

static int qs_unhex(unsigned c) {
  if (c >= '0' && c <= '9') return (int)(c - '0');
  if (c >= 'A' && c <= 'F') return (int)(c - 'A' + 10);
  if (c >= 'a' && c <= 'f') return (int)(c - 'a' + 10);
  return -1;
}

/* One UTF-8 code point at p (well-formed by the runtime invariant);
 * *adv gets the byte length. */
static uint32_t qs_utf8_decode(const char *p, size_t *adv) {
  unsigned char b0 = (unsigned char)p[0];
  if (b0 < 0x80) {
    *adv = 1;
    return b0;
  }
  if (b0 < 0xE0) {
    *adv = 2;
    return (uint32_t)((b0 & 0x1Fu) << 6) | ((unsigned char)p[1] & 0x3Fu);
  }
  if (b0 < 0xF0) {
    *adv = 3;
    return (uint32_t)((b0 & 0x0Fu) << 12) |
           (uint32_t)(((unsigned char)p[1] & 0x3Fu) << 6) |
           ((unsigned char)p[2] & 0x3Fu);
  }
  *adv = 4;
  return (uint32_t)((b0 & 0x07u) << 18) |
         (uint32_t)(((unsigned char)p[1] & 0x3Fu) << 12) |
         (uint32_t)(((unsigned char)p[2] & 0x3Fu) << 6) |
         ((unsigned char)p[3] & 0x3Fu);
}

static void qs_utf8_encode(QsBuf *b, uint32_t cp) {
  char tmp[4];
  if (cp < 0x80) {
    tmp[0] = (char)cp;
    qb_append(b, tmp, 1);
  } else if (cp < 0x800) {
    tmp[0] = (char)(0xC0 | (cp >> 6));
    tmp[1] = (char)(0x80 | (cp & 0x3F));
    qb_append(b, tmp, 2);
  } else if (cp < 0x10000) {
    tmp[0] = (char)(0xE0 | (cp >> 12));
    tmp[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    tmp[2] = (char)(0x80 | (cp & 0x3F));
    qb_append(b, tmp, 3);
  } else {
    tmp[0] = (char)(0xF0 | (cp >> 18));
    tmp[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    tmp[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    tmp[3] = (char)(0x80 | (cp & 0x3F));
    qb_append(b, tmp, 4);
  }
}

/* ── unescape (Node's qsUnescape) ────────────────────────────────────── */

/* The string's UTF-16 code units (astral chars split into surrogate
 * pairs) — unescapeBuffer's scan is defined over these, byte-truncation
 * quirk included, so the fallback builds them first. Caller frees. */
static uint16_t *qs_utf16_units(const ScrStr *s, size_t *out_n) {
  /* One unit per byte is a safe cap (ASCII 1:1; multibyte shrinks). */
  uint16_t *units = malloc(sizeof(uint16_t) * (s->len ? s->len : 1));
  if (!units) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  size_t n = 0, i = 0;
  while (i < s->len) {
    size_t adv;
    uint32_t cp = qs_utf8_decode(s->data + i, &adv);
    i += adv;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      units[n++] = (uint16_t)(0xD800 + (cp >> 10));
      units[n++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
    } else {
      units[n++] = (uint16_t)cp;
    }
  }
  *out_n = n;
  return units;
}

/* WHATWG UTF-8 decode with replacement (maximal subpart) — the semantics
 * of Buffer.prototype.toString('utf8') the fallback path ends with. */
static ScrStr *qs_utf8_replace_decode(const unsigned char *p, size_t n) {
  QsBuf out;
  qb_init(&out);
  size_t i = 0;
  while (i < n) {
    unsigned char b0 = p[i];
    if (b0 < 0x80) {
      qb_push(&out, (char)b0);
      i++;
      continue;
    }
    int need;
    unsigned lo = 0x80, hi = 0xBF;
    if (b0 >= 0xC2 && b0 <= 0xDF) need = 1;
    else if (b0 == 0xE0) { need = 2; lo = 0xA0; }
    else if (b0 == 0xED) { need = 2; hi = 0x9F; }
    else if (b0 >= 0xE1 && b0 <= 0xEF) need = 2;
    else if (b0 == 0xF0) { need = 3; lo = 0x90; }
    else if (b0 == 0xF4) { need = 3; hi = 0x8F; }
    else if (b0 >= 0xF1 && b0 <= 0xF3) need = 3;
    else { /* 0x80..0xC1, 0xF5..0xFF: never a leading byte */
      qs_utf8_encode(&out, 0xFFFD);
      i++;
      continue;
    }
    /* Consume as many valid continuations as exist (maximal subpart):
     * an invalid or missing continuation replaces the consumed prefix
     * with ONE U+FFFD and rescans at the offending byte. */
    uint32_t cp = b0 & (uint32_t)(0xFF >> (need + 2));
    size_t j = i + 1;
    int k = 0;
    bool ok = true;
    for (; k < need; k++, j++) {
      if (j >= n) { ok = false; break; }
      unsigned c = p[j];
      unsigned clo = (k == 0) ? lo : 0x80, chi = (k == 0) ? hi : 0xBF;
      if (c < clo || c > chi) { ok = false; break; }
      cp = (cp << 6) | (c & 0x3F);
    }
    if (!ok) {
      qs_utf8_encode(&out, 0xFFFD);
      i = j; /* prefix consumed; rescan at the offending byte */
      continue;
    }
    qs_utf8_encode(&out, cp);
    i = j;
  }
  return qb_take(&out);
}

/* Node's unescapeBuffer(s, decodeSpaces) over the UTF-16 units: the byte
 * buffer and its length. Caller frees *out. */
static unsigned char *qs_unescape_bytes(const ScrStr *s, bool decode_spaces, size_t *out_len) {
  size_t n;
  uint16_t *units = qs_utf16_units(s, &n);
  unsigned char *out = malloc(n ? n : 1);
  if (!out) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  size_t w = 0, index = 0;
  /* maxLength = s.length - 2 as a signed comparison (n < 2 must refuse
   * every escape, matching Node's `index < maxLength` on negatives). */
  while (index < n) {
    unsigned cur = units[index];
    if (cur == '%' && n >= 3 && index < n - 2) {
      unsigned c1 = units[index + 1];
      int hexHigh = (c1 < 256) ? qs_unhex(c1) : -1;
      if (hexHigh < 0) {
        out[w++] = '%';
        index++;
        continue;
      }
      unsigned c2 = units[index + 2];
      int hexLow = (c2 < 256) ? qs_unhex(c2) : -1;
      if (hexLow < 0) {
        out[w++] = '%';
        index++; /* Node: ++index then index-- — net one step */
        continue;
      }
      cur = (unsigned)(hexHigh * 16 + hexLow);
      index += 2;
    } else if (decode_spaces && cur == '+') {
      cur = ' ';
    }
    out[w++] = (unsigned char)(cur & 0xFF); /* Buffer write truncates */
    index++;
  }
  free(units);
  *out_len = w;
  return out;
}

/* unescapeBuffer(s).toString(): the replacement decode of the bytes. */
static ScrStr *qs_unescape_buffer(const ScrStr *s, bool decode_spaces) {
  size_t w;
  unsigned char *out = qs_unescape_bytes(s, decode_spaces, &w);
  ScrStr *res = qs_utf8_replace_decode(out, w);
  free(out);
  return res;
}

ScrBytes *scr_qs_unescape_buffer(const ScrStr *s, bool decode_spaces) {
  size_t w;
  unsigned char *out = qs_unescape_bytes(s, decode_spaces, &w);
  ScrBytes *buf = scr_buffer_alloc((double)w);
  if (buf && w) memcpy(buf->data, out, w);
  free(out);
  return buf;
}

ScrStr *scr_qs_unescape(const ScrStr *s) {
  ScrStr *strict = scr_str_decode_uri_component_try((ScrStr *)s);
  if (strict) return strict;
  return qs_unescape_buffer(s, false);
}

/* qsUnescape(s, true), parse's fallback when a custom decoder throws. */
static ScrStr *qs_unescape_spaces(const ScrStr *s) {
  ScrStr *strict = scr_str_decode_uri_component_try((ScrStr *)s);
  if (strict) return strict;
  return qs_unescape_buffer(s, true);
}

/* ── parse ───────────────────────────────────────────────────────────── */

/* Where parse's pairs land: the typed ParsedUrlQuery dictionary's overflow
 * map (its string and string[] union tags), or a checked-dynamic
 * null-prototype object (url.parse's parsed query). */
typedef struct {
  ScrMap *map;
  uint32_t str_tag, arr_tag;
  ScrDyn *obj;
  /* A custom decodeURIComponent (a function), or NULL for the default. */
  const ScrDyn *decoder;
} QsSink;

/* decodeStr(s, decoder): the decoder's string, or qsUnescape(s, true) when
 * it throws. A decoder that answers another value has no lowering (the
 * dictionary holds strings): NULL with SC2020 pending. */
static ScrStr *qs_decode_custom(const ScrDyn *decoder, ScrStr *s) {
  ScrDyn *arg = scr_dyn_new_str(s);
  ScrDyn *result = scr_dyn_call(decoder, &arg, 1, "decodeURIComponent");
  scr_dyn_release(arg);
  if (!result) {
    scr_exc_clear();
    ScrStr *fallback = qs_unescape_spaces(s);
    scr_str_release(s);
    return fallback;
  }
  scr_str_release(s);
  if (result->kind != SCR_DYN_STR) {
    scr_dyn_release(result);
    static const char message[] =
        "querystring.parse with a decodeURIComponent that answers a value that is not a string has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  ScrStr *text = scr_str_retain(result->v.str);
  scr_dyn_release(result);
  return text;
}

/* addKeyVal's tail: decode-if-encoded, then group (first value = a
 * string; a repeat REPLACES it with a two-element string array; later
 * repeats push). key/value move in. False with an exception pending. */
static bool qs_add_key_val(QsSink *out, ScrStr *key, ScrStr *value,
                           bool key_encoded, bool val_encoded) {
  if (key->len > 0 && key_encoded) {
    ScrStr *dec = out->decoder ? qs_decode_custom(out->decoder, scr_str_retain(key)) : scr_qs_unescape(key);
    scr_str_release(key);
    if (!dec) {
      scr_str_release(value);
      return false;
    }
    key = dec;
  }
  if (value->len > 0 && val_encoded) {
    ScrStr *dec = out->decoder ? qs_decode_custom(out->decoder, scr_str_retain(value)) : scr_qs_unescape(value);
    scr_str_release(value);
    if (!dec) {
      scr_str_release(key);
      return false;
    }
    value = dec;
  }
  if (out->obj) {
    ScrDyn *cur = scr_dyn_obj_get(out->obj, key->data, key->len);
    ScrDyn *boxed = scr_dyn_new_str(value);
    scr_str_release(value);
    if (!cur) {
      scr_dyn_obj_set(out->obj, key->data, key->len, boxed);
    } else if (cur->kind == SCR_DYN_STR) {
      ScrDyn *rows = scr_dyn_new_arr();
      scr_dyn_arr_push(rows, scr_dyn_retain(cur));
      scr_dyn_arr_push(rows, boxed);
      scr_dyn_obj_set(out->obj, key->data, key->len, rows);
    } else {
      scr_dyn_arr_push(cur, boxed);
    }
    scr_str_release(key);
    return true;
  }
  uint32_t str_tag = out->str_tag, arr_tag = out->arr_tag;
  ScrUnion *cell = scr_map_get_str_ref(out->map, key);
  if (!cell) {
    scr_map_set_str_ref(out->map, key,
                        scr_union_new_ref(str_tag, value, &scr_str_retain_v,
                                          &scr_str_release_v, NULL));
    scr_str_release(key);
    return true;
  }
  if (cell->tag == str_tag) {
    /* obj[key] = [curValue, value] */
    ScrArr *rows = scr_arr_new(SCR_ELEM_STR, 2);
    scr_arr_push_ref(rows, scr_str_retain_v(scr_union_peek(cell)));
    scr_arr_push_ref(rows, value);
    scr_map_set_str_ref(out->map, key,
                        scr_union_new_ref(arr_tag, rows, &scr_arr_retain_v,
                                          &scr_arr_release_v, NULL));
  } else {
    scr_arr_push_ref((ScrArr *)scr_union_peek(cell), value);
  }
  scr_union_release(cell);
  scr_str_release(key);
  return true;
}

static void qs_parse(QsSink *out, const ScrStr *qs, const ScrStr *sep,
                     const ScrStr *eq, double max_keys) {
  if (qs->len == 0) return;
  /* NULL is the default; the frontend resolves Node's falsy rule, so an
   * empty sequence here is an explicitly empty one (String([]) is ''),
   * which never matches. */
  const char *sep_b = sep ? sep->data : "&";
  size_t sep_len = sep ? sep->len : 1;
  const char *eq_b = eq ? eq->data : "=";
  size_t eq_len = eq ? eq->len : 1;

  /* pairs: Node's `maxKeys > 0 ? maxKeys : -1` as a double so Infinity
   * decrements forever, exactly like Node's -1 sentinel. */
  double pairs = max_keys > 0 ? max_keys : -1;

  const char *p = qs->data;
  size_t n = qs->len;
  QsBuf key, value;
  qb_init(&key);
  qb_init(&value);
  size_t last_pos = 0, sep_idx = 0, eq_idx = 0;
  /* A custom decoder decodes every key and value, and '+' reads as "%20"
   * for it to decode. */
  const bool custom = out->decoder != NULL;
  const char *plus = custom ? "%20" : " ";
  const size_t plus_len = custom ? 3 : 1;
  bool key_encoded = custom, val_encoded = custom;
  int encode_check = 0;
  bool returned = false;

  for (size_t i = 0; i < n; ++i) {
    unsigned char code = (unsigned char)p[i];

    /* Try matching the pair separator (e.g. '&'). */
    if (sep_len > 0 && code == (unsigned char)sep_b[sep_idx]) {
      if (++sep_idx == sep_len) {
        /* Key/value pair separator match. */
        size_t end = i - sep_idx + 1;
        if (eq_idx < eq_len) {
          /* No (entire) key/value separator seen. */
          if (last_pos < end) {
            qb_append(&key, p + last_pos, end - last_pos);
          } else if (key.len == 0) {
            /* An empty substring between separators. */
            if (--pairs == 0) { returned = true; break; }
            last_pos = i + 1;
            sep_idx = eq_idx = 0;
            continue;
          }
        } else if (last_pos < end) {
          qb_append(&value, p + last_pos, end - last_pos);
        }

        if (!qs_add_key_val(out, scr_str_new(key.data, key.len),
                            scr_str_new(value.data, value.len), key_encoded,
                            val_encoded)) {
          returned = true;
          break;
        }

        if (--pairs == 0) { returned = true; break; }
        key_encoded = val_encoded = custom;
        key.len = value.len = 0;
        encode_check = 0;
        last_pos = i + 1;
        sep_idx = eq_idx = 0;
      }
    } else {
      sep_idx = 0;
      /* Try matching the key/value separator (e.g. '=') if we haven't. */
      if (eq_idx < eq_len) {
        if (code == (unsigned char)eq_b[eq_idx]) {
          if (++eq_idx == eq_len) {
            /* Key/value separator match. */
            size_t end = i - eq_idx + 1;
            if (last_pos < end) qb_append(&key, p + last_pos, end - last_pos);
            encode_check = 0;
            last_pos = i + 1;
          }
          continue;
        }
        eq_idx = 0;
        if (!key_encoded) {
          /* Match a valid encoded byte once, to minimize decode calls. */
          if (code == '%') {
            encode_check = 1;
            continue;
          } else if (encode_check > 0) {
            if (qs_unhex(code) >= 0) {
              if (++encode_check == 3) key_encoded = true;
              continue;
            } else {
              encode_check = 0;
            }
          }
        }
        if (code == '+') {
          if (last_pos < i) qb_append(&key, p + last_pos, i - last_pos);
          qb_append(&key, plus, plus_len);
          last_pos = i + 1;
          continue;
        }
      }
      if (code == '+') {
        if (last_pos < i) qb_append(&value, p + last_pos, i - last_pos);
        qb_append(&value, plus, plus_len);
        last_pos = i + 1;
      } else if (!val_encoded) {
        if (code == '%') {
          encode_check = 1;
        } else if (encode_check > 0) {
          if (qs_unhex(code) >= 0) {
            if (++encode_check == 3) val_encoded = true;
          } else {
            encode_check = 0;
          }
        }
      }
    }
  }

  if (!returned) {
    /* Leftover key or value data. */
    bool ended_empty = false;
    if (last_pos < n) {
      if (eq_idx < eq_len) qb_append(&key, p + last_pos, n - last_pos);
      else if (sep_idx < sep_len) qb_append(&value, p + last_pos, n - last_pos);
    } else if (eq_idx == 0 && key.len == 0) {
      ended_empty = true; /* ended on an empty substring */
    }
    if (!ended_empty) {
      (void)qs_add_key_val(out, scr_str_new(key.data, key.len),
                           scr_str_new(value.data, value.len), key_encoded,
                           val_encoded);
    }
  }
  free(key.data);
  free(value.data);
}

void scr_qs_parse_into(ScrMap *out, const ScrStr *qs, const ScrStr *sep,
                       const ScrStr *eq, double max_keys, uint32_t str_tag,
                       uint32_t arr_tag) {
  QsSink sink = {.map = out, .str_tag = str_tag, .arr_tag = arr_tag};
  qs_parse(&sink, qs, sep, eq, max_keys);
}

void scr_qs_parse_into_custom(ScrMap *out, const ScrStr *qs, const ScrStr *sep,
                              const ScrStr *eq, double max_keys, const ScrDyn *decoder,
                              uint32_t str_tag, uint32_t arr_tag) {
  QsSink sink = {.map = out, .str_tag = str_tag, .arr_tag = arr_tag,
                 .decoder = decoder->kind == SCR_DYN_FUNC ? decoder : NULL};
  qs_parse(&sink, qs, sep, eq, max_keys);
}

ScrDyn *scr_qs_parse_dyn(const ScrStr *qs) {
  QsSink sink = {.obj = scr_dyn_new_obj_null_proto()};
  qs_parse(&sink, qs, NULL, NULL, 1000);
  /* Rebuild in JS own-key order (array-index keys ascending first), the
   * order Node's object holds them in. */
  ScrDyn *keys = scr_dyn_obj_keys(sink.obj);
  ScrDyn *out = scr_dyn_new_obj_null_proto();
  for (size_t i = 0; i < keys->v.arr.len; i++) {
    const ScrStr *k = keys->v.arr.items[i]->v.str;
    ScrDyn *v = scr_dyn_obj_get(sink.obj, k->data, k->len);
    scr_dyn_obj_set(out, k->data, k->len, scr_dyn_retain(v));
  }
  scr_dyn_release(keys);
  scr_dyn_release(sink.obj);
  return out;
}

/* ── stringify ───────────────────────────────────────────────────────── */

/* Node's encodeStringified over one dyn value: strings escape, finite
 * numbers render then escape, bigints and booleans are bare, everything
 * else is the empty value. Appends to b. */
static void qs_stringify_value(QsBuf *b, const ScrDyn *v) {
  switch (v->kind) {
    case SCR_DYN_STR: {
      ScrStr *enc = scr_qs_escape(v->v.str);
      qb_append_str(b, enc);
      scr_str_release(enc);
      return;
    }
    case SCR_DYN_NUM: {
      if (!isfinite(v->v.num)) return;
      ScrStr *num = scr_f64_to_scrstr(v->v.num);
      ScrStr *enc = scr_str_encode_uri_component(num);
      qb_append_str(b, enc);
      scr_str_release(enc);
      scr_str_release(num);
      return;
    }
    case SCR_DYN_BIGINT: {
      ScrStr *text = scr_bigint_to_string(v->v.bigint, 10);
      qb_append_str(b, text);
      scr_str_release(text);
      return;
    }
    case SCR_DYN_BOOL:
      if (v->v.b) qb_append(b, "true", 4);
      else qb_append(b, "false", 5);
      return;
    default:
      return; /* null/undefined/symbols/objects/arrays/functions → '' */
  }
}

/* obj[k] (+1), read as Node's `const v = obj[k]` reads it: an array's
 * elements by index and its named properties by name, undefined for a key
 * removed after ObjectKeys. A capsule answers from its native value as it
 * is now, as the dynamic keyed read does. NULL with an exception pending
 * (a throwing getter). */
static ScrDyn *qs_read(const ScrDyn *obj, const ScrStr *k) {
  if (obj->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *fast = scr_dyn_typed_ref_key_get(obj, k);
    if (fast) return fast;
    ScrDyn *view = scr_dyn_typed_ref_materialize(obj);
    ScrDyn *v = view && !scr_exc_pending() ? qs_read(view, k) : NULL;
    scr_dyn_release(view);
    return v;
  }
  ScrDyn *v = scr_dyn_obj_read(obj, k->data, k->len);
  if (!v) return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  return v;
}

/* v[index] (+1) for an array or an array capsule; a hole reads undefined. */
static ScrDyn *qs_element(const ScrDyn *v, size_t index) {
  if (v->kind == SCR_DYN_ARR) return scr_dyn_arr_at(v, (double)index);
  char text[32];
  int length = snprintf(text, sizeof text, "%zu", index);
  ScrStr *key = scr_str_new(text, (size_t)length);
  ScrDyn *item = qs_read(v, key);
  scr_str_release(key);
  return item;
}

/* qs_read, with a capsule value answered by its materialized view. */
static ScrDyn *qs_member(const ScrDyn *obj, const ScrStr *k) {
  ScrDyn *v = qs_read(obj, k);
  if (!v || v->kind != SCR_DYN_TYPED_REF) return v;
  ScrDyn *view = scr_dyn_typed_ref_materialize(v);
  scr_dyn_release(v);
  if (view && scr_exc_pending()) {
    scr_dyn_release(view);
    return NULL;
  }
  return view;
}

ScrStr *scr_qs_stringify(const ScrDyn *obj, const ScrStr *sep,
                         const ScrStr *eq) {
  if (obj && obj->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(obj);
    ScrStr *result = view && !scr_exc_pending() ? scr_qs_stringify(view, sep, eq) : NULL;
    scr_dyn_release(view);
    return result;
  }
  const char *sep_b = sep ? sep->data : "&";
  size_t sep_len = sep ? sep->len : 1;
  const char *eq_b = eq ? eq->data : "=";
  size_t eq_len = eq ? eq->len : 1;
  /* An object, an array among them; any other value is the empty string. */
  if (!obj || (obj->kind != SCR_DYN_OBJ && obj->kind != SCR_DYN_ARR)) return scr_str_new("", 0);

  QsBuf fields;
  qb_init(&fields);
  /* JS own-key order (array-index keys ascending first) — ObjectKeys. An
   * array's keys are the indices of its present elements. */
  ScrDyn *keys = scr_dyn_obj_keys((ScrDyn *)obj);
  if (!keys) {
    free(fields.data);
    return NULL;
  }
  for (size_t i = 0; i < keys->v.arr.len; i++) {
    const ScrStr *k = keys->v.arr.items[i]->v.str;
    ScrDyn *v = qs_member(obj, k);
    if (!v) { scr_dyn_release(keys); free(fields.data); return NULL; }
    ScrStr *ks = scr_qs_escape((ScrStr *)k);
    if (v->kind == SCR_DYN_ARR) {
      for (size_t j = 0; j < v->v.arr.len; j++) {
        if (fields.len) qb_append(&fields, sep_b, sep_len);
        qb_append_str(&fields, ks);
        qb_append(&fields, eq_b, eq_len);
        ScrDyn *item = scr_dyn_arr_at(v, (double)j); /* a hole reads undefined */
        qs_stringify_value(&fields, item);
        scr_dyn_release(item);
      }
    } else {
      if (fields.len) qb_append(&fields, sep_b, sep_len);
      qb_append_str(&fields, ks);
      qb_append(&fields, eq_b, eq_len);
      qs_stringify_value(&fields, v);
    }
    scr_str_release(ks);
    scr_dyn_release(v);
  }
  scr_dyn_release(keys);
  if (scr_exc_pending()) { /* a lone surrogate: URIError [ERR_INVALID_URI] */
    free(fields.data);
    return NULL;
  }
  return qb_take(&fields);
}

/* stringify with a custom encodeURIComponent: Node's
 * encodeStringifiedCustom, encode(stringifyPrimitive(v)), over each key
 * (once per key, empty arrays included) and each value, in that order. The
 * encoder's answers append with `+`, as Node's `fields +=` does. +1, or NULL
 * with the encoder's exception pending. */
static ScrDyn *qs_primitive_text(const ScrDyn *v) {
  switch (v->kind) {
    case SCR_DYN_STR:
      return scr_dyn_retain((ScrDyn *)v);
    case SCR_DYN_NUM:
      if (isfinite(v->v.num)) {
        ScrStr *num = scr_f64_to_scrstr(v->v.num);
        ScrDyn *out = scr_dyn_new_str(num);
        scr_str_release(num);
        return out;
      }
      break;
    case SCR_DYN_BIGINT: {
      ScrStr *text = scr_bigint_to_string(v->v.bigint, 10);
      ScrDyn *out = scr_dyn_new_str(text);
      scr_str_release(text);
      return out;
    }
    case SCR_DYN_BOOL: {
      ScrStr *text = v->v.b ? scr_str_new("true", 4) : scr_str_new("false", 5);
      ScrDyn *out = scr_dyn_new_str(text);
      scr_str_release(text);
      return out;
    }
    default:
      break;
  }
  ScrStr *empty = scr_str_new("", 0);
  ScrDyn *out = scr_dyn_new_str(empty);
  scr_str_release(empty);
  return out;
}

/* fields + encode(text): the encoder's answer appended with `+`. */
static ScrDyn *qs_append_encoded(ScrDyn *fields, const ScrDyn *encoder, const ScrDyn *value) {
  ScrDyn *text = qs_primitive_text(value);
  ScrDyn *encoded = scr_dyn_call(encoder, &text, 1, "encodeURIComponent");
  scr_dyn_release(text);
  if (!encoded) {
    scr_dyn_release(fields);
    return NULL;
  }
  ScrDyn *joined = scr_dyn_add(fields, encoded);
  scr_dyn_release(encoded);
  scr_dyn_release(fields);
  return joined;
}

static ScrDyn *qs_append_text(ScrDyn *fields, const char *bytes, size_t len) {
  ScrStr *text = scr_str_new(bytes, len);
  ScrDyn *piece = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrDyn *joined = scr_dyn_add(fields, piece);
  scr_dyn_release(piece);
  scr_dyn_release(fields);
  return joined;
}

ScrStr *scr_qs_stringify_custom(const ScrDyn *obj, const ScrStr *sep, const ScrStr *eq,
                                const ScrDyn *encoder) {
  if (encoder->kind != SCR_DYN_FUNC) return scr_qs_stringify(obj, sep, eq);
  const char *sep_b = sep ? sep->data : "&";
  size_t sep_len = sep ? sep->len : 1;
  const char *eq_b = eq ? eq->data : "=";
  size_t eq_len = eq ? eq->len : 1;
  if (!obj) return scr_str_new("", 0);
  /* ObjectKeys once; the values are read from obj itself as the loop
   * reaches them, so a capsule answers what the encoder has changed. */
  ScrDyn *keys = NULL;
  if (obj->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(obj);
    if (!view || scr_exc_pending()) {
      scr_dyn_release(view);
      return NULL;
    }
    if (view->kind == SCR_DYN_OBJ || view->kind == SCR_DYN_ARR) keys = scr_dyn_obj_keys(view);
    else keys = scr_dyn_new_arr();
    scr_dyn_release(view);
  } else if (obj->kind == SCR_DYN_OBJ || obj->kind == SCR_DYN_ARR) {
    keys = scr_dyn_obj_keys((ScrDyn *)obj);
  } else {
    return scr_str_new("", 0);
  }
  if (!keys) return NULL;
  ScrStr *empty = scr_str_new("", 0);
  ScrDyn *fields = scr_dyn_new_str(empty);
  scr_str_release(empty);
  bool any = false;
  for (size_t i = 0; fields && i < keys->v.arr.len; i++) {
    const ScrDyn *kd = keys->v.arr.items[i];
    /* v is held across the encoder calls below, which may replace or
     * delete obj[k]. */
    ScrDyn *v = qs_read(obj, kd->v.str);
    if (!v) {
      scr_dyn_release(fields);
      fields = NULL;
      break;
    }
    /* ks = convert(k, encode) + eq */
    ScrDyn *ks = NULL;
    {
      ScrDyn *text = qs_primitive_text(kd);
      ScrDyn *encoded = scr_dyn_call(encoder, &text, 1, "encodeURIComponent");
      scr_dyn_release(text);
      if (encoded) {
        ScrStr *eqs = scr_str_new(eq_b, eq_len);
        ScrDyn *eqd = scr_dyn_new_str(eqs);
        scr_str_release(eqs);
        ks = scr_dyn_add(encoded, eqd);
        scr_dyn_release(eqd);
        scr_dyn_release(encoded);
      }
    }
    if (!ks) {
      scr_dyn_release(v);
      scr_dyn_release(fields);
      fields = NULL;
      break;
    }
    /* ArrayIsArray(v) and v.length, after the key's encoder call. */
    bool array = v->kind == SCR_DYN_ARR;
    size_t vlen = array ? v->v.arr.len : 0;
    if (v->kind == SCR_DYN_TYPED_REF) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(v);
      if (!view || scr_exc_pending()) {
        scr_dyn_release(view);
        scr_dyn_release(ks);
        scr_dyn_release(v);
        scr_dyn_release(fields);
        fields = NULL;
        break;
      }
      array = view->kind == SCR_DYN_ARR;
      vlen = array ? view->v.arr.len : 0;
      scr_dyn_release(view);
    }
    if (array) {
      /* Node reads the length once and each element as the loop reaches
       * it: an encoder that grows the array adds no values, and one that
       * shrinks it leaves empty values. */
      for (size_t j = 0; fields && j < vlen; j++) {
        if (any) fields = qs_append_text(fields, sep_b, sep_len);
        if (fields) {
          ScrDyn *joined = scr_dyn_add(fields, ks);
          scr_dyn_release(fields);
          fields = joined;
        }
        if (fields) {
          ScrDyn *item = qs_element(v, j);
          if (item) fields = qs_append_encoded(fields, encoder, item);
          else {
            scr_dyn_release(fields);
            fields = NULL;
          }
          scr_dyn_release(item);
        }
        any = true;
      }
    } else {
      if (any) fields = qs_append_text(fields, sep_b, sep_len);
      if (fields) {
        ScrDyn *joined = scr_dyn_add(fields, ks);
        scr_dyn_release(fields);
        fields = joined;
      }
      if (fields) fields = qs_append_encoded(fields, encoder, v);
      any = true;
    }
    scr_dyn_release(ks);
    scr_dyn_release(v);
  }
  scr_dyn_release(keys);
  if (!fields) return NULL;
  ScrStr *out = scr_str_retain(fields->v.str);
  scr_dyn_release(fields);
  return out;
}

/* A sep or eq argument that may not be a string: a falsy value is the
 * default. parse converts any other value with String(value), once.
 * stringify appends the value with `+=` at each separator, which converts
 * an object again each time and throws for a symbol only once a separator
 * is appended: those have no lowering there (SC2020); other values convert
 * as String(value) does. +1, or NULL with the exception pending. */
ScrStr *scr_qs_separator(const ScrDyn *value, const ScrStr *fallback, bool parse) {
  if (!scr_dyn_truthy(value)) return scr_str_retain((ScrStr *)fallback);
  if (!parse && (value->kind == SCR_DYN_SYMBOL || value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR ||
                 value->kind == SCR_DYN_FUNC || value->kind == SCR_DYN_TYPED_REF || value->kind == SCR_DYN_BYTES ||
                 value->kind == SCR_DYN_HANDLE || value->kind == SCR_DYN_PROXY || value->kind == SCR_DYN_PROMISE)) {
    static const char message[] =
        "querystring.stringify with a separator that is an object or a symbol has no lowering; pass a string";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  return scr_dyn_string_constructor(value);
}
