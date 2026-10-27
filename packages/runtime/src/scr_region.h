/* scriptc runtime — counted lifetime regions (scr_region.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_REGION_H
#define SCR_REGION_H

#include "scr_core.h"

/* ── counted lifetime regions (scr_region.c) ───────────────────────────
 * Programs that construct a LifetimeRegion (@scriptc/experimental) allocate
 * every ProgramLifetime instance in the thread's CURRENT region instead of
 * the small-object allocator. A region owns SCR_RGN_CHUNK-aligned chunks;
 * each class packs its instances into segments of a chunk, so a region's
 * objects are enumerable without a header. Instead of a per-object count,
 * the class's retain and release adjust the chunk's first word (`count`);
 * with the first reference each object starts with, it gives the number of
 * references to the chunk's objects.
 *
 * release() condemns a region. A condemned region is freed only when a walk
 * of its objects, and of the ordinary objects they own, explains every
 * counted reference: trial deletion restricted to the region. References
 * the walk cannot see (locals, globals, objects outside the walked graph,
 * shapes it does not know) stay unexplained and keep the region. Freeing
 * releases every reference field of every object, which tears the owned
 * ordinary objects down through their normal paths, runs the cycle
 * collector for the owned cycles, and then requires every count to be 0.
 * Region 0 of each thread (the default) is never freed: programs that do
 * not use regions keep ProgramLifetime's behavior.
 *
 * Only references to objects of regions that can be freed are counted:
 * until the process creates its first region, scr_region_counting is 0 and
 * retains and releases touch nothing, and chunks of the default regions
 * have no owner, so references to their objects are never counted. Every
 * reference to an object of a non-default region is created after that
 * region exists, so its counts are exact.
 *
 * The layouts below are an ABI with the emitted code (llvm/regions.ts):
 * the inline allocation fast path bumps the class's ScrRgnCursor, and the
 * retain/release bodies test scr_region_counting, then the chunk's owner,
 * then adjust its count. */
#define SCR_RGN_CHUNK_SHIFT 21
#define SCR_RGN_CHUNK ((size_t)1 << SCR_RGN_CHUNK_SHIFT)

typedef struct ScrRgnWalk ScrRgnWalk;

/* One per ProgramLifetime class, emitted as a mutable global: `slot` is
 * assigned process-wide on the first allocation (-1 until then). */
typedef struct ScrRgnClass {
  size_t size;                               /* instance size (the stride rounds it to 8) */
  void (*visit)(void *obj, ScrRgnWalk *w);   /* reports each reference field */
  void (*release_fields)(void *obj);         /* releases each reference field */
  const char *name;
  int32_t slot;
  /* The names of the fields `visit` reports, in its order, NULL-terminated
   * (SCRIPTC_REGION_DEBUG). */
  const char *const *fields;
} ScrRgnClass;

/* The calling thread's allocation cursor for one class in its current
 * region: emitted per class (thread-local in worker executables). NULL
 * fields send the next allocation to scr_region_alloc. */
typedef struct ScrRgnCursor {
  char *bump, *limit;
} ScrRgnCursor;

/* The emitted type table (terminated by a NULL release): the release entry
 * point a container stores for a type (shapes.ts vAdapters), and the walker
 * of its objects. A NULL walker marks a ProgramLifetime class. */
typedef struct ScrRgnType {
  void (*release)(void *);
  void (*walk)(void *obj, ScrRgnWalk *w);
} ScrRgnType;

typedef struct ScrRgnChunk {
  int64_t count; /* word 0: references to this chunk's objects, less one per object */
  void *owner;   /* word 1: the owning thread; NULL in default regions */
  struct ScrRegion *region;
  struct ScrRgnChunk *next;
  char *bump;    /* the next free segment byte */
  int64_t found; /* references the last walk saw into this chunk */
  /* What stays resident across reuse (scr_region.c's chunk cache): the
   * highest byte any region carved or faulted in, and whether the chunk
   * may be backed by huge pages. */
  char *touched;
  bool huge;
} ScrRgnChunk;
_Static_assert(offsetof(ScrRgnChunk, count) == 0 && offsetof(ScrRgnChunk, owner) == sizeof(int64_t),
               "llvm/regions.ts addresses the chunk count at 0 and the owner at 8");

static inline ScrRgnChunk *scr_rgn_chunk_of(const void *obj) {
  return (ScrRgnChunk *)((uintptr_t)obj & ~(uintptr_t)(SCR_RGN_CHUNK - 1));
}

/* 1 once any thread has created a region (never reset); emitted retains
 * and releases count nothing while it is 0. */
extern _Atomic uint8_t scr_region_counting;

/* The allocation slow path: a zeroed instance of `cls` in the current
 * region. Refills `cursor`. */
void *scr_region_alloc(ScrRgnCursor *cursor, ScrRgnClass *cls);
/* new LifetimeRegion(): a fresh region id (ids are never reused). `types`
 * is the program's constant type table. Retries condemned regions. */
double scr_region_create(const ScrRgnType *types);
/* run(fn): makes region `id` current until the matching leave. An id this
 * thread does not own (another thread's, or a freed region's) selects the
 * thread's default region. Calls nest. */
void scr_region_enter(double id);
void scr_region_leave(void);
/* release(): condemns region `id` and tries to free it. */
void scr_region_release(double id);

/* Walk callbacks for emitted visits and walkers. scr_region_ref reports a
 * reference to a ProgramLifetime instance; scr_region_slot reports a
 * reference of the type whose container release entry point is `release`
 * (unknown entry points are not walked, which keeps their references
 * unexplained). Both tolerate NULL. */
void scr_region_ref(ScrRgnWalk *w, void *obj);
void scr_region_slot(ScrRgnWalk *w, void *obj, void (*release)(void *));

/* Async continuations. A fiber that runs an async function body, on its
 * own stack or as a stackless coroutine, carries the region that was
 * current when it was spawned (`capture`; NULL is the default region), and
 * the event loop makes that region current while the fiber runs after an
 * await (`resume` answers the region to restore with
 * `suspend`). A region is never freed while a fiber that carries it
 * exists; `drop` ends the fiber's hold. scr_region_create installs the
 * hooks (process-wide, once); until then the fiber machinery (scr_async.c)
 * calls nothing. Every hook acts on the calling thread's regions. */
typedef struct ScrRgnFiberHooks {
  void *(*capture)(void);
  void (*drop)(void *region);
  void *(*resume)(void *region);
  void (*suspend)(void *previous);
} ScrRgnFiberHooks;
extern _Atomic(const ScrRgnFiberHooks *) scr_region_fiber_hooks;

#endif /* SCR_REGION_H */
