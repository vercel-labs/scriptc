/* The Linux backend of the platform readiness contract (scr_platform.h):
 * epoll for fd readiness, one timerfd for every armed one-shot timer. This
 * is the LIVE Linux poller behind scr_net.c and scr_dgram.c (native-toolchain.ts links it
 * alongside scr_loop_kqueue.c whenever those units compile; each TU is
 * empty off its platform). Child-exit wakeups are NOT here: scr_child.c
 * keeps its narrow seam inline (kqueue EVFILT_PROC on BSD, pidfd_open +
 * a dedicated epoll on Linux) because that unit links into every binary
 * and its plumbing never matched the fd/timer poller shape.
 *
 * Design notes:
 * - Interest is keyed by fd with ONE mask under epoll, so the poller keeps
 *   an fd -> (mask, udata) table (indexed by fd number) and merges
 *   read/write interest into EPOLL_CTL_MOD.
 * - EPOLLHUP/EPOLLERR/EPOLLRDHUP report as READABLE (plus WRITABLE when
 *   write interest is armed): the units learn EOF/errors from read()==0 or
 *   errno exactly as they do from kqueue's EV_EOF today. Note an fd is in
 *   the epoll set ONLY while some interest is armed, so a consumer-less
 *   socket can never busy-report HUP.
 * - Timers: EVFILT_TIMER has no epoll analogue. Armed keys live in a
 *   deadline min-heap (a pointer hash finds a key's slot), and ONE timerfd
 *   in the epoll set wakes the loop at the earliest deadline. Re-arming,
 *   arming a later deadline and cancelling make no system call: the
 *   timerfd is reprogrammed only when a deadline earlier than its own
 *   arrives, or when it fires early (the heap then holds later deadlines).
 *   A server's per-request idle-timer churn therefore costs nothing in the
 *   kernel, like libuv's timer heap. Expired timers are delivered (and
 *   disarmed: kqueue's EV_ONESHOT semantics) by the next drain.
 * - Units must scrp_forget a watched fd before close(2) (the contract's
 *   epoll obligation). As a second line of defense against a missed
 *   forget followed by fd-number reuse, watch self-heals: a MOD that
 *   reports ENOENT retries as ADD, an ADD that reports EEXIST retries as
 *   MOD — the table entry then matches reality again. */
#if defined(__linux__)

#define _GNU_SOURCE 1
#include "scr_platform.h"

#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

/* ── fd/timer poller ─────────────────────────────────────────────────── */

typedef struct {
  int fd;        /* watched fd */
  unsigned mask; /* SCRP_READABLE|SCRP_WRITABLE */
  void *udata;   /* delivery tag */
} ScrpEntry;

typedef struct {
  double deadline; /* CLOCK_MONOTONIC milliseconds */
  uint64_t seq;    /* arm order: equal deadlines fire first-armed first */
  void *key;
  void *udata;
} ScrpTimer;

typedef struct {
  void *key;
  size_t idx; /* the key's heap index */
} ScrpKeySlot;

struct ScrPoller {
  int ep;
  ScrpEntry *entries;
  size_t n, cap;
  size_t *slot_of_fd; /* fd -> entry index + 1 (0: unwatched) */
  size_t fd_cap;
  int tfd;              /* the shared timerfd (-1 until a timer arms) */
  double tfd_deadline;  /* what tfd is programmed for; INFINITY: disarmed */
  ScrpTimer *heap;
  size_t nt, heap_cap;
  ScrpKeySlot *key_slots; /* open addressing over keys (key NULL: empty) */
  size_t key_cap;       /* power of two */
  uint64_t seq;
};

static ScrpEntry *scrp_find_fd(ScrPoller *p, int fd) {
  if (fd < 0 || (size_t)fd >= p->fd_cap || p->slot_of_fd[fd] == 0) return NULL;
  return &p->entries[p->slot_of_fd[fd] - 1];
}

static void scrp_remove(ScrPoller *p, ScrpEntry *e) {
  size_t i = (size_t)(e - p->entries);
  p->slot_of_fd[e->fd] = 0;
  p->n--;
  if (i != p->n) {
    p->entries[i] = p->entries[p->n];
    p->slot_of_fd[p->entries[i].fd] = i + 1;
  }
}

static bool scrp_push(ScrPoller *p, ScrpEntry e) {
  if ((size_t)e.fd >= p->fd_cap) {
    size_t cap = p->fd_cap == 0 ? 64 : p->fd_cap;
    while (cap <= (size_t)e.fd) cap *= 2;
    size_t *grown = realloc(p->slot_of_fd, cap * sizeof *grown);
    if (grown == NULL) return false;
    memset(grown + p->fd_cap, 0, (cap - p->fd_cap) * sizeof *grown);
    p->slot_of_fd = grown;
    p->fd_cap = cap;
  }
  if (p->n == p->cap) {
    size_t cap = p->cap == 0 ? 16 : p->cap * 2;
    ScrpEntry *grown = realloc(p->entries, cap * sizeof *grown);
    if (grown == NULL) return false;
    p->entries = grown;
    p->cap = cap;
  }
  p->entries[p->n++] = e;
  p->slot_of_fd[e.fd] = p->n;
  return true;
}

/* ── the timer heap ── */

static double scrp_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

static size_t scrp_key_hash(const ScrPoller *p, const void *key) {
  uintptr_t h = (uintptr_t)key;
  h ^= h >> 17;
  h *= (uintptr_t)0x9E3779B97F4A7C15ull;
  h ^= h >> 29;
  return (size_t)h & (p->key_cap - 1);
}

/* The hash slot holding `key`, or the empty slot where it would go. */
static size_t scrp_key_probe(const ScrPoller *p, const void *key) {
  size_t i = scrp_key_hash(p, key);
  while (p->key_slots[i].key != NULL && p->key_slots[i].key != key)
    i = (i + 1) & (p->key_cap - 1);
  return i;
}

static ScrpKeySlot *scrp_key_find(const ScrPoller *p, const void *key) {
  if (p->key_cap == 0) return NULL;
  size_t i = scrp_key_probe(p, key);
  return p->key_slots[i].key != NULL ? &p->key_slots[i] : NULL;
}

/* Backward-shift deletion keeps linear probing tombstone-free. */
static void scrp_key_erase(ScrPoller *p, size_t i) {
  size_t mask = p->key_cap - 1;
  p->key_slots[i].key = NULL;
  for (size_t j = (i + 1) & mask; p->key_slots[j].key != NULL; j = (j + 1) & mask) {
    size_t home = scrp_key_hash(p, p->key_slots[j].key);
    /* move j into the hole when its home is not cyclically within (i, j] */
    if (((j - home) & mask) >= ((j - i) & mask)) {
      p->key_slots[i] = p->key_slots[j];
      p->key_slots[j].key = NULL;
      i = j;
    }
  }
}

static bool scrp_key_grow(ScrPoller *p) {
  size_t cap = p->key_cap == 0 ? 64 : p->key_cap * 2;
  ScrpKeySlot *slots = calloc(cap, sizeof *slots);
  if (slots == NULL) return false;
  free(p->key_slots);
  p->key_slots = slots;
  p->key_cap = cap;
  for (size_t h = 0; h < p->nt; h++)
    p->key_slots[scrp_key_probe(p, p->heap[h].key)] = (ScrpKeySlot){p->heap[h].key, h};
  return true;
}

static bool scrp_timer_less(const ScrpTimer *a, const ScrpTimer *b) {
  return a->deadline < b->deadline || (a->deadline == b->deadline && a->seq < b->seq);
}

/* Place `t` at heap index `i` and record it in the key table. */
static void scrp_heap_put(ScrPoller *p, size_t i, ScrpTimer t) {
  p->heap[i] = t;
  scrp_key_find(p, t.key)->idx = i;
}

static void scrp_heap_fix(ScrPoller *p, size_t i) {
  ScrpTimer t = p->heap[i];
  while (i > 0) {
    size_t parent = (i - 1) / 2;
    if (!scrp_timer_less(&t, &p->heap[parent])) break;
    scrp_heap_put(p, i, p->heap[parent]);
    i = parent;
  }
  for (;;) {
    size_t child = 2 * i + 1;
    if (child >= p->nt) break;
    if (child + 1 < p->nt && scrp_timer_less(&p->heap[child + 1], &p->heap[child])) child++;
    if (!scrp_timer_less(&p->heap[child], &t)) break;
    scrp_heap_put(p, i, p->heap[child]);
    i = child;
  }
  scrp_heap_put(p, i, t);
}

static void scrp_heap_remove(ScrPoller *p, size_t i) {
  scrp_key_erase(p, scrp_key_probe(p, p->heap[i].key));
  p->nt--;
  if (i == p->nt) return;
  p->heap[i] = p->heap[p->nt];
  scrp_heap_fix(p, i);
}

/* Program the shared timerfd for `deadline` (INFINITY disarms). */
static bool scrp_tfd_program(ScrPoller *p, double deadline) {
  struct itimerspec its;
  memset(&its, 0, sizeof its);
  if (deadline != INFINITY) {
    if (deadline < 0) deadline = 0;
    its.it_value.tv_sec = (time_t)(deadline / 1000.0);
    its.it_value.tv_nsec = (long)((deadline - (double)its.it_value.tv_sec * 1000.0) * 1e6);
    if (its.it_value.tv_nsec >= 1000000000L) its.it_value.tv_nsec = 999999999L;
    if (its.it_value.tv_sec == 0 && its.it_value.tv_nsec == 0) its.it_value.tv_nsec = 1; /* 0 disarms */
  }
  if (timerfd_settime(p->tfd, TFD_TIMER_ABSTIME, &its, NULL) != 0) return false;
  p->tfd_deadline = deadline;
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
  p->tfd = -1;
  p->tfd_deadline = INFINITY;
  return p;
}

void scrp_poller_free(ScrPoller *p) {
  if (p == NULL) return;
  if (p->tfd >= 0) close(p->tfd);
  close(p->ep);
  free(p->entries);
  free(p->slot_of_fd);
  free(p->heap);
  free(p->key_slots);
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
    if (!scrp_push(p, (ScrpEntry){fd, next, udata})) return false;
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
  if (p->tfd < 0) {
    int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
    if (tfd < 0) return false;
    struct epoll_event ev = {.events = EPOLLIN, .data = {.fd = tfd}};
    if (epoll_ctl(p->ep, EPOLL_CTL_ADD, tfd, &ev) != 0) {
      close(tfd);
      return false;
    }
    p->tfd = tfd;
  }
  ScrpTimer t = {scrp_now_ms() + ms, p->seq++, key, udata};
  ScrpKeySlot *slot = scrp_key_find(p, key);
  if (slot != NULL) {
    /* re-arm replaces the deadline */
    size_t i = slot->idx;
    p->heap[i] = t;
    scrp_heap_fix(p, i);
  } else {
    if (p->nt == p->heap_cap) {
      size_t cap = p->heap_cap == 0 ? 16 : p->heap_cap * 2;
      ScrpTimer *grown = realloc(p->heap, cap * sizeof *grown);
      if (grown == NULL) return false;
      p->heap = grown;
      p->heap_cap = cap;
    }
    if ((p->nt + 1) * 2 > p->key_cap && !scrp_key_grow(p)) return false;
    p->heap[p->nt] = t;
    p->key_slots[scrp_key_probe(p, key)] = (ScrpKeySlot){key, p->nt};
    p->nt++;
    scrp_heap_fix(p, p->nt - 1);
  }
  /* Only an earlier deadline needs the kernel: a later one is found when
   * the timerfd fires early. */
  if (p->heap[0].deadline < p->tfd_deadline && !scrp_tfd_program(p, p->heap[0].deadline)) {
    scrp_heap_remove(p, scrp_key_find(p, key)->idx);
    return false;
  }
  return true;
}

void scrp_timer_cancel(ScrPoller *p, void *key) {
  ScrpKeySlot *slot = scrp_key_find(p, key);
  if (slot == NULL) return; /* unarmed or already fired: no-op */
  /* the timerfd keeps its deadline; an early wake finds nothing due */
  scrp_heap_remove(p, slot->idx);
}

int scrp_drain(ScrPoller *p, ScrPollerEvent *out, int max) {
  if (max <= 0) return 0;
  struct epoll_event evs[64];
  int want = max < 64 ? max : 64;
  int n = epoll_wait(p->ep, evs, want, 0);
  int filled = 0;
  bool timer_woke = false;
  for (int i = 0; i < n; i++) {
    if (evs[i].data.fd == p->tfd && p->tfd >= 0) {
      uint64_t ticks;
      (void)!read(p->tfd, &ticks, sizeof ticks);
      timer_woke = true;
      continue;
    }
    ScrpEntry *e = scrp_find_fd(p, evs[i].data.fd);
    if (e == NULL) continue; /* raced with forget */
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
  /* The timerfd always holds a deadline no later than the heap's earliest
   * (arming an earlier one reprograms it), so a timer can only be due
   * after it fires. */
  if (timer_woke) {
    p->tfd_deadline = INFINITY; /* one-shot: it fired */
    /* deliver every expired timer the batch has room for, one-shot */
    double now = scrp_now_ms();
    while (p->nt > 0 && filled < max && p->heap[0].deadline <= now) {
      out[filled].udata = p->heap[0].udata;
      out[filled++].events = SCRP_TIMER;
      scrp_heap_remove(p, 0);
    }
    /* the next deadline (one already past fires at once) */
    if (p->nt > 0) (void)scrp_tfd_program(p, p->heap[0].deadline);
  }
  return filled;
}

#else /* !__linux__ */

/* Empty TU off-Linux: the kqueue backend (scr_loop_kqueue.c) carries the
 * macOS/BSD implementation; linking both everywhere is harmless. */
typedef int scr_loop_epoll_unused;

#endif
