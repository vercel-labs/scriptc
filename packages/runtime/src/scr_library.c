/* Library mode support: the panic sink, the poisoned-library flag, the
 * outbound-result arena, the reset registry, and the sink-routing trap
 * funnel. Linked ONLY into library artifacts (every TU of a library archive
 * compiles with -DSCR_LIB); executable builds never contain this file —
 * their funnel expansion lives in scr_console.c and their session teardown
 * stays atexit-driven.
 *
 * The profile-NAMED symbols (init, sink registration, reset, collect) are
 * emitted in the program TU and delegate here, so this file stays
 * profile-agnostic and the program TU carries every profile-named symbol —
 * one place for the conformance symbol audit to look.
 *
 * Multi-instance processes (the profile's abi.localize_runtime): the
 * archive build demotes this file's externals — and every other runtime
 * internal — to LOCAL symbols, so each linked archive carries its own
 * private copy of all the state here: its own sink registration, poison
 * flag, arena, and entry-symbol slot. Sinks therefore register per
 * instance, and a trap poisons only the instance it fired in. Nothing in
 * this file is thread-aware; the embedder contract is one thread per
 * instance (an instance is never entered from two threads).
 *
 * Thread-instanced archives (the profile's abi.instance_per_thread) take
 * the same story one level down: SCR_TL moves this file's state — and
 * every other mutable static in the archive — into thread-local storage,
 * so ONE linked archive serves one independent instance per embedder
 * thread. A thread registers its own sink and calls the init entry before
 * serving; its trap poisons only its own instance while sibling threads'
 * instances keep answering. The one-thread-per-instance contract is
 * unchanged — the calling thread IS the instance selector.
 *
 * State after a sink call: none is legal. The trap fired mid-operation with
 * no unwinding — heap, arena, and collector state are unspecified; the library
 * is POISONED. Every runtime-touching entry prologue aborts on the flag
 * (deterministic, never heap corruption); recovery is process restart. */
#include "scr_runtime.h"

#ifdef SCR_LIB

#include <stdio.h>
#include <stdlib.h>

/* ── sink registration + poison ───────────────────────────────────────── */

static SCR_TL ScrLibSinkFn scr_library_sink = NULL;
static SCR_TL void *scr_library_sink_ctx = NULL;
static SCR_TL bool scr_library_poisoned = false;

void scr_library_set_sink(ScrLibSinkFn fn, void *ctx) {
  /* Latest registration wins; re-registration is permitted before a trap.
   * Deliberately NOT poison-guarded: a pure store, touching no runtime
   * state — but a poisoned library's entries abort regardless of the sink. */
  scr_library_sink = fn;
  scr_library_sink_ctx = ctx;
}

/* ── host-callback channels (scr_runtime.h's contract) ────────────────────
 * Fixed slot storage, one pair per profile-declared channel (declaration
 * order = slot index, assigned by the generated registration symbol's
 * dispatch). SCR_TL gives thread-instanced archives per-instance
 * registration; localization gives multi-instance processes per-archive
 * slots — exactly the sink's story. The generated program TU is the only
 * caller, with slot indices proven in range at compile time (the profile
 * caps channels at SCR_LIB_MAX_CALLBACKS). */

static SCR_TL ScrLibCbFn scr_library_cb_fns[SCR_LIB_MAX_CALLBACKS];
static SCR_TL void *scr_library_cb_ctxs[SCR_LIB_MAX_CALLBACKS];
/* A typed host callback runs synchronously inside one ABI entry. Like the
 * sink, slots, poison, arena, and current-entry symbol, this belongs to the
 * localized / thread-instanced library copy rather than the process. */
static SCR_TL size_t scr_library_callback_depth = 0;

void scr_library_cb_set(size_t slot, ScrLibCbFn fn, void *ctx) {
  /* A pure store, the sink registration's rule: latest wins, NULL clears,
   * not poison-guarded, persists across init/reset. */
  scr_library_cb_fns[slot] = fn;
  scr_library_cb_ctxs[slot] = ctx;
}

ScrLibCbFn scr_library_cb_require(size_t slot, const char *trap_msg) {
  /* trap_msg is the call site's constant ("scriptc: library callback
   * '<name>' invoked before registration\n") — a DETECTED trap the funnel
   * classifies SC4025 and assembles with the entry the host called. */
  if (scr_library_cb_fns[slot] == NULL) scr_trap(trap_msg);
  return scr_library_cb_fns[slot];
}

void *scr_library_cb_ctx(size_t slot) { return scr_library_cb_ctxs[slot]; }

void scr_library_callback_begin(void) { scr_library_callback_depth++; }

void scr_library_callback_end(void) {
  /* Generated calls pair this only with a normally returned host callback.
   * A callback that illegally unwinds leaves the depth set, so a later ABI
   * entry fails deterministically instead of silently reusing the instance. */
  if (scr_library_callback_depth != 0) scr_library_callback_depth--;
}

/* ── the trap funnel, library expansion ───────────────────────────────────
 * Poison first (the sink may longjmp to a host frame below the entry — the
 * conforming survival pattern), then deliver exactly once, then abort:
 * before registration, or if the sink returns (the ruled host-contract
 * violation). The address is the funnel frame's return address — the trap
 * site — 0 where the toolchain cannot supply one.
 *
 * Delivery shape (the ratified structured trap-teaching encoding): a
 * message that already begins with the 0x01 marker — a facade-authored
 * structured throw riding the verbatim rule, or the wrapper's compile-
 * time-assembled SC4012 contract trap — is delivered byte-for-byte. Every
 * OTHER message is a trap the runtime DETECTED, and the funnel assembles
 * it here into 0x01 text 0x1F code 0x1F symbol [0x1F remediation]: the
 * baseline human line becomes field 0 unchanged (so plain-text hosts read
 * exactly what they always read), the code classifies the trap kind, the
 * symbol is the entry the trapping call came through (recorded by the
 * entry prologue below), and the remediation is the profile's for that
 * code when the program TU's overlay table declares one. */

#if defined(__GNUC__) || defined(__clang__)
#define SCR_TRAP_ADDR() ((uint64_t)(uintptr_t)__builtin_return_address(0))
#else
#define SCR_TRAP_ADDR() ((uint64_t)0)
#endif

/* The current-entry slot: every generated entry's prologue records its
 * external symbol before dispatching into core code. A single static slot
 * is sound — exactly one core is live per copy of this state (the sole
 * core in a classic process; each archive's own instance under
 * abi.localize_runtime, where this slot is a per-instance local), re-entry
 * from a host callback is rejected before core work begins, and a trap can
 * only fire while an entry is on the stack.
 * NULL (never entered) renders as the empty symbol field. */
static SCR_TL const char *scr_library_entry_symbol = NULL;

/* Detected-trap classification: the runtime's trap sites self-classify
 * through their message conventions (the exact bytes the executable lane
 * prints), so the kind → code mapping keys on those prefixes. The codes are
 * the compiler registry's runtime family (diagnostics/diagnostic.ts —
 * documented beside SC4012); SC4019 is the family's residual for detected
 * traps outside the named kinds (environment failures, unsupported
 * operations, the RC audit). */
static const struct {
  const char *prefix;
  const char *code;
} scr_library_trap_kinds[] = {
  {"Uncaught ", "SC4013"},                  /* escaped exception at an entry */
  {"scriptc: RangeError: ", "SC4014"},      /* range trap */
  {"scriptc: TypeError: ", "SC4015"},       /* type trap */
  {"scriptc: SyntaxError: ", "SC4016"},     /* syntax trap (regex compile) */
  {"scriptc: out of memory", "SC4017"},     /* allocation failure */
  {"scriptc: internal error: ", "SC4018"},  /* internal invariant failure */
  {"scriptc: library callback ", "SC4025"}, /* unregistered host callback */
  {"scriptc: library entry ", "SC4026"},    /* host callback re-entry */
};

static const char *scr_library_trap_code(const char *msg, size_t len) {
  for (size_t i = 0; i < sizeof scr_library_trap_kinds / sizeof scr_library_trap_kinds[0]; i++) {
    size_t plen = strlen(scr_library_trap_kinds[i].prefix);
    if (len >= plen && memcmp(msg, scr_library_trap_kinds[i].prefix, plen) == 0) {
      return scr_library_trap_kinds[i].code;
    }
  }
  return "SC4019"; /* other detected trap */
}

static _Noreturn void scr_library_trap_deliver(const char *msg, size_t len, uint64_t addr) {
  scr_library_poisoned = true;
  if (!(len > 0 && (uint8_t)msg[0] == 0x01)) {
    /* A detected trap: assemble the structured message. Static buffer —
     * no malloc on the failure path; text truncates before structure ever
     * would (codes and symbols are short; an oversized remediation drops
     * whole, never split). */
    static SCR_TL char buf[2048];
    const char *code = scr_library_trap_code(msg, len);
    const char *text = msg;
    size_t text_len = len;
    const char *rem = NULL;
    for (size_t i = 0; i < scr_library_trap_overlays_len; i++) {
      const char *const *t = &scr_library_trap_overlays[3 * i];
      if (strcmp(t[0], code) == 0) {
        if (t[1] != NULL) {
          text = t[1];
          text_len = strlen(t[1]);
        }
        rem = t[2];
        break;
      }
    }
    const char *sym = scr_library_entry_symbol != NULL ? scr_library_entry_symbol : "";
    size_t tail = 2 + strlen(code) + strlen(sym);
    if (rem != NULL) {
      if (tail + 1 + strlen(rem) > sizeof buf - 1) rem = NULL; /* drop whole, keep structure */
      else tail += 1 + strlen(rem);
    }
    size_t n = 0;
    buf[n++] = '\x01';
    size_t cap = sizeof buf - 1 - tail;
    if (text_len > cap) text_len = cap;
    for (size_t i = 0; i < text_len; i++) {
      /* The encoding reserves 0x01/0x1F; runtime messages never contain
       * them, but an escaped exception's rendered text embeds user bytes. */
      char c = text[i];
      buf[n++] = (c == '\x01' || c == '\x1f') ? ' ' : c;
    }
    buf[n++] = '\x1f';
    memcpy(buf + n, code, strlen(code));
    n += strlen(code);
    buf[n++] = '\x1f';
    memcpy(buf + n, sym, strlen(sym));
    n += strlen(sym);
    if (rem != NULL) {
      buf[n++] = '\x1f';
      memcpy(buf + n, rem, strlen(rem));
      n += strlen(rem);
    }
    msg = buf;
    len = n;
  }
  if (scr_library_sink != NULL) {
    scr_library_sink(scr_library_sink_ctx, (const uint8_t *)msg, len, addr);
  }
  abort();
}

__attribute__((noinline)) _Noreturn void scr_trap(const char *msg) {
  scr_library_trap_deliver(msg, strlen(msg), SCR_TRAP_ADDR());
}

__attribute__((noinline)) _Noreturn void scr_trap_len(const char *msg, size_t len) {
  /* The length-delimited funnel entry: structured trap-teaching messages
   * and verbatim 0x01-led thrown messages are byte-counted, never
   * NUL-scanned (a thrown JS string may embed NUL). Same poison-deliver-
   * abort discipline as scr_trap. */
  scr_library_trap_deliver(msg, len, SCR_TRAP_ADDR());
}

__attribute__((noinline)) _Noreturn void scr_trap_fmt(const char *fmt, ...) {
  static SCR_TL char buf[512]; /* no malloc on the invariant-failure path */
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  size_t len = n < 0 ? 0 : (size_t)n >= sizeof buf ? sizeof buf - 1 : (size_t)n;
  scr_library_trap_deliver(buf, len, SCR_TRAP_ADDR());
}

/* ── entry prologues ──────────────────────────────────────────────────── */

static _Noreturn void scr_library_callback_reentry(const char *entry_symbol) {
  /* Attribute the detected trap to the attempted INNER ABI symbol. Clear
   * depth before delivery: a conforming sink may longjmp to a host recovery
   * frame, and its poisoned instance must not retain stale callback-active
   * state that would change the established pure-registration behavior. */
  scr_library_entry_symbol = entry_symbol;
  scr_library_callback_depth = 0;
  scr_trap_fmt("scriptc: library entry '%s' invoked from a host callback\n", entry_symbol);
}

void scr_library_callback_entry_guard(const char *entry_symbol) {
  if (scr_library_callback_depth != 0) scr_library_callback_reentry(entry_symbol);
}

void scr_library_entry(bool reset_arena, const char *entry_symbol) {
  /* Record the entry symbol FIRST so even a poisoned-abort's core dump
  * names the entry; a trap anywhere below (the arena reset's OOM
  * included) then reports the right symbol. */
  scr_library_entry_symbol = entry_symbol;
  /* Re-entry must win over poison and reset: no inner ABI entry may mutate
   * globals, release arena data, collect, or replace state from a callback. */
  if (scr_library_callback_depth != 0) scr_library_callback_reentry(entry_symbol);
  /* A poisoned library's entries abort deterministically — never through the
   * sink again (it received its exactly-once message when the trap fired),
   * never into a heap whose invariants already failed. */
  if (scr_library_poisoned) abort();
  if (reset_arena) scr_library_arena_reset();
}

/* ── the outbound-result arena ────────────────────────────────────────────
 * Buffer-class results (string/bytes) MOVE in here; the host reads through
 * borrowed pointers until the arena resets (per-entry under the auto
 * posture, host-cycled when the profile declares a reset symbol; init and
 * collect always reset). */

typedef struct {
  void *v;
  bool is_str; /* ScrStr vs ScrBytes — picks the release */
} ScrCoreArenaEnt;

static SCR_TL ScrCoreArenaEnt *scr_library_arena = NULL;
static SCR_TL size_t scr_library_arena_n = 0, scr_library_arena_cap = 0;

static void scr_library_arena_keep(void *v, bool is_str) {
  if (scr_library_arena_n == scr_library_arena_cap) {
    scr_library_arena_cap = scr_library_arena_cap ? scr_library_arena_cap * 2 : 16;
    scr_library_arena = realloc(scr_library_arena, scr_library_arena_cap * sizeof *scr_library_arena);
    if (!scr_library_arena) scr_trap("scriptc: out of memory\n");
  }
  scr_library_arena[scr_library_arena_n].v = v;
  scr_library_arena[scr_library_arena_n].is_str = is_str;
  scr_library_arena_n++;
}

void scr_library_arena_reset(void) {
  for (size_t i = 0; i < scr_library_arena_n; i++) {
    if (scr_library_arena[i].is_str) scr_str_release((ScrStr *)scr_library_arena[i].v);
    else scr_bytes_release((ScrBytes *)scr_library_arena[i].v);
  }
  scr_library_arena_n = 0;
}

void scr_library_collect(void) {
  scr_library_arena_reset();
  scr_collect_cycles();
}

/* ── marshalling helpers (both emissions call exactly these) ──────────── */

ScrStr *scr_library_str_in(const uint8_t *p, size_t len) {
  /* ptr may be NULL when len is 0 (the contract's empty-buffer form). */
  return scr_str_new(len == 0 ? "" : (const char *)p, len);
}

ScrBytes *scr_library_bytes_in(const uint8_t *p, size_t len, const char *trap_msg) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (b == NULL) {
    /* scr_bytes_new throws only for lengths past 2^53-1 — an impossible
     * host buffer; funnel the contract violation instead of a NULL deref.
     * The message is the wrapper's compiler-assembled structured
     * trap-teaching form (code SC4012, the trapping export's symbol, the
     * profile's teaching and remediation) — opaque bytes here. */
    scr_exc_clear();
    scr_trap(trap_msg);
  }
  if (len > 0 && p != NULL) memcpy(b->data, p, len);
  return b;
}

double scr_library_i64_in(int64_t v, const char *trap_msg) {
  /* The inbound declared-integer edge (ask 4): only |v| <= 2^53-1 rides
   * f64 exactly; past it, (double)v silently rounds — a coercion the
   * author never wrote, so the wrapper funnels the host-contract
   * violation instead (same story as an impossible bytes length; the
   * message is the compiler-assembled structured trap-teaching form). */
  if (v > 9007199254740991LL || v < -9007199254740991LL) scr_trap(trap_msg);
  return (double)v;
}

double scr_library_u64_in(uint64_t v, const char *trap_msg) {
  if (v > 9007199254740991ULL) scr_trap(trap_msg);
  return (double)v;
}

void scr_library_str_out(ScrStr *s, const uint8_t **out, size_t *out_len) {
  scr_library_arena_keep(s, true);
  *out = (const uint8_t *)s->data; /* NUL-terminated after len (ScrStr layout) */
  *out_len = s->len;
}

void scr_library_bytes_out(ScrBytes *b, const uint8_t **out, size_t *out_len) {
  scr_library_arena_keep(b, false);
  *out = b->data; /* elem is always u8 at the boundary (v1 bytes class) */
  *out_len = b->len;
}

/* ── the reset registry + session reset ─────────────────────────────────
 * Where an executable's always-linked units atexit() their lazy teardowns,
 * library builds register here (scr_atexit in scr_runtime.h): registered
 * once, drained on EVERY reset — re-registration guards in the units stay
 * satisfied because the entry persists. */

#define SCR_LIB_MAX_RESETS 32
static SCR_TL void (*scr_library_resets[SCR_LIB_MAX_RESETS])(void);
static SCR_TL size_t scr_library_nresets = 0;

void scr_library_register_reset(void (*fn)(void)) {
  for (size_t i = 0; i < scr_library_nresets; i++) {
    if (scr_library_resets[i] == fn) return;
  }
  if (scr_library_nresets == SCR_LIB_MAX_RESETS) {
    scr_trap("scriptc: internal error: library reset registry overflow\n");
  }
  scr_library_resets[scr_library_nresets++] = fn;
}

#ifdef SCR_RC_AUDIT
extern long scr_str_live_count(void);     /* scr_string.c */
extern long scr_arr_live_count(void);     /* scr_array.c */
extern long scr_map_live_count(void);     /* scr_map.c */
extern long scr_box_live_count(void);     /* scr_closure.c */
extern long scr_closure_live_count(void); /* scr_closure.c */
extern long scr_obj_live_count(void);     /* scr_object.c */
extern long scr_union_live_count(void);   /* scr_union.c */
extern long scr_dyn_live_count(void);     /* scr_json.c */
extern long scr_bytes_live_count(void);   /* scr_bytes.c */

/* The per-session heap-emptiness assertion (the audit flavor's determinism
 * seam): after a full reset the live counters must all read zero, or the
 * previous session leaked. A failure is a TRAP through the sink — the
 * executable audit's _Exit(99) stays exe-lane-only. */
static void scr_library_audit_zero(void) {
  long strings = scr_str_live_count(), arrays = scr_arr_live_count(),
       maps = scr_map_live_count(), boxes = scr_box_live_count(),
       closures = scr_closure_live_count(), objects = scr_obj_live_count(),
       unions = scr_union_live_count(), dyns = scr_dyn_live_count(),
       bytes = scr_bytes_live_count();
  if (strings != 0 || arrays != 0 || maps != 0 || boxes != 0 || closures != 0 ||
      objects != 0 || unions != 0 || dyns != 0 || bytes != 0) {
    scr_trap_fmt(
        "scriptc LIBRARY RC AUDIT FAILED: %ld heap string(s), %ld array(s), "
        "%ld map(s), %ld box(es), %ld closure(s), %ld object(s), "
        "%ld union(s), %ld dyn value(s), %ld bytes value(s) live across re-init\n",
        strings, arrays, maps, boxes, closures, objects, unions, dyns, bytes);
  }
}
#endif /* SCR_RC_AUDIT */

extern void scr_lib_session_cleanup(void); /* scr_lib.c: the interned process values */

void scr_library_reset(void) {
  /* Called by the generated init entry AFTER the program TU released and
   * zeroed its globals (run-once guards included) — the same order the
   * executable exit path runs: library cleanup → cycle collection → RC
   * audit. Everything here is re-runnable; the first call is a cheap
   * no-op pass. */
  scr_exc_clear();
  scr_library_arena_reset();
  for (size_t i = 0; i < scr_library_nresets; i++) scr_library_resets[i]();
  scr_lib_session_cleanup();
  scr_collect_cycles();
#ifdef SCR_RC_AUDIT
  scr_library_audit_zero();
#endif
}

#endif /* SCR_LIB */
