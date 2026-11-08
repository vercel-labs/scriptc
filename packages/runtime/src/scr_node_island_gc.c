/* Node islands: cross-heap cycle collection (scope-B milestone NI-8).
 * Linked with scr_node_island.c (the `nodeIsland` runtime feature).
 *
 * The two heaps hold each other through two tables. The export table holds
 * native values whose V8 representatives JavaScript uses
 * (scr_node_island_export.c), and the bridge's import table holds V8
 * objects the program uses (scr_node_island_handle.c). Each table is a root
 * for its own collector, so a cycle through both heaps (a native object
 * holding an island emitter whose listener is a native closure capturing
 * that object) was never freed by either side.
 *
 * Before V8's major GC marks, the bridge asks this unit which exports the
 * program's own roots still hold and what every other export reaches
 * across the boundary. The answer comes from a restricted trial deletion
 * (Bacon-Rajan) over the native subgraph under the exported values,
 * through the same trace functions the cycle collector uses (ScrCycType):
 *
 *  1. Walk every object reachable from an exported value and count, for
 *     each, the references that come from inside that subgraph or from the
 *     export table. An object with references left over is held from
 *     outside: from a root, or from an object the walk did not reach.
 *  2. Everything reachable from such an object is held natively (black).
 *     An export whose value is black is a root for V8; an import held by a
 *     black holder, or by anything outside the subgraph (its count is not
 *     explained by holders the walk saw), is a root too.
 *  3. For every other export, walk its white subgraph and list the imports
 *     and the other exports it reaches. V8 marks those when, and only
 *     when, it marks the export's representative.
 *
 * This never under-approximates what the program can reach. An edge the
 * walk does not count leaves a count unexplained, which only makes more
 * objects black; so does a reference from an object the walk did not
 * reach, and so does stopping the walk early (its budget). A white object
 * is reachable only through the export table, so the program can reach it
 * again only through a representative V8 still marks (the bridge roots any
 * export JavaScript touches during the marking that follows). V8's own
 * marker honors weak references, ephemerons (WeakMap) and
 * FinalizationRegistry on its side; native weak collections hold their
 * keys weakly and need the key in hand, so they open no path to a white
 * object.
 *
 * Holders of imports are island handle boxes and the pin table, which
 * holds a runtime promise standing for an island promise together with its
 * ref: a pinned object the walk reaches counts as the holder of its ref.
 *
 * The walk reads counts and calls trace functions only: it writes no
 * collector header and allocates nothing the collector sees. It refuses
 * to answer (the bridge then roots everything for that GC) while a cycle
 * collection is in progress, which it notices by a non-black header, and
 * when counts are inconsistent.
 *
 * The unit's last section keeps the entries that native weak collections
 * key by island objects: where they live decides when they end, which is
 * this collector's and V8's to say. */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

/* One object of the walk: a headered native object, (NI_REF) the
 * ScrNodeRef of an island handle box, or (NI_TWIN) the native object of a
 * twin class, which has no collector header. `count` starts at the object's
 * reference count and loses one per reference the walk explains. */
enum { NI_OBJ = 1, NI_REF = 2, NI_TWIN = 3 };
typedef struct {
  void *key;
  int64_t count;
  uint32_t stamp;  /* the reach walk that last saw it */
  uint32_t ident;  /* 1 + index of the analyzed export whose referent this is, else 0 */
  uint32_t id;     /* NI_REF: its import id (0: none) */
  uint32_t pin;    /* NI_OBJ: 1 + index of its first pin, else 0 */
  uint8_t kind;
  uint8_t black;   /* held natively */
  uint8_t walked;  /* NI_OBJ: its children were (or are queued to be) counted */
  uint8_t leaf;    /* NI_OBJ: a capsule's referent with no cycle header (gc_count_leaf) */
} NiGcNode;

static NiGcNode *gc_nodes = NULL;
static size_t gc_cap = 0, gc_len = 0;
static void **gc_work = NULL;
static size_t gc_nwork = 0, gc_work_cap = 0;
static bool gc_failed = false;
static size_t gc_budget = 0;

/* The pin table as the walk sees it: pinned object -> its pins. */
static void **gc_pin_obj = NULL, **gc_pin_ref = NULL;
static size_t gc_npins = 0;
static uint32_t *gc_pin_next = NULL; /* 1 + next pin of the same object */
static size_t gc_pin_next_cap = 0;
typedef struct {
  void *obj;
  uint32_t first; /* 1 + index */
} NiGcPinSlot;
static NiGcPinSlot *gc_pin_map = NULL;
static size_t gc_pin_map_cap = 0;

/* Answer buffers, reused across GCs. */
static uint32_t *gc_free = NULL;
static size_t gc_nfree = 0, gc_free_cap = 0;
static uint8_t *gc_rooted = NULL;
static uint32_t *gc_rstart = NULL, *gc_rlen = NULL;
static size_t gc_nexp_cap = 0;
static uint32_t *gc_reach = NULL;
static size_t gc_nreach = 0, gc_reach_cap = 0;

SCR_COLD static void gc_oom(void) { scr_trap("scriptc: out of memory\n"); }

static void *gc_realloc(void *p, size_t n) {
  void *q = realloc(p, n);
  if (q == NULL) gc_oom();
  return q;
}

static size_t gc_hash(const void *p) {
  uintptr_t x = (uintptr_t)p;
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33;
  return (size_t)x;
}

static NiGcNode *gc_find_slot(NiGcNode *table, size_t cap, const void *key) {
  size_t mask = cap - 1;
  for (size_t i = gc_hash(key) & mask;; i = (i + 1) & mask)
    if (table[i].key == NULL || table[i].key == key) return &table[i];
}

static void gc_grow(void) {
  size_t cap = gc_cap ? gc_cap * 2 : 1024;
  NiGcNode *table = calloc(cap, sizeof *table);
  if (table == NULL) gc_oom();
  for (size_t i = 0; i < gc_cap; i++)
    if (gc_nodes[i].key != NULL) *gc_find_slot(table, cap, gc_nodes[i].key) = gc_nodes[i];
  free(gc_nodes);
  gc_nodes = table;
  gc_cap = cap;
}

static NiGcNode *gc_lookup(const void *key) {
  if (gc_cap == 0 || key == NULL) return NULL;
  NiGcNode *n = gc_find_slot(gc_nodes, gc_cap, key);
  return n->key != NULL ? n : NULL;
}

/* The slot of `key`, initialized as a new node of `kind` with `count` when
 * it has none (*fresh). Node pointers stay valid until the next insertion. */
static NiGcNode *gc_insert(void *key, int kind, int64_t count, bool *fresh) {
  if ((gc_len + 1) * 2 > gc_cap) gc_grow();
  NiGcNode *n = gc_find_slot(gc_nodes, gc_cap, key);
  *fresh = n->key == NULL;
  if (*fresh) {
    memset(n, 0, sizeof *n);
    n->key = key;
    n->kind = (uint8_t)kind;
    n->count = count;
    gc_len++;
  } else if (n->kind != kind) { /* one pointer seen as two kinds: inconsistent */
    gc_failed = true;
  }
  return n;
}

static void gc_push(void *obj) {
  if (gc_nwork == gc_work_cap) {
    gc_work_cap = gc_work_cap ? gc_work_cap * 2 : 1024;
    gc_work = gc_realloc(gc_work, gc_work_cap * sizeof *gc_work);
  }
  gc_work[gc_nwork++] = obj;
}

/* Objects the walk does not enter: none, immortal, published or compact
 * (no count to explain; whatever they hold stays black). */
static bool gc_skip(const void *obj) {
  return obj == NULL || SCR_RC_COUNT(obj) >= SCR_RC_COMPACT_TAG;
}

/* An island handle box: its ref is an import. */
static bool gc_island_box(void *obj) {
  if (scr_cyc_type(scr_cyc_hdr(obj))->kind != SCR_CYC_KIND_DYN) return false;
  const ScrDyn *d = obj;
  return d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_NODE_ISLAND;
}

/* ── twins ────────────────────────────────────────────────────────────
 * The native object behind a twin box (scr_node_island_export.c) has no
 * collector header and no trace function, so the walk never enters it. It
 * counts the boxes that hold the object: one held by anything else (the
 * program's own boxes, a timer, a signal that follows it) is held natively,
 * and so are the exports of its twins, which keeps the island's object and
 * its listeners alive for as long as the program can still reach the
 * native one. What the object itself holds stays unexplained, that is,
 * held, as it is for the cycle collector. */
static void *gc_twin_object(void *obj) {
  if (scr_cyc_type(scr_cyc_hdr(obj))->kind != SCR_CYC_KIND_DYN) return NULL;
  const ScrDyn *d = obj;
  return scr_ni_twin_box(d) ? d->v.handle.ptr : NULL;
}

/* A walked box holds its twin object once. */
static void gc_count_twin(void *obj) {
  void *object = gc_twin_object(obj);
  if (object == NULL) return;
  bool fresh;
  gc_insert(object, NI_TWIN, (int64_t)*(const size_t *)object, &fresh)->count--;
}

static void gc_black_twin(void *obj) {
  NiGcNode *t = gc_lookup(gc_twin_object(obj));
  if (t != NULL) t->black = 1;
}

/* ── capsule referents without a cycle header ────────────────────────────
 * A record or class instance whose fields cannot form a cycle has no cycle
 * header, so its capsule's trace does not visit it, but the capsule holds it
 * once. The walk counts that reference and never enters the referent: it
 * has no trace function, and what it holds leads nowhere across the
 * boundary, except to a twin's object, whose count then stays unexplained
 * (it is held, by this referent). Without this count the referent always
 * looks held from outside, and every such record an island was handed
 * stays a root for good. */
static void *gc_leaf_of(void *obj) {
  if (scr_cyc_type(scr_cyc_hdr(obj))->kind != SCR_CYC_KIND_DYN) return NULL;
  const ScrDyn *d = obj;
  if (d->kind != SCR_DYN_TYPED_REF || d->v.typed_ref.traced) return NULL;
  return gc_skip(d->v.typed_ref.ptr) ? NULL : d->v.typed_ref.ptr;
}

static void gc_black_leaf(void *obj) {
  NiGcNode *leaf = gc_lookup(gc_leaf_of(obj));
  if (leaf != NULL) leaf->black = 1;
}

/* ── pins ─────────────────────────────────────────────────────────────── */

static void gc_pins_load(void) {
  gc_npins = scr_ni_gc_pins(&gc_pin_obj, &gc_pin_ref);
  size_t cap = 64;
  while (cap < gc_npins * 2) cap *= 2;
  if (cap > gc_pin_map_cap) {
    free(gc_pin_map);
    gc_pin_map = malloc(cap * sizeof *gc_pin_map);
    if (gc_pin_map == NULL) gc_oom();
    gc_pin_map_cap = cap;
  }
  memset(gc_pin_map, 0, gc_pin_map_cap * sizeof *gc_pin_map);
  if (gc_npins > gc_pin_next_cap) {
    gc_pin_next_cap = gc_npins * 2;
    gc_pin_next = gc_realloc(gc_pin_next, gc_pin_next_cap * sizeof *gc_pin_next);
  }
  size_t mask = gc_pin_map_cap - 1;
  for (size_t p = 0; p < gc_npins; p++) {
    size_t i = gc_hash(gc_pin_obj[p]) & mask;
    while (gc_pin_map[i].obj != NULL && gc_pin_map[i].obj != gc_pin_obj[p]) i = (i + 1) & mask;
    gc_pin_next[p] = gc_pin_map[i].obj != NULL ? gc_pin_map[i].first : 0;
    gc_pin_map[i].obj = gc_pin_obj[p];
    gc_pin_map[i].first = (uint32_t)p + 1;
  }
}

static uint32_t gc_pin_first(const void *obj) {
  if (gc_npins == 0) return 0;
  size_t mask = gc_pin_map_cap - 1;
  for (size_t i = gc_hash(obj) & mask; gc_pin_map[i].obj != NULL; i = (i + 1) & mask)
    if (gc_pin_map[i].obj == obj) return gc_pin_map[i].first;
  return 0;
}

/* ── phase 1: count the references the subgraph explains ──────────────── */

/* Every child of `obj` the walk counts: what its trace visits, plus the
 * counted references the cycle collector leaves untraced but that can lead
 * across the boundary (a dyn promise box's promise, a promise's untraced
 * dyn payload). Counting more owned edges is always sound: an edge the
 * walk counts is one it also follows. */
static void gc_children(void *obj, ScrTraceVisit visit) {
  const ScrCycType *type = scr_cyc_type(scr_cyc_hdr(obj));
  type->trace(obj, visit, NULL);
  if (type->kind == SCR_CYC_KIND_DYN) {
    const ScrDyn *d = obj;
    if (d->kind == SCR_DYN_PROMISE && d->v.promise != NULL) visit(d->v.promise, NULL);
  } else if (type->kind == SCR_CYC_KIND_PROMISE) {
    void *payload = scr_promise_untraced_dyn_payload(obj);
    if (payload != NULL) visit(payload, NULL);
  }
}

/* The refs `obj` holds across the boundary: an island box's ref, and the
 * refs of the pins of a pinned object. */
static void gc_refs_of(void *obj, uint32_t pin, void (*fn)(void *ref)) {
  if (gc_island_box(obj)) {
    size_t rc;
    uint32_t id;
    void *ref = scr_ni_gc_ref(obj, &rc, &id);
    if (ref != NULL) fn(ref);
  }
  for (uint32_t p = pin; p != 0; p = gc_pin_next[p - 1]) fn(gc_pin_ref[p - 1]);
}

/* The node of a headered object, created on first sight: the pin table
 * holds a pinned object once per pin, which the count starts without. */
static NiGcNode *gc_obj_node(void *obj) {
  bool fresh;
  NiGcNode *n = gc_insert(obj, NI_OBJ, SCR_RC_COUNT(obj), &fresh);
  if (fresh) {
    n->pin = gc_pin_first(obj);
    for (uint32_t p = n->pin; p != 0; p = gc_pin_next[p - 1]) n->count--;
  }
  return n;
}

/* Reached through a counted edge: queued for counting its own children. */
static NiGcNode *gc_obj(void *obj) {
  NiGcNode *n = gc_obj_node(obj);
  if (!n->walked && n->kind == NI_OBJ) {
    n->walked = 1;
    gc_push(obj);
  }
  return n;
}

static void gc_count_visit(void *child, void *ctx) {
  (void)ctx;
  if (gc_skip(child)) return;
  gc_obj(child)->count--;
}

static void gc_count_ref(void *ref) {
  size_t rc = 0;
  uint32_t id = 0;
  scr_ni_gc_ref_info(ref, &rc, &id);
  bool fresh;
  NiGcNode *n = gc_insert(ref, NI_REF, (int64_t)rc, &fresh);
  if (fresh) n->id = id;
  n->count--;
}

/* A walked capsule holds its header-less referent once. */
static void gc_count_leaf(void *obj) {
  void *leaf = gc_leaf_of(obj);
  if (leaf == NULL) return;
  NiGcNode *n = gc_obj_node(leaf);
  n->count--;
  n->leaf = 1;
}

/* Counts the subgraph under the queued objects, until the budget. */
static void gc_count(void) {
  while (gc_nwork > 0 && !gc_failed && gc_len <= gc_budget) {
    void *obj = gc_work[--gc_nwork];
    /* Outside a collection every live object is black. */
    if (scr_cyc_color(scr_cyc_hdr(obj)) != SCR_CYC_BLACK) {
      gc_failed = true;
      return;
    }
    gc_children(obj, gc_count_visit);
    gc_refs_of(obj, gc_lookup(obj)->pin, gc_count_ref);
    gc_count_twin(obj);
    gc_count_leaf(obj);
  }
  /* Left over when the budget ran out: their children were not counted,
   * so they must not pass for walked (they become black). */
  while (gc_nwork > 0) {
    NiGcNode *n = gc_lookup(gc_work[--gc_nwork]);
    if (n != NULL) n->walked = 0;
  }
}

/* ── phase 2: blacken what is held from outside ───────────────────────── */

static void gc_black_visit(void *child, void *ctx) {
  (void)ctx;
  if (gc_skip(child)) return;
  NiGcNode *n = gc_lookup(child);
  if (n != NULL && !n->black) {
    n->black = 1;
    if (n->walked) gc_push(child);
  }
}

static void gc_black_ref(void *ref) {
  NiGcNode *r = gc_lookup(ref);
  if (r != NULL) r->black = 1;
}

static void gc_blacken(void) {
  for (size_t i = 0; i < gc_cap; i++) {
    NiGcNode *n = &gc_nodes[i];
    if (n->key == NULL) continue;
    if (n->count < 0) { /* more references explained than counted */
      gc_failed = true;
      return;
    }
    /* Held from outside, or never walked: its children are unknown, and
     * what it holds is a root as far as this analysis can tell. */
    if (n->kind == NI_OBJ && (n->count > 0 || (!n->walked && !n->leaf)) && !n->black) {
      n->black = 1;
      if (n->walked) gc_push(n->key);
    }
    if (n->kind == NI_TWIN && n->count > 0) n->black = 1;
    while (gc_nwork > 0) {
      void *obj = gc_work[--gc_nwork];
      gc_children(obj, gc_black_visit);
      gc_refs_of(obj, gc_lookup(obj)->pin, gc_black_ref);
      gc_black_twin(obj);
      gc_black_leaf(obj);
    }
  }
}

/* ── phase 3: what each white export reaches ──────────────────────────── */

static uint32_t gc_stamp = 0;
static uint32_t gc_walk_export; /* 1 + index of the export being walked */
static const uint32_t *gc_exports_in;

static void gc_reach_add(uint32_t entry) {
  if (gc_nreach == gc_reach_cap) {
    gc_reach_cap = gc_reach_cap ? gc_reach_cap * 2 : 256;
    gc_reach = gc_realloc(gc_reach, gc_reach_cap * sizeof *gc_reach);
  }
  gc_reach[gc_nreach++] = entry;
}

static void gc_reach_visit(void *child, void *ctx) {
  (void)ctx;
  if (gc_skip(child)) return;
  NiGcNode *n = gc_lookup(child);
  if (n == NULL || n->black || n->stamp == gc_stamp) return;
  n->stamp = gc_stamp;
  /* Another white export's referent: V8 marks its representative, whose
   * own reach covers the rest. */
  if (n->ident != 0 && n->ident != gc_walk_export && !gc_rooted[n->ident - 1]) {
    gc_reach_add(gc_exports_in[n->ident - 1] | SCR_NODE_GC_EXPORT);
    return;
  }
  gc_push(child);
}

static void gc_reach_ref(void *ref) {
  NiGcNode *r = gc_lookup(ref);
  if (r != NULL && !r->black && r->count == 0 && r->id != 0 && r->stamp != gc_stamp) {
    r->stamp = gc_stamp;
    gc_reach_add(r->id);
  }
}

/* A white twin object the walked export reaches through a box: V8 marks
 * the object's twins (the other exports that stand for it) with the walked
 * export's representative. */
static void gc_reach_twin(void *obj) {
  void *object = gc_twin_object(obj);
  NiGcNode *t = gc_lookup(object);
  if (t == NULL || t->black || t->stamp == gc_stamp) return;
  t->stamp = gc_stamp;
  uint32_t ids[2];
  size_t n = scr_ni_twin_exports(object, ids);
  for (size_t i = 0; i < n; i++)
    if (ids[i] != gc_exports_in[gc_walk_export - 1]) gc_reach_add(ids[i] | SCR_NODE_GC_EXPORT);
}

/* White objects were all walked: an unwalked one is black. */
static void gc_reach_walk(void *start) {
  NiGcNode *s = gc_lookup(start);
  if (s == NULL || s->black) return;
  s->stamp = gc_stamp;
  gc_push(start);
  while (gc_nwork > 0) {
    void *obj = gc_work[--gc_nwork];
    gc_children(obj, gc_reach_visit);
    gc_refs_of(obj, gc_lookup(obj)->pin, gc_reach_ref);
    gc_reach_twin(obj);
  }
}

static void gc_reserve_exports(size_t n) {
  if (n <= gc_nexp_cap) return;
  size_t cap = gc_nexp_cap ? gc_nexp_cap : 64;
  while (cap < n) cap *= 2;
  gc_rooted = gc_realloc(gc_rooted, cap);
  gc_rstart = gc_realloc(gc_rstart, cap * sizeof *gc_rstart);
  gc_rlen = gc_realloc(gc_rlen, cap * sizeof *gc_rlen);
  gc_nexp_cap = cap;
}

static void gc_free_add(uint32_t id) {
  if (gc_nfree == gc_free_cap) {
    gc_free_cap = gc_free_cap ? gc_free_cap * 2 : 256;
    gc_free = gc_realloc(gc_free, gc_free_cap * sizeof *gc_free);
  }
  gc_free[gc_nfree++] = id;
}

/* Clears the table for a walk like the last one, dropping a table much
 * larger than that walk needs. */
static void gc_reset(size_t expect) {
  size_t want = 1024;
  while (want < expect * 2) want *= 2;
  if (gc_cap > 4 * want) {
    free(gc_nodes);
    gc_nodes = NULL;
    gc_cap = 0;
  } else if (gc_len > 0) {
    memset(gc_nodes, 0, gc_cap * sizeof *gc_nodes);
  }
  gc_len = 0;
  gc_nwork = 0;
  gc_nfree = 0;
  gc_nreach = 0;
  gc_failed = false;
}

/* The object export `e`'s representative stands for, as the walk counts
 * it: the export's identity, except for a promise. A promise's identity is
 * a plain cell the export table keeps (so a typed promise that crosses
 * twice is one export); the counted object is the promise itself. */
static const void *gc_referent(uint32_t e) {
  const ScrDyn *v = scr_ni_export_value(e);
  if (v != NULL && v->kind == SCR_DYN_PROMISE) return v->v.promise;
  if (v != NULL && scr_ni_twin_box(v)) return NULL; /* counted through its boxes (twins, above) */
  return scr_ni_export_identity(e);
}

/* The objects one analysis may walk before the exports it has not reached
 * yet count as held: a bounded pause, at the price of collecting their
 * cycles at a later GC. */
#define NI_GC_BUDGET ((size_t)1 << 20)

int scr_ni_host_gc_analyze(const uint32_t *exports, size_t n, ScrNodeGcResult *out) {
  static size_t last_len = 0;
  memset(out, 0, sizeof *out);
  gc_reset(last_len);
  gc_reserve_exports(n > 0 ? n : 1);
  out->rooted = gc_rooted;
  out->reach_start = gc_rstart;
  out->reach_len = gc_rlen;
  if (n == 0) return 0; /* nothing exported: no cycle can pass through V8 */
  gc_exports_in = exports;
  gc_budget = NI_GC_BUDGET + 8 * n;
  gc_pins_load();

  /* The exports in the bridge's order (newest first), each referent marked
   * so the walk recognizes it, and each value box, which the export table
   * holds once, counted from. Once the budget runs out the remaining
   * exports stay roots. */
  for (size_t i = 0; i < n; i++) {
    gc_rstart[i] = gc_rlen[i] = 0;
    ScrDyn *v = scr_ni_export_value(exports[i]);
    gc_rooted[i] = v == NULL || gc_skip(v);
  }
  for (size_t i = 0; i < n && !gc_failed; i++) {
    if (gc_rooted[i]) continue;
    if (gc_len > gc_budget) {
      gc_rooted[i] = 1;
      continue;
    }
    const void *ident = gc_referent(exports[i]);
    /* A native error's view: the error-view cache (scr_json.c) holds the
     * view and the error until nothing else does, so it is not a holder.
     * An error the program still holds keeps its export a root; otherwise
     * the cache's two references are explained like the table's. */
    ScrDyn *v = scr_ni_export_value(exports[i]);
    ScrError *error = v->kind == SCR_DYN_OBJ || v->kind == SCR_DYN_TYPED_REF ? scr_errdyn_err_of(v) : NULL;
    bool cached = false;
    if (error != NULL) {
      cached = scr_errdyn_view_of(error) == v;
      size_t boxed = v->kind == SCR_DYN_TYPED_REF && v->v.typed_ref.ptr == (void *)error;
      /* This call's reference, the cache's and the capsule's. */
      bool held = SCR_RC_COUNT(error) > 2 + boxed;
      scr_error_release(error);
      if (cached && held) {
        gc_rooted[i] = 1;
        continue;
      }
    }
    if (ident != NULL && !gc_skip(ident)) gc_obj_node((void *)ident)->ident = (uint32_t)i + 1;
    gc_obj(v)->count -= cached ? 2 : 1;
    gc_count();
    if (cached) {
      NiGcNode *held_error = gc_lookup(error);
      if (held_error != NULL && held_error->kind == NI_OBJ) held_error->count--;
    }
  }
  if (!gc_failed) gc_blacken();
  last_len = gc_len;
  if (gc_failed) return 1;

  for (size_t i = 0; i < n; i++) {
    if (gc_rooted[i]) continue;
    NiGcNode *nd = gc_lookup(scr_ni_export_value(exports[i]));
    if (nd == NULL || nd->black) gc_rooted[i] = 1;
    /* A box the export table alone holds still stands for its referent (a
     * closure, a typed capsule's object): held natively, the export is a
     * root, so its representative keeps its identity in V8's weak maps. */
    const void *ident = gc_referent(exports[i]);
    if (ident != NULL && ident != scr_ni_export_value(exports[i])) {
      NiGcNode *in = gc_lookup(ident);
      if (in != NULL && in->black) gc_rooted[i] = 1;
    }
    /* A twin's native object held by anything but the walked boxes. */
    NiGcNode *twin = gc_lookup(gc_twin_object(scr_ni_export_value(exports[i])));
    if (twin != NULL && twin->black) gc_rooted[i] = 1;
  }
  for (size_t i = 0; i < n; i++) {
    gc_rstart[i] = (uint32_t)gc_nreach;
    if (!gc_rooted[i]) {
      if (++gc_stamp == 0) { /* wrapped: clear the stamps */
        for (size_t k = 0; k < gc_cap; k++) gc_nodes[k].stamp = 0;
        gc_stamp = 1;
      }
      gc_walk_export = (uint32_t)i + 1;
      gc_reach_walk(scr_ni_export_value(exports[i]));
    }
    gc_rlen[i] = (uint32_t)gc_nreach - gc_rstart[i];
  }

  /* Imports whose every holder is white. */
  for (size_t k = 0; k < gc_cap; k++) {
    NiGcNode *r = &gc_nodes[k];
    if (r->key != NULL && r->kind == NI_REF && !r->black && r->count == 0 && r->id != 0)
      gc_free_add(r->id);
  }
  out->free_imports = gc_free;
  out->nfree_imports = gc_nfree;
  out->reach = gc_reach;
  out->visited = gc_len;
  return 0;
}

void scr_ni_gc_cleanup(void) {
  free(gc_nodes);
  free(gc_work);
  free(gc_free);
  free(gc_rooted);
  free(gc_rstart);
  free(gc_rlen);
  free(gc_reach);
  free(gc_pin_next);
  free(gc_pin_map);
  gc_nodes = NULL;
  gc_work = NULL;
  gc_free = NULL;
  gc_rooted = NULL;
  gc_rstart = gc_rlen = gc_reach = gc_pin_next = NULL;
  gc_pin_map = NULL;
  gc_cap = gc_len = gc_nwork = gc_work_cap = gc_free_cap = gc_nfree = 0;
  gc_nexp_cap = gc_nreach = gc_reach_cap = gc_pin_next_cap = gc_pin_map_cap = 0;
}

/* ── weak collections keyed by island objects ─────────────────────────────
 * A native WeakMap, WeakSet or FinalizationRegistry (scr_json.c) keys an
 * entry by a native pointer and ends it when the runtime frees that
 * pointer. An object a Node island made has no such pointer. The program
 * holds it through a handle, but the handle is not the object: it goes
 * when the program drops it, while the object lives on for as long as
 * island code reaches it, and comes back under a new handle. So the
 * entries a native weak collection keys by island objects are kept where
 * the keys are: in a WeakMap (or WeakSet) inside the island, one per
 * native collection, made with the first such entry and held by the native
 * collection through an ordinary handle. V8 compares the keys, and V8 ends
 * an entry when its key dies, or when the native collection does and
 * releases the island one.
 *
 * A value V8 stores must be a V8 value. undefined, null, booleans, numbers
 * and island objects cross as what they are and are stored as they are.
 * Every other value stays native: the entry holds a cell, a native object
 * with the value as its one property, which crosses by reference like any
 * native object (scr_node_island_export.c). The island never reads a cell;
 * it only keeps the cell's representative alive for as long as the entry
 * lives, and a lookup that answers the representative answers the cell. A
 * cell's value that reaches the entry's own key through the island is no
 * leak: the analysis above marks what a cell reaches only when V8 marks
 * its representative, which V8 does only while the key is alive. V8 frees
 * a cell's representative, and with it the cell and its value, at a major
 * collection after the entry ended. A delete or a replacing set does not
 * wait for that: the island side answers the cell that left the collection
 * and the value is released here at once.
 *
 * The island side is one function, compiled on first use from the text
 * below. It captures the intrinsics then, so later changes to the island's
 * WeakMap.prototype do not reach it. It is not part of the island bootstrap
 * (scr_node_island_host.cjs), which every island program carries and
 * parses at every start: nothing here is linked into, or run by, a program
 * that keys no weak collection by an island object. */
enum {
  NI_WEAK_NEW_MAP, NI_WEAK_NEW_SET,
  NI_WEAK_GET, NI_WEAK_SET, NI_WEAK_SET_CELL, NI_WEAK_HAS, NI_WEAK_DELETE,
  NI_WEAK_ADD, NI_WEAK_SET_HAS, NI_WEAK_SET_DELETE,
};
static const char ni_weak_source[] =
  "(function () {\n"
  "  const call = Function.prototype.call;\n"
  "  const M = WeakMap, S = WeakSet;\n"
  "  const get = call.bind(M.prototype.get), set = call.bind(M.prototype.set);\n"
  "  const has = call.bind(M.prototype.has), del = call.bind(M.prototype.delete);\n"
  "  const add = call.bind(S.prototype.add), setHas = call.bind(S.prototype.has);\n"
  "  const setDel = call.bind(S.prototype.delete);\n"
  "  // The representatives of cells, to tell a cell that leaves a map from\n"
  "  // an island object stored as itself.\n"
  "  const cells = new S();\n"
  "  const cell = (old) => (old !== undefined && setHas(cells, old) ? old : undefined);\n"
  "  return function scriptcWeak(op, collection, key, value) {\n"
  "    switch (op) {\n"
  "      case 0: return new M();\n"
  "      case 1: return new S();\n"
  "      case 2: return get(collection, key);\n"
  "      case 3:\n"
  "      case 4: {\n"
  "        const old = get(collection, key);\n"
  "        set(collection, key, value);\n"
  "        if (op === 4) add(cells, value);\n"
  "        return cell(old);\n"
  "      }\n"
  "      case 5: return has(collection, key);\n"
  "      case 6: {\n"
  "        const old = get(collection, key);\n"
  "        return del(collection, key) ? cell(old) ?? true : false;\n"
  "      }\n"
  "      case 7: add(collection, key); return undefined;\n"
  "      case 8: return setHas(collection, key);\n"
  "      default: return setDel(collection, key);\n"
  "    }\n"
  "  };\n"
  "})()";

/* The function above (+1), NULL until first use. One handle box per thread,
 * released when the thread ends: a box belongs to the heap of the thread
 * that made it, and a worker thread keys weak collections by island objects
 * too (its operations run on the island's thread, where the function is
 * compiled once per thread that asks; the cells set is that copy's). */
static SCR_TL ScrDyn *ni_weak_fn = NULL;

static void ni_weak_cleanup(void) {
  scr_dyn_release(ni_weak_fn);
  ni_weak_fn = NULL;
}

/* One operation of the island side (+1), or NULL with the exception
 * pending. */
static ScrDyn *ni_weak_call(int op, ScrDyn *collection, ScrDyn *key, ScrDyn *value) {
  if (ni_weak_fn == NULL) {
    ScrStr *name = scr_str_new("node:vm", 7);
    ScrDyn *vm = scr_ni_require(name);
    scr_str_release(name);
    if (vm == NULL) return NULL;
    ScrDyn *run = scr_ni_get_str(vm, "runInThisContext", 16);
    if (run != NULL) {
      ScrStr *text = scr_str_new(ni_weak_source, sizeof ni_weak_source - 1);
      ScrDyn *source = scr_dyn_new_str(text);
      scr_str_release(text);
      ni_weak_fn = scr_ni_call(run, vm, &source, 1);
      scr_dyn_release(source);
      scr_dyn_release(run);
    }
    scr_dyn_release(vm);
    if (ni_weak_fn == NULL) return NULL;
    scr_atexit(ni_weak_cleanup);
  }
  ScrDyn *code = scr_dyn_new_num(op);
  ScrDyn *args[4] = {code, collection != NULL ? collection : scr_dyn_undefined(),
                     key != NULL ? key : scr_dyn_undefined(),
                     value != NULL ? value : scr_dyn_undefined()};
  ScrDyn *result = scr_ni_call(ni_weak_fn, scr_dyn_undefined(), args, 4);
  scr_dyn_release(code);
  return result;
}

/* A cell that left its collection (the island side's answer to a delete or
 * a replacing set, consumed): its value is released now, not when V8 frees
 * the cell's representative. Any other answer is only released. */
static bool ni_weak_retire(ScrDyn *left) {
  bool cell = left->kind == SCR_DYN_OBJ;
  if (cell) scr_dyn_obj_set(left, "value", 5, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_release(left);
  return cell;
}

/* The value of the entry of island collection `collection` (NULL: the
 * native collection has none yet) keyed by island object `key`: +1,
 * undefined when there is no entry, or NULL with the exception pending. */
ScrDyn *scr_ni_weak_get(ScrDyn *collection, ScrDyn *key) {
  if (collection == NULL) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *stored = ni_weak_call(NI_WEAK_GET, collection, key, NULL);
  /* A native object here is a cell: no native object is stored as itself. */
  if (stored == NULL || stored->kind != SCR_DYN_OBJ) return stored;
  ScrDyn *value = scr_dyn_retain(scr_dyn_obj_get(stored, "value", 5));
  scr_dyn_release(stored);
  return value;
}

/* Whether `key` has an entry in `collection` (a WeakSet when `set`),
 * removing it when `remove`: 1 or 0, or -1 with the exception pending. */
int scr_ni_weak_test(ScrDyn *collection, bool set, ScrDyn *key, bool remove) {
  if (collection == NULL) return 0;
  int op = set ? (remove ? NI_WEAK_SET_DELETE : NI_WEAK_SET_HAS)
               : (remove ? NI_WEAK_DELETE : NI_WEAK_HAS);
  ScrDyn *found = ni_weak_call(op, collection, key, NULL);
  if (found == NULL) return -1;
  /* A removed entry answers true, or the cell it held. */
  bool answer = found->kind == SCR_DYN_BOOL && found->v.b;
  return ni_weak_retire(found) || answer;
}

/* Enters `key` (with `value`, unless the collection is a WeakSet) into the
 * island collection *collection, which is made first when the native
 * collection has none (+1 in *collection). False with the exception
 * pending. */
bool scr_ni_weak_set(ScrDyn **collection, bool set, ScrDyn *key, ScrDyn *value) {
  if (*collection == NULL) {
    *collection = ni_weak_call(set ? NI_WEAK_NEW_SET : NI_WEAK_NEW_MAP, NULL, NULL, NULL);
    if (*collection == NULL) return false;
  }
  ScrDyn *stored = NULL;
  int op = NI_WEAK_ADD;
  if (!set) {
    if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL ||
        value->kind == SCR_DYN_BOOL || value->kind == SCR_DYN_NUM || scr_ni_is_handle(value)) {
      stored = scr_dyn_retain(value);
      op = NI_WEAK_SET;
    } else {
      stored = scr_dyn_new_obj();
      scr_dyn_obj_set(stored, "value", 5, scr_dyn_retain(value));
      op = NI_WEAK_SET_CELL;
    }
  }
  ScrDyn *done = ni_weak_call(op, *collection, key, stored);
  scr_dyn_release(stored);
  if (done == NULL) {
    /* V8 holds every island object weakly but a registered symbol, which it
     * refuses with the TypeError a native collection has for a value it
     * cannot hold. The program called its own WeakMap, so the error is the
     * program's TypeError, not the island realm's with the island's frames. */
    ScrCaught *caught = scr_exc_take();
    ScrStr *text = scr_caught_to_string(caught);
    const char *message = set ? "Invalid value used in weak set" : "Invalid value used as weak map key";
    size_t len = strlen(message);
    bool refused = text->len == len + 11 && memcmp(text->data, "TypeError: ", 11) == 0 &&
                   memcmp(text->data + 11, message, len) == 0;
    scr_str_release(text);
    if (refused) scr_throw_error_msg(SCR_ERR_TYPE, message, len);
    else scr_rethrow(caught);
    scr_caught_release(caught);
    return false;
  }
  ni_weak_retire(done); /* the cell this entry replaced, if any */
  return true;
}

#endif
