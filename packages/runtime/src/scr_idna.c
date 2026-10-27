/* UTS #46 domain processing for node:url — the conversions Node applies to
 * WHATWG URL hosts and url.parse() hostnames (ToASCII),
 * url.domainToASCII()/domainToUnicode() and url.format()'s unicode option:
 * nontransitional mapping, NFC, label validity (leading combining marks,
 * ContextJ, and the RFC 5893 bidi rule), and Punycode. It matches Node 24's implementation, including its
 * validity-data snapshot and the shortcuts its label checks take; the
 * differential corpus and test/url-legacy-cases.txt (generated from Node)
 * are the oracle.
 *
 * Code points travel as UTF-32 buffers. Input bytes must be well-formed
 * UTF-8: lone surrogates and malformed sequences fail ToASCII, as they do
 * once Node has replaced them with U+FFFD (a disallowed code point). All
 * inputs are BORROWED; string results are fresh (+1). Nothing throws. */
#include "scr_runtime.h"
#include "scr_idna_data.h"

#include <stdlib.h>
#include <string.h>

/* ── UTF-32 scratch buffers ─────────────────────────────────────────── */

typedef struct {
  uint32_t *data;
  size_t len;
  size_t cap;
} IdnaBuf;

static void ib32_reserve(IdnaBuf *b, size_t extra) {
  if (b->len + extra <= b->cap) return;
  size_t cap = b->cap ? b->cap : 16;
  while (b->len + extra > cap) cap *= 2;
  uint32_t *grown = realloc(b->data, cap * sizeof *grown);
  if (!grown) scr_trap("scriptc: out of memory\n");
  b->data = grown;
  b->cap = cap;
}

static void ib32_push(IdnaBuf *b, uint32_t c) {
  ib32_reserve(b, 1);
  b->data[b->len++] = c;
}

static void ib32_insert(IdnaBuf *b, size_t at, uint32_t c) {
  ib32_reserve(b, 1);
  memmove(b->data + at + 1, b->data + at, (b->len - at) * sizeof *b->data);
  b->data[at] = c;
  b->len++;
}

/* Strict UTF-8 → UTF-32; false on any malformed sequence, overlong form,
 * surrogate, or code point past U+10FFFF. */
static bool idna_decode_utf8(const char *p, size_t n, IdnaBuf *out) {
  const unsigned char *s = (const unsigned char *)p;
  for (size_t i = 0; i < n;) {
    unsigned char c = s[i];
    uint32_t cp;
    size_t extra;
    if (c < 0x80) {
      ib32_push(out, c);
      i++;
      continue;
    }
    if ((c & 0xE0) == 0xC0) {
      cp = c & 0x1F;
      extra = 1;
    } else if ((c & 0xF0) == 0xE0) {
      cp = c & 0x0F;
      extra = 2;
    } else if ((c & 0xF8) == 0xF0) {
      cp = c & 0x07;
      extra = 3;
    } else {
      return false;
    }
    if (i + extra >= n) return false;
    for (size_t k = 1; k <= extra; k++) {
      if ((s[i + k] & 0xC0) != 0x80) return false;
      cp = (cp << 6) | (s[i + k] & 0x3F);
    }
    if ((extra == 1 && cp < 0x80) || (extra == 2 && (cp < 0x800 || (cp >= 0xD800 && cp < 0xE000))) ||
        (extra == 3 && (cp < 0x10000 || cp > 0x10FFFF)))
      return false;
    ib32_push(out, cp);
    i += extra + 1;
  }
  return true;
}

static void idna_put_utf8(ScrJsonBuf *b, uint32_t cp) {
  char out[4];
  size_t n;
  if (cp < 0x80) {
    out[0] = (char)cp;
    n = 1;
  } else if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6));
    out[1] = (char)(0x80 | (cp & 0x3F));
    n = 2;
  } else if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    n = 3;
  } else {
    out[0] = (char)(0xF0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (char)(0x80 | (cp & 0x3F));
    n = 4;
  }
  scr_jb_write_utf8(b, out, n);
}

/* ── table lookups ─────────────────────────────────────────────────── */

static uint32_t idna_status(uint32_t cp) {
  size_t lo = 0, hi = sizeof scr_idna_status / sizeof scr_idna_status[0];
  while (hi - lo > 1) {
    size_t mid = lo + (hi - lo) / 2;
    if (scr_idna_status[mid][0] <= cp) lo = mid;
    else hi = mid;
  }
  return scr_idna_status[lo][1];
}

static uint8_t idna_range_value(const ScrIdnaRange *table, size_t n, uint32_t cp) {
  size_t lo = 0, hi = n;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    if (table[mid].end < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo < n && table[lo].start <= cp ? table[lo].value : 0;
}

#define IDNA_LOOKUP(table, cp) idna_range_value(table, sizeof table / sizeof table[0], cp)

static uint8_t idna_bidi(uint32_t cp) { return IDNA_LOOKUP(scr_idna_bidi, cp); }

static bool idna_is_virama(uint32_t cp) {
  size_t lo = 0, hi = sizeof scr_idna_virama / sizeof scr_idna_virama[0];
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    if (scr_idna_virama[mid] < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo < sizeof scr_idna_virama / sizeof scr_idna_virama[0] && scr_idna_virama[lo] == cp;
}

/* The UTS #46 Map step: false when a disallowed code point appears. */
static bool idna_map(const uint32_t *in, size_t n, IdnaBuf *out) {
  for (size_t i = 0; i < n; i++) {
    uint32_t descriptor = idna_status(in[i]);
    switch (descriptor & 0xFF) {
      case 0:
        break;
      case 1:
        ib32_push(out, in[i]);
        break;
      case 2:
        return false;
      default: {
        size_t count = descriptor >> 24;
        size_t index = (descriptor >> 8) & 0xFFFF;
        for (size_t k = 0; k < count; k++) ib32_push(out, scr_idna_mappings[index + k]);
      }
    }
  }
  return true;
}

static void idna_normalize(IdnaBuf *b) {
  bool ascii = true;
  for (size_t i = 0; i < b->len && ascii; i++) ascii = b->data[i] < 0x80;
  if (ascii) return;
  size_t len;
  uint32_t *nfc = scr_nfc_code_points(b->data, b->len, &len);
  free(b->data);
  b->data = nfc;
  b->len = b->cap = len;
}

static bool idna_same(const uint32_t *a, size_t an, const uint32_t *b, size_t bn) {
  return an == bn && (an == 0 || memcmp(a, b, an * sizeof *a) == 0);
}

/* ── Punycode (RFC 3492) ───────────────────────────────────────────── */

enum { PUNY_BASE = 36, PUNY_TMIN = 1, PUNY_TMAX = 26, PUNY_SKEW = 38, PUNY_DAMP = 700 };

static int32_t puny_digit(char c) {
  if (c >= 'a' && c <= 'z') return c - 'a';
  if (c >= '0' && c <= '9') return c - '0' + 26;
  return -1;
}

static char puny_char(int32_t digit) { return (char)(digit < 26 ? digit + 'a' : digit + 22); }

static int32_t puny_adapt(int32_t d, int32_t n, bool first) {
  d = first ? d / PUNY_DAMP : d / 2;
  d += d / n;
  int32_t k = 0;
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) / 2) {
    d /= PUNY_BASE - PUNY_TMIN;
    k += PUNY_BASE;
  }
  return k + (((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW));
}

/* Decodes the label after its "xn--" prefix into `out`. A decoded label
 * that itself begins with "xn--" fails (whatwg/url#803). */
static bool puny_decode(const char *p, size_t n, IdnaBuf *out) {
  int32_t written = 0;
  uint32_t code = 128;
  int32_t i = 0;
  int32_t bias = 72;
  size_t dash = n;
  for (size_t k = n; k > 0; k--) {
    if (p[k - 1] == '-') {
      dash = k - 1;
      break;
    }
  }
  size_t pos = 0;
  if (dash != n) {
    for (size_t k = 0; k < dash; k++) {
      if ((unsigned char)p[k] >= 0x80) return false;
      ib32_push(out, (unsigned char)p[k]);
      written++;
    }
    pos = dash + 1;
  }
  while (pos < n) {
    int32_t old = i;
    int32_t w = 1;
    for (int32_t k = PUNY_BASE;; k += PUNY_BASE) {
      if (pos >= n) return false;
      int32_t digit = puny_digit(p[pos++]);
      if (digit < 0) return false;
      if (digit > (0x7fffffff - i) / w) return false;
      i += digit * w;
      int32_t t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
      if (digit < t) break;
      if (w > 0x7fffffff / (PUNY_BASE - t)) return false;
      w *= PUNY_BASE - t;
    }
    bias = puny_adapt(i - old, written + 1, old == 0);
    if (i / (written + 1) > (int32_t)(0x7fffffff - code)) return false;
    code += (uint32_t)(i / (written + 1));
    i %= written + 1;
    if (code < 0x80) return false;
    ib32_insert(out, (size_t)i, code);
    written++;
    i++;
  }
  return !(out->len >= 4 && out->data[0] == 'x' && out->data[1] == 'n' && out->data[2] == '-' &&
           out->data[3] == '-');
}

static bool puny_encode(const uint32_t *in, size_t n, ScrJsonBuf *out) {
  uint32_t code = 128;
  int32_t delta = 0;
  int32_t bias = 72;
  size_t handled = 0;
  for (size_t k = 0; k < n; k++) {
    if (in[k] < 0x80) {
      handled++;
      scr_jb_putc(out, (char)in[k]);
    }
    if (in[k] > 0x10FFFF || (in[k] >= 0xD800 && in[k] < 0xE000)) return false;
  }
  size_t basic = handled;
  if (basic > 0) scr_jb_putc(out, '-');
  while (handled < n) {
    uint32_t m = 0x10FFFF;
    for (size_t k = 0; k < n; k++)
      if (in[k] >= code && in[k] < m) m = in[k];
    if ((m - code) > (0x7fffffff - (uint32_t)delta) / (handled + 1)) return false;
    delta += (int32_t)((m - code) * (handled + 1));
    code = m;
    for (size_t k = 0; k < n; k++) {
      if (in[k] < code) {
        if (delta == 0x7fffffff) return false;
        delta++;
      }
      if (in[k] == code) {
        int32_t q = delta;
        for (int32_t j = PUNY_BASE;; j += PUNY_BASE) {
          int32_t t = j <= bias ? PUNY_TMIN : j >= bias + PUNY_TMAX ? PUNY_TMAX : j - bias;
          if (q < t) break;
          scr_jb_putc(out, puny_char(t + ((q - t) % (PUNY_BASE - t))));
          q = (q - t) / (PUNY_BASE - t);
        }
        scr_jb_putc(out, puny_char(q));
        bias = puny_adapt(delta, (int32_t)(handled + 1), handled == basic);
        delta = 0;
        handled++;
      }
    }
    delta++;
    code++;
  }
  return true;
}

/* ── label validity ────────────────────────────────────────────────── */

/* The UTS #46 Validity Criteria as Node checks them: a leading combining
 * mark fails; the FIRST joiner decides the whole label (a joiner after a
 * virama passes, a ZWNJ otherwise needs a left- or dual-joining character
 * somewhere before it and a right- or dual-joining one somewhere after);
 * otherwise a label holding an R, AL or AN character follows the RFC 5893
 * rule for the direction of its first character: an L label allows only
 * L, EN, ES, CS, ET, ON, BN and NSM and ends (before trailing NSMs) in L
 * or EN; any other label must start with R or AL. */
static bool idna_label_valid(const uint32_t *label, size_t n) {
  if (n == 0) return true;
  if (IDNA_LOOKUP(scr_idna_marks, label[0])) return false;
  for (size_t i = 0; i < n; i++) {
    uint32_t c = label[i];
    if (c != 0x200C && c != 0x200D) continue;
    if (i > 0 && idna_is_virama(label[i - 1])) return true;
    if (c == 0x200D || i + 1 >= n) return false;
    bool before = false, after = false;
    for (size_t k = 0; k < i && !before; k++) {
      uint8_t j = IDNA_LOOKUP(scr_idna_joining, label[k]);
      before = j == SCR_JOIN_L || j == SCR_JOIN_D;
    }
    for (size_t k = i + 1; k < n && !after; k++) {
      uint8_t j = IDNA_LOOKUP(scr_idna_joining, label[k]);
      after = j == SCR_JOIN_R || j == SCR_JOIN_D;
    }
    return before && after;
  }
  size_t last = n;
  for (size_t k = n; k > 0; k--) {
    if (idna_bidi(label[k - 1]) != SCR_BIDI_NSM) {
      last = k - 1;
      break;
    }
  }
  if (last == n) return false;
  bool rtl = false;
  for (size_t k = 0; k < n && !rtl; k++) {
    uint8_t d = idna_bidi(label[k]);
    rtl = d == SCR_BIDI_R || d == SCR_BIDI_AL || d == SCR_BIDI_AN;
  }
  if (!rtl) return true;
  if (idna_bidi(label[0]) == SCR_BIDI_L) {
    for (size_t k = 0; k <= last; k++) {
      uint8_t d = idna_bidi(label[k]);
      if (!(d == SCR_BIDI_L || d == SCR_BIDI_EN || d == SCR_BIDI_ES || d == SCR_BIDI_CS ||
            d == SCR_BIDI_ET || d == SCR_BIDI_ON || d == SCR_BIDI_BN || d == SCR_BIDI_NSM))
        return false;
    }
    uint8_t end = idna_bidi(label[last]);
    return end == SCR_BIDI_L || end == SCR_BIDI_EN;
  }
  uint8_t first = idna_bidi(label[0]);
  if (first != SCR_BIDI_R && first != SCR_BIDI_AL) return false;
  bool has_an = false, has_en = false;
  for (size_t k = 0; k <= last; k++) {
    uint8_t d = idna_bidi(label[k]);
    if (d == SCR_BIDI_EN) {
      has_en = true;
      if (has_an) return false;
    } else if (d == SCR_BIDI_AN) {
      has_an = true;
      if (has_en) return false;
    }
    if (!(d == SCR_BIDI_R || d == SCR_BIDI_AL || d == SCR_BIDI_AN || d == SCR_BIDI_EN ||
          d == SCR_BIDI_ES || d == SCR_BIDI_CS || d == SCR_BIDI_ET || d == SCR_BIDI_ON ||
          d == SCR_BIDI_BN || d == SCR_BIDI_NSM))
      return false;
    if (k == last && !(d == SCR_BIDI_R || d == SCR_BIDI_AL || d == SCR_BIDI_AN || d == SCR_BIDI_EN))
      return false;
  }
  return true;
}

/* An "xn--" label's Punycode must decode to a non-ASCII label that the
 * mapping and NFC leave unchanged and that passes the validity checks.
 * `decoded_out` (nullable) receives the decoded code points when it passes. */
static bool idna_check_puny_label(const char *p, size_t n, IdnaBuf *decoded_out) {
  IdnaBuf decoded = {0}, mapped = {0};
  bool ok = puny_decode(p, n, &decoded);
  if (ok) {
    bool ascii = true;
    for (size_t k = 0; k < decoded.len && ascii; k++) ascii = decoded.data[k] < 0x80;
    ok = !ascii && idna_map(decoded.data, decoded.len, &mapped) &&
         idna_same(decoded.data, decoded.len, mapped.data, mapped.len);
  }
  if (ok) {
    IdnaBuf normal = {0};
    ib32_reserve(&normal, mapped.len);
    memcpy(normal.data, mapped.data, mapped.len * sizeof *mapped.data);
    normal.len = mapped.len;
    idna_normalize(&normal);
    ok = idna_same(normal.data, normal.len, mapped.data, mapped.len) && mapped.len > 0 &&
         idna_label_valid(mapped.data, mapped.len);
    free(normal.data);
  }
  if (ok && decoded_out) {
    *decoded_out = decoded;
  } else {
    free(decoded.data);
  }
  free(mapped.data);
  return ok;
}

static ScrStr *idna_fail(ScrJsonBuf *b) {
  scr_str_release(scr_jb_finish(b));
  return scr_str_new("", 0);
}

/* ── ToASCII / ToUnicode ───────────────────────────────────────────── */

/* Inputs longer than this many bytes fail ToASCII and pass ToUnicode
 * through unchanged. */
#define IDNA_MAX_INPUT_BYTES 16384u

ScrStr *scr_idna_to_ascii(const char *p, size_t n) {
  ScrJsonBuf out;
  scr_jb_init(&out);
  if (n > IDNA_MAX_INPUT_BYTES) return idna_fail(&out);
  bool ascii = true;
  for (size_t i = 0; i < n && ascii; i++) ascii = (unsigned char)p[i] < 0x80;
  if (ascii) {
    /* An ASCII domain is the input lowercased, whatever its labels hold
     * (the URL Standard's domain to ASCII with beStrict false). */
    for (size_t i = 0; i < n; i++) {
      char c = p[i];
      scr_jb_putc(&out, c >= 'A' && c <= 'Z' ? (char)(c + 32) : c);
    }
    return scr_jb_finish(&out);
  }
  IdnaBuf input = {0}, mapped = {0};
  if (!idna_decode_utf8(p, n, &input) || !idna_map(input.data, input.len, &mapped)) {
    free(input.data);
    free(mapped.data);
    return idna_fail(&out);
  }
  free(input.data);
  idna_normalize(&mapped);
  bool ok = true;
  for (size_t start = 0; ok && start < mapped.len;) {
    size_t end = start;
    while (end < mapped.len && mapped.data[end] != '.') end++;
    const uint32_t *label = mapped.data + start;
    size_t len = end - start;
    bool label_ascii = true;
    for (size_t k = 0; k < len && label_ascii; k++) label_ascii = label[k] < 0x80;
    if (len >= 4 && label[0] == 'x' && label[1] == 'n' && label[2] == '-' && label[3] == '-') {
      if (!label_ascii) {
        ok = false;
        break;
      }
      char *bytes = malloc(len);
      if (!bytes) scr_trap("scriptc: out of memory\n");
      for (size_t k = 0; k < len; k++) bytes[k] = (char)label[k];
      ok = idna_check_puny_label(bytes + 4, len - 4, NULL);
      if (ok) scr_jb_write_utf8(&out, bytes, len);
      free(bytes);
    } else if (label_ascii) {
      for (size_t k = 0; k < len; k++) scr_jb_putc(&out, (char)label[k]);
    } else {
      ok = idna_label_valid(label, len);
      if (ok) {
        scr_jb_puts(&out, "xn--");
        ok = puny_encode(label, len, &out);
      }
    }
    if (end < mapped.len) scr_jb_putc(&out, '.');
    start = end + 1;
  }
  free(mapped.data);
  return ok ? scr_jb_finish(&out) : idna_fail(&out);
}

/* ToUnicode never fails: an "xn--" label decodes only when it passes the
 * same checks ToASCII applies to it; any other label stays as given. */
ScrStr *scr_idna_to_unicode(const char *p, size_t n) {
  if (n > IDNA_MAX_INPUT_BYTES) return scr_str_new(p, n);
  ScrJsonBuf out;
  scr_jb_init(&out);
  for (size_t start = 0; start < n;) {
    const char *dot = memchr(p + start, '.', n - start);
    size_t end = dot ? (size_t)(dot - p) : n;
    const char *label = p + start;
    size_t len = end - start;
    bool ascii = true;
    for (size_t k = 0; k < len && ascii; k++) ascii = (unsigned char)label[k] < 0x80;
    bool decoded = false;
    IdnaBuf cps = {0};
    if (ascii && len >= 4 && memcmp(label, "xn--", 4) == 0 &&
        idna_check_puny_label(label + 4, len - 4, &cps)) {
      bool scalar = true;
      for (size_t k = 0; k < cps.len && scalar; k++)
        scalar = cps.data[k] <= 0x10FFFF && (cps.data[k] < 0xD800 || cps.data[k] >= 0xE000);
      if (scalar) {
        for (size_t k = 0; k < cps.len; k++) idna_put_utf8(&out, cps.data[k]);
        decoded = true;
      }
    }
    free(cps.data);
    if (!decoded) scr_jb_write(&out, label, len);
    if (!dot) break;
    scr_jb_putc(&out, '.');
    start = end + 1;
  }
  return scr_jb_finish(&out);
}

/* The URL host parser's UTS #46 ToASCII (scr_url.c). */
void scr_url_idna_install(void) { scr_url_host_to_ascii = &scr_idna_to_ascii; }
