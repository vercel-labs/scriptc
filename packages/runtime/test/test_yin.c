/* The young-in nursery (scr_cycle.c built with SCR_YIN): young objects
 * allocated as emitted constructors allocate them, released as emitted
 * release paths release them, and collected by nursery collections, trial
 * deletion and the full sweep. Every check must hold for any nursery size
 * (SCR_YOUNG_NURSERY_SIZE), including a one-object nursery that collects at
 * every allocation. */
#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct Plain {
  size_t rc;
} Plain;

typedef struct Obj Obj;
struct Obj {
  size_t rc;
  Obj *a;
  Obj *b;
  Plain *plain; /* untraced: released by the teardown, never visited */
};

static size_t freed, plain_freed, disposed;

static void check(bool condition, const char *message) {
  if (condition) return;
  fprintf(stderr, "young nursery test failed: %s\n", message);
  exit(EXIT_FAILURE);
}

_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  exit(EXIT_FAILURE);
}

size_t scr_cyc_pass_at(unsigned gen);

static void plain_release(Plain *p) {
  if (p && --p->rc == 0) {
    plain_freed++;
    free(p);
  }
}

static void obj_trace(void *o, ScrTraceVisit visit, void *ctx) {
  Obj *x = o;
  if (x->a) visit(x->a, ctx);
  if (x->b) visit(x->b, ctx);
}

/* The collector's teardown: untraced children only, then the block. */
static void obj_gcfree(void *o) {
  plain_release(((Obj *)o)->plain);
  freed++;
  scr_cyc_free(o);
}

static ScrCycType young_type = {&obj_trace, &obj_gcfree, 0, 0};
static ScrCycType mature_type = {&obj_trace, &obj_gcfree, 0, 0};

/* An emitted constructor: zeroed headered block, rc = 1, then the nursery. */
static Obj *young_new_of(ScrCycType *type) {
  Obj *o = scr_cyc_alloc(sizeof(Obj), type);
  o->rc = 1;
  scr_yin_enter(o);
  return o;
}
static Obj *young_new(void) { return young_new_of(&young_type); }

/* A runtime family that is not young (gen 0, trial deletion only). */
static Obj *mature_new(void) {
  Obj *o = scr_cyc_alloc(sizeof(Obj), &mature_type);
  o->rc = 1;
  return o;
}

static void release(Obj *o);
static void destroy(void *p) {
  Obj *o = p;
  release(o->a);
  release(o->b);
  plain_release(o->plain);
  freed++;
  scr_cyc_free(o);
}

/* An emitted release: the buffered-bit tests are what young objects rely on. */
static void release(Obj *o) {
  if (!o || o->rc == SIZE_MAX) return;
  if (--o->rc == 0) {
    scr_cyc_dead(o);
    scr_rc_destroy(o, destroy);
    return;
  }
  scr_cyc_released(o);
}

static Obj *retain(Obj *o) {
  if (o && o->rc != SIZE_MAX) o->rc++;
  return o;
}

/* h->a or h->b = v (v borrowed): unlink, then release the old value. */
static void store(Obj *h, int slot, Obj *v) {
  retain(v);
  Obj **f = slot == 0 ? &h->a : &h->b;
  Obj *old = *f;
  *f = v;
  release(old);
}

static unsigned gen_of(Obj *o) { return scr_cyc_gen(scr_cyc_hdr(o)); }
static bool buffered(Obj *o) { return scr_cyc_is_buffered(scr_cyc_hdr(o)); }

static void count_dispose(void *obj) {
  (void)obj;
  disposed++;
}

/* Everything collectable is collected and the live count is back. */
static void settle(size_t live, const char *what) {
  scr_collect_cycles();
  if (scr_cyc_live != live) {
    fprintf(stderr, "live %zu, expected %zu\n", scr_cyc_live, live);
    check(false, what);
  }
}

/* With a nursery of a few objects, a pair's first object is promoted before
 * the pair is linked, and the pair then waits for an older level's pass:
 * the exact checks need room for the pair. */
static bool small_nursery(void) {
  const char *size = getenv("SCR_YOUNG_NURSERY_SIZE");
  return size != NULL && atol(size) < 4;
}

static void check_dead_pair_and_live_ring(void) {
  size_t live = scr_cyc_live, before = freed;
  Obj *a = young_new(), *b = young_new();
  store(a, 0, b);
  store(b, 0, a);
  release(a);
  release(b);
  check(freed == before, "a young cycle died by reference counting");

  enum { RING = 10 };
  Obj *head = young_new(), *last = retain(head);
  for (int i = 1; i < RING; i++) {
    Obj *n = young_new();
    store(last, 0, n);
    release(last);
    last = n;
  }
  store(last, 0, head);
  release(last);
  settle(live + RING, "dead young pair not collected or live ring freed");
  check(freed == before + 2, "dead young pair not freed exactly");
  check(gen_of(head) != SCR_CYC_YOUNG && !buffered(head), "survivor not promoted unbuffered");
  release(head); /* an older release buffers the ring (and may collect it) */
  settle(live, "promoted ring not collected after its last reference");
  check(freed == before + 2 + RING, "promoted ring not freed exactly");
}

static void check_rc_deaths_leave_the_nursery(void) {
  enum { N = 300 };
  size_t live = scr_cyc_live, before = freed;
  Obj *objs[N];
  for (int i = 0; i < N; i++) objs[i] = young_new();
  /* Pairs (i, i+1) for even i; every third object dies by RC first. */
  for (int i = 0; i + 1 < N; i += 2) {
    store(objs[i], 0, objs[i + 1]);
    store(objs[i + 1], 0, objs[i]);
  }
  size_t rc_dead = 0;
  for (int i = 0; i < N; i += 6) {
    /* break the pair, then drop both: plain RC deaths of young objects */
    store(objs[i], 0, NULL);
    store(objs[i + 1], 0, NULL);
    release(objs[i]);
    release(objs[i + 1]);
    objs[i] = objs[i + 1] = NULL;
    rc_dead += 2;
  }
  check(freed == before + rc_dead, "young RC deaths not freed at once");
  /* Keep every fourth surviving pair alive from outside; drop the rest. */
  Obj *kept[N];
  size_t nkept = 0, dropped = 0;
  for (int i = 0; i < N; i += 2) {
    if (!objs[i]) continue;
    if ((i / 2) % 4 == 0) kept[nkept++] = objs[i];
    else {
      release(objs[i]);
      dropped += 2;
    }
    release(objs[i + 1]);
  }
  settle(live + 2 * nkept, "young pairs not collected after RC deaths");
  check(freed == before + rc_dead + dropped, "dead pairs not freed exactly");
  for (size_t k = 0; k < nkept; k++) {
    check(gen_of(kept[k]) != SCR_CYC_YOUNG, "kept pair not promoted");
    release(kept[k]);
  }
  settle(live, "kept pairs not collected after release");
}

static void check_dead_set_gives_up_outgoing_edges(void) {
  size_t live = scr_cyc_live, before = freed, plain_before = plain_freed;
  Obj *m = mature_new();  /* held from outside, and by the dead set */
  Obj *s = young_new();   /* survivor held from outside, and by the dead set */
  Obj *d1 = young_new(), *d2 = young_new();
  Plain *p = calloc(1, sizeof *p);
  p->rc = 1;
  d1->plain = p;
  store(d1, 0, d2);
  store(d2, 0, d1);
  store(d1, 1, m);
  store(d2, 1, s);
  release(d1);
  release(d2);
  check(m->rc == 2 && s->rc == 2, "setup counts");
  settle(live + 2, "dead set with outgoing edges not collected");
  check(freed == before + 2, "only the dead pair is freed");
  check(plain_freed == plain_before + 1, "untraced child of the dead set not released");
  check(m->rc == 1 && s->rc == 1, "dead set's outgoing edges not given up exactly once");
  check(gen_of(s) != SCR_CYC_YOUNG, "survivor not promoted");
  release(m);
  release(s);
  settle(live, "outside objects not freed at their last release");
}

static void check_older_holders_keep_young_alive(void) {
  size_t live = scr_cyc_live, before = freed;
  Obj *m = mature_new();
  Obj *y1 = young_new(), *y2 = young_new();
  store(y1, 0, y2);
  store(y2, 0, y1);
  store(m, 0, y1);
  release(y1);
  release(y2);
  settle(live + 3, "young cycle held by an older object was freed");
  check(freed == before, "nothing may be freed while the holder lives");
  release(m); /* m dies by RC; its release of y1 buffers the promoted cycle */
  settle(live, "cycle not collected after its older holder died");
  check(freed == before + 3, "holder and cycle not freed exactly");
}

static void check_trial_deletion_releases_into_the_nursery(void) {
  size_t live = scr_cyc_live, before = freed;
  Obj *m1 = mature_new(), *m2 = mature_new();
  Obj *y = young_new(), *z = young_new();
  store(m1, 0, m2);
  store(m2, 0, m1);
  store(m1, 1, y);   /* y's only reference: dies when the white set goes */
  store(m2, 1, z);   /* z keeps an outside reference */
  release(y);
  release(m1);
  release(m2);
  /* A trial-deletion pass alone walks the young objects at the nursery
   * level: y joins the white set (and leaves the nursery), z survives. */
  scr_cyc_pass_at(SCR_CYC_OLD);
  check(freed == before + 3, "white set and its only-held young child not freed");
  check(z->rc == 1, "outside-held young child damaged");
  check(small_nursery() || gen_of(z) == SCR_CYC_YOUNG, "trial deletion promoted a young survivor");
  release(z);
  settle(live, "nursery inconsistent after trial deletion freed young objects");
  check(freed == before + 4, "last young object not freed");

  /* A young cycle held only by a dead older cycle: one pass frees all. */
  before = freed;
  m1 = mature_new();
  m2 = mature_new();
  Obj *y1 = young_new(), *y2 = young_new();
  store(y1, 0, y2);
  store(y2, 0, y1);
  store(m1, 0, m2);
  store(m2, 0, m1);
  store(m1, 1, y1);
  release(y1);
  release(y2);
  release(m1);
  release(m2);
  scr_cyc_pass_at(SCR_CYC_OLD);
  check(freed == before + 4, "mixed dead structure not freed by one pass");
  settle(live, "nursery inconsistent after a mixed dead structure");
}

/* A dead structure whose root died young and that reaches beyond the
 * nursery: the nursery collection keeps it (an older object holds a young
 * member) and must leave a candidate, or nothing short of a full sweep
 * would ever reach it. */
static void check_dead_structures_beyond_the_nursery(void) {
  size_t live = scr_cyc_live, before = freed;
  Obj *r = young_new();
  Obj *a = mature_new(); /* a family that is not young: an array, say */
  Obj *n = young_new();
  r->a = a; /* moved in, never released: a is no candidate */
  store(a, 0, n);
  store(n, 0, r);
  release(n);
  release(r); /* the last outside reference, dropped while r is young */
  for (int i = 0; i < 1024 && freed == before; i++) scr_cyc_collect_scheduled();
  check(freed == before + 3, "dead structure reaching beyond the nursery never collected");
  settle(live, "structure beyond the nursery");
}

/* A type whose objects keep surviving stops entering the nursery for a
 * while, then is met again. */
static void check_types_that_do_not_die_young(void) {
  enum { KEPT = 5000, PROBE = 64 * 1024 };
  static ScrCycType kept_type = {&obj_trace, &obj_gcfree, 0, 0};
  size_t live = scr_cyc_live;
  Obj **kept = malloc(KEPT * sizeof *kept);
  for (int i = 0; i < KEPT; i++) kept[i] = young_new_of(&kept_type);
  scr_collect_cycles(); /* meets them all: none dies */
  Obj *out = young_new_of(&kept_type);
  check(gen_of(out) != SCR_CYC_YOUNG && !buffered(out), "surviving type still enters the nursery");
  release(out);
  bool met_again = false;
  for (int i = 0; i < 2 * PROBE && !met_again; i++) {
    Obj *probe = young_new_of(&kept_type);
    met_again = gen_of(probe) == SCR_CYC_YOUNG;
    release(probe);
  }
  check(met_again, "surviving type never met again");
  for (int i = 0; i < KEPT; i++) release(kept[i]);
  free(kept);
  settle(live, "surviving type left objects behind");
}

static void check_publication_takes_young_objects(void) {
  size_t live = scr_cyc_live;
  Obj *y1 = young_new(), *y2 = young_new(), *y3 = young_new();
  /* scr_pub_mark takes an object whose header reads as buffered, and
   * records the answer plus one as its position (0: nothing to restore). */
  if (buffered(y1)) {
    check((uint32_t)(scr_cyc_pub_take(y1) + 1) == 0 || small_nursery(), "young take recorded");
    scr_cyc_pub_fill();
  }
  check(gen_of(y1) != SCR_CYC_YOUNG && !buffered(y1), "published young object not taken");
  y1->rc = SIZE_MAX; /* published: immortal from here on */
  /* y3 took y1's nursery slot: its death and y2's must still find theirs. */
  release(y3);
  release(y2);
  settle(live + 1, "nursery inconsistent after a publish took a young object");
  /* A refused publish restores nothing for a young object: it stays out of
   * the nursery and every buffer, reachable from the refused graph. */
  Obj *y4 = young_new();
  uint32_t recorded = scr_cyc_pub_take(y4) + 1;
  check(recorded == 0, "young take recorded a position");
  scr_cyc_pub_fill();
  check(gen_of(y4) != SCR_CYC_YOUNG && !buffered(y4), "refused publish left the object young");
  release(y4);
  settle(live + 1, "refused young object not freed");
}

static void check_deep_young_structures(void) {
  enum { DEPTH = 200000 };
  static ScrCycType deep_type = {&obj_trace, &obj_gcfree, 0, 0};
  size_t live = scr_cyc_live, before = freed;
  /* A long live chain (deep marking), and a long dead chain closing a cycle. */
  Obj *keep = young_new_of(&deep_type), *at = retain(keep);
  for (int i = 1; i < DEPTH; i++) {
    Obj *n = young_new_of(&deep_type);
    store(at, 0, n);
    release(at);
    at = n;
  }
  release(at);
  Obj *head = young_new_of(&deep_type);
  at = retain(head);
  for (int i = 1; i < DEPTH; i++) {
    Obj *n = young_new_of(&deep_type);
    store(at, 0, n);
    release(at);
    at = n;
  }
  store(at, 0, head);
  release(at);
  release(head);
  settle(live + DEPTH, "deep young structures");
  check(freed == before + DEPTH, "dead chain not freed exactly");
  release(keep); /* an acyclic chain: freed by reference counting */
  check(freed == before + 2 * DEPTH, "live chain not freed at its release");
  settle(live, "deep young structures left objects behind");
}

static void check_collection_points_and_limited_passes(void) {
  size_t live = scr_cyc_live, before = freed;
  if (small_nursery()) return;
  Obj *a = young_new(), *b = young_new();
  store(a, 0, b);
  store(b, 0, a);
  release(a);
  release(b);
  scr_cyc_collect_scheduled(); /* a collection point collects the nursery */
  check(freed == before + 2, "collection point left young garbage");
  a = young_new();
  b = young_new();
  store(a, 0, b);
  store(b, 0, a);
  release(a);
  release(b);
  void *slots[4] = {0};
  ScrCycSet none = {slots, 3};
  check(scr_cyc_collect_set(&none, SCR_CYC_OLD) >= 2, "limited pass skipped the nursery");
  check(freed == before + 4, "limited pass left young garbage");
  check(scr_cyc_live == live, "limited pass live count");
}

static void check_weak_observers_see_young_deaths(void) {
  size_t live = scr_cyc_live, before = freed;
  disposed = 0;
  scr_weak_dispose_hook = count_dispose;
  Obj *a = young_new(), *b = young_new(), *c = young_new();
  store(a, 0, b);
  store(b, 0, a);
  release(a);
  release(b);
  release(c); /* RC death */
  settle(live, "weak observer case");
  scr_weak_dispose_hook = NULL;
  check(freed == before + 3 && disposed == 3, "weak dispose hook missed a young death");
}

int main(void) {
  check_dead_pair_and_live_ring();
  check_rc_deaths_leave_the_nursery();
  check_dead_set_gives_up_outgoing_edges();
  check_older_holders_keep_young_alive();
  check_trial_deletion_releases_into_the_nursery();
  check_dead_structures_beyond_the_nursery();
  check_types_that_do_not_die_young();
  check_publication_takes_young_objects();
  check_deep_young_structures();
  check_collection_points_and_limited_passes();
  check_weak_observers_see_young_deaths();
  const char *size = getenv("SCR_YOUNG_NURSERY_SIZE");
  printf("young nursery checks passed: size=%s\n", size ? size : "default");
  return 0;
}
