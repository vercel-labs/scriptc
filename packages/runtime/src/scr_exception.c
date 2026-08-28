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

#include <stdio.h>
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
#if defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)
/* A thread-local pointer cannot be initialized with &scr_main_exc — the
 * address of a thread-local is not a constant expression — so NULL stands
 * for the main cell and every read resolves it. Fibers never exist in
 * library artifacts, so the cell only ever IS the main cell here. */
static SCR_TL ScrExcCell *scr_cur;
#define SCR_EXC_CUR() (scr_cur ? scr_cur : &scr_main_exc)
#else
static ScrExcCell *scr_cur = &scr_main_exc;
#define SCR_EXC_CUR() (scr_cur)
#endif

/* Fiber switching (scr_async.c) points the exception machinery at the
 * incoming fiber's cell; returns the previous cell. */
ScrExcCell *scr_exc_swap_cell(ScrExcCell *cell) {
  ScrExcCell *prev = SCR_EXC_CUR();
  scr_cur = cell ? cell : &scr_main_exc;
  return prev;
}

/* The ACTIVE cell, for runtime code that moves a pending payload out of it
 * (a new-Promise executor throw rejecting the promise). */
ScrExcCell *scr_exc_current_cell(void) { return SCR_EXC_CUR(); }

#define scr_exc_kind (SCR_EXC_CUR()->kind)
#define scr_exc_f64 (SCR_EXC_CUR()->f64)
#define scr_exc_bool (SCR_EXC_CUR()->b)
#define scr_exc_payload (SCR_EXC_CUR()->payload)
#define scr_exc_retain_fn (SCR_EXC_CUR()->retain_fn)
#define scr_exc_release_fn (SCR_EXC_CUR()->release_fn)
#define scr_exc_trace_fn (SCR_EXC_CUR()->trace_fn)

bool scr_exc_pending(void) { return scr_exc_kind != SCR_EXC_NONE; }

/* Release the current payload (if any) and reset to NONE. Shared by clear,
 * the uncaught printer, and every throw (replace semantics). */
static void scr_exc_reset(void) {
  if (scr_exc_kind == SCR_EXC_STR) {
    scr_str_release((ScrStr *)scr_exc_payload);
  } else if (scr_exc_kind == SCR_EXC_REF || scr_exc_kind == SCR_EXC_OBJ) {
    scr_exc_release_fn(scr_exc_payload);
  }
  scr_exc_kind = SCR_EXC_NONE;
  scr_exc_payload = NULL;
  scr_exc_retain_fn = NULL;
  scr_exc_release_fn = NULL;
  scr_exc_trace_fn = NULL;
}

void scr_exc_clear(void) { scr_exc_reset(); }

/* ── catch bindings (ScrCaught — contract in scr_runtime.h) ──────────── */

ScrCaught *scr_exc_take(void) {
  ScrCaught *c = calloc(1, sizeof *c);
  if (!c) {
    scr_trap("scriptc: out of memory\n");
  }
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
    if (c->kind == SCR_EXC_STR) {
      scr_str_release((ScrStr *)c->payload);
    } else if (c->kind == SCR_EXC_REF || c->kind == SCR_EXC_OBJ) {
      c->release_fn(c->payload);
    }
    scr_obj_free_note();
    free(c);
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
  case SCR_EXC_OBJ:
    scr_throw_obj(c->retain_fn(c->payload), c->retain_fn, c->release_fn, c->trace_fn);
    break;
  case SCR_EXC_NONE:
    break; /* unreachable: take() never stores NONE */
  case SCR_EXC_GENRET:
    /* The generator-return sentinel, stashed across an exception-path
     * finally (emitTryCatch): re-raising restores the bare kind — no
     * payload exists. */
    scr_exc_reset();
    scr_exc_kind = SCR_EXC_GENRET;
    break;
  }
}

bool scr_caught_instanceof(const ScrCaught *c, size_t pre, size_t post) {
  if (c->kind != SCR_EXC_OBJ) return false;
  /* Every hierarchy class shares the rc+vt prefix; ScrError names it. */
  const ScrVt *vt = ((const ScrError *)c->payload)->vt;
  return pre <= vt->pre && vt->pre <= post;
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
    /* Object.prototype.toString — exact for thrown records and class
     * instances without a toString override; thrown arrays/closures/union
     * boxes print this too where Node would vary (SEMANTICS.md). */
    return scr_str_new("[object Object]", 15);
  case SCR_EXC_NONE:
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
  case SCR_EXC_REF: {
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
}

void scr_throw_bool(bool v) {
  scr_exc_reset();
  scr_exc_kind = SCR_EXC_BOOL;
  scr_exc_bool = v;
}

void scr_throw_str(ScrStr *v) {
  scr_exc_reset();
  scr_exc_kind = SCR_EXC_STR;
  scr_exc_payload = v; /* ownership moves in */
}

void scr_throw_ref(void *v, void *(*retain)(void *), void (*release)(void *),
                    ScrTraceFn trace) {
  scr_exc_reset();
  scr_exc_kind = SCR_EXC_REF;
  scr_exc_payload = v; /* ownership moves in */
  scr_exc_retain_fn = retain;
  scr_exc_release_fn = release;
  scr_exc_trace_fn = trace;
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

void scr_exc_print_uncaught(void) {
  scr_exit_code_note(1);
  /* Settle any runtime-internal stdout fragment before the stderr line when
   * both share an fd. JavaScript-visible writes already flush themselves. */
  fflush(stdout);
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
      ScrStr *s = scr_error_to_string((ScrError *)scr_exc_payload);
      fwrite(s->data, 1, s->len, stderr);
      scr_str_release(s);
      break;
    }
    /* fall through: non-Error hierarchy objects render like other refs */
  case SCR_EXC_REF:
    fputs("[object]", stderr);
    break;
  case SCR_EXC_NONE: /* main only calls this when pending */
  case SCR_EXC_GENRET: /* unreachable: the trampoline consumes the sentinel */
    fputs("(no exception)", stderr);
    break;
  }
  fputc('\n', stderr);
  scr_exc_reset(); /* the payload counts as live until released */
}
