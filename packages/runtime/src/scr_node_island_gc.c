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
 * when counts are inconsistent. */
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

/* One object of the walk: a headered native object, or (NI_REF) the
 * ScrNodeRef of an island handle box. `count` starts at the object's
 * reference count and loses one per reference the walk explains. */
enum { NI_OBJ = 1, NI_REF = 2 };
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
    if (n->kind == NI_OBJ && (n->count > 0 || !n->walked) && !n->black) {
      n->black = 1;
      if (n->walked) gc_push(n->key);
    }
    while (gc_nwork > 0) {
      void *obj = gc_work[--gc_nwork];
      gc_children(obj, gc_black_visit);
      gc_refs_of(obj, gc_lookup(obj)->pin, gc_black_ref);
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
    const void *ident = scr_ni_export_identity(exports[i]);
    if (ident != NULL && !gc_skip(ident)) gc_obj_node((void *)ident)->ident = (uint32_t)i + 1;
    gc_obj(scr_ni_export_value(exports[i]))->count--;
    gc_count();
  }
  if (!gc_failed) gc_blacken();
  last_len = gc_len;
  if (gc_failed) return 1;

  for (size_t i = 0; i < n; i++) {
    if (gc_rooted[i]) continue;
    NiGcNode *nd = gc_lookup(scr_ni_export_value(exports[i]));
    if (nd == NULL || nd->black) gc_rooted[i] = 1;
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

#endif
