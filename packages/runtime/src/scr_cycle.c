/* Reference-cycle collector: generational Bacon–Rajan trial deletion (see
 * "Concurrent Cycle Collection in Reference Counted Systems", the
 * synchronous algorithm) over cycle-headered objects only — the object
 * model and the trace/teardown contract live in scr_runtime.h.
 *
 * Life of a candidate: a release that leaves rc > 0 buffers the object
 * (purple). Collection walks the buffer in three phases over the graph
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
 * The main graph phases keep a bounded depth-first walk and defer deeper
 * traces to reusable worklists. Ordinary RC destruction and cross-generation
 * releases are separate paths. White candidates are recorded during scan
 * and filtered after outside roots settle, avoiding a separate gather walk.
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
 *                  ADAPTS to what full passes find: a growth-triggered full
 *                  pass that reclaims few OLD objects relative to the growth
 *                  that triggered it, twice in a row, doubles the fraction
 *                  (up to 1/2), and one that does reclaim them restores 1/4.
 *                  Garbage younger than the old generation does not count:
 *                  the mature level reclaims it without walking the old heap.
 *                  This is what stops a large retained structure from being
 *                  re-walked at every quarter of growth while it is building
 *                  or while the garbage is all young.
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
 *   mature         the same two rules one level down, with a fixed 1/4
 *                  growth fraction measured from the last mature-or-full
 *                  pass and a backlog rule over the mature buffer.
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
 * forever. Peak memory stays bounded the same way: young garbage floats by
 * at most a quarter of the heap before a mature pass, and old garbage by at
 * most half the heap's size after the last full pass, and by more than a
 * quarter only once two full passes in a row have shown that little of the
 * growth was old garbage.
 */
#include "scr_runtime.h"

SCR_TL void (*scr_weak_dispose_hook)(void *) = NULL;

void scr_weak_dispose(void *object) {
  if (scr_weak_dispose_hook) scr_weak_dispose_hook(object);
}

#include <stdio.h>
#include <stdlib.h>

/* Every heap object's first member is `size_t rc`. */
#define SCR_RC(obj) (*(size_t *)(obj))

static void scr_cyc_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

typedef struct {
  void *object;
  void (*destroy)(void *);
} ScrDestroyEntry;

/* Keep shallow destruction synchronous without allocating. A chain may mix
 * program layouts, unions and runtime containers, so one instance-local
 * depth budget covers every participating destructor. Queued zero-count
 * objects still own their children until their callback runs. */
#define SCR_DESTROY_DEPTH 64
static SCR_TL unsigned scr_destroy_depth;
static SCR_TL ScrDestroyEntry *scr_destroy_pending;
static SCR_TL size_t scr_destroy_count, scr_destroy_capacity;

void scr_rc_destroy(void *obj, void (*destroy)(void *)) {
  if (scr_destroy_depth == SCR_DESTROY_DEPTH) {
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
    return;
  }
  scr_destroy_depth++;
  destroy(obj);
  scr_destroy_depth--;
  if (scr_destroy_depth) return;
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

/* Live cycle-headered objects and the running count of OLD objects freed.
 * The inline allocation/free paths (scr_runtime.h, llvm/alloc.ts) maintain
 * both counters so full passes can measure old-generation reclamation. */
SCR_TL size_t scr_cyc_live = 0;
SCR_TL size_t scr_cyc_old_freed = 0;

void *scr_cyc_alloc(size_t size, ScrTraceFn trace, ScrCycFreeFn free_fn) {
  return scr_cyc_alloc_inline(size, trace, free_fn);
}

void scr_cyc_free(void *obj) { scr_cyc_free_inline(obj); }

/* A pointer vector that only ever grows (these reuse their capacity across
 * passes rather than churning it). Pointer, count and capacity live in ONE
 * struct on purpose: buffering a candidate is the hot path, and splitting
 * them across three arrays indexed by generation would touch three cache
 * lines per release where the original single buffer touched one. */
typedef struct {
  void **v;
  size_t n, cap;
} ScrVec;

static void scr_cyc_grow(ScrVec *vec) {
  vec->cap = vec->cap ? vec->cap * 2 : 64;
  void **grown = realloc(vec->v, vec->cap * sizeof *grown);
  if (!grown) scr_cyc_oom();
  vec->v = grown;
}

static void scr_cyc_push(ScrVec *vec, void *obj) {
  if (vec->n == vec->cap) scr_cyc_grow(vec);
  vec->v[vec->n++] = obj;
}

/* ── the candidate-root buffers (one per generation) ──────────────────── */

static SCR_TL ScrVec scr_roots[SCR_CYC_NGENS];
static SCR_TL bool scr_collecting = false;

/* The candidates of the pass in flight, gathered across the generations it
 * collects so the phases can walk them without re-filtering the buffers. */
static SCR_TL ScrVec scr_cands;

/* Nursery survivors awaiting promotion (see scr_scan_black). */
static SCR_TL ScrVec scr_promote;

/* Deferred traces cap recursive traversal without changing the common
 * depth-first walk. Restore can run inside scan, so it has its own stack. */
static SCR_TL ScrVec scr_pending;
static SCR_TL ScrVec scr_restore_pending;
#define SCR_CYC_WALK_DEPTH 64

/* The gathered white set (freed after the walk completes). */
static SCR_TL ScrVec scr_white;

/* Cross-generation targets pinned by the white set (see scr_xg_pin_visit),
 * one entry per skipped edge. Drained after the teardowns. */
static SCR_TL ScrVec scr_xgen;

/* Objects above this generation are invisible to the pass in flight. */
static SCR_TL unsigned scr_gen_limit = SCR_CYC_OLD;

static size_t scr_cyc_pass(unsigned gen_limit);

/* ── when to collect ──────────────────────────────────────────────────── */

#define SCR_CYC_NURSERY_CANDIDATES 256 /* nursery trigger */

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

/* Live count as of the end of the last full pass, and of the last pass that
 * walked the mature generation (mature or full). */
static SCR_TL size_t scr_cyc_live_after_full = 0;
static SCR_TL size_t scr_cyc_live_after_mature = 0;

/* Doublings of the full-pass growth fraction earned by consecutive
 * growth-triggered full passes that reclaimed little of the old generation
 * (see scr_cyc_scheduled_pass). Capped at a fraction of 1/2: the heap may grow
 * at most by half past its size after the last full pass before the next.
 * The streak counts those unproductive passes since the last productive one;
 * the fraction only grows once two have run in a row. */
#define SCR_CYC_GROWTH_MAX_SHIFT 1
static SCR_TL unsigned scr_cyc_growth_shift = 0;
static SCR_TL unsigned scr_cyc_growth_streak = 0;

/* Doublings of each generation's backlog threshold earned by consecutive
 * passes that found almost nothing to free (see scr_cyc_backlog_threshold).
 * Only the mature and old entries are used. */
#define SCR_CYC_BACKLOG_MAX_SHIFT 8
static SCR_TL unsigned scr_cyc_backlog_shift[SCR_CYC_NGENS];

static size_t scr_cyc_nursery_threshold(void) {
  static SCR_TL size_t cached = 0;
  if (cached == 0) {
    const char *env = scr_getenv("SCR_CYCLE_THRESHOLD");
    long v = env ? strtol(env, NULL, 10) : 0;
    cached = v > 0 ? (size_t)v : SCR_CYC_NURSERY_CANDIDATES;
  }
  return cached;
}

/* Buffered candidates across every generation, and the count at which the
 * release path next collects. Keeping a running total (rather than summing
 * the buffers) is what holds the hot path to one load and one compare, as
 * it was when there was a single buffer. The trigger is re-armed at the end
 * of every pass to "whatever survived, plus a nursery's worth": without that
 * hysteresis a large older buffer — which a nursery pass cannot drain —
 * would re-arm on every single release. Both start at zero, so the first
 * release runs one trivial pass that arms them properly. */
static SCR_TL size_t scr_cyc_nbuffered = 0;
static SCR_TL size_t scr_cyc_trigger = 0;

/* Scheduled nursery passes for which at least one mature or old root was
 * waiting. A full pass resets the age; with no such backlog there is nothing
 * to age. */
static SCR_TL size_t scr_cyc_scheduled_mature_age = 0;

static size_t scr_cyc_buffered(void) {
  return scr_roots[SCR_CYC_NURSERY].n + scr_roots[SCR_CYC_MATURE].n
         + scr_roots[SCR_CYC_OLD].n;
}

static bool scr_cyc_older_backlog(void) {
  return scr_roots[SCR_CYC_MATURE].n != 0 || scr_roots[SCR_CYC_OLD].n != 0;
}

static size_t scr_cyc_growth_base(size_t live_after) {
  return live_after < SCR_CYC_GROWTH_FLOOR ? SCR_CYC_GROWTH_FLOOR : live_after;
}

/* A pass is due once the live heap has grown a fraction past what it was
 * when the last pass at that level finished. Since a pass resets its
 * baseline to the live count it leaves behind, an unproductive pass cannot
 * re-trigger itself — the next one waits for another fraction of growth. */
static bool scr_cyc_grown(size_t live_after, unsigned shift) {
  size_t base = scr_cyc_growth_base(live_after);
  return scr_cyc_live > base + ((base / SCR_CYC_GROWTH_DIV) << shift);
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
 * first productive pass at that level restores the original fraction. */
static size_t scr_cyc_backlog_threshold(unsigned gen) {
  size_t t = scr_cyc_live / SCR_CYC_GROWTH_DIV;
  if (t < SCR_CYC_NURSERY_CANDIDATES) t = SCR_CYC_NURSERY_CANDIDATES;
  unsigned shift = scr_cyc_backlog_shift[gen];
  return t > (SIZE_MAX >> shift) ? SIZE_MAX : t << shift;
}

/* One scheduled pass at `gen`. A mature or old pass adapts that level's
 * backlog threshold to its yield; the explicit sweep (scr_collect_cycles) is
 * not a scheduling decision and leaves the thresholds alone. Productive means
 * at least one object freed per GROWTH_DIV candidates; a pass with no
 * candidates says nothing.
 *
 * A full pass that heap growth triggered also adapts the growth fraction to
 * what it reclaimed from the OLD generation — the one part of its work no
 * restricted pass could have done. Weighing that against the growth since the
 * last full pass keeps full passes frequent while old structures are being
 * discarded (their garbage is what floats until the next full pass) and
 * spaces them out while the heap is growing with live or young data, where
 * each walk of the retained heap buys almost nothing. Backing off only after
 * two unproductive passes in a row keeps a program that discards old
 * structures at a steady rate on the base schedule: its passes alternate
 * between finding the garbage just aged into the old generation and finding
 * it still younger, and a single miss says little.
 *
 * Every level shares this one body, so a program that links the collector
 * carries a single copy of the scheduling logic. */
static SCR_CYC_SCHEDULING void scr_cyc_scheduled_pass(unsigned gen, bool by_growth) {
  size_t base = scr_cyc_growth_base(scr_cyc_live_after_full);
  size_t growth = scr_cyc_live > base ? scr_cyc_live - base : 0;
  size_t old_freed_before = scr_cyc_old_freed;
  size_t freed = scr_cyc_pass(gen);
  if (gen == SCR_CYC_NURSERY) return;
  if (scr_cands.n != 0) {
    if (freed * SCR_CYC_GROWTH_DIV >= scr_cands.n)
      scr_cyc_backlog_shift[gen] = 0;
    else if (scr_cyc_backlog_shift[gen] < SCR_CYC_BACKLOG_MAX_SHIFT)
      scr_cyc_backlog_shift[gen]++;
  }
  if (!by_growth) return;
  size_t reclaimed = scr_cyc_old_freed - old_freed_before;
  if (reclaimed * SCR_CYC_GROWTH_DIV >= growth) {
    scr_cyc_growth_shift = 0;
    scr_cyc_growth_streak = 0;
  } else if (++scr_cyc_growth_streak >= 2
             && scr_cyc_growth_shift < SCR_CYC_GROWTH_MAX_SHIFT) {
    scr_cyc_growth_shift++;
  }
}

/* Cold half of the release path: pick the level and collect. It runs once
 * per pass, so it is kept out of line and built for size, which leaves the
 * hot buffering path in scr_cyc_on_release small. */
static SCR_CYC_SCHEDULING void scr_cyc_collect_due(void) {
  unsigned gen = SCR_CYC_NURSERY;
  bool by_growth = scr_cyc_grown(scr_cyc_live_after_full, scr_cyc_growth_shift);
  if (by_growth || scr_roots[SCR_CYC_OLD].n >= scr_cyc_backlog_threshold(SCR_CYC_OLD))
    gen = SCR_CYC_OLD;
  else if (scr_cyc_grown(scr_cyc_live_after_mature, 0)
           || scr_roots[SCR_CYC_MATURE].n >= scr_cyc_backlog_threshold(SCR_CYC_MATURE))
    gen = SCR_CYC_MATURE;
  scr_cyc_scheduled_pass(gen, by_growth);
}

/* One scheduled pass, for callers that reach a natural collection point
 * (the event loop between turns) rather than a threshold. Deliberately NOT
 * scr_collect_cycles: that one is the exit-time full sweep, and running it
 * per turn would walk the whole live heap every turn — which is exactly the
 * cost the generations exist to avoid. */
void scr_cyc_collect_scheduled(void) {
  if (scr_cyc_buffered() == 0) {
    scr_cyc_scheduled_mature_age = 0;
    return;
  }
  if (!scr_cyc_older_backlog()) {
    scr_cyc_scheduled_mature_age = 0;
  } else if (++scr_cyc_scheduled_mature_age
             >= scr_cyc_nursery_threshold()) {
    scr_cyc_scheduled_pass(SCR_CYC_OLD, false);
    return;
  }
  scr_cyc_collect_due();
}

void scr_cyc_on_dead(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (!h->buffered) return;
  /* O(1) removal: swap the last entry into the hole. A buffered object's
   * generation never changes (promotion runs only on objects the pass has
   * already drained from the buffers), so `gen` names the right one. */
  ScrVec *b = &scr_roots[h->gen];
  size_t i = h->buf_index;
  void *last = b->v[--b->n];
  b->v[i] = last;
  if (last != obj) scr_cyc_hdr(last)->buf_index = i;
  h->buffered = 0;
  scr_cyc_nbuffered--;
  /* A death must not consume room reserved for a future candidate. */
  scr_cyc_trigger--;
  if (h->gen != SCR_CYC_NURSERY && !scr_cyc_older_backlog())
    scr_cyc_scheduled_mature_age = 0;
}

/* THE hot path — every release that leaves an object alive lands here, so
 * it stays what it has always been: buffer inline, then one compare. */
void scr_cyc_on_release(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  h->color = SCR_CYC_PURPLE;
  /* Releasing an existing candidate cannot advance the trigger. A pass
   * always re-arms after its teardowns, including any candidates they add. */
  if (h->buffered) return;
  ScrVec *b = &scr_roots[h->gen];
  if (b->n == b->cap) scr_cyc_grow(b);
  h->buffered = 1;
  h->buf_index = b->n;
  b->v[b->n++] = obj;
  scr_cyc_nbuffered++;
  /* Never re-entered: a teardown's releases of untraced children can buffer
   * new candidates mid-collection, but they only wait for the next pass. */
  if (!scr_collecting && scr_cyc_nbuffered >= scr_cyc_trigger)
    scr_cyc_collect_due();
}

/* ── trial deletion ───────────────────────────────────────────────────── */

/* Child filter shared by every phase — and it MUST be shared by every
 * phase: scan restores exactly the trial decrements markGray made, so the
 * two must agree on which edges are internal. Nothing to do for NULL
 * (unassigned slots), immortal (interned statics have no header at all), or
 * a generation this pass does not collect. */
#define SCR_CYC_SKIP(child)                     \
  ((child) == NULL || SCR_RC(child) == SIZE_MAX \
   || scr_cyc_hdr(child)->gen > scr_gen_limit)

/* Trace callbacks forward an integer depth through their opaque context;
 * it is never dereferenced. The ABI already carries it through every edge. */
static void scr_mark_gray(void *obj, uintptr_t depth);
static void scr_mg_visit(void *child, void *ctx) {
  if (SCR_CYC_SKIP(child)) return;
  SCR_RC(child) -= 1;
  scr_mark_gray(child, (uintptr_t)ctx);
}
static void scr_mark_gray(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (h->color == SCR_CYC_GRAY) return;
  h->color = SCR_CYC_GRAY;
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push(&scr_pending, obj);
    return;
  }
  h->trace(obj, scr_mg_visit, (void *)(depth + 1));
}

static void scr_scan_black(void *obj, uintptr_t depth);
static void scr_sb_visit(void *child, void *ctx) {
  if (SCR_CYC_SKIP(child)) return;
  SCR_RC(child) += 1;
  if (scr_cyc_hdr(child)->color != SCR_CYC_BLACK)
    scr_scan_black(child, (uintptr_t)ctx);
}
static void scr_scan_black(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  h->color = SCR_CYC_BLACK;
  if (h->gen < SCR_CYC_OLD) scr_cyc_push(&scr_promote, obj);
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push(&scr_restore_pending, obj);
    return;
  }
  h->trace(obj, scr_sb_visit, (void *)(depth + 1));
}

static void scr_scan(void *obj, uintptr_t depth);
static void scr_scan_visit(void *child, void *ctx) {
  if (SCR_CYC_SKIP(child)) return;
  scr_scan(child, (uintptr_t)ctx);
}
static void scr_scan(void *obj, uintptr_t depth) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (h->color != SCR_CYC_GRAY) return;
  if (SCR_RC(obj) > 0) {
    scr_scan_black(obj, 0);
    while (scr_restore_pending.n) {
      void *next = scr_restore_pending.v[--scr_restore_pending.n];
      scr_cyc_hdr(next)->trace(next, scr_sb_visit, NULL);
    }
    return;
  }
  h->color = SCR_CYC_WHITE;
  /* Record each whitened object once. A later outside root can restore it;
   * filter the list only after every scan finishes. No gather trace needed. */
  scr_cyc_push(&scr_white, obj);
  if (depth == SCR_CYC_WALK_DEPTH) {
    scr_cyc_push(&scr_pending, obj);
    return;
  }
  h->trace(obj, scr_scan_visit, (void *)(depth + 1));
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
 * One entry per skipped edge, so several edges sharing a target settle it
 * once each.
 *
 * Nothing pinned here can be in the white set: a skipped older object's
 * edges were never trial-deleted, so anything it references kept that count
 * and was scan-blacked rather than whitened — the same conservatism that
 * makes restricting the walk sound in the first place. */
static SCR_CYC_COMPACT void scr_xg_pin_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SIZE_MAX) return;
  if (scr_cyc_hdr(child)->gen <= scr_gen_limit) return; /* markGray had it */
  SCR_RC(child) += 1; /* pin across the teardowns */
  scr_cyc_push(&scr_xgen, child);
}

/* Freed by the cross-generation drain, for the caller's fixpoint. */
static SCR_TL size_t scr_xg_freed = 0;

static void scr_xg_release(void *obj);
static void scr_xg_child_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SIZE_MAX) return;
  scr_xg_release(child);
}

/* One genuine release, generically: the header carries everything needed. */
static void scr_xg_destroy(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  h->trace(obj, scr_xg_child_visit, NULL);
  h->free_fn(obj);
  scr_xg_freed++;
}

static SCR_CYC_COMPACT void scr_xg_release(void *obj) {
  if (SCR_RC(obj) > 1) {
    SCR_RC(obj) -= 1;
    scr_cyc_on_release(obj); /* lost a reference: a possible cycle root */
    return;
  }
  SCR_RC(obj) = 0;
  scr_cyc_on_dead(obj); /* out of its candidate buffer before the block goes */
  scr_rc_destroy(obj, scr_xg_destroy);
}

/* One pass over every candidate at or below `gen_limit`; returns how many
 * objects it freed. */
/* The second half of a pass: settle the white set, promote, re-buffer,
 * tear down and re-arm. Its loops run once per candidate or dead object and
 * spend their time in the trace and teardown calls they make, so this half is
 * built for size; the graph walk above it stays fully optimized. Returns how
 * many objects the pass freed. */
static SCR_CYC_COMPACT size_t scr_cyc_settle(unsigned gen_limit) {
  size_t dead = 0;
  for (size_t i = 0; i < scr_white.n; i++) {
    void *obj = scr_white.v[i];
    ScrCycHdr *h = scr_cyc_hdr(obj);
    if (h->color != SCR_CYC_WHITE) continue;
    h->color = SCR_CYC_DOOMED;
    scr_white.v[dead++] = obj;
  }
  scr_white.n = dead;

  /* Pin the cross-generation targets of everything about to be freed, while
   * `gen` still holds the values the walk filtered on (promotion below is
   * what changes them). A full pass skips no edge, so it pins nothing. */
  scr_xgen.n = 0;
  if (gen_limit < SCR_CYC_OLD) {
    for (size_t i = 0; i < scr_white.n; i++) {
      void *obj = scr_white.v[i];
      scr_cyc_hdr(obj)->trace(obj, scr_xg_pin_visit, NULL);
    }
  }

  /* Every phase that consults SCR_CYC_SKIP has run, so the recorded
   * survivors can graduate now, one generation each. They are externally
   * referenced, so none of them is in the white set about to be freed. */
  for (size_t i = 0; i < scr_promote.n; i++) {
    ScrCycHdr *h = scr_cyc_hdr(scr_promote.v[i]);
    if (h->gen < SCR_CYC_OLD) h->gen++;
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
   * is truly live gets re-blackened by the next retain and dropped then. */
  if (gen_limit < SCR_CYC_OLD) {
    for (size_t i = 0; i < scr_cands.n; i++) {
      void *obj = scr_cands.v[i];
      ScrCycHdr *h = scr_cyc_hdr(obj);
      if (h->color == SCR_CYC_DOOMED) continue; /* being freed below */
      h->color = SCR_CYC_PURPLE;
      if (!h->buffered) {
        h->buffered = 1;
        h->buf_index = scr_roots[h->gen].n;
        scr_cyc_push(&scr_roots[h->gen], obj);
      }
    }
  }

  /* Teardowns run after the full walk. They may release untraced children
   * (plain RC) — which can re-buffer survivors for the NEXT pass — but
   * never touch traced (white, already-accounted) edges. */
  size_t freed = scr_white.n;
  for (size_t i = 0; i < scr_white.n; i++) {
    void *obj = scr_white.v[i];
    scr_cyc_hdr(obj)->free_fn(obj);
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

  if (gen_limit >= SCR_CYC_MATURE) scr_cyc_live_after_mature = scr_cyc_live;
  if (gen_limit >= SCR_CYC_OLD) {
    scr_cyc_live_after_full = scr_cyc_live;
    scr_cyc_scheduled_mature_age = 0;
  }
  /* markRoots drained buffers in bulk and teardowns moved the count around;
   * resync from the buffers themselves and re-arm. */
  scr_cyc_nbuffered = scr_cyc_buffered();
  scr_cyc_trigger = scr_cyc_nbuffered + scr_cyc_nursery_threshold();
  scr_collecting = false;
  return freed;
}

static size_t scr_cyc_pass(unsigned gen_limit) {
  if (scr_collecting) return 0;
  scr_collecting = true;
  scr_gen_limit = gen_limit;

  /* markRoots: keep live candidates (still purple), drop the rest — an
   * object re-retained since buffering is black. Drain the buffers before
   * walking: tracing only adjusts counts and worklists, so nothing can
   * re-buffer underneath us. Candidates ABOVE the limit keep their slots
   * and wait for a pass at their own level. */
  scr_cands.n = 0;
  for (unsigned g = 0; g <= gen_limit; g++) {
    for (size_t i = 0; i < scr_roots[g].n; i++) {
      void *obj = scr_roots[g].v[i];
      ScrCycHdr *h = scr_cyc_hdr(obj);
      h->buffered = 0;
      if (h->color == SCR_CYC_PURPLE)
        scr_cyc_push(&scr_cands, obj);
    }
    scr_roots[g].n = 0;
  }
  for (size_t i = 0; i < scr_cands.n; i++) scr_mark_gray(scr_cands.v[i], 0);
  while (scr_pending.n) {
    void *obj = scr_pending.v[--scr_pending.n];
    scr_cyc_hdr(obj)->trace(obj, scr_mg_visit, NULL);
  }

  scr_white.n = 0;
  for (size_t i = 0; i < scr_cands.n; i++) scr_scan(scr_cands.v[i], 0);
  while (scr_pending.n) {
    void *obj = scr_pending.v[--scr_pending.n];
    /* A later outside root may have restored this deferred white node and
     * its descendants already. Never scan a black node's edges again. */
    if (scr_cyc_hdr(obj)->color == SCR_CYC_WHITE)
      scr_cyc_hdr(obj)->trace(obj, scr_scan_visit, NULL);
  }

  return scr_cyc_settle(gen_limit);
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
  while (scr_cyc_pass(SCR_CYC_OLD) && scr_cyc_buffered()) {
  }
}

/* Worker TLS becomes unreachable when its OS thread returns. Release the
 * reusable traversal buffers after all context-owned roots are retired. */
void scr_cyc_context_cleanup(void) {
  scr_collect_cycles();
  ScrVec *vectors[] = {&scr_roots[SCR_CYC_NURSERY], &scr_roots[SCR_CYC_MATURE],
    &scr_roots[SCR_CYC_OLD], &scr_cands, &scr_promote, &scr_pending, &scr_restore_pending, &scr_white, &scr_xgen};
  for (size_t i = 0; i < sizeof vectors / sizeof vectors[0]; i++) {
    free(vectors[i]->v);
    *vectors[i] = (ScrVec){0};
  }
}
