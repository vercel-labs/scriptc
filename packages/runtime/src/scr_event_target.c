/* EventTarget, Event and CustomEvent over checked-dynamic values — Node's
 * lib/internal/event_target.js, step for step (scr_runtime.h has the
 * layout contract).
 *
 * Listeners for one event type form a linked list in registration order.
 * Every node holds a reference on its `next` node and keeps that link when
 * it is removed, exactly the JS objects Node walks: a dispatch caches the
 * next node before a callback runs, skips nodes flagged removed, and
 * continues from a removed node into whatever it last pointed at. Type
 * roots are refcounted the same way, so a dispatch keeps walking a root
 * that removeEventListener dropped from the target's map.
 */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <process.h>
#define SCR_ET_PID() ((long)_getpid())
#else
#include <unistd.h>
#define SCR_ET_PID() ((long)getpid())
#endif

enum {
  SCR_ET_ONCE = 1 << 0,
  SCR_ET_CAPTURE = 1 << 1,
  SCR_ET_PASSIVE = 1 << 2,
  SCR_ET_RESIST = 1 << 3, /* runs after stopImmediatePropagation */
  SCR_ET_REMOVED = 1 << 4,
};

/* What a native listener node is: Node registers a function of its own in
 * both cases, so getEventListeners reports one where scr_et_native_value
 * builds it. */
enum {
  SCR_ET_VALUE_NONE = 0,
  SCR_ET_VALUE_HOOK,    /* options.signal's removal hook */
  SCR_ET_VALUE_HANDLER, /* an on<type> attribute's wrapper */
};

typedef struct ScrEtListener ScrEtListener;

struct ScrEtListener {
  size_t rc;
  ScrEtListener *next; /* +1 */
  ScrEtListener *prev; /* weak; NULL when the root is the predecessor */
  ScrEtRoot *root;     /* weak; the root outlives its live nodes */
  unsigned flags;
  ScrDyn *listener;    /* +1; NULL for a native listener */
  /* Native listeners: options.signal removal hooks and `on<type>`
   * attribute wrappers. */
  void (*native)(void *ctx, ScrDyn *self, ScrDyn *event);
  void *ctx;
  void (*ctx_release)(void *ctx);
  unsigned char native_kind; /* SCR_ET_VALUE_*, for a native node */
};

struct ScrEtRoot {
  size_t rc;
  ScrEventTargetCore *core; /* weak; NULL once the root leaves the map */
  ScrEtRoot *map_next;      /* the map's own reference order */
  ScrStr *type;
  size_t size;
  bool resist;
  ScrEtListener *head; /* +1 */
};

struct ScrEtHandler {
  size_t rc;
  ScrStr *type;
  ScrDyn *handler; /* +1 or NULL (null) */
  ScrEtHandler *next;
};

/* `signal.addEventListener('abort', () => this.removeEventListener(type,
 * listener, options), { once: true, [kWeakHandler]: this, ... })`: the
 * signal's listener list owns the hook; the target is weak (its core
 * clears `target` when it is dropped). */
struct ScrEtHook {
  size_t rc;
  ScrEventTargetCore *target; /* weak */
  ScrEtHook *target_next;     /* the target's hook registry */
  ScrDyn *type;     /* +1, converted when the hook fires (Node's order) */
  ScrDyn *listener; /* +1 */
  bool capture;
};

static void scr_et_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void *scr_et_calloc(size_t n) {
  void *p = calloc(1, n);
  if (!p) scr_et_oom();
  return p;
}

static bool scr_et_eq(const ScrStr *s, const char *want) {
  return s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

static void scr_et_type_error(const char *message, const char *code) {
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), code);
}

/* ── teardown registries ─────────────────────────────────────────────
 * Listener closures and events can reach their targets again (a closure
 * capturing the target, an event's target), cycles the RC scheme does not
 * collect. Cores with listeners and events holding references register
 * here, and exit drops them before the RC audit counts. */

static SCR_TL ScrEventTargetCore *scr_et_live_cores;
static SCR_TL ScrEvent *scr_et_live_events;
static SCR_TL bool scr_et_teardown_registered;

static void scr_et_teardown(void);

static void scr_et_register_teardown(void) {
  if (scr_et_teardown_registered) return;
  scr_et_teardown_registered = true;
  scr_atexit(scr_et_teardown);
}

static void scr_et_core_track(ScrEventTargetCore *core) {
  if (core->tracked) return;
  scr_et_register_teardown();
  core->tracked = true;
  core->tracked_prev = NULL;
  core->tracked_next = scr_et_live_cores;
  if (scr_et_live_cores) scr_et_live_cores->tracked_prev = core;
  scr_et_live_cores = core;
}

static void scr_et_core_untrack(ScrEventTargetCore *core) {
  if (!core->tracked) return;
  if (core->tracked_prev) core->tracked_prev->tracked_next = core->tracked_next;
  else scr_et_live_cores = core->tracked_next;
  if (core->tracked_next) core->tracked_next->tracked_prev = core->tracked_prev;
  core->tracked = false;
  core->tracked_prev = core->tracked_next = NULL;
}

static void scr_event_track(ScrEvent *ev) {
  if (ev->tracked) return;
  scr_et_register_teardown();
  ev->tracked = true;
  ev->tracked_prev = NULL;
  ev->tracked_next = scr_et_live_events;
  if (scr_et_live_events) scr_et_live_events->tracked_prev = ev;
  scr_et_live_events = ev;
}

static void scr_event_untrack(ScrEvent *ev) {
  if (!ev->tracked) return;
  if (ev->tracked_prev) ev->tracked_prev->tracked_next = ev->tracked_next;
  else scr_et_live_events = ev->tracked_next;
  if (ev->tracked_next) ev->tracked_next->tracked_prev = ev->tracked_prev;
  ev->tracked = false;
  ev->tracked_prev = ev->tracked_next = NULL;
}

/* ── listener nodes and type roots ─────────────────────────────────── */

static ScrEtListener *scr_et_listener_retain(ScrEtListener *l) {
  if (l) l->rc++;
  return l;
}

static void scr_et_listener_release(ScrEtListener *l) {
  while (l && --l->rc == 0) {
    ScrEtListener *next = l->next;
    scr_dyn_release(l->listener);
    if (l->ctx_release) l->ctx_release(l->ctx);
    free(l);
    l = next; /* the reference this node held */
  }
}

static ScrEtRoot *scr_et_root_retain(ScrEtRoot *r) {
  r->rc++;
  return r;
}

static void scr_et_root_release(ScrEtRoot *r) {
  if (!r || --r->rc > 0) return;
  scr_et_listener_release(r->head);
  scr_str_release(r->type);
  free(r);
}

/* Listener.remove(): unlink, keep `next`, flag removed. */
static void scr_et_listener_remove(ScrEtListener *l) {
  ScrEtListener *next = l->next;
  if (next) next->prev = l->prev;
  l->flags |= SCR_ET_REMOVED;
  /* The predecessor's link may be the last reference to l. */
  if (l->prev) {
    l->prev->next = scr_et_listener_retain(next);
  } else if (l->root) {
    l->root->head = scr_et_listener_retain(next);
  } else {
    return;
  }
  scr_et_listener_release(l);
}

static ScrEtRoot *scr_et_root_find(const ScrEventTargetCore *core, const ScrStr *type) {
  for (ScrEtRoot *r = core->roots; r; r = r->map_next) {
    if (r->type->len == type->len && memcmp(r->type->data, type->data, type->len) == 0) return r;
  }
  return NULL;
}

/* this[kEvents].delete(type) */
static void scr_et_root_unmap(ScrEventTargetCore *core, ScrEtRoot *root) {
  for (ScrEtRoot **at = &core->roots; *at; at = &(*at)->map_next) {
    if (*at == root) {
      *at = root->map_next;
      root->map_next = NULL;
      root->core = NULL;
      scr_et_root_release(root);
      return;
    }
  }
}

/* ── options.signal hooks ──────────────────────────────────────────── */

static void scr_et_hook_release(void *ctx) {
  ScrEtHook *h = ctx;
  if (--h->rc > 0) return;
  if (h->target) {
    for (ScrEtHook **at = &h->target->hooks; *at; at = &(*at)->target_next) {
      if (*at == h) {
        *at = h->target_next;
        break;
      }
    }
  }
  scr_dyn_release(h->type);
  scr_dyn_release(h->listener);
  free(h);
}

static void scr_et_remove_matching(ScrEventTargetCore *core, const ScrStr *type,
                                   const ScrDyn *listener, bool capture);
static int scr_et_listener_check(const ScrDyn *listener);
static void scr_et_report(ScrCaught *caught);

static void scr_et_hook_fire(void *ctx, ScrDyn *self, ScrDyn *event) {
  (void)self;
  (void)event;
  ScrEtHook *h = ctx;
  if (!h->target || scr_et_listener_check(h->listener) <= 0) {
    if (scr_exc_pending()) scr_et_report(scr_exc_take());
    return;
  }
  ScrStr *type = scr_dyn_string_coerce_js(h->type);
  if (!type) {
    scr_et_report(scr_exc_take());
    return;
  }
  scr_et_remove_matching(h->target, type, h->listener, h->capture);
  scr_str_release(type);
}

/* ── listener values ───────────────────────────────────────────────── */

/* validateEventListener: true for a function or an object (handleEvent is
 * read at dispatch), false for null/undefined, a TypeError otherwise. */
static int scr_et_listener_check(const ScrDyn *listener) {
  switch (listener->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
    return 0;
  case SCR_DYN_FUNC:
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_PROXY:
    return 1;
  case SCR_DYN_TYPED_REF:
    if (scr_dyn_ref_typeof_is(listener, "function") || scr_dyn_ref_typeof_is(listener, "object"))
      return 1;
    break;
  default:
    break;
  }
  scr_dyn_arg_type_fail("listener", "an instance of EventListener", listener);
  return -1;
}

static bool scr_et_listener_same(const ScrDyn *a, const ScrDyn *b) {
  return scr_dyn_strict_eq(a, b) || scr_dyn_obj_same_source(a, b);
}

/* ── the warnings Node prints through process.emitWarning ───────────── */

typedef struct {
  char name[48];
  ScrStr *message;
} ScrEtWarning;

static void *scr_et_warning_retain_v(void *p) { return p; }
static void scr_et_warning_release_v(void *p) {
  ScrEtWarning *w = p;
  scr_str_release(w->message);
  free(w);
}

static void scr_et_warn_tick(ScrClosure *cb) {
  ScrEtWarning *w = scr_box_get_ref(cb->caps[0]);
  if (scr_warning_emit_hook) {
    scr_warning_emit_hook(w->name, NULL, w->message);
    return;
  }
  scr_stdout_settle();
  fflush(stdout);
  fprintf(stderr, "(node:%ld) %s: %.*s\n", SCR_ET_PID(), w->name, (int)w->message->len,
          w->message->data);
  if (!scr_warning_trace_hint_shown) {
    scr_warning_trace_hint_shown = true;
    fputs("(Use `node --trace-warnings ...` to show where the warning was created)\n", stderr);
  }
}

/* process.emitWarning: listeners and the default report run from a
 * nextTick. */
static void scr_et_warn(const char *name, const char *message) {
  ScrEtWarning *w = scr_et_calloc(sizeof *w);
  snprintf(w->name, sizeof w->name, "%s", name);
  w->message = scr_str_new(message, strlen(message));
  ScrClosure *cb = scr_closure_new((void *)&scr_et_warn_tick, 1);
  cb->caps[0] = scr_box_new_obj(&scr_et_warning_retain_v, &scr_et_warning_release_v, NULL);
  scr_box_set_ref(cb->caps[0], w);
  scr_next_tick(cb);
}

/* this[kNewListener]: the one-time leak warning. */
static void scr_et_new_listener(ScrEventTargetCore *core, ScrEtRoot *root) {
  if (core->max_listeners <= 0 || (double)root->size <= core->max_listeners || core->warned) return;
  core->warned = true;
  char message[512];
  snprintf(message, sizeof message,
           "Possible EventTarget memory leak detected. %zu %.*s listeners added to %s. "
           "MaxListeners is %g. Use events.setMaxListeners() to increase limit",
           root->size, (int)root->type->len, root->type->data, core->cls, core->max_listeners);
  scr_et_warn("MaxListenersExceededWarning", message);
}

/* ── the core ──────────────────────────────────────────────────────── */

void scr_et_core_init(ScrEventTargetCore *core, double max_listeners, const char *cls) {
  memset(core, 0, sizeof *core);
  core->max_listeners = max_listeners;
  core->cls = cls;
}

void scr_et_core_drop(ScrEventTargetCore *core) {
  scr_et_core_untrack(core);
  /* Released last: it may hold the instance that owns this core. */
  ScrDyn *self = core->self;
  core->self = NULL;
  ScrEtRoot *roots = core->roots;
  ScrEtHandler *handlers = core->handlers;
  core->roots = NULL;
  core->handlers = NULL;
  /* Hooks aimed at this target stay registered on their signals and do
   * nothing once fired (Node's weak handler). */
  while (core->hooks) {
    ScrEtHook *h = core->hooks;
    core->hooks = h->target_next;
    h->target = NULL;
    h->target_next = NULL;
  }
  while (roots) {
    ScrEtRoot *next = roots->map_next;
    roots->core = NULL;
    roots->map_next = NULL;
    scr_et_root_release(roots);
    roots = next;
  }
  while (handlers) {
    ScrEtHandler *next = handlers->next;
    handlers->next = NULL;
    if (--handlers->rc == 0) {
      scr_str_release(handlers->type);
      scr_dyn_release(handlers->handler);
      free(handlers);
    } else {
      /* A wrapper still on a dispatch's stack keeps the slot; the handler
       * value goes now so no cycle survives teardown. */
      ScrDyn *handler = handlers->handler;
      handlers->handler = NULL;
      scr_dyn_release(handler);
    }
    handlers = next;
  }
  scr_dyn_release(self);
}

/* Appends a listener node to the type's list (Node's addEventListener
 * tail). `listener` borrowed (retained in); for native nodes NULL. */
static ScrEtListener *scr_et_append(ScrEventTargetCore *core, ScrStr *type, ScrDyn *listener,
                                    unsigned flags, bool *duplicate) {
  *duplicate = false;
  ScrEtRoot *root = scr_et_root_find(core, type);
  bool fresh = root == NULL;
  ScrEtListener *previous = NULL;
  if (fresh) {
    root = scr_et_calloc(sizeof *root);
    root->rc = 1; /* the map's reference */
    root->core = core;
    root->type = scr_str_retain(type);
    ScrEtRoot **tail = &core->roots;
    while (*tail) tail = &(*tail)->map_next;
    *tail = root;
  } else if (listener) {
    bool capture = (flags & SCR_ET_CAPTURE) != 0;
    for (ScrEtListener *h = root->head; h; h = h->next) {
      if (h->listener && ((h->flags & SCR_ET_CAPTURE) != 0) == capture &&
          scr_et_listener_same(h->listener, listener)) {
        *duplicate = true;
        return NULL;
      }
      previous = h;
    }
  } else {
    for (ScrEtListener *h = root->head; h; h = h->next) previous = h;
  }
  ScrEtListener *l = scr_et_calloc(sizeof *l);
  l->rc = 1; /* the predecessor's link */
  l->root = root;
  l->prev = previous;
  l->flags = flags;
  l->listener = listener ? scr_dyn_retain(listener) : NULL;
  if (previous) previous->next = l;
  else root->head = l;
  root->size = fresh ? 1 : root->size + 1;
  if (flags & SCR_ET_RESIST) root->resist = true;
  scr_et_core_track(core);
  return l;
}

static void scr_et_remove_matching(ScrEventTargetCore *core, const ScrStr *type,
                                   const ScrDyn *listener, bool capture) {
  ScrEtRoot *root = scr_et_root_find(core, type);
  if (!root || !root->head) return;
  for (ScrEtListener *h = root->head; h; h = h->next) {
    if (h->listener && ((h->flags & SCR_ET_CAPTURE) != 0) == capture &&
        scr_et_listener_same(h->listener, listener)) {
      scr_et_listener_remove(h);
      root->size--;
      if (root->size == 0) scr_et_root_unmap(core, root);
      return;
    }
  }
}

/* A property read on an options dictionary: typed records cross as live
 * capsules, read through their materialized view. +1 or NULL. */
static ScrDyn *scr_et_prop(const ScrDyn *object, const char *key) {
  if (object->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    ScrDyn *value = view ? scr_dyn_obj_read(view, key, strlen(key)) : NULL;
    scr_dyn_release(view);
    return value;
  }
  return scr_dyn_obj_read(object, key, strlen(key));
}

/* The listener options: a boolean is `capture`, null is no options, any
 * object's once/capture/passive/signal are read in Node's order. */
typedef struct {
  bool once, capture, passive;
  ScrDyn *signal; /* +1 or NULL */
} ScrEtOptions;

static bool scr_et_read_options(const ScrDyn *options, ScrEtOptions *out) {
  memset(out, 0, sizeof *out);
  if (!options || options->kind == SCR_DYN_UNDEF) return true;
  if (options->kind == SCR_DYN_BOOL) {
    out->capture = options->v.b;
    return true;
  }
  if (options->kind == SCR_DYN_NULL) return true;
  if (!scr_dyn_is_object(options) && options->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return false;
  }
  static const char *const keys[] = {"once", "capture", "passive"};
  bool *slots[] = {&out->once, &out->capture, &out->passive};
  for (size_t i = 0; i < 3; i++) {
    ScrDyn *v = scr_et_prop(options, keys[i]);
    if (!v && scr_exc_pending()) return false;
    *slots[i] = v && scr_dyn_truthy(v);
    scr_dyn_release(v);
  }
  ScrDyn *signal = scr_et_prop(options, "signal");
  if (!signal && scr_exc_pending()) return false;
  if (signal && signal->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(signal);
    signal = NULL;
  }
  out->signal = signal;
  return true;
}

SCR_TL ScrEventTargetCore *(*scr_et_signal_core_fn)(const ScrDyn *d, bool *aborted) = NULL;

/* The event type is coerced with String(), which a symbol has no form for:
 * Node reports that as ERR_INVALID_ARG_TYPE with this message rather than
 * the language's TypeError. */
static bool scr_et_symbol_type_fail(const ScrDyn *type) {
  if (type->kind != SCR_DYN_SYMBOL) return false;
  static const char message[] = "Value is a Symbol and cannot be converted to a string.";
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
  return true;
}

ScrDyn *scr_et_add_listener(ScrEventTargetCore *core, ScrDyn *const *args, size_t argc) {
  if (argc < 2) {
    scr_et_type_error("The \"type\" and \"listener\" arguments must be specified", "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrEtOptions opts;
  if (!scr_et_read_options(argc > 2 ? args[2] : NULL, &opts)) return NULL;
  if (opts.signal) {
    bool aborted = false;
    ScrEventTargetCore *signal_core =
        scr_et_signal_core_fn ? scr_et_signal_core_fn(opts.signal, &aborted) : NULL;
    if (!signal_core) {
      scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", opts.signal);
      scr_dyn_release(opts.signal);
      return NULL;
    }
    scr_dyn_release(opts.signal);
    if (aborted) return scr_dyn_retain(scr_dyn_undefined());
    ScrEtHook *h = scr_et_calloc(sizeof *h);
    h->rc = 1;
    h->type = scr_dyn_retain(args[0]);
    h->listener = scr_dyn_retain(args[1]);
    h->capture = opts.capture;
    h->target = core;
    h->target_next = core->hooks;
    core->hooks = h;
    ScrStr *abort = scr_str_new("abort", 5);
    bool duplicate;
    ScrEtListener *l =
        scr_et_append(signal_core, abort, NULL, SCR_ET_ONCE | SCR_ET_RESIST, &duplicate);
    scr_str_release(abort);
    l->native = scr_et_hook_fire;
    l->native_kind = SCR_ET_VALUE_HOOK;
    l->ctx = h; /* the creation reference moves in */
    l->ctx_release = scr_et_hook_release;
  }
  int valid = scr_et_listener_check(args[1]);
  if (valid < 0) return NULL;
  if (valid == 0) {
    char message[96];
    snprintf(message, sizeof message, "addEventListener called with %s which has no effect.",
             args[1]->kind == SCR_DYN_NULL ? "null" : "undefined");
    scr_et_warn("AddEventListenerArgumentTypeWarning", message);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (scr_et_symbol_type_fail(args[0])) return NULL;
  ScrStr *type = scr_dyn_string_coerce_js(args[0]);
  if (!type) return NULL;
  unsigned flags = (opts.once ? SCR_ET_ONCE : 0) | (opts.capture ? SCR_ET_CAPTURE : 0) |
                   (opts.passive ? SCR_ET_PASSIVE : 0);
  bool duplicate;
  ScrEtListener *l = scr_et_append(core, type, args[1], flags, &duplicate);
  if (l) scr_et_new_listener(core, l->root);
  scr_str_release(type);
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_et_remove_listener(ScrEventTargetCore *core, ScrDyn *const *args, size_t argc) {
  if (argc < 2) {
    scr_et_type_error("The \"type\" and \"listener\" arguments must be specified", "ERR_MISSING_ARGS");
    return NULL;
  }
  int valid = scr_et_listener_check(args[1]);
  if (valid < 0) return NULL;
  if (valid == 0) return scr_dyn_retain(scr_dyn_undefined());
  if (scr_et_symbol_type_fail(args[0])) return NULL;
  ScrStr *type = scr_dyn_string_coerce_js(args[0]);
  if (!type) return NULL;
  /* `options?.capture === true`: a boolean options value reads no
   * capture property. */
  bool capture = false;
  if (argc > 2 && scr_dyn_is_object(args[2])) {
    ScrDyn *v = scr_et_prop(args[2], "capture");
    if (!v && scr_exc_pending()) {
      scr_str_release(type);
      return NULL;
    }
    capture = v && v->kind == SCR_DYN_BOOL && v->v.b;
    scr_dyn_release(v);
  }
  scr_et_remove_matching(core, type, args[1], capture);
  scr_str_release(type);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* ── listener errors ───────────────────────────────────────────────── */

static void *scr_et_caught_retain_v(void *p) { return scr_caught_retain((ScrCaught *)p); }
static void scr_et_caught_release_v(void *p) { scr_caught_release((ScrCaught *)p); }

static void scr_et_rethrow_tick(ScrClosure *cb) {
  ScrCaught *caught = scr_box_get_ref(cb->caps[0]);
  scr_rethrow(caught);
  scr_caught_release(caught);
}

/* emitUncaughtException: process.nextTick(() => { throw err; }). */
static void scr_et_report(ScrCaught *caught /* moves */) {
  ScrClosure *cb = scr_closure_new((void *)&scr_et_rethrow_tick, 1);
  cb->caps[0] = scr_box_new_obj(&scr_et_caught_retain_v, &scr_et_caught_release_v, NULL);
  scr_box_set_ref(cb->caps[0], caught);
  scr_next_tick(cb);
}

static ScrDyn *scr_et_report_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  scr_dyn_throw(scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()));
  scr_et_report(scr_exc_take());
  return scr_dyn_retain(scr_dyn_undefined());
}

/* addCatch(result): `then(undefined, report)`. A native promise reports
 * from a continuation one turn after it rejects (the reaction's turn);
 * `awaited` adds the handleEvent wrapper's own await, one turn more. */
typedef struct {
  ScrPromise *promise;
  bool awaited;
} ScrEtCatch;

static void scr_et_report_job(ScrClosure *job) {
  ScrCaught *caught = scr_box_get_ref(job->caps[0]);
  scr_et_report(caught);
}

/* A reaction job one microtask from now that reports `caught`. */
static void scr_et_report_later(ScrCaught *caught /* moves */) {
  ScrClosure *job = scr_closure_new((void *)&scr_et_report_job, 1);
  job->caps[0] = scr_box_new_obj(&scr_et_caught_retain_v, &scr_et_caught_release_v, NULL);
  scr_box_set_ref(job->caps[0], caught);
  scr_queue_microtask(job);
}

static void scr_et_catch_entry(ScrFiber *self, void *argpack) {
  (void)self;
  ScrEtCatch *c = argpack;
  if (!scr_promise_await_settled(c->promise)) {
    ScrCaught *caught = scr_exc_take();
    if (c->awaited) scr_et_report_later(caught);
    else scr_et_report(caught);
  }
  scr_promise_release(c->promise);
  free(c);
}

static void scr_et_catch_promise(ScrPromise *p, bool awaited) {
  scr_promise_mark_handled(p);
  ScrEtCatch *c = scr_et_calloc(sizeof *c);
  c->promise = scr_promise_retain(p);
  c->awaited = awaited;
  ScrPromise *done = scr_async_spawn_after(p, scr_et_catch_entry, c);
  scr_promise_release(done);
}

static void scr_et_add_catch(ScrDyn *result) {
  if (result->kind == SCR_DYN_PROMISE) {
    scr_et_catch_promise(result->v.promise, false);
    return;
  }
  if (!scr_dyn_is_object(result) && result->kind != SCR_DYN_FUNC) return;
  ScrDyn *then = scr_dyn_obj_read(result, "then", 4);
  if (then && scr_dyn_is_callable(then)) {
    ScrDyn *report = scr_dyn_new_func(scr_closure_new((void *)&scr_et_report_call, 0),
                                      scr_et_report_call, 1, "(err)", "");
    ScrDyn *call_args[2] = {scr_dyn_undefined(), report};
    scr_dyn_this_push_dyn(result);
    ScrDyn *r = scr_dyn_call(then, call_args, 2, "then");
    scr_dyn_this_pop();
    scr_dyn_release(r);
    scr_dyn_release(report);
  }
  scr_dyn_release(then);
  if (scr_exc_pending()) scr_et_report(scr_exc_take());
}

/* The handleEvent wrapper is an async function: a synchronous throw
 * rejects its promise at once, so addCatch's reaction is the next job. */
static void scr_et_reject_through_catch(ScrCaught *caught /* moves */) {
  scr_et_report_later(caught);
}

/* Calls one listener with `this` = the target (functions) or the listener
 * object (handleEvent). */
static SCR_TL ScrDyn *scr_et_handle_event_reader;

void scr_event_handle_event_reader(ScrDyn *reader) {
  ScrDyn *old = scr_et_handle_event_reader;
  scr_et_handle_event_reader = scr_dyn_retain(reader);
  scr_dyn_release(old);
  scr_et_register_teardown();
}

static void scr_et_invoke(ScrEtListener *l, ScrDyn *self, ScrDyn *event) {
  if (l->native) {
    l->native(l->ctx, self, event);
    return;
  }
  ScrDyn *listener = l->listener;
  ScrDyn *args[1] = {event};
  if (listener->kind == SCR_DYN_FUNC ||
      (listener->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_typeof_is(listener, "function"))) {
    scr_dyn_this_push_dyn(self);
    ScrDyn *result = scr_dyn_call(listener, args, 1, "listener");
    scr_dyn_this_pop();
    if (!result) {
      scr_et_report(scr_exc_take());
      return;
    }
    if (result->kind != SCR_DYN_UNDEF && result->kind != SCR_DYN_NULL) scr_et_add_catch(result);
    scr_dyn_release(result);
    return;
  }
  /* `if (listener.handleEvent) await ReflectApply(listener.handleEvent,
   * listener, args)`. A typed record listener re-reads its live source,
   * so handleEvent replacements on the original are seen here. */
  ScrDyn *current = listener->kind == SCR_DYN_OBJ && listener->v.obj.source_identity &&
                            listener->v.obj.source_access
                        ? listener->v.obj.source_access(listener->v.obj.source_identity, true)
                        : scr_dyn_retain(listener);
  ScrDyn *handle = NULL;
  if (current->kind == SCR_DYN_OBJ || current->kind == SCR_DYN_PROXY ||
      current->kind == SCR_DYN_TYPED_REF) {
    if (current->kind == SCR_DYN_TYPED_REF && scr_et_handle_event_reader) {
      /* A class instance's handleEvent is a compiled method. */
      ScrDyn *reader_args[1] = {current};
      handle = scr_dyn_call(scr_et_handle_event_reader, reader_args, 1, "handleEvent");
    } else if (current->kind == SCR_DYN_TYPED_REF) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(current);
      handle = view ? scr_dyn_obj_read(view, "handleEvent", 11) : NULL;
      scr_dyn_release(view);
    } else if (current->kind == SCR_DYN_PROXY) {
      ScrStr *key = scr_str_new("handleEvent", 11);
      handle = scr_dyn_proxy_get(current, key);
      scr_str_release(key);
    } else {
      handle = scr_dyn_obj_read(current, "handleEvent", 11);
    }
  }
  if (!handle && scr_exc_pending()) {
    scr_dyn_release(current);
    scr_et_reject_through_catch(scr_exc_take());
    return;
  }
  if (handle && scr_dyn_truthy(handle)) {
    if (!scr_dyn_is_callable(handle)) {
      /* Reflect.apply's TypeError, V8's wording. */
      bool primitive =
          handle->kind == SCR_DYN_NUM || handle->kind == SCR_DYN_STR || handle->kind == SCR_DYN_BOOL;
      ScrStr *text = primitive ? scr_dyn_string_coerce_js(handle) : scr_str_new("#<Object>", 9);
      const char *kind = handle->kind == SCR_DYN_NUM    ? "a number"
                         : handle->kind == SCR_DYN_STR  ? "a string"
                         : handle->kind == SCR_DYN_BOOL ? "a boolean"
                                                        : "an object";
      char message[320];
      snprintf(message, sizeof message,
               "Function.prototype.apply was called on %.*s, which is %s and not a function",
               text ? (int)text->len : 0, text ? text->data : "", kind);
      scr_str_release(text);
      scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
      scr_et_reject_through_catch(scr_exc_take());
    } else {
      ScrDyn *receiver = listener->kind == SCR_DYN_TYPED_REF ? listener : current;
      scr_dyn_this_push_dyn(receiver);
      ScrDyn *result = scr_dyn_call(handle, args, 1, "handleEvent");
      scr_dyn_this_pop();
      if (!result) {
        scr_et_reject_through_catch(scr_exc_take());
      } else {
        /* the wrapper awaits a returned promise and settles after it */
        if (result->kind == SCR_DYN_PROMISE) scr_et_catch_promise(result->v.promise, true);
        scr_dyn_release(result);
      }
    }
  }
  scr_dyn_release(handle);
  scr_dyn_release(current);
}

/* ── dispatch (kHybridDispatch) ────────────────────────────────────── */

static ScrEventObj *scr_event_obj_of(const ScrDyn *d);

static ScrEvent *scr_event_of(const ScrDyn *d) {
  if (d && d->kind == SCR_DYN_HANDLE &&
      (d->v.handle.tag == SCR_DYNH_EVENT || d->v.handle.tag == SCR_DYNH_CUSTOM_EVENT ||
       d->v.handle.tag == SCR_DYNH_MESSAGE_EVENT)) {
    return (ScrEvent *)d->v.handle.ptr;
  }
  ScrEventObj *obj = scr_event_obj_of(d);
  return obj ? obj->ev : NULL;
}

static void scr_event_set_target(ScrEvent *ev, ScrDyn *target) {
  ScrDyn *old = ev->target;
  ev->target = scr_dyn_retain(target);
  scr_event_track(ev);
  scr_dyn_release(old);
}

void scr_et_dispatch(ScrEventTargetCore *core, ScrDyn *self, ScrDyn *event) {
  ScrEvent *ev = scr_event_of(event);
  scr_dyn_retain(event);
  scr_event_set_target(ev, self);
  ev->dispatching = true;
  ScrStr *type = scr_str_retain(ev->type);
  ScrEtRoot *root = scr_et_root_find(core, type);
  scr_str_release(type);
  if (!root || !root->head) {
    ev->dispatching = false;
    scr_dyn_release(event);
    return;
  }
  scr_et_root_retain(root);
  ScrEtListener *handler = scr_et_listener_retain(root->head);
  while (handler && (root->resist || (handler->flags & SCR_ET_PASSIVE) || !ev->stop)) {
    /* Cache the next item in case this iteration removes the current one. */
    ScrEtListener *next = scr_et_listener_retain(handler->next);
    if ((handler->flags & SCR_ET_REMOVED) || (ev->stop && !(handler->flags & SCR_ET_RESIST))) {
      scr_et_listener_release(handler);
      handler = next;
      continue;
    }
    if (handler->flags & SCR_ET_ONCE) {
      scr_et_listener_remove(handler);
      root->size--;
    }
    bool passive = (handler->flags & SCR_ET_PASSIVE) != 0;
    if (passive) ev->in_passive = true;
    scr_et_invoke(handler, self, event);
    ev->dispatching = false;
    if (ev->in_passive) ev->in_passive = false;
    scr_et_listener_release(handler);
    handler = next;
  }
  scr_et_listener_release(handler);
  ev->dispatching = false;
  scr_et_root_release(root);
  scr_dyn_release(event);
}

ScrDyn *scr_et_dispatch_event(ScrEventTargetCore *core, ScrDyn *self, ScrDyn *const *args,
                              size_t argc) {
  if (argc < 1) {
    scr_et_type_error("The \"event\" argument must be specified", "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrEvent *ev = scr_event_of(args[0]);
  if (!ev) {
    scr_dyn_arg_type_fail("event", "an instance of Event", args[0]);
    return NULL;
  }
  if (ev->dispatching) {
    char message[256];
    snprintf(message, sizeof message, "The event \"%.*s\" is already being dispatched",
             (int)ev->type->len, ev->type->data);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "ERR_EVENT_RECURSION");
    return NULL;
  }
  scr_et_dispatch(core, self, args[0]);
  return scr_dyn_new_bool(!(ev->cancelable && ev->default_prevented));
}

/* ── event-handler attributes (defineEventHandler) ─────────────────── */

static void scr_et_handler_release(void *ctx) {
  ScrEtHandler *h = ctx;
  if (--h->rc > 0) return;
  scr_str_release(h->type);
  scr_dyn_release(h->handler);
  free(h);
}

/* The wrapper: `if (typeof handler !== 'function') return; return
 * ReflectApply(handler, this, args)`. */
static void scr_et_handler_fire(void *ctx, ScrDyn *self, ScrDyn *event) {
  ScrEtHandler *h = ctx;
  if (!h->handler || !scr_dyn_is_callable(h->handler)) return;
  ScrDyn *handler = scr_dyn_retain(h->handler);
  ScrDyn *args[1] = {event};
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(handler, args, 1, "handler");
  scr_dyn_this_pop();
  scr_dyn_release(handler);
  if (!result) {
    scr_et_report(scr_exc_take());
    return;
  }
  if (result->kind != SCR_DYN_UNDEF && result->kind != SCR_DYN_NULL) scr_et_add_catch(result);
  scr_dyn_release(result);
}

static ScrEtHandler *scr_et_handler_find(ScrEventTargetCore *core, const char *type) {
  for (ScrEtHandler *h = core->handlers; h; h = h->next) {
    if (scr_et_eq(h->type, type)) return h;
  }
  return NULL;
}

ScrDyn *scr_et_handler_get(ScrEventTargetCore *core, const char *type) {
  ScrEtHandler *h = scr_et_handler_find(core, type);
  return h && h->handler ? scr_dyn_retain(h->handler) : scr_dyn_new_null();
}

void scr_et_handler_set(ScrEventTargetCore *core, const char *type, const ScrDyn *value) {
  ScrDyn *next =
      value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_retain((ScrDyn *)value);
  ScrEtHandler *h = scr_et_handler_find(core, type);
  if (h) {
    /* Replacing keeps the wrapper's registration position; the listener
     * count follows whether the handler is a function. */
    ScrEtRoot *root = scr_et_root_find(core, h->type);
    bool was = h->handler && scr_dyn_is_callable(h->handler);
    bool now = next && scr_dyn_is_callable(next);
    ScrDyn *old = h->handler;
    h->handler = next;
    scr_dyn_release(old);
    if (root) {
      if (was) root->size--;
      if (now) {
        root->size++;
        scr_et_new_listener(core, root);
      }
    }
    return;
  }
  h = scr_et_calloc(sizeof *h);
  h->rc = 1; /* the core's map */
  h->type = scr_str_new(type, strlen(type));
  h->handler = next;
  h->next = core->handlers;
  core->handlers = h;
  bool duplicate;
  ScrEtListener *l = scr_et_append(core, h->type, NULL, 0, &duplicate);
  h->rc++;
  l->native = scr_et_handler_fire;
  l->native_kind = SCR_ET_VALUE_HANDLER;
  l->ctx = h;
  l->ctx_release = scr_et_handler_release;
  scr_et_new_listener(core, l->root);
}

/* ── Event handles ─────────────────────────────────────────────────── */

static ScrEvent *scr_event_alloc(ScrStr *type /* moves */, bool custom) {
  ScrEvent *ev = scr_et_calloc(sizeof *ev);
  ev->rc = 1;
  ev->type = type;
  ev->custom = custom;
  ev->time_stamp = scr_perf_now();
  return ev;
}

static void *scr_event_retain_v(void *p) {
  ((ScrEvent *)p)->rc++;
  return p;
}

static void scr_event_drop_refs(ScrEvent *ev) {
  scr_event_untrack(ev);
  ScrDyn *target = ev->target;
  ScrDyn *detail = ev->detail;
  ev->target = NULL;
  ev->detail = NULL;
  scr_dyn_release(target);
  scr_dyn_release(detail);
}

static void scr_event_release_v(void *p) {
  ScrEvent *ev = p;
  if (--ev->rc > 0) return;
  scr_event_drop_refs(ev);
  scr_str_release(ev->type);
  free(ev);
}

static bool scr_et_key(const char *key, size_t len, const char *want) {
  return strlen(want) == len && memcmp(key, want, len) == 0;
}

/* ── method values ──────────────────────────────────────────────────
 * A member read as a value (`event.preventDefault`, `target[name]`) is
 * the prototype's function: it runs the member on its `this`, and any
 * other receiver throws Node's ERR_INVALID_THIS. One function per member,
 * so repeated reads compare equal. */
static const char *const scr_et_method_names[] = {
    "addEventListener", "removeEventListener",      "dispatchEvent", "preventDefault",
    "stopPropagation",  "stopImmediatePropagation", "composedPath",  "initEvent",
};
static const uint32_t scr_et_method_lengths[] = {2, 2, 1, 0, 0, 0, 0, 1};
enum { SCR_ET_TARGET_METHODS = 3, SCR_ET_METHODS = 8 };
static SCR_TL ScrDyn *scr_et_method_values[SCR_ET_METHODS];

static ScrEventTargetObj *scr_event_target_obj_of(const ScrDyn *d);

typedef struct ScrEventTarget {
  size_t rc;
  ScrEventTargetCore core;
} ScrEventTarget;

static bool scr_et_target_method(ScrEventTargetCore *core, ScrDyn *self, const char *method,
                                 ScrDyn *const *args, size_t argc, ScrDyn **out);
static ScrDyn *scr_event_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                                size_t argc, const char *what);

/* The listener core of an EventTarget value: a plain target, a
 * BroadcastChannel, an AbortSignal, or a subclass instance; NULL for
 * anything else. */
static ScrEventTargetCore *scr_et_core_of(const ScrDyn *d) {
  ScrEventTargetObj *obj = scr_event_target_obj_of(d);
  if (obj) return obj->core;
  if (d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_EVENT_TARGET)
    return &((ScrEventTarget *)d->v.handle.ptr)->core;
  if (scr_et_broadcast_core_fn) {
    ScrEventTargetCore *broadcast = scr_et_broadcast_core_fn(d);
    if (broadcast) return broadcast;
  }
  bool aborted;
  return scr_et_signal_core_fn ? scr_et_signal_core_fn(d, &aborted) : NULL;
}

static ScrDyn *scr_et_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  size_t index = (size_t)scr_box_get_f64(clo->caps[0]);
  const char *method = scr_et_method_names[index];
  ScrDyn *self = scr_dyn_this_get();
  bool target = index < SCR_ET_TARGET_METHODS;
  ScrEventTargetCore *core = target ? scr_et_core_of(self) : NULL;
  ScrEvent *ev = target ? NULL : scr_event_of(self);
  if (!core && !ev) {
    scr_dyn_release(self);
    char message[64];
    snprintf(message, sizeof message, "Value of \"this\" must be of type %s",
             target ? "EventTarget" : "Event");
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), "ERR_INVALID_THIS");
    return NULL;
  }
  ScrDyn *out = NULL;
  if (core) scr_et_target_method(core, self, method, args, argc, &out);
  else out = scr_event_invoke(ev, self, method, args, argc, method);
  scr_dyn_release(self);
  return out;
}

/* The function of member `key` (+1), or NULL when `key` names none. */
static ScrDyn *scr_et_method_value(const char *key, size_t len, bool target) {
  size_t from = target ? 0 : SCR_ET_TARGET_METHODS;
  size_t to = target ? SCR_ET_TARGET_METHODS : SCR_ET_METHODS;
  for (size_t i = from; i < to; i++) {
    const char *name = scr_et_method_names[i];
    if (strlen(name) != len || memcmp(name, key, len) != 0) continue;
    if (!scr_et_method_values[i]) {
      /* An AbortSignal answers these without the unit ever installing:
       * exit releases the cached function either way. */
      scr_et_register_teardown();
      ScrClosure *clo = scr_closure_new(NULL, 1);
      clo->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(clo->caps[0], (double)i);
      scr_et_method_values[i] =
          scr_dyn_new_func(clo, scr_et_method_call, scr_et_method_lengths[i], "", name);
    }
    return scr_dyn_retain(scr_et_method_values[i]);
  }
  return NULL;
}

ScrDyn *scr_event_target_method_value(const char *key, size_t len) {
  return scr_et_method_value(key, len, true);
}

static ScrDyn *scr_event_target_value(const ScrEvent *ev) {
  return ev->target ? scr_dyn_retain(ev->target) : scr_dyn_new_null();
}

static ScrDyn *scr_event_get(void *ptr, const char *key, size_t len) {
  ScrEvent *ev = ptr;
  if (scr_et_key(key, len, "type")) return scr_dyn_new_str(ev->type);
  if (scr_et_key(key, len, "target") || scr_et_key(key, len, "srcElement"))
    return scr_event_target_value(ev);
  if (scr_et_key(key, len, "currentTarget"))
    return ev->dispatching ? scr_event_target_value(ev) : scr_dyn_new_null();
  if (scr_et_key(key, len, "cancelable")) return scr_dyn_new_bool(ev->cancelable);
  if (scr_et_key(key, len, "defaultPrevented"))
    return scr_dyn_new_bool(ev->cancelable && ev->default_prevented);
  if (scr_et_key(key, len, "timeStamp")) return scr_dyn_new_num(ev->time_stamp);
  if (scr_et_key(key, len, "returnValue"))
    return scr_dyn_new_bool(!ev->cancelable || !ev->default_prevented);
  if (scr_et_key(key, len, "bubbles")) return scr_dyn_new_bool(ev->bubbles);
  if (scr_et_key(key, len, "composed")) return scr_dyn_new_bool(ev->composed);
  if (scr_et_key(key, len, "eventPhase")) return scr_dyn_new_num(ev->dispatching ? 2 : 0);
  if (scr_et_key(key, len, "cancelBubble")) return scr_dyn_new_bool(ev->propagation_stopped);
  if (scr_et_key(key, len, "isTrusted")) return scr_dyn_new_bool(ev->trusted);
  if (ev->custom && scr_et_key(key, len, "detail"))
    return ev->detail ? scr_dyn_retain(ev->detail) : scr_dyn_new_null();
  if (ev->message) {
    if (scr_et_key(key, len, "data")) return ev->detail ? scr_dyn_retain(ev->detail) : scr_dyn_new_null();
    if (scr_et_key(key, len, "origin") || scr_et_key(key, len, "lastEventId")) {
      ScrStr *empty = scr_str_new("", 0);
      ScrDyn *value = scr_dyn_new_str(empty);
      scr_str_release(empty);
      return value;
    }
    if (scr_et_key(key, len, "source")) return scr_dyn_new_null();
    if (scr_et_key(key, len, "ports")) return scr_dyn_new_arr();
  }
  return scr_et_method_value(key, len, false);
}

static bool scr_event_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  ScrEvent *ev = ptr;
  if (scr_et_key(key, len, "returnValue")) {
    if (!scr_dyn_truthy(value) && ev->cancelable && !ev->in_passive) ev->default_prevented = true;
    return true;
  }
  if (scr_et_key(key, len, "cancelBubble")) {
    if (scr_dyn_truthy(value)) ev->propagation_stopped = true;
    return true;
  }
  return false;
}

static void scr_et_not_function(const char *what) {
  char message[256];
  snprintf(message, sizeof message, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

static bool scr_event_method_is(const char *method) {
  static const char *const names[] = {"preventDefault", "stopPropagation",
                                      "stopImmediatePropagation", "composedPath", "initEvent"};
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    if (strcmp(method, names[i]) == 0) return true;
  }
  return false;
}

static ScrDyn *scr_event_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                                size_t argc, const char *what) {
  ScrEvent *ev = ptr;
  (void)self;
  if (strcmp(method, "preventDefault") == 0) {
    if (ev->cancelable && !ev->in_passive) ev->default_prevented = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "stopPropagation") == 0) {
    ev->propagation_stopped = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "stopImmediatePropagation") == 0) {
    ev->propagation_stopped = true;
    ev->stop = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "composedPath") == 0) {
    ScrDyn *path = scr_dyn_new_arr();
    if (ev->dispatching) scr_dyn_arr_push(path, scr_event_target_value(ev));
    return path;
  }
  if (strcmp(method, "initEvent") == 0) {
    if (argc == 0) {
      scr_et_type_error("The \"type\" argument must be specified", "ERR_MISSING_ARGS");
      return NULL;
    }
    if (ev->dispatching) return scr_dyn_retain(scr_dyn_undefined());
    ScrStr *type = scr_dyn_string_coerce_js(args[0]);
    if (!type) return NULL;
    scr_str_release(ev->type);
    ev->type = type;
    ev->bubbles = argc > 1 && scr_dyn_truthy(args[1]);
    ev->cancelable = argc > 2 && scr_dyn_truthy(args[2]);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  scr_et_not_function(what);
  return NULL;
}

/* Node's [kInspect]: `Event { type, defaultPrevented, cancelable,
 * timeStamp }`. */
static ScrDyn *scr_event_inspect_view(void *ptr) {
  ScrEvent *ev = ptr;
  ScrDyn *view = scr_dyn_new_obj();
  scr_dyn_obj_set(view, "type", 4, scr_dyn_new_str(ev->type));
  scr_dyn_obj_set(view, "defaultPrevented", 16, scr_dyn_new_bool(ev->default_prevented));
  scr_dyn_obj_set(view, "cancelable", 10, scr_dyn_new_bool(ev->cancelable));
  scr_dyn_obj_set(view, "timeStamp", 9, scr_dyn_new_num(ev->time_stamp));
  return view;
}

/* An Event's members are prototype getters, so an event has no own
 * enumerable property and JSON.stringify answers `{}`; class members and
 * the CustomEvent detail stay behind their getters. */
static const ScrDynHandleOps scr_event_ops = {
    .cls = "Event",
    .retain = scr_event_retain_v,
    .release = scr_event_release_v,
    .invoke = scr_event_invoke,
    .get = scr_event_get,
    .set = scr_event_set,
    .inspect_view = scr_event_inspect_view,
    .json_empty_object = true,
};

static const ScrDynHandleOps scr_message_event_ops = {
    .cls = "MessageEvent",
    .retain = scr_event_retain_v,
    .release = scr_event_release_v,
    .invoke = scr_event_invoke,
    .get = scr_event_get,
    .set = scr_event_set,
    .inspect_view = scr_event_inspect_view,
    .json_empty_object = true,
};

static const ScrDynHandleOps scr_custom_event_ops = {
    .cls = "CustomEvent",
    .retain = scr_event_retain_v,
    .release = scr_event_release_v,
    .invoke = scr_event_invoke,
    .get = scr_event_get,
    .set = scr_event_set,
    .inspect_view = scr_event_inspect_view,
    .json_empty_object = true,
};

/* ── EventTarget handles ───────────────────────────────────────────── */

static void *scr_event_target_retain_v(void *p) {
  ((ScrEventTarget *)p)->rc++;
  return p;
}

static void scr_event_target_release_v(void *p) {
  ScrEventTarget *t = p;
  if (--t->rc > 0) return;
  scr_et_core_drop(&t->core);
  free(t);
}

/* The EventTarget methods over a core; false when `method` is not one. */
static bool scr_et_target_method(ScrEventTargetCore *core, ScrDyn *self, const char *method,
                                 ScrDyn *const *args, size_t argc, ScrDyn **out) {
  if (strcmp(method, "addEventListener") == 0) {
    *out = scr_et_add_listener(core, args, argc);
  } else if (strcmp(method, "removeEventListener") == 0) {
    *out = scr_et_remove_listener(core, args, argc);
  } else if (strcmp(method, "dispatchEvent") == 0) {
    *out = scr_et_dispatch_event(core, self, args, argc);
  } else {
    return false;
  }
  return true;
}

static ScrDyn *scr_event_target_invoke(void *ptr, ScrDyn *self, const char *method,
                                       ScrDyn *const *args, size_t argc, const char *what) {
  ScrEventTarget *t = ptr;
  ScrDyn *out;
  if (scr_et_target_method(&t->core, self, method, args, argc, &out)) return out;
  scr_et_not_function(what);
  return NULL;
}

static ScrDyn *scr_event_target_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  return scr_et_method_value(key, len, true);
}

static bool scr_event_target_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static ScrDyn *scr_event_target_inspect_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

static const ScrDynHandleOps scr_event_target_ops = {
    .cls = "EventTarget",
    .retain = scr_event_target_retain_v,
    .release = scr_event_target_release_v,
    .invoke = scr_event_target_invoke,
    .get = scr_event_target_get,
    .set = scr_event_target_set,
    .inspect_view = scr_event_target_inspect_view,
};

/* ── function values of native listeners ─────────────────────────────
 * Node registers a function for an options.signal removal hook and for an
 * on<type> attribute, so getEventListeners reports one for each. These
 * build those functions on the first request: the node keeps the value, so
 * repeated reads answer the same function, and dispatch still runs the
 * native side. */

static void *scr_et_hook_retain_v(void *p) {
  ScrEtHook *h = p;
  h->rc++;
  return h;
}

static void *scr_et_handler_retain_v(void *p) {
  ScrEtHandler *h = p;
  h->rc++;
  return h;
}

/* `() => this.removeEventListener(type, listener, options)`. */
static ScrDyn *scr_et_hook_value_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEtHook *h = scr_box_get_ref(clo->caps[0]);
  if (!h) return scr_dyn_retain(scr_dyn_undefined());
  if (h->target) {
    ScrStr *type = scr_dyn_string_coerce_js(h->type);
    if (type) {
      scr_et_remove_matching(h->target, type, h->listener, h->capture);
      scr_str_release(type);
    }
  }
  scr_et_hook_release(h);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* `function eventHandler(...args) { if (typeof eventHandler.handler !==
 * 'function') return; return handler.call(this, ...args); }`. */
static ScrDyn *scr_et_handler_value_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrEtHandler *h = scr_box_get_ref(clo->caps[0]);
  if (!h) return scr_dyn_retain(scr_dyn_undefined());
  if (!h->handler || !scr_dyn_is_callable(h->handler)) {
    scr_et_handler_release(h);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  ScrDyn *handler = scr_dyn_retain(h->handler);
  scr_et_handler_release(h);
  ScrDyn *self = scr_dyn_this_get();
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(handler, args, argc, "handler");
  scr_dyn_this_pop();
  scr_dyn_release(self);
  scr_dyn_release(handler);
  return result;
}

/* The function value of a native listener node, +1. */
static ScrDyn *scr_et_native_value(ScrEtListener *l) {
  ScrClosure *clo = scr_closure_new(NULL, 1);
  if (l->native_kind == SCR_ET_VALUE_HOOK) {
    clo->caps[0] = scr_box_new_obj(scr_et_hook_retain_v, scr_et_hook_release,
                                   NULL);
    /* The box owns a reference of its own: set_ref takes the value over
     * without retaining, and the node keeps the creation one. */
    scr_box_set_ref(clo->caps[0], scr_et_hook_retain_v(l->ctx));
    l->listener = scr_dyn_new_func(clo, scr_et_hook_value_call, 0, "", NULL);
  } else {
    clo->caps[0] = scr_box_new_obj(scr_et_handler_retain_v, scr_et_handler_release, NULL);
    scr_box_set_ref(clo->caps[0], scr_et_handler_retain_v(l->ctx));
    l->listener = scr_dyn_new_func(clo, scr_et_handler_value_call, 0, "", "eventHandler");
  }
  return scr_dyn_retain(l->listener);
}

/* ── the node:events helpers over EventTarget receivers ───────────────
 * Node's getEventListeners, listenerCount, getMaxListeners and
 * setMaxListeners take an EventTarget as well as an EventEmitter. An
 * EventEmitter argument whose class the compiler knows is answered by the
 * emitter paths; these read a checked-dynamic receiver as a target, and
 * throw Node's ERR_INVALID_ARG_TYPE for any other value, an EventEmitter
 * among them. No name is coerced: a type that is not a string matches no
 * type root, so the helpers answer empty, as Node's do. */

/* The EventTarget behind a helper's receiver, or NULL with the exception
 * pending: Node's property read of `prop` for null and undefined (a plain
 * TypeError; `plain_read` false for the helpers that read the property
 * through optional chaining, which send those values to the type check),
 * and its ERR_INVALID_ARG_TYPE for any other value that is neither an
 * EventEmitter nor an EventTarget (`argname` is "emitter" or
 * "eventTargets"). */
/* The worker unit installs the NodeEventTarget accessor (NULL without it):
 * a Worker or MessagePort carries its listeners in an emitter registry
 * rather than an EventTarget core. The pointer itself lives in the emitter
 * unit (scr_events_emitter.c), which links whenever a NodeEventTarget can. */

static ScrEmitter *scr_et_helper_emitter(const ScrDyn *self) {
  return scr_node_event_target_ops ? scr_node_event_target_ops->emitter_of(self) : NULL;
}

static ScrEventTargetCore *scr_et_helper_target_of(const ScrDyn *self, const char *argname,
                                                   const char *prop, bool plain_read) {
  if (plain_read && (self->kind == SCR_DYN_NULL || self->kind == SCR_DYN_UNDEF)) {
    char message[96];
    snprintf(message, sizeof message, "Cannot read properties of %s (reading '%s')",
             self->kind == SCR_DYN_NULL ? "null" : "undefined", prop);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return NULL;
  }
  ScrEventTargetCore *core = scr_et_core_of(self);
  if (!core) {
    /* A NodeEventTarget answers through its emitter; the caller falls back
     * to it. Any other value is Node's ERR_INVALID_ARG_TYPE. */
    if (scr_et_helper_emitter(self) != NULL) return NULL;
    scr_dyn_arg_type_fail(argname, "an instance of EventEmitter or EventTarget", self);
    return NULL;
  }
  return core;
}

static ScrEventTargetCore *scr_et_helper_target(const ScrDyn *self, const char *argname,
                                                const char *prop) {
  return scr_et_helper_target_of(self, argname, prop, true);
}

ScrDyn *scr_event_target_listeners(const ScrDyn *self, const ScrStr *type) {
  ScrEventTargetCore *core = scr_et_helper_target(self, "emitter", "listeners");
  if (!core) {
    ScrEmitter *em = scr_et_helper_emitter(self);
    return em ? scr_emitter_listeners_dyn(em, (ScrStr *)type) : scr_dyn_new_arr();
  }
  /* The caller converts the array through a checked cast, which needs a
   * value even when the exception is pending. */
  ScrDyn *out = scr_dyn_new_arr();
  const ScrEtRoot *root = scr_et_root_find(core, type);
  for (ScrEtListener *h = root ? root->head : NULL; h; h = h->next) {
    if (h->listener) scr_dyn_arr_push(out, scr_dyn_retain(h->listener));
    else if (h->native_kind != SCR_ET_VALUE_NONE) scr_dyn_arr_push(out, scr_et_native_value(h));
  }
  return out;
}

ScrDyn *scr_event_target_listeners_dyn(const ScrDyn *self, const ScrDyn *type) {
  ScrEventTargetCore *core = scr_et_helper_target(self, "emitter", "listeners");
  if (!core) {
    ScrEmitter *em = scr_et_helper_emitter(self);
    if (!em || type->kind != SCR_DYN_STR) return scr_dyn_new_arr();
    return scr_emitter_listeners_dyn(em, type->v.str);
  }
  if (type->kind != SCR_DYN_STR) return scr_dyn_new_arr();
  return scr_event_target_listeners(self, type->v.str);
}

double scr_event_target_listener_count(const ScrDyn *self, const ScrStr *type) {
  ScrEventTargetCore *core = scr_et_helper_target(self, "emitter", "listenerCount");
  if (!core) {
    ScrEmitter *em = scr_et_helper_emitter(self);
    return em ? scr_emitter_listener_count(em, (ScrStr *)type) : 0;
  }
  const ScrEtRoot *root = scr_et_root_find(core, type);
  return root ? (double)root->size : 0;
}

/* Node reads the type's root straight off the target's map, so a type that
 * is not a string finds none. */
double scr_event_target_listener_count_dyn(const ScrDyn *self, const ScrDyn *type) {
  ScrEventTargetCore *core = scr_et_helper_target(self, "emitter", "listenerCount");
  if (!core) {
    ScrEmitter *em = scr_et_helper_emitter(self);
    if (!em || type->kind != SCR_DYN_STR) return 0;
    return scr_emitter_listener_count(em, type->v.str);
  }
  if (type->kind != SCR_DYN_STR) return 0;
  return scr_event_target_listener_count(self, type->v.str);
}

/* events.getMaxListeners(emitterOrTarget) — the module's static helper.
 * Node reads `_maxListeners` off a value that has getMaxListeners: a Worker
 * is an EventEmitter, so its configured limit comes back. A NodeEventTarget
 * (MessagePort) keeps its limit in kMaxEventTargetListeners instead, so the
 * static form answers the process default even though its instance method
 * reports the target's own; the worker unit's kind query makes that split.
 * Plain EventTargets have no getMaxListeners and are read through
 * kMaxEventTargetListeners, which our cores hold as max_listeners. */
double scr_event_target_get_max(const ScrDyn *self) {
  ScrEventTargetCore *core =
      scr_et_helper_target_of(self, "emitter", "getMaxListeners", false);
  if (core) return core->max_listeners;
  double out;
  if (scr_node_event_target_ops && scr_node_event_target_ops->emitter_max &&
      scr_node_event_target_ops->emitter_max(self, &out))
    return out;
  return scr_emitter_default_max;
}

/* Node's validateNumber(n, 'setMaxListeners', 0): a negative or NaN limit
 * throws ERR_OUT_OF_RANGE (the ladder scr_emitter_set_max applies). It runs
 * before the receiver is looked at, as Node's does. */
static bool scr_et_max_ok(double n) {
  if (n >= 0) return true;
  char num[32];
  size_t nlen = scr_f64_to_str(n, num);
  char msg[128];
  int len = snprintf(msg, sizeof msg,
                     "The value of \"setMaxListeners\" is out of range. It must be >= 0. Received %.*s",
                     (int)nlen, num);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

void scr_event_target_set_max(const ScrDyn *self, double n) {
  if (!scr_et_max_ok(n)) return;
  ScrEventTargetCore *core = scr_et_helper_target(self, "eventTargets", "setMaxListeners");
  if (!core) {
    ScrEmitter *em = scr_et_helper_emitter(self);
    if (em) scr_emitter_release(scr_emitter_set_max(em, n));
    return;
  }
  core->max_listeners = n;
  /* Node clears the leak-warning latch with the limit. */
  core->warned = false;
}

/* ── compiled subclasses (`class Bus extends EventTarget`) ─────────────
 * Instances are compiler-emitted hierarchy objects whose prefix points at
 * the engine state (scr_runtime.h). Their checked-dynamic capsules carry
 * the RC adapters below, so a capsule's release adapter identifies the
 * family: such a capsule is a target's `self`, the event a listener
 * receives, and what event.target answers. */

void *scr_event_target_obj_retain_v(void *o) {
  ScrEventTargetObj *t = o;
  if (t && t->rc != SIZE_MAX) t->rc++;
  return o;
}

void scr_event_target_obj_release_v(void *o) {
  ScrEventTargetObj *t = o;
  if (!t || t->rc == SIZE_MAX) return;
  t->vt->release(t); /* the dynamic class's teardown */
}

void *scr_event_obj_retain_v(void *o) {
  ScrEventObj *e = o;
  if (e && e->rc != SIZE_MAX) e->rc++;
  return o;
}

void scr_event_obj_release_v(void *o) {
  ScrEventObj *e = o;
  if (!e || e->rc == SIZE_MAX) return;
  e->vt->release(e);
}

void *scr_event_target_obj_retain(void *o) { return scr_event_target_obj_retain_v(o); }
void scr_event_target_obj_release(void *o) { scr_event_target_obj_release_v(o); }
void *scr_event_obj_retain(void *o) { return scr_event_obj_retain_v(o); }
void scr_event_obj_release(void *o) { scr_event_obj_release_v(o); }

static ScrEventTargetObj *scr_event_target_obj_of(const ScrDyn *d) {
  return d && d->kind == SCR_DYN_TYPED_REF &&
                 d->v.typed_ref.release == &scr_event_target_obj_release_v
             ? (ScrEventTargetObj *)d->v.typed_ref.ptr
             : NULL;
}

static ScrEventObj *scr_event_obj_of(const ScrDyn *d) {
  return d && d->kind == SCR_DYN_TYPED_REF && d->v.typed_ref.release == &scr_event_obj_release_v
             ? (ScrEventObj *)d->v.typed_ref.ptr
             : NULL;
}

static void scr_et_install(void);
static ScrEvent *scr_event_construct(ScrDyn *args, bool custom);

void scr_event_target_obj_init(void *obj) {
  scr_et_install();
  ScrEventTargetObj *t = obj;
  t->core = scr_et_calloc(sizeof *t->core);
  scr_et_core_init(t->core, 10, t->cls);
}

/* The instance's rc reached zero, so its cached capsule (which holds the
 * instance) is already gone. */
void scr_event_target_state_drop(ScrEventTargetCore *core) {
  if (!core) return;
  scr_et_core_drop(core);
  free(core);
}

void scr_event_target_state_trace(ScrEventTargetCore *core, ScrTraceVisit visit, void *ctx) {
  if (!core) return;
  if (core->self) visit(core->self, ctx);
  for (ScrEtRoot *root = core->roots; root; root = root->map_next) {
    for (ScrEtListener *l = root->head; l; l = l->next) {
      if (l->listener) visit(l->listener, ctx);
    }
  }
  for (ScrEtHandler *h = core->handlers; h; h = h->next) {
    if (h->handler) visit(h->handler, ctx);
  }
}

/* The collector's teardown: the traced values are the collector's to
 * account, so they leave the state unreleased; the rest drops as usual. */
void scr_event_target_state_gcfree(ScrEventTargetCore *core) {
  if (!core) return;
  core->self = NULL;
  for (ScrEtRoot *root = core->roots; root; root = root->map_next) {
    for (ScrEtListener *l = root->head; l; l = l->next) l->listener = NULL;
  }
  for (ScrEtHandler *h = core->handlers; h; h = h->next) h->handler = NULL;
  scr_et_core_drop(core);
  free(core);
}

/* The first method call through a capsule of the instance keeps it. */
static void scr_et_keep_self(ScrEventTargetObj *t, ScrDyn *self) {
  if (!t->core->self && self && scr_event_target_obj_of(self) == t)
    t->core->self = scr_dyn_retain(self);
}

void scr_event_obj_init(void *obj, ScrDyn *args) {
  ScrEventObj *e = obj;
  e->ev = scr_event_construct(args, false);
}

/* super(type) with a string: nothing to validate or convert. */
void scr_event_obj_init_type(void *obj, ScrStr *type) {
  scr_et_install();
  ScrEventObj *e = obj;
  e->ev = scr_event_alloc(scr_str_retain(type), false);
}

void scr_event_state_drop(ScrEvent *ev) {
  if (ev) scr_event_release_v(ev);
}

void scr_event_state_trace(ScrEvent *ev, ScrTraceVisit visit, void *ctx) {
  if (!ev) return;
  if (ev->target) visit(ev->target, ctx);
  if (ev->detail) visit(ev->detail, ctx);
}

void scr_event_state_gcfree(ScrEvent *ev) {
  if (!ev) return;
  ev->target = NULL;
  ev->detail = NULL;
  scr_event_release_v(ev);
}

/* The typed-receiver entry points: `method` is the member's name literal
 * (string data is NUL-terminated), `args` the argument vector as one dyn
 * array. */
ScrDyn *scr_event_target_obj_call(void *obj, ScrDyn *self, ScrStr *method, ScrDyn *args) {
  ScrEventTargetObj *t = obj;
  scr_et_keep_self(t, self);
  ScrDyn *out = NULL;
  scr_et_target_method(t->core, self, method->data, args->v.arr.items, args->v.arr.len, &out);
  return out;
}

/* dispatchEvent(event) on a typed receiver: the result as a bool (false
 * with the exception pending). */
bool scr_event_target_obj_dispatch(void *obj, ScrDyn *self, ScrDyn *event) {
  ScrEventTargetObj *t = obj;
  scr_et_keep_self(t, self);
  ScrDyn *args[1] = {event};
  ScrDyn *out = scr_et_dispatch_event(t->core, self, args, 1);
  if (!out) return false;
  bool accepted = out->v.b;
  scr_dyn_release(out);
  return accepted;
}

ScrDyn *scr_event_obj_get(void *obj, ScrStr *key) {
  ScrEventObj *e = obj;
  ScrDyn *value = scr_event_get(e->ev, key->data, key->len);
  return value ? value : scr_dyn_retain(scr_dyn_undefined());
}

void scr_event_obj_set(void *obj, ScrStr *key, ScrDyn *value) {
  ScrEventObj *e = obj;
  scr_event_set(e->ev, key->data, key->len, value);
}

ScrDyn *scr_event_obj_call(void *obj, ScrStr *method, ScrDyn *args) {
  ScrEventObj *e = obj;
  return scr_event_invoke(e->ev, NULL, method->data, args->v.arr.items, args->v.arr.len,
                          method->data);
}

/* Checked-dynamic access to the inherited members (the handle ops' twins
 * over the capsule; members of the subclass itself answer through the
 * capsule's ordinary view). */
static ScrDyn *scr_event_ref_get(const ScrDyn *d, const ScrStr *key) {
  if (scr_event_target_obj_of(d)) return scr_et_method_value(key->data, key->len, true);
  ScrEventObj *e = scr_event_obj_of(d);
  return e && e->ev ? scr_event_get(e->ev, key->data, key->len) : NULL;
}

static bool scr_event_ref_set(ScrDyn *d, const ScrStr *key, const ScrDyn *value) {
  ScrEventTargetObj *t = scr_event_target_obj_of(d);
  ScrEventObj *e = scr_event_obj_of(d);
  if (!t && !(e && e->ev)) return false;
  if (e && scr_event_set(e->ev, key->data, key->len, value)) return true;
  /* The other inherited members are getters and prototype methods; a
   * write would shadow them with an own property the engine never
   * reads. */
  ScrDyn *inherited = t ? scr_et_method_value(key->data, key->len, true)
                        : scr_event_get(e->ev, key->data, key->len);
  if (!inherited) return false;
  scr_dyn_release(inherited);
  char message[128];
  snprintf(message, sizeof message,
           "writing the inherited member '%.*s' through an untyped value is not supported",
           (int)key->len, key->data);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
  return true;
}

static bool scr_event_ref_invoke(ScrDyn *d, const char *method, ScrDyn *const *args, size_t argc,
                                 const char *what, ScrDyn **out) {
  ScrEventTargetObj *t = scr_event_target_obj_of(d);
  if (t) {
    if (!t->core) return false;
    scr_et_keep_self(t, d);
    return scr_et_target_method(t->core, d, method, args, argc, out);
  }
  ScrEventObj *e = scr_event_obj_of(d);
  if (!e || !e->ev || !scr_event_method_is(method)) return false;
  *out = scr_event_invoke(e->ev, d, method, args, argc, what);
  return true;
}

/* Node's [kInspect] on the subclass: the constructor's name, then the
 * Event view (an empty object for targets). */
static ScrDyn *scr_event_ref_inspect_view(const ScrDyn *d, const char **cls) {
  ScrEventTargetObj *t = scr_event_target_obj_of(d);
  if (t) {
    *cls = t->cls;
    return scr_dyn_new_obj();
  }
  ScrEventObj *e = scr_event_obj_of(d);
  if (!e || !e->ev) return NULL;
  *cls = e->cls;
  return scr_event_inspect_view(e->ev);
}

static const char *scr_event_ref_string_tag(const ScrDyn *d) {
  if (scr_event_target_obj_of(d)) return "[object EventTarget]";
  return scr_event_obj_of(d) ? "[object Event]" : NULL;
}

static const ScrEventRefHooks scr_event_obj_ref_hooks = {
    .get = scr_event_ref_get,
    .set = scr_event_ref_set,
    .invoke = scr_event_ref_invoke,
    .inspect_view = scr_event_ref_inspect_view,
    .string_tag = scr_event_ref_string_tag,
};

static void scr_et_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_EVENT, &scr_event_ops);
  scr_dyn_handle_install(SCR_DYNH_CUSTOM_EVENT, &scr_custom_event_ops);
  scr_dyn_handle_install(SCR_DYNH_MESSAGE_EVENT, &scr_message_event_ops);
  scr_dyn_handle_install(SCR_DYNH_EVENT_TARGET, &scr_event_target_ops);
  scr_event_ref_hooks = &scr_event_obj_ref_hooks;
  scr_et_register_teardown();
}

static void scr_et_teardown(void) {
  while (scr_et_live_cores) scr_et_core_drop(scr_et_live_cores);
  while (scr_et_live_events) scr_event_drop_refs(scr_et_live_events);
  for (size_t i = 0; i < SCR_ET_METHODS; i++) {
    scr_dyn_release(scr_et_method_values[i]);
    scr_et_method_values[i] = NULL;
  }
  scr_dyn_release(scr_et_handle_event_reader);
  scr_et_handle_event_reader = NULL;
}

ScrDyn *scr_event_target_new(void) {
  scr_et_install();
  ScrEventTarget *t = scr_et_calloc(sizeof *t);
  t->rc = 1;
  scr_et_core_init(&t->core, 10, "EventTarget");
  ScrDyn *out = scr_dyn_new_handle(t, SCR_DYNH_EVENT_TARGET);
  scr_event_target_release_v(t);
  return out;
}

ScrDyn *scr_event_new_trusted(const char *type) {
  scr_et_install();
  ScrEvent *ev = scr_event_alloc(scr_str_new(type, strlen(type)), false);
  ev->trusted = true;
  ScrDyn *out = scr_dyn_new_handle(ev, SCR_DYNH_EVENT);
  scr_event_release_v(ev);
  return out;
}

/* The constructor's options: null/undefined are none, other non-objects
 * throw; bubbles, cancelable and composed are read in order. */
static ScrEvent *scr_event_construct(ScrDyn *args, bool custom) {
  scr_et_install();
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  if (argc == 0) {
    scr_et_type_error("The \"type\" argument must be specified", "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrDyn *const *items = args->v.arr.items;
  ScrDyn *options = argc > 1 ? items[1] : NULL;
  bool has_options = options && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL;
  if (has_options && (!scr_dyn_is_object(options) || options->kind == SCR_DYN_ARR)) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  bool flags[3] = {false, false, false};
  static const char *const keys[] = {"bubbles", "cancelable", "composed"};
  for (size_t i = 0; has_options && i < 3; i++) {
    ScrDyn *v = scr_et_prop(options, keys[i]);
    if (!v && scr_exc_pending()) return NULL;
    flags[i] = v && scr_dyn_truthy(v);
    scr_dyn_release(v);
  }
  ScrStr *type = scr_dyn_string_coerce_js(items[0]);
  if (!type) return NULL;
  ScrEvent *ev = scr_event_alloc(type, custom);
  ev->bubbles = flags[0];
  ev->cancelable = flags[1];
  ev->composed = flags[2];
  return ev;
}

ScrDyn *scr_event_new(ScrDyn *args) {
  ScrEvent *ev = scr_event_construct(args, false);
  if (!ev) return NULL;
  ScrDyn *out = scr_dyn_new_handle(ev, SCR_DYNH_EVENT);
  scr_event_release_v(ev);
  return out;
}

ScrDyn *scr_custom_event_new(ScrDyn *args) {
  ScrEvent *ev = scr_event_construct(args, true);
  if (!ev) return NULL;
  /* `options?.detail ?? null`, read after the Event fields */
  ScrDyn *options = args->v.arr.len > 1 ? args->v.arr.items[1] : NULL;
  if (options && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL) {
    ScrDyn *detail = scr_et_prop(options, "detail");
    if (!detail && scr_exc_pending()) {
      scr_event_release_v(ev);
      return NULL;
    }
    if (detail && detail->kind != SCR_DYN_UNDEF && detail->kind != SCR_DYN_NULL) {
      ev->detail = detail;
      scr_event_track(ev);
    } else {
      scr_dyn_release(detail);
    }
  }
  ScrDyn *out = scr_dyn_new_handle(ev, SCR_DYNH_CUSTOM_EVENT);
  scr_event_release_v(ev);
  return out;
}

/* ── BroadcastChannel's EventTarget side ───────────────────────────── */

static ScrEventTargetCore *scr_et_broadcast_core_new(const char *cls) {
  ScrEventTargetCore *core = scr_et_calloc(sizeof *core);
  scr_et_core_init(core, 10, cls);
  return core;
}

static void scr_et_broadcast_core_free(ScrEventTargetCore *core) {
  scr_et_core_drop(core);
  free(core);
}

/* the 'message' MessageEvent (not trusted, as in Node) with the data */
static void scr_et_broadcast_dispatch(ScrEventTargetCore *core, ScrDyn *self, ScrDyn *data) {
  ScrEvent *ev = scr_event_alloc(scr_str_new("message", 7), false);
  ev->message = true;
  ev->detail = scr_dyn_retain(data);
  scr_event_track(ev);
  ScrDyn *event = scr_dyn_new_handle(ev, SCR_DYNH_MESSAGE_EVENT);
  scr_event_release_v(ev);
  scr_et_dispatch(core, self, event);
  scr_dyn_release(event);
}

static ScrDyn *scr_et_broadcast_method_value(const char *name, size_t length) {
  return scr_et_method_value(name, length, true);
}

static const ScrEtBroadcastOps scr_et_broadcast_table = {
    &scr_et_broadcast_core_new,     &scr_et_broadcast_core_free, &scr_et_broadcast_dispatch,
    &scr_et_target_method,          &scr_et_broadcast_method_value,
    &scr_et_handler_get,            &scr_et_handler_set,
};

void scr_et_broadcast_install(void) {
  scr_et_install();
  scr_et_broadcast_ops = &scr_et_broadcast_table;
}

bool scr_event_is(const ScrDyn *v, double kind) {
  if (v->kind == SCR_DYN_TYPED_REF) {
    /* Compiled subclasses extend Event or EventTarget (never CustomEvent). */
    if (kind == 0) return scr_event_obj_of(v) != NULL;
    return kind == 2 && scr_event_target_obj_of(v) != NULL;
  }
  if (v->kind != SCR_DYN_HANDLE) return false;
  ScrDynHandleTag tag = v->v.handle.tag;
  if (kind == 0)
    return tag == SCR_DYNH_EVENT || tag == SCR_DYNH_CUSTOM_EVENT || tag == SCR_DYNH_MESSAGE_EVENT;
  if (kind == 1) return tag == SCR_DYNH_CUSTOM_EVENT;
  return tag == SCR_DYNH_EVENT_TARGET ||
         (scr_et_signal_core_fn != NULL && tag == SCR_DYNH_ABORT_SIGNAL);
}

/* ── events.addAbortListener ───────────────────────────────────────── */

static void *scr_et_dyn_retain_v(void *p) { return scr_dyn_retain((ScrDyn *)p); }
static void scr_et_dyn_release_v(void *p) { scr_dyn_release((ScrDyn *)p); }

static ScrDyn *scr_et_box_get(ScrClosure *clo, size_t i) {
  return (ScrDyn *)scr_box_get_ref(clo->caps[i]);
}

static ScrBox *scr_et_dyn_box(ScrDyn *value) {
  ScrBox *box = scr_box_new_obj(&scr_et_dyn_retain_v, &scr_et_dyn_release_v, NULL);
  scr_box_set_ref(box, scr_dyn_retain(value));
  return box;
}

static void scr_et_aborted_listener_job(ScrClosure *job) {
  ScrDyn *listener = scr_et_box_get(job, 0);
  ScrDyn *r = scr_dyn_call(listener, NULL, 0, "listener");
  scr_dyn_release(r);
  scr_dyn_release(listener);
}

/* [SymbolDispose]() { removeEventListener?.(); } */
static ScrDyn *scr_et_abort_listener_dispose(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  if (clo->ncaps == 2) {
    ScrDyn *signal = scr_et_box_get(clo, 0);
    ScrDyn *listener = scr_et_box_get(clo, 1);
    bool aborted;
    ScrEventTargetCore *core = scr_et_signal_core_fn ? scr_et_signal_core_fn(signal, &aborted) : NULL;
    if (core) {
      ScrStr *abort = scr_str_new("abort", 5);
      ScrDyn *type = scr_dyn_new_str(abort);
      scr_str_release(abort);
      ScrDyn *remove_args[2] = {type, listener};
      ScrDyn *r = scr_et_remove_listener(core, remove_args, 2);
      scr_dyn_release(r);
      scr_dyn_release(type);
    }
    scr_dyn_release(signal);
    scr_dyn_release(listener);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_events_add_abort_listener(ScrDyn *signal, ScrDyn *listener) {
  bool aborted = false;
  ScrEventTargetCore *core =
      signal && scr_et_signal_core_fn ? scr_et_signal_core_fn(signal, &aborted) : NULL;
  if (!core) {
    scr_dyn_arg_type_fail("signal", "an instance of AbortSignal", signal ? signal : scr_dyn_undefined());
    return NULL;
  }
  if (!listener || !scr_dyn_is_callable(listener)) {
    scr_dyn_arg_type_fail("listener", "of type function", listener ? listener : scr_dyn_undefined());
    return NULL;
  }
  ScrClosure *dispose;
  if (aborted) {
    ScrClosure *job = scr_closure_new((void *)&scr_et_aborted_listener_job, 1);
    job->caps[0] = scr_et_dyn_box(listener);
    scr_queue_microtask(job);
    dispose = scr_closure_new((void *)&scr_et_abort_listener_dispose, 0);
  } else {
    ScrStr *abort = scr_str_new("abort", 5);
    bool duplicate;
    ScrEtListener *l =
        scr_et_append(core, abort, listener, SCR_ET_ONCE | SCR_ET_RESIST, &duplicate);
    scr_str_release(abort);
    (void)l;
    dispose = scr_closure_new((void *)&scr_et_abort_listener_dispose, 2);
    dispose->caps[0] = scr_et_dyn_box(signal);
    dispose->caps[1] = scr_et_dyn_box(listener);
  }
  return scr_dyn_new_func(dispose, scr_et_abort_listener_dispose, 0, "()", "[Symbol.dispose]");
}

/* ── node:timers/promises with { signal } ─────────────────────────────
 * setTimeout(delay, value, { signal, ref }) and setImmediate(value,
 * { signal, ref }), as lib/timers/promises.js runs them. An undefined
 * signal takes the plain form. A value that is not an AbortSignal rejects
 * with ERR_INVALID_ARG_TYPE, and an aborted signal rejects with an
 * AbortError whose cause is signal.reason, both without arming the timer.
 * Otherwise an 'abort' listener clears the timer (or immediate) and
 * rejects with that AbortError. The result settles like the timer's
 * promise once the listener is removed (scr_tp_abort_entry). */
typedef struct {
  size_t rc;
  ScrPromise *inner;  /* settled by the timer or the abort; owned */
  ScrPromise *result; /* the returned promise; owned */
  ScrDyn *signal;     /* owned */
  ScrDyn *listener;   /* owned, NULL until registered */
  double handle;
  bool immediate;
  int step;           /* the next step of scr_tp_abort_entry */
  bool settled;       /* the timer fired or the signal aborted */
} ScrTpAbort;

static void *scr_tp_abort_retain_v(void *p) {
  ((ScrTpAbort *)p)->rc++;
  return p;
}

static void scr_tp_abort_release_v(void *p) {
  ScrTpAbort *t = p;
  if (--t->rc != 0) return;
  scr_promise_release(t->inner);
  scr_promise_release(t->result);
  scr_dyn_release(t->signal);
  if (t->listener) scr_dyn_release(t->listener);
  free(t);
}

static ScrBox *scr_tp_abort_box(ScrTpAbort *t) {
  ScrBox *box = scr_box_new_obj(&scr_tp_abort_retain_v, &scr_tp_abort_release_v, NULL);
  scr_box_set_ref(box, scr_tp_abort_retain_v(t));
  return box;
}

/* new AbortError(undefined, { cause: signal.reason }), thrown. */
static void scr_tp_throw_abort(ScrDyn *signal) {
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  /* AbortError assigns code, then name: own enumerable properties */
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  ScrStr *k = scr_str_new("reason", 6);
  ScrDyn *reason = scr_dyn_handle_key_get(signal, k);
  scr_str_release(k);
  scr_error_define_cause(e, reason ? reason : scr_dyn_undefined());
  if (reason) scr_dyn_release(reason);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* The timer or immediate fired: the timer's promise takes the value. */
static void scr_tp_abort_fire(ScrClosure *self) {
  ScrTpAbort *t = scr_box_get_ref(self->caps[0]);
  ScrPromise *value = scr_box_get_ref(self->caps[1]);
  if (!t->settled) {
    t->settled = true;
    scr_promise_adapt_copy(t->inner, value);
  }
  scr_promise_release(value);
  scr_tp_abort_release_v(t);
}

/* The 'abort' listener: clear the timer, reject the timer's promise. */
static ScrDyn *scr_tp_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrTpAbort *t = scr_box_get_ref(clo->caps[0]);
  if (!t->settled) {
    t->settled = true;
    if (t->immediate) scr_clear_immediate(t->handle);
    else scr_clear_interval(t->handle);
    scr_tp_throw_abort(t->signal);
    scr_promise_reject_pending(t->inner);
  }
  scr_tp_abort_release_v(t);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The steps after the timer's promise settles, one promise job each:
 * Node's SafePromisePrototypeFinally wraps the promise in
 * `new Promise((a, b) => new SafePromise((a, b) => p.then(a, b))
 * .finally(remove).then(a, b))`, so the listener comes off in the second
 * job and the result settles in the fifth. Native fibers take each job as
 * an await hop; on wasm32 a runtime waiter cannot suspend, so each job is
 * a waiter spawned after a settled promise. */
static void scr_tp_abort_entry(ScrFiber *self, void *opaque) {
  (void)self;
  ScrTpAbort *t = opaque;
  for (;;) {
    if (t->step == 0) {
      scr_await_void(t->inner);
      if (scr_exc_pending()) scr_exc_clear();
    } else if (t->step == 1) {
      bool aborted;
      ScrEventTargetCore *core =
          scr_et_signal_core_fn ? scr_et_signal_core_fn(t->signal, &aborted) : NULL;
      if (core && t->listener) {
        ScrStr *abort = scr_str_new("abort", 5);
        ScrDyn *type = scr_dyn_new_str(abort);
        scr_str_release(abort);
        ScrDyn *remove_args[2] = {type, t->listener};
        ScrDyn *r = scr_et_remove_listener(core, remove_args, 2);
        if (r) scr_dyn_release(r);
        scr_dyn_release(type);
      }
      /* The listener's closure holds this state: dropping it here ends
       * the cycle once the signal no longer holds the listener. */
      if (t->listener) {
        scr_dyn_release(t->listener);
        t->listener = NULL;
      }
    } else if (t->step == 4) {
      scr_promise_adapt_copy(t->result, t->inner);
      scr_tp_abort_release_v(t);
      return;
    }
    t->step++;
#ifdef __wasi__
    ScrPromise *settled = scr_promise_settled_void();
    scr_promise_release(scr_async_spawn_after(settled, &scr_tp_abort_entry, t));
    scr_promise_release(settled);
    return;
#else
    scr_await_hop();
#endif
  }
}

static ScrPromise *scr_tp_signal(double ms, ScrPromise *value, bool ref, ScrDyn *signal,
                                 bool immediate) {
  if (signal->kind == SCR_DYN_UNDEF) {
    return immediate ? scr_tp_set_immediate_value(value, ref)
                     : scr_tp_set_timeout_value(ms, value, ref);
  }
  bool aborted = false;
  ScrEventTargetCore *core = scr_et_signal_core_fn ? scr_et_signal_core_fn(signal, &aborted) : NULL;
  ScrPromise *result = scr_promise_new();
  if (!core) {
    scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
    scr_promise_reject_pending(result);
    return result;
  }
  if (aborted) {
    scr_tp_throw_abort(signal);
    scr_promise_reject_pending(result);
    return result;
  }
  ScrTpAbort *t = scr_et_calloc(sizeof *t);
  t->rc = 1;
  t->inner = scr_promise_new();
  t->result = scr_promise_retain(result);
  t->signal = scr_dyn_retain(signal);
  t->immediate = immediate;
  ScrClosure *fire = scr_closure_new((void *)&scr_tp_abort_fire, 2);
  fire->caps[0] = scr_tp_abort_box(t);
  fire->caps[1] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
  scr_box_set_ref(fire->caps[1], scr_promise_retain(value));
  if (immediate) {
    t->handle = scr_set_immediate(fire);
    if (!ref) scr_immediate_unref(t->handle);
  } else {
    t->handle = scr_set_timeout_handle(fire, ms);
    if (!ref) scr_timer_unref(t->handle);
  }
  ScrClosure *clo = scr_closure_new((void *)&scr_tp_abort_thunk, 1);
  clo->caps[0] = scr_tp_abort_box(t);
  t->listener = scr_dyn_new_func(clo, &scr_tp_abort_thunk, 0, "()", "cancelListenerHandler");
  ScrStr *abort = scr_str_new("abort", 5);
  bool duplicate;
  (void)scr_et_append(core, abort, t->listener, SCR_ET_RESIST, &duplicate);
  scr_str_release(abort);
  /* The creation reference moves to the finally waiter. */
  scr_promise_release(scr_async_spawn_after(t->inner, &scr_tp_abort_entry, t));
  return result;
}

ScrPromise *scr_tp_set_timeout_signal(double ms, ScrPromise *value, bool ref, ScrDyn *signal) {
  return scr_tp_signal(ms, value, ref, signal, false);
}

ScrPromise *scr_tp_scheduler_wait_signal(double ms, ScrPromise *value, bool ref, ScrDyn *signal) {
  if (scr_mt_wait_state == 2) {
    static const char msg[] = "Value of \"this\" must be of type Scheduler";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_THIS");
    return NULL;
  }
  if (scr_mt_wait_state == 1) {
    static const char msg[] =
        "scheduler.wait with a signal while mock.timers mocks it has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
    return NULL;
  }
  return scr_tp_signal(ms, value, ref, signal, false);
}

ScrPromise *scr_tp_set_immediate_signal(ScrPromise *value, bool ref, ScrDyn *signal) {
  return scr_tp_signal(0, value, ref, signal, true);
}

/* ── util.aborted(signal, resource) ────────────────────────────────────
 * Node's async function: the signal must be an AbortSignal and the
 * resource an object (functions and arrays included), or the promise
 * rejects with ERR_INVALID_ARG_TYPE. An aborted signal gives a promise of
 * undefined; otherwise a once 'abort' listener that resists
 * stopImmediatePropagation resolves it with the event. The answer adopts
 * that promise, as an async function's result does. */
static ScrDyn *scr_util_aborted_listener(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrPromise *inner = scr_box_get_ref(closure->caps[0]);
  /* scr_promise_resolve_dyn takes the value's reference. */
  scr_promise_resolve_dyn(inner, scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()));
  scr_promise_release(inner);
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_util_aborted(ScrDyn *signal, ScrDyn *resource) {
  ScrPromise *outer = scr_promise_new();
  bool aborted = false;
  ScrEventTargetCore *core = scr_et_signal_core_fn ? scr_et_signal_core_fn(signal, &aborted) : NULL;
  bool object = resource->kind == SCR_DYN_OBJ || resource->kind == SCR_DYN_ARR || resource->kind == SCR_DYN_FUNC ||
                resource->kind == SCR_DYN_TYPED_REF || resource->kind == SCR_DYN_HANDLE ||
                resource->kind == SCR_DYN_BYTES || resource->kind == SCR_DYN_PROMISE ||
                resource->kind == SCR_DYN_PROXY;
  if (!core) {
    static const char message[] = "signal is not of type AbortSignal.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
  } else if (!object) {
    scr_dyn_arg_type_fail("resource", "of type object", resource);
  }
  if (scr_exc_pending()) {
    scr_promise_reject_pending(outer);
    ScrDyn *rejected = scr_dyn_new_promise(outer);
    scr_promise_release(outer);
    return rejected;
  }
  ScrPromise *inner = scr_promise_new();
  if (aborted) {
    scr_promise_fulfill_void(inner);
  } else {
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, NULL);
    scr_box_set_ref(closure->caps[0], scr_promise_retain(inner));
    ScrDyn *listener = scr_dyn_new_func(closure, scr_util_aborted_listener, 1, "native:function", "");
    ScrStr *abort = scr_str_new("abort", 5);
    bool duplicate;
    (void)scr_et_append(core, abort, listener, SCR_ET_ONCE | SCR_ET_RESIST, &duplicate);
    scr_str_release(abort);
    scr_dyn_release(listener);
  }
  ScrDyn *adopted = scr_dyn_new_promise(inner);
  scr_promise_release(inner);
  scr_promise_resolve_dyn(outer, adopted); /* moves the promise box in */
  ScrDyn *result = scr_dyn_new_promise(outer);
  scr_promise_release(outer);
  return result;
}

/* ── events.once(target, name[, { signal }]) over EventTargets ─────────
 * Node's lib/events.js `once` for a receiver that is not an EventEmitter:
 * a plain EventTarget (a target, an AbortSignal, a compiled subclass or a
 * BroadcastChannel) takes the event through addEventListener with
 * `{ once: true, [kResistStopPropagation]: true }` and resolves with the
 * event as the array's one element; a NodeEventTarget (a Worker or
 * MessagePort handle) goes through its own `once()` and resolves with the
 * emitted arguments, and — unless the awaited name is 'error' — a second
 * once listener on 'error' rejects the promise. Any other receiver is
 * Node's ERR_INVALID_ARG_TYPE. The options' signal is validated first (a
 * non-signal rejects with ERR_INVALID_ARG_TYPE, an aborted one with the
 * AbortError carrying its reason); otherwise a once, resist-stop-
 * propagation 'abort' listener removes the target's listener and rejects.
 *
 * The result adopts the inner promise through a thenable job, as the async
 * `once` function's return does. The state owns the inner promise, the
 * receiver, the name and the signal; each registered listener reaches it
 * through a link whose release clears the state's weak pointer to that
 * listener, so a removal never compares a freed identity. The state never
 * owns a listener: a target's core keeps the checked-dynamic function, an
 * emitter's entry keeps the closure, and the listener list is what frees
 * them. */

static ScrArrOps scr_eot_arr_ops = { scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v };

typedef struct ScrEotState ScrEotState;

enum { SCR_EOT_EVENT, SCR_EOT_ERROR, SCR_EOT_ABORT };

/* One registered listener as the state sees it: the value its list owns. A
 * target's core keeps the checked-dynamic function (removeEventListener
 * matches by it); an emitter's entry keeps the closure it was handed
 * (removeListener matches by it). Weak either way. */
typedef struct ScrEotSlot {
  ScrDyn *dyn;     /* target path */
  ScrClosure *clo; /* emitter path */
} ScrEotSlot;

typedef struct ScrEotLink {
  size_t rc;
  ScrEotState *st; /* owned */
  int slot;
} ScrEotLink;

struct ScrEotState {
  size_t rc;
  ScrPromise *inner;      /* owned */
  ScrDyn *target;         /* owned */
  ScrStr *name;           /* owned */
  ScrDyn *signal;         /* owned; undefined without one */
  ScrEotSlot event;
  ScrEotSlot error;
  ScrEotSlot abort;
  bool settled;
  bool emitter; /* the receiver is a NodeEventTarget (its emitter) */
};

static void scr_eot_oom(void) { scr_trap("scriptc: out of memory in events.once\n"); }

static void scr_eot_state_release(ScrEotState *st) {
  if (--st->rc > 0) return;
  scr_promise_release(st->inner);
  scr_dyn_release(st->target);
  scr_str_release(st->name);
  scr_dyn_release(st->signal);
  free(st);
}

static ScrEotSlot *scr_eot_slot(ScrEotState *st, int slot) {
  return slot == SCR_EOT_EVENT ? &st->event : slot == SCR_EOT_ERROR ? &st->error : &st->abort;
}

static void *scr_eot_link_retain(void *p) {
  ((ScrEotLink *)p)->rc++;
  return p;
}

static void scr_eot_link_release(void *p) {
  ScrEotLink *link = p;
  if (--link->rc > 0) return;
  ScrEotState *st = link->st;
  ScrEotSlot *slot = scr_eot_slot(st, link->slot);
  slot->dyn = NULL;
  slot->clo = NULL;
  scr_eot_state_release(st);
  free(link);
}

static ScrBox *scr_eot_link_box(ScrEotState *st, int slot) {
  ScrEotLink *link = calloc(1, sizeof *link);
  if (!link) scr_eot_oom();
  link->rc = 1;
  link->st = st;
  link->slot = slot;
  st->rc++;
  ScrBox *box = scr_box_new_obj(&scr_eot_link_retain, &scr_eot_link_release, NULL);
  scr_box_set_ref(box, link);
  return box;
}

/* A native listener function: caps[0] its link. +1. */
static ScrDyn *scr_eot_listener(ScrDynThunk thunk, ScrEotState *st, int slot, uint32_t arity,
                                const char *sig, const char *name) {
  ScrClosure *clo = scr_closure_new(NULL, 1);
  clo->caps[0] = scr_eot_link_box(st, slot);
  return scr_dyn_new_func(clo, thunk, arity, sig, name);
}

/* The event's arguments as the fulfilled array. +1. */
static ScrArr *scr_eot_values(ScrDyn *const *args, size_t argc) {
  ScrArr *values = scr_arr_new_ops(&scr_eot_arr_ops, argc ? argc : 1);
  for (size_t i = 0; i < argc; i++) scr_arr_set_ref(values, (double)i, scr_dyn_retain(args[i]));
  return values;
}

/* eventTargetAgnosticRemoveListener(receiver, name, listener). */
static void scr_eot_remove_name(ScrEotState *st, const ScrStr *name, const ScrEotSlot *slot) {
  if (st->emitter) {
    if (slot->clo == NULL) return;
    ScrEmitter *em = scr_et_helper_emitter(st->target);
    if (em) scr_emitter_release(scr_emitter_off(em, (ScrStr *)name, (ScrClosure *)slot->clo));
    return;
  }
  if (slot->dyn == NULL) return;
  ScrEventTargetCore *core = scr_et_core_of(st->target);
  if (core == NULL) return;
  ScrDyn *type = scr_dyn_new_str((ScrStr *)name);
  ScrDyn *args[2] = {type, slot->dyn};
  ScrDyn *result = scr_et_remove_listener(core, args, 2);
  if (result) scr_dyn_release(result);
  scr_dyn_release(type);
}

/* eventTargetAgnosticRemoveListener(signal, 'abort', abortListener). */
static void scr_eot_remove_abort(ScrEotState *st) {
  if (st->abort.dyn == NULL) return;
  bool aborted;
  ScrEventTargetCore *core =
      scr_et_signal_core_fn ? scr_et_signal_core_fn(st->signal, &aborted) : NULL;
  if (core == NULL) return;
  ScrStr *abort = scr_str_new("abort", 5);
  ScrDyn *type = scr_dyn_new_str(abort);
  scr_str_release(abort);
  ScrDyn *args[2] = {type, st->abort.dyn};
  ScrDyn *result = scr_et_remove_listener(core, args, 2);
  if (result) scr_dyn_release(result);
  scr_dyn_release(type);
}

/* The event fired: Node's resolver removes the 'error' listener (an
 * EventEmitter's), then the abort listener, and fulfills with the event's
 * arguments. */
static ScrDyn *scr_eot_fire(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrEotLink *link = scr_box_get_ref(cb->caps[0]);
  ScrEotState *st = link->st;
  if (!st->settled) {
    st->settled = true;
    if (st->error.dyn != NULL || st->error.clo != NULL) {
      ScrStr *error = scr_str_new("error", 5);
      scr_eot_remove_name(st, error, &st->error);
      scr_str_release(error);
    }
    scr_eot_remove_abort(st);
    ScrArr *values = scr_eot_values(args, argc);
    scr_promise_fulfill_ref(st->inner, values, scr_arr_retain_v, scr_arr_release_v,
                            values->cyc ? scr_arr_trace_v : NULL);
  }
  scr_eot_link_release(link);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The receiver emitted 'error' while waiting: Node's errorListener removes
 * the awaited listener and the abort listener, then rejects with the
 * error value. */
static ScrDyn *scr_eot_reject_error(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrEotLink *link = scr_box_get_ref(cb->caps[0]);
  ScrEotState *st = link->st;
  if (!st->settled) {
    st->settled = true;
    scr_eot_remove_name(st, st->name, &st->event);
    scr_eot_remove_abort(st);
    scr_dyn_throw(scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()));
    scr_promise_reject_pending(st->inner);
  }
  scr_eot_link_release(link);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The signal aborted: both listeners leave and the promise rejects with the
 * AbortError. */
static ScrDyn *scr_eot_reject_abort(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEotLink *link = scr_box_get_ref(cb->caps[0]);
  ScrEotState *st = link->st;
  if (!st->settled) {
    st->settled = true;
    scr_eot_remove_name(st, st->name, &st->event);
    if (st->error.dyn != NULL || st->error.clo != NULL) {
      ScrStr *error = scr_str_new("error", 5);
      scr_eot_remove_name(st, error, &st->error);
      scr_str_release(error);
    }
    scr_tp_throw_abort(st->signal);
    scr_promise_reject_pending(st->inner);
  }
  scr_eot_link_release(link);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrBox *scr_eot_promise_box(ScrPromise *p) {
  ScrBox *box = scr_box_new_obj(&scr_promise_retain_v, &scr_promise_release_v, &scr_promise_trace_v);
  scr_box_set_ref(box, scr_promise_retain(p));
  return box;
}

static void scr_eot_adopt_job(ScrClosure *job) {
  ScrPromise *outer = scr_box_get_ref(job->caps[0]);
  ScrPromise *inner = scr_box_get_ref(job->caps[1]);
  scr_promise_race_join(outer, inner, &scr_promise_adapt_copy);
  scr_promise_release(inner);
  scr_promise_release(outer);
}

/* The once() result adopts `inner` one turn after it settles, as the async
 * function's return does. Moves `inner` in; the result is +1. */
static ScrPromise *scr_eot_adopt(ScrPromise *inner) {
  ScrPromise *outer = scr_promise_new();
  ScrClosure *job = scr_closure_new((void *)&scr_eot_adopt_job, 2);
  job->caps[0] = scr_eot_promise_box(outer);
  job->caps[1] = scr_eot_promise_box(inner);
  scr_promise_release(inner);
  scr_queue_microtask(job);
  return outer;
}

static ScrPromise *scr_events_once_target_impl(ScrDyn *target, ScrStr *name, ScrDyn *options) {
  /* Node's async body: validateObject(options, 'options') and
   * validateAbortSignal(options.signal, 'options.signal') run before the
   * promise's executor. */
  ScrDyn *signal = scr_events_once_options(options);
  if (signal == NULL) {
    ScrPromise *rejected = scr_promise_new();
    scr_promise_reject_pending(rejected);
    return rejected;
  }
  /* Node takes an undefined options.signal as none; the helper reports a
   * null or non-AbortSignal one, and a value that only claims `aborted`
   * fails the core lookup below. */
  bool has_signal = signal->kind != SCR_DYN_UNDEF;
  bool aborted = false;
  ScrEventTargetCore *sig_core = NULL;
  if (has_signal) {
    sig_core = scr_et_signal_core_fn ? scr_et_signal_core_fn(signal, &aborted) : NULL;
    if (!sig_core) scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
    else if (aborted) scr_tp_throw_abort(signal);
  }
  ScrEventTargetCore *core = NULL;
  ScrEmitter *em = NULL;
  if (!scr_exc_pending()) {
    core = scr_et_core_of(target);
    if (core == NULL) {
      em = scr_et_helper_emitter(target);
      if (em == NULL) scr_dyn_arg_type_fail("emitter", "an instance of EventEmitter", target);
    }
  }
  if (scr_exc_pending()) {
    /* The async function's rejection: validation happens before the
     * promise's executor runs. */
    ScrPromise *rejected = scr_promise_new();
    scr_promise_reject_pending(rejected);
    scr_dyn_release(signal);
    return rejected;
  }
  ScrPromise *inner = scr_promise_new();
  ScrEotState *st = calloc(1, sizeof *st);
  if (!st) scr_eot_oom();
  st->rc = 1;
  st->inner = inner;
  st->target = scr_dyn_retain(target);
  st->name = scr_str_retain(name);
  st->signal = scr_dyn_retain(has_signal ? signal : scr_dyn_undefined());
  st->emitter = em != NULL;
  ScrDyn *event_listener =
      scr_eot_listener(&scr_eot_fire, st, SCR_EOT_EVENT, 1, "native:function", "resolver");
  if (em != NULL) {
    st->event.clo = event_listener->v.fn.clo;
    scr_emitter_release(scr_emitter_on_flex(em, name, event_listener, true, false));
    if (!scr_exc_pending() && !(name->len == 5 && !memcmp(name->data, "error", 5))) {
      /* An EventEmitter waits on 'error' too (unless that is the awaited
       * name): the error rejects the promise instead of throwing. */
      ScrDyn *error_listener = scr_eot_listener(&scr_eot_reject_error, st, SCR_EOT_ERROR, 1,
                                                "native:function", "errorListener");
      ScrStr *error_name = scr_str_new("error", 5);
      ScrEmitter *added = scr_emitter_on_flex(em, error_name, error_listener, true, false);
      if (added) scr_emitter_release(added);
      if (!scr_exc_pending()) st->error.clo = error_listener->v.fn.clo;
      scr_str_release(error_name);
      scr_dyn_release(error_listener);
    }
  } else {
    st->event.dyn = event_listener;
    bool duplicate;
    (void)scr_et_append(core, name, event_listener, SCR_ET_ONCE | SCR_ET_RESIST, &duplicate);
  }
  scr_dyn_release(event_listener);
  if (scr_exc_pending()) {
    /* A throwing 'newListener' listener rejects the promise, as a throw
     * inside the executor does; no abort listener follows it. */
    st->settled = true;
    scr_promise_reject_pending(inner);
  } else if (sig_core != NULL) {
    ScrDyn *abort_listener =
        scr_eot_listener(&scr_eot_reject_abort, st, SCR_EOT_ABORT, 0, "()", "abortListener");
    st->abort.dyn = abort_listener;
    ScrStr *abort = scr_str_new("abort", 5);
    bool duplicate;
    (void)scr_et_append(sig_core, abort, abort_listener, SCR_ET_ONCE | SCR_ET_RESIST, &duplicate);
    scr_str_release(abort);
    scr_dyn_release(abort_listener);
  }
  scr_eot_state_release(st); /* the creator's reference */
  scr_dyn_release(signal);
  return scr_eot_adopt(scr_promise_retain(inner));
}

/* events.once(target, name) */
ScrPromise *scr_events_once_target(ScrDyn *target, ScrStr *name) {
  return scr_events_once_target_impl(target, name, NULL);
}

/* events.once(target, name, options) */
ScrPromise *scr_events_once_target_signal(ScrDyn *target, ScrStr *name, ScrDyn *options) {
  return scr_events_once_target_impl(target, name, options);
}

/* ── events.on(emitter, name[, options]) ──────────────────────────────
 * Node's lib/events.js `on`: the async iterator over a receiver's events.
 *
 * The iterator is a checked-dynamic object with Node's own members:
 * next(), return(), throw(err), [Symbol.asyncIterator]() answering the
 * object, and the Symbol.for('nodejs.watermarkData') object whose
 * size/low/high/isPaused getters read the queue control. `for await` over
 * it takes the generic async-iteration path, so the members behave as
 * Node's methods of the same names do.
 *
 * Node's option ladder runs before the receiver is touched: the options
 * object (an object; null, arrays, functions and primitives are refused),
 * its `signal` (an object carrying an 'aborted' member; a pre-aborted one
 * throws the AbortError carrying its reason), then the watermarks —
 * integers from 1 to Number.MAX_SAFE_INTEGER, defaulting to 9007199254740991
 * and 1. Both watermark spellings are read: the camelCase one first and,
 * when it is nullish, the lowercase alias, which Node kept for backward
 * compatibility.
 *
 * The receiver then picks the protocol: a callable `on` registers through
 * an emitter (a NodeEventTarget through its own registry, a compiled
 * emitter through the emitter table, any other value through its own on),
 * a callable `addEventListener` through an EventTarget's listener core,
 * and a receiver with neither is Node's ERR_INVALID_ARG_TYPE (null and
 * undefined are the property-read TypeError instead, the read of `.on`
 * coming first). Unless 'error' is the awaited name and `on` is the
 * protocol, an 'error' listener follows; then the close names (from
 * options.close, when its length is truthy) and last the abort listener,
 * registered through the signal's addEventListener with `{ once: true }`.
 *
 * The watermark control is Node's: an event with no waiter counts in
 * `size`, pauses the receiver through its own pause() once size exceeds
 * the high watermark (a receiver without pause() throws, leaving the value
 * out of the queue but counted), and next() resumes through resume() once
 * size drops below the low watermark. Stored errors reject the oldest
 * waiter or wait for the next next(); throw(err) takes an Error and is
 * Node's ERR_INVALID_ARG_TYPE for anything else; close() disposes the
 * abort listener first, removes the listeners last-registered first, and
 * resolves every waiter with one done result.
 *
 * The state owns the receiver, the name and the signal; each registered
 * listener reaches it through a link whose release clears the state's weak
 * pointer to that listener, so a removal never compares a freed identity,
 * and the iterator's members pin the state while they live. The abort
 * listener's link is weak (the signal's own entry keeps the listener
 * alive; it pins no state), and the state owns that listener so its
 * disposal can reach it after the signal dropped it.
 */

#define SCR_EON_HIGH_DEFAULT 9007199254740991.0

/* The iterator's own members pin the state through links with one of these
 * slots; a registered listener's slot is always below st->nslots, so a
 * link's release tells the two apart. */
#define SCR_EON_MEMBER_NEXT (SIZE_MAX)
#define SCR_EON_MEMBER_RETURN (SIZE_MAX - 1)
#define SCR_EON_MEMBER_THROW (SIZE_MAX - 2)
#define SCR_EON_MEMBER_ASYNC (SIZE_MAX - 3)
#define SCR_EON_MEMBER_SIZE (SIZE_MAX - 4)
#define SCR_EON_MEMBER_LOW (SIZE_MAX - 5)
#define SCR_EON_MEMBER_HIGH (SIZE_MAX - 6)
#define SCR_EON_MEMBER_PAUSED (SIZE_MAX - 7)
#define SCR_EON_MEMBER_ABORT (SIZE_MAX - 8)

enum { SCR_EON_REG_EMITTER, SCR_EON_REG_CORE, SCR_EON_REG_DYN };

typedef struct ScrEonState ScrEonState;

/* One registered listener as the state sees it: the value its list holds
 * (an emitter entry keeps the checked-dynamic function, a target's core the
 * same function, a dynamic receiver whatever its on() stored) and the key
 * it was registered under. The value is borrowed — the link's release
 * clears it — and the key is owned by the state. */
typedef struct ScrEonSlot {
  ScrDyn *dyn;
  ScrClosure *clo;
  ScrStr *name;
} ScrEonSlot;

typedef struct ScrEonLink {
  size_t rc;
  ScrEonState *st; /* owned unless `weak` */
  size_t slot;
  bool weak;
} ScrEonLink;

struct ScrEonState {
  size_t rc;
  ScrDyn *recv;           /* owned: the receiver */
  ScrStr *name;           /* owned: the awaited event's registry key */
  ScrDyn *signal;         /* owned; undefined without one */
  ScrDyn *abort_listener; /* owned: the signal's 'abort' listener */
  ScrEonLink *abort_link; /* owned, weak: that listener's link */
  ScrDyn *error;          /* owned; the stored error, NULL when none */
  ScrEmitter *em;         /* borrowed (REG_EMITTER) */
  ScrEventTargetCore *core; /* borrowed (REG_CORE) */
  int reg;
  bool uses_on;         /* the protocol registers through `on` (symbol names kept) */
  bool abort_disposable; /* the non-aborted arm ran: close() calls removeEventListener */
  /* The typed registration, for a receiver compiled as an emitter: the
   * compiler's boxers (the event tuple and 'error''s to a checked-dynamic
   * argument array) and the adapter entry points built from them, which a
   * typed emit invokes. NULL `adapter` is the checked-dynamic form, whose
   * emits call the listener thunks. */
  ScrClosure *boxer;       /* owned; NULL without one */
  ScrClosure *error_boxer; /* owned */
  void *adapter;           /* the closure's function pointer (the adapter) */
  ScrEeInvoke inv;         /* the va_list shim that reaches it */
  void *error_adapter;
  ScrEeInvoke error_inv;
  /* The receiver's own pause()/resume() as callable values (owned; NULL
   * when it has none), which the watermark control calls with `recv` as
   * `this`. A compiled emitter's methods are not reachable through its
   * checked-dynamic view, which holds fields only, so the compiler hands
   * them over; without them the members are read from `recv` as Node
   * does. */
  ScrDyn *pause_fn;
  ScrDyn *resume_fn;
  double high, low;
  size_t size;
  bool paused, finished;
  ScrEonSlot *slots;
  size_t nslots, cslots;
  ScrDyn **events;
  size_t ehead, elen, ecap;
  ScrPromise **waiters;
  size_t whead, wlen, wcap;
};

static void scr_eon_oom(void) { scr_trap("scriptc: out of memory in events.on\n"); }

static void scr_eon_state_release(ScrEonState *st);
static ScrDyn *scr_eon_finish(ScrEonState *st, ScrDyn *options);

static void *scr_eon_state_retain(void *p) {
  ((ScrEonState *)p)->rc++;
  return p;
}

static void scr_eon_state_release_v(void *p) { scr_eon_state_release(p); }

static void *scr_eon_link_retain(void *p) {
  ((ScrEonLink *)p)->rc++;
  return p;
}

static void scr_eon_link_release(void *p) {
  ScrEonLink *link = p;
  if (--link->rc > 0) return;
  ScrEonState *st = link->st;
  if (!link->weak && st != NULL) {
    if (link->slot < st->nslots) {
      st->slots[link->slot].dyn = NULL;
      st->slots[link->slot].clo = NULL;
    }
    scr_eon_state_release(st);
  }
  free(link);
}

static ScrEonLink *scr_eon_link_new(ScrEonState *st, size_t slot, bool weak) {
  ScrEonLink *link = calloc(1, sizeof *link);
  if (!link) scr_eon_oom();
  link->rc = 1;
  link->st = st;
  link->slot = slot;
  link->weak = weak;
  if (!weak) st->rc++;
  return link;
}

static void scr_eon_state_release(ScrEonState *st) {
  if (--st->rc > 0) return;
  for (size_t i = 0; i < st->nslots; i++)
    if (st->slots[i].name) scr_str_release(st->slots[i].name);
  free(st->slots);
  for (size_t i = 0; i < st->elen; i++) scr_dyn_release(st->events[(st->ehead + i) % st->ecap]);
  free(st->events);
  for (size_t i = 0; i < st->wlen; i++)
    scr_promise_release(st->waiters[(st->whead + i) % st->wcap]);
  free(st->waiters);
  if (st->abort_listener) {
    /* The listener may outlive the state in a signal's registry: its link
     * stops reaching the state before either reference goes. */
    if (st->abort_link) {
      st->abort_link->st = NULL;
      scr_eon_link_release(st->abort_link);
    }
    scr_dyn_release(st->abort_listener);
  } else if (st->abort_link) {
    scr_eon_link_release(st->abort_link);
  }
  if (st->error) scr_dyn_release(st->error);
  if (st->pause_fn) scr_dyn_release(st->pause_fn);
  if (st->resume_fn) scr_dyn_release(st->resume_fn);
  if (st->boxer) scr_closure_release(st->boxer);
  if (st->error_boxer) scr_closure_release(st->error_boxer);
  scr_dyn_release(st->recv);
  scr_str_release(st->name);
  scr_dyn_release(st->signal);
  free(st);
}

/* A native listener over a fresh link in `slot`; a weak link does not pin
 * the state. `keep` takes the link's own reference when asked for. +1. */
static ScrDyn *scr_eon_listener(ScrEonState *st, ScrDynThunk thunk, size_t slot, bool weak,
                                uint32_t arity, const char *name, ScrEonLink **keep) {
  ScrEonLink *link = scr_eon_link_new(st, slot, weak);
  if (keep) *keep = scr_eon_link_retain(link);
  ScrBox *box = scr_box_new_obj(&scr_eon_link_retain, &scr_eon_link_release, NULL);
  scr_box_set_ref(box, link);
  ScrClosure *clo = scr_closure_new((void *)thunk, 1);
  clo->caps[0] = box;
  return scr_dyn_new_func(clo, thunk, arity, "native:function", name);
}

/* The adapter closure a typed emit invokes: caps[0] holds the compiler's
 * boxer (its tuple-to-arguments conversion), caps[1] the state the fire
 * entry reads. `adapter` is the compiler's entry that calls the boxer and
 * hands the array to scr_events_on_fire; `inv` the va_list shim in front of
 * it. */
static ScrClosure *scr_eon_adapter(void *adapter, ScrClosure *boxer, ScrEonState *st) {
  ScrClosure *c = scr_closure_new(adapter, 2);
  ScrBox *bx = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(bx, scr_closure_retain(boxer));
  c->caps[0] = bx;
  ScrBox *sb = scr_box_new_obj(&scr_eon_state_retain, &scr_eon_state_release_v, NULL);
  scr_box_set_ref(sb, scr_eon_state_retain(st));
  c->caps[1] = sb;
  return c;
}

/* The typed adapter of a listener whose Node form ignores the event's
 * arguments (the close and abort listeners): the emit's tuple is left
 * unread, and the listener thunk runs with none. */
static void scr_eon_ignore_invoke(ScrClosure *cb, va_list ap) {
  (void)ap;
  ScrDyn *answer = ((ScrDynThunk)cb->fn)(cb, NULL, 0);
  if (answer) scr_dyn_release(answer);
}

/* Get(object, key) over any checked-dynamic value, +1 (undefined when
 * absent). A string and a Buffer answer their own `length`, a capsule reads
 * its materialized view, a handle its key table; proxies and accessors run
 * as they do anywhere else. NULL means the read threw. */
static ScrDyn *scr_eon_prop(const ScrDyn *object, const char *key, size_t len) {
  switch (object->kind) {
  case SCR_DYN_STR:
    if (len == 6 && memcmp(key, "length", 6) == 0)
      return scr_dyn_new_num(scr_str_utf16_len(object->v.str));
    break;
  case SCR_DYN_BYTES:
    if (len == 6 && memcmp(key, "length", 6) == 0)
      return scr_dyn_new_num((double)object->v.bytes->len);
    break;
  case SCR_DYN_TYPED_REF: {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    if (!view) return NULL;
    ScrDyn *value = scr_eon_prop(view, key, len);
    scr_dyn_release(view);
    return value;
  }
  case SCR_DYN_HANDLE: {
    ScrStr *name = scr_str_new(key, len);
    ScrDyn *value = scr_dyn_handle_key_get(object, name);
    scr_str_release(name);
    return value;
  }
  default:
    break;
  }
  return scr_dyn_obj_read(object, key, len);
}

/* A member of the options dictionary (undefined without one). +1 or NULL. */
static ScrDyn *scr_eon_opt(const ScrDyn *options, const char *key, size_t len) {
  if (options == NULL) return scr_dyn_retain(scr_dyn_undefined());
  return scr_eon_prop(options, key, len);
}

/* events.once's options argument: Node's `validateObject(options,
 * 'options'); const { signal } = options; validateAbortSignal(signal,
 * 'options.signal')`, in that order. An explicit undefined is the default
 * options object. Other properties are not read. An array is not an
 * options object, including the view an empty literal typed `never[]`
 * reaches the runtime as. +1, or NULL with the exception pending (a
 * throwing signal getter stays pending). */
ScrDyn *scr_events_once_options(ScrDyn *options) {
  if (options != NULL && options->kind == SCR_DYN_UNDEF) options = NULL;
  if (options != NULL && (options->kind == SCR_DYN_NULL || options->kind == SCR_DYN_ARR ||
                          scr_dyn_ref_is_array(options) || !scr_dyn_is_object(options))) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  ScrDyn *signal = scr_eon_opt(options, "signal", 6);
  if (!signal) return NULL;
  if (signal->kind == SCR_DYN_UNDEF) return signal;
  /* validateAbortSignal: null and a non-object are not AbortSignals, and
   * neither is an object without an `aborted` member (Node's `in` probe). */
  bool carries = false;
  if (signal->kind != SCR_DYN_NULL && scr_dyn_is_object(signal)) {
    ScrStr *aborted = scr_str_new("aborted", 7);
    carries = scr_dyn_in(signal, aborted);
    scr_str_release(aborted);
    if (scr_exc_pending()) {
      scr_dyn_release(signal);
      return NULL;
    }
  }
  if (!carries) {
    scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
    scr_dyn_release(signal);
    return NULL;
  }
  return signal;
}

/* The value of a registry key: a symbol key keeps its symbol, any other key
 * is the string itself. +1. */
static ScrDyn *scr_eon_key_value(const ScrStr *name) {
  if (scr_str_is_symbol_key(name)) return scr_dyn_new_symbol(scr_str_symbol_key_sym(name));
  return scr_dyn_new_str((ScrStr *)name);
}

/* The registry key of an event-name value: a symbol keeps its identity when
 * the receiver registers through `on`, and is Node's ToString failure for
 * the addEventListener protocol (whose type is `${type}`). +1 or NULL with
 * the exception pending. */
static ScrStr *scr_eon_name_key(const ScrDyn *value, bool symbol_ok) {
  if (symbol_ok) return scr_emitter_name_dyn(value);
  /* The EventTarget protocol's event type has no symbol form: the target
   * coerces it with String(), and Node reports the symbol as this
   * ERR_INVALID_ARG_TYPE rather than the language's TypeError. */
  if (value->kind == SCR_DYN_SYMBOL) {
    static const char message[] = "Value is a Symbol and cannot be converted to a string.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  return scr_dyn_string_coerce_js(value);
}

/* close[i] over any value (undefined when absent). +1 or NULL. */
static ScrDyn *scr_eon_element(const ScrDyn *value, double index) {
  ScrDyn *fast = scr_dyn_index_get(value, index);
  if (fast == NULL && value->kind == SCR_DYN_STR) fast = scr_dyn_string_index_get(value, index);
  if (fast == NULL && value->kind == SCR_DYN_BYTES) fast = scr_dyn_bytes_index_get(value, index);
  if (fast != NULL) return fast;
  char key[32];
  size_t len = scr_f64_to_str(index, key);
  return scr_eon_prop(value, key, len);
}

/* `i < close.length` after the truthiness test, as < coerces the length.
 * False ends the loop — with the exception pending when the coercion threw
 * (`below` also false). */
static bool scr_eon_length_below(const ScrDyn *close, double index, bool *below) {
  ScrDyn *length = scr_eon_prop(close, "length", 6);
  if (!length) return false;
  double count = 0;
  bool ok = scr_dyn_number_coerce_js(length, &count);
  scr_dyn_release(length);
  if (!ok) return false;
  *below = index < count;
  return true;
}

/* The event's arguments as the wrapper's array. +1. */
static ScrDyn *scr_eon_args(ScrDyn *const *args, size_t argc) {
  ScrDyn *values = scr_dyn_new_arr();
  for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(values, scr_dyn_retain(args[i]));
  return values;
}

/* A typed boxer's array of the event's arguments as the checked-dynamic
 * array the iterator's next value is (the boxer returns `any[]`, whose
 * elements are borrowed). Moves `args`; +1. */
static ScrDyn *scr_eon_boxed_args(ScrArr *args) {
  size_t count = (size_t)scr_arr_len(args);
  ScrDyn *values = scr_dyn_new_arr();
  for (size_t i = 0; i < count; i++)
    scr_dyn_arr_push(values, scr_arr_get_ref(args, (double)i));
  scr_arr_release(args);
  return values;
}

static void scr_eon_events_push(ScrEonState *st, ScrDyn *value /* moves */) {
  if (st->elen == st->ecap) {
    size_t cap = st->ecap ? st->ecap * 2 : 8;
    ScrDyn **grown = malloc(cap * sizeof *grown);
    if (!grown) {
      scr_dyn_release(value);
      scr_eon_oom();
    }
    for (size_t i = 0; i < st->elen; i++) grown[i] = st->events[(st->ehead + i) % st->ecap];
    free(st->events);
    st->events = grown;
    st->ecap = cap;
    st->ehead = 0;
  }
  st->events[(st->ehead + st->elen) % st->ecap] = value;
  st->elen++;
}

/* The queue's oldest value. The queue can be shorter than the count: a
 * pause() that throws drops the event it just counted (scr_eon_push), as in
 * Node, whose FixedQueue.shift() then answers null for the missing entry.
 * That is what next() takes as the value once the real entries run out.
 * +1 (a fresh null when the queue is empty). */
static ScrDyn *scr_eon_events_shift(ScrEonState *st) {
  if (st->elen == 0) return scr_dyn_new_null();
  ScrDyn *value = st->events[st->ehead];
  st->events[st->ehead] = NULL;
  st->ehead = st->ecap ? (st->ehead + 1) % st->ecap : 0;
  st->elen--;
  if (st->elen == 0) st->ehead = 0;
  return value;
}

static void scr_eon_waiters_push(ScrEonState *st, ScrPromise *p /* moves */) {
  if (st->wlen == st->wcap) {
    size_t cap = st->wcap ? st->wcap * 2 : 4;
    ScrPromise **grown = malloc(cap * sizeof *grown);
    if (!grown) {
      scr_promise_release(p);
      scr_eon_oom();
    }
    for (size_t i = 0; i < st->wlen; i++) grown[i] = st->waiters[(st->whead + i) % st->wcap];
    free(st->waiters);
    st->waiters = grown;
    st->wcap = cap;
    st->whead = 0;
  }
  st->waiters[(st->whead + st->wlen) % st->wcap] = p;
  st->wlen++;
}

static ScrPromise *scr_eon_waiters_shift(ScrEonState *st) {
  ScrPromise *p = st->waiters[st->whead];
  st->whead = st->wcap ? (st->whead + 1) % st->wcap : 0;
  st->wlen--;
  if (st->wlen == 0) st->whead = 0;
  return p;
}

/* createIterResult(value, done): { value, done }. `value` borrowed. +1. */
static ScrDyn *scr_eon_result(ScrDyn *value, bool done) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

/* PromiseResolve(result): a fulfilled promise of it. Moves `result`. +1. */
static ScrDyn *scr_eon_resolved(ScrDyn *result) {
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_ref(p, result, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return out;
}

/* PromiseReject(error): the error thrown into a fresh promise. Moves the
 * error. +1. */
static ScrDyn *scr_eon_rejected(ScrDyn *error) {
  ScrPromise *p = scr_promise_new();
  scr_dyn_throw(error);
  scr_promise_reject_pending(p);
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return out;
}

/* Resolves a parked waiter with `result` (moved) and drops it. */
static void scr_eon_settle(ScrPromise *p, ScrDyn *result) {
  scr_promise_fulfill_ref(p, result, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_promise_release(p);
}

/* emitter.pause() / emitter.resume(), read from the receiver as Node calls
 * it: a receiver without the method throws Node's TypeError. When the
 * compiler handed the method over (a compiled emitter), it is called with
 * the receiver bound as `this`. */
static void scr_eon_call(ScrEonState *st, ScrDyn *fn, const char *method, const char *what) {
  if (fn != NULL) {
    scr_dyn_this_push_dyn(st->recv);
    ScrDyn *result = scr_dyn_call(fn, NULL, 0, what);
    scr_dyn_this_pop();
    if (result) scr_dyn_release(result);
    return;
  }
  ScrDyn *result = scr_dyn_invoke(st->recv, method, NULL, 0, what);
  if (result) scr_dyn_release(result);
}

static void scr_eon_pause(ScrEonState *st) {
  scr_eon_call(st, st->pause_fn, "pause", "emitter.pause");
}

static void scr_eon_resume(ScrEonState *st) {
  scr_eon_call(st, st->resume_fn, "resume", "emitter.resume");
}

/* throw new AbortError(undefined, { cause: signal.reason }). */
static void scr_eon_throw_abort(const ScrDyn *signal) {
  ScrDyn *reason = scr_eon_prop(signal, "reason", 6);
  if (!reason) return;
  ScrError *error = scr_error_abort(reason);
  scr_dyn_release(reason);
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* Which listener a registration carries: `form` picks the typed adapter a
 * compiled emitter's typed emits invoke (the event form and 'error''s use
 * the compiler's boxers, the close and abort listeners ignore the event's
 * arguments). */
enum { SCR_EON_LISTEN_EVENT, SCR_EON_LISTEN_ERROR, SCR_EON_LISTEN_IGNORE };

/* Appends a slot and registers one listener of `name` (borrowed) through
 * the state's protocol. The listener's link clears the slot when the list
 * frees it. Answers the slot index, or SIZE_MAX with the exception
 * pending. */
static size_t scr_eon_register(ScrEonState *st, const ScrStr *name, ScrDynThunk thunk,
                               uint32_t arity, const char *fn_name, int form) {
  if (st->nslots == st->cslots) {
    size_t cap = st->cslots ? st->cslots * 2 : 4;
    ScrEonSlot *grown = realloc(st->slots, cap * sizeof *grown);
    if (!grown) {
      scr_eon_oom();
      return SIZE_MAX;
    }
    st->slots = grown;
    st->cslots = cap;
  }
  size_t index = st->nslots++;
  ScrEonSlot *slot = &st->slots[index];
  memset(slot, 0, sizeof *slot);
  slot->name = scr_str_retain((ScrStr *)name);
  ScrDyn *listener = scr_eon_listener(st, thunk, index, false, arity, fn_name, NULL);
  if (st->reg == SCR_EON_REG_EMITTER) {
    slot->clo = listener->v.fn.clo;
    if (st->adapter == NULL) {
      /* The checked-dynamic form: an untyped emit calls the thunk, and the
       * runtime-fixed events ('error' and the meta events) reach it through
       * the registry's own typed adapters — the name crosses as a value, so
       * it may be any of them. */
      scr_emitter_release(scr_emitter_on_any(st->em, (ScrStr *)name, listener, false, false));
    } else if (form == SCR_EON_LISTEN_IGNORE) {
      /* The listener ignores the event's arguments, so its own closure is
       * the typed adapter: it runs the thunk with none. */
      scr_emitter_release(scr_emitter_on_dyn(st->em, (ScrStr *)name, listener,
                                             scr_closure_retain(listener->v.fn.clo),
                                             &scr_eon_ignore_invoke, false, false));
    } else {
      ScrClosure *boxer = st->boxer;
      void *adapter = st->adapter;
      ScrEeInvoke inv = st->inv;
      if (form == SCR_EON_LISTEN_ERROR && st->error_boxer != NULL) {
        boxer = st->error_boxer;
        adapter = st->error_adapter;
        inv = st->error_inv;
      }
      scr_emitter_release(scr_emitter_on_dyn(st->em, (ScrStr *)name, listener,
                                             scr_eon_adapter(adapter, boxer, st), inv, false,
                                             false));
    }
  } else if (st->reg == SCR_EON_REG_CORE) {
    slot->dyn = listener;
    bool duplicate;
    (void)scr_et_append(st->core, (ScrStr *)name, listener, 0, &duplicate);
  } else {
    /* The dynamic receiver: the key it registers under, the flags the
     * protocol takes, and the listener as its own function value. */
    slot->dyn = listener;
    ScrDyn *key = scr_eon_key_value(name);
    ScrDyn *args[3] = {key, listener, scr_dyn_undefined()};
    ScrDyn *result = scr_dyn_invoke(st->recv, st->uses_on ? "on" : "addEventListener", args,
                                    st->uses_on ? 2 : 3,
                                    st->uses_on ? "emitter.on" : "emitter.addEventListener");
    if (result) scr_dyn_release(result);
    scr_dyn_release(key);
  }
  scr_dyn_release(listener);
  return scr_exc_pending() ? SIZE_MAX : index;
}

/* eventTargetAgnosticRemoveListener(receiver, name, listener) for one slot. */
static void scr_eon_remove(ScrEonState *st, const ScrEonSlot *slot) {
  if (st->reg == SCR_EON_REG_EMITTER) {
    if (slot->clo == NULL || st->em == NULL) return;
    scr_emitter_release(scr_emitter_off(st->em, slot->name, slot->clo));
    return;
  }
  if (slot->dyn == NULL) return;
  if (st->reg == SCR_EON_REG_CORE) {
    if (st->core == NULL) return;
    ScrDyn *type = scr_eon_key_value(slot->name);
    ScrDyn *args[2] = {type, slot->dyn};
    ScrDyn *result = scr_et_remove_listener(st->core, args, 2);
    if (result) scr_dyn_release(result);
    scr_dyn_release(type);
    return;
  }
  ScrDyn *remove = scr_eon_prop(st->recv, "removeListener", 14);
  bool event_listener = false;
  if (remove && !scr_dyn_is_callable(remove)) {
    scr_dyn_release(remove);
    remove = NULL;
  }
  if (remove == NULL && !scr_exc_pending()) {
    remove = scr_eon_prop(st->recv, "removeEventListener", 19);
    if (remove && !scr_dyn_is_callable(remove)) {
      scr_dyn_release(remove);
      remove = NULL;
    }
    event_listener = true;
  }
  if (remove == NULL) {
    if (!scr_exc_pending())
      scr_dyn_arg_type_fail("emitter", "an instance of EventEmitter", st->recv);
    return;
  }
  ScrDyn *key = scr_eon_key_value(slot->name);
  ScrDyn *args[3] = {key, slot->dyn, scr_dyn_undefined()};
  ScrDyn *result = scr_dyn_invoke(
      st->recv, event_listener ? "removeEventListener" : "removeListener", args,
      event_listener ? 3 : 2,
      event_listener ? "emitter.removeEventListener" : "emitter.removeListener");
  if (result) scr_dyn_release(result);
  scr_dyn_release(key);
  scr_dyn_release(remove);
}

/* closeHandler() as a promise: the abort listener disposes, the listeners
 * leave last-registered first, and every waiter resolves with one done
 * result. PromiseResolve(doneResult) (+1), or NULL with the exception
 * pending. */
static ScrDyn *scr_eon_close(ScrEonState *st) {
  if (st->abort_disposable && st->abort_listener && st->signal->kind != SCR_DYN_UNDEF) {
    ScrStr *abort = scr_str_new("abort", 5);
    ScrDyn *key = scr_dyn_new_str(abort);
    scr_str_release(abort);
    ScrDyn *args[2] = {key, scr_dyn_retain(st->abort_listener)};
    ScrDyn *result =
        scr_dyn_invoke(st->signal, "removeEventListener", args, 2, "signal.removeEventListener");
    if (result) scr_dyn_release(result);
    scr_dyn_release(key);
    scr_dyn_release(args[1]);
    if (scr_exc_pending()) return NULL;
  }
  while (st->nslots > 0) {
    ScrEonSlot slot = st->slots[--st->nslots];
    st->slots[st->nslots].name = NULL;
    scr_eon_remove(st, &slot);
    if (slot.name) scr_str_release(slot.name);
    if (scr_exc_pending()) return NULL;
  }
  st->finished = true;
  st->paused = false;
  ScrDyn *done = scr_eon_result(scr_dyn_undefined(), true);
  while (st->wlen > 0) {
    ScrPromise *p = scr_eon_waiters_shift(st);
    scr_eon_settle(p, scr_dyn_retain(done));
  }
  return scr_eon_resolved(done);
}

/* errorHandler(err): the oldest waiter rejects, or the error waits for the
 * next next(); either way the iterator closes. Moves `err`. */
static bool scr_eon_on_error(ScrEonState *st, ScrDyn *err) {
  if (st->wlen == 0) {
    if (st->error) scr_dyn_release(st->error);
    st->error = err;
  } else {
    ScrPromise *p = scr_eon_waiters_shift(st);
    scr_dyn_throw(err);
    scr_promise_reject_pending(p);
    scr_promise_release(p);
  }
  ScrDyn *promise = scr_eon_close(st);
  if (promise == NULL) return false;
  scr_dyn_release(promise);
  return true;
}

/* One event's value reaches the iterator: the oldest parked waiter takes
 * it, or it counts in `size` and waits — pausing the receiver once size
 * exceeds the high watermark. `value` moves in. */
static void scr_eon_push(ScrEonState *st, ScrDyn *value) {
  if (st->wlen == 0) {
    st->size++;
    if (!st->paused && (double)st->size > st->high) {
      st->paused = true;
      scr_eon_pause(st);
    }
    /* Node pushes after pause(): a throwing pause drops the value, and the
     * count stays. */
    if (scr_exc_pending()) scr_dyn_release(value);
    else scr_eon_events_push(st, value);
  } else {
    ScrPromise *p = scr_eon_waiters_shift(st);
    ScrDyn *result = scr_eon_result(value, false); /* borrows `value` */
    scr_dyn_release(value);
    scr_eon_settle(p, result);
  }
}

/* The event fired: the wrapper's array goes to the oldest waiter, or counts
 * in `size` and waits. The wrapper's own return value is undefined. */
static ScrDyn *scr_eon_on_event(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrEonLink *link = scr_box_get_ref(cb->caps[0]);
  scr_eon_push(link->st, scr_eon_args(args, argc));
  scr_eon_link_release(link);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_eon_error_listener(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrEonLink *link = scr_box_get_ref(cb->caps[0]);
  scr_eon_on_error(link->st, scr_dyn_retain(argc > 0 ? args[0] : scr_dyn_undefined()));
  bool ok = !scr_exc_pending();
  scr_eon_link_release(link);
  return ok ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
}

static ScrDyn *scr_eon_close_listener(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEonLink *link = scr_box_get_ref(cb->caps[0]);
  ScrDyn *promise = scr_eon_close(link->st);
  bool ok = promise != NULL;
  if (promise) scr_dyn_release(promise);
  scr_eon_link_release(link);
  return ok ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
}

/* abortListener(): the AbortError carrying the signal's reason goes through
 * errorHandler. */
static ScrDyn *scr_eon_abort_listener_thunk(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEonLink *link = scr_box_get_ref(cb->caps[0]);
  ScrEonState *st = link->st;
  if (st != NULL) {
    ScrDyn *reason = scr_eon_prop(st->signal, "reason", 6);
    if (reason) {
      ScrError *error = scr_error_abort(reason);
      ScrDyn *value = scr_dyn_from_error(error);
      scr_error_release(error);
      scr_eon_on_error(st, value);
      scr_dyn_release(reason);
    }
  }
  bool ok = !scr_exc_pending();
  scr_eon_link_release(link);
  return ok ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
}

/* The pre-aborted arm's queueMicrotask(() => listener()). */
static void scr_eon_abort_job(ScrClosure *job) {
  ScrDyn *listener = scr_et_box_get(job, 0);
  ScrDyn *result = scr_eon_abort_listener_thunk(listener->v.fn.clo, NULL, 0);
  if (result) scr_dyn_release(result);
  scr_dyn_release(listener);
}

/* next(). +1 or NULL with the exception pending. */
static ScrDyn *scr_eon_next(ScrEonState *st) {
  if (st->size > 0) {
    ScrDyn *value = scr_eon_events_shift(st);
    st->size--;
    if (st->paused && (double)st->size < st->low) {
      scr_eon_resume(st);
      if (scr_exc_pending()) {
        scr_dyn_release(value);
        return NULL;
      }
      st->paused = false;
    }
    ScrDyn *result = scr_eon_result(value, false);
    scr_dyn_release(value);
    return scr_eon_resolved(result);
  }
  if (st->error != NULL && scr_dyn_truthy(st->error)) {
    ScrDyn *error = st->error;
    st->error = NULL;
    return scr_eon_rejected(error);
  }
  if (st->finished) return scr_eon_close(st);
  ScrPromise *p = scr_promise_new();
  scr_eon_waiters_push(st, p);
  return scr_dyn_new_promise(p);
}

static ScrDyn *scr_eon_next_thunk(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEonLink *link = scr_box_get_ref(cb->caps[0]);
  ScrDyn *result = scr_eon_next(link->st);
  scr_eon_link_release(link);
  return result;
}

static ScrDyn *scr_eon_return_thunk(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEonLink *link = scr_box_get_ref(cb->caps[0]);
  ScrDyn *result = scr_eon_close(link->st);
  scr_eon_link_release(link);
  return result;
}

/* Node's `throw(err)` check, `err instanceof Error`: a value compiled from
 * TypeScript crosses as the checked-dynamic error encoding (`%error`), or
 * as a capsule whose materialized view is one, while a JavaScript-lane
 * error keeps the built-in prototype. */
static bool scr_eon_is_error(const ScrDyn *value) {
  if (value == NULL) return false;
  if (value->kind == SCR_DYN_OBJ && scr_dyn_obj_get(value, "%error", 6) != NULL) return true;
  return scr_dyn_inherits_error_prototype(value) || scr_dyn_ref_is_error(value);
}

/* throw(err): an Error closes the iterator through errorHandler, though
 * `next()` rejects whatever was stored; anything else is Node's
 * ERR_INVALID_ARG_TYPE and the iterator is untouched. */
static ScrDyn *scr_eon_throw_thunk(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrEonLink *link = scr_box_get_ref(cb->caps[0]);
  ScrDyn *error = argc > 0 ? args[0] : scr_dyn_undefined();
  if (!scr_dyn_truthy(error) || !scr_eon_is_error(error))
    scr_dyn_arg_type_fail("EventEmitter.AsyncIterator", "an instance of Error", error);
  else
    scr_eon_on_error(link->st, scr_dyn_retain(error));
  bool ok = !scr_exc_pending();
  scr_eon_link_release(link);
  return ok ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
}

static ScrDyn *scr_eon_async_iter(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)cb;
  (void)args;
  (void)argc;
  return scr_dyn_this_get();
}

/* The watermark getters: no receiver, the state answers. */
static ScrDyn *scr_eon_watermark(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrEonLink *link = scr_box_get_ref(cb->caps[0]);
  ScrEonState *st = link->st;
  ScrDyn *value;
  switch (link->slot) {
  case SCR_EON_MEMBER_LOW:
    value = scr_dyn_new_num(st->low);
    break;
  case SCR_EON_MEMBER_HIGH:
    value = scr_dyn_new_num(st->high);
    break;
  case SCR_EON_MEMBER_PAUSED:
    value = scr_dyn_new_bool(st->paused);
    break;
  default:
    value = scr_dyn_new_num((double)st->size);
    break;
  }
  scr_eon_link_release(link);
  return value;
}

/* The iterator object Node builds with its object literal: next, return,
 * throw in insertion order, the async-iterator method and the watermark
 * symbol. +1. */
static ScrDyn *scr_eon_iterator(ScrEonState *st) {
  ScrDyn *it = scr_dyn_new_obj();
  scr_dyn_obj_set(it, "next", 4,
                  scr_eon_listener(st, &scr_eon_next_thunk, SCR_EON_MEMBER_NEXT, false, 0, "next",
                                   NULL));
  scr_dyn_obj_set(it, "return", 6,
                  scr_eon_listener(st, &scr_eon_return_thunk, SCR_EON_MEMBER_RETURN, false, 0,
                                   "return", NULL));
  scr_dyn_obj_set(it, "throw", 5,
                  scr_eon_listener(st, &scr_eon_throw_thunk, SCR_EON_MEMBER_THROW, false, 1,
                                   "throw", NULL));
  ScrStr *async_name = scr_str_new("asyncIterator", 13);
  ScrSym *async_sym = scr_sym_well_known(async_name);
  scr_str_release(async_name);
  if (async_sym != NULL) {
    ScrDyn *key = scr_dyn_new_symbol(async_sym);
    ScrDyn *method = scr_eon_listener(st, &scr_eon_async_iter, SCR_EON_MEMBER_ASYNC, false, 0,
                                      "[Symbol.asyncIterator]", NULL);
    scr_dyn_key_set_computed(it, key, method);
    scr_dyn_release(method);
    scr_dyn_release(key);
    scr_sym_release(async_sym);
  }
  ScrStr *marks_name = scr_str_new("nodejs.watermarkData", 20);
  ScrSym *marks_sym = scr_sym_for(marks_name);
  scr_str_release(marks_name);
  if (marks_sym != NULL) {
    static const struct {
      const char *name;
      size_t len, slot;
      const char *fn;
    } rows[] = {
        {"size", 4, SCR_EON_MEMBER_SIZE, "get size"},
        {"low", 3, SCR_EON_MEMBER_LOW, "get low"},
        {"high", 4, SCR_EON_MEMBER_HIGH, "get high"},
        {"isPaused", 8, SCR_EON_MEMBER_PAUSED, "get isPaused"},
    };
    ScrDyn *marks = scr_dyn_new_obj();
    for (size_t i = 0; i < sizeof rows / sizeof rows[0]; i++) {
      ScrDyn *getter =
          scr_eon_listener(st, &scr_eon_watermark, rows[i].slot, false, 0, rows[i].fn, NULL);
      scr_dyn_obj_set_accessor(marks, rows[i].name, rows[i].len, getter, NULL);
    }
    ScrDyn *key = scr_dyn_new_symbol(marks_sym);
    scr_dyn_key_set_computed(it, key, marks);
    scr_dyn_release(marks);
    scr_dyn_release(key);
    scr_sym_release(marks_sym);
  }
  return it;
}

static ScrDyn *scr_eon_abandon(ScrEonState *st) {
  scr_eon_state_release(st);
  return NULL;
}

/* The watermark ladder: validateInteger(value, name, 1). */
static bool scr_eon_watermark_check(const ScrDyn *value, const char *name, double *out) {
  if (value->kind != SCR_DYN_NUM) {
    scr_dyn_prop_type_fail(name, "of type number", value);
    return false;
  }
  double number = value->v.num;
  if (isfinite(number) && floor(number) == number && number >= 1 &&
      number <= SCR_EON_HIGH_DEFAULT) {
    *out = number;
    return true;
  }
  char received[48];
  scr_num_received(number, received);
  char message[192];
  int len = isfinite(number) && floor(number) == number
      ? snprintf(message, sizeof message,
                 "The value of \"%s\" is out of range. It must be >= 1 && <= 9007199254740991. "
                 "Received %s",
                 name, received)
      : snprintf(message, sizeof message,
                 "The value of \"%s\" is out of range. It must be an integer. Received %s", name,
                 received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

/* options.highWaterMark ?? options.highWatermark (the 'low' pair reads the
 * same): the modern spelling wins, the lowercase one is the alias Node
 * kept for backward compatibility, and a nullish primary falls through. */
static ScrDyn *scr_eon_opt_alias(const ScrDyn *options, const char *key, size_t key_len,
                                 const char *alias, size_t alias_len) {
  ScrDyn *value = scr_eon_opt(options, key, key_len);
  if (!value) return NULL;
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    scr_dyn_release(value);
    value = scr_eon_opt(options, alias, alias_len);
  }
  return value;
}

/* The options ladder both entries share: validateObject(options, 'options'),
 * options.signal (type-checked, then the pre-aborted AbortError) and the two
 * watermarks in Node's order. Answers the state with recv/signal/high/low
 * set (the event name and the protocol follow), or NULL with the exception
 * pending. */
/* The ladder's failure exit: drop the state, answer NULL. */
static ScrEonState *scr_eon_begin_fail(ScrEonState *st) {
  scr_eon_state_release(st);
  return NULL;
}

static ScrEonState *scr_eon_begin(ScrDyn *recv, ScrDyn *options) {
  /* An explicit undefined is the plain form (Node's options parameter is
   * optional). */
  if (options != NULL && options->kind == SCR_DYN_UNDEF) options = NULL;
  /* validateObject(options, 'options'): null, an array, a function, or a
   * primitive. */
  if (options != NULL && (options->kind == SCR_DYN_NULL || options->kind == SCR_DYN_ARR ||
                          scr_dyn_ref_is_array(options) || !scr_dyn_is_object(options))) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  ScrDyn *signal = scr_eon_opt(options, "signal", 6);
  if (!signal) return NULL;
  ScrEonState *st = calloc(1, sizeof *st);
  if (!st) {
    scr_dyn_release(signal);
    scr_eon_oom();
  }
  st->rc = 1;
  st->recv = scr_dyn_retain(recv);
  if (signal->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(signal);
    st->signal = scr_dyn_retain(scr_dyn_undefined());
  } else {
    st->signal = signal;
  }
  st->high = SCR_EON_HIGH_DEFAULT;
  st->low = 1;

  /* validateAbortSignal(options.signal, 'options.signal'), then the
   * pre-aborted AbortError. */
  bool has_signal = st->signal->kind != SCR_DYN_UNDEF;
  if (has_signal) {
    /* validateAbortSignal: a nullish signal is not an AbortSignal (and the
     * `in` probe below would throw its own TypeError on null). */
    if (st->signal->kind == SCR_DYN_NULL || !scr_dyn_is_object(st->signal)) {
      scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", st->signal);
      return scr_eon_begin_fail(st);
    }
    ScrStr *aborted_name = scr_str_new("aborted", 7);
    bool carries = scr_dyn_in(st->signal, aborted_name);
    scr_str_release(aborted_name);
    if (scr_exc_pending()) return scr_eon_begin_fail(st);
    if (!carries) {
      scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", st->signal);
      return scr_eon_begin_fail(st);
    }
    ScrDyn *aborted = scr_eon_prop(st->signal, "aborted", 7);
    if (!aborted) return scr_eon_begin_fail(st);
    bool early = scr_dyn_truthy(aborted);
    scr_dyn_release(aborted);
    if (early) {
      scr_eon_throw_abort(st->signal);
      return scr_eon_begin_fail(st);
    }
    /* option order: highWaterMark, then lowWaterMark */
  }
  ScrDyn *high = scr_eon_opt_alias(options, "highWaterMark", 13, "highWatermark", 13);
  if (!high) return scr_eon_begin_fail(st);
  if (high->kind != SCR_DYN_UNDEF && high->kind != SCR_DYN_NULL &&
      !scr_eon_watermark_check(high, "options.highWaterMark", &st->high)) {
    scr_dyn_release(high);
    return scr_eon_begin_fail(st);
  }
  scr_dyn_release(high);
  ScrDyn *low = scr_eon_opt_alias(options, "lowWaterMark", 12, "lowWatermark", 12);
  if (!low) return scr_eon_begin_fail(st);
  if (low->kind != SCR_DYN_UNDEF && low->kind != SCR_DYN_NULL &&
      !scr_eon_watermark_check(low, "options.lowWaterMark", &st->low)) {
    scr_dyn_release(low);
    return scr_eon_begin_fail(st);
  }
  scr_dyn_release(low);
  return st;
}

/* The awaited event's registry key, converted from the name value once the
 * protocol is known: `on` keeps a symbol's identity, the addEventListener
 * protocol has no symbol form. Answers false with the exception pending. */
static bool scr_eon_name(ScrEonState *st, const ScrDyn *name) {
  st->name = scr_eon_name_key(name, st->uses_on);
  return st->name != NULL;
}

static ScrDyn *scr_events_on_impl(ScrEmitter *seed_emitter, ScrDyn *recv, ScrDyn *pause_fn,
                                  ScrDyn *resume_fn, ScrDyn *name, ScrDyn *options) {
  ScrEonState *st = scr_eon_begin(recv, options);
  if (!st) return NULL;
  if (pause_fn != NULL && pause_fn->kind != SCR_DYN_UNDEF)
    st->pause_fn = scr_dyn_retain(pause_fn);
  if (resume_fn != NULL && resume_fn->kind != SCR_DYN_UNDEF)
    st->resume_fn = scr_dyn_retain(resume_fn);

  /* The protocol, from the receiver's own members. */
  if (seed_emitter != NULL) {
    st->reg = SCR_EON_REG_EMITTER;
    st->em = seed_emitter;
    st->uses_on = true;
  } else if (recv->kind == SCR_DYN_NULL || recv->kind == SCR_DYN_UNDEF) {
    char message[96];
    snprintf(message, sizeof message, "Cannot read properties of %s (reading 'on')",
             recv->kind == SCR_DYN_NULL ? "null" : "undefined");
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return scr_eon_abandon(st);
  } else {
    ScrDyn *on = scr_eon_prop(recv, "on", 2);
    if (!on) return scr_eon_abandon(st);
    bool has_on = scr_dyn_is_callable(on);
    scr_dyn_release(on);
    if (has_on) {
      st->uses_on = true;
      st->em = scr_et_helper_emitter(recv);
      st->reg = st->em ? SCR_EON_REG_EMITTER : SCR_EON_REG_DYN;
    } else {
      ScrDyn *add = scr_eon_prop(recv, "addEventListener", 16);
      if (!add) return scr_eon_abandon(st);
      bool has_add = scr_dyn_is_callable(add);
      scr_dyn_release(add);
      if (!has_add) {
        scr_dyn_arg_type_fail("emitter", "an instance of EventEmitter", recv);
        return scr_eon_abandon(st);
      }
      st->core = scr_et_core_of(recv);
      st->reg = st->core ? SCR_EON_REG_CORE : SCR_EON_REG_DYN;
    }
  }
  if (!scr_eon_name(st, name)) return scr_eon_abandon(st);
  return scr_eon_finish(st, options);
}

/* The registrations every entry makes, in Node's order — the event, the
 * 'error' handler, the close names, the signal's abort listener — and the
 * iterator itself. `options` is borrowed. Consumes the creator's reference
 * to `st`; +1. */
static ScrDyn *scr_eon_finish(ScrEonState *st, ScrDyn *options) {
  ScrStr *name = st->name;
  bool has_signal = st->signal->kind != SCR_DYN_UNDEF;

  if (scr_eon_register(st, name, &scr_eon_on_event, 0, "", SCR_EON_LISTEN_EVENT) == SIZE_MAX)
    return scr_eon_abandon(st);
  bool error_name = name->len == 5 && memcmp(name->data, "error", 5) == 0;
  if (!error_name && st->uses_on) {
    ScrStr *error = scr_str_new("error", 5);
    size_t slot =
        scr_eon_register(st, error, &scr_eon_error_listener, 1, "errorHandler",
                         SCR_EON_LISTEN_ERROR);
    scr_str_release(error);
    if (slot == SIZE_MAX) return scr_eon_abandon(st);
  }

  /* const closeEvents = options?.close; its names follow. */
  ScrDyn *close = scr_eon_opt(options, "close", 5);
  if (!close) return scr_eon_abandon(st);
  if (close->kind != SCR_DYN_UNDEF && close->kind != SCR_DYN_NULL) {
    ScrDyn *length = scr_eon_prop(close, "length", 6);
    bool any = length != NULL && scr_dyn_truthy(length);
    scr_dyn_release(length);
    double index = 0;
    while (any) {
      bool below = false;
      if (!scr_eon_length_below(close, index, &below) || !below) break;
      ScrDyn *element = scr_eon_element(close, index);
      if (!element) break;
      ScrStr *key = scr_eon_name_key(element, st->uses_on);
      scr_dyn_release(element);
      if (!key) break;
      size_t slot =
          scr_eon_register(st, key, &scr_eon_close_listener, 0, "closeHandler",
                           SCR_EON_LISTEN_IGNORE);
      scr_str_release(key);
      if (slot == SIZE_MAX) break;
      index += 1.0;
    }
  }
  scr_dyn_release(close);
  if (scr_exc_pending()) return scr_eon_abandon(st);

  /* const abortListenerDisposable = signal ? addAbortListener(signal,
   * abortListener) : null; — the signal's aborted state is read again. */
  if (has_signal) {
    ScrDyn *aborted = scr_eon_prop(st->signal, "aborted", 7);
    if (!aborted) return scr_eon_abandon(st);
    bool late = scr_dyn_truthy(aborted);
    scr_dyn_release(aborted);
    /* The abort listener is not one of the close slots: its registration
     * is the signal's, and its link stays weak. */
    ScrDyn *listener = scr_eon_listener(st, &scr_eon_abort_listener_thunk,
                                        SCR_EON_MEMBER_ABORT, true, 0, "abortListener",
                                        &st->abort_link);
    st->abort_listener = listener;
    if (late) {
      ScrClosure *job = scr_closure_new((void *)&scr_eon_abort_job, 1);
      job->caps[0] = scr_et_dyn_box(listener);
      scr_queue_microtask(job);
    } else {
      st->abort_disposable = true;
      bool ignored = false;
      ScrEventTargetCore *core =
          scr_et_signal_core_fn ? scr_et_signal_core_fn(st->signal, &ignored) : NULL;
      if (core != NULL) {
        ScrStr *abort = scr_str_new("abort", 5);
        bool duplicate;
        (void)scr_et_append(core, abort, listener, SCR_ET_ONCE | SCR_ET_RESIST, &duplicate);
        scr_str_release(abort);
      } else {
        ScrDyn *flags = scr_dyn_new_obj();
        scr_dyn_obj_set(flags, "once", 4, scr_dyn_new_bool(true));
        ScrStr *abort = scr_str_new("abort", 5);
        ScrDyn *key = scr_dyn_new_str(abort);
        scr_str_release(abort);
        ScrDyn *args[3] = {key, listener, flags};
        ScrDyn *result =
            scr_dyn_invoke(st->signal, "addEventListener", args, 3, "signal.addEventListener");
        if (result) scr_dyn_release(result);
        scr_dyn_release(key);
        scr_dyn_release(flags);
      }
      if (scr_exc_pending()) return scr_eon_abandon(st);
    }
  }

  ScrDyn *iterator = scr_eon_iterator(st);
  scr_eon_state_release(st); /* the creator's reference */
  return iterator;
}

/* events.on(emitter, name[, options]) over a checked-dynamic receiver. */
ScrDyn *scr_events_on(ScrDyn *recv, ScrDyn *name, ScrDyn *options) {
  return scr_events_on_impl(NULL, recv, NULL, NULL, name, options);
}

/* events.on(emitter, name[, options]) over a receiver compiled as an
 * emitter: its registry, with the checked-dynamic value for the protocol's
 * other members and the compiler's pause()/resume() method values. */
ScrDyn *scr_events_on_emitter(ScrEmitter *em, ScrDyn *recv, ScrDyn *pause_fn, ScrDyn *resume_fn,
                              ScrDyn *name, ScrDyn *options) {
  return scr_events_on_impl(em, recv, pause_fn, resume_fn, name, options);
}

/* The typed registration a receiver compiled as an emitter needs: its typed
 * emits invoke runtime-built adapters rather than the listeners' checked-
 * dynamic thunks. `boxer`/`error_boxer` (the compiler's tuple-to-array
 * conversions, +1 — consumed here) and the adapter entries built from them
 * are what the main listener and the 'error' handler dispatch through; the
 * close and abort listeners ignore the event's arguments and need none of
 * them. `recv` is the emitter's checked-dynamic value (borrowed). */
ScrDyn *scr_events_on_typed(ScrEmitter *em, ScrDyn *recv, ScrDyn *pause_fn, ScrDyn *resume_fn,
                            ScrDyn *name, ScrClosure *boxer, ScrClosure *error_boxer, void *adapter,
                            ScrEeInvoke inv, void *error_adapter, ScrEeInvoke error_inv,
                            ScrDyn *options) {
  ScrEonState *st = scr_eon_begin(recv, options);
  if (st == NULL) {
    if (boxer) scr_closure_release(boxer);
    if (error_boxer) scr_closure_release(error_boxer);
    return NULL;
  }
  st->reg = SCR_EON_REG_EMITTER;
  st->em = em;
  st->uses_on = true;
  if (pause_fn != NULL && pause_fn->kind != SCR_DYN_UNDEF)
    st->pause_fn = scr_dyn_retain(pause_fn);
  if (resume_fn != NULL && resume_fn->kind != SCR_DYN_UNDEF)
    st->resume_fn = scr_dyn_retain(resume_fn);
  st->boxer = boxer;
  st->error_boxer = error_boxer;
  st->adapter = adapter;
  st->inv = inv;
  st->error_adapter = error_adapter != NULL ? error_adapter : adapter;
  st->error_inv = error_inv;
  if (!scr_eon_name(st, name)) return scr_eon_abandon(st);
  return scr_eon_finish(st, options);
}

/* The event adapter's tail: `args` is the boxed event arguments (+1, moves
 * in) — the iterator's next value itself. */
void scr_events_on_fire(ScrClosure *cb, ScrArr *args) {
  ScrEonState *st = scr_box_get_ref(cb->caps[1]);
  scr_eon_push(st, scr_eon_boxed_args(args));
  scr_eon_state_release(st);
}

/* The 'error' adapter's tail: the boxed arguments (+1, moves in) carry the
 * error the iterator rejects with. */
void scr_events_on_error_fire(ScrClosure *cb, ScrArr *args) {
  ScrEonState *st = scr_box_get_ref(cb->caps[1]);
  ScrDyn *err = scr_arr_get_ref(args, 0);
  scr_arr_release(args);
  scr_eon_on_error(st, err);
  scr_eon_state_release(st);
}
