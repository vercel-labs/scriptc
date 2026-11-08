/* Node islands: the process events Node raises itself. Links with
 * scr_node_island.c (the `nodeIsland` runtime feature) and nothing else.
 *
 * A program with a Node island is one process, so it has one list of
 * listeners for `uncaughtException`, `uncaughtExceptionMonitor`,
 * `unhandledRejection`, `rejectionHandled` and `warning`, and one
 * `process.exitCode`. Before Node is loaded the runtime's own registries
 * hold the native listeners (scr_async_dyn.c), as in a program without
 * islands. Once Node is loaded, Node's `process` is the registry, as its
 * queues are the queues (scr_async.c's hosted loop):
 *
 *  - scr_process_events_to_node (the SCR_NODE_ISLANDS build of
 *    scr_async_dyn.c) moves the native listeners onto `process` in their
 *    order, and every later native registration, removal and prepend goes
 *    there too (scr_ni_process_listen). A native listener is the function
 *    it is: it crosses as its export, one V8 function per closure, so
 *    `off` finds it, `listenerCount` counts it and `once` removes it;
 *  - an error native code lets escape is raised through
 *    process._fatalException (scr_ni_uncaught): the monitors, the capture
 *    callback, the listeners of both sides in their order;
 *  - a rejected native promise nobody handles is handed to Node's own
 *    tracking as its V8 promise (scr_ni_promise_unhandled), which emits
 *    `unhandledRejection` under the mode Node runs in, and
 *    `rejectionHandled` when native code handles it later
 *    (scr_ni_promise_handled);
 *  - a warning native code emits is emitted on `process`
 *    (scr_ni_warning): Node's own listener prints it;
 *  - process.exitCode is Node's property (scr_ni_exit_code).
 *
 * Signals and 'exit' stay in the runtime's registries (scr_events.c), which
 * own the dispositions and the exit sequence and already order both sides.
 * Everything here runs on the main thread: a worker thread has registries
 * of its own and no Node. */
#include "scr_runtime.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

/* process.on (0), once (1), prependListener (2), removeListener (3) or
 * prependOnceListener (4) of a native listener. A JavaScript throw (a `newListener` listener's) is left
 * pending, as the registration throws in Node. */
void scr_ni_process_listen(int mode, const char *event, ScrDyn *listener) {
  ScrStr *name = scr_str_new(event, strlen(event));
  ScrDyn *args[3] = {scr_dyn_new_num((double)mode), scr_dyn_new_str(name), listener};
  scr_str_release(name);
  scr_dyn_release(scr_ni_helper("processListen", args, 3));
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
}

/* Whether a value can cross into Node (a native symbol cannot). */
static bool ne_crosses(ScrDyn *value) {
  ScrNodeValue out;
  bool ok = false;
  scr_ni_value_out_end(scr_ni_value_out_begin(value, &out, &ok));
  if (!ok && scr_exc_pending()) scr_exc_clear();
  return ok;
}

/* A helper call from a place that may be unwinding: the caller's pending
 * exception stays as it is, and the call leaves none of its own. */
static void ne_call_quiet(const char *name, ScrDyn *const *args, size_t argc) {
  ScrCaught *pending = scr_exc_pending() ? scr_exc_take() : NULL;
  scr_dyn_release(scr_ni_helper(name, args, argc));
  if (scr_exc_pending()) scr_exc_clear();
  if (pending != NULL) {
    scr_rethrow(pending);
    scr_caught_release(pending);
  }
}

/* scr_uncaught_exception_hook once Node is loaded: the pending exception
 * goes through Node's process._fatalException. 1: handled; 0: nobody
 * handled it and it is pending again for the runtime's report; -1: a
 * listener threw, and that error is pending instead. */
int scr_ni_uncaught(bool from_promise) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *error = scr_caught_to_dyn(caught);
  int result = 0;
  /* A value that cannot cross reaches no listener. */
  if (error != NULL && ne_crosses(error)) {
    scr_ni_error_link(error);
    ScrDyn *args[2] = {error, scr_dyn_new_bool(from_promise)};
    ScrDyn *handled = scr_ni_helper("processUncaught", args, 2);
    scr_dyn_release(args[1]);
    if (handled == NULL || scr_exc_pending()) result = -1;
    else if (handled->kind == SCR_DYN_BOOL && handled->v.b) result = 1;
    scr_dyn_release(handled);
  }
  scr_dyn_release(error);
  if (result == 0) scr_rethrow(caught);
  scr_caught_release(caught);
  return result;
}

/* A rejected native promise nobody observed at the checkpoint: Node tracks
 * it from here. Crossing creates its V8 promise, which the bridge rejects
 * at once and without a handler (scr_ni_host_export_watch), so Node raises
 * `unhandledRejection` after this checkpoint, where it raises its own. */
void scr_ni_promise_unhandled(ScrPromise *p) {
  ScrDyn *reason = scr_promise_reason_dyn(p);
  if (reason != NULL) scr_ni_error_link(reason);
  scr_dyn_release(reason);
  ScrDyn *boxed = scr_dyn_new_promise(p);
  ne_call_quiet("processRejected", &boxed, 1);
  scr_dyn_release(boxed);
}

/* scr_rjh_notify_fn once Node is loaded: native code reacts to a promise
 * whose V8 promise carries the tracking, so that one is handled too. Node
 * raises `rejectionHandled` if it had reported the rejection. */
void scr_ni_promise_handled(ScrPromise *p) {
  if (!scr_context_is_main() || !scr_ni_running()) return;
  ScrDyn *boxed = scr_dyn_new_promise(p);
  ne_call_quiet("processHandled", &boxed, 1);
  scr_dyn_release(boxed);
}

/* A warning native code emitted, on Node's `process`. `code` and `detail`
 * (NULL, or any value: only strings count) are the warning's own, which
 * its V8 error does not carry. `no_deprecation`: process.noDeprecation is
 * set in native code now, which Node's report reads from its own
 * `process`. false with the exception pending when a listener threw. */
bool scr_ni_warning(ScrDyn *warning, ScrDyn *code, ScrDyn *detail, bool no_deprecation) {
  scr_ni_error_link(warning);
  ScrDyn *none = scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *args[4] = {warning, scr_dyn_new_bool(no_deprecation), code != NULL ? code : none,
                     detail != NULL ? detail : none};
  ScrDyn *r = scr_ni_helper("processWarning", args, 4);
  scr_dyn_release(args[1]);
  scr_dyn_release(none);
  bool ok = r != NULL && !scr_exc_pending();
  scr_dyn_release(r);
  return ok;
}

/* process.exitCode in Node. `set`: assigns `code` first. Answers whether a
 * code is set and, in *out, the code. -1 when Node cannot answer (not
 * loaded, stopped, or another thread): the runtime's own value stands. */
int scr_ni_exit_code(bool set, double code, double *out) {
  if (scr_exc_pending() || !scr_context_is_main() || !scr_ni_running()) return -1;
  ScrDyn *args[2] = {scr_dyn_new_bool(set), scr_dyn_new_num(code)};
  ScrDyn *r = scr_ni_helper("processExitCode", args, 2);
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  int state = -1;
  if (r != NULL && !scr_exc_pending()) {
    state = r->kind == SCR_DYN_NUM ? 1 : 0;
    if (state == 1) *out = r->v.num;
  }
  scr_dyn_release(r);
  if (scr_exc_pending()) scr_exc_clear();
  return state;
}

/* process.exitCode in a program with islands (island-process-state.ts
 * routes the program's reads and writes here): Node's property once Node
 * is loaded, the runtime's own value before. */
void scr_node_island_set_exit_code(double code) {
  scr_process_set_exit_code_tracked(code);
  if (scr_exc_pending()) return; /* a code Node refuses too */
  double ignored;
  (void)scr_ni_exit_code(true, scr_process_exit_code_or_zero(), &ignored);
}

double scr_node_island_exit_code(void) {
  double code = 0;
  int state = scr_ni_exit_code(false, 0, &code);
  if (state < 0) return scr_process_exit_code_or_zero();
  return state == 1 ? code : 0;
}

bool scr_node_island_has_exit_code(void) {
  double code = 0;
  int state = scr_ni_exit_code(false, 0, &code);
  return state < 0 ? scr_process_has_exit_code() : state == 1;
}

/* process.chdir in a program with islands (island-process-state.ts): the
 * working directory is the process's, and Node caches process.cwd() until
 * its own process.chdir runs. After the program's change Node changes to
 * ".", which keeps the directory and drops the cached answer. A Node that
 * is not loaded yet reads the directory when it starts. */
void scr_node_island_chdir(ScrStr *dir) {
  scr_process_chdir(dir);
  if (scr_exc_pending() || !scr_context_is_main() || !scr_ni_running()) return;
  scr_dyn_release(scr_ni_helper("processChdir", NULL, 0));
  /* The program's own change succeeded: a directory that vanished since
   * leaves Node's cached answer, which its next process.chdir replaces. */
  if (scr_exc_pending()) scr_exc_clear();
}

#endif
