/* scriptc runtime — sync and async generators (scr_async.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_GENERATOR_H
#define SCR_GENERATOR_H

#include "scr_events.h"

/* ── sync generators (function*) ──────────────────────────────────────
 * A generator is a refcounted handle (ScrGen) over a fiber created
 * SUSPENDED — nothing runs until the first resume — plus three
 * type-erased value slots (kind + payload + release fn, the exception
 * cell's technique): OUT (the yielded value, or the completion value once
 * done), IN (the `.next(v)` argument), and RET (a parked `.return(v)`
 * value, promoted to OUT by the trampoline when the GENRET unwind
 * completes). The emitted code is type-directed: setters/takes move
 * ownership (+1 in, +1 out); a NONE slot is JS's undefined.
 *
 * Resume protocol (consumer side, synchronous — no event loop):
 * - scr_gen_resume: `.next()`. Starts or resumes the fiber and returns
 *   when it yields or completes. A body exception (or an injected
 *   `.throw`) moves into the CALLER's cell — the emitted pending check
 *   after the resume propagates it. Resuming a RUNNING generator throws
 *   Node's TypeError; resuming a DONE one is a no-op (OUT stays NONE —
 *   `{ value: undefined, done: true }`).
 * - scr_gen_resume_return: `.return(v)` with v already parked in RET.
 *   UNSTARTED/DONE: the body never runs (the unstarted fiber tears down,
 *   its argpack dropped); RET promotes to OUT. SUSPENDED: the GENRET
 *   sentinel enters the fiber's cell and the fiber resumes — finallys
 *   run; a finally that YIELDS parks the sentinel (done stays false; a
 *   later resume continues the unwind); a finally that THROWS replaces it.
 * - scr_gen_resume_throw: `.throw(e)` with e pending in the CALLER's cell
 *   (the emitted scr_throw_* just ran). SUSPENDED: the payload moves into
 *   the fiber's cell and the fiber resumes — the body's own try/catch
 *   sees it. UNSTARTED/DONE: the generator becomes done and the payload
 *   stays pending in the caller (the `.throw` call itself throws).
 *
 * Abandonment: releasing a SUSPENDED generator leaks its fiber
 * deliberately (unwinding would run user finallys Node's GC never runs);
 * the fiber stays in the live count, so programs that abandon one get the
 * abandoned-fiber RC-audit note (the loop-exhaustion story). An UNSTARTED
 * generator tears down cleanly: drop_args releases the packed arguments.
 */
typedef struct ScrGen ScrGen;

ScrGen *scr_gen_new(void (*entry)(ScrFiber *, void *), void *argpack,
                    void (*drop_args)(void *));
/* A synchronous generator whose body the compiler emitted as an LLVM
 * switched coroutine: no fiber stack; resumes call into the coroutine frame
 * on the resumer's stack. The body registers its frame with
 * scr_coro_started and ends in scr_gen_coro_finish (the trampoline
 * epilogue of the fiber form). Native targets only. */
ScrGen *scr_gen_new_stackless(void (*entry)(ScrFiber *, void *), void *argpack,
                              void (*drop_args)(void *));
void scr_coro_started(void *handle);
/* The OUT stores of a coroutine body's yield (its suspension follows). */
void scr_coro_yield_f64(ScrFiber *self, double v);
void scr_coro_yield_bool(ScrFiber *self, bool v);
void scr_coro_yield_ref(ScrFiber *self, void *v, void (*release)(void *)); /* moves */
void scr_gen_coro_finish(ScrFiber *self);
ScrGen *scr_async_gen_new(void (*entry)(ScrFiber *, void *), void *argpack,
                          void (*drop_args)(void *),
                          void (*settle)(ScrGen *, ScrPromise *));
/* An async generator whose body is a switched coroutine, as
 * scr_gen_new_stackless's: its steps run on the resumer's stack (the loop's
 * after an await), its awaits suspend through scr_coro_await_prepare and
 * scr_coro_hop_prepare, and its yields store OUT through scr_coro_yield_*.
 * Native targets only. */
ScrGen *scr_async_gen_new_stackless(void (*entry)(ScrFiber *, void *), void *argpack,
                                    void (*drop_args)(void *),
                                    void (*settle)(ScrGen *, ScrPromise *));
/* Runs when return() reaches the generator before its first resume, with
 * the packed arguments still alive: an iterator helper closes its source. */
void scr_gen_set_unstarted_return(ScrGen *g, void (*hook)(void *));
/* The @@toStringTag that util.inspect and Object.prototype.toString print
 * for the generator object: "Generator" (or "AsyncGenerator") unless set,
 * as the compiler does for iterator helpers ("Iterator Helper") and for
 * the array and string iterators it builds as generators. A tag that
 * starts with '!' marks a generator standing in for an object of another
 * class, which these refuse to print. */
void scr_gen_set_tag(ScrGen *g, const char *tag);
/* An adapter generator prints with the tag of the generator it adapts. */
void scr_gen_copy_tag(ScrGen *g, const ScrGen *from);
const char *scr_gen_tag(const ScrGen *g);
/* scr_gen_tag for units that also link without the generator runtime (a
 * library links none): the generator runtime sets it when it creates a
 * generator, so it is set whenever a generator capsule exists. Read it with
 * a relaxed atomic load. */
extern const char *(*scr_gen_tag_reader)(const ScrGen *g);
ScrGen *scr_gen_retain(ScrGen *g);
void scr_gen_release(ScrGen *g); /* NULL-tolerant */
void *scr_gen_retain_v(void *g);
void scr_gen_release_v(void *g);

void scr_gen_resume(ScrGen *g);
void scr_gen_resume_return(ScrGen *g);
/* A valueless next() that answers done (the compiler's own drives). */
bool scr_gen_step(ScrGen *g);
/* IteratorClose: a valueless return() whose result is dropped. */
void scr_gen_close(ScrGen *g);
void scr_gen_resume_throw(ScrGen *g);
bool scr_gen_done(ScrGen *g);

/* Async-generator resume methods. Reference arguments move into the
 * queued request; every function returns a +1 Promise<IteratorResult>. */
ScrPromise *scr_async_gen_next_none(ScrGen *g);
ScrPromise *scr_async_gen_next_f64(ScrGen *g, double value);
ScrPromise *scr_async_gen_next_bool(ScrGen *g, bool value);
ScrPromise *scr_async_gen_next_ref(ScrGen *g, void *value,
                                   void (*release)(void *));
ScrPromise *scr_async_gen_return_none(ScrGen *g);
ScrPromise *scr_async_gen_return_f64(ScrGen *g, double value);
ScrPromise *scr_async_gen_return_bool(ScrGen *g, bool value);
ScrPromise *scr_async_gen_return_ref(ScrGen *g, void *value,
                                     void (*release)(void *));
ScrPromise *scr_async_gen_throw(ScrGen *g);

/* IN slot (consumer stores before resume; body takes after the yield). */
void scr_gen_in_f64(ScrGen *g, double v);
void scr_gen_in_bool(ScrGen *g, bool v);
void scr_gen_in_ref(ScrGen *g, void *v, void (*release)(void *)); /* moves */
void scr_gen_in_none(ScrGen *g);
double scr_gen_take_in_f64(void); /* body side: the running fiber's gen */
bool scr_gen_take_in_bool(void);
void *scr_gen_take_in_ref(void); /* +1 moved out; NONE → NULL */
ScrDyn *scr_gen_take_in_dyn(void); /* dyn channel: +1; NONE → undefined */
/* yield* captures next/return/throw before ordinary yield unwinding. Ref
 * converters borrow their typed payload and return an owned dyn value. */
ScrDyn *scr_gen_delegate_resume(ScrDyn *(*next_ref)(void *),
                                ScrDyn *(*return_ref)(void *),
                                ScrDyn *(*caught_ref)(const ScrCaught *));

/* yield* over a typed generator delegate. start runs the first valueless
 * next(); flag 1 marks a typed next channel, which a suspended delegate
 * cannot take undefined into (the SC1071 fence), and flag 2 a completion
 * read as a return type that cannot hold undefined. forward runs right
 * after the delegating body's yield resumes and passes the consumer's
 * next(v), return(v), or throw(e) to the delegate; next is its form for a
 * resume with nothing pending. `modes` packs the next, return, and
 * completion channel transfers (two bits each) and the typed-completion
 * flag (64; 4 for next); the converters box a borrowed ref payload into
 * an owned dyn. All answer whether the delegate is done. */
bool scr_gen_delegate_start(ScrGen *d, unsigned flags);
bool scr_gen_delegate_next(ScrGen *d, unsigned flags, ScrDyn *(*to_dyn)(void *));
bool scr_gen_delegate_forward(ScrGen *d, unsigned modes, ScrDyn *(*next_dyn)(void *),
                              ScrDyn *(*ret_dyn)(void *), ScrDyn *(*done_dyn)(void *));

/* RET slot (consumer parks the `.return(v)` value before resume_return). */
void scr_gen_ret_f64(ScrGen *g, double v);
void scr_gen_ret_bool(ScrGen *g, bool v);
void scr_gen_ret_ref(ScrGen *g, void *v, void (*release)(void *)); /* moves */
void scr_gen_ret_none(ScrGen *g);

/* OUT slot (body yields / the emitted trampoline completes; consumer
 * takes after resume). The no-gen-argument yield forms run on the CURRENT
 * fiber's generator and switch back to the resumer; control returns when
 * the consumer resumes again (the emitted pending check right after sees
 * an injected .throw payload or the GENRET sentinel). */
void scr_gen_yield_f64(double v);
void scr_gen_yield_bool(bool v);
void scr_gen_yield_ref(void *v, void (*release)(void *)); /* moves */
void scr_async_gen_hop_done(void);
/* An async generator's `return x` whose completion turn awaits x. */
void scr_async_gen_return_awaits(void);
void scr_gen_out_f64(ScrGen *g, double v); /* trampoline completion stores */
void scr_gen_out_bool(ScrGen *g, bool v);
void scr_gen_out_ref(ScrGen *g, void *v, void (*release)(void *)); /* moves */
bool scr_gen_out_has(ScrGen *g); /* false = undefined completion value */
double scr_gen_take_out_f64(ScrGen *g);
bool scr_gen_take_out_bool(ScrGen *g);
void *scr_gen_take_out_ref(ScrGen *g); /* +1 moved out; NONE → NULL */

/* The trampoline's GENRET epilogue: true iff the sentinel is pending in
 * the ACTIVE cell (also the emitted catch-prologue test in generator
 * bodies). ret_to_out promotes the parked return value to the completion
 * value. gen_of answers the generator a fiber belongs to (borrowed). */
bool scr_exc_genret_pending(void);
void scr_gen_ret_to_out(ScrGen *g);
ScrGen *scr_gen_of_fiber(ScrFiber *f);

#ifdef SCR_RC_AUDIT
long scr_promise_live_count(void);
#endif

void scr_fetch_install(void);
ScrPromise *scr_fetch_input(ScrDyn *input, ScrDyn *init);
ScrDyn *scr_fetch_function(void);
void scr_global_fetch_install(ScrDyn *(*get)(void));
ScrDyn *scr_fetch_request_new(ScrDyn *input, ScrDyn *init);
ScrDyn *scr_fetch_headers_new(ScrDyn *init);
ScrPromise *scr_fetch_static(ScrStr *url, ScrDyn *init); /* +1 promise<Response handle> */
ScrDyn *scr_fetch_response_new(ScrDyn *body, ScrDyn *init); /* borrowed args; +1 Response handle or NULL pending */
ScrDyn *scr_fetch_response_json_static(ScrDyn *data, ScrDyn *init); /* Response.json; borrowed args; +1 Response handle or NULL pending */
ScrArr *scr_fetch_response_light(ScrDyn *response); /* @hono/node-server shim: borrowed; +1 string[] */
ScrPromise *scr_fetch_response_json(ScrDyn *response); /* +1 promise<dyn> */
ScrPromise *scr_fetch_response_text(ScrDyn *response); /* +1 promise<dyn> */
ScrPromise *scr_fetch_response_array_buffer(ScrDyn *response); /* +1 promise<dyn> */
ScrPromise *scr_fetch_response_bytes(ScrDyn *response); /* +1 promise<dyn> */
ScrDyn *scr_fetch_abort_controller_new(void); /* +1 AbortController handle */
/* Borrowed number; +1 AbortSignal handle or NULL pending. */
ScrDyn *scr_fetch_abort_timeout(ScrDyn *delay);
ScrDyn *scr_fetch_abort_now(ScrDyn *reason); /* borrowed reason; +1 handle */
ScrDyn *scr_fetch_abort_any(ScrDyn *signals); /* borrowed array; +1 handle or NULL pending */
ScrDyn *scr_fetch_stream_new(ScrDyn *source); /* borrowed source; +1 handle or NULL pending */
ScrDyn *scr_fetch_transform_new(void); /* +1 identity TransformStream handle */
ScrDyn *scr_fetch_stream_from(ScrDyn *iterable); /* borrowed iterable; +1 handle or NULL pending */
ScrDyn *scr_fetch_stream_from_array(
    ScrArr *iterable,
    ScrDyn *(*item)(ScrArr *, double)); /* borrowed array/callback; +1 handle */
ScrDyn *scr_fetch_stream_from_bytes(
    ScrBytes *iterable); /* borrowed bytes; +1 handle */
ScrDyn *scr_fetch_stream_from_string(
    ScrStr *iterable); /* borrowed string; +1 handle */
ScrPromise *scr_fetch_reader_read(ScrDyn *reader); /* borrowed handle; +1 */
/* A read request served by callbacks instead of a promise (the streams
 * spec's readableStreamDefaultReaderRead with a read request; Node's
 * Readable.fromWeb adapter uses one). chunk and error borrow their value;
 * error's reason is NULL when the reader was released. */
typedef struct ScrFetchReadSink {
  void (*chunk)(void *ctx, ScrDyn *value);
  void (*close)(void *ctx);
  void (*error)(void *ctx, ScrDyn *reason);
} ScrFetchReadSink;
/* Queue a sink read request on a reader handle (borrowed). false with a
 * TypeError pending for a value that is not a reader or a released one. */
bool scr_fetch_reader_read_into(ScrDyn *reader, const ScrFetchReadSink *sink, void *ctx);
/* What the fetch unit reaches of checked-dynamic web streams
 * (scr_webstreams.c installs it); NULL in programs without them. */
typedef struct ScrWebStreamBridge {
  /* scr_fetch_reader_read_into for one of their readers. */
  bool (*reader_read_into)(ScrDyn *reader, const ScrFetchReadSink *sink, void *ctx);
  /* Whether a ReadableStream is locked or disturbed, which makes it
   * unusable as a body. */
  bool (*unusable)(const ScrDyn *stream);
} ScrWebStreamBridge;
extern SCR_TL const ScrWebStreamBridge *scr_web_stream_bridge;
/* The web stream class constructors for checked-dynamic code, by kind
 * (scr_webstreams.c: ReadableStream, ReadableStreamDefaultReader,
 * ReadableStreamDefaultController, CountQueuingStrategy,
 * ByteLengthQueuingStrategy); +1. */
ScrDyn *scr_webstream_class(double kind);
/* `value instanceof <class>` for those classes (value borrowed). */
bool scr_webstream_instanceof(ScrDyn *value, double kind);

#endif /* SCR_GENERATOR_H */
