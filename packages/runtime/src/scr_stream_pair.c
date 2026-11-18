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
 * Ownership: the pair state BORROWS both streams (Node's #otherSide is a
 * plain field); each side's stream holds a PairSide in its native state
 * slot that clears the pair's pointer for that side when the stream is
 * freed. The hooks hold the pair state, so the two streams and their hooks
 * never form an untraced reference cycle. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <stdlib.h>

typedef struct Pair Pair;
struct Pair {
  size_t rc;
  ScrStream *s[2]; /* borrowed; NULL once that stream is freed */
  /* A write on that side is waiting for the peer's _read. */
  bool wait[2];
};

static Pair *pair_ref(Pair *p) {
  p->rc++;
  return p;
}

static void pair_unref(Pair *p) {
  if (--p->rc > 0) return;
  free(p);
}

/* The native state each side's stream owns: it drops that side from the
 * pair when the stream is freed, so the borrowed pointers never dangle. */
typedef struct PairSide PairSide;
struct PairSide {
  size_t rc;
  Pair *pair; /* +1 */
  int side;
};

static void pair_side_unref(void *v) {
  PairSide *side = v;
  if (--side->rc > 0) return;
  if (side->pair->s[side->side] != NULL) side->pair->s[side->side] = NULL;
  pair_unref(side->pair);
  free(side);
}

static PairSide *pair_side_new(Pair *p, int side) {
  PairSide *s = calloc(1, sizeof *s);
  if (!s) abort();
  s->rc = 1;
  s->pair = pair_ref(p);
  s->side = side;
  return s;
}

static void *pair_ref_v(void *p) { return pair_ref(p); }
static void pair_unref_v(void *p) { pair_unref(p); }

/* A hook closure over the pair. */
static ScrClosure *pair_closure(Pair *p, void *fn) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(pair_ref_v, pair_unref_v, NULL);
  scr_box_set_ref(cl->caps[0], pair_ref(p));
  return cl;
}

/* A hook closure over the pair and a side. */
static ScrClosure *pair_side_closure(Pair *p, void *fn, int side, bool had_error) {
  ScrClosure *cl = scr_closure_new(fn, 3);
  cl->caps[0] = scr_box_new_obj(pair_ref_v, pair_unref_v, NULL);
  scr_box_set_ref(cl->caps[0], pair_ref(p));
  cl->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(cl->caps[1], (double)side);
  cl->caps[2] = scr_box_new(SCR_BOX_BOOL);
  scr_box_set_bool(cl->caps[2], had_error);
  return cl;
}

static Pair *pair_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

static int pair_side(const Pair *p, const ScrStream *s) { return s == p->s[0] ? 0 : 1; }

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

static void pair_destroy(ScrClosure *cl, ScrStream *s, ScrError *err) {
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
  if (materialized) scr_dyn_release(materialized);
  Pair *p = calloc(1, sizeof *p);
  if (!p) abort();
  p->rc = 1;
  p->s[0] = first;
  p->s[1] = second;
  scr_stream_set_read(first, pair_closure(p, (void *)&pair_read), &pair_read);
  scr_stream_set_write(first, pair_closure(p, (void *)&pair_write), &pair_write);
  scr_stream_set_final(first, pair_closure(p, (void *)&pair_final), &pair_final);
  scr_stream_set_destroy(first, pair_closure(p, (void *)&pair_destroy), &pair_destroy);
  scr_stream_set_read(second, pair_closure(p, (void *)&pair_read), &pair_read);
  scr_stream_set_write(second, pair_closure(p, (void *)&pair_write), &pair_write);
  scr_stream_set_final(second, pair_closure(p, (void *)&pair_final), &pair_final);
  scr_stream_set_destroy(second, pair_closure(p, (void *)&pair_destroy), &pair_destroy);
  /* Each side's native state lets that side's teardown clear the pair's
   * borrowed pointer. */
  scr_stream_set_native(first, pair_side_new(p, 0), &pair_side_unref);
  scr_stream_set_native(second, pair_side_new(p, 1), &pair_side_unref);
  ScrArr *out = scr_arr_new_ops(&pair_arr_ops, 2);
  scr_arr_set_ref(out, 0, scr_stream_retain(first));
  scr_arr_set_ref(out, 1, scr_stream_retain(second));
  pair_unref(p); /* the hooks and the side states own the pair now */
  scr_stream_release(first); /* the array and side state hold it */
  scr_stream_release(second);
  return out;
}
