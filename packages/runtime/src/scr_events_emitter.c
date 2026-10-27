/* The node:events EventEmitter — the runtime-provided BASE CLASS behind
 * `new EventEmitter()` and `class My extends EventEmitter` (the ScrError
 * precedent: ScrEmitter lays out exactly like a compiler-emitted hierarchy
 * class — rc, vt, then the prefix fields — so user subclasses embed it and
 * every vtable mechanism applies unchanged). This translation unit links
 * ONLY into binaries whose IR touches the emitter surface
 * (moduleUsesEmitter — the scr_events.c gating precedent); emitter-free
 * binaries keep their exact link line. Pure data structure: no event loop,
 * no poller — emits are synchronous calls on the caller's stack, exactly
 * Node's contract.
 *
 * Listener lists are name-keyed buckets in first-registration order
 * (eventNames order; a bucket emptied by removal DROPS, and a later add
 * re-appends — Node deletes the _events key the same way). Entries are
 * small shared heap nodes so an emit's SNAPSHOT and the live list agree on
 * the once-fired flag: Node emits over a copy (a listener removed
 * mid-emit still runs for that emit; one added waits), and a once wrapper
 * skips only when it already FIRED — mid-emit removal of a not-yet-run
 * once listener does not skip it, matching the wrapper's `fired` check.
 *
 * Literal-name dispatch is C-variadic: LLVM emit sites pass borrowed
 * pointers, with scalars stored in call-lived stack slots. A runtime shim
 * reads the listener's parameter prefix and hands it to the emitted
 * adapter, which loads scalars, retains the references the callee owns,
 * and calls the original closure. The frontend's per-event tuple
 * unification is what makes every adapter's reads agree with every emit
 * site's writes. Internal (meta-event) emits reuse the same variadic
 * entry, passing the event NAME as the one argument — meta listeners are
 * fenced to arity <= 1, so no adapter ever reads the listener argument
 * Node would pass second. Listeners registered as checked-dynamic functions
 * keep their checked-dynamic thunk, which untyped emits call with the exact
 * argument vector; an entry can hold both forms, so typed and untyped
 * registrations and emits of one name share one list.
 *
 * The special 'error' event routes through scr_emitter_emit_error: with no
 * 'error' listener the Error payload THROWS through the exception cell
 * (catchable; uncaught exits 1), Node's unhandled-'error' contract.
 *
 * The maxListeners leak warning is emitted once per (emitter, event name)
 * on the next tick, as process.emitWarning delivers it: to the process
 * 'warning' listeners and Node's stderr report, with the once-per-process
 * --trace-warnings hint line. The pid in "(node:pid)" is this process's
 * (it can never equal the oracle's). */
#include "scr_runtime.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <process.h>
#define SCR_EE_PID() ((long)_getpid())
#else
#include <unistd.h>
#define SCR_EE_PID() ((long)getpid())
#endif

static void scr_ee_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* One registered listener. Shared between the live list and emit
 * snapshots via `refs` (never the closure's own rc: the node owns ONE cb
 * reference, released when the last holder lets go). */
typedef struct ScrEeEntry {
  ScrClosure *cb; /* owned by the node — what emit INVOKES */
  /* NULL for direct registrations. A dyn-adapted registration (the JS
   * lane's checked-dynamic listeners) invokes through a compiler-built
   * adapter closure (cb) but keeps the ORIGINAL function here (owned):
   * removeListener/off match it, listenerCount(name, fn) counts it, and
   * listeners()/rawListeners() answer it — Node's identity semantics. */
  ScrClosure *orig;
  ScrEeInvoke inv;
  /* Checked-dynamic registration (computed names, and every listener
   * registered as a dynamic function value): the original closure and its
   * checked-dynamic thunk, called with the exact argument count of an
   * untyped emit. Holding the closure directly keeps its capture edges
   * visible to cycle collection. An entry may carry both forms: a typed
   * emit calls `inv`, an untyped one calls the thunk with the arguments as
   * given. The descriptor rebuilds the function value for listeners() and
   * the meta events. */
  ScrClosure *flex_cb;
  ScrDynThunk flex_invoke;
  /* The function box's typed message entry (scr_emitter_emit_message). */
  ScrDynMessageListener flex_message;
  const char *flex_sig;
  const char *flex_name;
  uint32_t flex_arity;
  bool once;
  bool fired; /* a once entry that already ran (snapshot skip rule) */
  uint32_t refs;
} ScrEeEntry;

typedef struct ScrEeBucket {
  ScrStr *name; /* owned */
  ScrEeEntry **ls;
  size_t n, cap;
  bool warned; /* leak warning printed for this name already */
  struct ScrEeBucket *next;
} ScrEeBucket;

struct ScrEeReg {
  ScrEeBucket *head; /* singly linked, first-registration order */
  double max;        /* -1 = unset (follows the default), 0 = unlimited */
  /* Node's kShapeMode: set when names were PRE-CREATED (the stream
   * constructors). In shape mode removeListener KEEPS an emptied name's
   * rank (Node writes events[type] = undefined instead of deleting) —
   * only removeAllListeners deletes: the named form drops the one key,
   * the no-argument wipe resets everything and leaves shape mode. */
  bool shape;
  /* Owner-internal observation of empty/nonempty listener transitions. It
   * runs before user meta events and must never invoke script or mutate the
   * emitter. The owner keeps the borrowed context alive with the emitter. */
  void (*observe)(void *context, const ScrStr *name, bool present);
  void *observer_context;
};

/* The vtable of BARE `new EventEmitter()` instances; the emitted main()
 * stamps pre/post from the program's preorder numbering (the
 * scr_error_vts precedent). release is the direct teardown below. */
static void scr_emitter_release_direct(void *obj);
SCR_TL ScrVt scr_emitter_vt = {0, 0, &scr_emitter_release_direct};

SCR_TL double scr_emitter_default_max = 10; /* EventEmitter.defaultMaxListeners */

/* Post-registration hook (scr_runtime.h): the stream unit's flow kick.
 * NULL in stream-free builds — behavior byte-identical. */
SCR_TL void (*scr_emitter_on_hook)(ScrEmitter *em, ScrStr *name) = NULL;

/* ── entries and buckets ──────────────────────────────────────────────── */

static void scr_ee_entry_unref(ScrEeEntry *e) {
  if (--e->refs > 0) return;
  scr_closure_release(e->cb);
  scr_closure_release(e->orig); /* NULL-tolerant */
  scr_closure_release(e->flex_cb);
  free(e);
}

/* The entry's IDENTITY closure — what Node would see as the listener. */
static ScrClosure *scr_ee_entry_fn(const ScrEeEntry *e) {
  return e->orig ? e->orig : e->cb ? e->cb : e->flex_cb;
}

static ScrEeReg *scr_ee_reg_ensure(ScrEmitter *em) {
  if (!em->reg) {
    em->reg = calloc(1, sizeof *em->reg);
    if (!em->reg) scr_ee_oom();
    em->reg->max = -1;
  }
  return em->reg;
}

void scr_emitter_observe(ScrEmitter *em,
                        void (*observe)(void *, const ScrStr *, bool), void *context) {
  ScrEeReg *reg = scr_ee_reg_ensure(em);
  reg->observe = observe;
  reg->observer_context = context;
}

static void scr_ee_observe(ScrEmitter *em, const ScrStr *name, bool present) {
  ScrEeReg *reg = em->reg;
  if (reg->observe) reg->observe(reg->observer_context, name, present);
}

/* events.errorMonitor's registry key. Node keys it by a symbol, so no
 * string event name can reach its listeners: the registry matches this
 * object by identity and never by bytes. The bytes are String(symbol),
 * which the leak warning prints. */
static const struct {
  size_t rc;
  size_t len;
  size_t cap;
  char data[sizeof "Symbol(events.errorMonitor)"];
} scr_ee_error_monitor_lit = {SIZE_MAX, sizeof "Symbol(events.errorMonitor)" - 1,
                              SCR_STR_CAP_WORD(sizeof "Symbol(events.errorMonitor)" - 1, 0, 1),
                              "Symbol(events.errorMonitor)"};
#define SCR_EE_ERROR_MONITOR ((ScrStr *)&scr_ee_error_monitor_lit)

ScrStr *scr_emitter_error_monitor(void) { return SCR_EE_ERROR_MONITOR; }

static bool scr_ee_is_error_monitor(const ScrStr *name) { return name == SCR_EE_ERROR_MONITOR; }

/* The bucket of a STRING event name (the errorMonitor bucket never
 * matches). */
static ScrEeBucket *scr_ee_bucket_find(ScrEeReg *reg, const char *name, size_t len) {
  if (!reg) return NULL;
  for (ScrEeBucket *b = reg->head; b; b = b->next) {
    if (b->name->len == len && !scr_ee_is_error_monitor(b->name) &&
        memcmp(b->name->data, name, len) == 0)
      return b;
  }
  return NULL;
}

/* The bucket of a registry key: a string name or the errorMonitor key. */
static ScrEeBucket *scr_ee_bucket_of(ScrEeReg *reg, const ScrStr *name) {
  if (!scr_ee_is_error_monitor(name)) return scr_ee_bucket_find(reg, name->data, name->len);
  if (!reg) return NULL;
  for (ScrEeBucket *b = reg->head; b; b = b->next) {
    if (b->name == name) return b;
  }
  return NULL;
}

static ScrEeBucket *scr_ee_bucket_ensure(ScrEeReg *reg, ScrStr *name) {
  ScrEeBucket *b = scr_ee_bucket_of(reg, name);
  if (b) return b;
  b = calloc(1, sizeof *b);
  if (!b) scr_ee_oom();
  b->name = scr_str_retain(name);
  /* Append: bucket order IS eventNames() order. */
  ScrEeBucket **link = &reg->head;
  while (*link) link = &(*link)->next;
  *link = b;
  return b;
}

/* Reserve a name's first-registration RANK without any listener: Node's
 * stream classes pre-create their known _events keys (a V8 shape
 * optimization eventNames() order observes — 'error'/'data'/... list
 * before user events added earlier). An empty bucket is ABSENT for every
 * read (n == 0 everywhere); the first add fills it in place, and a bucket
 * emptied by removal still drops — Node deleting the key. */
void scr_emitter_reserve(ScrEmitter *em, const char *name) {
  ScrEeReg *reg = scr_ee_reg_ensure(em);
  reg->shape = true;
  if (scr_ee_bucket_find(reg, name, strlen(name))) return;
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_ee_bucket_ensure(reg, n);
  scr_str_release(n);
}

/* Drops an emptied bucket from the list (Node deletes the _events key; a
 * later add re-appends at the end). */
static void scr_ee_bucket_drop(ScrEeReg *reg, ScrEeBucket *b) {
  ScrEeBucket **link = &reg->head;
  while (*link != b) link = &(*link)->next;
  *link = b->next;
  scr_str_release(b->name);
  free(b->ls);
  free(b);
}

static bool scr_ee_has(ScrEeReg *reg, const char *name) {
  ScrEeBucket *b = scr_ee_bucket_find(reg, name, strlen(name));
  return b != NULL && b->n > 0;
}

/* ── the emitter object (hierarchy prefix helpers) ────────────────────── */

/* rc-0 teardown of the registry: releases EVERYTHING (closures included)
 * and frees the storage. The emitted subclass DIRECT releases call this
 * for their embedded prefix, exactly like a string field's release. */
void scr_emitter_reg_drop(ScrEeReg *reg) {
  if (!reg) return;
  ScrEeBucket *b = reg->head;
  while (b) {
    ScrEeBucket *next = b->next;
    for (size_t i = 0; i < b->n; i++) scr_ee_entry_unref(b->ls[i]);
    scr_str_release(b->name);
    free(b->ls);
    free(b);
    b = next;
  }
  free(reg);
}

/* Collector trace: every entry's direct, adapter, or flex closure is a
 * cycle-headered child. Bucket names are acyclic strings. */
void scr_emitter_reg_trace(ScrEeReg *reg, ScrTraceVisit visit, void *ctx) {
  if (!reg) return;
  for (ScrEeBucket *b = reg->head; b; b = b->next) {
    for (size_t i = 0; i < b->n; i++) {
      if (b->ls[i]->cb) visit(b->ls[i]->cb, ctx);
      if (b->ls[i]->orig) visit(b->ls[i]->orig, ctx);
      if (b->ls[i]->flex_cb) visit(b->ls[i]->flex_cb, ctx);
    }
  }
}

/* Collector teardown: the complement of the trace — releases the names,
 * frees vectors/entries/registry, but NOT the closures (traced edges were
 * already accounted by the collector). */
void scr_emitter_reg_gcfree(ScrEeReg *reg) {
  if (!reg) return;
  ScrEeBucket *b = reg->head;
  while (b) {
    ScrEeBucket *next = b->next;
    for (size_t i = 0; i < b->n; i++) {
      ScrEeEntry *e = b->ls[i];
      if (--e->refs == 0) free(e);
    }
    scr_str_release(b->name);
    free(b->ls);
    free(b);
    b = next;
  }
  free(reg);
}

void scr_emitter_trace(void *obj, ScrTraceVisit visit, void *ctx) {
  scr_emitter_reg_trace(((ScrEmitter *)obj)->reg, visit, ctx);
}

static void scr_emitter_gcfree(void *obj) {
  scr_emitter_reg_gcfree(((ScrEmitter *)obj)->reg);
  scr_obj_free_note();
  scr_cyc_free(obj);
}

static void scr_emitter_release_direct(void *obj) {
  ScrEmitter *em = obj;
  if (--em->rc == 0) {
    scr_cyc_dead(em);
    scr_emitter_reg_drop(em->reg);
    scr_obj_free_note();
    scr_cyc_free(em);
  } else {
    scr_cyc_released(em); /* possible cycle root; may collect */
  }
}

ScrEmitter *scr_emitter_new(void) {
  /* Always collector-headered: the registry holds closures, so the
   * emitter hierarchy is unconditionally cycle-capable (the canonical
   * capture cycle is `e.on('x', () => e.emit(...))`). */
  static ScrCycType cyc_type = { &scr_emitter_trace, &scr_emitter_gcfree, SCR_CYC_KIND_EMITTER };
  ScrEmitter *em = scr_cyc_alloc(sizeof *em, &cyc_type);
  em->rc = 1;
  em->vt = &scr_emitter_vt;
  em->reg = NULL;
  em->cls = "EventEmitter";
  scr_obj_alloc_note();
  return em;
}

/* x.constructor.name of an emitter, a stream, or an instance of an emitted
 * subclass: the class name every allocation stamps (EventEmitter,
 * Readable, ReadStream, Gzip, Socket, the program class's name). +1. */
ScrStr *scr_emitter_class_name(const ScrEmitter *em) {
  return scr_str_new(em->cls, strlen(em->cls));
}

/* super() into the emitter prefix of an emitted subclass: the allocation
 * already zeroed reg and stamped the concrete class's display name, so
 * construction has nothing left to do — the call exists so the super()
 * statement lowers to a real site (and may grow options later). */
void scr_emitter_init(void *obj) { (void)obj; }

ScrEmitter *scr_emitter_retain(ScrEmitter *em) {
  if (em && em->rc != SIZE_MAX) {
    em->rc++;
  }
  return em;
}

void scr_emitter_release(ScrEmitter *em) {
  if (!em || em->rc == SIZE_MAX) return;
  em->vt->release(em); /* the DYNAMIC class's teardown */
}

void *scr_emitter_retain_v(void *em) { return scr_emitter_retain(em); }
void scr_emitter_release_v(void *em) { scr_emitter_release(em); }

/* ── the meta events ('newListener' / 'removeListener') ──────────────── */

static bool scr_ee_emit_va(ScrEmitter *em, ScrStr *name, ...);
static bool scr_ee_emit_mixed_va(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc,
                                 int typed, ...);

static void scr_ee_symbol_name_fence(const char *what) {
  char message[160];
  snprintf(message, sizeof message, "%s with an events.errorMonitor listener is not supported yet",
           what);
  scr_throw_error(SCR_ERR_ERROR, scr_str_new(message, strlen(message)));
}

/* Whether any entry of the bucket was registered as a checked-dynamic
 * function (it can take the untyped argument vector). */
static bool scr_ee_bucket_has_flex(const ScrEeBucket *b) {
  for (size_t i = 0; b && i < b->n; i++) {
    if (b->ls[i]->flex_invoke) return true;
  }
  return false;
}

/* The checked-dynamic function value of a dynamically registered entry
 * (+1), or NULL for a typed listener. Identity lives in the closure, so the
 * rebuilt box compares equal to the value that was registered. */
static ScrDyn *scr_ee_entry_dyn(const ScrEeEntry *e) {
  if (!e->flex_invoke) return NULL;
  return scr_dyn_new_func(scr_closure_retain(e->flex_cb), e->flex_invoke, e->flex_arity,
                          e->flex_sig, e->flex_name);
}

/* A meta event with a listener registered as a checked-dynamic function:
 * the untyped argument vector — the affected event's name and, when it was
 * registered dynamically, the listener (`fn`, borrowed, may be NULL) —
 * beside the typed one-name tuple. False when no such listener exists (the
 * caller emits the typed tuple alone). */
static bool scr_ee_dyn_emit_meta(ScrEmitter *em, ScrStr *meta, ScrStr *name, const ScrDyn *fn) {
  if (!scr_ee_bucket_has_flex(scr_ee_bucket_of(em->reg, meta))) return false;
  ScrDyn *args[2] = { scr_dyn_new_str(name), (ScrDyn *)fn };
  scr_ee_emit_mixed_va(em, meta, args, fn ? 2 : 1, 1, name);
  scr_dyn_release(args[0]);
  return true;
}

/* The function value of a listener about to be removed, for checked-
 * dynamic 'removeListener' listeners (+1), or NULL. */
static ScrDyn *scr_ee_dyn_removed(ScrEmitter *em, const ScrEeEntry *e) {
  if (!scr_ee_bucket_has_flex(scr_ee_bucket_find(em->reg, "removeListener", 14))) return NULL;
  return scr_ee_entry_dyn(e);
}

/* The checked-dynamic half of the registry, installed by the first
 * registration through an untyped value (scr_emitter_on_any): only such
 * listeners take the meta events' untyped argument vector, so programs
 * without untyped emitter calls never reach, or link, this half. */
struct ScrEeDynOps {
  bool (*emit_meta)(ScrEmitter *em, ScrStr *meta, ScrStr *name, const ScrDyn *fn);
  ScrDyn *(*removed)(ScrEmitter *em, const struct ScrEeEntry *e);
};
static const ScrEeDynOps scr_ee_dyn_ops = { &scr_ee_dyn_emit_meta, &scr_ee_dyn_removed };
/* External linkage on purpose: the optimizer must not prove the hook's
 * value from this unit's stores and inline the dynamic half back in. */
SCR_TL const ScrEeDynOps *scr_ee_dyn = NULL;

/* Fires a meta event with the affected event's NAME as the argument.
 * Typed meta listeners are fenced to arity <= 1; listeners registered as
 * checked-dynamic functions also receive the listener Node passes second
 * when it was itself registered dynamically (`fn`, borrowed, may be NULL). */
static void scr_ee_emit_meta(ScrEmitter *em, const char *meta, ScrStr *name, const ScrDyn *fn) {
  if (!scr_ee_has(em->reg, meta)) return;
  /* Node passes the symbol itself, which the string tuple cannot carry. */
  if (scr_ee_is_error_monitor(name)) {
    scr_ee_symbol_name_fence(meta);
    return;
  }
  ScrStr *m = scr_str_new(meta, strlen(meta));
  if (!scr_ee_dyn || !scr_ee_dyn->emit_meta(em, m, name, fn)) scr_ee_emit_va(em, m, name);
  scr_str_release(m);
}

/* ── add / remove ─────────────────────────────────────────────────────── */

/* process.emitWarning's next-tick delivery of the leak warning: to the
 * 'warning' listeners and the default report when the process-warning
 * unit is linked, otherwise the default report alone. */
static void scr_ee_warn_tick(ScrClosure *self) {
  ScrStr *message = (ScrStr *)scr_box_get_ref(self->caps[0]);
  if (scr_warning_emit_hook) {
    scr_warning_emit_hook("MaxListenersExceededWarning", NULL, message);
  } else {
    fflush(stdout);
    fprintf(stderr, "(node:%ld) MaxListenersExceededWarning: %.*s\n", SCR_EE_PID(),
            (int)message->len, message->data);
    if (!scr_warning_trace_hint_shown) {
      scr_warning_trace_hint_shown = true;
      fputs("(Use `node --trace-warnings ...` to show where the warning was created)\n", stderr);
    }
  }
  scr_str_release(message);
}

static void scr_ee_warn_maybe(ScrEmitter *em, ScrEeBucket *b) {
  ScrEeReg *reg = em->reg;
  double max = reg->max >= 0 ? reg->max : scr_emitter_default_max;
  if (b->warned || max <= 0 || (double)b->n <= max) return;
  b->warned = true;
  /* Node's message, except the pid, which is this process's. Node emits
   * the warning through process.emitWarning, which delivers it on the next
   * tick. */
  char count[32], limit[32];
  snprintf(count, sizeof count, "%zu", b->n);
  snprintf(limit, sizeof limit, "%g", max);
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "Possible EventEmitter memory leak detected. ");
  scr_jb_puts(&text, count);
  scr_jb_putc(&text, ' ');
  scr_jb_write(&text, b->name->data, b->name->len);
  scr_jb_puts(&text, " listeners added to [");
  scr_jb_puts(&text, em->cls);
  scr_jb_puts(&text, "]. MaxListeners is ");
  scr_jb_puts(&text, limit);
  scr_jb_puts(&text, ". Use emitter.setMaxListeners() to increase limit");
  ScrClosure *tick = scr_closure_new((void *)&scr_ee_warn_tick, 1);
  ScrBox *box = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(box, scr_jb_finish(&text));
  tick->caps[0] = box;
  scr_next_tick(tick);
}

/* Registers a listener. cb and orig MOVE in; name is borrowed. Returns em
 * +1 (the `return this` chaining value). 'newListener' fires BEFORE the
 * add, like Node. A listener throw inside the meta emit leaves the
 * exception pending; the add still happens (Node's addListener has no
 * try). */
static ScrEmitter *scr_ee_add(ScrEmitter *em, ScrStr *name, ScrClosure *cb /*moves*/,
                              ScrClosure *orig /*moves; may be NULL*/,
                              ScrEeInvoke inv, const ScrDyn *dyn /*borrowed; may be NULL*/,
                              bool once, bool prepend) {
  scr_ee_reg_ensure(em);
  scr_ee_emit_meta(em, "newListener", name, dyn);
  ScrEeBucket *b = scr_ee_bucket_ensure(em->reg, name);
  ScrEeEntry *e = calloc(1, sizeof *e);
  if (!e) scr_ee_oom();
  e->cb = cb;
  e->orig = orig;
  e->inv = inv;
  if (dyn) {
    e->flex_cb = scr_closure_retain(dyn->v.fn.clo);
    e->flex_invoke = dyn->v.fn.thunk;
    e->flex_message = dyn->v.fn.message;
    e->flex_sig = dyn->v.fn.sig;
    e->flex_name = dyn->v.fn.name;
    e->flex_arity = dyn->v.fn.arity;
  }
  e->once = once;
  e->refs = 1;
  if (b->n == b->cap) {
    b->cap = b->cap ? b->cap * 2 : 2;
    b->ls = realloc(b->ls, b->cap * sizeof *b->ls);
    if (!b->ls) scr_ee_oom();
  }
  if (prepend) {
    memmove(b->ls + 1, b->ls, b->n * sizeof *b->ls);
    b->ls[0] = e;
  } else {
    b->ls[b->n] = e;
  }
  b->n++;
  if (b->n == 1) scr_ee_observe(em, name, true);
  scr_ee_warn_maybe(em, b);
  if (scr_emitter_on_hook != NULL) scr_emitter_on_hook(em, name);
  return scr_emitter_retain(em);
}

ScrEmitter *scr_emitter_on(ScrEmitter *em, ScrStr *name, ScrClosure *cb /*moves*/,
                            ScrEeInvoke inv, bool once, bool prepend) {
  return scr_ee_add(em, name, cb, NULL, inv, NULL, once, prepend);
}

/* events.once(emitter, name): a pending promise of the event's arguments
 * as an array. Two one-shot typed listeners share the state below: the
 * event's, which fulfills with the array its compiler-built boxer makes,
 * and (unless the event is 'error') an 'error' listener, which rejects with
 * the error. Whichever fires first settles the promise and removes the
 * other, like Node. The emitter and the two closures are weak here: the
 * closures live in the emitter's listener entries, so neither can outlive
 * it, and holding them strongly would cycle through the entries. Each
 * closure's caps[0] is its boxer and caps[1] the shared state. */
static void scr_ee_unadd(ScrEmitter *em, ScrStr *name, ScrClosure *cb);

typedef struct ScrEeOnce {
  size_t rc;
  ScrPromise *promise;
  ScrEmitter *em;
  ScrStr *name;
  ScrClosure *event_cb;
  ScrClosure *error_cb;
  bool settled;
} ScrEeOnce;

static void *scr_ee_once_retain(void *p) {
  ((ScrEeOnce *)p)->rc++;
  return p;
}

static void scr_ee_once_release(void *p) {
  ScrEeOnce *st = p;
  if (--st->rc > 0) return;
  scr_promise_release(st->promise);
  scr_str_release(st->name);
  free(st);
}

static ScrClosure *scr_ee_once_closure(void *adapter, ScrClosure *boxer, ScrEeOnce *st) {
  ScrClosure *c = scr_closure_new(adapter, 2);
  ScrBox *bx = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(bx, scr_closure_retain(boxer));
  c->caps[0] = bx;
  ScrBox *sb = scr_box_new_obj(scr_ee_once_retain, scr_ee_once_release, NULL);
  scr_box_set_ref(sb, scr_ee_once_retain(st));
  c->caps[1] = sb;
  return c;
}

static ScrBox *scr_ee_once_promise_box(ScrPromise *p) {
  ScrBox *box = scr_box_new_obj(&scr_promise_retain_v, &scr_promise_release_v, &scr_promise_trace_v);
  scr_box_set_ref(box, scr_promise_retain(p));
  return box;
}

static void scr_ee_once_adopt_job(ScrClosure *job) {
  ScrPromise *outer = scr_box_get_ref(job->caps[0]);
  ScrPromise *inner = scr_box_get_ref(job->caps[1]);
  scr_promise_race_join(outer, inner, &scr_promise_adapt_copy);
  scr_promise_release(inner);
  scr_promise_release(outer);
}

/* boxer and err_boxer are borrowed; the result is +1. err_boxer is NULL
 * when the awaited event is 'error' itself. Node's once is an async
 * function returning the executor's promise, so the result adopts that
 * promise through a thenable job queued here, whose reaction settles the
 * result one turn after the executor's promise settles. */
ScrPromise *scr_events_once(ScrEmitter *em, ScrStr *name, ScrClosure *boxer, void *adapter,
                            ScrEeInvoke inv, ScrClosure *err_boxer, void *err_adapter,
                            ScrEeInvoke err_inv) {
  ScrEeOnce *st = calloc(1, sizeof *st);
  if (!st) scr_ee_oom();
  st->rc = 1;
  st->promise = scr_promise_new();
  st->em = em;
  st->name = scr_str_retain(name);
  st->event_cb = scr_ee_once_closure(adapter, boxer, st);
  if (err_boxer != NULL) st->error_cb = scr_ee_once_closure(err_adapter, err_boxer, st);
  /* Node registers both inside the promise's executor: a throwing
   * 'newListener' listener rejects the promise instead of throwing, and the
   * listener it announced is never added (the event's listener stays when
   * only the 'error' announcement throws). */
  ScrCaught *thrown = NULL;
  scr_emitter_release(scr_ee_add(em, name, st->event_cb, NULL, inv, NULL, true, false));
  if (scr_exc_pending()) {
    thrown = scr_exc_take();
    scr_ee_unadd(em, name, st->event_cb);
    if (st->error_cb != NULL) scr_closure_release(st->error_cb); /* never registered */
    st->event_cb = st->error_cb = NULL;
  } else if (st->error_cb != NULL) {
    ScrStr *error = scr_str_new("error", 5);
    scr_emitter_release(scr_ee_add(em, error, st->error_cb, NULL, err_inv, NULL, true, false));
    if (scr_exc_pending()) {
      thrown = scr_exc_take();
      scr_ee_unadd(em, error, st->error_cb);
      st->error_cb = NULL;
    }
    scr_str_release(error);
  }
  if (thrown != NULL) {
    st->settled = true;
    scr_rethrow(thrown);
    scr_caught_release(thrown);
    scr_promise_reject_pending(st->promise);
  }
  ScrPromise *outer = scr_promise_new();
  ScrClosure *job = scr_closure_new((void *)&scr_ee_once_adopt_job, 2);
  job->caps[0] = scr_ee_once_promise_box(outer);
  job->caps[1] = scr_ee_once_promise_box(st->promise);
  scr_queue_microtask(job);
  scr_ee_once_release(st);
  return outer;
}

/* The adapter's tail: `cb` is the firing listener closure, `args` the
 * boxed event arguments (moves in). */
void scr_events_once_fire(ScrClosure *cb, ScrArr *args) {
  ScrEeOnce *st = (ScrEeOnce *)scr_box_get_ref(cb->caps[1]);
  if (!st->settled) {
    st->settled = true;
    bool error = cb == st->error_cb;
    /* The other listener leaves the emitter (its once entry has not fired). */
    ScrClosure *other = error ? st->event_cb : st->error_cb;
    if (other != NULL) {
      ScrStr *other_name = error ? scr_str_retain(st->name) : scr_str_new("error", 5);
      scr_emitter_release(scr_emitter_off(st->em, other_name, other));
      scr_str_release(other_name);
    }
    if (error) {
      ScrDyn *reason = (ScrDyn *)scr_arr_get_ref(args, 0);
      scr_dyn_throw(reason); /* moves reason */
      scr_promise_reject_pending(st->promise);
    } else {
      scr_promise_fulfill_ref(st->promise, scr_arr_retain(args), scr_arr_retain_v,
                              scr_arr_release_v, args->cyc ? scr_arr_trace_v : NULL);
    }
  }
  scr_arr_release(args);
  scr_ee_once_release(st);
}

/* The dyn-adapted registration (JS-lane checked-dynamic listeners): the
 * ADAPTER closure (compiler-built — boxes the event tuple to dyn and
 * calls the original through the checked-dynamic machinery) is what a
 * typed emit invokes; the ORIGINAL function (the dyn box's underlying
 * closure) is the entry's identity, and its checked-dynamic thunk is what
 * an untyped emit of the same name invokes, with every argument as given.
 * cb must be a SCR_DYN_FUNC (the emitted scr_emitter_check_listener ran
 * first); adapter MOVES in, cb is borrowed. */
ScrEmitter *scr_emitter_on_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *cb,
                                ScrClosure *adapter /*moves*/,
                                ScrEeInvoke inv, bool once, bool prepend) {
  return scr_ee_add(em, name, adapter, scr_closure_retain(cb->v.fn.clo), inv,
                    cb->kind == SCR_DYN_FUNC ? cb : NULL, once, prepend);
}

/* The typed adapters of a checked-dynamic listener on the events whose
 * tuples the runtime itself fixes: 'error' (one Error) and the meta
 * events (one name string). caps[0] holds the dynamic function in a traced
 * box, so a listener capturing its emitter stays collectable. */
static void scr_ee_dyn_fire(ScrClosure *self, ScrDyn *arg /*moves*/) {
  ScrDyn *fn = scr_box_get_ref(self->caps[0]); /* +1 */
  ScrDyn *args[1] = { arg };
  scr_dyn_release(scr_dyn_call(fn, args, 1, "listener"));
  scr_dyn_release(arg);
  scr_dyn_release(fn);
}

static void scr_ee_dyn_error_fire(ScrClosure *self, ScrError *err) {
  scr_ee_dyn_fire(self, scr_dyn_from_error(err));
}

static void scr_ee_dyn_name_fire(ScrClosure *self, ScrStr *name) {
  scr_ee_dyn_fire(self, scr_dyn_new_str(name));
}

static ScrClosure *scr_ee_dyn_adapter(const ScrDyn *cb, void *fire) {
  ScrClosure *clo = scr_closure_new(fire, 1);
  ScrBox *box = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, &scr_dyn_trace_v);
  scr_box_set_ref(box, scr_dyn_retain((ScrDyn *)cb));
  clo->caps[0] = box;
  return clo;
}

static bool scr_ee_is_name(const ScrStr *name, const char *literal) {
  size_t len = strlen(literal);
  return name->len == len && memcmp(name->data, literal, len) == 0;
}

/* A listener registered as a checked-dynamic function (computed event
 * names, and runtime-internal registries such as the worker events, whose
 * emits are untyped): its thunk alone. cb must be a function value (the
 * caller ran the listener check). */
ScrEmitter *scr_emitter_on_flex(ScrEmitter *em, ScrStr *name, const ScrDyn *cb,
                                bool once, bool prepend) {
  if (cb->kind != SCR_DYN_FUNC) {
    scr_dyn_check_listener(cb, "listener");
    return scr_emitter_retain(em);
  }
  return scr_ee_add(em, name, NULL, NULL, NULL, cb, once, prepend);
}

/* on/once/prepend* through an untyped value, under a name the program never
 * fixes a tuple for: the thunk, and under 'error' and the meta events, whose
 * tuples typed code and the runtime emit with, a runtime-built typed adapter
 * too. Installs the registry's dynamic half. */
ScrEmitter *scr_emitter_on_any(ScrEmitter *em, ScrStr *name, const ScrDyn *cb,
                               bool once, bool prepend) {
  if (cb->kind != SCR_DYN_FUNC) {
    scr_dyn_check_listener(cb, "listener");
    return scr_emitter_retain(em);
  }
  scr_ee_dyn = &scr_ee_dyn_ops;
  void *fire = NULL;
  if (!scr_ee_is_error_monitor(name)) {
    if (scr_ee_is_name(name, "error")) fire = (void *)&scr_ee_dyn_error_fire;
    else if (scr_ee_is_name(name, "newListener") || scr_ee_is_name(name, "removeListener"))
      fire = (void *)&scr_ee_dyn_name_fire;
  }
  if (fire) {
    return scr_ee_add(em, name, scr_ee_dyn_adapter(cb, fire),
                      scr_closure_retain(cb->v.fn.clo), &scr_ee_inv_fixed1, cb, once, prepend);
  }
  return scr_ee_add(em, name, NULL, NULL, NULL, cb, once, prepend);
}

/* The adapter-mediated registration (the LLVM backend): adapter is what
 * emit invokes, orig is the entry's identity — the on_dyn split with a
 * plain-closure identity. Both move in. */
ScrEmitter *scr_emitter_on_via(ScrEmitter *em, ScrStr *name, ScrClosure *orig /*moves*/,
                                ScrClosure *adapter /*moves*/,
                                ScrEeInvoke inv, bool once, bool prepend) {
  return scr_ee_add(em, name, adapter, orig, inv, NULL, once, prepend);
}

/* ── fixed-arity invoke shims (scr_runtime.h's contract) ──────────────
 * Read k pointer-size slots and call the fixed-signature adapter behind
 * cb->fn. The LLVM lane's emit sites pass scalars by pointer to typed stack
 * slots and references directly; the runtime's own emits are pointer-only,
 * so va_arg(ap, void *) reads every tuple a fixed-registered listener can
 * observe on 32- and 64-bit targets. */
void scr_ee_inv_fixed0(ScrClosure *cb, va_list ap) {
  (void)ap;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}
void scr_ee_inv_fixed1(ScrClosure *cb, va_list ap) {
  void *a0 = va_arg(ap, void *);
  ((void (*)(ScrClosure *, void *))cb->fn)(cb, a0);
}
void scr_ee_inv_fixed2(ScrClosure *cb, va_list ap) {
  void *a0 = va_arg(ap, void *);
  void *a1 = va_arg(ap, void *);
  ((void (*)(ScrClosure *, void *, void *))cb->fn)(cb, a0, a1);
}
void scr_ee_inv_fixed3(ScrClosure *cb, va_list ap) {
  void *a0 = va_arg(ap, void *);
  void *a1 = va_arg(ap, void *);
  void *a2 = va_arg(ap, void *);
  ((void (*)(ScrClosure *, void *, void *, void *))cb->fn)(cb, a0, a1, a2);
}
void scr_ee_inv_fixed4(ScrClosure *cb, va_list ap) {
  void *a0 = va_arg(ap, void *);
  void *a1 = va_arg(ap, void *);
  void *a2 = va_arg(ap, void *);
  void *a3 = va_arg(ap, void *);
  ((void (*)(ScrClosure *, void *, void *, void *, void *))cb->fn)(cb, a0, a1, a2, a3);
}

void scr_ee_inv_args(ScrClosure *cb, va_list ap) {
  va_list cursor;
  va_copy(cursor, ap);
  ((void (*)(ScrClosure *, void *))cb->fn)(cb, &cursor);
  va_end(cursor);
}

void *scr_ee_arg_next(void *cursor) {
  return va_arg(*(va_list *)cursor, void *);
}

/* Removes one entry (by index) from a bucket's live list and fires the
 * 'removeListener' meta event AFTER the removal, Node's order. Drops the
 * bucket when emptied — except in shape mode, where the emptied name
 * keeps its rank (Node's events[type] = undefined). */
static void scr_ee_remove_at_quiet(ScrEmitter *em, ScrEeBucket *b, size_t i) {
  ScrEeEntry *e = b->ls[i];
  memmove(b->ls + i, b->ls + i + 1, (b->n - i - 1) * sizeof *b->ls);
  b->n--;
  ScrStr *name = scr_str_retain(b->name);
  if (b->n == 0) scr_ee_observe(em, name, false);
  if (b->n == 0 && !em->reg->shape) scr_ee_bucket_drop(em->reg, b);
  scr_ee_entry_unref(e);
  scr_str_release(name);
}

static void scr_ee_remove_at(ScrEmitter *em, ScrEeBucket *b, size_t i) {
  ScrStr *name = scr_str_retain(b->name);
  /* The removed listener as a function value, for checked-dynamic
   * 'removeListener' listeners (Node's second argument). */
  ScrDyn *fn = scr_ee_dyn ? scr_ee_dyn->removed(em, b->ls[i]) : NULL;
  scr_ee_remove_at_quiet(em, b, i);
  scr_ee_emit_meta(em, "removeListener", name, fn);
  if (fn) scr_dyn_release(fn);
  scr_str_release(name);
}

/* Takes back the listener closure `cb` that scr_ee_add just registered
 * under `name`, without a 'removeListener' event: its 'newListener'
 * announcement threw, and Node never adds such a listener. */
static void scr_ee_unadd(ScrEmitter *em, ScrStr *name, ScrClosure *cb) {
  ScrEeBucket *b = em->reg ? scr_ee_bucket_of(em->reg, name) : NULL;
  if (!b) return;
  for (size_t i = b->n; i-- > 0;) {
    if (b->ls[i]->cb == cb) {
      scr_ee_remove_at_quiet(em, b, i);
      return;
    }
  }
}

/* removeListener/off: the LAST matching occurrence leaves (Node searches
 * from the end). cb is borrowed. Returns em +1. */
ScrEmitter *scr_emitter_off(ScrEmitter *em, ScrStr *name, ScrClosure *cb) {
  ScrEeBucket *b = em->reg ? scr_ee_bucket_of(em->reg, name) : NULL;
  if (b) {
    for (size_t i = b->n; i-- > 0;) {
      if (scr_closure_identity_equal(scr_ee_entry_fn(b->ls[i]), cb)) {
        scr_ee_remove_at(em, b, i);
        break;
      }
    }
  }
  return scr_emitter_retain(em);
}

/* off/removeListener with a checked-dynamic listener: the identity is the
 * dyn box's underlying closure (check_listener ran first — the kind IS
 * function). cb borrowed; returns em +1. */
ScrEmitter *scr_emitter_off_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *cb) {
  return scr_emitter_off(em, name, cb->v.fn.clo);
}

/* The listener-argument type check Node runs first in the whole
 * registration family (on, once, the prepend forms, removeListener): a
 * non-function throws the catchable ERR_INVALID_ARG_TYPE TypeError,
 * message shaped by errors.js's determineSpecificType (scalars render
 * inspected and truncate at 28 rendered chars to 25 + "..."; strings take
 * the simple '-quoted spelling — listener mistakes are words, not escape
 * zoos). */
void scr_emitter_check_listener(const ScrDyn *cb) {
  /* The shared gate lives in the always-linked dyn core (scr_json.c) so
   * the handle dispatchers' .on paths render the same shapes without
   * linking this unit. */
  scr_dyn_check_listener(cb, "listener");
}

/* removeAllListeners(name?) — all = no name argument. With NO
 * 'removeListener' listeners this is a plain wipe (no events, Node's fast
 * path). With them, listeners leave ONE AT A TIME in LIFO order, each
 * firing the meta event — and the whole-emitter form does every other
 * event first (bucket order), 'removeListener' itself LAST. Returns em +1. */
static void scr_ee_remove_all_named(ScrEmitter *em, ScrEeBucket *b, bool meta) {
  if (b->n == 0) {
    /* An empty rank-holding bucket reaches here only from the WIPE scan
     * (the named form skips undefined keys — Node no-ops and the rank
     * stays): drop it, the wipe resets _events wholesale. */
    scr_ee_bucket_drop(em->reg, b);
    return;
  }
  if (!meta) {
    for (size_t i = 0; i < b->n; i++) scr_ee_entry_unref(b->ls[i]);
    b->n = 0;
    scr_ee_observe(em, b->name, false);
    scr_ee_bucket_drop(em->reg, b);
    return;
  }
  /* Node snapshots the list and removeListener()s each entry from the
   * END (LIFO): meta listeners run per removal, and anything they add
   * survives. The bucket can drop (and even be recreated) under the
   * pass, so every step re-finds it and matches entries by identity. */
  ScrStr *name = scr_str_retain(b->name);
  size_t n = b->n;
  ScrEeEntry **snap = malloc(n * sizeof *snap);
  if (!snap) scr_ee_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = b->ls[i];
    snap[i]->refs++;
  }
  for (size_t i = n; i-- > 0;) {
    ScrEeEntry *e = snap[i];
    ScrEeBucket *live = scr_ee_bucket_of(em->reg, name);
    if (live) {
      for (size_t j = live->n; j-- > 0;) {
        if (live->ls[j] == e) {
          scr_ee_remove_at(em, live, j);
          break;
        }
      }
    }
    scr_ee_entry_unref(e);
  }
  free(snap);
  scr_str_release(name);
}

ScrEmitter *scr_emitter_remove_all(ScrEmitter *em, ScrStr *name, bool all) {
  ScrEeReg *reg = em->reg;
  if (!reg) return scr_emitter_retain(em);
  bool meta = scr_ee_has(reg, "removeListener");
  if (!all) {
    ScrEeBucket *b = scr_ee_bucket_of(reg, name);
    /* A rank-holding empty bucket is Node's `events[type] === undefined`:
     * the named form no-ops there (the rank survives). A POPULATED name
     * deletes its key even in shape mode — but through the meta path each
     * listener leaves via removeListener, whose shape rule KEEPS the
     * emptied rank (Node's exact split). */
    if (b && b->n > 0) {
      scr_ee_remove_all_named(em, b, meta);
      if (!meta) {
        /* Node's non-meta named branch: the count hitting zero replaces
         * _events wholesale — every rank (pre-created included) goes,
         * though kShapeMode itself stays set (Node's exact quirk). */
        bool any_live = false;
        for (ScrEeBucket *w = reg->head; w; w = w->next) {
          if (w->n > 0) { any_live = true; break; }
        }
        if (!any_live) {
          while (reg->head) scr_ee_bucket_drop(reg, reg->head);
        }
      }
    }
    return scr_emitter_retain(em);
  }
  /* Every event except 'removeListener' first, in bucket order; then
   * 'removeListener' itself. The bucket list mutates under us (drops,
   * meta listeners may add), so restart the scan after each bucket. */
  for (;;) {
    ScrEeBucket *pick = NULL;
    for (ScrEeBucket *b = reg->head; b; b = b->next) {
      if (b->name->len == 14 && memcmp(b->name->data, "removeListener", 14) == 0) continue;
      pick = b;
      break;
    }
    if (!pick) break;
    scr_ee_remove_all_named(em, pick, meta);
  }
  ScrEeBucket *rl = scr_ee_bucket_find(reg, "removeListener", 14);
  if (rl) scr_ee_remove_all_named(em, rl, meta);
  /* The wipe replaces _events wholesale in Node — pre-created ranks are
   * gone and the emitter leaves shape mode. */
  while (reg->head) scr_ee_bucket_drop(reg, reg->head);
  reg->shape = false;
  return scr_emitter_retain(em);
}

/* ── emit ─────────────────────────────────────────────────────────────── */

/* The checked-dynamic argument vector of an untyped emit without
 * arguments: flex_args is non-NULL exactly when the emit carries one. */
static ScrDyn *const scr_ee_no_args[1] = { NULL };

/* A typed emit site passes its event's tuple as C variadics (ap_template);
 * an untyped emit passes the checked-dynamic arguments as given
 * (flex_args); an untyped emit of an event typed code also uses passes both
 * (the compiler converted the arguments to the event's tuple for listeners
 * with typed parameters).
 *
 * One dispatch pass over a SNAPSHOT of the bucket: entries invoke in list
 * order, each listener registered as a checked-dynamic function through its
 * thunk when the emit carries untyped arguments, otherwise through its
 * emitted adapter with a fresh va_copy of the typed tail. A once entry
 * leaves the live list (firing 'removeListener', Node's wrapper calls
 * removeListener) BEFORE its callback runs, and never runs twice even when
 * a nested emit's snapshot still holds it (the shared fired flag — Node's
 * wrapper.fired). A listener throw stops the pass (the exception stays
 * pending for the caller). Returns whether the bucket had listeners. */
typedef struct ScrEeMessage ScrEeMessage;
static bool scr_ee_emit_core(ScrEmitter *em, ScrStr *name, va_list *ap_template,
                             ScrDyn *const *flex_args, size_t flex_argc, ScrEeMessage *message);

/* emit('error', ...) first emits the same arguments to errorMonitor. */
static void scr_ee_emit_error_monitor(ScrEmitter *em, va_list *ap_template,
                                      ScrDyn *const *flex_args, size_t flex_argc) {
  ScrEeBucket *b = scr_ee_bucket_of(em->reg, SCR_EE_ERROR_MONITOR);
  if (!b || b->n == 0) return;
  scr_ee_emit_core(em, SCR_EE_ERROR_MONITOR, ap_template, flex_args, flex_argc, NULL);
}

/* A listener this emit has no argument form for: an untyped emit whose
 * arguments have no conversion to a typed listener's parameters, or a typed
 * emit reaching a dynamic listener without a typed adapter. Throws (the
 * pass stops like a listener throw); never traps. */
SCR_COLD static void scr_ee_listener_mismatch(const ScrStr *name, bool typed_emit) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  if (typed_emit) {
    scr_jb_puts(&text, "emitting '");
    scr_jb_write(&text, name->data, name->len);
    scr_jb_puts(&text, "' with typed arguments to a listener registered through an untyped value is not supported yet");
  } else {
    scr_jb_puts(&text, "The '");
    scr_jb_write(&text, name->data, name->len);
    scr_jb_puts(&text, "' listener has typed parameters the arguments of this untyped emit do not convert to");
  }
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error(typed_emit ? SCR_ERR_ERROR : SCR_ERR_TYPE, message);
}

/* A message emit (scr_emitter_emit_message): listeners with a typed message
 * entry read the message until a listener without one runs; that listener
 * and every later one share one decoded argument. */
struct ScrEeMessage {
  const struct ScrMessage *message;
  ScrDyn *(*decode)(const struct ScrMessage *);
  ScrDyn *decoded;
};

static bool scr_ee_emit_core(ScrEmitter *em, ScrStr *name, va_list *ap_template,
                             ScrDyn *const *flex_args, size_t flex_argc, ScrEeMessage *message) {
  if (name->len == 5 && memcmp(name->data, "error", 5) == 0) {
    scr_ee_emit_error_monitor(em, ap_template, flex_args, flex_argc);
    if (scr_exc_pending()) return true;
  }
  ScrEeBucket *b = em->reg ? scr_ee_bucket_of(em->reg, name) : NULL;
  if (!b || b->n == 0) return false;
  size_t n = b->n;
  ScrEeEntry **snap = malloc(n * sizeof *snap);
  if (!snap) scr_ee_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = b->ls[i];
    snap[i]->refs++;
  }
  for (size_t i = 0; i < n; i++) {
    ScrEeEntry *e = snap[i];
    if (scr_exc_pending()) {
      scr_ee_entry_unref(e);
      continue;
    }
    if (e->once) {
      if (e->fired) {
        scr_ee_entry_unref(e);
        continue;
      }
      e->fired = true;
      /* Remove from the live list first (the wrapper's own removal). The
       * bucket may have been dropped/recreated by earlier listeners —
       * re-find it and match by entry identity. */
      ScrEeBucket *live = scr_ee_bucket_of(em->reg, name);
      if (live) {
        for (size_t j = 0; j < live->n; j++) {
          if (live->ls[j] == e) {
            scr_ee_remove_at(em, live, j);
            break;
          }
        }
      }
      if (scr_exc_pending()) { /* a removeListener meta listener threw */
        scr_ee_entry_unref(e);
        continue;
      }
    }
    /* Once a listener has the decoded value, later listeners read that
     * value: an earlier listener may have changed it, as in Node. */
    if (message && !message->decoded && e->flex_message &&
        e->flex_message(e->flex_cb, message->message)) {
      scr_ee_entry_unref(e);
      continue;
    }
    if (message && !message->decoded) {
      message->decoded = message->decode(message->message);
      if (!message->decoded) {
        scr_ee_entry_unref(e);
        continue;
      }
      flex_args = &message->decoded;
      flex_argc = 1;
    }
    if (flex_args && e->flex_invoke) {
      ScrDyn *answer = e->flex_invoke(e->flex_cb, flex_args, flex_argc);
      scr_dyn_release(answer); /* EventEmitter ignores callback results. */
    } else if (ap_template && e->inv) {
      va_list ap;
      va_copy(ap, *ap_template);
      e->inv(e->cb, ap);
      va_end(ap);
    } else {
      scr_ee_listener_mismatch(name, ap_template != NULL);
    }
    scr_ee_entry_unref(e);
  }
  free(snap);
  return true;
}

static bool scr_ee_emit_va(ScrEmitter *em, ScrStr *name, ...) {
  va_list ap;
  va_start(ap, name);
  bool had = scr_ee_emit_core(em, name, &ap, NULL, 0, NULL);
  va_end(ap);
  return had;
}

/* An untyped emit with the typed tuple too when `typed` (the variadics),
 * or the untyped arguments alone. */
static bool scr_ee_emit_mixed_va(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc,
                                 int typed, ...) {
  va_list ap;
  va_start(ap, typed);
  bool had = scr_ee_emit_core(em, name, typed ? &ap : NULL, args ? args : scr_ee_no_args, argc, NULL);
  va_end(ap);
  return had;
}

/* emit(name, ...tuple) — the emitted call site passes the event's unified
 * tuple as typed C variadics (doubles, pointers, ints for bools); every
 * argument is BORROWED (adapters retain the +1 each callee owns). May
 * leave an exception pending (a listener threw). */
bool scr_emitter_emit(ScrEmitter *em, ScrStr *name, ...) {
  va_list ap;
  va_start(ap, name);
  bool had = scr_ee_emit_core(em, name, &ap, NULL, 0, NULL);
  va_end(ap);
  return had;
}

/* An untyped emit of an event typed code also emits or listens to: the
 * arguments as given (borrowed) for listeners registered as checked-dynamic
 * functions, and the compiler-converted tuple (the variadics, scr_emitter_emit's
 * form) for typed listeners. */
bool scr_emitter_emit_mixed(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc, ...) {
  va_list ap;
  va_start(ap, argc);
  bool had = scr_ee_emit_core(em, name, &ap, args ? args : scr_ee_no_args, argc, NULL);
  va_end(ap);
  return had;
}

/* Whether an untyped emit of `name` reaches a listener without a checked-
 * dynamic thunk (one registered with typed parameters), so the arguments
 * must convert to the event's tuple first. Includes errorMonitor for
 * 'error'. */
bool scr_emitter_has_typed(ScrEmitter *em, ScrStr *name) {
  ScrEeBucket *b = em->reg ? scr_ee_bucket_of(em->reg, name) : NULL;
  for (size_t i = 0; b && i < b->n; i++) {
    if (!b->ls[i]->flex_invoke) return true;
  }
  if (!scr_ee_is_error_monitor(name) && scr_ee_is_name(name, "error"))
    return scr_emitter_has_typed(em, SCR_EE_ERROR_MONITOR);
  return false;
}

/* Node's ERR_UNHANDLED_ERROR for a non-Error payload: the message quotes
 * util.inspect of the payload. This unit renders the primitive payloads
 * inspect prints plainly; others report that they are not supported. */
static void scr_ee_unhandled_error(const ScrDyn *er) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "Unhandled error. (");
  bool shown = true;
  switch (er->kind) {
  case SCR_DYN_UNDEF: scr_jb_puts(&text, "undefined"); break;
  case SCR_DYN_NULL: scr_jb_puts(&text, "null"); break;
  case SCR_DYN_BOOL: scr_jb_puts(&text, er->v.b ? "true" : "false"); break;
  case SCR_DYN_NUM: {
    char num[32];
    if (er->v.num == 0 && 1 / er->v.num < 0) {
      scr_jb_puts(&text, "-0");
    } else {
      size_t len = scr_f64_to_str(er->v.num, num);
      scr_jb_write(&text, num, len);
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
      scr_jb_putc(&text, '\'');
      scr_jb_write(&text, s->data, s->len);
      scr_jb_putc(&text, '\'');
    }
    break;
  }
  default: shown = false; break;
  }
  ScrStr *message = scr_jb_finish(&text);
  if (shown) {
    ScrJsonBuf full;
    scr_jb_init(&full);
    scr_jb_write(&full, message->data, message->len);
    scr_jb_putc(&full, ')');
    ScrStr *rendered = scr_jb_finish(&full);
    scr_throw_error_msg_code(SCR_ERR_ERROR, rendered->data, rendered->len, "ERR_UNHANDLED_ERROR");
    scr_str_release(rendered);
  } else {
    const char *refusal =
        "emit('error') through an untyped value with this non-Error payload and no 'error' listener is not supported yet";
    scr_throw_error(SCR_ERR_ERROR, scr_str_new(refusal, strlen(refusal)));
  }
  scr_str_release(message);
}

/* emit('error', ...) through an untyped value: errorMonitor first; with no
 * 'error' listener an Error payload throws itself and anything else throws
 * ERR_UNHANDLED_ERROR, Node's contract; otherwise listeners receive the
 * arguments as given, and typed listeners the payload as an Error. */
static bool scr_ee_emit_error_dyn(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc) {
  const ScrDyn *er = argc ? args[0] : scr_dyn_undefined();
  ScrError *err = scr_dyn_err_instanceof(er, SCR_ERR_ERROR) ? scr_errdyn_err_of(er) : NULL;
  bool had = false;
  if (!scr_ee_has(em->reg, "error")) {
    scr_ee_emit_mixed_va(em, SCR_EE_ERROR_MONITOR, args, argc, err != NULL, err);
    if (!scr_exc_pending()) {
      if (err) scr_dyn_throw(scr_dyn_retain((ScrDyn *)er));
      else scr_ee_unhandled_error(er);
    }
  } else {
    had = scr_ee_emit_mixed_va(em, name, args, argc, err != NULL, err);
  }
  scr_error_release(err);
  return had;
}

/* An untyped emit of a name typed code never fixes a tuple for (computed
 * names, runtime-internal registries): the arguments as given. */
bool scr_emitter_emit_flex(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc) {
  return scr_ee_emit_core(em, name, NULL, args ? args : scr_ee_no_args, argc, NULL);
}

bool scr_emitter_emit_message(ScrEmitter *em, ScrStr *name, const struct ScrMessage *message,
                              ScrDyn *(*decode)(const struct ScrMessage *)) {
  ScrEeMessage state = {message, decode, NULL};
  bool had = scr_ee_emit_core(em, name, NULL, NULL, 0, &state);
  scr_dyn_release(state.decoded);
  return had;
}

/* emit(name, ...args) through an untyped value: the arguments as given.
 * 'error' keeps Node's unhandled-error contract, and the meta events reach
 * typed listeners with a string name. */
bool scr_emitter_emit_any(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc) {
  if (!scr_ee_is_error_monitor(name)) {
    if (scr_ee_is_name(name, "error")) return scr_ee_emit_error_dyn(em, name, args, argc);
    if (scr_ee_is_name(name, "newListener") || scr_ee_is_name(name, "removeListener")) {
      ScrStr *s = argc && args[0]->kind == SCR_DYN_STR ? args[0]->v.str : NULL;
      return scr_ee_emit_mixed_va(em, name, args, argc, s != NULL, s);
    }
  }
  return scr_ee_emit_core(em, name, NULL, args ? args : scr_ee_no_args, argc, NULL);
}

/* Handle event registries use checked callbacks for every tuple, including
 * errors. Keep this separate from the statically typed Error ABI above. */
bool scr_emitter_emit_error_flex(ScrEmitter *em, ScrDyn *error) {
  if (!scr_ee_has(em->reg, "error")) {
    scr_ee_emit_error_monitor(em, NULL, &error, 1);
    if (scr_exc_pending()) return false;
    scr_dyn_throw(scr_dyn_retain(error));
    return false;
  }
  ScrStr *name = scr_str_new("error", 5);
  bool had = scr_ee_emit_core(em, name, NULL, &error, 1, NULL);
  scr_str_release(name);
  return had;
}

/* emit('error', err) — Node's special event: with no 'error' listener the
 * payload THROWS (catchable; uncaught exits 1 with the error report).
 * err is borrowed; the throw takes its own +1. */
static void scr_ee_emit_error_monitor_va(ScrEmitter *em, ...) {
  va_list ap;
  va_start(ap, em);
  scr_ee_emit_error_monitor(em, &ap, NULL, 0);
  va_end(ap);
}

bool scr_emitter_emit_error(ScrEmitter *em, ScrStr *name, ScrError *err) {
  if (!scr_ee_has(em->reg, "error")) {
    scr_ee_emit_error_monitor_va(em, err);
    if (scr_exc_pending()) return false;
    scr_throw_obj(scr_error_retain(err), &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    return false;
  }
  return scr_ee_emit_va(em, name, err);
}

/* ── introspection ────────────────────────────────────────────────────── */

/* The stream unit's registration probe (any unit's, really). */
bool scr_emitter_has(ScrEmitter *em, const char *name) {
  return scr_ee_has(em->reg, name);
}

double scr_emitter_listener_count(ScrEmitter *em, ScrStr *name) {
  ScrEeBucket *b = em->reg ? scr_ee_bucket_of(em->reg, name) : NULL;
  return b ? (double)b->n : 0;
}

/* listenerCount(name, fn): entries matching fn by identity. */
double scr_emitter_listener_count_fn(ScrEmitter *em, ScrStr *name, ScrClosure *fn) {
  ScrEeBucket *b = em->reg ? scr_ee_bucket_of(em->reg, name) : NULL;
  if (!b) return 0;
  size_t count = 0;
  for (size_t i = 0; i < b->n; i++) {
    if (scr_closure_identity_equal(scr_ee_entry_fn(b->ls[i]), fn)) count++;
  }
  return (double)count;
}

/* A checked-dynamic filter must compare the original closure, never a
 * newly built call adapter. Node treats a nullish filter as omitted;
 * other non-functions cannot match a registered listener. All borrowed. */
double scr_emitter_listener_count_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *fn) {
  if (fn->kind == SCR_DYN_NULL || fn->kind == SCR_DYN_UNDEF)
    return scr_emitter_listener_count(em, name);
  return fn->kind == SCR_DYN_FUNC
    ? scr_emitter_listener_count_fn(em, name, fn->v.fn.clo)
    : 0;
}

/* eventNames(): +1 string[] of the bucket names in first-registration
 * order (exactly Node's _events key order). Reserved-but-empty buckets
 * (the stream pre-created keys) are invisible until a listener lands. */
ScrArr *scr_emitter_event_names(ScrEmitter *em) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
  if (em->reg) {
    for (ScrEeBucket *b = em->reg->head; b; b = b->next) {
      if (b->n == 0) continue;
      /* Node lists the errorMonitor symbol, which a string[] cannot hold. */
      if (scr_ee_is_error_monitor(b->name)) {
        scr_arr_release(out);
        scr_ee_symbol_name_fence("eventNames()");
        return scr_arr_new(SCR_ELEM_STR, 0);
      }
      scr_arr_push_ref(out, scr_str_retain(b->name));
    }
  }
  return out;
}

/* listeners(name) / rawListeners(name): +1 closure array in list order.
 * The once wrapper is runtime-internal here, so BOTH forms answer the
 * original listeners (SEMANTICS.md documents the rawListeners
 * divergence). */
static ScrArrOps scr_ee_closure_arr_ops = { &scr_closure_retain_v, &scr_closure_release_v,
                                                  &scr_closure_trace_v };

ScrArr *scr_emitter_listeners(ScrEmitter *em, ScrStr *name) {
  ScrArr *out = scr_arr_new_ops(&scr_ee_closure_arr_ops, 0);
  ScrEeBucket *b = em->reg ? scr_ee_bucket_of(em->reg, name) : NULL;
  if (b) {
    for (size_t i = 0; i < b->n; i++) {
      scr_arr_push_ref(out, scr_closure_retain(scr_ee_entry_fn(b->ls[i])));
    }
  }
  return out;
}

/* listeners(name) / rawListeners(name) through an untyped value: a +1
 * checked-dynamic array of the listener functions in list order. A
 * listener registered with typed parameters has no checked-dynamic
 * function value, so such a bucket reports that it is not supported. */
ScrDyn *scr_emitter_listeners_dyn(ScrEmitter *em, ScrStr *name) {
  ScrDyn *out = scr_dyn_new_arr();
  ScrEeBucket *b = em->reg ? scr_ee_bucket_of(em->reg, name) : NULL;
  for (size_t i = 0; b && i < b->n; i++) {
    ScrDyn *fn = scr_ee_entry_dyn(b->ls[i]);
    if (!fn) {
      scr_dyn_release(out);
      const char *message = "listeners() through an untyped value of an event with a typed listener is not supported yet";
      scr_throw_error(SCR_ERR_ERROR, scr_str_new(message, strlen(message)));
      return scr_dyn_new_arr();
    }
    scr_dyn_arr_push(out, fn);
  }
  return out;
}

/* ── max listeners ────────────────────────────────────────────────────── */

/* The checked-dynamic setMaxListeners ladder: non-numbers throw Node's
 * ERR_INVALID_ARG_TYPE ("The \"setMaxListeners\" argument must be of
 * type number. Received ..."), numbers run the range gate below.
 * Borrowed dyn; +1 receiver either way (the pending check unwinds). */
ScrEmitter *scr_emitter_set_max_chk(ScrEmitter *em, const ScrDyn *n) {
  if (n->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("setMaxListeners", "of type number", n);
    return scr_emitter_retain(em);
  }
  return scr_emitter_set_max(em, n->v.num);
}

ScrEmitter *scr_emitter_set_max(ScrEmitter *em, double n) {
  if (!(n >= 0)) { /* negatives and NaN — Node's validateNumber */
    char num[32];
    size_t nlen = scr_f64_to_str(n, num);
    char msg[128];
    int len = snprintf(msg, sizeof msg,
                       "The value of \"setMaxListeners\" is out of range. It must be >= 0. Received %.*s",
                       (int)nlen, num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return scr_emitter_retain(em); /* the pending check unwinds */
  }
  scr_ee_reg_ensure(em)->max = n;
  return scr_emitter_retain(em);
}

double scr_emitter_get_max(ScrEmitter *em) {
  if (em->reg && em->reg->max >= 0) return em->reg->max;
  return scr_emitter_default_max;
}

/* The checked-dynamic defaultMaxListeners ladder — `name` picks the
 * message's slot ("setMaxListeners" for the static call,
 * "defaultMaxListeners" for the module-property assignment, Node's own
 * split). Borrowed. */
void scr_emitter_set_default_max_chk(const ScrDyn *n, const ScrStr *name) {
  if (n->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name->data, "of type number", n);
    return;
  }
  if (!(n->v.num >= 0)) {
    char num[32];
    size_t nlen = scr_f64_to_str(n->v.num, num);
    char msg[128];
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be >= 0. Received %.*s",
                       name->data, (int)nlen, num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  scr_emitter_set_default_max(n->v.num);
}

void scr_emitter_set_default_max(double n) {
  if (!(n >= 0)) { /* negatives and NaN — Node's validateNumber(n, "setMaxListeners", 0) */
    char num[32];
    size_t nlen = scr_f64_to_str(n, num);
    char msg[128];
    int len = snprintf(msg, sizeof msg,
                       "The value of \"setMaxListeners\" is out of range. It must be >= 0. Received %.*s",
                       (int)nlen, num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return; /* the pending check unwinds */
  }
  scr_emitter_default_max = n;
}
double scr_emitter_get_default_max(void) { return scr_emitter_default_max; }

/* The events module's ES module namespace holds a copy of
 * defaultMaxListeners, taken when the program starts; ESM namespace
 * and named-import reads answer it. module.syncBuiltinESMExports() copies
 * the current value into it. */
static SCR_TL double scr_emitter_esm_default_max = 10;
double scr_emitter_esm_default_max_get(void) { return scr_emitter_esm_default_max; }
void scr_emitter_esm_sync(void) { scr_emitter_esm_default_max = scr_emitter_default_max; }

/* events.once with a signal (scr_events_once_signal.c) undoes an add whose
 * 'newListener' announcement threw. */
void scr_emitter_unadd_quiet(ScrEmitter *em, ScrStr *name, ScrClosure *cb) {
  scr_ee_unadd(em, name, cb);
}
