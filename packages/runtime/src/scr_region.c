/* Counted lifetime regions (@scriptc/experimental LifetimeRegion): the
 * allocator, the region table and the release check for ProgramLifetime
 * instances. The emitted half (llvm/regions.ts) inlines the allocation fast
 * path and the count updates, and supplies the per-class visits and the
 * walkers of ordinary classes and records; the contract is in
 * scr_runtime.h.
 *
 * Threads. Every script thread owns its regions, its cursors and its
 * default region; region ids are process-wide and never reused, so a region
 * handle that reaches another thread (or outlives its region) selects that
 * thread's default region and releases nothing. Chunks record their owner:
 * worker executables count only references to their own chunks, so a
 * published instance that other threads read is never counted by them.
 * Publication makes an instance immortal (rc == SIZE_MAX); the release walk
 * sees that and pins the region, which is then never freed.
 *
 * Counting. The default regions are never freed, so references to their
 * objects are not counted (their chunks have no owner), and until the first
 * region exists nothing is counted at all (scr_region_counting): a program
 * that supports regions pays for counts only once it uses one.
 *
 * The release check. A walk visits every instance of the region (each
 * class's visit reports its reference fields) and, from there, every
 * ordinary object it can explain: classes and records through the emitted
 * walkers, and the runtime's own containers (arrays, maps and sets, unions,
 * closures and their capture boxes, dyn values) through the release entry
 * points they store for their elements. Each ordinary object reached is an
 * entry: the references the walk found to it, the references it holds into
 * the region, and the entries it references. An entry whose count exceeds
 * the references found is referenced from outside, and so is everything it
 * reaches. The region is freed when the references found from its own
 * objects and from the entries nothing outside references add up to its
 * counted references. Anything the walk cannot see only leaves references
 * unexplained: mistakes keep memory, they never free it.
 *
 * Sanitized builds (the RC audit lane, AddressSanitizer) never reuse a
 * freed chunk: it stays mapped without access, so any use after free
 * faults. SCRIPTC_REGION_STATS=1 reports every release attempt on stderr. */

#include "scr_runtime.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#include <malloc.h>
#define SCR_RGN_MMAP 0
#elif defined(__wasi__) || defined(__wasm__)
#define SCR_RGN_MMAP 0
#else
#include <sys/mman.h>
#define SCR_RGN_MMAP 1
#endif

#if defined(SCR_RC_AUDIT) || defined(SCR_LSAN_IMMORTAL)
#define SCR_RGN_POISON 1
#endif
#ifdef SCR_LSAN_IMMORTAL
/* Chunks are not heap blocks: register them as leak-scan roots so what
 * their instances hold is reachable, like the published-object roots. */
void __lsan_register_root_region(const void *p, size_t size) __attribute__((weak));
void __lsan_unregister_root_region(const void *p, size_t size) __attribute__((weak));
#endif

#define SCR_RGN_HDR ((size_t)64)
#define SCR_RGN_SEG ((size_t)16384)
#define SCR_RGN_AHEAD ((size_t)256 << 10)      /* see scr_rgn_ahead */
#define SCR_RGN_AHEAD_START ((size_t)1 << 20)  /* see scr_rgn_ahead */
_Static_assert(sizeof(ScrRgnChunk) <= SCR_RGN_HDR, "the chunk header fits before the first segment");

/* Freed chunks a thread keeps for its next regions: a program that frees
 * a region per request or per batch would otherwise map, fault in and
 * unmap its chunks every time. A cached chunk keeps at most its first
 * SCR_RGN_CACHE_WARM bytes resident (cleared), and gets fresh pages past
 * them, so a small region that reuses the chunk of a large one does not
 * hold the large one's memory. The cache holds at most SCR_RGN_CACHE_BYTES
 * of resident chunk memory (whole chunks where chunks are not mapped
 * pages); chunks beyond it, and chunks huge pages may back, are unmapped
 * as before. */
#define SCR_RGN_CACHE_BYTES ((size_t)8 << 20)
#define SCR_RGN_CACHE_WARM ((size_t)256 << 10)

/* Regions start with small pages and switch to huge pages once they span
 * this many chunks (a default region at once): small regions then do not
 * pay a 2 MiB fault, large ones do not pay 512 small ones. */
#define SCR_RGN_HUGE_AFTER 4

/* Retries. A condemned region is attempted at the first retry after its
 * release. An attempt that keeps it records the references counted to it;
 * later retries attempt it again once that count changes, or once the
 * thread has allocated this many bytes in regions (or the kept region's
 * size, if larger) since the attempt, doubling after each attempt that
 * found the count unchanged: references from ordinary objects the walk
 * reaches can go away without changing the count. Retries run at region
 * creation, at release, and at a region entry after this many bytes of
 * region allocation. */
#define SCR_RGN_RETRY_BYTES ((size_t)8 << 20)
#define SCR_RGN_MAX_BACKOFF 6

enum { SCR_RGN_LIVE = 1, SCR_RGN_CONDEMNED, SCR_RGN_PINNED, SCR_RGN_LEAKED };

typedef struct ScrRgnSeg {
  char *start, *end, *limit; /* instances of one class at its stride */
  const ScrRgnClass *cls;
  struct ScrRgnSeg *next;
} ScrRgnSeg;

typedef struct ScrRegion {
  uint64_t id; /* 0: the thread's default region */
  int state;
  uint32_t depth; /* run() frames active on this region */
  size_t fibers;  /* async fibers that carry it (scr_region_fiber_hooks) */
  ScrRgnChunk *chunks;
  size_t nchunks;
  ScrRgnSeg *segs;
  ScrRgnSeg **cur; /* per class slot: the segment allocations continue in */
  size_t ncur;
  size_t bytes;
  ScrRgnChunk *spare; /* the next chunk, mapped and faulted in ahead of use */
  /* After an attempt that kept the region: the references counted then,
   * and when it is attempted regardless (see SCR_RGN_RETRY_BYTES). */
  bool kept;
  int64_t kept_counted;
  size_t retry_at;
  unsigned backoff;
  /* The first check of a retry could not free it (scr_rgn_retry): what that
   * walk found, for the check after the heap pass. */
  bool held;
  int64_t held_counted, held_explained;
  size_t held_black, held_owned;
  double held_walk_ms;
} ScrRegion;

typedef struct {
  ScrRegion *prev, *entered;
} ScrRgnFrame;

/* The release walk's per-thread state (buffers are reused across walks). */
typedef struct {
  void *obj;
  int64_t found; /* references to it the walk saw */
  int64_t rrefs; /* references it holds into the region */
  bool black;    /* referenced from outside, or reached from such an entry */
} ScrRgnEntry;

typedef struct {
  size_t parent, child;
} ScrRgnEdge;

enum {
  SCR_RGN_W_EMITTED,
  SCR_RGN_W_ARR,
  SCR_RGN_W_MAP,
  SCR_RGN_W_UNION,
  SCR_RGN_W_CLOSURE,
  SCR_RGN_W_BOX,
  SCR_RGN_W_DYN,
};

typedef struct {
  size_t entry; /* SCR_RGN_SINGLE: walked like the region's own objects */
  void *obj;
  int kind;
  void (*walk)(void *, ScrRgnWalk *);
} ScrRgnWork;

#define SCR_RGN_SINGLE SIZE_MAX

/* SCRIPTC_REGION_DEBUG reports (scr_rgn_report) are compiled into
 * unoptimized runtimes (the dev flavor, --optimization=dev) and RC-audit
 * builds; release and speed runtimes walk without the bookkeeping. */
#if !defined(SCR_RGN_DEBUG) && (!defined(__OPTIMIZE__) || defined(SCR_RC_AUDIT))
#define SCR_RGN_DEBUG 1
#endif

#ifdef SCR_RGN_DEBUG
/* Where the walk first reached an entry: from the entry `parent` (index +
 * 1), or, when 0, from field `field` of an object of class `cls`. */
typedef struct {
  const ScrRgnClass *cls;
  uint32_t field;
  int kind;
  size_t parent;
} ScrRgnFrom;
#endif

struct ScrRgnWalk {
  ScrRegion *region;
  int64_t internal; /* references found from the region's own objects */
  size_t src;       /* entry index + 1 being walked; 0 = a region object */
  ScrRgnEntry *ents;
  size_t nents, cap_ents;
  size_t singles; /* owned objects walked without an entry */
  size_t *hash; /* open addressing: entry index + 1 */
  size_t cap_hash;
  void **owned; /* the entries' objects, as a set (scr_rgn_owned_set) */
  size_t cap_owned;
  ScrRgnEdge *edges;
  size_t nedges, cap_edges;
  ScrRgnWork *work;
  size_t nwork, cap_work;
#ifdef SCR_RGN_DEBUG
  /* SCRIPTC_REGION_DEBUG: the region object being visited and the index
   * of its next reported field, and where each entry was reached. */
  bool debug;
  const ScrRgnClass *vcls;
  uint32_t vfield;
  ScrRgnFrom *from;
  size_t cap_from;
#endif
};

typedef struct {
  ScrRegion *current, *dflt;
  ScrRgnCursor **cursors; /* per class slot; NULL until this thread allocates it */
  size_t ncursors;
  ScrRegion **regions; /* every non-default region this thread owns and has not freed */
  size_t nregions, cap_regions;
  ScrRgnFrame *stack;
  size_t depth, cap_stack;
  size_t allocated; /* bytes of region segments this thread has allocated */
  size_t checked;   /* `allocated` at the last retry */
  ScrRgnWalk walk;
  ScrRgnChunk *cache;   /* freed chunks, linked through `next` (SCR_RGN_CACHE_BYTES) */
  size_t cache_bytes;   /* their resident bytes, as recorded in each one's `found` */
  bool exit_registered;
  bool exited; /* the exit cleanup ran: the fiber hooks do nothing */
  double cycle_ms; /* the cycle pass before the next attempt (stats) */
  struct {
    size_t created, released, freed, pinned, leaked, attempts;
    size_t heap_passes; /* full cycle passes run for regions */
  } stats;
} ScrRgnThread;

static SCR_TL ScrRgnThread scr_rgn;

static _Atomic(uint64_t) scr_rgn_next_id = 1;
static _Atomic(int32_t) scr_rgn_next_slot = 0;
static _Atomic(const ScrRgnType *) scr_rgn_types = NULL;
static _Atomic(int) scr_rgn_stats_mode = -1;

/* The walker index of the emitted type table, by release entry point.
 * Built once, by the first walk; the table itself is constant. */
static _Atomic(int) scr_rgn_index_state = 0; /* 0 none, 1 building, 2 ready */
static const ScrRgnType **scr_rgn_index;
static size_t scr_rgn_index_cap;

static bool scr_rgn_stats(void) {
  int mode = atomic_load_explicit(&scr_rgn_stats_mode, memory_order_relaxed);
  if (mode < 0) {
    const char *env = scr_getenv("SCRIPTC_REGION_STATS");
    mode = env != NULL && env[0] != 0 && strcmp(env, "0") != 0;
    atomic_store_explicit(&scr_rgn_stats_mode, mode, memory_order_relaxed);
  }
  return mode != 0;
}

/* SCRIPTC_REGION_DEBUG: the lines scr_rgn_report prints per kept attempt
 * (0: off). 1 prints up to 10; a larger number sets the limit. Runtimes
 * built without the reports say so once instead. */
static _Atomic(long) scr_rgn_debug_mode = -1;

static size_t scr_rgn_debug(void) {
  long mode = atomic_load_explicit(&scr_rgn_debug_mode, memory_order_relaxed);
  if (mode < 0) {
    const char *env = scr_getenv("SCRIPTC_REGION_DEBUG");
    mode = env ? strtol(env, NULL, 10) : 0;
    if (mode < 0) mode = 0;
    if (mode == 1) mode = 10;
    atomic_store_explicit(&scr_rgn_debug_mode, mode, memory_order_relaxed);
  }
  return (size_t)mode;
}

static void *scr_rgn_grow(void *p, size_t *cap, size_t size, size_t first) {
  size_t n = *cap ? *cap * 2 : first;
  void *q = realloc(p, n * size);
  if (!q) scr_trap("scriptc: out of memory\n");
  *cap = n;
  return q;
}

_Atomic uint8_t scr_region_counting = 0;

/* The owner word of the calling thread's freeable chunks: worker
 * executables compare it with the thread's own &scr_thread_hot. */
static void *scr_rgn_self(void) {
#ifdef SCR_WORKERS
  return &scr_thread_hot;
#else
  return &scr_rgn;
#endif
}

/* ── chunks and segments ─────────────────────────────────────────────── */

static ScrRgnChunk *scr_rgn_chunk_map(void) {
#if SCR_RGN_MMAP
  char *raw = mmap(NULL, 2 * SCR_RGN_CHUNK, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (raw == MAP_FAILED) scr_trap("scriptc: out of memory\n");
  uintptr_t base = ((uintptr_t)raw + SCR_RGN_CHUNK - 1) & ~(uintptr_t)(SCR_RGN_CHUNK - 1);
  if (base > (uintptr_t)raw) munmap(raw, base - (uintptr_t)raw);
  uintptr_t end = (uintptr_t)raw + 2 * SCR_RGN_CHUNK;
  if (end > base + SCR_RGN_CHUNK) munmap((void *)(base + SCR_RGN_CHUNK), end - (base + SCR_RGN_CHUNK));
  return (ScrRgnChunk *)base;
#elif defined(_WIN32)
  void *p = _aligned_malloc(SCR_RGN_CHUNK, SCR_RGN_CHUNK);
  if (!p) scr_trap("scriptc: out of memory\n");
  memset(p, 0, SCR_RGN_CHUNK);
  return p;
#else
  void *p = aligned_alloc(SCR_RGN_CHUNK, SCR_RGN_CHUNK);
  if (!p) scr_trap("scriptc: out of memory\n");
  memset(p, 0, SCR_RGN_CHUNK);
  return p;
#endif
}

/* A freed region's chunk. Sanitized builds keep it mapped without access
 * and never hand it out again, so a reference that survived faults. */
static void scr_rgn_chunk_unmap(ScrRgnChunk *c) {
#ifdef SCR_LSAN_IMMORTAL
  if (__lsan_unregister_root_region) __lsan_unregister_root_region(c, SCR_RGN_CHUNK);
#endif
#if SCR_RGN_MMAP
#ifdef SCR_RGN_POISON
  if (mprotect(c, SCR_RGN_CHUNK, PROT_NONE) != 0) scr_trap("scriptc: mprotect failed\n");
#else
  munmap(c, SCR_RGN_CHUNK);
#endif
#elif defined(SCR_RGN_POISON)
  memset(c, 0xdb, SCR_RGN_CHUNK); /* no page protection here: poison, keep */
#elif defined(_WIN32)
  _aligned_free(c);
#else
  free(c);
#endif
}

/* Whether the region's next chunk uses huge pages. */
static bool scr_rgn_huge(const ScrRegion *r) { return r->id == 0 || r->nchunks + 1 >= SCR_RGN_HUGE_AFTER; }

/* A chunk for `r`'s next one, with its page policy. */
static ScrRgnChunk *scr_rgn_chunk_reserve(const ScrRegion *r) {
  ScrRgnChunk *c = scr_rgn_chunk_map();
  c->huge = false;
#if SCR_RGN_MMAP
  c->touched = (char *)c + SCR_RGN_HDR;
#else
  c->touched = (char *)c + SCR_RGN_CHUNK; /* allocated zeroed */
#endif
#if SCR_RGN_MMAP && defined(MADV_HUGEPAGE)
  if (scr_rgn_huge(r)) {
    (void)madvise(c, SCR_RGN_CHUNK, MADV_HUGEPAGE);
    c->huge = true;
  }
#else
  (void)r;
#endif
  return c;
}

/* Faults [from, to) of chunk `c` in ahead of use. */
static void scr_rgn_prefault(ScrRgnChunk *c, char *from, char *to) {
  if (to > c->touched) c->touched = to;
  scr_mem_prefault(from, to);
}

static ScrRgnChunk *scr_rgn_chunk_new(ScrRegion *r) {
  ScrRgnChunk *c = r->spare;
  if (!c && scr_rgn.cache) {
    c = scr_rgn.cache;
    scr_rgn.cache = c->next;
    scr_rgn.cache_bytes -= (size_t)c->found;
  }
  if (!c) c = scr_rgn_chunk_reserve(r);
  r->spare = NULL;
  if (r->bytes >= SCR_RGN_AHEAD_START) scr_rgn_prefault(c, (char *)c, (char *)c + 2 * SCR_RGN_AHEAD);
#ifdef SCR_LSAN_IMMORTAL
  if (__lsan_register_root_region) __lsan_register_root_region(c, SCR_RGN_CHUNK);
#endif
  c->count = 0;
  c->owner = r->id == 0 ? NULL : scr_rgn_self(); /* the default region is never counted */
  c->region = r;
  c->next = r->chunks;
  c->bump = (char *)c + SCR_RGN_HDR;
  c->found = 0;
  r->chunks = c;
  r->nchunks++;
  return c;
}

/* Faulting ahead, like the small-object allocator's slices: first touch of
 * a fresh page costs a fault and a page clear on the allocating thread, so
 * the allocator's helper thread faults memory in just ahead of the bump.
 * Nothing is faulted ahead before a region has carved SCR_RGN_AHEAD_START,
 * so small regions commit nothing extra. Then the bump entering an
 * SCR_RGN_AHEAD step requests the next one, a new chunk starts with its
 * first two steps requested, and a chunk that is half carved maps the
 * region's next chunk and has it faulted in (one huge page, or its first
 * step), so a growing region rarely waits for the kernel. */
static void scr_rgn_ahead(ScrRegion *r, ScrRgnChunk *c, char *from) {
  if (r->bytes < SCR_RGN_AHEAD_START) return;
  size_t before = (size_t)(from - (char *)c), after = (size_t)(c->bump - (char *)c);
  if (after / SCR_RGN_AHEAD != before / SCR_RGN_AHEAD) {
    char *lo = (char *)c + (after / SCR_RGN_AHEAD + 1) * SCR_RGN_AHEAD;
    if (lo < (char *)c + SCR_RGN_CHUNK) scr_rgn_prefault(c, lo, lo + SCR_RGN_AHEAD);
  }
  if (!r->spare && after >= SCR_RGN_CHUNK / 2 && before < SCR_RGN_CHUNK / 2) {
    bool huge = scr_rgn_huge(r);
    r->spare = scr_rgn_chunk_reserve(r);
    scr_rgn_prefault(r->spare, (char *)r->spare, (char *)r->spare + (huge ? SCR_RGN_CHUNK : SCR_RGN_AHEAD));
  }
}

/* Returns a chunk that holds no object to the system. */
static void scr_rgn_chunk_drop(ScrRgnChunk *c) {
#if SCR_RGN_MMAP
  munmap(c, SCR_RGN_CHUNK);
#elif defined(_WIN32)
  _aligned_free(c);
#else
  free(c);
#endif
}

/* A spare chunk never held objects: it goes straight back. */
static void scr_rgn_spare_drop(ScrRegion *r) {
  if (!r->spare) return;
  scr_rgn_chunk_drop(r->spare);
  r->spare = NULL;
}

/* A freed region's chunk: kept for the thread's next regions while the
 * cache has room, cleared (a fresh chunk is zero, and allocation relies on
 * that), else unmapped (SCR_RGN_CACHE_BYTES). Sanitized builds never reuse
 * a chunk (scr_rgn_chunk_unmap). */
static void scr_rgn_chunk_retire(ScrRgnThread *t, ScrRgnChunk *c) {
#ifndef SCR_RGN_POISON
  char *first = (char *)c + SCR_RGN_HDR;
  if (c->bump > c->touched) c->touched = c->bump;
#if SCR_RGN_MMAP
  char *warm = (char *)c + SCR_RGN_CACHE_WARM;
  size_t resident = (size_t)((c->touched < warm ? c->touched : warm) - (char *)c);
#else
  size_t resident = SCR_RGN_CHUNK;
#endif
  if (!c->huge && t->cache_bytes + resident <= SCR_RGN_CACHE_BYTES) {
#if SCR_RGN_MMAP
    if (c->touched > warm) {
      /* Fresh zero pages past the warm part (64 KiB steps cover every
       * page size). */
      size_t tail = ((size_t)(c->touched - warm) + 0xffff) & ~(size_t)0xffff;
      if (tail > SCR_RGN_CHUNK - SCR_RGN_CACHE_WARM) tail = SCR_RGN_CHUNK - SCR_RGN_CACHE_WARM;
      if (mmap(warm, tail, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == MAP_FAILED) {
        scr_rgn_chunk_unmap(c);
        return;
      }
      c->touched = warm;
    }
    memset(first, 0, (size_t)((c->bump < warm ? c->bump : warm) - first));
#else
    memset(first, 0, (size_t)(c->bump - first));
#endif
    c->found = (int64_t)resident;
    c->next = t->cache;
    t->cache = c;
    t->cache_bytes += resident;
    return;
  }
#else
  (void)t;
#endif
  scr_rgn_chunk_unmap(c);
}

/* The instance stride: the emitted fast path rounds the size the same way. */
static inline size_t scr_rgn_stride(const ScrRgnClass *cls) { return (cls->size + 7) & ~(size_t)7; }

static ScrRgnSeg *scr_rgn_seg_new(ScrRegion *r, const ScrRgnClass *cls) {
  size_t stride = scr_rgn_stride(cls);
  size_t need = stride > SCR_RGN_SEG ? stride : SCR_RGN_SEG;
  if (need > SCR_RGN_CHUNK - SCR_RGN_HDR) scr_trap("scriptc: ProgramLifetime instance too large for a region\n");
  ScrRgnChunk *c = r->chunks;
  if (!c || (size_t)((char *)c + SCR_RGN_CHUNK - c->bump) < need) c = scr_rgn_chunk_new(r);
  ScrRgnSeg *s = malloc(sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  s->start = s->end = c->bump;
  s->limit = c->bump + need;
  c->bump += need;
  scr_rgn_ahead(r, c, s->start);
  s->cls = cls;
  s->next = r->segs;
  r->segs = s;
  r->bytes += need;
  scr_rgn.allocated += need;
  return s;
}

/* ── the thread's region table ───────────────────────────────────────── */

static ScrRegion *scr_rgn_region_new(uint64_t id) {
  ScrRegion *r = calloc(1, sizeof *r);
  if (!r) scr_trap("scriptc: out of memory\n");
  r->id = id;
  r->state = SCR_RGN_LIVE;
  return r;
}

static void scr_rgn_thread_exit(void);

static ScrRgnThread *scr_rgn_thread(void) {
  ScrRgnThread *t = &scr_rgn;
  if (!t->dflt) {
    t->dflt = scr_rgn_region_new(0);
    t->current = t->dflt;
    if (!t->exit_registered) {
      t->exit_registered = true;
      scr_atexit(scr_rgn_thread_exit);
    }
  }
  return t;
}

static ScrRegion *scr_rgn_lookup(ScrRgnThread *t, double id) {
  if (!(id >= 1)) return NULL;
  for (size_t i = 0; i < t->nregions; i++)
    if ((double)t->regions[i]->id == id) return t->regions[i];
  return NULL;
}

static void scr_rgn_forget(ScrRgnThread *t, ScrRegion *r) {
  for (size_t i = 0; i < t->nregions; i++)
    if (t->regions[i] == r) {
      t->regions[i] = t->regions[--t->nregions];
      return;
    }
}

/* The current region's cursors write their bump pointers back into its
 * segments; then `r`'s segments load into the cursors. */
static void scr_rgn_switch(ScrRgnThread *t, ScrRegion *r) {
  ScrRegion *cur = t->current;
  if (cur == r) return;
  for (size_t i = 0; i < t->ncursors; i++) {
    ScrRgnCursor *c = t->cursors[i];
    if (!c) continue;
    if (c->bump) cur->cur[i]->end = c->bump;
    ScrRgnSeg *s = i < r->ncur ? r->cur[i] : NULL;
    c->bump = s ? s->end : NULL;
    c->limit = s ? s->limit : NULL;
  }
  t->current = r;
}

static int32_t scr_rgn_slot(ScrRgnClass *cls) {
  int32_t slot = atomic_load_explicit((_Atomic(int32_t) *)&cls->slot, memory_order_acquire);
  if (slot >= 0) return slot;
  int32_t fresh = atomic_fetch_add_explicit(&scr_rgn_next_slot, 1, memory_order_relaxed);
  int32_t expected = -1;
  if (atomic_compare_exchange_strong_explicit((_Atomic(int32_t) *)&cls->slot, &expected, fresh,
                                              memory_order_acq_rel, memory_order_acquire))
    return fresh;
  return expected; /* another thread numbered it first; `fresh` stays unused */
}

void *scr_region_alloc(ScrRgnCursor *cursor, ScrRgnClass *cls) {
  ScrRgnThread *t = scr_rgn_thread();
  size_t slot = (size_t)scr_rgn_slot(cls);
  if (slot >= t->ncursors) {
    size_t n = slot + 16;
    t->cursors = realloc(t->cursors, n * sizeof *t->cursors);
    if (!t->cursors) scr_trap("scriptc: out of memory\n");
    for (size_t i = t->ncursors; i < n; i++) t->cursors[i] = NULL;
    t->ncursors = n;
  }
  t->cursors[slot] = cursor;
  ScrRegion *r = t->current;
  if (slot >= r->ncur) {
    size_t n = slot + 16;
    r->cur = realloc(r->cur, n * sizeof *r->cur);
    if (!r->cur) scr_trap("scriptc: out of memory\n");
    for (size_t i = r->ncur; i < n; i++) r->cur[i] = NULL;
    r->ncur = n;
  }
  ScrRgnSeg *s = r->cur[slot];
  if (s && cursor->bump) s->end = cursor->bump;
  size_t stride = scr_rgn_stride(cls);
  if (!s || (size_t)(s->limit - s->end) < stride) {
    s = scr_rgn_seg_new(r, cls);
    r->cur[slot] = s;
  }
  char *o = s->end;
  s->end += stride;
  cursor->bump = s->end;
  cursor->limit = s->limit;
  return o; /* its first reference is implied (scr_rgn_counted) */
}

/* ── the release walk ────────────────────────────────────────────────── */

static size_t scr_rgn_hash_of(const void *p, size_t cap) {
  return (size_t)(((uintptr_t)p >> 3) * 0x9E3779B97F4A7C15ull) & (cap - 1);
}

static size_t scr_rgn_find(ScrRgnWalk *w, const void *p) {
  size_t j = scr_rgn_hash_of(p, w->cap_hash);
  while (w->hash[j] && w->ents[w->hash[j] - 1].obj != p) j = (j + 1) & (w->cap_hash - 1);
  return j;
}

/* The objects the walk entered, as a set for scr_cyc_collect_set. */
static ScrCycSet scr_rgn_owned_set(ScrRgnWalk *w) {
  size_t cap = 16;
  while (cap < w->nents * 2) cap <<= 1;
  if (cap > w->cap_owned) {
    free(w->owned);
    w->owned = calloc(cap, sizeof *w->owned);
    if (!w->owned) scr_trap("scriptc: out of memory\n");
    w->cap_owned = cap;
  } else
    memset(w->owned, 0, cap * sizeof *w->owned);
  ScrCycSet set = {w->owned, cap - 1};
  for (size_t i = 0; i < w->nents; i++) {
    size_t j = scr_cyc_set_slot(w->ents[i].obj, set.mask);
    while (set.slots[j]) j = (j + 1) & set.mask;
    set.slots[j] = w->ents[i].obj;
  }
  return set;
}

static void scr_rgn_rehash(ScrRgnWalk *w) {
  size_t cap = w->cap_hash ? w->cap_hash * 2 : (size_t)1 << 12;
  free(w->hash);
  w->hash = calloc(cap, sizeof *w->hash);
  if (!w->hash) scr_trap("scriptc: out of memory\n");
  w->cap_hash = cap;
  for (size_t i = 0; i < w->nents; i++) w->hash[scr_rgn_find(w, w->ents[i].obj)] = i + 1;
}

static void scr_rgn_queue(ScrRgnWalk *w, size_t entry, void *p, int kind, void (*walk)(void *, ScrRgnWalk *)) {
  if (w->nwork == w->cap_work) w->work = scr_rgn_grow(w->work, &w->cap_work, sizeof *w->work, 4096);
  w->work[w->nwork++] = (ScrRgnWork){entry, p, kind, walk};
}

/* One more reference to the ordinary object `p`, from the object being
 * walked; queues `p`'s own walk when it is first reached.
 *
 * An object with a single reference, found from one of the region's own
 * objects (or from an object walked like them), has no other referrer, so
 * it can never be referenced from outside: it gets no entry and no edges,
 * and it is walked like the region's own objects, its references into the
 * region counted as explained. RC-audit builds still enter it, and stop if
 * the walk reaches it twice. */
static void scr_rgn_enter(ScrRgnWalk *w, void *p, int kind, void (*walk)(void *, ScrRgnWalk *)) {
  if (!p || *(size_t *)p == SIZE_MAX) return; /* immortal: never freed, not walked */
#ifdef SCR_RGN_DEBUG
  bool single = w->src == 0 && *(size_t *)p == 1 && !w->debug;
#else
  bool single = w->src == 0 && *(size_t *)p == 1;
#endif
#ifndef SCR_RC_AUDIT
  if (single) {
    w->singles++;
    scr_rgn_queue(w, SCR_RGN_SINGLE, p, kind, walk);
    return;
  }
#endif
  if ((w->nents + 1) * 2 > w->cap_hash) scr_rgn_rehash(w);
  size_t j = scr_rgn_find(w, p);
  size_t idx = w->hash[j];
  if (!idx) {
    if (w->nents == w->cap_ents) w->ents = scr_rgn_grow(w->ents, &w->cap_ents, sizeof *w->ents, 4096);
    w->ents[w->nents] = (ScrRgnEntry){p, 0, 0, false};
    idx = w->hash[j] = ++w->nents;
#ifdef SCR_RGN_DEBUG
    if (w->debug) {
      if (w->nents > w->cap_from) w->from = scr_rgn_grow(w->from, &w->cap_from, sizeof *w->from, 4096);
      w->from[idx - 1] = (ScrRgnFrom){w->src ? NULL : w->vcls, w->src ? 0 : w->vfield - 1, kind, w->src};
    }
#endif
    scr_rgn_queue(w, single ? SCR_RGN_SINGLE : idx - 1, p, kind, walk);
  } else if (single) {
    fprintf(stderr, "scriptc: internal error: the region walk reached an object with one reference twice\n");
    abort();
  }
  w->ents[idx - 1].found++;
  if (w->src) {
    if (w->nedges == w->cap_edges) w->edges = scr_rgn_grow(w->edges, &w->cap_edges, sizeof *w->edges, 4096);
    w->edges[w->nedges++] = (ScrRgnEdge){w->src - 1, idx - 1};
  }
}

static void scr_rgn_ref(ScrRgnWalk *w, void *obj) {
  if (!obj) return;
  ScrRgnChunk *c = scr_rgn_chunk_of(obj);
  if (c->region != w->region) return; /* another region's: counted there */
  c->found++;
  if (w->src) w->ents[w->src - 1].rrefs++;
  else w->internal++;
}

static const ScrRgnType *scr_rgn_type_of(void (*release)(void *)) {
  if (atomic_load_explicit(&scr_rgn_index_state, memory_order_acquire) != 2 || !scr_rgn_index_cap) return NULL;
  size_t j = scr_rgn_hash_of((const void *)(uintptr_t)release, scr_rgn_index_cap);
  while (scr_rgn_index[j]) {
    if (scr_rgn_index[j]->release == release) return scr_rgn_index[j];
    j = (j + 1) & (scr_rgn_index_cap - 1);
  }
  return NULL;
}

static void scr_rgn_index_build(void) {
  int state = 0;
  if (!atomic_compare_exchange_strong(&scr_rgn_index_state, &state, 1)) {
    while (atomic_load_explicit(&scr_rgn_index_state, memory_order_acquire) != 2) {
    }
    return;
  }
  const ScrRgnType *types = atomic_load_explicit(&scr_rgn_types, memory_order_acquire);
  size_t n = 0;
  for (const ScrRgnType *ty = types; ty && ty->release; ty++) n++;
  size_t cap = 16;
  while (cap < n * 2) cap *= 2;
  scr_rgn_index = calloc(cap, sizeof *scr_rgn_index);
  if (!scr_rgn_index) scr_trap("scriptc: out of memory\n");
  scr_rgn_index_cap = cap;
  for (const ScrRgnType *ty = types; ty && ty->release; ty++) {
    size_t j = scr_rgn_hash_of((const void *)(uintptr_t)ty->release, cap);
    while (scr_rgn_index[j] && scr_rgn_index[j]->release != ty->release) j = (j + 1) & (cap - 1);
    scr_rgn_index[j] = ty;
  }
  atomic_store_explicit(&scr_rgn_index_state, 2, memory_order_release);
}

/* How the walk treats a value stored with a release entry point: a
 * container kind, an ordinary object with an emitted walker, a reference
 * into a region (SCR_RGN_S_REF), or nothing it can walk (SCR_RGN_S_NONE,
 * its references stay unexplained). Containers resolve it once for all
 * their elements. */
enum { SCR_RGN_S_NONE = -1, SCR_RGN_S_REF = -2 };
typedef struct {
  int kind;
  void (*walk)(void *, ScrRgnWalk *);
} ScrRgnSlotKind;

static ScrRgnSlotKind scr_rgn_slot_kind(void (*release)(void *)) {
  if (!release) return (ScrRgnSlotKind){SCR_RGN_S_NONE, NULL};
  if (release == scr_arr_release_v) return (ScrRgnSlotKind){SCR_RGN_W_ARR, NULL};
  if (release == scr_map_release_v) return (ScrRgnSlotKind){SCR_RGN_W_MAP, NULL};
  if (release == scr_union_release_v) return (ScrRgnSlotKind){SCR_RGN_W_UNION, NULL};
  if (release == scr_closure_release_v) return (ScrRgnSlotKind){SCR_RGN_W_CLOSURE, NULL};
  if (release == scr_dyn_release_v) return (ScrRgnSlotKind){SCR_RGN_W_DYN, NULL};
  const ScrRgnType *ty = scr_rgn_type_of(release);
  if (!ty) return (ScrRgnSlotKind){SCR_RGN_S_NONE, NULL};
  if (!ty->walk) return (ScrRgnSlotKind){SCR_RGN_S_REF, NULL};
  return (ScrRgnSlotKind){SCR_RGN_W_EMITTED, ty->walk};
}

static void scr_rgn_slot_as(ScrRgnWalk *w, void *obj, ScrRgnSlotKind k) {
  if (!obj || k.kind == SCR_RGN_S_NONE) return;
  if (k.kind == SCR_RGN_S_REF) scr_rgn_ref(w, obj);
  else scr_rgn_enter(w, obj, k.kind, k.walk);
}

/* The emitted visits and walkers report each field through these, so
 * SCRIPTC_REGION_DEBUG numbers a region object's fields in the order of its
 * class's `fields` names. */
void scr_region_ref(ScrRgnWalk *w, void *obj) {
#ifdef SCR_RGN_DEBUG
  if (w->vcls) w->vfield++;
#endif
  scr_rgn_ref(w, obj);
}

void scr_region_slot(ScrRgnWalk *w, void *obj, void (*release)(void *)) {
#ifdef SCR_RGN_DEBUG
  if (w->vcls) w->vfield++;
#endif
  if (!obj || !release) return;
  scr_rgn_slot_as(w, obj, scr_rgn_slot_kind(release));
}

static void *scr_rgn_slot_ptr(uint64_t slot) {
  void *p;
  memcpy(&p, &slot, sizeof p);
  return p;
}

static void scr_rgn_walk_arr(ScrRgnWalk *w, ScrArr *a) {
  if (a->elem != SCR_ELEM_REF && a->elem != SCR_ELEM_ARR) return;
  ScrRgnSlotKind k = a->elem == SCR_ELEM_ARR ? (ScrRgnSlotKind){SCR_RGN_W_ARR, NULL}
                                             : scr_rgn_slot_kind(a->ops ? a->ops->release : NULL);
  size_t dense = a->len < a->cap ? a->len : a->cap;
  for (size_t i = 0; i < dense; i++)
    if (!a->present || a->present[i] == SCR_ARR_VALUE) scr_rgn_slot_as(w, scr_rgn_slot_ptr(a->data[i]), k);
  if (!a->ext) return;
  for (size_t i = 0; i < a->ext->sparse_len; i++)
    if (a->ext->sparse[i].state == SCR_ARR_VALUE) scr_rgn_slot_as(w, scr_rgn_slot_ptr(a->ext->sparse[i].slot), k);
  for (size_t i = 0; i < a->ext->prop_len; i++)
    if (a->ext->props[i].state == SCR_ARR_VALUE) scr_rgn_slot_as(w, scr_rgn_slot_ptr(a->ext->props[i].slot), k);
  scr_rgn_enter(w, a->ext->metadata, SCR_RGN_W_DYN, NULL);
}

static void scr_rgn_walk_map(ScrRgnWalk *w, ScrMap *m) {
  bool keyref = m->key_kind == SCR_MAP_KEY_REF || m->key_kind == SCR_MAP_KEY_UNION_REF ||
      m->key_kind == SCR_MAP_KEY_UNION_VALUE;
  bool keydyn = m->key_kind == SCR_MAP_KEY_DYN;
  bool valref = m->val_kind == SCR_MAP_VAL_REF;
  if (!keyref && !keydyn && !valref) return;
  ScrRgnSlotKind kk = keydyn ? (ScrRgnSlotKind){SCR_RGN_W_DYN, NULL}
                    : keyref ? scr_rgn_slot_kind(m->ops->key_release)
                             : (ScrRgnSlotKind){SCR_RGN_S_NONE, NULL};
  ScrRgnSlotKind vk = valref ? scr_rgn_slot_kind(m->ops->val_release) : (ScrRgnSlotKind){SCR_RGN_S_NONE, NULL};
  for (size_t i = 0; i < m->nentries; i++) {
    const ScrMapEntry *e = &m->entries[i];
    if (!e->hash) continue; /* tombstone */
    scr_rgn_slot_as(w, scr_rgn_slot_ptr(e->key), kk);
    scr_rgn_slot_as(w, scr_rgn_slot_ptr(e->val), vk);
  }
}

static void scr_rgn_walk_box(ScrRgnWalk *w, ScrBox *b) {
  void *p = scr_rgn_slot_ptr(b->slot);
  switch (b->kind) {
  case SCR_BOX_OBJ: scr_region_slot(w, p, b->obj_release); break;
  case SCR_BOX_ARR: scr_rgn_enter(w, p, SCR_RGN_W_ARR, NULL); break;
  case SCR_BOX_FUNC: scr_rgn_enter(w, p, SCR_RGN_W_CLOSURE, NULL); break;
  default: break; /* strings and scalars hold no references */
  }
}

static void scr_rgn_walk_closure(ScrRgnWalk *w, ScrClosure *c) {
  for (size_t i = 0; i < c->ncaps; i++) scr_rgn_enter(w, c->caps[i], SCR_RGN_W_BOX, NULL);
  scr_rgn_enter(w, c->props, SCR_RGN_W_BOX, NULL);
}

static void scr_rgn_walk_dyn(ScrRgnWalk *w, ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_ARR:
    for (size_t i = 0; i < d->v.arr.len; i++)
      if (!d->v.arr.presence || d->v.arr.presence[i]) scr_rgn_enter(w, d->v.arr.items[i], SCR_RGN_W_DYN, NULL);
    scr_rgn_enter(w, d->v.arr.properties, SCR_RGN_W_DYN, NULL);
    break;
  case SCR_DYN_OBJ:
    /* source_identity is owned through its access callback: not walked. */
    for (size_t i = 0; i < d->v.obj.len; i++) {
      const ScrDynEntry *e = &d->v.obj.entries[i];
      if (e->accessor) {
        scr_rgn_enter(w, e->getter, SCR_RGN_W_DYN, NULL);
        scr_rgn_enter(w, e->setter, SCR_RGN_W_DYN, NULL);
      } else scr_rgn_enter(w, e->value, SCR_RGN_W_DYN, NULL);
    }
    break;
  case SCR_DYN_FUNC: scr_rgn_enter(w, d->v.fn.clo, SCR_RGN_W_CLOSURE, NULL); break;
  case SCR_DYN_TYPED_REF:
    scr_region_slot(w, d->v.typed_ref.ptr, d->v.typed_ref.release);
    scr_rgn_enter(w, d->v.typed_ref.materialized, SCR_RGN_W_DYN, NULL);
    for (ScrDynTypedCast *cast = d->v.typed_ref.casts; cast; cast = cast->next)
      scr_region_slot(w, cast->ptr, cast->release);
    break;
  case SCR_DYN_PROXY:
    scr_rgn_enter(w, d->v.proxy.target, SCR_RGN_W_DYN, NULL);
    scr_rgn_enter(w, d->v.proxy.handler, SCR_RGN_W_DYN, NULL);
    break;
  default: break; /* scalars, strings, bytes; handles and promises are not walked */
  }
  scr_rgn_enter(w, d->prototype, SCR_RGN_W_DYN, NULL);
  scr_rgn_enter(w, d->symbol_properties, SCR_RGN_W_DYN, NULL);
  scr_rgn_enter(w, d->symbol_keys, SCR_RGN_W_DYN, NULL);
}

static void scr_rgn_drain(ScrRgnWalk *w) {
  while (w->nwork) {
    ScrRgnWork job = w->work[--w->nwork];
    void *p = job.obj;
    w->src = job.entry == SCR_RGN_SINGLE ? 0 : job.entry + 1;
    switch (job.kind) {
    case SCR_RGN_W_EMITTED: job.walk(p, w); break;
    case SCR_RGN_W_ARR: scr_rgn_walk_arr(w, p); break;
    case SCR_RGN_W_MAP: scr_rgn_walk_map(w, p); break;
    case SCR_RGN_W_UNION: {
      ScrUnion *u = p;
      if (u->arm_release) scr_region_slot(w, scr_rgn_slot_ptr(u->slot), u->arm_release);
      break;
    }
    case SCR_RGN_W_CLOSURE: scr_rgn_walk_closure(w, p); break;
    case SCR_RGN_W_BOX: scr_rgn_walk_box(w, p); break;
    case SCR_RGN_W_DYN: scr_rgn_walk_dyn(w, p); break;
    }
  }
  w->src = 0;
}

/* Trial deletion over the entries: marks the ones referenced from outside
 * and everything they reach, and returns the references into the region
 * held by the rest. */
static int64_t scr_rgn_settle(ScrRgnWalk *w, size_t *black_out) {
  size_t n = w->nents;
  size_t *start = calloc(n + 1, sizeof *start);
  size_t *child = malloc((w->nedges + 1) * sizeof *child);
  size_t *stack = malloc((n + 1) * sizeof *stack);
  if (!start || !child || !stack) scr_trap("scriptc: out of memory\n");
  for (size_t e = 0; e < w->nedges; e++) start[w->edges[e].parent + 1]++;
  for (size_t i = 0; i < n; i++) start[i + 1] += start[i];
  for (size_t e = 0; e < w->nedges; e++) child[start[w->edges[e].parent]++] = w->edges[e].child;
  for (size_t i = n; i > 0; i--) start[i] = start[i - 1]; /* the fill moved each start to its end */
  start[0] = 0;
  size_t top = 0;
  for (size_t i = 0; i < n; i++) {
    ScrRgnEntry *x = &w->ents[i];
    if (*(size_t *)x->obj != (size_t)x->found) {
      x->black = true;
      stack[top++] = i;
    }
  }
  while (top) {
    size_t i = stack[--top];
    for (size_t k = start[i]; k < start[i + 1]; k++) {
      ScrRgnEntry *c = &w->ents[child[k]];
      if (c->black) continue;
      c->black = true;
      stack[top++] = child[k];
    }
  }
  int64_t sum = 0;
  size_t black = 0;
  for (size_t i = 0; i < n; i++) {
    if (w->ents[i].black) black++;
    else sum += w->ents[i].rrefs;
  }
  free(start);
  free(child);
  free(stack);
  *black_out = black;
  return sum;
}

/* The references counted to the region's objects: the chunk counts, plus
 * the first reference every object starts with (allocation counts nothing,
 * so a chunk count can be negative). */
static int64_t scr_rgn_counted(const ScrRegion *r) {
  int64_t n = 0;
  for (const ScrRgnChunk *c = r->chunks; c; c = c->next) n += c->count;
  for (const ScrRgnSeg *s = r->segs; s; s = s->next) n += (int64_t)((size_t)(s->end - s->start) / scr_rgn_stride(s->cls));
  return n;
}

static double scr_rgn_ms(uint64_t from, uint64_t to) { return (double)(to - from) / 1e6; }

/* The region's segments hold instances up to their `end`; a region that
 * is not current has every cursor written back (scr_rgn_switch). */
#define SCR_RGN_EACH(r, s, o) \
  for (ScrRgnSeg *s = (r)->segs; s; s = s->next) \
    for (char *o = s->start; o < s->end; o += scr_rgn_stride(s->cls))

static void scr_rgn_free_region(ScrRgnThread *t, ScrRegion *r) {
  scr_rgn_spare_drop(r);
  for (ScrRgnChunk *c = r->chunks, *next; c; c = next) {
    next = c->next;
    scr_rgn_chunk_retire(t, c);
  }
  for (ScrRgnSeg *s = r->segs, *next; s; s = next) {
    next = s->next;
    free(s);
  }
  free(r->cur);
  scr_rgn_forget(t, r);
  free(r);
}

#ifdef SCR_RGN_DEBUG
static const char *scr_rgn_kind_name(int kind) {
  switch (kind) {
  case SCR_RGN_W_ARR: return "an array";
  case SCR_RGN_W_MAP: return "a map or set";
  case SCR_RGN_W_UNION: return "a union value";
  case SCR_RGN_W_CLOSURE: return "a closure";
  case SCR_RGN_W_BOX: return "a captured variable";
  case SCR_RGN_W_DYN: return "a dynamic value";
  default: return "an object";
  }
}

/* The name of field `i` in a class's visit order. */
static const char *scr_rgn_field_name(const ScrRgnClass *cls, uint32_t i) {
  if (!cls->fields) return "?";
  for (uint32_t k = 0; k < i; k++)
    if (!cls->fields[k]) return "?";
  return cls->fields[i] ? cls->fields[i] : "?";
}

/* SCRIPTC_REGION_DEBUG: why an attempt kept `r`, in at most `lines` lines.
 * References into a chunk that the walk did not find come from outside it
 * (variables, other regions, objects it does not walk); the walk knows
 * only the chunk, so the line names the classes the chunk holds. Owned
 * objects referenced from outside are named by how the walk reached them,
 * from a field of one of the region's objects. */
static void scr_rgn_report(const ScrRegion *r, const ScrRgnWalk *w, int64_t unexplained, size_t lines) {
  fprintf(stderr, "scriptc region %llu: %lld references from outside keep it:\n", (unsigned long long)r->id,
          (long long)unexplained);
  size_t printed = 0, more = 0;
  for (const ScrRgnChunk *c = r->chunks; c; c = c->next) {
    int64_t objects = 0;
    const char *names[4];
    size_t nnames = 0;
    bool others = false;
    for (const ScrRgnSeg *s = r->segs; s; s = s->next) {
      if (scr_rgn_chunk_of(s->start) != c) continue;
      objects += (int64_t)((size_t)(s->end - s->start) / scr_rgn_stride(s->cls));
      if (s->end == s->start) continue;
      bool seen = false;
      for (size_t k = 0; k < nnames; k++) seen |= names[k] == s->cls->name;
      if (seen) continue;
      if (nnames < 4) names[nnames++] = s->cls->name;
      else others = true;
    }
    int64_t missing = c->count + objects - c->found;
    if (missing <= 0) continue;
    if (printed == lines) {
      more++;
      continue;
    }
    printed++;
    fprintf(stderr, "  %lld not found by the walk, to objects in a chunk holding", (long long)missing);
    for (size_t k = 0; k < nnames; k++) fprintf(stderr, "%s %s", k ? "," : "", names[k]);
    fprintf(stderr, "%s\n", others ? ", and other classes" : "");
  }
  for (size_t i = 0; i < w->nents; i++) {
    const ScrRgnEntry *x = &w->ents[i];
    if (*(size_t *)x->obj == (size_t)x->found) continue; /* not referenced from outside itself */
    if (printed == lines) {
      more++;
      continue;
    }
    printed++;
    fprintf(stderr, "  %s", scr_rgn_kind_name(w->from[i].kind));
    size_t at = i;
    while (w->from[at].parent) {
      at = w->from[at].parent - 1;
      fprintf(stderr, " in %s", scr_rgn_kind_name(w->from[at].kind));
    }
    const ScrRgnFrom *f = &w->from[at];
    fprintf(stderr, " held by %s.%s, with %zu references, %lld of them from what the region owns\n",
            f->cls ? f->cls->name : "?", f->cls ? scr_rgn_field_name(f->cls, f->field) : "?", *(size_t *)x->obj,
            (long long)x->found);
  }
  if (more) fprintf(stderr, "  %zu more\n", more);
}
#endif

/* One release attempt; true when `r` was freed. */
/* `tentative`: an attempt before the retry's cycle pass. A region it cannot
 * free is left as it was, for the attempt after the pass to judge. */
/* A region an attempt could not free: when it is attempted again. */
static void scr_rgn_keep(ScrRgnThread *t, ScrRegion *r, int64_t counted, int64_t explained, size_t black, size_t owned,
                         double cycles, double walk_ms) {
  if (r->kept && counted == r->kept_counted) {
    if (r->backoff < SCR_RGN_MAX_BACKOFF) r->backoff++;
  } else r->backoff = 0;
  r->kept = true;
  r->kept_counted = counted;
  r->retry_at = t->allocated + ((r->bytes > SCR_RGN_RETRY_BYTES ? r->bytes : SCR_RGN_RETRY_BYTES) << r->backoff);
  if (scr_rgn_stats())
    fprintf(stderr,
            "scriptc region %llu: kept: %lld references counted, %lld explained; %zu of %zu owned objects referenced from outside; cycles %.1f ms, walk %.1f ms\n",
            (unsigned long long)r->id, (long long)counted, (long long)explained, black, owned, cycles, walk_ms);
}

static bool scr_rgn_try_free(ScrRgnThread *t, ScrRegion *r, bool tentative) {
  bool stats = scr_rgn_stats();
  uint64_t t0 = stats ? scr_hrtime_ns() : 0;
  double cycles = t->cycle_ms;
  t->cycle_ms = 0;
  t->stats.attempts++;
  bool held = r->held;
  r->held = false;
  /* Kept on the first check, and the heap pass dropped no reference into
   * it: the walk would find what that check found. A pass that freed a dead
   * cycle referring only to an owned object leaves the count as it was;
   * such a region waits for its next attempt. SCRIPTC_REGION_DEBUG walks
   * again for its report. */
  if (held && !tentative && scr_rgn_counted(r) == r->held_counted && !scr_rgn_debug()) {
    scr_rgn_keep(t, r, r->held_counted, r->held_explained, r->held_black, r->held_owned, cycles, r->held_walk_ms);
    return false;
  }
  ScrRgnWalk *w = &t->walk;
  w->region = r;
  w->internal = 0;
  w->src = 0;
  w->nents = w->nedges = w->nwork = w->singles = 0;
#ifdef SCR_RGN_DEBUG
  size_t debug = scr_rgn_debug();
  w->debug = debug != 0;
  w->vcls = NULL;
#endif
  if (w->hash) memset(w->hash, 0, w->cap_hash * sizeof *w->hash);
  for (ScrRgnChunk *c = r->chunks; c; c = c->next) c->found = 0;
  size_t objects = 0;
  SCR_RGN_EACH(r, s, o) {
    if (*(size_t *)o == SIZE_MAX) {
      /* Published: other threads may hold it, uncounted. */
      r->state = SCR_RGN_PINNED;
      t->stats.pinned++;
      if (stats) fprintf(stderr, "scriptc region %llu: pinned: it holds a published object\n", (unsigned long long)r->id);
      return false;
    }
#ifdef SCR_RGN_DEBUG
    if (debug) {
      w->vcls = s->cls;
      w->vfield = 0;
    }
#endif
    s->cls->visit(o, w);
    objects++;
  }
#ifdef SCR_RGN_DEBUG
  w->vcls = NULL;
#endif
  scr_rgn_drain(w);
  int64_t counted = scr_rgn_counted(r);
  size_t black = 0;
  int64_t explained = w->internal + scr_rgn_settle(w, &black);
  uint64_t t1 = stats ? scr_hrtime_ns() : 0;
  if (explained != counted) {
    if (tentative) {
      r->held = true;
      r->held_counted = counted;
      r->held_explained = explained;
      r->held_black = black;
      r->held_owned = w->nents + w->singles;
      r->held_walk_ms = stats ? scr_rgn_ms(t0, t1) : 0;
      return false;
    }
    scr_rgn_keep(t, r, counted, explained, black, w->nents + w->singles, cycles, stats ? scr_rgn_ms(t0, t1) : 0);
#ifdef SCR_RGN_DEBUG
    if (debug) scr_rgn_report(r, w, counted - explained, debug);
#else
    static _Atomic(bool) told = false;
    if (scr_rgn_debug() && !atomic_exchange_explicit(&told, true, memory_order_relaxed))
      fprintf(stderr, "scriptc: SCRIPTC_REGION_DEBUG reports need a build with --optimization=dev\n");
#endif
    return false;
  }
  /* Free: drop weak entries keyed by the instances, then release every
   * reference field. The owned objects tear down through their own
   * releases; the cycle collector frees the owned cycles. */
  if (scr_weak_dispose_hook) SCR_RGN_EACH(r, s, o) scr_weak_dispose(o);
  SCR_RGN_EACH(r, s, o) s->cls->release_fields(o);
  int64_t left = scr_rgn_counted(r);
  /* What can still count references is cycles of the owned objects: each
   * has a member that lost a reference here, which leaves it buffered as a
   * candidate (the walk entered every cycle member). Passes over those
   * candidates come first, from the youngest buffer out (objects made during
   * the region's runs are usually young, while a large heap keeps most of
   * its candidates in the older buffers), and the whole heap only if counts
   * remain. The set may hold the addresses of owned objects already freed;
   * it is only compared with buffered candidates. */
  if (left != 0) {
    ScrCycSet owned = scr_rgn_owned_set(w);
    for (unsigned gen = SCR_CYC_NURSERY; left != 0 && gen <= SCR_CYC_OLD;) {
      /* A pass that frees nothing at this depth widens to the next
       * generation's buffer; one that frees something may have left new
       * candidates through its teardowns, so it goes again. */
      if (scr_cyc_collect_set(&owned, gen) == 0) gen++;
      left = scr_rgn_counted(r);
    }
  }
  if (left != 0) {
    t->stats.heap_passes++;
    scr_collect_cycles();
    left = scr_rgn_counted(r);
  }
  if (left != 0) {
    /* The walk explained references that do not exist: the instances are
     * already released, so keep their memory forever. */
    r->state = SCR_RGN_LEAKED;
    t->stats.leaked++;
    fprintf(stderr, "scriptc region %llu: %lld references left after release; memory kept\n",
            (unsigned long long)r->id, (long long)left);
#ifdef SCR_RC_AUDIT
    abort();
#endif
    return false;
  }
#ifdef SCR_RC_AUDIT
  scr_obj_lifetime_forget((long)objects);
#endif
  size_t bytes = r->nchunks * SCR_RGN_CHUNK, nchunks = r->nchunks;
  uint64_t id = r->id;
  scr_rgn_free_region(t, r);
  t->stats.freed++;
  if (stats)
    fprintf(stderr,
            "scriptc region %llu: freed %zu objects, %zu owned objects, %zu chunks (%.1f MiB); cycles %.1f ms, walk %.1f ms, free %.1f ms\n",
            (unsigned long long)id, objects, w->nents + w->singles, nchunks, (double)bytes / 1048576.0, cycles, scr_rgn_ms(t0, t1),
            scr_rgn_ms(t1, scr_hrtime_ns()));
  return true;
}

/* A condemned region not in use, never attempted, or kept by an attempt
 * whose outcome may have changed since (see SCR_RGN_RETRY_BYTES). */
static bool scr_rgn_due(const ScrRegion *r, const ScrRgnThread *t) {
  if (r->state != SCR_RGN_CONDEMNED || r->depth != 0 || r->fibers != 0 || r == t->current) return false;
  return !r->kept || t->allocated >= r->retry_at || scr_rgn_counted(r) != r->kept_counted;
}

/* Attempts every condemned region that is due; true if one was kept. */
static bool scr_rgn_try_due(ScrRgnThread *t, bool tentative) {
  bool kept = false;
  for (size_t i = 0; i < t->nregions;) {
    ScrRegion *r = t->regions[i];
    if (scr_rgn_due(r, t)) {
      if (scr_rgn_try_free(t, r, tentative)) {
        /* The table shrank, and the freed region's references may have
         * kept another one: the regions it held now count fewer
         * references. */
        i = 0;
        kept = false;
        continue;
      }
      kept = true;
    }
    i++;
  }
  return kept;
}

/* Tries every condemned region that is due. A region whose references all
 * come from its own objects and what they own frees without a cycle pass;
 * one that is kept may be kept by dead cycles of ordinary objects, which
 * hold counted references into it until the collector frees them, so only
 * then does the thread's heap get a full pass before the region is judged. */
static void scr_rgn_retry(ScrRgnThread *t) {
  bool any = false;
  for (size_t i = 0; i < t->nregions && !any; i++) any = scr_rgn_due(t->regions[i], t);
  t->checked = t->allocated;
  if (!any) return;
  if (atomic_load_explicit(&scr_rgn_index_state, memory_order_acquire) != 2) scr_rgn_index_build();
  if (!scr_rgn_try_due(t, true)) return;
  uint64_t t0 = scr_rgn_stats() ? scr_hrtime_ns() : 0;
  t->stats.heap_passes++;
  scr_collect_cycles();
  if (t0) t->cycle_ms = scr_rgn_ms(t0, scr_hrtime_ns());
  scr_rgn_try_due(t, false);
}

/* ── async continuations ─────────────────────────────────────────────── */

/* A fiber spawned while a region is current carries it: the region
 * cannot be freed until the fiber is gone, so work that resumes after an
 * await can keep allocating in it, condemned or not (scr_rgn_due). The
 * fiber's own references to the region's objects are counted like any
 * others. Fibers of the default region carry nothing. */
static void *scr_rgn_fiber_capture(void) {
  ScrRgnThread *t = &scr_rgn;
  ScrRegion *r = t->current;
  if (t->exited || !r || r->id == 0) return NULL;
  r->fibers++;
  return r;
}

static void scr_rgn_fiber_drop(void *region) {
  if (region && !scr_rgn.exited) ((ScrRegion *)region)->fibers--;
}

/* The event loop resumes a fiber: its region becomes current until the
 * fiber suspends or finishes. Run frames never span a suspension, so the
 * fiber leaves the region current that it found. */
static void *scr_rgn_fiber_resume(void *region) {
  ScrRgnThread *t = &scr_rgn;
  if (t->exited || !t->dflt) return NULL; /* no region on this thread yet */
  ScrRegion *previous = t->current;
  scr_rgn_switch(t, region ? (ScrRegion *)region : t->dflt);
  return previous;
}

static void scr_rgn_fiber_suspend(void *previous) {
  if (previous && !scr_rgn.exited) scr_rgn_switch(&scr_rgn, previous);
}

static const ScrRgnFiberHooks scr_rgn_fiber_hooks = {
    scr_rgn_fiber_capture,
    scr_rgn_fiber_drop,
    scr_rgn_fiber_resume,
    scr_rgn_fiber_suspend,
};

/* ── program-facing entry points ─────────────────────────────────────── */

double scr_region_create(const ScrRgnType *types) {
  const ScrRgnType *expected = NULL;
  atomic_compare_exchange_strong(&scr_rgn_types, &expected, types);
  atomic_store_explicit(&scr_region_fiber_hooks, &scr_rgn_fiber_hooks, memory_order_relaxed);
  /* Counting starts before the region's first object exists. */
  atomic_store_explicit(&scr_region_counting, 1, memory_order_relaxed);
  ScrRgnThread *t = scr_rgn_thread();
  scr_rgn_retry(t);
  uint64_t id = atomic_fetch_add_explicit(&scr_rgn_next_id, 1, memory_order_relaxed);
  if (t->nregions == t->cap_regions) t->regions = scr_rgn_grow(t->regions, &t->cap_regions, sizeof *t->regions, 16);
  t->regions[t->nregions++] = scr_rgn_region_new(id);
  t->stats.created++;
  return (double)id;
}

void scr_region_enter(double id) {
  ScrRgnThread *t = scr_rgn_thread();
  ScrRegion *r = scr_rgn_lookup(t, id);
  if (!r || r->state != SCR_RGN_LIVE) r = t->dflt; /* released regions take no new objects */
  if (t->nregions && t->allocated - t->checked >= SCR_RGN_RETRY_BYTES) scr_rgn_retry(t);
  if (t->depth == t->cap_stack) t->stack = scr_rgn_grow(t->stack, &t->cap_stack, sizeof *t->stack, 16);
  t->stack[t->depth++] = (ScrRgnFrame){t->current, r};
  r->depth++;
  scr_rgn_switch(t, r);
}

void scr_region_leave(void) {
  ScrRgnThread *t = &scr_rgn;
  if (t->depth == 0) scr_trap("scriptc: internal error: unbalanced region leave\n");
  ScrRgnFrame f = t->stack[--t->depth];
  f.entered->depth--;
  scr_rgn_switch(t, f.prev);
}

void scr_region_release(double id) {
  ScrRgnThread *t = scr_rgn_thread();
  ScrRegion *r = scr_rgn_lookup(t, id);
  if (!r || r->state != SCR_RGN_LIVE) return;
  r->state = SCR_RGN_CONDEMNED;
  t->stats.released++;
  scr_rgn_retry(t);
}

/* Thread (or process) exit: the regions can no longer be released, but
 * their instances may be published, so the chunks stay; the bookkeeping
 * goes. */
static void scr_rgn_thread_exit(void) {
  ScrRgnThread *t = &scr_rgn;
  if (scr_rgn_stats()) {
    size_t condemned = 0;
    for (size_t i = 0; i < t->nregions; i++) condemned += t->regions[i]->state == SCR_RGN_CONDEMNED;
    fprintf(stderr, "scriptc regions: %zu created, %zu released, %zu freed, %zu pinned, %zu kept\n",
            t->stats.created, t->stats.released, t->stats.freed, t->stats.pinned, condemned);
    fprintf(stderr, "scriptc region heap passes: %zu\n", t->stats.heap_passes);
  }
  ScrRegion *all[1] = {t->dflt};
  for (size_t i = 0; i <= t->nregions; i++) {
    ScrRegion *r = i < t->nregions ? t->regions[i] : all[0];
    if (!r) continue;
    scr_rgn_spare_drop(r);
    for (ScrRgnSeg *s = r->segs, *next; s; s = next) {
      next = s->next;
      free(s);
    }
    free(r->cur);
    free(r);
  }
  for (ScrRgnChunk *c = t->cache, *next; c; c = next) {
    next = c->next;
    scr_rgn_chunk_drop(c);
  }
  free(t->regions);
  free(t->cursors);
  free(t->stack);
  free(t->walk.ents);
  free(t->walk.hash);
  free(t->walk.owned);
  free(t->walk.edges);
  free(t->walk.work);
#ifdef SCR_RGN_DEBUG
  free(t->walk.from);
#endif
  memset(t, 0, sizeof *t);
  t->exit_registered = true; /* the cleanup ran; a late allocation keeps its memory */
  t->exited = true;          /* fibers destroyed later must not touch the freed regions */
}
