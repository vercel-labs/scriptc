/* URLSearchParams (scr_runtime.h has the API contract): the WHATWG
 * application/x-www-form-urlencoded list, standalone or as a URL's LIVE
 * query view. LINK-GATED: compiled into the binary only when the IR uses
 * the searchParams surface (moduleUsesSearchParams — the scr_symbol
 * gating precedent), so sp-free programs pay zero bytes; scr_url.c stays
 * always-linked and never references this unit. Shares only the parsed
 * URL layout (scr_url_internal.h) with the url unit — the buffer and
 * hex helpers below are this unit's own statics. */
#include "scr_runtime.h"
#include "scr_url_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── a tiny growable byte buffer (scr_url.c's, redeclared locally) ───── */

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} UrlBuf;

static void ub_init(UrlBuf *b) {
  b->cap = 64;
  b->len = 0;
  b->data = malloc(b->cap);
  if (!b->data) {
    scr_trap("scriptc: out of memory\n");
  }
}

static void ub_append(UrlBuf *b, const char *bytes, size_t n) {
  if (b->len + n > b->cap) {
    while (b->len + n > b->cap) b->cap *= 2;
    char *grown = realloc(b->data, b->cap);
    if (!grown) {
      scr_trap("scriptc: out of memory\n");
    }
    b->data = grown;
  }
  memcpy(b->data + b->len, bytes, n);
  b->len += n;
}

static void ub_push(UrlBuf *b, char c) { ub_append(b, &c, 1); }

static ScrStr *ub_take(UrlBuf *b) {
  ScrStr *s = scr_str_new(b->data, b->len);
  free(b->data);
  return s;
}

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* ── URLSearchParams (WHATWG application/x-www-form-urlencoded) ───────
 *
 * A refcounted ordered list of (name, value) DECODED pairs. Standalone
 * (`new URLSearchParams(...)`) or the LIVE view of a URL's query
 * (`u.searchParams`): the view retains its URL, the URL caches the view
 * non-owningly (one identity, Node's cached object), and every mutation
 * re-serializes the list into the URL's query — href reflects
 * immediately, and emptying the list drops the '?' entirely (the spec's
 * update steps set a null query for the empty serialization).
 *
 * Parsing and serialization are the URL Standard's urlencoded pair
 * exactly (Node's byte behavior, pinned by the differential corpus):
 * parse splits on '&' (empty segments skipped), first '=' splits the
 * pair, '+' decodes to space, %XX decodes case-insensitively (malformed
 * escapes pass through verbatim), and the decoded BYTES pass through
 * UTF-8 decode-with-replacement (invalid sequences become U+FFFD per
 * maximal subpart — every stored string stays well-formed UTF-8);
 * serialize keeps [A-Za-z0-9*\-._] verbatim, encodes space as '+', and
 * percent-encodes every other byte as uppercase %XX. sort() is a STABLE
 * sort by the name's UTF-16 code units (the spec's order — supplementary
 * code points compare as their surrogate pairs, BELOW U+E000..U+FFFF,
 * where raw UTF-8 byte order would put them above). */

struct ScrSearchParams {
  size_t rc;
  size_t len, cap;
  ScrStr **names; /* decoded */
  ScrStr **vals;  /* decoded */
  ScrUrl *owner;  /* retained; NULL for standalone lists */
};

static ScrSearchParams *sp_alloc(void) {
  ScrSearchParams *sp = malloc(sizeof(ScrSearchParams));
  if (!sp) {
    scr_trap("scriptc: out of memory\n");
  }
  sp->rc = 1;
  sp->len = 0;
  sp->cap = 8;
  sp->names = malloc(sp->cap * sizeof(ScrStr *));
  sp->vals = malloc(sp->cap * sizeof(ScrStr *));
  if (!sp->names || !sp->vals) {
    scr_trap("scriptc: out of memory\n");
  }
  sp->owner = NULL;
  return sp;
}

ScrSearchParams *scr_sp_retain(ScrSearchParams *sp) {
  if (sp->rc != SIZE_MAX) sp->rc++;
  return sp;
}

void scr_sp_release(ScrSearchParams *sp) {
  if (!sp || sp->rc == SIZE_MAX) return;
  if (--sp->rc == 0) {
    for (size_t i = 0; i < sp->len; i++) {
      scr_str_release(sp->names[i]);
      scr_str_release(sp->vals[i]);
    }
    free(sp->names);
    free(sp->vals);
    if (sp->owner) {
      sp->owner->sp_cache = NULL;
      scr_url_release(sp->owner);
    }
    free(sp);
  }
}

void *scr_sp_retain_v(void *p) { return scr_sp_retain(p); }
void scr_sp_release_v(void *p) { scr_sp_release(p); }

/* Takes ownership of both strings. */
static void sp_push(ScrSearchParams *sp, ScrStr *name, ScrStr *value) {
  if (sp->len == sp->cap) {
    sp->cap *= 2;
    ScrStr **gn = realloc(sp->names, sp->cap * sizeof(ScrStr *));
    ScrStr **gv = realloc(sp->vals, sp->cap * sizeof(ScrStr *));
    if (!gn || !gv) {
      scr_trap("scriptc: out of memory\n");
    }
    sp->names = gn;
    sp->vals = gv;
  }
  sp->names[sp->len] = name;
  sp->vals[sp->len] = value;
  sp->len++;
}

/* WHATWG UTF-8 decode with U+FFFD replacement per maximal invalid subpart
 * — percent-decoding produces arbitrary BYTES, and Node runs them through
 * this exact decode (scr_bytes.c's toString("utf8") twin; duplicated so
 * the always-linked url unit stays self-contained). */
static ScrStr *sp_scrub_utf8(const char *in_c, size_t n) {
  const unsigned char *in = (const unsigned char *)in_c;
  char *out = malloc(n * 3 + 1);
  if (!out) {
    scr_trap("scriptc: out of memory\n");
  }
  size_t o = 0;
  uint32_t cp = 0;
  int needed = 0;
  unsigned char lower = 0x80, upper = 0xbf;
  for (size_t i = 0; i <= n; i++) {
    if (i == n) {
      if (needed > 0) {
        memcpy(out + o, "\xef\xbf\xbd", 3);
        o += 3;
      }
      break;
    }
    unsigned char byte = in[i];
    if (needed == 0) {
      if (byte <= 0x7f) {
        out[o++] = (char)byte;
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1; cp = byte & 0x1fu;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte == 0xe0) lower = 0xa0;
        if (byte == 0xed) upper = 0x9f;
        needed = 2; cp = byte & 0xfu;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte == 0xf0) lower = 0x90;
        if (byte == 0xf4) upper = 0x8f;
        needed = 3; cp = byte & 0x7u;
      } else {
        memcpy(out + o, "\xef\xbf\xbd", 3);
        o += 3;
      }
      continue;
    }
    if (byte < lower || byte > upper) {
      memcpy(out + o, "\xef\xbf\xbd", 3);
      o += 3;
      needed = 0; lower = 0x80; upper = 0xbf;
      i--;
      continue;
    }
    lower = 0x80; upper = 0xbf;
    cp = (cp << 6) | (byte & 0x3fu);
    if (--needed == 0) {
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

/* One urlencoded piece → decoded string: '+' is space, %XX decodes
 * (malformed escapes pass through verbatim), then the UTF-8 scrub. */
static ScrStr *sp_decode_piece(const char *s, size_t len) {
  UrlBuf b;
  ub_init(&b);
  for (size_t i = 0; i < len; i++) {
    char c = s[i];
    if (c == '+') {
      ub_push(&b, ' ');
    } else if (c == '%' && i + 2 < len && hex_val(s[i + 1]) >= 0 && hex_val(s[i + 2]) >= 0) {
      ub_push(&b, (char)((hex_val(s[i + 1]) << 4) | hex_val(s[i + 2])));
      i += 2;
    } else {
      ub_push(&b, c);
    }
  }
  ScrStr *out = sp_scrub_utf8(b.data, b.len);
  free(b.data);
  return out;
}

/* The urlencoded serializer's byte set: [A-Za-z0-9*\-._] verbatim, space
 * as '+', everything else uppercase %XX. */
static void sp_encode_piece(UrlBuf *b, const ScrStr *s) {
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (c == ' ') {
      ub_push(b, '+');
    } else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
               c == '*' || c == '-' || c == '.' || c == '_') {
      ub_push(b, (char)c);
    } else {
      char hex[4];
      snprintf(hex, sizeof hex, "%%%02X", c);
      ub_append(b, hex, 3);
    }
  }
}

/* Parses an urlencoded body into the list (no leading '?' here). */
static void sp_parse_into(ScrSearchParams *sp, const char *s, size_t len) {
  size_t start = 0;
  for (size_t i = 0; i <= len; i++) {
    if (i < len && s[i] != '&') continue;
    if (i > start) {
      size_t eq = i; /* first '=' inside [start, i) */
      for (size_t j = start; j < i; j++) {
        if (s[j] == '=') {
          eq = j;
          break;
        }
      }
      ScrStr *name = sp_decode_piece(s + start, eq - start);
      ScrStr *value = eq < i ? sp_decode_piece(s + eq + 1, i - eq - 1) : scr_str_new("", 0);
      sp_push(sp, name, value);
    }
    start = i + 1;
  }
}

ScrStr *scr_sp_to_string(ScrSearchParams *sp) {
  UrlBuf b;
  ub_init(&b);
  for (size_t i = 0; i < sp->len; i++) {
    if (i > 0) ub_push(&b, '&');
    sp_encode_piece(&b, sp->names[i]);
    ub_push(&b, '=');
    sp_encode_piece(&b, sp->vals[i]);
  }
  return ub_take(&b);
}

/* The live view's write-back: re-serialize the list into the owner's
 * query ("?..." or "", the spec's null-query for an empty serialization).
 * href/search read the field directly, so the update is visible at once. */
static void sp_sync_owner(ScrSearchParams *sp) {
  if (!sp->owner) return;
  scr_str_release(sp->owner->query);
  if (sp->len == 0) {
    sp->owner->query = scr_str_new("", 0);
    return;
  }
  UrlBuf b;
  ub_init(&b);
  ub_push(&b, '?');
  for (size_t i = 0; i < sp->len; i++) {
    if (i > 0) ub_push(&b, '&');
    sp_encode_piece(&b, sp->names[i]);
    ub_push(&b, '=');
    sp_encode_piece(&b, sp->vals[i]);
  }
  sp->owner->query = ub_take(&b);
}

ScrSearchParams *scr_sp_new(void) { return sp_alloc(); }

ScrSearchParams *scr_sp_parse(ScrStr *init) {
  ScrSearchParams *sp = sp_alloc();
  const char *s = init->data;
  size_t len = init->len;
  if (len > 0 && s[0] == '?') {
    s++;
    len--;
  }
  sp_parse_into(sp, s, len);
  return sp;
}

ScrSearchParams *scr_sp_copy(ScrSearchParams *src) {
  ScrSearchParams *sp = sp_alloc();
  for (size_t i = 0; i < src->len; i++) {
    sp_push(sp, scr_str_retain(src->names[i]), scr_str_retain(src->vals[i]));
  }
  return sp;
}

/* string[][] init: each row must be a [name, value] pair — Node's
 * ERR_INVALID_TUPLE TypeError otherwise. */
ScrSearchParams *scr_sp_from_pairs(ScrArr *pairs) {
  size_t n = (size_t)scr_arr_len(pairs);
  for (size_t i = 0; i < n; i++) {
    ScrArr *row = scr_arr_get_ref(pairs, (double)i);
    double rl = scr_arr_len(row);
    scr_arr_release(row);
    if (rl != 2) {
      static const char tuple_msg[] = "Each query pair must be an iterable [name, value] tuple";
      scr_throw_error_msg_code(SCR_ERR_TYPE, tuple_msg, sizeof tuple_msg - 1,
                               "ERR_INVALID_TUPLE");
      return NULL;
    }
  }
  ScrSearchParams *sp = sp_alloc();
  for (size_t i = 0; i < n; i++) {
    ScrArr *row = scr_arr_get_ref(pairs, (double)i);
    ScrStr *name = scr_arr_get_ref(row, 0);
    ScrStr *value = scr_arr_get_ref(row, 1);
    scr_arr_release(row);
    sp_push(sp, name, value); /* ownership of the +1 reads passes in */
  }
  return sp;
}

/* The record-literal init desugar: append one pair, answer the SAME list
 * +1 (`new URLSearchParams({a: "1", b: "2"})` folds to a with-chain). */
ScrSearchParams *scr_sp_with(ScrSearchParams *sp, ScrStr *name, ScrStr *value) {
  sp_push(sp, scr_str_retain(name), scr_str_retain(value));
  return scr_sp_retain(sp);
}

ScrSearchParams *scr_url_search_params(ScrUrl *u) {
  if (u->sp_cache) return scr_sp_retain(u->sp_cache);
  ScrSearchParams *sp = sp_alloc();
  if (u->query->len > 1) sp_parse_into(sp, u->query->data + 1, u->query->len - 1);
  sp->owner = scr_url_retain(u);
  u->sp_cache = sp;
  return sp;
}

void scr_sp_append(ScrSearchParams *sp, ScrStr *name, ScrStr *value) {
  sp_push(sp, scr_str_retain(name), scr_str_retain(value));
  sp_sync_owner(sp);
}

static bool sp_str_eq(const ScrStr *a, const ScrStr *b) {
  return a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
}

void scr_sp_set(ScrSearchParams *sp, ScrStr *name, ScrStr *value) {
  size_t w = 0;
  bool replaced = false;
  for (size_t i = 0; i < sp->len; i++) {
    if (sp_str_eq(sp->names[i], name)) {
      if (!replaced) {
        replaced = true;
        scr_str_release(sp->vals[i]);
        sp->vals[i] = scr_str_retain(value);
        sp->names[w] = sp->names[i];
        sp->vals[w] = sp->vals[i];
        w++;
      } else {
        scr_str_release(sp->names[i]);
        scr_str_release(sp->vals[i]);
      }
    } else {
      sp->names[w] = sp->names[i];
      sp->vals[w] = sp->vals[i];
      w++;
    }
  }
  sp->len = w;
  if (!replaced) sp_push(sp, scr_str_retain(name), scr_str_retain(value));
  sp_sync_owner(sp);
}

static void sp_delete_impl(ScrSearchParams *sp, ScrStr *name, ScrStr *value) {
  size_t w = 0;
  for (size_t i = 0; i < sp->len; i++) {
    bool drop = sp_str_eq(sp->names[i], name) && (!value || sp_str_eq(sp->vals[i], value));
    if (drop) {
      scr_str_release(sp->names[i]);
      scr_str_release(sp->vals[i]);
    } else {
      sp->names[w] = sp->names[i];
      sp->vals[w] = sp->vals[i];
      w++;
    }
  }
  sp->len = w;
  sp_sync_owner(sp);
}

void scr_sp_delete(ScrSearchParams *sp, ScrStr *name) { sp_delete_impl(sp, name, NULL); }
void scr_sp_delete_value(ScrSearchParams *sp, ScrStr *name, ScrStr *value) {
  sp_delete_impl(sp, name, value);
}

ScrStr *scr_sp_get(ScrSearchParams *sp, ScrStr *name) {
  for (size_t i = 0; i < sp->len; i++) {
    if (sp_str_eq(sp->names[i], name)) return scr_str_retain(sp->vals[i]);
  }
  return NULL;
}

ScrArr *scr_sp_get_all(ScrSearchParams *sp, ScrStr *name) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 4);
  for (size_t i = 0; i < sp->len; i++) {
    if (sp_str_eq(sp->names[i], name)) scr_arr_push_ref(out, scr_str_retain(sp->vals[i]));
  }
  return out;
}

bool scr_sp_has(ScrSearchParams *sp, ScrStr *name) {
  for (size_t i = 0; i < sp->len; i++) {
    if (sp_str_eq(sp->names[i], name)) return true;
  }
  return false;
}

bool scr_sp_has_value(ScrSearchParams *sp, ScrStr *name, ScrStr *value) {
  for (size_t i = 0; i < sp->len; i++) {
    if (sp_str_eq(sp->names[i], name) && sp_str_eq(sp->vals[i], value)) return true;
  }
  return false;
}

/* Stable insertion sort by name (lists are small; equal names keep their
 * relative order — the spec's stability requirement). */
void scr_sp_sort(ScrSearchParams *sp) {
  for (size_t i = 1; i < sp->len; i++) {
    ScrStr *n = sp->names[i];
    ScrStr *v = sp->vals[i];
    size_t j = i;
    while (j > 0 && scr_str_cmp_u16(sp->names[j - 1], n) > 0) {
      sp->names[j] = sp->names[j - 1];
      sp->vals[j] = sp->vals[j - 1];
      j--;
    }
    sp->names[j] = n;
    sp->vals[j] = v;
  }
  sp_sync_owner(sp);
}

double scr_sp_size(ScrSearchParams *sp) { return (double)sp->len; }

/* Iteration primitives: the desugared for-of/forEach walk re-reads the
 * count every pass (the spec's index-based live iteration — entries
 * appended mid-walk are visited, deletions shift). The index is guarded
 * by the loop condition; out-of-range reads answer "" defensively. */
ScrStr *scr_sp_key_at(ScrSearchParams *sp, double i) {
  size_t idx = (size_t)i;
  if (idx >= sp->len) return scr_str_new("", 0);
  return scr_str_retain(sp->names[idx]);
}

ScrStr *scr_sp_val_at(ScrSearchParams *sp, double i) {
  size_t idx = (size_t)i;
  if (idx >= sp->len) return scr_str_new("", 0);
  return scr_str_retain(sp->vals[idx]);
}
