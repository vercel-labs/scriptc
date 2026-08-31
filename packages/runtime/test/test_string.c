/* Oracle test for the string methods.
 * Reads case lines ("<op>\t<input-hex>\t<args>\t<expected-hex>\n", "-" for
 * an empty hex field — see gen-string-cases.mjs) from the file given as
 * argv[1] (or stdin), runs each operation, and asserts byte equality.
 * Numeric/boolean results are compared through scr_f64_to_str /
 * "true"/"false", so the expected column is always UTF-8 bytes.
 *
 * Also contains hand-written assertions for the documented divergence
 * (charAt / slice on half an astral pair -> U+FFFD instead of a lone
 * surrogate), even though the oracle covers them too via Buffer.from's
 * identical replacement behavior.
 *
 * Special mode: --crash-repeat / --crash-repeat-inf call
 * scr_str_repeat with an invalid count and must abort() after printing
 * "scriptc: RangeError: Invalid count value" (checked by string.test.ts).
 *
 * Exit 0 = all pass; prints each mismatch (capped) and exits 1 otherwise.
 */
#include "../src/scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void); /* provided by scr_string.c */
#endif

#ifdef SCR_SIDX_TEST
/* Test-only sparse-index observability, deliberately absent from the normal
 * runtime ABI. The walker count is code-point steps after a cache prime. */
void scr_sidx_test_reset_steps(void);
size_t scr_sidx_test_walk_steps(void);
void scr_sidx_test_reset_cache(void);
size_t scr_sidx_test_entries(void);
size_t scr_sidx_test_points(void);
#endif

#define MAX_FIELD 8192

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Decode "<hex>" or "-" (empty) into out; returns length or (size_t)-1. */
static size_t hex_decode(const char *hex, char *out) {
  if (strcmp(hex, "-") == 0) return 0;
  size_t n = strlen(hex);
  if (n % 2 != 0 || n / 2 > MAX_FIELD) return (size_t)-1;
  for (size_t i = 0; i < n; i += 2) {
    int hi = hex_val(hex[i]), lo = hex_val(hex[i + 1]);
    if (hi < 0 || lo < 0) return (size_t)-1;
    out[i / 2] = (char)((hi << 4) | lo);
  }
  return n / 2;
}

static void hex_print(FILE *f, const char *bytes, size_t len) {
  if (len == 0) {
    fputc('-', f);
    return;
  }
  for (size_t i = 0; i < len; i++)
    fprintf(f, "%02x", (unsigned char)bytes[i]);
}

static long total = 0, failed = 0;

static void check(const char *op, const char *args, ScrStr *input,
                  const char *got, size_t got_len, const char *expected,
                  size_t expected_len) {
  total++;
  if (got_len == expected_len && memcmp(got, expected, got_len) == 0) return;
  failed++;
  if (failed <= 20) {
    fprintf(stderr, "MISMATCH %s(", op);
    hex_print(stderr, input->data, input->len);
    fprintf(stderr, " ; %s) expected=", args);
    hex_print(stderr, expected, expected_len);
    fprintf(stderr, " got=");
    hex_print(stderr, got, got_len);
    fputc('\n', stderr);
  }
}

static void check_f64(const char *op, const char *args, ScrStr *input,
                      double got, const char *expected, size_t expected_len) {
  char buf[32];
  size_t len = scr_f64_to_str(got, buf);
  check(op, args, input, buf, len, expected, expected_len);
}

static void check_bool(const char *op, const char *args, ScrStr *input,
                       bool got, const char *expected, size_t expected_len) {
  const char *s = got ? "true" : "false";
  check(op, args, input, s, strlen(s), expected, expected_len);
}

/* Consumes (releases) the +1 result. */
static void check_str(const char *op, const char *args, ScrStr *input,
                      ScrStr *got, const char *expected, size_t expected_len) {
  if (got->data[got->len] != '\0') {
    failed++;
    fprintf(stderr, "MISSING NUL TERMINATOR after %s result\n", op);
  }
  check(op, args, input, got->data, got->len, expected, expected_len);
  scr_str_release(got);
}

/* Hand-written assertions for the documented lone-surrogate divergence:
 * boundaries inside the astral pair of "a\u{1F600}b" produce U+FFFD where
 * JS would produce "\uD83D" / "\uDE00". */
static void divergence_asserts(void) {
  static const char FFFD[] = "\xEF\xBF\xBD";
  ScrStr *s = scr_str_new("a\xF0\x9F\x98\x80" "b", 6); /* a 😀 b */

  ScrStr *hi = scr_str_char_at(s, 1); /* JS: "\uD83D" */
  check("charAt-divergence", "1", s, hi->data, hi->len, FFFD, 3);
  scr_str_release(hi);

  ScrStr *lo = scr_str_char_at(s, 2); /* JS: "\uDE00" */
  check("charAt-divergence", "2", s, lo->data, lo->len, FFFD, 3);
  scr_str_release(lo);

  ScrStr *head = scr_str_slice(s, 0, 2); /* JS: "a\uD83D" */
  check("slice-divergence", "0,2", s, head->data, head->len,
        "a\xEF\xBF\xBD", 4);
  scr_str_release(head);

  ScrStr *tail = scr_str_slice(s, 2, 4); /* JS: "\uDE00b" */
  check("slice-divergence", "2,4", s, tail->data, tail->len,
        "\xEF\xBF\xBD" "b", 4);
  scr_str_release(tail);

  ScrStr *mid = scr_str_slice(s, 2, 3); /* JS: "\uDE00" */
  check("slice-divergence", "2,3", s, mid->data, mid->len, FFFD, 3);
  scr_str_release(mid);

  /* both boundaries split different pairs: "😀😀".slice(1,3) */
  ScrStr *two = scr_str_new("\xF0\x9F\x98\x80\xF0\x9F\x98\x80", 8);
  ScrStr *both = scr_str_slice(two, 1, 3); /* JS: "\uDE00\uD83D" */
  check("slice-divergence", "1,3", two, both->data, both->len,
        "\xEF\xBF\xBD\xEF\xBF\xBD", 6);
  scr_str_release(both);

  /* numeric results do NOT diverge: exact surrogate values */
  check_f64("charCodeAt-surrogate", "1", s, scr_str_char_code_at(s, 1),
            "55357", 5); /* 0xD83D */
  check_f64("charCodeAt-surrogate", "2", s, scr_str_char_code_at(s, 2),
            "56832", 5); /* 0xDE00 */

  scr_str_release(two);
  scr_str_release(s);
}

/* Model the compiler's canonical `s = s + suffix` ownership handoff. The
 * retained snapshot survives suffix evaluation; the binding then gives up
 * whichever value it currently holds, and concat returns the new binding
 * value. The snapshot's release balances concat's second reference when it
 * appends in place. */
static void handoff_append(ScrStr **binding, ScrStr *suffix) {
  ScrStr *snapshot = scr_str_retain(*binding);
  ScrStr *old = *binding;
  *binding = NULL;
  scr_str_release(old);
  *binding = scr_str_concat(snapshot, suffix);
  scr_str_release(snapshot);
}

static void accumulation_asserts(void) {
  ScrStr *piece = scr_str_new("x", 1);
  ScrStr *acc = scr_str_new("", 0);
  size_t relocations = 0;
  enum { APPENDS = 8192 };
  for (size_t i = 0; i < APPENDS; i++) {
    ScrStr *before = acc;
    handoff_append(&acc, piece);
    if (acc != before) relocations++;
  }
  if (acc->len != APPENDS || relocations > 2 + 2 * 13) {
    failed++;
    fprintf(stderr, "ACCUMULATION: len=%zu relocations=%zu\n", acc->len,
            relocations);
  }
  scr_str_release(acc);
  scr_str_release(piece);

  /* A real alias keeps rc > 1, so concat copies and the alias sees its old
   * bytes. Prime slack first to ensure this checks ownership rather than an
   * unavoidable first growth. */
  ScrStr *seed = scr_str_new("seed", 4);
  ScrStr *x = scr_str_new("x", 1);
  handoff_append(&seed, x);
  ScrStr *alias = scr_str_retain(seed);
  ScrStr *before = seed;
  ScrStr *bang = scr_str_new("!", 1);
  handoff_append(&seed, bang);
  if (seed == alias || alias != before || alias->len != 5 ||
      memcmp(alias->data, "seedx", 5) != 0 || seed->len != 6 ||
      memcmp(seed->data, "seedx!", 6) != 0) {
    failed++;
    fprintf(stderr, "ACCUMULATION: alias was mutated or not copied\n");
  }
  scr_str_release(bang);
  scr_str_release(alias);
  scr_str_release(seed);
  scr_str_release(x);

  /* Populate the UTF-16 cache, then take an in-place multibyte append. The
   * cached length must be invalidated while its byte/unit cursor remains a
   * valid prefix cursor. */
  ScrStr *unicode = scr_str_new("\xC3\xA9", 2); /* é */
  handoff_append(&unicode, x = scr_str_new("x", 1));
  (void)scr_str_utf16_len(unicode); /* cache: éx is two UTF-16 units */
  ScrStr *astral = scr_str_new("\xF0\x9F\x98\x80", 4); /* 😀 */
  ScrStr *unicode_before = unicode;
  handoff_append(&unicode, astral);
  if (unicode != unicode_before || scr_str_utf16_len(unicode) != 4) {
    failed++;
    fprintf(stderr, "ACCUMULATION: UTF-16 cache was not invalidated\n");
  }
  scr_str_release(astral);
  scr_str_release(x);
  scr_str_release(unicode);

  /* A sparse-indexed non-ASCII prefix must survive in-place appends: old
   * prefix checkpoints remain safe while length/end facts extend lazily. */
  static const char mixed[] = "\xC3\xA9\xF0\x9F\x98\x80"; /* é😀: 3 units */
  ScrStr *large = scr_str_new(mixed, sizeof(mixed) - 1);
  ScrStr *many = scr_str_repeat(large, 12000); /* 72 KiB: sparse-indexed */
  ScrStr *tail_x = scr_str_new("x", 1);
  handoff_append(&many, tail_x); /* first growth creates spare capacity */
  size_t old_units = (size_t)scr_str_utf16_len(many);
  ScrStr *han = scr_str_new("\xE4\xB8\xAD", 3); /* 中 */
  ScrStr *face = scr_str_new("\xF0\x9F\x98\x80", 4); /* 😀 */
  ScrStr *many_before = many;
#ifdef SCR_SIDX_TEST
  scr_sidx_test_reset_steps();
#endif
  handoff_append(&many, han);
  handoff_append(&many, face);
  if (many != many_before || scr_str_utf16_len(many) != old_units + 3 ||
      scr_str_char_code_at(many, (double)(old_units - 1)) != 120.0 ||
      scr_str_char_code_at(many, (double)old_units) != 0x4E2D ||
      scr_str_char_code_at(many, (double)(old_units + 1)) != 0xD83D ||
      scr_str_char_code_at(many, (double)(old_units + 2)) != 0xDE00) {
    failed++;
    fprintf(stderr, "ACCUMULATION: sparse UTF-16 index did not extend\n");
  }
#ifdef SCR_SIDX_TEST
  /* The former end is now an internal anchor, so these boundary lookups do
   * not walk back through the final pre-append checkpoint interval. */
  if (scr_sidx_test_walk_steps() > 8) {
    failed++;
    fprintf(stderr, "ACCUMULATION: append discarded its boundary checkpoint\n");
  }
#endif
  scr_str_release(face);
  scr_str_release(han);
  scr_str_release(tail_x);
  scr_str_release(many);
  scr_str_release(large);
}

#ifdef SCR_SIDX_TEST
static void sidx_fail(const char *what) {
  failed++;
  fprintf(stderr, "SIDX: %s\n", what);
}

/* The counter is deliberately about code-point decoder steps, not elapsed
 * time. After length primes sparse anchors, alternating distant UTF-16
 * operations must stay proportional to query count × the 4 KiB stride. */
static void sparse_index_asserts(void) {
  enum { REPS = 24000, QUERIES = 48 };
  static const char piece[] = "a\xC3\xA9\xF0\x9F\x98\x80" "e\xCC\x81";
  static const double codes[] = {97, 233, 0xD83D, 0xDE00, 101, 769};
  size_t bytes = (sizeof(piece) - 1) * (size_t)REPS;
  char *raw = malloc(bytes);
  if (!raw) { sidx_fail("test allocation"); return; }
  for (size_t i = 0; i < REPS; i++)
    memcpy(raw + i * (sizeof(piece) - 1), piece, sizeof(piece) - 1);
  ScrStr *s = scr_str_new(raw, bytes);
  free(raw);
  ScrStr *face = scr_str_new("\xF0\x9F\x98\x80", 4);
  ScrStr *e_face = scr_str_new("\xC3\xA9\xF0\x9F\x98\x80", 6);
  size_t units = (size_t)scr_str_utf16_len(s);
  if (units != (size_t)REPS * 6) sidx_fail("large mixed length");
  scr_sidx_test_reset_steps();

  for (size_t q = 0; q < QUERIES; q++) {
    size_t rep = (q * 7919) % REPS;
    size_t base = rep * 6;
    size_t unit = base + (q % 6);
    if (scr_str_char_code_at(s, (double)unit) != codes[q % 6])
      sidx_fail("charCodeAt result");

    ScrStr *ch = scr_str_char_at(s, (double)(base + 2));
    if (ch->len != 3 || memcmp(ch->data, "\xEF\xBF\xBD", 3) != 0)
      sidx_fail("charAt surrogate result");
    scr_str_release(ch);

    ScrStr *slice = scr_str_slice(s, (double)(base + 1), (double)(base + 4));
    if (slice->len != 6 || memcmp(slice->data, e_face->data, 6) != 0)
      sidx_fail("slice result");
    scr_str_release(slice);

    ScrStr *sub = scr_str_substring(s, (double)(base + 2), (double)(base + 4));
    if (sub->len != 4 || memcmp(sub->data, face->data, 4) != 0)
      sidx_fail("substring result");
    scr_str_release(sub);

    if (scr_str_index_of(s, e_face, (double)base) != (double)(base + 1))
      sidx_fail("positioned indexOf result");
    if (scr_str_last_index_of(s, face) != (double)((REPS - 1) * 6 + 2))
      sidx_fail("lastIndexOf result");
  }
  /* Each query maps at most a handful of locations. A mapping walks no
   * farther than the 4 KiB interval plus a small UTF-8-boundary margin. */
  if (scr_sidx_test_walk_steps() > (size_t)QUERIES * 8 * 4200)
    sidx_fail("non-local lookup exceeded sparse stride bound");

  /* Sparse state has fixed four-entry residency by design. A fifth large
   * receiver evicts one entry (rather than joining an unbounded registry),
   * and release/address reuse clear only the bounded table. */
  ScrStr *live[5];
  for (size_t i = 0; i < 5; i++) {
    live[i] = scr_str_new(piece, sizeof(piece) - 1);
    ScrStr *grown = scr_str_repeat(live[i], 7000);
    scr_str_release(live[i]);
    live[i] = grown;
    (void)scr_str_utf16_len(live[i]);
  }
  if (scr_sidx_test_entries() != 4 || scr_sidx_test_points() == 0)
    sidx_fail("five live sparse indexes did not evict to four entries");
  /* Fresh tiny indexed calls use the separate cursor tier. They must not
   * evict the four warmed sparse entries merely because the short receivers
   * happen to have different addresses on every iteration. */
  for (size_t i = 0; i < 4096; i++) {
    ScrStr *tiny = scr_str_new("x", 1);
    if (scr_str_utf16_len(tiny) != 1.0 ||
        scr_str_char_code_at(tiny, 0) != 120.0)
      sidx_fail("tiny indexed operation result");
    scr_str_release(tiny);
  }
  if (scr_sidx_test_entries() != 4 || scr_sidx_test_points() == 0)
    sidx_fail("tiny indexed operations evicted sparse entries");
  scr_sidx_test_reset_steps();
  for (size_t q = 0; q < QUERIES; q++) {
    /* Mirror ordinary production traffic: each far lookup has one fresh,
     * tiny indexed receiver immediately before it. The sparse points must
     * remain resident throughout, not merely survive a release-only churn. */
    ScrStr *tiny = scr_str_new("x", 1);
    if (scr_str_utf16_len(tiny) != 1.0 ||
        scr_str_char_code_at(tiny, 0) != 120.0)
      sidx_fail("interleaved tiny indexed operation result");
    scr_str_release(tiny);
    if (scr_str_char_code_at(live[1 + q % 4], 41999.0) != 769.0)
      sidx_fail("post-tiny sparse charCodeAt result");
    if (scr_sidx_test_points() == 0)
      sidx_fail("interleaved tiny operation discarded sparse checkpoints");
  }
  if (scr_sidx_test_walk_steps() > (size_t)QUERIES * 4200)
    sidx_fail("tiny indexed operations lost sparse stride bound");
  scr_str_release(live[4]);
  if (scr_sidx_test_entries() != 3) sidx_fail("release did not purge entry");
  ScrStr *reused = scr_str_alloc_raw((sizeof(piece) - 1) * 7000,
                                     (sizeof(piece) - 1) * 7000);
  for (size_t i = 0; i < 7000; i++)
    memcpy(reused->data + i * (sizeof(piece) - 1), piece, sizeof(piece) - 1);
  reused->data[reused->len] = '\0';
  if (scr_str_char_code_at(reused, 2) != 0xD83D) sidx_fail("reused address result");
  scr_str_release(reused);
  for (size_t i = 0; i < 4; i++) scr_str_release(live[i]);
  if (scr_sidx_test_entries() != 0) sidx_fail("all sparse entries did not purge");
  scr_str_release(e_face);
  scr_str_release(face);
  scr_str_release(s);
  scr_sidx_test_reset_cache();
}

/* Do not wait for the first non-ASCII byte before proving this access shape.
 * A string can have megabytes of ordinary ASCII followed by one emoji: no
 * `.length` prime is involved here, and alternating distant reads in that
 * prefix must retain identity checkpoints instead of repeatedly walking the
 * distance between the two hot-cursor positions. A lookup at the ASCII
 * prefix's far end must retain those checkpoints too; otherwise a later
 * non-local lookup silently falls back to a linear restart. */
static void sparse_ascii_prefix_asserts(void) {
  enum { PREFIX = 4 * 1024 * 1024, QUERIES = 8 };
  const size_t first = (size_t)1024 * 1024 + 137;
  const size_t second = (size_t)3 * 1024 * 1024 + 271;
  char *raw = malloc((size_t)PREFIX + 4);
  if (!raw) { sidx_fail("ASCII-prefix test allocation"); return; }
  memset(raw, 'a', PREFIX);
  memcpy(raw + PREFIX, "\xF0\x9F\x98\x80", 4); /* terminal emoji */
  ScrStr *s = scr_str_new(raw, (size_t)PREFIX + 4);
  free(raw);

  scr_sidx_test_reset_cache();
  scr_sidx_test_reset_steps();
  for (size_t q = 0; q < QUERIES; q++) {
    size_t at = q & 1 ? second : first;
    if (scr_str_char_code_at(s, (double)at) != 97.0)
      sidx_fail("ASCII-prefix charCodeAt result");
  }
  if (scr_sidx_test_points() == 0)
    sidx_fail("ASCII-prefix identity checkpoints were not retained");
  if (scr_sidx_test_walk_steps() > (size_t)QUERIES * 4200)
    sidx_fail("ASCII-prefix lookup exceeded sparse stride bound");

  /* This is still an ASCII character, but it is at the far end of the
   * prefix immediately before the terminal emoji. Completing the interval
   * must not mistake the prefix for a wholly ASCII string and discard the
   * anchors accumulated above. */
  if (scr_str_char_code_at(s, (double)(PREFIX - 1)) != 97.0)
    sidx_fail("ASCII-prefix end charCodeAt result");
  if (scr_sidx_test_points() == 0)
    sidx_fail("ASCII-prefix end lookup discarded checkpoints");

  scr_sidx_test_reset_steps();
  for (size_t q = 0; q < QUERIES; q++) {
    size_t at = q & 1 ? second : first;
    if (scr_str_char_code_at(s, (double)at) != 97.0)
      sidx_fail("ASCII-prefix warmed charCodeAt result");
  }
  if (scr_sidx_test_walk_steps() > (size_t)QUERIES * 4200)
    sidx_fail("ASCII-prefix end lookup lost sparse stride bound");

  scr_str_release(s);
  scr_sidx_test_reset_cache();
}

/* A far-end lookup initially has to scan an unknown all-ASCII string, but
 * that completed scan proves byte and UTF-16 offsets identical. It must not
 * then allocate the prefix checkpoints useful only for a still-unknown
 * ASCII prefix before non-ASCII content. */
static void sparse_all_ascii_end_asserts(void) {
  enum { BYTES = 4 * 1024 * 1024 };
  char *raw = malloc(BYTES);
  if (!raw) { sidx_fail("all-ASCII test allocation"); return; }
  memset(raw, 'z', BYTES);
  ScrStr *s = scr_str_new(raw, BYTES);
  free(raw);

  scr_sidx_test_reset_cache();
  if (scr_str_char_code_at(s, (double)(BYTES - 1)) != 122.0)
    sidx_fail("all-ASCII end charCodeAt result");
  if (scr_str_utf16_len(s) != (double)BYTES)
    sidx_fail("all-ASCII length result");
  if (scr_sidx_test_points() != 0)
    sidx_fail("all-ASCII end lookup retained checkpoints");

  scr_str_release(s);
  scr_sidx_test_reset_cache();
}

/* Crossing the sparse threshold is not necessarily what first introduces
 * non-ASCII data: a mixed 63KiB receiver can be length-indexed while still
 * small, then grow in place. The completed non-identity cache must
 * materialize every checkpoint interval at that transition rather than
 * retaining only the hot cursor or an old-end anchor. */
static void sparse_append_threshold_asserts(void) {
  enum { BEFORE = 32700, EXTRA = 200, QUERIES = 8 };
  ScrStr *eacute = scr_str_new("\xC3\xA9", 2);
  ScrStr *s = scr_str_repeat(eacute, BEFORE); /* 65,400 bytes: below 64KiB */
  ScrStr *one = scr_str_new("x", 1);
  handoff_append(&s, one); /* copy once to make slack, still below threshold */
  if (scr_str_utf16_len(s) != (double)(BEFORE + 1) ||
      scr_sidx_test_points() != 0) {
    sidx_fail("small mixed prefix unexpectedly indexed");
  }
  ScrStr *more = scr_str_repeat(eacute, EXTRA);
  handoff_append(&s, more); /* in-place non-ASCII threshold crossing */
  if (scr_str_utf16_len(s) != (double)(BEFORE + 1 + EXTRA) ||
      scr_sidx_test_points() == 0) {
    sidx_fail("mixed threshold append did not materialize checkpoints");
  }

  scr_sidx_test_reset_steps();
  for (size_t q = 0; q < QUERIES; q++) {
    size_t at = q & 1 ? (size_t)BEFORE - 1 : (size_t)BEFORE / 3;
    if (scr_str_char_code_at(s, (double)at) != 233.0)
      sidx_fail("mixed threshold append charCodeAt result");
  }
  if (scr_sidx_test_walk_steps() > (size_t)QUERIES * 4200)
    sidx_fail("mixed threshold append lost sparse stride bound");

  scr_str_release(more);
  scr_str_release(one);
  scr_str_release(s);
  scr_str_release(eacute);
  scr_sidx_test_reset_cache();
}
#endif

int main(int argc, char **argv) {
  if (argc > 1 && strncmp(argv[1], "--crash-repeat", 14) == 0) {
    ScrStr *s = scr_str_new("ab", 2);
    double count = strcmp(argv[1], "--crash-repeat-inf") == 0
                       ? (double)INFINITY
                       : -1.0;
    scr_str_repeat(s, count); /* must print RangeError and abort() */
    fputs("UNREACHABLE: scr_str_repeat returned\n", stderr);
    return 3;
  }

  FILE *in = stdin;
  if (argc > 1) {
    in = fopen(argv[1], "r");
    if (!in) {
      perror(argv[1]);
      return 2;
    }
  }

  static char linebuf[4 * MAX_FIELD];
  static char in_bytes[MAX_FIELD], needle_bytes[MAX_FIELD],
      expected_bytes[MAX_FIELD];

  while (fgets(linebuf, sizeof linebuf, in)) {
    linebuf[strcspn(linebuf, "\n")] = '\0';
    if (linebuf[0] == '\0') continue;

    /* split: op \t input-hex \t args \t expected-hex */
    char *op = linebuf;
    char *input_hex = strchr(op, '\t');
    if (!input_hex) goto badline;
    *input_hex++ = '\0';
    char *args = strchr(input_hex, '\t');
    if (!args) goto badline;
    *args++ = '\0';
    char *expected_hex = strchr(args, '\t');
    if (!expected_hex) goto badline;
    *expected_hex++ = '\0';

    size_t in_len = hex_decode(input_hex, in_bytes);
    size_t exp_len = hex_decode(expected_hex, expected_bytes);
    if (in_len == (size_t)-1 || exp_len == (size_t)-1) goto badline;

    ScrStr *input = scr_str_new(in_bytes, in_len);

    if (strcmp(op, "len") == 0) {
      check_f64(op, args, input, scr_str_utf16_len(input), expected_bytes,
                exp_len);
    } else if (strcmp(op, "charCodeAt") == 0) {
      check_f64(op, args, input, scr_str_char_code_at(input, strtod(args, NULL)),
                expected_bytes, exp_len);
    } else if (strcmp(op, "charAt") == 0) {
      check_str(op, args, input, scr_str_char_at(input, strtod(args, NULL)),
                expected_bytes, exp_len);
    } else if (strcmp(op, "slice") == 0) {
      char *comma = strchr(args, ',');
      if (!comma) goto badline_release;
      double a = strtod(args, NULL), b = strtod(comma + 1, NULL);
      check_str(op, args, input, scr_str_slice(input, a, b), expected_bytes,
                exp_len);
    } else if (strcmp(op, "repeat") == 0) {
      check_str(op, args, input, scr_str_repeat(input, strtod(args, NULL)),
                expected_bytes, exp_len);
    } else if (strcmp(op, "trim") == 0) {
      check_str(op, args, input, scr_str_trim(input), expected_bytes,
                exp_len);
    } else if (strcmp(op, "trimStart") == 0) {
      check_str(op, args, input, scr_str_trim_start(input), expected_bytes,
                exp_len);
    } else if (strcmp(op, "trimEnd") == 0) {
      check_str(op, args, input, scr_str_trim_end(input), expected_bytes,
                exp_len);
    } else if (strcmp(op, "parseInt") == 0) {
      check_f64(op, args, input, scr_parse_int(input, strtod(args, NULL)),
                expected_bytes, exp_len);
    } else if (strcmp(op, "split") == 0) {
      /* args = separator hex; expected = "<count>:<pieces joined by 0x01>" */
      size_t sep_len = hex_decode(args, needle_bytes);
      if (sep_len == (size_t)-1) goto badline_release;
      ScrStr *sep = scr_str_new(needle_bytes, sep_len);
      ScrArr *pieces = scr_str_split(input, sep);
      size_t count = (size_t)scr_arr_len(pieces);
      size_t cap = 32;
      for (size_t i = 0; i < count; i++) {
        ScrStr *p = (ScrStr *)scr_arr_get_ref(pieces, (double)i);
        cap += p->len + 1;
        scr_str_release(p);
      }
      char *joined = malloc(cap);
      size_t o = (size_t)snprintf(joined, 32, "%zu:", count);
      for (size_t i = 0; i < count; i++) {
        if (i > 0) joined[o++] = '\x01';
        ScrStr *p = (ScrStr *)scr_arr_get_ref(pieces, (double)i);
        memcpy(joined + o, p->data, p->len);
        o += p->len;
        scr_str_release(p);
      }
      check(op, args, input, joined, o, expected_bytes, exp_len);
      free(joined);
      scr_arr_release(pieces);
      scr_str_release(sep);
    } else if (strcmp(op, "padStart") == 0 || strcmp(op, "padEnd") == 0) {
      /* args = "<target>,<fill hex>" */
      char *comma = strchr(args, ',');
      if (!comma) goto badline_release;
      *comma = '\0';
      double target = strtod(args, NULL);
      size_t fill_len = hex_decode(comma + 1, needle_bytes);
      *comma = ','; /* restore for mismatch printing */
      if (fill_len == (size_t)-1) goto badline_release;
      ScrStr *fill = scr_str_new(needle_bytes, fill_len);
      ScrStr *got = strcmp(op, "padStart") == 0
                        ? scr_str_pad_start(input, target, fill)
                        : scr_str_pad_end(input, target, fill);
      check_str(op, args, input, got, expected_bytes, exp_len);
      scr_str_release(fill);
    } else if (strcmp(op, "indexOf") == 0) {
      char *comma = strchr(args, ',');
      if (!comma) goto badline_release;
      *comma = '\0';
      size_t nee_len = hex_decode(args, needle_bytes);
      if (nee_len == (size_t)-1) goto badline_release;
      double from = strtod(comma + 1, NULL);
      *comma = ','; /* restore for mismatch printing */
      ScrStr *needle = scr_str_new(needle_bytes, nee_len);
      check_f64(op, args, input, scr_str_index_of(input, needle, from),
                expected_bytes, exp_len);
      scr_str_release(needle);
    } else if (strcmp(op, "lastIndexOf") == 0) {
      size_t nee_len = hex_decode(args, needle_bytes);
      if (nee_len == (size_t)-1) goto badline_release;
      ScrStr *needle = scr_str_new(needle_bytes, nee_len);
      check_f64(op, args, input, scr_str_last_index_of(input, needle),
                expected_bytes, exp_len);
      scr_str_release(needle);
    } else if (strcmp(op, "includes") == 0 || strcmp(op, "startsWith") == 0 ||
               strcmp(op, "endsWith") == 0) {
      size_t nee_len = hex_decode(args, needle_bytes);
      if (nee_len == (size_t)-1) goto badline_release;
      ScrStr *needle = scr_str_new(needle_bytes, nee_len);
      bool got = op[0] == 'i'   ? scr_str_includes(input, needle)
                 : op[0] == 's' ? scr_str_starts_with(input, needle)
                                : scr_str_ends_with(input, needle);
      check_bool(op, args, input, got, expected_bytes, exp_len);
      scr_str_release(needle);
    } else {
      goto badline_release;
    }
    scr_str_release(input);
    continue;

  badline_release:
    scr_str_release(input);
  badline:
    failed++;
    fprintf(stderr, "BAD LINE: %s\n", op);
  }
  if (in != stdin) fclose(in);

  divergence_asserts();
  accumulation_asserts();
#ifdef SCR_SIDX_TEST
  sparse_index_asserts();
  sparse_ascii_prefix_asserts();
  sparse_all_ascii_end_asserts();
  sparse_append_threshold_asserts();
#endif

#ifdef SCR_RC_AUDIT
  if (scr_str_live_count() != 0) {
    fprintf(stderr, "RC AUDIT: %ld strings leaked\n", scr_str_live_count());
    failed++;
  }
#endif

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed ? 1 : 0;
}
