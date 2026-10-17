/* scriptc runtime — typed arrays and Buffer (scr_bytes.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_BYTES_H
#define SCR_BYTES_H

#include "scr_events.h"

/* ── typed arrays / Buffer (scr_bytes.c) ──────────────────────────────
 * ONE runtime representation for the supported numeric typed arrays,
 * Node's Buffer (a Uint8Array subclass), and DataView: a refcounted,
 * MUTABLE, fixed-length element buffer. An ScrBytes either OWNS its
 * storage (backing == NULL, byteOffset 0) or is a VIEW: its `data` points
 * INTO an owner's storage and its `backing` retains that owner (chain
 * depth is always exactly 1 — views over views resolve to the owner at
 * construction), so reads/writes through the view alias the source
 * JS-exactly. Views come from DataView (scr_dataview_new) and from
 * subarray()/Buffer-slice() (scr_bytes_subarray — Buffer's slice is
 * subarray's deprecated alias in Node); only the plain typed arrays'
 * slice() copies (scr_bytes_slice, matching JS).
 * Elements are scalars only and the backing edge is acyclic by
 * construction (owners point at nothing): never part of a cycle, no
 * trace. Element reads widen to double; writes coerce JS-exactly (ToUint8
 * / ToUint32 modular truncation, double→float rounding for f32).
 * Out-of-bounds typed ELEMENT reads trap like arrays; invalid writes are
 * ignored as in JavaScript. The Node-shaped operations
 * (construction lengths, set(), the read/write numeric families, the
 * DataView constructor and getters) THROW catchable RangeErrors exactly
 * where Node throws. */

typedef enum ScrBytesElem {
  SCR_BYTES_U8,  /* Uint8Array / Buffer */
  SCR_BYTES_U32, /* Uint32Array */
  SCR_BYTES_F32, /* Float32Array */
  SCR_BYTES_I32, /* Int32Array (reads sign-extend; writes ToInt32-wrap) */
  SCR_BYTES_F64, /* Float64Array */
  SCR_BYTES_I8,  /* Int8Array */
  SCR_BYTES_U16, /* Uint16Array */
  SCR_BYTES_I16, /* Int16Array */
  SCR_BYTES_U8C, /* Uint8ClampedArray */
} ScrBytesElem;

typedef struct ScrSharedBytes ScrSharedBytes;

typedef struct ScrBytes {
  size_t rc;
  size_t len; /* ELEMENT count, fixed at construction */
  ScrBytesElem elem;
  uint8_t *data; /* len * elem_size bytes; owned unless backing is set */
  /* NULL for owners. A view (DataView, subarray, Buffer-slice) sets this
   * to the retained OWNER it aliases (chain depth is always exactly 1:
   * views over views resolve to the owner at construction) and its `data`
   * points into backing->data — released, never freed. */
  struct ScrBytes *backing;
  bool is_buffer; /* Buffer brand belongs to the view, not its backing. */
  bool is_data_view; /* DataView is distinct from a numeric typed array. */
  bool external; /* Root aliases foreign memory; releasing it never frees data. */
  bool untransferable; /* A Buffer pool slab: its ArrayBuffer cannot be transferred. */
  ScrSharedBytes *shared; /* Neutral backing, borrowed by views from their local owner. */
} ScrBytes;

/* Copies out of and into shared storage, made of relaxed atomic accesses
 * (aligned 8-byte words, single bytes at unaligned edges). Lock-free
 * Atomics operations and element accesses on the same bytes stay free of
 * data races; a copy that overlaps a concurrent write may observe either
 * value of each word or byte, which ECMA-262 permits for non-atomic
 * accesses. */
void scr_shared_load(void *dst, const void *src, size_t n);
void scr_shared_store(void *dst, const void *src, size_t n);
ScrSharedBytes *scr_shared_retain(ScrSharedBytes *);
void scr_shared_release(ScrSharedBytes *);
void scr_bytes_make_shared(ScrBytes *);
ScrBytes *scr_shared_wrap(ScrSharedBytes *);
void scr_bytes_read(const ScrBytes *, size_t, void *, size_t);
void scr_bytes_write(ScrBytes *, size_t, const void *, size_t);
ScrStr *scr_bytes_string(const ScrBytes *, size_t, size_t);
ScrBytes *scr_bytes_snapshot(const ScrBytes *);
void scr_bytes_snapshot_release(ScrBytes **);
ScrBytes *scr_bytes_local_copy(ScrBytes *); /* +1; shared inputs are copied */
void scr_bytes_require_unshared(const ScrBytes *);
/* Snapshot before reading shared bytes in bulk or passing byte pointers to
 * I/O or callback-capable consumers. The copy is local and read with
 * scr_shared_load, so no shared raw memory escapes. */
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
#define SCR_BYTES_SNAPSHOT(name) \
  ScrBytes *scr_snapshot_##name __attribute__((cleanup(scr_bytes_snapshot_release))) = scr_bytes_snapshot(name); \
  if (scr_snapshot_##name) name = scr_snapshot_##name
#else
#define SCR_BYTES_SNAPSHOT(name) ((void)0)
#endif
ScrDyn *scr_shared_array_buffer_new(ScrDyn *);
ScrDyn *scr_worker_data(void);
ScrDyn *scr_worker_parent_port(void);
/* new MessageChannel() ({ port1, port2 }) and receiveMessageOnPort(port)
 * (scr_worker_events.c). */
ScrDyn *scr_worker_message_channel(void);
ScrDyn *scr_worker_receive_message_on_port(ScrDyn *port);
/* new BroadcastChannel(...args) (scr_worker_events.c): args is the argument
 * vector as one array (borrowed); may throw. */
ScrDyn *scr_worker_broadcast_channel(ScrDyn *args);
/* setEnvironmentData(key, value) and getEnvironmentData(key) (+1); both
 * borrow their arguments. */
void scr_worker_set_environment_data(ScrDyn *key, ScrDyn *value);
ScrDyn *scr_worker_get_environment_data(ScrDyn *key);
ScrDyn *scr_worker_resource_limits(void);
ScrDyn *scr_worker_thread_name_current(void);
/* markAsUntransferable(value) and isMarkedAsUntransferable(value)
 * (scr_worker_events.c); both borrow the value. */
void scr_worker_mark_untransferable(ScrDyn *value);
bool scr_worker_is_marked_untransferable(ScrDyn *value);
/* worker.stdout, worker.stderr and worker.stdin streams: main installs the
 * stream unit's operations and the Readable and Writable boxes (the
 * Writable one may be NULL) when the program reads them. */
struct ScrChildStreamOps;
void scr_worker_stdio_install(const struct ScrChildStreamOps *ops, ScrDyn *(*readable_box)(void *),
                              ScrDyn *(*writable_box)(void *));
void scr_worker_stdio_default(const struct ScrChildStreamOps *ops, ScrDyn *(*view)(void *));
ScrDyn *scr_worker_new(double root, ScrStr *filename, ScrDyn *options);
bool scr_shared_array_buffer_is(const ScrDyn *);
bool scr_buffer_storage_is(const ScrDyn *);
ScrBytes *scr_bytes_from_external(void *data, size_t length);
ScrDyn *scr_ffi_memory_module(ScrDyn *catalog);
ScrDyn *scr_ffi_argument(ScrDyn *value, ScrStr *type);

size_t scr_bytes_elem_size(ScrBytesElem elem); /* 1, 2, 4, or 8 */
const char *scr_bytes_elem_name(ScrBytesElem elem);
double scr_bytes_to_u8_clamp(double value);

/* node:string_decoder's StringDecoder (scr_bytes.c, beside the decoders
 * it shares): the decoder value is a record holding the CANONICAL
 * encoding name and an f64 packing the pending partial sequence (count +
 * up to 3 raw bytes — every encoding buffers at most 3); the compiler's
 * interned %strdec helpers thread both through these pure functions.
 * write answers the decoded complete prefix of pending+chunk, next the
 * packed new pending, end the buffered partial's flush (utf8 replacement
 * chars, base64's padded remainder, utf16le's held bytes; the stateless
 * latin1/ascii/hex flush nothing). Node-exact per encoding — utf8's
 * incomplete-tail walk, base64's mod-3 groups, utf16le's odd-byte and
 * trailing-lead-surrogate holds. None throws. */
ScrStr *scr_strdec_write(const ScrStr *enc, double pending, const ScrBytes *chunk);
double scr_strdec_next(const ScrStr *enc, double pending, const ScrBytes *chunk);
ScrStr *scr_strdec_end(const ScrStr *enc, double pending);

/* `new Uint8Array(n)` / Buffer.alloc(n): zero-filled. n goes through
 * ToIndex like JS (NaN → 0, truncate toward zero; negative or > 2^53-1
 * THROWS Node's "Invalid typed array length" RangeError catchably and
 * returns NULL with the exception pending). */
ScrBytes *scr_bytes_new(ScrBytesElem elem, double n); /* +1 */
/* Shared u8 view over exactly the source view's raw bytes. Borrows; +1. */
ScrBytes *scr_bytes_raw_view(ScrBytes *bytes);
ScrBytes *scr_bytes_as_buffer(ScrBytes *bytes); /* borrows; +1, Buffer factory only */
/* Views retain the root allocation; offsets are relative to its complete
 * byte storage, including when src is itself a subarray. */
ScrBytes *scr_bytes_buffer_view(ScrBytes *src, ScrBytesElem elem,
                               double offset, bool has_len, double length);
ScrDyn *scr_array_buffer_constructor(void);
ScrDyn *scr_array_buffer_new(ScrDyn *length);
ScrDyn *scr_array_buffer_from_bytes(ScrBytes *view);
bool scr_array_buffer_is(const ScrDyn *value);
bool scr_array_buffer_is_view(const ScrDyn *value);
double scr_array_buffer_byte_length_getter(void);
ScrDyn *scr_array_buffer_byte_length_descriptor(ScrDyn *getter);
ScrBytes *scr_array_buffer_view(ScrBytesElem elem, const ScrDyn *buffer,
                               const ScrDyn *offset, const ScrDyn *length);
ScrBytes *scr_array_buffer_view_u8c(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_i8(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_u16(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_i16(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_u8(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_u32(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_i32(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_f32(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_f64(ScrDyn *, ScrDyn *, ScrDyn *);
ScrBytes *scr_array_buffer_view_dv(ScrDyn *, ScrDyn *, ScrDyn *);
/* Native callback boundary: exact owned u8 copy. NULL with len == 0 is an
 * empty span. */
ScrBytes *scr_bytes_from_data(const uint8_t *data, size_t len); /* +1 */
ScrBytes *scr_bytes_take_data(uint8_t *data, size_t len); /* +1, consumes malloc storage */

/* Same-element-kind copy, preserving the raw representation. Cross-kind
 * construction uses scr_bytes_convert. Borrows src. Never throws. */
ScrBytes *scr_bytes_copy(const ScrBytes *src); /* +1 */

/* `new Uint8Array([1, 2, 3])` / Buffer.from(number[]): each f64 element
 * coerces per the element kind (ToUint8/ToUint32/float). Borrows arr
 * (SCR_ELEM_F64). Never throws. */
ScrBytes *scr_bytes_from_arr(ScrBytesElem elem, const ScrArr *arr); /* +1 */

static inline ScrBytes *scr_bytes_retain(ScrBytes *b) {
  if (b->rc != SIZE_MAX) b->rc++;
  return b;
}
void scr_bytes_release(ScrBytes *b); /* NULL-tolerant */
void *scr_bytes_retain_v(void *b);
void scr_bytes_release_v(void *b);
#ifdef SCR_RC_AUDIT
long scr_bytes_live_count(void);
#endif

double scr_bytes_len(const ScrBytes *b);      /* element count */
double scr_bytes_byte_len(const ScrBytes *b); /* len * elem size */

/* `.byteOffset`: 0 for owners (scriptc typed arrays always own their
 * whole storage — SEMANTICS.md notes the divergence from Node's Buffer
 * pooling), the view's offset into its owner's storage for a DataView. */
double scr_bytes_byte_offset(const ScrBytes *b);

/* `new DataView(src.buffer, byteOffset?, byteLength?)` — src is the bytes
 * value whose `.buffer` the program named (any elem kind; a DataView src
 * resolves to ITS owner, so offsets stay relative to the one buffer,
 * exactly like JS). Both indices go through ToIndex (NaN → 0, truncate
 * toward zero); a bad offset THROWS Node's "Start offset %s is outside
 * the bounds of the buffer" and a bad/overflowing length "Invalid
 * DataView length %s" (catchable RangeErrors, NULL result with the
 * exception pending). has_len distinguishes an omitted byteLength (view
 * to the end of the buffer) from an explicit one. Borrows src; the
 * result retains the owner. */
ScrBytes *scr_dataview_new(ScrBytes *src, double byte_off, bool has_len, double byte_len); /* +1 */

/* DataView getters. LE flag false = big-endian (the JS default). The
 * BIGU64/BIGI64 kinds answer the composed Number(view.getBigUint64/
 * getBigInt64(...)) lowering: the 8-byte integer converted to double
 * (round-to-nearest-even — exactly Number(bigint)). Offsets go through
 * ToIndex; any invalid or out-of-range offset THROWS Node's "Offset is
 * outside the bounds of the DataView" RangeError catchably (0 result
 * with the exception pending). */
typedef enum ScrDataViewGet {
  SCR_DV_U8, SCR_DV_I8, SCR_DV_U16, SCR_DV_I16, SCR_DV_U32, SCR_DV_I32,
  SCR_DV_F32, SCR_DV_F64, SCR_DV_BIGU64, SCR_DV_BIGI64,
} ScrDataViewGet;
double scr_dataview_get(const ScrBytes *b, double byte_off, ScrDataViewGet kind, bool le);

/* DataView setters (the integer/float kinds only — the BIG kinds never
 * lower: bigint arguments have no representation). Values coerce
 * JS-exactly: the integer kinds by modular truncation (ToUint32's residue
 * — the narrower widths store its low bytes, the same 2^width residue),
 * F32 by double→float round-to-nearest-even. Offsets go through ToIndex
 * with the getters' one RangeError. */
void scr_dataview_set(ScrBytes *b, double byte_off, double value, ScrDataViewGet kind, bool le);

/* Element read/write. Invalid typed reads trap; invalid writes are ignored.
 * Checked reads preserve JavaScript's undefined result. Valid writes coerce
 * JS-exactly: u8/u32 by modular truncation (NaN/±Infinity → 0, truncate
 * toward zero, wrap mod 2^8/2^32), f32 by double→float rounding. */
double scr_bytes_get(const ScrBytes *b, double i);
double scr_bytes_get_or_nan(const ScrBytes *b, double i); /* NaN when the index is invalid */
void scr_bytes_set(ScrBytes *b, double i, double v);
/* Shared-view element access at an index the caller has checked against
 * the length (0 <= i < len). Each accesses the element as one relaxed
 * atomic access of its width. Integer elements read as their value in 32 bits, sign- or
 * zero-extended, with Uint32 elements as their bit pattern; float elements
 * read as a double. Writes coerce like scr_bytes_set. Compiled code calls
 * these only from a view's shared branch. */
int32_t scr_bytes_shared_get_int(const ScrBytes *b, size_t i);
double scr_bytes_shared_get_f64(const ScrBytes *b, size_t i);
void scr_bytes_shared_set(ScrBytes *b, size_t i, double v);
/* Replace a live typed-array capsule's fixed-size payload from its dyn
 * snapshot. Source and target have the same compiler-checked bytes type. */
void scr_bytes_copy_contents(ScrBytes *dst, const ScrBytes *src);

/* TypedArray.prototype.slice(start, end): relative indices clamp like
 * string/array slice (ToIntegerOrInfinity, negatives from the end); the
 * result is a fresh same-kind copy. Never throws. */
ScrBytes *scr_bytes_slice(const ScrBytes *b, double start, double end); /* +1 */
/* Independent element-coerced copy; same-kind copies preserve raw bits. */
ScrBytes *scr_bytes_convert(ScrBytesElem elem, const ScrBytes *src); /* +1 */
/* Checked native constructor/from input; no JavaScript engine required.
 * `from` selects iterable/array-like semantics, otherwise primitives are
 * converted to lengths. Borrows source, returns +1 or NULL+pending. */
ScrBytes *scr_bytes_from_dyn(ScrBytesElem elem, const ScrDyn *value, bool from);

/* In-place, overlapping copy with relative/clamped element indices;
 * returns the retained receiver, including for a shared subarray view. */
ScrBytes *scr_bytes_copy_within(ScrBytes *b, double target, double start, double end); /* +1 */

/* ES2023 typed-array copying methods. Both preserve the receiver's element
 * kind and return a fresh +1 owner. with() raises Node's catchable
 * "Invalid typed array index" RangeError for an invalid relative index. */
ScrBytes *scr_bytes_to_reversed(const ScrBytes *b); /* +1 */
/* In-place numeric sort of a typed array: order 0 is the default
 * TypedArray order (NaN last, -0 before +0); 1 or -1 is a recognized
 * numeric comparator's, refused (false, nothing written) when a float
 * element is NaN or -0. Runs no script code. */
bool scr_bytes_sort_numeric(ScrBytes *b, int32_t order);
/* Comparator sort of a typed array with the comparison schedule Node
 * uses; `f` is a borrowed closure of `arity` (0..2) number parameters.
 * A comparator exception stays pending and nothing is written back. */
void scr_bytes_sort_compare(ScrBytes *b, struct ScrClosure *f, uint32_t arity);
ScrBytes *scr_bytes_with(const ScrBytes *b, double index, double value); /* +1 */

/* Numeric typed-array iteration drained into number[], and Uint8Array.join.
 * Inputs borrowed; results fresh +1. */
ScrArr *scr_bytes_to_arr(const ScrBytes *b); /* +1 */
ScrStr *scr_bytes_join(const ScrBytes *b, const ScrStr *separator); /* +1 */

/* TypedArray.prototype.fill on non-u8 receivers: per-element fill with
 * the element write's coercion, slice-clamped relative indices; answers
 * the receiver +1 (chaining). Never throws. */
ScrBytes *scr_bytes_fill_elem(ScrBytes *b, double v, double start, double end); /* +1 */

/* TypedArray.prototype.subarray(start, end) — and Buffer's slice(), its
 * deprecated alias: a same-elem VIEW aliasing the receiver's storage
 * (mutations visible both ways, JS-exactly). The view retains the OWNER
 * (chain depth exactly 1, the DataView rule) and its byteOffset composes.
 * Same index clamping as slice; never throws. */
ScrBytes *scr_bytes_subarray(ScrBytes *b, double start, double end); /* +1 */

/* dst.set(src, offset): overlapping-safe, element-coerced copy.
 * offset goes through ToIntegerOrInfinity; a negative offset or
 * src.len + offset > dst.len THROWS Node's "offset is out of bounds"
 * RangeError catchably. */
void scr_bytes_set_from(ScrBytes *dst, const ScrBytes *src, double offset);
/* Array-like source with sequential element coercion and catchable errors.
 * Earlier writes remain visible when a later coercion throws. */
void scr_bytes_set_from_dyn(ScrBytes *dst, const ScrDyn *src, double offset);

/* buf.toString(enc) on u8 bytes: "utf8" decodes with WHATWG per-maximal-
 * subpart U+FFFD replacement (Node-exact for invalid sequences), "hex" is
 * lowercase pairs, "base64"/"base64url" the standard/url alphabets (url
 * unpadded), "latin1" maps bytes to U+00XX, "ascii" masks to & 0x7f, and
 * "utf16le" decodes LE code units (surrogate pairs combine; a LONE
 * surrogate stays lone; an odd tail byte drops). Aliases arrive NORMALIZED (the compiler folds "binary",
 * "ucs2", "utf-8", ...); NULL selects the default UTF-8 encoding for
 * implicit native coercions. Borrows both; +1 result. Never throws (the
 * compiler fences other encodings). */
ScrStr *scr_bytes_to_str(const ScrBytes *b, const ScrStr *enc);
ScrStr *scr_bytes_to_str_range(const ScrBytes *b, const ScrStr *enc, double start, double end);
/* Runtime-valued Buffer.toString encoding: aliases/case canonicalize;
 * unknown names throw ERR_UNKNOWN_ENCODING. +1, or NULL when throwing. */
ScrStr *scr_bytes_to_str_checked(const ScrBytes *b, const ScrStr *enc);
ScrStr *scr_bytes_to_str_checked_range(const ScrBytes *b, const ScrStr *enc, double start, double end);

/* WHATWG TextDecoder.decode over u8 bytes (utf-8, default options): the
 * same replacement decode as toString("utf8") with the leading BOM
 * stripped. Borrows; +1; never throws. */
ScrStr *scr_text_decode(const ScrBytes *b);
double scr_text_decoder_encoding(const ScrDyn *label);
ScrStr *scr_text_decoder_name(double encoding);
ScrDyn *scr_text_encode_into(const ScrDyn *source, const ScrDyn *destination);
bool scr_buffer_is_ascii(const ScrDyn *input);
bool scr_buffer_is_utf8(const ScrDyn *input);
ScrBytes *scr_buffer_transcode(const ScrDyn *source, const ScrDyn *from, const ScrDyn *to);
ScrBytes *scr_bytes_buffer_source(const ScrDyn *value);
ScrStr *scr_text_decode_buffer_source(const ScrDyn *value);
ScrStr *scr_text_decode_options(const ScrBytes *b, bool fatal, bool ignore_bom);
ScrStr *scr_text_decode_stream(ScrDyn *state, const ScrBytes *b, double encoding, bool fatal, bool ignore_bom, bool stream);
ScrStr *scr_text_decode_legacy_options(const ScrBytes *b, double encoding, bool fatal, bool ignore_bom);

/* TextDecoder with a compile-time WHATWG legacy-encoding id. The frontend
 * owns label canonicalization and emits only the ids understood by
 * scr_bytes.c; keeping this separate from scr_text_decode means default
 * UTF-8 users do not retain the legacy mapping tables. Borrows; +1. */
ScrStr *scr_text_decode_legacy(const ScrBytes *b, double encoding);

/* Buffer.from(string, enc): "utf8" copies the bytes; "hex" parses pairs
 * and stops at the first invalid/odd tail (Node-lenient); "base64" and
 * "base64url" decode the standard AND url-safe alphabets, skipping
 * invalid bytes (Node-lenient); "latin1"/"ascii" write each UTF-16
 * unit's low byte (astral code points contribute their two surrogates');
 * "utf16le" writes LE code units, surrogate pairs included. Borrows
 * both; +1 u8 result. Never throws. */
ScrBytes *scr_bytes_from_str(const ScrStr *s, const ScrStr *enc);
/* The Buffer pool (Node's lib/buffer.js allocate/fromStringFast/
 * fromArrayLike): Buffer.allocUnsafe, Buffer.from of strings, arrays and
 * array-likes, and Buffer.concat return views into a per-thread slab of
 * Buffer.poolSize bytes when the size is below poolSize >>> 1. Views start
 * at 8-byte aligned offsets; a request that does not fit starts a new
 * slab. A slab lives while any of its views does. All return +1 Buffers. */
double scr_buffer_pool_size(void);
void scr_buffer_set_pool_size(double size);
ScrBytes *scr_buffer_alloc(double size);             /* zeroed, never pooled */
ScrBytes *scr_buffer_alloc_unsafe(double size);      /* pooled */
ScrBytes *scr_buffer_alloc_unsafe_slow(double size); /* never pooled */
ScrBytes *scr_buffer_from_str(const ScrStr *s, const ScrStr *enc);
ScrBytes *scr_buffer_from_str_checked(const ScrStr *s, const ScrStr *enc);
ScrBytes *scr_buffer_from_bytes(const ScrBytes *src); /* a copy of any typed array's values */
ScrBytes *scr_buffer_from_arr(const ScrArr *arr);     /* number[] */
ScrBytes *scr_buffer_from_dyn_pooled(const ScrDyn *value, const ScrStr *encoding);
ScrBytes *scr_buffer_concat(const ScrArr *list);
ScrBytes *scr_buffer_concat_len(const ScrArr *list, double total);
/* Drops the pool's slab reference and restores Buffer.poolSize (process
 * exit audits and library session resets). */
void scr_buffer_pool_reset(void);
/* A pooled copy of an unpooled u8 Buffer below the pool threshold; others
 * are returned as they are. Consumes `b`. */
ScrBytes *scr_buffer_pool_adopt(ScrBytes *b);
ScrBytes *scr_bytes_from_str_checked(const ScrStr *s, const ScrStr *enc);

/* Buffer.byteLength(string, enc) — enc NORMALIZED like from_str — and
 * Buffer.isEncoding(name) (case-insensitive over Node's alias set).
 * Borrow; never throw. */
double scr_bytes_byte_length_str(ScrStr *s, const ScrStr *enc);
double scr_buffer_byte_length_dyn(ScrDyn *value, ScrStr *enc);
bool scr_bytes_is_encoding(const ScrStr *s);

/* equals / compare / indexOf-lastIndexOf / fill / copy / swap / write on
 * u8 bytes, Node-exact (corpus 1663). compare and copy take nargs — the
 * count of PRESENT index args (defaults skip validation like Node);
 * their ladders and fill/write's mirror validateOffset ('an integer',
 * then '>= 0 && <= max' — Node spells '&&' here) and copy's C++ ladder
 * (fractionals truncate without an error; targetStart/sourceEnd check only
 * >= 0). indexOf coerces byteOffset (NaN = search everything) and steps
 * by `align` (2 for utf16le needles — matches land on even offsets).
 * fill repeats the pattern over [offset, end) and answers the RECEIVER
 * (+1, chaining); the string form zero-fills on an empty pattern where
 * the bytes form throws Node's TypeError. swap reverses w-byte groups in
 * place (+1 receiver; ERR_INVALID_BUFFER_SIZE off the width). write
 * encodes and truncates at unit boundaries (whole UTF-8 code points,
 * even utf16le lengths), returning the bytes written. concat_len
 * truncates/zero-pads the concatenation to the validated total. */
bool scr_bytes_equals(const ScrBytes *a, const ScrBytes *b);
double scr_bytes_compare(const ScrBytes *src, const ScrBytes *target, double nargs,
                         double ts, double te, double ss, double se);
/* Node's validateOffset ladder (buffer.js): non-integers (±Infinity and
 * NaN included) throw the 'an integer' ERR_OUT_OF_RANGE RangeError, the
 * rest the '>= 0 && <= max' render; max < 0 drops the upper bound.
 * Returns false after arming the pending throw. */
bool scr_bytes_validate_off(const char *name, double value, double max);
/* The checked-dynamic compare/equals validators (scr_bytes_io.c): Node's
 * argument ladder over dyn-boxed arguments — a non-bytes value throws
 * ERR_INVALID_ARG_TYPE with the API's own argument name ("buf1"/"buf2",
 * "otherBuffer", "target"), non-number offsets ERR_INVALID_ARG_TYPE
 * "of type number", out-of-range numbers the validateOffset RangeError;
 * an undefined offset takes its Node default. All arguments BORROWED. */
double scr_buffer_compare_chk(const ScrDyn *a, const ScrDyn *b);
ScrBytes *scr_buffer_from_dyn(const ScrDyn *value, const ScrStr *encoding); /* +1 or NULL+pending; borrowed args */
bool scr_bytes_equals_chk(const ScrBytes *recv, const ScrDyn *other);
double scr_bytes_compare_chk(const ScrBytes *src, const ScrDyn *target,
                             const ScrDyn *ts, const ScrDyn *te,
                             const ScrDyn *ss, const ScrDyn *se);
/* new Buffer(number, encoding)'s string-arm type error (always throws;
 * borrowed). */
ScrBytes *scr_buffer_new_string_fail(const ScrDyn *got);
/* fs._toUnixTimestamp over a dyn time value: numeric strings and finite
 * numbers coerce (negatives answer now/1000), the rest throw Node's
 * ERR_INVALID_ARG_TYPE. Borrowed. */
double scr_fs_to_unix_timestamp(const ScrDyn *t);
double scr_fs_timestamp_value(const ScrDyn *t, const char *name);
void scr_fs_utimes_checked(const ScrDyn *path, const ScrDyn *atime, const ScrDyn *mtime);
void scr_fs_lutimes_checked(const ScrDyn *path, const ScrDyn *atime, const ScrDyn *mtime);
void scr_fs_futimes_checked(const ScrDyn *fd, const ScrDyn *atime, const ScrDyn *mtime);
/* The fs argument-validation ladders (the fs.*Chk libCalls): Node-order
 * validation over dyn values with Node's exact typed errors; a pass
 * meets the real operation where one exists (mkdtempSync, macOS
 * lchmodSync) or the compiler-rendered fence. All borrowed; the Chk
 * forms without results always leave an exception pending. */
ScrDyn *scr_fs_exists_async(const ScrDyn *path, const ScrDyn *cb);
void scr_fs_mkdtemp_chk(const ScrDyn *prefix, const ScrDyn *cb, const ScrStr *fence);
ScrStr *scr_fs_mkdtemp_sync_chk(const ScrDyn *prefix, const ScrDyn *opts, const ScrStr *fence);
void scr_fs_read_file_chk(const ScrDyn *path, const ScrDyn *opts, const ScrDyn *cb, const ScrStr *fence);
void scr_fs_opendir_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence);
void scr_fs_watch_file_chk(const ScrDyn *path, const ScrDyn *listener, const ScrStr *fence);
void scr_fs_lchmod_chk(const ScrDyn *path, const ScrDyn *mode, const ScrDyn *cb, const ScrStr *fence);
ScrDyn *scr_fs_lchmod_sync_chk(const ScrDyn *path, const ScrDyn *mode);
ScrPromise *scr_fsp_lchmod_chk(const ScrDyn *path, const ScrDyn *mode);
void scr_fs_read_chk(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                     const ScrDyn *length, const ScrDyn *position, const ScrStr *fence);
void scr_fs_stream_opts_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence);
/* The fs streams' option pieces (scr_fs_stream.c): the getOptions,
 * options.fd and path checks above without the fence; the checked path
 * (+1, URLs converted); string flags as native open(2) bits (-1 with the
 * exception pending); parseFileMode with the 0o666 default. */
bool scr_fs_stream_opts_valid(const ScrDyn *path, const ScrDyn *opts);
ScrStr *scr_fs_stream_path(const ScrDyn *value);
int scr_fs_stream_flags(const ScrDyn *flag, const char *fallback);
bool scr_fs_stream_mode(const ScrDyn *value, double *mode);
/* The checked-dynamic max-listeners ladders (scr_events_emitter.c). */
ScrEmitter *scr_emitter_set_max_chk(ScrEmitter *em, const ScrDyn *n);
void scr_emitter_set_default_max_chk(const ScrDyn *n, const ScrStr *name);
double scr_bytes_index_of(const ScrBytes *b, const ScrBytes *needle, double off, double align, bool fwd);
double scr_bytes_index_of_num(const ScrBytes *b, double v, double off, bool fwd);
ScrBytes *scr_bytes_fill(ScrBytes *b, const ScrBytes *pattern, double nargs, double offset, double end);
ScrBytes *scr_bytes_fill_num(ScrBytes *b, double v, double nargs, double offset, double end);
ScrBytes *scr_bytes_fill_str(ScrBytes *b, const ScrStr *s, const ScrStr *enc,
                             double nargs, double offset, double end);
double scr_bytes_copy_into(const ScrBytes *src, ScrBytes *dst, double nargs,
                           double ts, double ss, double se);
ScrBytes *scr_bytes_swap(ScrBytes *b, double width);
double scr_bytes_write_str(ScrBytes *b, const ScrStr *s, const ScrStr *enc,
                           double offset, double len, bool has_len);
ScrBytes *scr_bytes_concat_len(const ScrArr *list, double total);

/* Buffer.concat(list): list is a SCR_ELEM_BYTES array of u8 bytes values;
 * the result is one fresh copy of their concatenation. Borrows the list.
 * Never throws. */
ScrBytes *scr_bytes_concat(const ScrArr *list); /* +1 */

#endif /* SCR_BYTES_H */
