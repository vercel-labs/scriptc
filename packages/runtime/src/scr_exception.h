/* scriptc runtime — exceptions and catch bindings (scr_exception.c). Included
 * by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_EXCEPTION_H
#define SCR_EXCEPTION_H

#include "scr_stream.h"

/* ── exceptions ─────────────────────────────────────────────────────
 * One in-flight exception cell per execution context — the main stack plus
 * one per fiber (scr_async.c swaps the active cell on fiber switches).
 * `throw` stores the thrown value (taking ownership of refcounted payloads)
 * and sets the pending flag; the COMPILER emits a pending check after every call that can throw
 * and unwinds by releasing its frames/scopes and returning a dummy value —
 * no setjmp/longjmp (longjmp would skip the emitted RC releases). A `catch`
 * takes the exception by clearing the cell (the supported catch form is
 * bindingless, so the payload is released, not read); an exception still
 * pending when the entry function returns is uncaught: main prints it to
 * stderr and exits 1 (Node's uncaught exit code).
 *
 * Ref payloads carry their RC entry points as function pointers, exactly
 * like ScrUnion/SCR_BOX_OBJ: the runtime cannot know per-class/per-record
 * struct layouts. A throw while an exception is already pending REPLACES it
 * (the old payload is released) — that is JS's behavior for a throw inside
 * a `finally` running on the exception path.
 *
 * Ownership: scr_throw_str/_ref take ownership (+1 moves into the cell);
 * scr_exc_clear and scr_exc_print_uncaught release the payload, so a
 * pending exception never survives them (the RC audit stays meaningful).
 */

typedef enum {
  SCR_EXC_NONE = 0,
  SCR_EXC_F64,
  SCR_EXC_BOOL,
  SCR_EXC_STR,
  SCR_EXC_REF, /* array/closure/standalone object/record/union: RC via the fn ptrs */
  /* A HIERARCHY-class instance (the payload carries a vtable word after
   * rc): RC exactly like REF, but the dynamic class is inspectable — catch
   * bindings run instanceof against the payload's preorder interval, and
   * the uncaught/unhandled printers render Error instances as
   * "name: message" instead of "[object]". */
  SCR_EXC_OBJ,
  /* The generator-return sentinel (`gen.return(v)` injected at a suspended
   * yield): PENDING like an exception — the emitted pending checks unwind
   * through finally blocks — but it is a RETURN completion, not a throw:
   * catch handlers in generator bodies re-unwind on it (the emitted
   * sentinel prologue), and the generator trampoline consumes it (clears
   * the cell, promotes the parked return value to the completion value).
   * Carries NO payload (the value rides the generator's ret slot), so
   * scr_exc_clear/reset need no arm. Never escapes a generator fiber. */
  SCR_EXC_GENRET,
  /* Refcounted values whose JS typeof is not object (Symbol, BigInt,
   * functions, and checked-dynamic primitives). The payload uses the
   * same ownership as REF. */
  SCR_EXC_PRIMITIVE_REF,
  /* Noncatchable context shutdown. Owns no payload; generated unwinding
   * releases locals while bypassing user catch and finally handlers. */
  SCR_EXC_TERMINATE,
} ScrExcKind;

/* One cell per fiber (JS has one exception in flight per execution
 * context); scr_async.c swaps the active cell on fiber switches. */
typedef struct ScrStackFrame {
  struct ScrStackFrame *previous;
  const char *text;
} ScrStackFrame;

void scr_stack_enter(ScrStackFrame *frame, const char *text);
void scr_stack_leave(ScrStackFrame *frame);
ScrStr *scr_stack_capture(void); /* +1, NULL when no source frames exist */
double scr_stack_limit_get(void);
void scr_stack_limit_set(double limit);

typedef struct ScrExcCell {
  ScrExcKind kind;
  double f64;
  bool b;
  void *payload;
  void *(*retain_fn)(void *);
  void (*release_fn)(void *);
  /* Non-NULL iff the REF payload type carries a cycle header — carried
   * along so a rejection moving the payload into a promise keeps the
   * promise's payload edge traceable. */
  ScrTraceFn trace_fn;
  ScrStackFrame *stack; /* execution state; never moves with an exception */
} ScrExcCell;

/* Runtime-internal (fiber machinery in scr_async.c) — never emitted. */
ScrExcCell *scr_exc_swap_cell(ScrExcCell *cell); /* NULL = main's cell */
/* The active cell, read inline by generated exception polls (thread-local
 * builds use NULL for the main cell until scr_init installs it). */
extern SCR_TL ScrExcCell *scr_exc_active;
ScrExcCell *scr_exc_current_cell(void);          /* the ACTIVE cell */
/* Runtime code that moved a payload into or out of the active cell (or a
 * cell that may be active) without the throw/take/clear entry points. */
void scr_exc_cell_changed(void);

bool scr_exc_pending(void);

#if !((defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)) || defined(SCR_WORKERS))
/* Runtime units test the active cell's kind inline, as emitted exception
 * polls do (scr_exc_active is never NULL outside thread-instanced libraries
 * and worker executables, which also poll cross-thread termination in
 * scr_exc_pending). The out-of-line definition in scr_exception.c stays
 * for those lanes and for emitted code's slow paths. */
static inline bool scr_exc_pending_inline(void) { return scr_exc_active->kind != SCR_EXC_NONE; }
#define scr_exc_pending() scr_exc_pending_inline()
/* These lanes keep no alert or flag state beside the active cell
 * (scr_exc_cell_changed is empty), so a fiber switch's cell swap is two
 * plain pointer moves that runtime units can inline into each hop. */
extern ScrExcCell *const scr_exc_main_cell;
static inline ScrExcCell *scr_exc_swap_cell_inline(ScrExcCell *cell) {
  ScrExcCell *prev = scr_exc_active;
  scr_exc_active = cell ? cell : scr_exc_main_cell;
  return prev;
}
#define scr_exc_swap_cell(cell) scr_exc_swap_cell_inline(cell)
#endif
_Static_assert(offsetof(ScrExcCell, kind) == 0 && sizeof(ScrExcKind) == 4 && SCR_EXC_NONE == 0,
               "the LLVM emitter's inline pending check loads an i32 kind at offset 0");

SCR_COLD void scr_throw_f64(double v);
SCR_COLD void scr_throw_bool(bool v);
SCR_COLD void scr_throw_str(ScrStr *v); /* takes ownership */
/* Takes ownership of v; retain/release must be non-NULL (the compiler
 * passes the payload type's `_v` adapters, like scr_union_new_ref); trace
 * is non-NULL iff the payload type carries a cycle header. */
SCR_COLD void scr_throw_ref(void *v, void *(*retain)(void *), void (*release)(void *),
                            ScrTraceFn trace);
/* Store a reference whose JS typeof was checked at the throw site. */
SCR_COLD void scr_throw_ref_classified(void *v, void *(*retain)(void *), void (*release)(void *),
                                       ScrTraceFn trace, bool object);
SCR_COLD void scr_throw_primitive_ref(void *v, void *(*retain)(void *), void (*release)(void *),
                                      ScrTraceFn trace);
/* Same ownership contract as scr_throw_ref; the payload must be a
 * hierarchy-class instance (vtable word present) — see SCR_EXC_OBJ. */
SCR_COLD void scr_throw_obj(void *v, void *(*retain)(void *), void (*release)(void *),
                            ScrTraceFn trace);

/* Catch: discard the in-flight exception (releases a refcounted payload). */
void scr_exc_clear(void);

/* ── catch bindings ───────────────────────────────────────────────────
 * `catch (e)` binds the in-flight exception as a refcounted SNAPSHOT box:
 * entering the catch MOVES the cell's payload into a fresh ScrCaught (the
 * pending flag clears), the binding releases with its scope like any
 * refcounted local, and every runtime question a catch body may ask —
 * typeof-style kind tests (emitted as direct kind reads), instanceof over
 * hierarchy payloads, payload extraction, rethrow — reads the box. The box
 * participates in cycle collection because a closure may capture the
 * binding and its payload may retain that closure. */
typedef struct ScrCaught {
  size_t rc;
  ScrExcKind kind; /* never SCR_EXC_NONE */
  double f64;
  bool b;
  void *payload;
  void *(*retain_fn)(void *);
  void (*release_fn)(void *);
  ScrTraceFn trace_fn;
} ScrCaught;

ScrCaught *scr_exc_take(void); /* moves the pending cell into a fresh box (+1) */
ScrCaught *scr_caught_retain(ScrCaught *c);
void scr_caught_release(ScrCaught *c); /* NULL-tolerant */
void scr_caught_trace_v(void *c, ScrTraceVisit visit, void *ctx);
/* Replace the pending disposal error with a SuppressedError and consume the
 * original body-error snapshot. The current exception cell must be pending.
 * The SuppressedError keeps both snapshots in a side table until its
 * teardown: scr_exc_suppressed_values answers them (borrowed) for the
 * error's `error` (the disposal error) and `suppressed` (the body error)
 * when scr_json.c builds its dyn view, and scr_exc_suppressed_forget
 * releases them. */
void scr_exc_suppress(ScrCaught *suppressed);
bool scr_exc_suppressed_values(const void *error_object, const ScrCaught **error,
                               const ScrCaught **suppressed);
void scr_exc_suppressed_forget(const void *error_object);
/* Borrows the box; re-raises the saved exception exactly (payload RETAINED
 * — the binding stays live until its scope exits). */
void scr_rethrow(const ScrCaught *c);
/* `e instanceof C` on a catch binding: an OBJ payload whose vtable preorder
 * lies inside C's interval. False for every other payload kind. */
bool scr_caught_instanceof(const ScrCaught *c, size_t pre, size_t post);
/* `typeof e === "object"` on a catch binding. Throw sites choose REF or
 * PRIMITIVE_REF from the value's JS typeof before storing the payload. */
bool scr_caught_is_object(const ScrCaught *c);
/* `String(e)` / `${e}` on a catch binding: JS's String() over the snapshot
 * — numbers/booleans/strings by value, Error payloads via
 * scr_error_to_string ("name: message" — String(e) carries no stack in
 * Node either), every other ref payload "[object Object]" (exact for
 * records and toString-less class instances; a documented approximation
 * for thrown arrays/closures/union boxes). Borrows the box; returns +1. */
ScrStr *scr_caught_to_string(const ScrCaught *c);
/* `e as C` on a catch binding (scr_lib.c): an OBJ payload inside C's
 * preorder interval extracts (retained, +1); every other payload THROWS a
 * catchable TypeError naming `cls`. Callers are compiler-emitted pending
 * checks. */
void *scr_caught_check_obj(const ScrCaught *c, size_t pre, size_t post,
                            const char *cls);
/* The snapshot as a dyn value (scr_json.c): identity-preserving for dyn
 * payloads and %Error instances, scalars by value, the type-erased empty
 * object for the rest (SEMANTICS.md 67). Borrows the box; +1. */
typedef struct ScrDyn ScrDyn; /* full definition below (C11 repeat) */
ScrDyn *scr_caught_to_dyn(const ScrCaught *c);

/* Uncaught path (called by main before exiting 1): flushes stdout, prints
 * "Uncaught <value>" to stderr (strings raw, numbers JS-exact, booleans
 * true/false, ref payloads as "[object]"), and releases the payload. */
void scr_exc_print_uncaught(void);
/* Optional native process exception registry. Hook returns 1 when handled,
 * 0 when unhandled, and -1 when a handler itself threw (Node exit 7). */
extern SCR_TL int (*scr_uncaught_exception_hook)(bool from_promise);
bool scr_exc_handle_uncaught(bool from_promise);
void scr_process_on_uncaught_exception(ScrDyn *fn, bool once, bool monitor);
void scr_process_off_uncaught_exception(ScrDyn *fn, bool monitor);
/* The value Node reports for an unhandled rejection (scr_async_dyn.c): an
 * error-like reason itself, otherwise an UnhandledPromiseRejection Error
 * (code ERR_UNHANDLED_REJECTION) quoting the reason. Borrows; +1, NULL
 * after a throw. */
ScrDyn *scr_unhandled_rejection_error(ScrDyn *reason);

#endif /* SCR_EXCEPTION_H */
