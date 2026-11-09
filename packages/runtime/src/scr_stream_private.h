/* The stream unit's private state layout, for the gated stdin stream unit.
 *
 * scr_stream.c owns the implementation; `ScrWEntry` and `ScrStreamState`
 * stay defined there, unchanged, because every program that uses a stream
 * links that unit and its object must not move. The gated
 * scr_stream_stdin.c unit (process.stdin handed on as a Readable) ends its
 * stream the way Node's file stream does, which no exported entry of the
 * stream unit expresses, so it repeats the layout here. This is not a
 * public surface: nothing outside the stream units includes it, and the
 * struct stays opaque (scr_stream.h's typedef) to everything else.
 *
 * The text between the two marker comments must stay line-for-line
 * identical to scr_stream.c's definitions from `typedef struct ScrWEntry`
 * to the end of `struct ScrStreamState`; a field's position is load-bearing
 * for both units at once. packages/runtime/test/stream-private-layout.test.ts
 * compares the two. */
#ifndef SCR_STREAM_PRIVATE_H
#define SCR_STREAM_PRIVATE_H

#include "scr_runtime.h"

/* scr_stream.c: state layout begin */
typedef struct ScrWEntry {
  ScrBytes *chunk; /* owned; a ScrDyn* value on an object-mode writable side,
                    * or a typed record when desc is set */
  ScrClosure *cb;  /* owned or NULL (the user's write(chunk, cb) callback) */
  ScrDyn *enc;     /* owned or NULL = undefined: the encoding argument an
                    * object-mode write passed (Node hands it to _write
                    * unchanged; null when the callback took its place) */
  const ScrStreamTypedDesc *desc; /* the typed chunk's type, or NULL */
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
    /* queue of owned chunks: the n entries from buf[first], the first one
     * read from head_off. Taking the head advances first instead of
     * shifting the rest; pushes reuse the freed front slots. */
    void **buf;
    size_t first, n, cap, head_off;
    int flowing; /* -1 null, 0 paused, 1 flowing */
    bool reading, in_read_sync, ended, end_emitted, end_scheduled;
    bool in_read_call; /* inside the user's _read (in_read_sync also starts true) */
    bool need_readable, emitted_readable, readable_listening;
    /* the stream has 'data' listeners: kept by scr_stream_listener_observe
     * from the registry's empty/nonempty transitions, so the per-chunk
     * paths read it instead of looking the name up */
    bool data_listeners;
    /* one of those listeners was registered through an untyped value with
     * no typed adapter (scr_emitter_has_dyn): the per-chunk emit then also
     * carries the chunk as a checked-dynamic value. Set on registration
     * (a stale true costs one box per chunk, never a missed delivery). */
    bool data_dyn;
    bool resume_scheduled, maybe_more_scheduled;
    /* A 'data' event was emitted (Node's kDataEmitted): readableDidRead. */
    bool data_emitted;
    /* The buffer's representation: encoded means every entry is a ScrStr,
     * otherwise every entry is a ScrBytes (scr_stream_rbuf_push checks
     * it). decoding: setEncoding() installed a decoder, so Buffer entries
     * decode on the way in; a string object stream without one
     * (Readable.from over strings) holds strings but decodes nothing. */
    bool encoded;
    bool decoding;
    ScrStr *enc;        /* owned canonical encoding name, or NULL */
    /* The `encoding` option as the program spelled it, when that is not
     * the canonical name (owned, or NULL): what readableEncoding answers
     * until setEncoding() replaces the decoder. */
    ScrStr *enc_name;
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
    /* The type of the typed records an object-mode buffer holds
     * (scr_stream_push_typed), or NULL. Set by the first entry and kept:
     * an entry taken out of the buffer is released through it even after
     * the buffer turned to dyn entries, which take precedence. */
    const ScrStreamTypedDesc *typed;
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
    /* the running write's typed chunk type, or NULL (a dyn value or a
     * Buffer) */
    const ScrStreamTypedDesc *cur_desc;
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
/* scr_stream.c: state layout end */

#endif
