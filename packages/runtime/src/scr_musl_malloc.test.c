/* The musl lane's malloc family (scr_musl_malloc.h): every size class and
 * the boundaries between them, calloc on recycled blocks, realloc growth
 * and shrinking across classes and into mappings of their own (contents
 * kept), aligned allocation up to and beyond the page size, the error
 * results, threads that allocate and free each other's blocks, blocks
 * handed back to their owner after a thread exits or goes idle, and fork
 * while other threads allocate.
 *
 * Built with SCR_MUSL_MALLOC_LIBC, it defines the libc names over the
 * prefixed functions (as scr_musl.c does) and uses those, so a static musl
 * build exercises the replacement of zig's allocator. */
#include "scr_musl_malloc.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef SCR_MUSL_MALLOC_LIBC
#define NB __attribute__((no_builtin))
NB void *malloc(size_t n) { return scr_musl_malloc(n); }
NB void *calloc(size_t m, size_t n) { return scr_musl_calloc(m, n); }
NB void *realloc(void *p, size_t n) { return scr_musl_realloc(p, n); }
NB void *reallocarray(void *p, size_t m, size_t n) { return scr_musl_reallocarray(p, m, n); }
NB void free(void *p) { scr_musl_free(p); }
NB size_t malloc_usable_size(void *p) { return scr_musl_malloc_usable_size(p); }
NB void *aligned_alloc(size_t align, size_t n) { return scr_musl_aligned_alloc(align, n); }
NB void *memalign(size_t align, size_t n) { return scr_musl_aligned_alloc(align, n); }
NB void *valloc(size_t n) { return scr_musl_aligned_alloc(SCR_MM_PAGE, n); }
NB int posix_memalign(void **out, size_t align, size_t n) { return scr_musl_posix_memalign(out, align, n); }
#endif

/* Checks stay on in optimized builds (NDEBUG). */
#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
      abort();                                                                   \
    }                                                                            \
  } while (0)

static unsigned long next_rand(unsigned long *s) {
  *s ^= *s << 13;
  *s ^= *s >> 7;
  *s ^= *s << 17;
  return *s;
}

static void fill(unsigned char *p, size_t n, unsigned seed) {
  for (size_t i = 0; i < n; i++) p[i] = (unsigned char)(seed + i * 7);
}
static int filled(const unsigned char *p, size_t n, unsigned seed) {
  for (size_t i = 0; i < n; i++)
    if (p[i] != (unsigned char)(seed + i * 7)) return 0;
  return 1;
}

static void check_classes(void) {
  for (unsigned c = 0; c < SCR_MM_NCLASS; c++) {
    size_t sz = scr_mm_class_size(c);
    CHECK(sz % 16 == 0);
    CHECK(scr_mm_class(sz) == c);
    if (c > 0) CHECK(scr_mm_class(scr_mm_class_size(c - 1) + 1) == c);
  }
  CHECK(scr_mm_class_size(SCR_MM_NCLASS - 1) == SCR_MM_SMALL_MAX);
}

/* Sizes around every class boundary and around the mapping threshold. */
static void check_sizes(void) {
  for (unsigned c = 0; c < SCR_MM_NCLASS; c++) {
    size_t sz = scr_mm_class_size(c);
    for (size_t n = sz > 2 ? sz - 2 : 1; n <= sz + 2; n++) {
      unsigned char *p = scr_musl_malloc(n);
      CHECK(p && ((uintptr_t)p & 15) == 0);
      CHECK(scr_musl_malloc_usable_size(p) >= n);
      fill(p, n, (unsigned)n);
      unsigned char *q = scr_musl_calloc(1, n);
      CHECK(q);
      for (size_t i = 0; i < n; i++) CHECK(q[i] == 0);
      CHECK(filled(p, n, (unsigned)n));
      scr_musl_free(q);
      scr_musl_free(p);
      /* A recycled block comes back cleared from calloc. */
      p = scr_musl_malloc(n);
      memset(p, 0xa5, n);
      scr_musl_free(p);
      q = scr_musl_calloc(n, 1);
      for (size_t i = 0; i < n; i++) CHECK(q[i] == 0);
      scr_musl_free(q);
    }
  }
  unsigned char *big = scr_musl_malloc(SCR_MM_SMALL_MAX * 3 + 5);
  CHECK(big && ((uintptr_t)big & 15) == 0);
  CHECK(scr_musl_malloc_usable_size(big) >= SCR_MM_SMALL_MAX * 3 + 5);
  scr_musl_free(big);
  void *zero = scr_musl_malloc(0);
  CHECK(zero);
  scr_musl_free(zero);
  scr_musl_free(NULL);
  CHECK(scr_musl_malloc_usable_size(NULL) == 0);
}

static void check_realloc(void) {
  static const size_t steps[] = {1, 17, 100, 129, 1000, 5000, 70000, 300000, 1048576,
                                 1048577, 3000000, 9000000, 2000000, 600000, 40, 3};
  unsigned char *p = NULL;
  size_t have = 0;
  for (size_t i = 0; i < sizeof steps / sizeof steps[0]; i++) {
    size_t n = steps[i];
    p = scr_musl_realloc(p, n);
    CHECK(p && ((uintptr_t)p & 15) == 0);
    CHECK(filled(p, have < n ? have : n, 3));
    fill(p, n, 3);
    have = n;
  }
  CHECK(scr_musl_realloc(p, 0) == NULL);
  size_t overflow = (size_t)1 << (sizeof(size_t) * 4);
  errno = 0;
  CHECK(scr_musl_calloc(overflow, overflow) == NULL && errno == ENOMEM);
  errno = 0;
  CHECK(scr_musl_reallocarray(NULL, overflow, overflow) == NULL && errno == ENOMEM);
  errno = 0;
  CHECK(scr_musl_malloc(SIZE_MAX - 64) == NULL && errno == ENOMEM);
}

static void check_aligned(void) {
  for (size_t align = 1; align <= ((size_t)1 << 16); align <<= 1) {
    static const size_t sizes[] = {0, 1, 24, 100, 4096, 5000, 70000, 2000000};
    for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
      unsigned char *p = scr_musl_aligned_alloc(align, sizes[i]);
      CHECK(p && ((uintptr_t)p & (align - 1)) == 0 && ((uintptr_t)p & 15) == 0);
      fill(p, sizes[i], 9);
      CHECK(scr_musl_malloc_usable_size(p) >= sizes[i]);
      p = scr_musl_realloc(p, sizes[i] * 2 + 1);
      CHECK(p && filled(p, sizes[i], 9));
      scr_musl_free(p);
      void *q = NULL;
      if (align >= sizeof(void *)) {
        CHECK(scr_musl_posix_memalign(&q, align, sizes[i]) == 0);
        CHECK(((uintptr_t)q & (align - 1)) == 0);
        scr_musl_free(q);
      } else {
        CHECK(scr_musl_posix_memalign(&q, align, sizes[i]) == EINVAL);
      }
    }
  }
  void *q = NULL;
  CHECK(scr_musl_posix_memalign(&q, 24, 8) == EINVAL);
  errno = 0;
  CHECK(scr_musl_aligned_alloc(24, 8) == NULL && errno == EINVAL);
}

#define SLOTS 1024
static _Atomic(void *) handoff[SLOTS];

static void *worker(void *arg) {
  unsigned long s = (uintptr_t)arg * 2654435761u + 1;
  enum { KEEP = 128 };
  unsigned char *mine[KEEP] = {0};
  size_t len[KEEP] = {0};
  for (int i = 0; i < 200000; i++) {
    unsigned k = (unsigned)(next_rand(&s) % KEEP);
    if (mine[k]) CHECK(filled(mine[k], len[k], k));
    unsigned op = (unsigned)(next_rand(&s) % 8);
    if (op < 4) {
      scr_musl_free(mine[k]);
      len[k] = next_rand(&s) % (next_rand(&s) % 16 == 0 ? 200000 : 700);
      mine[k] = op & 1 ? scr_musl_calloc(1, len[k]) : scr_musl_malloc(len[k]);
      CHECK(mine[k]);
    } else if (op < 6) {
      size_t n = next_rand(&s) % 4000;
      mine[k] = scr_musl_realloc(mine[k], n ? n : 1);
      CHECK(mine[k] && filled(mine[k], len[k] < n ? len[k] : n, k));
      len[k] = n ? n : 1;
    } else {
      /* Another thread frees this block. */
      void *p = scr_musl_malloc(next_rand(&s) % 2000 + 1);
      CHECK(p);
      scr_musl_free(atomic_exchange(&handoff[next_rand(&s) % SLOTS], p));
      continue;
    }
    fill(mine[k], len[k], k);
  }
  for (unsigned k = 0; k < KEEP; k++) scr_musl_free(mine[k]);
  return NULL;
}

static void check_threads_and_fork(void) {
  pthread_t t[6];
  for (uintptr_t i = 0; i < 6; i++) CHECK(pthread_create(&t[i], NULL, worker, (void *)(i + 1)) == 0);
  for (int f = 0; f < 10; f++) {
    pid_t pid = fork();
    CHECK(pid >= 0);
    if (pid == 0) {
      void *p = scr_musl_malloc(100);
      void *q = scr_musl_malloc(3000000);
      scr_musl_free(p);
      scr_musl_free(q);
      _exit(p && q ? 0 : 1);
    }
    int status;
    CHECK(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  }
  for (int i = 0; i < 6; i++) CHECK(pthread_join(t[i], NULL) == 0);
  for (int i = 0; i < SLOTS; i++) scr_musl_free(atomic_exchange(&handoff[i], NULL));
}

/* Blocks one thread frees for another come back to the owner: after the
 * freeing thread exits, and after its event loop waits twice while it
 * lives on. */
enum { HANDED = 10, HANDED_SIZE = 3000 };
static void *handed[HANDED];
static _Atomic int freer_stage;

static void *exiting_freer(void *arg) {
  (void)arg;
  for (int i = 0; i < HANDED; i++) scr_musl_free(handed[i]);
  return NULL;
}

static void *idle_freer(void *arg) {
  (void)arg;
  for (int i = 0; i < HANDED; i++) scr_musl_free(handed[i]);
  scr_mm_idle(); /* freed since the last wait: still held */
  scr_mm_idle(); /* nothing freed since: handed back */
  atomic_store(&freer_stage, 1);
  while (atomic_load(&freer_stage) != 2) sched_yield();
  return NULL;
}

/* Allocates blocks of the handed size until every handed block came back. */
static void expect_handed_back(void) {
  enum { LIMIT = 20000 };
  static void *got[LIMIT];
  int seen = 0, n = 0;
  while (seen < HANDED && n < LIMIT) {
    void *p = got[n++] = scr_musl_malloc(HANDED_SIZE);
    for (int i = 0; i < HANDED; i++)
      if (p == handed[i]) seen++;
  }
  CHECK(seen == HANDED);
  for (int i = 0; i < n; i++) scr_musl_free(got[i]);
}

static void check_remote_frees(void) {
  pthread_t t;
  for (int i = 0; i < HANDED; i++) handed[i] = scr_musl_malloc(HANDED_SIZE);
  CHECK(pthread_create(&t, NULL, exiting_freer, NULL) == 0);
  CHECK(pthread_join(t, NULL) == 0);
  expect_handed_back();
  for (int i = 0; i < HANDED; i++) handed[i] = scr_musl_malloc(HANDED_SIZE);
  CHECK(pthread_create(&t, NULL, idle_freer, NULL) == 0);
  while (atomic_load(&freer_stage) != 1) sched_yield();
  expect_handed_back();
  atomic_store(&freer_stage, 2);
  CHECK(pthread_join(t, NULL) == 0);
}

int main(void) {
  check_classes();
  check_sizes();
  check_realloc();
  check_aligned();
  check_threads_and_fork();
  check_remote_frees();
  puts("ok");
  return 0;
}
