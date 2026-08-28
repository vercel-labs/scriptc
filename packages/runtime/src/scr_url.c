/* The WHATWG URL slice (scr_runtime.h has the API contract): an immutable,
 * refcounted URL value parsed once at construction, plus the file-URL
 * bridge pair (fileURLToPath / pathToFileURL).
 *
 * The parser covers the WHATWG algorithm's common ground exactly — pinned
 * against Node by the differential corpus:
 *   - scheme lowercasing; "Invalid URL" TypeError on schemeless input
 *   - special schemes (http/https/ws/wss/ftp/file): authority parsing with
 *     host lowercasing, default-port removal (leading zeros stripped),
 *     canonical bracketed IPv6 literals,
 *     backslash-as-slash, and any run of leading slashes tolerated
 *     (http:foo.com works); file: takes an authority only after exactly
 *     "//" (file:/x and file:x are host-less absolute paths, like Node)
 *   - dot-segment removal with %2e equivalence (case-insensitive), empty
 *     segments preserved (http://h//a stays //a)
 *   - percent-ENCODING of the WHATWG path/query/fragment/userinfo sets
 *     (space, quotes, angle brackets, braces, non-ASCII UTF-8 bytes, ...);
 *     existing %-sequences pass through verbatim (no decode, no case
 *     normalization — like Node)
 *   - non-special schemes: "//" parses an authority (host case preserved),
 *     a single "/" roots a normalized path, anything else is an OPAQUE
 *     path kept verbatim (data:text/plain,hi there)
 *
 * DOCUMENTED DIVERGENCES (SEMANTICS.md): non-ASCII and %-escaped hosts are
 * rejected with "Invalid URL" (no IDNA/punycode), and opaque paths skip
 * the spec's C0-encode pass (kept verbatim).
 *
 * Failures THROW catchable TypeErrors through the exception cell with
 * Node's messages; callers are compiler-emitted pending checks. */
#include "scr_runtime.h"
#include "scr_url_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#endif

ScrUrl *scr_url_retain(ScrUrl *u) {
  if (u->rc != SIZE_MAX) u->rc++;
  return u;
}

void scr_url_release(ScrUrl *u) {
  if (!u || u->rc == SIZE_MAX) return;
  if (--u->rc == 0) {
    scr_str_release(u->scheme);
    scr_str_release(u->userinfo);
    scr_str_release(u->host);
    scr_str_release(u->port);
    scr_str_release(u->path);
    scr_str_release(u->query);
    scr_str_release(u->fragment);
    free(u);
  }
}

void *scr_url_retain_v(void *p) { return scr_url_retain(p); }
void scr_url_release_v(void *p) { scr_url_release(p); }

/* ── a tiny growable byte buffer (mirrors scr_path.c's) ──────────────── */

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

/* WHATWG's IPv6 serializer: lowercase hexadecimal with the first longest
 * run of two-or-more zero pieces compressed. inet_pton supplies the parser,
 * while serializing the eight pieces here also avoids the platform-specific
 * dotted-decimal spelling inet_ntop uses for IPv4-mapped addresses. */
static bool ub_append_ipv6(UrlBuf *out, const char *raw, size_t len) {
  char *text = malloc(len + 1);
  if (!text) scr_trap("scriptc: out of memory\n");
  memcpy(text, raw, len);
  text[len] = '\0';
  struct in6_addr address;
  bool valid = inet_pton(AF_INET6, text, &address) == 1;
  free(text);
  if (!valid) return false;

  const unsigned char *bytes = (const unsigned char *)&address;
  uint16_t pieces[8];
  for (size_t i = 0; i < 8; i++) {
    pieces[i] = (uint16_t)(((uint16_t)bytes[i * 2] << 8) |
                           bytes[i * 2 + 1]);
  }
  size_t best_start = 0;
  size_t best_len = 0;
  for (size_t i = 0; i < 8;) {
    if (pieces[i] != 0) {
      i++;
      continue;
    }
    size_t start = i;
    while (i < 8 && pieces[i] == 0) i++;
    size_t run = i - start;
    if (run > best_len) {
      best_start = start;
      best_len = run;
    }
  }
  if (best_len < 2) best_len = 0;

  ub_push(out, '[');
  bool first = true;
  size_t compressed_end = best_start + best_len;
  for (size_t i = 0; i < 8;) {
    if (best_len > 0 && i == best_start) {
      ub_append(out, "::", 2);
      first = false;
      i = compressed_end;
      continue;
    }
    if (!first && (best_len == 0 || i != compressed_end)) ub_push(out, ':');
    char hex[5];
    int hex_len = snprintf(hex, sizeof hex, "%x", pieces[i]);
    if (hex_len <= 0 || (size_t)hex_len >= sizeof hex) return false;
    ub_append(out, hex, (size_t)hex_len);
    first = false;
    i++;
  }
  ub_push(out, ']');
  return true;
}

/* ── percent-encode sets (WHATWG) ────────────────────────────────────── */

static bool enc_always(unsigned char c) {
  return c < 0x20 || c == 0x7f || c >= 0x80; /* C0, DEL, non-ASCII */
}

static bool enc_fragment(unsigned char c) {
  return enc_always(c) || c == ' ' || c == '"' || c == '<' || c == '>' || c == '`';
}

static bool enc_query(unsigned char c, bool special) {
  return enc_always(c) || c == ' ' || c == '"' || c == '#' || c == '<' || c == '>' ||
         (special && c == '\'');
}

static bool enc_path(unsigned char c) {
  return enc_query(c, false) || c == '?' || c == '`' || c == '{' || c == '}';
}

static bool enc_userinfo(unsigned char c) {
  return enc_path(c) || c == '/' || c == ':' || c == ';' || c == '=' || c == '@' ||
         c == '[' || c == '\\' || c == ']' || c == '^' || c == '|';
}

static void ub_push_encoded(UrlBuf *b, unsigned char c, bool (*needs)(unsigned char)) {
  if (needs(c)) {
    char hex[4];
    snprintf(hex, sizeof hex, "%%%02X", c);
    ub_append(b, hex, 3);
  } else {
    ub_push(b, (char)c);
  }
}

/* ── parsing ─────────────────────────────────────────────────────────── */

static void scr_url_throw_invalid(void) {
  scr_throw_error_msg(SCR_ERR_TYPE, "Invalid URL", 11);
}

static bool is_special_scheme(const char *s, size_t len) {
  static const char *specials[] = {"http", "https", "ws", "wss", "ftp", "file"};
  for (size_t i = 0; i < 6; i++) {
    if (strlen(specials[i]) == len && memcmp(specials[i], s, len) == 0) return true;
  }
  return false;
}

/* The scheme's default port as text, or NULL. */
static const char *default_port(const char *scheme, size_t len) {
  if ((len == 4 && memcmp(scheme, "http", 4) == 0) || (len == 2 && memcmp(scheme, "ws", 2) == 0)) {
    return "80";
  }
  if ((len == 5 && memcmp(scheme, "https", 5) == 0) || (len == 3 && memcmp(scheme, "wss", 3) == 0)) {
    return "443";
  }
  if (len == 3 && memcmp(scheme, "ftp", 3) == 0) return "21";
  return NULL;
}

static bool seg_is_dot(const char *s, size_t len) {
  if (len == 1 && s[0] == '.') return true;
  return len == 3 && s[0] == '%' && s[1] == '2' && (s[2] == 'e' || s[2] == 'E');
}

static bool seg_is_dotdot(const char *s, size_t len) {
  if (len == 2) return seg_is_dot(s, 1) && seg_is_dot(s + 1, 1);
  if (len == 4) {
    return (seg_is_dot(s, 1) && seg_is_dot(s + 1, 3)) || (seg_is_dot(s, 3) && seg_is_dot(s + 3, 1));
  }
  return len == 6 && seg_is_dot(s, 3) && seg_is_dot(s + 3, 3);
}

/* Rooted-path parse with WHATWG dot-segment handling: `raw` is everything
 * after the authority (or after the scheme's slashes), '?'/'#' excluded.
 * Backslashes act as slashes iff `special`. Output starts with '/' for
 * every non-empty result; empty stays empty (git://host has path ""). */
static ScrStr *parse_rooted_path(const char *raw, size_t len, bool special) {
  if (len == 0) return scr_str_new("", 0); /* no path at all (git://host) */
  /* Collected segment list: one output buffer + an index of segment start
   * offsets (popping a ".." truncates to the previous start). */
  UrlBuf out;
  ub_init(&out);
  size_t seg_starts_cap = 8, seg_count = 0;
  size_t *seg_starts = malloc(seg_starts_cap * sizeof(size_t));
  if (!seg_starts) {
    scr_trap("scriptc: out of memory\n");
  }
  size_t i = 0;
  /* One leading separator opens the first segment (rooted). */
  if (i < len && (raw[i] == '/' || (special && raw[i] == '\\'))) i++;
  size_t seg_begin = i;
  for (;; i++) {
    bool at_end = i >= len;
    bool is_sep = !at_end && (raw[i] == '/' || (special && raw[i] == '\\'));
    if (!at_end && !is_sep) continue;
    const char *seg = raw + seg_begin;
    size_t seg_len = i - seg_begin;
    if (seg_is_dotdot(seg, seg_len)) {
      if (seg_count > 0) {
        seg_count--;
        out.len = seg_starts[seg_count];
      }
      if (at_end) {
        /* Terminal "..": the popped directory's slot stays as an empty
         * segment ("/a/.." → "/"). */
        if (seg_count == seg_starts_cap) {
          seg_starts_cap *= 2;
          seg_starts = realloc(seg_starts, seg_starts_cap * sizeof(size_t));
          if (!seg_starts) scr_trap("scriptc: out of memory\n");
        }
        seg_starts[seg_count++] = out.len;
      }
    } else if (seg_is_dot(seg, seg_len)) {
      if (at_end) {
        if (seg_count == seg_starts_cap) {
          seg_starts_cap *= 2;
          seg_starts = realloc(seg_starts, seg_starts_cap * sizeof(size_t));
          if (!seg_starts) scr_trap("scriptc: out of memory\n");
        }
        seg_starts[seg_count++] = out.len;
      }
    } else {
      if (seg_count == seg_starts_cap) {
        seg_starts_cap *= 2;
        seg_starts = realloc(seg_starts, seg_starts_cap * sizeof(size_t));
        if (!seg_starts) {
          scr_trap("scriptc: out of memory\n");
        }
      }
      seg_starts[seg_count++] = out.len;
      for (size_t j = 0; j < seg_len; j++) {
        ub_push_encoded(&out, (unsigned char)seg[j], enc_path);
      }
    }
    if (at_end) break;
    seg_begin = i + 1;
  }
  /* Serialize: "/" + segment for each. */
  UrlBuf ser;
  ub_init(&ser);
  for (size_t s = 0; s < seg_count; s++) {
    size_t end = s + 1 < seg_count ? seg_starts[s + 1] : out.len;
    ub_push(&ser, '/');
    ub_append(&ser, out.data + seg_starts[s], end - seg_starts[s]);
  }
  free(out.data);
  free(seg_starts);
  return ub_take(&ser);
}

/* Parses `authority` (between the slashes and the path/query/fragment):
 * [userinfo@]host[:port]. Returns false (throws) on invalid input. */
static bool parse_authority(const char *raw, size_t len, bool special, bool is_file,
                            const char *scheme, size_t scheme_len,
                            ScrStr **userinfo, ScrStr **host, ScrStr **port) {
  /* Userinfo: up to the LAST '@'. */
  long at = -1;
  for (size_t i = 0; i < len; i++) {
    if (raw[i] == '@') at = (long)i;
  }
  UrlBuf ub;
  ub_init(&ub);
  if (at >= 0) {
    /* The FIRST ':' separates user from password and stays verbatim;
     * every other byte encodes with the userinfo set. */
    bool seen_colon = false;
    for (long i = 0; i < at; i++) {
      if (raw[i] == ':' && !seen_colon) {
        seen_colon = true;
        ub_push(&ub, ':');
      } else {
        ub_push_encoded(&ub, (unsigned char)raw[i], enc_userinfo);
      }
    }
  }
  *userinfo = ub_take(&ub);
  const char *hp = at >= 0 ? raw + at + 1 : raw;
  size_t hp_len = at >= 0 ? len - (size_t)at - 1 : len;
  /* host[:port], with IPv6 literals bracketed per WHATWG. */
  long colon = -1;
  size_t host_len = hp_len;
  bool ipv6 = hp_len > 0 && hp[0] == '[';
  size_t ipv6_end = 0;
  if (ipv6) {
    while (ipv6_end < hp_len && hp[ipv6_end] != ']') ipv6_end++;
    if (ipv6_end == hp_len || ipv6_end == 1) return false;
    host_len = ipv6_end + 1;
    if (host_len < hp_len) {
      if (hp[host_len] != ':') return false;
      colon = (long)host_len;
    }
  } else {
    for (size_t i = 0; i < hp_len; i++) {
      if (hp[i] == ':') colon = (long)i;
    }
    host_len = colon >= 0 ? (size_t)colon : hp_len;
  }
  /* Validate + lowercase (special) the host. Divergence: non-ASCII and
   * %-escapes (IDNA territory) are rejected outright. */
  UrlBuf hb;
  ub_init(&hb);
  if (ipv6) {
    if (!ub_append_ipv6(&hb, hp + 1, ipv6_end - 1)) {
      free(hb.data);
      return false;
    }
  } else {
    for (size_t i = 0; i < host_len; i++) {
      unsigned char c = (unsigned char)hp[i];
      if (c >= 0x80 || c == '%' || c == ':' || c == '[' || c == ']' ||
          c <= 0x20 || c == '#' || c == '/' || c == '<' || c == '>' ||
          c == '?' || c == '@' || c == '\\' || c == '^' || c == '|') {
        free(hb.data);
        return false;
      }
      if (special && c >= 'A' && c <= 'Z') {
        c = (unsigned char)(c - 'A' + 'a');
      }
      ub_push(&hb, (char)c);
    }
  }
  /* file: "localhost" normalizes to "" at parse time (Node). */
  if (is_file && hb.len == 9 && memcmp(hb.data, "localhost", 9) == 0) hb.len = 0;
  if (hb.len == 0 && special && !is_file) {
    free(hb.data);
    return false; /* http:// — special non-file needs a host */
  }
  *host = ub_take(&hb);
  /* Port: digits only, leading zeros stripped, defaults dropped. */
  UrlBuf pb;
  ub_init(&pb);
  if (colon >= 0) {
    const char *ps = hp + colon + 1;
    size_t ps_len = hp_len - (size_t)colon - 1;
    size_t start = 0;
    while (start < ps_len - (ps_len > 0 ? 1 : 0) && ps[start] == '0') start++;
    long value = 0;
    bool any = false;
    for (size_t i = 0; i < ps_len; i++) {
      if (ps[i] < '0' || ps[i] > '9') {
        free(pb.data);
        return false;
      }
    }
    for (size_t i = start; i < ps_len; i++) {
      value = value * 10 + (ps[i] - '0');
      any = true;
      if (value > 65535) {
        free(pb.data);
        return false;
      }
    }
    if (any && value != 0) {
      char digits[8];
      int dlen = snprintf(digits, sizeof digits, "%ld", value);
      const char *dflt = default_port(scheme, scheme_len);
      if (!(dflt && strlen(dflt) == (size_t)dlen && memcmp(dflt, digits, (size_t)dlen) == 0)) {
        ub_append(&pb, digits, (size_t)dlen);
      }
    } else if (any) {
      /* Port 0 is a real (non-default) port. */
      ub_push(&pb, '0');
    }
  }
  *port = ub_take(&pb);
  return true;
}

/* The full constructor-path parser. Returns NULL after throwing. */
ScrUrl *scr_url_new(ScrStr *input) {
  /* WHATWG pre-processing: trim leading/trailing C0-or-space, strip every
   * TAB/LF/CR. */
  size_t raw_len = input->len;
  const char *raw = input->data;
  size_t b = 0, e = raw_len;
  while (b < e && (unsigned char)raw[b] <= 0x20) b++;
  while (e > b && (unsigned char)raw[e - 1] <= 0x20) e--;
  char *buf = malloc(e - b + 1);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  size_t len = 0;
  for (size_t i = b; i < e; i++) {
    char c = raw[i];
    if (c == '\t' || c == '\n' || c == '\r') continue;
    buf[len++] = c;
  }

  /* Scheme: [A-Za-z][A-Za-z0-9+\-.]* ":" — lowercased. */
  size_t sl = 0;
  if (len > 0 && ((buf[0] >= 'a' && buf[0] <= 'z') || (buf[0] >= 'A' && buf[0] <= 'Z'))) {
    sl = 1;
    while (sl < len &&
           ((buf[sl] >= 'a' && buf[sl] <= 'z') || (buf[sl] >= 'A' && buf[sl] <= 'Z') ||
            (buf[sl] >= '0' && buf[sl] <= '9') || buf[sl] == '+' || buf[sl] == '-' ||
            buf[sl] == '.')) {
      sl++;
    }
  }
  if (sl == 0 || sl >= len || buf[sl] != ':') {
    free(buf);
    scr_url_throw_invalid();
    return NULL;
  }
  for (size_t i = 0; i < sl; i++) {
    if (buf[i] >= 'A' && buf[i] <= 'Z') buf[i] = (char)(buf[i] - 'A' + 'a');
  }
  const char *scheme = buf;
  bool special = is_special_scheme(scheme, sl);
  bool is_file = sl == 4 && memcmp(scheme, "file", 4) == 0;

  const char *rest = buf + sl + 1;
  size_t rest_len = len - sl - 1;

  /* Split off fragment, then query (they never contain '#'/'?' rules we
   * need beyond this). */
  size_t hash = rest_len;
  for (size_t i = 0; i < rest_len; i++) {
    if (rest[i] == '#') {
      hash = i;
      break;
    }
  }
  size_t qmark = hash;
  for (size_t i = 0; i < hash; i++) {
    if (rest[i] == '?') {
      qmark = i;
      break;
    }
  }
  const char *body = rest;
  size_t body_len = qmark;

  ScrStr *userinfo = NULL, *host = NULL, *port = NULL, *path = NULL;
  bool has_authority = false;

  if (special) {
    size_t slashes = 0;
    while (slashes < body_len && (body[slashes] == '/' || body[slashes] == '\\')) slashes++;
    bool file_authority = is_file && slashes == 2;
    bool nonfile = !is_file;
    if (file_authority || nonfile) {
      /* Authority: after the slashes (file: exactly two), up to the next
       * separator. */
      size_t astart = is_file ? 2 : slashes;
      size_t aend = astart;
      while (aend < body_len && body[aend] != '/' && body[aend] != '\\') aend++;
      if (!parse_authority(body + astart, aend - astart, special, is_file, scheme, sl,
                           &userinfo, &host, &port)) {
        scr_str_release(userinfo);
        scr_str_release(host);
        scr_str_release(port);
        free(buf);
        scr_url_throw_invalid();
        return NULL;
      }
      has_authority = true;
      path = parse_rooted_path(body + aend, body_len - aend, special);
      if (path->len == 0) {
        scr_str_release(path);
        path = scr_str_new("/", 1); /* special URLs never have empty paths */
      }
    } else {
      /* file: with 0, 1, or 3+ slashes — host-less absolute path. */
      userinfo = scr_str_new("", 0);
      host = scr_str_new("", 0);
      port = scr_str_new("", 0);
      has_authority = true; /* file: always serializes with "//" */
      size_t skip = slashes > 2 ? 2 : slashes; /* keep surplus slashes as path */
      const char *p = body + skip;
      size_t plen = body_len - skip;
      /* Root the path: parse_rooted_path treats one leading sep as the
       * root; prepend one if absent so "tmp" parses as "/tmp". */
      if (plen > 0 && (p[0] == '/' || p[0] == '\\')) {
        path = parse_rooted_path(p, plen, special);
      } else {
        UrlBuf rb;
        ub_init(&rb);
        ub_push(&rb, '/');
        ub_append(&rb, p, plen);
        ScrStr *tmp = ub_take(&rb);
        path = parse_rooted_path(tmp->data, tmp->len, special);
        scr_str_release(tmp);
      }
      if (path->len == 0) {
        scr_str_release(path);
        path = scr_str_new("/", 1);
      }
    }
  } else if (body_len >= 2 && body[0] == '/' && body[1] == '/') {
    /* Non-special authority (git://host/...): host case preserved. */
    size_t aend = 2;
    while (aend < body_len && body[aend] != '/') aend++;
    if (!parse_authority(body + 2, aend - 2, false, false, scheme, sl, &userinfo, &host, &port)) {
      scr_str_release(userinfo);
      scr_str_release(host);
      scr_str_release(port);
      free(buf);
      scr_url_throw_invalid();
      return NULL;
    }
    has_authority = true;
    path = parse_rooted_path(body + aend, body_len - aend, false);
  } else if (body_len >= 1 && body[0] == '/') {
    /* Rooted path, no authority (foo:/bar/../x → foo:/x). */
    userinfo = scr_str_new("", 0);
    host = scr_str_new("", 0);
    port = scr_str_new("", 0);
    path = parse_rooted_path(body, body_len, false);
  } else {
    /* Opaque path — kept verbatim (divergence: the spec C0-encodes). */
    userinfo = scr_str_new("", 0);
    host = scr_str_new("", 0);
    port = scr_str_new("", 0);
    path = scr_str_new(body, body_len);
  }

  /* Query and fragment, encoded and stored WITH their sigils. */
  UrlBuf qb;
  ub_init(&qb);
  if (qmark < hash) {
    ub_push(&qb, '?');
    for (size_t i = qmark + 1; i < hash; i++) {
      unsigned char c = (unsigned char)rest[i];
      if (enc_query(c, special)) {
        char hex[4];
        snprintf(hex, sizeof hex, "%%%02X", c);
        ub_append(&qb, hex, 3);
      } else {
        ub_push(&qb, (char)c);
      }
    }
  }
  ScrStr *query = ub_take(&qb);
  UrlBuf fb;
  ub_init(&fb);
  if (hash < rest_len) {
    ub_push(&fb, '#');
    for (size_t i = hash + 1; i < rest_len; i++) {
      ub_push_encoded(&fb, (unsigned char)rest[i], enc_fragment);
    }
  }
  ScrStr *fragment = ub_take(&fb);

  ScrStr *scheme_str = scr_str_new(scheme, sl);
  free(buf);

  ScrUrl *u = malloc(sizeof(ScrUrl));
  if (!u) {
    scr_trap("scriptc: out of memory\n");
  }
  u->rc = 1;
  u->scheme = scheme_str;
  u->userinfo = userinfo;
  u->host = host;
  u->port = port;
  u->path = path;
  u->query = query;
  u->fragment = fragment;
  u->has_authority = has_authority;
  u->sp_cache = NULL;
  return u;
}

ScrStr *scr_url_protocol(ScrUrl *u) {
  UrlBuf b;
  ub_init(&b);
  ub_append(&b, u->scheme->data, u->scheme->len);
  ub_push(&b, ':');
  return ub_take(&b);
}

ScrStr *scr_url_pathname(ScrUrl *u) { return scr_str_retain(u->path); }

/* WHATWG host getter: host[:port] — the port only when non-default (the
 * parser already stripped defaults), "" for authority-less URLs. The
 * normalized form findRoute-style authority compares want (lowercased
 * host, no default :443/:80). */
ScrStr *scr_url_host(ScrUrl *u) {
  if (u->port->len == 0) return scr_str_retain(u->host);
  UrlBuf b;
  ub_init(&b);
  ub_append(&b, u->host->data, u->host->len);
  ub_push(&b, ':');
  ub_append(&b, u->port->data, u->port->len);
  return ub_take(&b);
}

/* WHATWG hostname getter: the stored port-less host verbatim ("" for
 * authority-less URLs); IPv6 literals retain their brackets. */
ScrStr *scr_url_hostname(ScrUrl *u) { return scr_str_retain(u->host); }

ScrStr *scr_url_href(ScrUrl *u) {
  UrlBuf b;
  ub_init(&b);
  ub_append(&b, u->scheme->data, u->scheme->len);
  ub_push(&b, ':');
  if (u->has_authority) {
    ub_append(&b, "//", 2);
    if (u->userinfo->len > 0) {
      ub_append(&b, u->userinfo->data, u->userinfo->len);
      ub_push(&b, '@');
    }
    ub_append(&b, u->host->data, u->host->len);
    if (u->port->len > 0) {
      ub_push(&b, ':');
      ub_append(&b, u->port->data, u->port->len);
    }
  }
  ub_append(&b, u->path->data, u->path->len);
  ub_append(&b, u->query->data, u->query->len);
  ub_append(&b, u->fragment->data, u->fragment->len);
  return ub_take(&b);
}

/* ── the file-URL bridge ─────────────────────────────────────────────── */

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* fileURLToPath over a parsed URL: Node's checks, Node's messages. The
 * posix arm rejects hosts and keeps forward slashes; the win32 arm maps
 * hosts to UNC \\host prefixes, flips separators, and demands a drive
 * letter otherwise. The public wrappers below select by TARGET. */
static ScrStr *scr_url_to_path_impl(ScrUrl *u, bool win32) {
  if (!(u->scheme->len == 4 && memcmp(u->scheme->data, "file", 4) == 0)) {
    scr_throw_error_msg(SCR_ERR_TYPE, "The URL must be of scheme file", 30);
    return NULL;
  }
  const char *p = u->path->data;
  size_t len = u->path->len;
  if (win32) {
    /* Node scans the ENCODED pathname for %2f/%2F (/) and %5c/%5C (\). */
    for (size_t n = 0; n + 1 < len; n++) {
      if (p[n] != '%') continue;
      char c1 = p[n + 1];
      int third = (n + 2 < len ? (unsigned char)p[n + 2] : 0) | 0x20;
      if ((c1 == '2' && third == 'f') || (c1 == '5' && third == 'c')) {
        scr_throw_error_msg(SCR_ERR_TYPE,
                             "File URL path must not include encoded \\ or / characters", 56);
        return NULL;
      }
    }
    /* Forward slashes become backslashes FIRST, then percent-decoding
     * (Node's decodeURIComponent order). Invalid sequences pass through
     * verbatim where Node throws URIError — no URIError class exists
     * here (documented divergence, shared with the posix arm). */
    UrlBuf out;
    ub_init(&out);
    if (u->host->len > 0) {
      /* A UNC path: \\host + pathname. (Node passes the hostname through
       * domainToUnicode; this parser rejected non-ASCII/IDN hosts at
       * construction, so the host is already plain ASCII.) */
      ub_append(&out, "\\\\", 2);
      ub_append(&out, u->host->data, u->host->len);
    }
    size_t path_start = out.len;
    for (size_t i = 0; i < len; i++) {
      if (p[i] == '/') {
        ub_push(&out, '\\');
        continue;
      }
      if (p[i] == '%' && i + 2 < len) {
        int hi = hex_val(p[i + 1]);
        int lo = hex_val(p[i + 2]);
        if (hi >= 0 && lo >= 0) {
          ub_push(&out, (char)((hi << 4) | lo));
          i += 2;
          continue;
        }
      }
      ub_push(&out, p[i]);
    }
    if (u->host->len > 0) return ub_take(&out);
    /* A local path requires a drive letter: pathname[1] in [a-zA-Z] and
     * pathname[2] === ':' (both on the DECODED, backslashed pathname). */
    size_t plen = out.len - path_start;
    const char *pp = out.data + path_start;
    int letter = (plen > 1 ? (unsigned char)pp[1] : 0) | 0x20;
    char drive_sep = plen > 2 ? pp[2] : 0;
    if (letter < 'a' || letter > 'z' || drive_sep != ':') {
      free(out.data);
      scr_throw_error_msg(SCR_ERR_TYPE, "File URL path must be absolute", 30);
      return NULL;
    }
    /* pathname.slice(1): the leading backslash drops. */
    ScrStr *s = scr_str_new(pp + 1, plen - 1);
    free(out.data);
    return s;
  }
  if (u->host->len > 0) {
    /* Parse-time normalization already emptied "localhost". */
    const char *plat =
#if defined(__APPLE__)
        "darwin";
#elif defined(__linux__)
        "linux";
#elif defined(_WIN32)
        "win32";
#else
        "posix";
#endif
    char msg[96];
    int mlen = snprintf(msg, sizeof msg, "File URL host must be \"localhost\" or empty on %s", plat);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)mlen);
    return NULL;
  }
  UrlBuf out;
  ub_init(&out);
  for (size_t i = 0; i < len; i++) {
    if (p[i] == '%' && i + 2 < len) {
      int hi = hex_val(p[i + 1]);
      int lo = hex_val(p[i + 2]);
      if (hi >= 0 && lo >= 0) {
        unsigned char decoded = (unsigned char)((hi << 4) | lo);
        if (decoded == '/') {
          free(out.data);
          scr_throw_error_msg(SCR_ERR_TYPE,
                               "File URL path must not include encoded / characters", 51);
          return NULL;
        }
        ub_push(&out, (char)decoded);
        i += 2;
        continue;
      }
    }
    ub_push(&out, p[i]);
  }
  return ub_take(&out);
}

/* The target's arm: Node on Windows takes the win32 branch of the same
 * dispatch (`isWindows` there is this binary's _WIN32 here). */
ScrStr *scr_url_to_path(ScrUrl *u) {
#ifdef _WIN32
  return scr_url_to_path_impl(u, true);
#else
  return scr_url_to_path_impl(u, false);
#endif
}

/* The string-receiver form parses first (Node accepts URL strings). */
ScrStr *scr_url_str_to_path(ScrStr *input) {
  ScrUrl *u = scr_url_new(input);
  if (!u) return NULL; /* Invalid URL already thrown */
  ScrStr *path = scr_url_to_path(u);
  scr_url_release(u);
  return path;
}

/* Assembles the file: URL value pathToFileURL returns (fields direct — no
 * reparse). Takes ownership of host and encoded path. */
static ScrUrl *scr_url_new_file(ScrStr *host, ScrStr *encoded_path) {
  ScrUrl *u = malloc(sizeof(ScrUrl));
  if (!u) {
    scr_trap("scriptc: out of memory\n");
  }
  u->rc = 1;
  u->scheme = scr_str_new("file", 4);
  u->userinfo = scr_str_new("", 0);
  u->host = host;
  u->port = scr_str_new("", 0);
  u->path = encoded_path;
  u->query = scr_str_new("", 0);
  u->fragment = scr_str_new("", 0);
  u->has_authority = true;
  u->sp_cache = NULL;
  return u;
}

/* util.inspect-style single-quoting for ERR_INVALID_ARG_VALUE's
 * "Received" clause ('\' and '\'' escape). */
static void ub_push_inspected(UrlBuf *b, const char *s, size_t len) {
  ub_push(b, '\'');
  for (size_t i = 0; i < len; i++) {
    if (s[i] == '\\' || s[i] == '\'') ub_push(b, '\\');
    ub_push(b, s[i]);
  }
  ub_push(b, '\'');
}

/* Node's ERR_INVALID_ARG_VALUE('path', value, reason) — a TypeError. */
static void scr_url_throw_arg_value(const char *reason, ScrStr *value) {
  UrlBuf msg;
  ub_init(&msg);
  ub_append(&msg, "The argument 'path' ", 20);
  ub_append(&msg, reason, strlen(reason));
  ub_append(&msg, ". Received ", 11);
  ub_push_inspected(&msg, value->data, value->len);
  scr_throw_error_msg(SCR_ERR_TYPE, msg.data, msg.len);
  free(msg.data);
}

/* Percent-encodes a raw filesystem path the way Node's
 * bindingUrl.pathToFileURL does, reusing the parser's rooted-path
 * machinery (WHATWG dot-segment removal with empty segments preserved,
 * backslash-as-slash when `backslash_sep`, the enc_path set): the bytes
 * Node encodes BEYOND that set ('%', '[', ']', '^', '|' — and '\\' when
 * it is a path byte rather than a separator) pre-encode here so the
 * parser passes them through. */
static ScrStr *scr_url_encode_file_path(const char *raw, size_t len, bool backslash_sep) {
  UrlBuf pre;
  ub_init(&pre);
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)raw[i];
    if (c == '%' || c == '[' || c == ']' || c == '^' || c == '|' ||
        (c == '\\' && !backslash_sep)) {
      char hex[4];
      snprintf(hex, sizeof hex, "%%%02X", c);
      ub_append(&pre, hex, 3);
    } else {
      ub_push(&pre, (char)c);
    }
  }
  ScrStr *encoded = parse_rooted_path(pre.data, pre.len, backslash_sep);
  free(pre.data);
  return encoded;
}

/* pathToFileURL: resolve against the cwd (Node does), keep an
 * intentionally-trailing separator, percent-encode. The posix arm
 * %5C-encodes backslashes (valid path bytes there); the win32 arm
 * resolves through path.win32, flips separators, and routes UNC prefixes
 * (\\server\share, \\?\UNC\...) into the URL host — with WHATWG
 * dot-segment removal on the unresolved UNC remainder, exactly Node.
 * Throws only for the win32 UNC malformations (Node's
 * ERR_INVALID_ARG_VALUE TypeErrors). */
static ScrUrl *scr_url_from_path_impl(ScrStr *path, bool win32) {
  ScrStr *resolved;
  if (win32) {
    bool is_unc = path->len >= 2 && path->data[0] == '\\' && path->data[1] == '\\';
    if (is_unc) {
      resolved = scr_str_retain(path);
    } else {
      ScrArr *pack = scr_arr_new(SCR_ELEM_STR, 1);
      scr_arr_push_ref(pack, scr_str_retain(path));
      resolved = scr_path_win32_resolve(pack);
      scr_arr_release(pack);
    }
    if (is_unc || (resolved->len >= 2 && resolved->data[0] == '\\' && resolved->data[1] == '\\')) {
      /* UNC path format: \\server\share\resource; an extended
       * \\?\UNC\ prefix is ignored. */
      bool extended = resolved->len >= 8 && memcmp(resolved->data, "\\\\?\\UNC\\", 8) == 0;
      size_t prefix = extended ? 8 : 2;
      long host_end = -1;
      for (size_t i = prefix; i < resolved->len; i++) {
        if (resolved->data[i] == '\\') {
          host_end = (long)i;
          break;
        }
      }
      if (host_end == -1) {
        scr_url_throw_arg_value("Missing UNC resource path", resolved);
        scr_str_release(resolved);
        return NULL;
      }
      if (host_end == 2) {
        scr_url_throw_arg_value("Empty UNC servername", resolved);
        scr_str_release(resolved);
        return NULL;
      }
      /* The URL host parser lowercases ASCII and TERMINATES at the URL
       * delimiters '/', '?', '#' (Node feeds the servername through
       * set_hostname: "\\\\?\\C:\\x" gets an EMPTY host and stays a
       * drive path). No IDNA (documented divergence — Node punycodes
       * non-ASCII names), and names with ':' or '%' stay verbatim where
       * Node aborts on a native set_hostname assertion. */
      UrlBuf host;
      ub_init(&host);
      for (size_t i = prefix; i < (size_t)host_end; i++) {
        char c = resolved->data[i];
        if (c == '/' || c == '?' || c == '#') break;
        if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
        ub_push(&host, c);
      }
      ScrStr *encoded = scr_url_encode_file_path(resolved->data + host_end,
                                                 resolved->len - (size_t)host_end, true);
      scr_str_release(resolved);
      return scr_url_new_file(ub_take(&host), encoded);
    }
  } else {
    ScrArr *pack = scr_arr_new(SCR_ELEM_STR, 1);
    scr_arr_push_ref(pack, scr_str_retain(path));
    resolved = scr_path_resolve(pack);
    scr_arr_release(pack);
  }
  /* path.resolve strips trailing slashes — Node adds an intentional one
   * back (the input ends with a separator the resolved path lost). On
   * win32 the input separator set is both slashes and the resolved path
   * keeps '\\' only at a root; posix knows '/' alone. */
  char last = path->len > 0 ? path->data[path->len - 1] : 0;
  bool wants_trailing = win32 ? (last == '/' || last == '\\') : last == '/';
  char resolved_last = resolved->len > 0 ? resolved->data[resolved->len - 1] : 0;
  bool has_trailing = win32 ? resolved_last == '\\' : resolved_last == '/';
  UrlBuf raw;
  ub_init(&raw);
  ub_append(&raw, resolved->data, resolved->len);
  if (wants_trailing && !has_trailing) ub_push(&raw, '/');
  ScrStr *encoded = scr_url_encode_file_path(raw.data, raw.len, win32);
  free(raw.data);
  scr_str_release(resolved);
  return scr_url_new_file(scr_str_new("", 0), encoded);
}

/* The target's arm, like scr_url_to_path's. Never throws on posix. */
ScrUrl *scr_url_from_path(ScrStr *path) {
#ifdef _WIN32
  return scr_url_from_path_impl(path, true);
#else
  return scr_url_from_path_impl(path, false);
#endif
}

/* The win32 arms as real entry points: the host-side differential tests
 * (test_url.c) exercise the Windows behavior from any platform, the same
 * way Node exposes { windows: true } options on the bridge pair. */
ScrStr *scr_url_to_path_w32(ScrUrl *u) { return scr_url_to_path_impl(u, true); }
ScrUrl *scr_url_from_path_w32(ScrStr *path) { return scr_url_from_path_impl(path, true); }

/* WHATWG search getter: "" for no query AND for the bare-'?' query;
 * "?..." verbatim otherwise. */
ScrStr *scr_url_search(ScrUrl *u) {
  if (u->query->len <= 1) return scr_str_new("", 0);
  return scr_str_retain(u->query);
}
