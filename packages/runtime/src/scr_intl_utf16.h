/* scriptc runtime — WTF-8 to UTF-16 for the ICU unit (scr_intl.c). Kept
 * apart from ICU's headers so packages/runtime/test can check the decode
 * on its own (test_intl_utf16.c). */
#ifndef SCR_INTL_UTF16_H
#define SCR_INTL_UTF16_H

#include <stddef.h>
#include <stdint.h>

/** The code point of the WTF-8 sequence at `p` (before `end`), and its byte
 * count in *size. A malformed sequence (an overlong form, a value above
 * U+10FFFF, a stray or missing continuation byte) is decoded one maximal
 * subpart at a time to U+FFFD, as the WHATWG UTF-8 decoder does. The 3-byte
 * form of a surrogate is WTF-8's lone surrogate and decodes to that unit. */
static inline uint32_t scr_intl_decode(const unsigned char *p, const unsigned char *end, size_t *size) {
  unsigned char lead = p[0];
  *size = 1;
  if (lead < 0x80) return lead;
  size_t need;
  unsigned char lo = 0x80, hi = 0xbf;
  uint32_t cp;
  if (lead >= 0xc2 && lead <= 0xdf) {
    need = 1;
    cp = lead & 0x1fu;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    need = 2;
    cp = lead & 0x0fu;
    if (lead == 0xe0) lo = 0xa0;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    need = 3;
    cp = lead & 0x07u;
    if (lead == 0xf0) lo = 0x90;
    if (lead == 0xf4) hi = 0x8f;
  } else {
    return 0xfffd;
  }
  for (size_t i = 1; i <= need; i++) {
    if (p + i >= end || p[i] < lo || p[i] > hi) {
      *size = i;
      return 0xfffd;
    }
    cp = (cp << 6) | (p[i] & 0x3fu);
    lo = 0x80;
    hi = 0xbf;
  }
  *size = need + 1;
  return cp;
}

/** The number of UTF-16 units the `len` bytes at `data` decode to. */
static inline size_t scr_intl_utf16_units(const unsigned char *data, size_t len) {
  const unsigned char *end = data + len;
  size_t count = 0;
  for (const unsigned char *p = data; p < end;) {
    size_t size;
    count += scr_intl_decode(p, end, &size) > 0xffff ? 2 : 1;
    p += size;
  }
  return count;
}

/** Writes the UTF-16 units of the `len` bytes at `data` to `out`, which has
 * room for scr_intl_utf16_units(data, len) of them, and returns how many it
 * wrote: always that count. */
static inline size_t scr_intl_utf16_fill(const unsigned char *data, size_t len, uint16_t *out) {
  const unsigned char *end = data + len;
  size_t at = 0;
  for (const unsigned char *p = data; p < end;) {
    size_t size;
    uint32_t cp = scr_intl_decode(p, end, &size);
    if (cp > 0xffff) {
      out[at++] = (uint16_t)(0xd800 + ((cp - 0x10000) >> 10));
      out[at++] = (uint16_t)(0xdc00 + ((cp - 0x10000) & 0x3ff));
    } else {
      out[at++] = (uint16_t)cp;
    }
    p += size;
  }
  return at;
}

#endif /* SCR_INTL_UTF16_H */
