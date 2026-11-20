/* node:diagnostics_channel — the in-process pub/sub core (scr_runtime.h
 * has the API contract). Linked only when the IR carries dc.* libCalls
 * (native-toolchain.ts; the zlib gating precedent), pure data structure over the checked-dynamic tree —
 * no loop hooks, no platform seams, cross-compiles everywhere.
 *
 * - The registry is process-global and append-only (Node's channels are
 *   process-lived too — its WeakRefMap only collects channels nothing
 *   references, which a compiled program cannot observe). Handles are
 *   1-based indexes so a zeroed f64 can never alias channel 0.
 * - Subscribers are dyn FUNCTION values. unsubscribe matches by the
 *   UNDERLYING closure when both sides are functions (boxing one function
 *   twice yields distinct ScrDyn nodes sharing one ScrClosure, and JS has
 *   ONE function object), falling back to node identity.
 * - publish iterates a SNAPSHOT of the subscriber list: a subscriber
 *   unsubscribing itself mid-publish still lets its siblings fire (the
 *   test suite's sync-unsubscribe shape, Node's behavior). A subscriber's
 *   throw does not stop the dispatch: like Node's
 *   process.nextTick(triggerUncaughtException), it surfaces as an uncaught
 *   exception on the next tick.
 * - The atexit teardown releases names and subscribers before the RC
 *   audit runs (atexit is LIFO; scr_init registered the audit first), so
 *   registry-held values never count as leaks.
 */
#include "scr_runtime.h"

#if defined(__APPLE__)
/* The node:test tracing hooks are optional in Mach-O executables. */
int scr_dc_unit_linked = 1;
#endif

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  double als_id;      /* the bound AsyncLocalStorage handle */
  ScrDyn *transform;  /* owned truthy transform value, or NULL (identity) */
} ScrDcBinding;

typedef struct {
  ScrDyn *name;   /* owned: the STR or SYMBOL name it was interned by */
  ScrDyn **subs;  /* owned entries */
  size_t nsubs, cap;
  /* bindStore entries: set semantics per store (a re-bind replaces the
   * transform), entered around every publish that flows through
   * runStores (and the tracing choreography's runStores points). */
  ScrDcBinding *binds;
  size_t nbinds, binds_cap;
} ScrDcChannel;

static SCR_TL ScrDcChannel *dc_channels = NULL;
static SCR_TL size_t dc_nchannels = 0, dc_cap = 0;
static SCR_TL bool dc_teardown_registered = false;

/* Subscriber and transform throws waiting for their next-tick report,
 * oldest first. */
static SCR_TL ScrCaught **dc_deferred = NULL;
static SCR_TL size_t dc_ndeferred = 0, dc_deferred_cap = 0;

static void dc_report_deferred(void) {
  if (dc_ndeferred == 0) return;
  ScrCaught *caught = dc_deferred[0];
  memmove(dc_deferred, dc_deferred + 1, --dc_ndeferred * sizeof *dc_deferred);
  scr_rethrow(caught);
  scr_caught_release(caught);
}

/* Move the pending exception into the deferred queue and report it from a
 * next tick of its own (Node: process.nextTick(() =>
 * triggerUncaughtException(err, false))). */
static void dc_defer_pending_throw(void) {
  if (dc_ndeferred == dc_deferred_cap) {
    dc_deferred_cap = dc_deferred_cap ? dc_deferred_cap * 2 : 4;
    dc_deferred = realloc(dc_deferred, dc_deferred_cap * sizeof *dc_deferred);
    if (!dc_deferred) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  dc_deferred[dc_ndeferred++] = scr_exc_take();
  scr_next_tick_raw(dc_report_deferred);
}

static void scr_dc_teardown(void) {
  for (size_t i = 0; i < dc_ndeferred; i++) scr_caught_release(dc_deferred[i]);
  free(dc_deferred);
  dc_deferred = NULL;
  dc_ndeferred = dc_deferred_cap = 0;
  for (size_t i = 0; i < dc_nchannels; i++) {
    ScrDcChannel *ch = &dc_channels[i];
    scr_dyn_release(ch->name);
    for (size_t j = 0; j < ch->nsubs; j++) scr_dyn_release(ch->subs[j]);
    free(ch->subs);
    for (size_t j = 0; j < ch->nbinds; j++) scr_dyn_release(ch->binds[j].transform);
    free(ch->binds);
  }
  free(dc_channels);
  dc_channels = NULL;
  dc_nchannels = dc_cap = 0;
}

/* Channel-name identity: strings by content, symbols by identity (a symbol
 * IS its identity — Node's registry keys them that way too). */
static bool dc_name_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a->kind != b->kind) return false;
  if (a->kind == SCR_DYN_STR) return scr_str_eq(a->v.str, b->v.str);
  if (a->kind == SCR_DYN_SYMBOL) return a->v.symbol.value == b->v.symbol.value;
  return false;
}

/* The console unit's publisher slot: installed the first time this unit
 * creates a channel, so a program without diagnostics_channel never pays for
 * it and no weak symbol is involved. */
extern void scr_console_set_channel_publisher(void (*publisher)(double member, ScrDyn *args));
extern void scr_console_set_channel_active(bool (*active)(double member));
void scr_dc_console_emit_args(double member, ScrDyn *args);
bool scr_dc_console_active(double member);

static void dc_install_console_publisher(void) {
  static SCR_TL bool installed = false;
  if (installed) return;
  installed = true;
  scr_console_set_channel_publisher(scr_dc_console_emit_args);
  scr_console_set_channel_active(scr_dc_console_active);
}

/* Get-or-create by name; returns the channel's index. Borrows name. */
static size_t dc_intern(ScrDyn *name) {
  for (size_t i = 0; i < dc_nchannels; i++) {
    if (dc_name_eq(dc_channels[i].name, name)) return i;
  }
  if (dc_nchannels == dc_cap) {
    dc_cap = dc_cap ? dc_cap * 2 : 8;
    dc_channels = realloc(dc_channels, dc_cap * sizeof *dc_channels);
    if (!dc_channels) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  if (!dc_teardown_registered) {
    dc_teardown_registered = true;
    scr_atexit(scr_dc_teardown);
  }
  dc_install_console_publisher();
  ScrDcChannel *ch = &dc_channels[dc_nchannels];
  ch->name = scr_dyn_retain(name);
  ch->subs = NULL;
  ch->nsubs = ch->cap = 0;
  ch->binds = NULL;
  ch->nbinds = ch->binds_cap = 0;
  return dc_nchannels++;
}

static ScrDcChannel *dc_of(double handle) {
  size_t i = (size_t)handle;
  if (i < 1 || i > dc_nchannels) {
    /* Compiled code can only hold handles dc_intern minted — anything
     * else is a compiler bug, never user-reachable. */
    fputs("scriptc: invalid diagnostics_channel handle\n", stderr);
    abort();
  }
  return &dc_channels[i - 1];
}

/* Node's ERR_INVALID_ARG_TYPE: the argument's name, the expectation
 * phrase (`of type function`, `one of type string or symbol`, ...) and the
 * "Received ..." tail this unit can render (determineSpecificType lite;
 * scr_dyn_handle.c's full renderer is not linked here). */
static void dc_throw_arg_type(const char *expected, const char *arg_name, const ScrDyn *cb) {
  const char *received = "an instance of Object";
  char detail[64];
  if (cb == NULL) {
    received = "undefined";
    char buf[192];
    int n = snprintf(buf, sizeof buf, "The \"%s\" %s must be %s. Received %s", arg_name,
                     strchr(arg_name, '.') ? "property" : "argument", expected, received);
    scr_throw_error_msg_code(SCR_ERR_TYPE, buf, (size_t)n, "ERR_INVALID_ARG_TYPE");
    return;
  }
  switch (cb->kind) {
  case SCR_DYN_NULL: received = "null"; break;
  case SCR_DYN_UNDEF: received = "undefined"; break;
  case SCR_DYN_ARR: received = "an instance of Array"; break;
  case SCR_DYN_BYTES:
    snprintf(detail, sizeof detail, "an instance of %s", scr_bytes_elem_name(cb->v.bytes->elem));
    received = detail;
    break;
  case SCR_DYN_BOOL:
    snprintf(detail, sizeof detail, "type boolean (%s)", cb->v.b ? "true" : "false");
    received = detail;
    break;
  case SCR_DYN_NUM: {
    char num[32];
    size_t n = scr_f64_to_str(cb->v.num, num);
    snprintf(detail, sizeof detail, "type number (%.*s)", (int)n, num);
    received = detail;
    break;
  }
  case SCR_DYN_STR:
    snprintf(detail, sizeof detail, "type string ('%.*s')",
             (int)(cb->v.str->len < 28 ? cb->v.str->len : 28), cb->v.str->data);
    received = detail;
    break;
  case SCR_DYN_SYMBOL: {
    ScrStr *text = cb->v.symbol.render(cb->v.symbol.value); /* "Symbol(desc)" */
    if (text != NULL) {
      snprintf(detail, sizeof detail, "type symbol (%.*s)", (int)text->len, text->data);
      scr_str_release(text);
      received = detail;
    }
    break;
  }

  default: break;
  }
  char buf[192];
  int n = snprintf(buf, sizeof buf, "The \"%s\" %s must be %s. Received %s", arg_name,
                   strchr(arg_name, '.') ? "property" : "argument", expected, received);
  scr_throw_error_msg_code(SCR_ERR_TYPE, buf, (size_t)n, "ERR_INVALID_ARG_TYPE");
}

static void dc_throw_bad_subscriber(const ScrDyn *cb) {
  dc_throw_arg_type("of type function", "subscription", cb);
}

/* validateChannelName over a dyn value: the retained STR or SYMBOL name,
 * or NULL with Node's ERR_INVALID_ARG_TYPE ("must be one of type string or
 * symbol") pending. */
static ScrDyn *dc_name_arg(ScrDyn *name, const char *arg_name) {
  if (name != NULL && (name->kind == SCR_DYN_STR || name->kind == SCR_DYN_SYMBOL))
    return scr_dyn_retain(name);
  dc_throw_arg_type("one of type string or symbol", arg_name, name);
  return NULL;
}

/* Subscriber identity: the underlying closure for FUNC pairs, node
 * identity otherwise. */
static bool dc_sub_matches(const ScrDyn *a, const ScrDyn *b) {
  if (a == b) return true;
  return a->kind == SCR_DYN_FUNC && b->kind == SCR_DYN_FUNC &&
         scr_closure_identity_equal(a->v.fn.clo, b->v.fn.clo);
}

static void dc_sub_add(ScrDcChannel *ch, ScrDyn *cb) {
  if (ch->nsubs == ch->cap) {
    ch->cap = ch->cap ? ch->cap * 2 : 4;
    ch->subs = realloc(ch->subs, ch->cap * sizeof *ch->subs);
    if (!ch->subs) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  ch->subs[ch->nsubs++] = scr_dyn_retain(cb);
}

static bool dc_sub_remove(ScrDcChannel *ch, const ScrDyn *cb) {
  for (size_t i = 0; i < ch->nsubs; i++) {
    if (dc_sub_matches(ch->subs[i], cb)) {
      scr_dyn_release(ch->subs[i]);
      memmove(ch->subs + i, ch->subs + i + 1, (ch->nsubs - i - 1) * sizeof *ch->subs);
      ch->nsubs--;
      return true;
    }
  }
  return false;
}

double scr_dc_channel(ScrDyn *name) {
  ScrDyn *key = dc_name_arg(name, "channel");
  if (key == NULL) return NAN;
  double handle = (double)(dc_intern(key) + 1);
  scr_dyn_release(key);
  return handle;
}

void scr_dc_chan_subscribe(double handle, ScrDyn *cb) {
  if (cb->kind != SCR_DYN_FUNC) {
    dc_throw_bad_subscriber(cb);
    return;
  }
  dc_sub_add(dc_of(handle), cb);
}

/* Node's Channel.unsubscribe answers false for a non-function (no check):
 * the prototype member removes nothing and raises nothing. */
bool scr_dc_chan_unsubscribe(double handle, ScrDyn *cb) {
  if (cb->kind != SCR_DYN_FUNC) return false;
  return dc_sub_remove(dc_of(handle), cb);
}

/* Node's Channel is ACTIVE with subscribers OR bound stores (bindStore
 * marks active through the same prototype swap subscribe uses), and
 * hasSubscribers answers activeness — so the tracing early exits keep
 * running the store choreography for subscriber-less bound channels. */
static bool dc_chan_active(const ScrDcChannel *ch) { return ch->nsubs > 0 || ch->nbinds > 0; }

bool scr_dc_chan_has_subscribers(double handle) { return dc_chan_active(dc_of(handle)); }

ScrDyn *scr_dc_chan_name(double handle) { return scr_dyn_retain(dc_of(handle)->name); }

void scr_dc_subscribe(ScrDyn *name, ScrDyn *cb) {
  /* Node validates the name first, then the subscriber. */
  ScrDyn *key = dc_name_arg(name, "channel");
  if (key == NULL) return;
  if (cb->kind != SCR_DYN_FUNC) {
    dc_throw_bad_subscriber(cb);
    scr_dyn_release(key);
    return;
  }
  /* Intern FIRST: a channel created here may realloc the registry, and a
   * subscript written as dc_channels[dc_intern(...)] may read the old
   * array pointer before the call that frees it. */
  size_t index = dc_intern(key);
  dc_sub_add(&dc_channels[index], cb);
  scr_dyn_release(key);
}

bool scr_dc_unsubscribe(ScrDyn *name, ScrDyn *cb) {
  /* Node validates the name here as channel() does, but answers false for a
   * subscriber that is not a function, and answers false for a never-created
   * channel without creating it; matching an existing list needs no creation
   * either — probe without interning. */
  ScrDyn *key = dc_name_arg(name, "channel");
  if (key == NULL) return false; /* the name's error is pending */
  bool removed = false;
  if (cb->kind == SCR_DYN_FUNC) {
    for (size_t i = 0; i < dc_nchannels; i++) {
      if (dc_name_eq(dc_channels[i].name, key)) {
        removed = dc_sub_remove(&dc_channels[i], cb);
        break;
      }
    }
  }
  scr_dyn_release(key);
  return removed;
}

bool scr_dc_has_subscribers(ScrDyn *name) {
  if (name == NULL || (name->kind != SCR_DYN_STR && name->kind != SCR_DYN_SYMBOL)) return false;
  for (size_t i = 0; i < dc_nchannels; i++) {
    if (dc_name_eq(dc_channels[i].name, name)) return dc_chan_active(&dc_channels[i]);
  }
  return false;
}

/* V8's TypeError for ReflectApply on a value that is not callable — the
 * traced call's check, verbatim (scr_ar_apply_type_error's shape). */
static void dc_throw_apply(const ScrDyn *fn) {
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
    size_t len = scr_f64_to_str(fn->v.num, buf);
    scr_jb_write(&b, buf, len);
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

/* ── bindStore / runStores (the AsyncLocalStorage integration) ─────────
 * bindStore is per-store SET semantics (a re-bind replaces the
 * transform); runStores enters every bound store with transform(data)
 * (identity without a transform), publishes INSIDE the entered contexts
 * (subscribers observe getStore(), Node's shape), runs fn with thisArg
 * bound and the arguments forwarded, and restores in reverse — the
 * finally, so a throw still restores. A transform throw skips its store
 * and surfaces as an uncaught exception on the next tick, as in Node. */

void scr_dc_chan_bind_store(double handle, double als_id, ScrDyn *transform) {
  ScrDcChannel *ch = dc_of(handle);
  /* Node keeps the transform value as given (a non-function one throws when
   * runStores calls it); a falsy one is the identity. */
  ScrDyn *t = (transform != NULL && scr_dyn_truthy(transform)) ? scr_dyn_retain(transform) : NULL;
  for (size_t i = 0; i < ch->nbinds; i++) {
    if (ch->binds[i].als_id == als_id) {
      scr_dyn_release(ch->binds[i].transform);
      ch->binds[i].transform = t;
      return;
    }
  }
  if (ch->nbinds == ch->binds_cap) {
    ch->binds_cap = ch->binds_cap ? ch->binds_cap * 2 : 4;
    ch->binds = realloc(ch->binds, ch->binds_cap * sizeof *ch->binds);
    if (!ch->binds) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  ch->binds[ch->nbinds].als_id = als_id;
  ch->binds[ch->nbinds].transform = t;
  ch->nbinds++;
}

bool scr_dc_chan_unbind_store(double handle, double als_id) {
  ScrDcChannel *ch = dc_of(handle);
  for (size_t i = 0; i < ch->nbinds; i++) {
    if (ch->binds[i].als_id == als_id) {
      scr_dyn_release(ch->binds[i].transform);
      memmove(ch->binds + i, ch->binds + i + 1, (ch->nbinds - i - 1) * sizeof *ch->binds);
      ch->nbinds--;
      return true;
    }
  }
  return false;
}

/* Enter every bound store (transform(data) or data itself); the returned
 * malloc'd array of PREVIOUS snapshots (*n_out entries) restores in
 * reverse. A store whose transform throws is not entered. */
static ScrAlsCtx **dc_stores_enter(ScrDcChannel *ch, ScrDyn *data, size_t *n_out) {
  *n_out = 0;
  if (ch->nbinds == 0) return NULL;
  ScrAlsCtx **prevs = malloc(ch->nbinds * sizeof *prevs);
  if (!prevs) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  for (size_t i = 0; i < ch->nbinds; i++) {
    ScrDyn *value;
    if (ch->binds[i].transform != NULL) {
      ScrDyn *args[1] = {data};
      if (!scr_dyn_is_callable(ch->binds[i].transform)) {
        /* Node calls the stored value, so a non-function answers V8's call
         * TypeError for its own local name; the throw is deferred as a
         * transform throw is. */
        static const char message[] = "transform is not a function";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        dc_defer_pending_throw();
        continue;
      }
      value = scr_dyn_call(ch->binds[i].transform, args, 1, "transform");
      if (value == NULL) {
        dc_defer_pending_throw();
        continue;
      }
    } else {
      value = scr_dyn_retain(data);
    }
    prevs[*n_out] = scr_als_enter(ch->binds[i].als_id, value);
    scr_dyn_release(value);
    (*n_out)++;
  }
  return prevs;
}

static void dc_stores_restore(ScrAlsCtx **prevs, size_t n) {
  if (prevs == NULL) return;
  for (size_t i = n; i > 0; i--) scr_als_restore(prevs[i - 1]);
  free(prevs);
}

ScrDyn *scr_dc_chan_run_stores(double handle, ScrDyn *data, ScrDyn *fn, ScrDyn *this_arg,
                               ScrDyn *args) {
  ScrDcChannel *ch = dc_of(handle);
  size_t entered = 0;
  ScrAlsCtx **prevs = dc_stores_enter(ch, data, &entered);
  scr_dc_publish(handle, data);
  ScrDyn *r = NULL;
  if (!scr_exc_pending()) {
    size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
    ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
    if (!scr_dyn_is_callable(fn)) {
      dc_throw_apply(fn);
    } else {
      scr_dyn_this_push_dyn(this_arg);
      r = scr_dyn_call(fn, items, argc, "runStores");
      scr_dyn_this_pop();
    }
  }
  dc_stores_restore(prevs, entered);
  return r;
}

/* ── TracingChannel ────────────────────────────────────────────────────
 * A registry entry of five channel indexes (start/end/asyncStart/asyncEnd/
 * error), handled as a 1-based f64 like Channel. The trace choreography
 * lives here in C over the checked-dynamic tree: publishes stash the pending traced-call /
 * subscriber exception in a ScrCaught box first (compiled subscriber
 * bodies run with a CLEAR cell — a pending flag would unwind them at
 * their first call) and re-raise after, so throws propagate exactly like
 * scr_dc_publish's documented divergence. */

typedef struct {
  size_t ch[5]; /* dc_channels indexes: start, end, asyncStart, asyncEnd, error */
} ScrDcTracing;

enum { DC_TC_START, DC_TC_END, DC_TC_ASYNC_START, DC_TC_ASYNC_END, DC_TC_ERROR };

static const char *const dc_trace_events[5] = {"start", "end", "asyncStart", "asyncEnd", "error"};

static SCR_TL ScrDcTracing *dc_tracings = NULL;
static SCR_TL size_t dc_ntracings = 0, dc_tracings_cap = 0;
static SCR_TL bool dc_tracings_teardown_registered = false;

static void scr_dc_tracings_teardown(void) {
  free(dc_tracings);
  dc_tracings = NULL;
  dc_ntracings = dc_tracings_cap = 0;
}

static double dc_tracing_register(const size_t ch[5]) {
  if (dc_ntracings == dc_tracings_cap) {
    dc_tracings_cap = dc_tracings_cap ? dc_tracings_cap * 2 : 4;
    dc_tracings = realloc(dc_tracings, dc_tracings_cap * sizeof *dc_tracings);
    if (!dc_tracings) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
  }
  if (!dc_tracings_teardown_registered) {
    dc_tracings_teardown_registered = true;
    scr_atexit(scr_dc_tracings_teardown);
  }
  for (size_t i = 0; i < 5; i++) dc_tracings[dc_ntracings].ch[i] = ch[i];
  dc_ntracings++;
  return (double)dc_ntracings;
}

static ScrDcTracing *dc_tc_of(double handle) {
  size_t i = (size_t)handle;
  if (i < 1 || i > dc_ntracings) {
    fputs("scriptc: invalid tracingChannel handle\n", stderr);
    abort();
  }
  return &dc_tracings[i - 1];
}

static bool dc_handle_valid(double h);

/* Node's TraceChannel collection form: the five event members must be
 * Channel instances. Our Channel values are handles, so a safe integer
 * naming a registered channel is one; a missing member answers the object
 * conversion TypeError Node's destructuring raises first. */
static double dc_tracing_from_collection(ScrDyn *name) {
  double h[5];
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *v = scr_dyn_obj_get(name, dc_trace_events[i], strlen(dc_trace_events[i]));
    if (v == NULL) {
      if (scr_exc_pending()) return NAN; /* the read threw */
      /* An absent member reads as undefined, which the collection check
       * refuses (Node's check runs before any handle exists); returning
       * an unset NaN here would hand the program an invalid handle. */
      static const char message[] = "Cannot convert undefined or null to object";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NAN;
    }
    if (v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) {
      static const char message[] = "Cannot convert undefined or null to object";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NAN;
    }
    if (v->kind != SCR_DYN_NUM || !dc_handle_valid(v->v.num)) {
      char member[32];
      snprintf(member, sizeof member, "nameOrChannels.%s", dc_trace_events[i]);
      dc_throw_arg_type("an instance of Channel", member, v);
      return NAN;
    }
    /* One read per member: the value is taken here, so a getter that
     * changes the object between reads cannot substitute a handle. */
    h[i] = v->v.num;
  }
  return scr_dc_tracing_channel_of(h[0], h[1], h[2], h[3], h[4]);
}

double scr_dc_tracing_channel(ScrDyn *name) {
  if (name != NULL && name->kind == SCR_DYN_OBJ) return dc_tracing_from_collection(name);
  /* Node's tracing names are strings only: a symbol is not a string or a
   * collection, so it answers the nameOrChannels argument error. */
  if (name == NULL || name->kind != SCR_DYN_STR) {
    dc_throw_arg_type("of type string or an instance of TracingChannel or Object", "nameOrChannels",
                      name);
    return NAN;
  }
  ScrStr *text = scr_str_retain(name->v.str);
  size_t ch[5];
  for (size_t i = 0; i < 5; i++) {
    /* "tracing:<name>:<event>" */
    size_t evlen = strlen(dc_trace_events[i]);
    size_t len = 8 + text->len + 1 + evlen;
    char *buf = malloc(len + 1);
    if (!buf) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
    memcpy(buf, "tracing:", 8);
    memcpy(buf + 8, text->data, text->len);
    buf[8 + text->len] = ':';
    memcpy(buf + 8 + text->len + 1, dc_trace_events[i], evlen);
    buf[len] = '\0';
    ScrStr *s = scr_str_new(buf, len);
    free(buf);
    ScrDyn *key = scr_dyn_new_str(s);
    scr_str_release(s);
    ch[i] = dc_intern(key);
    scr_dyn_release(key);
  }
  scr_str_release(text);
  return dc_tracing_register(ch);
}

/* Whether `h` is one of this registry's channel handles (compiled code
 * only holds minted ones, but a collection object can carry any number). */
static bool dc_handle_valid(double h) {
  size_t i = (size_t)h;
  return h >= 1 && (double)i == h && i <= dc_nchannels;
}

/* Node's check on a TracingChannel collection member: each event must be a
 * Channel. Compiled code holds handles minted by dc_intern, but a value
 * asserted past the type reaches this constructor as a bare number, and a
 * number that is no channel handle must not index the table (dc_of would
 * end the process). */
static void dc_throw_bad_tracing_member(const char *event, double handle) {
  char received[48];
  if (handle == handle)
    snprintf(received, sizeof received, "type number (%g)", handle);
  else
    snprintf(received, sizeof received, "type number (NaN)");
  char buf[192];
  int n = snprintf(buf, sizeof buf,
                   "The \"nameOrChannels.%s\" property must be an instance of Channel. Received %s",
                   event, received);
  scr_throw_error_msg_code(SCR_ERR_TYPE, buf, (size_t)n, "ERR_INVALID_ARG_TYPE");
}

double scr_dc_tracing_channel_of(double start, double end, double async_start,
                                  double async_end, double error) {
  const double members[5] = {start, end, async_start, async_end, error};
  size_t ch[5];
  for (int i = 0; i < 5; i++) {
    double handle = members[i];
    if (!dc_handle_valid(handle)) {
      dc_throw_bad_tracing_member(dc_trace_events[i], handle);
      return 0;
    }
    ch[i] = (size_t)handle - 1;
  }
  return dc_tracing_register(ch);
}

double scr_dc_tc_channel(double h, double idx) {
  ScrDcTracing *tc = dc_tc_of(h);
  size_t i = (size_t)idx;
  if (i > 4) {
    fputs("scriptc: invalid tracingChannel event index\n", stderr);
    abort();
  }
  return (double)(tc->ch[i] + 1);
}

bool scr_dc_tc_has_subscribers(double h) {
  ScrDcTracing *tc = dc_tc_of(h);
  for (size_t i = 0; i < 5; i++) {
    if (dc_chan_active(&dc_channels[tc->ch[i]])) return true;
  }
  return false;
}

/* Node's subscribe(subscribers) destructures the object first, so a
 * null/undefined one raises the property read for its first member. */
static bool dc_tc_handlers_object(const ScrDyn *handlers) {
  if (handlers != NULL && handlers->kind != SCR_DYN_UNDEF && handlers->kind != SCR_DYN_NULL)
    return true;
  static const char undef_message[] = "Cannot read properties of undefined (reading 'start')";
  static const char null_message[] = "Cannot read properties of null (reading 'start')";
  if (handlers != NULL && handlers->kind == SCR_DYN_NULL)
    scr_throw_error_msg(SCR_ERR_TYPE, null_message, sizeof null_message - 1);
  else
    scr_throw_error_msg(SCR_ERR_TYPE, undef_message, sizeof undef_message - 1);
  return false;
}

void scr_dc_tc_subscribe(double h, ScrDyn *handlers) {
  ScrDcTracing *tc = dc_tc_of(h);
  if (!dc_tc_handlers_object(handlers)) return;
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *cb = scr_dyn_obj_get(handlers, dc_trace_events[i], strlen(dc_trace_events[i]));
    if (cb == NULL || !scr_dyn_truthy(cb)) continue; /* falsy slots skip, Node */
    scr_dc_chan_subscribe((double)(tc->ch[i] + 1), cb);
    if (scr_exc_pending()) return; /* a non-function slot threw */
  }
}

bool scr_dc_tc_unsubscribe(double h, ScrDyn *handlers) {
  ScrDcTracing *tc = dc_tc_of(h);
  if (!dc_tc_handlers_object(handlers)) return false;
  bool done = true;
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *cb = scr_dyn_obj_get(handlers, dc_trace_events[i], strlen(dc_trace_events[i]));
    if (cb == NULL || !scr_dyn_truthy(cb)) continue;
    if (!scr_dc_chan_unsubscribe((double)(tc->ch[i] + 1), cb)) done = false;
    if (scr_exc_pending()) return false;
  }
  return done;
}

/* The pending exception as a dyn value for ctx.error: scr_caught_to_dyn
 * (scr_json.c) — identity-preserving for dyn payloads and %Error
 * instances (the identity-cached crossing: the stamped ctx.error compares
 * reference-equal to the thrown error's other boxings). */

/* publish while an exception snapshot is parked: the cell is already
 * clear (scr_exc_take), subscribers run normally; a SUBSCRIBER throw
 * replaces the parked one (JS's finally-throw rule) — the caller checks
 * pending after. */
static void dc_tc_publish(ScrDcTracing *tc, int ev, ScrDyn *ctx) {
  scr_dc_publish((double)(tc->ch[ev] + 1), ctx);
}

/* The traced call: thisArg bound as the ambient receiver. Result +1 or
 * NULL with the exception pending. */
static ScrDyn *dc_tc_apply(ScrDyn *fn, ScrDyn *this_arg, ScrDyn *const *items, size_t n,
                            const char *what) {
  (void)what;
  if (!scr_dyn_is_callable(fn)) {
    dc_throw_apply(fn);
    return NULL;
  }
  scr_dyn_this_push_dyn(this_arg);
  ScrDyn *r = scr_dyn_call(fn, items, n, "trace");
  scr_dyn_this_pop();
  return r;
}

/* The choreography body, run inside the start channel's entered stores
 * (start.runStores — Node wraps the WHOLE body: the start publish, the
 * traced call, and the finally end publish). */
static ScrDyn *dc_tc_trace_sync_body(ScrDcTracing *tc, ScrDyn *fn, ScrDyn *ctx,
                                     ScrDyn *this_arg, ScrDyn *const *items, size_t argc) {
  dc_tc_publish(tc, DC_TC_START, ctx);
  if (scr_exc_pending()) return NULL;
  ScrDyn *r = dc_tc_apply(fn, this_arg, items, argc, "traceSync");
  if (r == NULL) {
    /* context.error = err; error.publish; end.publish (finally); rethrow */
    ScrCaught *c = scr_exc_take();
    if (ctx->kind == SCR_DYN_OBJ) scr_dyn_obj_set(ctx, "error", 5, scr_caught_to_dyn(c));
    dc_tc_publish(tc, DC_TC_ERROR, ctx);
    if (!scr_exc_pending()) dc_tc_publish(tc, DC_TC_END, ctx);
    if (!scr_exc_pending()) scr_rethrow(c);
    scr_caught_release(c);
    return NULL;
  }
  /* context.result = result; end.publish (finally); return result */
  if (ctx->kind == SCR_DYN_OBJ) scr_dyn_obj_set(ctx, "result", 6, scr_dyn_retain(r));
  dc_tc_publish(tc, DC_TC_END, ctx);
  if (scr_exc_pending()) {
    scr_dyn_release(r);
    return NULL;
  }
  return r;
}

ScrDyn *scr_dc_tc_trace_sync(double h, ScrDyn *fn, ScrDyn *ctx, ScrDyn *this_arg, ScrDyn *args) {
  ScrDcTracing *tc = dc_tc_of(h);
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  if (!scr_dc_tc_has_subscribers(h)) {
    return dc_tc_apply(fn, this_arg, items, argc, "traceSync");
  }
  /* start.runStores: the body runs inside the start channel's stores. */
  size_t entered = 0;
  ScrAlsCtx **prevs = dc_stores_enter(&dc_channels[tc->ch[DC_TC_START]], ctx, &entered);
  ScrDyn *r = scr_exc_pending() ? NULL
                                : dc_tc_trace_sync_body(tc, fn, ctx, this_arg, items, argc);
  dc_stores_restore(prevs, entered);
  return r;
}

/* ── tracePromise ──────────────────────────────────────────────────────
 * Node's choreography: start.runStores(ctx, body) where body calls the
 * traced fn, wraps a non-promise result in a resolved promise, registers
 * the resolve/reject reactions, and publishes end in the finally. The
 * reactions run one microtask later: resolve stamps ctx.result and
 * publishes asyncStart + asyncEnd (plain publishes — promises have no
 * "after" point for a runStores, Node's comment); reject stamps
 * ctx.error, publishes error then asyncStart + asyncEnd, and passes the
 * rejection through. The returned promise is the REACTION's (a rejection
 * nobody observes is the unhandled one, exactly Node's then-chain). A
 * reaction fiber provides the microtask ordering without extra code. */
typedef struct {
  ScrPromise *src, *dst; /* owned */
  double h;
  ScrDyn *ctx; /* owned */
} DcTracePromisePack;

static void dc_tp_entry(ScrFiber *self, void *ap) {
  (void)self;
  DcTracePromisePack *a = (DcTracePromisePack *)ap;
  ScrDcTracing *tc = dc_tc_of(a->h);
  ScrDyn *v = scr_await_dyn(a->src);
  if (scr_exc_pending()) {
    ScrCaught *c = scr_exc_take();
    if (a->ctx->kind == SCR_DYN_OBJ) scr_dyn_obj_set(a->ctx, "error", 5, scr_caught_to_dyn(c));
    dc_tc_publish(tc, DC_TC_ERROR, a->ctx);
    if (!scr_exc_pending()) dc_tc_publish(tc, DC_TC_ASYNC_START, a->ctx);
    if (!scr_exc_pending()) dc_tc_publish(tc, DC_TC_ASYNC_END, a->ctx);
    /* A subscriber throw replaced the parked rejection (the finally-throw
     * rule; Node routes it to triggerUncaughtException) — either way the
     * pending exception is what dst rejects with. */
    if (!scr_exc_pending()) scr_rethrow(c);
    scr_promise_reject_pending(a->dst);
    scr_caught_release(c);
  } else {
    if (a->ctx->kind == SCR_DYN_OBJ) scr_dyn_obj_set(a->ctx, "result", 6, scr_dyn_retain(v));
    dc_tc_publish(tc, DC_TC_ASYNC_START, a->ctx);
    if (!scr_exc_pending()) dc_tc_publish(tc, DC_TC_ASYNC_END, a->ctx);
    if (scr_exc_pending()) {
      scr_promise_reject_pending(a->dst); /* the subscriber throw */
      scr_dyn_release(v);
    } else {
      scr_promise_fulfill_ref(a->dst, v, scr_dyn_retain_v, scr_dyn_release_v, NULL);
    }
  }
  scr_dyn_release(a->ctx);
  scr_promise_release(a->src);
  scr_promise_release(a->dst);
  free(a);
}

/* The traced result as a promise (+1): a dyn promise unwraps, anything
 * else is PromiseResolve'd (Node converts non-promise returns; a raw
 * non-promise return on the NO-SUBSCRIBER path wraps too — the lowering
 * types the result Promise<unknown>, a wrap Node skips, SEMANTICS.md). */
static ScrPromise *dc_tp_promise_of(ScrDyn *r) {
  ScrPromise *p = scr_dyn_promise_of(r);
  if (p != NULL) return scr_promise_retain(p);
  ScrPromise *fresh = scr_promise_new();
  scr_promise_fulfill_ref(fresh, scr_dyn_retain(r), scr_dyn_retain_v, scr_dyn_release_v, NULL);
  return fresh;
}

ScrPromise *scr_dc_tc_trace_promise(double h, ScrDyn *fn, ScrDyn *ctx, ScrDyn *this_arg,
                                     ScrDyn *args) {
  ScrDcTracing *tc = dc_tc_of(h);
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  if (!scr_dc_tc_has_subscribers(h)) {
    ScrDyn *r = dc_tc_apply(fn, this_arg, items, argc, "tracePromise");
    if (r == NULL) return NULL;
    ScrPromise *p = dc_tp_promise_of(r);
    scr_dyn_release(r);
    return p;
  }
  /* start.runStores: the start publish, the traced call, the reaction
   * registration, and the finally end publish run inside the start
   * channel's entered stores — the traced async body's fiber INHERITS
   * them at spawn, so getStore() inside the traced function answers
   * across its awaits (the run-stores suite's shape). The reactions
   * publish OUTSIDE any store (promises have no "after" runStores point,
   * Node's comment). */
  size_t entered = 0;
  ScrAlsCtx **prevs = dc_stores_enter(&dc_channels[tc->ch[DC_TC_START]], ctx, &entered);
  ScrPromise *out = NULL;
  if (!scr_exc_pending()) {
    dc_tc_publish(tc, DC_TC_START, ctx);
    if (!scr_exc_pending()) {
      ScrDyn *r = dc_tc_apply(fn, this_arg, items, argc, "tracePromise");
      if (r == NULL) {
        /* ctx.error = err; error.publish; end.publish (finally); rethrow */
        ScrCaught *c = scr_exc_take();
        if (ctx->kind == SCR_DYN_OBJ) scr_dyn_obj_set(ctx, "error", 5, scr_caught_to_dyn(c));
        dc_tc_publish(tc, DC_TC_ERROR, ctx);
        if (!scr_exc_pending()) dc_tc_publish(tc, DC_TC_END, ctx);
        if (!scr_exc_pending()) scr_rethrow(c);
        scr_caught_release(c);
      } else {
        ScrPromise *src = dc_tp_promise_of(r);
        scr_dyn_release(r);
        DcTracePromisePack *a = malloc(sizeof *a);
        if (!a) {
          fputs("scriptc: out of memory\n", stderr);
          abort();
        }
        a->src = src; /* the +1 moves in */
        a->dst = scr_promise_new();
        a->h = h;
        a->ctx = scr_dyn_retain(ctx);
        out = scr_promise_retain(a->dst);
        ScrPromise *waiter = scr_async_spawn(dc_tp_entry, a);
        scr_promise_release(waiter); /* the entry never rejects; nobody awaits it */
        dc_tc_publish(tc, DC_TC_END, ctx); /* finally */
        if (scr_exc_pending()) {
          scr_promise_release(out);
          out = NULL;
        }
      }
    }
  }
  dc_stores_restore(prevs, entered);
  return out;
}

/* traceCallback's wrapped callback: caps[0] = the tracing handle (f64),
 * caps[1] = ctx (dyn), caps[2] = the original callback (dyn). Publishes
 * error/result off the (err, res) convention, then asyncStart, runs the
 * original with the ambient receiver and ALL arguments forwarded, then
 * asyncEnd (finally — also on a callback throw). */
static ScrDyn *dc_tc_wrapped_cb(ScrClosure *clo, ScrDyn *const *cbargs, size_t cbargc) {
  double h = scr_box_get_f64(clo->caps[0]);
  ScrDcTracing *tc = dc_tc_of(h);
  ScrDyn *ctx = scr_box_get_ref(clo->caps[1]);
  ScrDyn *cb = scr_box_get_ref(clo->caps[2]);
  ScrDyn *err = cbargc >= 1 ? cbargs[0] : NULL;
  if (err != NULL && scr_dyn_truthy(err)) {
    if (ctx->kind == SCR_DYN_OBJ) scr_dyn_obj_set(ctx, "error", 5, scr_dyn_retain(err));
    dc_tc_publish(tc, DC_TC_ERROR, ctx);
  } else if (ctx->kind == SCR_DYN_OBJ) {
    ScrDyn *res = cbargc >= 2 ? scr_dyn_retain(cbargs[1]) : scr_dyn_undefined();
    scr_dyn_obj_set(ctx, "result", 6, res);
  }
  ScrDyn *r = NULL;
  if (!scr_exc_pending()) {
    /* asyncStart.runStores: the asyncStart publish, the original
     * callback, and the finally asyncEnd all run inside the asyncStart
     * channel's entered stores (Node's manual context-recovery point). */
    size_t entered = 0;
    ScrAlsCtx **prevs = dc_stores_enter(&dc_channels[tc->ch[DC_TC_ASYNC_START]], ctx, &entered);
    if (!scr_exc_pending()) dc_tc_publish(tc, DC_TC_ASYNC_START, ctx);
    if (!scr_exc_pending()) {
      ScrDyn *this_arg = scr_dyn_this_get();
      scr_dyn_this_push_dyn(this_arg);
      r = scr_dyn_call(cb, cbargs, cbargc, "callback");
      scr_dyn_this_pop();
      scr_dyn_release(this_arg);
      /* finally: asyncEnd fires on the throw path too, exception parked */
      if (r == NULL) {
        ScrCaught *c = scr_exc_take();
        dc_tc_publish(tc, DC_TC_ASYNC_END, ctx);
        if (!scr_exc_pending()) scr_rethrow(c);
        scr_caught_release(c);
      } else {
        dc_tc_publish(tc, DC_TC_ASYNC_END, ctx);
        if (scr_exc_pending()) {
          scr_dyn_release(r);
          r = NULL;
        }
      }
    }
    dc_stores_restore(prevs, entered);
  }
  scr_dyn_release(ctx);
  scr_dyn_release(cb);
  return r;
}

ScrDyn *scr_dc_tc_trace_callback(double h, ScrDyn *fn, double position, ScrDyn *ctx,
                                  ScrDyn *this_arg, ScrDyn *args) {
  ScrDcTracing *tc = dc_tc_of(h);
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = args->kind == SCR_DYN_ARR ? args->v.arr.items : NULL;
  if (!scr_dc_tc_has_subscribers(h)) {
    return dc_tc_apply(fn, this_arg, items, argc, "traceCallback");
  }
  /* args.at(position), JS-style negative indexing */
  double pos = position < 0 ? (double)argc + position : position;
  size_t idx = (size_t)pos;
  ScrDyn *cb = (pos >= 0 && idx < argc) ? items[idx] : NULL;
  if (cb == NULL || cb->kind != SCR_DYN_FUNC) {
    dc_throw_arg_type("of type function", "callback", cb);
    return NULL;
  }
  /* Splice the wrapper in (a fresh argument vector; the dyn array is
   * borrowed and Node's splice mutation is unobservable through it — the
   * caller rebuilt it from the call site's arguments). */
  ScrClosure *clo = scr_closure_new((void *)dc_tc_wrapped_cb, 3);
  clo->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(clo->caps[0], h);
  clo->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[1], scr_dyn_retain(ctx));
  clo->caps[2] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[2], scr_dyn_retain(cb));
  ScrDyn *wrapped = scr_dyn_new_func(clo, dc_tc_wrapped_cb, 2, "(err,res)", "wrappedCallback");
  ScrDyn **call_items = NULL;
  if (argc > 0) {
    call_items = malloc(argc * sizeof *call_items);
    if (!call_items) {
      fputs("scriptc: out of memory\n", stderr);
      abort();
    }
    for (size_t i = 0; i < argc; i++) call_items[i] = i == idx ? wrapped : items[i];
  }
  /* start.runStores: the start publish, the traced call, and the finally
   * end publish run inside the start channel's entered stores. */
  size_t entered = 0;
  ScrAlsCtx **prevs = dc_stores_enter(&dc_channels[tc->ch[DC_TC_START]], ctx, &entered);
  ScrDyn *r = NULL;
  if (!scr_exc_pending()) {
    dc_tc_publish(tc, DC_TC_START, ctx);
    if (!scr_exc_pending()) {
      r = dc_tc_apply(fn, this_arg, call_items, argc, "traceCallback");
      if (r == NULL) {
        ScrCaught *c = scr_exc_take();
        if (ctx->kind == SCR_DYN_OBJ) scr_dyn_obj_set(ctx, "error", 5, scr_caught_to_dyn(c));
        dc_tc_publish(tc, DC_TC_ERROR, ctx);
        if (!scr_exc_pending()) dc_tc_publish(tc, DC_TC_END, ctx);
        if (!scr_exc_pending()) scr_rethrow(c);
        scr_caught_release(c);
      } else {
        /* No result stamping here — the traced fn's return value is not the
         * traced RESULT (the callback's res is; wrappedCallback stamps it). */
        dc_tc_publish(tc, DC_TC_END, ctx); /* finally */
        if (scr_exc_pending()) {
          scr_dyn_release(r);
          r = NULL;
        }
      }
    }
  }
  dc_stores_restore(prevs, entered);
  free(call_items);
  scr_dyn_release(wrapped);
  return r;
}

void scr_dc_publish(double handle, ScrDyn *message) {
  ScrDcChannel *ch = dc_of(handle);
  if (ch->nsubs == 0) return;
  /* Snapshot: subscribe/unsubscribe during dispatch affect LATER
   * publishes only (a self-unsubscribing subscriber's siblings still
   * fire this round). */
  size_t n = ch->nsubs;
  ScrDyn **snap = malloc(n * sizeof *snap);
  if (!snap) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  for (size_t i = 0; i < n; i++) snap[i] = scr_dyn_retain(ch->subs[i]);
  ScrDyn *namev = scr_dyn_retain(ch->name);
  for (size_t i = 0; i < n; i++) {
    ScrDyn *args[2] = {message, namev};
    ScrDyn *r = scr_dyn_call(snap[i], args, 2, "onMessage");
    if (r == NULL) dc_defer_pending_throw();
    else scr_dyn_release(r);
  }
  scr_dyn_release(namev);
  for (size_t i = 0; i < n; i++) scr_dyn_release(snap[i]);
  free(snap);
}

/* ── the console channels ────────────────────────────────────────────
 * Node's global console publishes each output member's own argument array
 * on console.<member> before it writes the line, when the channel has
 * subscribers. The console unit hands that array here
 * (the console unit's publisher slot); every argument type is already a
 * checked-dynamic value, so the message is the call's array unchanged. */
static const char *const dc_console_channels[5] = {"console.log", "console.info", "console.debug",
                                                   "console.warn", "console.error"};

bool scr_dc_console_active(double member) {
  int index = (int)member;
  if (member != (double)index || index < 0 || index > 4) return false;
  const char *name = dc_console_channels[index];
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrDyn *key = scr_dyn_new_str(text);
  scr_str_release(text);
  bool active = scr_dc_has_subscribers(key);
  scr_dyn_release(key);
  return active;
}

void scr_dc_console_emit_args(double member, ScrDyn *args) {
  int index = (int)member;
  if (member != (double)index || index < 0 || index > 4 || args == NULL) return;
  const char *name = dc_console_channels[index];
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrDyn *key = scr_dyn_new_str(text);
  scr_str_release(text);
  if (!scr_dc_has_subscribers(key)) {
    scr_dyn_release(key);
    return;
  }
  double handle = scr_dc_channel(key);
  scr_dyn_release(key);
  if (handle != handle) return; /* an exception is pending; the line still writes */
  scr_dc_publish(handle, args);
}
