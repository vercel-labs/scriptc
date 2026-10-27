/* Shared storage is neutral: only its backing allocation and synchronization
 * cross contexts. ScrBytes wrappers and their reference counts remain local.
 * Every access to shared bytes is atomic: Atomics operations as sequentially
 * consistent instructions, other element and bulk accesses as relaxed ones
 * (scr_shared_load, scr_shared_store). No lock orders them. */
#include "scr_runtime.h"
#include "scr_numeric.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

void scr_shared_load(void *dst, const void *src, size_t n) {
  uint8_t *out = dst;
  const uint8_t *in = src;
  for (; n && ((uintptr_t)in & 7); n--) *out++ = __atomic_load_n(in++, __ATOMIC_RELAXED);
  for (; n >= 8; n -= 8, in += 8, out += 8) {
    uint64_t word = __atomic_load_n((const uint64_t *)(const void *)in, __ATOMIC_RELAXED);
    memcpy(out, &word, 8);
  }
  for (; n; n--) *out++ = __atomic_load_n(in++, __ATOMIC_RELAXED);
}

void scr_shared_store(void *dst, const void *src, size_t n) {
  uint8_t *out = dst;
  const uint8_t *in = src;
  for (; n && ((uintptr_t)out & 7); n--) __atomic_store_n(out++, *in++, __ATOMIC_RELAXED);
  for (; n >= 8; n -= 8, in += 8, out += 8) {
    uint64_t word;
    memcpy(&word, in, 8);
    __atomic_store_n((uint64_t *)(void *)out, word, __ATOMIC_RELAXED);
  }
  for (; n; n--) __atomic_store_n(out++, *in++, __ATOMIC_RELAXED);
}

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
  if (!length) return;
  if (bytes->shared) scr_shared_load(out, bytes->data + offset, length);
  else memcpy(out, bytes->data + offset, length);
}

void scr_bytes_write(ScrBytes *bytes, size_t offset, const void *data, size_t length) {
  if (!length) return;
  if (bytes->shared) scr_shared_store(bytes->data + offset, data, length);
  else memcpy(bytes->data + offset, data, length);
}

ScrStr *scr_bytes_string(const ScrBytes *bytes, size_t offset, size_t length) {
  if (!bytes->shared) return scr_str_new((const char *)bytes->data + offset, length);
  char *copy = malloc(length ? length : 1);
  if (!copy) scr_trap("scriptc: out of memory\n");
  scr_shared_load(copy, bytes->data + offset, length);
  ScrStr *text = scr_str_new(copy, length);
  free(copy);
  return text;
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

/* Atomics operations are single atomic instructions on the element, with
 * sequentially consistent ordering (ECMA-262 Atomics), and take no lock.
 * Operands arrive as the element type's ToUint32 residue; unsigned
 * arithmetic wraps at the element width. Each returns the element's
 * previous bits. */
#define SCR_ATOMICS_RMW(type)                                                                     \
  static type scr_atomics_rmw_##type(type *p, int operation, type operand, type replacement) {   \
    switch (operation) {                                                                          \
    case 0: return __atomic_load_n(p, __ATOMIC_SEQ_CST);                                          \
    case 2: return __atomic_exchange_n(p, operand, __ATOMIC_SEQ_CST);                             \
    case 3: {                                                                                     \
      type expected = operand;                                                                    \
      /* A failed exchange leaves the current value in expected. */                               \
      __atomic_compare_exchange_n(p, &expected, replacement, false, __ATOMIC_SEQ_CST,             \
                                  __ATOMIC_SEQ_CST);                                              \
      return expected;                                                                            \
    }                                                                                             \
    case 4: return __atomic_fetch_add(p, operand, __ATOMIC_SEQ_CST);                              \
    case 5: return __atomic_fetch_sub(p, operand, __ATOMIC_SEQ_CST);                              \
    case 6: return __atomic_fetch_and(p, operand, __ATOMIC_SEQ_CST);                              \
    case 7: return __atomic_fetch_or(p, operand, __ATOMIC_SEQ_CST);                               \
    case 8: return __atomic_fetch_xor(p, operand, __ATOMIC_SEQ_CST);                              \
    }                                                                                             \
    scr_trap("scriptc: invalid atomic operation\n");                                              \
  }
SCR_ATOMICS_RMW(uint8_t)
SCR_ATOMICS_RMW(uint16_t)
SCR_ATOMICS_RMW(uint32_t)

/* Operations: load, store, exchange, compareExchange, add, sub, and, or, xor. */
double scr_atomics_op(ScrBytes *bytes, double index, double value, double replacement, double operation) {
  size_t i;
  if (!scr_atomics_index(bytes, index, false, &i)) return 0;
  int op = (int)operation;
  uint32_t operand = scr_numeric_to_u32(value), swap = scr_numeric_to_u32(replacement);
  uint8_t *p = bytes->data + i * scr_bytes_elem_size(bytes->elem);
  uint32_t previous = 0;
  switch (scr_bytes_elem_size(bytes->elem)) {
  case 1:
    if (op == 1) __atomic_store_n(p, (uint8_t)operand, __ATOMIC_SEQ_CST);
    else previous = scr_atomics_rmw_uint8_t(p, op, (uint8_t)operand, (uint8_t)swap);
    break;
  case 2:
    if (op == 1) __atomic_store_n((uint16_t *)p, (uint16_t)operand, __ATOMIC_SEQ_CST);
    else previous = scr_atomics_rmw_uint16_t((uint16_t *)p, op, (uint16_t)operand, (uint16_t)swap);
    break;
  default:
    if (op == 1) __atomic_store_n((uint32_t *)p, operand, __ATOMIC_SEQ_CST);
    else previous = scr_atomics_rmw_uint32_t((uint32_t *)p, op, operand, swap);
    break;
  }
  /* store answers ToIntegerOrInfinity of the value, not the stored element
   * (NaN and both zeros, including a truncated -0.5, are +0). */
  if (op == 1) {
    double whole = trunc(value);
    return isnan(whole) || whole == 0 ? 0 : whole;
  }
  switch (bytes->elem) {
  case SCR_BYTES_I8: return (double)(int8_t)previous;
  case SCR_BYTES_I16: return (double)(int16_t)previous;
  case SCR_BYTES_I32: return (double)(int32_t)previous;
  default: return (double)previous;
  }
}

/* Waiters queue per bucket, chosen by storage and byte offset. A bucket's
 * lock orders a wait's value check and registration against notify for the
 * same location; other Atomics operations never take it. */
typedef struct ScrAtomicWaiter {
  ScrSharedBytes *storage;
  size_t offset;
  bool notified;
  struct ScrAtomicWaiter *next;
} ScrAtomicWaiter;

#define SCR_WAIT_BUCKETS 64
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
#define SCR_WAIT_THREADS 1
#endif

typedef struct ScrWaitBucket {
#ifdef SCR_WAIT_THREADS
#ifdef _WIN32
  SRWLOCK lock;
  CONDITION_VARIABLE condition;
#else
  pthread_mutex_t lock;
  pthread_cond_t condition;
#endif
#endif
  ScrAtomicWaiter *waiters;
} ScrWaitBucket;

static ScrWaitBucket scr_wait_buckets[SCR_WAIT_BUCKETS];
#if defined(SCR_WAIT_THREADS) && !defined(_WIN32)
static pthread_once_t scr_wait_once = PTHREAD_ONCE_INIT;
static void scr_wait_init(void) {
  for (size_t b = 0; b < SCR_WAIT_BUCKETS; b++) {
    pthread_mutex_init(&scr_wait_buckets[b].lock, NULL);
    pthread_cond_init(&scr_wait_buckets[b].condition, NULL);
  }
}
#endif

/* Locked bucket for a location (SRWLOCK and CONDITION_VARIABLE are valid
 * when zero-initialized). */
static ScrWaitBucket *scr_wait_lock(ScrSharedBytes *storage, size_t offset) {
  uintptr_t key = (uintptr_t)storage ^ (uintptr_t)(offset / 4) * 0x9E3779B1u;
  ScrWaitBucket *bucket = &scr_wait_buckets[(key ^ (key >> 7)) % SCR_WAIT_BUCKETS];
#ifdef SCR_WAIT_THREADS
#ifdef _WIN32
  AcquireSRWLockExclusive(&bucket->lock);
#else
  pthread_once(&scr_wait_once, scr_wait_init);
  pthread_mutex_lock(&bucket->lock);
#endif
#endif
  return bucket;
}

static void scr_wait_unlock(ScrWaitBucket *bucket) {
#ifdef SCR_WAIT_THREADS
#ifdef _WIN32
  ReleaseSRWLockExclusive(&bucket->lock);
#else
  pthread_mutex_unlock(&bucket->lock);
#endif
#else
  (void)bucket;
#endif
}

/* Sleep up to ms with the bucket locked; returns with it locked. */
static void scr_atomics_pause(ScrWaitBucket *bucket, double ms) {
#ifdef SCR_WAIT_THREADS
#ifdef _WIN32
  SleepConditionVariableSRW(&bucket->condition, &bucket->lock, (DWORD)ceil(ms), 0);
#else
  struct timespec until;
  clock_gettime(CLOCK_REALTIME, &until);
  until.tv_nsec += (long)(ms * 1000000.0);
  until.tv_sec += until.tv_nsec / 1000000000;
  until.tv_nsec %= 1000000000;
  pthread_cond_timedwait(&bucket->condition, &bucket->lock, &until);
#endif
#else
  (void)bucket;
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
  size_t offset = (size_t)(bytes->data - bytes->shared->data) + i * 4;
  int32_t *cell = (int32_t *)(bytes->data + i * 4);
  ScrWaitBucket *bucket = scr_wait_lock(bytes->shared, offset);
  /* Under the bucket lock, a notify for this location cannot fall between
   * this check and the registration below. */
  if (__atomic_load_n(cell, __ATOMIC_SEQ_CST) != compare) {
    scr_wait_unlock(bucket);
    return scr_str_new("not-equal", 9);
  }
  double duration = isnan(timeout) ? INFINITY : fmax(timeout, 0);
  double end = scr_perf_now() + duration;
  ScrAtomicWaiter waiter = {bytes->shared, offset, false, NULL};
  ScrAtomicWaiter **tail = &bucket->waiters;
  while (*tail) tail = &(*tail)->next;
  *tail = &waiter;
  bool stopped = false;
  while (!waiter.notified) {
    double remaining = end - scr_perf_now();
    if (!(remaining > 0)) break;
    /* A bounded wait gives cooperative termination a safe cancellation point. */
    scr_atomics_pause(bucket, fmin(remaining, 10));
#ifdef SCR_WORKERS
    scr_wait_unlock(bucket);
    stopped = scr_context_checkpoint();
    bucket = scr_wait_lock(bytes->shared, offset);
    if (stopped) break;
#endif
  }
  ScrAtomicWaiter **slot = &bucket->waiters;
  while (*slot != &waiter) slot = &(*slot)->next;
  *slot = waiter.next;
  scr_wait_unlock(bucket);
  return stopped ? NULL : scr_str_new(waiter.notified ? "ok" : "timed-out", waiter.notified ? 2 : 9);
}

double scr_atomics_notify(ScrBytes *bytes, double index, double count) {
  size_t i;
  if (!scr_atomics_index(bytes, index, true, &i)) return 0;
  if (!bytes->shared) return 0;
  double limit = isnan(count) ? 0 : fmax(trunc(count), 0);
  size_t offset = (size_t)(bytes->data - bytes->shared->data) + i * 4;
  double notified = 0;
  ScrWaitBucket *bucket = scr_wait_lock(bytes->shared, offset);
  /* Waiters are woken in the order they arrived (ECMA-262 WaiterList). */
  for (ScrAtomicWaiter *waiter = bucket->waiters; waiter && notified < limit; waiter = waiter->next) {
    if (waiter->storage == bytes->shared && waiter->offset == offset && !waiter->notified) {
      waiter->notified = true;
      notified++;
    }
  }
#ifdef SCR_WAIT_THREADS
#ifdef _WIN32
  if (notified) WakeAllConditionVariable(&bucket->condition);
#else
  if (notified) pthread_cond_broadcast(&bucket->condition);
#endif
#endif
  scr_wait_unlock(bucket);
  return notified;
}

/* V8's text for a value in the TypeErrors below: a typed array as
 * [object Int8Array] and so on, an array as [object Array], an ArrayBuffer
 * or other native object as #<Class>, an object as #<Constructor>, and
 * other values as String() gives them (undefined and null by name). */
static ScrStr *scr_atomics_value_text(const ScrDyn *value) {
  char text[64];
  int n;
  if (value->kind == SCR_DYN_BYTES) {
    if (value->v.bytes->is_data_view) n = snprintf(text, sizeof text, "#<DataView>");
    else n = snprintf(text, sizeof text, "[object %s]", scr_bytes_elem_name(value->v.bytes->elem));
  } else if (value->kind == SCR_DYN_ARR) {
    n = snprintf(text, sizeof text, "[object Array]");
  } else if (value->kind == SCR_DYN_HANDLE) {
    n = snprintf(text, sizeof text, "#<%s>", scr_dyn_handle_ops_of(value)->cls);
  } else if (value->kind == SCR_DYN_OBJ) {
    const char *name = scr_dyn_class_name(value);
    n = snprintf(text, sizeof text, "#<%s>", name ? name : "Object");
  } else if (value->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_class_name(value)) {
    const ScrStr *name = scr_dyn_typed_ref_class_name(value);
    n = snprintf(text, sizeof text, "#<%.*s>", (int)name->len, (const char *)name->data);
  } else if (value->kind == SCR_DYN_UNDEF) {
    n = snprintf(text, sizeof text, "undefined");
  } else if (value->kind == SCR_DYN_NULL) {
    n = snprintf(text, sizeof text, "null");
  } else {
    return scr_dyn_to_string(value, NULL);
  }
  return scr_str_new(text, n < (int)sizeof text ? (size_t)n : sizeof text - 1);
}

/* The integer typed array an untyped Atomics argument holds, or NULL with
 * Node's TypeError pending. `waitable` requires an Int32Array, as wait and
 * notify do. */
static ScrBytes *scr_atomics_dyn_array(const ScrDyn *value, bool waitable) {
  if (value->kind == SCR_DYN_BYTES && !value->v.bytes->is_data_view) {
    ScrBytesElem elem = value->v.bytes->elem;
    bool integer = elem == SCR_BYTES_I8 || elem == SCR_BYTES_U8 || elem == SCR_BYTES_I16 ||
      elem == SCR_BYTES_U16 || elem == SCR_BYTES_I32 || elem == SCR_BYTES_U32;
    if (waitable ? elem == SCR_BYTES_I32 : integer) return value->v.bytes;
  }
  ScrStr *shown = scr_atomics_value_text(value);
  if (!shown) return NULL;
  const char *tail = waitable ? " is not an int32 or BigInt64 typed array." : " is not an integer typed array.";
  ScrStr *parts[2] = {shown, scr_str_new(tail, strlen(tail))};
  ScrStr *message = scr_str_concat_parts(parts, 2);
  scr_str_release(parts[0]);
  scr_str_release(parts[1]);
  scr_throw_error(SCR_ERR_TYPE, message);
  return NULL;
}

double scr_atomics_op_dyn(const ScrDyn *array, double index, double value, double replacement, double operation) {
  ScrBytes *bytes = scr_atomics_dyn_array(array, false);
  return bytes ? scr_atomics_op(bytes, index, value, replacement, operation) : 0;
}

ScrStr *scr_atomics_wait_dyn(const ScrDyn *array, double index, double expected, double timeout) {
  ScrBytes *bytes = scr_atomics_dyn_array(array, true);
  return bytes ? scr_atomics_wait(bytes, index, expected, timeout) : NULL;
}

double scr_atomics_notify_dyn(const ScrDyn *array, double index, double count) {
  ScrBytes *bytes = scr_atomics_dyn_array(array, true);
  return bytes ? scr_atomics_notify(bytes, index, count) : 0;
}
