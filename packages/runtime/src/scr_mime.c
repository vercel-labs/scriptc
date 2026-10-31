/* node:util MIMEType and MIMEParams (Node's lib/internal/mime.js) as
 * native handles of the checked-dynamic tree. The parser scans UTF-16 code
 * units, as Node's string searches do, so error offsets match; every value
 * that survives validation is ASCII (types, subtypes, parameter names) or
 * Latin-1 (parameter values). MIMEParams keeps Map semantics: insertion
 * order, a set of an existing name keeps its place, and a deleted entry
 * leaves a gap that live iterators skip. A separate unit, linked only by
 * programs that construct these classes. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  size_t rc;
  ScrStr **keys;
  ScrStr **values; /* NULL for a deleted entry */
  size_t len, cap;
} ScrMimeParams;

typedef struct {
  size_t rc;
  ScrStr *type;
  ScrStr *subtype;
  ScrDyn *params; /* the MIMEParams handle box, owned */
} ScrMimeType;

static void scr_mime_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* ── code units ─────────────────────────────────────────────────────── */

typedef struct {
  uint16_t *units;
  size_t len;
} ScrMimeUnits;

static ScrMimeUnits scr_mime_units(ScrStr *text) {
  ScrMimeUnits out;
  out.len = (size_t)scr_str_utf16_len(text);
  out.units = malloc((out.len ? out.len : 1) * sizeof *out.units);
  if (!out.units) scr_mime_oom();
  for (size_t i = 0; i < out.len; i++) out.units[i] = (uint16_t)scr_str_char_code_at(text, (double)i);
  return out;
}

static bool scr_mime_ws(uint16_t c) { return c == '\r' || c == '\n' || c == '\t' || c == ' '; }

static bool scr_mime_token(uint16_t c) {
  if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) return true;
  return c != 0 && c < 0x80 && strchr("!#$%&'*+-.^_`|~", (char)c) != NULL;
}

static bool scr_mime_quoted(uint16_t c) {
  return c == '\t' || (c >= 0x20 && c <= 0x7E) || (c >= 0x80 && c <= 0xFF);
}

/* The index of the first unit of [from, to) outside the token set, as an
 * offset from `from`, or -1. */
static long scr_mime_invalid_token(const uint16_t *u, size_t from, size_t to) {
  for (size_t i = from; i < to; i++)
    if (!scr_mime_token(u[i])) return (long)(i - from);
  return -1;
}

/* A string of units that are all at most 0xFF, lowered (ASCII only) when
 * `lower`. +1. */
static ScrStr *scr_mime_latin1(const uint16_t *u, size_t from, size_t to, bool lower) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  for (size_t i = from; i < to; i++) {
    uint16_t c = u[i];
    if (lower && c >= 'A' && c <= 'Z') c = (uint16_t)(c + ('a' - 'A'));
    if (c < 0x80) {
      scr_jb_putc(&b, (char)c);
    } else {
      char pair[2] = {(char)(0xC0 | (c >> 6)), (char)(0x80 | (c & 0x3F))};
      scr_jb_write(&b, pair, 2);
    }
  }
  return scr_jb_finish(&b);
}

/* ERR_INVALID_MIME_SYNTAX(production, str, invalidIndex). */
static void scr_mime_syntax_fail(const char *production, const ScrStr *str, long index) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The MIME syntax for a ");
  scr_jb_puts(&b, production);
  scr_jb_puts(&b, " in \"");
  scr_jb_put_str(&b, str);
  scr_jb_puts(&b, "\" is invalid");
  if (index != -1) {
    char at[32];
    snprintf(at, sizeof at, " at %ld", index);
    scr_jb_puts(&b, at);
  }
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_MIME_SYNTAX");
  scr_str_release(message);
}

/* ── MIMEParams ─────────────────────────────────────────────────────── */

static ScrMimeParams *scr_mime_params_alloc(void) {
  ScrMimeParams *p = calloc(1, sizeof *p);
  if (!p) scr_mime_oom();
  p->rc = 1;
  return p;
}

static void *scr_mime_params_retain(void *h) {
  ((ScrMimeParams *)h)->rc++;
  return h;
}

static void scr_mime_params_release(void *h) {
  ScrMimeParams *p = h;
  if (!p || --p->rc > 0) return;
  for (size_t i = 0; i < p->len; i++) {
    scr_str_release(p->keys[i]);
    scr_str_release(p->values[i]);
  }
  free(p->keys);
  free(p->values);
  free(p);
}

static long scr_mime_params_find(const ScrMimeParams *p, const ScrStr *key) {
  for (size_t i = 0; i < p->len; i++)
    if (p->values[i] && scr_str_eq((ScrStr *)p->keys[i], (ScrStr *)key)) return (long)i;
  return -1;
}

/* Map.prototype.set: an existing name keeps its place. Both borrowed. */
static void scr_mime_params_put(ScrMimeParams *p, ScrStr *key, ScrStr *value) {
  long at = scr_mime_params_find(p, key);
  if (at >= 0) {
    scr_str_release(p->values[at]);
    p->values[at] = scr_str_retain(value);
    return;
  }
  if (p->len == p->cap) {
    p->cap = p->cap ? p->cap * 2 : 4;
    p->keys = realloc(p->keys, p->cap * sizeof *p->keys);
    p->values = realloc(p->values, p->cap * sizeof *p->values);
    if (!p->keys || !p->values) scr_mime_oom();
  }
  p->keys[p->len] = scr_str_retain(key);
  p->values[p->len] = scr_str_retain(value);
  p->len++;
}

/* Node's MIMEParams#parse over the text after the subtype's ';'. */
static void scr_mime_params_parse(ScrMimeParams *p, const uint16_t *u, size_t n) {
  size_t end = n;
  while (end > 0 && scr_mime_ws(u[end - 1])) end--;
  size_t pos = 0;
  while (pos < end) {
    while (pos < n && scr_mime_ws(u[pos])) pos++;
    size_t name_end = pos;
    while (name_end < n && u[name_end] != ';' && u[name_end] != '=') name_end++;
    size_t name_from = pos;
    pos = name_end;
    if (pos < end) {
      uint16_t c = u[pos];
      pos++;
      if (c == ';') continue;
    }
    if (pos >= end) break;
    uint16_t *value = NULL;
    size_t value_len = 0;
    if (u[pos] == '"') {
      pos++;
      /* QUOTED_VALUE_PATTERN: escaped units, a trailing backslash (group 1)
       * and the closing quote (group 2). */
      size_t i = pos;
      bool trailing_backslash = false, closed = false;
      while (i < n) {
        if (u[i] == '\\') {
          if (i + 1 == n) {
            trailing_backslash = true;
            i++;
            break;
          }
          bool pair = u[i + 1] >= 0xD800 && u[i + 1] <= 0xDBFF && i + 2 < n && u[i + 2] >= 0xDC00 && u[i + 2] <= 0xDFFF;
          i += pair ? 3 : 2;
        } else if (u[i] != '"') {
          i++;
        } else {
          break;
        }
      }
      if (i < n && u[i] == '"' && !trailing_backslash) {
        closed = true;
        i++;
      }
      size_t match = i - pos;
      size_t inside = trailing_backslash || closed ? match - 1 : match;
      value = malloc((inside + 2) * sizeof *value);
      if (!value) scr_mime_oom();
      /* removeBackslashes, then the unmatched backslash back at the end. */
      size_t k;
      for (k = 0; inside > 0 && k < inside - 1; k++) {
        uint16_t c = u[pos + k];
        if (c == '\\') {
          k++;
          value[value_len++] = u[pos + k];
        } else {
          value[value_len++] = c;
        }
      }
      if (inside > 0 && k == inside - 1) value[value_len++] = u[pos + k];
      if (trailing_backslash) value[value_len++] = '\\';
      pos += match;
    } else {
      size_t value_end = pos;
      while (value_end < n && u[value_end] != ';') value_end++;
      size_t trimmed = value_end;
      while (trimmed > pos && scr_mime_ws(u[trimmed - 1])) trimmed--;
      size_t raw = value_end - pos;
      if (trimmed == pos) {
        pos += raw;
        continue;
      }
      value_len = trimmed - pos;
      value = malloc(value_len * sizeof *value);
      if (!value) scr_mime_oom();
      memcpy(value, u + pos, value_len * sizeof *value);
      pos += raw;
    }
    bool valid_name = name_end > name_from && scr_mime_invalid_token(u, name_from, name_end) == -1;
    bool valid_value = true;
    for (size_t i = 0; i < value_len && valid_value; i++) valid_value = scr_mime_quoted(value[i]);
    if (valid_name && valid_value) {
      ScrStr *key = scr_mime_latin1(u, name_from, name_end, true);
      if (scr_mime_params_find(p, key) < 0) {
        ScrStr *text = scr_mime_latin1(value, 0, value_len, false);
        scr_mime_params_put(p, key, text);
        scr_str_release(text);
      }
      scr_str_release(key);
    }
    free(value);
    pos++;
  }
}

/* The `encode` step of MIMEParams#toString. */
static void scr_mime_encode_value(ScrJsonBuf *b, const ScrStr *value) {
  if (value->len == 0) {
    scr_jb_puts(b, "\"\"");
    return;
  }
  bool plain = true;
  for (size_t i = 0; i < value->len && plain; i++) {
    unsigned char c = (unsigned char)value->data[i];
    plain = c < 0x80 && scr_mime_token(c);
  }
  if (plain) {
    scr_jb_put_str(b, value);
    return;
  }
  scr_jb_putc(b, '"');
  for (size_t i = 0; i < value->len; i++) {
    char c = value->data[i];
    if (c == '"' || c == '\\') scr_jb_putc(b, '\\');
    scr_jb_putc(b, c);
  }
  scr_jb_putc(b, '"');
}

static ScrStr *scr_mime_params_to_string(const ScrMimeParams *p) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  bool first = true;
  for (size_t i = 0; i < p->len; i++) {
    if (!p->values[i]) continue;
    if (!first) scr_jb_putc(&b, ';');
    first = false;
    scr_jb_put_str(&b, p->keys[i]);
    scr_jb_putc(&b, '=');
    scr_mime_encode_value(&b, p->values[i]);
  }
  return scr_jb_finish(&b);
}

/* ToString(name), lowered: `toASCIILower(`${name}`)`. +1 or NULL pending. */
static ScrStr *scr_mime_name_arg(ScrDyn *const *args, size_t argc) {
  ScrStr *raw = scr_dyn_string_coerce_js(argc ? args[0] : scr_dyn_undefined());
  if (!raw) return NULL;
  ScrJsonBuf b;
  scr_jb_init(&b);
  for (size_t i = 0; i < raw->len; i++) {
    char c = raw->data[i];
    scr_jb_putc(&b, c >= 'A' && c <= 'Z' ? (char)(c + ('a' - 'A')) : c);
  }
  scr_str_release(raw);
  return scr_jb_finish(&b);
}

static ScrDyn *scr_mime_not_a_function(const char *what) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

static ScrDyn *scr_mime_params_step(void *h, double *index, unsigned selection) {
  ScrMimeParams *p = h;
  size_t i = (size_t)*index;
  while (i < p->len && !p->values[i]) i++;
  bool done = i >= p->len;
  ScrDyn *value;
  if (done) {
    value = scr_dyn_retain(scr_dyn_undefined());
    *index = (double)p->len;
  } else {
    if (selection == 2) {
      value = scr_dyn_new_arr();
      scr_dyn_arr_push(value, scr_dyn_new_str(p->keys[i]));
      scr_dyn_arr_push(value, scr_dyn_new_str(p->values[i]));
    } else {
      value = scr_dyn_new_str(selection == 1 ? p->keys[i] : p->values[i]);
    }
    *index = (double)(i + 1);
  }
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, value);
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

static ScrDyn *scr_mime_params_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                      const char *what) {
  ScrMimeParams *p = h;
  if (!strcmp(method, "entries") || !strcmp(method, "keys") || !strcmp(method, "values"))
    return scr_dyn_native_handle_iterator(self, !strcmp(method, "entries") ? 2 : !strcmp(method, "keys") ? 1 : 0);
  if (!strcmp(method, "toString") || !strcmp(method, "toJSON")) {
    ScrStr *text = scr_mime_params_to_string(p);
    ScrDyn *result = scr_dyn_new_str(text);
    scr_str_release(text);
    return result;
  }
  bool get = !strcmp(method, "get"), has = !strcmp(method, "has"), del = !strcmp(method, "delete");
  bool set = !strcmp(method, "set");
  if (!get && !has && !del && !set) return scr_mime_not_a_function(what);
  ScrStr *name = scr_mime_name_arg(args, argc);
  if (!name) return NULL;
  ScrDyn *result = NULL;
  long at = scr_mime_params_find(p, name);
  if (get) {
    result = at >= 0 ? scr_dyn_new_str(p->values[at]) : scr_dyn_new_null();
  } else if (has) {
    result = scr_dyn_new_bool(at >= 0);
  } else if (del) {
    if (at >= 0) {
      scr_str_release(p->values[at]);
      p->values[at] = NULL;
    }
    result = scr_dyn_retain(scr_dyn_undefined());
  } else {
    ScrStr *value = scr_dyn_string_coerce_js(argc > 1 ? args[1] : scr_dyn_undefined());
    if (value) {
      ScrMimeUnits nu = scr_mime_units(name);
      long bad_name = nu.len == 0 ? -1 : scr_mime_invalid_token(nu.units, 0, nu.len);
      free(nu.units);
      ScrMimeUnits vu = scr_mime_units(value);
      long bad_value = -1;
      for (size_t i = 0; i < vu.len && bad_value == -1; i++)
        if (!scr_mime_quoted(vu.units[i])) bad_value = (long)i;
      free(vu.units);
      if (name->len == 0 || bad_name != -1) {
        scr_mime_syntax_fail("parameter name", name, bad_name);
      } else if (bad_value != -1) {
        scr_mime_syntax_fail("parameter value", value, bad_value);
      } else {
        scr_mime_params_put(p, name, value);
        result = scr_dyn_retain(scr_dyn_undefined());
      }
      scr_str_release(value);
    }
  }
  scr_str_release(name);
  return result;
}

static ScrDyn *scr_mime_empty_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

/* A method read as a value (`params.get` without a call) has no dyn
 * function value here: it throws the "not supported yet" Error; other
 * names answer undefined. */
static ScrDyn *scr_mime_member_get(const char *cls, const char *const *methods, const char *key, size_t len) {
  for (size_t i = 0; methods[i]; i++) {
    if (strlen(methods[i]) != len || memcmp(methods[i], key, len) != 0) continue;
    char message[128];
    int n = snprintf(message, sizeof message, "'%s.prototype.%s' as a value is not supported yet", cls, methods[i]);
    scr_throw_error_msg(SCR_ERR_ERROR, message, (size_t)n);
    return NULL;
  }
  return NULL;
}

static ScrDyn *scr_mime_params_get(void *h, const char *key, size_t len) {
  (void)h;
  static const char *const methods[] = {"delete", "entries", "get", "has", "keys", "set", "values", "toString", "toJSON", NULL};
  return scr_mime_member_get("MIMEParams", methods, key, len);
}

static ScrDyn *scr_mime_params_box(ScrMimeParams *p) {
  static const ScrDynHandleOps ops = {
      .cls = "MIMEParams",
      .retain = scr_mime_params_retain,
      .release = scr_mime_params_release,
      .invoke = scr_mime_params_invoke,
      .get = scr_mime_params_get,
      .iter_step = scr_mime_params_step,
      .inspect_view = scr_mime_empty_view,
      .inspect_view_empty = true,
  };
  scr_dyn_handle_install(SCR_DYNH_MIME_PARAMS, &ops);
  ScrDyn *box = scr_dyn_new_handle(p, SCR_DYNH_MIME_PARAMS);
  scr_mime_params_release(p);
  return box;
}

/* new util.MIMEParams(): an empty parameter map. +1. */
ScrDyn *scr_mime_params_new(void) { return scr_mime_params_box(scr_mime_params_alloc()); }

/* ── MIMEType ───────────────────────────────────────────────────────── */

static void *scr_mime_type_retain(void *h) {
  ((ScrMimeType *)h)->rc++;
  return h;
}

static void scr_mime_type_release(void *h) {
  ScrMimeType *t = h;
  if (!t || --t->rc > 0) return;
  scr_str_release(t->type);
  scr_str_release(t->subtype);
  scr_dyn_release(t->params);
  free(t);
}

/* The setters' validation: a non-empty token, lowered. +1 or NULL pending. */
static ScrStr *scr_mime_part(const char *production, const ScrDyn *value) {
  ScrStr *text = scr_dyn_string_coerce_js(value);
  if (!text) return NULL;
  ScrMimeUnits u = scr_mime_units(text);
  long bad = scr_mime_invalid_token(u.units, 0, u.len);
  ScrStr *out = NULL;
  if (u.len == 0 || bad != -1) scr_mime_syntax_fail(production, text, bad);
  else out = scr_mime_latin1(u.units, 0, u.len, true);
  free(u.units);
  scr_str_release(text);
  return out;
}

static ScrStr *scr_mime_type_to_string(const ScrMimeType *t) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_put_str(&b, t->type);
  scr_jb_putc(&b, '/');
  scr_jb_put_str(&b, t->subtype);
  ScrStr *params = scr_mime_params_to_string(t->params->v.handle.ptr);
  if (params->len) {
    scr_jb_putc(&b, ';');
    scr_jb_put_str(&b, params);
  }
  scr_str_release(params);
  return scr_jb_finish(&b);
}

static ScrDyn *scr_mime_type_get(void *h, const char *key, size_t len) {
  ScrMimeType *t = h;
  if (len == 4 && !memcmp(key, "type", 4)) return scr_dyn_new_str(t->type);
  if (len == 7 && !memcmp(key, "subtype", 7)) return scr_dyn_new_str(t->subtype);
  if (len == 6 && !memcmp(key, "params", 6)) return scr_dyn_retain(t->params);
  if (len == 7 && !memcmp(key, "essence", 7)) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_put_str(&b, t->type);
    scr_jb_putc(&b, '/');
    scr_jb_put_str(&b, t->subtype);
    ScrStr *text = scr_jb_finish(&b);
    ScrDyn *out = scr_dyn_new_str(text);
    scr_str_release(text);
    return out;
  }
  static const char *const methods[] = {"toString", "toJSON", NULL};
  return scr_mime_member_get("MIMEType", methods, key, len);
}

static bool scr_mime_type_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  ScrMimeType *t = h;
  bool type = len == 4 && !memcmp(key, "type", 4), subtype = len == 7 && !memcmp(key, "subtype", 7);
  if (!type && !subtype) return false;
  ScrStr *part = scr_mime_part(type ? "type" : "subtype", value);
  if (!part) return true;
  ScrStr **slot = type ? &t->type : &t->subtype;
  scr_str_release(*slot);
  *slot = part;
  return true;
}

static ScrDyn *scr_mime_type_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                    const char *what) {
  (void)self; (void)args; (void)argc;
  if (strcmp(method, "toString") && strcmp(method, "toJSON")) return scr_mime_not_a_function(what);
  ScrStr *text = scr_mime_type_to_string(h);
  ScrDyn *result = scr_dyn_new_str(text);
  scr_str_release(text);
  return result;
}

/* new MIMEType(string, noThrow) and MIMEType.parse(string): NULL with the
 * error pending, or (parse) NULL with nothing pending for invalid input. */
static ScrDyn *scr_mime_type_make(const ScrDyn *input, bool no_throw) {
  ScrStr *text = scr_dyn_string_coerce_js(input);
  if (!text) return NULL;
  ScrMimeUnits u = scr_mime_units(text);
  size_t n = u.len, pos = 0;
  while (pos < n && scr_mime_ws(u.units[pos])) pos++;
  size_t type_end = pos;
  while (type_end < n && u.units[type_end] != '/') type_end++;
  bool slash = type_end < n;
  long bad_type = scr_mime_invalid_token(u.units, pos, type_end);
  ScrDyn *result = NULL;
  if (type_end == pos || bad_type != -1 || !slash) {
    if (!no_throw) scr_mime_syntax_fail("type", text, bad_type);
    goto done;
  }
  size_t type_from = pos;
  pos = type_end + 1;
  size_t sub_end = pos;
  while (sub_end < n && u.units[sub_end] != ';') sub_end++;
  size_t sub_from = pos;
  size_t trimmed = sub_end;
  while (trimmed > sub_from && scr_mime_ws(u.units[trimmed - 1])) trimmed--;
  pos = sub_end < n ? sub_end + 1 : sub_end;
  long bad_sub = scr_mime_invalid_token(u.units, sub_from, trimmed);
  if (trimmed == sub_from || bad_sub != -1) {
    if (!no_throw) scr_mime_syntax_fail("subtype", text, bad_sub);
    goto done;
  }
  ScrMimeType *t = calloc(1, sizeof *t);
  if (!t) scr_mime_oom();
  t->rc = 1;
  t->type = scr_mime_latin1(u.units, type_from, type_end, true);
  t->subtype = scr_mime_latin1(u.units, sub_from, trimmed, true);
  ScrMimeParams *p = scr_mime_params_alloc();
  scr_mime_params_parse(p, u.units + pos, n - pos);
  t->params = scr_mime_params_box(p);
  static const ScrDynHandleOps ops = {
      .cls = "MIMEType",
      .retain = scr_mime_type_retain,
      .release = scr_mime_type_release,
      .invoke = scr_mime_type_invoke,
      .get = scr_mime_type_get,
      .set = scr_mime_type_set,
      .inspect_view = scr_mime_empty_view,
      .inspect_view_empty = true,
  };
  scr_dyn_handle_install(SCR_DYNH_MIME_TYPE, &ops);
  result = scr_dyn_new_handle(t, SCR_DYNH_MIME_TYPE);
  scr_mime_type_release(t);
done:
  free(u.units);
  scr_str_release(text);
  return result;
}

/* new util.MIMEType(string[, noThrowSymbol]): a second argument that is not
 * null or undefined throws ERR_ILLEGAL_CONSTRUCTOR (Node's internal
 * kNoThrow symbol is unreachable from programs). +1 or NULL pending. */
ScrDyn *scr_mime_type_new(ScrDyn *input, ScrDyn *no_throw) {
  if (no_throw->kind != SCR_DYN_UNDEF && no_throw->kind != SCR_DYN_NULL) {
    static const char message[] = "Illegal constructor";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_ILLEGAL_CONSTRUCTOR");
    return NULL;
  }
  return scr_mime_type_make(input, false);
}

/* MIMEType.parse(string): the MIMEType, or null for invalid input. +1, or
 * NULL with a conversion error pending. */
ScrDyn *scr_mime_type_parse(ScrDyn *input) {
  ScrDyn *result = scr_mime_type_make(input, true);
  if (result || scr_exc_pending()) return result;
  return scr_dyn_new_null();
}

/* `value instanceof MIMEType` (kind 0) or `MIMEParams` (1). */
bool scr_mime_is(const ScrDyn *value, double kind) {
  return value->kind == SCR_DYN_HANDLE &&
         value->v.handle.tag == (kind == 0 ? SCR_DYNH_MIME_TYPE : SCR_DYNH_MIME_PARAMS);
}
