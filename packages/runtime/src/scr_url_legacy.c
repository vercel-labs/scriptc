/* node:url's legacy API — url.parse(), url.format() and url.resolve() —
 * plus url.domainToASCII()/domainToUnicode(): a port of Node 24's
 * lib/url.js (Url.prototype.parse/format/resolveObject), edge cases
 * included, and of the WHATWG host parser behind the domain functions.
 * The differential corpus is the oracle.
 *
 * url.parse() answers a checked-dynamic Url instance: an ordinary object
 * with Node's twelve own properties in Node's order (null where Node leaves
 * null), tagged with the "Url" class name for util.inspect. url.Url as a
 * value is Node's constructor; it initializes its receiver with those same
 * twelve fields and shares the prototype parse() results carry. url.format()
 * reads any object's fields with JS truthiness and string conversion;
 * url.resolve() runs entirely over fresh parses. The scans work on the
 * runtime's UTF-8 storage: every delimiter the algorithms test is ASCII,
 * and the few UTF-16 facts they depend on (hostname length, the U+00A0 and
 * U+FEFF trim set, \s, auth's encodeStr) are computed explicitly.
 *
 * DEP0169 (url.parse()'s deprecation) and DEP0170 (an invalid port) are
 * emitted once per process on the next tick, Node's timing; the compiler
 * passes `warn` false for call sites inside node_modules, Node's
 * isInsideNodeModules rule.
 *
 * Linked with the regex (toLowerCase, NFC), querystring and dyn-async
 * (warnings) units. All inputs are BORROWED; results are fresh (+1), or
 * NULL with a catchable error pending. */
#include "scr_runtime.h"
#include "scr_url_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── strings ───────────────────────────────────────────────────────── */

static ScrStr *lu_str(const char *p, size_t n) { return scr_str_new(p, n); }
static ScrStr *lu_cstr(const char *s) { return scr_str_new(s, strlen(s)); }
static bool lu_truthy(const ScrStr *s) { return s && s->len > 0; }
static bool lu_eq(const ScrStr *a, const ScrStr *b) {
  if (!a || !b) return a == b;
  return a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
}
static bool lu_is(const ScrStr *s, const char *lit) {
  size_t n = strlen(lit);
  return s && s->len == n && memcmp(s->data, lit, n) == 0;
}
static void lu_set(ScrStr **slot, ScrStr *value /* moves in; NULL = null */) {
  if (*slot) scr_str_release(*slot);
  *slot = value;
}
static ScrStr *lu_ref(ScrStr *s) { return s ? scr_str_retain(s) : NULL; }
static bool lu_has(const ScrStr *s, char c) { return s && memchr(s->data, c, s->len) != NULL; }

static ScrStr *lu_cat(const ScrStr *a, const ScrStr *b) {
  ScrJsonBuf out;
  scr_jb_init(&out);
  if (a) scr_jb_put_str(&out, a);
  if (b) scr_jb_put_str(&out, b);
  return scr_jb_finish(&out);
}
static ScrStr *lu_prefix(const char *head, const ScrStr *s) {
  ScrJsonBuf out;
  scr_jb_init(&out);
  scr_jb_puts(&out, head);
  if (s) scr_jb_put_str(&out, s);
  return scr_jb_finish(&out);
}

/* The protocol sets of lib/internal/url.js (membership is case-sensitive,
 * with and without the colon). */
static bool lu_slashed_protocol(const ScrStr *p) {
  static const char *names[] = {"http",   "http:", "https", "https:", "ftp",  "ftp:", "gopher",
                                "gopher:", "file", "file:", "ws",     "ws:",  "wss",  "wss:"};
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
    if (lu_is(p, names[i])) return true;
  return false;
}
static bool lu_hostless_protocol(const ScrStr *p) {
  return lu_is(p, "javascript") || lu_is(p, "javascript:");
}

/* UTF-16 length of a UTF-8 (WTF-8) span: 4-byte sequences are pairs. */
static size_t lu_utf16_len(const ScrStr *s) {
  size_t n = 0;
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if ((c & 0xC0) != 0x80) n += c >= 0xF0 ? 2 : 1;
  }
  return n;
}

/* The code point at p (lenient: continuation bytes are trusted). */
static uint32_t lu_cp(const char *p, size_t n, size_t *len) {
  unsigned char c = (unsigned char)p[0];
  if (c < 0x80 || n < 2) {
    *len = 1;
    return c;
  }
  if (c < 0xE0) {
    *len = 2;
    return ((uint32_t)(c & 0x1F) << 6) | ((unsigned char)p[1] & 0x3F);
  }
  if (c < 0xF0 || n < 4) {
    *len = n < 3 ? n : 3;
    return n < 3 ? c : ((uint32_t)(c & 0x0F) << 12) | ((uint32_t)((unsigned char)p[1] & 0x3F) << 6) |
                           ((unsigned char)p[2] & 0x3F);
  }
  *len = 4;
  return ((uint32_t)(c & 0x07) << 18) | ((uint32_t)((unsigned char)p[1] & 0x3F) << 12) |
         ((uint32_t)((unsigned char)p[2] & 0x3F) << 6) | ((unsigned char)p[3] & 0x3F);
}

/* JS RegExp \s: WhiteSpace and LineTerminator. */
static bool lu_regex_space(uint32_t c) {
  return (c >= 0x09 && c <= 0x0D) || c == 0x20 || c == 0xA0 || c == 0x1680 ||
         (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F ||
         c == 0x205F || c == 0x3000 || c == 0xFEFF;
}

static void lu_throw_invalid_url(void) {
  scr_throw_error_msg_code(SCR_ERR_TYPE, "Invalid URL", 11, "ERR_INVALID_URL");
}

/* ── the Url record ────────────────────────────────────────────────── */

typedef struct {
  ScrStr *protocol, *auth, *host, *port, *hostname, *hash, *search, *query, *pathname, *path,
      *href;
  ScrDyn *query_obj; /* parseQueryString's object (query stays NULL) */
  bool slashes;
} LegacyUrl;

static void lu_free(LegacyUrl *u) {
  ScrStr **fields[] = {&u->protocol, &u->auth,     &u->host, &u->port, &u->hostname, &u->hash,
                       &u->search,   &u->query,    &u->pathname, &u->path, &u->href};
  for (size_t i = 0; i < sizeof fields / sizeof fields[0]; i++) lu_set(fields[i], NULL);
  if (u->query_obj) scr_dyn_release(u->query_obj);
  u->query_obj = NULL;
}

static void lu_copy(LegacyUrl *dst, const LegacyUrl *src) {
  lu_free(dst);
  dst->protocol = lu_ref(src->protocol);
  dst->auth = lu_ref(src->auth);
  dst->host = lu_ref(src->host);
  dst->port = lu_ref(src->port);
  dst->hostname = lu_ref(src->hostname);
  dst->hash = lu_ref(src->hash);
  dst->search = lu_ref(src->search);
  dst->query = lu_ref(src->query);
  dst->pathname = lu_ref(src->pathname);
  dst->path = lu_ref(src->path);
  dst->href = lu_ref(src->href);
  dst->query_obj = src->query_obj ? scr_dyn_retain(src->query_obj) : NULL;
  dst->slashes = src->slashes;
}

/* ── warnings ──────────────────────────────────────────────────────── */

static SCR_TL bool lu_parse_warned = false;
static SCR_TL bool lu_port_warned = false;

/* process.emitWarning(message, 'DeprecationWarning', code): reported on
 * the next tick, dropped under process.noDeprecation, and thrown from its
 * own tick under process.throwDeprecation. Borrows message. */
static void lu_deprecate(const char *code, ScrStr *message) {
  ScrStr *code_text = lu_cstr(code);
  ScrDyn *warning = scr_warning_new(message, "DeprecationWarning", code_text);
  scr_str_release(code_text);
  scr_warning_emit_deferred(warning);
  scr_dyn_release(warning);
}

static void lu_warn_parse(bool warn) {
  if (!warn || lu_parse_warned) return;
  lu_parse_warned = true;
  ScrStr *message = lu_cstr(
      "`url.parse()` behavior is not standardized and prone to errors that have security "
      "implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` "
      "vulnerabilities.");
  lu_deprecate("DEP0169", message);
  scr_str_release(message);
}

/* ── format ────────────────────────────────────────────────────────── */

static const signed char lu_no_escape_auth[128] = {
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0,
};

/* lib/internal/querystring.js encodeStr with the auth table. */
static ScrStr *lu_encode_auth(const ScrStr *s) { return scr_qs_encode_str(s, lu_no_escape_auth); }

static bool lu_ipv6_hostname(const ScrStr *h) {
  return h && h->len > 0 && h->data[0] == '[' && h->data[h->len - 1] == ']';
}

/* Url.prototype.format. `query` is querystring.stringify of an object
 * query (NULL otherwise). */
static ScrStr *lu_format(const LegacyUrl *u, const ScrStr *query) {
  ScrStr *auth = NULL;
  if (lu_truthy(u->auth)) {
    ScrStr *encoded = lu_encode_auth(u->auth);
    if (!encoded) return NULL;
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_put_str(&b, encoded);
    scr_jb_putc(&b, '@');
    scr_str_release(encoded);
    auth = scr_jb_finish(&b);
  }
  ScrJsonBuf protocol;
  scr_jb_init(&protocol);
  if (lu_truthy(u->protocol)) {
    scr_jb_put_str(&protocol, u->protocol);
    if (u->protocol->data[u->protocol->len - 1] != ':') scr_jb_putc(&protocol, ':');
  }
  ScrStr *proto = scr_jb_finish(&protocol);

  ScrJsonBuf host;
  scr_jb_init(&host);
  if (lu_truthy(u->host)) {
    if (auth) scr_jb_put_str(&host, auth);
    scr_jb_put_str(&host, u->host);
  } else if (lu_truthy(u->hostname)) {
    if (auth) scr_jb_put_str(&host, auth);
    bool bracket = lu_has(u->hostname, ':') && !lu_ipv6_hostname(u->hostname);
    if (bracket) scr_jb_putc(&host, '[');
    scr_jb_put_str(&host, u->hostname);
    if (bracket) scr_jb_putc(&host, ']');
    if (lu_truthy(u->port)) {
      scr_jb_putc(&host, ':');
      scr_jb_put_str(&host, u->port);
    }
  }
  ScrStr *host_part = scr_jb_finish(&host);
  if (auth) scr_str_release(auth);

  const ScrStr *search_src = lu_truthy(u->search) ? u->search : NULL;
  ScrJsonBuf pathname;
  scr_jb_init(&pathname);
  if (lu_truthy(u->pathname)) {
    for (size_t i = 0; i < u->pathname->len; i++) {
      char c = u->pathname->data[i];
      if (c == '#') scr_jb_puts(&pathname, "%23");
      else if (c == '?') scr_jb_puts(&pathname, "%3F");
      else scr_jb_putc(&pathname, c);
    }
  }
  ScrStr *path = scr_jb_finish(&pathname);

  ScrJsonBuf out;
  scr_jb_init(&out);
  scr_jb_put_str(&out, proto);
  if (u->slashes || lu_slashed_protocol(proto)) {
    if (u->slashes || host_part->len > 0) {
      scr_jb_puts(&out, "//");
      scr_jb_put_str(&out, host_part);
      if (path->len > 0 && path->data[0] != '/') scr_jb_putc(&out, '/');
    } else if (proto->len >= 4 && memcmp(proto->data, "file", 4) == 0) {
      scr_jb_puts(&out, "//");
    }
  } else {
    scr_jb_put_str(&out, host_part);
  }
  scr_jb_put_str(&out, path);
  if (search_src || lu_truthy(query)) {
    const ScrStr *search = search_src ? search_src : query;
    if (!search_src || search->data[0] != '?') scr_jb_putc(&out, '?');
    for (size_t i = 0; i < search->len; i++) {
      if (search->data[i] == '#') scr_jb_puts(&out, "%23");
      else scr_jb_putc(&out, search->data[i]);
    }
  }
  if (lu_truthy(u->hash)) {
    if (u->hash->data[0] != '#') scr_jb_putc(&out, '#');
    scr_jb_put_str(&out, u->hash);
  }
  scr_str_release(proto);
  scr_str_release(host_part);
  scr_str_release(path);
  return scr_jb_finish(&out);
}

/* ── parse ─────────────────────────────────────────────────────────── */

/* A mutable byte span (the algorithm's `rest`). */
typedef struct {
  char *p;
  size_t n;
} LuSpan;

static void lu_span_set(LuSpan *s, const char *p, size_t n) {
  char *copy = malloc(n ? n : 1);
  if (!copy) scr_trap("scriptc: out of memory\n");
  memcpy(copy, p, n);
  free(s->p);
  s->p = copy;
  s->n = n;
}

static void lu_span_drop(LuSpan *s, size_t k) {
  memmove(s->p, s->p + k, s->n - k);
  s->n -= k;
}

static const char *const lu_auto_escape[126] = {
    ['\t'] = "%09", ['\n'] = "%0A", ['\r'] = "%0D", [' '] = "%20", ['"'] = "%22",
    ['\''] = "%27", ['<'] = "%3C",  ['>'] = "%3E",  ['\\'] = "%5C", ['^'] = "%5E",
    ['`'] = "%60",  ['{'] = "%7B",  ['|'] = "%7C",  ['}'] = "%7D",
};

static bool lu_host_forbidden(const ScrStr *h, bool ipv6) {
  for (size_t i = 0; i < h->len; i++) {
    switch (h->data[i]) {
      case '\0': case '\t': case '\n': case '\r': case ' ': case '#': case '%': case '/':
      case '<': case '>': case '?': case '@': case '\\': case '^': case '|':
        return true;
      case ':': case '[': case ']':
        if (!ipv6) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

/* Url.prototype.parse(url, parseQueryString, slashesDenoteHost) over an
 * empty record. False with an error pending. */
static bool lu_parse(LegacyUrl *self, const ScrStr *url, bool parse_query, bool slashes_denote_host) {
  const char *s = url->data;
  size_t n = url->len;
  /* Trim (C0 controls, space, U+00A0, U+FEFF) and turn backslashes before
   * the first ? or # into slashes. */
  bool has_hash = false, has_at = false;
  long start = -1, end = -1;
  size_t last_pos = 0;
  ScrJsonBuf restb;
  scr_jb_init(&restb);
  bool in_ws = false, split = false;
  for (size_t i = 0, len; i < n; i += len) {
    uint32_t code = lu_cp(s + i, n - i, &len);
    bool ws = code < 33 || code == 0xA0 || code == 0xFEFF;
    if (start == -1) {
      if (ws) continue;
      last_pos = (size_t)(start = (long)i);
    } else if (in_ws) {
      if (!ws) {
        end = -1;
        in_ws = false;
      }
    } else if (ws) {
      end = (long)i;
      in_ws = true;
    }
    if (!split) {
      switch (code) {
        case '@':
          has_at = true;
          break;
        case '#':
          has_hash = true;
          split = true;
          break;
        case '?':
          split = true;
          break;
        case '\\':
          if (i > last_pos) scr_jb_write(&restb, s + last_pos, i - last_pos);
          scr_jb_putc(&restb, '/');
          last_pos = i + 1;
          break;
        default:
          break;
      }
    } else if (!has_hash && code == '#') {
      has_hash = true;
    }
  }
  if (start != -1) {
    if (last_pos == (size_t)start) {
      if (end == -1) scr_jb_write(&restb, s + start, n - (size_t)start);
      else scr_jb_write(&restb, s + start, (size_t)(end - start));
    } else if (end == -1 && last_pos < n) {
      scr_jb_write(&restb, s + last_pos, n - last_pos);
    } else if (end != -1 && last_pos < (size_t)end) {
      scr_jb_write(&restb, s + last_pos, (size_t)end - last_pos);
    }
  }
  ScrStr *rest_str = scr_jb_finish(&restb);
  LuSpan rest = {0};
  lu_span_set(&rest, rest_str->data, rest_str->len);

  if (!slashes_denote_host && !has_hash && !has_at) {
    /* simplePathPattern: /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/ */
    const char *r = rest.p;
    size_t rn = rest.n;
    if (rn > 0 && r[0] == '/' && !(rn > 2 && r[1] == '/' && r[2] == '/')) {
      size_t i = 1, query_at = rn;
      bool ok = true;
      while (i < rn) {
        size_t len;
        uint32_t c = lu_cp(r + i, rn - i, &len);
        if (lu_regex_space(c)) {
          ok = false;
          break;
        }
        if (c == '?' && query_at == rn) query_at = i;
        i += len;
      }
      if (ok) {
        self->path = scr_str_retain(rest_str);
        self->href = scr_str_retain(rest_str);
        self->pathname = lu_str(r, query_at);
        if (query_at < rn) {
          self->search = lu_str(r + query_at, rn - query_at);
          if (parse_query) {
            ScrStr *q = lu_str(r + query_at + 1, rn - query_at - 1);
            self->query_obj = scr_qs_parse_dyn(q);
            scr_str_release(q);
          } else {
            self->query = lu_str(r + query_at + 1, rn - query_at - 1);
          }
        } else if (parse_query) {
          self->query_obj = scr_dyn_new_obj_null_proto();
        }
        free(rest.p);
        scr_str_release(rest_str);
        return true;
      }
    }
  }
  scr_str_release(rest_str);

  /* protocolPattern: /^[a-z0-9.+-]+:/i */
  ScrStr *proto = NULL, *lower_proto = NULL;
  {
    size_t j = 0;
    while (j < rest.n) {
      char c = rest.p[j];
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' ||
          c == '+' || c == '-')
        j++;
      else
        break;
    }
    if (j > 0 && j < rest.n && rest.p[j] == ':') {
      proto = lu_str(rest.p, j + 1);
      char *lower = malloc(j + 1);
      if (!lower) scr_trap("scriptc: out of memory\n");
      for (size_t k = 0; k <= j; k++) {
        char c = rest.p[k];
        lower[k] = c >= 'A' && c <= 'Z' ? (char)(c + 32) : c;
      }
      lower_proto = lu_str(lower, j + 1);
      free(lower);
      self->protocol = scr_str_retain(lower_proto);
      lu_span_drop(&rest, j + 1);
    }
  }

  /* hostPattern: /^\/\/[^@/]+@[^@/]+/ */
  bool host_pattern = false;
  if (rest.n > 2 && rest.p[0] == '/' && rest.p[1] == '/') {
    size_t k = 2;
    while (k < rest.n && rest.p[k] != '@' && rest.p[k] != '/') k++;
    host_pattern =
        k > 2 && k < rest.n && rest.p[k] == '@' && k + 1 < rest.n && rest.p[k + 1] != '@' && rest.p[k + 1] != '/';
  }
  bool slashes = false;
  if (slashes_denote_host || proto || host_pattern) {
    slashes = rest.n >= 2 && rest.p[0] == '/' && rest.p[1] == '/';
    if (slashes && !(proto && lu_hostless_protocol(lower_proto))) {
      lu_span_drop(&rest, 2);
      self->slashes = true;
    }
  }

  bool failed = false;
  if (!lu_hostless_protocol(lower_proto) && (slashes || (proto && !lu_slashed_protocol(proto)))) {
    long host_end = -1, at_sign = -1, non_host = -1;
    for (size_t i = 0; i < rest.n; i++) {
      switch (rest.p[i]) {
        case '\t':
        case '\n':
        case '\r':
          memmove(rest.p + i, rest.p + i + 1, rest.n - i - 1);
          rest.n--;
          i--;
          break;
        case ' ': case '"': case '%': case '\'': case ';': case '<': case '>': case '\\':
        case '^': case '`': case '{': case '|': case '}':
          if (non_host == -1) non_host = (long)i;
          break;
        case '#':
        case '/':
        case '?':
          if (non_host == -1) non_host = (long)i;
          host_end = (long)i;
          break;
        case '@':
          at_sign = (long)i;
          non_host = -1;
          break;
        default:
          break;
      }
      if (host_end != -1) break;
    }
    size_t host_start = 0;
    if (at_sign != -1) {
      ScrStr *raw = lu_str(rest.p, (size_t)at_sign);
      ScrStr *auth = scr_str_decode_uri_component(raw);
      scr_str_release(raw);
      if (!auth) {
        failed = true;
        goto done;
      }
      self->auth = auth;
      host_start = (size_t)at_sign + 1;
    }
    if (non_host == -1) {
      self->host = lu_str(rest.p + host_start, rest.n - host_start);
      rest.n = 0;
    } else {
      self->host = lu_str(rest.p + host_start, (size_t)non_host - host_start);
      lu_span_drop(&rest, (size_t)non_host);
    }

    /* parseHost: portPattern /:[0-9]*$/ */
    {
      const ScrStr *h = self->host;
      size_t k = h->len;
      while (k > 0 && h->data[k - 1] >= '0' && h->data[k - 1] <= '9') k--;
      size_t host_len = h->len;
      if (k > 0 && h->data[k - 1] == ':') {
        if (h->len - k > 0) self->port = lu_str(h->data + k, h->len - k);
        host_len = k - 1;
      }
      if (host_len > 0) self->hostname = lu_str(h->data, host_len);
    }
    if (!self->hostname) self->hostname = lu_str("", 0);

    bool ipv6 = lu_ipv6_hostname(self->hostname);
    if (!ipv6) {
      /* getHostname: a character no hostname may hold moves the remainder
       * into the path (only ':' can still appear here). */
      const ScrStr *h = self->hostname;
      for (size_t i = 0; i < h->len; i++) {
        char c = h->data[i];
        if (c != '/' && c != '\\' && c != '#' && c != '?' && c != ':') continue;
        if (c == ':' && !lu_port_warned) {
          lu_port_warned = true;
          ScrJsonBuf detail;
          scr_jb_init(&detail);
          scr_jb_puts(&detail, "The URL ");
          scr_jb_put_str(&detail, url);
          scr_jb_puts(&detail, " is invalid. Future versions of Node.js will throw an error.");
          ScrStr *message = scr_jb_finish(&detail);
          lu_deprecate("DEP0170", message);
          scr_str_release(message);
        }
        ScrJsonBuf moved;
        scr_jb_init(&moved);
        scr_jb_putc(&moved, '/');
        scr_jb_write(&moved, h->data + i, h->len - i);
        scr_jb_write(&moved, rest.p, rest.n);
        ScrStr *joined = scr_jb_finish(&moved);
        lu_span_set(&rest, joined->data, joined->len);
        scr_str_release(joined);
        lu_set(&self->hostname, lu_str(h->data, i));
        break;
      }
    }
    if (lu_utf16_len(self->hostname) > 255) {
      lu_set(&self->hostname, lu_str("", 0));
    } else {
      lu_set(&self->hostname, scr_str_to_lower(self->hostname));
    }
    if (self->hostname->len > 0) {
      if (ipv6) {
        if (lu_host_forbidden(self->hostname, true)) {
          lu_throw_invalid_url();
          failed = true;
          goto done;
        }
      } else {
        ScrStr *ascii = scr_idna_to_ascii(self->hostname->data, self->hostname->len);
        lu_set(&self->hostname, ascii);
        if (ascii->len == 0 || lu_host_forbidden(ascii, false)) {
          lu_throw_invalid_url();
          failed = true;
          goto done;
        }
      }
    }
    {
      ScrJsonBuf hb;
      scr_jb_init(&hb);
      scr_jb_put_str(&hb, self->hostname);
      if (lu_truthy(self->port)) {
        scr_jb_putc(&hb, ':');
        scr_jb_put_str(&hb, self->port);
      }
      lu_set(&self->host, scr_jb_finish(&hb));
    }
    if (ipv6) {
      const ScrStr *h = self->hostname;
      lu_set(&self->hostname, lu_str(h->data + 1, h->len >= 2 ? h->len - 2 : 0));
      if (rest.n == 0 || rest.p[0] != '/') {
        char *grown = malloc(rest.n + 1);
        if (!grown) scr_trap("scriptc: out of memory\n");
        grown[0] = '/';
        memcpy(grown + 1, rest.p, rest.n);
        free(rest.p);
        rest.p = grown;
        rest.n++;
      }
    }
  }

  if (!(lower_proto && lu_is(lower_proto, "javascript:"))) {
    /* autoEscapeStr */
    bool any = false;
    for (size_t i = 0; i < rest.n && !any; i++) {
      unsigned char c = (unsigned char)rest.p[i];
      any = c < 126 && lu_auto_escape[c];
    }
    if (any) {
      ScrJsonBuf esc;
      scr_jb_init(&esc);
      for (size_t i = 0; i < rest.n; i++) {
        unsigned char c = (unsigned char)rest.p[i];
        if (c < 126 && lu_auto_escape[c]) scr_jb_puts(&esc, lu_auto_escape[c]);
        else scr_jb_write(&esc, rest.p + i, 1);
      }
      ScrStr *escaped = scr_jb_finish(&esc);
      lu_span_set(&rest, escaped->data, escaped->len);
      scr_str_release(escaped);
    }
  }

  long question = -1, hash_at = -1;
  for (size_t i = 0; i < rest.n; i++) {
    if (rest.p[i] == '#') {
      self->hash = lu_str(rest.p + i, rest.n - i);
      hash_at = (long)i;
      break;
    }
    if (rest.p[i] == '?' && question == -1) question = (long)i;
  }
  if (question != -1) {
    size_t stop = hash_at == -1 ? rest.n : (size_t)hash_at;
    self->search = lu_str(rest.p + question, stop - (size_t)question);
    ScrStr *q = lu_str(rest.p + question + 1, stop - (size_t)question - 1);
    if (parse_query) {
      self->query_obj = scr_qs_parse_dyn(q);
      scr_str_release(q);
    } else {
      self->query = q;
    }
  } else if (parse_query) {
    self->query_obj = scr_dyn_new_obj_null_proto();
  }
  bool use_question = question != -1 && (hash_at == -1 || question < hash_at);
  long first = use_question ? question : hash_at;
  if (first == -1) {
    if (rest.n > 0) self->pathname = lu_str(rest.p, rest.n);
  } else if (first > 0) {
    self->pathname = lu_str(rest.p, (size_t)first);
  }
  if (lu_slashed_protocol(lower_proto) && lu_truthy(self->hostname) && !lu_truthy(self->pathname))
    lu_set(&self->pathname, lu_str("/", 1));
  if (lu_truthy(self->pathname) || lu_truthy(self->search)) {
    lu_set(&self->path, lu_cat(lu_truthy(self->pathname) ? self->pathname : NULL,
                               lu_truthy(self->search) ? self->search : NULL));
  }
  {
    /* format() stringifies an object query even when search wins, so a
     * lone surrogate in it throws here too. */
    ScrStr *query = self->query_obj ? scr_qs_stringify(self->query_obj, NULL, NULL) : NULL;
    if (self->query_obj && !query) {
      failed = true;
      goto done;
    }
    self->href = lu_format(self, query);
    if (query) scr_str_release(query);
    failed = self->href == NULL;
  }
done:
  free(rest.p);
  if (proto) scr_str_release(proto);
  if (lower_proto) scr_str_release(lower_proto);
  return !failed;
}

/* ── checked-dynamic boundary ──────────────────────────────────────── */

static ScrDyn *lu_box(const ScrStr *s) { return s ? scr_dyn_new_str((ScrStr *)s) : scr_dyn_new_null(); }

static SCR_TL ScrDyn *lu_prototype = NULL;
static ScrDyn *lu_url_prototype(void);

static ScrDyn *lu_to_dyn(const LegacyUrl *u) {
  ScrDyn *o = scr_dyn_new_obj();
  o->prototype = scr_dyn_retain(lu_url_prototype());
  scr_dyn_obj_set(o, "protocol", 8, lu_box(u->protocol));
  scr_dyn_obj_set(o, "slashes", 7, u->slashes ? scr_dyn_new_bool(true) : scr_dyn_new_null());
  scr_dyn_obj_set(o, "auth", 4, lu_box(u->auth));
  scr_dyn_obj_set(o, "host", 4, lu_box(u->host));
  scr_dyn_obj_set(o, "port", 4, lu_box(u->port));
  scr_dyn_obj_set(o, "hostname", 8, lu_box(u->hostname));
  scr_dyn_obj_set(o, "hash", 4, lu_box(u->hash));
  scr_dyn_obj_set(o, "search", 6, lu_box(u->search));
  scr_dyn_obj_set(o, "query", 5, u->query_obj ? scr_dyn_retain(u->query_obj) : lu_box(u->query));
  scr_dyn_obj_set(o, "pathname", 8, lu_box(u->pathname));
  scr_dyn_obj_set(o, "path", 4, lu_box(u->path));
  scr_dyn_obj_set(o, "href", 4, lu_box(u->href));
  return o;
}

static void lu_arg_type(const char *name, const char *expected, const ScrDyn *got) {
  scr_dyn_arg_type_fail(name, expected, got);
}

static const ScrDyn *lu_unwrap(const ScrDyn *v) {
  while (v && v->kind == SCR_DYN_PROXY) v = v->v.proxy.target;
  return v;
}

/* A string argument validateString accepts, or NULL with its TypeError
 * pending. */
static const ScrStr *lu_string_arg(const ScrDyn *v, const char *name) {
  if (v && v->kind == SCR_DYN_STR) return v->v.str;
  lu_arg_type(name, "of type string", v);
  return NULL;
}

/* `url instanceof Url`: Url.prototype on the prototype chain. */
static bool lu_is_url_instance(const ScrDyn *v) {
  if (!v || v->kind != SCR_DYN_OBJ || !lu_prototype) return false;
  for (const ScrDyn *p = v->prototype; p; p = p->prototype)
    if (p == lu_prototype) return true;
  return false;
}

ScrDyn *scr_url_legacy_parse(const ScrDyn *url, const ScrDyn *parse_query, const ScrDyn *slashes,
                             bool warn) {
  lu_warn_parse(warn);
  if (lu_is_url_instance(url)) return scr_dyn_retain((ScrDyn *)url);
  const ScrStr *s = lu_string_arg(url, "url");
  if (!s) return NULL;
  LegacyUrl u = {0};
  if (!lu_parse(&u, s, scr_dyn_truthy(parse_query), scr_dyn_truthy(slashes))) {
    lu_free(&u);
    return NULL;
  }
  ScrDyn *out = lu_to_dyn(&u);
  lu_free(&u);
  return out;
}

/* A property read with JS truthiness and string conversion: NULL for a
 * falsy or absent value (format treats both alike), else the string; a
 * throwing conversion sets *failed. */
static ScrStr *lu_field(const ScrDyn *obj, const char *key, bool *failed) {
  ScrDyn *v = NULL;
  for (const ScrDyn *o = obj; o && !v; o = o->prototype) {
    if (o->kind == SCR_DYN_OBJ) v = scr_dyn_obj_get(o, key, strlen(key));
  }
  if (!v || !scr_dyn_truthy(v) || *failed) return NULL;
  if (v->kind == SCR_DYN_STR) return scr_str_retain(v->v.str);
  ScrStr *s = scr_dyn_string_coerce_js(v);
  if (!s) *failed = true;
  return s;
}

static ScrDyn *lu_raw_field(const ScrDyn *obj, const char *key) {
  for (const ScrDyn *o = obj; o; o = o->prototype) {
    if (o->kind != SCR_DYN_OBJ) continue;
    ScrDyn *v = scr_dyn_obj_get(o, key, strlen(key));
    if (v) return v;
  }
  return NULL;
}

/* url.format(URL, options): Node's binding over the WHATWG record. */
static ScrStr *lu_format_whatwg(ScrUrl *url, const ScrDyn *options) {
  bool fragment = true, unicode = false, search = true, auth = true;
  options = lu_unwrap(options);
  if (options && scr_dyn_truthy(options)) {
    /* validateObject: any object but an array or a function. */
    bool array = options->kind == SCR_DYN_ARR ||
                 (options->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(options));
    bool object = options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_TYPED_REF ||
                  options->kind == SCR_DYN_HANDLE || options->kind == SCR_DYN_BYTES ||
                  options->kind == SCR_DYN_PROMISE;
    if (array || !object) {
      lu_arg_type("options", "of type object", options);
      return NULL;
    }
    ScrDyn *view = options->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(options) : NULL;
    const ScrDyn *o = view ? view : options;
    const char *names[] = {"fragment", "unicode", "search", "auth"};
    bool *slots[] = {&fragment, &unicode, &search, &auth};
    for (size_t i = 0; i < 4; i++) {
      ScrDyn *v = lu_raw_field(o, names[i]);
      if (v && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_UNDEF) *slots[i] = scr_dyn_truthy(v);
    }
    if (view) scr_dyn_release(view);
  }
  ScrUrl copy = *url;
  ScrStr *empty = lu_str("", 0);
  ScrStr *host = NULL;
  if (!fragment) copy.fragment = empty;
  if (!search) copy.query = empty;
  if (!auth) copy.userinfo = empty;
  if (unicode && copy.has_authority) {
    host = scr_idna_to_unicode(copy.host->data, copy.host->len);
    copy.host = host;
  }
  ScrStr *out = scr_url_href(&copy);
  if (host) scr_str_release(host);
  scr_str_release(empty);
  return out;
}

/* Url.prototype.format.call(object) over any object. */
static ScrStr *lu_format_object(const ScrDyn *object) {
  ScrDyn *view = object->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(object) : NULL;
  if (object->kind == SCR_DYN_TYPED_REF && (!view || scr_exc_pending())) {
    if (view) scr_dyn_release(view);
    return NULL;
  }
  const ScrDyn *o = view ? view : object;
  LegacyUrl u = {0};
  bool failed = false;
  u.auth = lu_field(o, "auth", &failed);
  u.protocol = lu_field(o, "protocol", &failed);
  u.pathname = lu_field(o, "pathname", &failed);
  u.hash = lu_field(o, "hash", &failed);
  u.host = lu_field(o, "host", &failed);
  u.hostname = lu_field(o, "hostname", &failed);
  u.port = lu_field(o, "port", &failed);
  u.search = lu_field(o, "search", &failed);
  const ScrDyn *slashes = lu_raw_field(o, "slashes");
  u.slashes = slashes && scr_dyn_truthy(slashes);
  ScrStr *query = NULL;
  const ScrDyn *q = failed ? NULL : lu_unwrap(lu_raw_field(o, "query"));
  if (q && (q->kind == SCR_DYN_OBJ || q->kind == SCR_DYN_ARR || q->kind == SCR_DYN_TYPED_REF ||
            q->kind == SCR_DYN_HANDLE)) {
    query = scr_qs_stringify(q, NULL, NULL);
    failed = query == NULL;
  }
  ScrStr *out = failed ? NULL : lu_format(&u, query);
  if (query) scr_str_release(query);
  lu_free(&u);
  if (view) scr_dyn_release(view);
  return out;
}

ScrStr *scr_url_legacy_format(const ScrDyn *object, const ScrDyn *options, bool warn) {
  object = lu_unwrap(object);
  if (object && object->kind == SCR_DYN_STR) {
    lu_warn_parse(warn);
    LegacyUrl u = {0};
    ScrStr *out = NULL;
    if (lu_parse(&u, object->v.str, false, false)) out = lu_format(&u, NULL);
    lu_free(&u);
    return out;
  }
  if (scr_dyn_native_url_is(object)) return lu_format_whatwg(object->v.handle.ptr, options);
  bool is_object = object && (object->kind == SCR_DYN_OBJ || object->kind == SCR_DYN_ARR ||
                              object->kind == SCR_DYN_HANDLE || object->kind == SCR_DYN_TYPED_REF ||
                              object->kind == SCR_DYN_BYTES || object->kind == SCR_DYN_PROMISE);
  if (!is_object) {
    lu_arg_type("urlObject", "one of type object or string", object);
    return NULL;
  }
  return lu_format_object(object);
}

/* ── Url.prototype ─────────────────────────────────────────────────── */

/* Node's Url.prototype holds five enumerable methods (for...in visits
 * them); format() runs here, and the record-mutating and resolving
 * methods throw an unsupported-operation error. */
static ScrDyn *lu_proto_format(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  const ScrDyn *o = lu_unwrap(self);
  ScrStr *out = NULL;
  if (o->kind == SCR_DYN_UNDEF || o->kind == SCR_DYN_NULL) {
    char message[64];
    int n = snprintf(message, sizeof message, "Cannot read properties of %s (reading 'auth')",
                     o->kind == SCR_DYN_UNDEF ? "undefined" : "null");
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, NULL);
  } else if (o->kind == SCR_DYN_OBJ || o->kind == SCR_DYN_TYPED_REF) {
    out = lu_format_object(o);
  } else {
    static const char message[] = "Url.prototype.format on this receiver has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  scr_dyn_release(self);
  if (!out) return NULL;
  ScrDyn *boxed = scr_dyn_new_str(out);
  scr_str_release(out);
  return boxed;
}

static ScrDyn *lu_proto_fenced(const char *method) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "Url.prototype.");
  scr_jb_puts(&message, method);
  scr_jb_puts(&message, " has no lowering; use url.parse, url.format or url.resolve");
  ScrStr *text = scr_jb_finish(&message);
  scr_throw_error_msg_code(SCR_ERR_ERROR, text->data, text->len, "SC2020");
  scr_str_release(text);
  return NULL;
}

#define LU_FENCED_METHOD(name)                                                     \
  static ScrDyn *lu_proto_##name(ScrClosure *closure, ScrDyn *const *args, size_t argc) { \
    (void)closure;                                                                 \
    (void)args;                                                                    \
    (void)argc;                                                                    \
    return lu_proto_fenced(#name);                                                 \
  }
LU_FENCED_METHOD(parse)
LU_FENCED_METHOD(resolve)
LU_FENCED_METHOD(resolveObject)
LU_FENCED_METHOD(parseHost)

static SCR_TL ScrDyn *lu_constructor = NULL;

/* Node's Url constructor initializes its receiver only: the twelve fields in
 * declaration order, all null, and answers undefined. Its body runs in
 * strict mode, so a primitive or nullish receiver throws the catchable
 * TypeError scr_dyn_key_set builds ("Cannot create property 'protocol' on
 * number '5'", "Cannot set properties of undefined (setting 'protocol')"). */
static ScrDyn *lu_construct(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  static const char *const fields[] = {
      "protocol", "slashes", "auth",   "host", "port",    "hostname",
      "hash",     "search",  "query",  "pathname", "path", "href",
  };
  ScrDyn *self = scr_dyn_this_get();
  for (size_t i = 0; i < sizeof fields / sizeof fields[0] && !scr_exc_pending(); i++) {
    ScrStr *key = lu_cstr(fields[i]);
    ScrDyn *null = scr_dyn_new_null();
    scr_dyn_key_set(self, key, null);
    scr_dyn_release(null);
    scr_str_release(key);
  }
  scr_dyn_release(self);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_undefined();
}

static void lu_class_teardown(void) {
  if (lu_constructor) {
    ScrDyn *ctor = lu_constructor;
    lu_constructor = NULL;
    scr_dyn_release(ctor);
  }
  if (!lu_prototype) return;
  /* The prototype's `constructor` holds the function, whose property table
   * holds the prototype: drop that back edge so both fall to zero. */
  ScrStr *key = lu_cstr("constructor");
  scr_dyn_obj_delete_field(lu_prototype, key);
  scr_str_release(key);
  lu_prototype->v.obj.class_name = NULL;
  scr_dyn_release(lu_prototype);
  lu_prototype = NULL;
}

/* The class is process-lifetime state (built once, released at exit). The
 * RFC audit runs before atexit handlers, so it drops the class first; a
 * later parse() call rebuilds it. Idempotent. */
void scr_url_legacy_class_release(void) { lu_class_teardown(); }

/* Url.prototype and the Url constructor exist together: parse() results carry
 * the prototype, and the constructor's `prototype` is the same object, so
 * `new Url()` is an instance of url.Url. The prototype's own keys are in
 * Node's order (constructor, then the five enumerable methods) and the
 * constructor's `prototype` is Node's ordinary-function property: writable,
 * non-enumerable, non-configurable. */
static ScrDyn *lu_url_class(void) {
  if (lu_constructor) return lu_constructor;
  static const struct {
    const char *name;
    uint32_t arity;
    ScrDynThunk thunk;
  } methods[] = {
      {"parse", 3, lu_proto_parse},
      {"format", 0, lu_proto_format},
      {"resolve", 1, lu_proto_resolve},
      {"resolveObject", 1, lu_proto_resolveObject},
      {"parseHost", 0, lu_proto_parseHost},
  };
  ScrDyn *proto = scr_dyn_new_obj();
  proto->v.obj.class_name = "Url";
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->function_kind = SCR_CLOSURE_KIND_OWN_PROTOTYPE;
  ScrDyn *ctor = scr_dyn_new_func(closure, lu_construct, 0, "native:url", "Url");
  scr_dyn_obj_set(proto, "constructor", 11, scr_dyn_retain(ctor));
  size_t index = scr_dyn_obj_index_of(proto, "constructor", 11);
  if (index != SIZE_MAX) scr_dyn_obj_set_attrs_at(proto, index, true, false, true);
  for (size_t i = 0; i < sizeof methods / sizeof methods[0]; i++)
    scr_dyn_obj_set(proto, methods[i].name, strlen(methods[i].name),
                    scr_dyn_new_func(scr_closure_new(NULL, 0), methods[i].thunk, methods[i].arity,
                                     "native:url.Url", methods[i].name));
  scr_dyn_fn_seed_prototype(ctor, scr_dyn_retain(proto));
  ScrDyn *table = scr_dyn_function_properties(ctor);
  index = scr_dyn_obj_index_of(table, "prototype", 9);
  if (index != SIZE_MAX) scr_dyn_obj_set_attrs_at(table, index, true, false, false);
  scr_dyn_release(table);
  lu_prototype = proto;
  lu_constructor = ctor;
  scr_atexit(lu_class_teardown);
  return ctor;
}

static ScrDyn *lu_url_prototype(void) {
  if (!lu_prototype) lu_url_class();
  return lu_prototype;
}

ScrDyn *scr_url_legacy_class(void) { return scr_dyn_retain(lu_url_class()); }

/* ── resolve ───────────────────────────────────────────────────────── */

typedef struct {
  ScrStr **items;
  size_t len, cap;
} LuPath;

static void lp_insert(LuPath *p, size_t at, ScrStr *s /* moves in */) {
  if (p->len == p->cap) {
    p->cap = p->cap ? p->cap * 2 : 8;
    ScrStr **grown = realloc(p->items, p->cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    p->items = grown;
  }
  memmove(p->items + at + 1, p->items + at, (p->len - at) * sizeof *p->items);
  p->items[at] = s;
  p->len++;
}
static void lp_push(LuPath *p, ScrStr *s) { lp_insert(p, p->len, s); }
static void lp_unshift(LuPath *p, ScrStr *s) { lp_insert(p, 0, s); }
static ScrStr *lp_shift(LuPath *p) {
  ScrStr *s = p->items[0];
  memmove(p->items, p->items + 1, (p->len - 1) * sizeof *p->items);
  p->len--;
  return s;
}
static void lp_remove(LuPath *p, size_t at) {
  scr_str_release(p->items[at]);
  memmove(p->items + at, p->items + at + 1, (p->len - at - 1) * sizeof *p->items);
  p->len--;
}
static void lp_free(LuPath *p) {
  for (size_t i = 0; i < p->len; i++) scr_str_release(p->items[i]);
  free(p->items);
  p->items = NULL;
  p->len = p->cap = 0;
}
static void lp_split(LuPath *p, const ScrStr *s) {
  size_t start = 0;
  for (size_t i = 0; i <= s->len; i++) {
    if (i == s->len || s->data[i] == '/') {
      lp_push(p, lu_str(s->data + start, i - start));
      start = i + 1;
    }
  }
}
static ScrStr *lp_join(const LuPath *p) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  for (size_t i = 0; i < p->len; i++) {
    if (i) scr_jb_putc(&b, '/');
    scr_jb_put_str(&b, p->items[i]);
  }
  return scr_jb_finish(&b);
}
static bool lp_first_is(const LuPath *p, const char *lit) { return p->len > 0 && lu_is(p->items[0], lit); }

static void lu_set_path(LegacyUrl *r) {
  lu_set(&r->path, lu_cat(lu_truthy(r->pathname) ? r->pathname : NULL,
                          lu_truthy(r->search) ? r->search : NULL));
}

/* Splits "auth@host[@...]" stuck in the host (mailto:-style resolutions). */
static void lu_auth_in_host(LegacyUrl *r) {
  if (!lu_truthy(r->host)) return;
  const char *at = memchr(r->host->data, '@', r->host->len);
  if (!at || at == r->host->data) return;
  size_t first = (size_t)(at - r->host->data);
  const char *rest = at + 1;
  size_t rest_len = r->host->len - first - 1;
  const char *next = memchr(rest, '@', rest_len);
  size_t second = next ? (size_t)(next - rest) : rest_len;
  ScrStr *host = lu_str(rest, second);
  lu_set(&r->auth, lu_str(r->host->data, first));
  lu_set(&r->hostname, scr_str_retain(host));
  lu_set(&r->host, host);
}

/* Url.prototype.resolveObject(relative) with both records fresh parses. */
static void lu_resolve_object(LegacyUrl *result, const LegacyUrl *self, LegacyUrl *rel) {
  lu_copy(result, self);
  lu_set(&result->hash, lu_ref(rel->hash));
  if (rel->href && rel->href->len == 0) return;
  if (rel->slashes && !lu_truthy(rel->protocol)) {
    ScrStr *protocol = lu_ref(result->protocol);
    lu_copy(result, rel);
    lu_set(&result->protocol, protocol);
    if (lu_slashed_protocol(result->protocol) && lu_truthy(result->hostname) &&
        !lu_truthy(result->pathname)) {
      lu_set(&result->pathname, lu_str("/", 1));
      lu_set(&result->path, lu_str("/", 1));
    }
    return;
  }
  if (lu_truthy(rel->protocol) && !lu_eq(rel->protocol, result->protocol)) {
    if (!lu_slashed_protocol(rel->protocol)) {
      lu_copy(result, rel);
      return;
    }
    lu_set(&result->protocol, lu_ref(rel->protocol));
    if (!lu_truthy(rel->host) && !lu_is(rel->protocol, "file") && !lu_is(rel->protocol, "file:") &&
        !lu_hostless_protocol(rel->protocol)) {
      LuPath rel_path = {0};
      ScrStr *empty = lu_str("", 0);
      lp_split(&rel_path, lu_truthy(rel->pathname) ? rel->pathname : empty);
      scr_str_release(empty);
      while (rel_path.len) {
        lu_set(&rel->host, lp_shift(&rel_path));
        if (lu_truthy(rel->host)) break;
      }
      if (!lu_truthy(rel->host)) lu_set(&rel->host, lu_str("", 0));
      if (!lu_truthy(rel->hostname)) lu_set(&rel->hostname, lu_str("", 0));
      if (!lp_first_is(&rel_path, "")) lp_unshift(&rel_path, lu_str("", 0));
      if (rel_path.len < 2) lp_unshift(&rel_path, lu_str("", 0));
      lu_set(&result->pathname, lp_join(&rel_path));
      lp_free(&rel_path);
    } else {
      lu_set(&result->pathname, lu_ref(rel->pathname));
    }
    lu_set(&result->search, lu_ref(rel->search));
    lu_set(&result->query, lu_ref(rel->query));
    lu_set(&result->host, lu_truthy(rel->host) ? scr_str_retain(rel->host) : lu_str("", 0));
    lu_set(&result->auth, lu_ref(rel->auth));
    lu_set(&result->hostname, lu_ref(lu_truthy(rel->hostname) ? rel->hostname : rel->host));
    lu_set(&result->port, lu_ref(rel->port));
    if (lu_truthy(result->pathname) || lu_truthy(result->search)) lu_set_path(result);
    result->slashes = result->slashes || rel->slashes;
    return;
  }

  bool is_source_abs = lu_truthy(result->pathname) && result->pathname->data[0] == '/';
  bool is_rel_abs = lu_truthy(rel->host) || (lu_truthy(rel->pathname) && rel->pathname->data[0] == '/');
  bool must_end_abs = is_rel_abs || is_source_abs || (lu_truthy(result->host) && lu_truthy(rel->pathname));
  bool remove_all_dots = must_end_abs;
  LuPath src_path = {0}, rel_path = {0};
  if (lu_truthy(result->pathname)) lp_split(&src_path, result->pathname);
  if (lu_truthy(rel->pathname)) lp_split(&rel_path, rel->pathname);
  bool no_leading_slashes = lu_truthy(result->protocol) && !lu_slashed_protocol(result->protocol);

  if (no_leading_slashes) {
    lu_set(&result->hostname, lu_str("", 0));
    lu_set(&result->port, NULL);
    if (lu_truthy(result->host)) {
      if (lp_first_is(&src_path, "")) {
        scr_str_release(src_path.items[0]);
        src_path.items[0] = scr_str_retain(result->host);
      } else {
        lp_unshift(&src_path, scr_str_retain(result->host));
      }
    }
    lu_set(&result->host, lu_str("", 0));
    if (lu_truthy(rel->protocol)) {
      lu_set(&rel->hostname, NULL);
      lu_set(&rel->port, NULL);
      lu_set(&result->auth, NULL);
      if (lu_truthy(rel->host)) {
        if (lp_first_is(&rel_path, "")) {
          scr_str_release(rel_path.items[0]);
          rel_path.items[0] = scr_str_retain(rel->host);
        } else {
          lp_unshift(&rel_path, scr_str_retain(rel->host));
        }
      }
      lu_set(&rel->host, NULL);
    }
    must_end_abs = must_end_abs && (lp_first_is(&rel_path, "") || lp_first_is(&src_path, ""));
  }

  if (is_rel_abs) {
    if (rel->host) {
      if (!lu_eq(result->host, rel->host)) lu_set(&result->auth, NULL);
      lu_set(&result->host, scr_str_retain(rel->host));
      lu_set(&result->port, lu_ref(rel->port));
    }
    if (rel->hostname) {
      if (!lu_eq(result->hostname, rel->hostname)) lu_set(&result->auth, NULL);
      lu_set(&result->hostname, scr_str_retain(rel->hostname));
    }
    lu_set(&result->search, lu_ref(rel->search));
    lu_set(&result->query, lu_ref(rel->query));
    lp_free(&src_path);
    src_path = rel_path;
    rel_path = (LuPath){0};
  } else if (rel_path.len) {
    if (src_path.len) lp_remove(&src_path, src_path.len - 1);
    for (size_t i = 0; i < rel_path.len; i++) lp_push(&src_path, scr_str_retain(rel_path.items[i]));
    lu_set(&result->search, lu_ref(rel->search));
    lu_set(&result->query, lu_ref(rel->query));
  } else if (rel->search) {
    if (no_leading_slashes) {
      ScrStr *first = src_path.len ? lp_shift(&src_path) : NULL;
      lu_set(&result->hostname, lu_ref(first));
      lu_set(&result->host, first);
      lu_auth_in_host(result);
    }
    lu_set(&result->search, lu_ref(rel->search));
    lu_set(&result->query, lu_ref(rel->query));
    if (result->pathname || result->search) lu_set_path(result);
    lp_free(&src_path);
    lp_free(&rel_path);
    return;
  }

  if (!src_path.len) {
    lu_set(&result->pathname, NULL);
    lu_set(&result->path, lu_truthy(result->search) ? lu_prefix("/", result->search) : NULL);
    lp_free(&src_path);
    lp_free(&rel_path);
    return;
  }

  const ScrStr *last = src_path.items[src_path.len - 1];
  bool dots = lu_is(last, ".") || lu_is(last, "..");
  bool has_trailing_slash =
      ((lu_truthy(result->host) || lu_truthy(rel->host) || src_path.len > 1) && dots) || lu_is(last, "");
  size_t up = 0;
  for (size_t i = src_path.len; i-- > 0;) {
    const ScrStr *seg = src_path.items[i];
    if (lu_is(seg, ".")) {
      lp_remove(&src_path, i);
    } else if (lu_is(seg, "..")) {
      lp_remove(&src_path, i);
      up++;
    } else if (up) {
      lp_remove(&src_path, i);
      up--;
    }
  }
  if (!must_end_abs && !remove_all_dots) {
    for (; up; up--) lp_unshift(&src_path, lu_str("..", 2));
  }
  if (must_end_abs && !lp_first_is(&src_path, "") &&
      (src_path.len == 0 || src_path.items[0]->len == 0 || src_path.items[0]->data[0] != '/'))
    lp_unshift(&src_path, lu_str("", 0));
  if (has_trailing_slash) {
    ScrStr *joined = lp_join(&src_path);
    if (joined->len == 0 || joined->data[joined->len - 1] != '/') lp_push(&src_path, lu_str("", 0));
    scr_str_release(joined);
  }
  bool is_absolute = lp_first_is(&src_path, "") ||
                     (src_path.len > 0 && src_path.items[0]->len > 0 && src_path.items[0]->data[0] == '/');
  if (no_leading_slashes) {
    ScrStr *host = is_absolute ? lu_str("", 0) : src_path.len ? lp_shift(&src_path) : lu_str("", 0);
    lu_set(&result->hostname, scr_str_retain(host));
    lu_set(&result->host, host);
    lu_auth_in_host(result);
  }
  must_end_abs = must_end_abs || (lu_truthy(result->host) && src_path.len > 0);
  if (must_end_abs && !is_absolute) lp_unshift(&src_path, lu_str("", 0));
  if (!src_path.len) {
    lu_set(&result->pathname, NULL);
    lu_set(&result->path, NULL);
  } else {
    lu_set(&result->pathname, lp_join(&src_path));
  }
  if (result->pathname || result->search) lu_set_path(result);
  if (lu_truthy(rel->auth)) lu_set(&result->auth, scr_str_retain(rel->auth));
  result->slashes = result->slashes || rel->slashes;
  lp_free(&src_path);
  lp_free(&rel_path);
}

ScrStr *scr_url_legacy_resolve(const ScrDyn *from, const ScrDyn *to, bool warn) {
  lu_warn_parse(warn);
  const ScrStr *source = lu_string_arg(lu_unwrap(from), "url");
  if (!source) return NULL;
  LegacyUrl self = {0}, rel = {0}, result = {0};
  ScrStr *out = NULL;
  if (lu_parse(&self, source, false, true)) {
    const ScrStr *relative = lu_string_arg(lu_unwrap(to), "url");
    if (relative && lu_parse(&rel, relative, false, true)) {
      lu_resolve_object(&result, &self, &rel);
      out = lu_format(&result, NULL);
    }
  }
  lu_free(&self);
  lu_free(&rel);
  lu_free(&result);
  return out;
}

/* ── url.domainToASCII / url.domainToUnicode ───────────────────────── */

/* The WHATWG IPv4 parser's number rule: decimal, 0x hex, or 0-led octal. */
static bool lu_ipv4_number(const char *p, size_t n, uint64_t *out) {
  unsigned radix = 10;
  if (n >= 2 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
    radix = 16;
    p += 2;
    n -= 2;
  } else if (n >= 2 && p[0] == '0') {
    radix = 8;
    p++;
    n--;
  }
  uint64_t v = 0;
  for (size_t i = 0; i < n; i++) {
    char c = p[i];
    unsigned d;
    if (c >= '0' && c <= '9') d = (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f') d = (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') d = (unsigned)(c - 'A' + 10);
    else return false;
    if (d >= radix) return false;
    v = v * radix + d;
    if (v > 0xFFFFFFFFull) v = 0x100000000ull; /* saturate: past every limit */
  }
  *out = v;
  return true;
}

/* The ends-in-a-number checker. */
static bool lu_ends_in_number(const char *p, size_t n) {
  if (n > 0 && p[n - 1] == '.') {
    if (n == 1) return false;
    n--;
  }
  size_t start = n;
  while (start > 0 && p[start - 1] != '.') start--;
  const char *last = p + start;
  size_t len = n - start;
  if (len == 0) return false;
  bool digits = true;
  for (size_t i = 0; i < len && digits; i++) digits = last[i] >= '0' && last[i] <= '9';
  if (digits) return true;
  uint64_t ignored;
  return len >= 2 && last[0] == '0' && (last[1] == 'x' || last[1] == 'X') &&
         lu_ipv4_number(last, len, &ignored);
}

static bool lu_parse_ipv4(const char *p, size_t n, ScrJsonBuf *out) {
  if (n > 0 && p[n - 1] == '.') n--;
  uint64_t parts[4];
  size_t count = 0;
  size_t start = 0;
  for (size_t i = 0; i <= n; i++) {
    if (i < n && p[i] != '.') continue;
    if (count == 4) return false;
    if (i == start || !lu_ipv4_number(p + start, i - start, &parts[count])) return false;
    count++;
    start = i + 1;
  }
  for (size_t i = 0; i + 1 < count; i++)
    if (parts[i] > 255) return false;
  if (parts[count - 1] >= (1ull << (8 * (5 - count)))) return false;
  uint64_t ipv4 = parts[count - 1];
  for (size_t i = 0; i + 1 < count; i++) ipv4 += parts[i] << (8 * (3 - i));
  for (int i = 3; i >= 0; i--) {
    scr_jb_put_number(out, (double)((ipv4 >> (8 * i)) & 0xFF));
    if (i) scr_jb_putc(out, '.');
  }
  return true;
}

static int lu_hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* The WHATWG IPv6 parser and serializer (brackets included). */
static bool lu_parse_ipv6(const char *p, size_t n, ScrJsonBuf *out) {
  uint16_t address[8] = {0};
  int piece = 0, compress = -1;
  size_t i = 0;
  if (n == 0) return false;
  if (p[0] == ':') {
    if (n < 2 || p[1] != ':') return false;
    i = 2;
    compress = ++piece;
  }
  while (i < n) {
    if (piece == 8) return false;
    if (p[i] == ':') {
      if (compress != -1) return false;
      i++;
      compress = ++piece;
      continue;
    }
    unsigned value = 0, length = 0;
    while (length < 4 && i < n && lu_hex_digit(p[i]) >= 0) {
      value = value * 16 + (unsigned)lu_hex_digit(p[i]);
      i++;
      length++;
    }
    if (i < n && p[i] == '.') {
      if (length == 0) return false;
      i -= length;
      if (piece > 6) return false;
      int seen = 0;
      while (i < n) {
        int v4 = -1;
        if (seen > 0) {
          if (p[i] == '.' && seen < 4) i++;
          else return false;
        }
        if (i >= n || p[i] < '0' || p[i] > '9') return false;
        while (i < n && p[i] >= '0' && p[i] <= '9') {
          int number = p[i] - '0';
          if (v4 == -1) v4 = number;
          else if (v4 == 0) return false;
          else v4 = v4 * 10 + number;
          if (v4 > 255) return false;
          i++;
        }
        address[piece] = (uint16_t)(address[piece] * 0x100 + v4);
        seen++;
        if (seen == 2 || seen == 4) piece++;
      }
      if (seen != 4) return false;
      break;
    } else if (i < n && p[i] == ':') {
      i++;
      if (i >= n) return false;
    } else if (i < n) {
      return false;
    }
    address[piece++] = (uint16_t)value;
  }
  if (compress != -1) {
    int swaps = piece - compress;
    piece = 7;
    while (piece != 0 && swaps > 0) {
      uint16_t t = address[piece];
      address[piece] = address[compress + swaps - 1];
      address[compress + swaps - 1] = t;
      piece--;
      swaps--;
    }
  } else if (piece != 8) {
    return false;
  }
  /* The longest run of two or more zero pieces compresses (the first on a
   * tie). */
  int best = -1, best_len = 0;
  for (int k = 0; k < 8;) {
    if (address[k] != 0) {
      k++;
      continue;
    }
    int run = k;
    while (run < 8 && address[run] == 0) run++;
    if (run - k > best_len && run - k >= 2) {
      best = k;
      best_len = run - k;
    }
    k = run;
  }
  static const char hex[] = "0123456789abcdef";
  scr_jb_putc(out, '[');
  for (int k = 0; k < 8; k++) {
    if (k == best) {
      scr_jb_puts(out, k == 0 ? "::" : ":");
      k += best_len - 1;
      continue;
    }
    char digits[4];
    int d = 0;
    unsigned v = address[k];
    do {
      digits[d++] = hex[v & 0xF];
      v >>= 4;
    } while (v);
    while (d) scr_jb_putc(out, digits[--d]);
    if (k != 7) scr_jb_putc(out, ':');
  }
  scr_jb_putc(out, ']');
  return true;
}

static bool lu_domain_forbidden(const char *p, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)p[i];
    if (c <= 32 || c >= 127) return true;
    switch (c) {
      case '#': case '%': case '/': case ':': case '<': case '>': case '?': case '@': case '[':
      case '\\': case ']': case '^': case '|':
        return true;
      default:
        break;
    }
  }
  return false;
}

/* Percent-decodes p into raw bytes (invalid escapes stay verbatim). */
static ScrStr *lu_percent_decode(const char *p, size_t n) {
  ScrJsonBuf out;
  scr_jb_init(&out);
  for (size_t i = 0; i < n; i++) {
    if (p[i] == '%' && i + 2 < n && lu_hex_digit(p[i + 1]) >= 0 && lu_hex_digit(p[i + 2]) >= 0) {
      char byte = (char)(lu_hex_digit(p[i + 1]) * 16 + lu_hex_digit(p[i + 2]));
      scr_jb_write(&out, &byte, 1);
      i += 2;
    } else {
      scr_jb_write(&out, p + i, 1);
    }
  }
  return scr_jb_finish(&out);
}

/* The special-scheme host parser's answer for `input`, serialized; NULL
 * on failure. */
static ScrStr *lu_host_parse(const char *p, size_t n) {
  ScrJsonBuf out;
  scr_jb_init(&out);
  if (n == 0) {
    scr_str_release(scr_jb_finish(&out));
    return NULL;
  }
  if (p[0] == '[') {
    if (p[n - 1] != ']' || !lu_parse_ipv6(p + 1, n - 2, &out)) {
      scr_str_release(scr_jb_finish(&out));
      return NULL;
    }
    return scr_jb_finish(&out);
  }
  ScrStr *decoded = lu_percent_decode(p, n);
  ScrStr *ascii = scr_idna_to_ascii(decoded->data, decoded->len);
  scr_str_release(decoded);
  if (ascii->len == 0 || lu_domain_forbidden(ascii->data, ascii->len)) {
    scr_str_release(ascii);
    scr_str_release(scr_jb_finish(&out));
    return NULL;
  }
  if (lu_ends_in_number(ascii->data, ascii->len)) {
    bool ok = lu_parse_ipv4(ascii->data, ascii->len, &out);
    scr_str_release(ascii);
    if (!ok) {
      scr_str_release(scr_jb_finish(&out));
      return NULL;
    }
    return scr_jb_finish(&out);
  }
  scr_str_release(scr_jb_finish(&out));
  return ascii;
}

/* The hostname setter on a special URL (Node's "ws://x" record): the host
 * parser over the input up to the first delimiter, or NULL when the setter
 * fails. */
static ScrStr *lu_set_hostname(const ScrStr *input) {
  const char *hash = memchr(input->data, '#', input->len);
  size_t n = hash ? (size_t)(hash - input->data) : input->len;
  char *host = malloc(n ? n : 1);
  if (!host) scr_trap("scriptc: out of memory\n");
  size_t len = 0;
  for (size_t i = 0; i < n; i++) {
    char c = input->data[i];
    if (c != '\t' && c != '\n' && c != '\r') host[len++] = c;
  }
  size_t location = len;
  bool colon = false;
  for (size_t i = 0; i < len; i++) {
    char c = host[i];
    if (c == '[') {
      const char *close = memchr(host + i, ']', len - i);
      if (!close) break;
      i = (size_t)(close - host);
      continue;
    }
    if (c == ':' || c == '/' || c == '?' || c == '\\') {
      location = i;
      colon = c == ':';
      break;
    }
  }
  ScrStr *out = NULL;
  if (!colon && location > 0) out = lu_host_parse(host, location);
  free(host);
  return out;
}

static ScrStr *lu_domain_input(const ScrDyn *domain, bool missing) {
  if (missing) {
    scr_throw_error_msg_code(SCR_ERR_TYPE, "The \"domain\" argument must be specified", 39,
                             "ERR_MISSING_ARGS");
    return NULL;
  }
  domain = lu_unwrap(domain);
  if (domain->kind == SCR_DYN_STR) return scr_str_retain(domain->v.str);
  return scr_dyn_string_coerce_js(domain);
}

ScrStr *scr_url_domain_to_ascii(const ScrDyn *domain, bool missing) {
  ScrStr *input = lu_domain_input(domain, missing);
  if (!input) return NULL;
  ScrStr *host = input->len ? lu_set_hostname(input) : NULL;
  scr_str_release(input);
  return host ? host : lu_str("", 0);
}

ScrStr *scr_url_domain_to_unicode(const ScrDyn *domain, bool missing) {
  ScrStr *input = lu_domain_input(domain, missing);
  if (!input) return NULL;
  ScrStr *host = input->len ? lu_set_hostname(input) : NULL;
  scr_str_release(input);
  if (!host) return lu_str("", 0);
  ScrStr *out = scr_idna_to_unicode(host->data, host->len);
  scr_str_release(host);
  return out;
}
