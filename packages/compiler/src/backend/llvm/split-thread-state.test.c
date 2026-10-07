#undef NDEBUG
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

_Thread_local int64_t foreign = 13;
extern void set_owner(int64_t owner);
extern int64_t get_owner(void);
extern int64_t next_value(void);

enum { THREADS = 4, ITERATIONS = 10000 };
static atomic_uint ready;

static void *run(void *argument) {
  int64_t id = (int64_t)(uintptr_t)argument;
  assert(get_owner() == 0);
  set_owner(id);
  atomic_fetch_add_explicit(&ready, 1, memory_order_release);
  while (atomic_load_explicit(&ready, memory_order_acquire) != THREADS) sched_yield();
  for (int64_t i = 0; i < ITERATIONS; i++) {
    assert(get_owner() == id);
    assert(next_value() == 20 + 2 * i);
    if (i % 64 == 0) sched_yield();
  }
  assert(foreign == 13 + ITERATIONS);
  return NULL;
}

int main(void) {
  pthread_t threads[THREADS];
  for (uintptr_t i = 0; i < THREADS; i++)
    assert(pthread_create(&threads[i], NULL, run, (void *)(i + 1)) == 0);
  for (unsigned i = 0; i < THREADS; i++) assert(pthread_join(threads[i], NULL) == 0);
  assert(get_owner() == 0 && next_value() == 20 && foreign == 14);
  puts("thread state stays isolated across compiled partitions");
}
