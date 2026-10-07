/* Shared storage is neutral: only its backing allocation and synchronization
 * cross contexts. ScrBytes wrappers and their reference counts remain local. */
#include "scr_runtime.h"
#include "scr_numeric.h"
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <time.h>
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
#ifdef _WIN32
#include <windows.h>
#else
#include <pthread.h>
#include <time.h>
#endif
#endif

struct ScrSharedBytes {
  atomic_size_t references;
  size_t length;
  uint8_t *data;
};

#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
#ifdef _WIN32
static SRWLOCK scr_shared_mutex = SRWLOCK_INIT;
static CONDITION_VARIABLE scr_shared_condition = CONDITION_VARIABLE_INIT;
#else
static pthread_mutex_t scr_shared_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t scr_shared_condition = PTHREAD_COND_INITIALIZER;
#endif
static SCR_TL unsigned scr_shared_depth;
#endif

/* One ordering domain covers overlapping views of different widths. Recursive
 * runtime helpers may nest, but no caller may execute script while holding it. */
void scr_shared_enter(void) {
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
  if (scr_shared_depth++ != 0) return;
#ifdef _WIN32
  AcquireSRWLockExclusive(&scr_shared_mutex);
#else
  pthread_mutex_lock(&scr_shared_mutex);
#endif
#endif
}

void scr_shared_leave(void) {
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
  if (--scr_shared_depth != 0) return;
#ifdef _WIN32
  ReleaseSRWLockExclusive(&scr_shared_mutex);
#else
  pthread_mutex_unlock(&scr_shared_mutex);
#endif
#endif
}

bool scr_shared_guard(const ScrBytes *a, const ScrBytes *b) {
  bool shared = (a && a->shared) || (b && b->shared);
  if (shared) scr_shared_enter();
  return shared;
}

void scr_shared_guard_release(bool *held) { if (*held) scr_shared_leave(); }

ScrSharedBytes *scr_shared_retain(ScrSharedBytes *storage) {
  atomic_fetch_add_explicit(&storage->references, 1, memory_order_relaxed);
  return storage;
}

void scr_shared_release(ScrSharedBytes *storage) {
  if (!storage || atomic_fetch_sub_explicit(&storage->references, 1, memory_order_acq_rel) != 1) return;
  free(storage->data);
  free(storage);
}

void scr_bytes_make_shared(ScrBytes *bytes) {
  if (bytes->backing || bytes->shared || bytes->external) scr_trap("scriptc: invalid shared storage owner\n");
  ScrSharedBytes *storage = malloc(sizeof(*storage));
  if (!storage) scr_trap("scriptc: out of memory\n");
  atomic_init(&storage->references, 1);
  storage->length = bytes->len * scr_bytes_elem_size(bytes->elem);
  storage->data = bytes->data;
  bytes->shared = storage;
}

ScrBytes *scr_shared_wrap(ScrSharedBytes *storage) {
  ScrBytes *bytes = scr_bytes_from_external(storage->data, storage->length);
  bytes->external = false;
  bytes->shared = scr_shared_retain(storage);
  return bytes;
}

void scr_bytes_read(const ScrBytes *bytes, size_t offset, void *out, size_t length) {
  SCR_SHARED_GUARD(bytes, NULL);
  if (length) memcpy(out, bytes->data + offset, length);
}

void scr_bytes_write(ScrBytes *bytes, size_t offset, const void *data, size_t length) {
  SCR_SHARED_GUARD(bytes, NULL);
  if (length) memcpy(bytes->data + offset, data, length);
}

ScrStr *scr_bytes_string(const ScrBytes *bytes, size_t offset, size_t length) {
  SCR_SHARED_GUARD(bytes, NULL);
  return scr_str_new((const char *)bytes->data + offset, length);
}

ScrBytes *scr_bytes_snapshot(const ScrBytes *bytes) {
  if (!bytes || !bytes->shared) return NULL;
  ScrBytes *copy = scr_bytes_copy(bytes);
  copy->is_buffer = bytes->is_buffer;
  copy->is_data_view = bytes->is_data_view;
  return copy;
}

void scr_bytes_snapshot_release(ScrBytes **bytes) { scr_bytes_release(*bytes); }

ScrBytes *scr_bytes_local_copy(ScrBytes *bytes) {
  ScrBytes *copy = scr_bytes_snapshot(bytes);
  return copy ? copy : scr_bytes_retain(bytes);
}

void scr_bytes_require_unshared(const ScrBytes *bytes) {
  if (!bytes->shared) return;
  static const char message[] = "Shared byte storage cannot expose an unmanaged native pointer";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
}

static bool scr_atomics_index(ScrBytes *bytes, double index, bool waitable, size_t *out) {
  bool integer = bytes->elem == SCR_BYTES_I8 || bytes->elem == SCR_BYTES_U8 ||
    bytes->elem == SCR_BYTES_I16 || bytes->elem == SCR_BYTES_U16 ||
    bytes->elem == SCR_BYTES_I32 || bytes->elem == SCR_BYTES_U32;
  if (bytes->is_data_view || !integer || (waitable && bytes->elem != SCR_BYTES_I32)) {
    static const char message[] = "The typed array is not an integer typed array of the required kind";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  double normalized = isnan(index) ? 0 : trunc(index);
  if (!(normalized >= 0) || normalized >= (double)bytes->len) {
    static const char message[] = "Invalid atomic access index";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return false;
  }
  *out = (size_t)normalized;
  return true;
}

/* Operations: load, store, exchange, compareExchange, add, sub, and, or, xor.
 * Unsigned arithmetic avoids signed overflow; the element store supplies the
 * selected width and signedness. The lock gives one sequentially consistent
 * order shared with ordinary accesses, including overlapping DataViews. */
double scr_atomics_op(ScrBytes *bytes, double index, double value, double replacement, double operation) {
  size_t i;
  if (!scr_atomics_index(bytes, index, false, &i)) return 0;
  SCR_SHARED_GUARD(bytes, NULL);
  double previous = scr_bytes_get(bytes, (double)i);
  uint32_t before = scr_numeric_to_u32(previous), operand = scr_numeric_to_u32(value);
  uint32_t after;
  switch ((int)operation) {
  case 0: return previous;
  case 1:
    scr_bytes_set(bytes, (double)i, value);
    return isnan(value) || value == 0 ? 0 : trunc(value);
  case 2: after = operand; break;
  case 3: {
    unsigned bits = (unsigned)scr_bytes_elem_size(bytes->elem) * 8;
    uint32_t mask = bits == 32 ? UINT32_MAX : (UINT32_C(1) << bits) - 1;
    if ((before & mask) != (operand & mask)) return previous;
    after = scr_numeric_to_u32(replacement);
    break;
  }
  case 4: after = before + operand; break;
  case 5: after = before - operand; break;
  case 6: after = before & operand; break;
  case 7: after = before | operand; break;
  case 8: after = before ^ operand; break;
  default: scr_trap("scriptc: invalid atomic operation\n");
  }
  scr_bytes_set(bytes, (double)i, (double)after);
  return previous;
}

typedef struct ScrAtomicWaiter {
  ScrSharedBytes *storage;
  size_t offset;
  bool notified;
  struct ScrAtomicWaiter *next;
} ScrAtomicWaiter;
static ScrAtomicWaiter *scr_atomic_waiters;

static void scr_atomics_pause(double ms) {
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
#ifdef _WIN32
  SleepConditionVariableSRW(&scr_shared_condition, &scr_shared_mutex, (DWORD)ceil(ms), 0);
#else
  struct timespec until;
  clock_gettime(CLOCK_REALTIME, &until);
  until.tv_nsec += (long)(ms * 1000000.0);
  until.tv_sec += until.tv_nsec / 1000000000;
  until.tv_nsec %= 1000000000;
  pthread_cond_timedwait(&scr_shared_condition, &scr_shared_mutex, &until);
#endif
#else
  struct timespec duration = {(time_t)(ms / 1000), (long)(fmod(ms, 1000) * 1000000)};
  nanosleep(&duration, NULL);
#endif
}

ScrStr *scr_atomics_wait(ScrBytes *bytes, double index, double expected, double timeout) {
  size_t i;
  if (!scr_atomics_index(bytes, index, true, &i)) return NULL;
  if (!bytes->shared) {
    static const char message[] = "[object Int32Array] is not a shared typed array.";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  int32_t compare;
  uint32_t bits = scr_numeric_to_u32(expected);
  memcpy(&compare, &bits, sizeof compare);
  scr_shared_enter();
  if (scr_bytes_get(bytes, (double)i) != compare) {
    scr_shared_leave();
    return scr_str_new("not-equal", 9);
  }
  double duration = isnan(timeout) ? INFINITY : fmax(timeout, 0);
  double end = scr_perf_now() + duration;
  ScrAtomicWaiter waiter = {bytes->shared, (size_t)(bytes->data - bytes->shared->data) + i * 4, false, NULL};
  ScrAtomicWaiter **tail = &scr_atomic_waiters;
  while (*tail) tail = &(*tail)->next;
  *tail = &waiter;
  bool stopped = false;
  while (!waiter.notified) {
    double remaining = end - scr_perf_now();
    if (!(remaining > 0)) break;
    /* A bounded wait gives cooperative termination a safe cancellation point.
     * Registration and condition release share the notify lock: no wakeup can
     * fall between the expected-value check and entering the wait. */
    scr_atomics_pause(fmin(remaining, 10));
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
    scr_shared_leave();
#ifdef SCR_WORKERS
    stopped = scr_context_checkpoint();
#endif
    scr_shared_enter();
    if (stopped) break;
#endif
  }
  ScrAtomicWaiter **slot = &scr_atomic_waiters;
  while (*slot != &waiter) slot = &(*slot)->next;
  *slot = waiter.next;
  scr_shared_leave();
  return stopped ? NULL : scr_str_new(waiter.notified ? "ok" : "timed-out", waiter.notified ? 2 : 9);
}

double scr_atomics_notify(ScrBytes *bytes, double index, double count) {
  size_t i;
  if (!scr_atomics_index(bytes, index, true, &i)) return 0;
  if (!bytes->shared) return 0;
  double limit = isnan(count) ? 0 : fmax(trunc(count), 0);
  size_t offset = (size_t)(bytes->data - bytes->shared->data) + i * 4;
  double notified = 0;
  scr_shared_enter();
  for (ScrAtomicWaiter *waiter = scr_atomic_waiters; waiter && notified < limit; waiter = waiter->next) {
    if (waiter->storage == bytes->shared && waiter->offset == offset && !waiter->notified) {
      waiter->notified = true;
      notified++;
    }
  }
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
#ifdef _WIN32
  if (notified) WakeAllConditionVariable(&scr_shared_condition);
#else
  if (notified) pthread_cond_broadcast(&scr_shared_condition);
#endif
#endif
  scr_shared_leave();
  return notified;
}
