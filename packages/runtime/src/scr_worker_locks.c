/* node:worker_threads — the Web Locks manager (`worker_threads.locks`).
 *
 * One store per thread: a name maps to the mode it is held in, how many
 * requests hold it, and the requests waiting for it. Grants are FIFO, a
 * queued exclusive request blocks later shared ones, and shared requests
 * granted together hold the name in shared mode (the writer preference the
 * Web Locks spec and Node both use). `query()` answers the calling thread's
 * own held and pending entries, which is what Node reports.
 *
 * Node's validation (read from its own implementation): the name goes
 * through DOMString first (the lowering does that conversion and refuses a
 * leading "-" here), the callback must be a function, the mode is
 * "exclusive" or "shared", and four combinations are refused with a
 * NotSupportedError DOMException — ifAvailable with steal, steal with a
 * shared mode, signal with steal, and signal with ifAvailable. An aborted
 * signal rejects with its reason or an AbortError.
 *
 * Cross-thread delivery is not implemented yet: the grant would have to wake
 * the owning thread's loop, so a request made off the main thread is refused
 * by name (ERR_SCRIPTC_LOCKS_THREAD) rather than granted unsafely. A
 * callback runs one microtask after its grant, as Node's wrapped callback
 * does, and a callback that returns a promise keeps the lock until that
 * promise settles.
 *
 * Steal grants at once and marks every current holder stolen: each holder's
 * request rejects with an AbortError and the name stops being held (a grant
 * left behind by an earlier callback throw is cleared too). Requests already
 * queued keep waiting for the steal's own release, as Node's queue does.
 * ifAvailable answers a null lock when the name is busy, holding and
 * queueing nothing, and settles the request with the callback's own result.
 *
 * A callback that throws settles its request with the value after Node's
 * convertLockError step: the value's `message` is read (a proxy get trap or
 * an accessor can throw there, and that error becomes the reason), a
 * LOCK_STOLEN message becomes an AbortError, and every other value stays the
 * reason. Without a signal Node leaves the grant held after that rejection,
 * so a later same-name request waits; the signal path releases it first. */
#include "scr_worker.h"

#ifdef SCR_WORKERS
#include "scr_async.h"
#include "scr_closure.h"
#include "scr_dyn.h"
#include "scr_error.h"
#include "scr_exception.h"
#include "scr_optional.h"
#include "scr_string.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <process.h>
#define scr_locks_pid() _getpid()
#else
#include <unistd.h>
#define scr_locks_pid() getpid()
#endif

typedef struct ScrLockEntry ScrLockEntry;
typedef struct ScrLockReq ScrLockReq;

/* One request: the promise the program awaits, the callback that runs under
 * the lock, and the mode it asked for. A granted request keeps its grant
 * until its callback's promise settles; an abort signal rejects it any time
 * before the callback starts, as Node's wrapped callback does. */
struct ScrLockReq {
  size_t rc;
  ScrPromise *promise; /* +1 */
  ScrDyn *callback;    /* +1, released when the callback starts */
  ScrLockEntry *entry; /* borrowed while granted (a holder keeps it alive) */
  ScrDyn *signal;      /* +1 when the request carries one */
  ScrDyn *dispose;     /* +1, the abort listener's remover */
  bool shared;
  bool granted; /* in the entry's holder list right now */
  bool started; /* the callback has begun: an abort from here does nothing */
  bool aborted;
  bool stolen; /* a steal detached it: its callback's result is discarded */
  bool leaked; /* callback threw with no signal: Node leaves the name held */
  ScrLockReq *next;      /* the queue's link */
  ScrLockReq *hold_next; /* the holder list's link */
};

typedef struct ScrLockEntry {
  char *name;
  size_t name_len;
  int holders;
  bool holder_shared;
  ScrLockReq *holder_head; /* one entry per held grant, oldest first */
  ScrLockReq *queue;
  ScrLockReq *tail;
  struct ScrLockEntry *next;
} ScrLockEntry;

static SCR_TL ScrLockEntry *scr_locks;

static ScrLockEntry *scr_locks_entry(const char *name, size_t len, bool create) {
  for (ScrLockEntry *entry = scr_locks; entry != NULL; entry = entry->next)
    if (entry->name_len == len && memcmp(entry->name, name, len) == 0) return entry;
  if (!create) return NULL;
  ScrLockEntry *entry = calloc(1, sizeof *entry);
  if (entry == NULL) scr_trap("out of memory");
  entry->name = malloc(len + 1);
  if (entry->name == NULL) scr_trap("out of memory");
  memcpy(entry->name, name, len);
  entry->name[len] = '\0';
  entry->name_len = len;
  entry->next = scr_locks;
  scr_locks = entry;
  return entry;
}

/* Drops an entry with no holders and no queue. */
static void scr_locks_drop_empty(ScrLockEntry *entry) {
  for (ScrLockEntry **slot = &scr_locks; *slot != NULL; slot = &(*slot)->next) {
    if (*slot != entry) continue;
    *slot = entry->next;
    free(entry->name);
    free(entry);
    return;
  }
}

static ScrDyn *scr_locks_object(const char *name, size_t len, const char *mode) {
  ScrStr *text = scr_str_new(name, len);
  ScrStr *mode_text = scr_str_new(mode, strlen(mode));
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "name", 4, scr_dyn_new_str(text));
  scr_dyn_obj_set(object, "mode", 4, scr_dyn_new_str(mode_text));
  scr_str_release(text);
  scr_str_release(mode_text);
  return object;
}

static const char *scr_locks_mode_name(bool shared) { return shared ? "shared" : "exclusive"; }

/* ── the request's lifetime ──────────────────────────────────────────
 * One reference travels with the request: the queue holds it while the
 * request waits, the start job's box while the grant has not run the
 * callback, and the wait context while the callback's promise is pending.
 * The abort listener keeps a reference of its own until it is disposed. */

static ScrLockReq *scr_locks_req_retain(ScrLockReq *req) {
  req->rc++;
  return req;
}

static void scr_locks_req_release(ScrLockReq *req) {
  if (req == NULL || --req->rc > 0) return;
  scr_promise_release(req->promise);
  scr_dyn_release(req->callback);
  scr_dyn_release(req->signal);
  scr_dyn_release(req->dispose);
  free(req);
}

static void *scr_locks_req_retain_v(void *req) { return scr_locks_req_retain(req); }
static void scr_locks_req_release_v(void *req) { scr_locks_req_release(req); }

/* A box holding one reference to the request, for a closure or a reaction's
 * context (the reference moves in). */
static ScrBox *scr_locks_req_box(ScrLockReq *req) {
  ScrBox *box = scr_box_new_obj(&scr_locks_req_retain_v, &scr_locks_req_release_v, NULL);
  scr_box_set_ref(box, req);
  return box;
}

/* ── the holder list ─────────────────────────────────────────────────
 * An entry keeps one reference per held grant, so `query()` lists a row per
 * held lock (shared holders side by side) and a steal can find and abort each
 * holder. A grant left behind by a callback throw keeps its entry reference
 * until a steal clears it, which is Node's leak. */

static void scr_locks_hold(ScrLockEntry *entry, ScrLockReq *req) {
  req->granted = true;
  req->entry = entry;
  req->hold_next = NULL;
  ScrLockReq **slot = &entry->holder_head;
  while (*slot != NULL) slot = &(*slot)->hold_next;
  *slot = req;
  entry->holders++;
  entry->holder_shared = req->shared;
  scr_locks_req_retain(req);
}

/* Takes the grant back and drops the holder list's reference. The caller
 * keeps its own reference (the start job's, the wait context's) for the rest
 * of the operation. */
static void scr_locks_unhold(ScrLockEntry *entry, ScrLockReq *req) {
  if (!req->granted) return;
  req->granted = false;
  for (ScrLockReq **slot = &entry->holder_head; *slot != NULL; slot = &(*slot)->hold_next) {
    if (*slot != req) continue;
    *slot = req->hold_next;
    break;
  }
  req->hold_next = NULL;
  if (entry->holders > 0) entry->holders--;
  if (entry->holder_head == NULL) entry->holder_shared = false;
  scr_locks_req_release(req);
}

/* Removes the request's abort listener, as Node's finally does once the
 * callback starts or the request settles. */
static void scr_locks_dispose_signal(ScrLockReq *req) {
  if (req->dispose == NULL) return;
  ScrDyn *dispose = req->dispose;
  req->dispose = NULL;
  ScrDyn *result = scr_dyn_call(dispose, NULL, 0, "dispose");
  scr_dyn_release(result);
  scr_dyn_release(dispose);
}

/* Rejects the request the way Node's abort listener does: the signal's
 * reason when it carries one, an AbortError DOMException otherwise. */
static void scr_locks_reject_aborted(ScrLockReq *req) {
  ScrDyn *reason = req->signal ? scr_dyn_obj_read(req->signal, "reason", 6) : NULL;
  if (reason == NULL || reason->kind == SCR_DYN_UNDEF || reason->kind == SCR_DYN_NULL) {
    scr_dyn_release(reason);
    scr_throw_domex("AbortError", "The operation was aborted");
  } else {
    scr_throw_ref(reason, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  }
  scr_promise_reject_pending(req->promise);
}

static void scr_locks_drain(ScrLockEntry *entry);

/* Node's convertLockError reads the thrown value's `message` and maps its
 * LOCK_STOLEN sentinel to an AbortError. The read is program code (a Proxy
 * get trap, an accessor), so it can throw; that error then becomes the
 * request's reason, exactly as the throw out of Node's own catch block does. */
static bool scr_locks_message_is_stolen(const ScrDyn *message) {
  static const char sentinel[] = "LOCK_STOLEN";
  return message != NULL && message->kind == SCR_DYN_STR &&
         message->v.str->len == sizeof sentinel - 1 &&
         memcmp(message->v.str->data, sentinel, sizeof sentinel - 1) == 0;
}

/* Rejects `promise` with the pending exception, converted as above. The
 * exception leaves the cell first: the runtime's reads require a clean cell,
 * and a trap or accessor the read runs is itself program code whose throw
 * leaves its own error behind. The original value is re-raised as the same
 * snapshot, so a catch binding keeps its identity. With `signal_path` the
 * conversion runs inside Node's rejection handler, so a read that throws
 * leaves the request promise unsettled and the error is an unhandled
 * rejection; every other path rejects with that error. */
static void scr_locks_reject_thrown(ScrPromise *promise, bool signal_path) {
  if (!scr_exc_pending()) return;
  ScrCaught *caught = scr_exc_take(); /* +1, the cell is clean now */
  bool stolen = false;
  if (caught->kind == SCR_EXC_REF || caught->kind == SCR_EXC_PRIMITIVE_REF) {
    /* The checked-dynamic payload keeps its identity here, so the message
     * read runs against the program's own object (proxies included). */
    const ScrDyn *value = caught->payload;
    if (caught->retain_fn == scr_dyn_retain_v && value != NULL &&
        value->kind != SCR_DYN_NULL && value->kind != SCR_DYN_UNDEF) {
      ScrDyn *message = scr_dyn_obj_read(value, "message", 7);
      if (message == NULL && scr_exc_pending()) {
        /* The read threw: that error is what the program sees. */
        scr_caught_release(caught);
        if (signal_path) {
          ScrPromise *report = scr_promise_new();
          scr_promise_reject_pending(report);
          scr_promise_release(report); /* the unhandled ledger keeps it until report */
        } else {
          scr_promise_reject_pending(promise);
        }
        return;
      }
      stolen = scr_locks_message_is_stolen(message);
      scr_dyn_release(message);
    }
  } else if (caught->kind == SCR_EXC_OBJ && scr_error_is(caught->payload)) {
    const ScrError *error = caught->payload;
    stolen = error->message != NULL && error->message->len == sizeof "LOCK_STOLEN" - 1 &&
             memcmp(error->message->data, "LOCK_STOLEN", sizeof "LOCK_STOLEN" - 1) == 0;
  }
  if (stolen) {
    scr_caught_release(caught);
    scr_throw_domex("AbortError", "The operation was aborted");
  } else {
    scr_rethrow(caught); /* borrows; raises a retained copy */
    scr_caught_release(caught);
  }
  scr_promise_reject_pending(promise);
}

/* The abort listener: a request whose callback has not started yet rejects
 * with the signal's reason, and the queue place or the grant it held goes
 * back to the entry. A request already running its callback keeps going,
 * as Node's lockGranted flag decides. */
static ScrDyn *scr_locks_abort_fire(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrLockReq *req = scr_box_get_ref(clo->caps[0]); /* +1 */
  if (req->aborted || req->started) {
    scr_locks_req_release(req);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  req->aborted = true;
  ScrLockEntry *entry = req->entry;
  bool granted = req->granted;
  if (!granted) {
    for (ScrLockReq **slot = &entry->queue; *slot != NULL; slot = &(*slot)->next) {
      if (*slot != req) continue;
      *slot = req->next;
      break;
    }
    req->next = NULL;
    entry->tail = NULL;
    for (ScrLockReq *queued = entry->queue; queued != NULL; queued = queued->next)
      entry->tail = queued;
  } else {
    scr_locks_unhold(entry, req);
  }
  scr_locks_reject_aborted(req);
  scr_locks_dispose_signal(req);
  /* A queued request's reference is the queue's, which is gone now; a
   * granted one stays with the start job, which finds the abort flag. */
  if (!granted) scr_locks_req_release(req);
  if (granted) scr_locks_drain(entry);
  scr_locks_req_release(req); /* this thunk's +1 */
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The callback's promise is pending: the lock stays held until it settles. */
typedef struct {
  ScrLockReq *req;    /* owned */
  ScrPromise *source; /* owned, kept until the reaction runs */
} ScrLocksWait;

static void scr_locks_wait_react(void *ctx, ScrPromise *settled) {
  ScrLocksWait *wait = ctx;
  ScrLockReq *req = wait->req;
  /* A steal already took the grant back and settled this request: Node skips
   * settling a stolen lock's promise and just processes the queue. */
  if (req->stolen) return;
  ScrLockEntry *entry = req->entry;
  if (req->granted) {
    /* The queue advances before this request's promise settles, as Node's
     * release does: the next granted callback runs in its own turn ahead of
     * this promise's consumers. An ifAvailable miss never held the name, so
     * it has nothing to release and no entry to touch. */
    scr_locks_unhold(entry, req);
    scr_locks_drain(entry);
  }
  if (scr_promise_is_rejected(settled)) {
    ScrDyn *reason = scr_promise_reason_dyn(settled); /* +1, moved to the throw */
    if (reason != NULL)
      scr_throw_ref(reason, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_locks_reject_thrown(req->promise, req->signal != NULL);
  } else {
    scr_promise_fulfill_like(req->promise, settled);
  }
}

static void scr_locks_wait_drop(void *ctx) {
  ScrLocksWait *wait = ctx;
  scr_promise_release(wait->source);
  scr_locks_req_release(wait->req);
  free(wait);
}

static const ScrPromiseReaction scr_locks_wait_reaction = { scr_locks_wait_react,
                                                            scr_locks_wait_drop };

/* Runs the granted request's callback, one microtask after the grant, as
 * Node's wrapped callback does (an abort issued before that turn rejects
 * the request instead of running it). The box holds the request's
 * reference for the grant. */
static ScrDyn *scr_locks_start_job(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrLockReq *req = scr_box_get_ref(clo->caps[0]); /* +1 */
  if (req->aborted || req->started) {
    scr_locks_req_release(req);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  bool stolen = req->stolen;
  req->started = true;
  scr_locks_dispose_signal(req);
  ScrLockEntry *entry = req->entry;
  ScrDyn *lock = scr_locks_object(entry->name, entry->name_len, scr_locks_mode_name(req->shared));
  ScrDyn *lock_args[] = {lock};
  /* Node resolves the request with the CALLBACK's own result, not with the
   * lock (the lock is the callback's argument). */
  ScrDyn *result = scr_dyn_call(req->callback, lock_args, 1, "locks.request callback");
  scr_dyn_release(lock);
  scr_dyn_release(req->callback);
  req->callback = NULL;
  if (stolen) {
    /* A steal released this request before its callback's turn. Node's
     * wrapped callback still runs and its outcome is dropped: the lock was
     * already detached and the request already settled by the steal. */
    scr_exc_clear();
    scr_dyn_release(result);
    scr_locks_req_release(req);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (scr_exc_pending()) {
    scr_dyn_release(result);
    bool signal_path = req->signal != NULL;
    if (signal_path) {
      /* The wrapped callback's promise carries the throw to the lock, which
       * Node releases before the rejection reaches the request. */
      scr_locks_unhold(entry, req);
      scr_locks_drain(entry);
    } else {
      /* Node rejects the request but never releases the grant, so the name
       * stays held and a later same-name request waits (Node's leak). The
       * request's settled promise is dropped afterwards: the grant, not the
       * request, is what Node keeps alive. */
      req->leaked = true;
    }
    scr_locks_reject_thrown(req->promise, signal_path);
    if (req->leaked) {
      scr_promise_release(req->promise);
      req->promise = NULL;
    }
    scr_locks_req_release(req);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (result != NULL && result->kind == SCR_DYN_PROMISE) {
    /* The lock waits for the callback's promise, and the request settles
     * with its outcome. */
    ScrLocksWait *wait = malloc(sizeof *wait);
    if (wait == NULL) scr_trap("out of memory");
    wait->req = scr_locks_req_retain(req);
    wait->source = scr_promise_retain(result->v.promise);
    scr_promise_react(wait->source, &scr_locks_wait_reaction, wait);
    scr_dyn_release(result);
  } else {
    scr_locks_unhold(entry, req);
    scr_locks_drain(entry);
    /* settle_ref takes the value's reference. */
    scr_promise_fulfill_ref(req->promise, result, scr_dyn_retain_v, scr_dyn_release_v,
                            scr_dyn_trace_v);
  }
  scr_locks_req_release(req); /* this thunk's +1 */
  return scr_dyn_retain(scr_dyn_undefined());
}

/* Grants a request: the holder list records it now (query() reports the lock
 * as held), and the callback runs one microtask later. Takes the request's
 * reference for the start job's box. */
static void scr_locks_grant(ScrLockEntry *entry, ScrLockReq *req) {
  scr_locks_hold(entry, req);
  ScrClosure *job = scr_closure_new((void *)&scr_locks_start_job, 1);
  job->caps[0] = scr_locks_req_box(req);
  scr_queue_microtask(job);
}

/* Grants queued requests while the queue can advance: an entry with no
 * holder takes its next request, a shared holder takes a queued shared one,
 * and an exclusive holder takes nothing. One loop rather than a call per
 * grant — a callback that queues same-name work grows this same queue, and
 * the entry that may free itself when it empties has to stay valid until
 * the loop is done with it. */
static void scr_locks_drain(ScrLockEntry *entry) {
  while (entry->queue != NULL) {
    if (entry->holders > 0 && (!entry->holder_shared || !entry->queue->shared)) break;
    ScrLockReq *next = entry->queue;
    entry->queue = next->next;
    if (entry->queue == NULL) entry->tail = NULL;
    next->next = NULL;
    scr_locks_grant(entry, next);
  }
  if (entry->holders == 0 && entry->queue == NULL) scr_locks_drop_empty(entry);
}

/* Node's validateFunction message for the callback slot. */
static void scr_locks_callback_type_error(const ScrDyn *callback) {
  char detail[64], msg[192];
  const char *received = callback == NULL ? "undefined"
                                          : scr_dyn_specific_type(callback, detail, sizeof detail);
  int len = snprintf(msg, sizeof msg,
                     "The \"callback\" argument must be of type function. Received %s", received);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_TYPE");
}

/* Reads one boolean option, defaulting to false. */
static bool scr_locks_flag(const ScrDyn *options, const char *key, size_t key_len) {
  if (options == NULL || options->kind != SCR_DYN_OBJ) return false;
  ScrDyn *value = scr_dyn_obj_read(options, key, key_len);
  bool answer = value != NULL && scr_dyn_truthy(value);
  scr_dyn_release(value);
  return answer;
}

static const char *scr_locks_mode_of(const ScrDyn *options, bool *shared) {
  *shared = false;
  if (options == NULL || options->kind != SCR_DYN_OBJ) return NULL;
  ScrDyn *value = scr_dyn_obj_read(options, "mode", 4);
  if (value == NULL || value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    return NULL;
  }
  if (value->kind != SCR_DYN_STR) {
    scr_dyn_release(value);
    return "mode is not a string";
  }
  const ScrStr *text = value->v.str;
  if (text->len == 9 && memcmp(text->data, "exclusive", 9) == 0) {
    scr_dyn_release(value);
    return NULL;
  }
  if (text->len == 6 && memcmp(text->data, "shared", 6) == 0) {
    *shared = true;
    scr_dyn_release(value);
    return NULL;
  }
  static char message[160];
  int len = snprintf(message, sizeof message,
                     "mode '%.*s' is not a valid enum value of type LockMode.", (int)text->len,
                     text->data);
  (void)len;
  scr_dyn_release(value);
  return message;
}

/* ifAvailable when the name is busy: Node calls the callback right away with
 * a null lock, holds nothing (query() lists neither a held nor a pending
 * row for it), and settles the request with the callback's own result; a
 * returned promise settles it later. The rejection conversion is the same as
 * for a granted request, and no lock is released on the way. */
static void scr_locks_if_available_miss(ScrLockReq *req) {
  ScrDyn *null_lock = scr_dyn_new_null();
  ScrDyn *args[] = {null_lock};
  ScrDyn *result = scr_dyn_call(req->callback, args, 1, "locks.request callback");
  scr_dyn_release(null_lock);
  scr_dyn_release(req->callback);
  req->callback = NULL;
  if (scr_exc_pending()) {
    scr_dyn_release(result);
    scr_locks_reject_thrown(req->promise, false);
  } else if (result != NULL && result->kind == SCR_DYN_PROMISE) {
    ScrLocksWait *wait = malloc(sizeof *wait);
    if (wait == NULL) scr_trap("out of memory");
    wait->req = scr_locks_req_retain(req);
    wait->source = scr_promise_retain(result->v.promise);
    scr_promise_react(wait->source, &scr_locks_wait_reaction, wait);
    scr_dyn_release(result);
  } else {
    scr_promise_fulfill_ref(req->promise, result, scr_dyn_retain_v, scr_dyn_release_v,
                            scr_dyn_trace_v);
  }
  scr_locks_req_release(req);
}

ScrPromise *scr_worker_locks_request(ScrStr *name, const ScrDyn *options, const ScrDyn *callback) {
  if (!scr_context_is_main()) {
    static const char message[] =
        "locks.request off the main thread waits for a grant that has to wake the calling "
        "thread's loop, which this build does not do yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_SCRIPTC_LOCKS_THREAD");
    ScrPromise *failed = scr_promise_new();
    scr_promise_reject_pending(failed);
    return failed;
  }
  if (callback == NULL || callback->kind != SCR_DYN_FUNC) {
    scr_locks_callback_type_error(callback);
    (void)0;
    ScrPromise *failed = scr_promise_new();
    scr_promise_reject_pending(failed);
    return failed;
  }
  /* A statically typed options object crosses into the checked-dynamic tree
   * as a typed reference: materialize it once so the fields read. */
  ScrDyn *materialized = NULL;
  if (options != NULL && options->kind == SCR_DYN_TYPED_REF) {
    materialized = scr_dyn_typed_ref_materialize(options);
    if (materialized == NULL || scr_exc_pending()) {
      scr_dyn_release(materialized);
      ScrPromise *failed = scr_promise_new();
      scr_promise_reject_pending(failed);
      return failed;
    }
    options = materialized;
  }
  bool shared = false;
  const char *mode_problem = scr_locks_mode_of(options, &shared);
  if (mode_problem != NULL) {
    scr_dyn_release(materialized);
    scr_throw_error_msg_code(SCR_ERR_TYPE, mode_problem, strlen(mode_problem),
                             "ERR_INVALID_ARG_VALUE");
    ScrPromise *failed = scr_promise_new();
    scr_promise_reject_pending(failed);
    return failed;
  }
  bool if_available = scr_locks_flag(options, "ifAvailable", 11);
  bool steal = scr_locks_flag(options, "steal", 5);
  ScrDyn *signal = options != NULL && options->kind == SCR_DYN_OBJ
                       ? scr_dyn_obj_read(options, "signal", 6)
                       : NULL;
  if (signal != NULL && signal->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(signal);
    signal = NULL;
  }
  /* The mode, flags and signal are captured; the materialized view is done. */
  scr_dyn_release(materialized);
  materialized = NULL;
  if (name->len > 0 && name->data[0] == '-') {
    scr_dyn_release(signal);
    scr_throw_domex("NotSupportedError", "Lock name may not start with hyphen");
    ScrPromise *failed = scr_promise_new();
    scr_promise_reject_pending(failed);
    return failed;
  }
  if (if_available && steal || shared && steal) {
    scr_dyn_release(signal);
    scr_throw_domex("NotSupportedError",
                    if_available && steal ? "ifAvailable and steal are mutually exclusive"
                                          : "mode: \"shared\" and steal are mutually exclusive");
    ScrPromise *failed = scr_promise_new();
    scr_promise_reject_pending(failed);
    return failed;
  }
  if (signal != NULL && (steal || if_available)) {
    scr_dyn_release(signal);
    scr_throw_domex("NotSupportedError", "signal cannot be used with steal or ifAvailable");
    ScrPromise *failed = scr_promise_new();
    scr_promise_reject_pending(failed);
    return failed;
  }
  /* An aborted signal rejects before anything is queued, with its own
   * reason when it carries one (Node's `signal.reason || AbortError`). */
  bool aborted = false;
  if (signal != NULL) {
    ScrDyn *flag = scr_dyn_obj_read(signal, "aborted", 7);
    aborted = flag != NULL && scr_dyn_truthy(flag);
    scr_dyn_release(flag);
  }
  if (aborted) {
    scr_dyn_release(signal);
    scr_throw_domex("AbortError", "This operation was aborted");
    ScrPromise *failed = scr_promise_new();
    scr_promise_reject_pending(failed);
    return failed;
  }

  ScrLockEntry *entry = scr_locks_entry(name->data, name->len, true);
  ScrLockReq *req = calloc(1, sizeof *req);
  if (req == NULL) scr_trap("out of memory");
  ScrPromise *promise = scr_promise_new();
  /* The queue keeps its own reference: a request can outlive the program's
   * handle to the promise (a callback that starts a same-name request and
   * drops the result), and draining it later settles that promise. */
  req->rc = 1;
  req->promise = scr_promise_retain(promise);
  req->callback = scr_dyn_retain((ScrDyn *)callback);
  req->entry = entry;
  req->shared = shared;
  /* The option's signal (the read above answered a reference) belongs to
   * the request now; its abort listener rejects the request until the
   * callback starts, as Node's wrapped callback does. */
  req->signal = signal;
  if (signal != NULL) {
    ScrClosure *watch = scr_closure_new((void *)&scr_locks_abort_fire, 1);
    watch->caps[0] = scr_locks_req_box(scr_locks_req_retain(req));
    ScrDyn *listener = scr_dyn_new_func(watch, &scr_locks_abort_fire, 0, "(event)", "abort");
    ScrDyn *dispose = scr_optional_event_target != NULL
                          ? scr_optional_event_target->add_abort_listener(signal, listener)
                          : NULL;
    scr_dyn_release(listener);
    if (dispose == NULL) {
      /* A value that is not an AbortSignal: Node's validation error becomes
       * the request's rejection. */
      if (scr_exc_pending()) scr_promise_reject_pending(promise);
      scr_locks_req_release(req);
      return promise;
    }
    req->dispose = dispose;
  }
  if (steal) {
    /* Node grants a steal ahead of the queue and marks every current holder
     * stolen: each holder's request rejects with an AbortError and the name
     * stops being held (a grant left behind by an earlier callback throw is
     * cleared too). Requests already queued are not aborted; they wait for
     * the steal's own release. */
    ScrLockReq *victim = entry->holder_head;
    entry->holder_head = NULL;
    entry->holders = 0;
    entry->holder_shared = false;
    while (victim != NULL) {
      ScrLockReq *next = victim->hold_next;
      victim->hold_next = NULL;
      victim->granted = false;
      victim->stolen = true;
      if (victim->promise != NULL && scr_promise_is_pending(victim->promise)) {
        scr_throw_domex("AbortError", "The operation was aborted");
        scr_promise_reject_pending(victim->promise);
      }
      /* A grant an earlier callback throw leaked keeps its (settled) promise:
       * there is nothing left to reject. */
      scr_locks_req_release(victim); /* the holder list's reference */
      victim = next;
    }
    scr_locks_grant(entry, req);
  } else if (entry->holders == 0 && entry->queue == NULL) {
    scr_locks_grant(entry, req);
    scr_locks_drain(entry);
  } else if (entry->holders > 0 && entry->holder_shared && shared && entry->queue == NULL) {
    scr_locks_grant(entry, req);
    scr_locks_drain(entry);
  } else if (if_available) {
    scr_locks_if_available_miss(req);
  } else {
    if (entry->tail == NULL)
      entry->queue = req;
    else
      entry->tail->next = req;
    entry->tail = req;
  }
  return promise;
}

ScrPromise *scr_worker_locks_query(void) {
  ScrDyn *held = scr_dyn_new_arr();
  ScrDyn *pending = scr_dyn_new_arr();
  char client[64];
  int client_len = snprintf(client, sizeof client, "node-%ld-%.0f", (long)scr_locks_pid(),
                            scr_context_thread_number());
  for (ScrLockEntry *entry = scr_locks; entry != NULL; entry = entry->next) {
    int row_len = 0;
    for (ScrLockReq *holder = entry->holder_head; holder != NULL; holder = holder->hold_next) {
      ScrDyn *row = scr_locks_object(entry->name, entry->name_len,
                                     scr_locks_mode_name(holder->shared));
      ScrStr *id = scr_str_new(client, (size_t)client_len);
      scr_dyn_obj_set(row, "clientId", 8, scr_dyn_new_str(id));
      scr_str_release(id);
      scr_dyn_arr_push(held, row);
      row_len++;
    }
    for (ScrLockReq *req = entry->queue; req != NULL; req = req->next) {
      ScrDyn *row = scr_locks_object(entry->name, entry->name_len,
                                     scr_locks_mode_name(req->shared));
      scr_dyn_arr_push(pending, row);
      row_len++;
    }
    (void)row_len;
  }
  ScrDyn *snapshot = scr_dyn_new_obj();
  scr_dyn_obj_set(snapshot, "held", 4, held);
  scr_dyn_obj_set(snapshot, "pending", 7, pending);
  ScrPromise *promise = scr_promise_new();
  /* The promise keeps the snapshot's reference. */
  scr_promise_fulfill_ref(promise, snapshot, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  return promise;
}

#endif /* SCR_WORKERS */
