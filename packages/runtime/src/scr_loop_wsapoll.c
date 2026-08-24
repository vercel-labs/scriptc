/* The Windows backend of the platform readiness contract (scr_platform.h):
 * WSAPoll for socket readiness, deadline bookkeeping for the one-shot
 * timers (no timerfd analogue — scrp_drain expires due keys against the
 * loop's scr_now_ms clock). native-toolchain.ts links this TU alongside the kqueue and
 * epoll backends whenever a poller-using unit compiles; each is empty off
 * its platform.
 *
 * Design notes:
 * - Interest lives in the same linear fd -> (mask, udata) table the epoll
 *   backend keeps, but there is no kernel registration at all: every
 *   scrp_drain builds a WSAPOLLFD array from the table and polls it with
 *   a zero timeout. At the units' scale (dozens of sockets) the rebuild
 *   is noise, and it makes forget/close ordering unable to go stale by
 *   construction — an entry gone from the table is gone from the poll.
 * - There is NO pollable poller fd to hand the loop (WSAPoll has no
 *   waitable handle shape): scrp_poller_fd answers -1 and the loop's
 *   win32 idle sleep runs capped (scr_async.c), dispatching at the next
 *   turn's top — readiness latency is bounded by the cap instead of
 *   eliminated by a wake fd. When that cap ever shows up in a profile,
 *   the upgrade path is WSAEventSelect + WaitForMultipleObjects (or
 *   IOCP), which needs a loop-side seam, not a contract change.
 * - POLLHUP/POLLERR report as READABLE (plus WRITABLE when write interest
 *   is armed) exactly like the epoll backend: units learn the truth from
 *   recv()==0 / the socket error. A failed nonblocking connect() reports
 *   through POLLERR/POLLHUP here (WSAPoll delivers those on Win10 19041+;
 *   the box class this lane targets).
 * - fds are winsock SOCKETs narrowed through the units' int fd contract
 *   and widened back here; Windows socket handles fit (kernel handle
 *   space), the same narrowing scr_child.c's stdio plumbing relies on.
 * - WSAStartup: the owning unit (scr_net.c/scr_dgram.c) initializes
 *   winsock before it creates sockets; poller_new also calls it (ref-
 *   counted by the OS) so a poller created first still works. */
#ifdef _WIN32

#include "scr_platform.h"
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>
#include <winsock2.h>

typedef struct {
  int fd;          /* watched SOCKET (narrowed), or -1 for a timer entry */
  unsigned mask;   /* SCRP_READABLE|SCRP_WRITABLE, or SCRP_TIMER */
  void *udata;     /* delivery tag; for timers: the arm-time udata */
  void *timer_key; /* timers only: the caller's key */
  double deadline; /* timers only: scr_now_ms deadline */
} ScrpEntry;

struct ScrPoller {
  ScrpEntry *entries;
  size_t n, cap;
};

static ScrpEntry *scrp_find_fd(ScrPoller *p, int fd) {
  for (size_t i = 0; i < p->n; i++)
    if ((p->entries[i].mask & SCRP_TIMER) == 0 && p->entries[i].fd == fd) return &p->entries[i];
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
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return NULL;
  ScrPoller *p = calloc(1, sizeof *p);
  if (p == NULL) WSACleanup();
  return p;
}

void scrp_poller_free(ScrPoller *p) {
  if (p == NULL) return;
  free(p->entries);
  free(p);
  WSACleanup();
}

int scrp_poller_fd(const ScrPoller *p) {
  (void)p;
  return -1; /* nothing waitable — the loop's capped win32 sleep serves us */
}

static bool scrp_watch(ScrPoller *p, int fd, void *udata, bool on, unsigned bit) {
  ScrpEntry *e = scrp_find_fd(p, fd);
  unsigned mask = e != NULL ? e->mask : 0u;
  unsigned next = on ? (mask | bit) : (mask & ~bit);
  if (e == NULL) {
    if (next == 0) return true; /* unwatch of an unwatched fd: no-op */
    return scrp_push(p, (ScrpEntry){fd, next, udata, NULL, 0});
  }
  if (next == 0) {
    scrp_remove(p, e);
    return true;
  }
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
  if (e != NULL) scrp_remove(p, e);
}

bool scrp_timer_arm(ScrPoller *p, void *key, double ms, void *udata) {
  if (!(ms >= 0)) ms = 0;
  double deadline = scr_now_ms() + ms;
  ScrpEntry *e = scrp_find_key(p, key);
  if (e != NULL) {
    e->deadline = deadline; /* re-arm replaces the deadline */
    e->udata = udata;
    return true;
  }
  return scrp_push(p, (ScrpEntry){-1, SCRP_TIMER, udata, key, deadline});
}

void scrp_timer_cancel(ScrPoller *p, void *key) {
  ScrpEntry *e = scrp_find_key(p, key);
  if (e != NULL) scrp_remove(p, e); /* unarmed or already fired: no-op */
}

int scrp_drain(ScrPoller *p, ScrPollerEvent *out, int max) {
  if (max <= 0) return 0;
  int filled = 0;
  /* Due timers first (kqueue delivers EVFILT_TIMER through the same
   * drain); one-shot — the entry leaves the table at delivery. */
  double now = scr_now_ms();
  for (size_t i = 0; i < p->n && filled < max;) {
    ScrpEntry *e = &p->entries[i];
    if ((e->mask & SCRP_TIMER) != 0 && e->deadline <= now) {
      out[filled].udata = e->udata;
      out[filled++].events = SCRP_TIMER;
      scrp_remove(p, e); /* swaps the tail in — revisit index i */
      continue;
    }
    i++;
  }
  /* Socket readiness: poll the whole table with a zero timeout. */
  enum { SCRP_BATCH = 64 };
  WSAPOLLFD pfds[SCRP_BATCH];
  ScrpEntry *owners[SCRP_BATCH];
  ULONG npfds = 0;
  for (size_t i = 0; i < p->n && npfds < SCRP_BATCH; i++) {
    ScrpEntry *e = &p->entries[i];
    if ((e->mask & SCRP_TIMER) != 0) continue;
    pfds[npfds].fd = (SOCKET)e->fd;
    pfds[npfds].events = 0;
    if ((e->mask & SCRP_READABLE) != 0) pfds[npfds].events |= POLLRDNORM;
    if ((e->mask & SCRP_WRITABLE) != 0) pfds[npfds].events |= POLLWRNORM;
    pfds[npfds].revents = 0;
    owners[npfds++] = e;
  }
  if (npfds == 0 || filled >= max) return filled;
  int n = WSAPoll(pfds, npfds, 0);
  if (n <= 0) return filled; /* none/failed: a spurious pass */
  for (ULONG i = 0; i < npfds && filled < max; i++) {
    SHORT re = pfds[i].revents;
    if (re == 0) continue;
    ScrpEntry *e = owners[i];
    unsigned got = 0;
    if ((re & (POLLRDNORM | POLLHUP | POLLERR | POLLNVAL)) != 0) got |= SCRP_READABLE;
    if ((re & POLLWRNORM) != 0 || ((re & (POLLHUP | POLLERR | POLLNVAL)) != 0 && (e->mask & SCRP_WRITABLE) != 0))
      got |= SCRP_WRITABLE;
    got &= e->mask | SCRP_READABLE; /* EOF/err always reads; writes only if armed */
    if (got == 0) continue;
    out[filled].udata = e->udata;
    out[filled++].events = got;
  }
  return filled;
}

#else /* !_WIN32 */

/* Empty TU off-Windows: the kqueue and epoll backends carry the POSIX
 * platforms; linking all three everywhere is harmless. */
typedef int scr_loop_wsapoll_unused;

#endif
