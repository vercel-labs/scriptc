/* White-box checks for the handle own-property table's two ownership rules
 * (scr_dyn_handle_props.c):
 *
 * 1. A class whose native object adopts and traces the table (ScrDynHandleOps
 *    .adopt_props) lets the collector reclaim an expando that refers back to
 *    its own handle. The fake class below is the same shape as the fetch
 *    classes: a cycle-headered native object that holds its property table.
 * 2. The serialization guard's visited set is an identity hash, so a wide
 *    JSON graph costs a lookup per object, not a scan over everything it has
 *    already visited.
 *
 * Built by scr_handle_props_cycle.test.ts with -DSCR_CYC_TESTING and the
 * core runtime plus scr_blob.c and scr_dyn_handle_props.c. */
#include "scr_runtime.h"

#include <assert.h>
#include <stdio.h>

/* The child and dyn-invoke units are out of this white-box link. Only the
 * member query is reached by the writes below; the fake class declares no
 * inherited members, so the borrowed `read` value is the answer. */
void scr_child_on_dyn(ScrChild *child, ScrStr *event, ScrDyn *listener) {
  (void)child;
  (void)event;
  (void)listener;
}

ScrDyn *scr_dyn_inherited_read(const ScrDyn *d, const ScrStr *key, ScrDyn *read) {
  (void)d;
  (void)key;
  return read;
}

#ifdef SCR_CYC_TESTING
extern size_t scr_dyn_handle_props_seen_probes(void);
#endif

/* The checked-dynamic keyed write (`h.k = v`), borrowing its operands. */
static void setkey(ScrDyn *recv, const char *key, size_t key_len, ScrDyn *value) {
  ScrStr *k = scr_str_new(key, key_len);
  scr_dyn_key_set(recv, k, value);
  scr_str_release(k);
}

typedef struct {
  size_t rc;
  ScrDyn *props; /* adopted from the table unit */
  int freed;
} FakeHandle;

static int fake_freed;

static void fake_trace(void *ptr, ScrTraceVisit visit, void *ctx) {
  FakeHandle *h = ptr;
  if (h->props) visit(h->props, ctx);
}

static void fake_gcfree(void *ptr) {
  fake_freed++;
  scr_cyc_free(ptr);
}

static void fake_destroy(void *ptr) {
  FakeHandle *h = ptr;
  scr_dyn_release(h->props);
  h->props = NULL;
  fake_gcfree(h);
}

static ScrCycType fake_cyc_type = {
    &fake_trace, &fake_gcfree, SCR_CYC_KIND_NONE, 0};

static void *fake_retain(void *ptr) {
  ((FakeHandle *)ptr)->rc++;
  return ptr;
}

static void fake_release(void *ptr) {
  FakeHandle *h = ptr;
  if (--h->rc == 0) {
    scr_cyc_dead(h);
    scr_rc_destroy(h, fake_destroy);
  } else {
    scr_cyc_released(h);
  }
}

static void fake_adopt_props(void *ptr, ScrDyn *props) {
  ((FakeHandle *)ptr)->props = props;
}

static const ScrDynHandleOps fake_ops = {
    "Response", &fake_retain, &fake_release, NULL, NULL, NULL, NULL,
    .adopt_props = &fake_adopt_props};

static FakeHandle *fake_new(void) {
  FakeHandle *h = scr_cyc_alloc(sizeof *h, &fake_cyc_type);
  h->rc = 1;
  h->props = NULL;
  h->freed = 0;
  return h;
}

/* 1. The table's value refers back to its handle: the collector reclaims
 * the handle, the table, the value and the handle box together. */
static void check_backreference_is_collected(void) {
  FakeHandle *h = fake_new();
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_FETCH_RESPONSE);
  fake_release(h); /* the constructor's reference becomes the box's */
  ScrDyn *value = scr_dyn_new_obj();
  setkey(value, "owner", 5, box);
  setkey(box, "context", 7, value);
  scr_dyn_release(value);
  scr_dyn_release(box);
  assert(h->rc == 1); /* the table's value holds the handle box */
  fake_freed = 0;
  scr_collect_cycles();
  assert(fake_freed == 1);
}

/* A handle that stays reachable keeps its table: an external reference to
 * the value makes the whole component survive the pass. */
static void check_reachable_backreference_survives(void) {
  FakeHandle *h = fake_new();
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_FETCH_RESPONSE);
  fake_release(h);
  ScrDyn *value = scr_dyn_new_obj();
  ScrDyn *root = scr_dyn_new_obj();
  setkey(value, "owner", 5, box);
  setkey(box, "context", 7, value);
  setkey(root, "keep", 4, value);
  scr_dyn_release(value);
  scr_dyn_release(box);
  fake_freed = 0;
  scr_collect_cycles();
  assert(fake_freed == 0);
  assert(h->props != NULL);
  scr_dyn_release(root); /* drops the external reference */
  fake_freed = 0;
  scr_collect_cycles();
  assert(fake_freed == 1);
}

/* 2. A wide graph with no handle in it costs one lookup per object. */
static void check_wide_guard_is_linear(void) {
  FakeHandle *h = fake_new();
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_FETCH_RESPONSE);
  fake_release(h);
  ScrDyn *one = scr_dyn_new_num(1);
  setkey(box, "context", 7, one);
  scr_dyn_release(one);
  scr_dyn_release(box);

  enum { WIDTH = 2000 };
  ScrDyn *wide = scr_dyn_new_arr();
  for (size_t i = 0; i < WIDTH; i++) {
    ScrDyn *item = scr_dyn_new_obj();
    scr_dyn_arr_push(wide, item);
  }
  ScrStr *consumer = scr_str_new("JSON.stringify", 14);
  size_t before = scr_dyn_handle_props_seen_probes();
  ScrDyn *kept = scr_dyn_handle_props_guard(wide, consumer);
  size_t probes = scr_dyn_handle_props_seen_probes() - before;
  assert(kept != NULL);
  assert(!scr_exc_pending());
  scr_dyn_release(kept);
  scr_str_release(consumer);
  /* The hash probes a few slots per object; the linear scan probed
   * WIDTH * WIDTH / 2 times. */
  if (probes > WIDTH * 4) {
    fprintf(stderr, "wide guard probes: %zu for %d objects\n", probes, WIDTH);
    assert(0);
  }
  scr_dyn_release(wide);
  scr_collect_cycles(); /* reclaims the handle and its table */
}

int main(void) {
  scr_init();
  scr_dyn_handle_install(SCR_DYNH_FETCH_RESPONSE, &fake_ops);
  scr_dyn_handle_props_install(0.0);
  check_backreference_is_collected();
  check_reachable_backreference_survives();
  check_wide_guard_is_linear();
  puts("handle property ownership and guard width ok");
  return 0;
}
