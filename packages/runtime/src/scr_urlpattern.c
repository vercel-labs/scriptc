#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE 1
#endif
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif
#include "scr_runtime.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scr_array.h"
#include "scr_regex.h"
#include "scr_url.h"

/* The global URLPattern class: the standard's algorithms. A pattern is
 * tokenized (asterisks and other modifiers, escapes, `{...}` groups,
 * `:name` parts and `(regexp)` parts), parsed into parts, and compiled to
 * one anchored regular expression per component with a parallel list of
 * group names. Input URLs are canonicalized through the WHATWG parser and
 * matched component by component; a result carries each component's input
 * and its named groups.
 *
 * The compile step uses the runtime's regular-expression engine, so an
 * invalid custom regexp is the standard's TypeError at construction.
 * Pattern canonicalization is the documented subset: literal case folds for
 * protocol and hostname as the standard requires, and the other components
 * keep their text (percent-encoding of pattern literals is not applied).
 * The row stays partial until that canonicalization is exact. */

/* ── tokens ─────────────────────────────────────────────────────────── */

enum {
  TK_CHAR,
  TK_ESCAPED_CHAR,
  TK_NAME,
  TK_REGEXP,
  TK_ASTERISK,
  TK_OTHER_MODIFIER,
  TK_OPEN,
  TK_CLOSE,
  TK_INVALID_CHAR,
  TK_END,
};

typedef struct {
  int type;
  ScrStr *value; /* owned */
  size_t pos;    /* the token's first byte in the input */
} WsToken;

typedef struct {
  WsToken *items;
  size_t len;
  size_t cap;
} WsTokens;

static void ws_tokens_push(WsTokens *list, int type, ScrStr *value /* owned */, size_t pos) {
  if (list->len == list->cap) {
    list->cap = list->cap ? list->cap * 2 : 16;
    list->items = realloc(list->items, list->cap * sizeof *list->items);
    if (list->items == NULL) scr_trap("scriptc: out of memory\n");
  }
  list->items[list->len].type = type;
  list->items[list->len].value = value;
  list->items[list->len].pos = pos;
  list->len++;
}

static void ws_tokens_free(WsTokens *list) {
  for (size_t i = 0; i < list->len; i++) scr_str_release(list->items[i].value);
  free(list->items);
  list->items = NULL;
  list->len = list->cap = 0;
}

static void ws_type_error(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

static bool ws_is_name_cp(unsigned char c, bool first) {
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
  if (c >= '0' && c <= '9') return !first;
  return c == '_' || (first && c == '$');
}

/* Tokenize `input`. `strict` throws the standard's TypeError on a
 * tokenizing error; the constructor string parser's lenient policy records
 * nothing and keeps what it could read. false with an exception pending. */
static bool ws_tokenize(ScrStr *input, bool strict, WsTokens *out) {
  memset(out, 0, sizeof *out);
  const unsigned char *s = (const unsigned char *)input->data;
  size_t n = input->len;
  size_t i = 0;
  bool failed = false;
  while (i < n) {
    unsigned char c = s[i];
    if (c == '*') {
      ws_tokens_push(out, TK_ASTERISK, scr_str_new("*", 1), i);
      i++;
      continue;
    }
    if (c == '+' || c == '?') {
      ws_tokens_push(out, TK_OTHER_MODIFIER, scr_str_new((const char *)&s[i], 1), i);
      i++;
      continue;
    }
    if (c == '\\') {
      if (i + 1 >= n) {
        failed = true;
        ws_tokens_push(out, TK_INVALID_CHAR, scr_str_new((const char *)&s[i], 1), i);
        i++;
        continue;
      }
      ws_tokens_push(out, TK_ESCAPED_CHAR, scr_str_new((const char *)&s[i + 1], 1), i);
      i += 2;
      continue;
    }
    if (c == '{') {
      ws_tokens_push(out, TK_OPEN, scr_str_new("{", 1), i);
      i++;
      continue;
    }
    if (c == '}') {
      ws_tokens_push(out, TK_CLOSE, scr_str_new("}", 1), i);
      i++;
      continue;
    }
    if (c == ':') {
      size_t start = i + 1;
      size_t at = start;
      bool first = true;
      while (at < n && ws_is_name_cp(s[at], first)) {
        at++;
        first = false;
      }
      if (at == start) {
        failed = true;
        ws_tokens_push(out, TK_INVALID_CHAR, scr_str_new((const char *)&s[i], 1), i);
        i = start;
        continue;
      }
      ws_tokens_push(out, TK_NAME, scr_str_new((const char *)s + start, at - start), i);
      i = at;
      continue;
    }
    if (c == '(') {
      size_t depth = 1;
      size_t start = i + 1;
      size_t at = start;
      bool error = false;
      if (at < n && s[at] == '?') error = true;
      while (!error && at < n) {
        unsigned char r = s[at];
        if (r > 0x7f) {
          error = true;
          break;
        }
        if (r == '\\') {
          if (at + 1 >= n || s[at + 1] > 0x7f) {
            error = true;
            break;
          }
          at += 2;
          continue;
        }
        if (r == '(') {
          depth++;
        } else if (r == ')') {
          depth--;
          if (depth == 0) {
            at++;
            break;
          }
        }
        at++;
      }
      if (error || depth != 0) {
        failed = true;
        ws_tokens_push(out, TK_INVALID_CHAR, scr_str_new((const char *)&s[i], 1), i);
        i = start;
        continue;
      }
      size_t value_len = at - 1 - start;
      if (value_len == 0) {
        failed = true;
        i = at;
        continue;
      }
      ws_tokens_push(out, TK_REGEXP, scr_str_new((const char *)s + start, value_len), i);
      i = at;
      continue;
    }
    ws_tokens_push(out, TK_CHAR, scr_str_new((const char *)&s[i], 1), i);
    i++;
  }
  ws_tokens_push(out, TK_END, scr_str_new("", 0), n);
  if (failed && strict) {
    ws_tokens_free(out);
    ws_type_error("Failed to construct URLPattern");
    return false;
  }
  return true;
}

/* ── parts ──────────────────────────────────────────────────────────── */

enum { WP_FIXED, WP_SEGMENT, WP_FULL, WP_REGEXP };
enum { WM_NONE, WM_OPTIONAL, WM_ZERO_OR_MORE, WM_ONE_OR_MORE };

typedef struct {
  int type;
  ScrStr *value;  /* fixed text or regexp source */
  ScrStr *name;   /* the capture's group name ("" for fixed text) */
  ScrStr *prefix; /* owned, may be empty */
  ScrStr *suffix; /* owned, may be empty */
  int modifier;
} WsPart;

typedef struct {
  WsPart *items;
  size_t len;
  size_t cap;
} WsParts;

static void ws_parts_push(WsParts *list, WsPart part) {
  if (list->len == list->cap) {
    list->cap = list->cap ? list->cap * 2 : 16;
    list->items = realloc(list->items, list->cap * sizeof *list->items);
    if (list->items == NULL) scr_trap("scriptc: out of memory\n");
  }
  list->items[list->len++] = part;
}

static void ws_parts_free(WsParts *list) {
  for (size_t i = 0; i < list->len; i++) {
    scr_str_release(list->items[i].value);
    scr_str_release(list->items[i].name);
    scr_str_release(list->items[i].prefix);
    scr_str_release(list->items[i].suffix);
  }
  free(list->items);
  list->items = NULL;
  list->len = list->cap = 0;
}

static ScrStr *ws_str_lower(ScrStr *s) {
  ScrStr *out = scr_str_new(s->data, s->len);
  for (size_t i = 0; i < out->len; i++)
    if (out->data[i] >= 'A' && out->data[i] <= 'Z') out->data[i] = (char)(out->data[i] - 'A' + 'a');
  return out;
}

typedef struct {
  const WsTokens *tokens;
  size_t index;
  const char *delimiter;  /* one byte, "" for the default options */
  const char *prefix_char; /* one byte, "" for none */
  ScrStr *pending;        /* owned buffered fixed text */
  WsParts parts;
  size_t next_numeric;
  bool canonicalize_case; /* protocol and hostname fold literal case */
} WsParser;

static void ws_parser_init(WsParser *p, const WsTokens *tokens, const char *delimiter,
                           const char *prefix_char, bool fold_case) {
  memset(p, 0, sizeof *p);
  p->tokens = tokens;
  p->delimiter = delimiter;
  p->prefix_char = prefix_char;
  p->pending = scr_str_new("", 0);
  p->canonicalize_case = fold_case;
}

static ScrStr *ws_parser_encode(WsParser *p, ScrStr *text) {
  return p->canonicalize_case ? ws_str_lower(text) : scr_str_retain(text);
}

static void ws_parser_free(WsParser *p) {
  scr_str_release(p->pending);
  ws_parts_free(&p->parts);
}

static const WsToken *ws_try_consume(WsParser *p, int type) {
  if (p->index >= p->tokens->len) return NULL;
  const WsToken *token = &p->tokens->items[p->index];
  if (token->type != type) return NULL;
  p->index++;
  return token;
}

static ScrStr *ws_consume_text(WsParser *p) {
  ScrStr *out = scr_str_new("", 0);
  for (;;) {
    const WsToken *token = NULL;
    if (p->index < p->tokens->len) token = &p->tokens->items[p->index];
    if (token == NULL || (token->type != TK_CHAR && token->type != TK_ESCAPED_CHAR)) break;
    ScrStr *next = scr_str_concat(out, token->value);
    scr_str_release(out);
    out = next;
    p->index++;
  }
  return out;
}

static bool ws_consume_required(WsParser *p, int type) {
  if (ws_try_consume(p, type) != NULL) return true;
  ws_type_error("Failed to construct URLPattern");
  return false;
}

static void ws_maybe_add_pending_fixed(WsParser *p) {
  if (p->pending->len == 0) return;
  WsPart part;
  memset(&part, 0, sizeof part);
  part.type = WP_FIXED;
  part.value = ws_parser_encode(p, p->pending);
  part.name = scr_str_new("", 0);
  part.prefix = scr_str_new("", 0);
  part.suffix = scr_str_new("", 0);
  part.modifier = WM_NONE;
  ws_parts_push(&p->parts, part);
  scr_str_release(p->pending);
  p->pending = scr_str_new("", 0);
}

static const WsToken *ws_try_consume_regexp_or_wildcard(WsParser *p, const WsToken *name) {
  const WsToken *token = ws_try_consume(p, TK_REGEXP);
  if (token != NULL) return token;
  if (name != NULL) return NULL;
  return ws_try_consume(p, TK_ASTERISK);
}

static int ws_modifier_of(const WsToken *token) {
  if (token == NULL) return WM_NONE;
  if (token->type == TK_ASTERISK) return WM_ZERO_OR_MORE;
  if (token->type != TK_OTHER_MODIFIER) return WM_NONE;
  return token->value->data[0] == '+' ? WM_ONE_OR_MORE : WM_OPTIONAL;
}

static const WsToken *ws_try_consume_modifier(WsParser *p) {
  if (p->index >= p->tokens->len) return NULL;
  int type = p->tokens->items[p->index].type;
  if (type == TK_OTHER_MODIFIER || type == TK_ASTERISK) return &p->tokens->items[p->index++];
  return NULL;
}

static bool ws_has_name(const WsParts *parts, ScrStr *name) {
  for (size_t i = 0; i < parts->len; i++)
    if (parts->items[i].name->len == name->len &&
        memcmp(parts->items[i].name->data, name->data, name->len) == 0)
      return true;
  return false;
}

/* Add one part per the standard's algorithm. false with a TypeError
 * pending (a duplicate group name). */
static bool ws_add_part(WsParser *p, ScrStr *prefix /* owned */, const WsToken *name,
                        const WsToken *regexp_or_wildcard, ScrStr *suffix /* owned */,
                        const WsToken *modifier) {
  int mod = ws_modifier_of(modifier);
  if (name == NULL && regexp_or_wildcard == NULL && mod == WM_NONE) {
    /* a `{foo}` grouping: it joins the pending fixed text */
    ScrStr *next = scr_str_concat(p->pending, prefix);
    scr_str_release(p->pending);
    p->pending = next;
    scr_str_release(prefix);
    scr_str_release(suffix);
    return true;
  }
  ws_maybe_add_pending_fixed(p);
  if (name == NULL && regexp_or_wildcard == NULL) {
    /* a `{foo}?` grouping: fixed text with a modifier */
    if (prefix->len == 0) {
      scr_str_release(prefix);
      scr_str_release(suffix);
      return true;
    }
    WsPart part;
    memset(&part, 0, sizeof part);
    part.type = WP_FIXED;
    part.value = ws_parser_encode(p, prefix);
    part.name = scr_str_new("", 0);
    part.prefix = scr_str_new("", 0);
    part.suffix = scr_str_new("", 0);
    part.modifier = mod;
    ws_parts_push(&p->parts, part);
    scr_str_release(prefix);
    scr_str_release(suffix);
    return true;
  }
  ScrStr *regexp_value;
  int type;
  if (regexp_or_wildcard == NULL) {
    /* the segment wildcard, compared by identity against the fragment */
    regexp_value = NULL;
    type = WP_SEGMENT;
  } else if (regexp_or_wildcard->type == TK_ASTERISK) {
    regexp_value = NULL;
    type = WP_FULL;
  } else {
    regexp_value = scr_str_retain(regexp_or_wildcard->value);
    type = WP_REGEXP;
  }
  ScrStr *name_value;
  if (name != NULL) {
    name_value = scr_str_retain(name->value);
  } else {
    char digits[32];
    int n = snprintf(digits, sizeof digits, "%zu", p->next_numeric++);
    name_value = scr_str_new(digits, (size_t)n);
  }
  if (ws_has_name(&p->parts, name_value)) {
    scr_str_release(name_value);
    if (regexp_value != NULL) scr_str_release(regexp_value);
    scr_str_release(prefix);
    scr_str_release(suffix);
    ws_type_error("Failed to construct URLPattern");
    return false;
  }
  WsPart part;
  memset(&part, 0, sizeof part);
  part.type = type;
  part.value = regexp_value != NULL ? regexp_value : scr_str_new("", 0);
  part.name = name_value;
  part.prefix = ws_parser_encode(p, prefix);
  part.suffix = ws_parser_encode(p, suffix);
  part.modifier = mod;
  ws_parts_push(&p->parts, part);
  scr_str_release(prefix);
  scr_str_release(suffix);
  return true;
}

/* Parse a pattern string into parts (strict tokens). false with a
 * TypeError pending. */
static bool ws_parse_pattern(WsParser *p) {
  for (;;) {
    const WsToken *char_token = ws_try_consume(p, TK_CHAR);
    const WsToken *name_token = ws_try_consume(p, TK_NAME);
    const WsToken *rx = ws_try_consume_regexp_or_wildcard(p, name_token);
    if (name_token != NULL || rx != NULL) {
      ScrStr *prefix = char_token != NULL ? scr_str_retain(char_token->value) : scr_str_new("", 0);
      if (prefix->len > 0 &&
          !(p->prefix_char[0] != '\0' && prefix->len == 1 && prefix->data[0] == p->prefix_char[0])) {
        ScrStr *next = scr_str_concat(p->pending, prefix);
        scr_str_release(p->pending);
        p->pending = next;
        scr_str_release(prefix);
        prefix = scr_str_new("", 0);
      }
      ws_maybe_add_pending_fixed(p);
      const WsToken *modifier = ws_try_consume_modifier(p);
      if (!ws_add_part(p, prefix, name_token, rx, scr_str_new("", 0), modifier)) return false;
      continue;
    }
    const WsToken *fixed = char_token;
    if (fixed == NULL) fixed = ws_try_consume(p, TK_ESCAPED_CHAR);
    if (fixed != NULL) {
      ScrStr *next = scr_str_concat(p->pending, fixed->value);
      scr_str_release(p->pending);
      p->pending = next;
      continue;
    }
    const WsToken *open = ws_try_consume(p, TK_OPEN);
    if (open != NULL) {
      ScrStr *prefix = ws_consume_text(p);
      const WsToken *group_name = ws_try_consume(p, TK_NAME);
      const WsToken *group_rx = ws_try_consume_regexp_or_wildcard(p, group_name);
      ScrStr *suffix = ws_consume_text(p);
      if (!ws_consume_required(p, TK_CLOSE)) {
        scr_str_release(prefix);
        scr_str_release(suffix);
        return false;
      }
      const WsToken *modifier = ws_try_consume_modifier(p);
      if (!ws_add_part(p, prefix, group_name, group_rx, suffix, modifier)) return false;
      continue;
    }
    ws_maybe_add_pending_fixed(p);
    if (!ws_consume_required(p, TK_END)) return false;
    break;
  }
  return !scr_exc_pending();
}

/* ── the regular expression ─────────────────────────────────────────── */

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} WsBuf;

static void ws_buf_add(WsBuf *b, const char *text, size_t n) {
  if (b->len + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 64;
    while (cap < b->len + n + 1) cap *= 2;
    char *grown = realloc(b->data, cap);
    if (grown == NULL) scr_trap("scriptc: out of memory\n");
    b->data = grown;
    b->cap = cap;
  }
  memcpy(b->data + b->len, text, n);
  b->len += n;
  b->data[b->len] = '\0';
}

static void ws_buf_str(WsBuf *b, const char *text) { ws_buf_add(b, text, strlen(text)); }

static void ws_buf_scr(WsBuf *b, const ScrStr *s) { ws_buf_add(b, s->data, s->len); }

static ScrStr *ws_buf_finish(WsBuf *b) {
  ScrStr *out = scr_str_new(b->data != NULL ? b->data : "", b->len);
  free(b->data);
  memset(b, 0, sizeof *b);
  return out;
}

/* Append `input` with the standard's regexp metacharacters escaped. */
static void ws_buf_add_escaped(WsBuf *b, ScrStr *input) {
  for (size_t i = 0; i < input->len; i++) {
    char c = input->data[i];
    if (strchr(".+*?^${}()[]|/\\", c) != NULL) ws_buf_add(b, "\\", 1);
    ws_buf_add(b, &c, 1);
  }
}

static const char *ws_modifier_string(int modifier) {
  switch (modifier) {
  case WM_OPTIONAL: return "?";
  case WM_ZERO_OR_MORE: return "*";
  case WM_ONE_OR_MORE: return "+";
  default: return "";
  }
}

/* "[^<delimiter>]+?" — the segment wildcard for the component's options. */
static ScrStr *ws_segment_wildcard(const char *delimiter) {
  WsBuf b = {0};
  ws_buf_str(&b, "[^");
  ScrStr *del = scr_str_new(delimiter, strlen(delimiter));
  ws_buf_add_escaped(&b, del);
  scr_str_release(del);
  ws_buf_str(&b, "]+?");
  return ws_buf_finish(&b);
}

/* Generate the anchored regular expression and the group-name list. */
static bool ws_generate_regex(WsParser *p, ScrStr **source /* +1 */, ScrStr ***names /* owned */,
                              size_t *names_len, bool *has_regexp) {
  ScrStr *wildcard = ws_segment_wildcard(p->delimiter);
  WsBuf b = {0};
  ScrStr **list = NULL;
  size_t len = 0, cap = 0;
  *has_regexp = false;
  ws_buf_str(&b, "^");
  for (size_t i = 0; i < p->parts.len; i++) {
    const WsPart *part = &p->parts.items[i];
    if (part->type == WP_FIXED) {
      if (part->modifier == WM_NONE) {
        ws_buf_add_escaped(&b, part->value);
      } else {
        ws_buf_str(&b, "(?:");
        ws_buf_add_escaped(&b, part->value);
        ws_buf_str(&b, ")");
        ws_buf_str(&b, ws_modifier_string(part->modifier));
      }
      continue;
    }
    if (part->type == WP_REGEXP) *has_regexp = true;
    if (len == cap) {
      cap = cap ? cap * 2 : 8;
      list = realloc(list, cap * sizeof *list);
      if (list == NULL) scr_trap("scriptc: out of memory\n");
    }
    list[len++] = scr_str_retain(part->name);
    ScrStr *value = part->type == WP_SEGMENT ? scr_str_retain(wildcard)
                    : part->type == WP_FULL  ? scr_str_new(".*", 2)
                                             : scr_str_retain(part->value);
    bool empty_affix = part->prefix->len == 0 && part->suffix->len == 0;
    bool simple_modifier = part->modifier == WM_NONE || part->modifier == WM_OPTIONAL;
    if (empty_affix) {
      if (simple_modifier) {
        ws_buf_str(&b, "(");
        ws_buf_scr(&b, value);
        ws_buf_str(&b, ")");
        ws_buf_str(&b, ws_modifier_string(part->modifier));
      } else {
        ws_buf_str(&b, "((?:");
        ws_buf_scr(&b, value);
        ws_buf_str(&b, ")");
        ws_buf_str(&b, ws_modifier_string(part->modifier));
        ws_buf_str(&b, ")");
      }
    } else if (simple_modifier) {
      ws_buf_str(&b, "(?:");
      ws_buf_add_escaped(&b, part->prefix);
      ws_buf_str(&b, "(");
      ws_buf_scr(&b, value);
      ws_buf_str(&b, ")");
      ws_buf_add_escaped(&b, part->suffix);
      ws_buf_str(&b, ")");
      ws_buf_str(&b, ws_modifier_string(part->modifier));
    } else {
      ws_buf_str(&b, "(?:");
      ws_buf_add_escaped(&b, part->prefix);
      ws_buf_str(&b, "((?:");
      ws_buf_scr(&b, value);
      ws_buf_str(&b, ")(?:");
      ws_buf_add_escaped(&b, part->suffix);
      ws_buf_add_escaped(&b, part->prefix);
      ws_buf_str(&b, "(?:");
      ws_buf_scr(&b, value);
      ws_buf_str(&b, "))*)"); /* close the inner value, repeat group, capture */
      ws_buf_add_escaped(&b, part->suffix);
      ws_buf_str(&b, ")");
      if (part->modifier == WM_ZERO_OR_MORE) ws_buf_str(&b, "?");
    }
    scr_str_release(value);
  }
  scr_str_release(wildcard);
  ws_buf_str(&b, "$");
  *source = ws_buf_finish(&b);
  *names = list;
  *names_len = len;
  return true;
}

/* ── components ─────────────────────────────────────────────────────── */

typedef struct {
  ScrStr *pattern; /* the component's pattern string, owned */
  ScrStr *literal; /* the pattern's canonicalized text for properties */
  ScrRegex *regex; /* owned */
  ScrStr **names;  /* owned group names, in capture order */
  size_t names_len;
  bool has_regexp;
} WsComponent;

static void ws_component_init(WsComponent *c) {
  memset(c, 0, sizeof *c);
  c->pattern = scr_str_new("", 0);
  c->literal = scr_str_new("", 0);
}

static void ws_component_free(WsComponent *c) {
  scr_str_release(c->pattern);
  scr_str_release(c->literal);
  if (c->regex != NULL) scr_regex_release(c->regex);
  for (size_t i = 0; i < c->names_len; i++) scr_str_release(c->names[i]);
  free(c->names);
  memset(c, 0, sizeof *c);
}

/* Compile `text` as one component pattern. false with an exception
 * pending (the standard's TypeError for an invalid pattern or regexp). */
static bool ws_compile(WsComponent *c, ScrStr *text, const char *delimiter, const char *prefix_char,
                       bool fold_case, bool ignore_case) {
  WsTokens tokens = {NULL, 0, 0};
  if (!ws_tokenize(text, true, &tokens)) return false;
  WsParser parser;
  ws_parser_init(&parser, &tokens, delimiter, prefix_char, fold_case);
  bool ok = ws_parse_pattern(&parser);
  ScrStr *source = NULL;
  ScrStr **names = NULL;
  size_t names_len = 0;
  bool has_regexp = false;
  if (ok) ok = ws_generate_regex(&parser, &source, &names, &names_len, &has_regexp);
  if (ok) {
    ScrStr *flags = scr_str_new(ignore_case ? "i" : "", ignore_case ? 1 : 0);
    ScrRegex *regex = scr_regex_new(source, flags);
    scr_str_release(flags);
    if (regex == NULL) {
      /* the engine's SyntaxError becomes the standard's TypeError */
      scr_exc_clear();
      ws_type_error("Failed to construct URLPattern");
      ok = false;
    } else {
      scr_str_release(c->pattern);
      c->pattern = scr_str_retain(text);
      scr_str_release(c->literal);
      c->literal = fold_case ? ws_str_lower(text) : scr_str_retain(text);
      if (c->regex != NULL) scr_regex_release(c->regex);
      c->regex = regex;
      for (size_t i = 0; i < c->names_len; i++) scr_str_release(c->names[i]);
      free(c->names);
      c->names = names;
      c->names_len = names_len;
      c->has_regexp = has_regexp;
      names = NULL;
    }
  }
  if (source != NULL) scr_str_release(source);
  if (names != NULL) {
    for (size_t i = 0; i < names_len; i++) scr_str_release(names[i]);
    free(names);
  }
  ws_parser_free(&parser);
  ws_tokens_free(&tokens);
  return ok;
}

/* ── the handle ──────────────────────────────────────────────────────── */

typedef struct ScrUrlPattern {
  size_t rc;
  WsComponent protocol, username, password, hostname, port, pathname, search, hash;
  bool ignore_case;
} ScrUrlPattern;

static void *ws_retain_v(void *p) {
  ((ScrUrlPattern *)p)->rc++;
  return p;
}

static void ws_release_v(void *p) {
  ScrUrlPattern *pattern = p;
  if (pattern == NULL || --pattern->rc > 0) return;
  ws_component_free(&pattern->protocol);
  ws_component_free(&pattern->username);
  ws_component_free(&pattern->password);
  ws_component_free(&pattern->hostname);
  ws_component_free(&pattern->port);
  ws_component_free(&pattern->pathname);
  ws_component_free(&pattern->search);
  ws_component_free(&pattern->hash);
  free(pattern);
}

bool scr_urlpattern_is(const ScrDyn *value) {
  return value != NULL && value->kind == SCR_DYN_HANDLE &&
         value->v.handle.tag == SCR_DYNH_URL_PATTERN;
}


/* ── constructor strings and component records ─────────────────────── */

typedef struct {
  ScrStr *protocol, *username, *password, *hostname, *port, *pathname, *search, *hash;
} WsInit;

static void ws_init_free(WsInit *init) {
  scr_str_release(init->protocol);
  scr_str_release(init->username);
  scr_str_release(init->password);
  scr_str_release(init->hostname);
  scr_str_release(init->port);
  scr_str_release(init->pathname);
  scr_str_release(init->search);
  scr_str_release(init->hash);
  memset(init, 0, sizeof *init);
}

static ScrStr *ws_slice(const ScrStr *input, size_t from, size_t to) {
  if (to < from) to = from;
  return scr_str_new(input->data + from, to - from);
}

static bool ws_scheme_is(const ScrStr *scheme, const char *want) {
  return scheme->len == strlen(want) && memcmp(scheme->data, want, scheme->len) == 0;
}

static bool ws_is_special_scheme(const ScrStr *scheme) {
  return ws_scheme_is(scheme, "http") || ws_scheme_is(scheme, "https") ||
         ws_scheme_is(scheme, "ws") || ws_scheme_is(scheme, "wss") || ws_scheme_is(scheme, "ftp") ||
         ws_scheme_is(scheme, "file");
}

enum { WC_INIT, WC_PROTOCOL, WC_AUTHORITY, WC_USERNAME, WC_PASSWORD, WC_HOSTNAME, WC_PORT,
       WC_PATHNAME, WC_SEARCH, WC_HASH, WC_DONE };

/* The constructor string parser: the standard's state machine over lenient
 * tokens, with components recorded as the input text between separators. */
static bool ws_parse_ctor(ScrStr *input, WsInit *out) {
  WsTokens tokens = {NULL, 0, 0};
  if (!ws_tokenize(input, false, &tokens)) {
    ws_tokens_free(&tokens);
    return false;
  }
  int state = WC_INIT;
  size_t index = 0;
  size_t component_start = 0;
  size_t group_depth = 0;
  size_t ipv6 = 0;
  bool ok = true;
  for (;;) {
    if (index >= tokens.len) break;
    const WsToken *token = &tokens.items[index];
    if (token->type == TK_END) {
      size_t end = input->len;
      switch (state) {
      case WC_INIT: {
        /* A relative constructor string: hash, search or pathname. */
        if (input->len > 0 && input->data[0] == '#') {
          out->hash = ws_slice(input, 1, input->len);
        } else if (input->len > 0 && input->data[0] == '?') {
          out->search = ws_slice(input, 1, input->len);
        } else {
          out->pathname = ws_slice(input, component_start, end);
        }
        break;
      }
      case WC_AUTHORITY:
      case WC_HOSTNAME:
        out->hostname = ws_slice(input, component_start, end);
        break;
      case WC_PORT:
        out->port = ws_slice(input, component_start, end);
        break;
      case WC_PATHNAME:
        out->pathname = ws_slice(input, component_start, end);
        break;
      case WC_SEARCH:
        out->search = ws_slice(input, component_start, end);
        break;
      case WC_HASH:
        out->hash = ws_slice(input, component_start, end);
        break;
      default:
        break;
      }
      state = WC_DONE;
      break;
    }
    if (token->type == TK_OPEN) {
      group_depth++;
      index++;
      continue;
    }
    if (group_depth > 0) {
      if (token->type == TK_CLOSE) group_depth--;
      index++;
      continue;
    }
    if (state == WC_INIT &&
        (token->type == TK_CHAR || token->type == TK_ESCAPED_CHAR ||
         token->type == TK_INVALID_CHAR) &&
        token->value->data[0] == ':') {
      /* A scheme separator: the text so far is the protocol. */
      out->protocol = ws_slice(input, 0, token->pos);
      component_start = token->pos + 1;
      /* Authority slashes: "//" right after the separator. */
      if (index + 2 < tokens.len && tokens.items[index + 1].type == TK_CHAR &&
          tokens.items[index + 1].value->data[0] == '/' && tokens.items[index + 2].type == TK_CHAR &&
          tokens.items[index + 2].value->data[0] == '/') {
        component_start = tokens.items[index + 2].pos + 1;
        state = WC_AUTHORITY;
        index += 3;
      } else {
        state = WC_PATHNAME;
        index++;
      }
      continue;
    }
    char c = (token->type == TK_CHAR || token->type == TK_ESCAPED_CHAR ||
               token->type == TK_INVALID_CHAR)
                  ? token->value->data[0]
                  : '\0';
    switch (state) {
    case WC_AUTHORITY:
      if (c == '/' || c == '?' || c == '#') {
        /* no userinfo: the text so far is the hostname */
        state = WC_HOSTNAME;
        continue;
      }
      if (c == '@') {
        ScrStr *userinfo = ws_slice(input, component_start, token->pos);
        size_t colon = userinfo->len;
        for (size_t i = 0; i < userinfo->len; i++)
          if (userinfo->data[i] == ':') {
            colon = i;
            break;
          }
        out->username = ws_slice(userinfo, 0, colon);
        if (colon < userinfo->len) out->password = ws_slice(userinfo, colon + 1, userinfo->len);
        scr_str_release(userinfo);
        component_start = token->pos + 1;
        state = WC_HOSTNAME;
      }
      index++;
      break;
    case WC_HOSTNAME:
      if (token->type == TK_NAME && token->pos < input->len && input->data[token->pos] == ':' &&
          ipv6 == 0) {
        out->hostname = ws_slice(input, component_start, token->pos);
        component_start = token->pos + 1;
        state = WC_PORT;
        index++;
        break;
      }
      if (c == '[') {
        ipv6++;
      } else if (c == ']' && ipv6 > 0) {
        ipv6--;
      } else if (ipv6 == 0 && c == ':') {
        out->hostname = ws_slice(input, component_start, token->pos);
        component_start = token->pos + 1;
        state = WC_PORT;
      } else if (ipv6 == 0 && (c == '/' || c == '?' || c == '#')) {
        out->hostname = ws_slice(input, component_start, token->pos);
        component_start = c == '/' ? token->pos : token->pos + 1;
        state = c == '/' ? WC_PATHNAME : c == '?' ? WC_SEARCH : WC_HASH;
        if (state == WC_SEARCH && out->pathname == NULL)
          out->pathname = scr_str_new(ws_is_special_scheme(out->protocol ? out->protocol : input)
                                          ? "/"
                                          : "",
                                      1);
        if (state == WC_HASH && out->search == NULL) out->search = scr_str_new("", 0);
      }
      index++;
      break;
    case WC_PORT:
      if (c == '/' || c == '?' || c == '#') {
        out->port = ws_slice(input, component_start, token->pos);
        component_start = c == '/' ? token->pos : token->pos + 1;
        state = c == '/' ? WC_PATHNAME : c == '?' ? WC_SEARCH : WC_HASH;
        if (state == WC_SEARCH && out->pathname == NULL)
          out->pathname = scr_str_new(ws_is_special_scheme(out->protocol ? out->protocol : input)
                                          ? "/"
                                          : "",
                                      1);
        if (state == WC_HASH && out->search == NULL) out->search = scr_str_new("", 0);
      }
      index++;
      break;
    case WC_PATHNAME:
      if (c == '?' || c == '#') {
        out->pathname = ws_slice(input, component_start, token->pos);
        component_start = token->pos + 1;
        state = c == '?' ? WC_SEARCH : WC_HASH;
        if (state == WC_HASH && out->search == NULL) out->search = scr_str_new("", 0);
      }
      index++;
      break;
    case WC_SEARCH:
      if (c == '#') {
        out->search = ws_slice(input, component_start, token->pos);
        component_start = token->pos + 1;
        state = WC_HASH;
      }
      index++;
      break;
    default:
      index++;
      break;
    }
    if (scr_exc_pending()) {
      ok = false;
      break;
    }
  }
  ws_tokens_free(&tokens);
  return ok;
}

/* Strip a leading component marker ('?' or '#' on search and hash). */
static ScrStr *ws_strip_marker(ScrStr *value, char marker) {
  if (value->len > 0 && value->data[0] == marker)
    return scr_str_new(value->data + 1, value->len - 1);
  return scr_str_retain(value);
}

/* A protocol read carries its trailing ':'. */
static ScrStr *ws_strip_protocol(ScrStr *value) {
  if (value->len > 0 && value->data[value->len - 1] == ':')
    return scr_str_new(value->data, value->len - 1);
  return scr_str_retain(value);
}

static bool ws_read_field(const ScrDyn *object, const char *name, ScrStr **out) {
  /* scr_dyn_obj_get answers a borrowed value. */
  ScrDyn *value = scr_dyn_obj_get(object, name, strlen(name));
  if (value == NULL || value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) return true;
  ScrStr *text = scr_dyn_string_coerce_js(value);
  if (text == NULL) return false;
  *out = text;
  return true;
}

/* A base URL's components fill the init's missing ones; a relative
 * pathname resolves against the base's directory. A base with credentials
 * is the standard's TypeError. */
static bool ws_apply_base(WsInit *init, ScrStr *base_text) {
  ScrUrl *base = scr_url_new(base_text);
  if (base == NULL) return false;
  ScrStr *user = scr_url_username(base);
  ScrStr *pass = scr_url_password(base);
  bool has_credentials = user->len > 0 || pass->len > 0;
  scr_str_release(user);
  scr_str_release(pass);
  if (has_credentials) {
    scr_url_release(base);
    ws_type_error("Failed to construct URLPattern");
    return false;
  }
  if (init->protocol == NULL) {
    ScrStr *protocol = scr_url_protocol(base);
    init->protocol = ws_strip_protocol(protocol);
    scr_str_release(protocol);
  }
  if (init->hostname == NULL) init->hostname = scr_url_hostname(base);
  if (init->port == NULL) init->port = scr_url_port(base);
  if (init->pathname != NULL && init->pathname->len > 0 && init->pathname->data[0] != '/') {
    ScrStr *base_path = scr_url_pathname(base);
    size_t cut = base_path->len;
    while (cut > 0 && base_path->data[cut - 1] != '/') cut--;
    ScrStr *dir = ws_slice(base_path, 0, cut);
    ScrStr *joined = scr_str_concat(dir, init->pathname);
    scr_str_release(dir);
    scr_str_release(base_path);
    scr_str_release(init->pathname);
    init->pathname = joined;
  }
  scr_url_release(base);
  return !scr_exc_pending();
}

/* The standard's defaults for the components a pattern left unset. */
static void ws_apply_defaults(WsInit *init, bool from_string) {
  if (init->protocol == NULL) init->protocol = scr_str_new("*", 1);
  bool special = ws_is_special_scheme(init->protocol);
  if (init->username == NULL) init->username = scr_str_new("*", 1);
  if (init->password == NULL) init->password = scr_str_new("*", 1);
  if (init->hostname == NULL) init->hostname = scr_str_new("*", 1);
  if (init->port == NULL) {
    /* A constructor string that names a host omits the port (it matches
     * the default port); a component record defaults the port to "*". */
    bool host_set = !(init->hostname->len == 1 && init->hostname->data[0] == '*');
    init->port = from_string && host_set ? scr_str_new("", 0) : scr_str_new("*", 1);
  }
  if (init->pathname == NULL) {
    /* A constructor string that names a search or hash implies an empty
     * path ("/" for a special scheme); a component record defaults the
     * pathname to "*". */
    bool later_set = from_string && ((init->search != NULL && init->search->len > 0) ||
                                     (init->hash != NULL && init->hash->len > 0));
    init->pathname = scr_str_new(later_set ? "/" : "*", 1);
  }
  if (init->search == NULL) init->search = scr_str_new("*", 1);
  if (init->hash == NULL) init->hash = scr_str_new("*", 1);
}

static bool ws_init_from_dyn(ScrDyn *input, ScrStr *base_text, bool *from_string, WsInit *out) {
  memset(out, 0, sizeof *out);
  *from_string = false;
  if (scr_urlpattern_is(input)) {
    ScrUrlPattern *other = input->v.handle.ptr;
    out->protocol = scr_str_retain(other->protocol.pattern);
    out->username = scr_str_retain(other->username.pattern);
    out->password = scr_str_retain(other->password.pattern);
    out->hostname = scr_str_retain(other->hostname.pattern);
    out->port = scr_str_retain(other->port.pattern);
    out->pathname = scr_str_retain(other->pathname.pattern);
    out->search = scr_str_retain(other->search.pattern);
    out->hash = scr_str_retain(other->hash.pattern);
    return true;
  }
  if (input->kind == SCR_DYN_STR) {
    *from_string = true;
    if (!ws_parse_ctor(input->v.str, out)) return false;
    if (out->hostname != NULL && out->hostname->len > 0 && out->hostname->data[0] == '[') {
      ws_type_error("Failed to construct URLPattern");
      return false;
    }
    if (base_text != NULL && !ws_apply_base(out, base_text)) return false;
    return true;
  }
  if (input->kind == SCR_DYN_OBJ && base_text != NULL) {
    /* the standard takes a base URL only with a constructor string */
    ws_type_error("Failed to construct URLPattern");
    return false;
  }
  if (input->kind == SCR_DYN_OBJ) {
    ScrStr *base_field = NULL;
    if (!ws_read_field(input, "protocol", &out->protocol) ||
        !ws_read_field(input, "username", &out->username) ||
        !ws_read_field(input, "password", &out->password) ||
        !ws_read_field(input, "hostname", &out->hostname) ||
        !ws_read_field(input, "port", &out->port) ||
        !ws_read_field(input, "pathname", &out->pathname) ||
        !ws_read_field(input, "search", &out->search) ||
        !ws_read_field(input, "hash", &out->hash) ||
        !ws_read_field(input, "baseURL", &base_field)) {
      scr_str_release(base_field);
      return false;
    }
    if (out->protocol != NULL) {
      ScrStr *stripped = ws_strip_protocol(out->protocol);
      scr_str_release(out->protocol);
      out->protocol = stripped;
    }
    if (out->search != NULL) {
      ScrStr *stripped = ws_strip_marker(out->search, '?');
      scr_str_release(out->search);
      out->search = stripped;
    }
    if (out->hash != NULL) {
      ScrStr *stripped = ws_strip_marker(out->hash, '#');
      scr_str_release(out->hash);
      out->hash = stripped;
    }
    ScrStr *effective_base = base_text != NULL ? base_text : base_field;
    if (effective_base != NULL && !ws_apply_base(out, effective_base)) {
      scr_str_release(base_field);
      return false;
    }
    scr_str_release(base_field);
    return true;
  }
  return true; /* undefined/null: the empty pattern */
}

/* ── building and matching ─────────────────────────────────────────── */

static bool ws_build(ScrUrlPattern *pattern, WsInit *init, bool from_string, bool ignore_case) {
  ws_apply_defaults(init, from_string);
  pattern->ignore_case = ignore_case;
  bool ok = ws_compile(&pattern->protocol, init->protocol, "", "", true, ignore_case) &&
            ws_compile(&pattern->username, init->username, "", "", false, ignore_case) &&
            ws_compile(&pattern->password, init->password, "", "", false, ignore_case) &&
            ws_compile(&pattern->hostname, init->hostname, ".", "", true, ignore_case) &&
            ws_compile(&pattern->port, init->port, "", "", false, ignore_case) &&
            ws_compile(&pattern->pathname, init->pathname, "/", "/", false, ignore_case) &&
            ws_compile(&pattern->search, init->search, "", "", false, ignore_case) &&
            ws_compile(&pattern->hash, init->hash, "", "", false, ignore_case);
  return ok;
}

typedef struct {
  ScrStr *protocol, *username, *password, *hostname, *port, *pathname, *search, *hash;
} WsInput;

static void ws_input_free(WsInput *in) {
  scr_str_release(in->protocol);
  scr_str_release(in->username);
  scr_str_release(in->password);
  scr_str_release(in->hostname);
  scr_str_release(in->port);
  scr_str_release(in->pathname);
  scr_str_release(in->search);
  scr_str_release(in->hash);
  memset(in, 0, sizeof *in);
}

static ScrStr *ws_take_or_empty(ScrStr *value) {
  return value != NULL ? scr_str_retain(value) : scr_str_new("", 0);
}

/* Canonicalize the match input: a URL string through the WHATWG parser (a
 * relative string needs a base; without one the match fails), or a
 * component record with the base filling what it omits. */
static bool ws_input_from_dyn(ScrDyn *input, ScrStr *base_text, WsInput *out) {
  memset(out, 0, sizeof *out);
  if (input->kind == SCR_DYN_STR) {
    ScrUrl *url = base_text != NULL ? scr_url_new_base(input->v.str, base_text)
                                    : scr_url_new(input->v.str);
    if (url == NULL) {
      scr_exc_clear();
      return false;
    }
    ScrStr *protocol = scr_url_protocol(url);
    out->protocol = ws_strip_protocol(protocol);
    scr_str_release(protocol);
    out->username = scr_url_username(url);
    out->password = scr_url_password(url);
    out->hostname = scr_url_hostname(url);
    out->port = scr_url_port(url);
    out->pathname = scr_url_pathname(url);
    ScrStr *search = scr_url_search(url);
    out->search = ws_strip_marker(search, '?');
    scr_str_release(search);
    ScrStr *hash = scr_url_hash(url);
    out->hash = ws_strip_marker(hash, '#');
    scr_str_release(hash);
    scr_url_release(url);
    return true;
  }
  if (input->kind == SCR_DYN_OBJ) {
    if (!ws_read_field(input, "protocol", &out->protocol) ||
        !ws_read_field(input, "username", &out->username) ||
        !ws_read_field(input, "password", &out->password) ||
        !ws_read_field(input, "hostname", &out->hostname) ||
        !ws_read_field(input, "port", &out->port) ||
        !ws_read_field(input, "pathname", &out->pathname) ||
        !ws_read_field(input, "search", &out->search) ||
        !ws_read_field(input, "hash", &out->hash)) {
      return false;
    }
    if (out->protocol != NULL) {
      ScrStr *stripped = ws_strip_protocol(out->protocol);
      scr_str_release(out->protocol);
      out->protocol = stripped;
    }
    if (out->search != NULL) {
      ScrStr *stripped = ws_strip_marker(out->search, '?');
      scr_str_release(out->search);
      out->search = stripped;
    }
    if (out->hash != NULL) {
      ScrStr *stripped = ws_strip_marker(out->hash, '#');
      scr_str_release(out->hash);
      out->hash = stripped;
    }
    if (base_text != NULL) {
      ScrUrl *base = scr_url_new(base_text);
      if (base == NULL) return false;
      if (out->protocol == NULL) {
        ScrStr *protocol = scr_url_protocol(base);
        out->protocol = ws_strip_protocol(protocol);
        scr_str_release(protocol);
      }
      if (out->hostname == NULL) out->hostname = scr_url_hostname(base);
      if (out->port == NULL) out->port = scr_url_port(base);
      if (out->pathname == NULL) out->pathname = scr_url_pathname(base);
      scr_url_release(base);
    }
    return true;
  }
  return true;
}

/* One component's match: the groups object (owned) and its input text. */
static ScrDyn *ws_match_component(WsComponent *component, ScrStr *input, bool *matched) {
  *matched = false;
  if (component->regex == NULL) return NULL;
  ScrArr *m = scr_regex_exec(input, component->regex);
  if (m == NULL) return NULL;
  ScrDyn *groups = scr_dyn_new_obj();
  /* Node's groups record carries its names in sorted order. */
  size_t *order = calloc(component->names_len ? component->names_len : 1, sizeof *order);
  if (order == NULL) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < component->names_len; i++) {
    size_t at = i;
    while (at > 0) {
      ScrStr *left = component->names[order[at - 1]];
      ScrStr *right = component->names[i];
      size_t common = left->len < right->len ? left->len : right->len;
      int cmp = memcmp(left->data, right->data, common);
      if (cmp == 0) cmp = left->len < right->len ? -1 : left->len > right->len ? 1 : 0;
      if (cmp <= 0) break;
      order[at] = order[at - 1];
      at--;
    }
    order[at] = i;
  }
  for (size_t k = 0; k < component->names_len; k++) {
    size_t i = order[k];
    size_t capture = i + 1;
    ScrDyn *value;
    if (capture < (size_t)scr_arr_len(m) && scr_arr_dense_state(m, capture) == SCR_ARR_VALUE) {
      ScrStr *text = scr_arr_get_ref(m, (double)capture);
      value = scr_dyn_new_str(text);
      scr_str_release(text);
    } else {
      value = scr_dyn_retain(scr_dyn_undefined());
    }
    scr_dyn_obj_set(groups, component->names[i]->data, component->names[i]->len, value);
  }
  free(order);
  scr_arr_release(m);
  *matched = true;
  return groups;
}

static ScrDyn *ws_component_result(ScrStr *input, ScrDyn *groups) {
  /* Node's result objects carry their keys in alphabetical order. */
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "groups", 6, groups);
  scr_dyn_obj_set(result, "input", 5, scr_dyn_new_str(input));
  return result;
}

/* exec(test_only=false) / test: the standard's result, or NULL for no
 * match. `input`/`base` are borrowed. */
static ScrDyn *ws_exec(ScrUrlPattern *pattern, ScrDyn *input, ScrDyn *base, bool test_only,
                       bool *matched) {
  ScrStr *base_text = NULL;
  if (base != NULL && base->kind == SCR_DYN_STR) base_text = base->v.str;
  WsInput in;
  if (!ws_input_from_dyn(input, base_text, &in)) {
    ws_input_free(&in);
    *matched = false;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  ScrStr *protocol = ws_take_or_empty(in.protocol);
  ScrStr *username = ws_take_or_empty(in.username);
  ScrStr *password = ws_take_or_empty(in.password);
  ScrStr *hostname = ws_take_or_empty(in.hostname);
  ScrStr *port = ws_take_or_empty(in.port);
  ScrStr *pathname = ws_take_or_empty(in.pathname);
  ScrStr *search = ws_take_or_empty(in.search);
  ScrStr *hash = ws_take_or_empty(in.hash);
  bool ok = true;
  ScrDyn *groups[8] = {NULL};
  struct {
    WsComponent *component;
    ScrStr *input;
  } parts[8] = {
      {&pattern->protocol, protocol}, {&pattern->username, username},
      {&pattern->password, password}, {&pattern->hostname, hostname},
      {&pattern->port, port},         {&pattern->pathname, pathname},
      {&pattern->search, search},     {&pattern->hash, hash},
  };
  for (size_t i = 0; i < 8 && ok; i++) {
    bool hit = false;
    groups[i] = ws_match_component(parts[i].component, parts[i].input, &hit);
    if (!hit) ok = false;
  }
  *matched = ok;
  ScrDyn *out = NULL;
  if (ok && !test_only) {
    out = scr_dyn_new_obj();
    ScrDyn *inputs = scr_dyn_new_arr();
    if (input->kind == SCR_DYN_OBJ) {
      /* Node's result carries the input record's coerced copy, keys in
       * alphabetical order and only the fields the input spelled. */
      static const char *const fields[9] = {"baseURL",  "hash",   "hostname", "password", "pathname",
                                            "port",     "protocol", "search", "username"};
      ScrDyn *copy = scr_dyn_new_obj();
      bool ok_fields = true;
      for (size_t i = 0; i < 9 && ok_fields; i++) {
        ScrStr *text = NULL;
        if (!ws_read_field(input, fields[i], &text)) {
          ok_fields = false;
          break;
        }
        if (text != NULL) {
          scr_dyn_obj_set(copy, fields[i], strlen(fields[i]), scr_dyn_new_str(text));
          scr_str_release(text);
        }
      }
      if (!ok_fields) {
        scr_dyn_release(copy);
        scr_dyn_release(inputs);
        /* the field coercion's exception is pending */
        for (size_t i = 0; i < 8; i++) scr_dyn_release(groups[i]);
        scr_str_release(protocol);
        scr_str_release(username);
        scr_str_release(password);
        scr_str_release(hostname);
        scr_str_release(port);
        scr_str_release(pathname);
        scr_str_release(search);
        scr_str_release(hash);
        ws_input_free(&in);
        return NULL;
      }
      scr_dyn_arr_push(inputs, copy);
    } else {
      scr_dyn_arr_push(inputs, scr_dyn_retain(input));
    }
    if (base_text != NULL) scr_dyn_arr_push(inputs, scr_dyn_new_str(base_text));
    /* Node's result keys, in alphabetical order. */
    static const char *const order[9] = {"hash",   "hostname", "inputs", "password", "pathname",
                                         "port",   "protocol", "search", "username"};
    static const int slot[9] = {7, 3, -1, 2, 5, 4, 0, 6, 1};
    size_t next_group = 0;
    for (size_t i = 0; i < 9; i++) {
      if (slot[i] < 0) {
        scr_dyn_obj_set(out, order[i], strlen(order[i]), inputs);
        continue;
      }
      size_t which = (size_t)slot[i];
      ScrDyn *result = ws_component_result(parts[which].input, groups[which]);
      groups[which] = NULL;
      scr_dyn_obj_set(out, order[i], strlen(order[i]), result);
      next_group++;
    }
    (void)next_group;
  }
  for (size_t i = 0; i < 8; i++) scr_dyn_release(groups[i]);
  scr_str_release(protocol);
  scr_str_release(username);
  scr_str_release(password);
  scr_str_release(hostname);
  scr_str_release(port);
  scr_str_release(pathname);
  scr_str_release(search);
  scr_str_release(hash);
  ws_input_free(&in);
  return out;
}

/* ── the member surface ────────────────────────────────────────────── */

static ScrDyn *ws_get(void *ptr, const char *key, size_t len) {
  ScrUrlPattern *pattern = ptr;
  const struct {
    const char *name;
    const WsComponent *component;
  } components[] = {
      {"protocol", &pattern->protocol}, {"username", &pattern->username},
      {"password", &pattern->password}, {"hostname", &pattern->hostname},
      {"port", &pattern->port},         {"pathname", &pattern->pathname},
      {"search", &pattern->search},     {"hash", &pattern->hash},
  };
  for (size_t i = 0; i < sizeof components / sizeof components[0]; i++) {
    if (strlen(components[i].name) == len && memcmp(components[i].name, key, len) == 0)
      return scr_dyn_new_str(components[i].component->literal);
  }
  if (len == 15 && memcmp(key, "hasRegExpGroups", 15) == 0) {
    bool any = pattern->protocol.has_regexp || pattern->username.has_regexp ||
               pattern->password.has_regexp || pattern->hostname.has_regexp ||
               pattern->port.has_regexp || pattern->pathname.has_regexp ||
               pattern->search.has_regexp || pattern->hash.has_regexp;
    return scr_dyn_new_bool(any);
  }
  return NULL;
}

static ScrDyn *ws_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                         size_t argc, const char *what) {
  (void)self;
  (void)what;
  bool is_test = strcmp(method, "test") == 0;
  if (!is_test && strcmp(method, "exec") != 0) {
    static const char message[] = "This URLPattern method is not implemented";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  ScrDyn *input = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrDyn *base = argc > 1 ? args[1] : scr_dyn_undefined();
  bool matched = false;
  ScrDyn *result = ws_exec(ptr, input, base, is_test, &matched);
  if (is_test) {
    scr_dyn_release(result);
    return scr_dyn_new_bool(matched);
  }
  if (!matched) return scr_dyn_new_null();
  return result;
}

static const ScrDynHandleOps ws_ops = {
    .cls = "URLPattern",
    .retain = ws_retain_v,
    .release = ws_release_v,
    .invoke = ws_invoke,
    .get = ws_get,
};

/* ── construction ──────────────────────────────────────────────────── */

ScrDyn *scr_urlpattern_new(ScrDyn *input, ScrDyn *base_url, ScrDyn *options) {
  ScrStr *base_text = NULL;
  ScrDyn *options_value = options;
  if (base_url != NULL && base_url->kind == SCR_DYN_STR) {
    base_text = base_url->v.str;
  } else if (options == NULL || options->kind == SCR_DYN_UNDEF) {
    /* `new URLPattern(input, options)` */
    options_value = base_url;
  }
  bool ignore_case = false;
  if (options_value != NULL && options_value->kind != SCR_DYN_UNDEF &&
      options_value->kind != SCR_DYN_NULL) {
    if (options_value->kind != SCR_DYN_OBJ) {
      ws_type_error("Failed to construct URLPattern");
      return NULL;
    }
    ScrDyn *flag = scr_dyn_obj_get(options_value, "ignoreCase", 10);
    ignore_case = flag != NULL && scr_dyn_truthy(flag);
  }
  ScrDyn *actual_input = input != NULL ? input : scr_dyn_undefined();
  bool from_string = false;
  WsInit init;
  if (!ws_init_from_dyn(actual_input, base_text, &from_string, &init)) {
    ws_init_free(&init);
    if (!scr_exc_pending()) ws_type_error("Failed to construct URLPattern");
    return NULL;
  }
  if (from_string && init.protocol == NULL) {
    /* a relative constructor string needs a base URL */
    ws_init_free(&init);
    ws_type_error("Failed to construct URLPattern");
    return NULL;
  }
  ScrUrlPattern *pattern = calloc(1, sizeof *pattern);
  if (pattern == NULL) scr_trap("scriptc: out of memory\n");
  pattern->rc = 1;
  ws_component_init(&pattern->protocol);
  ws_component_init(&pattern->username);
  ws_component_init(&pattern->password);
  ws_component_init(&pattern->hostname);
  ws_component_init(&pattern->port);
  ws_component_init(&pattern->pathname);
  ws_component_init(&pattern->search);
  ws_component_init(&pattern->hash);
  bool ok = ws_build(pattern, &init, from_string, ignore_case);
  ws_init_free(&init);
  if (!ok) {
    ws_release_v(pattern);
    return NULL;
  }
  ScrDyn *out = scr_dyn_new_handle(pattern, SCR_DYNH_URL_PATTERN);
  ws_release_v(pattern);
  return out;
}

__attribute__((constructor)) static void ws_ops_install(void) {
  scr_dyn_handle_install(SCR_DYNH_URL_PATTERN, &ws_ops);
}
