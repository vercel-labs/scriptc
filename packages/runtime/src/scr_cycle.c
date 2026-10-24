/* Reference-cycle collector: generational Bacon–Rajan trial deletion (see
 * "Concurrent Cycle Collection in Reference Counted Systems", the
 * synchronous algorithm) over cycle-headered objects only — the object
 * model and the trace/teardown contract live in scr_runtime.h.
 *
 * Life of a candidate: a release that leaves rc > 0 buffers the object.
 * Collection walks the buffer in three phases over the graph
 * reachable from it:
 *   markGray     trial-delete: decrement rc once per internal edge;
 *   scan         nodes still rc > 0 are externally referenced — re-blacken
 *                their subgraph and restore the trial decrements;
 *   gather       filter the scanned white set, then free it, releasing
 *                only edges that LEAVE the white set (each member's
 *                teardown releases its untraced children; traced edges were
 *                already accounted by markGray).
 * The white set is gathered first and freed after the walk — freeing
 * during the walk would leave dangling sibling edges for later visits.
 *
 * Correctness leans on two global invariants (docs/memory.md):
 * - every strong reference is counted: stacks, locals, and runtime-owned
 *   buffers (timer callbacks, unhandled-rejection tracking) all hold +1,
 *   so trial deletion can never free something a root still reaches;
 * - mutators unlink before they release: a heap object's stored pointer is
 *   overwritten BEFORE the old value's release runs, so a threshold
 *   collection triggered inside that release never sees an edge whose
 *   count was already given up (which would over-decrement and free live
 *   data).
 *
 * The graph phases keep a bounded depth-first walk and defer deeper traces
 * to reusable worklists. Ordinary RC destruction and cross-generation
 * releases are separate paths. markGray records the objects it grays (up
 * to SCR_CYC_GRAY_LIST_MAX) and counts those still externally referenced
 * (rc > 0 after the trial decrements), per pass and per component: the
 * objects first reached from one candidate. A component with none is
 * garbage, which is what scan would find, so the pass dooms it at once.
 * For the others, scan blackens from each recorded object that is still
 * externally referenced, which restores exactly the survivors, and what
 * stays gray is the garbage: no walk whitens it. Only a pass too large to
 * record walks scan from the candidates, whitening as it goes, and then
 * filters the white set after outside roots settle, avoiding a separate
 * gather walk.
 *
 * ── generations ──────────────────────────────────────────────────────
 * A pass costs O(objects reachable from its candidates), and a candidate
 * deep in a live structure reaches all of it — so collecting on a fixed
 * candidate count makes total work QUADRATIC in a growing live heap. A
 * splay tree is the worst case: re-linking a node buffers it, the walk
 * from it drags in every node below, and none of it is ever garbage.
 *
 * So the collector is generational, in the shape CPython uses for this
 * same algorithm: nursery, mature and old. Each header carries a `gen`; a
 * pass names the oldest generation it will walk and SKIPS every object above
 * it, exactly as it skips NULL and immortals. Objects that survive a pass are
 * promoted one generation, so the next pass at a lower level never walks
 * them again: the cost of a nursery pass is proportional to what has been
 * allocated since the last one, and the cost of a mature pass to what has
 * survived a nursery pass since the last mature one — not to the live heap.
 * The third generation is what keeps a long-lived structure out of the walk
 * that reclaims medium-lived garbage: objects that die after surviving one
 * pass (scratch structures built for a phase of work, say) are reclaimed by
 * mature passes that never touch the data that has been live for a while.
 *
 * Restricting the walk stays sound because trial deletion is already
 * conservative in the right direction. An edge from a skipped (older)
 * object into the walked set is never trial-deleted, so its target keeps
 * that count, reads as externally referenced, and survives — the same
 * answer the collector gives for a reference held by the stack. Edges the
 * other way are simply not followed; the older object was not a candidate
 * for freeing in this pass. What this gives up is cycles that SPAN
 * generations: those are invisible to a restricted pass and are found by
 * the full pass, which walks every generation and so is exactly the
 * single-generation algorithm.
 *
 * Scheduling. One counter drives the release path: candidates buffered
 * since the last pass. When it trips, the pass runs at the highest level
 * whose condition holds:
 *   full, growth   the live cycle-headered heap is a fraction past its size
 *                  after the last full pass. The fraction starts at 1/4 and
 *                  is scheduled by YIELD: it widens by doublings (up to the
 *                  growth cap, 16 unless SCR_CYCLE_GROWTH_CAP lowers it)
 *                  as growth-triggered full passes reclaim fewer OLD objects
 *                  relative to the growth that triggered them, and narrows
 *                  back as soon as a pass finds old garbage again (see
 *                  scr_cyc_adapt_growth). Garbage younger than the old
 *                  generation does not count: the mature level reclaims it
 *                  without walking the old heap. This is what stops a large
 *                  retained structure from being re-walked at every quarter
 *                  of growth while it is building or while the garbage is
 *                  all young.
 *   full, backlog  the old candidate buffer has reached a fraction of the
 *                  live heap. This one is not redundant: live data that is
 *                  unlinked INTO a dead cycle grows no counter at all (it
 *                  was tallied when it was allocated) and is invisible to a
 *                  restricted pass, so without it a program that churns its
 *                  long-lived structures would never collect anything. But
 *                  an old object is also buffered whenever a temporary
 *                  reference to it is dropped, so merely READING a live
 *                  structure (walking a tree, say) refills the buffer with
 *                  objects that are not garbage. A pass that frees almost
 *                  nothing therefore doubles this fraction, and a productive
 *                  one restores it.
 *   full, death    live objects have died outside passes since the last
 *                  full pass (the live count fell between passes, by at
 *                  least 1/32 of the heap that pass left) and have stopped
 *                  dying, and the heap has grown the base fraction since.
 *                  Growth alone cannot tell a heap that keeps live data
 *                  from one that keeps garbage, and once full passes stop
 *                  finding anything the fraction widens to the cap. A
 *                  program that drops a large structure and builds another
 *                  (a compiler rebuilding in watch mode) would then hold
 *                  the dead structures' cyclic parts until the heap had
 *                  grown to the cap. The acyclic parts of such a structure
 *                  go by reference counting, which shows as the fall. One
 *                  that finds fewer older objects than had died doubles the
 *                  fall the next one needs, and a productive one restores
 *                  it. Like every full pass the growth rule did not choose
 *                  (backlog, scheduled age), it can raise the levels'
 *                  growth baselines but not lower them: the heap regrowing
 *                  to where it was before such a pass reclaimed a dropped
 *                  structure is a rebuild, not growth.
 *                  Once the thread's event loop runs, the pass waits for
 *                  the loop's next idle moment (scr_cyc_collect_idle), or
 *                  until the heap has grown the base fraction past where
 *                  it was asked for.
 *   mature         the same two rules one level down: a growth fraction
 *                  measured from the last mature-or-full pass and scheduled
 *                  by everything mature passes free, and a backlog rule over
 *                  the mature buffer. Until a mature pass has had
 *                  candidates, the backlog threshold widens with the growth
 *                  fraction (scr_cyc_backlog_threshold).
 *   scheduled age  a mature or old candidate has waited through a nursery's
 *                  worth of event-loop checkpoints. Candidate COUNT cannot
 *                  bound the garbage behind one root, and an idle heap does
 *                  not trip growth, so this keeps a sparse backlog from
 *                  floating forever without putting a full walk on every
 *                  turn.
 * The growth and backlog rules bound collection work to a constant factor of
 * mutator work — one heap-sized walk per live/N candidates or per growth of
 * live/N — while the scheduled age is the liveness backstop, limiting its
 * forced full walks to one per nursery's worth of checkpoints while older
 * roots wait. That is the trade: a fixed root threshold bounds floating
 * garbage tightly and pays unbounded time for it; this bounds ordinary
 * mutator-triggered work and lets garbage float in proportion, but not
 * forever. Peak memory stays bounded the same way. Every dead cycle keeps a
 * buffered member (a restricted pass re-buffers what it spares), and a full
 * pass walks every buffer without skipping any generation, so it leaves no
 * cyclic garbage behind except what its own teardowns release for the next
 * pass. Between two full passes the cycle-headered heap can grow by at most
 * the old level's fraction, so it never exceeds 17 times its size after the
 * last full pass (or the growth floor), or twice it with
 * SCR_CYCLE_GROWTH_CAP=1; the mature level bounds younger garbage the same
 * way between mature passes. That cap is reached only after passes have
 * stopped finding garbage. While they find it, a level widens its
 * fraction only in inverse proportion to its yield, so if the yield holds,
 * the garbage floating by its next pass stays below an eighth of the heap
 * once widened, inside the quarter the base fraction allows.
 */
#include "scr_runtime.h"

#ifndef SCR_WORKERS /* worker executables keep it in scr_thread_hot */
SCR_TL void (*scr_weak_dispose_hook)(void *) = NULL;
#endif

void scr_weak_dispose(void *object) {
  if (scr_weak_dispose_hook) scr_weak_dispose_hook(object);
}

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Every heap object's first member is `size_t rc`; the collector works on
 * its count (SCR_RC_COUNT), and tests it without a frozen record's bit
 * (SCR_RC_REFS). */
#define SCR_RC(obj) SCR_RC_COUNT(obj)

static void scr_cyc_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* A pointer vector that only ever grows (these reuse their capacity across
 * passes rather than churning it). Pointer, count and capacity live in ONE
 * struct on purpose: buffering a candidate is the hot path, and splitting
 * them across three arrays indexed by generation would touch three cache
 * lines per release where the original single buffer touched one. */
/* Its layout is scr_rc.h's ScrCycBuffer (the candidate buffers are part of
 * the inline buffering ABI). `used`: the most entries a pass held, for the
 * work vectors a pass fills (scr_cyc_push_work); scr_cyc_pass_done frees a
 * large vector that the pass used little of. */
typedef ScrCycBuffer ScrVec;

typedef struct {
  void *object;
  void (*destroy)(void *);
} ScrDestroyEntry;

/* Keep shallow destruction synchronous without allocating. A chain may mix
 * program layouts, unions and runtime containers, so one instance-local
 * depth budget covers every participating destructor. Queued zero-count
 * objects still own their children until their callback runs. */
#define SCR_DESTROY_DEPTH 64
#ifdef SCR_WORKERS
/* Worker executables keep the collector's per-thread state in one
 * thread-local block: on Darwin every distinct thread-local costs a call
 * per function that touches it, and the release, disposal and walk paths
 * touch several. Ordinary and library builds keep separate variables. */
typedef struct {
  unsigned destroy_depth;
  ScrDestroyEntry *destroy_pending;
  size_t destroy_count;
  size_t destroy_capacity;
  ScrVec roots[SCR_CYC_NGENS];
  bool collecting;
  ScrVec cands;
  ScrVec promote;
  ScrVec pending;
  ScrVec restore_pending;
  ScrVec white;
  ScrVec xgen;
  ScrVec xgen_edges;
  void *gray_holder;
  ScrVec pub_holes[SCR_CYC_NGENS];
  unsigned gen_limit;
  size_t live_after[SCR_CYC_NGENS];
  unsigned char growth_shift[SCR_CYC_NGENS];
  unsigned char growth_streak[SCR_CYC_NGENS];
  unsigned backlog_shift[SCR_CYC_NGENS];
  bool backlog_judged[SCR_CYC_NGENS];
  size_t fallen;
  size_t live_seen;
  size_t full_after;
  unsigned char death_shift;
  bool falling;
  bool idle_points;
  size_t death_due_live;
  bool keep_base;
  size_t trigger;
  size_t alloc_trigger;
  size_t gray_referenced;
  size_t comp_referenced;
  uint32_t gray_comp;
  ScrVec live_ranges;
  size_t scheduled_mature_age;
  size_t xg_freed;
  size_t mature_dead;
  struct ScrCycKind *kinds;
  size_t kinds_cap;
} ScrCycThread;
static _Thread_local ScrCycThread scr_cyc_thread = {.gen_limit = SCR_CYC_OLD};
#define scr_destroy_depth (scr_cyc_thread.destroy_depth)
#define scr_destroy_pending (scr_cyc_thread.destroy_pending)
#define scr_destroy_count (scr_cyc_thread.destroy_count)
#define scr_destroy_capacity (scr_cyc_thread.destroy_capacity)
#define scr_roots (scr_cyc_thread.roots)
#define scr_collecting (scr_cyc_thread.collecting)
#define scr_cands (scr_cyc_thread.cands)
#define scr_promote (scr_cyc_thread.promote)
#define scr_pending (scr_cyc_thread.pending)
#define scr_restore_pending (scr_cyc_thread.restore_pending)
#define scr_white (scr_cyc_thread.white)
#define scr_xgen (scr_cyc_thread.xgen)
#define scr_xgen_edges (scr_cyc_thread.xgen_edges)
#define scr_gray_holder (scr_cyc_thread.gray_holder)
#define scr_pub_holes (scr_cyc_thread.pub_holes)
#define scr_gen_limit (scr_cyc_thread.gen_limit)
#define scr_cyc_live_after (scr_cyc_thread.live_after)
#define scr_cyc_growth_shift (scr_cyc_thread.growth_shift)
#define scr_cyc_growth_streak (scr_cyc_thread.growth_streak)
#define scr_cyc_backlog_shift (scr_cyc_thread.backlog_shift)
#define scr_cyc_backlog_judged (scr_cyc_thread.backlog_judged)
#define scr_cyc_trigger (scr_cyc_thread.trigger)
#define scr_cyc_alloc_trigger (scr_cyc_thread.alloc_trigger)
#define scr_gray_referenced (scr_cyc_thread.gray_referenced)
#define scr_comp_referenced (scr_cyc_thread.comp_referenced)
#define scr_gray_comp (scr_cyc_thread.gray_comp)
#define scr_live_ranges (scr_cyc_thread.live_ranges)
#define scr_cyc_scheduled_mature_age (scr_cyc_thread.scheduled_mature_age)
#define scr_xg_freed (scr_cyc_thread.xg_freed)
#define scr_cyc_mature_dead (scr_cyc_thread.mature_dead)
#define scr_cyc_fallen (scr_cyc_thread.fallen)
#define scr_cyc_live_seen (scr_cyc_thread.live_seen)
#define scr_cyc_full_after (scr_cyc_thread.full_after)
#define scr_cyc_death_shift (scr_cyc_thread.death_shift)
#define scr_cyc_falling (scr_cyc_thread.falling)
#define scr_cyc_idle_points (scr_cyc_thread.idle_points)
#define scr_cyc_death_due_live (scr_cyc_thread.death_due_live)
#define scr_cyc_keep_base (scr_cyc_thread.keep_base)
#define scr_cyc_kinds (scr_cyc_thread.kinds)
#define scr_cyc_kinds_cap (scr_cyc_thread.kinds_cap)
#endif
#ifndef SCR_WORKERS
static SCR_TL unsigned scr_destroy_depth;
static SCR_TL ScrDestroyEntry *scr_destroy_pending;
static SCR_TL size_t scr_destroy_count, scr_destroy_capacity;
#endif

/* Queues a disposal past the depth budget; the outermost disposal runs it. */
static void scr_rc_destroy_defer(void *obj, void (*destroy)(void *)) {
  if (scr_destroy_count == scr_destroy_capacity) {
    size_t capacity = scr_destroy_capacity ? scr_destroy_capacity * 2 : 64;
    if (capacity < scr_destroy_capacity || capacity > SIZE_MAX / sizeof(ScrDestroyEntry))
      scr_cyc_oom();
    ScrDestroyEntry *entries = realloc(scr_destroy_pending, capacity * sizeof(*entries));
    if (!entries) scr_cyc_oom();
    scr_destroy_pending = entries;
    scr_destroy_capacity = capacity;
  }
  scr_destroy_pending[scr_destroy_count++] = (ScrDestroyEntry){ obj, destroy };
}

/* Runs the queued disposals once the outermost one has returned. */
static void scr_rc_destroy_drain(void) {
  while (scr_destroy_count) {
    ScrDestroyEntry entry = scr_destroy_pending[--scr_destroy_count];
    scr_destroy_depth = 1;
    entry.destroy(entry.object);
    scr_destroy_depth = 0;
  }
  /* Deep teardown is exceptional; don't retain its peak queue allocation
   * throughout an otherwise idle executable or embedded runtime instance. */
  if (scr_destroy_pending) {
    free(scr_destroy_pending);
    scr_destroy_pending = NULL;
    scr_destroy_capacity = 0;
  }
}

void scr_rc_destroy(void *obj, void (*destroy)(void *)) {
  if (scr_destroy_depth == SCR_DESTROY_DEPTH) {
    scr_rc_destroy_defer(obj, destroy);
    return;
  }
  scr_destroy_depth++;
  destroy(obj);
  scr_destroy_depth--;
  if (scr_destroy_depth == 0) scr_rc_destroy_drain();
}

void *scr_rc_destroy_seg(void *obj, void *(*destroy_seg)(void *, void *),
                         void (*destroy)(void *), void *tail) {
  if (scr_destroy_depth == SCR_DESTROY_DEPTH) {
    scr_rc_destroy_defer(obj, destroy);
    return tail;
  }
  scr_destroy_depth++;
  tail = destroy_seg(obj, tail);
  scr_destroy_depth--;
  if (scr_destroy_depth == 0) scr_rc_destroy_drain();
  return tail;
}

/* Live cycle-headered objects and the running count of OLD objects freed.
 * The inline allocation/free paths (scr_runtime.h, llvm/alloc.ts) maintain
 * both counters so full passes can measure old-generation reclamation. */
#ifndef SCR_WORKERS /* worker executables keep them in scr_thread_hot */
SCR_TL size_t scr_cyc_live = 0;
SCR_TL size_t scr_cyc_old_freed = 0;
#endif

/* Descriptor copies by registry id. Id 0 stays empty (an unregistered type).
 * Explicitly initialized so library localization can demote it: a tentative
 * definition is a COMMON symbol on Mach-O, and COMMON symbols stay global. */
ScrCycType scr_cyc_types[SCR_CYC_MAX_TYPES] = {0};
static uint32_t scr_cyc_ntypes = 1;

/* Assign `type` its id on its first allocation; any thread may get there
 * first, and every thread then sees the same id. A lost race leaves one
 * table slot unused. */
uint32_t scr_cyc_register(ScrCycType *type) {
  uint32_t id = __atomic_load_n(&type->id, __ATOMIC_ACQUIRE);
  if (id) return id;
  uint32_t fresh = __atomic_fetch_add(&scr_cyc_ntypes, 1, __ATOMIC_RELAXED);
  if (fresh >= SCR_CYC_MAX_TYPES) scr_trap("scriptc: too many cycle-collected types\n");
  /* Copy the fields another thread never writes; `id` may be published
   * concurrently by a racing registration. */
  scr_cyc_types[fresh] = (ScrCycType){
      .trace = type->trace, .free_fn = type->free_fn, .kind = type->kind, .id = fresh};
  __atomic_thread_fence(__ATOMIC_RELEASE);
  uint32_t expected = 0;
  if (__atomic_compare_exchange_n(&type->id, &expected, fresh, false, __ATOMIC_ACQ_REL,
                                  __ATOMIC_ACQUIRE))
    return fresh;
  return expected;
}

void *scr_cyc_alloc(size_t size, ScrCycType *type) {
  void *obj = scr_cyc_alloc_inline(size, type);
  if (type->trace == scr_cyc_no_children) scr_cyc_hdr(obj)->buf = SCR_CYC_ACYCLIC;
  return obj;
}

void scr_cyc_no_children(void *obj, ScrTraceVisit visit, void *ctx) {
  (void)obj;
  (void)visit;
  (void)ctx;
}

void scr_cyc_free(void *obj) { scr_cyc_free_inline(obj); }

static __attribute__((noinline, cold)) void scr_cyc_grow(ScrVec *vec) {
  /* Candidate positions are 31-bit (ScrCycHdr.buf). */
  if (vec->cap > (size_t)(SCR_CYC_BUFFERED_BIT - 1) / 2) scr_cyc_oom();
  vec->cap = vec->cap ? vec->cap * 2 : 64;
  void **grown = realloc(vec->v, vec->cap * sizeof *grown);
  if (!grown) scr_cyc_oom();
  vec->v = grown;
}

static __attribute__((noinline)) void scr_cyc_push(ScrVec *vec, void *obj) {
  if (vec->n == vec->cap) scr_cyc_grow(vec);
  vec->v[vec->n++] = obj;
}

/* A push onto a vector that a pass fills and leaves empty, recording how
 * many entries the pass held at most. */
static inline void scr_cyc_push_work(ScrVec *vec, void *obj) {
  scr_cyc_push(vec, obj);
  if (vec->n > vec->used) vec->used = vec->n;
}

/* The same push inline, for the gray list markGray fills once per object;
 * the pass records the list's high-water mark itself (scr_cyc_note_used). */
static inline void scr_cyc_push_gray(ScrVec *vec, void *obj) {
  if (__builtin_expect(vec->n == vec->cap, 0)) scr_cyc_grow(vec);
  vec->v[vec->n++] = obj;
}
static inline void scr_cyc_note_used(ScrVec *vec) {
  if (vec->n > vec->used) vec->used = vec->n;
}

/* ── the candidate-root buffers (one per generation) ──────────────────── */

#ifndef SCR_WORKERS
/* Emitted and inline releases append nursery candidates to these buffers
 * directly where the build allows it (scr_rc.h). Explicitly initialized so
 * library localization can demote it (see scr_cyc_types). */
#if SCR_CYC_INLINE_BUFFERING
ScrCycBuffers scr_cyc_buffers = {0};
#else
static SCR_TL ScrCycBuffers scr_cyc_buffers;
#endif
#define scr_roots (scr_cyc_buffers.roots)
#define scr_cyc_alloc_trigger (scr_cyc_buffers.alloc_trigger)
static SCR_TL bool scr_collecting = false;
#endif

/* The candidates of the pass in flight, gathered across the generations it
 * collects so the phases can walk them without re-filtering the buffers. */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_cands;
#endif

/* Nursery survivors awaiting promotion (see scr_scan_black). */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_promote;
#endif

/* Deferred traces cap recursive traversal without changing the common
 * depth-first walk. Restore can run inside scan, so it has its own stack. */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_pending;
static SCR_TL ScrVec scr_restore_pending;
#endif

/* The gathered white set (freed after the walk completes). */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_white;
#endif

/* Cross-generation targets pinned by the white set (see "cross-generation
 * edges"), one entry per skipped edge. Drained after the teardowns. */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_xgen;
#endif

/* Edges from a gray object into a generation the pass does not walk, as
 * (holder, target) pairs, recorded by markGray (each gray object is traced
 * there exactly once, so each edge appears once), and the object markGray is
 * tracing. */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_xgen_edges;
static SCR_TL void *scr_gray_holder;
#endif

/* Objects above this generation are invisible to the pass in flight. */
#ifndef SCR_WORKERS
static SCR_TL unsigned scr_gen_limit = SCR_CYC_OLD;
#endif

static size_t scr_cyc_pass(unsigned gen_limit);
#ifdef SCR_YIN
/* The young-in nursery's state (see "young-in nursery" below): the nursery
 * itself (scr_rc.h), every live young object at the index its header
 * records; a collection's mark worklist, dead set and deferred releases;
 * per-object counts of references from other young objects, valid during a
 * collection. */
SCR_TL ScrYin scr_yin = {0};
static SCR_TL ScrVec scr_yin_stack;
static SCR_TL ScrVec scr_yin_dead;
static SCR_TL ScrVec scr_yin_xrel;
static SCR_TL uint32_t *scr_yin_counts;
static SCR_TL size_t scr_yin_counts_cap;
static SCR_TL bool scr_yin_busy;
static void scr_yin_leave(ScrCycHdr *h, void *obj);
static size_t scr_yin_collect(void);
#endif
static void scr_cyc_route_bypassed(void);
/* A limited pass (scr_cyc_collect_set) takes only the candidates in this
 * set from the buffers up to `scr_cyc_take_gen`; NULL takes them all. */
static SCR_TL const ScrCycSet *scr_cyc_take = NULL;
static SCR_TL unsigned scr_cyc_take_gen = SCR_CYC_OLD;

/* ── when to collect ──────────────────────────────────────────────────── */

#define SCR_CYC_NURSERY_CANDIDATES 256 /* nursery trigger */
/* A release that buffers a candidate also runs a pass once the live
 * cycle-headered count has grown by this much since the last one, however
 * few candidates there are: a dead structure is usually reachable from a
 * single candidate (its root), so counting candidates alone lets thousands
 * of dead structures pile up, and the pass then walks them long after they
 * have left the cache. */
#define SCR_CYC_NURSERY_ALLOCATIONS 4096

/* Scheduling decisions run once per pass, never per object, so they are
 * kept out of line and built for size: every executable that can release a
 * cycle-capable value links them, including ones that never form a cycle. */
#define SCR_CYC_SCHEDULING __attribute__((cold, noinline, minsize))

/* Per-pass and cross-generation bookkeeping: work that is proportional to
 * candidates, dead objects or skipped edges and dominated by the calls it
 * makes, never the per-edge graph walk. Built for size for the same reason. */
#define SCR_CYC_COMPACT __attribute__((noinline, minsize))
#define SCR_CYC_GROWTH_DIV 4           /* growth pass per +1/4 of live heap */
#define SCR_CYC_GROWTH_FLOOR 4096      /* ...but not below this many objects */

/* Per level, the live count as of the end of the last pass that walked it:
 * the mature entry is set by mature and full passes, the old entry by full
 * passes. The nursery entry is unused. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_cyc_live_after[SCR_CYC_NGENS];
#endif

/* Per level, doublings of the growth fraction (see scr_cyc_adapt_growth),
 * and whether the last growth-triggered pass at that level asked for a wider
 * fraction than the current one. Only the mature and old entries are used.
 *
 * The fraction is capped at 16 (shift 6): after passes at a level stop
 * finding garbage, the heap may grow to 17 times its size after the last
 * pass there before the next. A lower cap bounds dead cyclic garbage more
 * tightly, but a large live heap that keeps growing is then walked in full
 * each time it grows by the cap, and on such heaps (a compiler checking a
 * large program, say) those walks dominate collection time. The cap trades
 * that walking for memory only when passes find nothing: while they find
 * garbage, the yield keeps the fraction narrow. SCR_CYCLE_GROWTH_CAP lowers
 * the cap for memory-sensitive programs, as scr_cyc_set_growth_cap does for
 * a program that sets its own: a power of two from 1 to 16, with
 * other positive values rounded down to a power of two and larger ones read
 * as 16. At 1 the heap may at most double past its size after the last pass
 * at a level before the next. */
#define SCR_CYC_GROWTH_MAX_SHIFT 6
#ifndef SCR_WORKERS
static SCR_TL unsigned char scr_cyc_growth_shift[SCR_CYC_NGENS];
static SCR_TL unsigned char scr_cyc_growth_streak[SCR_CYC_NGENS];
#endif

/* The growth cap a program sets for itself (scr_cyc_set_growth_cap), 0 for
 * the default; SCR_CYCLE_GROWTH_CAP takes precedence over it. */
static long scr_cyc_growth_cap_set = 0;
static SCR_TL unsigned char scr_cyc_growth_max_shift_cached = 0;

/* Shift of the configured growth cap: 2 + log2(cap), since the base
 * fraction is 1/4. */
static unsigned scr_cyc_growth_max_shift(void) {
  if (scr_cyc_growth_max_shift_cached == 0) {
    const char *env = scr_getenv("SCR_CYCLE_GROWTH_CAP");
    long v = env ? strtol(env, NULL, 10) : 0;
    if (v <= 0) v = scr_cyc_growth_cap_set;
    unsigned shift = SCR_CYC_GROWTH_MAX_SHIFT;
    if (v > 0)
      for (shift = 2; shift < SCR_CYC_GROWTH_MAX_SHIFT && (2L << (shift - 2)) <= v;)
        shift++;
    scr_cyc_growth_max_shift_cached = (unsigned char)shift;
  }
  return scr_cyc_growth_max_shift_cached;
}

void scr_cyc_set_growth_cap(long cap) {
  scr_cyc_growth_cap_set = cap;
  scr_cyc_growth_max_shift_cached = 0;
  /* Fractions already widened past the new cap start at it. */
  unsigned max = scr_cyc_growth_max_shift();
  for (unsigned gen = 0; gen < SCR_CYC_NGENS; gen++)
    if (scr_cyc_growth_shift[gen] > max) scr_cyc_growth_shift[gen] = (unsigned char)max;
}

/* Doublings of each generation's backlog threshold earned by consecutive
 * passes that found almost nothing to free (see scr_cyc_backlog_threshold),
 * and whether a pass at that level has had candidates to judge them by.
 * Only the mature and old entries are used. */
#define SCR_CYC_BACKLOG_MAX_SHIFT 8
#ifndef SCR_WORKERS
static SCR_TL unsigned scr_cyc_backlog_shift[SCR_CYC_NGENS];
static SCR_TL bool scr_cyc_backlog_judged[SCR_CYC_NGENS];
#endif

/* Mature objects in the last full pass's dead set (scr_cyc_adapt_growth). */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_cyc_mature_dead = 0;
#endif

/* The death rule (see the scheduling notes above). `fallen`: how far the
 * live count fell between passes since the last full pass; `live_seen`: the
 * live count at the end of the last pass or check; `full_after`: the live
 * count after the last full pass; `falling`: whether it fell since the
 * previous check; `death_shift`: doublings of the fall a pass needs, earned
 * by passes that found less than had died; `keep_base`: the pass running
 * is a full pass the growth rule did not choose, which may raise the
 * levels' growth baselines but not lower them. */
#define SCR_CYC_DEATH_DIV 32
#define SCR_CYC_DEATH_MAX_SHIFT 8
#ifndef SCR_WORKERS
static SCR_TL size_t scr_cyc_fallen = 0, scr_cyc_live_seen = 0, scr_cyc_full_after = 0;
static SCR_TL unsigned char scr_cyc_death_shift = 0;
static SCR_TL bool scr_cyc_falling = false, scr_cyc_keep_base = false;
#endif

/* A death pass waits for an idle moment of the thread's event loop
 * (scr_cyc_collect_idle) once the loop runs (`idle_points`): the dropped
 * structure it reclaims is not urgent, and a program that drops one in the
 * middle of its work (a compiler starting a rebuild in watch mode) would
 * otherwise walk its whole heap on the way. `death_due_live`: the live
 * count when the death rule first asked for the pass that waits, 0 when
 * none does. If the heap grows the base fraction past that before an idle
 * moment comes, the pass runs where it is due. */
#ifndef SCR_WORKERS
static SCR_TL bool scr_cyc_idle_points = false;
static SCR_TL size_t scr_cyc_death_due_live = 0;
#endif

static size_t scr_cyc_nursery_threshold(void) {
  static SCR_TL size_t cached = 0;
  if (cached == 0) {
    const char *env = scr_getenv("SCR_CYCLE_THRESHOLD");
    long v = env ? strtol(env, NULL, 10) : 0;
    cached = v > 0 ? (size_t)v : SCR_CYC_NURSERY_CANDIDATES;
  }
  return cached;
}

/* The number of buffered candidates (across every generation) at which the
 * release path next collects, and the live count at which it collects
 * however few candidates there are. The trigger is re-armed at the end of
 * every pass to "whatever survived, plus a nursery's worth": without that
 * hysteresis a large older buffer — which a nursery pass cannot drain —
 * would re-arm on every single release. Both start at zero, so the first
 * release runs one trivial pass that arms them properly. The inline
 * appends (scr_rc.h) compare against the window scr_cyc_window_update
 * derives from these, so the slow path sums the buffers when it needs the
 * total. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_cyc_trigger = 0;
#endif
/* Gray objects whose count is above zero after the trial decrements so far
 * (see scr_mg_visit). markGray records the gray objects in scr_white while
 * there are fewer than SCR_CYC_GRAY_LIST_MAX; a larger walk runs scan.
 *
 * The same count is kept per component (see "components" at scr_cyc_pass):
 * the objects one candidate's walk grays first carry that walk's number in
 * `buf` (gray objects are never buffered during a pass), and
 * scr_comp_referenced counts those still externally referenced.
 * scr_live_ranges holds (start, end) ranges of scr_white whose component
 * was externally referenced and is left to scan. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_gray_referenced = 0;
static SCR_TL size_t scr_comp_referenced = 0;
static SCR_TL uint32_t scr_gray_comp = 0;
static SCR_TL ScrVec scr_live_ranges;
#endif
#define SCR_CYC_GRAY_LIST_MAX 65536


/* Scheduled nursery passes for which at least one mature or old root was
 * waiting. A full pass resets the age; with no such backlog there is nothing
 * to age. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_cyc_scheduled_mature_age = 0;
#endif

static size_t scr_cyc_buffered(void) {
  return scr_roots[SCR_CYC_NURSERY].n + scr_roots[SCR_CYC_MATURE].n
         + scr_roots[SCR_CYC_OLD].n;
}

/* The inline buffering window (scr_rc.h): how many entries the nursery
 * buffer may hold before an append would bring the buffered total to the
 * trigger or would need the buffer to grow. While a pass runs, every
 * release takes the call. Recomputed wherever the buffers, the nursery
 * buffer's capacity or the trigger change in bulk; the release and death
 * paths adjust it by one (scr_cyc_window_shrink). */
static inline void scr_cyc_window_update(void) {
#if SCR_CYC_INLINE_BUFFERING
  size_t window = 0;
  if (!scr_collecting) {
    size_t older = scr_roots[SCR_CYC_MATURE].n + scr_roots[SCR_CYC_OLD].n;
    if (scr_cyc_trigger > older + 1) window = scr_cyc_trigger - older - 1;
    if (window > scr_roots[SCR_CYC_NURSERY].cap) window = scr_roots[SCR_CYC_NURSERY].cap;
  }
  scr_cyc_buffers.window = window;
#endif
}

/* One step of the window's formula going down by one: an older candidate
 * was buffered, or a nursery death lowered the trigger. A window below the
 * formula only sends more releases through the call, so the clamp to the
 * capacity can stay where it is. */
static inline void scr_cyc_window_shrink(void) {
#if SCR_CYC_INLINE_BUFFERING
  if (scr_cyc_buffers.window) scr_cyc_buffers.window--;
#endif
}

static bool scr_cyc_older_backlog(void) {
  return scr_roots[SCR_CYC_MATURE].n != 0 || scr_roots[SCR_CYC_OLD].n != 0;
}

static size_t scr_cyc_growth_base(size_t live_after) {
  return live_after < SCR_CYC_GROWTH_FLOOR ? SCR_CYC_GROWTH_FLOOR : live_after;
}

/* A pass at `gen` is due once the live heap has grown that level's fraction
 * past what it was when the last pass at that level finished. Since a pass
 * resets its baseline to the live count it leaves behind, an unproductive
 * pass cannot re-trigger itself — the next one waits for another fraction of
 * growth. */
static SCR_CYC_SCHEDULING bool scr_cyc_grown(unsigned gen) {
  size_t base = scr_cyc_growth_base(scr_cyc_live_after[gen]);
  return scr_cyc_live > base + ((base / SCR_CYC_GROWTH_DIV) << scr_cyc_growth_shift[gen]);
}

/* The backlog rule for one generation's candidate buffer.
 *
 * Heap growth is not the only thing that owes a pass. Live data that TURNS
 * INTO garbage — an older structure unlinked into a dead cycle — grows no
 * counter at all: those objects were already tallied in scr_cyc_live when
 * they were allocated, so the growth rules stay false forever, and a
 * restricted pass cannot see them because they sit above its level. Left at
 * that, a program that churns its long-lived structures without allocating
 * would never collect anything. So a buffer's own size is the second trigger
 * for its level, at a fraction of the live heap: that bounds uncollected
 * candidates proportionally and keeps the amortized cost linear (one walk
 * per live/N candidates).
 *
 * Re-buffered live objects cannot be told apart from new garbage until a
 * pass walks them, and a program that keeps traversing one live structure
 * buffers it again after every pass. Each backlog-level pass that frees
 * almost none of its candidates doubles the threshold, so repeated
 * unproductive walks thin out geometrically; once it exceeds the population
 * this trigger rests, leaving heap growth, the scheduled age and exit to
 * collect. That only delays garbage made from existing data: replacing it
 * requires allocation, which grows the heap and trips a growth trigger. The
 * first productive pass at that level restores the original fraction.
 *
 * Only passes that had candidates adapt the threshold. Until one has, the
 * level uses its growth fraction's doublings instead (scr_cyc_adapt_growth),
 * which every growth-triggered pass at the level adapts, candidates or not.
 * A program can keep a level's buffer empty while its heap grows, so that
 * growth passes there find nothing and widen, and then fill the buffer with
 * live objects (a structure it builds and reads as it builds it); at the
 * base threshold, the first backlog pass would walk a quarter of the live
 * heap to find nothing. */
static size_t scr_cyc_backlog_threshold(unsigned gen) {
  size_t t = scr_cyc_live / SCR_CYC_GROWTH_DIV;
  if (t < SCR_CYC_NURSERY_CANDIDATES) t = SCR_CYC_NURSERY_CANDIDATES;
  unsigned shift =
      scr_cyc_backlog_judged[gen] ? scr_cyc_backlog_shift[gen] : scr_cyc_growth_shift[gen];
  return t > (SIZE_MAX >> shift) ? SIZE_MAX : t << shift;
}

/* Adapt a level's growth fraction to the yield of a growth-triggered pass at
 * that level: `reclaimed` objects found against `growth` objects of heap
 * growth since the previous pass there. Only full passes reclaim the old
 * generation, so a full pass counts old objects, plus the mature objects of
 * its dead set (scr_cyc_mature_dead): a dead structure whose members are
 * partly old and partly mature, which is what a type that stops bypassing
 * the mature level leaves behind, is invisible to mature passes, so a full
 * pass is the only one that finds any of it. Garbage that has not survived
 * a pass is the nursery's to find, and a mature pass counts everything it
 * freed.
 *
 * The fraction is sized so the garbage a level lets float stays near what the
 * base schedule allows. A pass whose yield reaches 1/GROWTH_DIV of the growth
 * keeps the base fraction of 1/4; each halving of the yield below that asks
 * for one doubling of the fraction, up to the cap. A level that keeps
 * reclaiming in proportion to growth therefore stays on the base schedule,
 * while one whose passes walk a large retained structure and find nothing
 * spaces them out geometrically, so its total walking stays a small multiple
 * of the heap it ends with instead of growing with every fraction of growth.
 *
 * Narrowing takes effect at once: a pass that finds garbage again moves the
 * fraction straight to what its yield asks for. Widening waits for two
 * passes in a row that asked for it. A program that discards older
 * structures at a steady rate sees its passes alternate between finding the
 * garbage just aged into the level and finding it still younger, and a
 * single miss says little.
 *
 * How far a qualifying pass widens depends on what the level's passes walk.
 * A full pass walks the whole heap, and a heap that grows for a whole run
 * gets only a handful of them, so widening a doubling per pass spent the
 * largest walks on the way to the cap (a run with seven full passes never
 * reached it). The old level therefore widens two doublings per qualifying
 * pass, never past what the pass asked for: passes that keep finding
 * nothing reach the cap of 16 on the fourth pass instead of the sixth, while
 * the heap is still small. A mature pass walks only what was promoted since
 * the last one, so its total walking hardly depends on how passes are
 * spaced, and the mature level keeps widening a doubling per pass, which
 * lets less young garbage float. */
#define SCR_CYC_OLD_WIDEN_STEP 2
static void scr_cyc_adapt_growth(unsigned gen, size_t growth,
                                 size_t reclaimed) {
  unsigned want = 0, max = scr_cyc_growth_max_shift();
  while (want < max && reclaimed * SCR_CYC_GROWTH_DIV < (growth >> want))
    want++;
  if (want <= scr_cyc_growth_shift[gen]) {
    scr_cyc_growth_shift[gen] = (unsigned char)want;
    scr_cyc_growth_streak[gen] = 0;
  } else if (scr_cyc_growth_streak[gen]) {
    unsigned shift = scr_cyc_growth_shift[gen] + (gen == SCR_CYC_OLD ? SCR_CYC_OLD_WIDEN_STEP : 1);
    scr_cyc_growth_shift[gen] = (unsigned char)(shift < want ? shift : want);
  } else {
    scr_cyc_growth_streak[gen] = 1;
  }
}

/* How far the live count fell since the last check: what died outside
 * passes, less what was allocated meanwhile. Every pass ends with a fresh
 * reading, so what passes free does not count. */
static void scr_cyc_note_fall(void) {
  scr_cyc_falling = scr_cyc_live < scr_cyc_live_seen;
  if (scr_cyc_falling) scr_cyc_fallen += scr_cyc_live_seen - scr_cyc_live;
  scr_cyc_live_seen = scr_cyc_live;
}

/* The death rule: enough has died since the last full pass, it has stopped
 * dying (a structure torn down by reference counting falls over several
 * checks, and a pass in the middle would find its rest still referenced),
 * and the heap has grown the base fraction since. */
static SCR_CYC_SCHEDULING bool scr_cyc_died(void) {
  if (scr_cyc_falling) return false;
  size_t base = scr_cyc_growth_base(scr_cyc_full_after);
  size_t need = base / SCR_CYC_DEATH_DIV;
  need = need > (SIZE_MAX >> scr_cyc_death_shift) ? SIZE_MAX : need << scr_cyc_death_shift;
  return scr_cyc_fallen >= need && scr_cyc_live > base + base / SCR_CYC_GROWTH_DIV;
}

/* One scheduled pass at `gen`. A mature or old pass adapts that level's
 * backlog threshold to its yield; the explicit sweep (scr_collect_cycles) is
 * not a scheduling decision and leaves the thresholds alone. Productive means
 * at least one object freed per GROWTH_DIV candidates; a pass with no
 * candidates says nothing. A pass that its level's growth rule triggered also
 * adapts that level's growth fraction (scr_cyc_adapt_growth).
 *
 * Every level shares this one body, so a program that links the collector
 * carries a single copy of the scheduling logic. */
static SCR_CYC_SCHEDULING void scr_cyc_scheduled_pass(unsigned gen, bool by_growth, bool by_death) {
  size_t base = scr_cyc_growth_base(scr_cyc_live_after[gen]);
  size_t growth = scr_cyc_live > base ? scr_cyc_live - base : 0;
  size_t fallen = scr_cyc_fallen;
  size_t old_freed_before = scr_cyc_old_freed;
  scr_cyc_keep_base = gen == SCR_CYC_OLD && !by_growth;
  size_t freed = scr_cyc_pass(gen);
  scr_cyc_keep_base = false;
  size_t old_reclaimed = scr_cyc_old_freed - old_freed_before + scr_cyc_mature_dead;
  if (gen == SCR_CYC_NURSERY) return;
  if (scr_cands.n != 0) {
    scr_cyc_backlog_judged[gen] = true;
    if (freed * SCR_CYC_GROWTH_DIV >= scr_cands.n)
      scr_cyc_backlog_shift[gen] = 0;
    else if (scr_cyc_backlog_shift[gen] < SCR_CYC_BACKLOG_MAX_SHIFT)
      scr_cyc_backlog_shift[gen]++;
  }
  if (by_death) {
    if (old_reclaimed >= fallen) scr_cyc_death_shift = 0;
    else if (scr_cyc_death_shift < SCR_CYC_DEATH_MAX_SHIFT) scr_cyc_death_shift++;
  } else if (by_growth)
    scr_cyc_adapt_growth(gen, growth,
                         gen == SCR_CYC_OLD ? old_reclaimed : freed);
}

/* Cold half of the release path: pick the level and collect. It runs once
 * per pass, so it is kept out of line and built for size, which leaves the
 * hot buffering path in scr_cyc_on_release small. */
static SCR_CYC_SCHEDULING void scr_cyc_collect_due(void) {
  scr_cyc_route_bypassed();
  scr_cyc_note_fall();
  unsigned gen = SCR_CYC_OLD;
  bool by_growth = scr_cyc_grown(SCR_CYC_OLD);
  bool by_death = !by_growth && scr_cyc_died();
  if (by_death && scr_cyc_idle_points) {
    if (!scr_cyc_death_due_live) scr_cyc_death_due_live = scr_cyc_live;
    by_death = scr_cyc_live > scr_cyc_death_due_live + scr_cyc_death_due_live / SCR_CYC_GROWTH_DIV;
  }
  if (!by_growth && !by_death && scr_roots[SCR_CYC_OLD].n < scr_cyc_backlog_threshold(SCR_CYC_OLD)) {
    gen = SCR_CYC_MATURE;
    by_growth = scr_cyc_grown(SCR_CYC_MATURE);
    if (!by_growth && scr_roots[SCR_CYC_MATURE].n < scr_cyc_backlog_threshold(SCR_CYC_MATURE))
      gen = SCR_CYC_NURSERY;
  }
  scr_cyc_scheduled_pass(gen, by_growth, by_death);
}

/* One scheduled pass, for callers that reach a natural collection point
 * (the event loop between turns) rather than a threshold. Deliberately NOT
 * scr_collect_cycles: that one is the exit-time full sweep, and running it
 * per turn would walk the whole live heap every turn — which is exactly the
 * cost the generations exist to avoid. */
void scr_cyc_collect_scheduled(void) {
#ifdef SCR_YIN
  /* A collection point also collects the nursery when anything entered it
   * since its last collection, so young garbage does not wait for the
   * allocation trigger in a program that has gone idle. */
  if (scr_yin.n != 0) scr_yin_collect();
#endif
  scr_cyc_route_bypassed();
  scr_cyc_note_fall();
  if (scr_cyc_buffered() == 0) {
    scr_cyc_scheduled_mature_age = 0;
    return;
  }
  if (!scr_cyc_older_backlog()) {
    scr_cyc_scheduled_mature_age = 0;
  } else if (++scr_cyc_scheduled_mature_age
             >= scr_cyc_nursery_threshold()) {
    scr_cyc_scheduled_pass(SCR_CYC_OLD, false, false);
    return;
  }
  scr_cyc_collect_due();
}

void scr_cyc_note_event_loop(void) { scr_cyc_idle_points = true; }

/* The death rule held when it asked for the waiting pass, and nothing
 * dies while the loop waits, so the pass runs without checking the rule
 * again: a heap that kept shrinking since would fail its size test, and
 * the dead structure it was asked for would stay buffered. */
bool scr_cyc_collect_idle(void) {
  if (!scr_cyc_death_due_live || scr_collecting) return false;
  scr_cyc_note_fall();
  scr_cyc_scheduled_pass(SCR_CYC_OLD, false, true);
  return true;
}

/* ── level bypass ─────────────────────────────────────────────────────── */

/* A nursery pass costs about the same for every candidate it walks, and
 * nearly every long-lived object is a candidate once, soon after it is
 * built: the release of the constructing frame's reference leaves it held
 * only by the structure it was stored into. So the nursery walks almost the
 * whole long-lived heap once, then re-buffers it for the mature level, whose
 * next pass walks it again. For most types neither walk finds anything: a
 * compiler's symbols, symbol links and syntax nodes survive essentially
 * always, and in tsc-ts they are half of what nursery passes walk. Garbage
 * cycles in the younger levels come from a few types (inference contexts
 * and their mappers, closures, some arrays).
 *
 * So each thread keeps, per collector type (ScrCycType.kind) and for the
 * nursery and mature levels, how many of the type's candidates passes at
 * that level walked and how many of its objects they freed. After every
 * BYPASS_WINDOW walked candidates, the type bypasses that level for the
 * next window if its objects were freed in fewer than one in BYPASS_RATIO
 * of them. A release that buffers an object of a bypassed level promotes
 * it past the level first, and so does a nursery pass that re-buffers a
 * survivor into a level the type bypasses: the candidate waits in an older
 * buffer, and passes of the bypassed level stop at it as they stop at any
 * older object.
 *
 * A bypassing type is still measured, by probing: after BYPASS_PROBE
 * windows' worth of candidates have gone past the level, the type is walked
 * there again for a full window and judged afresh. Measuring a sample of
 * candidates instead (some kept at the level while the rest go past it) is
 * biased towards survival: a dead cycle of the type usually has several
 * candidate members, and a sampled member is kept alive by the edges of its
 * partners that went past, which a pass at the level does not trial-delete.
 * A type that once bypassed would then keep bypassing while its cycles died
 * young, and its garbage would wait for full passes over the whole heap. In
 * a probe window every candidate of the type stays at the level, so the
 * cycles it builds during the window die there.
 *
 * This changes only which generation an object is judged in. Any
 * generation assignment is sound (a restricted pass treats edges from older
 * objects as external), and a bypassing candidate is buffered like any
 * other, so a dead cycle through it keeps a buffered member exactly as a
 * survivor re-buffered into the next generation does. Full passes walk
 * everything they did before, so the old level's bounds above are
 * unchanged; garbage cycles made only of objects of a bypassing type wait
 * for the next pass at an older level, by construction a type whose
 * candidates almost never die at the bypassed one. Small programs never
 * complete a window and are collected exactly as before. */
#define SCR_CYC_BYPASS_WINDOW 8192 /* walked candidates per decision */
#define SCR_CYC_BYPASS_RATIO 128   /* bypass when freed < walked / RATIO */
#define SCR_CYC_BYPASS_PROBE 16    /* windows of bypassed candidates per probe */

/* One level's statistics for a type. */
typedef struct {
  uint32_t walked; /* candidates walked by passes at this level, this window */
  uint32_t freed;  /* objects freed by passes at this level, this window */
  uint32_t bypass; /* candidates to send past the level before the next
                    * probe window; 0 while the type is walked there */
} ScrCycLevelStat;
typedef struct ScrCycKind {
  ScrCycLevelStat level[2]; /* SCR_CYC_NURSERY, SCR_CYC_MATURE */
} ScrCycKind;

#ifndef SCR_WORKERS
static SCR_TL ScrCycKind *scr_cyc_kinds;
static SCR_TL size_t scr_cyc_kinds_cap;
#endif
#if SCR_CYC_INLINE_BUFFERING
/* Types that bypass the nursery right now (scr_cyc_route_bypassed). */
static size_t scr_cyc_nursery_bypassing = 0;
#endif

/* The statistics of `kind` (nonzero), growing the table to cover it. */
static SCR_CYC_COMPACT ScrCycKind *scr_cyc_kind_grow(uint32_t kind) {
  size_t cap = scr_cyc_kinds_cap ? scr_cyc_kinds_cap : 256;
  while (cap <= kind) cap *= 2;
  ScrCycKind *kinds = realloc(scr_cyc_kinds, cap * sizeof *kinds);
  if (!kinds) scr_cyc_oom();
  memset(kinds + scr_cyc_kinds_cap, 0, (cap - scr_cyc_kinds_cap) * sizeof *kinds);
  scr_cyc_kinds = kinds;
  scr_cyc_kinds_cap = cap;
  return &kinds[kind];
}
static inline ScrCycKind *scr_cyc_kind(uint32_t kind) {
  return kind < scr_cyc_kinds_cap ? &scr_cyc_kinds[kind] : scr_cyc_kind_grow(kind);
}

/* Whether a candidate of this type at level `gen` (nursery or mature)
 * skips that level's passes (see above). The last candidate a bypass sends
 * past the level opens a probe window, with fresh counts. */
static inline __attribute__((always_inline)) bool scr_cyc_bypassed(const ScrCycType *type,
                                                                  unsigned gen) {
  uint32_t kind = type->kind;
  if (kind >= scr_cyc_kinds_cap) return false;
  ScrCycLevelStat *k = &scr_cyc_kinds[kind].level[gen];
  if (k->bypass == 0) return false;
  if (--k->bypass == 0) {
    k->walked = k->freed = 0;
#if SCR_CYC_INLINE_BUFFERING
    if (gen == SCR_CYC_NURSERY) scr_cyc_nursery_bypassing--;
#endif
  }
  return true;
}

/* The generation a release buffers an object into: its own, or past the
 * levels its type bypasses. Both run once per candidate that the routing
 * below moves, so they are inlined there too. */
static inline __attribute__((always_inline)) unsigned scr_cyc_buffer_gen(const ScrCycType *type,
                                                                 unsigned gen) {
  if (gen == SCR_CYC_NURSERY && scr_cyc_bypassed(type, SCR_CYC_NURSERY)) gen = SCR_CYC_MATURE;
  if (gen == SCR_CYC_MATURE && scr_cyc_bypassed(type, SCR_CYC_MATURE)) gen = SCR_CYC_OLD;
  return gen;
}

/* A pass at `gen` (nursery or mature) walks a candidate of `type`: count
 * it, and decide the next window when this one is full. */
static inline void scr_cyc_walked(const ScrCycType *type, unsigned gen) {
  if (!type->kind) return;
  ScrCycLevelStat *k = &scr_cyc_kind(type->kind)->level[gen];
  if (++k->walked == SCR_CYC_BYPASS_WINDOW) {
#if SCR_CYC_INLINE_BUFFERING
    bool before = k->bypass != 0;
#endif
    k->bypass = k->freed * SCR_CYC_BYPASS_RATIO < SCR_CYC_BYPASS_WINDOW
                    ? SCR_CYC_BYPASS_WINDOW * SCR_CYC_BYPASS_PROBE
                    : 0;
#if SCR_CYC_INLINE_BUFFERING
    if (gen == SCR_CYC_NURSERY && before != (k->bypass != 0))
      scr_cyc_nursery_bypassing += before ? (size_t)-1 : 1;
#endif
    k->walked = k->freed = 0;
  }
}
/* A pass at `gen` (nursery or mature) frees an object of `type`. */
static inline void scr_cyc_freed(const ScrCycType *type, unsigned gen) {
  if (type->kind) scr_cyc_kind(type->kind)->level[gen].freed++;
}

/* An inline append (scr_rc.h) leaves every nursery candidate in the nursery
 * buffer, including one whose type bypasses the nursery, which
 * scr_cyc_on_release would have buffered past it. Where a candidate waits
 * matters only once something reads the buffers, so every scheduling
 * decision and every pass first moves such candidates to the generation
 * scr_cyc_on_release would have chosen, consuming the bypass counts as it
 * would have, in buffer order. Candidates that scr_cyc_on_release buffered
 * already passed the same test with the counts unchanged since (they only
 * change during passes), so they stay. */
static SCR_CYC_COMPACT void scr_cyc_route_bypassed(void) {
#if SCR_CYC_INLINE_BUFFERING
  if (scr_cyc_nursery_bypassing == 0) return;
  ScrVec *nursery = &scr_roots[SCR_CYC_NURSERY];
  for (size_t i = 0; i < nursery->n;) {
    void *obj = nursery->v[i];
    ScrCycHdr *h = scr_cyc_hdr(obj);
    unsigned gen = scr_cyc_buffer_gen(scr_cyc_type(h), SCR_CYC_NURSERY);
    if (gen == SCR_CYC_NURSERY) {
      i++;
      continue;
    }
    void *last = nursery->v[--nursery->n];
    nursery->v[i] = last;
    if (last != obj) scr_cyc_set_buffered(scr_cyc_hdr(last), (uint32_t)i);
    scr_cyc_set_gen(h, gen);
    ScrVec *b = &scr_roots[gen];
    if (b->n == b->cap) scr_cyc_grow(b);
    scr_cyc_set_buffered(h, (uint32_t)b->n);
    b->v[b->n++] = obj;
  }
  scr_cyc_window_update();
#endif
}

void scr_cyc_on_dead(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (!scr_cyc_is_buffered(h)) return;
#ifdef SCR_YIN
  /* A young object leaves the nursery; nothing else lists it. */
  if (scr_cyc_gen(h) == SCR_CYC_YOUNG) {
    scr_yin_leave(h, obj);
    return;
  }
#endif
  /* O(1) removal: swap the last entry into the hole. A buffered object's
   * generation never changes (promotion runs only on objects the pass has
   * already drained from the buffers), so `gen` names the right one. */
  ScrVec *b = &scr_roots[scr_cyc_gen(h)];
  size_t i = scr_cyc_buf_index(h);
  void *last = b->v[--b->n];
  b->v[i] = last;
  if (last != obj) scr_cyc_set_buffered(scr_cyc_hdr(last), (uint32_t)i);
  scr_cyc_clear_buffered(h);
  /* A death must not consume room reserved for a future candidate. */
  scr_cyc_trigger--;
  /* An older death lowers the older count with the trigger: the window
   * stays. A nursery death lowers only the trigger. */
  if (scr_cyc_gen(h) == SCR_CYC_NURSERY) scr_cyc_window_shrink();
  else if (!scr_cyc_older_backlog()) scr_cyc_scheduled_mature_age = 0;
}

/* Publication (scr_publish.c) takes buffered objects out of their candidate
 * buffers while it walks them, when their headers are in cache: the slot is
 * cleared, the header unbuffered and the slot's index recorded in
 * scr_pub_holes. Nothing buffers or collects during the walk, so the slots
 * stay where they are until the publish ends and scr_cyc_pub_fill closes
 * the ones still empty. A refused publish first puts each object back
 * (scr_cyc_pub_restore). */
#ifndef SCR_WORKERS
static SCR_TL ScrVec scr_pub_holes[SCR_CYC_NGENS];
#endif

uint32_t scr_cyc_pub_take(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
#ifdef SCR_YIN
  /* A young object (its header reads as buffered) leaves the nursery,
   * unbuffered: young objects never become immortal in the nursery, and so
   * never reach another thread from it. The answer UINT32_MAX makes
   * scr_pub_mark's recorded position 0 ("not taken"), so a refused publish
   * leaves it out of every buffer, as it was. It is reachable from the
   * graph being published, so it needs no candidate. */
  if (scr_cyc_gen(h) == SCR_CYC_YOUNG) {
    scr_yin_leave(h, obj);
    return UINT32_MAX;
  }
#endif
  unsigned gen = scr_cyc_gen(h);
  uint32_t index = scr_cyc_buf_index(h);
  scr_roots[gen].v[index] = NULL;
  scr_cyc_clear_buffered(h);
  scr_cyc_push(&scr_pub_holes[gen], (void *)(uintptr_t)index);
  return index;
}

void scr_cyc_pub_restore(void *obj, uint32_t index) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  scr_cyc_set_buffered(h, index);
  scr_roots[scr_cyc_gen(h)].v[index] = obj;
}

/* Each empty slot takes the buffer's last entry, after the empty slots at
 * the end are dropped: one move or drop per slot, with scr_cyc_on_dead's
 * accounting for each. */
void scr_cyc_pub_fill(void) {
  bool older = false;
  for (unsigned gen = 0; gen < SCR_CYC_NGENS; gen++) {
    ScrVec *holes = &scr_pub_holes[gen], *b = &scr_roots[gen];
    size_t before = b->n;
    for (size_t k = 0; k < holes->n; k++) {
      size_t i = (uintptr_t)holes->v[k];
      while (b->n > 0 && b->v[b->n - 1] == NULL) b->n--;
      if (i < b->n && b->v[i] == NULL) {
        void *last = b->v[--b->n];
        b->v[i] = last;
        scr_cyc_set_buffered(scr_cyc_hdr(last), (uint32_t)i);
      }
    }
    holes->n = 0;
    size_t closed = before - b->n;
    /* A death must not consume room reserved for a future candidate. */
    scr_cyc_trigger -= closed;
    if (closed && gen != SCR_CYC_NURSERY) older = true;
  }
  if (older && !scr_cyc_older_backlog()) scr_cyc_scheduled_mature_age = 0;
  scr_cyc_window_update();
}

/* Every release that leaves an unbuffered object alive lands here (the
 * emitted and inline release paths test `buffered` first) unless the window
 * let it append a nursery candidate on its own fast path (scr_rc.h), so it
 * stays what it has always been: the same append, then buffer and compare. */
void scr_cyc_on_release(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  /* Releasing an existing candidate cannot advance the trigger. A pass
   * always re-arms after its teardowns, including any candidates they add. */
  if (scr_cyc_release_done(h)) return;
  /* An object without cycle-capable children whose SCR_CYC_ACYCLIC a pass
   * or the young-in nursery replaced gets it back. */
  if (scr_cyc_type(h)->trace == scr_cyc_no_children) {
    h->buf = SCR_CYC_ACYCLIC;
    return;
  }
#if SCR_CYC_INLINE_BUFFERING
  if (scr_cyc_append(h, obj)) return;
#endif
  if (scr_cyc_gen(h) < SCR_CYC_OLD) scr_cyc_set_gen(h, scr_cyc_buffer_gen(scr_cyc_type(h), scr_cyc_gen(h)));
  unsigned gen = scr_cyc_gen(h);
  ScrVec *b = &scr_roots[gen];
  if (b->n == b->cap) {
    scr_cyc_grow(b);
    scr_cyc_window_update();
  }
  scr_cyc_set_buffered(h, (uint32_t)b->n);
  b->v[b->n++] = obj;
  if (gen != SCR_CYC_NURSERY) scr_cyc_window_shrink();
  /* Never re-entered: a teardown's releases of untraced children can buffer
   * new candidates mid-collection, but they only wait for the next pass. */
  if (!scr_collecting && (scr_cyc_buffered() >= scr_cyc_trigger || scr_cyc_live >= scr_cyc_alloc_trigger))
    scr_cyc_collect_due();
}

/* ── trial deletion ───────────────────────────────────────────────────── */

/* Child filter shared by every phase — and it MUST be shared by every
 * phase: scan restores exactly the trial decrements markGray made, so the
 * two must agree on which edges are internal. Nothing to do for NULL
 * (unassigned slots), immortal (interned statics have no header at all), or
 * a generation this pass does not collect. */
#ifdef SCR_YIN
/* Trial deletion walks a young object as a nursery-level one: structures
 * that mix young objects with families that are not young (arrays,
 * closures) are found by the candidates of the latter, exactly as before.
 * A young survivor stays young (scan_black promotes only below OLD) and a
 * young member of the dead set leaves the nursery before its teardown. */
#define SCR_CYC_WALK_GEN(h) (scr_cyc_gen(h) == SCR_CYC_YOUNG ? SCR_CYC_NURSERY : scr_cyc_gen(h))
#else
#define SCR_CYC_WALK_GEN(h) scr_cyc_gen(h)
#endif
#define SCR_CYC_SKIP(child)                     \
  ((child) == NULL || SCR_RC(child) == SCR_RC_IMMORTAL \
   || SCR_CYC_WALK_GEN(scr_cyc_hdr(child)) > scr_gen_limit)

/* The walks are depth-first and recursive up to SCR_CYC_WALK_DEPTH, where
 * an object is queued instead (scr_pending, or scr_restore_pending for the
 * restoration, which can run inside scan) and traced from the queue. Trace
 * callbacks forward that integer depth through their opaque context; it is
 * never dereferenced. */
#define SCR_CYC_WALK_DEPTH 64

/* A walk visits a dense cycle-capable array's children itself: the present
 * dense elements, which are all scr_arr_trace_v visits when the array has
 * no sparse entries, properties or metadata (no `ext`). Each walk gets its
 * own copy, out of line, so the per-edge visitors stay small. */
#define SCR_CYC_ARRAY_WALK(name, visit)                                  \
  static __attribute__((noinline)) void name(const ScrArr *arr, void *ctx) { \
    size_t end = arr->len < arr->cap ? arr->len : arr->cap;               \
    const uint8_t *states = scr_arr_scan_states(arr);                     \
    size_t filled = !states || arr->filled > end ? end : arr->filled;     \
    for (size_t i = 0; i < filled; i++) visit((void *)(uintptr_t)arr->data[i], ctx); \
    for (size_t i = filled; i < end; i++)                                 \
      if (*scr_arr_state_in(states, i) == SCR_ARR_VALUE)                   \
        visit((void *)(uintptr_t)arr->data[i], ctx);                      \
  }

/* Visit every child of `obj` with VISIT, through ARRAY_WALK for a dense
 * cycle-capable array and through the type's trace otherwise. An empty
 * dense array has no children to visit, and ARRAY_WALK is not called. */
#define SCR_CYC_CHILDREN(obj, type, ARRAY_WALK, VISIT, depth)                         \
  do {                                                                                \
    if ((type)->kind == SCR_CYC_KIND_ARRAY &&                                         \
        !(((const ScrArr *)(obj))->spare & SCR_ARR_HAS_EXT)) {                        \
      if (((const ScrArr *)(obj))->len != 0)                                          \
        ARRAY_WALK((const ScrArr *)(obj), (void *)(depth));                           \
    } else {                                                                          \
      (type)->trace((obj), (VISIT), (void *)(depth));                                 \
    }                                                                                 \
  } while (0)

static void scr_mg_visit(void *child, void *ctx);
static void scr_sb_visit(void *child, void *ctx);
static void scr_scan_visit(void *child, void *ctx);
SCR_CYC_ARRAY_WALK(scr_mg_array, scr_mg_visit)
SCR_CYC_ARRAY_WALK(scr_sb_array, scr_sb_visit)
SCR_CYC_ARRAY_WALK(scr_scan_array, scr_scan_visit)

static inline __attribute__((always_inline)) void scr_mark_gray(void *obj, uintptr_t depth);
/* An edge into a generation this pass does not walk, for settle. */
static __attribute__((noinline)) void scr_mg_skip_edge(void *child) {
  scr_cyc_push_work(&scr_xgen_edges, scr_gray_holder);
  scr_cyc_push_work(&scr_xgen_edges, child);
}
/* The first visit of an object: gray it and walk its children. */
static __attribute__((noinline)) void scr_mg_first(void *child, void *ctx) {
  scr_mark_gray(child, (uintptr_t)ctx);
}
/* Most edges end at an object that is skipped or gray already. Those
 * return without a stack frame; the other two cases tail-call out of
 * line. */
static void scr_mg_visit(void *child, void *ctx) {
  if (child == NULL || SCR_RC(child) == SCR_RC_IMMORTAL) return;
  ScrCycHdr *h = scr_cyc_hdr(child);
  if (SCR_CYC_WALK_GEN(h) > scr_gen_limit) {
    scr_mg_skip_edge(child);
    return;
  }
  --SCR_RC(child);
  size_t rc = SCR_RC_REFS(child);
  if (scr_cyc_color(h) == SCR_CYC_GRAY) {
    if (rc == 0) {
      scr_gray_referenced--;
      if (h->buf == scr_gray_comp) scr_comp_referenced--;
    }
    return;
  }
  scr_mg_first(child, ctx);
}
/* markGray reaches `obj` (its count already trial-decremented): gray it,
 * number it with the walk's component, record it, count it while it is
 * externally referenced, and walk its children. */
static inline __attribute__((always_inline)) void scr_mark_gray(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  scr_cyc_set_color(h, SCR_CYC_GRAY);
  /* A full pass takes every buffer, so each buffered object it reaches
   * leaves its buffer here, in the header write that numbers it anyway. A
   * limited pass can gray candidates it did not take; they keep their
   * buffer position and are simply never counted as members. */
  if (!scr_cyc_is_buffered(h) || (scr_gen_limit == SCR_CYC_OLD && !scr_cyc_take
#ifdef SCR_YIN
                                    /* a young object's `buf` is its nursery index */
                                    && scr_cyc_gen(h) != SCR_CYC_YOUNG
#endif
                                    ))
    h->buf = scr_gray_comp;
  if (scr_white.n < SCR_CYC_GRAY_LIST_MAX) scr_cyc_push_gray(&scr_white, obj);
  if (SCR_RC_REFS(obj) > 0) {
    scr_gray_referenced++;
    scr_comp_referenced++;
  }
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push_work(&scr_pending, obj);
    return;
  }
  void *holder = scr_gray_holder;
  scr_gray_holder = obj;
  const ScrCycType *type = scr_cyc_type(h);
  SCR_CYC_CHILDREN(obj, type, scr_mg_array, scr_mg_visit, depth + 1);
  scr_gray_holder = holder;
}
/* markGray from one (black) candidate, through the queue. */
static void scr_mark_gray_from(void *root) {
  scr_mark_gray(root, 0);
  while (scr_pending.n) {
    void *obj = scr_pending.v[--scr_pending.n];
    const ScrCycType *type = scr_cyc_type(scr_cyc_hdr(obj));
    scr_gray_holder = obj;
    SCR_CYC_CHILDREN(obj, type, scr_mg_array, scr_mg_visit, 1);
  }
}

/* scan's restoration: blacken an externally referenced object and
 * everything it reaches that is not black yet, giving back the trial
 * decrements of the edges it follows. */
static void scr_scan_black(void *obj, uintptr_t depth);
static void scr_sb_visit(void *child, void *ctx) {
  if (SCR_CYC_SKIP(child)) return;
  SCR_RC(child) += 1;
  if (scr_cyc_color(scr_cyc_hdr(child)) != SCR_CYC_BLACK)
    scr_scan_black(child, (uintptr_t)ctx);
}
static void scr_scan_black(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  scr_cyc_set_color(h, SCR_CYC_BLACK);
  /* Drop markGray's component number: a survivor leaves the pass unbuffered
   * unless it is a candidate that a limited pass did not take, and one
   * without cycle-capable children leaves it SCR_CYC_ACYCLIC again. */
  const ScrCycType *type = scr_cyc_type(h);
  bool acyclic = type->trace == scr_cyc_no_children;
  /* A candidate left buffered by a limited pass must keep the generation
   * its buffer slot belongs to. */
  if (!scr_cyc_is_buffered(h)) {
    h->buf = acyclic ? SCR_CYC_ACYCLIC : 0;
    if (scr_cyc_gen(h) < SCR_CYC_OLD) scr_cyc_push_work(&scr_promote, obj);
  }
  if (acyclic) return;
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push_work(&scr_restore_pending, obj);
    return;
  }
  SCR_CYC_CHILDREN(obj, type, scr_sb_array, scr_sb_visit, depth + 1);
}
static void scr_restore_from(void *root) {
  scr_scan_black(root, 0);
  while (scr_restore_pending.n) {
    void *obj = scr_restore_pending.v[--scr_restore_pending.n];
    const ScrCycType *type = scr_cyc_type(scr_cyc_hdr(obj));
    SCR_CYC_CHILDREN(obj, type, scr_sb_array, scr_sb_visit, 1);
  }
}

/* scan, walking: restore a gray object that is externally referenced, else
 * whiten it, record it once (a later outside root can still restore it;
 * settle filters the list) and walk its children. */
static void scr_scan(void *obj, uintptr_t depth);
static void scr_scan_visit(void *child, void *ctx) {
  if (SCR_CYC_SKIP(child)) return;
  scr_scan(child, (uintptr_t)ctx);
}
static void scr_scan(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (scr_cyc_color(h) != SCR_CYC_GRAY) return;
  if (SCR_RC_REFS(obj) > 0) {
    scr_restore_from(obj);
    return;
  }
  scr_cyc_set_color(h, SCR_CYC_WHITE);
  scr_cyc_push_work(&scr_white, obj);
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push_work(&scr_pending, obj);
    return;
  }
  const ScrCycType *type = scr_cyc_type(h);
  SCR_CYC_CHILDREN(obj, type, scr_scan_array, scr_scan_visit, depth + 1);
}

/* ── cross-generation edges ───────────────────────────────────────────── */

/* A restricted pass leaves one edge unaccounted, and it is the one edge that
 * nothing else accounts either. markGray does not trial-delete an edge into a
 * generation it refused to walk (SCR_CYC_SKIP), and the teardown contract has
 * free_fn release exactly the UNTRACED children — because every traced edge
 * was supposed to have been decremented by markGray. So when a white object
 * holds a traced edge into an older generation, freeing it drops the edge
 * while the target keeps the count: a phantom reference that reads as an
 * external one to every later pass, full ones included. The target and
 * everything under it would never be reclaimable again.
 *
 * So the white set pays those edges off explicitly. The walk cannot do it
 * inline — a release there could free a survivor that scr_promote still
 * points at, or cascade into the white set mid-teardown — so it runs in two
 * halves: PIN each target with a retain while `gen` still holds walk-time
 * values, then DROP THE PIN AND GIVE UP THE EDGE after the teardowns, when
 * generations have settled and the white set is gone. Two decrements per
 * entry, because the pin is one of them — a single release would only undo
 * the pin and leave the phantom edge exactly where it was. The pin is what
 * makes the second decrement safe: a teardown's releases of untraced
 * children can reach a cycle-headered object (that is how they re-buffer
 * survivors), so without it a target could be freed before the drain runs.
 *
 * markGray records each such edge as it skips it (scr_xgen_edges), so the
 * white set needs no second trace to find them: settle pins the targets of
 * the recorded edges whose holder is about to be freed. One entry per
 * skipped edge, so several edges sharing a target settle it once each.
 *
 * Nothing pinned here can be in the white set: a skipped older object's
 * edges were never trial-deleted, so anything it references kept that count
 * and was scan-blacked rather than whitened — the same conservatism that
 * makes restricting the walk sound in the first place. */
/* Freed by the cross-generation drain, for the caller's fixpoint. */
#ifndef SCR_WORKERS
static SCR_TL size_t scr_xg_freed = 0;
#endif

static void scr_xg_release(void *obj);
static void scr_xg_child_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SCR_RC_IMMORTAL) return;
  scr_xg_release(child);
}

/* One genuine release, generically: the header carries everything needed. */
static void scr_xg_destroy(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  scr_cyc_type(h)->trace(obj, scr_xg_child_visit, NULL);
  scr_cyc_type(h)->free_fn(obj);
  scr_xg_freed++;
}

static SCR_CYC_COMPACT void scr_xg_release(void *obj) {
  if (SCR_RC_REFS(obj) > 1) {
    SCR_RC(obj) -= 1;
    scr_cyc_on_release(obj); /* lost a reference: a possible cycle root */
    return;
  }
  SCR_RC(obj) = 0;
  scr_cyc_on_dead(obj); /* out of its candidate buffer before the block goes */
  scr_rc_destroy(obj, scr_xg_destroy);
}

/* A work vector that holds more than this many entries is freed at the end
 * of a pass that used less than a quarter of it, so a spike in one pass
 * does not keep its buffers for the rest of the program, while passes of a
 * steady size keep reusing theirs. */
#define SCR_CYC_KEEP_VECTOR 65536

static SCR_CYC_COMPACT void scr_cyc_trim_free(ScrVec *vec) {
  free(vec->v);
  vec->v = NULL;
  vec->cap = 0;
}
/* Every pass ends by trimming its work vectors, and most of them stay
 * small: only the capacity test runs inline. */
static inline void scr_cyc_trim(ScrVec *vec) {
  if (vec->cap > SCR_CYC_KEEP_VECTOR && vec->n == 0 && vec->used < vec->cap / 4)
    scr_cyc_trim_free(vec);
  vec->used = 0;
}

#ifdef SCR_YIN
/* ── young-in nursery ─────────────────────────────────────────────────── */

/* Programs built with the young-in nursery (SCRIPTC_YOUNG_NURSERY=1, which
 * links this unit built with SCR_YIN) allocate compiled class and record
 * instances YOUNG: the emitted constructor hands each new object to
 * scr_yin_enter, which lists it in the nursery and marks its header
 * SCR_CYC_YOUNG with its nursery index in `buf`, under the buffered bit.
 * The bit makes every release path treat the object as an existing
 * candidate: a release that leaves it alive makes no call, and its death
 * calls scr_cyc_on_dead, which takes it out of the nursery
 * (scr_yin_leave) before the teardown runs. Young objects are never
 * candidates, but trial deletion walks them as nursery-level objects when
 * a candidate reaches them (SCR_CYC_WALK_GEN).
 *
 * Whenever the nursery holds SCR_YOUNG_NURSERY_SIZE live objects (4096 by
 * default), at collection points and before every full sweep, the nursery
 * is collected on its own, in time proportional to its size and without
 * walking anything older:
 *   count    for every young object, the references to it from traced
 *            fields of other young objects (one trace per young object);
 *   mark     an object whose count is below its reference count is
 *            referenced from outside the nursery (a stack, a global, an
 *            older object, a runtime structure, FFI, a fiber or a coroutine
 *            frame: every one of them holds a counted reference); mark
 *            from each such object through young edges;
 *   sweep    what is unmarked is referenced only from unmarked young
 *            objects, which is garbage. Marked objects join trial
 *            deletion's nursery generation, unbuffered; dead ones are torn
 *            down, giving up only the edges that leave the dead set (like
 *            the white set's cross-generation edges, after every teardown).
 * Survivors go to trial deletion's nursery rather than past it because the
 * structures that survive are mostly held by families that are not young
 * (arrays, closures, maps): a dead tree whose nodes are young and whose
 * child arrays are not survives the nursery collection through the
 * arrays, and the arrays' own candidates reach it there.
 * Soundness rests on the two invariants trial deletion already needs: every
 * strong reference is counted, and a trace visits exactly the counted
 * references to headered children. The counts are recomputed at every
 * collection, so no store barrier is needed and none can be missed.
 *
 * Candidates. A release of a young object never buffers it, so a structure
 * whose last outside reference was dropped while its root was young has no
 * candidate, and when the structure reaches beyond the nursery (a young
 * node in an array that is not young, say), the nursery collection sees
 * the outside edge as a root and keeps it. So every outside root a
 * collection finds (count below the reference count) becomes a candidate
 * as it is promoted. That suffices: every survivor is reachable from such
 * a root, so if a survivor was already garbage, so was its root, and trial
 * deletion reaches the survivor from the root's candidate; garbage formed
 * after the promotion has a candidate from the release that formed it,
 * since survivors are no longer young. */
#define SCR_YIN_DEFAULT_SIZE 4096
#define SCR_CYC_YIN_PROMOTED SCR_CYC_NURSERY

/* Pushes onto the collection's work vectors, inline. */
static inline __attribute__((always_inline)) void scr_yin_push(ScrVec *vec, void *obj) {
  if (__builtin_expect(vec->n == vec->cap, 0)) scr_cyc_grow(vec);
  vec->v[vec->n++] = obj;
  if (vec->n > vec->used) vec->used = vec->n;
}
#define SCR_YIN_MAX_SIZE ((size_t)1 << 30)

static size_t scr_yin_size(void) {
  static SCR_TL size_t cached = 0;
  if (cached == 0) {
    const char *env = scr_getenv("SCR_YOUNG_NURSERY_SIZE");
    long v = env ? strtol(env, NULL, 10) : 0;
    cached = v > 0 ? ((size_t)v < SCR_YIN_MAX_SIZE ? (size_t)v : SCR_YIN_MAX_SIZE)
                   : SCR_YIN_DEFAULT_SIZE;
  }
  return cached;
}

/* Collections, survivors and dead objects, printed at exit with
 * SCR_YOUNG_NURSERY_STATS=1 (measurement). */
static SCR_TL size_t scr_yin_stat[3];
static void scr_yin_stats_print(void) {
  fprintf(stderr, "scriptc young nursery: %zu collections, %zu survivors, %zu dead\n",
          scr_yin_stat[0], scr_yin_stat[1], scr_yin_stat[2]);
}

/* Types that do not die in young cycles. Only a young object that dies in
 * a nursery collection gains anything there; every other one costs: one
 * that dies by reference counting makes a call to leave the nursery (where
 * it made none before), one that is published is moved out of it, and one
 * that survives a collection is kept by it, and becomes a trial-deletion
 * candidate when an outside reference holds it. Structures held by
 * families that are not young (tree nodes in child arrays, objects
 * captured by closures) survive, and plain data dies by reference counting.
 * So each thread keeps, per registry id, how many of the type's young
 * objects left the nursery (by a collection or otherwise) and how many of
 * them a collection freed, and after SCR_YIN_WINDOW of them a type freed
 * for fewer than one in SCR_YIN_RATIO is allocated as before (trial
 * deletion's nursery) for its next SCR_YIN_PROBE allocations, then
 * enters again for a fresh window: the same bypass-and-probe scheme as the
 * levels' bypass above. The countdown
 * (scr_yin_skip, an ABI: emitted constructors test and decrement it
 * inline) only steers which objects enter the nursery. */
#define SCR_YIN_WINDOW 1024
#define SCR_YIN_RATIO 4
#define SCR_YIN_PROBE (64 * SCR_YIN_WINDOW)
#ifdef SCR_WORKERS
static _Thread_local uint32_t *scr_yin_skip_tl;
static uint32_t *scr_yin_skip_table(void) {
  if (!scr_yin_skip_tl) {
    scr_yin_skip_tl = calloc(SCR_CYC_MAX_TYPES, sizeof *scr_yin_skip_tl);
    if (!scr_yin_skip_tl) scr_cyc_oom();
  }
  return scr_yin_skip_tl;
}
#else
uint32_t scr_yin_skip[SCR_CYC_MAX_TYPES] = {0};
static uint32_t *scr_yin_skip_table(void) { return scr_yin_skip; }
#endif
typedef struct {
  uint32_t met, freed;
} ScrYinType;
/* SCR_YOUNG_NURSERY_ALL=1 keeps every type young (test lanes). */
static bool scr_yin_all(void) {
  static SCR_TL int cached = -1;
  if (cached < 0) {
    const char *env = scr_getenv("SCR_YOUNG_NURSERY_ALL");
    cached = env != NULL && env[0] == '1';
  }
  return cached != 0;
}
static SCR_TL ScrYinType *scr_yin_types;

static __attribute__((noinline, cold)) void scr_yin_decide(uint16_t id, ScrYinType *t) {
  if (t->freed * SCR_YIN_RATIO < t->met && !scr_yin_all()) scr_yin_skip_table()[id] = SCR_YIN_PROBE;
  t->met = t->freed = 0;
}
static inline __attribute__((always_inline)) void scr_yin_met(uint16_t id, bool dead) {
  ScrYinType *t = &scr_yin_types[id];
  t->freed += dead;
  if (__builtin_expect(++t->met >= SCR_YIN_WINDOW, 0)) scr_yin_decide(id, t);
}

void scr_yin_enter_slow(void *obj);

/* The whole nursery entry, for targets whose constructors call it. */
void scr_yin_enter(void *obj) {
  uint32_t *skip = &scr_yin_skip_table()[scr_cyc_hdr(obj)->id];
  if (*skip != 0) {
    --*skip;
    return;
  }
  scr_yin_enter_slow(obj);
}

/* The slow half of the nursery entry (the emitted constructors inline the
 * rest: skip, or append while n < lim). The nursery holds at most
 * SCR_YOUNG_NURSERY_SIZE live young objects: the object that would exceed
 * that collects the nursery first, then enters. */
void scr_yin_enter_slow(void *obj) {
  size_t size = scr_yin_size();
  if (!scr_yin_types) {
    scr_yin_types = calloc(SCR_CYC_MAX_TYPES, sizeof *scr_yin_types);
    if (!scr_yin_types) scr_cyc_oom();
  }
  if (scr_yin.n >= size) {
    static SCR_TL bool stats_checked = false;
    if (!stats_checked) {
      stats_checked = true;
      const char *env = scr_getenv("SCR_YOUNG_NURSERY_STATS");
      if (env && env[0] == '1') atexit(scr_yin_stats_print);
    }
    scr_yin_collect();
  }
  if (scr_yin.n == scr_yin.cap) {
    /* Positions are 31-bit (ScrCycHdr.buf); the size is capped below. */
    size_t cap = scr_yin.cap ? scr_yin.cap * 2 : 1024;
    void **grown = realloc(scr_yin.v, cap * sizeof *grown);
    if (!grown) scr_cyc_oom();
    scr_yin.v = grown;
    scr_yin.cap = cap;
  }
  scr_yin.lim = scr_yin.cap < size ? scr_yin.cap : size;
  ScrCycHdr *h = scr_cyc_hdr(obj);
  scr_cyc_set_gen(h, SCR_CYC_YOUNG);
  scr_cyc_set_buffered(h, (uint32_t)scr_yin.n);
  scr_yin.v[scr_yin.n++] = obj;
}

/* O(1) removal: the last young object takes the hole. */
static void scr_yin_leave(ScrCycHdr *h, void *obj) {
  size_t i = scr_cyc_buf_index(h);
#ifdef SCR_RC_AUDIT
  if (i >= scr_yin.n || scr_yin.v[i] != obj) scr_trap("scriptc: young object outside the nursery\n");
#endif
  void *last = scr_yin.v[--scr_yin.n];
  scr_yin.v[i] = last;
  if (last != obj) scr_cyc_set_buffered(scr_cyc_hdr(last), (uint32_t)i);
  scr_cyc_clear_buffered(h);
  scr_cyc_set_gen(h, SCR_CYC_NURSERY);
  scr_yin_met(h->id, false);
}

static void scr_yin_count_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SCR_RC_IMMORTAL) return;
  ScrCycHdr *h = scr_cyc_hdr(child);
  if (scr_cyc_gen(h) == SCR_CYC_YOUNG) scr_yin_counts[scr_cyc_buf_index(h)]++;
}

/* Marked young objects are GRAY (young objects are otherwise BLACK). */
static void scr_yin_mark_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SCR_RC_IMMORTAL) return;
  ScrCycHdr *h = scr_cyc_hdr(child);
  if (scr_cyc_gen(h) != SCR_CYC_YOUNG || scr_cyc_color(h) == SCR_CYC_GRAY) return;
  scr_cyc_set_color(h, SCR_CYC_GRAY);
  scr_yin_push(&scr_yin_stack, child);
}

/* A dead object's edge: young and unmarked is dead too (nothing to give
 * up); a marked young object (promoted now or soon) or an older one keeps
 * the count until every teardown has run. */
static void scr_yin_dead_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SCR_RC_IMMORTAL) return;
  ScrCycHdr *h = scr_cyc_hdr(child);
  if (scr_cyc_gen(h) == SCR_CYC_YOUNG && scr_cyc_color(h) != SCR_CYC_GRAY) return;
  scr_yin_push(&scr_yin_xrel, child);
}

/* Fully optimized, unlike trial deletion's per-pass bookkeeping: its loops
 * run once per young object. */
static __attribute__((noinline)) size_t scr_yin_collect(void) {
  if (scr_yin_busy || scr_collecting) return 0;
  size_t n = scr_yin.n;
  if (n == 0) return 0;
  /* What died outside passes so far counts toward the death rule; what this
   * collection frees does not (the reading is refreshed at its end). */
  scr_cyc_note_fall();
  scr_yin_busy = true;
  /* Releases made by teardowns below buffer candidates but must not start
   * a trial-deletion pass while the dead set is half torn down, and take
   * the call, as during a pass (scr_cyc_window_update). */
  scr_collecting = true;
  scr_cyc_window_update();
  if (n > scr_yin_counts_cap) {
    size_t cap = scr_yin_counts_cap ? scr_yin_counts_cap * 2 : 1024;
    while (cap < n) cap *= 2;
    uint32_t *counts = realloc(scr_yin_counts, cap * sizeof *counts);
    if (!counts) scr_cyc_oom();
    scr_yin_counts = counts;
    scr_yin_counts_cap = cap;
  }
  memset(scr_yin_counts, 0, n * sizeof *scr_yin_counts);
  void **v = scr_yin.v;
  for (size_t k = 0; k < n; k++)
    scr_cyc_type(scr_cyc_hdr(v[k]))->trace(v[k], scr_yin_count_visit, NULL);
#ifdef SCR_RC_AUDIT
  /* Membership and counts: every listed object is young at its index and
   * alive, and holds at least the references young objects make to it
   * (fewer would mean an uncounted reference). */
  for (size_t k = 0; k < n; k++) {
    ScrCycHdr *h = scr_cyc_hdr(v[k]);
    if (scr_cyc_gen(h) != SCR_CYC_YOUNG || !scr_cyc_is_buffered(h) || scr_cyc_buf_index(h) != k ||
        scr_cyc_color(h) != SCR_CYC_BLACK)
      scr_trap("scriptc: corrupt young nursery entry\n");
    if (SCR_RC_REFS(v[k]) == 0 || SCR_RC_REFS(v[k]) < scr_yin_counts[k])
      scr_trap("scriptc: young object with uncounted references\n");
  }
#endif
  for (size_t k = 0; k < n; k++) {
    void *obj = v[k];
    ScrCycHdr *h = scr_cyc_hdr(obj);
    if (scr_cyc_color(h) == SCR_CYC_GRAY || SCR_RC_REFS(obj) <= scr_yin_counts[k]) continue;
    scr_cyc_set_color(h, SCR_CYC_GRAY);
    scr_yin_push(&scr_yin_stack, obj);
    while (scr_yin_stack.n) {
      void *x = scr_yin_stack.v[--scr_yin_stack.n];
      scr_cyc_type(scr_cyc_hdr(x))->trace(x, scr_yin_mark_visit, NULL);
    }
  }
  /* Split: promote the marked objects; record the dead ones and their
   * edges to survivors and older objects, which are given up after every
   * teardown (until then each holds the count it was made with, so no
   * teardown's releases can free a target early). Edges between dead
   * objects need nothing: both go. No block is freed before every dead
   * object has been traced. */
  scr_yin_dead.n = 0;
  scr_yin_xrel.n = 0;
  for (size_t k = 0; k < n; k++) {
    void *obj = v[k];
    ScrCycHdr *h = scr_cyc_hdr(obj);
    if (scr_cyc_color(h) == SCR_CYC_GRAY) {
      scr_cyc_set_color(h, SCR_CYC_BLACK);
      scr_cyc_set_gen(h, SCR_CYC_YIN_PROMOTED);
      scr_cyc_clear_buffered(h);
      /* An outside root becomes a candidate (see "candidates" above). */
      if (SCR_RC_REFS(obj) > scr_yin_counts[k]) scr_cyc_on_release(obj);
      scr_yin_met(h->id, false);
    } else {
      scr_yin_met(h->id, true);
      scr_cyc_set_color(h, SCR_CYC_DOOMED);
      scr_yin_push(&scr_yin_dead, obj);
      scr_cyc_type(h)->trace(obj, scr_yin_dead_visit, NULL);
    }
  }
  scr_yin.n = 0;
  scr_yin_stat[0]++;
  scr_yin_stat[1] += n - scr_yin_dead.n;
  scr_yin_stat[2] += scr_yin_dead.n;
  size_t freed = scr_yin_dead.n;
  for (size_t i = 0; i < scr_yin_dead.n; i++) {
    void *obj = scr_yin_dead.v[i];
    scr_cyc_type(scr_cyc_hdr(obj))->free_fn(obj);
  }
  scr_yin_dead.n = 0;
  scr_xg_freed = 0;
  for (size_t i = 0; i < scr_yin_xrel.n; i++) scr_xg_release(scr_yin_xrel.v[i]);
  freed += scr_xg_freed;
  scr_yin_xrel.n = 0;
  scr_cyc_trim(&scr_yin_stack);
  scr_cyc_trim(&scr_yin_dead);
  scr_cyc_trim(&scr_yin_xrel);
  scr_cyc_live_seen = scr_cyc_live;
  scr_collecting = false;
  scr_cyc_window_update();
  scr_yin_busy = false;
  /* The candidates buffered above count toward trial deletion's trigger,
   * which only a release checks; a program whose releases are all of
   * young objects would otherwise never reach it. */
  if (scr_cyc_buffered() >= scr_cyc_trigger || scr_cyc_live >= scr_cyc_alloc_trigger)
    scr_cyc_collect_due();
  return freed;
}
#endif

/* Dead sets at least this large are torn down in address order. Smaller
 * ones mostly stay in cache, where ordering them costs more than it saves. */
#define SCR_CYC_ORDER_MIN 16384

/* One pass over every candidate at or below `gen_limit`; returns how many
 * objects it freed. */
/* The second half of a pass: settle the white set, promote, re-buffer,
 * tear down and re-arm. Its loops run once per candidate or dead object and
 * spend their time in the trace and teardown calls they make, so this half is
 * built for size; the graph walk above it stays fully optimized. Returns how
 * many objects the pass freed. */
static SCR_CYC_COMPACT size_t scr_cyc_settle(unsigned gen_limit, bool doomed) {
  size_t dead = 0;
  scr_cyc_mature_dead = 0;
  scr_cyc_note_used(&scr_white);
  /* The list holds the dead set: doomed components, and what scan whitened
   * (black once a later outside root restored it), or, when the pass found
   * nothing externally referenced, every gray object. `doomed` says that
   * every entry is a doomed component's already. */
  for (size_t i = 0; i < scr_white.n && !doomed; i++) {
    void *obj = scr_white.v[i];
    ScrCycHdr *h = scr_cyc_hdr(obj);
    unsigned color = scr_cyc_color(h);
    if (color == SCR_CYC_BLACK) continue;
    if (color != SCR_CYC_DOOMED) {
      /* A limited pass can reach candidates it did not take: out of their
       * buffers before they are freed. */
      if (scr_cyc_take && scr_cyc_is_buffered(h)) scr_cyc_on_dead(obj);
      scr_cyc_set_color(h, SCR_CYC_DOOMED);
    }
    scr_white.v[dead++] = obj;
  }
  if (!doomed) scr_white.n = dead;

  /* Pin the cross-generation targets of everything about to be freed, while
   * `gen` still holds the values the walk filtered on (promotion below is
   * what changes them). A full pass skips no edge, so it pins nothing. */
  scr_xgen.n = 0;
  for (size_t i = 0; i < scr_xgen_edges.n; i += 2) {
    if (scr_cyc_color(scr_cyc_hdr(scr_xgen_edges.v[i])) != SCR_CYC_DOOMED) continue;
    void *target = scr_xgen_edges.v[i + 1];
    SCR_RC(target) += 1; /* pin across the teardowns */
    scr_cyc_push_work(&scr_xgen, target);
  }
  scr_xgen_edges.n = 0;

  /* Every phase that consults SCR_CYC_SKIP has run, so the recorded
   * survivors can graduate now, one generation each. They are externally
   * referenced, so none of them is in the white set about to be freed. */
  for (size_t i = 0; i < scr_promote.n; i++) {
    ScrCycHdr *h = scr_cyc_hdr(scr_promote.v[i]);
    if (scr_cyc_gen(h) < SCR_CYC_OLD) scr_cyc_set_gen(h, scr_cyc_gen(h) + 1);
  }
  scr_promote.n = 0;

  /* A restricted pass may have spared a candidate only because the edge
   * keeping it alive came from a generation it refused to walk — the
   * deliberate conservatism above. But the candidate buffer is the ONLY
   * root set this collector has, and markRoots consumed the entry. Dropping
   * it would retire the one record that this object is a possible cycle
   * root, and a dead cycle whose members all got spared that way would
   * never be walked again by any pass, full ones included. So a restricted
   * pass hands its survivors back as candidates in the generation they were
   * just promoted into, where a later pass at that level — and in the end a
   * full pass, which skips nothing and so judges them on real reference
   * counts — will settle them. A full pass
   * needs none of this: it walked every edge, so rc > 0 there means a
   * genuine outside reference and Bacon-Rajan's own reasoning retires the
   * candidate. Re-buffering costs a walk, never correctness: an object that
   * is truly live survives the next pass at its level and is dropped then. */
  if (gen_limit < SCR_CYC_OLD) {
    for (size_t i = 0; i < scr_cands.n; i++) {
      void *obj = scr_cands.v[i];
      ScrCycHdr *h = scr_cyc_hdr(obj);
      if (scr_cyc_color(h) == SCR_CYC_DOOMED) continue; /* being freed below */
      /* A candidate without cycle-capable children was never on a cycle. */
      if (!scr_cyc_is_buffered(h) && h->buf != SCR_CYC_ACYCLIC) {
        /* A survivor promoted into a level its type bypasses moves past
         * it, as a release would buffer it. */
        if (scr_cyc_gen(h) == SCR_CYC_MATURE && scr_cyc_bypassed(scr_cyc_type(h), SCR_CYC_MATURE))
          scr_cyc_set_gen(h, SCR_CYC_OLD);
        scr_cyc_set_buffered(h, (uint32_t)scr_roots[scr_cyc_gen(h)].n);
        scr_cyc_push(&scr_roots[scr_cyc_gen(h)], obj);
      }
    }
  }

  /* Teardowns run after the full walk. They may release untraced children
   * (plain RC) — which can re-buffer survivors for the NEXT pass — but
   * never touch traced (white, already-accounted) edges.
   *
   * A large dead set is torn down in address order, highest address first
   * (scr_mem_order_for_free). The walk leaves it in graph order, in which
   * the free lists would hand its blocks to the next allocations scattered
   * over every page the dead structure used, and the structures built from
   * them, and every later walk over those, would miss the cache on most
   * objects. In address order the blocks come back in the order the bump
   * pointers hand out fresh memory. Teardown order is not observable. The
   * level statistics are counted here, where the teardown reads the type
   * anyway; they only steer later passes. */
  size_t freed = scr_white.n;
  if (scr_white.n >= SCR_CYC_ORDER_MIN)
    scr_mem_order_for_free(scr_white.v, scr_white.n, sizeof(ScrCycHdr));
  for (size_t i = 0; i < scr_white.n; i++) {
    void *obj = scr_white.v[i];
    ScrCycHdr *h = scr_cyc_hdr(obj);
    const ScrCycType *type = scr_cyc_type(h);
    if (gen_limit < SCR_CYC_OLD) scr_cyc_freed(type, gen_limit);
    else scr_cyc_mature_dead += scr_cyc_gen(h) == SCR_CYC_MATURE;
#ifdef SCR_YIN
    if (scr_cyc_gen(h) == SCR_CYC_YOUNG) scr_yin_leave(h, obj);
#endif
    type->free_fn(obj);
  }
  scr_white.n = 0;

  /* Now drain the pins: the white set is gone and generations have settled,
   * so each of those edges can be given up for real. A target that survives
   * lands back in the candidate buffer — it just lost a reference, which is
   * exactly what makes an object a possible cycle root. */
  scr_xg_freed = 0;
  for (size_t i = 0; i < scr_xgen.n; i++) {
    void *obj = scr_xgen.v[i];
    /* Drop the pin first. The phantom edge is still counted, so this cannot
     * reach zero and the release below is the one that settles the object. */
    SCR_RC(obj) -= 1;
    scr_xg_release(obj);
  }
  scr_xgen.n = 0;
  freed += scr_xg_freed;

  /* A limited pass walked only some of the candidates: the schedule's
   * baselines stay those of the last pass over them all. */
  scr_cyc_live_seen = scr_cyc_live;
  if (scr_cyc_take == NULL) {
    /* A full pass the growth rule did not choose (death, backlog, scheduled
     * age) may raise the growth baselines but not lower them. After it
     * reclaims a dropped structure, the heap regrowing to where it was is
     * the program rebuilding what it had, not growth: from the low point,
     * the next growth passes would walk the rebuilt live heap for nothing,
     * at both levels. */
    for (unsigned g = SCR_CYC_MATURE; g <= gen_limit; g++)
      if (!scr_cyc_keep_base || scr_cyc_live > scr_cyc_live_after[g]) scr_cyc_live_after[g] = scr_cyc_live;
    if (gen_limit >= SCR_CYC_OLD) {
      scr_cyc_scheduled_mature_age = 0;
      scr_cyc_fallen = 0;
      scr_cyc_death_due_live = 0;
      scr_cyc_full_after = scr_cyc_live;
    }
  }
  /* markRoots drained buffers in bulk and teardowns moved the count around;
   * resync from the buffers themselves and re-arm. */
  scr_cyc_trigger = scr_cyc_buffered() + scr_cyc_nursery_threshold();
  scr_cyc_alloc_trigger = scr_cyc_live + SCR_CYC_NURSERY_ALLOCATIONS;
  scr_collecting = false;
  scr_cyc_window_update();
  return freed;
}

/* The end of every pass. The candidate list keeps its count, which the
 * scheduler reads; its buffer goes when this pass's candidates filled
 * less than a quarter of it. */
static size_t scr_cyc_pass_done(size_t freed) {
  if (scr_cands.cap > SCR_CYC_KEEP_VECTOR && scr_cands.n < scr_cands.cap / 4) {
    free(scr_cands.v);
    scr_cands.v = NULL;
    scr_cands.cap = 0;
  }
  scr_cyc_trim(&scr_pending);
  scr_cyc_trim(&scr_white);
  scr_cyc_trim(&scr_promote);
  scr_cyc_trim(&scr_restore_pending);
  scr_cyc_trim(&scr_xgen);
  scr_cyc_trim(&scr_xgen_edges);
  scr_cyc_trim(&scr_live_ranges);
  return freed;
}

static size_t scr_cyc_pass(unsigned gen_limit) {
  if (scr_collecting) return 0;
  scr_cyc_route_bypassed();
  scr_collecting = true;
  scr_cyc_window_update();
  scr_gen_limit = gen_limit;

  /* markRoots: every buffered entry is a candidate (retains do not mark
   * candidates live; measured on the tsc-ts self-check, that filter dropped
   * almost none, and it cost a header store per retain). Drain the buffers
   * before walking: tracing only adjusts counts and worklists, so nothing
   * can re-buffer underneath us. Candidates ABOVE the limit keep their
   * slots and wait for a pass at their own level. */
  if (scr_cyc_take) {
    scr_cands.n = 0;
    /* A limited pass: only the set's candidates leave their buffers. The
     * scan reads the buffers' pointers alone, so the candidates it leaves,
     * which may be most of a large heap's, are not touched. */
    for (unsigned g = 0; g <= scr_cyc_take_gen; g++) {
      ScrVec *b = &scr_roots[g];
      for (size_t i = 0; i < b->n;) {
        void *obj = b->v[i];
        if (!scr_cyc_set_has(scr_cyc_take, obj)) {
          i++;
          continue;
        }
        void *last = b->v[--b->n];
        b->v[i] = last;
        if (last != obj) scr_cyc_set_buffered(scr_cyc_hdr(last), (uint32_t)i);
        scr_cyc_clear_buffered(scr_cyc_hdr(obj));
        scr_cyc_push(&scr_cands, obj);
      }
    }
  } else {
    /* A full pass: the fullest root buffer becomes the candidate list
     * instead of being copied into it, so a pass never holds two buffers
     * of every candidate; the generation gets the previous candidate
     * buffer, empty. The other buffers are appended after it. */
    unsigned largest = 0;
    for (unsigned g = 1; g <= gen_limit; g++)
      if (scr_roots[g].n > scr_roots[largest].n) largest = g;
    ScrVec previous = scr_cands;
    scr_cands = scr_roots[largest];
    scr_roots[largest] = previous;
    scr_roots[largest].n = 0;
    /* A full pass clears the buffered marks as markGray reaches the
     * candidates, so only a limited level's candidates are touched here. */
    if (gen_limit < SCR_CYC_OLD)
      for (size_t i = 0; i < scr_cands.n; i++) {
        ScrCycHdr *h = scr_cyc_hdr(scr_cands.v[i]);
        scr_cyc_clear_buffered(h);
        scr_cyc_walked(scr_cyc_type(h), gen_limit);
      }
  }
  for (unsigned g = 0; g <= gen_limit && !scr_cyc_take; g++) {
    for (size_t i = 0; i < scr_roots[g].n; i++) {
      void *obj = scr_roots[g].v[i];
      if (gen_limit < SCR_CYC_OLD) {
        ScrCycHdr *h = scr_cyc_hdr(obj);
        scr_cyc_clear_buffered(h);
        scr_cyc_walked(scr_cyc_type(h), gen_limit);
      }
      scr_cyc_push(&scr_cands, obj);
    }
    scr_roots[g].n = 0;
  }
  scr_xgen_edges.n = 0;
  scr_white.n = 0;
  scr_gray_referenced = 0;
  scr_live_ranges.n = 0;
  /* Components. Each candidate that no earlier walk reached starts a walk
   * of its own, and the objects that walk grays first form its component.
   * A component whose objects all end the walk at count zero is garbage:
   * a count of zero means every reference to the object was trial-deleted,
   * i.e. came from an object grayed so far. An earlier component cannot
   * hold one (the walk that grayed it would have grayed the target too),
   * so every reference comes from inside the component, and a later walk
   * cannot add one: its objects would be referencing this component, and
   * those references are still counted. scan would whiten exactly this
   * set, so it is doomed at once and scan runs only over the components
   * that are externally referenced, if any. A limited pass keeps the single
   * whole-pass decision below (its untaken candidates cannot carry the
   * component number). */
  bool split = scr_cyc_take == NULL;
  uint32_t comp = 0;
  for (size_t i = 0; i < scr_cands.n; i++) {
    void *obj = scr_cands.v[i];
    if (scr_cyc_color(scr_cyc_hdr(obj)) != SCR_CYC_BLACK) continue; /* walked already */
    size_t start = scr_white.n;
    scr_gray_comp = split ? ++comp : 0;
    scr_comp_referenced = 0;
    scr_mark_gray_from(obj);
    if (!split) continue;
    size_t end = scr_white.n;
    if (scr_comp_referenced == 0 && end < SCR_CYC_GRAY_LIST_MAX) {
      for (size_t j = start; j < end; j++) scr_cyc_set_color(scr_cyc_hdr(scr_white.v[j]), SCR_CYC_DOOMED);
    } else if (scr_live_ranges.n && (uintptr_t)scr_live_ranges.v[scr_live_ranges.n - 1] == start) {
      scr_live_ranges.v[scr_live_ranges.n - 1] = (void *)(uintptr_t)end;
    } else {
      scr_cyc_push_work(&scr_live_ranges, (void *)(uintptr_t)start);
      scr_cyc_push_work(&scr_live_ranges, (void *)(uintptr_t)end);
    }
  }
  scr_cyc_note_used(&scr_white);
  /* Nothing externally referenced at all: every gray object is garbage,
   * including components that looked referenced only because a later
   * component held them. settle dooms the recorded set. */
  if (scr_gray_referenced == 0 && scr_white.n < SCR_CYC_GRAY_LIST_MAX)
    return scr_cyc_pass_done(scr_cyc_settle(gen_limit, split && scr_live_ranges.n == 0));

  /* scan, from the recorded set when markGray recorded every gray object:
   * the survivors are exactly what the externally referenced gray objects
   * reach, so blackening from each of them in turn leaves the garbage gray
   * without walking it again, and settle dooms what is still gray. Only
   * the referenced components' entries need looking at; the doomed ones
   * are settled already. */
  if (scr_white.n < SCR_CYC_GRAY_LIST_MAX) {
    /* One sweep over the list, keeping the doomed components' entries and,
     * of the referenced components', only those still gray: a survivor
     * leaves the list as soon as it is seen black, and an object kept here
     * that a later restoration blackens is skipped by settle. */
    size_t kept = 0, from = 0;
    size_t nranges = split ? scr_live_ranges.n : 2;
    for (size_t k = 0; k < nranges; k += 2) {
      size_t start = split ? (uintptr_t)scr_live_ranges.v[k] : 0;
      size_t end = split ? (uintptr_t)scr_live_ranges.v[k + 1] : scr_white.n;
      if (start > from) memmove(scr_white.v + kept, scr_white.v + from, (start - from) * sizeof *scr_white.v);
      kept += start - from;
      for (size_t j = start; j < end; j++) {
        void *obj = scr_white.v[j];
        if (scr_cyc_color(scr_cyc_hdr(obj)) != SCR_CYC_GRAY) continue;
        if (SCR_RC_REFS(obj) > 0) scr_restore_from(obj);
        else scr_white.v[kept++] = obj;
      }
      from = end;
    }
    if (scr_white.n > from) memmove(scr_white.v + kept, scr_white.v + from, (scr_white.n - from) * sizeof *scr_white.v);
    scr_white.n = kept + (scr_white.n - from);
    return scr_cyc_pass_done(scr_cyc_settle(gen_limit, false));
  }

  /* Otherwise scan walks from the candidates. Keep only the doomed
   * components' entries; scan appends what it whitens. */
  if (!split) {
    scr_white.n = 0;
  } else if (scr_live_ranges.n) {
    size_t kept = 0, from = 0;
    for (size_t k = 0; k < scr_live_ranges.n; k += 2) {
      size_t start = (uintptr_t)scr_live_ranges.v[k], end = (uintptr_t)scr_live_ranges.v[k + 1];
      memmove(scr_white.v + kept, scr_white.v + from, (start - from) * sizeof *scr_white.v);
      kept += start - from;
      from = end;
    }
    memmove(scr_white.v + kept, scr_white.v + from, (scr_white.n - from) * sizeof *scr_white.v);
    scr_white.n = kept + (scr_white.n - from);
  }
  /* Externally referenced candidates first: what they restore is never
   * whitened only to be restored again. */
  for (size_t i = 0; i < scr_cands.n; i++) {
    void *obj = scr_cands.v[i];
    if (scr_cyc_color(scr_cyc_hdr(obj)) == SCR_CYC_GRAY && SCR_RC_REFS(obj) > 0) scr_restore_from(obj);
  }
  for (size_t i = 0; i < scr_cands.n; i++) {
    void *obj = scr_cands.v[i];
    if (scr_cyc_color(scr_cyc_hdr(obj)) == SCR_CYC_GRAY) scr_scan(obj, 0);
  }
  while (scr_pending.n) {
    void *obj = scr_pending.v[--scr_pending.n];
    /* A later outside root may have restored this deferred white object and
     * its descendants already. Never scan a black object's edges again. */
    ScrCycHdr *h = scr_cyc_hdr(obj);
    if (scr_cyc_color(h) != SCR_CYC_WHITE) continue;
    const ScrCycType *type = scr_cyc_type(h);
    SCR_CYC_CHILDREN(obj, type, scr_scan_array, scr_scan_visit, 1);
  }

  return scr_cyc_pass_done(scr_cyc_settle(gen_limit, false));
}

#ifdef SCR_CYC_TESTING
/* Tests only: one pass at exactly `gen`, outside the schedule. */
size_t scr_cyc_pass_at(unsigned gen) { return scr_cyc_pass(gen); }
/* Tests only: route appended candidates of bypassing types, as the next
 * scheduling decision or pass would. */
void scr_cyc_route_bypassed_at(void) { scr_cyc_route_bypassed(); }
/* Tests only: the backlog threshold at `gen`, and forgetting what passes
 * there have taught it, as on a thread that has not collected yet. */
size_t scr_cyc_backlog_threshold_at(unsigned gen) { return scr_cyc_backlog_threshold(gen); }
void scr_cyc_forget_backlog_at(unsigned gen) {
  scr_cyc_backlog_shift[gen] = 0;
  scr_cyc_backlog_judged[gen] = false;
}
/* Tests only: the thread's event loop stops counting as running. */
void scr_cyc_forget_event_loop_at(void) {
  scr_cyc_idle_points = false;
  scr_cyc_death_due_live = 0;
}
#endif

size_t scr_cyc_collect_set(const ScrCycSet *set, unsigned gen) {
  if (scr_collecting) return 0;
#ifdef SCR_YIN
  /* Young objects are invisible to trial deletion: collect them first, so
   * survivors are promoted where the limited pass can walk them. */
  size_t young = scr_yin_collect();
#else
  size_t young = 0;
#endif
  scr_cyc_take = set;
  scr_cyc_take_gen = gen;
  size_t freed = young + scr_cyc_pass(SCR_CYC_OLD);
  scr_cyc_take = NULL;
  return freed;
}

void scr_collect_cycles(void) {
  /* The full pass, run to a fixpoint. A teardown's releases can drop the
   * last reference to a further cycle, so one pass does not always drain
   * everything reclaimable — and the callers that matter (program exit,
   * library session reset) are immediately followed by the RC audit and
   * want nothing reclaimable left behind. Only a pass that freed something
   * can have buffered anything new, so a pass that comes up empty ends
   * this; and since each repeat needs a strictly smaller live heap to
   * continue, it terminates. */
#ifdef SCR_YIN
  /* The nursery first: afterwards no young object is left (a teardown
   * never allocates one), so the passes see every object. */
  scr_yin_collect();
#endif
  while (scr_cyc_pass(SCR_CYC_OLD) && scr_cyc_buffered()) {
  }
}

/* The full sweep, for a caller that knows a phase's data has just died (a
 * compiler dropping its frontend). Such data is mostly cyclic, so reference
 * counting frees little of it and the schedule cannot see it die. The
 * growth fractions the phase widened, while its live data kept passes from
 * finding anything, and the death rule's backoff then start over from the
 * heap the sweep leaves, as after a productive pass. Otherwise the next
 * phase's garbage would accumulate until the heap grew to that widened
 * fraction. */
void scr_collect_cycles_phase(void) {
  scr_collect_cycles();
  for (unsigned gen = SCR_CYC_MATURE; gen < SCR_CYC_NGENS; gen++) {
    scr_cyc_growth_shift[gen] = 0;
    scr_cyc_growth_streak[gen] = 0;
  }
  scr_cyc_death_shift = 0;
}

/* Worker TLS becomes unreachable when its OS thread returns. Release the
 * reusable traversal buffers after all context-owned roots are retired. */
void scr_cyc_context_cleanup(void) {
  scr_collect_cycles();
  ScrVec *vectors[] = {&scr_roots[SCR_CYC_NURSERY], &scr_roots[SCR_CYC_MATURE],
    &scr_roots[SCR_CYC_OLD], &scr_cands, &scr_promote, &scr_pending, &scr_restore_pending, &scr_white, &scr_xgen, &scr_xgen_edges, &scr_live_ranges,
    &scr_pub_holes[SCR_CYC_NURSERY], &scr_pub_holes[SCR_CYC_MATURE], &scr_pub_holes[SCR_CYC_OLD]};
  for (size_t i = 0; i < sizeof vectors / sizeof vectors[0]; i++) {
    free(vectors[i]->v);
    *vectors[i] = (ScrVec){0};
  }
  free(scr_cyc_kinds);
  scr_cyc_kinds = NULL;
  scr_cyc_kinds_cap = 0;
#ifdef SCR_YIN
  ScrVec *young[] = {&scr_yin_stack, &scr_yin_dead, &scr_yin_xrel};
  for (size_t i = 0; i < sizeof young / sizeof young[0]; i++) {
    free(young[i]->v);
    *young[i] = (ScrVec){0};
  }
  free(scr_yin.v);
  scr_yin = (ScrYin){0};
  free(scr_yin_types);
  scr_yin_types = NULL;
#ifdef SCR_WORKERS
  free(scr_yin_skip_tl);
  scr_yin_skip_tl = NULL;
#endif
  free(scr_yin_counts);
  scr_yin_counts = NULL;
  scr_yin_counts_cap = 0;
#endif
#if SCR_CYC_INLINE_BUFFERING
  scr_cyc_nursery_bypassing = 0;
#endif
  scr_cyc_window_update();
}
