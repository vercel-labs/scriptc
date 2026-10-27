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

/* Node's unescapeBuffer(s) (decodeSpaces false — neither qsUnescape nor
 * the exported unescape passes it) over the UTF-16 units, then the
 * replacement decode of the byte buffer. */
static ScrStr *qs_unescape_buffer(const ScrStr *s) {
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
    }
    out[w++] = (unsigned char)(cur & 0xFF); /* Buffer write truncates */
    index++;
  }
  free(units);
  ScrStr *res = qs_utf8_replace_decode(out, w);
  free(out);
  return res;
}

ScrStr *scr_qs_unescape(const ScrStr *s) {
  ScrStr *strict = scr_str_decode_uri_component_try((ScrStr *)s);
  if (strict) return strict;
  return qs_unescape_buffer(s);
}

/* ── parse ───────────────────────────────────────────────────────────── */

/* Where parse's pairs land: the typed ParsedUrlQuery dictionary's overflow
 * map (its string and string[] union tags), or a checked-dynamic
 * null-prototype object (url.parse's parsed query). */
typedef struct {
  ScrMap *map;
  uint32_t str_tag, arr_tag;
  ScrDyn *obj;
} QsSink;

/* addKeyVal's tail: decode-if-encoded, then group (first value = a
 * string; a repeat REPLACES it with a two-element string array; later
 * repeats push). key/value move in. */
static void qs_add_key_val(QsSink *out, ScrStr *key, ScrStr *value,
                           bool key_encoded, bool val_encoded) {
  if (key->len > 0 && key_encoded) {
    ScrStr *dec = scr_qs_unescape(key);
    scr_str_release(key);
    key = dec;
  }
  if (value->len > 0 && val_encoded) {
    ScrStr *dec = scr_qs_unescape(value);
    scr_str_release(value);
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
    return;
  }
  uint32_t str_tag = out->str_tag, arr_tag = out->arr_tag;
  ScrUnion *cell = scr_map_get_str_ref(out->map, key);
  if (!cell) {
    scr_map_set_str_ref(out->map, key,
                        scr_union_new_ref(str_tag, value, &scr_str_retain_v,
                                          &scr_str_release_v, NULL));
    scr_str_release(key);
    return;
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
}

static void qs_parse(QsSink *out, const ScrStr *qs, const ScrStr *sep,
                     const ScrStr *eq, double max_keys) {
  if (qs->len == 0) return;
  /* Node's falsy rule: undefined/null/'' all mean the default. */
  const char *sep_b = (sep && sep->len) ? sep->data : "&";
  size_t sep_len = (sep && sep->len) ? sep->len : 1;
  const char *eq_b = (eq && eq->len) ? eq->data : "=";
  size_t eq_len = (eq && eq->len) ? eq->len : 1;

  /* pairs: Node's `maxKeys > 0 ? maxKeys : -1` as a double so Infinity
   * decrements forever, exactly like Node's -1 sentinel. */
  double pairs = max_keys > 0 ? max_keys : -1;

  const char *p = qs->data;
  size_t n = qs->len;
  QsBuf key, value;
  qb_init(&key);
  qb_init(&value);
  size_t last_pos = 0, sep_idx = 0, eq_idx = 0;
  bool key_encoded = false, val_encoded = false;
  int encode_check = 0;
  bool returned = false;

  for (size_t i = 0; i < n; ++i) {
    unsigned char code = (unsigned char)p[i];

    /* Try matching the pair separator (e.g. '&'). */
    if (code == (unsigned char)sep_b[sep_idx]) {
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

        qs_add_key_val(out, scr_str_new(key.data, key.len),
                       scr_str_new(value.data, value.len), key_encoded,
                       val_encoded);

        if (--pairs == 0) { returned = true; break; }
        key_encoded = val_encoded = false;
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
          qb_push(&key, ' ');
          last_pos = i + 1;
          continue;
        }
      }
      if (code == '+') {
        if (last_pos < i) qb_append(&value, p + last_pos, i - last_pos);
        qb_push(&value, ' ');
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
      qs_add_key_val(out, scr_str_new(key.data, key.len),
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

ScrStr *scr_qs_stringify(const ScrDyn *obj, const ScrStr *sep,
                         const ScrStr *eq) {
  if (obj && obj->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(obj);
    ScrStr *result = view && !scr_exc_pending() ? scr_qs_stringify(view, sep, eq) : NULL;
    scr_dyn_release(view);
    return result;
  }
  const char *sep_b = (sep && sep->len) ? sep->data : "&";
  size_t sep_len = (sep && sep->len) ? sep->len : 1;
  const char *eq_b = (eq && eq->len) ? eq->data : "=";
  size_t eq_len = (eq && eq->len) ? eq->len : 1;
  if (!obj || obj->kind != SCR_DYN_OBJ) return scr_str_new("", 0);

  QsBuf fields;
  qb_init(&fields);
  /* JS own-key order (array-index keys ascending first) — ObjectKeys. */
  ScrDyn *keys = scr_dyn_obj_keys((ScrDyn *)obj);
  for (size_t i = 0; i < keys->v.arr.len; i++) {
    const ScrDyn *kd = keys->v.arr.items[i];
    const ScrStr *k = kd->v.str;
    const ScrDyn *v = scr_dyn_obj_get(obj, k->data, k->len);
    if (!v) continue; /* unreachable: keys came from the object */
    ScrDyn *view = v->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(v) : NULL;
    if (view) v = view;
    if (scr_exc_pending()) { scr_dyn_release(view); scr_dyn_release(keys); free(fields.data); return NULL; }
    ScrStr *ks = scr_qs_escape((ScrStr *)k);
    if (v->kind == SCR_DYN_ARR) {
      for (size_t j = 0; j < v->v.arr.len; j++) {
        if (fields.len) qb_append(&fields, sep_b, sep_len);
        qb_append_str(&fields, ks);
        qb_append(&fields, eq_b, eq_len);
        qs_stringify_value(&fields, v->v.arr.items[j]);
      }
    } else {
      if (fields.len) qb_append(&fields, sep_b, sep_len);
      qb_append_str(&fields, ks);
      qb_append(&fields, eq_b, eq_len);
      qs_stringify_value(&fields, v);
    }
    scr_str_release(ks);
    scr_dyn_release(view);
  }
  scr_dyn_release(keys);
  if (scr_exc_pending()) { /* a lone surrogate: URIError [ERR_INVALID_URI] */
    free(fields.data);
    return NULL;
  }
  return qb_take(&fields);
}
