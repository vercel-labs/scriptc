#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Node Node;
struct Node {
  size_t rc;
  Node *next;
  Node *other;
  Node *untraced;
};

static size_t freed;
static size_t traced; /* trace calls: the collector's walk, one per object visit */

static size_t configured_nursery_threshold(void) {
  const char *env = getenv("SCR_CYCLE_THRESHOLD");
  long value = env ? strtol(env, NULL, 10) : 0;
  return value > 0 ? (size_t)value : 256;
}

/* How many times its size after the last full pass the heap may grow before
 * the next once passes stop finding garbage: SCR_CYCLE_GROWTH_CAP rounded
 * down to a power of two from 1 to 16, and 16 when unset. */
static size_t configured_growth_cap(void) {
  const char *env = getenv("SCR_CYCLE_GROWTH_CAP");
  long value = env ? strtol(env, NULL, 10) : 0;
  if (value <= 0) return 16;
  size_t cap = 1;
  while (cap < 16 && (long)(cap * 2) <= value) cap *= 2;
  return cap;
}

static void check(bool condition, const char *message) {
  if (condition) return;
  fprintf(stderr, "cycle test failed: %s\n", message);
  exit(EXIT_FAILURE);
}

_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  exit(EXIT_FAILURE);
}

static void node_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  traced++;
  visit(((Node *)obj)->next, ctx);
  visit(((Node *)obj)->other, ctx);
}

static void node_free(void *obj) {
  Node *untraced = ((Node *)obj)->untraced;
  if (untraced) {
    untraced->rc--;
    scr_cyc_on_release(untraced);
  }
  freed++;
  scr_cyc_free(obj);
}

static Node *make_ring_of(size_t count, ScrCycType *type) {
  Node **nodes = calloc(count, sizeof(*nodes));
  if (!nodes) scr_trap("cycle test: out of memory\n");
  for (size_t i = 0; i < count; i++) {
    nodes[i] = scr_cyc_alloc(sizeof(*nodes[i]), type);
    nodes[i]->rc = 1; /* the ring edge that will point at this node */
  }
  for (size_t i = 0; i < count; i++)
    nodes[i]->next = nodes[(i + 1) % count];

  Node *root = nodes[0];
  root->rc++; /* external owner */
  free(nodes);
  return root;
}

static Node *make_ring(size_t count) {
  static ScrCycType cyc_type = { &node_trace, &node_free, 0 };
  return make_ring_of(count, &cyc_type);
}

static void release_live(Node *node) {
  node->rc--;
  scr_cyc_on_release(node);
}

static void check_sparse_mature_backlog(size_t roots) {
  enum { NODES_PER_RING = 32 };
  size_t scheduled_passes = configured_nursery_threshold();
  Node *ring_roots[2];
  size_t before = freed;

  for (size_t i = 0; i < roots; i++) {
    ring_roots[i] = make_ring(NODES_PER_RING);
    ring_roots[i]->rc++; /* temporary release makes it a candidate */
    release_live(ring_roots[i]);
  }

  /* Promote and drain every candidate while the rings are externally live.
   * This also resets scheduled age, independent of release-triggered passes. */
  scr_collect_cycles();
  check(freed == before, "setup full pass freed a live ring");

  for (size_t i = 0; i < roots; i++) release_live(ring_roots[i]);
  for (size_t i = 1; i < scheduled_passes; i++)
    scr_cyc_collect_scheduled();
  check(freed == before, "mature rings collected before configured boundary");

  scr_cyc_collect_scheduled();

  check(freed - before == roots * NODES_PER_RING,
        "configured boundary did not collect the mature rings exactly");
}

static void check_age_reset_when_last_mature_root_dies(void) {
  size_t partial_age = configured_nursery_threshold() / 2;
  size_t scheduled_passes = configured_nursery_threshold();
  size_t before = freed;
  Node *ring;
  Node *leaf;

  ring = make_ring(32);
  ring->rc++;
  release_live(ring);
  static ScrCycType cyc_type = { &node_trace, &node_free, 0 };
  leaf = scr_cyc_alloc(sizeof(*leaf), &cyc_type);
  leaf->rc = 1;
  leaf->rc++; /* temporary release makes it a nursery candidate */
  release_live(leaf);

  /* Both objects are now mature, live, unbuffered, and scheduled age is zero. */
  scr_collect_cycles();
  check(freed == before, "setup full pass freed a live age-reset object");

  leaf->rc++;
  release_live(leaf); /* buffer the mature leaf while it remains externally live */
  for (size_t i = 0; i < partial_age; i++) scr_cyc_collect_scheduled();

  leaf->rc--;
  scr_cyc_on_dead(leaf); /* removing the last mature root resets its age */
  node_free(leaf);
  check(freed == before + 1, "directly dead mature root was not freed");

  /* The waiting ring starts a fresh age after the last prior root disappeared. */
  release_live(ring);
  for (size_t i = 1; i < scheduled_passes; i++)
    scr_cyc_collect_scheduled();
  check(freed == before + 1,
        "age reset ring collected before configured boundary");
  scr_cyc_collect_scheduled();
  check(freed == before + 33,
        "age reset ring was not collected at configured boundary");
}

static void check_dead_backlog_rearms_release_trigger(void) {
  enum { BACKLOG = 32 };
  size_t threshold = configured_nursery_threshold();
  Node *leaves[BACKLOG];

  for (size_t i = 0; i < BACKLOG; i++) {
    static ScrCycType cyc_type = { &node_trace, &node_free, 0 };
    leaves[i] = scr_cyc_alloc(sizeof(*leaves[i]), &cyc_type);
    leaves[i]->rc = 2; /* external owner plus a temporary reference */
    release_live(leaves[i]);
  }
  scr_collect_cycles(); /* promote the live leaves and drain their roots */

  for (size_t i = 0; i < BACKLOG; i++) {
    leaves[i]->rc++;
    release_live(leaves[i]); /* build a mature candidate backlog */
  }
  if (threshold > 1)
    scr_cyc_collect_scheduled(); /* re-arm over the entire backlog */

  for (size_t i = 0; i < BACKLOG; i++) {
    leaves[i]->rc--;
    scr_cyc_on_dead(leaves[i]);
    node_free(leaves[i]);
  }

  size_t before = freed;
  for (size_t i = 0; i < threshold; i++)
    release_live(make_ring(1));
  check(freed - before == threshold,
        "directly dead backlog delayed the next release-triggered pass");
}

static Node *make_leaf(void) {
  static ScrCycType cyc_type = { &node_trace, &node_free, 0 };
  Node *leaf = scr_cyc_alloc(sizeof(*leaf), &cyc_type);
  leaf->rc = 1;
  return leaf;
}

/* A temporary reference taken and dropped, as when a program reads it. */
static void read_live(Node *node) {
  node->rc++;
  release_live(node);
}

/* A promoted ring whose last outside owner has just been dropped. */
static void make_dead_mature_ring(size_t count) {
  Node *ring = make_ring(count);
  ring->rc++;
  release_live(ring);
  scr_collect_cycles();
  release_live(ring); /* only the ring edge remains */
}

/* Dead mature rings reclaimed by one scheduled full pass that frees more
 * than it walks live, which restores the backlog trigger's base fraction. */
static void collect_dead_mature_rings(void) {
  enum { RING = 32, RINGS = 64 };
  Node *rings[RINGS];
  size_t before = freed;
  for (size_t i = 0; i < RINGS; i++) {
    rings[i] = make_ring(RING);
    rings[i]->rc++;
    release_live(rings[i]);
  }
  scr_collect_cycles();
  for (size_t i = 0; i < RINGS; i++) release_live(rings[i]);
  for (size_t i = 0; i < configured_nursery_threshold(); i++)
    scr_cyc_collect_scheduled();
  check(freed == before + RINGS * RING, "scheduled pass missed dead mature rings");
}

static void check_unproductive_backlog_backs_off(void) {
  enum { LIVE = 8192, RING = 32 };
  static Node *leaves[LIVE];
  for (size_t i = 0; i < LIVE; i++) {
    leaves[i] = make_leaf();
    read_live(leaves[i]);
  }
  scr_collect_cycles(); /* promote; the explicit sweep never adapts the threshold */
  collect_dead_mature_rings();

  /* Reading a quarter of the live heap reaches the backlog trigger, whose
   * pass finds the dead ring among live candidates but little else. */
  size_t before = freed;
  make_dead_mature_ring(RING);
  for (size_t i = 0; i < 3000; i++) read_live(leaves[i]);
  check(freed == before + RING, "backlog trigger missed a dead mature ring");

  /* That unproductive pass doubled the threshold: the same reads wait. */
  before = freed;
  make_dead_mature_ring(RING);
  for (size_t i = 0; i < 3500; i++) read_live(leaves[i]);
  check(freed == before, "unproductive backlog pass did not back off");
  for (size_t i = 3500; i < 5000; i++) read_live(leaves[i]);
  check(freed == before + RING, "backed-off backlog trigger never collected");

  /* A productive scheduled pass restores the original fraction. */
  collect_dead_mature_rings();
  before = freed;
  make_dead_mature_ring(RING);
  for (size_t i = 0; i < 3000; i++) read_live(leaves[i]);
  check(freed == before + RING, "productive pass did not restore the backlog trigger");

  for (size_t i = 0; i < LIVE; i++) {
    leaves[i]->rc--;
    scr_cyc_on_dead(leaves[i]);
    node_free(leaves[i]);
  }
}

/* Survive two passes: nursery to mature, then mature to old. */
static void age_to_old(Node *node) {
  for (int i = 0; i < 2; i++) {
    read_live(node);
    scr_collect_cycles();
  }
  check(scr_cyc_gen(scr_cyc_hdr(node)) == SCR_CYC_OLD, "survivor did not reach the old generation");
}

/* Fresh live leaves, each released once so the release path keeps running
 * its passes, until `target` objects have been freed or `limit` leaves have
 * been made. Returns how many it made. */
static size_t grow_until(Node **keep, size_t limit, size_t target) {
  size_t n = 0;
  while (freed < target && n < limit) {
    keep[n] = make_leaf();
    read_live(keep[n]);
    n++;
  }
  return n;
}

static void drop_leaves(Node **keep, size_t n) {
  for (size_t i = 0; i < n; i++) {
    keep[i]->rc--;
    scr_cyc_on_dead(keep[i]);
    node_free(keep[i]);
  }
}

/* A dead cycle that has aged into the old generation is reachable only by a
 * full pass, which must reclaim it before the heap has grown a quarter past
 * its size after the last full pass while no pass has yet asked for a wider
 * fraction. Runs first, so the live heap is below the growth floor and that
 * bound is known. */
static void check_old_garbage_reclaimed_while_growing(void) {
  enum { RING = 64, FLOOR = 4096, LIMIT = 4 * FLOOR };
  static Node *keep[LIMIT];
  size_t before = freed;
  Node *ring = make_ring(RING);
  age_to_old(ring);
  release_live(ring); /* last outside owner gone: a dead old cycle */
  size_t grown = grow_until(keep, LIMIT, before + RING);
  check(freed == before + RING, "dead old cycle was never reclaimed while the heap grew");
  check(grown <= FLOOR + FLOOR / 4, "dead old cycle outlived the growth bound");
  drop_leaves(keep, grown);
  scr_collect_cycles();
}

/* Dead rings that survived at least one pass, each holding a traced edge
 * into an old ring: whichever level reclaims them must pay those edges off,
 * and must do so without an explicit sweep. */
static void check_older_rings_into_old(void) {
  enum { OLD_RING = 2048, RING = 8, RINGS = 1024, LIMIT = 4 * (OLD_RING + RING * RINGS) };
  static Node *keep[LIMIT];
  Node *old = make_ring(OLD_RING);
  age_to_old(old);
  size_t before = freed;
  Node *rings[RINGS];
  for (size_t i = 0; i < RINGS; i++) {
    rings[i] = make_ring(RING);
    rings[i]->other = old;
    old->rc++;
    read_live(rings[i]);
  }
  scr_cyc_collect_scheduled(); /* every ring survives at least one pass */
  for (size_t i = 0; i < RINGS; i++) {
    check(scr_cyc_gen(scr_cyc_hdr(rings[i])) != SCR_CYC_NURSERY, "ring was not promoted");
    release_live(rings[i]);
  }
  size_t grown = grow_until(keep, LIMIT, before + RINGS * RING);
  check(freed == before + RINGS * RING, "dead older rings were never reclaimed");
  check(old->rc == 2, "edges into the old generation were not paid off");
  drop_leaves(keep, grown);
  release_live(old);
  scr_collect_cycles();
}

/* A dead cycle spanning the mature and old generations is spared by mature
 * passes; promotion and re-buffering must still hand it to a full pass. */
static void check_cycle_spanning_mature_and_old(void) {
  enum { LIMIT = 4 * 4096 };
  static Node *keep[LIMIT];
  Node *old = make_ring(4);
  age_to_old(old);
  Node *young = make_ring(4);
  young->other = old;
  old->rc++;
  old->other = young;
  young->rc++;
  read_live(young);
  scr_cyc_collect_scheduled(); /* young survives a pass and is promoted */
  size_t before = freed;
  release_live(old);
  release_live(young); /* only the cycle's own edges remain */
  size_t grown = grow_until(keep, LIMIT, before + 8);
  check(freed == before + 8, "cycle spanning generations was never reclaimed");
  drop_leaves(keep, grown);
  scr_collect_cycles();
}

/* Grow a chain by `count` nodes, each new head owning the previous one and
 * released once, as reading the newest entry of a retained list would. Every
 * buffered head reaches the whole chain, so each full pass walks all of it. */
static Node *grow_chain(Node *head, size_t count) {
  for (size_t i = 0; i < count; i++) {
    Node *node = make_leaf();
    node->next = head; /* takes over the caller's reference */
    head = node;
    read_live(head);
  }
  return head;
}

/* Full passes over a growing retained structure that find nothing widen the
 * growth fraction, so the structure is not re-walked at every quarter of its
 * growth. How far the fraction may widen, and how a productive pass narrows
 * it, are pinned on a heap at the growth floor by
 * check_growth_cap_bounds_floating_garbage: on a structure this size the
 * default cap lets a dead cycle wait through millions of allocations. Leaves
 * the fraction widened, so it runs after the tests that assume the base
 * schedule. */
static void check_growth_schedule_follows_yield(void) {
  enum { START = 4096, GROW = 64 * START };
  size_t before = freed;
  Node *head = grow_chain(make_leaf(), START);
  scr_collect_cycles(); /* a baseline the bounds below are measured from */
  size_t walked_before = traced;
  head = grow_chain(head, GROW);
  check(freed == before, "growing a live chain freed part of it");
  /* Counting every level, walking the chain at every quarter or half of its
   * growth costs eight to ten times its final length; the widened schedule
   * keeps it near five. */
  check(traced - walked_before <= 7 * (size_t)GROW,
        "a growing retained structure was re-walked at every fraction of growth");

  /* Close the chain into one dead cycle: the collector reclaims it whole. */
  Node *tail = head;
  while (tail->next) tail = tail->next;
  tail->other = head;
  head->rc++;
  size_t length = scr_cyc_live; /* nothing else is live between the tests */
  before = freed;
  release_live(head);
  scr_collect_cycles();
  check(freed == before + length, "the closed chain was not reclaimed whole");
}

/* Grow one dead cycle until a full pass reclaims it, and return the live
 * heap at the release that ran that pass. The cycle's only old member is
 * also its only candidate; the young nodes appended to it are never
 * buffered, so only a full pass walks or frees them, and that pass reclaims
 * one old object against all of the growth, plus a dead old ring of
 * `old_garbage` objects when that is nonzero. Dead one-node rings keep the
 * release path running restricted passes meanwhile. The explicit sweeps in
 * age_to_old leave a live heap below the growth floor, so the full pass is
 * due once the heap grows past the floor by the old level's fraction. With
 * `mixed`, the dead ring is mature instead, held in a cycle with one old
 * node: a dead structure only a full pass can see. */
static size_t grow_dead_cycle_until_full_pass(size_t old_garbage, bool mixed) {
  enum { FLOOR = 4096 };
  size_t limit = FLOOR * 18 + 4 * configured_nursery_threshold();
  Node *garbage = NULL;
  if (old_garbage && !mixed) {
    garbage = make_ring(old_garbage);
    age_to_old(garbage);
  }
  Node *old = make_leaf();
  age_to_old(old);
  if (old_garbage && mixed) {
    Node *tie = make_leaf();
    age_to_old(tie);
    garbage = make_ring(old_garbage);
    read_live(garbage); /* a release-triggered pass may promote it at once */
    if (scr_cyc_gen(scr_cyc_hdr(garbage)) == SCR_CYC_NURSERY) scr_collect_cycles();
    check(scr_cyc_gen(scr_cyc_hdr(garbage)) == SCR_CYC_MATURE, "survivor did not reach the mature generation");
    tie->other = garbage;
    garbage->rc++;
    garbage->other = tie;
    tie->rc++;
    release_live(tie); /* now held only by the ring */
  }
  check(scr_cyc_live < FLOOR, "live heap did not start below the growth floor");
  if (garbage) release_live(garbage); /* last outside owner gone */
  Node *first = make_leaf(); /* owned by old->other */
  first->next = old;
  old->rc++;
  old->other = first;
  release_live(old); /* external owner gone: a dead cycle with one old root */
  size_t old_before = scr_cyc_old_freed;
  for (size_t appended = 1; appended < limit; appended++) {
    Node *node = make_leaf(); /* takes over old's reference to the newest */
    node->next = old->other;
    old->other = node;
    Node *ring = make_ring(1);
    size_t live = scr_cyc_live;
    release_live(ring);
    if (scr_cyc_old_freed != old_before) {
      /* A mature pass that walks the mixed ring first promotes it. */
      size_t old_dead = scr_cyc_old_freed - old_before;
      check((mixed ? old_dead >= 2 && old_dead <= old_garbage + 2 : old_dead == old_garbage + 1)
              && scr_cyc_live < FLOOR / 2,
            "the full pass did not reclaim the dead old garbage whole");
      return live;
    }
  }
  check(false, "a dead cycle through the old generation outlived the growth cap");
  return 0;
}

/* Passes that keep finding nothing widen the old level's fraction up to the
 * configured cap and no further, two doublings per pass once two passes in a
 * row have asked: at the cap a dead cycle goes exactly when the heap has
 * grown the cap past the floor, not one doubling earlier (a narrower cap)
 * and not later (a wider or missing one). A pass that finds old garbage
 * narrows the fraction at once, and a single pass that finds nothing after
 * it does not widen it again. From where the ring below narrows it (two
 * doublings under any cap of 4 or more, the base fraction under 1 and 2),
 * the second pass in a row that finds nothing reaches the cap; widening a
 * doubling per pass would not. Runs last: it leaves the fraction narrowed
 * but not at the base. */
static void check_growth_cap_bounds_floating_garbage(void) {
  enum { FLOOR = 4096 };
  size_t cap = configured_growth_cap();
  /* Passes wait for the release trigger, and dead rings float until the
   * next restricted pass, so allow two nursery's worth. */
  size_t slack = 2 * configured_nursery_threshold() + 2;
  size_t narrowed = FLOOR + FLOOR * cap / 2 + slack;
  size_t due = FLOOR + FLOOR * cap;
  /* The previous test left the fraction at the cap. Old garbage narrows it
   * (see below); the pass after that is the first to find nothing and must
   * not widen it; the second in a row widens it to the cap. */
  grow_dead_cycle_until_full_pass(FLOOR / 2 - 64, false);
  size_t live = grow_dead_cycle_until_full_pass(0, false);
  check(live <= narrowed, "a pass that found old garbage did not narrow the growth fraction");
  live = grow_dead_cycle_until_full_pass(0, false);
  check(live <= narrowed, "a single pass that found nothing widened the growth fraction");
  live = grow_dead_cycle_until_full_pass(0, false);
  check(live > due, "two passes in a row that found nothing did not widen to the cap");
  check(live <= due + slack, "the growth fraction widened past the cap");
  live = grow_dead_cycle_until_full_pass(0, false);
  check(live > due && live <= due + slack, "the growth fraction left the cap");

  /* At any cap, old garbage of an eighth of the floor or more is a yield
   * that asks for at least one doubling less (this ring asks for two below
   * a cap of 2 or more), and narrowing does not wait for a second pass. */
  live = grow_dead_cycle_until_full_pass(FLOOR / 2 - 64, false);
  check(live > due && live <= due + slack, "a capped pass came early or late");
  live = grow_dead_cycle_until_full_pass(0, false);
  check(live <= narrowed, "a pass that found old garbage did not narrow the growth fraction");
}

/* A full pass's yield counts the mature members of its dead set: a dead
 * structure of mature and old objects is invisible to mature passes, so the
 * full pass that frees it found garbage only it could find, and narrows the
 * old level's fraction as old garbage does. Runs after the test above. */
static void check_mixed_dead_structure_narrows(void) {
  enum { FLOOR = 4096 };
  size_t cap = configured_growth_cap();
  size_t slack = 2 * configured_nursery_threshold() + 2;
  size_t narrowed = FLOOR + FLOOR * cap / 2 + slack;
  size_t due = FLOOR + FLOOR * cap;
  size_t live = 0;
  for (int i = 0; i < 4; i++) live = grow_dead_cycle_until_full_pass(0, false);
  check(live > due && live <= due + slack, "passes that found nothing did not settle at the cap");
  grow_dead_cycle_until_full_pass(FLOOR / 2 - 64, true);
  live = grow_dead_cycle_until_full_pass(0, false);
  check(live <= narrowed, "a pass that freed a dead mature and old structure did not narrow the growth fraction");
}

/* scr_cyc_set_growth_cap sets the cap SCR_CYCLE_GROWTH_CAP sets, and a
 * fraction already widened past it starts at it: after passes that found
 * nothing widened the old level's fraction to the configured cap, a cap of
 * 1 has the next dead cycle go once the heap has doubled past the floor.
 * Restores the configured cap. */
static void check_program_growth_cap(void) {
  enum { FLOOR = 4096 };
  if (getenv("SCR_CYCLE_GROWTH_CAP") != NULL) return; /* it takes precedence */
  size_t slack = 2 * configured_nursery_threshold() + 2;
  size_t live = 0;
  for (int i = 0; i < 4; i++) live = grow_dead_cycle_until_full_pass(0, false);
  check(live > FLOOR + FLOOR * configured_growth_cap(),
        "passes that found nothing did not widen the growth fraction to the cap");
  scr_cyc_set_growth_cap(1);
  for (int i = 0; i < 4; i++) {
    live = grow_dead_cycle_until_full_pass(0, false);
    check(live <= FLOOR + FLOOR + slack, "a program's growth cap of 1 did not bound the heap");
  }
  scr_cyc_set_growth_cap(0);
}

/* The phase sweep (scr_collect_cycles_phase) is for a caller that knows a
 * phase's data has just died: it sweeps, and the growth schedule starts
 * over. After passes that find nothing have widened the old level's
 * fraction to the cap, the plain sweep leaves the next dead cycle to the
 * cap, while after the phase sweep it goes once the heap has grown the base
 * quarter past the floor. */
static void check_phase_sweep_restarts_schedule(void) {
  enum { FLOOR = 4096 };
  size_t cap = configured_growth_cap();
  if (cap < 2) return; /* the base fraction is already the cap */
  size_t slack = 2 * configured_nursery_threshold() + 2;
  size_t due = FLOOR + FLOOR * cap;
  size_t live = 0;
  for (int i = 0; i < 4; i++) live = grow_dead_cycle_until_full_pass(0, false);
  check(live > due, "passes that found nothing did not widen the growth fraction to the cap");
  scr_collect_cycles();
  live = grow_dead_cycle_until_full_pass(0, false);
  check(live > due, "the plain sweep changed the growth schedule");
  scr_collect_cycles_phase();
  live = grow_dead_cycle_until_full_pass(0, false);
  check(live <= FLOOR + FLOOR / 4 + slack, "the phase sweep did not restart the growth schedule");
}

static void check_deep_ring(void) {
  enum { DEPTH = 100000 };
  size_t before = freed;
  Node *root = make_ring(DEPTH);
  root->rc++;
  release_live(root);
  scr_collect_cycles();
  check(freed == before, "deep live ring was reclaimed");
  Node *node = root;
  for (size_t i = 0; i < DEPTH; i++) {
    check(node->rc == (i == 0 ? 2u : 1u), "deep ring count not restored");
    node = node->next;
  }
  release_live(root);
  scr_collect_cycles();
  check(freed == before + DEPTH, "deep dead ring not reclaimed exactly");
}

static void check_shared_edges_and_outside_owner(void) {
  size_t before = freed;
  Node *root = make_ring(3);
  Node *shared = root->next;
  root->other = shared;
  shared->rc++; /* duplicate edge */
  shared->rc++; /* independent external owner */
  release_live(root);
  scr_collect_cycles();
  check(freed == before, "shared subgraph lost its outside owner");
  check(root->rc == 1 && shared->rc == 3 && shared->next->rc == 1,
        "duplicate edges were not restored once each");
  /* Several candidates overlap the same graph. */
  root->rc++;
  release_live(root);
  release_live(shared);
  scr_collect_cycles();
  check(freed == before + 3, "overlapping candidates were not reclaimed once");
}

static void check_repeated_buffered_release(void) {
  size_t before = freed;
  Node *root = make_ring(3);
  root->rc++;
  release_live(root);
  scr_collect_cycles();
  for (size_t i = 0; i < 1000; i++) {
    root->rc++;
    release_live(root);
  }
  check(freed == before && root->rc == 2,
        "repeated buffered releases changed live references");
  release_live(root);
  for (size_t i = 0; i < configured_nursery_threshold(); i++)
    scr_cyc_collect_scheduled();
  check(freed == before + 3, "buffered live-to-dead transition lost its root");
}

static void check_disconnected_survivors(void) {
  size_t before = freed;
  Node *first = make_ring(2);
  Node *second = make_ring(3);
  Node *dead = make_ring(4);
  scr_collect_cycles(); /* arm the trigger before buffering separate graphs */
  first->rc++;
  release_live(first);
  second->rc++;
  release_live(second);
  release_live(dead);
  scr_collect_cycles();
  check(freed == before + 4, "mixed live/dead components were misclassified");
  check(first->rc == 2 && first->next->rc == 1 &&
        second->rc == 2 && second->next->rc == 1,
        "a later outside root replayed earlier restored edges");
  release_live(first);
  release_live(second);
  scr_collect_cycles();
  check(freed == before + 9, "disconnected survivors were not later reclaimed");
}

static void check_cross_generation_edges(void) {
  size_t before = freed;
  Node *older = make_ring(2);
  older->rc++;
  release_live(older);
  scr_collect_cycles();
  Node *younger = make_ring(2);
  younger->other = older; /* transfer the older external owner */
  release_live(younger);
  scr_cyc_collect_scheduled();
  check(freed >= before + 2, "nursery cycle was not reclaimed");
  scr_collect_cycles();
  check(freed == before + 4, "cross-generation edge was not paid off");

  before = freed;
  older = make_ring(2);
  older->rc++;
  release_live(older);
  scr_collect_cycles();
  younger = make_ring(2);
  older->other = younger; /* transfer the younger external owner */
  younger->other = older;
  older->rc++;
  /* The nursery candidate is kept alive by an edge the restricted pass
   * cannot subtract. It must remain discoverable for the later full pass. */
  younger->rc++;
  release_live(younger);
  scr_cyc_collect_scheduled();
  check(freed == before, "cross-generation live cycle was reclaimed");
  release_live(older);
  scr_collect_cycles();
  check(freed == before + 4, "cross-generation cycle lost its candidate");
}

static void check_deep_cross_generation_chain(void) {
  enum { DEPTH = 100000 };
  size_t before = freed;
  Node *chain = NULL;
  for (size_t i = 0; i < DEPTH; i++) {
    static ScrCycType cyc_type = { &node_trace, &node_free, 0 };
    Node *node = scr_cyc_alloc(sizeof(*node), &cyc_type);
    node->rc = 1;
    node->next = chain;
    chain = node;
  }
  chain->rc++;
  release_live(chain);
  scr_collect_cycles(); /* promote the externally live chain */
  check(freed == before, "promotion freed an owned deep chain");
  Node *young = make_ring(2);
  young->other = chain; /* the last external owner moves into the nursery */
  release_live(young);
  scr_cyc_collect_scheduled();
  scr_collect_cycles();
  check(freed == before + DEPTH + 2,
        "cross-generation destruction leaked a deep chain");
}

static void check_teardown_rebuffers_and_immortals(void) {
  size_t before = freed;
  static Node immortal = { .rc = SIZE_MAX };
  Node *first = make_ring(2);
  Node *second = make_ring(2);
  first->other = &immortal;
  first->untraced = second; /* a plain-RC owner released by the teardown */
  release_live(first);
  scr_collect_cycles();
  check(freed == before + 4, "teardown candidate did not reach the fixpoint");
  check(immortal.rc == SIZE_MAX, "immortal edge was trial-deleted");
}

static void check_deferred_white_restoration(void) {
  enum { DEPTH = 4096 };
  size_t before = freed;
  Node *root = make_ring(DEPTH);
  Node *outside = root;
  for (size_t i = 0; i < DEPTH / 2; i++) outside = outside->next;
  outside->rc++;
  release_live(root);
  scr_collect_cycles();
  check(freed == before, "deferred white nodes lost an outside owner");
  Node *node = root;
  for (size_t i = 0; i < DEPTH; i++) {
    check(node->rc == (node == outside ? 2u : 1u),
          "deferred white restoration changed edge counts");
    node = node->next;
  }
  release_live(outside);
  scr_collect_cycles();
  check(freed == before + DEPTH, "restored deferred nodes leaked");
}

/* Nursery bypass (scr_cycle.c): candidates of an emitted type (kind != 0)
 * that keep surviving their nursery passes are promoted on release instead
 * of walked; dead cycles of that type are still found by older passes; and
 * once the type's objects die in nursery cycles again, the next probe window
 * finds that and it is walked again. Window, ratio and probe interval mirror
 * SCR_CYC_BYPASS_*. */
/* Tests only (SCR_CYC_TESTING): one pass at exactly `gen`, and the routing
 * of appended candidates whose type bypasses a level, which the next
 * scheduling decision or pass would do. */
size_t scr_cyc_pass_at(unsigned gen);
void scr_cyc_route_bypassed_at(void);
static size_t bypass_traced; /* trace calls on bypass-kind nodes */
static size_t bypass_freed;  /* bypass-kind nodes freed */
static void bypass_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  bypass_traced++;
  node_trace(obj, visit, ctx);
}
static void bypass_free(void *obj) {
  bypass_freed++;
  node_free(obj);
}
static ScrCycType bypass_type = { &bypass_trace, &bypass_free, 7 };

static Node *make_bypass_node(void) {
  Node *node = scr_cyc_alloc(sizeof(*node), &bypass_type);
  node->rc = 1;
  return node;
}

/* Run release-triggered passes, as a program does by releasing: a pass's
 * level then follows growth and backlogs only, never the scheduled age. */
static void run_release_passes(void) {
  for (size_t i = 0; i <= configured_nursery_threshold(); i++)
    release_live(make_ring(1));
}

/* Trace calls spent on PROBE fresh, externally owned bypass-kind
 * candidates. A full pass first resets the growth baselines, so the probe
 * never trips a mature or full pass: only nursery passes walk. */
static size_t probe_bypass_walks(Node **owned, size_t probe) {
  scr_collect_cycles();
  size_t before = bypass_traced;
  for (size_t i = 0; i < probe; i++) {
    owned[i] = make_bypass_node();
    read_live(owned[i]);
  }
  run_release_passes();
  return bypass_traced - before;
}

static void check_nursery_bypass(void) {
  enum { WINDOW = 8192, INTERVAL = 16, LIVE = 3 * WINDOW, PROBE = 4096, RINGS = 32 };
  Node **live = calloc(LIVE + 3 * PROBE, sizeof(*live));
  if (!live) scr_trap("cycle test: out of memory\n");
  size_t nlive = 0;

  /* A walked candidate costs two trace calls (markGray and the restoring
   * scan). Every survivor of the first window is walked; afterwards none is
   * until a probe window opens. */
  for (; nlive < LIVE; nlive++) {
    live[nlive] = make_bypass_node();
    read_live(live[nlive]);
  }
  size_t walks = probe_bypass_walks(live + nlive, PROBE);
  nlive += PROBE;
  check(walks < PROBE / 2, "a type whose candidates always survive was not bypassed");

  /* Dead rings of the bypassed type wait in the mature buffer for an older
   * pass, which finds them. */
  size_t before = bypass_freed;
  for (size_t r = 0; r < RINGS; r++) {
    Node *a = make_bypass_node(), *b = make_bypass_node();
    a->next = b;
    b->next = a;
    a->rc++; /* the outside owner */
    release_live(a);
  }
  run_release_passes();
  check(bypass_freed - before < 2 * RINGS, "bypassed dead rings were all walked by the nursery");
  scr_collect_cycles();
  check(bypass_freed - before == 2 * RINGS, "an older pass missed dead rings of a bypassed type");

  /* The same through the inline release path, which leaves the candidates
   * in the nursery buffer: the next pass routes them past the nursery. */
  before = bypass_freed;
  for (size_t r = 0; r < RINGS; r++) {
    Node *a = make_bypass_node(), *b = make_bypass_node();
    a->next = b;
    b->next = a;
    a->rc++;
    a->rc--;
    scr_cyc_released(a);
  }
  run_release_passes();
  check(bypass_freed - before < 2 * RINGS, "inline-buffered bypassed rings were walked by the nursery");
  scr_collect_cycles();
  check(bypass_freed - before == 2 * RINGS, "an older pass missed inline-buffered rings");

  /* Now the type's objects die in nursery cycles. Once INTERVAL windows'
   * worth of candidates went past the nursery, a probe window walks them
   * there again, and its yield turns the bypass off. A nursery pass after
   * each release walks the probe window's candidates at their own level:
   * the promoted rings pile up in older buffers, and an older pass the
   * growth schedule runs there would otherwise sweep probed candidates too
   * and leave the nursery's window unfinished. */
  for (size_t r = 0; r < (size_t)WINDOW * (INTERVAL + 2); r++) {
    Node *a = make_bypass_node(), *b = make_bypass_node();
    a->next = b;
    b->next = a;
    a->rc++;
    release_live(a);
    scr_cyc_pass_at(SCR_CYC_NURSERY);
  }
  scr_collect_cycles();
  walks = probe_bypass_walks(live + nlive, PROBE);
  nlive += PROBE;
  check(walks >= PROBE, "a type whose objects die in nursery cycles stayed bypassed");

  for (size_t i = 0; i < nlive; i++) {
    live[i]->rc = 0;
    scr_cyc_on_dead(live[i]);
    node_free(live[i]);
  }
  free(live);
  scr_collect_cycles();
}

/* The mature level's bypass: a type whose mature candidates keep surviving
 * goes straight to the old generation, its dead cycles are found by full
 * passes, and once its objects die at the mature level again it is judged
 * there again. Passes run at exact levels through the test entry point. */
static size_t mature_kind_freed;
static void mature_kind_free(void *obj) {
  mature_kind_freed++;
  node_free(obj);
}
static ScrCycType mature_kind_type = { &node_trace, &mature_kind_free, 8 };

static Node *make_mature_kind_node(void) {
  Node *node = scr_cyc_alloc(sizeof(*node), &mature_kind_type);
  node->rc = 1;
  return node;
}

/* How many of PROBE fresh, externally owned candidates a release buffers
 * straight into the old generation, by the time anything reads the buffers
 * (a release may append the candidate to the nursery buffer, which the next
 * decision routes past the levels its type bypasses). */
static size_t probe_old_on_release(Node **owned, size_t probe) {
  scr_collect_cycles(); /* reset the growth baselines: no pass runs below */
  size_t old = 0;
  for (size_t i = 0; i < probe; i++) {
    owned[i] = make_mature_kind_node();
    read_live(owned[i]);
    scr_cyc_route_bypassed_at();
    old += scr_cyc_gen(scr_cyc_hdr(owned[i])) == SCR_CYC_OLD;
  }
  return old;
}

static void check_mature_bypass(void) {
  enum { WINDOW = 8192, INTERVAL = 16, LIVE = 3 * WINDOW, PROBE = 4096, BATCH = 1024 };
  Node **live = calloc(LIVE + 2 * PROBE, sizeof(*live));
  Node **batch = calloc(BATCH, sizeof(*batch));
  if (!live || !batch) scr_trap("cycle test: out of memory\n");
  size_t nlive = 0;

  for (; nlive < LIVE; nlive++) {
    live[nlive] = make_mature_kind_node();
    read_live(live[nlive]);
  }
  /* Whatever passes those releases ran, put every node in the mature
   * generation as a candidate (any generation is sound), and walk them all
   * at that level: none dies. */
  scr_collect_cycles();
  for (size_t i = 0; i < nlive; i++) {
    scr_cyc_set_gen(scr_cyc_hdr(live[i]), SCR_CYC_MATURE);
    read_live(live[i]);
  }
  scr_cyc_pass_at(SCR_CYC_MATURE);
  size_t old = probe_old_on_release(live + nlive, PROBE);
  nlive += PROBE;
  check(old >= PROBE / 2, "a type whose mature candidates always survive kept its mature passes");

  /* Dead rings of it wait for a full pass, which finds them. */
  size_t before = mature_kind_freed;
  for (size_t r = 0; r < 32; r++) {
    Node *a = make_mature_kind_node(), *b = make_mature_kind_node();
    a->next = b;
    b->next = a;
    a->rc++;
    release_live(a);
  }
  scr_cyc_pass_at(SCR_CYC_NURSERY);
  scr_cyc_pass_at(SCR_CYC_MATURE);
  check(mature_kind_freed - before < 64, "rings past the mature level were all walked by it");
  scr_collect_cycles();
  check(mature_kind_freed - before == 64, "a full pass missed dead rings of a type past the mature level");

  /* Now its rings survive the nursery and die before the next mature pass.
   * The next probe window at the mature level measures that, and the type
   * is judged there again. */
  for (size_t round = 0; round < (size_t)WINDOW * (INTERVAL + 2) / BATCH; round++) {
    for (size_t r = 0; r < BATCH; r++) {
      Node *a = make_mature_kind_node(), *b = make_mature_kind_node();
      a->next = b;
      b->next = a;
      a->rc++; /* the outside owner */
      read_live(a);
      batch[r] = a;
    }
    scr_cyc_pass_at(SCR_CYC_NURSERY);
    for (size_t r = 0; r < BATCH; r++) release_live(batch[r]);
    scr_cyc_pass_at(SCR_CYC_MATURE);
  }
  scr_collect_cycles();
  old = probe_old_on_release(live + nlive, PROBE);
  nlive += PROBE;
  check(old < PROBE / 4, "a type whose objects die at the mature level stayed past it");

  for (size_t i = 0; i < nlive; i++) {
    live[i]->rc = 0;
    scr_cyc_on_dead(live[i]);
    node_free(live[i]);
  }
  free(live);
  free(batch);
  scr_collect_cycles();
}

/* A bypassing type whose dead cycles consist of several candidates: every
 * member of each ring here is released, so each is buffered on its own. A
 * sample kept at the nursery while its partners went past would always be
 * held alive by a partner's edge, and the type would keep bypassing while
 * all of its rings died young; a probe window keeps every member at the
 * nursery, so the rings die there and the bypass ends. */
static size_t paired_traced, paired_freed;
static void paired_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  paired_traced++;
  node_trace(obj, visit, ctx);
}
static void paired_free(void *obj) {
  paired_freed++;
  node_free(obj);
}
static ScrCycType paired_type = { &paired_trace, &paired_free, 10 };

static void check_probe_sees_candidate_rings(void) {
  /* Both members of a ring must be buffered before a pass walks either: with
   * a threshold of 1 every release collects, and the first member's pass
   * promotes the pair out of the nursery. */
  if (configured_nursery_threshold() < 2) return;
  enum { WINDOW = 8192, INTERVAL = 16, LIVE = 2 * WINDOW, RINGS = WINDOW * (INTERVAL + 2) / 2, PROBE = 1024 };
  Node **live = calloc(LIVE + PROBE, sizeof(*live));
  if (!live) scr_trap("cycle test: out of memory\n");
  size_t nlive = 0;
  for (; nlive < LIVE; nlive++) {
    live[nlive] = scr_cyc_alloc(sizeof(*live[nlive]), &paired_type);
    live[nlive]->rc = 1;
    read_live(live[nlive]);
    scr_cyc_pass_at(SCR_CYC_NURSERY);
  }
  scr_collect_cycles();
  size_t before = paired_freed;
  for (size_t r = 0; r < RINGS; r++) {
    Node *a = scr_cyc_alloc(sizeof(*a), &paired_type);
    Node *b = scr_cyc_alloc(sizeof(*b), &paired_type);
    a->rc = 2; /* b's edge and an owner */
    b->rc = 2; /* a's edge and an owner */
    a->next = b;
    b->next = a;
    release_live(a);
    release_live(b);
    scr_cyc_pass_at(SCR_CYC_NURSERY);
  }
  scr_collect_cycles();
  check(paired_freed - before == 2 * RINGS, "rings of candidates leaked");
  /* Nursery passes walk fresh candidates of the type again (two trace
   * calls each; see probe_bypass_walks). */
  size_t traced = paired_traced;
  for (size_t i = 0; i < PROBE; i++) {
    live[nlive] = scr_cyc_alloc(sizeof(*live[nlive]), &paired_type);
    live[nlive]->rc = 1;
    read_live(live[nlive++]);
  }
  run_release_passes();
  check(paired_traced - traced >= PROBE, "a type whose candidate rings die young stayed past the nursery");
  for (size_t i = 0; i < nlive; i++) {
    live[i]->rc = 0;
    scr_cyc_on_dead(live[i]);
    node_free(live[i]);
  }
  free(live);
  scr_collect_cycles();
}

/* A nursery pass re-buffers its survivors past the mature level when
 * their type bypasses it, even if the type's nursery candidates are
 * walked (here half of them die young, in rings). */
static ScrCycType young_dying_type = { &node_trace, &node_free, 9 };

static void check_rebuffer_past_mature(void) {
  enum { BATCH = 1024, ROUNDS = 24, PROBE = 1024 };
  Node **live = calloc((size_t)BATCH * ROUNDS + PROBE, sizeof(*live));
  if (!live) scr_trap("cycle test: out of memory\n");
  size_t nlive = 0;
  for (size_t round = 0; round < ROUNDS; round++) {
    for (size_t i = 0; i < BATCH; i++) {
      Node *keep = scr_cyc_alloc(sizeof(*keep), &young_dying_type);
      keep->rc = 1;
      read_live(keep);
      live[nlive++] = keep;
      Node *a = scr_cyc_alloc(sizeof(*a), &young_dying_type);
      Node *b = scr_cyc_alloc(sizeof(*b), &young_dying_type);
      a->rc = 2; /* b's edge and the outside owner */
      b->rc = 1;
      a->next = b;
      b->next = a;
      release_live(a); /* dead, buffered in the nursery */
    }
    scr_cyc_pass_at(SCR_CYC_NURSERY); /* frees the rings, re-buffers the rest */
    scr_cyc_pass_at(SCR_CYC_MATURE);  /* finds nothing */
  }
  scr_collect_cycles();
  for (size_t i = 0; i < PROBE; i++) {
    Node *keep = scr_cyc_alloc(sizeof(*keep), &young_dying_type);
    keep->rc = 1;
    read_live(keep);
    live[nlive++] = keep;
  }
  scr_cyc_pass_at(SCR_CYC_NURSERY);
  size_t old = 0;
  for (size_t i = nlive - PROBE; i < nlive; i++) old += scr_cyc_gen(scr_cyc_hdr(live[i])) == SCR_CYC_OLD;
  check(old >= PROBE / 2, "nursery survivors were re-buffered into a level their type bypasses");
  for (size_t i = 0; i < nlive; i++) {
    live[i]->rc = 0;
    scr_cyc_on_dead(live[i]);
    node_free(live[i]);
  }
  free(live);
  scr_collect_cycles();
}

/* Dead rings with one candidate each: fewer candidates than the nursery
 * threshold, but each candidate's release runs a pass once the live
 * cycle-headered count has grown by SCR_CYC_NURSERY_ALLOCATIONS (4096 in
 * scr_cycle.c) since the last one, so the dead nodes left uncollected stay
 * within that much plus the ring in hand. */
size_t scr_cyc_backlog_threshold_at(unsigned gen);
void scr_cyc_forget_backlog_at(unsigned gen);

/* A heap that grows while its mature buffer stays empty: every release is
 * of one old object, so the mature passes that growth brings have no
 * candidates and only widen the mature growth fraction. Until a mature pass
 * has had candidates, the backlog threshold widens with it, so a program
 * that then reads the structure it built does not walk a quarter of it at
 * once to find nothing. */
static void check_unjudged_backlog_follows_growth(void) {
  enum { LIVE = 65536 };
  Node **leaves = calloc(LIVE, sizeof(*leaves));
  if (!leaves) scr_trap("cycle test: out of memory\n");
  Node *anchor = make_leaf();
  age_to_old(anchor);
  scr_cyc_forget_backlog_at(SCR_CYC_MATURE);
  for (size_t i = 0; i < LIVE; i++) {
    leaves[i] = make_leaf();
    read_live(anchor);
  }
  check(scr_cyc_backlog_threshold_at(SCR_CYC_MATURE) > scr_cyc_live / 4,
        "an unjudged mature backlog stayed at a quarter of the live heap");
  drop_leaves(leaves, LIVE);
  anchor->rc--;
  scr_cyc_on_dead(anchor);
  node_free(anchor);
  free(leaves);
}

static void check_allocation_growth_runs_passes(void) {
  enum { RINGS = 80, NODES_PER_RING = 64, ALLOCATION_WINDOW = 4096 };
  scr_collect_cycles();
  size_t before = freed;
  for (size_t i = 0; i < RINGS; i++) release_live(make_ring(NODES_PER_RING));
  size_t dropped = (size_t)RINGS * NODES_PER_RING;
  check(freed > before, "allocation growth ran no pass");
  check(before + dropped - freed <= ALLOCATION_WINDOW + NODES_PER_RING,
        "dead rings outgrew the allocation window");
  scr_collect_cycles();
  check(freed - before == dropped, "dead rings survived a full collection");
}

/* Publication takes its objects out of the candidate buffers while it
 * walks them (scr_cyc_pub_take) and closes the slots when it ends
 * (scr_cyc_pub_fill); a refused publish puts its objects back first
 * (scr_cyc_pub_restore). The rings here are dropped before the publish, so
 * only their buffer entries keep them collectable. Rings taken and made
 * immortal are never walked again; rings put back are collected, like the
 * rings that were never taken. */
static size_t immortal_traced;

static void published_ring_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  if (((Node *)obj)->rc == SIZE_MAX) immortal_traced++;
  node_trace(obj, visit, ctx);
}

static void check_publication_takes_candidates(void) {
  enum { RINGS = 40, NODES_PER_RING = 8 };
  static ScrCycType cyc_type = { &published_ring_trace, &node_free, 0 };
  Node *roots[RINGS];
  uint32_t taken[RINGS];
  size_t before = freed;
  for (size_t i = 0; i < RINGS; i++) {
    roots[i] = make_ring_of(NODES_PER_RING, &cyc_type);
    roots[i]->rc++;
    release_live(roots[i]); /* buffered, still externally owned */
  }
  for (size_t i = 0; i < RINGS; i++)
    if (i % 3 != 0) release_live(roots[i]); /* garbage now */
  /* Low thresholds run passes while the rings are built, which can leave a
   * published root unbuffered: publication takes only buffered objects. */
  bool buffered[RINGS];
  for (size_t i = 0; i < RINGS; i++) {
    buffered[i] = i % 3 != 2 && scr_cyc_is_buffered(scr_cyc_hdr(roots[i]));
    if (buffered[i]) taken[i] = scr_cyc_pub_take(roots[i]);
  }
  for (size_t i = 0; i < RINGS; i++) {
    if (i % 3 == 0) { /* published: every node becomes immortal */
      Node *node = roots[i];
      do {
        Node *next = node->next;
        node->rc = SIZE_MAX;
        node = next;
      } while (node != roots[i]);
    } else if (i % 3 == 1 && buffered[i]) {
      scr_cyc_pub_restore(roots[i], taken[i]); /* refused */
    }
  }
  scr_cyc_pub_fill();
  scr_collect_cycles();
  size_t dropped = 0;
  for (size_t i = 0; i < RINGS; i++) dropped += i % 3 != 0;
  check(freed - before == dropped * NODES_PER_RING,
        "publication left the dropped rings uncollected, or collected a published one");
  check(immortal_traced == 0, "a pass walked a published ring");
}

/* scr_cyc_collect_set: a full-depth pass over the candidates in a set. The
 * others keep their slots for ordinary passes, unless the walk from a taken
 * one reaches them, in which case a dead one is freed and leaves its
 * buffer. */
static void *taken_slots[8];
static ScrCycSet taken = {taken_slots, 7};
static void take(void *obj) {
  size_t j = scr_cyc_set_slot(obj, taken.mask);
  while (taken.slots[j]) j = (j + 1) & taken.mask;
  taken.slots[j] = obj;
}

static void check_limited_pass(void) {
  enum { RING = 16 };
  /* The setup buffers four candidates that must stay buffered until the
   * limited pass; lower thresholds run scheduled passes in between. */
  if (configured_nursery_threshold() < 8) return;
  scr_collect_cycles();
  size_t before = freed;
  /* Candidates the filter refuses: a dead ring it must leave, and a ring
   * whose last outside reference is from a dead ring it takes. */
  Node *older = make_ring(RING);
  release_live(older);
  Node *reached = make_ring(RING);
  Node *fresh = make_ring(RING);
  fresh->other = reached;
  reached->rc++;
  release_live(reached); /* its owner's */
  release_live(fresh);
  /* A live candidate it takes. */
  Node *live = make_ring(RING);
  live->rc++;
  release_live(live);
  take(fresh);
  take(live);
  check(scr_cyc_collect_set(&taken, SCR_CYC_NURSERY) == 2 * RING,
        "limited pass did not free the taken ring and what it reached");
  check(freed - before == 2 * RING, "limited pass freed a live or refused candidate");
  check(scr_cyc_collect_set(&taken, SCR_CYC_OLD) == 0, "a second limited pass freed something");
  memset(taken_slots, 0, sizeof taken_slots);
  scr_collect_cycles();
  check(freed - before == 3 * RING, "the refused dead ring was not left for the next pass");
  release_live(live);
  scr_collect_cycles();
  check(freed - before == 4 * RING, "the live ring was not collected once dead");
}

/* A limited pass can reach a live candidate that keeps its buffer slot. */
static void check_limited_pass_spares_buffered_survivor(void) {
  enum { RING = 16 };
  if (configured_nursery_threshold() < 8) return;
  scr_collect_cycles();
  size_t before = freed;
  Node *kept = make_ring(RING);
  kept->rc++;
  release_live(kept); /* buffered, still externally owned */
  Node *root = make_ring(RING);
  root->other = kept;
  kept->rc++;
  release_live(root);
  take(root);

  check(scr_cyc_collect_set(&taken, SCR_CYC_NURSERY) == RING,
        "limited pass did not free exactly the taken ring");
  memset(taken_slots, 0, sizeof taken_slots);
  check(scr_cyc_gen(scr_cyc_hdr(kept)) == SCR_CYC_NURSERY,
        "a spared candidate was promoted out of the buffer that holds it");

  release_live(kept);
  scr_collect_cycles();
  check(freed - before == 2 * RING, "the spared ring was not collected once dead");
}

/* A full pass whose fullest candidate buffer is the old generation's (more
 * entries than a pass keeps between passes), with nursery candidates
 * beside it: every dead ring in either buffer is reclaimed, the live rings
 * keep their counts, and a second round collects through the buffers the
 * first one left behind. */
static void check_large_old_buffer_with_nursery_candidates(void) {
  enum { OLD = 70000, YOUNG = 300, RING = 2 };
  static Node *old[OLD];
  Node *young[YOUNG];
  for (int round = 0; round < 2; round++) {
    for (size_t i = 0; i < OLD; i++) {
      old[i] = make_ring(RING);
      read_live(old[i]);
    }
    scr_collect_cycles();
    for (size_t i = 0; i < OLD; i++) read_live(old[i]);
    scr_collect_cycles();
    check(scr_cyc_gen(scr_cyc_hdr(old[OLD - 1])) == SCR_CYC_OLD, "rings did not reach the old generation");
    size_t before = freed;
    for (size_t i = 0; i < OLD; i++)
      if (i % 2) release_live(old[i]); /* dead: only the ring edge remains */
      else read_live(old[i]);          /* live candidate */
    for (size_t i = 0; i < YOUNG; i++) {
      young[i] = make_ring(RING);
      if (i % 3) release_live(young[i]);
      else read_live(young[i]);
    }
    scr_collect_cycles();
    size_t young_dead = YOUNG - (YOUNG + 2) / 3;
    check(freed - before == (OLD / 2 + young_dead) * RING, "a dead ring was not reclaimed");
    for (size_t i = 0; i < OLD; i += 2) check(old[i]->rc == 2, "a live old ring lost a count");
    for (size_t i = 0; i < YOUNG; i += 3) check(young[i]->rc == 2, "a live young ring lost a count");
    before = freed;
    for (size_t i = 0; i < OLD; i += 2) release_live(old[i]);
    for (size_t i = 0; i < YOUNG; i += 3) release_live(young[i]);
    scr_collect_cycles();
    check(freed - before == (OLD / 2 + (YOUNG + 2) / 3) * RING, "the remaining rings were not reclaimed");
  }
}

/* Releases through scr_cyc_released append nursery candidates inline while
 * the window allows, and fall back to scr_cyc_on_release exactly when a
 * collection is due: the candidate that brings the buffered total to the
 * trigger runs the pass, as it would through the call. */
static void check_inline_buffering(void) {
  enum { MAX = 4096 };
  static Node *nodes[MAX];
  size_t threshold = configured_nursery_threshold();
  if (threshold > MAX) return;
  scr_collect_cycles();
  size_t before = traced;
  for (size_t i = 0; i < threshold; i++) {
    nodes[i] = make_ring(1);
    nodes[i]->rc--; /* drop the self edge: a live leaf held by its owner */
    nodes[i]->next = NULL;
    nodes[i]->rc++;
    nodes[i]->rc--;
    scr_cyc_released(nodes[i]);
    ScrCycHdr *h = scr_cyc_hdr(nodes[i]);
    if (i + 1 < threshold) {
      check(scr_cyc_is_buffered(h) && scr_cyc_gen(h) == SCR_CYC_NURSERY,
            "a nursery release did not buffer its candidate");
#if SCR_CYC_INLINE_BUFFERING
      check(scr_cyc_buffers.roots[SCR_CYC_NURSERY].v[scr_cyc_buf_index(h)] == nodes[i],
            "an inline append is not where the header says");
#endif
      check(traced == before, "a pass ran before the trigger");
    }
  }
  /* The last release reached the trigger: one nursery pass walked them all
   * and promoted the survivors, which wait in the mature buffer. */
  check(traced > before, "the release that reached the trigger did not collect");
  for (size_t i = 0; i < threshold; i++) {
    ScrCycHdr *h = scr_cyc_hdr(nodes[i]);
    check(scr_cyc_gen(h) == SCR_CYC_MATURE, "a nursery survivor was not promoted");
    check(nodes[i]->rc == 1, "a survivor lost its count");
  }
  size_t freed_before = freed;
  for (size_t i = 0; i < threshold; i++) {
    nodes[i]->rc = 0;
    scr_cyc_on_dead(nodes[i]);
    node_free(nodes[i]);
  }
  check(freed - freed_before == threshold, "the leaves were not freed");
  scr_collect_cycles();
}

/* The death rule: once objects have died outside passes (the live count
 * fell by 1/32 of the heap the last full pass left, here the floor's), a
 * full pass is due as soon as the heap has grown the base quarter past it,
 * however wide the growth fraction has become. With the old level's
 * fraction at the cap, the dead old ring below would otherwise wait until
 * the heap had grown to the cap. A fall that the pass it brings finds
 * nothing behind doubles the fall the next one needs. */
static size_t watched_freed;
static void watched_free(void *obj) {
  watched_freed++;
  node_free(obj);
}

/* Fresh live leaves that are never released, each followed by a dead
 * one-node ring, which keeps the release path running its passes without
 * buffering the leaves, until the watched ring is freed or `limit` leaves
 * have been made. Returns how many it made. */
static size_t grow_until_watched(Node **keep, size_t limit, size_t watched) {
  size_t n = 0;
  while (watched_freed < watched && n < limit) {
    keep[n++] = make_leaf();
    release_live(make_ring(1));
  }
  return n;
}

void scr_cyc_forget_event_loop_at(void);

/* Once the thread's event loop runs, the full pass a fall asks for waits
 * for the loop's next idle moment, unless the heap grows another quarter
 * first. A heap that shrinks while the pass waits does not cancel it. */
static void check_death_waits_for_idle(void) {
  enum { FLOOR = 4096, RING = 64, LEAVES = 1024 };
  static ScrCycType watched_type = { &node_trace, &watched_free, 0 };
  if (configured_growth_cap() < 4) return; /* growth alone is due about as soon */
  size_t limit = 2 * FLOOR + 2 * configured_nursery_threshold() + 2;
  size_t before_due = FLOOR + FLOOR / 4 + 2 * configured_nursery_threshold() + 2;
  Node **leaves = calloc(LEAVES, sizeof(*leaves));
  Node **keep = calloc(limit, sizeof(*keep));
  if (!leaves || !keep) scr_trap("cycle test: out of memory\n");
  for (int i = 0; i < 4; i++) grow_dead_cycle_until_full_pass(0, false);
  scr_cyc_note_event_loop();
  for (int round = 0; round < 3; round++) {
    Node *ring = make_ring_of(RING, &watched_type);
    age_to_old(ring);
    for (size_t i = 0; i < LEAVES; i++) leaves[i] = make_leaf();
    scr_collect_cycles();
    watched_freed = 0;
    drop_leaves(leaves, LEAVES);
    scr_cyc_collect_scheduled();
    release_live(ring);
    size_t grown = grow_until_watched(keep, before_due, RING);
    check(watched_freed == 0, "a fall brought a full pass while the event loop was busy");
    if (round == 0) {
      check(scr_cyc_collect_idle(), "the idle moment did not run the waiting full pass");
      check(watched_freed == RING, "the waiting full pass did not reclaim the dead old ring");
    } else if (round == 2) {
      drop_leaves(keep, grown);
      grown = 0;
      check(scr_cyc_collect_idle(), "a heap that shrank cancelled the waiting full pass");
      check(watched_freed == RING, "the waiting full pass did not reclaim the dead old ring after a shrink");
    } else {
      grown += grow_until_watched(keep + grown, limit - grown, RING);
      check(watched_freed == RING, "the waiting full pass did not run once the heap grew another quarter");
      check(!scr_cyc_collect_idle(), "a full pass ran at the idle moment after the due one had run");
    }
    drop_leaves(keep, grown);
    scr_collect_cycles();
  }
  scr_cyc_forget_event_loop_at();
  free(leaves);
  free(keep);
}

static void check_death_brings_full_pass(void) {
  enum { FLOOR = 4096, RING = 64, LEAVES = 1024 };
  static ScrCycType watched_type = { &node_trace, &watched_free, 0 };
  size_t cap = configured_growth_cap();
  if (cap < 4) return; /* growth alone is due about as soon */
  size_t limit = FLOOR + FLOOR / 4 + 2 * configured_nursery_threshold() + 2;
  Node **leaves = calloc(LEAVES, sizeof(*leaves));
  Node **keep = calloc(limit, sizeof(*keep));
  if (!leaves || !keep) scr_trap("cycle test: out of memory\n");
  /* Growth passes that find nothing widen the old fraction to the cap. */
  for (int i = 0; i < 4; i++) grow_dead_cycle_until_full_pass(0, false);

  Node *ring = make_ring_of(RING, &watched_type);
  age_to_old(ring);
  for (size_t i = 0; i < LEAVES; i++) leaves[i] = make_leaf();
  scr_collect_cycles();
  check(scr_cyc_live < FLOOR - LEAVES, "live heap did not start below the growth floor");
  watched_freed = 0;
  drop_leaves(leaves, LEAVES); /* gone by reference counting: the live count falls */
  scr_cyc_collect_scheduled(); /* a check reads the whole fall */
  release_live(ring); /* a dead old cycle */
  size_t grown = grow_until_watched(keep, limit, RING);
  check(watched_freed == RING, "the fall did not bring a full pass by the base fraction");
  drop_leaves(keep, grown);
  scr_collect_cycles();

  /* A fall with nothing behind it: the pass it brings finds nothing. */
  for (size_t i = 0; i < LEAVES; i++) leaves[i] = make_leaf();
  scr_collect_cycles();
  drop_leaves(leaves, LEAVES);
  scr_cyc_collect_scheduled();
  grown = grow_until_watched(keep, limit, 1);
  drop_leaves(keep, grown);
  /* So the next death pass needs twice the fall: 1/32 of the floor, enough
   * before, no longer is. */
  ring = make_ring_of(RING, &watched_type);
  age_to_old(ring);
  for (size_t i = 0; i < FLOOR / 32; i++) leaves[i] = make_leaf();
  scr_collect_cycles();
  watched_freed = 0;
  drop_leaves(leaves, FLOOR / 32);
  scr_cyc_collect_scheduled();
  release_live(ring);
  grown = grow_until_watched(keep, limit, RING);
  check(watched_freed == 0, "a fall smaller than the backed-off one brought a full pass");
  drop_leaves(keep, grown);
  scr_collect_cycles();
  check(watched_freed == RING, "the full sweep did not reclaim the dead old ring");
  free(leaves);
  free(keep);
}

/* An object whose type's trace is scr_cyc_no_children starts out
 * SCR_CYC_ACYCLIC and is never buffered. A pass that reaches it from a dead
 * cycle frees it with the cycle when the cycle held its last reference, and
 * otherwise leaves it SCR_CYC_ACYCLIC with its outside count. */
static void check_acyclic_objects(void) {
  static ScrCycType leaf_type = { &scr_cyc_no_children, &node_free, 0 };
  size_t before = freed;
  Node *leaf = scr_cyc_alloc(sizeof(*leaf), &leaf_type);
  ScrCycHdr *h = scr_cyc_hdr(leaf);
  check(h->buf == SCR_CYC_ACYCLIC && !scr_cyc_is_buffered(h), "acyclic object did not start acyclic");
  leaf->rc = 2; /* an outside owner and a temporary reference */
  release_live(leaf);
  check(h->buf == SCR_CYC_ACYCLIC, "release buffered an acyclic object");

  Node *first = make_ring(2);
  first->other = leaf;
  leaf->rc++;
  release_live(first);
  scr_cyc_pass_at(SCR_CYC_NURSERY);
  check(freed == before + 2, "nursery pass did not free the ring");
  check(leaf->rc == 1 && h->buf == SCR_CYC_ACYCLIC, "acyclic survivor lost its count or its mark");

  Node *second = make_ring(2);
  second->next->other = leaf;
  leaf->rc++;
  release_live(leaf); /* the outside owner lets go: only the ring holds it */
  check(h->buf == SCR_CYC_ACYCLIC, "release buffered an acyclic object");
  release_live(second);
  scr_collect_cycles();
  check(freed == before + 5, "acyclic object held only by a dead ring was not freed with it");
}

int main(void) {
  check_inline_buffering();
  check_old_garbage_reclaimed_while_growing();
  check_older_rings_into_old();
  check_cycle_spanning_mature_and_old();
  check_unproductive_backlog_backs_off();
  check_sparse_mature_backlog(1);
  check_sparse_mature_backlog(2);
  check_age_reset_when_last_mature_root_dies();
  check_dead_backlog_rearms_release_trigger();
  check_deep_ring();
  check_shared_edges_and_outside_owner();
  check_repeated_buffered_release();
  check_disconnected_survivors();
  check_deferred_white_restoration();
  check_cross_generation_edges();
  check_deep_cross_generation_chain();
  check_teardown_rebuffers_and_immortals();
  check_growth_schedule_follows_yield();
  check_growth_cap_bounds_floating_garbage();
  check_mixed_dead_structure_narrows();
  check_death_waits_for_idle();
  check_phase_sweep_restarts_schedule();
  check_death_brings_full_pass();
  check_nursery_bypass();
  check_mature_bypass();
  check_probe_sees_candidate_rings();
  check_rebuffer_past_mature();
  check_allocation_growth_runs_passes();
  check_publication_takes_candidates();
  check_limited_pass();
  check_limited_pass_spares_buffered_survivor();
  check_large_old_buffer_with_nursery_candidates();
  check_unjudged_backlog_follows_growth();
  check_acyclic_objects();
  check_program_growth_cap();
  printf("cycle collection checks passed: threshold=%zu growth_cap=%zu\n",
         configured_nursery_threshold(), configured_growth_cap());
  return 0;
}
