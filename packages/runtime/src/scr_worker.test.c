#undef NDEBUG
#include "scr_worker.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

enum { WORKERS = 4, MESSAGES = 16 };
static atomic_bool start;
static SCR_TL unsigned timer_calls;
static SCR_TL unsigned cleanup_calls;

static void check_cleanup(void) { cleanup_calls++; }

/* Two threads write, read and enumerate the process environment at once
 * (the SHARE_ENV shape): every access serializes on the process lock, and a
 * write never leaves a reader a torn or freed value. */
static atomic_bool race_stop;
static ScrStr *race_name, *race_value;

static void *race_reader(void *unused) {
  (void)unused;
  unsigned long seen = 0;
  while (!atomic_load_explicit(&race_stop, memory_order_relaxed)) {
    // Enumeration takes the process lock and walks environ: the crashed
    // shape. (A get opens the reader's per-thread value ring, whose cleanup
    // is a scriptc context's, so this raw pthread stays with the walk.)
    ScrArr *pairs = scr_env_pairs();
    if (pairs) {
      seen += pairs->len;
      scr_arr_release(pairs);
    }
  }
  return (void *)seen;
}

static void timer(ScrClosure *closure) {
  (void)closure;
  assert(!scr_context_is_main());
  timer_calls++;
}

static int entry(uint32_t root_id) {
  scr_init();
  scr_lib_init(0, NULL);
  assert(!scr_context_is_main());
  assert(timer_calls == 0 && cleanup_calls == 0);
  assert(scr_context_atexit(check_cleanup) == 0);
  while (!atomic_load_explicit(&start, memory_order_acquire)) sched_yield();
  ScrDyn *input = scr_worker_data();
  assert(input && !scr_exc_pending());
  assert(scr_dyn_obj_get(input, "root", 4)->v.num == root_id);
  assert(scr_dyn_obj_get(input, "self", 4) == input);
  ScrDyn *again = scr_worker_data();
  assert(input == again);
  scr_dyn_release(again);
  scr_dyn_release(input);

  for (unsigned i = 0; i < MESSAGES; i++) {
    ScrDyn *value = scr_dyn_new_num(root_id * 100 + i);
    ScrMessage *wire = scr_message_encode(value);
    scr_dyn_release(value);
    assert(wire && scr_worker_post_parent(wire));
    ScrMailEvent *reply = NULL;
    while (!(reply = scr_mailbox_take(scr_worker_inbox())))
      scr_mailbox_wait(scr_worker_inbox(), 1000);
    assert(reply->kind == SCR_WORKER_MESSAGE && reply->source == 0);
    value = scr_message_decode(reply->message);
    assert(value && value->kind == SCR_DYN_NUM && value->v.num == root_id * 100 + i);
    scr_dyn_release(value);
    scr_mail_event_free(reply);
  }
  scr_set_timeout(scr_closure_new((void *)timer, 0), 1);
  assert(!scr_loop_run(NULL) && !scr_exc_pending());
  assert(timer_calls == 1 && cleanup_calls == 0);
  return (int)root_id;
}

#if defined(__linux__)
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>

/* Worker builds grow the descriptor table at load, while the process has one
 * thread: growing it later, with threads sharing it, waits a full RCU grace
 * period on the thread that opens the next worker's mailbox. */
static void check_fd_table_reserved(void) {
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0 || (limit.rlim_cur != RLIM_INFINITY && limit.rlim_cur <= 255)) return;
  FILE *status = fopen("/proc/self/status", "r");
  assert(status);
  char line[256];
  long size = -1;
  while (fgets(line, sizeof line, status))
    if (strncmp(line, "FDSize:", 7) == 0) size = strtol(line + 7, NULL, 10);
  fclose(status);
  assert(size >= 256);
}
#endif

int main(void) {
#if defined(__linux__)
  check_fd_table_reserved();
#endif
  scr_init();
  scr_lib_init(0, NULL);
  ScrMailbox *mailbox = scr_mailbox_new();
  assert(mailbox);
  ScrWorkerThread *workers[WORKERS];
  unsigned messages[WORKERS] = {0};
  bool online[WORKERS] = {false};
  bool exited[WORKERS] = {false};
  for (unsigned i = 0; i < WORKERS; i++) {
    ScrDyn *input = scr_dyn_new_obj();
    scr_dyn_obj_set(input, "root", 4, scr_dyn_new_num(i));
    scr_dyn_obj_set(input, "self", 4, scr_dyn_retain(input));
    ScrMessage *wire = scr_message_encode(input);
    scr_dyn_release(input);
    assert(wire && !scr_exc_pending());
    ScrStr *name = scr_str_new("WorkerThread", 12);
    workers[i] = scr_worker_thread_start(entry, i, wire, false, mailbox, NULL, 0, NULL, name, 0, NULL, false);
    scr_str_release(name);
    assert(workers[i] && !scr_exc_pending());
    assert(scr_worker_thread_id(workers[i]) != 0);
  }
  /* No sender heap survives into the workerData decode. */
  scr_collect_cycles();
  atomic_store_explicit(&start, true, memory_order_release);
  unsigned exit_count = 0;
  while (exit_count != WORKERS) {
    ScrMailEvent *event = scr_mailbox_take(mailbox);
    if (!event) { scr_mailbox_wait(mailbox, 1000); continue; }
    unsigned i = 0;
    while (i < WORKERS && scr_worker_thread_id(workers[i]) != event->source) i++;
    assert(i < WORKERS && !exited[i]);
    if (event->kind == SCR_WORKER_ONLINE) {
      assert(!online[i]);
      online[i] = true;
    } else if (event->kind == SCR_WORKER_MESSAGE) {
      assert(online[i] && messages[i] < MESSAGES);
      ScrDyn *value = scr_message_decode(event->message);
      assert(value && value->kind == SCR_DYN_NUM && value->v.num == i * 100 + messages[i]);
      messages[i]++;
      ScrMessage *reply = scr_message_encode(value);
      scr_dyn_release(value);
      assert(reply && scr_worker_thread_post(workers[i], reply));
    } else {
      assert(event->kind == SCR_WORKER_EXIT && event->code == (int)i);
      assert(online[i] && messages[i] == MESSAGES);
      exited[i] = true;
      exit_count++;
      scr_worker_thread_join(workers[i]);
      scr_worker_thread_join(workers[i]);
      ScrMessage *late = scr_message_encode(scr_dyn_undefined());
      assert(late && !scr_worker_thread_post(workers[i], late));
    }
    scr_mail_event_free(event);
  }
  for (unsigned i = 0; i < WORKERS; i++) scr_worker_thread_release(workers[i]);
  scr_mailbox_release(mailbox);
  assert(timer_calls == 0 && cleanup_calls == 0 && scr_context_is_main());
  /* The process-environment lock is reentrant for its owner: a locked read
   * allocates, and the allocator's own environment reads must not deadlock
   * on the lock they are already inside. */
  scr_context_env_process_lock();
  scr_context_env_process_lock();
  /* An enumeration allocates under the lock, and the allocator reads its
   * tunables through the accessor; the accessor itself must use the reentrant
   * lock rather than acquire the mutex again. */
  ScrArr *pairs_under_lock = scr_env_pairs();
  assert(pairs_under_lock != NULL);
  scr_arr_release(pairs_under_lock);
  const char *path_atom = scr_context_getenv("PATH");
  (void)path_atom;
  scr_context_env_process_unlock();
  scr_context_env_process_unlock();
  /* The shared-environment race the corpus program exercises: 20k writes
   * with a reader enumerating alongside. */
  race_name = scr_str_new("SCRIPTC_TEST_RACE", 17);
  race_value = scr_str_new("value", 5);
  pthread_t race_thread;
  assert(pthread_create(&race_thread, NULL, race_reader, NULL) == 0);
  for (int i = 0; i < 20000; i++) scr_env_set(race_name, race_value);
  atomic_store_explicit(&race_stop, true, memory_order_relaxed);
  assert(pthread_join(race_thread, NULL) == 0);
  ScrStr *race_final = scr_env_get(race_name);
  assert(race_final && race_final->len == 5 && memcmp(race_final->data, "value", 5) == 0);
  scr_str_release(race_final);
  scr_env_unset(race_name);
  scr_str_release(race_name);
  scr_str_release(race_value);
  scr_context_cleanup();
  puts("worker threads isolate heaps, exchange messages and publish ordered exits");
}
