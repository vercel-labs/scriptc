/* stream.duplexPair (Node's internal/streams/duplexpair.js): two Duplexes
 * wired to each other, so whatever is written to one is readable on the
 * other. Each side is a plain Duplex with the pair's four implementer
 * hooks:
 *
 *   _write(chunk, enc, cb)  pushes the chunk into the peer and completes
 *                           the write only when the peer reads it (Node
 *                           keeps the callback in the peer's kCallback and
 *                           fires it from _read); a zero-length chunk
 *                           completes on the next tick instead.
 *   _read()                 fires the write that is waiting on this side.
 *   _final(cb)              ends the peer and completes once the peer's
 *                           'end' fires.
 *   _destroy(err, cb)       on a later tick, ends the peer (or destroys it
 *                           without the error when this side failed), then
 *                           completes the destruction.
 *
 * An option callback the program passed (read, write, final or destroy) is
 * an own method on the instance in Node, so it shadows DuplexSide's
 * prototype hook; the hook is installed here only for the options the
 * program did not supply.
 *
 * Ownership: the pair state retains both streams (Node's #otherSide is a
 * strong field), and every hook holds the pair, so the streams and the pair
 * form a reference cycle the collector can trace: dropping one endpoint
 * keeps the other alive — a pending write still reaches its EOF — and the
 * collector reclaims the pair once both are unreachable. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <stdlib.h>
#include <string.h>

typedef struct Pair Pair;
struct Pair {
  size_t rc;
  ScrStream *s[2]; /* +1 each */
  /* A write on that side is waiting for the peer's _read. */
  bool wait[2];
};

static void pair_trace(void *h, ScrTraceVisit visit, void *ctx) {
  Pair *p = h;
  for (int i = 0; i < 2; i++) {
    if (p->s[i]) visit(p->s[i], ctx);
  }
}

/* The collector frees the traced streams itself; this just frees the pair. */
static void pair_gcfree(void *h) {
  scr_obj_free_note();
  scr_cyc_free(h);
}

static void pair_destroy(void *h) {
  Pair *p = h;
  for (int i = 0; i < 2; i++) {
    ScrStream *s = p->s[i];
    p->s[i] = NULL;
    if (s) scr_stream_release(s);
  }
  pair_gcfree(p);
}

static Pair *pair_ref(Pair *p) {
  p->rc++;
  return p;
}

static void pair_unref(void *h) {
  Pair *p = h;
  if (--p->rc == 0) {
    scr_cyc_dead(p);
    scr_rc_destroy(p, pair_destroy);
  } else {
    scr_cyc_released(p);
  }
}

static void *pair_ref_v(void *p) { return pair_ref(p); }

static ScrCycType pair_cyc_type = { &pair_trace, &pair_gcfree, SCR_CYC_KIND_NONE, 0 };

/* A hook closure over the pair (+1). */
static ScrClosure *pair_closure(Pair *p, void *fn) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(pair_ref_v, pair_unref, pair_trace);
  scr_box_set_ref(cl->caps[0], pair_ref(p));
  return cl;
}

/* A hook closure over the pair and a side. */
static ScrClosure *pair_side_closure(Pair *p, void *fn, int side, bool had_error) {
  ScrClosure *cl = scr_closure_new(fn, 3);
  cl->caps[0] = scr_box_new_obj(pair_ref_v, pair_unref, pair_trace);
  scr_box_set_ref(cl->caps[0], pair_ref(p));
  cl->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(cl->caps[1], (double)side);
  cl->caps[2] = scr_box_new(SCR_BOX_BOOL);
  scr_box_set_bool(cl->caps[2], had_error);
  return cl;
}

static Pair *pair_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

static int pair_side(const Pair *p, const ScrStream *s) { return s == p->s[0] ? 0 : 1; }

/* Whether the options object supplies a function for `key` (Node's
 * `typeof options.write === 'function'`): such a callback is an own method
 * that shadows the pair's hook. */
static bool pair_option_fn(const ScrDyn *opts, const char *key) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return false;
  ScrDyn *v = scr_dyn_obj_read(opts, key, strlen(key));
  bool fn = v != NULL && v->kind == SCR_DYN_FUNC;
  if (v) scr_dyn_release(v);
  return fn;
}

/* The zero-length write's completion, on a later tick (Node's
 * process.nextTick(callback) in _write). */
static void pair_write_zero_tick(ScrClosure *cl) {
  Pair *p = pair_of(cl);
  int side = (int)scr_box_get_f64(cl->caps[1]);
  if (p->s[side] != NULL) scr_stream_write_done(p->s[side], NULL);
  pair_unref(p);
}

/* Node's `chunk.length === 0` in DuplexSide._write: an empty Buffer, string
 * or array completes on a later tick; an object-mode value without a length
 * does not. */
static bool pair_chunk_free(ScrStream *s, ScrBytes *chunk, const ScrStreamTypedDesc *desc) {
  /* A typed record is an object without a `length`. */
  if (desc != NULL) return false;
  if (!scr_stream_writes_values(s)) return chunk->len == 0;
  ScrDyn *v = (ScrDyn *)chunk;
  if (v->kind == SCR_DYN_STR) return scr_str_utf16_len(v->v.str) == 0;
  if (v->kind == SCR_DYN_BYTES) return v->v.bytes->len == 0;
  if (v->kind == SCR_DYN_ARR) return scr_dyn_arr_length(v) == 0;
  return false;
}

static void pair_write(ScrClosure *cl, ScrStream *s, ScrBytes *chunk) {
  Pair *p = pair_of(cl);
  int side = pair_side(p, s);
  ScrStream *peer = p->s[1 - side];
  const ScrStreamTypedDesc *desc = scr_stream_write_desc(s);
  if (peer == NULL) {
    scr_stream_write_done(s, NULL);
  } else if (pair_chunk_free(s, chunk, desc)) {
    scr_next_tick(pair_side_closure(p, (void *)&pair_write_zero_tick, side, false));
  } else if (desc != NULL) {
    scr_stream_push_typed(peer, chunk, desc);
    p->wait[side] = true;
  } else if (scr_stream_writes_values(s)) {
    scr_stream_push_dyn(peer, (ScrDyn *)chunk);
    p->wait[side] = true;
  } else {
    scr_stream_push(peer, chunk);
    p->wait[side] = true;
  }
  pair_unref(p);
}

static void pair_read(ScrClosure *cl, ScrStream *s, double size) {
  (void)size;
  Pair *p = pair_of(cl);
  int side = pair_side(p, s);
  /* The peer's write waits for this side to read. */
  if (p->wait[1 - side]) {
    p->wait[1 - side] = false;
    if (p->s[1 - side] != NULL) scr_stream_write_done(p->s[1 - side], NULL);
  }
  pair_unref(p);
}

/* The peer's 'end' completes this side's _final. */
static void pair_final_end(ScrClosure *cl) {
  Pair *p = pair_of(cl);
  int side = (int)scr_box_get_f64(cl->caps[1]);
  if (p->s[side] != NULL) scr_stream_final_done(p->s[side], NULL);
  pair_unref(p);
}

static void pair_final(ScrClosure *cl, ScrStream *s) {
  Pair *p = pair_of(cl);
  int side = pair_side(p, s);
  ScrStream *peer = p->s[1 - side];
  if (peer == NULL) {
    scr_stream_final_done(s, NULL);
  } else {
    ScrStr *name = scr_str_new("end", 3);
    scr_emitter_release(scr_emitter_on((ScrEmitter *)peer, name,
                                       pair_side_closure(p, (void *)&pair_final_end, side, false),
                                       scr_ee_inv_fixed0, false, false));
    scr_str_release(name);
    scr_stream_push_null(peer);
  }
  pair_unref(p);
}

/* The peer teardown Node schedules from _destroy on a later tick. */
static void pair_peer_tick(ScrClosure *cl) {
  Pair *p = pair_of(cl);
  int side = (int)scr_box_get_f64(cl->caps[1]);
  bool had_error = scr_box_get_bool(cl->caps[2]);
  ScrStream *peer = p->s[1 - side];
  if (peer != NULL && !scr_stream_prop(peer, "destroyed")) {
    if (had_error) {
      /* Node destroys the other side without the error object, so the pair
       * closes gracefully instead of reporting an unhandled error twice. */
      ScrStream *destroyed = scr_stream_destroy(peer, NULL);
      if (destroyed) scr_stream_release(destroyed);
    } else {
      scr_stream_push_null(peer);
    }
  }
  pair_unref(p);
}

static void pair_destroy_hook(ScrClosure *cl, ScrStream *s, ScrError *err) {
  Pair *p = pair_of(cl);
  int side = pair_side(p, s);
  /* Node reads `otherSide.destroyed` when the tick runs, not here. */
  scr_next_tick(pair_side_closure(p, (void *)&pair_peer_tick, side, err != NULL));
  /* The hook's err is borrowed; the completion takes ownership. */
  scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
  pair_unref(p);
}

static ScrArrOps pair_arr_ops = {
  &scr_stream_retain_v,
  &scr_stream_release_v,
  &scr_stream_trace,
};

/* stream.duplexPair([options]): the two Duplexes ([Duplex, Duplex], +1).
 * options is borrowed: the same object builds both sides, as Node passes it
 * to both DuplexSide constructors. A typed options value arrives as a typed
 * capsule, which the option walk reads through its materialized object. */
ScrArr *scr_stream_duplexpair(ScrDyn *options) {
  ScrDyn *materialized = NULL;
  if (options != NULL && options->kind == SCR_DYN_TYPED_REF) {
    materialized = scr_dyn_typed_ref_materialize(options);
    options = materialized;
  }
  ScrStream *first = scr_stream_new_duplex_dyn(options);
  if (!first) {
    if (materialized) scr_dyn_release(materialized);
    return NULL;
  }
  ScrStream *second = scr_stream_new_duplex_dyn(options);
  if (!second) {
    scr_stream_release(first);
    if (materialized) scr_dyn_release(materialized);
    return NULL;
  }
  Pair *p = scr_cyc_alloc(sizeof *p, &pair_cyc_type);
  if (!p) abort();
  scr_obj_alloc_note();
  p->rc = 1;
  p->s[0] = first;  /* the creation references move into the pair */
  p->s[1] = second;
  /* Node's own callbacks shadow the prototype hooks, one key at a time. */
  if (!pair_option_fn(options, "read"))
    scr_stream_set_read(first, pair_closure(p, (void *)&pair_read), &pair_read);
  if (!pair_option_fn(options, "write"))
    scr_stream_set_write(first, pair_closure(p, (void *)&pair_write), &pair_write);
  if (!pair_option_fn(options, "final"))
    scr_stream_set_final(first, pair_closure(p, (void *)&pair_final), &pair_final);
  if (!pair_option_fn(options, "destroy"))
    scr_stream_set_destroy(first, pair_closure(p, (void *)&pair_destroy_hook), &pair_destroy_hook);
  if (!pair_option_fn(options, "read"))
    scr_stream_set_read(second, pair_closure(p, (void *)&pair_read), &pair_read);
  if (!pair_option_fn(options, "write"))
    scr_stream_set_write(second, pair_closure(p, (void *)&pair_write), &pair_write);
  if (!pair_option_fn(options, "final"))
    scr_stream_set_final(second, pair_closure(p, (void *)&pair_final), &pair_final);
  if (!pair_option_fn(options, "destroy"))
    scr_stream_set_destroy(second, pair_closure(p, (void *)&pair_destroy_hook), &pair_destroy_hook);
  ScrArr *out = scr_arr_new_ops(&pair_arr_ops, 2);
  scr_arr_set_ref(out, 0, scr_stream_retain(first));
  scr_arr_set_ref(out, 1, scr_stream_retain(second));
  if (materialized) scr_dyn_release(materialized);
  pair_unref(p); /* the hooks own the pair now */
  return out;
}
