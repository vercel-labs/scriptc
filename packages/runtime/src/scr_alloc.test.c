/* White-box checks for the small-object allocator (scr_alloc.c). Built by
 * scr_alloc.test.ts without ASan (the size-class allocator is live), with
 * ASan (every call must reach the system allocator), and as a worker
 * executable's allocator (per-thread arenas, also under ThreadSanitizer). */
#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>

#if SCR_SMALL_ALLOC
/* Whether p is a block of the calling thread's arena: in the window, in a
 * chunk that carries the thread's tag. */
static bool owned(const void *p) {
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  return off < scr_sa.span && (scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT] & 0xff00) == scr_sa.tag;
}
/* The size class of a block of the calling thread's arena. */
static unsigned class_of(const void *p) {
  return scr_sa_chunks[((uintptr_t)p - scr_sa.base) >> SCR_SA_CHUNK_SHIFT] & 0xff;
}
/* The start of the window chunk holding p. */
static uintptr_t chunk_of(const void *p) {
  return scr_sa.base + (((uintptr_t)p - scr_sa.base) & ~(uintptr_t)(SCR_SA_CHUNK - 1));
}
#endif

/* The allocator unit needs only scr_trap from the rest of the runtime: the
 * program-lifetime region stops the program through it. */
_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  abort();
}

static void fill(unsigned char *p, size_t n, unsigned char seed) {
  for (size_t i = 0; i < n; i++) p[i] = (unsigned char)(seed + i * 7);
}

static void verify(const unsigned char *p, size_t n, unsigned char seed) {
  for (size_t i = 0; i < n; i++) assert(p[i] == (unsigned char)(seed + i * 7));
}

/* Blocks are 8-byte aligned, and 16-byte aligned for multiples of 16. */
static bool aligned(const void *p, size_t n) {
  return ((uintptr_t)p & (n % 16 ? 7 : 15)) == 0;
}

/* Classes step by 8 bytes up to SCR_SA_FINE_MAX and by 16 above it; the
 * class of 49 to 56-byte requests holds 64-byte blocks. */
static void check_classes(void) {
  unsigned prev = 0;
  for (size_t n = 1; n <= SCR_SA_MAX; n++) {
    unsigned c = scr_sa_class(n);
    size_t sz = scr_sa_class_size(c), step = n <= SCR_SA_FINE_MAX ? 8u : 16u;
    assert(c < SCR_SA_NCLASS && (c == prev || c == prev + 1));
    if (n > 48 && n <= 56) assert(sz == 64);
    else assert(sz >= n && sz - n < step && sz % step == 0);
    prev = c;
  }
  assert(scr_sa_class(SCR_SA_MAX) == SCR_SA_NCLASS - 1);
  assert(scr_sa_class_size(SCR_SA_NCLASS - 1) == SCR_SA_MAX);
}

static void check_alignment_and_zeroing(void) {
  for (size_t n = 1; n <= 600; n++) {
    unsigned char *p = scr_mem_calloc(n);
    assert(p && aligned(p, n));
    for (size_t i = 0; i < n; i++) assert(p[i] == 0);
    fill(p, n, (unsigned char)n);
    scr_mem_free(p);
    /* A recycled block (same class, LIFO) must come back zeroed. */
    unsigned char *q = scr_mem_calloc(n);
    assert(q && aligned(q, n));
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
  size_t sizes[] = {12, 16, 17, 100, 512, 513, 4000, 300, 40, 24, 16, 7};
  size_t live = 10;
  for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
    size_t n = sizes[i];
    p = scr_mem_realloc(p, n);
    assert(p && aligned(p, n));
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

/* scr_mem_order_for_free keeps every pointer, puts system blocks first and
 * each class's blocks in descending address order, and freeing in that
 * order hands each class's blocks back in ascending address order. Builds
 * without the size-class allocator leave the array as it is. */
static int compare_pointers(const void *a, const void *b) {
  uintptr_t x = (uintptr_t)*(void *const *)a, y = (uintptr_t)*(void *const *)b;
  return x < y ? -1 : x > y;
}

static void check_free_order(void) {
  enum { BLOCKS = 12000, SYSTEM = 64, N = BLOCKS + SYSTEM };
  static void *ptrs[N], *before[N], *a[N], *b[N];
  const size_t sizes[2] = {32, 96};
  for (size_t i = 0; i < BLOCKS; i++) ptrs[i] = scr_mem_alloc(sizes[i % 2]);
  for (size_t i = BLOCKS; i < N; i++) ptrs[i] = malloc(1024);
  uint32_t x = 0x2545f491u;
  for (size_t i = N - 1; i > 0; i--) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    size_t j = x % (i + 1);
    void *t = ptrs[i];
    ptrs[i] = ptrs[j];
    ptrs[j] = t;
  }
  memcpy(before, ptrs, sizeof ptrs);
  scr_mem_order_for_free(ptrs, N, 0);
  memcpy(a, ptrs, sizeof ptrs);
  memcpy(b, before, sizeof before);
  qsort(a, N, sizeof *a, compare_pointers);
  qsort(b, N, sizeof *b, compare_pointers);
  assert(memcmp(a, b, sizeof a) == 0);
#if SCR_SMALL_ALLOC
  size_t i = 0;
  uintptr_t last[SCR_SA_NCLASS] = {0};
  for (; i < SYSTEM; i++) assert(!owned(ptrs[i]));
  for (; i < N; i++) {
    assert(owned(ptrs[i]));
    unsigned c = class_of(ptrs[i]);
    assert(!last[c] || (uintptr_t)ptrs[i] < last[c]);
    last[c] = (uintptr_t)ptrs[i];
  }
  for (i = 0; i < N; i++) scr_mem_free(ptrs[i]);
  for (size_t c = 0; c < 2; c++) {
    for (size_t k = 0; k < BLOCKS / 2; k++) {
      a[k] = scr_mem_alloc(sizes[c]);
      if (k) assert(a[k] > a[k - 1]);
    }
    for (size_t k = 0; k < BLOCKS / 2; k++) scr_mem_free(a[k]);
  }
#else
  assert(memcmp(ptrs, before, sizeof ptrs) == 0);
  for (size_t i = 0; i < N; i++) scr_mem_free(ptrs[i]);
#endif
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

#include <sys/resource.h>
/* Whether the kernel would write a core of this process: a core_pattern
 * handler or socket, or a nonzero RLIMIT_CORE. */
static bool cores_written(void) {
  struct rlimit core;
  if (getrlimit(RLIMIT_CORE, &core) != 0 || core.rlim_cur != 0) return true;
  FILE *f = fopen("/proc/sys/kernel/core_pattern", "r");
  if (!f) return true;
  int c = fgetc(f);
  fclose(f);
  return c == '|' || c == '@';
}
#endif

/* A class carves contiguously through each chunk it takes, across the
 * points where its limit is raised, and continues at the start of another
 * chunk when one is full; on Linux chunks are huge-page aligned, a class's
 * first 8 MiB of chunks stay on small pages and later chunks may use huge
 * pages, a helper thread faults in memory ahead of the limit, and only the
 * carved part of a chunk is included in core dumps. Every fresh block still
 * reads as zero, wherever the limit steps and whoever faulted it. */
static void check_chunk_growth(void) {
  enum { SZ = 496, AFTER = 8 << 20, PAST = 3 * (2 << 20) + (1 << 20) };
  unsigned char *first = scr_mem_alloc(SZ), *prev = first;
  assert(owned(first) && class_of(first) == scr_sa_class(SZ));
  uintptr_t start = chunk_of(first);
  assert((uintptr_t)first == start); /* a class nothing else has touched */
  size_t blocks = (AFTER + PAST) / SZ, chunks = 1;
  unsigned char *huge = NULL; /* a block in the class's third chunk */
  for (size_t i = 1; i < blocks; i++) {
    unsigned char *p = scr_mem_alloc(SZ);
    if (p != prev + SZ) {
      /* A new chunk, once the last one had no room for another block. */
      assert((uintptr_t)p == chunk_of(p) && (uintptr_t)prev + 2 * SZ > chunk_of(prev) + SCR_SA_CHUNK);
      if (++chunks == 3) huge = p;
    }
    assert(owned(p) && class_of(p) == scr_sa_class(SZ));
    for (size_t k = 0; k < SZ; k += 16) assert(p[k] == 0);
    p[0] = (unsigned char)i; /* commit the pages */
    p[SZ - 1] = (unsigned char)i;
    prev = p;
  }
  assert(chunks == 4 && huge);
#ifdef __linux__
  assert((scr_sa.base & ((2u << 20) - 1)) == 0);
  FILE *thp = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (thp) { /* a kernel without THP refuses both advices */
    fclose(thp);
    char flags[256];
    vm_flags(first, flags, sizeof flags);
    assert(strstr(flags, " nh") && !strstr(flags, " hg"));
    vm_flags(huge, flags, sizeof flags);
    assert(strstr(flags, " hg") && !strstr(flags, " nh"));
  }
  /* Core dumps hold the carved blocks, where the kernel would write a core
   * at all, but not the untouched rest of a chunk or of the window
   * (" dd" is VM_DONTDUMP). */
  bool cores = cores_written();
  char flags[256];
  vm_flags(first, flags, sizeof flags);
  assert(!strstr(flags, " dd") == cores);
  vm_flags(prev + SZ - 1, flags, sizeof flags);
  assert(!strstr(flags, " dd") == cores);
  /* Within a chunk the dumpable part ends on a 2 MiB grid past the limit. */
  uintptr_t grid = (uintptr_t)2 << 20;
  uintptr_t edge = (((uintptr_t)prev + SZ - chunk_of(prev)) + grid - 1) & ~(grid - 1);
  if (!cores || edge < SCR_SA_CHUNK) {
    vm_flags((void *)(chunk_of(prev) + SCR_SA_CHUNK - 1), flags, sizeof flags);
    assert(strstr(flags, " dd"));
  }
  vm_flags((void *)(scr_sa.base + scr_sa.span - 1), flags, sizeof flags);
  assert(strstr(flags, " dd"));
#endif
  /* The blocks recycle through the free list like any others. */
  scr_mem_free(first);
  assert(scr_mem_alloc(SZ) == first);
  scr_mem_free(first);
}

#if defined(__linux__) && defined(__GLIBC__)
#include <unistd.h>
/* Blocks above SCR_SA_MAX come from glibc; once its brk heap has grown past
 * 32 MiB, the heap is advised huge pages where THP is in madvise mode. */
static void check_heap_huge_pages(void) {
  enum { N = 1024, SZ = 64 << 10 };
  static unsigned char *block[N];
  uintptr_t start = (uintptr_t)sbrk(0);
  for (size_t i = 0; i < N; i++) {
    block[i] = scr_mem_alloc(SZ);
    assert(block[i] && !owned(block[i]));
    block[i][0] = (unsigned char)i;
  }
  uintptr_t top = (uintptr_t)sbrk(0);
  char mode[96] = {0};
  FILE *thp = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (thp) {
    size_t n = fread(mode, 1, sizeof mode - 1, thp);
    mode[n] = '\0';
    fclose(thp);
  }
  /* Only where glibc's heap served them (a sanitizer may replace malloc). */
  if (top - start >= ((size_t)48 << 20) && strstr(mode, "[madvise]")) {
    char flags[256];
    vm_flags(block[N - 1], flags, sizeof flags);
    assert(strstr(flags, " hg"));
  }
  for (size_t i = 0; i < N; i++) {
    assert(block[i][0] == (unsigned char)i);
    scr_mem_free(block[i]);
  }
}
#endif
#endif

#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC
#include <pthread.h>

/* Script threads own disjoint arenas; blocks freed by another thread return
 * to their owner through its remote list, and an exiting thread's arena
 * (free lists included) passes to the next thread that claims one. */
enum { HANDOFF = 256 };
static void *handoff[HANDOFF];
static void *handed[HANDOFF]; /* the addresses, kept after the frees */
static uint32_t worker_tag;

static void *alloc_and_hand_off(void *arg) {
  (void)arg;
  for (unsigned i = 0; i < HANDOFF; i++) {
    handoff[i] = scr_mem_calloc(48);
    assert(handoff[i] && owned(handoff[i]));
    handed[i] = handoff[i];
    fill(handoff[i], 48, (unsigned char)i);
  }
  worker_tag = scr_sa.tag;
  scr_sa_thread_park();
  return NULL;
}

static void *reclaim_arena(void *arg) {
  (void)arg;
  /* The parked arena is the only free one besides main's: claimed again,
   * with the main thread's remote frees drained into its free lists. */
  void *p = scr_mem_alloc(48);
  assert(scr_sa.tag == worker_tag);
  bool recycled = false;
  for (unsigned i = 0; i < HANDOFF; i++) recycled |= p == handed[i];
  assert(recycled);
  scr_mem_free(p);
  scr_sa_thread_park();
  return NULL;
}

#if defined(__linux__) && defined(__GLIBC__)
/* A thread whose large blocks pass 16 MiB gets them from a glibc heap of
 * its own, which is then advised huge pages where THP is in madvise mode. */
enum { HEAP_BLOCKS = 320, HEAP_BLOCK = 64 << 10 };
static void *heap_blocks[HEAP_BLOCKS];
static char heap_flags[256];
static void *thread_heap_allocate(void *arg) {
  (void)arg;
  for (unsigned i = 0; i < HEAP_BLOCKS; i++) {
    heap_blocks[i] = scr_mem_alloc(HEAP_BLOCK);
    assert(heap_blocks[i] && !owned(heap_blocks[i]));
    ((unsigned char *)heap_blocks[i])[0] = (unsigned char)i;
  }
  vm_flags(heap_blocks[HEAP_BLOCKS - 1], heap_flags, sizeof heap_flags);
  for (unsigned i = 0; i < HEAP_BLOCKS; i++) {
    assert(((unsigned char *)heap_blocks[i])[0] == (unsigned char)i);
    scr_mem_free(heap_blocks[i]);
  }
  scr_sa_thread_park();
  return NULL;
}

static void check_thread_heap_huge_pages(void) {
  pthread_t t;
  assert(pthread_create(&t, NULL, thread_heap_allocate, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  char mode[96] = {0};
  FILE *thp = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (thp) {
    size_t n = fread(mode, 1, sizeof mode - 1, thp);
    mode[n] = '\0';
    fclose(thp);
  }
  FILE *f = fopen("/proc/sys/vm/overcommit_memory", "r");
  int overcommit = f ? fgetc(f) : '0';
  if (f) fclose(f);
  /* ThreadSanitizer replaces malloc, which turns the policy off. */
  bool glibc_malloc = true;
#if defined(__SANITIZE_THREAD__)
  glibc_malloc = false;
#elif defined(__has_feature)
#if __has_feature(thread_sanitizer)
  glibc_malloc = false;
#endif
#endif
  /* With glibc's memory tagging tunable set the heap is left alone: under
   * arm64 MTE, reading its chunk headers through block pointers faults. */
  const char *tunables = getenv("GLIBC_TUNABLES");
  if (tunables && strstr(tunables, "glibc.mem.tagging=3")) assert(!strstr(heap_flags, " hg"));
  else if (glibc_malloc && strstr(mode, "[madvise]") && !tunables && overcommit != '2')
    assert(strstr(heap_flags, " hg"));
}
#endif

static void check_threads(void) {
  void *mine = scr_mem_alloc(48);
  assert(owned(mine));
  pthread_t t;
  assert(pthread_create(&t, NULL, alloc_and_hand_off, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  assert(worker_tag != scr_sa.tag);
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

#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC && defined(__linux__)
#include <sys/mman.h>
#include <unistd.h>

/* An exiting thread returns the pages that hold only free blocks; the next
 * thread to claim the arena carves the returned range again, zeroed, before
 * growing the slice. */
enum { TRIM_BLOCKS = 1 << 20, TRIM_KEEP = 4096, TRIM_SIZE = 48 };
static unsigned char **trim_blocks;
static unsigned char *trim_kept[TRIM_BLOCKS / TRIM_KEEP];
static uintptr_t trim_lo, trim_hi;
static size_t trim_outside;

static size_t resident_pages(uintptr_t lo, uintptr_t hi) {
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  lo &= ~(uintptr_t)(page - 1);
  size_t n = (hi - lo + page - 1) / page, count = 0;
  unsigned char *vec = malloc(n);
  assert(vec && mincore((void *)lo, n * page, vec) == 0);
  for (size_t i = 0; i < n; i++) count += vec[i] & 1;
  free(vec);
  return count;
}

static void *trim_allocate(void *arg) {
  (void)arg;
  trim_lo = UINTPTR_MAX;
  trim_hi = 0;
  for (size_t i = 0; i < TRIM_BLOCKS; i++) {
    trim_blocks[i] = scr_mem_alloc(TRIM_SIZE);
    assert(trim_blocks[i] && owned(trim_blocks[i]));
    fill(trim_blocks[i], TRIM_SIZE, (unsigned char)i);
    if ((uintptr_t)trim_blocks[i] < trim_lo) trim_lo = (uintptr_t)trim_blocks[i];
    if ((uintptr_t)trim_blocks[i] + TRIM_SIZE > trim_hi) trim_hi = (uintptr_t)trim_blocks[i] + TRIM_SIZE;
  }
  for (size_t i = 0; i < TRIM_BLOCKS; i++) {
    if (i % TRIM_KEEP == 0) trim_kept[i / TRIM_KEEP] = trim_blocks[i];
    else scr_mem_free(trim_blocks[i]);
  }
  scr_sa_thread_park();
  return NULL;
}

static void *trim_reuse(void *arg) {
  (void)arg;
  trim_outside = 0;
  for (size_t i = 0; i < TRIM_BLOCKS; i++) {
    unsigned char *p = scr_mem_calloc(TRIM_SIZE);
    assert(p && owned(p));
    for (size_t k = 0; k < TRIM_SIZE; k++) assert(p[k] == 0);
    fill(p, TRIM_SIZE, (unsigned char)i);
    if ((uintptr_t)p < trim_lo || (uintptr_t)p >= trim_hi) trim_outside++;
    trim_blocks[i] = p;
  }
  for (size_t i = 0; i < TRIM_BLOCKS; i++) scr_mem_free(trim_blocks[i]);
  scr_sa_thread_park();
  return NULL;
}

static void check_trim(void) {
  trim_blocks = malloc(TRIM_BLOCKS * sizeof *trim_blocks);
  assert(trim_blocks);
  pthread_t t;
  assert(pthread_create(&t, NULL, trim_allocate, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  scr_sa_wait_trims(); /* a helper thread returns the pages */
  /* One page per kept block stays, give or take the pages at run ends. */
  size_t total = (trim_hi - trim_lo) / (size_t)sysconf(_SC_PAGESIZE);
  size_t resident = resident_pages(trim_lo, trim_hi);
  assert(resident < total / 8);
  for (size_t k = 0; k < TRIM_BLOCKS / TRIM_KEEP; k++)
    verify(trim_kept[k], TRIM_SIZE, (unsigned char)(k * TRIM_KEEP));
  assert(pthread_create(&t, NULL, trim_reuse, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  scr_sa_wait_trims();
  /* Nearly every block came from the returned range: the slice did not grow. */
  assert(trim_outside < 4 * TRIM_BLOCKS / TRIM_KEEP + 256);
  for (size_t k = 0; k < TRIM_BLOCKS / TRIM_KEEP; k++) {
    verify(trim_kept[k], TRIM_SIZE, (unsigned char)(k * TRIM_KEEP));
    scr_mem_free(trim_kept[k]); /* remote free into the parked arena */
  }
  free(trim_blocks);
}

/* A thread that parks returns the pages faulted in past each slice's
 * frontier (the rest of the frontier's huge page and the pages faulted in
 * ahead), and its blocks stay; the next thread to claim the arena carves on
 * from the frontier, zeroed. FRONTIER_SIZE is a class the other checks leave
 * unused, and FRONTIER_BYTES carves past SCR_SA_HUGE_AFTER. */
enum { FRONTIER_SIZE = 120, FRONTIER_BYTES = 12 << 20, FRONTIER_MORE = 4096 };
static unsigned char **frontier_blocks;
static size_t frontier_n;
static uintptr_t frontier_hi, frontier_end;
static size_t frontier_past;

static void *frontier_allocate(void *arg) {
  (void)arg;
  scr_sa_thread_starting();
  for (size_t i = 0; i < frontier_n; i++) {
    unsigned char *p = scr_mem_alloc(FRONTIER_SIZE);
    assert(p && owned(p));
    fill(p, FRONTIER_SIZE, (unsigned char)i);
    frontier_blocks[i] = p;
    if ((uintptr_t)p + FRONTIER_SIZE > frontier_hi) frontier_hi = (uintptr_t)p + FRONTIER_SIZE;
  }
  /* The end of the chunk that holds the class's frontier. */
  frontier_end = chunk_of(frontier_blocks[frontier_n - 1]) + SCR_SA_CHUNK;
  scr_sa_thread_shares();
  scr_sa_thread_park();
  return NULL;
}

static void *frontier_continue(void *arg) {
  (void)arg;
  for (size_t i = 0; i < FRONTIER_MORE; i++) {
    unsigned char *p = scr_mem_calloc(FRONTIER_SIZE);
    assert(p && owned(p));
    for (size_t k = 0; k < FRONTIER_SIZE; k++) assert(p[k] == 0);
    if ((uintptr_t)p >= frontier_hi) frontier_past++;
    scr_mem_free(p);
  }
  scr_sa_thread_park();
  return NULL;
}

static void check_release_frontiers(void) {
  frontier_n = FRONTIER_BYTES / FRONTIER_SIZE;
  frontier_blocks = malloc(frontier_n * sizeof *frontier_blocks);
  assert(frontier_blocks);
  pthread_t t;
  assert(pthread_create(&t, NULL, frontier_allocate, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  scr_sa_wait_trims();
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  uintptr_t from = (frontier_hi + page - 1) & ~(uintptr_t)(page - 1);
  uintptr_t to = from + ((size_t)4 << 20) < frontier_end ? from + ((size_t)4 << 20) : frontier_end;
  if (to > from) assert(resident_pages(from, to) == 0);
  for (size_t i = 0; i < frontier_n; i++) verify(frontier_blocks[i], FRONTIER_SIZE, (unsigned char)i);
  assert(pthread_create(&t, NULL, frontier_continue, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  /* The freed block comes back each time: one block past the frontier. */
  assert(frontier_past >= 1);
  for (size_t i = 0; i < frontier_n; i++) scr_mem_free(frontier_blocks[i]); /* remote frees */
  free(frontier_blocks);
}
#endif

#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC && defined(__linux__)
#include <malloc.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* A worker thread (scr_sa_thread_starting) that exits without sharing
 * gives its memory back: the pages it carved, and the system blocks it
 * still holds. Older blocks of the arena, and the memory of a worker that
 * shared (or got a remote free of its own blocks), stay. */
/* DISCARD_SIZE and POISON_SIZE are classes the earlier checks leave unused
 * in the workers' arena, so their state there is known. */
enum { DISCARD_BLOCKS = 1 << 20, DISCARD_SIZE = 40, POISON_SIZE = 56, DISCARD_OLD = 64, DISCARD_LARGE = 64 };
enum { DISCARD_LARGE_SIZE = 64 << 10 };
static unsigned char *old_blocks[DISCARD_OLD];
static unsigned char **discard_blocks;
static unsigned char *discard_large[DISCARD_LARGE];
static uint32_t discard_tag;
static uintptr_t discard_lo, discard_hi;
static size_t block_size = DISCARD_SIZE; /* of the workers' and reusing threads' blocks */
/* Whether discard workers claim the arena of discard_old_owner (no other worker holds it). */
static bool discard_in_old_arena = true;
/* The end of the highest block of class DISCARD_SIZE so far, and how many blocks of a run lay past the mark
 * at its start: those the slice grew for. */
static uintptr_t class_hi;
static size_t discard_beyond, reuse_beyond;
static bool discard_shares;
static atomic_int discard_step;

static void wait_step(int step) {
  while (atomic_load(&discard_step) < step) {
    struct timespec pause = {0, 100000};
    nanosleep(&pause, NULL);
  }
}

/* A plain script thread whose blocks stay live in its parked arena. */
static void *discard_old_owner(void *arg) {
  (void)arg;
  for (unsigned i = 0; i < DISCARD_OLD; i++) {
    old_blocks[i] = scr_mem_alloc(DISCARD_SIZE);
    assert(owned(old_blocks[i]));
    fill(old_blocks[i], DISCARD_SIZE, (unsigned char)i);
  }
  discard_tag = scr_sa.tag;
  scr_sa_thread_park();
  return NULL;
}

static void allocate_discardable(void) {
  discard_lo = UINTPTR_MAX;
  discard_hi = 0;
  discard_beyond = 0;
  for (size_t i = 0; i < DISCARD_BLOCKS; i++) {
    unsigned char *p = scr_mem_alloc(block_size);
    assert(p && owned(p));
    fill(p, block_size, (unsigned char)i);
    discard_blocks[i] = p;
    if ((uintptr_t)p >= class_hi) discard_beyond++;
    if ((uintptr_t)p < discard_lo) discard_lo = (uintptr_t)p;
    if ((uintptr_t)p + block_size > discard_hi) discard_hi = (uintptr_t)p + block_size;
  }
  if (block_size == DISCARD_SIZE && discard_hi > class_hi) class_hi = discard_hi;
  /* System blocks: some freed, some moved by realloc, the rest kept. */
  for (unsigned i = 0; i < DISCARD_LARGE; i++) {
    discard_large[i] = scr_mem_alloc(DISCARD_LARGE_SIZE);
    assert(discard_large[i] && !owned(discard_large[i]));
    fill(discard_large[i], 64, (unsigned char)i);
  }
  for (unsigned i = 0; i < DISCARD_LARGE; i += 4) {
    scr_mem_free(discard_large[i]);
    discard_large[i] = NULL;
  }
  for (unsigned i = 1; i < DISCARD_LARGE; i += 4) discard_large[i] = scr_mem_realloc(discard_large[i], 2 * DISCARD_LARGE_SIZE);
}

static void *discard_worker(void *arg) {
  (void)arg;
  scr_sa_thread_starting();
  allocate_discardable();
  /* None of the arena's older blocks or free blocks is reused. */
  if (scr_sa.tag == discard_tag)
    for (unsigned i = 0; i < DISCARD_OLD; i++) assert(discard_lo > (uintptr_t)old_blocks[i]);
  else assert(!discard_in_old_arena);
  if (discard_shares) scr_sa_thread_shares();
  scr_sa_thread_park();
  return NULL;
}

/* A worker one of whose blocks the main thread frees while it runs. */
static void *remote_freed_worker(void *arg) {
  (void)arg;
  scr_sa_thread_starting();
  allocate_discardable();
  atomic_store(&discard_step, 1);
  wait_step(2);
  /* A class this thread has not used: its first block takes the slow path,
   * which drains the remote free. */
  void *p = scr_mem_alloc(200);
  assert(p);
  scr_sa_thread_park();
  return NULL;
}

/* A plain thread that takes as many blocks again from the arena: carved
 * ones must be zero (the fast path does not clear them). */
static size_t reuse_outside;
static uintptr_t reuse_hi;
static void *discard_reuse(void *arg) {
  (void)arg;
  reuse_outside = 0;
  reuse_hi = 0;
  reuse_beyond = 0;
  for (size_t i = 0; i < DISCARD_BLOCKS; i++) {
    unsigned char *p = scr_mem_calloc(block_size);
    assert(p && owned(p));
    assert(scr_sa.tag == discard_tag);
    for (size_t k = 0; k < block_size; k++) assert(p[k] == 0);
    for (unsigned j = 0; j < DISCARD_OLD; j++) assert(p != old_blocks[j]);
    if ((uintptr_t)p < discard_lo || (uintptr_t)p >= discard_hi) reuse_outside++;
    if ((uintptr_t)p + block_size > reuse_hi) reuse_hi = (uintptr_t)p + block_size;
    if ((uintptr_t)p >= class_hi) reuse_beyond++;
    discard_blocks[i] = p;
  }
  if (block_size == DISCARD_SIZE && reuse_hi > class_hi) class_hi = reuse_hi;
  for (size_t i = 0; i < DISCARD_BLOCKS; i++) scr_mem_free(discard_blocks[i]);
  scr_sa_thread_park();
  return NULL;
}

static void run(void *(*fn)(void *)) {
  pthread_t t;
  assert(pthread_create(&t, NULL, fn, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  scr_sa_wait_trims();
}

static void verify_old_blocks(void) {
  for (unsigned i = 0; i < DISCARD_OLD; i++) verify(old_blocks[i], DISCARD_SIZE, (unsigned char)i);
}

/* The worker's blocks stayed as it left them, and the next thread to claim
 * the arena carves past them; then they are freed (remote frees). */
static void verify_kept(void) {
  for (size_t i = 0; i < DISCARD_BLOCKS; i++) verify(discard_blocks[i], block_size, (unsigned char)i);
  for (unsigned i = 0; i < DISCARD_LARGE; i++) {
    if (!discard_large[i]) continue;
    verify(discard_large[i], 64, (unsigned char)i);
    free(discard_large[i]);
  }
  for (size_t i = 0; i < DISCARD_BLOCKS; i++) scr_mem_free(discard_blocks[i]);
}

/* The protection of the mapping that holds address a, from /proc/self/maps. */
static bool readable(uintptr_t a) {
  FILE *maps = fopen("/proc/self/maps", "r");
  assert(maps);
  char line[512];
  bool found = false, result = false;
  while (!found && fgets(line, sizeof line, maps)) {
    unsigned long lo, hi;
    char perms[8];
    if (sscanf(line, "%lx-%lx %7s", &lo, &hi, perms) != 3) continue;
    if (a >= lo && a < hi) {
      found = true;
      result = perms[0] == 'r';
    }
  }
  fclose(maps);
  assert(found);
  return result;
}

/* A worker that runs until discard_step reaches 3. */
static void *holding_worker(void *arg) {
  (void)arg;
  scr_sa_thread_starting();
  void *p = scr_mem_alloc(DISCARD_SIZE);
  assert(p && owned(p));
  atomic_store(&discard_step, 1);
  wait_step(3);
  scr_sa_thread_park();
  return NULL;
}

/* A worker that allocates one block of a class the other checks leave
 * alone and parks without sharing. */
static void *small_worker(void *arg) {
  (void)arg;
  scr_sa_thread_starting();
  void *p = scr_mem_alloc(200);
  assert(p && owned(p));
  scr_sa_thread_park();
  return NULL;
}

/* Discards wait while another worker runs, and the last worker to park
 * starts them. When every arena is held by a discard that waits, a worker
 * that needs one discards one of them and claims it. */
static void check_deferred_discard(void) {
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  atomic_store(&discard_step, 0);
  pthread_t holder;
  assert(pthread_create(&holder, NULL, holding_worker, NULL) == 0);
  wait_step(1);
  discard_shares = false;
  discard_in_old_arena = false;
  pthread_t t;
  assert(pthread_create(&t, NULL, discard_worker, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  uintptr_t first = (discard_lo + page - 1) & ~(uintptr_t)(page - 1);
  size_t total = (discard_hi - first) / page;
  /* Still resident (the arena is not reused meanwhile, so the blocks are intact). */
  assert(resident_pages(first, discard_hi) > total / 2);
  for (size_t i = 0; i < DISCARD_BLOCKS; i += 4099) verify(discard_blocks[i], block_size, (unsigned char)i);
  /* More arenas held by waiting discards than there are free ones. */
  for (unsigned n = 0; n < 40; n++) {
    assert(pthread_create(&t, NULL, small_worker, NULL) == 0);
    assert(pthread_join(t, NULL) == 0);
  }
  atomic_store(&discard_step, 3);
  assert(pthread_join(holder, NULL) == 0);
  scr_sa_wait_trims();
  assert(resident_pages(first, discard_hi) < total / 2);
  discard_in_old_arena = true;
}

/* A plain thread that holds an arena until discard_step reaches 3. */
static void *holding_thread(void *arg) {
  (void)arg;
  void *p = scr_mem_alloc(DISCARD_SIZE);
  assert(p && owned(p));
  atomic_store(&discard_step, 1);
  wait_step(3);
  scr_mem_free(p);
  scr_sa_thread_park();
  return NULL;
}

/* The helper waits SCR_SA_DISCARD_DELAY_MS before it returns the pages, and
 * stops if a worker starts meanwhile; the last worker of that group starts
 * the discards again. A plain thread holds the arena whose slice the earlier
 * checks filled, so the worker carves a slice of its own. */
static void check_discard_delay(void) {
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  setenv("SCR_SA_DISCARD_DELAY_MS", "300", 1);
  atomic_store(&discard_step, 0);
  pthread_t plain;
  assert(pthread_create(&plain, NULL, holding_thread, NULL) == 0);
  wait_step(1);
  discard_shares = false;
  discard_in_old_arena = false;
  pthread_t t;
  assert(pthread_create(&t, NULL, discard_worker, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  atomic_store(&discard_step, 0);
  pthread_t holder;
  assert(pthread_create(&holder, NULL, holding_worker, NULL) == 0);
  wait_step(1);
  /* Past the delay: the helper stopped when the holder started. */
  struct timespec pause = {0, 600000000L};
  nanosleep(&pause, NULL);
  uintptr_t first = (discard_lo + page - 1) & ~(uintptr_t)(page - 1);
  size_t total = (discard_hi - first) / page;
  assert(resident_pages(first, discard_hi) > total / 2);
  for (size_t i = 0; i < DISCARD_BLOCKS; i += 4099) verify(discard_blocks[i], block_size, (unsigned char)i);
  setenv("SCR_SA_DISCARD_DELAY_MS", "0", 1);
  atomic_store(&discard_step, 3);
  assert(pthread_join(holder, NULL) == 0);
  assert(pthread_join(plain, NULL) == 0);
  scr_sa_wait_trims();
  setenv("SCR_SA_DISCARD_DELAY_MS", "100", 1);
  assert(resident_pages(first, discard_hi) < total / 2);
  discard_in_old_arena = true;
}

/* A discard that workers follow within ten delays was too early: the next
 * delay is twice as long, and memory idle for that long still goes back. */
static void *plain_discard_worker(void *arg) {
  (void)arg;
  scr_sa_thread_starting();
  allocate_discardable();
  scr_sa_thread_park();
  return NULL;
}

static void check_discard_delay_grows(void) {
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  setenv("SCR_SA_DISCARD_DELAY_MS", "100", 1);
  setenv("SCR_SA_DISCARD_DELAY_MAX_MS", "10000", 1);
  discard_blocks = malloc(DISCARD_BLOCKS * sizeof *discard_blocks);
  assert(discard_blocks);
  /* A plain thread holds the arena whose slice the earlier checks filled. */
  atomic_store(&discard_step, 0);
  pthread_t plain;
  assert(pthread_create(&plain, NULL, holding_thread, NULL) == 0);
  wait_step(1);
  run(plain_discard_worker); /* returned after the delay */
  pthread_t t;
  assert(pthread_create(&t, NULL, plain_discard_worker, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  uintptr_t first = (discard_lo + page - 1) & ~(uintptr_t)(page - 1);
  size_t total = (discard_hi - first) / page;
  struct timespec pause = {0, 140000000L};
  nanosleep(&pause, NULL);
  assert(resident_pages(first, discard_hi) > total / 2); /* the delay is 200 ms or more now */
  scr_sa_wait_trims();
  assert(resident_pages(first, discard_hi) < total / 2);
  setenv("SCR_SA_DISCARD_DELAY_MS", "100", 1);
  setenv("SCR_SA_DISCARD_DELAY_MAX_MS", "0", 1);
  atomic_store(&discard_step, 3);
  assert(pthread_join(plain, NULL) == 0);
  free(discard_blocks);
}

/* Once the event loop runs, discards wait for it to wait with nothing
 * ready; a loop that does not wait gets them SCR_SA_DISCARD_DELAY_MAX_MS
 * after the delay. The test's thread plays the loop's. */
static void check_discard_waits_for_loop(void) {
  size_t page = (size_t)sysconf(_SC_PAGESIZE);
  setenv("SCR_SA_DISCARD_DELAY_MS", "100", 1);
  setenv("SCR_SA_DISCARD_DELAY_MAX_MS", "10000", 1);
  discard_blocks = malloc(DISCARD_BLOCKS * sizeof *discard_blocks);
  assert(discard_blocks);
  atomic_store(&discard_step, 0);
  pthread_t plain;
  assert(pthread_create(&plain, NULL, holding_thread, NULL) == 0);
  wait_step(1);
  scr_sa_loop_waiting(true);
  scr_sa_loop_waiting(false); /* the loop runs */
  pthread_t t;
  assert(pthread_create(&t, NULL, plain_discard_worker, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  uintptr_t first = (discard_lo + page - 1) & ~(uintptr_t)(page - 1);
  size_t total = (discard_hi - first) / page;
  struct timespec pause = {0, 900000000L};
  nanosleep(&pause, NULL);
  assert(resident_pages(first, discard_hi) > total / 2); /* past the delay */
  scr_sa_loop_waiting(true);
  scr_sa_wait_trims();
  assert(resident_pages(first, discard_hi) < total / 2);
  /* A loop that keeps running. */
  scr_sa_loop_waiting(false);
  setenv("SCR_SA_DISCARD_DELAY_MAX_MS", "300", 1);
  assert(pthread_create(&t, NULL, plain_discard_worker, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  first = (discard_lo + page - 1) & ~(uintptr_t)(page - 1);
  total = (discard_hi - first) / page;
  scr_sa_wait_trims();
  assert(resident_pages(first, discard_hi) < total / 2);
  setenv("SCR_SA_DISCARD_DELAY_MAX_MS", "0", 1);
  atomic_store(&discard_step, 3);
  assert(pthread_join(plain, NULL) == 0);
  free(discard_blocks);
}

/* The thread that is not a worker returns its free pages when its loop
 * waits with nothing ready, once it has carved SCR_SA_TRIM_MIN more since
 * its last trim; blocks allocated afterwards come from the returned range,
 * zeroed. The test's thread plays the loop's. IDLE_SIZE is a class the
 * other checks leave unused. */
enum { IDLE_BLOCKS = 1 << 20, IDLE_KEEP = 4096, IDLE_SIZE = 88 };

/* The pages of [lo, hi) that lie in the calling thread's chunks of class c
 * (other classes' chunks lie between them in the window); `*resident` is how
 * many of them are resident. */
static size_t class_pages(uintptr_t lo, uintptr_t hi, unsigned c, size_t *resident) {
  size_t page = (size_t)sysconf(_SC_PAGESIZE), total = 0;
  *resident = 0;
  for (uintptr_t ch = chunk_of((void *)lo); ch < hi; ch += SCR_SA_CHUNK) {
    if (!owned((void *)ch) || class_of((void *)ch) != c) continue;
    uintptr_t from = ch > lo ? ch : lo, to = ch + SCR_SA_CHUNK < hi ? ch + SCR_SA_CHUNK : hi;
    from &= ~(uintptr_t)(page - 1);
    total += (to - from + page - 1) / page;
    *resident += resident_pages(from, to);
  }
  return total;
}

static void check_idle_trim(void) {
  unsigned char **blocks = malloc(IDLE_BLOCKS * sizeof *blocks);
  unsigned char *kept[IDLE_BLOCKS / IDLE_KEEP];
  assert(blocks);
  uintptr_t lo = UINTPTR_MAX, hi = 0;
  for (size_t i = 0; i < IDLE_BLOCKS; i++) {
    blocks[i] = scr_mem_alloc(IDLE_SIZE);
    assert(blocks[i] && owned(blocks[i]));
    fill(blocks[i], IDLE_SIZE, (unsigned char)i);
    if ((uintptr_t)blocks[i] < lo) lo = (uintptr_t)blocks[i];
    if ((uintptr_t)blocks[i] + IDLE_SIZE > hi) hi = (uintptr_t)blocks[i] + IDLE_SIZE;
  }
  for (size_t i = 0; i < IDLE_BLOCKS; i++) {
    if (i % IDLE_KEEP == 0) kept[i / IDLE_KEEP] = blocks[i];
    else scr_mem_free(blocks[i]);
  }
  unsigned c = class_of(kept[0]);
  size_t resident, total = class_pages(lo, hi, c, &resident);
  assert(resident > total / 2);
  scr_sa_loop_waiting(true);
  scr_sa_loop_waiting(false);
  /* One page per kept block stays, give or take the pages at run ends. */
  assert(class_pages(lo, hi, c, &resident) == total && resident < total / 8);
  for (size_t k = 0; k < IDLE_BLOCKS / IDLE_KEEP; k++) verify(kept[k], IDLE_SIZE, (unsigned char)(k * IDLE_KEEP));
  size_t outside = 0;
  for (size_t i = 0; i < IDLE_BLOCKS / 2; i++) {
    unsigned char *q = scr_mem_calloc(IDLE_SIZE);
    assert(q && owned(q));
    for (size_t k = 0; k < IDLE_SIZE; k++) assert(q[k] == 0);
    if ((uintptr_t)q < lo || (uintptr_t)q >= hi) outside++;
    blocks[i] = q;
  }
  assert(outside < 256);
  for (size_t i = 0; i < IDLE_BLOCKS / 2; i++) scr_mem_free(blocks[i]);
  for (size_t k = 0; k < IDLE_BLOCKS / IDLE_KEEP; k++) scr_mem_free(kept[k]);
  free(blocks);
}

/* Blocks a 32-bit reference may name (scr_mem_alloc_ref) that a worker
 * keeping its memory apart takes above SCR_SA_MAX come from the window too:
 * a discard returns its runs to the window and puts its large-class blocks
 * back on the arena's free lists, from which the next thread takes them
 * zeroed; a worker that shared keeps them. REF_SIZE is a large class the
 * other checks leave unused. */
enum { REF_BLOCKS = 32, REF_SIZE = 3000, REF_RUNS = 2 };
#define REF_RUN_SIZE ((size_t)5 << 20)
static unsigned char *ref_blocks[REF_BLOCKS], *ref_runs[REF_RUNS];
static bool ref_shares;
static uint32_t ref_tag;

static bool ref_in_window(const void *p) { return (uintptr_t)p - scr_sa.base < scr_sa.span; }

static unsigned ref_entry(const void *p) {
  return scr_sa_chunks[((uintptr_t)p - scr_sa.base) >> SCR_SA_CHUNK_SHIFT];
}

static void *ref_worker(void *arg) {
  (void)arg;
  scr_sa_thread_starting();
  for (unsigned i = 0; i < REF_BLOCKS; i++) {
    ref_blocks[i] = scr_mem_alloc_ref(REF_SIZE);
    assert(ref_blocks[i] && ref_in_window(ref_blocks[i]));
    fill(ref_blocks[i], REF_SIZE, (unsigned char)(i + 1));
  }
  for (unsigned i = 0; i < REF_RUNS; i++) {
    ref_runs[i] = scr_mem_alloc_ref(REF_RUN_SIZE);
    assert(ref_runs[i] && ref_in_window(ref_runs[i]));
    fill(ref_runs[i], REF_RUN_SIZE, (unsigned char)(i + 1));
  }
  /* Blocks it frees itself are no longer its to give back. */
  for (unsigned i = 0; i < REF_BLOCKS; i += 2) {
    scr_mem_free(ref_blocks[i]);
    ref_blocks[i] = NULL;
  }
  scr_mem_free(ref_runs[0]);
  ref_runs[0] = NULL;
  ref_tag = scr_sa.tag;
  if (ref_shares) scr_sa_thread_shares();
  scr_sa_thread_park();
  return NULL;
}

static void *ref_reuse(void *arg) {
  (void)arg;
  unsigned char *got[REF_BLOCKS];
  unsigned reused = 0;
  for (unsigned i = 0; i < REF_BLOCKS; i++) {
    unsigned char *p = scr_mem_calloc_ref(REF_SIZE);
    assert(p && ref_in_window(p));
    for (size_t k = 0; k < REF_SIZE; k++) assert(p[k] == 0);
    for (unsigned j = 1; j < REF_BLOCKS; j += 2) reused += p == ref_blocks[j];
    got[i] = p;
  }
  /* In the worker's arena, the blocks it kept are free blocks again. */
  if (scr_sa.tag == ref_tag) assert(reused == REF_BLOCKS / 2);
  for (unsigned i = 0; i < REF_BLOCKS; i++) scr_mem_free(got[i]);
  scr_sa_thread_park();
  return NULL;
}

static void check_discard_ref_blocks(void) {
  ref_shares = false;
  run(ref_worker);
  /* The run it kept went back to the window. */
  assert(ref_entry(ref_runs[1]) == 0);
  run(ref_reuse);

  ref_shares = true;
  run(ref_worker);
  for (unsigned i = 1; i < REF_BLOCKS; i += 2) verify(ref_blocks[i], REF_SIZE, (unsigned char)(i + 1));
  verify(ref_runs[1], REF_RUN_SIZE, 2);
  for (unsigned i = 1; i < REF_BLOCKS; i += 2) scr_mem_free(ref_blocks[i]);
  scr_mem_free(ref_runs[1]);
}

static void check_discard(void) {
  discard_blocks = malloc(DISCARD_BLOCKS * sizeof *discard_blocks);
  assert(discard_blocks);
  run(discard_old_owner);
  size_t page = (size_t)sysconf(_SC_PAGESIZE);

  /* Discarded: its pages are returned, and carved again (zeroed) by the next
   * thread, which does not grow the slice. The arena's older blocks stay. */
  discard_shares = false;
  run(discard_worker);
  verify_old_blocks();
  uintptr_t first = (discard_lo + page - 1) & ~(uintptr_t)(page - 1);
  /* Pre-fault requests still in flight may fault in a few megabytes again. */
  size_t total = (discard_hi - first) / page;
  assert(resident_pages(first, discard_hi) < total / 2);
  run(discard_reuse);
  assert(reuse_outside < 256);
  verify_old_blocks();

  /* SCR_SA_DISCARD=poison makes the pages inaccessible; the next thread
   * carves past them. */
  block_size = POISON_SIZE;
  setenv("SCR_SA_DISCARD", "poison", 1);
  run(discard_worker);
  unsetenv("SCR_SA_DISCARD");
  verify_old_blocks();
  first = (discard_lo + page - 1) & ~(uintptr_t)(page - 1);
  assert(!readable(first));
  assert(!readable((discard_hi - 1) & ~(uintptr_t)(page - 1)));
  run(discard_reuse);
  assert(reuse_outside == DISCARD_BLOCKS);
  verify_old_blocks();
  block_size = DISCARD_SIZE;

  /* A worker that shared keeps its memory. */
  discard_shares = true;
  run(discard_worker);
  verify_old_blocks();
  verify_kept();

  /* So does one that got a remote free of one of its blocks. */
  atomic_store(&discard_step, 0);
  pthread_t t;
  assert(pthread_create(&t, NULL, remote_freed_worker, NULL) == 0);
  wait_step(1);
  scr_mem_free(discard_blocks[0]);
  discard_blocks[0] = scr_mem_alloc(DISCARD_SIZE); /* main's own block, for verify_kept */
  fill(discard_blocks[0], DISCARD_SIZE, 0);
  atomic_store(&discard_step, 2);
  assert(pthread_join(t, NULL) == 0);
  scr_sa_wait_trims();
  verify_old_blocks();
  verify_kept();

  /* SCR_SA_DISCARD=0 keeps every worker's memory. */
  discard_shares = false;
  setenv("SCR_SA_DISCARD", "0", 1);
  run(discard_worker);
  unsetenv("SCR_SA_DISCARD");
  verify_old_blocks();
  verify_kept();

  /* The kept workers' blocks are free now (remote frees): a worker takes
   * them once its slice has no bump room left, and they are free again
   * after its memory goes back, so the next thread does not grow the slice
   * either. Past the highest block so far, each carves at most the bump room
   * the slice had left (a few megabytes). */
  size_t room = ((size_t)4 << 20) / DISCARD_SIZE;
  run(discard_worker);
  verify_old_blocks();
  assert(discard_beyond < room);
  run(discard_reuse);
  assert(reuse_beyond < room);
  verify_old_blocks();

  /* Returned regions (holes) of an earlier trim are kept apart while a
   * worker runs, and carved again afterwards. */
  trim_blocks = malloc(TRIM_BLOCKS * sizeof *trim_blocks); /* check_trim freed its own */
  assert(trim_blocks);
  run(trim_allocate);
  uintptr_t hole_lo = trim_lo, hole_hi = trim_hi;
  discard_shares = false;
  run(discard_worker);
  verify_old_blocks();
  for (size_t k = 0; k < TRIM_BLOCKS / TRIM_KEEP; k++)
    verify(trim_kept[k], TRIM_SIZE, (unsigned char)(k * TRIM_KEEP));
  trim_lo = hole_lo;
  trim_hi = hole_hi;
  run(trim_reuse);
  assert(trim_outside < 4 * TRIM_BLOCKS / TRIM_KEEP + 256);
  for (size_t k = 0; k < TRIM_BLOCKS / TRIM_KEEP; k++) scr_mem_free(trim_kept[k]);
  free(trim_blocks);

  check_deferred_discard();
  check_discard_delay();
  for (unsigned i = 0; i < DISCARD_OLD; i++) scr_mem_free(old_blocks[i]);
  free(discard_blocks);
}
#endif

/* ThreadSanitizer stops a child that starts a thread after a fork in a
 * threaded program, so its build skips the fork check. */
#define FORK_CHECK 1
#if defined(__SANITIZE_THREAD__)
#undef FORK_CHECK
#elif defined(__has_feature)
#if __has_feature(thread_sanitizer)
#undef FORK_CHECK
#endif
#endif

#if defined(__linux__) && SCR_SMALL_ALLOC && defined(FORK_CHECK)
#include <signal.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#define FORK_ROUNDS 64
#define FORK_SPAN ((size_t)64 << 20)
#define FORK_OWN ((size_t)1 << 20)

/* A child forked while the prefault helper faults in a range has no helper.
 * It releases that range (which waits for a busy range to finish), then
 * requests a fault-in of its own and releases it, and must exit within five
 * seconds. */
static void check_fork_while_prefaulting(void) {
  for (unsigned round = 0; round < FORK_ROUNDS; round++) {
    char *lo = mmap(NULL, FORK_SPAN, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    assert(lo != MAP_FAILED);
    scr_mem_prefault(lo, lo + FORK_SPAN);
    pid_t pid = fork();
    assert(pid >= 0);
    if (pid == 0) {
      scr_mem_release_ahead(lo, lo + FORK_SPAN);
      char *own = mmap(NULL, FORK_OWN, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
      if (own == MAP_FAILED) _exit(2);
      scr_mem_prefault(own, own + FORK_OWN);
      scr_mem_release_ahead(own, own + FORK_OWN);
      _exit(0);
    }
    int status = 0;
    pid_t done = 0;
    for (unsigned ms = 0; ms < 5000 && done == 0; ms++) {
      done = waitpid(pid, &status, WNOHANG);
      if (done == 0) nanosleep(&(struct timespec){0, 1000000L}, NULL);
    }
    if (done == 0) {
      kill(pid, SIGKILL);
      (void)waitpid(pid, &status, 0);
      fprintf(stderr, "the child forked in round %u did not exit\n", round);
      abort();
    }
    assert(done == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    scr_mem_release_ahead(lo, lo + FORK_SPAN);
    assert(munmap(lo, FORK_SPAN) == 0);
  }
}
#endif

#if defined(__linux__) && SCR_SMALL_ALLOC
/* The program-lifetime region hands out zeroed, 8-byte aligned blocks below
 * 32 GiB, in order from the calling thread's chunk; a block larger than a
 * chunk gets chunks of its own. Heap statistics count the chunks. Builds
 * with AddressSanitizer have no region (its shadow memory takes the range),
 * and scriptc builds with sanitizers keep pointers instead. */
static void check_program_lifetime_region(void) {
  double total0, used0, total1, used1;
  scr_heap_stats(&total0, &used0);
  scr_plr_init();
  unsigned char *a = scr_plr_alloc(20), *b = scr_plr_alloc(40);
  assert(((uintptr_t)a & 7) == 0 && b == a + 24);
  assert((uintptr_t)a >= ((uintptr_t)4 << 30) && (uintptr_t)b + 40 <= ((uintptr_t)32 << 30));
  /* The region's chunks are the window's, and hold no small blocks. */
  assert((uintptr_t)a - scr_sa.base < scr_sa.span || !scr_sa.span);
  if (scr_sa.span) assert(scr_sa_chunks[((uintptr_t)a - scr_sa.base) >> SCR_SA_CHUNK_SHIFT] == 0);
  for (size_t i = 0; i < 40; i++) assert(b[i] == 0);
  size_t n = (size_t)3 << 20;
  unsigned char *big = scr_plr_alloc(n);
  assert(((uintptr_t)big & 7) == 0 && (uintptr_t)big + n <= ((uintptr_t)32 << 30));
  for (size_t i = 0; i < n; i += 4096) assert(big[i] == 0);
  fill(big, n, 3);
  verify(big, n, 3);
  scr_heap_stats(&total1, &used1);
  assert(total1 - total0 >= (double)n && used1 - used0 >= (double)n && used1 <= total1);
}

#ifdef SCR_WORKERS
/* Threads carve the region concurrently: every block is zeroed and keeps
 * what its thread wrote. */
#define REGION_THREADS 4u
#define REGION_BLOCKS 20000u
static unsigned char *region_blocks[REGION_THREADS][REGION_BLOCKS];

static void *region_alloc(void *arg) {
  unsigned t = (unsigned)(uintptr_t)arg;
  for (unsigned i = 0; i < REGION_BLOCKS; i++) {
    unsigned char *p = scr_plr_alloc(24);
    for (size_t k = 0; k < 24; k++) assert(p[k] == 0);
    fill(p, 24, (unsigned char)(t * 31 + i));
    region_blocks[t][i] = p;
  }
  return NULL;
}

static void check_program_lifetime_region_threads(void) {
  pthread_t threads[REGION_THREADS];
  for (unsigned t = 0; t < REGION_THREADS; t++)
    assert(pthread_create(&threads[t], NULL, region_alloc, (void *)(uintptr_t)t) == 0);
  for (unsigned t = 0; t < REGION_THREADS; t++) assert(pthread_join(threads[t], NULL) == 0);
  for (unsigned t = 0; t < REGION_THREADS; t++)
    for (unsigned i = 0; i < REGION_BLOCKS; i++)
      verify(region_blocks[t][i], 24, (unsigned char)(t * 31 + i));
}
#endif
#endif


#if defined(SCR_SA_WINDOW_TEST_CHUNKS) && SCR_SMALL_ALLOC
#include <sys/wait.h>
#include <unistd.h>
/* A window of SCR_SA_WINDOW_TEST_CHUNKS chunks fills up: later small blocks
 * come from the system allocator and behave as before, and freeing either
 * kind is safe. */
static void check_window_exhaustion(void) {
  enum { SZ = 64, N = SCR_SA_WINDOW_TEST_CHUNKS * (SCR_SA_CHUNK / SZ) + 1000 };
  static unsigned char *block[N];
  size_t mine = 0, system = 0;
  for (size_t i = 0; i < N; i++) {
    block[i] = scr_mem_calloc(SZ);
    assert(block[i] && aligned(block[i], SZ));
    for (size_t k = 0; k < SZ; k++) assert(block[i][k] == 0);
    fill(block[i], SZ, (unsigned char)i);
    if (owned(block[i])) mine++;
    else system++;
  }
  assert(mine > 0 && system >= 1000);
  assert(scr_sa.span == ((uintptr_t)SCR_SA_WINDOW_TEST_CHUNKS << SCR_SA_CHUNK_SHIFT));
  for (size_t i = 0; i < N; i++) {
    verify(block[i], SZ, (unsigned char)i);
    block[i] = scr_mem_realloc(block[i], SZ / 2);
    verify(block[i], SZ / 2, (unsigned char)i);
  }
  for (size_t i = 0; i < N; i++) scr_mem_free(block[i]);
  /* Freed blocks of the window are reused before the system's. */
  unsigned char *again = scr_mem_alloc(SZ);
  assert(owned(again));
  scr_mem_free(again);
}

#ifdef __linux__
/* Program-lifetime objects past the window end the process as Node does
 * when its heap is full: its message and an abort. */
static void check_window_heap_limit(void) {
  int fds[2];
  assert(pipe(fds) == 0);
  pid_t child = fork();
  assert(child >= 0);
  if (child == 0) {
    (void)dup2(fds[1], 2);
    scr_plr_init();
    for (;;) (void)scr_plr_alloc((size_t)1 << 20);
  }
  close(fds[1]);
  char out[256] = {0};
  size_t got = 0;
  ssize_t r;
  while (got < sizeof out - 1 && (r = read(fds[0], out + got, sizeof out - 1 - got)) > 0) got += (size_t)r;
  close(fds[0]);
  int status = 0;
  assert(waitpid(child, &status, 0) == child);
  assert(WIFSIGNALED(status) && WTERMSIG(status) == SIGABRT);
  assert(strcmp(out, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n") == 0);
}
#endif
#endif

#if SCR_SMALL_ALLOC
/* Whether p lies in the window (any owner). */
static bool in_window(const void *p) { return (uintptr_t)p - scr_sa.base < scr_sa.span; }

#if defined(__linux__)
/* The resident pages of [p, p + n). */
static size_t resident_pages_at(const void *p, size_t n) {
  size_t page = (size_t)sysconf(_SC_PAGESIZE), count = 0, np = (n + page - 1) / page;
  unsigned char *vec = malloc(np);
  assert(vec && mincore((void *)p, np * page, vec) == 0);
  for (size_t i = 0; i < np; i++) count += vec[i] & 1;
  free(vec);
  return count;
}
#endif

/* Blocks a 32-bit reference may name come from the window above SCR_SA_MAX
 * too: large classes up to 2 MiB, runs of chunks beyond. They keep their
 * contents through realloc, come back zeroed from calloc, and are reused. */
static void check_large_blocks(void) {
  static const size_t sizes[] = {513, 640, 641, 1000, 4096, 65536, 100000, (size_t)2 << 20,
                                 ((size_t)2 << 20) + 1, (size_t)5 << 20, (size_t)9 << 20};
  for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
    size_t n = sizes[i];
    unsigned char *p = scr_mem_alloc_ref(n);
    assert(p && in_window(p) && aligned(p, 16) && scr_mem_block_size(p) >= n);
    fill(p, n, (unsigned char)i);
    unsigned char *z = scr_mem_calloc_ref(n);
    assert(z && in_window(z) && z != p);
    for (size_t k = 0; k < n; k += 61) assert(z[k] == 0);
    assert(z[n - 1] == 0);
    fill(z, n, (unsigned char)(i + 1));
    verify(p, n, (unsigned char)i);
    scr_mem_free(z);
    /* A freed block of a class is the next one of the class; it comes
     * back zeroed from calloc. */
    if (n <= ((size_t)2 << 20)) {
      unsigned char *again = scr_mem_calloc_ref(n);
      assert(again == z);
      for (size_t k = 0; k < n; k += 61) assert(again[k] == 0);
      scr_mem_free(again);
    }
    scr_mem_free(p);
  }
  /* A freed run is taken again first, and reads as zero. */
  unsigned char *run = scr_mem_alloc_ref((size_t)9 << 20);
  fill(run, (size_t)9 << 20, 3);
  scr_mem_free(run);
  unsigned char *run2 = scr_mem_calloc_ref((size_t)9 << 20);
  assert(run2 == run);
  for (size_t k = 0; k < ((size_t)9 << 20); k += 4093) assert(run2[k] == 0);
  scr_mem_free(run2);
  /* Growth keeps the contents and stays in the window, through
   * scr_mem_realloc_ref and through scr_mem_realloc of a large block. */
  size_t steps[] = {600, 3000, 70000, (size_t)3 << 20, (size_t)9 << 20, 5000};
  unsigned char *g = scr_mem_alloc_ref(100);
  fill(g, 100, 9);
  size_t have = 100;
  for (size_t i = 0; i < sizeof steps / sizeof steps[0]; i++) {
    size_t n = steps[i];
    g = (i % 2) ? scr_mem_realloc(g, n) : scr_mem_realloc_ref(g, n);
    assert(g && (n <= SCR_SA_MAX || in_window(g)));
    verify(g, have < n ? have : n, 9);
    fill(g, n, 9);
    have = n;
  }
  scr_mem_free(g);
  /* Freed blocks give their pages back on a trim, and still serve. */
  enum { NB = 64 };
  static unsigned char *b[NB];
  for (size_t i = 0; i < NB; i++) {
    b[i] = scr_mem_alloc_ref(65536);
    fill(b[i], 65536, (unsigned char)i);
  }
  for (size_t i = 0; i < NB; i++) scr_mem_free(b[i]);
  scr_heap_trim();
  for (size_t i = 0; i < NB; i++) {
    b[i] = scr_mem_calloc_ref(65536);
    assert(in_window(b[i]));
    for (size_t k = 0; k < 65536; k += 509) assert(b[i][k] == 0);
    fill(b[i], 65536, (unsigned char)(i + 7));
  }
  for (size_t i = 0; i < NB; i++) {
    verify(b[i], 65536, (unsigned char)(i + 7));
    scr_mem_free(b[i]);
  }
#if defined(__linux__)
  /* A run grows by moving its pages to a larger run: the contents stay, and
   * the old range returns to the window reading as zero, without resident
   * pages. */
  {
    size_t small_run = (size_t)5 << 20, big_run = (size_t)21 << 20;
    unsigned char *r = scr_mem_alloc_ref(small_run);
    fill(r, small_run, 0x3c);
    unsigned char *g2 = scr_mem_realloc_ref(r, big_run);
    assert(g2 && g2 != r && in_window(g2));
    verify(g2, small_run, 0x3c);
    fill(g2, big_run, 0x5d);
    assert(scr_sa_chunks[((uintptr_t)r - scr_sa.base) >> SCR_SA_CHUNK_SHIFT] == 0);
    assert(resident_pages_at(r, small_run) == 0);
    verify(g2, big_run, 0x5d);
    scr_mem_free(g2);
  }
#endif
  /* A class whose blocks are not whole pages: a trimmed block's last page
   * kept its bytes, and calloc clears them too. */
  enum { ODD = 10000 };
  for (size_t i = 0; i < NB; i++) {
    b[i] = scr_mem_alloc_ref(ODD);
    fill(b[i], ODD, 0xa5);
  }
  for (size_t i = 0; i < NB; i++) scr_mem_free(b[i]);
  scr_heap_trim();
  for (size_t i = 0; i < NB; i++) {
    b[i] = scr_mem_calloc_ref(ODD);
    for (size_t k = 0; k < ODD; k++) assert(b[i][k] == 0);
  }
  for (size_t i = 0; i < NB; i++) scr_mem_free(b[i]);
}
#endif

#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC
/* Large blocks freed by another thread go back to their arena, and a large
 * run freed by another thread goes back to the window. */
enum { LARGE_HANDOFF = 200 };
static unsigned char *large_handoff[LARGE_HANDOFF];
static void *large_allocate(void *arg) {
  (void)arg;
  for (size_t i = 0; i < LARGE_HANDOFF; i++) {
    size_t n = i % 10 == 0 ? ((size_t)3 << 20) : 600 + i * 97;
    large_handoff[i] = scr_mem_alloc_ref(n);
    assert(large_handoff[i] && in_window(large_handoff[i]));
    fill(large_handoff[i], 600, (unsigned char)i);
  }
  return NULL;
}
static void *large_reuse(void *arg) {
  (void)arg;
  /* This thread may claim the parked arena, whose remote list holds the
   * blocks; either way its blocks are its own. */
  for (size_t i = 0; i < LARGE_HANDOFF; i++) {
    unsigned char *p = scr_mem_calloc_ref(600 + i * 97);
    assert(p && in_window(p));
    for (size_t k = 0; k < 600; k++) assert(p[k] == 0);
    scr_mem_free(p);
  }
  return NULL;
}
static void check_large_threads(void) {
  pthread_t t;
  assert(pthread_create(&t, NULL, large_allocate, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
  for (size_t i = 0; i < LARGE_HANDOFF; i++) {
    verify(large_handoff[i], 600, (unsigned char)i);
    scr_mem_free(large_handoff[i]); /* remote frees, and runs back to the window */
  }
  assert(pthread_create(&t, NULL, large_reuse, NULL) == 0);
  assert(pthread_join(t, NULL) == 0);
}
#endif

#if SCR_SMALL_ALLOC && defined(__linux__) && !defined(SCR_WORKERS) && !defined(SCR_SA_WINDOW_TEST_CHUNKS)
/* A program without workers carves each small class from its slice at the
 * start of the window: a block's class is its offset >> SCR_SA_SLICE_SHIFT.
 * A class that outgrows its slice goes on in chunks elsewhere in the window,
 * whose blocks the free finds through the chunk map. SLICE_SIZE is a class
 * the other checks leave unused. */
enum { SLICE_SIZE = 168 };
static int cmp_ptr(const void *a, const void *b) {
  uintptr_t x = (uintptr_t) * (unsigned char *const *)a, y = (uintptr_t) * (unsigned char *const *)b;
  return x < y ? -1 : x > y;
}
static void check_slices(void) {
  unsigned char *p = scr_mem_alloc(SLICE_SIZE);
  assert(p && owned(p));
  assert(scr_sa_slice_span == (uintptr_t)SCR_SA_NCLASS << SCR_SA_SLICE_SHIFT);
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  assert(off < scr_sa_slice_span && (off >> SCR_SA_SLICE_SHIFT) == class_of(p));
  scr_mem_free(p);
  assert(scr_mem_alloc(SLICE_SIZE) == p);
  scr_mem_free(p);
  if (SCR_SA_SLICE_SHIFT > 24) return; /* overflow needs the test's small slices */
  size_t n = ((size_t)2 << SCR_SA_SLICE_SHIFT) / SLICE_SIZE;
  unsigned char **b = malloc(n * sizeof *b);
  assert(b);
  size_t outside = 0;
  for (size_t i = 0; i < n; i++) {
    b[i] = scr_mem_alloc(SLICE_SIZE);
    assert(b[i] && owned(b[i]) && class_of(b[i]) == class_of(p));
    fill(b[i], SLICE_SIZE, (unsigned char)i);
    outside += (uintptr_t)b[i] - scr_sa.base >= scr_sa_slice_span;
  }
  assert(outside > n / 3);
  for (size_t i = 0; i < n; i++) verify(b[i], SLICE_SIZE, (unsigned char)i);
  unsigned char **old = malloc(n * sizeof *old);
  assert(old);
  memcpy(old, b, n * sizeof *b);
  qsort(old, n, sizeof *old, cmp_ptr);
  for (size_t i = 0; i < n; i++) scr_mem_free(b[i]);
  /* Every block came back to the class, in the slice and past it: the next
   * n blocks are the same ones. */
  for (size_t i = 0; i < n; i++) {
    b[i] = scr_mem_alloc(SLICE_SIZE);
    assert(bsearch(&b[i], old, n, sizeof *old, cmp_ptr));
  }
  for (size_t i = 0; i < n; i++) scr_mem_free(b[i]);
  free(old);
  free(b);
}
#endif

#if SCR_SMALL_ALLOC && defined(__linux__)
/* The chunk map mirrors the chunk table while the window lies below 32 GiB,
 * and the free paths find the thread's blocks there. A block freed through
 * scr_sa_free_foreign, which every free takes while the map is empty, goes
 * back to its class as well. */
static void check_chunk_map(void) {
  unsigned char *p = scr_mem_alloc(72);
  assert(p && owned(p));
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  if (scr_sa.base + scr_sa.span <= (uintptr_t)SCR_SA_MAP_CHUNKS << SCR_SA_CHUNK_SHIFT)
    assert(scr_sa_chunk_map[(uintptr_t)p >> SCR_SA_CHUNK_SHIFT] == scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT]);
  assert(scr_sa.tag != SCR_SA_TAG_NONE);
#ifndef SCR_WORKERS
  scr_sa_free_foreign(p);
  unsigned char *q = scr_mem_alloc(72);
  assert(q == p);
  scr_mem_free(q);
#else
  scr_mem_free(p);
#endif
}
#endif

int main(void) {
#if defined(SCR_SA_WINDOW_TEST_CHUNKS) && SCR_SMALL_ALLOC
  check_window_exhaustion();
#ifdef __linux__
  check_window_heap_limit();
#endif
  printf("allocator checks passed: small window\n");
  return 0;
#endif
#if SCR_SMALL_ALLOC
  check_chunk_growth(); /* first: its class must be untouched */
#endif
  check_classes();
#if SCR_SMALL_ALLOC
  check_large_blocks();
#endif
#if SCR_SMALL_ALLOC && defined(__linux__)
  check_chunk_map();
#endif
#if SCR_SMALL_ALLOC && defined(__linux__) && !defined(SCR_WORKERS) && !defined(SCR_SA_WINDOW_TEST_CHUNKS)
  check_slices();
#endif
  check_alignment_and_zeroing();
  check_realloc();
  check_system_pointers();
  check_churn();
  check_free_order();
#if defined(__linux__) && SCR_SMALL_ALLOC && defined(FORK_CHECK)
  check_fork_while_prefaulting();
#endif
#if SCR_SMALL_ALLOC && defined(__linux__) && defined(__GLIBC__)
  check_heap_huge_pages();
#endif
#if defined(__linux__) && SCR_SMALL_ALLOC
  check_program_lifetime_region();
#ifdef SCR_WORKERS
  check_program_lifetime_region_threads();
#endif
#endif
#if defined(SCR_WORKERS) && SCR_SMALL_ALLOC
  /* A short discard delay, which stays at its start until check_discard_delay_grows. */
  setenv("SCR_SA_DISCARD_DELAY_MS", "100", 1);
  setenv("SCR_SA_DISCARD_DELAY_MAX_MS", "0", 1);
  check_threads();
  check_large_threads();
#if defined(__linux__) && defined(__GLIBC__)
  check_thread_heap_huge_pages();
#endif
#ifdef __linux__
  check_trim();
  check_release_frontiers();
  check_discard();
  check_discard_ref_blocks();
  check_discard_delay_grows();
  check_discard_waits_for_loop();
  check_idle_trim();
#endif
  printf("allocator checks passed: size-class workers\n");
#else
  printf("allocator checks passed: %s\n", SCR_SMALL_ALLOC ? "size-class" : "system");
#endif
  return 0;
}
