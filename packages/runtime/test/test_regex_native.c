/* Differential fuzz test: the native one-byte matcher (scr_regex_native.h)
 * against libregexp's lre_exec, the reference it replaces for ASCII
 * subjects. Random patterns from a grammar that covers the translated
 * subset (classes, escapes, every quantifier form, groups, alternation,
 * anchors, word boundaries) plus constructs that must bail out (lookaround,
 * back references, quantified groups that can be empty). For every pattern
 * that translates, random ASCII subjects are matched from every start
 * index and the result and all capture slots must agree exactly.
 *
 * Every pattern, translated or not, also goes through scr_re_anchor_search
 * on a copy of its bytecode. When that finds the pattern anchored at
 * position 0, the one-attempt search of both engines (the copy under
 * lre_exec, the translated program) must agree with the reference search
 * of the untouched bytecode from every start index. A table of fixed
 * shapes pins which patterns count as anchored.
 *
 *   test_regex_native [iterations] [seed]
 * Prints "<translated>/<patterns> translated, <anchored> anchored, <checks>
 * checks" to stderr and exits non-zero on the first mismatch.
 */
#define _POSIX_C_SOURCE 200809L /* clock_gettime under -std=c11 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../src/scr_regex_native.h"

bool lre_check_stack_overflow(void *opaque, size_t alloca_size) {
  (void)opaque;
  (void)alloca_size;
  return false;
}
static double now_sec(void);
static double lre_deadline;
/* Nested unbounded quantifiers backtrack exponentially in both engines
 * (same order, same state count): the reference gets a deadline and such
 * subjects are skipped. */
int lre_check_timeout(void *opaque) {
  (void)opaque;
  return now_sec() > lre_deadline;
}
void *lre_realloc(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  if (size == 0) {
    free(ptr);
    return NULL;
  }
  return realloc(ptr, size);
}

static uint64_t rng_state;
static uint32_t rnd(uint32_t n) {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 7;
  rng_state ^= rng_state << 17;
  return (uint32_t)(rng_state % n);
}

typedef struct {
  char buf[512];
  int len;
  int groups;
} Pat;

static void put(Pat *p, const char *s) {
  size_t n = strlen(s);
  if (p->len + (int)n < (int)sizeof p->buf - 1) {
    memcpy(p->buf + p->len, s, n);
    p->len += (int)n;
  }
}

static const char *ATOMS[] = {
    "a", "b", "c", "A", "B", "x", "-", " ", ".", "\\d", "\\w", "\\s", "\\D", "\\W", "\\S",
    "[ab]", "[^ab]", "[a-c]", "[^a-c ]", "[\\d.]", "[A-Za-z]", "\\.", "\\-", "\\/", "\\n",
    "[^\\]]", "\\]", "\"", "?", "k", "s", "K", "S", "[k-s]", "\\x41", "\\u017f", "\\u212a",
    "[\\u017f]", "[^\\u212a]", "\\x7f", "\\t",
};
static const char *QUANTS[] = {"", "", "", "*", "+", "?", "*?", "+?", "??", "{2}", "{1,3}",
                               "{0,2}", "{2,}", "{0,1}", "{3}?", "{1,2}?", "{0,3}?"};

static void gen_alt(Pat *p, int depth);

static void gen_term(Pat *p, int depth) {
  uint32_t r = rnd(100);
  if (r < 6) {
    put(p, "^");
    return;
  }
  if (r < 12) {
    put(p, "$");
    return;
  }
  if (r < 16) {
    put(p, rnd(2) ? "\\b" : "\\B");
    return;
  }
  if (r < 30 && depth < 2) {
    uint32_t kind = rnd(12);
    if (kind < 6) {
      p->groups++;
      put(p, "(");
    } else if (kind < 10) {
      put(p, "(?:");
    } else if (kind < 11) {
      put(p, rnd(2) ? "(?=" : "(?!"); /* bails */
    } else {
      put(p, rnd(2) ? "(?<=" : "(?<!"); /* bails */
    }
    gen_alt(p, depth + 1);
    put(p, ")");
  } else if (r < 32 && p->groups > 0) {
    char ref[8];
    snprintf(ref, sizeof ref, "\\%d", 1 + (int)rnd((uint32_t)p->groups)); /* bails */
    put(p, ref);
    return;
  } else {
    put(p, ATOMS[rnd(sizeof ATOMS / sizeof ATOMS[0])]);
  }
  put(p, QUANTS[rnd(sizeof QUANTS / sizeof QUANTS[0])]);
}

static void gen_seq(Pat *p, int depth) {
  int n = 1 + (int)rnd(depth == 0 ? 6 : 4);
  for (int i = 0; i < n; i++) gen_term(p, depth);
}

static void gen_alt(Pat *p, int depth) {
  gen_seq(p, depth);
  while (rnd(5) == 0) {
    put(p, "|");
    gen_seq(p, depth);
  }
}

static double now_sec(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec * 1e-9;
}

static const char ALPHABET[] = "aabbcxAB -.\n\"]?ksKS019/\t_";

/* `bc` is the untouched bytecode (the reference search). `nat` is its
 * translated program or NULL; `anchored_bc` is the copy whose search
 * scr_re_anchor_search made one attempt, or NULL when the pattern is not
 * anchored. */
static int check(const uint8_t *bc, const ScrReNative *nat, const uint8_t *anchored_bc,
                 const char *pat, int flags, const uint8_t *subject, int len) {
  int alloc = lre_get_alloc_count(bc);
  int ncap = lre_get_capture_count(bc);
  uint8_t **ref = calloc((size_t)alloc + 1, sizeof *ref);
  uint8_t **got = calloc((size_t)alloc + 1, sizeof *got);
  int checks = 0;
  for (int start = 0; start <= len; start++) {
    lre_deadline = now_sec() + 0.002;
    int a = lre_exec(ref, bc, subject, start, len, 0, NULL);
    if (a < 0) break;
    for (int engine = 0; engine < 2; engine++) {
      const char *name = engine == 0 ? "native" : "anchored lre";
      int b;
      if (engine == 0) {
        if (!nat) continue;
        b = scr_re_native_exec(nat, got, subject, start, len);
      } else {
        if (!anchored_bc) continue;
        lre_deadline = now_sec() + 1;
        b = lre_exec(got, anchored_bc, subject, start, len, 0, NULL);
      }
      checks++;
      bool same = a == b;
      if (same && a == 1) {
        for (int k = 0; k < 2 * ncap; k++) {
          if (ref[k] != got[k]) same = false;
        }
      }
      if (!same) {
        fprintf(stderr, "MISMATCH /%s/ flags=%d subject=\"", pat, flags);
        for (int i = 0; i < len; i++) {
          if (subject[i] == '\n') fprintf(stderr, "\\n");
          else if (subject[i] == '\t') fprintf(stderr, "\\t");
          else fputc(subject[i], stderr);
        }
        fprintf(stderr, "\" start=%d lre=%d %s=%d\n", start, a, name, b);
        for (int k = 0; k < 2 * ncap; k++) {
          fprintf(stderr, "  slot %d: lre=%ld %s=%ld\n", k,
                  ref[k] ? (long)(ref[k] - subject) : -1L, name,
                  got[k] ? (long)(got[k] - subject) : -1L);
        }
        free(ref);
        free(got);
        return -1;
      }
    }
  }
  free(ref);
  free(got);
  return checks;
}

/* A copy of `bc` with scr_re_anchor_search applied (and `nat` with it), or
 * NULL when the pattern is not anchored at position 0. */
static uint8_t *anchored_copy(const uint8_t *bc, int bc_len, ScrReNative *nat) {
  uint8_t *copy = malloc((size_t)bc_len);
  if (!copy) abort();
  memcpy(copy, bc, (size_t)bc_len);
  if (scr_re_anchor_search(copy, nat)) return copy;
  free(copy);
  return NULL;
}

int main(int argc, char **argv) {
  int iterations = argc > 1 ? atoi(argv[1]) : 20000;
  rng_state = argc > 2 ? strtoull(argv[2], NULL, 10) : 0x9E3779B97F4A7C15ull;
  if (rng_state == 0) rng_state = 1;
  static const int FLAGSETS[] = {
      0,
      LRE_FLAG_GLOBAL,
      LRE_FLAG_IGNORECASE,
      LRE_FLAG_MULTILINE,
      LRE_FLAG_DOTALL,
      LRE_FLAG_UNICODE,
      LRE_FLAG_STICKY,
      LRE_FLAG_IGNORECASE | LRE_FLAG_UNICODE,
      LRE_FLAG_MULTILINE | LRE_FLAG_IGNORECASE,
      LRE_FLAG_DOTALL | LRE_FLAG_UNICODE | LRE_FLAG_STICKY,
      LRE_FLAG_GLOBAL | LRE_FLAG_STICKY | LRE_FLAG_MULTILINE,
  };
  long translated = 0, compiled = 0, anchored = 0, checks = 0;
  for (int it = 0; it < iterations; it++) {
    Pat p = {{0}, 0, 0};
    gen_alt(&p, 0);
    p.buf[p.len] = '\0';
    int flags = FLAGSETS[rnd(sizeof FLAGSETS / sizeof FLAGSETS[0])];
    char err[64];
    int bc_len;
    uint8_t *bc = lre_compile(&bc_len, err, sizeof err, p.buf, (size_t)p.len, flags, NULL);
    if (!bc) continue;
    compiled++;
    ScrReNative *nat = scr_re_native_build(bc);
    uint8_t *anchored_bc = anchored_copy(bc, bc_len, nat);
    if (nat) translated++;
    if (anchored_bc) anchored++;
    if (nat || anchored_bc) {
      if (getenv("FUZZ_TRACE")) fprintf(stderr, "%d /%s/ %d\n", it, p.buf, flags);
      for (int s = 0; s < 6; s++) {
        uint8_t subject[40];
        int len = (int)rnd(sizeof subject);
        for (int i = 0; i < len; i++) subject[i] = (uint8_t)ALPHABET[rnd(sizeof ALPHABET - 1)];
        int c = check(bc, nat, anchored_bc, p.buf, flags, subject, len);
        if (c < 0) return 1;
        checks += c;
      }
    }
    scr_re_native_free(nat);
    free(anchored_bc);
    free(bc);
  }
  /* Fixed shapes from the benchmark workloads and quantifier edge cases. */
  static const struct {
    const char *pat;
    int flags;
    const char *subject;
  } FIXED[] = {
      {"^(\\d+\\.\\d+\\.\\d+\\.\\d+) - - \\[([^\\]]+)\\] \"(\\w+) ([^ ?\"]+)(?:\\?([^ \"]*))? "
       "HTTP\\/1\\.1\" (\\d{3}) (\\d+) \"([^\"]*)\"$",
       0,
       "10.1.2.3 - - [07/Oct/2026:12:00:00 +0000] \"GET /api/items/search?id=42 HTTP/1.1\" 200 "
       "17 \"curl/8.4.0\""},
      {"curl|bot|spider", LRE_FLAG_IGNORECASE, "Mozilla/5.0 (Macintosh) SPIDER"},
      {"\\d+", LRE_FLAG_GLOBAL, "a1b22c333"},
      {"&", LRE_FLAG_GLOBAL, "R&D & more"},
      {"a{2,4}?b", 0, "aaaaab"},
      {"(a|ab)(c|bcd)(d*)", 0, "abcd"},
      {"(?:a+|b)*c", 0, "aababbc"},
      {"x*", 0, ""},
  };
  for (size_t i = 0; i < sizeof FIXED / sizeof FIXED[0]; i++) {
    char err[64];
    int bc_len;
    uint8_t *bc = lre_compile(&bc_len, err, sizeof err, FIXED[i].pat, strlen(FIXED[i].pat),
                              FIXED[i].flags, NULL);
    if (!bc) {
      fprintf(stderr, "fixed pattern failed to compile: %s\n", FIXED[i].pat);
      return 1;
    }
    ScrReNative *nat = scr_re_native_build(bc);
    if (!nat) {
      fprintf(stderr, "fixed pattern not translated: /%s/\n", FIXED[i].pat);
      return 1;
    }
    uint8_t *anchored_bc = anchored_copy(bc, bc_len, nat);
    int c = check(bc, nat, anchored_bc, FIXED[i].pat, FIXED[i].flags,
                  (const uint8_t *)FIXED[i].subject, (int)strlen(FIXED[i].subject));
    if (c < 0) return 1;
    checks += c;
    scr_re_native_free(nat);
    free(anchored_bc);
    free(bc);
  }
  /* Which patterns can only match at position 0. The analysis may call an
   * anchored pattern unanchored (it then searches as before), never the
   * reverse: every `false` row below either matches somewhere else or is a
   * shape the analysis deliberately does not follow. */
  static const struct {
    const char *pat;
    int flags;
    bool anchored;
  } ANCHORS[] = {
      {"^abc", 0, true},
      {"^", 0, true},
      {"^abc", LRE_FLAG_IGNORECASE | LRE_FLAG_UNICODE, true},
      {"^abc", LRE_FLAG_GLOBAL, true},
      {"^abc", LRE_FLAG_MULTILINE, false},       /* ^ also matches after a line terminator */
      {"^abc", LRE_FLAG_STICKY, false},          /* no search to shorten */
      {"^a|^b", 0, true},
      {"^a|b", 0, false},                        /* matches b anywhere */
      {"a|^b", 0, false},
      {"(^a)", 0, true},
      {"(?:^a|^b)c", 0, true},
      {"((^a)|(^b))", 0, true},
      {"(?:^a|b)c", 0, false},
      {"\\b^a", 0, true},                        /* zero-width assertions first */
      {"$^", 0, true},
      {"(?=a)^a", 0, true},                      /* a lookaround before the anchor */
      {"(?!b)^a", 0, true},
      {"(?<!b)^a", 0, true},
      {"^(?=a)a", 0, true},
      {"(?=^)a", 0, false},                      /* an anchor inside a lookaround is not read */
      {"(?!^)a", 0, false},                      /* matches a everywhere but at 0 */
      {"(?<=^)a", 0, false},
      {"(?:^a)+", 0, true},                      /* the group runs at least once */
      {"(?:^a){2}", 0, true},
      {"(?:^a)?b", 0, false},                    /* the group can be skipped */
      {"(?:^a)*b", 0, false},
      {"(?:^a){0,2}b", 0, false},
      {"a?^b", 0, false},                        /* anchored in fact; not followed past a? */
      {"a^", 0, false},
      {"(a)|\\1^b", 0, false},                   /* a back reference before the anchor */
      {"(?:)^a", 0, true},
      {"^a", LRE_FLAG_DOTALL, true},
      {"[^a]", 0, false},
      {"\\^a", 0, false},
  };
  for (size_t i = 0; i < sizeof ANCHORS / sizeof ANCHORS[0]; i++) {
    char err[64];
    int bc_len;
    uint8_t *bc = lre_compile(&bc_len, err, sizeof err, ANCHORS[i].pat, strlen(ANCHORS[i].pat),
                              ANCHORS[i].flags, NULL);
    if (!bc) {
      fprintf(stderr, "anchor pattern failed to compile: %s\n", ANCHORS[i].pat);
      return 1;
    }
    ScrReNative *nat = scr_re_native_build(bc);
    uint8_t *anchored_bc = anchored_copy(bc, bc_len, nat);
    if ((anchored_bc != NULL) != ANCHORS[i].anchored) {
      fprintf(stderr, "anchor analysis: /%s/ flags=%d is %s, expected %s\n", ANCHORS[i].pat,
              ANCHORS[i].flags, anchored_bc ? "anchored" : "not anchored",
              ANCHORS[i].anchored ? "anchored" : "not anchored");
      return 1;
    }
    static const char *const SUBJECTS[] = {"abc", "ab", "b", "xabc", "a\nabc", "bab", "aab", "",
                                           "ba", "ac", "bc", "aabc", "\nb"};
    for (size_t k = 0; k < sizeof SUBJECTS / sizeof SUBJECTS[0]; k++) {
      int c = check(bc, nat, anchored_bc, ANCHORS[i].pat, ANCHORS[i].flags,
                    (const uint8_t *)SUBJECTS[k], (int)strlen(SUBJECTS[k]));
      if (c < 0) return 1;
      checks += c;
    }
    scr_re_native_free(nat);
    free(anchored_bc);
    free(bc);
  }
  fprintf(stderr, "%ld/%ld translated, %ld anchored, %ld checks\n", translated, compiled,
          anchored, checks);
  return 0;
}
