/* The in-flight exception cell (see scr_runtime.h). One cell per execution
 * context — the main stack plus one per fiber (scr_async.c swaps the active
 * cell on fiber switches) — never a stack of cells: JS has exactly one
 * exception in flight per context, and a throw while one is pending (only
 * reachable from a `finally` running on the exception path) REPLACES it,
 * which is JS's semantics too.
 *
 * Unwinding itself is compiler-emitted (pending checks + RC releases +
 * dummy returns); this file only stores, renders, and releases the value.
 */
#include "scr_runtime.h"
#ifdef SCR_NODE_ISLANDS
#include "scr_node_island.h"
#endif

#include <stdatomic.h>
#include <stdio.h>
#include <math.h>
#include <stdlib.h>

#ifndef SCR_LIB
/* The trap funnel's EXECUTABLE expansion: exactly the historical
 * fputs/vfprintf-to-stderr + abort every trap site used to open-code — the
 * default lane's bytes and behavior are unchanged by construction. Library
 * builds (-DSCR_LIB) get the sink-routing definitions from scr_library.c
 * instead; this pair compiles out there. Lives HERE (the failure-channel
 * unit, present in every link including the runtime's own unit-test
 * subsets) rather than in the console unit. */
_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  abort();
}

_Noreturn void scr_trap_fmt(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  abort();
}
#endif /* !SCR_LIB */

static SCR_TL ScrExcCell scr_main_exc; /* fiber zero (the main stack) */
/* The active cell is exported so executables can test its kind inline at
 * every exception poll and call scr_exc_pending only on the slow path; the
 * kind is the cell's first field. */
#if (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)) || defined(SCR_WORKERS)
/* A thread-local pointer cannot be initialized with &scr_main_exc — the
 * address of a thread-local is not a constant expression — so NULL stands
 * for the main cell and every read resolves it. Worker executables also
 * switch this pointer as fibers enter and leave their own exception cells,
 * and scr_init points it at the context's main cell before program code
 * runs, so generated inline polls never read NULL. */
SCR_TL ScrExcCell *scr_exc_active;
#define SCR_EXC_CUR() (scr_exc_active ? scr_exc_active : &scr_main_exc)
#else
ScrExcCell *scr_exc_active = &scr_main_exc;
/* What scr_exc_swap_cell(NULL) selects; the inline swap reads it. */
ScrExcCell *const scr_exc_main_cell = &scr_main_exc;
#define SCR_EXC_CUR() (scr_exc_active)
#endif

/* The running stack's overflow guard (scr_runtime.h). It lives beside the
 * exception cell so fiber switching can maintain it whenever scr_async.c is
 * linked; scr_context.c installs it per thread. The explicit initializer
 * keeps it an ordinary definition rather than a common symbol, which a
 * localized library archive would otherwise leave shared. */
SCR_TL uintptr_t scr_stack_guard = 0;

#if defined(SCR_WORKERS) && !defined(SCR_LIB) && defined(SCR_EXC_FLAG)
/* The thread's exact pending word, tested inline by every emitted pending
 * check in ELF worker executables (one %fs/tpidr-relative load: the word is
 * in the executable's static TLS block). Nonzero means the running code
 * must unwind, so the emitted check needs no out-of-line answer:
 *
 * - SCR_EXC_FLAG_PENDING mirrors `active cell kind != NONE` exactly. Only
 *   the owner thread writes it, at every change of its active cell (throws,
 *   rethrows, take/clear, fiber switches, payload moves, the termination
 *   sentinel), because a stale bit would unwind a normal path.
 * - SCR_EXC_FLAG_STOP means the context must stop. worker.terminate() sets
 *   it from the owner's thread (scr_exc_flag_request_stop, through the
 *   pointer the worker registers while its script runs), scr_context_stop
 *   sets it for process.exit() and fatal paths, and nothing clears it.
 *
 * A set STOP bit unwinds while the active cell may still be NONE: the
 * TERMINATE sentinel is installed by whoever consumes the unwind before it
 * inspects the cell. scr_exc_pending and scr_context_checkpoint do that,
 * emitted try regions test the bit before entering a handler, and the
 * runtime's unwind consumers (fiber completion, the uncaught reporters,
 * exit listeners) checkpoint first. */
SCR_TL _Atomic uint32_t scr_exc_flag;

static inline void scr_exc_flag_pending(bool pending) {
  uint32_t word = atomic_load_explicit(&scr_exc_flag, memory_order_relaxed);
  if (((word & SCR_EXC_FLAG_PENDING) != 0) == pending) return;
  if (pending) atomic_fetch_or_explicit(&scr_exc_flag, SCR_EXC_FLAG_PENDING, memory_order_relaxed);
  else atomic_fetch_and_explicit(&scr_exc_flag, ~SCR_EXC_FLAG_PENDING, memory_order_relaxed);
}

void scr_exc_flag_request_stop(_Atomic uint32_t *flag) {
  /* Release: a thread that observes the bit also observes the requester's
   * earlier writes (the worker's cancel flag). */
  atomic_fetch_or_explicit(flag, SCR_EXC_FLAG_STOP, memory_order_release);
}

/* The active cell, or the context's stop state, may have changed. */
void scr_exc_cell_changed(void) {
  if (!scr_context_quiet() &&
      !(atomic_load_explicit(&scr_exc_flag, memory_order_relaxed) & SCR_EXC_FLAG_STOP))
    atomic_fetch_or_explicit(&scr_exc_flag, SCR_EXC_FLAG_STOP, memory_order_relaxed);
  scr_exc_flag_pending(SCR_EXC_CUR()->kind != SCR_EXC_NONE);
}

void scr_exc_alert_thread_exit(void) {}
#define SCR_EXC_RAISED() scr_exc_flag_pending(true)
#elif defined(SCR_WORKERS) && !defined(SCR_LIB)
/* The process-wide exception alert, tested inline by every emitted pending
 * check in worker executables: one ordinary load, where reading the active
 * cell would be a thread-local access (a call on Darwin). It counts the
 * script threads whose active cell may hold a pending exception or which
 * must stop, plus one reference per outstanding worker.terminate() request
 * (scr_worker.c). Zero proves that no thread has anything pending, so the
 * check falls through; otherwise the out-of-line scr_exc_pending answers for
 * the calling thread. A thread raises its share whenever its active cell may
 * have become pending (throws, rethrows, the termination sentinel, fiber
 * switches and moves into the active cell) and drops it once that cell is
 * clear again (take, clear, the slow path), so an exception in flight in one
 * thread costs the others slow-path calls only until it is caught. Only its
 * owner changes a thread's share, so a thread's own raise is visible to all
 * of its later checks. */
_Alignas(64) _Atomic uint32_t scr_exc_alert = 0;
static SCR_TL bool scr_exc_alerted;

void scr_exc_alert_add(int delta) {
  atomic_fetch_add_explicit(&scr_exc_alert, (uint32_t)delta, memory_order_release);
}

static void scr_exc_alert_raise(void) {
  if (scr_exc_alerted) return;
  scr_exc_alerted = true;
  atomic_fetch_add_explicit(&scr_exc_alert, 1, memory_order_relaxed);
}

static void scr_exc_alert_drop(void) {
  if (!scr_exc_alerted) return;
  scr_exc_alerted = false;
  atomic_fetch_sub_explicit(&scr_exc_alert, 1, memory_order_relaxed);
}

/* The active cell, or the context's stop state, may have changed. */
void scr_exc_cell_changed(void) {
  if (SCR_EXC_CUR()->kind != SCR_EXC_NONE || !scr_context_quiet()) scr_exc_alert_raise();
  else scr_exc_alert_drop();
}

/* A worker thread's script execution has ended for good. */
void scr_exc_alert_thread_exit(void) { scr_exc_alert_drop(); }
#define SCR_EXC_RAISED() scr_exc_alert_raise()
#else
void scr_exc_cell_changed(void) {}
#define SCR_EXC_RAISED() ((void)0)
#endif

/* Fiber switching (scr_async.c) points the exception machinery at the
 * incoming fiber's cell; returns the previous cell. */
ScrExcCell *(scr_exc_swap_cell)(ScrExcCell *cell) {
  ScrExcCell *prev = SCR_EXC_CUR();
  scr_exc_active = cell ? cell : &scr_main_exc;
  scr_exc_cell_changed();
  return prev;
}

/* The ACTIVE cell, for runtime code that moves a pending payload out of it
 * (a new-Promise executor throw rejecting the promise). */
ScrExcCell *scr_exc_current_cell(void) { return SCR_EXC_CUR(); }

void scr_stack_enter(ScrStackFrame *frame, const char *text) {
  frame->previous = SCR_EXC_CUR()->stack;
  frame->text = text;
  SCR_EXC_CUR()->stack = frame;
}

void scr_stack_leave(ScrStackFrame *frame) {
  SCR_EXC_CUR()->stack = frame->previous;
}

static SCR_TL double scr_stack_limit = 10;
static SCR_TL bool scr_stack_limit_reset_registered;
static void scr_stack_limit_reset(void) {
  scr_stack_limit = 10;
  scr_stack_limit_reset_registered = false;
}
double scr_stack_limit_get(void) { return scr_stack_limit; }
void scr_stack_limit_set(double limit) {
  if (!scr_stack_limit_reset_registered) {
    scr_atexit(scr_stack_limit_reset);
    scr_stack_limit_reset_registered = true;
  }
  scr_stack_limit = limit;
}

ScrStr *scr_stack_capture(void) {
  if (!SCR_EXC_CUR()->stack) return NULL;
  const double limit = floor(scr_stack_limit);
  if (!(limit > 0)) return NULL;
  size_t length = 0;
  size_t count = 0;
  for (ScrStackFrame *frame = SCR_EXC_CUR()->stack; frame && (double)count++ < limit; frame = frame->previous)
    length += 1 + strlen(frame->text);
  char *text = malloc(length);
  if (!text) scr_trap("scriptc: out of memory\n");
  size_t offset = 0;
  count = 0;
  for (ScrStackFrame *frame = SCR_EXC_CUR()->stack; frame && (double)count++ < limit; frame = frame->previous) {
    text[offset++] = '\n';
    size_t size = strlen(frame->text);
    memcpy(text + offset, frame->text, size);
    offset += size;
  }
  ScrStr *out = scr_str_new(text, length);
  free(text);
  return out;
}

#define scr_exc_kind (SCR_EXC_CUR()->kind)
#define scr_exc_f64 (SCR_EXC_CUR()->f64)
#define scr_exc_bool (SCR_EXC_CUR()->b)
#define scr_exc_payload (SCR_EXC_CUR()->payload)
#define scr_exc_retain_fn (SCR_EXC_CUR()->retain_fn)
#define scr_exc_release_fn (SCR_EXC_CUR()->release_fn)
#define scr_exc_trace_fn (SCR_EXC_CUR()->trace_fn)

/* Parenthesized: scr_runtime.h maps runtime-internal calls to an inline
 * test with a function-like macro; this keeps the exported symbol. */
bool(scr_exc_pending)(void) {
#ifdef SCR_WORKERS
  if (scr_context_checkpoint()) return true;
#endif
  bool pending = scr_exc_kind != SCR_EXC_NONE;
#if defined(SCR_WORKERS) && !defined(SCR_LIB) && defined(SCR_EXC_FLAG)
  /* The pending bit is exact; settling it here is only a safety net. */
  scr_exc_flag_pending(pending);
#elif defined(SCR_WORKERS) && !defined(SCR_LIB)
  /* The slow path of the alert test: settle this thread's share. */
  if (pending != scr_exc_alerted) scr_exc_cell_changed();
#endif
  return pending;
}

/* Release the current payload (if any) and reset to NONE. Shared by clear,
 * the uncaught printer, and every throw (replace semantics). */
static void scr_exc_reset(void) {
  if (scr_exc_kind == SCR_EXC_STR) {
    scr_str_release((ScrStr *)scr_exc_payload);
  } else if (scr_exc_kind == SCR_EXC_REF || scr_exc_kind == SCR_EXC_OBJ ||
             scr_exc_kind == SCR_EXC_PRIMITIVE_REF) {
    scr_exc_release_fn(scr_exc_payload);
  }
  scr_exc_kind = SCR_EXC_NONE;
  scr_exc_payload = NULL;
  scr_exc_retain_fn = NULL;
  scr_exc_release_fn = NULL;
  scr_exc_trace_fn = NULL;
}

void scr_exc_clear(void) {
  scr_exc_reset();
  scr_exc_cell_changed();
}

/* ── catch bindings (ScrCaught — contract in scr_runtime.h) ──────────── */

void scr_caught_trace_v(void *object, ScrTraceVisit visit, void *ctx) {
  ScrCaught *c = object;
  if (c->payload && c->trace_fn) visit(c->payload, ctx);
}

static void scr_caught_gcfree(void *object) {
  ScrCaught *c = object;
  if (c->kind == SCR_EXC_STR) {
    scr_str_release((ScrStr *)c->payload);
  } else if (c->payload && c->release_fn && !c->trace_fn) {
    c->release_fn(c->payload);
  }
  scr_obj_free_note();
  scr_cyc_free(c);
}

ScrCaught *scr_exc_take(void) {
  static ScrCycType cyc_type = { &scr_caught_trace_v, &scr_caught_gcfree, SCR_CYC_KIND_CAUGHT };
  ScrCaught *c = scr_cyc_alloc(sizeof *c, &cyc_type);
  c->rc = 1;
  c->kind = scr_exc_kind;
  c->f64 = scr_exc_f64;
  c->b = scr_exc_bool;
  c->payload = scr_exc_payload; /* ownership MOVES from the cell */
  c->retain_fn = scr_exc_retain_fn;
  c->release_fn = scr_exc_release_fn;
  c->trace_fn = scr_exc_trace_fn;
  scr_exc_kind = SCR_EXC_NONE; /* clear WITHOUT releasing (moved) */
  scr_exc_payload = NULL;
  scr_exc_retain_fn = NULL;
  scr_exc_release_fn = NULL;
  scr_exc_trace_fn = NULL;
  scr_exc_cell_changed();
  scr_obj_alloc_note();
  return c;
}

ScrCaught *scr_caught_retain(ScrCaught *c) {
  if (c) c->rc++;
  return c;
}

void scr_caught_release(ScrCaught *c) {
  if (!c) return;
  if (--c->rc == 0) {
    scr_cyc_dead(c);
    if (c->kind == SCR_EXC_STR) {
      scr_str_release((ScrStr *)c->payload);
    } else if (c->kind == SCR_EXC_REF || c->kind == SCR_EXC_OBJ ||
               c->kind == SCR_EXC_PRIMITIVE_REF) {
      c->release_fn(c->payload);
    }
    scr_obj_free_note();
    scr_cyc_free(c);
  } else {
    scr_cyc_released(c);
  }
}

void scr_rethrow(const ScrCaught *c) {
  switch (c->kind) {
  case SCR_EXC_F64: scr_throw_f64(c->f64); break;
  case SCR_EXC_BOOL: scr_throw_bool(c->b); break;
  case SCR_EXC_STR: scr_throw_str(scr_str_retain((ScrStr *)c->payload)); break;
  case SCR_EXC_REF:
    scr_throw_ref(c->retain_fn(c->payload), c->retain_fn, c->release_fn, c->trace_fn);
    break;
  case SCR_EXC_PRIMITIVE_REF:
    scr_throw_primitive_ref(c->retain_fn(c->payload), c->retain_fn, c->release_fn, c->trace_fn);
    break;
  case SCR_EXC_OBJ:
    scr_throw_obj(c->retain_fn(c->payload), c->retain_fn, c->release_fn, c->trace_fn);
    break;
  case SCR_EXC_NONE:
    break; /* unreachable: take() never stores NONE */
  case SCR_EXC_TERMINATE:
  case SCR_EXC_GENRET:
    /* The generator-return sentinel, stashed across an exception-path
     * finally (emitTryCatch): re-raising restores the bare kind — no
     * payload exists. */
    scr_exc_reset();
    scr_exc_kind = c->kind;
    SCR_EXC_RAISED();
    break;
  }
}

/* Explicit resource management's error merge: a SuppressedError whose
 * `error` is the disposal error and whose `suppressed` is the body error.
 * The snapshots wait in this table for the error's dyn view, so programs
 * that never read them link no checked-dynamic code. */
typedef struct ScrSuppressedEntry {
  const void *error_object;
  ScrCaught *error;
  ScrCaught *suppressed;
} ScrSuppressedEntry;
static SCR_TL ScrSuppressedEntry *scr_suppressed_entries = NULL;
static SCR_TL size_t scr_suppressed_len = 0;
static SCR_TL size_t scr_suppressed_cap = 0;

bool scr_exc_suppressed_values(const void *error_object, const ScrCaught **error,
                               const ScrCaught **suppressed) {
  for (size_t i = 0; i < scr_suppressed_len; i++) {
    if (scr_suppressed_entries[i].error_object != error_object) continue;
    *error = scr_suppressed_entries[i].error;
    *suppressed = scr_suppressed_entries[i].suppressed;
    return true;
  }
  return false;
}

void scr_exc_suppressed_forget(const void *error_object) {
  for (size_t i = 0; i < scr_suppressed_len; i++) {
    if (scr_suppressed_entries[i].error_object != error_object) continue;
    ScrSuppressedEntry entry = scr_suppressed_entries[i];
    scr_suppressed_entries[i] = scr_suppressed_entries[--scr_suppressed_len];
    scr_caught_release(entry.error);
    scr_caught_release(entry.suppressed);
    return;
  }
}

void scr_exc_keep_first(ScrCaught *first) {
  if (first->kind == SCR_EXC_GENRET) {
    scr_caught_release(first);
    return;
  }
  ScrCaught *dropped = scr_exc_take();
  if (dropped) scr_caught_release(dropped);
  scr_rethrow(first);
  scr_caught_release(first);
}

void scr_exc_suppress(ScrCaught *suppressed) {
  if (suppressed->kind == SCR_EXC_GENRET) {
    /* A generator .return() is a return completion, not a thrown error.
     * A failing disposer replaces it directly. */
    scr_caught_release(suppressed);
    return;
  }
  ScrCaught *error = scr_exc_take();
  if (!error) {
    scr_rethrow(suppressed);
    scr_caught_release(suppressed);
    return;
  }
  static const char text[] = "An error was suppressed during disposal";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrError *e = scr_error_new(SCR_ERR_SUPPRESSED, message);
  scr_str_release(message);
  if (scr_suppressed_len == scr_suppressed_cap) {
    size_t cap = scr_suppressed_cap ? scr_suppressed_cap * 2 : 4;
    ScrSuppressedEntry *entries = realloc(scr_suppressed_entries, cap * sizeof *entries);
    if (!entries) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
    scr_suppressed_entries = entries;
    scr_suppressed_cap = cap;
  }
  scr_suppressed_entries[scr_suppressed_len++] = (ScrSuppressedEntry){e, error, suppressed};
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

bool scr_caught_instanceof(const ScrCaught *c, size_t pre, size_t post) {
  if (c->kind != SCR_EXC_OBJ) return false;
  /* Every hierarchy class shares the rc+vt prefix; ScrError names it. */
  const ScrVt *vt = ((const ScrError *)c->payload)->vt;
  return pre <= vt->pre && vt->pre <= post;
}

bool scr_caught_is_object(const ScrCaught *c) {
  return c->kind == SCR_EXC_OBJ || c->kind == SCR_EXC_REF;
}

ScrStr *scr_caught_to_string(const ScrCaught *c) {
  switch (c->kind) {
  case SCR_EXC_F64: return scr_f64_to_scrstr(c->f64);
  case SCR_EXC_BOOL: return scr_bool_to_scrstr(c->b);
  case SCR_EXC_STR: return scr_str_retain((ScrStr *)c->payload);
  case SCR_EXC_OBJ:
    /* Error instances stringify by Error.prototype.toString — "name",
     * "name: message", or "Error" for the empty halves. This IS Node's
     * String(e): the stack is a property Node's console printing adds,
     * never part of toString. Non-Error hierarchy objects fall through. */
    if (scr_error_is(c->payload)) {
      return scr_error_to_string((ScrError *)c->payload);
    }
    /* fall through */
  case SCR_EXC_REF:
  case SCR_EXC_PRIMITIVE_REF:
    if (c->retain_fn == scr_dyn_retain_v) return scr_dyn_string_constructor(c->payload);
    /* Object.prototype.toString — exact for thrown class instances
     * without a toString override; thrown closures and union boxes print
     * this too where Node would vary. Thrown records and arrays arrive as
     * checked-dynamic values (above). */
    return scr_str_new("[object Object]", 15);
  case SCR_EXC_NONE:
  case SCR_EXC_TERMINATE:
  case SCR_EXC_GENRET: /* unreachable: take() never stores NONE/the sentinel */
    break;
  }
  return scr_str_new("", 0);
}

#ifdef SCR_LIB
/* An exception that escaped user code into a generated entry wrapper: the
 * host contract is that declared entries do not throw, so an escape is a
 * contract-shaped failure exactly like a trap. Render the same "Uncaught
 * ..." first line the executable epilogue prints (scr_exc_print_uncaught's
 * arms, buffer-writing), release the payload, and route the text through
 * the trap funnel — one failure channel at the boundary. The funnel
 * (scr_library.c) assembles the rendered line into the structured
 * trap-teaching form (code SC4013, the trapping entry's symbol) before
 * delivery; only the 0x01-led verbatim path below bypasses assembly. */
void scr_library_check_exc(void) {
  if (!scr_exc_pending()) return;
  static SCR_TL char buf[1024]; /* the message is copied out before the payload dies */
  /* The ratified verbatim rule: a thrown message that ALREADY begins with
   * the structured trap-teaching marker (0x01) is delivered exactly as
   * authored — no "Uncaught " prefix, no added newline — which is how a
   * facade-authored structured teaching rides the throw channel through to
   * the sink. Both throw idioms qualify: a thrown string, and an Error
   * whose .message starts with the marker. Everything else keeps the
   * baseline "Uncaught ..." shape below, whose first byte is printable —
   * the guarantee the marker's unambiguity rests on. */
  const ScrStr *marked = NULL;
  if (scr_exc_kind == SCR_EXC_STR) {
    marked = (const ScrStr *)scr_exc_payload;
  } else if (scr_exc_kind == SCR_EXC_OBJ && scr_error_is(scr_exc_payload)) {
    marked = ((const ScrError *)scr_exc_payload)->message;
  }
  if (marked != NULL && marked->len > 0 && (uint8_t)marked->data[0] == 0x01) {
    size_t take = marked->len > sizeof buf ? sizeof buf : marked->len;
    memcpy(buf, marked->data, take);
    scr_exc_reset(); /* the payload is released before the funnel poisons */
    scr_trap_len(buf, take);
  }
  size_t n = 0;
  const char prefix[] = "Uncaught ";
  memcpy(buf, prefix, sizeof prefix - 1);
  n = sizeof prefix - 1;
  const size_t cap = sizeof buf - 2; /* room for '\n' + NUL */
  switch (scr_exc_kind) {
  case SCR_EXC_F64:
    n += scr_f64_to_str(scr_exc_f64, buf + n);
    break;
  case SCR_EXC_BOOL: {
    const char *b = scr_exc_bool ? "true" : "false";
    size_t bl = strlen(b);
    memcpy(buf + n, b, bl);
    n += bl;
    break;
  }
  case SCR_EXC_STR: {
    const ScrStr *s = (const ScrStr *)scr_exc_payload;
    size_t take = s->len > cap - n ? cap - n : s->len;
    memcpy(buf + n, s->data, take);
    n += take;
    break;
  }
  case SCR_EXC_OBJ:
    if (scr_error_is(scr_exc_payload)) {
      ScrStr *s = scr_error_to_string((ScrError *)scr_exc_payload);
      size_t take = s->len > cap - n ? cap - n : s->len;
      memcpy(buf + n, s->data, take);
      n += take;
      scr_str_release(s);
      break;
    }
    /* fall through: non-Error hierarchy objects render like other refs */
  case SCR_EXC_REF:
  case SCR_EXC_PRIMITIVE_REF: {
    const char obj[] = "[object]";
    memcpy(buf + n, obj, sizeof obj - 1);
    n += sizeof obj - 1;
    break;
  }
  case SCR_EXC_NONE:
  case SCR_EXC_GENRET: { /* unreachable through the pending() gate */
    const char none[] = "(no exception)";
    memcpy(buf + n, none, sizeof none - 1);
    n += sizeof none - 1;
    break;
  }
  }
  buf[n++] = '\n';
  buf[n] = '\0';
  scr_exc_reset(); /* the payload is released before the funnel poisons */
  scr_trap(buf);
}
#endif /* SCR_LIB */

void scr_throw_f64(double v) {
  scr_exc_reset();
  scr_exc_kind = SCR_EXC_F64;
  scr_exc_f64 = v;
  SCR_EXC_RAISED();
}

void scr_throw_bool(bool v) {
  scr_exc_reset();
  scr_exc_kind = SCR_EXC_BOOL;
  scr_exc_bool = v;
  SCR_EXC_RAISED();
}

void scr_throw_str(ScrStr *v) {
  scr_exc_reset();
  scr_exc_kind = SCR_EXC_STR;
  scr_exc_payload = v; /* ownership moves in */
  SCR_EXC_RAISED();
}

void scr_throw_ref(void *v, void *(*retain)(void *), void (*release)(void *),
                    ScrTraceFn trace) {
  scr_exc_reset();
  scr_exc_kind = SCR_EXC_REF;
  scr_exc_payload = v; /* ownership moves in */
  scr_exc_retain_fn = retain;
  scr_exc_release_fn = release;
  scr_exc_trace_fn = trace;
  SCR_EXC_RAISED();
}

void scr_throw_primitive_ref(void *v, void *(*retain)(void *), void (*release)(void *),
                             ScrTraceFn trace) {
  scr_throw_ref(v, retain, release, trace);
  scr_exc_kind = SCR_EXC_PRIMITIVE_REF;
}

void scr_throw_ref_classified(void *v, void *(*retain)(void *), void (*release)(void *),
                              ScrTraceFn trace, bool object) {
  scr_throw_ref(v, retain, release, trace);
  if (!object) scr_exc_kind = SCR_EXC_PRIMITIVE_REF;
}

void scr_throw_obj(void *v, void *(*retain)(void *), void (*release)(void *),
                    ScrTraceFn trace) {
  scr_throw_ref(v, retain, release, trace);
  scr_exc_kind = SCR_EXC_OBJ;
}

/* The abnormal-exit code hint: main returns 1 after an uncaught throw or
 * a reported unhandled rejection, and the process 'exit' listeners (the
 * events unit's atexit, when linked) must see that code, like Node's.
 * Lives HERE so the unit is self-contained (the reporters below and in
 * scr_async.c both note it; scr_events.c reads it). */
static SCR_TL int scr_exit_code_hint = 0;
void scr_exit_code_note(int code) { scr_exit_code_hint = code; }
int scr_exit_code_hint_get(void) { return scr_exit_code_hint; }

SCR_TL int (*scr_uncaught_exception_hook)(bool from_promise) = NULL;
static SCR_TL bool scr_uncaught_handler_failed = false;

bool scr_exc_handle_uncaught(bool from_promise) {
#ifdef SCR_WORKERS
  /* Checkpoint, not just test: the unwind that brought control here may
   * have been a stop request the cell does not show yet. */
  if (scr_context_checkpoint()) return false;
#endif
  if (!scr_exc_pending()) return true;
  if (!scr_uncaught_exception_hook || scr_uncaught_handler_failed) return false;
  int result = scr_uncaught_exception_hook(from_promise);
  if (result < 0) scr_uncaught_handler_failed = true;
  return result > 0;
}

static bool scr_uncaught_print_dyn_primitive(const ScrDyn *d) {
  switch (d->kind) {
  case SCR_DYN_STR:
    fwrite(d->v.str->data, 1, d->v.str->len, stderr);
    return true;
  case SCR_DYN_NUM: {
    char buf[32];
    size_t len = scr_f64_to_str(d->v.num, buf);
    fwrite(buf, 1, len, stderr);
    return true;
  }
  case SCR_DYN_BOOL:
    fputs(d->v.b ? "true" : "false", stderr);
    return true;
  case SCR_DYN_NULL:
    fputs("null", stderr);
    return true;
  case SCR_DYN_UNDEF:
    fputs("undefined", stderr);
    return true;
  default:
    return false;
  }
}

/* An SC diagnostic code ("SC" and four digits) that `text` does not
 * already name as "[SCnnnn". */
static bool scr_uncaught_unnamed_sc_code(const ScrStr *code, const ScrStr *text) {
  if (code == NULL || code->len != 6 || code->data[0] != 'S' || code->data[1] != 'C') return false;
  for (size_t i = 2; i < 6; i++)
    if (code->data[i] < '0' || code->data[i] > '9') return false;
  for (size_t i = 0; i + 7 <= text->len; i++)
    if (text->data[i] == '[' && memcmp(text->data + i + 1, code->data, 6) == 0) return false;
  return true;
}

void scr_exc_print_uncaught(void) {
#ifdef SCR_WORKERS
  if (scr_context_checkpoint()) { scr_exc_clear(); return; }
  if (scr_context_report_error) {
    scr_exit_code_note(scr_uncaught_handler_failed ? 7 : 1);
    scr_context_report_error();
    return;
  }
#endif
  scr_exit_code_note(scr_uncaught_handler_failed ? 7 : 1);
  /* Settle any runtime-internal stdout fragment before the stderr line when
   * both share an fd. JavaScript-visible writes already flush themselves. */
  fflush(stdout);
#ifdef SCR_NODE_ISLANDS
  /* An error thrown by Node island code: Node's own report (the throw
   * site's source line, the stack, the Node.js version). */
  if (scr_exc_kind == SCR_EXC_OBJ && scr_error_is(scr_exc_payload) &&
      scr_ni_report_uncaught((ScrError *)scr_exc_payload)) {
    scr_exc_reset(); /* the payload counts as live until released */
    scr_exc_cell_changed();
    return;
  }
#endif
  fputs("Uncaught ", stderr);
  switch (scr_exc_kind) {
  case SCR_EXC_F64: {
    char buf[32];
    size_t len = scr_f64_to_str(scr_exc_f64, buf);
    fwrite(buf, 1, len, stderr);
    break;
  }
  case SCR_EXC_BOOL:
    fputs(scr_exc_bool ? "true" : "false", stderr);
    break;
  case SCR_EXC_STR: {
    const ScrStr *s = (const ScrStr *)scr_exc_payload;
    fwrite(s->data, 1, s->len, stderr);
    break;
  }
  case SCR_EXC_OBJ:
    /* Error instances (builtin or user subclass) render like Node's first
     * line: "name: message" (toString rules for the empty halves). Node
     * appends a stack trace; scriptc has none (documented divergence). */
    if (scr_error_is(scr_exc_payload)) {
      const ScrError *error = (const ScrError *)scr_exc_payload;
      ScrStr *s = scr_error_to_string((ScrError *)scr_exc_payload);
      fwrite(s->data, 1, s->len, stderr);
      /* A runtime refusal carries its scriptc diagnostic code on `code`;
       * name it unless the message already does, as deferred compile-time
       * refusals' "[SC1090 at file:line]" suffix does. */
      if (scr_uncaught_unnamed_sc_code(error->code, s))
        fprintf(stderr, " [%.*s]", (int)error->code->len, error->code->data);
      scr_str_release(s);
      break;
    }
    /* fall through: non-Error hierarchy objects render like other refs */
  case SCR_EXC_REF:
  case SCR_EXC_PRIMITIVE_REF:
    /* A checked-dynamic value (`throw v` with v: unknown) prints its
     * primitive the way Node's uncaught report does — a string's own
     * text, numbers/booleans/null/undefined by their names. */
    if (scr_exc_release_fn == scr_dyn_release_v && scr_exc_payload != NULL &&
        scr_uncaught_print_dyn_primitive((const ScrDyn *)scr_exc_payload))
      break;
    fputs("[object]", stderr);
    break;
  case SCR_EXC_NONE: /* main only calls this when pending */
  case SCR_EXC_GENRET: /* unreachable: the trampoline consumes the sentinel */
  case SCR_EXC_TERMINATE:
    fputs("(no exception)", stderr);
    break;
  }
  fputc('\n', stderr);
  scr_exc_reset(); /* the payload counts as live until released */
  scr_exc_cell_changed();
}
