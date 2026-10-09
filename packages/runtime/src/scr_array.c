#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SCR_ARR_MAX_LENGTH ((size_t)UINT32_MAX)
#define SCR_ARR_MAX_INDEX (SCR_ARR_MAX_LENGTH - 1)
/* Keep the packed representation proportional to the populated elements.
 * Indices below this cutoff always grow dense storage geometrically. Above
 * it, dense storage grows only when the new range stays populated: a
 * contiguous extension of a full dense prefix (appends and forward fills),
 * a bulk range write (fill, push, splice, unshift), or a sorted sparse tail
 * that has become dense enough for packed slots to cost at most about twice
 * its side-store memory. Genuinely sparse indices keep the sorted side store,
 * so a single write near 2^32 never allocates the intervening range. */
#define SCR_ARR_DENSE_LIMIT ((size_t)1 << 20)
/* Writes this far past a full dense prefix extend dense storage, matching
 * the gap V8 tolerates before falling back to dictionary elements. */
#define SCR_ARR_DENSE_GAP ((size_t)1024)

/* Live heap-array count for the RC audit lane (-DSCR_RC_AUDIT); same
 * contract as scr_str_live_count in scr_string.c. */
#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_arrays = 0;
long scr_arr_live_count(void) { return scr_live_arrays; }
#endif

static void scr_arr_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* Canonical array indices grow indexed storage and may leave holes. Negative,
 * fractional, NaN, infinity, and 2^32-1 numeric keys use the ordinary
 * property vector; only a missing property or a low-level read of a hole
 * reaches the proven-accessor trap. */
static void scr_arr_trap_oob(double i, size_t len) {
  char buf[32];
  scr_f64_to_str(i, buf);
  scr_trap_fmt("scriptc: RangeError: array index %s out of bounds (length %zu)\n",
               buf, len);
}

/* Validate i as a canonical JavaScript array index after the caller has
 * dispatched noncanonical numeric keys to ordinary property storage. */
static size_t scr_arr_check_index(const ScrArr *a, double i, bool allow_append) {
  const double max_index = (double)SCR_ARR_MAX_INDEX;
  if (!(i >= 0) || i != trunc(i) || i > max_index ||
      (!allow_append && i >= (double)a->len)) {
    scr_arr_trap_oob(i, a->len);
  }
  return (size_t)i;
}

static bool scr_arr_valid_index(double i, size_t *out) {
  if (!(i >= 0) || i != trunc(i) || i > (double)SCR_ARR_MAX_INDEX) return false;
  *out = (size_t)i;
  return true;
}

static size_t scr_arr_prop_index(const ScrArr *a, const char *key,
                                 size_t key_len) {
  for (size_t i = 0; i < a->prop_len; i++) {
    if (a->props[i].key_len == key_len &&
        memcmp(a->props[i].key, key, key_len) == 0) {
      return i;
    }
  }
  return SIZE_MAX;
}

static size_t scr_arr_prop_key(double i, char *buf) {
  return scr_f64_to_str(i, buf);
}

static void scr_arr_grow_props(ScrArr *a, size_t need) {
  if (need <= a->prop_cap) return;
  size_t cap = a->prop_cap ? a->prop_cap : 4;
  while (cap < need) {
    if (cap > SIZE_MAX / 2 / sizeof(*a->props)) scr_arr_oom();
    cap *= 2;
  }
  ScrArrProp *props = realloc(a->props, cap * sizeof(*props));
  if (!props) scr_arr_oom();
  a->props = props;
  a->prop_cap = cap;
}

/* ── slot packing: 8-byte slots hold doubles, bools, or pointers ───────── */

static uint64_t scr_slot_from_f64(double v) {
  uint64_t s;
  memcpy(&s, &v, sizeof s);
  return s;
}

static double scr_slot_to_f64(uint64_t s) {
  double v;
  memcpy(&v, &s, sizeof v);
  return v;
}

static uint64_t scr_slot_from_ptr(void *p) { return (uint64_t)(uintptr_t)p; }

static void *scr_slot_to_ptr(uint64_t s) { return (void *)(uintptr_t)s; }

static bool scr_elem_is_ref(ScrElemKind k) {
  return k == SCR_ELEM_STR || k == SCR_ELEM_ARR || k == SCR_ELEM_BYTES ||
         k == SCR_ELEM_REF;
}

static void scr_elem_release(const ScrArr *a, uint64_t slot) {
  void *p = scr_slot_to_ptr(slot);
  if (!p) return;
  if (a->elem == SCR_ELEM_STR) scr_str_release((ScrStr *)p);
  else if (a->elem == SCR_ELEM_ARR) scr_arr_release((ScrArr *)p);
  else if (a->elem == SCR_ELEM_BYTES) scr_bytes_release((ScrBytes *)p);
  else if (a->elem == SCR_ELEM_REF) a->elem_release(p);
}

static uint64_t scr_elem_retain_slot(const ScrArr *a, uint64_t slot) {
  if (!scr_elem_is_ref(a->elem)) return slot;
  void *p = scr_slot_to_ptr(slot);
  if (!p) return slot;
  if (a->elem == SCR_ELEM_STR) p = scr_str_retain((ScrStr *)p);
  else if (a->elem == SCR_ELEM_ARR) p = scr_arr_retain((ScrArr *)p);
  else if (a->elem == SCR_ELEM_BYTES) p = scr_bytes_retain((ScrBytes *)p);
  else p = a->elem_retain(p);
  return scr_slot_from_ptr(p);
}

static uint64_t scr_arr_retain_state_slot(const ScrArr *a, uint64_t slot,
                                          uint8_t state) {
  return state == SCR_ARR_VALUE ? scr_elem_retain_slot(a, slot) : 0;
}

/* ── storage and lifecycle ─────────────────────────────────────────────── */

typedef struct {
  uint64_t *data;
  uint8_t *present;
  size_t cap;
  ScrArrSparseSlot *sparse;
  size_t sparse_len;
  size_t sparse_cap;
} ScrArrStorage;

static size_t scr_arr_sparse_lower_bound(const ScrArrSparseSlot *slots,
                                         size_t n, size_t index) {
  size_t lo = 0, hi = n;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    if (slots[mid].index < index) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* The sorted side store is a deque. Its allocation holds `front` spare slots,
 * one header slot whose index records `front`, then sparse_cap slots starting
 * at a->sparse (live entries first). The header sits directly before
 * a->sparse, so every owner of the pointer (including swapped or detached
 * storage) can recover the allocation base. Inserts and removals move only
 * the shorter side, so ascending and descending first-touch writes and prefix
 * migration into dense storage are amortized O(1). */
static size_t scr_arr_sparse_front(const ScrArrSparseSlot *slots) {
  return slots ? slots[-1].index : 0;
}

static void scr_arr_sparse_free(ScrArrSparseSlot *slots) {
  if (slots) free(slots - 1 - slots[-1].index);
}

static size_t scr_arr_sparse_grow_cap(size_t have, size_t need) {
  size_t cap = have ? have : 4;
  while (cap < need) {
    if (cap > SIZE_MAX / 4 / sizeof(ScrArrSparseSlot)) scr_arr_oom();
    cap *= 2;
  }
  return cap;
}

/* Reallocate with `front` spare slots before the live entries and `back`
 * slots from the first live entry onward (back >= sparse_len). */
static void scr_arr_sparse_realloc(ScrArr *a, size_t front, size_t back) {
  const size_t unit = sizeof(ScrArrSparseSlot);
  if (front > SIZE_MAX / unit / 2 || back > SIZE_MAX / unit / 2) scr_arr_oom();
  size_t total = (front + 1 + back) * unit;
  ScrArrSparseSlot *slots;
  if (a->sparse && front == scr_arr_sparse_front(a->sparse)) {
    ScrArrSparseSlot *base = realloc(a->sparse - 1 - front, total);
    if (!base) scr_arr_oom();
    slots = base + front + 1;
  } else {
    ScrArrSparseSlot *base = malloc(total);
    if (!base) scr_arr_oom();
    slots = base + front + 1;
    if (a->sparse_len) memcpy(slots, a->sparse, a->sparse_len * unit);
    scr_arr_sparse_free(a->sparse);
  }
  slots[-1] = (ScrArrSparseSlot){front, 0, 0};
  a->sparse = slots;
  a->sparse_cap = back;
}

static void scr_arr_grow_sparse(ScrArr *a, size_t need) {
  if (need <= a->sparse_cap) return;
  scr_arr_sparse_realloc(a, scr_arr_sparse_front(a->sparse),
                         scr_arr_sparse_grow_cap(a->sparse_cap, need));
}

static void scr_arr_sparse_insert(ScrArr *a, size_t pos, ScrArrSparseSlot entry) {
  size_t len = a->sparse_len;
  if (pos < len - pos) {
    if (scr_arr_sparse_front(a->sparse) == 0) {
      scr_arr_sparse_realloc(a, len > 4 ? len : 4, a->sparse_cap);
    }
    size_t front = scr_arr_sparse_front(a->sparse);
    ScrArrSparseSlot *slots = a->sparse - 1; /* the old header slot */
    slots[-1] = (ScrArrSparseSlot){front - 1, 0, 0};
    memmove(slots, a->sparse, pos * sizeof(*slots));
    slots[pos] = entry;
    a->sparse = slots;
    a->sparse_cap++;
  } else {
    scr_arr_grow_sparse(a, len + 1);
    memmove(a->sparse + pos + 1, a->sparse + pos, (len - pos) * sizeof(*a->sparse));
    a->sparse[pos] = entry;
  }
  a->sparse_len = len + 1;
}

static void scr_arr_sparse_remove(ScrArr *a, size_t pos) {
  size_t len = a->sparse_len;
  if (pos < len - 1 - pos) {
    size_t front = scr_arr_sparse_front(a->sparse);
    memmove(a->sparse + 1, a->sparse, pos * sizeof(*a->sparse));
    a->sparse[0] = (ScrArrSparseSlot){front + 1, 0, 0};
    a->sparse++;
    a->sparse_cap--;
  } else {
    memmove(a->sparse + pos, a->sparse + pos + 1, (len - pos - 1) * sizeof(*a->sparse));
  }
  a->sparse_len = len - 1;
}

/* Drop the first `count` live entries after the caller moved them out. */
static void scr_arr_sparse_drop_prefix(ScrArr *a, size_t count) {
  if (count == 0) return;
  size_t front = scr_arr_sparse_front(a->sparse);
  a->sparse[count - 1] = (ScrArrSparseSlot){front + count, 0, 0};
  a->sparse += count;
  a->sparse_cap -= count;
  a->sparse_len -= count;
}

/* Grow dense storage to cover at least [0, need). Callers decide whether the
 * range is populated enough (scr_arr_dense_ok); this only allocates. Sparse
 * entries below the new capacity move into the packed slots, preserving the
 * invariant every reader (including emitted code) relies on: indices below
 * cap live in dense storage and sparse entries all lie at or above cap. */
static void scr_arr_grow_dense_to(ScrArr *a, size_t need, bool exact) {
  if (need <= a->cap) return;
  if (need > SCR_ARR_MAX_LENGTH) scr_arr_oom();
  size_t cap = a->cap ? a->cap : 4;
  while (cap < need) {
    /* Double below the cutoff; grow by half above it to bound overshoot. */
    size_t step = cap < SCR_ARR_DENSE_LIMIT ? cap : cap / 2;
    cap = cap > SCR_ARR_MAX_LENGTH - step ? SCR_ARR_MAX_LENGTH : cap + step;
  }
  if (need <= SCR_ARR_DENSE_LIMIT && cap > SCR_ARR_DENSE_LIMIT) cap = SCR_ARR_DENSE_LIMIT;
  /* Densifying an arbitrary sparse tail sizes to the populated span; only
   * appends benefit from geometric headroom. */
  if (exact && need > SCR_ARR_DENSE_LIMIT) cap = need;
  /* Values and states share one allocation. Move the old states before
   * publishing the larger capacity: their previous location is now part
   * of the value area. Existing data and state pointers keep their ABI. */
  if (cap > SIZE_MAX / (sizeof(uint64_t) + sizeof(uint8_t))) scr_arr_oom();
  uint64_t *data = scr_mem_realloc(a->data, cap * (sizeof(uint64_t) + sizeof(uint8_t)));
  if (!data) scr_arr_oom();
  uint8_t *present = (uint8_t *)(data + cap);
  if (a->cap) memmove(present, (uint8_t *)(data + a->cap), a->cap);
  memset(present + a->cap, 0, cap - a->cap);
  a->data = data;
  a->present = present;
  a->cap = cap;
  size_t moved = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, cap);
  for (size_t i = 0; i < moved; i++) {
    a->data[a->sparse[i].index] = a->sparse[i].slot;
    a->present[a->sparse[i].index] = a->sparse[i].state;
  }
  scr_arr_sparse_drop_prefix(a, moved);
}

static void scr_arr_grow_dense(ScrArr *a, size_t need) {
  scr_arr_grow_dense_to(a, need, false);
}

/* Is the top of the dense prefix populated like an append or forward fill?
 * Samples at most SCR_ARR_DENSE_GAP states, and only when a write lands
 * within that gap past capacity. */
static bool scr_arr_dense_tail_populated(const ScrArr *a) {
  size_t window = a->cap < SCR_ARR_DENSE_GAP ? a->cap : SCR_ARR_DENSE_GAP;
  if (window == 0 || a->present[a->cap - 1] == SCR_ARR_HOLE) return false;
  size_t populated = 0;
  for (size_t i = a->cap - window; i < a->cap; i++) populated += a->present[i] != SCR_ARR_HOLE;
  return populated * 16 >= window * 3;
}

/* May dense storage cover [0, need) when `added` new elements are about to be
 * written beyond the current capacity? Below the cutoff always; above it,
 * only when the packed slots between max(cap, cutoff) and need would be at
 * least 3/16 populated by those elements plus the sparse entries they would
 * absorb. At that density 9 bytes per packed slot cost at most twice the
 * 24-byte sparse entries, so memory stays proportional to populated
 * elements while sorted side-store inserts stop dominating. */
static bool scr_arr_dense_ok(const ScrArr *a, size_t need, size_t added) {
  if (need <= a->cap || need <= SCR_ARR_DENSE_LIMIT) return true;
  size_t base = a->cap > SCR_ARR_DENSE_LIMIT ? a->cap : SCR_ARR_DENSE_LIMIT;
  uint64_t span = (uint64_t)(need - base);
  uint64_t populated = (uint64_t)a->sparse_len + (uint64_t)added;
  return populated * 16 >= span * 3;
}

static void scr_arr_grow_for_index(ScrArr *a, size_t index) {
  if (index < a->cap) return;
  if (index < SCR_ARR_DENSE_LIMIT) {
    scr_arr_grow_dense(a, index + 1);
    return;
  }
  /* Contiguous extension: appends and forward indexed fills write just past
   * a populated dense prefix. */
  if (index - a->cap < SCR_ARR_DENSE_GAP && scr_arr_dense_tail_populated(a)) {
    scr_arr_grow_dense(a, index + 1);
    return;
  }
  /* Densify the whole sparse tail once it is populated enough. */
  size_t need = index + 1;
  if (a->sparse_len > 0 && a->sparse[a->sparse_len - 1].index >= need) {
    need = a->sparse[a->sparse_len - 1].index + 1;
  }
  if (scr_arr_dense_ok(a, need, 1)) scr_arr_grow_dense_to(a, need, true);
}

static uint8_t scr_arr_state_at_storage(const ScrArrStorage *s, size_t index,
                                         uint64_t *out) {
  if (index < s->cap) {
    if (s->present[index] == SCR_ARR_HOLE) return SCR_ARR_HOLE;
    if (out) *out = s->data[index];
    return s->present[index];
  }
  size_t pos = scr_arr_sparse_lower_bound(s->sparse, s->sparse_len, index);
  if (pos == s->sparse_len || s->sparse[pos].index != index) return SCR_ARR_HOLE;
  if (out) *out = s->sparse[pos].slot;
  return s->sparse[pos].state;
}

static bool scr_arr_slot_at_storage(const ScrArrStorage *s, size_t index,
                                    uint64_t *out) {
  return scr_arr_state_at_storage(s, index, out) != SCR_ARR_HOLE;
}

static bool scr_arr_slot_at(const ScrArr *a, size_t index, uint64_t *out) {
  ScrArrStorage s = {
      a->data, a->present, a->cap, a->sparse, a->sparse_len, a->sparse_cap};
  return scr_arr_slot_at_storage(&s, index, out);
}

static uint8_t scr_arr_state_at(const ScrArr *a, size_t index, uint64_t *out) {
  ScrArrStorage s = {
      a->data, a->present, a->cap, a->sparse, a->sparse_len, a->sparse_cap};
  return scr_arr_state_at_storage(&s, index, out);
}

/* Store an owned slot into an empty index. The caller has already established
 * the destination length and does not need a retain. */
static void scr_arr_store_state_owned(ScrArr *a, size_t index, uint64_t slot,
                                      uint8_t state) {
  scr_arr_grow_for_index(a, index);
  if (index < a->cap) {
    a->data[index] = slot;
    a->present[index] = state;
    return;
  }
  size_t pos = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, index);
  if (pos < a->sparse_len && a->sparse[pos].index == index) {
    a->sparse[pos].slot = slot;
    a->sparse[pos].state = state;
    return;
  }
  scr_arr_sparse_insert(a, pos, (ScrArrSparseSlot){index, slot, state});
}

static void scr_arr_store_owned(ScrArr *a, size_t index, uint64_t slot) {
  scr_arr_store_state_owned(a, index, slot, SCR_ARR_VALUE);
}

static bool scr_arr_take_state(ScrArr *a, size_t index, uint64_t *out,
                               uint8_t *state_out) {
  if (index < a->cap) {
    uint8_t state = a->present[index];
    if (state == SCR_ARR_HOLE) return false;
    *out = a->data[index];
    a->present[index] = SCR_ARR_HOLE;
    a->data[index] = 0;
    if (state_out) *state_out = state;
    return true;
  }
  size_t pos = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, index);
  if (pos == a->sparse_len || a->sparse[pos].index != index) return false;
  *out = a->sparse[pos].slot;
  if (state_out) *state_out = a->sparse[pos].state;
  scr_arr_sparse_remove(a, pos);
  return true;
}

/* Overwrite an index in place, then release the previous value. Publish the
 * new edge before releasing the old one: a release can collect cycles. Holes
 * have uninitialized data and must not be read. An existing sparse entry is
 * updated where it sits, so rewriting a large sparse array costs one binary
 * search per write rather than a delete-and-reinsert of the sorted tail. */
static void scr_arr_replace_state_owned(ScrArr *a, size_t index, uint64_t slot,
                                        uint8_t state) {
  uint8_t old_state;
  uint64_t old = 0;
  if (index < a->cap) {
    old_state = a->present[index];
    if (old_state == SCR_ARR_VALUE) old = a->data[index];
    a->data[index] = slot;
    a->present[index] = state;
  } else {
    size_t pos = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, index);
    if (pos == a->sparse_len || a->sparse[pos].index != index) {
      scr_arr_store_state_owned(a, index, slot, state);
      return;
    }
    old_state = a->sparse[pos].state;
    old = a->sparse[pos].slot;
    a->sparse[pos].slot = slot;
    a->sparse[pos].state = state;
  }
  if (old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, old);
}

static void scr_arr_replace_owned(ScrArr *a, size_t index, uint64_t slot) {
  scr_arr_replace_state_owned(a, index, slot, SCR_ARR_VALUE);
}

static bool scr_arr_prop_get_state(const ScrArr *a, double key, uint64_t *out,
                                   uint8_t *state_out) {
  char text[64];
  size_t len = scr_arr_prop_key(key, text);
  size_t pos = scr_arr_prop_index(a, text, len);
  if (pos == SIZE_MAX) return false;
  if (out) *out = a->props[pos].slot;
  if (state_out) *state_out = a->props[pos].state;
  return true;
}

static bool scr_arr_prop_get(const ScrArr *a, double key, uint64_t *out) {
  return scr_arr_prop_get_state(a, key, out, NULL);
}

static void scr_arr_prop_set(ScrArr *a, double key, uint64_t slot) {
  char text[64];
  size_t len = scr_arr_prop_key(key, text);
  size_t pos = scr_arr_prop_index(a, text, len);
  if (pos != SIZE_MAX) {
    uint64_t old = a->props[pos].slot;
    a->props[pos].slot = slot;
    uint8_t old_state = a->props[pos].state;
    a->props[pos].state = SCR_ARR_VALUE;
    if (old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) {
      scr_elem_release(a, old);
    }
    return;
  }
  scr_arr_grow_props(a, a->prop_len + 1);
  char *copy = malloc(len + 1);
  if (!copy) scr_arr_oom();
  memcpy(copy, text, len + 1);
  a->props[a->prop_len++] = (ScrArrProp){copy, len, slot, SCR_ARR_VALUE};
}

static void scr_arr_prop_set_undefined(ScrArr *a, double key) {
  char text[64];
  size_t len = scr_arr_prop_key(key, text);
  size_t pos = scr_arr_prop_index(a, text, len);
  if (pos != SIZE_MAX) {
    uint64_t old = a->props[pos].slot;
    uint8_t old_state = a->props[pos].state;
    a->props[pos].slot = 0;
    a->props[pos].state = SCR_ARR_UNDEFINED;
    if (old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) {
      scr_elem_release(a, old);
    }
    return;
  }
  scr_arr_grow_props(a, a->prop_len + 1);
  char *copy = malloc(len + 1);
  if (!copy) scr_arr_oom();
  memcpy(copy, text, len + 1);
  a->props[a->prop_len++] = (ScrArrProp){copy, len, 0, SCR_ARR_UNDEFINED};
}

static bool scr_arr_prop_delete(ScrArr *a, double key) {
  char text[64];
  size_t len = scr_arr_prop_key(key, text);
  size_t pos = scr_arr_prop_index(a, text, len);
  if (pos == SIZE_MAX) return false;
  uint64_t old = a->props[pos].slot;
  uint8_t old_state = a->props[pos].state;
  free(a->props[pos].key);
  memmove(a->props + pos, a->props + pos + 1,
          (a->prop_len - pos - 1) * sizeof(*a->props));
  a->prop_len--;
  if (old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) {
    scr_elem_release(a, old);
  }
  return true;
}

static ScrArrStorage scr_arr_take_storage(ScrArr *a) {
  ScrArrStorage old = {
      a->data, a->present, a->cap, a->sparse, a->sparse_len,
      a->sparse_cap};
  a->data = NULL;
  a->present = NULL;
  a->cap = 0;
  a->sparse = NULL;
  a->sparse_len = 0;
  a->sparse_cap = 0;
  return old;
}

static void scr_arr_free_storage(ScrArrStorage *s) {
  scr_mem_free(s->data);
  scr_arr_sparse_free(s->sparse);
  memset(s, 0, sizeof(*s));
}

/* Dense storage may still contain holes and explicit undefined. These
 * operations move ownership with the slots and move the states alongside
 * them; they never inspect an uninitialized hole payload. */
static bool scr_arr_is_dense(const ScrArr *a) {
  return a->len <= a->cap && a->sparse_len == 0;
}

static void scr_arr_move_dense(ScrArr *a, size_t to, size_t from, size_t count) {
  if (count == 0) return;
  memmove(a->data + to, a->data + from, count * sizeof(*a->data));
  memmove(a->present + to, a->present + from, count);
}

static void scr_arr_clear_dense(ScrArr *a, size_t from, size_t count) {
  if (count == 0) return;
  memset(a->present + from, SCR_ARR_HOLE, count);
  memset(a->data + from, 0, count * sizeof(*a->data));
}

/* The destination owns no values in this range. Only retain adapters run
 * while copying references: no release can collect an intermediate copy.
 * Self-appends use disjoint ranges after reserving capacity. */
static void scr_arr_copy_dense(ScrArr *dst, size_t to, const ScrArr *src,
                                size_t from, size_t count, bool reverse,
                                bool materialize_holes) {
  if (count == 0) return;
  if (!reverse) {
    memcpy(dst->data + to, src->data + from, count * sizeof(*dst->data));
    memcpy(dst->present + to, src->present + from, count);
  } else {
    for (size_t i = 0; i < count; i++) {
      size_t source = from + count - i - 1;
      memcpy(dst->data + to + i, src->data + source, sizeof(*dst->data));
      dst->present[to + i] = src->present[source];
    }
  }
  bool refs = scr_elem_is_ref(src->elem);
  if (!refs && !materialize_holes) return;
  for (size_t i = to; i < to + count; i++) {
    if (dst->present[i] == SCR_ARR_VALUE) {
      if (refs) dst->data[i] = scr_elem_retain_slot(src, dst->data[i]);
    } else if (materialize_holes && dst->present[i] == SCR_ARR_HOLE) {
      dst->data[i] = 0;
      dst->present[i] = SCR_ARR_UNDEFINED;
    }
  }
}

ScrArr *scr_arr_new(ScrElemKind elem, size_t initial_cap) {
  ScrArr *a = scr_mem_alloc(sizeof(ScrArr));
  if (!a) scr_arr_oom();
  a->rc = 1;
  a->len = 0;
  a->cap = 0;
  a->elem = elem;
  a->elem_retain = NULL;
  a->elem_release = NULL;
  a->elem_trace = NULL;
  a->data = NULL;
  a->present = NULL;
  a->sparse = NULL;
  a->sparse_len = 0;
  a->sparse_cap = 0;
  a->props = NULL;
  a->prop_len = 0;
  a->prop_cap = 0;
  a->metadata = NULL;
  if (initial_cap > 0) scr_arr_grow_dense(a, initial_cap);
#ifdef SCR_RC_AUDIT
  scr_live_arrays++;
#endif
  return a;
}

/* Collector trace of a cycle-capable array: every element is a headered
 * child (elem_trace non-NULL means the element TYPE carries a header, and
 * arrays are monomorphic), so trace visits all of them and the teardown
 * below releases none — the complement contract in scr_runtime.h. */
void scr_arr_trace_v(void *a0, ScrTraceVisit visit, void *ctx) {
  ScrArr *a = (ScrArr *)a0;
  if (a->metadata) visit(a->metadata, ctx);
  /* Growth and truncation leave spare capacity empty. Sparse slots and
   * named properties are separate edges, independent of dense length. */
  for (size_t i = 0, end = a->len < a->cap ? a->len : a->cap; i < end; i++) {
    if (a->present[i] == SCR_ARR_VALUE) visit(scr_slot_to_ptr(a->data[i]), ctx);
  }
  for (size_t i = 0; i < a->sparse_len; i++) {
    if (a->sparse[i].state == SCR_ARR_VALUE) {
      visit(scr_slot_to_ptr(a->sparse[i].slot), ctx);
    }
  }
  for (size_t i = 0; i < a->prop_len; i++) {
    if (a->props[i].state == SCR_ARR_VALUE) {
      visit(scr_slot_to_ptr(a->props[i].slot), ctx);
    }
  }
}

static void scr_arr_gc_free(void *a0) {
  ScrArr *a = (ScrArr *)a0;
  scr_mem_free(a->data);
  scr_arr_sparse_free(a->sparse);
  for (size_t i = 0; i < a->prop_len; i++) free(a->props[i].key);
  free(a->props);
#ifdef SCR_RC_AUDIT
  scr_live_arrays--;
#endif
  scr_cyc_free_inline(a);
}

ScrArr *scr_arr_new_ref(void *(*elem_retain)(void *),
                         void (*elem_release)(void *),
                         ScrTraceFn elem_trace, size_t initial_cap) {
  ScrArr *a;
  if (elem_trace) {
    a = scr_cyc_alloc_inline(sizeof(ScrArr), &scr_arr_trace_v, &scr_arr_gc_free);
  } else {
    a = scr_mem_alloc(sizeof(ScrArr));
    if (!a) scr_arr_oom();
  }
  a->rc = 1;
  a->len = 0;
  a->cap = 0;
  a->elem = SCR_ELEM_REF;
  a->elem_retain = elem_retain;
  a->elem_release = elem_release;
  a->elem_trace = elem_trace;
  a->data = NULL;
  a->present = NULL;
  a->sparse = NULL;
  a->sparse_len = 0;
  a->sparse_cap = 0;
  a->props = NULL;
  a->prop_len = 0;
  a->prop_cap = 0;
  a->metadata = NULL;
  if (initial_cap > 0) scr_arr_grow_dense(a, initial_cap);
#ifdef SCR_RC_AUDIT
  scr_live_arrays++;
#endif
  return a;
}

static void scr_arr_destroy(void *object) {
  ScrArr *a = object;
  scr_dyn_release(a->metadata);
  a->metadata = NULL;
  if (scr_elem_is_ref(a->elem)) {
    for (size_t i = 0, end = a->len < a->cap ? a->len : a->cap; i < end; i++) {
      if (a->present[i] != SCR_ARR_HOLE) {
        uint64_t old = a->data[i];
        uint8_t state = a->present[i];
        a->present[i] = 0;
        a->data[i] = 0;
        if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
      }
    }
    while (a->sparse_len > 0) {
      size_t i = a->sparse_len - 1;
      uint64_t old = a->sparse[i].slot;
      uint8_t state = a->sparse[i].state;
      a->sparse_len = i;
      if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
    }
    while (a->prop_len > 0) {
      size_t i = a->prop_len - 1;
      uint64_t old = a->props[i].slot;
      uint8_t state = a->props[i].state;
      free(a->props[i].key);
      a->prop_len = i;
      if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
    }
  }
  if (a->elem_trace) {
    scr_arr_gc_free(a);
  } else {
    scr_mem_free(a->data);
    scr_arr_sparse_free(a->sparse);
    for (size_t i = 0; i < a->prop_len; i++) free(a->props[i].key);
    free(a->props);
#ifdef SCR_RC_AUDIT
    scr_live_arrays--;
#endif
    scr_weak_dispose(a);
    scr_mem_free(a);
  }
}

void scr_arr_release(ScrArr *a) {
  if (!a || a->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--a->rc == 0) {
    if (a->elem_trace) scr_cyc_on_dead(a);
    scr_rc_destroy(a, scr_arr_destroy);
  } else if (a->elem_trace) {
    scr_cyc_on_release(a); /* possible cycle root; may collect */
  }
}

double scr_arr_len(ScrArr *a) { return (double)a->len; }

bool scr_arr_has(const ScrArr *a, double i) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx)) return scr_arr_prop_get(a, i, NULL);
  if (idx >= a->len) return false;
  return scr_arr_slot_at(a, idx, NULL);
}

double scr_arr_state(const ScrArr *a, double i) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx)) {
    uint8_t state;
    return scr_arr_prop_get_state(a, i, NULL, &state)
        ? (double)state
        : (double)SCR_ARR_HOLE;
  }
  if (idx >= a->len) return (double)SCR_ARR_HOLE;
  return (double)scr_arr_state_at(a, idx, NULL);
}

double scr_arr_next_present(const ScrArr *a, double start) {
  if (!(start < (double)a->len)) return (double)a->len;
  size_t i = start > 0 ? (size_t)ceil(start) : 0;
  size_t end = a->cap < a->len ? a->cap : a->len;
  for (; i < end; i++) {
    if (a->present[i] != SCR_ARR_HOLE) return (double)i;
  }
  size_t pos = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, i);
  if (pos < a->sparse_len && a->sparse[pos].index < a->len) {
    return (double)a->sparse[pos].index;
  }
  return (double)a->len;
}

static void scr_arr_invalid_length(double length) {
  (void)length;
  static const char msg[] = "Invalid array length";
  scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
}

void scr_arr_set_len(ScrArr *a, double length) {
  if (!(length >= 0) || !isfinite(length) || length != trunc(length) ||
      length > (double)SCR_ARR_MAX_LENGTH) {
    scr_arr_invalid_length(length);
    return;
  }
  size_t next = (size_t)length;
  if (next < a->len) {
    /* Spare capacity is already empty. Repeatedly clearing a reused work
     * array must cost only the elements removed, not its historical peak. */
    size_t dense_end = a->len < a->cap ? a->len : a->cap;
    size_t dense_stop = next < dense_end ? next : dense_end;
    if (scr_elem_is_ref(a->elem)) {
      for (size_t i = dense_stop; i < dense_end; i++) {
        if (a->present[i] != SCR_ARR_HOLE) {
          uint64_t old = a->data[i];
          uint8_t state = a->present[i];
          a->present[i] = 0;
          a->data[i] = 0;
          if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
        }
      }
      size_t keep = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, next);
      while (a->sparse_len > keep) {
        size_t i = a->sparse_len - 1;
        uint64_t old = a->sparse[i].slot;
        uint8_t state = a->sparse[i].state;
        a->sparse_len = i;
        if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
      }
    } else {
      for (size_t i = dense_stop; i < dense_end; i++) {
        a->present[i] = 0;
        a->data[i] = 0;
      }
      a->sparse_len = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, next);
    }
  }
  a->len = next;
}

void scr_arr_copy_index(ScrArr *dst, size_t dst_index, const ScrArr *src,
                        size_t src_index) {
  uint64_t slot;
  uint8_t state = scr_arr_state_at(src, src_index, &slot);
  if (state == SCR_ARR_HOLE) return;
  if (state == SCR_ARR_VALUE) slot = scr_elem_retain_slot(src, slot);
  scr_arr_replace_state_owned(dst, dst_index, slot, state);
}

void scr_arr_copy_range(ScrArr *dst, size_t dst_start, const ScrArr *src,
                        size_t src_start, size_t count, bool reverse) {
  scr_arr_copy_range_ex(dst, dst_start, src, src_start, count, reverse, false);
}

void scr_arr_copy_range_ex(ScrArr *dst, size_t dst_start, const ScrArr *src,
                           size_t src_start, size_t count, bool reverse,
                           bool materialize_holes) {
  if (count == 0) return;
  if (src != dst && src_start <= src->cap && count <= src->cap - src_start &&
      dst_start <= dst->cap && count <= dst->cap - dst_start) {
    size_t empty = 0;
    while (empty < count && dst->present[dst_start + empty] == SCR_ARR_HOLE) empty++;
    if (empty == count) {
      scr_arr_copy_dense(dst, dst_start, src, src_start, count, reverse,
                         materialize_holes);
      return;
    }
  }
  size_t end = src_start + count;
  size_t dense_start = src_start < src->cap ? src_start : src->cap;
  size_t dense_end = end < src->cap ? end : src->cap;
  for (size_t i = dense_start; i < dense_end; i++) {
    size_t off = reverse ? count - 1 - (i - src_start) : i - src_start;
    uint8_t state = scr_arr_state_at(src, i, NULL);
    if (state == SCR_ARR_HOLE) {
      if (materialize_holes) scr_arr_replace_state_owned(dst, dst_start + off, 0, SCR_ARR_UNDEFINED);
    } else {
      scr_arr_copy_index(dst, dst_start + off, src, i);
    }
  }
  size_t pos = scr_arr_sparse_lower_bound(src->sparse, src->sparse_len, src_start);
  for (; pos < src->sparse_len && src->sparse[pos].index < end; pos++) {
    size_t i = src->sparse[pos].index;
    size_t off = reverse ? count - 1 - (i - src_start) : i - src_start;
    scr_arr_copy_index(dst, dst_start + off, src, i);
  }
  if (materialize_holes) {
    size_t first = dense_end > src_start ? dense_end : src_start;
    for (size_t i = first; i < end; i++) {
      if (scr_arr_state_at(src, i, NULL) == SCR_ARR_HOLE) {
        size_t off = reverse ? count - 1 - (i - src_start) : i - src_start;
        scr_arr_replace_state_owned(dst, dst_start + off, 0, SCR_ARR_UNDEFINED);
      }
    }
  }
}

static size_t scr_arr_relative_index(double value, size_t length) {
  double integer = isnan(value) ? 0 : trunc(value);
  if (integer < 0) integer += (double)length;
  return integer <= 0 ? 0 : integer >= (double)length ? length : (size_t)integer;
}

ScrArr *scr_arr_copy_within(ScrArr *a, double target, double start, double end) {
  size_t to = scr_arr_relative_index(target, a->len);
  size_t from = scr_arr_relative_index(start, a->len);
  size_t last = scr_arr_relative_index(end, a->len);
  size_t count = last > from ? last - from : 0;
  if (count > a->len - to) count = a->len - to;
  if (count == 0 || from == to) return scr_arr_retain(a);
  if (!scr_elem_is_ref(a->elem) && from < a->cap && count <= a->cap - from &&
      to < a->cap && count <= a->cap - to) {
    scr_arr_move_dense(a, to, from, count);
    return scr_arr_retain(a);
  }
  bool backwards = from < to && to - from < count;
  for (size_t i = 0; i < count; i++) {
    size_t offset = backwards ? count - i - 1 : i;
    uint64_t slot = 0;
    uint8_t state = scr_arr_state_at(a, from + offset, &slot);
    if (state == SCR_ARR_HOLE) {
      scr_arr_delete(a, (double)(to + offset));
    } else {
      if (state == SCR_ARR_VALUE) slot = scr_elem_retain_slot(a, slot);
      /* Each replacement publishes its edge before releasing the previous
       * owner; cycle collection can run between successive positions. */
      scr_arr_replace_state_owned(a, to + offset, slot, state);
    }
  }
  return scr_arr_retain(a);
}

static ScrArr *scr_arr_fill_slot(ScrArr *a, uint64_t slot, uint8_t state,
                                  double start, double end) {
  size_t from = scr_arr_relative_index(start, a->len);
  size_t until = scr_arr_relative_index(end, a->len);
  if (from >= until) return scr_arr_retain(a);
  bool refs = scr_elem_is_ref(a->elem);
  if (scr_arr_dense_ok(a, until, until - from)) scr_arr_grow_dense(a, until);
  if (!refs && until <= a->cap) {
    for (size_t i = from; i < until; i++) a->data[i] = slot;
    memset(a->present + from, state, until - from);
  } else {
    for (size_t i = from; i < until; i++) {
      uint64_t value = refs && state == SCR_ARR_VALUE ? scr_elem_retain_slot(a, slot) : slot;
      scr_arr_replace_state_owned(a, i, value, state);
    }
  }
  return scr_arr_retain(a);
}

ScrArr *scr_arr_fill_f64(ScrArr *a, double value, double start, double end) {
  return scr_arr_fill_slot(a, scr_slot_from_f64(value), SCR_ARR_VALUE, start, end);
}

ScrArr *scr_arr_fill_bool(ScrArr *a, bool value, double start, double end) {
  return scr_arr_fill_slot(a, value ? 1 : 0, SCR_ARR_VALUE, start, end);
}

ScrArr *scr_arr_fill_ref(ScrArr *a, void *value, double start, double end) {
  return scr_arr_fill_slot(a, scr_slot_from_ptr(value), SCR_ARR_VALUE, start, end);
}

ScrArr *scr_arr_fill_undefined(ScrArr *a, double start, double end) {
  return scr_arr_fill_slot(a, 0, SCR_ARR_UNDEFINED, start, end);
}

/* ── Math.max/min over one spread number[] ─────────────────────────────
 * The JS fold exactly (ECMA Math.max/min applied to the elements): any
 * NaN poisons the result, +0 beats -0 for max (the reverse for min), and
 * the empty array yields the zero-argument constants. Borrows the array. */
double scr_math_max_arr(ScrArr *a) {
  double best = -INFINITY;
  for (size_t i = 0; i < a->len; i++) {
    uint64_t slot;
    if (scr_arr_state_at(a, i, &slot) != SCR_ARR_VALUE) return NAN;
    double v = scr_slot_to_f64(slot);
    if (isnan(v)) return v;
    if (v > best || (v == 0.0 && best == 0.0 && !signbit(v))) best = v;
  }
  return best;
}

double scr_math_min_arr(ScrArr *a) {
  double best = INFINITY;
  for (size_t i = 0; i < a->len; i++) {
    uint64_t slot;
    if (scr_arr_state_at(a, i, &slot) != SCR_ARR_VALUE) return NAN;
    double v = scr_slot_to_f64(slot);
    if (isnan(v)) return v;
    if (v < best || (v == 0.0 && best == 0.0 && signbit(v))) best = v;
  }
  return best;
}

/* Math.hypot is variadic. Scale before summing to avoid intermediate
 * overflow/underflow, and scan every element so Infinity wins over NaN. */
double scr_math_hypot_arr(ScrArr *a) {
  double scale = 0.0;
  bool has_nan = false;
  for (size_t i = 0; i < a->len; i++) {
    uint64_t slot;
    if (scr_arr_state_at(a, i, &slot) != SCR_ARR_VALUE) {
      has_nan = true;
      continue;
    }
    double v = fabs(scr_slot_to_f64(slot));
    if (isinf(v)) return INFINITY;
    if (isnan(v)) has_nan = true;
    else if (v > scale) scale = v;
  }
  if (has_nan) return NAN;
  if (scale == 0.0) return 0.0;
  double sum = 0.0;
  double correction = 0.0;
  for (size_t i = 0; i < a->len; i++) {
    uint64_t slot;
    (void)scr_arr_state_at(a, i, &slot);
    double v = scr_slot_to_f64(slot) / scale;
    double term = v * v - correction;
    double next = sum + term;
    correction = (next - sum) - term;
    sum = next;
  }
  return scale * sqrt(sum);
}

/* ── reads ─────────────────────────────────────────────────────────────── */

static uint64_t scr_arr_require_index(const ScrArr *a, size_t idx, double i);

static uint64_t scr_arr_require_slot(ScrArr *a, double i) {
  size_t idx;
  if (scr_arr_valid_index(i, &idx)) {
    if (idx < a->len) return scr_arr_require_index(a, idx, i);
    scr_arr_trap_oob(i, a->len);
  }
  uint64_t prop;
  uint8_t state;
  if (scr_arr_prop_get_state(a, i, &prop, &state)) {
    if (state == SCR_ARR_UNDEFINED) {
      char buf[32];
      scr_f64_to_str(i, buf);
      scr_trap_fmt("scriptc: RangeError: numeric property %s is undefined\n", buf);
    }
    return prop;
  }
  char buf[32];
  scr_f64_to_str(i, buf);
  scr_trap_fmt("scriptc: RangeError: numeric property %s is absent\n", buf);
  return 0;
}

static uint64_t scr_arr_require_index(const ScrArr *a, size_t idx, double i) {
  uint64_t slot;
  uint8_t state = scr_arr_state_at(a, idx, &slot);
  if (state == SCR_ARR_HOLE) {
    char buf[32];
    scr_f64_to_str(i, buf);
    scr_trap_fmt("scriptc: RangeError: array index %s is a hole (length %zu)\n",
                 buf, a->len);
  }
  if (state == SCR_ARR_UNDEFINED) {
    char buf[32];
    scr_f64_to_str(i, buf);
    scr_trap_fmt("scriptc: RangeError: array index %s is undefined (length %zu)\n",
                 buf, a->len);
  }
  return slot;
}

double scr_arr_get_f64(ScrArr *a, double i) {
  return scr_slot_to_f64(scr_arr_require_slot(a, i));
}

static bool scr_arr_read_value(const ScrArr *a, double i, uint64_t *slot) {
  size_t idx;
  uint8_t state;
  if (scr_arr_valid_index(i, &idx)) {
    if (idx >= a->len) return false;
    state = scr_arr_state_at(a, idx, slot);
  } else if (!scr_arr_prop_get_state(a, i, slot, &state)) {
    return false;
  }
  return state == SCR_ARR_VALUE;
}

void *scr_arr_peek_ref(const ScrArr *a, double i) {
  /* Dense in-range canonical indices answer from the state byte without
   * the general lookup; the range check precedes the cast. */
  if (i >= 0 && i < (double)a->cap) {
    size_t idx = (size_t)i;
    if ((double)idx == i) {
      if (idx >= a->len || a->present[idx] != SCR_ARR_VALUE) return NULL;
      return scr_slot_to_ptr(a->data[idx]);
    }
  }
  uint64_t slot;
  return scr_arr_read_value(a, i, &slot) ? scr_slot_to_ptr(slot) : NULL;
}

double scr_arr_get_number(const ScrArr *a, double i) {
  /* Keep this hot numeric-only entry self-contained: routing it through
   * scr_arr_read_value adds an out-of-line call at -O2 on native targets. */
  size_t idx;
  uint64_t slot;
  uint8_t state;
  if (scr_arr_valid_index(i, &idx)) {
    if (idx >= a->len) return NAN;
    state = scr_arr_state_at(a, idx, &slot);
  } else if (!scr_arr_prop_get_state(a, i, &slot, &state)) {
    return NAN;
  }
  return state == SCR_ARR_VALUE ? scr_slot_to_f64(slot) : NAN;
}

bool scr_arr_index_eq(const ScrArr *a, double i, const ScrArr *b, double j) {
  uint64_t av, bv;
  /* Avoid two general lookups for the common dense case. Check the range
   * before casting, and distinguish values from holes/present undefined. */
  if (i >= 0 && i < (double)a->cap && i == trunc(i) &&
      j >= 0 && j < (double)b->cap && j == trunc(j)) {
    size_t ai = (size_t)i, bi = (size_t)j;
    bool ap = ai < a->len && a->present[ai] == SCR_ARR_VALUE;
    bool bp = bi < b->len && b->present[bi] == SCR_ARR_VALUE;
    if (!ap || !bp) return ap == bp;
    av = a->data[ai];
    bv = b->data[bi];
  } else {
    bool ap = scr_arr_read_value(a, i, &av);
    bool bp = scr_arr_read_value(b, j, &bv);
    if (!ap || !bp) return ap == bp;
  }
  if (a->elem == SCR_ELEM_F64) return scr_slot_to_f64(av) == scr_slot_to_f64(bv);
  if (a->elem == SCR_ELEM_STR) return scr_str_eq(scr_slot_to_ptr(av), scr_slot_to_ptr(bv));
  return av == bv; /* bool; matching primitive kinds are validated by the IR */
}

bool scr_arr_get_bool(ScrArr *a, double i) {
  return scr_arr_require_slot(a, i) != 0;
}

void *scr_arr_get_ref(ScrArr *a, double i) {
  void *p = scr_slot_to_ptr(scr_arr_require_slot(a, i));
  if (!p) return NULL;
  if (a->elem == SCR_ELEM_STR) scr_str_retain((ScrStr *)p);
  else if (a->elem == SCR_ELEM_BYTES) scr_bytes_retain((ScrBytes *)p);
  else if (a->elem == SCR_ELEM_REF) p = a->elem_retain(p);
  else scr_arr_retain((ScrArr *)p);
  return p;
}

void *scr_arr_borrow_ref(ScrArr *a, double i) {
  return scr_slot_to_ptr(scr_arr_require_slot(a, i));
}

/* ── writes: i == len appends ──────────────────────────────────────────── */

static void scr_arr_set_slot(ScrArr *a, double i, uint64_t slot) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx)) {
    scr_arr_prop_set(a, i, slot);
    return;
  }
  if (idx >= a->len) a->len = idx + 1;
  /* Unlink-then-release: a release can trigger a cycle collection, which
   * must never see a heap edge whose count was already given up. */
  scr_arr_replace_owned(a, idx, slot);
}

void scr_arr_set_f64(ScrArr *a, double i, double v) {
  scr_arr_set_slot(a, i, scr_slot_from_f64(v));
}

void scr_arr_set_bool(ScrArr *a, double i, bool v) {
  scr_arr_set_slot(a, i, (uint64_t)(v ? 1 : 0));
}

void scr_arr_set_ref(ScrArr *a, double i, void *v) {
  scr_arr_set_slot(a, i, scr_slot_from_ptr(v));
}

void scr_arr_set_undefined(ScrArr *a, double i) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx)) {
    scr_arr_prop_set_undefined(a, i);
    return;
  }
  if (idx >= a->len) a->len = idx + 1;
  scr_arr_replace_state_owned(a, idx, 0, SCR_ARR_UNDEFINED);
}

bool scr_arr_delete(ScrArr *a, double i) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx)) return scr_arr_prop_delete(a, i);
  if (idx >= a->len) return false;
  uint64_t old;
  uint8_t state;
  if (!scr_arr_take_state(a, idx, &old, &state)) return false;
  if (state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) {
    scr_elem_release(a, old);
  }
  return true;
}

/* ── push / pop ────────────────────────────────────────────────────────── */

static double scr_arr_push_slot(ScrArr *a, uint64_t slot) {
  size_t idx = scr_arr_check_index(a, (double)a->len, true);
  scr_arr_store_owned(a, idx, slot);
  a->len++;
  return (double)a->len;
}

double scr_arr_push_f64(ScrArr *a, double v) {
  return scr_arr_push_slot(a, scr_slot_from_f64(v));
}

double scr_arr_push_bool(ScrArr *a, bool v) {
  return scr_arr_push_slot(a, (uint64_t)(v ? 1 : 0));
}

double scr_arr_push_ref(ScrArr *a, void *v) {
  return scr_arr_push_slot(a, scr_slot_from_ptr(v));
}

double scr_arr_push_many(ScrArr *a, size_t count, const uint64_t *slots) {
  if (count > SCR_ARR_MAX_LENGTH - a->len) scr_arr_oom();
  size_t from = a->len, next = from + count;
  if (scr_arr_dense_ok(a, next, count)) {
    scr_arr_grow_dense(a, next);
    if (count) {
      memcpy(a->data + from, slots, count * sizeof(*slots));
      memset(a->present + from, SCR_ARR_VALUE, count);
    }
  } else {
    for (size_t i = 0; i < count; i++) scr_arr_store_owned(a, from + i, slots[i]);
  }
  a->len = next;
  return (double)next;
}

double scr_arr_push_spread(ScrArr *a, const ScrArr *src) {
  size_t old_len = a->len;
  size_t add = src->len;
  if (add > SCR_ARR_MAX_LENGTH - old_len) scr_arr_oom();
  if (scr_arr_is_dense(a) && scr_arr_is_dense(src) &&
      scr_arr_dense_ok(a, old_len + add, add)) {
    scr_arr_grow_dense(a, old_len + add);
    scr_arr_copy_dense(a, old_len, src, 0, add, false, true);
    a->len += add;
    return (double)a->len;
  }
  if (src == a) {
    ScrArrStorage old = scr_arr_take_storage(a);
    a->len = 0;
    for (size_t i = 0; i < old_len; i++) {
      uint64_t slot;
      uint8_t state = scr_arr_state_at_storage(&old, i, &slot);
      if (state != SCR_ARR_HOLE) scr_arr_store_state_owned(a, i, slot, state);
      if (state == SCR_ARR_VALUE) {
        scr_arr_store_owned(a, old_len + i, scr_elem_retain_slot(a, slot));
      } else {
        scr_arr_store_state_owned(a, old_len + i, 0, SCR_ARR_UNDEFINED);
      }
    }
    a->len = old_len + add;
    scr_arr_free_storage(&old);
    return (double)a->len;
  }
  a->len = old_len + add;
  for (size_t i = 0; i < add; i++) {
    uint64_t slot;
    uint8_t state = scr_arr_state_at(src, i, &slot);
    if (state == SCR_ARR_VALUE) {
      scr_arr_store_owned(a, old_len + i, scr_elem_retain_slot(src, slot));
    } else {
      scr_arr_store_state_owned(a, old_len + i, 0, SCR_ARR_UNDEFINED);
    }
  }
  return (double)a->len;
}

double scr_arr_concat_copy(ScrArr *a, const ScrArr *src) {
  size_t old_len = a->len;
  size_t add = src->len;
  if (add > SCR_ARR_MAX_LENGTH - old_len) scr_arr_oom();
  if (scr_arr_is_dense(a) && scr_arr_is_dense(src) &&
      scr_arr_dense_ok(a, old_len + add, add)) {
    scr_arr_grow_dense(a, old_len + add);
    scr_arr_copy_dense(a, old_len, src, 0, add, false, false);
    a->len += add;
    return (double)a->len;
  }
  if (src == a) {
    ScrArrStorage old = scr_arr_take_storage(a);
    a->len = 0;
    for (size_t i = 0; i < old_len; i++) {
      uint64_t slot;
      uint8_t state = scr_arr_state_at_storage(&old, i, &slot);
      if (state != SCR_ARR_HOLE) scr_arr_store_state_owned(a, i, slot, state);
      if (state == SCR_ARR_VALUE) {
        scr_arr_store_owned(a, old_len + i, scr_elem_retain_slot(a, slot));
      } else if (state == SCR_ARR_UNDEFINED) {
        scr_arr_store_state_owned(a, old_len + i, 0, state);
      }
    }
    a->len = old_len + add;
    scr_arr_free_storage(&old);
    return (double)a->len;
  }
  a->len = old_len + add;
  for (size_t i = 0; i < src->cap; i++) {
    if (src->present[i] != SCR_ARR_HOLE) {
      scr_arr_copy_index(a, old_len + i, src, i);
    }
  }
  for (size_t i = 0; i < src->sparse_len; i++) {
    scr_arr_copy_index(a, old_len + src->sparse[i].index, src,
                       src->sparse[i].index);
  }
  return (double)a->len;
}

/* ── unshift / reverse ──────────────────────────────────────────────────
 * Single-element unshift takes ownership, matching push. The emitter calls
 * it from right to left after evaluating every variadic argument, preserving
 * JS argument order without a temporary array. The spread form borrows and
 * retains its source, snapshots the count, and handles self-spread after the
 * tail move by reading the relocated original block. */
static double scr_arr_unshift_slot(ScrArr *a, uint64_t slot) {
  if (a->len == SCR_ARR_MAX_LENGTH) {
    scr_arr_trap_oob((double)a->len, a->len);
  }
  size_t old_len = a->len;
  if (scr_arr_is_dense(a) && scr_arr_dense_ok(a, old_len + 1, 1)) {
    scr_arr_grow_dense(a, old_len + 1);
    scr_arr_move_dense(a, 1, 0, old_len);
    a->data[0] = slot;
    a->present[0] = SCR_ARR_VALUE;
    a->len++;
    return (double)a->len;
  }
  ScrArrStorage old = scr_arr_take_storage(a);
  a->len = 0;
  scr_arr_store_owned(a, 0, slot);
  for (size_t i = 0; i < old.cap; i++) {
    if (old.present[i]) scr_arr_store_state_owned(a, i + 1, old.data[i], old.present[i]);
  }
  for (size_t i = 0; i < old.sparse_len; i++) {
    scr_arr_store_state_owned(a, old.sparse[i].index + 1, old.sparse[i].slot,
                              old.sparse[i].state);
  }
  a->len = old_len + 1;
  scr_arr_free_storage(&old);
  return (double)a->len;
}

double scr_arr_unshift_f64(ScrArr *a, double v) {
  return scr_arr_unshift_slot(a, scr_slot_from_f64(v));
}

double scr_arr_unshift_bool(ScrArr *a, bool v) {
  return scr_arr_unshift_slot(a, (uint64_t)(v ? 1 : 0));
}

double scr_arr_unshift_ref(ScrArr *a, void *v) {
  return scr_arr_unshift_slot(a, scr_slot_from_ptr(v));
}

double scr_arr_unshift_many(ScrArr *a, size_t count, const uint64_t *slots) {
  size_t old_len = a->len;
  if (count == 0) return (double)old_len;
  if (count > SCR_ARR_MAX_LENGTH - old_len) scr_arr_oom();
  if (scr_arr_is_dense(a) && scr_arr_dense_ok(a, old_len + count, count)) {
    scr_arr_grow_dense(a, old_len + count);
    scr_arr_move_dense(a, count, 0, old_len);
    memcpy(a->data, slots, count * sizeof(*slots));
    memset(a->present, SCR_ARR_VALUE, count);
  } else {
    ScrArrStorage old = scr_arr_take_storage(a);
    for (size_t i = 0; i < count; i++) scr_arr_store_owned(a, i, slots[i]);
    for (size_t i = 0; i < old.cap; i++) {
      if (old.present[i] != SCR_ARR_HOLE)
        scr_arr_store_state_owned(a, i + count, old.data[i], old.present[i]);
    }
    for (size_t i = 0; i < old.sparse_len; i++) {
      scr_arr_store_state_owned(a, old.sparse[i].index + count,
                                old.sparse[i].slot, old.sparse[i].state);
    }
    scr_arr_free_storage(&old);
  }
  a->len = old_len + count;
  return (double)a->len;
}

double scr_arr_unshift_spread(ScrArr *a, const ScrArr *src) {
  size_t old_len = a->len;
  size_t add = src->len;
  if (add == 0) return (double)old_len;
  if (add > SCR_ARR_MAX_LENGTH - old_len) scr_arr_oom();
  if (scr_arr_is_dense(a) && scr_arr_is_dense(src) &&
      scr_arr_dense_ok(a, old_len + add, add)) {
    scr_arr_grow_dense(a, old_len + add);
    scr_arr_move_dense(a, add, 0, old_len);
    /* A self-spread reads the original values at their moved location. */
    scr_arr_copy_dense(a, 0, src, src == a ? add : 0, add, false, true);
    a->len += add;
    return (double)a->len;
  }
  ScrArrStorage old = scr_arr_take_storage(a);
  a->len = 0;
  for (size_t i = 0; i < add; i++) {
    uint64_t slot;
    uint8_t state = src == a
        ? scr_arr_state_at_storage(&old, i, &slot)
        : scr_arr_state_at(src, i, &slot);
    if (state == SCR_ARR_VALUE) {
      scr_arr_store_owned(a, i, scr_arr_retain_state_slot(src == a ? a : src, slot, state));
    } else {
      scr_arr_store_state_owned(a, i, 0, SCR_ARR_UNDEFINED);
    }
  }
  for (size_t i = 0; i < old.cap; i++) {
    if (old.present[i] != SCR_ARR_HOLE) {
      scr_arr_store_state_owned(a, i + add, old.data[i], old.present[i]);
    }
  }
  for (size_t i = 0; i < old.sparse_len; i++) {
    scr_arr_store_state_owned(a, old.sparse[i].index + add,
                              old.sparse[i].slot, old.sparse[i].state);
  }
  a->len = old_len + add;
  scr_arr_free_storage(&old);
  return (double)a->len;
}

ScrArr *scr_arr_reverse(ScrArr *a) {
  size_t len = a->len;
  if (scr_arr_is_dense(a)) {
    for (size_t i = 0; i < len / 2; i++) {
      size_t j = len - i - 1;
      uint64_t slot;
      memcpy(&slot, a->data + i, sizeof slot);
      memcpy(a->data + i, a->data + j, sizeof slot);
      memcpy(a->data + j, &slot, sizeof slot);
      uint8_t state = a->present[i];
      a->present[i] = a->present[j];
      a->present[j] = state;
    }
    return scr_arr_retain(a);
  }
  ScrArrStorage old = scr_arr_take_storage(a);
  a->len = len;
  for (size_t i = 0; i < old.cap; i++) {
    if (old.present[i]) scr_arr_store_state_owned(a, len - 1 - i, old.data[i], old.present[i]);
  }
  for (size_t i = 0; i < old.sparse_len; i++) {
    scr_arr_store_state_owned(a, len - 1 - old.sparse[i].index,
                              old.sparse[i].slot, old.sparse[i].state);
  }
  scr_arr_free_storage(&old);
  return scr_arr_retain(a);
}

uint8_t scr_arr_pop_state(ScrArr *a, uint64_t *slot_out) {
  if (slot_out) *slot_out = 0;
  if (a->len == 0) return SCR_ARR_HOLE;
  size_t idx = a->len - 1;
  uint64_t slot = 0;
  uint8_t state = SCR_ARR_HOLE;
  if (!scr_arr_take_state(a, idx, &slot, &state)) state = SCR_ARR_HOLE;
  a->len = idx;
  if (slot_out) *slot_out = slot;
  return state;
}

static uint64_t scr_arr_pop_slot(ScrArr *a) {
  uint64_t slot = 0;
  uint8_t state = scr_arr_pop_state(a, &slot);
  if (state != SCR_ARR_VALUE) {
    scr_trap("scriptc: RangeError: pop() returned undefined\n");
  }
  return slot;
}

double scr_arr_pop_f64(ScrArr *a) { return scr_slot_to_f64(scr_arr_pop_slot(a)); }

bool scr_arr_pop_bool(ScrArr *a) { return scr_arr_pop_slot(a) != 0; }

void *scr_arr_pop_ref(ScrArr *a) { return scr_slot_to_ptr(scr_arr_pop_slot(a)); }

/* ── shift ─────────────────────────────────────────────────────────────
 * The first element out, tail sliding down. The EMITTER guards the empty
 * array (JS answers undefined there — the `elem | undefined` union), so
 * an empty receiver here is an internal error, pop's discipline. Ref
 * ownership moves out to the caller (no retain). */
uint8_t scr_arr_shift_state(ScrArr *a, uint64_t *slot_out) {
  if (slot_out) *slot_out = 0;
  if (a->len == 0) return SCR_ARR_HOLE;
  size_t old_len = a->len;
  if (scr_arr_is_dense(a)) {
    uint8_t state = a->present[0];
    if (slot_out && state == SCR_ARR_VALUE) *slot_out = a->data[0];
    scr_arr_move_dense(a, 0, 1, old_len - 1);
    scr_arr_clear_dense(a, old_len - 1, 1);
    a->len--;
    return state;
  }
  ScrArrStorage old = scr_arr_take_storage(a);
  uint64_t s = 0;
  uint8_t state = scr_arr_state_at_storage(&old, 0, &s);
  a->len = 0;
  for (size_t i = 1; i < old.cap; i++) {
    if (old.present[i]) scr_arr_store_state_owned(a, i - 1, old.data[i], old.present[i]);
  }
  for (size_t i = 0; i < old.sparse_len; i++) {
    if (old.sparse[i].index > 0) {
      scr_arr_store_state_owned(a, old.sparse[i].index - 1, old.sparse[i].slot,
                                old.sparse[i].state);
    }
  }
  a->len = old_len - 1;
  scr_arr_free_storage(&old);
  if (slot_out) *slot_out = s;
  return state;
}

static uint64_t scr_arr_shift_slot(ScrArr *a) {
  uint64_t s = 0;
  uint8_t state = scr_arr_shift_state(a, &s);
  if (state != SCR_ARR_VALUE) {
    scr_trap("scriptc: RangeError: shift() returned undefined\n");
  }
  return s;
}

double scr_arr_shift_f64(ScrArr *a) { return scr_slot_to_f64(scr_arr_shift_slot(a)); }

bool scr_arr_shift_bool(ScrArr *a) { return scr_arr_shift_slot(a) != 0; }

void *scr_arr_shift_ref(ScrArr *a) { return scr_slot_to_ptr(scr_arr_shift_slot(a)); }

/* ── splice (the removal forms) ────────────────────────────────────────
 * a.splice(start, deleteCount) with Node's exact index handling: start
 * goes through ToIntegerOrInfinity with negative-from-the-end resolution
 * and clamps to [0, len]; deleteCount clamps to [0, len - start] (the
 * omitted-count form passes +Infinity — remove to the end). The removed
 * elements come back as a fresh +1 array IN ORDER, their ownership MOVED
 * out of the receiver (no retain/release churn); the tail slides down.
 * Borrows a. */
ScrArr *scr_arr_splice(ScrArr *a, double start, double deleteCount) {
  double len = (double)a->len;
  double s0 = isnan(start) ? 0 : trunc(start);
  if (s0 < 0) s0 += len;
  size_t from = s0 <= 0 ? 0 : s0 >= len ? a->len : (size_t)s0;
  double avail = len - (double)from;
  double d0 = isnan(deleteCount) ? 0 : trunc(deleteCount);
  size_t n = d0 <= 0 ? 0 : d0 >= avail ? (size_t)avail : (size_t)d0;
  /* A dense receiver bounds the removed range by its own packed storage;
   * otherwise the range may be mostly holes, so the capacity is a hint. */
  size_t hint = scr_arr_is_dense(a) || n <= SCR_ARR_DENSE_LIMIT ? n : SCR_ARR_DENSE_LIMIT;
  ScrArr *out =
      a->elem == SCR_ELEM_REF
          ? scr_arr_new_ref(a->elem_retain, a->elem_release, a->elem_trace, hint ? hint : 1)
          : scr_arr_new(a->elem, hint ? hint : 1);
  out->len = n;
  size_t old_len = a->len;
  if (scr_arr_is_dense(a)) {
    if (n) {
      memcpy(out->data, a->data + from, n * sizeof(*a->data));
      memcpy(out->present, a->present + from, n);
    }
    scr_arr_move_dense(a, from, from + n, old_len - from - n);
    scr_arr_clear_dense(a, old_len - n, n);
    a->len -= n;
    return out;
  }
  ScrArrStorage old = scr_arr_take_storage(a);
  a->len = 0;
  for (size_t i = 0; i < old.cap; i++) {
    if (old.present[i] == SCR_ARR_HOLE) continue;
    uint8_t state = old.present[i];
    size_t dst;
    if (i < from) {
      dst = i;
      scr_arr_store_state_owned(a, dst, old.data[i], state);
    } else if (i >= from + n) {
      dst = i - n;
      scr_arr_store_state_owned(a, dst, old.data[i], state);
    } else {
      dst = i - from;
      scr_arr_store_state_owned(out, dst, old.data[i], state);
    }
  }
  for (size_t j = 0; j < old.sparse_len; j++) {
    size_t i = old.sparse[j].index;
    if (i < from) {
      scr_arr_store_state_owned(a, i, old.sparse[j].slot, old.sparse[j].state);
    } else if (i >= from + n) {
      scr_arr_store_state_owned(a, i - n, old.sparse[j].slot, old.sparse[j].state);
    } else {
      scr_arr_store_state_owned(out, i - from, old.sparse[j].slot, old.sparse[j].state);
    }
  }
  a->len = old_len - n;
  scr_arr_free_storage(&old);
  return out;
}

/* Insert the evaluated arguments at the original start position. The first
 * splice moves removed slots out, and the second moves the remaining tail
 * out. Appending items follows array iteration (a hole becomes undefined);
 * appending the tail follows indexed copying (holes stay holes). */
ScrArr *scr_arr_splice_insert(ScrArr *a, double start, double deleteCount,
                              const ScrArr *items) {
  double len = (double)a->len;
  double s0 = isnan(start) ? 0 : trunc(start);
  if (s0 < 0) s0 += len;
  size_t from = s0 <= 0 ? 0 : s0 >= len ? a->len : (size_t)s0;
  double avail = len - (double)from;
  double d0 = isnan(deleteCount) ? 0 : trunc(deleteCount);
  size_t n = d0 <= 0 ? 0 : d0 >= avail ? (size_t)avail : (size_t)d0;
  if (items->len > SCR_ARR_MAX_LENGTH - (a->len - n)) scr_arr_oom();
  size_t add = items->len, next_len = a->len - n + add;
  if (scr_arr_is_dense(a) && scr_arr_is_dense(items) &&
      scr_arr_dense_ok(a, next_len, add)) {
    /* Snapshot an aliased argument before changing the receiver. Ordinary
     * callers have already materialized variadic arguments, so this copy
     * is needed only by direct self-spread runtime callers. */
    ScrArr *snapshot = items == a ? scr_arr_slice(a, 0, INFINITY) : NULL;
    if (snapshot) items = snapshot;
    ScrArr *removed = a->elem == SCR_ELEM_REF
        ? scr_arr_new_ref(a->elem_retain, a->elem_release, a->elem_trace, n)
        : scr_arr_new(a->elem, n);
    if (n) {
      memcpy(removed->data, a->data + from, n * sizeof(*a->data));
      memcpy(removed->present, a->present + from, n);
    }
    removed->len = n;
    scr_arr_grow_dense(a, next_len);
    scr_arr_move_dense(a, from + add, from + n, a->len - from - n);
    scr_arr_copy_dense(a, from, items, 0, add, false, true);
    if (next_len < a->len) scr_arr_clear_dense(a, next_len, a->len - next_len);
    a->len = next_len;
    scr_arr_release(snapshot);
    return removed;
  }
  ScrArr *removed = scr_arr_splice(a, start, deleteCount);
  ScrArr *tail = scr_arr_splice(a, (double)from, INFINITY);
  scr_arr_push_spread(a, items);
  scr_arr_concat_copy(a, tail);
  scr_arr_release(tail);
  return removed;
}

/* A statement-position splice: `a.splice(start, deleteCount, ...items)`
 * whose removed-elements array is never observed. The `count` owned value
 * slots are inserted exactly as scr_arr_splice_insert would (same clamping,
 * same resulting states), but no result array or argument array is built.
 * The removed values are released only after the receiver is consistent
 * again: a release can run the cycle collector. Sparse receivers and
 * sparse-sized results keep the general implementation. */
void scr_arr_splice_drop(ScrArr *a, double start, double deleteCount, size_t count,
                         const uint64_t *slots) {
  double len = (double)a->len;
  double s0 = isnan(start) ? 0 : trunc(start);
  if (s0 < 0) s0 += len;
  size_t from = s0 <= 0 ? 0 : s0 >= len ? a->len : (size_t)s0;
  double avail = len - (double)from;
  double d0 = isnan(deleteCount) ? 0 : trunc(deleteCount);
  size_t n = d0 <= 0 ? 0 : d0 >= avail ? (size_t)avail : (size_t)d0;
  if (count > SCR_ARR_MAX_LENGTH - (a->len - n)) scr_arr_oom();
  size_t next_len = a->len - n + count;
  bool refs = scr_elem_is_ref(a->elem);
  if (!scr_arr_is_dense(a) || !scr_arr_dense_ok(a, next_len, count)) {
    ScrArr *items = a->elem == SCR_ELEM_REF
        ? scr_arr_new_ref(a->elem_retain, a->elem_release, a->elem_trace, count)
        : scr_arr_new(a->elem, count);
    scr_arr_push_many(items, count, slots);
    scr_arr_release(scr_arr_splice_insert(a, start, deleteCount, items));
    scr_arr_release(items);
    return;
  }
  /* Removed slots, kept until the receiver is rewritten. */
  uint64_t inline_removed[8];
  uint64_t *removed = inline_removed;
  size_t kept = 0;
  if (refs && n > 0) {
    if (n > 8) {
      removed = scr_mem_alloc(n * sizeof(uint64_t));
      if (!removed) scr_arr_oom();
    }
    for (size_t i = from; i < from + n; i++) {
      if (a->present[i] == SCR_ARR_VALUE) removed[kept++] = a->data[i];
    }
  }
  size_t old_len = a->len;
  scr_arr_grow_dense(a, next_len);
  scr_arr_move_dense(a, from + count, from + n, old_len - from - n);
  if (count) {
    memcpy(a->data + from, slots, count * sizeof(*slots));
    memset(a->present + from, SCR_ARR_VALUE, count);
  }
  if (next_len < old_len) scr_arr_clear_dense(a, next_len, old_len - next_len);
  a->len = next_len;
  for (size_t i = 0; i < kept; i++) scr_elem_release(a, removed[i]);
  if (removed != inline_removed) scr_mem_free(removed);
}

/* FlattenIntoArray for static arrays: a dense copy with depth zero, or one
 * level over array elements. The frontend supplies an empty result of the
 * correct element kind; inner holes are skipped and present undefined stays
 * present. This function borrows both inputs and returns a retained result. */
ScrArr *scr_arr_flat_copy(const ScrArr *a, ScrArr *out, bool flatten) {
  for (size_t i = 0; i < a->len; i++) {
    uint64_t slot;
    uint8_t state = scr_arr_state_at(a, i, &slot);
    if (state == SCR_ARR_HOLE) continue;
    if (flatten && state == SCR_ARR_VALUE) {
      const ScrArr *inner = (const ScrArr *)scr_slot_to_ptr(slot);
      for (size_t j = 0; j < inner->len; j++) {
        if (scr_arr_state_at(inner, j, NULL) == SCR_ARR_HOLE) continue;
        if (out->len == SCR_ARR_MAX_LENGTH) scr_arr_oom();
        size_t at = out->len++;
        scr_arr_copy_index(out, at, inner, j);
      }
    } else {
      if (out->len == SCR_ARR_MAX_LENGTH) scr_arr_oom();
      size_t at = out->len++;
      scr_arr_copy_index(out, at, a, i);
    }
  }
  return scr_arr_retain(out);
}

/* ── indexOf / includes ────────────────────────────────────────────────
 * indexOf uses JS strict equality (===): NaN never matches (NaN !== NaN),
 * -0 matches 0 (C == agrees on both). includes uses SameValueZero: the one
 * difference is that NaN DOES match NaN. Reference elements: strings by
 * content (JS strings are primitive values), arrays by pointer identity.
 * All needles are borrowed. */

static bool scr_arr_ref_eq(const ScrArr *a, uint64_t slot, void *v) {
  void *p = scr_slot_to_ptr(slot);
  if (a->elem == SCR_ELEM_STR) return scr_str_eq((ScrStr *)p, (ScrStr *)v);
  if (a->elem == SCR_ELEM_REF && a->elem_retain == scr_dyn_retain_v) {
    return scr_dyn_strict_eq((ScrDyn *)p, (ScrDyn *)v);
  }
  if (a->elem == SCR_ELEM_REF && a->elem_retain == scr_closure_retain_v)
    return scr_closure_identity_equal((ScrClosure *)p, (ScrClosure *)v);
  return p == v;
}

double scr_arr_index_of_f64(ScrArr *a, double v) {
  for (size_t i = 0; i < a->cap && i < a->len; i++) {
    if (a->present[i] == SCR_ARR_VALUE && scr_slot_to_f64(a->data[i]) == v) return (double)i;
  }
  for (size_t i = 0; i < a->sparse_len; i++) {
    if (a->sparse[i].state == SCR_ARR_VALUE && scr_slot_to_f64(a->sparse[i].slot) == v) return (double)a->sparse[i].index;
  }
  return -1;
}

double scr_arr_index_of_bool(ScrArr *a, bool v) {
  for (size_t i = 0; i < a->cap && i < a->len; i++) {
    if (a->present[i] == SCR_ARR_VALUE && ((a->data[i] != 0) == v)) return (double)i;
  }
  for (size_t i = 0; i < a->sparse_len; i++) {
    if (a->sparse[i].state == SCR_ARR_VALUE && (a->sparse[i].slot != 0) == v) return (double)a->sparse[i].index;
  }
  return -1;
}

double scr_arr_index_of_ref(ScrArr *a, void *v) {
  for (size_t i = 0; i < a->cap && i < a->len; i++) {
    if (a->present[i] == SCR_ARR_VALUE && scr_arr_ref_eq(a, a->data[i], v)) return (double)i;
  }
  for (size_t i = 0; i < a->sparse_len; i++) {
    if (a->sparse[i].state == SCR_ARR_VALUE && scr_arr_ref_eq(a, a->sparse[i].slot, v)) return (double)a->sparse[i].index;
  }
  return -1;
}

bool scr_arr_includes_f64(ScrArr *a, double v) {
  for (size_t i = 0; i < a->cap && i < a->len; i++) {
    if (a->present[i] != SCR_ARR_VALUE) continue;
    double x = scr_slot_to_f64(a->data[i]);
    if (x == v || (x != x && v != v)) return true; /* SameValueZero: NaN hits */
  }
  for (size_t i = 0; i < a->sparse_len; i++) {
    if (a->sparse[i].state != SCR_ARR_VALUE) continue;
    double x = scr_slot_to_f64(a->sparse[i].slot);
    if (x == v || (x != x && v != v)) return true;
  }
  return false;
}

bool scr_arr_includes_bool(ScrArr *a, bool v) {
  return scr_arr_index_of_bool(a, v) >= 0;
}

bool scr_arr_includes_ref(ScrArr *a, void *v) {
  if (a->elem == SCR_ELEM_REF && a->elem_retain == scr_dyn_retain_v) {
    const ScrDyn *needle = (const ScrDyn *)v;
    if (needle->kind == SCR_DYN_NUM && needle->v.num != needle->v.num) {
      for (size_t i = 0; i < a->cap && i < a->len; i++) {
        if (a->present[i] != SCR_ARR_VALUE) continue;
        const ScrDyn *d = (const ScrDyn *)scr_slot_to_ptr(a->data[i]);
        if (d->kind == SCR_DYN_NUM && d->v.num != d->v.num) return true;
      }
      for (size_t i = 0; i < a->sparse_len; i++) {
        if (a->sparse[i].state != SCR_ARR_VALUE) continue;
        const ScrDyn *d = (const ScrDyn *)scr_slot_to_ptr(a->sparse[i].slot);
        if (d->kind == SCR_DYN_NUM && d->v.num != d->v.num) return true;
      }
      return false;
    }
  }
  return scr_arr_index_of_ref(a, v) >= 0;
}

/* ── join ──────────────────────────────────────────────────────────────── */

static size_t scr_join_size(size_t len, size_t extra) {
  if (extra > SIZE_MAX - sizeof(ScrStr) - 1 - len) scr_arr_oom();
  return len + extra;
}

/* The builder owns the final string allocation throughout construction.
 * It has no aliases or index-cache entries, and no user callbacks run while
 * appending primitive array values. Finish by publishing the terminator. */
static void scr_join_append(ScrStr **out, const char *bytes, size_t n) {
  ScrStr *s = *out;
  size_t need = scr_join_size(s->len, n);
  if (need > s->cap) {
    const size_t limit = SIZE_MAX - sizeof(ScrStr) - 1;
    size_t cap = s->cap;
    while (cap < need) cap = cap > limit / 2 ? need : cap * 2;
    s = scr_str_regrow(s, cap);
    *out = s;
  }
  memcpy(s->data + s->len, bytes, n);
  s->len = need;
}

/* `a.slice(start?, end?)` — a fresh shallow copy of the index range,
 * JS-exact: indices go through ToIntegerOrInfinity (the emitter fills the
 * omitted defaults 0 / +Infinity), negatives count from the end, both
 * clamp to [0, len]. Ref elements RETAIN into the copy — the same
 * references, exactly JS's shallow copy. Borrows a; returns +1. */
ScrArr *scr_arr_slice(ScrArr *a, double start, double end) {
  /* ToIntegerOrInfinity + relative-index resolution over the LENGTH. */
  double len = (double)a->len;
  double s0 = isnan(start) ? 0 : trunc(start);
  double e0 = isnan(end) ? 0 : trunc(end);
  if (s0 < 0) s0 += len;
  if (e0 < 0) e0 += len;
  size_t from = s0 <= 0 ? 0 : s0 >= len ? a->len : (size_t)s0;
  size_t to = e0 <= 0 ? 0 : e0 >= len ? a->len : (size_t)e0;
  size_t n = to > from ? to - from : 0;
  /* A range inside packed storage copies densely; a range reaching the
   * sparse side store may be mostly holes, so its capacity is a hint. */
  size_t hint = to <= a->cap || n <= SCR_ARR_DENSE_LIMIT ? n : SCR_ARR_DENSE_LIMIT;
  ScrArr *out =
      a->elem == SCR_ELEM_REF
          ? scr_arr_new_ref(a->elem_retain, a->elem_release, a->elem_trace, hint ? hint : 1)
          : scr_arr_new(a->elem, hint ? hint : 1);
  out->len = n;
  if (to <= a->cap) {
    scr_arr_copy_dense(out, 0, a, from, n, false, false);
    return out;
  }
  for (size_t i = 0; i < a->cap && i < to; i++) {
    if (i < from || a->present[i] == SCR_ARR_HOLE) continue;
    uint8_t state = a->present[i];
    scr_arr_store_state_owned(out, i - from,
                              scr_arr_retain_state_slot(a, a->data[i], state),
                              state);
  }
  for (size_t i = 0; i < a->sparse_len; i++) {
    size_t index = a->sparse[i].index;
    if (index >= from && index < to) {
      scr_arr_store_state_owned(out, index - from,
                                scr_arr_retain_state_slot(a, a->sparse[i].slot,
                                                          a->sparse[i].state),
                                a->sparse[i].state);
    }
  }
  return out;
}

/* Default ordering of primitive arrays cannot call user code. Keep each
 * payload owned by its source while sorting raw slots, then publish the
 * complete permutation without per-comparison retains or releases. */
typedef struct {
  uint64_t value;
  char text[32];
} ScrNumberSortKey;

typedef struct {
  ScrElemKind kind;
  const ScrNumberSortKey *numbers;
} ScrPrimitiveOrder;

static int scr_arr_primitive_compare(uint64_t left, uint64_t right,
                                      const ScrPrimitiveOrder *order) {
  if (order->kind == SCR_ELEM_STR)
    return scr_str_cmp_u16(scr_slot_to_ptr(left), scr_slot_to_ptr(right));
  if (order->kind == SCR_ELEM_BOOL) return (left > right) - (left < right);
  return strcmp(order->numbers[left].text, order->numbers[right].text);
}

/* Natural runs preserve ordered inputs. Reverse strictly descending runs
 * only, insert after ties, and merge from the left on equality. Allocate
 * scratch only when there is more than one completed run. */
static void scr_arr_primitive_order(uint64_t *values, size_t count,
                                     const ScrPrimitiveOrder *order) {
  if (count < 2) return;
  size_t local_runs[64], *runs = local_runs, run_cap = 64, run_count = 1;
  runs[0] = 0;
  for (size_t start = 0; start < count;) {
    size_t end = start + 1;
    if (end < count) {
      bool descending = scr_arr_primitive_compare(values[start], values[end], order) > 0;
      end++;
      while (end < count &&
             (scr_arr_primitive_compare(values[end - 1], values[end], order) > 0) == descending)
        end++;
      if (descending) {
        for (size_t left = start, right = end - 1; left < right; left++, right--) {
          uint64_t value = values[left];
          values[left] = values[right];
          values[right] = value;
        }
      }
    }
    size_t limit = count - start < 16 ? count : start + 16;
    while (end < limit) {
      uint64_t value = values[end];
      size_t low = start, high = end;
      while (low < high) {
        size_t mid = low + (high - low) / 2;
        if (scr_arr_primitive_compare(values[mid], value, order) > 0) high = mid;
        else low = mid + 1;
      }
      memmove(values + low + 1, values + low, (end - low) * sizeof(*values));
      values[low] = value;
      end++;
    }
    if (run_count == run_cap) {
      if (run_cap > SIZE_MAX / 2 / sizeof(*runs)) scr_arr_oom();
      size_t *next = malloc(run_cap * 2 * sizeof(*runs));
      if (!next) scr_arr_oom();
      memcpy(next, runs, run_count * sizeof(*runs));
      if (runs != local_runs) free(runs);
      runs = next;
      run_cap *= 2;
    }
    runs[run_count++] = end;
    start = end;
  }
  if (run_count > 2) {
    if (count > SIZE_MAX / sizeof(*values)) scr_arr_oom();
    uint64_t *scratch = malloc(count * sizeof(*scratch));
    if (!scratch) scr_arr_oom();
    uint64_t *src = values, *dst = scratch;
    while (run_count > 2) {
      size_t next_run = 1;
      for (size_t run = 0; run + 1 < run_count; run += 2) {
        size_t start = runs[run], mid = runs[run + 1];
        size_t end = run + 2 < run_count ? runs[run + 2] : count;
        if (mid == end || scr_arr_primitive_compare(src[mid - 1], src[mid], order) <= 0) {
          memcpy(dst + start, src + start, (end - start) * sizeof(*dst));
        } else {
          size_t left = start, right = mid, out = start;
          while (left < mid && right < end) {
            dst[out++] = scr_arr_primitive_compare(src[left], src[right], order) > 0
                ? src[right++] : src[left++];
          }
          if (left < mid) memcpy(dst + out, src + left, (mid - left) * sizeof(*dst));
          else if (right < end) memcpy(dst + out, src + right, (end - right) * sizeof(*dst));
        }
        runs[next_run++] = end;
      }
      run_count = next_run;
      uint64_t *swap = src; src = dst; dst = swap;
    }
    if (src != values) memcpy(values, src, count * sizeof(*values));
    free(scratch);
  }
  if (runs != local_runs) free(runs);
}

ScrArr *scr_arr_sort_primitive(ScrArr *a, bool copy) {
  if (a->elem != SCR_ELEM_STR && a->elem != SCR_ELEM_F64 && a->elem != SCR_ELEM_BOOL)
    scr_trap("scriptc: invalid primitive array ordering\n");
  if (a->len == 0) return copy ? scr_arr_new(a->elem, 0) : scr_arr_retain(a);
  size_t dense = a->len < a->cap ? a->len : a->cap;
  size_t count = 0, undefined_count = 0;
  for (size_t i = 0; i < dense; i++) {
    count += a->present[i] == SCR_ARR_VALUE;
    undefined_count += a->present[i] == SCR_ARR_UNDEFINED;
  }
  for (size_t i = 0; i < a->sparse_len; i++) {
    count += a->sparse[i].state == SCR_ARR_VALUE;
    undefined_count += a->sparse[i].state == SCR_ARR_UNDEFINED;
  }
  if (count > SIZE_MAX / sizeof(uint64_t)) scr_arr_oom();
  uint64_t *values = count ? malloc(count * sizeof(*values)) : NULL;
  if (count && !values) scr_arr_oom();
  size_t used = 0;
  for (size_t i = 0; i < dense; i++)
    if (a->present[i] == SCR_ARR_VALUE) values[used++] = a->data[i];
  for (size_t i = 0; i < a->sparse_len; i++)
    if (a->sparse[i].state == SCR_ARR_VALUE) values[used++] = a->sparse[i].slot;
  ScrNumberSortKey *numbers = NULL;
  if (a->elem == SCR_ELEM_F64 && count > 1) {
    if (count > SIZE_MAX / sizeof(*numbers)) scr_arr_oom();
    numbers = malloc(count * sizeof(*numbers));
    if (!numbers) scr_arr_oom();
    for (size_t i = 0; i < count; i++) {
      numbers[i].value = values[i];
      scr_f64_to_str(scr_slot_to_f64(values[i]), numbers[i].text);
      values[i] = i;
    }
  }
  ScrPrimitiveOrder order = {a->elem, numbers};
  scr_arr_primitive_order(values, count, &order);
  if (numbers) {
    for (size_t i = 0; i < count; i++) values[i] = numbers[values[i]].value;
    free(numbers);
  }
  size_t present = copy ? a->len : count + undefined_count;
  ScrArr *out = copy ? scr_arr_new(a->elem, present) : a;
  if (copy) out->len = a->len;
  if (!copy && scr_arr_is_dense(a)) {
    if (count) memcpy(a->data, values, count * sizeof(*values));
    memset(a->present, SCR_ARR_VALUE, count);
    memset(a->present + count, SCR_ARR_UNDEFINED, undefined_count);
    scr_arr_clear_dense(a, count + undefined_count, a->len - count - undefined_count);
    if (undefined_count) memset(a->data + count, 0, undefined_count * sizeof(*a->data));
  } else {
    ScrArrStorage old = {0};
    if (!copy) old = scr_arr_take_storage(a);
    for (size_t i = 0; i < count; i++)
      scr_arr_store_owned(out, i, copy ? scr_elem_retain_slot(a, values[i]) : values[i]);
    for (size_t i = count; i < present; i++)
      scr_arr_store_state_owned(out, i, 0, SCR_ARR_UNDEFINED);
    if (!copy) scr_arr_free_storage(&old);
  }
  free(values);
  return copy ? out : scr_arr_retain(a);
}

/* ── comparator sort over a compacted private snapshot ────────────────── */

typedef struct {
  ScrClosure *f;
  void *(*retain)(void *); /* reference elements; NULL for numbers */
  uint32_t arity;
  bool numbers;
} ScrSortCompare;

static void *scr_sort_retain_str(void *p) { return scr_str_retain((ScrStr *)p); }
static void *scr_sort_retain_arr(void *p) { return scr_arr_retain((ScrArr *)p); }
static void *scr_sort_retain_bytes(void *p) { return scr_bytes_retain((ScrBytes *)p); }

/* One comparator call with the closure ABI of the emitted callValue: the
 * callee owns its reference parameters and reports an exception through
 * the pending flag. The caller holds the undefined-`this` window open for
 * the whole sort; every emitted call restores the receiver stack it
 * pushed, so its top is undefined at each comparator entry. */
static bool scr_sort_greater(const ScrSortCompare *c, uint64_t left, uint64_t right,
                             bool *failed) {
  double result;
  if (c->numbers) {
    double x = scr_slot_to_f64(left), y = scr_slot_to_f64(right);
    if (c->arity == 2) result = ((double (*)(ScrClosure *, double, double))c->f->fn)(c->f, x, y);
    else if (c->arity == 1) result = ((double (*)(ScrClosure *, double))c->f->fn)(c->f, x);
    else result = ((double (*)(ScrClosure *))c->f->fn)(c->f);
  } else {
    void *x = scr_slot_to_ptr(left), *y = scr_slot_to_ptr(right);
    if (c->arity == 2) {
      if (x) x = c->retain(x);
      if (y) y = c->retain(y);
      result = ((double (*)(ScrClosure *, void *, void *))c->f->fn)(c->f, x, y);
    } else if (c->arity == 1) {
      if (x) x = c->retain(x);
      result = ((double (*)(ScrClosure *, void *))c->f->fn)(c->f, x);
    } else {
      result = ((double (*)(ScrClosure *))c->f->fn)(c->f);
    }
  }
  if (scr_exc_pending()) {
    *failed = true;
    return false;
  }
  return result > 0;
}

/* Merges touch one element they have not seen before per comparison; for
 * reference elements that load usually misses the cache. Request it a few
 * comparisons early so the miss overlaps the current comparator call. */
#ifndef SCR_SORT_PREFETCH_DISTANCE
#define SCR_SORT_PREFETCH_DISTANCE 4
#endif
#if defined(__GNUC__) || defined(__clang__)
#define SCR_SORT_PREFETCH_AT(c, buf, at, limit)                      \
  do {                                                              \
    if (!(c).numbers && (at) < (limit))                             \
      __builtin_prefetch(scr_slot_to_ptr((buf)[(at)]));             \
  } while (0)
#else
#define SCR_SORT_PREFETCH_AT(c, buf, at, limit) ((void)0)
#endif
#define SCR_SORT_PREFETCH(c, buf, index, limit) \
  SCR_SORT_PREFETCH_AT(c, buf, (index) + SCR_SORT_PREFETCH_DISTANCE, limit)

/* The stable natural merge sort of the compiler's IR helper, over borrowed
 * slot copies: strictly descending runs reverse, short runs grow to 16 with
 * binary insertion after equal values, then merge passes consume pairs of
 * runs. Comparator calls happen in exactly the IR helper's order. The array
 * keeps owning every element and stays untouched while user code runs, so
 * the cycle collector and a throwing comparator both see the original
 * snapshot; the sorted permutation is published only after success. */
void scr_arr_sort_values(ScrArr *a, double count, ScrClosure *f, uint32_t arity) {
  size_t n = (size_t)count;
  if (n < 2) return;
  if (n > a->len || n > SIZE_MAX / 2 / sizeof(uint64_t))
    scr_trap("scriptc: invalid comparator sort snapshot\n");
  ScrSortCompare c = {f, NULL, arity, a->elem == SCR_ELEM_F64};
  if (!c.numbers) {
    if (a->elem == SCR_ELEM_STR) c.retain = scr_sort_retain_str;
    else if (a->elem == SCR_ELEM_ARR) c.retain = scr_sort_retain_arr;
    else if (a->elem == SCR_ELEM_BYTES) c.retain = scr_sort_retain_bytes;
    else if (a->elem == SCR_ELEM_REF) c.retain = a->elem_retain;
    else scr_trap("scriptc: invalid comparator sort element kind\n");
  }
  uint64_t *src = malloc(n * sizeof(*src));
  uint64_t *dst = malloc(n * sizeof(*dst));
  size_t *runs = malloc((n + 1) * sizeof(*runs));
  if (!src || !dst || !runs) scr_arr_oom();
  for (size_t i = 0; i < n; i++) {
    if (scr_arr_state_at(a, i, &src[i]) != SCR_ARR_VALUE)
      scr_trap("scriptc: invalid comparator sort snapshot\n");
  }
  bool failed = false;
  scr_dyn_this_push_dyn(NULL);
#define SCR_SORT_GREATER(x, y) (scr_sort_greater(&c, (x), (y), &failed))
#define SCR_SORT_CHECK() \
  do {                   \
    if (failed) goto done; \
  } while (0)
  size_t run_count = 1, start = 0;
  runs[0] = 0;
  while (start < n) {
    size_t end = start + 1;
    if (end < n) {
      bool descending = SCR_SORT_GREATER(src[start], src[end]);
      SCR_SORT_CHECK();
      end++;
      while (end < n) {
        SCR_SORT_PREFETCH(c, src, end, n);
        bool greater = SCR_SORT_GREATER(src[end - 1], src[end]);
        SCR_SORT_CHECK();
        if (descending ? greater : !greater) end++;
        else break;
      }
      if (descending) {
        for (size_t left = start, right = end - 1; left < right; left++, right--) {
          uint64_t v = src[left];
          src[left] = src[right];
          src[right] = v;
        }
      }
    }
    size_t limit = start + 16 < n ? start + 16 : n;
    for (; end < limit; end++) {
      uint64_t pivot = src[end];
      size_t low = start, high = end;
      while (low < high) {
        size_t center = low + (high - low) / 2;
        bool greater = SCR_SORT_GREATER(src[center], pivot);
        SCR_SORT_CHECK();
        if (greater) high = center;
        else low = center + 1;
      }
      memmove(src + low + 1, src + low, (end - low) * sizeof(*src));
      src[low] = pivot;
    }
    runs[run_count++] = end;
    start = end;
  }
  while (run_count > 2) {
    size_t next_run = 1;
    for (size_t run = 0; run + 1 < run_count; run += 2) {
      size_t lo = runs[run], mid = runs[run + 1];
      size_t right = run + 2 < run_count ? runs[run + 2] : n;
      size_t i = lo, j = mid, k = lo;
      bool merge = false;
      if (mid < right) {
        merge = SCR_SORT_GREATER(src[mid - 1], src[mid]);
        SCR_SORT_CHECK();
      }
      if (merge) {
        uint64_t left_value = src[i], right_value = src[j];
        for (size_t ahead = 1; ahead < SCR_SORT_PREFETCH_DISTANCE; ahead++) {
          SCR_SORT_PREFETCH_AT(c, src, i + ahead, mid);
          SCR_SORT_PREFETCH_AT(c, src, j + ahead, right);
        }
        while (i < mid && j < right) {
          bool greater = SCR_SORT_GREATER(left_value, right_value);
          SCR_SORT_CHECK();
          if (greater) {
            dst[k] = right_value;
            if (++j < right) right_value = src[j];
            SCR_SORT_PREFETCH(c, src, j, right);
          } else {
            dst[k] = left_value;
            if (++i < mid) left_value = src[i];
            SCR_SORT_PREFETCH(c, src, i, mid);
          }
          k++;
        }
      }
      memcpy(dst + k, src + i, (mid - i) * sizeof(*src));
      k += mid - i;
      memcpy(dst + k, src + j, (right - j) * sizeof(*src));
      runs[next_run++] = right;
    }
    run_count = next_run;
    uint64_t *tmp = src;
    src = dst;
    dst = tmp;
  }
#undef SCR_SORT_CHECK
#undef SCR_SORT_GREATER
  /* A permutation of the same owned slots: no reference count changes. */
  for (size_t i = 0; i < n; i++) {
    if (i < a->cap) {
      a->data[i] = src[i];
    } else {
      size_t pos = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, i);
      a->sparse[pos].slot = src[i];
    }
  }
done:
  scr_dyn_this_pop();
  free(src);
  free(dst);
  free(runs);
}

ScrStr *scr_arr_join(ScrArr *a, ScrStr *sep) {
  size_t cap = 64;
  /* String widths are already known. Size once to avoid growth and copying
   * even when the array holds holes, explicit undefined or sparse slots.
   * Numeric formatting stays single-pass rather than formatting twice. */
  if (a->elem == SCR_ELEM_STR) {
    const size_t limit = SIZE_MAX - sizeof(ScrStr) - 1;
    if (a->len > 1 && sep->len > limit / (a->len - 1)) scr_arr_oom();
    cap = a->len > 1 ? (a->len - 1) * sep->len : 0;
    for (size_t i = 0; i < a->len; i++) {
      uint64_t slot;
      if (scr_arr_state_at(a, i, &slot) != SCR_ARR_VALUE) continue;
      const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(slot);
      if (s) cap = scr_join_size(cap, s->len);
    }
  }
  ScrStr *out = scr_str_alloc_raw(0, cap);
  for (size_t i = 0; i < a->len; i++) {
    if (i > 0) scr_join_append(&out, sep->data, sep->len);
    uint64_t slot;
    uint8_t state = scr_arr_state_at(a, i, &slot);
    if (state != SCR_ARR_VALUE) continue;
    switch (a->elem) {
      case SCR_ELEM_F64: {
        char nb[32];
        size_t n = scr_f64_to_str(scr_slot_to_f64(slot), nb);
        scr_join_append(&out, nb, n);
        break;
      }
      case SCR_ELEM_BOOL:
        if (slot != 0) scr_join_append(&out, "true", 4);
        else scr_join_append(&out, "false", 5);
        break;
      case SCR_ELEM_STR: {
        const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(slot);
        if (s) scr_join_append(&out, s->data, s->len);
        break;
      }
      case SCR_ELEM_ARR:
      case SCR_ELEM_BYTES:
      case SCR_ELEM_REF:
        /* The compiler rejects join on ref-element arrays (SC1090). */
        scr_trap("scriptc: internal error: join on a ref-element array\n");
    }
  }
  out->data[out->len] = '\0';
  return out;
}

/* String.raw over the template's raw literals and PRE-STRINGIFIED
 * substitutions (the frontend applies the static ToString per value):
 * raw[0] sub[0] raw[1] sub[1] ... — substitutions beyond raw.len-1 drop,
 * missing ones skip, exactly the spec's loop. Both arrays are
 * SCR_ELEM_STR; borrows both; +1 result. Never throws. */
ScrStr *scr_str_raw(ScrArr *raw, ScrArr *subs) {
  ScrStr *out = scr_str_alloc_raw(0, 64);
  for (size_t i = 0; i < raw->len; i++) {
    uint64_t raw_slot;
    if (scr_arr_slot_at(raw, i, &raw_slot)) {
      const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(raw_slot);
      if (s) scr_join_append(&out, s->data, s->len);
    }
    if (i + 1 < raw->len && i < subs->len) {
      uint64_t sub_slot;
      if (scr_arr_slot_at(subs, i, &sub_slot)) {
        const ScrStr *v = (const ScrStr *)scr_slot_to_ptr(sub_slot);
        if (v) scr_join_append(&out, v->data, v->len);
      }
    }
  }
  out->data[out->len] = '\0';
  return out;
}

void scr_arr_copy_metadata(ScrArr *a, ScrDyn *target) {
  if (!a->metadata) return;
  for (size_t i = 0; i < a->metadata->v.obj.len; i++) {
    ScrDynEntry *entry = &a->metadata->v.obj.entries[i];
    ScrStr *key = scr_str_new(entry->key, entry->key_len);
    scr_dyn_key_set(target, key, entry->value);
    scr_str_release(key);
  }
}
