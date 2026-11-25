/* readable.iterator: the async iterator over a readable's chunks. This unit
 * installs scr_stream_iterator_hook so the stream unit's checked-dynamic
 * dispatch never links it directly. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <stdlib.h>

/* Installs the dispatch hook (the stream unit stays independent of this one). */
__attribute__((constructor)) static void scr_stream_iterator_install(void) {
  scr_stream_iterator_hook = scr_stream_dyn_iterator;
}

typedef struct SdiCtx SdiCtx;
struct SdiCtx {
  size_t rc;
  ScrStream *s;  /* +1 */
  /* return() or throw() ran: every later next()/return() answers
   * { value: undefined, done: true }, as Node's iterator does. */
  bool finished;
  bool destroy_on_return;
};

static SdiCtx *sdi_ref(SdiCtx *c) {
  c->rc++;
  return c;
}

static void sdi_unref(SdiCtx *c) {
  if (--c->rc > 0) return;
  if (c->s) scr_stream_release(c->s);
  free(c);
}

static void *sdi_ref_v(void *p) { return sdi_ref(p); }
static void sdi_unref_v(void *p) { sdi_unref(p); }

static ScrClosure *sdi_closure(void *fn, SdiCtx *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&sdi_ref_v, &sdi_unref_v, NULL);
  scr_box_set_ref(cl->caps[0], sdi_ref(c));
  return cl;
}

static SdiCtx *sdi_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* IteratorResult { value: undefined, done: true }, settled. */
static ScrPromise *sdi_done_promise(void) {
  ScrPromise *p = scr_promise_new();
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(true));
  scr_promise_fulfill_ref(p, result, scr_dyn_retain_v, scr_dyn_release_v, NULL);
  return p;
}

static ScrDyn *sdi_promise_dyn(ScrPromise *p /* +1 kept by the caller */) {
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return out;
}

/* next(): one read of the readable, answered as an IteratorResult. */
static ScrDyn *sdi_next(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SdiCtx *c = sdi_of(cl);
  ScrPromise *p = c->s && !c->finished ? scr_stream_next_result_dyn(c->s) : NULL;
  if (!p) p = sdi_done_promise();
  ScrDyn *out = sdi_promise_dyn(p);
  if (scr_exc_pending()) scr_exc_clear();
  sdi_unref(c);
  return out;
}

/* return(): completes the iteration; the readable is destroyed unless
 * destroyOnReturn is false. */
static ScrDyn *sdi_return(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SdiCtx *c = sdi_of(cl);
  bool first = !c->finished;
  c->finished = true;
  if (first && c->s && c->destroy_on_return && scr_stream_prop(c->s, "destroyed") == 0) {
    scr_stream_release(scr_stream_destroy(c->s, NULL));
    if (scr_exc_pending()) scr_exc_clear();
  }
  ScrDyn *out = sdi_promise_dyn(sdi_done_promise());
  sdi_unref(c);
  return out;
}

/* throw(err): destroys the readable with the value and rejects with it. */
static ScrDyn *sdi_throw(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  SdiCtx *c = sdi_of(cl);
  ScrDyn *reason = argc > 0 ? args[0] : scr_dyn_undefined();
  bool first = !c->finished;
  c->finished = true;
  if (first && c->s && scr_stream_prop(c->s, "destroyed") == 0) {
    ScrError *err = scr_error_from_dyn(reason);
    /* The iterator's own error listener consumes the destroy's 'error', as
     * Node's does: the rejection carries it instead. */
    scr_stream_next_error_consumed(c->s);
    scr_stream_release(scr_stream_destroy(c->s, err));
    if (err) scr_error_release(err);
  }
  ScrPromise *p = scr_promise_new();
  scr_dyn_throw(scr_dyn_retain(reason));
  scr_promise_reject_pending(p);
  if (scr_exc_pending()) scr_exc_clear();
  ScrDyn *out = sdi_promise_dyn(p);
  sdi_unref(c);
  return out;
}

/* [Symbol.asyncIterator](): the receiver, as %AsyncIteratorPrototype%'s
 * method answers `this`. The context holds no pointer back to the iterator
 * object: a method saved off the object outlives it, and the context (which
 * every member closure retains) only owns the readable. */
static ScrDyn *sdi_async_iter(ScrClosure *cl, ScrDyn *const *args, size_t argc) {
  (void)cl;
  (void)args;
  (void)argc;
  return scr_dyn_this_get();
}

static ScrDyn *sdi_member(void *fn, ScrDynThunk thunk, uint32_t arity, const char *sig,
                          const char *name, SdiCtx *c) {
  ScrClosure *cl = sdi_closure(fn, c);
  return scr_dyn_new_func(cl, thunk, arity, sig, name);
}

/* The iterator over a readable (+1). */
ScrDyn *scr_stream_iterator(ScrStream *s, bool destroy_on_return) {
  SdiCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->s = scr_stream_retain(s);
  c->destroy_on_return = destroy_on_return;
  ScrDyn *it = scr_dyn_new_obj();
  scr_dyn_obj_set(it, "next", 4, sdi_member((void *)&sdi_next, &sdi_next, 0, "()", "next", c));
  scr_dyn_obj_set(it, "return", 6,
                  sdi_member((void *)&sdi_return, &sdi_return, 0, "()", "return", c));
  scr_dyn_obj_set(it, "throw", 5,
                  sdi_member((void *)&sdi_throw, &sdi_throw, 1, "(err)", "throw", c));
  ScrStr *async_name = scr_str_new("asyncIterator", 13);
  ScrSym *async_sym = scr_sym_well_known(async_name);
  scr_str_release(async_name);
  if (async_sym != NULL) {
    ScrDyn *key = scr_dyn_new_symbol(async_sym);
    ScrDyn *method = sdi_member((void *)&sdi_async_iter, &sdi_async_iter, 0, "()",
                                "[Symbol.asyncIterator]", c);
    scr_dyn_key_set_computed(it, key, method);
    scr_dyn_release(method);
    scr_dyn_release(key);
    scr_sym_release(async_sym);
  }
  sdi_unref(c);
  return it;
}

/* iterator(options) over a checked-dynamic receiver: an options object with
 * destroyOnReturn (default true), Node's object validation for anything
 * else. */
ScrDyn *scr_stream_dyn_iterator(ScrStream *s, ScrDyn *const *args, size_t argc) {
  bool destroy_on_return = true;
  ScrDyn *options = argc > 0 ? args[0] : scr_dyn_undefined();
  if (options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL) {
    if (options->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "of type object", options);
      return NULL;
    }
    /* Node tests `options?.destroyOnReturn !== false`: only the boolean
     * false turns the destroy off, so an explicit undefined (and every other
     * non-false value) keeps Node's default cleanup. obj_get answers a
     * BORROWED value; the key is the property's fifteen bytes, NUL
     * excluded. */
    ScrDyn *flag = scr_dyn_obj_get(options, "destroyOnReturn", 15);
    if (flag != NULL && flag->kind == SCR_DYN_BOOL && flag->v.b == false)
      destroy_on_return = false;
  }
  if (scr_exc_pending()) return NULL;
  return scr_stream_iterator(s, destroy_on_return);
}
