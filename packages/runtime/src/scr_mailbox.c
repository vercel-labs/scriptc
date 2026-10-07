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
