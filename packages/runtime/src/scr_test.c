/* node:test — the in-process test runner (linked only when the program
 * imports node:test; native-toolchain.ts gates on moduleUsesNodeTest like dgram/net).
 *
 * Registration (test/it/describe/suite/hooks) builds a tree under an
 * implicit root while the module bodies run: describe callbacks execute
 * IMMEDIATELY at registration (Node runs suite bodies during collection),
 * test callbacks are stored. The FIRST registration spawns the runner
 * fiber, whose first act is one microtask hop (scr_await_hop) — so it
 * parks on the ready queue and runs only after main returns and
 * scr_loop_run drains microtasks: Node's "tests start after the file's
 * synchronous body completes" scheduling, ahead of any main-registered
 * timers. Tests run SEQUENTIALLY on that fiber (Node's default
 * concurrency 1): sync bodies are called directly (the fiber's own
 * exception cell isolates their throws), async bodies run via their spawn
 * wrappers and the runner awaits the promise — timers/io inside test
 * bodies interleave through the ordinary loop while the runner is parked.
 *
 * Reporting reproduces Node v24's SPEC reporter (the default on every
 * stream since v20 made it universal): ✔/✖/﹣/⚠ result lines with
 * per-test durations, # SKIP/# TODO directives, ▶ suite headers printed
 * lazily when the first child reports, the ℹ summary block, and the
 * "✖ failing tests:" section (test-at location, result line, the error
 * message indented two spaces — no stack frames: the harness strips
 * Node's, SEMANTICS.md numbers the divergence). Durations are real
 * elapsed milliseconds and thus NONDETERMINISTIC — the differential
 * harness normalizes them on both lanes; the suite runner only reads
 * exit codes. One deliberate divergence: reporter lines write to stdout
 * synchronously as results land, where Node's reporter stream lags
 * console output racily — programs that interleave console.log with the
 * reporter cannot be byte-compared under Node itself.
 *
 * Exit code: main asks scr_test_exit_code() after the loop drains —
 * 1 when any non-todo test failed (todo failures print ⚠ and list in the
 * failing section but exit 0, Node's contract), else 0. */
#include "scr_platform.h"
#include "scr_runtime.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef _WIN32
#include <unistd.h>
#else
#include <direct.h>
#define getcwd _getcwd
#endif

static void scr_test_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* mode values (the frontend's literals) */
enum { SCR_TEST_RUN = 0, SCR_TEST_SKIP = 1, SCR_TEST_TODO = 2 };
/* flags bitmask */
enum {
  SCR_TEST_F_ASYNC = 1,
  SCR_TEST_F_CTX = 2,
  SCR_TEST_F_ONLY = 4,
  SCR_TEST_F_TIMEOUT = 8,
  SCR_TEST_F_CONCURRENCY = 16,
};
/* hook kinds */
enum { SCR_HOOK_BEFORE = 0, SCR_HOOK_AFTER = 1, SCR_HOOK_BEFORE_EACH = 2, SCR_HOOK_AFTER_EACH = 3 };
/* outcome states */
enum {
  SCR_TS_PENDING = 0,
  SCR_TS_PASS,
  SCR_TS_FAIL,      /* own body threw (or a hook failed it) */
  SCR_TS_CHILDFAIL, /* own body passed; a descendant failed */
  SCR_TS_SKIPPED,
  SCR_TS_TODO_PASS,
  SCR_TS_TODO_FAIL,
  SCR_TS_CANCELLED, /* { timeout } elapsed before the body settled */
};

typedef struct {
  ScrClosure *cb;
  int flags;
  ScrStr *at; /* "file:line:col" of the hook call, owned; NULL for t.* hooks */
} ScrTestHook;

typedef struct {
  ScrTestHook *v;
  size_t n, cap;
} ScrTestHooks;

struct ScrTestCtx {
  size_t rc;
  ScrStr *name; /* owned */
  ScrStr *msg;  /* directive message, owned; NULL = bare SKIP/TODO */
  ScrStr *at;   /* "file:line:col" (absolute file), owned; NULL for suites */
  ScrClosure *cb; /* owned; NULL = fn-less test (Node: counts as pass) */
  int mode;
  int flags;
  bool is_suite;
  int state;
  bool started_line; /* the "▶ name" header printed */
  double dur_ms;
  ScrCaught *err;      /* owned; the own-body failure payload */
  ScrStr **diags;      /* owned t.diagnostic strings, printed after the line */
  size_t ndiags, dcap;
  struct ScrTestCtx *parent; /* borrowed back-edge */
  struct ScrTestCtx **children; /* owned refs */
  size_t nchildren, ccap;
  ScrTestHooks hooks[4]; /* suites and root; tests through t.after/t.beforeEach/t.afterEach */
  ScrCaught *before_err; /* owned; a throwing t.before, which fails the test and later subtests */
  int plan;              /* t.plan count, -1 without a plan */
  int plan_count;        /* t.assert calls and subtests counted against the plan */
  ScrTestHooks mocks;    /* t.mock: the restore closure of each mock, in creation order */
  double timeout;        /* { timeout } in ms, INFINITY without one */
  bool timed_out;        /* the async body was still pending when the timeout elapsed */
  /* { concurrency }: how many subtests run at once (1 runs them in order),
   * the parent's value without the option. Above 1, each subtest runs on
   * its own fiber, started in order as slots free up. */
  double concurrency;
  int active;          /* subtests running on their own fibers */
  bool queued;         /* waiting for a free slot under the parent's concurrency */
  bool on_fiber;       /* started on its own fiber by a concurrent parent */
  ScrPromise *done;    /* owned; settles when a concurrent subtest finishes */
  ScrPromise *slot;    /* owned; the parent waiting for its next subtest to finish */
  struct ScrMockTimers *mock_timers; /* t.mock.timers, made on first use; freed at exit */
  bool passed; /* t.passed: set when the body passes, as Node's pass() does */
  bool listed; /* a suite listed in the failing section (a failing root before) */
  double start_ms; /* when the test started running; NaN before */
  size_t serial; /* index in scr_test_nodes, getTestContext()'s handle */
};

static SCR_TL ScrTestCtx *scr_test_root = NULL;
/* Where registrations attach: the suite body being collected or the test
 * currently running (its nested test()/t.test() calls are subtests). */
static SCR_TL ScrTestCtx *scr_test_reg_parent = NULL;
static SCR_TL bool scr_test_runner_spawned = false;
static SCR_TL bool scr_test_run_done = false;
static SCR_TL long scr_test_ct_tests = 0, scr_test_ct_suites = 0, scr_test_ct_pass = 0,
            scr_test_ct_fail = 0, scr_test_ct_cancelled = 0, scr_test_ct_skipped = 0,
            scr_test_ct_todo = 0;
static SCR_TL double scr_test_t0 = 0;
static SCR_TL bool scr_test_suite_hook_failed = false;
/* The promises of async module-level before hooks, which the runner waits
 * for before the first top-level test. */
static SCR_TL ScrPromise **scr_test_root_pending = NULL;
static SCR_TL size_t scr_test_root_npending = 0, scr_test_root_pending_cap = 0;

/* A module-level before hook threw or rejected: the first failure is kept
 * for the top-level tests and suites, later ones are dropped. */
static void scr_test_root_before_failed(ScrTestCtx *root) {
  if (!scr_exc_pending()) return;
  if (!root->before_err) root->before_err = scr_exc_take();
  else scr_exc_clear();
}
/* Above 0 while subtests run concurrently: result lines are held, and the
 * outermost concurrent parent prints its subtrees in declaration order,
 * as Node's reporter does, once they all finish. */
static SCR_TL int scr_test_defer = 0;

/* Where a concurrent subtest's fiber registers: each fiber started by a
 * concurrent parent has its own registration parent, which its nested
 * test() calls and hooks attach to. Other code uses scr_test_reg_parent. */
typedef struct {
  void *fiber;
  ScrTestCtx *parent;
} ScrTestFiberParent;
static SCR_TL ScrTestFiberParent *scr_test_fibers = NULL;
static SCR_TL size_t scr_test_nfibers = 0, scr_test_fibers_cap = 0;
/* The module's `mock` tracker: the restore closure of each mock it made. */
static SCR_TL ScrTestHooks scr_test_mocks = {0};

/* getTestContext(): the test, suite or hook owner whose code is running
 * rides the AsyncLocalStorage snapshot under a reserved store id
 * (AsyncLocalStorage ids are positive), so it follows a body across its
 * awaits and into the async functions it calls, as Node's async context
 * does. The entry holds the node's serial, an index in scr_test_nodes
 * (borrowed pointers, cleared when a node is freed), so a snapshot that
 * outlives its node answers undefined instead of a freed node. */
#define SCR_TEST_SCOPE_ID (-1.0)
static SCR_TL ScrTestCtx **scr_test_nodes = NULL;
static SCR_TL size_t scr_test_nnodes = 0, scr_test_nodes_cap = 0, scr_test_nodes_live = 0;

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_testctx_live = 0;
long scr_testctx_live_count(void) { return scr_testctx_live; }
#endif

ScrTestCtx *scr_testctx_retain(ScrTestCtx *t) {
  if (t) t->rc++;
  return t;
}

static void scr_test_hooks_free(ScrTestHooks *h) {
  for (size_t i = 0; i < h->n; i++) {
    scr_closure_release(h->v[i].cb);
    scr_str_release(h->v[i].at);
  }
  free(h->v);
  h->v = NULL;
  h->n = h->cap = 0;
}

void scr_testctx_release(ScrTestCtx *t) {
  if (!t || --t->rc > 0) return;
  scr_str_release(t->name);
  scr_str_release(t->msg);
  scr_str_release(t->at);
  scr_closure_release(t->cb);
  scr_caught_release(t->err);
  scr_caught_release(t->before_err);
  scr_promise_release(t->done);
  scr_promise_release(t->slot);
  for (size_t i = 0; i < t->ndiags; i++) scr_str_release(t->diags[i]);
  free(t->diags);
  for (size_t i = 0; i < t->nchildren; i++) scr_testctx_release(t->children[i]);
  free(t->children);
  for (int k = 0; k < 4; k++) scr_test_hooks_free(&t->hooks[k]);
  scr_test_hooks_free(&t->mocks);
  scr_test_nodes[t->serial] = NULL;
  if (--scr_test_nodes_live == 0) {
    free(scr_test_nodes);
    scr_test_nodes = NULL;
    scr_test_nnodes = scr_test_nodes_cap = 0;
  }
#ifdef SCR_RC_AUDIT
  scr_testctx_live--;
#endif
  free(t);
}

void *scr_testctx_retain_v(void *t) { return scr_testctx_retain(t); }
void scr_testctx_release_v(void *t) { scr_testctx_release(t); }

static ScrTestCtx *scr_test_node_new(ScrStr *name /*borrowed*/, int mode,
                                      ScrStr *msg /*borrowed, may be empty*/,
                                      ScrClosure *cb /*moves, may be NULL*/,
                                      int flags, ScrStr *at /*borrowed, may be NULL*/,
                                      bool is_suite) {
  ScrTestCtx *t = calloc(1, sizeof *t);
  if (!t) scr_test_oom();
  t->rc = 1;
  t->name = name ? scr_str_retain(name) : NULL;
  t->msg = (msg && msg->len > 0) ? scr_str_retain(msg) : NULL;
  t->at = (at && at->len > 0) ? scr_str_retain(at) : NULL;
  t->cb = cb;
  t->mode = mode;
  t->flags = flags;
  t->is_suite = is_suite;
  t->plan = -1;
  t->timeout = INFINITY;
  t->concurrency = 1;
  t->start_ms = NAN;
  if (scr_test_nnodes == scr_test_nodes_cap) {
    scr_test_nodes_cap = scr_test_nodes_cap ? scr_test_nodes_cap * 2 : 16;
    scr_test_nodes = realloc(scr_test_nodes, scr_test_nodes_cap * sizeof *scr_test_nodes);
    if (!scr_test_nodes) scr_test_oom();
  }
  t->serial = scr_test_nnodes;
  scr_test_nodes[scr_test_nnodes++] = t;
  scr_test_nodes_live++;
#ifdef SCR_RC_AUDIT
  scr_testctx_live++;
#endif
  return t;
}

/* Makes `t` the node getTestContext() answers, until the matching
 * scr_test_scope_leave. Returns the previous snapshot. */
static ScrAlsCtx *scr_test_scope_enter(ScrTestCtx *t) {
  ScrDyn *serial = scr_dyn_new_num((double)t->serial);
  ScrAlsCtx *prev = scr_als_enter(SCR_TEST_SCOPE_ID, serial);
  scr_dyn_release(serial);
  return prev;
}

static void scr_test_scope_leave(ScrAlsCtx *prev /*moves*/) { scr_als_restore(prev); }

/* The node getTestContext() answers (borrowed), or NULL. */
static ScrTestCtx *scr_test_scope_node(void) {
  ScrDyn *serial = scr_als_peek(SCR_TEST_SCOPE_ID);
  if (!serial || serial->kind != SCR_DYN_NUM) return NULL;
  size_t i = (size_t)serial->v.num;
  return i < scr_test_nnodes ? scr_test_nodes[i] : NULL;
}

bool scr_test_has_context(void) { return scr_test_scope_node() != NULL; }

ScrTestCtx *scr_test_context(void) { return scr_testctx_retain(scr_test_scope_node()); }

static void scr_test_child_add(ScrTestCtx *parent, ScrTestCtx *child /*moves*/) {
  if (parent->nchildren == parent->ccap) {
    parent->ccap = parent->ccap ? parent->ccap * 2 : 4;
    parent->children = realloc(parent->children, parent->ccap * sizeof *parent->children);
    if (!parent->children) scr_test_oom();
  }
  child->parent = parent;
  /* Node's todo inheritance: tests and suites under a todo suite or test
   * are todo themselves, with a bare TODO directive, unless they carry
   * their own skip or todo. */
  if (child->mode == SCR_TEST_RUN && parent->mode == SCR_TEST_TODO) child->mode = SCR_TEST_TODO;
  /* Subtests inherit the parent's concurrency unless they set their own. */
  if (!(child->flags & SCR_TEST_F_CONCURRENCY)) child->concurrency = parent->concurrency;
  parent->children[parent->nchildren++] = child;
}

static ScrTestFiberParent *scr_test_fiber_slot(void) {
  if (scr_test_nfibers == 0) return NULL;
  void *self = scr_fiber_self();
  for (size_t i = 0; i < scr_test_nfibers; i++) {
    if (scr_test_fibers[i].fiber == self) return &scr_test_fibers[i];
  }
  return NULL;
}

static ScrTestCtx *scr_test_parent_get(void) {
  ScrTestFiberParent *slot = scr_test_fiber_slot();
  return slot ? slot->parent : scr_test_reg_parent;
}

static void scr_test_parent_set(ScrTestCtx *t) {
  ScrTestFiberParent *slot = scr_test_fiber_slot();
  if (slot) slot->parent = t;
  else scr_test_reg_parent = t;
}

static ScrTestCtx *scr_test_ensure_root(void) {
  if (!scr_test_root) {
    scr_test_root = scr_test_node_new(NULL, SCR_TEST_RUN, NULL, NULL, 0, NULL, true);
    scr_test_reg_parent = scr_test_root;
  }
  return scr_test_root;
}

/* ── reporting (Node v24 spec reporter) ──────────────────────────────── */

static int scr_test_depth(const ScrTestCtx *t) {
  int d = 0;
  for (const ScrTestCtx *p = t->parent; p && p->parent; p = p->parent) d++;
  return d;
}

static void scr_test_indent(int depth) {
  for (int i = 0; i < depth; i++) fputs("  ", stdout);
}

/* "(1.234567ms)" — durations print microsecond-rounded (Node's hrtime
 * granularity), not with double noise. */
/* NaN prints nothing: a test cancelled before it started has no duration. */
static void scr_test_print_dur(double ms) {
  if (isnan(ms)) return;
  char num[32];
  fputs(" (", stdout);
  size_t n = scr_f64_to_str(round(ms * 1e6) / 1e6, num);
  fwrite(num, 1, n, stdout);
  fputs("ms)", stdout);
}

static const char *scr_test_symbol(int state) {
  switch (state) {
  case SCR_TS_PASS:
  case SCR_TS_TODO_PASS: return "\xE2\x9C\x94";      /* ✔ */
  case SCR_TS_FAIL:
  case SCR_TS_CHILDFAIL:
  case SCR_TS_CANCELLED: return "\xE2\x9C\x96";      /* ✖ */
  case SCR_TS_SKIPPED: return "\xEF\xB9\xA3";         /* ﹣ */
  case SCR_TS_TODO_FAIL: return "\xE2\x9A\xA0";       /* ⚠ */
  default: return "?";
  }
}

static void scr_test_print_str(const ScrStr *s) {
  if (s) fwrite(s->data, 1, s->len, stdout);
}

/* Ancestors print their "▶ name" headers before the first descendant
 * result line lands — Node's reporter defers the arrow until a child
 * reports, so empty suites never print one. */
static void scr_test_ensure_started(ScrTestCtx *t) {
  if (!t || !t->parent || t->started_line) return;
  scr_test_ensure_started(t->parent);
  t->started_line = true;
  scr_test_indent(scr_test_depth(t));
  fputs("\xE2\x96\xB6 ", stdout); /* ▶ */
  scr_test_print_str(t->name);
  fputc('\n', stdout);
}

/* "<sym> <name> (<dur>ms)[ # directive]" + queued ℹ diagnostics. Held
 * while subtests run concurrently (scr_test_report_tree prints them). */
static void scr_test_report_result(ScrTestCtx *t) {
  if (scr_test_defer > 0) return;
  scr_test_ensure_started(t->parent);
  int depth = scr_test_depth(t);
  scr_test_indent(depth);
  fputs(scr_test_symbol(t->state), stdout);
  fputc(' ', stdout);
  scr_test_print_str(t->name);
  scr_test_print_dur(t->dur_ms);
  if (t->state == SCR_TS_SKIPPED) {
    fputs(" # ", stdout);
    if (t->msg) scr_test_print_str(t->msg);
    else fputs("SKIP", stdout);
  } else if (t->state == SCR_TS_TODO_PASS || t->state == SCR_TS_TODO_FAIL) {
    fputs(" # ", stdout);
    if (t->msg) scr_test_print_str(t->msg);
    else fputs("TODO", stdout);
  }
  fputc('\n', stdout);
  for (size_t i = 0; i < t->ndiags; i++) {
    scr_test_indent(depth);
    fputs("\xE2\x84\xB9 ", stdout); /* ℹ */
    scr_test_print_str(t->diags[i]);
    fputc('\n', stdout);
  }
}

/* ── running ─────────────────────────────────────────────────────────── */

/* An async test body with { timeout }: awaits the body's promise or a
 * timer, whichever settles first. When the timer wins, the test fails with
 * Node's "test timed out after <timeout>ms" string and is cancelled; the
 * body keeps running unobserved. */
static void scr_test_await_timeout(ScrPromise *p, ScrTestCtx *t) {
  ScrPromise *timer = scr_promise_new();
  double handle = scr_set_timeout_handle(scr_make_resolve(timer, 3 /* void */), t->timeout);
  ScrPromise *race = scr_promise_new();
  scr_promise_race_join(race, p, scr_promise_adapt_copy);
  scr_promise_race_join(race, timer, scr_promise_adapt_copy);
  scr_await_void(race);
  scr_clear_interval(handle);
  scr_promise_release(race);
  scr_promise_release(timer);
  if (!scr_exc_pending() && scr_promise_is_pending(p)) {
    char num[32];
    size_t n = scr_f64_to_str(t->timeout, num);
    char buf[80];
    int len = snprintf(buf, sizeof buf, "test timed out after %.*sms", (int)n, num);
    t->timed_out = true;
    scr_throw_str(scr_str_new(buf, (size_t)len));
  }
}

/* Call one stored closure by its lowering-pinned shape; async shapes are
 * awaited (the runner is a fiber). `ctx` is passed +1 when the body takes
 * the TestContext, and `scope` is what getTestContext() answers while it
 * runs. Returns with the fiber's exception cell holding any failure.
 * `timed` is the test whose { timeout } bounds an async body. */
static void scr_test_call(ScrClosure *cb, int flags, ScrTestCtx *ctx, ScrTestCtx *scope,
                          ScrTestCtx *timed) {
  ScrAlsCtx *outer = scr_test_scope_enter(scope);
  bool takes_ctx = (flags & SCR_TEST_F_CTX) != 0;
  if (flags & SCR_TEST_F_ASYNC) {
    ScrPromise *p =
        takes_ctx
            ? ((ScrPromise * (*)(ScrClosure *, ScrTestCtx *)) cb->fn)(cb, scr_testctx_retain(ctx))
            : ((ScrPromise * (*)(ScrClosure *)) cb->fn)(cb);
    if (!scr_exc_pending() && p) {
      if (timed && isfinite(timed->timeout)) scr_test_await_timeout(p, timed);
      else scr_await_void(p);
    }
    scr_promise_release(p);
  } else if (takes_ctx) {
    ((void (*)(ScrClosure *, ScrTestCtx *))cb->fn)(cb, scr_testctx_retain(ctx));
  } else {
    ((void (*)(ScrClosure *))cb->fn)(cb);
  }
  scr_test_scope_leave(outer);
}

/* A mock tracker's restoreAll: each mock's restore, in creation order.
 * reset also forgets the mocks, so later restoreAll calls skip them. */
static void scr_test_mocks_restore(ScrTestHooks *mocks, bool forget) {
  for (size_t i = 0; i < mocks->n; i++) {
    ScrClosure *cb = mocks->v[i].cb;
    ((void (*)(ScrClosure *))cb->fn)(cb);
  }
  if (forget) scr_test_hooks_free(mocks);
}

/* Run `which` hooks up (beforeEach: outermost suite first) or down
 * (afterEach: innermost first) the ancestor chain. A hook throw fails the
 * test with the hook's error (Node cancels harder — SEMANTICS.md). */
/* `ctx` is the context a hook that takes one receives: the suite or test
 * for its own before/after hooks, the test for the beforeEach/afterEach
 * chain. */
static ScrTestHook *scr_test_run_hooks_of(ScrTestCtx *owner, int which, ScrTestCtx *ctx) {
  if (scr_exc_pending()) return NULL; /* an earlier hook in the chain threw */
  for (size_t i = 0; i < owner->hooks[which].n; i++) {
    ScrTestHook *h = &owner->hooks[which].v[i];
    scr_test_call(h->cb, h->flags, ctx, owner, NULL);
    if (scr_exc_pending()) return h; /* the hook that threw */
  }
  return NULL;
}

/* Returns whether the chain has any `which` hooks. */
static bool scr_test_run_each_hooks(ScrTestCtx *t, int which, bool outermost_first) {
  ScrTestCtx *chain[64];
  int n = 0;
  bool any = false;
  for (ScrTestCtx *p = t->parent; p && n < 64; p = p->parent) {
    chain[n++] = p;
    if (p->hooks[which].n > 0) any = true;
  }
  if (outermost_first) {
    for (int i = n - 1; i >= 0; i--) scr_test_run_hooks_of(chain[i], which, t);
  } else {
    for (int i = 0; i < n; i++) scr_test_run_hooks_of(chain[i], which, t);
  }
  return any;
}

/* A test or suite marked only, or one with a marked descendant. */
static bool scr_test_has_only(const ScrTestCtx *t) {
  if (t->flags & SCR_TEST_F_ONLY) return true;
  for (size_t i = 0; i < t->nchildren; i++) {
    if (scr_test_has_only(t->children[i])) return true;
  }
  return false;
}

static bool scr_test_any_only(ScrTestCtx *parent) {
  for (size_t i = 0; i < parent->nchildren; i++) {
    if (scr_test_has_only(parent->children[i])) return true;
  }
  return false;
}

static void scr_test_run_node(ScrTestCtx *t);
typedef struct ScrMockTimers ScrMockTimers;
static void scr_mt_reset(ScrMockTimers *m);

/* ── concurrency ─────────────────────────────────────────────────────── */

/* Turns a concurrent subtest waits: after its beforeEach hooks, and before
 * a suite runs its children (Node awaits its suite build first). Node's
 * awaited hook and suite steps take these many microtask turns, so sibling
 * bodies interleave as they do there. */
#define SCR_TEST_HOOK_TURNS 8
#define SCR_TEST_SUITE_TURNS 2

static void scr_test_spawn(ScrTestCtx *c);

static void scr_test_fiber_enter(ScrTestCtx *parent) {
  if (scr_test_nfibers == scr_test_fibers_cap) {
    scr_test_fibers_cap = scr_test_fibers_cap ? scr_test_fibers_cap * 2 : 8;
    scr_test_fibers = realloc(scr_test_fibers, scr_test_fibers_cap * sizeof *scr_test_fibers);
    if (!scr_test_fibers) scr_test_oom();
  }
  scr_test_fibers[scr_test_nfibers].fiber = scr_fiber_self();
  scr_test_fibers[scr_test_nfibers].parent = parent;
  scr_test_nfibers++;
}

static void scr_test_fiber_leave(void) {
  void *self = scr_fiber_self();
  for (size_t i = 0; i < scr_test_nfibers; i++) {
    if (scr_test_fibers[i].fiber == self) {
      scr_test_fibers[i] = scr_test_fibers[--scr_test_nfibers];
      break;
    }
  }
  if (scr_test_nfibers == 0) {
    free(scr_test_fibers);
    scr_test_fibers = NULL;
    scr_test_fibers_cap = 0;
  }
}

static void scr_test_child_entry(ScrFiber *self, void *arg) {
  (void)self;
  ScrTestCtx *c = arg;
  ScrTestCtx *parent = c->parent;
  scr_test_fiber_enter(parent);
  if (c->is_suite && c->mode != SCR_TEST_SKIP) {
    for (int i = 0; i < SCR_TEST_SUITE_TURNS; i++) scr_await_hop();
  }
  scr_test_run_node(c);
  scr_test_fiber_leave();
  parent->active--;
  /* The next queued sibling takes the freed slot. */
  for (size_t i = 0; i < parent->nchildren; i++) {
    if (parent->children[i]->queued) {
      scr_test_spawn(parent->children[i]);
      break;
    }
  }
  scr_promise_fulfill_void(c->done);
  if (parent->slot) scr_promise_fulfill_void(parent->slot);
  scr_testctx_release(c);
}

static void scr_test_spawn(ScrTestCtx *c) {
  c->queued = false;
  c->on_fiber = true;
  c->parent->active++;
  scr_promise_release(scr_async_spawn(scr_test_child_entry, scr_testctx_retain(c)));
}

/* Starts a subtest of a concurrent parent: now when a slot is free, else
 * when one frees up. */
static void scr_test_start(ScrTestCtx *c) {
  ScrTestCtx *parent = c->parent;
  c->done = scr_promise_new();
  if (parent->active >= parent->concurrency) {
    c->queued = true;
    return;
  }
  scr_test_spawn(c);
}

/* Waits until every subtest the parent started has finished. */
static void scr_test_wait_children(ScrTestCtx *t) {
  for (;;) {
    bool pending = t->active > 0;
    for (size_t i = 0; i < t->nchildren && !pending; i++) pending = t->children[i]->queued;
    if (!pending) return;
    t->slot = scr_promise_new();
    scr_await_void(t->slot);
    scr_promise_release(t->slot);
    t->slot = NULL;
  }
}

/* Prints a finished subtree's result lines, in the order a sequential
 * run prints them. */
static void scr_test_report_tree(ScrTestCtx *t) {
  if (t->state == SCR_TS_PENDING) return;
  for (size_t i = 0; i < t->nchildren; i++) scr_test_report_tree(t->children[i]);
  scr_test_report_result(t);
}

/* A concurrent parent's subtests are done: the outermost one prints them. */
static void scr_test_finish_concurrent(ScrTestCtx *t) {
  scr_test_wait_children(t);
  if (--scr_test_defer > 0) return;
  for (size_t i = 0; i < t->nchildren; i++) scr_test_report_tree(t->children[i]);
}

/* A failing root before hook (Node): each top-level test fails with its
 * error without running its body or beforeEach hooks, though its
 * afterEach hooks run; a top-level suite fails with it, and the tests and
 * suites in it are cancelled before they start. */
static void scr_test_cancel_unrun(ScrTestCtx *c) {
  for (size_t i = 0; i < c->nchildren; i++) scr_test_cancel_unrun(c->children[i]);
  static const char msg[] = "test did not finish before its parent and was cancelled";
  scr_throw_str(scr_str_new(msg, sizeof msg - 1));
  c->err = scr_exc_take();
  c->listed = true;
  c->dur_ms = NAN;
  c->state = SCR_TS_CANCELLED;
  scr_test_report_result(c);
}

/* A cancelled subtest's afterEach chain and t.after hooks, on their own
 * fiber: they start at the next turn, once the runner has moved on, as
 * Node runs them when the cancelled test's own run resumes. The afterEach
 * chain is copied when the test is cancelled, because its ancestors drop
 * their hooks when they finish. Then the test's hooks are dropped,
 * releasing closures that capture its context. */
typedef struct {
  ScrTestCtx *test;      /* owned ref */
  ScrTestHooks each;     /* the afterEach chain, innermost first; owned closures */
  ScrTestCtx **owners;   /* owned refs: each afterEach hook's suite or test */
} ScrTestCancelled;

static void scr_test_cancelled_hooks_entry(ScrFiber *self, void *arg) {
  (void)self;
  ScrTestCancelled *job = arg;
  ScrTestCtx *c = job->test;
  scr_await_hop(); /* the spawn runs the fiber at once; start at the next turn */
  for (size_t i = 0; i < job->each.n && !scr_exc_pending(); i++)
    scr_test_call(job->each.v[i].cb, job->each.v[i].flags, c, job->owners[i], NULL);
  if (scr_exc_pending()) scr_exc_clear();
  scr_test_run_hooks_of(c, SCR_HOOK_AFTER, c);
  if (scr_exc_pending()) scr_exc_clear();
  for (int k = 0; k < 4; k++) scr_test_hooks_free(&c->hooks[k]);
  for (size_t i = 0; i < job->each.n; i++) scr_testctx_release(job->owners[i]);
  free(job->owners);
  scr_test_hooks_free(&job->each);
  scr_testctx_release(c);
  free(job);
}

static void scr_test_cancelled_hooks(ScrTestCtx *c) {
  ScrTestCancelled *job = calloc(1, sizeof *job);
  if (!job) scr_test_oom();
  job->test = scr_testctx_retain(c);
  for (ScrTestCtx *p = c->parent; p; p = p->parent) {
    ScrTestHooks *h = &p->hooks[SCR_HOOK_AFTER_EACH];
    for (size_t i = 0; i < h->n; i++) {
      if (job->each.n == job->each.cap) {
        job->each.cap = job->each.cap ? job->each.cap * 2 : 4;
        job->each.v = realloc(job->each.v, job->each.cap * sizeof *job->each.v);
        job->owners = realloc(job->owners, job->each.cap * sizeof *job->owners);
        if (!job->each.v || !job->owners) scr_test_oom();
      }
      job->owners[job->each.n] = scr_testctx_retain(p);
      job->each.v[job->each.n].cb = scr_closure_retain(h->v[i].cb);
      job->each.v[job->each.n].flags = h->v[i].flags;
      job->each.v[job->each.n].at = NULL;
      job->each.n++;
    }
  }
  scr_promise_release(scr_async_spawn(scr_test_cancelled_hooks_entry, job));
}

/* A test that timed out (Node): its subtests that are still running are
 * cancelled, innermost first, with their durations so far. Each one's
 * mocks are restored and its mock timers reset at once, and its afterEach
 * chain and t.after hooks run once the runner yields. Their bodies keep
 * running unobserved and report nothing when they settle. */
static void scr_test_cancel_running(ScrTestCtx *t) {
  for (size_t i = 0; i < t->nchildren; i++) {
    ScrTestCtx *c = t->children[i];
    if (c->is_suite || c->state != SCR_TS_PENDING || isnan(c->start_ms)) continue;
    scr_test_cancel_running(c);
    static const char msg[] = "test did not finish before its parent and was cancelled";
    scr_throw_str(scr_str_new(msg, sizeof msg - 1));
    c->err = scr_exc_take();
    c->dur_ms = scr_now_ms() - c->start_ms;
    c->state = SCR_TS_CANCELLED;
    scr_test_report_result(c);
    scr_test_mocks_restore(&c->mocks, true);
    scr_mt_reset(c->mock_timers);
    scr_test_cancelled_hooks(c);
  }
}

static void scr_test_fail_unrun(ScrTestCtx *c, ScrCaught *err) {
  double start = scr_now_ms();
  c->err = scr_caught_retain(err);
  c->listed = true;
  if (c->is_suite) {
    for (size_t i = 0; i < c->nchildren; i++) scr_test_cancel_unrun(c->children[i]);
  } else {
    scr_test_run_each_hooks(c, SCR_HOOK_AFTER_EACH, false);
    if (scr_exc_pending()) scr_exc_clear();
  }
  c->dur_ms = scr_now_ms() - start;
  c->state = SCR_TS_FAIL;
  scr_test_report_result(c);
}

static void scr_test_run_children(ScrTestCtx *t) {
  /* `only` at this level: when a child is marked, or contains a marked
   * test or suite, only those children run. The others are dropped entirely
   * (Node reports nothing for them). */
  bool only = scr_test_any_only(t);
  for (size_t i = 0; i < t->nchildren; i++) {
    ScrTestCtx *c = t->children[i];
    if (only && !scr_test_has_only(c)) {
      continue; /* filtered: never run, never reported, never counted */
    }
    /* Subtests t.test already ran INLINE at their call site, or started on
     * their own fiber. */
    if (c->state != SCR_TS_PENDING || c->done) continue;
    if (t == scr_test_root && t->before_err) {
      scr_test_fail_unrun(c, t->before_err);
      continue;
    }
    if (t->concurrency > 1) scr_test_start(c);
    else scr_test_run_node(c);
  }
}

static bool scr_test_subtree_failed(const ScrTestCtx *t) {
  for (size_t i = 0; i < t->nchildren; i++) {
    int s = t->children[i]->state;
    if (s == SCR_TS_FAIL || s == SCR_TS_CHILDFAIL || s == SCR_TS_CANCELLED) return true;
  }
  return false;
}

static void scr_test_run_node(ScrTestCtx *t) {
  double start = scr_now_ms();
  if (t->mode == SCR_TEST_SKIP) {
    t->dur_ms = scr_now_ms() - start;
    t->state = SCR_TS_SKIPPED;
    t->passed = true;
    scr_test_report_result(t);
    return;
  }
  if (t->is_suite) {
    /* The body already ran at registration (children collected). A hook
     * throw fails the SUITE with that error — before-failures skip the
     * children (Node cancels them; SEMANTICS.md numbers the difference). */
    scr_test_run_hooks_of(t, SCR_HOOK_BEFORE, t);
    if (scr_exc_pending()) {
      t->err = scr_exc_take();
    } else {
      if (t->concurrency > 1) {
        scr_test_defer++;
        scr_test_run_children(t);
        scr_test_finish_concurrent(t);
      } else {
        scr_test_run_children(t);
      }
      scr_test_run_hooks_of(t, SCR_HOOK_AFTER, t);
      if (scr_exc_pending()) t->err = scr_exc_take();
    }
    t->dur_ms = scr_now_ms() - start;
    if (t->err) scr_test_suite_hook_failed = true;
    if (t->mode == SCR_TEST_TODO) {
      /* A todo suite reports its directive; its children are todo too. */
      t->state = t->err ? SCR_TS_TODO_FAIL : SCR_TS_TODO_PASS;
    } else {
      t->state = t->err                     ? SCR_TS_FAIL
                 : scr_test_subtree_failed(t) ? SCR_TS_CHILDFAIL
                                              : SCR_TS_PASS;
    }
    /* Node's suite pass() comes after its after hooks. */
    t->passed = t->state == SCR_TS_PASS || t->state == SCR_TS_TODO_PASS;
    scr_test_report_result(t);
    return;
  }
  /* A test: beforeEach chain, the body, subtests it queued (t.test runs
   * them inline; bare nested test() calls queued unrun run now), the
   * afterEach chain. */
  ScrTestCtx *prev_parent = scr_test_parent_get();
  scr_test_parent_set(t);
  t->start_ms = start;
  if (t->concurrency > 1) scr_test_defer++;
  bool hooked = scr_test_run_each_hooks(t, SCR_HOOK_BEFORE_EACH, true);
  /* A concurrent subtest resumes after its beforeEach hooks as many turns
   * later as Node's awaited hook run takes, so sibling bodies interleave
   * as they do there. */
  if (hooked && t->on_fiber && !scr_exc_pending()) {
    for (int i = 0; i < SCR_TEST_HOOK_TURNS; i++) scr_await_hop();
  }
  bool failed = false;
  if (scr_exc_pending()) {
    t->err = scr_exc_take();
    failed = true;
  } else if (t->cb) {
    scr_test_call(t->cb, t->flags, t, t, t);
    if (t->state != SCR_TS_PENDING) {
      /* Its parent timed out and cancelled it while the body ran: the
       * result is reported, its cleanup ran at the cancellation
       * (scr_test_cancel_running), and the runner has moved on, so the
       * registration parent is not restored either: it belongs to the
       * test that runs now. */
      if (scr_exc_pending()) scr_exc_clear();
      if (t->concurrency > 1) scr_test_defer--;
      return;
    }
    if (scr_exc_pending()) {
      t->err = scr_exc_take();
      failed = true;
    }
    if (failed && t->timed_out) scr_test_cancel_running(t);
  }
  /* Children a passing body registered without running (bare test() in
   * the body): run them now, before the parent completes — Node holds
   * the parent open for its pending subtests. */
  if (!failed) scr_test_run_children(t);
  /* Concurrent subtests the body started are awaited either way. */
  if (t->concurrency > 1) scr_test_finish_concurrent(t);
  if (!failed && t->before_err) {
    t->err = scr_caught_retain(t->before_err);
    failed = true;
  }
  /* t.plan: the t.assert calls and subtests the test made. Node reports the
   * mismatch as a string failure. */
  if (!failed && t->plan >= 0 && t->plan_count != t->plan) {
    char buf[96];
    int n = snprintf(buf, sizeof buf, "plan expected %d assertions but received %d", t->plan,
                     t->plan_count);
    scr_throw_str(scr_str_new(buf, (size_t)n));
    t->err = scr_exc_take();
    failed = true;
  }
  /* Node's pass()/fail(): afterEach hooks already see the outcome. */
  t->passed = !failed;
  scr_test_run_each_hooks(t, SCR_HOOK_AFTER_EACH, false);
  if (scr_exc_pending()) {
    if (!failed && !t->err) {
      t->err = scr_exc_take();
      failed = true;
    } else {
      scr_exc_clear();
    }
  }
  /* t.after hooks run once the test and its afterEach chain finish. */
  scr_test_run_hooks_of(t, SCR_HOOK_AFTER, t);
  if (scr_exc_pending()) {
    if (!failed && !t->err) {
      t->err = scr_exc_take();
      failed = true;
    } else {
      scr_exc_clear();
    }
  }
  /* Then t.mock is reset: its mocks are restored and its timers reset. */
  scr_test_mocks_restore(&t->mocks, true);
  scr_mt_reset(t->mock_timers);
  /* Its t.before/t.after/t.beforeEach/t.afterEach hooks have all run, and
   * nothing runs them again: dropping them releases closures that capture
   * the context, which would otherwise keep it alive in a cycle. */
  for (int k = 0; k < 4; k++) scr_test_hooks_free(&t->hooks[k]);
  scr_test_parent_set(prev_parent);
  t->dur_ms = scr_now_ms() - start;
  if (t->mode == SCR_TEST_SKIP) {
    /* t.skip() marked it mid-body. */
    t->state = SCR_TS_SKIPPED;
  } else if (t->mode == SCR_TEST_TODO) {
    t->state = failed ? SCR_TS_TODO_FAIL : SCR_TS_TODO_PASS;
  } else if (failed) {
    t->state = t->timed_out ? SCR_TS_CANCELLED : SCR_TS_FAIL;
  } else {
    t->state = scr_test_subtree_failed(t) ? SCR_TS_CHILDFAIL : SCR_TS_PASS;
  }
  scr_test_report_result(t);
}

/* ── the summary + failing-tests section ─────────────────────────────── */

static void scr_test_count(const ScrTestCtx *t) {
  for (size_t i = 0; i < t->nchildren; i++) {
    const ScrTestCtx *c = t->children[i];
    if (c->state == SCR_TS_PENDING) continue; /* only-filtered / never ran */
    if (c->is_suite) {
      scr_test_ct_suites++;
    } else {
      scr_test_ct_tests++;
      switch (c->state) {
      case SCR_TS_PASS: scr_test_ct_pass++; break;
      case SCR_TS_FAIL:
      case SCR_TS_CHILDFAIL: scr_test_ct_fail++; break;
      case SCR_TS_CANCELLED: scr_test_ct_cancelled++; break;
      case SCR_TS_SKIPPED: scr_test_ct_skipped++; break;
      case SCR_TS_TODO_PASS:
      case SCR_TS_TODO_FAIL: scr_test_ct_todo++; break;
      default: break;
      }
    }
    scr_test_count(c);
  }
}

static void scr_test_info_line(const char *label, double value) {
  char num[32];
  fputs("\xE2\x84\xB9 ", stdout);
  fputs(label, stdout);
  fputc(' ', stdout);
  size_t n = scr_f64_to_str(value, num);
  fwrite(num, 1, n, stdout);
  fputc('\n', stdout);
}

/* The failing-tests detail: "test at <file>:<line>:<col>" (the file
 * relative to the working directory when it lies underneath, Node's
 * rendering), the result line at column 0, the error message indented two
 * spaces per line. Node appends the stack frames and an inspect property
 * block; this runtime stops at the message (SEMANTICS.md — the harness
 * strips both sides). */
static void scr_test_print_at(const ScrStr *at) {
  fputs("test at ", stdout);
  char cwd[4096];
  if (getcwd(cwd, sizeof cwd)) {
    size_t cl = strlen(cwd);
    if (at->len > cl + 1 && memcmp(at->data, cwd, cl) == 0 && at->data[cl] == '/') {
      fwrite(at->data + cl + 1, 1, at->len - cl - 1, stdout);
      fputc('\n', stdout);
      return;
    }
  }
  fwrite(at->data, 1, at->len, stdout);
  fputc('\n', stdout);
}

static void scr_test_print_failure(ScrTestCtx *t) {
  fputc('\n', stdout);
  if (t->at) scr_test_print_at(t->at);
  fputs(scr_test_symbol(t->state), stdout);
  fputc(' ', stdout);
  scr_test_print_str(t->name);
  scr_test_print_dur(t->dur_ms);
  if (t->state == SCR_TS_TODO_FAIL) {
    fputs(" # ", stdout);
    if (t->msg) scr_test_print_str(t->msg);
    else fputs("TODO", stdout);
  }
  fputc('\n', stdout);
  if (t->err) {
    /* Node prints the failure inspected: a thrown string is quoted, and
     * numbers, booleans and checked-dynamic values (thrown records, arrays,
     * null and undefined) print as util.inspect renders them. Errors and
     * other payloads print their string form. */
    const ScrCaught *err = t->err;
    ScrStr *msg;
    if (err->kind == SCR_EXC_STR) {
      msg = scr_insp_str(err->payload);
    } else if (err->kind == SCR_EXC_F64 || err->kind == SCR_EXC_BOOL ||
               ((err->kind == SCR_EXC_REF || err->kind == SCR_EXC_PRIMITIVE_REF) &&
                err->retain_fn == scr_dyn_retain_v)) {
      ScrDyn *value = scr_caught_to_dyn(err);
      msg = scr_insp_dyn(value, 0, 2);
      scr_dyn_release(value);
    } else {
      msg = scr_caught_to_string(err);
    }
    if (msg) {
      const char *p = msg->data;
      const char *end = msg->data + msg->len;
      while (p <= end) {
        const char *nl = memchr(p, '\n', (size_t)(end - p));
        size_t linelen = nl ? (size_t)(nl - p) : (size_t)(end - p);
        fputs("  ", stdout);
        fwrite(p, 1, linelen, stdout);
        fputc('\n', stdout);
        if (!nl) break;
        p = nl + 1;
      }
      scr_str_release(msg);
    }
  }
}

/* Own-body failures in declaration order — Node lists the tests whose
 * bodies threw (todo throwers included); parents failed by descendants
 * and suites never appear. */
static void scr_test_print_failures(ScrTestCtx *t, bool *any) {
  /* Completion order, as Node lists them: a test completes after its
   * subtests, so they print first. */
  for (size_t i = 0; i < t->nchildren; i++) {
    ScrTestCtx *c = t->children[i];
    scr_test_print_failures(c, any);
    if ((!c->is_suite || c->listed) &&
        (c->state == SCR_TS_FAIL || c->state == SCR_TS_TODO_FAIL ||
         c->state == SCR_TS_CANCELLED) &&
        c->err) {
      if (!*any) {
        *any = true;
        fputs("\n\xE2\x9C\x96 failing tests:\n", stdout);
      }
      scr_test_print_failure(c);
    }
  }
}

/* ── t.assert.snapshot and t.assert.fileSnapshot ───────────────────────
 * Node's SnapshotManager (lib/internal/test_runner/snapshot.js). A
 * snapshot is the serialized value, template-escaped and wrapped in
 * newlines, stored under "<test full name> <n>" in "<entry file>.snapshot".
 * Compare mode reads that file on the first assertion and returns the
 * stored value, which the emitted assert.strictEqual compares; update
 * mode records the value and writes every file, keys sorted, after the
 * last test. The file is read in the form Node writes it:
 * exports[`key`] = `value`; statements of template literals. */

typedef struct {
  ScrStr *key;   /* the snapshot id (cooked, as Node's exports keys) */
  ScrStr *value; /* the escaped, wrapped value */
} ScrSnapEntry;

typedef struct ScrSnapFile {
  ScrStr *path;
  ScrSnapEntry *entries;
  size_t n, cap;
  ScrStr **names; /* nextId's counters: test full names ... */
  long *counts;   /* ... and the next number for each */
  size_t nnames, ncap;
  bool loaded;
  struct ScrSnapFile *next;
} ScrSnapFile;

static SCR_TL ScrSnapFile *scr_snap_files = NULL;
/* Node's --test-update-snapshots: a leading argument of the binary,
 * which scr_test_init takes out of process.argv. */
static SCR_TL bool scr_test_update_snapshots = false;

void scr_test_init(void) {
  scr_test_update_snapshots = scr_lib_take_flag("--test-update-snapshots");
}

static void scr_snap_throw_state(const char *text, size_t len) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Invalid state: ");
  scr_jb_write(&b, text, len);
  ScrStr *msg = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg->data, msg->len, "ERR_INVALID_STATE");
  scr_str_release(msg);
}

/* "Cannot read snapshot file '<file>.'", with the tip when it is missing. */
static void scr_snap_throw_file(const char *verb, const ScrStr *file, bool missing) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Cannot ");
  scr_jb_puts(&b, verb);
  scr_jb_puts(&b, " snapshot file '");
  scr_jb_put_str(&b, file);
  scr_jb_puts(&b, ".'");
  if (missing)
    scr_jb_puts(&b, " Missing snapshots can be generated by rerunning the command with the "
                    "--test-update-snapshots flag.");
  ScrStr *msg = scr_jb_finish(&b);
  scr_snap_throw_state(msg->data, msg->len);
  scr_str_release(msg);
}

/* Node's templateEscape: \ ` and ${ escaped for a template literal. */
static void scr_snap_put_escaped(ScrJsonBuf *b, const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s[i] == '\\') scr_jb_puts(b, "\\\\");
    else if (s[i] == '`') scr_jb_puts(b, "\\`");
    else if (s[i] == '$' && i + 1 < n && s[i + 1] == '{') scr_jb_puts(b, "\\$");
    else scr_jb_putc(b, s[i]);
  }
}

/* Node's serializeValue: each serializer's result feeds the next; with no
 * serializers, the default JSON.stringify(value, null, 2). A throw becomes
 * Node's ERR_INVALID_STATE. Returns +1, or NULL after a throw. */
ScrDyn *scr_test_snapshot_serialize(ScrDyn *value, ScrDyn *serializers) {
  ScrDyn *v;
  if (serializers->kind != SCR_DYN_ARR) {
    ScrDyn *undef = scr_dyn_undefined();
    ScrDyn *space = scr_dyn_new_num(2);
    v = scr_json_stringify_value(value, undef, space);
    scr_dyn_release(undef);
    scr_dyn_release(space);
  } else {
    v = scr_dyn_retain(value);
    for (size_t i = 0; v && i < serializers->v.arr.len; i++) {
      ScrDyn *next = scr_dyn_call(serializers->v.arr.items[i], &v, 1, "serializer");
      scr_dyn_release(v);
      v = next;
    }
  }
  if (v && !scr_exc_pending()) return v;
  scr_dyn_release(v);
  scr_exc_clear();
  static const char msg[] = "The provided serializers did not generate a string.";
  scr_snap_throw_state(msg, sizeof msg - 1);
  return NULL;
}

ScrStr *scr_test_snapshot_value(ScrStr *serialized) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_putc(&b, '\n');
  scr_snap_put_escaped(&b, serialized->data, serialized->len);
  scr_jb_putc(&b, '\n');
  return scr_jb_finish(&b);
}

static ScrSnapFile *scr_snap_file(ScrStr *path) {
  for (ScrSnapFile *f = scr_snap_files; f; f = f->next) {
    if (f->path->len == path->len && memcmp(f->path->data, path->data, path->len) == 0) return f;
  }
  ScrSnapFile *f = calloc(1, sizeof *f);
  if (!f) scr_test_oom();
  f->path = scr_str_retain(path);
  f->loaded = scr_test_update_snapshots;
  f->next = scr_snap_files;
  scr_snap_files = f;
  return f;
}

/* nextId(name): "<name> <n>", counting from 1 per name. */
static ScrStr *scr_snap_next_id(ScrSnapFile *f, ScrStr *name) {
  size_t i = 0;
  while (i < f->nnames &&
         !(f->names[i]->len == name->len && memcmp(f->names[i]->data, name->data, name->len) == 0))
    i++;
  if (i == f->nnames) {
    if (f->nnames == f->ncap) {
      f->ncap = f->ncap ? f->ncap * 2 : 8;
      f->names = realloc(f->names, f->ncap * sizeof *f->names);
      f->counts = realloc(f->counts, f->ncap * sizeof *f->counts);
      if (!f->names || !f->counts) scr_test_oom();
    }
    f->names[i] = scr_str_retain(name);
    f->counts[i] = 1;
    f->nnames++;
  }
  char num[24];
  int len = snprintf(num, sizeof num, " %ld", f->counts[i]++);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_put_str(&b, name);
  scr_jb_write(&b, num, (size_t)len);
  return scr_jb_finish(&b);
}

static ScrSnapEntry *scr_snap_find(ScrSnapFile *f, const ScrStr *key) {
  for (size_t i = 0; i < f->n; i++) {
    const ScrStr *k = f->entries[i].key;
    if (k->len == key->len && memcmp(k->data, key->data, key->len) == 0) return &f->entries[i];
  }
  return NULL;
}

/* Sets key to value (both moved), replacing an earlier entry. */
static void scr_snap_set(ScrSnapFile *f, ScrStr *key, ScrStr *value) {
  ScrSnapEntry *e = scr_snap_find(f, key);
  if (e) {
    scr_str_release(key);
    scr_str_release(e->value);
    e->value = value;
    return;
  }
  if (f->n == f->cap) {
    f->cap = f->cap ? f->cap * 2 : 8;
    f->entries = realloc(f->entries, f->cap * sizeof *f->entries);
    if (!f->entries) scr_test_oom();
  }
  f->entries[f->n].key = key;
  f->entries[f->n].value = value;
  f->n++;
}

/* Appends the UTF-8 encoding of code point `cp`. */
static void scr_snap_put_cp(ScrJsonBuf *b, unsigned long cp) {
  char u[4];
  size_t n;
  if (cp < 0x80) {
    u[0] = (char)cp;
    n = 1;
  } else if (cp < 0x800) {
    u[0] = (char)(0xC0 | (cp >> 6));
    u[1] = (char)(0x80 | (cp & 0x3F));
    n = 2;
  } else if (cp < 0x10000) {
    u[0] = (char)(0xE0 | (cp >> 12));
    u[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    u[2] = (char)(0x80 | (cp & 0x3F));
    n = 3;
  } else {
    u[0] = (char)(0xF0 | (cp >> 18));
    u[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    u[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    u[3] = (char)(0x80 | (cp & 0x3F));
    n = 4;
  }
  scr_jb_write(b, u, n);
}

static int scr_snap_hex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Reads `count` hex digits at s[*i]. */
static bool scr_snap_hex_run(const char *s, size_t n, size_t *i, int count, unsigned long *out) {
  unsigned long v = 0;
  for (int k = 0; k < count; k++) {
    if (*i >= n) return false;
    int h = scr_snap_hex(s[*i]);
    if (h < 0) return false;
    v = v * 16 + (unsigned long)h;
    (*i)++;
  }
  *out = v;
  return true;
}

/* The cooked value of the template literal whose body starts at s[*i],
 * past its opening backtick; *i ends past the closing one. Returns NULL
 * for an unterminated literal, an invalid escape, or a substitution. */
static ScrStr *scr_snap_template(const char *s, size_t n, size_t *i) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  while (*i < n) {
    char c = s[(*i)++];
    if (c == '`') return scr_jb_finish(&b);
    if (c == '$' && *i < n && s[*i] == '{') break;
    if (c == '\r') {
      /* Template literals cook CR and CRLF to LF. */
      if (*i < n && s[*i] == '\n') (*i)++;
      scr_jb_putc(&b, '\n');
      continue;
    }
    if (c != '\\') {
      scr_jb_putc(&b, c);
      continue;
    }
    if (*i >= n) break;
    char e = s[(*i)++];
    unsigned long cp;
    switch (e) {
    case 'n':
      scr_jb_putc(&b, '\n');
      continue;
    case 't':
      scr_jb_putc(&b, '\t');
      continue;
    case 'r':
      scr_jb_putc(&b, '\r');
      continue;
    case 'b':
      scr_jb_putc(&b, '\b');
      continue;
    case 'f':
      scr_jb_putc(&b, '\f');
      continue;
    case 'v':
      scr_jb_putc(&b, '\v');
      continue;
    case '0':
      if (*i < n && s[*i] >= '0' && s[*i] <= '9') goto bad;
      scr_jb_putc(&b, '\0');
      continue;
    case '\r':
      if (*i < n && s[*i] == '\n') (*i)++;
      continue; /* line continuation */
    case '\n':
      continue;
    case 'x':
      if (!scr_snap_hex_run(s, n, i, 2, &cp)) goto bad;
      scr_snap_put_cp(&b, cp);
      continue;
    case 'u':
      if (*i < n && s[*i] == '{') {
        (*i)++;
        cp = 0;
        size_t start = *i;
        while (*i < n && s[*i] != '}') {
          int h = scr_snap_hex(s[*i]);
          if (h < 0 || cp > 0x10FFFF) goto bad;
          cp = cp * 16 + (unsigned long)h;
          (*i)++;
        }
        if (*i >= n || *i == start || cp > 0x10FFFF) goto bad;
        (*i)++;
      } else if (!scr_snap_hex_run(s, n, i, 4, &cp)) {
        goto bad;
      }
      if (cp >= 0xD800 && cp <= 0xDBFF && *i + 6 <= n && s[*i] == '\\' && s[*i + 1] == 'u') {
        size_t j = *i + 2;
        unsigned long lo;
        if (scr_snap_hex_run(s, n, &j, 4, &lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          *i = j;
        }
      }
      scr_snap_put_cp(&b, cp);
      continue;
    default:
      if (e >= '1' && e <= '9') goto bad;
      scr_jb_putc(&b, e); /* \\ \` \$ and identity escapes */
      continue;
    }
  }
bad:
  scr_str_release(scr_jb_finish(&b));
  return NULL;
}

static void scr_snap_skip_space(const char *s, size_t n, size_t *i) {
  while (*i < n && (s[*i] == ' ' || s[*i] == '\t' || s[*i] == '\n' || s[*i] == '\r')) (*i)++;
}

static bool scr_snap_expect(const char *s, size_t n, size_t *i, const char *text) {
  size_t len = strlen(text);
  if (*i + len > n || memcmp(s + *i, text, len) != 0) return false;
  *i += len;
  return true;
}

/* Parses the file's exports[`key`] = `value`; statements. Values are
 * escaped again, as Node escapes the exports it read. */
static bool scr_snap_parse(ScrSnapFile *f, const char *s, size_t n) {
  size_t i = 0;
  for (;;) {
    scr_snap_skip_space(s, n, &i);
    if (i >= n) return true;
    if (!scr_snap_expect(s, n, &i, "exports[`")) return false;
    ScrStr *key = scr_snap_template(s, n, &i);
    if (!key) return false;
    scr_snap_skip_space(s, n, &i);
    bool ok = scr_snap_expect(s, n, &i, "]");
    scr_snap_skip_space(s, n, &i);
    ok = ok && scr_snap_expect(s, n, &i, "=");
    scr_snap_skip_space(s, n, &i);
    ok = ok && scr_snap_expect(s, n, &i, "`");
    ScrStr *raw = ok ? scr_snap_template(s, n, &i) : NULL;
    if (!raw) {
      scr_str_release(key);
      return false;
    }
    scr_snap_skip_space(s, n, &i);
    (void)scr_snap_expect(s, n, &i, ";");
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_snap_put_escaped(&b, raw->data, raw->len);
    scr_str_release(raw);
    scr_snap_set(f, key, scr_jb_finish(&b));
  }
}

static bool scr_snap_read(ScrSnapFile *f) {
  if (f->loaded) return true;
  FILE *fp = fopen(f->path->data, "rb");
  if (!fp) {
    scr_snap_throw_file("read", f->path, errno == ENOENT);
    return false;
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  char chunk[8192];
  size_t got;
  while ((got = fread(chunk, 1, sizeof chunk, fp)) > 0) scr_jb_write(&b, chunk, got);
  bool read_ok = !ferror(fp);
  fclose(fp);
  ScrStr *text = scr_jb_finish(&b);
  bool ok = read_ok && scr_snap_parse(f, text->data, text->len);
  scr_str_release(text);
  if (!ok) {
    scr_snap_throw_file("read", f->path, false);
    return false;
  }
  f->loaded = true;
  return true;
}

/* Node's escapeSnapshotKey: the JSON string body of the id, with ` and
 * ${ escaped (+1). Update mode stores and sorts keys in this form. */
static ScrStr *scr_snap_escape_key(const ScrStr *key) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_put_json_str(&b, key);
  ScrStr *json = scr_jb_finish(&b);
  const char *s = json->data + 1;
  size_t n = json->len - 2;
  ScrJsonBuf out;
  scr_jb_init(&out);
  for (size_t i = 0; i < n; i++) {
    if (s[i] == '`') scr_jb_puts(&out, "\\`");
    else if (s[i] == '$' && i + 1 < n && s[i + 1] == '{') scr_jb_puts(&out, "\\$");
    else scr_jb_putc(&out, s[i]);
  }
  scr_str_release(json);
  return scr_jb_finish(&out);
}

/* t.assert.snapshot: the stored value for the test's next id (+1), or the
 * recorded `value` in update mode. NULL after a throw. */
ScrStr *scr_test_ctx_snapshot(ScrTestCtx *t, ScrStr *value, ScrStr *file) {
  ScrSnapFile *f = scr_snap_file(file);
  ScrStr *name = scr_test_ctx_full_name(t);
  ScrStr *id = scr_snap_next_id(f, name);
  scr_str_release(name);
  if (scr_test_update_snapshots) {
    scr_snap_set(f, scr_snap_escape_key(id), scr_str_retain(value));
    scr_str_release(id);
    return scr_str_retain(value);
  }
  if (!scr_snap_read(f)) {
    scr_str_release(id);
    return NULL;
  }
  ScrSnapEntry *e = scr_snap_find(f, id);
  if (!e) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "Snapshot '");
    scr_jb_put_str(&b, id);
    scr_jb_puts(&b, "' not found in '");
    scr_jb_put_str(&b, f->path);
    scr_jb_puts(&b, ".' Missing snapshots can be generated by rerunning the command with the "
                    "--test-update-snapshots flag.");
    ScrStr *msg = scr_jb_finish(&b);
    scr_snap_throw_state(msg->data, msg->len);
    scr_str_release(msg);
    scr_str_release(id);
    return NULL;
  }
  scr_str_release(id);
  return scr_str_retain(e->value);
}

static bool scr_snap_write_text(const ScrStr *path, const char *data, size_t len) {
  FILE *fp = fopen(path->data, "wb");
  if (!fp) return false;
  bool ok = fwrite(data, 1, len, fp) == len;
  return fclose(fp) == 0 && ok;
}

/* mkdirSync(dirname(path), { recursive: true }); false after an error. */
static bool scr_snap_mkdir_parent(const ScrStr *path) {
  size_t end = path->len;
  while (end > 0 && path->data[end - 1] != '/'
#ifdef _WIN32
         && path->data[end - 1] != '\\'
#endif
  )
    end--;
  if (end <= 1) return true;
  ScrStr *dir = scr_str_new(path->data, end - 1);
  scr_fs_mkdir_recursive(dir);
  scr_str_release(dir);
  if (!scr_exc_pending()) return true;
  scr_exc_clear();
  return false;
}

/* t.assert.fileSnapshot: the file's contents (+1), or the recorded value
 * in update mode, which writes the file. NULL after a throw. */
ScrStr *scr_test_file_snapshot(ScrStr *value, ScrStr *path) {
  if (scr_test_update_snapshots) {
    if (!scr_snap_mkdir_parent(path) || !scr_snap_write_text(path, value->data, value->len)) {
      scr_snap_throw_file("write", path, false);
      return NULL;
    }
    return scr_str_retain(value);
  }
  FILE *fp = fopen(path->data, "rb");
  if (!fp) {
    scr_snap_throw_file("read", path, errno == ENOENT);
    return NULL;
  }
  ScrJsonBuf b;
  scr_jb_init(&b);
  char chunk[8192];
  size_t got;
  while ((got = fread(chunk, 1, sizeof chunk, fp)) > 0) scr_jb_write(&b, chunk, got);
  bool ok = !ferror(fp);
  fclose(fp);
  ScrStr *text = scr_jb_finish(&b);
  if (!ok) {
    scr_str_release(text);
    scr_snap_throw_file("read", path, false);
    return NULL;
  }
  return text;
}

/* The next UTF-16 code unit of a UTF-8 key: *low carries the low
 * surrogate of an astral character to the following call. */
static unsigned long scr_snap_unit(const ScrStr *s, size_t *i, unsigned long *low) {
  if (*low) {
    unsigned long u = *low;
    *low = 0;
    return u;
  }
  const unsigned char *d = (const unsigned char *)s->data;
  unsigned char c = d[*i];
  size_t len = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
  if (*i + len > s->len) len = s->len - *i;
  unsigned long cp = len == 1 ? c : len == 2 ? (c & 0x1Fu) : len == 3 ? (c & 0x0Fu) : (c & 0x07u);
  for (size_t k = 1; k < len; k++) cp = (cp << 6) | (d[*i + k] & 0x3Fu);
  *i += len;
  if (cp < 0x10000) return cp;
  *low = 0xDC00 + ((cp - 0x10000) & 0x3FF);
  return 0xD800 + ((cp - 0x10000) >> 10);
}

/* Array.prototype.sort's default order: UTF-16 code units. */
static int scr_snap_key_cmp(const void *a, const void *b) {
  const ScrStr *x = ((const ScrSnapEntry *)a)->key, *y = ((const ScrSnapEntry *)b)->key;
  size_t i = 0, j = 0;
  unsigned long xl = 0, yl = 0;
  while ((i < x->len || xl) && (j < y->len || yl)) {
    unsigned long u = scr_snap_unit(x, &i, &xl), v = scr_snap_unit(y, &j, &yl);
    if (u != v) return u < v ? -1 : 1;
  }
  bool xmore = i < x->len || xl, ymore = j < y->len || yl;
  return xmore == ymore ? 0 : xmore ? 1 : -1;
}


/* writeSnapshotFiles(): every snapshot file of the run, in update mode. */
static void scr_snap_write_all(void) {
  if (!scr_test_update_snapshots) return;
  for (ScrSnapFile *f = scr_snap_files; f; f = f->next) {
    qsort(f->entries, f->n, sizeof *f->entries, scr_snap_key_cmp);
    ScrJsonBuf b;
    scr_jb_init(&b);
    for (size_t i = 0; i < f->n; i++) {
      if (i > 0) scr_jb_putc(&b, '\n');
      scr_jb_puts(&b, "exports[`");
      scr_jb_put_str(&b, f->entries[i].key);
      scr_jb_puts(&b, "`] = `");
      scr_jb_put_str(&b, f->entries[i].value);
      scr_jb_puts(&b, "`;\n");
    }
    ScrStr *text = scr_jb_finish(&b);
    if (!scr_snap_mkdir_parent(f->path) || !scr_snap_write_text(f->path, text->data, text->len)) {
      fflush(stdout);
      fprintf(stderr, "Error [ERR_INVALID_STATE]: Invalid state: Cannot write snapshot file '%.*s.'\n",
              (int)f->path->len, f->path->data);
      scr_test_suite_hook_failed = true;
    }
    scr_str_release(text);
  }
}

static void scr_snap_free_all(void) {
  while (scr_snap_files) {
    ScrSnapFile *f = scr_snap_files;
    scr_snap_files = f->next;
    for (size_t i = 0; i < f->n; i++) {
      scr_str_release(f->entries[i].key);
      scr_str_release(f->entries[i].value);
    }
    for (size_t i = 0; i < f->nnames; i++) scr_str_release(f->names[i]);
    free(f->entries);
    free(f->names);
    free(f->counts);
    scr_str_release(f->path);
    free(f);
  }
}

/* ── the runner fiber ────────────────────────────────────────────────── */

static void scr_test_runner_entry(ScrFiber *self, void *argpack) {
  (void)self;
  (void)argpack;
  /* Park until main returns and the loop drains microtasks — Node starts
   * the first test only after the file's synchronous body completes. */
  scr_await_hop();
  ScrTestCtx *root = scr_test_root;
  /* The root's before hooks ran at their before() calls; the first test
   * waits for the async ones. */
  for (size_t i = 0; i < scr_test_root_npending; i++) {
    scr_await_void(scr_test_root_pending[i]);
    scr_test_root_before_failed(root);
    scr_promise_release(scr_test_root_pending[i]);
  }
  free(scr_test_root_pending);
  scr_test_root_pending = NULL;
  scr_test_root_npending = scr_test_root_pending_cap = 0;
  scr_test_run_children(root);
  /* Its after hooks: a throw reports the root as "✖ <file>" with the hook's
   * location, after the top-level results, without counting it or changing
   * the exit code, as Node does. */
  double after_start = scr_now_ms();
  ScrTestHook *after_failed = scr_test_run_hooks_of(root, SCR_HOOK_AFTER, root);
  if (scr_exc_pending()) {
    root->err = scr_exc_take();
    root->dur_ms = scr_now_ms() - after_start;
    root->state = SCR_TS_FAIL;
    if (after_failed && after_failed->at) {
      root->at = scr_str_retain(after_failed->at);
      /* The name is the file: the location without its ":line:col". */
      size_t end = root->at->len;
      for (int colons = 0; end > 0 && colons < 2; end--) {
        if (root->at->data[end - 1] == ':') colons++;
      }
      scr_str_release(root->name);
      root->name = scr_str_new(root->at->data, end);
    }
    fputs("\xE2\x9C\x96 ", stdout);
    scr_test_print_str(root->name);
    scr_test_print_dur(root->dur_ms);
    fputc('\n', stdout);
  }
  scr_test_run_done = true;
  scr_snap_write_all();
  scr_test_count(root);
  scr_test_info_line("tests", (double)scr_test_ct_tests);
  scr_test_info_line("suites", (double)scr_test_ct_suites);
  scr_test_info_line("pass", (double)scr_test_ct_pass);
  scr_test_info_line("fail", (double)scr_test_ct_fail);
  scr_test_info_line("cancelled", (double)scr_test_ct_cancelled);
  scr_test_info_line("skipped", (double)scr_test_ct_skipped);
  scr_test_info_line("todo", (double)scr_test_ct_todo);
  scr_test_info_line("duration_ms", round((scr_now_ms() - scr_test_t0) * 1e6) / 1e6);
  bool any = false;
  scr_test_print_failures(root, &any);
  if (root->err) {
    if (!any) fputs("\n\xE2\x9C\x96 failing tests:\n", stdout);
    scr_test_print_failure(root);
  }
  /* The tree is done reporting: release it (test bodies may still hold
   * their TestContext refs — the boxes stay alive through those). */
  scr_test_reg_parent = NULL;
  scr_test_root = NULL;
  scr_testctx_release(root);
}

static void scr_test_ensure_runner(void) {
  if (scr_test_runner_spawned) return;
  scr_test_runner_spawned = true;
  scr_test_t0 = scr_now_ms();
  ScrPromise *p = scr_async_spawn(scr_test_runner_entry, NULL);
  scr_promise_release(p);
}

/* ── the registration surface (libCall targets) ──────────────────────── */

/* The { plan, timeout } options of a new test. Node checks the timeout's
 * range when the test is created and throws ERR_OUT_OF_RANGE. */
static void scr_test_out_of_range(const char *option, const char *range, double value) {
  char recv[48];
  size_t n = scr_num_received(value, recv);
  char msg[192];
  int len = snprintf(msg, sizeof msg,
                     "The value of \"options.%s\" is out of range. It must be %s. Received %.*s",
                     option, range, (int)n, recv);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
}

/* Node checks concurrency (a positive uint32; -1 stands for `true`) and
 * then the timeout's range when the test is created. */
static bool scr_test_options_ok(double flags, double timeout, double concurrency) {
  if (((int)flags & SCR_TEST_F_CONCURRENCY) && concurrency != -1) {
    if (concurrency != floor(concurrency) || isnan(concurrency)) {
      scr_test_out_of_range("concurrency", "an integer", concurrency);
      return false;
    }
    if (concurrency < 1 || concurrency > 4294967295.0) {
      scr_test_out_of_range("concurrency", ">= 1 && <= 4294967295", concurrency);
      return false;
    }
  }
  if (((int)flags & SCR_TEST_F_TIMEOUT) && timeout != INFINITY &&
      !(timeout >= 0 && timeout <= 2147483647)) {
    scr_test_out_of_range("timeout", ">= 0 && <= 2147483647", timeout);
    return false;
  }
  return true;
}

static void scr_test_options_apply(ScrTestCtx *t, double flags, double plan, double timeout,
                                   double concurrency) {
  if (plan >= 0) t->plan = (int)plan;
  if ((int)flags & SCR_TEST_F_TIMEOUT) t->timeout = timeout;
  if ((int)flags & SCR_TEST_F_CONCURRENCY) {
    /* `true` runs every subtest at once: Node uses Infinity for any test
     * with a parent, and os.availableParallelism() - 1 only for its root. */
    t->concurrency = concurrency == -1 ? INFINITY : concurrency;
  }
}

void scr_test_register(ScrStr *name /*borrowed*/, double mode, ScrStr *msg /*borrowed*/,
                        ScrClosure *cb /*moves, may be NULL*/, double flags,
                        ScrStr *at /*borrowed*/, double plan, double timeout,
                        double concurrency) {
  if (!scr_test_options_ok(flags, timeout, concurrency)) {
    scr_closure_release(cb);
    return;
  }
  scr_test_ensure_root();
  scr_test_ensure_runner();
  if (scr_test_run_done) {
    /* Registration after the run completed (a late timer callback):
     * Node throws ERR_TEST_FAILURE; this runtime drops it (SEMANTICS). */
    scr_closure_release(cb);
    return;
  }
  ScrTestCtx *t = scr_test_node_new(name, (int)mode, msg, cb, (int)flags, at, false);
  scr_test_options_apply(t, flags, plan, timeout, concurrency);
  ScrTestCtx *parent = scr_test_parent_get();
  scr_test_child_add(parent, t);
  /* A test() call inside a running concurrent test starts the subtest now. */
  if (!parent->is_suite && parent->concurrency > 1) scr_test_start(t);
}

void scr_test_suite(ScrStr *name /*borrowed*/, double mode, ScrStr *msg /*borrowed*/,
                     ScrClosure *cb /*moves, may be NULL*/, ScrStr *at /*borrowed*/,
                     double flags, double concurrency) {
  if (!scr_test_options_ok(flags, 0, concurrency)) {
    scr_closure_release(cb);
    return;
  }
  scr_test_ensure_root();
  scr_test_ensure_runner();
  if (scr_test_run_done) {
    scr_closure_release(cb);
    return;
  }
  ScrTestCtx *t = scr_test_node_new(name, (int)mode, msg, NULL, (int)flags, at, true);
  scr_test_options_apply(t, flags, -1, 0, concurrency);
  scr_test_child_add(scr_test_parent_get(), t);
  /* The suite body runs NOW (Node's collection phase) — its test()/it()
   * calls attach here. Skipped suites keep their bodies unrun. */
  if (cb && (int)mode != SCR_TEST_SKIP) {
    ScrTestCtx *prev = scr_test_parent_get();
    scr_test_parent_set(t);
    ScrAlsCtx *outer = scr_test_scope_enter(t);
    /* flag 2: the body takes its SuiteContext (+1, as test bodies do). */
    if ((int)flags & SCR_TEST_F_CTX)
      ((void (*)(ScrClosure *, ScrTestCtx *))cb->fn)(cb, scr_testctx_retain(t));
    else
      ((void (*)(ScrClosure *))cb->fn)(cb);
    scr_test_scope_leave(outer);
    scr_test_parent_set(prev);
  }
  scr_closure_release(cb);
}

/* A module-level before hook runs at its before() call, as Node runs the
 * hooks of its already-started root at once: the synchronous part runs
 * now, on the caller's stack, and the runner waits for an async hook's
 * promise before the first top-level test. The first failure fails the
 * top-level tests and suites (scr_test_fail_unrun). */
static void scr_test_root_before_now(ScrTestCtx *root, ScrClosure *cb, int flags) {
  bool takes_ctx = (flags & SCR_TEST_F_CTX) != 0;
  ScrAlsCtx *outer = scr_test_scope_enter(root);
  if (flags & SCR_TEST_F_ASYNC) {
    ScrPromise *p =
        takes_ctx
            ? ((ScrPromise * (*)(ScrClosure *, ScrTestCtx *)) cb->fn)(cb, scr_testctx_retain(root))
            : ((ScrPromise * (*)(ScrClosure *)) cb->fn)(cb);
    if (p && !scr_exc_pending()) {
      if (scr_test_root_npending == scr_test_root_pending_cap) {
        scr_test_root_pending_cap = scr_test_root_pending_cap ? scr_test_root_pending_cap * 2 : 2;
        scr_test_root_pending = realloc(scr_test_root_pending,
                                        scr_test_root_pending_cap * sizeof *scr_test_root_pending);
        if (!scr_test_root_pending) scr_test_oom();
      }
      /* The runner observes it: a rejection is the hook's failure, not an
       * unhandled rejection. */
      scr_promise_mark_handled(p);
      scr_test_root_pending[scr_test_root_npending++] = p;
      scr_test_scope_leave(outer);
      return;
    }
    scr_promise_release(p);
  } else if (takes_ctx) {
    ((void (*)(ScrClosure *, ScrTestCtx *))cb->fn)(cb, scr_testctx_retain(root));
  } else {
    ((void (*)(ScrClosure *))cb->fn)(cb);
  }
  scr_test_scope_leave(outer);
  scr_test_root_before_failed(root);
}

void scr_test_hook(double which, ScrClosure *cb /*moves*/, double flags, ScrStr *at) {
  scr_test_ensure_root();
  ScrTestCtx *owner = scr_test_parent_get();
  ScrTestHooks *h = &owner->hooks[(int)which];
  if (h->n == h->cap) {
    h->cap = h->cap ? h->cap * 2 : 2;
    h->v = realloc(h->v, h->cap * sizeof *h->v);
    if (!h->v) scr_test_oom();
  }
  h->v[h->n].cb = cb;
  h->v[h->n].flags = (int)flags;
  h->v[h->n].at = at && at->len > 0 ? scr_str_retain(at) : NULL;
  h->n++;
  if ((int)which == SCR_HOOK_BEFORE && owner == scr_test_root)
    scr_test_root_before_now(owner, cb, (int)flags);
}

/* t.test(...): registers under `t` and — because subtests run inline on
 * the runner fiber at their call site (Node's awaited-subtest ordering) —
 * runs it immediately. Returns the settled promise `await t.test(...)`
 * consumes. */
ScrPromise *scr_test_sub(ScrTestCtx *t, ScrStr *name /*borrowed*/, double mode,
                          ScrStr *msg /*borrowed*/, ScrClosure *cb /*moves, may be NULL*/,
                          double flags, ScrStr *at /*borrowed*/, double plan, double timeout,
                          double concurrency) {
  if (!scr_test_options_ok(flags, timeout, concurrency)) {
    scr_closure_release(cb);
    return NULL;
  }
  ScrTestCtx *sub = scr_test_node_new(name, (int)mode, msg, cb, (int)flags, at, false);
  scr_test_options_apply(sub, flags, plan, timeout, concurrency);
  scr_test_child_add(t, sub);
  t->plan_count++;
  if (t->concurrency > 1 && !t->before_err) {
    /* Under concurrency the subtest starts now, or when a slot frees up,
     * and the returned promise settles when it finishes. */
    scr_test_start(sub);
    return scr_promise_retain(sub->done);
  }
  if (t->before_err) {
    /* A throwing t.before fails the subtests that follow: their bodies and
     * beforeEach hooks do not run, their afterEach hooks do. */
    sub->err = scr_caught_retain(t->before_err);
    sub->state = SCR_TS_FAIL;
    scr_test_run_each_hooks(sub, SCR_HOOK_AFTER_EACH, false);
    if (scr_exc_pending()) scr_exc_clear();
    scr_test_report_result(sub);
    return scr_promise_settled_void();
  }
  scr_test_run_node(sub);
  return scr_promise_settled_void();
}

void scr_test_ctx_skip(ScrTestCtx *t, ScrStr *msg /*borrowed*/) {
  t->mode = SCR_TEST_SKIP;
  if (msg && msg->len > 0) {
    scr_str_release(t->msg);
    t->msg = scr_str_retain(msg);
  }
}

void scr_test_ctx_todo(ScrTestCtx *t, ScrStr *msg /*borrowed*/) {
  t->mode = SCR_TEST_TODO;
  if (msg && msg->len > 0) {
    scr_str_release(t->msg);
    t->msg = scr_str_retain(msg);
  }
}

/* t.before/t.after/t.beforeEach/t.afterEach. t.before runs at once (the
 * test is already running); a throw fails the test and the subtests that
 * follow. The others attach to the test: beforeEach and afterEach wrap
 * each descendant subtest, and after runs once the test finishes. */
void scr_test_ctx_hook(ScrTestCtx *t, double which, ScrClosure *cb /*moves*/, double flags) {
  if ((int)which == SCR_HOOK_BEFORE) {
    scr_test_call(cb, (int)flags, t, t, NULL);
    scr_closure_release(cb);
    if (scr_exc_pending() && !t->before_err) t->before_err = scr_exc_take();
    else if (scr_exc_pending()) scr_exc_clear();
    return;
  }
  ScrTestHooks *h = &t->hooks[(int)which];
  if (h->n == h->cap) {
    h->cap = h->cap ? h->cap * 2 : 2;
    h->v = realloc(h->v, h->cap * sizeof *h->v);
    if (!h->v) scr_test_oom();
  }
  h->v[h->n].cb = cb;
  h->v[h->n].flags = (int)flags;
  h->v[h->n].at = NULL;
  h->n++;
}

static void scr_test_mocks_add(ScrTestHooks *h, ScrClosure *restore /*moves*/) {
  if (h->n == h->cap) {
    h->cap = h->cap ? h->cap * 2 : 2;
    h->v = realloc(h->v, h->cap * sizeof *h->v);
    if (!h->v) scr_test_oom();
  }
  h->v[h->n].cb = restore;
  h->v[h->n].flags = 0;
  h->v[h->n].at = NULL;
  h->n++;
}

/* ── mock.timers ──────────────────────────────────────────────────────
 * Node's MockTimers (lib/internal/test_runner/mock/mock_timers.js). The
 * module's `mock` and every t.mock own one. enable() makes it the owner
 * of the APIs it lists: setTimeout, setInterval, setImmediate and their
 * clear functions then queue entries on it instead of arming loop timers,
 * AbortSignal.timeout aborts from its queue, timers/promises
 * scheduler.wait settles from it, Date.now() and new Date() read its
 * clock, and tick() runs the due entries synchronously. enable() saves the owner each API had and reset() restores it, as Node
 * saves and restores the functions it replaces. The queue is Node's
 * binary heap (internal/priority_queue.js) with Node's comparator, so
 * entries with equal, negative or NaN run times fire in Node's order.
 * Mock handles are negative, which the loop's timer functions ignore.
 *
 * The scr_test_mt_* entry points replace the timer calls of programs
 * that use mock.timers (the moduleUsesMockTimers switch), so other
 * programs call the loop's timer functions directly. */

/* The APIs enable() mocks, in Node's SUPPORTED_APIS order. */
enum {
  SCR_MT_TIMEOUT,
  SCR_MT_INTERVAL,
  SCR_MT_IMMEDIATE,
  SCR_MT_DATE,
  SCR_MT_WAIT,
  SCR_MT_ABORT,
  SCR_MT_NAPIS
};

typedef struct {
  double run_at;
  double id;         /* Node's #currentTimer: the tie-break between equal run times */
  double interval;   /* the period of a setInterval entry */
  bool has_interval; /* false for timeouts and cleared intervals (Node's undefined) */
  ScrClosure *cb;    /* owned */
  size_t pos;        /* heap slot, 0 when unset (Node's priorityQueuePosition) */
  double handle;     /* the negative handle the program holds */
  ScrMockTimers *owner;
  int refs;          /* heap slots holding the entry, plus a running callback */
} ScrMockTimer;

struct ScrMockTimers {
  bool enabled;
  char apis[16]; /* the APIs enable() listed, in order (Node's #timersInContext) */
  size_t napis;
  double now;
  double next_id;
  ScrMockTimer **heap; /* 1-based, as Node's #heap */
  size_t size, cap;
  ScrMockTimers *saved[SCR_MT_NAPIS]; /* each API's owner before enable() */
  ScrMockTimers *next_all;
};

/* The owner of each API: the MockTimers its calls queue on, NULL for the
 * loop's timers. */
static SCR_TL ScrMockTimers *scr_mt_owner[SCR_MT_NAPIS];
static SCR_TL ScrMockTimers *scr_mt_module = NULL;
/* Every MockTimers, freed at exit: an owner or saved slot can still name
 * one after its test ended, as Node keeps the replaced functions. */
static SCR_TL ScrMockTimers *scr_mt_all = NULL;
static SCR_TL double scr_mt_next_handle = -1;
/* Set once a MockTimers that mocked scheduler.wait gives the real one
 * back: Node restores it bound to the MockTimers, so every later call
 * throws ERR_INVALID_THIS. */
static SCR_TL bool scr_mt_wait_unbound = false;
/* Entries the program can still reach through a handle. */
static SCR_TL ScrMockTimer **scr_mt_live = NULL;
static SCR_TL size_t scr_mt_nlive = 0, scr_mt_live_cap = 0;

static ScrMockTimers *scr_mt_new(void) {
  ScrMockTimers *m = calloc(1, sizeof *m);
  if (!m) scr_test_oom();
  m->next_id = 1;
  m->next_all = scr_mt_all;
  scr_mt_all = m;
  return m;
}

static ScrMockTimers *scr_mt_of(ScrTestCtx *t) {
  ScrMockTimers **slot = t ? &t->mock_timers : &scr_mt_module;
  if (!*slot) *slot = scr_mt_new();
  return *slot;
}

static void scr_mt_unref(ScrMockTimer *e) {
  if (--e->refs > 0) return;
  for (size_t i = 0; i < scr_mt_nlive; i++) {
    if (scr_mt_live[i] == e) {
      scr_mt_live[i] = scr_mt_live[--scr_mt_nlive];
      break;
    }
  }
  scr_closure_release(e->cb);
  free(e);
}

static ScrMockTimer *scr_mt_find(double handle) {
  if (!(handle < 0)) return NULL;
  for (size_t i = 0; i < scr_mt_nlive; i++) {
    if (scr_mt_live[i]->handle == handle) return scr_mt_live[i];
  }
  return NULL;
}

/* Node's compareTimersLists: (a.runAt - b.runAt) || (a.id - b.id). */
static double scr_mt_compare(const ScrMockTimer *a, const ScrMockTimer *b) {
  double d = a->run_at - b->run_at;
  if (d != 0 && !isnan(d)) return d;
  return a->id - b->id;
}

static void scr_mt_percolate_down(ScrMockTimers *m, size_t pos) {
  ScrMockTimer **heap = m->heap;
  size_t size = m->size, hsize = size >> 1;
  ScrMockTimer *item = heap[pos];
  while (pos <= hsize) {
    size_t child = pos << 1, next = child + 1;
    ScrMockTimer *child_item = heap[child];
    if (next <= size && scr_mt_compare(heap[next], child_item) < 0) {
      child = next;
      child_item = heap[next];
    }
    if (scr_mt_compare(item, child_item) <= 0) break;
    child_item->pos = pos;
    heap[pos] = child_item;
    pos = child;
  }
  heap[pos] = item;
  item->pos = pos;
}

static void scr_mt_percolate_up(ScrMockTimers *m, size_t pos) {
  ScrMockTimer **heap = m->heap;
  ScrMockTimer *item = heap[pos];
  while (pos > 1) {
    size_t parent = pos >> 1;
    ScrMockTimer *parent_item = heap[parent];
    if (scr_mt_compare(parent_item, item) <= 0) break;
    heap[pos] = parent_item;
    parent_item->pos = pos;
    pos = parent;
  }
  heap[pos] = item;
  item->pos = pos;
}

static void scr_mt_insert(ScrMockTimers *m, ScrMockTimer *e) {
  if (m->size + 2 > m->cap) {
    m->cap = m->cap ? m->cap * 2 : 8;
    m->heap = realloc(m->heap, m->cap * sizeof *m->heap);
    if (!m->heap) scr_test_oom();
  }
  e->refs++;
  m->heap[++m->size] = e;
  scr_mt_percolate_up(m, m->size);
}

static void scr_mt_remove_at(ScrMockTimers *m, size_t pos) {
  ScrMockTimer **heap = m->heap;
  ScrMockTimer *removed = heap[pos];
  heap[pos] = heap[m->size];
  heap[m->size] = NULL;
  size_t size = --m->size;
  if (size > 0 && pos <= size) {
    if (pos > 1 && scr_mt_compare(heap[pos >> 1], heap[pos]) > 0) scr_mt_percolate_up(m, pos);
    else scr_mt_percolate_down(m, pos);
  }
  scr_mt_unref(removed);
}

static ScrMockTimer *scr_mt_peek(ScrMockTimers *m) { return m->size > 0 ? m->heap[1] : NULL; }

static void scr_mt_throw_state(const char *what) {
  char msg[160];
  int len = snprintf(msg, sizeof msg, "Invalid state: %s", what);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, "ERR_INVALID_STATE");
}

/* Node's #assertTimeArg: ERR_INVALID_ARG_VALUE('time', 'positive integer', time). */
static bool scr_mt_time_ok(double time) {
  if (!(time < 0)) return true;
  char num[32];
  size_t n = scr_f64_to_str(time, num);
  char msg[96];
  int len = snprintf(msg, sizeof msg, "The argument 'time' %.*s. Received 'positive integer'",
                     (int)n, num);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_VALUE");
  return false;
}

static int scr_mt_api(char code) {
  switch (code) {
  case 'I':
    return SCR_MT_INTERVAL;
  case 'M':
    return SCR_MT_IMMEDIATE;
  case 'D':
    return SCR_MT_DATE;
  case 'W':
    return SCR_MT_WAIT;
  case 'A':
    return SCR_MT_ABORT;
  default:
    return SCR_MT_TIMEOUT;
  }
}

/* Node's #createTimer: the delay is used as given, except that one past
 * TIMEOUT_MAX becomes 1; an omitted delay arrives as NaN (Node's
 * undefined). */
static ScrMockTimer *scr_mt_create(ScrMockTimers *m, bool is_interval, ScrClosure *cb /*moves*/,
                                   double delay) {
  if (delay > 2147483647.0) delay = 1;
  ScrMockTimer *e = calloc(1, sizeof *e);
  if (!e) scr_test_oom();
  e->id = m->next_id++;
  e->cb = cb;
  e->run_at = m->now + delay;
  e->has_interval = is_interval && !isnan(delay);
  e->interval = delay;
  e->handle = scr_mt_next_handle--;
  e->owner = m;
  if (scr_mt_nlive == scr_mt_live_cap) {
    scr_mt_live_cap = scr_mt_live_cap ? scr_mt_live_cap * 2 : 8;
    scr_mt_live = realloc(scr_mt_live, scr_mt_live_cap * sizeof *scr_mt_live);
    if (!scr_mt_live) scr_test_oom();
  }
  scr_mt_live[scr_mt_nlive++] = e;
  scr_mt_insert(m, e);
  return e;
}

/* Node's #clearTimer on the API's owner. A handle the owner did not
 * create is left alone. */
static void scr_mt_clear(ScrMockTimers *m, double handle) {
  ScrMockTimer *e = scr_mt_find(handle);
  if (!e || e->owner != m || e->pos == 0) return;
  size_t pos = e->pos;
  e->pos = 0;
  e->has_interval = false;
  scr_mt_remove_at(m, pos);
}

static void scr_mt_tick(ScrMockTimers *m, double time) {
  if (!m->enabled) {
    scr_mt_throw_state("You should enable MockTimers first by calling the .enable function");
    return;
  }
  if (!scr_mt_time_ok(time)) return;
  m->now += time;
  ScrMockTimer *timer = scr_mt_peek(m);
  while (timer) {
    if (timer->run_at > m->now) break;
    timer->refs++;
    ((void (*)(ScrClosure *))timer->cb->fn)(timer->cb);
    if (scr_exc_pending()) {
      /* The throw leaves the entry queued, as in Node. */
      scr_mt_unref(timer);
      return;
    }
    /* Node's tick() removes the fired entry only while it is still first
     * in the queue: a callback that cleared its own timer already removed
     * it, and one that queued an entry sorting before it (an immediate,
     * due at now - 1) leaves it queued, so it runs again, as in Node. The
     * mock-timers-date fixture checks that order against Node. */
    ScrMockTimer *after = scr_mt_peek(m);
    if (after && after->id == timer->id) {
      timer->pos = 0;
      scr_mt_remove_at(m, 1);
    }
    if (timer->has_interval) {
      timer->run_at += timer->interval;
      scr_mt_insert(m, timer);
    }
    scr_mt_unref(timer);
    timer = scr_mt_peek(m);
  }
}

static void scr_mt_abort_arm(ScrClosure *cb /*moves*/, double ms) {
  (void)scr_mt_create(scr_mt_owner[SCR_MT_ABORT], false, cb, ms);
}

/* Points the Date, AbortSignal.timeout and scheduler.wait hooks at their
 * owners. */
static void scr_mt_hooks(void) {
  ScrMockTimers *date = scr_mt_owner[SCR_MT_DATE];
  scr_date_mock_now = date ? &date->now : NULL;
  scr_mt_abort_timeout_arm = scr_mt_owner[SCR_MT_ABORT] ? &scr_mt_abort_arm : NULL;
  scr_mt_wait_state = scr_mt_owner[SCR_MT_WAIT] ? 1 : scr_mt_wait_unbound ? 2 : 0;
}

/* Node's #toggleEnableTimers. Mocking Date while another MockTimers mocks
 * it throws ERR_INVALID_STATE; the APIs listed before Date stay mocked,
 * and the MockTimers stays disabled, as in Node. */
static bool scr_mt_toggle(ScrMockTimers *m, bool activate) {
  for (size_t i = 0; i < m->napis; i++) {
    int api = scr_mt_api(m->apis[i]);
    if (activate) {
      if (api == SCR_MT_DATE && scr_mt_owner[api] != NULL) {
        scr_mt_hooks();
        scr_mt_throw_state("Date is already being mocked!");
        return false;
      }
      m->saved[api] = scr_mt_owner[api];
      scr_mt_owner[api] = m;
    } else {
      scr_mt_owner[api] = m->saved[api];
      if (api == SCR_MT_WAIT && scr_mt_owner[api] == NULL) scr_mt_wait_unbound = true;
    }
  }
  scr_mt_hooks();
  m->enabled = activate;
  return true;
}

static void scr_mt_reset(ScrMockTimers *m) {
  if (!m || !m->enabled) return;
  scr_mt_toggle(m, false);
  m->napis = 0;
  m->now = 0;
  while (m->size > 0) scr_mt_remove_at(m, 1);
}

/* enable({ apis, now }): `apis` holds one code per listed API, in order
 * ('T' setTimeout, 'I' setInterval, 'M' setImmediate, 'D' Date, 'W'
 * scheduler.wait, 'A' AbortSignal.timeout). flags: 1 = `now` is given, 2 = it
 * came from a Date (Node then takes its time without checks). */
static void scr_mt_enable(ScrMockTimers *m, ScrStr *apis, double now, double flags) {
  if (m->enabled) {
    scr_mt_throw_state("MockTimers is already enabled!");
    return;
  }
  bool given = ((int)flags & 1) != 0, from_date = ((int)flags & 2) != 0;
  if (given && !from_date && isnan(now)) {
    static const char msg[] =
        "The argument 'now' epoch must be a positive integer received NaN. Received NaN";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_VALUE");
    return;
  }
  if (!given || (!from_date && now == 0)) now = 0;
  m->napis = apis->len < sizeof m->apis ? apis->len : sizeof m->apis;
  memcpy(m->apis, apis->data, m->napis);
  if (!from_date && !scr_mt_time_ok(now)) return;
  m->now = now;
  (void)scr_mt_toggle(m, true);
}

void scr_test_mock_timers_enable(ScrStr *apis, double now, double flags) {
  scr_mt_enable(scr_mt_of(NULL), apis, now, flags);
}
void scr_test_ctx_mock_timers_enable(ScrTestCtx *t, ScrStr *apis, double now, double flags) {
  scr_mt_enable(scr_mt_of(t), apis, now, flags);
}
void scr_test_mock_timers_tick(double time) { scr_mt_tick(scr_mt_of(NULL), time); }
void scr_test_ctx_mock_timers_tick(ScrTestCtx *t, double time) { scr_mt_tick(scr_mt_of(t), time); }

static void scr_mt_run_all(ScrMockTimers *m) {
  if (!m->enabled) {
    scr_mt_throw_state("You should enable MockTimers first by calling the .enable function");
    return;
  }
  /* Node ticks to the entry in the heap's last slot. */
  if (m->size == 0) return;
  scr_mt_tick(m, m->heap[m->size]->run_at - m->now);
}
void scr_test_mock_timers_run_all(void) { scr_mt_run_all(scr_mt_of(NULL)); }
void scr_test_ctx_mock_timers_run_all(ScrTestCtx *t) { scr_mt_run_all(scr_mt_of(t)); }
void scr_test_mock_timers_reset(void) { scr_mt_reset(scr_mt_module); }
void scr_test_ctx_mock_timers_reset(ScrTestCtx *t) { scr_mt_reset(t->mock_timers); }

/* setTime(time): Node checks the time before whether timers are enabled. */
static void scr_mt_set_time(ScrMockTimers *m, double time) {
  if (!scr_mt_time_ok(time)) return;
  if (!m->enabled) {
    scr_mt_throw_state("You should enable MockTimers first by calling the .enable function");
    return;
  }
  m->now = time;
}
void scr_test_mock_timers_set_time(double time) { scr_mt_set_time(scr_mt_of(NULL), time); }
void scr_test_ctx_mock_timers_set_time(ScrTestCtx *t, double time) {
  scr_mt_set_time(scr_mt_of(t), time);
}

/* The timer calls of a program that uses mock.timers: an owned API
 * queues on its owner, else the loop's timer functions run. */
void scr_test_mt_set_timeout(ScrClosure *cb /*moves*/, double ms) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_TIMEOUT];
  if (m) (void)scr_mt_create(m, false, cb, ms);
  else scr_set_timeout(cb, ms);
}
double scr_test_mt_set_timeout_handle(ScrClosure *cb /*moves*/, double ms) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_TIMEOUT];
  return m ? scr_mt_create(m, false, cb, ms)->handle : scr_set_timeout_handle(cb, ms);
}
double scr_test_mt_set_interval(ScrClosure *cb /*moves*/, double ms) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_INTERVAL];
  return m ? scr_mt_create(m, true, cb, ms)->handle : scr_set_interval(cb, ms);
}
void scr_test_mt_clear_timeout(double handle) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_TIMEOUT];
  if (m) scr_mt_clear(m, handle);
  else scr_clear_interval(handle);
}
void scr_test_mt_clear_interval(double handle) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_INTERVAL];
  if (m) scr_mt_clear(m, handle);
  else scr_clear_interval(handle);
}
/* A mock Timeout's ref() and unref() return it unchanged, refresh() does
 * nothing, and hasRef() is true. */
void scr_test_mt_unref(double handle) {
  if (!(handle < 0)) scr_timer_unref(handle);
}
void scr_test_mt_ref(double handle) {
  if (!(handle < 0)) scr_timer_ref(handle);
}
void scr_test_mt_refresh(double handle) {
  if (!(handle < 0)) scr_timer_refresh(handle);
}
bool scr_test_mt_has_ref(double handle) { return handle < 0 || scr_timer_has_ref(handle); }
/* Node's mocked setImmediate queues a timer with delay -1, so it runs
 * before timers due at the same tick; its handle is a mock Timeout. */
double scr_test_mt_set_immediate(ScrClosure *cb /*moves*/) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_IMMEDIATE];
  return m ? scr_mt_create(m, false, cb, -1)->handle : scr_set_immediate(cb);
}
/* The same calls in a program that enters AsyncLocalStorage stores: a
 * mocked timer runs in the context its tick() runs in, as in Node; a real
 * one keeps the stores active when it was scheduled. */
void scr_test_mt_set_timeout_als(ScrClosure *cb /*moves*/, double ms) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_TIMEOUT];
  if (m) (void)scr_mt_create(m, false, cb, ms);
  else scr_set_timeout_als(cb, ms);
}
double scr_test_mt_set_timeout_handle_als(ScrClosure *cb /*moves*/, double ms) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_TIMEOUT];
  return m ? scr_mt_create(m, false, cb, ms)->handle : scr_set_timeout_handle_als(cb, ms);
}
double scr_test_mt_set_interval_als(ScrClosure *cb /*moves*/, double ms) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_INTERVAL];
  return m ? scr_mt_create(m, true, cb, ms)->handle : scr_set_interval_als(cb, ms);
}
double scr_test_mt_set_immediate_als(ScrClosure *cb /*moves*/) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_IMMEDIATE];
  return m ? scr_mt_create(m, false, cb, -1)->handle : scr_set_immediate_als(cb);
}
void scr_test_mt_clear_immediate(double handle) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_IMMEDIATE];
  if (m) scr_mt_clear(m, handle);
  else scr_clear_immediate(handle);
}
void scr_test_mt_immediate_unref(double handle) {
  if (!(handle < 0)) scr_immediate_unref(handle);
}
void scr_test_mt_immediate_ref(double handle) {
  if (!(handle < 0)) scr_immediate_ref(handle);
}
bool scr_test_mt_immediate_has_ref(double handle) {
  return handle < 0 || scr_immediate_has_ref(handle);
}
/* timers/promises scheduler.wait(delay). Node's mock settles the result
 * from an async function that awaits an inner promise the entry
 * resolves, so the result settles one microtask after the entry fires.
 * The entry's closure holds the result promise until it first fires. */
static void scr_mt_wait_fire(ScrClosure *self) {
  ScrPromise *p = (ScrPromise *)scr_box_get_ref(self->caps[0]);
  if (!p) return;
  scr_box_set_ref(self->caps[0], NULL);
  scr_queue_microtask(scr_make_resolve(p, 3 /* void */));
  scr_promise_release(p);
}

static bool scr_mt_wait_bound(void) {
  if (!scr_mt_wait_unbound) return true;
  static const char msg[] = "Value of \"this\" must be of type Scheduler";
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_THIS");
  return false;
}

static ScrPromise *scr_mt_wait(ScrMockTimers *m, double ms) {
  ScrPromise *p = scr_promise_new();
  ScrClosure *c = scr_closure_new((void *)&scr_mt_wait_fire, 1);
  ScrBox *b = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
  scr_box_set_ref(b, scr_promise_retain(p));
  c->caps[0] = b;
  (void)scr_mt_create(m, false, c, ms);
  return p;
}

ScrPromise *scr_test_mt_scheduler_wait(double ms) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_WAIT];
  if (m) return scr_mt_wait(m, ms);
  return scr_mt_wait_bound() ? scr_tp_set_timeout(ms) : NULL;
}

/* scheduler.wait(delay, { ref }): Node's mock ignores ref. */
ScrPromise *scr_test_mt_scheduler_wait_value(double ms, ScrPromise *value, bool ref) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_WAIT];
  if (m) return scr_mt_wait(m, ms);
  return scr_mt_wait_bound() ? scr_tp_set_timeout_value(ms, value, ref) : NULL;
}

/* Date.now() and new Date() under a mocked Date read its clock. */
double scr_test_mt_date_now(void) {
  ScrMockTimers *m = scr_mt_owner[SCR_MT_DATE];
  return m ? m->now : scr_date_now();
}

/* Releases every MockTimers and its queued entries at exit. */
static void scr_mt_free_all(void) {
  while (scr_mt_all) {
    ScrMockTimers *m = scr_mt_all;
    scr_mt_all = m->next_all;
    while (m->size > 0) scr_mt_remove_at(m, 1);
    free(m->heap);
    free(m);
  }
  free(scr_mt_live);
  scr_mt_live = NULL;
  scr_mt_nlive = scr_mt_live_cap = 0;
  for (int i = 0; i < SCR_MT_NAPIS; i++) scr_mt_owner[i] = NULL;
  scr_mt_hooks();
  scr_mt_module = NULL;
}

void scr_test_mock_track(ScrClosure *restore /*moves*/) {
  scr_test_mocks_add(&scr_test_mocks, restore);
}
void scr_test_mock_restore_all(void) { scr_test_mocks_restore(&scr_test_mocks, false); }
/* reset() restores the tracker's mocks and resets its timers. */
void scr_test_mock_reset(void) {
  scr_test_mocks_restore(&scr_test_mocks, true);
  scr_mt_reset(scr_mt_module);
}
void scr_test_ctx_mock_track(ScrTestCtx *t, ScrClosure *restore /*moves*/) {
  scr_test_mocks_add(&t->mocks, restore);
}
void scr_test_ctx_mock_restore_all(ScrTestCtx *t) { scr_test_mocks_restore(&t->mocks, false); }
void scr_test_ctx_mock_reset(ScrTestCtx *t) {
  scr_test_mocks_restore(&t->mocks, true);
  scr_mt_reset(t->mock_timers);
}

void scr_test_ctx_plan(ScrTestCtx *t, double count) { t->plan = (int)count; }

void scr_test_ctx_count(ScrTestCtx *t) { t->plan_count++; }

void scr_test_ctx_diagnostic(ScrTestCtx *t, ScrStr *msg /*borrowed*/) {
  if (t->ndiags == t->dcap) {
    t->dcap = t->dcap ? t->dcap * 2 : 2;
    t->diags = realloc(t->diags, t->dcap * sizeof *t->diags);
    if (!t->diags) scr_test_oom();
  }
  t->diags[t->ndiags++] = scr_str_retain(msg);
}

ScrStr *scr_test_ctx_name(ScrTestCtx *t) {
  if (!t->name && !t->parent) return scr_str_new("<root>", 6); /* Node's root test */
  return t->name ? scr_str_retain(t->name) : scr_str_new("", 0);
}

bool scr_test_ctx_passed(ScrTestCtx *t) { return t->passed; }

/* t.workerId: Number(process.env.NODE_TEST_WORKER_ID) || undefined, with 0
 * standing for undefined. */
double scr_test_worker_id(void) {
  const char *env = getenv("NODE_TEST_WORKER_ID");
  if (!env) return 0;
  ScrStr *s = scr_str_new(env, strlen(env));
  double n = scr_string_to_number(s);
  scr_str_release(s);
  return isnan(n) ? 0 : n;
}

/* t.fullName: the names from the outermost suite or test down to this one,
 * joined with " > "; the root's own name for the root. */
ScrStr *scr_test_ctx_full_name(ScrTestCtx *t) {
  if (!t->parent) return scr_test_ctx_name(t);
  const ScrTestCtx *chain[64];
  int n = 0;
  for (const ScrTestCtx *p = t; p && p->parent && n < 64; p = p->parent) chain[n++] = p;
  size_t len = 0;
  for (int i = 0; i < n; i++) len += (chain[i]->name ? chain[i]->name->len : 0) + (i ? 3 : 0);
  char *buf = malloc(len ? len : 1);
  if (!buf) scr_test_oom();
  size_t at = 0;
  for (int i = n - 1; i >= 0; i--) {
    if (i != n - 1) {
      memcpy(buf + at, " > ", 3);
      at += 3;
    }
    if (chain[i]->name) {
      memcpy(buf + at, chain[i]->name->data, chain[i]->name->len);
      at += chain[i]->name->len;
    }
  }
  ScrStr *out = scr_str_new(buf, at);
  free(buf);
  return out;
}

int scr_test_exit_code(void) {
  /* The program is done: the module tracker's restore closures go. */
  if (scr_exit_frees()) {
    scr_test_hooks_free(&scr_test_mocks);
    scr_mt_free_all();
    scr_snap_free_all();
  }
  /* The runner never finished: a test awaited a promise nobody settles
   * and the loop exhausted (Node cancels the test and exits 1 — the
   * summary it prints there is not reproduced; SEMANTICS.md). The run
   * exits 1 instead of passing. */
  if (scr_test_runner_spawned && !scr_test_run_done) {
    fflush(stdout);
    fputs("scriptc: node:test runner never finished (a test awaited a promise nobody settles)\n", stderr);
    return 1;
  }
  return (scr_test_ct_fail > 0 || scr_test_ct_cancelled > 0 || scr_test_suite_hook_failed) ? 1
                                                                                         : 0;
}
