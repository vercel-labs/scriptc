/* Unit tests for the typed-array/Buffer runtime (scr_bytes.c) and the
 * zlib slice (scr_zlib.c). Built with ASan + -DSCR_RC_AUDIT by
 * bytes.test.ts, which also asserts the trap modes abort:
 *
 *   <scratch-dir>       run all assertions; prints "N/N cases passed"
 *   --crash-get-oob     element read past the end   → RangeError + abort()
 *   --crash-get-frac    fractional element index    → RangeError + abort()
 *
 * The coercion matrix mirrors Node exactly (verified by hand and by the
 * differential corpus): ToUint8/ToUint32 modular truncation on writes,
 * double→float rounding for f32, ToIndex construction lengths, WHATWG
 * replacement decoding for toString("utf8").
 */
#include "../src/scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void);
long scr_bytes_live_count(void);
#endif

static long total = 0, failed = 0;

void scr_bytes_test_bulk_storage(void);
void scr_bytes_test_buffer_pool(void);

static void check(bool ok, const char *what) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

static void check_f64(double got, double want, const char *what) {
  check(got == want, what);
  if (got != want) fprintf(stderr, "  got %g want %g\n", got, want);
}

static void check_str(ScrStr *got /* consumed */, const char *want, const char *what) {
  check(got->len == strlen(want) && memcmp(got->data, want, got->len) == 0, what);
  if (got->len != strlen(want) || memcmp(got->data, want, got->len) != 0) {
    fprintf(stderr, "  got \"%.*s\" want \"%s\"\n", (int)got->len, got->data, want);
  }
  scr_str_release(got);
}

static ScrStr *S(const char *text) { return scr_str_new(text, strlen(text)); }

static void expect_pending(const char *name) {
  check(scr_exc_pending(), name);
  if (scr_exc_pending()) scr_exc_print_uncaught();
}

static void test_construction(void) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, 3);
  check_f64(scr_bytes_len(b), 3, "new(3) length");
  check_f64(scr_bytes_byte_len(b), 3, "u8 byteLength == length");
  check_f64(scr_bytes_get(b, 0), 0, "zero-filled");
  scr_bytes_release(b);

  b = scr_bytes_new(SCR_BYTES_U8, 1);
  scr_bytes_set(b, 0, 3);
  const double invalid_indices[] = { -1, 0.5, 1, NAN, INFINITY, -INFINITY };
  for (size_t i = 0; i < sizeof invalid_indices / sizeof invalid_indices[0]; i++) {
    scr_bytes_set(b, invalid_indices[i], 7);
    check_f64(scr_bytes_get(b, 0), 3, "invalid writes preserve existing elements");
    check_f64(scr_bytes_len(b), 1, "invalid writes do not grow typed arrays");
    check(!scr_exc_pending(), "invalid writes do not throw");
  }
  scr_bytes_release(b);

  /* ToIndex: 3.5 truncates to 3, NaN is 0 — no throw (Node-exact). */
  b = scr_bytes_new(SCR_BYTES_U8, 3.5);
  check_f64(scr_bytes_len(b), 3, "new(3.5) truncates to 3");
  scr_bytes_release(b);
  b = scr_bytes_new(SCR_BYTES_U8, 0.0 / 0.0);
  check_f64(scr_bytes_len(b), 0, "new(NaN) is empty");
  scr_bytes_release(b);

  /* Negative lengths throw Node's RangeError, catchably. */
  check(!scr_exc_pending(), "no pending exception before");
  b = scr_bytes_new(SCR_BYTES_U8, -1);
  check(b == NULL, "new(-1) returns NULL");
  expect_pending("new(-1) throws RangeError");

  b = scr_bytes_new(SCR_BYTES_U32, 2);
  check_f64(scr_bytes_byte_len(b), 8, "u32 byteLength is 4x");
  scr_bytes_release(b);
}

static void test_coercion_matrix(void) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, 1);
  static const double in[] = {3.7, -3.7, -1, 255, 256, 257, 0.0 / 0.0,
                              1.0 / 0.0, -1.0 / 0.0, 1e10, 0.5, -0.5};
  static const double out[] = {3, 253, 255, 255, 0, 1, 0, 0, 0, 0, 0, 0};
  for (size_t i = 0; i < sizeof in / sizeof in[0]; i++) {
    scr_bytes_set(b, 0, in[i]);
    check_f64(scr_bytes_get(b, 0), out[i], "ToUint8 matrix");
  }
  scr_bytes_release(b);

  ScrBytes *u = scr_bytes_new(SCR_BYTES_U32, 1);
  static const double uin[] = {-1, 4294967296.0, 4294967301.0, 4.9, 0.0 / 0.0};
  static const double uout[] = {4294967295.0, 0, 5, 4, 0};
  for (size_t i = 0; i < sizeof uin / sizeof uin[0]; i++) {
    scr_bytes_set(u, 0, uin[i]);
    check_f64(scr_bytes_get(u, 0), uout[i], "ToUint32 matrix");
  }
  scr_bytes_release(u);

  ScrBytes *f = scr_bytes_new(SCR_BYTES_F32, 1);
  scr_bytes_set(f, 0, 0.1);
  check_f64(scr_bytes_get(f, 0), 0.10000000149011612, "f32 rounding of 0.1");
  scr_bytes_set(f, 0, 0.0 / 0.0);
  check(scr_bytes_get(f, 0) != scr_bytes_get(f, 0), "f32 NaN round-trips");
  scr_bytes_release(f);
}

static void test_slice_set_copy(void) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, 5);
  for (double i = 0; i < 5; i++) scr_bytes_set(b, i, i + 1);

  ScrBytes *s = scr_bytes_slice(b, -3, -1); /* [3, 4] */
  check_f64(scr_bytes_len(s), 2, "slice(-3,-1) length");
  check_f64(scr_bytes_get(s, 0), 3, "slice negative start");
  check_f64(scr_bytes_get(s, 1), 4, "slice negative end");
  scr_bytes_set(s, 0, 99);
  check_f64(scr_bytes_get(b, 2), 3, "slice is a COPY (source untouched)");
  scr_bytes_release(s);

  s = scr_bytes_slice(b, 1.9, 3.2); /* trunc: [2, 3] */
  check_f64(scr_bytes_len(s), 2, "slice truncates fractional indices");
  check_f64(scr_bytes_get(s, 0), 2, "slice(1.9, ...)");
  scr_bytes_release(s);

  ScrBytes *src = scr_bytes_new(SCR_BYTES_U8, 2);
  scr_bytes_set(src, 0, 7);
  scr_bytes_set(src, 1, 8);
  scr_bytes_set_from(b, src, 3);
  check_f64(scr_bytes_get(b, 3), 7, "set(src, 3)");
  check_f64(scr_bytes_get(b, 4), 8, "set(src, 3) second");
  check(!scr_exc_pending(), "in-bounds set does not throw");
  scr_bytes_set_from(b, src, 4); /* 2 + 4 > 5 */
  expect_pending("set(src, 4) overflows: RangeError");
  scr_bytes_release(src);

  ScrBytes *c = scr_bytes_copy(b);
  check_f64(scr_bytes_len(c), 5, "copy length");
  scr_bytes_set(c, 0, 42);
  check_f64(scr_bytes_get(b, 0), 1, "copy is independent");
  scr_bytes_release(c);
  scr_bytes_release(b);
}

static void test_encodings(void) {
  check_str(scr_str_from_utf8_lossy(NULL, 0), "", "empty native UTF-8 span");
  /* utf8 round-trip, astral included (U+1F4A9 + U+00E9). */
  ScrStr *utf8 = S("utf8");
  ScrStr *hex = S("hex");
  ScrStr *b64 = S("base64");
  ScrStr *poo = S("\xf0\x9f\x92\xa9\xc3\xa9");
  ScrBytes *b = scr_bytes_from_str(poo, utf8);
  check_f64(scr_bytes_len(b), 6, "utf8 byte length of astral pair");
  check_str(scr_bytes_to_str(b, hex), "f09f92a9c3a9", "toString hex");
  check_str(scr_bytes_to_str(b, utf8), "\xf0\x9f\x92\xa9\xc3\xa9", "utf8 round-trip");
  check_str(scr_bytes_to_str(b, b64), "8J+SqcOp", "toString base64");
  scr_bytes_release(b);
  scr_str_release(poo);

  /* hex decode: lenient — stops at the first invalid pair / odd tail. */
  ScrStr *lenient = S("a1g2");
  b = scr_bytes_from_str(lenient, hex);
  check_f64(scr_bytes_len(b), 1, "hex stops at invalid pair");
  check_f64(scr_bytes_get(b, 0), 0xa1, "hex first pair");
  scr_bytes_release(b);
  scr_str_release(lenient);

  /* base64 decode: whitespace/'='-lenient; padded round-trip. */
  ScrStr *spaced = S("aGV s bG8=??");
  b = scr_bytes_from_str(spaced, b64);
  check_str(scr_bytes_to_str(b, utf8), "hello", "base64 lenient decode");
  scr_bytes_release(b);
  scr_str_release(spaced);

  /* Invalid utf8 → U+FFFD per maximal subpart (Node/WHATWG-exact):
   * surrogate bytes decode to one replacement PER BYTE; a truncated
   * 4-byte lead is ONE replacement. */
  ScrStr *sur = S("eda0bd");
  b = scr_bytes_from_str(sur, hex);
  check_str(scr_bytes_to_str(b, utf8), "\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd",
            "surrogate bytes -> 3 replacements");
  scr_bytes_release(b);
  scr_str_release(sur);
  ScrStr *trunc4 = S("f09f92");
  b = scr_bytes_from_str(trunc4, hex);
  check_str(scr_bytes_to_str(b, utf8), "\xef\xbf\xbd", "truncated lead -> 1 replacement");
  scr_bytes_release(b);
  scr_str_release(trunc4);

  /* Bytes with a NUL are preserved (binary-safe). */
  ScrStr *withNul = S("00ff00");
  b = scr_bytes_from_str(withNul, hex);
  check_f64(scr_bytes_get(b, 0), 0, "NUL byte");
  check_f64(scr_bytes_get(b, 1), 255, "0xff byte");
  check_str(scr_bytes_to_str(b, hex), "00ff00", "binary-safe hex round-trip");
  scr_bytes_release(b);
  scr_str_release(withNul);

  scr_str_release(utf8);
  scr_str_release(hex);
  scr_str_release(b64);
}

/* The length of the well-formed WTF-8 sequence at in[i], or 0. */
static size_t ref_seq_len(const uint8_t *in, size_t n, size_t i) {
  uint8_t b = in[i];
  if (b < 0x80) return 1;
  size_t len;
  uint8_t lo = 0x80, hi = 0xbf;
  if (b >= 0xc2 && b <= 0xdf) len = 2;
  else if (b >= 0xe0 && b <= 0xef) len = 3;
  else if (b >= 0xf0 && b <= 0xf4) len = 4;
  else return 0;
  if (b == 0xe0) lo = 0xa0;
  if (b == 0xf0) lo = 0x90;
  if (b == 0xf4) hi = 0x8f;
  if (n - i < len || in[i + 1] < lo || in[i + 1] > hi) return 0;
  for (size_t k = 2; k < len; k++)
    if ((in[i + k] & 0xc0) != 0x80) return 0;
  return len;
}

/* The UTF-16 units of string storage, one at a time: a well-formed
 * sequence gives its code point's units and any other byte stands for
 * U+0000..U+00FF (a raw HTTP header byte). */
static size_t ref_units(const uint8_t *in, size_t n, uint16_t *out) {
  size_t k = 0;
  for (size_t i = 0; i < n;) {
    size_t len = ref_seq_len(in, n, i);
    if (len == 0) {
      out[k++] = in[i++];
      continue;
    }
    uint32_t cp = len == 1 ? in[i] : (uint32_t)(in[i] & (0x7f >> len));
    for (size_t j = 1; j < len; j++) cp = (cp << 6) | (in[i + j] & 0x3f);
    i += len;
    if (cp > 0xffff) {
      out[k++] = (uint16_t)(0xd800 + ((cp - 0x10000) >> 10));
      out[k++] = (uint16_t)(0xdc00 + ((cp - 0x10000) & 0x3ff));
    } else {
      out[k++] = (uint16_t)cp;
    }
  }
  return k;
}

/* Encodes storage that is not well-formed (raw header bytes become string
 * storage unchecked) and compares latin1, ascii and utf16le with the
 * reference; hex and base64 decode the latin1 bytes. ASan checks that no
 * path reads or writes outside either buffer. */
/* encs: latin1, ascii, utf16le, hex, base64. */
static void check_raw_encodings(ScrStr *const *encs, const uint8_t *in, size_t n, const char *what) {
  ScrStr *latin1 = encs[0], *ascii = encs[1], *utf16le = encs[2], *hex = encs[3], *b64 = encs[4];
  ScrStr *s = scr_str_new((const char *)in, n);
  uint16_t units[64];
  size_t k = ref_units(in, n, units);
  ScrStr *narrow[] = {latin1, ascii};
  for (size_t e = 0; e < 2; e++) {
    ScrBytes *b = scr_bytes_from_str(s, narrow[e]);
    bool ok = b->len == k;
    for (size_t j = 0; ok && j < k; j++) ok = b->data[j] == (uint8_t)units[j];
    check(ok, what);
    scr_bytes_release(b);
  }
  ScrBytes *wide = scr_bytes_from_str(s, utf16le);
  bool ok = wide->len == 2 * k;
  for (size_t j = 0; ok && j < k; j++)
    ok = wide->data[2 * j] == (uint8_t)units[j] && wide->data[2 * j + 1] == units[j] >> 8;
  check(ok, what);
  scr_bytes_release(wide);
  scr_bytes_release(scr_bytes_from_str(s, hex));
  scr_bytes_release(scr_bytes_from_str(s, b64));
  scr_str_release(s);
}

static void test_raw_storage_encodings(void) {
  /* Each pattern at every offset in an eight-byte word, alone and followed
   * by ASCII, two-byte characters or more of the pattern. */
  static const struct { const char *bytes; size_t n; } patterns[] = {
      {"\x80", 1}, {"\x80\x81\xbf\x90", 4}, {"\xc3", 1}, {"\xc3\xa9", 2},
      {"\xc3\xa9\xc3", 3}, {"\xc0\x80\xc1\xbf", 4}, {"\xe9\x41\xe9", 3},
      {"\xf0\x9f\x41", 3}, {"\xe2\x82", 2}, {"\xe2\x82\xac", 3},
      {"\xf0\x9f\x98\x80", 4}, {"\xed\xa0\x80", 3}, {"\xff\xfe\xf5", 3},
      {"\xdf\xbf\x80\x80", 4}, {"\xc2\x80\xc2", 3}, {"x\xe9y\x80\x80z\xdf", 7},
  };
  static const struct { const char *bytes; size_t n; } tails[] = {
      {"", 0}, {"bcdefghij", 9}, {"\xc3\xa9\xc3\xa9\xc3\xa9\xc3\xa9", 8}, {"\x80\xc3\xa9", 3},
  };
  ScrStr *encs[] = {S("latin1"), S("ascii"), S("utf16le"), S("hex"), S("base64")};
  uint8_t buf[64];
  char what[96];
  for (size_t p = 0; p < sizeof patterns / sizeof patterns[0]; p++) {
    for (size_t offset = 0; offset < 17; offset++) {
      for (size_t t = 0; t < sizeof tails / sizeof tails[0]; t++) {
        for (size_t lead = 0; lead < 2; lead++) {
          /* lead: the offset is two-byte characters instead of ASCII. */
          size_t n = 0;
          for (size_t j = 0; j < offset; j++) {
            if (lead && j + 1 < offset) {
              buf[n++] = 0xc3;
              buf[n++] = 0xa9;
              j++;
            } else {
              buf[n++] = 'a';
            }
          }
          memcpy(buf + n, patterns[p].bytes, patterns[p].n);
          n += patterns[p].n;
          memcpy(buf + n, tails[t].bytes, tails[t].n);
          n += tails[t].n;
          snprintf(what, sizeof what, "raw storage encodings: pattern %zu offset %zu tail %zu lead %zu",
                   p, offset, t, lead);
          check_raw_encodings(encs, buf, n, what);
        }
      }
    }
  }
  /* Random bytes, mostly high, of every length up to 40. */
  uint32_t seed = 12345;
  for (int round = 0; round < 4000; round++) {
    size_t n = (size_t)round % 41;
    for (size_t j = 0; j < n; j++) {
      seed = seed * 1103515245u + 12345u;
      uint8_t r = (uint8_t)(seed >> 16);
      buf[j] = (seed >> 27) & 1 ? (uint8_t)(0x80 | r) : (uint8_t)(r & 0x7f);
    }
    snprintf(what, sizeof what, "raw storage encodings: random round %d", round);
    check_raw_encodings(encs, buf, n, what);
  }
  for (size_t e = 0; e < sizeof encs / sizeof encs[0]; e++) scr_str_release(encs[e]);
}

static void test_concat_and_u32be(void) {
  ScrArr *list = scr_arr_new(SCR_ELEM_BYTES, 0);
  ScrBytes *a = scr_bytes_new(SCR_BYTES_U8, 2);
  scr_bytes_set(a, 0, 1);
  scr_bytes_set(a, 1, 2);
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, 1);
  scr_bytes_set(b, 0, 3);
  scr_arr_push_ref(list, a); /* moves in */
  scr_arr_push_ref(list, b);
  ScrBytes *cat = scr_bytes_concat(list);
  check_f64(scr_bytes_len(cat), 3, "concat length");
  check_f64(scr_bytes_get(cat, 2), 3, "concat order");
  scr_bytes_release(cat);
  scr_arr_release(list); /* releases a and b */

  ScrBytes *w = scr_bytes_new(SCR_BYTES_U8, 8);
  check_f64(scr_bytes_write_num(w, 0xdeadbeef, 1, SCR_BN_U32, false), 5,
            "writeUInt32BE returns offset+4");
  check_f64(scr_bytes_get(w, 1), 0xde, "BE byte order");
  check_f64(scr_bytes_get(w, 4), 0xef, "BE last byte");
  check_f64(scr_bytes_read_num(w, 1, SCR_BN_U32, false), 3735928559.0,
            "readUInt32BE round-trip");
  check(!scr_exc_pending(), "in-range u32be does not throw");
  scr_bytes_write_num(w, 4294967296.0, 0, SCR_BN_U32, false);
  expect_pending("writeUInt32BE value out of range throws");
  scr_bytes_write_num(w, 5, 5, SCR_BN_U32, false); /* > len - 4 */
  expect_pending("writeUInt32BE offset out of range throws");
  scr_bytes_read_num(w, -1, SCR_BN_U32, false);
  expect_pending("readUInt32BE negative offset throws");
  scr_bytes_read_num(w, 1.5, SCR_BN_U32, false);
  expect_pending("readUInt32BE fractional offset throws (an integer)");
  scr_bytes_release(w);

  ScrBytes *tiny = scr_bytes_new(SCR_BYTES_U8, 2);
  scr_bytes_read_num(tiny, 0, SCR_BN_U32, false);
  expect_pending("readUInt32BE on a <4-byte buffer throws");
  scr_bytes_release(tiny);

  /* The wider numeric families: sign extension, endianness, var widths. */
  ScrBytes *n = scr_bytes_new(SCR_BYTES_U8, 8);
  check_f64(scr_bytes_write_num(n, -2, 0, SCR_BN_I16, true), 2,
            "writeInt16LE returns offset+2");
  check_f64(scr_bytes_get(n, 0), 0xfe, "I16LE low byte");
  check_f64(scr_bytes_get(n, 1), 0xff, "I16LE high byte");
  check_f64(scr_bytes_read_num(n, 0, SCR_BN_I16, true), -2, "readInt16LE round-trip");
  check_f64(scr_bytes_read_num(n, 0, SCR_BN_U16, true), 65534, "readUInt16LE view");
  check_f64(scr_bytes_write_num(n, 1.5, 0, SCR_BN_F64, false), 8,
            "writeDoubleBE returns offset+8");
  check_f64(scr_bytes_read_num(n, 0, SCR_BN_F64, false), 1.5, "readDoubleBE round-trip");
  check_f64(scr_bytes_write_var(n, -1, 0, 6, true, true), 6,
            "writeIntLE(-1, 0, 6) returns 6");
  check_f64(scr_bytes_read_var(n, 0, 6, true, true), -1, "readIntLE(0, 6) sign-extends");
  check_f64(scr_bytes_read_var(n, 0, 6, false, true), 281474976710655.0,
            "readUIntLE(0, 6) full width");
  check(!scr_exc_pending(), "in-range numeric family does not throw");
  scr_bytes_read_var(n, 0, 7, false, true);
  expect_pending("readUIntLE byteLength 7 throws");
  scr_bytes_write_var(n, 256, 0, 1, false, true);
  expect_pending("writeUIntLE(256, 0, 1) value throws");
  scr_bytes_release(n);
}

static void test_from_arr_and_random(void) {
  ScrArr *arr = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(arr, 1);
  scr_arr_push_f64(arr, 2.7);
  scr_arr_push_f64(arr, -1);
  scr_arr_push_f64(arr, 256);
  ScrBytes *b = scr_bytes_from_arr(SCR_BYTES_U8, arr);
  check_f64(scr_bytes_get(b, 1), 2, "from_arr truncates");
  check_f64(scr_bytes_get(b, 2), 255, "from_arr wraps negatives");
  check_f64(scr_bytes_get(b, 3), 0, "from_arr wraps 256");
  scr_bytes_release(b);
  scr_arr_release(arr);

  ScrBytes *r = scr_crypto_random_bytes(16);
  check_f64(scr_bytes_len(r), 16, "randomBytes(16) length");
  scr_bytes_release(r);
  r = scr_crypto_random_bytes(-1);
  check(r == NULL, "randomBytes(-1) returns NULL");
  expect_pending("randomBytes(-1) throws RangeError");
}

static void test_zlib_roundtrip(void) {
  ScrStr *utf8 = S("utf8");
  ScrStr *text = S("hello hello hello hello compression works works works");
  ScrBytes *raw = scr_bytes_from_str(text, utf8);
  ScrBytes *packed = scr_zlib_deflate(raw);
  check(packed->len > 0 && packed->len < raw->len, "deflate shrinks repetitive input");
  check_f64(scr_bytes_get(packed, 0), 0x78, "zlib header first byte");
  ScrBytes *back = scr_zlib_inflate(packed);
  check(back->len == raw->len && memcmp(back->data, raw->data, raw->len) == 0,
        "deflate/inflate round-trip");
  scr_bytes_release(back);

  /* Corrupt input throws catchably. */
  ScrBytes *junk = scr_bytes_copy(raw);
  check(!scr_exc_pending(), "clean before corrupt inflate");
  ScrBytes *bad = scr_zlib_inflate(junk);
  check(bad == NULL, "inflate of junk returns NULL");
  expect_pending("inflate of junk throws");
  scr_bytes_release(junk);

  /* Truncated input throws too. */
  ScrBytes *cut = scr_bytes_slice(packed, 0, (double)(packed->len - 4));
  bad = scr_zlib_inflate(cut);
  check(bad == NULL, "inflate of truncated returns NULL");
  expect_pending("inflate of truncated throws");
  scr_bytes_release(cut);

  scr_bytes_release(packed);
  scr_bytes_release(raw);
  scr_str_release(text);
  scr_str_release(utf8);
}

static void test_fs_roundtrip(const char *scratch) {
  char pathbuf[1024];
  snprintf(pathbuf, sizeof pathbuf, "%s/bytes-roundtrip.bin", scratch);
  ScrStr *path = S(pathbuf);
  /* Binary-safe: a NUL and non-utf8 sequences survive the round trip. */
  ScrStr *hex = S("hex");
  ScrStr *blob = S("00ff80eda0bd0a");
  ScrBytes *data = scr_bytes_from_str(blob, hex);
  scr_fs_write_file_bytes(path, data);
  check(!scr_exc_pending(), "write_file_bytes succeeds");
  ScrBytes *back = scr_fs_read_file_bytes(path);
  check(!scr_exc_pending(), "read_file_bytes succeeds");
  check(back->len == data->len && memcmp(back->data, data->data, data->len) == 0,
        "fs round-trip is byte-exact");
  scr_bytes_release(back);

  /* The UTF-8 read decodes in place: each maximal malformed subpart (ff,
   * 80, ed, a0, bd) becomes U+FFFD. */
  ScrStr *utf8 = S("utf8");
  ScrStr *upper = S("UTF-8");
  static const char repaired[] =
      "\0\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd\n";
  ScrStr *forms[2] = { scr_fs_read_file_encoded(path, utf8), scr_fs_read_file(path) };
  for (int i = 0; i < 2; i++) {
    check(forms[i]->len == sizeof repaired - 1 && memcmp(forms[i]->data, repaired, sizeof repaired - 1) == 0,
          i == 0 ? "utf8 file read replaces malformed bytes"
                 : "promise-form utf8 read replaces malformed bytes");
    scr_str_release(forms[i]);
  }
  ScrStr *latin = S("caf\xc3\xa9 \xef\xbb\xbf");
  scr_fs_write_file(path, latin);
  ScrStr *read_back = scr_fs_read_file_encoded(path, upper);
  check(read_back->len == latin->len && memcmp(read_back->data, latin->data, latin->len) == 0 &&
            !scr_str_known_ascii(read_back),
        "well-formed utf8 file reads back unchanged");
  scr_str_release(read_back);
  ScrStr *plain = S("plain ascii text that spans more than one thirty-two byte chunk");
  scr_fs_write_file(path, plain);
  read_back = scr_fs_read_file_encoded(path, utf8);
  check(read_back->len == plain->len && memcmp(read_back->data, plain->data, plain->len) == 0 &&
            scr_str_known_ascii(read_back),
        "ascii file read records the ASCII fact");
  scr_str_release(read_back);
  ScrStr *empty = S("");
  scr_fs_write_file(path, empty);
  check_str(scr_fs_read_file_encoded(path, utf8), "", "empty utf8 file read");
  scr_str_release(empty);
  scr_str_release(plain);
  scr_str_release(latin);
  scr_str_release(upper);
  scr_str_release(utf8);

  scr_bytes_release(data);
  scr_str_release(blob);
  scr_str_release(hex);
  scr_str_release(path);

  ScrStr *missing = S("/nonexistent-scriptc-test/nope.bin");
  ScrBytes *none = scr_fs_read_file_bytes(missing);
  check(none == NULL, "read of missing file returns NULL");
  expect_pending("read of missing file throws ENOENT");
  scr_str_release(missing);
}

static void test_rc(void) {
#ifdef SCR_RC_AUDIT
  long before = scr_bytes_live_count();
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, 4);
  ScrBytes *c = scr_bytes_retain(b);
  check(scr_bytes_live_count() == before + 1, "retain does not allocate");
  scr_bytes_release(c);
  check(scr_bytes_live_count() == before + 1, "one release keeps it live");
  scr_bytes_release(b);
  check(scr_bytes_live_count() == before, "second release frees");

  /* An array of bytes releases its elements recursively. */
  ScrArr *arr = scr_arr_new(SCR_ELEM_BYTES, 0);
  scr_arr_push_ref(arr, scr_bytes_new(SCR_BYTES_U8, 1));
  scr_arr_push_ref(arr, scr_bytes_new(SCR_BYTES_U8, 2));
  check(scr_bytes_live_count() == before + 2, "two live in the array");
  ScrBytes *got = scr_arr_get_ref(arr, 0); /* +1 */
  scr_arr_release(arr);
  check(scr_bytes_live_count() == before + 1, "array release frees unshared element");
  scr_bytes_release(got);
  check(scr_bytes_live_count() == before, "shared element frees on last release");
#endif
}

int main(int argc, char **argv) {
  if (argc > 1 && strncmp(argv[1], "--crash-", 8) == 0) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, 1);
    if (strcmp(argv[1], "--crash-get-oob") == 0) {
      scr_bytes_get(b, 1);
    } else if (strcmp(argv[1], "--crash-get-frac") == 0) {
      scr_bytes_get(b, 0.5);
    } else {
      fprintf(stderr, "unknown mode %s\n", argv[1]);
      return 2;
    }
    fprintf(stderr, "expected a trap, still alive\n");
    return 2;
  }
  if (argc != 2) {
    fprintf(stderr, "usage: test_bytes <scratch-dir> | --crash-*\n");
    return 2;
  }

  test_construction();
  test_coercion_matrix();
  test_slice_set_copy();
  scr_bytes_test_bulk_storage();
  scr_bytes_test_buffer_pool();
  test_encodings();
  test_raw_storage_encodings();
  test_concat_and_u32be();
  test_from_arr_and_random();
  test_zlib_roundtrip();
  test_fs_roundtrip(argv[1]);
  test_rc();

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
