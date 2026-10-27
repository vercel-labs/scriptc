/* Counted lifetime regions (scr_region.c), driven the way emitted code
 * drives them: a ProgramLifetime class with the inline allocation fast
 * path, chunk-count retain/release and a visit, an ordinary class with an
 * emitted walker, and the runtime's own containers around them. Each mode
 * prints its checks to stdout; SCRIPTC_REGION_STATS=1 reports every release
 * attempt on stderr, which the driver (scr_region.test.ts) compares. */
#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#if !defined(_WIN32)
#include <sys/wait.h>
#include <unistd.h>
#endif

#ifdef SCR_WORKERS
#define TEST_TL _Thread_local
#else
#define TEST_TL
#endif

/* ── the "emitted" ProgramLifetime class ───────────────────────────── */

typedef struct Plain Plain;
typedef struct Node {
  size_t rc;
  struct Node *parent;
  ScrArr *kids;
  ScrMap *names;
  ScrUnion *tag;
  ScrClosure *fn;
  ScrDyn *data;
  Plain *plain;
  struct Node *other;
  double value;
} Node;

/* The emitted retain and release: nothing before the first region exists,
 * then only the calling thread's chunks of freeable regions. */
static ScrRgnChunk *counted_chunk(void *o) {
  if (!atomic_load_explicit(&scr_region_counting, memory_order_relaxed) || !o) return NULL;
  ScrRgnChunk *c = scr_rgn_chunk_of(o);
#ifdef SCR_WORKERS
  return c->owner == (void *)&scr_thread_hot ? c : NULL;
#else
  return c->owner ? c : NULL;
#endif
}

static void *node_retain(void *o) {
  ScrRgnChunk *c = counted_chunk(o);
  if (c) c->count++;
  return o;
}

static void node_release(void *o) {
  ScrRgnChunk *c = counted_chunk(o);
  if (c) c->count--;
}

static ScrArrOps node_ops = {node_retain, node_release, NULL};

/* ── the "emitted" ordinary class (acyclic, plain heap block) ────────── */

struct Plain {
  size_t rc;
  Node *node;
  Plain *next;
};

static void plain_release(void *p) {
  Plain *o = p;
  if (!o || o->rc == SIZE_MAX) return;
  if (--o->rc) return;
  node_release(o->node);
  plain_release(o->next);
  free(o);
}

static Plain *plain_new(Node *owned, Plain *next) {
  Plain *o = calloc(1, sizeof *o);
  o->rc = 1;
  o->node = owned;
  o->next = next;
  return o;
}

static void plain_walk(void *p, ScrRgnWalk *w) {
  Plain *o = p;
  scr_region_ref(w, o->node);
  scr_region_slot(w, o->next, plain_release);
}

/* A container entry point the type table does not list. */
static void opaque_release(void *p) { node_release(p); }

static const ScrRgnType types[] = {{node_release, NULL}, {plain_release, plain_walk}, {NULL, NULL}};

static void node_visit(void *p, ScrRgnWalk *w) {
  Node *n = p;
  scr_region_ref(w, n->parent);
  scr_region_slot(w, n->kids, scr_arr_release_v);
  scr_region_slot(w, n->names, scr_map_release_v);
  scr_region_slot(w, n->tag, scr_union_release_v);
  scr_region_slot(w, n->fn, scr_closure_release_v);
  scr_region_slot(w, n->data, scr_dyn_release_v);
  scr_region_slot(w, n->plain, plain_release);
  scr_region_ref(w, n->other);
}

static void node_release_fields(void *p) {
  Node *n = p;
  node_release(n->parent);
  scr_arr_release(n->kids);
  scr_map_release(n->names);
  scr_union_release(n->tag);
  scr_closure_release(n->fn);
  scr_dyn_release(n->data);
  plain_release(n->plain);
  node_release(n->other);
}

static const char *const node_fields[] = {"parent", "kids", "names", "tag", "fn", "data", "plain", "other", NULL};
static ScrRgnClass node_cls = {sizeof(Node), node_visit, node_release_fields, "Node", -1, node_fields};
static TEST_TL ScrRgnCursor node_cursor;

/* The emitted constructor: the inline fast path, else the runtime. */
static Node *node_new(double value) {
  Node *n;
  char *p = node_cursor.bump;
  if (p && p + sizeof(Node) <= node_cursor.limit) {
    node_cursor.bump = p + sizeof(Node);
    n = (Node *)p;
  } else n = scr_region_alloc(&node_cursor, &node_cls);
  n->rc = (size_t)1 << (sizeof(size_t) * 8 - 1); /* programLifetimeRc */
  n->value = value;
#ifdef SCR_RC_AUDIT
  scr_obj_lifetime_note(n);
#endif
  return n;
}

static double region(void) { return scr_region_create(types); }

static ScrArr *node_array(void) { return scr_arr_new_ops(&node_ops, 0); }

/* A closure whose first capture holds the closure itself (a cycle the
 * collector frees) and whose second holds `held` through `release`. */
static ScrClosure *cyclic_closure(Node *held, void (*release)(void *)) {
  ScrClosure *c = scr_closure_new(NULL, 2);
  c->caps[0] = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(c->caps[0], scr_closure_retain(c));
  c->caps[1] = scr_box_new_obj(node_retain, release, NULL);
  scr_box_set_ref(c->caps[1], held);
  return c;
}

static void *disposed[4096];
static size_t ndisposed;
static void note_disposed(void *obj) {
  if (ndisposed < sizeof disposed / sizeof *disposed) disposed[ndisposed++] = obj;
}

static bool was_disposed(const void *obj) {
  for (size_t i = 0; i < ndisposed; i++)
    if (disposed[i] == obj) return true;
  return false;
}

static const ScrMapOps node_names_ops = { NULL, NULL, NULL, node_retain, node_release, NULL, NULL };
static const ScrMapOps node_set_ops = { node_retain, node_release, NULL, NULL, NULL, NULL, NULL };

/* A graph exercising every walked shape, rooted at the returned node. */
static Node *build_graph(int n) {
  Node *root = node_new(0);
  root->kids = node_array();
  root->names = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_REF, &node_names_ops);
  ScrMap *set = scr_map_new(SCR_MAP_KEY_REF, SCR_MAP_VAL_F64, &node_set_ops);
  ScrDyn *list = scr_dyn_new_arr();
  for (int i = 0; i < n; i++) {
    Node *child = node_new(i + 1);
    child->parent = node_retain(root);
    char key[16];
    int len = snprintf(key, sizeof key, "k%d", i);
    ScrStr *k = scr_str_new(key, (size_t)len);
    scr_map_set_str_ref(root->names, k, node_retain(child));
    scr_str_release(k);
    scr_map_set_ref_f64(set, child, i);
    child->tag = scr_union_new_ref(1, node_retain(child), node_retain, node_release, NULL);
    child->plain = plain_new(node_retain(root), i % 2 ? plain_new(node_retain(child), NULL) : NULL);
    ScrDyn *ref = scr_dyn_new_typed_ref(child, node_retain, node_release, "Node", 4, NULL, NULL);
    scr_dyn_arr_push(list, ref);
    ScrArr *nested = scr_arr_new(SCR_ELEM_ARR, 0);
    ScrArr *inner = node_array();
    scr_arr_push_ref(inner, node_retain(child));
    scr_arr_push_ref(nested, inner);
    ScrBox *box = scr_box_new(SCR_BOX_ARR);
    scr_box_set_ref(box, nested);
    ScrClosure *fn = scr_closure_new(NULL, 1);
    fn->caps[0] = box;
    child->fn = fn;
    scr_arr_push_ref(root->kids, child); /* moves the constructor's reference */
  }
  ScrDyn *obj = scr_dyn_new_obj();
  scr_dyn_obj_set(obj, "list", 4, list);
  scr_dyn_obj_set(obj, "set", 3,
                  scr_dyn_new_typed_ref(set, scr_map_retain_v, scr_map_release_v, "Set<Node>", 9, NULL, NULL));
  scr_map_release(set);
  root->data = obj;
  return root;
}

static void check_owned_graph(void) {
  double r = region();
  scr_region_enter(r);
  Node *root = build_graph(100);
  scr_region_leave();
  Node *nodes[101] = {root};
  for (size_t i = 0; i < 100; i++) nodes[i + 1] = (Node *)(uintptr_t)root->kids->data[i];
  node_release(root);
  void (*hook)(void *) = scr_weak_dispose_hook;
  scr_weak_dispose_hook = note_disposed;
  scr_region_release(r);
  scr_weak_dispose_hook = hook;
  for (size_t i = 0; i < 101; i++) assert(was_disposed(nodes[i])); /* weak entries keyed by them go */
  puts("an owned graph of every walked shape is freed with its region");
}

static void check_outside_local(void) {
  double r = region();
  scr_region_enter(r);
  Node *keep = build_graph(10);
  scr_region_leave();
  scr_region_release(r); /* `keep` is a counted outside reference */
  assert(keep->value == 0 && keep->kids->len == 10);
  node_release(keep);
  scr_region_release(region()); /* creation retries the condemned region */
  puts("an outside reference keeps a region until it is dropped");
}

static void check_outside_container(void) {
  double r = region();
  scr_region_enter(r);
  Node *root = build_graph(3);
  Node *shared = node_new(7);
  scr_region_leave();
  ScrArr *outside = node_array();
  scr_arr_push_ref(outside, shared);
  ScrArr *kids = scr_arr_retain(root->kids); /* owned by the region and held outside */
  node_release(root);
  scr_region_release(r);
  scr_arr_release(kids);
  scr_region_release(region());
  assert(((Node *)(uintptr_t)outside->data[0])->value == 7);
  scr_arr_release(outside);
  scr_region_release(region());
  puts("ordinary objects referenced from outside keep what they reach");
}

static void check_cycles(void) {
  double r = region();
  scr_region_enter(r);
  Node *root = build_graph(2);
  Node *held = node_new(1);
  root->fn = cyclic_closure(held, node_release); /* an owned cycle */
  Node *dead = node_new(2);
  scr_region_leave();
  ScrClosure *garbage = cyclic_closure(dead, node_release);
  scr_closure_release(garbage); /* a dead cycle outside the region holds `dead` */
  node_release(root);
  scr_region_release(r);
  puts("owned cycles and dead outside cycles do not keep a region");
}

static void check_unwalked(void) {
  double r = region();
  scr_region_enter(r);
  Node *root = build_graph(2);
  Node *hidden = node_new(3);
  ScrClosure *fn = cyclic_closure(hidden, opaque_release);
  scr_closure_release(root->fn);
  root->fn = fn;
  scr_region_leave();
  node_release(root);
  scr_region_release(r); /* the walk cannot explain `hidden`'s reference */
  /* What the program does once it no longer needs the shape: */
  ScrClosure *drop = root->fn;
  root->fn = NULL;
  scr_closure_release(drop);
  scr_region_release(region());
  puts("references the walk cannot explain keep a region");
}

static void check_in_use(void) {
  double r = region();
  double other = region();
  scr_region_enter(r);
  Node *a = node_new(1);
  scr_region_enter(other);
  Node *b = node_new(2);
  b->other = node_retain(a); /* other → r */
  scr_region_leave();
  Node *c = node_new(3);
  scr_region_release(r); /* current: deferred */
  scr_region_leave();
  assert(a->value == 1 && c->value == 3);
  node_release(a);
  node_release(c);
  node_release(b);
  scr_region_release(region()); /* `other` still refers into r */
  scr_region_release(other);
  puts("regions in use or referenced by other regions are kept");
}

static void check_cursors(void) {
  double r = region();
  double s = region();
  Node *keep[3000];
  int n = 0;
  for (int round = 0; round < 3; round++) {
    scr_region_enter(r);
    for (int i = 0; i < 500; i++, n++) keep[n] = node_new(n + 1);
    scr_region_enter(s);
    for (int i = 0; i < 500; i++, n++) keep[n] = node_new(n + 1);
    scr_region_leave();
    scr_region_leave();
  }
  for (int i = 0; i < n; i++) assert(keep[i]->value == i + 1);
  for (int i = 0; i < n; i++) node_release(keep[i]);
  scr_region_release(r);
  scr_region_release(s);
  puts("allocation continues per class across region switches");
}

/* Dropping an outside reference to an ordinary object the walk reaches
 * leaves the region's count unchanged, so the retries at creation and
 * release skip the kept region. It is attempted again once the thread has
 * allocated SCR_RGN_RETRY_BYTES (8 MiB) in regions since its last attempt. */
static void check_retry_schedule(void) {
  double r = region();
  scr_region_enter(r);
  Node *root = build_graph(3);
  scr_region_leave();
  ScrArr *kids = scr_arr_retain(root->kids); /* owned by the region and held outside */
  node_release(root);
  scr_region_release(r);
  scr_arr_release(kids); /* no counted reference changes */
  scr_region_release(region()); /* skips r */
  double big = region();
  scr_region_enter(big);
  for (size_t i = 0; i < ((size_t)9 << 20) / sizeof(Node); i++) node_release(node_new(0));
  scr_region_leave();
  scr_region_enter(big); /* past the allocation volume: attempts r */
  scr_region_leave();
  scr_region_release(big);
  puts("a kept region is attempted again after enough region allocation");
}

/* SCRIPTC_REGION_DEBUG names what keeps a region: references the walk
 * does not find, by the classes of the chunk they point into, and owned
 * objects referenced from outside, by the field that holds them. */
static void check_debug_report(void) {
  double r = region();
  scr_region_enter(r);
  Node *root = node_new(1);
  root->kids = node_array();
  Node *child = node_new(2);
  child->parent = node_retain(root);
  scr_arr_push_ref(root->kids, child);
  Node *held = node_new(3);
  scr_region_leave();
  ScrArr *kids = scr_arr_retain(root->kids); /* owned by `root` and held outside */
  node_release(root);
  scr_region_release(r); /* kept by `held` and `kids` */
  scr_arr_release(kids);
  node_release(held);
  scr_region_release(region());
  puts("the debug report names what keeps a region");
}

/* A freed region's chunk serves the thread's next region, cleared where
 * the freed objects were. Sanitized builds never reuse a chunk. */
static void check_chunk_reuse(void) {
#ifndef SCR_RC_AUDIT
  double r = region();
  scr_region_enter(r);
  Node *first = node_new(7);
  first->other = node_retain(first);
  scr_region_leave();
  ScrRgnChunk *chunk = scr_rgn_chunk_of(first);
  node_release(first);
  scr_region_release(r);
  double s = region();
  scr_region_enter(s);
  Node *again = node_new(8);
  scr_region_leave();
  assert(scr_rgn_chunk_of(again) == chunk);
  assert(again->other == NULL && again->parent == NULL && again->kids == NULL);
  node_release(again);
  scr_region_release(s);
  puts("a freed region's chunk serves the next region, cleared");
#endif
}

static void check_poison(void) {
#if defined(SCR_RC_AUDIT) && !defined(_WIN32)
  double r = region();
  scr_region_enter(r);
  Node *stale = node_new(5);
  scr_region_leave();
  node_release(stale);
  scr_region_release(r);
  fflush(NULL);
  pid_t pid = fork();
  if (pid == 0) {
    freopen("/dev/null", "w", stderr); /* the sanitizer's report */
    volatile double v = stale->value;
    (void)v;
    _exit(0);
  }
  int status = 0;
  assert(waitpid(pid, &status, 0) == pid);
  assert(!(WIFEXITED(status) && WEXITSTATUS(status) == 0));
  puts("sanitized builds fault on any access to a freed region");
#endif
}

/* ── what is never freed: the default region, published objects ────── */

static void check_default_region(void) {
  double r = region();
  scr_region_enter(r);
  Node *a = node_new(1);
  scr_region_leave();
  scr_region_release(r);
  node_release(a);
  scr_region_enter(r); /* a released region takes no new objects */
  Node *d = node_new(4);
  scr_region_enter(1e15); /* never created */
  Node *e = node_new(5);
  scr_region_leave();
  scr_region_leave();
  assert(scr_rgn_chunk_of(d) == scr_rgn_chunk_of(e) && scr_rgn_chunk_of(d) != scr_rgn_chunk_of(a));
  scr_region_release(-1);
  scr_region_release(region());
  node_release(d);
  node_release(e);
  puts("objects outside every live region go to the default region");
}


static void check_published(void) {
  double r = region();
  scr_region_enter(r);
  Node *root = build_graph(2);
  scr_region_leave();
  root->rc = SIZE_MAX; /* what publication does to every object it reaches */
  scr_region_release(r);
  scr_region_release(region());
  assert(root->value == 0);
  puts("a published object pins its region");
}

#ifdef SCR_WORKERS
enum { THREADS = 4 };
static Node *published_node;
static atomic_uint finished;

static void *thread_main(void *arg) {
  uint64_t id = (uint64_t)(uintptr_t)arg;
  scr_context_enter(id);
  scr_init();
  scr_lib_init(0, NULL);
  for (int round = 0; round < 20; round++) {
    double r = region();
    scr_region_enter(r);
    Node *root = build_graph(50);
    for (int i = 0; i < 50; i++) {
      /* A foreign, published instance is read and referenced uncounted. */
      Node *seen = node_retain(published_node);
      assert(seen->value == 42);
      node_release(seen);
    }
    scr_region_leave();
    node_release(root);
    scr_region_release(r);
  }
  scr_region_release(1); /* another thread's region: not ours to release */
  atomic_fetch_add(&finished, 1);
  scr_context_cleanup();
  return NULL;
}

static void check_threads(void) {
  double r = region();
  scr_region_enter(r);
  published_node = node_new(42);
  scr_region_leave();
  published_node->rc = SIZE_MAX;
  pthread_t threads[THREADS];
  for (unsigned i = 0; i < THREADS; i++)
    assert(!pthread_create(&threads[i], NULL, thread_main, (void *)(uintptr_t)(i + 1)));
  for (unsigned i = 0; i < THREADS; i++) assert(!pthread_join(threads[i], NULL));
  assert(atomic_load(&finished) == THREADS);
  scr_region_release(r);
  puts("threads free their own regions; a shared published object pins its region");
}
#endif

int main(int argc, char **argv) {
  scr_init();
  scr_lib_init(argc, argv);
  const char *mode = argc > 1 ? argv[1] : "regions";
  if (!strcmp(mode, "regions")) {
    check_owned_graph();
    check_outside_local();
    check_outside_container();
    check_cycles();
    check_unwalked();
    check_in_use();
    check_cursors();
    check_retry_schedule();
    check_chunk_reuse();
    check_poison();
  } else if (!strcmp(mode, "debug")) {
    check_debug_report();
  } else if (!strcmp(mode, "retained")) {
    check_default_region();
    check_published();
#ifdef SCR_WORKERS
  } else if (!strcmp(mode, "threads")) {
    check_threads();
#endif
  } else return 2;
  return 0;
}
