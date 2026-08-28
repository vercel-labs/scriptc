/* The Linux backend of the platform readiness contract (scr_platform.h):
 * epoll for fd readiness, one timerfd per armed one-shot timer. This is
 * the LIVE Linux poller behind scr_net.c and scr_dgram.c (native-toolchain.ts links it
 * alongside scr_loop_kqueue.c whenever those units compile; each TU is
 * empty off its platform). Child-exit wakeups are NOT here: scr_child.c
 * keeps its narrow seam inline (kqueue EVFILT_PROC on BSD, pidfd_open +
 * a dedicated epoll on Linux) because that unit links into every binary
 * and its plumbing never matched the fd/timer poller shape.
 *
 * Design notes:
 * - Interest is keyed by fd with ONE mask under epoll, so the poller keeps
 *   a linear fd -> (mask, udata) table and merges read/write interest into
 *   EPOLL_CTL_MOD. Linear scan is fine at the units' scale (dozens of fds,
 *   drained in 64-event batches today); swap for a hash if profiles say so.
 * - EPOLLHUP/EPOLLERR/EPOLLRDHUP report as READABLE (plus WRITABLE when
 *   write interest is armed): the units learn EOF/errors from read()==0 or
 *   errno exactly as they do from kqueue's EV_EOF today. Note an fd is in
 *   the epoll set ONLY while some interest is armed, so a consumer-less
 *   socket can never busy-report HUP.
 * - Timers: EVFILT_TIMER has no epoll analogue, so each armed key owns a
 *   TFD_NONBLOCK timerfd registered EPOLLIN in the same epoll set, tagged
 *   through the same table (mask=TIMER). Fired timers are disarmed and
 *   their timerfd closed at delivery (kqueue's EV_ONESHOT semantics).
 * - Units must scrp_forget a watched fd before close(2) (the contract's
 *   epoll obligation). As a second line of defense against a missed
 *   forget followed by fd-number reuse, watch self-heals: a MOD that
 *   reports ENOENT retries as ADD, an ADD that reports EEXIST retries as
 *   MOD — the table entry then matches reality again. */
#if defined(__linux__)

#define _GNU_SOURCE 1
#include "scr_platform.h"

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/timerfd.h>
#include <unistd.h>

/* ── fd/timer poller ─────────────────────────────────────────────────── */

typedef struct {
  int fd;          /* watched fd, or the timer's timerfd */
  unsigned mask;   /* SCRP_READABLE|SCRP_WRITABLE, or SCRP_TIMER */
  void *udata;     /* delivery tag; for timers: the arm-time udata */
  void *timer_key; /* timers only: the caller's key */
} ScrpEntry;

struct ScrPoller {
  int ep;
  ScrpEntry *entries;
  size_t n, cap;
};

static ScrpEntry *scrp_find_fd(ScrPoller *p, int fd) {
  for (size_t i = 0; i < p->n; i++)
    if (p->entries[i].fd == fd) return &p->entries[i];
  return NULL;
}

static ScrpEntry *scrp_find_key(ScrPoller *p, void *key) {
  for (size_t i = 0; i < p->n; i++)
    if ((p->entries[i].mask & SCRP_TIMER) != 0 && p->entries[i].timer_key == key) return &p->entries[i];
  return NULL;
}

static void scrp_remove(ScrPoller *p, ScrpEntry *e) {
  size_t i = (size_t)(e - p->entries);
  p->entries[i] = p->entries[p->n - 1];
  p->n--;
}

static bool scrp_push(ScrPoller *p, ScrpEntry e) {
  if (p->n == p->cap) {
    size_t cap = p->cap == 0 ? 16 : p->cap * 2;
    ScrpEntry *grown = realloc(p->entries, cap * sizeof *grown);
    if (grown == NULL) return false;
    p->entries = grown;
    p->cap = cap;
  }
  p->entries[p->n++] = e;
  return true;
}

ScrPoller *scrp_poller_new(void) {
  ScrPoller *p = calloc(1, sizeof *p);
  if (p == NULL) return NULL;
  p->ep = epoll_create1(EPOLL_CLOEXEC);
  if (p->ep < 0) {
    free(p);
    return NULL;
  }
  return p;
}

void scrp_poller_free(ScrPoller *p) {
  if (p == NULL) return;
  for (size_t i = 0; i < p->n; i++)
    if ((p->entries[i].mask & SCRP_TIMER) != 0) close(p->entries[i].fd);
  close(p->ep);
  free(p->entries);
  free(p);
}

int scrp_poller_fd(const ScrPoller *p) { return p->ep; }

static uint32_t scrp_epoll_mask(unsigned mask) {
  uint32_t ev = 0;
  if ((mask & SCRP_READABLE) != 0) ev |= EPOLLIN;
  if ((mask & SCRP_WRITABLE) != 0) ev |= EPOLLOUT;
  return ev;
}

static bool scrp_watch(ScrPoller *p, int fd, void *udata, bool on, unsigned bit) {
  ScrpEntry *e = scrp_find_fd(p, fd);
  unsigned mask = e != NULL ? e->mask : 0u;
  unsigned next = on ? (mask | bit) : (mask & ~bit);
  if (next == mask && (e == NULL || e->udata == udata)) {
    if (e != NULL) e->udata = udata;
    return true;
  }
  struct epoll_event ev = {.events = scrp_epoll_mask(next), .data = {.fd = fd}};
  if (e == NULL) {
    if (next == 0) return true; /* unwatch of an unwatched fd: no-op */
    if (!scrp_push(p, (ScrpEntry){fd, next, udata, NULL})) return false;
    int rc = epoll_ctl(p->ep, EPOLL_CTL_ADD, fd, &ev);
    if (rc != 0 && errno == EEXIST) rc = epoll_ctl(p->ep, EPOLL_CTL_MOD, fd, &ev);
    if (rc != 0) {
      scrp_remove(p, &p->entries[p->n - 1]);
      return false;
    }
    return true;
  }
  if (next == 0) {
    (void)epoll_ctl(p->ep, EPOLL_CTL_DEL, fd, NULL);
    scrp_remove(p, e);
    return true;
  }
  int rc = epoll_ctl(p->ep, EPOLL_CTL_MOD, fd, &ev);
  if (rc != 0 && errno == ENOENT) rc = epoll_ctl(p->ep, EPOLL_CTL_ADD, fd, &ev);
  if (rc != 0) return false;
  e->mask = next;
  e->udata = udata; /* last registration wins, both directions */
  return true;
}

bool scrp_watch_read(ScrPoller *p, int fd, void *udata, bool on) {
  return scrp_watch(p, fd, udata, on, SCRP_READABLE);
}

bool scrp_watch_write(ScrPoller *p, int fd, void *udata, bool on) {
  return scrp_watch(p, fd, udata, on, SCRP_WRITABLE);
}

void scrp_forget(ScrPoller *p, int fd) {
  ScrpEntry *e = scrp_find_fd(p, fd);
  if (e == NULL) return;
  (void)epoll_ctl(p->ep, EPOLL_CTL_DEL, fd, NULL);
  scrp_remove(p, e);
}

bool scrp_timer_arm(ScrPoller *p, void *key, double ms, void *udata) {
  if (!(ms >= 0)) ms = 0;
  ScrpEntry *e = scrp_find_key(p, key);
  int tfd = e != NULL ? e->fd : timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
  if (tfd < 0) return false;
  struct itimerspec its;
  memset(&its, 0, sizeof its);
  its.it_value.tv_sec = (time_t)(ms / 1000.0);
  its.it_value.tv_nsec = (long)((ms - (double)its.it_value.tv_sec * 1000.0) * 1e6);
  if (its.it_value.tv_sec == 0 && its.it_value.tv_nsec == 0) its.it_value.tv_nsec = 1; /* 0 disarms timerfd */
  if (timerfd_settime(tfd, 0, &its, NULL) != 0) {
    if (e == NULL) close(tfd);
    return false;
  }
  if (e != NULL) {
    e->udata = udata;
    return true; /* re-arm replaces the deadline */
  }
  if (!scrp_push(p, (ScrpEntry){tfd, SCRP_TIMER, udata, key})) {
    close(tfd);
    return false;
  }
  struct epoll_event ev = {.events = EPOLLIN, .data = {.fd = tfd}};
  if (epoll_ctl(p->ep, EPOLL_CTL_ADD, tfd, &ev) != 0) {
    scrp_remove(p, &p->entries[p->n - 1]);
    close(tfd);
    return false;
  }
  return true;
}

void scrp_timer_cancel(ScrPoller *p, void *key) {
  ScrpEntry *e = scrp_find_key(p, key);
  if (e == NULL) return; /* unarmed or already fired: no-op */
  (void)epoll_ctl(p->ep, EPOLL_CTL_DEL, e->fd, NULL);
  close(e->fd);
  scrp_remove(p, e);
}

int scrp_drain(ScrPoller *p, ScrPollerEvent *out, int max) {
  if (max <= 0) return 0;
  struct epoll_event evs[64];
  int want = max < 64 ? max : 64;
  int n = epoll_wait(p->ep, evs, want, 0);
  if (n <= 0) return 0; /* EINTR/none: a spurious pass */
  int filled = 0;
  for (int i = 0; i < n; i++) {
    ScrpEntry *e = scrp_find_fd(p, evs[i].data.fd);
    if (e == NULL) continue; /* raced with forget */
    if ((e->mask & SCRP_TIMER) != 0) {
      out[filled].udata = e->udata;
      out[filled++].events = SCRP_TIMER;
      /* one-shot: disarm at delivery, EV_ONESHOT semantics */
      (void)epoll_ctl(p->ep, EPOLL_CTL_DEL, e->fd, NULL);
      close(e->fd);
      scrp_remove(p, e);
      continue;
    }
    unsigned got = 0;
    uint32_t ep = evs[i].events;
    if ((ep & (EPOLLIN | EPOLLHUP | EPOLLERR | EPOLLRDHUP)) != 0) got |= SCRP_READABLE;
    if ((ep & EPOLLOUT) != 0 || ((ep & (EPOLLHUP | EPOLLERR)) != 0 && (e->mask & SCRP_WRITABLE) != 0))
      got |= SCRP_WRITABLE;
    got &= e->mask | SCRP_READABLE; /* EOF/err always reads; writes only if armed */
    if (got == 0) continue;
    out[filled].udata = e->udata;
    out[filled++].events = got;
  }
  return filled;
}

#else /* !__linux__ */

/* Empty TU off-Linux: the kqueue backend (scr_loop_kqueue.c) carries the
 * macOS/BSD implementation; linking both everywhere is harmless. */
typedef int scr_loop_epoll_unused;

#endif
