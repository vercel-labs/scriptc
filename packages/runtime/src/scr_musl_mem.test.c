/* The x86_64 musl lane's memory and string routines (scr_musl_mem.h)
 * against byte-loop references: every length up to 600 and a set of long
 * ones (across the rep threshold), every source and destination alignment
 * in a 32-byte window, overlapping moves in both directions, memcmp's sign
 * at every position, and strlen up to the end of a readable page. */
#include "scr_musl_mem.h"

#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

/* Checks stay on in optimized builds (NDEBUG). */
#define CHECK(cond)                                                       \
  do {                                                                    \
    if (!(cond)) {                                                        \
      fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
      abort();                                                            \
    }                                                                     \
  } while (0)

static unsigned seed = 12345;
static unsigned char next_byte(void) {
  seed = seed * 1103515245u + 12345u;
  return (unsigned char)(seed >> 16);
}

static const size_t long_lengths[] = {1000, 2047, 2048, 2049, 4095, 4096, 5003, 65536, 70001};

static void check_lengths(void (*check)(size_t)) {
  for (size_t n = 0; n <= 600; n++) check(n);
  for (size_t i = 0; i < sizeof long_lengths / sizeof long_lengths[0]; i++) check(long_lengths[i]);
}

enum { PAD = 64, WINDOW = 32 };

static void check_memset(size_t n) {
  size_t cap = n + 2 * PAD + WINDOW;
  unsigned char *buf = malloc(cap), *ref = malloc(cap);
  for (size_t off = 0; off < WINDOW; off += n > 600 ? 7 : 1) {
    for (size_t i = 0; i < cap; i++) buf[i] = ref[i] = next_byte();
    int c = next_byte();
    for (size_t i = 0; i < n; i++) ref[PAD + off + i] = (unsigned char)c;
    void *r = scr_musl_memset(buf + PAD + off, c, n);
    CHECK(r == buf + PAD + off);
    for (size_t i = 0; i < cap; i++) CHECK(buf[i] == ref[i]);
  }
  free(buf);
  free(ref);
}

static void check_memcpy(size_t n) {
  size_t cap = n + 2 * PAD + WINDOW;
  unsigned char *src = malloc(cap), *dst = malloc(cap), *ref = malloc(cap);
  int step = n > 600 ? 5 : 1;
  for (size_t so = 0; so < 16; so += step) {
    for (size_t doff = 0; doff < 16; doff += step) {
      for (size_t i = 0; i < cap; i++) {
        src[i] = next_byte();
        dst[i] = ref[i] = next_byte();
      }
      for (size_t i = 0; i < n; i++) ref[PAD + doff + i] = src[PAD + so + i];
      void *r = scr_musl_memcpy(dst + PAD + doff, src + PAD + so, n);
      CHECK(r == dst + PAD + doff);
      for (size_t i = 0; i < cap; i++) CHECK(dst[i] == ref[i]);
    }
  }
  free(src);
  free(dst);
  free(ref);
}

/* Overlapping and disjoint moves inside one buffer, in both directions. */
static void check_memmove(size_t n) {
  size_t cap = 2 * n + 2 * PAD + 2 * WINDOW;
  unsigned char *buf = malloc(cap), *ref = malloc(cap), *tmp = malloc(n + 1);
  static const long shifts[] = {-40, -17, -16, -15, -8, -3, -1, 0, 1, 3, 8, 15, 16, 17, 40};
  for (size_t k = 0; k < sizeof shifts / sizeof shifts[0]; k++) {
    for (size_t base = 0; base < 16; base += n > 600 ? 5 : 3) {
      long shift = shifts[k];
      size_t s = PAD + WINDOW + base, d = (size_t)((long)s + shift);
      for (size_t i = 0; i < cap; i++) buf[i] = ref[i] = next_byte();
      for (size_t i = 0; i < n; i++) tmp[i] = ref[s + i];
      for (size_t i = 0; i < n; i++) ref[d + i] = tmp[i];
      void *r = scr_musl_memmove(buf + d, buf + s, n);
      CHECK(r == buf + d);
      for (size_t i = 0; i < cap; i++) CHECK(buf[i] == ref[i]);
    }
  }
  free(buf);
  free(ref);
  free(tmp);
}

static int sign(int v) { return (v > 0) - (v < 0); }

static void check_memcmp(size_t n) {
  unsigned char *a = malloc(n + 2 * WINDOW), *b = malloc(n + 2 * WINDOW);
  for (size_t ao = 0; ao < 4; ao++) {
    size_t bo = (ao * 5) % 16;
    for (size_t i = 0; i < n; i++) a[ao + i] = b[bo + i] = next_byte();
    CHECK(scr_musl_memcmp(a + ao, b + bo, n) == 0);
    size_t positions = n > 600 ? 9 : n;
    for (size_t j = 0; j < positions; j++) {
      size_t pos = n > 600 ? (n - 1) * j / 8 : j;
      unsigned char saved = b[bo + pos];
      unsigned char other = (unsigned char)(saved + 1 + next_byte() % 255);
      b[bo + pos] = other;
      int want = (int)a[ao + pos] - (int)other;
      int got = scr_musl_memcmp(a + ao, b + bo, n);
      CHECK(sign(got) == sign(want) && got != 0);
      b[bo + pos] = saved;
    }
  }
  free(a);
  free(b);
}

/* Strings ending at every offset before an unreadable page. */
static void check_strlen(void) {
  long page = sysconf(_SC_PAGESIZE);
  unsigned char *map = mmap(NULL, (size_t)page * 2, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  CHECK(map != MAP_FAILED);
  CHECK(mprotect(map + page, (size_t)page, PROT_NONE) == 0);
  for (size_t len = 0; len < 300; len++) {
    for (size_t end = 1; end <= 40; end++) {
      unsigned char *term = map + page - end;
      if ((size_t)(term - map) < len) continue;
      unsigned char *start = term - len;
      for (unsigned char *p = map; p < map + page; p++) *p = (unsigned char)(1 + next_byte() % 255);
      *term = 0;
      CHECK(scr_musl_strlen((const char *)start) == len);
    }
  }
  munmap(map, (size_t)page * 2);
}

int main(void) {
  check_lengths(check_memset);
  check_lengths(check_memcpy);
  check_lengths(check_memmove);
  check_lengths(check_memcmp);
  check_strlen();
  puts("ok");
  return 0;
}
