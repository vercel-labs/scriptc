/* scriptc runtime — the dynamic tier's inline caches (scr_js.h; two-tier
 * design stage S4).
 *
 * Caches key on object layouts (scr_dyn.h): a layout-mode object's layout
 * proves which key sits at each slot and which keys the object lacks, and
 * every property of such an object is a writable data property, so a hit
 * tests the layout word and, for prototype hits, the prototype pointer.
 * Dictionary-mode objects (layout NULL) never hit and take the generic
 * paths.
 *
 * Linked only into programs with dynamic-tier code (the dynTier runtime
 * feature). */
#include "scr_js.h"
#include "scr_key.h"

#include <stdlib.h>
#include <string.h>

/* The compiler's inline cache tests read these in place (64-bit targets;
 * backend/llvm/js-ic.ts). */
#if SCR_JS_IMMEDIATES
_Static_assert(offsetof(ScrDyn, kind) == 8, "kind offset");
_Static_assert(offsetof(ScrDyn, v.obj.len) == 16 && offsetof(ScrDyn, v.obj.slots) == 32 &&
               offsetof(ScrDyn, v.obj.layout) == 80, "object slot offsets");
_Static_assert(offsetof(ScrDyn, v.arr.len) == 16 && offsetof(ScrDyn, v.arr.items) == 32 &&
               offsetof(ScrDyn, v.arr.presence) == 56, "array element offsets");
_Static_assert(offsetof(ScrDyn, prototype) == 96, "prototype offset");
_Static_assert(sizeof(ScrJsIcEntry) == 40 && sizeof(ScrJsIc) == 168, "cache layout");
#endif

/* The cache records that hold entries. Entries name layouts and prototype
 * objects, so the reset of a thread's runtime state (which frees its
 * layouts) also clears these records: a library's next session runs the
 * same sites with the same records. */
static SCR_TL ScrJsIc **scr_js_filled_ics;
static SCR_TL size_t scr_js_filled_count;
static SCR_TL size_t scr_js_filled_capacity;
static SCR_TL bool scr_js_ics_registered;

/* The second-level cache of load sites whose own record is full: one entry
 * per (receiver layout, key bytes) slot, filled by the probe and checked
 * like a site entry. It names layouts, so the reset clears it. */
#define SCR_JS_SHARED_LOADS 2048
typedef struct ScrJsSharedLoad {
  const char *key;
  ScrJsIcEntry entry;
} ScrJsSharedLoad;
static SCR_TL ScrJsSharedLoad *scr_js_shared_loads;

static void scr_js_ics_reset(void) {
  for (size_t i = 0; i < scr_js_filled_count; i++)
    memset(scr_js_filled_ics[i], 0, sizeof *scr_js_filled_ics[i]);
  free(scr_js_shared_loads);
  scr_js_shared_loads = NULL;
  free(scr_js_filled_ics);
  scr_js_filled_ics = NULL;
  scr_js_filled_count = 0;
  scr_js_filled_capacity = 0;
  scr_js_ics_registered = false;
}

/* An object's layout, or NULL for objects caches leave alone: other kinds,
 * dictionary-mode objects (immortal objects, which threads share, are
 * always in dictionary mode), and the builtin Object.prototype. */
static inline const ScrLayout *scr_js_layout_of(const ScrDyn *object) {
  if (object->kind != SCR_DYN_OBJ || object->rc == SIZE_MAX) return NULL;
  const ScrLayout *layout = object->v.obj.layout;
  if (!layout || object == scr_dyn_tier_object_prototype()) return NULL;
  return layout;
}

/* The slot of `key` in an object of layout `layout`, or SIZE_MAX. */
static size_t scr_js_layout_find(const ScrLayout *layout, const char *key, size_t key_len) {
  uint32_t slot = scr_layout_find(layout, key, key_len);
  return slot == UINT32_MAX ? SIZE_MAX : slot;
}

/* Fills a cache entry: `stale` (a matching entry whose hit failed) when
 * there is one, else a free or replaceable one. */
static void scr_js_ic_add(ScrJsIc *ic, uint32_t stale, ScrJsIcEntry entry) {
  if (ic->count == 0) {
    if (!scr_js_ics_registered) {
      scr_js_ics_registered = true;
      scr_atexit(scr_js_ics_reset);
    }
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

/* The cached answer of an entry whose receiver layout matched, or NULL. */
static ScrDyn *scr_js_load_hit(ScrDyn *receiver, const ScrJsIcEntry *entry) {
  const ScrDyn *holder = receiver;
  if (entry->target) {
    holder = entry->holder;
    if (receiver->prototype != holder || holder->kind != SCR_DYN_OBJ ||
        holder->v.obj.layout != entry->target)
      return NULL;
  }
  return scr_dyn_retain(holder->v.obj.slots[entry->slot]);
}

/* An absent entry: its target is this tag and its holder is a placeholder
 * that is never a prototype, so the inline test of entry 0 in compiled code
 * (a prototype hit needs the receiver's prototype to be the holder) always
 * sends such a receiver to the probe. Its holder_layout and slot name the
 * one prototype the read walked past (layout and object), or NULL and 0 when
 * the receiver had no prototype. */
static const ScrLayout scr_js_absent;
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

static ScrJsSharedLoad *scr_js_shared_load(const ScrLayout *shape, const ScrStr *key) {
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
         walked->v.obj.layout == entry->holder_layout && walked->prototype == NULL;
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

/* A load site's probe. With `absent`, a read of a key that the receiver and
 * its chain of plain shaped objects (ending in the default prototype) lack
 * answers undefined and caches that answer. Method reads leave absent
 * methods to the slow path, which names the missing function. */
static __attribute__((noinline)) ScrDyn *scr_js_probe_load(ScrDyn *receiver, const ScrStr *key,
                                                            ScrJsIc *ic, bool absent) {
  const ScrLayout *shape = scr_js_layout_of(receiver);
  if (!shape) return NULL;
  uint32_t stale = UINT32_MAX;
  for (uint32_t i = 0; i < ic->count; i++) {
    if (ic->entry[i].layout != shape) continue;
    ScrDyn *value = scr_js_entry_answer(receiver, &ic->entry[i]);
    if (value) return value;
    if (stale == UINT32_MAX) stale = i;
  }
  ScrJsSharedLoad *shared = NULL;
  if (ic->count == SCR_JS_IC_WAYS) {
    shared = scr_js_shared_load(shape, key);
    if (shared->key == key->data && shared->entry.layout == shape &&
        (absent || shared->entry.target != &scr_js_absent)) {
      ScrDyn *value = scr_js_entry_answer(receiver, &shared->entry);
      if (value) return value;
    }
  }
  size_t slot = scr_js_layout_find(shape, key->data, key->len);
  if (slot != SIZE_MAX) {
    scr_js_load_fill(ic, stale, shared, key, (ScrJsIcEntry){shape, NULL, NULL, NULL, slot});
    return scr_dyn_retain(receiver->v.obj.slots[slot]);
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
  const ScrLayout *holder_shape = scr_js_layout_of(holder);
  if (!holder_shape) return NULL;
  slot = scr_js_layout_find(holder_shape, key->data, key->len);
  if (slot == SIZE_MAX) {
    if (!absent || holder->prototype != NULL) return NULL;
    scr_js_load_fill(ic, stale, shared, key,
                     (ScrJsIcEntry){shape, &scr_js_absent, &scr_js_absent_holder, holder_shape,
                                    (size_t)holder});
    return scr_dyn_retain(scr_dyn_undefined());
  }
  scr_js_load_fill(ic, stale, shared, key, (ScrJsIcEntry){shape, holder_shape, holder, NULL, slot});
  return scr_dyn_retain(holder->v.obj.slots[slot]);
}

/* Receivers other than ordinary objects have no layout: they miss before
 * the probe sets up its frame. */
ScrDyn *scr_js_load_probe(ScrDyn *receiver, const ScrStr *key, ScrJsIc *ic) {
  if (receiver->kind != SCR_DYN_OBJ) return NULL;
  return scr_js_probe_load(receiver, key, ic, false);
}

ScrDyn *scr_js_get_probe(ScrDyn *receiver, const ScrStr *key, ScrJsIc *ic) {
  if (receiver->kind != SCR_DYN_OBJ) return NULL;
  return scr_js_probe_load(receiver, key, ic, true);
}

ScrDyn *scr_js_get_probe_native(ScrDyn *receiver, const ScrStr *key, ScrJsIc *ic) {
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
  scr_dyn_region_store(receiver, value);
  ScrDyn **found = &receiver->v.obj.slots[slot];
  ScrDyn *old = *found;
  *found = scr_dyn_retain(value);
  scr_dyn_release(old);
  return true;
}

/* Whether an add may skip the generic path's prototype-chain walk: the
 * chain is empty, or one ordinary object that lacks the key and ends it. */
static bool scr_js_add_chain(const ScrDyn *prototype, const ScrLayout *prototype_shape,
                             const ScrStr *key) {
  if (!prototype) return true;
  return prototype_shape && !prototype->prototype &&
         scr_js_layout_find(prototype_shape, key->data, key->len) == SIZE_MAX;
}

static bool scr_js_append_shaped(ScrDyn *receiver, const ScrLayout *target, ScrDyn *value) {
  if (receiver->non_extensible) return false;
  scr_dyn_tier_append(receiver, target, scr_dyn_retain(value));
  return true;
}

bool scr_js_store_probe(ScrDyn *receiver, const ScrStr *key, ScrDyn *value, ScrJsIc *ic) {
  const ScrLayout *shape = scr_js_layout_of(receiver);
  if (!shape || scr_js_error_synced_key(key)) return false;
  uint32_t stale = UINT32_MAX;
  for (uint32_t i = 0; i < ic->count; i++) {
    const ScrJsIcEntry *entry = &ic->entry[i];
    if (entry->layout != shape) continue;
    if (entry->target == shape) {
      if (scr_js_replace(receiver, entry->slot, value)) return true;
    } else if (receiver->prototype == entry->holder &&
               (!entry->holder || (entry->holder->kind == SCR_DYN_OBJ &&
                                   entry->holder->v.obj.layout == entry->holder_layout &&
                                   !entry->holder->prototype))) {
      if (scr_js_append_shaped(receiver, entry->target, value)) return true;
    }
    stale = i;
    break;
  }
  size_t slot = scr_js_layout_find(shape, key->data, key->len);
  if (slot != SIZE_MAX) {
    scr_js_ic_add(ic, stale, (ScrJsIcEntry){shape, shape, NULL, NULL, slot});
    return scr_js_replace(receiver, slot, value);
  }
  ScrDyn *prototype = receiver->prototype;
  const ScrLayout *prototype_shape = prototype ? scr_js_layout_of(prototype) : NULL;
  if (!scr_js_add_chain(prototype, prototype_shape, key) || receiver->non_extensible) return false;
  const ScrLayout *target = scr_layout_add(shape, key->data, key->len);
  if (!target) return false;
  scr_js_ic_add(ic, stale, (ScrJsIcEntry){shape, target, prototype, prototype_shape, target->count - 1});
  return scr_js_append_shaped(receiver, target, value);
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
  const ScrLayout *shape = scr_js_layout_of(receiver);
  if (!shape) return NULL;
  size_t len = receiver->v.obj.len;
  for (uint32_t i = 0; i < ic->count; i++) {
    size_t slot = ic->entry[i].slot;
    if (slot >= len) continue;
    const ScrLayoutKey *found = &shape->keys[slot];
    if (found->len == name->len && scr_key_equal(found->key, name->data, name->len))
      return scr_dyn_retain(receiver->v.obj.slots[slot]);
  }
  size_t slot = scr_js_layout_find(shape, name->data, name->len);
  if (slot == SIZE_MAX) return NULL;
  scr_js_ic_add(ic, UINT32_MAX, (ScrJsIcEntry){NULL, NULL, NULL, NULL, slot});
  return scr_dyn_retain(receiver->v.obj.slots[slot]);
}
