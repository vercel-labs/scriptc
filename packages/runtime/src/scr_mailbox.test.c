#undef NDEBUG
#include "scr_mailbox.h"
#include <assert.h>
#include <math.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

enum { PRODUCERS = 4, EVENTS = 4096 };
typedef struct {
  ScrMailbox *mailbox;
  unsigned source;
} Producer;
static atomic_uint waiting;
static atomic_bool closed;

static ScrMailEvent *make_event(unsigned source, int code) {
  ScrMailEvent *event = calloc(1, sizeof(*event));
  assert(event);
  event->source = source;
  event->code = code;
  return event;
}

static void *produce(void *data) {
  Producer *producer = data;
  for (int i = 0; i < EVENTS; i++)
    assert(scr_mailbox_post(producer->mailbox, make_event(producer->source, i)));
  scr_mailbox_release(producer->mailbox);
  return NULL;
}

static void *post_after_close(void *data) {
  ScrMailbox *mailbox = data;
  atomic_fetch_add_explicit(&waiting, 1, memory_order_release);
  while (!atomic_load_explicit(&closed, memory_order_acquire)) sched_yield();
  scr_mailbox_wait(mailbox, INFINITY);
  assert(!scr_mailbox_post(mailbox, make_event(0, 1)));
  scr_mailbox_release(mailbox);
  return NULL;
}

int main(void) {
  scr_init();
  ScrMailbox *mailbox = scr_mailbox_new();
  assert(mailbox && !scr_exc_pending());
  assert(!scr_mailbox_pending(mailbox));
  pthread_t threads[PRODUCERS];
  Producer producers[PRODUCERS];
  for (unsigned i = 0; i < PRODUCERS; i++) {
    producers[i] = (Producer){scr_mailbox_retain(mailbox), i};
    assert(pthread_create(&threads[i], NULL, produce, &producers[i]) == 0);
  }
  for (unsigned i = 0; i < PRODUCERS; i++) assert(pthread_join(threads[i], NULL) == 0);

  /* Filling before draining exercises coalesced wakeups and a full pipe.
   * Per-producer order must survive arbitrary cross-producer interleaving. */
  int next[PRODUCERS] = {0};
  struct pollfd ready = {scr_mailbox_pollfd(mailbox), POLLIN, 0};
  for (unsigned i = 0; i < PRODUCERS * EVENTS; i++) {
    assert(scr_mailbox_pending(mailbox));
    assert(poll(&ready, 1, 0) == 1 && (ready.revents & POLLIN));
    ScrMailEvent *event = scr_mailbox_take(mailbox);
    assert(event && event->source < PRODUCERS && event->next == NULL);
    assert(event->code == next[event->source]++);
    scr_mail_event_free(event);
  }
  assert(!scr_mailbox_pending(mailbox));
  assert(!scr_mailbox_take(mailbox));
  assert(poll(&ready, 1, 0) == 0);

  /* Closing before a waiter starts sleeping must also wake it. Drop the
   * creator's reference while producers retain the mailbox independently. */
  for (unsigned i = 0; i < PRODUCERS; i++)
    assert(pthread_create(&threads[i], NULL, post_after_close, scr_mailbox_retain(mailbox)) == 0);
  while (atomic_load_explicit(&waiting, memory_order_acquire) != PRODUCERS) sched_yield();
  scr_mailbox_close(mailbox);
  scr_mailbox_release(mailbox);
  atomic_store_explicit(&closed, true, memory_order_release);
  for (unsigned i = 0; i < PRODUCERS; i++) assert(pthread_join(threads[i], NULL) == 0);
  scr_context_cleanup();
  puts("mailboxes preserve concurrent FIFO delivery, wakeups and close ownership");
}
