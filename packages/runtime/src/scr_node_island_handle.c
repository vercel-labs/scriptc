/* Node islands: object handles (scope-B milestone NI-4). Linked with
 * scr_node_island.c into programs whose IR reaches Node.
 *
 * Island values the program holds are handles: a ScrNodeRef per V8 value,
 * naming an entry of the bridge's import table (a v8::Global), boxed as
 * SCR_DYN_HANDLE with tag SCR_DYNH_NODE_ISLAND. The bridge answers one id
 * per V8 value while the runtime holds it and the runtime keeps one ref per
 * id (ni_refs), so the same V8 object always comes back as the same ref:
 * `===` compares handle pointers and identity is exact. When the last box
 * releases a ref, the bridge drops its reference and V8 may collect the
 * object. Cycles across both heaps are collected by NI-8
 * (scr_node_island_gc.c): V8 keeps an import alive only while the runtime
 * may still use it.
 *
 * Boundary rules (DESIGN §2.5.1): undefined, null, booleans, numbers
 * (exact: -0, NaN), strings (WTF-8, lone surrogates kept) and BigInt are
 * copied; everything else is a handle. Island promises cross as scriptc
 * promises, one mirror per V8 promise while it lives, which reacts to the
 * V8 promise once native code reacts to it and runs the native reactions
 * inside V8's reaction job.
 * Typed arrays, Buffers, DataViews and ArrayBuffers cross as ScrBytes
 * over the same memory, one object per view and one per ArrayBuffer on each
 * side (below, "byte views"). Symbols cross as symbols: an island symbol is
 * a native symbol paired with it, the registry's and the well-known ones
 * by key and by name. Island errors thrown into the program become ScrErrors
 * with V8's name, message, stack and code, and become the original V8
 * error again when they cross back. Native errors cross by reference the
 * other way: one V8 Error per native error (an export), which is the
 * native error again when it crosses back.
 *
 * Runtime objects paired with a V8 value (a promise, an error, a byte view,
 * the storage of an ArrayBuffer, a symbol) are "pinned": the table below
 * holds the object and its ref, and a lazy sweep at bridge entries releases
 * both once the table holds the object's last reference. While the program
 * holds the object, the import is a root for V8, so each half of the pair
 * crosses as the other and identity holds in both directions. Native
 * objects and arrays that are not island values
 * cross by JSON copy until NI-5's exports (a documented NI-4 shortcut). */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

typedef struct ScrNodeRef {
  size_t rc;
  uint32_t id;
  uint32_t flags; /* SCR_NVF_* */
  /* NI-7: a stub of a deferred island module's value (id 0) carries its
   * interface-snapshot entry (scr_node_island_boot.c) until Node starts and
   * the boot unit reconciles it with the real value. `alias`: the real ref
   * when the value already had one (identity split, traced). */
  void *stub;
  struct ScrNodeRef *alias;
  /* NI-5d: a native subclass of an island class not created yet: the
   * seven subclass arguments (retained), created on first need. */
  ScrDyn **lazy;
  uint32_t pin; /* 1 + the index of the pin that pairs it with a runtime object; 0: none */
  /* An island function's identity root (owned, made on first need): the
   * closure every typed view of the function adopts as its identity. It is
   * only ever compared, never called, retained or released, so it is a
   * plain block this ref frees: `fn` marks it as such a root and the slot
   * after the header names this ref (nh_function_of_identity). A view keeps
   * the function's handle, and so this ref, alive through its capture. */
  ScrClosure *identity;
} ScrNodeRef;

static ScrNodeRef **ni_refs = NULL; /* by bridge id */
static size_t ni_refs_cap = 0;
static bool ni_stopped = false;

SCR_COLD static void nh_oom(void) { scr_trap("scriptc: out of memory\n"); }

static const ScrNodeBridge *nh_bridge(void) { return scr_ni_bridge(); }

/* ── pinned runtime objects ──────────────────────────────────────────── */

/* NH_PIN_BYTES pairs a view object with a V8 view; NH_PIN_BUFFER pairs the
 * owner of a storage with a V8 ArrayBuffer. An owner typed array is both a
 * view and its own storage, so one ScrBytes can carry one pin of each. It
 * usually carries only the view's: the V8 ArrayBuffer made with its view
 * needs no handle of its own until V8 hands it back, and is then known by
 * its memory (`keyed`). */
/* NH_PIN_NATIVE_ERROR: an error native code made, pinned to the V8 error it
 * crossed as (scr_ni_error_link). The others are views of V8 values. */
enum {
  NH_PIN_PROMISE = 1,
  NH_PIN_ERROR = 2,
  NH_PIN_BYTES = 3,
  NH_PIN_BUFFER = 4,
  NH_PIN_SYMBOL = 5,
  NH_PIN_NATIVE_ERROR = 6,
};

typedef struct {
  void *obj; /* retained; its reference count is the first word */
  ScrNodeRef *ref; /* retained */
  int kind;
  /* Bytes: the V8 backing stores over this storage, each of which holds
   * one reference to it until V8 frees the store (scr_ni_bytes_free).
   * Counted on the storage's pin, or on the object's view pin when that
   * is the only one. */
  uint32_t stores;
  /* A view pin that stands for its storage too: the index also finds it by
   * the storage's memory. */
  bool keyed;
  /* The storage of an island buffer: a view was made over it since it was
   * last found without one (nh_idle_storage). */
  bool used;
} NhPin;

static NhPin *nh_pins = NULL;
static size_t nh_npins = 0, nh_pins_cap = 0, nh_sweep_at = 64;
/* Pins from here on were made since the last entry (nh_enter). Most pair a
 * value that crossed once and is dropped again at once, a chunk of a
 * stream: the next entry looks at these alone, so their V8 halves stop
 * being roots while V8 still counts them young. */
static size_t nh_young = 0;
/* The storage of an island buffer whose last view went at the previous
 * entry (borrowed: its pin holds it). It keeps its pin for one more entry,
 * so the next chunk an island cuts from the same buffer (Node's pooled
 * Buffers, a library's own slab) finds it again instead of pairing the
 * buffer anew; unused by then, it goes. */
static ScrBytes *nh_idle_storage = NULL;

/* Pinned object -> its pin, open addressing over a power-of-two table at
 * most half full. The key is the object's address; a storage pin sets the
 * low bit (objects are allocations, so the bit is free), which keeps the
 * two pins of an owner typed array apart. */
typedef struct {
  uintptr_t key; /* 0: empty */
  uint32_t pin;  /* 1 + index into nh_pins */
} NhPinSlot;
static NhPinSlot *nh_pin_index = NULL;
static size_t nh_pin_index_cap = 0, nh_pin_index_len = 0;

static void nh_ref_release(ScrNodeRef *ref);
static ScrNodeRef *nh_ref(uint32_t id, uint32_t flags);

static uintptr_t nh_pin_key(const void *obj, int kind) {
  return (uintptr_t)obj | (kind == NH_PIN_BUFFER ? 1u : 0u);
}

/* The key of the memory a storage owns (an allocation of its own, so the
 * second bit is free and no object's key equals it). */
static uintptr_t nh_data_key(const void *data) { return (uintptr_t)data | 2u; }

static size_t nh_pin_hash(uintptr_t x) {
  x ^= x >> 33;
  x *= (uintptr_t)0xff51afd7ed558ccdULL;
  x ^= x >> 29;
  return (size_t)x;
}

static NhPinSlot *nh_pin_slot(uintptr_t key) {
  if (nh_pin_index_cap == 0) return NULL;
  size_t mask = nh_pin_index_cap - 1;
  for (size_t i = nh_pin_hash(key) & mask;; i = (i + 1) & mask) {
    if (nh_pin_index[i].key == 0) return NULL;
    if (nh_pin_index[i].key == key) return &nh_pin_index[i];
  }
}

static void nh_pin_index_put(uintptr_t key, uint32_t pin) {
  if ((nh_pin_index_len + 1) * 2 > nh_pin_index_cap) {
    size_t cap = nh_pin_index_cap ? nh_pin_index_cap * 2 : 64;
    NhPinSlot *grown = calloc(cap, sizeof *grown);
    if (grown == NULL) nh_oom();
    for (size_t i = 0; i < nh_pin_index_cap; i++) {
      if (nh_pin_index[i].key == 0) continue;
      size_t j = nh_pin_hash(nh_pin_index[i].key) & (cap - 1);
      while (grown[j].key != 0) j = (j + 1) & (cap - 1);
      grown[j] = nh_pin_index[i];
    }
    free(nh_pin_index);
    nh_pin_index = grown;
    nh_pin_index_cap = cap;
  }
  size_t mask = nh_pin_index_cap - 1;
  size_t i = nh_pin_hash(key) & mask;
  while (nh_pin_index[i].key != 0) i = (i + 1) & mask;
  nh_pin_index[i] = (NhPinSlot){key, pin};
  nh_pin_index_len++;
}

/* Removes a key, closing the gap so every later entry of its run is still
 * reachable from its home slot. */
static void nh_pin_index_del(uintptr_t key) {
  NhPinSlot *found = nh_pin_slot(key);
  if (found == NULL) return;
  size_t mask = nh_pin_index_cap - 1;
  size_t hole = (size_t)(found - nh_pin_index);
  for (size_t j = (hole + 1) & mask; nh_pin_index[j].key != 0; j = (j + 1) & mask) {
    size_t home = nh_pin_hash(nh_pin_index[j].key) & mask;
    if (((j - home) & mask) >= ((j - hole) & mask)) {
      nh_pin_index[hole] = nh_pin_index[j];
      hole = j;
    }
  }
  nh_pin_index[hole].key = 0;
  nh_pin_index_len--;
}

static void nh_pin_retain_obj(void *obj, int kind) {
  switch (kind) {
  case NH_PIN_PROMISE: scr_promise_retain((ScrPromise *)obj); break;
  case NH_PIN_ERROR:
  case NH_PIN_NATIVE_ERROR: scr_error_retain((ScrError *)obj); break;
  case NH_PIN_BYTES:
  case NH_PIN_BUFFER: scr_bytes_retain((ScrBytes *)obj); break;
  case NH_PIN_SYMBOL: scr_sym_retain((ScrSym *)obj); break;
  }
}

static void nh_pin_release_obj(NhPin *pin) {
  switch (pin->kind) {
  case NH_PIN_PROMISE: scr_promise_release((ScrPromise *)pin->obj); break;
  case NH_PIN_ERROR:
  case NH_PIN_NATIVE_ERROR: scr_error_release((ScrError *)pin->obj); break;
  case NH_PIN_BYTES:
  case NH_PIN_BUFFER: scr_bytes_release((ScrBytes *)pin->obj); break;
  case NH_PIN_SYMBOL: scr_sym_release((ScrSym *)pin->obj); break;
  }
}

static NhPin *nh_pin(void *obj, int kind, ScrNodeRef *ref) {
  if (nh_npins == nh_pins_cap) {
    size_t cap = nh_pins_cap ? nh_pins_cap * 2 : 16;
    NhPin *grown = realloc(nh_pins, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    nh_pins = grown;
    nh_pins_cap = cap;
  }
  nh_pin_retain_obj(obj, kind);
  ref->rc++;
  nh_pin_index_put(nh_pin_key(obj, kind), (uint32_t)nh_npins + 1);
  ref->pin = (uint32_t)nh_npins + 1;
  nh_pins[nh_npins] = (NhPin){obj, ref, kind, 0, false, true};
  return &nh_pins[nh_npins++];
}

/* The pin of a runtime object, or NULL. */
static NhPin *nh_pin_of(const void *obj, int kind) {
  NhPinSlot *slot = nh_pin_slot(nh_pin_key(obj, kind));
  if (slot == NULL) return NULL;
  NhPin *pin = &nh_pins[slot->pin - 1];
  return pin->kind == kind ? pin : NULL;
}

/* The ref a pinned runtime object represents, or NULL. */
static ScrNodeRef *nh_pinned(const void *obj, int kind) {
  NhPin *pin = nh_pin_of(obj, kind);
  return pin != NULL ? pin->ref : NULL;
}

/* The pinned object of a ref, or NULL. */
static void *nh_pinned_obj(const ScrNodeRef *ref, int kind) {
  if (ref->pin == 0) return NULL;
  NhPin *pin = &nh_pins[ref->pin - 1];
  return pin->kind == kind ? pin->obj : NULL;
}

/* Moves a pin to another place of the table. */
static void nh_pin_move(size_t to, size_t from) {
  if (to == from) return;
  nh_pins[to] = nh_pins[from];
  nh_pins[to].ref->pin = (uint32_t)to + 1;
  nh_pin_slot(nh_pin_key(nh_pins[to].obj, nh_pins[to].kind))->pin = (uint32_t)to + 1;
  if (nh_pins[to].keyed)
    nh_pin_slot(nh_data_key(((ScrBytes *)nh_pins[to].obj)->data))->pin = (uint32_t)to + 1;
}

/* Takes pin `i` out of the table and releases what it held. The gap is
 * closed so that the pins made since the last entry (from nh_young on)
 * stay behind the older ones. */
static void nh_unpin(size_t i) {
  NhPin pin = nh_pins[i];
  if (pin.obj == nh_idle_storage && pin.kind == NH_PIN_BUFFER) nh_idle_storage = NULL;
  if (pin.stores > 0) {
    /* The stores outlive this pin: the object's other pin counts them. */
    NhPin *twin = nh_pin_of(pin.obj, pin.kind == NH_PIN_BYTES ? NH_PIN_BUFFER : NH_PIN_BYTES);
    if (twin != NULL) twin->stores += pin.stores;
  }
  if (pin.keyed) nh_pin_index_del(nh_data_key(((ScrBytes *)pin.obj)->data));
  nh_pin_index_del(nh_pin_key(pin.obj, pin.kind));
  pin.ref->pin = 0;
  if (i < nh_young) {
    nh_pin_move(i, nh_young - 1);
    i = --nh_young;
  }
  nh_pin_move(i, nh_npins - 1);
  nh_npins--;
  nh_pin_release_obj(&pin);
  nh_ref_release(pin.ref);
}

/* The references to a pinned object that are not the program's: the pin's
 * own, the V8 backing stores over a storage, and for bytes the same of the
 * object's other pin (an owner typed array is a view and a storage). */
static size_t nh_pin_held(const NhPin *pin) {
  size_t n = 1 + pin->stores;
  /* A view over another object's storage is not a storage itself. */
  if (pin->kind == NH_PIN_BYTES && ((const ScrBytes *)pin->obj)->backing != NULL) return n;
  if (pin->kind == NH_PIN_BYTES || pin->kind == NH_PIN_BUFFER) {
    const NhPin *twin = nh_pin_of(pin->obj, pin->kind == NH_PIN_BYTES ? NH_PIN_BUFFER : NH_PIN_BYTES);
    if (twin != NULL) n += 1 + twin->stores;
  }
  return n;
}

/* Whether only the table (and V8, for a storage) still holds a pin's
 * object. A pinned error the program read as a dynamic value also has a
 * view, and the error-view cache (scr_json.c) holds the error and the view
 * until nothing else does. That pair is not a holder: counted as one, the
 * table and the cache keep each other's entry for the rest of the run. */
static bool nh_pin_dead(const NhPin *pin) {
  size_t rc = *(size_t *)pin->obj;
  if (rc == nh_pin_held(pin)) return true;
  if (pin->kind != NH_PIN_ERROR || rc != 2) return false;
  const ScrDyn *view = scr_errdyn_view_of(pin->obj);
  if (view == NULL || view->kind != SCR_DYN_OBJ) return false;
  /* The view's own entries may hold the view itself. */
  size_t self = 0;
  for (size_t i = 0; i < scr_dyn_obj_count(view); i++) self += scr_dyn_obj_value_at(view, i) == view;
  return SCR_RC_COUNT(view) == 1 + self;
}

/* Releases every pin (`full`), or every byte view and symbol pinned since
 * the last entry, whose object only the table (and V8, for a storage) still
 * holds.
 * Releasing a pin can free objects that held other pinned objects (a view
 * holds its storage), so it repeats until a pass frees nothing. A sweep of
 * the young pins leaves the storage of an island buffer one entry of grace
 * (nh_idle_storage). */
static void nh_sweep_pins(bool full) {
  if (!full && nh_idle_storage != NULL) {
    NhPin *idle = nh_pin_of(nh_idle_storage, NH_PIN_BUFFER);
    nh_idle_storage = NULL;
    if (idle != NULL && !idle->used && nh_pin_dead(idle)) nh_unpin((size_t)(idle - nh_pins));
  }
  size_t from = full ? 0 : nh_young;
  bool freed = true;
  while (freed) {
    freed = false;
    for (size_t i = from; i < nh_npins;) {
      NhPin *pin = &nh_pins[i];
      /* What a sweep of the young pins leaves for a full one: the storage
       * of an island buffer (below), and promises and errors, whose typed
       * views in the program are made from the pinned object each time the
       * island value crosses and share its identity only through it. */
      bool later = pin->kind == NH_PIN_PROMISE || pin->kind == NH_PIN_ERROR ||
                   pin->kind == NH_PIN_NATIVE_ERROR ||
                   (pin->kind == NH_PIN_BUFFER && ((ScrBytes *)pin->obj)->external);
      if (!nh_pin_dead(pin) || (!full && later)) {
        i++;
        continue;
      }
      /* The storage a view of an island buffer leaves behind. */
      ScrBytes *storage = pin->kind == NH_PIN_BYTES ? ((ScrBytes *)pin->obj)->backing : NULL;
      if (storage != NULL && !storage->external) storage = NULL;
      nh_unpin(i);
      freed = true;
      if (!full && storage != NULL) {
        NhPin *left = nh_pin_of(storage, NH_PIN_BUFFER);
        if (left != NULL && nh_pin_dead(left)) {
          left->used = false;
          nh_idle_storage = storage;
        }
      }
    }
  }
  nh_young = nh_npins;
}

static void nh_sweep(void) {
  nh_sweep_pins(true);
  nh_sweep_at = nh_npins * 2 > 64 ? nh_npins * 2 : 64;
}

/* ── young views ──────────────────────────────────────────────────────
 * A program view that crosses for the first time is "young" until the next
 * entry: the bridge keeps its V8 view alive and this unit holds the view
 * object, in the same order, and that is all. Most such views are a chunk
 * of a stream, dropped by the program right after the call that carried
 * them; a pin, an import and their release for each would cost more than
 * the crossing. The next entry pins the ones the program still holds and
 * lets the others go (nh_young_flush). A young view is found by its handle
 * (SCR_NODE_YOUNG | position) coming out of V8 and by its object going in,
 * so its identity holds from the first crossing on. */
typedef struct {
  ScrBytes *obj; /* retained */
  bool store;    /* a V8 backing store over it holds it too (it is its own storage) */
} NhYoungView;

static NhYoungView *nh_young_views = NULL;
static size_t nh_nyoung_views = 0, nh_young_views_cap = 0;

/* The young handle of a view object, or 0. */
static uint32_t nh_young_handle(const ScrBytes *b) {
  for (size_t i = 0; i < nh_nyoung_views; i++)
    if (nh_young_views[i].obj == b) return SCR_NODE_YOUNG | (uint32_t)i;
  return 0;
}

/* The view object of a young handle (borrowed), or NULL. */
static ScrBytes *nh_young_obj(uint32_t handle) {
  size_t i = handle & ~SCR_NODE_YOUNG;
  return (handle & SCR_NODE_YOUNG) && i < nh_nyoung_views ? nh_young_views[i].obj : NULL;
}

static void nh_young_add(ScrBytes *b, bool store) {
  if (nh_nyoung_views == nh_young_views_cap) {
    size_t cap = nh_young_views_cap ? nh_young_views_cap * 2 : 8;
    NhYoungView *grown = realloc(nh_young_views, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    nh_young_views = grown;
    nh_young_views_cap = cap;
  }
  nh_young_views[nh_nyoung_views++] = (NhYoungView){scr_bytes_retain(b), store};
}

typedef struct {
  const uint8_t *keep;
  size_t n;
  uint32_t *ids;
} NhYoungFlush;

static void nh_young_flush_job(void *p) {
  NhYoungFlush *f = p;
  scr_ni_bridge_loaded()->young_flush(f->keep, f->n, f->ids);
}

/* Ends the young views. One the program still holds (its count exceeds
 * this unit's hold, the store's and its storage pin's) is pinned to the
 * handle the bridge gives its V8 view; any other is released, and V8
 * collects its view unless island code kept it. */
static void nh_young_flush(void) {
  size_t n = nh_nyoung_views;
  if (n == 0) return;
  uint8_t keep_small[16];
  uint32_t ids_small[16];
  bool kept = false;
  uint8_t *keep = n <= 16 ? keep_small : malloc(n);
  uint32_t *ids = n <= 16 ? ids_small : malloc(n * sizeof *ids);
  if (keep == NULL || ids == NULL) nh_oom();
  for (size_t i = 0; i < n; i++) {
    const NhYoungView *y = &nh_young_views[i];
    size_t held = 1 + (y->store ? 1 : 0);
    const NhPin *storage = nh_pin_of(y->obj, NH_PIN_BUFFER);
    if (storage != NULL) held += 1 + storage->stores;
    keep[i] = *(size_t *)y->obj > held;
    kept = kept || keep[i];
    ids[i] = 0;
  }
  const ScrNodeBridge *bridge = scr_ni_bridge_loaded();
  if (bridge != NULL && !ni_stopped) {
    /* Giving a view a handle can allocate in V8, and so collect: that
     * runs on Node's stack, like every operation (V8 scans the stack it
     * believes it is on). Letting the views go allocates nothing. */
    NhYoungFlush flush = {keep, n, ids};
    if (kept) scr_ni_on_node_stack(nh_young_flush_job, &flush);
    else bridge->young_flush(keep, n, ids);
  }
  nh_nyoung_views = 0;
  for (size_t i = 0; i < n; i++) {
    NhYoungView y = nh_young_views[i];
    if (keep[i] && ids[i] != 0) {
      ScrNodeRef *ref = nh_ref(ids[i], 0);
      if (ref->pin == 0) {
        NhPin *pin = nh_pin(y.obj, NH_PIN_BYTES, ref);
        if (y.store) {
          /* It is its own storage: the pin counts the store, and the index
           * finds it by the storage's memory (nh_buffer_root). */
          pin->stores = 1;
          pin->keyed = true;
          nh_pin_index_put(nh_data_key(y.obj->data), (uint32_t)(pin - nh_pins) + 1);
        }
      }
      nh_ref_release(ref);
    }
    scr_bytes_release(y.obj);
  }
  if (keep != keep_small) free(keep);
  if (ids != ids_small) free(ids);
}

/* ── runtime bytes V8 freed (any thread) ─────────────────────────────── */

static pthread_mutex_t nh_freed_lock = PTHREAD_MUTEX_INITIALIZER;
static void **nh_freed = NULL;
static size_t nh_nfreed = 0, nh_freed_cap = 0;

void scr_ni_bytes_free(void *owner) {
  pthread_mutex_lock(&nh_freed_lock);
  if (nh_nfreed == nh_freed_cap) {
    size_t cap = nh_freed_cap ? nh_freed_cap * 2 : 16;
    void **grown = realloc(nh_freed, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    nh_freed = grown;
    nh_freed_cap = cap;
  }
  nh_freed[nh_nfreed++] = owner;
  pthread_mutex_unlock(&nh_freed_lock);
}

static void nh_drain_freed(void) {
  for (;;) {
    pthread_mutex_lock(&nh_freed_lock);
    void *owner = nh_nfreed > 0 ? nh_freed[--nh_nfreed] : NULL;
    pthread_mutex_unlock(&nh_freed_lock);
    if (owner == NULL) return;
    /* The store is gone: its reference no longer counts as V8's. */
    NhPin *pin = nh_pin_of(owner, NH_PIN_BUFFER);
    if (pin == NULL || pin->stores == 0) pin = nh_pin_of(owner, NH_PIN_BYTES);
    if (pin != NULL && pin->stores > 0) pin->stores--;
    scr_bytes_release((ScrBytes *)owner);
  }
}

/* Housekeeping at every operation: bytes V8 freed, and the pin sweep once
 * the table has grown. */
static void nh_enter(void) {
  if (nh_nyoung_views > 0) nh_young_flush();
  if (nh_nfreed > 0) nh_drain_freed();
  if (nh_npins >= nh_sweep_at) nh_sweep();
  else if (nh_young < nh_npins || nh_idle_storage != NULL) nh_sweep_pins(false);
}

/* The same when island code calls into the program (a listener an island
 * loop calls with a chunk each time enters no operation of this unit).
 * Only once every value of the call has been converted: until then a view
 * the bridge named by its handle alone is held by its pin only. */
void scr_ni_called_in(void) { nh_enter(); }

/* ── refs ─────────────────────────────────────────────────────────────── */

static void *nh_ref_retain_v(void *h) {
  ((ScrNodeRef *)h)->rc++;
  return h;
}

static void nh_lazy_free(ScrNodeRef *ref) {
  if (ref->lazy == NULL) return;
  for (int i = 0; i < 7; i++) scr_dyn_release(ref->lazy[i]);
  free(ref->lazy);
  ref->lazy = NULL;
}

static void nh_ref_release(ScrNodeRef *ref) {
  if (--ref->rc != 0) return;
  free(ref->identity);
  if (ref->alias != NULL) {
    nh_ref_release(ref->alias);
    free(ref);
    return;
  }
  if (ref->id == 0) { /* a stub never materialized, or a transplanted ref */
    nh_lazy_free(ref);
    free(ref);
    return;
  }
  if (ref->id < ni_refs_cap && ni_refs[ref->id] == ref) ni_refs[ref->id] = NULL;
  if (!ni_stopped && scr_ni_bridge_loaded() != NULL) scr_ni_bridge_loaded()->drop(ref->id);
  free(ref);
}

static void nh_ref_release_v(void *h) { nh_ref_release((ScrNodeRef *)h); }

/* The ref of bridge id `id` (+1), created on first sight. */
static ScrNodeRef *nh_ref(uint32_t id, uint32_t flags) {
  if (id >= ni_refs_cap) {
    size_t cap = ni_refs_cap ? ni_refs_cap : 64;
    while (cap <= id) cap *= 2;
    ScrNodeRef **grown = realloc(ni_refs, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    memset(grown + ni_refs_cap, 0, (cap - ni_refs_cap) * sizeof *grown);
    ni_refs = grown;
    ni_refs_cap = cap;
  }
  ScrNodeRef *ref = ni_refs[id];
  if (ref != NULL) {
    ref->rc++;
    return ref;
  }
  ref = calloc(1, sizeof *ref);
  if (ref == NULL) nh_oom();
  ref->rc = 1;
  ref->id = id;
  ref->flags = flags;
  ni_refs[id] = ref;
  return ref;
}

/* ── NI-7 stubs (deferred island modules, scr_node_island_boot.c) ─────── */

ScrDyn *scr_ni_stub_new(uint32_t flags, void *stub) {
  ScrNodeRef *ref = calloc(1, sizeof *ref);
  if (ref == NULL) nh_oom();
  ref->rc = 1;
  ref->flags = flags;
  ref->stub = stub;
  ScrDyn *box = scr_dyn_new_handle(ref, SCR_DYNH_NODE_ISLAND);
  ref->rc--; /* the box holds the only reference */
  return box;
}

void *scr_ni_stub_of(const ScrDyn *value) {
  if (value == NULL || value->kind != SCR_DYN_HANDLE || value->v.handle.tag != SCR_DYNH_NODE_ISLAND)
    return NULL;
  return ((ScrNodeRef *)value->v.handle.ptr)->stub;
}

/* Identity reconciliation: the stub box `stub` becomes the program's
 * handle of the real island value `real` (borrowed). When the runtime saw
 * the value for the first time, the stub takes over its bridge id, so every
 * later crossing of the value answers the stub's ref and `===` holds; the
 * fresh ref is retired without dropping the bridge entry. Answers false
 * when the value is not an island object (the snapshot no longer applies). */
bool scr_ni_stub_reconcile(ScrDyn *stub, ScrDyn *real) {
  ScrNodeRef *s = stub->v.handle.ptr;
  if (!scr_ni_is_handle(real)) return false;
  ScrNodeRef *r = real->v.handle.ptr;
  if (r != s && r->stub != NULL) return false;
  s->stub = NULL;
  if (r == s) return true;
  if (r->rc == 1 && r->alias == NULL) {
    /* Only `real` holds the fresh ref: move its id to the stub. */
    s->id = r->id;
    s->flags = r->flags;
    ni_refs[r->id] = s;
    r->id = 0;
    real->v.handle.ptr = s;
    s->rc++;
    r->rc = 0;
    free(r);
    return true;
  }
  /* The program already holds the value through another ref: the stub
   * forwards to it (identity split for `===` between the two). */
  s->alias = r;
  r->rc++;
  s->id = r->id;
  s->flags = r->flags;
  if (getenv("SCRIPTC_NODE_ISLANDS_TRACE") != NULL)
    fprintf(stderr, "[node-islands] stub identity split (id %u)\n", r->id);
  return true;
}

/* A stub whose Node value is needed: starting Node materializes every
 * deferred module (scr_node_island_boot.c); then the ref is real.
 * False with the module's load error pending. */
ScrDyn *scr_ni_lazy_subclass_new(ScrDyn *const *args) {
  ScrNodeRef *ref = calloc(1, sizeof *ref);
  ScrDyn **lazy = malloc(7 * sizeof *lazy);
  if (ref == NULL || lazy == NULL) nh_oom();
  for (int i = 0; i < 7; i++) lazy[i] = scr_dyn_retain(args[i]);
  ref->rc = 1;
  ref->flags = SCR_NVF_FUNCTION | SCR_NVF_CONSTRUCTOR;
  ref->lazy = lazy;
  ScrDyn *box = scr_dyn_new_handle(ref, SCR_DYNH_NODE_ISLAND);
  ref->rc--; /* the box holds the only reference */
  return box;
}

static bool nh_lazy_is(const ScrDyn *value) {
  return scr_ni_is_handle(value) && ((ScrNodeRef *)value->v.handle.ptr)->lazy != NULL;
}

/* Creates a lazy subclass now (its base materializes first, as the
 * conversion of the base argument needs it) and makes the lazy ref the
 * class's handle, so the box the program holds is the class. */
static bool nh_lazy_create(ScrNodeRef *ref) {
  ScrDyn **lazy = ref->lazy;
  ref->lazy = NULL;
  ScrDyn *real = scr_ni_subclass_create(lazy);
  if (real == NULL || !scr_ni_is_handle(real)) {
    ref->lazy = lazy;
    scr_dyn_release(real);
    return false;
  }
  ScrNodeRef *r = real->v.handle.ptr;
  ref->id = r->id;
  ref->flags = r->flags;
  ni_refs[r->id] = ref;
  real->v.handle.ptr = ref;
  ref->rc++;
  r->id = 0;
  r->rc = 0;
  free(r);
  scr_dyn_release(real);
  for (int i = 0; i < 7; i++) scr_dyn_release(lazy[i]);
  free(lazy);
  if (getenv("SCRIPTC_NODE_ISLANDS_TRACE") != NULL)
    fprintf(stderr, "[node-islands] created native subclass (id %u)\n", ref->id);
  return true;
}

static bool nh_live(ScrNodeRef *ref) {
  if (ref->lazy != NULL) return nh_lazy_create(ref);
  if (ref->stub == NULL) return true;
  void *stub = ref->stub;
  scr_ni_bridge();
  if (ref->stub == NULL) return true;
  scr_ni_boot_stub_failed(stub);
  return false;
}

static const ScrDynHandleOps nh_ops;

bool scr_ni_is_handle(const ScrDyn *value) {
  return value != NULL && value->kind == SCR_DYN_HANDLE &&
         value->v.handle.tag == SCR_DYNH_NODE_ISLAND;
}

static ScrNodeRef *nh_ref_of(const ScrDyn *value) {
  return scr_ni_is_handle(value) ? (ScrNodeRef *)value->v.handle.ptr : NULL;
}

/* ── awaiting island thenables ───────────────────────────────────────── */

typedef struct {
  uint32_t token;
  ScrPromise *promise; /* owned */
} NhWaiter;

static NhWaiter *nh_waiters = NULL;
static size_t nh_nwaiters = 0, nh_waiters_cap = 0;
static uint32_t nh_next_token = 1;

static uint32_t nh_wait(ScrPromise *p) {
  if (nh_nwaiters == nh_waiters_cap) {
    size_t cap = nh_waiters_cap ? nh_waiters_cap * 2 : 8;
    NhWaiter *grown = realloc(nh_waiters, cap * sizeof *grown);
    if (grown == NULL) nh_oom();
    nh_waiters = grown;
    nh_waiters_cap = cap;
  }
  uint32_t token = nh_next_token++;
  if (nh_next_token == 0) nh_next_token = 1;
  nh_waiters[nh_nwaiters++] = (NhWaiter){token, scr_promise_retain(p)};
  return token;
}

/* ── V8 → runtime ─────────────────────────────────────────────────────── */

static ScrDyn *nh_from_node(const ScrNodeValue *v);
static void nh_throw_value(const ScrNodeValue *v);
static int nh_then(const ScrNodeValue *value, uint32_t token, ScrNodeValue *thrown);

static bool nh_has_lone_surrogate(const char *p, size_t n) {
  for (size_t i = 0; i + 1 < n; i++)
    if ((unsigned char)p[i] == 0xED && (unsigned char)p[i + 1] >= 0xA0) return true;
  return false;
}

static ScrStr *nh_str(const char *data, size_t len) {
  if (nh_has_lone_surrogate(data, len)) scr_wtf8_note();
  return scr_str_new(data, len);
}

/* An island promise as a scriptc promise, its mirror: one per V8 promise
 * while the program holds it. Crossing adds no reaction to the V8 promise:
 * the mirror subscribes when native code first reacts to it
 * (nh_promise_subscribe), so a promise only island code handles keeps
 * exactly its island reactions and V8 decides whether it is unhandled. */
static ScrDyn *nh_promise_box(ScrNodeRef *ref) {
  ScrPromise *p = nh_pinned_obj(ref, NH_PIN_PROMISE);
  if (p == NULL) {
    p = scr_promise_new();
    scr_promise_mark_island_mirror(p);
    nh_pin(p, NH_PIN_PROMISE, ref);
    scr_promise_release(p); /* the pin holds it */
  }
  return scr_dyn_new_promise(p);
}

/* The first native reaction to a mirror (scr_async.c calls this once per
 * mirror, after the reaction attached): one reaction on the V8 promise,
 * whose job settles the mirror and runs the native reactions
 * (scr_ni_settle_value). After Node stopped nothing can settle it. */
static void nh_promise_subscribe(ScrPromise *p) {
  ScrNodeRef *ref = nh_pinned(p, NH_PIN_PROMISE);
  if (ref == NULL || ni_stopped || ref->id == 0 || scr_ni_bridge_loaded() == NULL) return;
  ScrNodeValue value = {.tag = SCR_NV_HANDLE, .flags = ref->flags};
  value.u.handle = ref->id;
  ScrNodeValue thrown;
  uint32_t token = nh_wait(p);
  if (nh_then(&value, token, &thrown) == 0) return;
  for (size_t i = 0; i < nh_nwaiters; i++) {
    if (nh_waiters[i].token != token) continue;
    nh_waiters[i] = nh_waiters[--nh_nwaiters];
    scr_promise_release(p);
    break;
  }
  /* The caller may have an exception of its own pending: the rejection
   * takes what `then` threw and leaves that one as it was. */
  ScrCaught *outer = scr_exc_pending() ? scr_exc_take() : NULL;
  nh_throw_value(&thrown);
  scr_promise_reject_pending(p);
  if (outer != NULL) {
    scr_rethrow(outer);
    scr_caught_release(outer);
  }
}

/* ── byte views ───────────────────────────────────────────────────────
 * JavaScript has two objects, the ArrayBuffer and the view, and so do both
 * sides here. The storage of an ArrayBuffer is a root ScrBytes (the
 * runtime's own allocation, or an external root over a V8 backing store),
 * pinned to the V8 ArrayBuffer; a view is a ScrBytes over its root, pinned
 * to the V8 view. Bytes are never copied: both sides read and write one
 * memory.
 *
 * Who keeps what alive. Memory V8 owns: the bridge's slot of the
 * ArrayBuffer holds its backing store, and the runtime holds that slot for
 * as long as the root lives, which every native view of it ensures. Memory
 * the runtime owns: the V8 backing store over it holds one reference to
 * the root until V8 frees the store, so island views outlive the program's
 * use of the bytes. A pin goes when the program no longer holds the
 * object; its V8 half is then V8's to collect, and a later crossing of
 * either half makes a new pair that nothing can tell from the old one. */

/* The storage of the ArrayBuffer a BYTES value names (borrowed: its pin
 * holds it). */
static ScrBytes *nh_buffer_root(const ScrNodeValue *v) {
  /* The ArrayBuffer of a young view of a typed array that is its own
   * storage: that array. */
  if (v->u.bytes.buffer & SCR_NODE_YOUNG) return nh_young_obj(v->u.bytes.buffer);
  ScrNodeRef *ref = nh_ref(v->u.bytes.buffer, 0);
  ScrBytes *root = nh_pinned_obj(ref, NH_PIN_BUFFER);
  if (root != NULL) nh_pins[ref->pin - 1].used = true;
  uint8_t *base = v->u.bytes.data != NULL ? v->u.bytes.data - v->u.bytes.offset : NULL;
  if (root == NULL && base != NULL) {
    /* The ArrayBuffer V8 made with the view of one of the program's typed
     * arrays: the store is over that array's own memory. It has a handle
     * of its own from here on. */
    NhPinSlot *slot = nh_pin_slot(nh_data_key(base));
    if (slot != NULL) {
      root = nh_pins[slot->pin - 1].obj;
      nh_pin(root, NH_PIN_BUFFER, ref);
    }
  }
  if (root == NULL) {
    root = scr_bytes_from_external(v->u.bytes.buffer_len > 0 ? base : NULL, v->u.bytes.buffer_len);
    /* The island owns this memory: the program cannot detach it. */
    root->untransferable = true;
    nh_pin(root, NH_PIN_BUFFER, ref);
    scr_bytes_release(root); /* the pin holds it */
  }
  nh_ref_release(ref);
  return root;
}

/* Bytes from V8: the view object paired with the V8 view, made over the
 * ArrayBuffer's storage at the view's own offset on first sight. NULL with
 * an exception pending when the view cannot be made. */
static ScrDyn *nh_bytes_box(const ScrNodeValue *v) {
  if (v->flags & SCR_NVF_ARRAYBUFFER) {
    ScrBytes *root = nh_buffer_root(v);
    if (root == NULL) scr_trap("scriptc: internal error: an island ArrayBuffer named a view that is gone\n");
    return scr_array_buffer_from_bytes(root);
  }
  if (v->u.bytes.handle & SCR_NODE_YOUNG) {
    /* A program view coming back before the flush: itself. */
    ScrBytes *young = nh_young_obj(v->u.bytes.handle);
    if (young == NULL) scr_trap("scriptc: internal error: an island byte view named a view that is gone\n");
    ScrDyn *d = scr_dyn_new_bytes(young);
    d->buffer = young->is_buffer;
    return d;
  }
  ScrNodeRef *ref = nh_ref(v->u.bytes.handle, 0);
  ScrBytes *b = nh_pinned_obj(ref, NH_PIN_BYTES);
  if (b == NULL) {
    if (v->u.bytes.buffer == 0) {
      /* The bridge names a view the runtime does not hold. */
      nh_ref_release(ref);
      scr_trap("scriptc: internal error: an island byte view crossed without its buffer\n");
    }
    ScrBytes *root = nh_buffer_root(v);
    if (root == NULL) {
      nh_ref_release(ref);
      scr_trap("scriptc: internal error: an island byte view named a buffer that is gone\n");
    }
    size_t width = scr_bytes_elem_size((ScrBytesElem)v->u.bytes.elem);
    b = (v->flags & SCR_NVF_DATAVIEW)
            ? scr_dataview_new(root, (double)v->u.bytes.offset, true, (double)(v->u.bytes.len * width))
            : scr_bytes_buffer_view(root, (ScrBytesElem)v->u.bytes.elem, (double)v->u.bytes.offset,
                                    true, (double)v->u.bytes.len);
    if (b == NULL) {
      nh_ref_release(ref);
      return NULL;
    }
    b->is_buffer = (v->flags & SCR_NVF_BUFFER) != 0;
    nh_pin(b, NH_PIN_BYTES, ref);
    scr_bytes_release(b); /* the pin holds it */
  }
  nh_ref_release(ref);
  ScrDyn *d = scr_dyn_new_bytes(b);
  d->buffer = b->is_buffer;
  return d;
}

/* The storage a view or ArrayBuffer crossing into V8 stands on: the
 * handle of its ArrayBuffer when one is bound, else what the bridge needs
 * to make and bind one. False with the refusal pending for storage V8
 * cannot alias. */
static bool nh_storage_out(ScrBytes *root, ScrNodeValue *out);

/* ── symbols ──────────────────────────────────────────────────────────
 * A symbol is one identity on both sides: Symbol.for symbols pair by key,
 * the well-known ones by name, every other symbol with one symbol the
 * other side makes for it, of the same description. The pin keeps the pair
 * while the program holds the native symbol. */

static const char *const nh_well_known[] = {
    "asyncDispose", "asyncIterator", "dispose",  "hasInstance", "isConcatSpreadable",
    "iterator",     "match",         "matchAll", "replace",     "search",
    "species",      "split",         "toPrimitive", "toStringTag", "unscopables",
};

static void nh_symbol_info(uint32_t id, ScrNodeSymbolInfo *info);

/* An island symbol as the native symbol paired with it (+1 box). */
static ScrDyn *nh_symbol_box(ScrNodeRef *ref) {
  ScrSym *sym = nh_pinned_obj(ref, NH_PIN_SYMBOL);
  if (sym != NULL) return scr_dyn_new_symbol(sym);
  ScrNodeSymbolInfo info;
  nh_symbol_info(ref->id, &info);
  ScrStr *text = info.text != NULL ? nh_str(info.text, info.len) : scr_str_new("", 0);
  switch (info.kind) {
  case SCR_NODE_SYMBOL_REGISTERED: sym = scr_sym_for(text); break;
  case SCR_NODE_SYMBOL_WELL_KNOWN: sym = scr_sym_well_known(text); break;
  case SCR_NODE_SYMBOL_UNIQUE: sym = scr_sym_new(text); break;
  default: sym = scr_sym_new(NULL); break;
  }
  scr_str_release(text);
  /* A registered or well-known symbol the program already sent across is
   * paired with that same island symbol, which has this ref. */
  if (nh_pin_of(sym, NH_PIN_SYMBOL) == NULL) nh_pin(sym, NH_PIN_SYMBOL, ref);
  ScrDyn *d = scr_dyn_new_symbol(sym);
  scr_sym_release(sym);
  return d;
}

/* A value the bridge answered, as a dyn value (+1). Copies string data at
 * once: it is valid only until the next bridge entry. */
static ScrDyn *nh_from_node(const ScrNodeValue *v) {
  switch (v->tag) {
  case SCR_NV_NULL: return scr_dyn_new_null();
  case SCR_NV_BOOL: return scr_dyn_new_bool(v->u.boolean != 0);
  case SCR_NV_NUMBER: return scr_dyn_new_num(v->u.num);
  case SCR_NV_STRING: {
    ScrStr *s = nh_str(v->u.str.data, v->u.str.len);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  case SCR_NV_BIGINT: {
    ScrStr *s = scr_str_new(v->u.str.data, v->u.str.len);
    ScrBigInt *n = scr_bigint_parse(s);
    scr_str_release(s);
    if (n == NULL) return NULL;
    ScrDyn *d = scr_dyn_new_bigint(n);
    scr_bigint_release(n);
    return d;
  }
  case SCR_NV_HANDLE: {
    /* `v` is the bridge's until the next entry, and an adoption enters. */
    uint32_t handle = v->u.handle;
    bool twin = (v->flags & SCR_NVF_TWIN) != 0;
    bool intrinsic = (v->flags & SCR_NVF_INTRINSIC) != 0;
    ScrNodeRef *ref = nh_ref(handle, v->flags);
    if (ref->flags & SCR_NVF_ERROR) {
      /* An island error the program already holds as an error (it caught
       * it, or took it as a callback's argument) is that error again
       * however it arrives, so the round trip of an island error through
       * the program and back is the identity, as a native error's is. */
      ScrError *pinned = nh_pinned_obj(ref, NH_PIN_ERROR);
      if (pinned != NULL) {
        nh_ref_release(ref);
        return scr_dyn_from_error(pinned);
      }
    }
    ScrDyn *d = (ref->flags & SCR_NVF_PROMISE)  ? nh_promise_box(ref)
                : (ref->flags & SCR_NVF_SYMBOL) ? nh_symbol_box(ref)
                                                : scr_dyn_new_handle(ref, SCR_DYNH_NODE_ISLAND);
    nh_ref_release(ref);
    /* An island object of a twin class (an AbortSignal the island made):
     * the native object that adopts it, when a class does. */
    if (twin) {
      ScrDyn *native = scr_ni_twin_adopt(d, handle);
      if (native != NULL) {
        scr_dyn_release(d);
        return native;
      }
    }
    /* One of the island's intrinsic constructors (its `String`): the
     * program's own value of that name, when it holds one. */
    if (intrinsic) {
      ScrDyn *native = scr_ni_intrinsic_native(d);
      if (native != NULL) {
        scr_dyn_release(d);
        return native;
      }
    }
    return d;
  }
  case SCR_NV_BYTES: return nh_bytes_box(v);
  case SCR_NV_EXPORT: {
    /* A native value's representative came back: the value itself. */
    ScrDyn *d = scr_ni_export_value(v->u.exp.id);
    return d != NULL ? scr_dyn_retain(d) : scr_dyn_undefined();
  }
  default: return scr_dyn_undefined();
  }
}

typedef struct {
  uint32_t h;
  ScrNodeErrorInfo *out;
} NhErrorInfo;

static void nh_error_info_job(void *p) {
  NhErrorInfo *a = p;
  scr_ni_bridge_loaded()->error_info(a->h, a->out);
}

/* The own name, message, stack and string code of island error `h`.
 * Reading them runs JavaScript (any of them may be an accessor), so it
 * runs on Node's stack like every operation. A thrown error is read after
 * the operation that threw it returned to the program's stack, and V8 scans
 * the stack it was entered on: a collection that started while it ran on
 * the program's stack failed that scan's check. */
static void nh_error_info(uint32_t h, ScrNodeErrorInfo *out) {
  NhErrorInfo read = {h, out};
  scr_ni_on_node_stack(nh_error_info_job, &read);
}

/* The ScrError of an island Error handle (+1): the one already pinned to
 * it, else a new one of the nearest intrinsic class, pinned. */
static ScrError *nh_error_of(const ScrNodeValue *v) {
  ScrNodeRef *ref = nh_ref(v->u.handle, v->flags);
  ScrError *pinned = nh_pinned_obj(ref, NH_PIN_ERROR);
  /* The V8 error of a linked native error: that error. */
  if (pinned == NULL) pinned = nh_pinned_obj(ref, NH_PIN_NATIVE_ERROR);
  if (pinned != NULL) {
    nh_ref_release(ref);
    return scr_error_retain(pinned);
  }
  ScrNodeErrorInfo info;
  nh_error_info(ref->id, &info);
  /* Node did not find a file, and the error names the installed module
   * tree: a tool may have removed files from it. What is missing is put
   * back (scr_ni_tree_repair), for nh_load's second attempt and for every
   * later load. */
  if (info.code != NULL && scr_ni_missing_file_code(info.code, info.code_len) &&
      ((info.message != NULL && scr_ni_tree_named(info.message, info.message_len)) ||
       (info.stack != NULL && scr_ni_tree_named(info.stack, info.stack_len))))
    scr_ni_tree_repair();
  ScrStr *message = nh_str(info.message ? info.message : "", info.message_len);
  ScrError *e = scr_error_new((int)info.kind, message);
  scr_str_release(message);
  if (info.name != NULL) {
    ScrStr *name = nh_str(info.name, info.name_len);
    ScrStr *deflt = scr_error_default_name(e);
    bool differs = deflt == NULL || deflt->len != name->len ||
                   memcmp(deflt->data, name->data, name->len) != 0;
    if (deflt != NULL) scr_str_release(deflt);
    if (differs) {
      scr_str_release(e->name);
      e->name = name;
      e->name_present = true;
    } else {
      scr_str_release(name);
    }
  }
  if (info.stack != NULL) {
    ScrStr *stack = nh_str(info.stack, info.stack_len);
    scr_error_set_stack(e, stack);
    scr_str_release(stack);
  }
  if (info.code != NULL) {
    ScrStr *code = nh_str(info.code, info.code_len);
    scr_error_set_code_value(e, code);
    scr_str_release(code);
  }
  nh_pin(e, NH_PIN_ERROR, ref);
  nh_ref_release(ref);
  return e;
}

/* An argument of a native callback (scr_node_island_export.c): island
 * Errors arrive as their pinned ScrError, as thrown ones do, so typed code
 * sees `instanceof RangeError`, `message` and `code`. +1. */
ScrDyn *scr_ni_arg_in(const ScrNodeValue *v) {
  if (v->tag == SCR_NV_HANDLE && (v->flags & SCR_NVF_ERROR)) {
    ScrError *e = nh_error_of(v);
    ScrDyn *d = scr_dyn_from_error(e);
    scr_error_release(e);
    return d;
  }
  return scr_ni_value_in(v);
}

/* Leaves a thrown island value pending as a scriptc exception. An Error
 * becomes a ScrError of the nearest intrinsic class with V8's name,
 * message, stack and string code, pinned to the V8 error so that it is
 * that error again if it crosses back. */
static void nh_throw_value(const ScrNodeValue *v) {
  if (v->tag == SCR_NV_HANDLE && (v->flags & SCR_NVF_ERROR)) {
    ScrError *e = nh_error_of(v);
    scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
    return;
  }
  ScrDyn *d = nh_from_node(v);
  if (d == NULL) return; /* a conversion error is pending */
  scr_dyn_throw(d);
}

/* V8's reaction job for a promise native code reacted to (a mirror, or the
 * promise of an awaited island value). This job is the turn the native
 * reactions take in Node, so they run here, in the order they attached:
 * the settlement collects the jobs it queues and they run before the job
 * returns. */
void scr_ni_settle_value(uint32_t token, int rejected, const ScrNodeValue *value) {
  for (size_t i = 0; i < nh_nwaiters; i++) {
    if (nh_waiters[i].token != token) continue;
    ScrPromise *p = nh_waiters[i].promise;
    nh_waiters[i] = nh_waiters[--nh_nwaiters];
    /* The value converts first (reading an island Error may run its
     * getters): only the settlement's own jobs are collected. */
    ScrDyn *d = NULL;
    if (rejected) nh_throw_value(value);
    else d = nh_from_node(value);
    scr_loop_hosted_settle_begin();
    if (d != NULL)
      scr_promise_fulfill_ref(p, d, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_promise_reject_pending(p); /* the rejection, or a conversion error; else a no-op */
    scr_promise_release(p);
    scr_loop_hosted_settle_run();
    return;
  }
}

/* ── runtime → V8 ─────────────────────────────────────────────────────── */

/* What a conversion into V8 keeps alive until the bridge call returns. */
typedef struct {
  void *items[16];
  void (*releases[16])(void *);
  size_t n;
  void **more;
  void (**more_releases)(void *);
  size_t nmore, more_cap;
} NhKeep;

static void nh_keep(NhKeep *k, void *obj, void (*release)(void *)) {
  if (k->n < 16) {
    k->items[k->n] = obj;
    k->releases[k->n++] = release;
    return;
  }
  if (k->nmore == k->more_cap) {
    size_t cap = k->more_cap ? k->more_cap * 2 : 16;
    void **items = realloc(k->more, cap * sizeof *items);
    void (**rels)(void *) = realloc(k->more_releases, cap * sizeof *rels);
    if (items == NULL || rels == NULL) nh_oom();
    k->more = items;
    k->more_releases = rels;
    k->more_cap = cap;
  }
  k->more[k->nmore] = obj;
  k->more_releases[k->nmore++] = release;
}

static void nh_keep_done(NhKeep *k) {
  for (size_t i = 0; i < k->n; i++) k->releases[i](k->items[i]);
  for (size_t i = 0; i < k->nmore; i++) k->more_releases[i](k->more[i]);
  free(k->more);
  free(k->more_releases);
}

static void nh_str_release_v(void *s) { scr_str_release((ScrStr *)s); }
static void nh_dyn_release_v(void *d) { scr_dyn_release((ScrDyn *)d); }

SCR_COLD static bool nh_refuse(const char *what) {
  char message[256];
  snprintf(message, sizeof message,
           "scriptc: %s cannot cross into a Node island yet (scope-B NI-5 exports native values by reference)",
           what);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), "SC8010");
  return false;
}

/* The values NI-5 exports by reference (closures, promises, typed refs,
 * native objects and arrays). Until then: plain dyn objects and arrays
 * cross as a JSON copy (the NI-4 shortcut), anything else is refused. */
static bool nh_export_value(ScrDyn *v, ScrNodeValue *out, NhKeep *keep) {
  /* NI-5: closures, promises, records, class instances and dyn objects
   * cross by reference (scr_node_island_export.c). */
  if (scr_ni_exportable(v)) {
    scr_ni_export_out(v, out);
    return true;
  }
  /* Arrays (dyn, and typed array capsules: NI-6 shortcut, as for dyn
   * arrays) keep NI-4's JSON copy. */
  if (v->kind == SCR_DYN_OBJ || v->kind == SCR_DYN_ARR ||
      (v->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(v) != NULL)) {
    ScrStr *gap = scr_str_new("", 0);
    ScrDyn *json = scr_json_stringify_replacer(v, scr_dyn_undefined(), gap);
    scr_str_release(gap);
    if (json == NULL || scr_exc_pending()) {
      if (json != NULL) scr_dyn_release(json);
      return false;
    }
    if (json->kind != SCR_DYN_STR) {
      scr_dyn_release(json);
      out->tag = SCR_NV_UNDEFINED;
      return true;
    }
    nh_keep(keep, json, nh_dyn_release_v);
    out->tag = SCR_NV_JSON;
    out->u.str.data = json->v.str->data;
    out->u.str.len = json->v.str->len;
    return true;
  }
  switch (v->kind) {
  case SCR_DYN_FUNC: return nh_refuse("a function");
  case SCR_DYN_PROMISE: return nh_refuse("a native promise");
  default: return nh_refuse("this native object");
  }
}

static bool nh_storage_out(ScrBytes *root, ScrNodeValue *out) {
  if (root->shared != NULL) return nh_refuse("shared memory");
  /* A buffer that can move or shrink has no fixed memory for V8 to alias.
   * This unit is built once, so it asks the bytes unit the program links
   * (a JavaScript program with mutable buffers has another build of it). */
  if (scr_bytes_storage_movable(root)) return nh_refuse("a resizable or detached ArrayBuffer");
  ScrNodeRef *ref = nh_pinned(root, NH_PIN_BUFFER);
  out->u.bytes.buffer = ref != NULL ? ref->id : 0;
  out->u.bytes.root = root;
  out->u.bytes.buffer_len = root->len * scr_bytes_elem_size(root->elem);
  return true;
}

/* A native symbol with no island symbol bound yet: what the bridge needs
 * to find or make one. */
static void nh_symbol_out(ScrSym *sym, ScrNodeValue *out, NhKeep *keep) {
  out->tag = SCR_NV_SYMBOL;
  out->u.sym.owner = sym;
  ScrStr *key = scr_sym_key_for(sym);
  if (key != NULL) {
    nh_keep(keep, key, nh_str_release_v);
    out->u.sym.kind = SCR_NODE_SYMBOL_REGISTERED;
    out->u.sym.text = key->data;
    out->u.sym.len = key->len;
    return;
  }
  ScrStr *desc = scr_sym_desc(sym);
  if (desc == NULL) {
    out->u.sym.kind = SCR_NODE_SYMBOL_NO_DESCRIPTION;
    return;
  }
  nh_keep(keep, desc, nh_str_release_v);
  out->u.sym.kind = SCR_NODE_SYMBOL_UNIQUE;
  out->u.sym.text = desc->data;
  out->u.sym.len = desc->len;
  if (desc->len <= 7 || memcmp(desc->data, "Symbol.", 7) != 0) return;
  for (size_t i = 0; i < sizeof nh_well_known / sizeof *nh_well_known; i++) {
    size_t n = strlen(nh_well_known[i]);
    if (desc->len - 7 != n || memcmp(desc->data + 7, nh_well_known[i], n) != 0) continue;
    /* The description of a well-known symbol: it is one when it is the
     * symbol the runtime keeps under that name. */
    ScrStr *name = scr_str_new(nh_well_known[i], n);
    ScrSym *known = scr_sym_well_known(name);
    scr_str_release(name);
    if (known == sym) {
      out->u.sym.kind = SCR_NODE_SYMBOL_WELL_KNOWN;
      out->u.sym.text = nh_well_known[i];
      out->u.sym.len = n;
    }
    scr_sym_release(known);
    return;
  }
}

/* The nearest class the island has a constructor for: V8's intrinsic
 * error classes and Node's DOMException (subclasses included). */
static uint32_t nh_error_kind(const ScrError *e) {
  for (int k = 1; k <= SCR_ERR_AGGREGATE; k++) {
    if (scr_error_vts[k].pre <= e->vt->pre && e->vt->pre <= scr_error_vts[k].post)
      return (uint32_t)k;
  }
  return 0;
}

/* A runtime value as a bridge in-value. False with an exception pending
 * when it cannot cross. */
static bool nh_to_node(ScrDyn *v, ScrNodeValue *out, NhKeep *keep) {
  memset(out, 0, sizeof *out);
  if (v == NULL) {
    out->tag = SCR_NV_UNDEFINED;
    return true;
  }
  switch (v->kind) {
  case SCR_DYN_UNDEF: out->tag = SCR_NV_UNDEFINED; return true;
  case SCR_DYN_NULL: out->tag = SCR_NV_NULL; return true;
  case SCR_DYN_BOOL: out->tag = SCR_NV_BOOL; out->u.boolean = v->v.b ? 1 : 0; return true;
  case SCR_DYN_NUM: out->tag = SCR_NV_NUMBER; out->u.num = v->v.num; return true;
  case SCR_DYN_STR:
    out->tag = SCR_NV_STRING;
    out->u.str.data = v->v.str->data;
    out->u.str.len = v->v.str->len;
    return true;
  case SCR_DYN_BIGINT: {
    ScrStr *text = scr_bigint_to_string(v->v.bigint, 10);
    if (text == NULL) return false;
    nh_keep(keep, text, nh_str_release_v);
    out->tag = SCR_NV_BIGINT;
    out->u.str.data = text->data;
    out->u.str.len = text->len;
    return true;
  }
  case SCR_DYN_HANDLE:
    if (v->v.handle.tag == SCR_DYNH_NODE_ISLAND) {
      ScrNodeRef *ref = v->v.handle.ptr;
      if (!nh_live(ref)) return false;
      out->tag = SCR_NV_HANDLE;
      out->flags = ref->flags;
      out->u.handle = ref->id;
      return true;
    }
    if (v->v.handle.tag == SCR_DYNH_ARRAY_BUFFER || v->v.handle.tag == SCR_DYNH_SHARED_ARRAY_BUFFER) {
      /* An ArrayBuffer is its storage: the buffer bound to it, or one the
       * bridge makes over it now. */
      ScrBytes *root = v->v.handle.ptr;
      out->tag = SCR_NV_BYTES;
      out->flags = SCR_NVF_ARRAYBUFFER;
      out->u.bytes.data = root->data;
      return nh_storage_out(root, out);
    }
    return nh_export_value(v, out, keep);
  case SCR_DYN_SYMBOL: {
    ScrSym *sym = v->v.symbol.value;
    ScrNodeRef *ref = nh_pinned(sym, NH_PIN_SYMBOL);
    if (ref != NULL) {
      out->tag = SCR_NV_HANDLE;
      out->flags = ref->flags;
      out->u.handle = ref->id;
      return true;
    }
    nh_symbol_out(sym, out, keep);
    return true;
  }
  case SCR_DYN_PROMISE: {
    ScrNodeRef *ref = nh_pinned(v->v.promise, NH_PIN_PROMISE);
    if (ref == NULL) return nh_export_value(v, out, keep);
    out->tag = SCR_NV_HANDLE;
    out->flags = ref->flags;
    out->u.handle = ref->id;
    return true;
  }
  case SCR_DYN_BYTES: {
    ScrBytes *b = v->v.bytes;
    ScrNodeRef *ref = nh_pinned(b, NH_PIN_BYTES);
    out->tag = SCR_NV_BYTES;
    if (ref != NULL) {
      out->u.bytes.handle = ref->id; /* the V8 view paired with it */
      return true;
    }
    if (nh_nyoung_views > 0 && (out->u.bytes.handle = nh_young_handle(b)) != 0) return true;
    /* Its first crossing: the bridge makes the V8 view over the storage's
     * ArrayBuffer, at the view's own offset, and binds it to this object. */
    ScrBytes *root = b->backing != NULL ? b->backing : b;
    if (!nh_storage_out(root, out)) return false;
    out->u.bytes.owner = b;
    out->u.bytes.elem = (uint32_t)b->elem;
    out->u.bytes.len = b->len;
    out->u.bytes.data = b->data;
    out->u.bytes.offset = (size_t)(b->data - root->data);
    if (b->is_buffer || v->buffer) out->flags |= SCR_NVF_BUFFER;
    if (b->is_data_view) out->flags |= SCR_NVF_DATAVIEW;
    return true;
  }
  default: break;
  }
  ScrError *e = scr_errdyn_err_of(v);
  if (e != NULL) {
    ScrNodeRef *ref = nh_pinned(e, NH_PIN_ERROR);
    if (ref == NULL) ref = nh_pinned(e, NH_PIN_NATIVE_ERROR);
    if (ref != NULL) {
      scr_error_release(e);
      out->tag = SCR_NV_HANDLE;
      out->flags = ref->flags;
      out->u.handle = ref->id;
      return true;
    }
    /* A native error crosses by reference, like every native object: its
     * dyn node is an export, and the bridge keeps one V8 Error per export,
     * of the error's intrinsic class. That V8 Error crossing back is
     * SCR_NV_EXPORT, so the program gets the error it threw: the same
     * object, with its class and fields. The V8 Error's own properties are
     * the native error's: the bridge asks the export which exist
     * (SCR_NODE_EXPORT_OWN) and reads and writes each through it, so island
     * code and the program read and write one set of values, `stack`
     * among them (formatted only when one side reads it). An instance of a
     * program class also answers its class's members there. */
    out->tag = SCR_NV_ERROR;
    out->flags = SCR_NVF_ERROR;
    out->u.error.export_id = scr_ni_export_id(v);
    out->u.error.kind = nh_error_kind(e);
    out->u.error.class_instance = v->kind == SCR_DYN_TYPED_REF;
    scr_error_release(e);
    return true;
  }
  return nh_export_value(v, out, keep);
}

/* ── operations on Node's stack ──────────────────────────────────────── */

enum {
  NH_LOAD, NH_GET, NH_SET, NH_HAS, NH_DEL, NH_INVOKE, NH_INVOKE_METHOD, NH_CONSTRUCT,
  NH_INSTANCEOF, NH_KEYS, NH_THEN, NH_SYMBOL_INFO,
};

typedef struct {
  int op;
  uint32_t h;
  const char *path;
  int mode;
  const ScrNodeValue *a, *b;
  const ScrNodeValue *args;
  size_t argc;
  uint32_t token;
  ScrNodeValue *out;
  ScrNodeSymbolInfo *info;
  int threw;
} NhCall;

static void nh_call_job(void *p) {
  NhCall *c = p;
  const ScrNodeBridge *b = scr_ni_bridge_loaded();
  switch (c->op) {
  case NH_LOAD: c->threw = b->load(c->path, c->mode, c->out); break;
  case NH_GET: c->threw = b->get(c->h, c->a, c->out); break;
  case NH_SET: c->threw = b->set(c->h, c->a, c->b, c->out); break;
  case NH_HAS: c->threw = b->has(c->h, c->a, c->out); break;
  case NH_DEL: c->threw = b->del(c->h, c->a, c->out); break;
  case NH_INVOKE: c->threw = b->invoke(c->h, c->a, c->args, c->argc, c->out); break;
  case NH_INVOKE_METHOD: c->threw = b->invoke_method(c->h, c->a, c->args, c->argc, c->out); break;
  case NH_CONSTRUCT: c->threw = b->construct(c->h, c->args, c->argc, c->out); break;
  case NH_INSTANCEOF: c->threw = b->instance_of(c->a, c->h, c->out); break;
  case NH_KEYS: c->threw = b->own_keys(c->h, c->mode, c->out); break;
  case NH_THEN: c->threw = b->then(c->a, c->token, c->out); break;
  case NH_SYMBOL_INFO: b->symbol_info(c->h, c->info); break;
  }
}

static int nh_run(NhCall *c) {
  scr_ni_shared_refresh();
  scr_ni_on_node_stack(nh_call_job, c);
  return c->threw;
}

static int nh_then(const ScrNodeValue *value, uint32_t token, ScrNodeValue *thrown) {
  NhCall c = {.op = NH_THEN, .a = value, .token = token, .out = thrown};
  return nh_run(&c);
}

static void nh_symbol_info(uint32_t id, ScrNodeSymbolInfo *info) {
  NhCall c = {.op = NH_SYMBOL_INFO, .h = id, .info = info};
  scr_ni_on_node_stack(nh_call_job, &c);
}

/* ── the bridge binds V8 values to runtime objects (host callbacks) ───── */

static int nh_bind_kind(uint32_t kind) {
  return kind == SCR_NODE_BIND_VIEW     ? NH_PIN_BYTES
         : kind == SCR_NODE_BIND_BUFFER ? NH_PIN_BUFFER
                                        : NH_PIN_SYMBOL;
}

uint32_t scr_ni_host_bound(uint32_t kind, void *owner) {
  ScrNodeRef *ref = nh_pinned(owner, nh_bind_kind(kind));
  if (ref != NULL) return ref->id;
  return kind == SCR_NODE_BIND_VIEW ? nh_young_handle(owner) : 0;
}

void scr_ni_host_bind(uint32_t kind, void *owner, uint32_t handle, int store) {
  if (store) {
    /* A V8 backing store now aliases this storage and holds it until V8
     * frees the store. The program's views do not follow a detach, so the
     * buffer is not one the program can detach either. */
    ScrBytes *root = owner;
    scr_bytes_retain(root);
    root->untransferable = true;
  }
  if (kind == SCR_NODE_BIND_VIEW) {
    /* A view's first crossing: young until the next entry. The bridge
     * numbers its young views as this unit does. */
    if ((handle & ~SCR_NODE_YOUNG) != nh_nyoung_views)
      scr_trap("scriptc: internal error: the bridge's young views are out of step\n");
    nh_young_add(owner, store != 0);
    return;
  }
  int pk = nh_bind_kind(kind);
  NhPin *pin = nh_pin_of(owner, pk);
  if (pin == NULL) {
    ScrNodeRef *ref = nh_ref(handle, kind == SCR_NODE_BIND_SYMBOL ? SCR_NVF_SYMBOL : 0);
    if (ref->pin == 0) pin = nh_pin(owner, pk, ref);
    nh_ref_release(ref);
  }
  if (store && pin != NULL) pin->stores++;
}

int scr_ni_host_holds(uint32_t handle) {
  return handle != 0 && handle < ni_refs_cap && ni_refs[handle] != NULL && ni_refs[handle]->pin != 0;
}

/* The outcome of a call as a dyn value (+1), or NULL with the thrown
 * value pending. */
static ScrDyn *nh_outcome(NhCall *c) {
  if (c->threw) {
    nh_throw_value(c->out);
    return NULL;
  }
  return nh_from_node(c->out);
}

/* The receiver of a property operation as an in-value: an island handle
 * names itself; anything else is a TypeError (the compiler routes only
 * island values here). */
static bool nh_receiver(ScrDyn *obj, uint32_t *id, const char *what) {
  ScrNodeRef *ref = nh_ref_of(obj);
  if (ref == NULL) {
    char message[160];
    snprintf(message, sizeof message, "scriptc: %s needs a Node island value", what);
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), "SC8010");
    return false;
  }
  if (!nh_live(ref)) return false;
  *id = ref->id;
  return true;
}

/* ── the runtime API (scr_node_island.h) ─────────────────────────────── */

static ScrDyn *nh_load(ScrStr *path, int esm) {
  nh_bridge();
  for (int attempt = 0;; attempt++) {
    size_t repairs = scr_ni_tree_repairs();
    nh_enter();
    char *p = scr_ni_module_path(path);
    ScrNodeValue out;
    NhCall c = {.op = NH_LOAD, .path = p, .mode = esm, .out = &out};
    nh_run(&c);
    free(p);
    ScrDyn *loaded = nh_outcome(&c);
    if (loaded != NULL || attempt > 0 || scr_ni_tree_repairs() == repairs) return loaded;
    /* The load failed on a file the installed tree had lost, and the file
     * is back: the load once more. */
    scr_caught_release(scr_exc_take());
  }
}

ScrDyn *scr_ni_require(ScrStr *path) { return nh_load(path, 0); }

ScrDyn *scr_ni_process_report(void) {
  ScrStr *specifier = scr_str_new("process", 7);
  ScrDyn *process = nh_load(specifier, 0);
  scr_str_release(specifier);
  if (process == NULL) return NULL;
  /* Node's process.report object: a stable object whose getReport() builds
   * the diagnostic report of THIS process — the island and the compiled
   * binary are one process, so sharedObjects lists the binary's own
   * libraries. */
  ScrDyn *report = scr_ni_get_str(process, "report", 6);
  scr_dyn_release(process);
  return report;
}

ScrPromise *scr_ni_import(ScrStr *path) {
  ScrDyn *d = nh_load(path, 1);
  if (d == NULL) {
    ScrPromise *p = scr_promise_new();
    scr_promise_reject_pending(p);
    return p;
  }
  ScrPromise *p = scr_dyn_promise_of(d);
  if (p != NULL) {
    p = scr_promise_retain(p);
  } else {
    p = scr_promise_new();
    scr_promise_fulfill_ref(p, scr_dyn_retain(d), scr_dyn_retain_v, scr_dyn_release_v,
                            scr_dyn_trace_v);
  }
  scr_dyn_release(d);
  return p;
}

ScrDyn *scr_ni_get(ScrDyn *obj, ScrDyn *key) {
  if (key != NULL && key->kind == SCR_DYN_STR && (scr_ni_stub_of(obj) != NULL || nh_lazy_is(obj)))
    return scr_ni_get_str(obj, key->v.str->data, key->v.str->len);
  uint32_t id;
  if (!nh_receiver(obj, &id, "a property read")) return NULL;
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue k, out;
  if (!nh_to_node(key, &k, &keep)) {
    nh_keep_done(&keep);
    return NULL;
  }
  NhCall c = {.op = NH_GET, .h = id, .a = &k, .out = &out};
  nh_run(&c);
  nh_keep_done(&keep);
  return nh_outcome(&c);
}

ScrDyn *scr_ni_get_str(ScrDyn *obj, const char *key, size_t len) {
  /* A lazy subclass answers its name without creating the class. */
  if (nh_lazy_is(obj) && len == 4 && memcmp(key, "name", 4) == 0)
    return scr_dyn_retain(((ScrNodeRef *)obj->v.handle.ptr)->lazy[1]);
  void *stub = scr_ni_stub_of(obj);
  if (stub != NULL && scr_ni_boot_snapshot_valid(stub)) {
    /* Until its module evaluates, the interface snapshot answers what it
     * holds. */
    ScrDyn *known = scr_ni_boot_member(stub, key, len);
    if (known != NULL) return known;
  }
  uint32_t id;
  if (!nh_receiver(obj, &id, "a property read")) return NULL;
  nh_enter();
  ScrNodeValue k = {.tag = SCR_NV_STRING}, out;
  k.u.str.data = key;
  k.u.str.len = len;
  NhCall c = {.op = NH_GET, .h = id, .a = &k, .out = &out};
  nh_run(&c);
  return nh_outcome(&c);
}

static bool nh_set(uint32_t id, const ScrNodeValue *k, ScrDyn *value) {
  NhKeep keep = {0};
  ScrNodeValue v, out;
  if (!nh_to_node(value, &v, &keep)) {
    nh_keep_done(&keep);
    return false;
  }
  NhCall c = {.op = NH_SET, .h = id, .a = k, .b = &v, .out = &out};
  nh_run(&c);
  nh_keep_done(&keep);
  if (c.threw) {
    nh_throw_value(&out);
    return false;
  }
  return true;
}

bool scr_ni_set(ScrDyn *obj, ScrDyn *key, ScrDyn *value) {
  uint32_t id;
  if (!nh_receiver(obj, &id, "a property write")) return false;
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue k;
  if (!nh_to_node(key, &k, &keep)) {
    nh_keep_done(&keep);
    return false;
  }
  bool ok = nh_set(id, &k, value);
  nh_keep_done(&keep);
  return ok;
}

bool scr_ni_set_str(ScrDyn *obj, const char *key, size_t len, ScrDyn *value) {
  uint32_t id;
  if (!nh_receiver(obj, &id, "a property write")) return false;
  nh_enter();
  ScrNodeValue k = {.tag = SCR_NV_STRING};
  k.u.str.data = key;
  k.u.str.len = len;
  return nh_set(id, &k, value);
}

static int nh_bool_op(int op, ScrDyn *obj, ScrDyn *key, const char *what) {
  uint32_t id;
  if (!nh_receiver(obj, &id, what)) return -1;
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue k, out;
  if (!nh_to_node(key, &k, &keep)) {
    nh_keep_done(&keep);
    return -1;
  }
  NhCall c = {.op = op, .h = id, .a = &k, .out = &out};
  nh_run(&c);
  nh_keep_done(&keep);
  if (c.threw) {
    nh_throw_value(&out);
    return -1;
  }
  return out.tag == SCR_NV_BOOL && out.u.boolean ? 1 : 0;
}

int scr_ni_has(ScrDyn *obj, ScrDyn *key) { return nh_bool_op(NH_HAS, obj, key, "the 'in' operator"); }

int scr_ni_delete(ScrDyn *obj, ScrDyn *key) { return nh_bool_op(NH_DEL, obj, key, "delete"); }

/* The host's Object.hasOwn and Object.prototype.propertyIsEnumerable,
 * loaded once. */
static ScrDyn *nh_has_own_fn = NULL;
static ScrDyn *nh_is_enumerable_fn = NULL;

/* Whether an island object has an own property `key`, or an own enumerable
 * one, answered by Node's intrinsics: the object's own method of either
 * name is shadowed or absent on a null-prototype object, and it decides
 * nothing either way. 1 or 0, -1 with the exception pending. */
int scr_ni_has_own(ScrDyn *obj, ScrDyn *key, int enumerable) {
  ScrDyn **slot = enumerable ? &nh_is_enumerable_fn : &nh_has_own_fn;
  if (*slot == NULL) {
    ScrStr *name = enumerable ? scr_str_new("scriptc:isEnumerable", 20)
                              : scr_str_new("scriptc:hasOwn", 14);
    *slot = nh_load(name, 0);
    scr_str_release(name);
    if (*slot == NULL) return -1;
  }
  ScrDyn *args[2] = {obj, key};
  ScrDyn *answer = scr_ni_call(*slot, scr_dyn_undefined(), args, 2);
  if (answer == NULL) return -1;
  int found = answer->kind == SCR_DYN_BOOL && answer->v.b ? 1 : 0;
  scr_dyn_release(answer);
  return found;
}

/* Converts call arguments; NULL with an exception pending on failure. */
static ScrNodeValue *nh_args(ScrDyn *const *args, size_t argc, ScrNodeValue *small, NhKeep *keep) {
  ScrNodeValue *values = argc <= 8 ? small : malloc(argc * sizeof *values);
  if (values == NULL) nh_oom();
  for (size_t i = 0; i < argc; i++) {
    if (!nh_to_node(args[i], &values[i], keep)) {
      if (values != small) free(values);
      return NULL;
    }
  }
  return values;
}

static ScrDyn *nh_call(int op, uint32_t id, ScrDyn *this_, const ScrNodeValue *key,
                       ScrDyn *const *args, size_t argc) {
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue small[8], recv, out;
  ScrNodeValue *values = nh_args(args, argc, small, &keep);
  if (values == NULL) {
    nh_keep_done(&keep);
    return NULL;
  }
  const ScrNodeValue *a = key;
  if (op == NH_INVOKE) {
    if (!nh_to_node(this_, &recv, &keep)) {
      if (values != small) free(values);
      nh_keep_done(&keep);
      return NULL;
    }
    a = &recv;
  }
  NhCall c = {.op = op, .h = id, .a = a, .args = values, .argc = argc, .out = &out};
  nh_run(&c);
  if (values != small) free(values);
  nh_keep_done(&keep);
  return nh_outcome(&c);
}

ScrDyn *scr_ni_call(ScrDyn *fn, ScrDyn *this_, ScrDyn *const *args, size_t argc) {
  uint32_t id;
  if (!nh_receiver(fn, &id, "a call")) return NULL;
  return nh_call(NH_INVOKE, id, this_, NULL, args, argc);
}

ScrDyn *scr_ni_call_method(ScrDyn *obj, const char *key, size_t len, ScrDyn *const *args,
                           size_t argc) {
  uint32_t id;
  if (!nh_receiver(obj, &id, "a method call")) return NULL;
  ScrNodeValue k = {.tag = SCR_NV_STRING};
  k.u.str.data = key;
  k.u.str.len = len;
  return nh_call(NH_INVOKE_METHOD, id, NULL, &k, args, argc);
}

ScrDyn *scr_ni_construct(ScrDyn *ctor, ScrDyn *const *args, size_t argc) {
  uint32_t id;
  if (!nh_receiver(ctor, &id, "new")) return NULL;
  return nh_call(NH_CONSTRUCT, id, NULL, NULL, args, argc);
}

ScrStr *scr_ni_typeof(ScrDyn *value) {
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref == NULL) return scr_dyn_typeof(value);
  const char *s = (ref->flags & SCR_NVF_FUNCTION) ? "function" : "object";
  return scr_str_new(s, strlen(s));
}

int scr_ni_instanceof(ScrDyn *value, ScrDyn *ctor) {
  /* A stub class before Node starts: no island object exists yet, and a
   * native value crossing into Node is never an instance of an ordinary
   * island class (the snapshot says whether the class is one). */
  void *stub = scr_ni_stub_of(ctor);
  if (stub != NULL && scr_ni_boot_snapshot_valid(stub) && !scr_ni_is_handle(value) &&
      scr_ni_boot_plain_class(stub))
    return 0;
  /* A lazy subclass has no instances yet, and a native value is never one
   * (its prototype chain is the subclass's own). */
  if (nh_lazy_is(ctor) && !scr_ni_is_handle(value)) return 0;
  uint32_t id;
  if (!nh_receiver(ctor, &id, "instanceof")) return -1;
  nh_enter();
  NhKeep keep = {0};
  ScrNodeValue v, out;
  if (!nh_to_node(value, &v, &keep)) {
    nh_keep_done(&keep);
    return -1;
  }
  NhCall c = {.op = NH_INSTANCEOF, .h = id, .a = &v, .out = &out};
  nh_run(&c);
  nh_keep_done(&keep);
  if (c.threw) {
    nh_throw_value(&out);
    return -1;
  }
  return out.tag == SCR_NV_BOOL && out.u.boolean ? 1 : 0;
}

/* NI-4: what the native view of an error island code threw does not hold.
 * The view carries the name, message, stack and string code every error
 * has; this error IS a V8 error, so every other property the program reads
 * (an own `status` or `errno`, `cause`, an AggregateError's `errors`, a
 * method of its class, and `constructor`, which in the island's realm is
 * V8's TypeError, the very value the island's own `TypeError` crosses as)
 * is read from it. Errors among the results are native views themselves.
 * 0 for an error the runtime made itself. */
/* The island error whose native view is `view`: its ref (borrowed: the pin
 * holds it), or NULL for a value that is no error's view, or the view of an
 * error the runtime made itself. */
static ScrNodeRef *nh_error_view_ref(const ScrDyn *view) {
  ScrError *err = scr_errdyn_err_of(view);
  if (err == NULL) return NULL;
  ScrNodeRef *ref = nh_pinned(err, NH_PIN_ERROR);
  scr_error_release(err); /* its pin and its view hold it */
  return ref;
}

static int nh_error_get(const ScrDyn *view, const char *key, size_t len, ScrDyn **out) {
  ScrNodeRef *ref = nh_error_view_ref(view);
  if (ref == NULL) return 0;
  *out = NULL;
  if (!nh_live(ref)) return 1;
  nh_enter();
  ScrNodeValue k = {.tag = SCR_NV_STRING}, value;
  k.u.str.data = key;
  k.u.str.len = len;
  NhCall c = {.op = NH_GET, .h = ref->id, .a = &k, .out = &value};
  nh_run(&c);
  if (c.threw) nh_throw_value(&value);
  else *out = scr_ni_arg_in(&value);
  return 1;
}

static int nh_error_has(const ScrDyn *view, const char *key, size_t len) {
  ScrNodeRef *ref = nh_error_view_ref(view);
  if (ref == NULL) return -1;
  ScrDyn *handle = scr_dyn_new_handle(ref, SCR_DYNH_NODE_ISLAND); /* retains */
  ScrStr *name = scr_str_new(key, len);
  ScrDyn *k = scr_dyn_new_str(name);
  scr_str_release(name);
  int found = scr_ni_has(handle, k);
  scr_dyn_release(k);
  scr_dyn_release(handle);
  return found == 1 ? 1 : 0;
}

ScrDyn *scr_ni_own_keys(ScrDyn *obj, int mode) {
  uint32_t id;
  if (!nh_receiver(obj, &id, "Object.keys")) return NULL;
  nh_enter();
  ScrNodeValue out;
  NhCall c = {.op = NH_KEYS, .h = id, .mode = mode, .out = &out};
  nh_run(&c);
  ScrDyn *array = nh_outcome(&c);
  if (array == NULL) return NULL;
  /* A fresh V8 array of keys: read its elements, then let it go. */
  ScrDyn *keys = scr_dyn_new_arr();
  ScrDyn *length = scr_ni_get_str(array, "length", 6);
  double n = length != NULL && length->kind == SCR_DYN_NUM ? length->v.num : 0;
  if (length != NULL) scr_dyn_release(length);
  for (double i = 0; i < n; i++) {
    ScrDyn *index = scr_dyn_new_num(i);
    ScrDyn *key = scr_ni_get(array, index);
    scr_dyn_release(index);
    if (key == NULL) {
      scr_dyn_release(keys);
      scr_dyn_release(array);
      return NULL;
    }
    scr_dyn_arr_push(keys, key);
  }
  scr_dyn_release(array);
  return keys;
}

ScrPromise *scr_ni_await(ScrDyn *value) {
  ScrPromise *boxed = value != NULL ? scr_dyn_promise_of(value) : NULL;
  if (boxed != NULL) return scr_promise_retain(boxed);
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref != NULL && !nh_live(ref)) {
    ScrPromise *p = scr_promise_new();
    scr_promise_reject_pending(p);
    return p;
  }
  ScrPromise *p = scr_promise_new();
  if (ref == NULL) {
    scr_promise_fulfill_ref(p, scr_dyn_retain(value != NULL ? value : scr_dyn_undefined()),
                            scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    return p;
  }
  nh_enter();
  ScrNodeValue v = {.tag = SCR_NV_HANDLE, .flags = ref->flags}, thrown;
  v.u.handle = ref->id;
  uint32_t token = nh_wait(p);
  if (nh_then(&v, token, &thrown) != 0) {
    nh_throw_value(&thrown);
    scr_promise_reject_pending(p);
  }
  return p;
}

/* PromiseResolve of a value the program awaits, for the island values the
 * dynamic await does not know: an island object or function is resolved as
 * every promise resolution resolves it (scr_dyn_promise_resolve: a callable
 * `then` makes it a thenable, which the runtime's thenable job adopts; a
 * `then` getter that throws rejects with what it threw), and the program
 * awaits that promise. A value without a callable `then` fulfils it, and
 * awaiting the fulfilled promise takes the one turn awaiting the value
 * takes. Every other value is itself. +1. */
ScrDyn *scr_node_island_adopt_thenable(ScrDyn *value) {
  if (nh_ref_of(value) == NULL || !scr_context_is_main()) return scr_dyn_retain(value);
  ScrPromise *resolved = scr_dyn_promise_resolve(value, NULL);
  ScrDyn *box = scr_dyn_new_promise(resolved);
  scr_promise_release(resolved);
  return box;
}

/* Promise.resolve(value) in a program with Node islands: the runtime's
 * PromiseResolve, which adopts an island thenable (and any other) and
 * answers a promise as itself. +1. */
ScrPromise *scr_node_island_promise_resolve(ScrDyn *value) {
  return scr_dyn_promise_resolve(value, NULL);
}

bool scr_ni_is_function(const ScrDyn *value) {
  ScrNodeRef *ref = nh_ref_of(value);
  return ref != NULL && (ref->flags & SCR_NVF_FUNCTION) != 0;
}

/* Its address in a closure's `fn` marks an island function's identity root. */
static const char nh_identity_mark = 0;

static ScrClosure *nh_function_identity(const ScrDyn *value) {
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref == NULL || (ref->flags & SCR_NVF_FUNCTION) == 0) return NULL;
  /* A deferred module's stub that already had a ref stands for it. */
  while (ref->alias != NULL) ref = ref->alias;
  if (ref->identity == NULL) {
    ScrClosure *root = calloc(1, sizeof *root + sizeof(ScrBox *));
    if (root == NULL) nh_oom();
    root->rc = SIZE_MAX;
    root->fn = (void *)&nh_identity_mark;
    root->caps[0] = (ScrBox *)(void *)ref; /* not a capture: ncaps stays 0 */
    ref->identity = root;
  }
  return ref->identity;
}

static ScrDyn *nh_function_of_identity(const ScrClosure *root) {
  if (root->fn != (void *)&nh_identity_mark) return NULL;
  return scr_dyn_new_handle((ScrNodeRef *)(void *)root->caps[0], SCR_DYNH_NODE_ISLAND); /* retains */
}

/* Node's util.inspect, loaded once and held for the program's life. */
static ScrDyn *nh_inspect_fn = NULL;

ScrStr *scr_ni_inspect(const ScrDyn *value, double recurse, double depth) {
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref == NULL) return scr_str_new("", 0);
  if (!nh_live(ref)) return scr_str_new("", 0);
  if (nh_inspect_fn == NULL) {
    ScrStr *util = scr_str_new("node:util", 9);
    ScrDyn *module = nh_load(util, 0);
    scr_str_release(util);
    if (module == NULL) return scr_str_new("", 0);
    nh_inspect_fn = scr_ni_get_str(module, "inspect", 7);
    scr_dyn_release(module);
    if (nh_inspect_fn == NULL) return scr_str_new("", 0);
  }
  /* The remaining depth, as util.inspect counts it (null: unlimited). */
  char options[64];
  double left = depth - recurse;
  if (left != left || left > 1e9)
    snprintf(options, sizeof options, "{\"depth\":null}");
  else
    snprintf(options, sizeof options, "{\"depth\":%.0f}", left < 0 ? 0 : left);
  ScrNodeValue args[2], out;
  memset(args, 0, sizeof args);
  args[0].tag = SCR_NV_HANDLE;
  args[0].flags = ref->flags;
  args[0].u.handle = ref->id;
  args[1].tag = SCR_NV_JSON;
  args[1].u.str.data = options;
  args[1].u.str.len = strlen(options);
  ScrNodeRef *fn = nh_ref_of(nh_inspect_fn);
  nh_enter();
  NhCall c = {.op = NH_INVOKE, .h = fn->id, .a = NULL, .args = args, .argc = 2, .out = &out};
  nh_run(&c);
  ScrDyn *text = nh_outcome(&c);
  if (text == NULL) return scr_str_new("", 0);
  ScrStr *s = text->kind == SCR_DYN_STR ? scr_str_retain(text->v.str) : scr_str_new("", 0);
  scr_dyn_release(text);
  return s;
}

/* The conversions for scr_node_island_export.c: what a value_out keeps
 * alive lives until the next value_out (the bridge reads it at once). */
static NhKeep nh_out_keep;

bool scr_ni_value_out(ScrDyn *v, ScrNodeValue *out) {
  NhKeep old = nh_out_keep;
  memset(&nh_out_keep, 0, sizeof nh_out_keep);
  nh_keep_done(&old);
  return nh_to_node(v, out, &nh_out_keep);
}

/* NI-6: a conversion whose keep belongs to the caller, for values the
 * runtime pushes into Node between other conversions (shared modules). */
void *scr_ni_value_out_begin(ScrDyn *v, ScrNodeValue *out, bool *ok) {
  NhKeep *k = calloc(1, sizeof *k);
  if (k == NULL) nh_oom();
  *ok = nh_to_node(v, out, k);
  return k;
}

void scr_ni_value_out_end(void *keep) {
  nh_keep_done(keep);
  free(keep);
}

ScrDyn *scr_ni_value_in(const ScrNodeValue *v) {
  ScrDyn *d = nh_from_node(v);
  return d != NULL ? d : scr_dyn_retain(scr_dyn_undefined());
}

/* NI-8: the pinned runtime objects and the refs they stand for (the pin
 * table holds one reference to each). */
size_t scr_ni_gc_pins(void ***objs, void ***refs) {
  static void **o = NULL, **r = NULL;
  static size_t cap = 0;
  if (nh_npins > cap) {
    cap = nh_npins * 2;
    void **go = realloc(o, cap * sizeof *go);
    if (go == NULL) nh_oom();
    o = go;
    void **gr = realloc(r, cap * sizeof *gr);
    if (gr == NULL) nh_oom();
    r = gr;
  }
  /* Bytes and symbols hold nothing and no trace visits them, so the walk
   * never asks for their pins: their imports stay roots while pinned. */
  size_t n = 0;
  for (size_t i = 0; i < nh_npins; i++) {
    int kind = nh_pins[i].kind;
    if (kind != NH_PIN_PROMISE && kind != NH_PIN_ERROR && kind != NH_PIN_NATIVE_ERROR) continue;
    o[n] = nh_pins[i].obj;
    r[n++] = nh_pins[i].ref;
  }
  *objs = o;
  *refs = r;
  return n;
}

/* NI-8: the ref an island handle box holds, its reference count and its
 * import id (0 unless it is the id's own ref: stubs, aliases and refs
 * whose import was transplanted have none). */
void *scr_ni_gc_ref_info(void *r, size_t *rc, uint32_t *id) {
  ScrNodeRef *ref = r;
  if (ref == NULL) return NULL;
  *rc = ref->rc;
  *id = ref->id != 0 && ref->id < ni_refs_cap && ni_refs[ref->id] == ref ? ref->id : 0;
  return ref;
}

void *scr_ni_gc_ref(const ScrDyn *box, size_t *rc, uint32_t *id) {
  return scr_ni_gc_ref_info(box->v.handle.ptr, rc, id);
}

/* ── island arrays as copies (results typed as arrays of copied values) ─
 * An island array whose declared native type is an array of primitives or
 * strings (or arrays of those) crosses as a copy of its elements, the
 * values the checked cast then meets; nested island arrays copy too, any
 * other value (a native export coming back, an island object) is itself. */
ScrDyn *scr_node_island_copy_arrays(ScrDyn *value) {
  ScrNodeRef *ref = nh_ref_of(value);
  if (ref == NULL || (ref->flags & SCR_NVF_ARRAY) == 0) return scr_dyn_retain(value);
  ScrDyn *len = scr_ni_get_str(value, "length", 6);
  if (len == NULL) return NULL;
  double n = len->kind == SCR_DYN_NUM ? len->v.num : 0;
  scr_dyn_release(len);
  ScrDyn *out = scr_dyn_new_arr();
  for (double i = 0; i < n; i++) {
    ScrDyn *key = scr_dyn_new_num(i);
    ScrDyn *element = scr_ni_get(value, key);
    scr_dyn_release(key);
    ScrDyn *copy = element != NULL ? scr_node_island_copy_arrays(element) : NULL;
    scr_dyn_release(element);
    if (copy == NULL) {
      scr_dyn_release(out);
      return NULL;
    }
    scr_dyn_arr_push(out, copy);
  }
  return out;
}

static void nh_copy_fulfilled(ScrPromise *dst, ScrPromise *src) {
  ScrDyn *payload = scr_promise_payload_is_dyn(src) ? (ScrDyn *)scr_promise_payload_ref(src)
                                                    : scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *copy = scr_node_island_copy_arrays(payload);
  scr_dyn_release(payload);
  if (copy == NULL) {
    scr_promise_reject_pending(dst);
    return;
  }
  scr_promise_fulfill_ref(dst, copy, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

/* `await` of an island promise whose declared result holds arrays: the
 * fulfillment value's island arrays copied (inside the settlement, so no
 * reaction turn is added), rejections as they are. +1 promise<dyn>. */
ScrPromise *scr_node_island_await_copy(ScrDyn *value) {
  ScrPromise *src = scr_ni_await(value);
  ScrPromise *dst = scr_promise_new();
  scr_promise_mark_handled(src);
  scr_promise_race_add(dst, src, nh_copy_fulfilled);
  scr_promise_release(src);
  return dst;
}

uint32_t scr_ni_live_handles(void) {
  const ScrNodeBridge *b = scr_ni_bridge_loaded();
  if (b == NULL) return 0;
  nh_young_flush();
  nh_drain_freed();
  nh_sweep();
  return b->live_handles();
}

void scr_ni_stop(void) { ni_stopped = true; }
bool scr_ni_running(void) { return !ni_stopped && scr_ni_bridge_loaded() != NULL; }

/* ── the handle tag (dynamic code over island values) ────────────────── */

static ScrDyn *nh_op_get(void *h, const char *key, size_t key_len) {
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  ScrDyn *result = scr_ni_get_str(box, key, key_len);
  scr_dyn_release(box);
  return result;
}

static bool nh_op_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  scr_ni_set_str(box, key, key_len, (ScrDyn *)value);
  scr_dyn_release(box);
  return true; /* handled; a throw stays pending */
}

/* A member that reads back as one of the program's own functions (a
 * native function stored on the island object, whose representative
 * crossed back as the native value, or a member of a module the program
 * shares with its islands): called natively, with the island object as
 * `this`, as V8 would call the representative. */
static bool nh_is_native_function(const ScrDyn *fn) {
  return !scr_ni_is_handle(fn) && scr_dyn_is_callable(fn);
}

static ScrDyn *nh_call_native(ScrDyn *fn, ScrDyn *this_, ScrDyn *const *args, size_t argc,
                              const char *what) {
  scr_dyn_this_push_dyn(this_);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  return result;
}

/* obj.m(...) from dynamic code: the member read, then the call with obj
 * as the receiver; a member that is not a function throws Node's TypeError
 * with the call site's text (`what`), as V8 words it. */
static ScrDyn *nh_op_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                            size_t argc, const char *what) {
  (void)h;
  ScrDyn *fn = scr_ni_get_str(self, method, strlen(method));
  if (fn == NULL) return NULL;
  if (nh_is_native_function(fn)) {
    ScrDyn *result = nh_call_native(fn, self, args, argc, what != NULL ? what : method);
    scr_dyn_release(fn);
    return result;
  }
  if (!scr_ni_is_function(fn)) {
    scr_dyn_release(fn);
    char message[512];
    snprintf(message, sizeof message, "%s is not a function", what != NULL ? what : method);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return NULL;
  }
  ScrDyn *result = scr_ni_call(fn, self, args, argc);
  scr_dyn_release(fn);
  return result;
}

static ScrDyn *nh_op_symbol_get(void *h, const ScrDyn *key) {
  if (key == NULL || key->kind != SCR_DYN_SYMBOL) return NULL;
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  ScrDyn *result = scr_ni_get(box, (ScrDyn *)key);
  scr_dyn_release(box);
  return result;
}

/* The host's ToPrimitive (scr_node_island_host.cjs), loaded once. */
static ScrDyn *nh_to_primitive_fn = NULL;

/* ToPrimitive of an island object, run by V8: Symbol.toPrimitive, then
 * toString/valueOf in the hint's order, with V8's TypeErrors. */
ScrDyn *scr_ni_to_primitive(const ScrDyn *self, int hint) {
  if (nh_to_primitive_fn == NULL) {
    ScrStr *name = scr_str_new("scriptc:toPrimitive", 19);
    nh_to_primitive_fn = nh_load(name, 0);
    scr_str_release(name);
    if (nh_to_primitive_fn == NULL) return NULL;
  }
  static const char *const hints[] = {"default", "number", "string"};
  const char *text = hints[hint >= 0 && hint <= 2 ? hint : 0];
  ScrStr *hs = scr_str_new(text, strlen(text));
  ScrDyn *args[2] = {(ScrDyn *)self, scr_dyn_new_str(hs)};
  scr_str_release(hs);
  ScrDyn *result = scr_ni_call(nh_to_primitive_fn, scr_dyn_undefined(), args, 2);
  scr_dyn_release(args[1]);
  return result;
}

/* The host's spread helper (`[...value]`), loaded once. */
static ScrDyn *nh_spread_fn = NULL;

/* Spread of an island value (`[...x]`, `f(...x)`): V8 drives the
 * iterator protocol, and the elements cross one by one into a fresh dyn
 * array (objects stay handles). +1, or NULL with the exception pending. */
static ScrDyn *nh_op_iter_pack(void *h) {
  if (nh_spread_fn == NULL) {
    ScrStr *name = scr_str_new("scriptc:spread", 14);
    nh_spread_fn = nh_load(name, 0);
    scr_str_release(name);
    if (nh_spread_fn == NULL) return NULL;
  }
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  ScrDyn *items = scr_ni_call(nh_spread_fn, scr_dyn_undefined(), &box, 1);
  scr_dyn_release(box);
  if (items == NULL) return NULL;
  ScrDyn *length = scr_ni_get_str(items, "length", 6);
  if (length == NULL) {
    scr_dyn_release(items);
    return NULL;
  }
  size_t n = length->kind == SCR_DYN_NUM && length->v.num > 0 ? (size_t)length->v.num : 0;
  scr_dyn_release(length);
  ScrDyn *out = scr_dyn_new_arr();
  for (size_t i = 0; i < n; i++) {
    ScrDyn *key = scr_dyn_new_num((double)i);
    ScrDyn *item = scr_ni_get(items, key);
    scr_dyn_release(key);
    if (item == NULL) {
      scr_dyn_release(out);
      scr_dyn_release(items);
      return NULL;
    }
    scr_dyn_arr_push(out, item);
  }
  scr_dyn_release(items);
  return out;
}

/* The host's structuredClone, loaded once. */
static ScrDyn *nh_clone_fn = NULL;

/* structuredClone of an island object: Node's own, so the copy is the
 * fresh island object Node makes (a handle of it), and a value Node cannot
 * clone throws Node's DataCloneError. +1, or NULL with the exception
 * pending. */
static ScrDyn *nh_op_clone(void *h) {
  if (nh_clone_fn == NULL) {
    ScrStr *name = scr_str_new("scriptc:clone", 13);
    nh_clone_fn = nh_load(name, 0);
    scr_str_release(name);
    if (nh_clone_fn == NULL) return NULL;
  }
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_NODE_ISLAND);
  ScrDyn *copy = scr_ni_call(nh_clone_fn, scr_dyn_undefined(), &box, 1);
  scr_dyn_release(box);
  return copy;
}

/* The host's Object.prototype.toString, loaded once. */
static ScrDyn *nh_object_tag_fn = NULL;

/* Object.prototype.toString.call of an island object, by Node. +1, or NULL
 * with the exception pending. */
static ScrStr *nh_object_tag(const ScrDyn *value) {
  if (nh_object_tag_fn == NULL) {
    ScrStr *name = scr_str_new("scriptc:objectTag", 17);
    nh_object_tag_fn = nh_load(name, 0);
    scr_str_release(name);
    if (nh_object_tag_fn == NULL) return NULL;
  }
  ScrDyn *args[1] = {(ScrDyn *)value};
  ScrDyn *tag = scr_ni_call(nh_object_tag_fn, scr_dyn_undefined(), args, 1);
  if (tag == NULL) return NULL;
  ScrStr *out = tag->kind == SCR_DYN_STR ? scr_str_retain(tag->v.str) : scr_str_new("[object Object]", 15);
  scr_dyn_release(tag);
  return out;
}

static const ScrDynHandleOps nh_ops = {
    .cls = "Object",
    .retain = nh_ref_retain_v,
    .release = nh_ref_release_v,
    .invoke = nh_op_invoke,
    .get = nh_op_get,
    .set = nh_op_set,
    .symbol_get = nh_op_symbol_get,
    .iter_pack = nh_op_iter_pack,
    .clone = nh_op_clone,
};

/* At exit: what the unit itself still holds (pins, unsettled waiters,
 * util.inspect), so the runtime's reference audit sees only the program's
 * own objects. */
static void nh_cleanup(void) {
  nh_drain_freed();
  /* What the last conversion for the export unit kept alive. */
  NhKeep last = nh_out_keep;
  memset(&nh_out_keep, 0, sizeof nh_out_keep);
  nh_keep_done(&last);
  if (nh_inspect_fn != NULL) {
    scr_dyn_release(nh_inspect_fn);
    nh_inspect_fn = NULL;
  }
  if (nh_to_primitive_fn != NULL) {
    scr_dyn_release(nh_to_primitive_fn);
    nh_to_primitive_fn = NULL;
  }
  if (nh_clone_fn != NULL) {
    scr_dyn_release(nh_clone_fn);
    nh_clone_fn = NULL;
  }
  if (nh_object_tag_fn != NULL) {
    scr_dyn_release(nh_object_tag_fn);
    nh_object_tag_fn = NULL;
  }
  if (nh_has_own_fn != NULL) {
    scr_dyn_release(nh_has_own_fn);
    nh_has_own_fn = NULL;
  }
  if (nh_is_enumerable_fn != NULL) {
    scr_dyn_release(nh_is_enumerable_fn);
    nh_is_enumerable_fn = NULL;
  }
  if (nh_spread_fn != NULL) {
    scr_dyn_release(nh_spread_fn);
    nh_spread_fn = NULL;
  }
  while (nh_nyoung_views > 0) scr_bytes_release(nh_young_views[--nh_nyoung_views].obj);
  free(nh_young_views);
  nh_young_views = NULL;
  nh_young_views_cap = 0;
  while (nh_npins > 0) {
    NhPin pin = nh_pins[--nh_npins];
    pin.ref->pin = 0;
    nh_pin_release_obj(&pin);
    nh_ref_release(pin.ref);
  }
  while (nh_nwaiters > 0) scr_promise_release(nh_waiters[--nh_nwaiters].promise);
  free(nh_pins);
  free(nh_pin_index);
  free(nh_waiters);
  nh_pin_index = NULL;
  nh_pin_index_cap = nh_pin_index_len = 0;
  nh_pins = NULL;
  nh_waiters = NULL;
  nh_pins_cap = nh_waiters_cap = 0;
}

void scr_ni_handles_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_NODE_ISLAND, &nh_ops);
  scr_atexit(nh_cleanup);
}

/* ── NI-4d: util.types, Array.isArray and uncaught reports ─────────────── */

static ScrDyn *nh_util_types = NULL; /* Node's util.types (held to exit) */

static void nh_util_types_cleanup(void) {
  scr_dyn_release(nh_util_types);
  nh_util_types = NULL;
}

bool scr_ni_util_type_is(const ScrDyn *value, const ScrStr *probe) {
  if (nh_util_types == NULL) {
    ScrStr *path = scr_str_new("node:util", 9);
    ScrDyn *util = scr_ni_require(path);
    scr_str_release(path);
    if (util == NULL) return false;
    nh_util_types = scr_ni_get_str(util, "types", 5);
    if (nh_util_types != NULL) scr_atexit(nh_util_types_cleanup);
    scr_dyn_release(util);
    if (nh_util_types == NULL) return false;
  }
  ScrDyn *args[1] = {(ScrDyn *)value};
  ScrDyn *r = scr_ni_call_method(nh_util_types, probe->data, probe->len, args, 1);
  if (r == NULL) return false;
  bool answer = r->kind == SCR_DYN_BOOL && r->v.b;
  scr_dyn_release(r);
  return answer;
}

bool scr_ni_is_array(ScrDyn *value) {
  if (value == NULL) return false;
  if (value->kind == SCR_DYN_ARR) return true;
  if (!scr_ni_is_handle(value)) return value->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(value);
  return (((ScrNodeRef *)value->v.handle.ptr)->flags & SCR_NVF_ARRAY) != 0;
}

bool scr_ni_report_uncaught(ScrError *error) {
  ScrNodeRef *ref = nh_pinned(error, NH_PIN_ERROR);
  const ScrNodeBridge *bridge = scr_ni_bridge_loaded();
  if (ref == NULL || ref->id == 0 || bridge == NULL) return false;
  ScrNodeErrorInfo info;
  nh_error_info(ref->id, &info);
  if (info.stack == NULL) return false;
  if (info.arrow != NULL && info.arrow_len > 0) {
    fwrite(info.arrow, 1, info.arrow_len, stderr);
    fputs("\n\n", stderr);
  }
  fwrite(info.stack, 1, info.stack_len, stderr);
  fprintf(stderr, "\n\nNode.js v%s\n", bridge->node_version);
  fflush(stderr);
  return true;
}

/* A native error the runtime raises as a process event (an uncaught error,
 * the reason of a rejection Node tracks, a warning) is one V8 error for as
 * long as native code holds it: the first crossing makes the V8 error, and
 * from then on the native error crosses as that error and that error
 * crosses back as the native one, so a native listener registered on
 * Node's `process` receives the error that was thrown, with its class and
 * fields, not a view of a copy. Any other value is left alone. */
void scr_ni_error_link(ScrDyn *value) {
  if (scr_exc_pending()) return; /* the caller's exception stays as it is */
  ScrError *e = value != NULL ? scr_errdyn_err_of(value) : NULL;
  if (e == NULL) return;
  if (nh_pinned(e, NH_PIN_ERROR) == NULL && nh_pinned(e, NH_PIN_NATIVE_ERROR) == NULL) {
    ScrDyn *args[1] = {value};
    ScrDyn *copy = scr_ni_helper("same", args, 1);
    if (copy != NULL && scr_ni_is_handle(copy))
      nh_pin(e, NH_PIN_NATIVE_ERROR, (ScrNodeRef *)copy->v.handle.ptr);
    scr_dyn_release(copy);
    if (scr_exc_pending()) scr_exc_clear();
  }
  scr_error_release(e);
}

/* ── NI-4a: libCall entry points of compiled island code ─────────────────
 * The compiler (frontend/lowering/lower-node-island.ts) lowers member
 * operations on island values to `nodeIsland.*` libCalls, which pass
 * strings as ScrStr and argument lists as one dyn array; these adapt them
 * to the scr_ni_* API above. Borrowed arguments, +1 results, NULL (or a
 * pending exception) when JavaScript threw. */

static size_t ni_libcall_args(ScrDyn *args, ScrDyn *const **items) {
  if (args == NULL || args->kind != SCR_DYN_ARR) {
    *items = NULL;
    return 0;
  }
  *items = args->v.arr.items;
  return args->v.arr.len;
}

/* Routing follows the value: a value typed by an island's declarations
 * may still be a native object (an island interface annotating a native
 * literal, a native error handed to an island callback). Those take the
 * ordinary checked-dynamic operations instead of the bridge. */
ScrDyn *scr_dyn_reflect_get(ScrDyn *target, ScrDyn *raw_key, ScrDyn *receiver);

static bool ni_lc_island(const ScrDyn *v) { return v != NULL && scr_ni_is_handle(v); }

/* An island promise is an island object as well: an island class that
 * extends Promise adds members of its own (an SDK's request promise with
 * `withResponse()`), while the program holds the promise as its mirror, a
 * plain promise. A member a promise does not have itself is the island
 * object's, which the pin table names; `then`, `catch` and `finally` stay
 * the mirror's, so reactions keep the runtime's rules. The island object
 * of mirror `obj` for member `key` (+1 handle box), or NULL. */
static ScrDyn *nh_promise_object(const ScrDyn *obj, const char *key, size_t len) {
  if (obj == NULL || obj->kind != SCR_DYN_PROMISE) return NULL;
  if ((len == 4 && memcmp(key, "then", 4) == 0) || (len == 5 && memcmp(key, "catch", 5) == 0) ||
      (len == 7 && memcmp(key, "finally", 7) == 0))
    return NULL;
  ScrNodeRef *ref = nh_pinned(obj->v.promise, NH_PIN_PROMISE);
  return ref != NULL ? scr_dyn_new_handle(ref, SCR_DYNH_NODE_ISLAND) : NULL;
}

static ScrDyn *nh_promise_object_key(const ScrDyn *obj, const ScrDyn *key) {
  if (key == NULL || key->kind != SCR_DYN_STR) return NULL;
  return nh_promise_object(obj, key->v.str->data, key->v.str->len);
}

static int nh_promise_has(const ScrDyn *promise, const char *key, size_t len) {
  ScrDyn *island = nh_promise_object(promise, key, len);
  if (island == NULL) return -1;
  ScrStr *name = scr_str_new(key, len);
  ScrDyn *k = scr_dyn_new_str(name);
  scr_str_release(name);
  int found = scr_ni_has(island, k);
  scr_dyn_release(k);
  scr_dyn_release(island);
  return found == 1 ? 1 : 0;
}

static int nh_promise_set(const ScrDyn *promise, const char *key, size_t len, ScrDyn *value) {
  ScrDyn *island = nh_promise_object(promise, key, len);
  if (island == NULL) return 0;
  (void)scr_ni_set_str(island, key, len, value);
  scr_dyn_release(island);
  return 1;
}

static int nh_promise_get(const ScrDyn *promise, const char *key, size_t len, ScrDyn **out) {
  ScrDyn *island = nh_promise_object(promise, key, len);
  if (island == NULL) return 0;
  *out = scr_ni_get_str(island, key, len);
  scr_dyn_release(island);
  return 1;
}

/* A NUL-terminated copy of `key` for the dyn invoke path (heap only for long names). */
static ScrDyn *ni_lc_native_invoke(ScrDyn *obj, ScrStr *key, ScrDyn *const *items, size_t argc) {
  char small[128];
  char *name = key->len < sizeof small ? small : malloc(key->len + 1);
  if (name == NULL) scr_trap("scriptc: out of memory\n");
  memcpy(name, key->data, key->len);
  name[key->len] = '\0';
  ScrDyn *result = scr_dyn_invoke(obj, name, items, argc, name);
  if (name != small) free(name);
  return result;
}

ScrDyn *scr_node_island_get(ScrDyn *obj, ScrStr *key) {
  if (ni_lc_island(obj)) return scr_ni_get_str(obj, key->data, key->len);
  ScrDyn *island = nh_promise_object(obj, key->data, key->len);
  if (island != NULL) {
    ScrDyn *member = scr_ni_get_str(island, key->data, key->len);
    scr_dyn_release(island);
    return member;
  }
  ScrDyn *k = scr_dyn_new_str(key);
  ScrDyn *value = scr_dyn_reflect_get(obj, k, obj);
  scr_dyn_release(k);
  return value;
}

ScrDyn *scr_node_island_get_key(ScrDyn *obj, ScrDyn *key) {
  if (ni_lc_island(obj)) return scr_ni_get(obj, key);
  ScrDyn *island = nh_promise_object_key(obj, key);
  if (island != NULL) {
    ScrDyn *member = scr_ni_get(island, key);
    scr_dyn_release(island);
    return member;
  }
  return scr_dyn_reflect_get(obj, key, obj);
}

void scr_node_island_set(ScrDyn *obj, ScrStr *key, ScrDyn *value) {
  ScrDyn *island = ni_lc_island(obj) ? NULL : nh_promise_object(obj, key->data, key->len);
  if (island != NULL) {
    (void)scr_ni_set_str(island, key->data, key->len, value);
    scr_dyn_release(island);
  } else if (ni_lc_island(obj)) {
    (void)scr_ni_set_str(obj, key->data, key->len, value);
  } else {
    scr_dyn_key_set(obj, key, value);
  }
}

void scr_node_island_set_key(ScrDyn *obj, ScrDyn *key, ScrDyn *value) {
  ScrDyn *island = ni_lc_island(obj) ? NULL : nh_promise_object_key(obj, key);
  if (island != NULL) {
    (void)scr_ni_set(island, key, value);
    scr_dyn_release(island);
  } else if (ni_lc_island(obj)) {
    (void)scr_ni_set(obj, key, value);
  } else {
    scr_dyn_key_set_computed(obj, key, value);
  }
}

ScrDyn *scr_node_island_invoke(ScrDyn *obj, ScrStr *key, ScrDyn *args) {
  ScrDyn *const *items;
  size_t argc = ni_libcall_args(args, &items);
  if (ni_lc_island(obj)) return scr_ni_call_method(obj, key->data, key->len, items, argc);
  ScrDyn *island = nh_promise_object(obj, key->data, key->len);
  if (island != NULL) {
    ScrDyn *result = scr_ni_call_method(island, key->data, key->len, items, argc);
    scr_dyn_release(island);
    return result;
  }
  return ni_lc_native_invoke(obj, key, items, argc);
}

ScrDyn *scr_node_island_apply(ScrDyn *fn, ScrDyn *args) {
  ScrDyn *const *items;
  size_t argc = ni_libcall_args(args, &items);
  if (ni_lc_island(fn)) return scr_ni_call(fn, NULL, items, argc);
  return scr_dyn_call(fn, items, argc, "value");
}

ScrDyn *scr_node_island_apply_to(ScrDyn *fn, ScrDyn *this_, ScrDyn *args) {
  ScrDyn *const *items;
  size_t argc = ni_libcall_args(args, &items);
  if (nh_is_native_function(fn)) return nh_call_native(fn, this_, items, argc, "value");
  return scr_ni_call(fn, this_, items, argc);
}

ScrDyn *scr_node_island_construct(ScrDyn *ctor, ScrDyn *args) {
  if (!ni_lc_island(ctor)) {
    ScrStr *what = scr_str_new("value", 5);
    ScrDyn *result = scr_dyn_construct(ctor, args, what);
    scr_str_release(what);
    return result;
  }
  ScrDyn *const *items;
  size_t argc = ni_libcall_args(args, &items);
  return scr_ni_construct(ctor, items, argc);
}

bool scr_node_island_instanceof(ScrDyn *value, ScrDyn *ctor) {
  return scr_ni_instanceof(value, ctor) == 1;
}

static bool nh_dyn_is_array(const ScrDyn *value) { return scr_ni_is_array((ScrDyn *)value); }

static const ScrNiDynOps nh_dyn_ops = {
    .get = scr_ni_get,
    .get_str = scr_ni_get_str,
    .has = scr_ni_has,
    .delete_key = scr_ni_delete,
    .own_keys = scr_ni_own_keys,
    .is_array = nh_dyn_is_array,
    .call = scr_ni_call,
    .construct = scr_ni_construct,
    .type_of = scr_ni_typeof,
    .util_type_is = scr_ni_util_type_is,
    .instance_of = scr_ni_instanceof,
    .to_primitive = scr_ni_to_primitive,
    .is_function = scr_ni_is_function,
    .error_get = nh_error_get,
    .object_tag = nh_object_tag,
    .function_identity = nh_function_identity,
    .function_of_identity = nh_function_of_identity,
    .inspect = scr_ni_inspect,
    .report_uncaught = scr_ni_report_uncaught,
    .weak_get = scr_ni_weak_get,
    .weak_test = scr_ni_weak_test,
    .weak_set = scr_ni_weak_set,
    .error_has = nh_error_has,
    .promise_get = nh_promise_get,
    .promise_has = nh_promise_has,
    .promise_set = nh_promise_set,
    .set = scr_ni_set,
    .has_own = scr_ni_has_own,
};

__attribute__((constructor)) static void nh_install(void) {
  scr_ni_dyn_ops = &nh_dyn_ops;
  scr_promise_subscribe_fn = nh_promise_subscribe;
}

#endif /* !_WIN32 && !__wasi__ */
