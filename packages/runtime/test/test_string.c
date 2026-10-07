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
size_t scr_sidx_test_searches(void);
void scr_sidx_test_reset_cache(void);
size_t scr_sidx_test_entries(void);
size_t scr_sidx_test_points(void);
size_t scr_sidx_test_active(void);
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

static void split_storage_asserts(void) {
  /* Cross the runtime's dense-storage boundary without allocating a
   * million distinct strings: each piece is the shared single-byte "a". */
  size_t boundary = (size_t)1 << 20, count = boundary + 3;
  char *bytes = malloc(count * 2 - 1);
  for (size_t i = 0; i < count; i++) {
    bytes[i * 2] = 'a';
    if (i + 1 < count) bytes[i * 2 + 1] = ',';
  }
  ScrStr *input = scr_str_new(bytes, count * 2 - 1);
  free(bytes);
  ScrStr *separator = scr_str_new(",", 1);
  ScrArr *parts = scr_str_split(input, separator);
  total++;
  if (parts->len != count) failed++;
  size_t positions[] = {0, boundary - 1, boundary, count - 1};
  for (size_t i = 0; i < sizeof positions / sizeof *positions; i++) {
    total++;
    if (!scr_arr_has(parts, positions[i])) { failed++; continue; }
    ScrStr *piece = scr_arr_get_ref(parts, positions[i]);
    check("split-storage", "dense/sparse", input, piece->data, piece->len, "a", 1);
    scr_str_release(piece);
  }
  scr_arr_release(parts);
  scr_str_release(separator);
  scr_str_release(input);
}

static void split_scratch_asserts(void) {
  _Static_assert(offsetof(ScrSplitCursor, offset) == 0, "split cursor offset");
  _Static_assert(offsetof(ScrSplitCursor, remaining) == sizeof(size_t), "split cursor limit");
  _Static_assert(offsetof(ScrSplitCursor, pending_unit) == sizeof(size_t) + 4, "split cursor pending unit");
  _Static_assert(sizeof(ScrSplitCursor) == sizeof(size_t) + 8, "split cursor storage");
  ScrStr *input = scr_str_new("alpha,beta-long,\xE4\xBD\xA0\xE5\xA5\xBD\xE4\xB8\x96\xE7\x95\x8C,test-tail,,last", 44);
  ScrStr *separator = scr_str_new(",", 1), *scratch = NULL;
  ScrSplitCursor cursor;
  scr_str_split_cursor_init(&cursor, UINT32_MAX);
  ScrStr *first = scr_str_split_cursor_next(input, separator, &cursor, &scratch);
  total++;
  if (first != scratch || first->rc != 2 || scr_str_utf16_len(first) != 5) failed++;
  scr_str_release(first);
  ScrStr *saved = scr_str_split_cursor_next(input, separator, &cursor, &scratch);
  total++;
  if (saved != first || scr_str_utf16_len(saved) != 9) failed++;
  /* Keep this yield alive: the next piece must allocate independent storage. */
  ScrStr *mixed = scr_str_split_cursor_next(input, separator, &cursor, &scratch);
  total++;
  if (mixed == saved || scr_str_utf16_len(mixed) != 4 ||
      saved->len != 9 || memcmp(saved->data, "beta-long", 9) != 0) failed++;
  scr_str_release(mixed);
  ScrStr *tail = scr_str_split_cursor_next(input, separator, &cursor, &scratch);
  total++;
  if (tail != mixed || scr_str_utf16_len(tail) != 9) failed++;
  scr_str_release(tail);
  while ((tail = scr_str_split_cursor_next(input, separator, &cursor, &scratch)))
    scr_str_release(tail);
  scr_str_release(saved);
  scr_str_release(scratch);
  scr_str_release(separator);
  scr_str_release(input);
}

static void construction_asserts(void) {
  ScrStr *empty = scr_str_new("", 0);
  ScrStr *value = scr_str_new("a\0\xE6\x97\xA5", 5);
  ScrStr *parts[] = {empty, value, empty, value};
  ScrStr *out = scr_str_concat_parts(parts, 4);
  total++;
  if (out->len != 10 || memcmp(out->data, value->data, 5) != 0 ||
      memcmp(out->data + 5, value->data, 5) != 0 || out->data[10] != '\0' ||
      value->rc != 1 || value->len != 5) {
    failed++;
    fputs("CONSTRUCTION: duplicate inputs, embedded zero or ownership\n", stderr);
  }
  scr_str_release(out);
  ScrStr *single = scr_str_concat_parts(parts, 3);
  ScrStr *left = scr_str_concat(empty, value);
  ScrStr *right = scr_str_concat(value, empty);
  total++;
  if (single != value || left != value || right != value || value->rc != 4) {
    failed++;
    fputs("CONSTRUCTION: empty operands must preserve independent owners\n", stderr);
  }
  scr_str_release(single);
  scr_str_release(left);
  scr_str_release(right);
  out = scr_str_concat_parts(NULL, 0);
  total++;
  if (out->len != 0 || out->data[0] != '\0') {
    failed++;
    fputs("CONSTRUCTION: empty part list\n", stderr);
  }
  scr_str_release(out);
  scr_str_release(value);
  scr_str_release(empty);
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

static void short_string_asserts(void) {
  // Scalar construction shares ASCII without allocating, including NUL.
  ScrStr *ascii = scr_str_from_char_code_one(65.9);
  ScrStr *wrapped = scr_str_from_char_code_one(65536 + 65);
  ScrStr *nul = scr_str_from_char_code_one(INFINITY);
  if (ascii != wrapped || ascii->rc != SIZE_MAX || ascii->len != 1 ||
      ascii->data[0] != 'A' || nul->len != 1 || nul->data[0] != 0) {
    failed++;
    fprintf(stderr, "SCALAR CHAR: ASCII cache or ToUint16 mismatch\n");
  }
  scr_str_release(ascii);
  scr_str_release(wrapped);
  scr_str_release(nul);

  ScrStr *unit = scr_str_from_char_code_one(0x2500);
  ScrStr *same = scr_str_from_char_code_one(0x2500);
  if (unit != same || unit->rc != 2 || unit->len != 3 ||
      memcmp(unit->data, "\xE2\x94\x80", 3) != 0) {
    failed++;
    fprintf(stderr, "SCALAR CHAR: Unicode sharing mismatch\n");
  }
  scr_str_release(unit);
  scr_str_release(same);

  ScrStr *source = scr_str_new("\xE2\x94\x80\xE2\x94\x80", 6);
  ScrStr *a = scr_str_char_at(source, 0);
  ScrStr *b = scr_str_char_at(source, 1);
  if (a != b || a->rc != 2) {
    failed++;
    fprintf(stderr, "SHORT: repeated Unicode character was not shared\n");
  }
  scr_str_release(a);
  scr_str_release(b);
  // Lookup after the last owner dies must never read a stale weak entry.
  for (int i = 0; i < 1000; i++) {
    ScrStr *c = scr_str_char_at(source, 0);
    if (c->len != 3 || memcmp(c->data, source->data, 3) != 0) failed++;
    scr_str_release(c);
  }
  // More live values than cache slots force collisions without invalidating
  // old owners. Embedded NULs are content, not terminators for the key.
  ScrStr *held[256];
  for (int i = 0; i < 256; i++) {
    char bytes[3] = {(char)('a' + i / 16), 0, (char)('a' + i % 16)};
    ScrStr *input = scr_str_new(bytes, 3);
    held[i] = scr_str_slice(input, 0, 3);
    scr_str_release(input);
  }
  for (int i = 0; i < 256; i++) {
    char bytes[3] = {(char)('a' + i / 16), 0, (char)('a' + i % 16)};
    if (held[i]->len != 3 || memcmp(held[i]->data, bytes, 3) != 0) failed++;
    scr_str_release(held[i]);
  }
  // Regrow may move the allocation. Append must also forget a cached key
  // before a uniquely owned string's bytes change.
  a = scr_str_char_at(source, 0);
  a = scr_str_regrow(a, 32);
  ScrStr *suffix = scr_str_new("x", 1);
  handoff_append(&a, suffix);
  b = scr_str_char_at(source, 0);
  if (a->len != 4 || b->len != 3 || memcmp(b->data, source->data, 3) != 0) failed++;
  // Sharing must preserve an observable alias across concat.
  ScrStr *alias = scr_str_char_at(source, 1);
  handoff_append(&b, suffix);
  if (alias->len != 3 || b->len != 4) failed++;
  scr_str_release(alias);
  scr_str_release(b);
  scr_str_release(a);
  scr_str_release(suffix);
  scr_str_release(source);
}

#ifdef SCR_SIDX_TEST
static void sidx_fail(const char *what) {
  failed++;
  fprintf(stderr, "SIDX: %s\n", what);
}

static void index_activity_asserts(void) {
  scr_sidx_test_reset_cache();
  ScrStr *strings[9];
  for (size_t i = 0; i < 9; i++) {
    strings[i] = scr_str_new("\xc3\xa9x", 3);
    if (scr_str_utf16_len(strings[i]) != 2) sidx_fail("cursor activation length");
    if (scr_sidx_test_active() != (i < 4 ? i + 1 : 4))
      sidx_fail("cursor activation or eviction count");
  }
  for (size_t i = 0; i < 9; i++) scr_str_release(strings[i]);
  if (scr_sidx_test_active() != 0) sidx_fail("last cursor release stayed active");
  ScrStr *s = scr_str_new("\xe4\xb8\xad", 3);
  (void)scr_str_utf16_len(s);
  scr_sidx_test_reset_cache();
  if (scr_sidx_test_active() != 0) sidx_fail("cache reset stayed active");
  if (scr_str_char_code_at(s, 0) != 0x4e2d || scr_sidx_test_active() != 1)
    sidx_fail("cache reactivation after reset");
  scr_str_release(s);
  if (scr_sidx_test_active() != 0) sidx_fail("reactivated cursor was not purged");
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
    if (scr_str_last_index_of_from(s, face, (double)(base + 3)) != (double)(base + 2))
      sidx_fail("positioned lastIndexOf result");
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
  scr_sidx_test_reset_cache();
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
      scr_sidx_test_points() == 0 || scr_sidx_test_active() != 1) {
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
  if (scr_sidx_test_active() != 0) sidx_fail("transferred sparse entry was not purged");
  scr_sidx_test_reset_cache();
}

/* Sequential, nearby and distant reads share one mixed receiver. The ASCII
 * span ends at different word alignments, followed by two surrogate pairs
 * and BMP characters; every code unit has an independent expected value. */
static void local_navigation_asserts(void) {
  enum { ASCII = 263, UNITS = ASCII + 7, REPS = 700 };
  static const char tail[] = "\xC3\xA9\xF0\x9F\x98\x80"
                             "\xE4\xB8\xAD\xF0\x9F\xA7\xAD\0";
  static const double codes[] = {233, 0xD83D, 0xDE00, 0x4E2D,
                                 0xD83E, 0xDDED, 0};
  char piece[ASCII + sizeof(tail) - 1];
  for (size_t i = 0; i < ASCII; i++) piece[i] = (char)('a' + i % 26);
  memcpy(piece + ASCII, tail, sizeof(tail) - 1);
  ScrStr *unit = scr_str_new(piece, sizeof(piece));
  ScrStr *s = scr_str_repeat(unit, REPS);
  scr_str_release(unit);
  scr_sidx_test_reset_cache();
  ScrStr *prefix = scr_str_new("abc", 3);
  if (scr_str_index_of(s, prefix, 0) != 0 ||
      !scr_str_starts_with_from(s, prefix, 0))
    sidx_fail("cold prefix search");
  if (scr_sidx_test_points() != 0)
    sidx_fail("prefix search indexed unrelated suffix");
  scr_str_release(prefix);
  if (scr_str_utf16_len(s) != UNITS * REPS) sidx_fail("local length");
  scr_sidx_test_reset_steps();
  for (size_t direction = 0; direction < 2; direction++) {
    for (size_t i = 0; i < UNITS * REPS; i++) {
      size_t at = direction ? UNITS * REPS - i - 1 : i;
      size_t offset = at % UNITS;
      double expected = offset < ASCII ? (double)('a' + offset % 26)
                                        : codes[offset - ASCII];
      if (scr_str_char_code_at(s, (double)at) != expected) {
        sidx_fail("local code unit");
        break;
      }
    }
  }
  if (scr_sidx_test_searches() > 2)
    sidx_fail("sequential reads repeatedly searched sparse index");
  for (size_t i = 0; i < 1024; i++) {
    size_t at = (i * 7919) % (UNITS * REPS);
    size_t offset = at % UNITS;
    double expected = offset < ASCII ? (double)('a' + offset % 26)
                                      : codes[offset - ASCII];
    if (scr_str_char_code_at(s, (double)at) != expected)
      sidx_fail("distant code unit");
    size_t start = at - offset;
    ScrStr *part = scr_str_substring(s, (double)(start + ASCII),
                                       (double)(start + UNITS));
    if (part->len != sizeof(tail) - 1 ||
        memcmp(part->data, tail, sizeof(tail) - 1) != 0)
      sidx_fail("distant substring");
    scr_str_release(part);
  }
  s = scr_str_regrow(s, s->len + 64);
  (void)scr_str_char_code_at(s, UNITS * (REPS - 1) + 17);
  ScrStr *suffix = scr_str_new("next", 4);
  handoff_append(&s, suffix);
  scr_str_release(suffix);
  if (scr_str_char_code_at(s, UNITS * (REPS - 1) + 18) != 's' ||
      scr_str_char_code_at(s, UNITS * REPS) != 'n' ||
      scr_str_utf16_len(s) != UNITS * REPS + 4)
    sidx_fail("local window across append");
  scr_str_release(s);
  scr_sidx_test_reset_cache();
}

/* An entry borrowed for a receiver must remain its entry when a second
 * string needs indexing. Fill the cursor tier so the needle would evict
 * precisely the receiver under a receiver-first lookup order. */
static void positioned_suffix_eviction_asserts(void) {
  scr_sidx_test_reset_cache();
  ScrStr *s = scr_str_new("\xC3\xA9" "abcdef", 8);
  ScrStr *others[3];
  (void)scr_str_utf16_len(s);
  for (size_t i = 0; i < 3; i++) {
    others[i] = scr_str_new("\xE4\xB8\xAD", 3);
    (void)scr_str_utf16_len(others[i]);
  }
  ScrStr *needle = scr_str_new("cd", 2);
  if (!scr_str_ends_with_from(s, needle, 5))
    sidx_fail("positioned suffix after receiver eviction");
  if (scr_str_ends_with_from(s, needle, 4))
    sidx_fail("positioned suffix mismatched boundary");
  scr_str_release(needle);
  for (size_t i = 0; i < 3; i++) scr_str_release(others[i]);
  scr_str_release(s);
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
    } else if (strcmp(op, "split") == 0 || strcmp(op, "splitLimit") == 0) {
      /* args = separator hex; expected = "<count>:<pieces joined by 0x01>" */
      double limit = 4294967295.0;
      char *comma = strcmp(op, "splitLimit") == 0 ? strchr(args, ',') : NULL;
      if (comma) { *comma = '\0'; limit = strtod(comma + 1, NULL); }
      size_t sep_len = hex_decode(args, needle_bytes);
      if (comma) *comma = ',';
      if (sep_len == (size_t)-1) goto badline_release;
      ScrStr *sep = scr_str_new(needle_bytes, sep_len);
      ScrArr *pieces = scr_str_split_limit(input, sep, limit);
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
      /* Consume and release one piece at a time. Empty pieces must remain
       * distinct from exhaustion, and resetting must restart the walk. */
      ScrSplitCursor cursor;
      for (int pass = 0; pass < 2; pass++) {
        scr_str_split_cursor_init(&cursor, scr_to_uint32(limit));
        ScrStr *scratch = NULL;
        size_t n = 0, used = 32;
        ScrStr *piece;
        while ((piece = scr_str_split_cursor_next(input, sep, &cursor, &scratch))) {
          if (n) joined[used++] = '\x01';
          memcpy(joined + used, piece->data, piece->len);
          used += piece->len;
          n++;
          scr_str_release(piece);
        }
        size_t prefix = (size_t)snprintf(joined, 32, "%zu:", n);
        total++;
        if (n != count || prefix > exp_len || used - 32 != exp_len - prefix ||
            memcmp(joined + 32, expected_bytes + prefix, used - 32) != 0)
          failed++;
        total++;
        if (scr_str_split_cursor_next(input, sep, &cursor, &scratch) != NULL) failed++;
        scr_str_release(scratch);
      }
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
  construction_asserts();
  split_storage_asserts();
  split_scratch_asserts();
  accumulation_asserts();
  short_string_asserts();
#ifdef SCR_SIDX_TEST
  sparse_index_asserts();
  sparse_ascii_prefix_asserts();
  sparse_all_ascii_end_asserts();
  sparse_append_threshold_asserts();
  index_activity_asserts();
  local_navigation_asserts();
  positioned_suffix_eviction_asserts();
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
