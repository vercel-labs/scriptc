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
ScrSaState scr_sa = {0};

#if SCR_SMALL_ALLOC
#include <sys/mman.h>

static bool scr_sa_refused;

/* Reserve address space for every class slice at once; smaller slices are
 * tried when the host limits address space or overcommit. */
static bool scr_sa_reserve(void) {
  for (unsigned shift = 30; shift >= 24; shift -= 2) {
    size_t span = (size_t)SCR_SA_NCLASS << shift;
    int flags = MAP_PRIVATE | MAP_ANON;
#ifdef MAP_NORESERVE
    flags |= MAP_NORESERVE;
#endif
    void *p = mmap(NULL, span, PROT_READ | PROT_WRITE, flags, -1, 0);
    if (p == MAP_FAILED) continue;
#if defined(__linux__) && defined(MADV_NOHUGEPAGE)
    /* Each class touches its own slice; transparent huge pages would make
     * every touched slice a 2 MiB resident minimum. */
    (void)madvise(p, span, MADV_NOHUGEPAGE);
#endif
    scr_sa.base = (uintptr_t)p;
    scr_sa.shift = shift;
    scr_sa.span = span;
    return true;
  }
  scr_sa_refused = true;
  return false;
}

/* Runs once per class (to reserve and open its slice) and then only for
 * blocks the fast path does not serve. */
__attribute__((cold, noinline)) void *scr_sa_slow(size_t n, bool zero) {
  if (n - 1 < SCR_SA_MAX && (scr_sa.span || (!scr_sa_refused && scr_sa_reserve()))) {
    unsigned c = (unsigned)((n - 1) / SCR_SA_STEP);
    if (!scr_sa.lim[c]) { /* open the class slice; fresh pages are zero */
      char *p = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
      scr_sa.lim[c] = p + ((size_t)1 << scr_sa.shift);
      scr_sa.bump[c] = p + (size_t)(c + 1) * SCR_SA_STEP;
      return p;
    }
  }
  /* Large or zero-sized, an exhausted slice, or no reservation. */
  return zero ? calloc(1, n) : malloc(n);
}

void *scr_mem_realloc(void *p, size_t n) {
  if (!p) return scr_mem_alloc(n);
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  if (off >= scr_sa.span) return realloc(p, n);
  size_t have = (size_t)((off >> scr_sa.shift) + 1) * SCR_SA_STEP;
  if (n && n <= have) return p; /* still fits its block */
  void *q = scr_mem_alloc(n ? n : 1);
  if (!q) return NULL;
  memcpy(q, p, have < n ? have : n);
  scr_mem_free(p);
  return q;
}
#else
void *scr_mem_realloc(void *p, size_t n) { return realloc(p, n); }
#endif

void *scr_rt_calloc(size_t n) { return scr_mem_calloc(n); }
void scr_rt_free(void *p) { scr_mem_free(p); }
