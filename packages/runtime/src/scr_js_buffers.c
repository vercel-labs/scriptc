/* Mutable ArrayBuffers (t262-dc): the views registry and the operations
 * that change a buffer's length or detach it. Compiled only for a program
 * with the `mutableBuffers` fact (runtime-pack-matrix.mjs
 * OPTIONAL_RUNTIME_SOURCES); the base units reach it through the
 * ScrJsBufferOps table in scr_bytes.h, which scr_js_buffers_arm installs.
 *
 * A resizable buffer reserves its maxByteLength up front, so a view's data
 * pointer stays inside the allocation for as long as the view lives (§2.1
 * of the design): this unit never moves storage that a view can index.
 * Every registered view keeps its declared byte offset and either its
 * declared element count or "length-tracking"; resize, grow and detach
 * recompute each view's length and data pointer, so compiled code that
 * reloads the header after the call (the backend drops !invariant.load for
 * fact programs) sees the new bounds.
 *
 * Registry state is borrowed: a view retains its owner (plus its node), so
 * an owner outlives its views, and the dispose observer drops both. Two
 * open-addressing pointer tables keep the lookups O(1); the views of one
 * owner form a singly linked list for the recompute. */

#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_JS_OBJECT_MODEL

/* The largest byte length ToIndex accepts (2^53-1), as the base runtime
 * uses. */
#define SCR_JS_BUFFER_MAX_INDEX 9007199254740991.0

/* A registered view: its declared offset into the owner's storage and
 * either its element count or SIZE_MAX for a length-tracking view. `oob`
 * is the specification's view-out-of-bounds (or detached) state, which
 * makes every method and the DataView byteLength/byteOffset getters throw. */
typedef struct ScrJsBufferView {
  ScrBytes *view;
  struct ScrJsBufferView *next; /* the owner's list */
  size_t offset;                /* bytes into the owner's storage */
  size_t count;                 /* elements, or SIZE_MAX when tracking */
  size_t width;                 /* bytes per element */
  bool oob;
} ScrJsBufferView;

/* One owner's state: the reserved capacity, whether it may resize or grow,
 * and whether it is detached. */
typedef struct {
  ScrBytes *owner;
  ScrJsBufferView *views;
  size_t capacity; /* reserved bytes: maxByteLength, or the byte length */
  bool resizable;
  bool growable;
  bool detached;
} ScrJsBufferOwner;

typedef struct {
  ScrBytes *view;
  ScrJsBufferView *node;
} ScrJsBufferViewSlot;

static SCR_TL ScrJsBufferOwner *scr_js_buffer_owners;
static SCR_TL size_t scr_js_buffer_owners_capacity, scr_js_buffer_owners_used;
static SCR_TL ScrJsBufferViewSlot *scr_js_buffer_views;
static SCR_TL size_t scr_js_buffer_views_capacity, scr_js_buffer_views_used;

#define SCR_JS_BUFFER_TOMBSTONE ((ScrBytes *)1)
#define SCR_JS_BUFFER_MIN_CAPACITY 64

/* A pointer hash: the low bits of an allocation are aligned away, so they
 * are folded in before the multiply. */
static size_t scr_js_buffer_hash(const void *pointer) {
  uintptr_t key = (uintptr_t)pointer;
  key ^= key >> 4;
  key *= (uintptr_t)0x9e3779b97f4a7c15u;
  key ^= key >> 29;
  return (size_t)key;
}

/* ── owner table ─────────────────────────────────────────────────────── */

static void scr_js_buffer_owners_grow(void);

/* The state of `owner`, optionally created (capacity = its byte length);
 * NULL when the owner was never registered. */
static ScrJsBufferOwner *scr_js_buffer_owner_state(ScrBytes *owner, bool create) {
  if (scr_js_buffer_owners_capacity) {
    size_t mask = scr_js_buffer_owners_capacity - 1;
    for (size_t slot = scr_js_buffer_hash(owner) & mask;; slot = (slot + 1) & mask) {
      ScrJsBufferOwner *entry = &scr_js_buffer_owners[slot];
      if (entry->owner == owner) return entry;
      if (!entry->owner) break;
    }
  }
  if (!create) return NULL;
  if (!scr_js_buffer_owners_capacity ||
      (scr_js_buffer_owners_used + 1) * 2 >= scr_js_buffer_owners_capacity) {
    scr_js_buffer_owners_grow();
  }
  size_t mask = scr_js_buffer_owners_capacity - 1;
  size_t slot = scr_js_buffer_hash(owner) & mask;
  while (scr_js_buffer_owners[slot].owner &&
         scr_js_buffer_owners[slot].owner != SCR_JS_BUFFER_TOMBSTONE) {
    slot = (slot + 1) & mask;
  }
  ScrJsBufferOwner *entry = &scr_js_buffer_owners[slot];
  if (entry->owner != SCR_JS_BUFFER_TOMBSTONE) scr_js_buffer_owners_used++;
  *entry = (ScrJsBufferOwner){0};
  entry->owner = owner;
  entry->capacity = (size_t)scr_bytes_byte_len(owner);
  return entry;
}

static void scr_js_buffer_owners_grow(void) {
  size_t capacity = scr_js_buffer_owners_capacity ? scr_js_buffer_owners_capacity * 2
                                                  : SCR_JS_BUFFER_MIN_CAPACITY;
  ScrJsBufferOwner *slots = calloc(capacity, sizeof *slots);
  if (!slots) scr_trap("scriptc: out of memory\n");
  size_t mask = capacity - 1;
  size_t used = 0;
  for (size_t i = 0; i < scr_js_buffer_owners_capacity; i++) {
    ScrJsBufferOwner *entry = &scr_js_buffer_owners[i];
    if (!entry->owner || entry->owner == SCR_JS_BUFFER_TOMBSTONE) continue;
    size_t slot = scr_js_buffer_hash(entry->owner) & mask;
    while (slots[slot].owner) slot = (slot + 1) & mask;
    slots[slot] = *entry;
    used++;
  }
  free(scr_js_buffer_owners);
  scr_js_buffer_owners = slots;
  scr_js_buffer_owners_capacity = capacity;
  scr_js_buffer_owners_used = used;
}

/* ── view table ──────────────────────────────────────────────────────── */

static void scr_js_buffer_views_grow(void);

static ScrJsBufferViewSlot *scr_js_buffer_view_slot(const ScrBytes *view, bool create) {
  if (scr_js_buffer_views_capacity) {
    size_t mask = scr_js_buffer_views_capacity - 1;
    for (size_t slot = scr_js_buffer_hash(view) & mask;; slot = (slot + 1) & mask) {
      ScrJsBufferViewSlot *entry = &scr_js_buffer_views[slot];
      if (entry->view == view) return entry;
      if (!entry->view) break;
    }
  }
  if (!create) return NULL;
  if (!scr_js_buffer_views_capacity ||
      (scr_js_buffer_views_used + 1) * 2 >= scr_js_buffer_views_capacity) {
    scr_js_buffer_views_grow();
  }
  size_t mask = scr_js_buffer_views_capacity - 1;
  size_t slot = scr_js_buffer_hash(view) & mask;
  while (scr_js_buffer_views[slot].view &&
         scr_js_buffer_views[slot].view != SCR_JS_BUFFER_TOMBSTONE) {
    slot = (slot + 1) & mask;
  }
  ScrJsBufferViewSlot *entry = &scr_js_buffer_views[slot];
  if (entry->view != SCR_JS_BUFFER_TOMBSTONE) scr_js_buffer_views_used++;
  entry->view = (ScrBytes *)view;
  entry->node = NULL;
  return entry;
}

static void scr_js_buffer_views_grow(void) {
  size_t capacity = scr_js_buffer_views_capacity ? scr_js_buffer_views_capacity * 2
                                                 : SCR_JS_BUFFER_MIN_CAPACITY;
  ScrJsBufferViewSlot *slots = calloc(capacity, sizeof *slots);
  if (!slots) scr_trap("scriptc: out of memory\n");
  size_t mask = capacity - 1;
  size_t used = 0;
  for (size_t i = 0; i < scr_js_buffer_views_capacity; i++) {
    ScrJsBufferViewSlot *entry = &scr_js_buffer_views[i];
    if (!entry->view || entry->view == SCR_JS_BUFFER_TOMBSTONE) continue;
    size_t slot = scr_js_buffer_hash(entry->view) & mask;
    while (slots[slot].view) slot = (slot + 1) & mask;
    slots[slot] = *entry;
    used++;
  }
  free(scr_js_buffer_views);
  scr_js_buffer_views = slots;
  scr_js_buffer_views_capacity = capacity;
  scr_js_buffer_views_used = used;
}

static ScrJsBufferView *scr_js_buffer_view_node(const ScrBytes *view) {
  ScrJsBufferViewSlot *slot = scr_js_buffer_view_slot(view, false);
  return slot ? slot->node : NULL;
}

/* Drops a view's slot (a tombstone keeps the probe chains intact). */
static void scr_js_buffer_view_forget(const ScrBytes *view) {
  ScrJsBufferViewSlot *slot = scr_js_buffer_view_slot(view, false);
  if (!slot) return;
  slot->node = NULL;
  slot->view = SCR_JS_BUFFER_TOMBSTONE;
}

/* ── the lengths ─────────────────────────────────────────────────────── */

/* Recomputes every view of `state` from the owner's current byte length.
 * A detached buffer, an out-of-bounds fixed view and a length-tracking view
 * whose offset is past the end all read as length 0 with byteOffset 0
 * (Node's view-out-of-bounds answers), while an in-bounds view keeps its
 * declared offset. */
static void scr_js_buffer_refresh(ScrJsBufferOwner *state) {
  ScrBytes *owner = state->owner;
  size_t bytes = (size_t)scr_bytes_byte_len(owner);
  for (ScrJsBufferView *node = state->views; node; node = node->next) {
    ScrBytes *view = node->view;
    size_t count = 0;
    bool oob;
    if (state->detached) {
      oob = true;
    } else if (node->count == SIZE_MAX) {
      oob = node->offset > bytes;
      if (!oob) count = (bytes - node->offset) / node->width;
    } else {
      oob = node->offset > bytes || node->count > (bytes - node->offset) / node->width;
      if (!oob) count = node->count;
    }
    node->oob = oob;
    view->data = oob ? owner->data : owner->data + node->offset;
    view->len = count;
  }
}

/* ── registration ────────────────────────────────────────────────────── */

/* Records `view` (recomputing its declared shape on a re-register, which
 * scr_bytes_buffer_view performs after it fixes the element kind). */
static void scr_js_buffer_view_register(ScrBytes *view, bool tracking) {
  ScrBytes *owner = view->backing;
  if (!owner) return;
  ScrJsBufferOwner *state = scr_js_buffer_owner_state(owner, true);
  ScrJsBufferViewSlot *slot = scr_js_buffer_view_slot(view, true);
  ScrJsBufferView *node = slot->node;
  if (!node) {
    node = calloc(1, sizeof *node);
    if (!node) scr_trap("scriptc: out of memory\n");
    node->view = view;
    node->next = state->views;
    node->offset = (size_t)(view->data - owner->data);
    state->views = node;
    slot->node = node;
  }
  node->width = scr_bytes_elem_size(view->elem);
  node->count = tracking ? SIZE_MAX : view->len;
  /* A view is built from its owner's current length, so it starts in
   * bounds; the calloc above already zeroed `oob`. */
}

static void scr_js_buffer_owner_forget(ScrBytes *owner) {
  if (!scr_js_buffer_owners_capacity) return;
  size_t mask = scr_js_buffer_owners_capacity - 1;
  for (size_t slot = scr_js_buffer_hash(owner) & mask;; slot = (slot + 1) & mask) {
    ScrJsBufferOwner *entry = &scr_js_buffer_owners[slot];
    if (!entry->owner) return;
    if (entry->owner != owner) continue;
    for (ScrJsBufferView *node = entry->views; node;) {
      ScrJsBufferView *next = node->next;
      scr_js_buffer_view_forget(node->view);
      free(node);
      node = next;
    }
    entry->owner = SCR_JS_BUFFER_TOMBSTONE;
    return;
  }
}

/* The dispose observer (scr_dispose_observers). Only pointer lookups: the
 * object may be any refcounted runtime value. */
static void scr_js_buffer_disposed(void *object) {
  ScrBytes *view = (ScrBytes *)object;
  ScrJsBufferView *node = scr_js_buffer_view_node(view);
  if (node) {
    ScrJsBufferOwner *state =
        scr_js_buffer_owner_state(node->view->backing, false);
    if (state) {
      for (ScrJsBufferView **link = &state->views; *link; link = &(*link)->next) {
        if (*link != node) continue;
        *link = node->next;
        break;
      }
    }
    free(node);
    scr_js_buffer_view_forget(view);
    return;
  }
  scr_js_buffer_owner_forget(view);
}

/* ── queries ─────────────────────────────────────────────────────────── */

static bool scr_js_buffer_view_invalid(const ScrBytes *view) {
  ScrJsBufferView *node = scr_js_buffer_view_node(view);
  if (node) return node->oob;
  ScrBytes *owner = view->backing ? view->backing : (ScrBytes *)view;
  ScrJsBufferOwner *state = scr_js_buffer_owner_state(owner, false);
  return state && state->detached;
}

static bool scr_js_buffer_view_tracks(const ScrBytes *view) {
  ScrJsBufferView *node = scr_js_buffer_view_node(view);
  return node && node->count == SIZE_MAX;
}

static bool scr_js_buffer_owner_detached(const ScrBytes *owner) {
  ScrJsBufferOwner *state = scr_js_buffer_owner_state((ScrBytes *)owner, false);
  return state && state->detached;
}

static bool scr_js_buffer_owner_resizable(const ScrBytes *owner) {
  ScrJsBufferOwner *state = scr_js_buffer_owner_state((ScrBytes *)owner, false);
  return state && state->resizable;
}

static bool scr_js_buffer_owner_growable(const ScrBytes *owner) {
  ScrJsBufferOwner *state = scr_js_buffer_owner_state((ScrBytes *)owner, false);
  return state && state->growable;
}

static double scr_js_buffer_owner_capacity(const ScrBytes *owner, double fallback) {
  ScrJsBufferOwner *state = scr_js_buffer_owner_state((ScrBytes *)owner, false);
  if (state && state->detached) return 0;
  return state ? (double)state->capacity : fallback;
}

/* ── the operations ──────────────────────────────────────────────────── */

/* ToIndex for a buffer length; a negative, Infinity or past-2^53-1 value
 * takes Node's "<label>: Invalid length parameter" RangeError. */
static bool scr_js_buffer_index(double value, const char *label, size_t *out) {
  double index = (value != value) ? 0 : trunc(value);
  if (!(index >= 0) || index > SCR_JS_BUFFER_MAX_INDEX) {
    char message[96];
    int length = snprintf(message, sizeof message, "%s: Invalid length parameter", label);
    scr_throw_error_msg(SCR_ERR_RANGE, message, (size_t)length);
    return false;
  }
  *out = (size_t)index;
  return true;
}

static void scr_js_buffer_brand_error(const char *label, const ScrBytes *owner) {
  char message[160];
  int length = snprintf(message, sizeof message,
                        "Method %s called on incompatible receiver #<%s", label,
                        owner->shared ? "SharedArrayBuffer" : "ArrayBuffer");
  message[length++] = '>';
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)length);
}

static void scr_js_buffer_detached_error(const char *label) {
  char message[160];
  int length = snprintf(message, sizeof message,
                        "Cannot perform %s on a detached ArrayBuffer", label);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)length);
}

/* ArrayBuffer.prototype.transfer / transferToFixedLength (ES2025 25.1.6.7-8):
 * the storage moves by pointer when the new capacity fits the old one, so no
 * view can be left pointing at freed bytes; otherwise it is copied. The old
 * owner ends detached with length 0 and never frees moved storage
 * (`external`). */
static ScrDyn *scr_js_buffer_transfer(ScrBytes *owner, bool has_length, double length,
                                      bool fixed) {
  const char *label = fixed ? "ArrayBuffer.prototype.transferToFixedLength"
                            : "ArrayBuffer.prototype.transfer";
  if (owner->shared) {
    scr_js_buffer_brand_error(label, owner);
    return NULL;
  }
  /* A Buffer pool slab's ArrayBuffer is untransferable: the slab serves
   * every Buffer view it handed out, so Node refuses to detach it. */
  const ScrBytes *storage = owner->backing ? owner->backing : owner;
  if (storage->untransferable) {
    static const char message[] = "ArrayBuffer is not detachable and could not be cloned.";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrJsBufferOwner *state = scr_js_buffer_owner_state(owner, true);
  if (state->detached) {
    scr_js_buffer_detached_error(label);
    return NULL;
  }
  size_t fresh_length;
  if (has_length) {
    if (!scr_js_buffer_index(length, label, &fresh_length)) return NULL;
  } else {
    fresh_length = (size_t)scr_bytes_byte_len(owner);
  }
  bool resizable = state->resizable && !fixed;
  size_t capacity = resizable ? state->capacity : fresh_length;
  if (fresh_length > capacity) {
    /* A resizable destination cannot exceed the old maxByteLength. */
    char message[96];
    int length_text =
        snprintf(message, sizeof message, "%s: Invalid length parameter", label);
    scr_throw_error_msg(SCR_ERR_RANGE, message, (size_t)length_text);
    return NULL;
  }
  size_t old_length = (size_t)scr_bytes_byte_len(owner);
  uint8_t *data;
  if (capacity <= state->capacity) {
    /* Move: the old allocation serves the new buffer. The bytes past the
     * new length are zeroed (a later resize must not expose them), and the
     * old owner stops counting and never frees the storage. */
    data = owner->data;
    if (capacity > fresh_length) memset(data + fresh_length, 0, capacity - fresh_length);
    scr_array_buffers_sub(false, scr_bytes_held(owner));
    scr_bytes_set_held(owner, 0);
    owner->external = true;
  } else {
    data = calloc(capacity ? capacity : 1, 1);
    if (!data) scr_trap("scriptc: out of memory\n");
    size_t copy = fresh_length < old_length ? fresh_length : old_length;
    if (copy) memcpy(data, owner->data, copy);
  }
  ScrBytes *fresh = scr_bytes_take_data(data, capacity);
  fresh->len = fresh_length;
  owner->len = 0;
  state->detached = true;
  scr_js_buffer_refresh(state);
  ScrJsBufferOwner *fresh_state = scr_js_buffer_owner_state(fresh, true);
  fresh_state->capacity = capacity;
  fresh_state->resizable = resizable;
  fresh_state->growable = false;
  ScrDyn *result = scr_array_buffer_from_bytes(fresh);
  scr_bytes_release(fresh);
  return result;
}

/* ArrayBuffer.prototype.resize: the new bytes of a growth and the old bytes
 * of a shrink are zeroed (a shrink then grow must read as zero). */
static bool scr_js_buffer_resize(ScrBytes *owner, double length) {
  static const char label[] = "ArrayBuffer.prototype.resize";
  if (owner->shared) {
    scr_js_buffer_brand_error(label, owner);
    return false;
  }
  ScrJsBufferOwner *state = scr_js_buffer_owner_state(owner, false);
  if (!state || !state->resizable) {
    scr_js_buffer_brand_error(label, owner);
    return false;
  }
  if (state->detached) {
    scr_js_buffer_detached_error(label);
    return false;
  }
  size_t fresh_length;
  if (!scr_js_buffer_index(length, label, &fresh_length)) return false;
  if (fresh_length > state->capacity) {
    char message[96];
    int length_text = snprintf(message, sizeof message, "%s: Invalid length parameter", label);
    scr_throw_error_msg(SCR_ERR_RANGE, message, (size_t)length_text);
    return false;
  }
  size_t old_length = (size_t)scr_bytes_byte_len(owner);
  if (fresh_length > old_length) {
    memset(owner->data + old_length, 0, fresh_length - old_length);
  } else if (old_length > fresh_length) {
    memset(owner->data + fresh_length, 0, old_length - fresh_length);
  }
  owner->len = fresh_length;
  scr_js_buffer_refresh(state);
  return true;
}

/* SharedArrayBuffer.prototype.grow: growth only, with the same zeroing and
 * view recompute. Shared storage is written directly here (scriptc runs the
 * test262 agents single-threaded; a concurrent reader may observe a torn
 * tail byte, which ECMA-262 permits for non-atomic access). */
static bool scr_js_buffer_grow(ScrBytes *owner, double length) {
  static const char label[] = "SharedArrayBuffer.prototype.grow";
  if (!owner->shared) {
    scr_js_buffer_brand_error(label, owner);
    return false;
  }
  ScrJsBufferOwner *state = scr_js_buffer_owner_state(owner, false);
  if (!state || !state->growable) {
    scr_js_buffer_brand_error(label, owner);
    return false;
  }
  size_t fresh_length;
  if (!scr_js_buffer_index(length, label, &fresh_length)) return false;
  size_t old_length = (size_t)scr_bytes_byte_len(owner);
  if (fresh_length < old_length || fresh_length > state->capacity) {
    char message[96];
    int length_text = snprintf(message, sizeof message, "%s: Invalid length parameter", label);
    scr_throw_error_msg(SCR_ERR_RANGE, message, (size_t)length_text);
    return false;
  }
  if (fresh_length > old_length) memset(owner->data + old_length, 0, fresh_length - old_length);
  owner->len = fresh_length;
  scr_js_buffer_refresh(state);
  return true;
}

/* ── construction ────────────────────────────────────────────────────── */

/* `new ArrayBuffer(len, options)` and `new SharedArrayBuffer(len, options)`:
 * ToIndex the length, then GetArrayBufferMaxByteLengthOption, then reserve
 * maxByteLength (Node's "Invalid array buffer length" / "Invalid array
 * buffer max length"). */
static ScrDyn *scr_js_buffer_build(ScrDyn *length_value, ScrDyn *options, bool shared) {
  double length_number;
  if (!scr_dyn_number_coerce_js(length_value, &length_number)) return NULL;
  double length_index = (length_number != length_number) ? 0 : trunc(length_number);
  if (!(length_index >= 0) || length_index > SCR_JS_BUFFER_MAX_INDEX ||
      length_index > (double)(SIZE_MAX / 8)) {
    static const char message[] = "Invalid array buffer length";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return NULL;
  }
  size_t bytes = (size_t)length_index;
  size_t capacity = bytes;
  bool resizable = false;
  if (options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL &&
      scr_dyn_is_object(options)) {
    /* A compiled record in the options position arrives as a typed ref, whose
     * fields only a dynamic view answers. */
    ScrDyn *view = NULL;
    const ScrDyn *source = options;
    if (options->kind == SCR_DYN_TYPED_REF) {
      view = scr_dyn_typed_ref_materialize(options);
      if (!view) return NULL;
      source = view;
    }
    ScrDyn *value = scr_dyn_obj_read(source, "maxByteLength", 13);
    if (view) scr_dyn_release(view);
    if (!value) return NULL; /* the getter threw */
    if (value->kind != SCR_DYN_UNDEF) {
      double max_number;
      bool converted = scr_dyn_number_coerce_js(value, &max_number);
      scr_dyn_release(value);
      if (!converted) return NULL;
      double max_index = (max_number != max_number) ? 0 : trunc(max_number);
      if (!(max_index >= 0) || max_index > SCR_JS_BUFFER_MAX_INDEX ||
          (size_t)max_index < bytes) {
        static const char message[] = "Invalid array buffer max length";
        scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
        return NULL;
      }
      capacity = (size_t)max_index;
      resizable = true;
    } else {
      scr_dyn_release(value);
    }
  }
  uint8_t *data = calloc(capacity ? capacity : 1, 1);
  if (!data) {
    /* Node's CreateByteDataBlock failure: a maxByteLength past what the
     * process can reserve is a RangeError, not a trap. */
    static const char message[] = "Array buffer allocation failed";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return NULL;
  }
  ScrBytes *owner = scr_bytes_take_data(data, capacity);
  owner->len = bytes; /* the reserved bytes past the length read 0 */
  if (shared) scr_bytes_make_shared(owner);
  ScrJsBufferOwner *state = scr_js_buffer_owner_state(owner, true);
  state->capacity = capacity;
  state->resizable = resizable;
  /* Only a maxByteLength makes a SharedArrayBuffer growable: `new
   * SharedArrayBuffer(2, {})` has a fixed length, as in Node. */
  state->growable = shared && resizable;
  ScrDyn *result = scr_array_buffer_from_bytes(owner);
  scr_bytes_release(owner);
  return result;
}

ScrDyn *scr_js_buffer_new_resizable(ScrDyn *length, ScrDyn *options) {
  return scr_js_buffer_build(length, options, false);
}

ScrDyn *scr_js_buffer_new_growable(ScrDyn *length, ScrDyn *options) {
  return scr_js_buffer_build(length, options, true);
}

/* ── the table ───────────────────────────────────────────────────────── */

static const ScrJsBufferOps scr_js_buffer_ops_table = {
  &scr_js_buffer_view_register,
  &scr_js_buffer_disposed,
  &scr_js_buffer_view_invalid,
  &scr_js_buffer_view_tracks,
  &scr_js_buffer_owner_detached,
  &scr_js_buffer_owner_resizable,
  &scr_js_buffer_owner_growable,
  &scr_js_buffer_owner_capacity,
  &scr_js_buffer_transfer,
  &scr_js_buffer_resize,
  &scr_js_buffer_grow,
};

/* arrayBuffer.armMutable, lowered into the top of %main: from here on the
 * base units record every view and consult the registry. Idempotent. */
void scr_js_buffers_arm(void) {
  if (scr_js_buffer_ops == &scr_js_buffer_ops_table) return;
  scr_js_buffer_ops = &scr_js_buffer_ops_table;
  scr_js_dispose_hook_install();
}

#endif /* SCR_JS_OBJECT_MODEL */
