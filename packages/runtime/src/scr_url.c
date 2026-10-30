/* The WHATWG URL slice (scr_runtime.h has the API contract): a mutable,
 * refcounted URL value parsed once at construction, plus the file-URL
 * bridge pair (fileURLToPath / pathToFileURL).
 *
 * The parser covers the WHATWG algorithm's common ground exactly — pinned
 * against Node by the differential corpus:
 *   - scheme lowercasing; "Invalid URL" TypeError on schemeless input
 *   - special schemes (http/https/ws/wss/ftp/file): authority parsing with
 *     percent-decoded, lowercased hosts, default-port removal (leading zeros stripped),
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
 *   - non-special schemes: "//" parses an authority (an opaque host,
 *     case preserved, C0-encoded), a single "/" roots a normalized path,
 *     anything else is an OPAQUE path with the C0 control set encoded
 *     (data:text/plain,hi there)
 *   - UTS #46 processing of non-ASCII hosts through the IDNA unit
 *     (scr_url_idna_install)
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
  return enc_query(c, false) || c == '?' || c == '^' || c == '`' || c == '{' || c == '}';
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
  scr_throw_error_msg_code(SCR_ERR_TYPE, "Invalid URL", 11, "ERR_INVALID_URL");
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
static bool url_drive_letter(const char *raw, size_t len) {
  return len == 2 && ((raw[0] >= 'a' && raw[0] <= 'z') ||
                     (raw[0] >= 'A' && raw[0] <= 'Z')) &&
         (raw[1] == ':' || raw[1] == '|');
}

static ScrStr *parse_rooted_path_mode(const char *raw, size_t len, bool special, bool file) {
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
      if (seg_count > 0 && !(file && seg_count == 1 && url_drive_letter(out.data, out.len))) {
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
        const char c = file && seg_count == 1 && url_drive_letter(seg, seg_len) && j == 1 ? ':' : seg[j];
        ub_push_encoded(&out, (unsigned char)c, enc_path);
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

static ScrStr *parse_rooted_path(const char *raw, size_t len, bool special) {
  return parse_rooted_path_mode(raw, len, special, false);
}

/* The WHATWG IPv4 number parser: "0x"/"0X" makes the rest hexadecimal
 * and a leading "0" octal; an empty rest is 0. Values past 2^32 saturate
 * there, since every caller rejects them. */
static bool url_ipv4_number(const char *s, size_t n, uint64_t *out) {
  if (n == 0) return false;
  unsigned radix = 10;
  if (n >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
    radix = 16;
    s += 2;
    n -= 2;
  } else if (n >= 2 && s[0] == '0') {
    radix = 8;
    s += 1;
    n -= 1;
  }
  uint64_t v = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    unsigned d = c >= '0' && c <= '9' ? (unsigned)(c - '0')
                 : c >= 'a' && c <= 'f' ? (unsigned)(c - 'a' + 10)
                 : c >= 'A' && c <= 'F' ? (unsigned)(c - 'A' + 10)
                                        : 16;
    if (d >= radix) return false;
    v = v > 0xFFFFFFFFull ? v : v * radix + d;
  }
  *out = v;
  return true;
}

/* The WHATWG "ends in a number" checker: the last dot-separated label
 * (one trailing empty label dropped) is all digits or an IPv4 number. */
static bool url_ends_in_number(const char *s, size_t n) {
  if (n > 0 && s[n - 1] == '.') n--;
  size_t start = n;
  while (start > 0 && s[start - 1] != '.') start--;
  const char *last = s + start;
  size_t len = n - start;
  if (len == 0) return false;
  bool digits = true;
  for (size_t i = 0; i < len && digits; i++) digits = last[i] >= '0' && last[i] <= '9';
  uint64_t ignored;
  return digits || url_ipv4_number(last, len, &ignored);
}

/* The WHATWG IPv4 parser: up to four labels (one trailing empty label
 * dropped); every label but the last at most 255, and the last below
 * 256^(5 - labels). Writes the dotted-decimal serialization. */
static bool url_ipv4_parse(const char *s, size_t n, UrlBuf *out) {
  if (n > 0 && s[n - 1] == '.') n--;
  uint64_t parts[4];
  size_t count = 0, start = 0;
  for (size_t i = 0; i <= n; i++) {
    if (i < n && s[i] != '.') continue;
    if (count == 4 || !url_ipv4_number(s + start, i - start, &parts[count])) return false;
    count++;
    start = i + 1;
  }
  for (size_t i = 0; i + 1 < count; i++)
    if (parts[i] > 255) return false;
  uint64_t limit = 1ull << (8 * (5 - count));
  if (parts[count - 1] >= limit) return false;
  uint64_t v = parts[count - 1];
  for (size_t i = 0; i + 1 < count; i++) v += parts[i] << (8 * (3 - i));
  char text[16];
  int len = snprintf(text, sizeof text, "%u.%u.%u.%u", (unsigned)(v >> 24) & 255, (unsigned)(v >> 16) & 255,
                     (unsigned)(v >> 8) & 255, (unsigned)v & 255);
  ub_append(out, text, (size_t)len);
  return true;
}

/* Byte classes for the host parser: URL_FORBIDDEN_HOST marks the URL
 * Standard's forbidden host code points (opaque hosts), URL_FORBIDDEN_DOMAIN
 * its forbidden domain code points (those plus the C0 controls, '%' and
 * U+007F) and every non-ASCII byte, which a special host cannot hold
 * without UTS #46 processing. */
enum { URL_FORBIDDEN_HOST = 1, URL_FORBIDDEN_DOMAIN = 2 };

static const unsigned char url_host_byte_class[256] = {
    3, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 2, 2, 3, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    3, 0, 0, 3, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 3, 0, 3, 3,
    3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
};

static bool enc_c0_control(unsigned char c) {
  return c < 0x20 || c > 0x7E;
}

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* UTS #46 ToASCII (scr_idna.c), which programs that use URLs install at
 * startup (scr_url_idna_install). NULL refuses hosts that hold non-ASCII
 * text. */
ScrStr *(*scr_url_host_to_ascii)(const char *p, size_t n) = NULL;

/* The URL Standard's host parser for the constructor and the setters,
 * with canonical IPv6 serialization:
 * - a non-special (opaque) host refuses forbidden host code points and
 *   percent-encodes the C0 control set;
 * - a special host is percent-decoded and lowercased; when that leaves
 *   non-ASCII text it goes through UTS #46 ToASCII (as Node's host parser
 *   does, an ASCII host, "xn--" labels included, is only lowercased). The
 *   result is refused when it holds a forbidden domain code point, and
 *   serialized as dotted decimal when it ends in a number (or refused when
 *   that number is invalid). */
static bool parse_host(const char *hp, size_t host_len, bool special, bool is_file,
                       ScrStr **host) {
  bool ipv6 = host_len > 0 && hp[0] == '[';
  size_t ipv6_end = host_len ? host_len - 1 : 0;
  if (ipv6 && (host_len < 3 || hp[ipv6_end] != ']')) return false;
  UrlBuf hb;
  ub_init(&hb);
  if (ipv6) {
    if (!ub_append_ipv6(&hb, hp + 1, ipv6_end - 1)) {
      free(hb.data);
      return false;
    }
    *host = ub_take(&hb);
    return true;
  }
  if (!special) {
    for (size_t i = 0; i < host_len; i++) {
      unsigned char c = (unsigned char)hp[i];
      if (url_host_byte_class[c] & URL_FORBIDDEN_HOST) {
        free(hb.data);
        return false;
      }
      ub_push_encoded(&hb, c, enc_c0_control);
    }
    *host = ub_take(&hb);
    return true;
  }
  bool non_ascii = false;
  for (size_t i = 0; i < host_len; i++) {
    unsigned char c = (unsigned char)hp[i];
    int hi, lo;
    if (c == '%' && i + 2 < host_len && (hi = hex_val(hp[i + 1])) >= 0 &&
        (lo = hex_val(hp[i + 2])) >= 0) {
      c = (unsigned char)(hi * 16 + lo);
      i += 2;
    }
    if (c >= 0x80) non_ascii = true;
    if (c >= 'A' && c <= 'Z') c = (unsigned char)(c - 'A' + 'a');
    ub_push(&hb, (char)c);
  }
  if (non_ascii) {
    /* UTS #46 ToASCII, or refused without the IDNA unit. */
    ScrStr *ascii = scr_url_host_to_ascii ? scr_url_host_to_ascii(hb.data, hb.len) : NULL;
    free(hb.data);
    if (!ascii || ascii->len == 0) {
      scr_str_release(ascii);
      return false;
    }
    ub_init(&hb);
    ub_append(&hb, ascii->data, ascii->len);
    scr_str_release(ascii);
  }
  for (size_t i = 0; i < hb.len; i++) {
    if (url_host_byte_class[(unsigned char)hb.data[i]] & URL_FORBIDDEN_DOMAIN) {
      free(hb.data);
      return false;
    }
  }
  if (url_ends_in_number(hb.data, hb.len)) {
    UrlBuf ip;
    ub_init(&ip);
    bool ok = url_ipv4_parse(hb.data, hb.len, &ip);
    free(hb.data);
    if (!ok) {
      free(ip.data);
      return false;
    }
    hb = ip;
  }
  /* file: "localhost" normalizes to "" at parse time (Node). */
  if (is_file && hb.len == 9 && memcmp(hb.data, "localhost", 9) == 0) hb.len = 0;
  if (hb.len == 0 && !is_file) {
    free(hb.data);
    return false; /* http:// — special non-file needs a host */
  }
  *host = ub_take(&hb);
  return true;
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
  /* An empty password is omitted from the serialized credentials. When
   * both username and password are empty, the authority has no userinfo. */
  if ((*userinfo)->len > 0 && (*userinfo)->data[(*userinfo)->len - 1] == ':') {
    ScrStr *canonical = scr_str_new((*userinfo)->data, (*userinfo)->len - 1);
    scr_str_release(*userinfo);
    *userinfo = canonical;
  }
  const char *hp = at >= 0 ? raw + at + 1 : raw;
  size_t hp_len = at >= 0 ? len - (size_t)at - 1 : len;
  /* Credentials need a host. A file: authority is a host alone, so its
   * '@' and ':' reach the host parser, which refuses them. */
  if (at >= 0 && hp_len == 0) return false;
  if (is_file) {
    *port = scr_str_new("", 0);
    return at < 0 && parse_host(hp, hp_len, special, is_file, host);
  }
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
  if (colon >= 0 && host_len == 0) return false;
  if (!parse_host(hp, host_len, special, is_file, host)) return false;
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

/* URL inputs are USVStrings: a lone surrogate parses as U+FFFD. */
static ScrStr *url_usv(ScrStr *input) {
  return scr_str_has_surrogate(input) ? scr_str_to_well_formed(input) : NULL;
}

/* The full constructor-path parser. Returns NULL after throwing. */
ScrUrl *scr_url_new(ScrStr *input) {
  ScrStr *usv = url_usv(input);
  if (usv) {
    ScrUrl *u = scr_url_new(usv);
    scr_str_release(usv);
    return u;
  }
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
      size_t path_start = aend;
      if (is_file && url_drive_letter(body + astart, aend - astart)) {
        userinfo = scr_str_new("", 0);
        host = scr_str_new("", 0);
        port = scr_str_new("", 0);
        path_start = astart - 1;
      } else if (!parse_authority(body + astart, aend - astart, special, is_file, scheme, sl,
                           &userinfo, &host, &port)) {
        scr_str_release(userinfo);
        scr_str_release(host);
        scr_str_release(port);
        free(buf);
        scr_url_throw_invalid();
        return NULL;
      }
      has_authority = true;
      path = parse_rooted_path_mode(body + path_start, body_len - path_start, special, is_file);
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
        path = parse_rooted_path_mode(p, plen, special, true);
      } else {
        UrlBuf rb;
        ub_init(&rb);
        ub_push(&rb, '/');
        ub_append(&rb, p, plen);
        ScrStr *tmp = ub_take(&rb);
        path = parse_rooted_path_mode(tmp->data, tmp->len, special, true);
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
    /* Opaque path: the C0 control set is percent-encoded, and a space
     * right before a query or fragment becomes %20. */
    userinfo = scr_str_new("", 0);
    host = scr_str_new("", 0);
    port = scr_str_new("", 0);
    UrlBuf ob;
    ub_init(&ob);
    bool trailing_space = qmark < rest_len && body_len > 0 && body[body_len - 1] == ' ';
    size_t kept = trailing_space ? body_len - 1 : body_len;
    for (size_t i = 0; i < kept; i++) ub_push_encoded(&ob, (unsigned char)body[i], enc_c0_control);
    if (trailing_space) ub_append(&ob, "%20", 3);
    path = ub_take(&ob);
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
  u->sp_reload = NULL;
  return u;
}

/* Resolve a relative reference using the parsed base's component boundaries.
 * Reuse the absolute parser for encoding, dot segments, authority validation,
 * and canonicalization. The base is parsed even for an absolute input: an
 * invalid supplied base is a constructor error in Node. */
ScrUrl *scr_url_new_base(ScrStr *input, ScrStr *base_input) {
  ScrStr *usv = url_usv(input);
  if (usv) {
    ScrUrl *u = scr_url_new_base(usv, base_input);
    scr_str_release(usv);
    return u;
  }
  ScrUrl *base = scr_url_new(base_input);
  if (!base) return NULL;
  size_t begin = 0, end = input->len;
  while (begin < end && (unsigned char)input->data[begin] <= 0x20) begin++;
  while (end > begin && (unsigned char)input->data[end - 1] <= 0x20) end--;
  UrlBuf cleaned;
  ub_init(&cleaned);
  for (size_t i = begin; i < end; i++) {
    char c = input->data[i];
    if (c != '\t' && c != '\n' && c != '\r') ub_push(&cleaned, c);
  }
  const char *raw = cleaned.data;
  size_t len = cleaned.len;
  size_t scheme_len = 0;
  if (len && ((raw[0] >= 'a' && raw[0] <= 'z') || (raw[0] >= 'A' && raw[0] <= 'Z'))) {
    size_t i = 1;
    while (i < len && ((raw[i] >= 'a' && raw[i] <= 'z') ||
           (raw[i] >= 'A' && raw[i] <= 'Z') || (raw[i] >= '0' && raw[i] <= '9') ||
           raw[i] == '+' || raw[i] == '-' || raw[i] == '.')) i++;
    if (i < len && raw[i] == ':') scheme_len = i;
  }
  bool special = is_special_scheme(base->scheme->data, base->scheme->len);
  bool file = base->scheme->len == 4 && memcmp(base->scheme->data, "file", 4) == 0;
  bool same_scheme = scheme_len == base->scheme->len;
  for (size_t i = 0; same_scheme && i < scheme_len; i++) {
    char c = raw[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != base->scheme->data[i]) same_scheme = false;
  }
  ScrUrl *result = NULL;
  if (scheme_len && (!same_scheme || !special)) {
    result = scr_url_new(input);
    goto done;
  }
  if (scheme_len) {
    raw += scheme_len + 1;
    len -= scheme_len + 1;
  }
  bool slash = len && (raw[0] == '/' || (special && raw[0] == '\\'));
  bool authority = slash && len > 1 && (raw[1] == '/' || (special && raw[1] == '\\'));
  bool opaque = !base->has_authority && (!base->path->len || base->path->data[0] != '/');
  if (opaque && (!len || raw[0] != '#')) {
    scr_url_throw_invalid();
    goto done;
  }
  UrlBuf absolute;
  ub_init(&absolute);
  ub_append(&absolute, base->scheme->data, base->scheme->len);
  ub_push(&absolute, ':');
  if (authority) {
    ub_append(&absolute, raw, len);
  } else {
    size_t path_len = 0;
    while (path_len < len && raw[path_len] != '?' && raw[path_len] != '#') path_len++;
    bool drive = file && path_len >= 2 && url_drive_letter(raw, 2) &&
                 (path_len == 2 || raw[2] == '/' || raw[2] == '\\');
    if (base->has_authority) {
      /* A drive letter relative to a file: base keeps the base's host. */
      ub_append(&absolute, "//", 2);
      if (base->userinfo->len) {
        ub_append(&absolute, base->userinfo->data, base->userinfo->len);
        ub_push(&absolute, '@');
      }
      ub_append(&absolute, base->host->data, base->host->len);
      if (base->port->len) {
        ub_push(&absolute, ':');
        ub_append(&absolute, base->port->data, base->port->len);
      }
    } else if (!opaque) {
      /* A host-less base path can start with "//"; the "/." prefix keeps
       * the resolved path from reparsing as an authority (dot-segment
       * removal drops it). */
      ub_append(&absolute, "/.", 2);
    }
    if (!path_len) {
      ub_append(&absolute, base->path->data, base->path->len);
      if (!len || raw[0] == '#') ub_append(&absolute, base->query->data, base->query->len);
    } else if (drive) {
      ub_push(&absolute, '/');
    } else if (slash) {
      // A rooted file reference retains its base drive unless it supplies
      // a replacement drive. Dot segments must never pop that drive root.
      bool replacement_drive = path_len >= 3 && url_drive_letter(raw + 1, 2) &&
                               (path_len == 3 || raw[3] == '/' || raw[3] == '\\');
      if (file && !replacement_drive && base->path->len >= 3 &&
          url_drive_letter(base->path->data + 1, 2)) {
        ub_append(&absolute, base->path->data, 3);
      }
    } else {
      size_t directory = base->path->len;
      while (directory && base->path->data[directory - 1] != '/') directory--;
      if (directory) ub_append(&absolute, base->path->data, directory);
      else ub_push(&absolute, '/');
    }
    ub_append(&absolute, raw, len);
  }
  ScrStr *resolved = ub_take(&absolute);
  result = scr_url_new(resolved);
  scr_str_release(resolved);
done:
  free(cleaned.data);
  scr_url_release(base);
  return result;
}

ScrStr *scr_url_protocol(ScrUrl *u) {
  UrlBuf b;
  ub_init(&b);
  ub_append(&b, u->scheme->data, u->scheme->len);
  ub_push(&b, ':');
  return ub_take(&b);
}

/* Input conversion is the caller's responsibility. Only parser errors are
 * suppressed: user toString errors must still escape the public factories. */
static ScrUrl *url_try_parse(ScrStr *input, ScrStr *base) {
  ScrUrl *u = base ? scr_url_new_base(input, base) : scr_url_new(input);
  if (!u) scr_exc_clear();
  return u;
}

bool scr_url_can_parse_base(ScrStr *input, ScrStr *base) {
  ScrUrl *u = url_try_parse(input, base);
  bool valid = u != NULL;
  scr_url_release(u);
  return valid;
}

bool scr_url_can_parse(ScrStr *input) { return scr_url_can_parse_base(input, NULL); }

ScrDyn *scr_url_parse_base(ScrStr *input, ScrStr *base) {
  ScrUrl *u = url_try_parse(input, base);
  if (!u) return scr_dyn_new_null();
  ScrDyn *value = scr_dyn_native_url(u);
  scr_url_release(u);
  return value;
}

ScrDyn *scr_url_parse(ScrStr *input) { return scr_url_parse_base(input, NULL); }

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
  if (u->port->len) {
    ub_push(&b, ':');
    ub_append(&b, u->port->data, u->port->len);
  }
  return ub_take(&b);
}

/* WHATWG hostname getter: the stored port-less host verbatim ("" for
 * authority-less URLs); IPv6 literals retain their brackets. */
ScrStr *scr_url_hostname(ScrUrl *u) { return scr_str_retain(u->host); }

ScrStr *scr_url_port(ScrUrl *u) { return scr_str_retain(u->port); }

/* WHATWG origin is opaque for file and non-special schemes. A blob URL
 * inherits the origin of an embedded http(s) URL when its path parses. */
ScrStr *scr_url_origin(ScrUrl *u) {
  const char *scheme = u->scheme->data;
  size_t len = u->scheme->len;
  if (len == 4 && memcmp(scheme, "blob", 4) == 0) {
    ScrUrl *inner = scr_url_new(u->path);
    if (!inner) {
      scr_exc_clear();
      return scr_str_new("null", 4);
    }
    bool http = (inner->scheme->len == 4 && memcmp(inner->scheme->data, "http", 4) == 0) ||
                (inner->scheme->len == 5 && memcmp(inner->scheme->data, "https", 5) == 0);
    ScrStr *result = http ? scr_url_origin(inner) : scr_str_new("null", 4);
    scr_url_release(inner);
    return result;
  }
  if (!((len == 4 && memcmp(scheme, "http", 4) == 0) ||
        (len == 5 && memcmp(scheme, "https", 5) == 0) ||
        (len == 2 && memcmp(scheme, "ws", 2) == 0) ||
        (len == 3 && memcmp(scheme, "wss", 3) == 0) ||
        (len == 3 && memcmp(scheme, "ftp", 3) == 0))) {
    return scr_str_new("null", 4);
  }
  UrlBuf b;
  ub_init(&b);
  ub_append(&b, scheme, len);
  ub_append(&b, "://", 3);
  ub_append(&b, u->host->data, u->host->len);
  if (u->port->len > 0) {
    ub_push(&b, ':');
    ub_append(&b, u->port->data, u->port->len);
  }
  return ub_take(&b);
}

ScrStr *scr_url_username(ScrUrl *u) {
  const char *separator = memchr(u->userinfo->data, ':', u->userinfo->len);
  size_t len = separator ? (size_t)(separator - u->userinfo->data) : u->userinfo->len;
  return scr_str_new(u->userinfo->data, len);
}

ScrStr *scr_url_password(ScrUrl *u) {
  const char *separator = memchr(u->userinfo->data, ':', u->userinfo->len);
  if (!separator) return scr_str_new("", 0);
  const char *start = separator + 1;
  return scr_str_new(start, u->userinfo->len - (size_t)(start - u->userinfo->data));
}

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
  /* A host-less hierarchical path starting with // must not serialize
   * as an authority (the URL Standard's /. escape). */
  if (!u->has_authority && u->path->len >= 2 && !memcmp(u->path->data, "//", 2)) ub_append(&b, "/.", 2);
  ub_append(&b, u->path->data, u->path->len);
  ub_append(&b, u->query->data, u->query->len);
  ub_append(&b, u->fragment->data, u->fragment->len);
  return ub_take(&b);
}

static bool url_opaque(ScrUrl *u) {
  return !u->has_authority && (u->path->len == 0 || u->path->data[0] != '/');
}

static void url_strip_opaque_spaces(ScrUrl *u) {
  if (!url_opaque(u) || u->query->len || u->fragment->len) return;
  size_t end = u->path->len;
  while (end && u->path->data[end - 1] == ' ') end--;
  if (end != u->path->len) {
    ScrStr *path = scr_str_new(u->path->data, end);
    scr_str_release(u->path);
    u->path = path;
  }
}

/* Setter state overrides preserve the other components. Unlike the full
 * parser they strip TAB/LF/CR without trimming surrounding spaces. */
static void url_copy_fields(ScrUrl *u, ScrUrl *next) {
  scr_str_release(u->scheme); u->scheme = scr_str_retain(next->scheme);
  scr_str_release(u->userinfo); u->userinfo = scr_str_retain(next->userinfo);
  scr_str_release(u->host); u->host = scr_str_retain(next->host);
  scr_str_release(u->port); u->port = scr_str_retain(next->port);
  scr_str_release(u->path); u->path = scr_str_retain(next->path);
  scr_str_release(u->query); u->query = scr_str_retain(next->query);
  scr_str_release(u->fragment); u->fragment = scr_str_retain(next->fragment);
  u->has_authority = next->has_authority;
}

static bool url_file(ScrUrl *u) {
  return u->scheme->len == 4 && !memcmp(u->scheme->data, "file", 4);
}

static bool url_cannot_have_credentials_or_port(ScrUrl *u) {
  return !u->host->len || url_file(u) || url_opaque(u);
}

static bool url_set_port(ScrUrl *u, const char *raw, size_t len, bool empty_input) {
  if (url_cannot_have_credentials_or_port(u)) return false;
  if (empty_input) {
    scr_str_release(u->port);
    u->port = scr_str_new("", 0);
    return true;
  }
  if (!len) return true; /* TAB/LF/CR-only input leaves the port unchanged. */
  if (raw[0] < '0' || raw[0] > '9') return false;
  unsigned int number = 0;
  for (size_t i = 0; i < len && raw[i] >= '0' && raw[i] <= '9'; i++) {
    number = number * 10 + (unsigned int)(raw[i] - '0');
    if (number > 65535) return false;
  }
  char digits[6];
  size_t size = (size_t)snprintf(digits, sizeof digits, "%u", number);
  const char *dflt = default_port(u->scheme->data, u->scheme->len);
  scr_str_release(u->port);
  u->port = scr_str_new(digits, dflt && strlen(dflt) == size && !memcmp(dflt, digits, size) ? 0 : size);
  return true;
}

static bool url_set_protocol(ScrUrl *u, const char *raw, size_t len) {
  if (!len) return true;
  if (!((raw[0] >= 'a' && raw[0] <= 'z') || (raw[0] >= 'A' && raw[0] <= 'Z'))) return false;
  size_t end = 1;
  while (end < len && ((raw[end] >= 'a' && raw[end] <= 'z') ||
         (raw[end] >= 'A' && raw[end] <= 'Z') || (raw[end] >= '0' && raw[end] <= '9') ||
         raw[end] == '+' || raw[end] == '-' || raw[end] == '.')) end++;
  if (end < len && raw[end] != ':') return false;
  UrlBuf normalized;
  ub_init(&normalized);
  for (size_t i = 0; i < end; i++) {
    char c = raw[i];
    ub_push(&normalized, c >= 'A' && c <= 'Z' ? (char)(c + 'a' - 'A') : c);
  }
  ScrStr *scheme = ub_take(&normalized);
  bool special = is_special_scheme(scheme->data, scheme->len);
  bool file = scheme->len == 4 && !memcmp(scheme->data, "file", 4);
  if (is_special_scheme(u->scheme->data, u->scheme->len) != special ||
      (file && (u->userinfo->len || u->port->len)) || (url_file(u) && !u->host->len)) {
    scr_str_release(scheme);
    /* Ada reports these state-override rejections as failed writes, so the
     * live URL keeps its pre-conversion snapshot in Node. */
    return false;
  }
  scr_str_release(u->scheme);
  u->scheme = scheme;
  const char *dflt = default_port(scheme->data, scheme->len);
  if (dflt && u->port->len == strlen(dflt) && !memcmp(u->port->data, dflt, u->port->len)) {
    scr_str_release(u->port);
    u->port = scr_str_new("", 0);
  }
  return true;
}

static bool url_set_credentials(ScrUrl *u, ScrStr *value, bool username) {
  if (url_cannot_have_credentials_or_port(u)) return false;
  ScrStr *other = username ? scr_url_password(u) : scr_url_username(u);
  UrlBuf encoded;
  ub_init(&encoded);
  for (size_t i = 0; i < value->len; i++) ub_push_encoded(&encoded, (unsigned char)value->data[i], enc_userinfo);
  ScrStr *part = ub_take(&encoded);
  ScrStr *user = username ? part : other;
  ScrStr *pass = username ? other : part;
  UrlBuf combined;
  ub_init(&combined);
  ub_append(&combined, user->data, user->len);
  if (pass->len) {
    ub_push(&combined, ':');
    ub_append(&combined, pass->data, pass->len);
  }
  scr_str_release(u->userinfo);
  u->userinfo = ub_take(&combined);
  scr_str_release(other);
  scr_str_release(part);
  return true;
}

static bool url_set_host(ScrUrl *u, const char *raw, size_t len, bool hostname) {
  if (url_opaque(u)) return false;
  bool file = url_file(u);
  bool special = is_special_scheme(u->scheme->data, u->scheme->len);
  size_t end = 0;
  bool bracket = false, colon = false;
  for (; end < len; end++) {
    char c = raw[end];
    if (c == '/' || c == '?' || c == '#' || (special && c == '\\')) break;
    if (!file && c == ':' && !bracket) { colon = true; break; }
    if (c == '[') bracket = true;
    if (c == ']') bracket = false;
  }
  if (colon && (hostname || !end)) return false;
  if (!end && !file && (special || u->userinfo->len || u->port->len)) return false;
  ScrStr *host = NULL;
  if (!parse_host(raw, end, special, file, &host)) return false;
  bool escaped_path = !u->has_authority && u->path->len >= 2 && !memcmp(u->path->data, "//", 2);
  scr_str_release(u->host);
  u->host = host;
  if (host->len || escaped_path) u->has_authority = true;
  if (colon && end + 1 < len) url_set_port(u, raw + end + 1, len - end - 1, false);
  return true;
}

/* The result distinguishes successful state overrides from ignored writes:
 * only successful writes replace Node's pre-conversion URL snapshot. */
static bool url_apply_component(ScrUrl *u, ScrStr *field, ScrStr *value) {
  if (field->len == 4 && !memcmp(field->data, "href", 4)) {
    ScrUrl *next = scr_url_new(value);
    if (!next) return false;
    url_copy_fields(u, next);
    scr_url_release(next);
    if (u->sp_cache) u->sp_reload(u->sp_cache, u->query);
    return true;
  }
  bool pathname = field->len == 8 && !memcmp(field->data, "pathname", 8);
  bool search = field->len == 6 && !memcmp(field->data, "search", 6);
  bool hash = field->len == 4 && !memcmp(field->data, "hash", 4);
  bool protocol = field->len == 8 && !memcmp(field->data, "protocol", 8);
  bool username = field->len == 8 && !memcmp(field->data, "username", 8);
  bool password = field->len == 8 && !memcmp(field->data, "password", 8);
  bool host = field->len == 4 && !memcmp(field->data, "host", 4);
  bool hostname = field->len == 8 && !memcmp(field->data, "hostname", 8);
  bool port = field->len == 4 && !memcmp(field->data, "port", 4);
  if (!pathname && !search && !hash && !protocol && !username && !password && !host && !hostname && !port) {
    static const char message[] = "Native URL setter has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return false;
  }
  if (username || password) return url_set_credentials(u, value, username);
  if (pathname && url_opaque(u)) return false;
  UrlBuf raw;
  ub_init(&raw);
  size_t start = (search || hash) && value->len && value->data[0] == (search ? '?' : '#') ? 1 : 0;
  for (size_t i = start; i < value->len; i++) {
    char c = value->data[i];
    if ((host || hostname) && c == '#') break;
    if (c != '\t' && c != '\n' && c != '\r') ub_push(&raw, c);
  }
  bool special = is_special_scheme(u->scheme->data, u->scheme->len);
  bool applied = true;
  if (protocol) applied = url_set_protocol(u, raw.data, raw.len);
  else if (port) applied = url_set_port(u, raw.data, raw.len, !value->len);
  else if (host || hostname) applied = url_set_host(u, raw.data, raw.len, hostname);
  else if (pathname) {
    bool file = u->scheme->len == 4 && !memcmp(u->scheme->data, "file", 4);
    ScrStr *path = parse_rooted_path_mode(raw.data, raw.len, special, file);
    if (!path->len && (special || !u->has_authority)) {
      scr_str_release(path);
      path = scr_str_new("/", 1);
    }
    scr_str_release(u->path);
    u->path = path;
  } else {
    UrlBuf encoded;
    ub_init(&encoded);
    if (value->len) {
      char prefix = search ? '?' : '#';
      ub_push(&encoded, prefix);
      for (size_t i = 0; i < raw.len; i++) {
        unsigned char c = (unsigned char)raw.data[i];
        bool needs = search ? enc_query(c, special) : enc_fragment(c);
        if (needs) {
          char hex[4];
          snprintf(hex, sizeof hex, "%%%02X", c);
          ub_append(&encoded, hex, 3);
        } else ub_push(&encoded, (char)c);
      }
    }
    ScrStr **slot = search ? &u->query : &u->fragment;
    scr_str_release(*slot);
    *slot = ub_take(&encoded);
    url_strip_opaque_spaces(u);
    if (search && u->sp_cache) u->sp_reload(u->sp_cache, u->query);
  }
  free(raw.data);
  return applied;
}

bool scr_url_set_component(ScrUrl *u, ScrStr *field, ScrStr *value) {
  ScrStr *usv = url_usv(value);
  if (usv) {
    bool applied = scr_url_set_component(u, field, usv);
    scr_str_release(usv);
    return applied;
  }
  if (field->len == 4 && !memcmp(field->data, "href", 4)) return url_apply_component(u, field, value);
  /* Node's binding reparses the captured href before applying an override.
   * This matters after protocol writes to file://localhost, which the
   * reparse turns into an empty host. Ignored overrides retain the live URL. */
  ScrStr *href = scr_url_href(u);
  ScrUrl *next = scr_url_new(href);
  scr_str_release(href);
  if (!next) return false;
  bool applied = url_apply_component(next, field, value);
  if (applied) {
    url_copy_fields(u, next);
    if (field->len == 6 && !memcmp(field->data, "search", 6) && u->sp_cache) u->sp_reload(u->sp_cache, u->query);
  }
  scr_url_release(next);
  return applied;
}

void scr_url_set(ScrUrl *u, ScrStr *field, ScrStr *value) {
  scr_url_set_component(u, field, value);
}

/* Node snapshots a component setter's URL before invoking user string
 * conversion. href converts first, and opaque pathname writes are ignored. */
void scr_url_set_checked(ScrUrl *u, ScrStr *field, const ScrDyn *value) {
  bool href = field->len == 4 && !memcmp(field->data, "href", 4);
  bool ignored = field->len == 8 && !memcmp(field->data, "pathname", 8) && url_opaque(u);
  ScrUrl *saved = NULL;
  if (!href && !ignored) {
    saved = malloc(sizeof *saved);
    if (!saved) abort();
    *saved = *u;
    saved->rc = 1;
    saved->sp_cache = NULL;
    saved->sp_reload = NULL;
    saved->scheme = scr_str_retain(u->scheme);
    saved->userinfo = scr_str_retain(u->userinfo);
    saved->host = scr_str_retain(u->host);
    saved->port = scr_str_retain(u->port);
    saved->path = scr_str_retain(u->path);
    saved->query = scr_str_retain(u->query);
    saved->fragment = scr_str_retain(u->fragment);
  }
  ScrStr *text = scr_dyn_string_coerce_js(value);
  if (text && !ignored) {
    bool applied = scr_url_set_component(saved ? saved : u, field, text);
    if (saved && applied && !scr_exc_pending()) {
      url_copy_fields(u, saved);
      if (field->len == 6 && !memcmp(field->data, "search", 6) && u->sp_cache) u->sp_reload(u->sp_cache, u->query);
    }
  }
  scr_str_release(text);
  scr_url_release(saved);
}

/* ── the file-URL bridge ─────────────────────────────────────────────── */

static bool url_file_scheme(ScrUrl *u) {
  if (u->scheme->len == 4 && memcmp(u->scheme->data, "file", 4) == 0) return true;
  scr_throw_error_msg_code(SCR_ERR_TYPE, "The URL must be of scheme file", 30, "ERR_INVALID_URL_SCHEME");
  return false;
}

static bool url_file_posix_host(ScrUrl *u) {
  if (u->host->len == 0) return true;
  const char *platform =
#if defined(__APPLE__)
      "darwin";
#elif defined(__linux__)
      "linux";
#elif defined(_WIN32)
      "win32";
#else
      "posix";
#endif
  char message[96];
  int length = snprintf(message, sizeof message, "File URL host must be \"localhost\" or empty on %s", platform);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)length, "ERR_INVALID_FILE_URL_HOST");
  return false;
}

/* fileURLToPath over a parsed URL: Node's checks, Node's messages. The
 * posix arm rejects hosts and keeps forward slashes; the win32 arm maps
 * hosts to UNC \\host prefixes, flips separators, and demands a drive
 * letter otherwise. The public wrappers below select by TARGET. */
static ScrStr *scr_url_to_path_impl(ScrUrl *u, bool win32) {
  if (!url_file_scheme(u)) return NULL;
  const char *p = u->path->data;
  size_t len = u->path->len;
  if (win32) {
    /* Node scans the ENCODED pathname for %2f/%2F (/) and %5c/%5C (\). */
    for (size_t n = 0; n + 1 < len; n++) {
      if (p[n] != '%') continue;
      char c1 = p[n + 1];
      int third = (n + 2 < len ? (unsigned char)p[n + 2] : 0) | 0x20;
      if ((c1 == '2' && third == 'f') || (c1 == '5' && third == 'c')) {
        scr_throw_error_msg_code(SCR_ERR_TYPE,
                             "File URL path must not include encoded \\ or / characters", 56, "ERR_INVALID_FILE_URL_PATH");
        return NULL;
      }
    }
    /* Encoded separators have already been refused, so decoding first and
     * replacing the remaining literal slashes has Node's ordering. Use the
     * strict decoder: malformed escapes and invalid UTF-8 throw URIError. */
    ScrStr *decoded = scr_str_decode_uri_component(u->path);
    if (!decoded) return NULL;
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
    for (size_t i = 0; i < decoded->len; i++)
      ub_push(&out, decoded->data[i] == '/' ? '\\' : decoded->data[i]);
    scr_str_release(decoded);
    if (u->host->len > 0) return ub_take(&out);
    /* A local path requires a drive letter: pathname[1] in [a-zA-Z] and
     * pathname[2] === ':' (both on the DECODED, backslashed pathname). */
    size_t plen = out.len - path_start;
    const char *pp = out.data + path_start;
    int letter = (plen > 1 ? (unsigned char)pp[1] : 0) | 0x20;
    char drive_sep = plen > 2 ? pp[2] : 0;
    if (letter < 'a' || letter > 'z' || drive_sep != ':') {
      free(out.data);
      scr_throw_error_msg_code(SCR_ERR_TYPE, "File URL path must be absolute", 30, "ERR_INVALID_FILE_URL_PATH");
      return NULL;
    }
    /* pathname.slice(1): the leading backslash drops. */
    ScrStr *s = scr_str_new(pp + 1, plen - 1);
    free(out.data);
    return s;
  }
  if (!url_file_posix_host(u)) return NULL;
  for (size_t i = 0; i < len; i++) {
    if (p[i] == '%' && i + 2 < len) {
      int hi = hex_val(p[i + 1]);
      int lo = hex_val(p[i + 2]);
      if (hi >= 0 && lo >= 0) {
        unsigned char decoded = (unsigned char)((hi << 4) | lo);
        if (decoded == '/') {
          scr_throw_error_msg_code(SCR_ERR_TYPE,
                               "File URL path must not include encoded / characters", 51, "ERR_INVALID_FILE_URL_PATH");
          return NULL;
        }
        i += 2;
      }
    }
  }
  return scr_str_decode_uri_component(u->path);
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

/* fs.existsSync and the fs.promises functions convert a URL path inside a
 * try and turn its error into false or a rejection: the conversion's result
 * as a value, the path string or the error. */
ScrDyn *scr_url_to_path_value(ScrUrl *u) {
  ScrStr *path = scr_url_to_path(u);
  if (path) {
    ScrDyn *value = scr_dyn_new_str(path);
    scr_str_release(path);
    return value;
  }
  ScrCaught *caught = scr_exc_take();
  ScrDyn *error = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  return error;
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
  u->sp_reload = NULL;
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
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg.data, msg.len, "ERR_INVALID_ARG_VALUE");
  free(msg.data);
}

/* Percent-encodes a raw filesystem path the way Node's
 * bindingUrl.pathToFileURL does, reusing the parser's rooted-path
 * machinery (WHATWG dot-segment removal with empty segments preserved,
 * backslash-as-slash when `backslash_sep`, the enc_path set): the bytes
 * Node encodes BEYOND that set ('%', '[', ']', '^', '|', '~' — and '\\' when
 * it is a path byte rather than a separator) pre-encode here so the
 * parser passes them through. */
static ScrStr *scr_url_encode_file_path(const char *raw, size_t len, bool backslash_sep) {
  UrlBuf pre;
  ub_init(&pre);
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)raw[i];
    if (c == '%' || c == '[' || c == ']' || c == '^' || c == '|' || c == '~' ||
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
  ScrStr *usv = url_usv(path);
  if (usv) {
    ScrUrl *u = scr_url_from_path_impl(usv, win32);
    scr_str_release(usv);
    return u;
  }
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
      /* The servername goes through the host parser, as Node's hostname
       * setter does: it drops tabs and newlines, stops at the URL
       * delimiters '/', '?' and '#'
       * ("\\\\?\\C:\\x" gets an empty host and stays a drive path),
       * and a host it refuses throws ERR_INVALID_URL. */
      UrlBuf name;
      ub_init(&name);
      for (size_t i = prefix; i < (size_t)host_end; i++) {
        char c = resolved->data[i];
        if (c == '/' || c == '?' || c == '#') break;
        if (c != '\t' && c != '\n' && c != '\r') ub_push(&name, c);
      }
      ScrStr *host = NULL;
      bool valid = parse_host(name.data, name.len, true, true, &host);
      free(name.data);
      if (!valid) {
        scr_str_release(resolved);
        scr_url_throw_invalid();
        return NULL;
      }
      ScrStr *encoded = scr_url_encode_file_path(resolved->data + host_end,
                                                 resolved->len - (size_t)host_end, true);
      scr_str_release(resolved);
      return scr_url_new_file(host, encoded);
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

ScrUrl *scr_url_from_path_platform(ScrStr *path, bool windows) {
  return scr_url_from_path_impl(path, windows);
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

/* A bare '#' remains in href but its hash getter is empty, like Node. */
ScrStr *scr_url_hash(ScrUrl *u) {
  if (u->fragment->len <= 1) return scr_str_new("", 0);
  return scr_str_retain(u->fragment);
}

/* Checked native URL values preserve their handle across unknown storage. */
static ScrDyn *scr_native_url_get(void *ptr, const char *key, size_t len) {
  if (len == 12 && !memcmp(key, "searchParams", len)) {
    ScrSearchParams *params = scr_url_search_params(ptr);
    ScrDyn *result = scr_dyn_native_search_params(params);
    scr_sp_release(params);
    return result;
  }
  ScrStr *text = NULL;
#define URL_GET(name) if (len == sizeof(#name) - 1 && memcmp(key, #name, len) == 0) text = scr_url_##name(ptr)
  URL_GET(href);
  else URL_GET(protocol);
  else URL_GET(origin);
  else URL_GET(username);
  else URL_GET(password);
  else URL_GET(host);
  else URL_GET(hostname);
  else URL_GET(port);
  else URL_GET(pathname);
  else URL_GET(search);
  else URL_GET(hash);
#undef URL_GET
  if (!text) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *result = scr_dyn_new_str(text);
  scr_str_release(text);
  return result;
}

static ScrDyn *scr_native_url_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self; (void)args; (void)argc; (void)what;
  if (!strcmp(method, "toString") || !strcmp(method, "toJSON")) {
    ScrStr *text = scr_url_href(ptr);
    ScrDyn *result = scr_dyn_new_str(text);
    scr_str_release(text);
    return result;
  }
  static const char message[] = "Native URL method has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static bool scr_native_url_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  bool modeled = (len == 4 && (!memcmp(key, "href", 4) || !memcmp(key, "hash", 4) || !memcmp(key, "host", 4) || !memcmp(key, "port", 4))) ||
    (len == 8 && (!memcmp(key, "pathname", 8) || !memcmp(key, "protocol", 8) || !memcmp(key, "username", 8) || !memcmp(key, "password", 8) || !memcmp(key, "hostname", 8))) ||
    (len == 6 && !memcmp(key, "search", 6));
  if (!modeled) return false;
  ScrStr *field = scr_str_new(key, len);
  scr_url_set_checked(ptr, field, value);
  scr_str_release(field);
  return true;
}

/* util.inspect's view of a URL: the properties Node's URL inspector lists,
 * in its order, with the live searchParams object. Past the depth limit
 * the inspector returns the URL itself, which util.inspect prints as
 * `URL {}` (it has no own properties). */
static ScrDyn *scr_native_url_inspect_view(void *ptr) {
  static const char *const keys[] = {"href", "origin", "protocol", "username", "password",
                                     "host", "hostname", "port", "pathname", "search",
                                     "searchParams", "hash"};
  ScrDyn *view = scr_dyn_new_obj();
  for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++) {
    size_t len = strlen(keys[i]);
    scr_dyn_obj_set(view, keys[i], len, scr_native_url_get(ptr, keys[i], len));
  }
  return view;
}

/* Node's urlToHttpOptions over a URL: protocol, hostname (an IPv6 literal
 * without its brackets), hash, search, pathname, path (pathname and
 * search), href, then port as a number when the URL has one and auth
 * (the decoded username and password) when it has credentials. */
ScrDyn *scr_url_to_http_options(ScrUrl *u) {
  ScrDyn *options = scr_dyn_new_obj_null_proto();
  ScrStr *pathname = scr_url_pathname(u);
  ScrStr *search = scr_url_search(u);
  ScrStr *hostname = scr_url_hostname(u);
  ScrStr *port = scr_url_port(u);
  ScrStr *username = scr_url_username(u);
  ScrStr *password = scr_url_password(u);
  ScrStr *auth = NULL;
  if (username->len || password->len) {
    ScrStr *user = scr_str_decode_uri_component(username);
    ScrStr *pass = user ? scr_str_decode_uri_component(password) : NULL;
    if (pass) {
      UrlBuf b;
      ub_init(&b);
      ub_append(&b, user->data, user->len);
      ub_push(&b, ':');
      ub_append(&b, pass->data, pass->len);
      auth = ub_take(&b);
    }
    scr_str_release(user);
    scr_str_release(pass);
    if (!auth) {
      scr_str_release(pathname);
      scr_str_release(search);
      scr_str_release(hostname);
      scr_str_release(port);
      scr_str_release(username);
      scr_str_release(password);
      scr_dyn_release(options);
      return NULL;
    }
  }
#define PUT_STR(key, value)                                       \
  do {                                                            \
    ScrStr *text_ = (value);                                      \
    scr_dyn_obj_set(options, key, sizeof key - 1, scr_dyn_new_str(text_)); \
    scr_str_release(text_);                                       \
  } while (0)
  PUT_STR("protocol", scr_url_protocol(u));
  if (hostname->len >= 2 && hostname->data[0] == '[')
    PUT_STR("hostname", scr_str_new(hostname->data + 1, hostname->len - 2));
  else
    PUT_STR("hostname", scr_str_retain(hostname));
  PUT_STR("hash", scr_url_hash(u));
  PUT_STR("search", scr_str_retain(search));
  PUT_STR("pathname", scr_str_retain(pathname));
  UrlBuf path;
  ub_init(&path);
  ub_append(&path, pathname->data, pathname->len);
  ub_append(&path, search->data, search->len);
  PUT_STR("path", ub_take(&path));
  PUT_STR("href", scr_url_href(u));
  if (port->len) {
    double number = 0;
    for (size_t i = 0; i < port->len; i++) number = number * 10 + (port->data[i] - '0');
    scr_dyn_obj_set(options, "port", 4, scr_dyn_new_num(number));
  }
  if (auth) PUT_STR("auth", auth);
#undef PUT_STR
  scr_str_release(pathname);
  scr_str_release(search);
  scr_str_release(hostname);
  scr_str_release(port);
  scr_str_release(username);
  scr_str_release(password);
  return options;
}

ScrDyn *scr_url_to_http_options_dyn(const ScrDyn *value) {
  if (scr_dyn_native_url_is(value)) return scr_url_to_http_options(value->v.handle.ptr);
  if (!value || value->kind <= SCR_DYN_STR || value->kind == SCR_DYN_UNDEF ||
      value->kind == SCR_DYN_BIGINT || value->kind == SCR_DYN_SYMBOL) {
    scr_dyn_arg_type_fail("url", "of type object", value);
    return NULL;
  }
  static const char message[] = "url.urlToHttpOptions of an object that is not a URL is not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

ScrDyn *scr_dyn_native_url(ScrUrl *value) {
  static const ScrDynHandleOps ops = {
    .cls = "URL",
    .retain = &scr_url_retain_v,
    .release = &scr_url_release_v,
    .invoke = &scr_native_url_invoke,
    .get = &scr_native_url_get,
    .set = &scr_native_url_set,
    .inspect_view = &scr_native_url_inspect_view,
    .inspect_view_nested = true,
  };
  scr_dyn_handle_install(SCR_DYNH_URL, &ops);
  return scr_dyn_new_handle(value, SCR_DYNH_URL);
}

bool scr_dyn_native_url_is(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_URL;
}

ScrUrl *scr_dyn_native_url_check(const ScrDyn *value, const ScrDynPath *path) {
  if (!scr_dyn_native_url_is(value)) { scr_dyn_check_fail(path, "URL", value); return NULL; }
  return scr_url_retain(value->v.handle.ptr);
}

static ScrDyn *scr_native_sp_get(void *ptr, const char *key, size_t len) {
  if (len == 4 && !memcmp(key, "size", len)) return scr_dyn_new_num(scr_sp_size(ptr));
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_native_sp_step(void *ptr, double *index, unsigned selection) {
  bool done = *index >= scr_sp_size(ptr);
  ScrDyn *value = scr_dyn_retain(scr_dyn_undefined());
  if (!done) {
    scr_dyn_release(value);
    ScrStr *key = scr_sp_key_at(ptr, *index), *text = scr_sp_val_at(ptr, *index);
    (*index)++;
    if (selection == 2) {
      value = scr_dyn_new_arr();
      scr_dyn_arr_push(value, scr_dyn_new_str(key));
      scr_dyn_arr_push(value, scr_dyn_new_str(text));
    } else value = scr_dyn_new_str(selection == 1 ? key : text);
    scr_str_release(key); scr_str_release(text);
  }
  /* { value, done }, in the iterator result's own key order. */
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, value);
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

static ScrDyn *scr_native_sp_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  if (!strcmp(method, "entries") || !strcmp(method, "keys") || !strcmp(method, "values"))
    return scr_dyn_native_handle_iterator(self, !strcmp(method, "entries") ? 2 : !strcmp(method, "keys") ? 1 : 0);
  if (!strcmp(method, "toString")) {
    ScrStr *text = scr_sp_to_string(ptr);
    ScrDyn *result = scr_dyn_new_str(text);
    scr_str_release(text);
    return result;
  }
  if (!strcmp(method, "sort")) { scr_sp_sort(ptr); return scr_dyn_retain(scr_dyn_undefined()); }
  if (!strcmp(method, "forEach")) {
    if (!argc) { scr_dyn_arg_type_fail("callback", "of type function", scr_dyn_undefined()); return NULL; }
    for (double i = 0; i < scr_sp_size(ptr); i++) {
      ScrStr *key = scr_sp_key_at(ptr, i), *value = scr_sp_val_at(ptr, i);
      ScrDyn *argv[] = {scr_dyn_new_str(value), scr_dyn_new_str(key), self};
      scr_str_release(key); scr_str_release(value);
      scr_dyn_this_push_dyn(argc > 1 ? args[1] : NULL);
      ScrDyn *called = scr_dyn_call(args[0], argv, 3, "callback");
      scr_dyn_this_pop();
      scr_dyn_release(called); scr_dyn_release(argv[0]); scr_dyn_release(argv[1]);
      if (scr_exc_pending()) return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  bool two = !strcmp(method, "append") || !strcmp(method, "set");
  bool one = !strcmp(method, "get") || !strcmp(method, "getAll") || !strcmp(method, "has") || !strcmp(method, "delete");
  if (!one && !two) {
    scr_dyn_arg_type_fail(what, "of type function", scr_dyn_undefined());
    return NULL;
  }
  if (argc < (two ? 2 : 1)) {
    static const char message[] = "Not enough arguments";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrStr *key = scr_dyn_string_coerce_js(args[0]);
  if (scr_exc_pending()) return NULL;
  ScrStr *value = NULL;
  if (two || argc > 1 && args[1]->kind != SCR_DYN_UNDEF) value = scr_dyn_string_coerce_js(args[1]);
  if (scr_exc_pending()) { scr_str_release(key); return NULL; }
  ScrDyn *result = NULL;
  if (!strcmp(method, "get")) {
    ScrStr *found = scr_sp_get(ptr, key);
    result = found ? scr_dyn_new_str(found) : scr_dyn_new_null();
    scr_str_release(found);
  } else if (!strcmp(method, "getAll")) {
    ScrArr *found = scr_sp_get_all(ptr, key);
    result = scr_dyn_new_arr();
    for (size_t i = 0; i < found->len; i++) {
      ScrStr *text = scr_arr_get_ref(found, i);
      scr_dyn_arr_push(result, scr_dyn_new_str(text));
      scr_str_release(text);
    }
    scr_arr_release(found);
  } else if (!strcmp(method, "has")) result = scr_dyn_new_bool(value ? scr_sp_has_value(ptr, key, value) : scr_sp_has(ptr, key));
  else {
    if (!strcmp(method, "append")) scr_sp_append(ptr, key, value);
    else if (!strcmp(method, "set")) scr_sp_set(ptr, key, value);
    else if (value) scr_sp_delete_value(ptr, key, value);
    else scr_sp_delete(ptr, key);
    result = scr_dyn_retain(scr_dyn_undefined());
  }
  scr_str_release(key); scr_str_release(value);
  return result;
}

ScrDyn *scr_dyn_native_search_params(ScrSearchParams *value) {
  static const ScrDynHandleOps ops = {
    "URLSearchParams", &scr_sp_retain_v, &scr_sp_release_v, &scr_native_sp_invoke,
    &scr_native_sp_get, NULL, NULL, NULL, &scr_native_sp_step,
  };
  scr_dyn_handle_install(SCR_DYNH_SEARCH_PARAMS, &ops);
  return scr_dyn_new_handle(value, SCR_DYNH_SEARCH_PARAMS);
}

bool scr_dyn_native_search_params_is(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_SEARCH_PARAMS;
}

ScrSearchParams *scr_dyn_native_search_params_check(const ScrDyn *value, const ScrDynPath *path) {
  if (!scr_dyn_native_search_params_is(value)) { scr_dyn_check_fail(path, "URLSearchParams", value); return NULL; }
  return scr_sp_retain(value->v.handle.ptr);
}

/* new URLSearchParams(init): only undefined is the empty init; null takes
 * the string branch like any other primitive ("null" parses as one key). */
ScrSearchParams *scr_sp_new_checked(const ScrDyn *value) {
  if (!value || value->kind == SCR_DYN_UNDEF) return scr_sp_new();
  if (scr_dyn_native_search_params_is(value)) return scr_sp_copy(value->v.handle.ptr);
  if (value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *iterator = scr_dyn_iterator_optional(value);
    if (scr_exc_pending()) return NULL;
    ScrSearchParams *result = scr_sp_new();
    if (iterator) {
      for (;;) {
        ScrStr *next_key = scr_str_new("next", 4);
        ScrDyn *next = iterator->kind == SCR_DYN_HANDLE ? scr_dyn_handle_key_get(iterator, next_key) : scr_dyn_obj_read(iterator, "next", 4);
        scr_str_release(next_key);
        scr_dyn_this_push_dyn(iterator);
        ScrDyn *step = scr_exc_pending() ? NULL : scr_dyn_call(next, NULL, 0, "iterator.next");
        scr_dyn_this_pop();
        scr_dyn_release(next);
        if (scr_exc_pending()) break;
        ScrDyn *done = scr_dyn_obj_read(step, "done", 4);
        bool end = scr_dyn_truthy(done);
        scr_dyn_release(done);
        if (end) { scr_dyn_release(step); scr_dyn_release(iterator); return result; }
        ScrDyn *row = scr_dyn_obj_read(step, "value", 5);
        ScrDyn *pair = scr_dyn_iter_pack(row, NULL);
        scr_dyn_release(row); scr_dyn_release(step);
        if (scr_exc_pending()) { scr_dyn_release(pair); break; }
        if (!pair || pair->kind != SCR_DYN_ARR || pair->v.arr.len != 2) {
          static const char message[] = "Each query pair must be an iterable [name, value] tuple";
          scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_TUPLE");
          scr_dyn_release(pair); break;
        }
        ScrStr *key = scr_dyn_string_coerce_js(pair->v.arr.items[0]);
        ScrStr *text = scr_exc_pending() ? NULL : scr_dyn_string_coerce_js(pair->v.arr.items[1]);
        if (!scr_exc_pending()) scr_sp_append(result, key, text);
        scr_str_release(key); scr_str_release(text); scr_dyn_release(pair);
        if (scr_exc_pending()) break;
      }
      scr_dyn_release(iterator); scr_sp_release(result); return NULL;
    }
    ScrDyn *keys = scr_dyn_obj_keys(value);
    if (scr_exc_pending()) { scr_sp_release(result); return NULL; }
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      ScrStr *key = keys->v.arr.items[i]->v.str;
      ScrDyn *entry = scr_dyn_obj_read(value, key->data, key->len);
      ScrStr *text = scr_exc_pending() ? NULL : scr_dyn_string_coerce_js(entry);
      scr_dyn_release(entry);
      if (!scr_exc_pending()) scr_sp_append(result, key, text);
      scr_str_release(text);
      if (scr_exc_pending()) { scr_dyn_release(keys); scr_sp_release(result); return NULL; }
    }
    scr_dyn_release(keys); return result;
  }
  ScrStr *text = scr_dyn_string_coerce_js(value);
  if (scr_exc_pending()) return NULL;
  ScrSearchParams *result = scr_sp_parse(text);
  scr_str_release(text);
  return result;
}

ScrStr *scr_url_checked_to_path(const ScrDyn *value) {
  if (scr_dyn_native_url_is(value)) return scr_url_to_path(value->v.handle.ptr);
  if (value->kind == SCR_DYN_STR) return scr_url_str_to_path(value->v.str);
  scr_dyn_arg_type_fail("path", "of type string or an instance of URL", value);
  return NULL;
}

/* Property reads keep option accessors/proxies live, including typed
 * record getter closures and objects held by the dynamic engine. */
static ScrDyn *url_property_read(const ScrDyn *object, const char *name) {
  if (object->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    if (!view) return NULL;
    char getter_name[64];
    snprintf(getter_name, sizeof getter_name, "%%get:%s", name);
    const ScrDyn *getter = scr_dyn_obj_get(view, getter_name, strlen(getter_name));
    ScrDyn *value = getter ? scr_dyn_call(getter, NULL, 0, "getter") : url_property_read(view, name);
    scr_dyn_release(view);
    return value;
  }
  if (object->kind == SCR_DYN_HANDLE) {
    ScrStr *key = scr_str_new(name, strlen(name));
    ScrDyn *value = scr_dyn_handle_key_get(object, key);
    scr_str_release(key);
    return value;
  }
  return scr_dyn_obj_read(object, name, strlen(name));
}

/* options?.windows is a nullish default followed by JS truthiness. */
static bool url_options_windows(const ScrDyn *options, bool *windows) {
#ifdef _WIN32
  *windows = true;
#else
  *windows = false;
#endif
  if (scr_dyn_is_nullish(options)) return true;
  ScrDyn *value = url_property_read(options, "windows");
  if (!value || scr_exc_pending()) { scr_dyn_release(value); return false; }
  if (!scr_dyn_is_nullish(value)) *windows = scr_dyn_truthy(value);
  scr_dyn_release(value);
  return true;
}

static ScrUrl *url_checked_file_input(const ScrDyn *value) {
  if (scr_dyn_native_url_is(value)) return scr_url_retain(value->v.handle.ptr);
  if (value->kind == SCR_DYN_STR) return scr_url_new(value->v.str);
  /* Node's isURL checks href/protocol/auth/path structurally. Keep the
   * short circuit order and getter exceptions before its scheme check. */
  bool is_url = !scr_dyn_is_nullish(value);
  const char *keys[] = {"href", "protocol", "auth", "path"};
  for (size_t i = 0; is_url && i < 4; i++) {
    ScrDyn *property = url_property_read(value, keys[i]);
    if (!property || scr_exc_pending()) { scr_dyn_release(property); return NULL; }
    is_url = i < 2 ? scr_dyn_truthy(property) : property->kind == SCR_DYN_UNDEF;
    scr_dyn_release(property);
  }
  if (!is_url) {
    scr_dyn_arg_type_fail("path", "of type string or an instance of URL", value);
    return NULL;
  }
  ScrDyn *protocol = url_property_read(value, "protocol");
  if (!protocol || scr_exc_pending()) { scr_dyn_release(protocol); return NULL; }
  bool file = protocol->kind == SCR_DYN_STR && protocol->v.str->len == 5 && memcmp(protocol->v.str->data, "file:", 5) == 0;
  scr_dyn_release(protocol);
  if (!file) {
    scr_throw_error_msg_code(SCR_ERR_TYPE, "The URL must be of scheme file", 30, "ERR_INVALID_URL_SCHEME");
    return NULL;
  }
  ScrDyn *host = url_property_read(value, "hostname");
  if (!host || scr_exc_pending()) { scr_dyn_release(host); return NULL; }
  ScrDyn *path = url_property_read(value, "pathname");
  if (!path || scr_exc_pending()) { scr_dyn_release(host); scr_dyn_release(path); return NULL; }
  if (host->kind != SCR_DYN_STR || path->kind != SCR_DYN_STR) {
    static const char message[] = "file URL-like objects require string hostname and pathname properties in scriptc";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    scr_dyn_release(host); scr_dyn_release(path);
    return NULL;
  }
  ScrUrl *url = scr_url_new_file(scr_str_retain(host->v.str), scr_str_retain(path->v.str));
  scr_dyn_release(host); scr_dyn_release(path);
  return url;
}

ScrStr *scr_url_checked_to_path_options(const ScrDyn *value, const ScrDyn *options) {
  bool windows;
  if (!url_options_windows(options, &windows)) return NULL;
  ScrUrl *url = url_checked_file_input(value);
  if (!url) return NULL;
  ScrStr *path = scr_url_to_path_impl(url, windows);
  scr_url_release(url);
  return path;
}

ScrUrl *scr_url_checked_from_path(const ScrDyn *value, const ScrDyn *options) {
  if (value->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("path", "of type string", value);
    return NULL;
  }
  bool windows;
  if (!url_options_windows(options, &windows)) return NULL;
  return scr_url_from_path_impl(value->v.str, windows);
}

ScrBytes *scr_url_checked_to_path_buffer(const ScrDyn *value, const ScrDyn *options) {
  bool windows;
  if (!url_options_windows(options, &windows)) return NULL;
  ScrUrl *url = url_checked_file_input(value);
  if (!url) return NULL;
  if (!url_file_scheme(url) || (!windows && !url_file_posix_host(url))) {
    scr_url_release(url);
    return NULL;
  }
  UrlBuf decoded;
  ub_init(&decoded);
  if (windows && url->host->len) {
    ub_append(&decoded, "\\\\", 2);
    ub_append(&decoded, url->host->data, url->host->len);
  }
  const char *path = url->path->data;
  for (size_t i = 0; i < url->path->len; i++) {
    if (path[i] == '%' && i + 2 < url->path->len) {
      int high = hex_val(path[i + 1]), low = hex_val(path[i + 2]);
      if (high >= 0 && low >= 0) {
        ub_push(&decoded, (char)((high << 4) | low));
        i += 2;
        continue;
      }
    }
    /* Convert literal separators before decoding: encoded %2F stays '/'.
     * Invalid escapes and invalid UTF-8 are preserved as raw bytes. */
    ub_push(&decoded, windows && path[i] == '/' ? '\\' : path[i]);
  }
  size_t start = 0;
  if (windows && url->host->len == 0) {
    int letter = (decoded.len > 1 ? (unsigned char)decoded.data[1] : 0) | 0x20;
    if (letter < 'a' || letter > 'z' || decoded.len < 3 || decoded.data[2] != ':') {
      free(decoded.data);
      scr_url_release(url);
      scr_throw_error_msg_code(SCR_ERR_TYPE, "File URL path must be absolute", 30, "ERR_INVALID_FILE_URL_PATH");
      return NULL;
    }
    start = 1;
  }
  ScrBytes *result = scr_bytes_new(SCR_BYTES_U8, (double)(decoded.len - start));
  result->is_buffer = true;
  if (decoded.len > start) memcpy(result->data, decoded.data + start, decoded.len - start);
  free(decoded.data);
  scr_url_release(url);
  return result;
}

/* ── node:punycode (deprecated, DEP0040) ───────────────────────────────
 * A port of the punycode.js 2.1.0 that Node 24 bundles as lib/punycode.js.
 * It works on UTF-16 code units: ucs2.decode pairs surrogates and keeps
 * lone ones, which is exactly a code-point walk over WTF-8 storage.
 * Errors throw the module's RangeErrors ("Overflow: ...", "Illegal input
 * >= 0x80 ...", "Invalid input"); decoded code points past U+10FFFF throw
 * String.fromCodePoint's "Invalid code point N". All inputs are borrowed;
 * results are +1, or NULL with the error pending. The DEP0040 report is
 * scr_punycode_warn (scr_async_dyn.c). */

enum {
  PC_MAX_INT = 2147483647,
  PC_BASE = 36,
  PC_TMIN = 1,
  PC_TMAX = 26,
  PC_SKEW = 38,
  PC_DAMP = 700,
  PC_INITIAL_BIAS = 72,
  PC_INITIAL_N = 128
};

static void pc_error(const char *message) {
  scr_throw_error_msg(SCR_ERR_RANGE, message, strlen(message));
}
#define PC_OVERFLOW "Overflow: input needs wider integers to process"
#define PC_NOT_BASIC "Illegal input >= 0x80 (not a basic code point)"
#define PC_INVALID "Invalid input"

typedef struct {
  uint32_t *data;
  size_t len, cap;
} PcPoints;

static void pc_push(PcPoints *p, uint32_t cp) {
  if (p->len == p->cap) {
    size_t cap = p->cap ? p->cap * 2 : 16;
    uint32_t *grown = realloc(p->data, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    p->data = grown;
    p->cap = cap;
  }
  p->data[p->len++] = cp;
}

/* ucs2decode over WTF-8 storage: a pair is one 4-byte sequence, a lone
 * surrogate one 3-byte sequence carrying its own value. */
static void pc_code_points(const char *s, size_t n, PcPoints *out) {
  const unsigned char *b = (const unsigned char *)s;
  for (size_t i = 0; i < n;) {
    uint32_t c = b[i];
    if (c < 0x80) {
      i += 1;
    } else if (c < 0xE0 && i + 1 < n) {
      c = ((c & 0x1F) << 6) | (b[i + 1] & 0x3F);
      i += 2;
    } else if (c < 0xF0 && i + 2 < n) {
      c = ((c & 0x0F) << 12) | ((uint32_t)(b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F);
      i += 3;
    } else if (i + 3 < n) {
      c = ((c & 0x07) << 18) | ((uint32_t)(b[i + 1] & 0x3F) << 12) |
          ((uint32_t)(b[i + 2] & 0x3F) << 6) | (b[i + 3] & 0x3F);
      i += 4;
    } else {
      i += 1;
    }
    pc_push(out, c);
  }
}

static int64_t pc_adapt(int64_t delta, int64_t points, bool first) {
  int64_t k = 0;
  delta = first ? delta / PC_DAMP : delta >> 1;
  delta += delta / points;
  for (; delta > ((PC_BASE - PC_TMIN) * PC_TMAX) >> 1; k += PC_BASE) delta /= PC_BASE - PC_TMIN;
  return k + (PC_BASE - PC_TMIN + 1) * delta / (delta + PC_SKEW);
}

static int64_t pc_basic_to_digit(unsigned char c) {
  if (c >= 0x30 && c < 0x3A) return 26 + (c - 0x30);
  if (c >= 0x41 && c < 0x5B) return c - 0x41;
  if (c >= 0x61 && c < 0x7B) return c - 0x61;
  return PC_BASE;
}

static char pc_digit_to_basic(int64_t digit) {
  return (char)(digit + 22 + 75 * (digit < 26));
}

/* String.fromCodePoint(...points). */
static ScrStr *pc_from_points(const PcPoints *p) {
  for (size_t i = 0; i < p->len; i++) {
    if (p->data[i] > 0x10FFFF) {
      char message[48];
      int size = snprintf(message, sizeof message, "Invalid code point %u", (unsigned)p->data[i]);
      scr_throw_error_msg(SCR_ERR_RANGE, message, (size_t)size);
      return NULL;
    }
  }
  char *out = malloc(p->len * 4 + 1);
  if (!out) scr_trap("scriptc: out of memory\n");
  size_t offset = 0;
  for (size_t i = 0; i < p->len; i++) {
    uint32_t point = p->data[i];
    if (point >= 0xD800 && point <= 0xDBFF && i + 1 < p->len && p->data[i + 1] >= 0xDC00 &&
        p->data[i + 1] <= 0xDFFF) {
      point = 0x10000 + ((point - 0xD800) << 10) + (p->data[i + 1] - 0xDC00);
      i++;
    }
    offset += scr_wtf8_put(out + offset, point);
  }
  ScrStr *result = scr_str_new(out, offset);
  free(out);
  return result;
}

/* punycode.decode over the bytes of one label. Any non-ASCII byte fails
 * where its first code unit would: before the last delimiter it is not
 * basic, after it it is no digit — so byte positions stand in for code
 * unit positions until the first error. */
static ScrStr *pc_decode(const char *s, size_t n) {
  PcPoints output = {0};
  size_t basic = 0;
  for (size_t k = n; k > 0; k--) {
    if (s[k - 1] == '-') {
      basic = k - 1;
      break;
    }
  }
  ScrStr *result = NULL;
  for (size_t j = 0; j < basic; j++) {
    if ((unsigned char)s[j] >= 0x80) {
      pc_error(PC_NOT_BASIC);
      goto done;
    }
    pc_push(&output, (unsigned char)s[j]);
  }
  int64_t i = 0, cp = PC_INITIAL_N, bias = PC_INITIAL_BIAS;
  for (size_t index = basic > 0 ? basic + 1 : 0; index < n;) {
    int64_t old = i;
    for (int64_t w = 1, k = PC_BASE;; k += PC_BASE) {
      if (index >= n) {
        pc_error(PC_INVALID);
        goto done;
      }
      int64_t digit = pc_basic_to_digit((unsigned char)s[index++]);
      if (digit >= PC_BASE) {
        pc_error(PC_INVALID);
        goto done;
      }
      if (digit > (PC_MAX_INT - i) / w) {
        pc_error(PC_OVERFLOW);
        goto done;
      }
      i += digit * w;
      int64_t t = k <= bias ? PC_TMIN : (k >= bias + PC_TMAX ? PC_TMAX : k - bias);
      if (digit < t) break;
      if (w > PC_MAX_INT / (PC_BASE - t)) {
        pc_error(PC_OVERFLOW);
        goto done;
      }
      w *= PC_BASE - t;
    }
    int64_t out = (int64_t)output.len + 1;
    bias = pc_adapt(i - old, out, old == 0);
    if (i / out > PC_MAX_INT - cp) {
      pc_error(PC_OVERFLOW);
      goto done;
    }
    cp += i / out;
    i %= out;
    pc_push(&output, 0);
    memmove(output.data + i + 1, output.data + i, (output.len - 1 - (size_t)i) * sizeof *output.data);
    output.data[i++] = (uint32_t)cp;
  }
  result = pc_from_points(&output);
done:
  free(output.data);
  return result;
}

/* punycode.encode of one label's code points, appended to buf. */
static bool pc_encode(const PcPoints *input, ScrJsonBuf *buf) {
  int64_t cp = PC_INITIAL_N, delta = 0, bias = PC_INITIAL_BIAS;
  size_t basic_length = 0;
  for (size_t k = 0; k < input->len; k++) {
    if (input->data[k] < 0x80) {
      scr_jb_putc(buf, (char)input->data[k]);
      basic_length++;
    }
  }
  size_t handled = basic_length;
  if (basic_length) scr_jb_putc(buf, '-');
  while (handled < input->len) {
    int64_t m = PC_MAX_INT;
    for (size_t k = 0; k < input->len; k++)
      if (input->data[k] >= cp && input->data[k] < m) m = input->data[k];
    int64_t handled_plus_one = (int64_t)handled + 1;
    if (m - cp > (PC_MAX_INT - delta) / handled_plus_one) {
      pc_error(PC_OVERFLOW);
      return false;
    }
    delta += (m - cp) * handled_plus_one;
    cp = m;
    for (size_t k = 0; k < input->len; k++) {
      int64_t current = input->data[k];
      if (current < cp && ++delta > PC_MAX_INT) {
        pc_error(PC_OVERFLOW);
        return false;
      }
      if (current == cp) {
        int64_t q = delta;
        for (int64_t j = PC_BASE;; j += PC_BASE) {
          int64_t t = j <= bias ? PC_TMIN : (j >= bias + PC_TMAX ? PC_TMAX : j - bias);
          if (q < t) break;
          scr_jb_putc(buf, pc_digit_to_basic(t + (q - t) % (PC_BASE - t)));
          q = (q - t) / (PC_BASE - t);
        }
        scr_jb_putc(buf, pc_digit_to_basic(q));
        bias = pc_adapt(delta, handled_plus_one, handled == basic_length);
        delta = 0;
        handled++;
      }
    }
    delta++;
    cp++;
  }
  return true;
}

ScrStr *scr_punycode_decode(const ScrStr *input) { return pc_decode(input->data, input->len); }

ScrStr *scr_punycode_encode(const ScrStr *input) {
  PcPoints points = {0};
  pc_code_points(input->data, input->len, &points);
  ScrJsonBuf buf;
  scr_jb_init(&buf);
  bool ok = pc_encode(&points, &buf);
  free(points.data);
  ScrStr *result = scr_jb_finish(&buf);
  if (ok) return result;
  scr_str_release(result);
  return NULL;
}

ScrArr *scr_punycode_ucs2_decode(const ScrStr *input) {
  PcPoints points = {0};
  pc_code_points(input->data, input->len, &points);
  ScrArr *out = scr_arr_new(SCR_ELEM_F64, points.len);
  for (size_t i = 0; i < points.len; i++) scr_arr_push_f64(out, (double)points.data[i]);
  free(points.data);
  return out;
}

/* mapDomain: only the part after the first '@' maps (and only up to a
 * second one — punycode.js keeps parts[0] and parts[1]); the RFC 3490
 * separators U+002E, U+3002, U+FF0E and U+FF61 all split labels, and the
 * labels rejoin with '.'. */
static ScrStr *pc_map_domain(const ScrStr *input, bool to_ascii) {
  const char *s = input->data;
  size_t n = input->len;
  ScrJsonBuf buf;
  scr_jb_init(&buf);
  const char *at = memchr(s, '@', n);
  if (at) {
    scr_jb_write(&buf, s, (size_t)(at - s) + 1);
    const char *rest = at + 1;
    const char *second = memchr(rest, '@', n - (size_t)(rest - s));
    n = (second ? (size_t)(second - rest) : n - (size_t)(rest - s));
    s = rest;
  }
  size_t start = 0;
  bool ok = true;
  for (size_t i = 0; ok && i <= n;) {
    size_t sep = 0;
    if (i == n) sep = 1;
    else if (s[i] == '.') sep = 1;
    else if (i + 2 < n && (unsigned char)s[i] == 0xE3 && (unsigned char)s[i + 1] == 0x80 &&
             (unsigned char)s[i + 2] == 0x82)
      sep = 3;
    else if (i + 2 < n && (unsigned char)s[i] == 0xEF &&
             (((unsigned char)s[i + 1] == 0xBC && (unsigned char)s[i + 2] == 0x8E) ||
              ((unsigned char)s[i + 1] == 0xBD && (unsigned char)s[i + 2] == 0xA1)))
      sep = 3;
    if (!sep) {
      i++;
      continue;
    }
    const char *label = s + start;
    size_t len = i - start;
    bool ascii = true;
    for (size_t k = 0; k < len; k++) ascii = ascii && (unsigned char)label[k] < 0x80;
    if (to_ascii && !ascii) {
      PcPoints points = {0};
      pc_code_points(label, len, &points);
      scr_jb_puts(&buf, "xn--");
      ok = pc_encode(&points, &buf);
      free(points.data);
    } else if (!to_ascii && len >= 4 && memcmp(label, "xn--", 4) == 0) {
      /* string.slice(4).toLowerCase(): ASCII letters fold; the one other
       * code point whose lowercase is ASCII is KELVIN SIGN (U+212A → k).
       * Any other non-ASCII stays non-ASCII and fails in decode either
       * way, at the same position. */
      ScrJsonBuf lower;
      scr_jb_init(&lower);
      for (size_t k = 4; k < len; k++) {
        unsigned char c = (unsigned char)label[k];
        if (c == 0xE2 && k + 2 < len && (unsigned char)label[k + 1] == 0x84 &&
            (unsigned char)label[k + 2] == 0xAA) {
          scr_jb_putc(&lower, 'k');
          k += 2;
        } else {
          scr_jb_putc(&lower, (char)(c >= 'A' && c <= 'Z' ? c + 32 : c));
        }
      }
      ScrStr *folded = scr_jb_finish(&lower);
      ScrStr *decoded = pc_decode(folded->data, folded->len);
      scr_str_release(folded);
      if (decoded) {
        scr_jb_put_str(&buf, decoded);
        scr_str_release(decoded);
      } else {
        ok = false;
      }
    } else {
      scr_jb_write(&buf, label, len);
    }
    if (ok && i < n) scr_jb_putc(&buf, '.');
    i += sep;
    start = i;
  }
  ScrStr *result = scr_jb_finish(&buf);
  if (ok) return result;
  scr_str_release(result);
  return NULL;
}

ScrStr *scr_punycode_to_ascii(const ScrStr *input) { return pc_map_domain(input, true); }
ScrStr *scr_punycode_to_unicode(const ScrStr *input) { return pc_map_domain(input, false); }
