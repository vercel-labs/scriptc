/* `for await` over a checked-dynamic value in a program that links the
 * stream unit: a native readable stream behind the value (a boxed stream,
 * or a Cipheriv/Decipheriv handle's Transform) iterates through an
 * iterator object whose next() answers the readable iterator's step as
 * { value, done } and whose return() closes it as a typed loop does
 * (destroy with an AbortError). Any other value takes
 * scr_dyn_async_iterator_open. Linked only by programs with such a loop
 * and streams. */
#include "scr_runtime.h"
#include "scr_stream.h"

/* caps[0]: the stream */
static ScrStream *iter_stream(ScrClosure *clo) {
  return scr_box_get_ref(clo->caps[0]); /* +1 */
}

static ScrDyn *iter_next_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrStream *s = iter_stream(clo);
  ScrPromise *p = scr_stream_next_result_dyn(s);
  scr_stream_release(s);
  ScrDyn *d = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return d;
}

static ScrDyn *iter_return_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrStream *s = iter_stream(clo);
  scr_stream_release(scr_stream_iterator_close(s));
  scr_stream_release(s);
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(true));
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_ref(p, result, scr_dyn_retain_v, scr_dyn_release_v, NULL);
  ScrDyn *d = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return d;
}

static ScrDyn *iter_method(ScrStream *s, ScrDynThunk thunk, const char *name) {
  ScrClosure *clo = scr_closure_new((void *)thunk, 1);
  clo->caps[0] = scr_box_new_obj(&scr_stream_retain_v, &scr_stream_release_v, &scr_stream_trace);
  scr_box_set_ref(clo->caps[0], scr_stream_retain(s));
  return scr_dyn_new_func(clo, thunk, 0, "()", name);
}

ScrDyn *scr_stream_dyn_async_iterator_open(ScrDyn *value, ScrStr *spell) {
  ScrStream *s = scr_stream_native_readable_of_dyn(value);
  if (!s) return scr_dyn_async_iterator_open(value, spell);
  /* the loop awaits its results with the async protocol */
  scr_dyn_async_iterator_set_sync(false);
  ScrDyn *it = scr_dyn_new_obj();
  scr_dyn_obj_set(it, "next", 4, iter_method(s, &iter_next_thunk, "next"));
  scr_dyn_obj_set(it, "return", 6, iter_method(s, &iter_return_thunk, "return"));
  scr_stream_release(s);
  return it;
}
