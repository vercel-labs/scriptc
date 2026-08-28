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
 * Dispatch is C-variadic: the emit call site passes the event tuple as
 * typed C values, and each listener invokes through a compiler-EMITTED
 * adapter `void inv(ScrClosure *cb, va_list ap)` that va_args exactly the
 * listener's own parameter prefix, retains the +1 the callee owns per the
 * universal convention, and calls cb->fn. The frontend's per-event tuple
 * unification is what makes every adapter's reads agree with every emit
 * site's writes. Internal (meta-event) emits reuse the same variadic
 * entry, passing the event NAME as the one argument — meta listeners are
 * fenced to arity <= 1, so no adapter ever reads the listener argument
 * Node would pass second.
 *
 * The special 'error' event routes through scr_emitter_emit_error: with no
 * 'error' listener the Error payload THROWS through the exception cell
 * (catchable; uncaught exits 1), Node's unhandled-'error' contract.
 *
 * The maxListeners leak warning prints Node's message shape on stderr,
 * once per (emitter, event name), plus the once-per-process
 * --trace-warnings hint line. Documented divergences: the pid in
 * "(node:pid)" is this process's (it can never equal the oracle's), and
 * the warning prints synchronously at the add (Node defers it a tick). */
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
};

/* The vtable of BARE `new EventEmitter()` instances; the emitted main()
 * stamps pre/post from the program's preorder numbering (the
 * scr_error_vts precedent). release is the direct teardown below. */
static void scr_emitter_release_direct(void *obj);
SCR_TL ScrVt scr_emitter_vt = {0, 0, &scr_emitter_release_direct};

SCR_TL double scr_emitter_default_max = 10; /* EventEmitter.defaultMaxListeners */

static SCR_TL bool scr_ee_trace_hint_shown = false;

/* Post-registration hook (scr_runtime.h): the stream unit's flow kick.
 * NULL in stream-free builds — behavior byte-identical. */
void (*scr_emitter_on_hook)(ScrEmitter *em, ScrStr *name) = NULL;

/* ── entries and buckets ──────────────────────────────────────────────── */

static void scr_ee_entry_unref(ScrEeEntry *e) {
  if (--e->refs > 0) return;
  scr_closure_release(e->cb);
  scr_closure_release(e->orig); /* NULL-tolerant */
  free(e);
}

/* The entry's IDENTITY closure — what Node would see as the listener. */
static ScrClosure *scr_ee_entry_fn(const ScrEeEntry *e) {
  return e->orig ? e->orig : e->cb;
}

static ScrEeReg *scr_ee_reg_ensure(ScrEmitter *em) {
  if (!em->reg) {
    em->reg = calloc(1, sizeof *em->reg);
    if (!em->reg) scr_ee_oom();
    em->reg->max = -1;
  }
  return em->reg;
}

static ScrEeBucket *scr_ee_bucket_find(ScrEeReg *reg, const char *name, size_t len) {
  if (!reg) return NULL;
  for (ScrEeBucket *b = reg->head; b; b = b->next) {
    if (b->name->len == len && memcmp(b->name->data, name, len) == 0) return b;
  }
  return NULL;
}

static ScrEeBucket *scr_ee_bucket_ensure(ScrEeReg *reg, ScrStr *name) {
  ScrEeBucket *b = scr_ee_bucket_find(reg, name->data, name->len);
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

/* Collector trace: the listener closures are the registry's only
 * cycle-headered children (bucket names are strings — acyclic). */
void scr_emitter_reg_trace(ScrEeReg *reg, ScrTraceVisit visit, void *ctx) {
  if (!reg) return;
  for (ScrEeBucket *b = reg->head; b; b = b->next) {
    for (size_t i = 0; i < b->n; i++) {
      visit(b->ls[i]->cb, ctx);
      if (b->ls[i]->orig) visit(b->ls[i]->orig, ctx);
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
      if (--b->ls[i]->refs == 0) free(b->ls[i]);
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
    scr_cyc_on_dead(em);
    scr_emitter_reg_drop(em->reg);
    scr_obj_free_note();
    scr_cyc_free(em);
  } else {
    scr_cyc_on_release(em); /* possible cycle root; may collect */
  }
}

ScrEmitter *scr_emitter_new(void) {
  /* Always collector-headered: the registry holds closures, so the
   * emitter hierarchy is unconditionally cycle-capable (the canonical
   * capture cycle is `e.on('x', () => e.emit(...))`). */
  ScrEmitter *em = scr_cyc_alloc(sizeof *em, &scr_emitter_trace, &scr_emitter_gcfree);
  em->rc = 1;
  em->vt = &scr_emitter_vt;
  em->reg = NULL;
  em->cls = "EventEmitter";
  scr_obj_alloc_note();
  return em;
}

/* super() into the emitter prefix of an emitted subclass: the allocation
 * already zeroed reg and stamped the concrete class's display name, so
 * construction has nothing left to do — the call exists so the super()
 * statement lowers to a real site (and may grow options later). */
void scr_emitter_init(void *obj) { (void)obj; }

ScrEmitter *scr_emitter_retain(ScrEmitter *em) {
  if (em && em->rc != SIZE_MAX) {
    em->rc++;
    scr_cyc_mark_live(em);
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

/* Fires a meta event with the affected event's NAME as the argument
 * (listeners are fenced to arity <= 1, so the listener-function argument
 * Node passes second is never read). */
static void scr_ee_emit_meta(ScrEmitter *em, const char *meta, ScrStr *name) {
  if (!scr_ee_has(em->reg, meta)) return;
  ScrStr *m = scr_str_new(meta, strlen(meta));
  scr_ee_emit_va(em, m, name);
  scr_str_release(m);
}

/* ── add / remove ─────────────────────────────────────────────────────── */

static void scr_ee_warn_maybe(ScrEmitter *em, ScrEeBucket *b) {
  ScrEeReg *reg = em->reg;
  double max = reg->max >= 0 ? reg->max : scr_emitter_default_max;
  if (b->warned || max <= 0 || (double)b->n <= max) return;
  b->warned = true;
  /* Node's message byte for byte — except the pid, which is OURS (it can
   * never match another process's), and the synchronous timing (Node
   * defers the print by a tick). SEMANTICS.md documents both. */
  fprintf(stderr,
          "(node:%ld) MaxListenersExceededWarning: Possible EventEmitter memory leak "
          "detected. %zu %s listeners added to [%s]. MaxListeners is %g. Use "
          "emitter.setMaxListeners() to increase limit\n",
          SCR_EE_PID(), b->n, b->name->data, em->cls, max);
  if (!scr_ee_trace_hint_shown) {
    scr_ee_trace_hint_shown = true;
    fputs("(Use `node --trace-warnings ...` to show where the warning was created)\n",
          stderr);
  }
}

/* Registers a listener. cb and orig MOVE in; name is borrowed. Returns em
 * +1 (the `return this` chaining value). 'newListener' fires BEFORE the
 * add, like Node. A listener throw inside the meta emit leaves the
 * exception pending; the add still happens (Node's addListener has no
 * try). */
static ScrEmitter *scr_ee_add(ScrEmitter *em, ScrStr *name, ScrClosure *cb /*moves*/,
                              ScrClosure *orig /*moves; may be NULL*/,
                              ScrEeInvoke inv, bool once, bool prepend) {
  scr_ee_reg_ensure(em);
  scr_ee_emit_meta(em, "newListener", name);
  ScrEeBucket *b = scr_ee_bucket_ensure(em->reg, name);
  ScrEeEntry *e = calloc(1, sizeof *e);
  if (!e) scr_ee_oom();
  e->cb = cb;
  e->orig = orig;
  e->inv = inv;
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
  scr_ee_warn_maybe(em, b);
  if (scr_emitter_on_hook != NULL) scr_emitter_on_hook(em, name);
  return scr_emitter_retain(em);
}

ScrEmitter *scr_emitter_on(ScrEmitter *em, ScrStr *name, ScrClosure *cb /*moves*/,
                            ScrEeInvoke inv, bool once, bool prepend) {
  return scr_ee_add(em, name, cb, NULL, inv, once, prepend);
}

/* The dyn-adapted registration (JS-lane checked-dynamic listeners): the
 * ADAPTER closure (compiler-built — boxes the event tuple to dyn and
 * calls the original through the checked-dynamic machinery) is what emit
 * invokes; the ORIGINAL function (the dyn box's underlying closure) is
 * the entry's identity. cb must be a SCR_DYN_FUNC (the emitted
 * scr_emitter_check_listener ran first); adapter MOVES in, cb is
 * borrowed. */
ScrEmitter *scr_emitter_on_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *cb,
                                ScrClosure *adapter /*moves*/,
                                ScrEeInvoke inv, bool once, bool prepend) {
  return scr_ee_add(em, name, adapter, scr_closure_retain(cb->v.fn.clo), inv, once,
                    prepend);
}

/* The adapter-mediated registration (the LLVM backend): adapter is what
 * emit invokes, orig is the entry's identity — the on_dyn split with a
 * plain-closure identity. Both move in. */
ScrEmitter *scr_emitter_on_via(ScrEmitter *em, ScrStr *name, ScrClosure *orig /*moves*/,
                                ScrClosure *adapter /*moves*/,
                                ScrEeInvoke inv, bool once, bool prepend) {
  return scr_ee_add(em, name, adapter, orig, inv, once, prepend);
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

/* Removes one entry (by index) from a bucket's live list and fires the
 * 'removeListener' meta event AFTER the removal, Node's order. Drops the
 * bucket when emptied — except in shape mode, where the emptied name
 * keeps its rank (Node's events[type] = undefined). */
static void scr_ee_remove_at(ScrEmitter *em, ScrEeBucket *b, size_t i) {
  ScrEeEntry *e = b->ls[i];
  memmove(b->ls + i, b->ls + i + 1, (b->n - i - 1) * sizeof *b->ls);
  b->n--;
  ScrStr *name = scr_str_retain(b->name);
  if (b->n == 0 && !em->reg->shape) scr_ee_bucket_drop(em->reg, b);
  scr_ee_entry_unref(e);
  scr_ee_emit_meta(em, "removeListener", name);
  scr_str_release(name);
}

/* removeListener/off: the LAST matching occurrence leaves (Node searches
 * from the end). cb is borrowed. Returns em +1. */
ScrEmitter *scr_emitter_off(ScrEmitter *em, ScrStr *name, ScrClosure *cb) {
  ScrEeBucket *b = em->reg ? scr_ee_bucket_find(em->reg, name->data, name->len) : NULL;
  if (b) {
    for (size_t i = b->n; i-- > 0;) {
      if (scr_ee_entry_fn(b->ls[i]) == cb) {
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
    ScrEeBucket *live = scr_ee_bucket_find(em->reg, name->data, name->len);
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
    ScrEeBucket *b = scr_ee_bucket_find(reg, name->data, name->len);
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

/* One dispatch pass over a SNAPSHOT of the bucket: entries invoke in list
 * order through their emitted adapters, each with a fresh va_start over
 * the emit site's typed tail. A once entry leaves the live list (firing
 * 'removeListener', Node's wrapper calls removeListener) BEFORE its
 * callback runs, and never runs twice even when a nested emit's snapshot
 * still holds it (the shared fired flag — Node's wrapper.fired). A
 * listener throw stops the pass (the exception stays pending for the
 * caller). Returns whether the bucket had listeners. */
static bool scr_ee_emit_core(ScrEmitter *em, ScrStr *name, va_list *ap_template) {
  ScrEeBucket *b = em->reg ? scr_ee_bucket_find(em->reg, name->data, name->len) : NULL;
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
      ScrEeBucket *live = scr_ee_bucket_find(em->reg, name->data, name->len);
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
    va_list ap;
    va_copy(ap, *ap_template);
    e->inv(e->cb, ap);
    va_end(ap);
    scr_ee_entry_unref(e);
  }
  free(snap);
  return true;
}

static bool scr_ee_emit_va(ScrEmitter *em, ScrStr *name, ...) {
  va_list ap;
  va_start(ap, name);
  bool had = scr_ee_emit_core(em, name, &ap);
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
  bool had = scr_ee_emit_core(em, name, &ap);
  va_end(ap);
  return had;
}

/* emit('error', err) — Node's special event: with no 'error' listener the
 * payload THROWS (catchable; uncaught exits 1 with the error report).
 * err is borrowed; the throw takes its own +1. */
bool scr_emitter_emit_error(ScrEmitter *em, ScrStr *name, ScrError *err) {
  if (!scr_ee_has(em->reg, "error")) {
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
  ScrEeBucket *b = em->reg ? scr_ee_bucket_find(em->reg, name->data, name->len) : NULL;
  return b ? (double)b->n : 0;
}

/* listenerCount(name, fn): entries matching fn by identity. */
double scr_emitter_listener_count_fn(ScrEmitter *em, ScrStr *name, ScrClosure *fn) {
  ScrEeBucket *b = em->reg ? scr_ee_bucket_find(em->reg, name->data, name->len) : NULL;
  if (!b) return 0;
  size_t count = 0;
  for (size_t i = 0; i < b->n; i++) {
    if (scr_ee_entry_fn(b->ls[i]) == fn) count++;
  }
  return (double)count;
}

/* eventNames(): +1 string[] of the bucket names in first-registration
 * order (exactly Node's _events key order). Reserved-but-empty buckets
 * (the stream pre-created keys) are invisible until a listener lands. */
ScrArr *scr_emitter_event_names(ScrEmitter *em) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
  if (em->reg) {
    for (ScrEeBucket *b = em->reg->head; b; b = b->next) {
      if (b->n > 0) scr_arr_push_ref(out, scr_str_retain(b->name));
    }
  }
  return out;
}

/* listeners(name) / rawListeners(name): +1 closure array in list order.
 * The once wrapper is runtime-internal here, so BOTH forms answer the
 * original listeners (SEMANTICS.md documents the rawListeners
 * divergence). */
ScrArr *scr_emitter_listeners(ScrEmitter *em, ScrStr *name) {
  ScrArr *out = scr_arr_new_ref(&scr_closure_retain_v, &scr_closure_release_v,
                                 &scr_closure_trace_v, 0);
  ScrEeBucket *b = em->reg ? scr_ee_bucket_find(em->reg, name->data, name->len) : NULL;
  if (b) {
    for (size_t i = 0; i < b->n; i++) {
      scr_arr_push_ref(out, scr_closure_retain(scr_ee_entry_fn(b->ls[i])));
    }
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
