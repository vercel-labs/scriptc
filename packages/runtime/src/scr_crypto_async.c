/* Callback-style node:crypto wrappers. Kept in a separate executable-only
 * translation unit: library-mode archives and minimal runtime tests link the
 * synchronous digest core without acquiring event-loop or bytes-I/O edges. */
#include "scr_runtime.h"

void scr_crypto_random_bytes_async(double size, ScrClosure *cb, ScrCryptoBytesFn fn) {
  ScrBytes *value = scr_crypto_random_bytes(size);
  if (scr_exc_pending()) {
    scr_closure_release(cb);
    return;
  }
  scr_crypto_defer_bytes(value, NULL, cb, fn);
}

void scr_crypto_pbkdf2_async(ScrBytes *password, ScrBytes *salt,
                             double iterations, double keylen, ScrStr *digest,
                             ScrClosure *cb, ScrCryptoBytesFn fn) {
  const char *failure;
  ScrBytes *value = scr_crypto_pbkdf2_job(password, salt, iterations, keylen, digest, &failure);
  if (scr_exc_pending()) {
    scr_closure_release(cb);
    return;
  }
  if (failure) {
    ScrStr *message = scr_str_new(failure, strlen(failure));
    ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    scr_crypto_defer_bytes(NULL, error, cb, fn);
  } else scr_crypto_defer_bytes(value, NULL, cb, fn);
}

void scr_crypto_hkdf_async(ScrStr *digest, ScrBytes *ikm, ScrBytes *salt,
                           ScrBytes *info, double keylen, ScrClosure *cb, ScrCryptoBytesFn fn) {
  ScrBytes *value = scr_crypto_hkdf_bytes(digest, ikm, salt, info, keylen);
  if (scr_exc_pending()) { scr_closure_release(cb); return; }
  if (value->len == 0) {
    scr_bytes_release(value);
    ScrStr *message = scr_str_new("Deriving bits failed", 20);
    ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
    scr_str_release(message);
    scr_crypto_defer_bytes(NULL, error, cb, fn);
  } else scr_crypto_defer_bytes(value, NULL, cb, fn);
}

void scr_crypto_scrypt_async(ScrBytes *password, ScrBytes *salt, double keylen,
                             ScrDyn *options, ScrClosure *cb, ScrCryptoBytesFn fn) {
  ScrBytes *value = scr_crypto_scrypt(password, salt, keylen, options);
  if (scr_exc_pending()) { scr_closure_release(cb); return; }
  scr_crypto_defer_bytes(value, NULL, cb, fn);
}

/* randomFill(buf, [offset, [size,]] callback) over a typed view: the fill
 * happens now, and the callback receives the same view in a later
 * macrotask, or synchronously when nothing is filled, as in Node. */
void scr_crypto_random_fill_async(ScrBytes *buf, double offset, double size, double form,
                                  ScrClosure *cb, ScrCryptoBytesFn fn) {
  double filled = scr_crypto_random_fill_args(buf, !buf->is_data_view, offset, size, (int)form);
  if (filled < 0) {
    scr_closure_release(cb);
    return;
  }
  if (filled == 0) {
    fn(cb, NULL, scr_bytes_retain(buf));
    scr_closure_release(cb);
    return;
  }
  scr_crypto_defer_bytes(scr_bytes_retain(buf), NULL, cb, fn);
}

/* The same over any buffer value; the callback adapter receives the
 * original value (an ArrayBuffer stays an ArrayBuffer). */
void scr_crypto_random_fill_async_dyn(ScrDyn *buf, ScrDyn *offset, ScrDyn *size, double form,
                                      ScrClosure *cb, ScrCryptoBytesFn fn) {
  ScrBytes *view = NULL;
  bool typed_array = false;
  if (buf->kind == SCR_DYN_BYTES) {
    view = scr_bytes_retain(buf->v.bytes);
    typed_array = !view->is_data_view;
  } else if (scr_buffer_storage_is(buf)) {
    view = scr_bytes_buffer_source(buf);
  } else {
    scr_dyn_arg_type_fail("buf", "an instance of ArrayBuffer or ArrayBufferView", buf);
  }
  double start = 0, count = 0;
  int shape = (int)form;
  bool ok = view != NULL;
  if (ok && shape >= 2) {
    if (offset->kind == SCR_DYN_NUM) {
      start = offset->v.num;
    } else {
      scr_dyn_arg_type_fail("offset", "of type number", offset);
      ok = false;
    }
  }
  if (ok && shape == 3) {
    if (size->kind == SCR_DYN_UNDEF) {
      shape = 4;
    } else if (size->kind == SCR_DYN_NUM) {
      count = size->v.num;
    } else {
      scr_dyn_arg_type_fail("size", "of type number", size);
      ok = false;
    }
  }
  double filled = ok ? scr_crypto_random_fill_args(view, typed_array, start, count, shape) : -1;
  if (view) scr_bytes_release(view);
  if (filled < 0) {
    scr_closure_release(cb);
    return;
  }
  if (filled == 0) {
    fn(cb, NULL, (ScrBytes *)scr_dyn_retain(buf));
    scr_closure_release(cb);
    return;
  }
  scr_crypto_defer_dyn(scr_dyn_retain(buf), NULL, cb, fn);
}

/* randomInt(min, max, callback). While the modeled cache has data the
 * result arrives on the next tick; when it is empty the call waits for an
 * asynchronous refill, and every waiting call then draws again, as Node's
 * asyncRefillRandomIntCache does. Node passes undefined as the error. */
typedef struct ScrRandomIntTask {
  double min;
  double max;
  bool min_given;
  ScrClosure *cb;
  ScrCryptoIntFn fn;
  double value;
  struct ScrRandomIntTask *next;
} ScrRandomIntTask;

static SCR_TL ScrRandomIntTask *scr_random_int_waiting = NULL, **scr_random_int_waiting_tail = NULL;
static SCR_TL ScrRandomIntTask *scr_random_int_ticks = NULL, **scr_random_int_ticks_tail = NULL;
static SCR_TL bool scr_random_int_refilling = false;
static SCR_TL bool scr_random_int_cleanup = false;

static void scr_random_int_free(ScrRandomIntTask *task) {
  while (task) {
    ScrRandomIntTask *next = task->next;
    scr_closure_release(task->cb);
    free(task);
    task = next;
  }
}

/* Calls and ticks still queued at exit never run. */
static void scr_random_int_shutdown(void) {
  scr_random_int_free(scr_random_int_waiting);
  scr_random_int_free(scr_random_int_ticks);
  scr_random_int_waiting = scr_random_int_ticks = NULL;
  scr_random_int_waiting_tail = scr_random_int_ticks_tail = NULL;
}

static void scr_random_int_push(ScrRandomIntTask ***tail, ScrRandomIntTask **head,
                                ScrRandomIntTask *task) {
  task->next = NULL;
  if (!*tail) *tail = head;
  **tail = task;
  *tail = &task->next;
}

static void scr_random_int_tick(void) {
  ScrRandomIntTask *task = scr_random_int_ticks;
  if (!task) return;
  scr_random_int_ticks = task->next;
  if (!scr_random_int_ticks) scr_random_int_ticks_tail = &scr_random_int_ticks;
  task->fn(task->cb, task->value);
  scr_closure_release(task->cb);
  free(task);
}

static void scr_random_int_run(ScrRandomIntTask *task);

static void scr_random_int_refilled(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  (void)cb;
  (void)error;
  (void)value;
  scr_random_int_refilling = false;
  scr_crypto_random_int_refill();
  ScrRandomIntTask *task = scr_random_int_waiting;
  scr_random_int_waiting = NULL;
  scr_random_int_waiting_tail = &scr_random_int_waiting;
  while (task) {
    ScrRandomIntTask *next = task->next;
    scr_random_int_run(task);
    task = next;
  }
}

static void scr_random_int_run(ScrRandomIntTask *task) {
  double value;
  if (scr_crypto_random_int_try(task->min, task->max - task->min, &value)) {
    task->value = value;
    scr_random_int_push(&scr_random_int_ticks_tail, &scr_random_int_ticks, task);
    scr_next_tick_raw(scr_random_int_tick);
    return;
  }
  scr_random_int_push(&scr_random_int_waiting_tail, &scr_random_int_waiting, task);
  if (scr_random_int_refilling) return;
  scr_random_int_refilling = true;
  scr_crypto_defer_bytes(NULL, NULL, NULL, scr_random_int_refilled);
}

void scr_crypto_random_int_async(double min, double max, double min_given, ScrClosure *cb,
                                 ScrCryptoIntFn fn) {
  double range;
  if (!scr_crypto_random_int_check(min, max, min_given != 0, &range)) {
    scr_closure_release(cb);
    return;
  }
  if (!scr_random_int_cleanup) {
    if (scr_atexit(scr_random_int_shutdown) != 0) scr_trap("scriptc: could not register randomInt cleanup\n");
    scr_random_int_cleanup = true;
  }
  ScrRandomIntTask *task = malloc(sizeof *task);
  if (!task) scr_trap("scriptc: out of memory\n");
  *task = (ScrRandomIntTask){.min = min, .max = max, .min_given = min_given != 0, .cb = cb, .fn = fn};
  scr_random_int_run(task);
}

/* generateKey(type, options, callback): the key arrives in a later
 * macrotask; argument errors throw, as in Node. */
void scr_crypto_generate_key_async(ScrDyn *type, ScrDyn *options, ScrClosure *cb,
                                   ScrCryptoBytesFn fn) {
  ScrDyn *key = scr_crypto_generate_key_sync(type, options);
  if (!key) {
    scr_closure_release(cb);
    return;
  }
  scr_crypto_defer_dyn(key, NULL, cb, fn);
}

/* util.promisify over the callback forms above. The callback is a closure
 * that owns the pending promise in caps[0], and each adapter below settles
 * that promise where the callback would run: an error rejects it, and the
 * value fulfills it in the representation the promise's type uses. */
static ScrPromise *scr_crypto_promise_of(ScrClosure *cb) {
  ScrPromise *p;
  memcpy(&p, &cb->caps[0]->slot, sizeof p);
  return p;
}

ScrClosure *scr_crypto_promise_callback(ScrPromise *promise) {
  ScrClosure *cb = scr_closure_new(NULL, 1);
  cb->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_promise_retain(promise));
  return cb;
}

/* An argument error thrown before the operation started rejects the
 * promise, as the throw inside Node's promisify wrapper does. */
void scr_crypto_promise_reject_thrown(ScrPromise *promise) {
  if (scr_exc_pending()) scr_promise_reject_pending(promise);
}

static bool scr_crypto_promise_rejected(ScrPromise *p, ScrError *error) {
  if (!error) return false;
  scr_throw_obj(scr_error_retain(error), &scr_error_retain_v, &scr_error_release_v,
                scr_error_trace_arg());
  scr_promise_reject_pending(p);
  return true;
}

static void scr_crypto_promise_fulfill_dyn(ScrPromise *p, ScrDyn *value /* moves */) {
  scr_promise_fulfill_ref(p, value, scr_dyn_retain_v, scr_dyn_release_v, NULL);
}

void scr_crypto_promise_settle_bytes(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  ScrPromise *p = scr_crypto_promise_of(cb);
  if (scr_crypto_promise_rejected(p, error)) return;
  scr_promise_fulfill_ref(p, value, scr_bytes_retain_v, scr_bytes_release_v, NULL);
}

void scr_crypto_promise_settle_buffer_dyn(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  ScrPromise *p = scr_crypto_promise_of(cb);
  if (scr_crypto_promise_rejected(p, error)) return;
  ScrDyn *boxed = scr_dyn_new_buffer(value);
  scr_bytes_release(value);
  scr_crypto_promise_fulfill_dyn(p, boxed);
}

void scr_crypto_promise_settle_view_dyn(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  ScrPromise *p = scr_crypto_promise_of(cb);
  if (scr_crypto_promise_rejected(p, error)) return;
  ScrDyn *boxed = scr_dyn_new_bytes(value);
  scr_bytes_release(value);
  scr_crypto_promise_fulfill_dyn(p, boxed);
}

void scr_crypto_promise_settle_array_buffer(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  ScrPromise *p = scr_crypto_promise_of(cb);
  if (scr_crypto_promise_rejected(p, error)) return;
  ScrDyn *buffer = scr_array_buffer_from_bytes(value);
  scr_bytes_release(value);
  scr_crypto_promise_fulfill_dyn(p, buffer);
}

/* generateKey and the checked-dynamic randomFill pass a ScrDyn value. */
void scr_crypto_promise_settle_dyn(ScrClosure *cb, ScrError *error, ScrBytes *value) {
  ScrPromise *p = scr_crypto_promise_of(cb);
  if (scr_crypto_promise_rejected(p, error)) return;
  scr_crypto_promise_fulfill_dyn(p, (ScrDyn *)value);
}

void scr_crypto_promise_settle_number(ScrClosure *cb, double value) {
  scr_promise_fulfill_f64(scr_crypto_promise_of(cb), value);
}

void scr_crypto_promise_settle_number_dyn(ScrClosure *cb, double value) {
  scr_crypto_promise_fulfill_dyn(scr_crypto_promise_of(cb), scr_dyn_new_num(value));
}
