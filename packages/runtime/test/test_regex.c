/* Unit tests for the regex runtime (scr_regex.c + vendored libregexp).
 * Built with ASan + -DSCR_RC_AUDIT by regex.test.ts. Prints "N/N cases
 * passed" to stderr.
 *
 * Focus areas beside the differential corpus (which re-checks the
 * observable results against Node): the C-level contracts — RC accounting
 * of results, catchable throws through the exception cell (replaceAll
 * without /g), capture-group splitting, the CESU-8 pattern re-encoding
 * for non-/u astral patterns, and the UTF-16 buffer round-trip.
 *
 */
#include "../src/scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void); /* provided by scr_string.c */
#endif

static long total = 0, failed = 0;

static void check(bool ok, const char *what) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

/* Immortal literals + regexes, exactly the layout the compiler emits. */
#define LIT(name, s) \
  static struct { size_t rc; size_t len; size_t cap; char data[sizeof(s)]; } name = \
      {SIZE_MAX, sizeof(s) - 1, sizeof(s) - 1, s}
#define RE(name, pat, fl)  \
  LIT(name##_pat, pat);    \
  LIT(name##_fl, fl);      \
  static ScrRegex name = { \
      SIZE_MAX, (ScrStr *)&name##_pat, (ScrStr *)&name##_fl, NULL}

RE(re_abc_i, "ab+c", "i");
RE(re_a_g, "a", "g");
RE(re_ab_g, "a|b", "g");
RE(re_group, "(b)", "");
RE(re_opt_group, "a(x)?c", "");
RE(re_astar_g, "a*", "g");
RE(re_a_first, "a", "");
RE(re_dot_g, "\\.", "g");
RE(re_dot_noglobal, "\\.", "");
RE(re_digit, "\\d", "");
RE(re_empty, "(?:)", "");
RE(re_empty_gu, "(?:)", "gu");
RE(re_bstar, "b*", "");
RE(re_b_y, "b", "y");
RE(re_letter_u, "\\p{L}", "u");
RE(re_caret_gm, "^", "gm");
RE(re_adotb_s, "a.b", "s");
RE(re_astral, "\xF0\x9F\x98\x80", "");        /* non-/u astral: CESU-8 path */
RE(re_astral_u, "\xF0\x9F\x98\x80", "u");
RE(re_split_group, "(,)", "g");
RE(re_named, "(?<y>\\d{4})-(?<m>\\d{2})", "");
RE(re_named_opt, "(?<a>a)(?<b>b)?", "");
RE(re_named_dup, "(?<x>\\d+)px|(?<x>\\d+)em", "g");
RE(re_backref, "(?<q>['\"]).*?\\k<q>", "");

static ScrStr *S(const char *s) { return scr_str_new(s, strlen(s)); }

static bool str_is(ScrStr *s, const char *want) {
  return s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

static void expect_str(ScrStr *got, const char *want, const char *what) {
  check(str_is(got, want), what);
  scr_str_release(got);
}

static void test_test(void) {
  ScrStr *s1 = S("xxABBBcyy");
  ScrStr *s2 = S("ab");
  check(scr_regex_test(&re_abc_i, s1), "test: /ab+c/i matches ABBBc");
  check(!scr_regex_test(&re_abc_i, s2), "test: /ab+c/i misses 'ab'");
  ScrStr *accent = S("\xC3\xA9"); /* é */
  check(scr_regex_test(&re_letter_u, accent), "test: /\\p{L}/u matches é (unicode tables linked)");
  ScrStr *newline = S("a\nb");
  check(scr_regex_test(&re_adotb_s, newline), "test: /a.b/s crosses the newline");
  ScrStr *emoji = S("\xF0\x9F\x98\x80");
  check(scr_regex_test(&re_astral, emoji), "test: non-/u astral pattern (CESU-8) matches the pair");
  check(scr_regex_test(&re_astral_u, emoji), "test: /u astral pattern matches");
  scr_str_release(s1);
  scr_str_release(s2);
  scr_str_release(accent);
  scr_str_release(newline);
  scr_str_release(emoji);
}

static void test_source_flags(void) {
  expect_str(scr_regex_source(&re_abc_i), "ab+c", "source readback");
  expect_str(scr_regex_flags(&re_abc_i), "i", "flags readback");
  expect_str(scr_regex_flags(&re_empty_gu), "gu", "flags keep source order");
}

static void test_replace(void) {
  ScrStr *s;

  s = S("aa");
  ScrStr *b = S("b");
  expect_str(scr_regex_replace(s, &re_a_first, b),
             "ba", "replace without /g replaces the first only");
  scr_str_release(b);
  scr_str_release(s);

  s = S("xaybz");
  ScrStr *rep = S("[$&|$`|$'|$1|$9|$$]");
  expect_str(scr_regex_replace(s, &re_ab_g, rep),
             "x[a|x|ybz|$1|$9|$]y[b|xay|z|$1|$9|$]z",
             "replace /g: $&, $`, $', out-of-range $1/$9 literal, $$");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("abc");
  rep = S("<$01|$1|$2|$10>");
  expect_str(scr_regex_replace(s, &re_group, rep),
             "a<b|b|$2|b0>c",
             "replace: $01 two-digit form, out-of-range $2 literal, $10 falls back to $1+'0'");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("ac");
  rep = S("[$1]");
  expect_str(scr_regex_replace(s, &re_opt_group, rep), "[]",
             "replace: unmatched group substitutes empty");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("aaa");
  rep = S("-");
  expect_str(scr_regex_replace(s, &re_astar_g, rep), "--",
             "replace /g: zero-length matches advance (no infinite loop)");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("\xF0\x9F\x98\x80x");
  rep = S("-");
  expect_str(scr_regex_replace(s, &re_empty_gu, rep), "-\xF0\x9F\x98\x80-x-",
             "replace /gu: AdvanceStringIndex respects surrogate pairs");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("a\nb");
  rep = S(">");
  expect_str(scr_regex_replace(s, &re_caret_gm, rep), ">a\n>b",
             "replace /gm: ^ matches after every line break");
  scr_str_release(rep);
  scr_str_release(s);
}

static void test_replace_all(void) {
  ScrStr *s = S("a.b.c");
  ScrStr *rep = S("-");
  expect_str(scr_regex_replace_all(s, &re_dot_g, rep), "a-b-c",
             "replaceAll with /g replaces every match");

  check(!scr_exc_pending(), "no pending exception before the fence");
  ScrStr *r = scr_regex_replace_all(s, &re_dot_noglobal, rep);
  check(r == NULL && scr_exc_pending(),
        "replaceAll without /g throws catchably and returns NULL");
  scr_exc_clear();
  scr_str_release(rep);
  scr_str_release(s);
}

/* $<name> in GetSubstitution (the named arm) + \k<name> execution. */
static void test_named_groups(void) {
  ScrStr *s = S("2024-07");
  ScrStr *rep = S("$<m>/$<y>");
  expect_str(scr_regex_replace(s, &re_named, rep), "07/2024",
             "replace: $<name> substitutes the named captures");
  scr_str_release(rep);

  rep = S("[$<y>][$<nope>]");
  expect_str(scr_regex_replace(s, &re_named, rep), "[2024][]",
             "replace: a nonexistent $<name> substitutes empty");
  scr_str_release(rep);

  rep = S("[$<y]");
  expect_str(scr_regex_replace(s, &re_named, rep), "[$<y]",
             "replace: an unterminated $<name stays literal");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("a");
  rep = S("[$<x>]");
  expect_str(scr_regex_replace(s, &re_a_first, rep), "[$<x>]",
             "replace: $<name> stays literal when the pattern has no named groups");
  scr_str_release(rep);

  rep = S("<$<a>|$<b>>");
  expect_str(scr_regex_replace(s, &re_named_opt, rep), "<a|>",
             "replace: a nonparticipating named group substitutes empty");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("14px 9em");
  rep = S("[$<x>]");
  expect_str(scr_regex_replace_all(s, &re_named_dup, rep), "[14] [9]",
             "replace: ES2025 duplicate names resolve to the participating alternative");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("say \"hi\" ok");
  check(scr_regex_test(&re_backref, s), "test: \\k<name> backreference matches");
  scr_str_release(s);
  s = S("say 'hi ok");
  check(!scr_regex_test(&re_backref, s), "test: \\k<name> backreference misses the unclosed quote");
  scr_str_release(s);
}

static void expect_split(ScrStr *s, ScrRegex *re, const char *const *want,
                         size_t want_len, const char *what) {
  ScrArr *a = scr_regex_split(s, re);
  bool ok = a != NULL && a->len == want_len;
  if (ok) {
    for (size_t i = 0; i < want_len; i++) {
      ScrStr *e = scr_arr_get_ref(a, (double)i);
      ok = ok && str_is(e, want[i]);
      scr_str_release(e);
    }
  }
  check(ok, what);
  scr_arr_release(a);
}

static void test_split(void) {
  ScrStr *s;

  s = S("a1b2c");
  expect_split(s, &re_digit, (const char *[]){"a", "b", "c"}, 3,
               "split by /\\d/");
  scr_str_release(s);

  s = S("abc");
  expect_split(s, &re_empty, (const char *[]){"a", "b", "c"}, 3,
               "split by the empty pattern separates every unit");
  scr_str_release(s);

  s = S("");
  expect_split(s, &re_empty, NULL, 0,
               "empty subject + matching pattern splits to []");
  expect_split(s, &re_digit, (const char *[]){""}, 1,
               "empty subject + non-matching pattern splits to ['']");
  scr_str_release(s);

  s = S("ab");
  expect_split(s, &re_bstar, (const char *[]){"a", ""}, 2,
               "split /b*/: trailing empty piece when the match ends the string");
  scr_str_release(s);

  s = S("abab");
  expect_split(s, &re_b_y, (const char *[]){"a", "a", ""}, 2 + 1,
               "split by a sticky pattern probes positions like the spec");
  scr_str_release(s);

  s = S("a,b");
  expect_split(s, &re_split_group, (const char *[]){"a", ",", "b"}, 3,
               "split includes participating capture groups");
  check(!scr_exc_pending(), "capture splitting leaves no pending exception");
  scr_str_release(s);
}

static void test_borrowed_results(void) {
  ScrStr *s = scr_str_new("unchanged\0tail", 14);
  ScrStr *rep = S("replacement");
  re_b_y.last_index = 500;
  ScrStr *result = scr_regex_replace(s, &re_b_y, rep);
  check(result == s && s->rc == 2 && re_b_y.last_index == 0,
        "unmatched sticky replacement reuses an owned subject and resets state");
  scr_str_release(s);
  check(result->len == 14 && memcmp(result->data, "unchanged\0tail", 14) == 0,
        "unmatched result survives its original owner, including NUL bytes");
  scr_str_release(result);
  scr_str_release(rep);

  s = scr_str_new("lower\0tail", 10);
  result = scr_str_to_lower(s);
  check(result == s && s->rc == 2, "unchanged ASCII case conversion retains its subject");
  scr_str_release(result);
  result = scr_str_to_upper(s);
  check(result->len == 10 && memcmp(result->data, "LOWER\0TAIL", 10) == 0,
        "ASCII case conversion preserves embedded NUL bytes");
  scr_str_release(result);
  ScrStr *form = S("NFC");
  result = scr_str_normalize(s, form);
  check(result == s && s->rc == 2, "ASCII normalization retains its subject");
  scr_str_release(result);
  scr_str_release(form);
  form = S("invalid");
  result = scr_str_normalize(s, form);
  check(result == NULL && scr_exc_pending(), "ASCII normalization still validates the form");
  scr_exc_clear();
  scr_str_release(form);
  scr_str_release(s);
}

static void test_capture_capacity(void) {
  // A large prior serialization must not size every later capture.
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  for (size_t i = 0; i < 65536; i++) scr_jb_putc(&buffer, 'x');
  scr_str_release(scr_jb_finish(&buffer));
  ScrStr *s = S("\xC3\xA9\xF0\x9F\x98\x80" "b");
  ScrArr *matches = scr_regex_exec(s, &re_group);
  ScrStr *capture = scr_arr_get_ref(matches, 1);
  check(str_is(capture, "b") && capture->cap <= 4,
        "small Unicode-subject capture has capacity proportional to its value");
  scr_str_release(capture);
  scr_arr_release(matches);
  matches = scr_regex_match(s, &re_astral_u);
  capture = scr_arr_get_ref(matches, 0);
  check(capture->len == 4 && capture->cap <= 16,
        "astral capture preserves the pair without inheriting a large capacity");
  scr_arr_release(matches);
  scr_str_release(s);
  expect_str(capture, "\xF0\x9F\x98\x80", "capture owns its bytes after subject release");
}

static void test_exec_groups(void) {
  /* Only the selected captures are materialized; the rest read undefined. */
  ScrStr *s = S("xac");
  ScrArr *full = scr_regex_exec(s, &re_opt_group);
  ScrArr *lean = scr_regex_exec_groups(s, &re_opt_group, 2.0);
  check(full && lean && full->len == lean->len && lean->len == 2, "exec_groups keeps the capture count");
  check(*scr_arr_state_ptr(lean, 0) == SCR_ARR_UNDEFINED && *scr_arr_state_ptr(lean, 1) == SCR_ARR_UNDEFINED,
        "exec_groups: unselected and nonparticipating captures are undefined");
  check(scr_arr_ext_of(lean) == NULL || scr_arr_ext_of(lean)->metadata == NULL, "exec_groups: no index/input properties");
  scr_arr_release(full);
  scr_arr_release(lean);
  ScrStr *ab = S("ab");
  lean = scr_regex_exec_groups(ab, &re_group, 2.0);
  ScrStr *group = lean ? scr_arr_get_ref(lean, 1) : NULL;
  check(group && str_is(group, "b"), "exec_groups: a selected capture keeps its value");
  scr_str_release(group);
  scr_arr_release(lean);
  check(scr_regex_exec_groups(s, &re_group, 1.0) == NULL, "exec_groups: no match is NULL");
  scr_str_release(ab);
  scr_str_release(s);
}

/* A build-time matcher stand-in for /(b)/: the first 'b'. Counts its calls,
 * and grows the backtrack stack once to exercise the runtime helper. */
static int fake_calls = 0;
static int32_t fake_b_matcher(const uint8_t *s, int32_t len, int32_t start, uint8_t **capture) {
  if (len < 0) return 2;
  fake_calls++;
  int32_t inline_buf[4];
  int32_t *stack = inline_buf, cap = 4;
  for (int32_t i = 0; i < 4; i++) inline_buf[i] = i;
  scr_regex_stack_grow(&stack, &cap, inline_buf, 9);
  bool kept = stack != inline_buf && cap >= 9 && stack[3] == 3;
  scr_regex_stack_free(stack);
  if (!kept) return 0;
  for (int32_t i = start; i < len; i++) {
    if (s[i] == 'b') {
      capture[0] = capture[2] = (uint8_t *)s + i;
      capture[1] = capture[3] = (uint8_t *)s + i + 1;
      return 1;
    }
  }
  return 0;
}
static int32_t fake_wrong_count(const uint8_t *s, int32_t len, int32_t start, uint8_t **capture) {
  (void)s;
  (void)start;
  (void)capture;
  if (len < 0) return 7;
  fake_calls++;
  return 0;
}
RE(re_matched, "(b)", "");
RE(re_mismatched, "(b)", "");

static void test_build_time_matcher(void) {
  re_matched.matcher = fake_b_matcher;
  re_mismatched.matcher = fake_wrong_count;
  ScrStr *ascii = S("abc");
  ScrStr *wide = S("\xC3\xA9" "b");
  ScrArr *m = scr_regex_exec(ascii, &re_matched);
  ScrStr *g = m ? scr_arr_get_ref(m, 1) : NULL;
  check(fake_calls == 1 && g && str_is(g, "b"), "matcher: ASCII subjects use the build-time matcher");
  scr_str_release(g);
  scr_arr_release(m);
  check(scr_regex_test(&re_matched, wide) && fake_calls == 1,
        "matcher: non-ASCII subjects keep the bytecode engine");
  ScrRegex *instance = scr_regex_literal(&re_matched);
  check(scr_regex_test(instance, ascii) && fake_calls == 2, "matcher: literal instances use the template's");
  scr_regex_release(instance);
  check(scr_regex_test(&re_mismatched, ascii) && fake_calls == 2 && re_mismatched.matcher == NULL,
        "matcher: a capture-count mismatch falls back to the bytecode engine");
  scr_str_release(ascii);
  scr_str_release(wide);
}

RE(re_matched_g, "(b)", "g");
RE(re_pair, "(a)(\\d+)?", "");
RE(re_digits_g, "\\d+", "g");

static void test_replace_matcher(void) {
  /* The direct loop over a build-time matcher: templates decode once. */
  re_matched_g.matcher = fake_b_matcher;
  ScrStr *s = S("abcb");
  ScrStr *t1 = S("[$1|$&|$$|$2|$01]");
  ScrStr *t2 = S("<$`>");
  ScrStr *t3 = S("");
  ScrStr *out = scr_regex_replace(s, &re_matched_g, t1);
  check(str_is(out, "a[b|b|$|$2|b]c[b|b|$|$2|b]") && scr_str_known_ascii(out),
        "matcher replace: $n, $&, $$ and out-of-range references; ASCII result");
  scr_str_release(out);
  expect_str(scr_regex_replace(s, &re_matched_g, t2), "a<a>c<abc>", "matcher replace: $` takes the general loop");
  expect_str(scr_regex_replace(s, &re_matched_g, t3), "ac", "matcher replace: empty template");
  check(re_matched_g.last_index == 0, "matcher replace: a global regex ends at lastIndex 0");
  scr_str_release(s);
  scr_str_release(t1);
  scr_str_release(t2);
  scr_str_release(t3);
}

static void test_exec_spans(void) {
  /* Lazy captures: compared and converted without strings on ASCII
   * subjects, materialized on wide ones. */
  ScrStr *ascii = S("xa12");
  ScrArr *m = scr_regex_exec_spans(ascii, &re_pair, 6.0, 6.0);
  check(m && m->len == 4 && *scr_arr_state_ptr(m, 1) == SCR_ARR_UNDEFINED,
        "exec_spans: ASCII subjects keep lazy captures as spans");
  ScrStr *a = S("a");
  ScrStr *twelve = S("12");
  check(m && scr_regex_group_eq(m, 1, a) && !scr_regex_group_eq(m, 2, a) && scr_regex_group_eq(m, 2, twelve),
        "group_eq compares the span");
  check(m && scr_regex_group_number(m, 2) == 12 && scr_regex_group_parse_int(m, 2, 16) == 18,
        "group_number and group_parse_int convert the span");
  check(m && isnan(scr_regex_group_number(m, 5)) && !scr_regex_group_eq(m, 5, a),
        "reads past the result are undefined");
  scr_arr_release(m);
  ScrStr *short_subject = S("a");
  m = scr_regex_exec_spans(short_subject, &re_pair, 6.0, 6.0);
  check(m && isnan(scr_regex_group_number(m, 2)) && scr_regex_group_parse_int(m, 2, 36) == 86464843759093.0,
        "a non-participating capture reads as undefined");
  scr_arr_release(m);
  ScrStr *wide = S("\xC3\xA9" "a7");
  m = scr_regex_exec_spans(wide, &re_pair, 6.0, 6.0);
  check(m && m->len == 3 && *scr_arr_state_ptr(m, 2) == SCR_ARR_VALUE && scr_regex_group_number(m, 2) == 7,
        "exec_spans: wide subjects materialize lazy captures");
  scr_arr_release(m);
  m = scr_regex_exec_spans(ascii, &re_pair, 38.0, 2.0);
  check(m && m->len == 3 && scr_regex_group_eq(m, 1, a), "exec_spans: a read past the captures keeps strings");
  scr_arr_release(m);
  ScrStr *list = S("1 22 333");
  m = scr_regex_match_groups(list, &re_digits_g, 1.0, 1.0);
  check(m && m->len == 3 && scr_regex_group_number(m, 2) == 333, "match_groups: a global regex answers every match");
  scr_arr_release(m);
  m = scr_regex_match_groups(ascii, &re_pair, 6.0, 4.0);
  check(m && scr_regex_group_number(m, 2) == 12, "match_groups: a non-global regex reads like exec_spans");
  scr_arr_release(m);
  scr_str_release(ascii);
  scr_str_release(short_subject);
  scr_str_release(wide);
  scr_str_release(list);
  scr_str_release(a);
  scr_str_release(twelve);
}

static void test_replace_chars(void) {
  ScrStr *chars = S("&<>");
  ScrStr *texts = scr_str_new("&amp;\0&lt;\0&gt;", 15);
  ScrStr *s = S("a<b>&c");
  expect_str(scr_str_replace_chars(s, chars, texts), "a&lt;b&gt;&amp;c", "replace_chars: every character");
  ScrStr *none = S("plain text without specials");
  ScrStr *same = scr_str_replace_chars(none, chars, texts);
  check(same == none, "replace_chars: no hit retains the subject");
  scr_str_release(same);
  ScrStr *longer = S("0123456789abcdefghij<0123456789abcdefghij>0123456789&");
  expect_str(scr_str_replace_chars(longer, chars, texts),
             "0123456789abcdefghij&lt;0123456789abcdefghij&gt;0123456789&amp;",
             "replace_chars: word-at-a-time scan");
  ScrStr *wide = S("\xC3\xA9<\xC3\xA9");
  expect_str(scr_str_replace_chars(wide, chars, texts), "\xC3\xA9&lt;\xC3\xA9", "replace_chars: UTF-8 subject");
  scr_str_release(chars);
  scr_str_release(texts);
  scr_str_release(s);
  scr_str_release(none);
  scr_str_release(longer);
  scr_str_release(wide);
}

static void test_string_replace(void) {
  /* String search values: one pass, GetSubstitution without captures. */
  ScrStr *s = S("a.b.c");
  ScrStr *dot = S(".");
  ScrStr *empty = S("");
  ScrStr *rep = S("<$&|$`|$'|$1|$$>");
  ScrStr *plain = S("--");
  expect_str(scr_str_replace_literal(s, dot, plain, false), "a--b.c", "string replace: first match");
  expect_str(scr_str_replace_literal(s, dot, plain, true), "a--b--c", "string replaceAll: every match");
  expect_str(scr_str_replace_literal(s, dot, rep, false), "a<.|a|b.c|$1|$>b.c",
             "string replace: substitutions");
  expect_str(scr_str_replace_literal(s, empty, plain, true), "--a--.--b--.--c--",
             "string replaceAll: empty search at every position");
  expect_str(scr_str_replace_literal(s, plain, dot, true), "a.b.c", "string replaceAll: no match");
  expect_str(scr_regex_replace(s, &re_dot_g, plain), "a--b--c", "plain-text regex replace");
  check(scr_regex_search(s, &re_dot_noglobal) == 1, "plain-text regex search");
  scr_str_release(s);
  scr_str_release(dot);
  scr_str_release(empty);
  scr_str_release(rep);
  scr_str_release(plain);
}

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;
  ScrStr *subject = S("aaa");
  check(scr_regex_test(&re_a_g, subject) && re_a_g.last_index == 1, "global test advances lastIndex");
  re_a_g.last_index = 3;
  check(!scr_regex_test(&re_a_g, subject) && re_a_g.last_index == 0, "failed global test resets lastIndex");
  scr_str_release(subject);

  test_test();
  test_source_flags();
  test_replace();
  test_replace_all();
  test_named_groups();
  test_split();
  test_borrowed_results();
  test_capture_capacity();
  test_exec_groups();
  test_string_replace();
  test_build_time_matcher();
  test_replace_matcher();
  test_exec_spans();
  test_replace_chars();

#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == 0, "no live heap strings at exit (RC audit)");
#endif

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
