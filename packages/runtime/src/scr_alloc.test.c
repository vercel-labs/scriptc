/* White-box checks for the small-object allocator (scr_alloc.c). Built by
 * scr_alloc.test.ts without ASan (the size-class allocator is live), with
 * ASan (every call must reach the system allocator), and as a worker
 * executable's allocator (per-thread arenas, also under ThreadSanitizer). */
#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>

#if SCR_SMALL_ALLOC
static bool owned(const void *p) { return (uintptr_t)p - scr_sa.base < scr_sa.span; }
#endif

static void fill(unsigned char *p, size_t n, unsigned char seed) {
  for (size_t i = 0; i < n; i++) p[i] = (unsigned char)(seed + i * 7);
}

static void verify(const unsigned char *p, size_t n, unsigned char seed) {
  for (size_t i = 0; i < n; i++) assert(p[i] == (unsigned char)(seed + i * 7));
}

static void check_alignment_and_zeroing(void) {
  for (size_t n = 1; n <= 600; n++) {
    unsigned char *p = scr_mem_calloc(n);
    assert(p && ((uintptr_t)p & 15) == 0);
    for (size_t i = 0; i < n; i++) assert(p[i] == 0);
    fill(p, n, (unsigned char)n);
    scr_mem_free(p);
    /* A recycled block (same class, LIFO) must come back zeroed. */
    unsigned char *q = scr_mem_calloc(n);
    assert(q && ((uintptr_t)q & 15) == 0);
    for (size_t i = 0; i < n; i++) assert(q[i] == 0);
#if SCR_SMALL_ALLOC
    if (n <= SCR_SA_MAX) assert(q == p && owned(q));
    else assert(!owned(q));
#endif
    scr_mem_free(q);
  }
}

static void check_realloc(void) {
  unsigned char *p = scr_mem_realloc(NULL, 10);
  fill(p, 10, 3);
  size_t sizes[] = {12, 16, 17, 100, 512, 513, 4000, 300, 40, 7};
  size_t live = 10;
  for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
    size_t n = sizes[i];
    p = scr_mem_realloc(p, n);
    assert(p && ((uintptr_t)p & 15) == 0);
    verify(p, live < n ? live : n, 3);
    fill(p, n, 3);
    live = n;
  }
  scr_mem_free(p);
}

static void check_system_pointers(void) {
  /* scr_mem_free / scr_mem_realloc accept blocks the system allocated. */
  void *a = malloc(32), *b = calloc(1, 4096), *c = malloc(24);
  assert(a && b && c);
  scr_mem_free(a);
  b = scr_mem_realloc(b, 8192);
  assert(b);
  scr_mem_free(b);
  c = scr_mem_realloc(c, 64);
  assert(c);
  scr_mem_free(c);
  scr_mem_free(NULL);
  scr_mem_free(scr_mem_alloc(0)); /* malloc(0) contract: NULL or freeable */
}

/* Interleaved alloc/free across every class: blocks never overlap and a
 * live block's contents survive unrelated traffic. */
static void check_churn(void) {
  enum { SLOTS = 4096 };
  static unsigned char *slot[SLOTS];
  static size_t len[SLOTS];
  uint32_t x = 0x9e3779b9u;
  for (unsigned round = 0; round < 400000; round++) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    unsigned i = x % SLOTS;
    if (slot[i]) {
      verify(slot[i], len[i], (unsigned char)i);
      scr_rt_free(slot[i]);
      slot[i] = NULL;
    } else {
      len[i] = 1 + (x >> 12) % 700;
      slot[i] = (x & 1) ? scr_rt_calloc(len[i]) : scr_mem_alloc(len[i]);
      assert(slot[i]);
      fill(slot[i], len[i], (unsigned char)i);
    }
  }
  for (unsigned i = 0; i < SLOTS; i++) {
    if (!slot[i]) continue;
    verify(slot[i], len[i], (unsigned char)i);
    scr_mem_free(slot[i]);
  }
}

#if SCR_SMALL_ALLOC
#include <string.h>
#ifdef __linux__
/* The VmFlags line of the mapping that contains p, or "". */
static void vm_flags(const void *p, char *out, size_t cap) {
  out[0] = '\0';
  FILE *f = fopen("/proc/self/smaps", "r");
  assert(f);
  char line[512];
  bool inside = false;
  while (fgets(line, sizeof line, f)) {
    unsigned long lo, hi;
    if (sscanf(line, "%lx-%lx ", &lo, &hi) == 2 && strchr(line, '-') < strchr(line, ' ')) {
      inside = (uintptr_t)p >= lo && (uintptr_t)p < hi;
    } else if (inside && !strncmp(line, "VmFlags:", 8)) {
      snprintf(out, cap, "%s", line + 8);
      break;
    }
  }
  fclose(f);
}
#endif

/* A class slice carves contiguously from its start, across the point where
 * its limit is raised; on Linux the slices are huge-page aligned, the first
 * 8 MiB of a slice stay on small pages and the rest may use huge pages. */
static void check_slice_growth(void) {
  enum { SZ = 496, AFTER = 8 << 20 };
  unsigned char *first = scr_mem_alloc(SZ), *prev = first;
  assert(owned(first));
  uintptr_t start = scr_sa.base + ((uintptr_t)((SZ - 1) / SCR_SA_STEP) << scr_sa.shift);
  assert((uintptr_t)first == start); /* a class nothing else has touched */
  size_t blocks = AFTER / SZ + 64;
  for (size_t i = 1; i < blocks; i++) {
    unsigned char *p = scr_mem_alloc(SZ);
    assert(p == prev + SZ);
    p[0] = (unsigned char)i; /* commit the pages */
    prev = p;
  }
#ifdef __linux__
  assert((scr_sa.base & ((2u << 20) - 1)) == 0);
  FILE *thp = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (thp) { /* a kernel without THP refuses both advices */
    fclose(thp);
    char flags[256];
    vm_flags(first, flags, sizeof flags);
    assert(strstr(flags, " nh") && !strstr(flags, " hg"));
    vm_flags((void *)(start + AFTER), flags, sizeof flags);
    assert(strstr(flags, " hg") && !strstr(flags, " nh"));
  }
#endif
  /* The blocks recycle through the free list like any others. */
  for (size_t i = blocks; i-- > 0;) scr_mem_free(first + i * SZ);
  assert(scr_mem_alloc(SZ) == first);
  scr_mem_free(first);
}
#endif

#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC
#include <pthread.h>

/* Script threads own disjoint arenas; blocks freed by another thread return
 * to their owner through its remote list, and an exiting thread's arena
 * (free lists included) passes to the next thread that claims one. */
enum { HANDOFF = 256 };
static void *handoff[HANDOFF];
static void *handed[HANDOFF]; /* the addresses, kept after the frees */
static uintptr_t worker_base;

static void *alloc_and_hand_off(void *arg) {
  (void)arg;
  for (unsigned i = 0; i < HANDOFF; i++) {
    handoff[i] = scr_mem_calloc(48);
    assert(handoff[i] && owned(handoff[i]));
    handed[i] = handoff[i];
    fill(handoff[i], 48, (unsigned char)i);
  }
  worker_base = scr_sa.base;
  scr_sa_thread_park();
  return NULL;
}

static void *reclaim_arena(void *arg) {
  (void)arg;
  /* The parked arena is the only free one besides main's: claimed again,
   * with the main thread's remote frees drained into its free lists. */
  void *p = scr_mem_alloc(48);
  assert(scr_sa.base == worker_base);
  bool recycled = false;
  for (unsigned i = 0; i < HANDOFF; i++) recycled |= p == handed[i];
  assert(recycled);
  scr_mem_free(p);
  scr_sa_thread_park();
  return NULL;
}

static void check_threads(void) {
  void *mine = scr_mem_alloc(48);
  assert(owned(mine));
  pthread_t t;
  assert(pthread_create(&t, NULL, alloc_and_hand_off, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  assert(worker_base != scr_sa.base);
  for (unsigned i = 0; i < HANDOFF; i++) {
    assert(!owned(handoff[i]));
    verify(handoff[i], 48, (unsigned char)i);
    if (i == 0) {
      handoff[0] = scr_mem_realloc(handoff[0], 600); /* moves to the system */
      verify(handoff[0], 48, 0);
      free(handoff[0]);
      handoff[0] = NULL;
    } else scr_mem_free(handoff[i]); /* remote free */
  }
  assert(pthread_create(&t, NULL, reclaim_arena, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  scr_mem_free(mine);
}
#endif

int main(void) {
#if SCR_SMALL_ALLOC
  check_slice_growth(); /* first: its class must be untouched */
#endif
  check_alignment_and_zeroing();
  check_realloc();
  check_system_pointers();
  check_churn();
#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC
  check_threads();
  printf("allocator checks passed: size-class workers\n");
#else
  printf("allocator checks passed: %s\n", SCR_SMALL_ALLOC ? "size-class" : "system");
#endif
  return 0;
}
