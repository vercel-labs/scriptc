/* AsyncDisposableStack: the `await using` counterpart of scr_symbol.c's
 * DisposableStack, and its one asynchronous operation, disposeAsync().
 *
 * The stack itself is the sync stack's shape — a collector-headered object
 * behind a traced dyn handle whose entries hold the resource and the method
 * that disposes it (getDisposeMethod at registration time, as the
 * specification's `use` does) — but its disposal is a promise-driven loop:
 * DisposeResources awaits each resource's disposal, so the loop suspends and
 * resumes across microtask checkpoints.
 *
 * The loop cannot park a C frame on wasm32, so it is a state machine whose
 * every step is one continuation, spawned after the promise it awaits
 * (scr_async_spawn_after): each continuation extracts at most one settled
 * result, disposes at most one resource, and spawns the next. A disposal's
 * answer goes through Await — PromiseResolve first, so a thenable adopts —
 * while a [Symbol.dispose] fallback's own answer is never awaited, because
 * GetDisposeMethod wraps the fallback in a promise that answers undefined.
 * Every step pays exactly the microtask the specification's Await costs.
 *
 * Error aggregation is the sync unit's: each failure after the first is
 * wrapped in a SuppressedError over the error so far, and a single failure
 * rejects the returned promise with the thrown value itself. A receiver
 * without the internal slot answers a REJECTED promise (not a throw), a
 * disposed stack answers a fulfilled one, and an empty stack fulfills
 * synchronously — the ticks are observable and Node's tests pin them.
 *
 * The whole unit is gated: only a program that constructs an
 * AsyncDisposableStack (the asyncDisposableStack program fact) links it. */
#include "scr_runtime.h"

enum { SCR_ADS_USE, SCR_ADS_ADOPT, SCR_ADS_DEFER };

typedef struct {
  ScrDyn *value; /* the resource (use, adopt); NULL for defer */
  ScrDyn *method;
  unsigned kind;
  /* Which members the last trace visited: the collector frees those
   * itself, and gcfree must not read them afterwards. */
  bool value_traced, method_traced;
} ScrAdsResource;

typedef struct {
  size_t rc;
  bool disposed;
  ScrAdsResource *items;
  size_t len, cap;
} ScrAsyncDisposableStack;

static bool scr_ads_traced(const ScrDyn *value) {
  return value && value->kind > SCR_DYN_STR && value->kind != SCR_DYN_UNDEF;
}

static void scr_ads_trace(void *ptr, ScrTraceVisit visit, void *ctx) {
  ScrAsyncDisposableStack *s = ptr;
  for (size_t i = 0; i < s->len; i++) {
    ScrAdsResource *r = &s->items[i];
    r->value_traced = scr_ads_traced(r->value);
    r->method_traced = scr_ads_traced(r->method);
    if (r->value_traced) visit(r->value, ctx);
    if (r->method_traced) visit(r->method, ctx);
  }
}

/* The collector frees traced members itself; the rest are released here. */
static void scr_ads_gcfree(void *ptr) {
  ScrAsyncDisposableStack *s = ptr;
  for (size_t i = 0; i < s->len; i++) {
    if (!s->items[i].value_traced) scr_dyn_release(s->items[i].value);
    if (!s->items[i].method_traced) scr_dyn_release(s->items[i].method);
  }
  free(s->items);
  scr_obj_free_note();
  scr_cyc_free(ptr);
}

static void scr_ads_destroy(void *ptr) {
  ScrAsyncDisposableStack *s = ptr;
  for (size_t i = 0; i < s->len; i++) {
    scr_dyn_release(s->items[i].value);
    scr_dyn_release(s->items[i].method);
  }
  s->len = 0;
  scr_ads_gcfree(ptr);
}

static void *scr_ads_retain(void *ptr) {
  ((ScrAsyncDisposableStack *)ptr)->rc++;
  return ptr;
}

static void scr_ads_release(void *ptr) {
  ScrAsyncDisposableStack *s = ptr;
  if (!s) return;
  if (--s->rc == 0) {
    scr_cyc_dead(s);
    scr_rc_destroy(s, scr_ads_destroy);
  } else scr_cyc_released(s);
}

static void scr_ads_push(ScrAsyncDisposableStack *s, ScrDyn *value, ScrDyn *method, unsigned kind) {
  if (s->len == s->cap) {
    size_t cap = s->cap ? s->cap * 2 : 4;
    ScrAdsResource *items = realloc(s->items, cap * sizeof *items);
    if (!items) scr_trap("scriptc: out of memory\n");
    s->items = items;
    s->cap = cap;
  }
  s->items[s->len++] = (ScrAdsResource){value, method, kind, false, false};
}

/* V8's rendering of a value in a TypeError: primitives by ToString,
 * arrays as [object Array], other objects as #<Constructor>. */
static void scr_ads_put_value(ScrJsonBuf *b, const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_UNDEF: scr_jb_puts(b, "undefined"); return;
  case SCR_DYN_NULL: scr_jb_puts(b, "null"); return;
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_BIGINT: {
    ScrStr *text = scr_dyn_to_string(value, NULL);
    if (text) scr_jb_write(b, text->data, text->len);
    scr_str_release(text);
    return;
  }
  case SCR_DYN_SYMBOL: {
    ScrStr *text = value->v.symbol.render(value->v.symbol.value);
    scr_jb_write(b, text->data, text->len);
    scr_str_release(text);
    return;
  }
  case SCR_DYN_ARR: scr_jb_puts(b, "[object Array]"); return;
  case SCR_DYN_HANDLE:
    scr_jb_puts(b, "#<");
    scr_jb_puts(b, scr_dyn_handle_cls(value));
    scr_jb_putc(b, '>');
    return;
  default: scr_jb_puts(b, "#<Object>"); return;
  }
}

static ScrAsyncDisposableStack *scr_ads_of(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_ASYNC_DISPOSABLE_STACK
    ? value->v.handle.ptr : NULL;
}

bool scr_async_disposable_stack_is(const ScrDyn *value) { return scr_ads_of(value) != NULL; }

/* The receiver of AsyncDisposableStack.prototype.<name>, or NULL with Node's
 * TypeError (an incompatible receiver) or ReferenceError (a disposed stack,
 * when `live` is required) pending. Node's disposed message names
 * DisposableStack, without the `Async` — the interface shares one text. */
static ScrAsyncDisposableStack *scr_ads_receiver(const ScrDyn *self, const char *name, bool getter, bool live) {
  ScrAsyncDisposableStack *s = scr_ads_of(self);
  ScrJsonBuf message;
  if (!s) {
    scr_jb_init(&message);
    scr_jb_puts(&message,
                getter ? "Method get AsyncDisposableStack.prototype." : "Method AsyncDisposableStack.prototype.");
    scr_jb_puts(&message, name);
    scr_jb_puts(&message, " called on incompatible receiver ");
    scr_ads_put_value(&message, self);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return NULL;
  }
  if (live && s->disposed) {
    scr_jb_init(&message);
    scr_jb_puts(&message, "Cannot call AsyncDisposableStack.prototype.");
    scr_jb_puts(&message, name);
    scr_jb_puts(&message, " on an already-disposed DisposableStack");
    scr_throw_error(SCR_ERR_REFERENCE, scr_jb_finish(&message));
    return NULL;
  }
  return s;
}

static bool scr_ads_callable(const ScrDyn *value) {
  if (scr_dyn_is_callable(value)) return true;
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_ads_put_value(&message, value);
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return false;
}

/* use(value): the resource's disposal method is read once, here, with the
 * async hint (@@asyncDispose first, @@dispose as the fallback) — null and
 * undefined answer undefined and register a resource with no method. */
bool scr_async_disposable_stack_use(const ScrDyn *stack, const ScrDyn *value) {
  ScrAsyncDisposableStack *s = scr_ads_receiver(stack, "use", false, true);
  if (!s) return false;
  ScrDyn *method = scr_dyn_using_method(value, true);
  if (!method) return false;
  scr_ads_push(s, scr_dyn_retain((ScrDyn *)value), method, SCR_ADS_USE);
  return true;
}

/* use(value) for a typed class instance: the compiler knows the class's
 * [Symbol.asyncDispose] (or its synchronous [Symbol.dispose]) and registers
 * the call it makes, because a class instance's dyn view carries no methods
 * to read. The entry disposes like adopt's — the callback runs with the value
 * and its result is awaited — so the loop's ticks and error aggregation are
 * the checked-dynamic form's. */
bool scr_async_disposable_stack_use_callback(const ScrDyn *stack, const ScrDyn *value,
                                             const ScrDyn *dispose) {
  ScrAsyncDisposableStack *s = scr_ads_receiver(stack, "use", false, true);
  if (!s || !scr_ads_callable(dispose)) return false;
  scr_ads_push(s, scr_dyn_retain((ScrDyn *)value), scr_dyn_retain((ScrDyn *)dispose), SCR_ADS_ADOPT);
  return true;
}

bool scr_async_disposable_stack_adopt(const ScrDyn *stack, const ScrDyn *value, const ScrDyn *on_dispose) {
  ScrAsyncDisposableStack *s = scr_ads_receiver(stack, "adopt", false, true);
  if (!s || !scr_ads_callable(on_dispose)) return false;
  scr_ads_push(s, scr_dyn_retain((ScrDyn *)value), scr_dyn_retain((ScrDyn *)on_dispose), SCR_ADS_ADOPT);
  return true;
}

static bool scr_async_disposable_stack_defer(const ScrDyn *stack, const ScrDyn *on_dispose) {
  ScrAsyncDisposableStack *s = scr_ads_receiver(stack, "defer", false, true);
  if (!s || !scr_ads_callable(on_dispose)) return false;
  scr_ads_push(s, NULL, scr_dyn_retain((ScrDyn *)on_dispose), SCR_ADS_DEFER);
  return true;
}

/* ── disposeAsync ──────────────────────────────────────────────────────
 * DisposeResources as a resumable loop. One run per disposeAsync call;
 * it owns the stack's entries from the moment disposal starts. */
typedef struct ScrAdsRun {
  ScrAsyncDisposableStack *stack; /* retained */
  ScrPromise *out;                /* the promise disposeAsync returned, retained */
  ScrAdsResource *items;
  size_t len, next; /* `next` counts down: the resources dispose in reverse */
  ScrCaught *error; /* owned; the error so far, NULL when none */
  ScrPromise *dep;  /* owned while an await is in flight */
  bool needsAwait;  /* a resource had no method (null or undefined) */
  bool hasAwaited;  /* a resource's disposal was awaited */
} ScrAdsRun;

static void scr_ads_step(ScrAdsRun *run);

static void scr_ads_free(ScrAdsRun *run) {
  free(run->items);
  scr_caught_release(run->error);
  scr_promise_release(run->out);
  if (run->stack) scr_ads_release(run->stack);
  free(run);
}

static void scr_ads_finish(ScrAdsRun *run) {
  if (run->error) {
    scr_rethrow(run->error);
    scr_promise_reject_pending(run->out);
  } else {
    scr_promise_resolve_dyn(run->out, scr_dyn_retain(scr_dyn_undefined()));
  }
  scr_ads_free(run);
}

/* Fold a pending exception — a disposal call's throw or an awaited
 * rejection — into the run's error. A later failure becomes a
 * SuppressedError over the error so far. */
static void scr_ads_record_pending(ScrAdsRun *run) {
  if (!scr_exc_pending()) return;
  /* scr_exc_suppress consumes the error it suppresses: it builds the
   * SuppressedError over it and leaves that pending. */
  if (run->error) scr_exc_suppress(run->error);
  run->error = scr_exc_take();
}

/* A fulfilled promise whose await costs JS's one hop: the wrapper promise a
 * [Symbol.dispose] fallback is awaited through, or the closing await of a
 * stack that disposed only null and undefined resources. +1. */
static ScrPromise *scr_ads_tick(void) {
  ScrPromise *tick = scr_promise_new();
  scr_promise_fulfill_ref(tick, (void *)scr_dyn_retain(scr_dyn_undefined()), scr_dyn_retain_v,
                          scr_dyn_release_v, scr_dyn_trace_v);
  return tick;
}

static void scr_ads_await_entry(ScrFiber *self, void *opaque) {
  (void)self;
  ScrAdsRun *run = opaque;
  ScrDyn *value = scr_await_dyn(run->dep);
  scr_dyn_release(value);
  scr_promise_release(run->dep);
  run->dep = NULL;
  scr_ads_step(run);
}

/* Await `dep` (moves +1) and resume the loop when it settles. On native the
 * spawn runs eagerly to its already-settled or parked await and yields, so
 * control returns here before the continuation touches the run. */
static void scr_ads_suspend(ScrAdsRun *run, ScrPromise *dep) {
  run->dep = dep;
  ScrPromise *waiter = scr_async_spawn_after(dep, scr_ads_await_entry, run);
  scr_promise_release(waiter);
}

/* One disposal: Call(method, value) — or the adopt/defer callback — with the
 * resource released afterwards. NULL with the exception pending on a throw.
 * `sync_fallback` answers whether the call ran the entry's [Symbol.dispose]
 * fallback, whose answer the loop never awaits. */
static ScrDyn *scr_ads_dispose(ScrAdsResource *r, bool *sync_fallback) {
  ScrDyn *result;
  *sync_fallback = false;
  if (r->kind == SCR_ADS_USE) {
    const ScrDyn *record = r->method;
    bool fallback = record->v.arr.items[1]->v.b;
    *sync_fallback = fallback;
    scr_dyn_this_push_dyn(r->value);
    result = scr_dyn_call(record->v.arr.items[0], NULL, 0, fallback ? "[Symbol.dispose]" : "[Symbol.asyncDispose]");
    scr_dyn_this_pop();
  } else {
    scr_dyn_this_push_dyn(scr_dyn_undefined());
    result = r->kind == SCR_ADS_ADOPT ? scr_dyn_call(r->method, &r->value, 1, "onDisposeAsync")
                                      : scr_dyn_call(r->method, NULL, 0, "onDisposeAsync");
    scr_dyn_this_pop();
  }
  scr_dyn_release(r->value);
  scr_dyn_release(r->method);
  return result;
}

/* Advance the loop: dispose resources until one must be awaited, then
 * suspend; settle the promise when the entries run out. */
static void scr_ads_step(ScrAdsRun *run) {
  scr_ads_record_pending(run);
  while (run->next > 0) {
    ScrAdsResource *r = &run->items[--run->next];
    if (r->kind == SCR_ADS_USE && r->method->kind == SCR_DYN_UNDEF) {
      /* A null or undefined resource: nothing to call, and DisposeResources
       * owes the closing await if no other resource took one. */
      scr_dyn_release(r->value);
      scr_dyn_release(r->method);
      run->needsAwait = true;
      continue;
    }
    bool sync_fallback = false;
    ScrDyn *result = scr_ads_dispose(r, &sync_fallback);
    if (sync_fallback) {
      /* GetDisposeMethod with the async hint wraps the [Symbol.dispose]
       * fallback in a promise that answers undefined whatever the method
       * returns — a promise it returns is never awaited — and rejects with
       * the method's throw. DisposeResources awaits that wrapper, so every
       * fallback costs exactly one hop. */
      scr_dyn_release(result);
      scr_ads_record_pending(run);
      run->hasAwaited = true;
      scr_ads_suspend(run, scr_ads_tick());
      return;
    }
    if (!result) {
      scr_ads_record_pending(run);
      continue;
    }
    run->hasAwaited = true;
    /* Await(result) is PromiseResolve over the answer: a thenable adopts
     * through its resolve job (a throwing `then` read rejects), a native
     * promise is itself, and any other value fulfills — one hop, as the
     * non-thenable await costs. */
    ScrPromise *dep = scr_dyn_promise_resolve(result, NULL);
    scr_dyn_release(result);
    scr_ads_suspend(run, dep);
    return;
  }
  if (run->needsAwait && !run->hasAwaited) {
    run->hasAwaited = true;
    scr_ads_suspend(run, scr_ads_tick());
    return;
  }
  scr_ads_finish(run);
}

/* AsyncDisposableStack.prototype.disposeAsync(): a promise, always. The
 * receiver check answers a REJECTED promise (Node's "Receiver is not an
 * AsyncDisposableStack"), a disposed stack a fulfilled one, and an empty
 * stack one fulfilled before the call returns. */
static ScrDyn *scr_ads_dispose_async(ScrDyn *self) {
  ScrPromise *out = scr_promise_new();
  ScrAsyncDisposableStack *stack = scr_ads_of(self);
  if (!stack) {
    static const char message[] = "Receiver is not an AsyncDisposableStack";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    scr_promise_reject_pending(out);
  } else if (stack->disposed) {
    scr_promise_resolve_dyn(out, scr_dyn_retain(scr_dyn_undefined()));
  } else {
    stack->disposed = true;
    ScrAdsRun *run = calloc(1, sizeof *run);
    if (!run) scr_trap("scriptc: out of memory\n");
    run->stack = scr_ads_retain(stack);
    run->out = scr_promise_retain(out);
    run->items = stack->items;
    run->len = run->next = stack->len;
    stack->items = NULL;
    stack->len = stack->cap = 0;
    scr_ads_step(run);
  }
  ScrDyn *boxed = scr_dyn_new_promise(out);
  scr_promise_release(out);
  return boxed;
}

static SCR_TL ScrDyn *scr_ads_method_values[6];
static const char *const scr_ads_method_names[] = {"use", "adopt", "defer", "move", "disposeAsync", "disposed"};
static const uint32_t scr_ads_method_lengths[] = {1, 2, 1, 0, 0, 0};
enum { SCR_ADS_M_USE, SCR_ADS_M_ADOPT, SCR_ADS_M_DEFER, SCR_ADS_M_MOVE, SCR_ADS_M_DISPOSE_ASYNC, SCR_ADS_M_DISPOSED };

static ScrAsyncDisposableStack *scr_ads_alloc(void);
static ScrDyn *scr_ads_box(ScrAsyncDisposableStack *s);
static void scr_ads_teardown(void);

/* The method-value cache is kept for the lifetime of the program, like the
 * sync stack's; register its teardown once, on whichever path creates the
 * first member value. */
static void scr_ads_arm_methods(void) {
  static SCR_TL bool armed;
  if (armed) return;
  armed = true;
  scr_atexit(scr_ads_teardown);
}

static ScrDyn *scr_ads_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  unsigned index = (unsigned)scr_box_get_f64(clo->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  const ScrDyn *arg0 = argc > 0 ? args[0] : scr_dyn_undefined();
  const ScrDyn *arg1 = argc > 1 ? args[1] : scr_dyn_undefined();
  ScrDyn *out = NULL;
  switch (index) {
  case SCR_ADS_M_USE:
    if (scr_async_disposable_stack_use(self, arg0)) out = scr_dyn_retain((ScrDyn *)arg0);
    break;
  case SCR_ADS_M_ADOPT:
    if (scr_async_disposable_stack_adopt(self, arg0, arg1)) out = scr_dyn_retain((ScrDyn *)arg0);
    break;
  case SCR_ADS_M_DEFER:
    if (scr_async_disposable_stack_defer(self, arg0)) out = scr_dyn_retain(scr_dyn_undefined());
    break;
  case SCR_ADS_M_MOVE: {
    /* The new stack takes the entries; this one becomes disposed. */
    ScrAsyncDisposableStack *s = scr_ads_receiver(self, "move", false, true);
    if (!s) break;
    ScrAsyncDisposableStack *moved = scr_ads_alloc();
    moved->items = s->items;
    moved->len = s->len;
    moved->cap = s->cap;
    s->items = NULL;
    s->len = s->cap = 0;
    s->disposed = true;
    out = scr_ads_box(moved);
    scr_ads_release(moved);
    break;
  }
  default:
    out = scr_ads_dispose_async(self);
    break;
  }
  scr_dyn_release(self);
  return out;
}

/* The function value of method `index` (+1), cached per thread. */
static ScrDyn *scr_ads_method_value(unsigned index) {
  if (!scr_ads_method_values[index]) {
    scr_ads_arm_methods();
    ScrClosure *clo = scr_closure_new(NULL, 1);
    clo->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(clo->caps[0], (double)index);
    scr_ads_method_values[index] = scr_dyn_new_func(clo, scr_ads_method_call, scr_ads_method_lengths[index],
                                                    "", scr_ads_method_names[index]);
  }
  return scr_dyn_retain(scr_ads_method_values[index]);
}

/* The function value an AsyncDisposableStack answers for the member named
 * `key` (+1), or NULL — the value AsyncDisposableStack.prototype holds as its
 * member, so a member read off a stack and off the prototype are one
 * function. */
ScrDyn *scr_async_disposable_stack_member_value(const char *key, size_t len) {
  for (unsigned i = 0; i < SCR_ADS_M_DISPOSED; i++) {
    if (strlen(scr_ads_method_names[i]) == len && memcmp(key, scr_ads_method_names[i], len) == 0)
      return scr_ads_method_value(i);
  }
  return NULL;
}

static ScrDyn *scr_ads_get(void *ptr, const char *key, size_t len) {
  ScrAsyncDisposableStack *s = ptr;
  if (len == 8 && memcmp(key, "disposed", 8) == 0) return scr_dyn_new_bool(s->disposed);
  return scr_async_disposable_stack_member_value(key, len);
}

static bool scr_ads_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

/* [Symbol.asyncDispose] is disposeAsync itself, as in Node; the stack has no
 * [Symbol.dispose]. [Symbol.toStringTag] is the class name the prototype
 * inherits from the intrinsic table, which a handle does not walk. */
static ScrDyn *scr_ads_symbol_get(void *ptr, const ScrDyn *key) {
  (void)ptr;
  if (key->kind != SCR_DYN_SYMBOL) return NULL;
  ScrStr *name = scr_str_new("asyncDispose", 12);
  ScrSym *async_dispose = scr_sym_well_known(name);
  scr_str_release(name);
  bool match = key->v.symbol.value == async_dispose;
  scr_sym_release(async_dispose);
  if (match) return scr_ads_method_value(SCR_ADS_M_DISPOSE_ASYNC);
  ScrStr *tag = scr_str_new("toStringTag", 11);
  ScrSym *to_string_tag = scr_sym_well_known(tag);
  scr_str_release(tag);
  bool tagged = key->v.symbol.value == to_string_tag;
  scr_sym_release(to_string_tag);
  if (!tagged) return NULL;
  ScrStr *text = scr_str_new("AsyncDisposableStack", 20);
  ScrDyn *value = scr_dyn_new_str(text);
  scr_str_release(text);
  return value;
}

static ScrDyn *scr_ads_inspect_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

static void scr_ads_teardown(void) {
  for (size_t i = 0; i < sizeof scr_ads_method_values / sizeof scr_ads_method_values[0]; i++) {
    scr_dyn_release(scr_ads_method_values[i]);
    scr_ads_method_values[i] = NULL;
  }
}

static const ScrDynHandleOps scr_ads_ops = {
    .cls = "AsyncDisposableStack",
    .retain = scr_ads_retain,
    .release = scr_ads_release,
    .get = scr_ads_get,
    .set = scr_ads_set,
    .inspect_view = scr_ads_inspect_view,
    .json_empty_object = true,
    .inspect_view_empty = true,
    .symbol_get = scr_ads_symbol_get,
};

/* The member providers table (scr_dyn_invoke.c) answers
 * `AsyncDisposableStack.prototype.<member>` from this unit's table, so a
 * member read off a stack and off its prototype are one function. That table
 * calls scr_async_disposable_stack_member_value() directly: the row lives in
 * the unit's own build column, which only a program with this unit's fact
 * selects, so the call resolves where the row exists and is not compiled
 * anywhere else. */

static ScrAsyncDisposableStack *scr_ads_alloc(void) {
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_ASYNC_DISPOSABLE_STACK, &scr_ads_ops);
    scr_ads_arm_methods();
  }
  static ScrCycType cyc_type = {&scr_ads_trace, &scr_ads_gcfree, SCR_CYC_KIND_NONE, 0};
  ScrAsyncDisposableStack *s = scr_cyc_alloc(sizeof *s, &cyc_type);
  s->rc = 1;
  scr_obj_alloc_note();
  return s;
}

static ScrDyn *scr_ads_box(ScrAsyncDisposableStack *s) {
  return scr_dyn_new_handle(s, SCR_DYNH_ASYNC_DISPOSABLE_STACK);
}

ScrDyn *scr_async_disposable_stack_new(void) {
  ScrAsyncDisposableStack *s = scr_ads_alloc();
  ScrDyn *out = scr_ads_box(s);
  scr_ads_release(s);
  return out;
}
