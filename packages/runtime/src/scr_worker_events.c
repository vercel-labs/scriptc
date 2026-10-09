#include "scr_worker.h"

#ifdef SCR_WORKERS
#include <stdlib.h>

extern int sc_worker_entry(uint32_t root);

typedef struct ScrWorkerView {
  size_t rc;
  ScrEmitter *events;
  ScrWorkerThread *thread;
  ScrPromise *termination;
  bool port;
  bool closed;
  bool referenced;
  bool started;
  bool closing;
  ScrMailEvent *queued_head;
  ScrMailEvent *queued_tail;
  struct ScrWorkerView *next;
} ScrWorkerView;

static SCR_TL ScrMailbox *scr_worker_events;
static SCR_TL ScrWorkerView *scr_worker_views;
static SCR_TL ScrWorkerView *scr_worker_port;
static const char *const scr_worker_method_names[] = {
  "ref", "unref", "hasRef", "terminate", "postMessage", "on", "once", "addListener",
  "prependListener", "prependOnceListener", "off", "removeListener", "removeAllListeners",
  "listenerCount", "close", "start",
};
static SCR_TL ScrDyn *scr_worker_methods[sizeof scr_worker_method_names / sizeof scr_worker_method_names[0]];

static void scr_worker_view_trace(void *ptr, ScrTraceVisit visit, void *ctx) {
  visit(((ScrWorkerView *)ptr)->events, ctx);
  visit(((ScrWorkerView *)ptr)->termination, ctx);
}

static void scr_worker_view_gcfree(void *ptr) {
  ScrWorkerView *view = ptr;
  scr_worker_thread_release(view->thread);
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
    scr_cyc_on_dead(view);
    scr_rc_destroy(view, scr_worker_view_destroy);
  } else scr_cyc_on_release(view);
}

static void scr_worker_port_listeners(void *ptr, const ScrStr *name, bool present) {
  ScrWorkerView *view = ptr;
  if (name->len != 7 || memcmp(name->data, "message", 7)) return;
  if (present) view->started = true;
  view->referenced = present;
}

static ScrWorkerView *scr_worker_view_new(bool port) {
  ScrWorkerView *view = scr_cyc_alloc(sizeof(*view), scr_worker_view_trace, scr_worker_view_gcfree);
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

static ScrDyn *scr_worker_view_invoke(void *ptr, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  (void)what;
  ScrWorkerView *view = ptr;
  if (!strcmp(method, "ref") || !strcmp(method, "unref")) {
    view->referenced = !strcmp(method, "ref");
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (view->port && !strcmp(method, "hasRef"))
    return scr_dyn_new_bool(view->referenced && !view->closed);
  if (!view->port && !strcmp(method, "terminate")) {
    if (!view->termination) {
      view->termination = scr_promise_new();
      if (view->closed) scr_promise_fulfill_ref(view->termination,
        scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      else scr_worker_thread_terminate(view->thread);
    }
    return scr_dyn_new_promise(view->termination);
  }
  if (!strcmp(method, "postMessage")) {
    /* Worker drops messages after exit before validating or cloning. A
     * closed MessagePort still validates its payload, as Node does. */
    if (!view->port && view->closed) return scr_dyn_retain(scr_dyn_undefined());
    if (!argc) {
      static const char message[] = "The \"value\" argument must be specified";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
      return NULL;
    }
    if (argc > 1 && !scr_worker_empty_transfer(args[1]))
      return scr_exc_pending() ? NULL : scr_worker_refusal("Worker postMessage transfer lists are not supported yet");
    ScrMessage *message = scr_message_encode(args[0]);
    if (!message) return NULL;
    if (view->closed) scr_message_free(message);
    else if (view->port) scr_worker_post_parent(message);
    else scr_worker_thread_post(view->thread, message);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  bool once = !strcmp(method, "once") || !strcmp(method, "prependOnceListener");
  bool prepend = !strcmp(method, "prependListener") || !strcmp(method, "prependOnceListener");
  if (once || prepend || !strcmp(method, "on") || !strcmp(method, "addListener")) {
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(listener, "listener");
    if (scr_exc_pending()) return NULL;
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_on_flex(view->events, args[0]->v.str, listener, once, prepend));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (!strcmp(method, "off") || !strcmp(method, "removeListener")) {
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(listener, "listener");
    if (scr_exc_pending()) return NULL;
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_off_dyn(view->events, args[0]->v.str, listener));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (!strcmp(method, "removeAllListeners")) {
    bool all = !argc || args[0]->kind == SCR_DYN_UNDEF;
    if (!all && args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    scr_emitter_release(scr_emitter_remove_all(view->events, all ? NULL : args[0]->v.str, all));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (!strcmp(method, "listenerCount")) {
    if (!argc || args[0]->kind != SCR_DYN_STR)
      return scr_worker_refusal("Worker event names must be strings");
    return scr_dyn_new_num(argc > 1 && args[1]->kind != SCR_DYN_UNDEF
      ? scr_emitter_listener_count_dyn(view->events, args[0]->v.str, args[1])
      : scr_emitter_listener_count(view->events, args[0]->v.str));
  }
  if (view->port && !strcmp(method, "close")) {
    if (argc && args[0]->kind != SCR_DYN_UNDEF) {
      scr_dyn_check_listener(args[0], "callback");
      if (scr_exc_pending()) return NULL;
      ScrStr *name = scr_str_new("close", 5);
      scr_emitter_release(scr_emitter_on_flex(view->events, name, args[0], true, false));
      scr_str_release(name);
    }
    if (!view->closed) view->closing = true;
    view->closed = true;
    scr_worker_port_close();
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (view->port && !strcmp(method, "start")) {
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

static ScrDyn *scr_worker_view_get(void *ptr, const char *key, size_t length) {
  ScrWorkerView *view = ptr;
  if (!view->port && length == 8 && !memcmp(key, "threadId", 8))
    return scr_dyn_new_num(view->closed ? -1 : (double)scr_worker_thread_id(view->thread));
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
  for (ScrWorkerView *view = scr_worker_views; view; view = view->next)
    if (view->referenced) return true;
  return scr_worker_port && (scr_worker_port->closing ||
    (scr_worker_port->referenced && !scr_worker_port->closed));
}

static int scr_worker_events_pollfd(void) {
  return scr_worker_events ? scr_mailbox_pollfd(scr_worker_events) : -1;
}

static bool scr_worker_events_ready(void) {
  return (scr_worker_port && (scr_worker_port->closing ||
    (scr_worker_port->started && scr_worker_port->queued_head))) ||
    (scr_worker_events && scr_mailbox_pending(scr_worker_events));
}

static void scr_worker_events_wait(double milliseconds) {
  if (!scr_worker_events_ready()) scr_mailbox_wait(scr_worker_events, milliseconds);
}

static void scr_worker_dispatch(void) {
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
  } else event = scr_mailbox_take(scr_worker_events);
  if (!event) return;
  if (event->kind == SCR_WORKER_WAKE) { scr_mail_event_free(event); return; }
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
  const char *event_name = event->kind == SCR_WORKER_ONLINE ? "online" :
    event->kind == SCR_WORKER_EXIT ? "exit" : event->kind == SCR_WORKER_ERROR ? "error" : "message";
  ScrDyn *argument = event->message ? scr_message_decode(event->message) :
    event->kind == SCR_WORKER_EXIT ? scr_dyn_new_num(event->code) : NULL;
  if (event->kind == SCR_WORKER_EXIT) {
    scr_worker_thread_join(view->thread);
    view->closed = true;
    if (view->termination) scr_promise_fulfill_ref(view->termination,
      scr_dyn_new_num(event->code), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
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
  scr_dyn_release(argument);
  scr_worker_view_release(view);
  scr_mail_event_free(event);
}

static void scr_worker_events_cleanup(void) {
  scr_loop_set_workers(NULL, NULL, NULL, NULL, NULL);
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
  for (size_t i = 0; i < sizeof scr_worker_methods / sizeof scr_worker_methods[0]; i++) {
    scr_dyn_release(scr_worker_methods[i]);
    scr_worker_methods[i] = NULL;
  }
  scr_mailbox_release(scr_worker_events);
  scr_worker_events = NULL;
}

static bool scr_worker_events_install(void) {
  if (scr_worker_events) return true;
  ScrMailbox *inbox = scr_worker_inbox();
  scr_worker_events = inbox ? scr_mailbox_retain(inbox) : scr_mailbox_new();
  if (!scr_worker_events) return false;
  if (inbox && !scr_worker_port) scr_worker_port = scr_worker_view_new(true);
  static const ScrDynHandleOps worker_ops = {
    .cls = "Worker", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
    .invoke = scr_worker_view_invoke, .get = scr_worker_view_get,
  };
  static const ScrDynHandleOps port_ops = {
    .cls = "MessagePort", .retain = scr_worker_view_retain, .release = scr_worker_view_release,
    .invoke = scr_worker_view_invoke, .get = scr_worker_view_get,
  };
  scr_dyn_handle_install(SCR_DYNH_WORKER, &worker_ops);
  scr_dyn_handle_install(SCR_DYNH_MESSAGE_PORT, &port_ops);
  if (scr_context_atexit(scr_worker_events_cleanup) != 0) scr_trap("scriptc: out of memory\n");
  scr_loop_set_workers(scr_workers_pending, scr_worker_events_ready, scr_worker_dispatch,
    scr_worker_events_pollfd, scr_worker_events_wait);
  return true;
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

static ScrDyn *scr_worker_new_options(double root, ScrStr *filename, ScrDyn *options) {
  if (!scr_worker_events_install()) return NULL;
  ScrDyn *data = scr_dyn_undefined();
  ScrDyn *argv = scr_dyn_undefined();
  if (options->kind != SCR_DYN_UNDEF) {
    if (options->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "object", options);
      return NULL;
    }
    for (size_t i = 0; i < options->v.obj.len; i++) {
      const ScrDynEntry *entry = &options->v.obj.entries[i];
      if (entry->accessor) return scr_worker_refusal("Worker option accessors are not supported yet");
      if (entry->key_len == 10 && !memcmp(entry->key, "workerData", 10)) data = entry->value;
      else if (entry->key_len == 4 && !memcmp(entry->key, "argv", 4)) argv = entry->value;
      else return scr_worker_refusal("This Worker constructor option is not supported yet");
    }
  }
  ScrArr *arguments = scr_worker_arguments(filename, argv);
  if (!arguments) return NULL;
  ScrMessage *wire = scr_message_encode(data);
  if (!wire) { scr_arr_release(arguments); return NULL; }
  ScrWorkerThread *thread = scr_worker_thread_start(sc_worker_entry, (uint32_t)root, wire, scr_worker_events, arguments);
  scr_arr_release(arguments);
  if (!thread) return NULL;
  ScrWorkerView *view = scr_worker_view_new(false);
  view->thread = thread;
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
