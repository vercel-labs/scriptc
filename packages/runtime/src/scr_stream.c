/* node:stream — the runtime-provided stream classes behind the
 * options-object constructor forms (`new Readable({ read() {} })` et al).
 * This translation unit links ONLY into binaries whose IR touches the
 * stream surface (moduleUsesStream — the scr_events_emitter.c gating
 * precedent); stream-free binaries keep their exact link line.
 *
 * ONE layout for all five classes (ScrStream: the ScrEmitter prefix plus
 * a state block), so upcasts among them and to ScrEmitter are pointer
 * reinterprets. Events dispatch through the embedded emitter registry —
 * scr_emitter_emit's variadic core — with the frontend's PER-BASE forced
 * tuples guaranteeing every 'data' listener reads one ScrBytes*, every
 * 'pipe'/'unpipe' listener one ScrStream*, and the lifecycle events
 * nothing.
 *
 * EVENT TIMING. Node schedules most stream emissions on process.nextTick;
 * here each deferral enqueues on the stream tick FIFO AND posts a raw
 * marker on the USER nextTick queue (scr_next_tick_raw), so stream
 * emissions and user nextTicks run in true FIFO enqueue order — Node's,
 * where they are the same queue. The scr_loop_set_stream station remains
 * as the drain of anything a marker never reached (and the uncaught-throw
 * cleanup). The implemented orderings follow lib/internal/streams:
 *   - on('data') starts flowing on a TICK (resume_): synchronous code
 *     after the registration runs before the first 'data'.
 *   - push() while flowing with an empty buffer emits 'data'
 *     SYNCHRONOUSLY (addChunk's direct-emit fast path).
 *   - 'readable' is emitted on a tick (emitReadable_), collapsed while
 *     one is already scheduled (emittedReadable).
 *   - push(null) → 'end' fires on a tick once the buffer drains, then
 *     autoDestroy (default) destroys and 'close' follows on the NEXT
 *     tick.
 *   - write() calls the user write synchronously; a SYNCHRONOUS
 *     completion defers afterWrite (the user cb + 'drain') to a tick
 *     (Node's onwrite sync guard), an async completion runs it directly.
 *   - end() → (buffer drains) → _final → 'prefinish' (sync) → 'finish'
 *     on a tick → autoDestroy → 'close' on the next tick.
 *   - destroy(err) calls _destroy synchronously; 'error' then 'close'
 *     fire on ticks (error first, close after — Node's order).
 * An unhandled 'error' event throws its payload through the exception
 * cell (scr_emitter_emit_error) — the loop's dispatch surfaces it as the
 * uncaught crash, Node's contract.
 *
 * DOCUMENTED DIVERGENCES (SEMANTICS.md, the stream block): tick-vs-
 * microtask interleaving (Node runs nextTick callbacks before promise
 * jobs; this queue drains after the fiber ready-queue), pipe() without
 * registry-visible listeners (listenerCount('data') does not count the
 * C-side pipe hookup), and Transform completing writes without read-side
 * backpressure. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Node v24's stream default (lib/internal/streams/state.js — 64 KiB
 * since nodejs/node#52037, EXCEPT win32, where the very same line keeps
 * the old 16 KiB: `process.platform === 'win32' ? 16 * 1024 : 64 * 1024`.
 * The triple decides at compile time, like the path/EOL bindings). */
#ifdef _WIN32
#define SCR_STREAM_DEFAULT_HWM 16384
#else
#define SCR_STREAM_DEFAULT_HWM 65536
#endif

static void scr_stream_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* Byte chunks the stream creates (from string chunks, Buffer.from(chunk,
 * encoding), or the concatenation read(n) returns, Buffer.concat) are
 * Buffers in Node, so user code that receives them sees a Buffer. Takes
 * fresh storage the stream owns; returns it. */
static ScrBytes *scr_stream_buffer(ScrBytes *b) {
  b->is_buffer = true;
  b->is_data_view = false;
  return b;
}

/* ── state ────────────────────────────────────────────────────────────── */

typedef struct ScrWEntry {
  ScrBytes *chunk; /* owned; a ScrDyn* value on an object-mode writable side */
  ScrClosure *cb;  /* owned or NULL (the user's write(chunk, cb) callback) */
  ScrDyn *enc;     /* owned or NULL = undefined: the encoding argument an
                    * object-mode write passed (Node hands it to _write
                    * unchanged; null when the callback took its place) */
} ScrWEntry;

struct ScrStreamState {
  bool has_r, has_w;
  bool passthrough;  /* identity transform (PassThrough) */
  bool is_transform; /* the writable side routes through transform/flush */
  bool allow_half_open;
  bool auto_destroy, emit_close;
  /* Duplex.from of a pipeline() argument that is not a stream: the
   * pipeline takes it as that stage's stream without wiring the stage
   * (scr_stream_unbox_dyn_stage) */
  bool pipeline_body;

  /* shared lifecycle */
  bool destroyed, destroy_calling, error_emitted, close_emitted, error_scheduled, close_scheduled;
  /* a parked for-await consumed the error as its rejection: the 'error'
   * EVENT is suppressed unless a user listener exists (Node's iterator
   * registers its own handler, so no unhandled-'error' crash occurs) */
  bool next_err_consumed;
  ScrError *errored; /* owned */

  /* readable side. The buffer holds owned ScrBytes* chunks — or, once an
   * encoding is set (setEncoding / the encoding option), owned ScrStr*
   * entries: pushes decode through the StringDecoder machinery, lengths
   * count JS string units (Node's encoded accounting), and head_off
   * counts CHARS consumed of buf[0] instead of bytes. */
  struct {
    size_t hwm, length;
    void **buf; /* queue of owned chunks; buf[0] read from head_off */
    size_t n, cap, head_off;
    int flowing; /* -1 null, 0 paused, 1 flowing */
    bool reading, in_read_sync, ended, end_emitted, end_scheduled;
    bool in_read_call; /* inside the user's _read (in_read_sync also starts true) */
    bool need_readable, emitted_readable, readable_listening;
    /* the stream has 'data' listeners: kept by scr_stream_listener_observe
     * from the registry's empty/nonempty transitions, so the per-chunk
     * paths read it instead of looking the name up */
    bool data_listeners;
    bool resume_scheduled, maybe_more_scheduled;
    /* The buffer's representation: encoded means every entry is a ScrStr,
     * otherwise every entry is a ScrBytes (scr_stream_rbuf_push checks
     * it). decoding: setEncoding() installed a decoder, so Buffer entries
     * decode on the way in; a string object stream without one
     * (Readable.from over strings) holds strings but decodes nothing. */
    bool encoded;
    bool decoding;
    ScrStr *enc;        /* owned canonical encoding name, or NULL */
    double dec_pending; /* scr_strdec packed pending state */
    /* The defaultEncoding option's push-side effect: how push(string)
     * DECODES string chunks into bytes (Node's Buffer.from(chunk,
     * state.defaultEncoding)). Owned canonical name; NULL = utf8. */
    ScrStr *push_enc;
    /* Readable.from mode: entries are whole OBJECTS (each counts 1
     * toward length/hwm and delivers undivided — Node's objectMode
     * accounting for the from() surface; hwm is 1). */
    bool object_entries;
    /* An operator output's entry kind is decided by its first push. */
    bool object_kind_set;
    /* An object-mode buffer that holds a value other than a string or a
     * Buffer, or both kinds: every entry is an owned ScrDyn*
     * (scr_stream_add_value). Takes precedence over `encoded`. */
    bool dyn_entries;
    /* The objectMode or readableObjectMode option made the buffer hold
     * object entries (a stream without _read is not a seeded
     * Readable.from source). */
    bool object_mode_opt;
    /* The parked for-await next() promise (at most one — the loop awaits
     * each chunk before asking again). next_dyn picks the resolution
     * shape: a dyn boxed by tag (the JS lane), or bytes; next_result
     * wraps the dyn in an iterator result ({ value, done }) for the
     * checked-dynamic for-await protocol. */
    ScrPromise *next_waiter;
    bool next_dyn;
    bool next_result;
    /* The iterator's own read() is calling _read: synchronous pushes
     * buffer, and the waiter takes the whole buffer afterwards (Node's
     * read() returns everything _read pushed). */
    bool next_reading;
    /* The waiter parked after its own read found nothing: data pushed
     * later reaches it through Node's iterator path, the 'readable'
     * nextTick and then the resumed `await new Promise(next)`
     * (next_wake: that tick is queued). */
    bool next_parked, next_wake;
    /* Node's iterator ends through eos, which waits for 'close' when the
     * stream will emit it (willEmitClose, fixed when the iterator starts:
     * a readable-only stream with autoDestroy and emitClose, not yet
     * closed). next_eof_close: the ended waiter is held for 'close'. */
    bool next_started, next_close_wait, next_eof_close;
    ScrClosure *read_cb;
    ScrStreamReadInv read_inv;
  } r;

  /* writable side */
  struct {
    size_t hwm, length, inflight_len;
    ScrWEntry *q;
    size_t n, cap, head;
    int corked;
    bool writing, wsync, need_drain, after_scheduled;
    /* the queued SCR_ST_AFTER_WRITE tick later synchronous writes with
     * the same callback join (Node's afterWriteTickInfo), or NULL */
    struct ScrStreamTick *after_tick;
    /* Deferred afterWrites Node also defers (a user callback, a 'drain'
     * or a destroyed stream): its pendingcb, which holds the finish until
     * they ran — afterWrite's finishMaybe then puts 'finish' on a tick
     * of its own. */
    size_t after_holds;
    /* clearBuffer is running its loop: a write completing inside it
     * leaves the next buffered write to the loop (Node's
     * kBufferProcessing), so completions keep their order */
    bool buffer_processing;
    /* objectMode writable side: queued chunks, and the chunk the write
     * and transform steps receive, are ScrDyn* values (in the ScrBytes*
     * slots), each counting 1 toward length. */
    bool object_mode;
    /* The queue holds ScrDyn* values: on an object-mode side, and with
     * decodeStrings: false, where strings stay strings (their UTF-16
     * length counts) and Buffers are buffer values. Each entry's encoding
     * argument rides in ScrWEntry.enc. */
    bool values, decode_strings_off;
    /* The defaultEncoding option or setDefaultEncoding(), as given; NULL
     * is utf8. What write(string) encodes with, and the encoding _write
     * receives for a string when decodeStrings is false. */
    ScrStr *default_enc;
    /* _writev: more than one buffered write reaches it as one batch, and a
     * stream without _write sends each write through it. */
    ScrClosure *writev_cb;
    ScrStreamWritevInv writev_inv;
    bool ending, finished, prefinished, final_called, finish_scheduled;
    bool final_pending; /* _final called, its callback not yet run */
    ScrClosure *inflight_cb; /* owned or NULL */
    ScrDyn *cur_enc;         /* borrowed: the running write's encoding argument */
    ScrClosure *write_cb;
    ScrStreamChunkInv write_inv;
    ScrClosure *final_cb;
    ScrStreamPlainInv final_inv;
    ScrClosure **end_cbs; /* owned end(cb) callbacks, fired at 'finish' */
    size_t end_cbs_n, end_cbs_cap;
  } w;

  /* transform */
  ScrClosure *transform_cb;
  ScrStreamChunkInv transform_inv;
  ScrClosure *flush_cb;
  ScrStreamPlainInv flush_inv;
  bool flush_called;
  bool flush_pending; /* _flush called, its callback not yet run */
  /* Transform._write's backpressure: the readable length when the
   * transform started, and whether its completed write waits for the
   * readable side to read (Node's kCallback). */
  size_t xf_length;
  bool xf_held;
  /* A _final that completes at once (zlib's ZlibBase): 'prefinish' starts
   * the flush and 'finish' does not wait for it. */
  bool flush_on_prefinish;
  /* A runtime-built stream's own state (scr_zlib_stream.c): one owned
   * reference, kept past 'close' until the stream is freed. The release
   * function doubles as the state's type tag. */
  void *native;
  void (*native_release)(void *);

  /* destroy */
  ScrClosure *destroy_cb;
  ScrStreamErrInv destroy_inv;

  /* The completion closures (`callback`) the emitted option-callback
   * thunks pass, owned. write_done is the one every write and writev call
   * receives (scr_stream_write_closure); done_cache is the last one a
   * transform, flush, final, construct or destroy call received, handed
   * out again while this is its only reference (scr_stream_done_closure).
   * Both hold the stream, so they are dropped at 'close' and traced for a
   * stream dropped before it closes. */
  ScrClosure *write_done;
  ScrClosure *done_cache;

  /* finished()/pipeline() watchers: fired once at the terminal point
   * (the 'close' tick — or a registration-time tick when already closed)
   * with the stream's finish status (NULL / the error / premature close).
   * A watcher's presence marks lifecycle errors HANDLED (Node's eos and
   * pipeline both register 'error' listeners, so no unhandled crash). */
  struct {
    ScrClosure **cb;
    ScrStreamErrInv *inv;
    size_t n, cap;
  } fin;

  /* pipes (src side): owned destination refs */
  struct {
    ScrStream **dst;
    bool *end;
    size_t n, cap;
  } pipes;
  size_t await_drain; /* pipe destinations we are waiting on */

  /* pipe sources awaiting THIS stream's drain (dst side): owned refs */
  struct {
    ScrStream **src;
    size_t n, cap;
  } drain_srcs;
  /* Deferred construction (Node's _construct, used by the fs streams):
   * until construct_done's tick runs, reads, buffered writes, the finish
   * path and _destroy wait. A destroy() in that window marks the stream
   * destroyed and runs its _destroy once construction completes. */
  bool constructing, destroy_deferred;
  bool construct_finished; /* onConstruct ran: a second callback is ERR_MULTIPLE_CALLBACK */
  bool construct_called;   /* the construct tick called the hook */
  ScrError *destroy_err; /* owned: the deferred destroy's error */
  ScrClosure *construct_cb;
  ScrStreamPlainInv construct_inv;
  /* _writev (the fs WriteStream): more than one buffered chunk flushes
   * as one write of their concatenation, whose completion runs every
   * buffered callback in order. */
  bool writev_concat;
  /* the native state's extra operations (the fs streams), or NULL */
  const ScrStreamNativeOps *native_ops;
};

/* ── vtables and RC ───────────────────────────────────────────────────── */

/* The five runtime vtables start with the EMPTY preorder interval
 * (pre 1 > post 0): main() stamps the real interval exactly when the
 * class def rides the module, and an unstamped vt must never claim a
 * user class whose preorder number happens to collide (scr_stream_is
 * below tests interval membership for compiler-emitted subclasses). */
static void scr_stream_release_direct(void *obj);
SCR_TL ScrVt scr_readable_vt = {1, 0, &scr_stream_release_direct};
SCR_TL ScrVt scr_writable_vt = {1, 0, &scr_stream_release_direct};
SCR_TL ScrVt scr_duplex_vt = {1, 0, &scr_stream_release_direct};
SCR_TL ScrVt scr_transform_vt = {1, 0, &scr_stream_release_direct};
SCR_TL ScrVt scr_passthrough_vt = {1, 0, &scr_stream_release_direct};

static bool scr_vt_within(const ScrVt *vt, const ScrVt *cls) {
  return cls->pre <= vt->pre && vt->pre <= cls->post;
}

/* True for the five runtime classes AND compiler-emitted user subclasses
 * (their structs embed the full ScrStream prefix, and their vtable's
 * preorder number sits inside a stream class's stamped interval — the
 * instanceof machinery). Duplex/Transform/PassThrough intervals nest
 * inside Readable's, so two tests cover the forest. */
static bool scr_stream_is(const ScrEmitter *em) {
  const ScrVt *vt = em->vt;
  if (vt == &scr_readable_vt || vt == &scr_writable_vt || vt == &scr_duplex_vt ||
      vt == &scr_transform_vt || vt == &scr_passthrough_vt) {
    return true;
  }
  return scr_vt_within(vt, &scr_readable_vt) || scr_vt_within(vt, &scr_writable_vt) ||
         scr_vt_within(vt, &scr_duplex_vt) || scr_vt_within(vt, &scr_transform_vt) ||
         scr_vt_within(vt, &scr_passthrough_vt);
}

/* Readable-buffer entry accessors: bytes chunks, strings once an
 * encoding is set (lengths then count JS string units, Node's encoded
 * accounting), or checked-dynamic values in an object-mode buffer that
 * holds other values. */
typedef enum { SCR_ENTRY_BYTES, SCR_ENTRY_STR, SCR_ENTRY_DYN } ScrEntryKind;

static ScrEntryKind scr_stream_rkind(const ScrStreamState *st) {
  return st->r.dyn_entries ? SCR_ENTRY_DYN : st->r.encoded ? SCR_ENTRY_STR : SCR_ENTRY_BYTES;
}

static size_t scr_stream_entry_len(const ScrStreamState *st, void *e) {
  if (st->r.object_entries) return 1; /* objectMode-style accounting */
  return st->r.encoded ? (size_t)scr_str_utf16_len((ScrStr *)e) : ((ScrBytes *)e)->len;
}

/* Releases an entry by the kind it had when it left the buffer: a 'data'
 * listener may call setEncoding() or push another kind of value while the
 * entry is out. */
static void scr_stream_entry_release_kind(void *e, ScrEntryKind kind) {
  if (kind == SCR_ENTRY_DYN) scr_dyn_release((ScrDyn *)e);
  else if (kind == SCR_ENTRY_STR) scr_str_release((ScrStr *)e);
  else scr_bytes_release((ScrBytes *)e);
}

static void scr_stream_entry_release(const ScrStreamState *st, void *e) {
  scr_stream_entry_release_kind(e, scr_stream_rkind(st));
}

/* An entry of the given kind as a dyn value (+1; moves entry). */
static ScrDyn *scr_stream_entry_box(void *entry, ScrEntryKind kind) {
  if (kind == SCR_ENTRY_DYN) return entry;
  ScrDyn *d;
  if (kind == SCR_ENTRY_STR) {
    d = scr_dyn_new_str((ScrStr *)entry);
    scr_str_release((ScrStr *)entry);
  } else {
    ScrBytes *b = entry;
    d = b->is_buffer ? scr_dyn_new_buffer(b) : scr_dyn_new_bytes(b);
    scr_bytes_release(b);
  }
  return d;
}

/* Writable-queue chunks: Buffers, or dyn values (w.values). A value
 * counts 1 on an object-mode side, else its length (a string's UTF-16
 * length, as Node's chunk.length). */
static size_t scr_stream_wchunk_len(const ScrStreamState *st, ScrBytes *chunk) {
  if (st->w.object_mode) return 1;
  if (!st->w.values) return chunk->len;
  ScrDyn *v = (ScrDyn *)chunk;
  if (v->kind == SCR_DYN_STR) return (size_t)scr_str_utf16_len(v->v.str);
  if (v->kind == SCR_DYN_BYTES) return v->v.bytes->len;
  return 1;
}

static ScrBytes *scr_stream_wchunk_retain(const ScrStreamState *st, ScrBytes *chunk) {
  if (st->w.values) return (ScrBytes *)scr_dyn_retain((ScrDyn *)chunk);
  return scr_bytes_retain(chunk);
}

static void scr_stream_wchunk_release(const ScrStreamState *st, ScrBytes *chunk) {
  if (st->w.values) scr_dyn_release((ScrDyn *)chunk);
  else scr_bytes_release(chunk);
}

/* A dyn entry the collector traces, and so frees itself in a collection
 * (the kinds that carry a collector header). */
static bool scr_stream_dyn_entry_traced(const ScrDyn *d) {
  return d->kind > SCR_DYN_STR && d->kind != SCR_DYN_UNDEF;
}

static void scr_stream_state_drop(ScrStreamState *st, bool gc) {
  if (!st) return;
  if (st->errored) scr_error_release(st->errored);
  if (st->native) st->native_release(st->native);
  for (size_t i = 0; i < st->r.n; i++) {
    /* The collector frees the dyn entries it traced. */
    if (gc && st->r.dyn_entries && scr_stream_dyn_entry_traced(st->r.buf[i])) continue;
    scr_stream_entry_release(st, st->r.buf[i]);
  }
  free(st->r.buf);
  if (st->r.enc) scr_str_release(st->r.enc);
  if (st->r.push_enc) scr_str_release(st->r.push_enc);
  if (!gc && st->r.next_waiter) scr_promise_release(st->r.next_waiter);
  if (st->destroy_err) scr_error_release(st->destroy_err);
  if (!gc) {
    if (st->construct_cb) scr_closure_release(st->construct_cb);
    if (st->w.writev_cb) scr_closure_release(st->w.writev_cb);
    if (st->r.read_cb) scr_closure_release(st->r.read_cb);
    if (st->w.write_cb) scr_closure_release(st->w.write_cb);
    if (st->w.final_cb) scr_closure_release(st->w.final_cb);
    if (st->w.inflight_cb) scr_closure_release(st->w.inflight_cb);
    if (st->transform_cb) scr_closure_release(st->transform_cb);
    if (st->flush_cb) scr_closure_release(st->flush_cb);
    if (st->destroy_cb) scr_closure_release(st->destroy_cb);
    if (st->write_done) scr_closure_release(st->write_done);
    if (st->done_cache) scr_closure_release(st->done_cache);
    for (size_t i = 0; i < st->w.end_cbs_n; i++) scr_closure_release(st->w.end_cbs[i]);
    for (size_t i = 0; i < st->fin.n; i++) scr_closure_release(st->fin.cb[i]);
    for (size_t i = 0; i < st->pipes.n; i++) scr_stream_release(st->pipes.dst[i]);
    for (size_t i = 0; i < st->drain_srcs.n; i++) scr_stream_release(st->drain_srcs.src[i]);
  }
  for (size_t i = st->w.head; i < st->w.n; i++) {
    bool traced = st->w.values && scr_stream_dyn_entry_traced((ScrDyn *)st->w.q[i].chunk);
    if (!gc || !traced) scr_stream_wchunk_release(st, st->w.q[i].chunk);
    if (!gc && st->w.q[i].cb) scr_closure_release(st->w.q[i].cb);
    ScrDyn *enc = st->w.q[i].enc;
    if (enc && (!gc || !scr_stream_dyn_entry_traced(enc))) scr_dyn_release(enc);
  }
  free(st->w.q);
  if (st->w.default_enc) scr_str_release(st->w.default_enc);
  free(st->w.end_cbs);
  free(st->fin.cb);
  free(st->fin.inv);
  free(st->pipes.dst);
  free(st->pipes.end);
  free(st->drain_srcs.src);
  free(st);
}

/* The compiler-emitted subclass RC/trace entry points: a user `extends
 * Readable` struct embeds the ScrStream prefix (vt, registry, display
 * name, state pointer), so its emitted teardown/trace delegate the STATE
 * here (the registry rides scr_emitter_reg_* like any emitter subclass).
 * NULL-safe: an exception before super(options) leaves st unset. */
void scr_stream_st_release(ScrStreamState *st) { scr_stream_state_drop(st, false); }
void scr_stream_st_gcfree(ScrStreamState *st) { scr_stream_state_drop(st, true); }

void scr_stream_st_trace(ScrStreamState *st, ScrTraceVisit visit, void *ctx) {
  if (!st) return;
  if (st->r.dyn_entries) {
    for (size_t i = 0; i < st->r.n; i++) {
      if (scr_stream_dyn_entry_traced(st->r.buf[i])) visit(st->r.buf[i], ctx);
    }
  }
  if (st->r.next_waiter) visit(st->r.next_waiter, ctx);
  if (st->r.read_cb) visit(st->r.read_cb, ctx);
  if (st->construct_cb) visit(st->construct_cb, ctx);
  if (st->w.write_cb) visit(st->w.write_cb, ctx);
  if (st->w.final_cb) visit(st->w.final_cb, ctx);
  if (st->w.writev_cb) visit(st->w.writev_cb, ctx);
  if (st->w.inflight_cb) visit(st->w.inflight_cb, ctx);
  if (st->transform_cb) visit(st->transform_cb, ctx);
  if (st->flush_cb) visit(st->flush_cb, ctx);
  if (st->destroy_cb) visit(st->destroy_cb, ctx);
  if (st->write_done) visit(st->write_done, ctx);
  if (st->done_cache) visit(st->done_cache, ctx);
  for (size_t i = 0; i < st->w.end_cbs_n; i++) visit(st->w.end_cbs[i], ctx);
  for (size_t i = 0; i < st->fin.n; i++) visit(st->fin.cb[i], ctx);
  for (size_t i = st->w.head; i < st->w.n; i++) {
    if (st->w.q[i].cb) visit(st->w.q[i].cb, ctx);
    if (st->w.values && scr_stream_dyn_entry_traced((ScrDyn *)st->w.q[i].chunk))
      visit(st->w.q[i].chunk, ctx);
    if (st->w.q[i].enc && scr_stream_dyn_entry_traced(st->w.q[i].enc)) visit(st->w.q[i].enc, ctx);
  }
  for (size_t i = 0; i < st->pipes.n; i++) visit(st->pipes.dst[i], ctx);
  for (size_t i = 0; i < st->drain_srcs.n; i++) visit(st->drain_srcs.src[i], ctx);
}

void scr_stream_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  ScrStream *s = obj;
  scr_emitter_reg_trace(s->reg, visit, ctx);
  scr_stream_st_trace(s->st, visit, ctx);
}

static void scr_stream_gcfree(void *obj) {
  ScrStream *s = obj;
  scr_emitter_reg_gcfree(s->reg);
  scr_stream_state_drop(s->st, true);
  scr_obj_free_note();
  scr_cyc_free(obj);
}

static void scr_stream_release_direct(void *obj) {
  ScrStream *s = obj;
  if (--s->rc == 0) {
    scr_cyc_dead(s);
    scr_emitter_reg_drop(s->reg);
    scr_stream_state_drop(s->st, false);
    scr_obj_free_note();
    scr_cyc_free(s);
  } else {
    scr_cyc_released(s);
  }
}

ScrStream *scr_stream_retain(ScrStream *s) {
  if (s && s->rc != SIZE_MAX) {
    s->rc++;
  }
  return s;
}

void scr_stream_release(ScrStream *s) {
  if (!s || s->rc == SIZE_MAX) return;
  s->vt->release(s);
}

void *scr_stream_retain_v(void *s) { return scr_stream_retain(s); }
void scr_stream_release_v(void *s) { scr_stream_release(s); }

/* A completion closure: a 1-cap closure calling fn over a box that holds
 * the stream. Returns +1. */
static ScrClosure *scr_stream_done_new(ScrStream *s, void *fn) {
  ScrClosure *c = scr_closure_new(fn, 1);
  ScrBox *bx = scr_box_new_obj(scr_stream_retain_v, scr_stream_release_v, scr_stream_trace);
  c->caps[0] = bx;
  scr_box_set_ref(bx, scr_stream_retain(s));
  return c;
}

/* Keeps c in *slot, replacing the closure there. Nothing is kept after
 * 'close'. Borrows c. */
static void scr_stream_done_keep(ScrStreamState *st, ScrClosure **slot, ScrClosure *c) {
  if (st->close_emitted) return;
  ScrClosure *old = *slot;
  *slot = scr_closure_retain(c);
  if (old) scr_closure_release(old);
}

/* The `callback` a write or writev option callback receives. Node passes
 * the stream's one onwrite function to every _write and _writev call, so
 * every call receives the same closure, kept or not. Returns +1. */
ScrClosure *scr_stream_write_closure(ScrStream *s, void *fn) {
  ScrStreamState *st = s->st;
  ScrClosure *c = st->write_done;
  if (c != NULL && c->fn == fn) return scr_closure_retain(c);
  c = scr_stream_done_new(s, fn);
  scr_stream_done_keep(st, &st->write_done, c);
  return c;
}

/* The `callback` a transform, flush, final, construct or destroy option
 * callback receives. Node passes a new function to each call. The stream
 * keeps the last closure and hands it out again while it holds the only
 * reference and the closure has no own properties; weak collections then
 * forget it first, as they would at its free, so it is a new key to them.
 * Otherwise a new closure replaces it, and one the user kept keeps its own
 * stream reference. Returns +1. */
ScrClosure *scr_stream_done_closure(ScrStream *s, void *fn) {
  ScrStreamState *st = s->st;
  ScrClosure *c = st->done_cache;
  if (c != NULL && c->rc == 1 && c->fn == fn && c->props == NULL) {
    scr_weak_dispose_inline(c);
    return scr_closure_retain(c);
  }
  c = scr_stream_done_new(s, fn);
  scr_stream_done_keep(st, &st->done_cache, c);
  return c;
}

/* ── the tick queue (the nextTick stand-in) ───────────────────────────── */

typedef enum {
  SCR_ST_RESUME,        /* resume_: read(0) kick, 'resume', flow */
  SCR_ST_READABLE,      /* emitReadable_: 'readable', then flow */
  SCR_ST_END,           /* endReadableNT: 'end', autoDestroy/half-open */
  SCR_ST_MAYBE_MORE,    /* maybeReadMore_: refill toward hwm */
  SCR_ST_AFTER_WRITE,   /* deferred afterWrite (sync completion) */
  SCR_ST_FINISH,        /* 'finish', end cbs, autoDestroy */
  SCR_ST_ERROR,         /* 'error' with the owned payload */
  SCR_ST_CLOSE,         /* 'close' (when emitClose) */
  SCR_ST_END_W,         /* half-open: end the writable side */
  SCR_ST_WCB_ERR,       /* a failed write's user cb (called plain) */
  SCR_ST_WRITE_ERR,     /* onwriteError after a synchronous failed write */
  SCR_ST_NEXT_EOF,      /* a parked for-await's EOF sentinel, AFTER 'end' */
  SCR_ST_NEXT_WAKE,     /* a parked for-await's 'readable' wake-up */
  SCR_ST_READ0,         /* nReadingNextTick: read(0) */
  SCR_ST_FIN,           /* notify finished()/pipeline watchers (already-
                         * terminal registration) */
  SCR_ST_ERROR_BUFFER,  /* errorBuffer: buffered write and end() callbacks */
  SCR_ST_CONSTRUCT,     /* constructNT: run the construct hook */
  SCR_ST_CONSTRUCTED,   /* onConstruct: resume reads/writes/destroy */
  SCR_ST_XF_DONE,       /* a transform's write callback after push(null) */
} ScrStreamTickOp;

typedef struct ScrStreamTick {
  ScrStream *s; /* owned */
  ScrStreamTickOp op;
  ScrError *err;   /* owned or NULL (SCR_ST_ERROR) */
  ScrClosure *cb;  /* owned or NULL (SCR_ST_AFTER_WRITE / SCR_ST_WCB_ERR / SCR_ST_WRITE_ERR) */
  bool hold;       /* SCR_ST_AFTER_WRITE: counted in w.after_holds */
  /* SCR_ST_AFTER_WRITE: the synchronous writes it completes, which share
   * cb (Node's afterWriteTickInfo.count) */
  size_t count;
  /* The AsyncLocalStorage context active when the tick was scheduled (+1,
   * NULL outside a store): Node schedules these steps with
   * process.nextTick, so their events and callbacks run in it. */
  ScrAlsCtx *ctx;
  struct ScrStreamTick *next;
} ScrStreamTick;

static SCR_TL ScrStreamTick *scr_st_head = NULL;
static SCR_TL ScrStreamTick *scr_st_tail = NULL;

static void scr_stream_dispatch_one(void);

static void scr_st_tick(ScrStream *s, ScrStreamTickOp op, ScrError *err /*moves*/,
                        ScrClosure *cb /*moves*/) {
  ScrStreamTick *t = scr_mem_calloc(sizeof *t);
  if (!t) scr_stream_oom();
  t->s = scr_stream_retain(s);
  t->op = op;
  t->err = err;
  t->cb = cb;
  t->ctx = scr_als_capture();
  if (scr_st_tail) scr_st_tail->next = t;
  else scr_st_head = t;
  scr_st_tail = t;
  /* One marker per tick on the USER nextTick queue: stream emissions are
   * process.nextTicks in Node (resume_, emitReadable_, endReadableNT,
   * afterWrite, ...), so they must interleave with user nextTicks in
   * enqueue order — a `push(); on('data'); process.nextTick(assert)`
   * sequence sees its data before the assert runs. The station dispatch
   * below stays as the drain of anything a marker never reached. */
  scr_next_tick_raw(&scr_stream_dispatch_one);
}

static bool scr_stream_ticks_pending(void) { return scr_st_head != NULL; }

/* ── emit helpers ─────────────────────────────────────────────────────── */

/* The event names the stream unit emits, as immortal strings (the layout
 * of an emitted string literal), so an emit allocates no name. */
#define SCR_STREAM_EVENT_NAME(name)                                                     \
  static const struct {                                                                 \
    size_t rc;                                                                          \
    size_t len;                                                                         \
    size_t cap;                                                                         \
    char data[sizeof #name];                                                            \
  } scr_stream_lit_##name = {SIZE_MAX, sizeof #name - 1,                                \
                             SCR_STR_CAP_WORD(sizeof #name - 1, 0, 1), #name}
SCR_STREAM_EVENT_NAME(data);
SCR_STREAM_EVENT_NAME(error);
SCR_STREAM_EVENT_NAME(close);
SCR_STREAM_EVENT_NAME(drain);
SCR_STREAM_EVENT_NAME(end);
SCR_STREAM_EVENT_NAME(finish);
SCR_STREAM_EVENT_NAME(pause);
SCR_STREAM_EVENT_NAME(prefinish);
SCR_STREAM_EVENT_NAME(readable);
SCR_STREAM_EVENT_NAME(resume);
SCR_STREAM_EVENT_NAME(pipe);
SCR_STREAM_EVENT_NAME(unpipe);
#undef SCR_STREAM_EVENT_NAME

static ScrStr *const scr_stream_event_names[] = {
    (ScrStr *)&scr_stream_lit_data,      (ScrStr *)&scr_stream_lit_error,
    (ScrStr *)&scr_stream_lit_close,     (ScrStr *)&scr_stream_lit_drain,
    (ScrStr *)&scr_stream_lit_end,       (ScrStr *)&scr_stream_lit_finish,
    (ScrStr *)&scr_stream_lit_pause,     (ScrStr *)&scr_stream_lit_prefinish,
    (ScrStr *)&scr_stream_lit_readable,  (ScrStr *)&scr_stream_lit_resume,
    (ScrStr *)&scr_stream_lit_pipe,      (ScrStr *)&scr_stream_lit_unpipe,
};

/* The event name as a string: an immortal one for the names above, else a
 * new string (+1 either way; releasing an immortal string does nothing). */
static ScrStr *scr_stream_event_name(const char *name) {
  for (size_t i = 0; i < sizeof scr_stream_event_names / sizeof *scr_stream_event_names; i++) {
    if (strcmp(scr_stream_event_names[i]->data, name) == 0) return scr_stream_event_names[i];
  }
  return scr_str_new(name, strlen(name));
}

static bool scr_stream_emit0(ScrStream *s, const char *name) {
  ScrStr *n = scr_stream_event_name(name);
  bool had = scr_emitter_emit((ScrEmitter *)s, n);
  scr_str_release(n);
  return had;
}

static void scr_stream_emit_stream(ScrStream *s, const char *name, ScrStream *payload) {
  ScrStr *n = scr_stream_event_name(name);
  scr_emitter_emit((ScrEmitter *)s, n, payload);
  scr_str_release(n);
}

/* 'error': unhandled throws the payload (Node's crash), via the emitter's
 * error contract. Borrows err. */
static void scr_stream_emit_error(ScrStream *s, ScrError *err) {
  ScrStr *n = (ScrStr *)&scr_stream_lit_error;
  scr_emitter_emit_error((ScrEmitter *)s, n, err);
  scr_str_release(n);
}

static ScrError *scr_stream_mkerr(const char *code, const char *msg) {
  ScrStr *m = scr_str_new(msg, strlen(msg));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, m);
  scr_str_release(m);
  scr_error_set_code(e, code);
  return e;
}

/* The pending exception as a stream error (+1): Error values as
 * themselves, any other thrown value as an internal assertion. */
static ScrError *scr_stream_take_error(void) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *value = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  ScrError *err = value ? scr_errdyn_err_of(value) : NULL;
  if (value) scr_dyn_release(value);
  return err ? err : scr_stream_mkerr("ERR_INTERNAL_ASSERTION", "a stream operation threw a value that is not an Error");
}

/* ── forward decls ────────────────────────────────────────────────────── */

static void scr_stream_flow(ScrStream *s);
static void scr_stream_readable_listen(ScrStream *s);
static void scr_stream_emit_readable_now(ScrStream *s);
static void scr_stream_maybe_read_more(ScrStream *s);
static void scr_stream_finish_maybe(ScrStream *s);
static void scr_stream_clear_buffer(ScrStream *s);
static void scr_stream_do_destroy(ScrStream *s, ScrError *err /*borrowed*/);
static void scr_stream_notify_finished(ScrStream *s);
static void *scr_stream_read_n(ScrStream *s, double size);
static void *scr_stream_read_n_kind(ScrStream *s, double size, ScrEntryKind *kind);
static void scr_stream_settle_next_waiter(ScrStream *s);
/* A for-await iterator's parked next(): only a stream with a waiter that
 * is not mid-read has anything to settle. */
static inline void scr_stream_settle_next(ScrStream *s) {
  if (s->st->r.next_waiter && !s->st->r.next_reading) scr_stream_settle_next_waiter(s);
}
static ScrStream *scr_stream_alloc(const ScrVt *vt, const char *cls, bool has_r, bool has_w,
                                    double rhwm, double whwm, bool auto_destroy,
                                    bool emit_close, bool allow_half_open);

/* errorOrDestroy: autoDestroy (the default) destroys with the error;
 * otherwise the error emits on a tick. Borrows err. */
static void scr_stream_error_or_destroy(ScrStream *s, ScrError *err) {
  ScrStreamState *st = s->st;
  if (st->destroyed) return; /* err stays the caller's borrow */
  if (st->auto_destroy) {
    scr_stream_do_destroy(s, err);
  } else {
    if (!st->errored) st->errored = scr_error_retain(err);
    if (!st->error_scheduled) {
      st->error_scheduled = true;
      scr_st_tick(s, SCR_ST_ERROR, scr_error_retain(err), NULL);
    }
    scr_stream_settle_next(s); /* a parked for-await rejects with the error */
  }
}

/* ── readable internals ───────────────────────────────────────────────── */

static void scr_stream_rbuf_push(ScrStreamState *st, void *chunk /*moves*/, ScrEntryKind kind,
                                 bool front) {
  if (kind != scr_stream_rkind(st)) {
    /* every entry has the buffer's representation (scr_stream_rkind) */
    fputs("scriptc: internal error: stream buffer entry of the wrong kind\n", stderr);
    abort();
  }
  if (st->r.n == st->r.cap) {
    st->r.cap = st->r.cap ? st->r.cap * 2 : 4;
    st->r.buf = realloc(st->r.buf, st->r.cap * sizeof *st->r.buf);
    if (!st->r.buf) scr_stream_oom();
  }
  if (front) {
    /* unshift: head_off must be zero (only buf[0] is partially consumed,
     * and unshift with a part-read head keeps the remainder intact by
     * materializing it first — the caller slices). */
    memmove(st->r.buf + 1, st->r.buf, st->r.n * sizeof *st->r.buf);
    st->r.buf[0] = chunk;
  } else {
    st->r.buf[st->r.n] = chunk;
  }
  st->r.n++;
  st->r.length += scr_stream_entry_len(st, chunk);
}

/* Takes n units (n <= length; bytes, or chars once encoded) off the
 * buffer head as one +1 Buffer / string. An object-mode buffer always
 * takes one whole entry (n is 1). */
static void *scr_stream_rbuf_take(ScrStreamState *st, size_t n) {
  void *first = st->r.n > 0 ? st->r.buf[0] : NULL;
  if (first && st->r.head_off == 0 && scr_stream_entry_len(st, first) == n) {
    /* whole-chunk fast path: hand the buffered chunk out as-is */
    memmove(st->r.buf, st->r.buf + 1, (st->r.n - 1) * sizeof *st->r.buf);
    st->r.n--;
    st->r.length -= n;
    return first;
  }
  if (st->r.encoded) {
    /* string mode: slice by JS string units (Node's fromList over
     * strings), concatenating across entries. */
    ScrStr *out = NULL;
    size_t at = 0;
    while (at < n) {
      ScrStr *head = st->r.buf[0];
      size_t head_len = (size_t)scr_str_utf16_len(head);
      size_t avail = head_len - st->r.head_off;
      size_t take = avail < n - at ? avail : n - at;
      ScrStr *piece = scr_str_slice(head, (double)st->r.head_off, (double)(st->r.head_off + take));
      if (out == NULL) {
        out = piece;
      } else {
        ScrStr *joined = scr_str_concat(out, piece);
        scr_str_release(out);
        scr_str_release(piece);
        out = joined;
      }
      at += take;
      st->r.head_off += take;
      if (st->r.head_off == head_len) {
        scr_str_release(head);
        memmove(st->r.buf, st->r.buf + 1, (st->r.n - 1) * sizeof *st->r.buf);
        st->r.n--;
        st->r.head_off = 0;
      }
    }
    st->r.length -= n;
    return out;
  }
  ScrBytes *out = scr_stream_buffer(scr_bytes_new(SCR_BYTES_U8, (double)n));
  size_t at = 0;
  while (at < n) {
    ScrBytes *head = st->r.buf[0];
    size_t avail = head->len - st->r.head_off;
    size_t take = avail < n - at ? avail : n - at;
    scr_bytes_read(head, st->r.head_off, out->data + at, take);
    at += take;
    st->r.head_off += take;
    if (st->r.head_off == head->len) {
      scr_bytes_release(head);
      memmove(st->r.buf, st->r.buf + 1, (st->r.n - 1) * sizeof *st->r.buf);
      st->r.n--;
      st->r.head_off = 0;
    }
  }
  st->r.length -= n;
  return out;
}

/* emit('data', chunk) + pipe delivery. Borrows chunk (a Buffer, a string
 * once encoded, or a dyn value, by kind). The emit ABI carries three
 * payload slots: the bytes chunk, the string chunk, and the value of a
 * dyn entry. A dyn entry that is a Buffer or a string also fills that
 * slot, so at most one of the first two is non-NULL; the compiler's
 * stream-data listener thunks dispatch on them (typed listeners unwrap
 * their declared side; dyn listeners box by tag or take the value). */
static void scr_stream_emit_data(ScrStream *s, void *chunk, ScrEntryKind kind) {
  ScrStreamState *st = s->st;
  ScrBytes *b = NULL;
  ScrStr *str = NULL;
  ScrDyn *value = NULL;
  if (kind == SCR_ENTRY_DYN) {
    value = chunk;
    if (value->kind == SCR_DYN_BYTES) b = value->v.bytes;
    else if (value->kind == SCR_DYN_STR) str = value->v.str;
  } else if (kind == SCR_ENTRY_STR) {
    str = chunk;
  } else {
    b = chunk;
  }
  /* emit('data') with no listeners does nothing; a piped stream delivers
   * through st->pipes below */
  if (st->r.data_listeners) {
    ScrStr *n = (ScrStr *)&scr_stream_lit_data;
    scr_emitter_emit((ScrEmitter *)s, n, b, str, value);
    scr_str_release(n);
    if (scr_exc_pending()) return;
  }
  /* pipe delivery, with backpressure: a full destination pauses us until
   * its 'drain'. Encoded sources write the string (utf8 bytes at the
   * destination — Node writes the decoded string through). */
  for (size_t i = 0; i < st->pipes.n;) {
    ScrStream *dst = st->pipes.dst[i];
    if (dst->st->destroyed) {
      /* Node's pipe cleanup: a destroyed destination unhooks (the
       * onerror/onclose → unpipe path) and pauses the source — writing
       * after destroy would drop the error without reporting it and spin
       * an infinite synchronous flow over an endless source. */
      scr_stream_release(scr_stream_unpipe(s, dst));
      if (scr_exc_pending()) return;
      continue; /* the pipes array shifted down over i */
    }
    bool ok = value ? scr_stream_write_dyn(dst, value, NULL)
              : b   ? scr_stream_write(dst, b, NULL)
                    : scr_stream_write_str(dst, str, NULL);
    if (scr_exc_pending()) return;
    i++;
    if (!ok && !dst->st->destroyed) {
      ScrStreamState *dstt = dst->st;
      /* register once */
      bool already = false;
      for (size_t j = 0; j < dstt->drain_srcs.n; j++) {
        if (dstt->drain_srcs.src[j] == s) already = true;
      }
      if (!already) {
        if (dstt->drain_srcs.n == dstt->drain_srcs.cap) {
          dstt->drain_srcs.cap = dstt->drain_srcs.cap ? dstt->drain_srcs.cap * 2 : 2;
          dstt->drain_srcs.src = realloc(dstt->drain_srcs.src, dstt->drain_srcs.cap * sizeof *dstt->drain_srcs.src);
          if (!dstt->drain_srcs.src) scr_stream_oom();
        }
        dstt->drain_srcs.src[dstt->drain_srcs.n++] = scr_stream_retain(s);
        st->await_drain++;
        st->r.flowing = 0;
      }
    }
  }
}

static void scr_stream_emit_readable_nt(ScrStream *s) {
  ScrStreamState *st = s->st;
  st->r.need_readable = false; /* Node's emitReadable clears the ask */
  if (!st->r.emitted_readable) {
    st->r.emitted_readable = true;
    scr_st_tick(s, SCR_ST_READABLE, NULL, NULL);
  }
}

static void scr_stream_end_readable(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->r.end_emitted || st->r.end_scheduled) return;
  st->r.end_scheduled = true;
  scr_st_tick(s, SCR_ST_END, NULL, NULL);
}

/* The user _read call (reading guard + sync flag). Absent read cb means
 * ERR_METHOD_NOT_IMPLEMENTED, Node's contract. */
static void scr_stream_call_read(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->r.read_cb == NULL && st->r.object_entries && !st->r.object_mode_opt) {
    /* Readable.from: fully seeded at construction — _read is a no-op */
    st->r.in_read_sync = false;
    return;
  }
  if (st->r.read_cb == NULL && !st->is_transform && !st->passthrough) {
    ScrError *e = scr_stream_mkerr("ERR_METHOD_NOT_IMPLEMENTED", "The _read() method is not implemented");
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return;
  }
  if (st->r.read_cb == NULL) {
    /* transform reads are push-driven; the attempt still clears the
     * initial sync flag (Node's Transform._read ran) and runs a held
     * write callback */
    st->r.in_read_sync = false;
    if (st->xf_held) {
      st->xf_held = false;
      scr_stream_write_done(s, NULL);
    }
    return;
  }
  st->r.reading = true;
  st->r.in_read_sync = true;
  st->r.in_read_call = true;
  st->r.read_inv(st->r.read_cb, s, (double)st->r.hwm);
  st->r.in_read_call = false;
  st->r.in_read_sync = false;
}

/* readableAddChunk. Borrows chunk (retains its own ref). Returns the
 * below-hwm answer. Encoded streams decode the bytes through the
 * StringDecoder first (Node decodes at push); an empty decode (a partial
 * multi-byte tail held pending) adds nothing but still clears the
 * reading flag. */
static int scr_stream_add_entry(ScrStream *s, void *entry /*moves*/, ScrEntryKind kind);
static void *scr_stream_entry_convert_kind(ScrStreamState *st, void *entry, ScrEntryKind *kind);
/* An entry already of the buffer's kind is kept as-is. */
static inline void *scr_stream_entry_convert(ScrStreamState *st, void *entry, ScrEntryKind *kind) {
  if (*kind == scr_stream_rkind(st)) return entry;
  return scr_stream_entry_convert_kind(st, entry, kind);
}

static bool scr_stream_add_chunk(ScrStream *s, ScrBytes *chunk, bool front) {
  ScrStreamState *st = s->st;
  if (st->has_r && st->r.object_entries) {
    /* object mode: the Buffer is one whole entry */
    if (!front) return scr_stream_add_entry(s, scr_bytes_retain(chunk), SCR_ENTRY_BYTES) > 0;
    ScrEntryKind kind = SCR_ENTRY_BYTES;
    void *entry = scr_stream_entry_convert(st, scr_bytes_retain(chunk), &kind);
    scr_stream_rbuf_push(st, entry, kind, true);
    if (st->r.need_readable) scr_stream_emit_readable_nt(s);
    scr_stream_settle_next(s);
    return !st->r.ended && (st->r.length < st->r.hwm || st->r.length == 0);
  }
  if (!st->has_r) {
    ScrError *e = scr_stream_mkerr("ERR_STREAM_PUSH_AFTER_EOF", "push on a Writable (no readable side)");
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return false;
  }
  if (st->r.ended && !front) {
    ScrError *e = scr_stream_mkerr("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return false;
  }
  if (st->destroyed) return false;
  if (!front) st->r.reading = false;
  void *entry;
  size_t entry_len;
  if (st->r.encoded) {
    ScrStr *dec = scr_strdec_write(st->r.enc, st->r.dec_pending, chunk);
    st->r.dec_pending = scr_strdec_next(st->r.enc, st->r.dec_pending, chunk);
    entry_len = (size_t)scr_str_utf16_len(dec);
    if (entry_len == 0) {
      scr_str_release(dec);
      if (!front) scr_stream_maybe_read_more(s);
      return !st->r.ended && (st->r.length < st->r.hwm || st->r.length == 0);
    }
    entry = dec; /* owned */
  } else {
    entry_len = chunk->len;
    if (entry_len == 0) {
      /* Node's readableAddChunk adds no empty chunk outside object mode:
       * it clears reading and may read more */
      if (!front) scr_stream_maybe_read_more(s);
      return !st->r.ended && (st->r.length < st->r.hwm || st->r.length == 0);
    }
    entry = scr_bytes_retain(chunk);
  }
  if (entry_len > 0 &&
      st->r.flowing == 1 && st->r.length == 0 && !st->r.in_read_sync && !front &&
      (st->r.data_listeners || st->pipes.n > 0)) {
    /* the direct-emit fast path: flowing, empty buffer, async push */
    if (st->r.emitted_readable) st->r.emitted_readable = false;
    ScrEntryKind kind = scr_stream_rkind(st);
    scr_stream_emit_data(s, entry, kind);
    scr_stream_entry_release_kind(entry, kind);
    if (scr_exc_pending()) return false;
  } else {
    scr_stream_rbuf_push(st, entry, scr_stream_rkind(st), front);
    if (st->r.need_readable) scr_stream_emit_readable_nt(s);
  }
  if (!front) scr_stream_maybe_read_more(s);
  scr_stream_settle_next(s); /* a parked for-await consumes buffered content */
  return !st->r.ended && (st->r.length < st->r.hwm || st->r.length == 0);
}

static void scr_stream_maybe_read_more(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->r.maybe_more_scheduled || st->r.reading || st->r.ended || st->destroyed ||
      st->constructing) {
    return;
  }
  if (!(st->r.length < st->r.hwm && (st->r.flowing == 1 || st->r.need_readable))) return;
  st->r.maybe_more_scheduled = true;
  scr_st_tick(s, SCR_ST_MAYBE_MORE, NULL, NULL);
}

/* howMuchToRead + fromList + the doRead discipline: readable.read().
 * Answers a +1 Buffer — or a +1 string once encoded (lengths and the
 * size argument then count JS string units, Node's encoded accounting). */
static void *scr_stream_read_n(ScrStream *s, double size) {
  ScrEntryKind kind;
  return scr_stream_read_n_kind(s, size, &kind);
}

/* read_n, also answering the chunk's kind as it was taken from the buffer
 * (a string when the stream was encoded then). A _read or a lazy pull
 * inside the read can change the representation, and a 'data' listener
 * can call setEncoding() before this returns, so callers that need the
 * kind read it here rather than from st->r.encoded afterwards. */
static void *scr_stream_read_n_kind(ScrStream *s, double size, ScrEntryKind *kind) {
  ScrStreamState *st = s->st;
  *kind = scr_stream_rkind(st);
  bool absent = size < 0;
  size_t n = 0;
  if (!absent) {
    n = (size_t)size;
    if (n > st->r.hwm) {
      /* Node grows hwm to the next power of two above n */
      size_t h = st->r.hwm;
      while (h < n) h *= 2;
      st->r.hwm = h;
    }
  }
  /* Node's read(): `if (n !== 0) state.emittedReadable = false` — the
   * absent form is NaN there, which also clears; only read(0) keeps it. */
  if (absent || n != 0) st->r.emitted_readable = false;
  if (!absent && n == 0 && st->r.need_readable &&
      (st->r.length >= st->r.hwm || st->r.ended)) {
    if (st->r.length == 0 && st->r.ended) scr_stream_end_readable(s);
    else scr_stream_emit_readable_nt(s);
    return NULL;
  }
  /* howMuchToRead */
  size_t want;
  if (st->r.object_entries) {
    /* objectMode-style: one whole entry per read (howMuchToRead: none
     * for read(0)) */
    want = st->r.length > 0 && (absent || n > 0) ? 1 : 0;
  } else if (absent) {
    want = st->r.flowing == 1 && st->r.n > 0
        ? scr_stream_entry_len(st, st->r.buf[0]) - st->r.head_off
        : st->r.length;
  } else {
    want = n <= st->r.length ? n : (st->r.ended ? st->r.length : 0);
  }
  if (want == 0 && st->r.ended) {
    if (st->r.length == 0) scr_stream_end_readable(s);
    return NULL;
  }
  bool do_read = st->r.need_readable || st->r.length == 0 ||
                 st->r.length - want < st->r.hwm;
  if (st->r.ended || st->r.reading || st->destroyed || st->errored || st->constructing) {
    do_read = false;
  }
  if (do_read) {
    if (st->r.length == 0) st->r.need_readable = true;
    scr_stream_call_read(s);
    if (scr_exc_pending()) return NULL;
    /* a synchronous push may have refilled */
    if (!st->r.reading) {
      if (st->r.object_entries) {
        want = st->r.length > 0 && (absent || n > 0) ? 1 : 0;
      } else if (absent) {
        want = st->r.flowing == 1 && st->r.n > 0
            ? scr_stream_entry_len(st, st->r.buf[0]) - st->r.head_off
            : st->r.length;
      } else {
        want = n <= st->r.length ? n : (st->r.ended ? st->r.length : 0);
      }
    }
  }
  *kind = scr_stream_rkind(st);
  void *ret = want > 0 && want <= st->r.length ? scr_stream_rbuf_take(st, want) : NULL;
  if (ret == NULL) {
    st->r.need_readable = st->r.length <= st->r.hwm;
  } else if (st->r.flowing == 1 && st->r.length == 0) {
    st->r.need_readable = true;
  }
  if (st->r.length == 0) {
    if (!st->r.ended) st->r.need_readable = true;
    if (st->r.ended && !absent && n != want) scr_stream_end_readable(s);
    if (st->r.ended && absent) scr_stream_end_readable(s);
  }
  if (ret != NULL && !st->error_emitted && !st->close_emitted) {
    scr_stream_emit_data(s, ret, *kind);
    if (scr_exc_pending()) {
      scr_stream_entry_release_kind(ret, *kind);
      return NULL;
    }
  }
  return ret;
}

static void scr_stream_flow(ScrStream *s) {
  ScrStreamState *st = s->st;
  while (st->r.flowing == 1 && !scr_exc_pending()) {
    ScrEntryKind kind;
    void *b = scr_stream_read_n_kind(s, -1, &kind);
    if (b == NULL) break;
    scr_stream_entry_release_kind(b, kind);
  }
}

static void scr_stream_resume_kick(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->r.resume_scheduled) return;
  st->r.resume_scheduled = true;
  scr_st_tick(s, SCR_ST_RESUME, NULL, NULL);
}

/* ── the dyn-flavored completion callbacks (the JS lane) ──────────────── */

/* The JS lane's option callbacks and underscore methods declare their
 * parameters implicitly-any: the compiler-emitted invoke thunks box the
 * chunk/encoding/error into dyn, and the COMPLETION callback arrives as
 * a callable dyn function whose glue lands here — arguments arrive as
 * borrowed dyn values: the error is null/undefined (none), an
 * error-shaped object ({message}), or a string; transform/flush data is
 * bytes, a string, or absent. clo->caps[0] boxes the retained stream. */

static ScrError *scr_stream_dyn_err(ScrDyn *const *args, size_t argc) {
  if (argc < 1) return NULL;
  const ScrDyn *a = args[0];
  if (!scr_dyn_truthy(a)) return NULL;
  if (a->kind == SCR_DYN_STR) return scr_error_new(SCR_ERR_ERROR, a->v.str);
  /* the error value itself (the same object reaches 'error') */
  return scr_error_from_dyn(a);
}

static ScrStream *scr_stream_dyn_recv(ScrClosure *clo) {
  return scr_box_get_ref(clo->caps[0]);
}

static ScrDyn *scr_stream_done_dyn_ret(void) { return scr_dyn_retain(scr_dyn_undefined()); }

ScrDyn *scr_stream_done_dyn_w(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  scr_stream_write_done(s, scr_stream_dyn_err(args, argc));
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

ScrDyn *scr_stream_done_dyn_f(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  scr_stream_final_done(s, scr_stream_dyn_err(args, argc));
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

ScrDyn *scr_stream_done_dyn_c(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  scr_stream_construct_done(s, scr_stream_dyn_err(args, argc));
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

ScrDyn *scr_stream_done_dyn_d(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  scr_stream_destroy_done(s, scr_stream_dyn_err(args, argc));
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

/* callback(err, data) of an untyped transform or flush: data is pushed
 * as push(data) pushes it. */
ScrDyn *scr_stream_done_dyn_t(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  scr_stream_transform_done_value(s, scr_stream_dyn_err(args, argc), argc > 1 ? args[1] : NULL);
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

ScrDyn *scr_stream_done_dyn_l(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  scr_stream_flush_done_value(s, scr_stream_dyn_err(args, argc), argc > 1 ? args[1] : NULL);
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

/* Checked-dynamic chunks (the JS lane's push/write of any-typed values):
 * dispatch by dyn tag — bytes copy out, strings convert utf8, null takes
 * the null path (EOF for push; ERR_STREAM_NULL_VALUES for write). On an
 * object-mode side every other value is one entry. Otherwise any other
 * write throws Node's ERR_INVALID_ARG_TYPE, push(undefined) adds nothing,
 * and any other push reports ERR_INVALID_ARG_TYPE through 'error', as
 * readableAddChunkPushByteMode does. Borrow d. */
bool scr_stream_push_dyn(ScrStream *s, const ScrDyn *d) {
  ScrStreamState *st = s->st;
  if (d->kind != SCR_DYN_NULL && st->has_r && st->r.object_entries)
    return scr_stream_push_object(s, d) > 0;
  switch (d->kind) {
  case SCR_DYN_BYTES: {
    ScrBytes *b = scr_bytes_raw_view(d->v.bytes);
    bool r = scr_stream_push_view(s, b);
    scr_bytes_release(b);
    return r;
  }
  case SCR_DYN_STR:
    return scr_stream_push_str(s, d->v.str);
  case SCR_DYN_NULL:
    return scr_stream_push_null(s);
  case SCR_DYN_UNDEF:
    if (!st->has_r) return false;
    st->r.reading = false;
    scr_stream_maybe_read_more(s);
    return !st->r.ended && (st->r.length < st->r.hwm || st->r.length == 0);
  default: {
    scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", d);
    ScrError *e = scr_stream_take_error();
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return false;
  }
  }
}

static bool scr_stream_write_value(ScrStream *s, ScrDyn *v, ScrClosure *cb);

bool scr_stream_write_dyn(ScrStream *s, const ScrDyn *d, ScrClosure *cb) {
  if (d->kind != SCR_DYN_NULL && s->st->has_w && s->st->w.object_mode)
    return scr_stream_write_value(s, (ScrDyn *)d, cb);
  switch (d->kind) {
  case SCR_DYN_BYTES: {
    ScrBytes *b = scr_bytes_raw_view(d->v.bytes);
    bool r = scr_stream_write(s, b, cb);
    scr_bytes_release(b);
    return r;
  }
  case SCR_DYN_STR:
    return scr_stream_write_str(s, d->v.str, cb);
  case SCR_DYN_NULL:
    if (cb) scr_closure_release(cb);
    return scr_stream_write_null(s);
  default:
    /* Writable.write: only null is the null-values error. */
    if (cb) scr_closure_release(cb);
    scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", d);
    return false;
  }
}

/* ── the for-await surface (readable.nextChunk) ───────────────────────── */

/* Resolve the parked waiter with a taken chunk (moves), the EOF
 * sentinel, or dyn-boxed content per next_dyn. */
/* Node's iterator is an async generator: `yield chunk` awaits the chunk,
 * so next() settles one microtask after the chunk is read. The end (a
 * bare return) and errors (a throw) settle without that await. caps[0]
 * the waiter, caps[1] the payload (dyn or bytes, by caps[2]). */
static void scr_stream_next_yield_job(ScrClosure *job) {
  ScrPromise *w = scr_box_get_ref(job->caps[0]);
  bool dyn = scr_box_get_bool(job->caps[2]);
  void *payload = scr_box_get_ref(job->caps[1]);
  if (dyn) scr_promise_fulfill_ref(w, payload, scr_dyn_retain_v, scr_dyn_release_v, NULL);
  else scr_promise_fulfill_ref(w, payload, scr_bytes_retain_v, scr_bytes_release_v, NULL);
  scr_promise_release(w);
}

static void scr_stream_next_str_fence(void) {
  static const char msg[] =
      "for-await over a stream with an encoding set is not supported yet in "
      "typed code (chunks are Buffers here)";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
}

/* Fulfills the parked iterator with a chunk taken from the buffer; kind
 * is its kind as taken. The typed lane's chunk is a Buffer, so another
 * chunk rejects with the encoding fence instead. The dyn lane's end is
 * the done marker (scr_stream_from_done): an object-mode stream can
 * yield undefined. */
static void scr_stream_next_fulfill(ScrStreamState *st, ScrPromise *w /*moves*/,
                                    void *chunk /*moves or NULL=EOF*/, ScrEntryKind kind) {
  void *payload;
  bool dyn = st->r.next_dyn;
  if (!dyn && chunk != NULL && kind == SCR_ENTRY_DYN) {
    ScrDyn *d = chunk;
    if (d->kind == SCR_DYN_BYTES) {
      chunk = scr_bytes_raw_view(d->v.bytes);
      kind = SCR_ENTRY_BYTES;
      scr_dyn_release(d);
    } else {
      chunk = scr_dyn_string_coerce_js(d);
      kind = SCR_ENTRY_STR;
      scr_dyn_release(d);
    }
  }
  if (!dyn && chunk != NULL && kind == SCR_ENTRY_STR) {
    scr_str_release((ScrStr *)chunk);
    scr_stream_next_str_fence();
    scr_promise_reject_pending(w);
    scr_promise_release(w);
    return;
  }
  if (dyn && st->r.next_result) {
    /* { value, done }: the value, or undefined at the end */
    ScrDyn *result = scr_dyn_new_obj();
    scr_dyn_obj_set(result, "value", 5,
                    chunk == NULL ? scr_dyn_retain(scr_dyn_undefined())
                                  : scr_stream_entry_box(chunk, kind));
    scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(chunk == NULL));
    payload = result;
  } else if (dyn) {
    payload = chunk == NULL ? scr_stream_from_done() : scr_stream_entry_box(chunk, kind);
  } else {
    payload = chunk ? (ScrBytes *)chunk : scr_bytes_new(SCR_BYTES_U8, 0);
  }
  if (chunk == NULL) {
    if (dyn) scr_promise_fulfill_ref(w, payload, scr_dyn_retain_v, scr_dyn_release_v, NULL);
    else scr_promise_fulfill_ref(w, payload, scr_bytes_retain_v, scr_bytes_release_v, NULL);
    scr_promise_release(w);
    return;
  }
  ScrClosure *job = scr_closure_new((void *)&scr_stream_next_yield_job, 3);
  job->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
  scr_box_set_ref(job->caps[0], w); /* moves */
  job->caps[1] = dyn ? scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL)
                     : scr_box_new_obj(scr_bytes_retain_v, scr_bytes_release_v, NULL);
  scr_box_set_ref(job->caps[1], payload); /* moves */
  job->caps[2] = scr_box_new(SCR_BOX_BOOL);
  scr_box_set_bool(job->caps[2], dyn);
  scr_queue_microtask(job);
}

/* One pass of createAsyncIterator's loop for the parked waiter:
 * `stream.read()` (a _read below the hwm, then the buffered chunk; pushes
 * the _read makes join it), else the settled states (error, EOF), else
 * the waiter stays parked. */
static void scr_stream_iter_step(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (!st->r.next_waiter) return;
  if (!st->destroyed && !st->errored) {
    st->r.next_reading = true;
    ScrEntryKind kind;
    void *chunk = scr_stream_read_n_kind(s, -1, &kind);
    st->r.next_reading = false;
    if (scr_exc_pending()) {
      if (chunk) scr_stream_entry_release_kind(chunk, kind);
      ScrPromise *w = st->r.next_waiter;
      st->r.next_waiter = NULL;
      if (w) {
        scr_promise_reject_pending(w);
        scr_promise_release(w);
      }
      return;
    }
    if (chunk) {
      ScrPromise *w = st->r.next_waiter;
      st->r.next_waiter = NULL;
      scr_stream_next_fulfill(st, w, chunk, kind);
      return;
    }
  }
  scr_stream_settle_next(s);
}

static void scr_stream_next_wake_job(ScrClosure *job) {
  ScrStream *s = scr_box_get_ref(job->caps[0]);
  s->st->r.next_wake = false;
  s->st->r.next_parked = false;
  scr_stream_iter_step(s);
  if (s->st->r.next_waiter) s->st->r.next_parked = true;
  scr_stream_release(s);
}

/* Settle the parked waiter if the stream's state can answer now: an
 * error rejects, buffered content fulfills (one whole entry in from
 * mode, the whole buffer otherwise — Node's iterator read()), EOF
 * fulfills the sentinel. Called from push/eof/destroy transitions. */
static void scr_stream_settle_next_waiter(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (!st->r.next_waiter || st->r.next_reading) return;
  if (st->errored && !st->error_emitted) {
    /* Node's iterator learns of the error from its eos 'error' listener,
     * after the listeners registered before it: the waiter rejects once
     * the 'error' event is dispatched (SCR_ST_ERROR), and its listener
     * keeps the error from being unhandled. */
    st->next_err_consumed = true;
    return;
  }
  if (st->errored) {
    ScrPromise *w = st->r.next_waiter;
    st->r.next_waiter = NULL;
    st->next_err_consumed = true;
    scr_throw_obj(scr_error_retain(st->errored), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(w);
    scr_promise_release(w);
    return;
  }
  if (st->r.length > 0) {
    if (st->r.next_parked) {
      if (!st->r.next_wake) {
        st->r.next_wake = true;
        scr_st_tick(s, SCR_ST_NEXT_WAKE, NULL, NULL);
      }
      return;
    }
    ScrPromise *w = st->r.next_waiter;
    st->r.next_waiter = NULL;
    ScrEntryKind kind = scr_stream_rkind(st);
    void *chunk = scr_stream_rbuf_take(st, st->r.object_entries ? 1 : st->r.length);
    scr_stream_next_fulfill(st, w, chunk, kind);
    if (st->r.ended && st->r.length == 0) scr_stream_end_readable(s);
    return;
  }
  if (st->r.ended || st->destroyed) {
    if (st->r.ended && st->r.next_close_wait && !st->close_emitted) {
      if (!st->r.end_emitted) scr_stream_end_readable(s);
      st->r.next_eof_close = true;
      return;
    }
    if (st->r.ended && !st->r.end_emitted) {
      /* Node's iterator completes AFTER 'end' (and its autoDestroy):
       * queue the sentinel BEHIND the pending 'end' tick, so code after
       * the loop reads readableEnded/destroyed true. */
      scr_stream_end_readable(s);
      scr_st_tick(s, SCR_ST_NEXT_EOF, NULL, NULL);
      return;
    }
    ScrPromise *w = st->r.next_waiter;
    st->r.next_waiter = NULL;
    scr_stream_next_fulfill(st, w, NULL, SCR_ENTRY_BYTES);
  }
}

static ScrPromise *scr_stream_next_chunk_impl(ScrStream *s, bool dyn, bool result) {
  ScrStreamState *st = s->st;
  ScrPromise *p = scr_promise_new();
  if (!st->has_r) {
    st->r.next_dyn = dyn;
    st->r.next_result = result;
    scr_stream_next_fulfill(st, scr_promise_retain(p), NULL, SCR_ENTRY_BYTES);
    return p;
  }
  if (st->r.next_waiter) {
    /* the desugared loop awaits each chunk before asking again */
    static const char msg[] = "concurrent for-await iteration of one stream is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    scr_promise_reject_pending(p);
    return p;
  }
  st->r.next_dyn = dyn;
  st->r.next_result = result;
  st->r.next_waiter = scr_promise_retain(p);
  st->r.next_parked = false;
  if (!st->r.next_started) {
    st->r.next_started = true;
    st->r.next_close_wait =
        !st->has_w && st->auto_destroy && st->emit_close && !st->close_scheduled && !st->close_emitted;
  }
  /* createAsyncIterator starts with stream.on('readable', next) */
  scr_stream_readable_listen(s);
  scr_stream_iter_step(s);
  if (st->r.next_waiter) st->r.next_parked = true;
  return p;
}

ScrPromise *scr_stream_next_chunk(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->has_r && st->r.encoded) {
    /* the typed lane's chunk is a Buffer; string chunks would confuse */
    ScrPromise *p = scr_promise_new();
    scr_stream_next_str_fence();
    scr_promise_reject_pending(p);
    return p;
  }
  return scr_stream_next_chunk_impl(s, false, false);
}

ScrPromise *scr_stream_next_chunk_dyn(ScrStream *s) {
  return scr_stream_next_chunk_impl(s, true, false);
}

ScrPromise *scr_stream_next_result_dyn(ScrStream *s) {
  return scr_stream_next_chunk_impl(s, true, true);
}

/* ── Readable.from (array, string and Buffer sources) ─────────────────── */

/* from.js over an array source: the iterator position and the `reading`
 * guard. The typed lane holds a ScrArr of ScrStr / ScrBytes elements; the
 * JS lane holds the checked-dynamic array. `single` is from.js's string /
 * Buffer special case: each _read pushes the value, then EOF. */
enum { SCR_FROM_HWM_FROM, SCR_FROM_HWM_DEFAULT, SCR_FROM_HWM_SET };

typedef struct {
  int rc;
  ScrArr *arr; /* +1 or NULL */
  ScrDyn *dyn; /* +1 or NULL */
  size_t i;
  bool strings, single, reading;
} ScrFromSrc;

static ScrFromSrc *scr_from_src_retain(ScrFromSrc *f) {
  f->rc++;
  return f;
}

static void scr_from_src_release(ScrFromSrc *f) {
  if (--f->rc > 0) return;
  if (f->arr) scr_arr_release(f->arr);
  if (f->dyn) scr_dyn_release(f->dyn);
  free(f);
}

static void *scr_from_src_retain_v(void *f) { return scr_from_src_retain(f); }
static void scr_from_src_release_v(void *f) { scr_from_src_release(f); }

/* One typed element into the stream: a whole entry in object mode, a
 * chunk in byte mode. Moves e. Returns push's answer. */
static bool scr_from_push_typed(ScrStream *s, void *e, bool strings) {
  if (s->st->r.object_entries)
    return scr_stream_add_entry(s, e, strings ? SCR_ENTRY_STR : SCR_ENTRY_BYTES) > 0;
  bool more = strings ? scr_stream_push_str(s, e) : scr_stream_push(s, e);
  if (strings) scr_str_release(e);
  else scr_bytes_release(e);
  return more;
}

static void scr_from_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)size;
  ScrFromSrc *f = scr_box_get_ref(cb->caps[0]);
  if (f->single) {
    scr_from_push_typed(s, scr_arr_get_ref(f->arr, 0), f->strings);
    if (!scr_exc_pending()) scr_stream_push_null(s);
  } else if (!f->reading) {
    /* nextSyncWithSyncValues: push while push() answers true */
    f->reading = true;
    for (;;) {
      if (f->i >= f->arr->len) {
        scr_stream_push_null(s);
        break;
      }
      void *e = scr_arr_get_ref(f->arr, (double)f->i++);
      bool more = scr_from_push_typed(s, e, f->strings);
      if (scr_exc_pending()) break;
      if (!more) {
        f->reading = false;
        break;
      }
    }
  }
  scr_from_src_release(f);
}

/* readable._destroy: close() is an async function with nothing to await
 * for an array iterator (no return/throw methods), so the callback runs
 * after its promise reaction and then a nextTick. */
typedef struct {
  int rc;
  ScrStream *s;    /* +1 */
  ScrError *error; /* +1 or NULL */
} ScrFromDestroy;

static void *scr_from_destroy_retain_v(void *p) {
  ((ScrFromDestroy *)p)->rc++;
  return p;
}

static void scr_from_destroy_release_v(void *p) {
  ScrFromDestroy *d = p;
  if (--d->rc > 0) return;
  scr_stream_release(d->s);
  if (d->error) scr_error_release(d->error);
  free(d);
}

static ScrClosure *scr_from_destroy_closure(void *fn, ScrFromDestroy *d) {
  ScrClosure *job = scr_closure_new(fn, 1);
  job->caps[0] = scr_box_new_obj(&scr_from_destroy_retain_v, &scr_from_destroy_release_v, NULL);
  scr_box_set_ref(job->caps[0], scr_from_destroy_retain_v(d));
  return job;
}

static void scr_from_destroy_tick(ScrClosure *job) {
  ScrFromDestroy *d = scr_box_get_ref(job->caps[0]);
  scr_stream_destroy_done(d->s, d->error ? scr_error_retain(d->error) : NULL);
  scr_from_destroy_release_v(d);
}

static void scr_from_destroy_job(ScrClosure *job) {
  ScrFromDestroy *d = scr_box_get_ref(job->caps[0]);
  scr_next_tick(scr_from_destroy_closure((void *)&scr_from_destroy_tick, d));
  scr_from_destroy_release_v(d);
}

static void scr_from_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)cb;
  ScrFromDestroy *d = calloc(1, sizeof *d);
  if (!d) scr_stream_oom();
  d->rc = 1;
  d->s = scr_stream_retain(s);
  d->error = err ? scr_error_retain(err) : NULL;
  scr_queue_microtask(scr_from_destroy_closure((void *)&scr_from_destroy_job, d));
  scr_from_destroy_release_v(d);
}

/* getHighWaterMark: a non-negative integer, or ERR_INVALID_ARG_VALUE
 * (thrown; false on return). */
static bool scr_from_check_hwm(double hwm) {
  if (hwm >= 0 && hwm <= 9007199254740991.0 && hwm == (double)(int64_t)hwm) return true;
  char num[40];
  char msg[96];
  num[scr_f64_to_str(hwm, num)] = 0;
  int n = snprintf(msg, sizeof msg, "The property 'options.highWaterMark' is invalid. Received %s", num);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_ARG_VALUE");
  return false;
}

/* The stream from.js builds: object mode unless the options turn it off;
 * highWaterMark 1 for iterables, the mode's default for the string /
 * Buffer case or a nullish option, or the option's value. +1, or NULL with the error
 * pending. Moves f. */
/* from.js's `new Readable(...)`: a Readable, or for Duplex.from (duplexify.js's
 * from(Duplexify, body, { objectMode: true, writable: false })) a Duplexify
 * whose writable side is off. */
static ScrStream *scr_from_new(bool duplex, double hwm, ScrClosure *read, ScrStreamReadInv read_inv,
                               ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  if (!duplex) return scr_stream_new_readable(hwm, true, true, read, read_inv, destroy, destroy_inv);
  ScrStream *d = scr_stream_new_duplex(hwm, hwm, true, true, true, true, false, read, read_inv, NULL,
                                       NULL, NULL, NULL, destroy, destroy_inv);
  scr_stream_set_object_mode(d, false, true);
  d->cls = "Duplexify";
  return d;
}

static ScrStream *scr_from_stream(ScrFromSrc *f, ScrStreamReadInv read_inv, bool object_mode,
                                  int hwm_kind, double hwm, bool strings, bool duplex) {
  if (hwm_kind == SCR_FROM_HWM_SET && !scr_from_check_hwm(hwm)) {
    scr_from_src_release(f);
    return NULL;
  }
  if (hwm_kind == SCR_FROM_HWM_FROM && !f->single) hwm = 1;
  else if (hwm_kind != SCR_FROM_HWM_SET) hwm = object_mode ? 16 : -1;
  ScrClosure *read = scr_closure_new((void *)read_inv, 1);
  read->caps[0] = scr_box_new_obj(scr_from_src_retain_v, scr_from_src_release_v, NULL);
  scr_box_set_ref(read->caps[0], f); /* moves */
  ScrClosure *destroy = NULL;
  if (!f->single) destroy = scr_closure_new((void *)&scr_from_destroy_inv, 0);
  ScrStream *s = scr_from_new(duplex, hwm, read, read_inv, destroy,
                              destroy ? &scr_from_destroy_inv : NULL);
  ScrStreamState *st = s->st;
  if (object_mode) {
    st->r.object_entries = true;
    st->r.object_kind_set = strings || f->arr != NULL;
    st->r.encoded = strings;
    if (strings) st->r.enc = scr_str_new("utf8", 4);
  }
  return s;
}

/* Readable.from over a generator (scr_stream_ops.c): the stream from.js
 * builds around native read and destroy callbacks, with the options'
 * flags (SCR_FROM_BYTE_MODE, SCR_FROM_HAS_HWM). +1, or NULL with
 * ERR_INVALID_ARG_VALUE pending (the callbacks are released). */
ScrStream *scr_stream_new_from_readable(ScrClosure *read, ScrStreamReadInv read_inv,
                                        ScrClosure *destroy, ScrStreamErrInv destroy_inv,
                                        double flags, double hwm) {
  int bits = (int)flags;
  if ((bits & SCR_FROM_HAS_HWM) && !scr_from_check_hwm(hwm)) {
    scr_closure_release(read);
    scr_closure_release(destroy);
    return NULL;
  }
  bool object_mode = (bits & SCR_FROM_BYTE_MODE) == 0;
  if (bits & SCR_FROM_DEFAULT_HWM) hwm = object_mode ? 16 : -1;
  else if (!(bits & SCR_FROM_HAS_HWM)) hwm = 1;
  ScrStream *s = scr_from_new((bits & SCR_FROM_DUPLEX) != 0, hwm, read, read_inv, destroy, destroy_inv);
  if (object_mode) s->st->r.object_entries = true;
  return s;
}

ScrStream *scr_stream_from_arr(ScrArr *arr, double flags, double hwm) {
  int bits = (int)flags;
  ScrFromSrc *f = calloc(1, sizeof *f);
  if (!f) scr_stream_oom();
  f->rc = 1;
  f->arr = scr_arr_retain(arr);
  f->strings = (bits & SCR_FROM_STRINGS) != 0;
  f->single = (bits & SCR_FROM_SINGLE) != 0;
  return scr_from_stream(f, &scr_from_read_inv, (bits & SCR_FROM_BYTE_MODE) == 0,
                         (bits & SCR_FROM_HAS_HWM) ? SCR_FROM_HWM_SET : SCR_FROM_HWM_FROM, hwm,
                         f->strings, (bits & SCR_FROM_DUPLEX) != 0);
}

/* The JS lane: one checked-dynamic value into the stream. null is
 * ERR_STREAM_NULL_VALUES; in object mode every other value is an entry;
 * byte mode rejects values other than strings and Buffers with push()'s
 * ERR_INVALID_ARG_TYPE. Each failure destroys the stream and answers -1.
 * Borrows v. */
int scr_stream_from_push(ScrStream *s, const ScrDyn *v) {
  ScrError *e = NULL;
  if (v->kind == SCR_DYN_NULL) {
    static const char m[] = "May not write null values to stream";
    ScrStr *msg = scr_str_new(m, sizeof m - 1);
    e = scr_error_new(SCR_ERR_TYPE, msg);
    scr_str_release(msg);
    scr_error_set_code(e, "ERR_STREAM_NULL_VALUES");
  } else if (s->st->r.object_entries) {
    return scr_stream_push_object(s, v);
  } else if (v->kind == SCR_DYN_STR || v->kind == SCR_DYN_BYTES) {
    return scr_stream_push_dyn(s, v) ? 1 : 0;
  } else {
    char detail[256];
    char m[400];
    int n = snprintf(m, sizeof m,
                     "The \"chunk\" argument must be of type string or an instance of Buffer, "
                     "TypedArray, or DataView. Received %s",
                     scr_dyn_specific_type(v, detail, sizeof detail));
    ScrStr *msg = scr_str_new(m, (size_t)n);
    e = scr_error_new(SCR_ERR_TYPE, msg);
    scr_str_release(msg);
    scr_error_set_code(e, "ERR_INVALID_ARG_TYPE");
  }
  scr_stream_release(scr_stream_destroy(s, e));
  scr_error_release(e);
  return -1;
}

static void scr_from_read_dyn_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)size;
  ScrFromSrc *f = scr_box_get_ref(cb->caps[0]);
  if (f->single) {
    if (scr_stream_from_push(s, f->dyn) >= 0 && !scr_exc_pending()) scr_stream_push_null(s);
  } else if (!f->reading) {
    f->reading = true;
    for (;;) {
      if (f->i >= f->dyn->v.arr.len) {
        scr_stream_push_null(s);
        break;
      }
      ScrDyn *v = scr_dyn_arr_at(f->dyn, (double)f->i++);
      if (!v) break;
      if (v->kind == SCR_DYN_NULL) f->reading = false;
      int pushed = scr_stream_from_push(s, v);
      scr_dyn_release(v);
      if (pushed < 0 || scr_exc_pending()) break;
      if (!pushed) {
        f->reading = false;
        break;
      }
    }
  }
  scr_from_src_release(f);
}

static ScrStream *scr_from_dyn_ex(ScrDyn *src, ScrDyn *opts, bool duplex) {
  bool single = src->kind == SCR_DYN_STR || src->kind == SCR_DYN_BYTES;
  ScrDyn *iter = NULL; /* from.js's iterator, for sources other than arrays */
  int kind = 0;
  if (!single && src->kind == SCR_DYN_ARR) {
    kind = scr_dyn_iterable_kind(src);
    if (kind < 0) return NULL;
  } else if (!single) {
    iter = scr_dyn_from_iterator(src, &kind);
    if (kind < 0) return NULL;
  }
  if (!single && kind == 0) {
    if (duplex) {
      scr_dyn_arg_type_fail("body",
                            "of type function or an instance of Blob, ReadableStream, WritableStream, "
                            "Stream, Iterable, AsyncIterable, or Promise or { readable, writable } pair",
                            src);
    } else {
      scr_dyn_arg_type_fail("iterable", "an instance of Iterable", src);
    }
    return NULL;
  }
  bool object_mode = true;
  int hwm_kind = SCR_FROM_HWM_FROM;
  double hwm = 0;
  if (opts && opts->kind == SCR_DYN_OBJ) {
    /* new Readable({ objectMode: true, highWaterMark: 1, ...opts }) */
    ScrDyn *keys = scr_dyn_own_keys(opts);
    if (!keys) {
      if (iter) scr_dyn_release(iter);
      return NULL;
    }
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      ScrDyn *k = keys->v.arr.items[i];
      if (k->kind != SCR_DYN_STR) continue;
      ScrStr *name = k->v.str;
      if ((name->len == 10 && memcmp(name->data, "objectMode", 10) == 0) ||
          (name->len == 13 && memcmp(name->data, "highWaterMark", 13) == 0)) {
        continue;
      }
      char m[200];
      int n = snprintf(m, sizeof m, "the Readable.from option '%.*s' is not supported yet",
                       (int)(name->len > 64 ? 64 : name->len), name->data);
      scr_dyn_release(keys);
      if (iter) scr_dyn_release(iter);
      scr_throw_error_msg(SCR_ERR_ERROR, m, (size_t)n);
      return NULL;
    }
    scr_dyn_release(keys);
    ScrDyn *om = scr_dyn_obj_get(opts, "objectMode", 10);
    if (om) object_mode = scr_dyn_truthy(om);
    ScrDyn *h = scr_dyn_obj_get(opts, "highWaterMark", 13);
    if (h && (h->kind == SCR_DYN_UNDEF || h->kind == SCR_DYN_NULL)) {
      hwm_kind = SCR_FROM_HWM_DEFAULT;
    } else if (h) {
      double v = h->kind == SCR_DYN_NUM ? h->v.num : -1;
      if (!(v >= 0 && v <= 9007199254740991.0 && v == (double)(int64_t)v)) {
        if (iter) scr_dyn_release(iter);
        scr_dyn_arg_value_fail("options.highWaterMark", NULL, h);
        return NULL;
      }
      hwm_kind = SCR_FROM_HWM_SET;
      hwm = v;
    }
  }
  if (iter) {
    double flags = (object_mode ? 0 : SCR_FROM_BYTE_MODE) | (duplex ? SCR_FROM_DUPLEX : 0) |
                   (hwm_kind == SCR_FROM_HWM_SET       ? SCR_FROM_HAS_HWM
                    : hwm_kind == SCR_FROM_HWM_DEFAULT ? SCR_FROM_DEFAULT_HWM
                                                       : 0);
    return scr_stream_from_dyn_iter(iter, kind == 2, flags, hwm);
  }
  ScrFromSrc *f = calloc(1, sizeof *f);
  if (!f) scr_stream_oom();
  f->rc = 1;
  f->dyn = scr_dyn_retain(src);
  f->single = single;
  return scr_from_stream(f, &scr_from_read_dyn_inv, object_mode, hwm_kind, hwm, false, duplex);
}

ScrStream *scr_stream_from_dyn(ScrDyn *src, ScrDyn *opts) {
  return scr_from_dyn_ex(src, opts, false);
}

/* Duplex.from(body) over a checked-dynamic body (duplexify.js): a native
 * Duplex answers itself, a lone native Readable or Writable is wrapped, a
 * promise reads as its value, an iterable reads as Duplex.from does, and
 * the other bodies Node accepts (a function, a thenable, a { readable,
 * writable } pair) are not supported yet. */
static ScrStream *scr_stream_boxed(const ScrDyn *value);
static ScrStream *scr_dupx_from_boxed(ScrDyn *boxed);

ScrStream *scr_stream_duplex_from_dyn(ScrDyn *body) {
  ScrStream *native = scr_stream_of_handle(body); /* +1 */
  if (!native) native = scr_stream_boxed(body);   /* +1 */
  if (native) {
    if (native->st->has_r && native->st->has_w) return native;
    /* _duplexify({ readable }) / _duplexify({ writable }) */
    ScrStream *d = native->st->has_r ? scr_stream_duplexify(native, NULL)
                                     : scr_stream_duplexify(NULL, native);
    scr_stream_release(native);
    return d;
  }
  if (body->kind == SCR_DYN_PROMISE) return scr_dupx_from_boxed(scr_dyn_retain(body));
  bool unsupported = body->kind == SCR_DYN_FUNC;
  if (!unsupported && body->kind == SCR_DYN_OBJ) {
    static const char *const keys[] = {"then", "readable", "writable"};
    for (size_t i = 0; i < 3 && !unsupported; i++) {
      ScrDyn *v = scr_dyn_obj_get(body, keys[i], strlen(keys[i]));
      unsupported = v != NULL && v->kind != SCR_DYN_UNDEF;
    }
  }
  if (unsupported) {
    static const char msg[] = "Duplex.from over this body is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
    return NULL;
  }
  return scr_from_dyn_ex(body, NULL, true);
}

/* ── object-mode streams for the stream operators (scr_stream_ops.c) ──── */

/* Readable.from's stream (objectMode, highWaterMark 1) around native read
 * and destroy callbacks. +1; the callbacks move. */
ScrStream *scr_stream_new_object_readable(ScrClosure *read, ScrStreamReadInv read_inv,
                                          ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStream *s = scr_stream_new_readable(1, true, true, read, read_inv, destroy, destroy_inv);
  s->st->r.object_entries = true;
  return s;
}

/* The object-mode buffer starts holding dyn values: every buffered entry
 * is boxed. */
static void scr_stream_rbuf_to_dyn(ScrStreamState *st) {
  ScrEntryKind kind = scr_stream_rkind(st);
  for (size_t i = 0; i < st->r.n; i++) st->r.buf[i] = scr_stream_entry_box(st->r.buf[i], kind);
  st->r.dyn_entries = true;
  st->r.object_kind_set = true;
}

/* An object-mode entry in the buffer's representation (moves entry; +1).
 * A Buffer on a stream with a decoder decodes through it (Node's
 * decoder.write in readableAddChunkPushObjectMode); an entry of another
 * kind turns the buffer into dyn entries. */
static void *scr_stream_entry_convert_kind(ScrStreamState *st, void *entry, ScrEntryKind *kind) {
  ScrEntryKind want = scr_stream_rkind(st);
  if (*kind == want) return entry;
  if (*kind == SCR_ENTRY_BYTES && want == SCR_ENTRY_STR && st->r.decoding) {
    ScrBytes *b = entry;
    ScrStr *dec = scr_strdec_write(st->r.enc, st->r.dec_pending, b);
    st->r.dec_pending = scr_strdec_next(st->r.enc, st->r.dec_pending, b);
    scr_bytes_release(b);
    *kind = SCR_ENTRY_STR;
    return dec;
  }
  if (want != SCR_ENTRY_DYN) scr_stream_rbuf_to_dyn(st);
  ScrDyn *d = scr_stream_entry_box(entry, *kind);
  *kind = SCR_ENTRY_DYN;
  return d;
}

/* readableAddChunk in object mode: every value is one whole entry, empty
 * strings and Buffers included. kind gives entry's kind. Answers push()'s
 * result. */
static int scr_stream_add_entry(ScrStream *s, void *entry /*moves*/, ScrEntryKind kind) {
  ScrStreamState *st = s->st;
  if (!st->r.object_kind_set && st->r.length == 0) {
    /* the first entry picks the representation */
    st->r.object_kind_set = true;
    if (kind == SCR_ENTRY_STR && !st->r.encoded) {
      st->r.encoded = true;
      if (!st->r.enc) st->r.enc = scr_str_new("utf8", 4);
    } else if (kind == SCR_ENTRY_DYN) {
      st->r.dyn_entries = true;
    }
  }
  entry = scr_stream_entry_convert(st, entry, &kind);
  if (st->r.ended) {
    scr_stream_entry_release_kind(entry, kind);
    ScrError *e = scr_stream_mkerr("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return 0;
  }
  if (st->destroyed || st->errored) {
    scr_stream_entry_release_kind(entry, kind);
    return 0;
  }
  st->r.reading = false;
  if (st->r.flowing == 1 && st->r.length == 0 && !st->r.in_read_sync &&
      (st->r.data_listeners || st->pipes.n > 0)) {
    if (st->r.emitted_readable) st->r.emitted_readable = false;
    scr_stream_emit_data(s, entry, kind);
    scr_stream_entry_release_kind(entry, kind);
    if (scr_exc_pending()) return 0;
  } else {
    scr_stream_rbuf_push(st, entry, kind, false);
    if (st->r.need_readable) scr_stream_emit_readable_nt(s);
  }
  scr_stream_maybe_read_more(s);
  scr_stream_settle_next(s);
  return !st->r.ended && (st->r.length < st->r.hwm || st->r.length == 0);
}

/* push(value) on an object-mode stream: a string or a Buffer keeps its
 * kind, any other value is a dyn entry. Borrows v. */
int scr_stream_push_object(ScrStream *s, const ScrDyn *v) {
  void *entry;
  ScrEntryKind kind;
  if (v->kind == SCR_DYN_STR) {
    entry = scr_str_retain(v->v.str);
    kind = SCR_ENTRY_STR;
  } else if (v->kind == SCR_DYN_BYTES) {
    entry = scr_bytes_raw_view(v->v.bytes);
    kind = SCR_ENTRY_BYTES;
  } else {
    entry = scr_dyn_retain((ScrDyn *)v);
    kind = SCR_ENTRY_DYN;
  }
  return scr_stream_add_entry(s, entry, kind) ? 1 : 0;
}

/* ── the registration hook ('data'/'readable' listeners kick flow) ────── */

/* Readable.prototype.on('readable'): the first listener pauses the
 * stream and asks for a 'readable' event (a read(0) on a tick when the
 * buffer is empty). Node's async iterator registers one too. */
static void scr_stream_readable_listen(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->r.end_emitted || st->r.readable_listening) return;
  st->r.readable_listening = true;
  st->r.need_readable = true;
  st->r.flowing = 0;
  st->r.emitted_readable = false;
  if (st->r.length > 0) {
    scr_stream_emit_readable_nt(s);
  } else if (!st->r.reading) {
    /* nReadingNextTick: a read(0) kick on a tick */
    scr_st_tick(s, SCR_ST_READ0, NULL, NULL);
  }
}

static void scr_stream_on_listener(ScrEmitter *em, ScrStr *name) {
  if (!scr_stream_is(em)) return;
  ScrStream *s = (ScrStream *)em;
  ScrStreamState *st = s->st;
  if (!st || !st->has_r) return;
  if (name->len == 4 && memcmp(name->data, "data", 4) == 0) {
    st->r.readable_listening = scr_emitter_has(em, "readable");
    if (st->r.flowing != 0) {
      st->r.flowing = 1;
      scr_stream_resume_kick(s);
    }
  } else if (name->len == 8 && memcmp(name->data, "readable", 8) == 0) {
    scr_stream_readable_listen(s);
  }
}

/* ── writable internals ───────────────────────────────────────────────── */

static void scr_stream_wq_push(ScrStreamState *st, ScrBytes *chunk /*moves*/, ScrClosure *cb /*moves*/,
                               ScrDyn *enc /*moves*/) {
  if (st->w.n == st->w.cap) {
    st->w.cap = st->w.cap ? st->w.cap * 2 : 4;
    st->w.q = realloc(st->w.q, st->w.cap * sizeof *st->w.q);
    if (!st->w.q) scr_stream_oom();
  }
  st->w.q[st->w.n].chunk = chunk;
  st->w.q[st->w.n].cb = cb;
  st->w.q[st->w.n].enc = enc;
  st->w.n++;
}

static void scr_stream_transform_callback(ScrStream *s);

static void scr_stream_do_write_inner(ScrStream *s, ScrBytes *chunk /*moves*/, ScrClosure *cb /*moves*/);
static ScrDyn *scr_stream_wentry_value(const ScrStreamState *st, ScrBytes *chunk);
static ScrDyn *scr_stream_wentry_encoding(const ScrStreamState *st, ScrDyn *enc);

/* One write reaching _write/_transform; the callback reads the write's
 * encoding argument through w.cur_enc while it runs. */
static void scr_stream_do_write(ScrStream *s, ScrBytes *chunk /*moves*/, ScrClosure *cb /*moves*/,
                                ScrDyn *enc /*moves*/) {
  ScrStreamState *st = s->st;
  if (enc == NULL) {
    scr_stream_do_write_inner(s, chunk, cb);
    return;
  }
  ScrDyn *outer = st->w.cur_enc;
  st->w.cur_enc = enc;
  scr_stream_do_write_inner(s, chunk, cb);
  st->w.cur_enc = outer;
  scr_dyn_release(enc);
}

static void scr_stream_do_write_inner(ScrStream *s, ScrBytes *chunk /*moves*/, ScrClosure *cb /*moves*/) {
  ScrStreamState *st = s->st;
  st->w.writing = true;
  st->w.wsync = true;
  st->w.inflight_len = scr_stream_wchunk_len(st, chunk);
  st->w.inflight_cb = cb;
  if (st->is_transform || st->passthrough) st->xf_length = st->r.length;
  if (st->passthrough && st->transform_cb == NULL) {
    /* identity: push through, complete synchronously */
    if (st->w.values) scr_stream_push_dyn(s, (ScrDyn *)chunk);
    else scr_stream_add_chunk(s, chunk, false);
    scr_stream_wchunk_release(st, chunk);
    if (!scr_exc_pending()) scr_stream_transform_callback(s);
    st->w.wsync = false;
    return;
  }
  if (st->is_transform || st->passthrough) {
    if (st->transform_cb == NULL) {
      scr_stream_wchunk_release(st, chunk);
      ScrError *e = scr_stream_mkerr("ERR_METHOD_NOT_IMPLEMENTED", "The _transform() method is not implemented");
      st->w.wsync = false;
      scr_stream_error_or_destroy(s, e);
      scr_error_release(e);
      return;
    }
    st->transform_inv(st->transform_cb, s, chunk);
    scr_stream_wchunk_release(st, chunk);
    st->w.wsync = false;
    return;
  }
  if (st->w.write_cb == NULL && st->w.writev_cb) {
    /* Writable.prototype._write: this._writev([{ chunk, encoding }], cb) */
    ScrDyn *chunks = scr_dyn_new_arr();
    ScrDyn *entry = scr_dyn_new_obj();
    scr_dyn_obj_set(entry, "chunk", 5, scr_stream_wentry_value(st, chunk));
    scr_dyn_obj_set(entry, "encoding", 8, scr_stream_wentry_encoding(st, st->w.cur_enc));
    scr_dyn_arr_push(chunks, entry);
    scr_stream_wchunk_release(st, chunk);
    st->w.writev_inv(st->w.writev_cb, s, chunks);
    scr_dyn_release(chunks);
    st->w.wsync = false;
    return;
  }
  if (st->w.write_cb == NULL) {
    scr_stream_wchunk_release(st, chunk);
    ScrError *e = scr_stream_mkerr("ERR_METHOD_NOT_IMPLEMENTED", "The _write() method is not implemented");
    st->w.wsync = false;
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return;
  }
  st->w.write_inv(st->w.write_cb, s, chunk);
  scr_stream_wchunk_release(st, chunk);
  st->w.wsync = false;
}

/* errorBuffer: once destroyed, the buffered writes' callbacks and the
 * end(cb) callbacks run (Node passes them ERR_STREAM_DESTROYED or the
 * stream's error) — unless a write is in flight, whose completion runs
 * them instead. */
static void scr_stream_error_buffer(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->w.writing) return;
  while (st->w.head < st->w.n && !scr_exc_pending()) {
    ScrWEntry e = st->w.q[st->w.head++];
    st->w.length -= scr_stream_wchunk_len(st, e.chunk);
    scr_stream_wchunk_release(st, e.chunk);
    if (e.enc) scr_dyn_release(e.enc);
    if (e.cb) {
      ((void (*)(ScrClosure *))e.cb->fn)(e.cb);
      scr_closure_release(e.cb);
    }
  }
  if (st->w.head == st->w.n) {
    st->w.head = 0;
    st->w.n = 0;
  }
  while (st->w.end_cbs_n > 0 && !scr_exc_pending()) {
    ScrClosure *cb = st->w.end_cbs[0];
    memmove(st->w.end_cbs, st->w.end_cbs + 1, (st->w.end_cbs_n - 1) * sizeof *st->w.end_cbs);
    st->w.end_cbs_n--;
    ((void (*)(ScrClosure *))cb->fn)(cb);
    scr_closure_release(cb);
  }
}

/* afterWrite — Node's exact order: 'drain' first (when the queue is
 * empty), THEN the user's write(chunk, cb) callback, then finishMaybe.
 * The buffered queue was already restarted by write_done (Node's onwrite
 * calls clearBuffer before afterWrite). cb moves. */
static void scr_stream_after_write(ScrStream *s, ScrClosure *cb, size_t count) {
  ScrStreamState *st = s->st;
  if (st->w.length == 0 && st->w.need_drain && !st->w.ending && !st->destroyed) {
    st->w.need_drain = false;
    scr_stream_emit0(s, "drain");
    if (scr_exc_pending()) {
      if (cb) scr_closure_release(cb);
      return;
    }
    /* pipe sources waiting on this drain resume now */
    while (st->drain_srcs.n > 0) {
      ScrStream *src = st->drain_srcs.src[--st->drain_srcs.n];
      if (src->st && src->st->await_drain > 0 && --src->st->await_drain == 0 && !src->st->destroyed) {
        src->st->r.flowing = 1;
        scr_stream_resume_kick(src);
      }
      scr_stream_release(src);
    }
  }
  if (cb) {
    /* afterWrite: the callback once per write the tick completes */
    for (size_t i = 0; i < count; i++) {
      ((void (*)(ScrClosure *))cb->fn)(cb);
      if (scr_exc_pending()) break;
    }
    scr_closure_release(cb);
    if (scr_exc_pending()) return;
  }
  if (st->destroyed) {
    scr_stream_error_buffer(s);
    return;
  }
  scr_stream_finish_maybe(s);
}

/* A writev completion: runs the buffered callbacks (caps[i] box them) in
 * order. */
static void scr_stream_writev_cbs(ScrClosure *self) {
  for (size_t i = 0; i < self->ncaps; i++) {
    ScrClosure *cb = scr_box_get_ref(self->caps[i]);
    ((void (*)(ScrClosure *))cb->fn)(cb);
    scr_closure_release(cb);
    if (scr_exc_pending()) return;
  }
}

/* Node's clearBuffer with _writev: every buffered chunk goes out as one
 * write of their concatenation. */
static SCR_COLD void scr_stream_writev_buffer(ScrStream *s) {
  ScrStreamState *st = s->st;
  size_t total = 0, ncbs = 0;
  for (size_t i = st->w.head; i < st->w.n; i++) {
    total += st->w.q[i].chunk->len;
    if (st->w.q[i].cb) ncbs++;
  }
  ScrBytes *all = scr_bytes_new(SCR_BYTES_U8, (double)total);
  scr_stream_buffer(all);
  ScrClosure *cbs = ncbs > 0 ? scr_closure_new((void *)&scr_stream_writev_cbs, ncbs) : NULL;
  size_t off = 0, k = 0;
  for (size_t i = st->w.head; i < st->w.n; i++) {
    ScrWEntry e = st->w.q[i];
    memcpy(all->data + off, e.chunk->data, e.chunk->len);
    off += e.chunk->len;
    scr_bytes_release(e.chunk);
    if (e.cb) {
      cbs->caps[k] = scr_box_new_obj(&scr_closure_retain_v, &scr_closure_release_v,
                                     &scr_closure_trace_v);
      scr_box_set_ref(cbs->caps[k], e.cb); /* moves */
      k++;
    }
  }
  st->w.head = 0;
  st->w.n = 0;
  scr_stream_do_write(s, all, cbs, NULL);
}

/* A write's chunk and encoding as _writev receives them (+1 each). */
static ScrDyn *scr_stream_wentry_value(const ScrStreamState *st, ScrBytes *chunk) {
  if (st->w.values) return scr_dyn_retain((ScrDyn *)chunk);
  return chunk->is_buffer ? scr_dyn_new_buffer(chunk) : scr_dyn_new_bytes(chunk);
}

static ScrDyn *scr_stream_wentry_encoding(const ScrStreamState *st, ScrDyn *enc) {
  if (!st->w.values) {
    ScrStr *buffer = scr_str_new("buffer", 6);
    ScrDyn *d = scr_dyn_new_str(buffer);
    scr_str_release(buffer);
    return d;
  }
  return scr_dyn_retain(enc ? enc : scr_dyn_undefined());
}

/* A compiled writev whose entries declare `encoding` a string: an entry
 * without one (an object-mode write passes undefined or null) gets "".
 * The batch array is the one this call receives. */
void scr_stream_writev_fill_encodings(ScrDyn *chunks) {
  if (!chunks || chunks->kind != SCR_DYN_ARR) return;
  double n = scr_dyn_arr_len(chunks);
  for (double i = 0; i < n; i++) {
    ScrDyn *entry = scr_dyn_arr_at(chunks, i); /* +1 */
    ScrDyn *enc = entry->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(entry, "encoding", 8) : NULL;
    if (entry->kind == SCR_DYN_OBJ && (!enc || enc->kind == SCR_DYN_UNDEF || enc->kind == SCR_DYN_NULL)) {
      ScrStr *empty = scr_str_new("", 0);
      scr_dyn_obj_set(entry, "encoding", 8, scr_dyn_new_str(empty));
      scr_str_release(empty);
    }
    scr_dyn_release(entry);
  }
}

/* A batch entry's callback: the write's callback, or Node's nop. */
static ScrDyn *scr_stream_writev_entry_cb_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  if (clo->ncaps > 0) {
    ScrClosure *cb = scr_box_get_ref(clo->caps[0]);
    ((void (*)(ScrClosure *))cb->fn)(cb);
    scr_closure_release(cb);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_stream_writev_entry_cb(ScrClosure *cb /*borrowed or NULL*/) {
  ScrClosure *c = scr_closure_new((void *)&scr_stream_writev_entry_cb_call, cb ? 1 : 0);
  if (cb) {
    c->caps[0] = scr_box_new_obj(&scr_closure_retain_v, &scr_closure_release_v, &scr_closure_trace_v);
    scr_box_set_ref(c->caps[0], scr_closure_retain(cb));
  }
  return scr_dyn_new_func(c, &scr_stream_writev_entry_cb_call, 1, "(error)", cb ? "" : "nop");
}

/* Calls _writev with chunks as the in-flight write of len, whose
 * completion runs cb (moves; NULL when every write had none). */
static void scr_stream_writev_call(ScrStream *s, ScrDyn *chunks, size_t len, ScrClosure *cb) {
  ScrStreamState *st = s->st;
  st->w.writing = true;
  st->w.wsync = true;
  st->w.inflight_len = len;
  st->w.inflight_cb = cb;
  st->w.writev_inv(st->w.writev_cb, s, chunks);
  st->w.wsync = false;
}

/* Node's clearBuffer with _writev and more than one buffered write: the
 * writes go out as one [{ chunk, encoding, callback }] batch (its
 * allBuffers says whether every encoding is 'buffer'), and the batch's
 * completion runs the writes' callbacks in order. */
static void scr_stream_writev_batch(ScrStream *s) {
  ScrStreamState *st = s->st;
  size_t total = 0, ncbs = 0;
  for (size_t i = st->w.head; i < st->w.n; i++)
    if (st->w.q[i].cb) ncbs++;
  ScrClosure *cbs = ncbs > 0 ? scr_closure_new((void *)&scr_stream_writev_cbs, ncbs) : NULL;
  ScrDyn *chunks = scr_dyn_new_arr();
  bool all_buffers = true;
  size_t k = 0;
  for (size_t i = st->w.head; i < st->w.n; i++) {
    ScrWEntry e = st->w.q[i];
    total += scr_stream_wchunk_len(st, e.chunk);
    ScrDyn *entry = scr_dyn_new_obj();
    ScrDyn *encoding = scr_stream_wentry_encoding(st, e.enc);
    if (!(encoding->kind == SCR_DYN_STR && encoding->v.str->len == 6 &&
          memcmp(encoding->v.str->data, "buffer", 6) == 0))
      all_buffers = false;
    scr_dyn_obj_set(entry, "chunk", 5, scr_stream_wentry_value(st, e.chunk));
    scr_dyn_obj_set(entry, "encoding", 8, encoding);
    scr_dyn_obj_set(entry, "callback", 8, scr_stream_writev_entry_cb(e.cb));
    scr_dyn_arr_push(chunks, entry);
    scr_stream_wchunk_release(st, e.chunk);
    if (e.enc) scr_dyn_release(e.enc);
    if (e.cb) {
      cbs->caps[k] = scr_box_new_obj(&scr_closure_retain_v, &scr_closure_release_v,
                                     &scr_closure_trace_v);
      scr_box_set_ref(cbs->caps[k], e.cb); /* moves */
      k++;
    }
  }
  scr_dyn_arr_named_put(chunks, "allBuffers", 10, scr_dyn_new_bool(all_buffers));
  st->w.head = 0;
  st->w.n = 0;
  scr_stream_writev_call(s, chunks, total, cbs);
  scr_dyn_release(chunks);
}

/* The buffered writes, one at a time (Node's clearBuffer without _writev). */
static void scr_stream_clear_buffer_entries(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->w.buffer_processing) return;
  st->w.buffer_processing = true;
  if (st->w.writev_cb && !st->w.writing && st->w.n - st->w.head > 1 && st->w.corked == 0 &&
      !st->destroyed && !st->constructing && !scr_exc_pending()) {
    scr_stream_writev_batch(s);
    st->w.buffer_processing = false;
    return;
  }
  while (!st->w.writing && st->w.head < st->w.n && st->w.corked == 0 &&
         !st->destroyed && !scr_exc_pending()) {
    ScrWEntry e = st->w.q[st->w.head++];
    if (st->w.head == st->w.n) {
      st->w.head = 0;
      st->w.n = 0;
    }
    scr_stream_do_write(s, e.chunk, e.cb, e.enc);
  }
  st->w.buffer_processing = false;
}

/* An empty write queue has nothing to clear. */
static inline void scr_stream_clear_buffer_each(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->w.head < st->w.n) scr_stream_clear_buffer_entries(s);
}

/* The fs streams' clearBuffer: nothing while constructing, and _writev
 * for more than one buffered chunk. */
static SCR_COLD void scr_stream_clear_buffer_runtime(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->constructing) return;
  if (st->writev_concat && !st->w.writing && st->w.n - st->w.head > 1 && st->w.corked == 0 &&
      !st->destroyed && !scr_exc_pending()) {
    scr_stream_writev_buffer(s);
    return;
  }
  scr_stream_clear_buffer_each(s);
}

static void scr_stream_clear_buffer(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->writev_concat || st->constructing) {
    scr_stream_clear_buffer_runtime(s);
    return;
  }
  scr_stream_clear_buffer_each(s);
}

/* prefinish + 'finish' scheduling once the writable side has fully
 * drained after end(). */
static void scr_stream_finish_maybe(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (!st->w.ending || st->w.writing || st->w.head < st->w.n || st->w.finished ||
      st->destroyed || st->w.finish_scheduled || st->w.final_pending || st->flush_pending ||
      st->constructing) {
    /* a pending _final/_flush callback holds the finish (Node's
     * pendingcb), as does a construction in progress */
    return;
  }
  if (!st->w.prefinished && st->flush_on_prefinish) {
    /* The Transform's own 'prefinish' listener (registered first) runs
     * the flush; 'finish' follows on a tick. */
    st->w.prefinished = true;
    if (!st->flush_called) {
      st->flush_called = true;
      st->flush_inv(st->flush_cb, s);
      if (scr_exc_pending()) return;
    }
    scr_stream_emit0(s, "prefinish");
    if (scr_exc_pending()) return;
  }
  if (!st->w.prefinished) {
    if ((st->is_transform || st->passthrough) && !st->flush_called) {
      st->flush_called = true;
      if (st->flush_cb) {
        st->flush_pending = true;
        st->flush_inv(st->flush_cb, s);
        return; /* flush_done resumes the finish path */
      }
      /* no flush: EOF the readable side now */
      scr_stream_push_null(s);
      if (scr_exc_pending()) return;
    }
    if (st->w.final_cb && !st->w.final_called) {
      st->w.final_called = true;
      st->w.final_pending = true;
      st->w.final_inv(st->w.final_cb, s);
      return; /* final_done resumes the finish path */
    }
    st->w.prefinished = true;
    scr_stream_emit0(s, "prefinish");
    if (scr_exc_pending()) return;
  }
  /* prefinish ran; without a _final the deferred afterWrites still hold
   * 'finish' (Node's pendingcb), and the last of them comes back here.
   * A _final's callback puts 'finish' on a tick at once (callFinal's
   * onFinish), and a Transform's _final is its flush. */
  if (st->w.after_holds > 0 && !st->w.final_cb && !st->is_transform && !st->passthrough) return;
  st->w.finish_scheduled = true;
  scr_st_tick(s, SCR_ST_FINISH, NULL, NULL);
}

/* ── construction ─────────────────────────────────────────────────────── */

static ScrStreamState *scr_stream_state_new(bool has_r, bool has_w,
                                            double rhwm, double whwm, bool auto_destroy,
                                            bool emit_close, bool allow_half_open) {
  ScrStreamState *st = calloc(1, sizeof *st);
  if (!st) scr_stream_oom();
  st->has_r = has_r;
  st->has_w = has_w;
  st->auto_destroy = auto_destroy;
  st->emit_close = emit_close;
  st->allow_half_open = allow_half_open;
  st->r.hwm = rhwm >= 0 ? (size_t)rhwm : SCR_STREAM_DEFAULT_HWM;
  st->w.hwm = whwm >= 0 ? (size_t)whwm : SCR_STREAM_DEFAULT_HWM;
  st->r.flowing = -1;
  /* Node's ReadableState.sync starts TRUE: pushes before the first _read
   * attempt take the buffered path (never the direct 'data' emit). */
  st->r.in_read_sync = true;
  return st;
}

/* The registry's empty/nonempty transitions for the names the per-chunk
 * paths test (scr_emitter_observe): no script runs here. */
static void scr_stream_listener_observe(void *context, const ScrStr *name, bool present) {
  ScrStream *s = context;
  if (s->st != NULL && name->len == 4 && memcmp(name->data, "data", 4) == 0)
    s->st->r.data_listeners = present;
}

/* Starts tracking the stream's 'data' listeners, once its state exists. */
static void scr_stream_watch_listeners(ScrStream *s) {
  s->st->r.data_listeners = scr_emitter_has((ScrEmitter *)s, "data");
  scr_emitter_observe((ScrEmitter *)s, &scr_stream_listener_observe, s);
}

static ScrStream *scr_stream_alloc(const ScrVt *vt, const char *cls, bool has_r, bool has_w,
                                    double rhwm, double whwm, bool auto_destroy,
                                    bool emit_close, bool allow_half_open) {
  static ScrCycType cyc_type = { &scr_stream_trace, &scr_stream_gcfree, SCR_CYC_KIND_STREAM };
  ScrStream *s = scr_cyc_alloc(sizeof *s, &cyc_type);
  s->rc = 1;
  s->vt = vt;
  s->reg = NULL;
  s->cls = cls;
  s->st = scr_stream_state_new(has_r, has_w, rhwm, whwm, auto_destroy, emit_close, allow_half_open);
  /* Node's stream constructors pre-create their known _events keys (a V8
   * shape optimization) — eventNames() lists these BEFORE user events
   * added earlier. Same names, same order: Readable close/error/data/end/
   * readable, Writable close/error/prefinish/finish/drain, Duplex the
   * union (writable trio first — Node's observed key order). */
  ScrEmitter *em = (ScrEmitter *)s;
  scr_emitter_reserve(em, "close");
  scr_emitter_reserve(em, "error");
  if (has_w) {
    scr_emitter_reserve(em, "prefinish");
    scr_emitter_reserve(em, "finish");
    scr_emitter_reserve(em, "drain");
  }
  if (has_r) {
    scr_emitter_reserve(em, "data");
    scr_emitter_reserve(em, "end");
    scr_emitter_reserve(em, "readable");
  }
  scr_stream_watch_listeners(s);
  scr_obj_alloc_note();
  return s;
}

ScrStream *scr_stream_new_readable(double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStream *s = scr_stream_alloc(&scr_readable_vt, "Readable", true, false,
                                   hwm, -1, auto_destroy, emit_close, true);
  s->st->r.read_cb = read;
  s->st->r.read_inv = read_inv;
  s->st->destroy_cb = destroy;
  s->st->destroy_inv = destroy_inv;
  return s;
}

ScrStream *scr_stream_new_writable(double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStream *s = scr_stream_alloc(&scr_writable_vt, "Writable", false, true,
                                   -1, hwm, auto_destroy, emit_close, true);
  s->st->w.write_cb = write;
  s->st->w.write_inv = write_inv;
  s->st->w.final_cb = final_cb;
  s->st->w.final_inv = final_inv;
  s->st->destroy_cb = destroy;
  s->st->destroy_inv = destroy_inv;
  return s;
}

ScrStream *scr_stream_new_duplex(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStream *s = scr_stream_alloc(&scr_duplex_vt, "Duplex", readable_side, writable_side,
                                   rhwm, whwm, auto_destroy, emit_close, allow_half_open);
  if (!readable_side) {
    /* Node: a { readable: false } duplex reads as an already-ended half */
    s->st->r.ended = true;
    s->st->r.end_emitted = true;
  }
  if (!writable_side) {
    s->st->w.ending = true;
    s->st->w.finished = true;
  }
  s->st->r.read_cb = read;
  s->st->r.read_inv = read_inv;
  s->st->w.write_cb = write;
  s->st->w.write_inv = write_inv;
  s->st->w.final_cb = final_cb;
  s->st->w.final_inv = final_inv;
  s->st->destroy_cb = destroy;
  s->st->destroy_inv = destroy_inv;
  return s;
}

static ScrStream *scr_stream_new_transformish(const ScrVt *vt, const char *cls, bool passthrough,
    double rhwm, double whwm, bool auto_destroy, bool emit_close, bool allow_half_open,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStream *s = scr_stream_alloc(vt, cls, true, true, rhwm, whwm,
                                   auto_destroy, emit_close, allow_half_open);
  s->st->is_transform = !passthrough;
  s->st->passthrough = passthrough;
  /* Node's Transform constructor: the readable half starts with
   * sync=false and needReadable=true (transformed data direct-emits). */
  s->st->r.in_read_sync = false;
  s->st->r.need_readable = true;
  s->st->transform_cb = transform;
  s->st->transform_inv = transform_inv;
  s->st->flush_cb = flush;
  s->st->flush_inv = flush_inv;
  s->st->destroy_cb = destroy;
  s->st->destroy_inv = destroy_inv;
  return s;
}

ScrStream *scr_stream_new_transform(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  (void)readable_side;
  (void)writable_side;
  return scr_stream_new_transformish(&scr_transform_vt, "Transform", false,
      rhwm, whwm, auto_destroy, emit_close, allow_half_open,
      transform, transform_inv, flush, flush_inv, destroy, destroy_inv);
}

ScrStream *scr_stream_new_passthrough(double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  (void)readable_side;
  (void)writable_side;
  ScrStream *s = scr_stream_new_transformish(&scr_passthrough_vt, "PassThrough",
      transform == NULL, rhwm, whwm, auto_destroy, emit_close, allow_half_open,
      transform, transform_inv, flush, flush_inv, destroy, destroy_inv);
  if (transform != NULL) s->st->is_transform = true;
  return s;
}

/* ── subclass initialization (the emitted super(options) call) ────────── */

/* A compiler-emitted `extends Readable` subclass allocates its own struct
 * (vt stamped with the SUBCLASS vtable, display name stamped, registry
 * and state NULL — the emitter-subclass story plus one slot); super(
 * options) lands here to build the stream state. The callback closures
 * move; overridden underscore methods arrive as compiler-synthesized
 * wrapper closures dispatching through the vt, so a further-derived
 * override wins even when an inherited constructor runs the init. */

void scr_stream_init_readable(ScrStream *s, double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStreamState *st = scr_stream_state_new(true, false, hwm, -1, auto_destroy, emit_close, true);
  s->st = st;
  scr_stream_watch_listeners(s);
  st->r.read_cb = read;
  st->r.read_inv = read_inv;
  st->destroy_cb = destroy;
  st->destroy_inv = destroy_inv;
}

void scr_stream_init_writable(ScrStream *s, double hwm, bool auto_destroy, bool emit_close,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStreamState *st = scr_stream_state_new(false, true, -1, hwm, auto_destroy, emit_close, true);
  s->st = st;
  scr_stream_watch_listeners(s);
  st->w.write_cb = write;
  st->w.write_inv = write_inv;
  st->w.final_cb = final_cb;
  st->w.final_inv = final_inv;
  st->destroy_cb = destroy;
  st->destroy_inv = destroy_inv;
}

void scr_stream_init_duplex(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *read, ScrStreamReadInv read_inv,
    ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStreamState *st = scr_stream_state_new(readable_side, writable_side, rhwm, whwm,
                                            auto_destroy, emit_close, allow_half_open);
  s->st = st;
  scr_stream_watch_listeners(s);
  if (!readable_side) {
    st->r.ended = true;
    st->r.end_emitted = true;
  }
  if (!writable_side) {
    st->w.ending = true;
    st->w.finished = true;
  }
  st->r.read_cb = read;
  st->r.read_inv = read_inv;
  st->w.write_cb = write;
  st->w.write_inv = write_inv;
  st->w.final_cb = final_cb;
  st->w.final_inv = final_inv;
  st->destroy_cb = destroy;
  st->destroy_inv = destroy_inv;
}

static void scr_stream_init_transformish(ScrStream *s, bool passthrough,
    double rhwm, double whwm, bool auto_destroy, bool emit_close, bool allow_half_open,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  ScrStreamState *st = scr_stream_state_new(true, true, rhwm, whwm,
                                            auto_destroy, emit_close, allow_half_open);
  s->st = st;
  scr_stream_watch_listeners(s);
  st->is_transform = !passthrough;
  st->passthrough = passthrough;
  /* the Transform constructor's readable-half stance (see new_transformish) */
  st->r.in_read_sync = false;
  st->r.need_readable = true;
  st->transform_cb = transform;
  st->transform_inv = transform_inv;
  st->flush_cb = flush;
  st->flush_inv = flush_inv;
  st->destroy_cb = destroy;
  st->destroy_inv = destroy_inv;
}

void scr_stream_init_transform(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  (void)readable_side;
  (void)writable_side;
  scr_stream_init_transformish(s, false, rhwm, whwm, auto_destroy, emit_close, allow_half_open,
      transform, transform_inv, flush, flush_inv, destroy, destroy_inv);
}

void scr_stream_init_passthrough(ScrStream *s, double rhwm, double whwm, bool auto_destroy,
    bool emit_close, bool allow_half_open, bool readable_side, bool writable_side,
    ScrClosure *transform, ScrStreamChunkInv transform_inv,
    ScrClosure *flush, ScrStreamPlainInv flush_inv,
    ScrClosure *destroy, ScrStreamErrInv destroy_inv) {
  (void)readable_side;
  (void)writable_side;
  scr_stream_init_transformish(s, transform == NULL, rhwm, whwm, auto_destroy, emit_close,
      allow_half_open, transform, transform_inv, flush, flush_inv, destroy, destroy_inv);
}

/* ── the underscore-method assignment surface ─────────────────────────
 * `r._read = fn` / `w._write = fn` (and _final/_destroy/_transform/
 * _flush) AFTER construction: Node assigns an own property that shadows
 * the prototype method, and the machinery calls through it from then on.
 * Here the same slot the option callbacks fill swaps its closure — the
 * old callback releases, the new one (+1, moves) takes the slot with its
 * compiler-emitted invoke thunk. In-flight operations already dispatched
 * through the OLD callback complete against it (they hold no further
 * reference); the next _read/_write/... dispatch uses the new one, which
 * is Node's own timing. A NULL state block (assignment before a
 * subclass's super()) cannot be reached from lowered code — super()
 * lowers before any statement that could see `this`. */
void scr_stream_set_read(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamReadInv inv) {
  ScrStreamState *st = s->st;
  if (st->r.read_cb) scr_closure_release(st->r.read_cb);
  st->r.read_cb = cb;
  st->r.read_inv = inv;
}

void scr_stream_set_write(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamChunkInv inv) {
  ScrStreamState *st = s->st;
  if (st->w.write_cb) scr_closure_release(st->w.write_cb);
  st->w.write_cb = cb;
  st->w.write_inv = inv;
}

void scr_stream_set_final(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamPlainInv inv) {
  ScrStreamState *st = s->st;
  if (st->w.final_cb) scr_closure_release(st->w.final_cb);
  st->w.final_cb = cb;
  st->w.final_inv = inv;
}

void scr_stream_set_destroy(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamErrInv inv) {
  ScrStreamState *st = s->st;
  if (st->destroy_cb) scr_closure_release(st->destroy_cb);
  st->destroy_cb = cb;
  st->destroy_inv = inv;
}

void scr_stream_set_transform(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamChunkInv inv) {
  ScrStreamState *st = s->st;
  if (st->transform_cb) scr_closure_release(st->transform_cb);
  st->transform_cb = cb;
  st->transform_inv = inv;
}

void scr_stream_set_flush(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamPlainInv inv) {
  ScrStreamState *st = s->st;
  if (st->flush_cb) scr_closure_release(st->flush_cb);
  st->flush_cb = cb;
  st->flush_inv = inv;
}

void scr_stream_set_flush_on_prefinish(ScrStream *s) { s->st->flush_on_prefinish = true; }

void scr_stream_set_destroyed(ScrStream *s, bool destroyed) { s->st->destroyed = destroyed; }

void scr_stream_set_native(ScrStream *s, void *state /*moves*/, void (*release)(void *)) {
  ScrStreamState *st = s->st;
  if (st->native) st->native_release(st->native);
  st->native = state;
  st->native_release = release;
}

void *scr_stream_native(ScrStream *s, void (*release)(void *)) {
  ScrStreamState *st = s->st;
  return st != NULL && st->native != NULL && st->native_release == release ? st->native : NULL;
}

/* ── dyn options (a checked-dynamic options record at construction) ─────
 *
 * The JS lane's `constructor(options) { super(options); }` forwarding and
 * `new Readable(dynVar)`: the record's SHAPE is runtime data, so the
 * option walk happens here — scalar options read with Node's own rules
 * (highWaterMark wins over the sided keys; autoDestroy/emitClose/
 * allowHalfOpen and the Duplex side toggles compare `!== false`; unknown
 * keys are ignored exactly like Node), and callback slots holding
 * callable values (Node's `typeof === 'function'` guard — anything else
 * leaves the slot to the prototype/fallback) bind as closures whose one
 * cap boxes the dyn callable; the invs below build the dyn arguments the
 * way the compiler-emitted dyn thunks do (chunk as Buffer-flavored bytes,
 * encoding 'buffer', the error via the boundary encoding, the completion
 * callback as a callable dyn over the *_done glue). Options that Node's
 * base WOULD consume but have no lowering here (signal, and
 * read/write/final on the transformish bases) throw the
 * "not supported yet" Error — the compile-time fence's runtime twin. */

/* The boxed dyn callable (+1 — scr_box_get_ref retains; callers release
 * after the call). */
static ScrDyn *scr_stream_dynopt_target(ScrClosure *cb) {
  return scr_box_get_ref(cb->caps[0]);
}

static ScrDyn *scr_stream_dynopt_done(ScrStream *s, ScrDynThunk glue, uint32_t arity, const char *sig) {
  ScrClosure *c = scr_closure_new((void *)glue, 1);
  c->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
  scr_box_set_ref(c->caps[0], scr_stream_retain(s));
  return scr_dyn_new_func(c, glue, arity, sig, "callback");
}

static void scr_stream_dynopt_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)s;
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *a = scr_dyn_new_num(size);
  ScrDyn *r = scr_dyn_call(fn, &a, 1, "read");
  scr_dyn_release(a);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static void scr_stream_dynopt_chunk3(ScrClosure *cb, ScrStream *s, ScrBytes *chunk,
                                     ScrDynThunk glue, const char *what) {
  ScrDyn *args[3];
  /* (chunk, encoding, cb): an object-mode side passes the value and the
   * write's encoding argument, as Node's Writable does */
  args[0] = scr_stream_chunk_value(s, chunk);
  args[1] = scr_stream_chunk_encoding_value(s);
  args[2] = scr_stream_dynopt_done(s, glue, 1, "(error)");
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *r = scr_dyn_call(fn, args, 3, what);
  for (int i = 0; i < 3; i++) scr_dyn_release(args[i]);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static void scr_stream_dynopt_write_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  scr_stream_dynopt_chunk3(cb, s, chunk, &scr_stream_done_dyn_w, "write");
}

static void scr_stream_dynopt_transform_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  ScrDyn *args[3];
  args[0] = scr_stream_chunk_value(s, chunk);
  args[1] = scr_stream_chunk_encoding_value(s);
  args[2] = scr_stream_dynopt_done(s, &scr_stream_done_dyn_t, 2, "(error,data)");
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *r = scr_dyn_call(fn, args, 3, "transform");
  for (int i = 0; i < 3; i++) scr_dyn_release(args[i]);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static void scr_stream_dynopt_construct_inv(ScrClosure *cb, ScrStream *s) {
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *a = scr_stream_dynopt_done(s, &scr_stream_done_dyn_c, 1, "(error)");
  ScrDyn *r = scr_dyn_call(fn, &a, 1, "construct");
  scr_dyn_release(a);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static void scr_stream_dynopt_writev_inv(ScrClosure *cb, ScrStream *s, ScrDyn *chunks) {
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *args[2];
  args[0] = scr_dyn_retain(chunks);
  args[1] = scr_stream_dynopt_done(s, &scr_stream_done_dyn_w, 1, "(error)");
  ScrDyn *r = scr_dyn_call(fn, args, 2, "writev");
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static void scr_stream_dynopt_final_inv(ScrClosure *cb, ScrStream *s) {
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *a = scr_stream_dynopt_done(s, &scr_stream_done_dyn_f, 1, "(error)");
  ScrDyn *r = scr_dyn_call(fn, &a, 1, "final");
  scr_dyn_release(a);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static void scr_stream_dynopt_flush_inv(ScrClosure *cb, ScrStream *s) {
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *a = scr_stream_dynopt_done(s, &scr_stream_done_dyn_l, 2, "(error,data)");
  ScrDyn *r = scr_dyn_call(fn, &a, 1, "flush");
  scr_dyn_release(a);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static void scr_stream_dynopt_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  ScrDyn *args[2];
  args[0] = err != NULL ? scr_dyn_from_error(err) : scr_dyn_new_null();
  args[1] = scr_stream_dynopt_done(s, &scr_stream_done_dyn_d, 1, "(error)");
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *r = scr_dyn_call(fn, args, 2, "destroy");
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static ScrClosure *scr_stream_dynopt_clo(ScrDyn *fn, void *inv) {
  ScrClosure *c = scr_closure_new(inv, 1);
  c->caps[0] = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_dyn_retain(fn));
  return c;
}

typedef struct {
  double rhwm, whwm;
  bool auto_destroy, emit_close, allow_half_open;
  bool readable_side, writable_side;
  bool readable_object, writable_object; /* objectMode and the sided keys */
  bool decode_strings_off;               /* decodeStrings: false */
  ScrStr *enc; /* owned canonical name, or NULL */
  /* defaultEncoding other than utf8: as given (borrowed) and canonical
   * (owned), or NULL */
  ScrStr *default_enc, *default_canonical;
  /* BORROWED callable fields (owned by the options record). */
  ScrDyn *read, *write, *final_fn, *destroy, *transform, *flush, *construct, *writev;
} ScrStreamDynOpts;

/* Node's `=== false` comparisons (autoDestroy/emitClose/allowHalfOpen and
 * the Duplex side toggles: `options.x !== false` — 0 does NOT disable). */
static bool scr_stream_dynopt_false(const ScrDyn *v) {
  return v != NULL && v->kind == SCR_DYN_BOOL && !v->v.b;
}

/* getHighWaterMark: highWaterMark, else (for Duplex sides) the sided key;
 * a present value must be a nonnegative integer, or Node throws
 * ERR_INVALID_ARG_VALUE naming the sided key on a Duplex. Answers -1 when
 * absent, -2 with the exception pending. */
static double scr_stream_dynopt_hwm(const ScrDyn *o, const char *sided, const char *name) {
  ScrDyn *v = scr_dyn_obj_get((ScrDyn *)o, "highWaterMark", 13);
  if ((v == NULL || v->kind == SCR_DYN_NULL || v->kind == SCR_DYN_UNDEF) && sided != NULL) {
    v = scr_dyn_obj_get((ScrDyn *)o, sided, strlen(sided));
  }
  if (v == NULL || v->kind == SCR_DYN_NULL || v->kind == SCR_DYN_UNDEF) return -1;
  if (v->kind != SCR_DYN_NUM || !(isfinite(v->v.num) && trunc(v->v.num) == v->v.num) || v->v.num < 0) {
    scr_dyn_arg_value_fail(name, NULL, v);
    return -2;
  }
  return v->v.num;
}

static ScrDyn *scr_stream_dynopt_fn(const ScrDyn *o, const char *key, size_t klen) {
  ScrDyn *v = scr_dyn_obj_get((ScrDyn *)o, key, klen);
  return v != NULL && v->kind == SCR_DYN_FUNC ? v : NULL; /* Node's typeof guard */
}

static bool scr_stream_dynopt_truthy(const ScrDyn *o, const char *key, size_t klen) {
  ScrDyn *v = scr_dyn_obj_get((ScrDyn *)o, key, klen);
  return v != NULL && scr_dyn_truthy(v);
}

static bool scr_stream_dynopt_unsupported(const char *msg, size_t len) {
  scr_throw_error_msg(SCR_ERR_ERROR, msg, len);
  return false;
}

/* The runtime twin of the frontend's literal-encoding fold (BUF_ENCODINGS):
 * canonicalizes or throws Node's ERR_UNKNOWN_ENCODING TypeError. */
static ScrStr *scr_stream_dynopt_encoding(const ScrStr *raw) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"}, {"base64", "base64"},
    {"base64url", "base64url"}, {"latin1", "latin1"}, {"binary", "latin1"},
    {"ascii", "ascii"}, {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"},
  };
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
    size_t n = strlen(map[i].from);
    if (raw->len == n && memcmp(raw->data, map[i].from, n) == 0) {
      return scr_str_new(map[i].to, strlen(map[i].to));
    }
  }
  char msg[128];
  int len = snprintf(msg, sizeof msg, "Unknown encoding: %.*s",
                     (int)(raw->len < 64 ? raw->len : 64), raw->data);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)(len < 0 ? 0 : len), "ERR_UNKNOWN_ENCODING");
  return NULL;
}

/* Parses a dyn options record for one base ('r','w','d','t','p'); false
 * with the exception pending when a consumed-but-unlowered option rides. */
static bool scr_stream_parse_dyn_opts(const ScrDyn *opts, char base, ScrStreamDynOpts *out) {
  out->rhwm = -1;
  out->whwm = -1;
  out->auto_destroy = true;
  out->emit_close = true;
  out->allow_half_open = true;
  out->readable_side = true;
  out->writable_side = true;
  out->enc = NULL;
  out->readable_object = out->writable_object = false;
  out->decode_strings_off = false;
  out->default_enc = out->default_canonical = NULL;
  out->read = out->write = out->final_fn = out->destroy = out->transform = out->flush = NULL;
  out->construct = out->writev = NULL;
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return true; /* Node's `if (options)` */
  const bool duplexish = base == 'd' || base == 't' || base == 'p';
  const bool transformish = base == 't' || base == 'p';
  const bool r_sided = base != 'w';

  {
    bool object = scr_stream_dynopt_truthy(opts, "objectMode", 10);
    out->readable_object = object || (duplexish && scr_stream_dynopt_truthy(opts, "readableObjectMode", 18));
    out->writable_object = object || (duplexish && scr_stream_dynopt_truthy(opts, "writableObjectMode", 18));
  }
  /* WritableState: decodeStrings === false keeps string writes */
  out->decode_strings_off =
      base != 'r' && scr_stream_dynopt_false(scr_dyn_obj_get((ScrDyn *)opts, "decodeStrings", 13));
  {
    ScrDyn *v = scr_dyn_obj_get((ScrDyn *)opts, "signal", 6);
    if (v != NULL && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_UNDEF) {
      static const char m[] = "the stream option 'signal' is not supported yet (AbortSignal-driven destruction has no lowering)";
      return scr_stream_dynopt_unsupported(m, sizeof m - 1);
    }
  }
  out->construct = scr_stream_dynopt_fn(opts, "construct", 9);
  /* a Transform's batches reach writev, not the transform, as in Node */
  if (base != 'r') out->writev = scr_stream_dynopt_fn(opts, "writev", 6);
  {
    /* a known encoding or ERR_UNKNOWN_ENCODING (the states' constructors) */
    ScrDyn *v = scr_dyn_obj_get((ScrDyn *)opts, "defaultEncoding", 15);
    if (v != NULL && v->kind == SCR_DYN_STR &&
        !(v->v.str->len == 4 && memcmp(v->v.str->data, "utf8", 4) == 0) &&
        !(v->v.str->len == 5 && memcmp(v->v.str->data, "utf-8", 5) == 0)) {
      ScrStr *canonical = scr_bytes_normalize_encoding(v->v.str);
      if (canonical == NULL) return false;
      out->default_enc = v->v.str;
      out->default_canonical = canonical;
    }
  }
  if (transformish) {
    /* Node's Transform would install these UNDER the transform machinery
     * (Duplex consumes read/write/final before Transform overrides). */
    if (scr_stream_dynopt_fn(opts, "read", 4) != NULL ||
        scr_stream_dynopt_fn(opts, "write", 5) != NULL ||
        scr_stream_dynopt_fn(opts, "final", 5) != NULL) {
      static const char m[] = "a read/write/final option on a Transform is not supported yet (it would replace the transform composition)";
      return scr_stream_dynopt_unsupported(m, sizeof m - 1);
    }
  }

  /* highWaterMark wins over the sided keys (Node's getHighWaterMark);
   * the readable side is checked first, as Duplex's Readable constructor
   * runs first. An object-mode side defaults to 16 entries. */
  if (duplexish) {
    out->rhwm = scr_stream_dynopt_hwm(opts, "readableHighWaterMark", "options.readableHighWaterMark");
    if (out->rhwm == -2) return false;
    out->whwm = scr_stream_dynopt_hwm(opts, "writableHighWaterMark", "options.writableHighWaterMark");
    if (out->whwm == -2) return false;
  } else {
    double hwm = scr_stream_dynopt_hwm(opts, NULL, "options.highWaterMark");
    if (hwm == -2) return false;
    out->rhwm = out->whwm = hwm;
  }
  if (out->rhwm == -1 && out->readable_object) out->rhwm = 16;
  if (out->whwm == -1 && out->writable_object) out->whwm = 16;
  out->auto_destroy = !scr_stream_dynopt_false(scr_dyn_obj_get((ScrDyn *)opts, "autoDestroy", 11));
  out->emit_close = !scr_stream_dynopt_false(scr_dyn_obj_get((ScrDyn *)opts, "emitClose", 9));
  if (duplexish) {
    out->allow_half_open = !scr_stream_dynopt_false(scr_dyn_obj_get((ScrDyn *)opts, "allowHalfOpen", 13));
    out->readable_side = !scr_stream_dynopt_false(scr_dyn_obj_get((ScrDyn *)opts, "readable", 8));
    out->writable_side = !scr_stream_dynopt_false(scr_dyn_obj_get((ScrDyn *)opts, "writable", 8));
  }
  if (r_sided) {
    ScrDyn *v = scr_dyn_obj_get((ScrDyn *)opts, "encoding", 8);
    if (v != NULL && v->kind == SCR_DYN_STR) {
      out->enc = scr_stream_dynopt_encoding(v->v.str);
      if (out->enc == NULL) return false;
    }
  }
  out->destroy = scr_stream_dynopt_fn(opts, "destroy", 7);
  if (transformish) {
    out->transform = scr_stream_dynopt_fn(opts, "transform", 9);
    out->flush = scr_stream_dynopt_fn(opts, "flush", 5);
  } else {
    if (base != 'w') out->read = scr_stream_dynopt_fn(opts, "read", 4);
    if (base != 'r') {
      out->write = scr_stream_dynopt_fn(opts, "write", 5);
      out->final_fn = scr_stream_dynopt_fn(opts, "final", 5);
    }
  }
  return true;
}

/* One slot: an options callback SHADOWS the fallback (Node's instance-
 * property-over-prototype rule); the unused fallback releases. */
static ScrClosure *scr_stream_dynopt_pick(ScrDyn *opt, void *dyn_inv, ScrClosure *fb, void *fb_inv, void **inv_out) {
  if (opt != NULL) {
    if (fb != NULL) scr_closure_release(fb);
    *inv_out = dyn_inv;
    return scr_stream_dynopt_clo(opt, dyn_inv);
  }
  *inv_out = fb != NULL ? fb_inv : NULL;
  return fb;
}

static void scr_stream_dynopt_construct_inv(ScrClosure *cb, ScrStream *s);
static void scr_stream_dynopt_writev_inv(ScrClosure *cb, ScrStream *s, ScrDyn *chunks);

/* The options a dyn constructor applies over the fresh stream: the object
 * modes, decodeStrings, defaultEncoding (the push decoding of a readable
 * side and the writes of a writable side), writev, and construct, which
 * Node's constructor schedules last. Releases the owned canonical name. */
static void scr_stream_dynopt_apply_object(ScrStream *s, ScrStreamDynOpts *o) {
  if (s != NULL && s->st != NULL) {
    scr_stream_set_object_mode(s, o->readable_object, o->writable_object);
    if (o->decode_strings_off) scr_stream_set_decode_strings(s, false);
    if (o->default_enc) {
      scr_stream_set_write_encoding(s, o->default_enc);
      if (s->st->has_r && !s->st->r.object_entries)
        scr_stream_release(scr_stream_set_push_encoding(s, o->default_canonical));
    }
    if (o->writev && s->st->has_w)
      scr_stream_set_writev(s, scr_stream_dynopt_clo(o->writev, (void *)&scr_stream_dynopt_writev_inv),
                            &scr_stream_dynopt_writev_inv);
    if (o->construct)
      scr_stream_set_construct(s, scr_stream_dynopt_clo(o->construct, (void *)&scr_stream_dynopt_construct_inv),
                               &scr_stream_dynopt_construct_inv);
  }
  if (o->default_canonical) {
    scr_str_release(o->default_canonical);
    o->default_canonical = NULL;
  }
}

static void scr_stream_dynopt_apply_enc(ScrStream *s, ScrStr *enc) {
  if (enc == NULL) return;
  ScrStream *chain = scr_stream_set_encoding(s, enc);
  scr_stream_release(chain);
  scr_str_release(enc);
}

ScrStream *scr_stream_new_readable_dyn(ScrDyn *opts) {
  ScrStreamDynOpts o;
  if (!scr_stream_parse_dyn_opts(opts, 'r', &o)) return NULL;
  void *rinv = NULL, *dinv = NULL;
  ScrClosure *read = scr_stream_dynopt_pick(o.read, (void *)&scr_stream_dynopt_read_inv, NULL, NULL, &rinv);
  ScrClosure *destroy = scr_stream_dynopt_pick(o.destroy, (void *)&scr_stream_dynopt_destroy_inv, NULL, NULL, &dinv);
  ScrStream *s = scr_stream_new_readable(o.rhwm, o.auto_destroy, o.emit_close,
      read, (ScrStreamReadInv)rinv, destroy, (ScrStreamErrInv)dinv);
  scr_stream_dynopt_apply_object(s, &o);
  scr_stream_dynopt_apply_enc(s, o.enc);
  return s;
}

ScrStream *scr_stream_new_writable_dyn(ScrDyn *opts) {
  ScrStreamDynOpts o;
  if (!scr_stream_parse_dyn_opts(opts, 'w', &o)) return NULL;
  void *winv = NULL, *finv = NULL, *dinv = NULL;
  ScrClosure *write = scr_stream_dynopt_pick(o.write, (void *)&scr_stream_dynopt_write_inv, NULL, NULL, &winv);
  ScrClosure *final_cb = scr_stream_dynopt_pick(o.final_fn, (void *)&scr_stream_dynopt_final_inv, NULL, NULL, &finv);
  ScrClosure *destroy = scr_stream_dynopt_pick(o.destroy, (void *)&scr_stream_dynopt_destroy_inv, NULL, NULL, &dinv);
  ScrStream *s = scr_stream_new_writable(o.whwm, o.auto_destroy, o.emit_close,
      write, (ScrStreamChunkInv)winv, final_cb, (ScrStreamPlainInv)finv, destroy, (ScrStreamErrInv)dinv);
  scr_stream_dynopt_apply_object(s, &o);
  return s;
}

ScrStream *scr_stream_new_duplex_dyn(ScrDyn *opts) {
  ScrStreamDynOpts o;
  if (!scr_stream_parse_dyn_opts(opts, 'd', &o)) return NULL;
  void *rinv = NULL, *winv = NULL, *finv = NULL, *dinv = NULL;
  ScrClosure *read = scr_stream_dynopt_pick(o.read, (void *)&scr_stream_dynopt_read_inv, NULL, NULL, &rinv);
  ScrClosure *write = scr_stream_dynopt_pick(o.write, (void *)&scr_stream_dynopt_write_inv, NULL, NULL, &winv);
  ScrClosure *final_cb = scr_stream_dynopt_pick(o.final_fn, (void *)&scr_stream_dynopt_final_inv, NULL, NULL, &finv);
  ScrClosure *destroy = scr_stream_dynopt_pick(o.destroy, (void *)&scr_stream_dynopt_destroy_inv, NULL, NULL, &dinv);
  ScrStream *s = scr_stream_new_duplex(o.rhwm, o.whwm, o.auto_destroy, o.emit_close,
      o.allow_half_open, o.readable_side, o.writable_side,
      read, (ScrStreamReadInv)rinv, write, (ScrStreamChunkInv)winv,
      final_cb, (ScrStreamPlainInv)finv, destroy, (ScrStreamErrInv)dinv);
  scr_stream_dynopt_apply_object(s, &o);
  scr_stream_dynopt_apply_enc(s, o.enc);
  return s;
}

static ScrStream *scr_stream_new_transformish_dyn(ScrDyn *opts, char base) {
  ScrStreamDynOpts o;
  if (!scr_stream_parse_dyn_opts(opts, base, &o)) return NULL;
  void *tinv = NULL, *linv = NULL, *dinv = NULL;
  ScrClosure *transform = scr_stream_dynopt_pick(o.transform, (void *)&scr_stream_dynopt_transform_inv, NULL, NULL, &tinv);
  ScrClosure *flush = scr_stream_dynopt_pick(o.flush, (void *)&scr_stream_dynopt_flush_inv, NULL, NULL, &linv);
  ScrClosure *destroy = scr_stream_dynopt_pick(o.destroy, (void *)&scr_stream_dynopt_destroy_inv, NULL, NULL, &dinv);
  ScrStream *s = base == 't'
      ? scr_stream_new_transform(o.rhwm, o.whwm, o.auto_destroy, o.emit_close,
            o.allow_half_open, o.readable_side, o.writable_side,
            transform, (ScrStreamChunkInv)tinv, flush, (ScrStreamPlainInv)linv,
            destroy, (ScrStreamErrInv)dinv)
      : scr_stream_new_passthrough(o.rhwm, o.whwm, o.auto_destroy, o.emit_close,
            o.allow_half_open, o.readable_side, o.writable_side,
            transform, (ScrStreamChunkInv)tinv, flush, (ScrStreamPlainInv)linv,
            destroy, (ScrStreamErrInv)dinv);
  scr_stream_dynopt_apply_object(s, &o);
  scr_stream_dynopt_apply_enc(s, o.enc);
  return s;
}

ScrStream *scr_stream_new_transform_dyn(ScrDyn *opts) {
  return scr_stream_new_transformish_dyn(opts, 't');
}

ScrStream *scr_stream_new_passthrough_dyn(ScrDyn *opts) {
  return scr_stream_new_transformish_dyn(opts, 'p');
}

void scr_stream_init_readable_dyn(ScrStream *s, ScrDyn *opts,
    ScrClosure *read_fb, ScrStreamReadInv read_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv) {
  ScrStreamDynOpts o;
  if (!scr_stream_parse_dyn_opts(opts, 'r', &o)) {
    if (read_fb != NULL) scr_closure_release(read_fb);
    if (destroy_fb != NULL) scr_closure_release(destroy_fb);
    return;
  }
  void *rinv = NULL, *dinv = NULL;
  ScrClosure *read = scr_stream_dynopt_pick(o.read, (void *)&scr_stream_dynopt_read_inv, read_fb, (void *)read_fb_inv, &rinv);
  ScrClosure *destroy = scr_stream_dynopt_pick(o.destroy, (void *)&scr_stream_dynopt_destroy_inv, destroy_fb, (void *)destroy_fb_inv, &dinv);
  scr_stream_init_readable(s, o.rhwm, o.auto_destroy, o.emit_close,
      read, (ScrStreamReadInv)rinv, destroy, (ScrStreamErrInv)dinv);
  scr_stream_dynopt_apply_object(s, &o);
  scr_stream_dynopt_apply_enc(s, o.enc);
}

void scr_stream_init_writable_dyn(ScrStream *s, ScrDyn *opts,
    ScrClosure *write_fb, ScrStreamChunkInv write_fb_inv,
    ScrClosure *final_fb, ScrStreamPlainInv final_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv) {
  ScrStreamDynOpts o;
  if (!scr_stream_parse_dyn_opts(opts, 'w', &o)) {
    if (write_fb != NULL) scr_closure_release(write_fb);
    if (final_fb != NULL) scr_closure_release(final_fb);
    if (destroy_fb != NULL) scr_closure_release(destroy_fb);
    return;
  }
  void *winv = NULL, *finv = NULL, *dinv = NULL;
  ScrClosure *write = scr_stream_dynopt_pick(o.write, (void *)&scr_stream_dynopt_write_inv, write_fb, (void *)write_fb_inv, &winv);
  ScrClosure *final_cb = scr_stream_dynopt_pick(o.final_fn, (void *)&scr_stream_dynopt_final_inv, final_fb, (void *)final_fb_inv, &finv);
  ScrClosure *destroy = scr_stream_dynopt_pick(o.destroy, (void *)&scr_stream_dynopt_destroy_inv, destroy_fb, (void *)destroy_fb_inv, &dinv);
  scr_stream_init_writable(s, o.whwm, o.auto_destroy, o.emit_close,
      write, (ScrStreamChunkInv)winv, final_cb, (ScrStreamPlainInv)finv, destroy, (ScrStreamErrInv)dinv);
  scr_stream_dynopt_apply_object(s, &o);
}

void scr_stream_init_duplex_dyn(ScrStream *s, ScrDyn *opts,
    ScrClosure *read_fb, ScrStreamReadInv read_fb_inv,
    ScrClosure *write_fb, ScrStreamChunkInv write_fb_inv,
    ScrClosure *final_fb, ScrStreamPlainInv final_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv) {
  ScrStreamDynOpts o;
  if (!scr_stream_parse_dyn_opts(opts, 'd', &o)) {
    if (read_fb != NULL) scr_closure_release(read_fb);
    if (write_fb != NULL) scr_closure_release(write_fb);
    if (final_fb != NULL) scr_closure_release(final_fb);
    if (destroy_fb != NULL) scr_closure_release(destroy_fb);
    return;
  }
  void *rinv = NULL, *winv = NULL, *finv = NULL, *dinv = NULL;
  ScrClosure *read = scr_stream_dynopt_pick(o.read, (void *)&scr_stream_dynopt_read_inv, read_fb, (void *)read_fb_inv, &rinv);
  ScrClosure *write = scr_stream_dynopt_pick(o.write, (void *)&scr_stream_dynopt_write_inv, write_fb, (void *)write_fb_inv, &winv);
  ScrClosure *final_cb = scr_stream_dynopt_pick(o.final_fn, (void *)&scr_stream_dynopt_final_inv, final_fb, (void *)final_fb_inv, &finv);
  ScrClosure *destroy = scr_stream_dynopt_pick(o.destroy, (void *)&scr_stream_dynopt_destroy_inv, destroy_fb, (void *)destroy_fb_inv, &dinv);
  scr_stream_init_duplex(s, o.rhwm, o.whwm, o.auto_destroy, o.emit_close,
      o.allow_half_open, o.readable_side, o.writable_side,
      read, (ScrStreamReadInv)rinv, write, (ScrStreamChunkInv)winv,
      final_cb, (ScrStreamPlainInv)finv, destroy, (ScrStreamErrInv)dinv);
  scr_stream_dynopt_apply_object(s, &o);
  scr_stream_dynopt_apply_enc(s, o.enc);
}

static void scr_stream_init_transformish_dyn(ScrStream *s, ScrDyn *opts, char base,
    ScrClosure *transform_fb, ScrStreamChunkInv transform_fb_inv,
    ScrClosure *flush_fb, ScrStreamPlainInv flush_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv) {
  ScrStreamDynOpts o;
  if (!scr_stream_parse_dyn_opts(opts, base, &o)) {
    if (transform_fb != NULL) scr_closure_release(transform_fb);
    if (flush_fb != NULL) scr_closure_release(flush_fb);
    if (destroy_fb != NULL) scr_closure_release(destroy_fb);
    return;
  }
  void *tinv = NULL, *linv = NULL, *dinv = NULL;
  ScrClosure *transform = scr_stream_dynopt_pick(o.transform, (void *)&scr_stream_dynopt_transform_inv, transform_fb, (void *)transform_fb_inv, &tinv);
  ScrClosure *flush = scr_stream_dynopt_pick(o.flush, (void *)&scr_stream_dynopt_flush_inv, flush_fb, (void *)flush_fb_inv, &linv);
  ScrClosure *destroy = scr_stream_dynopt_pick(o.destroy, (void *)&scr_stream_dynopt_destroy_inv, destroy_fb, (void *)destroy_fb_inv, &dinv);
  if (base == 't') {
    scr_stream_init_transform(s, o.rhwm, o.whwm, o.auto_destroy, o.emit_close,
        o.allow_half_open, o.readable_side, o.writable_side,
        transform, (ScrStreamChunkInv)tinv, flush, (ScrStreamPlainInv)linv,
        destroy, (ScrStreamErrInv)dinv);
  } else {
    scr_stream_init_passthrough(s, o.rhwm, o.whwm, o.auto_destroy, o.emit_close,
        o.allow_half_open, o.readable_side, o.writable_side,
        transform, (ScrStreamChunkInv)tinv, flush, (ScrStreamPlainInv)linv,
        destroy, (ScrStreamErrInv)dinv);
  }
  scr_stream_dynopt_apply_object(s, &o);
  scr_stream_dynopt_apply_enc(s, o.enc);
}

void scr_stream_init_transform_dyn(ScrStream *s, ScrDyn *opts,
    ScrClosure *transform_fb, ScrStreamChunkInv transform_fb_inv,
    ScrClosure *flush_fb, ScrStreamPlainInv flush_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv) {
  scr_stream_init_transformish_dyn(s, opts, 't', transform_fb, transform_fb_inv,
      flush_fb, flush_fb_inv, destroy_fb, destroy_fb_inv);
}

void scr_stream_init_passthrough_dyn(ScrStream *s, ScrDyn *opts,
    ScrClosure *transform_fb, ScrStreamChunkInv transform_fb_inv,
    ScrClosure *flush_fb, ScrStreamPlainInv flush_fb_inv,
    ScrClosure *destroy_fb, ScrStreamErrInv destroy_fb_inv) {
  scr_stream_init_transformish_dyn(s, opts, 'p', transform_fb, transform_fb_inv,
      flush_fb, flush_fb_inv, destroy_fb, destroy_fb_inv);
}

/* ── finished() and pipeline() (lib/internal/streams/end-of-stream and
 *    pipeline — the callback forms) ─────────────────────────────────────
 *
 * PROBED ORDERINGS (Node v24.15.0):
 *   - finished(s, cb): cb fires right AFTER s's 'close' (willEmitClose —
 *     the default autoDestroy+emitClose lifecycle), with `this` bound to
 *     the stream, no arguments on success, the error on error, and
 *     ERR_STREAM_PREMATURE_CLOSE ("Premature close") when the stream
 *     closed before end/finish. finished returns a CLEANUP function that
 *     unhooks the callback.
 *   - pipeline(a, b, c, cb) follows pipeline.js (see scr_stream_pipeline_ex):
 *     cb runs on a nextTick once every stream's eos watcher finished, and
 *     the first error destroys the streams that have not finished.
 *   - both register 'error' handlers, so an otherwise-unhandled stream
 *     error no longer crashes (the SCR_ST_ERROR suppression above). */

static void scr_stream_fin_add(ScrStreamState *st, ScrClosure *cb /*moves*/, ScrStreamErrInv inv) {
  if (st->fin.n == st->fin.cap) {
    st->fin.cap = st->fin.cap ? st->fin.cap * 2 : 2;
    st->fin.cb = realloc(st->fin.cb, st->fin.cap * sizeof *st->fin.cb);
    st->fin.inv = realloc(st->fin.inv, st->fin.cap * sizeof *st->fin.inv);
    if (!st->fin.cb || !st->fin.inv) scr_stream_oom();
  }
  st->fin.cb[st->fin.n] = cb;
  st->fin.inv[st->fin.n] = inv;
  st->fin.n++;
}

/* The stream's finish status: +1 error (the recorded one, or premature
 * close), or NULL for a clean end+finish. */
static ScrError *scr_stream_finish_status(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->errored) return scr_error_retain(st->errored);
  if ((st->has_r && !st->r.end_emitted) || (st->has_w && !st->w.finished)) {
    return scr_stream_mkerr("ERR_STREAM_PREMATURE_CLOSE", "Premature close");
  }
  return NULL;
}

static void scr_stream_notify_finished(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->fin.n == 0) return;
  /* Take the list out first: a watcher may register another finished()
   * or run cleanup reentrantly. */
  ScrClosure **cbs = st->fin.cb;
  ScrStreamErrInv *invs = st->fin.inv;
  size_t n = st->fin.n;
  st->fin.cb = NULL;
  st->fin.inv = NULL;
  st->fin.n = 0;
  st->fin.cap = 0;
  ScrError *err = scr_stream_finish_status(s);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) invs[i](cbs[i], s, err);
    scr_closure_release(cbs[i]);
  }
  if (err) scr_error_release(err);
  free(cbs);
  free(invs);
}

static void scr_stream_finished_cleanup_fn(ScrClosure *self) {
  ScrStream *s = scr_box_get_ref(self->caps[0]);       /* +1 */
  ScrClosure *cb = scr_box_get_ref(self->caps[1]);      /* +1 */
  ScrStreamState *st = s->st;
  for (size_t i = 0; i < st->fin.n; i++) {
    if (st->fin.cb[i] == cb) {
      scr_closure_release(st->fin.cb[i]);
      memmove(&st->fin.cb[i], &st->fin.cb[i + 1], (st->fin.n - i - 1) * sizeof *st->fin.cb);
      memmove(&st->fin.inv[i], &st->fin.inv[i + 1], (st->fin.n - i - 1) * sizeof *st->fin.inv);
      st->fin.n--;
      break;
    }
  }
  scr_closure_release(cb);
  scr_stream_release(s);
}

ScrClosure *scr_stream_finished(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamErrInv inv) {
  ScrStreamState *st = s->st;
  scr_stream_fin_add(st, scr_closure_retain(cb), inv);
  if (st->close_emitted) {
    /* Already terminal: Node's eos still calls back asynchronously. */
    scr_st_tick(s, SCR_ST_FIN, NULL, NULL);
  }
  ScrClosure *cleanup = scr_closure_new((void *)&scr_stream_finished_cleanup_fn, 2);
  cleanup->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
  scr_box_set_ref(cleanup->caps[0], scr_stream_retain(s));
  cleanup->caps[1] = scr_box_new_obj(&scr_closure_retain_v, &scr_closure_release_v, &scr_closure_trace_v);
  scr_box_set_ref(cleanup->caps[1], cb); /* the move lands here */
  return cleanup;
}

/* The dyn-valued finished/pipeline callback (a mustCall wrapper): success
 * calls with NO arguments (Node's callback.call(stream)), an error boxes
 * through the boundary encoding. */
void scr_stream_finished_dyn_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *r;
  if (err != NULL) {
    ScrDyn *a = scr_dyn_from_error(err);
    r = scr_dyn_call(fn, &a, 1, "callback");
    scr_dyn_release(a);
  } else {
    r = scr_dyn_call(fn, NULL, 0, "callback");
  }
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static ScrError *scr_stream_abort_error(ScrDyn *signal);
static ScrDyn *scr_stream_signal_prop(ScrDyn *signal, const char *key);
static void *scr_stream_dyn_retain_v(void *p);
static void scr_stream_dyn_release_v(void *p);
static ScrClosure *scr_stream_eos_impl(ScrStream *s, ScrClosure *cb, ScrStreamErrInv inv,
                                       ScrPromise *p, bool auto_cleanup, int readable,
                                       int writable, bool on_error, ScrDyn *signal,
                                       ScrAbortAddFn add);

/* callback(error, value) for pipelines that end in a function: cb owned
 * by the caller; value is the destination's value boxed (NULL: undefined)
 * and value_p its promise (NULL for an async generator destination). */
typedef void (*ScrPipeValInv)(ScrClosure *cb, ScrError *err, ScrDyn *value, ScrPromise *value_p);

/* stream.pipeline over streams (lib/internal/streams/pipeline.js). Each
 * stream gets the destroyer (a 'close' listener and an eos watcher over
 * the sides it plays), an 'error' listener, and each adjacent pair the
 * pipe() helper: src.pipe(dst, { end: false }), dst.end() on the source's
 * 'end', a premature-close check on the destination's 'close', and eos
 * watchers on both. The callback runs on a nextTick once every watcher
 * finished, or the first error destroys the remaining streams.
 *
 * The context's listeners on the streams hold it, and it holds the
 * streams until the final callback (or exit), which breaks the cycle. */

typedef struct {
  size_t rc;
  size_t n;
  ScrStream **streams;   /* +1 each; NULL after the final callback */
  bool *destroyer;       /* stream i has a destroyer (destroys queue) */
  bool *finished;        /* the destroyer's finished flag */
  bool *ended;           /* pipe(streams[i-1], streams[i])'s ended flag */
  size_t destroy_head;   /* the next destroys entry to run */
  long finish_count;
  ScrError *error;       /* +1 or NULL */
  ScrClosure *cb;        /* +1 until the final callback is queued */
  ScrStreamErrInv inv;
  bool final_done;
  ScrDyn *signal;        /* +1 or NULL */
  ScrDyn *dispose;       /* the abort listener's disposable (+1) or NULL */
  /* lastStreamCleanup: the last stream's eos cleanups and its 'error'
   * listener, when that stream is readable */
  ScrClosure *last_cleanup[2];
  size_t last_cleanups;
  ScrClosure *last_error_l; /* +1 */
  /* function stages: the closure aborting the pipeline's own
   * AbortController (finishImpl's ac.abort()), and a promise
   * destination's value — boxed for the callback, and the destination's
   * own promise for the promise form (each +1 or NULL) */
  ScrClosure *abort;
  ScrDyn *value;
  ScrPromise *value_p;
  /* the final callback with the value: callback(error, value) */
  ScrPipeValInv val_inv;
  void *live_prev, *live_next;
} ScrStreamPipeCtx;

static SCR_TL ScrStreamPipeCtx *scr_pipe_live = NULL;

static void scr_pipe_unlink(ScrStreamPipeCtx *ctx) {
  ScrStreamPipeCtx *prev = ctx->live_prev, *next = ctx->live_next;
  if (prev) prev->live_next = next;
  else if (scr_pipe_live == ctx) scr_pipe_live = next;
  if (next) next->live_prev = prev;
  ctx->live_prev = ctx->live_next = NULL;
}

static void *scr_stream_pipectx_retain_v(void *p) {
  ((ScrStreamPipeCtx *)p)->rc++;
  return p;
}

/* What the context holds besides its flags: the streams, the pending
 * callback, the signal's disposable and the cleanups. */
static void scr_stream_pipectx_drop(ScrStreamPipeCtx *ctx) {
  scr_pipe_unlink(ctx);
  if (ctx->streams) {
    for (size_t i = 0; i < ctx->n; i++) scr_stream_release(ctx->streams[i]);
    free(ctx->streams);
    ctx->streams = NULL;
  }
  if (ctx->cb) {
    scr_closure_release(ctx->cb);
    ctx->cb = NULL;
  }
  if (ctx->dispose) {
    ScrDyn *d = ctx->dispose;
    ctx->dispose = NULL;
    scr_dyn_release(d);
  }
  if (ctx->signal) {
    scr_dyn_release(ctx->signal);
    ctx->signal = NULL;
  }
  for (size_t i = 0; i < ctx->last_cleanups; i++) scr_closure_release(ctx->last_cleanup[i]);
  ctx->last_cleanups = 0;
  if (ctx->last_error_l) {
    scr_closure_release(ctx->last_error_l);
    ctx->last_error_l = NULL;
  }
  if (ctx->abort) {
    scr_closure_release(ctx->abort);
    ctx->abort = NULL;
  }
  if (ctx->value) {
    scr_dyn_release(ctx->value);
    ctx->value = NULL;
  }
  if (ctx->value_p) {
    scr_promise_release(ctx->value_p);
    ctx->value_p = NULL;
  }
}

static void scr_stream_pipectx_release_v(void *p) {
  ScrStreamPipeCtx *ctx = p;
  if (--ctx->rc > 0) return;
  scr_stream_pipectx_drop(ctx);
  if (ctx->error) scr_error_release(ctx->error);
  free(ctx->destroyer);
  free(ctx->finished);
  free(ctx->ended);
  free(ctx);
}

static void scr_pipe_atexit(void) {
  while (scr_pipe_live) {
    ScrStreamPipeCtx *ctx = scr_stream_pipectx_retain_v(scr_pipe_live);
    scr_stream_pipectx_drop(ctx);
    scr_stream_pipectx_release_v(ctx);
  }
}

/* caps[0] the context, caps[1] the stream index. */
static ScrClosure *scr_pipe_closure(void *fn, ScrStreamPipeCtx *ctx, size_t i) {
  ScrClosure *c = scr_closure_new(fn, 2);
  c->caps[0] = scr_box_new_obj(&scr_stream_pipectx_retain_v, &scr_stream_pipectx_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_stream_pipectx_retain_v(ctx));
  c->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(c->caps[1], (double)i);
  return c;
}

static ScrStreamPipeCtx *scr_pipe_of(ScrClosure *c, size_t *i) {
  if (i) *i = (size_t)scr_box_get_f64(c->caps[1]);
  return scr_box_get_ref(c->caps[0]); /* +1 */
}

static void scr_pipe_on(ScrStream *s, const char *name, ScrClosure *cb /*moves*/, ScrEeInvoke inv,
                        bool once) {
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_emitter_release(scr_emitter_on((ScrEmitter *)s, n, cb, inv, once, false));
  scr_str_release(n);
}

static bool scr_pipe_err_is(const ScrError *e, const char *code, const char *name) {
  if (code && e->code && e->code->len == strlen(code) && memcmp(e->code->data, code, e->code->len) == 0)
    return true;
  return name && e->name && e->name->len == strlen(name) &&
         memcmp(e->name->data, name, e->name->len) == 0;
}

/* process.nextTick(callback, error): caps[0] the context, caps[1] the
 * callback, caps[2] the last stream, caps[3] the error as it was when
 * the tick was queued (an Error or NULL). */
/* process.nextTick(callback, error, value) for a pipeline whose callback
 * takes the destination's value. */
typedef struct {
  size_t rc;
  ScrPipeValInv inv;
  ScrClosure *cb;      /* +1 */
  ScrError *err;       /* +1 or NULL */
  ScrDyn *value;       /* +1 or NULL (undefined) */
  ScrPromise *value_p; /* +1 or NULL */
} ScrPipeValueJob;

static void *scr_pipe_value_job_retain(void *p) {
  ((ScrPipeValueJob *)p)->rc++;
  return p;
}

static void scr_pipe_value_job_free(void *p) {
  ScrPipeValueJob *vj = p;
  if (--vj->rc > 0) return;
  if (vj->cb) scr_closure_release(vj->cb);
  if (vj->err) scr_error_release(vj->err);
  if (vj->value) scr_dyn_release(vj->value);
  if (vj->value_p) scr_promise_release(vj->value_p);
  free(vj);
}

static void scr_pipe_value_tick(ScrClosure *job) {
  ScrPipeValueJob *vj = scr_box_get_ref(job->caps[0]);
  vj->inv(vj->cb, vj->err, vj->value, vj->value_p);
  scr_pipe_value_job_free(vj);
}

static void scr_pipe_callback_tick(ScrClosure *job) {
  ScrStreamPipeCtx *ctx = scr_box_get_ref(job->caps[0]);
  ScrClosure *cb = scr_box_get_ref(job->caps[1]);
  ScrStream *last = scr_box_get_ref(job->caps[2]);
  ScrError *err = job->ncaps > 3 ? scr_box_get_ref(job->caps[3]) : NULL;
  ctx->inv(cb, last, err);
  if (err) scr_error_release(err);
  scr_closure_release(cb);
  scr_stream_release(last);
  scr_stream_pipectx_release_v(ctx);
}

/* destroyImpl.destroyer(stream, err || new ERR_STREAM_DESTROYED('pipe')) */
static void scr_pipe_destroy(ScrStream *s, ScrError *err) {
  if (s->st->destroyed) return;
  ScrError *e = err ? scr_error_retain(err)
                    : scr_stream_mkerr("ERR_STREAM_DESTROYED", "Cannot call pipe after a stream was destroyed");
  scr_stream_release(scr_stream_destroy(s, e));
  scr_error_release(e);
}

static void scr_pipe_finish_impl(ScrStreamPipeCtx *ctx, ScrError *err, bool final) {
  if (ctx->final_done) final = false;
  if (err && (!ctx->error || scr_pipe_err_is(ctx->error, "ERR_STREAM_PREMATURE_CLOSE", "AbortError"))) {
    if (ctx->error) scr_error_release(ctx->error);
    ctx->error = scr_error_retain(err);
  }
  if (!ctx->error && !final) return;
  if (!ctx->streams) return;
  scr_stream_pipectx_retain_v(ctx);
  while (ctx->destroy_head < ctx->n) {
    size_t i = ctx->destroy_head++;
    if (!ctx->destroyer[i] || ctx->finished[i]) continue;
    ctx->finished[i] = true;
    scr_pipe_destroy(ctx->streams[i], ctx->error);
    if (!ctx->streams) break;
  }
  if (ctx->dispose) {
    ScrDyn *d = ctx->dispose;
    ctx->dispose = NULL;
    ScrDyn *r = scr_dyn_call(d, NULL, 0, "dispose");
    if (r) scr_dyn_release(r);
    scr_dyn_release(d);
  }
  if (ctx->abort) {
    /* ac.abort(): later calls are no-ops on an aborted controller */
    ScrClosure *a = ctx->abort;
    ctx->abort = NULL;
    ((void (*)(ScrClosure *))a->fn)(a);
    scr_closure_release(a);
    if (scr_exc_pending()) scr_exc_clear();
  }
  if (final && ctx->streams) {
    ctx->final_done = true;
    if (!ctx->error) {
      for (size_t i = 0; i < ctx->last_cleanups; i++) {
        ScrClosure *c = ctx->last_cleanup[i];
        ((void (*)(ScrClosure *))c->fn)(c);
      }
      if (ctx->last_error_l) {
        ScrStr *n = scr_str_new("error", 5);
        scr_emitter_release(scr_emitter_off((ScrEmitter *)ctx->streams[ctx->n - 1], n, ctx->last_error_l));
        scr_str_release(n);
      }
    }
    /* process.nextTick(callback, error, value) */
    if (ctx->val_inv) {
      /* the job owns the callback, the value and the error */
      ScrPipeValueJob *vj = calloc(1, sizeof *vj);
      if (!vj) scr_stream_oom();
      vj->rc = 1;
      vj->inv = ctx->val_inv;
      vj->cb = ctx->cb;
      ctx->cb = NULL;
      vj->err = ctx->error ? scr_error_retain(ctx->error) : NULL;
      if (!vj->err) {
        vj->value = ctx->value;
        vj->value_p = ctx->value_p;
        ctx->value = NULL;
        ctx->value_p = NULL;
      }
      ScrClosure *vjob = scr_closure_new((void *)&scr_pipe_value_tick, 1);
      vjob->caps[0] = scr_box_new_obj(&scr_pipe_value_job_retain, &scr_pipe_value_job_free, NULL);
      scr_box_set_ref(vjob->caps[0], vj);
      scr_next_tick(vjob);
      scr_stream_pipectx_drop(ctx);
      scr_stream_pipectx_release_v(ctx);
      return;
    }
    ScrClosure *job = scr_closure_new((void *)&scr_pipe_callback_tick, ctx->error ? 4 : 3);
    job->caps[0] = scr_box_new_obj(&scr_stream_pipectx_retain_v, &scr_stream_pipectx_release_v, NULL);
    scr_box_set_ref(job->caps[0], scr_stream_pipectx_retain_v(ctx));
    job->caps[1] = scr_box_new_obj(&scr_closure_retain_v, &scr_closure_release_v, &scr_closure_trace_v);
    scr_box_set_ref(job->caps[1], ctx->cb); /* moves */
    ctx->cb = NULL;
    job->caps[2] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
    scr_box_set_ref(job->caps[2], scr_stream_retain(ctx->streams[ctx->n - 1]));
    if (ctx->error) {
      job->caps[3] = scr_box_new_obj(&scr_error_retain_v, &scr_error_release_v, NULL);
      scr_box_set_ref(job->caps[3], scr_error_retain(ctx->error));
    }
    scr_next_tick(job);
    scr_stream_pipectx_drop(ctx);
  }
  scr_stream_pipectx_release_v(ctx);
}

/* finish(err): finishImpl(err, --finishCount === 0) */
static void scr_pipe_finish_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  ScrStreamPipeCtx *ctx = scr_pipe_of(cb, NULL);
  scr_pipe_finish_impl(ctx, err, --ctx->finish_count == 0);
  scr_stream_pipectx_release_v(ctx);
}

static void scr_pipe_finish_l(ScrClosure *cb) { scr_pipe_finish_inv(cb, NULL, NULL); }

static void scr_pipe_finish_err_l(ScrClosure *cb, void *err) { scr_pipe_finish_inv(cb, NULL, err); }

/* destroyer: stream.on('close') marks finished; eos marks it !err. */
static void scr_pipe_destroyer_close_l(ScrClosure *cb) {
  size_t i;
  ScrStreamPipeCtx *ctx = scr_pipe_of(cb, &i);
  ctx->finished[i] = true;
  scr_stream_pipectx_release_v(ctx);
}

static void scr_pipe_destroyer_eos(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  size_t i;
  ScrStreamPipeCtx *ctx = scr_pipe_of(cb, &i);
  ctx->finished[i] = err == NULL;
  scr_stream_pipectx_release_v(ctx);
}

/* onError: errors after pipe completed (not AbortError / premature close) */
static void scr_pipe_error_l(ScrClosure *cb, void *errp) {
  ScrError *err = errp;
  ScrStreamPipeCtx *ctx = scr_pipe_of(cb, NULL);
  if (err && !scr_pipe_err_is(err, "ERR_STREAM_PREMATURE_CLOSE", "AbortError")) {
    scr_pipe_finish_impl(ctx, err, false);
  }
  scr_stream_pipectx_release_v(ctx);
}

/* pipe(): the destination closed before the source ended */
static void scr_pipe_dst_close_l(ScrClosure *cb) {
  size_t i;
  ScrStreamPipeCtx *ctx = scr_pipe_of(cb, &i);
  if (!ctx->ended[i]) {
    ScrError *e = scr_stream_mkerr("ERR_STREAM_PREMATURE_CLOSE", "Premature close");
    scr_pipe_finish_impl(ctx, e, false);
    scr_error_release(e);
  }
  scr_stream_pipectx_release_v(ctx);
}

/* pipe()'s endFn: ended = true; dst.end(). caps[1] the destination's
 * index. */
static void scr_pipe_end_fn(ScrClosure *cb) {
  size_t i;
  ScrStreamPipeCtx *ctx = scr_pipe_of(cb, &i);
  ctx->ended[i] = true;
  if (ctx->streams) {
    ScrStream *r = scr_stream_end(ctx->streams[i], NULL, NULL, NULL);
    if (r) scr_stream_release(r);
  }
  scr_stream_pipectx_release_v(ctx);
}

/* pipe()'s eos(src, { readable: true, writable: false }): a premature
 * close after the source already ended (no error) waits for 'end' or
 * 'error' instead. caps[1] the source's index. */
static void scr_pipe_src_eos(ScrClosure *cb, ScrStream *s, ScrError *err) {
  size_t i;
  ScrStreamPipeCtx *ctx = scr_pipe_of(cb, &i);
  ScrStreamState *st = s->st;
  if (err && scr_pipe_err_is(err, "ERR_STREAM_PREMATURE_CLOSE", NULL) && st->r.ended &&
      !st->errored && !st->error_emitted) {
    scr_pipe_on(s, "end", scr_pipe_closure((void *)&scr_pipe_finish_l, ctx, i), scr_ee_inv_fixed0, true);
    scr_pipe_on(s, "error", scr_pipe_closure((void *)&scr_pipe_finish_err_l, ctx, i), scr_ee_inv_fixed1,
                true);
  } else {
    scr_pipe_finish_impl(ctx, err, --ctx->finish_count == 0);
  }
  scr_stream_pipectx_release_v(ctx);
}

/* eos(stream, { readable, writable }, cb) with Node's listeners. */
static ScrClosure *scr_pipe_eos(ScrStream *s, ScrClosure *cb, ScrStreamErrInv inv, bool readable,
                                bool writable) {
  return scr_stream_eos_impl(s, cb, inv, NULL, false, readable, writable, true, NULL, NULL);
}

static void scr_pipe_abort(ScrStreamPipeCtx *ctx) {
  ScrError *e = scr_stream_abort_error(ctx->signal);
  scr_pipe_finish_impl(ctx, e, false);
  scr_error_release(e);
}

static ScrDyn *scr_pipe_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrStreamPipeCtx *ctx = scr_pipe_of(clo, NULL);
  if (ctx->signal) scr_pipe_abort(ctx);
  scr_stream_pipectx_release_v(ctx);
  return scr_dyn_retain(scr_dyn_undefined());
}

static void scr_pipe_abort_tick(ScrClosure *job) {
  ScrStreamPipeCtx *ctx = scr_pipe_of(job, NULL);
  if (ctx->signal) scr_pipe_abort(ctx);
  scr_stream_pipectx_release_v(ctx);
}

/* The context-free throws of pipelineImpl's loop. */
static void scr_pipe_throw(const char *code, const char *msg, int kind) {
  ScrStr *m = scr_str_new(msg, strlen(msg));
  ScrError *e = scr_error_new(kind, m);
  scr_str_release(m);
  scr_error_set_code(e, code);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* The generators' done marker (Readable.from's and the pipeline stages'
 * helpers answer it): a process-lived object compared by identity. */
static SCR_TL ScrDyn *scr_stream_done_marker = NULL;

static void scr_stream_done_marker_free(void) {
  scr_dyn_release(scr_stream_done_marker);
  scr_stream_done_marker = NULL;
}

/* readable.chunkDone: whether a dyn for-await step answered the end (the
 * done marker; an object-mode stream can yield undefined). */
bool scr_stream_chunk_done(const ScrDyn *v) {
  return v != NULL && v == scr_stream_done_marker;
}

ScrDyn *scr_stream_from_done(void) {
  if (!scr_stream_done_marker) {
    scr_stream_done_marker = scr_dyn_new_obj();
    scr_atexit(scr_stream_done_marker_free);
  }
  return scr_dyn_retain(scr_stream_done_marker);
}

/* ── pipeline function stages (pipeline.js: makeAsyncIterable, pumpToNode) ──
 * Runs of async generator functions between node streams. Each stage is
 * called while the pipeline is set up, in pipeline order:
 * makeAsyncIterable hands a stage that follows a stream the stream itself
 * (a Readable is async iterable) and any other stage the previous stage's
 * generator. The last generator of a run that a stream follows is pumped
 * into that stream with pumpToNode. The stages and helpers use the closure
 * ABI (the closure first; the callee owns its parameters). */

typedef ScrPromise *(*ScrPipeNextFn)(ScrClosure *, ScrGen *);
typedef ScrDyn *(*ScrPipeReadFn)(ScrClosure *, void *);
typedef ScrDyn *(*ScrPipeBoxFn)(ScrClosure *, ScrPromise *);

/* SCR_PIPE_DEST_DYN: an untyped destination function's result, a
 * checked-dynamic value the pipeline classifies (scr_pipe_dest_dyn_kind) */
enum { SCR_PIPE_DEST_STREAM, SCR_PIPE_DEST_GEN, SCR_PIPE_DEST_PROMISE, SCR_PIPE_DEST_DYN };
/* flags bit 7: the callback is typed code's (stream.pipelineStagesDyn) */
enum { SCR_PIPE_TYPED_CB = 128 };

typedef struct {
  size_t count;              /* the function stages */
  uint64_t positions;        /* bit j: the pipeline's j-th stage is a function */
  /* stage(source[, { signal }]) answers an async generator, or a promise
   * for a promise destination; the source is absent for a source
   * function (position 0), else the previous stream or async generator */
  ScrClosure **stages;
  int dest;                  /* the last stage: SCR_PIPE_DEST_* */
  unsigned opts_mask;        /* bit i: stages[i] takes the { signal } argument */
  ScrDyn *signal;            /* the pipeline's AbortSignal when opts_mask != 0 */
  /* (next, read, return) for each generator pumped into a stream (an
   * async generator destination's PassThrough included), in pipeline
   * order, or NULL */
  ScrClosure **helpers;
  /* SCR_PIPE_DEST_PROMISE: boxes its promise as a dyn promise;
   * SCR_PIPE_DEST_DYN: answers the async generator over a dyn iterable */
  ScrClosure *box;
} ScrPipeStages;

static bool scr_pipe_is_stage(const ScrPipeStages *fs, size_t j) {
  return fs && j < 64 && ((fs->positions >> j) & 1u);
}

/* stages[i](source[, { signal }]): the callee owns its parameters. */
static void *scr_pipe_call_stage(const ScrPipeStages *fs, size_t i, void *src /*moves*/) {
  ScrClosure *st = fs->stages[i];
  ScrDyn *opts = NULL;
  if ((fs->opts_mask >> i) & 1u) {
    opts = scr_dyn_new_obj();
    scr_dyn_obj_set(opts, "signal", 6, scr_dyn_retain(fs->signal));
  }
  if (i == 0 && (fs->positions & 1u)) {
    return opts ? ((void *(*)(ScrClosure *, ScrDyn *))st->fn)(st, opts)
                : ((void *(*)(ScrClosure *))st->fn)(st);
  }
  return opts ? ((void *(*)(ScrClosure *, void *, ScrDyn *))st->fn)(st, src, opts)
              : ((void *(*)(ScrClosure *, void *))st->fn)(st, src);
}

enum { SCR_PUMP_DRAIN0, SCR_PUMP_WRITE, SCR_PUMP_END };

typedef struct {
  size_t rc;
  ScrStreamPipeCtx *ctx;         /* +1 */
  ScrGen *gen;                   /* +1 */
  ScrClosure *next, *read, *ret; /* +1 */
  ScrStream *w;                  /* +1 */
  bool end;
  ScrError *error;               /* +1: what resume() recorded, or NULL */
  ScrPromise *waiter;            /* +1: the pending wait(), or NULL */
  int stage;                     /* what the pending wait() resumes */
  ScrClosure *drain_l;           /* +1 */
  ScrClosure *eos_cleanup;       /* +1 */
  ScrError *fail;                /* +1: the loop's error while return() runs */
} ScrPump;

static void *scr_pump_retain_v(void *p) {
  ((ScrPump *)p)->rc++;
  return p;
}

static void scr_pump_release_v(void *p) {
  ScrPump *pm = p;
  if (--pm->rc > 0) return;
  scr_stream_pipectx_release_v(pm->ctx);
  scr_gen_release(pm->gen);
  scr_closure_release(pm->next);
  scr_closure_release(pm->read);
  scr_closure_release(pm->ret);
  scr_stream_release(pm->w);
  if (pm->error) scr_error_release(pm->error);
  if (pm->waiter) scr_promise_release(pm->waiter);
  if (pm->drain_l) scr_closure_release(pm->drain_l);
  if (pm->eos_cleanup) scr_closure_release(pm->eos_cleanup);
  if (pm->fail) scr_error_release(pm->fail);
  free(pm);
}

static ScrClosure *scr_pump_closure(void *fn, ScrPump *pm) {
  ScrClosure *c = scr_closure_new(fn, 1);
  c->caps[0] = scr_box_new_obj(&scr_pump_retain_v, &scr_pump_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_pump_retain_v(pm));
  return c;
}

/* A rejection as a pipeline error: Error values as themselves. +1. */
static ScrError *scr_pump_caught(void) {
  ScrCaught *c = scr_exc_take();
  ScrDyn *d = scr_caught_to_dyn(c);
  scr_caught_release(c);
  ScrError *e = d ? scr_errdyn_err_of(d) : NULL;
  if (d) scr_dyn_release(d);
  if (e) return e;
  return scr_stream_mkerr("ERR_INTERNAL_ASSERTION",
                          "a pipeline stage rejection that is not an Error object is not supported yet");
}

static void scr_pump_loop(ScrPump *pm);
static void scr_pump_wait(ScrPump *pm, int stage);
static void scr_pump_fail_in_loop(ScrPump *pm, ScrError *err);

/* finish(err) and the finally block: the eos cleanup, then the 'drain'
 * listener. Moves err. */
static void scr_pump_done(ScrPump *pm, ScrError *err) {
  ScrStreamPipeCtx *ctx = pm->ctx;
  scr_pipe_finish_impl(ctx, err, --ctx->finish_count == 0);
  if (err) scr_error_release(err);
  if (pm->eos_cleanup) {
    ScrClosure *c = pm->eos_cleanup;
    pm->eos_cleanup = NULL;
    ((void (*)(ScrClosure *))c->fn)(c);
    scr_closure_release(c);
  }
  if (pm->drain_l) {
    ScrStr *n = scr_str_new("drain", 5);
    scr_emitter_release(scr_emitter_off((ScrEmitter *)pm->w, n, pm->drain_l));
    scr_str_release(n);
    scr_closure_release(pm->drain_l);
    pm->drain_l = NULL;
  }
}

/* resume(err): the 'drain' listener and the eos callback. */
static void scr_pump_resume(ScrPump *pm, ScrError *err) {
  if (err && !pm->error) pm->error = scr_error_retain(err);
  ScrPromise *w = pm->waiter;
  if (!w) return;
  pm->waiter = NULL;
  if (pm->error) {
    scr_throw_obj(scr_error_retain(pm->error), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(w);
  } else {
    scr_promise_fulfill_void(w);
  }
  scr_promise_release(w);
}

static void scr_pump_drain_l(ScrClosure *c) {
  ScrPump *pm = scr_box_get_ref(c->caps[0]);
  scr_pump_resume(pm, NULL);
  scr_pump_release_v(pm);
}

static void scr_pump_eos(ScrClosure *c, ScrStream *s, ScrError *err) {
  (void)s;
  ScrPump *pm = scr_box_get_ref(c->caps[0]);
  scr_pump_resume(pm, err);
  scr_pump_release_v(pm);
}

/* `await p` for the pump: kind 0 a wait(), 1 the generator's next(),
 * 2 its return(). */
typedef struct {
  ScrPump *pm; /* +1 */
  ScrPromise *p; /* +1 */
  int kind;
  int stage;
} ScrPumpAwait;

static void scr_pump_after_wait(ScrPump *pm, int stage, bool rejected);
static void scr_pump_after_next(ScrPump *pm, ScrDyn *v);
static void scr_pump_after_return(ScrPump *pm);

static void scr_pump_await_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  ScrPumpAwait a = *(ScrPumpAwait *)arg;
  free(arg);
  if (a.kind == 1) {
    void *rec = scr_await_ref(a.p);
    ScrDyn *v = scr_exc_pending() ? NULL : ((ScrPipeReadFn)a.pm->read->fn)(a.pm->read, rec);
    scr_pump_after_next(a.pm, v);
  } else {
    scr_await_void(a.p);
    if (a.kind == 2) {
      if (scr_exc_pending()) scr_exc_clear(); /* the loop's error wins */
      scr_pump_after_return(a.pm);
    } else {
      scr_pump_after_wait(a.pm, a.stage, scr_exc_pending());
    }
  }
  if (scr_exc_pending()) scr_exc_clear();
  scr_promise_release(a.p);
  scr_pump_release_v(a.pm);
}

static void scr_pump_await(ScrPump *pm, ScrPromise *p /*borrowed*/, int kind, int stage) {
  ScrPumpAwait *a = malloc(sizeof *a);
  if (!a) scr_stream_oom();
  a->pm = scr_pump_retain_v(pm);
  a->p = scr_promise_retain(p);
  a->kind = kind;
  a->stage = stage;
  scr_promise_release(scr_async_spawn_after(p, &scr_pump_await_entry, a));
}

/* `await wait()`: rejects at once with a recorded error, else waits for
 * resume(). */
static void scr_pump_wait(ScrPump *pm, int stage) {
  ScrPromise *p = scr_promise_new();
  if (pm->error) {
    scr_throw_obj(scr_error_retain(pm->error), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(p);
  } else {
    pm->waiter = scr_promise_retain(p);
  }
  scr_pump_await(pm, p, 0, stage);
  scr_promise_release(p);
}

/* `for await (const chunk of iterable)`: one next() per pass. */
static void scr_pump_loop(ScrPump *pm) {
  ScrPromise *p = ((ScrPipeNextFn)pm->next->fn)(pm->next, scr_gen_retain(pm->gen));
  scr_pump_await(pm, p, 1, 0);
  scr_promise_release(p);
}

static void scr_pump_after_next(ScrPump *pm, ScrDyn *v) {
  if (!v) {
    /* the generator threw: catch (err) */
    scr_pump_done(pm, scr_pump_caught());
    return;
  }
  if (v == scr_stream_done_marker) {
    scr_dyn_release(v);
    if (pm->end) {
      scr_stream_release(scr_stream_end(pm->w, NULL, NULL, NULL));
      if (scr_exc_pending()) {
        scr_pump_done(pm, scr_pump_caught());
        return;
      }
      scr_pump_wait(pm, SCR_PUMP_END);
      return;
    }
    scr_pump_done(pm, NULL);
    return;
  }
  bool ok = scr_stream_write_dyn(pm->w, v, NULL);
  scr_dyn_release(v);
  if (scr_exc_pending()) {
    scr_pump_fail_in_loop(pm, scr_pump_caught());
    return;
  }
  if (!ok) {
    scr_pump_wait(pm, SCR_PUMP_WRITE);
    return;
  }
  scr_pump_loop(pm);
}

/* An error inside the loop body: for-await's AsyncIteratorClose awaits
 * the generator's return() before the catch block runs. Moves err. */
static void scr_pump_fail_in_loop(ScrPump *pm, ScrError *err) {
  pm->fail = err;
  ScrPromise *p = ((ScrPipeNextFn)pm->ret->fn)(pm->ret, scr_gen_retain(pm->gen));
  scr_pump_await(pm, p, 2, 0);
  scr_promise_release(p);
}

static void scr_pump_after_return(ScrPump *pm) {
  ScrError *err = pm->fail;
  pm->fail = NULL;
  scr_pump_done(pm, err);
}

static void scr_pump_after_wait(ScrPump *pm, int stage, bool rejected) {
  ScrError *err = rejected ? scr_pump_caught() : NULL;
  if (stage == SCR_PUMP_WRITE) {
    if (err) scr_pump_fail_in_loop(pm, err);
    else scr_pump_loop(pm);
  } else if (stage == SCR_PUMP_DRAIN0) {
    if (err) scr_pump_done(pm, err);
    else scr_pump_loop(pm);
  } else {
    scr_pump_done(pm, err);
  }
}

/* pumpToNode(gen, w, finish, { end }): starts at once, as the async
 * function does. The helpers (next, read, return) are borrowed. */
static void scr_pump_start(ScrStreamPipeCtx *ctx, ScrGen *gen /*moves*/, ScrClosure *const *helpers,
                           ScrStream *w, bool end) {
  ScrPump *pm = calloc(1, sizeof *pm);
  if (!pm) scr_stream_oom();
  pm->rc = 1;
  pm->ctx = scr_stream_pipectx_retain_v(ctx);
  pm->gen = gen;
  pm->next = scr_closure_retain(helpers[0]);
  pm->read = scr_closure_retain(helpers[1]);
  pm->ret = scr_closure_retain(helpers[2]);
  pm->w = scr_stream_retain(w);
  pm->end = end;
  pm->drain_l = scr_pump_closure((void *)&scr_pump_drain_l, pm);
  scr_pipe_on(w, "drain", scr_closure_retain(pm->drain_l), scr_ee_inv_fixed0, false);
  pm->eos_cleanup = scr_pipe_eos(w, scr_pump_closure((void *)&scr_pump_eos, pm), &scr_pump_eos, false,
                                 w->st->has_w);
  if (w->st->has_w && w->st->w.need_drain) scr_pump_wait(pm, SCR_PUMP_DRAIN0);
  else scr_pump_loop(pm);
  scr_pump_release_v(pm);
}

/* process.nextTick(finish, err) */
static void scr_pipe_finish_tick(ScrClosure *job) {
  ScrStreamPipeCtx *ctx = scr_box_get_ref(job->caps[0]);
  ScrError *err = job->ncaps > 1 ? scr_box_get_ref(job->caps[1]) : NULL;
  scr_pipe_finish_impl(ctx, err, --ctx->finish_count == 0);
  if (err) scr_error_release(err);
  scr_stream_pipectx_release_v(ctx);
}

static void scr_pipe_finish_next_tick(ScrStreamPipeCtx *ctx, ScrError *err /*borrowed*/) {
  ScrClosure *job = scr_closure_new((void *)&scr_pipe_finish_tick, err ? 2 : 1);
  job->caps[0] = scr_box_new_obj(&scr_stream_pipectx_retain_v, &scr_stream_pipectx_release_v, NULL);
  scr_box_set_ref(job->caps[0], scr_stream_pipectx_retain_v(ctx));
  if (err) {
    job->caps[1] = scr_box_new_obj(&scr_error_retain_v, &scr_error_release_v, NULL);
    scr_box_set_ref(job->caps[1], scr_error_retain(err));
  }
  scr_next_tick(job);
}

/* A promise destination's then(): on fulfillment the value is kept for
 * the callback, written to the PassThrough when it is not nullish (a
 * string or Buffer; object-mode values of other kinds stay off the
 * stream), and the PassThrough ends; on rejection it is destroyed with
 * the reason. finish runs on the next tick either way. */
typedef struct {
  ScrStreamPipeCtx *ctx; /* +1 */
  ScrPromise *typed;     /* +1, the destination's promise */
  ScrDyn *boxed;         /* +1, the same promise boxed */
  size_t pi;
  bool end;
} ScrPipeDest;

static void scr_pipe_dest_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  ScrPipeDest d = *(ScrPipeDest *)arg;
  free(arg);
  ScrStreamPipeCtx *ctx = d.ctx;
  /* the boxed promise's payload is a dyn value (NULL: undefined) */
  ScrDyn *v = scr_await_ref(d.boxed->v.promise);
  bool rejected = scr_exc_pending();
  ScrStream *pt = ctx->streams ? ctx->streams[d.pi] : NULL;
  if (!rejected) {
    if (ctx->value) scr_dyn_release(ctx->value);
    ctx->value = v;
    if (ctx->value_p) scr_promise_release(ctx->value_p);
    ctx->value_p = scr_promise_retain(d.typed);
    if (pt && v && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_UNDEF) {
      scr_stream_write_dyn(pt, v, NULL);
      if (scr_exc_pending()) scr_exc_clear();
    }
    if (pt && d.end) {
      scr_stream_release(scr_stream_end(pt, NULL, NULL, NULL));
      if (scr_exc_pending()) scr_exc_clear();
    }
    scr_pipe_finish_next_tick(ctx, NULL);
  } else {
    ScrError *err = scr_pump_caught();
    if (pt) scr_stream_release(scr_stream_destroy(pt, err));
    if (scr_exc_pending()) scr_exc_clear();
    scr_pipe_finish_next_tick(ctx, err);
    scr_error_release(err);
  }
  scr_promise_release(d.typed);
  scr_dyn_release(d.boxed);
  scr_stream_pipectx_release_v(ctx);
}

static void scr_pipe_dest_promise(ScrStreamPipeCtx *ctx, ScrPromise *p /*moves*/, ScrClosure *box,
                                  size_t pi, bool end) {
  ScrPipeDest *d = malloc(sizeof *d);
  if (!d) scr_stream_oom();
  d->ctx = scr_stream_pipectx_retain_v(ctx);
  d->typed = p;
  d->boxed = ((ScrPipeBoxFn)box->fn)(box, scr_promise_retain(p));
  d->pi = pi;
  d->end = end;
  scr_promise_release(scr_async_spawn_after(d->boxed->v.promise, &scr_pipe_dest_entry, d));
}

/* An untyped destination's promise: scr_pipe_dest_promise over a promise
 * that already holds dyn values. */
static void scr_pipe_dest_dyn_promise(ScrStreamPipeCtx *ctx, ScrDyn *boxed /*moves*/, size_t pi,
                                      bool end) {
  ScrPipeDest *d = malloc(sizeof *d);
  if (!d) scr_stream_oom();
  d->ctx = scr_stream_pipectx_retain_v(ctx);
  d->typed = scr_promise_retain(boxed->v.promise);
  d->boxed = boxed;
  d->pi = pi;
  d->end = end;
  scr_promise_release(scr_async_spawn_after(d->boxed->v.promise, &scr_pipe_dest_entry, d));
}

typedef ScrGen *(*ScrPipeIterFn)(ScrClosure *, ScrDyn *);
static bool scr_stream_dyn_has_method(const ScrDyn *value, const char *key);
static bool scr_stream_dyn_transform_like(const ScrDyn *value);
static void scr_stream_throw_web_stage(void);
static bool scr_stream_dyn_stage_returned_stream(const ScrDyn *value);
static void scr_stream_throw_invalid_return(const char *expected, const char *name,
                                           const ScrDyn *got);

/* What pipelineImpl does with an untyped destination function's result:
 * a promise settles the pipeline's value (the `then` branch), and an
 * async iterable, or a { readable, writable } pair's readable side, is
 * pumped into the PassThrough. *out answers the promise or that
 * iterable's async generator (+1). Other values throw
 * ERR_INVALID_RETURN_VALUE, and thenables that are not promises and web
 * streams throw the not-supported Error; -1 then. */
enum { SCR_PIPE_DYN_PROMISE, SCR_PIPE_DYN_ITER };
static int scr_pipe_dest_dyn_kind(const ScrPipeStages *fs, ScrDyn *r, void **out) {
  if (r->kind == SCR_DYN_PROMISE) {
    *out = scr_dyn_retain(r);
    return SCR_PIPE_DYN_PROMISE;
  }
  if (r->kind == SCR_DYN_OBJ && scr_stream_dyn_has_method(r, "then")) {
    static const char msg[] =
        "pipeline destinations that return a thenable other than a promise are not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
    return -1;
  }
  if (scr_exc_pending() || scr_stream_dyn_stage_returned_stream(r)) return -1;
  ScrDyn *read = NULL;
  int kind = scr_dyn_iterable_kind(r);
  if (kind < 0) return -1;
  if (r->kind == SCR_DYN_HANDLE &&
      (r->v.handle.tag == SCR_DYNH_WEB_STREAM || r->v.handle.tag == SCR_DYNH_WEB_TRANSFORM ||
       r->v.handle.tag == SCR_DYNH_WS_READABLE)) {
    scr_stream_throw_web_stage();
    return -1;
  }
  if (kind == 2) {
    read = scr_dyn_retain(r);
  } else if (scr_stream_dyn_transform_like(r)) {
    read = scr_dyn_obj_read(r, "readable", 8);
  }
  if (!read) {
    if (!scr_exc_pending()) scr_stream_throw_invalid_return("AsyncIterable or Promise", "destination", r);
    return -1;
  }
  ScrGen *g = ((ScrPipeIterFn)fs->box->fn)(fs->box, read);
  if (!g) return -1;
  *out = g;
  return SCR_PIPE_DYN_ITER;
}

static ScrStream *scr_stream_pipeline_ex(size_t n, ScrStream **streams, ScrClosure *cb,
                                         ScrStreamErrInv inv, bool end_opt, ScrDyn *signal,
                                         ScrAbortAddFn add, const ScrPipeStages *fs,
                                         ScrClosure *abort, ScrPipeValInv val_inv) {
  ScrStreamPipeCtx *ctx = calloc(1, sizeof *ctx);
  if (!ctx) scr_stream_oom();
  ctx->rc = 1;
  ctx->n = n;
  /* a function destination appends its PassThrough */
  size_t room = n + 1;
  ctx->streams = calloc(room, sizeof *ctx->streams);
  ctx->destroyer = calloc(room, sizeof *ctx->destroyer);
  ctx->finished = calloc(room, sizeof *ctx->finished);
  ctx->ended = calloc(room, sizeof *ctx->ended);
  if (!ctx->streams || !ctx->destroyer || !ctx->finished || !ctx->ended) scr_stream_oom();
  for (size_t i = 0; i < n; i++) ctx->streams[i] = scr_stream_retain(streams[i]);
  ctx->cb = cb;
  ctx->inv = inv;
  ctx->val_inv = val_inv;
  ctx->abort = abort ? scr_closure_retain(abort) : NULL;
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(scr_pipe_atexit);
  }
  ctx->live_next = scr_pipe_live;
  if (scr_pipe_live) scr_pipe_live->live_prev = ctx;
  scr_pipe_live = ctx;
  bool aborted = false;
  if (signal) {
    ctx->signal = scr_dyn_retain(signal);
    ScrDyn *a = scr_stream_signal_prop(signal, "aborted");
    aborted = a && scr_dyn_truthy(a);
    if (a) scr_dyn_release(a);
    ScrClosure *clo = scr_pipe_closure((void *)&scr_pipe_abort_thunk, ctx, 0);
    ScrDyn *listener = scr_dyn_new_func(clo, &scr_pipe_abort_thunk, 0, "()", "abort");
    ctx->dispose = add(signal, listener);
    scr_dyn_release(listener);
  }
  /* pipelineImpl's loop over the stages: the n streams and fs->count
   * function stages, at the positions fs->positions names */
  size_t stages = n + (fs ? fs->count : 0);
  ScrStream *ret = NULL;
  ScrGen *ret_gen = NULL; /* +1: ret when the previous stage was a function */
  size_t i = 0;           /* the next stream */
  size_t k = 0;           /* the next function stage */
  size_t h = 0;           /* the next pumped generator's helpers */
  for (size_t j = 0; j < stages; j++) {
    bool reading = j + 1 < stages;
    bool end = reading || end_opt;
    bool last = j + 1 == stages;
    if (scr_pipe_is_stage(fs, j)) {
      /* ret = stage({ signal }) for the source, else
       * stage(makeAsyncIterable(ret), { signal }) */
      bool dest = last && fs->dest != SCR_PIPE_DEST_STREAM;
      void *src = j == 0  ? NULL
                  : ret_gen ? (void *)ret_gen
                            : (void *)scr_stream_retain(ret);
      ret_gen = NULL;
      void *out = scr_pipe_call_stage(fs, k++, src);
      int dyn_kind = -1;
      if (!scr_exc_pending() && dest && fs->dest == SCR_PIPE_DEST_DYN) {
        ScrDyn *r = out ? out : scr_dyn_retain(scr_dyn_undefined());
        out = NULL;
        dyn_kind = scr_pipe_dest_dyn_kind(fs, r, &out);
        scr_dyn_release(r);
      }
      if (scr_exc_pending()) {
        if (out && dest && fs->dest == SCR_PIPE_DEST_DYN) {
          if (dyn_kind == SCR_PIPE_DYN_ITER) scr_gen_release(out);
          else scr_dyn_release(out);
        } else if (out && dest) scr_promise_release(out);
        else if (out) scr_gen_release(out);
        scr_stream_pipectx_drop(ctx);
        scr_stream_pipectx_release_v(ctx);
        return NULL;
      }
      if (!dest) {
        ret_gen = out;
        continue;
      }
      /* The destination function: pipeline() answers an object-mode
       * PassThrough proxy that the promise's value or the generator's
       * values feed. */
      ScrDyn *pt_opts = scr_dyn_new_obj();
      scr_dyn_obj_set(pt_opts, "objectMode", 10, scr_dyn_new_bool(true));
      ScrStream *pt = scr_stream_new_passthrough_dyn(pt_opts);
      scr_dyn_release(pt_opts);
      size_t pi = ctx->n++;
      ctx->streams[pi] = pt;
      ctx->finish_count++;
      if (fs->dest == SCR_PIPE_DEST_GEN ||
          (fs->dest == SCR_PIPE_DEST_DYN && dyn_kind == SCR_PIPE_DYN_ITER)) {
        /* pumpToNode(ret, pt, finish, { end }) */
        scr_pump_start(ctx, out, fs->helpers + 3 * h++, pt, end);
      } else if (fs->dest == SCR_PIPE_DEST_DYN) {
        scr_pipe_dest_dyn_promise(ctx, out, pi, end);
      } else {
        scr_pipe_dest_promise(ctx, out, fs->box, pi, end);
      }
      /* destroyer(pt, false, true), with its cleanup as the last stream's */
      ctx->destroyer[pi] = true;
      scr_pipe_on(pt, "close", scr_pipe_closure((void *)&scr_pipe_destroyer_close_l, ctx, pi),
                  scr_ee_inv_fixed0, false);
      ctx->last_cleanup[ctx->last_cleanups++] =
          scr_pipe_eos(pt, scr_pipe_closure((void *)&scr_pipe_destroyer_eos, ctx, pi),
                       &scr_pipe_destroyer_eos, false, true);
      ret = pt;
      continue;
    }
    ScrStream *s = streams[i];
    if (s->st->pipeline_body) {
      /* ret = Duplex.from(stream) for an argument that is not a stream:
       * no destroyer or 'error' listener, and the previous stage is
       * neither piped nor pumped into it */
      s->st->pipeline_body = false;
      if (ret_gen) {
        scr_gen_release(ret_gen);
        ret_gen = NULL;
        h++;
      }
      ret = s;
      i++;
      continue;
    }
    bool writing = j > 0;
    if (reading && !scr_pipe_is_stage(fs, j + 1) &&
        (streams[i + 1]->st->close_emitted || streams[i + 1]->st->destroyed)) {
      scr_pipe_throw("ERR_STREAM_UNABLE_TO_PIPE", "Cannot pipe to a closed or destroyed stream",
                     SCR_ERR_ERROR);
      scr_stream_pipectx_drop(ctx);
      scr_stream_pipectx_release_v(ctx);
      return NULL;
    }
    bool last_readable = last && scr_stream_prop(s, "readable");
    if (end) {
      ctx->destroyer[i] = true;
      scr_pipe_on(s, "close", scr_pipe_closure((void *)&scr_pipe_destroyer_close_l, ctx, i),
                  scr_ee_inv_fixed0, false);
      ScrClosure *cleanup = scr_pipe_eos(s, scr_pipe_closure((void *)&scr_pipe_destroyer_eos, ctx, i),
                                         &scr_pipe_destroyer_eos, reading, writing);
      if (last_readable) ctx->last_cleanup[ctx->last_cleanups++] = cleanup;
      else scr_closure_release(cleanup);
    }
    ScrClosure *on_error = scr_pipe_closure((void *)&scr_pipe_error_l, ctx, i);
    scr_pipe_on(s, "error", scr_closure_retain(on_error), scr_ee_inv_fixed1, false);
    if (last_readable) ctx->last_error_l = on_error;
    else scr_closure_release(on_error);
    if (ret_gen) {
      /* an async iterable before a stream: pumpToNode(ret, s, finish, { end }) */
      ctx->finish_count++;
      ScrGen *g = ret_gen;
      ret_gen = NULL;
      scr_pump_start(ctx, g, fs->helpers + 3 * h++, s, end);
    } else if (j > 0) {
      if (!ret->st->has_r) {
        static const char msg[] =
            "The \"val\" argument must be an instance of Readable, Iterable, AsyncIterable, "
            "ReadableStream, or TransformStream. Received an instance of Writable";
        scr_pipe_throw("ERR_INVALID_ARG_TYPE", msg, SCR_ERR_TYPE);
        scr_stream_pipectx_drop(ctx);
        scr_stream_pipectx_release_v(ctx);
        return NULL;
      }
      /* pipe(ret, s, finish, finishOnlyHandleError, { end }) */
      ctx->finish_count += 2;
      scr_pipe_on(s, "close", scr_pipe_closure((void *)&scr_pipe_dst_close_l, ctx, i), scr_ee_inv_fixed0,
                  false);
      scr_stream_release(scr_stream_pipe(ret, s, false));
      if (end) {
        ScrClosure *end_fn = scr_pipe_closure((void *)&scr_pipe_end_fn, ctx, i);
        if (ret->st->r.end_emitted) scr_next_tick(end_fn);
        else scr_pipe_on(ret, "end", end_fn, scr_ee_inv_fixed0, true);
      } else {
        scr_pipe_finish_impl(ctx, NULL, --ctx->finish_count == 0);
      }
      scr_closure_release(scr_pipe_eos(ret, scr_pipe_closure((void *)&scr_pipe_src_eos, ctx, i - 1),
                                       &scr_pipe_src_eos, true, false));
      ScrClosure *cleanup = scr_pipe_eos(s, scr_pipe_closure((void *)&scr_pipe_finish_inv, ctx, i),
                                         &scr_pipe_finish_inv, false, true);
      if (scr_stream_prop(s, "readable") && last) ctx->last_cleanup[ctx->last_cleanups++] = cleanup;
      else scr_closure_release(cleanup);
    }
    ret = s;
    i++;
  }
  if (aborted) scr_next_tick(scr_pipe_closure((void *)&scr_pipe_abort_tick, ctx, 0));
  scr_stream_pipectx_release_v(ctx); /* the listeners and the live list hold it */
  return scr_stream_retain(ret);
}

static ScrPipeStages scr_pipe_stages_of(double count, ScrClosure **stages, double positions,
                                        double flags, double mask, ScrClosure **helpers,
                                        ScrClosure *box, ScrDyn *signal) {
  int bits = (int)flags;
  ScrPipeStages fs = {(size_t)count, (uint64_t)positions, stages, (bits >> 1) & 3, (unsigned)mask,
                      signal, helpers, box};
  return fs;
}

/* callback(error, value) through a checked-dynamic callback: Node passes
 * both arguments. A typed callback (SCR_PIPE_TYPED_CB) takes null for no
 * error, as the typed callback forms do. */
static void scr_pipe_dyn_value_call(ScrClosure *cb, ScrError *err, ScrDyn *value, bool typed) {
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *none = typed ? scr_dyn_new_null() : scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *args[2] = {err ? scr_dyn_from_error(err) : none,
                     value && !err ? scr_dyn_retain(value) : scr_dyn_retain(scr_dyn_undefined())};
  if (err) scr_dyn_release(none);
  ScrDyn *r = scr_dyn_call(fn, args, 2, "callback");
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_dyn_release(fn);
  if (r != NULL) scr_dyn_release(r);
}

static void scr_pipe_dyn_value_inv(ScrClosure *cb, ScrError *err, ScrDyn *value, ScrPromise *value_p) {
  (void)value_p;
  scr_pipe_dyn_value_call(cb, err, value, false);
}

static void scr_pipe_dyn_value_typed_inv(ScrClosure *cb, ScrError *err, ScrDyn *value,
                                         ScrPromise *value_p) {
  (void)value_p;
  scr_pipe_dyn_value_call(cb, err, value, true);
}

/* pipeline(...) with function stages (see ScrPipeStages): positions
 * marks the function stages among the n + count stages, flags bits 1-2
 * give the destination kind, and mask names the stages taking
 * { signal }. The helpers, box, signal and abort are borrowed (each NULL
 * when unused); cb moves. */
ScrStream *scr_stream_pipeline_stages(double n, ScrStream **streams, double count,
                                      ScrClosure **stages, double positions, double flags,
                                      double mask, ScrClosure **helpers, ScrClosure *box,
                                      ScrDyn *signal, ScrClosure *abort, ScrClosure *cb,
                                      ScrStreamErrInv inv) {
  ScrPipeStages fs = scr_pipe_stages_of(count, stages, positions, flags, mask, helpers, box, signal);
  return scr_stream_pipeline_ex((size_t)n, streams, cb, inv, true, NULL, NULL, &fs, abort, NULL);
}

ScrStream *scr_stream_pipeline_stages_dyn(double n, ScrStream **streams, double count,
                                          ScrClosure **stages, double positions, double flags,
                                          double mask, ScrClosure **helpers, ScrClosure *box,
                                          ScrDyn *signal, ScrClosure *abort, ScrDyn *cb) {
  ScrPipeStages fs = scr_pipe_stages_of(count, stages, positions, flags, mask, helpers, box, signal);
  ScrClosure *c = scr_stream_dynopt_clo(cb, (void *)&scr_stream_finished_dyn_inv);
  /* a function destination's value reaches the callback */
  ScrPipeValInv vi = fs.dest == SCR_PIPE_DEST_STREAM ? NULL
                     : ((int)flags & SCR_PIPE_TYPED_CB) ? &scr_pipe_dyn_value_typed_inv
                                                        : &scr_pipe_dyn_value_inv;
  return scr_stream_pipeline_ex((size_t)n, streams, c, &scr_stream_finished_dyn_inv, true, NULL,
                                NULL, &fs, abort, vi);
}

ScrStream *scr_stream_pipeline(double n_d, ScrStream **streams /*borrowed*/,
    ScrClosure *cb /*moves*/, ScrStreamErrInv inv) {
  return scr_stream_pipeline_ex((size_t)n_d, streams, cb, inv, true, NULL, NULL, NULL, NULL, NULL);
}

/* The dyn-valued twins: the callback rides as a checked-dynamic value
 * (borrowed; the closure's cap box retains it). */
ScrClosure *scr_stream_finished_dyn(ScrStream *s, ScrDyn *cb) {
  ScrClosure *c = scr_stream_dynopt_clo(cb, (void *)&scr_stream_finished_dyn_inv);
  ScrClosure *cleanup = scr_stream_finished(s, c, &scr_stream_finished_dyn_inv);
  return cleanup;
}

ScrStream *scr_stream_pipeline_dyn(double n, ScrStream **streams, ScrDyn *cb) {
  ScrClosure *c = scr_stream_dynopt_clo(cb, (void *)&scr_stream_finished_dyn_inv);
  return scr_stream_pipeline(n, streams, c, &scr_stream_finished_dyn_inv);
}

/* ── stream.compose (compose.js over stream instances) ────────────────
 * The streams run as a pipeline; the answer is a Duplex whose writes go
 * to the head and whose reads come from the tail. The context is shared
 * by the Duplex's callbacks, the head/tail listeners, the tail's eos
 * watcher and the pipeline callback. It holds the Duplex until the
 * Duplex's destroy completes (or exit), which breaks the cycle through
 * the Duplex's own callbacks. */

enum { SCR_COMPOSE_RUNNING, SCR_COMPOSE_DONE, SCR_COMPOSE_WAIT };

typedef struct ScrCompose {
  size_t rc;
  ScrStream *head, *tail; /* +1 */
  ScrStream *d;           /* +1 until teardown */
  ScrClosure *drain_l, *data_l, *end_l; /* +1, the listeners, or NULL */
  bool readable, writable;
  bool ondrain, onfinish;
  int onclose; /* compose.js's onclose: undefined, null, or d's destroy callback */
  struct ScrCompose *live_prev, *live_next;
} ScrCompose;

static SCR_TL ScrCompose *scr_compose_live = NULL;

static void *scr_compose_retain_v(void *p) {
  ((ScrCompose *)p)->rc++;
  return p;
}

static void scr_compose_release_v(void *p) {
  ScrCompose *c = p;
  if (--c->rc > 0) return;
  if (c->head) scr_stream_release(c->head);
  scr_stream_release(c->tail);
  free(c);
}

static ScrClosure *scr_compose_closure(void *fn, ScrCompose *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&scr_compose_retain_v, &scr_compose_release_v, NULL);
  scr_box_set_ref(cl->caps[0], scr_compose_retain_v(c));
  return cl;
}

static void scr_compose_off(ScrStream *s, const char *name, ScrClosure **l) {
  if (!*l) return;
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_emitter_release(scr_emitter_off((ScrEmitter *)s, n, *l));
  scr_str_release(n);
  scr_closure_release(*l);
  *l = NULL;
}

/* Drop the Duplex and the head/tail listeners. */
static void scr_compose_teardown(ScrCompose *c) {
  if (!c->d) return;
  scr_compose_off(c->head, "drain", &c->drain_l);
  scr_compose_off(c->tail, "data", &c->data_l);
  scr_compose_off(c->tail, "end", &c->end_l);
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else scr_compose_live = c->live_next;
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  ScrStream *d = c->d;
  c->d = NULL;
  scr_stream_release(d);
  scr_compose_release_v(c); /* the live list's reference */
}

static void scr_compose_atexit(void) {
  while (scr_compose_live) scr_compose_teardown(scr_compose_live);
}

static void scr_compose_on(ScrStream *s, const char *name, ScrClosure **slot, void *fn, ScrCompose *c,
                           ScrEeInvoke inv) {
  ScrStr *n = scr_str_new(name, strlen(name));
  *slot = scr_compose_closure(fn, c);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)s, n, scr_closure_retain(*slot), inv, false, false));
  scr_str_release(n);
}

/* d's destroy callback: callback(err), then the context lets go. */
static void scr_compose_destroyed(ScrCompose *c, ScrError *err) {
  ScrStream *d = scr_stream_retain(c->d);
  scr_compose_teardown(c);
  scr_stream_destroy_done(d, err ? scr_error_retain(err) : NULL);
  scr_stream_release(d);
}

/* d._write: head.write(chunk) ? callback() : (ondrain = callback) */
static void scr_compose_write_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  bool ok = scr_stream_writes_values(s) ? scr_stream_write_dyn(c->head, (ScrDyn *)chunk, NULL)
                                        : scr_stream_write(c->head, chunk, NULL);
  if (ok) {
    if (!scr_exc_pending()) scr_stream_write_done(s, NULL);
  } else {
    c->ondrain = true;
  }
  scr_compose_release_v(c);
}

/* d._final: head.end(); onfinish = callback */
static void scr_compose_final_inv(ScrClosure *cb, ScrStream *s) {
  (void)s;
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  ScrStream *r = scr_stream_end(c->head, NULL, NULL, NULL);
  if (r) scr_stream_release(r);
  c->onfinish = true;
  scr_compose_release_v(c);
}

static void scr_compose_drain_l(ScrClosure *cb) {
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  if (c->ondrain && c->d) {
    c->ondrain = false;
    scr_stream_write_done(c->d, NULL);
  }
  scr_compose_release_v(c);
}

/* eos(tail): the pending final callback runs */
static void scr_compose_tail_eos(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  (void)err;
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  if (c->onfinish && c->d) {
    c->onfinish = false;
    scr_stream_final_done(c->d, NULL);
  }
  scr_compose_release_v(c);
}

/* d._read: tail.resume() */
static void scr_compose_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)s;
  (void)size;
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  if (c->d) scr_stream_release(scr_stream_resume(c->tail));
  scr_compose_release_v(c);
}

/* tail.on('data'): d.push(chunk), pausing the tail when d is full. The
 * chunk is the tail's Buffer, its string when the tail is encoded, or an
 * object-mode value. */
static void scr_compose_data_l(ScrClosure *cb, ScrBytes *bytes, ScrStr *str, ScrDyn *value) {
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  ScrStream *d = c->d;
  if (d) {
    ScrStreamState *dst = d->st;
    bool more;
    if (dst->r.object_entries) {
      more = value ? scr_stream_push_object(d, value) > 0
                   : scr_stream_add_entry(d, str ? (void *)scr_str_retain(str) : (void *)scr_bytes_retain(bytes),
                                          str ? SCR_ENTRY_STR : SCR_ENTRY_BYTES) > 0;
    } else if (value && !str && !bytes) {
      more = scr_stream_push_dyn(d, value);
    } else if (str) {
      more = scr_stream_push_str(d, str);
    } else {
      more = scr_stream_push(d, bytes);
    }
    if (!more && !scr_exc_pending() && c->d) scr_stream_release(scr_stream_pause(c->tail));
  }
  scr_compose_release_v(c);
}

static void scr_compose_end_l(ScrClosure *cb) {
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  if (c->d) scr_stream_push_null(c->d);
  scr_compose_release_v(c);
}

static ScrError *scr_compose_abort_error(void) {
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  return e;
}

/* d._destroy */
static void scr_compose_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  ScrError *e = err ? scr_error_retain(err) : NULL;
  if (!e && c->onclose != SCR_COMPOSE_DONE) e = scr_compose_abort_error();
  c->ondrain = c->onfinish = false;
  if (!c->tail->st->destroyed) scr_stream_release(scr_stream_destroy(c->tail, e));
  if (c->onclose == SCR_COMPOSE_DONE) {
    if (c->d) scr_compose_destroyed(c, e);
  } else {
    c->onclose = SCR_COMPOSE_WAIT;
  }
  if (e) scr_error_release(e);
  scr_compose_release_v(c);
}

/* The pipeline callback (compose.js's onfinished). */
static void scr_compose_finished(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  ScrCompose *c = scr_box_get_ref(cb->caps[0]);
  int onclose = c->onclose;
  c->onclose = SCR_COMPOSE_DONE;
  if (onclose == SCR_COMPOSE_WAIT) {
    if (c->d) scr_compose_destroyed(c, err);
  } else if (c->d && (err || (!c->readable && !c->writable))) {
    ScrStream *d = scr_stream_retain(c->d);
    scr_stream_release(scr_stream_destroy(d, err));
    scr_stream_release(d);
  }
  scr_compose_release_v(c);
}

static void scr_compose_arg_value(size_t i, const char *what, ScrStream *s) {
  char m[160];
  int n = snprintf(m, sizeof m, "The argument 'streams[%zu]' must be %s. Received an instance of %s",
                   i, what, s->cls ? s->cls : "Stream");
  scr_throw_error_msg_code(SCR_ERR_TYPE, m, (size_t)n, "ERR_INVALID_ARG_VALUE");
}

/* compose(...streams) over n streams and fs's function stages: the stream
 * at pipeline position j must be readable unless it is last and writable
 * unless it is first. A first stage that is not a stream (an iterable or
 * source function) leaves the Duplex without a writable side. */
static ScrStream *scr_stream_compose_impl(size_t n, ScrStream **streams, const ScrPipeStages *fs,
                                          ScrClosure *abort) {
  size_t total = n + (fs ? fs->count : 0);
  if (total == 0) {
    static const char msg[] = "The \"streams\" argument must be specified";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_MISSING_ARGS");
    return NULL;
  }
  if (total == 1 && n == 1) return scr_stream_retain(streams[0]); /* Duplex.from(duplex) */
  for (size_t j = 0, i = 0; j < total; j++) {
    if (fs && j < 64 && ((fs->positions >> j) & 1u)) continue;
    if (j + 1 < total && !scr_stream_prop(streams[i], "readable")) {
      scr_compose_arg_value(j, "readable", streams[i]);
      return NULL;
    }
    if (j > 0 && !scr_stream_prop(streams[i], "writable")) {
      scr_compose_arg_value(j, "writable", streams[i]);
      return NULL;
    }
    i++;
  }
  bool stage_head = fs && (fs->positions & 1u);
  ScrCompose *c = calloc(1, sizeof *c);
  if (!c) scr_stream_oom();
  c->rc = 1;
  c->head = stage_head ? NULL : scr_stream_retain(streams[0]);
  c->tail = scr_stream_retain(streams[n - 1]);
  c->onclose = SCR_COMPOSE_RUNNING;
  ScrStream *tail = scr_stream_pipeline_ex(n, streams, scr_compose_closure((void *)&scr_compose_finished, c),
                                           &scr_compose_finished, true, NULL, NULL, fs, abort,
                                           NULL);
  if (!tail) {
    scr_compose_release_v(c);
    return NULL;
  }
  scr_stream_release(tail);
  c->writable = c->head && scr_stream_prop(c->head, "writable") != 0;
  c->readable = scr_stream_prop(c->tail, "readable") != 0;
  /* readableObjectMode: !!tail?.readableObjectMode, writableObjectMode:
   * !!head?.writableObjectMode */
  bool object_mode = c->tail->st->has_r && c->tail->st->r.object_entries;
  bool w_object = c->head && c->head->st->has_w && c->head->st->w.object_mode;
  ScrStream *d = scr_stream_new_duplex(
      object_mode ? 16 : -1, w_object ? 16 : -1, true, true, true, c->readable, c->writable,
      c->readable ? scr_compose_closure((void *)&scr_compose_read_inv, c) : NULL,
      c->readable ? &scr_compose_read_inv : NULL,
      c->writable ? scr_compose_closure((void *)&scr_compose_write_inv, c) : NULL,
      c->writable ? &scr_compose_write_inv : NULL,
      c->writable ? scr_compose_closure((void *)&scr_compose_final_inv, c) : NULL,
      c->writable ? &scr_compose_final_inv : NULL,
      scr_compose_closure((void *)&scr_compose_destroy_inv, c), &scr_compose_destroy_inv);
  if (object_mode) d->st->r.object_entries = true;
  if (w_object) scr_stream_set_object_mode(d, false, true);
  c->d = scr_stream_retain(d);
  if (c->writable) {
    scr_compose_on(c->head, "drain", &c->drain_l, (void *)&scr_compose_drain_l, c, scr_ee_inv_fixed0);
    scr_closure_release(scr_stream_finished(
        c->tail, scr_compose_closure((void *)&scr_compose_tail_eos, c), &scr_compose_tail_eos));
  }
  if (c->readable) {
    scr_compose_on(c->tail, "data", &c->data_l, (void *)&scr_compose_data_l, c, scr_ee_inv_fixed3);
    scr_compose_on(c->tail, "end", &c->end_l, (void *)&scr_compose_end_l, c, scr_ee_inv_fixed0);
  }
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(scr_compose_atexit);
  }
  c->live_next = scr_compose_live;
  if (scr_compose_live) scr_compose_live->live_prev = c;
  scr_compose_live = c; /* the reference c was created with */
  return d;
}

ScrStream *scr_stream_compose(double n_d, ScrStream **streams) {
  return scr_stream_compose_impl((size_t)n_d, streams, NULL, NULL);
}

/* compose(...stages) with function stages among the streams (the
 * pipeline stage layout: scr_stream_pipeline_stages). */
ScrStream *scr_stream_compose_stages(double n, ScrStream **streams, double count, ScrClosure **stages,
                                     double positions, double flags, double mask, ScrClosure **helpers,
                                     ScrClosure *box, ScrDyn *signal, ScrClosure *abort) {
  ScrPipeStages fs = scr_pipe_stages_of(count, stages, positions, flags, mask, helpers, box, signal);
  return scr_stream_compose_impl((size_t)n, streams, &fs, abort);
}

/* ── Duplex.from over a stream or a { readable, writable } pair ─────────
 * duplexify.js's _duplexify({ readable, writable }): a Duplexify that
 * writes to w (write() answering false waits for 'drain'; final ends w and
 * waits for its 'finish') and reads r through 'readable' and read(), with
 * each side's end of stream (eos) finishing the Duplex. The readable and
 * writable object modes follow r's and w's. */

enum { SCR_DUPX_UNSET, SCR_DUPX_NULL, SCR_DUPX_WAIT };

typedef struct ScrDuplexify {
  size_t rc;
  ScrStream *r, *w;  /* +1 or NULL */
  ScrStream *d;      /* +1 until teardown */
  ScrClosure *drain_l, *finish_l, *readable_l, *end_l; /* +1, the listeners, or NULL */
  ScrClosure *r_eos, *w_eos; /* +1: the eos listeners' cleanups, or NULL */
  bool readable, writable;
  bool ondrain, onfinish, onreadable;
  int onclose; /* _duplexify's onclose: undefined, null, or d's destroy callback */
  struct ScrDuplexify *live_prev, *live_next;
} ScrDuplexify;

static SCR_TL ScrDuplexify *scr_dupx_live = NULL;

static void *scr_dupx_retain_v(void *p) {
  ((ScrDuplexify *)p)->rc++;
  return p;
}

static void scr_dupx_release_v(void *p) {
  ScrDuplexify *x = p;
  if (--x->rc > 0) return;
  if (x->r_eos) scr_closure_release(x->r_eos);
  if (x->w_eos) scr_closure_release(x->w_eos);
  if (x->r) scr_stream_release(x->r);
  if (x->w) scr_stream_release(x->w);
  free(x);
}

static ScrClosure *scr_dupx_closure(void *fn, ScrDuplexify *x) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&scr_dupx_retain_v, &scr_dupx_release_v, NULL);
  scr_box_set_ref(cl->caps[0], scr_dupx_retain_v(x));
  return cl;
}

static void scr_dupx_on(ScrStream *s, const char *name, ScrClosure **slot, void *fn, ScrDuplexify *x) {
  ScrStr *n = scr_str_new(name, strlen(name));
  *slot = scr_dupx_closure(fn, x);
  scr_emitter_release(
      scr_emitter_on((ScrEmitter *)s, n, scr_closure_retain(*slot), scr_ee_inv_fixed0, false, false));
  scr_str_release(n);
}

/* Drop the Duplex and the listeners on r and w (the eos listeners stay
 * registered; their cleanups, which hold the context, are dropped). */
static void scr_dupx_teardown(ScrDuplexify *x) {
  if (!x->d) return;
  if (x->r_eos) scr_closure_release(x->r_eos);
  if (x->w_eos) scr_closure_release(x->w_eos);
  x->r_eos = x->w_eos = NULL;
  if (x->w) {
    scr_compose_off(x->w, "drain", &x->drain_l);
    scr_compose_off(x->w, "finish", &x->finish_l);
  }
  if (x->r) {
    scr_compose_off(x->r, "readable", &x->readable_l);
    scr_compose_off(x->r, "end", &x->end_l);
  }
  if (x->live_prev) x->live_prev->live_next = x->live_next;
  else scr_dupx_live = x->live_next;
  if (x->live_next) x->live_next->live_prev = x->live_prev;
  x->live_prev = x->live_next = NULL;
  ScrStream *d = x->d;
  x->d = NULL;
  scr_stream_release(d);
  scr_dupx_release_v(x); /* the live list's reference */
}

/* At exit, a Duplexify still open also drops its eos listeners on r and
 * w: they hold the context, which holds r and w. */
static void scr_dupx_atexit(void) {
  while (scr_dupx_live) {
    ScrDuplexify *x = scr_dupx_live;
    ScrClosure *eos[2] = {x->r_eos, x->w_eos};
    x->r_eos = x->w_eos = NULL;
    for (int i = 0; i < 2; i++) {
      if (!eos[i]) continue;
      ((void (*)(ScrClosure *))eos[i]->fn)(eos[i]);
      scr_closure_release(eos[i]);
    }
    scr_dupx_teardown(x);
  }
}

/* d's destroy callback: callback(err), then the context lets go. */
static void scr_dupx_destroyed(ScrDuplexify *x, ScrError *err) {
  ScrStream *d = scr_stream_retain(x->d);
  scr_dupx_teardown(x);
  scr_stream_destroy_done(d, err ? scr_error_retain(err) : NULL);
  scr_stream_release(d);
}

/* onfinished(err): the pending destroy callback, else d.destroy(err) */
static void scr_dupx_onfinished(ScrDuplexify *x, ScrError *err) {
  int onclose = x->onclose;
  x->onclose = SCR_DUPX_NULL;
  if (!x->d) return;
  if (onclose == SCR_DUPX_WAIT) {
    scr_dupx_destroyed(x, err);
  } else if (err) {
    ScrStream *d = scr_stream_retain(x->d);
    scr_stream_release(scr_stream_destroy(d, err));
    scr_stream_release(d);
  }
}

/* eos(w): writable = false; an error destroys r */
static void scr_dupx_w_eos(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  x->writable = false;
  if (err && x->r) scr_stream_release(scr_stream_destroy(x->r, err));
  scr_dupx_onfinished(x, err);
  scr_dupx_release_v(x);
}

/* eos(r): readable = false; an error destroys w */
static void scr_dupx_r_eos(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  x->readable = false;
  if (err && x->w) scr_stream_release(scr_stream_destroy(x->w, err));
  scr_dupx_onfinished(x, err);
  scr_dupx_release_v(x);
}

/* d._write: w.write(chunk) ? callback() : (ondrain = callback) */
static void scr_dupx_write_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  bool ok = scr_stream_writes_values(s) ? scr_stream_write_dyn(x->w, (ScrDyn *)chunk, NULL)
                                        : scr_stream_write(x->w, chunk, NULL);
  if (ok) {
    if (!scr_exc_pending()) scr_stream_write_done(s, NULL);
  } else {
    x->ondrain = true;
  }
  scr_dupx_release_v(x);
}

/* d._final: w.end(); onfinish = callback */
static void scr_dupx_final_inv(ScrClosure *cb, ScrStream *s) {
  (void)s;
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  ScrStream *r = scr_stream_end(x->w, NULL, NULL, NULL);
  if (r) scr_stream_release(r);
  x->onfinish = true;
  scr_dupx_release_v(x);
}

static void scr_dupx_drain_l(ScrClosure *cb) {
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  if (x->ondrain && x->d) {
    x->ondrain = false;
    scr_stream_write_done(x->d, NULL);
  }
  scr_dupx_release_v(x);
}

static void scr_dupx_finish_l(ScrClosure *cb) {
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  if (x->onfinish && x->d) {
    x->onfinish = false;
    scr_stream_final_done(x->d, NULL);
  }
  scr_dupx_release_v(x);
}

/* d._read: push r.read() until it answers null (then wait for 'readable')
 * or d is full */
static void scr_dupx_pull(ScrDuplexify *x) {
  ScrStream *d = x->d;
  while (d && x->r) {
    ScrEntryKind kind = SCR_ENTRY_BYTES;
    void *chunk = scr_stream_read_n_kind(x->r, -1, &kind);
    if (scr_exc_pending()) return;
    if (!chunk) {
      x->onreadable = true;
      return;
    }
    bool more;
    if (d->st->r.object_entries) {
      more = scr_stream_add_entry(d, chunk, kind) > 0;
    } else if (kind == SCR_ENTRY_STR) {
      more = scr_stream_push_str(d, chunk);
      scr_str_release(chunk);
    } else if (kind == SCR_ENTRY_DYN) {
      more = scr_stream_push_dyn(d, chunk);
      scr_dyn_release(chunk);
    } else {
      more = scr_stream_push(d, chunk);
      scr_bytes_release(chunk);
    }
    if (!more || scr_exc_pending()) return;
  }
}

static void scr_dupx_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)s;
  (void)size;
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  x->onreadable = false;
  scr_dupx_pull(x);
  scr_dupx_release_v(x);
}

static void scr_dupx_readable_l(ScrClosure *cb) {
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  if (x->onreadable && x->d) {
    x->onreadable = false;
    scr_dupx_pull(x);
  }
  scr_dupx_release_v(x);
}

static void scr_dupx_end_l(ScrClosure *cb) {
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  if (x->d) scr_stream_push_null(x->d);
  scr_dupx_release_v(x);
}

/* d._destroy */
static void scr_dupx_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  ScrDuplexify *x = scr_box_get_ref(cb->caps[0]);
  ScrError *e = err ? scr_error_retain(err) : NULL;
  if (!e && x->onclose != SCR_DUPX_NULL) e = scr_compose_abort_error();
  x->onreadable = x->ondrain = x->onfinish = false;
  if (x->onclose == SCR_DUPX_NULL) {
    if (x->d) scr_dupx_destroyed(x, e);
  } else {
    x->onclose = SCR_DUPX_WAIT;
    if (x->w && !x->w->st->destroyed) scr_stream_release(scr_stream_destroy(x->w, e));
    if (x->r && !x->r->st->destroyed) scr_stream_release(scr_stream_destroy(x->r, e));
  }
  if (e) scr_error_release(e);
  scr_dupx_release_v(x);
}

/* _duplexify({ readable: r, writable: w }): r and w borrowed, either NULL.
 * +1. */
ScrStream *scr_stream_duplexify(ScrStream *r, ScrStream *w) {
  ScrDuplexify *x = calloc(1, sizeof *x);
  if (!x) scr_stream_oom();
  x->rc = 1;
  x->r = r ? scr_stream_retain(r) : NULL;
  x->w = w ? scr_stream_retain(w) : NULL;
  x->onclose = SCR_DUPX_UNSET;
  x->readable = r && scr_stream_prop(r, "readable") != 0;
  x->writable = w && scr_stream_prop(w, "writable") != 0;
  /* new Duplexify({ readableObjectMode, writableObjectMode, readable, writable }) */
  bool r_object = r && r->st->has_r && r->st->r.object_entries;
  bool w_object = w && w->st->has_w && w->st->w.object_mode;
  ScrStream *d = scr_stream_new_duplex(
      r_object ? 16 : -1, w_object ? 16 : -1, true, true, true, x->readable, x->writable,
      x->readable ? scr_dupx_closure((void *)&scr_dupx_read_inv, x) : NULL,
      x->readable ? &scr_dupx_read_inv : NULL,
      x->writable ? scr_dupx_closure((void *)&scr_dupx_write_inv, x) : NULL,
      x->writable ? &scr_dupx_write_inv : NULL,
      x->writable ? scr_dupx_closure((void *)&scr_dupx_final_inv, x) : NULL,
      x->writable ? &scr_dupx_final_inv : NULL,
      scr_dupx_closure((void *)&scr_dupx_destroy_inv, x), &scr_dupx_destroy_inv);
  if (r_object) d->st->r.object_entries = true;
  if (w_object) scr_stream_set_object_mode(d, false, true);
  d->cls = "Duplexify";
  x->d = scr_stream_retain(d);
  if (x->writable) {
    x->w_eos = scr_stream_finished(w, scr_dupx_closure((void *)&scr_dupx_w_eos, x), &scr_dupx_w_eos);
    scr_dupx_on(w, "drain", &x->drain_l, (void *)&scr_dupx_drain_l, x);
    scr_dupx_on(w, "finish", &x->finish_l, (void *)&scr_dupx_finish_l, x);
  }
  if (x->readable) {
    x->r_eos = scr_stream_finished(r, scr_dupx_closure((void *)&scr_dupx_r_eos, x), &scr_dupx_r_eos);
    scr_dupx_on(r, "readable", &x->readable_l, (void *)&scr_dupx_readable_l, x);
    scr_dupx_on(r, "end", &x->end_l, (void *)&scr_dupx_end_l, x);
  }
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(scr_dupx_atexit);
  }
  x->live_next = scr_dupx_live;
  if (scr_dupx_live) scr_dupx_live->live_prev = x;
  scr_dupx_live = x; /* the reference x was created with */
  return d;
}

/* Duplex.from(promise) (duplexify.js): a Duplexify({ objectMode: true,
 * writable: false, read() {} }) that pushes the promise's value unless it
 * is nullish, then ends; a rejection destroys it with the reason. */
typedef struct {
  ScrStream *d;  /* +1 */
  ScrDyn *boxed; /* +1, the promise boxed */
} ScrDupxPromise;

static void scr_dupx_noop_read(ScrClosure *cb, ScrStream *s, double size) {
  (void)cb;
  (void)s;
  (void)size;
}

static void scr_dupx_promise_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  ScrDupxPromise p = *(ScrDupxPromise *)arg;
  free(arg);
  /* the boxed promise's payload is a dyn value (NULL: undefined) */
  ScrDyn *v = scr_await_ref(p.boxed->v.promise);
  if (!scr_exc_pending()) {
    if (v && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_UNDEF) scr_stream_push_object(p.d, v);
    if (!scr_exc_pending()) scr_stream_push_null(p.d);
    if (scr_exc_pending()) scr_exc_clear();
    if (v) scr_dyn_release(v);
  } else {
    ScrError *err = scr_pump_caught();
    scr_stream_release(scr_stream_destroy(p.d, err));
    if (scr_exc_pending()) scr_exc_clear();
    scr_error_release(err);
  }
  scr_stream_release(p.d);
  scr_dyn_release(p.boxed);
}

/* The readable Duplexify over a boxed promise (moves boxed). +1. */
static ScrStream *scr_dupx_from_boxed(ScrDyn *boxed) {
  ScrClosure *read = scr_closure_new((void *)&scr_dupx_noop_read, 0);
  ScrStream *d = scr_stream_new_duplex(16, 16, true, true, true, true, false, read,
                                       &scr_dupx_noop_read, NULL, NULL, NULL, NULL, NULL, NULL);
  scr_stream_set_object_mode(d, true, true);
  d->cls = "Duplexify";
  ScrDupxPromise *ctx = malloc(sizeof *ctx);
  if (!ctx) scr_stream_oom();
  ctx->d = scr_stream_retain(d);
  ctx->boxed = boxed;
  scr_promise_release(scr_async_spawn_after(ctx->boxed->v.promise, &scr_dupx_promise_entry, ctx));
  return d;
}

/* p and box borrowed (box: the compiler's promise → dyn promise helper). +1. */
ScrStream *scr_stream_duplex_from_promise(ScrPromise *p, ScrClosure *box) {
  return scr_dupx_from_boxed(((ScrPipeBoxFn)box->fn)(box, scr_promise_retain(p)));
}

ScrStream *scr_stream_duplexify_readable(ScrStream *r) { return scr_stream_duplexify(r, NULL); }
ScrStream *scr_stream_duplexify_writable(ScrStream *w) { return scr_stream_duplexify(NULL, w); }
ScrStream *scr_stream_duplexify_pair(ScrStream *r, ScrStream *w) { return scr_stream_duplexify(r, w); }

/* ── node:stream/promises ─────────────────────────────────────────────
 * The promise forms ride the callback machinery above with a settling
 * watcher: caps[0] boxes the pending promise; the terminal status
 * fulfills (NULL) or rejects (the error moves through the exception
 * cell, the reject-pending pattern). */

static void scr_sp_settle_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  ScrPromise *p = scr_box_get_ref(cb->caps[0]); /* +1 */
  if (err != NULL) {
    scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(p);
  } else {
    scr_promise_fulfill_void(p);
  }
  scr_promise_release(p);
}

static ScrClosure *scr_sp_watcher(ScrPromise *p /*borrowed*/) {
  ScrClosure *w = scr_closure_new((void *)&scr_sp_settle_inv, 1);
  w->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
  scr_box_set_ref(w->caps[0], scr_promise_retain(p));
  return w;
}

ScrPromise *scr_sp_finished(ScrStream *s) {
  ScrPromise *p = scr_promise_new();
  /* The cleanup closure is the callback form's return value; the promise
   * form exposes no unhook, so it drops here (the watcher stays parked —
   * scr_stream_finished retained it into the stream's list). */
  ScrClosure *cleanup = scr_stream_finished(s, scr_sp_watcher(p), &scr_sp_settle_inv);
  scr_closure_release(cleanup);
  return p;
}

ScrPromise *scr_sp_pipeline(double n, ScrStream **streams) {
  ScrPromise *p = scr_promise_new();
  ScrStream *dst = scr_stream_pipeline(n, streams, scr_sp_watcher(p), &scr_sp_settle_inv);
  if (dst) scr_stream_release(dst);
  else scr_promise_reject_pending(p);
  return p;
}

/* The promise form's settlement with the destination's value: a
 * promise destination's value settles the result as it settled the
 * destination's own promise (same inner type). */
static void scr_sp_value_inv(ScrClosure *cb, ScrError *err, ScrDyn *value, ScrPromise *value_p) {
  (void)value;
  ScrPromise *p = scr_box_get_ref(cb->caps[0]); /* +1 */
  if (err != NULL) {
    scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(p);
  } else if (value_p != NULL) {
    scr_promise_fulfill_like(p, value_p);
  } else {
    scr_promise_fulfill_void(p);
  }
  scr_promise_release(p);
}

/* scr_sp_value_inv for an untyped destination (SCR_PIPE_DEST_DYN), whose
 * result promise carries a dyn value: when the destination returned an
 * async iterable (no promise), or its promise carries no payload, the
 * result is undefined, as in Node. */
static void scr_sp_dyn_value_inv(ScrClosure *cb, ScrError *err, ScrDyn *value,
                                 ScrPromise *value_p) {
  if (err != NULL || (value_p != NULL && scr_promise_payload_kind(value_p) != SCR_EXC_NONE)) {
    scr_sp_value_inv(cb, err, value, value_p);
    return;
  }
  ScrPromise *p = scr_box_get_ref(cb->caps[0]); /* +1 */
  scr_promise_fulfill_ref(p, scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v,
                          scr_dyn_release_v, NULL);
  scr_promise_release(p);
}

ScrPromise *scr_sp_pipeline_stages(double n, ScrStream **streams, double count,
                                   ScrClosure **stages, double positions, double flags,
                                   double mask, ScrClosure **helpers, ScrClosure *box,
                                   ScrDyn *signal, ScrClosure *abort) {
  ScrPromise *p = scr_promise_new();
  ScrPipeStages fs = scr_pipe_stages_of(count, stages, positions, flags, mask, helpers, box, signal);
  ScrPipeValInv vi = fs.dest == SCR_PIPE_DEST_STREAM ? NULL
                     : fs.dest == SCR_PIPE_DEST_DYN  ? &scr_sp_dyn_value_inv
                                                     : &scr_sp_value_inv;
  ScrStream *dst = scr_stream_pipeline_ex((size_t)n, streams, scr_sp_watcher(p), &scr_sp_settle_inv,
                                          true, NULL, NULL, &fs, abort, vi);
  if (dst) scr_stream_release(dst);
  else scr_promise_reject_pending(p);
  return p;
}

/* The options' signal: NULL for a nullish one; false (p rejected with
 * ERR_INVALID_ARG_TYPE) for a value that is not an AbortSignal. */
static bool scr_sp_opts_signal(ScrPromise *p, ScrDyn **signal) {
  if (*signal && scr_dyn_is_nullish(*signal)) *signal = NULL;
  if (!*signal) return true;
  ScrDyn *aborted = NULL;
  if ((*signal)->kind == SCR_DYN_OBJ || (*signal)->kind == SCR_DYN_HANDLE) {
    aborted = scr_stream_signal_prop(*signal, "aborted");
  }
  if (!aborted) {
    scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", *signal);
    scr_promise_reject_pending(p);
    return false;
  }
  scr_dyn_release(aborted);
  return true;
}

/* pipeline(...streams, { signal, end }): end false leaves the destination
 * open (the promise settles once the stages before it finish); signal is
 * NULL or borrowed — a value that is not an AbortSignal rejects with
 * ERR_INVALID_ARG_TYPE before anything is piped. */
ScrPromise *scr_sp_pipeline_opts(double n, ScrStream **streams, bool end, ScrDyn *signal,
                                 ScrAbortAddFn add) {
  ScrPromise *p = scr_promise_new();
  if (!scr_sp_opts_signal(p, &signal)) return p;
  ScrStream *dst = scr_stream_pipeline_ex((size_t)n, streams, scr_sp_watcher(p),
                                          &scr_sp_settle_inv, end, signal, add, NULL, NULL, NULL);
  if (dst) scr_stream_release(dst);
  else scr_promise_reject_pending(p);
  return p;
}

/* scr_sp_pipeline_stages with the options argument: end and the
 * options' signal (outer, NULL or borrowed) as scr_sp_pipeline_opts
 * takes them. The stages' signal is the pipeline's own. */
ScrPromise *scr_sp_pipeline_stages_opts(double n, ScrStream **streams, double count,
                                        ScrClosure **stages, double positions, double flags,
                                        double mask, ScrClosure **helpers, ScrClosure *box,
                                        ScrDyn *signal, ScrClosure *abort, bool end,
                                        ScrDyn *outer, ScrAbortAddFn add) {
  ScrPromise *p = scr_promise_new();
  if (!scr_sp_opts_signal(p, &outer)) return p;
  ScrPipeStages fs = scr_pipe_stages_of(count, stages, positions, flags, mask, helpers, box, signal);
  ScrPipeValInv vi = fs.dest == SCR_PIPE_DEST_STREAM ? NULL
                     : fs.dest == SCR_PIPE_DEST_DYN  ? &scr_sp_dyn_value_inv
                                                     : &scr_sp_value_inv;
  ScrStream *dst = scr_stream_pipeline_ex((size_t)n, streams, scr_sp_watcher(p), &scr_sp_settle_inv,
                                          end, outer, add, &fs, abort, vi);
  if (dst) scr_stream_release(dst);
  else scr_promise_reject_pending(p);
  return p;
}

/* ── node:stream/consumers ────────────────────────────────────────────
 * text/json/buffer/arrayBuffer over the readable machinery: a native 'data' listener
 * accumulates every chunk (Buffer chunks as-is; string chunks — an
 * encoded stream or Readable.from strings — as their utf8 bytes, the
 * Blob rule Node's consumers share for whole-stream accumulation), and
 * the finished watcher settles at the terminal point — the accumulated
 * result on a clean end (right after 'close', Node's own timing: the
 * consumer's async iterator completes through eos), the stream's error,
 * or ERR_STREAM_PREMATURE_CLOSE on an early close — and marks lifecycle
 * errors handled, exactly like the iterator's eos registration. Both
 * closures share the cap layout: caps[0] the pending promise, caps[1]
 * the chunk list (Buffer entries). */

enum { SCR_SC_TEXT = 0, SCR_SC_JSON = 1, SCR_SC_BUFFER = 2, SCR_SC_ARRAY_BUFFER = 3 };

static void scr_sc_settle_ok(ScrClosure *cb, int kind) {
  ScrPromise *p = scr_box_get_ref(cb->caps[0]);  /* +1 */
  ScrArr *chunks = scr_box_get_ref(cb->caps[1]); /* +1 */
  ScrBytes *all = scr_bytes_concat(chunks);
  scr_arr_release(chunks);
  if (kind == SCR_SC_BUFFER) {
    scr_promise_fulfill_ref(p, all, scr_bytes_retain_v, scr_bytes_release_v, NULL);
    scr_promise_release(p);
    return;
  }
  if (kind == SCR_SC_ARRAY_BUFFER) {
    /* The concatenation is a fresh exact-length owner, so the buffer
     * wraps it with no second copy (Node copies into a Blob, then out). */
    ScrDyn *ab = scr_array_buffer_from_bytes(all);
    scr_bytes_release(all);
    scr_promise_fulfill_ref(p, ab, scr_dyn_retain_v, scr_dyn_release_v, NULL);
    scr_promise_release(p);
    return;
  }
  ScrStr *enc = scr_str_new("utf8", 4);
  ScrStr *text = scr_bytes_to_str(all, enc); /* U+FFFD per invalid subpart */
  scr_str_release(enc);
  scr_bytes_release(all);
  if (kind == SCR_SC_TEXT) {
    scr_promise_fulfill_str(p, text); /* moves */
  } else {
    ScrDyn *doc = scr_json_parse(text);
    scr_str_release(text);
    if (doc == NULL) {
      /* the parse's SyntaxError rides the cell — the rejection, like
       * Node's json() rejecting with JSON.parse's throw */
      scr_promise_reject_pending(p);
    } else {
      scr_promise_fulfill_ref(p, doc, scr_dyn_retain_v, scr_dyn_release_v, NULL);
    }
  }
  scr_promise_release(p);
}

/* The 'data' accumulation (the emit ABI's two payload slots — exactly
 * one non-NULL). */
/* An object-mode value other than a string or a Buffer reaching a
 * runtime consumer that reads text or bytes (stream/consumers, readline). */
static void scr_stream_value_consumer_fence(const char *consumer) {
  char msg[160];
  int n = snprintf(msg, sizeof msg,
                   "%s over an object-mode stream value that is not a string or Buffer is not supported yet",
                   consumer);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)n, "SC2020");
}

static void scr_sc_data(ScrClosure *cb, void *b, void *str, void *value) {
  if (b == NULL && str == NULL && value != NULL) {
    scr_stream_value_consumer_fence("stream/consumers");
    return;
  }
  ScrArr *chunks = scr_box_get_ref(cb->caps[1]); /* +1 */
  if (b != NULL) {
    scr_arr_push_ref(chunks, scr_bytes_retain((ScrBytes *)b));
  } else if (str != NULL) {
    ScrStr *enc = scr_str_new("utf8", 4);
    scr_arr_push_ref(chunks, scr_bytes_from_str((ScrStr *)str, enc));
    scr_str_release(enc);
  }
  scr_arr_release(chunks);
}

static void scr_sc_fin(ScrClosure *cb, ScrError *err, int kind) {
  if (err != NULL) {
    ScrPromise *p = scr_box_get_ref(cb->caps[0]); /* +1 */
    scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    scr_promise_reject_pending(p);
    scr_promise_release(p);
    return;
  }
  scr_sc_settle_ok(cb, kind);
}

static void scr_sc_fin_text(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  scr_sc_fin(cb, err, SCR_SC_TEXT);
}
static void scr_sc_fin_json(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  scr_sc_fin(cb, err, SCR_SC_JSON);
}
static void scr_sc_fin_buffer(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  scr_sc_fin(cb, err, SCR_SC_BUFFER);
}
static void scr_sc_fin_array_buffer(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  scr_sc_fin(cb, err, SCR_SC_ARRAY_BUFFER);
}

static ScrClosure *scr_sc_closure(void *fn, ScrPromise *p, ScrArr *chunks) {
  ScrClosure *c = scr_closure_new(fn, 2);
  c->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
  scr_box_set_ref(c->caps[0], scr_promise_retain(p));
  c->caps[1] = scr_box_new_obj(scr_arr_retain_v, scr_arr_release_v, NULL);
  scr_box_set_ref(c->caps[1], scr_arr_retain(chunks));
  return c;
}

static ScrPromise *scr_sc_consume(ScrStream *s, int kind) {
  ScrPromise *p = scr_promise_new();
  if (s->st == NULL || !s->st->has_r) {
    /* Node's consumers for-await the argument; a stream with no readable
     * side has no async iterator — the TypeError rejects. */
    static const char msg[] = "stream is not async iterable";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    scr_promise_reject_pending(p);
    return p;
  }
  static ScrArrOps bytes_ops = { scr_bytes_retain_v, scr_bytes_release_v, NULL };
  ScrArr *chunks = scr_arr_new_ops(&bytes_ops, 4);
  ScrStreamErrInv fin_inv = kind == SCR_SC_TEXT    ? &scr_sc_fin_text
                            : kind == SCR_SC_JSON  ? &scr_sc_fin_json
                            : kind == SCR_SC_BUFFER ? &scr_sc_fin_buffer
                                                    : &scr_sc_fin_array_buffer;
  /* The terminal watcher first (it marks lifecycle errors handled); the
   * promise form exposes no unhook — the cleanup closure drops. */
  ScrClosure *cleanup = scr_stream_finished(s, scr_sc_closure((void *)fin_inv, p, chunks), fin_inv);
  scr_closure_release(cleanup);
  ScrStr *dn = scr_str_new("data", 4);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)s, dn,
                                     scr_sc_closure((void *)&scr_sc_data, p, chunks),
                                     scr_ee_inv_fixed3, false, false));
  scr_str_release(dn);
  /* resume() rather than the 'data' hook alone: Node's consumer pulls
   * through the iterator, which drains a PAUSED stream too. */
  scr_stream_release(scr_stream_resume(s));
  scr_arr_release(chunks);
  return p;
}

ScrPromise *scr_sc_text(ScrStream *s) { return scr_sc_consume(s, SCR_SC_TEXT); }
ScrPromise *scr_sc_json(ScrStream *s) { return scr_sc_consume(s, SCR_SC_JSON); }
ScrPromise *scr_sc_buffer(ScrStream *s) { return scr_sc_consume(s, SCR_SC_BUFFER); }
ScrPromise *scr_sc_array_buffer(ScrStream *s) { return scr_sc_consume(s, SCR_SC_ARRAY_BUFFER); }

/* ── stream.addAbortSignal and the constructors' signal option ─────────
 * lib/internal/streams/add-abort-signal.js: the signal must be an object
 * with an `aborted` property (ERR_INVALID_ARG_TYPE otherwise). An aborted
 * signal destroys the stream now with new AbortError(undefined, { cause:
 * signal.reason }); otherwise an abort listener does it later, and the
 * listener is removed when the stream finishes (eos — whose own 'error'
 * listener also marks the stream's errors handled). The signal's
 * properties are read through the generic checked-dynamic getters, and
 * addAbortListener arrives as `add` from the event-target unit, so this
 * unit links without it. */

static ScrDyn *scr_stream_signal_prop(ScrDyn *signal, const char *key) {
  size_t n = strlen(key);
  if (signal->kind == SCR_DYN_OBJ) {
    ScrDyn *v = scr_dyn_obj_get(signal, key, n);
    return v ? scr_dyn_retain(v) : NULL;
  }
  ScrStr *k = scr_str_new(key, n);
  ScrDyn *v = scr_dyn_handle_key_get(signal, k);
  scr_str_release(k);
  return v;
}

static bool scr_stream_signal_aborted(ScrDyn *signal) {
  ScrDyn *aborted = scr_stream_signal_prop(signal, "aborted");
  bool is_aborted = aborted && scr_dyn_truthy(aborted);
  if (aborted) scr_dyn_release(aborted);
  return is_aborted;
}

static ScrError *scr_stream_abort_error(ScrDyn *signal) {
  ScrDyn *reason = scr_stream_signal_prop(signal, "reason");
  ScrError *e = scr_error_abort(reason);
  if (reason) scr_dyn_release(reason);
  return e;
}

static void scr_stream_abort_now(ScrStream *s, ScrDyn *signal) {
  ScrError *e = scr_stream_abort_error(signal);
  scr_stream_release(scr_stream_destroy(s, e));
  scr_error_release(e);
}

/* onAbort: caps[0] the stream, caps[1] the signal. */
static ScrDyn *scr_stream_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrStream *s = scr_box_get_ref(clo->caps[0]); /* +1, NULL after exit teardown */
  ScrDyn *signal = scr_box_get_ref(clo->caps[1]); /* +1 */
  if (s) scr_stream_abort_now(s, signal);
  scr_dyn_release(signal);
  if (s) scr_stream_release(s);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* A pending abort hook: the listener closure (borrowed) holds the stream,
 * and the stream's watcher holds the listener through the disposable — a
 * cycle the stream's finish breaks. Hooks still pending at exit drop the
 * listener's stream so the stream can be freed. */
typedef struct ScrAbortHook {
  ScrClosure *listener; /* borrowed */
  struct ScrAbortHook *prev, *next;
} ScrAbortHook;

static SCR_TL ScrAbortHook *scr_abort_hooks = NULL;

static void scr_abort_hook_unlink(ScrAbortHook *h) {
  if (h->prev) h->prev->next = h->next;
  else if (scr_abort_hooks == h) scr_abort_hooks = h->next;
  if (h->next) h->next->prev = h->prev;
  free(h);
}

static void scr_abort_hooks_atexit(void) {
  while (scr_abort_hooks) {
    ScrAbortHook *h = scr_abort_hooks;
    scr_box_set_ref(h->listener->caps[0], NULL);
    scr_abort_hook_unlink(h);
  }
}

static void *scr_stream_ptr_keep_v(void *p) { return p; }
static void scr_stream_ptr_drop_v(void *p) { (void)p; }

/* The eos callback: the disposable (caps[0]) removes the abort listener;
 * caps[1] is the pending hook. */
static void scr_stream_abort_dispose_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  (void)err;
  ScrAbortHook *h = scr_box_get_ref(cb->caps[1]);
  if (h) {
    scr_box_set_ref(cb->caps[1], NULL);
    scr_abort_hook_unlink(h);
  }
  ScrDyn *dispose = scr_box_get_ref(cb->caps[0]); /* +1 */
  ScrDyn *r = scr_dyn_call(dispose, NULL, 0, "dispose");
  if (r) scr_dyn_release(r);
  scr_dyn_release(dispose);
}

static void *scr_stream_dyn_retain_v(void *p) { return p ? scr_dyn_retain(p) : NULL; }
static void scr_stream_dyn_release_v(void *p) { scr_dyn_release(p); }

/* addAbortSignal(signal, stream), or the `signal` option (from_option:
 * a falsy value is ignored, Node's `if (options.signal)`). Borrows both;
 * answers the stream +1, or NULL with ERR_INVALID_ARG_TYPE pending. */
ScrStream *scr_stream_add_abort_signal(ScrStream *s, ScrDyn *signal, bool from_option,
                                       ScrAbortAddFn add) {
  if (from_option && (signal == NULL || !scr_dyn_truthy(signal))) return scr_stream_retain(s);
  if (signal && signal->kind == SCR_DYN_NULL) {
    /* typeof null is 'object': the `in` test itself throws */
    static const char m[] = "Cannot use 'in' operator to search for 'aborted' in null";
    scr_throw_error_msg(SCR_ERR_TYPE, m, sizeof m - 1);
    return NULL;
  }
  ScrDyn *aborted = NULL;
  if (signal && (signal->kind == SCR_DYN_OBJ || signal->kind == SCR_DYN_HANDLE)) {
    aborted = scr_stream_signal_prop(signal, "aborted");
  }
  if (aborted == NULL) {
    scr_dyn_arg_type_fail("signal", "an instance of AbortSignal",
                          signal ? signal : scr_dyn_undefined());
    return NULL;
  }
  bool is_aborted = scr_dyn_truthy(aborted);
  scr_dyn_release(aborted);
  if (is_aborted) {
    scr_stream_abort_now(s, signal);
    return scr_stream_retain(s);
  }
  ScrClosure *clo = scr_closure_new((void *)&scr_stream_abort_thunk, 2);
  clo->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
  scr_box_set_ref(clo->caps[0], scr_stream_retain(s));
  clo->caps[1] = scr_box_new_obj(&scr_stream_dyn_retain_v, &scr_stream_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[1], scr_dyn_retain(signal));
  ScrDyn *listener = scr_dyn_new_func(clo, &scr_stream_abort_thunk, 0, "()", "onAbort");
  ScrDyn *dispose = add(signal, listener);
  scr_dyn_release(listener);
  if (dispose == NULL) return NULL;
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(scr_abort_hooks_atexit);
  }
  ScrAbortHook *h = calloc(1, sizeof *h);
  if (!h) scr_stream_oom();
  h->listener = clo;
  h->next = scr_abort_hooks;
  if (scr_abort_hooks) scr_abort_hooks->prev = h;
  scr_abort_hooks = h;
  ScrClosure *w = scr_closure_new((void *)&scr_stream_abort_dispose_inv, 2);
  w->caps[0] = scr_box_new_obj(&scr_stream_dyn_retain_v, &scr_stream_dyn_release_v, NULL);
  scr_box_set_ref(w->caps[0], dispose); /* moves */
  w->caps[1] = scr_box_new_obj(&scr_stream_ptr_keep_v, &scr_stream_ptr_drop_v, NULL);
  scr_box_set_ref(w->caps[1], h);
  scr_closure_release(scr_stream_finished(s, w, &scr_stream_abort_dispose_inv));
  return scr_stream_retain(s);
}

/* ── node:readline over stream inputs and outputs ─────────────────────
 * The Interface's stream side (scr_readline.c has the model): 'data',
 * 'end' and 'error' listeners on the input, registered in that order like
 * Node's constructor ('error' first there; it is never observable before
 * the others), removed again when the interface closes, and prompt
 * writes to the output. The input resumes at creation (input.resume()). */

typedef struct ScrRlHook {
  ScrStream *s; /* borrowed: the interface holds the stream */
  double id;
  ScrClosure *data, *end, *error; /* borrowed: the emitter owns them */
  struct ScrRlHook *next;
} ScrRlHook;

static SCR_TL ScrRlHook *scr_rl_hooks = NULL;

static double scr_stream_rl_id(ScrClosure *cb) { return scr_box_get_f64(cb->caps[0]); }

static void scr_stream_rl_data(ScrClosure *cb, void *b, void *str, void *value) {
  if (b == NULL && str == NULL && value != NULL) {
    scr_stream_value_consumer_fence("readline");
    return;
  }
  if (b != NULL) scr_rl_input_bytes(scr_stream_rl_id(cb), (ScrBytes *)b);
  else if (str != NULL) scr_rl_input_str(scr_stream_rl_id(cb), (ScrStr *)str);
}

static void scr_stream_rl_end(ScrClosure *cb) { scr_rl_input_end(scr_stream_rl_id(cb)); }

static void scr_stream_rl_error(ScrClosure *cb, void *err) {
  scr_rl_input_error(scr_stream_rl_id(cb), (ScrError *)err);
}

static ScrClosure *scr_stream_rl_listener(void *fn, double id) {
  ScrClosure *c = scr_closure_new(fn, 1);
  c->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(c->caps[0], id);
  return c;
}

static void scr_stream_rl_on(ScrStream *s, const char *name, ScrClosure *cb, ScrEeInvoke inv) {
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_emitter_release(scr_emitter_on((ScrEmitter *)s, n, cb, inv, false, false));
  scr_str_release(n);
}

static void scr_stream_rl_off(ScrStream *s, const char *name, ScrClosure *cb) {
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_emitter_release(scr_emitter_off((ScrEmitter *)s, n, cb));
  scr_str_release(n);
}

static void scr_stream_rl_pause(void *s) { scr_stream_release(scr_stream_pause(s)); }
static void scr_stream_rl_resume(void *s) { scr_stream_release(scr_stream_resume(s)); }
static void scr_stream_rl_write(void *s, ScrStr *text) { scr_stream_write_str(s, text, NULL); }
static void scr_stream_rl_write_cb(void *s, ScrStr *text, ScrClosure *cb) {
  scr_stream_write_str(s, text, cb);
}
static void scr_stream_rl_release(void *s) { scr_stream_release(s); }

static void scr_stream_rl_on_event(void *s, const char *name, ScrClosure *cb, int nargs) {
  ScrEeInvoke inv = nargs == 0 ? scr_ee_inv_fixed0 : nargs == 1 ? scr_ee_inv_fixed1 : scr_ee_inv_fixed2;
  scr_stream_rl_on(s, name, cb, inv);
}

static void scr_stream_rl_off_event(void *s, const char *name, ScrClosure *cb) {
  scr_stream_rl_off(s, name, cb);
}

static double scr_stream_rl_listener_count(void *s, const char *name) {
  ScrStr *n = scr_str_new(name, strlen(name));
  double c = scr_emitter_listener_count((ScrEmitter *)s, n);
  scr_str_release(n);
  return c;
}

static void scr_stream_rl_emit2(void *s, const char *name, void *a, void *b) {
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_emitter_emit((ScrEmitter *)s, n, a, b);
  scr_str_release(n);
}

static void *scr_stream_rl_retain(void *s) { return scr_stream_retain(s); }

static void scr_stream_rl_detach(void *s, double id) {
  for (ScrRlHook **at = &scr_rl_hooks; *at; at = &(*at)->next) {
    ScrRlHook *h = *at;
    if (h->s != s || h->id != id) continue;
    *at = h->next;
    if (h->data) scr_stream_rl_off(h->s, "data", h->data);
    scr_stream_rl_off(h->s, "error", h->error);
    scr_stream_rl_off(h->s, "end", h->end);
    free(h);
    return;
  }
}

/* a terminal interface reads keys, not 'data' */
static void scr_stream_rl_drop_data(void *s, double id) {
  for (ScrRlHook *h = scr_rl_hooks; h; h = h->next) {
    if (h->s != s || h->id != id || !h->data) continue;
    scr_stream_rl_off(h->s, "data", h->data);
    h->data = NULL;
    return;
  }
}

static const ScrRlIo scr_stream_rl_io = {
    &scr_stream_rl_pause,          &scr_stream_rl_resume,   &scr_stream_rl_detach,
    &scr_stream_rl_write,          &scr_stream_rl_write_cb, &scr_stream_rl_on_event,
    &scr_stream_rl_off_event,      &scr_stream_rl_listener_count,
    &scr_stream_rl_emit2,          &scr_stream_rl_retain,   &scr_stream_rl_drop_data,
    &scr_stream_rl_release,
};

/* readline.emitKeypressEvents(stream, interface) */
void scr_stream_rl_keypress_events(ScrStream *s, double iface, double timeout) {
  scr_rl_keypress_events(&scr_stream_rl_io, s, iface, timeout);
}

static void scr_stream_rl_hooks_free(void) {
  while (scr_rl_hooks) {
    ScrRlHook *h = scr_rl_hooks;
    scr_rl_hooks = h->next;
    free(h);
  }
}

/* createInterface's input or output given as a checked-dynamic value (a
 * JavaScript function's result, an object's member): the stream (+1).
 * An output of null or undefined is NULL (no output). A value that is
 * not a stream with a readable (input) or writable (output) side is
 * refused. */
ScrStream *scr_stream_rl_from_dyn(const ScrDyn *value, bool output) {
  if (output && (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF)) return NULL;
  if (value->kind == SCR_DYN_TYPED_REF && value->v.typed_ref.type_key_len > 7 &&
      !memcmp(value->v.typed_ref.type_key, "object:", 7)) {
    ScrStream *stream = scr_dyn_typed_ref_unbox(value);
    const ScrVt *vt = scr_stream_vt_of(stream);
    if (vt) {
      bool duplex = vt == &scr_duplex_vt || vt == &scr_transform_vt || vt == &scr_passthrough_vt ||
                    scr_vt_within(vt, &scr_duplex_vt);
      bool ok = duplex || (output ? vt == &scr_writable_vt || scr_vt_within(vt, &scr_writable_vt)
                                  : vt == &scr_readable_vt || scr_vt_within(vt, &scr_readable_vt));
      if (ok) return stream;
    }
    value->v.typed_ref.release(stream);
  }
  static const char in_m[] = "createInterface with an input that is not a readable stream has no lowering";
  static const char out_m[] = "createInterface with an output that is not a writable stream has no lowering";
  if (output) scr_throw_error_msg_code(SCR_ERR_ERROR, out_m, sizeof out_m - 1, "SC2020");
  else scr_throw_error_msg_code(SCR_ERR_ERROR, in_m, sizeof in_m - 1, "SC2020");
  return NULL;
}

double scr_stream_rl_open(ScrStream *in, ScrStream *out, bool out_stdout, double crlf_delay,
                          ScrStr *prompt, ScrDyn *signal, ScrAbortAddFn add) {
  double id = scr_rl_open(&scr_stream_rl_io, in ? scr_stream_retain(in) : NULL,
                          out ? scr_stream_retain(out) : NULL, out_stdout, crlf_delay, prompt,
                          signal, add);
  if (in == NULL) return id;
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(scr_stream_rl_hooks_free);
  }
  ScrRlHook *h = calloc(1, sizeof *h);
  if (!h) scr_stream_oom();
  h->s = in;
  h->id = id;
  h->error = scr_stream_rl_listener((void *)&scr_stream_rl_error, id);
  h->data = scr_stream_rl_listener((void *)&scr_stream_rl_data, id);
  h->end = scr_stream_rl_listener((void *)&scr_stream_rl_end, id);
  h->next = scr_rl_hooks;
  scr_rl_hooks = h;
  scr_stream_rl_on(in, "error", h->error, scr_ee_inv_fixed1);
  scr_stream_rl_on(in, "data", h->data, scr_ee_inv_fixed3);
  scr_stream_rl_on(in, "end", h->end, scr_ee_inv_fixed0);
  scr_stream_rl_resume(in);
  return id;
}

static int scr_eos_is_writable(const ScrStreamState *st);

/* new Readline(stream, options): isWritable(stream), else
 * ERR_INVALID_ARG_TYPE('stream', 'Writable', stream) */
double scr_stream_rl_ui_open(ScrStream *out, bool auto_commit) {
  if (scr_eos_is_writable(out->st) != 1) {
    char m[160];
    int n = snprintf(m, sizeof m,
                     "The \"stream\" argument must be an instance of Writable. Received an "
                     "instance of %s",
                     out->cls ? out->cls : "Stream");
    scr_throw_error_msg_code(SCR_ERR_TYPE, m, (size_t)n, "ERR_INVALID_ARG_TYPE");
    return 0;
  }
  return scr_rl_ui_open(&scr_stream_rl_io, scr_stream_retain(out), 0, auto_commit);
}

/* ── finished(stream, options) (lib/internal/streams/end-of-stream.js) ──
 * The options form registers Node's own listeners on the stream — 'end',
 * 'finish', 'error' (unless options.error is false) and 'close', in that
 * order — and decides with Node's predicates over the stream state:
 * options.readable/writable (default: whether the stream has that side)
 * choose which ends count, and willEmitClose (autoDestroy, emitClose,
 * not yet closed, and both sides counted) defers the callback to 'close'.
 * options.signal: an abort removes the listeners and calls back with
 * new AbortError(undefined, { cause: signal.reason }). The callback runs
 * once; the answered cleanup closure removes the listeners. */

typedef struct ScrEos {
  size_t rc;
  /* Borrowed: the stream's listeners hold the context, so the context
   * must not hold the stream; every closure that can run after the
   * listeners are gone (ticks, the abort listener, cleanup) holds the
   * stream itself. */
  ScrStream *s;
  bool pending;   /* the callback has not run */
  ScrClosure *cb; /* owned until it runs or cleanup drops it (callback form) */
  ScrStreamErrInv inv;
  bool readable, writable;
  bool will_emit_close;
  bool readable_finished, writable_finished;
  bool on_error;
  ScrClosure *l_end, *l_finish, *l_error, *l_close; /* emitter-owned */
  ScrDyn *dispose; /* the signal listener's disposable (+1) */
  ScrDyn *signal;  /* +1 */
  ScrPromise *promise; /* the promise form (+1) */
  bool auto_cleanup;
  ScrError *immediate; /* +1: the immediate result (Node 24), or NULL */
  struct ScrEos *live_prev, *live_next; /* pending contexts, released at exit */
} ScrEos;

static SCR_TL ScrEos *scr_eos_live = NULL;

static void scr_eos_unlink(ScrEos *e) {
  if (e->live_prev) e->live_prev->live_next = e->live_next;
  else if (scr_eos_live == e) scr_eos_live = e->live_next;
  if (e->live_next) e->live_next->live_prev = e->live_prev;
  e->live_prev = e->live_next = NULL;
}

/* The callback and promise a context still holds: dropped once it
 * settles, is cleaned up, or the program exits. */
static void scr_eos_drop(ScrEos *e) {
  e->pending = false;
  scr_eos_unlink(e);
  if (e->cb) {
    scr_closure_release(e->cb);
    e->cb = NULL;
  }
  if (e->promise) {
    scr_promise_release(e->promise);
    e->promise = NULL;
  }
}

static void *scr_eos_retain_v(void *p);
static void scr_eos_release_v(void *p);

/* At exit the disposable goes too: it holds the abort listener, which
 * holds this context. */
static void scr_eos_atexit(void) {
  while (scr_eos_live) {
    ScrEos *e = scr_eos_retain_v(scr_eos_live);
    ScrDyn *d = e->dispose;
    e->dispose = NULL;
    scr_eos_drop(e);
    if (d) scr_dyn_release(d);
    scr_eos_release_v(e);
  }
}

static void *scr_eos_retain_v(void *p) {
  ((ScrEos *)p)->rc++;
  return p;
}

static void scr_eos_release_v(void *p) {
  ScrEos *e = p;
  if (--e->rc > 0) return;
  if (e->cb) scr_closure_release(e->cb);
  if (e->dispose) scr_dyn_release(e->dispose);
  if (e->signal) scr_dyn_release(e->signal);
  if (e->promise) scr_promise_release(e->promise);
  if (e->immediate) scr_error_release(e->immediate);
  scr_eos_unlink(e);
  free(e);
}

/* A closure over the context; `keep` also holds the stream. */
static ScrClosure *scr_eos_closure_k(void *fn, ScrEos *e, bool keep) {
  ScrClosure *c = scr_closure_new(fn, keep ? 2 : 1);
  c->caps[0] = scr_box_new_obj(&scr_eos_retain_v, &scr_eos_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_eos_retain_v(e));
  if (keep) {
    c->caps[1] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
    scr_box_set_ref(c->caps[1], scr_stream_retain(e->s));
  }
  return c;
}

static ScrClosure *scr_eos_closure(void *fn, ScrEos *e) { return scr_eos_closure_k(fn, e, false); }

static ScrEos *scr_eos_of(ScrClosure *c) { return scr_box_get_ref(c->caps[0]); /* +1 */ }

/* Node's predicates (internal/streams/utils.js) over the state. */
static bool scr_eos_closed(const ScrStreamState *st) { return st->close_scheduled || st->close_emitted; }
static bool scr_eos_readable_prop(const ScrStreamState *st) {
  return st->has_r && !st->destroyed && !st->error_emitted && !st->r.end_emitted;
}
static bool scr_eos_writable_prop(const ScrStreamState *st) {
  return st->has_w && !st->destroyed && !st->errored && !st->w.ending;
}
static bool scr_eos_readable_finished(const ScrStreamState *st, bool strict) {
  if (!st->has_r || st->errored) return false;
  return st->r.end_emitted || (!strict && st->r.ended && st->r.length == 0);
}
static bool scr_eos_writable_finished(const ScrStreamState *st, bool strict) {
  if (!st->has_w) return false;
  if (st->w.finished) return true;
  if (st->errored) return false;
  return !strict && st->w.ending && st->w.length == 0;
}
/* isReadable/isWritable: -1 for null (no such property), else 0/1. */
static int scr_eos_is_readable(const ScrStreamState *st) {
  if (!st->has_r) return -1;
  if (st->destroyed) return 0;
  return scr_eos_readable_prop(st) && !st->r.end_emitted;
}
static int scr_eos_is_writable(const ScrStreamState *st) {
  if (!st->has_w) return -1;
  if (st->destroyed) return 0;
  return scr_eos_writable_prop(st) && !st->w.ending;
}

static void scr_eos_unlisten(ScrEos *e) {
  ScrStream *s = e->s;
  if (e->l_end) scr_stream_rl_off(s, "end", e->l_end);
  if (e->l_finish) scr_stream_rl_off(s, "finish", e->l_finish);
  if (e->l_error) scr_stream_rl_off(s, "error", e->l_error);
  if (e->l_close) scr_stream_rl_off(s, "close", e->l_close);
  e->l_end = e->l_finish = e->l_error = e->l_close = NULL;
}

static void scr_eos_dispose_signal(ScrEos *e) {
  if (!e->dispose) return;
  ScrDyn *d = e->dispose;
  e->dispose = NULL;
  ScrDyn *r = scr_dyn_call(d, NULL, 0, "dispose");
  if (r) scr_dyn_release(r);
  scr_dyn_release(d);
}

static void scr_eos_settle(ScrEos *e, ScrError *err);

/* callback.call(stream, err): once; borrows err. */
static void scr_eos_fire(ScrEos *e, ScrError *err) {
  if (!e->pending) return;
  scr_eos_dispose_signal(e);
  scr_eos_settle(e, err);
}

/* Runs the callback (or settles the promise) and drops them. */
static void scr_eos_settle(ScrEos *e, ScrError *err) {
  scr_eos_retain_v(e);
  ScrClosure *cb = e->cb;
  ScrPromise *p = e->promise;
  e->cb = NULL;
  e->promise = NULL;
  e->pending = false;
  scr_eos_unlink(e);
  if (p) {
    if (e->auto_cleanup) scr_eos_unlisten(e);
    if (err != NULL) {
      scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                    scr_error_trace_arg());
      scr_promise_reject_pending(p);
    } else {
      scr_promise_fulfill_void(p);
    }
    scr_promise_release(p);
  } else if (cb) {
    e->inv(cb, e->s, err);
    scr_closure_release(cb);
  }
  scr_eos_release_v(e);
}

static void scr_eos_onfinish(ScrClosure *c) {
  ScrEos *e = scr_eos_of(c);
  ScrStreamState *st = e->s->st;
  e->writable_finished = true;
  if (st->destroyed) e->will_emit_close = false;
  if (!(e->will_emit_close && (!scr_eos_readable_prop(st) || e->readable))) {
    if (!e->readable || e->readable_finished) scr_eos_fire(e, NULL);
  }
  scr_eos_release_v(e);
}

static void scr_eos_onend(ScrClosure *c) {
  ScrEos *e = scr_eos_of(c);
  ScrStreamState *st = e->s->st;
  e->readable_finished = true;
  if (st->destroyed) e->will_emit_close = false;
  if (!(e->will_emit_close && (!scr_eos_writable_prop(st) || e->writable))) {
    if (!e->writable || e->writable_finished) scr_eos_fire(e, NULL);
  }
  scr_eos_release_v(e);
}

static void scr_eos_onerror(ScrClosure *c, void *err) {
  ScrEos *e = scr_eos_of(c);
  scr_eos_fire(e, (ScrError *)err);
  scr_eos_release_v(e);
}

/* getEosOnCloseError: the stream's error, ERR_STREAM_PREMATURE_CLOSE for a
 * side that closed unfinished, or NULL. +1. */
static ScrError *scr_eos_close_error(ScrEos *e) {
  ScrStreamState *st = e->s->st;
  if (st->errored) return scr_error_retain(st->errored);
  if ((e->readable && !e->readable_finished && st->has_r && !scr_eos_readable_finished(st, false)) ||
      (e->writable && !e->writable_finished && !scr_eos_writable_finished(st, false))) {
    return scr_stream_mkerr("ERR_STREAM_PREMATURE_CLOSE", "Premature close");
  }
  return NULL;
}

static void scr_eos_onclose(ScrClosure *c) {
  ScrEos *e = scr_eos_of(c);
  ScrError *err = scr_eos_close_error(e);
  scr_eos_fire(e, err);
  if (err) scr_error_release(err);
  scr_eos_release_v(e);
}

static void scr_eos_immediate_tick(ScrClosure *c) {
  ScrEos *e = scr_eos_of(c);
  scr_eos_fire(e, e->immediate);
  scr_eos_release_v(e);
}

static void scr_eos_noop_error(ScrClosure *c, void *err) {
  (void)c;
  (void)err;
}

static void scr_eos_onclosed(ScrClosure *c) {
  ScrEos *e = scr_eos_of(c);
  ScrStreamState *st = e->s->st;
  scr_eos_fire(e, st->errored);
  scr_eos_release_v(e);
}

/* abort: the listeners go (cleanup keeps the callback for this call),
 * then the callback runs with the AbortError. */
static void scr_eos_abort(ScrEos *e) {
  if (!e->pending) return;
  scr_eos_unlisten(e);
  scr_eos_dispose_signal(e);
  ScrError *err = scr_stream_abort_error(e->signal);
  scr_eos_settle(e, err);
  scr_error_release(err);
}

static ScrDyn *scr_eos_abort_thunk(ScrClosure *c, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEos *e = scr_eos_of(c);
  scr_eos_abort(e);
  scr_eos_release_v(e);
  return scr_dyn_retain(scr_dyn_undefined());
}

static void scr_eos_cleanup_fn(ScrClosure *c) {
  ScrEos *e = scr_eos_of(c);
  scr_eos_unlisten(e);
  scr_eos_dispose_signal(e);
  if (e->pending) scr_eos_drop(e);
  scr_eos_release_v(e);
}

/* readable/writable: -1 for the default; on_error: options.error !==
 * false; signal: NULL when absent (borrowed). cb moves. Answers the +1
 * cleanup closure, or NULL with ERR_INVALID_ARG_TYPE pending for a signal
 * that is not an AbortSignal. */
static ScrClosure *scr_stream_eos_impl(ScrStream *s, ScrClosure *cb, ScrStreamErrInv inv,
                                       ScrPromise *p, bool auto_cleanup, int readable,
                                       int writable, bool on_error, ScrDyn *signal,
                                       ScrAbortAddFn add) {
  ScrStreamState *st = s->st;
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(scr_eos_atexit);
  }
  if (signal && !scr_dyn_is_nullish(signal)) {
    ScrDyn *aborted = NULL;
    if (signal->kind == SCR_DYN_OBJ || signal->kind == SCR_DYN_HANDLE) {
      aborted = scr_stream_signal_prop(signal, "aborted");
    }
    if (!aborted) {
      if (cb) scr_closure_release(cb);
      scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
      return NULL;
    }
    scr_dyn_release(aborted);
  } else {
    signal = NULL;
  }
  ScrEos *e = calloc(1, sizeof *e);
  if (!e) scr_stream_oom();
  e->rc = 1;
  e->s = s;
  e->pending = true;
  e->cb = cb;
  e->inv = inv;
  e->promise = p ? scr_promise_retain(p) : NULL;
  e->auto_cleanup = auto_cleanup;
  e->live_next = scr_eos_live;
  if (scr_eos_live) scr_eos_live->live_prev = e;
  scr_eos_live = e;
  e->readable = readable < 0 ? st->has_r : readable != 0;
  e->writable = writable < 0 ? st->has_w : writable != 0;
  e->on_error = on_error;
  e->will_emit_close = st->auto_destroy && st->emit_close && !scr_eos_closed(st) &&
                       st->has_r == e->readable && st->has_w == e->writable;
  e->writable_finished = scr_eos_writable_finished(st, false);
  e->readable_finished = scr_eos_readable_finished(st, false);
  /* Node 24's immediate result: a stream that already settled what eos()
   * waits for answers on a nextTick with the result as of now, with no
   * end/finish/close listeners (only a no-op 'error' listener, unless
   * options.error is false). An already aborted signal answers the same
   * way with its AbortError. */
  bool immediate = true;
  ScrError *result = NULL;
  if (scr_eos_closed(st)) {
    result = scr_eos_close_error(e);
  } else if (st->error_emitted) {
    if (e->will_emit_close) immediate = false;
    else if (st->errored) result = scr_error_retain(st->errored);
  } else if ((!e->readable && (!e->will_emit_close || scr_eos_is_readable(st) == 1) &&
              (e->writable_finished || scr_eos_is_writable(st) == 0) &&
              (!st->has_w || (!st->w.writing && st->w.head == st->w.n))) ||
             (!e->writable && (!e->will_emit_close || scr_eos_is_writable(st) == 1) &&
              (e->readable_finished || scr_eos_is_readable(st) == 0))) {
    if (st->errored) result = scr_error_retain(st->errored);
  } else {
    immediate = false;
  }
  if (immediate) {
    if (on_error) {
      e->l_error = scr_eos_closure((void *)&scr_eos_noop_error, e);
      scr_stream_rl_on(s, "error", e->l_error, scr_ee_inv_fixed1);
    }
  } else if (signal && scr_stream_signal_aborted(signal)) {
    immediate = true;
    result = scr_stream_abort_error(signal);
  }
  if (immediate) {
    e->immediate = result; /* moves */
    scr_next_tick(scr_eos_closure_k((void *)&scr_eos_immediate_tick, e, true));
  } else {
    e->l_end = scr_eos_closure((void *)&scr_eos_onend, e);
    e->l_finish = scr_eos_closure((void *)&scr_eos_onfinish, e);
    e->l_close = scr_eos_closure((void *)&scr_eos_onclose, e);
    scr_stream_rl_on(s, "end", e->l_end, scr_ee_inv_fixed0);
    scr_stream_rl_on(s, "finish", e->l_finish, scr_ee_inv_fixed0);
    if (on_error) {
      e->l_error = scr_eos_closure((void *)&scr_eos_onerror, e);
      scr_stream_rl_on(s, "error", e->l_error, scr_ee_inv_fixed1);
    }
    scr_stream_rl_on(s, "close", e->l_close, scr_ee_inv_fixed0);
    if (signal) {
      e->signal = scr_dyn_retain(signal);
      ScrClosure *clo = scr_eos_closure_k((void *)&scr_eos_abort_thunk, e, true);
      ScrDyn *listener = scr_dyn_new_func(clo, &scr_eos_abort_thunk, 0, "()", "abort");
      e->dispose = add(signal, listener);
      scr_dyn_release(listener);
    }
  }
  ScrClosure *cleanup = scr_eos_closure_k((void *)&scr_eos_cleanup_fn, e, true);
  scr_eos_release_v(e);
  return cleanup;
}

ScrClosure *scr_stream_finished_opts(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamErrInv inv,
                                     double readable, double writable, bool on_error,
                                     ScrDyn *signal, ScrAbortAddFn add) {
  return scr_stream_eos_impl(s, cb, inv, NULL, false, (int)readable, (int)writable, on_error,
                             signal, add);
}

ScrClosure *scr_stream_finished_opts_dyn(ScrStream *s, ScrDyn *cb, double readable,
                                         double writable, bool on_error, ScrDyn *signal,
                                         ScrAbortAddFn add) {
  ScrClosure *c = scr_stream_dynopt_clo(cb, (void *)&scr_stream_finished_dyn_inv);
  return scr_stream_eos_impl(s, c, &scr_stream_finished_dyn_inv, NULL, false, (int)readable,
                             (int)writable, on_error, signal, add);
}

/* stream/promises finished(stream, options): cleanup removes the
 * listeners once the promise settles. */
ScrPromise *scr_sp_finished_opts(ScrStream *s, double readable, double writable, bool on_error,
                                 bool cleanup, ScrDyn *signal, ScrAbortAddFn add) {
  ScrPromise *p = scr_promise_new();
  ScrClosure *cleanup_fn = scr_stream_eos_impl(s, NULL, NULL, p, cleanup, (int)readable,
                                               (int)writable, on_error, signal, add);
  if (cleanup_fn == NULL) {
    scr_promise_reject_pending(p);
    return p;
  }
  scr_closure_release(cleanup_fn);
  return p;
}

/* ── node:console Console instances over writable streams ─────────────
 * Node's kWriteToConsole: with ignoreErrors (the default) one shared noop
 * 'error' listener brackets the write when the stream has none, and the
 * write's completion handler re-arms it for the write's own error before
 * that error is emitted (the handler's tick precedes the emit), so a
 * failing console stream never crashes the program; synchronous throws
 * out of the write are discarded. Without ignoreErrors it is a plain
 * write. */

static SCR_TL ScrClosure *scr_console_noop;

static void scr_console_noop_fn(ScrClosure *cb) { (void)cb; }

static void scr_console_noop_cleanup(void) {
  scr_closure_release(scr_console_noop);
  scr_console_noop = NULL;
}

static ScrClosure *scr_console_noop_get(void) {
  if (!scr_console_noop) {
    scr_console_noop = scr_closure_new((void *)&scr_console_noop_fn, 0);
    scr_atexit(scr_console_noop_cleanup);
  }
  return scr_console_noop;
}

/* createWriteErrorHandler: the write failed and its error is still to be
 * emitted with no listener to receive it — park the noop for it. */
static void scr_console_on_written(ScrClosure *cb) {
  ScrStream *s = scr_box_get_ref(cb->caps[0]); /* +1 */
  ScrStreamState *st = s->st;
  if (st->errored != NULL && !st->error_emitted) {
    ScrStr *name = scr_str_new("error", 5);
    if (scr_emitter_listener_count((ScrEmitter *)s, name) == 0) {
      scr_emitter_release(scr_emitter_on((ScrEmitter *)s, name,
                                         scr_closure_retain(scr_console_noop_get()),
                                         scr_ee_inv_fixed0, true, false));
    }
    scr_str_release(name);
  }
  scr_stream_release(s);
}

static void scr_console_stream_write(ScrConsoleInst *inst, int which, ScrStr *line) {
  ScrStream *s = inst->stream[which];
  if (!inst->ignore_errors) {
    scr_stream_write_str(s, line, NULL);
    return;
  }
  ScrStr *name = scr_str_new("error", 5);
  ScrClosure *noop = scr_console_noop_get();
  if (scr_emitter_listener_count((ScrEmitter *)s, name) == 0) {
    scr_emitter_release(scr_emitter_on((ScrEmitter *)s, name, scr_closure_retain(noop),
                                       scr_ee_inv_fixed0, true, false));
  }
  if (!scr_exc_pending()) scr_stream_write_str(s, line, scr_closure_retain(inst->on_written[which]));
  if (scr_exc_pending()) scr_exc_clear();
  scr_emitter_release(scr_emitter_off((ScrEmitter *)s, name, noop));
  if (scr_exc_pending()) scr_exc_clear();
  scr_str_release(name);
}

static void scr_console_stream_drop(ScrConsoleInst *inst) {
  for (int i = 0; i < 2; i++) {
    if (inst->stream[i]) scr_stream_release(inst->stream[i]);
    if (inst->on_written[i]) scr_closure_release(inst->on_written[i]);
    inst->stream[i] = NULL;
    inst->on_written[i] = NULL;
  }
}

void scr_console_bind(ScrDyn *console, double which, ScrStream *stream) {
  ScrConsoleInst *inst = console->v.handle.ptr;
  int i = which != 0 ? 1 : 0;
  if (inst->stream[i]) scr_stream_release(inst->stream[i]);
  if (inst->on_written[i]) scr_closure_release(inst->on_written[i]);
  inst->stream[i] = scr_stream_retain(stream);
  ScrClosure *cb = scr_closure_new((void *)&scr_console_on_written, 1);
  cb->caps[0] = scr_box_new_obj(scr_stream_retain_v, scr_stream_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_stream_retain(stream));
  inst->on_written[i] = cb;
  inst->stream_write = &scr_console_stream_write;
  inst->stream_drop = &scr_console_stream_drop;
}

/* ── object mode ──────────────────────────────────────────────────────── */

/* The objectMode option (both sides) or a Duplex's readableObjectMode and
 * writableObjectMode, applied right after construction: the readable
 * side's entries are whole values (each counts 1, and the first push picks
 * the representation), and the writable side queues values. The caller
 * passes the object-mode high-water marks (16 by default). */
void scr_stream_set_object_mode(ScrStream *s, bool readable, bool writable) {
  ScrStreamState *st = s->st;
  if (readable && st->has_r) {
    st->r.object_entries = true;
    st->r.object_mode_opt = true;
  }
  if (writable && st->has_w) st->w.object_mode = st->w.values = true;
}

/* decodeStrings: false — string writes stay strings (scr_stream_write_string). */
void scr_stream_set_decode_strings(ScrStream *s, bool decode) {
  ScrStreamState *st = s->st;
  if (decode || !st->has_w) return;
  st->w.decode_strings_off = true;
  st->w.values = true;
}

ScrStream *scr_stream_decode_strings(ScrStream *s, bool decode) {
  scr_stream_set_decode_strings(s, decode);
  return scr_stream_retain(s);
}

static void scr_stream_store_default_enc(ScrStreamState *st, ScrStr *enc /*moves*/) {
  if (st->w.default_enc) scr_str_release(st->w.default_enc);
  st->w.default_enc = NULL;
  if ((enc->len == 4 && memcmp(enc->data, "utf8", 4) == 0) ||
      (enc->len == 5 && memcmp(enc->data, "utf-8", 5) == 0)) {
    scr_str_release(enc); /* Node's kDefaultUTF8Encoding */
    return;
  }
  st->w.default_enc = enc;
}

/* The defaultEncoding option on the writable side, a known encoding as
 * given (borrowed; validated by the caller). */
void scr_stream_set_write_encoding(ScrStream *s, ScrStr *enc) {
  if (s->st->has_w) scr_stream_store_default_enc(s->st, scr_str_retain(enc));
}

ScrStream *scr_stream_write_encoding(ScrStream *s, ScrStr *enc) {
  scr_stream_set_write_encoding(s, enc);
  return scr_stream_retain(s);
}

/* setDefaultEncoding(encoding): the name lowercased, a known encoding or
 * ERR_UNKNOWN_ENCODING (thrown); answers the stream (+1). */
ScrStream *scr_stream_set_default_encoding(ScrStream *s, ScrDyn *enc) {
  ScrStr *raw = enc->kind == SCR_DYN_STR ? scr_str_retain(enc->v.str) : scr_dyn_string_coerce_js(enc);
  ScrStr *lower = raw;
  if (enc->kind == SCR_DYN_STR) {
    char *buf = malloc(raw->len ? raw->len : 1);
    if (!buf) scr_stream_oom();
    for (size_t i = 0; i < raw->len; i++) {
      char c = raw->data[i];
      buf[i] = c >= 'A' && c <= 'Z' ? (char)(c - 'A' + 'a') : c;
    }
    lower = scr_str_new(buf, raw->len);
    free(buf);
    scr_str_release(raw);
  }
  ScrStr *canonical = scr_bytes_normalize_encoding(lower);
  if (canonical == NULL) {
    scr_str_release(lower);
    return scr_stream_retain(s);
  }
  scr_str_release(canonical);
  if (s->st->has_w) scr_stream_store_default_enc(s->st, lower);
  else scr_str_release(lower);
  return scr_stream_retain(s);
}

/* Whether a defaultEncoding option value is the default: null, undefined,
 * 'utf8' or 'utf-8' (the state constructors' kDefaultUTF8Encoding). */
static bool scr_stream_default_encoding_value(const ScrDyn *v) {
  if (!v || v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) return true;
  return v->kind == SCR_DYN_STR && ((v->v.str->len == 4 && memcmp(v->v.str->data, "utf8", 4) == 0) ||
                                    (v->v.str->len == 5 && memcmp(v->v.str->data, "utf-8", 5) == 0));
}

/* A runtime defaultEncoding option value, checked before construction as
 * the state constructors check it: the default, a name Buffer.isEncoding
 * knows, or ERR_UNKNOWN_ENCODING (thrown). Borrows v. */
void scr_stream_check_encoding_option(ScrDyn *v) {
  if (scr_stream_default_encoding_value(v)) return;
  if (v->kind == SCR_DYN_STR) {
    ScrStr *canonical = scr_bytes_normalize_encoding(v->v.str);
    if (canonical) scr_str_release(canonical);
    return;
  }
  ScrStr *shown = scr_dyn_string_coerce_js(v);
  if (!shown) return;
  char msg[128];
  int len = snprintf(msg, sizeof msg, "Unknown encoding: %.*s", (int)(shown->len < 64 ? shown->len : 64),
                     shown->data);
  scr_str_release(shown);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)(len < 0 ? 0 : len), "ERR_UNKNOWN_ENCODING");
}

/* Runtime decodeStrings and defaultEncoding option values over a fresh
 * stream (after its objectMode): decodeStrings === false keeps string
 * writes, and a known defaultEncoding is the write side's default as
 * given and how a byte-mode readable side decodes push(string). Borrows
 * both; answers the receiver (+1). */
ScrStream *scr_stream_option_values(ScrStream *s, ScrDyn *decode_strings, ScrDyn *default_encoding) {
  ScrStreamState *st = s->st;
  if (st->has_w && decode_strings && decode_strings->kind == SCR_DYN_BOOL && !decode_strings->v.b)
    scr_stream_set_decode_strings(s, false);
  if (!scr_stream_default_encoding_value(default_encoding) && default_encoding->kind == SCR_DYN_STR) {
    ScrStr *canonical = scr_bytes_normalize_encoding(default_encoding->v.str);
    if (canonical) {
      scr_stream_set_write_encoding(s, default_encoding->v.str);
      if (st->has_r && !st->r.object_entries) scr_stream_release(scr_stream_set_push_encoding(s, canonical));
      scr_str_release(canonical);
    } else if (scr_exc_pending()) {
      scr_exc_clear(); /* checked before construction */
    }
  }
  return scr_stream_retain(s);
}

/* stream.objectMode: scr_stream_set_object_mode, answering the receiver
 * (+1). */
ScrStream *scr_stream_object_mode(ScrStream *s, bool readable, bool writable) {
  scr_stream_set_object_mode(s, readable, writable);
  return scr_stream_retain(s);
}

/* Whether the write and transform steps receive dyn values (an
 * object-mode writable side): the compiler's chunk thunks read the chunk
 * by this. */
bool scr_stream_writes_values(ScrStream *s) {
  return s->st->has_w && s->st->w.values;
}

/* emit('data', value) with a checked-dynamic chunk: the 'data' slots by
 * the value's tag (scr_stream_emit_data's ABI). Borrows its arguments. */
bool scr_stream_emit_value(ScrStream *s, ScrStr *name, ScrDyn *v) {
  ScrBytes *b = v->kind == SCR_DYN_BYTES ? v->v.bytes : NULL;
  ScrStr *str = v->kind == SCR_DYN_STR ? v->v.str : NULL;
  return scr_emitter_emit((ScrEmitter *)s, name, b, str, v);
}

/* The chunk a compiled write or transform callback receives, by its
 * declared type: as a Buffer (+1; on an object-mode side the value must
 * be a Buffer, else a TypeError is thrown and NULL answered), as a dyn
 * value (+1), and the encoding argument: 'buffer' on a byte-mode side,
 * else what the write passed (undefined, null or a name). A parameter
 * typed string receives the name, or "" for undefined and null; one typed
 * otherwise receives the value (+1 each). */
ScrBytes *scr_stream_chunk_bytes(ScrStream *s, ScrBytes *chunk) {
  if (!scr_stream_writes_values(s)) return scr_bytes_retain(chunk);
  ScrDyn *v = (ScrDyn *)chunk;
  if (v->kind == SCR_DYN_BYTES) return scr_bytes_raw_view(v->v.bytes);
  static const char msg[] =
      "a stream callback declaring a Buffer chunk received an object-mode value that is not a Buffer";
  scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
  return NULL;
}

ScrDyn *scr_stream_chunk_value(ScrStream *s, ScrBytes *chunk) {
  if (scr_stream_writes_values(s)) return scr_dyn_retain((ScrDyn *)chunk);
  return scr_dyn_new_buffer(chunk);
}

ScrStr *scr_stream_chunk_encoding(ScrStream *s) {
  if (!scr_stream_writes_values(s)) return scr_str_new("buffer", 6);
  ScrDyn *enc = s->st->w.cur_enc;
  if (enc && enc->kind == SCR_DYN_STR) return scr_str_retain(enc->v.str);
  if (enc == NULL || enc->kind == SCR_DYN_NULL) return scr_str_new("", 0);
  return scr_dyn_string_coerce_js(enc);
}

ScrDyn *scr_stream_chunk_encoding_value(ScrStream *s) {
  if (!scr_stream_writes_values(s)) {
    ScrStr *name = scr_str_new("buffer", 6);
    ScrDyn *d = scr_dyn_new_str(name);
    scr_str_release(name);
    return d;
  }
  ScrDyn *enc = s->st->w.cur_enc;
  return enc ? scr_dyn_retain(enc) : scr_dyn_undefined();
}

bool scr_stream_chunk_encoding_undefined(ScrStream *s) {
  return scr_stream_writes_values(s) && s->st->w.cur_enc == NULL;
}

/* ── the readable surface ─────────────────────────────────────────────── */

bool scr_stream_push(ScrStream *s, ScrBytes *chunk) {
  return scr_stream_add_chunk(s, chunk, false);
}

/* readable.push(chunk) from a program: in byte mode another
 * ArrayBufferView becomes a Buffer over the same bytes
 * (Stream._uint8ArrayToBuffer); the runtime's own producers push Buffers
 * through scr_stream_push. */
bool scr_stream_push_view(ScrStream *s, ScrBytes *chunk) {
  if (chunk && !chunk->is_buffer && !(s->st->has_r && s->st->r.object_entries)) {
    ScrBytes *b = scr_bytes_buffer_view(chunk, SCR_BYTES_U8, scr_bytes_byte_offset(chunk), true,
                                        scr_bytes_byte_len(chunk));
    if (!b) return false;
    b->is_buffer = true;
    bool r = scr_stream_add_chunk(s, b, false);
    scr_bytes_release(b);
    return r;
  }
  return scr_stream_add_chunk(s, chunk, false);
}

bool scr_stream_push_str(ScrStream *s, ScrStr *str) {
  /* object mode: the string is one whole entry, not converted */
  if (s->st->has_r && s->st->r.object_entries)
    return scr_stream_add_entry(s, scr_str_retain(str), SCR_ENTRY_STR) > 0;
  ScrStr *enc = s->st->has_r ? s->st->r.push_enc : NULL;
  ScrBytes *b;
  if (enc != NULL) {
    /* Node: Buffer.from(chunk, state.defaultEncoding). */
    b = scr_bytes_from_str(str, enc);
  } else {
    b = scr_bytes_new(SCR_BYTES_U8, (double)str->len);
    memcpy(b->data, str->data, str->len);
    if (!str->ascii) scr_wtf8_to_utf8((char *)b->data, str->len);
  }
  scr_stream_buffer(b);
  bool ret = scr_stream_add_chunk(s, b, false);
  scr_bytes_release(b);
  return ret;
}

/* push(chunk, encoding) with an explicit non-utf8 literal: the per-call
 * encoding overrides the stream's default. Borrows both strings. */
bool scr_stream_push_str_enc(ScrStream *s, ScrStr *str, ScrStr *enc) {
  /* object mode: the string is the chunk and the encoding is not used */
  if (s->st->has_r && s->st->r.object_entries) return scr_stream_push_str(s, str);
  ScrBytes *b = scr_stream_buffer(scr_bytes_from_str(str, enc));
  bool ret = scr_stream_add_chunk(s, b, false);
  scr_bytes_release(b);
  return ret;
}

/* The defaultEncoding option's push side (canonical literal, frontend-
 * folded; never "utf8" — that stays the NULL fast path). Answers the
 * receiver +1, the setEncoding chaining shape. */
ScrStream *scr_stream_set_push_encoding(ScrStream *s, ScrStr *enc) {
  ScrStreamState *st = s->st;
  if (st->has_r) {
    if (st->r.push_enc) scr_str_release(st->r.push_enc);
    st->r.push_enc = scr_str_retain(enc);
  }
  return scr_stream_retain(s);
}

bool scr_stream_push_null(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (!st->has_r || st->destroyed) return false;
  st->r.reading = false;
  if (!st->r.ended) {
    /* onEofChunk flushes the decoder's held partial first (utf8's
     * replacement chars et al — Node's decoder.end() push). */
    if (st->r.encoded && !st->r.dyn_entries) {
      ScrStr *tail = scr_strdec_end(st->r.enc, st->r.dec_pending);
      st->r.dec_pending = 0;
      if (scr_str_utf16_len(tail) > 0) {
        scr_stream_rbuf_push(st, tail, SCR_ENTRY_STR, false);
        if (st->r.need_readable) scr_stream_emit_readable_nt(s);
      } else {
        scr_str_release(tail);
      }
    }
    st->r.ended = true;
    /* onEofChunk: inside a _read call (or before the first attempt) the
     * 'readable' pass defers to a tick; outside one it runs NOW — a
     * flowing stream delivers its buffered chunks synchronously here.
     * Inside _read, read() ends an empty stream when _read returns;
     * before the first attempt the end waits for the next read. */
    if (st->r.in_read_sync) {
      scr_stream_emit_readable_nt(s);
      if (st->r.length == 0 && st->r.in_read_call) scr_stream_end_readable(s);
    } else {
      st->r.need_readable = false;
      st->r.emitted_readable = true;
      scr_stream_emit_readable_now(s);
    }
    if (!scr_exc_pending()) scr_stream_settle_next(s);
  }
  return false;
}

void scr_stream_unshift(ScrStream *s, ScrBytes *chunk) {
  ScrStreamState *st = s->st;
  if (st->r.head_off > 0) {
    /* materialize the part-read head so the front slot is whole */
    void *rest = scr_stream_rbuf_take(st, scr_stream_entry_len(st, st->r.buf[0]) - st->r.head_off);
    scr_stream_rbuf_push(st, rest, scr_stream_rkind(st), true);
  }
  scr_stream_add_chunk(s, chunk, true);
}

void scr_stream_unshift_str(ScrStream *s, ScrStr *str) {
  if (s->st->has_r && s->st->r.object_entries) {
    /* object mode: the string itself goes to the front */
    ScrDyn *v = scr_dyn_new_str(str);
    scr_stream_unshift_dyn(s, v);
    scr_dyn_release(v);
    return;
  }
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)str->len);
  memcpy(b->data, str->data, str->len);
  if (!str->ascii) scr_wtf8_to_utf8((char *)b->data, str->len);
  scr_stream_buffer(b);
  scr_stream_unshift(s, b);
  scr_bytes_release(b);
}

/* unshift(value): null is the end of the stream (Node's onEofChunk); an
 * object-mode stream takes any other value as one entry at the front; a
 * byte-mode stream takes Buffers and strings, ignores undefined and
 * reports another value as push does. Borrows d. */
void scr_stream_unshift_dyn(ScrStream *s, const ScrDyn *d) {
  ScrStreamState *st = s->st;
  if (d->kind == SCR_DYN_NULL) {
    scr_stream_push_null(s);
    return;
  }
  if (st->has_r && st->r.object_entries) {
    void *entry;
    ScrEntryKind kind;
    if (d->kind == SCR_DYN_STR) {
      entry = scr_str_retain(d->v.str);
      kind = SCR_ENTRY_STR;
    } else if (d->kind == SCR_DYN_BYTES) {
      entry = scr_bytes_raw_view(d->v.bytes);
      kind = SCR_ENTRY_BYTES;
    } else {
      entry = scr_dyn_retain((ScrDyn *)d);
      kind = SCR_ENTRY_DYN;
    }
    entry = scr_stream_entry_convert(st, entry, &kind);
    scr_stream_rbuf_push(st, entry, kind, true);
    if (st->r.need_readable) scr_stream_emit_readable_nt(s);
    scr_stream_settle_next(s);
    return;
  }
  if (d->kind == SCR_DYN_BYTES) {
    ScrBytes *b = scr_bytes_raw_view(d->v.bytes);
    scr_stream_unshift(s, b);
    scr_bytes_release(b);
  } else if (d->kind == SCR_DYN_STR) {
    scr_stream_unshift_str(s, d->v.str);
  } else {
    scr_stream_push_dyn(s, d);
  }
}

static void scr_stream_listener_error(ScrClosure *adapter, ScrError *error) {
  ScrDyn *fn = scr_dyn_listener_fn(adapter);
  ScrDyn *arg = scr_dyn_from_error(error);
  ScrDyn *answer = scr_dyn_call(fn, &arg, 1, "listener");
  scr_dyn_release(answer);
  scr_dyn_release(arg);
  scr_dyn_release(fn);
}

static void scr_stream_listener_data(ScrClosure *adapter, ScrBytes *bytes, ScrStr *string, ScrDyn *value) {
  ScrDyn *fn = scr_dyn_listener_fn(adapter);
  ScrDyn *arg = value ? scr_dyn_retain(value) : string ? scr_dyn_new_str(string) : scr_dyn_new_bytes(bytes);
  ScrDyn *answer = scr_dyn_call(fn, &arg, 1, "listener");
  scr_dyn_release(answer);
  scr_dyn_release(arg);
  scr_dyn_release(fn);
}

ScrStream *scr_stream_on_dyn(ScrStream *s, ScrStr *name, ScrDyn *cb, bool once, bool prepend) {
  if (name->len == 4 && !memcmp(name->data, "data", 4)) {
    return (ScrStream *)scr_emitter_on_dyn((ScrEmitter *)s, name, cb,
      scr_dyn_listener_closure_fn(cb, (void *)scr_stream_listener_data),
      scr_ee_inv_fixed3, once, prepend);
  }
  bool error = name->len == 5 && memcmp(name->data, "error", 5) == 0;
  bool empty = (name->len == 8 && memcmp(name->data, "readable", 8) == 0) ||
    (name->len == 3 && memcmp(name->data, "end", 3) == 0) ||
    (name->len == 5 && memcmp(name->data, "close", 5) == 0) ||
    (name->len == 6 && memcmp(name->data, "finish", 6) == 0) ||
    (name->len == 5 && memcmp(name->data, "drain", 5) == 0) ||
    (name->len == 6 && memcmp(name->data, "resume", 6) == 0) ||
    (name->len == 5 && memcmp(name->data, "pause", 5) == 0) ||
    (name->len == 9 && memcmp(name->data, "prefinish", 9) == 0);
  if (error || empty) {
    ScrClosure *adapter = error ? scr_dyn_listener_closure_fn(cb, (void *)&scr_stream_listener_error) : scr_dyn_listener_closure0(cb);
    return (ScrStream *)scr_emitter_on_dyn((ScrEmitter *)s, name, cb, adapter,
      error ? scr_ee_inv_fixed1 : scr_ee_inv_fixed0, once, prepend);
  }
  /* The stream emits 'pipe' and 'unpipe' with its source stream; other
   * names reach the listener only through emit calls, with every argument
   * they pass. */
  bool piping = (name->len == 4 && memcmp(name->data, "pipe", 4) == 0) ||
    (name->len == 6 && memcmp(name->data, "unpipe", 6) == 0);
  if (!piping) return (ScrStream *)scr_emitter_on_flex((ScrEmitter *)s, name, cb, once, prepend);
  static const char message[] = "this stream event has no checked-dynamic listener adapter";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

ScrDyn *scr_stream_read_dyn(ScrStream *s, ScrDyn *size) {
  double n = size && size->kind != SCR_DYN_UNDEF ? scr_dyn_number_coerce(size) : -1;
  if (scr_exc_pending()) return scr_dyn_undefined();
  ScrEntryKind kind = SCR_ENTRY_BYTES;
  void *chunk = s->st->has_r ? scr_stream_read_n_kind(s, n, &kind) : NULL;
  if (!chunk) return scr_dyn_new_null();
  if (kind == SCR_ENTRY_BYTES) {
    ScrDyn *result = scr_dyn_new_buffer(chunk);
    scr_bytes_release(chunk);
    return result;
  }
  return scr_stream_entry_box(chunk, kind);
}

/* read() answers STRINGS once encoded: the static result type here is
 * `Buffer | null`, so the honest answer is a fence, not a mistyped
 * payload (SEMANTICS.md; 'data' listeners carry strings). */
static void scr_stream_read_str_fence(void) {
  static const char msg[] =
      "read() on a stream with an encoding set is not supported yet "
      "(consume 'data' events, which deliver strings)";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
}

ScrBytes *scr_stream_read(ScrStream *s, double size) {
  /* a destroyed readable still DRAINS its buffer (Node: destroy leaves
   * buffered chunks readable; only _read refills are blocked) */
  if (!s->st->has_r) return NULL;
  if (s->st->r.encoded && !s->st->r.dyn_entries) {
    scr_stream_read_str_fence();
    return NULL;
  }
  ScrEntryKind kind;
  void *chunk = scr_stream_read_n_kind(s, size, &kind);
  if (chunk && kind == SCR_ENTRY_DYN) {
    /* an object-mode value: a Buffer is the result, anything else is not */
    ScrDyn *d = chunk;
    if (d->kind == SCR_DYN_BYTES) {
      ScrBytes *b = scr_bytes_raw_view(d->v.bytes);
      scr_dyn_release(d);
      return b;
    }
    scr_dyn_release(d);
    static const char msg[] =
        "read() of an object-mode stream value that is not a Buffer is not supported yet in typed "
        "code (consume 'data' events or for await)";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return NULL;
  }
  if (chunk && kind == SCR_ENTRY_STR) {
    /* the read itself made the stream hold strings (a lazy Readable.from
     * pull's first string, or setEncoding() inside _read): the same
     * fence, never a string in the Buffer result */
    scr_str_release(chunk);
    scr_stream_read_str_fence();
    return NULL;
  }
  return chunk;
}

/* setEncoding(enc): flips the readable buffer into string mode — Node
 * re-decodes the buffered content into ONE string entry and re-counts
 * length in string units. Borrows enc (canonical, frontend-folded);
 * answers the receiver +1. */
ScrStream *scr_stream_set_encoding(ScrStream *s, ScrStr *enc) {
  ScrStreamState *st = s->st;
  if (!st->has_r) return scr_stream_retain(s);
  if (st->r.dyn_entries) {
    /* an object-mode buffer of values: Buffers pushed later decode */
    if (st->r.enc) scr_str_release(st->r.enc);
    st->r.enc = scr_str_retain(enc);
    st->r.dec_pending = 0;
    st->r.decoding = true;
    return scr_stream_retain(s);
  }
  if (st->r.encoded) {
    /* switching encodings mid-stream: fold the old decoder's pending
     * tail into the buffer first (rare; Node re-creates the decoder) */
    ScrStr *tail = scr_strdec_end(st->r.enc, st->r.dec_pending);
    if (scr_str_utf16_len(tail) > 0) scr_stream_rbuf_push(st, tail, SCR_ENTRY_STR, false);
    else scr_str_release(tail);
    scr_str_release(st->r.enc);
    st->r.enc = scr_str_retain(enc);
    st->r.dec_pending = 0;
    st->r.decoding = true;
    st->r.object_kind_set = true;
    return scr_stream_retain(s);
  }
  st->r.enc = scr_str_retain(enc);
  st->r.dec_pending = 0;
  /* decode the buffered bytes into one concatenated string entry */
  ScrStr *content = NULL;
  size_t skip = st->r.head_off; /* buf[0] may be part-read (byte offset) */
  for (size_t i = 0; i < st->r.n; i++) {
    ScrBytes *chunk = st->r.buf[i];
    ScrBytes *view = chunk;
    if (i == 0 && skip > 0) {
      view = scr_bytes_new(SCR_BYTES_U8, (double)(chunk->len - skip));
      scr_bytes_read(chunk, skip, view->data, chunk->len - skip);
    }
    ScrStr *piece = scr_strdec_write(st->r.enc, st->r.dec_pending, view);
    st->r.dec_pending = scr_strdec_next(st->r.enc, st->r.dec_pending, view);
    if (view != chunk) scr_bytes_release(view);
    scr_bytes_release(chunk);
    if (content == NULL) {
      content = piece;
    } else {
      ScrStr *joined = scr_str_concat(content, piece);
      scr_str_release(content);
      scr_str_release(piece);
      content = joined;
    }
  }
  if (st->r.ended) {
    /* Node 24: an ended stream's decoder flushes its partial tail */
    ScrStr *tail = scr_strdec_end(st->r.enc, st->r.dec_pending);
    st->r.dec_pending = 0;
    if (content == NULL) {
      content = tail;
    } else {
      ScrStr *joined = scr_str_concat(content, tail);
      scr_str_release(content);
      scr_str_release(tail);
      content = joined;
    }
  }
  st->r.n = 0;
  st->r.head_off = 0;
  st->r.length = 0;
  /* AFTER the byte-entry walk above: from here every entry is a string,
   * and Buffer entries pushed later decode (scr_stream_entry_convert) */
  st->r.encoded = true;
  st->r.decoding = true;
  st->r.object_kind_set = true;
  if (content != NULL) {
    if (scr_str_utf16_len(content) > 0) scr_stream_rbuf_push(st, content, SCR_ENTRY_STR, false);
    else scr_str_release(content);
  }
  return scr_stream_retain(s);
}

ScrStream *scr_stream_pause(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->has_r && st->r.flowing != 0) {
    st->r.flowing = 0;
    scr_stream_emit0(s, "pause"); /* Node emits 'pause' synchronously */
  }
  return scr_stream_retain(s);
}

ScrStream *scr_stream_resume(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->has_r && !st->destroyed && st->r.flowing != 1) {
    st->r.flowing = st->r.readable_listening ? 0 : 1;
    scr_stream_resume_kick(s);
  }
  return scr_stream_retain(s);
}

bool scr_stream_is_paused(ScrStream *s) { return s->st->r.flowing == 0; }

double scr_stream_flowing(ScrStream *s) {
  int f = s->st->r.flowing;
  return f < 0 ? -1 : f;
}

ScrStream *scr_stream_pipe(ScrStream *src, ScrStream *dst, bool end) {
  ScrStreamState *st = src->st;
  if (st->pipes.n == st->pipes.cap) {
    st->pipes.cap = st->pipes.cap ? st->pipes.cap * 2 : 2;
    st->pipes.dst = realloc(st->pipes.dst, st->pipes.cap * sizeof *st->pipes.dst);
    st->pipes.end = realloc(st->pipes.end, st->pipes.cap * sizeof *st->pipes.end);
    if (!st->pipes.dst || !st->pipes.end) scr_stream_oom();
  }
  st->pipes.dst[st->pipes.n] = scr_stream_retain(dst);
  st->pipes.end[st->pipes.n] = end;
  st->pipes.n++;
  scr_stream_emit_stream(dst, "pipe", src); /* Node emits 'pipe' synchronously */
  if (!scr_exc_pending() && st->r.flowing != 1 && st->await_drain == 0) {
    st->r.flowing = 1;
    scr_stream_resume_kick(src);
  }
  return scr_stream_retain(dst);
}

ScrStream *scr_stream_unpipe(ScrStream *src, ScrStream *dst) {
  ScrStreamState *st = src->st;
  for (size_t i = 0; i < st->pipes.n;) {
    if (dst == NULL || st->pipes.dst[i] == dst) {
      ScrStream *d = st->pipes.dst[i];
      memmove(st->pipes.dst + i, st->pipes.dst + i + 1, (st->pipes.n - i - 1) * sizeof *st->pipes.dst);
      memmove(st->pipes.end + i, st->pipes.end + i + 1, (st->pipes.n - i - 1) * sizeof *st->pipes.end);
      st->pipes.n--;
      st->r.flowing = 0; /* Node pauses the source on unpipe */
      scr_stream_emit_stream(d, "unpipe", src);
      scr_stream_release(d);
      if (scr_exc_pending()) break;
      if (dst != NULL) break;
    } else {
      i++;
    }
  }
  return scr_stream_retain(src);
}

/* ── the writable surface ─────────────────────────────────────────────── */

static bool scr_stream_write_chunk_enc(ScrStream *s, ScrBytes *chunk /*borrowed*/,
                                       ScrClosure *cb /*moves*/, ScrDyn *enc /*borrowed*/) {
  ScrStreamState *st = s->st;
  if (!st->has_w || st->destroyed || st->w.ending) {
    ScrError *e = st->has_w && !st->destroyed
        ? scr_stream_mkerr("ERR_STREAM_WRITE_AFTER_END", "write after end")
        : scr_stream_mkerr("ERR_STREAM_DESTROYED", "Cannot call write after a stream was destroyed");
    if (cb) scr_st_tick(s, SCR_ST_WCB_ERR, NULL, cb);
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return false;
  }
  st->w.length += scr_stream_wchunk_len(st, chunk);
  if (enc) enc = scr_dyn_retain(enc);
  if (st->w.writing || st->w.corked > 0 || st->constructing) {
    scr_stream_wq_push(st, scr_stream_wchunk_retain(st, chunk), cb, enc);
  } else {
    scr_stream_do_write(s, scr_stream_wchunk_retain(st, chunk), cb, enc);
  }
  /* Node computes the answer AFTER the (possibly synchronous) write:
   * a sync completion has already drained its bytes from length. Only
   * the length sets needDrain; an errored or destroyed stream answers
   * false without waiting for 'drain'. */
  bool below = st->w.length < st->w.hwm;
  if (!below) st->w.need_drain = true;
  return below && !st->destroyed && !st->errored;
}

static bool scr_stream_write_chunk(ScrStream *s, ScrBytes *chunk /*borrowed*/, ScrClosure *cb /*moves*/) {
  return scr_stream_write_chunk_enc(s, chunk, cb, NULL);
}

/* The encoding argument of a compiled write(chunk[, cb]) on an object-mode
 * side: undefined, or null when the callback took its place (Node's
 * write and end shift it there). */
static ScrDyn *scr_stream_cb_enc(ScrClosure *cb) { return cb ? scr_dyn_new_null() : NULL; }

/* write(value) on an object-mode writable side: the value is the chunk.
 * Borrows v. */
static bool scr_stream_write_value(ScrStream *s, ScrDyn *v, ScrClosure *cb) {
  return scr_stream_write_chunk_enc(s, (ScrBytes *)v, cb, scr_stream_cb_enc(cb));
}

/* A Buffer write on a byte-mode side: with decodeStrings: false the
 * queue holds values, so the Buffer is boxed with its 'buffer' encoding.
 * Borrows chunk. */
static bool scr_stream_write_buffer(ScrStream *s, ScrBytes *chunk, ScrClosure *cb) {
  ScrStreamState *st = s->st;
  if (!st->has_w || !st->w.values) return scr_stream_write_chunk(s, chunk, cb);
  ScrDyn *v = chunk->is_buffer ? scr_dyn_new_buffer(chunk) : scr_dyn_new_bytes(chunk);
  ScrStr *buffer = scr_str_new("buffer", 6);
  ScrDyn *enc = scr_dyn_new_str(buffer);
  scr_str_release(buffer);
  bool ret = scr_stream_write_chunk_enc(s, (ScrBytes *)v, cb, enc);
  scr_dyn_release(enc);
  scr_dyn_release(v);
  return ret;
}

/* A string write on a byte-mode side, with the encoding argument as
 * given (borrowed; NULL takes the default encoding): decodeStrings
 * encodes it (Buffer.from(chunk, encoding)), and with decodeStrings:
 * false it stays a string that _write receives with that encoding. */
static bool scr_stream_write_string(ScrStream *s, ScrStr *str, ScrStr *name, ScrClosure *cb) {
  ScrStreamState *st = s->st;
  ScrStr *given = name ? scr_str_retain(name) : st->has_w && st->w.default_enc ? scr_str_retain(st->w.default_enc) : NULL;
  if (st->has_w && st->w.decode_strings_off) {
    ScrStr *e = given ? given : scr_str_new("utf8", 4);
    ScrDyn *v = scr_dyn_new_str(str);
    ScrDyn *enc = scr_dyn_new_str(e);
    scr_str_release(e);
    bool ret = scr_stream_write_chunk_enc(s, (ScrBytes *)v, cb, enc);
    scr_dyn_release(enc);
    scr_dyn_release(v);
    return ret;
  }
  ScrBytes *b;
  if (given) {
    ScrStr *canonical = scr_bytes_normalize_encoding(given);
    scr_str_release(given);
    if (canonical == NULL) {
      if (cb) scr_closure_release(cb);
      return false;
    }
    b = scr_bytes_from_str(str, canonical);
    scr_str_release(canonical);
  } else {
    b = scr_bytes_new(SCR_BYTES_U8, (double)str->len);
    memcpy(b->data, str->data, str->len);
    if (!str->ascii) scr_wtf8_to_utf8((char *)b->data, str->len);
  }
  scr_stream_buffer(b);
  bool ret = scr_stream_write_buffer(s, b, cb);
  scr_bytes_release(b);
  return ret;
}

bool scr_stream_write(ScrStream *s, ScrBytes *chunk, ScrClosure *cb) {
  if (s->st->has_w && s->st->w.object_mode) {
    ScrDyn *v = chunk->is_buffer ? scr_dyn_new_buffer(chunk) : scr_dyn_new_bytes(chunk);
    bool ret = scr_stream_write_value(s, v, cb);
    scr_dyn_release(v);
    return ret;
  }
  if (!chunk->is_buffer) {
    /* Writable's _write: a typed array or DataView chunk becomes a Buffer
     * over the same bytes (Stream._uint8ArrayToBuffer), which _write,
     * _writev and a decodeStrings: false queue receive. */
    ScrBytes *b = scr_bytes_buffer_view(chunk, SCR_BYTES_U8, scr_bytes_byte_offset(chunk), true,
                                        scr_bytes_byte_len(chunk));
    if (!b) {
      if (cb) scr_closure_release(cb);
      return false;
    }
    b->is_buffer = true;
    bool ret = scr_stream_write_buffer(s, b, cb);
    scr_bytes_release(b);
    return ret;
  }
  return scr_stream_write_buffer(s, chunk, cb);
}

/* write(null) reached at runtime (a nullable-union chunk's null arm):
 * Node throws the ERR_STREAM_NULL_VALUES TypeError synchronously. */
bool scr_stream_write_null(ScrStream *s) {
  (void)s;
  static const char msg[] = "May not write null values to stream";
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_STREAM_NULL_VALUES");
  return false;
}

bool scr_stream_write_str(ScrStream *s, ScrStr *str, ScrClosure *cb) {
  if (s->st->has_w && s->st->w.object_mode) {
    /* object mode: the string itself, not converted */
    ScrDyn *v = scr_dyn_new_str(str);
    bool ret = scr_stream_write_value(s, v, cb);
    scr_dyn_release(v);
    return ret;
  }
  return scr_stream_write_string(s, str, NULL, cb);
}

/* write(chunk, encoding, cb) with the encoding argument as passed (NULL
 * or undefined when absent): an object-mode side hands it to _write
 * unchanged; a byte-mode side encodes a string chunk with it. Borrows
 * chunk and enc. */
bool scr_stream_write_enc(ScrStream *s, const ScrDyn *chunk, ScrDyn *enc, ScrClosure *cb) {
  if (enc && enc->kind == SCR_DYN_UNDEF) enc = NULL;
  ScrStreamState *st = s->st;
  if (chunk->kind != SCR_DYN_NULL && st->has_w && st->w.object_mode)
    return scr_stream_write_chunk_enc(s, (ScrBytes *)chunk, cb, enc);
  /* Node's _write: an encoding other than 'buffer' must be a known one
   * (ERR_UNKNOWN_ENCODING, thrown), and a string chunk is encoded with
   * it; an empty or nullish encoding is the default */
  ScrStr *name = NULL;
  if (enc && enc->kind != SCR_DYN_NULL && !(enc->kind == SCR_DYN_STR && enc->v.str->len == 0))
    name = scr_dyn_string_coerce_js(enc);
  if (name && !(name->len == 6 && memcmp(name->data, "buffer", 6) == 0)) {
    ScrStr *canonical = scr_bytes_normalize_encoding(name);
    if (canonical == NULL) {
      scr_str_release(name);
      if (cb) scr_closure_release(cb);
      return false;
    }
    scr_str_release(canonical);
    bool ret = chunk->kind == SCR_DYN_STR ? scr_stream_write_string(s, chunk->v.str, name, cb)
                                          : scr_stream_write_dyn(s, chunk, cb);
    scr_str_release(name);
    return ret;
  }
  if (name && chunk->kind == SCR_DYN_STR) {
    /* Buffer.from(string, 'buffer') */
    scr_str_release(name);
    if (cb) scr_closure_release(cb);
    static const char msg[] = "Unknown encoding: buffer";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_UNKNOWN_ENCODING");
    return false;
  }
  if (name) scr_str_release(name);
  return scr_stream_write_dyn(s, chunk, cb);
}

ScrStream *scr_stream_end(ScrStream *s, ScrBytes *chunk_b, ScrStr *chunk_s, ScrClosure *cb) {
  ScrStreamState *st = s->st;
  if ((chunk_b || chunk_s) && st->has_w && st->w.object_mode) {
    /* end(chunk[, cb]) writes with the encoding Node's end leaves:
     * undefined, or null when the callback took its place */
    ScrDyn *v = chunk_s ? scr_dyn_new_str(chunk_s)
        : chunk_b->is_buffer ? scr_dyn_new_buffer(chunk_b) : scr_dyn_new_bytes(chunk_b);
    scr_stream_write_chunk_enc(s, (ScrBytes *)v, NULL, scr_stream_cb_enc(cb));
    scr_dyn_release(v);
  } else if (chunk_b) {
    scr_stream_write(s, chunk_b, NULL);
  } else if (chunk_s) {
    scr_stream_write_str(s, chunk_s, NULL);
  }
  if (!st->has_w || st->destroyed) {
    if (cb) scr_closure_release(cb);
    return scr_stream_retain(s);
  }
  if (cb) {
    if (st->w.finished) {
      scr_st_tick(s, SCR_ST_WCB_ERR, NULL, cb); /* already finished: plain call */
    } else {
      if (st->w.end_cbs_n == st->w.end_cbs_cap) {
        st->w.end_cbs_cap = st->w.end_cbs_cap ? st->w.end_cbs_cap * 2 : 2;
        st->w.end_cbs = realloc(st->w.end_cbs, st->w.end_cbs_cap * sizeof *st->w.end_cbs);
        if (!st->w.end_cbs) scr_stream_oom();
      }
      st->w.end_cbs[st->w.end_cbs_n++] = cb;
    }
  }
  if (!st->w.ending) {
    st->w.ending = true;
    if (st->w.corked > 0) {
      st->w.corked = 1;
      scr_stream_uncork(s);
    }
    scr_stream_finish_maybe(s);
  }
  return scr_stream_retain(s);
}

void scr_stream_cork(ScrStream *s) { s->st->w.corked++; }

void scr_stream_uncork(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->w.corked > 0 && --st->w.corked == 0) {
    scr_stream_clear_buffer(s);
    scr_stream_finish_maybe(s);
  }
}

/* ── completion entries (called by the emitted done closures) ─────────── */

void scr_stream_write_done(ScrStream *s, ScrError *err /*moves*/) {
  ScrStreamState *st = s->st;
  if (!st->w.writing) {
    /* cb called twice (or spuriously): Node's ERR_MULTIPLE_CALLBACK */
    if (err) scr_error_release(err);
    ScrError *e = scr_stream_mkerr("ERR_MULTIPLE_CALLBACK", "Callback called multiple times");
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return;
  }
  st->w.writing = false;
  st->w.length -= st->w.inflight_len;
  st->w.inflight_len = 0;
  ScrClosure *ucb = st->w.inflight_cb;
  st->w.inflight_cb = NULL;
  if (err) {
    /* Node's onwrite: errored is set now; onwriteError (the callback,
     * then errorOrDestroy) runs on a tick after a synchronous write. */
    if (!st->errored) st->errored = scr_error_retain(err);
    if (st->w.wsync) {
      scr_st_tick(s, SCR_ST_WRITE_ERR, err, ucb);
      return;
    }
    if (ucb) {
      ((void (*)(ScrClosure *))ucb->fn)(ucb);
      scr_closure_release(ucb);
    }
    if (!scr_exc_pending()) scr_stream_error_or_destroy(s, err);
    scr_error_release(err);
    return;
  }
  /* Node's onwrite: the buffered queue restarts FIRST (clearBuffer),
   * then afterWrite — deferred to a tick for a synchronous completion. */
  bool was_sync = st->w.wsync;
  scr_stream_clear_buffer(s);
  if (scr_exc_pending()) {
    if (ucb) scr_closure_release(ucb);
    return;
  }
  if (was_sync) {
    bool hold = ucb != NULL || (st->w.need_drain && st->w.length == 0) || st->destroyed;
    ScrStreamTick *pending = st->w.after_tick;
    if (pending && pending->cb == ucb) {
      /* Node's onwrite: a synchronous write with the callback of the
       * afterWrite tick already queued joins it (count++) */
      pending->count++;
      if (ucb) scr_closure_release(ucb);
    } else {
      scr_st_tick(s, SCR_ST_AFTER_WRITE, NULL, ucb);
      pending = scr_st_tail;
      pending->count = 1;
      st->w.after_tick = pending;
    }
    if (hold && !pending->hold) {
      pending->hold = true;
      st->w.after_holds++;
    }
  } else {
    scr_stream_after_write(s, ucb, 1);
  }
}

void scr_stream_final_done(ScrStream *s, ScrError *err /*moves*/) {
  ScrStreamState *st = s->st;
  st->w.final_pending = false;
  if (err) {
    scr_stream_error_or_destroy(s, err);
    scr_error_release(err);
    return;
  }
  st->w.prefinished = true;
  scr_stream_emit0(s, "prefinish");
  if (scr_exc_pending()) return;
  scr_stream_finish_maybe(s);
}

void scr_stream_destroy_done(ScrStream *s, ScrError *err /*moves*/) {
  ScrStreamState *st = s->st;
  /* Node's onDestroy: 'error' emits only with the error the USER'S
   * callback passed along — a `cb()` after destroy(err) SWALLOWS the
   * error (errored stays set, no emission; the default _destroy forwards,
   * which is the no-destroy-callback path in do_destroy). */
  if (err) {
    if (!st->errored) st->errored = scr_error_retain(err);
    if (!st->error_scheduled) {
      st->error_scheduled = true;
      scr_st_tick(s, SCR_ST_ERROR, err, NULL);
    } else {
      scr_error_release(err);
    }
  }
  if (!st->close_scheduled) {
    st->close_scheduled = true;
    scr_st_tick(s, SCR_ST_CLOSE, NULL, NULL);
  }
}

/* Transform._write's callback after the transform pushed its output:
 * on a tick once the readable side has ended, at once when the writable
 * side has ended, the transform pushed nothing, or the readable buffer is
 * below its high-water mark, and otherwise when the readable side next
 * reads (Transform._read). */
static void scr_stream_transform_callback(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->r.ended) scr_st_tick(s, SCR_ST_XF_DONE, NULL, NULL);
  else if (st->w.ending || st->xf_length == st->r.length || st->r.length < st->r.hwm)
    scr_stream_write_done(s, NULL);
  else st->xf_held = true;
}

void scr_stream_transform_done(ScrStream *s, ScrError *err /*moves*/, ScrBytes *data /*moves*/,
                               ScrStr *data_str /*moves*/) {
  if (!err) {
    if (data) {
      scr_stream_add_chunk(s, data, false);
    } else if (data_str && s->st->r.object_entries) {
      scr_stream_push_str(s, data_str); /* object mode: the string itself */
    } else if (data_str) {
      ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)data_str->len);
      memcpy(b->data, data_str->data, data_str->len);
      if (!data_str->ascii) scr_wtf8_to_utf8((char *)b->data, data_str->len);
      scr_stream_buffer(b);
      scr_stream_add_chunk(s, b, false);
      scr_bytes_release(b);
    }
  }
  if (data) scr_bytes_release(data);
  if (data_str) scr_str_release(data_str);
  if (scr_exc_pending()) {
    if (err) scr_error_release(err);
    return;
  }
  if (err) scr_stream_write_done(s, err);
  else scr_stream_transform_callback(s);
}

void scr_stream_flush_done(ScrStream *s, ScrError *err /*moves*/, ScrBytes *data /*moves*/,
                           ScrStr *data_str /*moves*/) {
  ScrStreamState *st = s->st;
  st->flush_pending = false;
  if (err) {
    if (data) scr_bytes_release(data);
    if (data_str) scr_str_release(data_str);
    scr_stream_error_or_destroy(s, err);
    scr_error_release(err);
    return;
  }
  if (data) {
    scr_stream_add_chunk(s, data, false);
    scr_bytes_release(data);
  } else if (data_str && st->r.object_entries) {
    scr_stream_push_str(s, data_str); /* object mode: the string itself */
    scr_str_release(data_str);
  } else if (data_str) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)data_str->len);
    memcpy(b->data, data_str->data, data_str->len);
    if (!data_str->ascii) scr_wtf8_to_utf8((char *)b->data, data_str->len);
    scr_stream_buffer(b);
    scr_stream_add_chunk(s, b, false);
    scr_bytes_release(b);
    scr_str_release(data_str);
  }
  if (scr_exc_pending()) return;
  scr_stream_push_null(s); /* EOF the readable side after flush */
  if (scr_exc_pending()) return;
  scr_stream_finish_maybe(s);
}

/* The transform and flush completions with a checked-dynamic value (an
 * object-mode Transform's data, or an untyped callback's): null and
 * undefined push nothing (Transform's `val != null`), and any other value
 * is pushed as push(value) pushes it. v borrowed (NULL: absent). */
static bool scr_stream_done_pushes(const ScrDyn *v) {
  return v && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_UNDEF;
}

void scr_stream_transform_done_value(ScrStream *s, ScrError *err /*moves*/, ScrDyn *v) {
  if (!err && scr_stream_done_pushes(v)) scr_stream_push_dyn(s, v);
  if (scr_exc_pending()) {
    if (err) scr_error_release(err);
    return;
  }
  if (err) scr_stream_write_done(s, err);
  else scr_stream_transform_callback(s);
}

void scr_stream_flush_done_value(ScrStream *s, ScrError *err /*moves*/, ScrDyn *v) {
  s->st->flush_pending = false;
  if (err) {
    scr_stream_error_or_destroy(s, err);
    scr_error_release(err);
    return;
  }
  if (scr_stream_done_pushes(v)) scr_stream_push_dyn(s, v);
  if (scr_exc_pending()) return;
  scr_stream_push_null(s);
  if (scr_exc_pending()) return;
  scr_stream_finish_maybe(s);
}

/* ── destroy ──────────────────────────────────────────────────────────── */

/* Node's _destroy step: the destroy hook, or 'error'/'close' on ticks. */
static void scr_stream_run_destroy(ScrStream *s, ScrError *err /*borrowed*/) {
  ScrStreamState *st = s->st;
  if (st->destroy_cb) {
    st->destroy_calling = true;
    st->destroy_inv(st->destroy_cb, s, err);
    st->destroy_calling = false;
    if (scr_exc_pending()) return;
    /* the user's destroy must call its callback (destroy_done schedules
     * 'error'/'close'); a user destroy that never calls back leaves the
     * stream half-closed, exactly Node */
    return;
  }
  if (err) {
    if (!st->error_scheduled) {
      st->error_scheduled = true;
      scr_st_tick(s, SCR_ST_ERROR, scr_error_retain(err), NULL);
    }
  }
  if (!st->close_scheduled) {
    st->close_scheduled = true;
    scr_st_tick(s, SCR_ST_CLOSE, NULL, NULL);
  }
}

static void scr_stream_do_destroy(ScrStream *s, ScrError *err /*borrowed*/) {
  ScrStreamState *st = s->st;
  if (st->destroyed || st->destroy_calling) return;
  /* Writable.prototype.destroy: pending callbacks run on a tick (Duplex
   * keeps Readable.prototype.destroy, so only afterWrite runs them) */
  if (st->has_w && !st->has_r && (st->w.head < st->w.n || st->w.end_cbs_n > 0)) {
    scr_st_tick(s, SCR_ST_ERROR_BUFFER, NULL, NULL);
  }
  st->destroyed = true;
  if (err && !st->errored) st->errored = scr_error_retain(err);
  scr_stream_settle_next(s); /* a parked for-await rejects/finishes */
  if (st->constructing) {
    /* still constructing: _destroy runs at onConstruct */
    st->destroy_deferred = true;
    st->destroy_err = err ? scr_error_retain(err) : NULL;
    return;
  }
  scr_stream_run_destroy(s, err);
}

ScrStream *scr_stream_destroy(ScrStream *s, ScrError *err) {
  scr_stream_do_destroy(s, err);
  return scr_stream_retain(s);
}

ScrStream *scr_stream_iterator_close(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->destroyed) return scr_stream_retain(s);
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(error->name);
  error->name = scr_str_new("AbortError", 10);
  scr_error_set_code(error, "ABORT_ERR");
  /* Node's iterator registers an internal error listener: the AbortError is
   * still observable through stream.errored and user listeners, but it does
   * not become an unhandled 'error' event when nobody subscribed. */
  st->next_err_consumed = true;
  scr_stream_do_destroy(s, error);
  scr_error_release(error);
  return scr_stream_retain(s);
}

ScrError *scr_stream_errored(ScrStream *s) {
  return s->st->errored ? scr_error_retain(s->st->errored) : NULL;
}

/* ── properties ───────────────────────────────────────────────────────── */

double scr_stream_prop(ScrStream *s, const char *name) {
  ScrStreamState *st = s->st;
  if (strcmp(name, "readable") == 0) {
    return st->has_r && !st->destroyed && !st->r.end_emitted && !st->errored;
  }
  if (strcmp(name, "readableEnded") == 0) return st->r.end_emitted;
  if (strcmp(name, "readableLength") == 0) return (double)st->r.length;
  if (strcmp(name, "readableHighWaterMark") == 0) return (double)st->r.hwm;
  if (strcmp(name, "readableObjectMode") == 0) return st->r.object_entries;
  if (strcmp(name, "writableObjectMode") == 0) return st->w.object_mode;
  if (strcmp(name, "writable") == 0) {
    return st->has_w && !st->destroyed && !st->w.ending && !st->errored;
  }
  if (strcmp(name, "writableEnded") == 0) return st->w.ending;
  if (strcmp(name, "writableFinished") == 0) return st->w.finished;
  if (strcmp(name, "writableNeedDrain") == 0) return st->w.need_drain;
  if (strcmp(name, "writableLength") == 0) return (double)st->w.length;
  if (strcmp(name, "writableHighWaterMark") == 0) return (double)st->w.hwm;
  if (strcmp(name, "writableCorked") == 0) return (double)st->w.corked;
  if (strcmp(name, "destroyed") == 0) return st->destroyed;
  if (strcmp(name, "closed") == 0) return st->close_emitted;
  if (strcmp(name, "allowHalfOpen") == 0) return st->allow_half_open;
  /* The _readableState/_writableState compat VIEW (read-only): each name
   * answers from the field the runtime actually keeps. Node's ending/
   * ended distinction inside end() collapses onto w.ending here. */
  if (strncmp(name, "rs:", 3) == 0) {
    const char *p = name + 3;
    if (strcmp(p, "ended") == 0) return st->r.ended;
    if (strcmp(p, "endEmitted") == 0) return st->r.end_emitted;
    if (strcmp(p, "destroyed") == 0) return st->destroyed;
    if (strcmp(p, "errorEmitted") == 0) return st->error_emitted;
    if (strcmp(p, "emittedReadable") == 0) return st->r.emitted_readable;
    if (strcmp(p, "needReadable") == 0) return st->r.need_readable;
    if (strcmp(p, "reading") == 0) return st->r.reading;
    if (strcmp(p, "readableListening") == 0) return st->r.readable_listening;
    if (strcmp(p, "resumeScheduled") == 0) return st->r.resume_scheduled;
    if (strcmp(p, "objectMode") == 0) return st->r.object_entries;
    if (strcmp(p, "constructed") == 0) return 1;
    if (strcmp(p, "closed") == 0) return st->close_emitted;
    if (strcmp(p, "length") == 0) return (double)st->r.length;
    if (strcmp(p, "highWaterMark") == 0) return (double)st->r.hwm;
    return 0;
  }
  if (strncmp(name, "ws:", 3) == 0) {
    const char *p = name + 3;
    if (strcmp(p, "ended") == 0 || strcmp(p, "ending") == 0) return st->w.ending;
    if (strcmp(p, "finished") == 0) return st->w.finished;
    if (strcmp(p, "prefinished") == 0) return st->w.prefinished;
    if (strcmp(p, "destroyed") == 0) return st->destroyed;
    if (strcmp(p, "errorEmitted") == 0) return st->error_emitted;
    if (strcmp(p, "needDrain") == 0) return st->w.need_drain;
    if (strcmp(p, "objectMode") == 0) return st->w.object_mode;
    if (strcmp(p, "constructed") == 0) return 1;
    if (strcmp(p, "closed") == 0) return st->close_emitted;
    if (strcmp(p, "length") == 0) return (double)st->w.length;
    if (strcmp(p, "highWaterMark") == 0) return (double)st->w.hwm;
    if (strcmp(p, "corked") == 0) return (double)st->w.corked;
    if (strcmp(p, "bufferedRequestCount") == 0) return (double)(st->w.n - st->w.head);
    return 0;
  }
  return 0;
}

/* emitReadable_ — the shared body of the 'readable' tick AND the
 * synchronous onEofChunk call (Node runs it directly when the eof push
 * arrives outside a _read call). */
static void scr_stream_emit_readable_now(ScrStream *s) {
  ScrStreamState *st = s->st;
  /* Node's emitReadable_ clears emittedReadable AFTER the emit (a
   * 'readable' listener observes true) and only when it really fired. */
  if (!st->destroyed && !st->errored && (st->r.length > 0 || st->r.ended)) {
    scr_stream_emit0(s, "readable");
    if (scr_exc_pending()) return;
    st->r.emitted_readable = false;
  }
  st->r.need_readable = st->r.flowing != 1 && !st->r.ended &&
                        st->r.length <= st->r.hwm;
  scr_stream_flow(s);
  if (!scr_exc_pending() && st->r.ended && st->r.length == 0) {
    scr_stream_end_readable(s);
  }
}

/* ── tick dispatch ────────────────────────────────────────────────────── */

/* onConstruct + the readable/writable onConstructed hooks. err moves. */
/* aggregateTwoErrors(inner, outer) for streams without native ops: both
 * present and distinct make an AggregateError([outer, inner]) with
 * outer's message and code. Borrows both; +1 or NULL. */
static ScrError *scr_stream_aggregate_errors(ScrError *inner, ScrError *outer) {
  if (inner && outer && inner != outer) {
    ScrDyn *message = scr_dyn_new_str(outer->message);
    ScrError *agg = scr_aggregate_new(message, scr_dyn_undefined());
    scr_dyn_release(message);
    if (agg == NULL) return scr_error_retain(outer);
    ScrDyn *outer_value = scr_dyn_from_error(outer);
    ScrDyn *list = scr_dyn_new_arr();
    scr_dyn_arr_push(list, scr_dyn_retain(outer_value));
    scr_dyn_arr_push(list, scr_dyn_from_error(inner));
    scr_aggregate_set_errors(agg, list);
    scr_dyn_release(list);
    ScrDyn *code = scr_dyn_obj_read(outer_value, "code", 4);
    if (code && code->kind == SCR_DYN_STR) scr_error_set_code(agg, code->v.str->data);
    scr_dyn_release(code);
    scr_dyn_release(outer_value);
    return agg;
  }
  ScrError *one = outer ? outer : inner;
  return one ? scr_error_retain(one) : NULL;
}

static void scr_stream_constructed(ScrStream *s, ScrError *err) {
  ScrStreamState *st = s->st;
  if (st->construct_finished) {
    /* onConstruct called again: errorOrDestroy(err ?? ERR_MULTIPLE_CALLBACK) */
    if (!err) err = scr_stream_mkerr("ERR_MULTIPLE_CALLBACK", "Callback called multiple times");
    scr_stream_error_or_destroy(s, err);
    scr_error_release(err);
    return;
  }
  st->construct_finished = true;
  st->constructing = false;
  if (st->construct_cb) {
    scr_closure_release(st->construct_cb);
    st->construct_cb = NULL;
  }
  if (st->destroy_deferred) {
    st->destroy_deferred = false;
    ScrError *derr = st->destroy_err;
    st->destroy_err = NULL;
    /* aggregateTwoErrors(constructError, destroyError): the owner builds
     * the AggregateError when both are present and distinct */
    ScrError *use;
    if (err && derr && err != derr) {
      use = st->native_ops && st->native_ops->aggregate ? st->native_ops->aggregate(err, derr)
                                                         : scr_stream_aggregate_errors(err, derr);
    } else {
      use = derr ? derr : err;
      if (use) scr_error_retain(use);
    }
    if (use && !st->errored) st->errored = scr_error_retain(use);
    scr_stream_run_destroy(s, use);
    if (use) scr_error_release(use);
    if (err) scr_error_release(err);
    if (derr) scr_error_release(derr);
    return;
  }
  if (err) {
    scr_stream_error_or_destroy(s, err);
    scr_error_release(err);
    return;
  }
  if (st->has_r && st->r.need_readable) scr_stream_maybe_read_more(s);
  if (st->has_w) {
    if (!st->w.writing) scr_stream_clear_buffer(s);
    if (scr_exc_pending()) return;
    if (st->w.ending) scr_stream_finish_maybe(s);
  }
}

void scr_stream_construct(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamPlainInv inv) {
  ScrStreamState *st = s->st;
  st->constructing = true;
  st->construct_cb = cb;
  st->construct_inv = inv;
  scr_st_tick(s, SCR_ST_CONSTRUCT, NULL, NULL);
}

void scr_stream_construct_done(ScrStream *s, ScrError *err /*moves*/) {
  scr_st_tick(s, SCR_ST_CONSTRUCTED, err, NULL);
}

void scr_stream_set_writev_concat(ScrStream *s) { s->st->writev_concat = true; }

/* A user construct option or _construct method: Node schedules it from the
 * constructor (construct(stream, cb)), and the hook's callback reports
 * through scr_stream_construct_done. */
void scr_stream_set_construct(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamPlainInv inv) {
  if (s->st->construct_cb || s->st->construct_finished) {
    scr_closure_release(cb);
    return;
  }
  scr_stream_construct(s, cb, inv);
}

void scr_stream_replace_construct(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamPlainInv inv) {
  ScrStreamState *st = s->st;
  if (!st->constructing || st->construct_called || !st->construct_cb) {
    scr_closure_release(cb);
    return;
  }
  scr_closure_release(st->construct_cb);
  st->construct_cb = cb;
  st->construct_inv = inv;
}

/* A class's _writev under options that may carry their own writev (the
 * option, an instance property in Node, wins). */
void scr_stream_set_writev_default(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamWritevInv inv) {
  if (s->st->has_w && s->st->w.writev_cb == NULL) {
    scr_stream_set_writev(s, cb, inv);
    return;
  }
  scr_closure_release(cb);
}

/* A user writev option or _writev method. */
void scr_stream_set_writev(ScrStream *s, ScrClosure *cb /*moves*/, ScrStreamWritevInv inv) {
  ScrStreamState *st = s->st;
  if (!st->has_w) {
    scr_closure_release(cb);
    return;
  }
  if (st->w.writev_cb) scr_closure_release(st->w.writev_cb);
  st->w.writev_cb = cb;
  st->w.writev_inv = inv;
}

void scr_stream_fail(ScrStream *s, ScrError *err) { scr_stream_error_or_destroy(s, err); }

static void scr_stream_plain_inv(ScrClosure *cb, va_list ap) {
  (void)ap;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

static void scr_stream_destroy_listener(ScrClosure *cb) {
  ScrStream *s = scr_box_get_ref(cb->caps[0]);
  scr_stream_do_destroy(s, NULL);
  scr_stream_release(s);
}

/* fs.WriteStream.close(cb): cb runs at 'close' (on a tick when already
 * closed); without autoClose a 'finish' listener destroys the stream;
 * then end(). cb moves (NULL = absent). */
void scr_stream_close_writable(ScrStream *s, ScrClosure *cb) {
  ScrStreamState *st = s->st;
  if (cb) {
    if (st->close_emitted) {
      scr_st_tick(s, SCR_ST_WCB_ERR, NULL, cb);
      return;
    }
    ScrStr *name = scr_str_new("close", 5);
    scr_stream_release((ScrStream *)scr_emitter_on((ScrEmitter *)s, name, cb, &scr_stream_plain_inv, false, false));
    scr_str_release(name);
    if (scr_exc_pending()) return;
  }
  if (!st->auto_destroy) {
    ScrClosure *d = scr_closure_new((void *)&scr_stream_destroy_listener, 1);
    d->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
    scr_box_set_ref(d->caps[0], scr_stream_retain(s));
    ScrStr *name = scr_str_new("finish", 6);
    scr_stream_release((ScrStream *)scr_emitter_on((ScrEmitter *)s, name, d, &scr_stream_plain_inv, false, false));
    scr_str_release(name);
    if (scr_exc_pending()) return;
  }
  scr_stream_release(scr_stream_end(s, NULL, NULL, NULL));
}

void scr_stream_set_native_ops(ScrStream *s, const ScrStreamNativeOps *ops) {
  s->st->native_ops = ops;
}

static void scr_stream_run_tick(ScrStreamTick *t) {
  ScrStream *s = t->s;
  ScrStreamState *st = s->st;
  switch (t->op) {
    case SCR_ST_RESUME: {
      st->r.resume_scheduled = false;
      if (!st->r.reading && st->r.flowing == 1) {
        /* read(0) kick: pull the user _read without consuming */
        st->r.need_readable = st->r.length == 0;
        if (!st->r.ended && !st->destroyed && !st->constructing) scr_stream_call_read(s);
        if (scr_exc_pending()) break;
      }
      scr_stream_emit0(s, "resume");
      if (scr_exc_pending()) break;
      scr_stream_flow(s);
      if (scr_exc_pending()) break;
      if (st->r.flowing == 1 && !st->r.reading && !st->r.ended && !st->destroyed &&
          !st->constructing) {
        scr_stream_call_read(s);
      }
      break;
    }
    case SCR_ST_READABLE:
      scr_stream_emit_readable_now(s);
      break;
    case SCR_ST_END: {
      st->r.end_scheduled = false;
      if (st->destroyed || st->errored || st->r.end_emitted || st->r.length != 0 || !st->r.ended) break;
      st->r.end_emitted = true;
      scr_stream_emit0(s, "end");
      if (scr_exc_pending()) break;
      /* pipe end propagation */
      for (size_t i = 0; i < st->pipes.n; i++) {
        if (st->pipes.end[i]) {
          scr_stream_release(scr_stream_end(st->pipes.dst[i], NULL, NULL, NULL));
          if (scr_exc_pending()) break;
        }
      }
      if (scr_exc_pending()) break;
      if (st->has_w && !st->allow_half_open && !st->w.ending) {
        scr_st_tick(s, SCR_ST_END_W, NULL, NULL);
        break;
      }
      if (st->auto_destroy && (!st->has_w || st->w.finished)) {
        scr_stream_do_destroy(s, NULL);
      }
      break;
    }
    case SCR_ST_MAYBE_MORE: {
      st->r.maybe_more_scheduled = false;
      if (st->destroyed || st->constructing) break;
      /* loop while synchronous pushes make progress below the hwm */
      while (!st->r.reading && !st->r.ended && st->r.length < st->r.hwm &&
             (st->r.flowing == 1 || st->r.need_readable) && !scr_exc_pending()) {
        size_t before = st->r.length;
        scr_stream_call_read(s);
        if (scr_exc_pending() || st->r.length == before) break;
      }
      break;
    }
    case SCR_ST_XF_DONE:
      if (st->w.writing) scr_stream_write_done(s, NULL);
      break;
    case SCR_ST_AFTER_WRITE: {
      st->w.after_scheduled = false;
      if (t->hold) st->w.after_holds--;
      /* afterWriteTick: the batch closes when any afterWrite tick runs, so
       * a write its callback makes queues a new tick */
      st->w.after_tick = NULL;
      ScrClosure *cb = t->cb;
      t->cb = NULL;
      if (!st->destroyed) {
        scr_stream_after_write(s, cb, t->count);
      } else {
        if (cb) {
          for (size_t i = 0; i < t->count; i++) {
            ((void (*)(ScrClosure *))cb->fn)(cb);
            if (scr_exc_pending()) break;
          }
          scr_closure_release(cb);
          if (scr_exc_pending()) break;
        }
        scr_stream_error_buffer(s);
      }
      break;
    }
    case SCR_ST_FINISH: {
      st->w.finish_scheduled = false;
      if (st->destroyed || st->w.finished) break;
      st->w.finished = true;
      /* Node runs the end(cb) callbacks (kOnFinished) BEFORE 'finish'. */
      while (st->w.end_cbs_n > 0) {
        ScrClosure *cb = st->w.end_cbs[0];
        memmove(st->w.end_cbs, st->w.end_cbs + 1, (st->w.end_cbs_n - 1) * sizeof *st->w.end_cbs);
        st->w.end_cbs_n--;
        ((void (*)(ScrClosure *))cb->fn)(cb);
        scr_closure_release(cb);
        if (scr_exc_pending()) break;
      }
      if (scr_exc_pending()) break;
      scr_stream_emit0(s, "finish");
      if (scr_exc_pending()) break;
      if (st->auto_destroy && (!st->has_r || st->r.end_emitted || !st->r.readable_listening)) {
        /* Node: autoDestroy after finish once the readable half is done
         * (a half-open duplex with a live readable side stays up) */
        if (!st->has_r || st->r.end_emitted) scr_stream_do_destroy(s, NULL);
      }
      break;
    }
    case SCR_ST_ERROR: {
      st->error_scheduled = false;
      if (!st->error_emitted && t->err) {
        st->error_emitted = true;
        if (st->next_err_consumed && !scr_emitter_has((ScrEmitter *)s, "error")) {
          /* the for-await's rejection consumed it (Node's iterator
           * registers its own 'error' handler — no unhandled crash) */
          scr_stream_settle_next(s);
          break;
        }
        if (st->fin.n > 0 && !scr_emitter_has((ScrEmitter *)s, "error")) {
          /* a finished()/pipeline watcher consumes it (Node's eos and
           * pipeline register their own 'error' handlers) — the watcher
           * reports it at the terminal point instead of crashing */
          break;
        }
        scr_stream_emit_error(s, t->err);
        if (!scr_exc_pending()) scr_stream_settle_next(s);
      }
      break;
    }
    case SCR_ST_CLOSE: {
      st->close_scheduled = false;
      if (!st->close_emitted) {
        st->close_emitted = true;
        if (st->emit_close) scr_stream_emit0(s, "close");
        if (st->r.next_eof_close && !scr_exc_pending()) {
          /* the iterator's eos 'close' listener completes the loop */
          st->r.next_eof_close = false;
          ScrPromise *w = st->r.next_waiter;
          st->r.next_waiter = NULL;
          if (w) scr_stream_next_fulfill(st, w, NULL, SCR_ENTRY_BYTES);
        }
        /* eos ordering: the finished()/pipeline watchers fire right after
         * 'close' (Node's willEmitClose stance). */
        scr_stream_notify_finished(s);
        /* Fully closed: nothing calls the option callbacks again (Node's
         * contract), so drop them here — this breaks the reference cycle
         * a callback capturing its own stream forms, including the dyn-
         * options closures whose stream edge rides through a dyn function
         * value the cycle collector cannot traverse. */
              if (st->r.read_cb) { scr_closure_release(st->r.read_cb); st->r.read_cb = NULL; }
        if (st->w.write_cb) { scr_closure_release(st->w.write_cb); st->w.write_cb = NULL; }
        if (st->w.final_cb) { scr_closure_release(st->w.final_cb); st->w.final_cb = NULL; }
        if (st->w.writev_cb) { scr_closure_release(st->w.writev_cb); st->w.writev_cb = NULL; }
        if (st->transform_cb) { scr_closure_release(st->transform_cb); st->transform_cb = NULL; }
        if (st->flush_cb) { scr_closure_release(st->flush_cb); st->flush_cb = NULL; }
        if (st->destroy_cb) { scr_closure_release(st->destroy_cb); st->destroy_cb = NULL; }
        if (st->write_done) { scr_closure_release(st->write_done); st->write_done = NULL; }
        if (st->done_cache) { scr_closure_release(st->done_cache); st->done_cache = NULL; }
      }
      break;
    }
    case SCR_ST_END_W: {
      scr_stream_release(scr_stream_end(s, NULL, NULL, NULL));
      break;
    }
    case SCR_ST_WCB_ERR: {
      ScrClosure *cb = t->cb;
      t->cb = NULL;
      if (cb) {
        ((void (*)(ScrClosure *))cb->fn)(cb);
        scr_closure_release(cb);
      }
      break;
    }
    case SCR_ST_WRITE_ERR: {
      ScrClosure *cb = t->cb;
      t->cb = NULL;
      if (cb) {
        ((void (*)(ScrClosure *))cb->fn)(cb);
        scr_closure_release(cb);
      }
      if (!scr_exc_pending()) scr_stream_error_or_destroy(s, t->err);
      break;
    }
    case SCR_ST_FIN: {
      scr_stream_notify_finished(s);
      break;
    }
    case SCR_ST_READ0: {
      if (st->has_r) {
        ScrEntryKind kind;
        void *chunk = scr_stream_read_n_kind(s, 0, &kind);
        if (chunk) scr_stream_entry_release_kind(chunk, kind);
      }
      break;
    }
    case SCR_ST_NEXT_WAKE: {
      /* the 'readable' listener resolves the iterator's wait; the loop
       * resumes (and reads) in the promise job */
      ScrClosure *job = scr_closure_new((void *)&scr_stream_next_wake_job, 1);
      job->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
      scr_box_set_ref(job->caps[0], scr_stream_retain(s));
      scr_queue_microtask(job);
      break;
    }
    case SCR_ST_ERROR_BUFFER:
      scr_stream_error_buffer(s);
      break;
    case SCR_ST_CONSTRUCT: {
      st->construct_called = true;
      if (st->construct_cb) {
        st->construct_inv(st->construct_cb, s);
        /* a throw inside _construct reaches onConstruct on a tick */
        if (scr_exc_pending()) scr_stream_construct_done(s, scr_stream_take_error());
      }
      break;
    }
    case SCR_ST_CONSTRUCTED: {
      ScrError *err = t->err;
      t->err = NULL;
      scr_stream_constructed(s, err);
      break;
    }
    case SCR_ST_NEXT_EOF: {
      if (st->r.next_waiter && st->r.length == 0 && st->r.ended && st->r.next_close_wait &&
          !st->close_emitted) {
        st->r.next_eof_close = true;
      } else if (st->r.next_waiter && st->r.length == 0 && (st->r.ended || st->destroyed)) {
        ScrPromise *w = st->r.next_waiter;
        st->r.next_waiter = NULL;
        scr_stream_next_fulfill(st, w, NULL, SCR_ENTRY_BYTES);
      } else if (st->r.next_waiter) {
        scr_stream_settle_next(s); /* content raced in: deliver it */
      }
      break;
    }
  }
}

static void scr_stream_dispatch(void);

/* A tick runs in the context it was scheduled in. */
static void scr_stream_run_tick_in_context(ScrStreamTick *t) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(t->ctx);
  scr_stream_run_tick(t);
  scr_als_dispatch_leave(prev);
}

static void scr_stream_tick_free(ScrStreamTick *t) {
  if (t->s->st && t->s->st->w.after_tick == t) t->s->st->w.after_tick = NULL;
  scr_stream_release(t->s);
  if (t->err) scr_error_release(t->err);
  if (t->cb) scr_closure_release(t->cb);
  scr_als_ctx_release(t->ctx);
  scr_mem_free(t);
}

/* One tick-marker's dispatch: the queue's FIFO head (markers and entries
 * are enqueued 1:1 in the same order). After an uncaught throw the
 * remaining entries drop through the station's exc branch below, keeping
 * the RC audit clean. */
static void scr_stream_dispatch_one(void) {
  ScrStreamTick *t = scr_st_head;
  if (t == NULL || scr_exc_pending()) return;
  scr_st_head = t->next;
  if (scr_st_head == NULL) scr_st_tail = NULL;
  scr_stream_run_tick_in_context(t);
  scr_stream_tick_free(t);
  if (scr_exc_pending()) scr_stream_dispatch(); /* its exc branch drops the rest */
}

static void scr_stream_dispatch(void) {
  while (scr_st_head != NULL && !scr_exc_pending() && !scr_loop_has_ready()) {
    ScrStreamTick *t = scr_st_head;
    scr_st_head = t->next;
    if (scr_st_head == NULL) scr_st_tail = NULL;
    scr_stream_run_tick_in_context(t);
    scr_stream_tick_free(t);
  }
  /* An uncaught throw ends the process (the loop returns to main): the
   * undelivered ticks are DROPPED — release their references here so the
   * RC audit stays clean (the children-teardown precedent). */
  if (scr_exc_pending()) {
    while (scr_st_head != NULL) {
      ScrStreamTick *t = scr_st_head;
      scr_st_head = t->next;
      scr_stream_tick_free(t);
    }
    scr_st_tail = NULL;
  }
}

static const ScrHandleStreamHooks scr_handle_stream_hooks_impl;

void scr_stream_install(void) {
  scr_emitter_on_hook = &scr_stream_on_listener;
  scr_handle_stream_hooks = &scr_handle_stream_hooks_impl;
  scr_loop_set_stream(&scr_stream_ticks_pending, &scr_stream_dispatch);
}

/* Child stdio uses the standard stream machinery once it crosses generic
 * storage. Child-only programs never reference this optional table. */
static void scr_stream_child_read(ScrClosure *cb, ScrStream *s, double size) {
  (void)cb; (void)s; (void)size;
}
static ScrStream *scr_stream_child_readable(const char *cls) {
  ScrStream *s = scr_stream_new_readable(-1, true, true,
      scr_closure_new((void *)scr_stream_child_read, 0), scr_stream_child_read,
      NULL, NULL);
  s->cls = cls;
  return s;
}
static ScrStream *scr_stream_child_writable(const char *cls, ScrClosure *write,
    ScrStreamChunkInv write_inv, ScrClosure *final_cb, ScrStreamPlainInv final_inv) {
  ScrStream *s = scr_stream_new_writable(-1, true, true, write, write_inv,
      final_cb, final_inv, NULL, NULL);
  s->cls = cls;
  return s;
}
const ScrChildStreamOps scr_stream_child_ops = {
  scr_stream_child_readable, scr_stream_child_writable,
  scr_stream_retain_v, scr_stream_release_v, scr_stream_trace,
  scr_stream_push, scr_stream_push_null,
  scr_stream_write_done, scr_stream_final_done,
};

static ScrDyn *scr_stream_dyn_view_v(void *stream) { return scr_stream_dyn_view(stream); }

/* new Worker() with the stdout or stderr option (readable.workerStdio) */
void scr_stream_worker_stdio(void) {
#ifdef SCR_WORKERS
  scr_worker_stdio_default(&scr_stream_child_ops, scr_stream_dyn_view_v);
#endif
}

/* ── handles that are Transforms (Cipheriv, Decipheriv) ──────────────────
 * A Transform handle (ScrDynHandleOps.transform) used as a stream gets one
 * native Transform, built here on first use and kept in the handle's
 * slot. Its steps share the handle (held, and traced: the handle and its
 * stream form a cycle the collector reclaims) and the handle's static
 * ops: each chunk goes through the handle's update(), and the flush pushes
 * final() or reports its error. */

static void *scr_handle_ops_retain(void *p) { return p; }
static void scr_handle_ops_release(void *p) { (void)p; }

static const ScrDynHandleOps *scr_handle_step_handle_ops(ScrClosure *cb) {
  return scr_box_get_ref(cb->caps[1]);
}

/* The step's handle, borrowed: scr_box_get_ref answers +1, and the box
 * keeps the handle alive. */
static void *scr_handle_step_handle(ScrClosure *cb) {
  void *h = scr_box_get_ref(cb->caps[0]);
  scr_handle_step_handle_ops(cb)->release(h);
  return h;
}

static const ScrDynHandleTransform *scr_handle_step_ops(ScrClosure *cb) {
  return scr_handle_step_handle_ops(cb)->transform;
}

static void scr_handle_step_transform(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  /* A throwing update() leaves the exception pending: it throws out of
   * the write, as Node's _transform does. */
  ScrBytes *out = scr_handle_step_ops(cb)->update(scr_handle_step_handle(cb), chunk);
  if (out) scr_stream_transform_done(s, NULL, out, NULL);
}

static void scr_handle_step_flush(ScrClosure *cb, ScrStream *s) {
  ScrBytes *out = scr_handle_step_ops(cb)->final(scr_handle_step_handle(cb));
  scr_stream_flush_done(s, out ? NULL : scr_stream_take_error(), out, NULL);
}

static void scr_handle_step_destroy(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)cb;
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
}

static ScrClosure *scr_handle_step(const ScrDynHandleOps *ops, void *h) {
  ScrClosure *step = scr_closure_new(NULL, 2);
  step->caps[0] = scr_box_new_obj(ops->retain, ops->release, ops->transform->trace);
  scr_box_set_ref(step->caps[0], ops->retain(h));
  step->caps[1] = scr_box_new_obj(scr_handle_ops_retain, scr_handle_ops_release, NULL);
  scr_box_set_ref(step->caps[1], (void *)ops);
  return step;
}

/* The Transform of handle h (+1), built on first use. */
static ScrStream *scr_handle_transform(const ScrDynHandleOps *ops, void *h) {
  const ScrDynHandleTransform *t = ops->transform;
  ScrStream *s = t->stream(h);
  if (!s) {
    s = scr_stream_new_transform(-1, -1, true, true, true, true, true,
                                 scr_handle_step(ops, h), scr_handle_step_transform,
                                 scr_handle_step(ops, h), scr_handle_step_flush,
                                 scr_handle_step(ops, h), scr_handle_step_destroy);
    s->cls = ops->cls;
    t->set_stream(h, s, scr_stream_release_v);
  }
  return scr_stream_retain(s);
}

/* The native stream of a checked-dynamic Transform handle (+1), or NULL
 * when the value is not one. */
ScrStream *scr_stream_of_handle(const ScrDyn *value) {
  if (value->kind != SCR_DYN_HANDLE) return NULL;
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(value);
  return ops->transform ? scr_handle_transform(ops, value->v.handle.ptr) : NULL;
}

/* A boxed native stream (+1), or NULL for any other value. */
static ScrStream *scr_stream_boxed(const ScrDyn *value) {
  if (value->kind != SCR_DYN_TYPED_REF || value->v.typed_ref.type_key_len <= 7 ||
      memcmp(value->v.typed_ref.type_key, "object:", 7) != 0)
    return NULL;
  ScrStream *stream = scr_dyn_typed_ref_unbox(value);
  const ScrVt *vt = scr_stream_vt_of(stream);
  if (vt && ((vt->pre >= scr_readable_vt.pre && vt->pre <= scr_readable_vt.post) ||
             (vt->pre >= scr_writable_vt.pre && vt->pre <= scr_writable_vt.post)))
    return stream;
  value->v.typed_ref.release(stream);
  return NULL;
}

/* The native readable stream behind a checked-dynamic value (+1): a
 * boxed stream or a Cipheriv/Decipheriv handle's Transform, or NULL. */
ScrStream *scr_stream_native_readable_of_dyn(const ScrDyn *value) {
  ScrStream *s = scr_stream_of_handle(value);
  if (!s) s = scr_stream_boxed(value);
  if (s && !s->st->has_r) {
    scr_stream_release(s);
    return NULL;
  }
  return s;
}

/* stream.handleStream: the stream of a value typed as a stream handle
 * class (a Cipheriv or Decipheriv), +1. A value of that type can also be
 * the stream itself, boxed (the stream addAbortSignal answers). */
ScrStream *scr_stream_handle(const ScrDyn *value) {
  ScrStream *stream = scr_stream_of_handle(value);
  if (!stream) stream = scr_stream_boxed(value);
  if (stream) return stream;
  static const char message[] = "Stream use of a value that is not a native stream has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static ScrStream *scr_stream_view_receiver(const ScrDyn *value) {
  ScrStream *stream = scr_stream_of_handle(value);
  if (!stream) stream = scr_stream_boxed(value);
  if (stream) return stream;
  scr_dyn_arg_type_fail("destination", "an instance of Stream", value);
  return NULL;
}

/* The members a native stream answers to checked-dynamic calls. */
static const char *const scr_stream_dyn_methods[] = {
  "on", "once", "addListener", "prependListener", "prependOnceListener",
  "off", "removeListener", "removeAllListeners", "listenerCount", "eventNames", "pipe",
  "unpipe", "read", "push", "unshift", "pause", "resume", "isPaused", "setEncoding", "write",
  "end", "destroy", "cork", "uncork", "setDefaultEncoding",
};

/* An event name argument: a string, +1; other values throw the "not
 * supported yet" Error. */
static ScrStr *scr_stream_dyn_event_name(const ScrDyn *value) {
  if (value->kind == SCR_DYN_STR) return scr_str_retain(value->v.str);
  static const char message[] = "event names other than strings on a native stream are not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

/* push(chunk, encoding): a string with an encoding pushes the string's
 * bytes in that encoding, undefined pushes an empty chunk outside object
 * mode, and other chunks push as push(chunk) does. */
static ScrDyn *scr_stream_dyn_push(ScrStream *stream, ScrDyn *const *args, size_t argc) {
  ScrDyn *chunk = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *encoding = argc > 1 ? args[1] : scr_dyn_undefined();
  if (chunk->kind == SCR_DYN_STR && encoding->kind == SCR_DYN_STR) {
    ScrStr *canonical = scr_bytes_normalize_encoding(encoding->v.str);
    if (!canonical) return NULL;
    bool more = scr_stream_push_str_enc(stream, chunk->v.str, canonical);
    scr_str_release(canonical);
    return scr_dyn_new_bool(more);
  }
  if (chunk->kind == SCR_DYN_UNDEF && !(stream->st->has_r && stream->st->r.object_entries)) {
    ScrStr *empty = scr_str_new("", 0);
    bool more = scr_stream_push_str(stream, empty);
    scr_str_release(empty);
    return scr_dyn_new_bool(more);
  }
  bool more = scr_stream_push_dyn(stream, chunk);
  return scr_exc_pending() ? NULL : scr_dyn_new_bool(more);
}

/* unshift(chunk[, encoding]): a byte-mode stream takes a string chunk with
 * an encoding as the bytes Buffer.from(chunk, encoding) holds, as Node's
 * readableAddChunkUnshift converts it; an unknown encoding throws
 * ERR_UNKNOWN_ENCODING. Answers whether the stream takes more data
 * afterwards, Node's canPushMore. */
static ScrDyn *scr_stream_dyn_unshift(ScrStream *stream, ScrDyn *const *args, size_t argc) {
  ScrDyn *chunk = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *encoding = argc > 1 ? args[1] : scr_dyn_undefined();
  if (chunk->kind == SCR_DYN_STR && encoding->kind == SCR_DYN_STR &&
      !(stream->st->has_r && stream->st->r.object_entries)) {
    ScrStr *canonical = scr_bytes_normalize_encoding(encoding->v.str);
    if (!canonical) return NULL;
    ScrBytes *b = scr_stream_buffer(scr_bytes_from_str(chunk->v.str, canonical));
    scr_str_release(canonical);
    scr_stream_unshift(stream, b);
    scr_bytes_release(b);
  } else {
    scr_stream_unshift_dyn(stream, chunk);
  }
  if (scr_exc_pending()) return NULL;
  ScrStreamState *st = stream->st;
  bool more = chunk->kind != SCR_DYN_NULL && st->has_r && !st->destroyed && !st->errored &&
    !st->r.ended && (st->r.length < st->r.hwm || st->r.length == 0);
  return scr_dyn_new_bool(more);
}

/* eventNames(): the stream's event names as a string array, +1. */
static ScrDyn *scr_stream_dyn_event_names(ScrStream *stream) {
  ScrArr *names = scr_emitter_event_names((ScrEmitter *)stream);
  ScrDyn *result = scr_dyn_new_arr();
  double length = scr_arr_len(names);
  for (double i = 0; i < length; i++) {
    ScrStr *name = scr_arr_get_ref(names, i);
    scr_dyn_arr_push(result, scr_dyn_new_str(name));
    scr_str_release(name);
  }
  scr_arr_release(names);
  return result;
}

/* A checked-dynamic call of one of a native stream's members (borrowed
 * stream): the result, +1, with `this` results answering `self`, or the
 * current `this` when self is NULL. */
static ScrDyn *scr_stream_dyn_call(ScrStream *stream, ScrDyn *self, const char *method,
                                   ScrDyn *const *args, size_t argc) {
  ScrDyn *result = NULL;
  ScrDyn *first = argc ? args[0] : scr_dyn_undefined();
  if (!strcmp(method, "on") || !strcmp(method, "once") || !strcmp(method, "addListener") ||
      !strcmp(method, "prependListener") || !strcmp(method, "prependOnceListener")) {
    if (first->kind != SCR_DYN_STR) scr_dyn_arg_type_fail("event", "of type string", first);
    else {
      ScrStream *registered = scr_stream_on_dyn(stream, first->v.str,
          argc > 1 ? args[1] : scr_dyn_undefined(),
          !strcmp(method, "once") || !strcmp(method, "prependOnceListener"),
          !strncmp(method, "prepend", 7));
      scr_stream_release(registered);
    }
  } else if (!strcmp(method, "off") || !strcmp(method, "removeListener")) {
    if (first->kind != SCR_DYN_STR) scr_dyn_arg_type_fail("event", "of type string", first);
    else {
      ScrEmitter *registered = scr_emitter_off_dyn((ScrEmitter *)stream, first->v.str,
          argc > 1 ? args[1] : scr_dyn_undefined());
      scr_emitter_release(registered);
    }
  } else if (!strcmp(method, "removeAllListeners")) {
    bool all = first->kind == SCR_DYN_UNDEF;
    ScrStr *name = all ? scr_str_new("", 0) : scr_stream_dyn_event_name(first);
    if (name) {
      scr_emitter_release(scr_emitter_remove_all((ScrEmitter *)stream, name, all));
      scr_str_release(name);
    }
  } else if (!strcmp(method, "listenerCount")) {
    ScrStr *name = scr_stream_dyn_event_name(first);
    if (name) {
      ScrDyn *only = argc > 1 ? args[1] : scr_dyn_undefined();
      double count = only->kind == SCR_DYN_UNDEF || only->kind == SCR_DYN_NULL
        ? scr_emitter_listener_count((ScrEmitter *)stream, name)
        : only->kind == SCR_DYN_FUNC ? scr_emitter_listener_count_dyn((ScrEmitter *)stream, name, only) : 0;
      scr_str_release(name);
      if (!scr_exc_pending()) result = scr_dyn_new_num(count);
    }
  } else if (!strcmp(method, "eventNames")) result = scr_stream_dyn_event_names(stream);
  else if (!strcmp(method, "push")) result = scr_stream_dyn_push(stream, args, argc);
  else if (!strcmp(method, "unshift")) result = scr_stream_dyn_unshift(stream, args, argc);
  else if (!strcmp(method, "setDefaultEncoding")) {
    ScrStream *returned = scr_stream_set_default_encoding(stream, first);
    if (returned) scr_stream_release(returned);
  } else if (!strcmp(method, "pipe") || !strcmp(method, "unpipe")) {
    ScrStream *destination = first->kind == SCR_DYN_UNDEF && !strcmp(method, "unpipe")
      ? NULL : scr_stream_view_receiver(first);
    if (!scr_exc_pending()) {
      bool end = true;
      if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF) {
        ScrDyn *option = scr_dyn_obj_read(args[1], "end", 3);
        end = option->kind == SCR_DYN_UNDEF || scr_dyn_truthy(option);
        scr_dyn_release(option);
      }
      /* scr_stream_pipe_general: a JavaScript caller can pipe into the
       * converted process.stdout / process.stderr, which a pipe never ends. */
      ScrStream *returned = !strcmp(method, "pipe")
          ? scr_stream_pipe_general(stream, destination, end) : scr_stream_unpipe(stream, destination);
      scr_stream_release(returned);
      if (!strcmp(method, "pipe") && !scr_exc_pending()) result = scr_dyn_retain(first);
    }
    scr_stream_release(destination);
  } else if (!strcmp(method, "read")) result = scr_stream_read_dyn(stream, first);
  else if (!strcmp(method, "pause") || !strcmp(method, "resume")) {
    ScrStream *returned = !strcmp(method, "pause") ? scr_stream_pause(stream) : scr_stream_resume(stream);
    scr_stream_release(returned);
  } else if (!strcmp(method, "isPaused")) result = scr_dyn_new_bool(scr_stream_is_paused(stream));
  else if (!strcmp(method, "setEncoding")) {
    if (first->kind != SCR_DYN_STR) scr_dyn_arg_type_fail("encoding", "of type string", first);
    else scr_stream_release(scr_stream_set_encoding(stream, first->v.str));
  } else if (!strcmp(method, "write")) {
    if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF) {
      static const char message[] = "Native stream method values with write encodings or callbacks have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    } else result = scr_dyn_new_bool(scr_stream_write_dyn(stream, first, NULL));
  } else if (!strcmp(method, "close")) {
    /* fs.ReadStream / fs.WriteStream close() */
    if (argc > 0 && first->kind != SCR_DYN_UNDEF) {
      static const char message[] = "Native stream method values with close callbacks have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    } else {
      stream->st->native_ops->close(stream);
    }
  } else if (!strcmp(method, "end")) {
    if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF) {
      static const char message[] = "Native stream method values with end encodings or callbacks have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    } else if (first->kind == SCR_DYN_UNDEF || first->kind == SCR_DYN_NULL) {
      scr_stream_release(scr_stream_end(stream, NULL, NULL, NULL));
    } else if (first->kind == SCR_DYN_STR) {
      scr_stream_release(scr_stream_end(stream, NULL, first->v.str, NULL));
    } else if (first->kind == SCR_DYN_BYTES) {
      scr_stream_release(scr_stream_end(stream, first->v.bytes, NULL, NULL));
    } else scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", first);
  } else if (!strcmp(method, "destroy")) {
    ScrError *error = first->kind == SCR_DYN_UNDEF || first->kind == SCR_DYN_NULL ? NULL : scr_error_from_dyn(first);
    scr_stream_release(scr_stream_destroy(stream, error));
    scr_error_release(error);
  } else if (!strcmp(method, "cork")) scr_stream_cork(stream);
  else if (!strcmp(method, "uncork")) scr_stream_uncork(stream);
  if (!result && !scr_exc_pending()) result = self ? scr_dyn_retain(self) : scr_dyn_this_get();
  return result;
}

static ScrDyn *scr_stream_view_call(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrStream *stream = scr_box_get_ref(cb->caps[0]);
  ScrStr *name = scr_box_get_ref(cb->caps[1]);
  ScrDyn *result = scr_stream_dyn_call(stream, NULL, name->data, args, argc);
  scr_str_release(name);
  scr_stream_release(stream);
  return result;
}

/* ScrHandleStreamHooks.call: a member a native stream answers to
 * checked-dynamic calls, on the handle's Transform. Members that answer
 * the stream answer `self`. */
static bool scr_handle_stream_call(const ScrDynHandleOps *ops, void *h, ScrDyn *self,
                                   const char *method, ScrDyn *const *args, size_t argc,
                                   ScrDyn **result) {
  for (size_t i = 0; i < sizeof scr_stream_dyn_methods / sizeof *scr_stream_dyn_methods; i++) {
    if (strcmp(method, scr_stream_dyn_methods[i]) != 0) continue;
    ScrStream *stream = scr_handle_transform(ops, h);
    *result = scr_stream_dyn_call(stream, self, method, args, argc);
    scr_stream_release(stream);
    return true;
  }
  return false;
}

/* The stream properties a checked-dynamic read answers. */
static const char *const scr_stream_dyn_properties[] = {
  "readable", "readableEnded", "readableLength", "readableHighWaterMark",
  "writable", "writableEnded", "writableFinished", "writableLength", "writableHighWaterMark",
  "writableNeedDrain", "destroyed", "closed",
};

static ScrDyn *scr_stream_dyn_property(ScrStream *stream, const char *name) {
  double value = scr_stream_prop(stream, name);
  bool number = strstr(name, "Length") || strstr(name, "HighWaterMark");
  return number ? scr_dyn_new_num(value) : scr_dyn_new_bool(value != 0);
}

/* ScrHandleStreamHooks.get: a stream property of the handle's Transform. */
static ScrDyn *scr_handle_stream_get(const ScrDynHandleOps *ops, void *h, const char *key,
                                     size_t key_len) {
  for (size_t i = 0; i < sizeof scr_stream_dyn_properties / sizeof *scr_stream_dyn_properties; i++) {
    const char *name = scr_stream_dyn_properties[i];
    if (strlen(name) != key_len || memcmp(name, key, key_len) != 0) continue;
    ScrStream *stream = scr_handle_transform(ops, h);
    ScrDyn *value = scr_stream_dyn_property(stream, name);
    scr_stream_release(stream);
    return value;
  }
  return NULL;
}

static const ScrHandleStreamHooks scr_handle_stream_hooks_impl = {
  scr_handle_stream_call,
  scr_handle_stream_get,
};

ScrDyn *scr_stream_dyn_view(ScrStream *stream) {
  ScrDyn *view = scr_dyn_new_obj();
  ScrDyn *prototype = scr_dyn_new_obj();
  const char *const *methods = scr_stream_dyn_methods;
  for (size_t i = 0; i < sizeof scr_stream_dyn_methods / sizeof *scr_stream_dyn_methods; i++) {
    ScrClosure *cb = scr_closure_new((void *)scr_stream_view_call, 2);
    cb->caps[0] = scr_box_new_obj(scr_stream_retain_v, scr_stream_release_v, scr_stream_trace);
    cb->caps[1] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(cb->caps[0], scr_stream_retain(stream));
    scr_box_set_ref(cb->caps[1], scr_str_new(methods[i], strlen(methods[i])));
    scr_dyn_obj_set(prototype, methods[i], strlen(methods[i]),
        scr_dyn_new_func(cb, scr_stream_view_call, 0, "native stream method", methods[i]));
  }
  for (size_t i = 0; i < sizeof scr_stream_dyn_properties / sizeof *scr_stream_dyn_properties; i++) {
    const char *name = scr_stream_dyn_properties[i];
    scr_dyn_obj_set(view, name, strlen(name), scr_stream_dyn_property(stream, name));
  }
  if (stream->st->has_r) {
    int flowing = stream->st->r.flowing;
    scr_dyn_obj_set(view, "readableFlowing", 15,
        flowing < 0 ? scr_dyn_new_null() : scr_dyn_new_bool(flowing == 1));
  }
  if (stream->st->native && stream->st->native_ops && stream->st->native_ops->view) {
    ScrClosure *cb = scr_closure_new((void *)scr_stream_view_call, 2);
    cb->caps[0] = scr_box_new_obj(scr_stream_retain_v, scr_stream_release_v, scr_stream_trace);
    cb->caps[1] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(cb->caps[0], scr_stream_retain(stream));
    scr_box_set_ref(cb->caps[1], scr_str_new("close", 5));
    scr_dyn_obj_set(prototype, "close", 5,
        scr_dyn_new_func(cb, scr_stream_view_call, 0, "native stream method", "close"));
    stream->st->native_ops->view(stream, view);
  }
  ScrDyn *attached = scr_dyn_set_prototype(view, prototype);
  scr_dyn_release(attached);
  scr_dyn_release(prototype);
  return view;
}

/* ── node:crypto Hash and Hmac values as streams ─────────────────────
 * Node's Hash and Hmac are Transforms. A value used as a stream gets one
 * native Transform, created on first use and owned by the value. The
 * steps share a box that holds the value without a reference; releasing
 * the box's payload detaches the value from the stream, whichever of the
 * two goes first. A pipe destination or pipeline stage holds the
 * value until the stream flushes or is destroyed, so a stream that only a
 * pipe still references keeps its value. */
static void *scr_hash_stream_box_retain(void *p) { return p; }

/* The value, borrowed: the box's retain is a no-op. */
static ScrCryptoHash *scr_hash_stream_value(ScrClosure *cb) {
  return scr_box_get_ref(cb->caps[0]);
}

static void scr_hash_stream_transform(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  ScrCryptoHash *hash = scr_hash_stream_value(cb);
  bool ok = hash && scr_crypto_hash_stream_write(hash, chunk);
  scr_stream_transform_done(s, ok ? NULL : scr_stream_mkerr("ERR_CRYPTO_HASH_UPDATE_FAILED", "Hash update failed"),
                            NULL, NULL);
}

static void scr_hash_stream_flush(ScrClosure *cb, ScrStream *s) {
  ScrCryptoHash *hash = scr_hash_stream_value(cb);
  ScrBytes *digest = hash ? scr_crypto_hash_stream_flush(hash) : NULL;
  /* Releasing the hold may free the value, which releases this stream. */
  scr_stream_retain(s);
  if (hash) scr_crypto_hash_stream_unhold(hash);
  scr_stream_flush_done(s, NULL, digest, NULL);
  scr_stream_release(s);
}

static void scr_hash_stream_destroy(ScrClosure *cb, ScrStream *s, ScrError *err) {
  ScrCryptoHash *hash = scr_hash_stream_value(cb);
  scr_stream_retain(s);
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
  if (hash) {
    /* The scheduled 'close' keeps the stream until it fires. */
    scr_crypto_hash_retain(hash);
    scr_crypto_hash_stream_close(hash);
    scr_crypto_hash_stream_unhold(hash);
    scr_crypto_hash_release(hash);
  }
  scr_stream_release(s);
}

static ScrClosure *scr_hash_stream_step(ScrBox *box) {
  ScrClosure *step = scr_closure_new(NULL, 1);
  step->caps[0] = scr_box_retain(box);
  return step;
}

ScrStream *scr_crypto_hash_stream(ScrCryptoHash *hash) {
  ScrStream *s = scr_crypto_hash_stream_get(hash);
  if (s) return scr_stream_retain(s);
  if (!scr_crypto_hash_stream_usable(hash)) return NULL;
  ScrBox *box = scr_box_new_obj(scr_hash_stream_box_retain, scr_crypto_hash_stream_detach, NULL);
  scr_box_set_ref(box, hash);
  s = scr_stream_new_transform(-1, -1, true, true, true, true, true,
                               scr_hash_stream_step(box), scr_hash_stream_transform,
                               scr_hash_stream_step(box), scr_hash_stream_flush,
                               scr_hash_stream_step(box), scr_hash_stream_destroy);
  s->cls = scr_crypto_hash_is_hmac(hash) ? "Hmac" : "Hash";
  /* The steps keep the box alive as long as the stream. */
  scr_crypto_hash_stream_set(hash, scr_stream_retain(s), scr_stream_release_v, box);
  scr_box_release(box);
  return s;
}

ScrStream *scr_crypto_hash_stream_piped(ScrCryptoHash *hash) {
  ScrStream *s = scr_crypto_hash_stream(hash);
  if (s) scr_crypto_hash_stream_hold(hash);
  return s;
}

/* ── the compiler's general stream representation ─────────────────────
 * NodeJS.ReadableStream / NodeJS.WritableStream slots that also hold other
 * streams compile as this unit's classes; the stdio handles convert into
 * them where they are read or flow. Both entry points sit last in the unit
 * and reference only global symbols and no new constant data, so programs
 * that never convert link the same bytes as before. */

/* destroy() on a bridged child stdin closes the pipe, as Node's does. */
static void scr_stream_child_stdin_destroy(ScrClosure *cb, ScrStream *s, ScrError *err) {
  ScrChildWriter *writer = scr_box_get_ref(cb->caps[0]);
  scr_child_writer_destroy(writer);
  scr_child_writer_release(writer);
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
}

/* A child stdio read (the child.stdioStream libCall): the bridged stream
 * the checked-dynamic ChildProcess view answers for the same key ("stdin",
 * "stdout" or "stderr", passed by the compiled program), so both views
 * share one stream per slot. The stdin stream (the only five-byte key)
 * gains the destroy hook that closes the pipe. +1, or NULL for an unpiped
 * slot or a throw. */
ScrStream *scr_stream_child_stdio(void *child, const char *key, size_t key_len) {
  ScrDyn *handle = scr_dyn_new_handle(child, SCR_DYNH_CHILD);
  ScrDyn *box = scr_dyn_handle_ops_of(handle)->get(child, key, key_len);
  scr_dyn_release(handle);
  if (box == NULL) return NULL;
  ScrStream *stream = box->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_unbox(box) : NULL;
  scr_dyn_release(box);
  if (stream != NULL && key_len == 5 && stream->st->destroy_cb == NULL) {
    ScrChildWriter *writer = scr_child_stdin(child);
    if (writer != NULL) {
      ScrClosure *destroy = scr_closure_new((void *)scr_stream_child_stdin_destroy, 1);
      destroy->caps[0] = scr_box_new_obj(scr_child_writer_retain_v, scr_child_writer_release_v, NULL);
      scr_box_set_ref(destroy->caps[0], writer);
      stream->st->destroy_cb = destroy;
      stream->st->destroy_inv = scr_stream_child_stdin_destroy;
    }
  }
  return stream;
}

/* process.stdout / process.stderr flowing into a Writable slot (the
 * stream.stdioWritable libCall): a Writable whose _write hands each chunk
 * to the descriptor through process.stdout.write's synchronous path and
 * completes at once, so ordering against console output and direct writes
 * is unchanged. The closure keeps the fd as given (1 or 2). Each thread
 * keeps one per descriptor, so every conversion of process.stdout answers
 * the same stream, as Node's process.stdout is one object: listeners,
 * writable state and identity are shared. The cache is released at exit. */
static SCR_TL ScrStream *scr_stream_stdio_writables[2];
static void scr_stream_stdio_write(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  int fd = (int)scr_box_get_f64(cb->caps[0]);
  (void)scr_stdio_write(fd == 2 ? 2 : 1, chunk->data, chunk->len * scr_bytes_elem_size(chunk->elem));
  scr_stream_write_done(s, NULL);
}
static void scr_stream_stdio_writables_free(void) {
  for (int i = 0; i < 2; i++) {
    ScrStream *s = scr_stream_stdio_writables[i];
    scr_stream_stdio_writables[i] = NULL;
    if (s) scr_stream_release(s);
  }
}
ScrStream *scr_stream_stdio_writable(double fd) {
  int i = fd == 2 ? 1 : 0;
  if (scr_stream_stdio_writables[i] == NULL) {
    if (scr_stream_stdio_writables[1 - i] == NULL) scr_atexit(scr_stream_stdio_writables_free);
    ScrClosure *write = scr_closure_new((void *)scr_stream_stdio_write, 1);
    write->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(write->caps[0], i ? 2 : 1);
    scr_stream_stdio_writables[i] = scr_stream_new_writable(-1, true, true, write,
        scr_stream_stdio_write, NULL, NULL, NULL, NULL);
  }
  return scr_stream_retain(scr_stream_stdio_writables[i]);
}

/* readable.pipe() into a Writable slot under the general representation
 * (the readable.pipeGeneral libCall), and pipe() called from JavaScript on
 * a native stream: Node never ends process.stdout or process.stderr from a
 * pipe, so their converted Writable keeps `end` off. */
ScrStream *scr_stream_pipe_general(ScrStream *src, ScrStream *dst, bool end) {
  if (dst == scr_stream_stdio_writables[0] || dst == scr_stream_stdio_writables[1]) end = false;
  return scr_stream_pipe(src, dst, end);
}

/* A pipeline() stage that arrives as a checked-dynamic value (the
 * stream.unboxDyn libCall): a boxed native stream unwraps by identity
 * (+1), a stream handle (a Cipheriv or Decipheriv) answers its stream, and
 * any other value throws the compiled program's not-supported message
 * (Node also takes iterables and functions there). */
ScrStream *scr_stream_unbox_dyn(const ScrDyn *value, const ScrStr *message) {
  ScrStream *stream = scr_stream_of_handle(value);
  if (!stream) stream = scr_stream_boxed(value);
  if (stream) return stream;
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  return NULL;
}

/* Whether a checked-dynamic object's member is of type "object". */
static bool scr_stream_dyn_member_object(const ScrDyn *value, const char *key) {
  ScrDyn *m = scr_dyn_obj_read(value, key, strlen(key));
  if (!m) return false;
  ScrStr *t = scr_dyn_typeof(m);
  bool object = t->len == 6 && memcmp(t->data, "object", 6) == 0;
  scr_str_release(t);
  scr_dyn_release(m);
  return object;
}

/* pipeline.js's isTransformStream for a value that is not a stream: an
 * object whose readable and writable members are both of type "object". */
static bool scr_stream_dyn_transform_like(const ScrDyn *value) {
  if (value->kind == SCR_DYN_HANDLE) return value->v.handle.tag == SCR_DYNH_WEB_TRANSFORM;
  return value->kind == SCR_DYN_OBJ && scr_stream_dyn_member_object(value, "readable") &&
         !scr_exc_pending() && scr_stream_dyn_member_object(value, "writable");
}

/* Whether a checked-dynamic object has a function member `key`. */
static bool scr_stream_dyn_has_method(const ScrDyn *value, const char *key) {
  ScrDyn *m = scr_dyn_obj_read(value, key, strlen(key));
  if (!m) return false;
  bool fn = m->kind == SCR_DYN_FUNC;
  scr_dyn_release(m);
  return fn;
}

/* pipeline.js's isNodeStream and isWebStream for a checked-dynamic value
 * that is not a native stream: a stream-like object or a web stream, which
 * the pipeline would pipe or pump into and has no lowering for. */
static bool scr_stream_dyn_stream_like(const ScrDyn *value) {
  if (value->kind == SCR_DYN_HANDLE) {
    int tag = value->v.handle.tag;
    return tag == SCR_DYNH_WEB_STREAM || tag == SCR_DYNH_WEB_TRANSFORM || tag == SCR_DYNH_WEB_WRITABLE ||
           tag == SCR_DYNH_WS_READABLE;
  }
  if (value->kind != SCR_DYN_OBJ) return false;
  static const char *const state_keys[] = {"_readableState", "_writableState"};
  for (size_t i = 0; i < 2; i++) {
    ScrDyn *v = scr_dyn_obj_read(value, state_keys[i], strlen(state_keys[i]));
    bool set = v && scr_dyn_truthy(v);
    if (v) scr_dyn_release(v);
    if (set) return true;
  }
  bool on = scr_stream_dyn_has_method(value, "on");
  if (on && (scr_stream_dyn_has_method(value, "write") || scr_stream_dyn_has_method(value, "pipe")))
    return true;
  if (scr_stream_dyn_has_method(value, "pipeThrough") &&
      scr_stream_dyn_has_method(value, "getReader") && scr_stream_dyn_has_method(value, "cancel"))
    return true;
  if (scr_stream_dyn_has_method(value, "getWriter") && scr_stream_dyn_has_method(value, "abort"))
    return true;
  return scr_stream_dyn_transform_like(value);
}

/* A checked-dynamic pipeline() stage that the pipeline takes as a stream
 * (the stream.unboxDynStage libCall): a boxed native stream or a stream
 * handle answers its stream (+1). Any other value that is not stream-like
 * or a function takes pipelineImpl's last branch, Duplex.from(stream):
 * an iterable answers a readable Duplex the pipeline uses without piping
 * the previous stage into it, and values Duplex.from rejects throw its
 * ERR_INVALID_ARG_TYPE. Stream-like objects, web streams and functions
 * throw `message` as the not-supported Error. */
ScrStream *scr_stream_unbox_dyn_stage(const ScrDyn *value, const ScrStr *message) {
  ScrStream *stream = scr_stream_of_handle(value);
  if (!stream) stream = scr_stream_boxed(value);
  if (stream) return stream;
  if (value->kind == SCR_DYN_FUNC || scr_stream_dyn_stream_like(value)) {
    if (!scr_exc_pending())
      scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
    return NULL;
  }
  if (scr_exc_pending()) return NULL;
  ScrStream *d = scr_stream_duplex_from_dyn((ScrDyn *)value);
  if (d) d->st->pipeline_body = true;
  return d;
}

/* pipeline.js's first stage: a function is a source function, which the
 * pipeline calls; a value with pipe() and on() methods is a readable node
 * stream, which the stage ladder tests before isIterable; a string, a
 * value with a Symbol.asyncIterator or Symbol.iterator method, or a
 * { readable, writable } pair is an iterable the pipeline pumps into the
 * next stage. */
bool scr_stream_dyn_iterable_source(const ScrDyn *value) {
  ScrStream *stream = scr_stream_of_handle(value);
  if (!stream) stream = scr_stream_boxed(value);
  if (stream) {
    scr_stream_release(stream);
    return false;
  }
  if (value->kind == SCR_DYN_STR || value->kind == SCR_DYN_FUNC) return true;
  if (value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WEB_TRANSFORM) return true;
  if (value->kind == SCR_DYN_OBJ) {
    ScrDyn *pipe = scr_dyn_obj_read(value, "pipe", 4);
    if (!pipe) return false;
    bool streamish = pipe->kind == SCR_DYN_FUNC;
    scr_dyn_release(pipe);
    if (streamish) {
      ScrDyn *on = scr_dyn_obj_read(value, "on", 2);
      if (!on) return false;
      streamish = on->kind == SCR_DYN_FUNC;
      scr_dyn_release(on);
      if (streamish) return false;
    }
    if (scr_stream_dyn_transform_like(value)) return true;
    if (scr_exc_pending()) return false;
  }
  return scr_dyn_iterable_kind(value) > 0;
}

/* Untyped web streams as pipeline stages have no lowering. */
static void scr_stream_throw_web_stage(void) {
  static const char msg[] = "pipeline stages that are untyped web streams are not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
}

/* A native stream returned by an untyped pipeline function, which Node
 * pipes or passes on as the stream: throws the not-supported Error. */
static bool scr_stream_dyn_stage_returned_stream(const ScrDyn *value) {
  ScrStream *stream = scr_stream_of_handle(value);
  if (!stream) stream = scr_stream_boxed(value);
  if (!stream) return false;
  scr_stream_release(stream);
  static const char msg[] = "pipeline function stages that return a stream are not supported yet";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
  return true;
}

/* Node's ERR_INVALID_RETURN_VALUE TypeError: "Expected <expected> to be
 * returned from the "<name>" function but got <the value's type>." */
static void scr_stream_throw_invalid_return(const char *expected, const char *name,
                                           const ScrDyn *got) {
  char detail[160];
  const char *type = scr_dyn_specific_type(got, detail, sizeof detail);
  char msg[384];
  int n = snprintf(msg, sizeof msg, "Expected %s to be returned from the \"%s\" function but got %s.",
                   expected, name, type);
  if (n < 0) n = 0;
  if ((size_t)n >= sizeof msg) n = (int)sizeof msg - 1;
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_RETURN_VALUE");
}

/* An untyped pipeline function stage's result before the last stage
 * (pipelineImpl's `isIterable(ret, true)` check): an async iterable
 * answers itself (+1); other values throw ERR_INVALID_RETURN_VALUE naming
 * the stage, as `label` ("transform[i]") does. */
ScrDyn *scr_stream_dyn_transform_result(const ScrDyn *value, const ScrStr *label) {
  if (scr_stream_dyn_stage_returned_stream(value)) return NULL;
  int kind = scr_dyn_iterable_kind(value);
  if (kind < 0) return NULL;
  if (kind != 2) {
    scr_stream_throw_invalid_return("AsyncIterable", label->data, value);
    return NULL;
  }
  return scr_dyn_retain((ScrDyn *)value);
}

/* The value a checked-dynamic first stage pumps (pipelineImpl's i === 0
 * branch): for `returned`, a source function's result, which must be
 * iterable; otherwise a { readable, writable } pair's readable side, or
 * the value itself. +1, or NULL with an exception pending. */
ScrDyn *scr_stream_dyn_source_value(const ScrDyn *value, bool returned) {
  if (!returned) {
    if (value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WEB_TRANSFORM) {
      scr_stream_throw_web_stage();
      return NULL;
    }
    if (scr_stream_dyn_transform_like(value)) return scr_dyn_obj_read(value, "readable", 8);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain((ScrDyn *)value);
  }
  if (scr_stream_dyn_stage_returned_stream(value)) return NULL;
  int kind = scr_dyn_iterable_kind(value);
  if (kind < 0) return NULL;
  if (kind == 0) {
    scr_stream_throw_invalid_return("Iterable, AsyncIterable or Stream", "source", value);
    return NULL;
  }
  return scr_dyn_retain((ScrDyn *)value);
}
