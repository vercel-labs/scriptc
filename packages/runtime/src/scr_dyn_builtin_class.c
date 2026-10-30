/* EventEmitter and the node:stream constructors as checked-dynamic
 * constructor values. JavaScript constructor functions inherit from them
 * the pre-class way:
 *
 *   function Bus() { EventEmitter.call(this); }
 *   util.inherits(Bus, EventEmitter);
 *
 * A compiled EventEmitter instance keeps its listeners in native state, but
 * the receiver here is an ordinary dyn object built by `new Bus()`. So the
 * EventEmitter value is a native function whose prototype carries Node's
 * lib/events.js methods over that object's own `_events`, `_eventsCount`
 * and `_maxListeners` properties, the state Node's own implementation
 * keeps there. Calling it with a receiver runs EventEmitter.init.
 *
 * Stream is Node's legacy constructor: EventEmitter.call(this, opts) and a
 * prototype that inherits EventEmitter's. Readable, Writable, Duplex,
 * Transform and PassThrough have prototypes chained as in Node, so
 * util.inherits onto them and instanceof work. Their stream half (the
 * prototypes' methods and `Readable.call(this, opts)`) lives in
 * scr_dyn_builtin_stream.c, which registers itself through
 * scr_dyn_builtin_class_streams in programs that link it; without it,
 * calling one with a receiver throws the "not supported yet" Error where
 * the construction runs. EventEmitter's methods hand a receiver with
 * stream state to that unit, whose listeners live in the runtime stream.
 *
 * One constructor per kind and thread, so every boxing of the same class
 * value is the same function. All arguments are borrowed. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <process.h>
#define BC_PID() ((long)_getpid())
#else
#include <unistd.h>
#define BC_PID() ((long)getpid())
#endif

enum {
  BC_EMITTER,
  BC_STREAM,
  BC_READABLE,
  BC_WRITABLE,
  BC_DUPLEX,
  BC_TRANSFORM,
  BC_PASSTHROUGH,
  BC_COUNT
};

static const char *const bc_names[BC_COUNT] = {
  "EventEmitter", "Stream", "Readable", "Writable", "Duplex", "Transform", "PassThrough",
};

static SCR_TL ScrDyn *bc_ctors[BC_COUNT];
static SCR_TL bool bc_teardown_registered;
/* Node's private kShapeMode and kCapture symbols, which util.inspect shows
 * on every emitter as Symbol(shapeMode) and Symbol(kCapture). */
enum { BC_SHAPE_MODE, BC_CAPTURE, BC_SYMBOLS };
static SCR_TL ScrDyn *bc_symbols[BC_SYMBOLS];

static ScrDyn *bc_class(int kind);

/* The stream half, once registered (scr_dyn_builtin_stream.c). */
static SCR_TL const ScrDynStreamOps *bc_stream_ops;

/* EventEmitter.prototype's method on a receiver with stream state. */
static bool bc_stream_event(int method, ScrDyn *self, ScrDyn *const *args, size_t argc, ScrDyn **result) {
  return bc_stream_ops != NULL && bc_stream_ops->event(method, self, args, argc, result);
}

/* ── property helpers ───────────────────────────────────────────────── */

static ScrDyn *bc_key(const char *name) {
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrDyn *key = scr_dyn_new_str(text);
  scr_str_release(text);
  return key;
}

/* object[key] with object as the receiver: +1, or NULL with an exception
 * pending. */
static ScrDyn *bc_get_key(ScrDyn *object, ScrDyn *key) {
  ScrDyn *value = scr_dyn_reflect_get(object, key, object);
  if (!value && !scr_exc_pending()) value = scr_dyn_retain(scr_dyn_undefined());
  return value;
}

static ScrDyn *bc_get(ScrDyn *object, const char *name) {
  ScrDyn *key = bc_key(name);
  ScrDyn *value = bc_get_key(object, key);
  scr_dyn_release(key);
  return value;
}

/* object[key] = value; the value moves in. False with an exception
 * pending. */
static bool bc_set_key(ScrDyn *object, ScrDyn *key, ScrDyn *value) {
  scr_dyn_key_set_computed(object, key, value);
  scr_dyn_release(value);
  return !scr_exc_pending();
}

static bool bc_set(ScrDyn *object, const char *name, ScrDyn *value) {
  ScrDyn *key = bc_key(name);
  bool ok = bc_set_key(object, key, value);
  scr_dyn_release(key);
  return ok;
}

static bool bc_undefined(const ScrDyn *value) {
  return value->kind == SCR_DYN_UNDEF;
}

static double bc_number(const ScrDyn *value) {
  return value->kind == SCR_DYN_NUM ? value->v.num : 0;
}

/* receiver.method(...args), dispatched through the receiver's own lookup
 * like Node's `this.emit(...)`. +1 or NULL. */
static ScrDyn *bc_invoke(ScrDyn *receiver, const char *method, ScrDyn *const *args, size_t argc) {
  ScrDyn *fn = bc_get(receiver, method);
  if (!fn) return NULL;
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(fn, args, argc, method);
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

static ScrDyn *bc_apply(ScrDyn *fn, ScrDyn *receiver, ScrDyn *const *args, size_t argc) {
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(fn, args, argc, "listener");
  scr_dyn_this_pop();
  return result;
}

/* Listener lists are replaced rather than mutated: a fresh array with item
 * first, or without the item at index. Node mutates its array in place,
 * which nothing outside the emitter observes (emit iterates a copy and
 * listeners() answers one). A leak warning already given stays given. */
static ScrDyn *bc_list_copy(ScrDyn *list, ScrDyn *first, double skip) {
  ScrDyn *copy = scr_dyn_new_arr();
  if (first) scr_dyn_arr_push(copy, scr_dyn_retain(first));
  double length = scr_dyn_arr_len(list);
  for (double i = 0; i < length; i++) {
    if (i == skip) continue;
    ScrDyn *item = scr_dyn_index_get(list, i);
    if (!item) {
      scr_dyn_release(copy);
      return NULL;
    }
    scr_dyn_arr_push(copy, item);
  }
  ScrDyn *warned = bc_get(list, "warned");
  if (!warned || (scr_dyn_truthy(warned) && !bc_set(copy, "warned", scr_dyn_new_bool(true)))) {
    if (warned) scr_dyn_release(warned);
    scr_dyn_release(copy);
    return NULL;
  }
  scr_dyn_release(warned);
  return copy;
}

static ScrDyn *bc_unused_args[1];

static ScrDyn *bc_arg(ScrDyn *const *args, size_t argc, size_t index) {
  return index < argc ? args[index] : scr_dyn_undefined();
}

/* The receiver of a prototype method call, +1. Methods called without one
 * (an extracted `emitter.on`) read `this` as undefined, as in strict code. */
static ScrDyn *bc_this(void) {
  return scr_dyn_this_get();
}

static bool bc_require_object(ScrDyn *self, const char *reading) {
  if (self->kind != SCR_DYN_UNDEF && self->kind != SCR_DYN_NULL) return true;
  char message[96];
  snprintf(message, sizeof message, "Cannot read properties of %s (reading '%s')",
           self->kind == SCR_DYN_NULL ? "null" : "undefined", reading);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  return false;
}

static bool bc_check_listener(const ScrDyn *listener) {
  if (scr_dyn_is_callable(listener)) return true;
  scr_dyn_arg_type_fail("listener", "of type function", listener);
  return false;
}

static void bc_teardown(void);

static ScrDyn *bc_symbol(int which) {
  if (!bc_symbols[which]) {
    if (!bc_teardown_registered) {
      bc_teardown_registered = true;
      scr_atexit(bc_teardown);
    }
    const char *name = which == BC_SHAPE_MODE ? "shapeMode" : "kCapture";
    ScrStr *description = scr_str_new(name, strlen(name));
    ScrSym *symbol = scr_sym_new(description);
    scr_str_release(description);
    bc_symbols[which] = scr_dyn_new_symbol(symbol);
    scr_sym_release(symbol);
  }
  return bc_symbols[which];
}

/* ── EventEmitter.init ──────────────────────────────────────────────── */

/* `_events` is fresh unless the receiver already has its own (Node's
 * shapeMode, a subclass that pre-populates it); `_maxListeners` keeps a
 * value set before the call. */
static bool bc_emitter_init(ScrDyn *self, ScrDyn *opts) {
  if (!bc_require_object(self, "_events")) return false;
  ScrDyn *events = bc_get(self, "_events");
  if (!events) return false;
  bool fresh = bc_undefined(events);
  if (!fresh) {
    ScrDyn *proto = scr_dyn_get_prototype(self);
    if (!proto) {
      scr_dyn_release(events);
      return false;
    }
    if (proto->kind != SCR_DYN_NULL) {
      ScrDyn *inherited = bc_get(proto, "_events");
      if (!inherited) {
        scr_dyn_release(proto);
        scr_dyn_release(events);
        return false;
      }
      fresh = scr_dyn_strict_eq(events, inherited);
      scr_dyn_release(inherited);
    }
    scr_dyn_release(proto);
  }
  scr_dyn_release(events);
  if (fresh) {
    if (!bc_set(self, "_events", scr_dyn_new_obj_null_proto())) return false;
    if (!bc_set(self, "_eventsCount", scr_dyn_new_num(0))) return false;
  }
  if (!bc_set_key(self, bc_symbol(BC_SHAPE_MODE), scr_dyn_new_bool(!fresh))) return false;
  ScrDyn *max = bc_get(self, "_maxListeners");
  if (!max) return false;
  bool keep = scr_dyn_truthy(max);
  if (!bc_set(self, "_maxListeners", keep ? max : (scr_dyn_release(max), scr_dyn_retain(scr_dyn_undefined()))))
    return false;
  if (opts->kind != SCR_DYN_UNDEF && opts->kind != SCR_DYN_NULL) {
    ScrDyn *capture = bc_get(opts, "captureRejections");
    if (!capture) return false;
    bool requested = !bc_undefined(capture);
    if (requested && capture->kind != SCR_DYN_BOOL) {
      scr_dyn_arg_type_fail("options.captureRejections", "of type boolean", capture);
      scr_dyn_release(capture);
      return false;
    }
    bool enabled = requested && capture->v.b;
    scr_dyn_release(capture);
    if (enabled) {
      static const char message[] = "EventEmitter captureRejections on a constructor function is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return false;
    }
  }
  return bc_set_key(self, bc_symbol(BC_CAPTURE), scr_dyn_new_bool(false));
}

/* ── listener bookkeeping (lib/events.js) ───────────────────────────── */

static double bc_max_listeners(ScrDyn *self) {
  ScrDyn *max = bc_get(self, "_maxListeners");
  if (!max) return -1;
  double value;
  if (bc_undefined(max)) {
    value = scr_emitter_get_default_max();
  } else {
    value = bc_number(max);
  }
  scr_dyn_release(max);
  return value;
}

static void bc_warn_tick(ScrClosure *self) {
  ScrStr *message = (ScrStr *)scr_box_get_ref(self->caps[0]);
  if (scr_warning_emit_hook) {
    scr_warning_emit_hook("MaxListenersExceededWarning", NULL, message);
  } else {
    fflush(stdout);
    fprintf(stderr, "(node:%ld) MaxListenersExceededWarning: %.*s\n", BC_PID(),
            (int)message->len, message->data);
    if (!scr_warning_trace_hint_shown) {
      scr_warning_trace_hint_shown = true;
      fputs("(Use `node --trace-warnings ...` to show where the warning was created)\n", stderr);
    }
  }
  scr_str_release(message);
}

/* The constructor name util.inspect prints at depth -1: `[Bus]`. */
static ScrStr *bc_constructor_name(ScrDyn *self) {
  ScrDyn *ctor = bc_get(self, "constructor");
  ScrStr *name = NULL;
  if (ctor && scr_dyn_is_callable(ctor)) {
    ScrDyn *text = bc_get(ctor, "name");
    if (text && text->kind == SCR_DYN_STR && text->v.str->len) name = scr_str_retain(text->v.str);
    if (text) scr_dyn_release(text);
  }
  if (ctor) scr_dyn_release(ctor);
  if (scr_exc_pending()) scr_exc_clear();
  return name ? name : scr_str_new("Object", 6);
}

static void bc_warn_leak(ScrDyn *self, ScrDyn *type, double count, double max) {
  char counted[32], limit[32];
  snprintf(counted, sizeof counted, "%g", count);
  snprintf(limit, sizeof limit, "%g", max);
  ScrStr *event = scr_dyn_string_coerce_js(type);
  if (!event) {
    scr_exc_clear();
    event = scr_str_new("", 0);
  }
  ScrStr *cls = bc_constructor_name(self);
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "Possible EventEmitter memory leak detected. ");
  scr_jb_puts(&text, counted);
  scr_jb_putc(&text, ' ');
  scr_jb_put_str(&text, event);
  scr_jb_puts(&text, " listeners added to [");
  scr_jb_put_str(&text, cls);
  scr_jb_puts(&text, "]. MaxListeners is ");
  scr_jb_puts(&text, limit);
  scr_jb_puts(&text, ". Use emitter.setMaxListeners() to increase limit");
  scr_str_release(event);
  scr_str_release(cls);
  ScrClosure *tick = scr_closure_new((void *)&bc_warn_tick, 1);
  ScrBox *box = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(box, scr_jb_finish(&text));
  tick->caps[0] = box;
  scr_next_tick(tick);
}

/* _addListener(target, type, listener, prepend): +1 target or NULL. */
static ScrDyn *bc_add_listener(ScrDyn *self, ScrDyn *type, ScrDyn *listener, bool prepend) {
  if (!bc_check_listener(listener)) return NULL;
  ScrDyn *events = bc_get(self, "_events");
  if (!events) return NULL;
  ScrDyn *existing = NULL;
  if (bc_undefined(events)) {
    scr_dyn_release(events);
    events = scr_dyn_new_obj_null_proto();
    if (!bc_set(self, "_events", scr_dyn_retain(events)) || !bc_set(self, "_eventsCount", scr_dyn_new_num(0)))
      goto fail;
  } else {
    ScrDyn *watcher = bc_get(events, "newListener");
    if (!watcher) goto fail;
    bool watched = !bc_undefined(watcher);
    scr_dyn_release(watcher);
    if (watched) {
      ScrDyn *inner = bc_get(listener, "listener");
      if (!inner) goto fail;
      ScrDyn *name = bc_key("newListener");
      ScrDyn *args[3] = { name, type, bc_undefined(inner) || inner->kind == SCR_DYN_NULL ? listener : inner };
      ScrDyn *emitted = bc_invoke(self, "emit", args, 3);
      scr_dyn_release(name);
      scr_dyn_release(inner);
      if (!emitted) goto fail;
      scr_dyn_release(emitted);
      /* the listener may have replaced _events */
      scr_dyn_release(events);
      events = bc_get(self, "_events");
      if (!events) return NULL;
    }
    existing = bc_get_key(events, type);
    if (!existing) goto fail;
  }
  if (!existing || bc_undefined(existing)) {
    if (!bc_set_key(events, type, scr_dyn_retain(listener))) goto fail;
    ScrDyn *count = bc_get(self, "_eventsCount");
    if (!count) goto fail;
    double next = bc_number(count) + 1;
    scr_dyn_release(count);
    if (!bc_set(self, "_eventsCount", scr_dyn_new_num(next))) goto fail;
  } else {
    if (scr_dyn_is_callable(existing)) {
      ScrDyn *list = scr_dyn_new_arr();
      scr_dyn_arr_push(list, scr_dyn_retain(prepend ? listener : existing));
      scr_dyn_arr_push(list, scr_dyn_retain(prepend ? existing : listener));
      if (!bc_set_key(events, type, scr_dyn_retain(list))) {
        scr_dyn_release(list);
        goto fail;
      }
      scr_dyn_release(existing);
      existing = list;
    } else if (prepend) {
      ScrDyn *list = bc_list_copy(existing, listener, -1);
      if (!list) goto fail;
      if (!bc_set_key(events, type, scr_dyn_retain(list))) {
        scr_dyn_release(list);
        goto fail;
      }
      scr_dyn_release(existing);
      existing = list;
    } else if (existing->kind == SCR_DYN_ARR) {
      scr_dyn_arr_push(existing, scr_dyn_retain(listener));
    }
    double max = bc_max_listeners(self);
    if (scr_exc_pending()) goto fail;
    double length = existing->kind == SCR_DYN_ARR ? scr_dyn_arr_len(existing) : 0;
    if (max > 0 && length > max) {
      ScrDyn *warned = bc_get(existing, "warned");
      if (!warned) goto fail;
      bool already = scr_dyn_truthy(warned);
      scr_dyn_release(warned);
      if (!already) {
        if (!bc_set(existing, "warned", scr_dyn_new_bool(true))) goto fail;
        bc_warn_leak(self, type, length, max);
      }
    }
  }
  if (existing) scr_dyn_release(existing);
  scr_dyn_release(events);
  return scr_dyn_retain(self);
fail:
  if (existing) scr_dyn_release(existing);
  scr_dyn_release(events);
  return NULL;
}

/* removeListener(type, listener): +1 self or NULL. */
static ScrDyn *bc_remove_listener(ScrDyn *self, ScrDyn *type, ScrDyn *listener) {
  if (!bc_check_listener(listener)) return NULL;
  ScrDyn *events = bc_get(self, "_events");
  if (!events) return NULL;
  if (bc_undefined(events)) {
    scr_dyn_release(events);
    return scr_dyn_retain(self);
  }
  ScrDyn *list = bc_get_key(events, type);
  if (!list) goto fail_events;
  if (bc_undefined(list)) {
    scr_dyn_release(list);
    scr_dyn_release(events);
    return scr_dyn_retain(self);
  }
  ScrDyn *wrapped = scr_dyn_is_callable(list) ? bc_get(list, "listener") : NULL;
  if (scr_exc_pending()) goto fail_list;
  bool match = scr_dyn_is_callable(list) &&
               (scr_dyn_strict_eq(list, listener) || (wrapped && scr_dyn_strict_eq(wrapped, listener)));
  if (match) {
    ScrDyn *count = bc_get(self, "_eventsCount");
    if (!count) goto fail_wrapped;
    double left = bc_number(count) - 1;
    scr_dyn_release(count);
    if (!bc_set(self, "_eventsCount", scr_dyn_new_num(left))) goto fail_wrapped;
    ScrDyn *shaped = bc_get_key(self, bc_symbol(BC_SHAPE_MODE));
    if (!shaped) goto fail_wrapped;
    bool shape_mode = scr_dyn_truthy(shaped);
    scr_dyn_release(shaped);
    if (shape_mode) {
      if (!bc_set_key(events, type, scr_dyn_retain(scr_dyn_undefined()))) goto fail_wrapped;
    } else if (left == 0) {
      if (!bc_set(self, "_events", scr_dyn_new_obj_null_proto())) goto fail_wrapped;
    } else {
      scr_dyn_key_delete_computed(events, type, false);
      if (scr_exc_pending()) goto fail_wrapped;
      ScrDyn *watcher = bc_get(events, "removeListener");
      if (!watcher) goto fail_wrapped;
      bool watched = scr_dyn_truthy(watcher);
      scr_dyn_release(watcher);
      if (watched) {
        ScrDyn *name = bc_key("removeListener");
        ScrDyn *args[3] = { name, type, wrapped && scr_dyn_truthy(wrapped) ? wrapped : listener };
        ScrDyn *emitted = bc_invoke(self, "emit", args, 3);
        scr_dyn_release(name);
        if (!emitted) goto fail_wrapped;
        scr_dyn_release(emitted);
      }
    }
  } else if (list->kind == SCR_DYN_ARR) {
    double length = scr_dyn_arr_len(list);
    double position = -1;
    for (double i = length - 1; i >= 0; i--) {
      ScrDyn *item = scr_dyn_index_get(list, i);
      if (!item) goto fail_wrapped;
      bool same = scr_dyn_strict_eq(item, listener);
      if (!same && scr_dyn_is_callable(item)) {
        ScrDyn *inner = bc_get(item, "listener");
        if (!inner) {
          scr_dyn_release(item);
          goto fail_wrapped;
        }
        same = scr_dyn_strict_eq(inner, listener);
        scr_dyn_release(inner);
      }
      scr_dyn_release(item);
      if (same) {
        position = i;
        break;
      }
    }
    if (position >= 0) {
      ScrDyn *rest = bc_list_copy(list, NULL, position);
      if (!rest) goto fail_wrapped;
      ScrDyn *stored = scr_dyn_arr_len(rest) == 1 ? scr_dyn_index_get(rest, 0) : scr_dyn_retain(rest);
      scr_dyn_release(rest);
      if (!stored || !bc_set_key(events, type, stored)) goto fail_wrapped;
      ScrDyn *watcher = bc_get(events, "removeListener");
      if (!watcher) goto fail_wrapped;
      bool watched = !bc_undefined(watcher);
      scr_dyn_release(watcher);
      if (watched) {
        ScrDyn *name = bc_key("removeListener");
        ScrDyn *args[3] = { name, type, listener };
        ScrDyn *emitted = bc_invoke(self, "emit", args, 3);
        scr_dyn_release(name);
        if (!emitted) goto fail_wrapped;
        scr_dyn_release(emitted);
      }
    }
  }
  if (wrapped) scr_dyn_release(wrapped);
  scr_dyn_release(list);
  scr_dyn_release(events);
  return scr_dyn_retain(self);
fail_wrapped:
  if (wrapped) scr_dyn_release(wrapped);
fail_list:
  scr_dyn_release(list);
fail_events:
  scr_dyn_release(events);
  return NULL;
}

/* ── once wrappers ──────────────────────────────────────────────────── */

enum { BC_ONCE_FIRED, BC_ONCE_TARGET, BC_ONCE_TYPE, BC_ONCE_LISTENER, BC_ONCE_SELF, BC_ONCE_CAPS };

static ScrBox *bc_box(ScrDyn *value /* moves in */) {
  ScrBox *box = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(box, value);
  return box;
}

static ScrDyn *bc_cap(ScrClosure *closure, size_t index) {
  return scr_box_get_ref(closure->caps[index]); /* +1 */
}

/* onceWrapper: the first call removes the wrapper, then calls the listener
 * with the target as its receiver. The wrapper's reference to itself is
 * dropped when it fires, so a fired wrapper holds no cycle. */
static ScrDyn *bc_once_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  if (scr_box_get_f64(closure->caps[BC_ONCE_FIRED]) != 0) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *target = bc_cap(closure, BC_ONCE_TARGET);
  ScrDyn *type = bc_cap(closure, BC_ONCE_TYPE);
  ScrDyn *listener = bc_cap(closure, BC_ONCE_LISTENER);
  ScrDyn *self = bc_cap(closure, BC_ONCE_SELF);
  ScrDyn *result = NULL;
  ScrDyn *removal[2] = { type, self };
  ScrDyn *removed = bc_invoke(target, "removeListener", removal, 2);
  if (removed) {
    scr_dyn_release(removed);
    scr_box_set_f64(closure->caps[BC_ONCE_FIRED], 1);
    scr_box_set_ref(closure->caps[BC_ONCE_SELF], scr_dyn_retain(scr_dyn_undefined()));
    result = bc_apply(listener, target, args, argc);
  }
  scr_dyn_release(self);
  scr_dyn_release(listener);
  scr_dyn_release(type);
  scr_dyn_release(target);
  return result;
}

static ScrDyn *bc_once_wrap(ScrDyn *target, ScrDyn *type, ScrDyn *listener) {
  ScrClosure *closure = scr_closure_new(NULL, BC_ONCE_CAPS);
  closure->caps[BC_ONCE_FIRED] = scr_box_new(SCR_BOX_F64);
  closure->caps[BC_ONCE_TARGET] = bc_box(scr_dyn_retain(target));
  closure->caps[BC_ONCE_TYPE] = bc_box(scr_dyn_retain(type));
  closure->caps[BC_ONCE_LISTENER] = bc_box(scr_dyn_retain(listener));
  closure->caps[BC_ONCE_SELF] = bc_box(scr_dyn_retain(scr_dyn_undefined()));
  scr_closure_retain(closure);
  ScrDyn *wrapper = scr_dyn_new_func(closure, bc_once_call, 0, "native:events", "bound onceWrapper");
  scr_box_set_ref(closure->caps[BC_ONCE_SELF], scr_dyn_retain(wrapper));
  scr_closure_release(closure);
  if (!bc_set(wrapper, "listener", scr_dyn_retain(listener))) {
    scr_dyn_release(wrapper);
    return NULL;
  }
  return wrapper;
}

/* ── EventEmitter.prototype ─────────────────────────────────────────── */

static ScrDyn *bc_on(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *self = bc_this();
  ScrDyn *result;
  if (bc_stream_event(SCR_EE_M_ON, self, args, argc, &result)) {
    scr_dyn_release(self);
    return result;
  }
  result = bc_require_object(self, "_events")
      ? bc_add_listener(self, bc_arg(args, argc, 0), bc_arg(args, argc, 1), false) : NULL;
  scr_dyn_release(self);
  return result;
}

static ScrDyn *bc_prepend(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *self = bc_this();
  ScrDyn *result;
  if (bc_stream_event(SCR_EE_M_PREPEND, self, args, argc, &result)) {
    scr_dyn_release(self);
    return result;
  }
  result = bc_require_object(self, "_events")
      ? bc_add_listener(self, bc_arg(args, argc, 0), bc_arg(args, argc, 1), true) : NULL;
  scr_dyn_release(self);
  return result;
}

static ScrDyn *bc_once_common(ScrDyn *const *args, size_t argc, bool prepend) {
  ScrDyn *self = bc_this();
  ScrDyn *type = bc_arg(args, argc, 0);
  ScrDyn *listener = bc_arg(args, argc, 1);
  ScrDyn *result = NULL;
  if (bc_stream_event(prepend ? SCR_EE_M_PREPEND_ONCE : SCR_EE_M_ONCE, self, args, argc, &result)) {
    scr_dyn_release(self);
    return result;
  }
  if (bc_check_listener(listener) && bc_require_object(self, "_events")) {
    ScrDyn *wrapper = bc_once_wrap(self, type, listener);
    if (wrapper) {
      result = bc_add_listener(self, type, wrapper, prepend);
      scr_dyn_release(wrapper);
    }
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *bc_once(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return bc_once_common(args, argc, false);
}

static ScrDyn *bc_prepend_once(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return bc_once_common(args, argc, true);
}

static ScrDyn *bc_off(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *self = bc_this();
  ScrDyn *result;
  if (bc_stream_event(SCR_EE_M_OFF, self, args, argc, &result)) {
    scr_dyn_release(self);
    return result;
  }
  result = bc_require_object(self, "_events")
      ? bc_remove_listener(self, bc_arg(args, argc, 0), bc_arg(args, argc, 1)) : NULL;
  scr_dyn_release(self);
  return result;
}

/* removeAllListeners(type?): with no 'removeListener' watcher the table is
 * reset; otherwise every listener is removed through removeListener, last
 * first, so the watcher sees each one (and itself last). */
static ScrDyn *bc_remove_all(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *self = bc_this();
  ScrDyn *handled;
  if (bc_stream_event(SCR_EE_M_REMOVE_ALL, self, args, argc, &handled)) {
    scr_dyn_release(self);
    return handled;
  }
  if (!bc_require_object(self, "_events")) {
    scr_dyn_release(self);
    return NULL;
  }
  ScrDyn *type = bc_arg(args, argc, 0);
  bool all = argc == 0;
  ScrDyn *events = bc_get(self, "_events");
  ScrDyn *watcher = NULL;
  if (!events) goto fail;
  if (bc_undefined(events)) goto done;
  watcher = bc_get(events, "removeListener");
  if (!watcher) goto fail;
  if (bc_undefined(watcher)) {
    if (all) {
      if (!bc_set(self, "_events", scr_dyn_new_obj_null_proto()) || !bc_set(self, "_eventsCount", scr_dyn_new_num(0)))
        goto fail;
    } else {
      ScrDyn *present = bc_get_key(events, type);
      if (!present) goto fail;
      bool has = !bc_undefined(present);
      scr_dyn_release(present);
      if (has) {
        ScrDyn *count = bc_get(self, "_eventsCount");
        if (!count) goto fail;
        double left = bc_number(count) - 1;
        scr_dyn_release(count);
        if (left == 0) {
          if (!bc_set(self, "_events", scr_dyn_new_obj_null_proto()) || !bc_set(self, "_eventsCount", scr_dyn_new_num(0)))
            goto fail;
        } else {
          if (!bc_set(self, "_eventsCount", scr_dyn_new_num(left))) goto fail;
          scr_dyn_key_delete_computed(events, type, false);
          if (scr_exc_pending()) goto fail;
        }
      }
    }
    goto done;
  }
  if (all) {
    ScrDyn *keys = scr_dyn_own_keys(events);
    if (!keys) goto fail;
    double length = scr_dyn_arr_len(keys);
    for (double i = 0; i < length; i++) {
      ScrDyn *key = scr_dyn_index_get(keys, i);
      if (!key) {
        scr_dyn_release(keys);
        goto fail;
      }
      bool skip = key->kind == SCR_DYN_STR && key->v.str->len == 14 && memcmp(key->v.str->data, "removeListener", 14) == 0;
      ScrDyn *done_key = NULL;
      if (!skip) {
        ScrDyn *one[1] = { key };
        done_key = bc_invoke(self, "removeAllListeners", one, 1);
      }
      scr_dyn_release(key);
      if (!skip && !done_key) {
        scr_dyn_release(keys);
        goto fail;
      }
      if (done_key) scr_dyn_release(done_key);
    }
    scr_dyn_release(keys);
    ScrDyn *name = bc_key("removeListener");
    ScrDyn *one[1] = { name };
    ScrDyn *cleared = bc_invoke(self, "removeAllListeners", one, 1);
    scr_dyn_release(name);
    if (!cleared) goto fail;
    scr_dyn_release(cleared);
    if (!bc_set(self, "_events", scr_dyn_new_obj_null_proto()) || !bc_set(self, "_eventsCount", scr_dyn_new_num(0)))
      goto fail;
    goto done;
  }
  {
    ScrDyn *listeners = bc_get_key(events, type);
    if (!listeners) goto fail;
    if (scr_dyn_is_callable(listeners)) {
      ScrDyn *pair[2] = { type, listeners };
      ScrDyn *removed = bc_invoke(self, "removeListener", pair, 2);
      scr_dyn_release(listeners);
      if (!removed) goto fail;
      scr_dyn_release(removed);
    } else if (listeners->kind == SCR_DYN_ARR) {
      for (double i = scr_dyn_arr_len(listeners) - 1; i >= 0; i--) {
        ScrDyn *item = scr_dyn_index_get(listeners, i);
        if (!item) {
          scr_dyn_release(listeners);
          goto fail;
        }
        ScrDyn *pair[2] = { type, item };
        ScrDyn *removed = bc_invoke(self, "removeListener", pair, 2);
        scr_dyn_release(item);
        if (!removed) {
          scr_dyn_release(listeners);
          goto fail;
        }
        scr_dyn_release(removed);
      }
      scr_dyn_release(listeners);
    } else {
      scr_dyn_release(listeners);
    }
  }
done:
  if (watcher) scr_dyn_release(watcher);
  if (events) scr_dyn_release(events);
  return self;
fail:
  if (watcher) scr_dyn_release(watcher);
  if (events) scr_dyn_release(events);
  scr_dyn_release(self);
  return NULL;
}

/* emit(type, ...args): Node's unhandled 'error' rule, then each listener
 * with the emitter as its receiver over a copy of the list. */
static ScrDyn *bc_emit(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *self = bc_this();
  ScrDyn *handled;
  if (bc_stream_event(SCR_EE_M_EMIT, self, args, argc, &handled)) {
    scr_dyn_release(self);
    return handled;
  }
  if (!bc_require_object(self, "_events")) {
    scr_dyn_release(self);
    return NULL;
  }
  ScrDyn *type = bc_arg(args, argc, 0);
  ScrDyn *const *rest = argc > 1 ? args + 1 : bc_unused_args;
  size_t restc = argc > 1 ? argc - 1 : 0;
  bool error = type->kind == SCR_DYN_STR && type->v.str->len == 5 && memcmp(type->v.str->data, "error", 5) == 0;
  ScrDyn *events = bc_get(self, "_events");
  if (!events) goto fail_self;
  if (!bc_undefined(events)) {
    if (error) {
      ScrDyn *handler = bc_get(events, "error");
      if (!handler) goto fail_events;
      error = bc_undefined(handler);
      scr_dyn_release(handler);
    }
  } else if (!error) {
    scr_dyn_release(events);
    scr_dyn_release(self);
    return scr_dyn_new_bool(false);
  }
  if (error) {
    ScrDyn *payload = restc ? rest[0] : scr_dyn_undefined();
    if (scr_dyn_err_instanceof(payload, SCR_ERR_ERROR)) {
      scr_dyn_throw(scr_dyn_retain(payload));
    } else {
      ScrStr *shown = scr_insp_dyn(payload, 0, 2);
      ScrJsonBuf text;
      scr_jb_init(&text);
      scr_jb_puts(&text, "Unhandled error. (");
      scr_jb_put_str(&text, shown);
      scr_jb_putc(&text, ')');
      scr_str_release(shown);
      ScrStr *message = scr_jb_finish(&text);
      scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "ERR_UNHANDLED_ERROR");
      scr_str_release(message);
    }
    goto fail_events;
  }
  ScrDyn *handler = bc_get_key(events, type);
  if (!handler) goto fail_events;
  bool fired = !bc_undefined(handler);
  if (scr_dyn_is_callable(handler)) {
    ScrDyn *result = bc_apply(handler, self, rest, restc);
    scr_dyn_release(handler);
    if (!result) goto fail_events;
    scr_dyn_release(result);
  } else if (handler->kind == SCR_DYN_ARR) {
    /* arrayClone: listeners added or removed during the emit run next time */
    size_t length = (size_t)scr_dyn_arr_len(handler);
    ScrDyn **listeners = malloc((length ? length : 1) * sizeof *listeners);
    if (!listeners) scr_trap("out of memory");
    for (size_t i = 0; i < length; i++) listeners[i] = scr_dyn_index_get(handler, (double)i);
    scr_dyn_release(handler);
    bool ok = true;
    for (size_t i = 0; i < length && ok; i++) {
      if (!listeners[i]) {
        ok = false;
        break;
      }
      ScrDyn *result = bc_apply(listeners[i], self, rest, restc);
      if (!result) ok = false;
      else scr_dyn_release(result);
    }
    for (size_t i = 0; i < length; i++)
      if (listeners[i]) scr_dyn_release(listeners[i]);
    free(listeners);
    if (!ok) goto fail_events;
  } else {
    scr_dyn_release(handler);
  }
  scr_dyn_release(events);
  scr_dyn_release(self);
  return scr_dyn_new_bool(fired);
fail_events:
  scr_dyn_release(events);
fail_self:
  scr_dyn_release(self);
  return NULL;
}

/* _listeners(target, type, unwrap): a fresh array. */
static ScrDyn *bc_listeners_of(bool unwrap, ScrDyn *const *args, size_t argc) {
  ScrDyn *self = bc_this();
  ScrDyn *handled;
  if (bc_stream_event(unwrap ? SCR_EE_M_LISTENERS : SCR_EE_M_RAW_LISTENERS, self, args, argc, &handled)) {
    scr_dyn_release(self);
    return handled;
  }
  if (!bc_require_object(self, "_events")) {
    scr_dyn_release(self);
    return NULL;
  }
  ScrDyn *result = scr_dyn_new_arr();
  ScrDyn *events = bc_get(self, "_events");
  ScrDyn *list = NULL;
  if (!events) goto fail;
  if (bc_undefined(events)) goto done;
  list = bc_get_key(events, bc_arg(args, argc, 0));
  if (!list) goto fail;
  size_t length = scr_dyn_is_callable(list) ? 1 : list->kind == SCR_DYN_ARR ? (size_t)scr_dyn_arr_len(list) : 0;
  for (size_t i = 0; i < length; i++) {
    ScrDyn *item = scr_dyn_is_callable(list) ? scr_dyn_retain(list) : scr_dyn_index_get(list, (double)i);
    if (!item) goto fail;
    if (unwrap && scr_dyn_is_callable(item)) {
      ScrDyn *inner = bc_get(item, "listener");
      if (!inner) {
        scr_dyn_release(item);
        goto fail;
      }
      if (!bc_undefined(inner)) {
        scr_dyn_release(item);
        item = inner;
      } else {
        scr_dyn_release(inner);
      }
    }
    scr_dyn_arr_push(result, item);
  }
done:
  if (list) scr_dyn_release(list);
  if (events) scr_dyn_release(events);
  scr_dyn_release(self);
  return result;
fail:
  if (list) scr_dyn_release(list);
  if (events) scr_dyn_release(events);
  scr_dyn_release(result);
  scr_dyn_release(self);
  return NULL;
}

static ScrDyn *bc_listeners(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return bc_listeners_of(true, args, argc);
}

static ScrDyn *bc_raw_listeners(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return bc_listeners_of(false, args, argc);
}

/* listenerCount(type, listener?) over an emitter's _events. */
static ScrDyn *bc_count_listeners(ScrDyn *self, ScrDyn *type, ScrDyn *only) {
  ScrDyn *events = bc_get(self, "_events");
  if (!events) return NULL;
  double count = 0;
  if (!bc_undefined(events)) {
    ScrDyn *list = bc_get_key(events, type);
    if (!list) {
      scr_dyn_release(events);
      return NULL;
    }
    size_t length = scr_dyn_is_callable(list) ? 1 : list->kind == SCR_DYN_ARR ? (size_t)scr_dyn_arr_len(list) : 0;
    for (size_t i = 0; i < length; i++) {
      if (!only) {
        count++;
        continue;
      }
      ScrDyn *item = scr_dyn_is_callable(list) ? scr_dyn_retain(list) : scr_dyn_index_get(list, (double)i);
      if (!item) break;
      bool same = scr_dyn_strict_eq(item, only);
      if (!same && scr_dyn_is_callable(item)) {
        ScrDyn *inner = bc_get(item, "listener");
        if (inner) {
          same = scr_dyn_strict_eq(inner, only);
          scr_dyn_release(inner);
        }
      }
      scr_dyn_release(item);
      if (same) count++;
    }
    scr_dyn_release(list);
  }
  scr_dyn_release(events);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_new_num(count);
}

static ScrDyn *bc_listener_count(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *self = bc_this();
  ScrDyn *result;
  if (bc_stream_event(SCR_EE_M_LISTENER_COUNT, self, args, argc, &result)) {
    scr_dyn_release(self);
    return result;
  }
  result = bc_require_object(self, "_events")
      ? bc_count_listeners(self, bc_arg(args, argc, 0),
                           argc > 1 && !bc_undefined(args[1]) && args[1]->kind != SCR_DYN_NULL ? args[1] : NULL)
      : NULL;
  scr_dyn_release(self);
  return result;
}

/* EventEmitter.listenerCount(emitter, type): the deprecated static. */
static ScrDyn *bc_static_listener_count(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *emitter = bc_arg(args, argc, 0);
  ScrDyn *type = bc_arg(args, argc, 1);
  ScrDyn *method = bc_require_object(emitter, "listenerCount") ? bc_get(emitter, "listenerCount") : NULL;
  if (!method) return NULL;
  ScrDyn *result;
  if (scr_dyn_is_callable(method)) result = bc_apply(method, emitter, &type, 1);
  else result = bc_count_listeners(emitter, type, NULL);
  scr_dyn_release(method);
  return result;
}

static ScrDyn *bc_event_names(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  ScrDyn *self = bc_this();
  ScrDyn *handled;
  if (bc_stream_event(SCR_EE_M_EVENT_NAMES, self, args, argc, &handled)) {
    scr_dyn_release(self);
    return handled;
  }
  if (!bc_require_object(self, "_eventsCount")) {
    scr_dyn_release(self);
    return NULL;
  }
  ScrDyn *count = bc_get(self, "_eventsCount");
  ScrDyn *result = NULL;
  if (count) {
    if (bc_number(count) > 0) {
      ScrDyn *events = bc_get(self, "_events");
      if (events) {
        result = scr_dyn_own_keys(events);
        scr_dyn_release(events);
      }
    } else {
      result = scr_dyn_new_arr();
    }
    scr_dyn_release(count);
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *bc_set_max(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *self = bc_this();
  ScrDyn *n = bc_arg(args, argc, 0);
  if (n->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("n", "of type number", n);
    scr_dyn_release(self);
    return NULL;
  }
  if (n->v.num < 0 || n->v.num != n->v.num) {
    ScrStr *shown = scr_dyn_string_coerce_js(n);
    ScrJsonBuf text;
    scr_jb_init(&text);
    scr_jb_puts(&text, "The value of \"n\" is out of range. It must be a non-negative number. Received ");
    if (shown) scr_jb_put_str(&text, shown);
    if (shown) scr_str_release(shown);
    ScrStr *message = scr_jb_finish(&text);
    scr_throw_error_msg_code(SCR_ERR_RANGE, message->data, message->len, "ERR_OUT_OF_RANGE");
    scr_str_release(message);
    scr_dyn_release(self);
    return NULL;
  }
  ScrDyn *handled;
  if (bc_stream_event(SCR_EE_M_SET_MAX, self, args, argc, &handled)) {
    scr_dyn_release(self);
    return handled;
  }
  if (!bc_require_object(self, "_maxListeners") || !bc_set(self, "_maxListeners", scr_dyn_retain(n))) {
    scr_dyn_release(self);
    return NULL;
  }
  return self;
}

/* EventEmitter.defaultMaxListeners, Node's accessor over the one default
 * the typed EventEmitter reads too (scr_events_emitter.c). The setter
 * validates as Node's validateNumber(arg, 'defaultMaxListeners', 0). */
static ScrDyn *bc_default_max_get(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  return scr_dyn_new_num(scr_emitter_get_default_max());
}

static ScrDyn *bc_default_max_set(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  static const char name[] = "defaultMaxListeners";
  ScrStr *key = scr_str_new(name, sizeof name - 1);
  scr_emitter_set_default_max_chk(argc ? args[0] : scr_dyn_undefined(), key);
  scr_str_release(key);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

static void bc_define_default_max(ScrDyn *ctor) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3,
                  scr_dyn_new_func(scr_closure_new(NULL, 0), bc_default_max_get, 0, "native:events", "get"));
  scr_dyn_obj_set(descriptor, "set", 3,
                  scr_dyn_new_func(scr_closure_new(NULL, 0), bc_default_max_set, 1, "native:events", "set"));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  ScrStr *name = scr_str_new("defaultMaxListeners", 19);
  ScrDyn *key = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *defined = scr_dyn_define_property(ctor, key, descriptor);
  if (defined) scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
}

static ScrDyn *bc_get_max(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  ScrDyn *self = bc_this();
  ScrDyn *handled;
  if (bc_stream_event(SCR_EE_M_GET_MAX, self, args, argc, &handled)) {
    scr_dyn_release(self);
    return handled;
  }
  double max = bc_require_object(self, "_maxListeners") ? bc_max_listeners(self) : -1;
  scr_dyn_release(self);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_new_num(max);
}

/* ── Stream.prototype.pipe (lib/internal/streams/legacy.js) ─────────── */

enum { BC_PIPE_SOURCE, BC_PIPE_DEST, BC_PIPE_ENDED, BC_PIPE_HANDLERS, BC_PIPE_CAPS };
enum { BC_ONDATA, BC_ONDRAIN, BC_ONEND, BC_ONCLOSE, BC_ONERROR, BC_CLEANUP, BC_HANDLER_COUNT };

static ScrDyn *bc_pipe_handler(ScrClosure *state, int which);

static ScrDyn *bc_pipe_get_handler(ScrClosure *state, int which) {
  ScrDyn *handlers = bc_cap(state, BC_PIPE_HANDLERS);
  ScrDyn *handler = scr_dyn_index_get(handlers, which);
  scr_dyn_release(handlers);
  return handler;
}

/* Calls source/dest.removeListener for one pipe handler. */
static bool bc_pipe_remove(ScrDyn *emitter, const char *event, ScrClosure *state, int which) {
  ScrDyn *handler = bc_pipe_get_handler(state, which);
  if (!handler) return false;
  ScrDyn *name = bc_key(event);
  ScrDyn *pair[2] = { name, handler };
  ScrDyn *removed = bc_invoke(emitter, "removeListener", pair, 2);
  scr_dyn_release(name);
  scr_dyn_release(handler);
  if (!removed) return false;
  scr_dyn_release(removed);
  return true;
}

static bool bc_pipe_on(ScrDyn *emitter, const char *event, ScrClosure *state, int which) {
  ScrDyn *handler = bc_pipe_get_handler(state, which);
  if (!handler) return false;
  ScrDyn *name = bc_key(event);
  ScrDyn *pair[2] = { name, handler };
  ScrDyn *added = bc_invoke(emitter, "on", pair, 2);
  scr_dyn_release(name);
  scr_dyn_release(handler);
  if (!added) return false;
  scr_dyn_release(added);
  return true;
}

static bool bc_pipe_cleanup(ScrClosure *state) {
  /* A second run (dest emitting 'close' from end(), with cleanup still
   * queued on the source's 'end') finds the listeners removed, as Node's
   * repeated removeListener calls do. */
  ScrDyn *handlers = bc_cap(state, BC_PIPE_HANDLERS);
  bool cleaned = handlers->kind == SCR_DYN_ARR && scr_dyn_arr_len(handlers) == 0;
  scr_dyn_release(handlers);
  if (cleaned) return true;
  ScrDyn *source = bc_cap(state, BC_PIPE_SOURCE);
  ScrDyn *dest = bc_cap(state, BC_PIPE_DEST);
  bool ok = bc_pipe_remove(source, "data", state, BC_ONDATA) &&
            bc_pipe_remove(dest, "drain", state, BC_ONDRAIN) &&
            bc_pipe_remove(source, "end", state, BC_ONEND) &&
            bc_pipe_remove(source, "close", state, BC_ONCLOSE) &&
            bc_pipe_remove(source, "error", state, BC_ONERROR) &&
            bc_pipe_remove(dest, "error", state, BC_ONERROR) &&
            bc_pipe_remove(source, "end", state, BC_CLEANUP) &&
            bc_pipe_remove(source, "close", state, BC_CLEANUP) &&
            bc_pipe_remove(dest, "close", state, BC_CLEANUP);
  scr_dyn_release(dest);
  scr_dyn_release(source);
  /* the handlers array held the closures that hold this state */
  if (ok) scr_box_set_ref(state->caps[BC_PIPE_HANDLERS], scr_dyn_new_arr());
  return ok;
}

static ScrDyn *bc_pipe_event(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrClosure *state = (ScrClosure *)scr_box_get_ref(closure->caps[0]);
  int which = (int)scr_box_get_f64(closure->caps[1]);
  ScrDyn *source = bc_cap(state, BC_PIPE_SOURCE);
  ScrDyn *dest = bc_cap(state, BC_PIPE_DEST);
  bool ok = true;
  switch (which) {
  case BC_ONDATA: {
    ScrDyn *writable = bc_get(dest, "writable");
    if (!writable) {
      ok = false;
      break;
    }
    bool open = scr_dyn_truthy(writable);
    scr_dyn_release(writable);
    if (!open) break;
    ScrDyn *chunk = bc_arg(args, argc, 0);
    ScrDyn *written = bc_invoke(dest, "write", &chunk, 1);
    if (!written) {
      ok = false;
      break;
    }
    bool full = written->kind == SCR_DYN_BOOL && !written->v.b;
    scr_dyn_release(written);
    if (full) {
      ScrDyn *pause = bc_get(source, "pause");
      if (!pause) {
        ok = false;
        break;
      }
      if (scr_dyn_is_callable(pause)) {
        ScrDyn *paused = bc_apply(pause, source, bc_unused_args, 0);
        if (paused) scr_dyn_release(paused);
        else ok = false;
      }
      scr_dyn_release(pause);
    }
    break;
  }
  case BC_ONDRAIN: {
    ScrDyn *readable = bc_get(source, "readable");
    ScrDyn *resume = readable ? bc_get(source, "resume") : NULL;
    if (!readable || !resume) {
      ok = false;
    } else if (scr_dyn_truthy(readable) && scr_dyn_is_callable(resume)) {
      ScrDyn *resumed = bc_apply(resume, source, bc_unused_args, 0);
      if (resumed) scr_dyn_release(resumed);
      else ok = false;
    }
    if (readable) scr_dyn_release(readable);
    if (resume) scr_dyn_release(resume);
    break;
  }
  case BC_ONEND:
  case BC_ONCLOSE: {
    if (scr_box_get_f64(state->caps[BC_PIPE_ENDED]) != 0) break;
    scr_box_set_f64(state->caps[BC_PIPE_ENDED], 1);
    ScrDyn *done = which == BC_ONEND ? bc_invoke(dest, "end", bc_unused_args, 0) : NULL;
    if (which == BC_ONCLOSE) {
      ScrDyn *destroy = bc_get(dest, "destroy");
      if (!destroy) {
        ok = false;
        break;
      }
      if (scr_dyn_is_callable(destroy)) done = bc_apply(destroy, dest, bc_unused_args, 0);
      else done = scr_dyn_retain(scr_dyn_undefined());
      scr_dyn_release(destroy);
    }
    if (done) scr_dyn_release(done);
    else ok = false;
    break;
  }
  case BC_ONERROR: {
    ok = bc_pipe_cleanup(state);
    if (!ok) break;
    ScrDyn *rethrow = scr_dyn_this_get();
    ScrDyn *name = bc_key("error");
    ScrDyn *count = rethrow->kind == SCR_DYN_UNDEF ? NULL : bc_invoke(rethrow, "listenerCount", &name, 1);
    scr_dyn_release(name);
    if (count && bc_number(count) == 0) {
      scr_dyn_throw(scr_dyn_retain(bc_arg(args, argc, 0)));
      ok = false;
    } else if (!count && scr_exc_pending()) {
      ok = false;
    }
    if (count) scr_dyn_release(count);
    scr_dyn_release(rethrow);
    break;
  }
  case BC_CLEANUP:
    ok = bc_pipe_cleanup(state);
    break;
  default:
    break;
  }
  scr_dyn_release(dest);
  scr_dyn_release(source);
  scr_closure_release(state);
  return ok ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
}

static ScrDyn *bc_pipe_handler(ScrClosure *state, int which) {
  ScrClosure *closure = scr_closure_new(NULL, 2);
  ScrBox *owner = scr_box_new_obj(scr_closure_retain_v, scr_closure_release_v, scr_closure_trace_v);
  scr_box_set_ref(owner, scr_closure_retain(state));
  closure->caps[0] = owner;
  closure->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[1], which);
  return scr_dyn_new_func(closure, bc_pipe_event, 0, "native:stream", which == BC_ONDATA ? "ondata"
      : which == BC_ONDRAIN ? "ondrain" : which == BC_ONEND ? "onend" : which == BC_ONCLOSE ? "onclose"
      : which == BC_ONERROR ? "onerror" : "cleanup");
}

/* Stream.prototype.pipe(dest, options): Node's legacy pipe for streams
 * that are only EventEmitters. 'end' and 'close' end or destroy the
 * destination unless options.end is false or the destination is stdio. */
static ScrDyn *bc_pipe(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *source = bc_this();
  ScrDyn *dest = bc_arg(args, argc, 0);
  ScrDyn *options = bc_arg(args, argc, 1);
  if (!bc_require_object(source, "on") || !bc_require_object(dest, "on")) {
    scr_dyn_release(source);
    return NULL;
  }
  ScrClosure *state = scr_closure_new(NULL, BC_PIPE_CAPS);
  state->caps[BC_PIPE_SOURCE] = bc_box(scr_dyn_retain(source));
  state->caps[BC_PIPE_DEST] = bc_box(scr_dyn_retain(dest));
  state->caps[BC_PIPE_ENDED] = scr_box_new(SCR_BOX_F64);
  ScrDyn *handlers = scr_dyn_new_arr();
  for (int i = 0; i < BC_HANDLER_COUNT; i++) scr_dyn_arr_push(handlers, bc_pipe_handler(state, i));
  state->caps[BC_PIPE_HANDLERS] = bc_box(handlers);
  bool ok = bc_pipe_on(source, "data", state, BC_ONDATA) && bc_pipe_on(dest, "drain", state, BC_ONDRAIN);
  bool end_dest = true;
  if (ok && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL) {
    ScrDyn *end = bc_get(options, "end");
    if (!end) ok = false;
    else {
      end_dest = !(end->kind == SCR_DYN_BOOL && !end->v.b);
      scr_dyn_release(end);
    }
  }
  if (ok && end_dest) {
    ScrDyn *stdio = bc_get(dest, "_isStdio");
    if (!stdio) ok = false;
    else {
      end_dest = !scr_dyn_truthy(stdio);
      scr_dyn_release(stdio);
    }
  }
  if (ok && end_dest)
    ok = bc_pipe_on(source, "end", state, BC_ONEND) && bc_pipe_on(source, "close", state, BC_ONCLOSE);
  if (ok) {
    /* prependListener(source, 'error', onerror) and the same on dest */
    ScrDyn *onerror = bc_pipe_get_handler(state, BC_ONERROR);
    ScrDyn *name = bc_key("error");
    ScrDyn *pair[2] = { name, onerror };
    ScrDyn *a = onerror ? bc_invoke(source, "prependListener", pair, 2) : NULL;
    ScrDyn *b = a ? bc_invoke(dest, "prependListener", pair, 2) : NULL;
    ok = a && b;
    if (a) scr_dyn_release(a);
    if (b) scr_dyn_release(b);
    scr_dyn_release(name);
    if (onerror) scr_dyn_release(onerror);
  }
  if (ok)
    ok = bc_pipe_on(source, "end", state, BC_CLEANUP) && bc_pipe_on(source, "close", state, BC_CLEANUP) &&
         bc_pipe_on(dest, "close", state, BC_CLEANUP);
  ScrDyn *result = NULL;
  if (ok) {
    ScrDyn *name = bc_key("pipe");
    ScrDyn *pair[2] = { name, source };
    ScrDyn *emitted = bc_invoke(dest, "emit", pair, 2);
    scr_dyn_release(name);
    if (emitted) {
      scr_dyn_release(emitted);
      result = scr_dyn_retain(dest);
    }
  }
  scr_closure_release(state);
  scr_dyn_release(source);
  return result;
}

/* ── the constructors ───────────────────────────────────────────────── */

static ScrDyn *bc_construct(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  int kind = (int)scr_box_get_f64(closure->caps[0]);
  ScrDyn *self = bc_this();
  ScrDyn *result = NULL;
  if (kind == BC_EMITTER || kind == BC_STREAM) {
    if (bc_emitter_init(self, bc_arg(args, argc, 0))) result = scr_dyn_retain(scr_dyn_undefined());
  } else if (bc_stream_ops) {
    result = bc_stream_ops->construct(kind, self, args, argc);
  } else {
    char message[160];
    snprintf(message, sizeof message,
             "'%s' as the base of a constructor function (util.inherits or %s.call(this)) is not supported yet",
             bc_names[kind], bc_names[kind]);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
  }
  scr_dyn_release(self);
  return result;
}

static void bc_method(ScrDyn *prototype, const char *name, ScrDynThunk thunk, uint32_t arity) {
  ScrDyn *fn = scr_dyn_new_func(scr_closure_new(NULL, 0), thunk, arity, "native:events", name);
  bc_set(prototype, name, fn);
}

static void bc_alias(ScrDyn *prototype, const char *alias, const char *name) {
  ScrDyn *fn = bc_get(prototype, name);
  if (fn) bc_set(prototype, alias, fn);
}

static void bc_teardown(void) {
  for (int i = 0; i < BC_COUNT; i++) {
    if (!bc_ctors[i]) continue;
    ScrDyn *ctor = bc_ctors[i];
    /* prototype.constructor, EventEmitter.EventEmitter and Stream.Stream
     * point back at the constructor, and Stream.Readable … at constructors
     * whose own prototype is Stream: break those cycles first. */
    ScrDyn *prototype = bc_get(ctor, "prototype");
    if (prototype && prototype->kind == SCR_DYN_OBJ) bc_set(prototype, "constructor", scr_dyn_retain(scr_dyn_undefined()));
    if (prototype) scr_dyn_release(prototype);
    bc_set(ctor, bc_names[i], scr_dyn_retain(scr_dyn_undefined()));
    if (i == BC_STREAM)
      for (int other = BC_READABLE; other < BC_COUNT; other++)
        bc_set(ctor, bc_names[other], scr_dyn_retain(scr_dyn_undefined()));
    if (scr_exc_pending()) scr_exc_clear();
  }
  for (int i = 0; i < BC_COUNT; i++) {
    if (!bc_ctors[i]) continue;
    ScrDyn *ctor = bc_ctors[i];
    bc_ctors[i] = NULL;
    scr_dyn_release(ctor);
  }
  for (int i = 0; i < BC_SYMBOLS; i++) {
    if (bc_symbols[i]) scr_dyn_release(bc_symbols[i]);
    bc_symbols[i] = NULL;
  }
  if (scr_exc_pending()) scr_exc_clear();
}

static ScrDyn *bc_new_class(int kind, ScrDyn *parent) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->function_kind = SCR_CLOSURE_KIND_OWN_PROTOTYPE;
  closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[0], kind);
  ScrDyn *ctor = scr_dyn_new_func(closure, bc_construct, 1, "native:events", bc_names[kind]);
  ScrDyn *prototype = parent ? NULL : scr_dyn_new_obj();
  if (parent) {
    ScrDyn *base = bc_get(parent, "prototype");
    prototype = scr_dyn_obj_create(base);
    scr_dyn_release(base);
    ScrDyn *linked = scr_dyn_set_prototype(ctor, parent);
    if (linked) scr_dyn_release(linked);
  }
  bc_set(prototype, "constructor", scr_dyn_retain(ctor));
  bc_set(ctor, "prototype", scr_dyn_retain(prototype));
  if (kind == BC_EMITTER) {
    bc_set(prototype, "_events", scr_dyn_retain(scr_dyn_undefined()));
    bc_set(prototype, "_eventsCount", scr_dyn_new_num(0));
    bc_set(prototype, "_maxListeners", scr_dyn_retain(scr_dyn_undefined()));
    bc_set_key(prototype, bc_symbol(BC_CAPTURE), scr_dyn_new_bool(false));
    bc_method(prototype, "setMaxListeners", bc_set_max, 1);
    bc_method(prototype, "getMaxListeners", bc_get_max, 0);
    bc_method(prototype, "emit", bc_emit, 1);
    bc_method(prototype, "addListener", bc_on, 2);
    bc_alias(prototype, "on", "addListener");
    bc_method(prototype, "prependListener", bc_prepend, 2);
    bc_method(prototype, "once", bc_once, 2);
    bc_method(prototype, "prependOnceListener", bc_prepend_once, 2);
    bc_method(prototype, "removeListener", bc_off, 2);
    bc_alias(prototype, "off", "removeListener");
    bc_method(prototype, "removeAllListeners", bc_remove_all, 1);
    bc_method(prototype, "listeners", bc_listeners, 1);
    bc_method(prototype, "rawListeners", bc_raw_listeners, 1);
    bc_method(prototype, "listenerCount", bc_listener_count, 2);
    bc_method(prototype, "eventNames", bc_event_names, 0);
    bc_set(ctor, "EventEmitter", scr_dyn_retain(ctor));
    bc_define_default_max(ctor);
    ScrDyn *count = scr_dyn_new_func(scr_closure_new(NULL, 0), bc_static_listener_count, 2, "native:events", "listenerCount");
    bc_set(ctor, "listenerCount", count);
  } else if (kind == BC_STREAM) {
    ScrDyn *pipe = scr_dyn_new_func(scr_closure_new(NULL, 0), bc_pipe, 2, "native:stream", "pipe");
    bc_set(prototype, "pipe", pipe);
  } else if (bc_stream_ops) {
    bc_stream_ops->prototype(kind, prototype);
  }
  scr_dyn_release(prototype);
  if (scr_exc_pending()) scr_exc_clear();
  return ctor;
}

/* All seven constructors are created together, each after its parent, so
 * Stream's static members name the same constructors every other read
 * answers. */
static ScrDyn *bc_class(int kind) {
  if (!bc_ctors[kind]) {
    static const int parents[BC_COUNT] = {
      -1, BC_EMITTER, BC_STREAM, BC_STREAM, BC_READABLE, BC_DUPLEX, BC_TRANSFORM,
    };
    for (int each = 0; each < BC_COUNT; each++) {
      if (bc_ctors[each]) continue;
      bc_ctors[each] = bc_new_class(each, parents[each] >= 0 ? bc_ctors[parents[each]] : NULL);
    }
    /* Registered after the constructors exist, so the teardown runs before
     * the runtime state their properties were stored in (scr_atexit is
     * last in, first out). */
    if (!bc_teardown_registered) {
      bc_teardown_registered = true;
      scr_atexit(bc_teardown);
    }
    /* require("stream") is Stream itself, carrying its classes */
    ScrDyn *stream = bc_ctors[BC_STREAM];
    bc_set(stream, "Stream", scr_dyn_retain(stream));
    for (int other = BC_READABLE; other < BC_COUNT; other++)
      bc_set(stream, bc_names[other], scr_dyn_retain(bc_ctors[other]));
    if (scr_exc_pending()) scr_exc_clear();
  }
  return bc_ctors[kind];
}

/* Registers the stream half; constructors that already exist get their
 * stream prototypes' methods now. */
void scr_dyn_builtin_class_streams(const ScrDynStreamOps *ops) {
  if (bc_stream_ops) return;
  bc_stream_ops = ops;
  for (int kind = BC_READABLE; kind < BC_COUNT; kind++) {
    if (!bc_ctors[kind]) continue;
    ScrDyn *prototype = bc_get(bc_ctors[kind], "prototype");
    if (prototype) {
      ops->prototype(kind, prototype);
      scr_dyn_release(prototype);
    }
    if (scr_exc_pending()) scr_exc_clear();
  }
}

/* The constructor value for kind (the BC_* order), +1. */
ScrDyn *scr_dyn_builtin_class(double kind) {
  int index = (int)kind;
  if (index < 0 || index >= BC_COUNT) scr_trap("scriptc: unknown builtin class value\n");
  return scr_dyn_retain(bc_class(index));
}

/* OrdinaryHasInstance over the value's prototype chain. */
static bool bc_chain_has(ScrDyn *value, ScrDyn *prototype) {
  ScrDyn *current;
#ifdef SCR_HANDLE_CLASSES
  /* A handle of a class (scr_dyn_handle_class.c) has the class's
   * prototype; this build is the one programs with such classes link. */
  if (value->kind == SCR_DYN_HANDLE) {
    current = scr_dyn_handle_class_prototype_of(value);
    if (!current) return false;
  } else
#endif
  {
    if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_ARR && value->kind != SCR_DYN_FUNC &&
        value->kind != SCR_DYN_PROXY)
      return false;
    current = scr_dyn_get_prototype(value);
  }
  while (current && current->kind != SCR_DYN_NULL) {
    if (scr_dyn_strict_eq(current, prototype)) {
      scr_dyn_release(current);
      return true;
    }
    ScrDyn *next = scr_dyn_get_prototype(current);
    scr_dyn_release(current);
    current = next;
  }
  if (current) scr_dyn_release(current);
  return false;
}

/* `value instanceof <kind>`. Node's Writable also answers true for an
 * object whose _writableState is a WritableState, which no untyped object
 * has, so the prototype chain answers for every kind. */
bool scr_dyn_builtin_instanceof(ScrDyn *value, double kind) {
  int index = (int)kind;
  if (index < 0 || index >= BC_COUNT) scr_trap("scriptc: unknown builtin class value\n");
  ScrDyn *prototype = bc_get(bc_class(index), "prototype");
  if (!prototype) return false;
  bool found = bc_chain_has(value, prototype);
  scr_dyn_release(prototype);
  return found;
}

/* `value instanceof callee` for an untyped constructor function. */
bool scr_dyn_function_instanceof(ScrDyn *value, ScrDyn *callee) {
#ifdef SCR_NODE_ISLANDS
  if (scr_ni_is_handle(callee)) return scr_ni_instanceof(value, callee) == 1;
#endif
  if (!scr_dyn_is_callable(callee)) {
    static const char message[] = "Right-hand side of 'instanceof' is not callable";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  int hooked = scr_dyn_has_instance_hook(value, callee);
  if (hooked >= 0) return hooked == 1;
  ScrDyn *prototype = bc_get(callee, "prototype");
  if (!prototype) return false;
  bool found = false;
  if (prototype->kind == SCR_DYN_OBJ || prototype->kind == SCR_DYN_ARR || prototype->kind == SCR_DYN_FUNC ||
      prototype->kind == SCR_DYN_PROXY) {
    found = bc_chain_has(value, prototype);
  } else if (value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_FUNC) {
    static const char message[] = "Function has non-object prototype 'undefined' in instanceof check";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  }
  scr_dyn_release(prototype);
  return found;
}
