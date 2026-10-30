#include "scr_worker.h"

#ifdef SCR_WORKERS
#include <stdlib.h>

extern int sc_worker_entry(uint32_t root);

typedef struct ScrWorkerView {
  size_t rc;
  ScrEmitter *events;
  ScrWorkerThread *thread;
  ScrPromise *termination;
  ScrPromise *disposal; /* worker[Symbol.asyncDispose]()'s promise */
  bool port;
  bool closed;
  bool referenced;
  bool started;
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
  "listenerCount", "close", "start",
};
static SCR_TL ScrDyn *scr_worker_methods[sizeof scr_worker_method_names / sizeof scr_worker_method_names[0]];
static const char *const scr_broadcast_method_names[] = {
  "postMessage", "close", "ref", "unref", "addEventListener", "removeEventListener", "dispatchEvent",
};
static SCR_TL ScrDyn *scr_broadcast_methods[sizeof scr_broadcast_method_names / sizeof scr_broadcast_method_names[0]];


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
  visit(view->termination, ctx);
  visit(view->disposal, ctx);
  for (int i = 0; i < 2; i++) {
    visit(view->stdio[i], ctx);
    visit(view->stdio_box[i], ctx);
  }
  visit(view->stdin_stream, ctx);
  visit(view->stdin_box, ctx);
}

static void scr_worker_view_gcfree(void *ptr) {
  ScrWorkerView *view = ptr;
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
  scr_promise_release(view->termination);
  scr_promise_release(view->disposal);
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

static void scr_worker_port_listeners(void *ptr, const ScrStr *name, bool present) {
  ScrWorkerView *view = ptr;
  if (name->len != 7 || memcmp(name->data, "message", 7)) return;
  if (present) view->started = true;
  view->referenced = present;
}

static ScrWorkerView *scr_worker_view_new(bool port) {
  static ScrCycType cyc_type = { &scr_worker_view_trace, &scr_worker_view_gcfree, SCR_CYC_KIND_WORKER_VIEW };
  ScrWorkerView *view = scr_cyc_alloc(sizeof(*view), &cyc_type);
  view->rc = 1;
  view->port = port;
  view->referenced = !port;
  view->events = scr_emitter_new();
  view->events->cls = port ? "MessagePort" : "Worker";
  if (port) scr_emitter_observe(view->events, scr_worker_port_listeners, view);
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

static ScrDyn *scr_worker_view_invoke(void *ptr, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  (void)what;
  ScrWorkerView *view = ptr;
  if (method_is(method, "ref") || method_is(method, "unref")) {
    view->referenced = method_is(method, "ref");
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (view->port && method_is(method, "hasRef"))
    return scr_dyn_new_bool(view->referenced && (!view->closed || (view->channel && view->closing)));
  if (!view->port && method_is(method, "terminate")) {
    if (!view->termination) {
      view->termination = scr_promise_new();
      if (view->closed) scr_promise_fulfill_ref(view->termination,
        scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      else scr_worker_thread_terminate(view->thread);
    }
    return scr_dyn_new_promise(view->termination);
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
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_on_flex(view->events, args[0]->v.str, listener, once, prepend));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (method_is(method, "off") || method_is(method, "removeListener")) {
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(listener, "listener");
    if (scr_exc_pending()) return NULL;
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_off_dyn(view->events, args[0]->v.str, listener));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (method_is(method, "removeAllListeners")) {
    bool all = !argc || args[0]->kind == SCR_DYN_UNDEF;
    if (!all && args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_remove_all(view->events, all ? NULL : args[0]->v.str, all));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (method_is(method, "listenerCount")) {
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    return scr_dyn_new_num(argc > 1 && args[1]->kind != SCR_DYN_UNDEF
      ? scr_emitter_listener_count_dyn(view->events, args[0]->v.str, args[1])
      : scr_emitter_listener_count(view->events, args[0]->v.str));
  }
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
      else if (!view->termination) scr_worker_thread_terminate(view->thread);
    }
    result = scr_dyn_new_promise(view->disposal);
  }
  scr_dyn_release(self);
  return result;
}

/* worker[Symbol.asyncDispose] */
static ScrDyn *scr_worker_symbol_get(void *ptr, const ScrDyn *key) {
  (void)ptr;
  if (!scr_dyn_is_async_dispose_symbol(key)) return NULL;
  ScrClosure *closure = scr_closure_new((void *)&scr_worker_async_dispose_call, 0);
  return scr_dyn_new_func(closure, &scr_worker_async_dispose_call, 0, "()", "[Symbol.asyncDispose]");
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
    int i = key[3] == 'e' ? 1 : 0;
    if (!view->stdio_captured[i])
      return scr_worker_refusal(i ? "worker.stderr without the stderr option is not supported yet"
                                  : "worker.stdout without the stdout option is not supported yet");
    if (!view->stdio[i]) return scr_dyn_new_null();
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
  if (!view->port && length == 14 && !memcmp(key, "resourceLimits", 14))
    return view->closed ? scr_dyn_new_obj() : scr_worker_refusal("worker.resourceLimits is not supported yet");
  for (size_t i = 0; i < sizeof scr_worker_methods / sizeof scr_worker_methods[0]; i++) {
    const char *name = scr_worker_method_names[i];
    if (strlen(name) != length || memcmp(name, key, length)) continue;
    if ((view->port && !strcmp(name, "terminate")) ||
        (!view->port && (!strcmp(name, "start") || !strcmp(name, "close") || !strcmp(name, "hasRef")))) return NULL;
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

static bool scr_workers_pending(void) {
  /* a worker's process.stdin waiting for worker.stdin chunks */
  if (scr_stdin_fed && scr_stdin_fed_waiting && scr_stdin_fed_waiting()) return true;
  for (ScrWorkerView *view = scr_worker_views; view; view = view->next)
    if (view->referenced) return true;
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

static void scr_worker_port_emit(ScrWorkerView *view, const char *event, ScrDyn *argument) {
  ScrStr *name = scr_str_new(event, strlen(event));
  scr_dyn_this_push(view, SCR_DYNH_MESSAGE_PORT);
  scr_emitter_emit_flex(view->events, name, argument ? &argument : NULL, argument ? 1 : 0);
  scr_dyn_this_pop();
  scr_str_release(name);
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
      /* Compiled listeners with a typed message entry read the message. */
      ScrStr *name = scr_str_new("message", 7);
      scr_dyn_this_push(view, SCR_DYNH_MESSAGE_PORT);
      scr_emitter_emit_message(view->events, name, event->message, scr_message_decode);
      scr_dyn_this_pop();
      scr_str_release(name);
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
    ScrWorkerView *source = scr_worker_views;
    while (source && scr_worker_thread_id(source->thread) != event->source) source = source->next;
    ScrStream *stream = source ? source->stdio[event->kind == SCR_WORKER_STDERR] : NULL;
    if (stream) {
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
    /* Compiled listeners with a typed message entry read the message. */
    if (!scr_exc_pending()) {
      ScrStr *name = scr_str_new("message", 7);
      scr_dyn_this_push(view, view->port ? SCR_DYNH_MESSAGE_PORT : SCR_DYNH_WORKER);
      scr_emitter_emit_message(view->events, name, event->message, scr_message_decode);
      scr_dyn_this_pop();
      scr_str_release(name);
    }
    scr_worker_view_release(view);
    scr_mail_event_free(event);
    return;
  }
  const char *event_name = event->kind == SCR_WORKER_ONLINE ? "online" :
    event->kind == SCR_WORKER_EXIT ? "exit" : event->kind == SCR_WORKER_ERROR ? "error" : "message";
  ScrDyn *argument = event->message ? scr_message_decode(event->message) :
    event->kind == SCR_WORKER_EXIT ? scr_dyn_new_num(event->code) : NULL;
  if (event->kind == SCR_WORKER_EXIT) {
    scr_worker_thread_join(view->thread);
    view->closed = true;
    if (view->termination) scr_promise_fulfill_ref(view->termination,
      scr_dyn_new_num(event->code), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
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

static void scr_worker_stdin_attach(void) { (void)scr_worker_events_install(); }

static bool scr_worker_events_install(void) {
  if (scr_worker_events) return true;
  ScrMailbox *inbox = scr_worker_inbox();
  scr_worker_events = inbox ? scr_mailbox_retain(inbox) : scr_mailbox_new();
  if (!scr_worker_events) return false;
  if (inbox && !scr_worker_port) scr_worker_port = scr_worker_view_new(true);
  static const ScrDynHandleOps worker_ops = {
    .cls = "Worker", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
    .invoke = scr_worker_view_invoke, .get = scr_worker_view_get,
    .symbol_get = scr_worker_symbol_get,
  };
  static const ScrDynHandleOps port_ops = {
    .cls = "MessagePort", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
    .invoke = scr_worker_view_invoke, .get = scr_worker_view_get,
  };
  scr_dyn_handle_install(SCR_DYNH_WORKER, &worker_ops);
  scr_dyn_handle_install(SCR_DYNH_MESSAGE_PORT, &port_ops);
  scr_port_ops_install();
  if (scr_context_atexit(scr_worker_events_cleanup) != 0) scr_trap("scriptc: out of memory\n");
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

/* worker_threads.resourceLimits: {} in the main thread, as Node; a worker's
 * values are its V8 heap configuration. */
ScrDyn *scr_worker_resource_limits(void) {
  if (scr_context_is_main()) return scr_dyn_new_obj();
  return scr_worker_refusal("resourceLimits in a worker is not supported yet");
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

/* resourceLimits: Node reads the four numbers when the option is an object
 * and ignores other values. stackSizeMb sizes the thread's stack (at least
 * 192 KiB, as Node); the V8 heap limits are refused. */
static bool scr_worker_stack_size(ScrDyn *limits, size_t *stack_size) {
  if (limits->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(limits);
    bool ok = view && !scr_exc_pending() && scr_worker_stack_size(view, stack_size);
    scr_dyn_release(view);
    return ok;
  }
  if (limits->kind != SCR_DYN_OBJ) return true;
  static const char *const heap[] = {"maxOldGenerationSizeMb", "maxYoungGenerationSizeMb", "codeRangeSizeMb"};
  for (size_t i = 0; i < sizeof heap / sizeof heap[0]; i++) {
    const ScrDyn *value = scr_dyn_obj_get(limits, heap[i], strlen(heap[i]));
    if (value && value->kind == SCR_DYN_NUM) {
      scr_worker_refusal("Worker resourceLimits heap limits are not supported yet");
      return false;
    }
  }
  const ScrDyn *megabytes = scr_dyn_obj_get(limits, "stackSizeMb", 11);
  if (megabytes && megabytes->kind == SCR_DYN_NUM && megabytes->v.num > 0) {
    double bytes = megabytes->v.num * 1048576.0;
    if (bytes < 192.0 * 1024) bytes = 192.0 * 1024;
    *stack_size = bytes >= (double)(SIZE_MAX / 2) ? SIZE_MAX / 2 : (size_t)bytes;
  }
  return true;
}

static ScrDyn *scr_worker_new_options(double root, ScrStr *filename, ScrDyn *options) {
  if (!scr_worker_events_install()) return NULL;
  ScrDyn *data = scr_dyn_undefined();
  ScrDyn *argv = scr_dyn_undefined();
  ScrDyn *transfer_list = scr_dyn_undefined();
  ScrDyn *limits = scr_dyn_undefined();
  ScrDyn *name = scr_dyn_undefined();
  unsigned capture = 0;
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
      else if (entry.key_len == 6 && !memcmp(entry.key, "stdout", 6)) capture |= scr_dyn_truthy(entry.value) ? 1 : 0;
      else if (entry.key_len == 6 && !memcmp(entry.key, "stderr", 6)) capture |= scr_dyn_truthy(entry.value) ? 2 : 0;
      else if (entry.key_len == 5 && !memcmp(entry.key, "stdin", 5)) capture |= scr_dyn_truthy(entry.value) ? 4 : 0;
      else return scr_worker_refusal("This Worker constructor option is not supported yet");
    }
  }
  size_t stack_size = 0;
  if (!scr_worker_stack_size(limits, &stack_size)) return NULL;
  ScrArr *arguments = scr_worker_arguments(filename, argv);
  if (!arguments) return NULL;
  /* Node: a truthy name must be a string, trimmed; otherwise WorkerThread */
  ScrStr *thread_name;
  if (scr_dyn_truthy(name)) {
    if (name->kind != SCR_DYN_STR) {
      scr_arr_release(arguments);
      scr_dyn_prop_type_fail("options.name", "of type string", name);
      return NULL;
    }
    thread_name = scr_str_trim(name->v.str);
  } else {
    thread_name = scr_str_new("WorkerThread", 12);
  }
  ScrDyn *transfer = scr_worker_transfer_list(transfer_list);
  if (scr_exc_pending()) { scr_arr_release(arguments); scr_str_release(thread_name); return NULL; }
  bool environment_data;
  ScrMessage *wire = scr_worker_start_message(data, transfer, &environment_data);
  if (capture & 4) scr_worker_set_stdin_attach(scr_worker_stdin_attach);
  scr_dyn_release(transfer);
  if (!wire) { scr_arr_release(arguments); scr_str_release(thread_name); return NULL; }
  ScrWorkerThread *thread = scr_worker_thread_start(sc_worker_entry, (uint32_t)root, wire, environment_data,
                                                    scr_worker_events, arguments, stack_size, thread_name,
                                                    capture);
  scr_str_release(thread_name);
  scr_arr_release(arguments);
  if (!thread) return NULL;
  ScrWorkerView *view = scr_worker_view_new(false);
  view->thread = thread;
  for (int i = 0; i < 2; i++) {
    view->stdio_captured[i] = (capture >> i) & 1;
    /* without the stream unit nothing can read the stream: the output is dropped */
    if (view->stdio_captured[i] && scr_worker_stdio_ops)
      view->stdio[i] = scr_worker_stdio_ops->readable("ReadableWorkerStdio");
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
