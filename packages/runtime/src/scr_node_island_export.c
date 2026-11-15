/* Node islands: native values in Node (scope-B milestone NI-5). Links with
 * scr_node_island.c (the `nodeIsland` runtime feature) and nothing else.
 *
 * The export table. A native value that crosses into Node by reference (a
 * closure, a promise, a record or class instance, a checked-dynamic object
 * or array) gets an export id: the table holds it strongly (+1) and the
 * bridge keeps one V8 representative per id, weakly. The same native value
 * always gets the same id, so it always meets the same V8 object, and a
 * representative crossing back is answered with the original value
 * (SCR_NV_EXPORT), so identity holds both ways. Identity is the referent,
 * not the dyn box: a record boxed twice is two capsules over one record.
 *
 * What the representative does (scr_node_bridge.cc):
 *  - closures are V8 functions whose calls run export_call: the arguments
 *    cross into the runtime per the boundary rules and meet the closure's
 *    declared parameter types through its dyn thunk (a mismatch throws the
 *    runtime's TypeError into JavaScript); the result crosses back; a
 *    runtime exception becomes a JavaScript throw and a JavaScript throw
 *    inside a nested island call propagates out as a runtime exception;
 *  - promises are V8 promises resolved inside the runtime promise's own
 *    settlement (export_watch), so their reactions queue exactly when a
 *    JavaScript promise's would;
 *  - objects use interceptors: every property read, write, `in`, delete
 *    and key enumeration goes to the native storage (Reflect.get/set over
 *    the dyn value: a typed record capsule reads and commits its fields).
 *
 *  - a native object of a twin class (below) is a real object of the
 *    island's own class, made by the bootstrap: its twin.
 *
 * When V8 collects a representative, the bridge reports export_release at
 * its next entry (never inside a GC) and the table drops its reference.
 * Cycles through both heaps are found by the analysis of
 * scr_node_island_gc.c before each major GC (NI-8). */
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

const ScrDynHandleOps *scr_dyn_handle_ops_of(const ScrDyn *d); /* scr_json.c */

typedef struct {
  ScrDyn *value; /* +1; NULL for a free slot */
  const void *identity;
  uint32_t flags;
  const ScrNiTwinClass *twin; /* the value's twin class, or NULL */
  void *attachment;           /* what the twin class's attach answered */
  uint32_t adopts;            /* the import this export is adopting (while it does) */
  bool adopted;               /* its representative is an island object it adopted */
} NiExport;

static NiExport *ni_exports = NULL; /* index = id; id 0 unused */
static uint32_t ni_exports_len = 1, ni_exports_cap = 0;
/* Worker threads read the table (a result that is a native value), while
 * the island's thread mints entries and the table grows. */
static pthread_mutex_t ni_exports_lock = PTHREAD_MUTEX_INITIALIZER;

/* The lock is taken once another thread uses the island (the handle
 * unit's shared mode, which is set only between operations). */
static inline bool ni_exports_take(void) {
  if (!SCR_NI_THREADS || !atomic_load_explicit(&scr_ni_threads_shared, memory_order_relaxed))
    return false;
  pthread_mutex_lock(&ni_exports_lock);
  return true;
}

static inline void ni_exports_give(bool held) {
  if (held) pthread_mutex_unlock(&ni_exports_lock);
}

static uint32_t *ni_free = NULL;
static uint32_t ni_nfree = 0, ni_free_cap = 0;

/* identity -> id, open addressing over a power-of-two table. */
typedef struct {
  const void *key;
  uint32_t id;
} NiIdEntry;
static NiIdEntry *ni_ids = NULL;
static size_t ni_ids_cap = 0, ni_ids_len = 0, ni_ids_dead = 0;
static const char ni_tomb;

SCR_COLD static void ni_export_oom(void) { scr_trap("scriptc: out of memory\n"); }

static size_t ni_hash(const void *p) {
  uintptr_t x = (uintptr_t)p;
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33;
  return (size_t)x;
}

static void ni_ids_put(const void *key, uint32_t id);

static void ni_ids_grow(void) {
  NiIdEntry *old = ni_ids;
  size_t old_cap = ni_ids_cap;
  ni_ids_cap = old_cap ? old_cap * 2 : 64;
  while (ni_ids_len * 2 >= ni_ids_cap) ni_ids_cap *= 2;
  ni_ids = calloc(ni_ids_cap, sizeof *ni_ids);
  if (ni_ids == NULL) ni_export_oom();
  ni_ids_len = 0;
  ni_ids_dead = 0;
  for (size_t i = 0; i < old_cap; i++)
    if (old[i].key != NULL && old[i].key != &ni_tomb) ni_ids_put(old[i].key, old[i].id);
  free(old);
}

static void ni_ids_put(const void *key, uint32_t id) {
  if ((ni_ids_len + ni_ids_dead + 1) * 2 > ni_ids_cap) ni_ids_grow();
  size_t mask = ni_ids_cap - 1;
  for (size_t i = ni_hash(key) & mask;; i = (i + 1) & mask) {
    if (ni_ids[i].key == NULL || ni_ids[i].key == &ni_tomb) {
      if (ni_ids[i].key == &ni_tomb) ni_ids_dead--;
      ni_ids[i].key = key;
      ni_ids[i].id = id;
      ni_ids_len++;
      return;
    }
  }
}

static uint32_t ni_ids_get(const void *key) {
  if (ni_ids_cap == 0) return 0;
  size_t mask = ni_ids_cap - 1;
  for (size_t i = ni_hash(key) & mask;; i = (i + 1) & mask) {
    if (ni_ids[i].key == NULL) return 0;
    if (ni_ids[i].key == key) return ni_ids[i].id;
  }
}

static void ni_ids_del(const void *key) {
  if (ni_ids_cap == 0) return;
  size_t mask = ni_ids_cap - 1;
  for (size_t i = ni_hash(key) & mask;; i = (i + 1) & mask) {
    if (ni_ids[i].key == NULL) return;
    if (ni_ids[i].key == key) {
      ni_ids[i].key = &ni_tomb;
      ni_ids_len--;
      ni_ids_dead++;
      return;
    }
  }
}

/* ── twins ────────────────────────────────────────────────────────────
 * A native object of a platform class whose receivers in the island test
 * its brand (undici's fetch, addEventListener, AbortSignal.any and
 * events.once all test a signal's) cannot be an interceptor object there.
 * It crosses as an export whose representative is a real object of the
 * island's own class, its twin, so identity (one twin per native object,
 * the native object again when the twin crosses back) and lifetime (the
 * table holds the native object while V8 can reach the twin, and V8 holds
 * the twin while the program holds the native object) are the table's.
 * The twin asks its native object through the handle's own property read
 * and method call (ni_twin_op), and the class's unit tells the twin what
 * changes natively afterwards (scr_ni_twin_tell).
 *
 * The other way, an island object of a twin class that reaches native code
 * meets native receivers that test the handle's tag (fetch, AbortSignal.any,
 * events.once, timers/promises). It is adopted (scr_ni_twin_adopt): the
 * class makes a native object, and that object's export takes the island
 * object as its representative. From then on the pair is an export like
 * any other twin, with the same identity and lifetime, and the island
 * object tells its native object what changes (the class's `hear`).
 *
 * The classes register from their own units, which link only into programs
 * that have both islands and the class's native objects. */
static ScrNiTwinClass *ni_twin_classes = NULL;

void scr_ni_twin_register(ScrNiTwinClass *cls) {
  cls->next = ni_twin_classes;
  ni_twin_classes = cls;
}

static const ScrNiTwinClass *ni_twin_class(const ScrDyn *v) {
  if (v->kind != SCR_DYN_HANDLE) return NULL;
  for (const ScrNiTwinClass *c = ni_twin_classes; c != NULL; c = c->next)
    if ((int)v->v.handle.tag == c->tag) return c;
  return NULL;
}

bool scr_ni_twin_box(const ScrDyn *v) { return ni_twin_class(v) != NULL; }

/* The identity of the second class of a shared native object: the object's
 * address with its low bit set, which no object has. */
static const void *ni_twin_second(const void *object) {
  return (const void *)((uintptr_t)object | 1u);
}

/* The identity of a value that crosses by reference: the referent for
 * boxes that wrap one (closures, typed capsules), a promise's shared
 * identity (a typed promise boxes a fresh adapter each time it crosses),
 * else the box. */
static const void *ni_identity(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_FUNC:
    /* A class value is boxed afresh per read: its identity is the class. */
    if (v->v.fn.class_obj != NULL) return v->v.fn.class_obj;
    return v->v.fn.clo != NULL ? (const void *)v->v.fn.clo : (const void *)v;
  case SCR_DYN_PROMISE:
    return scr_promise_identity_key(v->v.promise);
  case SCR_DYN_TYPED_REF:
    return v->v.typed_ref.ptr;
  case SCR_DYN_HANDLE: {
    /* A Map or Set: its native storage. A twin: its native object. */
    const ScrNiTwinClass *twin = ni_twin_class(v);
    return twin != NULL && twin->shares_object ? ni_twin_second(v->v.handle.ptr) : v->v.handle.ptr;
  }
  default:
    return v;
  }
}

static bool ni_index_key(const ScrStr *s) {
  if (s->len == 0 || s->len > 10) return false;
  if (s->len > 1 && s->data[0] == '0') return false;
  for (size_t i = 0; i < s->len; i++)
    if (s->data[i] < '0' || s->data[i] > '9') return false;
  return true;
}

/* A dyn array, a live array capsule, or a capsule whose view is an array
 * (a tuple). */
static bool ni_is_array(const ScrDyn *v) {
  if (v->kind == SCR_DYN_ARR) return true;
  if (v->kind != SCR_DYN_TYPED_REF) return false;
  if (scr_dyn_typed_ref_array_ops(v) != NULL) return true;
  if (v->v.typed_ref.record || v->v.typed_ref.klass) return false;
  ScrDyn *view = scr_dyn_typed_ref_materialize(v);
  bool array = view != NULL && view->kind == SCR_DYN_ARR;
  scr_dyn_release(view);
  if (scr_exc_pending()) scr_exc_clear();
  return array;
}

/* The live Map or Set a value is (a dyn handle, or a typed capsule whose
 * view is one): +1 view with *set telling which, or NULL. */
static ScrDyn *ni_collection(const ScrDyn *v, bool *set) {
  ScrDyn *view = NULL;
  if (v->kind == SCR_DYN_HANDLE) view = scr_dyn_retain((ScrDyn *)v);
  else if (v->kind == SCR_DYN_TYPED_REF && !v->v.typed_ref.record && !v->v.typed_ref.klass &&
           scr_dyn_typed_ref_array_ops(v) == NULL) {
    view = scr_dyn_typed_ref_materialize(v);
    if (scr_exc_pending()) scr_exc_clear();
  }
  if (view != NULL && view->kind == SCR_DYN_HANDLE &&
      (view->v.handle.tag == SCR_DYNH_MAP || view->v.handle.tag == SCR_DYNH_SET)) {
    *set = view->v.handle.tag == SCR_DYNH_SET;
    return view;
  }
  scr_dyn_release(view);
  return NULL;
}

uint32_t scr_ni_export_flags(const ScrDyn *v) {
  /* A native error's node, whatever its form (a plain view, or the capsule
   * of an instance of a program class): scr_node_island_handle.c exports
   * it with the error's own value form. */
  if (v->kind == SCR_DYN_OBJ || v->kind == SCR_DYN_TYPED_REF) {
    ScrError *e = scr_errdyn_err_of(v);
    if (e != NULL) {
      scr_error_release(e);
      return SCR_NVF_ERROR;
    }
  }
  switch (v->kind) {
  case SCR_DYN_FUNC:
    return v->v.fn.class_obj != NULL ? SCR_NVF_FUNCTION | SCR_NVF_CONSTRUCTOR : SCR_NVF_FUNCTION;
  case SCR_DYN_PROMISE:
    return SCR_NVF_PROMISE;
  case SCR_DYN_ARR:
    return SCR_NVF_ARRAY;
  case SCR_DYN_HANDLE:
  case SCR_DYN_TYPED_REF: {
    if (ni_twin_class(v) != NULL) return SCR_NVF_TWIN;
    if (v->kind == SCR_DYN_TYPED_REF && ni_is_array(v)) return SCR_NVF_ARRAY;
    bool set = false;
    ScrDyn *c = ni_collection(v, &set);
    if (c == NULL) return 0;
    scr_dyn_release(c);
    return set ? SCR_NVF_SET : SCR_NVF_MAP;
  }
  default:
    return 0;
  }
}

/* The representative of a native error is a V8 Error of its intrinsic
 * class whose own properties are the native error's: the bridge installs
 * one per name SCR_NODE_EXPORT_OWN lists, and each read or write of one
 * comes back here (export_get, export_set), so there is one set of values.
 * For an instance of a program class the export also answers, from behind
 * the V8 Error and in front of its intrinsic prototype, what the class
 * holds. It answers only what the native error or its class holds, and
 * leaves what an error inherits (`toString`, a plain TypeError's
 * `constructor`) to V8's own. */
static bool ni_export_is_error(uint32_t id) { return (ni_exports[id].flags & SCR_NVF_ERROR) != 0; }

static ScrDyn *ni_class_method(const ScrDyn *target, const ScrDyn *key);

/* The properties every error keeps in slots of its own, which typed code
 * reads and writes: message, name and cause. An error's view holds them as
 * of the last time it was built or written through, so the export answers
 * them, and whether they are own properties, from the error itself. */
enum { NI_SLOT_NONE, NI_SLOT_MESSAGE, NI_SLOT_NAME, NI_SLOT_CAUSE };

static int ni_error_slot(const ScrStr *name) {
  if (name->len == 7 && memcmp(name->data, "message", 7) == 0) return NI_SLOT_MESSAGE;
  if (name->len == 4 && memcmp(name->data, "name", 4) == 0) return NI_SLOT_NAME;
  if (name->len == 5 && memcmp(name->data, "cause", 5) == 0) return NI_SLOT_CAUSE;
  return NI_SLOT_NONE;
}

/* Whether slot `slot` of `e` is an own property, and its attribute bits
 * (SCR_NODE_EXPORT_OWN's) as an error is made with them: writable and
 * configurable, enumerable when an assignment made it. A descriptor the
 * program defined since is the view's to say (ni_slot_defined_bits). */
static bool ni_error_slot_own(const ScrError *e, int slot, int *bits) {
  bool own = slot == NI_SLOT_MESSAGE ? e->message_present
             : slot == NI_SLOT_NAME  ? e->name_present
                                     : e->error_cause != NULL;
  bool enumerable = slot == NI_SLOT_MESSAGE ? e->message_enumerable
                    : slot == NI_SLOT_NAME  ? e->name_enumerable
                                            : e->cause_enumerable;
  *bits = 1 | 4 | (enumerable ? 2 : 0);
  return own;
}

/* The writable and configurable bits of a slot property as the error's
 * view holds them: the slot keeps the value, and what
 * Object.defineProperty(err, "message", { writable: false }) said lives on
 * the view. `bits` keeps the slot's own enumerable bit. false with the
 * exception pending when reading the descriptor threw. */
static bool ni_slot_defined_bits(ScrDyn *target, ScrDyn *key, int *bits) {
  ScrDyn *descriptor = scr_dyn_get_own_property_descriptor(target, key);
  if (scr_exc_pending()) {
    scr_dyn_release(descriptor);
    return false;
  }
  if (descriptor != NULL && descriptor->kind == SCR_DYN_OBJ &&
      scr_dyn_obj_get(descriptor, "value", 5) != NULL) {
    const ScrDyn *writable = scr_dyn_obj_get(descriptor, "writable", 8);
    const ScrDyn *configurable = scr_dyn_obj_get(descriptor, "configurable", 12);
    *bits &= ~(1 | 4);
    if (writable != NULL && writable->kind == SCR_DYN_BOOL && writable->v.b) *bits |= 1;
    if (configurable != NULL && configurable->kind == SCR_DYN_BOOL && configurable->v.b) *bits |= 4;
  }
  scr_dyn_release(descriptor);
  return true;
}

/* Whether the view itself holds `name` as an accessor (an error whose
 * message is computed on demand): the slot has no value then, and the
 * view's getter answers. */
static bool ni_view_accessor(const ScrDyn *target, const ScrStr *name) {
  if (target->kind != SCR_DYN_OBJ) return false;
  ScrDyn *getter = scr_dyn_obj_accessor_fn(target, name->data, name->len, false);
  bool accessor = getter != NULL && getter->kind == SCR_DYN_FUNC;
  scr_dyn_release(getter);
  return accessor;
}

/* Member `key` of native error `target` as its export answers it (+1), or
 * NULL when V8's own Error answers (or an exception is pending): a field,
 * an accessor or a method of the error's class, and its class as
 * `constructor`. The names every object inherits and the constructor of an
 * intrinsic error class are V8's, so `e.constructor === TypeError` holds
 * in island code for a native TypeError. */
static ScrDyn *ni_error_member(ScrDyn *target, ScrDyn *key) {
  if (key->kind != SCR_DYN_STR) return NULL;
  const ScrStr *name = key->v.str;
  int slot = ni_error_slot(name);
  if (slot != NI_SLOT_NONE && !ni_view_accessor(target, name)) {
    ScrError *e = scr_errdyn_err_of(target);
    if (e != NULL) {
      int bits;
      ScrDyn *value = NULL;
      if (ni_error_slot_own(e, slot, &bits)) {
        value = slot == NI_SLOT_MESSAGE ? scr_dyn_new_str(e->message)
                : slot == NI_SLOT_NAME  ? scr_dyn_new_str(e->name)
                                        : scr_dyn_retain(e->error_cause);
      }
      scr_error_release(e);
      if (value != NULL) return value;
      /* Not in the slot: the view answers (a DOMException's name and
       * message are its view's own). */
    }
  }
  bool own = scr_dyn_has_key(target, name);
  if (scr_exc_pending()) return NULL;
  bool ctor = name->len == 11 && memcmp(name->data, "constructor", 11) == 0;
  if (!own && !ctor && scr_dyn_in(target, name)) return NULL;
  if (scr_exc_pending()) return NULL;
  ScrDyn *value = scr_dyn_reflect_get(target, key, target);
  if (value == NULL || scr_exc_pending()) {
    scr_dyn_release(value);
    return NULL;
  }
  if (ctor) {
    static const char *const intrinsic[] = {"Error",          "TypeError", "RangeError",
                                            "SyntaxError",    "ReferenceError", "EvalError",
                                            "URIError",       "AggregateError"};
    for (size_t i = 0; i < sizeof intrinsic / sizeof intrinsic[0]; i++) {
      ScrDyn *builtin = scr_dyn_error_constructor(intrinsic[i]);
      bool same = builtin == value;
      scr_dyn_release(builtin);
      if (same) {
        scr_dyn_release(value);
        return NULL;
      }
    }
  }
  if (value->kind == SCR_DYN_UNDEF && !own) {
    scr_dyn_release(value);
    return ni_class_method(target, key);
  }
  return value;
}

/* Whether `v` crosses into Node as an export (by reference). */
bool scr_ni_exportable(const ScrDyn *v);
bool scr_ni_exportable(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_FUNC:
  case SCR_DYN_PROMISE:
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR: /* a Proxy over an Array in V8 (NI-5b) */
  case SCR_DYN_TYPED_REF:
    return true;
  case SCR_DYN_HANDLE: /* Maps and Sets (NI-5b), and twins */
    return v->v.handle.tag == SCR_DYNH_MAP || v->v.handle.tag == SCR_DYNH_SET ||
           ni_twin_class(v) != NULL;
  default:
    return false;
  }
}


/* The export id of `v` (borrowed), minting one on first crossing (`fresh`).
 * Called with the table's lock. The twin fields of an entry (twin,
 * attachment, adopts, adopted) are read and written on the island's thread
 * only, which is also the only thread that changes the table, so that
 * thread reads them without the lock; a twin class's callbacks (attach,
 * detach, adopt, hear) run outside the lock, since they are a class's own
 * code and may come back to the table. */
static uint32_t ni_export_id_locked(ScrDyn *v, bool *fresh) {
  const void *identity = ni_identity(v);
  uint32_t id = ni_ids_get(identity);
  *fresh = id == 0;
  if (id != 0) return id;
  if (ni_nfree > 0) {
    id = ni_free[--ni_nfree];
  } else {
    if (ni_exports_len >= ni_exports_cap) {
      uint32_t cap = ni_exports_cap ? ni_exports_cap * 2 : 64;
      NiExport *grown = realloc(ni_exports, cap * sizeof *grown);
      if (grown == NULL) ni_export_oom();
      ni_exports = grown;
      ni_exports_cap = cap;
      if (ni_exports_len == 1) memset(&ni_exports[0], 0, sizeof ni_exports[0]);
    }
    id = ni_exports_len++;
  }
  ni_exports[id].value = scr_dyn_retain(v);
  ni_exports[id].identity = identity;
  /* The table keeps a promise's identity cell while the export lives: a
   * freed cell's address could come back as another promise's. */
  if (v->kind == SCR_DYN_PROMISE) scr_promise_identity_hold(identity);
  ni_exports[id].flags = scr_ni_export_flags(v);
  ni_exports[id].twin = ni_twin_class(v);
  ni_exports[id].attachment = NULL;
  ni_exports[id].adopts = 0;
  ni_exports[id].adopted = false;
  ni_ids_put(identity, id);
  return id;
}

/* Export `id` of `v` was just made: its native object starts telling its
 * twin what changes. After the lock was given back (ni_export_id_locked). */
static void ni_twin_attach(uint32_t id, ScrDyn *v) {
  const ScrNiTwinClass *twin = ni_exports[id].twin;
  if (twin == NULL || twin->attach == NULL) return;
  void *attachment = twin->attach(id, v->v.handle.ptr);
  if (ni_exports[id].value == v) ni_exports[id].attachment = attachment;
}

uint32_t scr_ni_export_id(ScrDyn *v) {
  bool fresh;
  bool held = ni_exports_take();
  uint32_t id = ni_export_id_locked(v, &fresh);
  ni_exports_give(held);
  if (fresh) ni_twin_attach(id, v);
  return id;
}

/* The value of export `id` (borrowed), or NULL. */
ScrDyn *scr_ni_export_value(uint32_t id) {
  bool held = ni_exports_take();
  ScrDyn *v = id != 0 && id < ni_exports_len ? ni_exports[id].value : NULL;
  ni_exports_give(held);
  return v;
}

/* ── Built-in constructors (SCR_NVF_INTRINSIC) ───────────────────────────
 * A built-in constructor is the same function in every realm of a Node
 * program, so one that crosses is the other side's own intrinsic: native
 * `String` in an island is the island's `String` (island code compares it
 * with its own, `type === Boolean`), and the island's `String` in native
 * code is the program's. The table holds the native value of each name: the
 * program registers its functions for the primitive constructors at start
 * (scr_ni_intrinsic_register, emitted by the compiler), and a constructor
 * the runtime interns joins the first time it crosses. */
typedef struct {
  char name[24];
  ScrDyn *value;
} NiIntrinsic;
static NiIntrinsic ni_intrinsics[48];
static size_t ni_nintrinsics = 0;

static void ni_intrinsics_cleanup(void) {
  for (size_t i = 0; i < ni_nintrinsics; i++) scr_dyn_release(ni_intrinsics[i].value);
  ni_nintrinsics = 0;
}

static NiIntrinsic *ni_intrinsic_named(const char *name, size_t len) {
  for (size_t i = 0; i < ni_nintrinsics; i++)
    if (strlen(ni_intrinsics[i].name) == len && memcmp(ni_intrinsics[i].name, name, len) == 0)
      return &ni_intrinsics[i];
  return NULL;
}

static NiIntrinsic *ni_intrinsic_add(const char *name, size_t len, ScrDyn *value) {
  if (len == 0 || len >= sizeof ni_intrinsics[0].name ||
      ni_nintrinsics == sizeof ni_intrinsics / sizeof ni_intrinsics[0])
    return NULL;
  if (ni_nintrinsics == 0) scr_atexit(ni_intrinsics_cleanup);
  NiIntrinsic *entry = &ni_intrinsics[ni_nintrinsics++];
  memcpy(entry->name, name, len);
  entry->name[len] = '\0';
  entry->value = scr_dyn_retain(value);
  return entry;
}

/* The program's function for the constructor `name`. */
void scr_ni_intrinsic_register(ScrStr *name, ScrDyn *value) {
  if (value->kind != SCR_DYN_FUNC || ni_intrinsic_named(name->data, name->len) != NULL) return;
  ni_intrinsic_add(name->data, name->len, value);
}

/* The table entry of the built-in constructor `v` is, or NULL: one of the
 * program's by the function behind it (an adapter of String is String), one
 * of the runtime's by its interned signature. */
static NiIntrinsic *ni_intrinsic_of(ScrDyn *v) {
  if (v->kind != SCR_DYN_FUNC || v->v.fn.class_obj != NULL || v->v.fn.clo == NULL) return NULL;
  ScrClosure *root = scr_closure_identity(v->v.fn.clo);
  for (size_t i = 0; i < ni_nintrinsics; i++) {
    ScrClosure *held = ni_intrinsics[i].value->v.fn.clo;
    if (held != NULL && scr_closure_identity(held) == root) return &ni_intrinsics[i];
  }
  const char *sig = v->v.fn.sig;
  if (sig == NULL || v->v.fn.name == NULL) return NULL;
  if (strcmp(sig, "native:constructor") != 0 && strcmp(sig, "native:Array") != 0 &&
      strcmp(sig, "native:ArrayBuffer") != 0 &&
      (strcmp(sig, "native:function-constructor") != 0 || strcmp(v->v.fn.name, "Function") != 0))
    return NULL;
  size_t len = strlen(v->v.fn.name);
  if (ni_intrinsic_named(v->v.fn.name, len) != NULL) return NULL;
  return ni_intrinsic_add(v->v.fn.name, len, v);
}

/* The native value (+1) of the island intrinsic constructor behind `handle`
 * (the bridge flagged it SCR_NVF_INTRINSIC), or NULL when the program holds
 * none of that name: the handle then stays an island function. */
ScrDyn *scr_ni_intrinsic_native(ScrDyn *handle) {
  if (ni_nintrinsics == 0) return NULL;
  ScrStr *key = scr_str_new("name", 4);
  ScrDyn *name = scr_node_island_get(handle, key);
  scr_str_release(key);
  if (name == NULL || scr_exc_pending()) {
    if (scr_exc_pending()) scr_exc_clear();
    if (name != NULL) scr_dyn_release(name);
    return NULL;
  }
  NiIntrinsic *entry =
      name->kind == SCR_DYN_STR ? ni_intrinsic_named(name->v.str->data, name->v.str->len) : NULL;
  scr_dyn_release(name);
  return entry != NULL ? scr_dyn_retain(entry->value) : NULL;
}

/* Fills `out` with the export of `v` (borrowed). */
void scr_ni_export_out(ScrDyn *v, ScrNodeValue *out) {
  /* A built-in constructor crosses as its one registered value, whatever
   * adapter of it arrived. */
  NiIntrinsic *intrinsic = ni_intrinsic_of(v);
  if (intrinsic != NULL) v = intrinsic->value;
  bool fresh;
  bool held = ni_exports_take();
  uint32_t id = ni_export_id_locked(v, &fresh);
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_EXPORT;
  out->flags = ni_exports[id].flags;
  out->u.exp.id = id;
  if (v->kind == SCR_DYN_FUNC) {
    out->u.exp.length = v->v.fn.arity;
    if (v->v.fn.name != NULL) {
      out->u.exp.name = v->v.fn.name;
      out->u.exp.name_len = strlen(v->v.fn.name);
    }
  } else if (ni_exports[id].twin != NULL) {
    out->u.exp.name = ni_exports[id].twin->name;
    out->u.exp.name_len = strlen(ni_exports[id].twin->name);
    out->u.exp.length = ni_exports[id].adopts;
  }
  if (intrinsic != NULL) {
    out->flags |= SCR_NVF_INTRINSIC;
    out->u.exp.name = intrinsic->name;
    out->u.exp.name_len = strlen(intrinsic->name);
  }
  ni_exports_give(held);
  if (fresh) ni_twin_attach(id, v);
}

/* NI-8: the exports whose twins stand for native object `object`: one per
 * twin class that shares it. Answers how many. */
size_t scr_ni_twin_exports(const void *object, uint32_t ids[2]) {
  size_t n = 0;
  uint32_t first = ni_ids_get(object), second = ni_ids_get(ni_twin_second(object));
  if (first != 0) ids[n++] = first;
  if (second != 0) ids[n++] = second;
  return n;
}

/* NI-8: the identity of export `id` (the referent its representative
 * stands for), or NULL for a free id. */
const void *scr_ni_export_identity(uint32_t id) {
  bool held = ni_exports_take();
  const void *identity = id != 0 && id < ni_exports_len ? ni_exports[id].identity : NULL;
  ni_exports_give(held);
  return identity;
}

uint32_t scr_ni_live_exports(void) {
  uint32_t n = 0;
  bool held = ni_exports_take();
  for (uint32_t i = 1; i < ni_exports_len; i++) n += ni_exports[i].value != NULL;
  ni_exports_give(held);
  return n;
}

/* ── host callbacks ───────────────────────────────────────────────────── */

/* Values the runtime hands the bridge stay alive until the next host call
 * (their string data points into them). */
static ScrDyn *ni_keep = NULL;

static void ni_keep_set(ScrDyn *v) {
  ScrDyn *old = ni_keep;
  ni_keep = v;
  scr_dyn_release(old);
}

/* The pending runtime exception as an out value: 1. */
static int ni_threw(ScrNodeValue *out) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *thrown = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  if (thrown == NULL) thrown = scr_dyn_retain(scr_dyn_undefined());
  if (!scr_ni_value_out(thrown, out)) {
    /* The thrown value itself cannot cross: throw what that raised. */
    scr_dyn_release(thrown);
    caught = scr_exc_take();
    thrown = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    if (thrown == NULL || !scr_ni_value_out(thrown, out)) {
      scr_exc_clear();
      memset(out, 0, sizeof *out);
      out->tag = SCR_NV_UNDEFINED;
    }
  }
  ni_keep_set(thrown);
  return 1;
}

/* A runtime result as an out value: 0, or 1 when it cannot cross. */
static int ni_returned(ScrDyn *result, ScrNodeValue *out) {
  if (!scr_ni_value_out(result, out)) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  ni_keep_set(result);
  return 0;
}

/* The values the bridge wrote for one host call are read one by one, and
 * two of them may name one import (the same island signal in two
 * arguments). An adoption while they are read lets go of the island
 * object's handle, which would drop the import under the values not read
 * yet: those handles live until the call's values are all read. */
static ScrDyn **ni_adopted = NULL;
static size_t ni_nadopted = 0, ni_adopted_cap = 0;
static uint32_t ni_reading = 0;

static size_t ni_read_begin(void) {
  ni_reading++;
  return ni_nadopted;
}

static void ni_read_end(size_t mark) {
  ni_reading--;
  while (ni_nadopted > mark) scr_dyn_release(ni_adopted[--ni_nadopted]);
}

static void ni_adopted_keep(ScrDyn *island) {
  if (ni_reading == 0) return;
  if (ni_nadopted == ni_adopted_cap) {
    ni_adopted_cap = ni_adopted_cap ? ni_adopted_cap * 2 : 8;
    ScrDyn **grown = realloc(ni_adopted, ni_adopted_cap * sizeof *grown);
    if (grown == NULL) ni_export_oom();
    ni_adopted = grown;
  }
  ni_adopted[ni_nadopted++] = scr_dyn_retain(island);
}

/* A twin argument naming the island object an earlier argument in the
 * same list named (+1), or NULL. The bridge converts a whole argument list
 * before the runtime sees any of it, so an island object named twice
 * arrives as two handles with one id and no export on either: each would
 * ask for its own adoption. The second is the value the first one became. */
static ScrDyn *ni_repeated_arg(const ScrNodeValue *args, ScrDyn *const *done, size_t i) {
  if (args[i].tag != SCR_NV_HANDLE || (args[i].flags & SCR_NVF_TWIN) == 0) return NULL;
  for (size_t j = 0; j < i; j++)
    if (args[j].tag == SCR_NV_HANDLE && args[j].u.handle == args[i].u.handle && done[j] != NULL)
      return scr_dyn_retain(done[j]);
  return NULL;
}

/* SCR_NODE_EXPORT_OWN: the own string-keyed properties of native error
 * `target`, in order, each followed by its attribute bits (1 writable, 2
 * enumerable, 4 configurable), then the state word (1: not extensible), as
 * a JSON copy. The bridge installs each as a property whose value lives
 * here, so an accessor of the view (a message computed on demand) is listed
 * like a data property. Not listed: `stack`, every error's accessor, which
 * V8 has too; and the accessors of a class instance's view, which are its
 * class's (Node keeps them on the prototype, and the export answers them
 * from behind the error). message, name and cause are listed from the
 * error's own slots. */
static int ni_export_own(ScrDyn *target, ScrNodeValue *out) {
  ScrDyn *names = scr_dyn_get_own_property_names(target);
  if (names == NULL || scr_exc_pending()) {
    scr_dyn_release(names);
    return ni_threw(out);
  }
  ScrError *e = scr_errdyn_err_of(target);
  bool listed[NI_SLOT_CAUSE + 1] = {false};
  ScrDyn *list = scr_dyn_new_arr();
  for (size_t i = 0; i < names->v.arr.len; i++) {
    ScrDyn *key = names->v.arr.items[i];
    if (key->kind != SCR_DYN_STR) continue;
    if (key->v.str->len == 5 && memcmp(key->v.str->data, "stack", 5) == 0) continue;
    int slot = ni_error_slot(key->v.str);
    int slot_bits;
    if (e != NULL && slot != NI_SLOT_NONE && !ni_view_accessor(target, key->v.str) &&
        ni_error_slot_own(e, slot, &slot_bits)) {
      if (!ni_slot_defined_bits(target, key, &slot_bits)) {
        scr_dyn_release(list);
        scr_dyn_release(names);
        scr_error_release(e);
        return ni_threw(out);
      }
      listed[slot] = true;
      scr_dyn_arr_push(list, scr_dyn_retain(key));
      scr_dyn_arr_push(list, scr_dyn_new_num(slot_bits));
      continue;
    }
    ScrDyn *descriptor = scr_dyn_get_own_property_descriptor(target, key);
    if (descriptor == NULL || scr_exc_pending()) {
      scr_dyn_release(descriptor);
      scr_dyn_release(list);
      scr_dyn_release(names);
      if (e != NULL) scr_error_release(e);
      return ni_threw(out);
    }
    if (descriptor->kind == SCR_DYN_OBJ) {
      bool data = scr_dyn_obj_get(descriptor, "value", 5) != NULL;
      const ScrDyn *setter = scr_dyn_obj_get(descriptor, "set", 3);
      if (data || target->kind == SCR_DYN_OBJ) {
        static const struct {
          const char *name;
          size_t len;
          int bit;
        } attributes[] = {{"writable", 8, 1}, {"enumerable", 10, 2}, {"configurable", 12, 4}};
        int bits = !data && setter != NULL && setter->kind == SCR_DYN_FUNC ? 1 : 0;
        for (size_t a = 0; a < 3; a++) {
          const ScrDyn *flag = scr_dyn_obj_get(descriptor, attributes[a].name, attributes[a].len);
          if (flag != NULL && flag->kind == SCR_DYN_BOOL && flag->v.b) bits |= attributes[a].bit;
        }
        if (slot != NI_SLOT_NONE) listed[slot] = true;
        scr_dyn_arr_push(list, scr_dyn_retain(key));
        scr_dyn_arr_push(list, scr_dyn_new_num(bits));
      }
    }
    scr_dyn_release(descriptor);
  }
  /* A slot typed code filled after the view was built. */
  static const struct {
    int slot;
    const char *name;
    size_t len;
  } slots[] = {{NI_SLOT_MESSAGE, "message", 7}, {NI_SLOT_NAME, "name", 4}, {NI_SLOT_CAUSE, "cause", 5}};
  for (size_t i = 0; e != NULL && i < 3; i++) {
    int bits;
    if (listed[slots[i].slot] || !ni_error_slot_own(e, slots[i].slot, &bits)) continue;
    ScrStr *name = scr_str_new(slots[i].name, slots[i].len);
    scr_dyn_arr_push(list, scr_dyn_new_str(name));
    scr_str_release(name);
    scr_dyn_arr_push(list, scr_dyn_new_num(bits));
  }
  if (e != NULL) scr_error_release(e);
  scr_dyn_release(names);
  bool extensible = scr_dyn_is_extensible(target);
  if (scr_exc_pending()) {
    scr_exc_clear();
    extensible = true;
  }
  scr_dyn_arr_push(list, scr_dyn_new_num(extensible ? 0 : 1));
  ScrStr *gap = scr_str_new("", 0);
  ScrDyn *json = scr_json_stringify_replacer(list, scr_dyn_undefined(), gap);
  scr_str_release(gap);
  scr_dyn_release(list);
  if (json == NULL || json->kind != SCR_DYN_STR || scr_exc_pending()) {
    scr_dyn_release(json);
    return ni_threw(out);
  }
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_JSON;
  out->u.str.data = json->v.str->data;
  out->u.str.len = json->v.str->len;
  ni_keep_set(json);
  return 0;
}

/* Arguments as runtime values (+1 each). */
static ScrDyn **ni_args_in(const ScrNodeValue *args, size_t argc, ScrDyn **small, size_t nsmall) {
  ScrDyn **out = argc <= nsmall ? small : malloc(argc * sizeof *out);
  if (out == NULL) ni_export_oom();
  for (size_t i = 0; i < argc; i++) {
    ScrDyn *repeated = ni_repeated_arg(args, out, i);
    out[i] = repeated != NULL ? repeated : scr_ni_arg_in(&args[i]);
  }
  return out;
}

static void ni_args_free(ScrDyn **args, size_t argc, ScrDyn **small) {
  for (size_t i = 0; i < argc; i++) scr_dyn_release(args[i]);
  if (args != small) free(args);
}

int scr_ni_host_export_call(uint32_t id, const ScrNodeValue *this_, const ScrNodeValue *args,
                            size_t argc, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *fn = scr_ni_export_value(id);
  if (fn == NULL) {
    scr_throw_error_msg(SCR_ERR_TYPE, "native function is gone", 23);
    return ni_threw(out);
  }
  scr_dyn_retain(fn);
  ScrDyn *small[8];
  size_t reading = ni_read_begin();
  ScrDyn **in = ni_args_in(args, argc, small, 8);
  ScrDyn *self = this_ != NULL ? scr_ni_value_in(this_) : scr_dyn_retain(scr_dyn_undefined());
  ni_read_end(reading);
  scr_ni_called_in();
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, in, argc, "callback");
  scr_dyn_this_pop();
  scr_dyn_release(self);
  ni_args_free(in, argc, small);
  scr_dyn_release(fn);
  scr_ni_shared_refresh();
  if (result == NULL || scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  return ni_returned(result, out);
}

static ScrDyn *ni_class_ctor(const ScrDyn *cls);

int scr_ni_host_export_construct(uint32_t id, const ScrNodeValue *args, size_t argc,
                                 ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *ctor = scr_ni_export_value(id);
  if (ctor == NULL) {
    scr_throw_error_msg(SCR_ERR_TYPE, "native function is gone", 23);
    return ni_threw(out);
  }
  scr_dyn_retain(ctor);
  ScrDyn *result;
  ScrDyn *helper = ni_class_ctor(ctor);
  if (helper != NULL) {
    /* A native class of a shared module (NI-6): its helper's thunk checks
     * the arguments against the constructor's parameters. */
    ScrDyn *small[8];
    size_t reading = ni_read_begin();
    ScrDyn **in = ni_args_in(args, argc, small, 8);
    ni_read_end(reading);
    result = scr_dyn_call(helper, in, argc, "constructor");
    ni_args_free(in, argc, small);
  } else {
    ScrDyn *list = scr_dyn_new_arr();
    size_t reading = ni_read_begin();
    for (size_t i = 0; i < argc; i++) {
      ScrDyn *repeated = ni_repeated_arg(args, list->v.arr.items, i);
      scr_dyn_arr_push(list, repeated != NULL ? repeated : scr_ni_value_in(&args[i]));
    }
    ni_read_end(reading);
    ScrStr *what = scr_str_new("constructor", 11);
    result = scr_dyn_construct(ctor, list, what);
    scr_str_release(what);
    scr_dyn_release(list);
  }
  scr_dyn_release(ctor);
  scr_ni_shared_refresh();
  if (result == NULL || scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  return ni_returned(result, out);
}

/* ── class method tables ──────────────────────────────────────────────
 * A class instance's capsule holds its fields; its prototype methods come
 * from a table the compiler's builder makes once per class (name -> the
 * unbound method value, a dyn function whose thunk checks the receiver),
 * keyed by the capsule's type key. */
typedef struct {
  const char *key;
  size_t key_len;
  ScrDyn *table; /* +1 dyn object */
  ScrDyn *ctor;  /* +1 dyn function constructing an instance (NI-6), or NULL */
} NiMethods;
static NiMethods *ni_methods = NULL;
static size_t ni_nmethods = 0, ni_methods_cap = 0;

static ScrDyn *ni_methods_of(const ScrDyn *v) {
  if (v->kind != SCR_DYN_TYPED_REF || v->v.typed_ref.type_key == NULL) return NULL;
  const char *key = v->v.typed_ref.type_key;
  size_t len = v->v.typed_ref.type_key_len;
  for (size_t i = 0; i < ni_nmethods; i++)
    if (ni_methods[i].key_len == len && memcmp(ni_methods[i].key, key, len) == 0)
      return ni_methods[i].table;
  return NULL;
}

/* The tables below belong to the island's thread: its host callbacks read
 * them (ni_class_method, ni_class_ctor) and call what they hold, and a
 * table is made of method values of the thread that built it. A worker
 * thread runs the same crossing sites, and its instance is refused crossing
 * by name right after (ERR_SCRIPTC_ISLAND_WORKER_VALUE, nh_to_node), so it
 * registers nothing: a table built there would be a worker's objects in a
 * list the island's thread reads without a lock and keeps after that
 * worker has ended. */
ScrDyn *scr_node_island_class_methods(ScrDyn *value, ScrDyn *builder) {
  if (!scr_ni_main_thread()) return scr_dyn_retain(value);
  if (value->kind == SCR_DYN_TYPED_REF && value->v.typed_ref.type_key != NULL &&
      ni_methods_of(value) == NULL) {
    ScrDyn *table = scr_dyn_call(builder, NULL, 0, "class methods");
    if (table == NULL) return NULL;
    if (ni_nmethods == ni_methods_cap) {
      ni_methods_cap = ni_methods_cap ? ni_methods_cap * 2 : 8;
      NiMethods *grown = realloc(ni_methods, ni_methods_cap * sizeof *grown);
      if (grown == NULL) ni_export_oom();
      ni_methods = grown;
    }
    ni_methods[ni_nmethods].key = value->v.typed_ref.type_key; /* static */
    ni_methods[ni_nmethods].key_len = value->v.typed_ref.type_key_len;
    ni_methods[ni_nmethods].table = table;
    ni_methods[ni_nmethods].ctor = NULL;
    ni_nmethods++;
  }
  return scr_dyn_retain(value);
}

/* NI-6: the method table of a class registered through its class value
 * (a shared module's exported class), keyed by the same type key its
 * instances carry. Answers the class value. */
/* The type key a class value's instances carry: "classval:C" -> "object:C".
 * Answers whether `key`/`len` is it. */
static bool ni_instance_key_is(const char *sig, const char *key, size_t len) {
  if (sig == NULL || key == NULL || strncmp(sig, "classval:", 9) != 0) return false;
  size_t rest = strlen(sig + 9);
  return len == 7 + rest && memcmp(key, "object:", 7) == 0 && memcmp(key + 7, sig + 9, rest) == 0;
}

static NiMethods *ni_methods_of_class(const ScrDyn *cls) {
  if (cls->kind != SCR_DYN_FUNC || cls->v.fn.class_obj == NULL) return NULL;
  for (size_t i = 0; i < ni_nmethods; i++)
    if (ni_instance_key_is(cls->v.fn.sig, ni_methods[i].key, ni_methods[i].key_len))
      return &ni_methods[i];
  return NULL;
}

ScrDyn *scr_node_island_class_methods_of(ScrDyn *cls, ScrDyn *builder, ScrDyn *ctor) {
  /* The island's thread only, as above (a shared module's accessor runs
   * there; nothing else calls this). */
  if (!scr_ni_main_thread()) return scr_dyn_retain(cls);
  if (cls->kind != SCR_DYN_FUNC || cls->v.fn.class_obj == NULL || cls->v.fn.sig == NULL ||
      strncmp(cls->v.fn.sig, "classval:", 9) != 0)
    return scr_dyn_retain(cls);
  NiMethods *known = ni_methods_of_class(cls);
  if (known != NULL) {
    if (known->ctor == NULL && ctor->kind == SCR_DYN_FUNC) known->ctor = scr_dyn_retain(ctor);
    return scr_dyn_retain(cls);
  }
  ScrDyn *table = builder->kind == SCR_DYN_FUNC ? scr_dyn_call(builder, NULL, 0, "class methods")
                                                : scr_dyn_new_obj();
  if (table == NULL) return NULL;
  if (ni_nmethods == ni_methods_cap) {
    ni_methods_cap = ni_methods_cap ? ni_methods_cap * 2 : 8;
    NiMethods *grown = realloc(ni_methods, ni_methods_cap * sizeof *grown);
    if (grown == NULL) ni_export_oom();
    ni_methods = grown;
  }
  size_t rest = strlen(cls->v.fn.sig + 9);
  char *key = malloc(7 + rest + 1); /* lives as long as the program */
  if (key == NULL) ni_export_oom();
  memcpy(key, "object:", 7);
  memcpy(key + 7, cls->v.fn.sig + 9, rest + 1);
  ni_methods[ni_nmethods].key = key;
  ni_methods[ni_nmethods].key_len = 7 + rest;
  ni_methods[ni_nmethods].table = table;
  ni_methods[ni_nmethods].ctor = ctor->kind == SCR_DYN_FUNC ? scr_dyn_retain(ctor) : NULL;
  ni_nmethods++;
  return scr_dyn_retain(cls);
}

/* The constructor helper of a native class value (borrowed), or NULL. */
static ScrDyn *ni_class_ctor(const ScrDyn *cls) {
  NiMethods *m = ni_methods_of_class(cls);
  return m != NULL ? m->ctor : NULL;
}

/* A prototype method of a class capsule (+1), or NULL. An own property the
 * island wrote under the method's name (kept in the capsule's materialized
 * view) hides the method, as an own property hides a prototype's in Node. */
static ScrDyn *ni_class_method(const ScrDyn *target, const ScrDyn *key) {
  if (key->kind != SCR_DYN_STR) return NULL;
  ScrDyn *table = ni_methods_of(target);
  if (table == NULL) return NULL;
  const ScrDyn *view = target->v.typed_ref.materialized;
  if (view != NULL && view->kind == SCR_DYN_OBJ &&
      scr_dyn_obj_get(view, key->v.str->data, key->v.str->len) != NULL)
    return NULL;
  ScrDyn *m = scr_dyn_obj_get(table, key->v.str->data, key->v.str->len);
  return m != NULL ? scr_dyn_retain(m) : NULL;
}

/* Whether `key` is a name `target` only inherits from Object.prototype.
 * scr_dyn_in answers true for those (the `in` operator consults the
 * prototype chain), and the representative has V8's own Object.prototype,
 * so they are left to it: an intercepted read answered undefined where
 * Node answers the inherited function, and `String(record)`,
 * `record.hasOwnProperty(k)` and `record.constructor` failed in the island. */
static bool ni_inherited_name(const ScrDyn *target, const ScrDyn *key) {
  static const char *const names[] = {
      "constructor",      "__defineGetter__", "__defineSetter__",     "hasOwnProperty",
      "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",        "propertyIsEnumerable",
      "toString",         "valueOf",          "__proto__",            "toLocaleString",
  };
  if (key->kind != SCR_DYN_STR) return false;
  const ScrStr *s = key->v.str;
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
    if (s->len == strlen(names[i]) && memcmp(s->data, names[i], s->len) == 0)
      return !scr_dyn_has_own(target, s);
  return false;
}

/* ── symbol keys ──────────────────────────────────────────────────────
 * The bridge sends a symbol key the program can name as well (a registered
 * or well-known symbol, whether or not it has crossed) or one the runtime
 * holds (the native symbol paired with it is pinned). No program code can
 * name any other symbol, so a property under one of those is island code's
 * own and stays on the representative. For a symbol the program can name,
 * the program's object answers what it has under it; anything else is left
 * to the representative, where island code that tags the objects it is
 * given finds its own writes again. */

/* The value of the symbol-keyed property `key` of an exported value (+1),
 * NULL when the program's object has none (*threw: an exception is
 * pending). */
static ScrDyn *ni_symbol_get(ScrDyn *target, ScrDyn *key, bool *threw) {
  *threw = false;
  /* A checked-dynamic object, or the view of a record or class instance
   * (generators, arrays and collections have other representatives). */
  if (target->kind != SCR_DYN_OBJ &&
      !(target->kind == SCR_DYN_TYPED_REF && (target->v.typed_ref.record || target->v.typed_ref.klass)))
    return NULL;
  ScrDyn *value = scr_dyn_symbol_key_get(target, key, true);
  if (value == NULL || scr_exc_pending()) {
    scr_dyn_release(value);
    *threw = true;
    return NULL;
  }
  if (value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    return NULL;
  }
  return value;
}

/* Whether a checked-dynamic object has the own property `key`. */
static bool ni_symbol_own(const ScrDyn *target, const ScrDyn *key) {
  return target->kind == SCR_DYN_OBJ && scr_dyn_own_symbol_entry(target, key) != NULL;
}

int scr_ni_host_export_get(uint32_t id, const ScrNodeValue *key, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL) return 2;
  ScrDyn *k = scr_ni_value_in(key);
  ScrDyn *pk = scr_dyn_property_key_value(k);
  if (pk == NULL) {
    scr_dyn_release(k);
    return ni_threw(out);
  }
  if (pk->kind == SCR_DYN_SYMBOL) {
    bool threw = false;
    ScrDyn *value = ni_symbol_get(target, pk, &threw);
    scr_dyn_release(pk);
    scr_dyn_release(k);
    if (threw) return ni_threw(out);
    return value != NULL ? ni_returned(value, out) : 2;
  }
  if (ni_is_array(target) && pk->kind == SCR_DYN_STR) {
    /* length and elements straight from the native array: a live array
     * capsule answers them without rebuilding its snapshot. */
    ScrDyn *fast = NULL;
    if (target->kind == SCR_DYN_TYPED_REF) {
      fast = scr_dyn_typed_ref_own_get(target, pk->v.str);
    } else if (pk->v.str->len == 6 && memcmp(pk->v.str->data, "length", 6) == 0) {
      fast = scr_dyn_new_num((double)target->v.arr.len);
    }
    if (fast != NULL) {
      scr_dyn_release(pk);
      scr_dyn_release(k);
      return ni_returned(fast, out);
    }
    /* Anything but an index is Array.prototype's (the Proxy target's). */
    if (!ni_index_key(pk->v.str) &&
        !(pk->v.str->len == 6 && memcmp(pk->v.str->data, "length", 6) == 0)) {
      scr_dyn_release(pk);
      scr_dyn_release(k);
      return 2;
    }
    ScrDyn *element = scr_dyn_reflect_get(target, pk, target);
    scr_dyn_release(pk);
    scr_dyn_release(k);
    if (element == NULL || scr_exc_pending()) {
      scr_dyn_release(element);
      return ni_threw(out);
    }
    return ni_returned(element, out);
  }
  if (ni_export_is_error(id)) {
    ScrDyn *member = ni_error_member(target, pk);
    scr_dyn_release(pk);
    scr_dyn_release(k);
    if (scr_exc_pending()) {
      scr_dyn_release(member);
      return ni_threw(out);
    }
    return member != NULL ? ni_returned(member, out) : 2;
  }
  int present = 0;
  if (pk->kind == SCR_DYN_STR) present = scr_dyn_in(target, pk->v.str);
  if (!present && !scr_exc_pending()) {
    /* A prototype method of a class instance (its table). */
    ScrDyn *method = ni_class_method(target, pk);
    scr_dyn_release(pk);
    scr_dyn_release(k);
    if (method != NULL) return ni_returned(method, out);
    return 2;
  }
  ScrDyn *result = scr_exc_pending() ? NULL : scr_dyn_reflect_get(target, pk, target);
  if (result != NULL && result->kind == SCR_DYN_UNDEF) {
    ScrDyn *method = ni_class_method(target, pk);
    if (method != NULL) {
      scr_dyn_release(result);
      result = method;
    } else if (ni_inherited_name(target, pk)) {
      scr_dyn_release(result);
      scr_dyn_release(pk);
      scr_dyn_release(k);
      return 2;
    }
  }
  scr_dyn_release(pk);
  scr_dyn_release(k);
  if (result == NULL || scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  return ni_returned(result, out);
}

int scr_ni_host_export_set(uint32_t id, const ScrNodeValue *key, const ScrNodeValue *value,
                           ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL) return 2;
  ScrDyn *k = scr_ni_value_in(key);
  if (k->kind == SCR_DYN_SYMBOL && target->kind != SCR_DYN_OBJ) {
    /* Only a checked-dynamic object stores a property under a symbol. */
    scr_dyn_release(k);
    return 2;
  }
  ScrDyn *v = scr_ni_value_in(value);
  bool ok = true;
  if (k->kind == SCR_DYN_SYMBOL) {
    scr_dyn_symbol_key_set(target, k, v);
  } else if (ni_export_is_error(id) && k->kind == SCR_DYN_STR) {
    /* A native error: the dynamic write, which also stores name, message,
     * stack, cause and code in the slots typed code reads. */
    scr_dyn_key_set(target, k->v.str, v);
  } else {
    ok = scr_dyn_reflect_set(target, k, v, target);
  }
  scr_dyn_release(v);
  scr_dyn_release(k);
  scr_ni_shared_refresh();
  if (scr_exc_pending()) return ni_threw(out);
  (void)ok; /* a refused write is silent outside strict mode; Node's setter
             * interceptor reports the same */
  memset(out, 0, sizeof *out);
  return 0;
}

int scr_ni_host_export_has(uint32_t id, const ScrNodeValue *key) {
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL) return 0;
  ScrDyn *k = scr_ni_value_in(key);
  if (k->kind == SCR_DYN_SYMBOL) {
    int own = ni_symbol_own(target, k) ? 1 : 0;
    scr_dyn_release(k);
    return own;
  }
  ScrDyn *pk = scr_dyn_property_key_value(k);
  int present = 0;
  if (pk != NULL && pk->kind == SCR_DYN_STR && ni_is_array(target)) {
    if (ni_index_key(pk->v.str)) {
      ScrStr *lk = scr_str_new("length", 6);
      ScrDyn *lkey = scr_dyn_new_str(lk);
      scr_str_release(lk);
      ScrDyn *len = scr_dyn_reflect_get(target, lkey, target);
      scr_dyn_release(lkey);
      double index = strtod(pk->v.str->data, NULL);
      present = len != NULL && len->kind == SCR_DYN_NUM && index < len->v.num;
      scr_dyn_release(len);
    }
  } else if (pk != NULL && pk->kind == SCR_DYN_STR && ni_export_is_error(id)) {
    ScrDyn *member = ni_error_member(target, pk);
    present = member != NULL;
    scr_dyn_release(member);
  } else if (pk != NULL && pk->kind == SCR_DYN_STR) {
    present = scr_dyn_in(target, pk->v.str);
  }
  if (scr_exc_pending()) scr_exc_clear();
  if (!present && pk != NULL) {
    ScrDyn *method = ni_class_method(target, pk);
    present = method != NULL;
    scr_dyn_release(method);
  } else if (present && !ni_is_array(target) && ni_inherited_name(target, pk)) {
    /* Not an own property: V8 answers `in` from the prototype chain. A
     * class's own method of that name stays the capsule's. */
    ScrDyn *method = ni_class_method(target, pk);
    present = method != NULL;
    scr_dyn_release(method);
  }
  scr_dyn_release(pk);
  scr_dyn_release(k);
  return present;
}

int scr_ni_host_export_delete(uint32_t id, const ScrNodeValue *key, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL) return 2;
  ScrDyn *k = scr_ni_value_in(key);
  if (k->kind == SCR_DYN_SYMBOL) {
    if (!ni_symbol_own(target, k)) {
      scr_dyn_release(k);
      return 2;
    }
    scr_dyn_obj_delete_symbol_field(target, k);
  } else {
    scr_dyn_key_delete_computed(target, k, false);
  }
  scr_dyn_release(k);
  if (scr_exc_pending()) return ni_threw(out);
  memset(out, 0, sizeof *out);
  return 0;
}

/* The own symbol keys of a checked-dynamic object, one per call, in the
 * order they were added. */
int scr_ni_host_export_symbol(uint32_t id, uint32_t index, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL || target->kind != SCR_DYN_OBJ || target->symbol_keys == NULL ||
      target->symbol_keys->kind != SCR_DYN_ARR || index >= target->symbol_keys->v.arr.len)
    return 2;
  return ni_returned(scr_dyn_retain(target->symbol_keys->v.arr.items[index]), out) == 0 ? 0 : 2;
}

/* Own enumerable string keys, in JS order, as an array value. */
int scr_ni_host_export_keys(uint32_t id, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  ScrDyn *keys = target != NULL ? scr_dyn_obj_keys(target) : scr_dyn_new_arr();
  if (keys == NULL || scr_exc_pending()) {
    scr_dyn_release(keys);
    return ni_threw(out);
  }
  /* Keys cross as a JSON copy: an array of strings. */
  ScrStr *gap = scr_str_new("", 0);
  ScrDyn *json = scr_json_stringify_replacer(keys, scr_dyn_undefined(), gap);
  scr_str_release(gap);
  scr_dyn_release(keys);
  if (json == NULL || json->kind != SCR_DYN_STR) {
    scr_dyn_release(json);
    if (scr_exc_pending()) return ni_threw(out);
    ScrStr *empty = scr_str_new("[]", 2);
    json = scr_dyn_new_str(empty);
    scr_str_release(empty);
  }
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_JSON;
  out->u.str.data = json->v.str->data;
  out->u.str.len = json->v.str->len;
  ni_keep_set(json);
  return 0;
}

/* A twin asks its native object (SCR_NODE_TWIN_*): the handle's own
 * property read or method call, named by the first argument. */
static int ni_twin_op(const ScrNiTwinClass *twin, ScrDyn *target, uint32_t op,
                      const ScrNodeValue *args, size_t argc, ScrNodeValue *out) {
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(target);
  ScrDyn *small[4];
  size_t reading = ni_read_begin();
  ScrDyn **in = ni_args_in(args, argc, small, 4);
  ni_read_end(reading);
  ScrDyn *result = NULL;
  scr_dyn_retain(target);
  if (ops != NULL && argc > 0 && in[0]->kind == SCR_DYN_STR) {
    const ScrStr *name = in[0]->v.str;
    void *object = target->v.handle.ptr;
    if (op == SCR_NODE_TWIN_GET && ops->get != NULL) {
      result = ops->get(object, name->data, name->len);
    } else if (op == SCR_NODE_TWIN_INVOKE && ops->invoke != NULL) {
      char method[64];
      size_t len = name->len < sizeof method ? name->len : sizeof method - 1;
      memcpy(method, name->data, len);
      method[len] = '\0';
      result = ops->invoke(object, target, method, in + 1, argc - 1, method);
      scr_ni_shared_refresh();
    } else if (op == SCR_NODE_TWIN_TELL && twin->hear != NULL) {
      char event[64];
      size_t len = name->len < sizeof event ? name->len : sizeof event - 1;
      memcpy(event, name->data, len);
      event[len] = '\0';
      twin->hear(object, event, argc > 1 ? in[1] : scr_dyn_undefined());
      scr_ni_shared_refresh();
    }
  }
  ni_args_free(in, argc, small);
  scr_dyn_release(target);
  if (scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  if (result == NULL) result = scr_dyn_retain(scr_dyn_undefined());
  return ni_returned(result, out);
}

int scr_ni_host_export_op(uint32_t id, uint32_t op, const ScrNodeValue *args, size_t argc,
                          ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  if (op == SCR_NODE_EXPORT_OWN) {
    if (target == NULL || !ni_export_is_error(id)) {
      scr_throw_error_msg(SCR_ERR_TYPE, "native error is gone", 20);
      return ni_threw(out);
    }
    return ni_export_own(target, out);
  }
  if (target != NULL && ni_exports[id].twin != NULL)
    return ni_twin_op(ni_exports[id].twin, target, op, args, argc, out);
  bool set = false;
  ScrDyn *view = target != NULL ? ni_collection(target, &set) : NULL;
  if (view == NULL) {
    scr_throw_error_msg(SCR_ERR_TYPE, "native collection is gone", 25);
    return ni_threw(out);
  }
  ScrDyn *small[4];
  size_t reading = ni_read_begin();
  ScrDyn **in = ni_args_in(args, argc, small, 4);
  ni_read_end(reading);
  /* The collection's own handle operations (scr_json.c), which every
   * program with Maps or Sets links. */
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(view);
  void *ptr = view->v.handle.ptr;
  static const char *const names[] = {"get", "set", "has", "delete", "clear"};
  ScrDyn *result = NULL;
  if (op <= SCR_NODE_COLLECTION_CLEAR) {
    const char *name = op == SCR_NODE_COLLECTION_SET && set ? "add" : names[op];
    result = ops->invoke(ptr, view, name, in, op == SCR_NODE_COLLECTION_CLEAR ? 0 : argc, name);
  } else if (op == SCR_NODE_COLLECTION_SIZE) {
    result = ops->get(ptr, "size", 4);
  } else {
    result = ops->iter_pack != NULL ? ops->iter_pack(ptr) : scr_dyn_new_arr();
  }
  ni_args_free(in, argc, small);
  scr_dyn_release(view);
  if (op == SCR_NODE_COLLECTION_SET && result != NULL) {
    scr_dyn_release(result); /* the JS side answers itself */
    result = scr_dyn_retain(scr_dyn_undefined());
  }
  if (result == NULL || scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  return ni_returned(result, out);
}

/* The native object of export `id` stops telling its twin. */
static void ni_twin_detach(uint32_t id) {
  void *attachment = ni_exports[id].attachment;
  if (attachment == NULL) return;
  ni_exports[id].attachment = NULL;
  ni_exports[id].twin->detach(attachment);
}

void scr_ni_twin_detached(uint32_t id) {
  if (id != 0 && id < ni_exports_len) ni_exports[id].attachment = NULL;
}

void scr_ni_host_export_release(uint32_t id) {
  /* The island's thread, which alone changes the table: the twin stops
   * telling first, outside the lock (its class's code). */
  if (id == 0 || id >= ni_exports_len || ni_exports[id].value == NULL) return;
  ni_twin_detach(id);
  bool held = ni_exports_take();
  if (ni_exports[id].value == NULL) {
    ni_exports_give(held);
    return;
  }
  ScrDyn *v = ni_exports[id].value;
  ni_ids_del(ni_exports[id].identity);
  if (v->kind == SCR_DYN_PROMISE) scr_promise_identity_drop(ni_exports[id].identity);
  ni_exports[id].value = NULL;
  ni_exports[id].identity = NULL;
  if (ni_nfree == ni_free_cap) {
    uint32_t cap = ni_free_cap ? ni_free_cap * 2 : 64;
    uint32_t *grown = realloc(ni_free, cap * sizeof *grown);
    if (grown == NULL) ni_export_oom();
    ni_free = grown;
    ni_free_cap = cap;
  }
  ni_free[ni_nfree++] = id;
  ni_exports_give(held);
  /* Outside the lock: a destructor may mint another export. */
  scr_dyn_release(v);
}

/* `value instanceof C` for the representative of native class C: the
 * value is an instance of C's own type key (NI-6 shortcut: instances of
 * native subclasses of C answer false; NOTES.md). A native error answers
 * by its class's place in the compiled hierarchy, as a catch clause does,
 * so an instance of a subclass of C is an instance of C. */
int scr_ni_host_export_instance_of(uint32_t id, const ScrNodeValue *value) {
  ScrDyn *ctor = scr_ni_export_value(id);
  if (ctor == NULL || ctor->kind != SCR_DYN_FUNC || ctor->v.fn.class_obj == NULL) return 0;
  ScrDyn *v = scr_ni_value_in(value);
  int is = v->kind == SCR_DYN_TYPED_REF &&
           ni_instance_key_is(ctor->v.fn.sig, v->v.typed_ref.type_key, v->v.typed_ref.type_key_len);
  if (!is && v->kind == SCR_DYN_TYPED_REF) {
    ScrError *e = scr_errdyn_err_of(v);
    if (e != NULL) {
      const ScrClassObj *cls = ctor->v.fn.class_obj;
      is = cls->pre <= e->vt->pre && e->vt->pre <= cls->post;
      scr_error_release(e);
    }
  }
  scr_dyn_release(v);
  return is;
}

/* ── promises into Node ───────────────────────────────────────────────── */

typedef struct {
  uint32_t id;
  int rejected;
  const ScrNodeValue *value;
} NiSettle;

static void ni_settle_job(void *p) {
  NiSettle *a = p;
  scr_ni_bridge_loaded()->export_settle(a->id, a->rejected, a->value);
}

void scr_ni_bridge_export_settle(uint32_t id, int rejected, const ScrNodeValue *value) {
  if (scr_ni_bridge_loaded() == NULL) return;
  NiSettle a = {id, rejected, value};
  scr_ni_on_node_stack(ni_settle_job, &a);
}

/* Settles the V8 promise of export `id` from the settled runtime promise. */
static void ni_settle_export(uint32_t id, ScrPromise *p) {
  ScrNodeValue value;
  ScrDyn *payload;
  int rejected = scr_promise_is_rejected(p);
  if (rejected) {
    payload = scr_promise_reason_dyn(p);
  } else if (scr_promise_payload_is_dyn(p)) {
    payload = (ScrDyn *)scr_promise_payload_ref(p);
  } else {
    payload = NULL; /* a void fulfillment */
  }
  if (payload == NULL) payload = scr_dyn_retain(scr_dyn_undefined());
  /* Node raises `unhandledRejection` with this reason if nobody handles the
   * V8 promise: a native listener receives the native error itself. */
  if (rejected) scr_ni_error_link(payload);
  if (!scr_ni_value_out(payload, &value)) {
    /* The payload cannot cross: the promise rejects with that error. */
    scr_dyn_release(payload);
    ScrCaught *caught = scr_exc_take();
    payload = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    rejected = 1;
    if (payload == NULL || !scr_ni_value_out(payload, &value)) {
      scr_exc_clear();
      memset(&value, 0, sizeof value);
    }
  }
  scr_ni_bridge_export_settle(id, rejected, &value);
  scr_dyn_release(payload);
}

static void ni_promise_settled(ScrPromise *dst, ScrPromise *src) {
  (void)dst;
  uint32_t id = ni_ids_get(scr_promise_identity_key(src));
  if (id != 0) ni_settle_export(id, src);
}

/* The bridge created the V8 promise of export `id`: it settles inside the
 * runtime promise's settlement, or now when that already happened. The
 * runtime promise counts as handled from here on; the V8 promise carries
 * Node's own unhandled-rejection tracking. */
void scr_ni_host_export_watch(uint32_t id) {
  ScrDyn *v = scr_ni_export_value(id);
  if (v == NULL || v->kind != SCR_DYN_PROMISE) return;
  ScrPromise *p = v->v.promise;
  bool handled = scr_promise_tracked_by_node(p);
  if (!scr_promise_is_pending(p)) ni_settle_export(id, p);
  else scr_promise_on_settle_sync(p, ni_promise_settled);
  /* Native code already reacts to the promise: its V8 promise is handled
   * too, so island code that only holds it sees no unhandled rejection. */
  if (handled) scr_ni_promise_handled(p);
}

/* ── shared modules (scope-B NI-6) ────────────────────────────────────
 * A module the program compiled and island code also imports exists once:
 * the program registers it (nodeIsland.share) with its accessor, a
 * compiler-generated function answering the current values of its exports
 * as a dyn array (the TDZ sentinel for a binding whose declaration has not
 * run). The bootstrap's loader hooks (scr_node_island_hooks.cjs) resolve
 * island imports of the module to a generated ES module whose bindings
 * read those values; the bindings that can change (exported lets, and
 * bindings still in their temporal dead zone when the generated module
 * linked) are kept current by pushes: at each entry into Node and before
 * each return from a native callback, the runtime compares the bound
 * values with the last pushed ones and pushes the changes. Island code only
 * runs inside those entries, so it never observes a stale binding. */

typedef struct {
  ScrStr *path;     /* +1 */
  ScrStr *exports;  /* +1 JSON [{"name","kind"}] */
  ScrDyn *accessor; /* +1 */
  uint32_t nslots;
  ScrDyn **last;    /* +1 each, NULL when unbound */
  uint8_t *bound;   /* 0 unbound, 1 bound, 2 bound late (not yet pushed) */
  uint32_t nbound;
} NiShared;

static NiShared *ni_shared = NULL;
static uint32_t ni_nshared = 0, ni_shared_cap = 0;
/* Bound slots over all modules. The island's thread writes it; with worker
 * threads every thread's entry into Node reads it first
 * (scr_ni_shared_refresh), so it is atomic there. Without them it is the
 * plain counter it was, and its test compiles to what it compiled to. */
#if SCR_NI_THREADS
static _Atomic uint32_t ni_shared_bound = 0;
#define NI_SHARED_BOUND() atomic_load_explicit(&ni_shared_bound, memory_order_relaxed)
#else
static uint32_t ni_shared_bound = 0;
#define NI_SHARED_BOUND() ni_shared_bound
#endif
static bool ni_refreshing = false;
static ScrDyn *ni_tdz = NULL;

static ScrDyn *ni_tdz_value(void) {
  if (ni_tdz == NULL) ni_tdz = scr_dyn_new_obj();
  return ni_tdz;
}

/* nodeIsland.sharedTdz: the sentinel an accessor answers for a binding in
 * its temporal dead zone (+1). */
ScrDyn *scr_node_island_shared_tdz(void) { return scr_dyn_retain(ni_tdz_value()); }

/* nodeIsland.share(path, exports JSON, accessor): registers a shared
 * module before any island code runs. Never loads Node. */
void scr_node_island_share(ScrStr *path, ScrStr *exports, ScrDyn *accessor) {
  /* The island's thread registers, once, before any other thread exists. A
   * worker whose entry is the program's entry runs the same registrations
   * in its own %init: its accessor reads that worker's instance of the
   * module, and the island has one instance of every module it imports, the
   * main thread's (the build says so, SC6011). */
  if (!scr_ni_main_thread()) return;
  for (uint32_t i = 0; i < ni_nshared; i++)
    if (ni_shared[i].path->len == path->len &&
        memcmp(ni_shared[i].path->data, path->data, path->len) == 0)
      return;
  /* Released at exit (after Node stopped, when it started: atexit order). */
  if (ni_nshared == 0 && ni_shared_cap == 0) scr_atexit(scr_ni_exports_release_all);
  if (ni_nshared == ni_shared_cap) {
    ni_shared_cap = ni_shared_cap ? ni_shared_cap * 2 : 8;
    NiShared *grown = realloc(ni_shared, ni_shared_cap * sizeof *grown);
    if (grown == NULL) ni_export_oom();
    ni_shared = grown;
  }
  NiShared *m = &ni_shared[ni_nshared++];
  memset(m, 0, sizeof *m);
  m->path = scr_str_retain(path);
  m->exports = scr_str_retain(exports);
  m->accessor = scr_dyn_retain(accessor);
  /* The slot count: the accessor's array length is the export count. */
  uint32_t n = 0;
  for (size_t i = 0; i < exports->len; i++) n += exports->data[i] == '{';
  m->nslots = n;
  m->last = calloc(n > 0 ? n : 1, sizeof *m->last);
  m->bound = calloc(n > 0 ? n : 1, 1);
  if (m->last == NULL || m->bound == NULL) ni_export_oom();
}

/* The current export values of module `m` (+1 dyn array), or NULL. */
static ScrDyn *ni_shared_values(NiShared *m) {
  ScrDyn *values = scr_dyn_call(m->accessor, NULL, 0, "shared module");
  if (values == NULL) scr_exc_clear();
  return values;
}

void scr_ni_host_shared_table(ScrNodeValue *out) {
  ni_keep_set(NULL);
  /* Each module's file as Node resolves it: in the shipped module tree. */
  char **paths = calloc(ni_nshared > 0 ? ni_nshared : 1, sizeof *paths);
  if (paths == NULL) ni_export_oom();
  size_t len = 2;
  for (uint32_t i = 0; i < ni_nshared; i++) {
    paths[i] = scr_ni_module_path(ni_shared[i].path);
    len += strlen(paths[i]) * 2 + ni_shared[i].exports->len + 32;
  }
  char *buf = malloc(len);
  if (buf == NULL) ni_export_oom();
  size_t at = 0;
  buf[at++] = '[';
  for (uint32_t i = 0; i < ni_nshared; i++) {
    NiShared *m = &ni_shared[i];
    if (i > 0) buf[at++] = ',';
    at += (size_t)sprintf(buf + at, "{\"path\":\"");
    for (const char *p = paths[i]; *p != '\0'; p++) {
      char c = *p;
      if (c == '"' || c == '\\') buf[at++] = '\\';
      buf[at++] = c;
    }
    free(paths[i]);
    at += (size_t)sprintf(buf + at, "\",\"exports\":");
    memcpy(buf + at, m->exports->data, m->exports->len);
    at += m->exports->len;
    buf[at++] = '}';
  }
  buf[at++] = ']';
  free(paths);
  ScrStr *text = scr_str_new(buf, at);
  ScrDyn *json = scr_dyn_new_str(text);
  scr_str_release(text);
  free(buf);
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_STRING;
  out->u.str.data = json->v.str->data;
  out->u.str.len = json->v.str->len;
  ni_keep_set(json);
}

static void ni_shared_bind(NiShared *m, uint32_t slot, ScrDyn *value, uint8_t how) {
  if (m->bound[slot] == 0) {
    m->nbound++;
    ni_shared_bound++;
  }
  m->bound[slot] = how;
  scr_dyn_release(m->last[slot]);
  m->last[slot] = value != NULL ? scr_dyn_retain(value) : NULL;
}

int scr_ni_host_shared_get(uint32_t mod, uint32_t slot, int mode, ScrNodeValue *out) {
  ni_keep_set(NULL);
  memset(out, 0, sizeof *out);
  if (mod >= ni_nshared || slot >= ni_shared[mod].nslots) return 3;
  NiShared *m = &ni_shared[mod];
  ScrDyn *values = ni_shared_values(m);
  if (values == NULL) return 3;
  ScrDyn *v = scr_dyn_arr_at(values, slot);
  scr_dyn_release(values);
  if (v == ni_tdz) {
    scr_dyn_release(v);
    if (mode == 2) ni_shared_bind(m, slot, NULL, 2);
    return 3;
  }
  /* Arrays still cross as copies (NI-5): a copy of shared state would
   * diverge silently, so the island read throws instead. */
  if (v->kind == SCR_DYN_ARR ||
      (v->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(v) != NULL)) {
    scr_dyn_release(v);
    static const char message[] =
        "scriptc: an array exported by a shared module cannot cross into a Node island yet";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "SC8010");
    return ni_threw(out);
  }
  if (mode == 1 || mode == 2) ni_shared_bind(m, slot, v, 1);
  return ni_returned(v, out);
}

void scr_ni_host_shared_tdz(ScrNodeValue *out) {
  ni_keep_set(NULL);
  size_t cap = 64, at = 0;
  char *buf = malloc(cap);
  if (buf == NULL) ni_export_oom();
  buf[at++] = '[';
  for (uint32_t i = 0; i < ni_nshared; i++) {
    NiShared *m = &ni_shared[i];
    ScrDyn *values = ni_shared_values(m);
    if (values == NULL) continue;
    for (uint32_t j = 0; j < m->nslots; j++) {
      ScrDyn *v = scr_dyn_arr_at(values, j);
      if (v == ni_tdz) {
        if (at + 32 > cap) {
          cap *= 2;
          char *grown = realloc(buf, cap);
          if (grown == NULL) ni_export_oom();
          buf = grown;
        }
        at += (size_t)sprintf(buf + at, "%s[%u,%u]", at > 1 ? "," : "", i, j);
      }
      scr_dyn_release(v);
    }
    scr_dyn_release(values);
  }
  buf[at++] = ']';
  ScrStr *text = scr_str_new(buf, at);
  ScrDyn *json = scr_dyn_new_str(text);
  scr_str_release(text);
  free(buf);
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_STRING;
  out->u.str.data = json->v.str->data;
  out->u.str.len = json->v.str->len;
  ni_keep_set(json);
}

typedef struct {
  uint32_t mod, slot;
  const ScrNodeValue *value;
} NiPush;

static void ni_push_job(void *p) {
  NiPush *a = p;
  scr_ni_bridge_loaded()->shared_push(a->mod, a->slot, a->value);
}

/* Pushes the bound exports whose native values changed since the last
 * push. Cheap when nothing is bound. */
void scr_ni_shared_refresh(void) {
  /* The shared binding tables belong to the island's thread, like every
   * other island-side structure; a worker thread's entry sees the values
   * the last entry on that thread pushed. */
#if SCR_NI_THREADS
  if (NI_SHARED_BOUND() == 0) return;
  if (!scr_ni_main_thread()) return;
  if (ni_refreshing || scr_ni_bridge_loaded() == NULL) return;
#else
  /* One script thread: the test as it was before threads could get here. */
  if (NI_SHARED_BOUND() == 0 || ni_refreshing || scr_ni_bridge_loaded() == NULL) return;
#endif
  ni_refreshing = true;
  bool pending = scr_exc_pending();
  ScrCaught *saved = pending ? scr_exc_take() : NULL;
  for (uint32_t i = 0; i < ni_nshared; i++) {
    NiShared *m = &ni_shared[i];
    if (m->nbound == 0) continue;
    ScrDyn *values = ni_shared_values(m);
    if (values == NULL) continue;
    for (uint32_t j = 0; j < m->nslots; j++) {
      if (m->bound[j] == 0) continue;
      ScrDyn *v = scr_dyn_arr_at(values, j);
      if (v == ni_tdz || (m->bound[j] == 1 && m->last[j] != NULL && scr_dyn_strict_eq(v, m->last[j]))) {
        scr_dyn_release(v);
        continue;
      }
      ScrNodeValue nv;
      bool ok = false;
      void *keep = scr_ni_value_out_begin(v, &nv, &ok);
      if (ok) {
        NiPush a = {i, j, &nv};
        scr_ni_on_node_stack(ni_push_job, &a);
      } else {
        scr_exc_clear();
      }
      scr_ni_value_out_end(keep);
      scr_dyn_release(m->last[j]);
      m->last[j] = v;
      m->bound[j] = 1;
    }
    scr_dyn_release(values);
  }
  if (saved != NULL) {
    scr_rethrow(saved);
    scr_caught_release(saved);
  }
  ni_refreshing = false;
}

/* At exit, once Node stopped: everything the export table, the class
 * tables and the shared modules hold (the RC audit counts them). */
void scr_ni_exports_release_all(void) {
  ni_keep_set(NULL);
  /* Each value is detached from the table under the lock and released after
   * it is dropped: a destructor may mint another export. */
  for (uint32_t i = 1; i < ni_exports_len; i++) {
    ScrDyn *v;
    /* The twin stops telling first, outside the lock (its class's code). */
    if (ni_exports[i].value != NULL) ni_twin_detach(i);
    bool held = ni_exports_take();
    v = ni_exports[i].value;
    if (v != NULL) {
      if (v->kind == SCR_DYN_PROMISE) scr_promise_identity_drop(ni_exports[i].identity);
      ni_exports[i].value = NULL;
    }
    ni_exports_give(held);
    scr_dyn_release(v);
  }
  ni_exports_len = 1;
  ni_nfree = 0;
  free(ni_adopted);
  ni_adopted = NULL;
  ni_adopted_cap = 0;
  free(ni_ids);
  ni_ids = NULL;
  ni_ids_cap = ni_ids_len = ni_ids_dead = 0;
  for (size_t i = 0; i < ni_nmethods; i++) {
    scr_dyn_release(ni_methods[i].table);
    scr_dyn_release(ni_methods[i].ctor);
  }
  ni_nmethods = 0;
  for (uint32_t i = 0; i < ni_nshared; i++) {
    NiShared *m = &ni_shared[i];
    for (uint32_t j = 0; j < m->nslots; j++) scr_dyn_release(m->last[j]);
    free(m->last);
    free(m->bound);
    scr_str_release(m->path);
    scr_str_release(m->exports);
    scr_dyn_release(m->accessor);
  }
  ni_nshared = 0;
  ni_shared_bound = 0;
  scr_dyn_release(ni_tdz);
  ni_tdz = NULL;
}

#endif

#if !defined(_WIN32) && !defined(__wasi__)
/* ── native classes extending island classes (scope-B NI-5b) ───────────
 * The class is a JavaScript constructor made by the bootstrap's helpers
 * (scr_node_island_host.cjs, module "scriptc:island-helpers"); its
 * constructor, field initializers, methods and accessors are native
 * closures exported into Node, and its instances are island objects. */
/* One handle box of the helpers module per thread: a box belongs to the
 * heap of the thread that made it, and a worker thread reaches the helpers
 * too (instanceof against a global class, promisify, a subclass). */
static SCR_TL ScrDyn *ni_helpers = NULL;

/* At the thread's exit the helpers module is the unit's own reference, not
 * the program's: release it so the reference audit sees only program
 * objects. */
static void ni_helpers_cleanup(void) {
  if (ni_helpers == NULL) return;
  scr_dyn_release(ni_helpers);
  ni_helpers = NULL;
}

ScrDyn *scr_ni_helper(const char *name, ScrDyn *const *args, size_t argc) {
  if (ni_helpers == NULL) {
    ScrStr *path = scr_str_new("scriptc:island-helpers", 22);
    ni_helpers = scr_ni_require(path);
    scr_str_release(path);
    if (ni_helpers == NULL) return NULL;
    scr_atexit(ni_helpers_cleanup);
  }
  return scr_ni_call_method(ni_helpers, name, strlen(name), args, argc);
}

/* The native object of export `id` tells its twin that `event` happened,
 * with `value` (borrowed): the bootstrap's tellTwin(class, event, twin,
 * value). Called from inside the native object's own state change, so the
 * twin's state is the native object's before either side's listeners run.
 * A value that cannot cross reaches the twin as the error that says so. */
void scr_ni_twin_tell(uint32_t id, const char *event, ScrDyn *value) {
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL || ni_exports[id].twin == NULL || scr_ni_bridge_loaded() == NULL) return;
  /* An adopted island object is where the change came from. */
  if (ni_exports[id].adopted) return;
  ScrCaught *saved = scr_exc_pending() ? scr_exc_take() : NULL;
  const char *name = ni_exports[id].twin->name;
  ScrStr *cs = scr_str_new(name, strlen(name)), *es = scr_str_new(event, strlen(event));
  ScrDyn *args[4] = {scr_dyn_new_str(cs), scr_dyn_new_str(es), scr_dyn_retain(target),
                     value != NULL ? value : scr_dyn_undefined()};
  scr_str_release(cs);
  scr_str_release(es);
  ScrDyn *answer = scr_ni_helper("tellTwin", args, 4);
  if (answer == NULL && scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *thrown = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    if (thrown != NULL) {
      args[3] = thrown;
      answer = scr_ni_helper("tellTwin", args, 4);
      scr_dyn_release(thrown);
    }
    if (scr_exc_pending()) scr_exc_clear();
  }
  scr_dyn_release(answer);
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_dyn_release(args[2]);
  if (saved != NULL) {
    scr_rethrow(saved);
    scr_caught_release(saved);
  }
}

/* An island object of a twin class reached native code (the bridge flagged
 * its handle). The class that adopts it makes a native object, whose export
 * takes the island object as its representative when it first crosses, here:
 * the island object is then that export for good, and crosses in as the
 * native object from now on. +1, or NULL: no class adopts it. */
ScrDyn *scr_ni_twin_adopt(ScrDyn *island, uint32_t handle) {
  bool adopting = false;
  for (const ScrNiTwinClass *c = ni_twin_classes; c != NULL; c = c->next) adopting |= c->adopt != NULL;
  if (!adopting) return NULL;
  ScrCaught *saved = scr_exc_pending() ? scr_exc_take() : NULL;
  ScrDyn *native = NULL;
  ScrDyn *name = scr_ni_helper("twinClassOf", &island, 1);
  const ScrNiTwinClass *cls = NULL;
  /* Adopted since this handle was made: the native object that did. */
  if (name != NULL && ni_twin_class(name) != NULL) {
    ni_adopted_keep(island);
    if (saved != NULL) {
      scr_rethrow(saved);
      scr_caught_release(saved);
    }
    return name;
  }
  if (name != NULL && name->kind == SCR_DYN_STR)
    for (const ScrNiTwinClass *c = ni_twin_classes; c != NULL && cls == NULL; c = c->next)
      if (c->adopt != NULL && strlen(c->name) == name->v.str->len &&
          memcmp(c->name, name->v.str->data, name->v.str->len) == 0)
        cls = c;
  scr_dyn_release(name);
  if (cls != NULL) native = cls->adopt();
  if (native != NULL) {
    uint32_t id = scr_ni_export_id(native);
    ni_exports[id].adopts = handle;
    ni_exports[id].adopted = true;
    ScrDyn *ready = scr_ni_helper("twinReady", &native, 1);
    bool ok = ready != NULL && ready->kind == SCR_DYN_BOOL && ready->v.b;
    scr_dyn_release(ready);
    if (ni_exports[id].value == native) ni_exports[id].adopts = 0;
    if (!ok) { /* the island object stays a handle */
      if (ni_exports[id].value == native) scr_ni_host_export_release(id);
      scr_dyn_release(native);
      native = NULL;
    } else {
      ni_adopted_keep(island);
    }
  }
  if (scr_exc_pending()) scr_exc_clear();
  if (saved != NULL) {
    scr_rethrow(saved);
    scr_caught_release(saved);
  }
  return native;
}

/* args: a dyn array whose items cross one by one (never as a copy). */
static ScrDyn *ni_helper_spread(const char *name, ScrDyn **lead, size_t nlead, ScrDyn *args) {
  size_t n = args != NULL && args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *small[16];
  ScrDyn **all = nlead + n <= 16 ? small : malloc((nlead + n) * sizeof *all);
  if (all == NULL) ni_export_oom();
  for (size_t i = 0; i < nlead; i++) all[i] = lead[i];
  for (size_t i = 0; i < n; i++) all[nlead + i] = args->v.arr.items[i];
  ScrDyn *r = scr_ni_helper(name, all, nlead + n);
  if (all != small) free(all);
  return r;
}

/* Creates the JavaScript class (base, name, ctor, fields, methods, getters,
 * setters): +1 island handle, or NULL with the error pending. */
ScrDyn *scr_ni_subclass_create(ScrDyn *const *args) {
  return scr_ni_helper("subclass", args, 7);
}

/* NI-5d: before Node has started (the base is a deferred island class's
 * stub), the class is a lazy ref: its name and typeof answer without Node,
 * and the first operation that needs the class creates it
 * (scr_node_island_handle.c, nh_live). */
ScrDyn *scr_node_island_subclass(ScrDyn *base, ScrStr *name, ScrDyn *ctor, ScrDyn *fields,
                                 ScrDyn *methods, ScrDyn *getters, ScrDyn *setters) {
  ScrDyn *n = scr_dyn_new_str(name);
  ScrDyn *args[] = {base, n, ctor, fields, methods, getters, setters};
  ScrDyn *r = scr_ni_bridge_loaded() == NULL ? scr_ni_lazy_subclass_new(args)
                                              : scr_ni_subclass_create(args);
  scr_dyn_release(n);
  return r;
}

ScrDyn *scr_node_island_super_construct(ScrDyn *box, ScrDyn *args) {
  ScrDyn *lead[] = {box};
  return ni_helper_spread("superConstruct", lead, 1, args);
}

ScrDyn *scr_node_island_super_method(ScrDyn *base, ScrDyn *self, ScrStr *name, ScrDyn *args) {
  ScrDyn *n = scr_dyn_new_str(name);
  ScrDyn *lead[] = {base, self, n};
  ScrDyn *r = ni_helper_spread("superMethod", lead, 3, args);
  scr_dyn_release(n);
  return r;
}

void scr_node_island_define_field(ScrDyn *self, ScrStr *key, ScrDyn *value) {
  ScrDyn *k = scr_dyn_new_str(key);
  ScrDyn *args[] = {self, k, value};
  ScrDyn *r = scr_ni_helper("defineField", args, 3);
  scr_dyn_release(k);
  scr_dyn_release(r);
}

/* `value instanceof Error` (or a builtin Error subclass, `name`) for an
 * island value: Node's own answer. False for every other value, which the
 * native test answers. */
bool scr_node_island_instanceof_global(ScrDyn *value, ScrStr *name) {
  if (value == NULL || !scr_ni_is_handle(value)) return false;
  ScrDyn *n = scr_dyn_new_str(name);
  ScrDyn *args[] = {value, n};
  ScrDyn *r = scr_ni_helper("isInstance", args, 2);
  scr_dyn_release(n);
  bool yes = r != NULL && r->kind == SCR_DYN_BOOL && r->v.b;
  scr_dyn_release(r);
  if (scr_exc_pending()) scr_exc_clear();
  return yes;
}

/* clearTimeout (which 0), clearInterval (1) or clearImmediate (2) of a
 * checked-dynamic value that is not a number: a timer island code created
 * is cleared by Node's own function, and every other value is ignored, as
 * Node ignores values that are not timers. A handle exists only once Node
 * is loaded, so this never starts it. */
void scr_node_island_clear_timer(ScrDyn *value, double which) {
  if (value == NULL || !scr_ni_is_handle(value)) return;
  ScrDyn *w = scr_dyn_new_num(which);
  ScrDyn *args[] = {w, value};
  ScrDyn *r = scr_ni_helper("clearTimer", args, 2);
  scr_dyn_release(w);
  scr_dyn_release(r);
}

/* util.promisify of an island function: Node's own, in the island. */
ScrDyn *scr_node_island_promisify(ScrDyn *fn) {
  ScrDyn *args[] = {fn};
  return scr_ni_helper("promisify", args, 1);
}
#endif
