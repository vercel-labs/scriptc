#include "scr_worker.h"
#include "scr_symbol.h"

#ifdef SCR_WORKERS
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

extern int sc_worker_entry(uint32_t root);

/* One terminate() call's promise, answered when the worker exits. */
typedef struct ScrTermWait {
  ScrPromise *promise;
  struct ScrTermWait *next;
} ScrTermWait;
/* worker.cpuUsage()'s unanswered request: the promise, and the `prev`
 * reading its delta is taken from. */
typedef struct ScrCpuWait {
  int seq;
  bool delta;
  double prev_user;
  double prev_system;
  ScrPromise *promise;
  struct ScrCpuWait *next;
} ScrCpuWait;

/* One type's place in a port's shared listener order. The surface that
 * registered the type first decides which kind Node's emit reaches first:
 * Node keeps one ordered set, and the two stores here cannot interleave
 * further than that. */
typedef struct {
  ScrStr *name; /* +1 */
  bool core_first;
} ScrWorkerOrderEntry;

typedef struct ScrWorkerView {
  size_t rc;
  ScrEmitter *events;
  ScrWorkerThread *thread;
  /* terminate()'s promises: Node answers a fresh promise per call, each
   * resolving with the exit code (undefined when the worker had already
   * stopped). */
  ScrTermWait *termination;
  ScrPromise *disposal; /* worker[Symbol.asyncDispose]()'s promise */
  bool port;
  bool closed;
  bool referenced;
  /* A Worker's public port carries its own ref: a 'message' listener refs
   * it, and the thread handle's ref is unaffected (Node's
   * setupPortReferencing). Both keep the loop alive. */
  bool message_port_ref;
  bool started;
  /* Whether a 'message' listener was present at the last liveness update:
   * Node changes the port's reference only on the 0→1 and 1→0 transitions. */
  bool message_listeners;
  bool closing;
  ScrMailEvent *queued_head;
  ScrMailEvent *queued_tail;
  /* A MessageChannel port: its channel (+1) and end; NULL for parentPort. */
  ScrChannel *channel;
  int side;
  bool detached; /* transferred to another thread */
  uint64_t close_seq; /* when close() ran: the latest close emits first */
  uint64_t close_gen; /* the poll generation close() ran in */
  size_t phase_left; /* messages this poll phase still delivers */
  bool phase_close;  /* the other end's close, delivered this phase */
  /* A BroadcastChannel: its name and EventTarget core; its channel's end 0
   * queues what the other instances with the name post. */
  bool broadcast;
  ScrStr *name;
  ScrEventTargetCore *et;
  /* NodeEventTarget lists its EventEmitter and EventTarget types from one
   * map, in first-registration order; the two surfaces are separate stores
   * here, so a port keeps that order beside them. */
  ScrWorkerOrderEntry *order;
  size_t order_n;
  /* A Worker's stdout/stderr streams (the stdout and stderr options) and
   * their checked-dynamic boxes, made on first read */
  ScrStream *stdio[2];
  ScrDyn *stdio_box[2];
  bool stdio_captured[2];
  /* worker.stdin (the stdin option): a Writable whose chunks go to the
   * worker's process.stdin, and its box */
  ScrStream *stdin_stream;
  ScrDyn *stdin_box;
  bool stdin_captured;
  /* worker.performance: { eventLoopUtilization }, made on first read. */
  ScrDyn *performance_box;
  /* resourceLimits as this Worker's constructor requested them, in Node's
   * key order (young, old, codeRange, stack): -1 for an unset V8 heap
   * limit, 4 for an unset stack. */
  double limits[4];
  /* its 'online' event was delivered: worker.performance answers the zero
   * object until then, even when the thread already published metrics, and
   * cpuUsage() answers only from then */
  bool online;
  /* cpuUsage() requests in flight, and the last sequence number given out */
  ScrCpuWait *cpu_wait;
  int cpu_seq;
  struct ScrWorkerView *next;
} ScrWorkerView;

static SCR_TL ScrMailbox *scr_worker_events;
static SCR_TL ScrWorkerView *scr_worker_views;
static SCR_TL ScrWorkerView *scr_worker_port;
/* this thread's MessageChannel ports (registry references) */
static SCR_TL ScrWorkerView *scr_channel_ports;
static SCR_TL uint64_t scr_channel_close_seq;
static SCR_TL bool scr_channel_phase; /* a poll phase is being delivered */
/* completed poll phases: a port's 'close' runs in the close phase after
 * the poll phase its close() came before or during */
static SCR_TL uint64_t scr_channel_poll_gen;
/* the loop pass continues a phase (scr_channel_more answered true) */
static SCR_TL bool scr_channel_continuing;
static SCR_TL bool scr_channel_closing_phase;
/* Messages from the thread's workers and its parent are delivered in
 * batches, as Node's MessagePort delivers them: one callback takes the
 * messages queued when it starts, and those that arrive meanwhile until it
 * has taken SCR_WORKER_BATCH_MIN, with a microtask checkpoint after each,
 * before the loop goes on to timers and immediates. A delivered message
 * starts a batch; the loop pass continues it (scr_workers_more) while the
 * next event is a message and the batch has room. Port messages that a
 * listener posts meanwhile wait for the batch to end, and the pass then
 * continues once more so they are delivered before immediates, as in Node. */
#define SCR_WORKER_BATCH_MIN 1000
static SCR_TL size_t scr_worker_batch_left;
static SCR_TL bool scr_worker_batch_ended;
/* scr_workers_more found the batch's next message at the head of the
 * mailbox. Only this thread takes events and others append them, so it is
 * still there when the pass dispatches. */
static SCR_TL bool scr_worker_batch_queued;

/* Whether a batch is open and its next message is queued. */
static bool scr_worker_batch_next(void) {
  return scr_worker_batch_left > 0 && scr_worker_events &&
         scr_mailbox_head_kind(scr_worker_events) == SCR_WORKER_MESSAGE;
}
static const char *const scr_worker_method_names[] = {
  "ref", "unref", "hasRef", "terminate", "postMessage", "on", "once", "addListener",
  "prependListener", "prependOnceListener", "off", "removeListener", "removeAllListeners",
  "listenerCount", "close", "start", "cpuUsage", "getHeapStatistics", "addEventListener",
  "removeEventListener",
  "dispatchEvent",
};
static SCR_TL ScrDyn *scr_worker_methods[sizeof scr_worker_method_names / sizeof scr_worker_method_names[0]];
static const char *const scr_broadcast_method_names[] = {
  "postMessage", "close", "ref", "unref", "addEventListener", "removeEventListener", "dispatchEvent",
};
static SCR_TL ScrDyn *scr_broadcast_methods[sizeof scr_broadcast_method_names / sizeof scr_broadcast_method_names[0]];

/* a port's EventTarget core, created on first use (defined below) */
static ScrEventTargetCore *scr_port_core(ScrWorkerView *view);
static void scr_worker_drop_if_empty(ScrWorkerView *view, const ScrStr *name);
static void scr_worker_order_clear(ScrWorkerView *view);


/* The stream unit's half of worker.stdout, worker.stderr and
 * worker.stdin, installed by main when the program reads them as streams
 * (scr_worker_stdio_install; a box the program has no type for is NULL). */
static SCR_TL const ScrChildStreamOps *scr_worker_stdio_ops;
static SCR_TL ScrDyn *(*scr_worker_stdio_box)(void *);
static SCR_TL ScrDyn *(*scr_worker_stdin_box)(void *);

void scr_worker_stdio_install(const ScrChildStreamOps *ops, ScrDyn *(*readable_box)(void *),
                              ScrDyn *(*writable_box)(void *)) {
  scr_worker_stdio_ops = ops;
  scr_worker_stdio_box = readable_box;
  scr_worker_stdin_box = writable_box;
}

/* A Worker with the stdout, stderr or stdin option in a program that has
 * no typed Readable or Writable box: the streams go through the stream
 * unit's live view. */
void scr_worker_stdio_default(const ScrChildStreamOps *ops, ScrDyn *(*view)(void *)) {
  if (!scr_worker_stdio_ops) scr_worker_stdio_ops = ops;
  if (!scr_worker_stdio_box) scr_worker_stdio_box = view;
  if (!scr_worker_stdin_box) scr_worker_stdin_box = view;
}

/* worker.stdin: each chunk written goes to the worker as an
 * SCR_WORKER_STDIN event, and end() sends the end of the input. The
 * callbacks hold the thread record, not the view (the view owns the
 * stream). Writes after the worker exited are dropped. */
static void *scr_worker_thread_retain_v(void *thread) { return scr_worker_thread_retain(thread); }
static void scr_worker_thread_release_v(void *thread) { scr_worker_thread_release(thread); }

static void scr_worker_stdin_write(ScrClosure *cb, ScrStream *stream, ScrBytes *chunk) {
  ScrWorkerThread *thread = scr_box_get_ref(cb->caps[0]); /* +1 */
  /* an empty chunk pushes nothing in Node's process.stdin */
  if (chunk->len) scr_worker_thread_post_stdin(thread, chunk->data, chunk->len, false);
  scr_worker_thread_release(thread);
  scr_worker_stdio_ops->write_done(stream, NULL);
}

static void scr_worker_stdin_final(ScrClosure *cb, ScrStream *stream) {
  ScrWorkerThread *thread = scr_box_get_ref(cb->caps[0]); /* +1 */
  scr_worker_thread_post_stdin(thread, NULL, 0, true);
  scr_worker_thread_release(thread);
  scr_worker_stdio_ops->final_done(stream, NULL);
}

static ScrClosure *scr_worker_stdin_callback(ScrWorkerThread *thread, void *fire) {
  ScrClosure *cb = scr_closure_new(fire, 1);
  cb->caps[0] = scr_box_new_obj(scr_worker_thread_retain_v, scr_worker_thread_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_worker_thread_retain(thread));
  return cb;
}

static ScrStream *scr_worker_stdin_new(ScrWorkerThread *thread) {
  return scr_worker_stdio_ops->writable("WritableWorkerStdio",
      scr_worker_stdin_callback(thread, (void *)scr_worker_stdin_write), scr_worker_stdin_write,
      scr_worker_stdin_callback(thread, (void *)scr_worker_stdin_final), scr_worker_stdin_final);
}

static void scr_worker_view_trace(void *ptr, ScrTraceVisit visit, void *ctx) {
  ScrWorkerView *view = ptr;
  visit(view->events, ctx);
  for (ScrTermWait *wait = view->termination; wait; wait = wait->next) visit(wait->promise, ctx);
  visit(view->disposal, ctx);
  for (int i = 0; i < 2; i++) {
    visit(view->stdio[i], ctx);
    visit(view->stdio_box[i], ctx);
  }
  visit(view->stdin_stream, ctx);
  visit(view->stdin_box, ctx);
  visit(view->performance_box, ctx);
  for (ScrCpuWait *wait = view->cpu_wait; wait; wait = wait->next) visit(wait->promise, ctx);
}

static void scr_worker_view_gcfree(void *ptr) {
  ScrWorkerView *view = ptr;
  /* Both the reference-count destructor and the cycle collector end here,
   * so the port's listener order (its allocation and its retained event
   * names) is released on either path. */
  scr_worker_order_clear(view);
  scr_worker_thread_release(view->thread);
  if (view->broadcast && view->channel && !view->closed) scr_broadcast_leave(view->channel);
  scr_channel_release(view->channel);
  if (view->name) scr_str_release(view->name);
  if (view->et) scr_et_broadcast_ops->core_free(view->et);
  while (view->queued_head) {
    ScrMailEvent *event = view->queued_head;
    view->queued_head = event->next;
    scr_mail_event_free(event);
  }
  scr_obj_free_note();
  scr_cyc_free(ptr);
}

static void scr_worker_view_destroy(void *ptr) {
  ScrWorkerView *view = ptr;
  scr_emitter_release(view->events);
  while (view->termination) {
    ScrTermWait *wait = view->termination;
    view->termination = wait->next;
    scr_promise_release(wait->promise);
    free(wait);
  }
  scr_promise_release(view->disposal);
  scr_dyn_release(view->performance_box);
  while (view->cpu_wait) {
    ScrCpuWait *wait = view->cpu_wait;
    view->cpu_wait = wait->next;
    scr_promise_release(wait->promise);
    free(wait);
  }
  for (int i = 0; i < 2; i++) {
    if (view->stdio[i]) scr_worker_stdio_ops->release(view->stdio[i]);
    scr_dyn_release(view->stdio_box[i]);
  }
  if (view->stdin_stream) scr_worker_stdio_ops->release(view->stdin_stream);
  scr_dyn_release(view->stdin_box);
  scr_worker_view_gcfree(ptr);
}

static void *scr_worker_view_retain(void *ptr) {
  ScrWorkerView *view = ptr;
  view->rc++;
  return view;
}

static void scr_worker_view_release(void *ptr) {
  ScrWorkerView *view = ptr;
  if (!view) return;
  if (--view->rc == 0) {
    scr_cyc_dead(view);
    scr_rc_destroy(view, scr_worker_view_destroy);
  } else scr_cyc_released(view);
}

/** Node's setupPortReferencing on a 'message' listener: for a port the
 * listener refs the port's own handle, starting it on the first one and
 * unrefing it when the last one leaves. A Worker runs the same bookkeeping
 * on its internal public port, which is a handle of its own: a 'message'
 * listener refs that port and leaves the thread handle's own ref alone, so
 * a Worker that was never unref()ed keeps the loop alive without listeners
 * and one that was unref()ed stays unreferenced when a listener leaves. */
/* Node's setupPortReferencing for a port: it is referenced while any
 * 'message' listener exists (Node's port keeps the emitter surface and the
 * EventTarget surface in one registry) and the first listener starts it.
 * The emitter's own on/off and the EventTarget attribute/listeners both
 * end here, so removing one kind while the other remains keeps the port
 * referenced, as Node's does. */
static void scr_port_message_refs(ScrWorkerView *view) {
  double listeners = view->et && scr_et_broadcast_ops->listener_count
                         ? scr_et_broadcast_ops->listener_count(view->et, "message")
                         : 0;
  ScrStr *name = scr_str_new("message", 7);
  listeners += scr_emitter_listener_count(view->events, name);
  scr_str_release(name);
  bool present = listeners > 0;
  /* Node's setupPortReferencing: only the transitions change the reference —
   * the first 'message' listener refs the port and starts it, the last one
   * leaving unrefs it. An explicit port.ref()/port.unref() between them
   * stands (removing one of several listeners changes nothing), and
   * non-'message' listeners never touch it. */
  if (present == view->message_listeners) return;
  view->message_listeners = present;
  if (present) {
    view->started = true;
    view->referenced = true;
  } else {
    view->referenced = false;
  }
}

/* ── NodeEventTarget's one listener map ──────────────────────────────
 * A Node MessagePort keeps its EventTarget listeners and its EventEmitter
 * listeners in one map, so eventNames() lists both spellings in
 * first-registration order and the counting and removal methods walk the
 * same entries. The two surfaces are separate stores here (an emitter
 * registry and an EventTarget core), so a port keeps the shared order
 * beside them: a type enters with its first listener anywhere and leaves
 * when its last one is gone. */
static void scr_worker_order_note(ScrWorkerView *view, const ScrStr *name, bool from_core) {
  if (!view->port || scr_str_is_symbol_key(name)) return;
  for (size_t i = 0; i < view->order_n; i++)
    if (view->order[i].name->len == name->len &&
        !memcmp(view->order[i].name->data, name->data, name->len)) return;
  ScrWorkerOrderEntry *grown = realloc(view->order, (view->order_n + 1) * sizeof *grown);
  if (!grown) scr_trap("scriptc: out of memory\n");
  view->order = grown;
  view->order[view->order_n].name = scr_str_retain((ScrStr *)name);
  view->order[view->order_n].core_first = from_core;
  view->order_n++;
}

/* The surface that registered the type first; emit walks that one first, as
 * Node's single ordered set does for the usual monotone registrations. */
static bool scr_worker_order_core_first(ScrWorkerView *view, const ScrStr *name) {
  for (size_t i = 0; i < view->order_n; i++)
    if (view->order[i].name->len == name->len &&
        !memcmp(view->order[i].name->data, name->data, name->len))
      return view->order[i].core_first;
  return false;
}

static void scr_worker_order_drop(ScrWorkerView *view, const ScrStr *name) {
  for (size_t i = 0; i < view->order_n; i++) {
    if (view->order[i].name->len != name->len ||
        memcmp(view->order[i].name->data, name->data, name->len)) continue;
    scr_str_release(view->order[i].name);
    memmove(view->order + i, view->order + i + 1, (view->order_n - i - 1) * sizeof *view->order);
    view->order_n--;
    return;
  }
}

static void scr_worker_order_clear(ScrWorkerView *view) {
  for (size_t i = 0; i < view->order_n; i++) scr_str_release(view->order[i].name);
  free(view->order);
  view->order = NULL;
  view->order_n = 0;
}

/* The type's listeners on the port's EventTarget core (the on<type>
 * attribute counts as one, as Node's port bookkeeping does). */
static double scr_worker_core_count(ScrWorkerView *view, const ScrStr *name) {
  if (!view->port || !view->et || !scr_et_broadcast_ops || !scr_et_broadcast_ops->listener_count)
    return 0;
  if (scr_str_is_symbol_key(name)) return 0;
  return scr_et_broadcast_ops->listener_count(view->et, name->data);
}

/* Whether the core still holds a map entry for the type: a root outlives its
 * last listener when a `{ once: true }` listener fired or the on<type>
 * attribute was cleared by assignment, and Node keeps reporting such a type
 * from eventNames() until an explicit removal deletes it. */
static bool scr_worker_core_has_type(ScrWorkerView *view, const ScrStr *name) {
  if (!view->port || !view->et || !scr_et_broadcast_ops || !scr_et_broadcast_ops->has_type)
    return false;
  if (scr_str_is_symbol_key(name)) return false;
  return scr_et_broadcast_ops->has_type(view->et, name->data);
}

/* A type whose last listener left both surfaces leaves the order. */
static void scr_worker_drop_if_empty(ScrWorkerView *view, const ScrStr *name) {
  if (!view->port || scr_str_is_symbol_key(name)) return;
  if (scr_emitter_listener_count(view->events, (ScrStr *)name) > 0) return;
  if (scr_worker_core_has_type(view, name)) return;
  scr_worker_order_drop(view, name);
}

static void scr_worker_message_listeners(void *ptr, const ScrStr *name, bool present) {
  ScrWorkerView *view = ptr;
  if (present) scr_worker_order_note(view, name, false);
  else scr_worker_drop_if_empty(view, name);
  if (name->len != 7 || memcmp(name->data, "message", 7)) return;
  if (!view->port) view->message_port_ref = present;
  else scr_port_message_refs(view);
}

/** The internal 'newListener'/'removeListener' listeners Node registers at
 * construction: EventEmitter's Worker registers its own ref bookkeeping
 * there, and NodeEventTarget's MessagePort keeps the DOM listener map and
 * the EventEmitter surface in sync. They make eventNames(), listenerCount()
 * and listeners() of a Worker or MessagePort report the meta events, as
 * Node's do. The reference bookkeeping is the observer above, so these only
 * have to exist. */
static ScrDyn *scr_worker_meta_noop(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  return scr_dyn_retain(scr_dyn_undefined());
}

static void scr_worker_seed_meta_listeners(ScrEmitter *em) {
  static const char *const names[] = {"newListener", "removeListener"};
  for (size_t i = 0; i < 2; i++) {
    ScrDyn *listener =
      scr_dyn_new_func(scr_closure_new(NULL, 0), scr_worker_meta_noop, 1, "(name)", "");
    ScrStr *name = scr_str_new(names[i], strlen(names[i]));
    scr_emitter_release(scr_emitter_on_any(em, name, listener, false, false));
    scr_str_release(name);
    scr_dyn_release(listener);
  }
}

static ScrWorkerView *scr_worker_view_new(bool port) {
  static ScrCycType cyc_type = { &scr_worker_view_trace, &scr_worker_view_gcfree, SCR_CYC_KIND_WORKER_VIEW };
  ScrWorkerView *view = scr_cyc_alloc(sizeof(*view), &cyc_type);
  view->rc = 1;
  view->port = port;
  view->referenced = !port;
  view->events = scr_emitter_new();
  view->events->cls = port ? "MessagePort" : "Worker";
  scr_emitter_observe(view->events, scr_worker_message_listeners, view);
  /* Only MessagePort is a NodeEventTarget: its seeded meta listeners never
   * fire on add/remove, its emit is raw dispatch, and a repeated listener
   * is a no-op. Worker extends EventEmitter, so it keeps the meta events,
   * the duplicate registrations and emit's unhandled-'error' throw. */
  if (port) scr_emitter_mark_plain(view->events);
  scr_worker_seed_meta_listeners(view->events);
  scr_obj_alloc_note();
  return view;
}

static ScrDyn *scr_worker_refusal(const char *operation) {
  ScrStr *message = scr_str_new(operation, strlen(operation));
  scr_throw_lowering_fence(message);
  scr_str_release(message);
  return NULL;
}

static bool scr_worker_empty_transfer(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    bool empty = view && !scr_exc_pending() && scr_worker_empty_transfer(view);
    scr_dyn_release(view);
    return empty;
  }
  return value->kind == SCR_DYN_UNDEF || (value->kind == SCR_DYN_ARR && value->v.arr.len == 0);
}

/* ── markAsUntransferable ─────────────────────────────────────────────── */

/* An ArrayBuffer's mark lives on its storage (Buffer pool slabs carry it
 * from creation, as in Node); other marked objects stay listed, retained,
 * for this thread's lifetime. A typed array shares its owner's storage with
 * its ArrayBuffer, so views are listed by their own identity. */
static SCR_TL ScrDyn **scr_untransferable;
static SCR_TL size_t scr_untransferable_count;
static SCR_TL size_t scr_untransferable_capacity;

static void scr_untransferable_cleanup(void) {
  for (size_t i = 0; i < scr_untransferable_count; i++) scr_dyn_release(scr_untransferable[i]);
  free(scr_untransferable);
  scr_untransferable = NULL;
  scr_untransferable_count = scr_untransferable_capacity = 0;
}

static bool scr_untransferable_same(const ScrDyn *a, const ScrDyn *b) {
  if (a->kind != b->kind) return false;
  switch (a->kind) {
  case SCR_DYN_BYTES: return a->v.bytes == b->v.bytes;
  case SCR_DYN_HANDLE: return a->v.handle.ptr == b->v.handle.ptr;
  case SCR_DYN_TYPED_REF: return a->v.typed_ref.ptr == b->v.typed_ref.ptr;
  default: return scr_dyn_strict_eq(a, b);
  }
}

/* typeof value is "object" or "function", and value is not null */
static bool scr_untransferable_object(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_UNDEF: case SCR_DYN_NULL: case SCR_DYN_BOOL: case SCR_DYN_NUM:
  case SCR_DYN_STR: case SCR_DYN_BIGINT: case SCR_DYN_SYMBOL: return false;
  default: return true;
  }
}

bool scr_worker_is_marked_untransferable(ScrDyn *value) {
  if (!scr_untransferable_object(value)) return false;
  if (scr_array_buffer_is(value) || scr_shared_array_buffer_is(value))
    return ((ScrBytes *)value->v.handle.ptr)->untransferable;
  for (size_t i = 0; i < scr_untransferable_count; i++)
    if (scr_untransferable_same(scr_untransferable[i], value)) return true;
  return false;
}

/* markAsUntransferable(value): primitives are left as they are */
void scr_worker_mark_untransferable(ScrDyn *value) {
  if (!scr_untransferable_object(value) || scr_worker_is_marked_untransferable(value)) return;
  if (scr_array_buffer_is(value) || scr_shared_array_buffer_is(value)) {
    ((ScrBytes *)value->v.handle.ptr)->untransferable = true;
    return;
  }
  if (scr_untransferable_count == scr_untransferable_capacity) {
    if (!scr_untransferable_capacity && scr_context_atexit(scr_untransferable_cleanup) != 0)
      scr_trap("scriptc: out of memory\n");
    size_t capacity = scr_untransferable_capacity ? scr_untransferable_capacity * 2 : 8;
    ScrDyn **values = realloc(scr_untransferable, capacity * sizeof *values);
    if (!values) scr_trap("scriptc: out of memory\n");
    scr_untransferable = values;
    scr_untransferable_capacity = capacity;
  }
  scr_untransferable[scr_untransferable_count++] = scr_dyn_retain(value);
}

/* postMessage's transfer argument: an array, or { transfer } (+1, or NULL
 * when empty) */
static ScrDyn *scr_worker_transfer_list(ScrDyn *arg) {
  ScrDyn *value = arg;
  ScrDyn *own = NULL;
  if (value->kind == SCR_DYN_TYPED_REF) {
    own = scr_dyn_typed_ref_materialize(value);
    if (!own || scr_exc_pending()) {
      scr_dyn_release(own);
      return NULL;
    }
    value = own;
  }
  if (value->kind == SCR_DYN_OBJ) {
    ScrDyn *list = scr_dyn_obj_get(value, "transfer", 8);
    ScrDyn *result = list ? scr_worker_transfer_list(list) : NULL;
    scr_dyn_release(own);
    return result;
  }
  if (value->kind == SCR_DYN_ARR && value->v.arr.len > 0) {
    for (size_t i = 0; i < value->v.arr.len; i++) {
      ScrDyn *item = value->v.arr.items[i];
      if (item && scr_worker_is_marked_untransferable(item)) {
        scr_dyn_release(own);
        scr_throw_domex("DataCloneError", "Cannot transfer object of unsupported type.");
        return NULL;
      }
      /* Node validates the list before it clones: one port listed twice is a
       * duplicate, and a value that is no transferable at all is invalid. An
       * ArrayBuffer or SharedArrayBuffer keeps the documented refusal. */
      if (item && item->kind == SCR_DYN_HANDLE && item->v.handle.tag == SCR_DYNH_MESSAGE_PORT) {
        for (size_t j = 0; j < i; j++) {
          const ScrDyn *earlier = value->v.arr.items[j];
          if (earlier && earlier->kind == SCR_DYN_HANDLE &&
              earlier->v.handle.tag == SCR_DYNH_MESSAGE_PORT &&
              earlier->v.handle.ptr == item->v.handle.ptr) {
            scr_dyn_release(own);
            scr_throw_domex("DataCloneError", "Transfer list contains duplicate MessagePort");
            return NULL;
          }
        }
        continue;
      }
      if (scr_array_buffer_is(item) || scr_shared_array_buffer_is(item)) continue;
      scr_dyn_release(own);
      scr_throw_domex("DataCloneError", "Found invalid value in transferList.");
      return NULL;
    }
    ScrDyn *result = scr_dyn_retain(value);
    scr_dyn_release(own);
    return result;
  }
  bool empty = scr_worker_empty_transfer(value);
  scr_dyn_release(own);
  if (!empty) scr_worker_refusal("This postMessage transfer argument is not supported yet");
  return NULL;
}

static bool scr_worker_transfer_has(const ScrDyn *transfer, const ScrWorkerView *view) {
  for (size_t i = 0; i < transfer->v.arr.len; i++) {
    const ScrDyn *item = transfer->v.arr.items[i];
    if (item && item->kind == SCR_DYN_HANDLE && item->v.handle.ptr == view) return true;
  }
  return false;
}

/* Whether a method name is `name`: first characters compare inline, so
 * the dispatch ladders below call strcmp only for names that can match. */
static inline bool method_is(const char *method, const char *name) {
  return method[0] == name[0] && strcmp(method, name) == 0;
}

/* ── worker.performance ──────────────────────────────────────────────── */

/* A reading's `idle` or `active` as JS reads it (Node's internal
 * eventLoopUtilization subtracts the properties without validating them). */
static bool scr_worker_perf_field(const ScrDyn *reading, const char *name, double *out) {
  ScrDyn *value = scr_dyn_obj_read(reading, name, strlen(name));
  bool ok = value && !scr_exc_pending() && scr_dyn_number_coerce_js(value, out);
  scr_dyn_release(value);
  return ok && !scr_exc_pending();
}

/* The utilization object, in Node's key order. */
static ScrDyn *scr_worker_perf_object(double idle, double active) {
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "idle", 4, scr_dyn_new_num(idle));
  scr_dyn_obj_set(object, "active", 6, scr_dyn_new_num(active));
  scr_dyn_obj_set(object, "utilization", 11, scr_dyn_new_num(active / (idle + active)));
  return object;
}

/* Node's internalEventLoopUtilization over the worker's loop: `now` is this
 * thread's process.hrtime, the loop start and idle time are the worker's. */
static ScrDyn *scr_worker_perf_elu_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  double id = scr_box_get_f64(closure->caps[0]);
  ScrWorkerView *view = scr_worker_views;
  while (view && (double)scr_worker_thread_id(view->thread) != id) view = view->next;
  double loop_start = 0;
  double idle = 0;
  /* Node answers zeros before the worker's online event has been delivered —
   * its own metrics may already be published by then — and after the worker
   * exits, when its view has left this thread's registry. */
  bool live = view && view->online && !view->closed &&
              scr_worker_thread_metrics(view->thread, &loop_start, &idle) && loop_start > 0;
  /* Node answers a literal zero object, never a 0/0 utilization. */
  if (!live) {
    ScrDyn *zeros = scr_dyn_new_obj();
    scr_dyn_obj_set(zeros, "idle", 4, scr_dyn_new_num(0));
    scr_dyn_obj_set(zeros, "active", 6, scr_dyn_new_num(0));
    scr_dyn_obj_set(zeros, "utilization", 11, scr_dyn_new_num(0));
    return zeros;
  }
  /* A static reading crossing into the checked-dynamic tree reads its
   * fields through the materialized view. */
  ScrDyn *materialized[2] = {NULL, NULL};
  const ScrDyn *util[2] = {NULL, NULL};
  for (size_t i = 0; i < 2; i++) {
    if ((size_t)argc <= i || !scr_dyn_truthy(args[i])) continue;
    if (args[i]->kind == SCR_DYN_TYPED_REF) {
      materialized[i] = scr_dyn_typed_ref_materialize(args[i]);
      if (!materialized[i] || scr_exc_pending()) {
        scr_dyn_release(materialized[0]);
        scr_dyn_release(materialized[1]);
        return NULL;
      }
      util[i] = materialized[i];
    } else {
      util[i] = args[i];
    }
  }
  double out_idle = idle;
  double out_active = scr_perf_now() - loop_start - idle;
  if (util[1]) {
    /* Node reads utilization1's fields as JS reads them, so a missing first
     * reading throws its TypeError. */
    const ScrDyn *first = util[0] ? util[0] : scr_dyn_undefined();
    double idle1, active1, idle2, active2;
    if (!scr_worker_perf_field(first, "idle", &idle1) ||
        !scr_worker_perf_field(first, "active", &active1) ||
        !scr_worker_perf_field(util[1], "idle", &idle2) ||
        !scr_worker_perf_field(util[1], "active", &active2)) {
      scr_dyn_release(materialized[0]);
      scr_dyn_release(materialized[1]);
      return NULL;
    }
    out_idle = idle1 - idle2;
    out_active = active1 - active2;
  } else if (util[0]) {
    double idle0, active0;
    if (!scr_worker_perf_field(util[0], "idle", &idle0) ||
        !scr_worker_perf_field(util[0], "active", &active0)) {
      scr_dyn_release(materialized[0]);
      return NULL;
    }
    out_idle = idle - idle0;
    out_active = out_active - active0;
  }
  ScrDyn *object = scr_worker_perf_object(out_idle, out_active);
  scr_dyn_release(materialized[0]);
  scr_dyn_release(materialized[1]);
  return object;
}

/* worker.performance: an object holding the bound eventLoopUtilization, as
 * Node's constructor makes one for every Worker. */
static ScrDyn *scr_worker_performance_object(ScrWorkerView *view) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[0], (double)scr_worker_thread_id(view->thread));
  ScrDyn *function = scr_dyn_new_func(closure, &scr_worker_perf_elu_call, 2,
                                      "(utilization1, utilization2)", "eventLoopUtilization");
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "eventLoopUtilization", 20, function);
  return object;
}

/* worker.performance over a Worker handle (the compiler's worker.performance
 * libCall): the same object reading the property answers. */
ScrDyn *scr_worker_performance(ScrDyn *value) {
  if (!value || value->kind != SCR_DYN_HANDLE || value->v.handle.tag != SCR_DYNH_WORKER)
    return scr_dyn_retain(scr_dyn_undefined());
  ScrWorkerView *view = value->v.handle.ptr;
  if (!view->performance_box) view->performance_box = scr_worker_performance_object(view);
  return scr_dyn_retain(view->performance_box);
}

/* ── worker.cpuUsage() ──────────────────────────────────────────────── */

/* Node's cpuUsage() answers a rejection with ERR_WORKER_NOT_RUNNING when
 * its handle cannot be asked: before the worker's thread runs and after it
 * stopped. */
static void scr_worker_cpu_reject(ScrPromise *promise) {
  static const char message[] = "Worker instance not running";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_WORKER_NOT_RUNNING");
  scr_promise_reject_pending(promise);
}

/* validateObject(prev, 'prev') + validateNumber(prev.user|system, 0,
 * Number.MAX_SAFE_INTEGER), with Node's latest error shapes: a non-object is
 * ERR_INVALID_ARG_TYPE on the argument, a non-number field is
 * ERR_INVALID_ARG_TYPE on the property, and a field outside the bound is
 * ERR_OUT_OF_RANGE. */
static bool scr_worker_cpu_prev(ScrDyn *prev, double *user, double *system) {
  /* A static value crossing into the checked-dynamic tree reads its fields
   * through the materialized view. */
  ScrDyn *materialized = NULL;
  if (prev->kind == SCR_DYN_TYPED_REF) {
    materialized = scr_dyn_typed_ref_materialize(prev);
    if (!materialized || scr_exc_pending()) {
      scr_dyn_release(materialized);
      return false;
    }
    prev = materialized;
  }
  if (prev->kind == SCR_DYN_NULL || prev->kind == SCR_DYN_ARR || !scr_dyn_is_object(prev)) {
    char detail[64], msg[192];
    const char *received = scr_dyn_specific_type(prev, detail, sizeof detail);
    int len = snprintf(msg, sizeof msg,
                       "The \"prev\" argument must be of type object. Received %s", received);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_TYPE");
    scr_dyn_release(materialized);
    return false;
  }
  static const char *const names[] = {"user", "system"};
  double *out[2] = {user, system};
  for (int i = 0; i < 2; i++) {
    char name[16];
    snprintf(name, sizeof name, "prev.%s", names[i]);
    ScrDyn *value = scr_dyn_obj_read(prev, names[i], strlen(names[i]));
    bool number = value && !scr_exc_pending() && value->kind == SCR_DYN_NUM;
    if (!number) {
      if (!scr_exc_pending())
        scr_dyn_prop_type_fail(name, "of type number", value ? value : scr_dyn_undefined());
      scr_dyn_release(value);
      scr_dyn_release(materialized);
      return false;
    }
    double n = value->v.num;
    scr_dyn_release(value);
    if (!(n == n && n >= 0 && n <= 9007199254740991.0)) {
      char received[48], msg[192];
      scr_num_received(n, received);
      int len = snprintf(msg, sizeof msg,
                         "The value of \"%s\" is out of range. It must be >= 0 && <= "
                         "9007199254740991. Received %s",
                         name, received);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
      scr_dyn_release(materialized);
      return false;
    }
    *out[i] = n;
  }
  scr_dyn_release(materialized);
  return true;
}

/* Fulfills the request with Node's {user, system}, in microseconds; with a
 * `prev` reading, the difference from it. */
static void scr_worker_cpu_fulfill(ScrCpuWait *wait, double user, double system) {
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "user", 4,
                  scr_dyn_new_num(wait->delta ? user - wait->prev_user : user));
  scr_dyn_obj_set(object, "system", 6,
                  scr_dyn_new_num(wait->delta ? system - wait->prev_system : system));
  scr_promise_fulfill_ref(wait->promise, object, scr_dyn_retain_v, scr_dyn_release_v,
                          scr_dyn_trace_v);
}

/* Answers the request whose sequence number is `seq`; a request that is not
 * in flight (the worker exited first) leaves nothing to settle. */
static bool scr_worker_cpu_settle(ScrWorkerView *view, int seq, double user, double system) {
  ScrCpuWait **slot = &view->cpu_wait;
  while (*slot && (*slot)->seq != seq) slot = &(*slot)->next;
  ScrCpuWait *wait = *slot;
  if (!wait) return false;
  *slot = wait->next;
  scr_worker_cpu_fulfill(wait, user, system);
  scr_promise_release(wait->promise);
  free(wait);
  return true;
}

/* worker.cpuUsage([prev]): the worker's thread measures its own CPU usage,
 * which Node reads from the worker's isolate. */
/* worker.getHeapStatistics(): the runtime's heap figures in V8's field
 * names and order. A compiled program has one heap for every thread, so the
 * numbers describe the process's runtime heap (the same sample
 * v8.getHeapStatistics() takes) rather than a per-thread V8 isolate. */
ScrPromise *scr_worker_heap_statistics(ScrDyn *value) {
  ScrPromise *promise = scr_promise_new();
  ScrWorkerView *view = NULL;
  if (value != NULL && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WORKER)
    view = value->v.handle.ptr;
  if (view == NULL || !view->online || view->closed) {
    static const char message[] = "Worker instance not running";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_WORKER_NOT_RUNNING");
    scr_promise_reject_pending(promise);
    return promise;
  }
  double heap_total = 0, heap_used = 0;
  scr_heap_stats(&heap_total, &heap_used);
  double limit = scr_available_memory() + heap_used;
  ScrDyn *stats = scr_dyn_new_obj();
  scr_dyn_obj_set(stats, "total_heap_size", 15, scr_dyn_new_num(heap_total));
  scr_dyn_obj_set(stats, "total_heap_size_executable", 26, scr_dyn_new_num(0));
  scr_dyn_obj_set(stats, "total_physical_size", 19, scr_dyn_new_num(heap_total));
  scr_dyn_obj_set(stats, "total_available_size", 20,
                  scr_dyn_new_num(limit > heap_used ? limit - heap_used : 0));
  scr_dyn_obj_set(stats, "used_heap_size", 14, scr_dyn_new_num(heap_used));
  scr_dyn_obj_set(stats, "heap_size_limit", 15, scr_dyn_new_num(limit));
  scr_dyn_obj_set(stats, "malloced_memory", 15, scr_dyn_new_num(0));
  scr_dyn_obj_set(stats, "peak_malloced_memory", 20, scr_dyn_new_num(0));
  scr_dyn_obj_set(stats, "does_zap_garbage", 16, scr_dyn_new_bool(false));
  scr_dyn_obj_set(stats, "number_of_native_contexts", 25, scr_dyn_new_num(1));
  scr_dyn_obj_set(stats, "number_of_detached_contexts", 27, scr_dyn_new_num(0));
  scr_dyn_obj_set(stats, "total_global_handles_size", 25, scr_dyn_new_num(0));
  scr_dyn_obj_set(stats, "used_global_handles_size", 24, scr_dyn_new_num(0));
  scr_dyn_obj_set(stats, "external_memory", 15, scr_dyn_new_num(0));
  /* The promise keeps the sample's reference (the cpuUsage pattern). */
  scr_promise_fulfill_ref(promise, stats, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  return promise;
}

static ScrDyn *scr_worker_cpu_usage(ScrWorkerView *view, ScrDyn *prev) {
  double prev_user = 0;
  double prev_system = 0;
  bool delta = scr_dyn_truthy(prev);
  if (delta && !scr_worker_cpu_prev(prev, &prev_user, &prev_system)) return NULL;
  ScrPromise *promise = scr_promise_new();
  ScrDyn *result = scr_dyn_new_promise(promise);
  int seq = ++view->cpu_seq;
  if (!view->online || view->closed || !scr_worker_thread_post_cputime(view->thread, seq)) {
    scr_worker_cpu_reject(promise);
    scr_promise_release(promise);
    return result;
  }
  ScrCpuWait *wait = malloc(sizeof *wait);
  if (!wait) scr_trap("scriptc: out of memory\n");
  wait->seq = seq;
  wait->delta = delta;
  wait->prev_user = prev_user;
  wait->prev_system = prev_system;
  wait->promise = scr_promise_retain(promise);
  wait->next = view->cpu_wait;
  view->cpu_wait = wait;
  scr_promise_release(promise);
  return result;
}

/* An event key. A Worker's emitter follows property-key conversion: a symbol
 * stays a symbol key and every other value converts with String(). A
 * MessagePort's on/once/off names are DOM strings, which a symbol has no
 * conversion for — Node reports that as ERR_INVALID_ARG_TYPE rather than the
 * language's TypeError. */
static ScrStr *scr_worker_event_name(const ScrWorkerView *view, const ScrDyn *value) {
  if (view->port && value->kind == SCR_DYN_SYMBOL) {
    static const char message[] = "Value is a Symbol and cannot be converted to a string.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  return scr_emitter_name_dyn(value);
}

/* A name for the key-table walks. Node's NodeEventTarget converts a symbol
 * with String() in listenerCount() and removeAllListeners(), so Symbol("s")
 * names the string key "Symbol(s)" — a port cannot register a listener under
 * a symbol (its on, once and off convert with the DOM string conversion and
 * throw), so that string key is the only one it can match. A Worker is an
 * EventEmitter: a symbol there stays its own key, as in Node. */
static ScrStr *scr_worker_key_table_name(const ScrWorkerView *view, const ScrDyn *value) {
  if (view->port && value->kind == SCR_DYN_SYMBOL) return scr_sym_to_string(value->v.symbol.value);
  return scr_emitter_name_dyn(value);
}

static ScrDyn *scr_worker_view_invoke(void *ptr, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  (void)what;
  ScrWorkerView *view = ptr;
  if (method_is(method, "ref") || method_is(method, "unref")) {
    view->referenced = method_is(method, "ref");
    /* Node's Worker ref()/unref() reach its public port as well; a port has
     * only the one handle its listener bookkeeping already toggles. */
    if (!view->port) view->message_port_ref = view->referenced;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (view->port && method_is(method, "hasRef"))
    return scr_dyn_new_bool(view->referenced && (!view->closed || (view->channel && view->closing)));
  if (!view->port && method_is(method, "cpuUsage"))
    return scr_worker_cpu_usage(view, argc ? args[0] : scr_dyn_undefined());
  if (!view->port && method_is(method, "getHeapStatistics")) {
    /* The dyn view retains the promise; the sample's reference is dropped. */
    ScrPromise *promise = scr_worker_heap_statistics(self);
    ScrDyn *result = scr_dyn_new_promise(promise);
    scr_promise_release(promise);
    return result;
  }
  if (!view->port && method_is(method, "terminate")) {
    /* Node's terminate() returns a fresh promise per call. It refs the worker
     * before stopping the thread, so the loop stays up until the exit event
     * settles it; a worker that had already stopped answers undefined. */
    view->referenced = true;
    view->message_port_ref = true;
    ScrPromise *promise = scr_promise_new();
    ScrDyn *result = scr_dyn_new_promise(promise);
    if (view->closed) {
      /* Node answers undefined once the worker has stopped, which the
       * declared Promise<number> cannot spell; a typed handler would reject
       * there, an untyped one reads exactly Node's value. */
      scr_promise_fulfill_ref(promise, scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v,
                              scr_dyn_release_v, scr_dyn_trace_v);
    } else {
      ScrTermWait *wait = malloc(sizeof *wait);
      if (!wait) scr_trap("scriptc: out of memory\n");
      wait->promise = scr_promise_retain(promise);
      wait->next = view->termination;
      view->termination = wait;
      scr_worker_thread_terminate(view->thread);
    }
    scr_promise_release(promise);
    return result;
  }
  if (method_is(method, "postMessage")) {
    /* Worker drops messages after exit before validating or cloning. A
     * closed MessagePort still validates its payload, as Node does. */
    if (!view->port && view->closed) return scr_dyn_retain(scr_dyn_undefined());
    if (view->detached) return scr_dyn_retain(scr_dyn_undefined());
    if (!argc) {
      if (view->channel) {
        static const char message[] = "Not enough arguments to MessagePort.postMessage";
        scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
      } else {
        static const char message[] = "The \"value\" argument must be specified";
        scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
      }
      return NULL;
    }
    ScrDyn *transfer = argc > 1 ? scr_worker_transfer_list(args[1]) : NULL;
    if (scr_exc_pending()) return NULL;
    if (transfer && scr_worker_transfer_has(transfer, view)) {
      scr_dyn_release(transfer);
      scr_throw_domex("DataCloneError", "Transfer list contains source port");
      return NULL;
    }
    ScrMessage *message = scr_message_encode_transfer(args[0], transfer);
    scr_dyn_release(transfer);
    if (!message) return NULL;
    if (view->closed) scr_message_free(message);
    else if (view->channel)
      scr_channel_post(view->channel, view->side, message, SCR_WORKER_MESSAGE, SCR_WORKER_WAKE);
    else if (view->port) scr_worker_post_parent(message);
    else scr_worker_thread_post(view->thread, message);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  bool once = method_is(method, "once") || method_is(method, "prependOnceListener");
  bool prepend = method_is(method, "prependListener") || method_is(method, "prependOnceListener");
  if (once || prepend || method_is(method, "on") || method_is(method, "addListener")) {
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(listener, "listener");
    if (scr_exc_pending()) return NULL;
    ScrStr *name = scr_worker_event_name(view, argc ? args[0] : scr_dyn_undefined());
    if (!name) return NULL;
    /* NodeEventTarget keeps one entry per listener (Node's Set holds the
     * original function, once() included): any second registration of the
     * same function is a no-op. A Worker is an EventEmitter and adds the
     * same function again. */
    if (view->port && scr_emitter_has_listener_fn(view->events, name, listener)) {
      scr_str_release(name);
      return scr_dyn_retain(self);
    }
    scr_emitter_release(scr_emitter_on_flex(view->events, name, listener, once, prepend));
    scr_str_release(name);
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (method_is(method, "off") || method_is(method, "removeListener")) {
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(listener, "listener");
    if (scr_exc_pending()) return NULL;
    ScrStr *name = scr_worker_event_name(view, argc ? args[0] : scr_dyn_undefined());
    if (!name) return NULL;
    scr_emitter_release(scr_emitter_off_dyn(view->events, name, listener));
    /* NodeEventTarget's off removes an addEventListener listener too; the
     * on<type> attribute keeps its registration, as Node's does. */
    if (view->port && !scr_exc_pending() && view->et && scr_et_broadcast_ops &&
        scr_worker_core_count(view, name) > 0) {
      ScrDyn *type = scr_dyn_new_str(name);
      ScrDyn *core_args[2] = {type, (ScrDyn *)listener};
      ScrDyn *out = NULL;
      scr_et_broadcast_ops->method(view->et, self, "removeEventListener", core_args, 2, &out);
      scr_dyn_release(out);
      scr_dyn_release(type);
      if (scr_exc_pending()) {
        scr_str_release(name);
        return NULL;
      }
      scr_worker_drop_if_empty(view, name);
    }
    scr_str_release(name);
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (method_is(method, "removeAllListeners")) {
    bool all = !argc || args[0]->kind == SCR_DYN_UNDEF;
    /* No DOMString here: Node's removeAllListeners walks the key table, so a
     * symbol name is its String() form instead of throwing. */
    ScrStr *name = all ? NULL : scr_worker_key_table_name(view, args[0]);
    if (!all && !name) return NULL;
    scr_emitter_release(scr_emitter_remove_all(view->events, name, all));
    /* One map in Node: the EventTarget listeners leave too, the on<type>
     * attribute's registration with them. */
    if (view->port && view->et && scr_et_broadcast_ops) {
      scr_et_broadcast_ops->remove_all(view->et, name ? name->data : NULL);
      if (name) scr_worker_drop_if_empty(view, name);
      else scr_worker_order_clear(view);
    }
    scr_str_release(name);
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (method_is(method, "listenerCount")) {
    ScrStr *name = scr_worker_key_table_name(view, argc ? args[0] : scr_dyn_undefined());
    if (!name) return NULL;
    double count;
    if (view->port) {
      /* NodeEventTarget counts both surfaces' listeners and ignores the
       * function argument. */
      count = scr_emitter_listener_count(view->events, name) + scr_worker_core_count(view, name);
    } else {
      count = argc > 1 && args[1]->kind != SCR_DYN_UNDEF
        ? scr_emitter_listener_count_dyn(view->events, name, args[1])
        : scr_emitter_listener_count(view->events, name);
    }
    scr_str_release(name);
    return scr_dyn_new_num(count);
  }
  /* NodeEventTarget's emit/eventNames/setMaxListeners/getMaxListeners —
   * the surface MessagePort and Worker share with EventEmitter. A port's
   * emit is the target's raw dispatch: exactly one argument (Node's
   * `emit(type, arg)` ignores the rest), no 'error' throw with no listener,
   * and no meta events; typed listeners are reached through the same
   * registry. A Worker's emit is EventEmitter's: every argument reaches
   * the listeners, and an unhandled 'error' throws. */
  if (method_is(method, "emit")) {
    /* A port's raw dispatch takes a string type only (Node's error is
     * reproduced below); a Worker's EventEmitter takes any key. */
    if (view->port && (!argc || args[0]->kind != SCR_DYN_STR)) {
      char detail[64];
      const char *received =
        scr_dyn_specific_type(argc ? args[0] : scr_dyn_undefined(), detail, sizeof detail);
      char msg[192];
      int n = snprintf(msg, sizeof msg,
                       "The \"type\" argument must be of type string. Received %s", received);
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_ARG_TYPE");
      return NULL;
    }
    ScrStr *name = scr_emitter_name_dyn(argc ? args[0] : scr_dyn_undefined());
    if (!name) return NULL;
    bool had;
    if (view->port) {
      /* One map in Node: the EventTarget listeners and the EventEmitter
       * listeners run in registration order, the first with a plain Event of
       * the type and the second with the raw argument. Which kind goes first
       * is the one that registered the type first. */
      had = false;
      bool core = view->et && scr_et_broadcast_ops && scr_worker_core_count(view, name) > 0;
      bool core_first = scr_worker_order_core_first(view, name);
      ScrDyn *arg = argc > 1 ? args[1] : scr_dyn_undefined();
      for (int pass = 0; pass < 2; pass++) {
        bool take_core = core_first ? pass == 0 : pass == 1;
        if (take_core) {
          if (core) {
            scr_et_broadcast_ops->dispatch_type(view->et, self, name->data);
            had = true;
          }
        } else if (scr_emitter_emit_flex(view->events, name, &arg, 1)) {
          had = true;
        }
      }
    } else {
      had = scr_emitter_emit_any(view->events, name, args + 1, argc > 1 ? argc - 1 : 0);
    }
    scr_str_release(name);
    return scr_exc_pending() ? NULL : scr_dyn_new_bool(had);
  }
  if (method_is(method, "eventNames")) {
    if (!view->port) return scr_emitter_event_names(view->events);
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t i = 0; i < view->order_n; i++) {
      /* A type that lost its listeners without a notification is not
       * reported; the order normally drops it as it empties. */
      if (scr_emitter_listener_count(view->events, view->order[i].name) == 0 &&
          !scr_worker_core_has_type(view, view->order[i].name)) continue;
      scr_dyn_arr_push(out, scr_dyn_new_str(view->order[i].name));
    }
    return out;
  }
  if (method_is(method, "setMaxListeners")) {
    scr_emitter_release(
      scr_emitter_set_max_chk(view->events, argc ? args[0] : scr_dyn_undefined()));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (method_is(method, "getMaxListeners"))
    return scr_dyn_new_num(scr_emitter_get_max(view->events));
  if (view->port && method_is(method, "close")) {
    if (argc && args[0]->kind != SCR_DYN_UNDEF) {
      scr_dyn_check_listener(args[0], "callback");
      if (scr_exc_pending()) return NULL;
      ScrStr *name = scr_str_new("close", 5);
      scr_emitter_release(scr_emitter_on_flex(view->events, name, args[0], true, false));
      scr_str_release(name);
    }
    if (!view->closed && !view->detached) {
      view->closing = true;
      view->closed = true;
      if (view->channel) {
        view->close_seq = ++scr_channel_close_seq;
        view->close_gen = scr_channel_poll_gen;
        scr_channel_close(view->channel, view->side);
      } else {
        scr_worker_port_close();
      }
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (view->port && method_is(method, "start")) {
    view->started = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  /* A MessagePort's EventTarget surface: addEventListener, removeEventListener
   * and dispatchEvent run on its listener core. A 'message' listener starts
   * the port, as Node does. */
  if (view->port && (method_is(method, "addEventListener") ||
                     method_is(method, "removeEventListener") || method_is(method, "dispatchEvent"))) {
    ScrEventTargetCore *core = scr_port_core(view);
    /* addEventListener runs the core's DOM steps — the options are read
     * first, an aborted signal returns before the type is read, then the
     * type is converted once — and hands the registered name back for the
     * eventNames order. */
    if (core && method_is(method, "addEventListener") && scr_et_broadcast_ops->add_listener) {
      ScrStr *type = NULL;
      ScrDyn *added = scr_et_broadcast_ops->add_listener(core, args, argc, &type);
      if (type) {
        if (type->len == 7 && !memcmp(type->data, "message", 7)) scr_port_message_refs(view);
        if (!scr_exc_pending()) {
          if (scr_worker_core_count(view, type) > 0) scr_worker_order_note(view, type, true);
          else scr_worker_drop_if_empty(view, type);
        }
        scr_str_release(type);
      }
      return scr_exc_pending() ? NULL : added;
    }
    ScrDyn *out = NULL;
    if (core && scr_et_broadcast_ops->method(core, self, method, args, argc, &out)) {
      if (argc > 0 && args[0]->kind == SCR_DYN_STR && args[0]->v.str->len == 7 &&
          !memcmp(args[0]->v.str->data, "message", 7))
        scr_port_message_refs(view);
      return out;
    }
  }
  return scr_worker_refusal("This Worker or MessagePort method is not supported yet");
}

static ScrDyn *scr_worker_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind != SCR_DYN_HANDLE ||
      (self->v.handle.tag != SCR_DYNH_WORKER && self->v.handle.tag != SCR_DYNH_MESSAGE_PORT)) {
    static const char message[] = "Illegal invocation";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_THIS");
  } else {
    size_t method = (size_t)scr_box_get_f64(closure->caps[0]);
    result = scr_worker_view_invoke(self->v.handle.ptr, self, scr_worker_method_names[method], args, argc, "worker method");
  }
  scr_dyn_release(self);
  return result;
}

/* worker[Symbol.asyncDispose](): Node's `await this.terminate()`, a
 * promise of undefined once the worker exited. */
static ScrDyn *scr_worker_async_dispose_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind != SCR_DYN_HANDLE || self->v.handle.tag != SCR_DYNH_WORKER) {
    static const char message[] = "Illegal invocation";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_THIS");
  } else {
    ScrWorkerView *view = self->v.handle.ptr;
    if (!view->disposal) {
      view->disposal = scr_promise_new();
      if (view->closed) scr_promise_fulfill_ref(view->disposal,
        scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      /* Node's disposal promise resolves with undefined, not the exit code
       * its terminate() answers (the exit event settles it below). */
      else if (!view->termination) scr_worker_thread_terminate(view->thread);
    }
    result = scr_dyn_new_promise(view->disposal);
  }
  scr_dyn_release(self);
  return result;
}

/* Node's makeResourceLimits: a fresh object with the four limits in its
 * key order. */
static ScrDyn *scr_worker_limits_object(const double limits[4]) {
  static const char *const names[] = {"maxYoungGenerationSizeMb", "maxOldGenerationSizeMb",
                                      "codeRangeSizeMb", "stackSizeMb"};
  ScrDyn *object = scr_dyn_new_obj();
  for (size_t i = 0; i < 4; i++)
    scr_dyn_obj_set(object, names[i], strlen(names[i]), scr_dyn_new_num(limits[i]));
  return object;
}

/* worker[Symbol.asyncDispose] */
static ScrDyn *scr_worker_symbol_get(void *ptr, const ScrDyn *key) {
  (void)ptr;
  if (!scr_dyn_is_async_dispose_symbol(key)) return NULL;
  ScrClosure *closure = scr_closure_new((void *)&scr_worker_async_dispose_call, 0);
  return scr_dyn_new_func(closure, &scr_worker_async_dispose_call, 0, "()", "[Symbol.asyncDispose]");
}

/* A listener left the core however it left — removeEventListener, a
 * `{ once: true }` listener firing, or an AbortSignal removing it. Only a
 * 'message' listener moves the port's loop reference, as Node's
 * setupPortReferencing hooks only that event. */
static void scr_port_listeners_changed(void *ctx, const ScrStr *type) {
  if (type == NULL) return;
  ScrWorkerView *view = ctx;
  /* A type whose last listener left the EventTarget surface leaves the
   * eventNames order unless the EventEmitter surface still holds one. */
  scr_worker_drop_if_empty(view, type);
  if (type->len != 7 || memcmp(type->data, "message", 7) != 0) return;
  scr_port_message_refs(view);
}

/* A port's EventTarget core, created on first use (Node's MessagePort is an
 * EventTarget beside its EventEmitter surface). */
static ScrEventTargetCore *scr_port_core(ScrWorkerView *view) {
  /* A program that never names BroadcastChannel or MessageChannel does not
   * link the EventTarget unit; its ports keep the emitter surface only. */
  if (!scr_et_broadcast_ops) return NULL;
  if (!view->et) {
    view->et = scr_et_broadcast_ops->core_new("MessagePort");
    if (view->et && scr_et_broadcast_ops->watch)
      scr_et_broadcast_ops->watch(view->et, view, scr_port_listeners_changed);
  }
  return view->et;
}

static ScrDyn *scr_worker_view_get(void *ptr, const char *key, size_t length) {
  ScrWorkerView *view = ptr;
  if (!view->port && length == 8 && !memcmp(key, "threadId", 8))
    return scr_dyn_new_num(view->closed ? -1 : (double)scr_worker_thread_id(view->thread));
  /* Node reports the running worker's V8 heap configuration; an exited
   * worker answers {}. */
  if (!view->port && length == 5 && !memcmp(key, "stdin", 5)) {
    if (!view->stdin_stream) return scr_dyn_new_null();
    if (!view->stdin_box) view->stdin_box = scr_worker_stdin_box(view->stdin_stream);
    return scr_dyn_retain(view->stdin_box);
  }
  if (!view->port && length == 6 && (!memcmp(key, "stdout", 6) || !memcmp(key, "stderr", 6))) {
    /* Node's getter always answers the stream: without the option the
     * worker's writes also reach the process's own output. */
    int i = key[3] == 'e' ? 1 : 0;
    if (!view->stdio[i]) {
      if (!scr_worker_stdio_ops) return scr_dyn_new_null();
      view->stdio[i] = scr_worker_stdio_ops->readable("ReadableWorkerStdio");
    }
    if (!view->stdio_box[i]) view->stdio_box[i] = scr_worker_stdio_box(view->stdio[i]);
    return scr_dyn_retain(view->stdio_box[i]);
  }
  if (!view->port && length == 10 && !memcmp(key, "threadName", 10)) {
    if (view->closed) return scr_dyn_new_null();
    /* a copy: the thread record's name is freed with the record, which
     * a string value can outlive */
    const ScrStr *name = scr_worker_thread_name(view->thread);
    ScrStr *copy = scr_str_new(name->data, name->len);
    ScrDyn *value = scr_dyn_new_str(copy);
    scr_str_release(copy);
    return value;
  }
  if (!view->port && length == 11 && !memcmp(key, "performance", 11)) {
    if (!view->performance_box) view->performance_box = scr_worker_performance_object(view);
    return scr_dyn_retain(view->performance_box);
  }
  if (!view->port && length == 14 && !memcmp(key, "resourceLimits", 14))
    /* Node's getter: the limits the constructor asked for, or {} once the
     * worker stopped. */
    return view->closed ? scr_dyn_new_obj() : scr_worker_limits_object(view->limits);
  if (view->port &&
      ((length == 9 && !memcmp(key, "onmessage", 9)) ||
       (length == 14 && !memcmp(key, "onmessageerror", 14)))) {
    char type[16];
    memcpy(type, key + 2, length - 2);
    type[length - 2] = '\0';
    ScrEventTargetCore *core = scr_port_core(view);
    return core ? scr_et_broadcast_ops->handler_get(core, type) : NULL;
  }
  for (size_t i = 0; i < sizeof scr_worker_methods / sizeof scr_worker_methods[0]; i++) {
    const char *name = scr_worker_method_names[i];
    if (strlen(name) != length || memcmp(name, key, length)) continue;
    if ((view->port && (!strcmp(name, "terminate") || !strcmp(name, "cpuUsage"))) ||
        (!view->port && (!strcmp(name, "start") || !strcmp(name, "close") || !strcmp(name, "hasRef") ||
                         !strcmp(name, "addEventListener") || !strcmp(name, "removeEventListener") ||
                         !strcmp(name, "dispatchEvent")))) return NULL;
    if (!scr_worker_methods[i]) {
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], (double)i);
      scr_worker_methods[i] = scr_dyn_new_func(closure, scr_worker_method_call, 0, "", name);
    }
    return scr_dyn_retain(scr_worker_methods[i]);
  }
  return NULL;
}

/* port.onmessage = fn / port.onmessageerror = fn: the EventTarget handler,
 * and Node starts the port when a 'message' handler is set. */
static bool scr_worker_view_set(void *ptr, const char *key, size_t length, const ScrDyn *value) {
  ScrWorkerView *view = ptr;
  if (!view->port) return false;
  if ((length == 9 && !memcmp(key, "onmessage", 9)) ||
      (length == 14 && !memcmp(key, "onmessageerror", 14))) {
    char type[16];
    memcpy(type, key + 2, length - 2);
    type[length - 2] = '\0';
    ScrEventTargetCore *core = scr_port_core(view);
    if (!core) return false;
    scr_et_broadcast_ops->handler_set(core, type, value);
    ScrStr *name = scr_str_new(type, strlen(type));
    if (scr_worker_core_count(view, name) > 0) scr_worker_order_note(view, name, true);
    else scr_worker_drop_if_empty(view, name);
    scr_str_release(name);
    if (!strcmp(type, "message")) scr_port_message_refs(view);
    return true;
  }
  return false;
}

static bool scr_workers_pending(void) {
  /* a worker's process.stdin waiting for worker.stdin chunks */  if (scr_stdin_fed && scr_stdin_fed_waiting && scr_stdin_fed_waiting()) return true;
  for (ScrWorkerView *view = scr_worker_views; view; view = view->next)
    if (view->referenced || view->message_port_ref) return true;
  for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
    if (view->closing || (view->started && view->referenced && !view->closed && !view->detached))
      return true;
  return scr_worker_port && (scr_worker_port->closing ||
    (scr_worker_port->referenced && !scr_worker_port->closed));
}

static int scr_worker_events_pollfd(void) {
  return scr_worker_events ? scr_mailbox_pollfd(scr_worker_events) : -1;
}

/* a channel port with something to deliver: its 'close', the other end's
 * close, or messages once started */
static bool scr_channel_port_ready(ScrWorkerView *view) {
  if (view->closing || view->phase_left || view->phase_close) return true;
  if (view->closed || view->detached) return false;
  if (view->started && scr_channel_count(view->channel, view->side) > 0) return true;
  return scr_channel_peer_closed(view->channel, view->side) &&
         scr_channel_count(view->channel, view->side) == 0;
}

static bool scr_worker_events_ready(void) {
  for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
    if (scr_channel_port_ready(view)) return true;
  return (scr_worker_port && (scr_worker_port->closing ||
    (scr_worker_port->started && scr_worker_port->queued_head))) ||
    (scr_worker_events && scr_mailbox_pending(scr_worker_events));
}

static void scr_worker_events_wait(double milliseconds) {
  if (!scr_worker_events_ready()) scr_mailbox_wait(scr_worker_events, milliseconds);
}

/* The EventTarget form of one delivered value (a 'message' MessageEvent). */
static void scr_port_dispatch_message(ScrWorkerView *view, ScrDyn *argument) {
  if (!view->et) return;
  ScrDyn *self = scr_dyn_new_handle(view, SCR_DYNH_MESSAGE_PORT);
  scr_et_broadcast_ops->dispatch_message(view->et, self, argument);
  scr_dyn_release(self);
}

static void scr_worker_port_emit(ScrWorkerView *view, const char *event, ScrDyn *argument) {
  ScrStr *name = scr_str_new(event, strlen(event));
  scr_dyn_this_push(view, SCR_DYNH_MESSAGE_PORT);
  scr_emitter_emit_flex(view->events, name, argument ? &argument : NULL, argument ? 1 : 0);
  scr_dyn_this_pop();
  scr_str_release(name);
  /* A MessagePort is an EventTarget as well: its onmessage/addEventListener
   * listeners receive the event form (a MessageEvent for 'message', an
   * Event for 'close'). */
  if (!view->et) return;
  if (!strcmp(event, "message") || !strcmp(event, "messageerror"))
    scr_port_dispatch_message(view, argument ? argument : scr_dyn_undefined());
  else {
    ScrDyn *self = scr_dyn_new_handle(view, SCR_DYNH_MESSAGE_PORT);
    scr_et_broadcast_ops->dispatch_type(view->et, self, event);
    scr_dyn_release(self);
  }
}

/* The channel ports' turn, one event per call, in Node's phase order:
 * - the close phase: ports this thread closed, the latest close() first
 *   (libuv's close callbacks), each telling its other end;
 * - the poll phase: a snapshot of each port's queued messages (the batch
 *   Node delivers), ports in creation order, then the other ends' close
 *   notices in the order they were sent. scr_channel_more keeps the loop
 *   pass going until the phase is delivered, with microtasks between.
 * False when nothing was ready. */
static bool scr_channel_close_due(const ScrWorkerView *view) {
  return view->closing && view->close_gen < scr_channel_poll_gen;
}

static bool scr_channel_dispatch(void) {
  bool continuing = scr_channel_continuing;
  scr_channel_continuing = false;
  /* a loop pass runs one phase: the close phase, or the poll phase */
  if (scr_channel_closing_phase && !continuing) scr_channel_closing_phase = false;
  if (!scr_channel_phase && (!continuing || scr_channel_closing_phase)) {
    ScrWorkerView *latest = NULL;
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
      if (scr_channel_close_due(view) && (!latest || view->close_seq > latest->close_seq))
        latest = view;
    if (latest) {
      scr_worker_view_retain(latest);
      latest->closing = false;
      scr_channel_closing_phase = true;
      scr_channel_drop(latest->channel, latest->side);
      scr_channel_notify_close(latest->channel, latest->side, SCR_WORKER_WAKE);
      scr_worker_port_emit(latest, "close", NULL);
      scr_worker_view_release(latest);
      return true;
    }
    if (scr_channel_closing_phase) return false;
    bool any = false;
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next) {
      if (view->closed || view->detached) continue;
      size_t count = scr_channel_count(view->channel, view->side);
      view->phase_left = view->started ? count : 0;
      view->phase_close = count == 0 && scr_channel_peer_closed(view->channel, view->side) != 0;
      any = any || view->phase_left || view->phase_close;
    }
    if (!any) {
      scr_channel_poll_gen++;
      return false;
    }
    scr_channel_phase = true;
  }
  for (ScrWorkerView *view = scr_channel_ports; view; view = view->next) {
    if (!view->phase_left) continue;
    view->phase_left--;
    ScrMailEvent *event = scr_channel_take(view->channel, view->side);
    if (!event) {
      view->phase_left = 0;
      continue;
    }
    scr_worker_view_retain(view);
    if (event->message && !view->broadcast && scr_message_readable(event->message)) {
      /* Compiled listeners with a typed message entry read the message; the
       * EventTarget listeners receive the same decoded value as the emitter
       * listeners, as Node's dispatch does. */
      ScrStr *name = scr_str_new("message", 7);
      scr_dyn_this_push(view, SCR_DYNH_MESSAGE_PORT);
      ScrDyn *argument = NULL;
      scr_emitter_emit_message_out(view->events, name, event->message, scr_message_decode, &argument);
      scr_dyn_this_pop();
      scr_str_release(name);
      /* A typed emitter listener reads the message without decoding it, so
       * a port only builds the EventTarget value when it has an
       * EventTarget core (the program named the EventTarget surface). */
      if (view->et && !argument && !scr_exc_pending())
        argument = scr_message_decode(event->message);
      if (argument && !scr_exc_pending()) {
        if (view->et) scr_port_dispatch_message(view, argument);
        scr_dyn_release(argument);
      } else if (argument) {
        scr_dyn_release(argument);
      }
      scr_mail_event_free(event);
      scr_worker_view_release(view);
      return true;
    }
    ScrDyn *argument = event->message ? scr_message_decode(event->message) : NULL;
    if (argument && view->broadcast) {
      ScrDyn *self = scr_dyn_new_handle(view, SCR_DYNH_BROADCAST_CHANNEL);
      scr_et_broadcast_ops->dispatch_message(view->et, self, argument);
      scr_dyn_release(self);
    } else if (argument) {
      scr_worker_port_emit(view, "message", argument);
    }
    scr_dyn_release(argument);
    scr_mail_event_free(event);
    scr_worker_view_release(view);
    return true;
  }
  ScrWorkerView *first = NULL;
  uint64_t first_seq = 0;
  for (ScrWorkerView *view = scr_channel_ports; view; view = view->next) {
    if (!view->phase_close) continue;
    uint64_t seq = scr_channel_peer_closed(view->channel, view->side);
    if (!first || seq < first_seq) {
      first = view;
      first_seq = seq;
    }
  }
  if (!first) {
    scr_channel_phase = false;
    scr_channel_poll_gen++;
    return false;
  }
  first->phase_close = false;
  if (first->closed) return true;
  scr_worker_view_retain(first);
  first->closed = true;
  scr_channel_drop(first->channel, first->side);
  scr_worker_port_emit(first, "close", NULL);
  scr_worker_view_release(first);
  return true;
}

/* more of the current poll phase to deliver in this loop pass */
static bool scr_channel_more(void) {
  bool more = false;
  if (scr_channel_closing_phase) {
    /* the close phase runs its callbacks back to back */
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
      if (scr_channel_close_due(view)) more = true;
  } else if (scr_channel_phase) {
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
      if (view->phase_left || view->phase_close) more = true;
    if (!more) {
      scr_channel_phase = false;
      scr_channel_poll_gen++;
    }
  }
  scr_channel_continuing = more;
  return more;
}

static bool scr_workers_more(void) {
  if (scr_worker_batch_left > 0) {
    if (scr_worker_batch_next()) {
      scr_worker_batch_queued = true;
      return true;
    }
    scr_worker_batch_left = 0;
    scr_worker_batch_ended = true;
  }
  if (scr_channel_more()) return true;
  /* One more pass after a batch when a port has something to deliver: the
   * ports' poll phase for what its listeners posted. */
  bool ended = scr_worker_batch_ended;
  scr_worker_batch_ended = false;
  if (ended)
    for (ScrWorkerView *view = scr_channel_ports; view; view = view->next)
      if (scr_channel_port_ready(view)) return true;
  return false;
}

/* A worker's write to the process's own output: the pipe Node makes when the
 * stdout or stderr option is absent. */
static void scr_worker_pipe_output(int fd, const unsigned char *data, size_t length) {
  while (length > 0) {
#ifdef _WIN32
    int written = _write(fd, data, (unsigned)(length > INT_MAX ? INT_MAX : length));
#else
    ssize_t written = write(fd, data, length);
#endif
    if (written <= 0) return;
    data += written;
    length -= (size_t)written;
  }
}

static void scr_worker_dispatch(void) {
  bool batch = scr_worker_batch_queued;
  scr_worker_batch_queued = false;
  if (!batch && scr_channel_dispatch()) return;
  ScrWorkerView *port = scr_worker_port;
  if (port && port->closing) {
    port->closing = false;
    ScrStr *name = scr_str_new("close", 5);
    scr_dyn_this_push(port, SCR_DYNH_MESSAGE_PORT);
    scr_emitter_emit_flex(port->events, name, NULL, 0);
    scr_dyn_this_pop();
    scr_str_release(name);
    if (scr_exc_pending()) return;
  }
  ScrMailEvent *event;
  if (port && port->started && port->queued_head) {
    event = port->queued_head;
    port->queued_head = event->next;
    if (!port->queued_head) port->queued_tail = NULL;
    event->next = NULL;
  } else {
    event = scr_mailbox_take(scr_worker_events);
    if (event && event->kind == SCR_WORKER_MESSAGE) {
      if (scr_worker_batch_left == 0) {
        size_t queued = 1 + scr_mailbox_count_kind(scr_worker_events, SCR_WORKER_MESSAGE);
        scr_worker_batch_left = queued > SCR_WORKER_BATCH_MIN ? queued : SCR_WORKER_BATCH_MIN;
      }
      scr_worker_batch_left--;
    }
  }
  if (!event) return;
  if (event->kind == SCR_WORKER_WAKE) { scr_mail_event_free(event); return; }
  if (event->kind == SCR_WORKER_CPUTIME) {
    /* this thread is the worker: measure its own usage and answer */
    uint64_t user = 0, system = 0;
    scr_worker_thread_cpu_usage(&user, &system);
    scr_worker_post_parent_cputime(event->code, user, system);
    scr_mail_event_free(event);
    return;
  }
  if (event->kind == SCR_WORKER_CPUTIME_RESULT) {
    ScrWorkerView *target = scr_worker_views;
    while (target && scr_worker_thread_id(target->thread) != event->source) target = target->next;
    if (target && event->data && event->length == 2 * sizeof(uint64_t)) {
      uint64_t values[2];
      memcpy(values, event->data, sizeof values);
      scr_worker_cpu_settle(target, event->code, (double)values[0], (double)values[1]);
    }
    scr_mail_event_free(event);
    return;
  }
  if (event->kind == SCR_WORKER_STDIN) {
    ScrBytes *chunk = NULL;
    if (event->data) {
      chunk = scr_bytes_new(SCR_BYTES_U8, (double)event->length);
      memcpy(chunk->data, event->data, event->length);
      chunk->is_buffer = true;
    }
    scr_stdin_fed_push(chunk);
    scr_mail_event_free(event);
    return;
  }
  if (event->kind == SCR_WORKER_STDOUT || event->kind == SCR_WORKER_STDERR) {
    int stderr_stream = event->kind == SCR_WORKER_STDERR;
    ScrWorkerView *source = scr_worker_views;
    while (source && scr_worker_thread_id(source->thread) != event->source) source = source->next;
    ScrStream *stream = source ? source->stdio[stderr_stream] : NULL;
    /* Node pipes a stream the options did not capture to the process's own
     * output, and its pipe is registered at construction: the chunk reaches
     * that output before a listener the program adds later runs. */
    if (source && !source->stdio_captured[stderr_stream] && event->data && event->length)
      scr_worker_pipe_output(stderr_stream ? 2 : 1, event->data, event->length);
    /* Pushing into a Readable nothing reads grows its buffer without bound.
     * A stream the options captured is Node's own buffered Readable; one they
     * did not capture is drained by the pipe above, so it takes a chunk only
     * while a reader (a 'data' listener or resume()) is flowing, as Node's
     * pipe consumes everything else. */
    /* A chunk nobody will read is forwarded and dropped: pushing it into a
     * Readable that never drains it would grow the parent without bound. */
    bool wanted = stream != NULL && scr_worker_stdio_ops->wanted != NULL &&
                  scr_worker_stdio_ops->wanted(stream);
    if (stream && (source->stdio_captured[stderr_stream] || wanted)) {
      ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)event->length);
      memcpy(chunk->data, event->data, event->length);
      chunk->is_buffer = true;
      scr_worker_stdio_ops->push(stream, chunk);
      scr_bytes_release(chunk);
    }
    scr_mail_event_free(event);
    return;
  }
  ScrWorkerView *view = scr_worker_port;
  if (event->source) {
    view = scr_worker_views;
    while (view && scr_worker_thread_id(view->thread) != event->source) view = view->next;
  }
  if (!view) { scr_mail_event_free(event); return; }
  if (view->port && event->kind == SCR_WORKER_MESSAGE) {
    if (view->closed) { scr_mail_event_free(event); return; }
    if (!view->started) {
      if (view->queued_tail) view->queued_tail->next = event;
      else view->queued_head = event;
      view->queued_tail = event;
      return;
    }
  }
  scr_worker_view_retain(view);
  if (event->kind == SCR_WORKER_MESSAGE && event->message && scr_message_readable(event->message)) {
    /* Compiled listeners with a typed message entry read the message; a
     * port's EventTarget listeners receive the same decoded value. */
    if (!scr_exc_pending()) {
      ScrStr *name = scr_str_new("message", 7);
      scr_dyn_this_push(view, view->port ? SCR_DYNH_MESSAGE_PORT : SCR_DYNH_WORKER);
      ScrDyn *argument = NULL;
      scr_emitter_emit_message_out(view->events, name, event->message, scr_message_decode, &argument);
      scr_dyn_this_pop();
      scr_str_release(name);
      if (view->port) {
        if (!argument && !scr_exc_pending()) argument = scr_message_decode(event->message);
        if (argument && !scr_exc_pending()) {
          scr_port_dispatch_message(view, argument);
          scr_dyn_release(argument);
        } else if (argument) {
          scr_dyn_release(argument);
        }
      } else {
        scr_dyn_release(argument);
      }
    }
    scr_worker_view_release(view);
    scr_mail_event_free(event);
    return;
  }
  if (event->kind == SCR_WORKER_ONLINE) view->online = true;
  const char *event_name = event->kind == SCR_WORKER_ONLINE ? "online" :
    event->kind == SCR_WORKER_EXIT ? "exit" : event->kind == SCR_WORKER_ERROR ? "error" : "message";
  ScrDyn *argument = event->message ? scr_message_decode(event->message) :
    event->kind == SCR_WORKER_EXIT ? scr_dyn_new_num(event->code) : NULL;
  if (event->kind == SCR_WORKER_ONLINE) view->online = true;
  if (event->kind == SCR_WORKER_EXIT) {
    scr_worker_thread_join(view->thread);
    view->closed = true;
    /* The list holds a call at the head when it is made, and Node settles
     * the calls in the order they were made: reverse it first, so each
     * promise's reactions run in call order. */
    ScrTermWait *settle = NULL;
    while (view->termination) {
      ScrTermWait *wait = view->termination;
      view->termination = wait->next;
      wait->next = settle;
      settle = wait;
    }
    while (settle) {
      ScrTermWait *wait = settle;
      settle = wait->next;
      scr_promise_fulfill_ref(wait->promise, scr_dyn_new_num(event->code),
                              scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      scr_promise_release(wait->promise);
      free(wait);
    }
    /* Node's cpuUsage() handle is gone with the worker: a request still in
     * flight rejects rather than waiting for an answer that cannot come. */
    while (view->cpu_wait) {
      ScrCpuWait *wait = view->cpu_wait;
      view->cpu_wait = wait->next;
      scr_worker_cpu_reject(wait->promise);
      scr_promise_release(wait->promise);
      free(wait);
    }
    if (view->disposal) scr_promise_fulfill_ref(view->disposal,
      scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    ScrWorkerView **slot = &scr_worker_views;
    while (*slot != view) slot = &(*slot)->next;
    *slot = view->next;
    view->next = NULL;
    scr_worker_view_release(view); /* registry reference */
  }
  if (!scr_exc_pending()) {
    ScrStr *name = scr_str_new(event_name, strlen(event_name));
    scr_dyn_this_push(view, view->port ? SCR_DYNH_MESSAGE_PORT : SCR_DYNH_WORKER);
    if (event->kind == SCR_WORKER_ERROR) scr_emitter_emit_error_flex(view->events, argument);
    else scr_emitter_emit_flex(view->events, name, argument ? &argument : NULL, argument ? 1 : 0);
    scr_dyn_this_pop();
    scr_str_release(name);
    /* A message the typed entry cannot read (cyclic, aliased, transferred
     * ports) still reaches the port's EventTarget listeners, with the same
     * decoded value the emitter listeners got. */
    if (event->kind == SCR_WORKER_MESSAGE && view->port && view->et && argument)
      scr_port_dispatch_message(view, argument);
  }
  /* Node ends worker.stdout and worker.stderr as the worker exits: their
   * 'end' events follow 'exit'. */
  if (event->kind == SCR_WORKER_EXIT)
    for (int i = 0; i < 2; i++)
      if (view->stdio[i]) scr_worker_stdio_ops->end(view->stdio[i]);
  scr_dyn_release(argument);
  scr_worker_view_release(view);
  scr_mail_event_free(event);
}

static void scr_worker_events_cleanup(void) {
  scr_loop_set_workers(NULL, NULL, NULL, NULL, NULL);
  scr_loop_set_workers_more(NULL);
  scr_mailbox_close(scr_worker_events);
  for (ScrWorkerView *view = scr_worker_views; view; view = view->next)
    scr_worker_thread_terminate(view->thread);
  while (scr_worker_views) {
    ScrWorkerView *view = scr_worker_views;
    scr_worker_views = view->next;
    view->next = NULL;
    scr_worker_thread_join(view->thread);
    scr_worker_view_release(view);
  }
  scr_worker_view_release(scr_worker_port);
  scr_worker_port = NULL;
  while (scr_channel_ports) {
    ScrWorkerView *view = scr_channel_ports;
    scr_channel_ports = view->next;
    view->next = NULL;
    if (view->channel) scr_channel_set_owner(view->channel, view->side, NULL, SCR_WORKER_WAKE);
    /* a BroadcastChannel's name and listeners go now: program values
     * may still hold the handle past this teardown */
    if (view->broadcast) {
      if (!view->closed) {
        view->closed = true;
        scr_broadcast_leave(view->channel);
      }
      if (view->name) scr_str_release(view->name);
      view->name = NULL;
      if (view->et) scr_et_broadcast_ops->core_free(view->et);
      view->et = NULL;
    }
    scr_worker_view_release(view);
  }
  for (size_t i = 0; i < sizeof scr_worker_methods / sizeof scr_worker_methods[0]; i++) {
    scr_dyn_release(scr_worker_methods[i]);
    scr_worker_methods[i] = NULL;
  }
  for (size_t i = 0; i < sizeof scr_broadcast_methods / sizeof scr_broadcast_methods[0]; i++) {
    scr_dyn_release(scr_broadcast_methods[i]);
    scr_broadcast_methods[i] = NULL;
  }
  scr_mailbox_release(scr_worker_events);
  scr_worker_events = NULL;
}

static void scr_port_ops_install(void);
static bool scr_worker_events_install(void);

/* The node:events helpers read a BroadcastChannel's listeners through its
 * EventTarget core (scr_et_core_of). */
static ScrEventTargetCore *scr_broadcast_core_of(const ScrDyn *value) {
  if (!value || value->kind != SCR_DYN_HANDLE ||
      value->v.handle.tag != SCR_DYNH_BROADCAST_CHANNEL)
    return NULL;
  ScrWorkerView *view = value->v.handle.ptr;
  return view->broadcast ? view->et : NULL;
}

static void scr_worker_stdin_attach(void) { (void)scr_worker_events_install(); }

/* A worker thread's exit (scr_worker.c, before scr_context_cleanup): the
 * thread's worker-event state goes before the reference-count audit, which
 * the exit stack would otherwise run first. */
static void scr_worker_events_detach(void) {
  if (scr_worker_events) scr_worker_events_cleanup();
}

/* A worker thread installs its own machinery before its script runs
 * (scr_worker.c calls this through the attach hook). */
static void scr_worker_events_attach(void) { (void)scr_worker_events_install(); }

/* The node:events helpers' NodeEventTarget accessor (scr_event_target.c
 * accepts a Worker or MessagePort through this). */
static ScrEmitter *scr_node_event_target_emitter_of(const ScrDyn *self) {
  if (!self || self->kind != SCR_DYN_HANDLE) return NULL;
  if (self->v.handle.tag != SCR_DYNH_WORKER && self->v.handle.tag != SCR_DYNH_MESSAGE_PORT)
    return NULL;
  return ((ScrWorkerView *)self->v.handle.ptr)->events;
}

/* events.getMaxListeners over a Worker reads the EventEmitter's
 * `_maxListeners`; a MessagePort keeps its limit in kMaxEventTargetListeners,
 * which the static helper does not read, so it stays at the process
 * default. Both kinds store the limit in the emitter registry here, so only
 * the Worker answers from it. */
static bool scr_node_event_target_emitter_max(const ScrDyn *self, double *out) {
  if (!self || self->kind != SCR_DYN_HANDLE) return false;
  if (self->v.handle.tag != SCR_DYNH_WORKER) return false;
  ScrWorkerView *view = self->v.handle.ptr;
  if (view->port) return false;
  *out = scr_emitter_get_max(view->events);
  return true;
}

static const ScrNodeEventTargetOps scr_node_event_target_ops_value = {
    scr_node_event_target_emitter_of,
    scr_node_event_target_emitter_max,
};

static bool scr_worker_events_install(void) {
  if (scr_worker_events) return true;
  ScrMailbox *inbox = scr_worker_inbox();
  scr_worker_events = inbox ? scr_mailbox_retain(inbox) : scr_mailbox_new();
  if (!scr_worker_events) return false;
  scr_et_broadcast_core_fn = scr_broadcast_core_of;
  if (inbox && !scr_worker_port) scr_worker_port = scr_worker_view_new(true);
  static const ScrDynHandleOps worker_ops = {
    .cls = "Worker", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
    .invoke = scr_worker_view_invoke, .get = scr_worker_view_get,
    .symbol_get = scr_worker_symbol_get,
  };
  static const ScrDynHandleOps port_ops = {
    .cls = "MessagePort", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
    .invoke = scr_worker_view_invoke, .get = scr_worker_view_get, .set = scr_worker_view_set,
  };
  scr_dyn_handle_install(SCR_DYNH_WORKER, &worker_ops);
  scr_dyn_handle_install(SCR_DYNH_MESSAGE_PORT, &port_ops);
  scr_port_ops_install();
  scr_node_event_target_ops = &scr_node_event_target_ops_value;
  scr_worker_set_events_attach(scr_worker_events_attach);
  scr_worker_set_events_detach(scr_worker_events_detach);
  /* A worker thread releases its worker-event state explicitly before the
   * reference-count audit runs (the detach hook above); only the main
   * thread's cleanup rides the context's exit stack. */
  if (scr_context_is_main() && scr_context_atexit(scr_worker_events_cleanup) != 0)
    scr_trap("scriptc: out of memory\n");
  scr_loop_set_workers(scr_workers_pending, scr_worker_events_ready, scr_worker_dispatch,
    scr_worker_events_pollfd, scr_worker_events_wait);
  scr_loop_set_workers_more(scr_workers_more);
  return true;
}

/* ── MessageChannel ports ─────────────────────────────────────────────── */

static ScrWorkerView *scr_channel_port_new(ScrChannel *channel /*borrowed*/, int side) {
  ScrWorkerView *view = scr_worker_view_new(true);
  view->channel = scr_channel_retain(channel);
  view->side = side;
  /* the registry reference, in creation order (Node delivers ports in the
   * order their handles were made) */
  ScrWorkerView **tail = &scr_channel_ports;
  while (*tail) tail = &(*tail)->next;
  *tail = view;
  scr_channel_set_owner(channel, side, scr_worker_events, SCR_WORKER_WAKE);
  return view;
}

static ScrWorkerView *scr_port_view_of(const ScrDyn *value) {
  if (!value || value->kind != SCR_DYN_HANDLE || value->v.handle.tag != SCR_DYNH_MESSAGE_PORT)
    return NULL;
  return value->v.handle.ptr;
}

static ScrChannel *scr_port_channel_of(const ScrDyn *value, int *side) {
  ScrWorkerView *view = scr_port_view_of(value);
  if (!view || !view->channel || view->detached) return NULL;
  *side = view->side;
  return scr_channel_retain(view->channel);
}

static bool scr_port_is(const ScrDyn *value) { return scr_port_view_of(value) != NULL; }

/* the sender's port after a transfer: inert, and no longer this thread's */
static void scr_port_detach(const ScrDyn *value) {
  ScrWorkerView *view = scr_port_view_of(value);
  if (!view || !view->channel || view->detached) return;
  view->detached = true;
  view->closing = false;
  scr_channel_set_owner(view->channel, view->side, NULL, SCR_WORKER_WAKE);
}

static ScrDyn *scr_port_adopt(ScrChannel *channel, int side) {
  if (!scr_worker_events_install()) return NULL;
  ScrWorkerView *view = scr_channel_port_new(channel, side);
  return scr_dyn_new_handle(view, SCR_DYNH_MESSAGE_PORT);
}

static const ScrMessagePortOps scr_port_ops = {
    &scr_port_channel_of, &scr_port_is, &scr_port_detach, &scr_port_adopt, &scr_channel_release,
};

static void scr_port_ops_install(void) { scr_message_port_ops = &scr_port_ops; }

/* new MessageChannel(): { port1, port2 } */
ScrDyn *scr_worker_message_channel(void) {
  if (!scr_worker_events_install()) return NULL;
  ScrChannel *channel = scr_channel_new();
  ScrWorkerView *a = scr_channel_port_new(channel, 0);
  ScrWorkerView *b = scr_channel_port_new(channel, 1);
  scr_channel_release(channel);
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "port1", 5, scr_dyn_new_handle(a, SCR_DYNH_MESSAGE_PORT));
  scr_dyn_obj_set(object, "port2", 5, scr_dyn_new_handle(b, SCR_DYNH_MESSAGE_PORT));
  return object;
}

/* new MessagePort(...args): Node's constructor exists but refuses every
 * call this way, after its arguments evaluate (the compiler passes them). */
ScrDyn *scr_worker_port_construct(ScrDyn *args) {
  (void)args;
  static const char message[] = "Constructor cannot be called";
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_CONSTRUCT_CALL_INVALID");
  return NULL;
}

/* ── BroadcastChannel ───────────────────────────────────────────────── */


static ScrDyn *scr_broadcast_invoke(void *ptr, ScrDyn *self, const char *method,
                                    ScrDyn *const *args, size_t argc, const char *what) {
  (void)what;
  ScrWorkerView *view = ptr;
  if (method_is(method, "postMessage")) {
    if (view->closed) {
      scr_throw_domex("InvalidStateError", "BroadcastChannel is closed.");
      return NULL;
    }
    if (!argc) {
      static const char message[] = "The \"message\" argument must be specified";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
      return NULL;
    }
    ScrMessage *first = scr_message_encode(args[0]);
    if (!first) return NULL;
    ScrChannel **peers = NULL;
    size_t n = scr_broadcast_peers(view->name->data, view->name->len, view->channel, &peers);
    for (size_t i = 0; i < n; i++) {
      ScrMessage *message = i == 0 ? first : scr_message_encode(args[0]);
      if (i == 0) first = NULL;
      if (message) scr_channel_post(peers[i], 1, message, SCR_WORKER_MESSAGE, SCR_WORKER_WAKE);
      scr_channel_release(peers[i]);
    }
    free(peers);
    scr_message_free(first);
    return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  }
  if (method_is(method, "close")) {
    if (!view->closed) {
      view->closed = true;
      scr_broadcast_leave(view->channel);
      scr_channel_drop(view->channel, 0);
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (method_is(method, "ref") || method_is(method, "unref")) {
    view->referenced = method_is(method, "ref");
    return scr_dyn_retain(self);
  }
  ScrDyn *out = NULL;
  if (scr_et_broadcast_ops->method(view->et, self, method, args, argc, &out)) return out;
  return scr_worker_refusal("This BroadcastChannel method is not supported yet");
}

static ScrDyn *scr_broadcast_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind != SCR_DYN_HANDLE || self->v.handle.tag != SCR_DYNH_BROADCAST_CHANNEL) {
    static const char message[] = "Illegal invocation";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_THIS");
  } else {
    size_t method = (size_t)scr_box_get_f64(closure->caps[0]);
    result = scr_broadcast_invoke(self->v.handle.ptr, self, scr_broadcast_method_names[method], args,
                                  argc, "BroadcastChannel method");
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_broadcast_get(void *ptr, const char *key, size_t length) {
  ScrWorkerView *view = ptr;
  if (length == 4 && !memcmp(key, "name", 4)) return scr_dyn_new_str(view->name);
  if ((length == 9 && !memcmp(key, "onmessage", 9)) ||
      (length == 14 && !memcmp(key, "onmessageerror", 14))) {
    char type[16];
    memcpy(type, key + 2, length - 2);
    type[length - 2] = '\0';
    return scr_et_broadcast_ops->handler_get(view->et, type);
  }
  for (size_t i = 0; i < sizeof scr_broadcast_methods / sizeof scr_broadcast_methods[0]; i++) {
    const char *name = scr_broadcast_method_names[i];
    if (strlen(name) != length || memcmp(name, key, length)) continue;
    if (!scr_broadcast_methods[i]) {
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], (double)i);
      scr_broadcast_methods[i] = scr_dyn_new_func(closure, scr_broadcast_method_call, 0, "", name);
    }
    return scr_dyn_retain(scr_broadcast_methods[i]);
  }
  return NULL;
}

static bool scr_broadcast_set(void *ptr, const char *key, size_t length, const ScrDyn *value) {
  ScrWorkerView *view = ptr;
  if ((length == 9 && !memcmp(key, "onmessage", 9)) ||
      (length == 14 && !memcmp(key, "onmessageerror", 14))) {
    char type[16];
    memcpy(type, key + 2, length - 2);
    type[length - 2] = '\0';
    scr_et_broadcast_ops->handler_set(view->et, type, value);
    return true;
  }
  return false;
}

/* new BroadcastChannel(name): open and referenced until close() or
 * unref(); args is the argument vector as one dyn array */
ScrDyn *scr_worker_broadcast_channel(ScrDyn *args) {
  if (!scr_worker_events_install()) return NULL;
  if (args->kind != SCR_DYN_ARR || args->v.arr.len == 0) {
    static const char message[] = "The \"name\" argument must be specified";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrStr *name = scr_dyn_string_coerce_js(args->v.arr.items[0]);
  if (!name) return NULL;
  static SCR_TL bool installed = false;
  if (!installed) {
    installed = true;
    static const ScrDynHandleOps broadcast_ops = {
      .cls = "BroadcastChannel", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
      .invoke = scr_broadcast_invoke, .get = scr_broadcast_get, .set = scr_broadcast_set,
    };
    scr_dyn_handle_install(SCR_DYNH_BROADCAST_CHANNEL, &broadcast_ops);
  }
  ScrChannel *channel = scr_channel_new();
  ScrWorkerView *view = scr_channel_port_new(channel, 0);
  scr_channel_release(channel);
  view->broadcast = true;
  view->name = name;
  view->et = scr_et_broadcast_ops->core_new("BroadcastChannel");
  view->started = true;
  view->referenced = true;
  scr_broadcast_join(name->data, name->len, view->channel);
  return scr_dyn_new_handle(view, SCR_DYNH_BROADCAST_CHANNEL);
}

/* A port's next queued message. For parentPort: the messages held until
 * start(), then the inbox's next message from the parent (events from this
 * thread's own workers stay queued). */
static ScrMailEvent *scr_port_take(ScrWorkerView *view) {
  if (view->channel) return scr_channel_take(view->channel, view->side);
  ScrMailEvent *event = view->queued_head;
  if (!event) return scr_mailbox_take_kind(scr_worker_events, SCR_WORKER_MESSAGE, 0);
  view->queued_head = event->next;
  if (!view->queued_head) view->queued_tail = NULL;
  event->next = NULL;
  return event;
}

/* receiveMessageOnPort(port): { message } of the next queued message, or
 * undefined */
ScrDyn *scr_worker_receive_message_on_port(ScrDyn *port) {
  ScrWorkerView *view = scr_port_view_of(port);
  if (!view) {
    static const char message[] = "The \"port\" argument must be a MessagePort instance";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  ScrMailEvent *event = view->closed || view->detached ? NULL : scr_port_take(view);
  if (!event) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *value = event->message ? scr_message_decode(event->message) : NULL;
  scr_mail_event_free(event);
  if (!value) return NULL;
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "message", 7, value);
  return object;
}

/* ── environment data ─────────────────────────────────────────────────── */

/* setEnvironmentData's map for this thread: keys compare with
 * SameValueZero, and a deleted key re-added goes last. A worker starts
 * from a clone of its parent's entries taken by new Worker(). */
typedef struct {
  ScrDyn *key;
  ScrDyn *value;
} ScrEnvironmentEntry;
static SCR_TL ScrEnvironmentEntry *scr_environment;
static SCR_TL size_t scr_environment_count;
static SCR_TL size_t scr_environment_capacity;
static SCR_TL bool scr_environment_ready;

static void scr_environment_cleanup(void) {
  for (size_t i = 0; i < scr_environment_count; i++) {
    scr_dyn_release(scr_environment[i].key);
    scr_dyn_release(scr_environment[i].value);
  }
  free(scr_environment);
  scr_environment = NULL;
  scr_environment_count = scr_environment_capacity = 0;
  scr_environment_ready = false;
}

static void scr_environment_append(ScrDyn *key, ScrDyn *value) {
  if (scr_environment_count == scr_environment_capacity) {
    size_t capacity = scr_environment_capacity ? scr_environment_capacity * 2 : 4;
    ScrEnvironmentEntry *entries = realloc(scr_environment, capacity * sizeof *entries);
    if (!entries) scr_trap("scriptc: out of memory\n");
    scr_environment = entries;
    scr_environment_capacity = capacity;
  }
  scr_environment[scr_environment_count++] = (ScrEnvironmentEntry){key, value};
}

/* This thread's entries, the inherited ones decoded on first use. */
static bool scr_environment_load(void) {
  if (scr_environment_ready) return true;
  ScrDyn *inherited = scr_worker_take_environment();
  if (scr_exc_pending()) return false;
  scr_environment_ready = true;
  if (scr_context_atexit(scr_environment_cleanup) != 0) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; inherited && i + 1 < inherited->v.arr.len; i += 2)
    scr_environment_append(scr_dyn_arr_at(inherited, (double)i), scr_dyn_arr_at(inherited, (double)i + 1));
  scr_dyn_release(inherited);
  return true;
}

static bool scr_environment_key_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a->kind == SCR_DYN_NUM && b->kind == SCR_DYN_NUM)
    return a->v.num == b->v.num || (a->v.num != a->v.num && b->v.num != b->v.num);
  if (a->kind == SCR_DYN_TYPED_REF && b->kind == SCR_DYN_TYPED_REF)
    return a->v.typed_ref.ptr == b->v.typed_ref.ptr;
  return scr_dyn_strict_eq(a, b);
}

static size_t scr_environment_find(const ScrDyn *key) {
  for (size_t i = 0; i < scr_environment_count; i++)
    if (scr_environment_key_eq(scr_environment[i].key, key)) return i;
  return SIZE_MAX;
}

/* setEnvironmentData(key, value): undefined deletes the key. */
void scr_worker_set_environment_data(ScrDyn *key, ScrDyn *value) {
  if (!scr_environment_load()) return;
  size_t index = scr_environment_find(key);
  if (value->kind == SCR_DYN_UNDEF) {
    if (index == SIZE_MAX) return;
    scr_dyn_release(scr_environment[index].key);
    scr_dyn_release(scr_environment[index].value);
    memmove(&scr_environment[index], &scr_environment[index + 1],
            (scr_environment_count - index - 1) * sizeof *scr_environment);
    scr_environment_count--;
    return;
  }
  if (index != SIZE_MAX) {
    scr_dyn_release(scr_environment[index].value);
    scr_environment[index].value = scr_dyn_retain(value);
    return;
  }
  scr_environment_append(scr_dyn_retain(key), scr_dyn_retain(value));
}

ScrDyn *scr_worker_get_environment_data(ScrDyn *key) {
  if (!scr_environment_load()) return NULL;
  size_t index = scr_environment_find(key);
  return scr_dyn_retain(index == SIZE_MAX ? scr_dyn_undefined() : scr_environment[index].value);
}

/* new Worker()'s start message: workerData alone, or [workerData,
 * [key, value, ...]] when this thread has environment data, cloned in one
 * message as Node clones both in one postMessage. */
static ScrMessage *scr_worker_start_message(ScrDyn *data, ScrDyn *transfer, bool *environment_data) {
  *environment_data = false;
  if (!scr_environment_load()) return NULL;
  if (!scr_environment_count) return scr_message_encode_transfer(data, transfer);
  ScrDyn *entries = scr_dyn_new_arr();
  for (size_t i = 0; i < scr_environment_count; i++) {
    scr_dyn_arr_push(entries, scr_dyn_retain(scr_environment[i].key));
    scr_dyn_arr_push(entries, scr_dyn_retain(scr_environment[i].value));
  }
  ScrDyn *start = scr_dyn_new_arr();
  scr_dyn_arr_push(start, scr_dyn_retain(data));
  scr_dyn_arr_push(start, entries);
  ScrMessage *message = scr_message_encode_transfer(start, transfer);
  scr_dyn_release(start);
  *environment_data = message != NULL;
  return message;
}

/* worker_threads.resourceLimits: {} in the main thread, as Node; in a worker
 * the limits its Worker was created with, -1 for an unset heap limit and 4
 * for an unset stack. Node reports its isolate's V8 heap configuration
 * there; a compiled program has one heap for every thread. */
ScrDyn *scr_worker_resource_limits(void) {
  double limits[4];
  if (scr_context_is_main() || !scr_worker_thread_current_limits(limits))
    return scr_dyn_new_obj();
  return scr_worker_limits_object(limits);
}

ScrDyn *scr_worker_parent_port(void) {
  if (scr_context_is_main()) return scr_dyn_new_null();
  if (!scr_worker_events_install()) return NULL;
  if (!scr_worker_port) scr_worker_port = scr_worker_view_new(true);
  return scr_dyn_new_handle(scr_worker_port, SCR_DYNH_MESSAGE_PORT);
}

static ScrArr *scr_worker_arguments(ScrStr *filename, ScrDyn *argv) {
  if (argv->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(argv);
    ScrArr *result = !view || scr_exc_pending() ? NULL : scr_worker_arguments(filename, view);
    scr_dyn_release(view);
    return result;
  }
  if (argv->kind != SCR_DYN_UNDEF && argv->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("options.argv", "an instance of Array", argv);
    return NULL;
  }
  ScrArr *arguments = scr_arr_new(SCR_ELEM_STR, 0);
  scr_arr_push_ref(arguments, scr_str_retain(filename));
  if (argv->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < argv->v.arr.len; i++) {
      ScrDyn *value = scr_dyn_arr_at(argv, (double)i);
      ScrStr *text = scr_dyn_to_string(value, NULL);
      scr_dyn_release(value);
      if (!text || scr_exc_pending()) {
        scr_str_release(text);
        scr_arr_release(arguments);
        return NULL;
      }
      if (memchr(text->data, 0, text->len)) {
        scr_str_release(text);
        scr_arr_release(arguments);
        scr_worker_refusal("Worker argv strings containing null bytes are not supported yet");
        return NULL;
      }
      scr_arr_push_ref(arguments, text);
    }
  }
  return arguments;
}

/* The resourceLimits option: the thread's stack size in bytes (0 = the
 * default stack) and, always, the limits the Worker reports back in Node's
 * key order (young, old, codeRange, stack). Node reports -1 for an unset
 * V8 heap limit and 4 for an unset stack, and the option's own value
 * otherwise; a non-positive stack size is the default. A compiled program
 * has one heap for every thread, so the heap limits are answered and not
 * enforced. */
static bool scr_worker_limits(ScrDyn *limits, size_t *stack_size, double out[4]) {
  out[0] = -1;
  out[1] = -1;
  out[2] = -1;
  out[3] = 4;
  if (limits->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(limits);
    bool ok = view && !scr_exc_pending() && scr_worker_limits(view, stack_size, out);
    scr_dyn_release(view);
    return ok;
  }
  if (limits->kind != SCR_DYN_OBJ) return true;
  static const char *const heap[] = {"maxYoungGenerationSizeMb", "maxOldGenerationSizeMb", "codeRangeSizeMb"};
  for (size_t i = 0; i < sizeof heap / sizeof heap[0]; i++) {
    const ScrDyn *value = scr_dyn_obj_get(limits, heap[i], strlen(heap[i]));
    if (!value || value->kind != SCR_DYN_NUM) continue;
    /* A compiled program has one heap for every thread, so a heap limit
     * cannot be enforced. Requesting one is refused rather than accepted
     * and ignored: a caller that asked for a memory bound must not get a
     * worker that runs without one. The literal form of the same request
     * is refused at build time (lowering's refuseHeapLimits); this answers
     * the options object a program computes. */
    char msg[192];
    int len = snprintf(msg, sizeof msg,
                       "worker threads share the process heap, so resourceLimits.%s cannot be enforced",
                       heap[i]);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, "ERR_SCRIPTC_WORKER_HEAP_LIMITS");
    return false;
  }
  const ScrDyn *megabytes = scr_dyn_obj_get(limits, "stackSizeMb", 11);
  if (megabytes && megabytes->kind == SCR_DYN_NUM && megabytes->v.num > 0) {
    out[3] = megabytes->v.num;
    double bytes = megabytes->v.num * 1048576.0;
    if (bytes < 192.0 * 1024) bytes = 192.0 * 1024;
    *stack_size = bytes >= (double)(SIZE_MAX / 2) ? SIZE_MAX / 2 : (size_t)bytes;
  }
  return true;
}

/* worker_threads.SHARE_ENV: the unique symbol the env option compares
 * against. It stays per thread, like every other symbol identity (nothing
 * compares a symbol across threads); the thread record's own reference
 * keeps it for the thread's lifetime. */
static SCR_TL ScrSym *scr_worker_share_env_symbol;

static void scr_worker_share_env_cleanup(void) {
  scr_sym_release(scr_worker_share_env_symbol);
  scr_worker_share_env_symbol = NULL;
}

ScrSym *scr_worker_share_env(void) {
  if (!scr_worker_share_env_symbol) {
    static const char text[] = "nodejs.worker_threads.SHARE_ENV";
    ScrStr *description = scr_str_new(text, sizeof text - 1);
    scr_worker_share_env_symbol = scr_sym_new(description);
    scr_str_release(description);
    if (scr_atexit(scr_worker_share_env_cleanup)) scr_trap("scriptc: out of memory\n");
  }
  return scr_sym_retain(scr_worker_share_env_symbol);
}

/* The option value's own enumerable entries as the environment's variables:
 * each value converts with ToString, so an object's Symbol.toPrimitive runs
 * first (with the "string" hint, as String() does) and a getter or either
 * hook can throw, the throw propagating out of the Worker constructor. The
 * text is stored as UTF-8, lone surrogates replaced as the process
 * environment stores them. */
static bool scr_worker_env_entries(ScrContextEnv *environment, ScrDyn *value) {
  ScrDynEntryPairs *pairs = scr_dyn_obj_entry_pairs(value);
  if (!pairs) return false;
  bool ok = true;
  for (size_t i = 0; i < pairs->count; i++) {
    ScrDynEntryPair *pair = &pairs->pairs[i];
    ScrStr *text = scr_util_to_string(pair->value);
    if (!text) { ok = false; break; }
    char *name_owned, *value_owned;
    const char *name = scr_str_utf8(pair->key, &name_owned);
    const char *entry = scr_str_utf8(text, &value_owned);
    scr_context_env_assign(environment, name, entry);
    scr_str_utf8_end(value_owned);
    scr_str_utf8_end(name_owned);
    scr_str_release(text);
  }
  for (size_t i = 0; i < pairs->count; i++) {
    scr_str_release(pairs->pairs[i].key);
    scr_dyn_release(pairs->pairs[i].value);
  }
  scr_dyn_entry_pairs_free(pairs);
  return ok;
}

/* Node's env option (lib/internal/worker.js): an object's own enumerable
 * entries become the thread's process.env, null and undefined copy the
 * creating thread's environment, SHARE_ENV shares that environment, and
 * every other value is ERR_INVALID_ARG_TYPE. */
static bool scr_worker_env_option(ScrDyn *value, ScrContextEnv **environment, bool *share) {
  static const char expected[] =
      "of type object or one of undefined, null, or worker_threads.SHARE_ENV";
  *environment = NULL;
  *share = false;
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    *environment = scr_context_env_capture();
    return true;
  }
  if (value->kind == SCR_DYN_SYMBOL) {
    ScrSym *shared = scr_worker_share_env();
    bool is_shared = value->v.symbol.value == shared;
    scr_sym_release(shared);
    if (is_shared) {
      *share = true;
      return true;
    }
    scr_dyn_prop_type_fail("options.env", expected, value);
    return false;
  }
  if (
      value->kind != SCR_DYN_ARR && value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_BYTES &&
      value->kind != SCR_DYN_HANDLE && value->kind != SCR_DYN_PROMISE &&
      value->kind != SCR_DYN_TYPED_REF && value->kind != SCR_DYN_PROXY) {
    scr_dyn_prop_type_fail("options.env", expected, value);
    return false;
  }
  ScrContextEnv *entries = scr_context_env_new();
  if (!scr_worker_env_entries(entries, value)) {
    scr_context_env_release(entries);
    return false;
  }
  *environment = entries;
  return true;
}

static ScrDyn *scr_worker_new_options(double root, ScrStr *filename, ScrDyn *options) {
  if (!scr_worker_events_install()) return NULL;
  ScrDyn *data = scr_dyn_undefined();
  ScrDyn *argv = scr_dyn_undefined();
  ScrDyn *transfer_list = scr_dyn_undefined();
  ScrDyn *limits = scr_dyn_undefined();
  ScrDyn *name = scr_dyn_undefined();
  ScrDyn *env = scr_dyn_undefined();
  unsigned capture = 0;
  bool option_stdout = false;
  bool option_stderr = false;
  if (options->kind != SCR_DYN_UNDEF) {
    if (options->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "object", options);
      return NULL;
    }
    for (size_t i = 0; i < scr_dyn_obj_count(options); i++) {
      ScrDynProp entry = scr_dyn_obj_prop_at(options, i);
      if (entry.accessor) return scr_worker_refusal("Worker option accessors are not supported yet");
      if (entry.key_len == 10 && !memcmp(entry.key, "workerData", 10)) data = entry.value;
      else if (entry.key_len == 4 && !memcmp(entry.key, "argv", 4)) argv = entry.value;
      else if (entry.key_len == 12 && !memcmp(entry.key, "transferList", 12)) transfer_list = entry.value;
      else if (entry.key_len == 14 && !memcmp(entry.key, "resourceLimits", 14)) limits = entry.value;
      else if (entry.key_len == 4 && !memcmp(entry.key, "name", 4)) name = entry.value;
      else if (entry.key_len == 3 && !memcmp(entry.key, "env", 3)) env = entry.value;
      else if (entry.key_len == 6 && !memcmp(entry.key, "stdout", 6)) option_stdout = scr_dyn_truthy(entry.value);
      else if (entry.key_len == 6 && !memcmp(entry.key, "stderr", 6)) option_stderr = scr_dyn_truthy(entry.value);
      else if (entry.key_len == 5 && !memcmp(entry.key, "stdin", 5)) capture |= scr_dyn_truthy(entry.value) ? 4 : 0;
      else return scr_worker_refusal("This Worker constructor option is not supported yet");
    }
  }
  /* Both streams are captured: one the options did not ask for is piped to
   * the process's own output by the dispatcher, as Node pipes it. */
  capture |= 3;
  size_t stack_size = 0;
  double limits_out[4];
  if (!scr_worker_limits(limits, &stack_size, limits_out)) return NULL;
  ScrArr *arguments = scr_worker_arguments(filename, argv);
  if (!arguments) return NULL;
  ScrContextEnv *environment;
  bool share_environment;
  if (!scr_worker_env_option(env, &environment, &share_environment)) {
    scr_arr_release(arguments);
    return NULL;
  }
  /* Node: a truthy name must be a string, trimmed; otherwise WorkerThread */
  ScrStr *thread_name;
  if (scr_dyn_truthy(name)) {
    if (name->kind != SCR_DYN_STR) {
      scr_arr_release(arguments);
      scr_context_env_release(environment);
      scr_dyn_prop_type_fail("options.name", "of type string", name);
      return NULL;
    }
    thread_name = scr_str_trim(name->v.str);
  } else {
    thread_name = scr_str_new("WorkerThread", 12);
  }
  ScrDyn *transfer = scr_worker_transfer_list(transfer_list);
  if (scr_exc_pending()) {
    scr_arr_release(arguments);
    scr_str_release(thread_name);
    scr_context_env_release(environment);
    return NULL;
  }
  bool environment_data;
  ScrMessage *wire = scr_worker_start_message(data, transfer, &environment_data);
  if (capture & 4) scr_worker_set_stdin_attach(scr_worker_stdin_attach);
  scr_dyn_release(transfer);
  if (!wire) {
    scr_arr_release(arguments);
    scr_str_release(thread_name);
    scr_context_env_release(environment);
    return NULL;
  }
  /* The thread record owns the environment; a shared one is the retained
   * reference to the creating thread's environment. */
  ScrWorkerThread *thread = scr_worker_thread_start(sc_worker_entry, (uint32_t)root, wire, environment_data,
                                                    scr_worker_events, arguments, stack_size, limits_out,
                                                    thread_name, capture, environment, share_environment);
  scr_str_release(thread_name);
  scr_arr_release(arguments);
  if (!thread) return NULL;
  ScrWorkerView *view = scr_worker_view_new(false);
  view->thread = thread;
  memcpy(view->limits, limits_out, sizeof view->limits);
  for (int i = 0; i < 2; i++) {
    view->stdio_captured[i] = i == 0 ? option_stdout : option_stderr;
    /* without the stream unit nothing can read the stream: the output is dropped */
    if (scr_worker_stdio_ops) view->stdio[i] = scr_worker_stdio_ops->readable("ReadableWorkerStdio");
  }
  view->stdin_captured = capture & 4;
  if (view->stdin_captured && scr_worker_stdio_ops) view->stdin_stream = scr_worker_stdin_new(thread);
  view->next = scr_worker_views;
  scr_worker_views = view;
  return scr_dyn_new_handle(view, SCR_DYNH_WORKER);
}

ScrDyn *scr_worker_new(double root, ScrStr *filename, ScrDyn *options) {
  ScrDyn *view = options->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(options) : NULL;
  ScrDyn *result = scr_exc_pending() ? NULL : scr_worker_new_options(root, filename, view ? view : options);
  scr_dyn_release(view);
  return result;
}
#endif
