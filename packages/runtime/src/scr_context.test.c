#undef NDEBUG
#include "scr_async.c"
#include <assert.h>
#include <sched.h>
#include <stdatomic.h>

enum { CONTEXTS = 4, REQUESTS = 64 };
static atomic_uint started;
static SCR_TL unsigned completed;
static SCR_TL unsigned destroyed;
static SCR_TL unsigned cleanup_order;
static SCR_TL unsigned timer_calls;

typedef struct Work {
  uint64_t owner;
  unsigned input;
  unsigned result;
  ScrStr *text;
  bool deliver;
} Work;

static void run_work(void *data) {
  Work *work = data;
  work->result = work->input * 7 + 3;
}

static void deliver_work(void *data) {
  Work *work = data;
  assert(work->deliver);
  assert(scr_context_thread_id() == work->owner);
  assert(work->result == work->input * 7 + 3);
  completed++;
}

static void destroy_work(void *data) {
  Work *work = data;
  assert(scr_context_thread_id() == work->owner);
  scr_str_release(work->text);
  destroyed++;
  free(work);
}

static void submit_work(unsigned input, bool deliver) {
  Work *work = malloc(sizeof(*work));
  assert(work);
  *work = (Work){scr_context_thread_id(), input, 0, scr_str_new("owned", 5), deliver};
  scr_work_submit(work, run_work, deliver_work, destroy_work);
}

static void timer(ScrClosure *closure) {
  (void)closure;
  timer_calls++;
}

static void cleanup_first(void) {
  assert(cleanup_order == 2);
  cleanup_order = 3;
}

static void cleanup_inserted(void) {
  assert(cleanup_order == 1);
  cleanup_order = 2;
}

static void cleanup_second(void) {
  assert(cleanup_order == 0);
  cleanup_order = 1;
  assert(scr_context_atexit(cleanup_inserted) == 0);
}

static void *run_context(void *data) {
  uint64_t id = (uintptr_t)data;
  scr_context_enter(id);
  assert(!scr_context_is_main());
  scr_init();
  scr_lib_init(0, NULL);
  assert(scr_context_atexit(cleanup_first) == 0);
  assert(scr_context_atexit(cleanup_second) == 0);

  /* Leave a distinct exception pending while every context is active. */
  scr_throw_f64((double)id);
  atomic_fetch_add_explicit(&started, 1, memory_order_release);
  while (atomic_load_explicit(&started, memory_order_acquire) != CONTEXTS) sched_yield();
  ScrCaught *caught = scr_exc_take();
  assert(caught && caught->kind == SCR_EXC_F64 && caught->f64 == (double)id);
  scr_caught_release(caught);

  for (unsigned i = 0; i < REQUESTS; i++) submit_work(i, true);
  ScrClosure *callback = scr_closure_new((void *)timer, 0);
  scr_set_timeout(callback, 1);
  assert(!scr_loop_run(NULL));
  assert(!scr_exc_pending());
  assert(completed == REQUESTS && destroyed == REQUESTS && timer_calls == 1);

  /* Teardown must wait for borrowed native work, release it on its owner,
   * and suppress its script callback. It must not stop another context. */
  submit_work(REQUESTS, false);
  scr_context_cleanup();
  assert(destroyed == REQUESTS + 1 && completed == REQUESTS);
  assert(cleanup_order == 3);
  scr_context_cleanup();
  assert(cleanup_order == 3);
  return NULL;
}

int main(void) {
  scr_init();
  scr_lib_init(0, NULL);
  pthread_t threads[CONTEXTS];
  for (uintptr_t i = 0; i < CONTEXTS; i++)
    assert(pthread_create(&threads[i], NULL, run_context, (void *)(i + 1)) == 0);
  for (unsigned i = 0; i < CONTEXTS; i++) assert(pthread_join(threads[i], NULL) == 0);
  assert(scr_context_is_main());
  assert(!scr_exc_pending());
  assert(completed == 0 && destroyed == 0 && timer_calls == 0);
  scr_context_cleanup();
  puts("runtime contexts keep completions, timers, exceptions and cleanup isolated");
}
