/* scriptc runtime — the dynamic tier's hidden classes and inline caches
 * (scr_js.h; two-tier design stage S4).
 *
 * Shapes are attached to the existing checked objects (ScrDyn OBJ nodes)
 * rather than replacing their entry storage: static code and the shared
 * runtime read those entries in place, so a second object representation
 * would have to be understood or converted at every boundary. A shape is a
 * node of the thread's transition tree over key sequences; an object's
 * shape proves which key sits at each entry index and which keys the
 * object lacks. Everything else a cache hit depends on is tested live: the
 * node kind, the accessor and writable bits of the entry it uses, and the
 * prototype pointer.
 *
 * Linked only into programs with dynamic-tier code (the dynTier runtime
 * feature), together with the SCR_JS_TIER build of scr_json.c, which
 * resets an object's shape on every change to its key set. */
#include "scr_js.h"
#include "scr_key.h"

#include <stdlib.h>
#include <string.h>

/* The compiler's inline cache tests read these in place (64-bit targets;
 * backend/llvm/js-ic.ts). */
#if SCR_JS_IMMEDIATES
_Static_assert(offsetof(ScrDyn, kind) == 8, "kind offset");
_Static_assert(offsetof(ScrDyn, v.obj.len) == 16 && offsetof(ScrDyn, v.obj.entries) == 32,
               "object entry offsets");
_Static_assert(offsetof(ScrDyn, v.arr.len) == 16 && offsetof(ScrDyn, v.arr.items) == 32 &&
               offsetof(ScrDyn, v.arr.presence) == 56, "array element offsets");
_Static_assert(offsetof(ScrDyn, prototype) == 96, "prototype offset");
_Static_assert(sizeof(ScrDynEntry) == 32 && offsetof(ScrDynEntry, value) == 16 &&
               offsetof(ScrDynEntry, writable) == 13, "entry layout");
_Static_assert(sizeof(ScrJsIcEntry) == 40 && sizeof(ScrJsIc) == 168, "cache layout");
#endif

/* Objects with more entries stay unshaped (dictionary mode): their reads
 * take the generic path and its hash index. */
#define SCR_JS_SHAPE_MAX 64

/* Shapes live until the thread exits or a library session ends, so a thread
 * creates at most this many, holding at most this many key bytes. Once
 * either budget is spent, objects whose key sequence has no shape yet stay
 * unshaped; shapes that exist keep serving. */
#define SCR_JS_SHAPE_BUDGET ((size_t)1 << 16)
#define SCR_JS_SHAPE_KEY_BYTES_BUDGET ((size_t)4 << 20)

struct ScrJsShape {
  const ScrJsShape *parent;
  char *key; /* one reference to shared key bytes (scr_json.c) */
  size_t key_len;
  uint64_t hash;
  uint32_t count; /* entries: the depth in the tree */
  ScrJsShape *all_next;
  /* for-in's keys of objects of this shape (scr_js_for_in_keys), built on
   * first use: a string[] that reads as immortal and owns its strings. */
  ScrArr *key_strs;
  bool index_keys; /* some key is integer-like (for-in orders those first) */
  /* One bit per key on the path (scr_js_key_bit): a key whose bit is clear
   * is not an own property of objects of this shape. */
  uint64_t bloom;
  /* The bytes of each key_strs string, in order: a for-in key read back
   * on an object of this shape finds its entry by address. */
  const char **key_data;
  /* The key bytes and lengths of the path, in entry order, built on the
   * first literal of this shape (scr_js_new_literal). */
  char **fill_keys;
  size_t *fill_lens;
};

/* Compiled get sites test a key's filter bit inline (js-ic.ts emitGet). */
_Static_assert(offsetof(ScrJsShape, bloom) == 64, "shape filter offset");
_Static_assert(offsetof(ScrDyn, v.obj.shape) == 80, "object shape offset");

/* The root is the empty key sequence. Transitions live in one open
 * addressing table per thread keyed by (parent, key). */
static SCR_TL ScrJsShape scr_js_root;
static SCR_TL ScrJsShape *scr_js_all_shapes;
static SCR_TL ScrJsShape **scr_js_transitions;
static SCR_TL size_t scr_js_transition_mask; /* capacity - 1; 0 when absent */
static SCR_TL size_t scr_js_transition_count;
static SCR_TL size_t scr_js_shape_key_bytes;
static SCR_TL bool scr_js_shapes_registered;

/* The cache records that hold entries. Entries name shapes and prototype
 * objects, so the reset that frees the shapes also clears these records: a
 * library's next session runs the same sites with the same records. */
static SCR_TL ScrJsIc **scr_js_filled_ics;
static SCR_TL size_t scr_js_filled_count;
static SCR_TL size_t scr_js_filled_capacity;

/* The shape word of an object whose key sequence has no shape within the
 * budgets. No cache entry names it, so its accesses take the probes,
 * which answer with a miss until the key set changes. */
static ScrJsShape scr_js_unshaped = {.bloom = UINT64_MAX}; /* never answers absent */

/* The second-level cache of load sites whose own record is full: one entry
 * per (receiver shape, key bytes) slot, filled by the probe and checked like
 * a site entry. It names shapes, so the shape reset clears it. */
#define SCR_JS_SHARED_LOADS 2048
typedef struct ScrJsSharedLoad {
  const char *key;
  ScrJsIcEntry entry;
} ScrJsSharedLoad;
static SCR_TL ScrJsSharedLoad *scr_js_shared_loads;

/* The key checks of an adopting copy, per (source shape, excluded names):
 * whether the keys copy as they are, which entry positions the copy drops,
 * and the shape of the kept keys (NULL past the budgets). Shapes die with
 * the shape reset, which clears these too. */
typedef struct {
  const ScrJsShape *shape;
  const ScrStr *excluded;
  const ScrJsShape *kept;
  uint64_t drop;
  bool ok;
} ScrJsAdoptMemo;
#define SCR_JS_ADOPT_MEMOS 64
static SCR_TL ScrJsAdoptMemo scr_js_adopt_memos[SCR_JS_ADOPT_MEMOS];

static void scr_js_key_strs_free(ScrJsShape *shape) {
  free(shape->key_data);
  shape->key_data = NULL;
  free(shape->fill_keys);
  shape->fill_keys = NULL;
  shape->fill_lens = NULL;
  if (!shape->key_strs) return;
  shape->key_strs->rc = 1;
  scr_arr_release(shape->key_strs);
  shape->key_strs = NULL;
}

static void scr_js_shapes_reset(void) {
  scr_js_key_strs_free(&scr_js_root);
  memset(scr_js_adopt_memos, 0, sizeof scr_js_adopt_memos);
  for (size_t i = 0; i < scr_js_filled_count; i++)
    memset(scr_js_filled_ics[i], 0, sizeof *scr_js_filled_ics[i]);
  free(scr_js_shared_loads);
  scr_js_shared_loads = NULL;
  free(scr_js_filled_ics);
  scr_js_filled_ics = NULL;
  scr_js_filled_count = 0;
  scr_js_filled_capacity = 0;
  while (scr_js_all_shapes) {
    ScrJsShape *shape = scr_js_all_shapes;
    scr_js_all_shapes = shape->all_next;
    scr_dyn_tier_key_release(shape->key, shape->key_len);
    scr_js_key_strs_free(shape);
    free(shape);
  }
  free(scr_js_transitions);
  scr_js_transitions = NULL;
  scr_js_transition_mask = 0;
  scr_js_transition_count = 0;
  scr_js_shape_key_bytes = 0;
  scr_js_shapes_registered = false;
}

static size_t scr_js_transition_slot(const ScrJsShape *parent, uint64_t hash) {
  return (size_t)scr_key_mix(hash ^ (uint64_t)(uintptr_t)parent);
}

static void scr_js_transition_insert(ScrJsShape *child) {
  size_t i = scr_js_transition_slot(child->parent, child->hash) & scr_js_transition_mask;
  while (scr_js_transitions[i]) i = (i + 1) & scr_js_transition_mask;
  scr_js_transitions[i] = child;
}

static void scr_js_transitions_grow(void) {
  size_t old_cap = scr_js_transition_mask ? scr_js_transition_mask + 1 : 0;
  size_t cap = old_cap ? old_cap * 2 : 256;
  ScrJsShape **old = scr_js_transitions;
  scr_js_transitions = calloc(cap, sizeof *scr_js_transitions);
  if (!scr_js_transitions) scr_trap("scriptc: out of memory\n");
  scr_js_transition_mask = cap - 1;
  for (size_t i = 0; i < old_cap; i++)
    if (old[i]) scr_js_transition_insert(old[i]);
  free(old);
}

/* The child of `parent` for appending `key` (borrowed bytes), created on
 * first use; NULL when creating it would exceed a budget. */
static const ScrJsShape *scr_js_transition(const ScrJsShape *parent, const char *key, size_t key_len) {
  uint64_t hash = scr_key_hash(key, key_len);
  if (scr_js_transition_mask) {
    size_t i = scr_js_transition_slot(parent, hash) & scr_js_transition_mask;
    for (ScrJsShape *child; (child = scr_js_transitions[i]); i = (i + 1) & scr_js_transition_mask) {
      if (child->parent == parent && child->hash == hash && child->key_len == key_len &&
          scr_key_equal(child->key, key, key_len))
        return child;
    }
  }
  if (scr_js_transition_count >= SCR_JS_SHAPE_BUDGET ||
      key_len > SCR_JS_SHAPE_KEY_BYTES_BUDGET - scr_js_shape_key_bytes)
    return NULL;
  if ((scr_js_transition_count + 1) * 2 > (scr_js_transition_mask ? scr_js_transition_mask + 1 : 0))
    scr_js_transitions_grow();
  ScrJsShape *child = malloc(sizeof *child);
  if (!child) scr_trap("scriptc: out of memory\n");
  *child = (ScrJsShape){parent, scr_dyn_tier_key_copy(key, key_len), key_len, hash, parent->count + 1,
                        scr_js_all_shapes};
  child->bloom = parent->bloom | (UINT64_C(1) << (hash & 63));
  scr_js_all_shapes = child;
  if (!scr_js_shapes_registered) {
    scr_js_shapes_registered = true;
    scr_atexit(scr_js_shapes_reset);
  }
  scr_js_transition_insert(child);
  scr_js_transition_count++;
  scr_js_shape_key_bytes += key_len;
  return child;
}

/* An object's shape, computed from its entries when it has none; NULL for
 * objects that stay unshaped (other kinds, immortal objects, the builtin
 * Object.prototype, dictionary-sized objects, key sequences past the
 * budgets). Immortal objects (rc == SIZE_MAX: published graphs, which
 * threads share by pointer) are never shaped: shapes belong to one thread
 * and die with it, and no thread writes an immortal object's header. */
#ifdef SCR_JS_VERIFY
/* Debugging aid (build the runtime with -DSCR_JS_VERIFY and compile with
 * SCRIPTC_JS_IC_WAYS=0 so every access probes): traps when an object's
 * shape no longer names its key sequence, i.e. when some mutation of the
 * key set missed its SCR_JS_SHAPE_RESET. */
static void scr_js_verify(const ScrDyn *object, const ScrJsShape *shape) {
  size_t len = object->v.obj.len;
  if (shape->count != len) scr_trap("scriptc: stale shape (entry count)\n");
  for (const ScrJsShape *s = shape; s->parent; s = s->parent) {
    const ScrDynEntry *entry = &object->v.obj.entries[s->count - 1];
    if (entry->key_len != s->key_len || !scr_key_equal(entry->key, s->key, s->key_len))
      scr_trap("scriptc: stale shape (key)\n");
  }
}
#endif

static const ScrJsShape *scr_js_shape_of(ScrDyn *object) {
  if (object->kind != SCR_DYN_OBJ || object->rc == SIZE_MAX) return NULL;
  const ScrJsShape *shape = object->v.obj.shape;
  if (shape == &scr_js_unshaped) return NULL;
#ifdef SCR_JS_VERIFY
  if (shape) scr_js_verify(object, shape);
#endif
  if (shape) return shape;
  size_t len = object->v.obj.len;
  if (len > SCR_JS_SHAPE_MAX || object == scr_dyn_tier_object_prototype()) return NULL;
  shape = &scr_js_root;
  for (size_t i = 0; i < len; i++) {
    ScrDynEntry *entry = &object->v.obj.entries[i];
    shape = scr_js_transition(shape, entry->key, entry->key_len);
    if (!shape) {
      object->v.obj.shape = &scr_js_unshaped;
      return NULL;
    }
  }
  object->v.obj.shape = (ScrJsShape *)shape;
  return shape;
}

/* for-in's key snapshot of a plain object whose prototype contributes no
 * keys, shared by every object of its shape: the keys in entry order, or
 * NULL when the object has no shape, some key is integer-like (for-in
 * lists those first, ascending) or some entry is not enumerable. The
 * array reads as immortal (callers only read it) and lives until the
 * thread's shapes are reset. */
ScrArr *scr_js_for_in_keys(ScrDyn *object) {
  ScrJsShape *shape = (ScrJsShape *)scr_js_shape_of(object);
  if (!shape) return NULL;
  if (!shape->key_strs) {
    const ScrJsShape *path[SCR_JS_SHAPE_MAX];
    for (const ScrJsShape *s = shape; s->parent; s = s->parent) path[s->count - 1] = s;
    ScrArr *keys = scr_arr_new(SCR_ELEM_STR, shape->count);
    const char **data = shape->count ? malloc(shape->count * sizeof *data) : NULL;
    if (shape->count && !data) scr_trap("scriptc: out of memory\n");
    bool index_keys = false;
    for (uint32_t i = 0; i < shape->count; i++) {
      uint32_t index;
      index_keys = index_keys || scr_key_array_index(path[i]->key, path[i]->key_len, &index);
      ScrStr *key = scr_str_new(path[i]->key, path[i]->key_len);
      data[i] = key->data;
      scr_arr_push_ref(keys, key);
    }
    shape->key_data = data;
    if (!shape->parent && !scr_js_shapes_registered) {
      scr_js_shapes_registered = true;
      scr_atexit(scr_js_shapes_reset);
    }
    keys->rc = SIZE_MAX;
    shape->key_strs = keys;
    shape->index_keys = index_keys;
  }
  if (shape->index_keys) return NULL;
  for (size_t i = 0; i < object->v.obj.len; i++)
    if (!object->v.obj.entries[i].enumerable) return NULL;
  return shape->key_strs;
}

/* The entry of a key whose bytes are one of the for-in key strings of
 * `object`'s shape, by address; SIZE_MAX otherwise. The object holds
 * exactly its shape's keys, in order. */
size_t scr_js_shape_key_slot(const ScrDyn *object, const char *key) {
  const ScrJsShape *shape = object->v.obj.shape;
  if (!shape || !shape->key_data || shape->count != object->v.obj.len) return SIZE_MAX;
  for (uint32_t i = 0; i < shape->count; i++)
    if (shape->key_data[i] == key) return i;
  return SIZE_MAX;
}

/* The entry index of `key` in `object` (of its shape): its entries are
 * contiguous, so this scan touches no shape chain. */
static inline size_t scr_js_entry_find(const ScrDyn *object, const char *key, size_t key_len) {
  const ScrDynEntry *entries = object->v.obj.entries;
  for (size_t i = 0, n = object->v.obj.len; i < n; i++)
    if (entries[i].key_len == key_len && scr_key_equal(entries[i].key, key, key_len)) return i;
  return SIZE_MAX;
}

/* The entry index of `key` in an object of shape `shape`, or SIZE_MAX. */
static size_t scr_js_shape_find(const ScrJsShape *shape, const char *key, size_t key_len) {
  for (; shape->parent; shape = shape->parent)
    if (shape->key_len == key_len && scr_key_equal(shape->key, key, key_len)) return shape->count - 1;
  return SIZE_MAX;
}

/* Fills a cache entry: `stale` (a matching entry whose hit failed) when
 * there is one, else a free or replaceable one. */
static void scr_js_ic_add(ScrJsIc *ic, uint32_t stale, ScrJsIcEntry entry) {
  if (ic->count == 0) {
    if (scr_js_filled_count == scr_js_filled_capacity) {
      size_t capacity = scr_js_filled_capacity ? scr_js_filled_capacity * 2 : 64;
      ScrJsIc **grown = realloc(scr_js_filled_ics, capacity * sizeof *grown);
      if (!grown) scr_trap("scriptc: out of memory\n");
      scr_js_filled_ics = grown;
      scr_js_filled_capacity = capacity;
    }
    scr_js_filled_ics[scr_js_filled_count++] = ic;
  }
  uint32_t index;
  if (stale < ic->count) {
    index = stale;
  } else if (ic->count < SCR_JS_IC_WAYS) {
    index = ic->count++;
  } else {
    /* A full cache keeps entry 0, which the site tests inline, and cycles
     * through the others. */
    index = 1 + ic->next++ % (SCR_JS_IC_WAYS - 1);
  }
  ic->entry[index] = entry;
}

/* ── loads ────────────────────────────────────────────────────────────── */

/* The cached answer of an entry whose receiver shape matched, or NULL. */
static ScrDyn *scr_js_load_hit(ScrDyn *receiver, const ScrJsIcEntry *entry) {
  const ScrDyn *holder = receiver;
  if (entry->target) {
    holder = entry->holder;
    if (receiver->prototype != holder || holder->kind != SCR_DYN_OBJ ||
        holder->v.obj.shape != entry->target)
      return NULL;
  }
  const ScrDynEntry *found = &holder->v.obj.entries[entry->slot];
  return found->accessor ? NULL : scr_dyn_retain(found->value);
}

/* An absent entry: its target is this tag and its holder is a placeholder
 * that is never a prototype, so the inline test of entry 0 in compiled code
 * (a prototype hit needs the receiver's prototype to be the holder) always
 * sends such a receiver to the probe. Its holder_shape and slot name the one
 * prototype the read walked past (shape and object), or NULL and 0 when the
 * receiver had no prototype. */
static const ScrJsShape scr_js_absent;
static const ScrDyn scr_js_absent_holder;

/* Keys whose read on a plain object is not just its [[Get]]: the members of
 * Object.prototype, which reads of an absent own property answer through
 * the inherited-member path, and the error constructor read. */
static bool scr_js_absent_cacheable(const ScrStr *key) {
#define SCR_JS_INHERITED(name) {name, sizeof name - 1}
  static const struct {
    const char *name;
    size_t len;
  } inherited[] = {
      SCR_JS_INHERITED("constructor"),      SCR_JS_INHERITED("__proto__"),
      SCR_JS_INHERITED("toString"),         SCR_JS_INHERITED("toLocaleString"),
      SCR_JS_INHERITED("valueOf"),          SCR_JS_INHERITED("hasOwnProperty"),
      SCR_JS_INHERITED("isPrototypeOf"),    SCR_JS_INHERITED("propertyIsEnumerable"),
      SCR_JS_INHERITED("__defineGetter__"), SCR_JS_INHERITED("__defineSetter__"),
      SCR_JS_INHERITED("__lookupGetter__"), SCR_JS_INHERITED("__lookupSetter__"),
  };
#undef SCR_JS_INHERITED
  for (size_t i = 0; i < sizeof inherited / sizeof inherited[0]; i++)
    if (key->len == inherited[i].len && memcmp(key->data, inherited[i].name, key->len) == 0)
      return false;
  return true;
}

static ScrJsSharedLoad *scr_js_shared_load(const ScrJsShape *shape, const ScrStr *key) {
  if (!scr_js_shared_loads) {
    scr_js_shared_loads = calloc(SCR_JS_SHARED_LOADS, sizeof *scr_js_shared_loads);
    if (!scr_js_shared_loads) scr_trap("scriptc: out of memory\n");
  }
  uint64_t mixed = scr_key_mix((uint64_t)(uintptr_t)shape ^ ((uint64_t)(uintptr_t)key->data << 1));
  return &scr_js_shared_loads[mixed & (SCR_JS_SHARED_LOADS - 1)];
}

/* Whether an absent entry still holds for `receiver`, whose shape matched:
 * its own keys lack the key, so the walked prototype (if any) must be the
 * same object with the same shape, and the chain must end there. */
static bool scr_js_absent_hit(const ScrDyn *receiver, const ScrJsIcEntry *entry) {
  const ScrDyn *prototype = receiver->prototype;
  const ScrDyn *walked = (const ScrDyn *)entry->slot;
  if (!walked) return prototype == NULL;
  return prototype == walked && walked->kind == SCR_DYN_OBJ &&
         walked->v.obj.shape == entry->holder_shape && walked->prototype == NULL;
}

/* The answer of a matching entry for `receiver`, or NULL when the entry no
 * longer holds. */
static inline __attribute__((always_inline)) ScrDyn *scr_js_entry_answer(ScrDyn *receiver,
                                                                     const ScrJsIcEntry *entry) {
  if (entry->target == &scr_js_absent)
    return scr_js_absent_hit(receiver, entry) ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
  return scr_js_load_hit(receiver, entry);
}

/* The object an entry's answer depends on besides the receiver: the
 * prototype it read from or walked past, or NULL for an own property. */
static const ScrDyn *scr_js_entry_prototype(const ScrJsIcEntry *entry) {
  if (entry->target == &scr_js_absent) return (const ScrDyn *)entry->slot;
  return entry->target ? entry->holder : NULL;
}

/* Records `entry` in the site and, when the site's record is full, in the
 * shared slot. A matching entry whose answer failed is replaced when it
 * depends on the same prototype (that prototype changed); one that names
 * another prototype stays, so receivers of one shape with different
 * prototypes each keep an entry. */
static void scr_js_load_fill(ScrJsIc *ic, uint32_t stale, ScrJsSharedLoad *shared,
                             const ScrStr *key, ScrJsIcEntry entry) {
  if (stale < ic->count &&
      scr_js_entry_prototype(&ic->entry[stale]) != scr_js_entry_prototype(&entry))
    stale = UINT32_MAX;
  if (shared) *shared = (ScrJsSharedLoad){key->data, entry};
  scr_js_ic_add(ic, stale, entry);
}

/* What a site's key means to an absent read: its shape-filter bit and
 * whether an absent own property answers undefined on a receiver with the
 * default prototype. Site keys are immortal strings, remembered by their
 * bytes' address. */
typedef struct {
  const char *data;
  uint64_t bit;
  bool cacheable;
} ScrJsKeyFacts;

static const ScrJsKeyFacts *scr_js_key_facts(const ScrStr *key) {
  static SCR_TL ScrJsKeyFacts memo[64];
  ScrJsKeyFacts *facts = &memo[((uintptr_t)key->data >> 4) & 63];
  if (facts->data != key->data) {
    facts->data = key->data;
    facts->bit = UINT64_C(1) << (scr_key_hash(key->data, key->len) & 63);
    facts->cacheable = key->rc == SIZE_MAX && scr_js_absent_cacheable(key);
  }
  return facts;
}

/* A load site's probe. With `absent`, a read of a key that the receiver and
 * its chain of plain shaped objects (ending in the default prototype) lack
 * answers undefined and caches that answer. Method reads leave absent
 * methods to the slow path, which names the missing function. */
static __attribute__((noinline)) ScrDyn *scr_js_probe_load(ScrDyn *receiver, const ScrStr *key,
                                                            ScrJsIc *ic, bool absent) {
  const ScrJsShape *shape = scr_js_shape_of(receiver);
  if (!shape) return NULL;
  uint32_t stale = UINT32_MAX;
  for (uint32_t i = 0; i < ic->count; i++) {
    if (ic->entry[i].shape != shape) continue;
    ScrDyn *value = scr_js_entry_answer(receiver, &ic->entry[i]);
    if (value) return value;
    if (stale == UINT32_MAX) stale = i;
  }
  /* A megamorphic site's absent key: the shape filter answers without the
   * shared cache. */
  if (absent && ic->count == SCR_JS_IC_WAYS && !receiver->prototype) {
    const ScrJsKeyFacts *facts = scr_js_key_facts(key);
    if (facts->cacheable && !(shape->bloom & facts->bit)) return scr_dyn_retain(scr_dyn_undefined());
  }
  ScrJsSharedLoad *shared = NULL;
  if (ic->count == SCR_JS_IC_WAYS) {
    shared = scr_js_shared_load(shape, key);
    if (shared->key == key->data && shared->entry.shape == shape &&
        (absent || shared->entry.target != &scr_js_absent)) {
      ScrDyn *value = scr_js_entry_answer(receiver, &shared->entry);
      if (value) return value;
    }
  }
  size_t slot = scr_js_entry_find(receiver, key->data, key->len);
  if (slot != SIZE_MAX) {
    const ScrDynEntry *found = &receiver->v.obj.entries[slot];
    if (found->accessor) return NULL;
    scr_js_load_fill(ic, stale, shared, key, (ScrJsIcEntry){shape, NULL, NULL, NULL, slot});
    return scr_dyn_retain(found->value);
  }
  absent = absent && scr_js_absent_cacheable(key);
  /* One prototype link: an ordinary object other than the builtin
   * Object.prototype (whose reads the generic path fences). */
  ScrDyn *holder = receiver->prototype;
  if (!holder) {
    if (!absent) return NULL;
    scr_js_load_fill(ic, stale, shared, key,
                     (ScrJsIcEntry){shape, &scr_js_absent, &scr_js_absent_holder, NULL, 0});
    return scr_dyn_retain(scr_dyn_undefined());
  }
  const ScrJsShape *holder_shape = scr_js_shape_of(holder);
  if (!holder_shape) return NULL;
  slot = scr_js_shape_find(holder_shape, key->data, key->len);
  if (slot == SIZE_MAX) {
    if (!absent || holder->prototype != NULL) return NULL;
    scr_js_load_fill(ic, stale, shared, key,
                     (ScrJsIcEntry){shape, &scr_js_absent, &scr_js_absent_holder, holder_shape,
                                    (size_t)holder});
    return scr_dyn_retain(scr_dyn_undefined());
  }
  const ScrDynEntry *found = &holder->v.obj.entries[slot];
  if (found->accessor) return NULL;
  scr_js_load_fill(ic, stale, shared, key, (ScrJsIcEntry){shape, holder_shape, holder, NULL, slot});
  return scr_dyn_retain(found->value);
}

/* ── object literals ───────────────────────────────────────────────────── */

/* An object literal whose members all have distinct constant keys (a
 * compiled literal site): a fresh ordinary object with `values` (each +1,
 * taken over) under `keys`, in order. The site remembers the literal's shape, so a
 * repeat appends each value under the key bytes the shape holds and sets
 * the shape, with no transition lookup. +1. */
ScrDyn *scr_js_new_literal(ScrJsIc *ic, size_t n, ScrStr *const *keys, ScrDyn *const *values) {
  ScrDyn *obj = scr_dyn_new_obj();
  const ScrJsShape *shape = ic->count ? ic->entry[0].target : NULL;
  if (shape && shape->count == n) {
    ScrJsShape *owner = (ScrJsShape *)shape;
    if (!owner->fill_keys && n) {
      /* One block: the key pointers, then the lengths. */
      char **keys = malloc(n * (sizeof *keys + sizeof(size_t)));
      if (!keys) scr_trap("scriptc: out of memory\n");
      size_t *lens = (size_t *)(keys + n);
      const ScrJsShape *s = shape;
      for (size_t i = n; i-- > 0; s = s->parent) {
        keys[i] = s->key;
        lens[i] = s->key_len;
      }
      owner->fill_lens = lens;
      owner->fill_keys = keys;
    }
    scr_dyn_tier_fill(obj, n, owner->fill_keys, owner->fill_lens, values);
    obj->v.obj.shape = owner;
    return obj;
  }
  const ScrJsShape *s = &scr_js_root;
  for (size_t i = 0; i < n; i++) {
    if (s) s = scr_js_transition(s, keys[i]->data, keys[i]->len);
    if (s) {
      scr_dyn_tier_append(obj, s->key, s->key_len, values[i]);
    } else {
      scr_dyn_key_set(obj, keys[i], values[i]);
      scr_dyn_release(values[i]);
    }
  }
  if (s) {
    obj->v.obj.shape = (ScrJsShape *)s;
    scr_js_ic_add(ic, 0, (ScrJsIcEntry){NULL, s, NULL, NULL, 0});
  }
  return obj;
}

/* ── live record capsules ─────────────────────────────────────────────── */

/* A record compiled by static code reaches dynamic code as a capsule that
 * answers its declared fields from the native record (record ops). Such a
 * receiver has no shape; its site remembers the field a key names per
 * record layout in an entry keyed by the layout's ops table, which no
 * shape pointer can equal. */
static inline size_t scr_js_record_slot(const ScrDynTypedRecordOps *ops, const ScrStr *key,
                                        ScrJsIc *ic) {
  const ScrJsShape *tag = (const ScrJsShape *)(const void *)ops;
  for (uint32_t i = 0; i < ic->count; i++)
    if (ic->entry[i].shape == tag && !ic->entry[i].target) return ic->entry[i].slot;
  size_t index;
  if (!scr_dyn_record_field_index(ops, key, &index)) index = SIZE_MAX;
  scr_js_ic_add(ic, UINT32_MAX, (ScrJsIcEntry){tag, NULL, NULL, NULL, index});
  return index;
}

/* The ops of a record capsule that answers from its native record (no
 * view yet): scr_dyn_typed_ref_live_record, inline. */
static inline const ScrDynTypedRecordOps *scr_js_live_record(const ScrDyn *d) {
  if (!d->v.typed_ref.record || d->v.typed_ref.materialized) return NULL;
  const ScrDynTypedRecordOps *ops = (const ScrDynTypedRecordOps *)(const void *)d->v.typed_ref.array;
  return ops && ops->select ? ops->select(d->v.typed_ref.ptr) : ops;
}

/* +1 value of a present declared field, or NULL. */
static inline ScrDyn *scr_js_record_load(ScrDyn *receiver, const ScrStr *key, ScrJsIc *ic) {
  const ScrDynTypedRecordOps *ops = scr_js_live_record(receiver);
  if (!ops) return NULL;
  size_t index = scr_js_record_slot(ops, key, ic);
  if (index == SIZE_MAX || (!ops->fixed && !ops->has(receiver->v.typed_ref.ptr, index))) return NULL;
  return ops->get(receiver->v.typed_ref.ptr, index);
}

/* A declared field's store into the native record, as the generic [[Set]]
 * of a capsule makes it; false leaves the store to the helper. */
static inline bool scr_js_record_store(ScrDyn *receiver, const ScrStr *key, ScrDyn *value,
                                       ScrJsIc *ic) {
  const ScrDynTypedRecordOps *ops = scr_js_live_record(receiver);
  if (!ops || !ops->set || scr_dyn_typed_ref_is_frozen(receiver)) return false;
  size_t index = scr_js_record_slot(ops, key, ic);
  if (index == SIZE_MAX) return false;
  return ops->set(receiver->v.typed_ref.ptr, index, value) || scr_exc_pending();
}

/* Names an ordinary function answers other than from its own table: its
 * builtin members and Object.prototype's. A site's key is one constant
 * string, so the answer is remembered by the key's bytes. */
static bool scr_js_fn_builtin(const ScrStr *key) {
  static SCR_TL struct {
    const char *data;
    size_t len;
    bool builtin;
  } memo[64];
  size_t slot = ((uintptr_t)key->data >> 4) & 63;
  if (memo[slot].data == key->data && memo[slot].len == key->len) return memo[slot].builtin;
  static const struct {
    const char *name;
    size_t len;
  } names[] = {{"name", 4},      {"length", 6}, {"prototype", 9}, {"apply", 5},
               {"call", 4},      {"bind", 4},   {"caller", 6},    {"arguments", 9},
               {"toString", 8},  {"stackTraceLimit", 15}};
  bool builtin = !scr_js_absent_cacheable(key);
  for (size_t i = 0; !builtin && i < sizeof names / sizeof names[0]; i++)
    builtin = key->len == names[i].len && memcmp(key->data, names[i].name, key->len) == 0;
  memo[slot].data = key->data;
  memo[slot].len = key->len;
  memo[slot].builtin = builtin;
  return builtin;
}

/* A read on an ordinary function: an own data property through the site's
 * cache (its table is an ordinary object without a prototype, so the cache
 * also keeps absent answers), else undefined for a name that is no builtin
 * member. NULL leaves the read to the generic path. */
/* A function read's recent answers, by (function, key): `table` and its
 * shape when the answer was read, and either a fixed answer (`value`, held:
 * an absent property, or a builtin name or length of a function without
 * a table) or the table entry `slot` holding it. */
typedef struct {
  const ScrClosure *owner;
  const char *key;
  ScrDynThunk thunk;
  const char *name;
  const ScrDyn *table;
  const ScrJsShape *shape;
  ScrDyn *value;
  size_t slot;
} ScrJsFnMemo;
static SCR_TL ScrJsFnMemo scr_js_fn_memo[256];

static ScrJsFnMemo *scr_js_fn_memo_of(const ScrClosure *owner, const ScrStr *key) {
  return &scr_js_fn_memo[(((uintptr_t)owner >> 4) ^ ((uintptr_t)key->data >> 3)) & 255];
}

/* The memo's answer for a plain function whose table (or its absence) is
 * as recorded, +1; NULL otherwise. */
static ScrDyn *scr_js_fn_memo_answer(const ScrDyn *receiver, const ScrClosure *owner, const ScrStr *key) {
  const ScrJsFnMemo *memo = scr_js_fn_memo_of(owner, key);
  if (memo->owner != owner || memo->key != key->data || memo->thunk != receiver->v.fn.thunk ||
      memo->name != receiver->v.fn.name || receiver->v.fn.class_obj)
    return NULL;
  const ScrDyn *table = owner->props ? scr_box_peek_ref(owner->props) : NULL;
  if (table != memo->table) return NULL;
  if (!table) return scr_dyn_retain(memo->value);
  if (table->kind != SCR_DYN_OBJ || table->v.obj.shape != memo->shape || table->prototype || table->null_proto)
    return NULL;
  if (memo->value) return scr_dyn_retain(memo->value);
  const ScrDynEntry *entry = &table->v.obj.entries[memo->slot];
  return entry->accessor ? NULL : scr_dyn_retain(entry->value);
}

static void scr_js_fn_memo_fill(const ScrDyn *receiver, const ScrClosure *owner, const ScrStr *key,
                                const ScrDyn *table, ScrDyn *answer) {
  if (key->rc != SIZE_MAX || receiver->v.fn.class_obj) return;
  ScrJsFnMemo *memo = scr_js_fn_memo_of(owner, key);
  size_t slot = SIZE_MAX;
  const ScrJsShape *shape = NULL;
  if (table) {
    shape = table->v.obj.shape;
    if (!shape || shape == &scr_js_unshaped) return;
    slot = scr_js_shape_find(shape, key->data, key->len);
    /* A present key answers from its entry; an absent one is undefined. */
    if (slot != SIZE_MAX && table->v.obj.entries[slot].value != answer) return;
  }
  ScrDyn *held = slot == SIZE_MAX ? scr_dyn_retain(answer) : NULL;
  scr_dyn_release(memo->value);
  *memo = (ScrJsFnMemo){owner, key->data, receiver->v.fn.thunk, receiver->v.fn.name, table, shape, held, slot};
}

static ScrDyn *scr_js_fn_load(ScrDyn *receiver, const ScrStr *key, ScrJsIc *ic) {
  ScrClosure *owner = scr_closure_identity(receiver->v.fn.clo);
  ScrDyn *remembered = scr_js_fn_memo_answer(receiver, owner, key);
  if (remembered) return remembered;
  bool plain;
  ScrDyn *table = scr_dyn_fn_plain_table(receiver, &plain);
  if (!plain) return NULL;
  bool builtin = scr_js_fn_builtin(key);
  if (table) {
    ScrDyn *answer = scr_js_probe_load(table, key, ic, !builtin);
    if (answer) scr_js_fn_memo_fill(receiver, owner, key, table, answer);
    return answer;
  }
  if (key->len == 4 && memcmp(key->data, "name", 4) == 0) {
    /* The name strings recently read, by the name's address and checked
     * against its text (React reads a component's name for every element
     * it renders). */
    static SCR_TL struct {
      const char *name;
      ScrDyn *value;
    } names[64];
    const char *name = receiver->v.fn.name ? receiver->v.fn.name : "";
    size_t slot = ((uintptr_t)name >> 3) & 63, length = strlen(name);
    const ScrStr *cached = names[slot].name == name ? names[slot].value->v.str : NULL;
    if (!cached || cached->len != length || memcmp(cached->data, name, length) != 0) {
      ScrStr *text = scr_str_new(name, length);
      ScrDyn *value = scr_dyn_new_str(text);
      scr_str_release(text);
      scr_dyn_release(names[slot].value);
      names[slot].name = name;
      names[slot].value = value;
    }
    scr_js_fn_memo_fill(receiver, owner, key, NULL, names[slot].value);
    return scr_dyn_retain(names[slot].value);
  }
  if (key->len == 6 && memcmp(key->data, "length", 6) == 0)
    return scr_dyn_new_num((double)receiver->v.fn.arity);
  if (builtin) return NULL;
  scr_js_fn_memo_fill(receiver, owner, key, NULL, scr_dyn_undefined());
  return scr_dyn_retain(scr_dyn_undefined());
}

/* Receivers other than ordinary objects have no shape: they miss before
 * the probe sets up its frame. */
ScrDyn *scr_js_load_probe(ScrDyn *receiver, const ScrStr *key, ScrJsIc *ic) {
  if (receiver->kind != SCR_DYN_OBJ) return NULL;
  return scr_js_probe_load(receiver, key, ic, false);
}

ScrDyn *scr_js_get_probe(ScrDyn *receiver, const ScrStr *key, ScrJsIc *ic) {
  if (receiver->kind == SCR_DYN_TYPED_REF) return scr_js_record_load(receiver, key, ic);
  if (receiver->kind == SCR_DYN_FUNC) return scr_js_fn_load(receiver, key, ic);
  if (receiver->kind != SCR_DYN_OBJ) return NULL;
  return scr_js_probe_load(receiver, key, ic, true);
}

ScrDyn *scr_js_get_probe_native(ScrDyn *receiver, const ScrStr *key, ScrJsIc *ic) {
  if (receiver->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *field = scr_js_record_load(receiver, key, ic);
    if (field || scr_exc_pending()) return field;
  }
  if (receiver->kind != SCR_DYN_OBJ) return scr_dyn_tier_unshaped_get(receiver, key);
  return scr_js_probe_load(receiver, key, ic, true);
}

/* ── stores ───────────────────────────────────────────────────────────── */

/* The generic store keeps a native Error's fields in sync with these keys
 * of its checked view (scr_json.c's scr_error_sync_slots); caches leave
 * them to it. */
static bool scr_js_error_synced_key(const ScrStr *key) {
  switch (key->len) {
  case 4: return memcmp(key->data, "name", 4) == 0 || memcmp(key->data, "code", 4) == 0;
  case 5: return memcmp(key->data, "cause", 5) == 0 || memcmp(key->data, "stack", 5) == 0;
  case 7: return memcmp(key->data, "message", 7) == 0;
  default: return false;
  }
}

static bool scr_js_replace(ScrDyn *receiver, size_t slot, ScrDyn *value) {
  ScrDynEntry *found = &receiver->v.obj.entries[slot];
  if (found->accessor || !found->writable || found->fenced) return false;
  scr_dyn_region_store(receiver, value);
  ScrDyn *old = found->value;
  found->value = scr_dyn_retain(value);
  scr_dyn_release(old);
  return true;
}

/* Whether an add may skip the generic path's prototype-chain walk: the
 * chain is empty, or one ordinary object that lacks the key and ends it. */
static bool scr_js_add_chain(const ScrDyn *prototype, const ScrJsShape *prototype_shape,
                             const ScrStr *key) {
  if (!prototype) return true;
  return prototype_shape && !prototype->prototype &&
         scr_js_shape_find(prototype_shape, key->data, key->len) == SIZE_MAX;
}

static bool scr_js_append_shaped(ScrDyn *receiver, const ScrJsShape *target, ScrDyn *value) {
  if (receiver->non_extensible) return false;
  scr_dyn_tier_append(receiver, target->key, target->key_len, scr_dyn_retain(value));
  receiver->v.obj.shape = (ScrJsShape *)target;
  return true;
}

/* A store's add or replace on an ordinary shaped object; `ic` (the site's
 * cache) may be NULL for a store whose key varies per call. */
static bool scr_js_store_shaped(ScrDyn *receiver, const ScrStr *key, ScrDyn *value, ScrJsIc *ic) {
  const ScrJsShape *shape = scr_js_shape_of(receiver);
  if (!shape || scr_js_error_synced_key(key)) return false;
  uint32_t stale = UINT32_MAX;
  for (uint32_t i = 0; ic && i < ic->count; i++) {
    const ScrJsIcEntry *entry = &ic->entry[i];
    if (entry->shape != shape) continue;
    if (entry->target == shape) {
      if (scr_js_replace(receiver, entry->slot, value)) return true;
    } else if (receiver->prototype == entry->holder &&
               (!entry->holder || (entry->holder->kind == SCR_DYN_OBJ &&
                                   entry->holder->v.obj.shape == entry->holder_shape &&
                                   !entry->holder->prototype))) {
      if (scr_js_append_shaped(receiver, entry->target, value)) return true;
    }
    stale = i;
    break;
  }
  size_t slot = scr_js_shape_find(shape, key->data, key->len);
  if (slot != SIZE_MAX) {
    const ScrDynEntry *found = &receiver->v.obj.entries[slot];
    if (found->accessor || !found->writable || found->fenced) return false;
    if (ic) scr_js_ic_add(ic, stale, (ScrJsIcEntry){shape, shape, NULL, NULL, slot});
    return scr_js_replace(receiver, slot, value);
  }
  ScrDyn *prototype = receiver->prototype;
  const ScrJsShape *prototype_shape = prototype ? scr_js_shape_of(prototype) : NULL;
  if (!scr_js_add_chain(prototype, prototype_shape, key) || receiver->non_extensible ||
      shape->count >= SCR_JS_SHAPE_MAX)
    return false;
  const ScrJsShape *target = scr_js_transition(shape, key->data, key->len);
  if (!target) return false;
  if (ic)
    scr_js_ic_add(ic, stale, (ScrJsIcEntry){shape, target, prototype, prototype_shape, target->count - 1});
  return scr_js_append_shaped(receiver, target, value);
}

bool scr_js_store_probe(ScrDyn *receiver, const ScrStr *key, ScrDyn *value, ScrJsIc *ic) {
  if (receiver->kind == SCR_DYN_TYPED_REF) return scr_js_record_store(receiver, key, value, ic);
  return scr_js_store_shaped(receiver, key, value, ic);
}

bool scr_js_keyed_store_probe_str(ScrDyn *receiver, const ScrStr *name, ScrDyn *value);

/* `for (k in src) if (hasOwn(src, k) && k !== e1 && ...) dst[k] = src[k]`
 * into a fresh empty `dst`, in one pass: an ordinary shaped `src` whose
 * entries are all enumerable data properties under ordinary names, copied
 * into an ordinary empty `dst` through shape transitions. False, with `dst`
 * untouched, leaves the loop to run as written. */
/* Whether the copy loop over `src` reads each own property once, in entry
 * order, as a plain value that the target can take as an ordinary data
 * property. */
static bool scr_js_copyable_source(ScrDyn *src, ScrDyn *dst) {
  if (src->kind != SCR_DYN_OBJ || dst->kind != SCR_DYN_OBJ || dst->v.obj.len != 0 ||
      dst->prototype || dst->null_proto || dst->non_extensible || src->v.obj.source_identity)
    return false;
  ScrArr *keys = scr_js_for_in_keys(src);
  if (!keys || !scr_js_shape_of(dst)) return false;
  size_t count = src->v.obj.len;
  if (count >= SCR_JS_SHAPE_MAX) return false;
  for (size_t i = 0; i < count; i++) {
    const ScrDynEntry *entry = &src->v.obj.entries[i];
    if (entry->accessor || entry->fenced) return false;
    if (entry->key_len == 9 && memcmp(entry->key, "__proto__", 9) == 0) return false;
    /* The keys an error's native fields mirror (scr_js_error_synced_key). */
    if (entry->key_len >= 4 && entry->key_len <= 7) {
      static const char *const synced[] = {"name", "code", "cause", "stack", "message"};
      for (size_t k = 0; k < 5; k++)
        if (strlen(synced[k]) == entry->key_len && memcmp(synced[k], entry->key, entry->key_len) == 0)
          return false;
    }
  }
  return true;
}

/* `excluded` holds at most a few names, NUL-separated; false past eight. */
static bool scr_js_excluded_names(const ScrStr *excluded, const char **names, size_t *lens, size_t *count) {
  size_t skip = 0;
  for (size_t at = 0; at <= excluded->len;) {
    if (skip == 8) return false;
    const char *end = memchr(excluded->data + at, 0, excluded->len - at);
    size_t len = end ? (size_t)(end - (excluded->data + at)) : excluded->len - at;
    names[skip] = excluded->data + at;
    lens[skip++] = len;
    at += len + 1;
  }
  *count = skip;
  return true;
}


static void scr_js_adopt_memo_fill(ScrJsAdoptMemo *memo, ScrDyn *src, const ScrJsShape *shape,
                                   const ScrStr *excluded) {
  *memo = (ScrJsAdoptMemo){shape, excluded, NULL, 0, false};
  const char *names[8];
  size_t lens[8], skip;
  size_t count = src->v.obj.len;
  if (count >= 64 || !scr_js_excluded_names(excluded, names, lens, &skip)) return;
  if (!scr_js_for_in_keys(src)) return;
  const ScrJsShape *kept = &scr_js_root;
  for (size_t i = 0; i < count; i++) {
    const ScrDynEntry *entry = &src->v.obj.entries[i];
    if (entry->key_len == 9 && memcmp(entry->key, "__proto__", 9) == 0) return;
    if (entry->key_len >= 4 && entry->key_len <= 7) {
      static const char *const synced[] = {"name", "code", "cause", "stack", "message"};
      for (size_t k = 0; k < 5; k++)
        if (strlen(synced[k]) == entry->key_len && memcmp(synced[k], entry->key, entry->key_len) == 0)
          return;
    }
    bool drop = false;
    for (size_t j = 0; !drop && j < skip; j++)
      drop = lens[j] == entry->key_len && memcmp(names[j], entry->key, lens[j]) == 0;
    if (drop) memo->drop |= UINT64_C(1) << i;
    else if (kept) kept = scr_js_transition(kept, entry->key, entry->key_len);
  }
  memo->kept = kept;
  memo->ok = true;
}

/* The copy from an owned source the function never reads again: when
 * nothing else references it, `dst` takes its entries, all of them plain
 * writable data, and drops the excluded ones, which is the copy's result. */
bool scr_js_adopt_own_except(ScrDyn *dst, ScrDyn *src, const ScrStr *excluded) {
  const ScrJsShape *shape = src->rc == 1 && dst->kind == SCR_DYN_OBJ && dst->v.obj.len == 0 &&
                                    excluded->rc == SIZE_MAX
                                ? scr_js_shape_of(src)
                                : NULL;
  if (!shape) return scr_js_copy_own_except(dst, src, excluded);
  ScrJsAdoptMemo *memo = &scr_js_adopt_memos[(((uintptr_t)shape >> 4) ^ ((uintptr_t)excluded >> 3)) &
                                              (SCR_JS_ADOPT_MEMOS - 1)];
  if (memo->shape != shape || memo->excluded != excluded) scr_js_adopt_memo_fill(memo, src, shape, excluded);
  if (!memo->ok) return scr_js_copy_own_except(dst, src, excluded);
  size_t count = src->v.obj.len;
  for (size_t i = 0; i < count; i++) {
    const ScrDynEntry *entry = &src->v.obj.entries[i];
    if (entry->accessor || entry->fenced || !entry->writable || !entry->configurable || !entry->enumerable)
      return scr_js_copy_own_except(dst, src, excluded);
  }
  if (!scr_dyn_tier_adopt_entries(dst, src)) return scr_js_copy_own_except(dst, src, excluded);
  uint64_t drop = memo->drop;
  if (drop) {
    ScrDynEntry *entries = dst->v.obj.entries;
    size_t kept = 0;
    for (size_t i = 0; i < count; i++) {
      ScrDynEntry entry = entries[i];
      if (!(drop >> i & 1)) {
        entries[kept++] = entry;
        continue;
      }
      scr_dyn_tier_slot_key_out(dst, entry.key_len);
      scr_dyn_tier_key_release(entry.key, entry.key_len);
      scr_dyn_release(entry.value);
    }
    memset(&entries[kept], 0, (count - kept) * sizeof *entries);
    dst->v.obj.len = kept;
    dst->v.obj.shape = (ScrJsShape *)memo->kept;
  }
  return true;
}

bool scr_js_copy_own_except(ScrDyn *dst, ScrDyn *src, const ScrStr *excluded) {
  if (!scr_js_copyable_source(src, dst)) return false;
  size_t count = src->v.obj.len;
  const char *names[8];
  size_t lens[8], skip;
  if (!scr_js_excluded_names(excluded, names, lens, &skip)) return false;
  /* No key excluded: the target takes the source's shape and a copy of its
   * entries (each value and shared key held once more). */
  bool clean = !src->null_proto && !src->v.obj.index;
  for (size_t i = 0; clean && i < count; i++) {
    const ScrDynEntry *entry = &src->v.obj.entries[i];
    clean = entry->writable && entry->configurable && entry->enumerable;
    for (size_t j = 0; clean && j < skip; j++)
      clean = !(lens[j] == entry->key_len && memcmp(names[j], entry->key, lens[j]) == 0);
  }
  if (clean && count > 0 && scr_js_shape_of(src) && scr_dyn_tier_clone_entries(dst, src)) return true;
  /* Source keys are distinct, so each kept key appends to the target's
   * shape. */
  const ScrJsShape *shape = scr_js_shape_of(dst);
  bool done = true;
  for (size_t i = 0; done && i < count; i++) {
    const ScrDynEntry *entry = &src->v.obj.entries[i];
    bool kept = true;
    for (size_t j = 0; kept && j < skip; j++)
      kept = !(lens[j] == entry->key_len && memcmp(names[j], entry->key, lens[j]) == 0);
    if (!kept) continue;
    const ScrJsShape *target = scr_js_transition(shape, entry->key, entry->key_len);
    done = target && scr_js_append_shaped(dst, target, entry->value);
    shape = target;
  }
  if (!done) scr_trap("scriptc: internal error: a fresh object refused a shaped copy\n");
  return true;
}

/* A computed store's add or replace on an ordinary object, without a
 * cache: the key varies per call. Array-index names keep the generic path
 * (they order before other keys). */
bool scr_js_keyed_store_probe(ScrDyn *receiver, const ScrDyn *key, ScrDyn *value) {
  if (key->kind != SCR_DYN_STR) return false;
  return scr_js_keyed_store_probe_str(receiver, key->v.str, value);
}

bool scr_js_keyed_store_probe_str(ScrDyn *receiver, const ScrStr *name, ScrDyn *value) {
  if (receiver->kind != SCR_DYN_OBJ) return false;
  uint32_t index;
  if (scr_key_array_index(name->data, name->len, &index)) return false;
  if (name->len == 9 && memcmp(name->data, "__proto__", 9) == 0) return false;
  return scr_js_store_shaped(receiver, name, value, NULL);
}

/* ── keyed loads ──────────────────────────────────────────────────────── */

ScrDyn *scr_js_index_probe(ScrDyn *receiver, double index) {
  /* A native array passed in from typed code answers its elements in
   * place, without forming the index's key string. */
  if (receiver->kind == SCR_DYN_TYPED_REF) return scr_dyn_index_get(receiver, index);
  if (receiver->kind != SCR_DYN_ARR || !(index >= 0) || index >= (double)receiver->v.arr.len)
    return NULL;
  size_t i = (size_t)index;
  if ((double)i != index || !scr_dyn_arr_has_index(receiver, i)) return NULL;
  return scr_dyn_retain(receiver->v.arr.items[i]);
}

ScrDyn *scr_js_keyed_probe(ScrDyn *receiver, const ScrDyn *key, ScrJsIc *ic) {
  if (key->kind == SCR_DYN_NUM) return scr_js_index_probe(receiver, key->v.num);
  if (key->kind != SCR_DYN_STR || receiver->kind != SCR_DYN_OBJ) return NULL;
  const ScrStr *name = key->v.str;
  size_t len = receiver->v.obj.len;
  /* A site past its ways (many keys, as in `row[column]`) asks the shared
   * table by (shape, key bytes): one entry, checked against the slot's key. */
  ScrJsSharedLoad *shared = NULL;
  const ScrJsShape *shape = NULL;
  if (ic->count == SCR_JS_IC_WAYS && (shape = scr_js_shape_of(receiver))) {
    shared = scr_js_shared_load(shape, name);
    if (shared->key == name->data && shared->entry.shape == shape && !shared->entry.target) {
      size_t slot = shared->entry.slot;
      const ScrDynEntry *found = &receiver->v.obj.entries[slot];
      if (slot < len && found->key_len == name->len && scr_key_equal(found->key, name->data, name->len))
        return found->accessor ? NULL : scr_dyn_retain(found->value);
    }
  }
  for (uint32_t i = 0; i < ic->count; i++) {
    size_t slot = ic->entry[i].slot;
    if (slot >= len) continue;
    const ScrDynEntry *found = &receiver->v.obj.entries[slot];
    if (found->key_len == name->len && scr_key_equal(found->key, name->data, name->len))
      return found->accessor ? NULL : scr_dyn_retain(found->value);
  }
  if (!shape && !(shape = scr_js_shape_of(receiver))) return NULL;
  size_t slot = scr_js_entry_find(receiver, name->data, name->len);
  if (slot == SIZE_MAX) return NULL;
  const ScrDynEntry *found = &receiver->v.obj.entries[slot];
  if (found->accessor) return NULL;
  if (shared) *shared = (ScrJsSharedLoad){name->data, (ScrJsIcEntry){shape, NULL, NULL, NULL, slot}};
  scr_js_ic_add(ic, UINT32_MAX, (ScrJsIcEntry){NULL, NULL, NULL, NULL, slot});
  return scr_dyn_retain(found->value);
}
