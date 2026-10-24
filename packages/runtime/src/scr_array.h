/* scriptc runtime — arrays and Math over arrays (scr_array.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_ARRAY_H
#define SCR_ARRAY_H

#include "scr_qs.h"

/* ── arrays ─────────────────────────────────────────────────────────
 * Monomorphic, growable, refcounted. Elements live in 8-byte slots
 * (doubles/pointers via memcpy and casts), except SCR_ELEM_BOOL, whose
 * dense storage holds one byte (0 or 1) per element; `elem` records what
 * the slots hold so the array can release its own reference elements — ScrStr's
 * layout is untouched (interned-literal statics depend on it), so the
 * element kind lives here instead of in a shared object header. A separate
 * presence bitset distinguishes a hole from a present `undefined`-carrying
 * reference value. Very large indices stay in a sorted sparse side store;
 * the dense slot array is retained for ordinary packed arrays.
 *
 * Index arguments are doubles (JS numbers). A valid array index is a
 * non-negative integer below 2^32-1; reads must be < len and writes may
 * extend len through a sparse hole. Noncanonical numeric keys are ordinary
 * properties stored by their JavaScript number-to-string spelling. Anything
 * else prints
 *   scriptc: RangeError: array index <i> out of bounds (length <n>)
 * to stderr and abort()s in the proven-presence accessors. `scr_arr_has` is
 * the shared presence query used before those accessors when the language
 * surface permits an undefined result.
 *
 * Ownership: _get_ref returns +1 (retains before returning); _set_ref and
 * _push_ref take ownership of the new element (and _set_ref releases the
 * old one); _pop_ref transfers the element's reference out to the caller.
 */

typedef enum {
  SCR_ELEM_F64,
  SCR_ELEM_BOOL,
  SCR_ELEM_STR, /* slots are ScrStr* — released with the array */
  SCR_ELEM_ARR, /* slots are ScrArr* — released recursively */
  SCR_ELEM_BYTES, /* slots are ScrBytes* — released with the array */
  /* Slots are void* to values the runtime cannot lay out itself — records,
   * class instances, unions, and cycle-capable inner arrays. The element
   * type's RC entry points arrive at construction (scr_arr_new_ops) as one
   * constant descriptor per element type, stored once per array; every
   * array is still monomorphic (one element type, one set of entry points). */
  SCR_ELEM_REF,
  /* An SCR_ELEM_REF type whose elements are compact class instances in the
   * program-lifetime region (SCR_ARR_OPS_COMPACT): 4-byte slots holding the
   * address over 8, 0 for NULL. Compact instances are never counted or
   * traced, so these arrays retain, release and trace nothing. */
  SCR_ELEM_CREF,
  /* Numbers that the compiler proves are always int32 (never -0), in
   * 4-byte slots: arrays that only compiled element accesses ever reach
   * (backend/llvm int32 arrays). Every runtime slot is the value's double
   * bits, as for SCR_ELEM_F64: scr_arr_dense_get and scr_arr_dense_put
   * convert, so the paths compiled code calls need no case of their own. */
  SCR_ELEM_I32,
} ScrElemKind;

typedef enum {
  SCR_ARR_HOLE = 0,
  SCR_ARR_VALUE = 1,
  SCR_ARR_UNDEFINED = 2,
} ScrArrState;

/* The RC entry points of an SCR_ELEM_REF array's element type: one constant
 * per element type (emitted by the compiler, or static in the runtime),
 * shared by every array of that type. retain/release are the type's `_v`
 * adapters; trace is non-NULL exactly when the element type carries a cycle
 * header. */
typedef struct ScrArrOps {
  void *(*retain)(void *);
  void (*release)(void *);
  ScrTraceFn trace;
  /* Registry id (scr_arr_ops_table), 0 until scr_arr_ops_register assigns
   * it on the first array of the type. Descriptors are writable for it. */
  uint32_t id;
  /* SCR_ARR_OPS_*. On 64-bit targets the field takes the struct's former
   * tail padding, so descriptors emitted without it read 0 here; on 32-bit
   * targets it lies past their end and is never read (scr_arr_ops_compact). */
  uint32_t flags;
} ScrArrOps;

/* The elements are compact class instances in the program-lifetime region:
 * arrays of the type are SCR_ELEM_CREF (llvm/shapes.ts arrOps). */
#define SCR_ARR_OPS_COMPACT 1u

/* Whether `ops` describes compact class elements. Compact instances exist
 * only on 64-bit targets. */
static inline bool scr_arr_ops_compact(const ScrArrOps *ops) {
#if UINTPTR_MAX > 0xffffffffu
  return (ops->flags & SCR_ARR_OPS_COMPACT) != 0;
#else
  (void)ops;
  return false;
#endif
}

/* `release` does nothing: the element type's instances live until the
 * process exits (llvm/shapes.ts arrOps). Destroying such an array frees only
 * its storage. */
#define SCR_ARR_OPS_RELEASE_NOTHING 2u

/* Whether `ops` has SCR_ARR_OPS_RELEASE_NOTHING. 32-bit descriptors end
 * before the flags word, so they never have it. */
static inline bool scr_arr_ops_release_nothing_flag(const ScrArrOps *ops) {
#if UINTPTR_MAX > 0xffffffffu
  return (ops->flags & SCR_ARR_OPS_RELEASE_NOTHING) != 0;
#else
  (void)ops;
  return false;
#endif
}

typedef struct ScrArr {
  size_t rc; /* SIZE_MAX = immortal (unused for arrays; kept per convention) */
  /* Length and dense capacity are at most SCR_ARR_MAX_LENGTH (2^32 - 1);
   * sparse entries cover indices >= cap. */
  uint32_t len;
  uint32_t cap;
  /* One ScrElemKind. */
  uint8_t elem;
  /* 1 exactly when ops->trace is non-NULL: the element type carries a cycle
   * header, so the array is CYCLE-CAPABLE (an element can point back at the
   * array that owns it) and allocates with the hidden collector header —
   * its trace visits every element, and the collector teardown frees only
   * the slot storage (all elements are traced children). Arrays of acyclic
   * ref elements and the historic element kinds keep the lean 1-word
   * header. Kept beside `elem` so the RC fast paths test it with one load. */
  uint8_t cyc;
  /* The low SCR_ARR_OPS_SHIFT bits: storage flags (SCR_ARR_INLINE_SLOTS,
   * SCR_ARR_HEAD_ROOM, SCR_ARR_UNSHIFTED, SCR_ARR_HAS_EXT, SCR_ARR_STATES)
   * and SCR_ARR_FROZEN. The rest: the
   * registry id of the element type's ops (scr_arr_ops), 0 for every kind
   * but SCR_ELEM_REF and SCR_ELEM_CREF. */
  uint16_t spare;
  /* A lower bound on the hole-free prefix: filled <= len, filled <= cap,
   * and every dense state below it is SCR_ARR_VALUE. Element reads below
   * it need no state check and element writes below it leave the states
   * alone. Any operation that may store another state (a hole, present
   * undefined) or move states below it lowers it first (scr_arr_cut);
   * 0 is always valid. */
  uint32_t filled;
  /* Dense values: `cap` 8-byte slots, `cap` bytes for SCR_ELEM_BOOL or
   * `cap` 4-byte slots for SCR_ELEM_CREF and SCR_ELEM_I32
   * (scr_arr_slot_width), followed in the same allocation, when the array
   * has states (SCR_ARR_STATES), by one state byte per slot in reverse slot
   * order (scr_arr_states_end). Sparse entries and properties keep 8-byte
   * slots for every kind; a bool slot is 0 or 1 wherever it lives, a CREF
   * slot's 8-byte form is the pointer and an I32 slot's the double's bits
   * (scr_arr_dense_get). Rarely
   * used storage (sparse indices, noncanonical numeric properties,
   * match-result metadata) lives out of line, and an array that has it
   * (SCR_ARR_HAS_EXT) keeps a pointer to it in the word before the dense
   * allocation (scr_arr_ext_of). */
  uint64_t *data;
} ScrArr;

typedef struct ScrArrExt {
  struct ScrArrSparseSlot *sparse;
  size_t sparse_len;
  size_t sparse_cap;
  struct ScrArrProp *props; /* noncanonical numeric properties */
  size_t prop_len;
  size_t prop_cap;
  /* Heterogeneous named properties of match results. Until a result's
   * metadata is first needed, this is the match source handle that the
   * results of one exec or matchAll call share (SCR_DYNH_MATCH_SOURCE,
   * scr_regex.c), and match_index is the result's UTF-16 start index. */
  struct ScrDyn *metadata;
  double match_index;
  /* The element ops of an array whose ops have no registry id
   * (SCR_ARR_OPS_OVERFLOW). */
  const ScrArrOps *ops;
  /* The class of an instance of a program class that extends Array
   * (scr_arr_subclass_init); NULL for every other array. */
  const struct ScrArrClass *cls;
} ScrArrExt;

/* A program class that extends Array. Its instances are emitted structs
 * that begin with a ScrArr (the reference count is the array's) and keep
 * the class's own fields after it; they always have an ext, whose `cls`
 * names the class. Every array entry point accepts them as arrays. */
typedef struct ScrArrClass {
  /* The class's name, as constructor.name reads it. */
  const char *name;
  /* Destroys an instance whose count reached zero: releases the class's own
   * fields, then scr_arr_subclass_drop, then frees the instance. */
  void (*destroy)(void *a);
  /* The class's own fields as a dyn object in declaration order (the array
   * is passed owned, +1), or NULL when the class declares none. util.inspect
   * and Object.keys list them after the elements. */
  struct ScrDyn *(*fields)(ScrArr *a);
  /* `new C(length)` (`new C()` without `with_length`): the instance
   * ArraySpeciesCreate makes for map, filter, slice, splice, concat, flat
   * and flatMap, and Array.of / Array.from called on the class. NULL when
   * the class's constructor cannot take that argument. */
  ScrArr *(*species)(double length, bool with_length);
} ScrArrClass;
/* The LLVM backend mirrors ScrArr as %ScrArr: its inline retain/release read
 * `cyc` (field 4, i8) to decide mark-live / candidate buffering exactly like
 * scr_arr_retain and scr_arr_release; its inline element access uses len and
 * cap (fields 1 and 2, i32), spare (field 5, i16, for SCR_ARR_STATES),
 * filled (field 6, i32) and data (field 7), and finds the state of slot i
 * of an array with states at data + cap * (slot width + 1) - 1 - i. */
_Static_assert(offsetof(ScrArr, len) == sizeof(size_t) && sizeof(((ScrArr *)0)->len) == 4,
               "emitted length reads load ScrArr.len as %ScrArr field 1, an i32");
_Static_assert(offsetof(ScrArr, cap) == sizeof(size_t) + 4 && sizeof(((ScrArr *)0)->cap) == 4,
               "emitted capacity reads load ScrArr.cap as %ScrArr field 2, an i32");
_Static_assert(offsetof(ScrArr, cyc) == sizeof(size_t) + 9,
               "inline RC fast paths read ScrArr.cyc as %ScrArr field 4");
_Static_assert(offsetof(ScrArr, spare) == sizeof(size_t) + 10,
               "inline element access reads ScrArr.spare as %ScrArr field 5");
_Static_assert(offsetof(ScrArr, filled) == sizeof(size_t) + 12,
               "inline element access reads ScrArr.filled as %ScrArr field 6");
_Static_assert(offsetof(ScrArr, data) == sizeof(size_t) + 16,
               "inline element reads use ScrArr.data as %ScrArr field 7");
_Static_assert(sizeof(ScrArr) == sizeof(size_t) + 16 + sizeof(void *),
               "ScrArr is 32 bytes on 64-bit targets");

/* Storage flags in `spare`. Inline slots: the dense slots live in the
 * array's own block, after the header. Head room: `data` has advanced past
 * vacated slots of its allocation, and the slot before `data` holds their
 * count. Unshifted: an unshift had to move every element. Has ext: the word
 * before the dense allocation (head room included) points at the array's
 * ScrArrExt; such an array always has an allocation of its own, without
 * inline slots. States: the dense slots carry state bytes (see below). */
#define SCR_ARR_INLINE_SLOTS 1u
#define SCR_ARR_HEAD_ROOM 2u
#define SCR_ARR_UNSHIFTED 4u
#define SCR_ARR_HAS_EXT 8u
#define SCR_ARR_STATES 16u
/* Object.freeze of the array (scr_arr_freeze). Emitted guards test it
 * before the writes of array types a program may freeze; the runtime's own
 * writes assume it is clear. */
#define SCR_ARR_FROZEN 32u

/* An array starts without state bytes. Without them, every index below
 * `len` is a present value in dense storage: len <= cap, there are no
 * sparse entries, and `filled` equals `len` whenever emitted code can read
 * the array (its inline reads load a state only at or past `filled`). The
 * first hole or present `undefined` below the length,
 * a length set past the elements, or a sparse entry gives the array its
 * states (scr_arr_add_states), which it keeps. */
static inline bool scr_arr_has_states(const ScrArr *a) { return (a->spare & SCR_ARR_STATES) != 0; }

static inline bool scr_arr_frozen(const ScrArr *a) { return (a->spare & SCR_ARR_FROZEN) != 0; }
/* Sets SCR_ARR_FROZEN; immortal arrays are left as they are. */
void scr_arr_freeze(ScrArr *a);
bool scr_arr_is_frozen(const ScrArr *a);
/* Throws Node's TypeError for the first write that the array operation
 * `op` makes to a frozen array of length `len`, or answers false when the
 * operation writes nothing. op: 0 index write (x = index), 1 push (y =
 * argument count), 2 pop, 3 length write, 4 unshift (y = argument count),
 * 5 delete (x = index), 6 shift, 7 reverse or sort, 8 fill (x = start, y =
 * end), 9 copyWithin (x = target, y = start, z = end), 10 splice (x =
 * start, y = delete count, z = item count). */
bool scr_array_frozen_error(int op, size_t len, double x, double y, double z);

/* The start of the dense slots' allocation: `data` less any head room. */
static inline uint64_t *scr_arr_block(const ScrArr *a) {
  return (a->spare & SCR_ARR_HEAD_ROOM) ? a->data - (size_t)a->data[-1] : a->data;
}

/* Bytes before the dense allocation of an array with out-of-line storage:
 * its pointer, in a word that keeps the 8-byte slots aligned on every
 * target. */
#define SCR_ARR_EXT_PREFIX sizeof(uint64_t)

/* The out-of-line storage of `a`, or NULL while it has none. */
static inline struct ScrArrExt *scr_arr_ext_of(const ScrArr *a) {
  if (!(a->spare & SCR_ARR_HAS_EXT)) return NULL;
  struct ScrArrExt *x;
  memcpy(&x, (const char *)scr_arr_block(a) - SCR_ARR_EXT_PREFIX, sizeof x);
  return x;
}

/* Element ops by registry id: `spare >> SCR_ARR_OPS_SHIFT` of an array.
 * Id 0 is no ops; ids are assigned on each descriptor's first array, in
 * any thread. A program with more element types than the field holds keeps
 * the ops of the rest in the array's ext (SCR_ARR_OPS_OVERFLOW). */
#define SCR_ARR_OPS_SHIFT 6
#define SCR_ARR_OPS_OVERFLOW (UINT16_MAX >> SCR_ARR_OPS_SHIFT)
extern const ScrArrOps *scr_arr_ops_table[SCR_ARR_OPS_OVERFLOW];
/* By registry id: 1 when the descriptor has SCR_ARR_OPS_RELEASE_NOTHING.
 * Written before the id is published; the overflow id stays 0. */
extern uint8_t scr_arr_ops_release_nothing[SCR_ARR_OPS_OVERFLOW + 1];
/* Assigns the id on a descriptor's first array; out of line, so the id
 * load in scr_arr_ops_id stays the only cost on later arrays. */
__attribute__((cold, noinline)) uint32_t scr_arr_ops_register(ScrArrOps *ops);

/* The registry id an array of element ops `ops` stores (0 for NULL). */
static inline uint32_t scr_arr_ops_id(const ScrArrOps *ops) {
  if (!ops) return 0;
  uint32_t id = __atomic_load_n(&ops->id, __ATOMIC_ACQUIRE);
  return id ? id : scr_arr_ops_register((ScrArrOps *)ops);
}

/* The element ops of an array whose ops have no registry id. */
const ScrArrOps *scr_arr_ops_overflow(const ScrArr *a);

/* The element ops of `a`: NULL for every kind but SCR_ELEM_REF and
 * SCR_ELEM_CREF. */
static inline const ScrArrOps *scr_arr_ops(const ScrArr *a) {
  uint32_t id = (uint32_t)a->spare >> SCR_ARR_OPS_SHIFT;
  if (__builtin_expect(id == SCR_ARR_OPS_OVERFLOW, 0)) return scr_arr_ops_overflow(a);
  return scr_arr_ops_table[id];
}

/* Bytes per dense value slot of element kind `elem`. */
static inline size_t scr_elem_slot_width(uint8_t elem) {
  if (elem == SCR_ELEM_BOOL) return 1;
  if (__builtin_expect(elem == SCR_ELEM_CREF || elem == SCR_ELEM_I32, 0)) return sizeof(uint32_t);
  return sizeof(uint64_t);
}

/* Bytes per dense value slot. */
static inline size_t scr_arr_slot_width(const ScrArr *a) {
  return scr_elem_slot_width(a->elem);
}

/* The dense states of an array with states, one byte per slot, share the
 * values' allocation (inline slots included). They follow the `cap` value
 * slots in reverse slot order: the state of slot i is the byte i + 1 before
 * scr_arr_states_end(a). Removing slots from the front (head room: `data`
 * advances, `cap` drops) leaves every remaining state at its address. The
 * address is computed on integers, so a NULL `data` stays NULL. Arrays
 * without states have no bytes there. */
static inline uint8_t *scr_arr_states_end(const ScrArr *a) {
  return (uint8_t *)((uintptr_t)a->data + (uintptr_t)a->cap * (scr_arr_slot_width(a) + 1));
}

/* scr_arr_states_end for an array whose slots are known to be `width`
 * bytes wide: a constant multiple, with no element-kind test. */
static inline uint8_t *scr_arr_states_end_w(const ScrArr *a, size_t width) {
  return (uint8_t *)((uintptr_t)a->data + (uintptr_t)a->cap * (width + 1));
}

/* The state of dense slot `index` (< cap), given the end of the states. */
static inline uint8_t *scr_arr_state_in(const uint8_t *end, size_t index) {
  return (uint8_t *)end - 1 - index;
}

static inline uint8_t *scr_arr_state_ptr(const ScrArr *a, size_t index) {
  return scr_arr_state_in(scr_arr_states_end(a), index);
}

/* The states of dense slots [from, from + count) are contiguous, in reverse
 * order; this is their first byte (the state of slot from + count - 1). */
static inline uint8_t *scr_arr_state_run(const ScrArr *a, size_t from, size_t count) {
  return scr_arr_states_end(a) - from - count;
}

/* The state of dense slot `index` (< cap), with or without state bytes. */
static inline uint8_t scr_arr_dense_state(const ScrArr *a, size_t index) {
  if (!scr_arr_has_states(a)) return index < a->len ? SCR_ARR_VALUE : SCR_ARR_HOLE;
  return *scr_arr_state_ptr(a, index);
}

/* The dense states of `a` for a scan (scr_arr_state_in), or NULL when it
 * has none: every index below its length is then a value. */
static inline const uint8_t *scr_arr_scan_states(const ScrArr *a) {
  return scr_arr_has_states(a) ? scr_arr_states_end(a) : NULL;
}

/* Give `a` state bytes: present values below the length, holes above it.
 * May move the dense slots. */
void scr_arr_add_states(ScrArr *a);

static inline void scr_arr_need_states(ScrArr *a) {
  if (!scr_arr_has_states(a)) scr_arr_add_states(a);
}
/* A CREF slot's pointer, and the slot of a pointer (NULL or a compact
 * instance below 32 GiB). */
static inline uint64_t scr_cref_decode(uint32_t ref) { return (uint64_t)ref << 3; }
static inline uint32_t scr_cref_encode(uint64_t slot) { return (uint32_t)(slot >> 3); }

/* The bits of `d` as a slot, and back. */
static inline uint64_t scr_arr_f64_slot(double d) {
  uint64_t slot;
  memcpy(&slot, &d, sizeof slot);
  return slot;
}

static inline double scr_arr_slot_f64(uint64_t slot) {
  double d;
  memcpy(&d, &slot, sizeof d);
  return d;
}

/* An int32 array's slot for a double: its stores are proven int32s that
 * are not -0 (and a cleared slot is +0), so anything else is a compiler
 * bug. */
static inline int32_t scr_arr_i32_of(uint64_t slot) {
  double d = scr_arr_slot_f64(slot);
  if (__builtin_expect(!(d >= -2147483648.0 && d <= 2147483647.0 && d == (double)(int32_t)d) ||
                           slot == UINT64_C(0x8000000000000000),
                       0))
    __builtin_trap();
  return (int32_t)d;
}

/* The dense value at `index` (< cap) as an 8-byte slot, and its store. */
static inline uint64_t scr_arr_dense_get(const ScrArr *a, size_t index) {
  if (a->elem == SCR_ELEM_BOOL) return ((const uint8_t *)a->data)[index];
  if (__builtin_expect(a->elem == SCR_ELEM_CREF, 0))
    return scr_cref_decode(((const uint32_t *)a->data)[index]);
  if (__builtin_expect(a->elem == SCR_ELEM_I32, 0))
    return scr_arr_f64_slot((double)((const int32_t *)a->data)[index]);
  return a->data[index];
}

static inline void scr_arr_dense_put(ScrArr *a, size_t index, uint64_t slot) {
  if (a->elem == SCR_ELEM_BOOL) ((uint8_t *)a->data)[index] = (uint8_t)slot;
  else if (__builtin_expect(a->elem == SCR_ELEM_CREF, 0))
    ((uint32_t *)a->data)[index] = scr_cref_encode(slot);
  else if (__builtin_expect(a->elem == SCR_ELEM_I32, 0))
    ((int32_t *)a->data)[index] = scr_arr_i32_of(slot);
  else a->data[index] = slot;
}

/* Lower the hole-free prefix to at most `index`: call before storing a
 * non-value state at `index`, or before moving states into [index, ...). */
static inline void scr_arr_cut(ScrArr *a, size_t index) {
  if (a->filled > index) a->filled = (uint32_t)index;
}

/* The first index in [f, end) whose state is not a present value (or end),
 * given the end of the states. Compares eight states per step: bulk copies
 * (slice, concat, spread) end with this scan over the whole copied range. */
static inline size_t scr_arr_value_run(const uint8_t *states_end, size_t f, size_t end) {
  const uint64_t values = 0x0101010101010101ull * SCR_ARR_VALUE;
  while (end - f >= 8) {
    uint64_t word;
    memcpy(&word, states_end - f - 8, sizeof word);
    if (word != values) break;
    f += 8;
  }
  while (f < end && *scr_arr_state_in(states_end, f) == SCR_ARR_VALUE) f++;
  return f;
}

/* Extend the hole-free prefix over populated dense states. Starts at the
 * current bound, so after an append it costs only the appended range. */
static inline void scr_arr_refill(ScrArr *a) {
  size_t end = a->len < a->cap ? a->len : a->cap;
  size_t f = a->filled;
  if (!scr_arr_has_states(a)) f = end;
  else if (f < end) f = scr_arr_value_run(scr_arr_states_end(a), f, end);
  a->filled = (uint32_t)f;
}

typedef struct ScrArrSparseSlot {
  size_t index;
  uint64_t slot;
  uint8_t state;
} ScrArrSparseSlot;

typedef struct ScrArrProp {
  char *key;
  size_t key_len;
  uint64_t slot;
  uint8_t state; /* SCR_ARR_VALUE or SCR_ARR_UNDEFINED */
} ScrArrProp;

ScrArr *scr_arr_new(ScrElemKind elem, size_t initial_cap); /* returns +1 */

/* SCR_ELEM_REF construction: `ops` must outlive the array (a constant; the
 * compiler emits one per element type) and its retain/release must be
 * non-NULL; ops->trace is non-NULL iff the element type carries a cycle
 * header (the array then allocates with the collector header — see the
 * struct comment). Returns +1. */
ScrArr *scr_arr_new_ops(const ScrArrOps *ops, size_t initial_cap);
/* An empty array expected to receive a few elements: its first slots live
 * in the array's own block (one allocation; the block of a plain empty
 * array plus five 8-byte slots). Otherwise exactly scr_arr_new(elem, 0) and
 * scr_arr_new_ops(ops, 0). Returns +1. */
ScrArr *scr_arr_new_small(ScrElemKind elem);
/* An int32 array's storage as doubles, in place (SCR_ELEM_I32 to
 * SCR_ELEM_F64); no-op for any other kind. */
void scr_arr_widen_i32(ScrArr *a);
ScrArr *scr_arr_new_ops_small(const ScrArrOps *ops);
/* scr_arr_new(elem, cap) for a known final length: the `cap` slots share
 * the array's own block (one allocation). With `states`, the array starts
 * with states (for holes or present undefined). Returns +1. */
ScrArr *scr_arr_new_inline(ScrElemKind elem, size_t cap, bool states);

static inline ScrArr *scr_arr_retain(ScrArr *a) {
  if (a->rc != SIZE_MAX) {
    a->rc++;
  }
  return a;
}

/* Releases ref elements (SCR_ELEM_STR/ARR/BYTES/REF) recursively at rc == 0.
 * NULL-tolerant (uninitialized locals). Cycle-capable arrays (`cyc`) feed
 * the candidate-root buffer like every headered type. */
void scr_arr_release(ScrArr *a);
/* Initializes the ScrArr prefix of a zeroed, freshly allocated instance of
 * an Array subclass (count already 1): no elements, the element kind and
 * ops, and an ext naming the class. `cyc` says the instance carries the
 * collector header (its class is cycle-capable). */
void scr_arr_subclass_init(ScrArr *a, uint8_t elem, const ScrArrOps *ops, const ScrArrClass *cls,
                           bool cyc);
/* The collector's teardown of an Array subclass instance's storage: the
 * elements are released unless they are the collector's (`traced`). */
void scr_arr_subclass_gc_drop(ScrArr *a);
/* The collector trace of an Array subclass instance's elements: visits
 * them when its current element ops trace them. */
void scr_arr_subclass_trace(void *a, ScrTraceVisit visit, void *ctx);
/* super(...args) in a class that extends Array (the Array constructor's
 * length-or-elements rule); `args` is borrowed. */
void scr_arr_subclass_construct(ScrArr *a, ScrArr *args, bool dyn_elems);
/* The implicit constructor's super(...args) over its dyn argument array. */
void scr_arr_subclass_construct_dyn(ScrArr *a, const struct ScrDyn *args, bool dyn_elems);
/* ArraySpeciesCreate over the result `result` (owned) of an Array method
 * called on `recv` (borrowed): a plain receiver keeps the result; a
 * subclass instance's result is `new C(ctor_length)`, whose indices then
 * receive the result's present elements, and whose length is set to the
 * result's when `set_length` (slice, splice and concat set it; map,
 * filter, flat and flatMap do not). A negative `ctor_length` passes the
 * result's length. Result owned. */
ScrArr *scr_arr_species_adopt(ScrArr *recv, ScrArr *result, double ctor_length, bool set_length);
/* ArraySpeciesCreate ahead of an Array method that calls back into the
 * program (map, filter, flatMap), so the species constructor runs before
 * the first callback: a subclass instance `recv` (borrowed) answers
 * `new C(ctor_length)`, a plain receiver itself. Result owned. */
ScrArr *scr_arr_species_create(ScrArr *recv, double ctor_length);
/* The present elements of the method's result `result` (owned) defined on
 * the instance scr_arr_species_create answered (`species`, borrowed), and
 * its length set to the result's when `set_length`; a plain receiver's
 * result as it is. Result owned. */
ScrArr *scr_arr_species_finish(ScrArr *species, ScrArr *result, bool set_length);
/* Array.of / Array.from called on an Array subclass: `new C(ctor_length)`
 * (`new C()` when ctor_length is negative), then the elements of `result`
 * (owned) and its length, as scr_arr_species_adopt. */
ScrArr *scr_arr_class_construct_adopt(const ScrArrClass *cls, ScrArr *result, double ctor_length);
/* `value instanceof C` for a dyn value and a class that extends Array: a
 * live view of an instance of C, or a snapshot of one. */
bool scr_dyn_is_array_class(const struct ScrDyn *d, const ScrArrClass *cls);
/* The class of an Array subclass instance, or NULL for a plain array. */
const ScrArrClass *scr_arr_class_of(const ScrArr *a);
/* Releases the elements of an Array subclass instance and frees its
 * storage and ext, leaving the instance itself to its class's destroy. */
void scr_arr_subclass_drop(ScrArr *a);
void scr_arr_copy_metadata(ScrArr *a, struct ScrDyn *target);
/* The commit of a live array view calls this on `a`, the array converted
 * from `view`, before `target` takes its storage: `a` takes the view's named
 * (non-index) properties as its metadata and the noncanonical numeric
 * properties of `target`, so neither is lost when the storage is swapped. */
void scr_arr_adopt_view_properties(ScrArr *a, struct ScrDyn *view, ScrArr *target);
/* True when `key` is the string spelling of a number that is not an array
 * index ("-1", "1.5", "NaN", "Infinity"), or "undefined", with the number in
 * *out (scr_arr_undefined_key for "undefined"). Arrays keep such properties
 * in their noncanonical property table. */
bool scr_arr_numeric_key(const char *key, size_t len, double *out);
/* The number compiled code passes as the key of an element access whose
 * index is undefined at run time: a NaN with its own payload, which the
 * property table spells "undefined" (JavaScript names that property, not
 * "NaN"). */
double scr_arr_undefined_key(void);
/* Whether the array still has the named or noncanonical numeric property
 * `key`: `for...in` skips a key deleted before its turn. Borrows both. */
bool scr_arr_has_named_key(ScrArr *a, ScrStr *key);
/* The enumerable string keys `for...in` visits after the indices: the
 * noncanonical numeric properties, then the named properties in insertion
 * order. +1. */
ScrArr *scr_arr_named_keys(ScrArr *a);
/* Whether the array has properties besides its elements (noncanonical
 * numeric keys, match metadata, named properties): util.inspect lists
 * them after the elements. */
bool scr_arr_has_properties(const ScrArr *a);
/* Installed by scr_regex.c when it records a pending match source; this
 * unit links without the regex runtime. Writes the pending metadata of
 * `a` into its dynamic copy or materializes it, answering whether it
 * wrote. */
extern SCR_TL bool (*scr_arr_match_copy)(ScrArr *a, struct ScrDyn *target);
/* The array's out-of-line storage, allocated (zeroed) on first use. */
ScrArrExt *scr_arr_ext(ScrArr *a);
/* Moves inline dense slots (kept in the header block of a small array) to
 * their own allocation, and the elements of an array with head room (left
 * by shift) to the start of theirs, so the storage pointers may be swapped
 * with another array's. No-op for other arrays. */
void scr_arr_outline(ScrArr *a);
/* Swaps the sparse slots and numeric properties of two arrays; each keeps
 * its own match metadata (refresh of a cached typed view, llvm/dyn.ts). */
void scr_arr_swap_indexed_ext(ScrArr *a, ScrArr *b);

/* Trace entry point for cycle-capable arrays — stored in their collector
 * header and passed wherever a container stores an ARRAY payload's RC entry
 * points and the array type is cycle-capable (boxes, union arms, map
 * values, promise payloads), exactly like scr_map_trace_v. */
void scr_arr_trace_v(void *a, ScrTraceVisit visit, void *ctx);

double scr_arr_len(ScrArr *a);
/* Shared hole/property query. Canonical indices answer from indexed storage;
 * noncanonical numeric keys answer from the ordinary-property vector. Missing
 * keys and indices >= length answer false without trapping; callers that need
 * a value must still use the proven-presence get accessors below. */
bool scr_arr_has(const ScrArr *a, double i);
double scr_arr_state(const ScrArr *a, double i);
double scr_arr_next_present(const ScrArr *a, double start);
/* Set Array.prototype.length semantics for the supported native array
 * surface. Growth creates holes without allocating a dense prefix; shrinking
 * releases removed reference elements. Invalid lengths set a catchable
 * RangeError and leave the array unchanged. */
void scr_arr_set_len(ScrArr *a, double length);
/* Copy one slot from src into dst, retaining reference elements when the
 * source slot is present. The destination must already have a length that
 * includes dst_index. Holes remain holes. */
void scr_arr_copy_index(ScrArr *dst, size_t dst_index, const ScrArr *src,
                        size_t src_index);
/* Copy a range while preserving holes. `dst_start` and `src_start` are the
 * starts of equal-length ranges; with reverse=true the source range is
 * copied in reverse order. Reference elements are retained. */
void scr_arr_copy_range(ScrArr *dst, size_t dst_start, const ScrArr *src,
                        size_t src_start, size_t count, bool reverse);
void scr_arr_copy_range_ex(ScrArr *dst, size_t dst_start, const ScrArr *src,
                           size_t src_start, size_t count, bool reverse,
                           bool materialize_holes);
/* Mutating indexed operations borrow the receiver and value, preserve
 * sparse presence, and return the receiver retained. */
ScrArr *scr_arr_copy_within(ScrArr *a, double target, double start, double end);
ScrArr *scr_arr_fill_f64(ScrArr *a, double value, double start, double end);
ScrArr *scr_arr_fill_bool(ScrArr *a, bool value, double start, double end);
ScrArr *scr_arr_fill_ref(ScrArr *a, void *value, double start, double end);
ScrArr *scr_arr_fill_undefined(ScrArr *a, double start, double end);
/* Math.max(...xs) / Math.min(...xs) over an f64-element array: the JS
 * fold (NaN poisons, ±0 by the JS preferences, empty → ∓Infinity). */
double scr_math_max_arr(ScrArr *a);
double scr_math_min_arr(ScrArr *a);
double scr_math_hypot_arr(ScrArr *a);
/* The scalar Math statics (scr_lib.c): min/max are the ECMA two-argument
 * folds (NaN poisons; max prefers +0, min prefers -0 — NOT C's fmin/fmax);
 * random is a uniform [0,1) double at 53-bit granularity from
 * arc4random_buf (SEMANTICS.md 62: Node's distribution, not its sequence). */
double scr_math_min(double a, double b);
double scr_math_round(double x);
double scr_math_pow(double base, double exponent);
double scr_math_clz32(double x);
double scr_math_fround(double x);
double scr_math_imul(double a, double b);
double scr_math_max(double a, double b);
double scr_math_random(void);

double scr_arr_get_f64(ScrArr *a, double i); /* trap missing/hole */
/* ToNumber(a[i]) for f64 storage: borrows a; missing/hole/undefined -> NaN. */
double scr_arr_get_number(const ScrArr *a, double i);
/* Strict equality of ordinary indexed reads on matching primitive arrays.
 * Borrows both arrays, preserves undefined vs NaN, and never allocates. */
bool scr_arr_index_eq(const ScrArr *a, double i, const ScrArr *b, double j);
bool scr_arr_get_bool(ScrArr *a, double i);  /* trap missing/hole */
void *scr_arr_get_ref(ScrArr *a, double i);  /* trap missing/hole; +1 */
void *scr_arr_borrow_ref(ScrArr *a, double i); /* same checks; borrowed */
/* Borrow a non-null reference element, or NULL for a hole/undefined/missing
 * property. Keep the array alive and retain before removing its element.
 * This read does not invoke retain callbacks or mutate runtime state. */
void *scr_arr_peek_ref(const ScrArr *a, double i);

/* i == len appends; the _ref variant releases the old element (when
 * replacing) and takes ownership of the new one. */
void scr_arr_set_f64(ScrArr *a, double i, double v);
void scr_arr_set_bool(ScrArr *a, double i, bool v);
void scr_arr_set_ref(ScrArr *a, double i, void *v);
void scr_arr_set_undefined(ScrArr *a, double i);
bool scr_arr_delete(ScrArr *a, double i);

/* slice(start?, end?): a fresh +1 shallow copy of the index range —
 * ToIntegerOrInfinity indices, negatives from the end, clamping; ref
 * elements retain into the copy. Borrows a. */
ScrArr *scr_arr_slice(ScrArr *a, double start, double end);

/* ES2023 copying methods. All borrow their inputs and return fresh +1
 * shallow copies. with() raises Node's catchable RangeError for an invalid
 * relative index; the ref variant retains the borrowed replacement. */
ScrArr *scr_arr_to_reversed(const ScrArr *a);
ScrArr *scr_arr_to_spliced(const ScrArr *a, double start,
                           double delete_count, const ScrArr *items);
ScrArr *scr_arr_with_f64(ScrArr *a, double index, double value);
ScrArr *scr_arr_with_bool(ScrArr *a, double index, bool value);
ScrArr *scr_arr_with_ref(ScrArr *a, double index, void *value);
ScrArr *scr_arr_with_undefined(ScrArr *a, double index);

/* push returns the new length (JS-exact); _ref takes ownership. */
double scr_arr_push_f64(ScrArr *a, double v);
double scr_arr_push_bool(ScrArr *a, bool v);
double scr_arr_push_ref(ScrArr *a, void *v);
/* Compiler-built slot buffers do not alias array storage. Both operations
 * move ownership of every slot and preserve the evaluated argument order. */
double scr_arr_push_many(ScrArr *a, size_t count, const uint64_t *slots);
double scr_arr_unshift_many(ScrArr *a, size_t count, const uint64_t *slots);
/* Append a same-element-kind array through the JS iterator contract: holes
 * become present undefined states. The source is borrowed and self-spread
 * duplicates the original indexed state. */
double scr_arr_push_spread(ScrArr *a, const ScrArr *src);
/* Append a concat argument by indexed property copy, preserving holes. */
double scr_arr_concat_copy(ScrArr *a, const ScrArr *src);
/* The same append for Array.prototype.concat's fresh result: dense storage
 * grows to exactly the combined length instead of geometrically. */
double scr_arr_concat_copy_exact(ScrArr *a, const ScrArr *src);
/* Exact dense capacity for an array literal about to copy `src` and then
 * `plain` more elements (a spread position). */
void scr_arr_reserve_spread(ScrArr *a, const ScrArr *src, size_t plain);
/* Exact dense capacity for `n` elements of an array that is filled to that
 * length next (Array.from({ length: n })); no effect for other lengths. */
void scr_arr_reserve_len(ScrArr *a, double n);

/* unshift returns the new length and _ref takes ownership. The spread form
 * borrows a same-element-kind source, retains copied refs, and snapshots
 * self-spread. reverse mutates in place and returns the receiver at +1. */
double scr_arr_unshift_f64(ScrArr *a, double v);
double scr_arr_unshift_bool(ScrArr *a, bool v);
double scr_arr_unshift_ref(ScrArr *a, void *v);
double scr_arr_unshift_spread(ScrArr *a, const ScrArr *src);
ScrArr *scr_arr_reverse(ScrArr *a);
/* Default primitive String ordering; stable, borrowed receiver, owned result. */
ScrArr *scr_arr_sort_primitive(ScrArr *a, bool copy);
/* Default ordering of reference elements by their String() text, which
 * `text` answers (+1) for each element once (Date arrays). Like
 * scr_arr_sort_primitive otherwise. */
ScrArr *scr_arr_sort_by_text(ScrArr *a, bool copy, ScrStr *(*text)(void *));
/* Stable comparator sort of the first `count` slots of a private, compacted
 * snapshot (every slot a value; f64 or reference elements). `f` is a borrowed
 * closure of `arity` (0..2) element parameters returning a number. Elements
 * move without reference-count traffic; a pending exception from `f` stops
 * the sort and leaves the snapshot unchanged. */
struct ScrClosure;
/* A nonzero `order` says `f` orders number keys ascending (1) or descending
 * (-1) without side effects: f64 elements are their own keys, and reference
 * elements read theirs through the borrowed `key` closure (element ->
 * number). Keys that are all numbers other than NaN and -0 then sort without
 * calling `f`, with the same stable result. An `order` from 2 says `f`
 * orders reference elements by several such keys, the first deciding: the
 * low byte is the key count (2..8), each bit from bit 8 marks a key that
 * orders descending, and `key` reads key j of an element (element, j ->
 * number). */
void scr_arr_sort_values(ScrArr *a, double count, struct ScrClosure *f, uint32_t arity,
                         int32_t order, struct ScrClosure *key);
/* Comparator sort of a dense array in place: `a.sort(f)`, or with `owned`
 * the private copy of `a.toSorted(f)`. Returns false without calling `f`
 * when `a` has holes, storage-level undefined or a sparse tail, or is
 * published; the caller then sorts a compacted snapshot. Otherwise sorts
 * and returns true; a pending exception from `f` leaves a shared `a`
 * unwritten (an owned copy then holds a permutation of its values). */
/* The borrowed 8-byte slots of `a` when every index below its length holds
 * a value in dense storage (length in *len); NULL for holes, storage-level
 * undefined, sparse tails, empty arrays and boolean elements. */
const uint64_t *scr_arr_dense_slots(const ScrArr *a, size_t *len);
bool scr_arr_sort_dense(ScrArr *a, struct ScrClosure *f, uint32_t arity, bool owned,
                        int32_t order, struct ScrClosure *key);
/* V8's TimSort over n slots with a caller comparison: less(ctx, x, y)
 * answers whether x orders before y (comparefn(x, y) < 0), or sets *failed,
 * with an exception pending, to stop the sort. Returns false after a
 * failure; `values` is then unchanged, and it holds every slot exactly once,
 * in its original order, whenever `less` runs. */
typedef bool (*ScrSortLess)(void *ctx, uint64_t x, uint64_t y, bool *failed);
bool scr_sort_slots_with(uint64_t *values, size_t n, ScrSortLess less, void *ctx);

/* pop traps on an empty array; _ref transfers ownership out (+1 to the
 * caller, no release). */
double scr_arr_pop_f64(ScrArr *a);
bool scr_arr_pop_bool(ScrArr *a);
void *scr_arr_pop_ref(ScrArr *a);
uint8_t scr_arr_pop_state(ScrArr *a, uint64_t *slot_out);

/* shift: the first element out; the rest stay in place behind head room
 * (amortized O(1)). The emitter guards the empty array (JS's undefined —
 * the `elem | undefined` union), so empty here is an internal error; _ref
 * transfers ownership out like pop. */
double scr_arr_shift_f64(ScrArr *a);
bool scr_arr_shift_bool(ScrArr *a);
void *scr_arr_shift_ref(ScrArr *a);
uint8_t scr_arr_shift_state(ScrArr *a, uint64_t *slot_out);

/* splice(start, deleteCount) — the REMOVAL forms: Node-exact
 * relative/clamped start, count clamped to [0, len - start] (+Infinity =
 * to the end). Returns the removed elements in order as a fresh +1 array,
 * ownership MOVED out of the receiver. Borrows a. */
ScrArr *scr_arr_splice(ScrArr *a, double start, double deleteCount);
ScrArr *scr_arr_splice_insert(ScrArr *a, double start, double deleteCount,
                              const ScrArr *items);
/* The same splice in statement position: inserts `count` owned value slots
 * (moved in) and releases the removed elements without building a result
 * array. Borrows a. */
void scr_arr_splice_drop(ScrArr *a, double start, double deleteCount, size_t count,
                         const uint64_t *slots);
ScrArr *scr_arr_flat_copy(const ScrArr *a, ScrArr *out, bool flatten);

/* indexOf: first index whose element strictly equals (JS ===) the needle,
 * or -1. Per element kind: f64 by value (NaN never matches — NaN !== NaN;
 * -0 matches 0), bool by value, SCR_ELEM_STR by CONTENT (JS strings are
 * primitives), SCR_ELEM_ARR/SCR_ELEM_REF by reference identity (JS object
 * equality; the compiler fences union-element arrays, whose boxes are
 * compiler artifacts pointer identity would misjudge). The _ref variants
 * BORROW the needle (no ownership change). */
double scr_arr_index_of_f64(ScrArr *a, double v);
double scr_arr_index_of_bool(ScrArr *a, bool v);
double scr_arr_index_of_ref(ScrArr *a, void *v);

/* includes: SameValueZero — exactly indexOf's equality EXCEPT NaN matches
 * NaN (JS: [NaN].indexOf(NaN) === -1 but [NaN].includes(NaN) === true). */
bool scr_arr_includes_f64(ScrArr *a, double v);
bool scr_arr_includes_bool(ScrArr *a, bool v);
bool scr_arr_includes_ref(ScrArr *a, void *v);

/* join(sep): elements stringified exactly like JS String(x) — numbers via
 * scr_f64_to_str (shortest roundtrip), booleans "true"/"false", strings
 * verbatim — with sep between. f64/bool/str element kinds only (the
 * compiler rejects the rest). Borrows both args; returns +1. */
ScrStr *scr_arr_join(ScrArr *a, ScrStr *sep);
/* String.raw over the raw literals and pre-stringified substitutions
 * (both SCR_ELEM_STR): the spec's interleave — extra substitutions drop,
 * missing ones skip. Borrows both; +1 result; never throws. */
ScrStr *scr_str_raw(ScrArr *raw, ScrArr *subs);

#endif /* SCR_ARRAY_H */
