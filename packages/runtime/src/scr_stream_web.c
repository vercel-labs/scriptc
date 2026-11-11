/* The node:stream <-> stream/web bridges of Node's
 * internal/webstreams/adapters.js, as the five statics use them:
 *
 *   Readable.toWeb(streamReadable[, options])
 *   Writable.toWeb(streamWritable)
 *   Duplex.toWeb(duplex[, options])
 *   Writable.fromWeb(writableStream[, options])
 *   Duplex.fromWeb(pair[, options])
 *
 * node -> web builds a native ReadableStream / WritableStream
 * (scr_webstreams.c) over the node stream's events: 'data' enqueues into
 * the controller and pauses on backpressure, eos (with Node's synchronous
 * callback option, scr_stream_finished_opts_sync) closes or errors it,
 * pull() resumes, cancel() destroys. web -> node builds a native stream
 * whose option callbacks are the web stream's reader and writer
 * operations, with Node's write tracker delivering the completions.
 *
 * Validation follows Node in wording AND order, because programs print
 * those messages: the stream check precedes the options check, arrays are
 * not objects to validateObject, and Duplex.toWeb validates options.type
 * only on the readable path.
 *
 * Linked only by programs that use the web stream classes and these
 * statics (the streamWeb runtime feature).
 */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* scr_webstream_class's classes, in that order
 * (packages/compiler/src/ir/webstream-classes.ts). */
enum {
  SW_CLS_READABLE = 0,
  SW_CLS_COUNT_STRATEGY = 3,
  SW_CLS_BYTE_STRATEGY = 4,
  SW_CLS_WRITABLE = 5,
};

/* ── shared helpers ──────────────────────────────────────────────────── */

static ScrDyn *sw_undefined(void) { return scr_dyn_retain(scr_dyn_undefined()); }


/* object[key] through Get (getters and the prototype chain); +1. NULL only
 * when an exception is pending.
 *
 * An options object written as an object literal reaches a dynamic parameter
 * as a typed-ref capsule (a bound record), not a plain dynamic object, so the
 * read dispatches on the value's kind the way a compiled dynamic read does. */
static ScrDyn *sw_get(const ScrDyn *object, const char *key) {
  if (!object) return sw_undefined();
  size_t len = strlen(key);
  ScrStr *name;
  ScrDyn *value;
  switch (object->kind) {
  case SCR_DYN_TYPED_REF:
  case SCR_DYN_HANDLE:
  case SCR_DYN_BYTES:
  case SCR_DYN_PROMISE:
    name = scr_str_new(key, len);
    switch (object->kind) {
    case SCR_DYN_TYPED_REF: value = scr_dyn_typed_ref_key_get(object, name); break;
    case SCR_DYN_HANDLE: value = scr_dyn_handle_key_get(object, name); break;
    case SCR_DYN_BYTES: value = scr_dyn_bytes_key_get(object, name); break;
    default: value = scr_dyn_promise_key_get(object, name); break;
    }
    scr_str_release(name);
    return value;
  default:
    return scr_dyn_obj_read(object, key, len);
  }
}

/* JS `typeof value === 'object'` without null: what validateObject takes. */
static bool sw_is_object(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_ARR:
  case SCR_DYN_OBJ:
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_TYPED_REF:
  case SCR_DYN_PROXY:
    return true;
  default:
    return false;
  }
}

/* Node's validateObject: objects only — not null, not a function, and not
 * an array. Throws ERR_INVALID_ARG_TYPE and answers false. */
/* The value Node's checks see: an argument the caller left out crosses as
 * NULL from the lowering, which Node sees as undefined. */
static const ScrDyn *sw_arg(const ScrDyn *v) { return v ? v : scr_dyn_undefined(); }

/* validateObject: null and arrays are not objects, and a non-object
 * throws ERR_INVALID_ARG_TYPE exactly as Node words it. */
static bool sw_validate_object(const ScrDyn *v, const char *name) {
  if (v->kind != SCR_DYN_NULL && v->kind != SCR_DYN_ARR && sw_is_object(v)) return true;
  scr_dyn_arg_type_fail(name, "of type object", v);
  return false;
}

/* `new <class>(args...)` over the native web stream classes, +1 or NULL
 * with the exception pending. */
static ScrDyn *sw_construct_class(double kind, ScrDyn *const *args, size_t n, const char *what) {
  ScrDyn *ctor = scr_webstream_class(kind);
  ScrDyn *list = scr_dyn_new_arr();
  for (size_t i = 0; i < n; i++) scr_dyn_arr_push(list, scr_dyn_retain(args[i]));
  ScrStr *w = scr_str_new(what, strlen(what));
  ScrDyn *result = scr_dyn_construct(ctor, list, w);
  scr_str_release(w);
  scr_dyn_release(list);
  scr_dyn_release(ctor);
  return result;
}

/* A plain object holding `key` -> value (value moves). */
static void sw_set(ScrDyn *object, const char *key, ScrDyn *value) {
  scr_dyn_obj_set(object, key, strlen(key), value);
}

/* recv.method(args...) through the checked-dynamic invocation; +1 or NULL
 * with the exception pending. */
static ScrDyn *sw_invoke(ScrDyn *recv, const char *method, ScrDyn *const *args, size_t argc,
                         const char *what) {
  return scr_dyn_invoke(recv, method, args, argc, what);
}

/* The value a pending exception carries, +1, or NULL when nothing is
 * pending. */
static ScrDyn *sw_take_caught(void) {
  if (!scr_exc_pending()) return NULL;
  ScrCaught *caught = scr_exc_take();
  ScrDyn *value = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  return value;
}

/* Node's handleKnownInternalErrors (adapters.js): a premature close
 * becomes an AbortError caused by it, and an ERR__ERROR_ failure (the
 * brotli decoder codes) becomes a TypeError carrying the same code.
 * Everything else answers itself. Borrowed cause; +1 result or NULL. */
static ScrError *sw_known_error(ScrError *cause) {
  if (!cause) return NULL;
  ScrStr *code = scr_error_code(cause);
  if (code) {
    if (code->len == 26 && memcmp(code->data, "ERR_STREAM_PREMATURE_CLOSE", 26) == 0) {
      ScrDyn *boxed = scr_dyn_from_error(cause);
      ScrError *abort = scr_error_abort(NULL); /* new AbortError() */
      scr_str_release(code);
      if (!abort) {
        scr_dyn_release(boxed);
        return NULL;
      }
      scr_error_set_cause(abort, boxed);
      scr_dyn_release(boxed);
      return abort;
    }
    if (code->len >= 11 && memcmp(code->data, "ERR__ERROR_", 11) == 0) {
      ScrStr *empty = scr_str_new("", 0);
      ScrError *type = scr_error_new(SCR_ERR_TYPE, empty);
      scr_str_release(empty);
      if (!type) {
        scr_str_release(code);
        return NULL;
      }
      ScrDyn *boxed = scr_dyn_from_error(cause);
      scr_error_set_cause(type, boxed);
      scr_dyn_release(boxed);
      scr_error_set_code_value(type, code);
      scr_str_release(code);
      return type;
    }
    scr_str_release(code);
  }
  return scr_error_retain(cause);
}

/* new ERR_STREAM_PREMATURE_CLOSE() — Node's wording, which the web stream
 * adapters compare by code anyway. */
static ScrError *sw_premature_close(void) {
  ScrStr *msg = scr_str_new("Premature close", 15);
  ScrError *err = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  if (err) scr_error_set_code(err, "ERR_STREAM_PREMATURE_CLOSE");
  return err;
}

/* destroy(stream, reason): reason NULL or undefined means no error. */
static void sw_destroy_with(ScrStream *s, const ScrDyn *reason) {
  if (!s || scr_stream_prop(s, "destroyed")) return;
  ScrError *err = NULL;
  if (reason && reason->kind != SCR_DYN_UNDEF && reason->kind != SCR_DYN_NULL) {
    err = scr_error_from_dyn(reason);
    if (scr_exc_pending()) scr_exc_clear();
  }
  scr_stream_release(scr_stream_destroy(s, err));
  if (err) scr_error_release(err);
}

/* callback(error) — NULL err is Node's callback(undefined). */
static void sw_call_done(ScrDyn *cb, ScrDyn *err /* borrowed, may be NULL */) {
  if (!cb) return;
  ScrDyn *args[1];
  size_t n = 0;
  if (err) {
    args[0] = err;
    n = 1;
  }
  ScrDyn *result = scr_dyn_call(cb, args, n, "callback");
  if (result) scr_dyn_release(result);
}

/* chunk?.byteLength ?? chunk?.length ?? 1 — the non-object-mode writable
 * strategy's size(). */
static double sw_size_value(const ScrDyn *chunk) {
  if (chunk && chunk->kind == SCR_DYN_BYTES) return (double)chunk->v.bytes->len;
  if (chunk && chunk->kind == SCR_DYN_STR) return (double)chunk->v.str->len;
  if (chunk && (chunk->kind == SCR_DYN_OBJ || chunk->kind == SCR_DYN_ARR ||
                chunk->kind == SCR_DYN_HANDLE || chunk->kind == SCR_DYN_TYPED_REF)) {
    ScrDyn *v = sw_get(chunk, "byteLength");
    bool found = v && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL;
    double out = found && v->kind == SCR_DYN_NUM ? v->v.num : 0;
    if (v) scr_dyn_release(v);
    if (found) return out;
    if (scr_exc_pending()) scr_exc_clear();
    v = sw_get(chunk, "length");
    found = v && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL;
    out = found && v->kind == SCR_DYN_NUM ? v->v.num : 0;
    if (v) scr_dyn_release(v);
    if (found) return out;
    if (scr_exc_pending()) scr_exc_clear();
  }
  return 1;
}

/* ── node -> web: the shared context ─────────────────────────────────── */

typedef struct SwCtx SwCtx;
struct SwCtx {
  size_t rc;
  ScrStream *node;      /* +1 */
  ScrDyn *web;          /* +1: the created web stream */
  ScrDyn *controller;   /* +1 once the underlying source/sink started */
  ScrClosure *l_data;   /* +1 */
  ScrClosure *l_drain;  /* +1 */
  ScrClosure *l_error;  /* +1: Node's post-eos noop error listener */
  ScrClosure *eos;      /* +1: eos's cleanup closure */
  ScrDyn *bp;           /* +1: the parked backpressure promise */
  ScrPromise *closed_p; /* +1: the WritableStream close()'s deferred */
  bool closed_started;  /* Node's `closed !== undefined` */
  bool bp_settled;
  bool object_mode;
  bool was_canceled;
  bool live;
  SwCtx *live_prev, *live_next;
};

static SCR_TL SwCtx *sw_live = NULL;

static SwCtx *sw_ref(SwCtx *c) {
  c->rc++;
  return c;
}

static void sw_drop(SwCtx *c);

static void sw_unref(SwCtx *c) {
  if (--c->rc > 0) return;
  sw_drop(c);
  free(c);
}

static void *sw_retain_v(void *p) { return sw_ref(p); }
static void sw_release_v(void *p) { sw_unref(p); }

static ScrClosure *sw_closure(void *fn, SwCtx *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&sw_retain_v, &sw_release_v, NULL);
  scr_box_set_ref(cl->caps[0], sw_ref(c));
  return cl;
}

static SwCtx *sw_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* Remove `name`'s listener from the node stream and drop the slot. */
static void sw_off(ScrStream *s, const char *name, ScrClosure **slot) {
  if (!*slot) return;
  ScrStr *n = scr_str_new(name, strlen(name));
  scr_emitter_release(scr_emitter_off((ScrEmitter *)s, n, *slot));
  scr_str_release(n);
  scr_closure_release(*slot);
  *slot = NULL;
}

static void sw_add_listener(ScrStream *s, const char *name, ScrClosure **slot, void *fn, void *inv,
                            SwCtx *c) {
  ScrStr *n = scr_str_new(name, strlen(name));
  *slot = sw_closure(fn, c);
  scr_emitter_release(
      scr_emitter_on((ScrEmitter *)s, n, scr_closure_retain(*slot), inv, false, false));
  scr_str_release(n);
}

static void sw_eos_cleanup(SwCtx *c) {
  if (!c->eos) return;
  ScrClosure *cl = c->eos;
  c->eos = NULL;
  ((void (*)(ScrClosure *))cl->fn)(cl);
  scr_closure_release(cl);
}

/* Drop everything the context holds. Idempotent. */
static void sw_drop(SwCtx *c) {
  if (c->node) {
    sw_off(c->node, "data", &c->l_data);
    sw_off(c->node, "drain", &c->l_drain);
    sw_off(c->node, "error", &c->l_error);
  }
  sw_eos_cleanup(c);
  if (c->controller) {
    scr_dyn_release(c->controller);
    c->controller = NULL;
  }
  if (c->bp) {
    scr_dyn_release(c->bp);
    c->bp = NULL;
  }
  if (c->closed_p) {
    scr_promise_release(c->closed_p);
    c->closed_p = NULL;
  }
  if (c->web) {
    scr_dyn_release(c->web);
    c->web = NULL;
  }
  if (c->node) {
    ScrStream *s = c->node;
    c->node = NULL;
    scr_stream_release(s);
  }
}

/* Unlink from the live list and drop what the cycle through the stream's
 * listeners holds. */
static void sw_teardown(SwCtx *c) {
  if (!c->live) return;
  c->live = false;
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else if (sw_live == c) sw_live = c->live_next;
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  sw_drop(c);
  sw_unref(c); /* the live list's reference */
}

static void sw_atexit(void) {
  while (sw_live) sw_teardown(sw_live);
}

/* Takes over the caller's reference as the live list's reference. */
static void sw_push_live(SwCtx *c) {
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(sw_atexit);
  }
  c->live = true;
  c->live_next = sw_live;
  if (sw_live) sw_live->live_prev = c;
  sw_live = c;
}

/* ── node -> web: Readable.toWeb ─────────────────────────────────────── */

/* The 'data' listener: enqueue the chunk, pausing the node stream when the
 * web stream's queue is full. */
static void sw_data_listener(ScrClosure *cb, ScrBytes *bytes, ScrStr *str, ScrDyn *value) {
  SwCtx *c = sw_of(cb);
  if (c->controller && !c->was_canceled) {
    if (value && value->kind == SCR_DYN_BYTES) bytes = value->v.bytes;
    else if (value && value->kind == SCR_DYN_STR) str = value->v.str;
    ScrDyn *chunk = NULL;
    if (!c->object_mode && bytes && scr_bytes_is_buffer(bytes)) {
      /* Node hands the web stream a plain Uint8Array, not the pooled
       * Buffer: `new Uint8Array(chunk)` copies out of the pool. */
      ScrBytes *copy = scr_bytes_copy(bytes);
      if (copy) {
        copy->is_buffer = false;
        chunk = scr_dyn_new_bytes(copy);
        scr_bytes_release(copy);
      }
    } else if (value) {
      chunk = scr_dyn_retain(value);
    } else if (str) {
      chunk = scr_dyn_new_str(str);
    } else if (bytes) {
      chunk = scr_dyn_new_bytes(bytes);
    }
    if (chunk) {
      ScrDyn *args[1] = {chunk};
      ScrDyn *r = sw_invoke(c->controller, "enqueue", args, 1, "controller.enqueue");
      scr_dyn_release(chunk);
      if (r) scr_dyn_release(r);
      if (scr_exc_pending()) {
        sw_unref(c);
        return;
      }
      ScrDyn *desired = sw_get(c->controller, "desiredSize");
      bool full = desired && desired->kind == SCR_DYN_NUM && desired->v.num <= 0;
      if (desired) scr_dyn_release(desired);
      if (full && !scr_exc_pending() && c->node) scr_stream_release(scr_stream_pause(c->node));
    }
  }
  sw_unref(c);
}

/* start(controller) for both directions. */
static ScrDyn *sw_start_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwCtx *c = sw_of(clo);
  if (argc > 0 && args[0] && !c->controller) c->controller = scr_dyn_retain(args[0]);
  sw_unref(c);
  return sw_undefined();
}

/* pull(): the web stream wants more. */
static ScrDyn *sw_pull_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SwCtx *c = sw_of(clo);
  if (c->node && !c->was_canceled) scr_stream_release(scr_stream_resume(c->node));
  sw_unref(c);
  return sw_undefined();
}

/* cancel(reason): the reader gave up. */
static ScrDyn *sw_cancel_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwCtx *c = sw_of(clo);
  c->was_canceled = true;
  sw_destroy_with(c->node, argc > 0 ? args[0] : NULL);
  sw_unref(c);
  return sw_undefined();
}

/* The post-eos noop 'error' listener (Node's kErrorSentinelAttached). */
static void sw_noop_error(ScrClosure *cb, void *a) {
  (void)cb;
  (void)a;
}

/* eos's callback for the readable side. */
static void sw_rd_eos(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  SwCtx *c = sw_of(cb);
  ScrError *error = sw_known_error(err); /* +1 or NULL */
  sw_eos_cleanup(c);
  if (c->node && !c->l_error)
    sw_add_listener(c->node, "error", &c->l_error, (void *)&sw_noop_error,
                    (void *)&scr_ee_inv_fixed1, c);
  if (c->was_canceled || !c->controller) {
    if (error) scr_error_release(error);
    sw_unref(c);
    return;
  }
  c->was_canceled = true;
  if (error) {
    ScrDyn *e = scr_dyn_from_error(error);
    ScrDyn *args[1] = {e};
    ScrDyn *r = sw_invoke(c->controller, "error", args, 1, "controller.error");
    scr_dyn_release(e);
    scr_error_release(error);
    if (r) scr_dyn_release(r);
  } else {
    ScrDyn *r = sw_invoke(c->controller, "close", NULL, 0, "controller.close");
    if (r) scr_dyn_release(r);
  }
  sw_unref(c);
}

/* options.type: undefined or 'bytes', else Node's validateOneOf message.
 * Answers the value +1 (possibly undefined). */
static ScrDyn *sw_read_type(const ScrDyn *opts) {
  ScrDyn *type = sw_get(opts, "type");
  if (!type) return NULL;
  if (type->kind == SCR_DYN_UNDEF) return type;
  if (type->kind == SCR_DYN_STR && type->v.str->len == 5 &&
      memcmp(type->v.str->data, "bytes", 5) == 0)
    return type;
  scr_dyn_arg_value_fail("options.type", "must be one of: 'bytes', undefined", type);
  scr_dyn_release(type);
  return NULL;
}

/* Node's newReadableStreamFromStreamReadable. `type` is the resolved
 * options.type (borrowed: NULL/undefined or 'bytes'), `opts` the caller's
 * options bag (borrowed; its `strategy` is read only on the path Node
 * reads it). +1, or NULL with the exception pending. */
static ScrDyn *sw_readable_to_web(ScrStream *node, const ScrDyn *type, const ScrDyn *opts) {
  bool byob = type && type->kind == SCR_DYN_STR;
  bool readable = scr_stream_prop(node, "readable") != 0;
  bool object_mode = scr_stream_prop(node, "readableObjectMode") != 0;
  double hwm = scr_stream_prop(node, "readableHighWaterMark");

  SwCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->node = scr_stream_retain(node);
  c->object_mode = object_mode;
  sw_push_live(c);

  ScrDyn *source = scr_dyn_new_obj();
  if (byob) sw_set(source, "type", scr_dyn_new_str(type->v.str));
  sw_set(source, "start", scr_dyn_new_func(sw_closure((void *)&sw_start_thunk, c), &sw_start_thunk,
                                           1, "(controller)", "start"));
  sw_set(source, "cancel", scr_dyn_new_func(sw_closure((void *)&sw_cancel_thunk, c),
                                            &sw_cancel_thunk, 1, "(reason)", "cancel"));
  if (readable) {
    sw_set(source, "pull", scr_dyn_new_func(sw_closure((void *)&sw_pull_thunk, c), &sw_pull_thunk, 0,
                                            "()", "pull"));
  }

  /* Node computes a strategy only for a readable stream: a plain
   * { highWaterMark } for BYOB, the caller's else a queuing strategy. */
  ScrDyn *strategy = NULL, *queuing = NULL;
  if (readable) {
    if (byob) {
      queuing = scr_dyn_new_obj();
      sw_set(queuing, "highWaterMark", scr_dyn_new_num(hwm));
    } else {
      strategy = sw_get(opts, "strategy");
      if (strategy && strategy->kind == SCR_DYN_UNDEF) {
        scr_dyn_release(strategy);
        strategy = NULL;
      }
      if (!strategy) {
        ScrDyn *init = scr_dyn_new_obj();
        sw_set(init, "highWaterMark", scr_dyn_new_num(hwm));
        ScrDyn *sargs[1] = {init};
        queuing = sw_construct_class(object_mode ? SW_CLS_COUNT_STRATEGY : SW_CLS_BYTE_STRATEGY,
                                     sargs, 1, "QueuingStrategy");
        scr_dyn_release(init);
      }
    }
  }
  ScrDyn *web = NULL;
  if (!scr_exc_pending()) {
    ScrDyn *args[2] = {source, NULL};
    size_t n = 1;
    if (readable) {
      if (strategy) {
        args[1] = strategy;
        n = 2;
      } else if (queuing) {
        args[1] = queuing;
        n = 2;
      }
    }
    web = sw_construct_class(SW_CLS_READABLE, args, n, "ReadableStream");
  }
  if (strategy) scr_dyn_release(strategy);
  if (queuing) scr_dyn_release(queuing);
  scr_dyn_release(source);
  if (!web) {
    sw_teardown(c);
    return NULL;
  }
  c->web = scr_dyn_retain(web);

  c->eos = scr_stream_finished_opts_sync(node, sw_closure((void *)&sw_rd_eos, c), &sw_rd_eos, -1, 0,
                                         true, NULL, NULL);
  if (!c->eos) {
    scr_dyn_release(web);
    sw_teardown(c);
    return NULL;
  }
  if (c->was_canceled) {
    /* eos answered before returning (a destroyed or already-ended stream),
     * so the callback's own cleanup was a no-op, as in Node. */
    sw_eos_cleanup(c);
  } else if (readable) {
    scr_stream_release(scr_stream_pause(node));
    sw_add_listener(node, "data", &c->l_data, (void *)&sw_data_listener,
                    (void *)&scr_ee_inv_fixed3, c);
  }
  return web;
}

/* ── node -> web: Writable.toWeb ─────────────────────────────────────── */

/* The 'drain' listener: release the parked write. */
static void sw_drain_listener(ScrClosure *cb) {
  SwCtx *c = sw_of(cb);
  if (c->bp && !c->bp_settled) {
    c->bp_settled = true;
    ScrDyn *bp = c->bp;
    c->bp = NULL;
    if (!scr_exc_pending()) scr_promise_fulfill_void(bp->v.promise);
    scr_dyn_release(bp);
  }
  sw_unref(c);
}

/* eos's callback for the writable side: the parked write, the close
 * deferred and the controller, in Node's order. */
static void sw_wr_eos(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s;
  SwCtx *c = sw_of(cb);
  ScrError *error = sw_known_error(err); /* +1 or NULL */
  sw_eos_cleanup(c);
  if (c->node && !c->l_error)
    sw_add_listener(c->node, "error", &c->l_error, (void *)&sw_noop_error,
                    (void *)&scr_ee_inv_fixed1, c);
  if (error) {
    if (c->bp && !c->bp_settled) {
      c->bp_settled = true;
      ScrDyn *bp = c->bp;
      c->bp = NULL;
      scr_dyn_throw(scr_dyn_from_error(error)); /* moves */
      scr_promise_reject_pending(bp->v.promise);
      scr_dyn_release(bp);
    }
    if (c->closed_p && c->closed_started) {
      ScrPromise *p = c->closed_p;
      c->closed_p = NULL;
      c->closed_started = false;
      scr_throw_obj(scr_error_retain(error), &scr_error_retain_v, &scr_error_release_v,
                    scr_error_trace_arg());
      scr_promise_reject_pending(p);
      scr_promise_release(p);
    }
    if (c->controller) {
      ScrDyn *e = scr_dyn_from_error(error);
      ScrDyn *args[1] = {e};
      ScrDyn *r = sw_invoke(c->controller, "error", args, 1, "controller.error");
      scr_dyn_release(e);
      if (r) scr_dyn_release(r);
      scr_dyn_release(c->controller);
      c->controller = NULL;
    }
    scr_error_release(error);
    sw_unref(c);
    return;
  }
  if (c->closed_p && c->closed_started) {
    ScrPromise *p = c->closed_p;
    c->closed_p = NULL;
    c->closed_started = false;
    scr_promise_fulfill_void(p);
    scr_promise_release(p);
    sw_unref(c);
    return;
  }
  if (c->controller) {
    ScrError *abort = scr_error_abort(NULL); /* new AbortError() */
    if (abort) {
      ScrDyn *e = scr_dyn_from_error(abort);
      ScrDyn *args[1] = {e};
      ScrDyn *r = sw_invoke(c->controller, "error", args, 1, "controller.error");
      scr_dyn_release(e);
      scr_error_release(abort);
      if (r) scr_dyn_release(r);
    }
    scr_dyn_release(c->controller);
    c->controller = NULL;
  }
  sw_unref(c);
}

/* The sink's abort(reason). */
static ScrDyn *sw_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwCtx *c = sw_of(clo);
  sw_destroy_with(c->node, argc > 0 ? args[0] : NULL);
  sw_unref(c);
  return sw_undefined();
}

/* The sink's close(): end the node stream and answer the deferred the eos
 * callback settles. */
static ScrDyn *sw_close_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SwCtx *c = sw_of(clo);
  ScrPromise *out = NULL;
  if (!c->closed_started && c->node && !scr_stream_prop(c->node, "writableEnded")) {
    ScrPromise *p = scr_promise_new();
    c->closed_p = p;
    c->closed_started = true;
    scr_stream_release(scr_stream_end(c->node, NULL, NULL, NULL));
    out = scr_promise_retain(p);
  } else {
    if (c->controller) {
      scr_dyn_release(c->controller);
      c->controller = NULL;
    }
    out = scr_promise_new();
    scr_promise_fulfill_void(out);
  }
  sw_unref(c);
  ScrDyn *boxed = scr_dyn_new_promise(out);
  scr_promise_release(out);
  return boxed;
}

/* The sink's write(chunk): the node write's backpressure as the returned
 * promise. */
static ScrDyn *sw_write_sink_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwCtx *c = sw_of(clo);
  ScrDyn *chunk = argc > 0 && args[0] ? (ScrDyn *)args[0] : scr_dyn_undefined();
  ScrBytes *view = NULL;
  ScrDyn *owned = NULL;
  if (!c->object_mode && scr_buffer_storage_is(chunk)) {
    /* Node's `new Uint8Array(arrayBuffer)` for the ArrayBuffers a web
     * stream may carry. */
    view = scr_array_buffer_view(SCR_BYTES_U8, chunk, scr_dyn_undefined(), scr_dyn_undefined());
    if (view) chunk = owned = scr_dyn_new_bytes(view);
  }
  bool need_drain = scr_stream_prop(c->node, "writableNeedDrain") != 0;
  bool ok = scr_stream_write_dyn(c->node, chunk, NULL);
  if (owned) scr_dyn_release(owned);
  if (view) scr_bytes_release(view);
  if (!need_drain && ok) {
    sw_unref(c);
    return sw_undefined();
  }
  ScrPromise *p = scr_promise_new();
  if (!scr_stream_prop(c->node, "writableNeedDrain")) scr_promise_fulfill_void(p);
  if (c->bp) scr_dyn_release(c->bp);
  c->bp_settled = false;
  c->bp = scr_dyn_new_promise(p);
  ScrDyn *boxed = scr_dyn_new_promise(p);
  scr_promise_release(p);
  sw_unref(c);
  return boxed;
}

/* The strategy's size(chunk). */
static ScrDyn *sw_size_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwCtx *c = sw_of(clo);
  double size = sw_size_value(argc > 0 ? args[0] : NULL);
  sw_unref(c);
  return scr_dyn_new_num(size);
}

/* A closed WritableStream (the destroyed and not-writable branches). */
static ScrDyn *sw_closed_writable(void) {
  ScrDyn *web = sw_construct_class(SW_CLS_WRITABLE, NULL, 0, "WritableStream");
  if (!web) return NULL;
  ScrDyn *r = sw_invoke(web, "close", NULL, 0, "writableStream.close");
  if (r) scr_dyn_release(r);
  if (scr_exc_pending()) scr_exc_clear(); /* close()'s own rejection is noise */
  return web;
}

/* Node's newWritableStreamFromStreamWritable. +1, or NULL with the
 * exception pending. */
static ScrDyn *sw_writable_to_web(ScrStream *node) {
  bool object_mode = scr_stream_prop(node, "writableObjectMode") != 0;
  double hwm = scr_stream_prop(node, "writableHighWaterMark");

  SwCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->node = scr_stream_retain(node);
  c->object_mode = object_mode;
  sw_push_live(c);

  ScrDyn *sink = scr_dyn_new_obj();
  sw_set(sink, "start", scr_dyn_new_func(sw_closure((void *)&sw_start_thunk, c), &sw_start_thunk, 1,
                                         "(controller)", "start"));
  sw_set(sink, "write", scr_dyn_new_func(sw_closure((void *)&sw_write_sink_thunk, c),
                                         &sw_write_sink_thunk, 1, "(chunk)", "write"));
  sw_set(sink, "abort", scr_dyn_new_func(sw_closure((void *)&sw_abort_thunk, c), &sw_abort_thunk, 1,
                                         "(reason)", "abort"));
  sw_set(sink, "close", scr_dyn_new_func(sw_closure((void *)&sw_close_thunk, c), &sw_close_thunk, 0,
                                         "()", "close"));

  ScrDyn *strategy = NULL;
  if (object_mode) {
    ScrDyn *init = scr_dyn_new_obj();
    sw_set(init, "highWaterMark", scr_dyn_new_num(hwm));
    ScrDyn *sargs[1] = {init};
    strategy = sw_construct_class(SW_CLS_COUNT_STRATEGY, sargs, 1, "QueuingStrategy");
    scr_dyn_release(init);
  } else {
    strategy = scr_dyn_new_obj();
    sw_set(strategy, "highWaterMark", scr_dyn_new_num(hwm));
    sw_set(strategy, "size", scr_dyn_new_func(sw_closure((void *)&sw_size_thunk, c), &sw_size_thunk,
                                              1, "(chunk)", "size"));
  }
  ScrDyn *web = NULL;
  if (strategy && !scr_exc_pending()) {
    ScrDyn *args[2] = {sink, strategy};
    web = sw_construct_class(SW_CLS_WRITABLE, args, 2, "WritableStream");
  }
  if (strategy) scr_dyn_release(strategy);
  scr_dyn_release(sink);
  if (!web) {
    sw_teardown(c);
    return NULL;
  }
  c->web = scr_dyn_retain(web);

  c->eos = scr_stream_finished_opts(node, sw_closure((void *)&sw_wr_eos, c), &sw_wr_eos, -1, -1, true,
                                    NULL, NULL);
  if (!c->eos) {
    scr_dyn_release(web);
    sw_teardown(c);
    return NULL;
  }
  sw_add_listener(node, "drain", &c->l_drain, (void *)&sw_drain_listener,
                  (void *)&scr_ee_inv_fixed0, c);
  return web;
}

/* ── web -> node ─────────────────────────────────────────────────────── */

typedef struct SwfCtx SwfCtx;
struct SwfCtx {
  size_t rc;
  ScrStream *node;     /* +1 until teardown */
  ScrDyn *reader;      /* +1 or NULL (Writable.fromWeb has none) */
  ScrDyn *writer;      /* +1 */
  ScrDyn *pending;     /* +1: the chunk the read callback deferred */
  ScrDyn *tracker_cb;  /* +1: the write completion the tracker owes */
  ScrDyn *tracker_err; /* +1: the first failure of the current write */
  ScrDyn *deliver_cb;  /* +1: a completion deferred one microtask */
  ScrDyn *deliver_err; /* +1: its error */
  ScrDyn *fail_err;    /* +1: a callback's throw awaiting the deferred destroy */
  size_t pending_writes;
  bool track_has_error;
  bool duplex;          /* Duplex.fromWeb: the destroy aborts instead of closing */
  bool closed;          /* the writer's closed promise settled */
  bool readable_closed; /* the reader's closed promise settled */
  bool live;
  SwfCtx *live_prev, *live_next;
};

static SCR_TL SwfCtx *swf_live = NULL;

static SwfCtx *swf_ref(SwfCtx *c) {
  c->rc++;
  return c;
}

static void swf_drop(SwfCtx *c);

static void swf_unref(SwfCtx *c) {
  if (--c->rc > 0) return;
  swf_drop(c);
  free(c);
}

static void *swf_retain_v(void *p) { return swf_ref(p); }
static void swf_release_v(void *p) { swf_unref(p); }

static ScrClosure *swf_closure(void *fn, SwfCtx *c) {
  ScrClosure *cl = scr_closure_new(fn, 1);
  cl->caps[0] = scr_box_new_obj(&swf_retain_v, &swf_release_v, NULL);
  scr_box_set_ref(cl->caps[0], swf_ref(c));
  return cl;
}

static SwfCtx *swf_of(ScrClosure *cl) { return scr_box_get_ref(cl->caps[0]); /* +1 */ }

/* Drop the node stream (the cycle through its callbacks) and everything
 * else the context holds. */
static void swf_drop(SwfCtx *c) {
  if (c->node) {
    ScrStream *s = c->node;
    c->node = NULL;
    scr_stream_release(s);
  }
  if (c->reader) {
    scr_dyn_release(c->reader);
    c->reader = NULL;
  }
  if (c->writer) {
    scr_dyn_release(c->writer);
    c->writer = NULL;
  }
  if (c->pending) {
    scr_dyn_release(c->pending);
    c->pending = NULL;
  }
  if (c->tracker_cb) {
    scr_dyn_release(c->tracker_cb);
    c->tracker_cb = NULL;
  }
  if (c->tracker_err) {
    scr_dyn_release(c->tracker_err);
    c->tracker_err = NULL;
  }
  if (c->deliver_cb) {
    scr_dyn_release(c->deliver_cb);
    c->deliver_cb = NULL;
  }
  if (c->deliver_err) {
    scr_dyn_release(c->deliver_err);
    c->deliver_err = NULL;
  }
  if (c->fail_err) {
    scr_dyn_release(c->fail_err);
    c->fail_err = NULL;
  }
}

static void swf_teardown(SwfCtx *c) {
  if (!c->live) return;
  c->live = false;
  if (c->live_prev) c->live_prev->live_next = c->live_next;
  else if (swf_live == c) swf_live = c->live_next;
  if (c->live_next) c->live_next->live_prev = c->live_prev;
  c->live_prev = c->live_next = NULL;
  swf_drop(c);
  swf_unref(c);
}

static void swf_atexit(void) {
  while (swf_live) swf_teardown(swf_live);
}

static void swf_push_live(SwfCtx *c) {
  static SCR_TL bool registered = false;
  if (!registered) {
    registered = true;
    scr_atexit(swf_atexit);
  }
  c->live = true;
  c->live_next = swf_live;
  if (swf_live) swf_live->live_prev = c;
  swf_live = c;
}

static void swf_after_callback(SwfCtx *c);

/* The deferred settle: deliver the error to the write completion. */
static void swf_deliver(ScrClosure *job) {
  SwfCtx *c = swf_of(job);
  ScrDyn *cb = c->deliver_cb;
  ScrDyn *err = c->deliver_err;
  c->deliver_cb = NULL;
  c->deliver_err = NULL;
  sw_call_done(cb, err);
  swf_after_callback(c);
  if (cb) scr_dyn_release(cb);
  if (err) scr_dyn_release(err);
  swf_unref(c);
}

/* A completion callback that threw: Node escapes the throw out of the
 * promise context with nextTick(() => destroy(stream, error)). */
static void swf_fail_job(ScrClosure *job) {
  SwfCtx *c = swf_of(job);
  ScrDyn *reason = c->fail_err;
  c->fail_err = NULL;
  if (reason && c->node) {
    ScrError *err = scr_error_from_dyn(reason);
    if (scr_exc_pending()) scr_exc_clear();
    scr_stream_release(scr_stream_destroy(c->node, err));
    if (err) scr_error_release(err);
  }
  if (reason) scr_dyn_release(reason);
  swf_unref(c);
}

static void swf_after_callback(SwfCtx *c) {
  if (!scr_exc_pending()) return;
  ScrDyn *reason = sw_take_caught();
  if (!reason) return;
  if (c->fail_err) scr_dyn_release(c->fail_err);
  c->fail_err = reason;
  scr_next_tick(swf_closure((void *)&swf_fail_job, c));
}

/* Node's tracker.settle(): hand the completion the failure, or complete it
 * now when every write succeeded. */
static void swf_settle(SwfCtx *c) {
  ScrDyn *cb = c->tracker_cb;
  c->tracker_cb = NULL;
  if (!cb) return;
  if (c->track_has_error) {
    ScrDyn *err = c->tracker_err;
    c->tracker_err = NULL;
    c->track_has_error = false;
    c->deliver_cb = cb;
    c->deliver_err = err;
    /* Deliver failures in a microtask: this can run while the writable
     * stream machinery is mid-transition, and the callback usually
     * destroys the stream, which re-enters it. */
    scr_queue_microtask(swf_closure((void *)&swf_deliver, c));
    return;
  }
  sw_call_done(cb, NULL);
  swf_after_callback(c);
  scr_dyn_release(cb);
}

static void swf_track_resolve(SwfCtx *c) {
  if (c->pending_writes) c->pending_writes--;
  if (c->pending_writes == 0 && c->tracker_cb) swf_settle(c);
}

static void swf_track_reject(SwfCtx *c, ScrDyn *err /* +1, may be NULL */) {
  if (c->pending_writes) c->pending_writes--;
  if (!c->track_has_error) {
    c->track_has_error = true;
    if (c->tracker_err) scr_dyn_release(c->tracker_err);
    c->tracker_err = err ? scr_dyn_retain(err) : scr_dyn_new_null();
  }
  if (err) scr_dyn_release(err);
  if (c->pending_writes == 0 && c->tracker_cb) swf_settle(c);
}

/* One dispatched write's completion: resolve, or reject with the caught
 * value. */
typedef struct {
  SwfCtx *c; /* +1 */
  ScrDyn *p; /* +1, the write's promise */
} SwfWrite;

static void swf_write_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SwfWrite w = *(SwfWrite *)arg;
  free(arg);
  ScrDyn *v = scr_await_ref(w.p->v.promise);
  if (v) scr_dyn_release(v);
  if (scr_exc_pending()) {
    ScrDyn *reason = sw_take_caught();
    swf_track_reject(w.c, reason);
  } else {
    swf_track_resolve(w.c);
  }
  scr_dyn_release(w.p);
  swf_unref(w.c);
}

/* writableStreamDefaultWriterWriteWithRequest(writer, chunk, tracker). */
static void swf_dispatch_write(SwfCtx *c, const ScrDyn *chunk) {
  c->pending_writes++;
  ScrDyn *args[1] = {(ScrDyn *)chunk};
  ScrDyn *p = sw_invoke(c->writer, "write", args, 1, "writer.write");
  if (!p) {
    ScrDyn *reason = sw_take_caught();
    swf_track_reject(c, reason);
    return;
  }
  if (p->kind != SCR_DYN_PROMISE) {
    scr_dyn_release(p);
    swf_track_resolve(c);
    return;
  }
  SwfWrite *w = malloc(sizeof *w);
  if (!w) abort();
  w->c = swf_ref(c);
  w->p = p;
  scr_promise_release(scr_async_spawn_after(p->v.promise, &swf_write_entry, w));
}

/* The write option: (chunk, encoding, callback). */
static ScrDyn *swf_write_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwfCtx *c = swf_of(clo);
  ScrDyn *chunk = argc > 0 ? args[0] : NULL;
  ScrDyn *cb = argc > 2 ? args[2] : NULL;
  if (c->tracker_cb) scr_dyn_release(c->tracker_cb);
  c->tracker_cb = cb ? scr_dyn_retain(cb) : NULL;
  swf_dispatch_write(c, chunk ? chunk : scr_dyn_undefined());
  if (c->pending_writes == 0 && c->tracker_cb) swf_settle(c);
  swf_unref(c);
  return sw_undefined();
}

/* The writev option: (chunks, callback). */
static ScrDyn *swf_writev_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwfCtx *c = swf_of(clo);
  ScrDyn *chunks = argc > 0 ? args[0] : NULL;
  ScrDyn *cb = argc > 1 ? args[1] : NULL;
  if (c->tracker_cb) scr_dyn_release(c->tracker_cb);
  c->tracker_cb = cb ? scr_dyn_retain(cb) : NULL;
  if (chunks && chunks->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < chunks->v.arr.len && !scr_exc_pending(); i++) {
      ScrDyn *entry = chunks->v.arr.items[i];
      if (!entry) continue;
      ScrDyn *chunk = sw_get(entry, "chunk");
      if (chunk) {
        swf_dispatch_write(c, chunk);
        scr_dyn_release(chunk);
      }
    }
  }
  if (c->pending_writes == 0 && c->tracker_cb) swf_settle(c);
  swf_unref(c);
  return sw_undefined();
}

/* The final option: (callback) — close the writer, then complete. */
typedef struct {
  SwfCtx *c;  /* +1 */
  ScrDyn *cb; /* +1 */
  ScrDyn *p;  /* +1 */
} SwfFinal;

static void swf_final_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SwfFinal f = *(SwfFinal *)arg;
  free(arg);
  ScrDyn *v = scr_await_ref(f.p->v.promise);
  ScrDyn *err = NULL;
  if (scr_exc_pending()) err = sw_take_caught();
  sw_call_done(f.cb, err);
  swf_after_callback(f.c);
  if (err) scr_dyn_release(err);
  if (v) scr_dyn_release(v);
  if (f.cb) scr_dyn_release(f.cb);
  scr_dyn_release(f.p);
  swf_unref(f.c);
}

static ScrDyn *swf_final_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwfCtx *c = swf_of(clo);
  ScrDyn *cb = argc > 0 ? args[0] : NULL;
  if (c->closed) { /* Node never answers final() once the writer closed */
    swf_unref(c);
    return sw_undefined();
  }
  ScrDyn *p = sw_invoke(c->writer, "close", NULL, 0, "writer.close");
  if (!p) {
    ScrDyn *err = sw_take_caught();
    sw_call_done(cb, err);
    swf_after_callback(c);
    if (err) scr_dyn_release(err);
    swf_unref(c);
    return sw_undefined();
  }
  if (p->kind == SCR_DYN_PROMISE && cb) {
    SwfFinal *f = malloc(sizeof *f);
    if (!f) abort();
    f->c = swf_ref(c);
    f->cb = scr_dyn_retain(cb);
    f->p = p;
    scr_promise_release(scr_async_spawn_after(p->v.promise, &swf_final_entry, f));
    swf_unref(c);
    return sw_undefined();
  }
  scr_dyn_release(p);
  swf_unref(c);
  return sw_undefined();
}

/* The destroy option: (error, callback) — abort or close the writer and
 * the reader, then forward the ORIGINAL error. */
typedef struct {
  SwfCtx *c;   /* +1 */
  ScrDyn *cb;  /* +1 or NULL */
  ScrDyn *err; /* +1 or NULL */
  ScrDyn *p1;  /* +1 or NULL */
  ScrDyn *p2;  /* +1 or NULL */
} SwfDestroy;

static void swf_destroy_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SwfDestroy d = *(SwfDestroy *)arg;
  free(arg);
  for (int i = 0; i < 2; i++) {
    ScrDyn *p = i == 0 ? d.p1 : d.p2;
    if (!p) continue;
    ScrDyn *v = scr_await_ref(p->v.promise);
    if (v) scr_dyn_release(v);
    if (scr_exc_pending()) scr_exc_clear();
    scr_dyn_release(p);
  }
  sw_call_done(d.cb, d.err);
  swf_after_callback(d.c);
  if (d.cb) scr_dyn_release(d.cb);
  if (d.err) scr_dyn_release(d.err);
  swf_unref(d.c);
}

static ScrDyn *swf_destroy_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  SwfCtx *c = swf_of(clo);
  ScrDyn *err = argc > 0 && args[0] && args[0]->kind != SCR_DYN_NULL &&
                        args[0]->kind != SCR_DYN_UNDEF
                    ? args[0]
                    : NULL;
  ScrDyn *cb = argc > 1 ? args[1] : NULL;
  bool writer_open = c->writer && !c->closed;
  bool reader_open = c->reader && !c->readable_closed;
  if (!writer_open && !reader_open) {
    sw_call_done(cb, err);
    swf_after_callback(c);
    swf_unref(c);
    return sw_undefined();
  }
  ScrDyn *p1 = NULL, *p2 = NULL;
  if (writer_open) {
    /* A duplex aborts its writer even without an error; the
     * Writable.fromWeb adapter closes it then. */
    if (c->duplex || err) {
      ScrDyn *a[1] = {err ? err : scr_dyn_undefined()};
      p1 = sw_invoke(c->writer, "abort", a, 1, "writer.abort");
    } else {
      p1 = sw_invoke(c->writer, "close", NULL, 0, "writer.close");
    }
    if (scr_exc_pending()) scr_exc_clear();
  }
  if (reader_open) {
    ScrDyn *a[1] = {err ? err : scr_dyn_undefined()};
    p2 = sw_invoke(c->reader, "cancel", a, 1, "reader.cancel");
    if (scr_exc_pending()) scr_exc_clear();
  }
  ScrDyn *wait = p1 && p1->kind == SCR_DYN_PROMISE ? p1 : p2 && p2->kind == SCR_DYN_PROMISE ? p2 : NULL;
  if (wait) {
    SwfDestroy *d = malloc(sizeof *d);
    if (!d) abort();
    d->c = swf_ref(c);
    d->cb = cb ? scr_dyn_retain(cb) : NULL;
    d->err = err ? scr_dyn_retain(err) : NULL;
    d->p1 = p1 && p1->kind == SCR_DYN_PROMISE ? p1 : NULL;
    d->p2 = p2 && p2->kind == SCR_DYN_PROMISE ? p2 : NULL;
    if (!d->p1 && p1) scr_dyn_release(p1);
    if (!d->p2 && p2) scr_dyn_release(p2);
    scr_promise_release(scr_async_spawn_after(wait->v.promise, &swf_destroy_entry, d));
    swf_unref(c);
    return sw_undefined();
  }
  if (p1) scr_dyn_release(p1);
  if (p2) scr_dyn_release(p2);
  sw_call_done(cb, err);
  swf_after_callback(c);
  swf_unref(c);
  return sw_undefined();
}

/* forwardChunk: node.push(pendingChunk) in a microtask. */
static void swf_forward(ScrClosure *job) {
  SwfCtx *c = swf_of(job);
  ScrDyn *chunk = c->pending;
  c->pending = NULL;
  if (chunk && c->node) {
    scr_stream_push_dyn(c->node, chunk);
    if (scr_exc_pending()) scr_exc_clear();
  }
  if (chunk) scr_dyn_release(chunk);
  swf_unref(c);
}

static void swf_sink_chunk(void *ctx, ScrDyn *value) {
  SwfCtx *c = ctx;
  if (c->pending) scr_dyn_release(c->pending);
  c->pending = value ? scr_dyn_retain(value) : NULL;
  scr_queue_microtask(swf_closure((void *)&swf_forward, c));
  swf_unref(c); /* the request's reference */
}

static void swf_sink_close(void *ctx) {
  SwfCtx *c = ctx;
  if (c->node) scr_stream_push_null(c->node);
  if (scr_exc_pending()) scr_exc_clear();
  swf_unref(c);
}

static void swf_sink_error(void *ctx, ScrDyn *reason) {
  SwfCtx *c = ctx;
  if (c->node) {
    ScrError *err = reason ? scr_error_from_dyn(reason) : NULL;
    if (scr_exc_pending()) scr_exc_clear();
    scr_stream_release(scr_stream_destroy(c->node, err));
    if (err) scr_error_release(err);
  }
  swf_unref(c);
}

static const ScrFetchReadSink swf_sink = {&swf_sink_chunk, &swf_sink_close, &swf_sink_error};

/* One read request on the web stream's reader. The checked-dynamic web
 * stream classes answer through the bridge they install (a reader of
 * theirs); a program that also links the fetch unit reads its own bodies
 * through scr_fetch_reader_read_into. A program with neither cannot hold a
 * reader: the web streams unit is what makes them. */
static bool swf_read_into(ScrDyn *reader, const ScrFetchReadSink *sink, void *ctx) {
  if (scr_web_stream_bridge && reader && reader->kind == SCR_DYN_HANDLE &&
      reader->v.handle.tag == SCR_DYNH_WS_READER)
    return scr_web_stream_bridge->reader_read_into(reader, sink, ctx);
#ifdef SCR_STREAM_WEB_FETCH
  return scr_fetch_reader_read_into(reader, sink, ctx);
#else
  (void)reader;
  (void)sink;
  (void)ctx;
  static const char m[] = "Expected a ReadableStreamDefaultReader";
  scr_throw_error_msg(SCR_ERR_TYPE, m, sizeof m - 1);
  return false;
#endif
}

/* The read option: (size). One read request in flight, as Node's adapter
 * keeps. */
static ScrDyn *swf_read_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  SwfCtx *c = swf_of(clo);
  /* Node's adapter reads whatever the reader's state is: a stream that
   * ended answers done, which pushes the end, and one that errored
   * answers its error; both are the read request's answer either way. The
   * reader is only gone once the context dropped the node stream. */
  if (c->reader) {
    if (!swf_read_into(c->reader, &swf_sink, swf_ref(c))) {
      swf_unref(c);
      if (scr_exc_pending()) scr_exc_clear();
    }
  }
  swf_unref(c);
  return sw_undefined();
}

/* writer.closed / reader.closed reactions. */
typedef struct {
  SwfCtx *c; /* +1 */
  ScrDyn *p; /* +1, the .closed promise */
  bool reader;
} SwfClosed;

static void swf_closed_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  SwfClosed w = *(SwfClosed *)arg;
  free(arg);
  ScrDyn *v = scr_await_ref(w.p->v.promise);
  if (v) scr_dyn_release(v);
  bool rejected = scr_exc_pending();
  ScrDyn *reason = rejected ? sw_take_caught() : NULL;
  if (w.reader) {
    w.c->readable_closed = true;
    if (rejected) {
      w.c->closed = true;
      if (w.c->node) {
        ScrError *err = NULL;
        if (reason) {
          err = scr_error_from_dyn(reason);
          if (scr_exc_pending()) scr_exc_clear();
        }
        scr_stream_release(scr_stream_destroy(w.c->node, err));
        if (err) scr_error_release(err);
      }
    }
  } else {
    w.c->closed = true;
    if (w.c->node) {
      if (rejected) {
        ScrError *err = NULL;
        if (reason) {
          err = scr_error_from_dyn(reason);
          if (scr_exc_pending()) scr_exc_clear();
        }
        scr_stream_release(scr_stream_destroy(w.c->node, err));
        if (err) scr_error_release(err);
      } else if (!scr_stream_prop(w.c->node, "writableEnded")) {
        ScrError *premature = sw_premature_close();
        if (premature) {
          scr_stream_release(scr_stream_destroy(w.c->node, premature));
          scr_error_release(premature);
        }
      }
    }
  }
  if (reason) scr_dyn_release(reason);
  scr_dyn_release(w.p);
  swf_unref(w.c);
}

static void swf_watch_closed(SwfCtx *c, ScrDyn *object, bool reader) {
  ScrStr *key = scr_str_new("closed", 6);
  ScrDyn *closed = object ? scr_dyn_handle_key_get(object, key) : NULL;
  scr_str_release(key);
  if (!closed) return;
  if (closed->kind == SCR_DYN_PROMISE) {
    SwfClosed *w = malloc(sizeof *w);
    if (!w) abort();
    w->c = swf_ref(c);
    w->p = closed;
    w->reader = reader;
    scr_promise_release(scr_async_spawn_after(closed->v.promise, &swf_closed_entry, w));
  } else {
    scr_dyn_release(closed);
  }
}

/* An option value read from a bag, +1; undefined when absent. */
static ScrDyn *swf_opt(const ScrDyn *opts, const char *key) { return sw_get(opts, key); }

/* validateBoolean(value, name): undefined passes as the default. */
static bool swf_read_bool(const ScrDyn *v, const char *name, bool dflt, bool *out) {
  if (!v || v->kind == SCR_DYN_UNDEF) {
    *out = dflt;
    return true;
  }
  if (v->kind != SCR_DYN_BOOL) {
    scr_dyn_prop_type_fail(name, "of type boolean", v);
    return false;
  }
  *out = v->v.b;
  return true;
}

/* The options bag the native constructor reads: the validated option
 * values plus the adapter's callbacks. */
static ScrDyn *swf_build_options(SwfCtx *c, const ScrDyn *high_water_mark, const ScrDyn *object_mode,
                                 const ScrDyn *decode_strings, const ScrDyn *encoding,
                                 const ScrDyn *allow_half_open, bool duplex) {
  ScrDyn *opts = scr_dyn_new_obj();
  if (high_water_mark && high_water_mark->kind != SCR_DYN_UNDEF)
    sw_set(opts, "highWaterMark", scr_dyn_retain((ScrDyn *)high_water_mark));
  if (object_mode) sw_set(opts, "objectMode", scr_dyn_retain((ScrDyn *)object_mode));
  if (decode_strings) sw_set(opts, "decodeStrings", scr_dyn_retain((ScrDyn *)decode_strings));
  if (encoding && encoding->kind != SCR_DYN_UNDEF)
    sw_set(opts, "encoding", scr_dyn_retain((ScrDyn *)encoding));
  if (allow_half_open) sw_set(opts, "allowHalfOpen", scr_dyn_retain((ScrDyn *)allow_half_open));
  sw_set(opts, "write",
         scr_dyn_new_func(swf_closure((void *)&swf_write_thunk, c), &swf_write_thunk, 3,
                          "(chunk, encoding, callback)", "write"));
  sw_set(opts, "writev",
         scr_dyn_new_func(swf_closure((void *)&swf_writev_thunk, c), &swf_writev_thunk, 2,
                          "(chunks, callback)", "writev"));
  sw_set(opts, "final",
         scr_dyn_new_func(swf_closure((void *)&swf_final_thunk, c), &swf_final_thunk, 1,
                          "(callback)", "final"));
  sw_set(opts, "destroy",
         scr_dyn_new_func(swf_closure((void *)&swf_destroy_thunk, c), &swf_destroy_thunk, 2,
                          "(error, callback)", "destroy"));
  if (duplex) {
    /* Node's adapter declares read() with no parameters. */
    sw_set(opts, "read", scr_dyn_new_func(swf_closure((void *)&swf_read_thunk, c), &swf_read_thunk,
                                          0, "()", "read"));
  }
  return opts;
}

/* The value as a web stream of the requested kind, or NULL with Node's
 * ERR_INVALID_ARG_TYPE pending. */
static bool swf_is_web_stream(const ScrDyn *value, bool writable) {
  if (!value || value->kind != SCR_DYN_HANDLE) return false;
  ScrDynHandleTag tag = value->v.handle.tag;
  if (writable) return tag == SCR_DYNH_WS_WRITABLE || tag == SCR_DYNH_WEB_WRITABLE;
  return tag == SCR_DYNH_WS_READABLE || tag == SCR_DYNH_WEB_STREAM;
}

/* A validated options value: the bag itself (NULL for absent) or NULL with
 * the exception pending. */
static const ScrDyn *swf_options_arg(const ScrDyn *options, bool *ok) {
  if (!options || options->kind == SCR_DYN_UNDEF) return NULL;
  if (!sw_validate_object(options, "options")) {
    *ok = false;
    return NULL;
  }
  return options;
}

/* The four option values the adapters validate themselves, +1 each. */
typedef struct {
  ScrDyn *hwm, *object, *encoding, *decode, *half_open, *signal;
} SwfOpts;

static void swf_opts_read(const ScrDyn *opts, SwfOpts *o) {
  o->hwm = swf_opt(opts, "highWaterMark");
  o->object = swf_opt(opts, "objectMode");
  o->encoding = swf_opt(opts, "encoding");
  o->decode = swf_opt(opts, "decodeStrings");
  o->half_open = swf_opt(opts, "allowHalfOpen");
  o->signal = swf_opt(opts, "signal");
}

static void swf_opts_release(SwfOpts *o) {
  if (o->hwm) scr_dyn_release(o->hwm);
  if (o->object) scr_dyn_release(o->object);
  if (o->encoding) scr_dyn_release(o->encoding);
  if (o->decode) scr_dyn_release(o->decode);
  if (o->half_open) scr_dyn_release(o->half_open);
  if (o->signal) scr_dyn_release(o->signal);
  o->hwm = o->object = o->encoding = o->decode = o->half_open = o->signal = NULL;
}

/* Node's newStreamWritableFromWritableStream. +1, or NULL with the
 * exception pending. */
ScrStream *scr_stream_writable_from_web(const ScrDyn *writable_stream, const ScrDyn *options) {
  if (!swf_is_web_stream(writable_stream, true)) {
    scr_dyn_arg_type_fail("writableStream", "an instance of WritableStream", sw_arg(writable_stream));
    return NULL;
  }
  bool ok = true;
  const ScrDyn *opts = swf_options_arg(options, &ok);
  if (!ok) return NULL;
  SwfOpts o;
  swf_opts_read(opts, &o);
  bool object_mode = false, decode_strings = true;
  ok = swf_read_bool(o.object, "options.objectMode", false, &object_mode) &&
       swf_read_bool(o.decode, "options.decodeStrings", true, &decode_strings);
  if (!ok) {
    swf_opts_release(&o);
    return NULL;
  }
  ScrDyn *writer = sw_invoke((ScrDyn *)writable_stream, "getWriter", NULL, 0,
                             "writableStream.getWriter");
  if (!writer) {
    swf_opts_release(&o);
    return NULL;
  }
  SwfCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->writer = writer;
  ScrDyn *bag = swf_build_options(c, o.hwm, o.object, o.decode, NULL, NULL, false);
  ScrStream *s = scr_stream_new_writable_dyn(bag);
  scr_dyn_release(bag);
  if (!s) {
    swf_opts_release(&o);
    if (c->writer) scr_dyn_release(c->writer);
    free(c);
    return NULL;
  }
  c->node = scr_stream_retain(s);
  swf_push_live(c);
  if (o.signal && o.signal->kind != SCR_DYN_UNDEF && o.signal->kind != SCR_DYN_NULL)
    scr_stream_release(scr_stream_add_abort_signal(s, o.signal, true,
                                                   scr_events_add_abort_listener));
  swf_opts_release(&o);
  swf_watch_closed(c, c->writer, false);
  return s;
}

/* Node's newStreamDuplexFromReadableWritablePair. +1, or NULL with the
 * exception pending. */
static ScrStream *swf_duplex_from_web(const ScrDyn *pair, const ScrDyn *options) {
  if (!sw_validate_object(sw_arg(pair), "pair")) return NULL;
  ScrDyn *readable = sw_get(pair, "readable");
  ScrDyn *writable = sw_get(pair, "writable");
  bool ok = !scr_exc_pending();
  if (ok && !swf_is_web_stream(readable, false)) {
    scr_dyn_arg_type_fail("pair.readable", "an instance of ReadableStream", readable);
    ok = false;
  }
  if (ok && !swf_is_web_stream(writable, true)) {
    scr_dyn_arg_type_fail("pair.writable", "an instance of WritableStream", writable);
    ok = false;
  }
  const ScrDyn *opts = NULL;
  if (ok) opts = swf_options_arg(options, &ok);
  SwfOpts o = {0};
  bool object_mode = false;
  if (ok) {
    swf_opts_read(opts, &o);
    /* Node validates objectMode and encoding here, nothing else: a
     * non-boolean allowHalfOpen reaches the Duplex constructor as-is. */
    ok = swf_read_bool(o.object, "options.objectMode", false, &object_mode);
    if (ok && o.encoding && o.encoding->kind != SCR_DYN_UNDEF &&
        (o.encoding->kind != SCR_DYN_STR || !scr_bytes_is_encoding(o.encoding->v.str))) {
      scr_dyn_arg_value_fail("options.encoding", NULL, o.encoding);
      ok = false;
    }
  }
  ScrDyn *writer = ok ? sw_invoke(writable, "getWriter", NULL, 0, "writableStream.getWriter") : NULL;
  ScrDyn *reader =
      writer ? sw_invoke(readable, "getReader", NULL, 0, "readableStream.getReader") : NULL;
  if (readable) scr_dyn_release(readable);
  if (writable) scr_dyn_release(writable);
  if (!reader) {
    if (writer) scr_dyn_release(writer);
    swf_opts_release(&o);
    return NULL;
  }
  SwfCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  c->rc = 1;
  c->writer = writer;
  c->reader = reader;
  c->duplex = true;
  /* The adapter's allowHalfOpen default is false, unlike Duplex's. */
  ScrDyn *half = o.half_open && o.half_open->kind != SCR_DYN_UNDEF ? scr_dyn_retain(o.half_open)
                                                                  : scr_dyn_new_bool(false);
  ScrDyn *bag = swf_build_options(c, o.hwm, o.object, o.decode, o.encoding, half, true);
  scr_dyn_release(half);
  ScrStream *s = scr_stream_new_duplex_dyn(bag);
  scr_dyn_release(bag);
  if (!s) {
    swf_opts_release(&o);
    if (c->writer) scr_dyn_release(c->writer);
    if (c->reader) scr_dyn_release(c->reader);
    free(c);
    return NULL;
  }
  c->node = scr_stream_retain(s);
  swf_push_live(c);
  if (o.signal && o.signal->kind != SCR_DYN_UNDEF && o.signal->kind != SCR_DYN_NULL)
    scr_stream_release(scr_stream_add_abort_signal(s, o.signal, true,
                                                   scr_events_add_abort_listener));
  swf_opts_release(&o);
  swf_watch_closed(c, c->writer, false);
  swf_watch_closed(c, c->reader, true);
  return s;
}

/* Node's pair parameter defaults to an empty object, so an undefined pair
 * reports the missing 'readable' property instead of the pair itself. */
ScrStream *scr_stream_duplex_from_web(const ScrDyn *pair, const ScrDyn *options) {
  if (pair && pair->kind != SCR_DYN_UNDEF) return swf_duplex_from_web(pair, options);
  ScrDyn *empty = scr_dyn_new_obj();
  ScrStream *s = swf_duplex_from_web(empty, options);
  scr_dyn_release(empty);
  return s;
}

/* ── the five statics ───────────────────────────────────────────────── */

/* Node's ERR_INVALID_ARG_TYPE over a value that may be a node stream: its
 * determineSpecificType names the stream's class ("an instance of
 * Readable"), which the shared renderer cannot see because a node stream
 * reaches a dynamic parameter as a typed-ref capsule; any other value keeps
 * the shared rendering. */
static void sw_arg_type_fail_native(const char *name, const char *expected, const ScrDyn *value) {
  ScrStream *s = value ? scr_stream_dyn_native(value, 1) : NULL;
  if (!s && value) s = scr_stream_dyn_native(value, 2);
  if (!s) {
    scr_dyn_arg_type_fail(name, expected, sw_arg(value));
    return;
  }
  char m[256];
  int n = snprintf(m, sizeof m, "The \"%s\" %s must be %s. Received an instance of %s", name,
                   strchr(name, '.') ? "property" : "argument", expected,
                   s->cls ? s->cls : "Stream");
  scr_stream_release(s);
  scr_throw_error_msg_code(SCR_ERR_TYPE, m, (size_t)n, "ERR_INVALID_ARG_TYPE");
}

/* The native stream a value boxes (+1), or NULL with Node's
 * ERR_INVALID_ARG_TYPE pending. `side` is 1 (readable), 2 (writable) or 3
 * (both sides, Node's isDuplex). */
static ScrStream *sw_native_arg(const ScrDyn *value, double side, const char *name,
                               const char *what) {
  ScrStream *s = value ? scr_stream_dyn_native(value, side) : NULL;
  if (!s) sw_arg_type_fail_native(name, what, value);
  return s;
}

/* Readable.toWeb(streamReadable[, options]) */
ScrDyn *scr_stream_readable_to_web(const ScrDyn *stream, const ScrDyn *options) {
  ScrStream *node = sw_native_arg(stream, 1, "streamReadable", "an stream.Readable");
  if (!node) return NULL;
  bool ok = true;
  const ScrDyn *opts = swf_options_arg(options, &ok);
  if (!ok) {
    scr_stream_release(node);
    return NULL;
  }
  ScrDyn *type = sw_read_type(opts);
  ScrDyn *web = NULL;
  if (type && !scr_exc_pending()) web = sw_readable_to_web(node, type, opts);
  if (type) scr_dyn_release(type);
  scr_stream_release(node);
  return web;
}

/* Writable.toWeb(streamWritable) */
ScrDyn *scr_stream_writable_to_web(const ScrDyn *stream) {
  ScrStream *node = sw_native_arg(stream, 2, "streamWritable", "an stream.Writable");
  if (!node) return NULL;
  ScrDyn *web;
  if (scr_stream_prop(node, "destroyed") || !scr_stream_prop(node, "writable")) {
    web = sw_closed_writable();
  } else {
    web = sw_writable_to_web(node);
  }
  scr_stream_release(node);
  return web;
}

/* The `type` Duplex.toWeb builds its readable options from:
 * readableType ?? type (+1, possibly undefined). */
static ScrDyn *sw_pair_type(const ScrDyn *opts) {
  ScrDyn *type = sw_get(opts, "readableType");
  if (type && (type->kind == SCR_DYN_UNDEF || type->kind == SCR_DYN_NULL)) {
    scr_dyn_release(type);
    return sw_get(opts, "type");
  }
  return type ? type : scr_dyn_undefined();
}

/* Duplex.toWeb(duplex[, options]) */
ScrDyn *scr_stream_duplex_to_web(const ScrDyn *stream, const ScrDyn *options) {
  ScrStream *node = sw_native_arg(stream, 3, "duplex", "an stream.Duplex");
  if (!node) return NULL;
  bool ok = true;
  const ScrDyn *opts = swf_options_arg(options, &ok);
  if (!ok) {
    scr_stream_release(node);
    return NULL;
  }
  bool destroyed = scr_stream_prop(node, "destroyed") != 0;
  bool is_readable = scr_stream_prop(node, "readable") != 0;
  bool is_writable = scr_stream_prop(node, "writable") != 0;
  ScrDyn *readable = NULL, *writable = NULL, *pair = NULL;

  if (destroyed) {
    ScrDyn *type = sw_pair_type(opts);
    if (type && type->kind != SCR_DYN_UNDEF) {
      ScrDyn *init = scr_dyn_new_obj();
      sw_set(init, "type", type);
      ScrDyn *args[1] = {init};
      readable = sw_construct_class(SW_CLS_READABLE, args, 1, "ReadableStream");
      scr_dyn_release(init);
    } else {
      if (type) scr_dyn_release(type);
      readable = sw_construct_class(SW_CLS_READABLE, NULL, 0, "ReadableStream");
    }
    if (readable) {
      ScrDyn *r = sw_invoke(readable, "cancel", NULL, 0, "readableStream.cancel");
      if (r) scr_dyn_release(r);
      if (scr_exc_pending()) scr_exc_clear();
    }
    writable = sw_closed_writable();
    if (readable && writable) {
      pair = scr_dyn_new_obj();
      sw_set(pair, "readable", readable);
      sw_set(pair, "writable", writable);
    } else {
      if (readable) scr_dyn_release(readable);
      if (writable) scr_dyn_release(writable);
    }
    scr_stream_release(node);
    return pair;
  }

  /* Node builds the writable side first, then the readable one. */
  writable = is_writable ? sw_writable_to_web(node) : sw_closed_writable();
  if (!writable) {
    scr_stream_release(node);
    return NULL;
  }
  ScrDyn *type = sw_pair_type(opts);
  if (is_readable) {
    /* validateOneOf(options.type) runs inside
     * newReadableStreamFromStreamReadable, so only on this path. */
    if (type->kind != SCR_DYN_UNDEF && !(type->kind == SCR_DYN_STR && type->v.str->len == 5 &&
                                        memcmp(type->v.str->data, "bytes", 5) == 0)) {
      scr_dyn_arg_value_fail("options.type", "must be one of: 'bytes', undefined", type);
      scr_dyn_release(type);
      scr_dyn_release(writable);
      scr_stream_release(node);
      return NULL;
    }
    readable = sw_readable_to_web(node, type, NULL);
  } else {
    /* new ReadableStream({ type }) — the constructor reports an invalid
     * value. */
    if (type->kind != SCR_DYN_UNDEF) {
      ScrDyn *init = scr_dyn_new_obj();
      /* The object owns the reference it is given; this function still
       * holds (and releases) the caller's, so pass it a retained one. */
      sw_set(init, "type", scr_dyn_retain(type));
      ScrDyn *args[1] = {init};
      readable = sw_construct_class(SW_CLS_READABLE, args, 1, "ReadableStream");
      scr_dyn_release(init);
    } else {
      readable = sw_construct_class(SW_CLS_READABLE, NULL, 0, "ReadableStream");
    }
    if (readable) {
      ScrDyn *r = sw_invoke(readable, "cancel", NULL, 0, "readableStream.cancel");
      if (r) scr_dyn_release(r);
      if (scr_exc_pending()) scr_exc_clear();
    }
  }
  scr_dyn_release(type);
  if (!readable) {
    scr_dyn_release(writable);
    scr_stream_release(node);
    return NULL;
  }
  pair = scr_dyn_new_obj();
  sw_set(pair, "writable", writable);
  sw_set(pair, "readable", readable);
  scr_stream_release(node);
  return pair;
}
