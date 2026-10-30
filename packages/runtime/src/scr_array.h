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
} ScrArrOps;

typedef struct ScrArr {
  size_t rc; /* SIZE_MAX = immutable published or template-site array */
  size_t len;
  size_t cap; /* dense capacity; sparse entries cover indices >= cap */
  /* One ScrElemKind. */
  uint8_t elem;
  /* Every mutable heap array carries a collector header: named metadata
   * can point back even when indexed elements are scalars. Immortal static
   * template arrays remain headerless. Kept beside `elem` for RC fast paths;
   * element tracing is separately determined by elem and ops->trace. */
  uint8_t cyc;
  uint16_t spare;
  /* A lower bound on the hole-free prefix: filled <= len, filled <= cap,
   * and every dense state below it is SCR_ARR_VALUE. Element reads below
   * it need no state check and element writes below it leave the states
   * alone. Any operation that may store another state (a hole, present
   * undefined) or move states below it lowers it first (scr_arr_cut);
   * 0 is always valid. */
  uint32_t filled;
  /* SCR_ELEM_REF only; NULL for every other element kind. */
  const ScrArrOps *ops;
  /* Dense values: `cap` 8-byte slots, or `cap` bytes for SCR_ELEM_BOOL
   * (scr_arr_slot_width). Sparse entries and properties keep 8-byte slots
   * for every kind; a bool slot is 0 or 1 wherever it lives. */
  uint64_t *data;
  uint8_t *present; /* one state per dense slot; heap arrays share data allocation */
  /* Rarely used storage (sparse indices, noncanonical numeric properties,
   * match-result metadata) lives out of line: NULL until first needed, so
   * the common dense array stays small. */
  struct ScrArrExt *ext;
} ScrArr;

typedef struct ScrArrExt {
  struct ScrArrSparseSlot *sparse;
  size_t sparse_len;
  size_t sparse_cap;
  struct ScrArrProp *props; /* noncanonical numeric properties */
  size_t prop_len;
  size_t prop_cap;
  struct ScrDyn *metadata; /* heterogeneous named properties of match results */
  struct ScrArrNamed *named; /* owned immutable live-view recipe; no object edges */
  uint8_t named_state;
} ScrArrExt;
enum { SCR_ARR_NAMES_UNPROMOTED, SCR_ARR_NAMES_PROMOTING, SCR_ARR_NAMES_PROMOTED };
/* The LLVM backend mirrors ScrArr as %ScrArr: its inline retain/release read
 * `cyc` (field 4, i8) to decide mark-live / candidate buffering exactly like
 * scr_arr_retain and scr_arr_release; its inline element access uses filled
 * (field 6, i32), data (field 8) and present (field 9). */
_Static_assert(offsetof(ScrArr, cyc) == 3 * sizeof(size_t) + 1,
               "inline RC fast paths read ScrArr.cyc as %ScrArr field 4");
_Static_assert(offsetof(ScrArr, filled) == 3 * sizeof(size_t) + 4,
               "inline element access reads ScrArr.filled as %ScrArr field 6");
_Static_assert(offsetof(ScrArr, data) == 3 * sizeof(size_t) + 8 + sizeof(void *),
               "inline element reads use ScrArr.data as %ScrArr field 8");

/* Bytes per dense value slot. */
static inline size_t scr_arr_slot_width(const ScrArr *a) {
  return a->elem == SCR_ELEM_BOOL ? 1 : sizeof(uint64_t);
}

/* The dense value at `index` (< cap) as an 8-byte slot, and its store. */
static inline uint64_t scr_arr_dense_get(const ScrArr *a, size_t index) {
  if (a->elem == SCR_ELEM_BOOL) return ((const uint8_t *)a->data)[index];
  return a->data[index];
}

static inline void scr_arr_dense_put(ScrArr *a, size_t index, uint64_t slot) {
  if (a->elem == SCR_ELEM_BOOL) ((uint8_t *)a->data)[index] = (uint8_t)slot;
  else a->data[index] = slot;
}

/* Lower the hole-free prefix to at most `index`: call before storing a
 * non-value state at `index`, or before moving states into [index, ...). */
static inline void scr_arr_cut(ScrArr *a, size_t index) {
  if (a->filled > index) a->filled = (uint32_t)index;
}

/* The first index in [f, end) whose state is not a present value (or end).
 * Compares eight states per step: bulk copies (slice, concat, spread) end
 * with this scan over the whole copied range. */
static inline size_t scr_arr_value_run(const uint8_t *present, size_t f, size_t end) {
  const uint64_t values = 0x0101010101010101ull * SCR_ARR_VALUE;
  while (end - f >= 8) {
    uint64_t word;
    memcpy(&word, present + f, sizeof word);
    if (word != values) break;
    f += 8;
  }
  while (f < end && present[f] == SCR_ARR_VALUE) f++;
  return f;
}

/* Extend the hole-free prefix over populated dense states. Starts at the
 * current bound, so after an append it costs only the appended range. */
static inline void scr_arr_refill(ScrArr *a) {
  size_t end = a->len < a->cap ? a->len : a->cap;
  size_t f = a->filled;
  if (f < end) f = scr_arr_value_run(a->present, f, end);
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
 * header. The array itself always carries a collector header. Returns +1. */
ScrArr *scr_arr_new_ops(const ScrArrOps *ops, size_t initial_cap);
/* An empty array expected to receive a few elements: its first slots live
 * in the array's own block (one allocation; the block of a plain empty
 * array plus five 8-byte slots). Otherwise exactly scr_arr_new(elem, 0) and
 * scr_arr_new_ops(ops, 0). Returns +1. */
ScrArr *scr_arr_new_small(ScrElemKind elem);
ScrArr *scr_arr_new_ops_small(const ScrArrOps *ops);
/* scr_arr_new(elem, cap) for a known final length: the `cap` slots share
 * the array's own block (one allocation). Returns +1. */
ScrArr *scr_arr_new_inline(ScrElemKind elem, size_t cap);

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
void scr_arr_copy_metadata(ScrArr *a, struct ScrDyn *target);
/* The array's out-of-line storage, allocated (zeroed) on first use. */
ScrArrExt *scr_arr_ext(ScrArr *a);
/* Commit a fully built named-property table, detaching typed properties before
 * their releases can collect or observe the referent. Consumes metadata. */
void scr_arr_promote_metadata(ScrArr *a, struct ScrDyn *metadata);
bool scr_arr_named_promoted(const ScrArr *a);
/* Requires a promoted binding. Names and missing own indexes resolve properties;
 * Get returns one owned value (including undefined), NULL only on pending error.
 * Has never calls getters. Fresh immutable bindings use their capsule's APIs. */
struct ScrDyn *scr_arr_property_get(const ScrArr *a, double key);
bool scr_arr_has_property(const ScrArr *a, double key);
/* Bound exact codec: borrowed value to owned slot, output untouched on failure. */
bool scr_arr_property_unbox(const ScrArr *a, const struct ScrDyn *value, uint64_t *out);
/* Moves inline dense slots (kept in the header block of a small array) to
 * their own allocation, so the storage pointers may be swapped with another
 * array's. No-op for other arrays. */
void scr_arr_outline(ScrArr *a);
/* Borrow two arrays with the same element/ownership representation and swap
 * their dense and sparse indexed storage, outlining inline slots first.
 * No callbacks or RC changes; names, metadata and integrity stay attached
 * to each referent. Callers own write admission and temporary disposal. */
void scr_arr_swap_indexed_storage(ScrArr *a, ScrArr *b);

/* Trace entry point for mutable heap arrays — stored in their collector
 * header and passed wherever a container stores an ARRAY payload's RC entry
 * points (boxes, union arms, map
 * values, promise payloads), exactly like scr_map_trace_v. */
void scr_arr_trace_v(void *a, ScrTraceVisit visit, void *ctx);

double scr_arr_len(ScrArr *a);
/* Shared hole/property query. Canonical indices answer from indexed storage;
 * noncanonical numeric keys answer from their referent-owned descriptors after
 * binding. Presence/state never invoke accessors; VALUE can describe an accessor,
 * so property Get must use the owned read rather than state followed by a raw read. */
bool scr_arr_has(const ScrArr *a, double i);
double scr_arr_state(const ScrArr *a, double i);
double scr_arr_next_present(const ScrArr *a, double start);
/* Set Array.prototype.length semantics for the supported native array
 * surface. Growth creates holes without allocating a dense prefix; shrinking
 * releases removed reference elements. Invalid lengths set a catchable
 * RangeError and leave the array unchanged. Frozen length assignments throw
 * first; sealed truncation stops just above the highest present element. */
void scr_arr_set_len(ScrArr *a, double length);
/* Property-action guards shared with generated stores and publication.
 * False means a TypeError is pending; no storage or ownership is changed.
 * Call after operands are evaluated, before moving owned values. */
/* Includes publication, whose immutable count outlives scalar metadata. */
unsigned scr_arr_integrity_flags(const ScrArr *a);
bool scr_arr_check_set(const ScrArr *a, double index);
bool scr_arr_check_delete(const ScrArr *a, double index);
bool scr_arr_check_length(const ScrArr *a);
/* Reflect requests quiet integrity refusal; conversion and representation
 * errors remain pending exceptions. The same owners back strict stores. */
bool scr_arr_check_set_mode(const ScrArr *a, double index, bool strict);
bool scr_arr_check_length_mode(const ScrArr *a, bool strict);
bool scr_arr_set_len_mode(ScrArr *a, double length, bool strict);
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
 * sparse presence, and return the receiver retained. Integrity refusals
 * stop at the first failed property action and return NULL with a pending
 * exception; prior successful writes remain visible. */
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

/* Callback-free compiler storage reads. Canonical own slots and unpromoted
 * raw names only; promoted names have no raw slot. Strict reads trap for
 * missing/undefined, optional number reads return NaN, references are +1
 * unless borrowed. Borrowed reads require the array's owner to stay alive. */
double scr_arr_get_slot_f64(const ScrArr *a, double i);
bool scr_arr_get_slot_bool(const ScrArr *a, double i);
void *scr_arr_get_slot_ref(const ScrArr *a, double i);
void *scr_arr_borrow_slot_ref(const ScrArr *a, double i);
double scr_arr_get_slot_number(const ScrArr *a, double i);

double scr_arr_get_f64(ScrArr *a, double i); /* trap missing/hole */
/* ToNumber(a[i]) for f64 storage: borrows a; missing/hole/undefined -> NaN. */
double scr_arr_get_number(const ScrArr *a, double i);
/* Strict equality of raw storage reads on matching primitive arrays.
 * Borrows both arrays, preserves undefined vs NaN, and never allocates. */
bool scr_arr_index_eq(const ScrArr *a, double i, const ScrArr *b, double j);
bool scr_arr_get_bool(ScrArr *a, double i);  /* trap missing/hole */
void *scr_arr_get_ref(ScrArr *a, double i);  /* trap missing/hole; +1 */
/* Borrowed raw-slot reads cannot serve promoted named properties. */
void *scr_arr_borrow_ref(ScrArr *a, double i);
/* Borrow a non-null reference element, or NULL for a hole/undefined/missing
 * property. Keep the array alive and retain before removing its element.
 * This read does not invoke retain callbacks or mutate runtime state. Promoted
 * names return NULL; use the owned property API for their data or accessors. */
void *scr_arr_peek_ref(const ScrArr *a, double i);

/* i == len appends; the _ref variant releases the old element (when
 * replacing) and takes ownership of the new one. */
void scr_arr_set_f64(ScrArr *a, double i, double v);
void scr_arr_set_bool(ScrArr *a, double i, bool v);
void scr_arr_set_ref(ScrArr *a, double i, void *v);
void scr_arr_set_undefined(ScrArr *a, double i);
/* Return whether an own property was removed, not the JS Delete result.
 * Non-strict refusal preserves both the element and any pending exception. */
bool scr_arr_delete_mode(ScrArr *a, double i, bool strict);
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

/* push/unshift return the new length, or zero with an exception pending.
 * _ref takes ownership even on failure. The existing maximum-length trap
 * boundary is unchanged; these checks cover native integrity restrictions. */
double scr_arr_push_f64(ScrArr *a, double v);
double scr_arr_push_bool(ScrArr *a, bool v);
double scr_arr_push_ref(ScrArr *a, void *v);
/* Compiler-built slot buffers do not alias array storage. Both operations
 * consume every slot even when mutation fails before insertion. Pass the
 * whole call's argument count; zero arguments still perform a length Set. */
double scr_arr_push_many(ScrArr *a, size_t count, const uint64_t *slots);
double scr_arr_unshift_many(ScrArr *a, size_t count, const uint64_t *slots);
/* Append a same-element-kind array through the JS iterator contract: holes
 * become present undefined states. The source is borrowed and self-spread
 * duplicates the original indexed state. Failure preserves completed
 * writes and releases temporary copies, leaving the borrowed source owned. */
double scr_arr_push_spread(ScrArr *a, const ScrArr *src);
/* Append a concat argument by indexed property copy, preserving holes. */
double scr_arr_concat_copy(ScrArr *a, const ScrArr *src);

/* unshift returns the new length and _ref takes ownership. The spread form
 * borrows a same-element-kind source, retains copied refs, and snapshots
 * self-spread. reverse mutates in place and returns the receiver at +1,
 * or NULL with a pending exception after an integrity refusal. */
double scr_arr_unshift_f64(ScrArr *a, double v);
double scr_arr_unshift_bool(ScrArr *a, bool v);
double scr_arr_unshift_ref(ScrArr *a, void *v);
double scr_arr_unshift_spread(ScrArr *a, const ScrArr *src);
ScrArr *scr_arr_reverse(ScrArr *a);
/* Default primitive String ordering; stable, borrowed receiver, owned result.
 * A refused in-place write leaves its completed prefix and returns NULL
 * with a pending exception. Copies do not inherit receiver restrictions. */
ScrArr *scr_arr_sort_primitive(ScrArr *a, bool copy);
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
 * calling `f`, with the same stable result. */
void scr_arr_sort_values(ScrArr *a, double count, struct ScrClosure *f, uint32_t arity,
                         int32_t order, struct ScrClosure *key);
/* Comparator sort of a dense array in place: `a.sort(f)`, or with `owned`
 * the private copy of `a.toSorted(f)`. Returns false without calling `f`
 * when `a` has holes, storage-level undefined or a sparse tail (length >= 2);
 * the caller then sorts a compacted snapshot. Otherwise sorts
 * and returns true; a pending exception from `f` leaves a shared `a`
 * unwritten (an owned copy then holds a permutation of its values).
 * Refused writeback preserves the completed prefix and sets an exception. */
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

/* Removal state helpers return holes/undefined without trapping and move
 * value ownership into slot_out; NULL discards and releases the result.
 * On failure they return HOLE, zero the output, and leave an exception
 * pending with completed mutations intact. Scalar/ref wrappers trap only
 * on a successful undefined result; _ref transfers ownership out. */
double scr_arr_pop_f64(ScrArr *a);
bool scr_arr_pop_bool(ScrArr *a);
void *scr_arr_pop_ref(ScrArr *a);
uint8_t scr_arr_pop_state(ScrArr *a, uint64_t *slot_out);

/* shift: the first element out, tail sliding down; same ownership and
 * pending-exception contract as pop. */
double scr_arr_shift_f64(ScrArr *a);
bool scr_arr_shift_bool(ScrArr *a);
void *scr_arr_shift_ref(ScrArr *a);
uint8_t scr_arr_shift_state(ScrArr *a, uint64_t *slot_out);

/* splice(start, deleteCount) — the REMOVAL forms: Node-exact
 * relative/clamped start, count clamped to [0, len - start] (+Infinity =
 * to the end). Returns the removed elements in order as a fresh +1 array,
 * borrowing a (and items for insertion). Failure returns NULL with an
 * exception pending; completed writes remain visible. */
ScrArr *scr_arr_splice(ScrArr *a, double start, double deleteCount);
ScrArr *scr_arr_splice_insert(ScrArr *a, double start, double deleteCount,
                              const ScrArr *items);
/* The same splice in statement position: inserts `count` owned value slots
 * (moved in) and releases the removed elements. Consumes every input slot
 * even on failure, which leaves an exception pending and preserves partial
 * writes. Borrows a; unrestricted dense calls avoid temporary arrays. */
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
