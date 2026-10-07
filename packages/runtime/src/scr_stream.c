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

/* ── state ────────────────────────────────────────────────────────────── */

typedef struct ScrWEntry {
  ScrBytes *chunk; /* owned */
  ScrClosure *cb;  /* owned or NULL (the user's write(chunk, cb) callback) */
} ScrWEntry;

struct ScrStreamState {
  bool has_r, has_w;
  bool passthrough;  /* identity transform (PassThrough) */
  bool is_transform; /* the writable side routes through transform/flush */
  bool allow_half_open;
  bool auto_destroy, emit_close;

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
    bool need_readable, emitted_readable, readable_listening;
    bool resume_scheduled, maybe_more_scheduled;
    bool encoded;       /* string-chunk mode (decoder active) */
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
    /* The parked for-await next() promise (at most one — the loop awaits
     * each chunk before asking again). next_dyn picks the resolution
     * shape: a dyn boxed by tag (the JS lane), or bytes. */
    ScrPromise *next_waiter;
    bool next_dyn;
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
    bool ending, finished, prefinished, final_called, finish_scheduled;
    ScrClosure *inflight_cb; /* owned or NULL */
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

  /* destroy */
  ScrClosure *destroy_cb;
  ScrStreamErrInv destroy_inv;

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

/* Readable-buffer entry accessors: bytes chunks, or strings once an
 * encoding is set (lengths then count JS string units, Node's encoded
 * accounting). */
static size_t scr_stream_entry_len(const ScrStreamState *st, void *e) {
  if (st->r.object_entries) return 1; /* objectMode-style accounting */
  return st->r.encoded ? (size_t)scr_str_utf16_len((ScrStr *)e) : ((ScrBytes *)e)->len;
}

static void scr_stream_entry_release(const ScrStreamState *st, void *e) {
  if (st->r.encoded) scr_str_release((ScrStr *)e);
  else scr_bytes_release((ScrBytes *)e);
}

static void scr_stream_state_drop(ScrStreamState *st, bool gc) {
  if (!st) return;
  if (st->errored) scr_error_release(st->errored);
  for (size_t i = 0; i < st->r.n; i++) scr_stream_entry_release(st, st->r.buf[i]);
  free(st->r.buf);
  if (st->r.enc) scr_str_release(st->r.enc);
  if (st->r.push_enc) scr_str_release(st->r.push_enc);
  if (!gc && st->r.next_waiter) scr_promise_release(st->r.next_waiter);
  if (!gc) {
    if (st->r.read_cb) scr_closure_release(st->r.read_cb);
    if (st->w.write_cb) scr_closure_release(st->w.write_cb);
    if (st->w.final_cb) scr_closure_release(st->w.final_cb);
    if (st->w.inflight_cb) scr_closure_release(st->w.inflight_cb);
    if (st->transform_cb) scr_closure_release(st->transform_cb);
    if (st->flush_cb) scr_closure_release(st->flush_cb);
    if (st->destroy_cb) scr_closure_release(st->destroy_cb);
    for (size_t i = 0; i < st->w.end_cbs_n; i++) scr_closure_release(st->w.end_cbs[i]);
    for (size_t i = 0; i < st->fin.n; i++) scr_closure_release(st->fin.cb[i]);
    for (size_t i = 0; i < st->pipes.n; i++) scr_stream_release(st->pipes.dst[i]);
    for (size_t i = 0; i < st->drain_srcs.n; i++) scr_stream_release(st->drain_srcs.src[i]);
  }
  for (size_t i = st->w.head; i < st->w.n; i++) {
    scr_bytes_release(st->w.q[i].chunk);
    if (!gc && st->w.q[i].cb) scr_closure_release(st->w.q[i].cb);
  }
  free(st->w.q);
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
  if (st->r.next_waiter) visit(st->r.next_waiter, ctx);
  if (st->r.read_cb) visit(st->r.read_cb, ctx);
  if (st->w.write_cb) visit(st->w.write_cb, ctx);
  if (st->w.final_cb) visit(st->w.final_cb, ctx);
  if (st->w.inflight_cb) visit(st->w.inflight_cb, ctx);
  if (st->transform_cb) visit(st->transform_cb, ctx);
  if (st->flush_cb) visit(st->flush_cb, ctx);
  if (st->destroy_cb) visit(st->destroy_cb, ctx);
  for (size_t i = 0; i < st->w.end_cbs_n; i++) visit(st->w.end_cbs[i], ctx);
  for (size_t i = 0; i < st->fin.n; i++) visit(st->fin.cb[i], ctx);
  for (size_t i = st->w.head; i < st->w.n; i++) {
    if (st->w.q[i].cb) visit(st->w.q[i].cb, ctx);
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
    scr_cyc_on_dead(s);
    scr_emitter_reg_drop(s->reg);
    scr_stream_state_drop(s->st, false);
    scr_obj_free_note();
    scr_cyc_free(s);
  } else {
    scr_cyc_on_release(s);
  }
}

ScrStream *scr_stream_retain(ScrStream *s) {
  if (s && s->rc != SIZE_MAX) {
    s->rc++;
    scr_cyc_mark_live(s);
  }
  return s;
}

void scr_stream_release(ScrStream *s) {
  if (!s || s->rc == SIZE_MAX) return;
  s->vt->release(s);
}

void *scr_stream_retain_v(void *s) { return scr_stream_retain(s); }
void scr_stream_release_v(void *s) { scr_stream_release(s); }

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
  SCR_ST_NEXT_EOF,      /* a parked for-await's EOF sentinel, AFTER 'end' */
  SCR_ST_FIN,           /* notify finished()/pipeline watchers (already-
                         * terminal registration) */
} ScrStreamTickOp;

typedef struct ScrStreamTick {
  ScrStream *s; /* owned */
  ScrStreamTickOp op;
  ScrError *err;   /* owned or NULL (SCR_ST_ERROR) */
  ScrClosure *cb;  /* owned or NULL (SCR_ST_AFTER_WRITE / SCR_ST_WCB_ERR) */
  struct ScrStreamTick *next;
} ScrStreamTick;

static SCR_TL ScrStreamTick *scr_st_head = NULL;
static SCR_TL ScrStreamTick *scr_st_tail = NULL;

static void scr_stream_dispatch_one(void);

static void scr_st_tick(ScrStream *s, ScrStreamTickOp op, ScrError *err /*moves*/,
                        ScrClosure *cb /*moves*/) {
  ScrStreamTick *t = calloc(1, sizeof *t);
  if (!t) scr_stream_oom();
  t->s = scr_stream_retain(s);
  t->op = op;
  t->err = err;
  t->cb = cb;
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

static bool scr_stream_emit0(ScrStream *s, const char *name) {
  ScrStr *n = scr_str_new(name, strlen(name));
  bool had = scr_emitter_emit((ScrEmitter *)s, n);
  scr_str_release(n);
  return had;
}

static void scr_stream_emit_stream(ScrStream *s, const char *name, ScrStream *payload) {
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_emitter_emit((ScrEmitter *)s, n, payload);
  scr_str_release(n);
}

/* 'error': unhandled throws the payload (Node's crash), via the emitter's
 * error contract. Borrows err. */
static void scr_stream_emit_error(ScrStream *s, ScrError *err) {
  ScrStr *n = scr_str_new("error", 5);
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

/* ── forward decls ────────────────────────────────────────────────────── */

static void scr_stream_flow(ScrStream *s);
static void scr_stream_emit_readable_now(ScrStream *s);
static void scr_stream_maybe_read_more(ScrStream *s);
static void scr_stream_finish_maybe(ScrStream *s);
static void scr_stream_clear_buffer(ScrStream *s);
static void scr_stream_do_destroy(ScrStream *s, ScrError *err /*borrowed*/);
static void scr_stream_notify_finished(ScrStream *s);
static void *scr_stream_read_n(ScrStream *s, double size);
static void scr_stream_settle_next(ScrStream *s);
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

static void scr_stream_rbuf_push(ScrStreamState *st, void *chunk /*moves*/, bool front) {
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
 * buffer head as one +1 Buffer / string. */
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
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)n);
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

/* emit('data', chunk) + pipe delivery. Borrows chunk (a Buffer, or a
 * string once encoded). The emit ABI carries BOTH payload slots — the
 * bytes chunk and the string chunk, exactly one non-NULL — and the
 * compiler's stream-data listener thunks dispatch on which (typed
 * listeners unwrap their declared side; dyn listeners box by tag). */
static void scr_stream_emit_data(ScrStream *s, void *chunk) {
  ScrStreamState *st = s->st;
  ScrBytes *b = st->r.encoded ? NULL : (ScrBytes *)chunk;
  ScrStr *str = st->r.encoded ? (ScrStr *)chunk : NULL;
  ScrStr *n = scr_str_new("data", 4);
  scr_emitter_emit((ScrEmitter *)s, n, b, str);
  scr_str_release(n);
  if (scr_exc_pending()) return;
  /* pipe delivery, with backpressure: a full destination pauses us until
   * its 'drain'. Encoded sources write the string (utf8 bytes at the
   * destination — Node writes the decoded string through). */
  for (size_t i = 0; i < st->pipes.n;) {
    ScrStream *dst = st->pipes.dst[i];
    if (dst->st->destroyed) {
      /* Node's pipe cleanup: a destroyed destination unhooks (the
       * onerror/onclose → unpipe path) and pauses the source — writing
       * after destroy would drop the error silently and spin an infinite
       * synchronous flow over an endless source. */
      scr_stream_release(scr_stream_unpipe(s, dst));
      if (scr_exc_pending()) return;
      continue; /* the pipes array shifted down over i */
    }
    bool ok = b ? scr_stream_write(dst, b, NULL) : scr_stream_write_str(dst, str, NULL);
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
  if (st->r.read_cb == NULL && st->r.object_entries) {
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
     * initial sync flag (Node's Transform._read ran) */
    st->r.in_read_sync = false;
    return;
  }
  st->r.reading = true;
  st->r.in_read_sync = true;
  st->r.read_inv(st->r.read_cb, s, (double)st->r.hwm);
  st->r.in_read_sync = false;
}

/* readableAddChunk. Borrows chunk (retains its own ref). Returns the
 * below-hwm answer. Encoded streams decode the bytes through the
 * StringDecoder first (Node decodes at push); an empty decode (a partial
 * multi-byte tail held pending) adds nothing but still clears the
 * reading flag. */
static bool scr_stream_add_chunk(ScrStream *s, ScrBytes *chunk, bool front) {
  ScrStreamState *st = s->st;
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
    entry = scr_bytes_retain(chunk);
    entry_len = chunk->len;
  }
  if (entry_len > 0 &&
      st->r.flowing == 1 && st->r.length == 0 && !st->r.in_read_sync && !front &&
      (scr_emitter_has((ScrEmitter *)s, "data") || st->pipes.n > 0)) {
    /* the direct-emit fast path: flowing, empty buffer, async push */
    if (st->r.emitted_readable) st->r.emitted_readable = false;
    scr_stream_emit_data(s, entry);
    scr_stream_entry_release(st, entry);
    if (scr_exc_pending()) return false;
  } else {
    scr_stream_rbuf_push(st, entry, front);
    if (st->r.need_readable) scr_stream_emit_readable_nt(s);
  }
  if (!front) scr_stream_maybe_read_more(s);
  scr_stream_settle_next(s); /* a parked for-await consumes buffered content */
  return !st->r.ended && (st->r.length < st->r.hwm || st->r.length == 0);
}

static void scr_stream_maybe_read_more(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->r.maybe_more_scheduled || st->r.reading || st->r.ended || st->destroyed) return;
  if (!(st->r.length < st->r.hwm && (st->r.flowing == 1 || st->r.need_readable))) return;
  st->r.maybe_more_scheduled = true;
  scr_st_tick(s, SCR_ST_MAYBE_MORE, NULL, NULL);
}

/* howMuchToRead + fromList + the doRead discipline: readable.read().
 * Answers a +1 Buffer — or a +1 string once encoded (lengths and the
 * size argument then count JS string units, Node's encoded accounting). */
static void *scr_stream_read_n(ScrStream *s, double size) {
  ScrStreamState *st = s->st;
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
    /* objectMode-style: one whole entry per read, whatever n says */
    want = st->r.length > 0 ? 1 : 0;
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
  if (st->r.ended || st->r.reading || st->destroyed || st->errored) do_read = false;
  if (do_read) {
    if (st->r.length == 0) st->r.need_readable = true;
    scr_stream_call_read(s);
    if (scr_exc_pending()) return NULL;
    /* a synchronous push may have refilled */
    if (!st->r.reading) {
      if (st->r.object_entries) {
        want = st->r.length > 0 ? 1 : 0;
      } else if (absent) {
        want = st->r.flowing == 1 && st->r.n > 0
            ? scr_stream_entry_len(st, st->r.buf[0]) - st->r.head_off
            : st->r.length;
      } else {
        want = n <= st->r.length ? n : (st->r.ended ? st->r.length : 0);
      }
    }
  }
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
    scr_stream_emit_data(s, ret);
    if (scr_exc_pending()) {
      scr_stream_entry_release(st, ret);
      return NULL;
    }
  }
  return ret;
}

static void scr_stream_flow(ScrStream *s) {
  ScrStreamState *st = s->st;
  while (st->r.flowing == 1 && !scr_exc_pending()) {
    void *b = scr_stream_read_n(s, -1);
    if (b == NULL) break;
    scr_stream_entry_release(st, b);
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
  if (a->kind == SCR_DYN_UNDEF || a->kind == SCR_DYN_NULL) return NULL;
  if (a->kind == SCR_DYN_STR) {
    ScrError *e = scr_error_new(SCR_ERR_ERROR, a->v.str);
    return e;
  }
  if (a->kind == SCR_DYN_OBJ) {
    ScrDyn *m = scr_dyn_obj_get((ScrDyn *)a, "message", 7);
    ScrStr *msg = m && m->kind == SCR_DYN_STR ? scr_str_retain(m->v.str) : scr_str_new("", 0);
    ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
    scr_str_release(msg);
    return e;
  }
  /* any other truthy value: Node would wrap it — approximate with "" */
  ScrStr *empty = scr_str_new("", 0);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, empty);
  scr_str_release(empty);
  return e;
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

ScrDyn *scr_stream_done_dyn_d(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  scr_stream_destroy_done(s, scr_stream_dyn_err(args, argc));
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

static void scr_stream_dyn_data(ScrDyn *const *args, size_t argc,
                                ScrBytes **data, ScrStr **data_str) {
  *data = NULL;
  *data_str = NULL;
  if (argc < 2) return;
  const ScrDyn *a = args[1];
  if (a->kind == SCR_DYN_BYTES) *data = scr_bytes_raw_view(a->v.bytes);
  else if (a->kind == SCR_DYN_STR) *data_str = scr_str_retain(a->v.str);
}

ScrDyn *scr_stream_done_dyn_t(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  ScrBytes *data;
  ScrStr *data_str;
  scr_stream_dyn_data(args, argc, &data, &data_str);
  scr_stream_transform_done(s, scr_stream_dyn_err(args, argc), data, data_str);
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

ScrDyn *scr_stream_done_dyn_l(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_stream_dyn_recv(clo);
  ScrBytes *data;
  ScrStr *data_str;
  scr_stream_dyn_data(args, argc, &data, &data_str);
  scr_stream_flush_done(s, scr_stream_dyn_err(args, argc), data, data_str);
  scr_stream_release(s);
  return scr_stream_done_dyn_ret();
}

/* Checked-dynamic chunks (the JS lane's push/write of any-typed values):
 * dispatch by dyn tag — bytes copy out, strings convert utf8, null takes
 * the null path (EOF for push; ERR_STREAM_NULL_VALUES for write), and
 * anything else throws the write TypeError (Node would throw
 * ERR_INVALID_ARG_TYPE — approximated by the same shape). Borrow d. */
bool scr_stream_push_dyn(ScrStream *s, const ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_BYTES: {
    ScrBytes *b = scr_bytes_raw_view(d->v.bytes);
    bool r = scr_stream_push(s, b);
    scr_bytes_release(b);
    return r;
  }
  case SCR_DYN_STR:
    return scr_stream_push_str(s, d->v.str);
  case SCR_DYN_NULL:
    return scr_stream_push_null(s);
  default: {
    static const char msg[] = "May not write null values to stream";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_STREAM_NULL_VALUES");
    return false;
  }
  }
}

bool scr_stream_write_dyn(ScrStream *s, const ScrDyn *d, ScrClosure *cb) {
  switch (d->kind) {
  case SCR_DYN_BYTES: {
    ScrBytes *b = scr_bytes_raw_view(d->v.bytes);
    bool r = scr_stream_write(s, b, cb);
    scr_bytes_release(b);
    return r;
  }
  case SCR_DYN_STR:
    return scr_stream_write_str(s, d->v.str, cb);
  default:
    if (cb) scr_closure_release(cb);
    return scr_stream_write_null(s);
  }
}

/* ── the for-await surface (readable.nextChunk) ───────────────────────── */

/* Resolve the parked waiter with a taken chunk (moves), the EOF
 * sentinel, or dyn-boxed content per next_dyn. */
static void scr_stream_next_fulfill(ScrStreamState *st, ScrPromise *w /*moves*/, void *chunk /*moves or NULL=EOF*/) {
  if (st->r.next_dyn) {
    ScrDyn *d;
    if (chunk == NULL) {
      d = scr_dyn_retain(scr_dyn_undefined()); /* the EOF sentinel */
    } else if (st->r.encoded) {
      d = scr_dyn_new_str((ScrStr *)chunk);
      scr_str_release((ScrStr *)chunk);
    } else {
      d = scr_dyn_new_buffer((ScrBytes *)chunk);
      scr_bytes_release((ScrBytes *)chunk);
    }
    scr_promise_fulfill_ref(w, d, scr_dyn_retain_v, scr_dyn_release_v, NULL);
  } else {
    ScrBytes *b = chunk ? (ScrBytes *)chunk : scr_bytes_new(SCR_BYTES_U8, 0);
    scr_promise_fulfill_ref(w, b, scr_bytes_retain_v, scr_bytes_release_v, NULL);
  }
  scr_promise_release(w);
}

/* Settle the parked waiter if the stream's state can answer now: an
 * error rejects, buffered content fulfills (one whole entry in from
 * mode, the whole buffer otherwise — Node's iterator read()), EOF
 * fulfills the sentinel. Called from push/eof/destroy transitions. */
static void scr_stream_settle_next(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (!st->r.next_waiter) return;
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
    ScrPromise *w = st->r.next_waiter;
    st->r.next_waiter = NULL;
    void *chunk = scr_stream_rbuf_take(st, st->r.object_entries ? 1 : st->r.length);
    scr_stream_next_fulfill(st, w, chunk);
    if (st->r.ended && st->r.length == 0) scr_stream_end_readable(s);
    return;
  }
  if (st->r.ended || st->destroyed) {
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
    scr_stream_next_fulfill(st, w, NULL);
  }
}

static ScrPromise *scr_stream_next_chunk_impl(ScrStream *s, bool dyn) {
  ScrStreamState *st = s->st;
  ScrPromise *p = scr_promise_new();
  if (!st->has_r) {
    st->r.next_dyn = dyn;
    scr_stream_next_fulfill(st, scr_promise_retain(p), NULL);
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
  st->r.next_waiter = scr_promise_retain(p);
  /* answer from the current state, or kick a _read and park */
  scr_stream_settle_next(s);
  if (st->r.next_waiter && !st->r.reading && !st->r.ended && !st->destroyed) {
    st->r.need_readable = true;
    scr_stream_call_read(s);
    if (scr_exc_pending()) {
      ScrPromise *w = st->r.next_waiter;
      st->r.next_waiter = NULL;
      scr_promise_reject_pending(w);
      scr_promise_release(w);
      return p;
    }
    /* a synchronous push may have answered already */
    scr_stream_settle_next(s);
  }
  return p;
}

ScrPromise *scr_stream_next_chunk(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (st->has_r && st->r.encoded) {
    /* the typed lane's chunk is a Buffer; string chunks would confuse */
    ScrPromise *p = scr_promise_new();
    static const char msg[] =
        "for-await over a stream with an encoding set is not supported yet in "
        "typed code (chunks are Buffers here)";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    scr_promise_reject_pending(p);
    return p;
  }
  return scr_stream_next_chunk_impl(s, false);
}

ScrPromise *scr_stream_next_chunk_dyn(ScrStream *s) {
  return scr_stream_next_chunk_impl(s, true);
}

/* ── Readable.from (array-seeded object-entry streams) ────────────────── */

/* +1 stream fully seeded from the array's elements (strings or Buffers —
 * one WHOLE entry per element, Node's objectMode delivery; hwm 1) and
 * already EOF'd. Borrows arr. */
ScrStream *scr_stream_from_arr(ScrArr *arr, bool strings) {
  ScrStream *s = scr_stream_alloc(&scr_readable_vt, "Readable", true, false,
                                   1, -1, true, true, true);
  ScrStreamState *st = s->st;
  st->r.object_entries = true;
  st->r.encoded = strings;
  if (strings) st->r.enc = scr_str_new("utf8", 4);
  for (size_t i = 0; i < arr->len; i++) {
    scr_stream_rbuf_push(st, scr_arr_get_ref(arr, (double)i), false);
  }
  scr_stream_push_null(s);
  return s;
}

/* ── the registration hook ('data'/'readable' listeners kick flow) ────── */

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
    if (!st->r.end_emitted && !st->r.readable_listening) {
      st->r.readable_listening = true;
      st->r.need_readable = true;
      st->r.flowing = 0;
      st->r.emitted_readable = false;
      if (st->r.length > 0) {
        scr_stream_emit_readable_nt(s);
      } else if (!st->r.reading) {
        /* nReadingNextTick: a read(0) kick on a tick */
        scr_st_tick(s, SCR_ST_MAYBE_MORE, NULL, NULL);
        st->r.maybe_more_scheduled = true;
      }
    }
  }
}

/* ── writable internals ───────────────────────────────────────────────── */

static void scr_stream_wq_push(ScrStreamState *st, ScrBytes *chunk /*moves*/, ScrClosure *cb /*moves*/) {
  if (st->w.n == st->w.cap) {
    st->w.cap = st->w.cap ? st->w.cap * 2 : 4;
    st->w.q = realloc(st->w.q, st->w.cap * sizeof *st->w.q);
    if (!st->w.q) scr_stream_oom();
  }
  st->w.q[st->w.n].chunk = chunk;
  st->w.q[st->w.n].cb = cb;
  st->w.n++;
}

static void scr_stream_do_write(ScrStream *s, ScrBytes *chunk /*moves*/, ScrClosure *cb /*moves*/) {
  ScrStreamState *st = s->st;
  st->w.writing = true;
  st->w.wsync = true;
  st->w.inflight_len = chunk->len;
  st->w.inflight_cb = cb;
  if (st->passthrough && st->transform_cb == NULL) {
    /* identity: push through, complete synchronously */
    scr_stream_add_chunk(s, chunk, false);
    scr_bytes_release(chunk);
    if (!scr_exc_pending()) scr_stream_write_done(s, NULL);
    st->w.wsync = false;
    return;
  }
  if (st->is_transform || st->passthrough) {
    if (st->transform_cb == NULL) {
      scr_bytes_release(chunk);
      ScrError *e = scr_stream_mkerr("ERR_METHOD_NOT_IMPLEMENTED", "The _transform() method is not implemented");
      st->w.wsync = false;
      scr_stream_error_or_destroy(s, e);
      scr_error_release(e);
      return;
    }
    st->transform_inv(st->transform_cb, s, chunk);
    scr_bytes_release(chunk);
    st->w.wsync = false;
    return;
  }
  if (st->w.write_cb == NULL) {
    scr_bytes_release(chunk);
    ScrError *e = scr_stream_mkerr("ERR_METHOD_NOT_IMPLEMENTED", "The _write() method is not implemented");
    st->w.wsync = false;
    scr_stream_error_or_destroy(s, e);
    scr_error_release(e);
    return;
  }
  st->w.write_inv(st->w.write_cb, s, chunk);
  scr_bytes_release(chunk);
  st->w.wsync = false;
}

/* afterWrite — Node's exact order: 'drain' first (when the queue is
 * empty), THEN the user's write(chunk, cb) callback, then finishMaybe.
 * The buffered queue was already restarted by write_done (Node's onwrite
 * calls clearBuffer before afterWrite). cb moves. */
static void scr_stream_after_write(ScrStream *s, ScrClosure *cb) {
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
    ((void (*)(ScrClosure *))cb->fn)(cb);
    scr_closure_release(cb);
    if (scr_exc_pending()) return;
  }
  scr_stream_finish_maybe(s);
}

static void scr_stream_clear_buffer(ScrStream *s) {
  ScrStreamState *st = s->st;
  while (!st->w.writing && st->w.head < st->w.n && st->w.corked == 0 &&
         !st->destroyed && !scr_exc_pending()) {
    ScrWEntry e = st->w.q[st->w.head++];
    if (st->w.head == st->w.n) {
      st->w.head = 0;
      st->w.n = 0;
    }
    scr_stream_do_write(s, e.chunk, e.cb);
  }
}

/* prefinish + 'finish' scheduling once the writable side has fully
 * drained after end(). */
static void scr_stream_finish_maybe(ScrStream *s) {
  ScrStreamState *st = s->st;
  if (!st->w.ending || st->w.writing || st->w.head < st->w.n || st->w.finished ||
      st->destroyed || st->w.finish_scheduled) {
    return;
  }
  if (!st->w.prefinished) {
    if ((st->is_transform || st->passthrough) && !st->flush_called) {
      st->flush_called = true;
      if (st->flush_cb) {
        st->flush_inv(st->flush_cb, s);
        return; /* flush_done resumes the finish path */
      }
      /* no flush: EOF the readable side now */
      scr_stream_push_null(s);
      if (scr_exc_pending()) return;
    }
    if (st->w.final_cb && !st->w.final_called) {
      st->w.final_called = true;
      st->w.final_inv(st->w.final_cb, s);
      return; /* final_done resumes the finish path */
    }
    st->w.prefinished = true;
    scr_stream_emit0(s, "prefinish");
    if (scr_exc_pending()) return;
  }
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

static ScrStream *scr_stream_alloc(const ScrVt *vt, const char *cls, bool has_r, bool has_w,
                                    double rhwm, double whwm, bool auto_destroy,
                                    bool emit_close, bool allow_half_open) {
  ScrStream *s = scr_cyc_alloc(sizeof *s, &scr_stream_trace, &scr_stream_gcfree);
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
 * base WOULD consume but have no lowering here (objectMode truthy,
 * decodeStrings:false, non-utf8 defaultEncoding, signal, construct,
 * writev, and read/write/final on the transformish bases) throw the loud
 * unsupported Error — the compile-time fence's runtime twin. */

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
  args[0] = scr_dyn_new_buffer(chunk);
  ScrStr *enc = scr_str_new("buffer", 6);
  args[1] = scr_dyn_new_str(enc);
  scr_str_release(enc);
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
  args[0] = scr_dyn_new_buffer(chunk);
  ScrStr *enc = scr_str_new("buffer", 6);
  args[1] = scr_dyn_new_str(enc);
  scr_str_release(enc);
  args[2] = scr_stream_dynopt_done(s, &scr_stream_done_dyn_t, 2, "(error,data)");
  ScrDyn *fn = scr_stream_dynopt_target(cb);
  ScrDyn *r = scr_dyn_call(fn, args, 3, "transform");
  for (int i = 0; i < 3; i++) scr_dyn_release(args[i]);
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
  ScrStr *enc; /* owned canonical name, or NULL */
  /* BORROWED callable fields (owned by the options record). */
  ScrDyn *read, *write, *final_fn, *destroy, *transform, *flush;
} ScrStreamDynOpts;

/* Node's `=== false` comparisons (autoDestroy/emitClose/allowHalfOpen and
 * the Duplex side toggles: `options.x !== false` — 0 does NOT disable). */
static bool scr_stream_dynopt_false(const ScrDyn *v) {
  return v != NULL && v->kind == SCR_DYN_BOOL && !v->v.b;
}

static double scr_stream_dynopt_hwm(const ScrDyn *o, const char *key, size_t klen) {
  ScrDyn *v = scr_dyn_obj_get((ScrDyn *)o, key, klen);
  if (v == NULL || v->kind != SCR_DYN_NUM || v->v.num < 0) return -1;
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
  out->read = out->write = out->final_fn = out->destroy = out->transform = out->flush = NULL;
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return true; /* Node's `if (options)` */
  const bool duplexish = base == 'd' || base == 't' || base == 'p';
  const bool transformish = base == 't' || base == 'p';
  const bool r_sided = base != 'w';

  if (scr_stream_dynopt_truthy(opts, "objectMode", 10) ||
      scr_stream_dynopt_truthy(opts, "readableObjectMode", 18) ||
      scr_stream_dynopt_truthy(opts, "writableObjectMode", 18)) {
    static const char m[] = "objectMode streams are not supported yet (chunks are Buffers or utf8 strings)";
    return scr_stream_dynopt_unsupported(m, sizeof m - 1);
  }
  if (scr_stream_dynopt_false(scr_dyn_obj_get((ScrDyn *)opts, "decodeStrings", 13))) {
    static const char m[] = "decodeStrings: false is not supported yet (chunks always decode to Buffers)";
    return scr_stream_dynopt_unsupported(m, sizeof m - 1);
  }
  {
    ScrDyn *v = scr_dyn_obj_get((ScrDyn *)opts, "signal", 6);
    if (v != NULL && v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_UNDEF) {
      static const char m[] = "the stream option 'signal' is not supported yet (AbortSignal-driven destruction has no lowering)";
      return scr_stream_dynopt_unsupported(m, sizeof m - 1);
    }
  }
  if (scr_stream_dynopt_fn(opts, "construct", 9) != NULL) {
    static const char m[] = "the stream option 'construct' is not supported yet (deferred construction has no lowering)";
    return scr_stream_dynopt_unsupported(m, sizeof m - 1);
  }
  if (scr_stream_dynopt_fn(opts, "writev", 6) != NULL) {
    static const char m[] = "the stream option 'writev' is not supported yet (writes deliver one chunk at a time)";
    return scr_stream_dynopt_unsupported(m, sizeof m - 1);
  }
  {
    ScrDyn *v = scr_dyn_obj_get((ScrDyn *)opts, "defaultEncoding", 15);
    if (v != NULL && v->kind == SCR_DYN_STR &&
        !(v->v.str->len == 4 && memcmp(v->v.str->data, "utf8", 4) == 0) &&
        !(v->v.str->len == 5 && memcmp(v->v.str->data, "utf-8", 5) == 0)) {
      static const char m[] = "the stream option 'defaultEncoding' is not supported yet (utf8, the default, is the write-side string encoding)";
      return scr_stream_dynopt_unsupported(m, sizeof m - 1);
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

  /* highWaterMark wins over the sided keys (Node's getHighWaterMark). */
  {
    double hwm = scr_stream_dynopt_hwm(opts, "highWaterMark", 13);
    double rh = duplexish ? scr_stream_dynopt_hwm(opts, "readableHighWaterMark", 21) : -1;
    double wh = duplexish ? scr_stream_dynopt_hwm(opts, "writableHighWaterMark", 21) : -1;
    out->rhwm = hwm >= 0 ? hwm : rh;
    out->whwm = hwm >= 0 ? hwm : wh;
  }
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
  return scr_stream_new_writable(o.whwm, o.auto_destroy, o.emit_close,
      write, (ScrStreamChunkInv)winv, final_cb, (ScrStreamPlainInv)finv, destroy, (ScrStreamErrInv)dinv);
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
 *   - pipeline(a, b, c, cb) on a mid-stream error: the erroring stream
 *     destroys itself and emits 'error'+'close'; the pipeline then
 *     destroys every OTHER stream with the SAME error (pipeline order),
 *     each emitting 'error' then 'close'; cb(err) runs after the last
 *     'close'. Success: cb(null) after the destination's 'close'.
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

typedef struct {
  size_t rc;
  size_t n, closed;
  ScrStream **streams; /* owned */
  ScrClosure *cb;      /* owned; NULL once fired */
  ScrStreamErrInv inv;
  ScrError *err;       /* first error, owned */
} ScrStreamPipeCtx;

static void *scr_stream_pipectx_retain_v(void *p) {
  ((ScrStreamPipeCtx *)p)->rc++;
  return p;
}

static void scr_stream_pipectx_release_v(void *p) {
  ScrStreamPipeCtx *ctx = p;
  if (--ctx->rc > 0) return;
  for (size_t i = 0; i < ctx->n; i++) scr_stream_release(ctx->streams[i]);
  free(ctx->streams);
  if (ctx->cb) scr_closure_release(ctx->cb);
  if (ctx->err) scr_error_release(ctx->err);
  free(ctx);
}

static void scr_stream_pipeline_watch_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  ScrStreamPipeCtx *ctx = scr_box_get_ref(cb->caps[0]); /* +1 */
  ctx->closed++;
  if (err != NULL && ctx->err == NULL) {
    ctx->err = scr_error_retain(err);
    /* Node's pipeline destroyer: every other stream goes down with the
     * SAME error, pipeline order (each emits 'error' then 'close'). */
    for (size_t i = 0; i < ctx->n; i++) {
      if (ctx->streams[i] != s) {
        ScrStream *chain = scr_stream_destroy(ctx->streams[i], ctx->err);
        scr_stream_release(chain);
      }
    }
  }
  if (ctx->closed == ctx->n && ctx->cb != NULL) {
    ScrClosure *ucb = ctx->cb;
    ctx->cb = NULL;
    ctx->inv(ucb, ctx->streams[ctx->n - 1], ctx->err);
    scr_closure_release(ucb);
  }
  scr_stream_pipectx_release_v(ctx);
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

ScrStream *scr_stream_pipeline(double n_d, ScrStream **streams /*borrowed*/,
    ScrClosure *cb /*moves*/, ScrStreamErrInv inv) {
  size_t n = (size_t)n_d;
  ScrStreamPipeCtx *ctx = calloc(1, sizeof *ctx);
  if (!ctx) scr_stream_oom();
  ctx->rc = 1;
  ctx->n = n;
  ctx->streams = calloc(n, sizeof *ctx->streams);
  if (!ctx->streams) scr_stream_oom();
  for (size_t i = 0; i < n; i++) ctx->streams[i] = scr_stream_retain(streams[i]);
  ctx->cb = cb;
  ctx->inv = inv;
  /* Chain the pipes first (end: true — Node's pipeline forwards EOF). */
  for (size_t i = 0; i + 1 < n; i++) {
    ScrStream *d = scr_stream_pipe(streams[i], streams[i + 1], true);
    scr_stream_release(d);
  }
  /* One watcher per stream: the terminal statuses drive error propagation
   * and the final callback (after the LAST 'close'). */
  for (size_t i = 0; i < n; i++) {
    ScrClosure *w = scr_closure_new((void *)&scr_stream_pipeline_watch_inv, 1);
    w->caps[0] = scr_box_new_obj(&scr_stream_pipectx_retain_v, &scr_stream_pipectx_release_v, NULL);
    scr_box_set_ref(w->caps[0], scr_stream_pipectx_retain_v(ctx));
    scr_stream_fin_add(streams[i]->st, w, &scr_stream_pipeline_watch_inv);
  }
  scr_stream_pipectx_release_v(ctx); /* the boxes own it now */
  return scr_stream_retain(streams[n - 1]);
}

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
  scr_stream_release(dst);
  return p;
}

/* ── node:stream/consumers ────────────────────────────────────────────
 * text/json/buffer over the readable machinery: a native 'data' listener
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

enum { SCR_SC_TEXT = 0, SCR_SC_JSON = 1, SCR_SC_BUFFER = 2 };

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
static void scr_sc_data(ScrClosure *cb, void *b, void *str) {
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
  ScrArr *chunks = scr_arr_new_ref(scr_bytes_retain_v, scr_bytes_release_v, NULL, 4);
  ScrStreamErrInv fin_inv = kind == SCR_SC_TEXT    ? &scr_sc_fin_text
                            : kind == SCR_SC_JSON  ? &scr_sc_fin_json
                                                   : &scr_sc_fin_buffer;
  /* The terminal watcher first (it marks lifecycle errors handled); the
   * promise form exposes no unhook — the cleanup closure drops. */
  ScrClosure *cleanup = scr_stream_finished(s, scr_sc_closure((void *)fin_inv, p, chunks), fin_inv);
  scr_closure_release(cleanup);
  ScrStr *dn = scr_str_new("data", 4);
  scr_emitter_release(scr_emitter_on((ScrEmitter *)s, dn,
                                     scr_sc_closure((void *)&scr_sc_data, p, chunks),
                                     scr_ee_inv_fixed2, false, false));
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

/* ── the readable surface ─────────────────────────────────────────────── */

bool scr_stream_push(ScrStream *s, ScrBytes *chunk) {
  return scr_stream_add_chunk(s, chunk, false);
}

bool scr_stream_push_str(ScrStream *s, ScrStr *str) {
  ScrStr *enc = s->st->has_r ? s->st->r.push_enc : NULL;
  ScrBytes *b;
  if (enc != NULL) {
    /* Node: Buffer.from(chunk, state.defaultEncoding). */
    b = scr_bytes_from_str(str, enc);
  } else {
    b = scr_bytes_new(SCR_BYTES_U8, (double)str->len);
    memcpy(b->data, str->data, str->len);
  }
  bool ret = scr_stream_add_chunk(s, b, false);
  scr_bytes_release(b);
  return ret;
}

/* push(chunk, encoding) with an explicit non-utf8 literal: the per-call
 * encoding overrides the stream's default. Borrows both strings. */
bool scr_stream_push_str_enc(ScrStream *s, ScrStr *str, ScrStr *enc) {
  ScrBytes *b = scr_bytes_from_str(str, enc);
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
    if (st->r.encoded) {
      ScrStr *tail = scr_strdec_end(st->r.enc, st->r.dec_pending);
      st->r.dec_pending = 0;
      if (scr_str_utf16_len(tail) > 0) {
        scr_stream_rbuf_push(st, tail, false);
        if (st->r.need_readable) scr_stream_emit_readable_nt(s);
      } else {
        scr_str_release(tail);
      }
    }
    st->r.ended = true;
    /* onEofChunk: inside a _read call (or before the first attempt) the
     * 'readable' pass defers to a tick; outside one it runs NOW — a
     * flowing stream delivers its buffered chunks synchronously here. */
    if (st->r.in_read_sync) {
      scr_stream_emit_readable_nt(s);
      if (st->r.length == 0) scr_stream_end_readable(s);
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
    scr_stream_rbuf_push(st, rest, true);
  }
  scr_stream_add_chunk(s, chunk, true);
}

void scr_stream_unshift_str(ScrStream *s, ScrStr *str) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)str->len);
  memcpy(b->data, str->data, str->len);
  scr_stream_unshift(s, b);
  scr_bytes_release(b);
}

static void scr_stream_listener_error(ScrClosure *adapter, ScrError *error) {
  ScrDyn *fn = scr_dyn_listener_fn(adapter);
  ScrDyn *arg = scr_dyn_from_error(error);
  ScrDyn *answer = scr_dyn_call(fn, &arg, 1, "listener");
  scr_dyn_release(answer);
  scr_dyn_release(arg);
  scr_dyn_release(fn);
}

static void scr_stream_listener_data(ScrClosure *adapter, ScrBytes *bytes, ScrStr *string) {
  ScrDyn *fn = scr_dyn_listener_fn(adapter);
  ScrDyn *arg = string ? scr_dyn_new_str(string) : scr_dyn_new_bytes(bytes);
  ScrDyn *answer = scr_dyn_call(fn, &arg, 1, "listener");
  scr_dyn_release(answer);
  scr_dyn_release(arg);
  scr_dyn_release(fn);
}

ScrStream *scr_stream_on_dyn(ScrStream *s, ScrStr *name, ScrDyn *cb, bool once, bool prepend) {
  if (name->len == 4 && !memcmp(name->data, "data", 4)) {
    return (ScrStream *)scr_emitter_on_dyn((ScrEmitter *)s, name, cb,
      scr_dyn_listener_closure_fn(cb, (void *)scr_stream_listener_data),
      scr_ee_inv_fixed2, once, prepend);
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
  static const char message[] = "this stream event has no checked-dynamic listener adapter";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

ScrDyn *scr_stream_read_dyn(ScrStream *s, ScrDyn *size) {
  double n = size && size->kind != SCR_DYN_UNDEF ? scr_dyn_number_coerce(size) : -1;
  if (scr_exc_pending()) return scr_dyn_undefined();
  void *chunk = s->st->has_r ? scr_stream_read_n(s, n) : NULL;
  if (!chunk) return scr_dyn_new_null();
  ScrDyn *result = s->st->r.encoded ? scr_dyn_new_str(chunk) : scr_dyn_new_buffer(chunk);
  scr_stream_entry_release(s->st, chunk);
  return result;
}

ScrBytes *scr_stream_read(ScrStream *s, double size) {
  /* a destroyed readable still DRAINS its buffer (Node: destroy leaves
   * buffered chunks readable; only _read refills are blocked) */
  if (!s->st->has_r) return NULL;
  if (s->st->r.encoded) {
    /* read() answers STRINGS once encoded — the static result type here
     * is `Buffer | null`, so the honest answer is a fence, not a
     * mistyped payload (SEMANTICS.md; 'data' listeners carry strings). */
    static const char msg[] =
        "read() on a stream with an encoding set is not supported yet "
        "(consume 'data' events, which deliver strings)";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return NULL;
  }
  return scr_stream_read_n(s, size);
}

/* setEncoding(enc): flips the readable buffer into string mode — Node
 * re-decodes the buffered content into ONE string entry and re-counts
 * length in string units. Borrows enc (canonical, frontend-folded);
 * answers the receiver +1. */
ScrStream *scr_stream_set_encoding(ScrStream *s, ScrStr *enc) {
  ScrStreamState *st = s->st;
  if (!st->has_r) return scr_stream_retain(s);
  if (st->r.encoded) {
    /* switching encodings mid-stream: fold the old decoder's pending
     * tail into the buffer first (rare; Node re-creates the decoder) */
    ScrStr *tail = scr_strdec_end(st->r.enc, st->r.dec_pending);
    if (scr_str_utf16_len(tail) > 0) scr_stream_rbuf_push(st, tail, false);
    else scr_str_release(tail);
    scr_str_release(st->r.enc);
    st->r.enc = scr_str_retain(enc);
    st->r.dec_pending = 0;
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
  st->r.n = 0;
  st->r.head_off = 0;
  st->r.length = 0;
  st->r.encoded = true; /* AFTER the byte-entry walk above */
  if (content != NULL) {
    if (scr_str_utf16_len(content) > 0) scr_stream_rbuf_push(st, content, false);
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

static bool scr_stream_write_chunk(ScrStream *s, ScrBytes *chunk /*borrowed*/, ScrClosure *cb /*moves*/) {
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
  size_t len = chunk->len;
  st->w.length += len;
  if (st->w.writing || st->w.corked > 0) {
    scr_stream_wq_push(st, scr_bytes_retain(chunk), cb);
  } else {
    scr_stream_do_write(s, scr_bytes_retain(chunk), cb);
  }
  /* Node computes the answer AFTER the (possibly synchronous) write:
   * a sync completion has already drained its bytes from length. */
  bool ret = st->w.length < st->w.hwm && !st->destroyed && !st->errored;
  if (!ret) st->w.need_drain = true;
  return ret;
}

bool scr_stream_write(ScrStream *s, ScrBytes *chunk, ScrClosure *cb) {
  return scr_stream_write_chunk(s, chunk, cb);
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
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)str->len);
  memcpy(b->data, str->data, str->len);
  bool ret = scr_stream_write_chunk(s, b, cb);
  scr_bytes_release(b);
  return ret;
}

ScrStream *scr_stream_end(ScrStream *s, ScrBytes *chunk_b, ScrStr *chunk_s, ScrClosure *cb) {
  ScrStreamState *st = s->st;
  if (chunk_b) scr_stream_write(s, chunk_b, NULL);
  else if (chunk_s) scr_stream_write_str(s, chunk_s, NULL);
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
    if (ucb) scr_st_tick(s, SCR_ST_WCB_ERR, NULL, ucb);
    scr_stream_error_or_destroy(s, err);
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
    scr_st_tick(s, SCR_ST_AFTER_WRITE, NULL, ucb);
  } else {
    scr_stream_after_write(s, ucb);
  }
}

void scr_stream_final_done(ScrStream *s, ScrError *err /*moves*/) {
  ScrStreamState *st = s->st;
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

void scr_stream_transform_done(ScrStream *s, ScrError *err /*moves*/, ScrBytes *data /*moves*/,
                               ScrStr *data_str /*moves*/) {
  if (!err) {
    if (data) {
      scr_stream_add_chunk(s, data, false);
    } else if (data_str) {
      ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)data_str->len);
      memcpy(b->data, data_str->data, data_str->len);
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
  scr_stream_write_done(s, err);
}

void scr_stream_flush_done(ScrStream *s, ScrError *err /*moves*/, ScrBytes *data /*moves*/,
                           ScrStr *data_str /*moves*/) {
  ScrStreamState *st = s->st;
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
  } else if (data_str) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)data_str->len);
    memcpy(b->data, data_str->data, data_str->len);
    scr_stream_add_chunk(s, b, false);
    scr_bytes_release(b);
    scr_str_release(data_str);
  }
  if (scr_exc_pending()) return;
  scr_stream_push_null(s); /* EOF the readable side after flush */
  if (scr_exc_pending()) return;
  scr_stream_finish_maybe(s);
}

/* ── destroy ──────────────────────────────────────────────────────────── */

static void scr_stream_do_destroy(ScrStream *s, ScrError *err /*borrowed*/) {
  ScrStreamState *st = s->st;
  if (st->destroyed || st->destroy_calling) return;
  st->destroyed = true;
  if (err && !st->errored) st->errored = scr_error_retain(err);
  scr_stream_settle_next(s); /* a parked for-await rejects/finishes */
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
    if (strcmp(p, "objectMode") == 0) return 0;
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

static void scr_stream_run_tick(ScrStreamTick *t) {
  ScrStream *s = t->s;
  ScrStreamState *st = s->st;
  switch (t->op) {
    case SCR_ST_RESUME: {
      st->r.resume_scheduled = false;
      if (!st->r.reading && st->r.flowing == 1) {
        /* read(0) kick: pull the user _read without consuming */
        st->r.need_readable = st->r.length == 0;
        if (!st->r.ended && !st->destroyed) scr_stream_call_read(s);
        if (scr_exc_pending()) break;
      }
      scr_stream_emit0(s, "resume");
      if (scr_exc_pending()) break;
      scr_stream_flow(s);
      if (scr_exc_pending()) break;
      if (st->r.flowing == 1 && !st->r.reading && !st->r.ended && !st->destroyed) {
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
      if (st->destroyed) break;
      /* loop while synchronous pushes make progress below the hwm */
      while (!st->r.reading && !st->r.ended && st->r.length < st->r.hwm &&
             (st->r.flowing == 1 || st->r.need_readable) && !scr_exc_pending()) {
        size_t before = st->r.length;
        scr_stream_call_read(s);
        if (scr_exc_pending() || st->r.length == before) break;
      }
      break;
    }
    case SCR_ST_AFTER_WRITE: {
      st->w.after_scheduled = false;
      ScrClosure *cb = t->cb;
      t->cb = NULL;
      if (!st->destroyed) {
        scr_stream_after_write(s, cb);
      } else if (cb) {
        ((void (*)(ScrClosure *))cb->fn)(cb);
        scr_closure_release(cb);
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
          break;
        }
        if (st->fin.n > 0 && !scr_emitter_has((ScrEmitter *)s, "error")) {
          /* a finished()/pipeline watcher consumes it (Node's eos and
           * pipeline register their own 'error' handlers) — the watcher
           * reports it at the terminal point instead of crashing */
          break;
        }
        scr_stream_emit_error(s, t->err);
      }
      break;
    }
    case SCR_ST_CLOSE: {
      st->close_scheduled = false;
      if (!st->close_emitted) {
        st->close_emitted = true;
        if (st->emit_close) scr_stream_emit0(s, "close");
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
        if (st->transform_cb) { scr_closure_release(st->transform_cb); st->transform_cb = NULL; }
        if (st->flush_cb) { scr_closure_release(st->flush_cb); st->flush_cb = NULL; }
        if (st->destroy_cb) { scr_closure_release(st->destroy_cb); st->destroy_cb = NULL; }
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
    case SCR_ST_FIN: {
      scr_stream_notify_finished(s);
      break;
    }
    case SCR_ST_NEXT_EOF: {
      if (st->r.next_waiter && st->r.length == 0 && (st->r.ended || st->destroyed)) {
        ScrPromise *w = st->r.next_waiter;
        st->r.next_waiter = NULL;
        scr_stream_next_fulfill(st, w, NULL);
      } else if (st->r.next_waiter) {
        scr_stream_settle_next(s); /* content raced in: deliver it */
      }
      break;
    }
  }
}

static void scr_stream_dispatch(void);

/* One tick-marker's dispatch: the queue's FIFO head (markers and entries
 * are enqueued 1:1 in the same order). After an uncaught throw the
 * remaining entries drop through the station's exc branch below, keeping
 * the RC audit clean. */
static void scr_stream_dispatch_one(void) {
  ScrStreamTick *t = scr_st_head;
  if (t == NULL || scr_exc_pending()) return;
  scr_st_head = t->next;
  if (scr_st_head == NULL) scr_st_tail = NULL;
  scr_stream_run_tick(t);
  scr_stream_release(t->s);
  if (t->err) scr_error_release(t->err);
  if (t->cb) scr_closure_release(t->cb);
  free(t);
  if (scr_exc_pending()) scr_stream_dispatch(); /* its exc branch drops the rest */
}

static void scr_stream_dispatch(void) {
  while (scr_st_head != NULL && !scr_exc_pending() && !scr_loop_has_ready()) {
    ScrStreamTick *t = scr_st_head;
    scr_st_head = t->next;
    if (scr_st_head == NULL) scr_st_tail = NULL;
    scr_stream_run_tick(t);
    scr_stream_release(t->s);
    if (t->err) scr_error_release(t->err);
    if (t->cb) scr_closure_release(t->cb);
    free(t);
  }
  /* An uncaught throw ends the process (the loop returns to main): the
   * undelivered ticks are DROPPED — release their references here so the
   * RC audit stays clean (the children-teardown precedent). */
  if (scr_exc_pending()) {
    while (scr_st_head != NULL) {
      ScrStreamTick *t = scr_st_head;
      scr_st_head = t->next;
      scr_stream_release(t->s);
      if (t->err) scr_error_release(t->err);
      if (t->cb) scr_closure_release(t->cb);
      free(t);
    }
    scr_st_tail = NULL;
  }
}

void scr_stream_install(void) {
  scr_emitter_on_hook = &scr_stream_on_listener;
  scr_loop_set_stream(&scr_stream_ticks_pending, &scr_stream_dispatch);
}

/* Child stdio uses the standard stream machinery once it crosses generic
 * storage. Child-only programs never reference this optional table. */
static void scr_stream_child_read(ScrClosure *cb, ScrStream *s, double size) {
  (void)cb; (void)s; (void)size;
}
static ScrStream *scr_stream_child_readable(void) {
  return scr_stream_new_readable(-1, true, true,
      scr_closure_new((void *)scr_stream_child_read, 0), scr_stream_child_read,
      NULL, NULL);
}
static ScrStream *scr_stream_child_writable(ScrClosure *write, ScrStreamChunkInv write_inv,
    ScrClosure *final_cb, ScrStreamPlainInv final_inv) {
  return scr_stream_new_writable(-1, true, true, write, write_inv,
      final_cb, final_inv, NULL, NULL);
}
const ScrChildStreamOps scr_stream_child_ops = {
  scr_stream_child_readable, scr_stream_child_writable,
  scr_stream_retain_v, scr_stream_release_v, scr_stream_trace,
  scr_stream_push, scr_stream_push_null,
  scr_stream_write_done, scr_stream_final_done,
};

static ScrStream *scr_stream_view_receiver(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF && value->v.typed_ref.type_key_len > 7 &&
      !memcmp(value->v.typed_ref.type_key, "object:", 7)) {
    ScrStream *stream = scr_dyn_typed_ref_unbox(value);
    const ScrVt *vt = stream->vt;
    if ((vt->pre >= scr_readable_vt.pre && vt->pre <= scr_readable_vt.post) ||
        (vt->pre >= scr_writable_vt.pre && vt->pre <= scr_writable_vt.post)) return stream;
    value->v.typed_ref.release(stream);
  }
  scr_dyn_arg_type_fail("destination", "an instance of Stream", value);
  return NULL;
}

static ScrDyn *scr_stream_view_call(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrStream *stream = scr_box_get_ref(cb->caps[0]);
  ScrStr *name = scr_box_get_ref(cb->caps[1]);
  const char *method = name->data;
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
      ScrStream *returned = !strcmp(method, "pipe")
          ? scr_stream_pipe(stream, destination, end) : scr_stream_unpipe(stream, destination);
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
  if (!result && !scr_exc_pending()) result = scr_dyn_this_get();
  scr_str_release(name);
  scr_stream_release(stream);
  return result;
}

ScrDyn *scr_stream_dyn_view(ScrStream *stream) {
  ScrDyn *view = scr_dyn_new_obj();
  ScrDyn *prototype = scr_dyn_new_obj();
  static const char *const methods[] = {
    "on", "once", "addListener", "prependListener", "prependOnceListener",
    "off", "removeListener", "pipe", "unpipe", "read", "pause", "resume", "isPaused",
    "setEncoding", "write", "end", "destroy", "cork", "uncork",
  };
  for (size_t i = 0; i < sizeof methods / sizeof *methods; i++) {
    ScrClosure *cb = scr_closure_new((void *)scr_stream_view_call, 2);
    cb->caps[0] = scr_box_new_obj(scr_stream_retain_v, scr_stream_release_v, scr_stream_trace);
    cb->caps[1] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(cb->caps[0], scr_stream_retain(stream));
    scr_box_set_ref(cb->caps[1], scr_str_new(methods[i], strlen(methods[i])));
    scr_dyn_obj_set(prototype, methods[i], strlen(methods[i]),
        scr_dyn_new_func(cb, scr_stream_view_call, 0, "native stream method", methods[i]));
  }
  static const char *const properties[] = {
    "readable", "readableEnded", "readableLength", "readableHighWaterMark",
    "writable", "writableEnded", "writableFinished", "writableLength", "writableHighWaterMark",
    "writableNeedDrain", "destroyed", "closed",
  };
  for (size_t i = 0; i < sizeof properties / sizeof *properties; i++) {
    double value = scr_stream_prop(stream, properties[i]);
    bool number = strstr(properties[i], "Length") || strstr(properties[i], "HighWaterMark");
    scr_dyn_obj_set(view, properties[i], strlen(properties[i]),
        number ? scr_dyn_new_num(value) : scr_dyn_new_bool(value != 0));
  }
  ScrDyn *attached = scr_dyn_set_prototype(view, prototype);
  scr_dyn_release(attached);
  scr_dyn_release(prototype);
  return view;
}
