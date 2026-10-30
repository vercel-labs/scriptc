#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SCR_ARR_MAX_LENGTH ((size_t)UINT32_MAX)
#define SCR_ARR_MAX_INDEX (SCR_ARR_MAX_LENGTH - 1)
/* A length as a JS number. Lengths never exceed 2^32 - 1, so the signed
 * conversion is exact; x86-64 has no single instruction for the unsigned
 * 64-bit one that a plain size_t cast compiles to. */
#define SCR_ARR_LEN_F64(n) ((double)(int64_t)(n))
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
/* A published array is immortal: it is never freed, so it leaves the count. */
void scr_arr_live_forget(void) { scr_live_arrays--; }
#endif

static void scr_arr_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* Readers of the out-of-line storage see an all-empty one until the first
 * sparse entry, noncanonical property or metadata allocates it. */
static const ScrArrExt scr_arr_no_ext;
#define SCR_AX(a) ((const ScrArrExt *)((a)->ext ? (a)->ext : &scr_arr_no_ext))

ScrArrExt *scr_arr_ext(ScrArr *a) {
  if (!a->ext) {
    a->ext = scr_mem_calloc(sizeof(ScrArrExt));
    if (!a->ext) scr_arr_oom();
  }
  return a->ext;
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
      (!allow_append && i >= SCR_ARR_LEN_F64(a->len))) {
    scr_arr_trap_oob(i, a->len);
  }
  /* 0 <= i < 2^32: the signed conversion is exact and a single instruction. */
  return (size_t)(int64_t)i;
}

static bool scr_arr_valid_index(double i, size_t *out) {
  if (!(i >= 0) || i != trunc(i) || i > (double)SCR_ARR_MAX_INDEX) return false;
  *out = (size_t)(int64_t)i;
  return true;
}

static size_t scr_arr_prop_index(const ScrArr *a, const char *key,
                                 size_t key_len) {
  for (size_t i = 0; i < SCR_AX(a)->prop_len; i++) {
    if (SCR_AX(a)->props[i].key_len == key_len &&
        memcmp(SCR_AX(a)->props[i].key, key, key_len) == 0) {
      return i;
    }
  }
  return SIZE_MAX;
}

static size_t scr_arr_prop_key(double i, char *buf) {
  return scr_f64_to_str(i, buf);
}

static void scr_arr_grow_props(ScrArr *a, size_t need) {
  ScrArrExt *x = scr_arr_ext(a);
  if (need <= x->prop_cap) return;
  size_t cap = x->prop_cap ? x->prop_cap : 4;
  while (cap < need) {
    if (cap > SIZE_MAX / 2 / sizeof(*x->props)) scr_arr_oom();
    cap *= 2;
  }
  ScrArrProp *props = realloc(x->props, cap * sizeof(*props));
  if (!props) scr_arr_oom();
  x->props = props;
  x->prop_cap = cap;
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
  else if (a->elem == SCR_ELEM_REF) a->ops->release(p);
}

static uint64_t scr_elem_retain_slot(const ScrArr *a, uint64_t slot) {
  if (!scr_elem_is_ref(a->elem)) return slot;
  void *p = scr_slot_to_ptr(slot);
  if (!p) return slot;
  if (a->elem == SCR_ELEM_STR) p = scr_str_retain((ScrStr *)p);
  else if (a->elem == SCR_ELEM_ARR) p = scr_arr_retain((ScrArr *)p);
  else if (a->elem == SCR_ELEM_BYTES) p = scr_bytes_retain((ScrBytes *)p);
  else p = a->ops->retain(p);
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
  uint8_t elem; /* the owning array's element kind: the dense slot width */
  bool inline_slots; /* the slots live in the array's own block: never freed alone */
} ScrArrStorage;

static uint64_t scr_arr_storage_get(const ScrArrStorage *s, size_t index) {
  if (s->elem == SCR_ELEM_BOOL) return ((const uint8_t *)s->data)[index];
  return s->data[index];
}

/* The address of dense slot `index` (<= cap). */
static uint8_t *scr_arr_dense_at(const ScrArr *a, size_t index) {
  return (uint8_t *)a->data + index * scr_arr_slot_width(a);
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

/* The sorted side store is a deque. Its allocation holds `front` spare slots,
 * one header slot whose index records `front`, then sparse_cap slots starting
 * at SCR_AX(a)->sparse (live entries first). The header sits directly before
 * SCR_AX(a)->sparse, so every owner of the pointer (including swapped or detached
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
  ScrArrExt *x = scr_arr_ext(a);
  const size_t unit = sizeof(ScrArrSparseSlot);
  if (front > SIZE_MAX / unit / 2 || back > SIZE_MAX / unit / 2) scr_arr_oom();
  size_t total = (front + 1 + back) * unit;
  ScrArrSparseSlot *slots;
  if (x->sparse && front == scr_arr_sparse_front(x->sparse)) {
    ScrArrSparseSlot *base = realloc(x->sparse - 1 - front, total);
    if (!base) scr_arr_oom();
    slots = base + front + 1;
  } else {
    ScrArrSparseSlot *base = malloc(total);
    if (!base) scr_arr_oom();
    slots = base + front + 1;
    if (x->sparse_len) memcpy(slots, x->sparse, x->sparse_len * unit);
    scr_arr_sparse_free(x->sparse);
  }
  slots[-1] = (ScrArrSparseSlot){front, 0, 0};
  x->sparse = slots;
  x->sparse_cap = back;
}

static void scr_arr_grow_sparse(ScrArr *a, size_t need) {
  if (need <= SCR_AX(a)->sparse_cap) return;
  scr_arr_sparse_realloc(a, scr_arr_sparse_front(SCR_AX(a)->sparse),
                         scr_arr_sparse_grow_cap(SCR_AX(a)->sparse_cap, need));
}

static void scr_arr_sparse_insert(ScrArr *a, size_t pos, ScrArrSparseSlot entry) {
  ScrArrExt *x = scr_arr_ext(a);
  size_t len = x->sparse_len;
  if (pos < len - pos) {
    if (scr_arr_sparse_front(x->sparse) == 0) {
      scr_arr_sparse_realloc(a, len > 4 ? len : 4, x->sparse_cap);
    }
    size_t front = scr_arr_sparse_front(x->sparse);
    ScrArrSparseSlot *slots = x->sparse - 1; /* the old header slot */
    slots[-1] = (ScrArrSparseSlot){front - 1, 0, 0};
    memmove(slots, x->sparse, pos * sizeof(*slots));
    slots[pos] = entry;
    x->sparse = slots;
    x->sparse_cap++;
  } else {
    scr_arr_grow_sparse(a, len + 1);
    memmove(x->sparse + pos + 1, x->sparse + pos, (len - pos) * sizeof(*x->sparse));
    x->sparse[pos] = entry;
  }
  x->sparse_len = len + 1;
}

static void scr_arr_sparse_remove(ScrArr *a, size_t pos) {
  ScrArrExt *x = scr_arr_ext(a);
  size_t len = x->sparse_len;
  if (pos < len - 1 - pos) {
    size_t front = scr_arr_sparse_front(x->sparse);
    memmove(x->sparse + 1, x->sparse, pos * sizeof(*x->sparse));
    x->sparse[0] = (ScrArrSparseSlot){front + 1, 0, 0};
    x->sparse++;
    x->sparse_cap--;
  } else {
    memmove(x->sparse + pos, x->sparse + pos + 1, (len - pos - 1) * sizeof(*x->sparse));
  }
  x->sparse_len = len - 1;
}

/* Drop the first `count` live entries after the caller moved them out. */
static void scr_arr_sparse_drop_prefix(ScrArr *a, size_t count) {
  if (count == 0) return;
  ScrArrExt *x = scr_arr_ext(a);
  size_t front = scr_arr_sparse_front(x->sparse);
  x->sparse[count - 1] = (ScrArrSparseSlot){front + count, 0, 0};
  x->sparse += count;
  x->sparse_cap -= count;
  x->sparse_len -= count;
}

/* Bytes per dense slot: the value and its state byte. Boolean arrays
 * store a one-byte value. */
#define SCR_ARR_SLOT_BYTES (sizeof(uint64_t) + sizeof(uint8_t))
#define SCR_ARR_BOOL_SLOT_BYTES (2 * sizeof(uint8_t))
/* Appends to an array smaller than this grow straight to it. */
#define SCR_ARR_MIN_GROWTH ((size_t)4)

/* Inline slots: an array built by scr_arr_new_small / scr_arr_new_ops_small
 * (empty literals the compiler sees appended to) keeps its first dense
 * slots and states in its own block, right after the ScrArr, so it costs
 * one allocation and its first elements share the header's cache lines.
 * `spare` records it. Growth past the inline capacity moves the slots to an
 * ordinary allocation; the inline room then stays unused until the array is
 * freed. */
#define SCR_ARR_INLINE_SLOTS 1u
/* Where inline slots start in the array's block (8-byte aligned on every
 * target). */
#define SCR_ARR_INLINE_OFFSET ((sizeof(ScrArr) + 7) & ~(size_t)7)

static bool scr_arr_inline(const ScrArr *a) { return (a->spare & SCR_ARR_INLINE_SLOTS) != 0; }

/* Slots requested by the small constructions, rounded up to fill a block
 * on the 16-byte grid: 5 eight-byte slots (or 8 booleans) after a plain
 * header. */
#define SCR_ARR_SMALL_SLOTS ((size_t)4)

/* Inline capacity of a small construction with `prefix` bytes of block
 * before the slots. */
static size_t scr_arr_small_cap(size_t prefix, bool bools) {
  size_t unit = bools ? SCR_ARR_BOOL_SLOT_BYTES : SCR_ARR_SLOT_BYTES;
#if SCR_SMALL_ALLOC
  size_t block = (prefix + SCR_ARR_SMALL_SLOTS * unit + 15) & ~(size_t)15;
  return bools ? (block - prefix) / SCR_ARR_BOOL_SLOT_BYTES : (block - prefix) / SCR_ARR_SLOT_BYTES;
#else
  (void)prefix;
  (void)unit;
  return SCR_ARR_SMALL_SLOTS;
#endif
}

static void scr_arr_use_inline(ScrArr *a, size_t cap) {
  a->data = (uint64_t *)((char *)a + SCR_ARR_INLINE_OFFSET);
  a->present = (uint8_t *)a->data + cap * scr_arr_slot_width(a);
  memset(a->present, SCR_ARR_HOLE, cap);
  a->cap = cap;
  a->spare |= SCR_ARR_INLINE_SLOTS;
}

/* Move inline slots to their own allocation of `cap` (>= a->cap) slots; the
 * array's block keeps the unused room until it is freed. */
static void scr_arr_move_inline(ScrArr *a, size_t cap, size_t unit) {
  size_t width = scr_arr_slot_width(a);
  uint64_t *data = scr_mem_alloc(cap * unit);
  if (!data) scr_arr_oom();
  uint8_t *present = (uint8_t *)data + cap * width;
  memcpy(data, a->data, a->cap * width);
  memcpy(present, a->present, a->cap);
  memset(present + a->cap, SCR_ARR_HOLE, cap - a->cap);
  a->data = data;
  a->present = present;
  a->cap = cap;
  a->spare &= (uint16_t)~SCR_ARR_INLINE_SLOTS;
}

/* How a dense allocation is sized. */
typedef enum {
  SCR_ARR_GROW_APPEND, /* geometric headroom for further appends */
  SCR_ARR_GROW_SPAN,   /* a densified sparse tail: exact above the cutoff */
  SCR_ARR_GROW_EXACT,  /* construction with a known element count */
} ScrArrGrow;

/* The small-object allocator rounds blocks up to their size class, so an
 * exactly sized array can use the whole block for slots: a one-element
 * literal keeps a 16-byte block rather than reserving 4 slots in a 40-byte
 * one. The request is first rounded to 16 bytes, so arrays of 2, 4 and 6
 * slots get one spare slot (a 2-element literal or copy holds 3 in a
 * 32-byte block) and an append right after construction needs no
 * reallocation. Growth keeps its own sequence (4, 8, 16, ...): rounding it
 * as well moves array storage into other size classes and measured
 * slower. */
static size_t scr_arr_block_cap(size_t cap, bool bools) {
#if SCR_SMALL_ALLOC
  size_t bytes = cap * (bools ? SCR_ARR_BOOL_SLOT_BYTES : SCR_ARR_SLOT_BYTES);
  if (bytes <= SCR_SA_MAX) {
    size_t block = scr_sa_class_size(scr_sa_class((bytes + 15) & ~(size_t)15));
    return bools ? block / SCR_ARR_BOOL_SLOT_BYTES : block / SCR_ARR_SLOT_BYTES;
  }
#else
  (void)bools;
#endif
  return cap;
}

/* Grow dense storage to cover at least [0, need). Callers decide whether the
 * range is populated enough (scr_arr_dense_ok); this only allocates. Sparse
 * entries below the new capacity move into the packed slots, preserving the
 * invariant every reader (including emitted code) relies on: indices below
 * cap live in dense storage and sparse entries all lie at or above cap. New
 * capacity always starts as holes; slot payloads past len stay unwritten. */
static void scr_arr_grow_dense_slow(ScrArr *a, size_t need, ScrArrGrow mode);

/* Arrays of 8-byte slots with their own storage block and no sparse entries,
 * growing below the cutoff, take a path with a constant slot size and no
 * sparse absorption; every other array takes scr_arr_grow_dense_slow. Both
 * paths pick the same capacity. */
static inline void scr_arr_grow_dense_to(ScrArr *a, size_t need, ScrArrGrow mode) {
  if (need <= a->cap) return;
  if (a->elem == SCR_ELEM_BOOL || scr_arr_inline(a) || (a->ext && a->ext->sparse_len) ||
      need > SCR_ARR_DENSE_LIMIT) {
    scr_arr_grow_dense_slow(a, need, mode);
    return;
  }
  size_t cap;
  if (mode == SCR_ARR_GROW_EXACT) {
    cap = scr_arr_block_cap(need, false);
  } else {
    cap = a->cap < SCR_ARR_MIN_GROWTH ? SCR_ARR_MIN_GROWTH : a->cap;
    while (cap < need) cap += cap;
    if (cap > SCR_ARR_DENSE_LIMIT) cap = SCR_ARR_DENSE_LIMIT;
  }
  size_t old = a->cap;
  uint64_t *data = a->data ? scr_mem_realloc(a->data, cap * SCR_ARR_SLOT_BYTES)
                           : scr_mem_alloc(cap * SCR_ARR_SLOT_BYTES);
  if (!data) scr_arr_oom();
  /* The states follow the values: move them past the larger value area. */
  uint8_t *present = (uint8_t *)(data + cap);
  if (old) memmove(present, (uint8_t *)(data + old), old);
  memset(present + old, SCR_ARR_HOLE, cap - old);
  a->data = data;
  a->present = present;
  a->cap = cap;
}

static void scr_arr_grow_dense_slow(ScrArr *a, size_t need, ScrArrGrow mode) {
  if (need > SCR_ARR_MAX_LENGTH) scr_arr_oom();
  bool bools = a->elem == SCR_ELEM_BOOL;
  size_t width = scr_arr_slot_width(a);
  size_t unit = bools ? SCR_ARR_BOOL_SLOT_BYTES : SCR_ARR_SLOT_BYTES;
  size_t cap;
  if (mode == SCR_ARR_GROW_EXACT) {
    cap = scr_arr_block_cap(need, bools);
  } else {
    /* Inline slots overflow into the ordinary sequence (4, 8, 16, ...). */
    size_t from = scr_arr_inline(a) ? 0 : a->cap;
    cap = from < SCR_ARR_MIN_GROWTH ? SCR_ARR_MIN_GROWTH : from;
    while (cap < need) {
      /* Double below the cutoff; grow by half above it to bound overshoot. */
      size_t step = cap < SCR_ARR_DENSE_LIMIT ? cap : cap / 2;
      cap = cap > SCR_ARR_MAX_LENGTH - step ? SCR_ARR_MAX_LENGTH : cap + step;
    }
    if (need <= SCR_ARR_DENSE_LIMIT && cap > SCR_ARR_DENSE_LIMIT) cap = SCR_ARR_DENSE_LIMIT;
    /* Densifying an arbitrary sparse tail sizes to the populated span; only
     * appends benefit from geometric headroom. */
    if (mode == SCR_ARR_GROW_SPAN && need > SCR_ARR_DENSE_LIMIT) cap = need;
  }
  if (cap > SIZE_MAX / SCR_ARR_SLOT_BYTES) scr_arr_oom(); /* bounds both slot sizes */
  if (scr_arr_inline(a)) {
    scr_arr_move_inline(a, cap, unit);
    size_t moved = scr_arr_sparse_lower_bound(SCR_AX(a)->sparse, SCR_AX(a)->sparse_len, cap);
    for (size_t i = 0; i < moved; i++) {
      scr_arr_dense_put(a, SCR_AX(a)->sparse[i].index, SCR_AX(a)->sparse[i].slot);
      a->present[SCR_AX(a)->sparse[i].index] = SCR_AX(a)->sparse[i].state;
    }
    scr_arr_sparse_drop_prefix(a, moved);
    return;
  }
  if (!a->data && SCR_AX(a)->sparse_len == 0) {
    /* First storage: nothing to copy, move or absorb. */
    uint64_t *data = scr_mem_alloc(cap * unit);
    if (!data) scr_arr_oom();
    a->data = data;
    a->present = (uint8_t *)data + cap * width;
    memset(a->present, SCR_ARR_HOLE, cap);
    a->cap = cap;
    return;
  }
  /* Values and states share one allocation. Move the old states before
   * publishing the larger capacity: their previous location is now part
   * of the value area. Existing data and state pointers keep their ABI. */
  uint64_t *data = scr_mem_realloc(a->data, cap * unit);
  if (!data) scr_arr_oom();
  uint8_t *present = (uint8_t *)data + cap * width;
  if (a->cap) memmove(present, (uint8_t *)data + a->cap * width, a->cap);
  memset(present + a->cap, SCR_ARR_HOLE, cap - a->cap);
  a->data = data;
  a->present = present;
  a->cap = cap;
  size_t moved = scr_arr_sparse_lower_bound(SCR_AX(a)->sparse, SCR_AX(a)->sparse_len, cap);
  for (size_t i = 0; i < moved; i++) {
    scr_arr_dense_put(a, SCR_AX(a)->sparse[i].index, SCR_AX(a)->sparse[i].slot);
    a->present[SCR_AX(a)->sparse[i].index] = SCR_AX(a)->sparse[i].state;
  }
  scr_arr_sparse_drop_prefix(a, moved);
}

static void scr_arr_grow_dense(ScrArr *a, size_t need) {
  scr_arr_grow_dense_to(a, need, SCR_ARR_GROW_APPEND);
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
  uint64_t populated = (uint64_t)SCR_AX(a)->sparse_len + (uint64_t)added;
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
  if (SCR_AX(a)->sparse_len > 0 && SCR_AX(a)->sparse[SCR_AX(a)->sparse_len - 1].index >= need) {
    need = SCR_AX(a)->sparse[SCR_AX(a)->sparse_len - 1].index + 1;
  }
  if (scr_arr_dense_ok(a, need, 1)) scr_arr_grow_dense_to(a, need, SCR_ARR_GROW_SPAN);
}

static uint8_t scr_arr_state_at_storage(const ScrArrStorage *s, size_t index,
                                         uint64_t *out) {
  if (index < s->cap) {
    if (s->present[index] == SCR_ARR_HOLE) return SCR_ARR_HOLE;
    if (out) *out = scr_arr_storage_get(s, index);
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
  ScrArrStorage s = {a->data, a->present, a->cap, SCR_AX(a)->sparse,
                     SCR_AX(a)->sparse_len, SCR_AX(a)->sparse_cap, a->elem, false};
  return scr_arr_slot_at_storage(&s, index, out);
}

static uint8_t scr_arr_state_at(const ScrArr *a, size_t index, uint64_t *out) {
  ScrArrStorage s = {a->data, a->present, a->cap, SCR_AX(a)->sparse,
                     SCR_AX(a)->sparse_len, SCR_AX(a)->sparse_cap, a->elem, false};
  return scr_arr_state_at_storage(&s, index, out);
}

/* Store an owned slot into an empty index. The caller has already established
 * the destination length and does not need a retain. */
static void scr_arr_store_state_owned(ScrArr *a, size_t index, uint64_t slot,
                                      uint8_t state) {
  if (state != SCR_ARR_VALUE) scr_arr_cut(a, index);
  scr_arr_grow_for_index(a, index);
  if (index < a->cap) {
    scr_arr_dense_put(a, index, slot);
    a->present[index] = state;
    return;
  }
  size_t pos = scr_arr_sparse_lower_bound(SCR_AX(a)->sparse, SCR_AX(a)->sparse_len, index);
  if (pos < SCR_AX(a)->sparse_len && SCR_AX(a)->sparse[pos].index == index) {
    SCR_AX(a)->sparse[pos].slot = slot;
    SCR_AX(a)->sparse[pos].state = state;
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
    scr_arr_cut(a, index);
    *out = scr_arr_dense_get(a, index);
    a->present[index] = SCR_ARR_HOLE;
    scr_arr_dense_put(a, index, 0);
    if (state_out) *state_out = state;
    return true;
  }
  size_t pos = scr_arr_sparse_lower_bound(SCR_AX(a)->sparse, SCR_AX(a)->sparse_len, index);
  if (pos == SCR_AX(a)->sparse_len || SCR_AX(a)->sparse[pos].index != index) return false;
  *out = SCR_AX(a)->sparse[pos].slot;
  if (state_out) *state_out = SCR_AX(a)->sparse[pos].state;
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
  if (state != SCR_ARR_VALUE) scr_arr_cut(a, index);
  if (index < a->cap) {
    old_state = a->present[index];
    if (old_state == SCR_ARR_VALUE) old = scr_arr_dense_get(a, index);
    scr_arr_dense_put(a, index, slot);
    a->present[index] = state;
  } else {
    size_t pos = scr_arr_sparse_lower_bound(SCR_AX(a)->sparse, SCR_AX(a)->sparse_len, index);
    if (pos == SCR_AX(a)->sparse_len || SCR_AX(a)->sparse[pos].index != index) {
      scr_arr_store_state_owned(a, index, slot, state);
      return;
    }
    old_state = SCR_AX(a)->sparse[pos].state;
    old = SCR_AX(a)->sparse[pos].slot;
    SCR_AX(a)->sparse[pos].slot = slot;
    SCR_AX(a)->sparse[pos].state = state;
  }
  if (old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, old);
}

/* A value was just stored at `index` (with the length already covering it):
 * extend the hole-free prefix when the store continues it. */
static void scr_arr_note_value(ScrArr *a, size_t index) {
  if (index == a->filled && index < a->cap && index < a->len) a->filled = (uint32_t)index + 1;
}

/* scr_arr_refill bounded to [0, limit): for range operations whose cost is
 * proportional to the range, not to the whole array. */
static void scr_arr_refill_to(ScrArr *a, size_t limit) {
  size_t end = a->len < a->cap ? a->len : a->cap;
  if (limit < end) end = limit;
  size_t f = a->filled;
  if (f < end) f = scr_arr_value_run(a->present, f, end);
  a->filled = (uint32_t)f;
}

static bool scr_arr_prop_get_state(const ScrArr *a, double key, uint64_t *out,
                                   uint8_t *state_out) {
  char text[64];
  size_t len = scr_arr_prop_key(key, text);
  size_t pos = scr_arr_prop_index(a, text, len);
  if (pos == SIZE_MAX) return false;
  if (out) *out = SCR_AX(a)->props[pos].slot;
  if (state_out) *state_out = SCR_AX(a)->props[pos].state;
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
    uint64_t old = SCR_AX(a)->props[pos].slot;
    SCR_AX(a)->props[pos].slot = slot;
    uint8_t old_state = SCR_AX(a)->props[pos].state;
    SCR_AX(a)->props[pos].state = SCR_ARR_VALUE;
    if (old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) {
      scr_elem_release(a, old);
    }
    return;
  }
  scr_arr_grow_props(a, SCR_AX(a)->prop_len + 1);
  char *copy = malloc(len + 1);
  if (!copy) scr_arr_oom();
  memcpy(copy, text, len + 1);
  a->ext->props[a->ext->prop_len++] = (ScrArrProp){copy, len, slot, SCR_ARR_VALUE};
}

static void scr_arr_prop_set_undefined(ScrArr *a, double key) {
  char text[64];
  size_t len = scr_arr_prop_key(key, text);
  size_t pos = scr_arr_prop_index(a, text, len);
  if (pos != SIZE_MAX) {
    uint64_t old = SCR_AX(a)->props[pos].slot;
    uint8_t old_state = SCR_AX(a)->props[pos].state;
    SCR_AX(a)->props[pos].slot = 0;
    SCR_AX(a)->props[pos].state = SCR_ARR_UNDEFINED;
    if (old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) {
      scr_elem_release(a, old);
    }
    return;
  }
  scr_arr_grow_props(a, SCR_AX(a)->prop_len + 1);
  char *copy = malloc(len + 1);
  if (!copy) scr_arr_oom();
  memcpy(copy, text, len + 1);
  a->ext->props[a->ext->prop_len++] = (ScrArrProp){copy, len, 0, SCR_ARR_UNDEFINED};
}

static bool scr_arr_prop_delete(ScrArr *a, double key) {
  char text[64];
  size_t len = scr_arr_prop_key(key, text);
  size_t pos = scr_arr_prop_index(a, text, len);
  if (pos == SIZE_MAX) return false;
  uint64_t old = SCR_AX(a)->props[pos].slot;
  uint8_t old_state = SCR_AX(a)->props[pos].state;
  free(SCR_AX(a)->props[pos].key);
  memmove(SCR_AX(a)->props + pos, SCR_AX(a)->props + pos + 1,
          (SCR_AX(a)->prop_len - pos - 1) * sizeof(*SCR_AX(a)->props));
  a->ext->prop_len--;
  if (old_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) {
    scr_elem_release(a, old);
  }
  return true;
}

bool scr_arr_named_promoted(const ScrArr *a) {
  return a->ext && a->ext->named_state == SCR_ARR_NAMES_PROMOTED;
}

void scr_arr_promote_metadata(ScrArr *a, ScrDyn *metadata) {
  ScrArrExt *x = a->ext;
  ScrArrProp *props = x->props;
  size_t count = x->prop_len;
  ScrDyn *old = x->metadata;
  x->metadata = metadata;
  x->props = NULL;
  x->prop_len = x->prop_cap = 0;
  x->named_state = SCR_ARR_NAMES_PROMOTED;
  for (size_t i = 0; i < count; i++) {
    free(props[i].key);
    if (props[i].state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem))
      scr_elem_release(a, props[i].slot);
  }
  free(props);
  scr_dyn_release(old);
}

static ScrArrStorage scr_arr_take_storage(ScrArr *a) {
  ScrArrStorage old = {a->data, a->present, a->cap, SCR_AX(a)->sparse,
                       SCR_AX(a)->sparse_len, SCR_AX(a)->sparse_cap, a->elem,
                       scr_arr_inline(a)};
  a->spare &= (uint16_t)~SCR_ARR_INLINE_SLOTS;
  a->data = NULL;
  a->present = NULL;
  a->cap = 0;
  a->filled = 0;
  if (a->ext) {
    a->ext->sparse = NULL;
    a->ext->sparse_len = 0;
    a->ext->sparse_cap = 0;
  }
  return old;
}

static void scr_arr_free_storage(ScrArrStorage *s) {
  if (!s->inline_slots) scr_mem_free(s->data);
  scr_arr_sparse_free(s->sparse);
  memset(s, 0, sizeof(*s));
}

/* Dense storage may still contain holes and explicit undefined. These
 * operations move ownership with the slots and move the states alongside
 * them; they never inspect an uninitialized hole payload. */
static bool scr_arr_is_dense(const ScrArr *a) {
  return a->len <= a->cap && SCR_AX(a)->sparse_len == 0;
}

static void scr_arr_move_dense(ScrArr *a, size_t to, size_t from, size_t count) {
  if (count == 0) return;
  scr_arr_cut(a, to);
  memmove(scr_arr_dense_at(a, to), scr_arr_dense_at(a, from), count * scr_arr_slot_width(a));
  memmove(a->present + to, a->present + from, count);
}

static void scr_arr_clear_dense(ScrArr *a, size_t from, size_t count) {
  if (count == 0) return;
  scr_arr_cut(a, from);
  memset(a->present + from, SCR_ARR_HOLE, count);
  memset(scr_arr_dense_at(a, from), 0, count * scr_arr_slot_width(a));
}

/* The destination owns no values in this range. Only retain adapters run
 * while copying references: no release can collect an intermediate copy.
 * Self-appends use disjoint ranges after reserving capacity. Both arrays
 * hold the same element kind, so their slots have the same width. */
static void scr_arr_copy_dense(ScrArr *dst, size_t to, const ScrArr *src,
                                size_t from, size_t count, bool reverse,
                                bool materialize_holes) {
  if (count == 0) return;
  scr_arr_cut(dst, to);
  if (!reverse && dst->elem != SCR_ELEM_BOOL) {
    /* 8-byte slots: a constant slot size. */
    memcpy(dst->data + to, src->data + from, count * sizeof(uint64_t));
    memcpy(dst->present + to, src->present + from, count);
  } else if (!reverse) {
    memcpy(scr_arr_dense_at(dst, to), scr_arr_dense_at(src, from),
           count * scr_arr_slot_width(dst));
    memcpy(dst->present + to, src->present + from, count);
  } else {
    for (size_t i = 0; i < count; i++) {
      size_t source = from + count - i - 1;
      scr_arr_dense_put(dst, to + i, scr_arr_dense_get(src, source));
      dst->present[to + i] = src->present[source];
    }
  }
  bool refs = scr_elem_is_ref(src->elem);
  if (!refs && !materialize_holes) return;
  for (size_t i = to; i < to + count; i++) {
    if (dst->present[i] == SCR_ARR_VALUE) {
      if (refs) dst->data[i] = scr_elem_retain_slot(src, dst->data[i]);
    } else if (materialize_holes && dst->present[i] == SCR_ARR_HOLE) {
      scr_arr_dense_put(dst, i, 0);
      dst->present[i] = SCR_ARR_UNDEFINED;
    }
  }
}

/* Store `count` 8-byte value slots into dense storage starting at `to`. */
static void scr_arr_put_slots(ScrArr *a, size_t to, size_t count, const uint64_t *slots) {
  if (a->elem != SCR_ELEM_BOOL) {
    memcpy(a->data + to, slots, count * sizeof(*slots));
    return;
  }
  for (size_t i = 0; i < count; i++) scr_arr_dense_put(a, to + i, slots[i]);
}

static void scr_arr_gc_free(void *a0);
static ScrCycType scr_arr_cyc_type = {
  .trace = scr_arr_trace_v, .free_fn = scr_arr_gc_free, .kind = SCR_CYC_KIND_ARRAY,
};

static ScrArr *scr_arr_make(ScrElemKind elem, size_t initial_cap, bool small) {
  size_t unit = elem == SCR_ELEM_BOOL ? SCR_ARR_BOOL_SLOT_BYTES : SCR_ARR_SLOT_BYTES;
  size_t inline_cap = small ? scr_arr_small_cap(SCR_ARR_INLINE_OFFSET + sizeof(ScrCycHdr), elem == SCR_ELEM_BOOL) : 0;
  ScrArr *a = scr_cyc_alloc_inline(
      inline_cap ? SCR_ARR_INLINE_OFFSET + inline_cap * unit : sizeof(ScrArr), &scr_arr_cyc_type);
  a->rc = 1;
  a->len = 0;
  a->cap = 0;
  a->elem = (uint8_t)elem;
  a->cyc = 1;
  a->spare = 0;
  a->filled = 0;
  a->ops = NULL;
  a->data = NULL;
  a->present = NULL;
  a->ext = NULL;
  if (inline_cap) scr_arr_use_inline(a, inline_cap);
  else if (initial_cap > 0) scr_arr_grow_dense_to(a, initial_cap, SCR_ARR_GROW_EXACT);
#ifdef SCR_RC_AUDIT
  scr_live_arrays++;
#endif
  return a;
}

ScrArr *scr_arr_new(ScrElemKind elem, size_t initial_cap) {
  return scr_arr_make(elem, initial_cap, false);
}

ScrArr *scr_arr_new_small(ScrElemKind elem) { return scr_arr_make(elem, 0, true); }

/* An array whose final length the runtime knows when it builds
 * it (regex match results): its `cap` slots and states share the header's
 * block, so construction and teardown cost one allocation. Growth past
 * `cap` moves the slots out like any inline array. */
ScrArr *scr_arr_new_inline(ScrElemKind elem, size_t cap) {
  if (cap == 0) return scr_arr_make(elem, 0, false);
  if (cap > SCR_ARR_MAX_LENGTH) scr_arr_oom();
  size_t unit = elem == SCR_ELEM_BOOL ? SCR_ARR_BOOL_SLOT_BYTES : SCR_ARR_SLOT_BYTES;
  ScrArr *a = scr_cyc_alloc_inline(SCR_ARR_INLINE_OFFSET + cap * unit, &scr_arr_cyc_type);
  a->rc = 1;
  a->len = 0;
  a->cap = 0;
  a->elem = (uint8_t)elem;
  a->cyc = 1;
  a->spare = 0;
  a->filled = 0;
  a->ops = NULL;
  a->data = NULL;
  a->present = NULL;
  a->ext = NULL;
  scr_arr_use_inline(a, cap);
#ifdef SCR_RC_AUDIT
  scr_live_arrays++;
#endif
  return a;
}

void scr_arr_outline(ScrArr *a) {
  if (scr_arr_inline(a))
    scr_arr_move_inline(a, a->cap,
                        a->elem == SCR_ELEM_BOOL ? SCR_ARR_BOOL_SLOT_BYTES : SCR_ARR_SLOT_BYTES);
}

void scr_arr_swap_indexed_storage(ScrArr *a, ScrArr *b) {
  if (a == b) return;
  /* Inline slots belong to their header allocation. Detach them before
   * transferring storage; named properties stay with each referent. */
  scr_arr_outline(a);
  scr_arr_outline(b);
  if (SCR_AX(a)->sparse || SCR_AX(b)->sparse) {
    ScrArrExt *wa = scr_arr_ext(a), *wb = scr_arr_ext(b), t = *wa;
    wa->sparse = wb->sparse;
    wa->sparse_len = wb->sparse_len;
    wa->sparse_cap = wb->sparse_cap;
    wb->sparse = t.sparse;
    wb->sparse_len = t.sparse_len;
    wb->sparse_cap = t.sparse_cap;
  }
  ScrArr t = *a;
  a->len = b->len;
  a->cap = b->cap;
  a->data = b->data;
  a->present = b->present;
  a->filled = b->filled;
  b->len = t.len;
  b->cap = t.cap;
  b->data = t.data;
  b->present = t.present;
  b->filled = t.filled;
}

/* Named metadata can close a cycle for every element kind. Indexed slots
 * only carry collector edges for nested arrays and traced REF payloads;
 * interpreting scalar/string/bytes slots as headered objects corrupts GC. */
static bool scr_arr_traces_elements(const ScrArr *a) {
  return a->elem == SCR_ELEM_ARR || (a->elem == SCR_ELEM_REF && a->ops->trace);
}

void scr_arr_trace_v(void *a0, ScrTraceVisit visit, void *ctx) {
  ScrArr *a = (ScrArr *)a0;
  if (SCR_AX(a)->metadata) visit(SCR_AX(a)->metadata, ctx);
  if (!scr_arr_traces_elements(a)) return;
  /* Growth and truncation leave spare capacity empty. Sparse slots and
   * named properties are separate edges, independent of dense length. */
  for (size_t i = 0, end = a->len < a->cap ? a->len : a->cap; i < end; i++) {
    if (a->present[i] == SCR_ARR_VALUE) visit(scr_slot_to_ptr(a->data[i]), ctx);
  }
  for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++) {
    if (SCR_AX(a)->sparse[i].state == SCR_ARR_VALUE) {
      visit(scr_slot_to_ptr(SCR_AX(a)->sparse[i].slot), ctx);
    }
  }
  for (size_t i = 0; i < SCR_AX(a)->prop_len; i++) {
    if (SCR_AX(a)->props[i].state == SCR_ARR_VALUE) {
      visit(scr_slot_to_ptr(SCR_AX(a)->props[i].slot), ctx);
    }
  }
}

/* Frees the out-of-line storage; callers check for it first, since most
 * arrays have none. */
static void scr_arr_ext_free(ScrArr *a) {
  ScrArrExt *x = a->ext;
  scr_arr_sparse_free(x->sparse);
  for (size_t i = 0; i < x->prop_len; i++) free(x->props[i].key);
  free(x->props);
  scr_mem_free(x->named);
  scr_mem_free(x);
  a->ext = NULL;
}

static void scr_arr_dispose(void *a0) {
  ScrArr *a = (ScrArr *)a0;
  if (!scr_arr_inline(a)) scr_mem_free(a->data);
  if (a->ext) scr_arr_ext_free(a);
#ifdef SCR_RC_AUDIT
  scr_live_arrays--;
#endif
  scr_cyc_free_inline(a);
}

/* Collector teardown releases only untraced payloads. Ordinary destruction
 * releases every edge itself, then calls disposal directly to avoid releasing
 * strings, bytes and acyclic REF slots twice. */
static void scr_arr_gc_free(void *a0) {
  ScrArr *a = a0;
  if (scr_elem_is_ref(a->elem) && !scr_arr_traces_elements(a)) {
    for (size_t i = 0, end = a->len < a->cap ? a->len : a->cap; i < end; i++)
      if (a->present[i] == SCR_ARR_VALUE) scr_elem_release(a, a->data[i]);
    for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++)
      if (SCR_AX(a)->sparse[i].state == SCR_ARR_VALUE) scr_elem_release(a, SCR_AX(a)->sparse[i].slot);
    for (size_t i = 0; i < SCR_AX(a)->prop_len; i++)
      if (SCR_AX(a)->props[i].state == SCR_ARR_VALUE) scr_elem_release(a, SCR_AX(a)->props[i].slot);
  }
  scr_arr_dispose(a);
}

static ScrArr *scr_arr_make_ops(const ScrArrOps *ops, size_t initial_cap, bool small) {
  size_t inline_cap =
      small ? scr_arr_small_cap(SCR_ARR_INLINE_OFFSET + sizeof(ScrCycHdr), false) : 0;
  size_t size = inline_cap ? SCR_ARR_INLINE_OFFSET + inline_cap * SCR_ARR_SLOT_BYTES : sizeof(ScrArr);
  ScrArr *a = scr_cyc_alloc_inline(size, &scr_arr_cyc_type);
  a->rc = 1;
  a->len = 0;
  a->cap = 0;
  a->elem = SCR_ELEM_REF;
  a->cyc = 1;
  a->spare = 0;
  a->filled = 0;
  a->ops = ops;
  a->data = NULL;
  a->present = NULL;
  a->ext = NULL;
  if (inline_cap) scr_arr_use_inline(a, inline_cap);
  else if (initial_cap > 0) scr_arr_grow_dense_to(a, initial_cap, SCR_ARR_GROW_EXACT);
#ifdef SCR_RC_AUDIT
  scr_live_arrays++;
#endif
  return a;
}

ScrArr *scr_arr_new_ops(const ScrArrOps *ops, size_t initial_cap) {
  return scr_arr_make_ops(ops, initial_cap, false);
}

ScrArr *scr_arr_new_ops_small(const ScrArrOps *ops) { return scr_arr_make_ops(ops, 0, true); }

static void scr_arr_destroy(void *object) {
  ScrArr *a = object;
  if (a->ext) {
    ScrDyn *metadata = a->ext->metadata;
    a->ext->metadata = NULL;
    scr_dyn_release(metadata);
  }
  if (scr_elem_is_ref(a->elem)) {
    size_t end = a->len < a->cap ? a->len : a->cap;
    if (a->elem == SCR_ELEM_STR) {
      /* Releasing a string runs no user code, so the slots need no clearing
       * first (and the storage cannot move under the loop); immortal strings
       * (interned characters, literals) need no call. */
      const uint64_t *data = a->data;
      const uint8_t *present = a->present;
      for (size_t i = 0; i < end; i++) {
        if (present[i] != SCR_ARR_VALUE) continue;
        ScrStr *s = (ScrStr *)scr_slot_to_ptr(data[i]);
        if (s && s->rc != SIZE_MAX) scr_str_release(s);
      }
    } else {
      for (size_t i = 0; i < end; i++) {
        if (a->present[i] != SCR_ARR_HOLE) {
          uint64_t old = a->data[i];
          uint8_t state = a->present[i];
          a->present[i] = 0;
          a->data[i] = 0;
          if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
        }
      }
    }
    if (a->ext) {
      while (a->ext->sparse_len > 0) {
        size_t i = a->ext->sparse_len - 1;
        uint64_t old = a->ext->sparse[i].slot;
        uint8_t state = a->ext->sparse[i].state;
        a->ext->sparse_len = i;
        if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
      }
      while (a->ext->prop_len > 0) {
        size_t i = a->ext->prop_len - 1;
        uint64_t old = a->ext->props[i].slot;
        uint8_t state = a->ext->props[i].state;
        free(a->ext->props[i].key);
        a->ext->prop_len = i;
        if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
      }
    }
  }
  scr_arr_dispose(a);
}

void scr_arr_release(ScrArr *a) {
  if (!a || a->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--a->rc == 0) {
    if (a->cyc) scr_cyc_dead(a);
    scr_rc_destroy(a, scr_arr_destroy);
  } else if (a->cyc) {
    scr_cyc_released(a); /* possible cycle root; may collect */
  }
}

double scr_arr_len(ScrArr *a) { return SCR_ARR_LEN_F64(a->len); }

bool scr_arr_has(const ScrArr *a, double i) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx)) return scr_arr_named_promoted(a)
      ? scr_dyn_array_named_has(a, i, true) : scr_arr_prop_get(a, i, NULL);
  if (idx >= a->len) return false;
  return scr_arr_slot_at(a, idx, NULL);
}

bool scr_arr_has_property(const ScrArr *a, double i) {
  if (a->ext && a->ext->named) return scr_dyn_array_named_has(a, i, false);
  return scr_arr_has(a, i);
}

double scr_arr_state(const ScrArr *a, double i) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx)) {
    if (scr_arr_named_promoted(a)) return scr_dyn_array_named_state(a, i);
    uint8_t state;
    return scr_arr_prop_get_state(a, i, NULL, &state)
        ? (double)state
        : (double)SCR_ARR_HOLE;
  }
  if (idx >= a->len) return (double)SCR_ARR_HOLE;
  return (double)scr_arr_state_at(a, idx, NULL);
}

double scr_arr_next_present(const ScrArr *a, double start) {
  if (!(start < SCR_ARR_LEN_F64(a->len))) return SCR_ARR_LEN_F64(a->len);
  size_t i = start > 0 ? (size_t)ceil(start) : 0;
  size_t end = a->cap < a->len ? a->cap : a->len;
  for (; i < end; i++) {
    if (a->present[i] != SCR_ARR_HOLE) return (double)i;
  }
  size_t pos = scr_arr_sparse_lower_bound(SCR_AX(a)->sparse, SCR_AX(a)->sparse_len, i);
  if (pos < SCR_AX(a)->sparse_len && SCR_AX(a)->sparse[pos].index < a->len) {
    return (double)SCR_AX(a)->sparse[pos].index;
  }
  return SCR_ARR_LEN_F64(a->len);
}

static void scr_arr_invalid_length(double length) {
  (void)length;
  static const char msg[] = "Invalid array length";
  scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
}

/* Native arrays and template-site arrays use SIZE_MAX only when immutable.
 * Metadata covers ordinary heap arrays; publication retires that metadata. */
unsigned scr_arr_integrity_flags(const ScrArr *a) {
  return a->rc == SIZE_MAX ? SCR_NATIVE_FROZEN : scr_native_integrity_flags(a);
}

static bool scr_arr_reject_key(const char *format, double index) {
  char key[64], message[192];
  scr_f64_to_str(index, key);
  int n = snprintf(message, sizeof message, format, key);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)n);
  return false;
}

bool scr_arr_check_set_mode(const ScrArr *a, double index, bool strict) {
  unsigned flags = scr_arr_integrity_flags(a);
  if (!flags) return true;
  if (scr_arr_has(a, index)) {
    if ((flags & SCR_NATIVE_FROZEN) != SCR_NATIVE_FROZEN) return true;
    if (strict) scr_arr_reject_key(
        "Cannot assign to read only property '%s' of object '[object Array]'", index);
    return false;
  }
  if (!(flags & SCR_NATIVE_NON_EXTENSIBLE)) return true;
  if (strict) scr_arr_reject_key("Cannot add property %s, object is not extensible", index);
  return false;
}

bool scr_arr_check_set(const ScrArr *a, double index) {
  return scr_arr_check_set_mode(a, index, true);
}

static bool scr_arr_can_delete(const ScrArr *a, double index, bool strict) {
  if ((scr_arr_integrity_flags(a) & SCR_NATIVE_SEALED) != SCR_NATIVE_SEALED ||
      !scr_arr_has(a, index)) return true;
  if (strict) scr_arr_reject_key("Cannot delete property '%s' of [object Array]", index);
  return false;
}

bool scr_arr_check_delete(const ScrArr *a, double index) {
  return scr_arr_can_delete(a, index, true);
}

bool scr_arr_check_length_mode(const ScrArr *a, bool strict) {
  if ((scr_arr_integrity_flags(a) & SCR_NATIVE_FROZEN) != SCR_NATIVE_FROZEN) return true;
  if (strict) {
    static const char message[] = "Cannot assign to read only property 'length' of object '[object Array]'";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  }
  return false;
}

bool scr_arr_check_length(const ScrArr *a) {
  return scr_arr_check_length_mode(a, true);
}

/* Consumes a present value even when Set fails. Undefined carries no
 * payload; holes use Delete instead. Every successful store installs its
 * edge before releasing the old value, including partial range mutations. */
static bool scr_arr_set_state_owned(ScrArr *a, double i, uint64_t slot, uint8_t state) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx) && scr_arr_named_promoted(a)) {
    bool ok = scr_dyn_array_named_set(a, i, slot, state, true);
    if (state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, slot);
    return ok;
  }
  if (!scr_arr_check_set(a, i)) {
    if (state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, slot);
    return false;
  }
  if (!scr_arr_valid_index(i, &idx)) {
    if (state == SCR_ARR_VALUE) scr_arr_prop_set(a, i, slot);
    else scr_arr_prop_set_undefined(a, i);
    return true;
  }
  if (idx >= a->len) a->len = idx + 1;
  scr_arr_replace_state_owned(a, idx, slot, state);
  if (state == SCR_ARR_VALUE) scr_arr_note_value(a, idx);
  return true;
}

bool scr_arr_set_len_mode(ScrArr *a, double length, bool strict) {
  if (!scr_arr_check_length_mode(a, strict)) return false;
  if (!(length >= 0) || !isfinite(length) || length != trunc(length) ||
      length > (double)SCR_ARR_MAX_LENGTH) {
    scr_arr_invalid_length(length);
    return false;
  }
  size_t next = (size_t)length;
  if (next < a->len) {
    if ((scr_arr_integrity_flags(a) & SCR_NATIVE_SEALED) == SCR_NATIVE_SEALED) {
      /* ArraySetLength deletes highest indices first. All present slots are
       * nonconfigurable: only trailing holes disappear before the refusal.
       * Inspect sparse entries directly instead of walking a huge hole. */
      size_t stop = next;
      size_t sparse = SCR_AX(a)->sparse_len;
      if (sparse && SCR_AX(a)->sparse[sparse - 1].index >= next) {
        stop = SCR_AX(a)->sparse[sparse - 1].index + 1;
      } else {
        size_t end = a->len < a->cap ? a->len : a->cap;
        for (size_t i = end; i > next; i--) {
          if (a->present[i - 1] != SCR_ARR_HOLE) {
            stop = i;
            break;
          }
        }
      }
      a->len = stop;
      scr_arr_cut(a, stop);
      if (stop > next && strict)
        scr_arr_reject_key("Cannot delete property '%s' of [object Array]", (double)(stop - 1));
      return stop == next;
    }
    scr_arr_cut(a, next);
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
      if (a->ext) {
        size_t keep = scr_arr_sparse_lower_bound(a->ext->sparse, a->ext->sparse_len, next);
        while (a->ext->sparse_len > keep) {
          size_t i = a->ext->sparse_len - 1;
          uint64_t old = a->ext->sparse[i].slot;
          uint8_t state = a->ext->sparse[i].state;
          a->ext->sparse_len = i;
          if (state == SCR_ARR_VALUE) scr_elem_release(a, old);
        }
      }
    } else {
      if (dense_stop < dense_end) {
        memset(a->present + dense_stop, 0, dense_end - dense_stop);
        memset(scr_arr_dense_at(a, dense_stop), 0,
               (dense_end - dense_stop) * scr_arr_slot_width(a));
      }
      if (a->ext) a->ext->sparse_len = scr_arr_sparse_lower_bound(a->ext->sparse, a->ext->sparse_len, next);
    }
  }
  a->len = next;
  return true;
}

void scr_arr_set_len(ScrArr *a, double length) {
  (void)scr_arr_set_len_mode(a, length, true);
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

static void scr_arr_copy_range_states(ScrArr *dst, size_t dst_start, const ScrArr *src,
                                      size_t src_start, size_t count, bool reverse,
                                      bool materialize_holes);

void scr_arr_copy_range_ex(ScrArr *dst, size_t dst_start, const ScrArr *src,
                           size_t src_start, size_t count, bool reverse,
                           bool materialize_holes) {
  if (count == 0) return;
  scr_arr_copy_range_states(dst, dst_start, src, src_start, count, reverse, materialize_holes);
  scr_arr_refill_to(dst, dst_start + count);
}

static void scr_arr_copy_range_states(ScrArr *dst, size_t dst_start, const ScrArr *src,
                                      size_t src_start, size_t count, bool reverse,
                                      bool materialize_holes) {
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
  size_t pos = scr_arr_sparse_lower_bound(SCR_AX(src)->sparse, SCR_AX(src)->sparse_len, src_start);
  for (; pos < SCR_AX(src)->sparse_len && SCR_AX(src)->sparse[pos].index < end; pos++) {
    size_t i = SCR_AX(src)->sparse[pos].index;
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

/* A mutation copy observes presence: a hole deletes the destination.
 * Retain before replacing so overlapping moves publish the new edge before
 * releasing the old one, even if that release runs cycle collection. */
static bool scr_arr_copy_index_checked(ScrArr *a, size_t to, size_t from) {
  uint64_t slot = 0;
  uint8_t state = scr_arr_state_at(a, from, &slot);
  if (state == SCR_ARR_HOLE) {
    scr_arr_delete(a, (double)to);
    return !scr_exc_pending();
  }
  if (state == SCR_ARR_VALUE) slot = scr_elem_retain_slot(a, slot);
  return scr_arr_set_state_owned(a, (double)to, slot, state);
}

ScrArr *scr_arr_copy_within(ScrArr *a, double target, double start, double end) {
  size_t to = scr_arr_relative_index(target, a->len);
  size_t from = scr_arr_relative_index(start, a->len);
  size_t last = scr_arr_relative_index(end, a->len);
  size_t count = last > from ? last - from : 0;
  if (count > a->len - to) count = a->len - to;
  if (count == 0) return scr_arr_retain(a);
  bool restricted = scr_arr_integrity_flags(a) != 0;
  if (from == to && !restricted) return scr_arr_retain(a);
  if (!restricted && !scr_elem_is_ref(a->elem) && from < a->cap && count <= a->cap - from &&
      to < a->cap && count <= a->cap - to) {
    /* Values moved within the hole-free prefix keep it. */
    size_t f = a->filled;
    scr_arr_move_dense(a, to, from, count);
    if (from + count <= f && to + count <= f) a->filled = (uint32_t)f;
    else scr_arr_refill_to(a, to + count);
    return scr_arr_retain(a);
  }
  bool backwards = from < to && to - from < count;
  for (size_t i = 0; i < count; i++) {
    size_t offset = backwards ? count - i - 1 : i;
    if (!scr_arr_copy_index_checked(a, to + offset, from + offset)) return NULL;
  }
  scr_arr_refill_to(a, to + count);
  return scr_arr_retain(a);
}

static ScrArr *scr_arr_fill_slot(ScrArr *a, uint64_t slot, uint8_t state,
                                  double start, double end) {
  size_t from = scr_arr_relative_index(start, a->len);
  size_t until = scr_arr_relative_index(end, a->len);
  if (from >= until) return scr_arr_retain(a);
  bool refs = scr_elem_is_ref(a->elem);
  bool restricted = scr_arr_integrity_flags(a) != 0;
  if (!restricted && scr_arr_dense_ok(a, until, until - from)) scr_arr_grow_dense(a, until);
  if (!restricted && !refs && until <= a->cap) {
    if (state != SCR_ARR_VALUE) scr_arr_cut(a, from);
    if (a->elem == SCR_ELEM_BOOL) memset(scr_arr_dense_at(a, from), (int)slot, until - from);
    else for (size_t i = from; i < until; i++) a->data[i] = slot;
    memset(a->present + from, state, until - from);
  } else {
    for (size_t i = from; i < until; i++) {
      uint64_t value = refs && state == SCR_ARR_VALUE ? scr_elem_retain_slot(a, slot) : slot;
      if (!scr_arr_set_state_owned(a, (double)i, value, state)) return NULL;
    }
  }
  if (state == SCR_ARR_VALUE) scr_arr_refill(a);
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

static uint64_t scr_arr_require_slot(const ScrArr *a, double i) {
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

/* Compiler slot reads never resolve descriptors or invoke user code. Once
 * names are promoted, their detached raw slots are absent by construction. */
double scr_arr_get_slot_f64(const ScrArr *a, double i) {
  return scr_slot_to_f64(scr_arr_require_slot(a, i));
}
bool scr_arr_get_slot_bool(const ScrArr *a, double i) {
  return scr_arr_require_slot(a, i) != 0;
}
void *scr_arr_borrow_slot_ref(const ScrArr *a, double i) {
  return scr_slot_to_ptr(scr_arr_require_slot(a, i));
}

double scr_arr_get_f64(ScrArr *a, double i) {
  size_t index;
  if (!scr_arr_valid_index(i, &index) && scr_arr_named_promoted(a)) {
    ScrDyn *value = scr_arr_property_get(a, i);
    double out = 0;
    if (value && value->kind == SCR_DYN_NUM) out = value->v.num;
    else if (!scr_exc_pending()) scr_dyn_check_fail(NULL, "number", value);
    scr_dyn_release(value);
    return out;
  }
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
  size_t index;
  if (!scr_arr_valid_index(i, &index) && scr_arr_named_promoted(a)) return NULL;
  /* Dense in-range canonical indices answer from the state byte without
   * the general lookup; the range check precedes the cast. */
  if (i >= 0 && i < (double)a->cap) {
    size_t idx = (size_t)i;
    if ((double)idx == i) {
      if (idx < a->filled) return scr_slot_to_ptr(a->data[idx]);
      if (idx >= a->len || a->present[idx] != SCR_ARR_VALUE) return NULL;
      return scr_slot_to_ptr(a->data[idx]);
    }
  }
  uint64_t slot;
  return scr_arr_read_value(a, i, &slot) ? scr_slot_to_ptr(slot) : NULL;
}

double scr_arr_get_slot_number(const ScrArr *a, double i) {
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

double scr_arr_get_number(const ScrArr *a, double i) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx) && scr_arr_named_promoted(a)) {
    ScrDyn *value = scr_arr_property_get(a, i);
    double number = NAN;
    if (value) scr_dyn_number_coerce_js(value, &number);
    scr_dyn_release(value);
    return number;
  }
  return scr_arr_get_slot_number(a, i);
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
    av = scr_arr_dense_get(a, ai);
    bv = scr_arr_dense_get(b, bi);
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
  size_t index;
  if (!scr_arr_valid_index(i, &index) && scr_arr_named_promoted(a)) {
    ScrDyn *value = scr_arr_property_get(a, i);
    bool out = value && value->kind == SCR_DYN_BOOL && value->v.b;
    if ((!value || value->kind != SCR_DYN_BOOL) && !scr_exc_pending())
      scr_dyn_check_fail(NULL, "boolean", value);
    scr_dyn_release(value);
    return out;
  }
  return scr_arr_require_slot(a, i) != 0;
}

void *scr_arr_get_ref(ScrArr *a, double i) {
  size_t index;
  if (!scr_arr_valid_index(i, &index) && scr_arr_named_promoted(a)) {
    ScrDyn *value = scr_arr_property_get(a, i);
    uint64_t slot = 0;
    if (value) scr_arr_property_unbox(a, value, &slot);
    scr_dyn_release(value);
    return scr_slot_to_ptr(slot);
  }
  return scr_arr_get_slot_ref(a, i);
}

void *scr_arr_get_slot_ref(const ScrArr *a, double i) {
  void *p = scr_slot_to_ptr(scr_arr_require_slot(a, i));
  if (!p) return NULL;
  if (a->elem == SCR_ELEM_STR) scr_str_retain((ScrStr *)p);
  else if (a->elem == SCR_ELEM_BYTES) scr_bytes_retain((ScrBytes *)p);
  else if (a->elem == SCR_ELEM_REF) p = a->ops->retain(p);
  else scr_arr_retain((ScrArr *)p);
  return p;
}

void *scr_arr_borrow_ref(ScrArr *a, double i) {
  size_t index;
  if (!scr_arr_valid_index(i, &index) && scr_arr_named_promoted(a)) {
    static const char message[] = "Named array properties require an owned read";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  return scr_slot_to_ptr(scr_arr_require_slot(a, i));
}

/* ── writes: i == len appends ──────────────────────────────────────────── */

void scr_arr_set_f64(ScrArr *a, double i, double v) {
  scr_arr_set_state_owned(a, i, scr_slot_from_f64(v), SCR_ARR_VALUE);
}

void scr_arr_set_bool(ScrArr *a, double i, bool v) {
  scr_arr_set_state_owned(a, i, (uint64_t)(v ? 1 : 0), SCR_ARR_VALUE);
}

void scr_arr_set_ref(ScrArr *a, double i, void *v) {
  scr_arr_set_state_owned(a, i, scr_slot_from_ptr(v), SCR_ARR_VALUE);
}

void scr_arr_set_undefined(ScrArr *a, double i) {
  scr_arr_set_state_owned(a, i, 0, SCR_ARR_UNDEFINED);
}

bool scr_arr_delete_mode(ScrArr *a, double i, bool strict) {
  size_t idx;
  if (!scr_arr_valid_index(i, &idx) && scr_arr_named_promoted(a))
    return scr_dyn_array_named_delete(a, i, strict);
  if (!scr_arr_can_delete(a, i, strict)) return false;
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

bool scr_arr_delete(ScrArr *a, double i) {
  return scr_arr_delete_mode(a, i, true);
}

/* Splice normalizes before mutation. All entry points share the same plan;
 * only unrestricted receivers may move storage without ordered Set/Delete. */
typedef struct {
  size_t old_len, from, remove, add, next_len;
} ScrSplicePlan;

static ScrSplicePlan scr_arr_splice_plan(const ScrArr *a, double start,
                                          double delete_count, size_t add) {
  size_t from = scr_arr_relative_index(start, a->len);
  double available = (double)(a->len - from);
  double count = isnan(delete_count) ? 0 : trunc(delete_count);
  size_t remove = count <= 0 ? 0 : count >= available ? (size_t)available : (size_t)count;
  if (add > SCR_ARR_MAX_LENGTH - (a->len - remove)) scr_arr_oom();
  return (ScrSplicePlan){a->len, from, remove, add, a->len - remove + add};
}

static bool scr_arr_replace_range_checked(ScrArr *a, ScrSplicePlan p, const ScrArr *items) {
  if (p.add < p.remove) {
    for (size_t i = p.from; i < p.old_len - p.remove; i++)
      if (!scr_arr_copy_index_checked(a, i + p.add, i + p.remove)) return false;
    for (size_t i = p.old_len; i > p.next_len; i--) {
      scr_arr_delete(a, (double)(i - 1));
      if (scr_exc_pending()) return false;
    }
  } else if (p.add > p.remove) {
    for (size_t i = p.old_len - p.remove; i > p.from; i--)
      if (!scr_arr_copy_index_checked(a, i + p.add - 1, i + p.remove - 1)) return false;
  }
  for (size_t i = 0; i < p.add; i++) {
    uint64_t slot = 0;
    uint8_t state = scr_arr_state_at(items, i, &slot);
    if (state == SCR_ARR_VALUE) slot = scr_elem_retain_slot(items, slot);
    else state = SCR_ARR_UNDEFINED; /* Spread iteration materializes holes. */
    if (!scr_arr_set_state_owned(a, (double)(p.from + i), slot, state)) return false;
  }
  /* All three mutators write length, even when no arguments change it. */
  scr_arr_set_len(a, (double)p.next_len);
  return !scr_exc_pending();
}

/* Restricted extension shares splice's ordered mutation owner. Owned
 * arguments stay in one temporary until success or refusal, so a failed
 * tail move also releases every value that was never inserted. */
static double scr_arr_extend_checked(ScrArr *a, size_t count, const uint64_t *slots,
                                        const ScrArr *src, bool prepend) {
  ScrArr *owned = NULL;
  if (!src) {
    owned = a->elem == SCR_ELEM_REF ? scr_arr_new_ops(a->ops, count) : scr_arr_new(a->elem, count);
    scr_arr_push_many(owned, count, slots);
    src = owned;
  } else if (src == a) {
    owned = scr_arr_slice(a, 0, INFINITY);
    src = owned;
  }
  ScrSplicePlan p = scr_arr_splice_plan(a, prepend ? 0 : (double)a->len, 0, count);
  bool ok = scr_arr_replace_range_checked(a, p, src);
  scr_arr_release(owned);
  return ok ? (double)p.next_len : 0;
}

/* ── push / pop ────────────────────────────────────────────────────────── */

static double scr_arr_push_slot(ScrArr *a, uint64_t slot) {
  if (scr_arr_integrity_flags(a)) return scr_arr_extend_checked(a, 1, &slot, NULL, false);
  /* scr_arr_check_index(a, len, true) without the double round trip: the
   * length is an integer, so only the upper bound can fail. */
  if (a->len > SCR_ARR_MAX_INDEX) scr_arr_trap_oob(SCR_ARR_LEN_F64(a->len), a->len);
  size_t idx = a->len;
  scr_arr_store_owned(a, idx, slot);
  a->len++;
  scr_arr_note_value(a, idx);
  return SCR_ARR_LEN_F64(a->len);
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
  if (scr_arr_integrity_flags(a)) return scr_arr_extend_checked(a, count, slots, NULL, false);
  if (count > SCR_ARR_MAX_LENGTH - a->len) scr_arr_oom();
  size_t from = a->len, next = from + count;
  if (scr_arr_dense_ok(a, next, count)) {
    scr_arr_grow_dense(a, next);
    if (count) {
      scr_arr_put_slots(a, from, count, slots);
      memset(a->present + from, SCR_ARR_VALUE, count);
    }
  } else {
    for (size_t i = 0; i < count; i++) scr_arr_store_owned(a, from + i, slots[i]);
  }
  a->len = next;
  scr_arr_refill(a);
  return (double)next;
}

double scr_arr_push_spread(ScrArr *a, const ScrArr *src) {
  if (scr_arr_integrity_flags(a)) return scr_arr_extend_checked(a, src->len, NULL, src, false);
  size_t old_len = a->len;
  size_t add = src->len;
  if (add > SCR_ARR_MAX_LENGTH - old_len) scr_arr_oom();
  if (scr_arr_is_dense(a) && scr_arr_is_dense(src) &&
      scr_arr_dense_ok(a, old_len + add, add)) {
    scr_arr_grow_dense(a, old_len + add);
    scr_arr_copy_dense(a, old_len, src, 0, add, false, true);
    a->len += add;
    scr_arr_refill(a);
    return SCR_ARR_LEN_F64(a->len);
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
    scr_arr_refill(a);
    return SCR_ARR_LEN_F64(a->len);
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
  scr_arr_refill(a);
  return SCR_ARR_LEN_F64(a->len);
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
    scr_arr_refill(a);
    return SCR_ARR_LEN_F64(a->len);
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
    scr_arr_refill(a);
    return SCR_ARR_LEN_F64(a->len);
  }
  a->len = old_len + add;
  for (size_t i = 0; i < src->cap; i++) {
    if (src->present[i] != SCR_ARR_HOLE) {
      scr_arr_copy_index(a, old_len + i, src, i);
    }
  }
  for (size_t i = 0; i < SCR_AX(src)->sparse_len; i++) {
    scr_arr_copy_index(a, old_len + SCR_AX(src)->sparse[i].index, src,
                       SCR_AX(src)->sparse[i].index);
  }
  scr_arr_refill(a);
  return SCR_ARR_LEN_F64(a->len);
}

/* ── unshift / reverse ──────────────────────────────────────────────────
 * Every entry point takes the complete argument count before moving the
 * receiver. The spread form borrows its source; unrestricted self-spread
 * reads the relocated original block after the tail move. */
static double scr_arr_unshift_slot(ScrArr *a, uint64_t slot) {
  if (scr_arr_integrity_flags(a)) return scr_arr_extend_checked(a, 1, &slot, NULL, true);
  if (a->len == SCR_ARR_MAX_LENGTH) {
    scr_arr_trap_oob(SCR_ARR_LEN_F64(a->len), a->len);
  }
  size_t old_len = a->len;
  if (scr_arr_is_dense(a) && scr_arr_dense_ok(a, old_len + 1, 1)) {
    scr_arr_grow_dense(a, old_len + 1);
    /* The prefix moves up behind the new first value. */
    size_t f = a->filled;
    scr_arr_move_dense(a, 1, 0, old_len);
    scr_arr_dense_put(a, 0, slot);
    a->present[0] = SCR_ARR_VALUE;
    a->len++;
    a->filled = (uint32_t)(f + 1);
    return SCR_ARR_LEN_F64(a->len);
  }
  ScrArrStorage old = scr_arr_take_storage(a);
  a->len = 0;
  scr_arr_store_owned(a, 0, slot);
  for (size_t i = 0; i < old.cap; i++) {
    if (old.present[i])
      scr_arr_store_state_owned(a, i + 1, scr_arr_storage_get(&old, i), old.present[i]);
  }
  for (size_t i = 0; i < old.sparse_len; i++) {
    scr_arr_store_state_owned(a, old.sparse[i].index + 1, old.sparse[i].slot,
                              old.sparse[i].state);
  }
  a->len = old_len + 1;
  scr_arr_free_storage(&old);
  scr_arr_refill(a);
  return SCR_ARR_LEN_F64(a->len);
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
  if (scr_arr_integrity_flags(a)) return scr_arr_extend_checked(a, count, slots, NULL, true);
  size_t old_len = a->len;
  if (count == 0) return (double)old_len;
  if (count > SCR_ARR_MAX_LENGTH - old_len) scr_arr_oom();
  if (scr_arr_is_dense(a) && scr_arr_dense_ok(a, old_len + count, count)) {
    scr_arr_grow_dense(a, old_len + count);
    size_t f = a->filled;
    scr_arr_move_dense(a, count, 0, old_len);
    scr_arr_put_slots(a, 0, count, slots);
    memset(a->present, SCR_ARR_VALUE, count);
    a->len = old_len + count;
    a->filled = (uint32_t)(f + count);
    return SCR_ARR_LEN_F64(a->len);
  } else {
    ScrArrStorage old = scr_arr_take_storage(a);
    for (size_t i = 0; i < count; i++) scr_arr_store_owned(a, i, slots[i]);
    for (size_t i = 0; i < old.cap; i++) {
      if (old.present[i] != SCR_ARR_HOLE)
        scr_arr_store_state_owned(a, i + count, scr_arr_storage_get(&old, i), old.present[i]);
    }
    for (size_t i = 0; i < old.sparse_len; i++) {
      scr_arr_store_state_owned(a, old.sparse[i].index + count,
                                old.sparse[i].slot, old.sparse[i].state);
    }
    scr_arr_free_storage(&old);
  }
  a->len = old_len + count;
  scr_arr_refill(a);
  return SCR_ARR_LEN_F64(a->len);
}

double scr_arr_unshift_spread(ScrArr *a, const ScrArr *src) {
  if (scr_arr_integrity_flags(a)) return scr_arr_extend_checked(a, src->len, NULL, src, true);
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
    scr_arr_refill(a);
    return SCR_ARR_LEN_F64(a->len);
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
      scr_arr_store_state_owned(a, i + add, scr_arr_storage_get(&old, i), old.present[i]);
    }
  }
  for (size_t i = 0; i < old.sparse_len; i++) {
    scr_arr_store_state_owned(a, old.sparse[i].index + add,
                              old.sparse[i].slot, old.sparse[i].state);
  }
  a->len = old_len + add;
  scr_arr_free_storage(&old);
  scr_arr_refill(a);
  return SCR_ARR_LEN_F64(a->len);
}

ScrArr *scr_arr_reverse(ScrArr *a) {
  size_t len = a->len;
  if (scr_arr_integrity_flags(a)) {
    for (size_t lower = 0; lower < len / 2; lower++) {
      size_t upper = len - lower - 1;
      uint64_t low = 0, high = 0;
      uint8_t low_state = scr_arr_state_at(a, lower, &low);
      uint8_t high_state = scr_arr_state_at(a, upper, &high);
      /* Both reads precede either mutation. Keep the lower value alive
       * across its deletion/replacement until the upper Set consumes it. */
      low = scr_arr_retain_state_slot(a, low, low_state);
      high = scr_arr_retain_state_slot(a, high, high_state);
      if (high_state != SCR_ARR_HOLE) {
        if (!scr_arr_set_state_owned(a, (double)lower, high, high_state)) {
          if (low_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, low);
          return NULL;
        }
      } else if (low_state != SCR_ARR_HOLE) {
        scr_arr_delete(a, (double)lower);
        if (scr_exc_pending()) {
          if (low_state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, low);
          return NULL;
        }
      }
      if (low_state != SCR_ARR_HOLE) {
        if (!scr_arr_set_state_owned(a, (double)upper, low, low_state)) return NULL;
      } else if (high_state != SCR_ARR_HOLE) {
        scr_arr_delete(a, (double)upper);
        if (scr_exc_pending()) return NULL;
      }
    }
    scr_arr_refill(a);
    return scr_arr_retain(a);
  }
  if (scr_arr_is_dense(a)) {
    /* A hole-free array stays hole-free; any other prefix is recomputed. */
    if (a->filled != len) scr_arr_cut(a, 0);
    for (size_t i = 0; i < len / 2; i++) {
      size_t j = len - i - 1;
      uint64_t slot = scr_arr_dense_get(a, i);
      scr_arr_dense_put(a, i, scr_arr_dense_get(a, j));
      scr_arr_dense_put(a, j, slot);
      uint8_t state = a->present[i];
      a->present[i] = a->present[j];
      a->present[j] = state;
    }
    scr_arr_refill(a);
    return scr_arr_retain(a);
  }
  ScrArrStorage old = scr_arr_take_storage(a);
  a->len = len;
  for (size_t i = 0; i < old.cap; i++) {
    if (old.present[i])
      scr_arr_store_state_owned(a, len - 1 - i, scr_arr_storage_get(&old, i), old.present[i]);
  }
  for (size_t i = 0; i < old.sparse_len; i++) {
    scr_arr_store_state_owned(a, len - 1 - old.sparse[i].index,
                              old.sparse[i].slot, old.sparse[i].state);
  }
  scr_arr_free_storage(&old);
  scr_arr_refill(a);
  return scr_arr_retain(a);
}

/* Removal returns an owned value only after every mutation succeeds.
 * Discarded results release after storage is consistent so collection
 * cannot trace an outgoing edge that the receiver no longer owns. */
static uint8_t scr_arr_removed_state(ScrArr *a, uint64_t slot, uint8_t state,
                                     uint64_t *slot_out) {
  if (slot_out) *slot_out = state == SCR_ARR_VALUE ? slot : 0;
  else if (state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, slot);
  return state;
}

uint8_t scr_arr_pop_state(ScrArr *a, uint64_t *slot_out) {
  if (slot_out) *slot_out = 0;
  if (a->len == 0) {
    scr_arr_check_length(a);
    return SCR_ARR_HOLE;
  }
  size_t idx = a->len - 1;
  /* Uniform native restrictions have no independently readonly length:
   * check Delete then length before transferring the outgoing value. */
  if (!scr_arr_check_delete(a, (double)idx) || !scr_arr_check_length(a)) return SCR_ARR_HOLE;
  uint64_t slot = 0;
  uint8_t state = SCR_ARR_HOLE;
  if (!scr_arr_take_state(a, idx, &slot, &state)) state = SCR_ARR_HOLE;
  a->len = idx;
  return scr_arr_removed_state(a, slot, state, slot_out);
}

static uint64_t scr_arr_pop_slot(ScrArr *a) {
  uint64_t slot = 0;
  uint8_t state = scr_arr_pop_state(a, &slot);
  if (scr_exc_pending()) return 0;
  if (state != SCR_ARR_VALUE) {
    scr_trap("scriptc: RangeError: pop() returned undefined\n");
  }
  return slot;
}

double scr_arr_pop_f64(ScrArr *a) { return scr_slot_to_f64(scr_arr_pop_slot(a)); }

bool scr_arr_pop_bool(ScrArr *a) { return scr_arr_pop_slot(a) != 0; }

void *scr_arr_pop_ref(ScrArr *a) { return scr_slot_to_ptr(scr_arr_pop_slot(a)); }

/* ── shift ─────────────────────────────────────────────────────────────
 * The first element out, tail sliding down. Restricted receivers preserve
 * each completed Set/Delete and retain the result across replacements.
 * Unrestricted storage transfers the outgoing edge without a retain. */
uint8_t scr_arr_shift_state(ScrArr *a, uint64_t *slot_out) {
  if (slot_out) *slot_out = 0;
  if (a->len == 0) {
    scr_arr_check_length(a);
    return SCR_ARR_HOLE;
  }
  size_t old_len = a->len;
  if (scr_arr_integrity_flags(a)) {
    uint64_t first = 0;
    uint8_t state = scr_arr_state_at(a, 0, &first);
    first = scr_arr_retain_state_slot(a, first, state);
    scr_arr_release(scr_arr_copy_within(a, 0, 1, (double)old_len));
    if (!scr_exc_pending()) scr_arr_delete(a, (double)(old_len - 1));
    if (!scr_exc_pending()) scr_arr_set_len(a, (double)(old_len - 1));
    if (scr_exc_pending()) {
      if (state == SCR_ARR_VALUE && scr_elem_is_ref(a->elem)) scr_elem_release(a, first);
      return SCR_ARR_HOLE;
    }
    return scr_arr_removed_state(a, first, state, slot_out);
  }
  if (scr_arr_is_dense(a)) {
    uint8_t state = a->present[0];
    uint64_t first = state == SCR_ARR_VALUE ? scr_arr_dense_get(a, 0) : 0;
    /* The prefix slides down with the tail. */
    size_t f = a->filled;
    scr_arr_move_dense(a, 0, 1, old_len - 1);
    scr_arr_clear_dense(a, old_len - 1, 1);
    a->len--;
    a->filled = (uint32_t)(f ? f - 1 : 0);
    return scr_arr_removed_state(a, first, state, slot_out);
  }
  ScrArrStorage old = scr_arr_take_storage(a);
  uint64_t s = 0;
  uint8_t state = scr_arr_state_at_storage(&old, 0, &s);
  a->len = 0;
  for (size_t i = 1; i < old.cap; i++) {
    if (old.present[i])
      scr_arr_store_state_owned(a, i - 1, scr_arr_storage_get(&old, i), old.present[i]);
  }
  for (size_t i = 0; i < old.sparse_len; i++) {
    if (old.sparse[i].index > 0) {
      scr_arr_store_state_owned(a, old.sparse[i].index - 1, old.sparse[i].slot,
                                old.sparse[i].state);
    }
  }
  a->len = old_len - 1;
  scr_arr_free_storage(&old);
  scr_arr_refill(a);
  return scr_arr_removed_state(a, s, state, slot_out);
}

static uint64_t scr_arr_shift_slot(ScrArr *a) {
  uint64_t s = 0;
  uint8_t state = scr_arr_shift_state(a, &s);
  if (scr_exc_pending()) return 0;
  if (state != SCR_ARR_VALUE) {
    scr_trap("scriptc: RangeError: shift() returned undefined\n");
  }
  return s;
}

double scr_arr_shift_f64(ScrArr *a) { return scr_slot_to_f64(scr_arr_shift_slot(a)); }

bool scr_arr_shift_bool(ScrArr *a) { return scr_arr_shift_slot(a) != 0; }

void *scr_arr_shift_ref(ScrArr *a) { return scr_slot_to_ptr(scr_arr_shift_slot(a)); }

static ScrArr *scr_arr_splice_checked(ScrArr *a, ScrSplicePlan p, const ScrArr *items) {
  /* Keep the removed snapshot owned while partial writes replace receiver
   * edges. Failure drops the result without undoing completed mutations. */
  ScrArr *out = scr_arr_slice(a, (double)p.from, (double)(p.from + p.remove));
  if (scr_arr_replace_range_checked(a, p, items)) return out;
  scr_arr_release(out);
  return NULL;
}

static ScrArr *scr_arr_splice_unrestricted(ScrArr *a, ScrSplicePlan p,
                                            const ScrArr *items) {
  size_t from = p.from, n = p.remove;
  bool dense = scr_arr_is_dense(a);
  size_t hint = dense || n <= SCR_ARR_DENSE_LIMIT ? n : SCR_ARR_DENSE_LIMIT;
  ScrArr *out = a->elem == SCR_ELEM_REF
      ? scr_arr_new_ops(a->ops, hint ? hint : 1)
      : scr_arr_new(a->elem, hint ? hint : 1);
  out->len = n;
  if (dense && (!items || scr_arr_is_dense(items)) && scr_arr_dense_ok(a, p.next_len, p.add)) {
    if (n) {
      memcpy(out->data, scr_arr_dense_at(a, from), n * scr_arr_slot_width(a));
      memcpy(out->present, a->present + from, n);
    }
    scr_arr_refill(out);
    scr_arr_grow_dense(a, p.next_len);
    scr_arr_move_dense(a, from + p.add, from + n, p.old_len - from - n);
    if (p.add) scr_arr_copy_dense(a, from, items, 0, p.add, false, true);
    if (p.next_len < p.old_len) scr_arr_clear_dense(a, p.next_len, p.old_len - p.next_len);
    a->len = p.next_len;
    scr_arr_refill(a);
    return out;
  }
  /* Transfer each old edge exactly once. A sparse receiver must not be
   * split with public splice calls: those calls can fail partway through. */
  ScrArrStorage old = scr_arr_take_storage(a);
  a->len = 0;
  for (size_t i = 0; i < old.cap; i++) {
    if (old.present[i] == SCR_ARR_HOLE) continue;
    uint8_t state = old.present[i];
    uint64_t slot = scr_arr_storage_get(&old, i);
    if (i < from) scr_arr_store_state_owned(a, i, slot, state);
    else if (i >= from + n) scr_arr_store_state_owned(a, i - n + p.add, slot, state);
    else scr_arr_store_state_owned(out, i - from, slot, state);
  }
  for (size_t j = 0; j < old.sparse_len; j++) {
    size_t i = old.sparse[j].index;
    uint8_t state = old.sparse[j].state;
    uint64_t slot = old.sparse[j].slot;
    if (i < from) scr_arr_store_state_owned(a, i, slot, state);
    else if (i >= from + n) scr_arr_store_state_owned(a, i - n + p.add, slot, state);
    else scr_arr_store_state_owned(out, i - from, slot, state);
  }
  a->len = p.next_len;
  if (p.add) scr_arr_copy_range_ex(a, from, items, 0, p.add, false, true);
  scr_arr_free_storage(&old);
  scr_arr_refill(a);
  scr_arr_refill(out);
  return out;
}

static ScrArr *scr_arr_splice_apply(ScrArr *a, ScrSplicePlan p, const ScrArr *items) {
  /* Direct runtime self-spread callers need the evaluated arguments to
   * survive receiver mutation, including sparse and restricted paths. */
  ScrArr *snapshot = items == a ? scr_arr_slice(a, 0, INFINITY) : NULL;
  if (snapshot) items = snapshot;
  ScrArr *out = scr_arr_integrity_flags(a) ? scr_arr_splice_checked(a, p, items)
                                    : scr_arr_splice_unrestricted(a, p, items);
  scr_arr_release(snapshot);
  return out;
}

ScrArr *scr_arr_splice(ScrArr *a, double start, double deleteCount) {
  return scr_arr_splice_apply(a, scr_arr_splice_plan(a, start, deleteCount, 0), NULL);
}

ScrArr *scr_arr_splice_insert(ScrArr *a, double start, double deleteCount,
                              const ScrArr *items) {
  return scr_arr_splice_apply(a, scr_arr_splice_plan(a, start, deleteCount, items->len), items);
}

/* A statement-position splice: `a.splice(start, deleteCount, ...items)`
 * whose removed-elements array is never observed. The `count` owned value
 * slots are inserted exactly as scr_arr_splice_insert would (same clamping,
 * same resulting states), but no result array or argument array is built.
 * The removed values are released only after the receiver is consistent
 * again: a release can run the cycle collector. Restricted/sparse receivers
 * use an argument array that owns every inserted value even after refusal. */
void scr_arr_splice_drop(ScrArr *a, double start, double deleteCount, size_t count,
                         const uint64_t *slots) {
  ScrSplicePlan p = scr_arr_splice_plan(a, start, deleteCount, count);
  size_t from = p.from, n = p.remove, next_len = p.next_len;
  bool refs = scr_elem_is_ref(a->elem);
  if (scr_arr_integrity_flags(a) || !scr_arr_is_dense(a) || !scr_arr_dense_ok(a, next_len, count)) {
    ScrArr *items = a->elem == SCR_ELEM_REF
        ? scr_arr_new_ops(a->ops, count)
        : scr_arr_new(a->elem, count);
    scr_arr_push_many(items, count, slots);
    scr_arr_release(scr_arr_splice_apply(a, p, items));
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
  bool packed = a->filled == old_len;
  scr_arr_move_dense(a, from + count, from + n, old_len - from - n);
  if (count) {
    scr_arr_put_slots(a, from, count, slots);
    memset(a->present + from, SCR_ARR_VALUE, count);
  }
  if (next_len < old_len) scr_arr_clear_dense(a, next_len, old_len - next_len);
  a->len = next_len;
  /* Values inserted into a hole-free array keep it hole-free. */
  if (packed) a->filled = (uint32_t)next_len;
  else scr_arr_refill(a);
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
  scr_arr_refill(out);
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
  if (a->elem == SCR_ELEM_REF && a->ops->retain == scr_dyn_retain_v) {
    return scr_dyn_strict_eq((ScrDyn *)p, (ScrDyn *)v);
  }
  if (a->elem == SCR_ELEM_REF && a->ops->retain == scr_closure_retain_v)
    return scr_closure_identity_equal((ScrClosure *)p, (ScrClosure *)v);
  return p == v;
}

double scr_arr_index_of_f64(ScrArr *a, double v) {
  for (size_t i = 0; i < a->cap && i < a->len; i++) {
    if (a->present[i] == SCR_ARR_VALUE && scr_slot_to_f64(a->data[i]) == v) return (double)i;
  }
  for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++) {
    if (SCR_AX(a)->sparse[i].state == SCR_ARR_VALUE && scr_slot_to_f64(SCR_AX(a)->sparse[i].slot) == v) return (double)SCR_AX(a)->sparse[i].index;
  }
  return -1;
}

double scr_arr_index_of_bool(ScrArr *a, bool v) {
  for (size_t i = 0; i < a->cap && i < a->len; i++) {
    if (a->present[i] == SCR_ARR_VALUE && ((scr_arr_dense_get(a, i) != 0) == v)) return (double)i;
  }
  for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++) {
    if (SCR_AX(a)->sparse[i].state == SCR_ARR_VALUE && (SCR_AX(a)->sparse[i].slot != 0) == v) return (double)SCR_AX(a)->sparse[i].index;
  }
  return -1;
}

double scr_arr_index_of_ref(ScrArr *a, void *v) {
  for (size_t i = 0; i < a->cap && i < a->len; i++) {
    if (a->present[i] == SCR_ARR_VALUE && scr_arr_ref_eq(a, a->data[i], v)) return (double)i;
  }
  for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++) {
    if (SCR_AX(a)->sparse[i].state == SCR_ARR_VALUE && scr_arr_ref_eq(a, SCR_AX(a)->sparse[i].slot, v)) return (double)SCR_AX(a)->sparse[i].index;
  }
  return -1;
}

bool scr_arr_includes_f64(ScrArr *a, double v) {
  for (size_t i = 0; i < a->cap && i < a->len; i++) {
    if (a->present[i] != SCR_ARR_VALUE) continue;
    double x = scr_slot_to_f64(a->data[i]);
    if (x == v || (x != x && v != v)) return true; /* SameValueZero: NaN hits */
  }
  for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++) {
    if (SCR_AX(a)->sparse[i].state != SCR_ARR_VALUE) continue;
    double x = scr_slot_to_f64(SCR_AX(a)->sparse[i].slot);
    if (x == v || (x != x && v != v)) return true;
  }
  return false;
}

bool scr_arr_includes_bool(ScrArr *a, bool v) {
  return scr_arr_index_of_bool(a, v) >= 0;
}

bool scr_arr_includes_ref(ScrArr *a, void *v) {
  if (a->elem == SCR_ELEM_REF && a->ops->retain == scr_dyn_retain_v) {
    const ScrDyn *needle = (const ScrDyn *)v;
    if (needle->kind == SCR_DYN_NUM && needle->v.num != needle->v.num) {
      for (size_t i = 0; i < a->cap && i < a->len; i++) {
        if (a->present[i] != SCR_ARR_VALUE) continue;
        const ScrDyn *d = (const ScrDyn *)scr_slot_to_ptr(a->data[i]);
        if (d->kind == SCR_DYN_NUM && d->v.num != d->v.num) return true;
      }
      for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++) {
        if (SCR_AX(a)->sparse[i].state != SCR_ARR_VALUE) continue;
        const ScrDyn *d = (const ScrDyn *)scr_slot_to_ptr(SCR_AX(a)->sparse[i].slot);
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
  double len = SCR_ARR_LEN_F64(a->len);
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
          ? scr_arr_new_ops(a->ops, hint ? hint : 1)
          : scr_arr_new(a->elem, hint ? hint : 1);
  out->len = n;
  if (to <= a->cap) {
    scr_arr_copy_dense(out, 0, a, from, n, false, false);
    /* States copied from below the source's bound are present values. */
    if (n > 0 && from < a->filled)
      out->filled = (uint32_t)((to < a->filled ? to : a->filled) - from);
    scr_arr_refill(out);
    return out;
  }
  for (size_t i = 0; i < a->cap && i < to; i++) {
    if (i < from || a->present[i] == SCR_ARR_HOLE) continue;
    uint8_t state = a->present[i];
    scr_arr_store_state_owned(out, i - from,
                              scr_arr_retain_state_slot(a, scr_arr_dense_get(a, i), state),
                              state);
  }
  for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++) {
    size_t index = SCR_AX(a)->sparse[i].index;
    if (index >= from && index < to) {
      scr_arr_store_state_owned(out, index - from,
                                scr_arr_retain_state_slot(a, SCR_AX(a)->sparse[i].slot,
                                                          SCR_AX(a)->sparse[i].state),
                                SCR_AX(a)->sparse[i].state);
    }
  }
  scr_arr_refill(out);
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
  if (!copy && a->len < 2) return scr_arr_retain(a);
  if (a->len == 0) return copy ? scr_arr_new(a->elem, 0) : scr_arr_retain(a);
  size_t dense = a->len < a->cap ? a->len : a->cap;
  size_t count = 0, undefined_count = 0;
  for (size_t i = 0; i < dense; i++) {
    count += a->present[i] == SCR_ARR_VALUE;
    undefined_count += a->present[i] == SCR_ARR_UNDEFINED;
  }
  for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++) {
    count += SCR_AX(a)->sparse[i].state == SCR_ARR_VALUE;
    undefined_count += SCR_AX(a)->sparse[i].state == SCR_ARR_UNDEFINED;
  }
  if (count > SIZE_MAX / sizeof(uint64_t)) scr_arr_oom();
  uint64_t *values = count ? malloc(count * sizeof(*values)) : NULL;
  if (count && !values) scr_arr_oom();
  size_t used = 0;
  for (size_t i = 0; i < dense; i++)
    if (a->present[i] == SCR_ARR_VALUE) values[used++] = scr_arr_dense_get(a, i);
  for (size_t i = 0; i < SCR_AX(a)->sparse_len; i++)
    if (SCR_AX(a)->sparse[i].state == SCR_ARR_VALUE) values[used++] = SCR_AX(a)->sparse[i].slot;
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
  if (!copy && scr_arr_integrity_flags(a)) {
    /* Retain the complete snapshot before Set can release an original
     * string. Refused Set consumes its value; only the unwritten suffix
     * still belongs to this buffer. */
    for (size_t i = 0; i < count; i++) values[i] = scr_elem_retain_slot(a, values[i]);
    for (size_t i = 0; i < count; i++) {
      if (!scr_arr_set_state_owned(a, (double)i, values[i], SCR_ARR_VALUE)) {
        for (size_t j = i + 1; j < count; j++) scr_elem_release(a, values[j]);
        free(values);
        return NULL;
      }
    }
    free(values);
    size_t present = count + undefined_count;
    for (size_t i = count; i < present; i++)
      if (!scr_arr_set_state_owned(a, (double)i, 0, SCR_ARR_UNDEFINED)) return NULL;
    /* Only present own slots can refuse Delete; skip absent sparse ranges
     * while preserving the ascending order of observable failures. */
    for (double i = scr_arr_next_present(a, (double)present); i < (double)a->len;
         i = scr_arr_next_present(a, i + 1)) {
      scr_arr_delete(a, i);
      if (scr_exc_pending()) return NULL;
    }
    scr_arr_refill(a);
    return scr_arr_retain(a);
  }
  size_t present = copy ? a->len : count + undefined_count;
  ScrArr *out = copy ? scr_arr_new(a->elem, present) : a;
  if (copy) out->len = a->len;
  if (!copy && scr_arr_is_dense(a)) {
    if (count) scr_arr_put_slots(a, 0, count, values);
    scr_arr_cut(a, count);
    memset(a->present, SCR_ARR_VALUE, count);
    memset(a->present + count, SCR_ARR_UNDEFINED, undefined_count);
    scr_arr_clear_dense(a, count + undefined_count, a->len - count - undefined_count);
    if (undefined_count)
      memset(scr_arr_dense_at(a, count), 0, undefined_count * scr_arr_slot_width(a));
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
  scr_arr_refill(out);
  return copy ? out : scr_arr_retain(a);
}

/* ── comparator sort over a compacted private snapshot ────────────────── */

typedef struct {
  ScrClosure *f;
  void *(*retain)(void *); /* reference elements; NULL for numbers */
  uint32_t arity;
  bool numbers;
  bool borrowing; /* enter through f->fn_borrowed, lending the slots */
  int32_t order;  /* 1 or -1: f orders number keys ascending or descending */
  ScrClosure *key; /* the key reader of reference elements under `order` */
  ScrSortLess less; /* a caller comparison in place of `f` (scr_sort_slots_with) */
  void *less_ctx;
} ScrSortCompare;

static void *scr_sort_retain_str(void *p) { return scr_str_retain((ScrStr *)p); }
static void *scr_sort_retain_arr(void *p) { return scr_arr_retain((ScrArr *)p); }
static void *scr_sort_retain_bytes(void *p) { return scr_bytes_retain((ScrBytes *)p); }

/* One comparator call with the closure ABI of the emitted callValue: the
 * callee owns its reference parameters and reports an exception through
 * the pending flag. A closure with a borrowing entry (fn_borrowed) is
 * entered there instead, lending both slots: the sort's storage owns every
 * slot until the sort returns, and the comparator cannot reach it. The
 * caller holds the undefined-`this` window open for the whole sort; every
 * emitted call restores the receiver stack it pushed, so its top is
 * undefined at each comparator entry. */
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
    void *fn = c->f->fn;
    if (c->borrowing) {
      fn = c->f->fn_borrowed;
    } else {
      if (x && c->arity >= 1) x = c->retain(x);
      if (y && c->arity >= 2) y = c->retain(y);
    }
    if (c->arity == 2) result = ((double (*)(ScrClosure *, void *, void *))fn)(c->f, x, y);
    else if (c->arity == 1) result = ((double (*)(ScrClosure *, void *))fn)(c->f, x);
    else result = ((double (*)(ScrClosure *))fn)(c->f);
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

static ScrSortCompare scr_sort_compare_for(const ScrArr *a, ScrClosure *f, uint32_t arity,
                                           int32_t order, ScrClosure *key) {
  ScrSortCompare c = {f, NULL, arity, a->elem == SCR_ELEM_F64, false, order, key};
  if (order != 0 && (arity != 2 || (order != 1 && order != -1) ||
                     (c.numbers ? key != NULL : a->elem != SCR_ELEM_REF || key == NULL)))
    scr_trap("scriptc: invalid keyed sort\n");
  if (!c.numbers) {
    c.borrowing = f->fn_borrowed != NULL;
    if (a->elem == SCR_ELEM_STR) c.retain = scr_sort_retain_str;
    else if (a->elem == SCR_ELEM_ARR) c.retain = scr_sort_retain_arr;
    else if (a->elem == SCR_ELEM_BYTES) c.retain = scr_sort_retain_bytes;
    else if (a->elem == SCR_ELEM_REF) c.retain = a->ops->retain;
    else scr_trap("scriptc: invalid comparator sort element kind\n");
  }
  return c;
}

/* ── keyed sort for recognized numeric comparators ───────────────────── */

/* `a - b`, `b - a`, `a.k - b.k` and the three-way ternaries order numbers
 * other than NaN consistently, call no user code and treat only equal
 * numbers as equal, except that -0 equals 0. When no key is NaN or -0, a
 * stable sort by key therefore produces exactly the comparator sort's
 * permutation. Keys map to unsigned integers in the same order (descending
 * order complements them). A first scan reads every key without storing
 * it: ordered input stays as it is, strictly descending input reverses,
 * a short tail after ascending reference keys is placed by binary search,
 * and input of a few ascending runs merges them. Anything else takes an
 * LSD radix sort, stable by construction, which skips the digit positions
 * every key shares, so small integers take about half the passes. */

typedef struct {
  uint64_t key;
  uint64_t slot;
} ScrSortItem;

#define SCR_SORT_SIGN (UINT64_C(1) << 63)
/* Inputs of at most this many ascending runs merge instead. */
#ifndef SCR_SORT_KEYED_RUNS
#define SCR_SORT_KEYED_RUNS 16
#endif
/* Below this length, binary insertion beats the radix passes' setup. */
#ifndef SCR_SORT_KEYED_INSERTION
#define SCR_SORT_KEYED_INSERTION 48
#endif

/* The order-preserving unsigned key of a number, false for NaN and -0. */
static bool scr_sort_key_encode(double value, uint64_t flip, uint64_t *key) {
  uint64_t bits;
  memcpy(&bits, &value, sizeof bits);
  if (value != value || bits == SCR_SORT_SIGN) return false;
  *key = ((bits & SCR_SORT_SIGN) ? ~bits : bits | SCR_SORT_SIGN) ^ flip;
  return true;
}

static uint64_t scr_sort_key_decode(uint64_t key, uint64_t flip) {
  key ^= flip;
  return (key & SCR_SORT_SIGN) ? key & ~SCR_SORT_SIGN : ~key;
}

/* From this length, 2-byte typed-array elements take a counting sort. */
#ifndef SCR_BYTES_COUNT_SORT
#define SCR_BYTES_COUNT_SORT 4096
#endif

/* Longer inputs sort by 11-bit digits (six passes) rather than bytes: the
 * larger count tables then pay for themselves. */
#ifndef SCR_SORT_WIDE_DIGITS
#define SCR_SORT_WIDE_DIGITS ((size_t)1 << 17)
#endif

/* What the first scan learned about the keys it read. */
typedef struct {
  size_t scanned; /* keys read: all n unless the input has many runs */
  size_t head;    /* the length of the first ascending run */
  size_t runs;    /* ascending runs among them */
  bool descending; /* strictly */
  bool valid;      /* no NaN or -0 among them */
} ScrSortScan;

#define SCR_SORT_SCAN(scan, n, READ)                                                \
  do {                                                                              \
    uint64_t previous_ = 0;                                                         \
    (scan).runs = 1;                                                                \
    (scan).head = (n);                                                              \
    (scan).descending = true;                                                       \
    (scan).valid = true;                                                            \
    size_t i_ = 0;                                                                  \
    for (; i_ < (n); i_++) {                                                        \
      uint64_t key_;                                                                \
      if (!scr_sort_key_encode(READ(i_), flip, &key_)) {                            \
        (scan).valid = false;                                                       \
        break;                                                                      \
      }                                                                             \
      if (i_) {                                                                     \
        if (previous_ > key_ && (scan).runs == 1) (scan).head = i_;                 \
        (scan).runs += previous_ > key_;                                            \
        (scan).descending &= previous_ > key_;                                      \
        if ((scan).runs > SCR_SORT_KEYED_RUNS && !(scan).descending) {              \
          i_++;                                                                     \
          break;                                                                    \
        }                                                                           \
      }                                                                             \
      previous_ = key_;                                                             \
    }                                                                               \
    (scan).scanned = i_;                                                            \
  } while (0)

/* Binary insertion of buf[end..limit) into the sorted buf[start..end),
 * after equal keys; leaves `end` at `limit`. */
#define SCR_SORT_INSERT_UNTIL(T, KEY, buf, start, end, limit)                        \
  do {                                                                               \
    for (; (end) < (limit); (end)++) {                                               \
      T pivot_ = (buf)[end];                                                         \
      uint64_t pk_ = KEY(pivot_);                                                    \
      size_t low_ = (start), high_ = (end);                                          \
      while (low_ < high_) {                                                         \
        size_t center_ = low_ + (high_ - low_) / 2;                                  \
        if (KEY((buf)[center_]) > pk_) high_ = center_;                              \
        else low_ = center_ + 1;                                                     \
      }                                                                              \
      memmove((buf) + low_ + 1, (buf) + low_, ((end) - low_) * sizeof(T));           \
      (buf)[low_] = pivot_;                                                          \
    }                                                                                \
  } while (0)

/* Merges runs src[i..mid) and src[j..hi) of very different lengths into
 * dst[k..): each record of the shorter run finds its place in the longer one
 * by binary search (after equal keys of the left run, before equal keys of
 * the right one), and the records between move as blocks. Leaves the
 * indices at the ends of both runs. */
#define SCR_SORT_BLOCK_MERGE(T, KEY, src, dst, i, j, k, mid, hi)                    \
  do {                                                                               \
    bool short_right_ = (hi) - (j) <= (mid) - (i);                                   \
    size_t *at_ = short_right_ ? &(i) : &(j), *by_ = short_right_ ? &(j) : &(i);    \
    size_t at_end_ = short_right_ ? (mid) : (hi), by_end_ = short_right_ ? (hi) : (mid); \
    for (; *by_ < by_end_; (*by_)++) {                                               \
      uint64_t key_ = KEY((src)[*by_]);                                              \
      size_t low_ = *at_, high_ = at_end_;                                           \
      while (low_ < high_) {                                                         \
        size_t center_ = low_ + (high_ - low_) / 2;                                  \
        uint64_t probe_ = KEY((src)[center_]);                                       \
        if (short_right_ ? probe_ > key_ : probe_ >= key_) high_ = center_;          \
        else low_ = center_ + 1;                                                     \
      }                                                                              \
      memcpy((dst) + (k), (src) + *at_, (low_ - *at_) * sizeof(T));                  \
      (k) += low_ - *at_;                                                            \
      *at_ = low_;                                                                   \
      (dst)[(k)++] = (src)[*by_];                                                    \
    }                                                                                \
  } while (0)

/* LSD radix passes over BITS-bit digits of KEY_BITS-bit keys from `src` into
 * `dst`, swapping the two after each pass; positions where every key has
 * the same digit are skipped. */
#define SCR_SORT_RADIX_PASSES(T, KEY, KEY_BITS, src, dst, n, BITS)                   \
  do {                                                                               \
    enum { digits_ = ((KEY_BITS) + (BITS) - 1) / (BITS), radix_ = 1 << (BITS) };     \
    size_t(*counts_)[radix_] = calloc(digits_, sizeof(*counts_));                    \
    if (!counts_) scr_arr_oom();                                                     \
    for (size_t i_ = 0; i_ < (n); i_++) {                                            \
      uint64_t k_ = KEY((src)[i_]);                                                  \
      for (unsigned d_ = 0; d_ < digits_; d_++)                                      \
        counts_[d_][(k_ >> ((BITS) * d_)) & (radix_ - 1)]++;                         \
    }                                                                                \
    uint64_t first_ = KEY((src)[0]);                                                 \
    for (unsigned d_ = 0; d_ < digits_; d_++) {                                      \
      size_t *count_ = counts_[d_];                                                  \
      unsigned shift_ = (BITS) * d_;                                                 \
      if (count_[(first_ >> shift_) & (radix_ - 1)] == (n)) continue;                \
      size_t at_ = 0;                                                                \
      for (unsigned b_ = 0; b_ < radix_; b_++) {                                     \
        size_t c_ = count_[b_];                                                      \
        count_[b_] = at_;                                                            \
        at_ += c_;                                                                   \
      }                                                                              \
      for (size_t i_ = 0; i_ < (n); i_++)                                            \
        (dst)[count_[(KEY((src)[i_]) >> shift_) & (radix_ - 1)]++] = (src)[i_];      \
      T *swap_ = (src);                                                              \
      (src) = (dst);                                                                 \
      (dst) = swap_;                                                                 \
    }                                                                                \
    free(counts_);                                                                   \
  } while (0)

/* Stable sort of `n` records of type T keyed by KEY(record), between `buf`
 * and `tmp` (which may be NULL when `n` is at most the insertion length);
 * leaves the sorted records in *out. */
#define SCR_SORT_KEYED_RECORDS(T, KEY, KEY_BITS, buf, tmp, n, few_runs, out)         \
  do {                                                                               \
    T *src_ = (buf), *dst_ = (tmp);                                                  \
    if (few_runs) {                                                                  \
      /* Runs grow to 16 records by insertion, as in the comparator sort; a  \
       * run starting inside an ascending run extends to that run's end, so  \
       * there are at most twice as many as ascending runs. */               \
      size_t starts_[2 * SCR_SORT_KEYED_RUNS + 1], count_ = 0;                       \
      for (size_t start_ = 0; start_ < (n);) {                                       \
        starts_[count_++] = start_;                                                  \
        size_t end_ = start_ + 1;                                                    \
        while (end_ < (n) && KEY(src_[end_ - 1]) <= KEY(src_[end_])) end_++;         \
        size_t limit_ = start_ + 16 < (n) ? start_ + 16 : (n);                       \
        SCR_SORT_INSERT_UNTIL(T, KEY, src_, start_, end_, limit_);                   \
        start_ = end_;                                                               \
      }                                                                              \
      starts_[count_] = (n);                                                         \
      while (count_ > 1) {                                                           \
        size_t next_ = 0;                                                            \
        for (size_t r_ = 0; r_ < count_; r_ += 2) {                                  \
          size_t lo_ = starts_[r_], mid_ = starts_[r_ + 1];                          \
          size_t hi_ = r_ + 2 <= count_ ? starts_[r_ + 2] : mid_;                    \
          size_t i_ = lo_, j_ = mid_, k_ = lo_;                                      \
          if ((hi_ - mid_) * 8 <= mid_ - lo_ || (mid_ - lo_) * 8 <= hi_ - mid_)      \
            SCR_SORT_BLOCK_MERGE(T, KEY, src_, dst_, i_, j_, k_, mid_, hi_);         \
          while (i_ < mid_ && j_ < hi_)                                              \
            dst_[k_++] = KEY(src_[j_]) < KEY(src_[i_]) ? src_[j_++] : src_[i_++];    \
          memcpy(dst_ + k_, src_ + i_, (mid_ - i_) * sizeof(T));                     \
          k_ += mid_ - i_;                                                           \
          memcpy(dst_ + k_, src_ + j_, (hi_ - j_) * sizeof(T));                      \
          starts_[next_++] = lo_;                                                    \
        }                                                                            \
        starts_[next_] = (n);                                                        \
        count_ = next_;                                                              \
        T *swap_ = src_;                                                             \
        src_ = dst_;                                                                 \
        dst_ = swap_;                                                                \
      }                                                                              \
    } else if ((n) <= SCR_SORT_KEYED_INSERTION) {                                    \
      size_t end_ = 1;                                                               \
      SCR_SORT_INSERT_UNTIL(T, KEY, src_, 0, end_, (n));                             \
    } else if ((n) > SCR_SORT_WIDE_DIGITS) {                                         \
      SCR_SORT_RADIX_PASSES(T, KEY, KEY_BITS, src_, dst_, n, 11);                    \
    } else {                                                                         \
      SCR_SORT_RADIX_PASSES(T, KEY, KEY_BITS, src_, dst_, n, 8);                     \
    }                                                                                \
    *(out) = src_;                                                                   \
  } while (0)

#define SCR_SORT_SELF_KEY(x) (x)
#define SCR_SORT_ITEM_KEY(x) ((x).key)

static void scr_sort_reverse_slots(uint64_t *values, size_t n) {
  for (size_t left = 0, right = n - 1; left < right; left++, right--) {
    uint64_t v = values[left];
    values[left] = values[right];
    values[right] = v;
  }
}

/* Sorts number slots in place as their keys. Equal keys are equal numbers,
 * so the order among them needs no tracking. */
static bool scr_sort_keyed_numbers(uint64_t *values, size_t n, uint64_t flip) {
  ScrSortScan scan;
#define SCR_SORT_NUMBER_AT(i) scr_slot_to_f64(values[i])
  SCR_SORT_SCAN(scan, n, SCR_SORT_NUMBER_AT);
  if (!scan.valid) return false;
  bool complete = scan.scanned == n;
  if (complete && scan.runs == 1) return true;
  if (complete && scan.descending) {
    scr_sort_reverse_slots(values, n);
    return true;
  }
  uint64_t key;
  for (size_t i = scan.scanned; i < n; i++)
    if (!scr_sort_key_encode(SCR_SORT_NUMBER_AT(i), flip, &key)) return false;
#undef SCR_SORT_NUMBER_AT
  for (size_t i = 0; i < n; i++) {
    scr_sort_key_encode(scr_slot_to_f64(values[i]), flip, &key);
    values[i] = key;
  }
  bool few_runs = complete && scan.runs <= SCR_SORT_KEYED_RUNS;
  uint64_t *tmp = NULL, *sorted = values;
  if (few_runs || n > SCR_SORT_KEYED_INSERTION) {
    tmp = malloc(n * sizeof(*tmp));
    if (!tmp) scr_arr_oom();
  }
  SCR_SORT_KEYED_RECORDS(uint64_t, SCR_SORT_SELF_KEY, 64, values, tmp, n, few_runs, &sorted);
  for (size_t i = 0; i < n; i++) values[i] = scr_sort_key_decode(sorted[i], flip);
  free(tmp);
  return true;
}

/* A reference element's key through the borrowed reader closure. */
static double scr_sort_read_key(const ScrSortCompare *c, uint64_t slot) {
  ScrClosure *reader = c->key;
  void *x = scr_slot_to_ptr(slot);
  if (reader->fn_borrowed)
    return ((double (*)(ScrClosure *, void *))reader->fn_borrowed)(reader, x);
  return ((double (*)(ScrClosure *, void *))reader->fn)(reader, x ? c->retain(x) : x);
}

/* Ascending keys followed by a short tail (values pushed onto a sorted
 * array): sorts the tail alone, finds where each of its slots belongs in
 * the head by binary search, then moves the head's slots as blocks, without
 * a buffer for the whole input. Every key is read before any slot moves. */
static bool scr_sort_keyed_tail(uint64_t *values, size_t n, size_t head, const ScrSortCompare *c,
                                uint64_t flip) {
  size_t tail = n - head;
  ScrSortItem *items = malloc(tail * 2 * sizeof(*items));
  if (!items) scr_arr_oom();
  for (size_t i = 0; i < tail; i++) {
    if (!scr_sort_key_encode(scr_sort_read_key(c, values[head + i]), flip, &items[i].key)) {
      free(items);
      return false;
    }
    items[i].slot = values[head + i];
  }
  ScrSortItem *sorted = items;
  SCR_SORT_KEYED_RECORDS(ScrSortItem, SCR_SORT_ITEM_KEY, 64, items, items + tail, tail, false,
                         &sorted);
  /* Each tail slot follows the head's slots with keys up to its own. The
   * places only grow, so each search starts at the previous one. */
  size_t *places = malloc(tail * sizeof(*places));
  if (!places) scr_arr_oom();
  for (size_t i = 0, low = 0; i < tail; i++) {
    size_t high = head;
    while (low < high) {
      size_t center = low + (high - low) / 2;
      uint64_t key;
      scr_sort_key_encode(scr_sort_read_key(c, values[center]), flip, &key);
      if (key > sorted[i].key) high = center;
      else low = center + 1;
    }
    places[i] = low;
  }
  for (size_t i = tail, end = head; i-- > 0;) {
    memmove(values + places[i] + i + 1, values + places[i], (end - places[i]) * sizeof(*values));
    values[places[i] + i] = sorted[i].slot;
    end = places[i];
  }
  free(places);
  free(items);
  return true;
}

/* Sorts reference slots by the keys their reader returns. The reader is a
 * plain field read; the slots move only after every key has been read. */
static bool scr_sort_keyed_refs(uint64_t *values, size_t n, const ScrSortCompare *c,
                                uint64_t flip) {
  ScrSortScan scan;
#define SCR_SORT_REF_AT(i) scr_sort_read_key(c, values[i])
  SCR_SORT_SCAN(scan, n, SCR_SORT_REF_AT);
#undef SCR_SORT_REF_AT
  if (!scan.valid) return false;
  bool complete = scan.scanned == n;
  if (complete && scan.runs == 1) return true;
  if (complete && scan.descending) {
    /* Strictly descending keys reverse without reordering ties. */
    scr_sort_reverse_slots(values, n);
    return true;
  }
  /* The scan has read and checked the head's keys; the tail's are checked
   * as they are read again. */
  if (scan.head < n && scan.head >= n - n / 8)
    return scr_sort_keyed_tail(values, n, scan.head, c, flip);
  ScrSortItem *items = malloc(n * sizeof(*items));
  if (!items) scr_arr_oom();
  for (size_t i = 0; i < n; i++) {
    if (!scr_sort_key_encode(scr_sort_read_key(c, values[i]), flip, &items[i].key)) {
      free(items);
      return false;
    }
    items[i].slot = values[i];
  }
  bool few_runs = complete && scan.runs <= SCR_SORT_KEYED_RUNS;
  ScrSortItem *tmp = NULL, *sorted = items;
  if (few_runs || n > SCR_SORT_KEYED_INSERTION) {
    tmp = malloc(n * sizeof(*tmp));
    if (!tmp) scr_arr_oom();
  }
  SCR_SORT_KEYED_RECORDS(ScrSortItem, SCR_SORT_ITEM_KEY, 64, items, tmp, n, few_runs, &sorted);
  for (size_t i = 0; i < n; i++) values[i] = sorted[i].slot;
  free(items);
  free(tmp);
  return true;
}

/* Orders `n >= 2` slots by key when the comparator allows it. Returns false,
 * leaving the slots as they were, when a key is NaN or -0: the comparator
 * sort then runs instead. */
static bool scr_sort_keyed(uint64_t *values, size_t n, const ScrSortCompare *c) {
  uint64_t flip = c->order < 0 ? ~UINT64_C(0) : 0;
  if (c->numbers) return scr_sort_keyed_numbers(values, n, flip);
  scr_dyn_this_push_dyn(NULL);
  bool sorted = scr_sort_keyed_refs(values, n, c, flip);
  scr_dyn_this_pop();
  return sorted;
}

/* ── typed-array numeric sort ─────────────────────────────────────────── */

/* The order-preserving unsigned key of any non-NaN number, -0 below +0. */
static uint64_t scr_sort_float_key(double value) {
  uint64_t bits;
  memcpy(&bits, &value, sizeof bits);
  return (bits & SCR_SORT_SIGN) ? ~bits : bits | SCR_SORT_SIGN;
}

static double scr_sort_float_value(uint64_t key) {
  uint64_t bits = (key & SCR_SORT_SIGN) ? key & ~SCR_SORT_SIGN : ~key;
  double value;
  memcpy(&value, &bits, sizeof value);
  return value;
}

/* Element `i` of `b` as a number; views may be unaligned. */
static double scr_bytes_sort_load(const ScrBytes *b, size_t i) {
  const uint8_t *at = b->data + i * scr_bytes_elem_size(b->elem);
  switch (b->elem) {
  case SCR_BYTES_U8:
  case SCR_BYTES_U8C: return *at;
  case SCR_BYTES_I8: return (int8_t)*at;
  case SCR_BYTES_U16: {
    uint16_t v;
    memcpy(&v, at, sizeof v);
    return v;
  }
  case SCR_BYTES_I16: {
    int16_t v;
    memcpy(&v, at, sizeof v);
    return v;
  }
  case SCR_BYTES_U32: {
    uint32_t v;
    memcpy(&v, at, sizeof v);
    return v;
  }
  case SCR_BYTES_I32: {
    int32_t v;
    memcpy(&v, at, sizeof v);
    return v;
  }
  case SCR_BYTES_F32: {
    float v;
    memcpy(&v, at, sizeof v);
    return v;
  }
  default: {
    double v;
    memcpy(&v, at, sizeof v);
    return v;
  }
  }
}

/* Stores a number read from an element of the same kind back into `b`. */
static void scr_bytes_sort_store(ScrBytes *b, size_t i, double value) {
  uint8_t *at = b->data + i * scr_bytes_elem_size(b->elem);
  switch (b->elem) {
  case SCR_BYTES_U8:
  case SCR_BYTES_U8C: *at = (uint8_t)value; break;
  case SCR_BYTES_I8: *at = (uint8_t)(int8_t)value; break;
  case SCR_BYTES_U16: {
    uint16_t v = (uint16_t)value;
    memcpy(at, &v, sizeof v);
    break;
  }
  case SCR_BYTES_I16: {
    int16_t v = (int16_t)value;
    memcpy(at, &v, sizeof v);
    break;
  }
  case SCR_BYTES_U32: {
    uint32_t v = (uint32_t)value;
    memcpy(at, &v, sizeof v);
    break;
  }
  case SCR_BYTES_I32: {
    int32_t v = (int32_t)value;
    memcpy(at, &v, sizeof v);
    break;
  }
  case SCR_BYTES_F32: {
    float v = (float)value;
    memcpy(at, &v, sizeof v);
    break;
  }
  default: memcpy(at, &value, sizeof value); break;
  }
}

/* A counting sort of 1- and 2-byte integer elements: every value of the
 * element domain is a bucket, so the elements are read once and written
 * once in bucket order. */
static void scr_bytes_count_sort(ScrBytes *b, bool descending) {
  size_t n = b->len, width = scr_bytes_elem_size(b->elem);
  bool sign = b->elem == SCR_BYTES_I8 || b->elem == SCR_BYTES_I16;
  size_t domain = width == 1 ? 256 : 65536, bias = sign ? domain / 2 : 0;
  size_t *counts = calloc(domain, sizeof(*counts));
  if (!counts) scr_arr_oom();
  uint8_t *data = b->data;
  if (width == 1) {
    for (size_t i = 0; i < n; i++) counts[(uint8_t)(data[i] + bias)]++;
  } else {
    for (size_t i = 0; i < n; i++) {
      uint16_t v;
      memcpy(&v, data + i * 2, 2);
      counts[(uint16_t)(v + bias)]++;
    }
  }
  size_t at = 0;
  for (size_t step = 0; step < domain; step++) {
    size_t bucket = descending ? domain - 1 - step : step;
    uint16_t v = (uint16_t)(bucket - bias);
    size_t end = at + counts[bucket];
    if (width == 1) {
      memset(data + at, (uint8_t)v, end - at);
    } else {
      for (size_t i = at; i < end; i++) memcpy(data + i * 2, &v, 2);
    }
    at = end;
  }
  free(counts);
}

/* The typed-array key sort over KT keys of KEY_BITS bits at `keys` (which
 * may alias the elements: each key is written at or before the element it
 * replaces). READ(i, &key) answers 0 for a number, 1 for NaN, 2 for a key
 * the order refuses; WRITE(i, key) stores an element. NaNs keep their
 * order and stored payloads after the numbers. */
#define SCR_BYTES_SORT_KEYS(KT, KEY_BITS, keys, READ, WRITE)                         \
  do {                                                                               \
    size_t kept_ = 0, runs_ = 1, nans_ = 0, nan_cap_ = 0;                            \
    uint64_t *nan_bits_ = NULL;                                                      \
    bool ascending_ = true, descending_ = true;                                      \
    for (size_t i_ = 0; i_ < n; i_++) {                                              \
      KT key_;                                                                       \
      if (READ(i_, &key_)) {                                                         \
        if (nans_ == nan_cap_) {                                                     \
          nan_cap_ = nan_cap_ ? nan_cap_ * 2 : 8;                                    \
          nan_bits_ = realloc(nan_bits_, nan_cap_ * sizeof(*nan_bits_));             \
          if (!nan_bits_) scr_arr_oom();                                             \
        }                                                                            \
        nan_bits_[nans_] = 0;                                                        \
        memcpy(&nan_bits_[nans_++], data + i_ * width, width);                       \
        continue;                                                                    \
      }                                                                              \
      if (kept_) {                                                                   \
        KT previous_ = (keys)[kept_ - 1];                                            \
        ascending_ &= previous_ <= key_;                                             \
        descending_ &= previous_ > key_;                                             \
        runs_ += previous_ > key_;                                                   \
      }                                                                              \
      (keys)[kept_++] = key_;                                                        \
    }                                                                                \
    KT *sorted_ = (keys), *tmp_ = NULL;                                              \
    if (ascending_) {                                                                \
    } else if (descending_) {                                                        \
      for (size_t l_ = 0, r_ = kept_ - 1; l_ < r_; l_++, r_--) {                     \
        KT swap_ = (keys)[l_];                                                       \
        (keys)[l_] = (keys)[r_];                                                     \
        (keys)[r_] = swap_;                                                          \
      }                                                                              \
    } else {                                                                         \
      bool few_runs_ = runs_ <= SCR_SORT_KEYED_RUNS;                                 \
      if (few_runs_ || kept_ > SCR_SORT_KEYED_INSERTION) {                           \
        tmp_ = malloc(kept_ * sizeof(*tmp_));                                        \
        if (!tmp_) scr_arr_oom();                                                    \
      }                                                                              \
      SCR_SORT_KEYED_RECORDS(KT, SCR_SORT_SELF_KEY, KEY_BITS, (keys), tmp_, kept_,   \
                             few_runs_, &sorted_);                                   \
    }                                                                                \
    for (size_t i_ = 0; i_ < kept_; i_++) WRITE(i_, sorted_[i_]);                    \
    for (size_t i_ = 0; i_ < nans_; i_++)                                            \
      memcpy(data + (kept_ + i_) * width, &nan_bits_[i_], width);                    \
    free(nan_bits_);                                                                 \
    free(tmp_);                                                                      \
  } while (0)

#define SCR_SORT_SIGN32 (UINT32_C(1) << 31)

/* Float keys refuse NaN and -0 under a comparator order; flip complements
 * every key of a descending order. */
static int scr_bytes_f32_key(const uint8_t *at, int32_t order, uint32_t *key) {
  float v;
  uint32_t bits;
  memcpy(&v, at, sizeof v);
  memcpy(&bits, at, sizeof bits);
  if (v != v) return order ? 2 : 1;
  if (order && bits == SCR_SORT_SIGN32) return 2;
  *key = ((bits & SCR_SORT_SIGN32) ? ~bits : bits | SCR_SORT_SIGN32) ^ (order < 0 ? ~UINT32_C(0) : 0);
  return 0;
}

static int scr_bytes_f64_key(const uint8_t *at, int32_t order, uint64_t *key) {
  double v;
  uint64_t bits;
  memcpy(&v, at, sizeof v);
  memcpy(&bits, at, sizeof bits);
  if (v != v) return order ? 2 : 1;
  if (order && bits == SCR_SORT_SIGN) return 2;
  *key = scr_sort_float_key(v) ^ (order < 0 ? ~UINT64_C(0) : 0);
  return 0;
}

/* 2- and 4-byte integer elements as 32-bit keys: signed kinds flip the
 * sign bit after sign extension, so key order is value order. */
static inline int scr_bytes_int_key(ScrBytesElem elem, const uint8_t *data, size_t i,
                                    uint32_t flip, uint32_t *key) {
  uint32_t v;
  switch (elem) {
  case SCR_BYTES_U16: {
    uint16_t x;
    memcpy(&x, data + i * 2, 2);
    v = x;
    break;
  }
  case SCR_BYTES_I16: {
    int16_t x;
    memcpy(&x, data + i * 2, 2);
    v = (uint32_t)(int32_t)x ^ SCR_SORT_SIGN32;
    break;
  }
  case SCR_BYTES_I32: {
    memcpy(&v, data + i * 4, 4);
    v ^= SCR_SORT_SIGN32;
    break;
  }
  default: memcpy(&v, data + i * 4, 4); break;
  }
  *key = v ^ flip;
  return 0;
}

static inline void scr_bytes_int_store(ScrBytesElem elem, uint8_t *data, size_t i, uint32_t flip,
                                       uint32_t key) {
  uint32_t v = key ^ flip;
  if (elem == SCR_BYTES_I16 || elem == SCR_BYTES_I32) v ^= SCR_SORT_SIGN32;
  if (elem == SCR_BYTES_U16 || elem == SCR_BYTES_I16) {
    uint16_t x = (uint16_t)v;
    memcpy(data + i * 2, &x, 2);
  } else {
    memcpy(data + i * 4, &v, 4);
  }
}

/* Whether a comparator order refuses this array (a float NaN or -0). */
static bool scr_bytes_sort_refused(const ScrBytes *b, int32_t order) {
  if (order == 0) return false;
  const uint8_t *data = b->data;
  for (size_t i = 0; i < b->len; i++) {
    if (b->elem == SCR_BYTES_F32) {
      uint32_t key;
      if (scr_bytes_f32_key(data + i * 4, order, &key)) return true;
    } else if (b->elem == SCR_BYTES_F64) {
      uint64_t key;
      if (scr_bytes_f64_key(data + i * 8, order, &key)) return true;
    }
  }
  return false;
}

/* Sorts a typed array's elements in place. Order 0 is the default
 * TypedArray order: ascending numbers, -0 before +0, then every NaN in its
 * original order with its stored bits. Order 1 or -1 is a recognized
 * comparator's (a - b, b - a, ...): it returns false, having written
 * nothing, when a float element is NaN or -0, and the caller then sorts
 * through the comparator. Equal keys are identical elements, so only the
 * keys need sorting. Runs no script code. */
bool scr_bytes_sort_numeric(ScrBytes *b, int32_t order) {
  size_t n = b->len;
  if (n < 2) return true;
  if (order < -1 || order > 1) scr_trap("scriptc: invalid typed array sort order\n");
  if (b->shared) {
    /* Sort a private copy and publish every element. */
    ScrBytes *copy = scr_bytes_snapshot(b);
    bool sorted = scr_bytes_sort_numeric(copy, order);
    if (sorted) scr_shared_store(b->data, copy->data, n * scr_bytes_elem_size(b->elem));
    scr_bytes_release(copy);
    return sorted;
  }
  size_t width = scr_bytes_elem_size(b->elem);
  uint8_t *data = b->data;
  /* Integer elements have no NaN or -0: every order is a value order. */
  if (width == 1 || (width == 2 && n >= SCR_BYTES_COUNT_SORT)) {
    scr_bytes_count_sort(b, order < 0);
    return true;
  }
  if (scr_bytes_sort_refused(b, order)) return false;
  uint32_t flip32 = order < 0 ? ~UINT32_C(0) : 0;
  uint64_t flip64 = order < 0 ? ~UINT64_C(0) : 0;
  if (n > SIZE_MAX / 2 / sizeof(uint64_t)) scr_arr_oom();
  if (b->elem == SCR_BYTES_F64) {
    /* Float64Array storage is 8-byte aligned (views start at multiples of
     * the element size), so the elements become their own keys. */
    uint64_t *keys = ((uintptr_t)data & 7) == 0 ? (uint64_t *)(void *)data : NULL;
    uint64_t *owned = keys ? NULL : malloc(n * sizeof(*owned));
    if (!keys && !owned) scr_arr_oom();
#define SCR_BYTES_F64_READ(i, key) scr_bytes_f64_key(data + (i) * 8, order, (key))
#define SCR_BYTES_F64_WRITE(i, key)                                                  \
  do {                                                                               \
    double v_ = scr_sort_float_value((key) ^ flip64);                                \
    memcpy(data + (i) * 8, &v_, 8);                                                  \
  } while (0)
    SCR_BYTES_SORT_KEYS(uint64_t, 64, keys ? keys : owned, SCR_BYTES_F64_READ, SCR_BYTES_F64_WRITE);
#undef SCR_BYTES_F64_READ
#undef SCR_BYTES_F64_WRITE
    free(owned);
    return true;
  }
  uint32_t *keys = malloc(n * sizeof(*keys));
  if (!keys) scr_arr_oom();
#define SCR_BYTES_KEYS32(NAME)                                                       \
  SCR_BYTES_SORT_KEYS(uint32_t, 32, keys, SCR_BYTES_READ32_##NAME, SCR_BYTES_WRITE32_##NAME)
#define SCR_BYTES_READ32_INT(i, key) scr_bytes_int_key(b->elem, data, (i), flip32, (key))
#define SCR_BYTES_WRITE32_INT(i, key) scr_bytes_int_store(b->elem, data, (i), flip32, (key))
#define SCR_BYTES_READ32_F32(i, key) scr_bytes_f32_key(data + (i) * 4, order, (key))
#define SCR_BYTES_WRITE32_F32(i, key)                                                \
  do {                                                                               \
    uint32_t k_ = (key) ^ flip32;                                                    \
    uint32_t bits_ = (k_ & SCR_SORT_SIGN32) ? k_ & ~SCR_SORT_SIGN32 : ~k_;           \
    memcpy(data + (i) * 4, &bits_, 4);                                               \
  } while (0)
  if (b->elem == SCR_BYTES_F32) SCR_BYTES_KEYS32(F32);
  else SCR_BYTES_KEYS32(INT);
#undef SCR_BYTES_KEYS32
#undef SCR_BYTES_READ32_INT
#undef SCR_BYTES_WRITE32_INT
#undef SCR_BYTES_READ32_F32
#undef SCR_BYTES_WRITE32_F32
  free(keys);
  return true;
}

/* Node's typed-array comparator sort: a top-down merge sort
 * between two snapshots of the elements, splitting at the midpoint and
 * taking the left element unless the comparator answers more than 0 (NaN
 * counts as 0). Matching its comparison schedule gives Node's result even
 * for comparators that are not consistent. Returns false when a comparator
 * throws. */
static bool scr_bytes_merge_sort(uint64_t *source, size_t from, size_t to, uint64_t *target,
                                 const ScrSortCompare *c) {
  size_t middle = from + ((to - from) >> 1);
  if (middle - from > 1 && !scr_bytes_merge_sort(target, from, middle, source, c)) return false;
  if (to - middle > 1 && !scr_bytes_merge_sort(target, middle, to, source, c)) return false;
  size_t left = from, right = middle;
  bool failed = false;
  for (size_t k = from; k < to; k++) {
    if (left < middle && right >= to) {
      target[k] = source[left++];
    } else if (left < middle) {
      if (scr_sort_greater(c, source[left], source[right], &failed)) {
        target[k] = source[right++];
      } else {
        if (failed) return false;
        target[k] = source[left++];
      }
    } else {
      target[k] = source[right++];
    }
  }
  return true;
}

/* Sorts a typed array through comparator `f` (of `arity` number
 * parameters) as TypedArray.prototype.sort does: the elements are read
 * once, sorted outside the array, and written back after the last
 * comparison, so the comparator sees the array unchanged and its writes to
 * it are overwritten. A comparator exception stays pending and leaves the
 * array as the comparator left it. */
void scr_bytes_sort_compare(ScrBytes *b, ScrClosure *f, uint32_t arity) {
  size_t n = b->len;
  if (n < 2) return;
  if (arity > 2) scr_trap("scriptc: invalid typed array comparator\n");
  if (n > SIZE_MAX / 2 / sizeof(uint64_t)) scr_arr_oom();
  if (b->shared) {
    /* The comparator runs on a private copy; a completed sort publishes
     * every element. */
    ScrBytes *copy = scr_bytes_snapshot(b);
    scr_bytes_sort_compare(copy, f, arity);
    if (!scr_exc_pending()) scr_shared_store(b->data, copy->data, n * scr_bytes_elem_size(b->elem));
    scr_bytes_release(copy);
    return;
  }
  uint64_t *work1 = malloc(n * sizeof(*work1)), *work2 = malloc(n * sizeof(*work2));
  if (!work1 || !work2) scr_arr_oom();
  for (size_t i = 0; i < n; i++) work1[i] = work2[i] = scr_slot_from_f64(scr_bytes_sort_load(b, i));
  ScrSortCompare c = {f, NULL, arity, true, false, 0, NULL};
  scr_dyn_this_push_dyn(NULL);
  bool sorted = scr_bytes_merge_sort(work2, 0, n, work1, &c);
  scr_dyn_this_pop();
  if (sorted) {
    for (size_t i = 0; i < n; i++) scr_bytes_sort_store(b, i, scr_slot_to_f64(work1[i]));
  }
  free(work1);
  free(work2);
}

#undef SCR_SORT_SELF_KEY
#undef SCR_SORT_ITEM_KEY
#undef SCR_SORT_KEYED_RECORDS
#undef SCR_SORT_RADIX_PASSES
#undef SCR_SORT_BLOCK_MERGE
#undef SCR_SORT_INSERT_UNTIL
#undef SCR_SORT_SCAN

/* ── comparator sort: V8's TimSort ──────────────────────────────────────
 * Array.prototype.sort and toSorted with a comparator run V8's TimSort
 * (third_party/v8/builtins/array-sort.tq) step for step: the same minimum
 * run length, run detection (strictly descending runs reverse), binary
 * insertion, run-stack invariants, galloping merges and adaptive gallop
 * threshold. Every comparison is `f(x, y) < 0` with V8's argument order, so
 * the comparator sees the calls Node makes, in Node's order, and an
 * inconsistent comparator produces Node's permutation. A comparator result
 * of NaN counts as 0, which `< 0` already gives. */

#define SCR_SORT_MIN_GALLOP 7
/* A backward merge reads cursor - 1 next: request the element the given
 * distance below it, if it is at or above `floor`. */
#define SCR_SORT_PREFETCH_BACK(c, buf, cursor, floor)                     \
  do {                                                                  \
    if ((cursor) >= (floor) + SCR_SORT_PREFETCH_DISTANCE + 1)           \
      SCR_SORT_PREFETCH_AT(c, buf, (cursor) - 1 - SCR_SORT_PREFETCH_DISTANCE, (cursor)); \
  } while (0)
/* Enough pending runs for any array length (V8's kMaxMergePending). */
#define SCR_SORT_MAX_PENDING 85

typedef struct {
  ScrSortCompare c;
  uint64_t *a;   /* the work array being sorted */
  uint64_t *tmp; /* merge scratch, grown on demand */
  size_t tmp_cap;
  size_t min_gallop;
  size_t run_base[SCR_SORT_MAX_PENDING];
  size_t run_len[SCR_SORT_MAX_PENDING];
  size_t runs;
  bool failed;
} ScrTimSort;

/* f(x, y) < 0, or false after the comparator throws (the state then records
 * the failure and every caller unwinds without another call). */
static inline __attribute__((always_inline)) bool scr_sort_less(const ScrSortCompare *c,
                                                                 uint64_t x, uint64_t y,
                                                                 bool *failed) {
  if (__builtin_expect(c->less != NULL, 0)) {
    /* A separate flag: the caller's stays out of memory. */
    bool stop = false;
    bool less = c->less(c->less_ctx, x, y, &stop);
    if (stop) *failed = true;
    return !stop && less;
  }
  double result;
  if (c->numbers) {
    double l = scr_slot_to_f64(x), r = scr_slot_to_f64(y);
    if (c->arity == 2) result = ((double (*)(ScrClosure *, double, double))c->f->fn)(c->f, l, r);
    else if (c->arity == 1) result = ((double (*)(ScrClosure *, double))c->f->fn)(c->f, l);
    else result = ((double (*)(ScrClosure *))c->f->fn)(c->f);
  } else {
    void *l = scr_slot_to_ptr(x), *r = scr_slot_to_ptr(y);
    void *fn = c->f->fn;
    if (c->borrowing) {
      fn = c->f->fn_borrowed;
    } else {
      if (l && c->arity >= 1) l = c->retain(l);
      if (r && c->arity >= 2) r = c->retain(r);
    }
    if (c->arity == 2) result = ((double (*)(ScrClosure *, void *, void *))fn)(c->f, l, r);
    else if (c->arity == 1) result = ((double (*)(ScrClosure *, void *))fn)(c->f, l);
    else result = ((double (*)(ScrClosure *))fn)(c->f);
  }
  if (scr_exc_pending()) {
    *failed = true;
    return false;
  }
  return result < 0;
}

/* Each sort step copies the comparator and keeps its failure flag in a
 * local, so both stay in registers across the comparator calls. */
#define SCR_TS_LOCALS            \
  const ScrSortCompare cmp_ = s->c; \
  bool failed_ = false
#define SCR_TS_LESS(x, y) scr_sort_less(&cmp_, (x), (y), &failed_)
#define SCR_TS_FAILED() (failed_ && (s->failed = true))
#define SCR_TS_FAIL_IF(value)       \
  do {                              \
    if (SCR_TS_FAILED()) return (value); \
  } while (0)

/* Merge scratch for the smaller run, at most n / 2 slots: allocated with
 * the work copy (scr_sort_copy), so a sort makes one allocation. */
static uint64_t *scr_sort_tmp(ScrTimSort *s, size_t n) {
  if (n > s->tmp_cap) scr_trap("scriptc: internal error: sort scratch overflow\n");
  return s->tmp;
}

/* Sorts [low, high) given that [low, start) is already sorted. */
static void scr_sort_binary_insertion(ScrTimSort *s, size_t low, size_t start, size_t high) {
  SCR_TS_LOCALS;
  uint64_t *a = s->a;
  if (low == start) start++;
  for (; start < high; start++) {
    size_t left = low, right = start;
    uint64_t pivot = a[right];
    while (left < right) {
      size_t mid = left + ((right - left) >> 1);
      bool less = SCR_TS_LESS(pivot, a[mid]);
      if (SCR_TS_FAILED()) return;
      if (less) right = mid;
      else left = mid + 1;
    }
    memmove(a + left + 1, a + left, (start - left) * sizeof(*a));
    a[left] = pivot;
  }
}

/* The length of the run starting at low (a strictly descending run is
 * reversed in place), or 0 after a comparator exception. */
static size_t scr_sort_count_run(ScrTimSort *s, size_t low, size_t high) {
  SCR_TS_LOCALS;
  uint64_t *a = s->a;
  size_t next = low + 1;
  if (next == high) return 1;
  size_t length = 2;
  bool descending = SCR_TS_LESS(a[next], a[next - 1]);
  SCR_TS_FAIL_IF(0);
  uint64_t previous = a[next];
  for (size_t i = next + 1; i < high; i++) {
    SCR_SORT_PREFETCH(cmp_, a, i, high);
    bool less = SCR_TS_LESS(a[i], previous);
    SCR_TS_FAIL_IF(0);
    if (descending ? !less : less) break;
    previous = a[i];
    length++;
  }
  if (descending) {
    for (size_t l = low, r = low + length - 1; l < r; l++, r--) {
      uint64_t v = a[l];
      a[l] = a[r];
      a[r] = v;
    }
  }
  return length;
}

/* Gallop searches probe far apart in the runs. The next exponential probe
 * is known before the current comparison, and a binary search step has two
 * possible next probes: request their elements ahead of the comparator
 * call, so its loads of them hit the cache. */
#define SCR_SORT_PREFETCH_SLOT(c, arr, index, limit)       \
  do {                                                    \
    if (!(c).numbers && (index) < (limit))                \
      __builtin_prefetch(scr_slot_to_ptr((arr)[(index)])); \
  } while (0)

/* A gallop result k as an offset into its run: 0 <= k <= length holds by
 * construction, and the merges copy k or length - k slots, so a violation
 * is an internal error rather than a copy. */
static size_t scr_sort_gallop_result(ptrdiff_t k, size_t length) {
  if (k < 0 || (size_t)k > length) scr_trap("scriptc: internal error: sort gallop out of range\n");
  return (size_t)k;
}

/* The offset k in [0, length] with arr[base + k - 1] < key <= arr[base + k]. */
static __attribute__((noinline)) size_t scr_sort_gallop_left(ScrTimSort *s, const uint64_t *arr, uint64_t key, size_t base,
                                   size_t length, size_t hint) {
  SCR_TS_LOCALS;
  size_t last = 0, offset = 1;
  bool less = SCR_TS_LESS(arr[base + hint], key);
  SCR_TS_FAIL_IF(0);
  ptrdiff_t lo, hi;
  if (less) {
    size_t max = length - hint;
    while (offset < max) {
      SCR_SORT_PREFETCH_SLOT(cmp_, arr, base + hint + 2 * offset + 1, base + hint + max);
      bool l = SCR_TS_LESS(arr[base + hint + offset], key);
      SCR_TS_FAIL_IF(0);
      if (!l) break;
      last = offset;
      offset = (offset << 1) + 1;
    }
    if (offset > max) offset = max;
    lo = (ptrdiff_t)(last + hint);
    hi = (ptrdiff_t)(offset + hint);
  } else {
    size_t max = hint + 1;
    while (offset < max) {
      if (2 * offset + 1 < max) SCR_SORT_PREFETCH_SLOT(cmp_, arr, base + hint - (2 * offset + 1), base + length);
      bool l = SCR_TS_LESS(arr[base + hint - offset], key);
      SCR_TS_FAIL_IF(0);
      if (l) break;
      last = offset;
      offset = (offset << 1) + 1;
    }
    if (offset > max) offset = max;
    lo = (ptrdiff_t)hint - (ptrdiff_t)offset;
    hi = (ptrdiff_t)hint - (ptrdiff_t)last;
  }
  lo++;
  while (lo < hi) {
    ptrdiff_t m = lo + ((hi - lo) >> 1);
    if (m + 1 < hi) SCR_SORT_PREFETCH_SLOT(cmp_, arr, base + (size_t)(m + 1 + ((hi - m - 1) >> 1)), base + length);
    if (lo < m) SCR_SORT_PREFETCH_SLOT(cmp_, arr, base + (size_t)(lo + ((m - lo) >> 1)), base + length);
    bool l = SCR_TS_LESS(arr[base + (size_t)m], key);
    SCR_TS_FAIL_IF(0);
    if (l) lo = m + 1;
    else hi = m;
  }
  return scr_sort_gallop_result(hi, length);
}

/* The offset k in [0, length] with arr[base + k - 1] <= key < arr[base + k]. */
static __attribute__((noinline)) size_t scr_sort_gallop_right(ScrTimSort *s, const uint64_t *arr, uint64_t key, size_t base,
                                    size_t length, size_t hint) {
  SCR_TS_LOCALS;
  size_t last = 0, offset = 1;
  bool less = SCR_TS_LESS(key, arr[base + hint]);
  SCR_TS_FAIL_IF(0);
  ptrdiff_t lo, hi;
  if (less) {
    size_t max = hint + 1;
    while (offset < max) {
      if (2 * offset + 1 < max) SCR_SORT_PREFETCH_SLOT(cmp_, arr, base + hint - (2 * offset + 1), base + length);
      bool l = SCR_TS_LESS(key, arr[base + hint - offset]);
      SCR_TS_FAIL_IF(0);
      if (!l) break;
      last = offset;
      offset = (offset << 1) + 1;
    }
    if (offset > max) offset = max;
    lo = (ptrdiff_t)hint - (ptrdiff_t)offset;
    hi = (ptrdiff_t)hint - (ptrdiff_t)last;
  } else {
    size_t max = length - hint;
    while (offset < max) {
      SCR_SORT_PREFETCH_SLOT(cmp_, arr, base + hint + 2 * offset + 1, base + hint + max);
      bool l = SCR_TS_LESS(key, arr[base + hint + offset]);
      SCR_TS_FAIL_IF(0);
      if (l) break;
      last = offset;
      offset = (offset << 1) + 1;
    }
    if (offset > max) offset = max;
    lo = (ptrdiff_t)(last + hint);
    hi = (ptrdiff_t)(offset + hint);
  }
  lo++;
  while (lo < hi) {
    ptrdiff_t m = lo + ((hi - lo) >> 1);
    if (m + 1 < hi) SCR_SORT_PREFETCH_SLOT(cmp_, arr, base + (size_t)(m + 1 + ((hi - m - 1) >> 1)), base + length);
    if (lo < m) SCR_SORT_PREFETCH_SLOT(cmp_, arr, base + (size_t)(lo + ((m - lo) >> 1)), base + length);
    bool l = SCR_TS_LESS(key, arr[base + (size_t)m]);
    SCR_TS_FAIL_IF(0);
    if (l) hi = m;
    else lo = m + 1;
  }
  return scr_sort_gallop_result(hi, length);
}

/* Merges [base_a, base_a + len_a) and the run after it, len_a <= len_b,
 * through a copy of run A, front to back. */
static __attribute__((noinline)) void scr_sort_merge_low(ScrTimSort *s, size_t base_a, size_t len_a, size_t base_b,
                               size_t len_b) {
  uint64_t *a = s->a;
  SCR_TS_LOCALS;
  uint64_t *tmp = scr_sort_tmp(s, len_a);
  memcpy(tmp, a + base_a, len_a * sizeof(*a));
  size_t dest = base_a, ct = 0, cb = base_b;
  size_t min_gallop = s->min_gallop;
  a[dest++] = a[cb++];
  if (--len_b == 0) goto succeed;
  if (len_a == 1) goto copy_b;
  for (;;) {
    size_t wins_a = 0, wins_b = 0;
    {
      /* The one-at-a-time merge keeps only the cursors live across the
       * comparator call: run A's unplaced elements fill the gap between
       * the destination and run B's cursor, so dest = cb - len_a, and only
       * the side that won last has a nonzero win count. */
      const size_t end_b = cb + len_b, end_t = ct + len_a;
      size_t win = 0;
      bool b_won = false;
      for (;;) {
        uint64_t xb = a[cb], xt = tmp[ct];
        bool less = SCR_TS_LESS(xb, xt);
        if (SCR_TS_FAILED()) return;
        if (less) {
          SCR_SORT_PREFETCH(cmp_, a, cb, end_b);
          a[cb - (end_t - ct)] = xb;
          cb++;
          win = b_won ? win + 1 : 1;
          b_won = true;
          if (cb == end_b || win >= min_gallop) break;
        } else {
          SCR_SORT_PREFETCH(cmp_, tmp, ct, end_t);
          a[cb - (end_t - ct)] = xt;
          ct++;
          win = b_won ? 1 : win + 1;
          b_won = false;
          if (end_t - ct == 1 || win >= min_gallop) break;
        }
      }
      len_b = end_b - cb;
      len_a = end_t - ct;
      dest = cb - len_a;
      wins_b = b_won ? win : 0;
      wins_a = b_won ? 0 : win;
      if (len_b == 0) goto succeed;
      if (len_a == 1) goto copy_b;
    }
    min_gallop++;
    bool first = true;
    while (wins_a >= SCR_SORT_MIN_GALLOP || wins_b >= SCR_SORT_MIN_GALLOP || first) {
      first = false;
      min_gallop = min_gallop > 1 ? min_gallop - 1 : 1;
      s->min_gallop = min_gallop;
      wins_a = scr_sort_gallop_right(s, tmp, a[cb], ct, len_a, 0);
      if (s->failed) return;
      if (wins_a > 0) {
        memcpy(a + dest, tmp + ct, wins_a * sizeof(*a));
        dest += wins_a;
        ct += wins_a;
        len_a -= wins_a;
        if (len_a == 1) goto copy_b;
        if (len_a == 0) goto succeed;
      }
      a[dest++] = a[cb++];
      if (--len_b == 0) goto succeed;
      wins_b = scr_sort_gallop_left(s, a, tmp[ct], cb, len_b, 0);
      if (s->failed) return;
      if (wins_b > 0) {
        memmove(a + dest, a + cb, wins_b * sizeof(*a));
        dest += wins_b;
        cb += wins_b;
        len_b -= wins_b;
        if (len_b == 0) goto succeed;
      }
      a[dest++] = tmp[ct++];
      if (--len_a == 1) goto copy_b;
    }
    min_gallop++;
    s->min_gallop = min_gallop;
  }
succeed:
  if (len_a > 0) memcpy(a + dest, tmp + ct, len_a * sizeof(*a));
  return;
copy_b:
  memmove(a + dest, a + cb, len_b * sizeof(*a));
  a[dest + len_b] = tmp[ct];
}

/* Merges [base_a, base_a + len_a) and the run after it, len_a > len_b,
 * through a copy of run B, back to front. */
static __attribute__((noinline)) void scr_sort_merge_high(ScrTimSort *s, size_t base_a, size_t len_a, size_t base_b,
                                size_t len_b) {
  uint64_t *a = s->a;
  SCR_TS_LOCALS;
  uint64_t *tmp = scr_sort_tmp(s, len_b);
  memcpy(tmp, a + base_b, len_b * sizeof(*a));
  /* Indices one past the next element: run A's cursor can reach base_a. */
  size_t dest = base_b + len_b, ca = base_a + len_a, ct = len_b;
  size_t min_gallop = s->min_gallop;
  a[--dest] = a[--ca];
  if (--len_a == 0) goto succeed;
  if (len_b == 1) goto copy_a;
  for (;;) {
    size_t wins_a = 0, wins_b = 0;
    {
      /* As in scr_sort_merge_low: run B's unplaced elements tmp[0, ct) fill
       * the gap between run A's cursor and the destination, so
       * dest = ca + ct, len_a = ca - base_a and len_b = ct. */
      size_t win = 0;
      bool a_won = false;
      for (;;) {
        uint64_t xt = tmp[ct - 1], xa = a[ca - 1];
        bool less = SCR_TS_LESS(xt, xa);
        if (SCR_TS_FAILED()) return;
        if (less) {
          SCR_SORT_PREFETCH_BACK(cmp_, a, ca, base_a);
          a[ca + ct - 1] = xa;
          ca--;
          win = a_won ? win + 1 : 1;
          a_won = true;
          if (ca == base_a || win >= min_gallop) break;
        } else {
          SCR_SORT_PREFETCH_BACK(cmp_, tmp, ct, 0);
          a[ca + ct - 1] = xt;
          ct--;
          win = a_won ? 1 : win + 1;
          a_won = false;
          if (ct == 1 || win >= min_gallop) break;
        }
      }
      len_a = ca - base_a;
      len_b = ct;
      dest = ca + ct;
      wins_a = a_won ? win : 0;
      wins_b = a_won ? 0 : win;
      if (len_a == 0) goto succeed;
      if (len_b == 1) goto copy_a;
    }
    min_gallop++;
    bool first = true;
    while (wins_a >= SCR_SORT_MIN_GALLOP || wins_b >= SCR_SORT_MIN_GALLOP || first) {
      first = false;
      min_gallop = min_gallop > 1 ? min_gallop - 1 : 1;
      s->min_gallop = min_gallop;
      size_t k = scr_sort_gallop_right(s, a, tmp[ct - 1], base_a, len_a, len_a - 1);
      if (s->failed) return;
      wins_a = len_a - k;
      if (wins_a > 0) {
        dest -= wins_a;
        ca -= wins_a;
        memmove(a + dest, a + ca, wins_a * sizeof(*a));
        len_a -= wins_a;
        if (len_a == 0) goto succeed;
      }
      a[--dest] = tmp[--ct];
      if (--len_b == 1) goto copy_a;
      k = scr_sort_gallop_left(s, tmp, a[ca - 1], 0, len_b, len_b - 1);
      if (s->failed) return;
      wins_b = len_b - k;
      if (wins_b > 0) {
        dest -= wins_b;
        ct -= wins_b;
        memcpy(a + dest, tmp + ct, wins_b * sizeof(*a));
        len_b -= wins_b;
        if (len_b == 1) goto copy_a;
        if (len_b == 0) goto succeed;
      }
      a[--dest] = a[--ca];
      if (--len_a == 0) goto succeed;
    }
    min_gallop++;
    s->min_gallop = min_gallop;
  }
succeed:
  if (len_b > 0) memcpy(a + dest - len_b, tmp + ct - len_b, len_b * sizeof(*a));
  return;
copy_a:
  dest -= len_a;
  ca -= len_a;
  memmove(a + dest, a + ca, len_a * sizeof(*a));
  a[dest - 1] = tmp[ct - 1];
}

/* Merges pending runs i and i + 1 (i is the second- or third-last run). */
static void scr_sort_merge_at(ScrTimSort *s, size_t i) {
  uint64_t *a = s->a;
  size_t base_a = s->run_base[i], len_a = s->run_len[i];
  size_t base_b = s->run_base[i + 1], len_b = s->run_len[i + 1];
  s->run_len[i] = len_a + len_b;
  if (i + 3 == s->runs) {
    s->run_base[i + 1] = s->run_base[i + 2];
    s->run_len[i + 1] = s->run_len[i + 2];
  }
  s->runs--;
  size_t k = scr_sort_gallop_right(s, a, a[base_b], base_a, len_a, 0);
  if (s->failed) return;
  base_a += k;
  len_a -= k;
  if (len_a == 0) return;
  len_b = scr_sort_gallop_left(s, a, a[base_a + len_a - 1], base_b, len_b, len_b - 1);
  if (s->failed || len_b == 0) return;
  if (len_a <= len_b) scr_sort_merge_low(s, base_a, len_a, base_b, len_b);
  else scr_sort_merge_high(s, base_a, len_a, base_b, len_b);
}

/* Whether run m (counting from the bottom) satisfies
 * len[m - 2] > len[m - 1] + len[m]. */
static bool scr_sort_run_invariant(const ScrTimSort *s, size_t m) {
  if (m < 2) return true;
  return s->run_len[m - 2] > s->run_len[m - 1] + s->run_len[m];
}

static void scr_sort_merge_collapse(ScrTimSort *s) {
  while (s->runs > 1 && !s->failed) {
    size_t m = s->runs - 2;
    if (!scr_sort_run_invariant(s, m + 1) || !scr_sort_run_invariant(s, m)) {
      if (s->run_len[m - 1] < s->run_len[m + 1]) m--;
      scr_sort_merge_at(s, m);
    } else if (s->run_len[m] <= s->run_len[m + 1]) {
      scr_sort_merge_at(s, m);
    } else {
      break;
    }
  }
}

static void scr_sort_merge_force_collapse(ScrTimSort *s) {
  while (s->runs > 1 && !s->failed) {
    size_t m = s->runs - 2;
    if (m > 0 && s->run_len[m - 1] < s->run_len[m + 1]) m--;
    scr_sort_merge_at(s, m);
  }
}

/* Runs the sort over s->a[0, n), n >= 2. */
static void scr_sort_run(ScrTimSort *s, size_t n) {
  size_t min_run = n, r = 0;
  while (min_run >= 64) {
    r |= min_run & 1;
    min_run >>= 1;
  }
  min_run += r;
  size_t low = 0, remaining = n;
  while (remaining != 0 && !s->failed) {
    size_t length = scr_sort_count_run(s, low, low + remaining);
    if (s->failed) break;
    if (length < min_run) {
      size_t forced = min_run < remaining ? min_run : remaining;
      scr_sort_binary_insertion(s, low, low + length, low + forced);
      if (s->failed) break;
      length = forced;
    }
    s->run_base[s->runs] = low;
    s->run_len[s->runs] = length;
    s->runs++;
    scr_sort_merge_collapse(s);
    low += length;
    remaining -= length;
  }
  if (!s->failed) scr_sort_merge_force_collapse(s);
}

/* The work copy and merge scratch of one sort. Returning a buffer of a few
 * hundred KiB to the system allocator after every sort lets it trim its
 * heap, and the next sort faults the pages back in, so each thread keeps
 * its largest buffer up to SCR_SORT_CACHE_SLOTS slots. A sort that starts
 * inside a comparator finds the cache taken and allocates its own. */
#define SCR_SORT_CACHE_SLOTS ((size_t)1 << 17)
static SCR_TL uint64_t *scr_sort_cache;
static SCR_TL size_t scr_sort_cache_slots;
static SCR_TL bool scr_sort_cache_registered;

static void scr_sort_cache_free(void) {
  free(scr_sort_cache);
  scr_sort_cache = NULL;
  scr_sort_cache_slots = 0;
}

static uint64_t *scr_sort_buffer_take(size_t slots, size_t *cap) {
  if (scr_sort_cache && scr_sort_cache_slots >= slots) {
    uint64_t *buffer = scr_sort_cache;
    *cap = scr_sort_cache_slots;
    scr_sort_cache = NULL;
    scr_sort_cache_slots = 0;
    return buffer;
  }
  uint64_t *buffer = malloc(slots * sizeof(*buffer));
  if (!buffer) scr_arr_oom();
  *cap = slots;
  return buffer;
}

static void scr_sort_buffer_give(uint64_t *buffer, size_t cap) {
  if (cap > SCR_SORT_CACHE_SLOTS || cap <= scr_sort_cache_slots) {
    free(buffer);
    return;
  }
  if (!scr_sort_cache_registered) {
    scr_sort_cache_registered = true;
    scr_atexit(scr_sort_cache_free);
  }
  free(scr_sort_cache);
  scr_sort_cache = buffer;
  scr_sort_cache_slots = cap;
}

/* Sorts a private copy of values[0, n) and, on success, stores the result
 * back. Returns false when a comparator throws; `values` is then unchanged.
 * `values` holds every slot exactly once, in its original order, whenever
 * a comparator runs. */
static bool scr_sort_copy(ScrTimSort *s, uint64_t *values, size_t n) {
  size_t scratch = n / 2 + 1, cap;
  if (n > SIZE_MAX / sizeof(*s->a) - scratch) scr_arr_oom();
  s->a = scr_sort_buffer_take(n + scratch, &cap);
  memcpy(s->a, values, n * sizeof(*s->a));
  s->tmp = s->a + n;
  s->tmp_cap = cap - n;
  s->min_gallop = SCR_SORT_MIN_GALLOP;
  s->runs = 0;
  s->failed = false;
  scr_sort_run(s, n);
  bool ok = !s->failed;
  if (ok) memcpy(values, s->a, n * sizeof(*values));
  scr_sort_buffer_give(s->a, cap);
  return ok;
}

/* Sorts `n >= 2` slots with V8's TimSort through the closure comparator.
 * That keeps array storage passed here consistent for the cycle collector,
 * and lets callers release or keep the slots after an exception; `scratch`
 * is accepted for the callers' benefit, as the private copy makes it
 * unnecessary. */
static bool scr_sort_slots(uint64_t *values, size_t n, const ScrSortCompare *cmp,
                           bool scratch) {
  (void)scratch;
  ScrTimSort s;
  s.c = *cmp;
  scr_dyn_this_push_dyn(NULL);
  bool ok = scr_sort_copy(&s, values, n);
  scr_dyn_this_pop();
  return ok;
}

bool scr_sort_slots_with(uint64_t *values, size_t n, ScrSortLess less, void *ctx) {
  if (n < 2) return true;
  ScrTimSort s;
  memset(&s.c, 0, sizeof s.c);
  s.c.less = less;
  s.c.less_ctx = ctx;
  return scr_sort_copy(&s, values, n);
}

#ifdef SCR_SORT_TEST
/* Test-only entry points into the TimSort steps, deliberately absent from
 * the normal runtime ABI. `arr` and `a` are indexed as the sort indexes its
 * work array, so a test can pass a base pointer below its buffer and reach
 * the buffer through indices past 2^32. */
static ScrTimSort scr_sort_test_state(ScrSortLess less) {
  ScrTimSort s;
  memset(&s, 0, sizeof s);
  s.c.less = less;
  s.min_gallop = SCR_SORT_MIN_GALLOP;
  return s;
}

size_t scr_sort_test_gallop(bool right, const uint64_t *arr, uint64_t key, size_t base,
                            size_t length, size_t hint, ScrSortLess less) {
  ScrTimSort s = scr_sort_test_state(less);
  return right ? scr_sort_gallop_right(&s, arr, key, base, length, hint)
               : scr_sort_gallop_left(&s, arr, key, base, length, hint);
}

/* Merges the sorted runs a[base, base + len_a) and a[base + len_a, base +
 * len_a + len_b) as the sort's merge step does: galloping trims both runs,
 * then merge_low or merge_high runs through `tmp`. Returns 1 after
 * merge_low, 2 after merge_high and 0 when the trimmed runs were already in
 * order. */
int scr_sort_test_merge(uint64_t *a, size_t base, size_t len_a, size_t len_b, uint64_t *tmp,
                         size_t tmp_cap, ScrSortLess less) {
  ScrTimSort s = scr_sort_test_state(less);
  s.a = a;
  s.tmp = tmp;
  s.tmp_cap = tmp_cap;
  s.run_base[0] = base;
  s.run_len[0] = len_a;
  s.run_base[1] = base + len_a;
  s.run_len[1] = len_b;
  s.runs = 2;
  size_t k = scr_sort_gallop_right(&s, a, a[base + len_a], base, len_a, 0);
  size_t trimmed_b = scr_sort_gallop_left(&s, a, a[base + len_a - 1], base + len_a, len_b, len_b - 1);
  scr_sort_merge_at(&s, 0);
  if (k == len_a || trimmed_b == 0) return 0;
  return len_a - k <= trimmed_b ? 1 : 2;
}

size_t scr_sort_test_gallop_result(ptrdiff_t k, size_t length) {
  return scr_sort_gallop_result(k, length);
}
#endif

#undef SCR_TS_FAIL_IF
#undef SCR_TS_FAILED
#undef SCR_TS_LESS
#undef SCR_TS_LOCALS
#undef SCR_SORT_PREFETCH_BACK
#undef SCR_SORT_PREFETCH_SLOT

/* Sorts the first `count` slots of a private, compacted snapshot. The array
 * keeps owning every element and stays untouched while user code runs, so
 * the cycle collector and a throwing comparator both see the original
 * snapshot; the sorted permutation is published only after success. */
void scr_arr_sort_values(ScrArr *a, double count, ScrClosure *f, uint32_t arity,
                         int32_t order, ScrClosure *key) {
  size_t n = (size_t)count;
  if (n < 2) return;
  if (n > a->len || n > SIZE_MAX / 2 / sizeof(uint64_t))
    scr_trap("scriptc: invalid comparator sort snapshot\n");
  ScrSortCompare c = scr_sort_compare_for(a, f, arity, order, key);
  uint64_t *src = malloc(n * sizeof(*src));
  if (!src) scr_arr_oom();
  for (size_t i = 0; i < n; i++) {
    if (scr_arr_state_at(a, i, &src[i]) != SCR_ARR_VALUE)
      scr_trap("scriptc: invalid comparator sort snapshot\n");
  }
  bool sorted = (order != 0 && scr_sort_keyed(src, n, &c)) || scr_sort_slots(src, n, &c, true);
  /* A permutation of the same owned slots: no reference count changes. */
  for (size_t i = 0; sorted && i < n; i++) {
    if (i < a->cap) {
      scr_arr_dense_put(a, i, src[i]);
    } else {
      size_t pos = scr_arr_sparse_lower_bound(SCR_AX(a)->sparse, SCR_AX(a)->sparse_len, i);
      SCR_AX(a)->sparse[pos].slot = src[i];
    }
  }
  free(src);
}

/* Whether every index below the length holds a value in dense storage: no
 * holes, no storage-level undefined and no sparse tail. */
static bool scr_arr_dense_values(const ScrArr *a) {
  if (!scr_arr_is_dense(a)) return false;
  if (a->filled == a->len) return true;
  const uint8_t *present = a->present;
  bool all = true;
  for (size_t i = 0; i < a->len; i++) all &= present[i] == SCR_ARR_VALUE;
  return all;
}

/* The 8-byte slots of `a` when every index below its length holds a value
 * in dense storage, with the length in *len; NULL for holes,
 * storage-level undefined, a sparse tail, an empty array, or boolean
 * elements (stored in 1-byte slots). The slots are borrowed and stay valid
 * while nothing writes the array. */
const uint64_t *scr_arr_dense_slots(const ScrArr *a, size_t *len) {
  if (a->len == 0 || a->elem == SCR_ELEM_BOOL || !scr_arr_dense_values(a)) return NULL;
  *len = a->len;
  return a->data;
}

/* The dense comparator sort: `a.sort(f)` (or, with `owned`, the private copy
 * of `a.toSorted(f)`) when every index below the length holds a value.
 * Returns false, having run no user code, when the array has holes,
 * storage-level undefined or a sparse tail: the caller
 * then takes the compacting snapshot path.
 *
 * Otherwise this is the spec's SortIndexedProperties then write-back without
 * the IR snapshot. A private copy sorts in its own storage. For `sort`, the
 * values are read once into a heap buffer, sorted there, and only a
 * successful sort writes `a[0..n)`: while the comparator runs, `a` itself is
 * untouched and observable as before. The comparator may write `a`; a
 * reference element it overwrites stays alive because the buffer holds its
 * own reference. The write-back then follows Set semantics: in place when
 * indices below the snapshot length are still dense storage, else through
 * the general element write, which fills holes, regrows a truncated array
 * and keeps appended indices. A comparator exception leaves `a` as the
 * comparator left it. A keyed sort calls no user code, so it permutes the
 * slots of an unrestricted `a` in place. */
bool scr_arr_sort_dense(ScrArr *a, ScrClosure *f, uint32_t arity, bool owned, int32_t order,
                        ScrClosure *key) {
  size_t n = a->len;
  /* In-place sort skips singleton writes; toSorted still materializes a
   * singleton hole through the caller's compacting snapshot path. */
  if (n < 2) return !owned || scr_arr_dense_values(a);
  if (!scr_arr_dense_values(a)) return false;
  if (n > SIZE_MAX / 2 / sizeof(uint64_t)) scr_arr_oom();
  ScrSortCompare c = scr_sort_compare_for(a, f, arity, order, key);
  /* Nothing else can reach a private copy: its own storage is sorted, and
   * the same owned slots only permute. A keyed sort runs no user code, so
   * it permutes a shared array's slots in place too. */
  if (!scr_arr_integrity_flags(a) && order != 0 && scr_sort_keyed(a->data, n, &c)) return true;
  if (owned && !scr_arr_integrity_flags(a)) {
    scr_sort_slots(a->data, n, &c, false);
    return true;
  }
  bool retained = !c.numbers;
  uint64_t *src = malloc(n * sizeof(*src));
  if (!src) scr_arr_oom();
  memcpy(src, a->data, n * sizeof(*src));
  if (retained)
    for (size_t i = 0; i < n; i++) src[i] = scr_elem_retain_slot(a, src[i]);
  if (!((order != 0 && scr_sort_keyed(src, n, &c)) || scr_sort_slots(src, n, &c, true))) {
    if (retained)
      for (size_t i = 0; i < n; i++) scr_elem_release(a, src[i]);
    free(src);
    return true;
  }
  /* Comparator callbacks may strengthen integrity or create holes. Only
   * the current unrestricted receiver permits bulk writeback. */
  if (!scr_arr_integrity_flags(a) && a->len >= n && a->cap >= n) {
    if (!retained) {
      memcpy(a->data, src, n * sizeof(*src));
      memset(a->present, SCR_ARR_VALUE, n);
    } else {
      /* Publish each new edge before releasing the value it replaces: a
       * release can collect cycles. The buffer still holds the slots not
       * yet written. */
      for (size_t i = 0; i < n; i++) {
        bool held = a->present[i] == SCR_ARR_VALUE;
        uint64_t old = held ? a->data[i] : 0;
        a->data[i] = src[i];
        a->present[i] = SCR_ARR_VALUE;
        if (held) scr_elem_release(a, old);
      }
    }
  } else {
    for (size_t i = 0; i < n; i++) {
      if (!scr_arr_set_state_owned(a, (double)i, src[i], SCR_ARR_VALUE)) {
        if (retained)
          for (size_t j = i + 1; j < n; j++) scr_elem_release(a, src[j]);
        break;
      }
    }
  }
  scr_arr_refill(a);
  free(src);
  return true;
}

/* join over a hole-free string array: size the result exactly, then copy
 * each piece without per-append capacity checks. Only a piece starting
 * with a lone low surrogate can complete a pair across its seam. */
static ScrStr *scr_arr_join_dense_str(const ScrArr *a, const ScrStr *sep) {
  const size_t limit = SIZE_MAX - sizeof(ScrStr) - 1;
  size_t n = a->len;
  if (n > 1 && sep->len > limit / (n - 1)) scr_arr_oom();
  size_t total = n > 1 ? (n - 1) * sep->len : 0;
  bool ascii = n < 2 || sep->ascii, lone = scr_wtf8_any();
  bool lead_low = lone && n > 1 && scr_wtf8_low_at(sep->data);
  for (size_t i = 0; i < n; i++) {
    const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(a->data[i]);
    if (!s) continue;
    total = scr_join_size(total, s->len);
    ascii &= s->ascii;
    if (lone) lead_low |= scr_wtf8_low_at(s->data);
  }
  ScrStr *out = scr_str_alloc_raw(total, total);
  char *w = out->data;
  for (size_t i = 0; i < n; i++) {
    if (i > 0) {
      scr_copy_bytes(w, sep->data, sep->len);
      w += sep->len;
    }
    const ScrStr *s = (const ScrStr *)scr_slot_to_ptr(a->data[i]);
    if (!s) continue;
    scr_copy_bytes(w, s->data, s->len);
    w += s->len;
  }
  out->data[total] = '\0';
  if (lead_low) scr_str_fuse_surrogates(out);
  else if (ascii) scr_str_note_ascii(out);
  return out;
}

ScrStr *scr_arr_join(ScrArr *a, ScrStr *sep) {
  if (a->elem == SCR_ELEM_STR && a->filled == a->len) return scr_arr_join_dense_str(a, sep);
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
  /* Only a piece starting with a lone low surrogate can complete a pair
   * across its seam; the finished string then needs fusing. */
  bool lone = scr_wtf8_any();
  bool lead_low = lone && a->len > 1 && scr_wtf8_low_at(sep->data);
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
        if (!s) break;
        if (lone) lead_low |= scr_wtf8_low_at(s->data);
        scr_join_append(&out, s->data, s->len);
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
  if (lead_low) scr_str_fuse_surrogates(out);
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
  scr_str_fuse_surrogates(out); /* pieces may complete surrogate pairs */
  return out;
}

void scr_arr_copy_metadata(ScrArr *a, ScrDyn *target) {
  if (!SCR_AX(a)->metadata) return;
  /* Snapshot properties retain descriptors and symbols. Assignment would
   * discard accessors and attributes, and could invoke inherited setters. */
  scr_dyn_release(scr_dyn_copy_property_descriptors(target, SCR_AX(a)->metadata));
  if (scr_exc_pending()) return;
  ScrDyn *old = target->prototype;
  target->prototype = SCR_AX(a)->metadata->prototype
      ? scr_dyn_retain(SCR_AX(a)->metadata->prototype) : NULL;
  target->null_proto = SCR_AX(a)->metadata->null_proto;
  scr_dyn_release(old);
}
