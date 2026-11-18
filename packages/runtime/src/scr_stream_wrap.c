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
 * Ownership: the context BORROWS both streams; each one's native state slot
 * clears the context's pointer for that side when the stream is freed. The
 * listeners and the _read hook hold the context, so no untraced cycle forms. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <string.h>
#include <stdlib.h>

typedef struct WrapCtx WrapCtx;
struct WrapCtx {
  size_t rc;
  ScrStream *self; /* borrowed; NULL once freed */
  ScrStream *src;  /* borrowed; NULL once freed */
  bool paused;
};

static WrapCtx *wrap_ref(WrapCtx *c) {
  c->rc++;
  return c;
}

static void wrap_unref(WrapCtx *c) {
  if (--c->rc > 0) return;
  free(c);
}

/* One side's native state: it drops the context's borrowed pointer when
 * that stream is freed. */
typedef struct WrapSide WrapSide;
struct WrapSide {
  size_t rc;
  WrapCtx *ctx; /* +1 */
  bool source;
};

static void wrap_side_unref(void *v) {
  WrapSide *side = v;
  if (--side->rc > 0) return;
  if (side->ctx->self != NULL && !side->source) side->ctx->self = NULL;
  if (side->ctx->src != NULL && side->source) side->ctx->src = NULL;
  wrap_unref(side->ctx);
  free(side);
}

static WrapSide *wrap_side_new(WrapCtx *c, bool source) {
  WrapSide *s = calloc(1, sizeof *s);
  if (!s) abort();
  s->rc = 1;
  s->ctx = wrap_ref(c);
  s->source = source;
  return s;
}

static void *wrap_ref_v(void *p) { return wrap_ref(p); }
static void wrap_unref_v(void *p) { wrap_unref(p); }

static ScrClosure *wrap_closure(WrapCtx *c, void *fn) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(wrap_ref_v, wrap_unref_v, NULL);
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

/* readable.wrap(stream): this readable (+1). A stream that already carries
 * another unit's native state (an fs or zlib stream) cannot host the wrap
 * side state, so it is refused by name. */
ScrStream *scr_stream_wrap(ScrStream *self, ScrStream *src) {
  if (scr_stream_has_native_state(self) || (src != self && scr_stream_has_native_state(src))) {
    static const char message[] =
        "readable.wrap over a stream with native state (an fs or zlib stream) is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  WrapCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->self = self;
  c->src = src;
  scr_stream_set_read(self, wrap_closure(c, (void *)&wrap_read), &wrap_read);
  wrap_on(src, "data", wrap_closure(c, (void *)&wrap_data), scr_ee_inv_fixed3);
  wrap_on(src, "end", wrap_closure(c, (void *)&wrap_end), scr_ee_inv_fixed0);
  wrap_on(src, "error", wrap_closure(c, (void *)&wrap_error), scr_ee_inv_fixed1);
  wrap_on(src, "close", wrap_closure(c, (void *)&wrap_close), scr_ee_inv_fixed0);
  wrap_on(src, "destroy", wrap_closure(c, (void *)&wrap_close), scr_ee_inv_fixed0);
  scr_stream_set_native(self, wrap_side_new(c, false), &wrap_side_unref);
  scr_stream_set_native(src, wrap_side_new(c, true), &wrap_side_unref);
  wrap_unref(c); /* the hooks and the side states own the context now */
  return scr_stream_retain(self);
}
