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
 *   collectWhite everything left white is a dead cycle: free it, releasing
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
 * Recursion depth equals the traced structure's depth — same property as
 * the existing recursive releases (deep lists recurse deeply; acceptable
 * for now, revisit with an explicit stack if it ever traps).
 *
 * ── generations ──────────────────────────────────────────────────────
 * A pass costs O(objects reachable from its candidates), and a candidate
 * deep in a live structure reaches all of it — so collecting on a fixed
 * candidate count makes total work QUADRATIC in a growing live heap. A
 * splay tree is the worst case: re-linking a node buffers it, the walk
 * from it drags in every node below, and none of it is ever garbage.
 *
 * So the collector is generational, in the shape CPython uses for this
 * same algorithm. Each header carries a `gen`; a pass names the oldest
 * generation it will walk and SKIPS every object above it, exactly as it
 * skips NULL and immortals. Objects that survive a pass are promoted, so
 * the next nursery pass never walks them again: the cost of a nursery pass
 * is proportional to what has been allocated since the last one, not to
 * the live heap.
 *
 * Restricting the walk stays sound because trial deletion is already
 * conservative in the right direction. An edge from a skipped (older)
 * object into the walked set is never trial-deleted, so its target keeps
 * that count, reads as externally referenced, and survives — the same
 * answer the collector gives for a reference held by the stack. Edges the
 * other way are simply not followed; the older object was not a candidate
 * for freeing in this pass. What this gives up is cycles that SPAN
 * generations: those are invisible to a nursery pass and are found by the
 * full pass, which walks every generation and so is exactly the old
 * algorithm.
 *
 * Scheduling. One counter drives the release path: candidates buffered
 * since the last pass. When it trips, the pass runs at the nursery level
 * unless either full-pass condition holds:
 *   heap growth    the live cycle-headered heap is a fraction past its size
 *                  after the last full pass — the standard mature-generation
 *                  rule, which catches garbage made from fresh allocation;
 *   mature backlog the mature candidate buffer has reached a fraction of the
 *                  live heap. This one is not redundant: live data that is
 *                  unlinked INTO a dead cycle grows no counter at all (it
 *                  was tallied when it was allocated) and is invisible to a
 *                  nursery pass, so without it a program that churns its
 *                  long-lived structures would never collect anything.
 * Each bounds total collection work to a constant factor of mutator work —
 * one heap-sized walk per live/N candidates — while keeping floating garbage
 * a bounded fraction of the live heap rather than a fixed object count. That
 * is the trade: a fixed threshold bounds floating garbage tightly and pays
 * unbounded time for it; this bounds time and lets garbage float in
 * proportion.
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>

/* Every heap object's first member is `size_t rc`. */
#define SCR_RC(obj) (*(size_t *)(obj))

static void scr_cyc_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* Live cycle-headered objects — what the full-pass trigger watches. */
static size_t scr_cyc_live = 0;

void *scr_cyc_alloc(size_t size, ScrTraceFn trace, ScrCycFreeFn free_fn) {
  ScrCycHdr *h = calloc(1, sizeof(ScrCycHdr) + size);
  if (!h) scr_cyc_oom();
  h->trace = trace;
  h->free_fn = free_fn;
  h->color = SCR_CYC_BLACK;
  h->gen = SCR_CYC_NURSERY;
  scr_cyc_live++;
  return h + 1;
}

void scr_cyc_free(void *obj) {
  scr_cyc_live--;
  free(scr_cyc_hdr(obj));
}

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

static ScrVec scr_roots[SCR_CYC_NGENS];
static bool scr_collecting = false;

/* The candidates of the pass in flight, gathered across the generations it
 * collects so the phases can walk them without re-filtering the buffers. */
static ScrVec scr_cands;

/* Nursery survivors awaiting promotion (see scr_scan_black). */
static ScrVec scr_promote;

/* The gathered white set (freed after the walk completes). */
static ScrVec scr_white;

/* Cross-generation targets pinned by the white set (see scr_xg_pin_visit),
 * one entry per skipped edge. Drained after the teardowns. */
static ScrVec scr_xgen;

/* Objects above this generation are invisible to the pass in flight. */
static unsigned scr_gen_limit = SCR_CYC_MATURE;

static size_t scr_cyc_pass(unsigned gen_limit);

/* ── when to collect ──────────────────────────────────────────────────── */

#define SCR_CYC_NURSERY_CANDIDATES 256 /* nursery trigger */
#define SCR_CYC_FULL_GROWTH_DIV 4      /* full pass per +1/4 of live heap */
#define SCR_CYC_FULL_FLOOR 4096        /* ...but not below this many objects */

/* Live count as of the end of the last full pass. */
static size_t scr_cyc_live_after_full = 0;

static size_t scr_cyc_nursery_threshold(void) {
  static size_t cached = 0;
  if (cached == 0) {
    const char *env = getenv("SCR_CYCLE_THRESHOLD");
    long v = env ? strtol(env, NULL, 10) : 0;
    cached = v > 0 ? (size_t)v : SCR_CYC_NURSERY_CANDIDATES;
  }
  return cached;
}

/* Buffered candidates across both generations, and the count at which the
 * release path next collects. Keeping a running total (rather than summing
 * the buffers) is what holds the hot path to one load and one compare, as
 * it was when there was a single buffer. The trigger is re-armed at the end
 * of every pass to "whatever survived, plus a nursery's worth": without that
 * hysteresis a large mature buffer — which a nursery pass cannot drain —
 * would re-arm on every single release. Both start at zero, so the first
 * release runs one trivial pass that arms them properly. */
static size_t scr_cyc_nbuffered = 0;
static size_t scr_cyc_trigger = 0;

static size_t scr_cyc_buffered(void) {
  return scr_roots[SCR_CYC_NURSERY].n + scr_roots[SCR_CYC_MATURE].n;
}

/* A full pass is due once the live heap has grown a fraction past what it
 * was when the last one finished. Since a pass resets the baseline to the
 * live count it leaves behind, an unproductive full pass cannot re-trigger
 * itself — the next one waits for another fraction of growth. */
static bool scr_cyc_full_due(void) {
  size_t base = scr_cyc_live_after_full;
  if (base < SCR_CYC_FULL_FLOOR) base = SCR_CYC_FULL_FLOOR;
  return scr_cyc_live > base + base / SCR_CYC_FULL_GROWTH_DIV;
}

/* Cold half of the release path: pick the generation and collect.
 *
 * Heap growth is not the only thing that owes a full pass. Live data that
 * TURNS INTO garbage — a mature structure unlinked into a dead cycle —
 * grows no counter at all: those objects were already tallied in
 * scr_cyc_live when they were allocated, so scr_cyc_full_due stays false
 * forever, and a nursery pass cannot see them because they are mature. Left
 * at that, a program that churns its long-lived structures without
 * allocating would never collect anything. So the mature buffer's own size
 * is the second full-pass trigger, at a fraction of the live heap: that
 * bounds uncollected mature candidates proportionally and keeps the
 * amortized cost linear (one heap-sized walk per live/N candidates). */
static size_t scr_cyc_mature_threshold(void) {
  size_t t = scr_cyc_live / SCR_CYC_FULL_GROWTH_DIV;
  return t < SCR_CYC_NURSERY_CANDIDATES ? SCR_CYC_NURSERY_CANDIDATES : t;
}

static void scr_cyc_collect_due(void) {
  bool full = scr_cyc_full_due()
              || scr_roots[SCR_CYC_MATURE].n >= scr_cyc_mature_threshold();
  scr_cyc_pass(full ? SCR_CYC_MATURE : SCR_CYC_NURSERY);
}

/* One scheduled pass, for callers that reach a natural collection point
 * (the event loop between turns) rather than a threshold. Deliberately NOT
 * scr_collect_cycles: that one is the exit-time full sweep, and running it
 * per turn would walk the whole live heap every turn — which is exactly the
 * cost the generations exist to avoid. */
void scr_cyc_collect_scheduled(void) {
  if (scr_cyc_buffered() == 0) return;
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
}

/* THE hot path — every release that leaves an object alive lands here, so
 * it stays what it has always been: buffer inline, then one compare. */
void scr_cyc_on_release(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  h->color = SCR_CYC_PURPLE;
  if (!h->buffered) {
    ScrVec *b = &scr_roots[h->gen];
    if (b->n == b->cap) scr_cyc_grow(b);
    h->buffered = 1;
    h->buf_index = b->n;
    b->v[b->n++] = obj;
    scr_cyc_nbuffered++;
  }
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

static void scr_mark_gray(void *obj);
static void scr_mg_visit(void *child, void *ctx) {
  (void)ctx;
  if (SCR_CYC_SKIP(child)) return;
  SCR_RC(child) -= 1; /* trial-delete this internal edge */
  scr_mark_gray(child);
}
static void scr_mark_gray(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (h->color == SCR_CYC_GRAY) return;
  h->color = SCR_CYC_GRAY;
  h->trace(obj, scr_mg_visit, NULL);
}

static void scr_scan_black(void *obj);
static void scr_sb_visit(void *child, void *ctx) {
  (void)ctx;
  if (SCR_CYC_SKIP(child)) return;
  SCR_RC(child) += 1; /* restore the trial decrement */
  if (scr_cyc_hdr(child)->color != SCR_CYC_BLACK) scr_scan_black(child);
}
static void scr_scan_black(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  h->color = SCR_CYC_BLACK;
  /* Blackening is what proves a walked object survives, so this is where
   * promotion is decided — but it is only RECORDED here. Raising `gen` now
   * would hide the object from SCR_CYC_SKIP partway through the pass, and
   * this phase has trial decrements left to restore. */
  if (h->gen < SCR_CYC_MATURE)
    scr_cyc_push(&scr_promote, obj);
  h->trace(obj, scr_sb_visit, NULL);
}

static void scr_scan(void *obj);
static void scr_scan_visit(void *child, void *ctx) {
  (void)ctx;
  if (SCR_CYC_SKIP(child)) return;
  scr_scan(child);
}
static void scr_scan(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (h->color != SCR_CYC_GRAY) return;
  if (SCR_RC(obj) > 0) {
    /* Externally referenced: this whole subgraph stays. */
    scr_scan_black(obj);
    return;
  }
  h->color = SCR_CYC_WHITE;
  h->trace(obj, scr_scan_visit, NULL);
}

static void scr_collect_white(void *obj);
static void scr_cw_visit(void *child, void *ctx) {
  (void)ctx;
  if (SCR_CYC_SKIP(child)) return;
  scr_collect_white(child);
}
static void scr_collect_white(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (h->color != SCR_CYC_WHITE || h->buffered) return;
  h->color = SCR_CYC_DOOMED; /* gathered — don't gather twice */
  h->trace(obj, scr_cw_visit, NULL);
  scr_cyc_push(&scr_white, obj);
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
static void scr_xg_pin_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SIZE_MAX) return;
  if (scr_cyc_hdr(child)->gen <= scr_gen_limit) return; /* markGray had it */
  SCR_RC(child) += 1; /* pin across the teardowns */
  scr_cyc_push(&scr_xgen, child);
}

/* Freed by the cross-generation drain, for the caller's fixpoint. */
static size_t scr_xg_freed = 0;

static void scr_xg_release(void *obj);
static void scr_xg_child_visit(void *child, void *ctx) {
  (void)ctx;
  if (child == NULL || SCR_RC(child) == SIZE_MAX) return;
  scr_xg_release(child);
}

/* One genuine release, generically: the header carries everything needed. */
static void scr_xg_release(void *obj) {
  ScrCycHdr *h = scr_cyc_hdr(obj);
  if (SCR_RC(obj) > 1) {
    SCR_RC(obj) -= 1;
    scr_cyc_on_release(obj); /* lost a reference: a possible cycle root */
    return;
  }
  SCR_RC(obj) = 0;
  scr_cyc_on_dead(obj); /* out of its candidate buffer before the block goes */
  h->trace(obj, scr_xg_child_visit, NULL); /* the traced children */
  h->free_fn(obj); /* the untraced ones, then the block */
  scr_xg_freed++;
}

/* One pass over every candidate at or below `gen_limit`; returns how many
 * objects it freed. */
static size_t scr_cyc_pass(unsigned gen_limit) {
  if (scr_collecting) return 0;
  scr_collecting = true;
  scr_gen_limit = gen_limit;

  /* markRoots: keep live candidates (still purple), drop the rest — an
   * object re-retained since buffering is black; one grayed by an earlier
   * candidate's walk is already covered by that candidate's subgraph. The
   * buffers are drained up front (markGray only touches counts directly,
   * so nothing can re-buffer underneath us) which leaves collectWhite free
   * to gather members of an earlier root's cycle. Candidates ABOVE the
   * limit keep their buffer slots and wait for a full pass. */
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
  for (size_t i = 0; i < scr_cands.n; i++) scr_mark_gray(scr_cands.v[i]);

  for (size_t i = 0; i < scr_cands.n; i++) scr_scan(scr_cands.v[i]);

  scr_white.n = 0;
  for (size_t i = 0; i < scr_cands.n; i++) scr_collect_white(scr_cands.v[i]);

  /* Pin the cross-generation targets of everything about to be freed, while
   * `gen` still holds the values the walk filtered on (promotion below is
   * what changes them). A full pass skips no edge, so it pins nothing. */
  scr_xgen.n = 0;
  if (gen_limit < SCR_CYC_MATURE) {
    for (size_t i = 0; i < scr_white.n; i++) {
      void *obj = scr_white.v[i];
      scr_cyc_hdr(obj)->trace(obj, scr_xg_pin_visit, NULL);
    }
  }

  /* Every phase that consults SCR_CYC_SKIP has run, so the recorded
   * survivors can graduate now. They are externally referenced, so none of
   * them is in the white set about to be freed. */
  for (size_t i = 0; i < scr_promote.n; i++)
    scr_cyc_hdr(scr_promote.v[i])->gen = SCR_CYC_MATURE;
  scr_promote.n = 0;

  /* A restricted pass may have spared a candidate only because the edge
   * keeping it alive came from a generation it refused to walk — the
   * deliberate conservatism above. But the candidate buffer is the ONLY
   * root set this collector has, and markRoots consumed the entry. Dropping
   * it would retire the one record that this object is a possible cycle
   * root, and a dead cycle whose members all got spared that way would
   * never be walked again by any pass, full ones included. So a restricted
   * pass hands its survivors back as candidates in the generation they were
   * just promoted into, where a full pass — which skips nothing, and so
   * judges them on real reference counts — will settle them. A full pass
   * needs none of this: it walked every edge, so rc > 0 there means a
   * genuine outside reference and Bacon-Rajan's own reasoning retires the
   * candidate. Re-buffering costs a walk, never correctness: an object that
   * is truly live gets re-blackened by the next retain and dropped then. */
  if (gen_limit < SCR_CYC_MATURE) {
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

  if (gen_limit >= SCR_CYC_MATURE) scr_cyc_live_after_full = scr_cyc_live;
  /* markRoots drained buffers in bulk and teardowns moved the count around;
   * resync from the buffers themselves and re-arm. */
  scr_cyc_nbuffered = scr_cyc_buffered();
  scr_cyc_trigger = scr_cyc_nbuffered + scr_cyc_nursery_threshold();
  scr_collecting = false;
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
  while (scr_cyc_pass(SCR_CYC_MATURE)
         && (scr_roots[SCR_CYC_NURSERY].n || scr_roots[SCR_CYC_MATURE].n)) {
  }
}
