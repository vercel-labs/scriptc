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
enum { SCR_TEST_F_ASYNC = 1, SCR_TEST_F_CTX = 2, SCR_TEST_F_ONLY = 4 };
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
};

typedef struct {
  ScrClosure *cb;
  int flags;
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
  ScrTestHooks hooks[4]; /* suites and root only */
};

static ScrTestCtx *scr_test_root = NULL;
/* Where registrations attach: the suite body being collected or the test
 * currently running (its nested test()/t.test() calls are subtests). */
static ScrTestCtx *scr_test_reg_parent = NULL;
static bool scr_test_runner_spawned = false;
static bool scr_test_run_done = false;
static long scr_test_ct_tests = 0, scr_test_ct_suites = 0, scr_test_ct_pass = 0,
            scr_test_ct_fail = 0, scr_test_ct_skipped = 0, scr_test_ct_todo = 0;
static double scr_test_t0 = 0;
static bool scr_test_suite_hook_failed = false;

#ifdef SCR_RC_AUDIT
static long scr_testctx_live = 0;
long scr_testctx_live_count(void) { return scr_testctx_live; }
#endif

ScrTestCtx *scr_testctx_retain(ScrTestCtx *t) {
  if (t) t->rc++;
  return t;
}

static void scr_test_hooks_free(ScrTestHooks *h) {
  for (size_t i = 0; i < h->n; i++) scr_closure_release(h->v[i].cb);
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
  for (size_t i = 0; i < t->ndiags; i++) scr_str_release(t->diags[i]);
  free(t->diags);
  for (size_t i = 0; i < t->nchildren; i++) scr_testctx_release(t->children[i]);
  free(t->children);
  for (int k = 0; k < 4; k++) scr_test_hooks_free(&t->hooks[k]);
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
#ifdef SCR_RC_AUDIT
  scr_testctx_live++;
#endif
  return t;
}

static void scr_test_child_add(ScrTestCtx *parent, ScrTestCtx *child /*moves*/) {
  if (parent->nchildren == parent->ccap) {
    parent->ccap = parent->ccap ? parent->ccap * 2 : 4;
    parent->children = realloc(parent->children, parent->ccap * sizeof *parent->children);
    if (!parent->children) scr_test_oom();
  }
  child->parent = parent;
  parent->children[parent->nchildren++] = child;
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
static void scr_test_print_dur(double ms) {
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
  case SCR_TS_CHILDFAIL: return "\xE2\x9C\x96";      /* ✖ */
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

/* "<sym> <name> (<dur>ms)[ # directive]" + queued ℹ diagnostics. */
static void scr_test_report_result(ScrTestCtx *t) {
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

/* Call one stored closure by its lowering-pinned shape; async shapes are
 * awaited (the runner is a fiber). `ctx` is passed +1 when the body takes
 * the TestContext. Returns with the fiber's exception cell holding any
 * failure. */
static void scr_test_call(ScrClosure *cb, int flags, ScrTestCtx *ctx) {
  bool takes_ctx = (flags & SCR_TEST_F_CTX) != 0;
  if (flags & SCR_TEST_F_ASYNC) {
    ScrPromise *p =
        takes_ctx
            ? ((ScrPromise * (*)(ScrClosure *, ScrTestCtx *)) cb->fn)(cb, scr_testctx_retain(ctx))
            : ((ScrPromise * (*)(ScrClosure *)) cb->fn)(cb);
    if (!scr_exc_pending() && p) scr_await_void(p);
    scr_promise_release(p);
  } else if (takes_ctx) {
    ((void (*)(ScrClosure *, ScrTestCtx *))cb->fn)(cb, scr_testctx_retain(ctx));
  } else {
    ((void (*)(ScrClosure *))cb->fn)(cb);
  }
}

/* Run `which` hooks up (beforeEach: outermost suite first) or down
 * (afterEach: innermost first) the ancestor chain. A hook throw fails the
 * test with the hook's error (Node cancels harder — SEMANTICS.md). */
static void scr_test_run_hooks_of(ScrTestCtx *owner, int which) {
  for (size_t i = 0; i < owner->hooks[which].n && !scr_exc_pending(); i++) {
    scr_test_call(owner->hooks[which].v[i].cb, owner->hooks[which].v[i].flags, NULL);
  }
}

static void scr_test_run_each_hooks(ScrTestCtx *t, int which, bool outermost_first) {
  ScrTestCtx *chain[64];
  int n = 0;
  for (ScrTestCtx *p = t->parent; p && n < 64; p = p->parent) chain[n++] = p;
  if (outermost_first) {
    for (int i = n - 1; i >= 0; i--) scr_test_run_hooks_of(chain[i], which);
  } else {
    for (int i = 0; i < n; i++) scr_test_run_hooks_of(chain[i], which);
  }
}

static bool scr_test_any_only(ScrTestCtx *parent) {
  for (size_t i = 0; i < parent->nchildren; i++) {
    if (parent->children[i]->flags & SCR_TEST_F_ONLY) return true;
  }
  return false;
}

static void scr_test_run_node(ScrTestCtx *t);

static void scr_test_run_children(ScrTestCtx *t) {
  /* `only: true` among the siblings: run only the marked ones — the
   * others are dropped entirely (Node reports nothing for them). */
  bool only = scr_test_any_only(t);
  for (size_t i = 0; i < t->nchildren; i++) {
    ScrTestCtx *c = t->children[i];
    if (only && !(c->flags & SCR_TEST_F_ONLY)) {
      continue; /* filtered: never run, never reported, never counted */
    }
    /* Subtests t.test already ran INLINE at their call site. */
    if (c->state != SCR_TS_PENDING) continue;
    scr_test_run_node(c);
  }
}

static bool scr_test_subtree_failed(const ScrTestCtx *t) {
  for (size_t i = 0; i < t->nchildren; i++) {
    int s = t->children[i]->state;
    if (s == SCR_TS_FAIL || s == SCR_TS_CHILDFAIL) return true;
  }
  return false;
}

static void scr_test_run_node(ScrTestCtx *t) {
  double start = scr_now_ms();
  if (t->mode == SCR_TEST_SKIP) {
    t->dur_ms = scr_now_ms() - start;
    t->state = SCR_TS_SKIPPED;
    scr_test_report_result(t);
    return;
  }
  if (t->is_suite) {
    /* The body already ran at registration (children collected). A hook
     * throw fails the SUITE with that error — before-failures skip the
     * children (Node cancels them; SEMANTICS.md numbers the difference). */
    scr_test_run_hooks_of(t, SCR_HOOK_BEFORE);
    if (scr_exc_pending()) {
      t->err = scr_exc_take();
    } else {
      scr_test_run_children(t);
      scr_test_run_hooks_of(t, SCR_HOOK_AFTER);
      if (scr_exc_pending()) t->err = scr_exc_take();
    }
    t->dur_ms = scr_now_ms() - start;
    if (t->err) scr_test_suite_hook_failed = true;
    t->state = t->err            ? SCR_TS_FAIL
               : scr_test_subtree_failed(t) ? SCR_TS_CHILDFAIL
                                            : SCR_TS_PASS;
    scr_test_report_result(t);
    return;
  }
  /* A test: beforeEach chain, the body, subtests it queued (t.test runs
   * them inline; bare nested test() calls queued unrun run now), the
   * afterEach chain. */
  ScrTestCtx *prev_parent = scr_test_reg_parent;
  scr_test_reg_parent = t;
  scr_test_run_each_hooks(t, SCR_HOOK_BEFORE_EACH, true);
  bool failed = false;
  if (scr_exc_pending()) {
    t->err = scr_exc_take();
    failed = true;
  } else if (t->cb) {
    scr_test_call(t->cb, t->flags, t);
    if (scr_exc_pending()) {
      t->err = scr_exc_take();
      failed = true;
    }
  }
  /* Children a passing body registered without running (bare test() in
   * the body): run them now, before the parent completes — Node holds
   * the parent open for its pending subtests. */
  if (!failed) scr_test_run_children(t);
  scr_test_run_each_hooks(t, SCR_HOOK_AFTER_EACH, false);
  if (scr_exc_pending()) {
    if (!failed && !t->err) {
      t->err = scr_exc_take();
      failed = true;
    } else {
      scr_exc_clear();
    }
  }
  scr_test_reg_parent = prev_parent;
  t->dur_ms = scr_now_ms() - start;
  if (t->mode == SCR_TEST_SKIP) {
    /* t.skip() marked it mid-body. */
    t->state = SCR_TS_SKIPPED;
  } else if (t->mode == SCR_TEST_TODO) {
    t->state = failed ? SCR_TS_TODO_FAIL : SCR_TS_TODO_PASS;
  } else if (failed) {
    t->state = SCR_TS_FAIL;
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
    ScrStr *msg = scr_caught_to_string(t->err);
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
  for (size_t i = 0; i < t->nchildren; i++) {
    ScrTestCtx *c = t->children[i];
    if (!c->is_suite && (c->state == SCR_TS_FAIL || c->state == SCR_TS_TODO_FAIL) && c->err) {
      if (!*any) {
        *any = true;
        fputs("\n\xE2\x9C\x96 failing tests:\n", stdout);
      }
      scr_test_print_failure(c);
    }
    scr_test_print_failures(c, any);
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
  scr_test_run_children(root);
  scr_test_run_done = true;
  scr_test_count(root);
  scr_test_info_line("tests", (double)scr_test_ct_tests);
  scr_test_info_line("suites", (double)scr_test_ct_suites);
  scr_test_info_line("pass", (double)scr_test_ct_pass);
  scr_test_info_line("fail", (double)scr_test_ct_fail);
  scr_test_info_line("cancelled", 0);
  scr_test_info_line("skipped", (double)scr_test_ct_skipped);
  scr_test_info_line("todo", (double)scr_test_ct_todo);
  scr_test_info_line("duration_ms", round((scr_now_ms() - scr_test_t0) * 1e6) / 1e6);
  bool any = false;
  scr_test_print_failures(root, &any);
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

void scr_test_register(ScrStr *name /*borrowed*/, double mode, ScrStr *msg /*borrowed*/,
                        ScrClosure *cb /*moves, may be NULL*/, double flags,
                        ScrStr *at /*borrowed*/) {
  scr_test_ensure_root();
  scr_test_ensure_runner();
  if (scr_test_run_done) {
    /* Registration after the run completed (a late timer callback):
     * Node throws ERR_TEST_FAILURE; this runtime drops it (SEMANTICS). */
    scr_closure_release(cb);
    return;
  }
  ScrTestCtx *t = scr_test_node_new(name, (int)mode, msg, cb, (int)flags, at, false);
  scr_test_child_add(scr_test_reg_parent, t);
}

void scr_test_suite(ScrStr *name /*borrowed*/, double mode, ScrStr *msg /*borrowed*/,
                     ScrClosure *cb /*moves, may be NULL*/, ScrStr *at /*borrowed*/) {
  scr_test_ensure_root();
  scr_test_ensure_runner();
  if (scr_test_run_done) {
    scr_closure_release(cb);
    return;
  }
  ScrTestCtx *t = scr_test_node_new(name, (int)mode, msg, NULL, 0, at, true);
  scr_test_child_add(scr_test_reg_parent, t);
  /* The suite body runs NOW (Node's collection phase) — its test()/it()
   * calls attach here. Skipped suites keep their bodies unrun. */
  if (cb && (int)mode != SCR_TEST_SKIP) {
    ScrTestCtx *prev = scr_test_reg_parent;
    scr_test_reg_parent = t;
    ((void (*)(ScrClosure *))cb->fn)(cb);
    scr_test_reg_parent = prev;
  }
  scr_closure_release(cb);
}

void scr_test_hook(double which, ScrClosure *cb /*moves*/, double flags) {
  scr_test_ensure_root();
  ScrTestCtx *owner = scr_test_reg_parent;
  ScrTestHooks *h = &owner->hooks[(int)which];
  if (h->n == h->cap) {
    h->cap = h->cap ? h->cap * 2 : 2;
    h->v = realloc(h->v, h->cap * sizeof *h->v);
    if (!h->v) scr_test_oom();
  }
  h->v[h->n].cb = cb;
  h->v[h->n].flags = (int)flags;
  h->n++;
}

/* t.test(...): registers under `t` and — because subtests run inline on
 * the runner fiber at their call site (Node's awaited-subtest ordering) —
 * runs it immediately. Returns the settled promise `await t.test(...)`
 * consumes. */
ScrPromise *scr_test_sub(ScrTestCtx *t, ScrStr *name /*borrowed*/, double mode,
                          ScrStr *msg /*borrowed*/, ScrClosure *cb /*moves, may be NULL*/,
                          double flags, ScrStr *at /*borrowed*/) {
  ScrTestCtx *sub = scr_test_node_new(name, (int)mode, msg, cb, (int)flags, at, false);
  scr_test_child_add(t, sub);
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

void scr_test_ctx_diagnostic(ScrTestCtx *t, ScrStr *msg /*borrowed*/) {
  if (t->ndiags == t->dcap) {
    t->dcap = t->dcap ? t->dcap * 2 : 2;
    t->diags = realloc(t->diags, t->dcap * sizeof *t->diags);
    if (!t->diags) scr_test_oom();
  }
  t->diags[t->ndiags++] = scr_str_retain(msg);
}

ScrStr *scr_test_ctx_name(ScrTestCtx *t) {
  return t->name ? scr_str_retain(t->name) : scr_str_new("", 0);
}

int scr_test_exit_code(void) {
  /* The runner never finished: a test awaited a promise nobody settles
   * and the loop exhausted (Node cancels the test and exits 1 — the
   * summary it prints there is not reproduced; SEMANTICS.md). Never a
   * silent pass. */
  if (scr_test_runner_spawned && !scr_test_run_done) {
    fflush(stdout);
    fputs("scriptc: node:test runner never finished (a test awaited a promise nobody settles)\n", stderr);
    return 1;
  }
  return (scr_test_ct_fail > 0 || scr_test_suite_hook_failed) ? 1 : 0;
}
