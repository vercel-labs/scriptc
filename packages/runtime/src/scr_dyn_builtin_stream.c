/* Native stream state for JavaScript constructor functions that inherit
 * from the node:stream classes the pre-class way:
 *
 *   function Source(opts) { Readable.call(this, opts); }
 *   util.inherits(Source, Readable);
 *   Source.prototype._read = function (n) { this.push(...); };
 *
 * scr_dyn_builtin_class.c provides Readable, Writable, Duplex, Transform
 * and PassThrough as untyped constructors with Node's prototype chain.
 * This unit (the dynBuiltinStream feature) gives them their stream half:
 *
 * - `Readable.call(this, opts)` (and the other four) creates a runtime
 *   stream (scr_stream.c) over the receiver. The receiver keeps it in a
 *   hidden slot (an entry of its symbol table that no symbol can name),
 *   so JavaScript sees only the properties Node's constructor adds:
 *   `_readableState` / `_writableState` (live read-only views of the
 *   runtime state), `allowHalfOpen` on the duplex kinds, and the option
 *   callbacks copied to `_read`, `_write`, `_final`, `_destroy`,
 *   `_transform` and `_flush`.
 * - The runtime stream calls the receiver's `_read`, `_write`,
 *   `_transform`, `_flush`, `_final` and `_destroy` through its property
 *   lookup, with the receiver as `this`, as Node's machinery does.
 * - The stream prototypes carry Node's methods and accessors (push, read,
 *   write, end, pipe, destroy, readable, destroyed, ...) over the hidden
 *   stream, and EventEmitter's methods register listeners with the runtime
 *   stream's own emitter (scr_dyn_builtin_class.c forwards to them), so the
 *   runtime's events and pipes reach JavaScript listeners with the
 *   receiver as `this`.
 *
 * Lifetime: the receiver holds its stream through a traced capsule, and
 * the stream's hook closures hold the receiver through traced boxes, so
 * the pair lives while either is reachable and the cycle collector
 * reclaims it afterwards. The stream's native record points back at the
 * receiver without a reference; the hook closures outlive the record.
 *
 * Not supported here (each throws the "not supported yet" Error where it
 * runs): the options scr_stream.c's dyn option walk refuses, symbol event names, listeners() /
 * rawListeners(), `wrap()`, and pipes into values that are neither runtime
 * streams nor constructor-function streams. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { BCS_READABLE = 2, BCS_WRITABLE, BCS_DUPLEX, BCS_TRANSFORM, BCS_PASSTHROUGH };

static const char bcs_hidden_key[] = "scriptc:stream";
#define BCS_HIDDEN_LEN (sizeof bcs_hidden_key - 1)

/* The runtime stream's native record. */
struct BcsRec;
typedef struct BcsRec {
  ScrDyn *object; /* borrowed: the hook closures keep it alive */
  ScrDyn **destroy_cbs; /* destroy(err, cb) callbacks waiting for _destroy */
  size_t destroy_n, destroy_cap;
  char cls[64]; /* the constructor's name, for the leak warning */
} BcsRec;

static void bcs_rec_release(void *p) {
  BcsRec *rec = p;
  for (size_t i = 0; i < rec->destroy_n; i++) scr_dyn_release(rec->destroy_cbs[i]);
  free(rec->destroy_cbs);
  free(rec);
}

static BcsRec *bcs_rec(ScrStream *s) {
  return scr_stream_native(s, bcs_rec_release);
}

/* ── small helpers ──────────────────────────────────────────────────── */

static ScrDyn *bcs_key(const char *name) {
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrDyn *key = scr_dyn_new_str(text);
  scr_str_release(text);
  return key;
}

/* object[name] with object as the receiver: +1, or NULL with an exception
 * pending. */
static ScrDyn *bcs_get(ScrDyn *object, const char *name) {
  ScrDyn *key = bcs_key(name);
  ScrDyn *value = scr_dyn_reflect_get(object, key, object);
  scr_dyn_release(key);
  if (!value && !scr_exc_pending()) value = scr_dyn_retain(scr_dyn_undefined());
  return value;
}

/* object[name] = value; the value moves in. */
static bool bcs_set(ScrDyn *object, const char *name, ScrDyn *value) {
  ScrDyn *key = bcs_key(name);
  scr_dyn_key_set_computed(object, key, value);
  scr_dyn_release(key);
  scr_dyn_release(value);
  return !scr_exc_pending();
}

static ScrDyn *bcs_arg(ScrDyn *const *args, size_t argc, size_t index) {
  return index < argc ? args[index] : scr_dyn_undefined();
}

static bool bcs_nullish(const ScrDyn *value) {
  return value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL;
}

static ScrDyn *bcs_undefined(void) {
  return scr_dyn_retain(scr_dyn_undefined());
}

static void bcs_unsupported(const char *message) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
}

/* fn.call(self, ...args): +1 or NULL. */
static ScrDyn *bcs_apply(ScrDyn *fn, ScrDyn *self, ScrDyn *const *args, size_t argc, const char *what) {
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  return result;
}

/* An error argument of a completion callback or destroy(): NULL for a
 * falsy value (Node tests `if (err)`), else the runtime error that boxes
 * back to the same JavaScript value (+1). */
static ScrError *bcs_error_of(const ScrDyn *value) {
  if (!scr_dyn_truthy(value)) return NULL;
  if (value->kind == SCR_DYN_STR) return scr_error_new(SCR_ERR_ERROR, value->v.str);
  return scr_error_from_dyn(value);
}

/* ── the hidden slot ────────────────────────────────────────────────── */

static void *bcs_capsule_retain(void *p) { return scr_stream_retain(p); }
/* Also the capsule's tag. */
static void bcs_capsule_release(void *p) { scr_stream_release(p); }

/* Whether `stream`, boxed as an "object:" typed ref, is a runtime stream. */
static bool bcs_stream_vt(const ScrStream *stream) {
  const ScrVt *vt = scr_stream_vt_of(stream);
  return vt != NULL && ((vt->pre >= scr_readable_vt.pre && vt->pre <= scr_readable_vt.post) ||
                        (vt->pre >= scr_writable_vt.pre && vt->pre <= scr_writable_vt.post));
}

static void bcs_rec_release(void *p);

/* The stream of a constructor-function stream or one of its state views,
 * or of a typed capsule of such a stream (a typed stream value that
 * crossed back into JavaScript), borrowed; NULL for other values. */
static ScrStream *bcs_of(const ScrDyn *value) {
  if (value != NULL && value->kind == SCR_DYN_TYPED_REF && value->v.typed_ref.type_key_len > 7 &&
      memcmp(value->v.typed_ref.type_key, "object:", 7) == 0) {
    ScrStream *stream = value->v.typed_ref.ptr;
    return bcs_stream_vt(stream) && scr_stream_native(stream, bcs_rec_release) ? stream : NULL;
  }
  if (value == NULL || value->kind != SCR_DYN_OBJ || value->symbol_properties == NULL) return NULL;
  ScrDyn *capsule = scr_dyn_obj_get(value->symbol_properties, bcs_hidden_key, BCS_HIDDEN_LEN);
  if (capsule == NULL || capsule->kind != SCR_DYN_TYPED_REF ||
      capsule->v.typed_ref.release != bcs_capsule_release)
    return NULL;
  return capsule->v.typed_ref.ptr;
}

/* Stores the stream in the object's symbol table under a storage name no
 * symbol produces (symbols store under their address), outside the key
 * list, so no reflection reaches it. */
static void bcs_hide(ScrDyn *object, ScrStream *s) {
  scr_dyn_region_store(object, NULL);
  if (!object->symbol_properties) object->symbol_properties = scr_dyn_new_obj_null_proto();
  if (!object->symbol_keys) object->symbol_keys = scr_dyn_new_arr();
  ScrDyn *capsule = scr_dyn_new_typed_ref_traced(s, bcs_capsule_retain, bcs_capsule_release,
                                                 bcs_hidden_key, BCS_HIDDEN_LEN,
                                                 scr_dyn_class_view_unavailable, NULL);
  scr_dyn_obj_set(object->symbol_properties, bcs_hidden_key, BCS_HIDDEN_LEN, capsule);
}

/* A runtime stream boxed as a typed capsule (a typed stream value that
 * crossed into JavaScript): +1, or NULL. */
static ScrStream *bcs_native_of(const ScrDyn *value) {
  if (value->kind != SCR_DYN_TYPED_REF || value->v.typed_ref.type_key_len <= 7 ||
      memcmp(value->v.typed_ref.type_key, "object:", 7) != 0)
    return NULL;
  ScrStream *stream = scr_dyn_typed_ref_unbox(value);
  if (bcs_stream_vt(stream)) return stream;
  value->v.typed_ref.release(stream);
  return NULL;
}

/* Any stream a JavaScript value stands for (+1), or NULL. */
ScrStream *scr_dyn_builtin_stream_of(const ScrDyn *value) {
  ScrStream *own = bcs_of(value);
  if (own) return scr_stream_retain(own);
  return bcs_native_of(value);
}

/* The JavaScript value of a runtime stream: the constructor-function
 * object it belongs to (+1), or NULL for other streams. */
ScrDyn *scr_dyn_builtin_stream_object(ScrStream *s) {
  BcsRec *rec = bcs_rec(s);
  return rec ? scr_dyn_retain(rec->object) : NULL;
}

/* A stream as a listener argument: its constructor-function object, or a
 * live view of another runtime stream whose pipe and unpipe take those
 * objects (scr_dyn_builtin_stream_view). +1. */
static ScrDyn *bcs_stream_value(ScrStream *s) {
  return scr_dyn_builtin_stream_view(s);
}

/* The receiver's stream for a prototype method, borrowed; throws Node's
 * TypeError (reading the state of a non-stream) and answers NULL. */
static ScrStream *bcs_need(ScrDyn *self, const char *reading) {
  ScrStream *s = bcs_of(self);
  if (s) return s;
  char message[128];
  if (bcs_nullish(self)) {
    snprintf(message, sizeof message, "Cannot read properties of %s (reading '%s')",
             self->kind == SCR_DYN_NULL ? "null" : "undefined", reading);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  } else {
    snprintf(message, sizeof message,
             "stream method '%s' on an object without stream state is not supported yet", reading);
    bcs_unsupported(message);
  }
  return NULL;
}

/* ── completion callbacks ───────────────────────────────────────────── */

enum { BCS_DONE_WRITE, BCS_DONE_FINAL, BCS_DONE_DESTROY, BCS_DONE_TRANSFORM, BCS_DONE_FLUSH, BCS_DONE_CONSTRUCT };

static void bcs_run_destroy_cbs(ScrStream *s, ScrError *err) {
  BcsRec *rec = bcs_rec(s);
  if (!rec || rec->destroy_n == 0) return;
  ScrDyn **cbs = rec->destroy_cbs;
  size_t n = rec->destroy_n;
  rec->destroy_cbs = NULL;
  rec->destroy_n = rec->destroy_cap = 0;
  ScrDyn *arg = err ? scr_dyn_from_error(err) : scr_dyn_new_null();
  ScrDyn *object = rec->object;
  scr_dyn_retain(object);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) {
      ScrDyn *result = bcs_apply(cbs[i], object, &arg, 1, "callback");
      if (result) scr_dyn_release(result);
    }
    scr_dyn_release(cbs[i]);
  }
  free(cbs);
  scr_dyn_release(object);
  scr_dyn_release(arg);
}

static ScrDyn *bcs_done_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_box_get_ref(closure->caps[0]);
  int which = (int)scr_box_get_f64(closure->caps[1]);
  ScrError *err = bcs_error_of(bcs_arg(args, argc, 0));
  switch (which) {
  case BCS_DONE_WRITE:
    scr_stream_write_done(s, err);
    break;
  case BCS_DONE_FINAL:
    scr_stream_final_done(s, err);
    break;
  case BCS_DONE_CONSTRUCT:
    scr_stream_construct_done(s, err);
    break;
  case BCS_DONE_DESTROY: {
    ScrError *kept = err ? scr_error_retain(err) : NULL;
    scr_stream_destroy_done(s, err);
    if (!scr_exc_pending()) bcs_run_destroy_cbs(s, kept);
    if (kept) scr_error_release(kept);
    break;
  }
  default: {
    /* the data is pushed as push(data) pushes it */
    ScrDyn *data = bcs_arg(args, argc, 1);
    if (which == BCS_DONE_TRANSFORM) scr_stream_transform_done_value(s, err, data);
    else scr_stream_flush_done_value(s, err, data);
    break;
  }
  }
  scr_stream_release(s);
  if (scr_exc_pending()) return NULL;
  return bcs_undefined();
}

static ScrDyn *bcs_done(ScrStream *s, int which) {
  ScrClosure *closure = scr_closure_new((void *)bcs_done_call, 2);
  closure->caps[0] = scr_box_new_obj(scr_stream_retain_v, scr_stream_release_v, scr_stream_trace);
  scr_box_set_ref(closure->caps[0], scr_stream_retain(s));
  closure->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[1], which);
  uint32_t arity = which == BCS_DONE_TRANSFORM || which == BCS_DONE_FLUSH ? 2 : 1;
  return scr_dyn_new_func(closure, bcs_done_call, arity, "native:stream", "");
}

/* ── the hooks: the runtime calls the receiver's underscore methods ─── */

static ScrBox *bcs_box(ScrDyn *value /* moves in */) {
  ScrBox *box = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(box, value);
  return box;
}

static ScrClosure *bcs_hook(ScrDyn *object, void *inv) {
  ScrClosure *closure = scr_closure_new(inv, 1);
  closure->caps[0] = bcs_box(scr_dyn_retain(object));
  return closure;
}

/* receiver[method](...args) with the receiver as `this`: +1 or NULL. */
static ScrDyn *bcs_invoke(ScrDyn *object, const char *method, ScrDyn *const *args, size_t argc) {
  ScrDyn *fn = bcs_get(object, method);
  if (!fn) return NULL;
  ScrDyn *result = NULL;
  if (scr_dyn_is_callable(fn)) {
    result = bcs_apply(fn, object, args, argc, method);
  } else {
    char message[96];
    snprintf(message, sizeof message, "this.%s is not a function", method);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  }
  scr_dyn_release(fn);
  return result;
}

/* The thrown value of a hook Node calls inside try/catch, as the runtime
 * error its catch hands on (+1); clears the exception. */
static ScrError *bcs_take_error(void) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *value = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  ScrError *err = NULL;
  if (value) {
    err = scr_dyn_truthy(value) ? bcs_error_of(value) : NULL;
    scr_dyn_release(value);
  }
  if (!err) {
    ScrStr *empty = scr_str_new("", 0);
    err = scr_error_new(SCR_ERR_ERROR, empty);
    scr_str_release(empty);
  }
  return err;
}

/* Readable.read: `try { this._read(hwm) } catch (err) { errorOrDestroy }` */
static void bcs_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  ScrDyn *object = scr_box_get_ref(cb->caps[0]);
  ScrDyn *n = scr_dyn_new_num(size);
  ScrDyn *result = bcs_invoke(object, "_read", &n, 1);
  scr_dyn_release(n);
  if (result) scr_dyn_release(result);
  else if (scr_exc_pending()) {
    ScrError *err = bcs_take_error();
    scr_stream_fail(s, err);
    scr_error_release(err);
  }
  scr_dyn_release(object);
}

/* _write(chunk, 'buffer', cb) and _transform(chunk, 'buffer', cb), or the
 * value and the write's encoding argument on an object-mode writable
 * side: a throw propagates to the write() caller, as in Node. */
static void bcs_chunk_call(ScrClosure *cb, ScrStream *s, ScrBytes *chunk, const char *method, int done) {
  ScrDyn *object = scr_box_get_ref(cb->caps[0]);
  ScrDyn *args[3];
  args[0] = scr_stream_chunk_value(s, chunk);
  args[1] = scr_stream_chunk_encoding_value(s);
  args[2] = bcs_done(s, done);
  ScrDyn *result = bcs_invoke(object, method, args, 3);
  for (int i = 0; i < 3; i++) scr_dyn_release(args[i]);
  if (result) scr_dyn_release(result);
  scr_dyn_release(object);
}

static void bcs_write_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  bcs_chunk_call(cb, s, chunk, "_write", BCS_DONE_WRITE);
}

static void bcs_transform_inv(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  bcs_chunk_call(cb, s, chunk, "_transform", BCS_DONE_TRANSFORM);
}

/* callFinal: `try { stream._final(onFinish) } catch (err) { onFinish(err) }`;
 * a Transform's _flush runs inside the same try. */
static void bcs_plain_call(ScrClosure *cb, ScrStream *s, const char *method, int done) {
  ScrDyn *object = scr_box_get_ref(cb->caps[0]);
  ScrDyn *callback = bcs_done(s, done);
  ScrDyn *result = bcs_invoke(object, method, &callback, 1);
  scr_dyn_release(callback);
  if (result) scr_dyn_release(result);
  else if (scr_exc_pending()) {
    ScrError *err = bcs_take_error();
    if (done == BCS_DONE_FINAL) scr_stream_final_done(s, err);
    else scr_stream_flush_done(s, err, NULL, NULL);
  }
  scr_dyn_release(object);
}

static bool bcs_is_function(ScrDyn *object, const char *name, bool *failed);

/* constructNT: `try { stream._construct(cb) } catch (err) { onConstruct(err) }`. */
static void bcs_construct_inv(ScrClosure *cb, ScrStream *s) {
  ScrDyn *object = scr_box_get_ref(cb->caps[0]);
  ScrDyn *callback = bcs_done(s, BCS_DONE_CONSTRUCT);
  ScrDyn *result = bcs_invoke(object, "_construct", &callback, 1);
  scr_dyn_release(callback);
  if (result) scr_dyn_release(result);
  else if (scr_exc_pending()) scr_stream_construct_done(s, bcs_take_error());
  scr_dyn_release(object);
}

/* clearBuffer's batch: this._writev(chunks, cb); a throw reaches the
 * write() caller, as in Node. */
static void bcs_writev_inv(ScrClosure *cb, ScrStream *s, ScrDyn *chunks) {
  ScrDyn *object = scr_box_get_ref(cb->caps[0]);
  ScrDyn *args[2];
  args[0] = scr_dyn_retain(chunks);
  args[1] = bcs_done(s, BCS_DONE_WRITE);
  ScrDyn *result = bcs_invoke(object, "_writev", args, 2);
  for (int i = 0; i < 2; i++) scr_dyn_release(args[i]);
  if (result) scr_dyn_release(result);
  scr_dyn_release(object);
}

/* prefinish reads `stream._final` when the writable side finishes, so a
 * method assigned after the constructor runs; without one the finish goes
 * on as Node's does when `typeof stream._final !== 'function'`. */
static void bcs_final_inv(ScrClosure *cb, ScrStream *s) {
  ScrDyn *object = scr_box_get_ref(cb->caps[0]);
  bool failed = false;
  bool present = bcs_is_function(object, "_final", &failed);
  scr_dyn_release(object);
  if (failed) return;
  if (present) bcs_plain_call(cb, s, "_final", BCS_DONE_FINAL);
  else scr_stream_final_done(s, NULL);
}

/* Transform's final reads `this._flush` the same way: without one it ends
 * the readable side. */
static void bcs_flush_inv(ScrClosure *cb, ScrStream *s) {
  ScrDyn *object = scr_box_get_ref(cb->caps[0]);
  bool failed = false;
  bool present = bcs_is_function(object, "_flush", &failed);
  if (!failed && bcs_is_function(object, "_final", &failed)) {
    bcs_unsupported("_final on a constructor-function Transform is not supported yet");
    failed = true;
  }
  scr_dyn_release(object);
  if (failed) return;
  if (present) bcs_plain_call(cb, s, "_flush", BCS_DONE_FLUSH);
  else scr_stream_flush_done(s, NULL, NULL, NULL);
}

static ScrDyn *bcs_default_method(int kind, const char *name);

/* _destroy(err || null, onDestroy) inside try/catch. The prototype's
 * default (cb(err)) completes without a call. */
static void bcs_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  ScrDyn *object = scr_box_get_ref(cb->caps[0]);
  ScrDyn *fn = bcs_get(object, "_destroy");
  ScrDyn *fallback = bcs_default_method(BCS_READABLE, "_destroy");
  if (fn && fallback && scr_dyn_strict_eq(fn, fallback)) {
    ScrError *kept = err ? scr_error_retain(err) : NULL;
    scr_stream_destroy_done(s, err ? scr_error_retain(err) : NULL);
    if (!scr_exc_pending()) bcs_run_destroy_cbs(s, kept);
    if (kept) scr_error_release(kept);
  } else if (fn) {
    ScrDyn *args[2];
    args[0] = err ? scr_dyn_from_error(err) : scr_dyn_new_null();
    args[1] = bcs_done(s, BCS_DONE_DESTROY);
    ScrDyn *result = NULL;
    if (scr_dyn_is_callable(fn)) {
      result = bcs_apply(fn, object, args, 2, "_destroy");
    } else {
      static const char message[] = "this._destroy is not a function";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    }
    scr_dyn_release(args[0]);
    scr_dyn_release(args[1]);
    if (result) scr_dyn_release(result);
    else if (scr_exc_pending()) {
      ScrError *thrown = bcs_take_error();
      ScrError *kept = scr_error_retain(thrown);
      scr_stream_destroy_done(s, thrown);
      if (!scr_exc_pending()) bcs_run_destroy_cbs(s, kept);
      scr_error_release(kept);
    }
  }
  if (fallback) scr_dyn_release(fallback);
  if (fn) scr_dyn_release(fn);
  scr_dyn_release(object);
}

/* ── listeners: the runtime emitter, the receiver as `this` ─────────── */

enum { BCS_L_FN, BCS_L_SELF, BCS_L_CAPS };

static void bcs_listener_call(ScrClosure *adapter, ScrDyn *const *args, size_t argc) {
  ScrDyn *fn = scr_box_get_ref(adapter->caps[BCS_L_FN]);
  ScrDyn *self = scr_box_get_ref(adapter->caps[BCS_L_SELF]);
  ScrDyn *result = bcs_apply(fn, self, args, argc, "listener");
  if (result) scr_dyn_release(result);
  scr_dyn_release(self);
  scr_dyn_release(fn);
}

static void bcs_listener0(ScrClosure *adapter) {
  bcs_listener_call(adapter, NULL, 0);
}

static void bcs_listener_data(ScrClosure *adapter, ScrBytes *bytes, ScrStr *text, ScrDyn *value) {
  ScrDyn *arg = value ? scr_dyn_retain(value) : text ? scr_dyn_new_str(text) : scr_dyn_new_buffer(bytes);
  bcs_listener_call(adapter, &arg, 1);
  scr_dyn_release(arg);
}

static void bcs_listener_error(ScrClosure *adapter, ScrError *error) {
  ScrDyn *arg = scr_dyn_from_error(error);
  bcs_listener_call(adapter, &arg, 1);
  scr_dyn_release(arg);
}

static void bcs_listener_stream(ScrClosure *adapter, ScrStream *stream) {
  ScrDyn *arg = bcs_stream_value(stream);
  bcs_listener_call(adapter, &arg, 1);
  scr_dyn_release(arg);
}

static void bcs_listener_name(ScrClosure *adapter, ScrStr *name) {
  ScrDyn *arg = scr_dyn_new_str(name);
  bcs_listener_call(adapter, &arg, 1);
  scr_dyn_release(arg);
}

/* Computed events: the listener's checked-dynamic call, with every
 * argument emit passed. */
static ScrDyn *bcs_listener_flex(ScrClosure *adapter, ScrDyn *const *args, size_t argc) {
  bcs_listener_call(adapter, args, argc);
  if (scr_exc_pending()) return NULL;
  return bcs_undefined();
}

static ScrClosure *bcs_adapter(ScrDyn *fn, ScrDyn *self, void *call) {
  ScrClosure *adapter = scr_closure_new(call, BCS_L_CAPS);
  adapter->caps[BCS_L_FN] = bcs_box(scr_dyn_retain(fn));
  adapter->caps[BCS_L_SELF] = bcs_box(scr_dyn_retain(self));
  scr_dyn_adopt_identity(adapter, fn);
  return adapter;
}

static bool bcs_is(const ScrStr *name, const char *text) {
  size_t length = strlen(text);
  return name->len == length && memcmp(name->data, text, length) == 0;
}

/* The runtime's fixed event tuples: 0 none, 1 data, 2 error, 3 a stream
 * (pipe/unpipe), 4 an event name (the meta events); -1 computed. */
static int bcs_event_shape(const ScrStr *name) {
  if (bcs_is(name, "data")) return 1;
  if (bcs_is(name, "error")) return 2;
  if (bcs_is(name, "pipe") || bcs_is(name, "unpipe")) return 3;
  if (bcs_is(name, "newListener") || bcs_is(name, "removeListener")) return 4;
  static const char *const empty[] = {
    "end", "close", "finish", "drain", "readable", "resume", "pause", "prefinish",
  };
  for (size_t i = 0; i < sizeof empty / sizeof *empty; i++)
    if (bcs_is(name, empty[i])) return 0;
  return -1;
}

/* The event name argument as a string, or NULL with an exception
 * pending. */
static ScrStr *bcs_event_name(const ScrDyn *type) {
  if (type->kind == SCR_DYN_STR) return scr_str_retain(type->v.str);
  if (type->kind == SCR_DYN_SYMBOL) {
    bcs_unsupported("symbol event names on a constructor-function stream are not supported yet");
    return NULL;
  }
  return scr_dyn_string_coerce_js(type);
}

static bool bcs_check_listener(const ScrDyn *listener) {
  if (listener->kind == SCR_DYN_FUNC) return true;
  if (scr_dyn_is_callable(listener)) {
    bcs_unsupported("listeners other than functions on a constructor-function stream are not supported yet");
    return false;
  }
  scr_dyn_arg_type_fail("listener", "of type function", listener);
  return false;
}

static bool bcs_add_listener(ScrStream *s, ScrDyn *self, ScrDyn *type, ScrDyn *listener, bool once,
                             bool prepend) {
  if (!bcs_check_listener(listener)) return false;
  ScrStr *name = bcs_event_name(type);
  if (!name) return false;
  ScrEmitter *em = (ScrEmitter *)s;
  ScrEmitter *chained = NULL;
  switch (bcs_event_shape(name)) {
  case 0:
    chained = scr_emitter_on_dyn(em, name, listener, bcs_adapter(listener, self, (void *)bcs_listener0),
                                 scr_ee_inv_fixed0, once, prepend);
    break;
  case 1:
    chained = scr_emitter_on_dyn(em, name, listener, bcs_adapter(listener, self, (void *)bcs_listener_data),
                                 scr_ee_inv_fixed3, once, prepend);
    break;
  case 2:
    chained = scr_emitter_on_dyn(em, name, listener, bcs_adapter(listener, self, (void *)bcs_listener_error),
                                 scr_ee_inv_fixed1, once, prepend);
    break;
  case 3:
    chained = scr_emitter_on_dyn(em, name, listener, bcs_adapter(listener, self, (void *)bcs_listener_stream),
                                 scr_ee_inv_fixed1, once, prepend);
    break;
  case 4:
    chained = scr_emitter_on_dyn(em, name, listener, bcs_adapter(listener, self, (void *)bcs_listener_name),
                                 scr_ee_inv_fixed1, once, prepend);
    break;
  default: {
    ScrClosure *adapter = bcs_adapter(listener, self, (void *)bcs_listener_flex);
    ScrDyn *wrapper = scr_dyn_new_func(adapter, bcs_listener_flex, 0, "native:events", "listener");
    chained = scr_emitter_on_flex(em, name, wrapper, once, prepend);
    scr_dyn_release(wrapper);
    break;
  }
  }
  if (chained) scr_emitter_release(chained);
  scr_str_release(name);
  return !scr_exc_pending();
}

/* this.emit(type, ...args) on the runtime emitter: the fixed tuples the
 * runtime's own listeners read, computed events with every argument. */
static ScrDyn *bcs_emit(ScrStream *s, ScrDyn *const *args, size_t argc) {
  ScrStr *name = bcs_event_name(bcs_arg(args, argc, 0));
  if (!name) return NULL;
  ScrEmitter *em = (ScrEmitter *)s;
  ScrDyn *const *rest = argc > 1 ? args + 1 : NULL;
  size_t restc = argc > 1 ? argc - 1 : 0;
  ScrDyn *first = restc ? rest[0] : scr_dyn_undefined();
  bool had = false;
  switch (bcs_event_shape(name)) {
  case 0:
    had = scr_emitter_emit(em, name);
    break;
  case 1:
    /* 'data' carries the bytes, string and value slots (scr_stream_emit_data) */
    if (first->kind == SCR_DYN_BYTES) {
      ScrBytes *bytes = scr_bytes_raw_view(first->v.bytes);
      had = scr_emitter_emit(em, name, bytes, (ScrStr *)NULL, first);
      scr_bytes_release(bytes);
    } else if (first->kind == SCR_DYN_STR) {
      had = scr_emitter_emit(em, name, (ScrBytes *)NULL, first->v.str, first);
    } else {
      had = scr_emitter_emit(em, name, (ScrBytes *)NULL, (ScrStr *)NULL, first);
    }
    break;
  case 2:
    if (!scr_emitter_has(em, "error")) {
      /* Node's unhandled 'error': an Error throws itself, anything else
       * ERR_UNHANDLED_ERROR. */
      if (scr_dyn_err_instanceof(first, SCR_ERR_ERROR)) {
        scr_dyn_throw(scr_dyn_retain(first));
      } else {
        ScrStr *shown = scr_insp_dyn(first, 0, 2);
        ScrJsonBuf text;
        scr_jb_init(&text);
        scr_jb_puts(&text, "Unhandled error. (");
        scr_jb_put_str(&text, shown);
        scr_jb_putc(&text, ')');
        scr_str_release(shown);
        ScrStr *message = scr_jb_finish(&text);
        scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "ERR_UNHANDLED_ERROR");
        scr_str_release(message);
      }
    } else {
      ScrError *err = bcs_error_of(first);
      if (!err) {
        ScrStr *empty = scr_str_new("", 0);
        err = scr_error_new(SCR_ERR_ERROR, empty);
        scr_str_release(empty);
      }
      had = scr_emitter_emit_error(em, name, err);
      scr_error_release(err);
    }
    break;
  case 3: {
    ScrStream *stream = scr_dyn_builtin_stream_of(first);
    if (stream) {
      had = scr_emitter_emit(em, name, stream);
      scr_stream_release(stream);
    } else {
      bcs_unsupported("emit('pipe') or emit('unpipe') with a value other than a stream on a constructor-function stream is not supported yet");
    }
    break;
  }
  case 4:
    if (first->kind == SCR_DYN_STR) had = scr_emitter_emit(em, name, first->v.str);
    else bcs_unsupported("emit('newListener') or emit('removeListener') with a name other than a string on a constructor-function stream is not supported yet");
    break;
  default:
    had = scr_emitter_emit_flex(em, name, rest, restc);
    break;
  }
  scr_str_release(name);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_new_bool(had);
}

static ScrDyn *bcs_event_names(ScrStream *s) {
  ScrArr *names = scr_emitter_event_names((ScrEmitter *)s);
  ScrDyn *result = scr_dyn_new_arr();
  double length = scr_arr_len(names);
  for (double i = 0; i < length; i++) {
    ScrStr *name = scr_arr_get_ref(names, i);
    scr_dyn_arr_push(result, scr_dyn_new_str(name));
    scr_str_release(name);
  }
  scr_arr_release(names);
  return result;
}

/* EventEmitter.prototype's methods on a constructor-function stream
 * (called by scr_dyn_builtin_class.c): true when self has a stream. */
static bool bcs_event(int method, ScrDyn *self, ScrDyn *const *args, size_t argc, ScrDyn **result) {
  ScrStream *s = bcs_of(self);
  if (!s) return false;
  ScrDyn *type = bcs_arg(args, argc, 0);
  ScrEmitter *em = (ScrEmitter *)s;
  ScrDyn *out = NULL;
  switch (method) {
  case SCR_EE_M_ON:
  case SCR_EE_M_PREPEND:
  case SCR_EE_M_ONCE:
  case SCR_EE_M_PREPEND_ONCE:
    if (bcs_add_listener(s, self, type, bcs_arg(args, argc, 1),
                         method == SCR_EE_M_ONCE || method == SCR_EE_M_PREPEND_ONCE,
                         method == SCR_EE_M_PREPEND || method == SCR_EE_M_PREPEND_ONCE))
      out = scr_dyn_retain(self);
    break;
  case SCR_EE_M_OFF: {
    ScrDyn *listener = bcs_arg(args, argc, 1);
    if (!bcs_check_listener(listener)) break;
    ScrStr *name = bcs_event_name(type);
    if (!name) break;
    scr_emitter_release(scr_emitter_off_dyn(em, name, listener));
    scr_str_release(name);
    if (!scr_exc_pending()) out = scr_dyn_retain(self);
    break;
  }
  case SCR_EE_M_REMOVE_ALL: {
    ScrStr *name = argc == 0 || type->kind == SCR_DYN_UNDEF ? NULL : bcs_event_name(type);
    if (argc > 0 && type->kind != SCR_DYN_UNDEF && !name) break;
    if (!name) name = scr_str_new("", 0);
    scr_emitter_release(scr_emitter_remove_all(em, name, argc == 0 || type->kind == SCR_DYN_UNDEF));
    scr_str_release(name);
    if (!scr_exc_pending()) out = scr_dyn_retain(self);
    break;
  }
  case SCR_EE_M_EMIT:
    out = bcs_emit(s, args, argc);
    break;
  case SCR_EE_M_LISTENER_COUNT: {
    ScrStr *name = bcs_event_name(type);
    if (!name) break;
    ScrDyn *only = bcs_arg(args, argc, 1);
    double count = bcs_nullish(only) ? scr_emitter_listener_count(em, name)
                                     : only->kind == SCR_DYN_FUNC ? scr_emitter_listener_count_dyn(em, name, only) : 0;
    scr_str_release(name);
    if (!scr_exc_pending()) out = scr_dyn_new_num(count);
    break;
  }
  case SCR_EE_M_EVENT_NAMES:
    out = bcs_event_names(s);
    break;
  case SCR_EE_M_SET_MAX:
    scr_emitter_release(scr_emitter_set_max(em, bcs_arg(args, argc, 0)->v.num));
    out = scr_dyn_retain(self);
    break;
  case SCR_EE_M_GET_MAX:
    out = scr_dyn_new_num(scr_emitter_get_max(em));
    break;
  default:
    bcs_unsupported("listeners() and rawListeners() on a constructor-function stream are not supported yet");
    break;
  }
  *result = scr_exc_pending() ? (out ? (scr_dyn_release(out), NULL) : NULL) : out;
  return true;
}

/* ── construction ───────────────────────────────────────────────────── */

static bool bcs_is_function(ScrDyn *object, const char *name, bool *failed) {
  ScrDyn *value = bcs_get(object, name);
  if (!value) {
    *failed = true;
    return false;
  }
  bool callable = scr_dyn_is_callable(value);
  scr_dyn_release(value);
  return callable;
}

/* Node's constructors copy these options onto the instance. */
static bool bcs_copy_option(ScrDyn *self, ScrDyn *opts, const char *option, const char *property) {
  ScrDyn *value = bcs_get(opts, option);
  if (!value) return false;
  if (scr_dyn_is_callable(value)) return bcs_set(self, property, value);
  scr_dyn_release(value);
  return true;
}

static void bcs_class_name(ScrDyn *self, char *out, size_t size) {
  snprintf(out, size, "%s", "Object");
  ScrDyn *ctor = bcs_get(self, "constructor");
  if (!ctor) {
    scr_exc_clear();
    return;
  }
  if (scr_dyn_is_callable(ctor)) {
    ScrDyn *name = bcs_get(ctor, "name");
    if (name && name->kind == SCR_DYN_STR && name->v.str->len > 0)
      snprintf(out, size, "%.*s", (int)name->v.str->len, name->v.str->data);
    if (name) scr_dyn_release(name);
    else scr_exc_clear();
  }
  scr_dyn_release(ctor);
}

static ScrDyn *bcs_state_proto(bool readable);

/* Listeners added before the constructor ran (bl registers its 'pipe'
 * listener first) sit in the instance's own _events, where Node's
 * constructor keeps them: they move to the runtime emitter, in order. */
static bool bcs_adopt_listeners(ScrStream *s, ScrDyn *self) {
  ScrDyn *events = bcs_get(self, "_events");
  if (!events) return false;
  if (events->kind != SCR_DYN_OBJ) {
    scr_dyn_release(events);
    return true;
  }
  ScrDyn *keys = scr_dyn_own_keys(events);
  bool ok = keys != NULL;
  size_t count = ok ? (size_t)scr_dyn_arr_len(keys) : 0;
  for (size_t i = 0; ok && i < count; i++) {
    ScrDyn *key = scr_dyn_index_get(keys, (double)i);
    ScrDyn *list = key ? scr_dyn_reflect_get(events, key, events) : NULL;
    if (!list) {
      if (key) scr_dyn_release(key);
      ok = false;
      break;
    }
    if (list->kind == SCR_DYN_ARR) {
      size_t length = (size_t)scr_dyn_arr_len(list);
      for (size_t j = 0; ok && j < length; j++) {
        ScrDyn *listener = scr_dyn_index_get(list, (double)j);
        ok = listener && bcs_add_listener(s, self, key, listener, false, false);
        if (listener) scr_dyn_release(listener);
      }
    } else if (scr_dyn_is_callable(list)) {
      ok = bcs_add_listener(s, self, key, list, false, false);
    }
    scr_dyn_release(list);
    scr_dyn_release(key);
  }
  if (keys) scr_dyn_release(keys);
  scr_dyn_release(events);
  if (ok && count > 0)
    ok = bcs_set(self, "_events", scr_dyn_new_obj_null_proto()) && bcs_set(self, "_eventsCount", scr_dyn_new_num(0));
  return ok;
}

static bool bcs_state_view(ScrDyn *self, ScrStream *s, bool readable) {
  ScrDyn *view = scr_dyn_obj_create(bcs_state_proto(readable));
  bcs_hide(view, s);
  return bcs_set(self, readable ? "_readableState" : "_writableState", view);
}

static ScrDyn *bcs_construct(int kind, ScrDyn *self, ScrDyn *const *args, size_t argc) {
  static const char *const names[] = { "", "", "Readable", "Writable", "Duplex", "Transform", "PassThrough" };
  char message[192];
  if (self->kind != SCR_DYN_OBJ || !scr_dyn_builtin_instanceof(self, kind)) {
    if (scr_exc_pending()) return NULL;
    snprintf(message, sizeof message,
             "%s.call() on a receiver that does not inherit %s.prototype is not supported yet",
             names[kind], names[kind]);
    bcs_unsupported(message);
    return NULL;
  }
  if (bcs_of(self)) {
    snprintf(message, sizeof message,
             "%s.call() on a receiver that already has stream state is not supported yet", names[kind]);
    bcs_unsupported(message);
    return NULL;
  }
  bool failed = false;
  bool writes = kind != BCS_READABLE;
  ScrDyn *opts = bcs_arg(args, argc, 0);
  /* Node's constructors assign options.writev and options.construct to
   * the instance (this._writev = options.writev), then read _writev and
   * _construct, so an option shadows the prototype's method. */
  if (opts->kind == SCR_DYN_OBJ) {
    if (writes && !bcs_copy_option(self, opts, "writev", "_writev")) return NULL;
    if (!bcs_copy_option(self, opts, "construct", "_construct")) return NULL;
  }
  bool has_writev = writes && bcs_is_function(self, "_writev", &failed);
  bool has_construct = !failed && bcs_is_function(self, "_construct", &failed);
  if (failed) return NULL;
  ScrStream *s = kind == BCS_READABLE   ? scr_stream_new_readable_dyn(opts)
               : kind == BCS_WRITABLE   ? scr_stream_new_writable_dyn(opts)
               : kind == BCS_DUPLEX     ? scr_stream_new_duplex_dyn(opts)
               : kind == BCS_TRANSFORM  ? scr_stream_new_transform_dyn(opts)
                                        : scr_stream_new_passthrough_dyn(opts);
  if (!s) return NULL;
  bool ok = true;
  if (opts->kind == SCR_DYN_OBJ) {
    bool transformish = kind == BCS_TRANSFORM || kind == BCS_PASSTHROUGH;
    if (!transformish && kind != BCS_WRITABLE) ok = ok && bcs_copy_option(self, opts, "read", "_read");
    if (!transformish && kind != BCS_READABLE) {
      ok = ok && bcs_copy_option(self, opts, "write", "_write");
      ok = ok && bcs_copy_option(self, opts, "final", "_final");
    }
    ok = ok && bcs_copy_option(self, opts, "destroy", "_destroy");
    if (transformish) {
      ok = ok && bcs_copy_option(self, opts, "transform", "_transform");
      ok = ok && bcs_copy_option(self, opts, "flush", "_flush");
    }
  }
  if (ok && kind >= BCS_DUPLEX)
    ok = bcs_set(self, "allowHalfOpen", scr_dyn_new_bool(scr_stream_prop(s, "allowHalfOpen") != 0));
  if (!ok) {
    scr_stream_release(s);
    return NULL;
  }
  BcsRec *rec = calloc(1, sizeof *rec);
  if (!rec) scr_trap("out of memory");
  rec->object = self;
  bcs_class_name(self, rec->cls, sizeof rec->cls);
  scr_stream_set_native(s, rec, bcs_rec_release);
  s->cls = rec->cls;
  /* The runtime calls the instance's underscore methods. */
  if (kind == BCS_READABLE || kind == BCS_DUPLEX)
    scr_stream_set_read(s, bcs_hook(self, (void *)bcs_read_inv), bcs_read_inv);
  if (kind == BCS_WRITABLE || kind == BCS_DUPLEX) {
    scr_stream_set_write(s, bcs_hook(self, (void *)bcs_write_inv), bcs_write_inv);
    /* _final is read when the writable side finishes (bcs_final_inv). */
    scr_stream_set_final(s, bcs_hook(self, (void *)bcs_final_inv), bcs_final_inv);
  }
  if (kind == BCS_TRANSFORM || kind == BCS_PASSTHROUGH) {
    /* _transform is read per chunk (a PassThrough's default passes the
     * chunk on) and _flush when the writable side finishes. */
    scr_stream_set_transform(s, bcs_hook(self, (void *)bcs_transform_inv), bcs_transform_inv);
    scr_stream_set_flush(s, bcs_hook(self, (void *)bcs_flush_inv), bcs_flush_inv);
    if (!failed && bcs_is_function(self, "_final", &failed)) {
      bcs_unsupported("_final on a constructor-function Transform is not supported yet");
      failed = true;
    }
  }
  scr_stream_set_destroy(s, bcs_hook(self, (void *)bcs_destroy_inv), bcs_destroy_inv);
  if (has_writev) scr_stream_set_writev(s, bcs_hook(self, (void *)bcs_writev_inv), bcs_writev_inv);
  if (has_construct)
    scr_stream_set_construct(s, bcs_hook(self, (void *)bcs_construct_inv), bcs_construct_inv);
  bcs_hide(self, s);
  if (!failed) failed = !bcs_adopt_listeners(s, self);
  if (!failed && kind != BCS_WRITABLE) failed = !bcs_state_view(self, s, true);
  if (!failed && kind != BCS_READABLE) failed = !bcs_state_view(self, s, false);
  scr_stream_release(s); /* the capsule holds it */
  if (failed || scr_exc_pending()) return NULL;
  return bcs_undefined();
}

/* ── prototype methods ──────────────────────────────────────────────── */

/* Node's encoding names, canonical; NULL with ERR_UNKNOWN_ENCODING. */
static ScrStr *bcs_encoding(const ScrDyn *value) {
  static const struct { const char *from, *to; } map[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"}, {"base64", "base64"},
    {"base64url", "base64url"}, {"latin1", "latin1"}, {"binary", "latin1"},
    {"ascii", "ascii"}, {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"},
  };
  ScrStr *raw = value->kind == SCR_DYN_STR ? scr_str_retain(value->v.str) : scr_dyn_string_coerce_js(value);
  if (!raw) return NULL;
  for (size_t i = 0; i < sizeof map / sizeof *map; i++) {
    if (bcs_is(raw, map[i].from)) {
      scr_str_release(raw);
      return scr_str_new(map[i].to, strlen(map[i].to));
    }
  }
  char message[128];
  snprintf(message, sizeof message, "Unknown encoding: %.*s", (int)(raw->len < 64 ? raw->len : 64), raw->data);
  scr_str_release(raw);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), "ERR_UNKNOWN_ENCODING");
  return NULL;
}

enum {
  BCS_M_PUSH, BCS_M_UNSHIFT, BCS_M_READ, BCS_M_SET_ENCODING, BCS_M_PAUSE, BCS_M_RESUME,
  BCS_M_IS_PAUSED, BCS_M_PIPE, BCS_M_UNPIPE, BCS_M_DESTROY, BCS_M_WRITE, BCS_M_END,
  BCS_M_CORK, BCS_M_UNCORK, BCS_M_SET_DEFAULT_ENCODING, BCS_M_WRITABLE_PIPE, BCS_M_WRAP,
  BCS_M_READ_DEFAULT, BCS_M_WRITE_DEFAULT, BCS_M_TRANSFORM_DEFAULT, BCS_M_DESTROY_DEFAULT,
  BCS_M_PASSTHROUGH_TRANSFORM, BCS_M_ON, BCS_M_OFF, BCS_M_REMOVE_ALL,
};

enum { BCS_CB_STREAM = BCS_L_CAPS, BCS_CB_CAPS };

/* A write or end callback: null after a successful write and at 'finish';
 * once the stream failed, its error, or Node's ERR_STREAM_DESTROYED for a
 * write a destroy cut off. */
static void bcs_callback_fire(ScrClosure *closure) {
  ScrDyn *fn = scr_box_get_ref(closure->caps[BCS_L_FN]);
  ScrDyn *self = scr_box_get_ref(closure->caps[BCS_L_SELF]);
  ScrStream *s = scr_box_get_ref(closure->caps[BCS_CB_STREAM]);
  ScrError *err = scr_stream_errored(s);
  ScrDyn *arg;
  if (err) {
    arg = scr_dyn_from_error(err);
    scr_error_release(err);
  } else if (scr_stream_prop(s, "destroyed") != 0) {
    ScrStr *message = scr_str_new("Cannot call write after a stream was destroyed", 46);
    ScrError *destroyed = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    scr_error_set_code(destroyed, "ERR_STREAM_DESTROYED");
    arg = scr_dyn_from_error(destroyed);
    scr_error_release(destroyed);
  } else {
    arg = scr_dyn_new_null();
  }
  scr_stream_release(s);
  ScrDyn *result = bcs_apply(fn, self, &arg, 1, "callback");
  if (result) scr_dyn_release(result);
  scr_dyn_release(arg);
  scr_dyn_release(self);
  scr_dyn_release(fn);
}

static ScrClosure *bcs_callback(ScrDyn *fn, ScrDyn *self, ScrStream *s) {
  if (!scr_dyn_is_callable(fn)) return NULL;
  ScrClosure *closure = scr_closure_new((void *)bcs_callback_fire, BCS_CB_CAPS);
  closure->caps[BCS_L_FN] = bcs_box(scr_dyn_retain(fn));
  closure->caps[BCS_L_SELF] = bcs_box(scr_dyn_retain(self));
  closure->caps[BCS_CB_STREAM] = scr_box_new_obj(scr_stream_retain_v, scr_stream_release_v, scr_stream_trace);
  scr_box_set_ref(closure->caps[BCS_CB_STREAM], scr_stream_retain(s));
  return closure;
}

static ScrDyn *bcs_write(ScrStream *s, ScrDyn *self, ScrDyn *const *args, size_t argc) {
  ScrDyn *chunk = bcs_arg(args, argc, 0);
  ScrDyn *encoding = bcs_arg(args, argc, 1);
  ScrDyn *cb = bcs_arg(args, argc, 2);
  if (scr_dyn_is_callable(encoding)) {
    cb = encoding;
    encoding = scr_stream_writes_values(s) ? scr_dyn_new_null() : scr_dyn_undefined();
  }
  /* an object-mode side hands the encoding argument to _write; a byte-mode
   * side encodes a string with it (or the default encoding) */
  bool below = scr_stream_write_enc(s, chunk, encoding, bcs_callback(cb, self, s));
  if (scr_exc_pending()) return NULL;
  return scr_dyn_new_bool(below);
}

static ScrDyn *bcs_end(ScrStream *s, ScrDyn *self, ScrDyn *const *args, size_t argc) {
  ScrDyn *chunk = bcs_arg(args, argc, 0);
  ScrDyn *encoding = bcs_arg(args, argc, 1);
  ScrDyn *cb = bcs_arg(args, argc, 2);
  if (scr_dyn_is_callable(chunk)) {
    cb = chunk;
    chunk = scr_dyn_undefined();
    encoding = scr_dyn_undefined();
  } else if (scr_dyn_is_callable(encoding)) {
    cb = encoding;
    encoding = scr_dyn_new_null();
  }
  ScrStream *chained = NULL;
  if (!bcs_nullish(chunk)) {
    /* end(chunk) writes the chunk with the encoding argument first */
    if (scr_stream_prop(s, "writableObjectMode") == 0 && chunk->kind != SCR_DYN_STR &&
        chunk->kind != SCR_DYN_BYTES) {
      scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", chunk);
      return NULL;
    }
    scr_stream_write_enc(s, chunk, encoding, NULL);
    if (scr_exc_pending()) return NULL;
  }
  chained = scr_stream_end(s, NULL, NULL, bcs_callback(cb, self, s));
  if (chained) scr_stream_release(chained);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(self);
}

static ScrDyn *bcs_destroy(ScrStream *s, ScrDyn *self, ScrDyn *const *args, size_t argc) {
  ScrDyn *errv = bcs_arg(args, argc, 0);
  ScrDyn *cb = bcs_arg(args, argc, 1);
  if (scr_stream_prop(s, "destroyed") != 0) {
    if (scr_dyn_is_callable(cb)) {
      ScrDyn *result = bcs_apply(cb, self, NULL, 0, "callback");
      if (!result) return NULL;
      scr_dyn_release(result);
    }
    return scr_dyn_retain(self);
  }
  if (scr_dyn_is_callable(cb)) {
    BcsRec *rec = bcs_rec(s);
    if (rec->destroy_n == rec->destroy_cap) {
      rec->destroy_cap = rec->destroy_cap ? rec->destroy_cap * 2 : 2;
      rec->destroy_cbs = realloc(rec->destroy_cbs, rec->destroy_cap * sizeof *rec->destroy_cbs);
      if (!rec->destroy_cbs) scr_trap("out of memory");
    }
    rec->destroy_cbs[rec->destroy_n++] = scr_dyn_retain(cb);
  }
  ScrError *err = bcs_error_of(errv);
  ScrStream *chained = scr_stream_destroy(s, err);
  if (err) scr_error_release(err);
  scr_stream_release(chained);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(self);
}

/* pipe(dest, { end }): runtime streams and constructor-function streams
 * pipe through the runtime's pipe. */
static bool bcs_overrides(ScrDyn *dest, const char *name);

static ScrDyn *bcs_pipe(ScrStream *s, ScrDyn *const *args, size_t argc) {
  ScrDyn *dest = bcs_arg(args, argc, 0);
  ScrDyn *options = bcs_arg(args, argc, 1);
  ScrStream *d = scr_dyn_builtin_stream_of(dest);
  if (!d) {
    if (!scr_exc_pending()) bcs_unsupported("pipe destinations other than streams are not supported yet");
    return NULL;
  }
  /* The runtime's pipe writes and ends the destination's stream itself;
   * Node calls the destination's write() and end(). */
  if (bcs_of(dest) && (bcs_overrides(dest, "write") || bcs_overrides(dest, "end"))) {
    scr_stream_release(d);
    if (!scr_exc_pending())
      bcs_unsupported("pipe into a constructor-function stream with its own write() or end() is not supported yet");
    return NULL;
  }
  bool end = true;
  if (options->kind == SCR_DYN_OBJ) {
    ScrDyn *option = bcs_get(options, "end");
    if (!option) {
      scr_stream_release(d);
      return NULL;
    }
    end = !(option->kind == SCR_DYN_BOOL && !option->v.b);
    scr_dyn_release(option);
  }
  ScrStream *chained = scr_stream_pipe(s, d, end);
  if (chained) scr_stream_release(chained);
  scr_stream_release(d);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(dest);
}

static ScrDyn *bcs_not_implemented(const char *method) {
  char message[64];
  snprintf(message, sizeof message, "The %s method is not implemented", method);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "ERR_METHOD_NOT_IMPLEMENTED");
  return NULL;
}

static ScrDyn *bcs_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  int method = (int)scr_box_get_f64(closure->caps[0]);
  switch (method) {
  case BCS_M_READ_DEFAULT:
    return bcs_not_implemented("_read()");
  case BCS_M_WRITE_DEFAULT: {
    /* Writable.prototype._write: this._writev([{ chunk, encoding }], cb) */
    ScrDyn *self = scr_dyn_this_get();
    bool failed = false;
    if (bcs_is_function(self, "_writev", &failed)) {
      ScrDyn *chunks = scr_dyn_new_arr();
      ScrDyn *entry = scr_dyn_new_obj();
      scr_dyn_obj_set(entry, "chunk", 5, scr_dyn_retain(bcs_arg(args, argc, 0)));
      scr_dyn_obj_set(entry, "encoding", 8, scr_dyn_retain(bcs_arg(args, argc, 1)));
      scr_dyn_arr_push(chunks, entry);
      ScrDyn *pass[2] = {chunks, bcs_arg(args, argc, 2)};
      ScrDyn *result = bcs_invoke(self, "_writev", pass, 2);
      scr_dyn_release(chunks);
      scr_dyn_release(self);
      return result;
    }
    scr_dyn_release(self);
    if (failed) return NULL;
    return bcs_not_implemented("_write()");
  }
  case BCS_M_TRANSFORM_DEFAULT:
    return bcs_not_implemented("_transform()");
  case BCS_M_DESTROY_DEFAULT:
  case BCS_M_PASSTHROUGH_TRANSFORM: {
    /* _destroy(err, cb) => cb(err); _transform(chunk, enc, cb) => cb(null, chunk) */
    ScrDyn *cb = bcs_arg(args, argc, method == BCS_M_DESTROY_DEFAULT ? 1 : 2);
    ScrDyn *pass[2];
    size_t passc = 1;
    if (method == BCS_M_DESTROY_DEFAULT) {
      pass[0] = bcs_arg(args, argc, 0);
    } else {
      pass[0] = scr_dyn_new_null();
      pass[1] = bcs_arg(args, argc, 0);
      passc = 2;
    }
    ScrDyn *answer = scr_dyn_call(cb, pass, passc, "callback");
    if (method != BCS_M_DESTROY_DEFAULT) scr_dyn_release(pass[0]);
    return answer;
  }
  default:
    break;
  }
  ScrDyn *self = scr_dyn_this_get();
  static const char *const reading[] = {
    "push", "unshift", "read", "setEncoding", "pause", "resume", "isPaused", "pipe", "unpipe",
    "destroy", "write", "end", "cork", "uncork", "setDefaultEncoding", "pipe", "wrap",
    "", "", "", "", "", "on", "removeListener", "removeAllListeners",
  };
  ScrDyn *result = NULL;
  if (method == BCS_M_WRITABLE_PIPE) {
    ScrStream *s = bcs_need(self, "pipe");
    if (s) {
      ScrStr *message = scr_str_new("Cannot pipe, not readable", 25);
      ScrError *err = scr_error_new(SCR_ERR_ERROR, message);
      scr_str_release(message);
      scr_error_set_code(err, "ERR_STREAM_CANNOT_PIPE");
      scr_stream_fail(s, err);
      scr_error_release(err);
      if (!scr_exc_pending()) result = scr_dyn_retain(bcs_arg(args, argc, 0));
    }
    scr_dyn_release(self);
    return result;
  }
  if (method == BCS_M_ON || method == BCS_M_OFF || method == BCS_M_REMOVE_ALL) {
    int ee = method == BCS_M_ON ? SCR_EE_M_ON : method == BCS_M_OFF ? SCR_EE_M_OFF : SCR_EE_M_REMOVE_ALL;
    if (!bcs_event(ee, self, args, argc, &result)) {
      /* Before the constructor ran (bl adds listeners first), Node's
       * Readable.prototype.on is Stream.prototype.on over _events. */
      ScrDyn *emitter = scr_dyn_builtin_class(0);
      ScrDyn *prototype = bcs_get(emitter, "prototype");
      scr_dyn_release(emitter);
      ScrDyn *fn = prototype ? bcs_get(prototype, reading[method]) : NULL;
      result = fn ? bcs_apply(fn, self, args, argc, reading[method]) : NULL;
      if (fn) scr_dyn_release(fn);
      if (prototype) scr_dyn_release(prototype);
    }
    scr_dyn_release(self);
    return result;
  }
  ScrStream *s = bcs_need(self, reading[method]);
  if (!s) {
    scr_dyn_release(self);
    return NULL;
  }
  ScrDyn *first = bcs_arg(args, argc, 0);
  switch (method) {
  case BCS_M_PUSH:
  case BCS_M_UNSHIFT: {
    ScrDyn *encoding = bcs_arg(args, argc, 1);
    if (method == BCS_M_PUSH && first->kind == SCR_DYN_STR && encoding->kind == SCR_DYN_STR) {
      ScrStr *canonical = bcs_encoding(encoding);
      if (canonical) {
        result = scr_dyn_new_bool(scr_stream_push_str_enc(s, first->v.str, canonical));
        scr_str_release(canonical);
      }
    } else if (method == BCS_M_PUSH) {
      if (first->kind == SCR_DYN_UNDEF) {
        ScrStr *empty = scr_str_new("", 0);
        result = scr_dyn_new_bool(scr_stream_push_str(s, empty));
        scr_str_release(empty);
      } else {
        result = scr_dyn_new_bool(scr_stream_push_dyn(s, first));
      }
    } else if (first->kind == SCR_DYN_STR) {
      scr_stream_unshift_str(s, first->v.str);
      result = bcs_undefined();
    } else if (first->kind == SCR_DYN_BYTES) {
      ScrBytes *bytes = scr_bytes_raw_view(first->v.bytes);
      scr_stream_unshift(s, bytes);
      scr_bytes_release(bytes);
      result = bcs_undefined();
    } else if (first->kind == SCR_DYN_NULL) {
      scr_stream_push_null(s);
      result = bcs_undefined();
    } else {
      scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", first);
    }
    break;
  }
  case BCS_M_READ:
    result = scr_stream_read_dyn(s, first);
    break;
  case BCS_M_SET_ENCODING: {
    ScrStr *canonical = bcs_encoding(first->kind == SCR_DYN_UNDEF ? scr_dyn_undefined() : first);
    if (canonical) {
      scr_stream_release(scr_stream_set_encoding(s, canonical));
      scr_str_release(canonical);
      result = scr_dyn_retain(self);
    }
    break;
  }
  case BCS_M_PAUSE:
    scr_stream_release(scr_stream_pause(s));
    result = scr_dyn_retain(self);
    break;
  case BCS_M_RESUME:
    scr_stream_release(scr_stream_resume(s));
    result = scr_dyn_retain(self);
    break;
  case BCS_M_IS_PAUSED:
    result = scr_dyn_new_bool(scr_stream_is_paused(s));
    break;
  case BCS_M_PIPE:
    result = bcs_pipe(s, args, argc);
    break;
  case BCS_M_UNPIPE: {
    ScrStream *d = first->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_builtin_stream_of(first);
    if (first->kind == SCR_DYN_UNDEF || d) {
      scr_stream_release(scr_stream_unpipe(s, d));
      if (d) scr_stream_release(d);
    }
    if (!scr_exc_pending()) result = scr_dyn_retain(self);
    break;
  }
  case BCS_M_DESTROY:
    result = bcs_destroy(s, self, args, argc);
    break;
  case BCS_M_WRITE:
    result = bcs_write(s, self, args, argc);
    break;
  case BCS_M_END:
    result = bcs_end(s, self, args, argc);
    break;
  case BCS_M_CORK:
    scr_stream_cork(s);
    result = bcs_undefined();
    break;
  case BCS_M_UNCORK:
    scr_stream_uncork(s);
    result = bcs_undefined();
    break;
  case BCS_M_SET_DEFAULT_ENCODING: {
    ScrStream *chained = scr_stream_set_default_encoding(s, first);
    if (chained) scr_stream_release(chained);
    if (!scr_exc_pending()) result = scr_dyn_retain(self);
    break;
  }
  default:
    bcs_unsupported("Readable.prototype.wrap on a constructor-function stream is not supported yet");
    break;
  }
  scr_dyn_release(self);
  if (scr_exc_pending()) {
    if (result) scr_dyn_release(result);
    return NULL;
  }
  return result;
}

static ScrDyn *bcs_function(int method, const char *name, uint32_t arity) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[0], method);
  return scr_dyn_new_func(closure, bcs_method_call, arity, "native:stream", name);
}

static void bcs_method(ScrDyn *prototype, const char *name, int method, uint32_t arity) {
  bcs_set(prototype, name, bcs_function(method, name, arity));
}

/* ── accessors ──────────────────────────────────────────────────────── */

enum {
  BCS_P_READABLE, BCS_P_READABLE_ENDED, BCS_P_READABLE_LENGTH, BCS_P_READABLE_HWM,
  BCS_P_READABLE_OBJECT_MODE, BCS_P_READABLE_FLOWING, BCS_P_WRITABLE, BCS_P_WRITABLE_ENDED,
  BCS_P_WRITABLE_FINISHED, BCS_P_WRITABLE_LENGTH, BCS_P_WRITABLE_HWM, BCS_P_WRITABLE_NEED_DRAIN,
  BCS_P_WRITABLE_CORKED, BCS_P_WRITABLE_OBJECT_MODE, BCS_P_DESTROYED, BCS_P_CLOSED, BCS_P_ERRORED,
  BCS_P_COUNT
};

static const char *const bcs_property_names[BCS_P_COUNT] = {
  "readable", "readableEnded", "readableLength", "readableHighWaterMark", "readableObjectMode",
  "readableFlowing", "writable", "writableEnded", "writableFinished", "writableLength",
  "writableHighWaterMark", "writableNeedDrain", "writableCorked", "writableObjectMode",
  "destroyed", "closed", "errored",
};

static ScrDyn *bcs_flowing(ScrStream *s) {
  double flowing = scr_stream_flowing(s);
  return flowing < 0 ? scr_dyn_new_null() : scr_dyn_new_bool(flowing != 0);
}

static ScrDyn *bcs_errored(ScrStream *s) {
  ScrError *err = scr_stream_errored(s);
  if (!err) return scr_dyn_new_null();
  ScrDyn *value = scr_dyn_from_error(err);
  scr_error_release(err);
  return value;
}

static ScrDyn *bcs_getter_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  int property = (int)scr_box_get_f64(closure->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  ScrStream *s = bcs_of(self);
  scr_dyn_release(self);
  /* Node's getters answer undefined (or false) before the constructor ran. */
  if (!s) return property == BCS_P_DESTROYED ? scr_dyn_new_bool(false) : bcs_undefined();
  const char *name = bcs_property_names[property];
  switch (property) {
  case BCS_P_READABLE_FLOWING:
    return bcs_flowing(s);
  case BCS_P_ERRORED:
    return bcs_errored(s);
  case BCS_P_READABLE_LENGTH:
  case BCS_P_READABLE_HWM:
  case BCS_P_WRITABLE_LENGTH:
  case BCS_P_WRITABLE_HWM:
  case BCS_P_WRITABLE_CORKED:
    return scr_dyn_new_num(scr_stream_prop(s, name));
  default:
    return scr_dyn_new_bool(scr_stream_prop(s, name) != 0);
  }
}

/* The destroyed setter: Node sets the states' flag without destroying.
 * The readable and writable setters store a flag the runtime state does
 * not keep (legacy code assigns `this.readable = true`), so they are
 * accepted and have no effect. */
static ScrDyn *bcs_setter_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  int property = (int)scr_box_get_f64(closure->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  ScrStream *s = bcs_of(self);
  scr_dyn_release(self);
  if (s && property == BCS_P_DESTROYED) scr_stream_set_destroyed(s, scr_dyn_truthy(bcs_arg(args, argc, 0)));
  return bcs_undefined();
}

static void bcs_define(ScrDyn *target, const char *name, ScrDyn *getter, ScrDyn *setter) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  bcs_set(descriptor, "get", getter);
  if (setter) bcs_set(descriptor, "set", setter);
  bcs_set(descriptor, "enumerable", scr_dyn_new_bool(false));
  bcs_set(descriptor, "configurable", scr_dyn_new_bool(true));
  ScrDyn *key = bcs_key(name);
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  if (defined) scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
}

static void bcs_accessor(ScrDyn *prototype, int property) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[0], property);
  const char *name = bcs_property_names[property];
  ScrDyn *getter = scr_dyn_new_func(closure, bcs_getter_call, 0, "native:stream", name);
  ScrDyn *setter = NULL;
  if (property == BCS_P_DESTROYED || property == BCS_P_READABLE || property == BCS_P_WRITABLE) {
    ScrClosure *set = scr_closure_new(NULL, 1);
    set->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(set->caps[0], property);
    setter = scr_dyn_new_func(set, bcs_setter_call, 1, "native:stream", name);
  }
  bcs_define(prototype, name, getter, setter);
}

/* ── _readableState / _writableState views ──────────────────────────── */

static const char *const bcs_rs_names[] = {
  "highWaterMark", "length", "ended", "endEmitted", "reading", "destroyed", "objectMode",
  "needReadable", "emittedReadable", "readableListening", "resumeScheduled", "errorEmitted",
  "closed", "constructed", "flowing", "errored",
};
static const char *const bcs_ws_names[] = {
  "highWaterMark", "length", "ended", "ending", "finished", "prefinished", "destroyed",
  "objectMode", "needDrain", "corked", "closed", "constructed", "errorEmitted",
  "bufferedRequestCount", "errored",
};
#define BCS_RS_COUNT (sizeof bcs_rs_names / sizeof *bcs_rs_names)
#define BCS_WS_COUNT (sizeof bcs_ws_names / sizeof *bcs_ws_names)

static SCR_TL ScrDyn *bcs_state_protos[2];
static SCR_TL bool bcs_teardown_registered;

static ScrDyn *bcs_state_get(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  bool readable = scr_box_get_f64(closure->caps[0]) != 0;
  size_t index = (size_t)scr_box_get_f64(closure->caps[1]);
  const char *name = readable ? bcs_rs_names[index] : bcs_ws_names[index];
  ScrDyn *self = scr_dyn_this_get();
  ScrStream *s = bcs_of(self);
  scr_dyn_release(self);
  if (!s) return bcs_undefined();
  if (!strcmp(name, "flowing")) return bcs_flowing(s);
  if (!strcmp(name, "errored")) return bcs_errored(s);
  char key[48];
  snprintf(key, sizeof key, "%s:%s", readable ? "rs" : "ws", name);
  double value = scr_stream_prop(s, key);
  bool number = !strcmp(name, "highWaterMark") || !strcmp(name, "length") || !strcmp(name, "corked") ||
                !strcmp(name, "bufferedRequestCount");
  return number ? scr_dyn_new_num(value) : scr_dyn_new_bool(value != 0);
}

static void bcs_teardown(void) {
  for (int i = 0; i < 2; i++) {
    if (bcs_state_protos[i]) scr_dyn_release(bcs_state_protos[i]);
    bcs_state_protos[i] = NULL;
  }
  if (scr_exc_pending()) scr_exc_clear();
}

static ScrDyn *bcs_state_proto(bool readable) {
  ScrDyn **slot = &bcs_state_protos[readable ? 0 : 1];
  if (!*slot) {
    if (!bcs_teardown_registered) {
      bcs_teardown_registered = true;
      scr_atexit(bcs_teardown);
    }
    ScrDyn *proto = scr_dyn_new_obj();
    size_t count = readable ? BCS_RS_COUNT : BCS_WS_COUNT;
    for (size_t i = 0; i < count; i++) {
      ScrClosure *closure = scr_closure_new(NULL, 2);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], readable ? 1 : 0);
      closure->caps[1] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[1], (double)i);
      const char *name = readable ? bcs_rs_names[i] : bcs_ws_names[i];
      bcs_define(proto, name, scr_dyn_new_func(closure, bcs_state_get, 0, "native:stream", name), NULL);
    }
    *slot = proto;
  }
  return *slot;
}

/* ── the prototypes ─────────────────────────────────────────────────── */

static ScrDyn *bcs_default_method(int kind, const char *name) {
  ScrDyn *ctor = scr_dyn_builtin_class(kind);
  ScrDyn *prototype = bcs_get(ctor, "prototype");
  scr_dyn_release(ctor);
  if (!prototype) return NULL;
  ScrDyn *method = bcs_get(prototype, name);
  scr_dyn_release(prototype);
  return method;
}

static void bcs_writable_members(ScrDyn *prototype) {
  bcs_method(prototype, "write", BCS_M_WRITE, 3);
  bcs_method(prototype, "cork", BCS_M_CORK, 0);
  bcs_method(prototype, "uncork", BCS_M_UNCORK, 0);
  bcs_method(prototype, "setDefaultEncoding", BCS_M_SET_DEFAULT_ENCODING, 1);
  bcs_method(prototype, "_write", BCS_M_WRITE_DEFAULT, 3);
  bcs_set(prototype, "_writev", scr_dyn_new_null());
  bcs_method(prototype, "end", BCS_M_END, 3);
  for (int p = BCS_P_WRITABLE; p <= BCS_P_WRITABLE_OBJECT_MODE; p++) bcs_accessor(prototype, p);
}

/* Node's stream prototypes: Readable and Writable carry their methods,
 * Duplex adds Writable's, Transform and PassThrough their _transform. */
static void bcs_prototype(int kind, ScrDyn *prototype) {
  switch (kind) {
  case BCS_READABLE:
    bcs_method(prototype, "destroy", BCS_M_DESTROY, 2);
    bcs_method(prototype, "_destroy", BCS_M_DESTROY_DEFAULT, 2);
    bcs_method(prototype, "push", BCS_M_PUSH, 2);
    bcs_method(prototype, "unshift", BCS_M_UNSHIFT, 2);
    bcs_method(prototype, "isPaused", BCS_M_IS_PAUSED, 0);
    bcs_method(prototype, "setEncoding", BCS_M_SET_ENCODING, 1);
    bcs_method(prototype, "read", BCS_M_READ, 1);
    bcs_method(prototype, "_read", BCS_M_READ_DEFAULT, 1);
    bcs_method(prototype, "pipe", BCS_M_PIPE, 2);
    bcs_method(prototype, "on", BCS_M_ON, 2);
    {
      ScrDyn *on = bcs_get(prototype, "on");
      if (on) bcs_set(prototype, "addListener", on);
    }
    bcs_method(prototype, "removeListener", BCS_M_OFF, 2);
    {
      ScrDyn *off = bcs_get(prototype, "removeListener");
      if (off) bcs_set(prototype, "off", off);
    }
    bcs_method(prototype, "removeAllListeners", BCS_M_REMOVE_ALL, 1);
    bcs_method(prototype, "resume", BCS_M_RESUME, 0);
    bcs_method(prototype, "pause", BCS_M_PAUSE, 0);
    bcs_method(prototype, "unpipe", BCS_M_UNPIPE, 1);
    bcs_method(prototype, "wrap", BCS_M_WRAP, 1);
    for (int p = BCS_P_READABLE; p <= BCS_P_READABLE_FLOWING; p++) bcs_accessor(prototype, p);
    bcs_accessor(prototype, BCS_P_DESTROYED);
    bcs_accessor(prototype, BCS_P_CLOSED);
    bcs_accessor(prototype, BCS_P_ERRORED);
    break;
  case BCS_WRITABLE:
    bcs_method(prototype, "pipe", BCS_M_WRITABLE_PIPE, 0);
    bcs_writable_members(prototype);
    bcs_method(prototype, "destroy", BCS_M_DESTROY, 2);
    bcs_method(prototype, "_destroy", BCS_M_DESTROY_DEFAULT, 2);
    bcs_accessor(prototype, BCS_P_DESTROYED);
    bcs_accessor(prototype, BCS_P_CLOSED);
    bcs_accessor(prototype, BCS_P_ERRORED);
    break;
  case BCS_DUPLEX:
    bcs_writable_members(prototype);
    bcs_accessor(prototype, BCS_P_DESTROYED);
    break;
  case BCS_TRANSFORM:
    bcs_method(prototype, "_transform", BCS_M_TRANSFORM_DEFAULT, 3);
    break;
  case BCS_PASSTHROUGH:
    bcs_method(prototype, "_transform", BCS_M_PASSTHROUGH_TRANSFORM, 3);
    break;
  default:
    break;
  }
  if (scr_exc_pending()) scr_exc_clear();
}

static const ScrDynStreamOps bcs_ops = { bcs_construct, bcs_prototype, bcs_event };

/* A stream class value (the BC_* kinds of scr_dyn_builtin_class.c) with
 * its stream half attached, +1. */
ScrDyn *scr_dyn_builtin_stream_class(double kind) {
  scr_dyn_builtin_class_streams(&bcs_ops);
  return scr_dyn_builtin_class(kind);
}

/* Whether dest's method is its own rather than the stream prototypes'. */
static bool bcs_overrides(ScrDyn *dest, const char *name) {
  ScrDyn *own = bcs_get(dest, name);
  if (!own) return true;
  ScrDyn *fallback = bcs_default_method(BCS_WRITABLE, name);
  ScrDyn *duplex = bcs_default_method(BCS_DUPLEX, name);
  bool overridden = !(fallback && scr_dyn_strict_eq(own, fallback)) && !(duplex && scr_dyn_strict_eq(own, duplex));
  if (fallback) scr_dyn_release(fallback);
  if (duplex) scr_dyn_release(duplex);
  scr_dyn_release(own);
  return overridden;
}

/* pipe and unpipe on a runtime stream's untyped view, which also take
 * constructor-function streams. */
static ScrDyn *bcs_view_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStream *s = scr_box_get_ref(closure->caps[0]);
  bool pipe = scr_box_get_f64(closure->caps[1]) != 0;
  ScrDyn *result = NULL;
  if (pipe) {
    result = bcs_pipe(s, args, argc);
  } else {
    ScrDyn *first = bcs_arg(args, argc, 0);
    ScrStream *d = first->kind == SCR_DYN_UNDEF ? NULL : scr_dyn_builtin_stream_of(first);
    if (first->kind == SCR_DYN_UNDEF || d) {
      scr_stream_release(scr_stream_unpipe(s, d));
      if (d) scr_stream_release(d);
    } else {
      scr_dyn_arg_type_fail("destination", "an instance of Stream", first);
    }
    if (!scr_exc_pending()) result = scr_dyn_this_get();
  }
  scr_stream_release(s);
  return result;
}

/* The untyped view of a runtime stream crossing into JavaScript, used in
 * place of scr_stream_dyn_view by programs that link this unit: a
 * constructor-function stream's own object, or the runtime view with pipe
 * and unpipe that take those objects. +1. */
ScrDyn *scr_dyn_builtin_stream_view(ScrStream *s) {
  ScrDyn *object = scr_dyn_builtin_stream_object(s);
  if (object) return object;
  ScrDyn *view = scr_stream_dyn_view(s);
  ScrDyn *prototype = scr_dyn_get_prototype(view);
  if (prototype && prototype->kind == SCR_DYN_OBJ) {
    for (int pipe = 0; pipe < 2; pipe++) {
      ScrClosure *closure = scr_closure_new((void *)bcs_view_call, 2);
      closure->caps[0] = scr_box_new_obj(scr_stream_retain_v, scr_stream_release_v, scr_stream_trace);
      scr_box_set_ref(closure->caps[0], scr_stream_retain(s));
      closure->caps[1] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[1], pipe);
      const char *name = pipe ? "pipe" : "unpipe";
      bcs_set(prototype, name, scr_dyn_new_func(closure, bcs_view_call, 0, "native stream method", name));
    }
  }
  if (prototype) scr_dyn_release(prototype);
  if (scr_exc_pending()) scr_exc_clear();
  return view;
}

/* A checked cast of an untyped value to a runtime stream class (kind:
 * the BC_* numbering): the stream of a constructor-function stream of a
 * matching class, +1, or NULL. */
ScrStream *scr_dyn_builtin_stream_check(const ScrDyn *value, double kind) {
  if (value->kind != SCR_DYN_OBJ) return NULL;
  ScrStream *s = bcs_of(value);
  if (!s) return NULL;
  const ScrVt *vt = s->vt;
  bool readable = vt->pre >= scr_readable_vt.pre && vt->pre <= scr_readable_vt.post;
  bool writable = vt->pre >= scr_writable_vt.pre && vt->pre <= scr_writable_vt.post;
  bool duplex = vt->pre >= scr_duplex_vt.pre && vt->pre <= scr_duplex_vt.post;
  bool ok = false;
  switch ((int)kind) {
  case BCS_READABLE: ok = readable; break;
  case BCS_WRITABLE: ok = writable || duplex; break;
  case BCS_DUPLEX: ok = duplex; break;
  case BCS_TRANSFORM: ok = vt->pre >= scr_transform_vt.pre && vt->pre <= scr_transform_vt.post; break;
  case BCS_PASSTHROUGH: ok = vt->pre >= scr_passthrough_vt.pre && vt->pre <= scr_passthrough_vt.post; break;
  default: break;
  }
  return ok ? scr_stream_retain(s) : NULL;
}

/* stream.dynNative (checked-dynamic stream slots, scr_stream_dyn.c) in
 * programs that link this unit: a constructor-function stream with the
 * requested side (1 readable, 2 writable) answers its runtime stream (+1),
 * so a pipe into it, and an unpipe of it, are the runtime's own, unless it
 * overrides write() or end(), which the runtime's pipe would bypass: that
 * one is NULL and pipes through its JavaScript members. Other values take
 * scr_stream_dyn_native. Never throws. */
ScrStream *scr_dyn_builtin_stream_dyn_native(const ScrDyn *value, double side) {
  ScrStream *s = value->kind == SCR_DYN_OBJ ? bcs_of(value) : NULL;
  if (s) {
    const ScrVt *vt = s->vt;
    bool readable = vt->pre >= scr_readable_vt.pre && vt->pre <= scr_readable_vt.post;
    bool writable = vt->pre >= scr_writable_vt.pre && vt->pre <= scr_writable_vt.post;
    bool duplex = vt->pre >= scr_duplex_vt.pre && vt->pre <= scr_duplex_vt.post;
    if (!(duplex || (side == 1 ? readable : writable))) return NULL;
    ScrDyn *object = (ScrDyn *)value;
    if (side == 2 && (bcs_overrides(object, "write") || bcs_overrides(object, "end"))) {
      if (scr_exc_pending()) scr_exc_clear();
      return NULL;
    }
    return scr_stream_retain(s);
  }
  return scr_stream_dyn_native(value, side);
}

/* stream.unboxDyn (an untyped pipe destination or pipeline stage) in
 * programs that link this unit: a constructor-function stream answers its
 * runtime stream (+1), unless it overrides write() or end(), which the
 * runtime's pipe would bypass; other values take scr_stream_unbox_dyn. */
ScrStream *scr_dyn_builtin_stream_unbox(const ScrDyn *value, const ScrStr *message) {
  ScrStream *s = bcs_of(value);
  if (s && value->kind == SCR_DYN_OBJ) {
    ScrDyn *dest = (ScrDyn *)value;
    if (bcs_overrides(dest, "write") || bcs_overrides(dest, "end")) {
      if (!scr_exc_pending())
        bcs_unsupported("pipes into a constructor-function stream with its own write() or end() are not supported yet");
      return NULL;
    }
    return scr_stream_retain(s);
  }
  return scr_stream_unbox_dyn(value, message);
}

/* stream.unboxDynStage in programs that link this unit: a
 * constructor-function stream as scr_dyn_builtin_stream_unbox takes it,
 * any other value as scr_stream_unbox_dyn_stage does. */
ScrStream *scr_dyn_builtin_stream_unbox_stage(const ScrDyn *value, const ScrStr *message) {
  if (bcs_of(value) && value->kind == SCR_DYN_OBJ) return scr_dyn_builtin_stream_unbox(value, message);
  return scr_stream_unbox_dyn_stage(value, message);
}
