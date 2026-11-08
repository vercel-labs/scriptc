/* Differential fuzz test: libregexp's WTF-8 subject type (cbuf_type 3, the
 * scriptc addition in vendor/quickjs-ng/libregexp.c) against its 16-bit
 * subject type, the reference it replaces for non-ASCII subjects.
 *
 * Random subjects are sequences of UTF-16 code units over an alphabet with
 * ASCII, two- and three-byte characters, line separators, the characters
 * that case-fold across the ASCII boundary, astral characters, and unpaired
 * high and low surrogates. Each is encoded as canonical WTF-8 (a pair is
 * its four-byte sequence, an unpaired surrogate its own three bytes) into a
 * buffer of exactly its length plus the NUL, so the sanitizer sees any read
 * outside it. Random patterns cover literals and classes of every width,
 * escapes, quantifiers, groups, alternation, anchors, word boundaries,
 * lookahead and lookbehind, and back references, under every flag
 * combination, with and without `u`.
 *
 * For every pattern and subject, both subject types are matched from every
 * start index, between the halves of a pair included. The result and every
 * capture must agree: each capture of the 16-bit run, as a unit index, must
 * be the byte position of that index (the third byte of a pair's four for
 * the index between its halves).
 *
 *   test_regex_wtf8 [iterations] [seed]
 * Prints "<patterns> patterns, <checks> checks, <matches> matches, <split>
 * captures between the halves of a pair" to stderr and exits non-zero on
 * the first mismatch.
 */
#define _POSIX_C_SOURCE 200809L /* clock_gettime under -std=c11 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "libregexp.h"

bool lre_check_stack_overflow(void *opaque, size_t alloca_size) {
  (void)opaque;
  (void)alloca_size;
  return false;
}
static double now_sec(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec * 1e-9;
}
static double lre_deadline;
/* Nested unbounded quantifiers backtrack exponentially in both runs (same
 * order, same state count): the reference gets a deadline and such
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

/* Atoms valid with and without `u`. */
static const char *ATOMS[] = {
    "a", "b", "k", "s", "K", "S", "-", " ", ".", "\\d", "\\w", "\\s", "\\D", "\\W", "\\S",
    "[ab]", "[^ab]", "[a-k]", "\\n",
    "\xc3\xa9",         /* é, two bytes */
    "\xc3\x89",         /* É */
    "\xc3\x9f",         /* ß */
    "\xe2\x80\x94",     /* —, three bytes */
    "\\u00e9", "\\u2014", "\\u2028", "\\u017f", "\\u212a", "\\u03c3", "\\u03c2", "\\u03a3",
    "[\\u00e0-\\u00ff]", "[^\\u2014]", "[\\u2014\\u2028a]", "[^a\\u00e9]", "[\\u0370-\\u03ff]",
    "[\\u017f]", "[^\\u212a]", "[k-s]", "[\\s\\u2014]",
    "\\ud83d", "\\ude00", "\\ud83d\\ude00", "[\\ud83d]", "[^\\ude00]", "[\\ud800-\\udbff]",
    "[\\udc00-\\udfff]",
};
/* Atoms that need `u`. */
static const char *UNICODE_ATOMS[] = {
    "\\u{1F600}", "\\u{1F64F}", "[\\u{1F600}-\\u{1F64F}]", "[^\\u{1F600}]", "\\p{L}", "\\P{L}",
    "\\p{Lu}", "[\\u{10000}-\\u{10FFFF}]", "\\u{e9}",
};
static const char *QUANTS[] = {"", "", "", "", "*", "+", "?", "*?", "+?", "??", "{2}", "{1,3}",
                               "{0,2}", "{2,}", "{1,2}?"};

static void gen_alt(Pat *p, int depth, bool unicode);

static void gen_term(Pat *p, int depth, bool unicode) {
  uint32_t r = rnd(100);
  if (r < 5) {
    put(p, "^");
    return;
  }
  if (r < 10) {
    put(p, "$");
    return;
  }
  if (r < 15) {
    put(p, rnd(2) ? "\\b" : "\\B");
    return;
  }
  if (r < 32 && depth < 2) {
    uint32_t kind = rnd(12);
    if (kind < 5) {
      p->groups++;
      put(p, "(");
    } else if (kind < 7) {
      put(p, "(?:");
    } else if (kind < 9) {
      put(p, rnd(2) ? "(?=" : "(?!");
    } else {
      put(p, rnd(2) ? "(?<=" : "(?<!");
    }
    gen_alt(p, depth + 1, unicode);
    put(p, ")");
    if (kind >= 7) return; /* a quantified lookaround is a syntax error under u */
  } else if (r < 38 && p->groups > 0) {
    char ref[8];
    snprintf(ref, sizeof ref, "\\%d", 1 + (int)rnd((uint32_t)p->groups));
    put(p, ref);
  } else if (unicode && r < 50) {
    put(p, UNICODE_ATOMS[rnd(sizeof UNICODE_ATOMS / sizeof UNICODE_ATOMS[0])]);
  } else {
    put(p, ATOMS[rnd(sizeof ATOMS / sizeof ATOMS[0])]);
  }
  put(p, QUANTS[rnd(sizeof QUANTS / sizeof QUANTS[0])]);
}

static void gen_seq(Pat *p, int depth, bool unicode) {
  int n = 1 + (int)rnd(depth == 0 ? 5 : 3);
  for (int i = 0; i < n; i++) gen_term(p, depth, unicode);
}

static void gen_alt(Pat *p, int depth, bool unicode) {
  gen_seq(p, depth, unicode);
  while (rnd(5) == 0) {
    put(p, "|");
    gen_seq(p, depth, unicode);
  }
}

/* The subject alphabet, as UTF-16 code units. A 0 entry stands for an
 * astral character (two units). */
static const uint16_t UNITS[] = {
    'a', 'a', 'b', 'k', 's', 'K', 'S', ' ', '-', '\n', '1', '_',
    0x00e9, 0x00c9, 0x00df, 0x017f, 0x212a, 0x2014, 0x2028, 0x03c3, 0x03c2, 0x03a3,
    0xd83d, 0xde00, 0xde4f, 0xd800, 0xdfff, 0, 0, 0,
};

enum { MAX_UNITS = 24 };

typedef struct {
  uint16_t units[MAX_UNITS + 1];
  int n;            /* UTF-16 units */
  uint8_t *bytes;   /* exactly nbytes + 1 bytes: the WTF-8 and its NUL */
  int nbytes;
  int pos[MAX_UNITS + 1]; /* the byte position of each unit index */
} Subject;

static void subject_encode(Subject *s) {
  uint8_t tmp[MAX_UNITS * 3 + 1];
  int o = 0;
  for (int i = 0; i < s->n; i++) {
    uint32_t c = s->units[i];
    s->pos[i] = o;
    if (c < 0x80) {
      tmp[o++] = (uint8_t)c;
    } else if (c < 0x800) {
      tmp[o++] = (uint8_t)(0xc0 | (c >> 6));
      tmp[o++] = (uint8_t)(0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s->n && s->units[i + 1] >= 0xdc00 &&
               s->units[i + 1] < 0xe000) {
      uint32_t cp = 0x10000 + ((c - 0xd800) << 10) + (s->units[i + 1] - 0xdc00);
      tmp[o++] = (uint8_t)(0xf0 | (cp >> 18));
      tmp[o++] = (uint8_t)(0x80 | ((cp >> 12) & 0x3f));
      s->pos[i + 1] = o; /* between the halves: the third byte */
      tmp[o++] = (uint8_t)(0x80 | ((cp >> 6) & 0x3f));
      tmp[o++] = (uint8_t)(0x80 | (cp & 0x3f));
      i++;
    } else {
      tmp[o++] = (uint8_t)(0xe0 | (c >> 12));
      tmp[o++] = (uint8_t)(0x80 | ((c >> 6) & 0x3f));
      tmp[o++] = (uint8_t)(0x80 | (c & 0x3f));
    }
  }
  s->pos[s->n] = o;
  s->nbytes = o;
  s->bytes = malloc((size_t)o + 1);
  if (!s->bytes) abort();
  memcpy(s->bytes, tmp, (size_t)o);
  s->bytes[o] = 0;
}

static void subject_random(Subject *s) {
  s->n = 0;
  int want = (int)rnd(MAX_UNITS - 1);
  while (s->n < want) {
    uint16_t u = UNITS[rnd(sizeof UNITS / sizeof UNITS[0])];
    if (u == 0) {
      s->units[s->n++] = 0xd83d;
      s->units[s->n++] = rnd(2) ? 0xde00 : 0xde4f;
    } else {
      s->units[s->n++] = u;
    }
  }
  subject_encode(s);
}

static void subject_print(const Subject *s) {
  for (int i = 0; i < s->n; i++) {
    uint16_t u = s->units[i];
    if (u >= 0x20 && u < 0x7f) fputc(u, stderr);
    else fprintf(stderr, "\\u%04x", u);
  }
}

static long matches, split_captures;

static int check(const uint8_t *bc, const char *pat, int flags, const Subject *s) {
  int alloc = lre_get_alloc_count(bc);
  int ncap = lre_get_capture_count(bc);
  uint8_t **ref = calloc((size_t)alloc + 1, sizeof *ref);
  uint8_t **got = calloc((size_t)alloc + 1, sizeof *got);
  if (!ref || !got) abort();
  int checks = 0;
  for (int start = 0; start <= s->n; start++) {
    lre_deadline = now_sec() + 0.002;
    int a = lre_exec(ref, bc, (const uint8_t *)s->units, start, s->n, 1, NULL);
    if (a < 0) break;
    lre_deadline = now_sec() + 1;
    int b = lre_exec(got, bc, s->bytes, s->pos[start], s->nbytes, 3, NULL);
    checks++;
    bool same = a == b;
    if (same && a == 1) {
      matches++;
      for (int k = 0; k < 2 * ncap; k++) {
        const uint8_t *want = NULL;
        if (ref[k]) {
          int unit = (int)((const uint16_t *)(const void *)ref[k] - s->units);
          want = s->bytes + s->pos[unit];
          if (unit > 0 && unit < s->n && s->pos[unit] == s->pos[unit - 1] + 2 &&
              (s->bytes[s->pos[unit]] & 0xc0) == 0x80)
            split_captures++;
        }
        if (want != got[k]) same = false;
      }
    }
    if (!same) {
      fprintf(stderr, "MISMATCH /%s/ flags=%d subject=\"", pat, flags);
      subject_print(s);
      fprintf(stderr, "\" start=%d 16-bit=%d wtf8=%d\n", start, a, b);
      for (int k = 0; k < 2 * ncap; k++) {
        long unit = ref[k] ? (long)((const uint16_t *)(const void *)ref[k] - s->units) : -1L;
        fprintf(stderr, "  slot %d: 16-bit unit %ld (byte %ld), wtf8 byte %ld\n", k, unit,
                unit < 0 ? -1L : (long)s->pos[unit], got[k] ? (long)(got[k] - s->bytes) : -1L);
      }
      free(ref);
      free(got);
      return -1;
    }
  }
  free(ref);
  free(got);
  return checks;
}

int main(int argc, char **argv) {
  int iterations = argc > 1 ? atoi(argv[1]) : 20000;
  rng_state = argc > 2 ? strtoull(argv[2], NULL, 10) : 0x9E3779B97F4A7C15ull;
  if (rng_state == 0) rng_state = 1;
  static const int FLAGSETS[] = {
      0,
      LRE_FLAG_IGNORECASE,
      LRE_FLAG_MULTILINE,
      LRE_FLAG_DOTALL,
      LRE_FLAG_UNICODE,
      LRE_FLAG_STICKY,
      LRE_FLAG_IGNORECASE | LRE_FLAG_UNICODE,
      LRE_FLAG_MULTILINE | LRE_FLAG_IGNORECASE,
      LRE_FLAG_DOTALL | LRE_FLAG_UNICODE | LRE_FLAG_STICKY,
      LRE_FLAG_GLOBAL | LRE_FLAG_STICKY | LRE_FLAG_MULTILINE,
      LRE_FLAG_UNICODE | LRE_FLAG_MULTILINE,
      LRE_FLAG_IGNORECASE | LRE_FLAG_STICKY,
  };
  long compiled = 0, checks = 0;
  for (int it = 0; it < iterations; it++) {
    int flags = FLAGSETS[rnd(sizeof FLAGSETS / sizeof FLAGSETS[0])];
    Pat p = {{0}, 0, 0};
    gen_alt(&p, 0, (flags & LRE_FLAG_UNICODE) != 0);
    p.buf[p.len] = '\0';
    char err[64];
    int bc_len;
    uint8_t *bc = lre_compile(&bc_len, err, sizeof err, p.buf, (size_t)p.len, flags, NULL);
    if (!bc) continue;
    compiled++;
    if (getenv("FUZZ_TRACE")) fprintf(stderr, "%d /%s/ %d\n", it, p.buf, flags);
    for (int k = 0; k < 6; k++) {
      Subject s;
      subject_random(&s);
      int c = check(bc, p.buf, flags, &s);
      free(s.bytes);
      if (c < 0) return 1;
      checks += c;
    }
    free(bc);
  }
  /* Fixed shapes: a match that stops between the halves of a pair, a
   * lookbehind that steps back over one, case folding across widths, and
   * back references to text of each width. */
  static const struct {
    const char *pat;
    int flags;
    uint16_t units[12];
    int n;
  } FIXED[] = {
      {".", 0, {0xd83d, 0xde00}, 2},
      {".", LRE_FLAG_UNICODE, {0xd83d, 0xde00}, 2},
      {"^.$", 0, {0xd83d, 0xde00}, 2},
      {"^.$", LRE_FLAG_UNICODE, {0xd83d, 0xde00}, 2},
      {"\\ud83d", 0, {'a', 0xd83d, 0xde00, 'b'}, 4},
      {"\\ud83d", LRE_FLAG_UNICODE, {'a', 0xd83d, 0xde00, 'b'}, 4},
      {"\\ude00", 0, {'a', 0xd83d, 0xde00, 'b'}, 4},
      {"(?<=\\ud83d)\\ude00", 0, {'a', 0xd83d, 0xde00, 'b'}, 4},
      {"(?<=\\ud83d).", 0, {0xd83d, 0xde00, 0xd83d, 'x'}, 4},
      {"(?<=(.))b", LRE_FLAG_UNICODE, {0xd83d, 0xde00, 'b'}, 3},
      {"(?<!\\u2014)a", 0, {0x2014, 'a', 0xe9, 'a'}, 4},
      {"(.)\\1", 0, {0xd83d, 0xde00, 0xd83d, 0xde00, 0xde00}, 5},
      {"(.)\\1", LRE_FLAG_UNICODE, {0xd83d, 0xde00, 0xd83d, 0xde00, 0xde00}, 5},
      {"(\\u00e9|\\u2014)+\\1", 0, {'a', 0xe9, 0x2014, 0x2014, 'b'}, 5},
      {"(?<=\\1(.))x", 0, {0xe9, 0xe9, 'x', 0x2014, 0x2014, 'x'}, 6},
      {"k+", LRE_FLAG_IGNORECASE | LRE_FLAG_UNICODE, {'k', 0x212a, 'K', 0x2014}, 4},
      {"k+", LRE_FLAG_IGNORECASE, {'k', 0x212a, 'K', 0x2014}, 4},
      {"\\u03c3+", LRE_FLAG_IGNORECASE, {0x03a3, 0x03c3, 0x03c2, 'a'}, 4},
      {"\\u00df", LRE_FLAG_IGNORECASE | LRE_FLAG_UNICODE, {'s', 's', 0xdf, 0x1e9e}, 4},
      {"\\w+", LRE_FLAG_IGNORECASE | LRE_FLAG_UNICODE, {'a', 0x017f, 0x212a, 0x2014}, 4},
      {"\\b.", 0, {0x2014, 'a', 0xd83d, 0xde00, 'b'}, 5},
      {"^.", LRE_FLAG_MULTILINE, {0x2014, 0x2028, 0xd83d, 0xde00, '\n', 0xe9}, 6},
      {".$", LRE_FLAG_MULTILINE, {0x2014, 0x2028, 0xd83d, 0xde00, '\n', 0xe9}, 6},
      {"[^a]", LRE_FLAG_STICKY, {'a', 0xd83d, 0xde00}, 3},
      {"[\\ud800-\\udbff][\\udc00-\\udfff]", 0, {0xd83d, 0xde00, 0xd800, 0xdfff}, 4},
      {"\\udfff", 0, {0xdfff, 0xd800, 0xdfff}, 3},
      {"", 0, {0xd83d, 0xde00}, 2},
      {"", LRE_FLAG_UNICODE, {0xd83d, 0xde00}, 2},
  };
  for (size_t i = 0; i < sizeof FIXED / sizeof FIXED[0]; i++) {
    char err[64];
    int bc_len;
    uint8_t *bc = lre_compile(&bc_len, err, sizeof err, FIXED[i].pat, strlen(FIXED[i].pat),
                              FIXED[i].flags, NULL);
    if (!bc) {
      fprintf(stderr, "fixed pattern failed to compile: %s: %s\n", FIXED[i].pat, err);
      return 1;
    }
    Subject s;
    s.n = FIXED[i].n;
    memcpy(s.units, FIXED[i].units, sizeof FIXED[i].units);
    subject_encode(&s);
    int c = check(bc, FIXED[i].pat, FIXED[i].flags, &s);
    free(s.bytes);
    if (c < 0) return 1;
    checks += c;
    free(bc);
  }
  fprintf(stderr, "%ld patterns, %ld checks, %ld matches, %ld captures between the halves of a pair\n",
          compiled, checks, matches, split_captures);
  return 0;
}
