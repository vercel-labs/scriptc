/* scriptc runtime — node:events EventEmitter (scr_events_emitter.c). Included
 * by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_EVENTS_EMITTER_H
#define SCR_EVENTS_EMITTER_H

#include "scr_closure.h"

/* ── node:events EventEmitter (scr_events_emitter.c, link-gated) ──────
 * The runtime-provided emitter base class — the ScrError precedent:
 * ScrEmitter lays out exactly like a compiler-emitted hierarchy class
 * (rc, vt, then the prefix fields), so `class My extends EventEmitter`
 * compiles as an ordinary derived class whose struct embeds this prefix
 * (`ScrEeReg *` then `const char *`, stamped by the emitted allocation),
 * and every vtable mechanism applies unchanged. The vtable of BARE
 * emitters lives here as a mutable global; the emitted main() stamps its
 * preorder interval (the scr_error_vts story). The emitter hierarchy is
 * UNCONDITIONALLY cycle-capable — the registry owns listener closures —
 * so bare instances always allocate collector-headered and emitted
 * subclasses are always in the traced set.
 *
 * Dispatch: listeners are invoked through compiler-emitted va_list
 * adapters; scr_emitter_emit's variadic tail carries the event's typed
 * argument tuple (frontend-unified per event name), every argument
 * BORROWED — each adapter retains the +1 its callee owns. emit and
 * emit_error may leave an exception pending (a listener threw; an
 * unhandled 'error' throws its payload). */
typedef struct ScrEeReg ScrEeReg; /* the listener registry (lazy) */
typedef void (*ScrEeInvoke)(ScrClosure *cb, va_list ap);

typedef struct ScrEmitter {
  size_t rc;
  const ScrVt *vt;
  ScrEeReg *reg;   /* NULL until the first listener/setMaxListeners */
  const char *cls; /* display name for the leak warning ("EventEmitter") */
} ScrEmitter;

extern SCR_TL ScrVt scr_emitter_vt; /* main() stamps pre/post */
extern SCR_TL double scr_emitter_default_max;

ScrEmitter *scr_emitter_new(void); /* +1, collector-headered */
ScrStr *scr_emitter_class_name(const ScrEmitter *em); /* +1 */
/* Internal owner hook; observes listener presence without running script. */
void scr_emitter_observe(ScrEmitter *em,
                        void (*observe)(void *, const ScrStr *, bool), void *context);
void scr_emitter_init(void *obj);  /* super() into the prefix (no-op today) */
ScrEmitter *scr_emitter_retain(ScrEmitter *em);
void scr_emitter_release(ScrEmitter *em); /* dispatches through em->vt */
void *scr_emitter_retain_v(void *em);
void scr_emitter_release_v(void *em);
void scr_emitter_trace(void *obj, ScrTraceVisit visit, void *ctx);

/* The emitted-subclass prefix helpers (the compiler's direct release /
 * trace / collector teardown call these for the embedded registry). */
void scr_emitter_reg_drop(ScrEeReg *reg);
void scr_emitter_reg_trace(ScrEeReg *reg, ScrTraceVisit visit, void *ctx);
void scr_emitter_reg_gcfree(ScrEeReg *reg);

/* on/once/prependListener/prependOnceListener: cb MOVES, name borrowed;
 * returns em +1 (the `return this` chaining value). 'newListener' fires
 * BEFORE the add; the leak warning prints at the crossing add. */
/* events.once(emitter, name) over typed listeners (scr_events_emitter.c). */
typedef struct ScrPromise ScrPromise;
ScrPromise *scr_events_once(ScrEmitter *em, ScrStr *name, ScrClosure *boxer, void *adapter,
                            ScrEeInvoke inv, ScrClosure *err_boxer, void *err_adapter,
                            ScrEeInvoke err_inv);
void scr_events_once_fire(ScrClosure *cb, ScrArr *args);
/* events.once(emitter, name, { signal }) (scr_events_once_signal.c): the
 * scr_events_once arguments plus the checked-dynamic signal (borrowed;
 * undefined for the plain form). Never throws: a non-AbortSignal value,
 * an aborted signal or a throwing 'newListener' listener rejects the +1
 * result. Its adapters end in scr_events_once_signal_fire. */
typedef struct ScrDyn ScrDyn; /* full definition below (C11 repeat) */
ScrPromise *scr_events_once_signal(ScrEmitter *em, ScrStr *name, ScrClosure *boxer, void *adapter,
                                   ScrEeInvoke inv, ScrClosure *err_boxer, void *err_adapter,
                                   ScrEeInvoke err_inv, ScrDyn *signal);
void scr_events_once_signal_fire(ScrClosure *cb, ScrArr *args);
/* Removes the listener entry whose closure is `cb` (borrowed) without a
 * 'removeListener' event: the undo of an add whose 'newListener'
 * announcement threw. */
void scr_emitter_unadd_quiet(ScrEmitter *em, ScrStr *name, ScrClosure *cb);
ScrEmitter *scr_emitter_on(ScrEmitter *em, ScrStr *name, ScrClosure *cb /*moves*/,
                            ScrEeInvoke inv, bool once, bool prepend);
/* The dyn-adapted registration family (JS-lane checked-dynamic
 * listeners). check_listener throws Node's ERR_INVALID_ARG_TYPE TypeError
 * (catchable, pending on return) when cb is not a function value; the
 * emitted registration helper calls it FIRST, so on_dyn/off_dyn take the
 * SCR_DYN_FUNC kind as given. on_dyn registers the compiler-built adapter
 * (what emit invokes — it boxes the tuple to dyn and calls the original
 * through the checked-dynamic machinery) and keeps the original (the dyn
 * box's underlying closure) as the entry's IDENTITY: off/removeListener
 * match it, listenerCount(name, fn) counts it, listeners() answers it.
 * cb is borrowed, adapter MOVES; both return em +1 (chaining). */
typedef struct ScrDyn ScrDyn; /* full definition below (C11 repeat) */
void scr_emitter_check_listener(const ScrDyn *cb);
ScrEmitter *scr_emitter_on_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *cb,
                                ScrClosure *adapter /*moves*/,
                                ScrEeInvoke inv, bool once, bool prepend);
/* Listeners registered as checked-dynamic functions retain the original
 * closure and its checked-dynamic call thunk, preserving the number of
 * arguments passed to an untyped emit. on_dyn entries also carry the typed
 * adapter for the event's fixed tuple; on_flex entries are for names the
 * program emits only through untyped values or computed names. */
ScrEmitter *scr_emitter_on_flex(ScrEmitter *em, ScrStr *name, const ScrDyn *cb,
                                bool once, bool prepend);
/* Registration and emit through an untyped value (the class dispatch of
 * compiled emitters): on_any adds runtime typed adapters under 'error' and
 * the meta events and installs the dynamic half; emit_any keeps Node's
 * unhandled-'error' contract and gives typed meta listeners a string. */
ScrEmitter *scr_emitter_on_any(ScrEmitter *em, ScrStr *name, const ScrDyn *cb,
                               bool once, bool prepend);
bool scr_emitter_emit_any(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc);
ScrEmitter *scr_emitter_off_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *cb);
/* The registry's checked-dynamic half (meta-event argument vectors and
 * rebuilt listener values), installed by the first on_any call; NULL in
 * programs that never register a listener through an untyped value.
 * Internal. */
typedef struct ScrEeDynOps ScrEeDynOps;
extern SCR_TL const ScrEeDynOps *scr_ee_dyn;
/* The adapter-mediated registration (the LLVM backend's listeners): the
 * ADAPTER closure is what emit invokes, the ORIGINAL closure is the
 * entry's identity (the on_dyn split, with a plain-closure identity).
 * Both MOVE in; returns em +1 (chaining). */
ScrEmitter *scr_emitter_on_via(ScrEmitter *em, ScrStr *name, ScrClosure *orig /*moves*/,
                                ScrClosure *adapter /*moves*/,
                                ScrEeInvoke inv, bool once, bool prepend);
/* Fixed-arity invoke shims for backends that cannot read a va_list
 * (LLVM textual IR is not va_arg-portable): shim k reads k POINTER-SIZE
 * slots off the emit tuple and calls cb->fn behind the fixed signature
 * `void (ScrClosure *, void * ×k)` — the fixed-signature adapter the
 * backend provides. Such backends pass every user tuple argument
 * pointer-classed at the emit site: scalar values point at call-lived
 * typed stack slots and reference values ride directly. The runtime's own
 * emits (data/error/pipe/meta) carry pointers only, so the shims read every
 * tuple either lane produces on 32- and 64-bit targets.
 * The fixed shims cover the common short tuples. Longer adapters use the
 * opaque cursor interface below without depending on the va_list ABI. */
#define SCR_EE_FIXED_MAX 4
void scr_ee_inv_fixed0(ScrClosure *cb, va_list ap);
void scr_ee_inv_fixed1(ScrClosure *cb, va_list ap);
void scr_ee_inv_fixed2(ScrClosure *cb, va_list ap);
void scr_ee_inv_fixed3(ScrClosure *cb, va_list ap);
void scr_ee_inv_fixed4(ScrClosure *cb, va_list ap);
/* Invoke cb->fn(cb, cursor). The cursor borrows a private va_list copy for
 * this call; each next operation reads one borrowed pointer argument. */
void scr_ee_inv_args(ScrClosure *cb, va_list ap);
void *scr_ee_arg_next(void *cursor);
/* removeListener/off (LAST matching occurrence, Node's search order) and
 * removeAllListeners; both return em +1. 'removeListener' fires after
 * each removal when listened for. */
ScrEmitter *scr_emitter_off(ScrEmitter *em, ScrStr *name, ScrClosure *cb /*borrowed*/);
ScrEmitter *scr_emitter_remove_all(ScrEmitter *em, ScrStr *name, bool all);
/* emit: snapshot dispatch in listener order (once entries leave before
 * running); returns whether the event had listeners. The _error form is
 * emit('error', err): no listener ⇒ THROWS err (borrowed; +1 taken). */
bool scr_emitter_emit(ScrEmitter *em, ScrStr *name, ...);
bool scr_emitter_emit_flex(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc);
/* An untyped emit of one message: a listener registered from a function
 * box with a typed message entry (scr_dyn_func_set_message) reads the
 * message itself while no listener has needed the decoded value; from the
 * first listener without an entry on, every listener gets decode(message),
 * made once. */
struct ScrMessage;
bool scr_emitter_emit_message(ScrEmitter *em, ScrStr *name, const struct ScrMessage *message,
                              ScrDyn *(*decode)(const struct ScrMessage *));
/* An untyped emit of an event with a fixed tuple: the arguments as given
 * for dynamic listeners, plus the tuple converted by the caller as
 * scr_emitter_emit's variadics for typed listeners. has_typed answers
 * whether any listener of the name needs the converted tuple. */
bool scr_emitter_emit_mixed(ScrEmitter *em, ScrStr *name, ScrDyn *const *args, size_t argc, ...);
bool scr_emitter_has_typed(ScrEmitter *em, ScrStr *name);
bool scr_emitter_emit_error_flex(ScrEmitter *em, ScrDyn *error);
bool scr_emitter_emit_error(ScrEmitter *em, ScrStr *name, ScrError *err);
double scr_emitter_listener_count(ScrEmitter *em, ScrStr *name);
double scr_emitter_listener_count_fn(ScrEmitter *em, ScrStr *name, ScrClosure *fn);
double scr_emitter_listener_count_dyn(ScrEmitter *em, ScrStr *name, const ScrDyn *fn);
ScrArr *scr_emitter_event_names(ScrEmitter *em);          /* +1 string[] */
/* events.errorMonitor's event key (immortal). Every name parameter above
 * accepts it; the registry matches it by identity, so no string name,
 * whatever its bytes, reaches the errorMonitor listeners. */
ScrStr *scr_emitter_error_monitor(void);
/* Pre-create a name's eventNames() rank with no listener (Node's stream
 * classes pre-create their known _events keys; empty = absent for every
 * other read). The stream constructors call this. */
void scr_emitter_reserve(ScrEmitter *em, const char *name);
ScrArr *scr_emitter_listeners(ScrEmitter *em, ScrStr *name); /* +1 closures */
ScrDyn *scr_emitter_listeners_dyn(ScrEmitter *em, ScrStr *name); /* +1 dyn array */
ScrEmitter *scr_emitter_set_max(ScrEmitter *em, double n);   /* returns em +1 */
double scr_emitter_get_max(ScrEmitter *em);
void scr_emitter_set_default_max(double n);
double scr_emitter_get_default_max(void);
double scr_emitter_esm_default_max_get(void);
void scr_emitter_esm_sync(void);
/* True when the emitter has at least one listener for `name` — the
 * stream unit's registration probe (and anyone else's). */
bool scr_emitter_has(ScrEmitter *em, const char *name);
/* Post-registration hook (one registrant: scr_stream_install) — called at
 * the END of scr_emitter_on with the emitter and the event name, so the
 * stream unit can start flowing on the first 'data' listener. NULL when
 * the stream unit is not linked; emitter behavior is byte-identical. */
extern SCR_TL void (*scr_emitter_on_hook)(ScrEmitter *em, ScrStr *name);

#endif /* SCR_EVENTS_EMITTER_H */
