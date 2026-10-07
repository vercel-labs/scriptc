#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>

enum { THREADS = 4, INCREMENTS = 10000 };
static atomic_uint ready;
static atomic_bool cancel_wait;
typedef struct { ScrSharedBytes *storage; unsigned id; bool waiting; } Task;

static void *run(void *ptr) {
  Task *task = ptr;
  scr_context_enter(task->id);
  scr_init();
  scr_lib_init(0, NULL);
  ScrBytes *storage = scr_shared_wrap(task->storage);
  scr_shared_release(task->storage);
  ScrBytes *values = scr_bytes_buffer_view(storage, SCR_BYTES_I32, 4, true, 2);
  ScrBytes *view = scr_dataview_new(storage, 12, true, 4);
  atomic_fetch_add_explicit(&ready, 1, memory_order_release);
  if (task->waiting) {
    scr_context_stop_flag(&cancel_wait);
    ScrStr *result = scr_atomics_wait(values, 0, 0, INFINITY);
    if (task->id == 1) {
      assert(result && result->len == 2 && !memcmp(result->data, "ok", 2));
      scr_str_release(result);
    } else assert(!result && scr_context_stopping());
  } else {
    while (atomic_load_explicit(&ready, memory_order_acquire) != THREADS) sched_yield();
    for (unsigned i = 0; i < INCREMENTS; i++) {
      scr_atomics_op(values, 0, 1, 0, 4);
      /* These accesses overlap the same shared address with different view
       * metadata. Non-atomic JS accesses must still be C data-race-free. */
      scr_dataview_set(view, 0, 0x12345678, SCR_DV_U32, true);
      assert(scr_dataview_get(view, 0, SCR_DV_U32, true) == 0x12345678);
      scr_bytes_set(values, 1, -7);
      assert(scr_bytes_get(values, 1) == -7);
      if (i % 100 == 0) {
        ScrBytes *copy = scr_bytes_local_copy(storage);
        assert(!copy->shared && copy->data != storage->data && copy->len == storage->len);
        scr_bytes_release(copy);
        ScrStr *text = scr_bytes_string(storage, 0, storage->len);
        assert(text->len == storage->len);
        scr_str_release(text);
      }
    }
  }
  scr_bytes_release(values);
  scr_bytes_release(view);
  scr_bytes_release(storage);
  scr_context_cleanup();
  return NULL;
}

int main(void) {
  scr_init();
  scr_lib_init(0, NULL);
  ScrBytes *storage = scr_bytes_new(SCR_BYTES_U8, 16);
  scr_bytes_make_shared(storage);
  ScrBytes *values = scr_bytes_buffer_view(storage, SCR_BYTES_I32, 4, true, 2);
  scr_bytes_require_unshared(values);
  assert(scr_exc_pending());
  scr_exc_clear();
  ScrBytes *local = scr_bytes_new(SCR_BYTES_U8, 2);
  ScrBytes *retained = scr_bytes_local_copy(local);
  assert(retained == local);
  scr_bytes_require_unshared(local);
  assert(!scr_exc_pending());
  scr_bytes_release(retained);
  scr_bytes_release(local);
  pthread_t threads[THREADS];
  Task tasks[THREADS];
  for (unsigned i = 0; i < THREADS; i++) {
    tasks[i] = (Task){scr_shared_retain(storage->shared), i + 1, false};
    assert(!pthread_create(&threads[i], NULL, run, &tasks[i]));
  }
  for (unsigned i = 0; i < THREADS; i++) assert(!pthread_join(threads[i], NULL));
  assert(scr_bytes_get(values, 0) == THREADS * INCREMENTS);
  assert(scr_atomics_op(values, 0, 3.9, 0, 1) == 3);
  assert(scr_atomics_op(values, 0, 3, 0xffffffff, 3) == 3);
  assert(scr_atomics_op(values, 0, 0, 0, 0) == -1);
  assert(scr_atomics_op(values, 0, 0, 0, 2) == -1);
  ScrStr *status = scr_atomics_wait(values, 0, 1, INFINITY);
  assert(status && !strcmp(status->data, "not-equal"));
  scr_str_release(status);
  status = scr_atomics_wait(values, 0, 0, 0);
  assert(status && !strcmp(status->data, "timed-out"));
  scr_str_release(status);

  tasks[0] = (Task){scr_shared_retain(storage->shared), 1, true};
  assert(!pthread_create(&threads[0], NULL, run, &tasks[0]));
  double deadline = scr_perf_now() + 5000;
  while (scr_atomics_notify(values, 0, 1) == 0) {
    assert(scr_perf_now() < deadline);
    sched_yield();
  }
  assert(!pthread_join(threads[0], NULL));
  assert(scr_atomics_notify(values, 0, INFINITY) == 0);

  tasks[0] = (Task){scr_shared_retain(storage->shared), 2, true};
  assert(!pthread_create(&threads[0], NULL, run, &tasks[0]));
  atomic_store_explicit(&cancel_wait, true, memory_order_relaxed);
  assert(!pthread_join(threads[0], NULL));
  assert(scr_atomics_notify(values, 0, INFINITY) == 0);
  scr_bytes_release(values);
  scr_bytes_release(storage);
  scr_context_cleanup();
  puts("shared views preserve atomic updates, wait queues and cancellation ownership");
}
