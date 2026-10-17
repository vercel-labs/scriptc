/* scriptc runtime — node:stream (scr_stream.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_STREAM_H
#define SCR_STREAM_H

#include "scr_events_emitter.h"

/* ── node:stream (scr_stream.c, link-gated by moduleUsesStream) ───────
 * The runtime-provided stream classes (Readable/Writable/Duplex/
 * Transform/PassThrough) behind the options-object constructor forms.
 * ONE layout for all five: the ScrEmitter prefix (so every emitter
 * mechanism — listener registry, emit dispatch, upcasts — applies
 * unchanged) plus a lazily-detailed state block. User `extends` of these
 * classes compiles (phase 2): the emitted subclass struct embeds this
 * full prefix (one extra slot over an emitter subclass — the state
 * pointer), allocation stamps the SUBCLASS vtable and display name and
 * leaves st NULL, and the constructor's super(options) call lands on a
 * scr_stream_init_* entry below. Stream identity for such instances is
 * preorder-interval membership under a runtime stream vtable (main()
 * stamps the intervals, the emitter-vt story).
 *
 * Event timing: Node defers most stream emissions by a process.nextTick.
 * Here those deferrals ride a dedicated TICK QUEUE drained at the top of
 * every loop turn (before the events/net/timer stations — the closest
 * station to nextTick; SEMANTICS.md documents the microtask-order
 * divergence), registered via scr_loop_set_stream at install. Emits run
 * user code synchronously on the dispatching stack and may leave an
 * exception pending, exactly like scr_emitter_emit — an unhandled
 * 'error' event throws its payload (Node's crash).
 *
 * Ownership: constructors take their option callbacks +1 (moves);
 * chunks are BORROWED at push/write (the buffer retains its copy);
 * chaining forms return the receiver +1; read()/errored answer +1 or
 * NULL. The *_done completion entries take err/data +1 (moves) — they
 * are called by compiler-emitted completion-callback closures. */
typedef struct ScrStreamState ScrStreamState;
typedef struct ScrBytes ScrBytes; /* full definition below (C11 repeat) */
/* events.addAbortListener (scr_events_add_abort_listener): passed to the
 * signal-taking stream and readline entry points by programs that link
 * the event-target unit. */
typedef ScrDyn *(*ScrAbortAddFn)(ScrDyn *signal, ScrDyn *listener);

typedef struct ScrStream {
  size_t rc;
  const ScrVt *vt;
  ScrEeReg *reg;   /* ScrEmitter prefix */
  const char *cls; /* ScrEmitter prefix (display name) */
  ScrStreamState *st;
} ScrStream;

extern SCR_TL ScrVt scr_readable_vt, scr_writable_vt, scr_duplex_vt,
    scr_transform_vt, scr_passthrough_vt; /* main() stamps pre/post */

/* Compiler-emitted option-callback invoke adapters (the leading-`this`
 * closures): the runtime calls the user's read/write/final/destroy/
 * transform/flush through these. */
typedef void (*ScrStreamReadInv)(ScrClosure *cb, ScrStream *s, double size);
typedef void (*ScrStreamChunkInv)(ScrClosure *cb, ScrStream *s, ScrBytes *chunk);
typedef void (*ScrStreamPlainInv)(ScrClosure *cb, ScrStream *s);
typedef void (*ScrStreamErrInv)(ScrClosure *cb, ScrStream *s, ScrError *err);

/* Constructors (+1 result; option callbacks MOVE; NULL = absent). hwm < 0
 * means the byte default (65536 — Node 24's getDefaultHighWaterMark). */
ScrStream *scr_stream_new_readable(double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
ScrStream *scr_stream_new_writable(double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
ScrStream *scr_stream_new_duplex(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
ScrStream *scr_stream_new_transform(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
ScrStream *scr_stream_new_passthrough(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);

/* Subclass initialization (the emitted super(options) call over an
 * ALREADY-ALLOCATED subclass struct — same tails as the constructors;
 * receiver borrowed, callbacks move). Overridden underscore methods
 * (_read/_write/...) arrive as compiler-synthesized wrapper closures
 * that dispatch through the receiver's vtable. */
void scr_stream_init_readable(ScrStream *s, double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
void scr_stream_init_writable(ScrStream *s, double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
void scr_stream_init_duplex(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
void scr_stream_init_transform(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);
void scr_stream_init_passthrough(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv);

/* The dyn-options twins (a checked-dynamic options record at
 * construction — `super(options)` forwarding a JS-lane parameter, `new
 * Readable(dynVar)`): the option walk runs at runtime with Node's own
 * reading rules (unknown keys ignored; consumed-but-unlowered options
 * throw the "not supported yet" Error — MAY THROW, NULL result / no init
 * with the exception pending). opts is BORROWED; the fallback closures
 * (a subclass's overridden underscore-method wrappers, shadowed by
 * options callbacks per Node's instance-property rule) MOVE. */
ScrStream *scr_stream_new_readable_dyn(struct ScrDyn *opts);
void scr_stream_worker_stdio(void);
ScrStream *scr_stream_new_writable_dyn(struct ScrDyn *opts);
ScrStream *scr_stream_new_duplex_dyn(struct ScrDyn *opts);
ScrStream *scr_stream_new_transform_dyn(struct ScrDyn *opts);
ScrStream *scr_stream_new_passthrough_dyn(struct ScrDyn *opts);
void scr_stream_init_readable_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *read_fb, ScrStreamReadInv read_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);
void scr_stream_init_writable_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *write_fb, ScrStreamChunkInv write_fb_inv,
    ScrClosure *final_fb, ScrStreamPlainInv final_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);
void scr_stream_init_duplex_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *read_fb, ScrStreamReadInv read_fb_inv,
    ScrClosure *write_fb, ScrStreamChunkInv write_fb_inv,
    ScrClosure *final_fb, ScrStreamPlainInv final_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);
void scr_stream_init_transform_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *transform_fb, ScrStreamChunkInv transform_fb_inv,
    ScrClosure *flush_fb, ScrStreamPlainInv flush_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);
void scr_stream_init_passthrough_dyn(ScrStream *s, struct ScrDyn *opts,
    ScrClosure *transform_fb, ScrStreamChunkInv transform_fb_inv,
    ScrClosure *flush_fb, ScrStreamPlainInv flush_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv);

/* stream.finished(s, cb) — the callback form: cb fires once at the
 * stream's terminal point (right after 'close'; asynchronously when
 * already closed) through the ErrInv ABI with the finish status (NULL /
 * the error / ERR_STREAM_PREMATURE_CLOSE). Returns the +1 CLEANUP
 * closure (a () => void unhooking the callback). cb MOVES. A registered
 * watcher marks lifecycle errors handled (no unhandled-'error' crash —
 * Node's eos registers listeners). */
ScrClosure *scr_stream_finished(ScrStream *s, ScrClosure *cb, ScrStreamErrInv inv);
/* The dyn-valued finished/pipeline callback inv (a mustCall wrapper in
 * the slot): success calls with NO arguments, errors box through the
 * boundary encoding. cb's cap boxes the dyn callable. */
void scr_stream_finished_dyn_inv(ScrClosure *cb, ScrStream *s, ScrError *err);
/* stream.pipeline(s1..sn, cb) — the callback form over stream arguments
 * (pipeline.js): pipes each pair, destroys the unfinished streams with
 * the first error, and calls cb on a nextTick once every stream's eos
 * watcher finished, with that error (or NULL). Streams borrowed; cb
 * MOVES; answers the destination +1 (pipeline's return value), or NULL
 * with ERR_STREAM_UNABLE_TO_PIPE / ERR_INVALID_ARG_TYPE pending. */
ScrStream *scr_stream_pipeline(double n, ScrStream **streams, ScrClosure *cb, ScrStreamErrInv inv);
/* The dyn-valued twins (the callback as a checked-dynamic value —
 * mustCall wrappers; borrowed). */
ScrClosure *scr_stream_finished_dyn(ScrStream *s, struct ScrDyn *cb);
ScrStream *scr_stream_pipeline_dyn(double n, ScrStream **streams, struct ScrDyn *cb);
/* pipeline(...[, cb]) with one run of function stages (pipeline.js): the
 * run starts at streams[at] (count functions). flags bit 0: the first
 * stage is a source function, called with only its options; bits 1-2:
 * the last stage is a function destination (2: an async function whose
 * promise, boxed through box, carries the value to the callback), and
 * pipeline() answers a PassThrough. Other
 * stages get the previous stream itself or the previous stage's async
 * generator. mask bit i: stage i takes { signal } (the pipeline's own
 * AbortSignal, aborted through abort when the pipeline finishes). The
 * last generator before a stream or a PassThrough is pumped
 * (pumpToNode) through its helpers: next/ret answer the resume's
 * promise, read maps its IteratorResult to the value or
 * scr_stream_from_done. Streams and closures borrowed (helpers, box,
 * signal and abort NULL when unused); cb moves. */
ScrStream *scr_stream_pipeline_stages(double n, ScrStream **streams, double at, double count,
                                      ScrClosure **stages, double flags, double mask,
                                      ScrClosure *next, ScrClosure *read, ScrClosure *ret,
                                      ScrClosure *box, struct ScrDyn *signal, ScrClosure *abort,
                                      ScrClosure *cb, ScrStreamErrInv inv);
ScrStream *scr_stream_pipeline_stages_dyn(double n, ScrStream **streams, double at, double count,
                                          ScrClosure **stages, double flags, double mask,
                                          ScrClosure *next, ScrClosure *read, ScrClosure *ret,
                                          ScrClosure *box, struct ScrDyn *signal,
                                          ScrClosure *abort, struct ScrDyn *cb);
struct ScrPromise *scr_sp_pipeline_stages(double n, ScrStream **streams, double at, double count,
                                          ScrClosure **stages, double flags, double mask,
                                          ScrClosure *next, ScrClosure *read, ScrClosure *ret,
                                          ScrClosure *box, struct ScrDyn *signal,
                                          ScrClosure *abort);
/* stream.compose(s1..sn): a pipeline over the streams and a Duplex that
 * writes to the first and reads from the last (compose.js). One stream
 * answers itself (Duplex.from of a duplex). +1, or NULL with
 * ERR_MISSING_ARGS / ERR_INVALID_ARG_VALUE pending. Streams borrowed. */
ScrStream *scr_stream_compose(double n, ScrStream **streams);

/* Emitted subclass RC/trace delegates for the state block (NULL-safe —
 * an exception before super(options) leaves st unset). The registry
 * slot rides scr_emitter_reg_* like any emitter subclass. */
void scr_stream_st_release(ScrStreamState *st);
void scr_stream_st_gcfree(ScrStreamState *st);
void scr_stream_st_trace(ScrStreamState *st, ScrTraceVisit visit, void *ctx);

/* The dyn-flavored completion-callback glues (the JS lane's implicitly-
 * any option callbacks / underscore methods): the emitted invoke thunks
 * mint a callable dyn (scr_dyn_new_func) over a 1-cap closure boxing the
 * retained stream, with the kind's glue — arguments arrive as dyn
 * values (error: null/undefined, a {message} object, or a string;
 * transform/flush data: bytes, a string, or absent). */
typedef struct ScrDyn ScrDyn; /* full declaration below (C11 repeat) */
ScrDyn *scr_stream_done_dyn_w(ScrClosure *clo, ScrDyn *const *args, size_t argc);
ScrDyn *scr_stream_done_dyn_f(ScrClosure *clo, ScrDyn *const *args, size_t argc);
ScrDyn *scr_stream_done_dyn_d(ScrClosure *clo, ScrDyn *const *args, size_t argc);
ScrDyn *scr_stream_done_dyn_t(ScrClosure *clo, ScrDyn *const *args, size_t argc);
ScrDyn *scr_stream_done_dyn_l(ScrClosure *clo, ScrDyn *const *args, size_t argc);

/* The readable surface. push/unshift borrow their chunk (strings convert
 * utf8, Node's decodeStrings default); push answers the below-hwm bool. */
bool scr_stream_push(ScrStream *s, ScrBytes *chunk);
bool scr_stream_push_str(ScrStream *s, ScrStr *str);
/* push(chunk, enc): the per-call literal encoding (canonical); overrides
 * the stream's defaultEncoding. Borrows both. */
bool scr_stream_push_str_enc(ScrStream *s, ScrStr *str, ScrStr *enc);
/* The defaultEncoding option's push side: how push(string) decodes chunks
 * (Buffer.from(chunk, enc)). Canonical literal, never "utf8". Receiver
 * answers +1 (the setEncoding chaining shape). */
ScrStream *scr_stream_set_push_encoding(ScrStream *s, ScrStr *enc);
bool scr_stream_push_null(ScrStream *s);
void scr_stream_unshift(ScrStream *s, ScrBytes *chunk);
void scr_stream_unshift_str(ScrStream *s, ScrStr *str);
ScrBytes *scr_stream_read(ScrStream *s, double size);
ScrStream *scr_stream_on_dyn(ScrStream *s, ScrStr *name, ScrDyn *cb, bool once, bool prepend);
ScrDyn *scr_stream_read_dyn(ScrStream *s, ScrDyn *size); /* +1 or NULL; size < 0 = all/first; throws once encoded (the static type is Buffer|null) */
/* setEncoding(enc): string-chunk mode — pushes decode through the
 * StringDecoder, 'data' delivers strings (the emit ABI carries both
 * payload slots; see scr_stream_emit_data), lengths count JS string
 * units. Borrows the canonical encoding name; receiver +1. */
ScrStream *scr_stream_set_encoding(ScrStream *s, ScrStr *enc);
typedef struct ScrPromise ScrPromise; /* full declaration below (C11 repeat) */
/* for-await: a +1 promise of the next chunk — buffered content (one
 * whole entry in Readable.from mode, the whole buffer otherwise —
 * Node's iterator read()), the EOF sentinel (an empty Buffer / dyn
 * undefined), or a rejection with the stream's error. The _dyn twin
 * boxes by runtime tag (the JS lane; encoded chunks arrive as dyn
 * strings); the typed form throws on encoded streams (chunks are
 * Buffers in typed code). At most one parked waiter (the loop awaits
 * each chunk before asking again). */
bool scr_stream_push_dyn(ScrStream *s, const ScrDyn *d);       /* borrows d; tag dispatch */
bool scr_stream_write_dyn(ScrStream *s, const ScrDyn *d, ScrClosure *cb); /* cb moves */
ScrPromise *scr_stream_next_chunk(ScrStream *s);
ScrPromise *scr_stream_next_chunk_dyn(ScrStream *s);
/* node:stream/promises — the promise forms over the finished/pipeline
 * machinery above: a pending void promise the terminal watcher settles
 * (fulfilled on a clean finish, rejected with the finish status
 * otherwise — the stream's error or ERR_STREAM_PREMATURE_CLOSE).
 * Streams borrowed; +1 promises. */
ScrPromise *scr_sp_finished(ScrStream *s);
ScrPromise *scr_sp_pipeline(double n, ScrStream **streams);
/* node:stream/consumers — the promise consumers over the readable
 * machinery: accumulate every chunk (string chunks as their utf8 bytes)
 * and settle at the terminal point (right after 'close', the eos timing
 * Node's consumers share) — text answers the utf8 decode, json parses
 * the text (malformed input rejects with the parse's SyntaxError; the
 * result is a +1 dyn tree), buffer the concatenated bytes, arrayBuffer
 * a +1 ArrayBuffer dyn over them. Stream errors reject; an early close
 * rejects ERR_STREAM_PREMATURE_CLOSE; a stream with no readable side
 * rejects Node's async-iterable TypeError.
 * Streams borrowed; +1 promises. */
ScrPromise *scr_sc_text(ScrStream *s);
ScrPromise *scr_sc_json(ScrStream *s);
ScrPromise *scr_sc_buffer(ScrStream *s);
ScrPromise *scr_sc_array_buffer(ScrStream *s);
/* Readable.from over a typed source: arr holds the string or Buffer
 * elements (one element under SCR_FROM_SINGLE, from.js's string/Buffer
 * case). Elements push lazily, one _read at a time, as whole entries
 * unless SCR_FROM_BYTE_MODE ({ objectMode: false }). hwm applies under
 * SCR_FROM_HAS_HWM. +1, or NULL with ERR_INVALID_ARG_VALUE pending.
 * Borrows arr. */
enum {
  SCR_FROM_STRINGS = 1,
  SCR_FROM_SINGLE = 2,
  SCR_FROM_BYTE_MODE = 4,
  SCR_FROM_HAS_HWM = 8,
  SCR_FROM_DEFAULT_HWM = 16, /* a nullish highWaterMark: the mode's default */
};
ScrStream *scr_stream_from_arr(ScrArr *arr, double flags, double hwm);
/* Readable.from(iterable, options) over a checked-dynamic source: a
 * string or Buffer, an array (read by index), or any other iterable or
 * async iterable, whose iterator from.js takes before reading the
 * options; options objectMode and highWaterMark. +1, or NULL with the
 * error pending (ERR_INVALID_ARG_TYPE for a non-iterable). Borrows. */
ScrStream *scr_stream_from_dyn(ScrDyn *src, ScrDyn *opts);
/* The from.js stream over a checked-dynamic iterator (scr_stream_ops.c),
 * async_iter when it came from Symbol.asyncIterator. iter moves; +1, or
 * NULL with ERR_INVALID_ARG_VALUE pending for a bad highWaterMark. */
ScrStream *scr_stream_from_dyn_iter(ScrDyn *iter, bool async_iter, double flags, double hwm);
/* Readable.from over a class iterator: the compiler opens it and passes a
 * checked-dynamic { next } object over it (borrowed), with SCR_FROM_*
 * flags. +1, or NULL with ERR_INVALID_ARG_VALUE pending. */
ScrStream *scr_stream_from_iter(ScrDyn *iter, double flags, double hwm);
ScrStream *scr_stream_from_async_iter(ScrDyn *iter, double flags, double hwm);
/* One checked-dynamic value into a Readable.from stream: a whole entry in
 * object mode, a chunk in byte mode. null, values other than strings and
 * Buffers in object mode, and byte mode's chunk errors destroy the stream
 * and answer -1; otherwise push()'s answer. Borrows v. */
int scr_stream_from_push(ScrStream *s, const ScrDyn *v);
/* The from.js stream around native read/destroy callbacks (moved), with
 * SCR_FROM_* option flags: +1, or NULL with ERR_INVALID_ARG_VALUE
 * pending for a bad highWaterMark. */
ScrStream *scr_stream_new_from_readable(ScrClosure *read, ScrStreamReadInv read_inv,
                                        ScrClosure *destroy, ScrStreamErrInv destroy_inv,
                                        double flags, double hwm);
struct ScrGen;
/* Readable.from over a compiled generator (scr_stream_ops.c). The
 * compiler's helpers (borrowed) take the generator: next/ret answer the
 * next value or the done marker (scr_stream_from_done) and thr takes the
 * error as a checked-dynamic value; for an async generator they answer
 * the resume's promise and `read` turns its IteratorResult into the value
 * or the marker. g borrowed; +1, or NULL with the error pending. */
ScrStream *scr_stream_from_gen(struct ScrGen *g, ScrClosure *next, ScrClosure *ret, ScrClosure *thr,
                               double flags, double hwm);
ScrStream *scr_stream_from_async_gen(struct ScrGen *g, ScrClosure *next, ScrClosure *read,
                                     ScrClosure *ret, ScrClosure *thr, double flags,
                                     double hwm);
ScrDyn *scr_stream_from_done(void); /* +1, the process-lived marker (scr_stream.c) */
ScrStream *scr_stream_pause(ScrStream *s);            /* recv +1 */
ScrStream *scr_stream_resume(ScrStream *s);           /* recv +1 */
bool scr_stream_is_paused(ScrStream *s);
double scr_stream_flowing(ScrStream *s); /* -1 = null, 0 = false, 1 = true */
ScrStream *scr_stream_pipe(ScrStream *src, ScrStream *dst, bool end); /* dst +1 */
ScrStream *scr_stream_unpipe(ScrStream *src, ScrStream *dst /*NULL = all*/); /* recv +1 */

/* The writable surface. write borrows its chunk; cb (when non-NULL)
 * MOVES and fires after the chunk's user write completes. */
bool scr_stream_write(ScrStream *s, ScrBytes *chunk, ScrClosure *cb /*moves*/);
bool scr_stream_write_str(ScrStream *s, ScrStr *str, ScrClosure *cb /*moves*/);
bool scr_stream_write_null(ScrStream *s); /* throws ERR_STREAM_NULL_VALUES */
ScrStream *scr_stream_end(ScrStream *s, ScrBytes *chunk_b, ScrStr *chunk_s,
                           ScrClosure *cb /*moves*/); /* recv +1 */
void scr_stream_cork(ScrStream *s);
void scr_stream_uncork(ScrStream *s);

/* Shared lifecycle. destroy's err is BORROWED (may be NULL). */
ScrStream *scr_stream_destroy(ScrStream *s, ScrError *err); /* recv +1 */
/* Readable async-iterator return(): destroy with Node's AbortError payload;
 * the iterator's internal error consumer suppresses an unhandled crash when
 * no user error listener exists. Receiver +1. */
ScrStream *scr_stream_iterator_close(ScrStream *s);
/* stream.addAbortSignal(signal, s) and the constructors' signal option
 * (from_option: a falsy signal is ignored). Borrows; answers s +1, or
 * NULL with ERR_INVALID_ARG_TYPE pending. */
ScrStream *scr_stream_add_abort_signal(ScrStream *s, ScrDyn *signal, bool from_option,
                                       ScrAbortAddFn add);
/* Object-mode streams for the stream operators: Readable.from's stream
 * (highWaterMark 1) around native callbacks (+1; callbacks move), and its
 * push: whole string or Buffer entries, the first push fixing the kind.
 * Answers push()'s result, -1 for another kind of value, -2 for a kind
 * that differs from the first push's. */
ScrStream *scr_stream_new_object_readable(ScrClosure *read, ScrStreamReadInv read_inv,
                                          ScrClosure *destroy, ScrStreamErrInv destroy_inv);
int scr_stream_push_object(ScrStream *s, const ScrDyn *v);
/* The Readable operators (scr_stream_ops.c, the streamOps feature): the
 * callbacks, counts and options are checked-dynamic values (borrowed).
 * The stream-returning ones answer the +1 object-mode output stream, or
 * NULL with Node's validation error pending; the promise-returning ones
 * answer a +1 promise and reject instead of throwing. toArray settles a
 * dyn array, find and reduce a dyn value — reduce's `kind` picks the
 * payload instead: 0 dyn, 1 number, 2 boolean, 3 string — some and every
 * a boolean, forEach nothing. */
ScrStream *scr_stream_op_map(ScrStream *s, ScrDyn *fn, ScrDyn *options);
ScrStream *scr_stream_op_filter(ScrStream *s, ScrDyn *fn, ScrDyn *options);
ScrStream *scr_stream_op_flat_map(ScrStream *s, ScrDyn *fn, ScrDyn *options);
ScrStream *scr_stream_op_drop(ScrStream *s, ScrDyn *number, ScrDyn *options);
ScrStream *scr_stream_op_take(ScrStream *s, ScrDyn *number, ScrDyn *options);
ScrPromise *scr_stream_op_to_array(ScrStream *s, ScrDyn *options);
ScrPromise *scr_stream_op_for_each(ScrStream *s, ScrDyn *fn, ScrDyn *options);
ScrPromise *scr_stream_op_some(ScrStream *s, ScrDyn *fn, ScrDyn *options);
ScrPromise *scr_stream_op_every(ScrStream *s, ScrDyn *fn, ScrDyn *options);
ScrPromise *scr_stream_op_find(ScrStream *s, ScrDyn *fn, ScrDyn *options);
ScrPromise *scr_stream_op_reduce(ScrStream *s, ScrDyn *fn, ScrDyn *init, bool has_init,
                                 ScrDyn *options, double kind);
/* finished(s, options[, cb]) — Node's eos with its listeners and state
 * predicates: readable/writable are -1 (the default), 0 or 1; on_error is
 * options.error !== false; signal is NULL or borrowed (ERR_INVALID_ARG_TYPE
 * pending and NULL answered for a non-signal). The callback forms answer
 * the +1 cleanup closure (cb moves; the typed form takes its invoke
 * adapter); the promise form rejects instead of throwing. */
ScrClosure *scr_stream_finished_opts(ScrStream *s, ScrClosure *cb, ScrStreamErrInv inv,
                                     double readable, double writable, bool on_error,
                                     ScrDyn *signal, ScrAbortAddFn add);
ScrClosure *scr_stream_finished_opts_dyn(ScrStream *s, ScrDyn *cb, double readable,
                                         double writable, bool on_error, ScrDyn *signal,
                                         ScrAbortAddFn add);
ScrPromise *scr_sp_finished_opts(ScrStream *s, double readable, double writable, bool on_error,
                                 bool cleanup, ScrDyn *signal, ScrAbortAddFn add);
/* stream/promises pipeline(...streams, { signal, end }): end false leaves
 * the destination open; a non-signal value rejects with
 * ERR_INVALID_ARG_TYPE. Streams borrowed. */
ScrPromise *scr_sp_pipeline_opts(double n, ScrStream **streams, bool end, ScrDyn *signal,
                                 ScrAbortAddFn add);
double scr_stream_prop(ScrStream *s, const char *name);
ScrError *scr_stream_errored(ScrStream *s); /* +1 or NULL */

/* The underscore-method assignment surface (`r._read = fn` after
 * construction — Node's own-property shadow of the prototype method):
 * the option-callback slot swaps its closure (+1 moves in, the old one
 * releases) and its compiler-emitted invoke thunk; the next dispatch
 * uses the new callback, Node's timing. */
void scr_stream_set_read(ScrStream *s, ScrClosure *cb, ScrStreamReadInv inv);
void scr_stream_set_write(ScrStream *s, ScrClosure *cb, ScrStreamChunkInv inv);
void scr_stream_set_final(ScrStream *s, ScrClosure *cb, ScrStreamPlainInv inv);
void scr_stream_set_destroy(ScrStream *s, ScrClosure *cb, ScrStreamErrInv inv);
void scr_stream_set_transform(ScrStream *s, ScrClosure *cb, ScrStreamChunkInv inv);
void scr_stream_set_flush(ScrStream *s, ScrClosure *cb, ScrStreamPlainInv inv);
/* Runtime-built Transforms (scr_zlib_stream.c): the flush starts at
 * 'prefinish' and 'finish' does not wait for it (a _final that completes
 * at once). set_native moves one reference to the stream's own state,
 * released when the stream is freed; scr_stream_native answers it
 * (borrowed) when it was set with `release`, else NULL. */
void scr_stream_set_flush_on_prefinish(ScrStream *s);
void scr_stream_set_native(ScrStream *s, void *state, void (*release)(void *));
void *scr_stream_native(ScrStream *s, void (*release)(void *));

/* Completion entries for the compiler-emitted done closures (err/data
 * MOVE; NULLs = absent). */
void scr_stream_write_done(ScrStream *s, ScrError *err);
void scr_stream_final_done(ScrStream *s, ScrError *err);
void scr_stream_destroy_done(ScrStream *s, ScrError *err);
void scr_stream_transform_done(ScrStream *s, ScrError *err, ScrBytes *data, ScrStr *data_str);
void scr_stream_flush_done(ScrStream *s, ScrError *err, ScrBytes *data, ScrStr *data_str);

/* Runtime-backed streams (the fs streams in scr_fs_stream.c).
 * - construct: Node's _construct. The hook runs on a tick after
 *   construction; until construct_done's tick, reads, buffered writes,
 *   the finish path and _destroy wait. cb moves; done's err moves.
 * - set_writev_concat: Node's _writev. More than one buffered chunk is
 *   written as one chunk holding their concatenation.
 * - native_ops: the extra operations of a stream's native state (set with
 *   scr_stream_set_native above). */
void scr_stream_construct(ScrStream *s, ScrClosure *cb, ScrStreamPlainInv inv);
void scr_stream_construct_done(ScrStream *s, ScrError *err);
void scr_stream_set_writev_concat(ScrStream *s);
/* The native state's extra operations: view adds its members to the
 * stream's untyped view and close is the view's close() (both NULL when
 * absent); aggregate builds aggregateTwoErrors' +1 AggregateError from the
 * construct and destroy errors (NULL: the destroy error is used). */
typedef struct ScrStreamNativeOps {
  void (*view)(ScrStream *s, ScrDyn *view);
  void (*close)(ScrStream *s);
  ScrError *(*aggregate)(ScrError *inner, ScrError *outer);
} ScrStreamNativeOps;
void scr_stream_set_native_ops(ScrStream *s, const ScrStreamNativeOps *ops);
/* errorOrDestroy (err borrowed), and fs.WriteStream.close(cb) (cb moves,
 * NULL = absent). */
void scr_stream_fail(ScrStream *s, ScrError *err);
void scr_stream_close_writable(ScrStream *s, ScrClosure *cb);
/* fs.ReadStream / fs.WriteStream (scr_fs_stream.c, linked with this
 * unit). The constructors take the path and options values (borrowed)
 * and answer +1 or NULL with the exception pending. bytes is bytesRead or
 * bytesWritten; path_value is +1 (undefined for the fd form); close_cb
 * borrows its callback. */
ScrStream *scr_fs_read_stream_new(ScrDyn *path, ScrDyn *options);
ScrStream *scr_fs_write_stream_new(ScrDyn *path, ScrDyn *options);
double scr_fs_stream_bytes(ScrStream *s);
bool scr_fs_stream_pending(ScrStream *s);
ScrDyn *scr_fs_stream_path_value(ScrStream *s);
ScrDyn *scr_fs_stream_prop_dyn(ScrStream *s, ScrStr *name); /* untyped reads, +1 */
/* A stream over a descriptor its owner holds (FileHandle.createReadStream
 * / createWriteStream, scr_fs_stream_fh.c): detach answers the descriptor
 * to close when the stream closes (-1 while the owner keeps it); release
 * runs when the stream is freed. owner moves; options borrowed. */
typedef struct ScrFsStreamOwnerOps {
  int (*detach)(void *owner);
  void (*release)(void *owner);
} ScrFsStreamOwnerOps;
ScrStream *scr_fs_stream_new_owned(ScrDyn *options, bool readable, int fd, void *owner,
                                   const ScrFsStreamOwnerOps *ops);
void scr_fs_stream_close(ScrStream *s);
void scr_fs_stream_close_cb(ScrStream *s, ScrClosure *cb);

/* RC / trace / install (the emitter-unit shapes). */
ScrStream *scr_stream_retain(ScrStream *s);
void scr_stream_release(ScrStream *s);
void *scr_stream_retain_v(void *s);
void scr_stream_release_v(void *s);
void scr_stream_trace(void *obj, ScrTraceVisit visit, void *ctx);
void scr_stream_install(void);

/* The loop's stream hook (scr_async.c): `pending` keeps the loop alive
 * while deferred ticks exist; `dispatch` drains them at every turn top —
 * the FIRST station (nextTick-most). Stream-free builds keep both NULL
 * and the loop is byte-identical. */
void scr_loop_set_stream(bool (*pending)(void), void (*dispatch)(void));
void scr_union_trace_v(void *u, ScrTraceVisit visit, void *ctx);
void scr_promise_trace_v(void *p, ScrTraceVisit visit, void *ctx);

#endif /* SCR_STREAM_H */
