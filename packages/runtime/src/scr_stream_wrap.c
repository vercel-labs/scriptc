/* readable.wrap(stream) (Node's Readable.prototype.wrap in
 * lib/internal/streams/readable.js): reads an old-style stream into this
 * readable. Node listens to the source's 'data', 'end', 'error', 'close' and
 * 'destroy' events; pushes each chunk (pausing the source while this
 * readable is full), ends this readable at the source's 'end', destroys it
 * with the source's error, and destroys it when the source closes or is
 * destroyed. Its _read resumes a paused source.
 *
 * Node then copies the source's own enumerable function members whose names
 * this readable lacks, bound to the source. A native Node stream owns no
 * enumerable functions (its methods are on the prototype), so for the native
 * source this unit adapts, that loop copies nothing — the same wrapper
 * surface Node builds.
 *
 * Ownership: the context retains both streams, as Node's listeners capture
 * the wrapper and the source: a source the program drops stays readable
 * while the wrapper is paused on it. The context, both streams and the hooks
 * form a reference cycle the collector traces, so it is reclaimed once the
 * program can reach neither side. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <string.h>
#include <stdlib.h>

typedef struct WrapCtx WrapCtx;
struct WrapCtx {
  size_t rc;
  ScrStream *self; /* +1 */
  ScrStream *src;  /* +1 */
  bool paused;
};

static void wrap_trace(void *h, ScrTraceVisit visit, void *ctx) {
  WrapCtx *c = h;
  if (c->self) visit(c->self, ctx);
  if (c->src) visit(c->src, ctx);
}

/* The collector frees the traced streams itself; this just frees the block. */
static void wrap_gcfree(void *h) {
  scr_obj_free_note();
  scr_cyc_free(h);
}

static void wrap_destroy_ctx(void *h) {
  WrapCtx *c = h;
  ScrStream *self = c->self;
  ScrStream *src = c->src;
  c->self = c->src = NULL;
  if (self) scr_stream_release(self);
  if (src) scr_stream_release(src);
  wrap_gcfree(c);
}

static WrapCtx *wrap_ref(WrapCtx *c) {
  c->rc++;
  return c;
}

static void wrap_unref(void *h) {
  WrapCtx *c = h;
  if (--c->rc == 0) {
    scr_cyc_dead(c);
    scr_rc_destroy(c, wrap_destroy_ctx);
  } else {
    scr_cyc_released(c);
  }
}

static void *wrap_ref_v(void *p) { return wrap_ref(p); }

static ScrCycType wrap_cyc_type = { &wrap_trace, &wrap_gcfree, SCR_CYC_KIND_NONE, 0 };

static ScrClosure *wrap_closure(WrapCtx *c, void *fn) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(wrap_ref_v, wrap_unref, wrap_trace);
  scr_box_set_ref(cl->caps[0], wrap_ref(c));
  return cl;
}

static WrapCtx *wrap_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

static void wrap_on(ScrStream *s, const char *name, ScrClosure *cl /*moves*/,
                    ScrEeInvoke inv) {
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_emitter_release(scr_emitter_on((ScrEmitter *)s, n, cl, inv, false, false));
  scr_str_release(n);
}

static void wrap_destroy_self(WrapCtx *c) {
  if (c->self == NULL) return;
  ScrStream *d = scr_stream_destroy(c->self, NULL);
  if (d) scr_stream_release(d);
}

/* 'data': push the chunk; pause the source while the readable is full. */
static void wrap_data(ScrClosure *cl, ScrBytes *bytes, ScrStr *str, ScrDyn *value) {
  WrapCtx *c = wrap_of(cl);
  if (c->self == NULL) {
    wrap_unref(c);
    return;
  }
  bool more;
  if (value) more = scr_stream_push_dyn(c->self, value);
  else if (str) more = scr_stream_push_str(c->self, str);
  else more = scr_stream_push(c->self, bytes);
  if (!more && !c->paused && c->src != NULL) {
    c->paused = true;
    scr_stream_release(scr_stream_pause(c->src));
  }
  wrap_unref(c);
}

static void wrap_end(ScrClosure *cl) {
  WrapCtx *c = wrap_of(cl);
  if (c->self != NULL) scr_stream_push_null(c->self);
  wrap_unref(c);
}

static void wrap_error(ScrClosure *cl, void *err) {
  WrapCtx *c = wrap_of(cl);
  /* errorOrDestroy(this, err): emit the wrapper's 'error' listener, or
   * destroy it with the source's error. */
  if (c->self != NULL) scr_stream_fail(c->self, err);
  wrap_unref(c);
}

static void wrap_close(ScrClosure *cl) {
  WrapCtx *c = wrap_of(cl);
  wrap_destroy_self(c);
  wrap_unref(c);
}

/* _read: resume the source paused by the full buffer. */
static void wrap_read(ScrClosure *cl, ScrStream *s, double size) {
  (void)s;
  (void)size;
  WrapCtx *c = wrap_of(cl);
  if (c->paused && c->src != NULL) {
    c->paused = false;
    scr_stream_release(scr_stream_resume(c->src));
  }
  wrap_unref(c);
}

/* readable.wrap(stream): this readable (+1). */
ScrStream *scr_stream_wrap(ScrStream *self, ScrStream *src) {
  WrapCtx *c = scr_cyc_alloc(sizeof *c, &wrap_cyc_type);
  if (!c) abort();
  scr_obj_alloc_note();
  c->rc = 1;
  c->self = scr_stream_retain(self);
  c->src = scr_stream_retain(src);
  scr_stream_set_read(self, wrap_closure(c, (void *)&wrap_read), &wrap_read);
  wrap_on(src, "data", wrap_closure(c, (void *)&wrap_data), scr_ee_inv_fixed3);
  wrap_on(src, "end", wrap_closure(c, (void *)&wrap_end), scr_ee_inv_fixed0);
  wrap_on(src, "error", wrap_closure(c, (void *)&wrap_error), scr_ee_inv_fixed1);
  wrap_on(src, "close", wrap_closure(c, (void *)&wrap_close), scr_ee_inv_fixed0);
  wrap_on(src, "destroy", wrap_closure(c, (void *)&wrap_close), scr_ee_inv_fixed0);
  wrap_unref(c); /* the hooks own the context now */
  return scr_stream_retain(self);
}
