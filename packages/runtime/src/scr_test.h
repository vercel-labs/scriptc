/* scriptc runtime — node:test (scr_test.c). Included by scr_runtime.h, which
 * says where new declarations go. */
#ifndef SCR_TEST_H
#define SCR_TEST_H

#include "scr_bytes.h"

/* ── node:test (scr_test.c — compiled only when the program imports it;
 * design note atop the file). Registration builds the test tree while
 * module bodies run (describe callbacks execute AT registration, Node's
 * collection phase); the first registration spawns the runner FIBER,
 * which parks one microtask hop and then runs every test sequentially
 * after main returns — sync bodies called on the fiber (its exception
 * cell isolates throws), async bodies awaited through their spawn
 * wrappers. Reporting is Node v24's spec-reporter shape on stdout;
 * durations are real (nondeterministic — harnesses normalize).
 * ScrStr arguments are BORROWED; closures MOVE. `mode`: 0 run, 1 skip,
 * 2 todo. `flags`: 1 = async body, 2 = body takes the TestContext,
 * 4 = { only: true }, 8 = a { timeout } is given, 16 = a { concurrency } is
 * given. `at` is "file:line:col" of the registration call (the
 * failing-section "test at" line), "" when unknown. `plan` is the { plan }
 * count, -1 without one; `timeout` is the { timeout } in ms, read with flag
 * 8; `concurrency` is the { concurrency } count, -1 for `true`, read with
 * flag 16. An out-of-range timeout or concurrency throws Node's
 * ERR_OUT_OF_RANGE and registers nothing. */
typedef struct ScrTestCtx ScrTestCtx;
ScrTestCtx *scr_testctx_retain(ScrTestCtx *t);
void scr_testctx_release(ScrTestCtx *t);
void *scr_testctx_retain_v(void *t);
void scr_testctx_release_v(void *t);
void scr_test_register(ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, double flags, ScrStr *at,
                       double plan, double timeout, double concurrency);
void scr_test_suite(ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, ScrStr *at,
                    double flags, double concurrency);
/* before/after/beforeEach/afterEach on the CURRENT registration parent
 * (`which`: 0 before, 1 after, 2 beforeEach, 3 afterEach); `at` is the
 * hook call's "file:line:col". The root's before and after hooks run
 * around the top-level tests. */
void scr_test_hook(double which, ScrClosure *cb, double flags, ScrStr *at);
/* t.test(...): registers under `t`, runs the subtest INLINE on the
 * runner fiber, and returns the settled promise the `await` consumes (+1). */
ScrPromise *scr_test_sub(ScrTestCtx *t, ScrStr *name, double mode, ScrStr *msg, ScrClosure *cb, double flags, ScrStr *at,
                         double plan, double timeout, double concurrency);
void scr_test_ctx_skip(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_todo(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_diagnostic(ScrTestCtx *t, ScrStr *msg);
void scr_test_ctx_hook(ScrTestCtx *t, double which, ScrClosure *cb, double flags);
void scr_test_ctx_plan(ScrTestCtx *t, double count);
void scr_test_ctx_count(ScrTestCtx *t);
ScrStr *scr_test_ctx_full_name(ScrTestCtx *t);
/* t.passed, and t.workerId as a number with 0 for undefined. */
bool scr_test_ctx_passed(ScrTestCtx *t);
double scr_test_worker_id(void);
ScrStr *scr_test_ctx_name(ScrTestCtx *t); /* +1 */
/* getTestContext(): whether a test, suite or hook is running in the
 * current async context, and its context (+1; call when has_context). */
bool scr_test_has_context(void);
ScrTestCtx *scr_test_context(void);
/* Mock trackers: the module's `mock` and each test's t.mock. track keeps
 * the closure that restores one mock; restore_all calls them in creation
 * order; reset calls them and forgets them. A test's t.mock is reset when
 * the test ends, after its t.after hooks. */
void scr_test_mock_track(ScrClosure *restore);
void scr_test_mock_restore_all(void);
void scr_test_mock_reset(void);
void scr_test_ctx_mock_track(ScrTestCtx *t, ScrClosure *restore);
void scr_test_ctx_mock_restore_all(ScrTestCtx *t);
void scr_test_ctx_mock_reset(ScrTestCtx *t);
/* Called by node:test programs right after scr_lib_init: a leading
 * --test-update-snapshots argument, Node's flag, turns on snapshot update
 * mode and moves from process.argv to process.execArgv. */
void scr_test_init(void);
/* t.assert.snapshot and t.assert.fileSnapshot. snapshot_value escapes
 * and wraps a serialized value (+1); ctx_snapshot returns the stored value
 * for the test's next snapshot id in `file` and file_snapshot the
 * contents of `path` (+1), or the recorded value in update mode. Both
 * throw Node's ERR_INVALID_STATE for missing or unreadable snapshots and
 * return NULL then. */
ScrStr *scr_test_snapshot_value(ScrStr *serialized);
ScrDyn *scr_test_snapshot_serialize(ScrDyn *value, ScrDyn *serializers);
ScrStr *scr_test_ctx_snapshot(ScrTestCtx *t, ScrStr *value, ScrStr *file);
ScrStr *scr_test_file_snapshot(ScrStr *value, ScrStr *path);
/* mock.timers on the module's `mock` and on t.mock: enable({ apis, now })
 * (`apis` one code per listed API: 'T' setTimeout, 'I' setInterval, 'M'
 * setImmediate, 'D' Date, 'W' scheduler.wait, 'A' AbortSignal.timeout;
 * flags 1 = `now` given, 2 = it came from a Date), tick, runAll, reset
 * and setTime. enable, tick, runAll and setTime throw Node's
 * ERR_INVALID_STATE and ERR_INVALID_ARG_VALUE errors, and tick and runAll
 * run the due timer callbacks, whose throws propagate. */
void scr_test_mock_timers_enable(ScrStr *apis, double now, double flags);
void scr_test_ctx_mock_timers_enable(ScrTestCtx *t, ScrStr *apis, double now, double flags);
void scr_test_mock_timers_tick(double time);
void scr_test_ctx_mock_timers_tick(ScrTestCtx *t, double time);
void scr_test_mock_timers_run_all(void);
void scr_test_ctx_mock_timers_run_all(ScrTestCtx *t);
void scr_test_mock_timers_reset(void);
void scr_test_ctx_mock_timers_reset(ScrTestCtx *t);
void scr_test_mock_timers_set_time(double time);
void scr_test_ctx_mock_timers_set_time(ScrTestCtx *t, double time);
/* The timer calls of programs that use mock.timers (moduleUsesMockTimers):
 * each queues on the API's MockTimers owner when it has one, else calls
 * the loop's function of the same shape. */
void scr_test_mt_set_timeout(ScrClosure *cb, double ms);
double scr_test_mt_set_timeout_handle(ScrClosure *cb, double ms);
double scr_test_mt_set_interval(ScrClosure *cb, double ms);
void scr_test_mt_clear_timeout(double handle);
void scr_test_mt_clear_interval(double handle);
void scr_test_mt_unref(double handle);
void scr_test_mt_ref(double handle);
void scr_test_mt_refresh(double handle);
bool scr_test_mt_has_ref(double handle);
double scr_test_mt_set_immediate(ScrClosure *cb);
void scr_test_mt_clear_immediate(double handle);
void scr_test_mt_immediate_unref(double handle);
void scr_test_mt_immediate_ref(double handle);
bool scr_test_mt_immediate_has_ref(double handle);
/* The setters of programs that also enter AsyncLocalStorage stores: an
 * unmocked call uses the loop's *_als function. */
void scr_test_mt_set_timeout_als(ScrClosure *cb, double ms);
double scr_test_mt_set_timeout_handle_als(ScrClosure *cb, double ms);
double scr_test_mt_set_interval_als(ScrClosure *cb, double ms);
double scr_test_mt_set_immediate_als(ScrClosure *cb);
double scr_test_mt_date_now(void);
/* timers/promises scheduler.wait(delay) (+1 promise; NULL after a throw). */
ScrPromise *scr_test_mt_scheduler_wait(double ms);
ScrPromise *scr_test_mt_scheduler_wait_value(double ms, ScrPromise *value, bool ref);
/* Main's epilogue (emitted when moduleUsesNodeTest): 1 when any non-todo
 * test failed, Node's exit contract. */
int scr_test_exit_code(void);
#ifdef SCR_RC_AUDIT
long scr_testctx_live_count(void);
#endif

#endif /* SCR_TEST_H */
