/* Writable.fromWeb (Node's newStreamWritableFromWritableStream in
 * lib/internal/webstreams/adapters.js): a native Writable over a web
 * WritableStream's writer. write() awaits writer.write(chunk), final() awaits
 * writer.close() and destroy() awaits writer.abort(reason); a writer that
 * closes before end() destroys the writable with ERR_STREAM_PREMATURE_CLOSE,
 * and a rejected writer.closed destroys it with that reason. */
#include "scr_runtime.h"
#include "scr_stream.h"

typedef struct SfwwCtx SfwwCtx;
struct SfwwCtx {
  size_t rc;
  ScrStream *writable; /* +1 until teardown */
  ScrDyn *writer;      /* +1 */
};

static SfwwCtx *sfww_ref(SfwwCtx *c) {
  c->rc++;
  return c;
}

static void sfww_unref(SfwwCtx *c) {
  if (--c->rc > 0) return;
  if (c->writable) scr_stream_release(c->writable);
  if (c->writer) scr_dyn_release(c->writer);
  free(c);
}

static void *sfww_ref_v(void *p) { return sfww_ref(p); }
static void sfww_unref_v(void *p) { sfww_unref(p); }

static ScrClosure *sfww_closure(void *fn, SfwwCtx *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&sfww_ref_v, &sfww_unref_v, NULL);
  scr_box_set_ref(cl->caps[0], sfww_ref(c));
  return cl;
}

static SfwwCtx *sfww_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* Every operation settles the stream through the same completion entry:
 * which 0 write, 1 final, 2 destroy; err is the rejection (borrowed) or
 * NULL when the writer's promise fulfilled. */
static void sfww_settle(SfwwCtx *c, int which, ScrDyn *err) {
  ScrStream *s = c->writable;
  ScrError *error = err ? scr_error_from_dyn(err) : NULL;
  if (s) {
    ScrError *moved = error ? scr_error_retain(error) : NULL;
    switch (which) {
    case 0: scr_stream_write_done(s, moved); break;
    case 1: scr_stream_final_done(s, moved); break;
    default: scr_stream_destroy_done(s, moved); break;
    }
  }
  if (error) scr_error_release(error);
  if (scr_exc_pending()) scr_exc_clear(); /* a continuation leaves none pending */
}

static ScrDyn *sfww_write_ok(ScrClosure *cl, ScrDyn *const *args, size_t argc);
static ScrDyn *sfww_write_err(ScrClosure *cl, ScrDyn *const *args, size_t argc);
static ScrDyn *sfww_final_ok(ScrClosure *cl, ScrDyn *const *args, size_t argc);
static ScrDyn *sfww_final_err(ScrClosure *cl, ScrDyn *const *args, size_t argc);
static ScrDyn *sfww_destroy_ok(ScrClosure *cl, ScrDyn *const *args, size_t argc);
static ScrDyn *sfww_destroy_err(ScrClosure *cl, ScrDyn *const *args, size_t argc);

/* await writer.<method>(...) for the operation: the settle runs in the
 * promise's reaction. */
static void sfww_await(SfwwCtx *c, ScrDyn *result, int which) {
  ScrDynThunk ok = which == 0   ? &sfww_write_ok
                   : which == 1 ? &sfww_final_ok
                                : &sfww_destroy_ok;
  ScrDynThunk bad = which == 0   ? &sfww_write_err
                    : which == 1 ? &sfww_final_err
                                 : &sfww_destroy_err;
  if (!result || result->kind != SCR_DYN_PROMISE) {
    sfww_settle(c, which, NULL);
    return;
  }
  ScrClosure *fc = sfww_closure((void *)ok, c);
  ScrClosure *rc = sfww_closure((void *)bad, c);
  ScrDyn *onf = scr_dyn_new_func(fc, ok, 1, "(value)", "fromWeb");
  ScrDyn *onr = scr_dyn_new_func(rc, bad, 1, "(reason)", "fromWeb");
  ScrDyn *chained = scr_dyn_promise_then(result->v.promise, onf, onr, NULL);
  if (chained) scr_dyn_release(chained);
  scr_dyn_release(onf);
  scr_dyn_release(onr);
}

static ScrDyn *sfww_write_ok(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SfwwCtx *c = sfww_of(cl);
  sfww_settle(c, 0, NULL);
  sfww_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sfww_write_err(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  SfwwCtx *c = sfww_of(cl);
  sfww_settle(c, 0, argc > 0 ? args[0] : NULL);
  sfww_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sfww_final_ok(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SfwwCtx *c = sfww_of(cl);
  sfww_settle(c, 1, NULL);
  sfww_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sfww_final_err(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  SfwwCtx *c = sfww_of(cl);
  sfww_settle(c, 1, argc > 0 ? args[0] : NULL);
  sfww_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sfww_destroy_ok(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SfwwCtx *c = sfww_of(cl);
  sfww_settle(c, 2, NULL);
  sfww_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sfww_destroy_err(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  SfwwCtx *c = sfww_of(cl);
  sfww_settle(c, 2, argc > 0 ? args[0] : NULL);
  sfww_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* writer.closed: a close before end() is Node's premature close; a
 * rejection is the writer's error. */
static void sfww_closed_settle(SfwwCtx *c, ScrDyn *reason) {
  ScrStream *s = c->writable;
  if (s && scr_stream_prop(s, "destroyed") == 0) {
    ScrError *err = NULL;
    if (reason) {
      err = scr_error_from_dyn(reason);
    } else if (scr_stream_prop(s, "writableEnded") == 0) {
      ScrStr *message = scr_str_new("Premature close", 15);
      err = scr_error_new(SCR_ERR_ERROR, message);
      scr_str_release(message);
      if (err) scr_error_set_code(err, "ERR_STREAM_PREMATURE_CLOSE");
    }
    if (err) {
      scr_stream_release(scr_stream_destroy(s, err));
      scr_error_release(err);
    }
  }
  if (scr_exc_pending()) scr_exc_clear();
}

static ScrDyn *sfww_closed_ok(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SfwwCtx *c = sfww_of(cl);
  sfww_closed_settle(c, NULL);
  sfww_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sfww_closed_err(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  SfwwCtx *c = sfww_of(cl);
  sfww_closed_settle(c, argc > 0 ? args[0] : NULL);
  sfww_unref(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* _write: writer.write(chunk) */
static void sfww_write_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  (void)s;
  SfwwCtx *c = sfww_of(cb);
  ScrDyn *value = scr_dyn_new_bytes(chunk);
  ScrDyn *args[1] = {value};
  ScrDyn *result = scr_dyn_invoke(c->writer, "write", args, 1, "writer.write");
  scr_dyn_release(value);
  sfww_await(c, result, 0);
  if (result) scr_dyn_release(result);
  sfww_unref(c);
}

/* _final: writer.close() */
static void sfww_final_inv(ScrClosure *cb, ScrStream *s) {
  (void)s;
  SfwwCtx *c = sfww_of(cb);
  ScrDyn *result = scr_dyn_invoke(c->writer, "close", NULL, 0, "writer.close");
  sfww_await(c, result, 1);
  if (result) scr_dyn_release(result);
  sfww_unref(c);
}

/* _destroy: writer.abort(reason) */
static void sfww_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  SfwwCtx *c = sfww_of(cb);
  ScrDyn *reason = err ? scr_dyn_from_error(err) : scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *args[1] = {reason};
  ScrDyn *result = scr_dyn_invoke(c->writer, "abort", args, 1, "writer.abort");
  scr_dyn_release(reason);
  sfww_await(c, result, 2);
  if (result) scr_dyn_release(result);
  sfww_unref(c);
}

/* Writable.fromWeb(writableStream): the Writable (+1), or NULL with
 * ERR_INVALID_ARG_TYPE pending for a value that is not a web WritableStream.
 * The options (objectMode, decodeStrings, highWaterMark, signal) have no
 * lowering. */
ScrStream *scr_stream_writable_from_web(ScrDyn *web, double flags) {
  (void)flags;
  if (web->kind != SCR_DYN_HANDLE || web->v.handle.tag != SCR_DYNH_WS_WRITABLE) {
    static const char message[] = "The \"writableStream\" argument must be a WritableStream";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  ScrDyn *writer = scr_dyn_invoke(web, "getWriter", NULL, 0, "writableStream.getWriter");
  if (!writer) return NULL;
  SfwwCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->writer = writer;
  ScrStream *w = scr_stream_new_writable(-1, true, true, sfww_closure((void *)&sfww_write_inv, c),
                                         &sfww_write_inv,
                                         sfww_closure((void *)&sfww_final_inv, c), &sfww_final_inv,
                                         sfww_closure((void *)&sfww_destroy_inv, c),
                                         &sfww_destroy_inv);
  c->writable = scr_stream_retain(w);
  ScrDyn *closed = scr_dyn_obj_read(writer, "closed", 6);
  if (closed && closed->kind == SCR_DYN_PROMISE) {
    ScrClosure *fc = sfww_closure((void *)&sfww_closed_ok, c);
    ScrClosure *rc = sfww_closure((void *)&sfww_closed_err, c);
    ScrDyn *onf = scr_dyn_new_func(fc, &sfww_closed_ok, 1, "(value)", "fromWeb");
    ScrDyn *onr = scr_dyn_new_func(rc, &sfww_closed_err, 1, "(reason)", "fromWeb");
    ScrDyn *chained = scr_dyn_promise_then(closed->v.promise, onf, onr, NULL);
    if (chained) scr_dyn_release(chained);
    scr_dyn_release(onf);
    scr_dyn_release(onr);
  }
  if (closed) scr_dyn_release(closed);
  sfww_unref(c);
  return w;
}
