#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SCR_ARR_MAX_LENGTH ((size_t)UINT32_MAX)
#define SCR_ARR_MAX_INDEX (SCR_ARR_MAX_LENGTH - 1)
/* Keep the packed representation bounded. Requests below this cutoff grow
 * geometrically in dense storage; indices at or above it use sorted sparse
 * entries. Sequential appends after crossing the cutoff intentionally trade
 * memory for side-store insertion work. */
#define SCR_ARR_DENSE_LIMIT ((size_t)1 << 20)

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

static void scr_arr_grow_dense(ScrArr *a, size_t need) {
  if (need <= a->cap || need > SCR_ARR_DENSE_LIMIT) return;
  size_t cap = a->cap ? a->cap : 4;
  while (cap < need && cap < SCR_ARR_DENSE_LIMIT) {
    if (cap > SIZE_MAX / 2 / sizeof(uint64_t)) scr_arr_oom();
    cap *= 2;
  }
  if (cap > SCR_ARR_DENSE_LIMIT) cap = SCR_ARR_DENSE_LIMIT;
  uint64_t *data = realloc(a->data, cap * sizeof(uint64_t));
  if (!data) scr_arr_oom();
  uint8_t *present = realloc(a->present, cap);
  if (!present) scr_arr_oom();
  memset(present + a->cap, 0, cap - a->cap);
  a->data = data;
  a->present = present;
  a->cap = cap;
}

static void scr_arr_grow_for_index(ScrArr *a, size_t index) {
  if (index < SCR_ARR_DENSE_LIMIT) scr_arr_grow_dense(a, index + 1);
}

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

static void scr_arr_grow_sparse(ScrArr *a, size_t need) {
  if (need <= a->sparse_cap) return;
  size_t cap = a->sparse_cap ? a->sparse_cap : 4;
  while (cap < need) {
    if (cap > SIZE_MAX / 2 / sizeof(*a->sparse)) scr_arr_oom();
    cap *= 2;
  }
  ScrArrSparseSlot *slots = realloc(a->sparse, cap * sizeof(*slots));
  if (!slots) scr_arr_oom();
  a->sparse = slots;
  a->sparse_cap = cap;
}

/* Store an owned slot into an empty index. The caller has already established
 * the destination length and does not need a retain. */
static void scr_arr_store_owned(ScrArr *a, size_t index, uint64_t slot) {
  scr_arr_grow_for_index(a, index);
  if (index < a->cap) {
    a->data[index] = slot;
    a->present[index] = SCR_ARR_VALUE;
    return;
  }
  size_t pos = scr_arr_sparse_lower_bound(a->sparse, a->sparse_len, index);
  if (pos < a->sparse_len && a->sparse[pos].index == index) {
    a->sparse[pos].slot = slot;
    a->sparse[pos].state = SCR_ARR_VALUE;
    return;
  }
  scr_arr_grow_sparse(a, a->sparse_len + 1);
  memmove(a->sparse + pos + 1, a->sparse + pos,
          (a->sparse_len - pos) * sizeof(*a->sparse));
  a->sparse[pos] = (ScrArrSparseSlot){index, slot, SCR_ARR_VALUE};
  a->sparse_len++;
}

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
  scr_arr_grow_sparse(a, a->sparse_len + 1);
  memmove(a->sparse + pos + 1, a->sparse + pos,
          (a->sparse_len - pos) * sizeof(*a->sparse));
  a->sparse[pos] = (ScrArrSparseSlot){index, slot, state};
  a->sparse_len++;
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
  memmove(a->sparse + pos, a->sparse + pos + 1,
          (a->sparse_len - pos - 1) * sizeof(*a->sparse));
  a->sparse_len--;
  return true;
}

static void scr_arr_replace_owned(ScrArr *a, size_t index, uint64_t slot) {
  uint64_t old;
  uint8_t state;
  bool had = scr_arr_take_state(a, index, &old, &state);
  scr_arr_store_owned(a, index, slot);
  if (had && state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, old);
}

static void scr_arr_replace_state_owned(ScrArr *a, size_t index, uint64_t slot,
                                        uint8_t state) {
  uint64_t old;
  uint8_t old_state;
  bool had = scr_arr_take_state(a, index, &old, &old_state);
  scr_arr_store_state_owned(a, index, slot, state);
  if (had && old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) {
    scr_elem_release(a, old);
  }
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
  free(s->data);
  free(s->present);
  free(s->sparse);
  memset(s, 0, sizeof(*s));
}

ScrArr *scr_arr_new(ScrElemKind elem, size_t initial_cap) {
  ScrArr *a = malloc(sizeof(ScrArr));
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
  for (size_t i = 0; i < a->cap; i++) {
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
  free(a->data);
  free(a->present);
  free(a->sparse);
  for (size_t i = 0; i < a->prop_len; i++) free(a->props[i].key);
  free(a->props);
#ifdef SCR_RC_AUDIT
  scr_live_arrays--;
#endif
  scr_cyc_free(a);
}

ScrArr *scr_arr_new_ref(void *(*elem_retain)(void *),
                         void (*elem_release)(void *),
                         ScrTraceFn elem_trace, size_t initial_cap) {
  ScrArr *a;
  if (elem_trace) {
    a = scr_cyc_alloc(sizeof(ScrArr), &scr_arr_trace_v, &scr_arr_gc_free);
  } else {
    a = malloc(sizeof(ScrArr));
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
  if (initial_cap > 0) scr_arr_grow_dense(a, initial_cap);
#ifdef SCR_RC_AUDIT
  scr_live_arrays++;
#endif
  return a;
}

void scr_arr_release(ScrArr *a) {
  if (!a || a->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--a->rc == 0) {
    if (a->elem_trace) scr_cyc_on_dead(a);
    if (scr_elem_is_ref(a->elem)) {
      for (size_t i = 0; i < a->cap; i++) {
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
      free(a->data);
      free(a->present);
      free(a->sparse);
      for (size_t i = 0; i < a->prop_len; i++) free(a->props[i].key);
      free(a->props);
#ifdef SCR_RC_AUDIT
      scr_live_arrays--;
#endif
      free(a);
    }
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
    if (scr_elem_is_ref(a->elem)) {
      size_t dense_stop = next < a->cap ? next : a->cap;
      for (size_t i = dense_stop; i < a->cap; i++) {
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
      size_t dense_stop = next < a->cap ? next : a->cap;
      for (size_t i = dense_stop; i < a->cap; i++) {
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

/* ── writes: i == len appends ──────────────────────────────────────────── */

static void scr_arr_set_slot(ScrArr *a, double i, uint64_t slot) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx)) {
    scr_arr_prop_set(a, i, slot);
    return;
  }
  idx = scr_arr_check_index(a, i, true);
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
  idx = scr_arr_check_index(a, i, true);
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

double scr_arr_push_spread(ScrArr *a, const ScrArr *src) {
  size_t old_len = a->len;
  size_t add = src->len;
  if (add > SCR_ARR_MAX_LENGTH - old_len) scr_arr_oom();
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

double scr_arr_unshift_spread(ScrArr *a, const ScrArr *src) {
  size_t old_len = a->len;
  size_t add = src->len;
  if (add == 0) return (double)old_len;
  if (add > SCR_ARR_MAX_LENGTH - old_len) scr_arr_oom();
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
  ScrArr *out =
      a->elem == SCR_ELEM_REF
          ? scr_arr_new_ref(a->elem_retain, a->elem_release, a->elem_trace, n ? n : 1)
          : scr_arr_new(a->elem, n ? n : 1);
  out->len = n;
  size_t old_len = a->len;
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

/* ── indexOf / includes ────────────────────────────────────────────────
 * indexOf uses JS strict equality (===): NaN never matches (NaN !== NaN),
 * -0 matches 0 (C == agrees on both). includes uses SameValueZero: the one
 * difference is that NaN DOES match NaN. Reference elements: strings by
 * content (JS strings are primitive values), arrays by pointer identity.
 * All needles are borrowed. */

static bool scr_arr_ref_eq(const ScrArr *a, uint64_t slot, void *v) {
  void *p = scr_slot_to_ptr(slot);
  if (a->elem == SCR_ELEM_STR) return scr_str_eq((ScrStr *)p, (ScrStr *)v);
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
  return scr_arr_index_of_ref(a, v) >= 0;
}

/* ── join ──────────────────────────────────────────────────────────────── */

static void scr_join_append(char **buf, size_t *len, size_t *cap,
                             const char *bytes, size_t n) {
  if (*len + n > *cap) {
    size_t cap2 = *cap;
    while (*len + n > cap2) {
      if (cap2 > SIZE_MAX / 2) scr_arr_oom();
      cap2 *= 2;
    }
    char *grown = realloc(*buf, cap2);
    if (!grown) scr_arr_oom();
    *buf = grown;
    *cap = cap2;
  }
  memcpy(*buf + *len, bytes, n);
  *len += n;
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
  ScrArr *out =
      a->elem == SCR_ELEM_REF
          ? scr_arr_new_ref(a->elem_retain, a->elem_release, a->elem_trace, n ? n : 1)
          : scr_arr_new(a->elem, n ? n : 1);
  out->len = n;
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

ScrStr *scr_arr_join(ScrArr *a, ScrStr *sep) {
  size_t cap = 64, len = 0;
  char *buf = malloc(cap);
  if (!buf) scr_arr_oom();
  for (size_t i = 0; i < a->len; i++) {
    if (i > 0) scr_join_append(&buf, &len, &cap, sep->data, sep->len);
    uint64_t slot;
    uint8_t state = scr_arr_state_at(a, i, &slot);
    if (state != SCR_ARR_VALUE) continue;
    switch (a->elem) {
      case SCR_ELEM_F64: {
        char nb[32];
        size_t n = scr_f64_to_str(scr_slot_to_f64(slot), nb);
        scr_join_append(&buf, &len, &cap, nb, n);
        break;
      }
      case SCR_ELEM_BOOL:
        if (slot != 0) scr_join_append(&buf, &len, &cap, "true", 4);
        else scr_join_append(&buf, &len, &cap, "false", 5);
        break;
      case SCR_ELEM_STR: {
        const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(slot);
        if (s) scr_join_append(&buf, &len, &cap, s->data, s->len);
        break;
      }
      case SCR_ELEM_ARR:
      case SCR_ELEM_BYTES:
      case SCR_ELEM_REF:
        /* The compiler rejects join on ref-element arrays (SC1090). */
        scr_trap("scriptc: internal error: join on a ref-element array\n");
    }
  }
  ScrStr *out = scr_str_new(buf, len);
  free(buf);
  return out;
}

/* String.raw over the template's raw literals and PRE-STRINGIFIED
 * substitutions (the frontend applies the static ToString per value):
 * raw[0] sub[0] raw[1] sub[1] ... — substitutions beyond raw.len-1 drop,
 * missing ones skip, exactly the spec's loop. Both arrays are
 * SCR_ELEM_STR; borrows both; +1 result. Never throws. */
ScrStr *scr_str_raw(ScrArr *raw, ScrArr *subs) {
  size_t cap = 64, len = 0;
  char *buf = malloc(cap);
  if (!buf) scr_arr_oom();
  for (size_t i = 0; i < raw->len; i++) {
    uint64_t raw_slot;
    if (scr_arr_slot_at(raw, i, &raw_slot)) {
      const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(raw_slot);
      if (s) scr_join_append(&buf, &len, &cap, s->data, s->len);
    }
    if (i + 1 < raw->len && i < subs->len) {
      uint64_t sub_slot;
      if (scr_arr_slot_at(subs, i, &sub_slot)) {
        const ScrStr *v = (const ScrStr *)scr_slot_to_ptr(sub_slot);
        if (v) scr_join_append(&buf, &len, &cap, v->data, v->len);
      }
    }
  }
  ScrStr *out = scr_str_new(buf, len);
  free(buf);
  return out;
}
