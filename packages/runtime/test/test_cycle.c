#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>

typedef struct Node Node;
struct Node {
  size_t rc;
  Node *next;
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
}

static void node_free(void *obj) {
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

int main(void) {
  check_sparse_mature_backlog(1);
  check_sparse_mature_backlog(2);
  check_age_reset_when_last_mature_root_dies();
  printf("scheduled mature cycles collected: %zu threshold=%zu\n", freed,
         configured_nursery_threshold());
  return 0;
}
