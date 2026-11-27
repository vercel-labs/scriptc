/* Checked-dynamic ASYNC surfaces (gated — native-toolchain.ts links this TU only when
 * the IR carries the crossing libCalls or dyn dispatch: the scr_dc.c
 * size-class precedent). Everything here rides scr_async.c's public
 * machinery: the checked-dynamic tree-promise reaction helpers (.then/.catch/.finally
 * over SCR_DYN_PROMISE, await of a checked-dynamic value, the
 * `new Promise(setImmediate)` constructor), the AsyncLocalStorage API
 * over the fiber-carried snapshots (the always-linked core keeps only
 * the active slot + RC pair), the unhandled-rejection listener registry
 * (installed into scr_report_unhandled_rejections' hook at
 * registration), and the process-warning channel (emitWarning + the
 * 'warning' listeners + Node's stderr report). */
#include "scr_runtime.h"
#ifdef SCR_NODE_ISLANDS
#include "scr_node_island.h"
#endif

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <process.h>
#define SCR_WARN_PID() ((long)_getpid())
#else
#include <unistd.h>
#define SCR_WARN_PID() ((long)getpid())
#endif

static void scr_ad_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static SCR_TL double scr_als_counter = 0;

/* The constructor options of each store, indexed by id - 1: the default
 * value getStore() answers where the store has no entry, and the name.
 * NULL until a store with options exists. */
typedef struct {
  ScrDyn *default_value; /* NULL: no default */
  ScrDyn *name;          /* NULL: "" */
} ScrAlsOptions;
static SCR_TL ScrAlsOptions *scr_als_options = NULL;
static SCR_TL size_t scr_als_options_len = 0;

static const ScrAlsOptions *scr_als_options_of(double id) {
  size_t i = (size_t)id - 1;
  return id >= 1 && i < scr_als_options_len ? &scr_als_options[i] : NULL;
}

/* Main-slot teardown (atexit, LIFO after scr_init's audit registration —
 * the dc-registry precedent): a top-level enterWith leaves a context in
 * the main slot at exit; release it before the RC audit counts. */
static void scr_als_teardown(void) {
  /* atexit runs on the main context — the active slot IS main's. */
  scr_als_ctx_release(*SCR_ALS_SLOT());
  *SCR_ALS_SLOT() = NULL;
  for (size_t i = 0; i < scr_als_options_len; i++) {
    scr_dyn_release(scr_als_options[i].default_value);
    scr_dyn_release(scr_als_options[i].name);
  }
  free(scr_als_options);
  scr_als_options = NULL;
  scr_als_options_len = 0;
}

double scr_als_new(void) {
  static SCR_TL bool teardown_registered = false;
  if (!teardown_registered) {
    teardown_registered = true;
    scr_atexit(scr_als_teardown);
  }
  return ++scr_als_counter;
}

/* options[key] as JavaScript reads it (+1, or NULL with the exception
 * pending): inherited properties and getters included. A class instance
 * reads its own fields through its snapshot; a member its class declares
 * (a getter or a method) has no runtime view here and is refused. */
static ScrDyn *scr_als_option(ScrDyn *options, const char *key, size_t key_len) {
  ScrStr *name = scr_str_new(key, key_len);
  if (options->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_class_has(options, name)) {
    char message[160];
    snprintf(message, sizeof message,
             "AsyncLocalStorage options whose class declares '%s' are not supported yet", key);
    scr_str_release(name);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
    return NULL;
  }
  ScrDyn *key_value = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *value = scr_dyn_reflect_get(options, key_value, options);
  scr_dyn_release(key_value);
  if (value == NULL && !scr_exc_pending()) value = scr_dyn_retain(scr_dyn_undefined());
  return value;
}

/* new AsyncLocalStorage(options): Node validates that options is an
 * object, then reads options.defaultValue once and options.name twice
 * (whether it is defined, then its value), keeping String(name). NaN with
 * the exception pending when options is not an object or a read throws. */
double scr_als_new_options(const ScrDyn *options) {
  if (options->kind == SCR_DYN_UNDEF) return scr_als_new();
  if (options->kind != SCR_DYN_OBJ && options->kind != SCR_DYN_TYPED_REF && options->kind != SCR_DYN_PROXY) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NAN;
  }
  ScrDyn *value = scr_als_option((ScrDyn *)options, "defaultValue", 12);
  if (!value) return NAN;
  ScrDyn *name = scr_als_option((ScrDyn *)options, "name", 4);
  if (name && name->kind != SCR_DYN_UNDEF) {
    scr_dyn_release(name);
    name = scr_als_option((ScrDyn *)options, "name", 4);
    if (name && name->kind == SCR_DYN_SYMBOL) {
      static const char message[] = "Cannot convert a Symbol value to a string";
      scr_dyn_release(name);
      name = NULL;
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    } else if (name) {
      ScrStr *text = scr_dyn_string_coerce_js(name);
      scr_dyn_release(name);
      name = text ? scr_dyn_new_str(text) : NULL;
      scr_str_release(text);
    }
  } else {
    scr_dyn_release(name);
    name = scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  }
  if (!name) {
    scr_dyn_release(value);
    return NAN;
  }
  double id = scr_als_new();
  size_t index = (size_t)id - 1;
  if (index >= scr_als_options_len) {
    size_t len = index + 1;
    ScrAlsOptions *grown = realloc(scr_als_options, len * sizeof *grown);
    if (!grown) scr_ad_oom();
    for (size_t i = scr_als_options_len; i < len; i++) grown[i] = (ScrAlsOptions){NULL, NULL};
    scr_als_options = grown;
    scr_als_options_len = len;
  }
  scr_als_options[index].default_value = value; /* the read's +1 moves */
  scr_als_options[index].name = name->kind != SCR_DYN_UNDEF ? name : NULL;
  if (name->kind == SCR_DYN_UNDEF) scr_dyn_release(name);
  return id;
}

/* asyncLocalStorage.name (+1): the constructor's name option, or "". */
ScrDyn *scr_als_name(double id) {
  const ScrAlsOptions *options = scr_als_options_of(id);
  if (options && options->name) return scr_dyn_retain(options->name);
  ScrStr *empty = scr_str_new("", 0);
  ScrDyn *result = scr_dyn_new_str(empty);
  scr_str_release(empty);
  return result;
}

ScrDyn *scr_als_get(double id) {
  const ScrAlsCtx *c = *SCR_ALS_SLOT();
  if (c) {
    for (size_t i = 0; i < c->len; i++) {
      if (c->entries[i].id == id) return scr_dyn_retain(c->entries[i].value);
    }
  }
  const ScrAlsOptions *options = scr_als_options_of(id);
  if (options && options->default_value) return scr_dyn_retain(options->default_value);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The exit() arm: the id REMOVED from the snapshot. */
ScrAlsCtx *scr_als_enter_absent(double id) {
  ScrAlsCtx *prev = *SCR_ALS_SLOT();
  size_t n = prev ? prev->len : 0;
  size_t keep = 0;
  for (size_t i = 0; i < n; i++) {
    if (prev->entries[i].id != id) keep++;
  }
  ScrAlsCtx *next = scr_als_ctx_alloc(keep);
  size_t w = 0;
  for (size_t i = 0; i < n; i++) {
    if (prev->entries[i].id == id) continue;
    next->entries[w].id = prev->entries[i].id;
    next->entries[w].value = scr_dyn_retain(prev->entries[i].value);
    w++;
  }
  *SCR_ALS_SLOT() = next;
  return prev;
}

void scr_als_enter_with(double id, ScrDyn *value) {
  ScrAlsCtx *prev = scr_als_enter(id, value);
  scr_als_ctx_release(prev); /* no restore point — Node's enterWith */
  scr_als_entered_with();
}

void scr_als_disable(double id) {
  ScrAlsCtx *prev = scr_als_enter_absent(id);
  scr_als_ctx_release(prev); /* minimal core: cleared for the current context */
}

/* run(store, fn, ...args) / exit(fn, ...args): enter (or clear), call the
 * dyn function with the forwarded arguments, restore — the finally, so a
 * throw still restores before propagating. Result +1 or NULL pending. */
static ScrDyn *scr_als_call_in(ScrAlsCtx *prev, ScrDyn *fn, ScrDyn *args) {
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  ScrDyn *r = scr_dyn_call(fn, items, argc, "callback");
  scr_als_restore(prev);
  return r;
}

ScrDyn *scr_als_run(double id, ScrDyn *value, ScrDyn *fn, ScrDyn *args) {
  return scr_als_call_in(scr_als_enter(id, value), fn, args);
}

/* exit() runs fn with the store undefined: a store with a default value
 * holds an undefined entry for the call (getStore() answers undefined,
 * not the default, as in Node); other stores drop their entry. */
ScrDyn *scr_als_exit_run(double id, ScrDyn *fn, ScrDyn *args) {
  const ScrAlsOptions *options = scr_als_options_of(id);
  ScrAlsCtx *prev = options && options->default_value
                        ? scr_als_enter(id, scr_dyn_undefined())
                        : scr_als_enter_absent(id);
  return scr_als_call_in(prev, fn, args);
}

/* AsyncLocalStorage.bind(fn) and the dyn completion callbacks of
 * callback-style APIs: a function that calls fn in the context active
 * when it was bound, with its own arguments and receiver. caps[0] holds
 * fn, caps[1] the context, as scr_als_bind_closure lays them out. */
static void *scr_als_ctx_retain_v(void *c) { return scr_als_ctx_retain(c); }
static void scr_als_ctx_release_v(void *c) { scr_als_ctx_release(c); }

static ScrDyn *scr_als_bound_dyn_call(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  ScrDyn *fn = scr_box_get_ref(self->caps[0]);
  ScrAlsCtx *prev = scr_als_bound_enter(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, "callback");
  scr_als_restore(prev);
  scr_dyn_release(fn);
  return result;
}

static ScrClosure *scr_als_context_closure(void *fn, size_t ncaps) {
  ScrClosure *closure = scr_closure_new(fn, ncaps);
  closure->caps[ncaps - 1] = scr_box_new_obj(scr_als_ctx_retain_v, scr_als_ctx_release_v, NULL);
  scr_box_set_ref(closure->caps[ncaps - 1], scr_als_ctx_retain(*SCR_ALS_SLOT()));
  return closure;
}

/* fn borrowed; +1. With `always` false an empty context answers fn
 * itself (the completion-callback form). AsyncLocalStorage.bind throws
 * Node's ERR_INVALID_ARG_TYPE for a non-function. */
ScrDyn *scr_als_bind_dyn(ScrDyn *fn, bool always) {
  if (fn->kind != SCR_DYN_FUNC) {
    if (always) {
      scr_dyn_arg_type_fail("fn", "of type function", fn);
      return NULL;
    }
    return scr_dyn_retain(fn);
  }
  if (!always && *SCR_ALS_SLOT() == NULL) return scr_dyn_retain(fn);
  ScrClosure *closure = scr_als_context_closure(NULL, 2);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_retain(fn));
  return scr_dyn_new_func(closure, scr_als_bound_dyn_call, fn->v.fn.arity, "(...args)", "bound");
}

/* AsyncLocalStorage.snapshot(): a function (cb, ...args) that calls cb
 * with args in the context active at the snapshot. */
static ScrDyn *scr_als_snapshot_call(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  const ScrDyn *cb = argc > 0 ? args[0] : scr_dyn_undefined();
  if (cb->kind != SCR_DYN_FUNC) {
    static const char message[] = "cb is not a function";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrAlsCtx **slot = SCR_ALS_SLOT();
  ScrAlsCtx *prev = *slot;
  *slot = scr_box_get_ref(self->caps[0]); /* the slot owns this reference */
  /* Node applies cb to an undefined receiver, whatever the runner's own. */
  scr_dyn_this_push_dyn(scr_dyn_undefined());
  ScrDyn *result = scr_dyn_call(cb, args + 1, argc - 1, "callback");
  scr_dyn_this_pop();
  scr_als_restore(prev);
  return result;
}

ScrDyn *scr_als_snapshot(void) {
  return scr_dyn_new_func(scr_als_context_closure(NULL, 1), scr_als_snapshot_call, 1, "(cb, ...args)", "bound");
}

/* ── AsyncLocalStorage.withScope (node:async_hooks — RunScope) ────────
 * Node's RunScope keeps the value getStore() answered before the scope
 * (defaultValue included) and a dispose() that enters THAT value again on
 * the same storage — so only this store changes, and a second dispose is
 * a no-op. The store is installed through enterWith's rules (it lasts for
 * the rest of the current callback on the main stack). The scope is a
 * native handle: typeof "object", Object.keys empty, util.inspect prints
 * `RunScope {}`, dispose is a method value, and [Symbol.dispose] answers
 * the same disposal (`using`). */
typedef struct {
  size_t rc;
  double storage;   /* the AsyncLocalStorage handle */
  ScrDyn *previous; /* owned: the effective store getStore() answered */
  bool disposed;
} ScrRunScope;

static void *scr_rs_retain(void *h) {
  ((ScrRunScope *)h)->rc++;
  return h;
}

static void scr_rs_release(void *h) {
  ScrRunScope *s = h;
  if (!s || --s->rc > 0) return;
  scr_dyn_release(s->previous);
  free(s);
}

static void scr_rs_dispose(ScrRunScope *s) {
  if (s->disposed) return;
  s->disposed = true;
  scr_als_enter_with(s->storage, s->previous);
}

static ScrDyn *scr_rs_dispose_value(ScrRunScope *s) {
  scr_rs_dispose(s);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_rs_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  (void)what;
  if (strcmp(method, "dispose") == 0) return scr_rs_dispose_value(h);
  static const char message[] = "RunScope member is not a function: ";
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, message);
  scr_jb_puts(&b, method);
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

static ScrDyn *scr_rs_empty_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

/* `scope[Symbol.dispose]`: Node's RunScope.prototype[Symbol.dispose] calls
 * the instance's dispose; a distinct function from the dispose method
 * value, as in Node. */
static ScrDyn *scr_rs_symbol_dispose_call(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrRunScope *s = scr_box_get_ref(self->caps[0]);
  ScrDyn *result = scr_rs_dispose_value(s);
  scr_rs_release(s);
  return result;
}

static ScrDyn *scr_rs_symbol_get(void *h, const ScrDyn *key) {
  if (!scr_dyn_is_dispose_symbol(key)) return NULL;
  ScrClosure *closure = scr_closure_new(NULL, 1);
  /* The RunScope payload is a plain allocation with no cycle header, so the
   * box treats it as acyclic: a trace here would send the collector through a
   * header that does not exist (memory corruption). */
  closure->caps[0] = scr_box_new_obj(scr_rs_retain, scr_rs_release, NULL);
  scr_box_set_ref(closure->caps[0], scr_rs_retain(h));
  return scr_dyn_new_func(closure, scr_rs_symbol_dispose_call, 0, "()", "[Symbol.dispose]");
}

static const ScrDynHandleMethod scr_rs_methods[] = {{"dispose", 0, false}, {NULL, 0, false}};

static ScrDyn *scr_rs_box(ScrRunScope *s) {
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    static const ScrDynHandleOps ops = {
        .cls = "RunScope",
        .retain = scr_rs_retain,
        .release = scr_rs_release,
        .invoke = scr_rs_invoke,
        .inspect_view = scr_rs_empty_view,
        .json_empty_object = true,
        .inspect_view_empty = true,
        .symbol_get = scr_rs_symbol_get,
        .methods = scr_rs_methods,
    };
    scr_dyn_handle_install(SCR_DYNH_RUN_SCOPE, &ops);
  }
  ScrDyn *box = scr_dyn_new_handle(s, SCR_DYNH_RUN_SCOPE);
  scr_rs_release(s);
  return box;
}

ScrDyn *scr_als_with_scope(double id, ScrDyn *store) {
  ScrRunScope *s = malloc(sizeof *s);
  if (!s) scr_ad_oom();
  s->rc = 1;
  s->storage = id;
  s->previous = scr_als_get(id); /* the effective store (defaultValue too) */
  s->disposed = false;
  scr_als_enter_with(id, store);
  return scr_rs_box(s);
}

/* ── AsyncResource (node:async_hooks) ─────────────────────────────────
 * Node's ids number every async resource from one root: the program's
 * top-level execution is id 1 with trigger id 0. This unit allocates its
 * resources' ids from the core's counter, so they interleave with the
 * tracked timers, immediates, ticks and promises exactly as Node's do. A
 * resource created inside another's scope answers that resource's id as its
 * trigger — the core's execution-id pair is saved and restored around
 * runInAsyncScope, like the context, so executionAsyncId() and
 * triggerAsyncId() answer the resource's ids inside it.
 *
 * Resources are 1-based f64 handles into a process-lived registry (the
 * Channel story): a handle carries no ownership the runtime could watch, so
 * an entry keeps its type and its captured store context until the process
 * exits, where Node releases them with the resource. The limitations page
 * states this. */
typedef struct ScrAsyncResource ScrAsyncResource;

/* executionAsyncResource(): the resource whose runInAsyncScope/bind call is
 * executing; NULL at the top level and inside the runtime's own timer,
 * immediate, tick and promise callbacks, which answer one shared plain
 * object instead of each execution's own resource object. */
static SCR_TL ScrAsyncResource *scr_ar_current_resource = NULL;
static SCR_TL ScrDyn *scr_ar_default_resource = NULL;

/* The hook callbacks the registry (below) keeps; AsyncResource asks for an
 * enabled callback before it runs one, and schedules the destroy that Node
 * emits from a later iteration rather than inside emitDestroy. */
static bool scr_ah_has_enabled_callback(int which);
static void scr_ah_dispatch_init(double id, const char *type, size_t type_len, double trigger,
                                 ScrDyn *resource);
static void scr_ah_dispatch_id(double id, int which);
static void scr_ar_flush_destroy(void);

double scr_ar_execution_id(void) { return scr_async_execution_id(); }

double scr_ar_execution_trigger(void) { return scr_async_execution_trigger(); }

static double scr_ar_next_async_id(void) { return scr_async_next_id(); }

struct ScrAsyncResource {
  size_t rc;
  ScrDyn *type;   /* owned: the validated type string */
  ScrAlsCtx *ctx; /* owned: the store snapshot at construction (NULL: none) */
  double async_id;
  double trigger_id;
  bool destroyed;
  /* Node registers a GC destroy hook for a resource built without
   * requireManualDestroy while destroy hooks exist; this runtime's disposal
   * point is the last reference, which is where that destroy is emitted. */
  bool manual_destroy;
  bool destroy_registered;
  /* The live list, only so the process releases what a program still holds
   * at exit (the resource itself is reclaimed by its last reference). */
  struct ScrAsyncResource *next;
};

static SCR_TL ScrAsyncResource *scr_ar_live = NULL;

static SCR_TL size_t scr_ar_live_count = 0;

/* Live resources: a handle that the program drops must take its payload
 * (type, captured store context) with it. */
size_t scr_ar_live_resources(void) { return scr_ar_live_count; }

static void *scr_ar_retain(void *h);
static void scr_ar_release(void *h);

/* Release what a resource still owns without freeing it: the audit at exit
 * wants every string and context released, and a box released by a later
 * atexit handler still owns the (now empty) struct. */
static void scr_ar_release_payload(ScrAsyncResource *r) {
  if (r->type != NULL) {
    scr_dyn_release(r->type);
    r->type = NULL;
  }
  if (r->ctx != NULL) {
    scr_als_ctx_release(r->ctx);
    r->ctx = NULL;
  }
}

/* Destroy events a resource's emitDestroy queued: Node emits them from a
 * later iteration than the call itself, so the drain runs from a next tick
 * and dispatches to whichever destroy hooks are enabled when it runs. */
static SCR_TL double *scr_ar_destroy_queue = NULL;
static SCR_TL size_t scr_ar_destroy_len = 0, scr_ar_destroy_cap = 0;
static SCR_TL bool scr_ar_destroy_scheduled = false;
/* The exit walk releases every live resource; the automatic destroy must not
 * queue a tick from an atexit handler. */
static SCR_TL bool scr_ar_tearing_down = false;

static void scr_ar_queue_destroy(double id) {
  if (scr_ar_destroy_len == scr_ar_destroy_cap) {
    scr_ar_destroy_cap = scr_ar_destroy_cap ? scr_ar_destroy_cap * 2 : 4;
    scr_ar_destroy_queue = realloc(scr_ar_destroy_queue, scr_ar_destroy_cap * sizeof *scr_ar_destroy_queue);
    if (!scr_ar_destroy_queue) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  scr_ar_destroy_queue[scr_ar_destroy_len++] = id;
  if (!scr_ar_destroy_scheduled) {
    scr_ar_destroy_scheduled = true;
    scr_next_tick_raw(scr_ar_flush_destroy);
  }
}

static void scr_ar_teardown(void);
static SCR_TL bool scr_ar_teardown_registered = false;

static void scr_ar_ensure_teardown(void) {
  if (scr_ar_teardown_registered) return;
  scr_ar_teardown_registered = true;
  scr_atexit(scr_ar_teardown);
}

static void scr_ar_teardown(void) {
  scr_ar_tearing_down = true;
  free(scr_ar_destroy_queue);
  scr_ar_destroy_queue = NULL;
  scr_ar_destroy_len = scr_ar_destroy_cap = 0;
  scr_dyn_release(scr_ar_default_resource);
  scr_ar_default_resource = NULL;
  /* Releasing a resource's captured store can release the resource itself — a
   * store that holds its own resource — which unlinks and frees that entry
   * from inside the release. Hold every entry for the walk, so each release
   * below is the only thing that can free its node, then drop it. */
  scr_cyc_suspend(); /* no collection pass over a half-released snapshot */
  for (ScrAsyncResource *r = scr_ar_live; r != NULL; r = r->next) scr_ar_retain(r);
  for (ScrAsyncResource *r = scr_ar_live; r != NULL;) {
    ScrAsyncResource *next = r->next;
    /* Detach the children before releasing them: a release below can run a
     * collector pass, and the pass must not walk this resource into the
     * snapshot it is in the middle of disposing (its entries are released one
     * by one, and a binding the store holds can release this very resource
     * mid-walk). A pass that misses an edge only over-retains. */
    ScrDyn *type = r->type;
    ScrAlsCtx *ctx = r->ctx;
    r->type = NULL;
    r->ctx = NULL;
    scr_dyn_release(type);
    scr_als_ctx_release(ctx);
    scr_ar_release(r);
    r = next;
  }
  scr_cyc_resume();
}


static void *scr_ar_retain(void *h) {
  ScrAsyncResource *r = h;
  if (r != NULL) r->rc++;
  return h;
}

/* Unlink a resource from the live list. Its last reference calls this once; a
 * collector pass that frees the resource calls it too. */
static void scr_ar_unlink(ScrAsyncResource *r) {
  for (ScrAsyncResource **link = &scr_ar_live; link != NULL && *link != NULL;
       link = &(*link)->next) {
    if (*link == r) {
      *link = r->next;
      break;
    }
  }
  scr_ar_live_count--;
}

/* A resource is a collector object. Its children are the type it was created
 * with and the snapshot it captured; a snapshot's entries are traced as well,
 * so a store that holds a bound callback of a resource that captured that store
 * is one loop the collector can walk and reclaim. A collected resource releases
 * nothing itself — the collector accounted for both children — beyond its
 * live-list entry. */
static void scr_ar_trace(void *o, ScrTraceVisit visit, void *ctx) {
  ScrAsyncResource *r = o;
  visit(r->type, ctx);
  visit(r->ctx, ctx);
}

static void scr_ar_gcfree(void *o) {
  ScrAsyncResource *r = o;
  scr_ar_unlink(r);
  /* A collected resource is disposed like a refcounted one: its registered
   * destroy is queued before the payload goes. */
  if (r->destroy_registered && !r->destroyed && !scr_ar_tearing_down) {
    r->destroyed = true;
    scr_ar_queue_destroy(r->async_id);
  }
  scr_cyc_free(r);
}

static void scr_ar_release(void *h) {
  ScrAsyncResource *r = h;
  if (r == NULL) return;
  if (--r->rc != 0) {
    scr_cyc_released(r); /* possible cycle root; may collect — r is done */
    return;
  }
  scr_cyc_dead(r);
  scr_ar_unlink(r);
  /* The last reference going away is this runtime's disposal point, so the
   * destroy a registered GC hook would emit for Node fires here (unless an
   * explicit emitDestroy already queued one, or the process is tearing
   * down). */
  if (r->destroy_registered && !r->destroyed && !scr_ar_tearing_down) {
    r->destroyed = true;
    scr_ar_queue_destroy(r->async_id);
  }
  scr_ar_release_payload(r);
  scr_cyc_free(r);
}

/* The resource behind a handle box. A value asserted past the type can carry
 * anything, so a value that is not a live resource handle answers NULL and
 * the member that needed it raises Node's argument error. */
static ScrDyn *scr_ar_box(ScrAsyncResource *r);

static ScrAsyncResource *scr_ar_payload(const ScrDyn *h) {
  if (h == NULL || h->kind != SCR_DYN_HANDLE || h->v.handle.tag != SCR_DYNH_ASYNC_RESOURCE)
    return NULL;
  return (ScrAsyncResource *)h->v.handle.ptr;
}

/* NumberIsSafeInteger: a finite integer within ±(2^53 - 1). */
static bool scr_ar_safe_integer(double v) {
  return isfinite(v) && v == floor(v) && fabs(v) <= 9007199254740991.0;
}

/* ERR_INVALID_ASYNC_ID's value text: a string prints bare and the scalars
 * as String() renders them (Node's template shows primitives that way); an
 * object renders as the dyn core's inspect bracket sketch, which is the
 * only rendering available without linking the inspect unit. */
static void scr_ar_put_value(ScrJsonBuf *b, const ScrDyn *v) {
  if (v->kind == SCR_DYN_STR) {
    scr_jb_put_str(b, v->v.str);
    return;
  }
  char detail[64];
  scr_jb_puts(b, scr_dyn_inspect_lite(v, detail, sizeof detail));
}

static void scr_ar_invalid_trigger(const ScrDyn *value) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Invalid triggerAsyncId value: ");
  scr_ar_put_value(&b, value);
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message->data, message->len, "ERR_INVALID_ASYNC_ID");
  scr_str_release(message);
}

static void scr_ar_invalid_trigger_number(double value) {
  char text[40];
  size_t len = scr_f64_to_str(value, text);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Invalid triggerAsyncId value: ");
  scr_jb_write(&b, text, len);
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message->data, message->len, "ERR_INVALID_ASYNC_ID");
  scr_str_release(message);
}

/* V8's TypeError for ReflectApply on a value that is not callable —
 * runInAsyncScope's and a bound function's check, verbatim. */
static void scr_ar_apply_type_error(const ScrDyn *fn) {
  const char *kind;
  switch (fn->kind) {
  case SCR_DYN_NULL: kind = "null"; break;
  case SCR_DYN_UNDEF: kind = "a undefined"; break;
  case SCR_DYN_NUM: kind = "a number"; break;
  case SCR_DYN_STR: kind = "a string"; break;
  case SCR_DYN_BOOL: kind = "a boolean"; break;
  case SCR_DYN_SYMBOL: kind = "a symbol"; break;
  case SCR_DYN_BIGINT: kind = "a bigint"; break;
  default: kind = "an object"; break;
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Function.prototype.apply was called on ");
  switch (fn->kind) {
  case SCR_DYN_NULL: scr_jb_puts(&b, "null"); break;
  case SCR_DYN_UNDEF: scr_jb_puts(&b, "undefined"); break;
  case SCR_DYN_NUM: {
    char buf[40];
    size_t n = scr_f64_to_str(fn->v.num, buf);
    scr_jb_write(&b, buf, n);
    break;
  }
  case SCR_DYN_STR: scr_jb_put_str(&b, fn->v.str); break;
  case SCR_DYN_BOOL: scr_jb_puts(&b, fn->v.b ? "true" : "false"); break;
  case SCR_DYN_ARR: scr_jb_puts(&b, "[object Array]"); break;
  default: scr_jb_puts(&b, "#<Object>"); break;
  }
  scr_jb_puts(&b, ", which is ");
  scr_jb_puts(&b, kind);
  scr_jb_puts(&b, " and not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

/* new AsyncResource(type[, opts]): Node's checks in its order — `type`
 * first, then the trigger (a number opts is the legacy trigger form; an
 * object reads triggerAsyncId, defaulting to executionAsyncId(), and
 * requireManualDestroy). The resource is a checked-dynamic handle whose
 * payload is refcounted: dropping the last reference to the value releases
 * the type and the captured store context, so a program that creates
 * resources per request does not grow for the life of the process. */
ScrDyn *scr_ar_new(ScrDyn *type, ScrDyn *options) {
  if (type->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("type", "of type string", type);
    return NULL;
  }
  double trigger = scr_async_execution_id();
  bool manual_destroy = false;
  if (options != NULL && options->kind != SCR_DYN_UNDEF) {
    if (options->kind == SCR_DYN_NUM) {
      trigger = options->v.num;
    } else {
      ScrStr *key_name = scr_str_new("triggerAsyncId", 14);
      ScrDyn *key = scr_dyn_new_str(key_name);
      scr_str_release(key_name);
      ScrDyn *value = scr_dyn_reflect_get(options, key, options);
      scr_dyn_release(key);
      if (value == NULL) return NULL; /* pending: a null receiver's read */
      /* Node reads requireManualDestroy before it validates the trigger,
       * so a throwing getter here answers before the trigger's error. */
      ScrStr *manual_name = scr_str_new("requireManualDestroy", 20);
      ScrDyn *manual_key = scr_dyn_new_str(manual_name);
      scr_str_release(manual_name);
      ScrDyn *manual = scr_dyn_reflect_get(options, manual_key, options);
      scr_dyn_release(manual_key);
      if (manual == NULL) {
        scr_dyn_release(value);
        return NULL;
      }
      manual_destroy = scr_dyn_truthy(manual);
      scr_dyn_release(manual);
      if (value->kind == SCR_DYN_UNDEF) trigger = scr_async_execution_id();
      else if (value->kind == SCR_DYN_NUM) trigger = value->v.num;
      if ((value->kind != SCR_DYN_UNDEF && value->kind != SCR_DYN_NUM) ||
          !scr_ar_safe_integer(trigger) || trigger < -1) {
        scr_ar_invalid_trigger(value);
        scr_dyn_release(value);
        return NULL;
      }
      scr_dyn_release(value);
    }
  }
  /* The legacy numeric options form takes the same trigger check. */
  if (!scr_ar_safe_integer(trigger) || trigger < -1) {
    scr_ar_invalid_trigger_number(trigger);
    return NULL;
  }
  /* Node refuses an empty type only while an init hook is enabled
   * (ERR_ASYNC_TYPE), so a program that creates one with no hooks keeps
   * it. */
  if (type->v.str->len == 0 && scr_ah_has_enabled_callback(0)) {
    static const char message[] = "Invalid name for async \"type\": ";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_ASYNC_TYPE");
    return NULL;
  }
  scr_ar_ensure_teardown();
  static ScrCycType cyc_type = {&scr_ar_trace, &scr_ar_gcfree, SCR_CYC_KIND_NONE};
  ScrAsyncResource *r = scr_cyc_alloc(sizeof *r, &cyc_type);
  if (!r) scr_ad_oom();
  r->rc = 1;
  r->type = scr_dyn_retain(type);
  r->ctx = scr_als_capture();
  r->async_id = scr_ar_next_async_id();
  r->trigger_id = trigger;
  r->destroyed = false;
  r->manual_destroy = manual_destroy;
  r->destroy_registered = false;
  r->next = scr_ar_live;
  scr_ar_live = r;
  scr_ar_live_count++;
  ScrDyn *box = scr_ar_box(r);
  /* Node fires init at construction, before the constructor answers, with
   * the resource itself as the fourth argument. */
  scr_ah_dispatch_init(r->async_id, type->v.str->data, type->v.str->len, r->trigger_id, box);
  /* Node registers its GC destroy hook for a resource built while destroy
   * hooks exist unless requireManualDestroy asked otherwise, and it does so
   * after emitInit: a hook enabled by an init callback counts, and a
   * throwing init skips the registration. */
  if (!scr_exc_pending())
    r->destroy_registered = !manual_destroy && scr_ah_has_enabled_callback(3);
  return box;
}

/* The call inside a resource's scope: its store snapshot and ids for the
 * synchronous extent, restored afterwards (the finally — a throw still
 * restores). The core's execution-id pair makes executionAsyncId() and
 * triggerAsyncId() answer the resource's ids, the before/after hooks bracket
 * the call, and executionAsyncResource() answers the resource. */
static ScrDyn *scr_ar_call_in_scope(ScrAsyncResource *r, ScrDyn *fn, ScrDyn *this_arg,
                                    ScrDyn *const *args, size_t argc) {
  ScrAsyncExecState prev_exec = scr_async_exec_enter(r->async_id, r->trigger_id);
  ScrAsyncResource *prev_resource = scr_ar_current_resource;
  scr_ar_current_resource = r;
  scr_ah_dispatch_id(r->async_id, 0); /* before */
  ScrDyn *result = NULL;
  bool entered = !scr_exc_pending(); /* a throwing before hook skips the call */
  if (entered) {
    ScrAlsCtx *prev_ctx = scr_als_dispatch_enter(r->ctx);
    scr_dyn_this_push_dyn(this_arg);
    result = scr_dyn_call(fn, args, argc, "fn");
    scr_dyn_this_pop();
    scr_als_dispatch_leave(prev_ctx);
  }
  if (entered) scr_ah_dispatch_id(r->async_id, 1); /* after */
  scr_ar_current_resource = prev_resource;
  scr_async_exec_leave(prev_exec);
  return result;
}

ScrDyn *scr_ar_run_in_scope(ScrDyn *handle, ScrDyn *fn, ScrDyn *this_arg, ScrDyn *args) {
  ScrAsyncResource *r = scr_ar_payload(handle);
  if (r == NULL) {
    if (!scr_exc_pending()) scr_dyn_arg_type_fail("this", "an instance of AsyncResource", handle);
    return NULL;
  }
  if (!scr_dyn_is_callable(fn)) {
    scr_ar_apply_type_error(fn);
    return NULL;
  }
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  return scr_ar_call_in_scope(r, fn, this_arg, items, argc);
}

/* The bound function: caps[0] the function (owned), caps[1] its receiver
 * (owned; an absent receiver is the undefined value), caps[2] the resource
 * handle (owned). Node names the result "bound", or "bound runInAsyncScope"
 * when the receiver is given, and gives it the bound function's length. Its
 * no-receiver form is a plain function Node calls with the receiver the
 * bound function was INVOKED with (ArrayPrototypeUnshift(args, fn, this)),
 * so `obj.f()` runs fn with `this` === obj; the receiver-given form always
 * runs it with that receiver instead. */
static ScrDyn *scr_ar_bound_call(ScrClosure *self, ScrDyn *const *args, size_t argc) {
  ScrDyn *fn = scr_box_get_ref(self->caps[0]);
  ScrDyn *this_arg = scr_box_get_ref(self->caps[1]);
  ScrAsyncResource *r = scr_box_get_ref(self->caps[2]);
  ScrDyn *result = NULL;
  if (!scr_dyn_is_callable(fn)) {
    scr_ar_apply_type_error(fn);
  } else if (r != NULL) {
    ScrDyn *call_this = this_arg->kind == SCR_DYN_UNDEF ? scr_dyn_this_get() : NULL;
    result = scr_ar_call_in_scope(r, fn, call_this != NULL ? call_this : this_arg, args, argc);
    if (call_this != NULL) scr_dyn_release(call_this);
  }
  scr_dyn_release(fn);
  scr_dyn_release(this_arg);
  /* scr_box_get_ref hands out its own reference; the call only borrowed the
   * payload, so the bound function holds exactly the box's one. */
  scr_ar_release(r);
  return result;
}

static ScrDyn *scr_ar_make_bound(ScrDyn *handle, ScrDyn *fn, ScrDyn *this_arg) {
  ScrClosure *closure = scr_closure_new(NULL, 3);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_retain(fn));
  closure->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[1], scr_dyn_retain(this_arg));
  /* The bound function owns the resource payload itself (retained by the
   * box), not a dynamic handle value: no dyn value is left behind for the
   * exit audit to find, and the payload's context is released at exit. */
  closure->caps[2] = scr_box_new_obj(scr_ar_retain, scr_ar_release, scr_ar_trace);
  scr_box_set_ref(closure->caps[2], scr_ar_retain(scr_ar_payload(handle)));
  uint32_t arity = fn->kind == SCR_DYN_FUNC ? fn->v.fn.arity : 0;
  const char *name = this_arg->kind == SCR_DYN_UNDEF ? "bound" : "bound runInAsyncScope";
  return scr_dyn_new_func(closure, scr_ar_bound_call, arity, "(...args)", name);
}

ScrDyn *scr_ar_bind(ScrDyn *handle, ScrDyn *fn, ScrDyn *this_arg) {
  if (!scr_dyn_is_callable(fn)) {
    scr_dyn_arg_type_fail("fn", "of type function", fn);
    return NULL;
  }
  if (scr_ar_payload(handle) == NULL) {
    if (!scr_exc_pending()) scr_dyn_arg_type_fail("this", "an instance of AsyncResource", handle);
    return NULL;
  }
  return scr_ar_make_bound(handle, fn, this_arg);
}

ScrDyn *scr_ar_bind_static(ScrDyn *fn, ScrDyn *type, ScrDyn *this_arg) {
  ScrDyn *chosen = NULL;
  bool owned = false;
  if (scr_dyn_truthy(type)) {
    chosen = type;
  } else if (fn->kind == SCR_DYN_NULL) {
    /* Node reads fn.name before it validates fn: a null one throws the
     * property read, not the argument check. */
    static const char message[] = "Cannot read properties of null (reading 'name')";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  } else {
    const char *name = fn->kind == SCR_DYN_FUNC ? fn->v.fn.name : NULL;
    ScrStr *text = name && name[0] ? scr_str_new(name, strlen(name))
                                   : scr_str_new("bound-anonymous-fn", 18);
    chosen = scr_dyn_new_str(text);
    scr_str_release(text);
    owned = true;
  }
  ScrDyn *handle = scr_ar_new(chosen, NULL);
  if (owned) scr_dyn_release(chosen);
  if (handle == NULL) return NULL;
  ScrDyn *bound = scr_ar_bind(handle, fn, this_arg);
  scr_dyn_release(handle);
  return bound;
}

ScrDyn *scr_ar_emit_destroy(ScrDyn *handle) {
  ScrAsyncResource *r = scr_ar_payload(handle);
  if (r != NULL && !r->destroyed) {
    /* Node's emitDestroy marks the resource destroyed and fires the destroy
     * hook; it keeps the captured store context, so a runInAsyncScope call or
     * a bound callback made after the destroy still runs inside the resource's
     * stores. The context is released with the resource itself — when the
     * value and every binding that holds it are gone, or at exit — so a
     * per-request resource stops holding its request's stores as soon as the
     * program drops it. A second destroy is a no-op. */
    r->destroyed = true;
    if (scr_ah_has_enabled_callback(3)) scr_ar_queue_destroy(r->async_id);
  }
  return scr_dyn_retain(handle);
}

/* executionAsyncResource(): the resource whose scope is executing (a fresh
 * handle box for the same payload — handle identity is payload identity), or
 * the shared plain object outside such a scope. */
ScrDyn *scr_ar_execution_resource(void) {
  /* scr_ar_box takes ownership of one reference; the current resource is
   * borrowed from the scope that installed it, so retain it for the box. */
  if (scr_ar_current_resource != NULL) {
    scr_ar_retain(scr_ar_current_resource);
    return scr_ar_box(scr_ar_current_resource);
  }
  scr_ar_ensure_teardown();
  if (scr_ar_default_resource == NULL) scr_ar_default_resource = scr_dyn_new_obj();
  return scr_dyn_retain(scr_ar_default_resource);
}

double scr_ar_async_id(ScrDyn *handle) {
  ScrAsyncResource *r = scr_ar_payload(handle);
  return r != NULL ? r->async_id : NAN;
}

double scr_ar_trigger_id(ScrDyn *handle) {
  ScrAsyncResource *r = scr_ar_payload(handle);
  return r != NULL ? r->trigger_id : NAN;
}

static const ScrDynHandleMethod scr_ar_methods[] = {{"runInAsyncScope", 0, false},
                                                    {"bind", 0, false},
                                                    {"emitDestroy", 0, false},
                                                    {"asyncId", 0, false},
                                                    {"triggerAsyncId", 0, false},
                                                    {NULL, 0, false}};

static ScrDyn *scr_ar_empty_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

/* Dynamic member calls (`resource.runInAsyncScope(...)` on a value the
 * program holds as checked-dynamic): the same helpers the lowered calls
 * use. */
static ScrDyn *scr_ar_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what) {
  ScrAsyncResource *r = h;
  (void)what;
  if (strcmp(method, "runInAsyncScope") == 0 && argc >= 1) {
    /* The dynamic call takes the same checks as the lowered one: Node's
     * own apply error for a value that is not a function. */
    if (!scr_dyn_is_callable(args[0])) {
      scr_ar_apply_type_error(args[0]);
      return NULL;
    }
    ScrDyn *args_array = scr_dyn_new_arr();
    for (size_t i = 2; i < argc; i++) scr_dyn_arr_push(args_array, scr_dyn_retain(args[i]));
    ScrDyn *result = scr_ar_call_in_scope(
        r, args[0], argc >= 2 ? args[1] : scr_dyn_undefined(), args_array->v.arr.items,
        args_array->v.arr.len);
    scr_dyn_release(args_array);
    return result;
  }
  if (strcmp(method, "bind") == 0 && argc >= 1) {
    /* bind validates the function at the call, as the lowered form does. */
    if (!scr_dyn_is_callable(args[0])) {
      scr_dyn_arg_type_fail("fn", "of type function", args[0]);
      return NULL;
    }
    return scr_ar_make_bound(self, args[0], argc >= 2 ? args[1] : scr_dyn_undefined());
  }
  if (strcmp(method, "emitDestroy") == 0) return scr_dyn_retain(self);
  if (strcmp(method, "asyncId") == 0) return scr_dyn_new_num(r->async_id);
  if (strcmp(method, "triggerAsyncId") == 0) return scr_dyn_new_num(r->trigger_id);
  static const char message[] = "AsyncResource member is not a function: ";
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, message);
  scr_jb_puts(&b, method);
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

static ScrDyn *scr_ar_box(ScrAsyncResource *r) {
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    static const ScrDynHandleOps ops = {
        .cls = "AsyncResource",
        .retain = scr_ar_retain,
        .release = scr_ar_release,
        .invoke = scr_ar_invoke,
        .inspect_view = scr_ar_empty_view,
        .json_empty_object = true,
        .inspect_view_empty = true,
        .methods = scr_ar_methods,
    };
    scr_dyn_handle_install(SCR_DYNH_ASYNC_RESOURCE, &ops);
  }
  ScrDyn *box = scr_dyn_new_handle(r, SCR_DYNH_ASYNC_RESOURCE);
  scr_ar_release(r);
  return box;
}


/* The two rejection-event registries share one shape: listeners with a
 * `once` flag (auto-removed after one delivery, Node's once) and
 * identity-based removal (the offWarning stance). */
typedef struct {
  size_t refs;
  bool fired;
} ScrRejState;

typedef struct {
  ScrDyn *fn;
  bool once;
  uint64_t id;
  ScrRejState *state; /* snapshots share the once-fired state */
} ScrRejListener;

static void scr_rej_release(ScrRejListener *l) {
  scr_dyn_release(l->fn);
  if (--l->state->refs == 0) free(l->state);
}

static SCR_TL uint64_t scr_rej_id = 0;

static SCR_TL ScrRejListener *scr_urj_listeners = NULL;
static SCR_TL size_t scr_nurj = 0, scr_urj_cap = 0;
static SCR_TL ScrRejListener *scr_rjh_listeners = NULL;
static SCR_TL size_t scr_nrjh = 0, scr_rjh_cap = 0;

static void scr_urj_teardown(void) {
  for (size_t i = 0; i < scr_nurj; i++) scr_rej_release(&scr_urj_listeners[i]);
  free(scr_urj_listeners);
  scr_urj_listeners = NULL;
  scr_nurj = scr_urj_cap = 0;
}

static void scr_rjh_teardown(void) {
  for (size_t i = 0; i < scr_nrjh; i++) scr_rej_release(&scr_rjh_listeners[i]);
  free(scr_rjh_listeners);
  scr_rjh_listeners = NULL;
  scr_nrjh = scr_rjh_cap = 0;
}

static bool scr_urj_dispatch(ScrPromise *p);
static void scr_rjh_dispatch(ScrPromise *p);

/* Node's ERR_INVALID_ARG_TYPE for a non-function listener; true when the
 * value is fine. */
static bool scr_rej_check_listener(ScrDyn *fn) {
  if (fn->kind == SCR_DYN_FUNC) return true;
  const char *msg = "The \"listener\" argument must be of type function";
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
  return false;
}

static void scr_rej_push(ScrRejListener **list, size_t *n, size_t *cap, ScrDyn *fn, bool once) {
  if (*n == *cap) {
    *cap = *cap ? *cap * 2 : 4;
    *list = realloc(*list, *cap * sizeof **list);
    if (!*list) scr_ad_oom();
  }
  ScrRejState *state = calloc(1, sizeof *state);
  if (!state) scr_ad_oom();
  state->refs = 1;
  (*list)[(*n)++] = (ScrRejListener){scr_dyn_retain(fn), once, ++scr_rej_id, state};
}

static void scr_rej_remove(ScrRejListener *list, size_t *n, ScrDyn *fn) {
  for (size_t left = *n; left > 0; left--) {
    size_t i = left - 1;
    ScrDyn *l = list[i].fn;
    bool same = l == fn || (l->kind == SCR_DYN_FUNC && fn->kind == SCR_DYN_FUNC &&
                            scr_dyn_strict_eq(l, fn));
    if (same) {
      scr_rej_release(&list[i]);
      memmove(list + i, list + i + 1, (*n - i - 1) * sizeof *list);
      (*n)--;
      return;
    }
  }
}

#ifdef SCR_NODE_ISLANDS
/* A program with Node islands has one list of listeners for these events.
 * Until Node is loaded it is the registries of this unit. Once Node is
 * loaded it is Node's `process` (scr_node_island_events.c):
 * scr_process_events_to_node moves the listeners there in their order, and
 * from then on every registration, removal and prepend below goes to
 * `process`, and errors, rejections and warnings are raised through it.
 * The move waits for a dispatch of this unit that is in progress (Node
 * started inside a listener): that dispatch finishes over the lists it
 * began with. */
static SCR_TL bool scr_pe_node = false;
static SCR_TL bool scr_pe_wanted = false;
static SCR_TL unsigned scr_pe_dispatching = 0;
static void scr_pe_move_all(void);

/* process.on (0), once (1), prependListener (2), removeListener (3),
 * prependOnceListener (4) on Node's `process`; false while this unit's
 * registries are the list. */
static bool scr_pe_listen(int mode, const char *event, ScrDyn *fn) {
  if (!scr_pe_node) return false;
  scr_ni_process_listen(mode, event, fn);
  return true;
}
#define SCR_PE_ENTER() (scr_pe_dispatching++)
#define SCR_PE_LEAVE()                                           \
  do {                                                           \
    if (--scr_pe_dispatching == 0 && scr_pe_wanted) scr_pe_move_all(); \
  } while (0)
#else
#define scr_pe_listen(mode, event, fn) false
#define SCR_PE_ENTER() ((void)0)
#define SCR_PE_LEAVE() ((void)0)
#endif

/* The hooks arm exactly while their registry is non-empty: Node with
 * every listener removed (off, or once-consumed) reverts to the default
 * report/silence, and the report loop consults the hook per promise. */
static void scr_urj_sync_hook(void) {
  scr_urj_deliver_fn = scr_nurj > 0 ? scr_urj_dispatch : NULL;
}

static void scr_rjh_sync_hook(void) {
#ifdef SCR_NODE_ISLANDS
  if (scr_pe_node) return; /* Node tracks the handled rejections */
#endif
  scr_rjh_notify_fn = scr_nrjh > 0 ? scr_rjh_dispatch : NULL;
}

void scr_process_on_unhandled_rejection(ScrDyn *fn, bool once) {
  if (!scr_rej_check_listener(fn)) return;
  if (scr_pe_listen(once ? 1 : 0, "unhandledRejection", fn)) return;
  static SCR_TL bool teardown_armed = false;
  if (!teardown_armed) {
    teardown_armed = true;
    scr_atexit(scr_urj_teardown);
  }
  scr_rej_push(&scr_urj_listeners, &scr_nurj, &scr_urj_cap, fn, once);
  scr_urj_sync_hook();
}

void scr_process_off_unhandled_rejection(ScrDyn *fn) {
  if (scr_pe_listen(3, "unhandledRejection", fn)) return;
  scr_rej_remove(scr_urj_listeners, &scr_nurj, fn);
  scr_urj_sync_hook();
}

void scr_process_on_rejection_handled(ScrDyn *fn, bool once) {
  if (!scr_rej_check_listener(fn)) return;
  if (scr_pe_listen(once ? 1 : 0, "rejectionHandled", fn)) return;
  static SCR_TL bool teardown_armed = false;
  if (!teardown_armed) {
    teardown_armed = true;
    scr_atexit(scr_rjh_teardown);
  }
  scr_rej_push(&scr_rjh_listeners, &scr_nrjh, &scr_rjh_cap, fn, once);
  scr_rjh_sync_hook();
}

void scr_process_off_rejection_handled(ScrDyn *fn) {
  if (scr_pe_listen(3, "rejectionHandled", fn)) return;
  scr_rej_remove(scr_rjh_listeners, &scr_nrjh, fn);
  scr_rjh_sync_hook();
}

/* Snapshot dispatch preserves EventEmitter mutation rules: removals do
 * not skip a pending listener, additions wait for the next delivery, and
 * once entries leave the live list before invoking user code. */
static bool scr_rej_fire(ScrRejListener **list, size_t *n, ScrDyn **args, size_t argc) {
  size_t count = *n;
  ScrRejListener *snap = count ? malloc(count * sizeof *snap) : NULL;
  if (count && !snap) scr_ad_oom();
  for (size_t i = 0; i < count; i++) {
    snap[i] = (*list)[i];
    scr_dyn_retain(snap[i].fn);
    snap[i].state->refs++;
  }
  bool ok = true;
  for (size_t i = 0; i < count; i++) {
    if (ok && !(snap[i].once && snap[i].state->fired)) {
      if (snap[i].once) {
        snap[i].state->fired = true;
        for (size_t j = 0; j < *n; j++) {
          if ((*list)[j].id == snap[i].id) {
            scr_rej_release(&(*list)[j]);
            memmove(*list + j, *list + j + 1, (*n - j - 1) * sizeof **list);
            (*n)--;
            break;
          }
        }
      }
      ScrDyn *r = scr_dyn_call(snap[i].fn, args, argc, "listener");
      ok = !scr_exc_pending();
      scr_dyn_release(r);
    }
    scr_rej_release(&snap[i]);
  }
  free(snap);
  return ok;
}

/* Uncaught exception listeners share the checked-dynamic callback ABI.
 * Monitors run first but do not handle the exception by themselves. */
static SCR_TL ScrRejListener *scr_uncaught_ls[2];
static SCR_TL size_t scr_uncaught_n[2], scr_uncaught_cap[2];
static int scr_uncaught_dispatch(bool from_promise);
static void scr_uncaught_sync_hook(void);

/* process.setUncaughtExceptionCaptureCallback's callback: when set, it
 * handles every uncaught exception INSTEAD of the 'uncaughtException'
 * listeners (after the monitors), and its own throw is the fatal error. */
static SCR_TL ScrDyn *scr_capture_fn = NULL;

static void scr_capture_teardown(void) {
  scr_dyn_release(scr_capture_fn);
  scr_capture_fn = NULL;
}

bool scr_process_has_uncaught_capture(void) { return scr_capture_fn != NULL; }

/* node:internal/process/execution's setUncaughtExceptionCaptureCallback:
 * null clears (checked first, so it never validates); anything that is not
 * a function throws ERR_INVALID_ARG_TYPE; a second callback while one is
 * active throws ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET. */
void scr_process_set_uncaught_capture(ScrDyn *fn) {
  if (fn->kind == SCR_DYN_NULL) {
    scr_dyn_release(scr_capture_fn);
    scr_capture_fn = NULL;
    scr_uncaught_sync_hook();
    return;
  }
  if (!scr_dyn_is_callable(fn)) {
    scr_dyn_arg_type_fail("fn", "of type function or null", fn);
    return;
  }
  if (scr_capture_fn != NULL) {
    static const char msg[] =
        "`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1,
                             "ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET");
    return;
  }
  static SCR_TL bool armed = false;
  if (!armed) {
    armed = true;
    scr_atexit(scr_capture_teardown);
  }
  scr_capture_fn = scr_dyn_retain(fn);
  scr_uncaught_sync_hook();
}

static void scr_uncaught_sync_hook(void) {
#ifdef SCR_NODE_ISLANDS
  if (scr_pe_node) return; /* the hook raises through Node's process */
#endif
  scr_uncaught_exception_hook = (scr_uncaught_n[0] || scr_uncaught_n[1] || scr_capture_fn)
                                    ? scr_uncaught_dispatch
                                    : NULL;
}

static void scr_uncaught_teardown(void) {
  for (size_t k = 0; k < 2; k++) {
    for (size_t i = 0; i < scr_uncaught_n[k]; i++) scr_rej_release(&scr_uncaught_ls[k][i]);
    free(scr_uncaught_ls[k]);
    scr_uncaught_ls[k] = NULL;
    scr_uncaught_n[k] = scr_uncaught_cap[k] = 0;
  }
  scr_uncaught_sync_hook();
}

#define SCR_UNCAUGHT_EVENT(monitor) ((monitor) ? "uncaughtExceptionMonitor" : "uncaughtException")

void scr_process_on_uncaught_exception(ScrDyn *fn, bool once, bool monitor) {
  if (!scr_rej_check_listener(fn)) return;
  if (scr_pe_listen(once ? 1 : 0, SCR_UNCAUGHT_EVENT(monitor), fn)) return;
  static SCR_TL bool armed = false;
  if (!armed) { armed = true; scr_atexit(scr_uncaught_teardown); }
  size_t k = monitor ? 1 : 0;
  scr_rej_push(&scr_uncaught_ls[k], &scr_uncaught_n[k], &scr_uncaught_cap[k], fn, once);
  scr_uncaught_sync_hook();
}

#ifdef SCR_PROCESS_EXTRAS
/* process.prependListener("uncaughtException"[Monitor], fn): the same
 * listener in FRONT of the registry's existing entries (Node's
 * EventEmitter order). The append path above registers it and the new entry
 * then moves to the front, so the two share one registration; a refused
 * listener (a non-function) left the list alone and nothing moves. */
void scr_process_prepend_uncaught_exception(ScrDyn *fn, bool monitor) {
#ifdef SCR_NODE_ISLANDS
  if (scr_pe_node) {
    if (scr_rej_check_listener(fn)) scr_ni_process_listen(2, SCR_UNCAUGHT_EVENT(monitor), fn);
    return;
  }
#endif
  size_t k = monitor ? 1 : 0;
  size_t before = scr_uncaught_n[k];
  scr_process_on_uncaught_exception(fn, false, monitor);
  if (scr_uncaught_n[k] != before + 1) return;
  ScrRejListener entry = scr_uncaught_ls[k][scr_uncaught_n[k] - 1];
  memmove(scr_uncaught_ls[k] + 1, scr_uncaught_ls[k],
          (scr_uncaught_n[k] - 1) * sizeof *scr_uncaught_ls[k]);
  scr_uncaught_ls[k][0] = entry;
}
#endif

void scr_process_off_uncaught_exception(ScrDyn *fn, bool monitor) {
  if (!scr_rej_check_listener(fn)) return;
  if (scr_pe_listen(3, SCR_UNCAUGHT_EVENT(monitor), fn)) return;
  size_t k = monitor ? 1 : 0;
  scr_rej_remove(scr_uncaught_ls[k], &scr_uncaught_n[k], fn);
  scr_uncaught_sync_hook();
}

/* V8's side-effect-free string of a value, which Node's
 * UnhandledPromiseRejection message quotes: primitives as String() gives
 * them, a symbol as Symbol(description), an array as [object Array], an
 * object with its own toString as [object Object], and other objects as
 * #<Constructor>. */
static bool scr_rejection_custom_to_string(const ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrStr *key = scr_str_new("toString", 8);
    bool found = scr_dyn_typed_ref_class_has(value, key);
    scr_str_release(key);
    return found;
  }
  for (const ScrDyn *p = value; p; p = p->prototype)
    if (p->kind == SCR_DYN_OBJ && scr_dyn_obj_get(p, "toString", 8)) return true;
  return false;
}

static ScrStr *scr_rejection_reason_text(const ScrDyn *reason, const ScrDyn *view) {
  switch (view->kind) {
  case SCR_DYN_UNDEF: return scr_str_new("undefined", 9);
  case SCR_DYN_NULL: return scr_str_new("null", 4);
  case SCR_DYN_SYMBOL: return reason->v.symbol.render(reason->v.symbol.value);
  case SCR_DYN_ARR: return scr_str_new("[object Array]", 14);
  case SCR_DYN_PROMISE: return scr_str_new("#<Promise>", 10);
  case SCR_DYN_OBJ: {
    if (scr_rejection_custom_to_string(reason) || scr_rejection_custom_to_string(view))
      return scr_str_new("[object Object]", 15);
    const char *name = reason->kind == SCR_DYN_OBJ ? scr_dyn_class_name(reason) : NULL;
    const ScrStr *typed = reason->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_class_name(reason) : NULL;
    ScrStr *parts[3] = {
      scr_str_new("#<", 2),
      typed ? scr_str_new(typed->data, typed->len) : scr_str_new(name ? name : "Object", name ? strlen(name) : 6),
      scr_str_new(">", 1),
    };
    ScrStr *text = scr_str_concat_parts(parts, 3);
    for (size_t i = 0; i < 3; i++) scr_str_release(parts[i]);
    return text;
  }
  default: return scr_dyn_to_string(view, NULL);
  }
}

ScrDyn *scr_unhandled_rejection_error(ScrDyn *reason) {
  ScrError *error = scr_errdyn_err_of(reason);
  ScrDyn *view = reason->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(reason) : scr_dyn_retain(reason);
  if (!view || scr_exc_pending()) {
    scr_error_release(error);
    scr_dyn_release(view);
    return NULL;
  }
  ScrStr *stack = scr_str_new("stack", 5);
  bool error_like = error || (view->kind == SCR_DYN_OBJ && scr_dyn_has_own(view, stack));
  scr_str_release(stack);
  if (error_like) {
    scr_error_release(error);
    scr_dyn_release(view);
    return scr_dyn_retain(reason);
  }
  ScrStr *text = scr_rejection_reason_text(reason, view);
  scr_dyn_release(view);
  if (!text || scr_exc_pending()) {
    scr_str_release(text);
    return NULL;
  }
  static const char head[] = "This error originated either by throwing inside of an async function without a "
                             "catch block, or by rejecting a promise which was not handled with .catch(). The "
                             "promise rejected with the reason \"";
  ScrStr *parts[3] = {scr_str_new(head, sizeof head - 1), text, scr_str_new("\".", 2)};
  ScrStr *message = scr_str_concat_parts(parts, 3);
  for (size_t i = 0; i < 3; i++) scr_str_release(parts[i]);
  error = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(error->name);
  error->name = scr_str_new("UnhandledPromiseRejection", 25);
  error->code = scr_str_new("ERR_UNHANDLED_REJECTION", 23);
  ScrDyn *value = scr_dyn_from_error(error);
  /* Node's class fields: code, then name, both own and enumerable */
  scr_dyn_obj_set(value, "name", 4, scr_dyn_new_str(error->name));
  scr_error_release(error);
  return value;
}

static int scr_uncaught_dispatch(bool from_promise) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *error = scr_caught_to_dyn(caught);
  if (from_promise) {
    ScrDyn *wrapped = scr_unhandled_rejection_error(error);
    scr_dyn_release(error);
    if (!wrapped) {
      scr_caught_release(caught);
      return -1;
    }
    error = wrapped;
  }
  SCR_PE_ENTER();
  const char *origin = from_promise ? "unhandledRejection" : "uncaughtException";
  ScrStr *text = scr_str_new(origin, strlen(origin));
  ScrDyn *args[2] = {error, scr_dyn_new_str(text)};
  scr_str_release(text);
  bool ok = scr_rej_fire(&scr_uncaught_ls[1], &scr_uncaught_n[1], args, 2);
  bool handled;
  if (ok && scr_capture_fn != NULL) {
    /* The capture callback replaces the 'uncaughtException' listeners: it
     * receives the error alone, and answering handles the exception. Its
     * own throw is the fatal one (the pending exception the fatal path
     * below prints). */
    ScrDyn *capture_args[1] = {error};
    /* The call holds its own reference: a callback that clears itself
     * (setUncaughtExceptionCaptureCallback(null)) drops the registry's,
     * and its body still reads what it captured. */
    ScrDyn *capture = scr_dyn_retain(scr_capture_fn);
    ScrDyn *result = scr_dyn_call(capture, capture_args, 1, "callback");
    ok = !scr_exc_pending();
    scr_dyn_release(result);
    scr_dyn_release(capture);
    handled = ok;
  } else {
    handled = ok && scr_uncaught_n[0] > 0;
    if (handled) ok = scr_rej_fire(&scr_uncaught_ls[0], &scr_uncaught_n[0], args, 2);
  }
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_uncaught_sync_hook();
#ifdef SCR_WORKERS
  /* A worker reports an uncaught error to its parent through this hook
   * (scr_exc_print_uncaught), which the main context never has. */
  bool fatal = !ok && scr_context_report_error == NULL;
#else
  bool fatal = !ok;
#endif
  if (fatal) {
    /* A listener itself threw: Node leaves through its fatal exit (status
     * 7), which emits no 'exit' event and runs nothing else. The report
     * and the exit are the ones a throwing 'exit' listener takes
     * (scr_run_exit_listeners). */
    scr_caught_release(caught);
    scr_exc_print_uncaught();
    scr_stdout_settle();
    fflush(stdout);
    _Exit(7);
  }
  if (ok && !handled) scr_rethrow(caught);
  scr_caught_release(caught);
  SCR_PE_LEAVE();
  return !ok ? -1 : handled ? 1 : 0;
}

/* Dispatch one unhandled rejection to the registered listeners —
 * (reason, promise), Node's signature. A listener throw is an uncaught
 * exception (Node crashes there too): the caller prints it and exits 1.
 * A once-consumed-to-empty registry disarms the hook on the way out, so
 * the report's NEXT promise takes the default print — Node's
 * listener-less behavior. */
static bool scr_urj_dispatch(ScrPromise *p) {
  ScrDyn *reason = scr_promise_reason_dyn(p);
  ScrDyn *boxed = scr_dyn_new_promise(p);
  ScrDyn *args[2] = {reason, boxed};
  SCR_PE_ENTER();
  bool ok = scr_rej_fire(&scr_urj_listeners, &scr_nurj, args, 2);
  scr_dyn_release(reason);
  scr_dyn_release(boxed);
  scr_urj_sync_hook();
  SCR_PE_LEAVE();
  return ok;
}

/* 'rejectionHandled' delivery — (promise), Node's payload. A listener
 * throw propagates as a pending exception through the attach site. */
static void scr_rjh_dispatch(ScrPromise *p) {
  ScrDyn *boxed = scr_dyn_new_promise(p);
  SCR_PE_ENTER();
  (void)scr_rej_fire(&scr_rjh_listeners, &scr_nrjh, &boxed, 1);
  scr_dyn_release(boxed);
  scr_rjh_sync_hook(); /* a once-consumed-to-empty registry disarms */
  SCR_PE_LEAVE();
}

/* ── process 'multipleResolves' ────────────────────────────────────────
 * V8 reports a resolution or rejection that arrives at a promise which
 * already resolved to Node's promiseRejectHandler, which — while a listener
 * is registered — queues a nextTick emitting ('resolve' | 'reject',
 * promise, value) and then, if that emit reached a listener, warns DEP0160
 * ONCE per process. Node checks `hasMultipleResolvesListener` (its cached
 * listener count) at the settle, so an unlistened promise schedules
 * nothing; the tick re-checks the registry, so a listener removed before
 * it runs sees nothing and warns nothing. The settle paths in scr_async.c
 * call the hook; this unit owns the registry, the queued events and the
 * deprecation. */
static SCR_TL ScrRejListener *scr_mr_listeners = NULL;
static SCR_TL size_t scr_nmr = 0, scr_mr_cap = 0;

typedef struct {
  ScrPromise *promise; /* +1 */
  ScrDyn *value;       /* +1 */
  int type;            /* 0 = resolve, 1 = reject */
} ScrMrEvent;

static SCR_TL ScrMrEvent *scr_mr_events = NULL;
static SCR_TL size_t scr_mr_head = 0, scr_mr_len = 0, scr_mr_events_cap = 0;
static SCR_TL bool scr_mr_events_armed = false;
static SCR_TL bool scr_mr_warned = false;

static void scr_mr_events_teardown(void) {
  for (size_t i = scr_mr_head; i < scr_mr_len; i++) {
    scr_promise_release(scr_mr_events[i].promise);
    scr_dyn_release(scr_mr_events[i].value);
  }
  free(scr_mr_events);
  scr_mr_events = NULL;
  scr_mr_head = scr_mr_len = scr_mr_events_cap = 0;
}

static void scr_mr_teardown(void) {
  for (size_t i = 0; i < scr_nmr; i++) scr_rej_release(&scr_mr_listeners[i]);
  free(scr_mr_listeners);
  scr_mr_listeners = NULL;
  scr_nmr = scr_mr_cap = 0;
}

static void scr_mr_tick(void);

/* A losing settle's value, already dyn (+1): dropped when nobody
 * listens (scr_async.c's typed note has the same contract). */
static void scr_mr_note_dyn(ScrPromise *p, int type, ScrDyn *value) {
  if (scr_multiple_resolves_fn == NULL) {
    scr_dyn_release(value);
    return;
  }
  scr_multiple_resolves_fn(p, type, value);
}

/* The settle-time hook: the losing value moves into a queued event. */
static void scr_mr_note(ScrPromise *p, int type, ScrDyn *value) {
  if (!scr_mr_events_armed) {
    scr_mr_events_armed = true;
    scr_atexit(scr_mr_events_teardown);
  }
  if (scr_mr_len == scr_mr_events_cap) {
    size_t cap = scr_mr_events_cap ? scr_mr_events_cap * 2 : 4;
    ScrMrEvent *grown = realloc(scr_mr_events, cap * sizeof *grown);
    if (!grown) scr_ad_oom();
    scr_mr_events = grown;
    scr_mr_events_cap = cap;
  }
  scr_mr_events[scr_mr_len++] = (ScrMrEvent){scr_promise_retain(p), value, type};
  scr_next_tick_raw(scr_mr_tick);
}

static void scr_mr_sync_hook(void) {
#ifdef SCR_NODE_ISLANDS
  if (scr_pe_node) return; /* Node's own promise hooks report these */
#endif
  scr_multiple_resolves_fn = scr_nmr > 0 ? scr_mr_note : NULL;
}

void scr_process_on_multiple_resolves(ScrDyn *fn, bool once) {
  if (!scr_rej_check_listener(fn)) return;
  if (scr_pe_listen(once ? 1 : 0, "multipleResolves", fn)) return;
  static SCR_TL bool teardown_armed = false;
  if (!teardown_armed) {
    teardown_armed = true;
    scr_atexit(scr_mr_teardown);
  }
  scr_rej_push(&scr_mr_listeners, &scr_nmr, &scr_mr_cap, fn, once);
  scr_mr_sync_hook();
}

void scr_process_off_multiple_resolves(ScrDyn *fn) {
  if (scr_pe_listen(3, "multipleResolves", fn)) return;
  scr_rej_remove(scr_mr_listeners, &scr_nmr, fn);
  scr_mr_sync_hook();
}

/* The DEP0160 report Node's deprecate() wrapper makes after a delivery
 * reached a listener: once per process, dropped outright while
 * process.noDeprecation is set (and then not marked, so a later delivery
 * under a cleared flag still warns — Node's deprecated() wrapper checks
 * the flag before its own once guard). */
static void scr_mr_deprecate(void) {
  if (scr_mr_warned || scr_process_deprecation_flag_on(0)) return;
  scr_mr_warned = true;
  static const char text[] = "The multipleResolves event has been deprecated.";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrStr *code = scr_str_new("DEP0160", 7);
  ScrDyn *w = scr_warning_new(message, "DeprecationWarning", code);
  scr_warning_emit_deferred(w);
  scr_dyn_release(w);
  scr_str_release(code);
  scr_str_release(message);
}

/* One queued event per losing settle, in settle order (Node's nextTick
 * FIFO). The registry is re-read now: no listener left, no event. */
static void scr_mr_tick(void) {
  if (scr_mr_head == scr_mr_len) return;
  ScrMrEvent ev = scr_mr_events[scr_mr_head++];
  if (scr_mr_head == scr_mr_len) scr_mr_head = scr_mr_len = 0;
  const char *name = ev.type == 0 ? "resolve" : "reject";
  ScrStr *text = scr_str_new(name, ev.type == 0 ? 7 : 6);
  ScrDyn *kind = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrDyn *boxed = scr_dyn_new_promise(ev.promise);
  ScrDyn *args[3] = {kind, boxed, ev.value};
  SCR_PE_ENTER();
  bool listened = scr_nmr > 0;
  bool ok = !listened || scr_rej_fire(&scr_mr_listeners, &scr_nmr, args, 3);
  scr_mr_sync_hook(); /* a once-consumed-to-empty registry disarms */
  SCR_PE_LEAVE();
  scr_dyn_release(kind);
  scr_dyn_release(boxed);
  if (listened && ok) scr_mr_deprecate();
  scr_dyn_release(ev.value);
  scr_promise_release(ev.promise);
}

/* `new Promise(setImmediate)` (the Node-suite early-exit shape): the
 * executor IS setImmediate, so resolve rides the immediate queue — a
 * fresh promise an armed immediate fulfills with the undefined dyn value
 * (the executor's resolve receives no argument; the dyn payload keeps
 * promise<dyn> awaiters honest and void awaiters ignore it). +1. */
static void scr_imm_promise_thunk(ScrClosure *self) {
  ScrPromise *p = (ScrPromise *)scr_box_get_ref(self->caps[0]);
  scr_promise_fulfill_ref(p, scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v,
                          scr_dyn_release_v, NULL);
  scr_promise_release(p);
}

ScrPromise *scr_immediate_promise(void) {
  ScrPromise *p = scr_promise_new();
  ScrClosure *cb = scr_closure_new((void *)scr_imm_promise_thunk, 1);
  cb->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_promise_retain(p));
  scr_set_immediate(cb); /* ownership of cb moves in */
  return p;
}

/* ── .then/.catch/.finally over dyn promises (scr_dyn_invoke's promise
 * arm and the dc tracePromise reactions) ──────────────────────────────
 * One native reaction per registration (scr_promise_react): its job runs
 * on the loop's stack one microtask turn after src settles (reactions
 * never run synchronously inside settle), in the AsyncLocalStorage context
 * of the registration, calls the checked-dynamic tree handler, and settles
 * dst. A handler returning a dyn promise is ADOPTED (the resolution
 * procedure, scr_promise_resolve_dyn). Non-callable handlers pass the
 * settlement through (JS's PromisePrototypeThen over non-function
 * reactions). The job consumes every exception into dst. Nothing here
 * suspends in the middle, so no reaction takes a fiber. */
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_DYN_REACTIONS_ROOTED 1
#endif
#endif

/* The collector does not trace a reaction's context, so one that never
 * runs on a cycle through its handler stays allocated, as the parked fiber
 * it replaces did. The sanitizer lane keeps the pending contexts on a list
 * rooted in a global (their first member), so the leak check sees them
 * reachable, as it saw that fiber's stack. The count audit takes one that
 * is left when the loop has nothing more to run as that fiber never
 * resumed (scr_dyn_reactions_pending). */
#ifdef SCR_RC_AUDIT
#define SCR_DYN_PENDING_COUNT(n) (scr_dyn_reactions_pending += (n))
#else
#define SCR_DYN_PENDING_COUNT(n) ((void)0)
#endif
#ifdef SCR_DYN_REACTIONS_ROOTED
typedef struct ScrDynPending {
  struct ScrDynPending *next, **previous;
} ScrDynPending;
static SCR_TL ScrDynPending *scr_dyn_pending = NULL;
static void scr_dyn_pending_link(ScrDynPending *p) {
  p->next = scr_dyn_pending;
  p->previous = &scr_dyn_pending;
  if (scr_dyn_pending) scr_dyn_pending->previous = &p->next;
  scr_dyn_pending = p;
}
static void scr_dyn_pending_unlink(ScrDynPending *p) {
  *p->previous = p->next;
  if (p->next) p->next->previous = p->previous;
}
#define SCR_DYN_PENDING ScrDynPending pending;
#define SCR_DYN_PENDING_LINK(pack) (scr_dyn_pending_link(&(pack)->pending), SCR_DYN_PENDING_COUNT(1))
#define SCR_DYN_PENDING_UNLINK(pack) (scr_dyn_pending_unlink(&(pack)->pending), SCR_DYN_PENDING_COUNT(-1))
#else
#define SCR_DYN_PENDING
#define SCR_DYN_PENDING_LINK(pack) SCR_DYN_PENDING_COUNT(1)
#define SCR_DYN_PENDING_UNLINK(pack) SCR_DYN_PENDING_COUNT(-1)
#endif

typedef struct {
  SCR_DYN_PENDING
  ScrPromise *dst;           /* owned */
  ScrDyn *onf, *onr, *onfin; /* owned or NULL */
  ScrAlsCtx *als;            /* the registration's context, owned or NULL */
} ScrDynThenPack;

/* The wait of a finally callback's result. It does not own the promise it
 * waits on: that promise owns the reaction, and a reference back would
 * keep both alive when the promise never settles. */
typedef struct {
  SCR_DYN_PENDING
  ScrPromise *src, *dst; /* owned */
} ScrDynFinallyPack;

static ScrDyn *scr_dyn_promise_payload(ScrPromise *p);

/* The promise a finally callback's result stands for has settled: its
 * rejection replaces the original settlement, anything else passes the
 * original on. */
static void scr_dyn_finally_react(void *ctx, ScrPromise *settled) {
  ScrDynFinallyPack *pack = ctx;
  scr_promise_settled_now(settled); /* observes; a rejection re-throws */
  if (scr_exc_pending()) scr_promise_reject_pending(pack->dst);
  else scr_promise_adapt_copy(pack->dst, pack->src);
}

static void scr_dyn_finally_drop(void *ctx) {
  ScrDynFinallyPack *pack = ctx;
  SCR_DYN_PENDING_UNLINK(pack);
  scr_promise_release(pack->src);
  scr_promise_release(pack->dst);
  free(pack);
}

static const ScrPromiseReaction scr_dyn_finally_reaction = { scr_dyn_finally_react,
                                                             scr_dyn_finally_drop };

SCR_TL void (*scr_dyn_reaction_spawn)(void *ctx, ScrPromise *src) = NULL;

static void scr_dyn_then_drop(void *ctx);

/* The reaction's steps. Inlined into both callers, so that the reaction
 * job stays one function in a program without tests. */
static inline __attribute__((always_inline)) void scr_dyn_then_steps(ScrDynThenPack *a,
                                                                     ScrPromise *src) {
  scr_promise_settled_now(src); /* observes; a rejection re-throws */
  bool rejected = scr_exc_pending();
  ScrCaught *c = rejected ? scr_exc_take() : NULL;
  ScrDyn *v = rejected ? NULL : scr_dyn_promise_payload(src);
  ScrDyn *handler = a->onfin ? a->onfin : (rejected ? a->onr : a->onf);
  if (handler != NULL && scr_dyn_is_callable(handler)) {
    ScrDyn *arg = NULL;
    if (a->onfin == NULL) arg = rejected ? scr_caught_to_dyn(c) : scr_dyn_retain(v);
    ScrAlsCtx *outer = scr_als_dispatch_enter(a->als);
    ScrDyn *r = scr_dyn_call(handler, arg ? &arg : NULL, arg ? 1 : 0, "handler");
    scr_als_dispatch_leave(outer);
    scr_dyn_release(arg);
    if (r == NULL) {
      /* The handler threw: dst rejects with that. */
      scr_promise_reject_pending(a->dst);
    } else if (a->onfin != NULL) {
      /* finally returns PromiseResolve(result).then(valueThunk), which
       * the outer reaction adopts. Even an undefined result takes those
       * jobs before propagating the original fulfillment or rejection. */
      if (r->kind != SCR_DYN_PROMISE) {
        ScrPromise *result = scr_promise_new();
        scr_promise_fulfill_ref(result, r, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
        r = scr_dyn_new_promise(result);
        scr_promise_release(result);
      }
      ScrPromise *passthrough = scr_promise_new();
      ScrDynFinallyPack *pack = malloc(sizeof *pack);
      if (!pack) scr_ad_oom();
      pack->src = scr_promise_retain(src);
      pack->dst = scr_promise_retain(passthrough);
      SCR_DYN_PENDING_LINK(pack);
      scr_promise_react_unmarked(r->v.promise, &scr_dyn_finally_reaction, pack);
      scr_dyn_release(r);
      scr_promise_resolve_dyn(a->dst, scr_dyn_new_promise(passthrough));
      scr_promise_release(passthrough);
    } else {
      scr_promise_resolve_dyn(a->dst, r);
    }
  } else if (rejected) {
    scr_rethrow(c);
    scr_promise_reject_pending(a->dst);
  } else {
    scr_promise_fulfill_ref(a->dst, scr_dyn_retain(v), scr_dyn_retain_v, scr_dyn_release_v, NULL);
  }
  scr_caught_release(c);
  scr_dyn_release(v);
}

#ifndef __wasi__
/* The steps on a fiber of their own (scr_dyn_then_spawn): the fiber holds
 * the source and a context of its own, because the reaction's context goes
 * with the reaction when its job returns, and the handler may still be
 * waiting then. */
typedef struct {
  ScrDynThenPack *pack; /* owned */
  ScrPromise *src;      /* owned */
} ScrDynThenFiber;

static void scr_dyn_then_fiber_entry(ScrFiber *self, void *argpack) {
  (void)self;
  ScrDynThenFiber *job = argpack;
  scr_dyn_then_steps(job->pack, job->src);
  scr_dyn_then_drop(job->pack);
  scr_promise_release(job->src);
  free(job);
}

/* Referenced by the test unit alone, so that a program without tests links
 * neither this copy nor the fiber machinery it starts. */
void scr_dyn_then_spawn(void *ctx, ScrPromise *src) {
  ScrDynThenPack *a = ctx;
  ScrDynThenFiber *job = malloc(sizeof *job);
  ScrDynThenPack *own = malloc(sizeof *own);
  if (!job || !own) scr_ad_oom();
  own->dst = scr_promise_retain(a->dst);
  own->onf = a->onf ? scr_dyn_retain(a->onf) : NULL;
  own->onr = a->onr ? scr_dyn_retain(a->onr) : NULL;
  own->onfin = a->onfin ? scr_dyn_retain(a->onfin) : NULL;
  own->als = a->als ? scr_als_ctx_retain(a->als) : NULL;
  SCR_DYN_PENDING_LINK(own);
  job->pack = own;
  job->src = scr_promise_retain(src);
  scr_promise_release(scr_async_spawn(scr_dyn_then_fiber_entry, job));
}
#endif

static void scr_dyn_then_react(void *ctx, ScrPromise *src) {
  if (scr_dyn_reaction_spawn != NULL) {
    scr_dyn_reaction_spawn(ctx, src);
    return;
  }
  scr_dyn_then_steps(ctx, src);
}

static void scr_dyn_then_drop(void *ctx) {
  ScrDynThenPack *a = ctx;
  SCR_DYN_PENDING_UNLINK(a);
  scr_promise_release(a->dst);
  scr_dyn_release(a->onf);
  scr_dyn_release(a->onr);
  scr_dyn_release(a->onfin);
  scr_als_ctx_release(a->als);
  free(a);
}

static const ScrPromiseReaction scr_dyn_then_reaction = { scr_dyn_then_react, scr_dyn_then_drop };

ScrDyn *scr_dyn_promise_then(ScrPromise *src, ScrDyn *onf, ScrDyn *onr, ScrDyn *onfin) {
  /* A rejection HANDLER marks the source handled at attach (Node's
   * moment), which also lets a .catch inside an 'unhandledRejection'
   * listener fire 'rejectionHandled' at the attach point. Without one the
   * reaction's own steps observe the source in their turn. */
  if (onr != NULL) scr_promise_mark_handled(src);
  ScrDynThenPack *a = malloc(sizeof *a);
  if (!a) scr_ad_oom();
  a->dst = scr_promise_new();
  a->onf = onf ? scr_dyn_retain(onf) : NULL;
  a->onr = onr ? scr_dyn_retain(onr) : NULL;
  a->onfin = onfin ? scr_dyn_retain(onfin) : NULL;
  a->als = scr_als_capture();
  ScrDyn *boxed = scr_dyn_new_promise(a->dst);
  SCR_DYN_PENDING_LINK(a);
  scr_promise_react_unmarked(src, &scr_dyn_then_reaction, a);
  return boxed;
}

/* The promise a resolution adopts has settled: a fulfilment resolves the
 * destination in turn, a rejection rejects it with the same reason. */
static void scr_dyn_adopt_react(void *ctx, ScrPromise *settled) {
  ScrPromise *destination = ctx;
  scr_promise_settled_now(settled); /* observes; a rejection re-throws */
  if (scr_exc_pending()) scr_promise_reject_pending(destination);
  else scr_promise_resolve_dyn(destination, scr_dyn_promise_payload(settled));
}

static void scr_dyn_adopt_drop(void *ctx) { scr_promise_release(ctx); }

static const ScrPromiseReaction scr_dyn_adopt_reaction = { scr_dyn_adopt_react, scr_dyn_adopt_drop };

/* The job that calls the adopted promise's `then`: the reaction above
 * subscribes in this turn, with a reference of its own on the destination
 * (the job's goes with the job). */
static void scr_dyn_adopt_subscribe(void *ctx, ScrPromise *adopted) {
  scr_promise_react_unmarked(adopted, &scr_dyn_adopt_reaction, scr_promise_retain(ctx));
}

static const ScrPromiseReaction scr_dyn_adopt_job = { scr_dyn_adopt_subscribe, scr_dyn_adopt_drop };

/* The destination is borrowed; value moves in. An async function may
 * return a native promise hidden behind any/unknown without an explicit
 * await, so its completion must use resolution rather than fulfillment.
 * A promise is adopted as JavaScript does it: one job calls its `then`
 * (scr_promise_react_next), whose reaction settles the destination one
 * turn after the promise settles, so two turns after a settled one. */
void scr_promise_resolve_dyn(ScrPromise *destination, ScrDyn *value) {
  if (value->kind != SCR_DYN_PROMISE) {
#ifdef SCR_NODE_ISLANDS
    /* An island object may be a thenable (scr_dyn_thenable_function): the
     * resolution adopts it, as it adopts a promise. */
    if (scr_ni_dyn_handle(value)) {
      scr_dyn_promise_resolve_with(destination, value);
      scr_dyn_release(value);
      return;
    }
#endif
    scr_promise_fulfill_ref(destination, value, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    return;
  }
  if (value->v.promise == destination) {
    static const char message[] = "Chaining cycle detected for promise #<Promise>";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    scr_promise_reject_pending(destination);
    scr_dyn_release(value);
    return;
  }
  scr_promise_react_next(value->v.promise, &scr_dyn_adopt_job, scr_promise_retain(destination));
  scr_dyn_release(value);
}

/* ── new Promise(executor) of a checked-dynamic value ─────────────────
 * The resolve function of such a promise runs the resolution procedure
 * (scr_promise_resolve_dyn): a promise it is given is adopted. From then on
 * the promise is resolved although it is still pending, so the executor's
 * resolve, its reject and its throw no longer change it. Both closures
 * share one box (scr_async.c's layout: caps[0] holds the promise); a
 * resolution that leaves the promise pending points the box at a settled
 * promise nobody observes, which every later call finds settled. */
static void scr_resolve_dyn_thunk(ScrClosure *self, ScrDyn *value) {
  ScrPromise *p = (ScrPromise *)scr_box_get_ref(self->caps[0]);
  if (!scr_promise_is_pending(p)) {
    scr_mr_note_dyn(p, 0, scr_dyn_retain(value));
    scr_dyn_release(value);
  } else {
    scr_promise_resolve_dyn(p, value); /* moves value in */
    if (scr_promise_is_pending(p)) {
      ScrPromise *resolved = scr_promise_new();
      scr_promise_fulfill_void(resolved);
      scr_box_set_ref(self->caps[0], resolved);
    }
  }
  scr_promise_release(p);
}

/* The resolve closure of `p` (+1). `reject`, the promise's reject closure
 * or NULL, is borrowed and joins the resolve closure's box. */
ScrClosure *scr_make_resolve_dyn(ScrPromise *p, ScrClosure *reject) {
  ScrClosure *resolve = scr_closure_new((void *)&scr_resolve_dyn_thunk, 1);
  ScrBox *target = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
  scr_box_set_ref(target, scr_promise_retain(p));
  resolve->caps[0] = target;
  if (reject != NULL) {
    scr_box_release(reject->caps[0]);
    reject->caps[0] = scr_box_retain(target);
  }
  return resolve;
}

/* Runs the executor of `p` with the closures scr_make_resolve_dyn paired
 * (`reject` NULL for a one-parameter executor). Borrows `p` and `exec`; the
 * closures move into the call. A throw rejects the promise unless the
 * executor resolved it first. */
void scr_promise_run_executor_dyn(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve,
                                  ScrClosure *reject) {
  ScrBox *target = scr_box_retain(resolve->caps[0]);
  if (reject != NULL)
    ((void (*)(ScrClosure *, ScrClosure *, ScrClosure *))exec->fn)(exec, resolve, reject);
  else ((void (*)(ScrClosure *, ScrClosure *))exec->fn)(exec, resolve);
  if (scr_exc_pending()) {
    ScrPromise *now = (ScrPromise *)scr_box_get_ref(target);
    if (now == p) scr_promise_reject_pending(p);
    else {
      /* The box swapped on a thenable adoption: the throw is the losing
       * settle V8 reports as reject-after-resolve. */
      scr_promise_multiple_resolves_note(p, 1, scr_exc_current_cell());
      scr_exc_clear();
    }
    scr_promise_release(now);
  }
  scr_box_release(target);
}

/* ── new Promise(executor) of a typed value, resolved with a promise ───
 * The typed half of the same procedure. A typed promise's resolve function
 * is the closure scr_make_resolve / scr_make_resolve_fn built, which
 * fulfils. Where the static type of a value it is given has a promise arm,
 * emitted code tests the arm and hands the promise here, so the value
 * itself is never asked.
 *
 * The promise is adopted as JavaScript does it: one job calls its `then`
 * (scr_promise_race_join: the reaction runs one turn after the source
 * settles, copies a fulfilment and a rejection alike, and marks the source
 * handled), so the target settles two turns after an already settled
 * source. From the call on the target is resolved although it is still
 * pending: the box both closures share points at a settled promise nobody
 * observes, exactly as scr_resolve_dyn_thunk leaves it. */
static void scr_resolve_adopt_job(ScrClosure *job) {
  ScrPromise *target = (ScrPromise *)scr_box_get_ref(job->caps[0]);
  ScrPromise *source = (ScrPromise *)scr_box_get_ref(job->caps[1]);
  scr_promise_race_join(target, source, scr_promise_adapt_copy);
  scr_promise_release(source);
  scr_promise_release(target);
}

/* The reject closure of the same promise joins the resolve closure's box
 * (scr_make_resolve_dyn does this for the pair it builds). Borrows both. */
void scr_resolve_join(ScrClosure *resolve, ScrClosure *reject) {
  scr_box_release(reject->caps[0]);
  reject->caps[0] = scr_box_retain(resolve->caps[0]);
}

/* `resolve(source)`: `resolve` is a typed promise's resolve closure and
 * `source` a promise of the same payload type. Borrows both. */
void scr_resolve_adopt(ScrClosure *resolve, ScrPromise *source) {
  ScrBox *box = resolve->caps[0];
  ScrPromise *p = (ScrPromise *)scr_box_get_ref(box);
  if (scr_promise_is_pending(p)) {
    if (source == p) {
      static const char message[] = "Chaining cycle detected for promise #<Promise>";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      scr_promise_reject_pending(p);
    } else {
      ScrClosure *job = scr_closure_new((void *)&scr_resolve_adopt_job, 2);
      job->caps[0] =
          scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
      scr_box_set_ref(job->caps[0], scr_promise_retain(p));
      job->caps[1] =
          scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
      scr_box_set_ref(job->caps[1], scr_promise_retain(source));
      scr_queue_microtask(job);
      ScrPromise *resolved = scr_promise_new();
      scr_promise_fulfill_void(resolved);
      scr_box_set_ref(box, resolved);
    }
  } else {
    /* resolve() again after the first resolution (any kind). */
    scr_mr_note_dyn(p, 0, scr_dyn_new_promise(source));
  }
  scr_promise_release(p);
}

/* `await v` where v is a CHECKED-DYNAMIC value: a dyn promise adopts
 * (the boxed promise awaits — rejections re-throw); every other kind is
 * JS's await-of-a-non-thenable — one microtask hop, the value itself
 * (+1). Thenable ADOPTION (a plain object carrying a then method) is not
 * modeled — SEMANTICS.md. */
ScrDyn *scr_await_dyn_value(ScrDyn *v) {
  if (v->kind == SCR_DYN_PROMISE) return scr_await_dyn(v->v.promise);
  scr_await_hop();
  return scr_dyn_retain(v);
}

/* The WASI emitter has already suspended on the value's actual promise,
 * or taken the non-promise microtask hop. Extraction must never suspend a
 * runtime-authored C frame. */
ScrDyn *scr_await_dyn_value_settled(ScrDyn *value) {
  return value->kind == SCR_DYN_PROMISE ? scr_await_dyn(value->v.promise) : scr_dyn_retain(value);
}

static ScrDyn *scr_dyn_promise_payload(ScrPromise *p);

/* The same for a native stackless body: the suspension has taken the turn
 * scr_await_dyn would take, so the extraction takes none. */
ScrDyn *scr_coro_await_dyn_value(ScrDyn *value) {
  if (value->kind != SCR_DYN_PROMISE) return scr_dyn_retain(value);
  ScrPromise *p = value->v.promise;
  if (!scr_promise_settled_now(p))
    scr_trap("scriptc: internal error: resumed before awaited promise settled\n");
  if (scr_promise_is_rejected(p)) return NULL;
  return scr_dyn_promise_payload(p);
}

/* ── process warnings (emitWarning + the 'warning' event) ─────────────
 * Gated with the rest of this TU (a deprecation-emitting unit's gate
 * must imply the dynAsync link). Listeners are dyn functions; the
 * warning is built at the call and emitted on the next tick, as Node's
 * emitWarning does (scr_warning_emit_deferred). The default stderr report
 * prints for every warning except deprecations under process.noDeprecation
 * (Node's own bootstrap listener; a compiled binary has no
 * --no-warnings). The warning VALUE is the dyn error encoding built over
 * an ScrError (identity-cached, so a listener comparing two deliveries
 * of one warning sees one object); a string `detail` joins the dyn node
 * and the report's second line, exactly Node. */
static SCR_TL ScrDyn **scr_warn_listeners = NULL;
static SCR_TL size_t scr_nwarn = 0, scr_warn_cap = 0;

static void scr_emit_leak_warning(ScrDyn *type, double count, ScrDyn *emitter, ScrStr *message);

#ifdef SCR_WARNING_REPLACE
/* The program's process.emitWarning replacement, or NULL while the
 * property holds Node's own function (defined below). */
static SCR_TL ScrDyn *scr_emit_warning_override = NULL;
#endif

static void scr_warn_teardown(void) {
  for (size_t i = 0; i < scr_nwarn; i++) scr_dyn_release(scr_warn_listeners[i]);
  free(scr_warn_listeners);
  scr_warn_listeners = NULL;
  scr_nwarn = scr_warn_cap = 0;
}

void scr_process_on_warning(ScrDyn *fn) {
  if (fn->kind != SCR_DYN_FUNC) {
    const char *msg = "The \"listener\" argument must be of type function";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
    return;
  }
  if (scr_pe_listen(0, "warning", fn)) return;
  scr_warning_emit_hook = scr_emit_warning;
  scr_warning_leak_hook = scr_emit_leak_warning;
  if (scr_nwarn == scr_warn_cap) {
    scr_warn_cap = scr_warn_cap ? scr_warn_cap * 2 : 4;
    scr_warn_listeners = realloc(scr_warn_listeners, scr_warn_cap * sizeof *scr_warn_listeners);
    if (!scr_warn_listeners) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  if (scr_nwarn == 0) scr_atexit(scr_warn_teardown);
  scr_warn_listeners[scr_nwarn++] = scr_dyn_retain(fn);
}

void scr_process_off_warning(ScrDyn *fn) {
  if (scr_pe_listen(3, "warning", fn)) return;
  for (size_t i = 0; i < scr_nwarn; i++) {
    ScrDyn *l = scr_warn_listeners[i];
    bool same = l == fn || (l->kind == SCR_DYN_FUNC && fn->kind == SCR_DYN_FUNC &&
                            scr_dyn_strict_eq(l, fn));
    if (same) {
      scr_dyn_release(l);
      memmove(scr_warn_listeners + i, scr_warn_listeners + i + 1,
              (scr_nwarn - i - 1) * sizeof *scr_warn_listeners);
      scr_nwarn--;
      return;
    }
  }
}

/* process.noDeprecation (0), process.throwDeprecation (1),
 * process.traceDeprecation (2) and process.traceProcessWarnings (3):
 * ordinary writable process properties, undefined until the program
 * assigns them. A compiled binary takes no Node command-line flags, so
 * only those assignments set them. */
static SCR_TL ScrDyn *scr_deprecation_flags[4] = {NULL, NULL, NULL, NULL};
static SCR_TL bool scr_deprecation_flags_registered = false;

static size_t scr_deprecation_flag_slot(double which) {
  if (which == 0) return 0;
  if (which == 1) return 1;
  return which == 2 ? 2 : 3;
}

static void scr_deprecation_flags_teardown(void) {
  for (size_t i = 0; i < 4; i++) {
    scr_dyn_release(scr_deprecation_flags[i]);
    scr_deprecation_flags[i] = NULL;
  }
}

ScrDyn *scr_process_deprecation_flag(double which) {
  ScrDyn *value = scr_deprecation_flags[scr_deprecation_flag_slot(which)];
  return scr_dyn_retain(value ? value : scr_dyn_undefined());
}

void scr_process_set_deprecation_flag(double which, ScrDyn *value) {
  if (!scr_deprecation_flags_registered) {
    scr_deprecation_flags_registered = true;
    scr_atexit(scr_deprecation_flags_teardown);
  }
  size_t slot = scr_deprecation_flag_slot(which);
  ScrDyn *previous = scr_deprecation_flags[slot];
  scr_deprecation_flags[slot] = scr_dyn_retain(value);
  scr_dyn_release(previous);
}

bool scr_process_deprecation_flag_on(int which) {
  const ScrDyn *value = scr_deprecation_flags[scr_deprecation_flag_slot((double)which)];
  return value != NULL && scr_dyn_truthy(value);
}

/* Node's onWarning trace test: process.traceProcessWarnings for every
 * warning, process.traceDeprecation for deprecations too. A set flag makes
 * the report print the warning's own stack in place of its one-line
 * "Name: message" and drops the one-time hint. */
static bool scr_warning_trace_on(bool deprecation) {
  return scr_process_deprecation_flag_on(3) || (deprecation && scr_process_deprecation_flag_on(2));
}

/* The warning's name as warning.toString() reads it: the own property, or
 * the Error class name an emitted Error instance inherits. +1 or NULL. */
/* A warning's `key` as a property read sees it, including the fields of an
 * Error subclass instance: +1, or NULL when there is none or the read threw
 * (the exception is pending). */
static ScrDyn *scr_warning_field(const ScrDyn *w, const char *key, size_t key_len) {
  if (w->kind == SCR_DYN_TYPED_REF) {
    /* The reference's own answer, else its materialized view's. */
    ScrStr *name = scr_str_new(key, key_len);
    ScrDyn *value = scr_dyn_typed_ref_own_get(w, name);
    scr_str_release(name);
    if (value || scr_exc_pending()) return value;
    ScrDyn *view = scr_dyn_typed_ref_materialize(w);
    if (view && !scr_exc_pending()) value = scr_warning_field(view, key, key_len);
    scr_dyn_release(view);
    return value;
  }
  if (w->kind != SCR_DYN_OBJ) return NULL;
  return scr_dyn_obj_read(w, key, key_len);
}

static ScrStr *scr_warning_name(const ScrDyn *w) {
  if (w->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *en = scr_warning_field(w, "name", 4);
    ScrStr *name = en && en->kind == SCR_DYN_STR ? scr_str_retain(en->v.str) : NULL;
    scr_dyn_release(en);
    if (name) return name;
  }
  const ScrDyn *en = scr_dyn_obj_get(w, "name", 4);
  if (en) return en->kind == SCR_DYN_STR ? scr_str_retain(en->v.str) : NULL;
  ScrError *e = scr_errdyn_err_of(w);
  if (!e) return NULL;
  ScrStr *name = e->name ? scr_str_retain(e->name) : scr_error_default_name(e);
  scr_error_release(e);
  return name;
}

static bool scr_warning_is_deprecation(const ScrDyn *w) {
  ScrStr *name = scr_warning_name(w);
  bool deprecation = name && name->len == 18 && memcmp(name->data, "DeprecationWarning", 18) == 0;
  scr_str_release(name);
  return deprecation;
}

/* NODE_NO_WARNINGS=1: Node reads it once at startup (a value whose first
 * character is "1") and leaves out its default report, while 'warning'
 * listeners still run. The process's own environment table is not the
 * program's `process.env`, so an assignment at run time changes nothing
 * here, as in Node. */
static bool scr_warnings_silenced(void) {
  const char *value = scr_getenv("NODE_NO_WARNINGS");
  return value != NULL && value[0] == '1';
}

/* The default stderr report + dispatch over a built warning dyn node.
 * Borrowed. A listener throw propagates (the dc publish stance). */
static void scr_warning_dispatch(ScrDyn *w) {
#ifdef SCR_NODE_ISLANDS
  /* Node's `process` holds the listeners, Node's own report first among
   * them: it prints what the report below prints, under the same rule for
   * deprecations (process.noDeprecation, which the emit carries over). */
  if (scr_pe_node) {
    /* The V8 error the warning crosses as holds its name, message and
     * stack; the report also prints its code and its detail. */
    ScrDyn *code = scr_warning_field(w, "code", 4);
    ScrDyn *detail = scr_exc_pending() ? NULL : scr_warning_field(w, "detail", 6);
    if (!scr_exc_pending())
      (void)scr_ni_warning(w, code, detail,
                           scr_warning_is_deprecation(w) && scr_process_deprecation_flag_on(0),
                           scr_process_deprecation_flag_on(3) != 0,
                           scr_process_deprecation_flag_on(2) != 0);
    scr_dyn_release(code);
    scr_dyn_release(detail);
    return;
  }
#endif
  /* "(node:pid) [CODE] Name: message" + "\n<detail>" — Node's
   * onWarning report, written as ONE console.error line (so the global
   * console's group indentation applies to each of its lines). Node
   * registers that listener at startup, so it runs before the program's,
   * and skips deprecations while process.noDeprecation is set. */
  bool deprecation = scr_warning_is_deprecation(w);
  if (deprecation && scr_process_deprecation_flag_on(0)) goto listeners;
  if (scr_warnings_silenced()) goto listeners;
  ScrStr *name = scr_warning_name(w);
  /* process.traceProcessWarnings / process.traceDeprecation: the report
   * prints the warning's own stack instead of the one-line heading (Node's
   * onWarning). The stack carries the heading too, so the name and message
   * reads stay for the untraced report and for a warning whose stack was
   * deleted. */
  bool trace = scr_warning_trace_on(deprecation);
  ScrDyn *em = scr_warning_field(w, "message", 7);
  ScrDyn *ec = scr_exc_pending() ? NULL : scr_warning_field(w, "code", 4);
  ScrDyn *ed = scr_exc_pending() ? NULL : scr_warning_field(w, "detail", 6);
  ScrDyn *es = trace && !scr_exc_pending() ? scr_warning_field(w, "stack", 5) : NULL;
  if (scr_exc_pending()) {
    /* A read that threw reports nothing; the exception propagates. */
    scr_str_release(name);
    scr_dyn_release(em);
    scr_dyn_release(ec);
    scr_dyn_release(ed);
    scr_dyn_release(es);
    return;
  }
  ScrJsonBuf report;
  scr_jb_init(&report);
  char pid[32];
  snprintf(pid, sizeof pid, "(node:%ld) ", SCR_WARN_PID());
  scr_jb_puts(&report, pid);
  if (ec && ec->kind == SCR_DYN_STR) {
    scr_jb_puts(&report, "[");
    scr_jb_put_str(&report, ec->v.str);
    scr_jb_puts(&report, "] ");
  }
  if (es && es->kind == SCR_DYN_STR) {
    /* The stack starts with the "Name: message" heading Node's untraced
     * report spells out below. */
    scr_jb_put_str(&report, es->v.str);
  } else {
    if (name) scr_jb_put_str(&report, name);
    else scr_jb_puts(&report, "Warning");
    scr_jb_puts(&report, ": ");
    if (em && em->kind == SCR_DYN_STR) scr_jb_put_str(&report, em->v.str);
  }
  scr_str_release(name);
  scr_dyn_release(es);
  if (ed && ed->kind == SCR_DYN_STR) {
    scr_jb_puts(&report, "\n");
    scr_jb_put_str(&report, ed->v.str);
  }
  scr_dyn_release(em);
  scr_dyn_release(ec);
  scr_dyn_release(ed);
  /* Node's one-time trace hint, after the first untraced report;
   * deprecations name their own trace flag. */
  if (!trace && !scr_warning_trace_hint_shown) {
    scr_warning_trace_hint_shown = true;
    scr_jb_puts(&report, deprecation
                             ? "\n(Use `node --trace-deprecation ...` to show where the warning was created)"
                             : "\n(Use `node --trace-warnings ...` to show where the warning was created)");
  }
  ScrLogArg line = {.tag = SCR_ARG_STR};
  line.v.s = scr_jb_finish(&report);
  scr_console_error(1, &line);
  scr_str_release(line.v.s);
listeners:
  SCR_PE_ENTER();
  for (size_t i = 0; i < scr_nwarn; i++) {
    ScrDyn *r = scr_dyn_call(scr_warn_listeners[i], &w, 1, "listener");
    if (r == NULL) {
      SCR_PE_LEAVE();
      return; /* pending exception propagates */
    }
    scr_dyn_release(r);
  }
  SCR_PE_LEAVE();
}

#ifdef SCR_NODE_ISLANDS
/* One registry's listeners onto Node's `process`, in their order. `front`:
 * the move was deferred, and island code may have registered listeners of
 * its own meanwhile; the native ones are older, so they go ahead of those
 * (prepended last to first). */
static void scr_pe_move(ScrRejListener **list, size_t *n, size_t *cap, const char *event,
                        bool front) {
  ScrRejListener *moved = *list;
  size_t count = *n;
  *list = NULL;
  *n = *cap = 0;
  for (size_t k = 0; k < count; k++) {
    size_t i = front ? count - 1 - k : k;
    int mode = front ? (moved[i].once ? 4 : 2) : (moved[i].once ? 1 : 0);
    scr_ni_process_listen(mode, event, moved[i].fn);
    if (scr_exc_pending()) scr_exc_clear();
    scr_rej_release(&moved[i]);
  }
  free(moved);
}

static void scr_pe_move_all(void) {
  bool front = scr_pe_wanted;
  scr_pe_wanted = false;
  scr_pe_node = true;
  /* A deferred move runs as a dispatch ends, which may leave an exception
   * pending (what a listener threw, or the error nobody handled): it is
   * set aside for the registrations and pending again afterwards. */
  ScrCaught *pending = scr_exc_pending() ? scr_exc_take() : NULL;
  scr_pe_move(&scr_uncaught_ls[1], &scr_uncaught_n[1], &scr_uncaught_cap[1],
              SCR_UNCAUGHT_EVENT(true), front);
  scr_pe_move(&scr_uncaught_ls[0], &scr_uncaught_n[0], &scr_uncaught_cap[0],
              SCR_UNCAUGHT_EVENT(false), front);
  scr_pe_move(&scr_urj_listeners, &scr_nurj, &scr_urj_cap, "unhandledRejection", front);
  scr_pe_move(&scr_rjh_listeners, &scr_nrjh, &scr_rjh_cap, "rejectionHandled", front);
  scr_pe_move(&scr_mr_listeners, &scr_nmr, &scr_mr_cap, "multipleResolves", front);
  ScrDyn **warn = scr_warn_listeners;
  size_t nwarn = scr_nwarn;
  scr_warn_listeners = NULL;
  scr_nwarn = scr_warn_cap = 0;
  for (size_t k = 0; k < nwarn; k++) {
    size_t i = front ? nwarn - 1 - k : k;
    scr_ni_process_listen(front ? 2 : 0, "warning", warn[i]);
    if (scr_exc_pending()) scr_exc_clear();
    scr_dyn_release(warn[i]);
  }
  free(warn);
  /* The runtime's errors, rejections and warnings are raised through Node
   * from here on; units that report warnings by themselves while no
   * listener exists route them through the dispatch above. */
  scr_uncaught_exception_hook = scr_ni_uncaught;
  scr_urj_deliver_fn = NULL;
  scr_urj_node_fn = scr_ni_promise_unhandled;
  scr_rjh_notify_fn = scr_ni_promise_handled;
  scr_warning_emit_hook = scr_emit_warning;
  if (pending != NULL) {
    scr_rethrow(pending);
    scr_caught_release(pending);
  }
}

/* Node is loaded (scr_node_island.c, on the main thread). */
void scr_process_events_to_node(void) {
  if (scr_pe_node) return;
  if (scr_pe_dispatching > 0) scr_pe_wanted = true;
  else scr_pe_move_all();
}
#endif

/* A string warning with a type and an optional code, as
 * process.emitWarning(message, type, code) builds it. Borrows; +1. */
ScrDyn *scr_warning_new(ScrStr *message, const char *type, const ScrStr *code) {
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(e->name);
  e->name = scr_str_new(type, strlen(type));
  e->name_present = true;
  if (code) e->code = scr_str_retain((ScrStr *)code);
  ScrDyn *w = scr_dyn_from_error(e);
  scr_error_release(e);
  return w;
}

/* The EventEmitter leak warning: MaxListenersExceededWarning with the
 * `emitter`, `type` and `count` own properties Node's _addListener sets,
 * in that order. `type` is the event name VALUE (a symbol stays a symbol),
 * and `emitter` is an identity-bearing value of the emitter, so a listener
 * comparing it with the emitter it registered on sees one object. Borrows
 * every argument. */
static void scr_emit_leak_warning(ScrDyn *type, double count, ScrDyn *emitter, ScrStr *message) {
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(e->name);
  e->name = scr_str_new("MaxListenersExceededWarning", sizeof "MaxListenersExceededWarning" - 1);
  e->name_present = true;
  ScrDyn *w = scr_dyn_from_error(e);
  /* The values move in (scr_error_set_prop takes the reference). */
  scr_error_set_prop(e, "emitter", 7, scr_dyn_retain(emitter));
  scr_error_set_prop(e, "type", 4, scr_dyn_retain(type));
  scr_error_set_prop(e, "count", 5, scr_dyn_new_num(count));
#ifdef SCR_WARNING_REPLACE
  if (scr_emit_warning_override != NULL) {
    /* _addListener calls process.emitWarning(warning), so a replacement
     * receives the warning object itself. */
    ScrDyn *r = scr_dyn_call(scr_emit_warning_override, &w, 1, "process.emitWarning");
    scr_dyn_release(r);
  } else
#endif
    scr_warning_dispatch(w);
  scr_dyn_release(w);
  scr_error_release(e);
}

#ifdef SCR_WARNING_REPLACE
/* Compiled only into the SCR_WARNING_REPLACE variant, which programs
 * assigning process.emitWarning link: every other executable keeps the
 * plain warning paths. */
static void scr_emit_warning_override_teardown(void) {
  scr_dyn_release(scr_emit_warning_override);
  scr_emit_warning_override = NULL;
}

void scr_process_set_emit_warning(ScrDyn *fn) {
  if (scr_emit_warning_override == NULL) scr_atexit(scr_emit_warning_override_teardown);
  ScrDyn *previous = scr_emit_warning_override;
  scr_emit_warning_override = scr_dyn_retain(fn);
  scr_dyn_release(previous);
  /* Units that report their own warnings without a listener route them
   * here once a replacement exists. */
  scr_warning_emit_hook = scr_emit_warning;
  scr_warning_leak_hook = scr_emit_leak_warning;
}

/* A runtime-built warning while a replacement is installed: Node's modules
 * call process.emitWarning(message, type, code), so the replacement sees
 * those arguments; nothing is reported. A throw stays pending.
 * `undefined_ctor` adds Node's fourth argument (the deprecation
 * constructor) as undefined, which getDeprecationWarningEmitter's callers
 * pass that way (DEP0203). */
static void scr_emit_warning_replaced(ScrStr *message, ScrStr *type, ScrStr *code, bool undefined_ctor) {
  ScrDyn *args[4];
  size_t argc = 0;
  args[argc++] = scr_dyn_new_str(message);
  ScrStr *fallback = type ? NULL : scr_str_new("Warning", 7);
  args[argc++] = scr_dyn_new_str(type ? type : fallback);
  scr_str_release(fallback);
  if (code) args[argc++] = scr_dyn_new_str(code);
  if (undefined_ctor) args[argc++] = scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *r = scr_dyn_call(scr_emit_warning_override, args, argc, "process.emitWarning");
  scr_dyn_release(r);
  for (size_t i = 0; i < argc; i++) scr_dyn_release(args[i]);
}
#endif /* SCR_WARNING_REPLACE */

/* A warning built from C parts (the runtime deprecation sites): name
 * defaults to "Warning"; code/detail optional. Reported synchronously.
 * Borrows message. */
static void scr_emit_warning_impl(const char *name, const char *code, ScrStr *message) {
#ifdef SCR_WARNING_REPLACE
  if (scr_emit_warning_override != NULL) {
    ScrStr *type_text = scr_str_new(name ? name : "Warning", strlen(name ? name : "Warning"));
    ScrStr *code_text = code ? scr_str_new(code, strlen(code)) : NULL;
    scr_emit_warning_replaced(message, type_text, code_text, false);
    scr_str_release(type_text);
    scr_str_release(code_text);
    return;
  }
#endif
  ScrStr *code_text = code ? scr_str_new(code, strlen(code)) : NULL;
  ScrDyn *w = scr_warning_new(message, name ? name : "Warning", code_text);
  scr_str_release(code_text);
  scr_warning_dispatch(w);
  scr_dyn_release(w);
}

void scr_emit_warning(const char *name, const char *code, ScrStr *message) {
  scr_emit_warning_impl(name, code, message);
}

/* DEP0203: node:crypto converting a CryptoKey key argument is deprecated.
 * Node reports it once per process through
 * getDeprecationWarningEmitter('DEP0203'), so a replacement sees it at the
 * call (with the emitter's four arguments) and the default report comes on
 * the next tick, dropped while process.noDeprecation is set and thrown
 * while process.throwDeprecation is set, as for the other runtime
 * deprecations. Every program that can hold a CryptoKey links this unit:
 * the WebCrypto calls that produce one settle through an awaited or
 * then-reaction value that selects it. */
static SCR_TL bool scr_dep0203_emitted = false;

static void scr_dep0203(void) {
  if (scr_dep0203_emitted) return;
  scr_dep0203_emitted = true;
  static const char text[] = "Passing a CryptoKey to node:crypto functions is deprecated.";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrStr *code = scr_str_new("DEP0203", sizeof "DEP0203" - 1);
  ScrDyn *w = scr_warning_new(message, "DeprecationWarning", code);
  scr_warning_emit_deferred_undefined_ctor(w);
  scr_dyn_release(w);
  scr_str_release(code);
  scr_str_release(message);
}

__attribute__((constructor)) static void scr_dep0203_install(void) {
  scr_crypto_deprecate_crypto_key = scr_dep0203;
}

/* Node's emitWarning tail for runtime-built warnings: deprecations are
 * dropped while process.noDeprecation is set and thrown from their own
 * tick while process.throwDeprecation is set; every other warning reaches
 * the report and the 'warning' listeners on the next tick. */
static void scr_warning_tick(ScrClosure *c) {
  ScrDyn *w = scr_box_get_ref(c->caps[0]);
  scr_warning_dispatch(w);
  scr_dyn_release(w);
}

static void scr_warning_throw_tick(ScrClosure *c) {
  /* Thrown as the Error it encodes, so the uncaught report and catch
   * bindings see an Error. */
  scr_dyn_throw(scr_box_get_ref(c->caps[0]));
}

static void scr_warning_defer(ScrDyn *w, void (*fire)(ScrClosure *)) {
  ScrClosure *c = scr_closure_new((void *)fire, 1);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(c->caps[0], scr_dyn_retain(w));
  scr_next_tick(c);
}

static void scr_warning_emit_deferred_impl(ScrDyn *w, bool undefined_ctor) {
#ifdef SCR_WARNING_REPLACE
  if (scr_emit_warning_override != NULL) {
    const ScrDyn *em = scr_dyn_obj_get(w, "message", 7);
    const ScrDyn *ec = scr_dyn_obj_get(w, "code", 4);
    ScrStr *name = scr_warning_name(w);
    ScrStr *message = em && em->kind == SCR_DYN_STR ? scr_str_retain(em->v.str) : scr_str_new("", 0);
    scr_emit_warning_replaced(message, name, ec && ec->kind == SCR_DYN_STR ? ec->v.str : NULL,
                              undefined_ctor);
    scr_str_release(message);
    scr_str_release(name);
    return;
  }
#else
  (void)undefined_ctor;
#endif
  if (scr_warning_is_deprecation(w)) {
    if (scr_process_deprecation_flag_on(0)) return;
    if (scr_process_deprecation_flag_on(1)) {
      scr_warning_defer(w, scr_warning_throw_tick);
      return;
    }
  }
  scr_warning_defer(w, scr_warning_tick);
}

void scr_warning_emit_deferred(ScrDyn *w) { scr_warning_emit_deferred_impl(w, false); }

/* The same, for a deprecation Node emits through getDeprecationWarningEmitter:
 * a replacement sees its fourth argument (the deprecation constructor) as
 * undefined. */
void scr_warning_emit_deferred_undefined_ctor(ScrDyn *w) {
  scr_warning_emit_deferred_impl(w, true);
}

static SCR_TL bool scr_punycode_loaded = false;

void scr_punycode_warn(bool immediate, bool report) {
  if (scr_punycode_loaded) return;
  scr_punycode_loaded = true;
  if (!report) return;
  static const char text[] =
      "The `punycode` module is deprecated. Please use a userland alternative instead.";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrStr *code = scr_str_new("DEP0040", 7);
  ScrDyn *w = scr_warning_new(message, "DeprecationWarning", code);
  if (immediate) {
    if (!scr_process_deprecation_flag_on(0)) scr_warning_dispatch(w);
  } else {
    scr_warning_emit_deferred(w);
  }
  scr_dyn_release(w);
  scr_str_release(code);
  scr_str_release(message);
}


static void scr_timer_this_fire(ScrClosure *self) {
  ScrClosure *cb = scr_box_get_ref(self->caps[0]);
  double handle = scr_timer_running_handle();
  ScrDyn *receiver = handle != 0 ? scr_dyn_new_num(handle) : scr_dyn_undefined();
  scr_dyn_this_push_dyn_once(receiver);
  ((void (*)(ScrClosure *))cb->fn)(cb);
  scr_dyn_this_pop();
  scr_dyn_release(receiver);
  scr_closure_release(cb);
}

ScrClosure *scr_timer_this_callback(ScrClosure *cb) {
  ScrClosure *bound = scr_closure_new((void *)scr_timer_this_fire, 1);
  bound->caps[0] = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(bound->caps[0], scr_closure_retain(cb));
  return bound;
}

void scr_buffer_deprecation(void) {
  /* Node's showFlaggedDeprecation: after 10000 calls the check stops. */
  if (scr_buffer_ctor_warned || ++scr_buffer_ctor_checks > 10000) return;
  static const char text[] =
      "Buffer() is deprecated due to security and usability issues. Please use the "
      "Buffer.alloc(), Buffer.allocUnsafe(), or Buffer.from() methods instead.";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrStr *code = scr_str_new("DEP0005", 7);
  ScrDyn *w = scr_warning_new(message, "DeprecationWarning", code);
  scr_warning_emit_deferred(w);
  scr_dyn_release(w);
  scr_str_release(code);
  scr_str_release(message);
  scr_buffer_ctor_warned = true;
}

/* assert.fail(actual, expected, ...) reports DEP0094 on the first
 * multi-argument call, as Node's deprecate() wrapper does. */
void scr_assert_fail_deprecation(void) {
  static SCR_TL bool warned = false;
  if (warned) return;
  warned = true;
  static const char text[] =
      "assert.fail() with more than one argument is deprecated. Please use "
      "assert.strictEqual() instead or only pass a message.";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrStr *code = scr_str_new("DEP0094", 7);
  ScrDyn *w = scr_warning_new(message, "DeprecationWarning", code);
  scr_warning_emit_deferred(w);
  scr_dyn_release(w);
  scr_str_release(code);
  scr_str_release(message);
}

/* SlowBuffer(size): Node 24's deprecate() wrapper reports DEP0030 on the
 * first call, then allocUnsafeSlow validates the size (a number,
 * ERR_INVALID_ARG_TYPE otherwise; ERR_OUT_OF_RANGE past [0, kMaxLength])
 * and allocates a Buffer outside the pool. +1, or NULL with the exception
 * pending. */
static SCR_TL bool scr_slow_buffer_warned = false;

ScrBytes *scr_buffer_slow(const ScrDyn *size) {
  if (!scr_slow_buffer_warned) {
    scr_slow_buffer_warned = true;
    static const char text[] = "SlowBuffer() is deprecated. Please use Buffer.allocUnsafeSlow()";
    ScrStr *message = scr_str_new(text, sizeof text - 1);
    ScrStr *code = scr_str_new("DEP0030", 7);
    ScrDyn *w = scr_warning_new(message, "DeprecationWarning", code);
    scr_warning_emit_deferred(w);
    scr_dyn_release(w);
    scr_str_release(code);
    scr_str_release(message);
  }
  if (size->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("size", "of type number", size);
    return NULL;
  }
  ScrBytes *bytes = scr_buffer_alloc_unsafe_slow(size->v.num);
  if (bytes) bytes->is_buffer = true;
  return bytes;
}

/* The console members' warnings. Node's emitWarning emits on
 * process.nextTick, so these queue in order and each rides one raw tick
 * on the shared tick queue; any left at exit are dropped with it. */
static SCR_TL ScrStr **scr_warn_texts = NULL;
static SCR_TL size_t scr_warn_texts_head = 0, scr_warn_texts_len = 0, scr_warn_texts_cap = 0;
static SCR_TL bool scr_warn_texts_registered = false;

static void scr_warn_texts_teardown(void) {
  for (size_t i = scr_warn_texts_head; i < scr_warn_texts_len; i++) scr_str_release(scr_warn_texts[i]);
  free(scr_warn_texts);
  scr_warn_texts = NULL;
  scr_warn_texts_head = scr_warn_texts_len = scr_warn_texts_cap = 0;
}

static void scr_warn_text_tick(void) {
  if (scr_warn_texts_head == scr_warn_texts_len) return;
  ScrStr *message = scr_warn_texts[scr_warn_texts_head++];
  if (scr_warn_texts_head == scr_warn_texts_len) scr_warn_texts_head = scr_warn_texts_len = 0;
  scr_emit_warning(NULL, NULL, message);
  scr_str_release(message);
}

void scr_process_emit_warning_text(ScrStr *message) {
  if (message->len == 0) return;
  if (!scr_warn_texts_registered) {
    scr_warn_texts_registered = true;
    scr_atexit(scr_warn_texts_teardown);
  }
  if (scr_warn_texts_len == scr_warn_texts_cap) {
    size_t cap = scr_warn_texts_cap ? scr_warn_texts_cap * 2 : 4;
    ScrStr **grown = realloc(scr_warn_texts, cap * sizeof *grown);
    if (!grown) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
    scr_warn_texts = grown;
    scr_warn_texts_cap = cap;
  }
  scr_warn_texts[scr_warn_texts_len++] = scr_str_retain(message);
  scr_next_tick_raw(scr_warn_text_tick);
}

/* A dyn value of kind STR equal to `text`. */
static bool scr_warn_str_is(const ScrDyn *value, const char *text) {
  size_t n = strlen(text);
  return value != NULL && value->kind == SCR_DYN_STR && value->v.str->len == n &&
         memcmp(value->v.str->data, text, n) == 0;
}

/* process.emitWarning(warning, type, code, ctor) in the order Node's
 * lib/internal/process/warning.js runs it:
 *   - a "DeprecationWarning" type string returns at once while
 *     process.noDeprecation is set;
 *   - an options object (any non-array object) replaces type with
 *     `options.type || "Warning"` and code with `options.code`, and keeps
 *     a string `options.detail`; a function in the type position is the
 *     ctor and clears code;
 *   - type, when not undefined, and code, when neither undefined nor a
 *     function, must be strings, for Error warnings too;
 *   - the warning must be a string or an Error.
 * Wrong kinds throw ERR_INVALID_ARG_TYPE TypeErrors with Node's message.
 * A string warning becomes an Error named `type || "Warning"`. The warning
 * is emitted on the next tick. Borrows its arguments; NULL is an omitted
 * argument. */
static void scr_emit_warning_args(const ScrDyn *warning, const ScrDyn *type, const ScrDyn *code) {
  const ScrDyn *detail = NULL;
  if (scr_warn_str_is(type, "DeprecationWarning") && scr_process_deprecation_flag_on(0)) return;
  if (type != NULL && type->kind == SCR_DYN_OBJ) {
    const ScrDyn *t = scr_dyn_obj_get(type, "type", 4);
    const ScrDyn *d = scr_dyn_obj_get(type, "detail", 6);
    code = scr_dyn_obj_get(type, "code", 4);
    if (d != NULL && d->kind == SCR_DYN_STR) detail = d;
    type = t != NULL && scr_dyn_truthy(t) ? t : NULL;
  } else if (type != NULL && type->kind == SCR_DYN_FUNC) {
    type = NULL;
    code = NULL;
  }
  if (type != NULL && type->kind == SCR_DYN_UNDEF) type = NULL;
  if (type != NULL && type->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("type", "of type string", type);
    return;
  }
  if (code != NULL && (code->kind == SCR_DYN_FUNC || code->kind == SCR_DYN_UNDEF)) code = NULL;
  if (code != NULL && code->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("code", "of type string", code);
    return;
  }
  /* An Error warning, an instance of an Error subclass included, keeps
   * its own name and code (Node). */
  ScrError *error = scr_errdyn_err_of(warning);
  if (error != NULL || (warning->kind == SCR_DYN_OBJ && scr_dyn_obj_get(warning, "%error", 6) != NULL) ||
      scr_dyn_ref_is_error(warning)) {
    scr_error_release(error);
    scr_warning_emit_deferred((ScrDyn *)warning);
    return;
  }
  if (warning->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("warning", "of type string or an instance of Error", warning);
    return;
  }
  ScrError *e = scr_error_new(SCR_ERR_ERROR, warning->v.str);
  scr_str_release(e->name);
  e->name = type != NULL && type->v.str->len > 0 ? scr_str_retain(type->v.str) : scr_str_new("Warning", 7);
  e->name_present = true;
  if (code != NULL) e->code = scr_str_retain(code->v.str);
  if (detail != NULL) scr_error_set_prop(e, "detail", 6, scr_dyn_new_str(detail->v.str)); /* retains */
  ScrDyn *w = scr_dyn_from_error(e);
  scr_error_release(e);
  scr_warning_emit_deferred(w);
  scr_dyn_release(w);
}

void scr_process_emit_warning(ScrDyn *args) {
#ifdef SCR_WARNING_REPLACE
  if (scr_emit_warning_override != NULL) {
    ScrDyn *r = scr_dyn_apply(scr_emit_warning_override, args, "process.emitWarning");
    scr_dyn_release(r);
    return;
  }
#endif
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  const ScrDyn *type = argc >= 2 ? items[1] : NULL;
  /* A typed record in the options position reads as the object it is. */
  ScrDyn *options = NULL;
  if (type != NULL && type->kind == SCR_DYN_TYPED_REF && !scr_dyn_ref_is_array(type)) {
    options = scr_dyn_typed_ref_materialize(type);
    if (options == NULL || scr_exc_pending()) {
      scr_dyn_release(options);
      return;
    }
    type = options;
  }
  scr_emit_warning_args(argc >= 1 ? items[0] : scr_dyn_undefined(), type, argc >= 3 ? items[2] : NULL);
  scr_dyn_release(options);
}

/* Whether `name` spells `lit` (a length-and-bytes compare; event names are
 * ASCII). */
static bool scr_emit_name_is(const ScrStr *name, const char *lit, size_t len) {
  return name->len == len && memcmp(name->data, lit, len) == 0;
}

#define SCR_EMIT_IS(name, lit) scr_emit_name_is((name), (lit), sizeof(lit) - 1)

/* process.emit(event, ...args): Node's EventEmitter emit on process for the
 * exception families, whose listeners this unit registers as checked-dynamic
 * callbacks. The compiler lowers only these two names here; a custom name
 * becomes the literal false and every other family is refused (its listeners
 * are typed closures, or its emit carries default handling of its own), so
 * an unknown name cannot reach this entry. Answers whether any listener
 * existed, Node's return value; a listener's throw stays pending for the
 * call's check. */
bool scr_process_emit_named(ScrDyn *event, ScrDyn *args) {
#ifdef SCR_NODE_ISLANDS
  /* Node's own `process` owns the listeners in an island program; the
   * compiler refuses the call there rather than dispatch the wrong list. */
  if (scr_pe_node) return false;
#endif
  if (event == NULL || event->kind != SCR_DYN_STR) return false;
  size_t argc = args != NULL && args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn **items = args != NULL && args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  const ScrStr *name = event->v.str;
  if (SCR_EMIT_IS(name, "uncaughtException") || SCR_EMIT_IS(name, "uncaughtExceptionMonitor")) {
    size_t k = SCR_EMIT_IS(name, "uncaughtExceptionMonitor") ? 1 : 0;
    if (scr_uncaught_n[k] == 0) return false;
    SCR_PE_ENTER();
    (void)scr_rej_fire(&scr_uncaught_ls[k], &scr_uncaught_n[k], items, argc);
    scr_uncaught_sync_hook();
    SCR_PE_LEAVE();
    return true;
  }
  return false;
}

/* process.emit('error', ...): no 'error' listener can be registered on
 * process here, so Node's EventEmitter contract throws. An Error payload
 * throws itself; any other payload throws ERR_UNHANDLED_ERROR whose message
 * quotes it (the primitive payloads this unit renders, as the events unit
 * does; an object payload is refused there and here). */
void scr_process_emit_error(ScrDyn *args) {
  const ScrDyn *er =
      args != NULL && args->kind == SCR_DYN_ARR && args->v.arr.len > 0
          ? args->v.arr.items[0]
          : scr_dyn_undefined();
  if (scr_dyn_err_instanceof(er, SCR_ERR_ERROR)) {
    scr_dyn_throw(scr_dyn_retain((ScrDyn *)er));
    return;
  }
  ScrJsonBuf shown_buf;
  scr_jb_init(&shown_buf);
  bool shown = true;
  switch (er->kind) {
  case SCR_DYN_UNDEF: scr_jb_puts(&shown_buf, "undefined"); break;
  case SCR_DYN_NULL: scr_jb_puts(&shown_buf, "null"); break;
  case SCR_DYN_BOOL: scr_jb_puts(&shown_buf, er->v.b ? "true" : "false"); break;
  case SCR_DYN_NUM: {
    char num[32];
    if (er->v.num == 0 && 1 / er->v.num < 0) {
      scr_jb_puts(&shown_buf, "-0");
    } else {
      size_t len = scr_f64_to_str(er->v.num, num);
      scr_jb_write(&shown_buf, num, len);
    }
    break;
  }
  case SCR_DYN_STR: {
    const ScrStr *s = er->v.str;
    for (size_t i = 0; i < s->len && shown; i++) {
      unsigned char c = (unsigned char)s->data[i];
      if (c < 0x20 || c == 0x7f || c == '\'' || c == '\\') shown = false;
    }
    if (s->len > 10000) shown = false;
    if (shown) {
      scr_jb_putc(&shown_buf, '\'');
      scr_jb_write(&shown_buf, s->data, s->len);
      scr_jb_putc(&shown_buf, '\'');
    }
    break;
  }
  default: shown = false; break;
  }
  ScrStr *shown_text = scr_jb_finish(&shown_buf);
  if (!shown) {
    scr_str_release(shown_text);
    static const char refusal[] =
        "emit('error') through an untyped value with this non-Error payload and no 'error' listener is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, refusal, sizeof refusal - 1, "SC2020");
    return;
  }
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "Unhandled error. (");
  scr_jb_write(&text, shown_text->data, shown_text->len);
  scr_jb_putc(&text, ')');
  ScrStr *message = scr_jb_finish(&text);
  scr_str_release(shown_text);
  ScrError *err = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_error_set_code(err, "ERR_UNHANDLED_ERROR");
  scr_error_set_prop(err, "context", 7, scr_dyn_retain((ScrDyn *)er));
  scr_throw_obj(err, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* A caught-exception snapshot as a dyn value — identity-preserving for
 * dyn payloads (a dyn-thrown value is retained, not copied), the
 * identity-cached %error encoding above for Error-family objects,
 * scalars by value, the type-erased empty object for the rest
 * (SEMANTICS.md 67). Shared by the dc trace choreography, the checked-dynamic tree
 * promise reactions, and the unhandled-rejection dispatch. Borrows the
 * box; result +1. */

/* Await a dyn-CROSSING promise (SCR_DYN_PROMISE's boundary contract —
 * dyn or void fulfillment): the payload as a dyn value (+1; a void
 * fulfillment answers the undefined value, and the defensive scalar arms
 * cover payload kinds a direct box could theoretically carry), or NULL
 * with the rejection re-thrown into the awaiter. */
static ScrDyn *scr_dyn_promise_payload(ScrPromise *p);

ScrDyn *scr_await_dyn(ScrPromise *p) {
  if (!scr_promise_await_settled(p)) return NULL;
  return scr_dyn_promise_payload(p);
}

/* A fulfilled dyn-crossing promise's payload as a dyn value (+1). */
static ScrDyn *scr_dyn_promise_payload(ScrPromise *p) {
  switch (scr_promise_payload_kind(p)) {
  case SCR_EXC_F64: return scr_dyn_new_num(scr_promise_payload_num(p));
  case SCR_EXC_BOOL: return scr_dyn_new_bool(scr_promise_payload_flag(p));
  case SCR_EXC_STR: {
    ScrStr *v = scr_promise_payload_str(p);
    ScrDyn *d = scr_dyn_new_str(v); /* retains */
    scr_str_release(v);
    return d;
  }
  case SCR_EXC_REF: {
    void *v = scr_promise_payload_ref(p);
    if (v) return (ScrDyn *)v; /* the dyn contract: a retained dyn */
    return scr_dyn_retain(scr_dyn_undefined());
  }
  default:
    return scr_dyn_retain(scr_dyn_undefined());
  }
}

/* The rejection reason as a dyn value — the scr_caught_to_dyn stances
 * over a promise's payload slot (identity-preserving for dyn-thrown
 * values and %Error instances). */
ScrDyn *scr_promise_reason_dyn(const ScrPromise *p) {
  switch (scr_promise_payload_kind(p)) {
  case SCR_EXC_F64: return scr_dyn_new_num(scr_promise_payload_num(p));
  case SCR_EXC_BOOL: return scr_dyn_new_bool(scr_promise_payload_flag(p));
  case SCR_EXC_STR: {
    ScrStr *v = scr_promise_payload_str((ScrPromise *)p);
    ScrDyn *d = scr_dyn_new_str(v); /* retains */
    scr_str_release(v);
    return d;
  }
  case SCR_EXC_REF:
  case SCR_EXC_PRIMITIVE_REF: {
    void *v = scr_promise_payload_ref((ScrPromise *)p);
    if (v == NULL) return scr_dyn_new_obj();
    if (scr_promise_payload_is_dyn(p)) return (ScrDyn *)v; /* retained */
    ScrDyn *d = scr_dyn_new_obj();
    /* release the generic +1 the accessor took */
    scr_promise_payload_release(p, v);
    return d;
  }
  case SCR_EXC_OBJ: {
    void *v = scr_promise_payload_ref((ScrPromise *)p);
    if (v != NULL && scr_error_is(v)) {
      ScrDyn *d = scr_dyn_from_error((const ScrError *)v);
      scr_promise_payload_release(p, v);
      return d;
    }
    if (v != NULL) scr_promise_payload_release(p, v);
    return scr_dyn_new_obj();
  }
  default:
    return scr_dyn_retain(scr_dyn_undefined());
  }
}

/* ── promises in the checked-dynamic tree (SCR_DYN_PROMISE) ────────────────────────────
 * Reference boxes over the fiber machinery's ScrPromise (scr_runtime.h's
 * design note). The boundary contract — a boxed promise settles with a
 * dyn payload — is the CALLERS' to keep: the compiler's converters box
 * promise<dyn> directly and every other inner type through the adapting
 * constructor below. */

SCR_TL extern bool (*scr_dyn_promise_identity_fn)(ScrPromise *, ScrPromise *);

/* Promise.prototype.then, catch and finally as function values: one FUNC
 * box per method and thread. A call reads its receiver from the ambient
 * binding (`p.then.call(p, f)`, or the method read off the promise and
 * called on it); a receiver that is not a promise throws Node's
 * incompatible-receiver TypeError. */
static const char *const scr_dyn_promise_method_names[3] = {"then", "catch", "finally"};
static SCR_TL ScrDyn *scr_dyn_promise_methods[3];

static void scr_dyn_promise_methods_cleanup(void) {
  for (size_t i = 0; i < 3; i++) {
    if (scr_dyn_promise_methods[i]) scr_dyn_release(scr_dyn_promise_methods[i]);
    scr_dyn_promise_methods[i] = NULL;
  }
}

static void scr_dyn_throw_incompatible_receiver(const char *method, const ScrDyn *self) {
  char shown[64];
  const char *text = "#<Object>";
  if (scr_dyn_is_nullish(self)) {
    text = self->kind == SCR_DYN_NULL ? "null" : "undefined";
  } else if (self->kind == SCR_DYN_BOOL) {
    text = self->v.b ? "true" : "false";
  } else if (self->kind == SCR_DYN_STR) {
    snprintf(shown, sizeof shown, "%.*s", (int)(self->v.str->len < 48 ? self->v.str->len : 48), self->v.str->data);
    text = shown;
  } else if (self->kind == SCR_DYN_NUM) {
    ScrStr *s = scr_f64_to_scrstr(self->v.num);
    snprintf(shown, sizeof shown, "%.*s", (int)s->len, s->data);
    scr_str_release(s);
    text = shown;
  }
  char message[160];
  int len = snprintf(message, sizeof message,
                     "Method Promise.prototype.%s called on incompatible receiver %s", method, text);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)len);
}

static ScrDyn *scr_dyn_promise_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  size_t which = (size_t)scr_box_get_f64(closure->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  ScrPromise *promise = scr_dyn_promise_of(self);
  if (!promise) {
    scr_dyn_throw_incompatible_receiver(scr_dyn_promise_method_names[which], self);
    scr_dyn_release(self);
    return NULL;
  }
  ScrDyn *first = argc >= 1 ? args[0] : NULL;
  ScrDyn *result = which == 0   ? scr_dyn_promise_then(promise, first, argc >= 2 ? args[1] : NULL, NULL)
                   : which == 1 ? scr_dyn_promise_then(promise, NULL, first, NULL)
                                : scr_dyn_promise_then(promise, NULL, NULL, first);
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_dyn_promise_member(const char *key, size_t len) {
  for (size_t i = 0; i < 3; i++) {
    const char *name = scr_dyn_promise_method_names[i];
    if (strlen(name) != len || memcmp(name, key, len) != 0) continue;
    if (!scr_dyn_promise_methods[i]) {
      if (!scr_dyn_promise_methods[0] && !scr_dyn_promise_methods[1] &&
          !scr_dyn_promise_methods[2])
        scr_atexit(scr_dyn_promise_methods_cleanup);
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], (double)i);
      scr_dyn_promise_methods[i] =
          scr_dyn_new_func(closure, scr_dyn_promise_method_call, i == 0 ? 2 : 1, "", name);
    }
    return scr_dyn_retain(scr_dyn_promise_methods[i]);
  }
  return NULL;
}

/* The inspect unit reads a boxed promise through this reader: the state
 * flags and, once settled, the outcome the boxed payload carries. */
static void scr_dyn_promise_inspect(const ScrPromise *p, bool *pending, bool *rejected,
                                    ScrDyn **value) {
  *pending = scr_promise_is_pending(p);
  *rejected = !*pending && scr_promise_is_rejected(p);
  *value = *pending ? NULL : scr_promise_reason_dyn(p);
}

ScrDyn *scr_dyn_new_promise(ScrPromise *p) {
  scr_dyn_promise_identity_fn = scr_promise_identity_equal;
  scr_dyn_promise_member_fn = scr_dyn_promise_member;
  scr_promise_inspect_dyn_fn = scr_dyn_promise_inspect;
  ScrDyn *d = scr_dyn_alloc_promise(scr_promise_release);
  d->v.promise = scr_promise_retain(p);
  return d;
}

/* The stream unit's [Symbol.asyncDispose]() answers through this hook: the
 * promise it creates is boxed here. The reference is weak because an async
 * program without the stream unit links this one alone. */
extern ScrDyn *(*scr_stream_promise_box_hook)(ScrPromise *) __attribute__((weak));

__attribute__((constructor)) static void scr_async_dyn_install_stream_hook(void) {
  if (&scr_stream_promise_box_hook) scr_stream_promise_box_hook = scr_dyn_new_promise;
}

/* The typed-inner box: a fresh destination promise parked on `src`
 * through the Promise.race cb-waiter machinery — `adapt` (emitted,
 * per-inner-type) converts the fulfillment payload into a dyn value and
 * fulfills the destination; rejections copy raw inside the machinery and
 * count as HANDLED on src (the box is the tracked promise, like a JS
 * .then chain). Already-settled sources adapt inline. Borrows src; +1. */
ScrDyn *scr_dyn_new_promise_adapting(ScrPromise *src,
                                     void (*adapt)(ScrPromise *dst, ScrPromise *src)) {
  ScrPromise *dst = scr_promise_new();
  scr_promise_share_identity(dst, src);
  scr_dyn_promise_identity_fn = scr_promise_identity_equal;
  scr_dyn_promise_member_fn = scr_dyn_promise_member;
  scr_promise_inspect_dyn_fn = scr_dyn_promise_inspect;
  scr_promise_race_add(dst, src, adapt);
  ScrDyn *d = scr_dyn_alloc_promise(scr_promise_release);
  d->v.promise = dst; /* the constructor's +1 moves in */
  return d;
}

ScrPromise *scr_dyn_promise_of(const ScrDyn *d) {
  return d->kind == SCR_DYN_PROMISE ? d->v.promise : NULL;
}

static void scr_dyn_all_result(ScrPromise *destination, ScrPromise *source) {
  ScrArr *values = scr_promise_payload_ref(source);
  ScrDyn *result = scr_dyn_new_arr();
  for (size_t i = 0; i < values->len; i++) scr_dyn_arr_push(result, scr_arr_get_ref(values, (double)i));
  scr_arr_release(values);
  scr_promise_fulfill_ref(destination, result, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

static ScrArrOps scr_dyn_arr_ops = { scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v };

/* ── Thenable adoption (PromiseResolve over a checked-dynamic value) ──
 * A non-promise object whose `then` is callable resolves through
 * NewPromiseResolveThenableJob: one microtask later `then` runs with the
 * thenable as `this` and a fresh resolve/reject pair, the first call of
 * which wins (a throw after it is ignored; a throw before it rejects).
 * The resolve function follows the full resolution procedure: native
 * promises adopt through scr_promise_resolve_dyn (its job then
 * reaction), further thenables queue another job, everything else
 * fulfills. */
typedef struct {
  size_t rc;
  bool called;
  ScrPromise *promise;
  ScrDyn *reader;   /* the then reader for further thenables (+1, or NULL) */
  ScrDyn *thenable; /* +1 until the job runs */
  ScrDyn *then;     /* +1 until the job runs */
} ScrDynThenState;

static void *scr_dyn_then_state_retain_v(void *p) {
  ((ScrDynThenState *)p)->rc++;
  return p;
}

static void scr_dyn_then_state_release_v(void *p) {
  ScrDynThenState *state = p;
  if (--state->rc > 0) return;
  scr_promise_release(state->promise);
  scr_dyn_release(state->reader);
  scr_dyn_release(state->thenable);
  scr_dyn_release(state->then);
  free(state);
}

static void scr_dyn_thenable_schedule(ScrPromise *target, const ScrDyn *thenable, const ScrDyn *then,
                                      const ScrDyn *reader);

/* The `then` of a resolution value: +1 when callable, NULL otherwise or
 * when the read threw (the exception stays pending). Program class
 * instances read through `reader`, the compiled property dispatch (no
 * reader: their own fields only). */
ScrDyn *scr_dyn_thenable_function(const ScrDyn *value, const ScrDyn *reader) {
#ifdef SCR_NODE_ISLANDS
  /* An island object or function: V8 reads its `then`, and a callable one
   * makes it a thenable like any other. The thenable job calls it in Node
   * with the island value as `this` and the native resolving functions
   * (scr_dyn_call calls an island function with the ambient receiver), so
   * every resolution adopts it: Promise.resolve, a combinator's entry, an
   * async function's return, an executor's resolve, and the operand of
   * `await` (scr_node_island_adopt_thenable). A worker thread holds island
   * values too: its read of `then` is routed to the island's thread like
   * every read, and its thenable job rejects by name, because the resolving
   * functions it would pass are this thread's and cannot cross
   * (ERR_SCRIPTC_ISLAND_WORKER_VALUE). Answering "not a thenable" there
   * would fulfil with the thenable itself, where Node adopts it. */
  if (scr_ni_dyn_handle(value)) {
    if (scr_ni_dyn_ops == NULL) return NULL;
    ScrDyn *island_then = scr_ni_dyn_ops->get_str((ScrDyn *)value, "then", 4);
    if (island_then != NULL && scr_dyn_is_callable(island_then)) return island_then;
    scr_dyn_release(island_then);
    return NULL;
  }
#endif
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_FUNC && value->kind != SCR_DYN_PROXY &&
      value->kind != SCR_DYN_TYPED_REF)
    return NULL;
  ScrDyn *then = NULL;
  if (value->kind == SCR_DYN_TYPED_REF && reader) {
    ScrDyn *arg = (ScrDyn *)value;
    then = scr_dyn_call(reader, &arg, 1, "then");
  } else if (value->kind == SCR_DYN_PROXY) {
    ScrStr *key = scr_str_new("then", 4);
    then = scr_dyn_proxy_get(value, key);
    scr_str_release(key);
  } else if (value->kind == SCR_DYN_FUNC) {
    then = scr_dyn_fn_get(value, "then", 4);
  } else if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    if (view) then = scr_dyn_obj_read(view, "then", 4);
    scr_dyn_release(view);
  } else {
    then = scr_dyn_obj_read(value, "then", 4);
  }
  if (then && then->kind == SCR_DYN_FUNC) return then;
  scr_dyn_release(then);
  return NULL;
}

/* Resolves `target` with `value` (borrowed). Inlined into both callers, so
 * the code of scr_dyn_then_resolve_call does not depend on whether a
 * program links scr_dyn_promise_resolve_with. */
__attribute__((always_inline)) static inline void scr_dyn_resolve_value(ScrPromise *target, ScrDyn *value,
                                                                const ScrDyn *reader) {
  if (value->kind == SCR_DYN_PROMISE) {
    scr_promise_resolve_dyn(target, scr_dyn_retain(value));
    return;
  }
  ScrDyn *then = scr_dyn_thenable_function(value, reader);
  if (scr_exc_pending()) {
    scr_promise_reject_pending(target);
  } else if (then) {
    scr_dyn_thenable_schedule(target, value, then, reader);
  } else {
    scr_promise_fulfill_ref(target, scr_dyn_retain(value), scr_dyn_retain_v, scr_dyn_release_v,
                            scr_dyn_trace_v);
  }
  scr_dyn_release(then);
}

/* The job and both resolving functions share one box holding the state;
 * box reads (scr_box_get_ref) answer +1 references. */
static ScrDyn *scr_dyn_then_resolve_call(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrDynThenState *state = scr_box_get_ref(cb->caps[0]);
  if (!state->called) {
    state->called = true;
    scr_dyn_resolve_value(state->promise, argc ? args[0] : scr_dyn_undefined(), state->reader);
  }
  scr_dyn_then_state_release_v(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_dyn_then_reject_call(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrDynThenState *state = scr_box_get_ref(cb->caps[0]);
  if (!state->called) {
    state->called = true;
    scr_dyn_throw(scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()));
    scr_promise_reject_pending(state->promise);
  }
  scr_dyn_then_state_release_v(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_dyn_then_function(ScrBox *box, ScrDynThunk thunk) {
  ScrClosure *closure = scr_closure_new((void *)thunk, 1);
  closure->caps[0] = scr_box_retain(box);
  return scr_dyn_new_func(closure, thunk, 1, "(value)", "");
}

static void scr_dyn_thenable_job(ScrClosure *job) {
  ScrDynThenState *state = scr_box_get_ref(job->caps[0]);
  ScrDyn *thenable = state->thenable;
  ScrDyn *then = state->then;
  state->thenable = state->then = NULL; /* the references move here */
  ScrDyn *args[2] = {
    scr_dyn_then_function(job->caps[0], scr_dyn_then_resolve_call),
    scr_dyn_then_function(job->caps[0], scr_dyn_then_reject_call),
  };
  scr_dyn_this_push_dyn(thenable);
  ScrDyn *result = scr_dyn_call(then, args, 2, "then");
  scr_dyn_this_pop();
  if (result) {
    scr_dyn_release(result);
  } else if (!state->called) {
    state->called = true;
    scr_promise_reject_pending(state->promise);
  } else {
    scr_exc_clear();
  }
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_dyn_release(then);
  scr_dyn_release(thenable);
  scr_dyn_then_state_release_v(state);
}

static void scr_dyn_thenable_schedule(ScrPromise *target, const ScrDyn *thenable, const ScrDyn *then,
                                      const ScrDyn *reader) {
  ScrDynThenState *state = malloc(sizeof *state);
  if (!state) scr_ad_oom();
  state->rc = 1;
  state->called = false;
  state->promise = scr_promise_retain(target);
  state->reader = reader ? scr_dyn_retain((ScrDyn *)reader) : NULL;
  state->thenable = scr_dyn_retain((ScrDyn *)thenable);
  state->then = scr_dyn_retain((ScrDyn *)then);
  ScrClosure *job = scr_closure_new((void *)&scr_dyn_thenable_job, 1);
  job->caps[0] = scr_box_new_obj(scr_dyn_then_state_retain_v, scr_dyn_then_state_release_v, NULL);
  scr_box_set_ref(job->caps[0], state); /* the creation reference moves in */
  scr_queue_microtask(job);
}

/* ── Promise.all / allSettled / any over checked-dynamic entries ──────
 * Each element goes through PromiseResolve: a native promise is itself,
 * a thenable gets a fresh promise and its resolve job, anything else a
 * fulfilled promise (a throwing `then` read rejects it). The element
 * joins the combinator right after, so a thenable's job sits between
 * the jobs of the entries around it, exactly Node's iteration. Without a
 * combinator (`c` NULL) this is PromiseResolve for one value. */
static ScrPromise *scr_dyn_promise_entry(ScrCombine *c, const ScrDyn *value, const ScrDyn *reader) {
  if (value->kind == SCR_DYN_PROMISE) return scr_promise_retain(value->v.promise);
  ScrPromise *source = scr_promise_new();
  ScrDyn *then = scr_dyn_thenable_function(value, reader);
  if (scr_exc_pending()) {
    scr_promise_reject_pending(source);
  } else if (then) {
    if (c) scr_promise_combine_flush(c);
    scr_dyn_thenable_schedule(source, value, then, reader);
  } else {
    scr_promise_fulfill_ref(source, scr_dyn_retain((ScrDyn *)value), scr_dyn_retain_v,
                            scr_dyn_release_v, scr_dyn_trace_v);
  }
  scr_dyn_release(then);
  return source;
}

ScrPromise *scr_dyn_promise_resolve(const ScrDyn *value, const ScrDyn *reader) {
  return scr_dyn_promise_entry(NULL, value, reader);
}

void scr_dyn_promise_resolve_with(ScrPromise *target, ScrDyn *value) {
  scr_dyn_resolve_value(target, value, NULL);
}

static void scr_dyn_settled_store(ScrArr *a, double i, ScrPromise *src) {
  ScrDyn *record = scr_dyn_new_obj();
  bool fulfilled = !scr_promise_is_rejected(src);
  ScrStr *status = fulfilled ? scr_str_new("fulfilled", 9) : scr_str_new("rejected", 8);
  scr_dyn_obj_set(record, "status", 6, scr_dyn_new_str(status));
  scr_str_release(status);
  if (fulfilled) scr_dyn_obj_set(record, "value", 5, scr_dyn_promise_payload(src));
  else scr_dyn_obj_set(record, "reason", 6, scr_promise_reason_dyn(src));
  scr_arr_set_ref(a, i, record);
}

static void scr_promise_any_store(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_ref(a, i, scr_promise_reason_dyn(src));
}

static void scr_promise_any_fail(ScrPromise *result, ScrArr *errors) {
  static const char message[] = "All promises were rejected";
  ScrStr *text = scr_str_new(message, sizeof message - 1);
  ScrDyn *m = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrError *e = scr_aggregate_new(m, scr_dyn_undefined());
  scr_dyn_release(m);
  ScrDyn *list = scr_dyn_new_arr();
  for (size_t i = 0; i < errors->len; i++) scr_dyn_arr_push(list, scr_arr_get_ref(errors, (double)i));
  scr_aggregate_set_errors(e, list);
  scr_dyn_release(list);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  scr_promise_reject_pending(result);
}

ScrPromise *scr_promise_any_typed(ScrArr *ps) {
  ScrArr *errors = scr_arr_new_ops(&scr_dyn_arr_ops, ps->len);
  ScrPromise *result = scr_promise_any(ps, errors, scr_promise_any_store, scr_promise_any_fail);
  scr_arr_release(errors);
  return result;
}

static ScrPromise *scr_dyn_promise_combine(const ScrDyn *entries, const ScrDyn *reader, int mode) {
  size_t n = entries->v.arr.len;
  ScrArr *values = scr_arr_new_ops(&scr_dyn_arr_ops, n);
  ScrAllStore store = mode == SCR_COMBINE_ALL           ? scr_promise_all_store_ref
                      : mode == SCR_COMBINE_ALL_SETTLED ? scr_dyn_settled_store
                                                        : scr_promise_any_store;
  ScrCombine c;
  scr_promise_combine_begin(&c, mode, n, values, store,
                            mode == SCR_COMBINE_ANY ? scr_promise_any_fail : NULL);
  for (size_t i = 0; i < n; i++) {
    ScrPromise *source = scr_dyn_promise_entry(&c, entries->v.arr.items[i], reader);
    scr_promise_combine_add(&c, source);
    scr_promise_release(source);
  }
  ScrPromise *combined = scr_promise_combine_end(&c);
  scr_arr_release(values);
  /* any settles with an entry's own dyn value or the AggregateError. */
  if (mode == SCR_COMBINE_ANY) return combined;
  ScrPromise *result = scr_promise_new();
  scr_promise_race_add(result, combined, scr_dyn_all_result);
  scr_promise_release(combined);
  return result;
}

ScrPromise *scr_dyn_promise_all(const ScrDyn *entries, const ScrDyn *reader) {
  return scr_dyn_promise_combine(entries, reader, SCR_COMBINE_ALL);
}

ScrPromise *scr_dyn_promise_all_settled(const ScrDyn *entries, const ScrDyn *reader) {
  return scr_dyn_promise_combine(entries, reader, SCR_COMBINE_ALL_SETTLED);
}

ScrPromise *scr_dyn_promise_any(const ScrDyn *entries, const ScrDyn *reader) {
  return scr_dyn_promise_combine(entries, reader, SCR_COMBINE_ANY);
}

/* The checked native WebCrypto digest entry keeps promise and ArrayBuffer results native. */
static ScrDyn *scr_crypto_digest_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrPromise *promise = scr_promise_new();
  ScrDyn *algorithm = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *name = algorithm->kind == SCR_DYN_OBJ ? scr_dyn_obj_read(algorithm, "name", 4) : scr_dyn_retain(algorithm);
  ScrStr *text = name ? scr_dyn_string_coerce_js(name) : NULL;
  scr_dyn_release(name);
  ScrBytes *bytes = argc > 1 && args[1]->kind == SCR_DYN_BYTES ? scr_dyn_bytes_unbox(args[1]) : NULL;
  if (!bytes && argc > 1 && scr_array_buffer_is(args[1])) bytes = scr_array_buffer_view(SCR_BYTES_U8, args[1], scr_dyn_undefined(), scr_dyn_undefined());
  const char *native = NULL;
  if (text) {
    if (text->len == 7 && strncasecmp(text->data, "SHA-256", 7) == 0) native = "sha256";
    else if (text->len == 5 && strncasecmp(text->data, "SHA-1", 5) == 0) native = "sha1";
  }
  if (!text || !bytes || !native) {
    static const char message[] = "Unsupported WebCrypto digest algorithm or BufferSource";
    if (!scr_exc_pending()) scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "SC2020");
    scr_promise_reject_pending(promise);
  } else {
    ScrStr *alg = scr_str_new(native, strlen(native));
    ScrCryptoHash *hash = scr_crypto_hash_new(alg);
    scr_str_release(alg);
    if (hash) {
      /* update answers the hash it retained for chaining; the digest owns
       * this one reference, so it lets go of it. */
      ScrCryptoHash *updated = scr_crypto_hash_update_bytes(hash, bytes);
      if (updated) scr_crypto_hash_release(updated);
      ScrBytes *digest = scr_exc_pending() ? NULL : scr_crypto_hash_digest_buffer(hash);
      scr_crypto_hash_release(hash);
      if (digest) {
        ScrDyn *buffer = scr_array_buffer_from_bytes(digest); scr_bytes_release(digest);
        scr_promise_resolve_dyn(promise, buffer);
      } else scr_promise_reject_pending(promise);
    } else scr_promise_reject_pending(promise);
  }
  scr_str_release(text); scr_bytes_release(bytes);
  ScrDyn *result = scr_dyn_new_promise(promise); scr_promise_release(promise); return result;
}
/* A SubtleCrypto method read as a value (`const { importKey } = subtle`, a
 * computed `subtle[name]`): Node answers the method function, and native
 * code keeps no receiver-bearing value, so this one carries Node's name and
 * length and refuses the call — the method is called on the SubtleCrypto
 * object, as the compiler's member reads refuse it. */
static ScrDyn *scr_crypto_subtle_method_fence(ScrClosure *closure, ScrDyn *const *args,
                                              size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *name = scr_box_get_ref(closure->caps[0]);
  ScrStr *text = scr_dyn_string_coerce_js(name);
  char message[128];
  int n = snprintf(message, sizeof message,
                   "crypto.subtle.%.*s as a value (call it on the SubtleCrypto object) [SC1090]",
                   (int)(text ? text->len : 6), text ? (const char *)text->data : "method");
  if (text) scr_str_release(text);
  scr_dyn_release(name);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)n, "SC1090");
  return NULL;
}

/* Adds `name`, with Node's `length`, to `subtle` as a refusing method value. */
static void scr_crypto_subtle_method(ScrDyn *subtle, const char *name, uint32_t length) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  ScrStr *text = scr_str_new(name, strlen(name));
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(closure->caps[0], scr_dyn_new_str(text));
  scr_str_release(text);
  scr_dyn_obj_set(subtle, name, strlen(name),
                  scr_dyn_new_func(closure, scr_crypto_subtle_method_fence, length,
                                   "crypto.subtle.method", name));
}

ScrDyn *scr_crypto_native(void) {
  ScrDyn *subtle = scr_dyn_new_obj();
  scr_dyn_obj_set(subtle, "digest", 6, scr_dyn_new_func(scr_closure_new(NULL, 0), scr_crypto_digest_call, 2, "crypto.subtle.digest", "digest"));
  /* The other methods answer Node's name and length; digest above keeps its
   * working value, which the object has answered since before the rest. */
  static const struct {
    const char *name;
    uint32_t length;
  } methods[] = {
      {"importKey", 5},       {"generateKey", 3},     {"exportKey", 2},       {"encrypt", 3},
      {"decrypt", 3},         {"wrapKey", 4},         {"unwrapKey", 7},       {"deriveBits", 2},
      {"deriveKey", 5},       {"sign", 3},            {"verify", 4},          {"getPublicKey", 2},
      {"encapsulateBits", 2}, {"encapsulateKey", 5},  {"decapsulateBits", 3}, {"decapsulateKey", 6},
  };
  for (size_t i = 0; i < sizeof methods / sizeof methods[0]; i++)
    scr_crypto_subtle_method(subtle, methods[i].name, methods[i].length);
  ScrDyn *result = scr_dyn_new_obj(); scr_dyn_obj_set(result, "subtle", 6, subtle); return result;
}

/* ── node:async_hooks createHook (AsyncHook) ──────────────────────────
 * The hook registry the always-linked core dispatches through once this
 * unit installs its ops table (at startup, when the IR uses async_hooks).
 * A hook object is a 1-based f64 handle; its five callbacks are dyn
 * functions, validated with Node's ERR_ASYNC_CALLBACK. Enabled hooks run
 * in registration order, each call's ids crossing as numbers and a
 * resource as the dyn object the core allocated for it. */
typedef struct {
  ScrDyn *init, *before, *after, *destroy, *promise_resolve; /* owned or NULL */
  bool enabled;
} ScrAhHook;

typedef struct {
  const char *key;
  size_t len;
  const char *label;
  size_t label_len;
} ScrAhCallbackSlot;

static const ScrAhCallbackSlot scr_ah_slots[5] = {
    {"init", 4, "init", 4},
    {"before", 6, "before", 6},
    {"after", 5, "after", 5},
    {"destroy", 7, "destroy", 7},
    {"promiseResolve", 14, "promiseResolve", 14},
};

static SCR_TL ScrAhHook *scr_ah_hooks = NULL;
static SCR_TL size_t scr_ah_count = 0, scr_ah_cap = 0;

static void scr_ah_release_hook(ScrAhHook *h) {
  scr_dyn_release(h->init);
  scr_dyn_release(h->before);
  scr_dyn_release(h->after);
  scr_dyn_release(h->destroy);
  scr_dyn_release(h->promise_resolve);
}

static void scr_ah_teardown(void) {
  for (size_t i = 0; i < scr_ah_count; i++) scr_ah_release_hook(&scr_ah_hooks[i]);
  free(scr_ah_hooks);
  scr_ah_hooks = NULL;
  scr_ah_count = scr_ah_cap = 0;
}

static ScrAhHook *scr_ah_of(double handle) {
  size_t i = (size_t)handle;
  return handle >= 1 && i <= scr_ah_count ? &scr_ah_hooks[i - 1] : NULL;
}

static void scr_ah_call(ScrDyn *fn, ScrDyn *const *args, size_t argc) {
  if (fn == NULL) return;
  ScrDyn *r = scr_dyn_call(fn, args, argc, "async hook callback");
  if (r != NULL) scr_dyn_release(r);
}

static ScrDyn *scr_ah_num(double v) { return scr_dyn_new_num(v); }

static void scr_ah_dispatch_init(double id, const char *type, size_t type_len, double trigger,
                                 ScrDyn *resource) {
  for (size_t i = 0; i < scr_ah_count; i++) {
    ScrAhHook *h = &scr_ah_hooks[i];
    if (!h->enabled || h->init == NULL) continue;
    ScrStr *name = scr_str_new(type, type_len);
    ScrDyn *args[4] = {scr_ah_num(id), scr_dyn_new_str(name), scr_ah_num(trigger),
                       scr_dyn_retain(resource)};
    scr_str_release(name); /* scr_dyn_new_str retains its own reference */
    scr_ah_call(h->init, args, 4);
    for (size_t a = 0; a < 4; a++) scr_dyn_release(args[a]);
  }
}

static void scr_ah_dispatch_id(double id, int which) {
  for (size_t i = 0; i < scr_ah_count; i++) {
    ScrAhHook *h = &scr_ah_hooks[i];
    if (!h->enabled) continue;
    ScrDyn *fn = which == 0   ? h->before
                 : which == 1 ? h->after
                 : which == 2 ? h->destroy
                              : h->promise_resolve;
    if (fn == NULL) continue;
    ScrDyn *args[1] = {scr_ah_num(id)};
    scr_ah_call(fn, args, 1);
    scr_dyn_release(args[0]);
  }
}

/* Whether any enabled hook registers the callback: 0 init, 1 before,
 * 2 after, 3 destroy, 4 promiseResolve. AsyncResource asks before an empty
 * type's ERR_ASYNC_TYPE (which only exists while an init hook would see it)
 * and before it queues a destroy. */
static bool scr_ah_has_enabled_callback(int which) {
  for (size_t i = 0; i < scr_ah_count; i++) {
    const ScrAhHook *h = &scr_ah_hooks[i];
    if (!h->enabled) continue;
    const ScrDyn *fn = which == 0   ? h->init
                       : which == 1 ? h->before
                       : which == 2 ? h->after
                       : which == 3 ? h->destroy
                                    : h->promise_resolve;
    if (fn != NULL) return true;
  }
  return false;
}

/* The next-tick drain of queued destroy events (scr_ar_emit_destroy). */
static void scr_ar_flush_destroy(void) {
  scr_ar_destroy_scheduled = false;
  size_t n = scr_ar_destroy_len;
  double *ids = scr_ar_destroy_queue;
  scr_ar_destroy_queue = NULL;
  scr_ar_destroy_len = scr_ar_destroy_cap = 0;
  for (size_t i = 0; i < n; i++) scr_ah_dispatch_id(ids[i], 2);
  free(ids);
}

static void scr_ah_hook_before(double id) { scr_ah_dispatch_id(id, 0); }
static void scr_ah_hook_after(double id) { scr_ah_dispatch_id(id, 1); }
static void scr_ah_hook_destroy(double id) { scr_ah_dispatch_id(id, 2); }
static void scr_ah_hook_promise_resolve(double id) { scr_ah_dispatch_id(id, 3); }

static const ScrAsyncHookOps scr_ah_ops = {
    .init = scr_ah_dispatch_init,
    .before = scr_ah_hook_before,
    .after = scr_ah_hook_after,
    .destroy = scr_ah_hook_destroy,
    .promise_resolve = scr_ah_hook_promise_resolve,
};

/* Emitted before the entry of a program whose IR uses async_hooks: from
 * here on the core allocates ids and dispatches hook callbacks. */
void scr_async_hooks_install(void) {
  if (scr_async_hook_ops == NULL) scr_async_hook_ops = &scr_ah_ops;
}

/* createHook(callbacks): the five members are read the way Node's
 * destructuring reads them — undefined and null raise its property-read
 * TypeError, any other value reads whatever it has and a missing member is
 * no callback — and a present member that is not a function raises
 * ERR_ASYNC_CALLBACK. callbacks borrowed; the handle is 1-based. */
double scr_ah_create(ScrDyn *options) {
  if (options == NULL || options->kind == SCR_DYN_UNDEF || options->kind == SCR_DYN_NULL) {
    static const char undef_message[] =
        "Cannot destructure property 'init' of 'undefined' as it is undefined.";
    static const char null_message[] =
        "Cannot destructure property 'init' of 'null' as it is null.";
    if (options != NULL && options->kind == SCR_DYN_NULL)
      scr_throw_error_msg(SCR_ERR_TYPE, null_message, sizeof null_message - 1);
    else
      scr_throw_error_msg(SCR_ERR_TYPE, undef_message, sizeof undef_message - 1);
    return NAN;
  }
  /* scr_dyn_obj_get borrows its answers; scr_ah_parts retains the ones it
   * keeps. */
  ScrDyn *values[5] = {NULL, NULL, NULL, NULL, NULL};
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *value = scr_dyn_obj_get(options, scr_ah_slots[i].key, scr_ah_slots[i].len);
    if (value == NULL && scr_exc_pending()) return NAN; /* a getter threw */
    values[i] = value; /* absent member reads as no callback */
  }
  return scr_ah_parts(values[0], values[1], values[2], values[3], values[4]);
}

/* The five callbacks as Node's createHook takes them: bounded (borrowed)
 * values, each either absent (undefined) or a function; an explicit null or
 * any other non-function raises Node's ERR_ASYNC_CALLBACK in slot order.
 * Answers the 1-based handle. */
double scr_ah_parts(ScrDyn *init, ScrDyn *before, ScrDyn *after, ScrDyn *destroy,
                    ScrDyn *promise_resolve) {
  ScrDyn **given[5] = {&init, &before, &after, &destroy, &promise_resolve};
  ScrAhHook hook = {NULL, NULL, NULL, NULL, NULL, false};
  ScrDyn **dest[5] = {&hook.init, &hook.before, &hook.after, &hook.destroy, &hook.promise_resolve};
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *value = *given[i];
    if (value == NULL || value->kind == SCR_DYN_UNDEF) continue;
    if (value->kind != SCR_DYN_FUNC) {
      static const char prefix[] = "hook.";
      static const char suffix[] = " must be a function";
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, prefix);
      scr_jb_puts(&b, scr_ah_slots[i].label);
      scr_jb_puts(&b, suffix);
      ScrStr *message = scr_jb_finish(&b);
      scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_ASYNC_CALLBACK");
      scr_str_release(message);
      scr_ah_release_hook(&hook);
      return NAN;
    }
    *dest[i] = scr_dyn_retain(value);
  }
  if (scr_ah_count == scr_ah_cap) {
    size_t cap = scr_ah_cap ? scr_ah_cap * 2 : 4;
    ScrAhHook *grown = realloc(scr_ah_hooks, cap * sizeof *grown);
    if (!grown) scr_ad_oom();
    scr_ah_hooks = grown;
    scr_ah_cap = cap;
    if (scr_ah_count == 0) scr_atexit(scr_ah_teardown);
  }
  scr_ah_hooks[scr_ah_count++] = hook;
  return (double)scr_ah_count;
}

double scr_ah_enable(double handle) {
  ScrAhHook *hook = scr_ah_of(handle);
  if (hook != NULL) hook->enabled = true;
  return handle;
}

double scr_ah_disable(double handle) {
  ScrAhHook *hook = scr_ah_of(handle);
  if (hook != NULL) hook->enabled = false;
  return handle;
}

/* ── node:async_hooks asyncWrapProviders ──────────────────────────────
 * The provider-name → id table Node 24 ships (async_wrap's constants): a
 * null-prototype object whose own enumerable properties are the names, so
 * a read answers the same table Node's does. A compiled binary has no
 * provider ids of its own; the value is Node's published table, not a
 * report of this runtime's internals. */
typedef struct {
  const char *name;
  double id;
} ScrAhProvider;

static const ScrAhProvider scr_ah_provider_table[] = {
  {"NONE", 0},
  {"DIRHANDLE", 1},
  {"DNSCHANNEL", 2},
  {"ELDHISTOGRAM", 3},
  {"FILEHANDLE", 4},
  {"FILEHANDLECLOSEREQ", 5},
  {"BLOBREADER", 6},
  {"FSEVENTWRAP", 7},
  {"FSREQCALLBACK", 8},
  {"FSREQPROMISE", 9},
  {"GETADDRINFOREQWRAP", 10},
  {"GETNAMEINFOREQWRAP", 11},
  {"HEAPSNAPSHOT", 12},
  {"HTTP2SESSION", 13},
  {"HTTP2STREAM", 14},
  {"HTTP2PING", 15},
  {"HTTP2SETTINGS", 16},
  {"HTTPINCOMINGMESSAGE", 17},
  {"HTTPCLIENTREQUEST", 18},
  {"LOCKS", 19},
  {"JSSTREAM", 20},
  {"JSUDPWRAP", 21},
  {"MESSAGEPORT", 22},
  {"PIPECONNECTWRAP", 23},
  {"PIPESERVERWRAP", 24},
  {"PIPEWRAP", 25},
  {"PROCESSWRAP", 26},
  {"PROMISE", 27},
  {"QUERYWRAP", 28},
  {"QUIC_ENDPOINT", 29},
  {"QUIC_LOGSTREAM", 30},
  {"QUIC_SESSION", 31},
  {"QUIC_STREAM", 32},
  {"QUIC_UDP", 33},
  {"SHUTDOWNWRAP", 34},
  {"SIGNALWRAP", 35},
  {"STATWATCHER", 36},
  {"STREAMPIPE", 37},
  {"TCPCONNECTWRAP", 38},
  {"TCPSERVERWRAP", 39},
  {"TCPWRAP", 40},
  {"TTYWRAP", 41},
  {"UDPSENDWRAP", 42},
  {"UDPWRAP", 43},
  {"SIGINTWATCHDOG", 44},
  {"WORKER", 45},
  {"WORKERCPUPROFILE", 46},
  {"WORKERCPUUSAGE", 47},
  {"WORKERHEAPPROFILE", 48},
  {"WORKERHEAPSNAPSHOT", 49},
  {"WORKERHEAPSTATISTICS", 50},
  {"WRITEWRAP", 51},
  {"ZLIB", 52},
  {"CHECKPRIMEREQUEST", 53},
  {"PBKDF2REQUEST", 54},
  {"KEYPAIRGENREQUEST", 55},
  {"KEYGENREQUEST", 56},
  {"KEYEXPORTREQUEST", 57},
  {"ARGON2REQUEST", 58},
  {"CIPHERREQUEST", 59},
  {"DERIVEBITSREQUEST", 60},
  {"HASHREQUEST", 61},
  {"RANDOMBYTESREQUEST", 62},
  {"RANDOMPRIMEREQUEST", 63},
  {"SCRYPTREQUEST", 64},
  {"SIGNREQUEST", 65},
  {"TLSWRAP", 66},
  {"VERIFYREQUEST", 67},
};

ScrDyn *scr_ah_providers(void) {
  ScrDyn *obj = scr_dyn_new_obj();
  for (size_t i = 0; i < sizeof scr_ah_provider_table / sizeof scr_ah_provider_table[0]; i++) {
    scr_dyn_obj_set(obj, scr_ah_provider_table[i].name, strlen(scr_ah_provider_table[i].name),
                    scr_dyn_new_num(scr_ah_provider_table[i].id));
  }
  /* A null prototype, as Node's table has: the setter borrows the
   * prototype and answers the object (+1), both of which the caller owns. */
  ScrDyn *null_proto = scr_dyn_new_null();
  ScrDyn *set = scr_dyn_set_prototype(obj, null_proto);
  scr_dyn_release(null_proto);
  scr_dyn_release(set);
  return obj;
}

/* ── node:trace_events (trace_events.Tracing) ─────────────────────────
 * A compiled binary carries no trace-event agent, which is what Node's
 * tracing objects drive. Without the agent — Node run without the
 * --trace-event-* flags — what a program observes is the object's own
 * bookkeeping: its categories string, its enabled flag, and the
 * process-wide enabled-categories list. The object is a native handle
 * (typeof "object", no own keys, `Tracing { enabled: false, categories:
 * 'v8,node' }`), with member reads and calls through the checked-dynamic
 * tree; enable()/disable() flip the flag, as Node's do when no agent is
 * recording. */
typedef struct {
  size_t rc;
  ScrStr *categories; /* owned: the options' categories joined by ',' */
  bool enabled;
} ScrTraceEvents;

/* Only ENABLED tracers are referenced here (Node's tracing agent holds the
 * enabled ones the same way): getEnabledCategories walks this list, and a
 * tracer the program discards while disabled is freed with its handle —
 * creating and dropping tracers in a loop retains and slows nothing. */
static SCR_TL ScrTraceEvents **scr_te_enabled = NULL;
static SCR_TL size_t scr_te_enabled_count = 0, scr_te_enabled_cap = 0;

static void *scr_te_retain(void *h) {
  ((ScrTraceEvents *)h)->rc++;
  return h;
}

static void scr_te_release(void *h) {
  ScrTraceEvents *t = h;
  if (!t || --t->rc > 0) return;
  scr_str_release(t->categories);
  free(t);
}

static void scr_te_teardown(void) {
  for (size_t i = 0; i < scr_te_enabled_count; i++) scr_te_release(scr_te_enabled[i]);
  free(scr_te_enabled);
  scr_te_enabled = NULL;
  scr_te_enabled_count = scr_te_enabled_cap = 0;
}

static void scr_te_set_enabled(ScrTraceEvents *t, bool enabled) {
  if (t->enabled == enabled) return;
  t->enabled = enabled;
  if (enabled) {
    if (scr_te_enabled_count == scr_te_enabled_cap) {
      scr_te_enabled_cap = scr_te_enabled_cap ? scr_te_enabled_cap * 2 : 4;
      ScrTraceEvents **grown = realloc(scr_te_enabled, scr_te_enabled_cap * sizeof *grown);
      if (!grown) scr_ad_oom();
      scr_te_enabled = grown;
      if (scr_te_enabled_count == 0) scr_atexit(scr_te_teardown);
    }
    scr_te_retain(t);
    scr_te_enabled[scr_te_enabled_count++] = t;
    return;
  }
  for (size_t i = 0; i < scr_te_enabled_count; i++) {
    if (scr_te_enabled[i] != t) continue;
    scr_te_enabled[i] = scr_te_enabled[--scr_te_enabled_count];
    scr_te_release(t);
    return;
  }
}

static ScrDyn *scr_te_member(void *h, const char *key, size_t len);
static ScrDyn *scr_te_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what);
static ScrDyn *scr_te_inspect_view(void *h);
static const ScrDynHandleMethod scr_te_methods[];

static ScrDyn *scr_te_box(ScrTraceEvents *t) {
  static const ScrDynHandleOps ops = {
      .cls = "Tracing",
      .retain = scr_te_retain,
      .release = scr_te_release,
      .invoke = scr_te_invoke,
      .get = scr_te_member,
      .inspect_view = scr_te_inspect_view,
      .methods = scr_te_methods,
  };
  scr_dyn_handle_install(SCR_DYNH_TRACING, &ops);
  /* The handle owns the resource; nothing else references a disabled
   * tracer, so dropping the handle frees it. */
  ScrDyn *box = scr_dyn_new_handle(t, SCR_DYNH_TRACING);
  scr_te_release(t);
  return box;
}

/* `tracing.enabled` / `tracing.categories` as Node's prototype getters
 * answer them; any other name is no member (undefined). */
static ScrDyn *scr_te_member(void *h, const char *key, size_t len) {
  ScrTraceEvents *t = h;
  if (len == 7 && memcmp(key, "enabled", 7) == 0) return scr_dyn_new_bool(t->enabled);
  if (len == 10 && memcmp(key, "categories", 10) == 0)
    return scr_dyn_new_str(t->categories); /* the box retains its own */
  return NULL;
}

static ScrDyn *scr_te_undefined(void) { return scr_dyn_retain(scr_dyn_undefined()); }

static ScrDyn *scr_te_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  (void)what;
  ScrTraceEvents *t = h;
  if (strcmp(method, "enable") == 0) {
    scr_te_set_enabled(t, true);
    return scr_te_undefined();
  }
  if (strcmp(method, "disable") == 0) {
    scr_te_set_enabled(t, false);
    return scr_te_undefined();
  }
  static const char message[] = "Tracing member is not a function: ";
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, message);
  scr_jb_puts(&b, method);
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return NULL;
}

static ScrDyn *scr_te_inspect_view(void *h) {
  ScrTraceEvents *t = h;
  ScrDyn *view = scr_dyn_new_obj();
  scr_dyn_obj_set(view, "enabled", 7, scr_dyn_new_bool(t->enabled));
  scr_dyn_obj_set(view, "categories", 10, scr_dyn_new_str(t->categories));
  return view;
}

static const ScrDynHandleMethod scr_te_methods[] = {
    {"enable", 0, false}, {"disable", 0, false}, {NULL, 0, false}};

ScrDyn *scr_te_create(ScrDyn *options) {
  bool object_kind = options != NULL && (options->kind == SCR_DYN_OBJ ||
                                         options->kind == SCR_DYN_TYPED_REF ||
                                         options->kind == SCR_DYN_PROXY);
  if (!object_kind) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  /* scr_dyn_obj_get borrows: only the undefined stand-in is ours to free.
   * The array itself is retained rather than borrowed: the element reads
   * below run program code (an index the array does not own is answered
   * through its prototype chain), and a getter there can remove
   * options.categories — the object's reference — leaving the array dead
   * under the reads that follow. */
  ScrDyn *cats = scr_dyn_obj_get(options, "categories", 10);
  bool cats_owned = false;
  if (cats == NULL) {
    if (scr_exc_pending()) return NULL;
    /* An absent member reads as undefined, which is not an Array. */
    cats = scr_dyn_retain(scr_dyn_undefined());
    cats_owned = true;
  } else {
    cats = scr_dyn_retain(cats);
    cats_owned = true;
  }
  if (cats->kind != SCR_DYN_ARR) {
    scr_dyn_prop_type_fail("options.categories", "an instance of Array", cats);
    if (cats_owned) scr_dyn_release(cats);
    return NULL;
  }
  double len = scr_dyn_arr_len(cats);
  if (len >= 1) {
    ScrJsonBuf joined;
    scr_jb_init(&joined);
    for (double i = 0; i < len; i++) {
      ScrDyn *item = scr_dyn_arr_at(cats, i);
      if (item == NULL) {
        scr_jb_abandon(&joined); /* the joined string is never built */
        if (cats_owned) scr_dyn_release(cats);
        return NULL;
      }
      if (item->kind != SCR_DYN_STR) {
        char name[40];
        snprintf(name, sizeof name, "options.categories[%d]", (int)i);
        scr_dyn_prop_type_fail(name, "of type string", item);
        scr_dyn_release(item);
        scr_jb_abandon(&joined); /* the joined string is never built */
        if (cats_owned) scr_dyn_release(cats);
        return NULL;
      }
      if (i > 0) scr_jb_putc(&joined, ',');
      scr_jb_put_str(&joined, item->v.str);
      scr_dyn_release(item);
    }
    if (cats_owned) scr_dyn_release(cats);
    ScrTraceEvents *t = malloc(sizeof *t);
    if (!t) scr_ad_oom();
    t->rc = 1;
    t->categories = scr_jb_finish(&joined);
    t->enabled = false;
    return scr_te_box(t);
  }
  if (cats_owned) scr_dyn_release(cats);
  static const char message[] = "At least one category is required";
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1,
                           "ERR_TRACE_EVENTS_CATEGORY_REQUIRED");
  return NULL;
}

static int scr_te_name_cmp(const void *a, const void *b) {
  const ScrStr *x = *(const ScrStr *const *)a;
  const ScrStr *y = *(const ScrStr *const *)b;
  size_t n = x->len < y->len ? x->len : y->len;
  int c = memcmp(x->data, y->data, n);
  if (c != 0) return c;
  return x->len < y->len ? -1 : x->len > y->len ? 1 : 0;
}

/* getEnabledCategories(): every enabled tracing object's categories, split
 * on ',', de-duplicated and sorted, joined back — Node's answer, and the
 * undefined value when nothing is enabled. */
ScrDyn *scr_te_get_enabled_categories(void) {
  ScrStr **names = NULL;
  size_t n = 0, cap = 0;
  for (size_t i = 0; i < scr_te_enabled_count; i++) {
    ScrTraceEvents *t = scr_te_enabled[i];
    size_t start = 0;
    for (size_t at = 0; at <= t->categories->len; at++) {
      if (at < t->categories->len && t->categories->data[at] != ',') continue;
      ScrStr *part = scr_str_new(t->categories->data + start, at - start);
      start = at + 1;
      bool seen = false;
      for (size_t j = 0; j < n && !seen; j++) seen = scr_str_eq(names[j], part);
      if (seen) {
        scr_str_release(part);
        continue;
      }
      if (n == cap) {
        cap = cap ? cap * 2 : 8;
        names = realloc(names, cap * sizeof *names);
        if (!names) scr_ad_oom();
      }
      names[n++] = part;
    }
  }
  if (n == 0) {
    free(names);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  qsort(names, n, sizeof *names, scr_te_name_cmp);
  ScrJsonBuf joined;
  scr_jb_init(&joined);
  for (size_t i = 0; i < n; i++) {
    if (i > 0) scr_jb_putc(&joined, ',');
    scr_jb_put_str(&joined, names[i]);
    scr_str_release(names[i]);
  }
  free(names);
  ScrStr *text = scr_jb_finish(&joined);
  ScrDyn *result = scr_dyn_new_str(text);
  scr_str_release(text);
  return result;
}
