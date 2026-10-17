/* scriptc runtime — EventTarget, Event and CustomEvent (scr_event_target.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_EVENT_TARGET_H
#define SCR_EVENT_TARGET_H

#include "scr_dyn.h"

/* ── EventTarget / Event / CustomEvent (scr_event_target.c) ───────────
 * Node's internal/event_target over checked-dynamic values. A target's
 * listeners live in a ScrEventTargetCore: per event type, a linked list
 * in registration order whose nodes keep their `next` link after removal,
 * so a dispatch that cached a removed node continues where Node's does.
 * Plain `new EventTarget()` values are SCR_DYNH_EVENT_TARGET handles;
 * AbortSignal embeds a core of its own (MaxListeners 0, the `onabort`
 * event-handler attribute). Events are ScrEvent handles (SCR_DYNH_EVENT,
 * SCR_DYNH_CUSTOM_EVENT for CustomEvent). Listener exceptions, and
 * rejections of a listener's returned promise or of a handleEvent call,
 * are reported as uncaught exceptions from a nextTick, like Node. */
typedef struct ScrEtRoot ScrEtRoot;
typedef struct ScrEtHandler ScrEtHandler;
typedef struct ScrEtHook ScrEtHook;
typedef struct ScrEventTargetCore {
  ScrEtRoot *roots;        /* per event type, in first-add order */
  ScrEtHandler *handlers;  /* event-handler attributes (`onabort`) */
  ScrEtHook *hooks;        /* options.signal removal hooks aimed here (weak) */
  /* A compiled subclass instance's own capsule (+1), kept from its first
   * method call so every later `this` and event target is the same value.
   * The instance holds the core, so this is a cycle the collector reclaims
   * through the scr_event_target_state_* helpers. NULL otherwise. */
  ScrDyn *self;
  double max_listeners;    /* 0 = no leak warning (AbortSignal) */
  bool warned;
  const char *cls;         /* the warning's target name ("EventTarget") */
  bool tracked;            /* in the exit teardown registry */
  struct ScrEventTargetCore *tracked_prev, *tracked_next;
} ScrEventTargetCore;

typedef struct ScrEvent {
  size_t rc;
  ScrStr *type;
  ScrDyn *target;  /* +1, NULL until dispatched */
  ScrDyn *detail;  /* CustomEvent's detail, MessageEvent's data (+1); NULL for Event */
  double time_stamp;
  bool custom, message, bubbles, cancelable, composed, trusted;
  bool default_prevented, propagation_stopped, stop, dispatching, in_passive;
  bool tracked;
  struct ScrEvent *tracked_prev, *tracked_next;
} ScrEvent;

void scr_et_core_init(ScrEventTargetCore *core, double max_listeners, const char *cls);
/* Drops every listener and handler (teardown and target destruction). */
void scr_et_core_drop(ScrEventTargetCore *core);
/* The EventTarget methods over a core: `self` is the target's own dyn
 * value (borrowed — `this` for listeners and the events' target), args
 * borrowed. +1 result, or NULL with the exception pending. */
ScrDyn *scr_et_add_listener(ScrEventTargetCore *core, ScrDyn *const *args, size_t argc);
ScrDyn *scr_et_remove_listener(ScrEventTargetCore *core, ScrDyn *const *args, size_t argc);
ScrDyn *scr_et_dispatch_event(ScrEventTargetCore *core, ScrDyn *self, ScrDyn *const *args, size_t argc);
/* Dispatches an event handle (borrowed) without the argument checks. */
void scr_et_dispatch(ScrEventTargetCore *core, ScrDyn *self, ScrDyn *event);
/* `on<type>` attributes (Node's defineEventHandler): get answers +1 (null
 * when unset); set registers the wrapper listener on first assignment. */
ScrDyn *scr_et_handler_get(ScrEventTargetCore *core, const char *type);
void scr_et_handler_set(ScrEventTargetCore *core, const char *type, const ScrDyn *value);
/* A trusted (isTrusted) Event handle of the given type, +1. */
ScrDyn *scr_event_new_trusted(const char *type);
/* new EventTarget() / new Event(type, options) / new CustomEvent(type,
 * options): `args` is the argument vector as one dyn array (borrowed).
 * +1 handle, or NULL with the exception pending. */
ScrDyn *scr_event_target_new(void);
ScrDyn *scr_event_new(ScrDyn *args);
ScrDyn *scr_custom_event_new(ScrDyn *args);
/* `v instanceof Event` (kind 0), `CustomEvent` (1), `EventTarget` (2). */
bool scr_event_is(const ScrDyn *v, double kind);
/* The AbortSignal unit's view of its handles for options.signal: the
 * signal's core and aborted flag, or NULL for a non-signal value.
 * Installed by the AbortSignal unit; NULL when no signal can exist. */
extern SCR_TL ScrEventTargetCore *(*scr_et_signal_core_fn)(const ScrDyn *d, bool *aborted);
/* The compiled `listener.handleEvent` read (dyn → dyn; the runtime keeps a
 * reference), installed by %main when a program class declares
 * handleEvent: dispatch reads a capsule listener's handleEvent through it,
 * which reaches the class's compiled methods. Without it a capsule's own
 * view answers. */
void scr_event_handle_event_reader(ScrDyn *reader);
/* BroadcastChannel's EventTarget side, which the worker events unit
 * reaches through this table (that unit links without this one): a core
 * of its own, dispatching a 'message' MessageEvent with the data, the
 * EventTarget methods (false: not one of them), and the on<type>
 * attributes. scr_et_broadcast_install sets the table (defined in
 * scr_json.c, which every program links). */
typedef struct {
  ScrEventTargetCore *(*core_new)(const char *cls);
  void (*core_free)(ScrEventTargetCore *core);
  void (*dispatch_message)(ScrEventTargetCore *core, ScrDyn *self, ScrDyn *data);
  bool (*method)(ScrEventTargetCore *core, ScrDyn *self, const char *method, ScrDyn *const *args,
                 size_t argc, ScrDyn **out);
  ScrDyn *(*method_value)(const char *name, size_t length);
  ScrDyn *(*handler_get)(ScrEventTargetCore *core, const char *type);
  void (*handler_set)(ScrEventTargetCore *core, const char *type, const ScrDyn *value);
} ScrEtBroadcastOps;
extern SCR_TL const ScrEtBroadcastOps *scr_et_broadcast_ops;
void scr_et_broadcast_install(void);

/* events.addAbortListener(signal, listener): +1 disposable, or NULL. */
ScrDyn *scr_events_add_abort_listener(ScrDyn *signal, ScrDyn *listener);

/* Compiled subclasses (`class Bus extends EventTarget`, `class Ping
 * extends Event`): an instance lays out like a compiler-emitted hierarchy
 * class (rc, vt, then this prefix, then the subclass fields — the
 * ScrEmitter arrangement). super() creates the engine state behind the
 * prefix pointer; `cls` is the concrete class's name, stamped by the
 * emitted allocation (the leak warning and util.inspect print it). The
 * instances' checked-dynamic capsules carry the RC adapters below, which
 * is how the engine recognizes them: a target's capsule is the `this` of
 * its listeners and the events' target, and an event's capsule is what
 * its listeners receive. */
typedef struct ScrEventTargetObj {
  size_t rc;
  const ScrVt *vt;
  ScrEventTargetCore *core; /* NULL until super() */
  const char *cls;
} ScrEventTargetObj;

typedef struct ScrEventObj {
  size_t rc;
  const ScrVt *vt;
  ScrEvent *ev; /* NULL until super() */
  const char *cls;
} ScrEventObj;

void *scr_event_target_obj_retain_v(void *o);
void scr_event_target_obj_release_v(void *o); /* dispatches through vt */
void *scr_event_obj_retain_v(void *o);
void scr_event_obj_release_v(void *o);
void *scr_event_target_obj_retain(void *o);
void scr_event_target_obj_release(void *o);
void *scr_event_obj_retain(void *o);
void scr_event_obj_release(void *o);
/* super() / super(type, options): `args` is the argument vector as one
 * dyn array (borrowed); a bad type or options value leaves Node's
 * exception pending. */
void scr_event_target_obj_init(void *obj);
void scr_event_obj_init(void *obj, ScrDyn *args);
void scr_event_obj_init_type(void *obj, ScrStr *type); /* super(type), type borrowed */
/* The emitted teardown's and collector's prefix helpers (NULL-tolerant):
 * trace visits the listener values, `on<type>` handlers and the cached
 * capsule of a target, and the target and detail of an event; gcfree
 * frees the state without releasing those traced edges. */
void scr_event_target_state_drop(ScrEventTargetCore *core);
void scr_event_target_state_trace(ScrEventTargetCore *core, ScrTraceVisit visit, void *ctx);
void scr_event_target_state_gcfree(ScrEventTargetCore *core);
void scr_event_state_drop(ScrEvent *ev);
void scr_event_state_trace(ScrEvent *ev, ScrTraceVisit visit, void *ctx);
void scr_event_state_gcfree(ScrEvent *ev);
/* The inherited members on typed receivers: `method`/`key` name an
 * EventTarget or Event member, `args` is the argument vector as one dyn
 * array, `self` the target's own capsule (borrowed). +1 results, or NULL
 * with the exception pending. */
ScrDyn *scr_event_target_obj_call(void *obj, ScrDyn *self, ScrStr *method, ScrDyn *args);
/* dispatchEvent(event): the bool result, false with the exception pending. */
bool scr_event_target_obj_dispatch(void *obj, ScrDyn *self, ScrDyn *event);
ScrDyn *scr_event_obj_call(void *obj, ScrStr *method, ScrDyn *args);
ScrDyn *scr_event_obj_get(void *obj, ScrStr *key);
void scr_event_obj_set(void *obj, ScrStr *key, ScrDyn *value);

/* The same members through a capsule (property reads and writes, method
 * calls, util.inspect, string conversion), installed by the EventTarget
 * unit with its first value and NULL before. get answers +1 or NULL (not
 * an inherited member); set and invoke answer whether they handled the
 * member. */
typedef struct ScrEventRefHooks {
  ScrDyn *(*get)(const ScrDyn *d, const ScrStr *key);
  bool (*set)(ScrDyn *d, const ScrStr *key, const ScrDyn *value);
  bool (*invoke)(ScrDyn *d, const char *method, ScrDyn *const *args, size_t argc,
                 const char *what, ScrDyn **out);
  ScrDyn *(*inspect_view)(const ScrDyn *d, const char **cls);
  /* Object.prototype.toString's answer with the inherited @@toStringTag
   * ("[object EventTarget]", "[object Event]"), or NULL. */
  const char *(*string_tag)(const ScrDyn *d);
} ScrEventRefHooks;
extern SCR_TL const ScrEventRefHooks *scr_event_ref_hooks;

#endif /* SCR_EVENT_TARGET_H */
