#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE 1
#endif
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#include "scr_mailbox.h"

#include <errno.h>
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#endif

struct ScrMailbox {
  atomic_size_t references;
  ScrMailEvent *head;
  ScrMailEvent **tail;
  bool closed;
#ifdef _WIN32
  SRWLOCK lock;
  CONDITION_VARIABLE condition;
#else
  pthread_mutex_t lock;
  pthread_cond_t condition;
  int read_fd;
  int write_fd;
#endif
};

static void scr_mailbox_lock(ScrMailbox *mailbox) {
#ifdef _WIN32
  AcquireSRWLockExclusive(&mailbox->lock);
#else
  (void)pthread_mutex_lock(&mailbox->lock);
#endif
}

static void scr_mailbox_unlock(ScrMailbox *mailbox) {
#ifdef _WIN32
  ReleaseSRWLockExclusive(&mailbox->lock);
#else
  (void)pthread_mutex_unlock(&mailbox->lock);
#endif
}

static void scr_mailbox_signal(ScrMailbox *mailbox) {
#ifdef _WIN32
  WakeAllConditionVariable(&mailbox->condition);
#else
  unsigned char byte = 1;
  /* Nonblocking wakeups coalesce when the pipe is full. The protected
   * queue is authoritative, so a full pipe cannot lose a message. */
  ssize_t written;
  do { written = write(mailbox->write_fd, &byte, 1); } while (written < 0 && errno == EINTR);
  (void)pthread_cond_broadcast(&mailbox->condition);
#endif
}

static void scr_mailbox_drain(ScrMailbox *mailbox) {
#ifndef _WIN32
  unsigned char bytes[128];
  ssize_t count;
  do { count = read(mailbox->read_fd, bytes, sizeof bytes); }
  while (count > 0 || (count < 0 && errno == EINTR));
#else
  (void)mailbox;
#endif
}

ScrMailbox *scr_mailbox_new(void) {
  ScrMailbox *mailbox = calloc(1, sizeof(*mailbox));
  if (!mailbox) scr_trap("scriptc: out of memory\n");
  atomic_init(&mailbox->references, 1);
  mailbox->tail = &mailbox->head;
#ifdef _WIN32
  InitializeSRWLock(&mailbox->lock);
  InitializeConditionVariable(&mailbox->condition);
#else
  int pipe_fd[2];
  if (pipe(pipe_fd) != 0) goto failed;
  mailbox->read_fd = pipe_fd[0];
  mailbox->write_fd = pipe_fd[1];
  if (fcntl(pipe_fd[0], F_SETFL, O_NONBLOCK) < 0 ||
      fcntl(pipe_fd[1], F_SETFL, O_NONBLOCK) < 0 ||
      fcntl(pipe_fd[0], F_SETFD, FD_CLOEXEC) < 0 ||
      fcntl(pipe_fd[1], F_SETFD, FD_CLOEXEC) < 0) goto failed_pipe;
  if (pthread_mutex_init(&mailbox->lock, NULL) != 0) goto failed_pipe;
  pthread_condattr_t attributes;
  if (pthread_condattr_init(&attributes) != 0) goto failed_lock;
#if !defined(__APPLE__)
  if (pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC) != 0) {
    pthread_condattr_destroy(&attributes);
    goto failed_lock;
  }
#endif
  int error = pthread_cond_init(&mailbox->condition, &attributes);
  pthread_condattr_destroy(&attributes);
  if (error != 0) goto failed_lock;
#endif
  return mailbox;
#ifndef _WIN32
failed_lock:
  pthread_mutex_destroy(&mailbox->lock);
failed_pipe:
  close(pipe_fd[0]);
  close(pipe_fd[1]);
failed:
  free(mailbox);
  static const char message[] = "Could not create worker message channel";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_WORKER_INIT_FAILED");
  return NULL;
#endif
}

ScrMailbox *scr_mailbox_retain(ScrMailbox *mailbox) {
  atomic_fetch_add_explicit(&mailbox->references, 1, memory_order_relaxed);
  return mailbox;
}

void scr_mail_event_free(ScrMailEvent *event) {
  if (!event) return;
  scr_message_free(event->message);
  free(event->data);
  free(event);
}

void scr_mailbox_release(ScrMailbox *mailbox) {
  if (!mailbox || atomic_fetch_sub_explicit(&mailbox->references, 1, memory_order_acq_rel) != 1) return;
  while (mailbox->head) {
    ScrMailEvent *event = mailbox->head;
    mailbox->head = event->next;
    scr_mail_event_free(event);
  }
#ifndef _WIN32
  pthread_cond_destroy(&mailbox->condition);
  pthread_mutex_destroy(&mailbox->lock);
  close(mailbox->read_fd);
  close(mailbox->write_fd);
#endif
  free(mailbox);
}

bool scr_mailbox_post(ScrMailbox *mailbox, ScrMailEvent *event) {
  scr_mailbox_lock(mailbox);
  if (mailbox->closed) {
    scr_mailbox_unlock(mailbox);
    scr_mail_event_free(event);
    return false;
  }
  event->next = NULL;
  *mailbox->tail = event;
  mailbox->tail = &event->next;
  scr_mailbox_signal(mailbox);
  scr_mailbox_unlock(mailbox);
  return true;
}

ScrMailEvent *scr_mailbox_take(ScrMailbox *mailbox) {
  scr_mailbox_lock(mailbox);
  ScrMailEvent *event = mailbox->head;
  if (event) {
    mailbox->head = event->next;
    event->next = NULL;
  }
  if (!mailbox->head) {
    mailbox->tail = &mailbox->head;
    scr_mailbox_drain(mailbox);
  }
  scr_mailbox_unlock(mailbox);
  return event;
}

ScrMailEvent *scr_mailbox_take_kind(ScrMailbox *mailbox, unsigned kind, uint64_t source) {
  scr_mailbox_lock(mailbox);
  ScrMailEvent **slot = &mailbox->head;
  while (*slot && ((*slot)->kind != kind || (*slot)->source != source)) slot = &(*slot)->next;
  ScrMailEvent *event = *slot;
  if (event) {
    *slot = event->next;
    if (mailbox->tail == &event->next) mailbox->tail = slot;
    event->next = NULL;
  }
  if (!mailbox->head) {
    mailbox->tail = &mailbox->head;
    scr_mailbox_drain(mailbox);
  }
  scr_mailbox_unlock(mailbox);
  return event;
}

void scr_mailbox_close(ScrMailbox *mailbox) {
  scr_mailbox_lock(mailbox);
  mailbox->closed = true;
  scr_mailbox_signal(mailbox);
  scr_mailbox_unlock(mailbox);
}

bool scr_mailbox_pending(ScrMailbox *mailbox) {
  scr_mailbox_lock(mailbox);
  bool pending = mailbox->head != NULL;
  scr_mailbox_unlock(mailbox);
  return pending;
}

void scr_mailbox_wait(ScrMailbox *mailbox, double milliseconds) {
  if (!(milliseconds > 0)) return;
  scr_mailbox_lock(mailbox);
  if (!mailbox->head && !mailbox->closed) {
#ifdef _WIN32
    DWORD timeout = milliseconds >= INFINITE ? INFINITE : (DWORD)ceil(milliseconds);
    (void)SleepConditionVariableSRW(&mailbox->condition, &mailbox->lock, timeout, 0);
#else
    if (isinf(milliseconds)) (void)pthread_cond_wait(&mailbox->condition, &mailbox->lock);
    else {
      /* The event loop rechecks its monotonic deadlines after every wake,
       * including spurious ones. Bound conversion before casting time_t. */
      if (milliseconds > 86400000) milliseconds = 86400000;
      struct timespec timeout = {(time_t)(milliseconds / 1000),
          (long)ceil(fmod(milliseconds, 1000) * 1000000)};
      if (timeout.tv_nsec == 1000000000) { timeout.tv_sec++; timeout.tv_nsec = 0; }
#ifdef __APPLE__
      (void)pthread_cond_timedwait_relative_np(&mailbox->condition, &mailbox->lock, &timeout);
#else
      struct timespec now;
      clock_gettime(CLOCK_MONOTONIC, &now);
      timeout.tv_sec += now.tv_sec;
      timeout.tv_nsec += now.tv_nsec;
      if (timeout.tv_nsec >= 1000000000) { timeout.tv_sec++; timeout.tv_nsec -= 1000000000; }
      (void)pthread_cond_timedwait(&mailbox->condition, &mailbox->lock, &timeout);
#endif
    }
#endif
  }
  scr_mailbox_unlock(mailbox);
}

int scr_mailbox_pollfd(const ScrMailbox *mailbox) {
#ifdef _WIN32
  (void)mailbox;
  return -1;
#else
  return mailbox->read_fd;
#endif
}

/* ── MessageChannel ──────────────────────────────────────────────────── */

typedef struct {
  ScrMailEvent *head; /* incoming events for this end, in order */
  ScrMailEvent **tail;
  size_t count;
  ScrMailbox *owner; /* the owning thread's inbox (+1), or NULL in transit */
  bool closed;       /* this end called close() */
  bool peer_closed;  /* the other end's close reached this end */
  uint64_t peer_closed_seq; /* when: notices are delivered in this order */
} ScrChannelEnd;

static atomic_uint_fast64_t scr_channel_notice_seq;

struct ScrChannel {
  atomic_size_t references;
  ScrChannelEnd end[2];
#ifdef _WIN32
  SRWLOCK lock;
#else
  pthread_mutex_t lock;
#endif
};

static void scr_channel_lock(ScrChannel *channel) {
#ifdef _WIN32
  AcquireSRWLockExclusive(&channel->lock);
#else
  (void)pthread_mutex_lock(&channel->lock);
#endif
}

static void scr_channel_unlock(ScrChannel *channel) {
#ifdef _WIN32
  ReleaseSRWLockExclusive(&channel->lock);
#else
  (void)pthread_mutex_unlock(&channel->lock);
#endif
}

ScrChannel *scr_channel_new(void) {
  ScrChannel *channel = calloc(1, sizeof(*channel));
  if (!channel) scr_trap("scriptc: out of memory\n");
  atomic_init(&channel->references, 1);
  for (int side = 0; side < 2; side++) channel->end[side].tail = &channel->end[side].head;
#ifdef _WIN32
  InitializeSRWLock(&channel->lock);
#else
  if (pthread_mutex_init(&channel->lock, NULL) != 0) scr_trap("scriptc: out of memory\n");
#endif
  return channel;
}

ScrChannel *scr_channel_retain(ScrChannel *channel) {
  atomic_fetch_add_explicit(&channel->references, 1, memory_order_relaxed);
  return channel;
}

void scr_channel_release(ScrChannel *channel) {
  if (!channel || atomic_fetch_sub_explicit(&channel->references, 1, memory_order_acq_rel) != 1)
    return;
  for (int side = 0; side < 2; side++) {
    ScrChannelEnd *end = &channel->end[side];
    while (end->head) {
      ScrMailEvent *event = end->head;
      end->head = event->next;
      scr_mail_event_free(event);
    }
    scr_mailbox_release(end->owner);
  }
#ifndef _WIN32
  pthread_mutex_destroy(&channel->lock);
#endif
  free(channel);
}

/* Wakes the owner's loop with a wake_kind event. */
static void scr_channel_wake(ScrMailbox *owner, unsigned wake_kind) {
  if (!owner) return;
  ScrMailEvent *wake = calloc(1, sizeof(*wake));
  if (!wake) scr_trap("scriptc: out of memory\n");
  wake->kind = wake_kind;
  scr_mailbox_post(owner, wake);
  scr_mailbox_release(owner);
}

void scr_channel_set_owner(ScrChannel *channel, int side, ScrMailbox *owner, unsigned wake_kind) {
  scr_channel_lock(channel);
  ScrChannelEnd *end = &channel->end[side];
  ScrMailbox *old = end->owner;
  end->owner = owner ? scr_mailbox_retain(owner) : NULL;
  ScrMailbox *wake = end->owner && (end->head || end->peer_closed) ? scr_mailbox_retain(end->owner) : NULL;
  scr_channel_unlock(channel);
  scr_mailbox_release(old);
  scr_channel_wake(wake, wake_kind);
}

/* postMessage from `side`: the message (consumed) queues on the other end
 * unless either end has closed. */
bool scr_channel_post(ScrChannel *channel, int side, ScrMessage *message, unsigned message_kind,
                      unsigned wake_kind) {
  ScrMailEvent *event = calloc(1, sizeof(*event));
  if (!event) scr_trap("scriptc: out of memory\n");
  event->kind = message_kind;
  event->message = message;
  scr_channel_lock(channel);
  ScrChannelEnd *peer = &channel->end[1 - side];
  if (channel->end[side].closed || peer->closed) {
    scr_channel_unlock(channel);
    scr_mail_event_free(event);
    return false;
  }
  *peer->tail = event;
  peer->tail = &event->next;
  peer->count++;
  ScrMailbox *wake = peer->owner ? scr_mailbox_retain(peer->owner) : NULL;
  scr_channel_unlock(channel);
  scr_channel_wake(wake, wake_kind);
  return true;
}

/* close() on `side`: nothing more is posted in either direction. */
void scr_channel_close(ScrChannel *channel, int side) {
  scr_channel_lock(channel);
  channel->end[side].closed = true;
  scr_channel_unlock(channel);
}

/* The closed port's 'close' ran: the other end learns it, after its queued
 * messages. */
void scr_channel_notify_close(ScrChannel *channel, int side, unsigned wake_kind) {
  scr_channel_lock(channel);
  ScrChannelEnd *peer = &channel->end[1 - side];
  ScrMailbox *wake = NULL;
  if (!peer->peer_closed && !peer->closed) {
    peer->peer_closed = true;
    peer->peer_closed_seq = atomic_fetch_add(&scr_channel_notice_seq, 1) + 1;
    wake = peer->owner ? scr_mailbox_retain(peer->owner) : NULL;
  }
  scr_channel_unlock(channel);
  scr_channel_wake(wake, wake_kind);
}

/* The next queued message for `side`, or NULL. */
ScrMailEvent *scr_channel_take(ScrChannel *channel, int side) {
  scr_channel_lock(channel);
  ScrChannelEnd *end = &channel->end[side];
  ScrMailEvent *event = end->head;
  if (event) {
    end->head = event->next;
    if (!end->head) end->tail = &end->head;
    end->count--;
    event->next = NULL;
  }
  scr_channel_unlock(channel);
  return event;
}

size_t scr_channel_count(ScrChannel *channel, int side) {
  scr_channel_lock(channel);
  size_t count = channel->end[side].count;
  scr_channel_unlock(channel);
  return count;
}

/* The other end's close notice order (0: none). */
uint64_t scr_channel_peer_closed(ScrChannel *channel, int side) {
  scr_channel_lock(channel);
  uint64_t seq = channel->end[side].peer_closed ? channel->end[side].peer_closed_seq : 0;
  scr_channel_unlock(channel);
  return seq;
}

/* Drops the queued messages for `side` (its port closed). */
void scr_channel_drop(ScrChannel *channel, int side) {
  scr_channel_lock(channel);
  ScrChannelEnd *end = &channel->end[side];
  ScrMailEvent *head = end->head;
  end->head = NULL;
  end->tail = &end->head;
  end->count = 0;
  scr_channel_unlock(channel);
  while (head) {
    ScrMailEvent *event = head;
    head = event->next;
    scr_mail_event_free(event);
  }
}

/* ── BroadcastChannel registry ───────────────────────────────────────── */

/* Every open BroadcastChannel in the process, by name: each has a channel
 * whose end 0 queues its incoming messages. */
typedef struct ScrBroadcastEntry {
  char *name;
  size_t length;
  ScrChannel *channel; /* +1 */
  struct ScrBroadcastEntry *next;
} ScrBroadcastEntry;

static ScrBroadcastEntry *scr_broadcast_entries;
#ifdef _WIN32
static SRWLOCK scr_broadcast_lock = SRWLOCK_INIT;
#define SCR_BROADCAST_LOCK() AcquireSRWLockExclusive(&scr_broadcast_lock)
#define SCR_BROADCAST_UNLOCK() ReleaseSRWLockExclusive(&scr_broadcast_lock)
#else
static pthread_mutex_t scr_broadcast_lock = PTHREAD_MUTEX_INITIALIZER;
#define SCR_BROADCAST_LOCK() (void)pthread_mutex_lock(&scr_broadcast_lock)
#define SCR_BROADCAST_UNLOCK() (void)pthread_mutex_unlock(&scr_broadcast_lock)
#endif

void scr_broadcast_join(const char *name, size_t length, ScrChannel *channel) {
  ScrBroadcastEntry *entry = calloc(1, sizeof(*entry));
  if (!entry) scr_trap("scriptc: out of memory\n");
  entry->name = malloc(length ? length : 1);
  if (!entry->name) scr_trap("scriptc: out of memory\n");
  memcpy(entry->name, name, length);
  entry->length = length;
  entry->channel = scr_channel_retain(channel);
  SCR_BROADCAST_LOCK();
  /* registration order is delivery order to the subscribers */
  ScrBroadcastEntry **tail = &scr_broadcast_entries;
  while (*tail) tail = &(*tail)->next;
  *tail = entry;
  SCR_BROADCAST_UNLOCK();
}

void scr_broadcast_leave(ScrChannel *channel) {
  ScrBroadcastEntry *gone = NULL;
  SCR_BROADCAST_LOCK();
  for (ScrBroadcastEntry **at = &scr_broadcast_entries; *at; at = &(*at)->next) {
    if ((*at)->channel != channel) continue;
    gone = *at;
    *at = gone->next;
    break;
  }
  SCR_BROADCAST_UNLOCK();
  if (!gone) return;
  scr_channel_release(gone->channel);
  free(gone->name);
  free(gone);
}

/* The other open channels named `name` (+1 each, in registration order);
 * the caller frees the array. */
size_t scr_broadcast_peers(const char *name, size_t length, ScrChannel *self, ScrChannel ***out) {
  size_t n = 0, cap = 0;
  ScrChannel **peers = NULL;
  SCR_BROADCAST_LOCK();
  for (ScrBroadcastEntry *entry = scr_broadcast_entries; entry; entry = entry->next) {
    if (entry->channel == self || entry->length != length ||
        (length && memcmp(entry->name, name, length) != 0))
      continue;
    if (n == cap) {
      cap = cap ? cap * 2 : 4;
      ScrChannel **grown = realloc(peers, cap * sizeof *grown);
      if (!grown) scr_trap("scriptc: out of memory\n");
      peers = grown;
    }
    peers[n++] = scr_channel_retain(entry->channel);
  }
  SCR_BROADCAST_UNLOCK();
  *out = peers;
  return n;
}
