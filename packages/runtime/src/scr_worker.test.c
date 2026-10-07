#undef NDEBUG
#include "scr_worker.h"
#include <assert.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>

enum { WORKERS = 4, MESSAGES = 16 };
static atomic_bool start;
static SCR_TL unsigned timer_calls;
static SCR_TL unsigned cleanup_calls;

static void check_cleanup(void) { cleanup_calls++; }

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

int main(void) {
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
    workers[i] = scr_worker_thread_start(entry, i, wire, mailbox, NULL);
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
  scr_context_cleanup();
  puts("worker threads isolate heaps, exchange messages and publish ordered exits");
}
