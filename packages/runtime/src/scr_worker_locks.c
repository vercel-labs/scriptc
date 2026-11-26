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
 * by name (ERR_SCRIPTC_LOCKS_THREAD) rather than granted unsafely. A callback
 * that returns a promise is settled when the promise settles only in the next
 * step; this build settles after the callback returns. */
#include "scr_worker.h"

#ifdef SCR_WORKERS
#include "scr_async.h"
#include "scr_dyn.h"
#include "scr_error.h"
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

/* One request: the promise the program awaits, the callback that runs under
 * the lock, and the mode it asked for. */
typedef struct ScrLockReq {
  ScrPromise *promise; /* +1 */
  ScrDyn *callback;    /* +1 */
  bool shared;
  bool granted;
  struct ScrLockReq *next;
} ScrLockReq;

typedef struct ScrLockEntry {
  char *name;
  size_t name_len;
  int holders;
  bool holder_shared;
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

/* Runs the granted request: the callback sees a Lock, then the promise
 * answers { name, mode }. Both are fresh objects, as Node's are. */
static void scr_locks_run(ScrLockEntry *entry, ScrLockReq *req) {
  req->granted = true;
  entry->holders++;
  entry->holder_shared = req->shared;
  ScrDyn *lock = scr_locks_object(entry->name, entry->name_len, scr_locks_mode_name(req->shared));
  ScrDyn *args[] = {lock};
  /* Node resolves the request with the CALLBACK's own result, not with the
   * lock (the lock is the callback's argument). */
  ScrDyn *result = scr_dyn_call(req->callback, args, 1, "locks.request callback");
  scr_dyn_release(lock);
  scr_dyn_release(req->callback);
  /* The promise keeps the reference the call answered, so it is not released
   * here. */
  scr_promise_fulfill_ref(req->promise, result, scr_dyn_retain_v, scr_dyn_release_v,
                          scr_dyn_trace_v);
  /* A request is done holding when its callback returned; releasing it here
   * lets the queue advance in the same turn, which is Node's ordering for a
   * callback that returns at once. */
  if (entry->holders > 0) entry->holders--;
  if (entry->holders > 0) return;
  while (entry->queue != NULL) {
    ScrLockReq *next = entry->queue;
    entry->queue = next->next;
    if (entry->queue == NULL) entry->tail = NULL;
    next->next = NULL;
    scr_locks_run(entry, next);
    if (entry->holders > 0 && !entry->holder_shared) break;
    if (entry->holders > 0 && entry->queue != NULL && entry->queue->shared) continue;
    if (entry->holders > 0) break;
  }
  if (entry->holders == 0 && entry->queue == NULL) scr_locks_drop_empty(entry);
  free(req);
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
  scr_dyn_release(signal);

  ScrLockEntry *entry = scr_locks_entry(name->data, name->len, true);
  ScrLockReq *req = calloc(1, sizeof *req);
  if (req == NULL) scr_trap("out of memory");
  ScrPromise *promise = scr_promise_new();
  req->promise = promise;
  req->callback = scr_dyn_retain((ScrDyn *)callback);
  req->shared = shared;
  if (steal) {
    /* The request is granted at once; whatever waited for the name is
     * rejected with AbortError, as Node does. */
    while (entry->queue != NULL) {
      ScrLockReq *aborted = entry->queue;
      entry->queue = aborted->next;
      if (entry->queue == NULL) entry->tail = NULL;
      scr_throw_domex("AbortError", "The lock was stolen");
      scr_promise_reject_pending(aborted->promise);
      scr_dyn_release(aborted->callback);
      free(aborted);
    }
    scr_locks_run(entry, req);
  } else if (entry->holders == 0 && entry->queue == NULL) {
    scr_locks_run(entry, req);
  } else if (entry->holders > 0 && entry->holder_shared && shared && entry->queue == NULL) {
    scr_locks_run(entry, req);
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
    if (entry->holders > 0) {
      ScrDyn *row = scr_locks_object(entry->name, entry->name_len,
                                     scr_locks_mode_name(entry->holder_shared));
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
