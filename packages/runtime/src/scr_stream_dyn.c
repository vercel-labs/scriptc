/* Checked-dynamic stream slots (the compiler's dyn-streams.ts).
 *
 * A program whose NodeJS.ReadableStream / NodeJS.WritableStream slots also
 * hold JavaScript stream objects compiles them as checked-dynamic values: a
 * native stream rides its typed capsule, any other value is the JavaScript
 * object itself. Member calls test the value here and take the native
 * stream path or the value's own members. Linked only by such programs
 * (the stream and dyn-invoke units together). */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

static bool scr_stream_dyn_within(const ScrVt *vt, const ScrVt *cls) {
  return vt == cls || (cls->pre <= vt->pre && vt->pre <= cls->post);
}

/* The native stream a checked-dynamic value boxes (+1), when it has the
 * requested side (1 readable, 2 writable; Duplex, Transform and PassThrough
 * have both), or the stream of a stream handle, or NULL for any other
 * value. Never throws. */
ScrStream *scr_stream_dyn_native(const ScrDyn *value, double side) {
  /* A Cipheriv or Decipheriv is a Transform. */
  if (value->kind == SCR_DYN_HANDLE) return scr_stream_of_handle(value);
  if (value->kind != SCR_DYN_TYPED_REF || value->v.typed_ref.type_key_len <= 7 ||
      memcmp(value->v.typed_ref.type_key, "object:", 7) != 0)
    return NULL;
  ScrStream *stream = scr_dyn_typed_ref_unbox(value);
  const ScrVt *vt = scr_stream_vt_of(stream);
  if (vt == NULL) {
    value->v.typed_ref.release(stream);
    return NULL;
  }
  bool duplex = scr_stream_dyn_within(vt, &scr_duplex_vt) ||
                scr_stream_dyn_within(vt, &scr_transform_vt) ||
                scr_stream_dyn_within(vt, &scr_passthrough_vt);
  bool ok = duplex || (side == 1 ? scr_stream_dyn_within(vt, &scr_readable_vt)
                                 : scr_stream_dyn_within(vt, &scr_writable_vt));
  if (ok) return stream;
  value->v.typed_ref.release(stream);
  return NULL;
}

/* ── readable.pipe(destination) into a JavaScript stream object ─────────
 * Node's Readable.prototype.pipe (lib/internal/streams/readable.js) over a
 * native source and a destination that is not a native stream: the same
 * listeners in the same order, with the destination's members called
 * through the dyn-invoke unit. The context holds the source, its boxed
 * value (what 'pipe' and 'unpipe' pass), the destination and the boxed
 * listeners until cleanup; the live list breaks the listener cycles at
 * exit without calling JavaScript. */

enum {
  SCR_DYN_PIPE_DATA,
  SCR_DYN_PIPE_END,
  SCR_DYN_PIPE_UNPIPE,
  SCR_DYN_PIPE_DRAIN,
  SCR_DYN_PIPE_ERROR,
  SCR_DYN_PIPE_CLOSE,
  SCR_DYN_PIPE_FINISH,
  SCR_DYN_PIPE_ON_UNPIPE,
  SCR_DYN_PIPE_COUNT
};

typedef struct ScrDynPipe {
  size_t rc;
  ScrStream *src;    /* +1 until dropped */
  ScrDyn *src_box;   /* +1 until dropped */
  ScrDyn *dest;      /* +1 until dropped */
  ScrDyn *l[SCR_DYN_PIPE_COUNT]; /* +1 boxed listeners, or NULL */
  bool end, cleaned, awaiting_drain, unpiped;
  struct ScrDynPipe *live_prev, *live_next;
} ScrDynPipe;

static SCR_TL ScrDynPipe *scr_dyn_pipe_live = NULL;

/* A string value for an event name (+1). */
static ScrDyn *scr_dyn_pipe_str(const char *text, size_t len) {
  ScrStr *s = scr_str_new(text, len);
  ScrDyn *value = scr_dyn_new_str(s);
  scr_str_release(s);
  return value;
}
static SCR_TL bool scr_dyn_pipe_atexit_set = false;

static void *scr_dyn_pipe_retain_v(void *p) {
  ((ScrDynPipe *)p)->rc++;
  return p;
}

static void scr_dyn_pipe_drop(ScrDynPipe *p) {
  if (p->live_prev) p->live_prev->live_next = p->live_next;
  else if (scr_dyn_pipe_live == p) scr_dyn_pipe_live = p->live_next;
  if (p->live_next) p->live_next->live_prev = p->live_prev;
  p->live_prev = p->live_next = NULL;
  for (size_t i = 0; i < SCR_DYN_PIPE_COUNT; i++) {
    ScrDyn *l = p->l[i];
    p->l[i] = NULL;
    if (l) scr_dyn_release(l);
  }
  if (p->src) {
    ScrStream *src = p->src;
    p->src = NULL;
    scr_stream_release(src);
  }
  if (p->src_box) {
    ScrDyn *box = p->src_box;
    p->src_box = NULL;
    scr_dyn_release(box);
  }
  if (p->dest) {
    ScrDyn *dest = p->dest;
    p->dest = NULL;
    scr_dyn_release(dest);
  }
}

static void scr_dyn_pipe_release_v(void *v) {
  ScrDynPipe *p = v;
  if (--p->rc > 0) return;
  scr_dyn_pipe_drop(p);
  free(p);
}

static void scr_dyn_pipe_atexit(void) {
  while (scr_dyn_pipe_live) {
    ScrDynPipe *p = scr_dyn_pipe_retain_v(scr_dyn_pipe_live);
    scr_dyn_pipe_drop(p);
    scr_dyn_pipe_release_v(p);
  }
}

/* destination.method(args...), the result discarded; false on a throw. */
static bool scr_dyn_pipe_call(ScrDynPipe *p, const char *method, ScrDyn *const *args, size_t argc) {
  ScrDyn *result = scr_dyn_invoke(p->dest, method, args, argc, method);
  if (result) scr_dyn_release(result);
  return !scr_exc_pending();
}

static bool scr_dyn_pipe_dest_off(ScrDynPipe *p, const char *event, size_t which) {
  if (!p->l[which]) return true;
  ScrDyn *args[2] = {scr_dyn_pipe_str(event, strlen(event)), p->l[which]};
  bool ok = scr_dyn_pipe_call(p, "removeListener", args, 2);
  scr_dyn_release(args[0]);
  return ok;
}

static void scr_dyn_pipe_src_off(ScrDynPipe *p, const char *event, size_t which) {
  if (!p->l[which] || !p->src) return;
  ScrStr *name = scr_str_new(event, strlen(event));
  scr_emitter_release(scr_emitter_off_dyn((ScrEmitter *)p->src, name, p->l[which]));
  scr_str_release(name);
}

static void scr_dyn_pipe_ondrain(ScrDynPipe *p) {
  p->awaiting_drain = false;
  if (!p->src) return;
  ScrStr *data = scr_str_new("data", 4);
  double listeners = scr_emitter_listener_count((ScrEmitter *)p->src, data);
  scr_str_release(data);
  if (listeners > 0) scr_stream_release(scr_stream_resume(p->src));
}

/* pipe's cleanup(): every listener off, then a pending drain resumes. */
static void scr_dyn_pipe_cleanup(ScrDynPipe *p) {
  if (p->cleaned) return;
  if (!scr_dyn_pipe_dest_off(p, "close", SCR_DYN_PIPE_CLOSE) ||
      !scr_dyn_pipe_dest_off(p, "finish", SCR_DYN_PIPE_FINISH) ||
      !scr_dyn_pipe_dest_off(p, "drain", SCR_DYN_PIPE_DRAIN) ||
      !scr_dyn_pipe_dest_off(p, "error", SCR_DYN_PIPE_ERROR) ||
      !scr_dyn_pipe_dest_off(p, "unpipe", SCR_DYN_PIPE_ON_UNPIPE))
    return;
  scr_dyn_pipe_src_off(p, "end", SCR_DYN_PIPE_END);
  scr_dyn_pipe_src_off(p, "end", SCR_DYN_PIPE_UNPIPE);
  scr_dyn_pipe_src_off(p, "data", SCR_DYN_PIPE_DATA);
  p->cleaned = true;
  if (p->l[SCR_DYN_PIPE_DRAIN] && p->awaiting_drain) scr_dyn_pipe_ondrain(p);
  ScrDynPipe *held = scr_dyn_pipe_retain_v(p);
  scr_dyn_pipe_drop(held);
  scr_dyn_pipe_release_v(held);
}

/* src.unpipe(dest): the source pauses (its only pipe goes) and the
 * destination hears 'unpipe' with { hasUnpiped: false }. */
static void scr_dyn_pipe_unpipe(ScrDynPipe *p) {
  if (p->unpiped || !p->src) return;
  p->unpiped = true;
  scr_stream_release(scr_stream_pause(p->src));
  ScrDyn *info = scr_dyn_new_obj();
  scr_dyn_obj_set(info, "hasUnpiped", 10, scr_dyn_new_bool(false));
  ScrDyn *args[3] = {scr_dyn_pipe_str("unpipe", 6), scr_dyn_retain(p->src_box), info};
  (void)scr_dyn_pipe_call(p, "emit", args, 3);
  for (size_t i = 0; i < 3; i++) scr_dyn_release(args[i]);
}

static ScrDyn *scr_dyn_pipe_listener(ScrDynPipe *p, int kind);

/* pipe's pause(): the source stops until the destination drains. */
static void scr_dyn_pipe_pause(ScrDynPipe *p) {
  if (!p->cleaned) {
    p->awaiting_drain = true;
    scr_stream_release(scr_stream_pause(p->src));
  }
  if (!p->l[SCR_DYN_PIPE_DRAIN] && p->dest) {
    p->l[SCR_DYN_PIPE_DRAIN] = scr_dyn_pipe_listener(p, SCR_DYN_PIPE_DRAIN);
    ScrDyn *args[2] = {scr_dyn_pipe_str("drain", 5), p->l[SCR_DYN_PIPE_DRAIN]};
    (void)scr_dyn_pipe_call(p, "on", args, 2);
    scr_dyn_release(args[0]);
  }
}

static ScrDyn *scr_dyn_pipe_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrDynPipe *p = scr_box_get_ref(clo->caps[0]); /* +1 */
  int kind = (int)scr_box_get_f64(clo->caps[1]);
  ScrDyn *first = argc ? args[0] : scr_dyn_undefined();
  switch (kind) {
  case SCR_DYN_PIPE_DATA: {
    if (!p->dest) break;
    ScrDyn *ret = scr_dyn_invoke(p->dest, "write", &first, 1, "write");
    if (ret) {
      if (ret->kind == SCR_DYN_BOOL && !scr_dyn_truthy(ret)) scr_dyn_pipe_pause(p);
      scr_dyn_release(ret);
    }
    break;
  }
  case SCR_DYN_PIPE_END:
    if (p->dest) (void)scr_dyn_pipe_call(p, "end", NULL, 0);
    break;
  case SCR_DYN_PIPE_UNPIPE:
    scr_dyn_pipe_unpipe(p);
    break;
  case SCR_DYN_PIPE_DRAIN:
    scr_dyn_pipe_ondrain(p);
    break;
  case SCR_DYN_PIPE_ERROR: {
    if (!p->dest) break;
    ScrDyn *dest = scr_dyn_retain(p->dest);
    ScrDyn *self = scr_dyn_retain(p->l[SCR_DYN_PIPE_ERROR]);
    scr_dyn_pipe_unpipe(p);
    if (!scr_exc_pending()) {
      ScrDyn *off[2] = {scr_dyn_pipe_str("error", 5), self};
      ScrDyn *r = scr_dyn_invoke(dest, "removeListener", off, 2, "removeListener");
      if (r) scr_dyn_release(r);
      ScrDyn *count = scr_exc_pending() ? NULL : scr_dyn_invoke(dest, "listenerCount", off, 1, "listenerCount");
      if (count && count->kind == SCR_DYN_NUM && !scr_dyn_truthy(count)) {
        ScrDyn *emit[2] = {off[0], first};
        r = scr_dyn_invoke(dest, "emit", emit, 2, "emit");
        if (r) scr_dyn_release(r);
      }
      if (count) scr_dyn_release(count);
      scr_dyn_release(off[0]);
    }
    scr_dyn_release(self);
    scr_dyn_release(dest);
    break;
  }
  case SCR_DYN_PIPE_CLOSE:
    if (scr_dyn_pipe_dest_off(p, "finish", SCR_DYN_PIPE_FINISH)) scr_dyn_pipe_unpipe(p);
    break;
  case SCR_DYN_PIPE_FINISH:
    if (scr_dyn_pipe_dest_off(p, "close", SCR_DYN_PIPE_CLOSE)) scr_dyn_pipe_unpipe(p);
    break;
  case SCR_DYN_PIPE_ON_UNPIPE: {
    ScrDyn *info = argc > 1 ? args[1] : NULL;
    if (p->src_box && scr_dyn_strict_eq(first, p->src_box) && info && info->kind == SCR_DYN_OBJ) {
      ScrDyn *has = scr_dyn_obj_read(info, "hasUnpiped", 10);
      if (!has || scr_exc_pending()) { /* a throwing getter */
        if (has) scr_dyn_release(has);
        break;
      }
      bool unpiped = has->kind == SCR_DYN_BOOL && !scr_dyn_truthy(has);
      scr_dyn_release(has);
      if (unpiped) {
        scr_dyn_obj_set(info, "hasUnpiped", 10, scr_dyn_new_bool(true));
        scr_dyn_pipe_cleanup(p);
      }
    }
    break;
  }
  }
  scr_dyn_pipe_release_v(p);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_dyn_pipe_listener(ScrDynPipe *p, int kind) {
  ScrClosure *clo = scr_closure_new((void *)scr_dyn_pipe_thunk, 2);
  clo->caps[0] = scr_box_new_obj(scr_dyn_pipe_retain_v, scr_dyn_pipe_release_v, NULL);
  scr_box_set_ref(clo->caps[0], scr_dyn_pipe_retain_v(p));
  clo->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(clo->caps[1], (double)kind);
  return scr_dyn_new_func(clo, scr_dyn_pipe_thunk, 1, "native pipe listener", NULL);
}

/* destination.on / once / prependListener(event, listener) */
static bool scr_dyn_pipe_listen(ScrDynPipe *p, const char *method, const char *event, int kind) {
  p->l[kind] = scr_dyn_pipe_listener(p, kind);
  ScrDyn *args[2] = {scr_dyn_pipe_str(event, strlen(event)), p->l[kind]};
  bool ok = scr_dyn_pipe_call(p, method, args, 2);
  scr_dyn_release(args[0]);
  return ok;
}

static void scr_dyn_pipe_src_on(ScrDynPipe *p, const char *event, int kind, bool once) {
  p->l[kind] = scr_dyn_pipe_listener(p, kind);
  ScrStr *name = scr_str_new(event, strlen(event));
  scr_stream_release(scr_stream_on_dyn(p->src, name, p->l[kind], once, false));
  scr_str_release(name);
}

/* readable.pipe(destination, { end }) for a destination that is not a
 * native stream. src and src_box (the source's boxed value) and dest are
 * borrowed. Throws what the destination's members throw. */
void scr_stream_pipe_dyn(ScrStream *src, ScrDyn *src_box, ScrDyn *dest, bool end) {
  ScrDynPipe *p = calloc(1, sizeof *p);
  if (!p) abort();
  p->rc = 1;
  p->src = scr_stream_retain(src);
  p->src_box = scr_dyn_retain(src_box);
  p->dest = scr_dyn_retain(dest);
  p->end = end;
  p->live_next = scr_dyn_pipe_live;
  if (scr_dyn_pipe_live) scr_dyn_pipe_live->live_prev = p;
  scr_dyn_pipe_live = p;
  if (!scr_dyn_pipe_atexit_set) {
    scr_dyn_pipe_atexit_set = true;
    scr_atexit(scr_dyn_pipe_atexit);
  }
  /* The source's end ends the destination (end: true) or unpipes it. */
  scr_dyn_pipe_src_on(p, "end", end ? SCR_DYN_PIPE_END : SCR_DYN_PIPE_UNPIPE, true);
  if (scr_exc_pending() || !scr_dyn_pipe_listen(p, "on", "unpipe", SCR_DYN_PIPE_ON_UNPIPE)) goto out;
  scr_dyn_pipe_src_on(p, "data", SCR_DYN_PIPE_DATA, false);
  if (scr_exc_pending()) goto out;
  {
    /* A throwing getter's exception propagates out of pipe(), as Node's
     * prependListener helper reads the member the same way. */
    ScrDyn *prepend = scr_dyn_obj_read(dest, "prependListener", 15);
    if (!prepend || scr_exc_pending()) {
      if (prepend) scr_dyn_release(prepend);
      goto out;
    }
    bool has_prepend = prepend->kind == SCR_DYN_FUNC;
    scr_dyn_release(prepend);
    if (!scr_dyn_pipe_listen(p, has_prepend ? "prependListener" : "on", "error", SCR_DYN_PIPE_ERROR))
      goto out;
  }
  if (!scr_dyn_pipe_listen(p, "once", "close", SCR_DYN_PIPE_CLOSE) ||
      !scr_dyn_pipe_listen(p, "once", "finish", SCR_DYN_PIPE_FINISH))
    goto out;
  {
    ScrDyn *args[2] = {scr_dyn_pipe_str("pipe", 4), scr_dyn_retain(src_box)};
    bool ok = scr_dyn_pipe_call(p, "emit", args, 2);
    scr_dyn_release(args[0]);
    scr_dyn_release(args[1]);
    if (!ok) goto out;
  }
  {
    ScrDyn *need = scr_dyn_obj_read(dest, "writableNeedDrain", 17);
    if (!need || scr_exc_pending()) {
      if (need) scr_dyn_release(need);
      goto out;
    }
    bool pause = need->kind == SCR_DYN_BOOL && scr_dyn_truthy(need);
    scr_dyn_release(need);
    if (pause) scr_dyn_pipe_pause(p);
    else if (scr_stream_is_paused(src))
      scr_stream_release(scr_stream_resume(src));
  }
out:
  scr_dyn_pipe_release_v(p);
}

/* readable.unpipe(destination) for a destination that is not a native
 * stream: the pipe scr_stream_pipe_dyn registered from src into it
 * unpipes, as Node's unpipe does for a piped destination; nothing happens
 * when there is none. An undefined destination (unpipe() without one)
 * unpipes every JavaScript destination of src, oldest pipe first.
 * Borrowed. */
void scr_stream_unpipe_dyn(ScrStream *src, ScrDyn *dest) {
  bool all = dest == NULL || dest->kind == SCR_DYN_UNDEF;
  for (;;) {
    /* The live list is newest first; the oldest matching pipe goes next.
     * Unpiping runs JavaScript ('unpipe' listeners), so each round walks
     * the list again. */
    ScrDynPipe *match = NULL;
    for (ScrDynPipe *p = scr_dyn_pipe_live; p; p = p->live_next) {
      if (p->src != src || p->unpiped || p->cleaned || !p->dest) continue;
      if (!all && !scr_dyn_strict_eq(p->dest, dest)) continue;
      match = p;
    }
    if (!match) return;
    ScrDynPipe *held = scr_dyn_pipe_retain_v(match);
    scr_dyn_pipe_unpipe(held);
    scr_dyn_pipe_release_v(held);
    if (!all || scr_exc_pending()) return;
  }
}
