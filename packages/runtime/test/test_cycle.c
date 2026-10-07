#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>

typedef struct Node Node;
struct Node {
  size_t rc;
  Node *next;
  Node *other;
  Node *untraced;
};

static size_t freed;

static size_t configured_nursery_threshold(void) {
  const char *env = getenv("SCR_CYCLE_THRESHOLD");
  long value = env ? strtol(env, NULL, 10) : 0;
  return value > 0 ? (size_t)value : 256;
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

static Node *make_ring(size_t count) {
  Node **nodes = calloc(count, sizeof(*nodes));
  if (!nodes) scr_trap("cycle test: out of memory\n");
  for (size_t i = 0; i < count; i++) {
    nodes[i] = scr_cyc_alloc(sizeof(*nodes[i]), node_trace, node_free);
    nodes[i]->rc = 1; /* the ring edge that will point at this node */
  }
  for (size_t i = 0; i < count; i++)
    nodes[i]->next = nodes[(i + 1) % count];

  Node *root = nodes[0];
  root->rc++; /* external owner */
  free(nodes);
  return root;
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
  leaf = scr_cyc_alloc(sizeof(*leaf), node_trace, node_free);
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
    leaves[i] = scr_cyc_alloc(sizeof(*leaves[i]), node_trace, node_free);
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
  Node *leaf = scr_cyc_alloc(sizeof(*leaf), node_trace, node_free);
  leaf->rc = 1;
  return leaf;
}

/* A temporary reference taken and dropped, as when a program reads it. */
static void read_live(Node *node) {
  node->rc++;
  scr_cyc_mark_live(node);
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
    scr_cyc_mark_live(root);
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
    Node *node = scr_cyc_alloc(sizeof(*node), node_trace, node_free);
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

int main(void) {
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
  printf("cycle collection checks passed: threshold=%zu\n",
         configured_nursery_threshold());
  return 0;
}
