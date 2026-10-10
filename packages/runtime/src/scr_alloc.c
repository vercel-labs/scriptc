/* scriptc runtime — small-object allocator state and slow paths.
 *
 * The fast paths (free-list pop, bump carve, free-list push) are inline in
 * scr_runtime.h; see the contract there. This unit owns the process-wide
 * state, the address-space reservation, the refill/fallback path, realloc,
 * and the out-of-line entry points the LLVM backend calls for acyclic
 * records and class instances.
 *
 * Freed blocks are recycled within their class and never returned to the
 * operating system; the reservation itself costs address space only, and
 * pages are committed as the bump pointers first touch them. */
#include "scr_runtime.h"

/* Defined in every build: the emitted fast paths read it (see the layout
 * contract in scr_runtime.h); without the allocator it stays all-zero.
 * Explicitly initialized so it is an ordinary (localizable) definition: a
 * tentative definition becomes a COMMON symbol, which library localization
 * deliberately keeps global (abi.localize_runtime), leaking it from every
 * localized library archive. */
#ifdef SCR_WORKERS
_Thread_local ScrThreadHot scr_thread_hot = {{0}};
#else
ScrSaState scr_sa = {0};
#endif

#if SCR_SMALL_ALLOC
#include <sys/mman.h>

/* Page policy. Slice pages are committed by first touch, which on 4 KiB
 * pages is one fault (and page clear) per 4 KiB the bump pointers cross.
 * Transparent huge pages fault 2 MiB at a time and shrink the TLB working
 * set, but make the whole 2 MiB page around a bump pointer resident at once,
 * so every class slice in use (per arena, in worker executables) would cost
 * up to 2 MiB more than it holds. A slice therefore starts on small pages
 * and moves the rest of its range to huge pages once it has carved
 * SCR_SA_HUGE_AFTER bytes: only slices that already hold that much pay the
 * partial last huge page. The reservation is huge-page aligned so the
 * switch point and every slice start on a huge-page boundary. */
#if defined(__linux__) && defined(MADV_HUGEPAGE) && defined(MADV_NOHUGEPAGE)
#define SCR_SA_THP 1
#define SCR_SA_HUGE_PAGE ((size_t)2 << 20)
#define SCR_SA_HUGE_AFTER ((size_t)8 << 20)
#endif

/* Maps span bytes of address space for slices (huge-page aligned where the
 * policy above applies), or NULL. */
static void *scr_sa_map(size_t span) {
  int flags = MAP_PRIVATE | MAP_ANON;
#ifdef MAP_NORESERVE
  flags |= MAP_NORESERVE;
#endif
#ifdef SCR_SA_THP
  size_t pad = SCR_SA_HUGE_PAGE;
#else
  size_t pad = 0;
#endif
  char *p = mmap(NULL, span + pad, PROT_READ | PROT_WRITE, flags, -1, 0);
  if (p == MAP_FAILED) return NULL;
#ifdef SCR_SA_THP
  char *a = (char *)(((uintptr_t)p + pad - 1) & ~(uintptr_t)(pad - 1));
  if (a > p) (void)munmap(p, (size_t)(a - p));
  (void)munmap(a + span, (size_t)(p + pad - a)); /* a < p + pad */
  p = a;
  (void)madvise(p, span, MADV_NOHUGEPAGE);
#endif
  return p;
}

/* The next bump limit of a class slice [start, end) whose limit is lim
 * (< end): its small-page prefix ends at SCR_SA_HUGE_AFTER, where the rest
 * of the slice switches to huge pages. */
static char *scr_sa_extend(char *start, char *lim, char *end) {
#ifdef SCR_SA_THP
  if ((size_t)(lim - start) < SCR_SA_HUGE_AFTER && (size_t)(end - start) > SCR_SA_HUGE_AFTER)
    return start + SCR_SA_HUGE_AFTER;
  if (lim > start) (void)madvise(lim, (size_t)(end - lim), MADV_HUGEPAGE);
#else
  (void)start;
  (void)lim;
#endif
  return end;
}

#ifdef SCR_WORKERS
#include <pthread.h>
#include <stdatomic.h>

/* Per-thread arenas (contract in scr_runtime.h). The region is reserved
 * once; arena i spans [region + i * arena_span, + arena_span) and is split
 * into class slices exactly like the single-threaded reservation. */
#define SCR_SA_ARENAS 32u
static pthread_mutex_t scr_sa_region_lock = PTHREAD_MUTEX_INITIALIZER;
static _Atomic(uintptr_t) scr_sa_region; /* 0 until reserved */
static uintptr_t scr_sa_arena_span;
static unsigned scr_sa_region_shift;
static bool scr_sa_region_refused;
static _Atomic(uint32_t) scr_sa_claimed;              /* one bit per arena */
static ScrSaState scr_sa_parked[SCR_SA_ARENAS];         /* unowned arenas */
static _Atomic(ScrSaBlock *) scr_sa_remote[SCR_SA_ARENAS]; /* foreign frees */
static _Thread_local int scr_sa_arena = -1;
static _Thread_local bool scr_sa_refused; /* this thread got no arena */
_Static_assert(SCR_SA_ARENAS <= 32, "one claim bit per arena");

static bool scr_sa_reserve_region(void) {
  pthread_mutex_lock(&scr_sa_region_lock);
  if (!atomic_load_explicit(&scr_sa_region, memory_order_acquire) && !scr_sa_region_refused) {
    /* Same per-class slice ladder as the single-threaded reservation, for
     * every arena at once; hosts that limit address space get smaller
     * slices (each slice that fills falls back to the system). */
    for (unsigned shift = 30; shift >= 22; shift -= 2) {
      size_t arena = (size_t)SCR_SA_NCLASS << shift;
      size_t span = arena * SCR_SA_ARENAS;
      void *p = scr_sa_map(span);
      if (!p) continue;
      scr_sa_arena_span = arena;
      scr_sa_region_shift = shift;
      atomic_store_explicit(&scr_sa_region, (uintptr_t)p, memory_order_release);
      break;
    }
    if (!atomic_load_explicit(&scr_sa_region, memory_order_relaxed)) scr_sa_region_refused = true;
  }
  pthread_mutex_unlock(&scr_sa_region_lock);
  return atomic_load_explicit(&scr_sa_region, memory_order_acquire) != 0;
}

/* Moves every block other threads freed into this arena's free lists. */
static void scr_sa_drain_remote(void) {
  ScrSaBlock *b = atomic_exchange_explicit(&scr_sa_remote[scr_sa_arena], NULL, memory_order_acquire);
  while (b) {
    ScrSaBlock *next = b->next;
    unsigned c = (unsigned)(((uintptr_t)b - scr_sa.base) >> scr_sa.shift);
    b->next = scr_sa.free[c];
    scr_sa.free[c] = b;
    b = next;
  }
}

/* Claims an arena for the calling thread: a parked one continues with its
 * free lists and bump pointers, a fresh one starts empty. */
static bool scr_sa_reserve(void) {
  if (!atomic_load_explicit(&scr_sa_region, memory_order_acquire) && !scr_sa_reserve_region()) {
    scr_sa_refused = true;
    return false;
  }
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
  uint32_t claimed = atomic_load_explicit(&scr_sa_claimed, memory_order_relaxed);
  for (;;) {
    if (claimed == UINT32_MAX) {
      scr_sa_refused = true;
      return false;
    }
    unsigned i = (unsigned)__builtin_ctz(~claimed);
    if (atomic_compare_exchange_weak_explicit(&scr_sa_claimed, &claimed, claimed | (1u << i),
                                              memory_order_acquire, memory_order_relaxed)) {
      scr_sa_arena = (int)i;
      scr_sa = scr_sa_parked[i];
      if (!scr_sa.span) {
        memset(&scr_sa, 0, sizeof scr_sa);
        scr_sa.base = region + (uintptr_t)i * scr_sa_arena_span;
        scr_sa.span = scr_sa_arena_span;
        scr_sa.shift = scr_sa_region_shift;
      }
      scr_sa_drain_remote();
      return true;
    }
  }
}

void scr_sa_thread_park(void) {
  if (scr_sa_arena < 0) return;
  unsigned i = (unsigned)scr_sa_arena;
  scr_sa_parked[i] = scr_sa;
  /* Later frees on this thread (thread-exit destructors) take the foreign
   * path into the parked arena's remote list. */
  memset(&scr_sa, 0, sizeof scr_sa);
  scr_sa_arena = -1;
  scr_sa_refused = true;
  atomic_fetch_and_explicit(&scr_sa_claimed, ~(1u << i), memory_order_release);
}

/* The class size of a block in another thread's arena, or 0 outside the
 * region (a system block). */
static size_t scr_sa_foreign_size(const void *p) {
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
  uintptr_t off = (uintptr_t)p - region;
  if (!region || off >= scr_sa_arena_span * SCR_SA_ARENAS) return 0;
  return (size_t)(((off % scr_sa_arena_span) >> scr_sa_region_shift) + 1) * SCR_SA_STEP;
}

void scr_sa_free_foreign(void *p) {
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
  uintptr_t off = (uintptr_t)p - region;
  if (region && off < scr_sa_arena_span * SCR_SA_ARENAS) {
    unsigned i = (unsigned)(off / scr_sa_arena_span);
    ScrSaBlock *b = p;
    ScrSaBlock *head = atomic_load_explicit(&scr_sa_remote[i], memory_order_relaxed);
    do b->next = head;
    while (!atomic_compare_exchange_weak_explicit(&scr_sa_remote[i], &head, b, memory_order_release,
                                                  memory_order_relaxed));
    return;
  }
  free(p);
}
#else
static bool scr_sa_refused;

/* Reserve address space for every class slice at once; smaller slices are
 * tried when the host limits address space or overcommit. */
static bool scr_sa_reserve(void) {
  for (unsigned shift = 30; shift >= 24; shift -= 2) {
    size_t span = (size_t)SCR_SA_NCLASS << shift;
    void *p = scr_sa_map(span);
    if (!p) continue;
    scr_sa.base = (uintptr_t)p;
    scr_sa.shift = shift;
    scr_sa.span = span;
    return true;
  }
  scr_sa_refused = true;
  return false;
}
#endif /* SCR_WORKERS */

/* Runs once per class (to reserve and open its slice) and then only for
 * blocks the fast path does not serve. */
__attribute__((cold, noinline)) void *scr_sa_slow(size_t n, bool zero) {
  if (n - 1 < SCR_SA_MAX && (scr_sa.span || (!scr_sa_refused && scr_sa_reserve()))) {
    unsigned c = (unsigned)((n - 1) / SCR_SA_STEP);
#ifdef SCR_WORKERS
    /* A claimed arena may be a parked one with free blocks and bump room,
     * and other threads may have returned blocks since the last miss. */
    if (atomic_load_explicit(&scr_sa_remote[scr_sa_arena], memory_order_relaxed))
      scr_sa_drain_remote();
    ScrSaBlock *b = scr_sa.free[c];
    if (b) {
      scr_sa.free[c] = b->next;
      if (zero) memset(b, 0, n);
      return b;
    }
#endif
    /* Carve from the slice, opening it or raising its limit as needed;
     * fresh pages are zero. */
    size_t sz = (size_t)(c + 1) * SCR_SA_STEP;
    char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
    char *end = start + ((size_t)1 << scr_sa.shift);
    char *p = scr_sa.lim[c] ? scr_sa.bump[c] : start;
    char *lim = scr_sa.lim[c] ? scr_sa.lim[c] : start;
    while ((size_t)(lim - p) < sz && lim < end) lim = scr_sa_extend(start, lim, end);
    scr_sa.lim[c] = lim;
    if ((size_t)(lim - p) >= sz) {
      scr_sa.bump[c] = p + sz;
      return p;
    }
    scr_sa.bump[c] = p;
  }
  /* Large or zero-sized, an exhausted slice, or no reservation. */
  return zero ? calloc(1, n) : malloc(n);
}

void *scr_mem_realloc(void *p, size_t n) {
  if (!p) return scr_mem_alloc(n);
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  size_t have;
  if (off < scr_sa.span) have = (size_t)((off >> scr_sa.shift) + 1) * SCR_SA_STEP;
#ifdef SCR_WORKERS
  else if ((have = scr_sa_foreign_size(p)) != 0) {
    /* Another arena's block: move it into this thread's allocator. */
  }
#endif
  else return realloc(p, n);
  if (n && n <= have) return p; /* still fits its block */
  void *q = scr_mem_alloc(n ? n : 1);
  if (!q) return NULL;
  memcpy(q, p, have < n ? have : n);
  scr_mem_free(p);
  return q;
}
#else
void *scr_mem_realloc(void *p, size_t n) { return realloc(p, n); }
#ifdef SCR_WORKERS
void scr_sa_thread_park(void) {}
void scr_sa_free_foreign(void *p) { free(p); }
#endif
#endif

void *scr_rt_calloc(size_t n) { return scr_mem_calloc(n); }
void scr_rt_free(void *p) { scr_mem_free(p); }
