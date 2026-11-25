/* Node islands: one process.stdout.write for the program and its islands.
 * Links only into programs that have Node islands and hold a process output
 * stream as a value (the `nodeIsland` and `stdioObject` runtime features),
 * with the SCR_NODE_ISLAND_STDIO build of scr_node_island.c, which calls
 * scr_ni_stdio_started when Node has started.
 *
 * Only such a program can replace process.stdout.write or
 * process.stderr.write: the replacement is a store into the stream object's
 * write slot (scr_events.c), and the stream object exists only where the
 * program takes it as a value. In Node there is one stream, so a replacement
 * sees every write of the program. Here the island's Node has its own
 * process.stdout over the same descriptor, so the two are joined: the
 * program's slot stays the only one, and the island's streams read and write
 * it through an accessor (scr_node_island_stdio.cjs). This unit gives that
 * accessor its three operations as native functions, and wraps what island
 * code stores:
 *
 *  - stdioGetWrite(fd): the slot's value. A function island code stored
 *    comes back as that island function.
 *  - stdioSetWrite(fd, value): stores into the slot. An island function is
 *    stored as a native function that calls it in Node with the island's
 *    stream as `this`, because the program's writes call the slot with the
 *    program's stream object, which is not a value Node can hold.
 *  - stdioWrite(fn, fd, ...args): calls a program function the island read
 *    from the slot (the stream's own write method, or a replacement the
 *    program installed) with the program's stream as `this`. Island
 *    functions among the arguments are wrapped the same way.
 *
 * Nothing here runs until Node starts, and a program whose islands never
 * touch process.stdout.write pays one helper call at that point. */
#include "scr_runtime.h"
#include "scr_node_island.h"

#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

/* The bootstrap's `invoke(fn, fd, ...args)`: calls an island function with
 * the island's stream for `fd` as `this`. */
static ScrDyn *nis_invoke = NULL;

static int nis_fd(ScrDyn *const *args, size_t argc, size_t i) {
  if (i >= argc || args[i]->kind != SCR_DYN_NUM) return 0;
  return args[i]->v.num == 1 ? 1 : args[i]->v.num == 2 ? 2 : 0;
}

/* An island function as the program holds it: the function island code
 * stored in the slot, or one it passed to a program function. Called with
 * the island's stream as `this` when the program calls it on its own
 * stream object, and with no receiver otherwise. */
static ScrDyn *nis_island_write(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrDyn *fn = scr_box_get_ref(cb->caps[0]);
  /* After the exit sequence released the helper: the island function with
   * no receiver. */
  if (nis_invoke == NULL) {
    ScrDyn *result = scr_ni_call(fn, scr_dyn_undefined(), args, argc);
    scr_dyn_release(fn);
    return result;
  }
  ScrDyn *self = scr_dyn_this_get();
  double fd = scr_dyn_process_stdio_is(self) ? scr_dyn_process_stdio_fd(self, NULL) : 0;
  scr_dyn_release(self);
  ScrDyn *small[8];
  ScrDyn **all = argc + 2 <= 8 ? small : malloc((argc + 2) * sizeof *all);
  if (all == NULL) scr_trap("scriptc: out of memory\n");
  all[0] = fn;
  all[1] = scr_dyn_new_num(fd);
  for (size_t i = 0; i < argc; i++) all[i + 2] = args[i];
  ScrDyn *result = scr_ni_call(nis_invoke, scr_dyn_undefined(), all, argc + 2);
  scr_dyn_release(all[1]);
  if (all != small) free(all);
  scr_dyn_release(fn);
  return result;
}

static bool nis_is_island_write(const ScrDyn *value) {
  return value->kind == SCR_DYN_FUNC && value->v.fn.thunk == nis_island_write;
}

static ScrDyn *nis_island_write_new(ScrDyn *fn) {
  ScrClosure *cb = scr_closure_new(NULL, 1);
  cb->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(cb->caps[0], scr_dyn_retain(fn));
  return scr_dyn_new_func(cb, nis_island_write, 3, "", "");
}

static ScrDyn *nis_get(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)cb;
  int fd = nis_fd(args, argc, 0);
  if (fd == 0) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *stream = scr_process_stdio(fd);
  ScrDyn *value = scr_dyn_handle_ops_of(stream)->get(stream->v.handle.ptr, "write", 5);
  scr_dyn_release(stream);
  if (value == NULL) return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  if (!nis_is_island_write(value)) return value;
  ScrDyn *fn = scr_box_get_ref(value->v.fn.clo->caps[0]);
  scr_dyn_release(value);
  return fn;
}

static ScrDyn *nis_set(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)cb;
  int fd = nis_fd(args, argc, 0);
  if (fd == 0) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *value = argc > 1 ? args[1] : scr_dyn_undefined();
  ScrDyn *wrapped = scr_ni_is_function(value) ? nis_island_write_new(value) : NULL;
  ScrDyn *stream = scr_process_stdio(fd);
  (void)scr_dyn_handle_ops_of(stream)->set(stream->v.handle.ptr, "write", 5,
                                            wrapped != NULL ? wrapped : value);
  scr_dyn_release(stream);
  scr_dyn_release(wrapped);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *nis_call(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)cb;
  ScrDyn *fn = argc > 0 ? args[0] : scr_dyn_undefined();
  int fd = nis_fd(args, argc, 1);
  size_t n = argc > 2 ? argc - 2 : 0;
  /* An island function among the arguments (console's error handler, a
   * write callback) is a native function for the call: the stream's own
   * write method takes its callback by kind, and calls it on a later tick. */
  ScrDyn *small[8];
  ScrDyn **in = n <= 8 ? small : malloc(n * sizeof *in);
  if (in == NULL) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < n; i++)
    in[i] = scr_ni_is_function(args[i + 2]) ? nis_island_write_new(args[i + 2]) : scr_dyn_retain(args[i + 2]);
  ScrDyn *self = fd != 0 ? scr_process_stdio(fd) : scr_dyn_retain(scr_dyn_undefined());
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, in, n, "write");
  scr_dyn_this_pop();
  scr_dyn_release(self);
  for (size_t i = 0; i < n; i++) scr_dyn_release(in[i]);
  if (in != small) free(in);
  return result;
}

/* At exit the helper is the unit's own reference, not the program's. The
 * exit sequence releases it after the 'exit' listeners, whose writes still
 * call island functions with the island's stream as `this`. */
void scr_ni_stdio_stop(void) {
  scr_dyn_release(nis_invoke);
  nis_invoke = NULL;
}

void scr_ni_stdio_started(void) {
  ScrStr *path = scr_str_new("scriptc:island-helpers", 22);
  ScrDyn *helpers = scr_ni_require(path);
  scr_str_release(path);
  ScrDyn *natives[3] = {
      scr_dyn_new_func(scr_closure_new(NULL, 0), nis_get, 1, "", "stdioGetWrite"),
      scr_dyn_new_func(scr_closure_new(NULL, 0), nis_set, 2, "", "stdioSetWrite"),
      scr_dyn_new_func(scr_closure_new(NULL, 0), nis_call, 2, "", "stdioWrite"),
  };
  if (helpers != NULL) nis_invoke = scr_ni_call_method(helpers, "shareStdio", 10, natives, 3);
  if (nis_invoke == NULL)
    scr_trap("scriptc: cannot share the process output streams with this program's Node islands\n");
  /* The accessor's closures hold the three natives from here on. */
  for (int i = 0; i < 3; i++) scr_dyn_release(natives[i]);
  scr_dyn_release(helpers);
}

#else

void scr_ni_stdio_started(void) {}
void scr_ni_stdio_stop(void) {}

#endif /* !_WIN32 && !__wasi__ */
