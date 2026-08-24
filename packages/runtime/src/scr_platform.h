/* The platform readiness contract — ONE interface both event backends
 * implement (kqueue on macOS/BSD, epoll on Linux), designed from how
 * scr_net.c / scr_dgram.c / scr_child.c use kqueue TODAY. Design notes and
 * the full macOS-ism audit live in docs/linux-port.md.
 *
 * Scope, deliberately: the loop CORE (scr_async.c) is already portable —
 * its idle sleep is poll(2)/nanosleep over fds the optional units hand it
 * via the pending/dispatch/pollfd hook triple, and that hook contract is
 * platform-neutral (an epoll fd polls readable while events pend, exactly
 * like a kqueue fd). What is NOT portable is the plumbing INSIDE each
 * unit: kqueue creation, filter add/remove, the idle-timer filter, the
 * child-exit filter, and the zero-timeout drains. This header names that
 * plumbing so each unit can call one spelling and link either backend.
 *
 * STATUS: LIVE. scr_net.c and scr_dgram.c call this contract; native-toolchain.ts
 * links BOTH backends whenever either unit compiles (scr_loop_kqueue.c —
 * a stateless spelling of the units' historical inline syscall
 * sequences, byte-identical on macOS by construction — and
 * scr_loop_epoll.c; each TU is empty off its platform). The mapping each
 * backend owes:
 *
 *   contract              kqueue backend                 epoll backend
 *   ------------------    ---------------------------    -------------------------------
 *   poller fd             the kqueue() fd                the epoll_create1() fd
 *   watch read on/off     EVFILT_READ EV_ADD/EV_DELETE   EPOLLIN via ADD/MOD/DEL + fd table
 *   watch write on/off    EVFILT_WRITE EV_ADD/EV_DELETE  EPOLLOUT via ADD/MOD/DEL + fd table
 *   one-shot timer(key)   EVFILT_TIMER ident=key,        one timerfd_create per armed key,
 *                         EV_ONESHOT, NOTE_* default ms  TFD_NONBLOCK, registered EPOLLIN
 *   drain (zero timeout)  kevent(evs, N, {0,0})          epoll_wait(evs, N, 0)
 *   EOF/error delivery    EV_EOF on the read filter      EPOLLHUP/EPOLLERR/EPOLLRDHUP
 *                                                        reported as READABLE (+WRITABLE
 *                                                        when write interest is armed) —
 *                                                        units learn the truth from
 *                                                        read()==0 / errno, as today
 *
 * (Child-exit wakeups live inline in scr_child.c — see the note at the
 * bottom of this header.)
 *
 * Two epoll-only obligations the kqueue side never had, called out so the
 * extraction cannot fudge them: (1) epoll keys interest by fd with
 * ONE mask, so read+write interest on the same fd must merge into a MOD —
 * the backend keeps a private fd -> (mask, udata) table; kqueue's separate
 * filters need no such state. (2) closing an fd does NOT reliably remove
 * it from an epoll set while dup'd references exist — units must call
 * scrp_forget BEFORE close(2). kqueue drops filters on close, so today's
 * units don't always bother; the extraction adds the forget calls (a
 * no-op wrapper on the kqueue side keeps macOS byte-identical in
 * behavior; the corpus proves it). */
#ifndef SCR_PLATFORM_H
#define SCR_PLATFORM_H

#include <stdbool.h>
#include <stddef.h>

/* ── the fd/timer poller (scr_net.c's and scr_dgram.c's unit kqueues) ── */

typedef struct ScrPoller ScrPoller;

enum {
  SCRP_READABLE = 1u << 0,
  SCRP_WRITABLE = 1u << 1,
  SCRP_TIMER = 1u << 2,
};

typedef struct {
  void *udata;     /* the pointer registered at watch/arm time; routing is
                    * the caller's business (scr_net routes on a leading
                    * `kind` int, exactly as its kevent udata does today) */
  unsigned events; /* SCRP_* bits OR'd */
} ScrPollerEvent;

/* NULL on resource exhaustion — callers report and disable the unit, the
 * historical kqueue() failure path. */
ScrPoller *scrp_poller_new(void);
void scrp_poller_free(ScrPoller *p);

/* The fd the LOOP sleeps on (poll(2), POLLIN): readable while any event
 * pends, the property both kqueue and epoll fds share. Owned by the
 * poller — never closed or drained by the caller. */
int scrp_poller_fd(const ScrPoller *p);

/* Watch/unwatch one direction on an fd. `udata` tags every delivery for
 * this fd (the LAST registration wins across both directions — matching
 * how the units pass the same socket pointer to both filters today).
 * Unwatching a direction that isn't armed is a no-op, like EV_DELETE on a
 * missing filter is ignored by today's code. */
bool scrp_watch_read(ScrPoller *p, int fd, void *udata, bool on);
bool scrp_watch_write(ScrPoller *p, int fd, void *udata, bool on);

/* Drop every registration for fd. MUST precede close(2) of a watched fd
 * (see the epoll obligation above); safe on unwatched fds. */
void scrp_forget(ScrPoller *p, int fd);

/* One-shot timer keyed by an arbitrary pointer (scr_net's idle timers:
 * ident = the socket pointer). Re-arming an armed key replaces its
 * deadline; delivery reports SCRP_TIMER with udata = key. Cancel of an
 * unarmed/already-fired key is a no-op (the timer "may already have
 * fired" comment in scr_net.c today). */
bool scrp_timer_arm(ScrPoller *p, void *key, double ms, void *udata);
void scrp_timer_cancel(ScrPoller *p, void *key);

/* Zero-timeout drain of everything pending, at most `max` events (the
 * units' dispatch-top drains: kevent/epoll_wait with a zero timeout).
 * Returns the count; EINTR reads as 0 (a spurious pass, as today). */
int scrp_drain(ScrPoller *p, ScrPollerEvent *out, int max);

/* ── child-exit wakeups: NOT here, deliberately ───────────────────────
 * scr_child.c keeps its narrow seam INLINE (scr_child_watch /
 * scr_children_wait / scr_children_wake_fd, plus the stream read-fd
 * arm/dearm): kqueue EVFILT_PROC NOTE_EXIT + EVFILT_READ on BSD,
 * pidfd_open + a dedicated epoll on Linux, and the portable
 * waitpid(WNOHANG)-under-a-~1ms-cap fallback everywhere else. That unit
 * links into EVERY binary, so routing it through this contract would put
 * both backends on every link line; its plumbing (wakeups-only, events
 * discarded, the unit's own unwatched-children accounting) also never
 * matched the fd/timer poller shape above. Reaping stays the WNOHANG
 * sweep on every platform — exit events are wakeups only. */

#endif /* SCR_PLATFORM_H */
