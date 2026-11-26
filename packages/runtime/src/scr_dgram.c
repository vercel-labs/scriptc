/* node:dgram + node:dns — UDP sockets over the event loop's readiness
 * poller (the scr_platform.h contract — kqueue on macOS/BSD, epoll on
 * Linux; scr_net.c has the seam's full story), and the dns.lookup slice
 * that rides the same unit.
 *
 * ── Design note ──────────────────────────────────────────────────────
 *
 * Object model. One refcounted handle kind, a LEAN allocation (no cycle
 * header — the ScrNetSocket precedent): ScrDgramSocket (fd, the
 * bound/connected/closing state machine, message/listening/connect/
 * close/error listener lists, the unref flag). Listeners MOVE in (+1)
 * and are released when the handle settles ('close' fired, or the
 * exit-time cleanup) — the scr_net.c ownership story verbatim, so a
 * listener capturing its own socket cannot cycle past settlement.
 *
 * Event dispatch. One poller owned by this unit (lazily created), fds
 * non-blocking. The loop (scr_async.c) calls scr_dgram_dispatch() at
 * every turn top — the net hook's exact shape — alternating a SWEEP of
 * deferred emits ('listening'/'connect' callbacks, bind/send failures,
 * 'close', pending dns.lookup deliveries) with a zero-timeout poller
 * drain (arrived datagrams, delivered macrotask-style on the main
 * stack), stopping early when a callback enqueued microtasks or threw.
 * Between turns the loop's idle poll(2) watches this unit's poller fd.
 *
 * Read model. Consumer-driven like net sockets: the read filter is armed
 * only while a 'message' listener exists — unheard datagrams wait in
 * the kernel's socket buffer (and drop when it fills, UDP's contract
 * in Node too). One recvfrom(2) per datagram, one 'message' emit per
 * datagram, rinfo parts delivered borrowed to the per-shape adapters.
 *
 * Send model. sendto(2) immediately — a UDP datagram either goes out or
 * it doesn't; there is no partial-write buffering. An unbound sender
 * implicit-binds (the kernel's ephemeral port), like Node. Send
 * failures defer to the 'error' sweep.
 *
 * State errors, Node-matched: bind on a bound socket throws "Socket is
 * already bound"; connect on a connected one "Already connected";
 * send/close/address on a closed (or address on a never-bound) one
 * "Not running" — all synchronous catchable Errors with Node's
 * MESSAGES (the code/errno properties don't exist — the fs error
 * stance, SEMANTICS.md divergence 13). Runtime failures (EADDRINUSE,
 * unreachable sends, failed host lookups) are the async 'error' event;
 * an 'error' with no listener prints and exits 1, the unhandled
 * EventEmitter behavior. bind()/connect() emit 'listening' (connect
 * implicit-binds first, so BOTH fire, Node's order) and 'connect' on
 * the next dispatch pass — Node's next-tick emits.
 *
 * Loop liveness. An open (bound or connected) socket holds the loop
 * until 'close' delivers or unref() waives it — Node's unref
 * semantics; ref() re-arms. A created-but-never-bound socket holds
 * nothing. Handles abandoned at exit are released by the atexit
 * cleanup, so the RC audit stays clean.
 *
 * dns.lookup. getaddrinfo(AF_INET) runs AT CALL TIME — synchronously,
 * where Node uses its threadpool (SEMANTICS.md documents the blocking
 * divergence) — and the callback defers to the next dispatch pass, so
 * delivery is async like Node's. Failures deliver Node's message shape
 * ("getaddrinfo ENOTFOUND <hostname>") through the per-union adapters;
 * the address argument is "" on failure where Node passes undefined
 * (the string-typed slot cannot hold undefined). A pending lookup
 * holds the loop like an in-flight request. */
#include "scr_platform.h"
#include "scr_runtime.h"
#include "scr_system_errors.h"
#include "scr_dgram_private.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h> /* getaddrinfo/EAI_*, inet_pton/ntop, socklen_t */
#include <process.h> /* _getpid */
#else
#include <netdb.h>
#include <net/if.h> /* if_nametoindex */
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/stat.h> /* bind({ fd }): the descriptor kind Node guesses */
#endif

#include "scr_system_error_event.h"

static void scr_dgram_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

#ifdef _WIN32
/* ── the winsock arm (scr_net.c's respelling, restated so this unit links
 * without scr_net.c — the listener-list precedent below) ───────────────
 * The BSD socket calls this file speaks, respelled once so every call
 * site stays byte-identical: SOCKETs narrow through the int fd contract,
 * failures land their WSA code in errno TRANSLATED to the POSIX constant
 * scr_dgram_errname and the retry tests read (libuv performs the same
 * translation for Node, so the spellings agree with the Windows oracle),
 * and close is closesocket. WSAStartup rides scrp_poller_new
 * (scr_loop_wsapoll.c): every socket() site is preceded by
 * scr_dgram_poller_init(), and scr_dns_lookup initializes the poller on
 * this arm before getaddrinfo (which needs winsock started too). The
 * netdb surface (getaddrinfo/freeaddrinfo, the EAI_* codes) is native
 * winsock — ws2tcpip.h spells Node's exact codes, WSAHOST_NOT_FOUND
 * being EAI_NONAME. */
static int scr_dgram_w32_map_err(int e) {
  switch (e) {
  case WSAEWOULDBLOCK: return EAGAIN;
  case WSAEINTR: return EINTR;
  case WSAECONNREFUSED: return ECONNREFUSED;
  case WSAECONNRESET: return ECONNRESET;
  case WSAEADDRINUSE: return EADDRINUSE;
  case WSAEACCES: return EACCES;
  case WSAEADDRNOTAVAIL: return EADDRNOTAVAIL;
  case WSAEHOSTUNREACH: return EHOSTUNREACH;
  case WSAENETUNREACH: return ENETUNREACH;
  case WSAEMSGSIZE: return EMSGSIZE;
  case WSAEINVAL: return EINVAL;
  case WSAENOPROTOOPT: return ENOPROTOOPT;
  case WSAEAFNOSUPPORT: return EAFNOSUPPORT;
  case WSAENOBUFS: return ENOBUFS;
  default: return e;
  }
}

static void scr_dgram_w32_seterr(void) { errno = scr_dgram_w32_map_err((int)WSAGetLastError()); }

static int scr_dgram_w32_socket(int af, int type, int proto) {
  SOCKET s = socket(af, type, proto);
  if (s == INVALID_SOCKET) {
    scr_dgram_w32_seterr();
    return -1;
  }
  return (int)s;
}

static int scr_dgram_w32_bind(int fd, const struct sockaddr *sa, socklen_t len) {
  if (bind((SOCKET)fd, sa, (int)len) != 0) {
    scr_dgram_w32_seterr();
    return -1;
  }
  return 0;
}

/* UDP connect(2) is local and immediate on winsock too — no EINPROGRESS
 * arm, unlike scr_net.c's stream wrapper. */
static int scr_dgram_w32_connect(int fd, const struct sockaddr *sa, socklen_t len) {
  if (connect((SOCKET)fd, sa, (int)len) != 0) {
    scr_dgram_w32_seterr();
    return -1;
  }
  return 0;
}

static int scr_dgram_w32_getsockname(int fd, struct sockaddr *sa, socklen_t *len) {
  int ilen = (int)*len;
  int rc = getsockname((SOCKET)fd, sa, &ilen);
  *len = (socklen_t)ilen;
  if (rc != 0) {
    scr_dgram_w32_seterr();
    return -1;
  }
  return 0;
}

static int scr_dgram_w32_setsockopt(int fd, int level, int name, const void *val, socklen_t len) {
  if (setsockopt((SOCKET)fd, level, name, (const char *)val, (int)len) != 0) {
    scr_dgram_w32_seterr();
    return -1;
  }
  return 0;
}

static int scr_dgram_w32_getsockopt(int fd, int level, int name, void *val, socklen_t *len) {
  int ilen = (int)*len;
  int rc = getsockopt((SOCKET)fd, level, name, (char *)val, &ilen);
  *len = (socklen_t)ilen;
  if (rc != 0) {
    scr_dgram_w32_seterr();
    return -1;
  }
  return 0;
}

static ssize_t scr_dgram_w32_sendto(int fd, const void *buf, size_t len, int flags,
                                     const struct sockaddr *sa, socklen_t salen) {
  int n = sendto((SOCKET)fd, (const char *)buf, len > 0x40000000 ? 0x40000000 : (int)len, flags,
                 sa, (int)salen);
  if (n < 0) scr_dgram_w32_seterr();
  return n;
}

static ssize_t scr_dgram_w32_recvfrom(int fd, void *buf, size_t len, int flags,
                                       struct sockaddr *sa, socklen_t *salen) {
  int ilen = salen != NULL ? (int)*salen : 0;
  int n = recvfrom((SOCKET)fd, (char *)buf, len > 0x40000000 ? 0x40000000 : (int)len, flags, sa,
                   salen != NULL ? &ilen : NULL);
  if (salen != NULL) *salen = (socklen_t)ilen;
  if (n < 0) scr_dgram_w32_seterr();
  return n;
}

static int scr_dgram_w32_close(int fd) {
  if (closesocket((SOCKET)fd) != 0) {
    scr_dgram_w32_seterr();
    return -1;
  }
  return 0;
}

#define socket(af, type, proto) scr_dgram_w32_socket((af), (type), (proto))
#define bind(fd, sa, len) scr_dgram_w32_bind((fd), (sa), (len))
#define connect(fd, sa, len) scr_dgram_w32_connect((fd), (sa), (len))
#define getsockname(fd, sa, len) scr_dgram_w32_getsockname((fd), (sa), (len))
#define setsockopt(fd, l, n, v, len) scr_dgram_w32_setsockopt((fd), (l), (n), (v), (len))
#define getsockopt(fd, l, n, v, len) scr_dgram_w32_getsockopt((fd), (l), (n), (v), (len))
#define sendto(fd, buf, len, fl, sa, salen) scr_dgram_w32_sendto((fd), (buf), (len), (fl), (sa), (salen))
#define recvfrom(fd, buf, len, fl, sa, salen) scr_dgram_w32_recvfrom((fd), (buf), (len), (fl), (sa), (salen))
#define close(fd) scr_dgram_w32_close(fd)
#endif /* _WIN32 */

/* Nonblocking + no-inherit, the scr_net.c spelling. The win32 arm also
 * turns OFF winsock's UDP connection-reset relay (an ICMP port-
 * unreachable from a PAST send failing a FUTURE recvfrom with
 * WSAECONNRESET) via SIO_UDP_CONNRESET — libuv does exactly this for
 * every Node UDP socket, so leaving it on would diverge from the
 * Windows oracle. */
static void scr_dgram_nonblock(int fd) {
#ifdef _WIN32
  u_long one = 1;
  ioctlsocket((SOCKET)fd, FIONBIO, &one);
  SetHandleInformation((HANDLE)(SOCKET)fd, HANDLE_FLAG_INHERIT, 0);
#ifndef SIO_UDP_CONNRESET
#define SIO_UDP_CONNRESET _WSAIOW(IOC_VENDOR, 12)
#endif
  BOOL off = FALSE;
  DWORD bytes = 0;
  WSAIoctl((SOCKET)fd, SIO_UDP_CONNRESET, &off, sizeof off, NULL, 0, &bytes, NULL, NULL);
#else
  fcntl(fd, F_SETFL, O_NONBLOCK);
  fcntl(fd, F_SETFD, FD_CLOEXEC);
#endif
}

/* Node's error-code names for the socket errors this slice can meet. */
static const char *scr_dgram_errname(int err) {
  switch (err) {
  case EADDRINUSE: return "EADDRINUSE";
  case EACCES: return "EACCES";
  case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
  case ECONNREFUSED: return "ECONNREFUSED";
  case EHOSTUNREACH: return "EHOSTUNREACH";
  case ENETUNREACH: return "ENETUNREACH";
  case EMSGSIZE: return "EMSGSIZE";
  case EINVAL: return "EINVAL";
  case EBADF: return "EBADF";
  case ENOPROTOOPT: return "ENOPROTOOPT";
  case EAFNOSUPPORT: return "EAFNOSUPPORT";
  case ENOBUFS: return "ENOBUFS";
  case ENOMEM: return "ENOMEM";
  case EPERM: return "EPERM";
  case ENODEV: return "ENODEV";
  default: return "EUNKNOWN";
  }
}

/* ── listener lists (the scr_net.c snapshot discipline, restated so this
 * unit links without scr_net.c) ─────────────────────────────────────── */


static void scr_dgram_ls_add(ScrDgramLs *l, ScrClosure *cb, void *fn, bool once) {
  if (l->n == l->cap) {
    l->cap = l->cap ? l->cap * 2 : 2;
    l->ls = realloc(l->ls, l->cap * sizeof *l->ls);
    if (!l->ls) scr_dgram_oom();
  }
  l->ls[l->n].cb = cb;
  l->ls[l->n].fn = fn;
  l->ls[l->n].once = once;
  l->n++;
}

static void scr_dgram_ls_drop(ScrDgramLs *l) {
  for (size_t i = 0; i < l->n; i++) scr_closure_release(l->ls[i].cb);
  free(l->ls);
  l->ls = NULL;
  l->n = l->cap = 0;
}

/* Snapshot for a firing pass: entries retained; `once` entries leave the
 * LIVE list before their callback runs. */
static size_t scr_dgram_ls_snapshot(ScrDgramLs *l, ScrDgramL **out) {
  size_t n = l->n;
  if (n == 0) {
    *out = NULL;
    return 0;
  }
  ScrDgramL *snap = malloc(n * sizeof *snap);
  if (!snap) scr_dgram_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = l->ls[i];
    scr_closure_retain(snap[i].cb);
  }
  size_t w = 0;
  for (size_t i = 0; i < l->n; i++) {
    if (l->ls[i].once) {
      scr_closure_release(l->ls[i].cb);
    } else {
      l->ls[w++] = l->ls[i];
    }
  }
  l->n = w;
  *out = snap;
  return n;
}

static void scr_dgram_fire0(ScrDgramLs *l) {
  ScrDgramL *snap;
  size_t n = scr_dgram_ls_snapshot(l, &snap);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
    scr_closure_release(snap[i].cb);
  }
  free(snap);
}

/* Take the listener just added off a list without firing it (the caller
 * owns the reference): a connect callback Node removes from 'connect'
 * when the connect fails before it can emit. */
static ScrClosure *scr_dgram_ls_pop_last(ScrDgramLs *l) {
  if (l->n == 0) return NULL;
  return l->ls[--l->n].cb;
}

/* 'error' with NO listener is fatal, like Node's unhandled EventEmitter
 * 'error' (the scr_net.c stance — _Exit skips atexit on purpose). */
static void scr_dgram_fire_err(ScrDgramLs *l, ScrStr *msg, const char *code,
                               ScrError *err_obj) {
  if (l->n == 0) {
    scr_stdout_settle();
    fflush(stdout);
    fprintf(stderr, "Unhandled 'error' event: Error: %s\n", msg->data);
    _Exit(1);
  }
  /* Node's error object for the message: errno, code and syscall, plus the
   * address and port (or hostname) the detail names; a message that names
   * no system error takes pending_code instead (ERR_IP_BLOCKED). Every
   * listener receives the same object. */
  ScrError *system = err_obj != NULL
                         ? scr_error_retain(err_obj)
                         : (code != NULL ? scr_error_new(SCR_ERR_ERROR, msg)
                                         : scr_system_error_from_message(msg));
  if (system != NULL && err_obj == NULL && code != NULL)
    system->code = scr_str_new(code, strlen(code));
  ScrError *saved = scr_event_error_payload;
  if (system != NULL) scr_event_error_payload = system;
  ScrDgramL *snap;
  size_t n = scr_dgram_ls_snapshot(l, &snap);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((ScrChildErrFn)snap[i].fn)(snap[i].cb, msg);
    scr_closure_release(snap[i].cb);
  }
  free(snap);
  scr_event_error_payload = saved;
  if (system != NULL) scr_error_release(system);
}

/* ── the handle ──────────────────────────────────────────────────────── */


#ifdef SCR_RC_AUDIT
static SCR_TL long scr_dgram_live = 0;
long scr_dgram_live_count(void) { return scr_dgram_live; }
#endif

static SCR_TL ScrDgramSocket *scr_dgram_socks = NULL; /* registry: +1 each, tail-appended */
static SCR_TL ScrPoller *scr_dgram_poller = NULL;

/* Deferred emits (a pending 'listening'/'connect'/'error', a queued dns
 * delivery) have no descriptor to wait on, so the poll would sleep until
 * the program's next timer and the emit would land late or behind a close.
 * A zero-delay timer on the unit's own poller wakes it for the dispatch in
 * the same turn. */
static char scr_dgram_wake_key;
/* Per thread: each worker owns its poller, so one thread's armed timer
 * must not suppress another's wake. */
static SCR_TL bool scr_dgram_wake_armed;

static void scr_dgram_wake(void) {
  if (scr_dgram_poller == NULL || scr_dgram_wake_armed) return;
  scr_dgram_wake_armed = scrp_timer_arm(scr_dgram_poller, &scr_dgram_wake_key, 0, &scr_dgram_wake_key);
}

/* Pending dns.lookup deliveries (already resolved — getaddrinfo ran at
 * the call; the sweep fires them FIFO). */
typedef struct ScrDnsPending {
  ScrClosure *cb; /* +1, or NULL for a dyn call */
  ScrDyn *call;   /* a dyn [callback, ...args] array (+1), or NULL */
  ScrDnsLookupFn fn;
  ScrStr *errmsg; /* +1 or NULL (success) */
  ScrStr *addr;   /* +1 ("" on failure) */
  double family;
  struct ScrDnsPending *next;
} ScrDnsPending;

static SCR_TL ScrDnsPending *scr_dns_pending = NULL;

/* The stub resolver's loop share and default-resolver server reading
 * (scr_dns_resolve.c, linked only for programs that use it — the
 * scr_dns_resolve_install story). NULL for dgram-only programs. */
const ScrDnsqHooks *scr_dnsq_hooks = NULL;
ScrDyn *(*scr_dns_servers_hook)(bool promises) = NULL;

/* ── RC ──────────────────────────────────────────────────────────────── */

static void scr_dgram_close_fd_raw(int fd); /* forget-then-close, defined below */

ScrDgramSocket *scr_dgram_retain(ScrDgramSocket *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_dgram_release(ScrDgramSocket *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    scr_dgram_ls_drop(&s->msg_ls);
    scr_dgram_ls_drop(&s->err_ls);
    scr_dgram_ls_drop(&s->listening_ls);
    scr_dgram_ls_drop(&s->close_ls);
    scr_dgram_ls_drop(&s->conn_ls);
    scr_str_release(s->pending_err);
    scr_error_release(s->pending_err_obj);
    scr_dyn_release(s->send_block_list);
    scr_dyn_release(s->recv_block_list);
    scr_dyn_release(s->abort_dispose);
    scr_dyn_release(s->lookup);
    if (s->fd >= 0) scr_dgram_close_fd_raw(s->fd);
#ifdef SCR_RC_AUDIT
    scr_dgram_live--;
#endif
    free(s);
  }
}

void *scr_dgram_retain_v(void *p) { return scr_dgram_retain((ScrDgramSocket *)p); }
void scr_dgram_release_v(void *p) { scr_dgram_release((ScrDgramSocket *)p); }

/* ── poller plumbing (the scr_platform.h seam; read-only subset) ─────── */

static bool scr_dgram_poller_init(void) {
  if (scr_dgram_poller != NULL) return true;
  scr_dgram_poller = scrp_poller_new();
  return scr_dgram_poller != NULL;
}

/* Registration failures ignored exactly as kevent's always were. */
static void scr_dgram_watch_read(int fd, void *udata, bool on) {
  if (scr_dgram_poller == NULL || fd < 0) return;
  (void)scrp_watch_read(scr_dgram_poller, fd, udata, on);
}

/* Forget-then-close — the epoll obligation (scr_platform.h); the kqueue
 * backend's forget is a no-op, so macOS keeps its historical sequence. */
static void scr_dgram_close_fd_raw(int fd) {
  if (fd < 0) return;
  if (scr_dgram_poller != NULL) scrp_forget(scr_dgram_poller, fd);
  close(fd);
}

/* Consumer-driven read arming (the net-socket discipline). */
static void scr_dgram_update_read(ScrDgramSocket *s) {
  bool want = s->fd >= 0 && s->msg_ls.n > 0;
  if (want && !s->read_armed) {
    scr_dgram_watch_read(s->fd, s, true);
    s->read_armed = true;
  } else if (!want && s->read_armed) {
    scr_dgram_watch_read(s->fd, s, false);
    s->read_armed = false;
  }
}

/* ── registry ────────────────────────────────────────────────────────── */

static void scr_dgram_register(ScrDgramSocket *s) {
  if (s->in_registry) return;
  s->in_registry = true;
  s->next = NULL;
  ScrDgramSocket **link = &scr_dgram_socks;
  while (*link) link = &(*link)->next;
  *link = scr_dgram_retain(s);
  scr_dgram_wake();
}

static void scr_dgram_unregister(ScrDgramSocket *s) {
  if (!s->in_registry) return;
  ScrDgramSocket **link = &scr_dgram_socks;
  while (*link && *link != s) link = &(*link)->next;
  if (*link) {
    *link = s->next;
    s->next = NULL;
    s->in_registry = false;
    scr_dgram_release(s);
  }
}

/* Whether a poll key still names a socket of this unit. The dns queries
 * share this poller and free their keys from inside a drain
 * (scr_dnsq_finish), so a copied batch can name a key that owns nothing any
 * more: the dispatch must not read it as a socket. The drain order is not a
 * guard by itself — epoll appends expired timers after the socket events,
 * but kqueue copies the kernel's order, where a timeout that exhausts a
 * query can come before that query's readiness. Every socket with an armed
 * read is registered (bind/connect/send register it), and settlement happens
 * in the sweep before the next drain, so membership is stable for a batch. */
static bool scr_dgram_key_is_socket(const void *udata) {
  for (ScrDgramSocket *s = scr_dgram_socks; s != NULL; s = s->next)
    if ((const void *)s == udata) return true;
  return false;
}

/* ── the surface ─────────────────────────────────────────────────────── */

ScrDgramSocket *scr_dgram_create(bool v6, bool reuse_addr, bool ipv6_only, bool reuse_port,
                                 double recv_size, double send_size) {
  ScrDgramSocket *s = calloc(1, sizeof *s);
  if (!s) scr_dgram_oom();
  s->rc = 1;
  s->fd = -1;
  s->v6 = v6;
  s->reuse_addr = reuse_addr;
  s->ipv6_only = ipv6_only;
  s->reuse_port = reuse_port;
  s->init_recv_size = recv_size;
  s->init_send_size = send_size;
#ifdef SCR_RC_AUDIT
  scr_dgram_live++;
#endif
  return s;
}

ScrStr *scr_dgram_type_str(ScrDgramSocket *s) {
  return scr_str_new(s->v6 ? "udp6" : "udp4", 4);
}

static void scr_dgram_throw(const char *msg) {
  /* Node's state errors carry their ERR_SOCKET_* codes; the message IS
   * the discriminant (each arm throws exactly one text). */
  const char *code =
      strcmp(msg, "Already connected") == 0 ? "ERR_SOCKET_DGRAM_IS_CONNECTED"
      : strcmp(msg, "Not running") == 0 ? "ERR_SOCKET_DGRAM_NOT_RUNNING"
      : strcmp(msg, "Socket is already bound") == 0 ? "ERR_SOCKET_ALREADY_BOUND"
      : NULL;
  if (code != NULL) {
    scr_throw_error_msg_code(0 /* Error */, msg, strlen(msg), code);
  } else {
    scr_throw_error_msg(0 /* Error */, msg, strlen(msg));
  }
}

/* snprintf's STORED length: the formatted text when it fit, else the
 * capacity minus the terminator. Callers hand this length to an error
 * constructor, which copies it — truncation must never overrun the
 * destination (a long Received tail could otherwise disclose stack
 * bytes). */
static size_t scr_dgram_fmt_len(int n, size_t cap) {
  if (n < 0) return 0;
  return (size_t)n < cap ? (size_t)n : cap - 1;
}

/* An error whose tail is a value's rendering (scr_dyn_specific_type):
 * built in the growing JSON buffer so a long BigInt or Symbol description
 * is copied in full, `head` ending just before the rendering. */
static void scr_dgram_throw_received(int kind, const char *code, const char *head, const ScrDyn *v,
                                     const char *tail) {
  char detail[1024];
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, head);
  scr_jb_puts(&b, scr_dyn_specific_type(v, detail, sizeof detail));
  scr_jb_puts(&b, tail);
  ScrStr *text = scr_jb_finish(&b);
  scr_throw_error_msg_code(kind, text->data, text->len, code);
  scr_str_release(text);
}

/* Forward declarations: the helpers below the socket surface. */
static bool scr_dgram_ip6(const char *text, struct in6_addr *addr, unsigned *scope);
static bool scr_dgram_dyn_truthy(const ScrDyn *v);
static void scr_dgram_throw_errno(int err, const char *syscall);
static void scr_dgram_throw_exception_host_port(int err, const char *syscall, const char *ip,
                                                int port);
static void scr_dgram_apply_init_buffers(ScrDgramSocket *s);
static bool scr_dgram_send_blocked(ScrDgramSocket *s, const char *ip, int family);
static ScrDyn *scr_dgram_blocked_error(const char *ip);
static ScrDyn *scr_dgram_send_error(const char *msg);
static void scr_dns_call_later(const ScrDyn *callback, ScrDyn **args, size_t argc, bool tick);

/* A JS number as V8 prints it in an error's Received tail ("70000",
 * "1.5", "NaN", "Infinity"). Integer-valued doubles print without a
 * fraction. */
static void scr_dgram_number_text(double v, char *buf, size_t cap) {
  if (v != v) {
    snprintf(buf, cap, "NaN");
  } else if (isinf(v)) {
    snprintf(buf, cap, v < 0 ? "-Infinity" : "Infinity");
  } else if (trunc(v) == v && v >= -9007199254740992.0 && v <= 9007199254740992.0) {
    snprintf(buf, cap, "%.0f", v);
  } else {
    snprintf(buf, cap, "%.17g", v);
  }
}

/* Node's ERR_INVALID_ARG_VALUE: "The property|argument 'name' <reason>.
 * Received <inspected>" (the inspection truncated at 128 characters, the
 * way Node truncates it). */
static void scr_dgram_throw_invalid_arg_value(const char *name, const ScrStr *value,
                                              const char *reason) {
  ScrStr *shown = scr_str_inspect_quoted(value, true);
  bool cut = shown->len > 128;
  char text[256];
  int n = snprintf(text, sizeof text, "The %s '%s' %s. Received %.*s%s",
                   strchr(name, '.') != NULL ? "property" : "argument", name, reason,
                   (int)(cut ? 128 : shown->len), shown->data, cut ? "..." : "");
  scr_str_release(shown);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text, scr_dgram_fmt_len(n, sizeof text), "ERR_INVALID_ARG_VALUE");
}

/* Node's validatePort(port, name, allowZero): an integer in 0..65535
 * (1..65535 when zero is not allowed). Throws ERR_SOCKET_BAD_PORT, a
 * RangeError, with Node's Received tail. False with the error pending. */
static bool scr_dgram_valid_port(double port, const char *name, bool allow_zero) {
  if (port >= 0 && port <= 65535 && trunc(port) == port && (allow_zero || port != 0)) return true;
  char shown[48];
  scr_dgram_number_text(port, shown, sizeof shown);
  char text[192];
  int n = snprintf(text, sizeof text, "%s should be %s 0 and < 65536. Received type number (%s).",
                   name, allow_zero ? ">=" : ">", shown);
  scr_throw_error_msg_code(SCR_ERR_RANGE, text, scr_dgram_fmt_len(n, sizeof text), "ERR_SOCKET_BAD_PORT");
  return false;
}

/* Fill a sockaddr for this socket's family: "" is the wildcard (bind's
 * default address), "localhost" pins the family's loopback (the net
 * stance), and every other host must be a numeric literal. False for a
 * non-numeric host — the caller defers Node's ENOTFOUND. */
static bool scr_dgram_host_addr(const ScrDgramSocket *s, const char *host, uint16_t port,
                                struct sockaddr_storage *out, socklen_t *outlen) {
  memset(out, 0, sizeof *out);
  if (s->v6) {
    struct sockaddr_in6 *a = (struct sockaddr_in6 *)out;
    a->sin6_family = AF_INET6;
    a->sin6_port = htons(port);
    if (host[0] == '\0') {
      a->sin6_addr = in6addr_any;
      *outlen = (socklen_t)sizeof *a;
      return true;
    }
    if (strcmp(host, "localhost") == 0) host = "::1";
    unsigned scope = 0;
    struct in6_addr addr;
    if (!scr_dgram_ip6(host, &addr, &scope)) return false;
    a->sin6_addr = addr;
    a->sin6_scope_id = scope;
    *outlen = (socklen_t)sizeof *a;
    return true;
  }
  struct sockaddr_in *a = (struct sockaddr_in *)out;
  a->sin_family = AF_INET;
  a->sin_port = htons(port);
  *outlen = (socklen_t)sizeof *a;
  if (host[0] == '\0') {
    a->sin_addr.s_addr = INADDR_ANY;
    return true;
  }
  if (strcmp(host, "localhost") == 0) host = "127.0.0.1";
  return inet_pton(AF_INET, host, &a->sin_addr) == 1;
}

/* A numeric literal this socket's family parses (the synchronous bind and
 * connect take literals only: Node performs no name resolution there). */
static bool scr_dgram_numeric_host(const ScrDgramSocket *s, const char *text) {
  if (s->v6) {
    struct in6_addr addr;
    unsigned scope = 0;
    return scr_dgram_ip6(text, &addr, &scope);
  }
  struct in_addr addr;
  return inet_pton(AF_INET, text, &addr) == 1;
}

/* The address text Node's ExceptionWithHostPort prints ("bind EADDRINUSE
 * 0.0.0.0:4000", "::1:4000" for udp6 — no brackets). */
static void scr_dgram_sockaddr_ip(const struct sockaddr_storage *sa, char *buf, size_t cap) {
  if (sa->ss_family == AF_INET6) {
    if (inet_ntop(AF_INET6, &((const struct sockaddr_in6 *)sa)->sin6_addr, buf, cap) == NULL)
      snprintf(buf, cap, "::");
  } else if (inet_ntop(AF_INET, &((const struct sockaddr_in *)sa)->sin_addr, buf, cap) == NULL) {
    snprintf(buf, cap, "0.0.0.0");
  }
}

/* Create the fd (idempotent). Aborts only on resource exhaustion, the
 * scr_net.c socket() stance. */
static void scr_dgram_ensure_fd(ScrDgramSocket *s) {
  if (s->fd >= 0) return;
  if (!scr_dgram_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  int fd = socket(s->v6 ? AF_INET6 : AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) {
    fputs("scriptc: socket() failed\n", stderr);
    abort();
  }
  scr_dgram_nonblock(fd);
  if (s->reuse_addr) {
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, (const void *)&one, sizeof one);
  }
#ifdef SO_REUSEPORT
  if (s->reuse_port) {
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, (const void *)&one, sizeof one);
  }
#else
  (void)s->reuse_port; /* libuv answers ENOTSUP on these platforms; a
                          bind that ignores the flag is the close match */
#endif
  if (s->v6 && s->ipv6_only) {
    int one = 1;
    setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, (const void *)&one, sizeof one);
  }
  s->fd = fd;
}

/* Node's startReceiving applies the constructor's recv/send buffer sizes
 * once the socket begins receiving. A setsockopt failure is ignored (Node
 * would throw inside its own callback; the sizes are best-effort here). */
static void scr_dgram_apply_init_buffers(ScrDgramSocket *s) {
  if (s->fd < 0) return;
  int value;
  if (s->init_recv_size > 0 && s->init_recv_size <= 2147483647.0) {
    value = (int)s->init_recv_size;
    setsockopt(s->fd, SOL_SOCKET, SO_RCVBUF, (const void *)&value, sizeof value);
  }
  if (s->init_send_size > 0 && s->init_send_size <= 2147483647.0) {
    value = (int)s->init_send_size;
    setsockopt(s->fd, SOL_SOCKET, SO_SNDBUF, (const void *)&value, sizeof value);
  }
}

static void scr_dgram_defer_err(ScrDgramSocket *s, const char *msg) {
  if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
  scr_dgram_register(s); /* the sweep delivers it */
  scr_dgram_wake();
}

/* The same for a resolver failure: the program's own error object (`err`,
 * nullable) is kept and delivered as the event payload, as Node hands the
 * resolver's error through unchanged. */
static void scr_dgram_defer_lk_err(ScrDgramSocket *s, const char *msg, const ScrDyn *err) {
  if (!s->pending_err && s->pending_err_obj == NULL && err != NULL)
    s->pending_err_obj = scr_dyn_error_value(err);
  if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
  scr_dgram_register(s);
  scr_dgram_wake();
}

/* A settled socket drops the program's resolver, as Node's handle does when
 * it is destroyed: a resolver that captures the socket (or the transport
 * owning it) must not keep the closed socket and its captured data alive. */
static void scr_dgram_drop_lookup(ScrDgramSocket *s) {
  scr_dyn_release(s->lookup);
  s->lookup = NULL;
}

/* ── createSocket({ lookup }): a program's own resolver ────────────────
 * Node's internal dgram handle carries a `lookup(address, family, cb)` and
 * calls it from bind, connect and every unconnected send — its default
 * short-circuits IP literals and defers through dns.lookup. A custom
 * resolver answers `cb(err, ip)`; the operation continues from that answer,
 * synchronously when the resolver called back synchronously, as Node's
 * does. The family argument is 4 or 6 for the socket's family. A connect or
 * send on an unbound socket resolves the implicit bind's address first
 * ("0.0.0.0"/"::"), as Node's bind({ port: 0 }) does, then the target. */

static void scr_dns_call_later(const ScrDyn *callback, ScrDyn **args, size_t argc, bool tick);
static void scr_dgram_send_raw(ScrDgramSocket *s, const char *data, size_t len, double port,
                               ScrStr *host);
static void scr_dgram_send_out(ScrDgramSocket *s, const char *data, size_t len, double port,
                               const ScrStr *host, const ScrDyn *callback);
static ScrDyn *scr_dgram_send_error(const char *msg);
static bool scr_dgram_connect_has_dyn(const ScrDyn *dyn_cb);
static void scr_dgram_connect_fail_dyn(const ScrDyn *dyn_cb, ScrDyn *err);
static void scr_dgram_connect_impl(ScrDgramSocket *s, double port, ScrStr *host, ScrClosure *cb,
                                   const ScrDyn *dyn_cb);

typedef enum {
  SCR_DGRAM_LK_BIND,
  SCR_DGRAM_LK_CONNECT,
  SCR_DGRAM_LK_SEND_RAW,
  SCR_DGRAM_LK_SEND_DYN
} ScrDgramLkOp;

typedef struct ScrDgramLkJob {
  size_t rc;          /* the callback box's reference */
  ScrDgramSocket *s;  /* +1 */
  ScrDgramLkOp op;
  char *address;      /* the text the current stage hands the resolver */
  char *target;       /* the operation's own address, parked during the
                       * implicit-bind stage (malloc) */
  int stage;          /* 1 = the implicit bind's address, 0 = the target */
  double port;
  ScrClosure *cb;     /* +1: bind's listening / connect's connect callback */
  char *data;         /* SEND_*: the payload */
  size_t len;
  ScrDyn *send_cb;    /* +1: the send completion (SEND_DYN) */
  ScrDyn *dyn_cb;     /* +1: connect's checked-dynamic completion */
  ScrDyn *fn;         /* +1: the resolver itself */
  bool done;          /* the current stage's first answer wins */
} ScrDgramLkJob;

static void scr_dgram_lk_job_destroy(ScrDgramLkJob *job) {
  scr_dgram_release(job->s);
  scr_closure_release(job->cb);
  scr_dyn_release(job->send_cb);
  scr_dyn_release(job->dyn_cb);
  scr_dyn_release(job->fn);
  free(job->address);
  free(job->target);
  free(job->data);
  free(job);
}

static void *scr_dgram_lk_job_retain(void *p) {
  ScrDgramLkJob *job = p;
  job->rc++;
  return job;
}

static void scr_dgram_lk_job_release(void *p) {
  ScrDgramLkJob *job = p;
  if (--job->rc == 0) scr_dgram_lk_job_destroy(job);
}

/* The failure text a lookup error carries: its `message` when it is an
 * Error-like value, else the value's string form (Node hands the program's
 * own error through; this re-raises an equivalent Error, see the row). */
static void scr_dgram_lk_error_message(const ScrDyn *err, char *out, size_t cap) {
  out[0] = 0;
  if (err == NULL) return;
  if (err->kind == SCR_DYN_STR) {
    size_t n = err->v.str->len < cap - 1 ? err->v.str->len : cap - 1;
    memcpy(out, err->v.str->data, n);
    out[n] = 0;
    return;
  }
  const ScrDyn *msg = NULL;
  if (err->kind == SCR_DYN_OBJ) msg = scr_dyn_obj_get(err, "message", 7);
  if (msg != NULL && msg->kind == SCR_DYN_STR) {
    size_t n = msg->v.str->len < cap - 1 ? msg->v.str->len : cap - 1;
    memcpy(out, msg->v.str->data, n);
    out[n] = 0;
    return;
  }
  snprintf(out, cap, "getaddrinfo failed");
}

/* The implicit bind a connect/send on an unbound socket performs, at the
 * address the resolver answered for Node's bind({ port: 0 }) call. Answers
 * false with the failure already reported. */
static bool scr_dgram_lk_bind_implicit(ScrDgramSocket *s, ScrStr *host) {
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  if (!scr_dgram_host_addr(s, host->data, 0, &sa, &salen)) {
    char msg[192];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", host->data);
    scr_dgram_defer_err(s, msg);
    return false;
  }
  scr_dgram_ensure_fd(s);
  if (bind(s->fd, (struct sockaddr *)&sa, salen) != 0) {
    char ip[64] = "";
    scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
    char msg[128];
    snprintf(msg, sizeof msg, "bind %s %s", scr_dgram_errname(errno), ip);
    scr_dgram_defer_err(s, msg);
    return false;
  }
  s->bound = true;
  s->emit_listening = true;
  scr_dgram_apply_init_buffers(s);
  scr_dgram_register(s);
  scr_dgram_update_read(s);
  return true;
}

static void scr_dgram_lk_invoke(ScrDgramSocket *s, ScrDgramLkJob *job);

/* The resolver's answer: continue the operation the job was started for. */
static ScrDyn *scr_dgram_lk_cb(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrDgramLkJob *job = scr_box_get_ref(clo->caps[0]); /* +1 */
  if (job == NULL) return scr_dyn_retain(scr_dyn_undefined());
  if (!job->done) {
    job->done = true;
    ScrDgramSocket *s = job->s;
    /* closed while the resolver was pending: Node's handle is gone, so the
     * answer runs no completion and creates no descriptor */
    if (s->closing || s->close_emitted) {
      scr_dgram_lk_job_release(job);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    const ScrDyn *err = argc > 0 ? args[0] : NULL;
    const ScrDyn *ip = argc > 1 ? args[1] : NULL;
    bool failed = err != NULL && err->kind != SCR_DYN_UNDEF && err->kind != SCR_DYN_NULL;
    if (failed && err->kind == SCR_DYN_BOOL && !err->v.b) failed = false;
    if (!failed && (ip == NULL || ip->kind != SCR_DYN_STR || ip->v.str->len == 0))
      failed = true;
    if (failed) {
      char msg[256];
      if (err != NULL && err->kind != SCR_DYN_UNDEF && err->kind != SCR_DYN_NULL) {
        scr_dgram_lk_error_message(err, msg, sizeof msg);
      } else {
        snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", job->address);
      }
      if (job->stage == 1) {
        /* the implicit bind's own resolution failed: Node answers on the
         * socket's 'error' event and abandons the operation — the send or
         * connect completion never runs */
        scr_dgram_defer_lk_err(s, msg, err);
      } else if (job->op == SCR_DGRAM_LK_SEND_DYN && job->send_cb != NULL) {
        ScrDyn *eargs[1] = { scr_dgram_send_error(msg) };
        scr_dns_call_later(job->send_cb, eargs, 1, false);
        scr_closure_release(job->cb);
        job->cb = NULL;
      } else if (job->op == SCR_DGRAM_LK_CONNECT && job->dyn_cb != NULL) {
        /* a dynamic completion receives the error object, as the
         * resolution-failure arm does; a typed one is answered on the next
         * tick with no arguments */
        scr_dgram_connect_fail_dyn(job->dyn_cb, scr_dgram_send_error(msg));
      } else if (job->op == SCR_DGRAM_LK_CONNECT && job->cb != NULL) {
        scr_next_tick(job->cb);
        job->cb = NULL;
      } else {
        scr_dgram_defer_lk_err(s, msg, err);
        scr_closure_release(job->cb);
        job->cb = NULL;
      }
      scr_dgram_lk_job_release(job);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    ScrStr *host = scr_str_new(ip->v.str->data, ip->v.str->len);
    if (job->stage == 1) {
      /* the implicit bind Node's connect/send performs first: bind at the
       * answered address, then resolve the operation's own target. A send
       * that raced an earlier implicit bind finds the socket bound. */
      if (!s->bound && !scr_dgram_lk_bind_implicit(s, host)) {
        scr_str_release(host);
        scr_closure_release(job->cb);
        job->cb = NULL;
        scr_dgram_lk_job_release(job);
        return scr_dyn_retain(scr_dyn_undefined());
      }
      free(job->address);
      job->address = job->target;
      job->target = NULL;
      job->stage = 0;
      job->done = false;
      scr_str_release(host);
      scr_dgram_lk_invoke(s, job);
      scr_dgram_lk_job_release(job);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    s->lookup_ready = true;
    switch (job->op) {
      case SCR_DGRAM_LK_BIND:
        scr_dgram_bind(s, job->port, host, job->cb);
        job->cb = NULL;
        break;
      case SCR_DGRAM_LK_CONNECT:
        scr_dgram_connect_impl(s, job->port, host, job->cb, job->dyn_cb);
        job->cb = NULL;
        scr_dyn_release(job->dyn_cb);
        job->dyn_cb = NULL;
        break;
      case SCR_DGRAM_LK_SEND_RAW:
        scr_dgram_send_raw(s, job->data, job->len, job->port, host);
        break;
      case SCR_DGRAM_LK_SEND_DYN:
        scr_dgram_send_out(s, job->data, job->len, job->port, host, job->send_cb);
        break;
    }
    s->lookup_ready = false;
    scr_str_release(host);
  }
  scr_dgram_lk_job_release(job);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* Call the resolver for the job's current address. */
static void scr_dgram_lk_invoke(ScrDgramSocket *s, ScrDgramLkJob *job) {
  ScrClosure *clo = scr_closure_new(NULL, 1);
  clo->caps[0] = scr_box_new_obj(&scr_dgram_lk_job_retain, &scr_dgram_lk_job_release, NULL);
  scr_box_set_ref(clo->caps[0], scr_dgram_lk_job_retain(job));
  ScrDyn *cb = scr_dyn_new_func(clo, &scr_dgram_lk_cb, 2, "(err, ip)", "lookupCallback");
  ScrStr *text = scr_str_new(job->address, strlen(job->address));
  ScrDyn *args[3] = { scr_dyn_new_str(text), scr_dyn_new_num(s->v6 ? 6 : 4), cb };
  ScrDyn *r = scr_dyn_call(job->fn, args, 3, "lookup");
  scr_dyn_release(r);
  for (size_t i = 0; i < 3; i++) scr_dyn_release(args[i]);
  scr_str_release(text);
}

/* Start the resolution for a new operation: an unbound connect/send asks
 * for the implicit bind's address first (Node's bind({ port: 0 })). */
static void scr_dgram_lk_start(ScrDgramSocket *s, ScrDgramLkJob *job) {
  job->rc = 1;
  job->s = scr_dgram_retain(s);
  job->fn = scr_dyn_retain(s->lookup);
  job->stage = 0;
  scr_dgram_register(s); /* a pending lookup holds the loop, like Node */
  if (!s->bound && (job->op == SCR_DGRAM_LK_CONNECT || job->op == SCR_DGRAM_LK_SEND_RAW ||
                    job->op == SCR_DGRAM_LK_SEND_DYN)) {
    job->stage = 1;
    job->target = job->address;
    job->address = strdup(s->v6 ? "::" : "0.0.0.0");
    if (!job->address) scr_dgram_oom();
  }
  scr_dgram_lk_invoke(s, job);
  /* the resolver callback's box owns the job from here: drop the starting
   * reference (a resolver that answered synchronously already released the
   * box's own). */
  scr_dgram_lk_job_release(job);
}

/* The defaulted address text Node hands its lookup per operation. */
static const char *scr_dgram_lk_address(const ScrDgramSocket *s, const ScrStr *host, bool bind) {
  if (host != NULL && host->len > 0) return host->data;
  if (bind) return s->v6 ? "::" : "0.0.0.0";
  return s->v6 ? "::1" : "127.0.0.1";
}

/* bind(port, host): binds NOW; 'listening' (and the bind callback) defer
 * to the next dispatch pass. State errors throw synchronously, runtime
 * failures defer to 'error' — both Node's split. */
void scr_dgram_bind(ScrDgramSocket *s, double port, ScrStr *host, ScrClosure *cb) {
  if (s->closing || s->close_emitted) {
    scr_closure_release(cb);
    scr_dgram_throw("Not running");
    return;
  }
  if (s->bound) {
    scr_closure_release(cb);
    scr_dgram_throw("Socket is already bound");
    return;
  }
  if (s->lookup != NULL && !s->lookup_ready) {
    /* Node resolves the bind address through its handle's lookup before
     * binding; the answer continues this bind. */
    ScrDgramLkJob *job = calloc(1, sizeof *job);
    if (!job) scr_dgram_oom();
    job->op = SCR_DGRAM_LK_BIND;
    job->address = strdup(scr_dgram_lk_address(s, host, true));
    if (!job->address) scr_dgram_oom();
    job->port = port;
    job->cb = cb;
    scr_dgram_lk_start(s, job);
    return;
  }
  if (cb) scr_dgram_ls_add(&s->listening_ls, cb, NULL, true);
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  if (!scr_dgram_host_addr(s, host->data, (uint16_t)(int)port, &sa, &salen)) {
    char msg[160];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", host->data);
    scr_dgram_defer_err(s, msg);
    return;
  }
  scr_dgram_ensure_fd(s);
  if (bind(s->fd, (struct sockaddr *)&sa, salen) != 0) {
    int err = errno;
    char ip[64];
    scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
    char msg[128];
    /* Node: "bind EADDRINUSE 0.0.0.0:4000" */
    snprintf(msg, sizeof msg, "bind %s %s:%d", scr_dgram_errname(err), ip, (int)port);
    close(s->fd); /* never watched: bind precedes any read arm */
    s->fd = -1;
    scr_dgram_defer_err(s, msg);
    return;
  }
  s->bound = true;
  s->emit_listening = true;
  scr_dgram_apply_init_buffers(s);
  scr_dgram_register(s);
  scr_dgram_update_read(s);
}

/* The kernel bind behind a send, connect or connectSync on an unbound
 * socket: Node's uv_udp_bind on the wildcard, port 0. It really binds —
 * address() answers an ephemeral port, 'listening' is emitted for it, and
 * a datagram can arrive — even when the operation is refused just after
 * (a blocked address or destination). False with the exception pending. */
static bool scr_dgram_bind_wildcard(ScrDgramSocket *s) {
  if (s->bound) return true;
  struct sockaddr_storage bsa;
  socklen_t blen = sizeof bsa;
  if (!scr_dgram_host_addr(s, "", 0, &bsa, &blen)) return false;
  scr_dgram_ensure_fd(s);
  if (bind(s->fd, (struct sockaddr *)&bsa, blen) != 0) {
    int err = errno;
    char ip[64];
    scr_dgram_sockaddr_ip(&bsa, ip, sizeof ip);
    close(s->fd);
    s->fd = -1;
    scr_dgram_throw_exception_host_port(err, "bind", ip, 0);
    return false;
  }
  s->bound = true;
  s->emit_listening = true; /* Node's implicit bind emits 'listening' */
  scr_dgram_apply_init_buffers(s);
  return true;
}

/* connect(port, host): implicit-binds (Node emits 'listening' for that,
 * then 'connect'); UDP connect(2) is local and immediate, so failures
 * here are deferred 'error's only for bad hosts. An address the socket's
 * sendBlockList blocks fails the connect itself (Node's doConnect answers
 * the callback, or emits 'error', with ERR_IP_BLOCKED). */
/* ── connect's completion callback ──────────────────────────────────────
 * A dynamic (untyped JavaScript) callback: Node registers it as
 * once('connect') and, when the connection is refused, calls it with the
 * error instead (process.nextTick(callback, ex)), which the checked
 * zero-argument closure a typed callback compiles to cannot carry. */
static void *scr_dgram_dyn_retain_v(void *p) { return scr_dyn_retain((ScrDyn *)p); }
static void scr_dgram_dyn_release_v(void *p) { scr_dyn_release((ScrDyn *)p); }

static void scr_dgram_dyn_connect_fire(ScrClosure *cb) {
  ScrDyn *fn = scr_box_get_ref(cb->caps[0]); /* +1 */
  ScrDyn *result = scr_dyn_call(fn, NULL, 0, "callback");
  scr_dyn_release(result);
  scr_dyn_release(fn);
}

static ScrClosure *scr_dgram_dyn_connect_job(const ScrDyn *fn) {
  ScrClosure *job = scr_closure_new((void *)&scr_dgram_dyn_connect_fire, 1);
  job->caps[0] = scr_box_new_obj(&scr_dgram_dyn_retain_v, &scr_dgram_dyn_release_v, NULL);
  scr_box_set_ref(job->caps[0], scr_dyn_retain((ScrDyn *)fn));
  return job;
}

/* Delivers a refusal to the dynamic callback with Node's
 * nextTick(callback, ex): the job carries the callback and the error and
 * releases both after the call. */
static void scr_dgram_dyn_fail_fire(ScrClosure *job) {
  ScrDyn *fn = scr_box_get_ref(job->caps[0]);  /* +1 */
  ScrDyn *err = scr_box_get_ref(job->caps[1]); /* +1 */
  ScrDyn *args[1] = {err};
  ScrDyn *result = scr_dyn_call(fn, args, 1, "callback");
  scr_dyn_release(result);
  scr_dyn_release(err);
  scr_dyn_release(fn);
}

/* Hands a refusal to the dynamic callback; the typed callback has its own
 * deferred invocation below. `err` moves. */
static void scr_dgram_connect_fail_dyn(const ScrDyn *dyn_cb, ScrDyn *err) {
  ScrClosure *job = scr_closure_new((void *)&scr_dgram_dyn_fail_fire, 2);
  job->caps[0] = scr_box_new_obj(&scr_dgram_dyn_retain_v, &scr_dgram_dyn_release_v, NULL);
  scr_box_set_ref(job->caps[0], scr_dyn_retain((ScrDyn *)dyn_cb));
  job->caps[1] = scr_box_new_obj(&scr_dgram_dyn_retain_v, &scr_dgram_dyn_release_v, NULL);
  scr_box_set_ref(job->caps[1], err);
  scr_next_tick(job);
}

static bool scr_dgram_connect_has_dyn(const ScrDyn *dyn_cb) {
  return dyn_cb != NULL && scr_dgram_dyn_truthy(dyn_cb);
}

static void scr_dgram_connect_impl(ScrDgramSocket *s, double port, ScrStr *host, ScrClosure *cb,
                                   const ScrDyn *dyn_cb) {
  if (s->closing || s->close_emitted) {
    scr_closure_release(cb);
    scr_dgram_throw("Not running");
    return;
  }
  if (s->connected) {
    scr_closure_release(cb);
    scr_dgram_throw("Already connected");
    return;
  }
  if (!scr_dgram_valid_port(port, "Port", false)) {
    scr_closure_release(cb);
    return;
  }
  /* Node hands the callback to once('connect'), which validates it: a truthy
   * value that is not a function throws there. */
  if (scr_dgram_connect_has_dyn(dyn_cb) && !scr_dyn_is_callable(dyn_cb)) {
    scr_closure_release(cb);
    scr_dyn_arg_type_fail("listener", "of type function", dyn_cb);
    return;
  }
  if (s->lookup != NULL && !s->lookup_ready) {
    /* Node resolves the connect address through its handle's lookup (after
     * the implicit bind's own lookup) and continues from the answer. */
    ScrDgramLkJob *job = calloc(1, sizeof *job);
    if (!job) scr_dgram_oom();
    job->op = SCR_DGRAM_LK_CONNECT;
    job->address = strdup(scr_dgram_lk_address(s, host, false));
    if (!job->address) scr_dgram_oom();
    job->port = port;
    job->cb = cb;
    if (scr_dgram_connect_has_dyn(dyn_cb)) job->dyn_cb = scr_dyn_retain((ScrDyn *)dyn_cb);
    scr_dgram_lk_start(s, job);
    return;
  }
  if (cb) scr_dgram_ls_add(&s->conn_ls, cb, NULL, true);
  else if (scr_dgram_connect_has_dyn(dyn_cb))
    scr_dgram_ls_add(&s->conn_ls, scr_dgram_dyn_connect_job(dyn_cb), NULL, true);
  const char *h = host->len > 0 ? host->data : (s->v6 ? "::1" : "127.0.0.1");
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  if (!scr_dgram_host_addr(s, h, (uint16_t)(int)port, &sa, &salen)) {
    char msg[160];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", h);
    /* Node answers the once('connect') completion and removes it; leaving it
     * in the list would run it again on a later, successful connect. */
    ScrClosure *failed = (cb != NULL || scr_dgram_connect_has_dyn(dyn_cb))
                             ? scr_dgram_ls_pop_last(&s->conn_ls)
                             : NULL;
    if (scr_dgram_connect_has_dyn(dyn_cb)) {
      scr_closure_release(failed);
      scr_dgram_connect_fail_dyn(dyn_cb, scr_dgram_send_error(msg));
    } else if (failed != NULL) {
      scr_next_tick(failed);
    } else {
      scr_dgram_defer_err(s, msg);
    }
    return;
  }
  scr_dgram_ensure_fd(s);
  /* Node's connect binds first (the wildcard, port 0), so the socket is
   * really bound — address() answers an ephemeral port — even when the
   * address is refused below. */
  if (!scr_dgram_bind_wildcard(s)) return;
  scr_dgram_register(s); /* the pending 'listening' (and a failure) defers */
  char peer_ip[64];
  scr_dgram_sockaddr_ip(&sa, peer_ip, sizeof peer_ip);
  if (scr_dgram_send_blocked(s, peer_ip, sa.ss_family == AF_INET6 ? 6 : 4)) {
    /* Node's doConnect failure: the callback (registered as once('connect'))
     * is removed and answered with ERR_IP_BLOCKED — a dynamic callback
     * receives the error object itself — otherwise the failure is the
     * deferred 'error'; 'connect' never emits. The implicit bind above
     * stands, as in Node, so the socket stays usable. */
    /* Only a completion that was actually registered leaves the 'connect'
     * list here: a falsy dynamic callback registered nothing (Node's
     * `if (callback)`), so a user's own 'connect' listener stays put and the
     * refusal is the deferred 'error'. */
    bool registered = cb != NULL || scr_dgram_connect_has_dyn(dyn_cb);
    ScrClosure *failed = registered ? scr_dgram_ls_pop_last(&s->conn_ls) : NULL;
    if (scr_dgram_connect_has_dyn(dyn_cb)) {
      scr_closure_release(failed);
      scr_dgram_connect_fail_dyn(dyn_cb, scr_dgram_blocked_error(peer_ip));
    } else if (failed != NULL) {
      scr_next_tick(failed);
    } else {
      char msg[160];
      int n = snprintf(msg, sizeof msg, "IP(%s) is blocked by net.BlockList", peer_ip);
      if (!s->pending_err) s->pending_err = scr_str_new(msg, (size_t)n);
      s->pending_code = "ERR_IP_BLOCKED";
    }
    /* The bind stands and, as in Node, the socket keeps receiving: its read
     * watch goes on with the failure, and 'listening' still emits. */
    scr_dgram_update_read(s);
    return;
  }
  if (connect(s->fd, (struct sockaddr *)&sa, salen) != 0) {
    char msg[128];
    char ip[64];
    scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
    snprintf(msg, sizeof msg, "connect %s %s:%d", scr_dgram_errname(errno), ip, (int)port);
    ScrClosure *failed = (cb != NULL || scr_dgram_connect_has_dyn(dyn_cb))
                             ? scr_dgram_ls_pop_last(&s->conn_ls)
                             : NULL;
    if (scr_dgram_connect_has_dyn(dyn_cb)) {
      scr_closure_release(failed);
      scr_dgram_connect_fail_dyn(dyn_cb, scr_dgram_send_error(msg));
    } else if (failed != NULL) {
      scr_next_tick(failed);
    } else {
      scr_dgram_defer_err(s, msg);
    }
    return;
  }
  s->connected = true;
  s->emit_connect = true;
  scr_dgram_register(s);
  scr_dgram_update_read(s);
}

void scr_dgram_connect(ScrDgramSocket *s, double port, ScrStr *host, ScrClosure *cb) {
  scr_dgram_connect_impl(s, port, host, cb, NULL);
}

void scr_dgram_connect_dyn(ScrDgramSocket *s, double port, ScrStr *host, const ScrDyn *cb) {
  scr_dgram_connect_impl(s, port, host, NULL, cb);
  /* The dynamic argument's owned reference (the runtime retains whatever it
   * defers). */
  scr_dyn_release((ScrDyn *)cb);
}

/* bindSync([options]): Node's synchronous bind. numeric host only; the
 * state and argument errors throw synchronously (validatePort's
 * ERR_SOCKET_BAD_PORT, ERR_INVALID_ARG_VALUE for a non-IP address, the
 * errno exception for a failed bind). 'listening' emits at the next
 * dispatch pass, Node's next tick. */
void scr_dgram_bind_sync(ScrDgramSocket *s, double port, ScrStr *host, bool has_host) {
  if (s->closing || s->close_emitted) {
    scr_dgram_throw("Not running");
    return;
  }
  if (s->bound) {
    scr_dgram_throw("Socket is already bound");
    return;
  }
  if (!scr_dgram_valid_port(port, "options.port", true)) return;
  const char *h = has_host ? host->data : "";
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  if (h[0] != '\0' && !scr_dgram_numeric_host(s, h)) {
    scr_dgram_throw_invalid_arg_value(
        "options.address", host,
        "must be a numeric IP address; bindSync does not perform DNS resolution");
    return;
  }
  if (!scr_dgram_host_addr(s, h, (uint16_t)(int)port, &sa, &salen)) {
    scr_dgram_throw_invalid_arg_value(
        "options.address", host,
        "must be a numeric IP address; bindSync does not perform DNS resolution");
    return;
  }
  scr_dgram_ensure_fd(s);
  if (bind(s->fd, (struct sockaddr *)&sa, salen) != 0) {
    int err = errno;
    char ip[64];
    scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
    close(s->fd);
    s->fd = -1;
    scr_dgram_throw_exception_host_port(err, "bind", ip, (int)port);
    return;
  }
  s->bound = true;
  s->emit_listening = true;
  scr_dgram_apply_init_buffers(s);
  scr_dgram_register(s);
  scr_dgram_update_read(s);
}

/* connectSync(port[, address]): the synchronous connect. An unbound
 * socket binds to the wildcard first (Node's this.bindSync()), and the
 * connect state becomes CONNECTED at once, so disconnect() works before
 * the 'connect' emission. */
void scr_dgram_connect_sync(ScrDgramSocket *s, double port, ScrStr *host, bool has_host) {
  if (s->closing || s->close_emitted) {
    scr_dgram_throw("Not running");
    return;
  }
  if (!scr_dgram_valid_port(port, "Port", false)) return;
  if (s->connected) {
    scr_dgram_throw("Already connected");
    return;
  }
  bool given = has_host && host->len > 0;
  const char *h = given ? host->data : (s->v6 ? "::1" : "127.0.0.1");
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  if (given && !scr_dgram_numeric_host(s, h)) {
    scr_dgram_throw_invalid_arg_value(
        "address", host,
        "must be a numeric IP address; connectSync does not perform DNS resolution");
    return;
  }
  if (!scr_dgram_host_addr(s, h, (uint16_t)(int)port, &sa, &salen)) {
    scr_dgram_throw_invalid_arg_value(
        "address", host,
        "must be a numeric IP address; connectSync does not perform DNS resolution");
    return;
  }
  /* Node's this.bindSync(): the wildcard, port 0, 'listening' pending */
  if (!scr_dgram_bind_wildcard(s)) return;
  char peer_ip[64];
  scr_dgram_sockaddr_ip(&sa, peer_ip, sizeof peer_ip);
  if (scr_dgram_send_blocked(s, peer_ip, sa.ss_family == AF_INET6 ? 6 : 4)) {
    /* Node's connectSync: the block check throws after the implicit
     * bindSync, so the socket is left bound, in the loop and receiving. */
    scr_dgram_register(s);
    scr_dgram_update_read(s);
    char text[160];
    int n = snprintf(text, sizeof text, "IP(%s) is blocked by net.BlockList", peer_ip);
    scr_throw_error_msg_code(SCR_ERR_ERROR, text, (size_t)n, "ERR_IP_BLOCKED");
    return;
  }
  if (connect(s->fd, (struct sockaddr *)&sa, salen) != 0) {
    char ip[64];
    scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
    scr_dgram_throw_exception_host_port(errno, "connect", ip, (int)port);
    return;
  }
  s->connected = true;
  s->connected_sync = true;
  s->emit_connect = true;
  scr_dgram_register(s);
  scr_dgram_update_read(s);
}

/* ── the options-object forms over checked-dynamic values ──────────────
 * createSocket's argument (a type string or an options object) and
 * bind/bindSync's options records arrive untyped so a literal, a typed
 * record, and an untyped JavaScript object all take Node's own path. */

/* Node's error-tail number: integer-valued doubles group their digits
 * with underscores ("70_000_000_000"), everything else prints plainly. */
static void scr_dgram_received_number(double v, char *buf, size_t cap) {
  char digits[64];
  scr_dgram_number_text(v, digits, sizeof digits);
  bool neg = digits[0] == '-';
  const char *d = neg ? digits + 1 : digits;
  size_t n = strlen(d);
  bool integer = v == v && !isinf(v) && trunc(v) == v;
  if (!integer || n <= 3) {
    snprintf(buf, cap, "%s", digits);
    return;
  }
  size_t groups = (n + 2) / 3;
  if (groups * 4 >= cap) {
    snprintf(buf, cap, "%s", digits);
    return;
  }
  char out[64];
  size_t o = 0;
  if (neg) out[o++] = '-';
  size_t first = n % 3 == 0 ? 3 : n % 3;
  size_t i = 0;
  for (size_t g = 0; g < first; g++) out[o++] = d[i++];
  while (i < n) {
    out[o++] = '_';
    for (int g = 0; g < 3; g++) out[o++] = d[i++];
  }
  out[o] = '\0';
  snprintf(buf, cap, "%s", out);
}

/* Node's validateUint32 for an options member: the integer check first,
 * then the 32-bit range. False with ERR_OUT_OF_RANGE pending. */
static bool scr_dgram_uint32_option(const ScrDyn *v, const char *name) {
  /* Node's validateUint32: a non-number is ERR_INVALID_ARG_TYPE (the
   * specific-type tail, which a long BigInt or Symbol makes long and the
   * error builder handles), then the integer and range checks. */
  if (v->kind != SCR_DYN_NUM) {
    scr_dyn_prop_type_fail(name, "of type number", v);
    return false;
  }
  if (trunc(v->v.num) != v->v.num || isinf(v->v.num)) {
    char shown[64], text[224];
    scr_dgram_number_text(v->v.num, shown, sizeof shown);
    int n = snprintf(text, sizeof text,
                     "The value of \"%s\" is out of range. It must be an integer. Received %s", name,
                     shown);
    scr_throw_error_msg_code(SCR_ERR_RANGE, text, scr_dgram_fmt_len(n, sizeof text),
                             "ERR_OUT_OF_RANGE");
    return false;
  }
  if (v->v.num < 0 || v->v.num > 4294967295.0) {
    char num[64], text[224];
    scr_dgram_received_number(v->v.num, num, sizeof num);
    int n = snprintf(text, sizeof text,
                     "The value of \"%s\" is out of range. It must be >= 0 && <= 4294967295. "
                     "Received %s",
                     name, num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, text, scr_dgram_fmt_len(n, sizeof text),
                             "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

/* A property present in an options object (not undefined). */
static bool scr_dgram_opt_present(const ScrDyn *obj, const char *name, size_t len,
                                  const ScrDyn **out) {
  const ScrDyn *v = scr_dyn_obj_get(obj, name, len);
  if (v == NULL || v->kind == SCR_DYN_UNDEF) return false;
  *out = v;
  return true;
}

/* The materialized options view (a typed record arrives by reference; the
 * caller releases *owned). NULL with the exception pending. */
static const ScrDyn *scr_dgram_options_view(const ScrDyn *v, ScrDyn **owned) {
  *owned = NULL;
  if (v->kind == SCR_DYN_TYPED_REF) {
    *owned = scr_dyn_typed_ref_materialize(v);
    return scr_exc_pending() ? NULL : *owned;
  }
  return v;
}

/* An options member read the way Node reads a property: a getter runs.
 * True with the value (+1 in *out) when the member is present and not
 * undefined; false when it is absent or its getter threw (exception
 * pending). */
static bool scr_dgram_opt_read(const ScrDyn *obj, const char *name, size_t len, ScrDyn **out) {
  if (obj == NULL || obj->kind != SCR_DYN_OBJ) return false;
  ScrDyn *v = scr_dyn_obj_read(obj, name, len);
  if (v == NULL) return false;
  if (v->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(v);
    return false;
  }
  *out = v;
  return true;
}

/* The abort listener Node's constructor installs for options.signal: it
 * closes the socket (close(), not destroy — 'close' emits at the next
 * sweep) and nothing else. */
static ScrDyn *scr_dgram_abort_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDgramSocket *s = scr_box_get_ref(clo->caps[0]); /* +1 */
  if (s != NULL) {
    if (!s->closing && !s->close_emitted) scr_dgram_close(s, NULL);
    scr_dgram_release(s);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrClosure *scr_dgram_abort_job(ScrDgramSocket *s) {
  ScrClosure *job = scr_closure_new((void *)&scr_dgram_abort_thunk, 1);
  job->caps[0] = scr_box_new_obj(&scr_dgram_retain_v, &scr_dgram_release_v, NULL);
  scr_box_set_ref(job->caps[0], scr_dgram_retain(s));
  return job;
}

/* Node's validateAbortSignal test, `'aborted' in signal`: a native
 * AbortSignal handle carries the tag, a plain object answers its own member
 * and a record reference through its materialized members. */
static bool scr_dgram_signal_value(const ScrDyn *v) {
  if (v->kind == SCR_DYN_HANDLE) return v->v.handle.tag == SCR_DYNH_ABORT_SIGNAL;
  if (v->kind == SCR_DYN_OBJ) return scr_dyn_obj_get(v, "aborted", 7) != NULL;
  if (v->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *owned = scr_dyn_typed_ref_materialize(v);
    if (owned == NULL) return false;
    bool has = scr_dyn_obj_get(owned, "aborted", 7) != NULL;
    scr_dyn_release(owned);
    return has;
  }
  return false;
}

/* The value of the signal's `aborted` member, as the constructor reads it
 * (a real signal's accessor, a duck-typed object's own field). */
static bool scr_dgram_signal_aborted(const ScrDyn *v) {
  const ScrDyn *obj = v;
  ScrDyn *owned = NULL;
  if (v->kind == SCR_DYN_TYPED_REF) {
    owned = scr_dyn_typed_ref_materialize(v);
    if (owned == NULL) return false;
    obj = owned;
  }
  ScrDyn *member = scr_dyn_obj_read(obj, "aborted", 7);
  bool aborted = member != NULL && scr_dgram_dyn_truthy(member);
  if (member != NULL) scr_dyn_release(member);
  if (owned != NULL) scr_dyn_release(owned);
  return aborted;
}

/* Arms options.signal: the socket closes when the signal aborts. Node's
 * constructor closes an already-aborted socket at once (onAborted runs
 * inside it) and installs the listener through events.addAbortListener
 * otherwise (`add_abort`, NULL only for a program that never links the
 * event-target unit). */
static void scr_dgram_arm_abort(ScrDgramSocket *s, const ScrDyn *signal,
                                ScrDyn *(*add_abort)(ScrDyn *, ScrDyn *)) {
  if (scr_dgram_signal_aborted(signal)) {
    if (!s->closing && !s->close_emitted) scr_dgram_close(s, NULL);
    return;
  }
  if (add_abort == NULL) return;
  ScrClosure *listener = scr_dgram_abort_job(s);
  ScrDyn *fn = scr_dyn_new_func(listener, scr_dgram_abort_thunk, 0, "()", "onAbort");
  s->abort_dispose = add_abort((ScrDyn *)signal, fn);
  scr_dyn_release(fn);
  if (s->abort_dispose == NULL) {
    /* Node's validateAbortSignal is duck-typed, and installing the listener
     * calls signal.addEventListener: a value that only looks like a signal
     * fails with that TypeError. */
    scr_exc_clear();
    scr_throw_error_msg(SCR_ERR_TYPE, "signal.addEventListener is not a function", 41);
  }
}

/* createSocket(type | options[, listener]) — Node's Socket constructor.
 * The listener (nullable, moves) registers as on('message'). NULL with the
 * exception pending (ERR_SOCKET_BAD_TYPE, ERR_OUT_OF_RANGE, the
 * ERR_INVALID_ARG_TYPE ladder) or an SC2020 for an option with no native
 * behavior yet. */
ScrDgramSocket *scr_dgram_create_chk(const ScrDyn *arg, ScrClosure *cb, ScrDgramMsgFn fn,
                                     ScrDyn *(*add_abort)(ScrDyn *, ScrDyn *)) {
  ScrDyn *owned = NULL;
  const ScrDyn *v = scr_dgram_options_view(arg, &owned);
  if (v == NULL) {
    scr_closure_release(cb);
    return NULL;
  }
  const ScrDyn *type = v;
  bool v6 = false, reuse = false, ipv6_only = false, reuse_port = false;
  double recv = 0, send = 0;
  ScrDyn *recv_list = NULL, *send_list = NULL; /* retained, move onto the socket */
  ScrDyn *signal_member = NULL;                /* retained, armed below */
  ScrDyn *type_member = NULL;                  /* retained member of an options record */
  ScrDyn *lookup = NULL; /* createSocket({ lookup }), transferred to the socket */
  if (v->kind == SCR_DYN_OBJ) {
    ScrDyn *m = NULL;
    bool ok = true;
    if (scr_dgram_opt_read(v, "reuseAddr", 9, &m)) {
      reuse = scr_dgram_dyn_truthy(m);
      scr_dyn_release(m);
    }
    if (ok && scr_exc_pending()) ok = false;
    if (ok && scr_dgram_opt_read(v, "ipv6Only", 8, &m)) {
      ipv6_only = scr_dgram_dyn_truthy(m);
      scr_dyn_release(m);
    }
    if (ok && scr_exc_pending()) ok = false;
    if (ok && scr_dgram_opt_read(v, "reusePort", 9, &m)) {
      reuse_port = scr_dgram_dyn_truthy(m);
      scr_dyn_release(m);
    }
    if (ok && scr_exc_pending()) ok = false;
    if (ok && scr_dgram_opt_read(v, "recvBufferSize", 14, &m)) {
      if (scr_dgram_dyn_truthy(m)) {
        if (!scr_dgram_uint32_option(m, "options.recvBufferSize")) ok = false;
        else if (m->kind == SCR_DYN_NUM) recv = m->v.num;
      }
      scr_dyn_release(m);
    }
    if (ok && scr_exc_pending()) ok = false;
    if (ok && scr_dgram_opt_read(v, "sendBufferSize", 14, &m)) {
      if (scr_dgram_dyn_truthy(m)) {
        if (!scr_dgram_uint32_option(m, "options.sendBufferSize")) ok = false;
        else if (m->kind == SCR_DYN_NUM) send = m->v.num;
      }
      scr_dyn_release(m);
    }
    if (ok && scr_exc_pending()) ok = false;
    if (ok && scr_dgram_opt_read(v, "signal", 6, &m)) {
      /* Node's validateAbortSignal is the loose `'aborted' in signal` test;
       * a native AbortSignal handle carries the tag. */
      bool signal = scr_dgram_signal_value(m);
      if (!signal) {
        scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", m);
        scr_dyn_release(m);
        ok = false;
      } else {
        signal_member = m; /* retained: armed once the socket exists */
      }
    }
    if (ok && scr_dgram_opt_read(v, "lookup", 6, &m)) {
      if (m->kind != SCR_DYN_FUNC) {
        scr_dyn_arg_type_fail("lookup", "of type function", m);
        ok = false;
      } else {
        /* held for the socket: bind/connect/send resolve through it */
        lookup = scr_dyn_retain(m);
      }
      scr_dyn_release(m);
    }
    if (ok && scr_dgram_opt_read(v, "receiveBlockList", 16, &m)) {
      /* Node stores the option only when it is truthy, then checks the
       * type: null, false and 0 stand for "no list". */
      if (!scr_dgram_dyn_truthy(m)) {
        scr_dyn_release(m);
      } else if (!scr_net_is_block_list(m)) {
        scr_dyn_prop_type_fail("options.receiveBlockList", "an net.BlockList", m);
        scr_dyn_release(m);
        ok = false;
      } else {
        recv_list = m; /* retained: moves onto the socket */
      }
    }
    if (ok && scr_dgram_opt_read(v, "sendBlockList", 13, &m)) {
      if (!scr_dgram_dyn_truthy(m)) {
        scr_dyn_release(m);
      } else if (!scr_net_is_block_list(m)) {
        scr_dyn_prop_type_fail("options.sendBlockList", "an net.BlockList", m);
        scr_dyn_release(m);
        ok = false;
      } else {
        send_list = m; /* retained: moves onto the socket */
      }
    }
    if (ok && scr_dgram_opt_read(v, "type", 4, &type_member)) type = type_member;
    if (ok && scr_exc_pending()) ok = false;
    if (!ok) {
      scr_dyn_release(recv_list);
      scr_dyn_release(send_list);
      scr_dyn_release(signal_member);
      scr_dyn_release(type_member);
      scr_dyn_release(lookup);
      scr_dyn_release(owned);
      scr_closure_release(cb);
      return NULL;
    }
  }
  if (type == NULL || type->kind != SCR_DYN_STR ||
      !((type->v.str->len == 4 && memcmp(type->v.str->data, "udp4", 4) == 0) ||
        (type->v.str->len == 4 && memcmp(type->v.str->data, "udp6", 4) == 0))) {
    static const char msg[] = "Bad socket type specified. Valid types are: udp4, udp6";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_SOCKET_BAD_TYPE");
    scr_dyn_release(recv_list);
    scr_dyn_release(send_list);
    scr_dyn_release(signal_member);
    scr_dyn_release(type_member);
    scr_dyn_release(lookup);
    scr_dyn_release(owned);
    scr_closure_release(cb);
    return NULL;
  }
  v6 = type->v.str->data[3] == '6';
  if (type != v) scr_dyn_release((ScrDyn *)type);
  ScrDgramSocket *s = scr_dgram_create(v6, reuse, ipv6_only, reuse_port, recv, send);
  s->recv_block_list = recv_list;
  s->send_block_list = send_list;
  s->lookup = lookup;
  if (signal_member != NULL) {
    /* The constructor's addAbortListener: an unreadable signal fails the
     * construction, as Node's does, and the socket goes with it. */
    scr_dgram_arm_abort(s, signal_member, add_abort);
    scr_dyn_release(signal_member);
    if (scr_exc_pending()) {
      scr_dgram_release(s);
      scr_dyn_release(owned);
      scr_closure_release(cb);
      return NULL;
    }
  }
  scr_dyn_release(owned);
  if (cb) scr_dgram_on_message(s, cb, fn, false);
  return s;
}

/* bind(options[, callback]) — Node's normalization over an untyped options
 * object: { port, address, exclusive }, with an open-fd request and the
 * option kinds with no native behavior yet refused explicitly. */
/* Node's bind(): `isInt32(port.fd) && port.fd > 0` selects the
 * descriptor-adopting form; any other fd falls through to the port bind. */
static bool scr_dgram_fd_option(const ScrDyn *v, int *out) {
  if (v->kind != SCR_DYN_NUM) return false;
  double d = v->v.num;
  if (!(d > 0) || d != floor(d) || d > 2147483647.0) return false;
  *out = (int)d;
  return true;
}

/* bind({ fd }): Node guesses the descriptor's kind (uv_guess_handle) and
 * refuses anything but a datagram socket with ERR_INVALID_FD_TYPE, then
 * hands it to the handle (uv_udp_open takes the descriptor over, sets it
 * non-blocking and starts receiving; 'listening' defers). False with the
 * exception pending. */
static bool scr_dgram_adopt_fd(ScrDgramSocket *s, int fd) {
  const char *kind = "UNKNOWN";
  int type = 0;
  socklen_t type_len = sizeof type;
#if !defined(_WIN32)
  struct stat st;
  if (fstat(fd, &st) == 0) {
    if (S_ISFIFO(st.st_mode)) kind = "PIPE";
    else if (S_ISDIR(st.st_mode)) kind = "DIRECTORY";
    else if (S_ISREG(st.st_mode)) kind = "FILE";
  }
#endif
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, (void *)&type, &type_len) == 0) {
    if (type == SOCK_STREAM) kind = "TCP";
    else if (type == SOCK_DGRAM) kind = "UDP";
  }
  if (strcmp(kind, "UDP") != 0) {
    char msg[64];
    int n = snprintf(msg, sizeof msg, "Unsupported fd type: %s", kind);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_FD_TYPE");
    return false;
  }
  /* The poller owns the loop's read watch (and, on Windows, the winsock
   * startup this descriptor's socket needs): the adopted socket arms its
   * watcher through it like a created one. */
  if (!scr_dgram_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  scr_dgram_nonblock(fd);
  s->fd = fd;
  s->bound = true;
  s->emit_listening = true;
  scr_dgram_apply_init_buffers(s);
  scr_dgram_register(s);
  scr_dgram_update_read(s);
  return true;
}

void scr_dgram_bind_opts(ScrDgramSocket *s, const ScrDyn *options, ScrClosure *cb) {
  ScrDyn *owned = NULL;
  const ScrDyn *v = scr_dgram_options_view(options, &owned);
  if (v == NULL) {
    scr_closure_release(cb);
    return;
  }
  /* bind(undefined) is bind() (Node's absent port: the wildcard), and so
   * is bind(null): Node's normalizeArgs reads a null first argument as the
   * port value, which validatePort turns into 0. (bindSync(null) is the
   * object form and throws, as Node does.) */
  const bool empty = v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL;
  if (!empty && (v->kind == SCR_DYN_NUM || v->kind == SCR_DYN_STR)) {
    /* Node's normalizeArgs: a number, or a string that reads as a port, is
     * the port (validatePort's ladder runs in scr_dgram_bind). */
    double port = v->kind == SCR_DYN_NUM ? v->v.num : scr_string_to_number(v->v.str);
    ScrStr *host = scr_str_new("", 0);
    scr_dgram_bind(s, port, host, cb);
    scr_str_release(host);
    scr_dyn_release(owned);
    return;
  }
  if (!empty && v->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object", v);
    scr_dyn_release(owned);
    scr_closure_release(cb);
    return;
  }
  ScrDyn *member = NULL;
  if (!empty && scr_dgram_opt_read(v, "fd", 2, &member)) {
    int fd = -1;
    bool fd_form = scr_dgram_fd_option(member, &fd);
    scr_dyn_release(member);
    if (fd_form) {
      /* Node's bind() ignores port and address in this form; the socket
       * must still be unbound and running. */
      if (s->closing || s->close_emitted) {
        scr_dyn_release(owned);
        scr_closure_release(cb);
        scr_dgram_throw("Not running");
        return;
      }
      if (s->bound) {
        scr_dyn_release(owned);
        scr_closure_release(cb);
        scr_dgram_throw("Socket is already bound");
        return;
      }
      /* The callback is Node's once('listening'): it runs when the adopted
       * socket starts listening, or not at all when the descriptor is
       * refused. */
      if (cb) scr_dgram_ls_add(&s->listening_ls, cb, NULL, true);
      scr_dyn_release(owned);
      scr_dgram_adopt_fd(s, fd);
      return;
    }
  }
  if (!empty && scr_exc_pending()) {
    scr_dyn_release(owned);
    scr_closure_release(cb);
    return;
  }
  ScrDyn *address = NULL;
  if (!empty) (void)scr_dgram_opt_read(v, "address", 7, &address);
  if (scr_exc_pending()) {
    scr_dyn_release(address);
    scr_dyn_release(owned);
    scr_closure_release(cb);
    return;
  }
  if (address != NULL && address->kind != SCR_DYN_STR && address->kind != SCR_DYN_NULL) {
    scr_dyn_arg_type_fail("hostname", "of type string", address);
    scr_dyn_release(address);
    scr_dyn_release(owned);
    scr_closure_release(cb);
    return;
  }
  ScrDyn *p = NULL;
  if (!empty) (void)scr_dgram_opt_read(v, "port", 4, &p);
  if (scr_exc_pending()) {
    scr_dyn_release(address);
    scr_dyn_release(p);
    scr_dyn_release(owned);
    scr_closure_release(cb);
    return;
  }
  double port = 0;
  if (p != NULL) {
    if (p->kind == SCR_DYN_NUM) port = p->v.num;
    else if (p->kind == SCR_DYN_STR) {
      port = scr_string_to_number(p->v.str); /* JavaScript's ToNumber */
    }
  }
  ScrStr *host = address != NULL && address->kind == SCR_DYN_STR ? scr_str_retain(address->v.str)
                                                                 : scr_str_new("", 0);
  scr_dgram_bind(s, port, host, cb);
  scr_str_release(host);
  scr_dyn_release(address);
  scr_dyn_release(p);
  scr_dyn_release(owned);
}
/* bindSync(options) — Node's synchronous bind over an untyped options
 * object: validateObject, its already-bound check, validatePort and the
 * numeric-address rule. */
void scr_dgram_bind_sync_chk(ScrDgramSocket *s, const ScrDyn *options) {
  ScrDyn *owned = NULL;
  const ScrDyn *v = scr_dgram_options_view(options, &owned);
  if (v == NULL) return;
  /* bindSync(undefined) is bindSync() (Node's kEmptyObject default). */
  const bool empty = v->kind == SCR_DYN_UNDEF;
  if (!empty && v->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object", v);
    scr_dyn_release(owned);
    return;
  }
  ScrDyn *member = NULL;
  /* Node's bindSync reads only port, address and exclusive: an fd member is
   * ignored and the port bind runs as usual. */
  if (!empty && scr_dgram_opt_read(v, "fd", 2, &member)) scr_dyn_release(member);
  if (!empty && scr_exc_pending()) {
    scr_dyn_release(owned);
    return;
  }
  ScrDyn *p = NULL;
  if (!empty) (void)scr_dgram_opt_read(v, "port", 4, &p);
  if (scr_exc_pending()) {
    scr_dyn_release(p);
    scr_dyn_release(owned);
    return;
  }
  double port = 0;
  if (p != NULL) {
    if (p->kind == SCR_DYN_NUM) {
      port = p->v.num;
    } else if (p->kind == SCR_DYN_STR) {
      /* validatePort's string arm: JavaScript's ToNumber ('0x10' is 16,
       * "12abc" is NaN), then the integer/range test. */
      ScrStr *trimmed = scr_str_trim(p->v.str);
      double value = scr_string_to_number(p->v.str);
      bool numeric = trimmed->len > 0 && value >= 0 && value <= 65535 &&
                     trunc(value) == value;
      scr_str_release(trimmed);
      if (!numeric) {
        scr_dgram_throw_received(SCR_ERR_RANGE, "ERR_SOCKET_BAD_PORT",
                                 "options.port should be >= 0 and < 65536. Received ", p, ".");
        scr_dyn_release(p);
        scr_dyn_release(owned);
        return;
      }
      port = value;
    } else {
      /* validatePort's non-number arm: ERR_SOCKET_BAD_PORT with the
       * specific-type tail. */
      scr_dgram_throw_received(SCR_ERR_RANGE, "ERR_SOCKET_BAD_PORT",
                               "options.port should be >= 0 and < 65536. Received ", p, ".");
      scr_dyn_release(p);
      scr_dyn_release(owned);
      return;
    }
  }
  ScrDyn *a = NULL;
  if (!empty) (void)scr_dgram_opt_read(v, "address", 7, &a);
  if (scr_exc_pending()) {
    scr_dyn_release(a);
    scr_dyn_release(p);
    scr_dyn_release(owned);
    return;
  }
  bool has_host = a != NULL && a->kind != SCR_DYN_NULL;
  ScrStr *host = has_host && a->kind == SCR_DYN_STR ? scr_str_retain(a->v.str) : scr_str_new("", 0);
  if (has_host && a->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("options.address", "of type string", a);
  } else {
    scr_dgram_bind_sync(s, port, host, has_host);
  }
  scr_str_release(host);
  scr_dyn_release(a);
  scr_dyn_release(p);
  scr_dyn_release(owned);
}
static void scr_dgram_send_raw(ScrDgramSocket *s, const char *data, size_t len, double port,
                                ScrStr *host) {
  if (s->closing || s->close_emitted) {
    scr_dgram_throw("Not running");
    return;
  }
  if (s->connected) {
    scr_dgram_throw("Already connected");
    return;
  }
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  /* An empty host is the family's loopback, Node's lookup answer for "". */
  const char *h = host->len > 0 ? host->data : (s->v6 ? "::1" : "127.0.0.1");
  if (s->lookup != NULL && !s->lookup_ready) {
    ScrDgramLkJob *job = calloc(1, sizeof *job);
    if (!job) scr_dgram_oom();
    job->op = SCR_DGRAM_LK_SEND_RAW;
    job->address = strdup(h);
    if (!job->address) scr_dgram_oom();
    job->port = port;
    job->data = malloc(len == 0 ? 1 : len);
    if (!job->data) scr_dgram_oom();
    if (len != 0) memcpy(job->data, data, len);
    job->len = len;
    scr_dgram_lk_start(s, job);
    return;
  }
  if (!scr_dgram_host_addr(s, h, (uint16_t)(int)port, &sa, &salen)) {
    char msg[160];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", h);
    scr_dgram_defer_err(s, msg);
    return;
  }
  /* The kernel bind behind Node's send-before-bind (and 'listening' emits
   * for it there too): the socket is really bound, and can receive, even
   * when the destination is blocked below. */
  if (!scr_dgram_bind_wildcard(s)) return;
  scr_dgram_register(s); /* an open sender holds the loop, like Node */
  {
    char ip[64];
    scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
    if (scr_dgram_send_blocked(s, ip, sa.ss_family == AF_INET6 ? 6 : 4)) {
      /* sendBlockList: the blocked datagram never reaches the wire, and a
       * send with no completion callback answers nothing (Node's doSend
       * drop). */
      scr_dgram_update_read(s);
      return;
    }
  }
  if (sendto(s->fd, data, len, 0, (struct sockaddr *)&sa, salen) < 0 &&
      errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
    char ip[64];
    scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
    char msg[128];
    snprintf(msg, sizeof msg, "send %s %s:%d", scr_dgram_errname(errno), ip, (int)port);
    scr_dgram_defer_err(s, msg);
  }
  scr_dgram_update_read(s);
}

void scr_dgram_send_str(ScrDgramSocket *s, ScrStr *data, double port, ScrStr *host) {
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  scr_dgram_send_raw(s, bytes, data->len, port, host);
  scr_str_utf8_end(owned);
}

void scr_dgram_send_bytes(ScrDgramSocket *s, ScrBytes *data, double port, ScrStr *host) {
  SCR_BYTES_SNAPSHOT(data);
  scr_dgram_send_raw(s, (const char *)data->data, data->len, port, host);
}

/* address() parts. The ip read carries the state errors: "Not running"
 * after close() (Node's healthCheck), else Node's getsockname EBADF on a
 * socket that never bound; family and port only run after ip succeeded. */
ScrStr *scr_dgram_addr_ip(ScrDgramSocket *s) {
  if (s->closing || s->close_emitted) {
    scr_dgram_throw("Not running");
    return NULL;
  }
  if (s->fd < 0 || !s->bound) {
    scr_dgram_throw_errno(EBADF, "getsockname");
    return NULL;
  }
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  char ip[64] = "0.0.0.0";
  if (getsockname(s->fd, (struct sockaddr *)&sa, &salen) == 0) scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
  return scr_str_new(ip, strlen(ip));
}

ScrStr *scr_dgram_addr_family(ScrDgramSocket *s) {
  return scr_str_new(s->v6 ? "IPv6" : "IPv4", s->v6 ? 4 : 4);
}

double scr_dgram_addr_port(ScrDgramSocket *s) {
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  if (s->fd >= 0 && getsockname(s->fd, (struct sockaddr *)&sa, &salen) == 0) {
    if (sa.ss_family == AF_INET6) return (double)ntohs(((struct sockaddr_in6 *)&sa)->sin6_port);
    if (sa.ss_family == AF_INET) return (double)ntohs(((struct sockaddr_in *)&sa)->sin_port);
  }
  return 0;
}

/* remoteAddress() parts: Node's healthCheck, then
 * ERR_SOCKET_DGRAM_NOT_CONNECTED, then getpeername's errno error. */
ScrStr *scr_dgram_remote_ip(ScrDgramSocket *s) {
  if (s->closing || s->close_emitted) {
    scr_dgram_throw("Not running");
    return NULL;
  }
  if (!s->connected) {
    static const char msg[] = "Not connected";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_SOCKET_DGRAM_NOT_CONNECTED");
    return NULL;
  }
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  char ip[64] = "0.0.0.0";
  if (getpeername(s->fd, (struct sockaddr *)&sa, &salen) != 0) {
    scr_dgram_throw_errno(errno, "getpeername");
    return NULL;
  }
  scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
  return scr_str_new(ip, strlen(ip));
}

ScrStr *scr_dgram_remote_family(ScrDgramSocket *s) {
  return scr_str_new(s->v6 ? "IPv6" : "IPv4", 4);
}

double scr_dgram_remote_port(ScrDgramSocket *s) {
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  if (s->fd >= 0 && getpeername(s->fd, (struct sockaddr *)&sa, &salen) == 0) {
    if (sa.ss_family == AF_INET6) return (double)ntohs(((struct sockaddr_in6 *)&sa)->sin6_port);
    if (sa.ss_family == AF_INET) return (double)ntohs(((struct sockaddr_in *)&sa)->sin_port);
  }
  return 0;
}


/* close([cb]): the fd closes NOW; 'close' (and the callback, registered
 * as once('close')) fires at the next sweep. Node throws "Not running"
 * on a second close. */
void scr_dgram_close(ScrDgramSocket *s, ScrClosure *cb) {
  if (s->closing || s->close_emitted) {
    scr_closure_release(cb);
    scr_dgram_throw("Not running");
    return;
  }
  if (cb) scr_dgram_ls_add(&s->close_ls, cb, NULL, true);
  if (s->fd >= 0) {
    scr_dgram_close_fd_raw(s->fd); /* registrations dropped, then the fd */
    s->fd = -1;
    s->read_armed = false;
  }
  s->closing = true;
  /* Move to the registry TAIL so 'close' emits in close() CALL order
   * (Node's per-close scheduled emit), not socket-creation order. The
   * caller's borrowed reference keeps the handle alive across the
   * unregister/register pair. */
  scr_dgram_unregister(s);
  scr_dgram_register(s); /* the sweep fires 'close' and settles */
}

void scr_dgram_unref(ScrDgramSocket *s) { s->unrefed = true; }
void scr_dgram_ref(ScrDgramSocket *s) { s->unrefed = false; }

/* ── socket options (dgram.Socket's setters and getters) ───────────────
 * Each follows Node's dgram.js plus the libuv call under it: the value
 * checks run first, then the option goes to the descriptor, so a socket
 * that has no descriptor yet (never bound) answers EBADF. After close()
 * Node's handle is null, so most members throw the TypeError reading a
 * property of null; the ones that call healthCheck() throw "Not running". */

/* The libuv name, number and message for an errno value (by name, so
 * the win32 arm's translated errno values find the same entries). */
static const ScrUvError *scr_dgram_uv_error(int err) {
  static const ScrUvError unknown = { SCR_NODE_UV__UNKNOWN, "UNKNOWN", "unknown error" };
  const char *name = scr_dgram_errname(err);
  const ScrUvError *known = scr_uv_error_named(name, strlen(name));
  return known != NULL ? known : &unknown;
}

/* Node's ErrnoException: "<syscall> <CODE>" with code, errno and syscall. */
static void scr_dgram_throw_errno(int err, const char *syscall) {
  const ScrUvError *uv = scr_dgram_uv_error(err);
  char text[96];
  int n = snprintf(text, sizeof text, "%s %s", syscall, uv->name);
  ScrStr *msg = scr_str_new(text, scr_dgram_fmt_len(n, sizeof text));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, uv->name);
  e->system_errno = uv->value;
  e->system_call = scr_str_new(syscall, strlen(syscall));
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* Node's ExceptionWithHostPort: "<syscall> <CODE> <ip>:<port>" (the port
 * part only for a positive port) with code, errno, syscall, address and
 * port. */
static void scr_dgram_throw_exception_host_port(int err, const char *syscall, const char *ip,
                                                int port) {
  const ScrUvError *uv = scr_dgram_uv_error(err);
  char text[160];
  int n = port > 0 ? snprintf(text, sizeof text, "%s %s %s:%d", syscall, uv->name, ip, port)
                   : snprintf(text, sizeof text, "%s %s %s", syscall, uv->name, ip);
  ScrStr *msg = scr_str_new(text, scr_dgram_fmt_len(n, sizeof text));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, uv->name);
  e->system_errno = uv->value;
  e->system_call = scr_str_new(syscall, strlen(syscall));
  ScrStr *addr = scr_str_new(ip, strlen(ip));
  scr_error_set_prop(e, "address", 7, scr_dyn_new_str(addr));
  scr_str_release(addr);
  if (port > 0) scr_error_set_prop(e, "port", 4, scr_dyn_new_num((double)port));
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* Node's ERR_SOCKET_BUFFER_SIZE SystemError for a failed libuv buffer
 * size call. */
static void scr_dgram_throw_buffer_size(int err, const char *syscall) {
  const ScrUvError *uv = scr_dgram_uv_error(err);
  char text[192];
  int n = snprintf(text, sizeof text, "Could not get or set buffer size: %s returned %s (%s)", syscall,
                   uv->name, uv->message);
  ScrStr *msg = scr_str_new(text, scr_dgram_fmt_len(n, sizeof text));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_str_release(e->name);
  e->name = scr_str_new("SystemError", 11);
  scr_error_set_code(e, "ERR_SOCKET_BUFFER_SIZE");
  e->system_errno = uv->value;
  e->system_call = scr_str_new(syscall, strlen(syscall));
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* After close() Node's handle is null: the member read throws. */
static bool scr_dgram_handle_gone(const ScrDgramSocket *s, const char *member) {
  if (!s->closing && !s->close_emitted) return false;
  char text[96];
  int n = snprintf(text, sizeof text, "Cannot read properties of null (reading '%s')", member);
  scr_throw_error_msg(SCR_ERR_TYPE, text, scr_dgram_fmt_len(n, sizeof text));
  return true;
}

/* healthCheck(): "Not running" once close() was called. */
static bool scr_dgram_not_running(const ScrDgramSocket *s) {
  if (!s->closing && !s->close_emitted) return false;
  scr_dgram_throw("Not running");
  return true;
}

/* V8's ToInt32, the conversion Node's binding applies to the value. */
static int scr_dgram_to_int32(double v) {
  if (!isfinite(v)) return 0;
  double t = fmod(trunc(v), 4294967296.0);
  if (t < 0) t += 4294967296.0;
  return (int)(int32_t)(uint32_t)t;
}

/* An int option on the descriptor; false (errno set) on failure. */
static bool scr_dgram_setopt_int(const ScrDgramSocket *s, int level, int name, int value) {
  if (s->fd < 0) {
    errno = EBADF;
    return false;
  }
  return setsockopt(s->fd, level, name, (const void *)&value, sizeof value) == 0;
}

void scr_dgram_set_broadcast(ScrDgramSocket *s, bool flag) {
  if (scr_dgram_handle_gone(s, "setBroadcast")) return;
  if (!scr_dgram_setopt_int(s, SOL_SOCKET, SO_BROADCAST, flag ? 1 : 0))
    scr_dgram_throw_errno(errno, "setBroadcast");
}

/* The TTL and multicast knobs dispatch on the socket's family, as libuv's
 * uv_udp_set_ttl / set_multicast_ttl / set_multicast_loopback do: a udp6
 * socket sets the IPV6_* option, not the IP_ one. */
double scr_dgram_set_ttl(ScrDgramSocket *s, double ttl) {
  if (scr_dgram_handle_gone(s, "setTTL")) return ttl;
  int value = scr_dgram_to_int32(ttl);
  int level = s->v6 ? IPPROTO_IPV6 : IPPROTO_IP;
  int name = s->v6 ? IPV6_UNICAST_HOPS : IP_TTL;
  if (value < 1 || value > 255) {
    scr_dgram_throw_errno(EINVAL, "setTTL");
  } else if (!scr_dgram_setopt_int(s, level, name, value)) {
    scr_dgram_throw_errno(errno, "setTTL");
  }
  return ttl;
}

double scr_dgram_set_multicast_ttl(ScrDgramSocket *s, double ttl) {
  if (scr_dgram_handle_gone(s, "setMulticastTTL")) return ttl;
  int value = scr_dgram_to_int32(ttl);
  int level = s->v6 ? IPPROTO_IPV6 : IPPROTO_IP;
  int name = s->v6 ? IPV6_MULTICAST_HOPS : IP_MULTICAST_TTL;
  if (value < 0 || value > 255) {
    scr_dgram_throw_errno(EINVAL, "setMulticastTTL");
  } else if (!scr_dgram_setopt_int(s, level, name, value)) {
    scr_dgram_throw_errno(errno, "setMulticastTTL");
  }
  return ttl;
}

bool scr_dgram_set_multicast_loopback(ScrDgramSocket *s, bool flag) {
  if (scr_dgram_handle_gone(s, "setMulticastLoopback")) return flag;
  int level = s->v6 ? IPPROTO_IPV6 : IPPROTO_IP;
  int name = s->v6 ? IPV6_MULTICAST_LOOP : IP_MULTICAST_LOOP;
  if (!scr_dgram_setopt_int(s, level, name, flag ? 1 : 0))
    scr_dgram_throw_errno(errno, "setMulticastLoopback");
  return flag;
}

/* A NUL-terminated copy of a borrowed string, NULL when it is too long
 * to be an address (the caller answers EINVAL). */
static const char *scr_dgram_cstr(const ScrStr *v, char *buf, size_t cap) {
  if (v->len >= cap || memchr(v->data, '\0', v->len) != NULL) return NULL;
  memcpy(buf, v->data, v->len);
  buf[v->len] = '\0';
  return buf;
}

/* uv_ip6_addr: an IPv6 literal with an optional %scope (an interface
 * name or number). */
static bool scr_dgram_ip6(const char *text, struct in6_addr *addr, unsigned *scope) {
  char host[64];
  const char *pct = strchr(text, '%');
  size_t len = pct != NULL ? (size_t)(pct - text) : strlen(text);
  if (len >= sizeof host) return false;
  memcpy(host, text, len);
  host[len] = '\0';
  if (inet_pton(AF_INET6, host, addr) != 1) return false;
  *scope = 0;
  if (pct != NULL) {
#ifndef _WIN32
    *scope = if_nametoindex(pct + 1);
#endif
    if (*scope == 0) *scope = (unsigned)atoi(pct + 1);
  }
  return true;
}

void scr_dgram_set_multicast_interface(ScrDgramSocket *s, ScrStr *iface /*borrowed*/) {
  if (scr_dgram_not_running(s)) return;
  char buf[96];
  const char *text = scr_dgram_cstr(iface, buf, sizeof buf);
  struct in_addr a4;
  struct in6_addr a6;
  unsigned scope = 0;
  bool ok;
  if (text != NULL && inet_pton(AF_INET, text, &a4) == 1) {
    ok = s->fd >= 0 && setsockopt(s->fd, IPPROTO_IP, IP_MULTICAST_IF, (const void *)&a4, sizeof a4) == 0;
  } else if (text != NULL && scr_dgram_ip6(text, &a6, &scope)) {
    ok = s->fd >= 0 &&
         setsockopt(s->fd, IPPROTO_IPV6, IPV6_MULTICAST_IF, (const void *)&scope, sizeof scope) == 0;
  } else {
    scr_dgram_throw_errno(EINVAL, "setMulticastInterface");
    return;
  }
  if (s->fd < 0) errno = EBADF;
  if (!ok) scr_dgram_throw_errno(errno, "setMulticastInterface");
}

/* addMembership / dropMembership. Node's libuv binds a socket that has
 * no descriptor yet to an ephemeral port first; that implicit bind has
 * no lowering. iface is NULL when the argument is omitted. */
static void scr_dgram_membership(ScrDgramSocket *s, ScrStr *group, ScrStr *iface, bool join) {
  const char *syscall = join ? "addMembership" : "dropMembership";
  if (scr_dgram_not_running(s)) return;
  if (group->len == 0) {
    static const char msg[] = "The \"multicastAddress\" argument must be specified";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_MISSING_ARGS");
    return;
  }
  char gbuf[96], ibuf[96];
  const char *gtext = scr_dgram_cstr(group, gbuf, sizeof gbuf);
  const char *itext = iface != NULL ? scr_dgram_cstr(iface, ibuf, sizeof ibuf) : NULL;
  struct in_addr g4;
  struct in6_addr g6;
  unsigned gscope = 0;
  bool v4 = gtext != NULL && inet_pton(AF_INET, gtext, &g4) == 1;
  if (!v4 && (gtext == NULL || !scr_dgram_ip6(gtext, &g6, &gscope))) {
    scr_dgram_throw_errno(EINVAL, syscall);
    return;
  }
  if (!s->bound) {
    /* Node's implicit bind: the join on an unbound socket binds the
     * wildcard on an ephemeral port first (and emits no 'listening'). */
    struct sockaddr_storage bsa;
    socklen_t blen = sizeof bsa;
    if (!scr_dgram_host_addr(s, "", 0, &bsa, &blen)) return;
    scr_dgram_ensure_fd(s);
    if (bind(s->fd, (struct sockaddr *)&bsa, blen) != 0) {
      scr_dgram_throw_errno(errno, syscall);
      return;
    }
    s->bound = true;
    scr_dgram_apply_init_buffers(s);
    /* the implicit bind arms the read watch, so the socket must also be
     * in the registry the dispatch resolves keys through */
    scr_dgram_register(s);
    scr_dgram_update_read(s);
  }
  int rc;
  if (v4) {
    struct ip_mreq mreq;
    memset(&mreq, 0, sizeof mreq);
    mreq.imr_multiaddr = g4;
    mreq.imr_interface.s_addr = htonl(INADDR_ANY);
    if (iface != NULL && (itext == NULL || inet_pton(AF_INET, itext, &mreq.imr_interface) != 1)) {
      scr_dgram_throw_errno(EINVAL, syscall);
      return;
    }
    rc = setsockopt(s->fd, IPPROTO_IP, join ? IP_ADD_MEMBERSHIP : IP_DROP_MEMBERSHIP,
                    (const void *)&mreq, sizeof mreq);
  } else {
    struct ipv6_mreq mreq;
    memset(&mreq, 0, sizeof mreq);
    mreq.ipv6mr_multiaddr = g6;
    if (iface != NULL) {
      struct in6_addr i6;
      unsigned iscope = 0;
      if (itext == NULL || !scr_dgram_ip6(itext, &i6, &iscope)) {
        scr_dgram_throw_errno(EINVAL, syscall);
        return;
      }
      mreq.ipv6mr_interface = iscope;
    }
    rc = setsockopt(s->fd, IPPROTO_IPV6, join ? IPV6_JOIN_GROUP : IPV6_LEAVE_GROUP,
                    (const void *)&mreq, sizeof mreq);
  }
  if (rc != 0) scr_dgram_throw_errno(errno, syscall);
}

void scr_dgram_add_membership(ScrDgramSocket *s, ScrStr *group, ScrStr *iface, bool has_iface) {
  scr_dgram_membership(s, group, has_iface ? iface : NULL, true);
}

void scr_dgram_drop_membership(ScrDgramSocket *s, ScrStr *group, ScrStr *iface, bool has_iface) {
  scr_dgram_membership(s, group, has_iface ? iface : NULL, false);
}

/* addSourceSpecificMembership / dropSourceSpecificMembership: Node's
 * libuv (uv_udp_set_source_membership). Both addresses are numeric
 * literals of the group's family; an optional interface is parsed the
 * same family (its scope id picks the interface for IPv6). An unbound
 * socket answers EBADF (libuv's fd test); a malformed address or
 * interface is EINVAL. */
static void scr_dgram_source_membership(ScrDgramSocket *s, ScrStr *source, ScrStr *group,
                                         ScrStr *iface, bool has_iface, bool join) {
  const char *syscall = join ? "addSourceSpecificMembership" : "dropSourceSpecificMembership";
  if (scr_dgram_not_running(s)) return;
  char gbuf[96], sbuf[96], ibuf[96];
  const char *gtext = scr_dgram_cstr(group, gbuf, sizeof gbuf);
  const char *stext = scr_dgram_cstr(source, sbuf, sizeof sbuf);
  const char *itext = has_iface ? scr_dgram_cstr(iface, ibuf, sizeof ibuf) : NULL;
  struct in_addr g4, s4;
  struct in6_addr g6, s6;
  unsigned gscope = 0, sscope = 0;
  bool v4 = gtext != NULL && inet_pton(AF_INET, gtext, &g4) == 1;
  bool v6 = !v4 && gtext != NULL && scr_dgram_ip6(gtext, &g6, &gscope);
  if (!v4 && !v6) {
    scr_dgram_throw_errno(EINVAL, syscall);
    return;
  }
  if (!s->bound) {
    /* libuv's deferred bind: the join on an unbound socket binds the
     * wildcard on an ephemeral port first (no 'listening' emission). */
    struct sockaddr_storage bsa;
    socklen_t blen = sizeof bsa;
    if (!scr_dgram_host_addr(s, "", 0, &bsa, &blen)) return;
    scr_dgram_ensure_fd(s);
    if (bind(s->fd, (struct sockaddr *)&bsa, blen) != 0) {
      scr_dgram_throw_errno(errno, syscall);
      return;
    }
    s->bound = true;
    scr_dgram_apply_init_buffers(s);
    /* the implicit bind arms the read watch, so the socket must also be
     * in the registry the dispatch resolves keys through */
    scr_dgram_register(s);
    scr_dgram_update_read(s);
  }
  if (v4) {
    if (stext == NULL || inet_pton(AF_INET, stext, &s4) != 1) {
      scr_dgram_throw_errno(EINVAL, syscall);
      return;
    }
    struct ip_mreq_source mreq;
    memset(&mreq, 0, sizeof mreq);
    mreq.imr_multiaddr = g4;
    mreq.imr_sourceaddr = s4;
    mreq.imr_interface.s_addr = htonl(INADDR_ANY);
    if (has_iface && (itext == NULL || inet_pton(AF_INET, itext, &mreq.imr_interface) != 1)) {
      scr_dgram_throw_errno(EINVAL, syscall);
      return;
    }
    if (setsockopt(s->fd, IPPROTO_IP,
                   join ? IP_ADD_SOURCE_MEMBERSHIP : IP_DROP_SOURCE_MEMBERSHIP,
                   (const void *)&mreq, sizeof mreq) != 0) {
      scr_dgram_throw_errno(errno, syscall);
    }
    return;
  }
  if (stext == NULL || !scr_dgram_ip6(stext, &s6, &sscope)) {
    scr_dgram_throw_errno(EINVAL, syscall);
    return;
  }
  struct group_source_req gsr;
  memset(&gsr, 0, sizeof gsr);
  if (has_iface) {
    struct in6_addr i6;
    unsigned iscope = 0;
    if (itext == NULL || !scr_dgram_ip6(itext, &i6, &iscope)) {
      scr_dgram_throw_errno(EINVAL, syscall);
      return;
    }
    gsr.gsr_interface = iscope;
  }
  struct sockaddr_in6 *gaddr = (struct sockaddr_in6 *)&gsr.gsr_group;
  gaddr->sin6_family = AF_INET6;
  gaddr->sin6_addr = g6;
  gaddr->sin6_scope_id = gscope;
  struct sockaddr_in6 *saddr = (struct sockaddr_in6 *)&gsr.gsr_source;
  saddr->sin6_family = AF_INET6;
  saddr->sin6_addr = s6;
  saddr->sin6_scope_id = sscope;
  if (setsockopt(s->fd, IPPROTO_IPV6,
                 join ? MCAST_JOIN_SOURCE_GROUP : MCAST_LEAVE_SOURCE_GROUP,
                 (const void *)&gsr, sizeof gsr) != 0) {
    scr_dgram_throw_errno(errno, syscall);
  }
}

void scr_dgram_add_source_membership(ScrDgramSocket *s, ScrStr *source, ScrStr *group, ScrStr *iface,
                                     bool has_iface) {
  scr_dgram_source_membership(s, source, group, iface, has_iface, true);
}

void scr_dgram_drop_source_membership(ScrDgramSocket *s, ScrStr *source, ScrStr *group,
                                      ScrStr *iface, bool has_iface) {
  scr_dgram_source_membership(s, source, group, iface, has_iface, false);
}

/* socket[Symbol.asyncDispose](): Node's `promisify(this.close)()` — a
 * promise of 'close', fulfilled at once for a socket whose handle is
 * already gone. */
static void scr_dgram_dispose_done(ScrClosure *cb) {
  ScrPromise *p = scr_box_get_ref(cb->caps[0]); /* +1 */
  if (p != NULL) scr_promise_fulfill_void(p);
  scr_promise_release(p);
}

ScrPromise *scr_dgram_async_dispose(ScrDgramSocket *s) {
  if (s->closing || s->close_emitted) return scr_promise_settled_void();
  ScrPromise *p = scr_promise_new();
  ScrClosure *cb = scr_closure_new((void *)&scr_dgram_dispose_done, 1);
  cb->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_promise_retain(p));
  scr_dgram_close(s, cb); /* ownership moves in */
  return p;
}

/* Node's bufferSize(): the size must be a uint32 (TypeError otherwise,
 * checked before the handle), 0 reads the current size, and a size past
 * the int32 range fails as EINVAL. */
static double scr_dgram_buffer_size(ScrDgramSocket *s, double size, bool recv) {
  if (!(size >= 0 && size <= 4294967295.0 && trunc(size) == size)) {
    static const char msg[] = "Buffer size must be a positive integer";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_SOCKET_BAD_BUFFER_SIZE");
    return 0;
  }
  if (scr_dgram_handle_gone(s, "bufferSize")) return 0;
  const char *syscall = recv ? "uv_recv_buffer_size" : "uv_send_buffer_size";
  if (size > 2147483647.0) {
    scr_dgram_throw_buffer_size(EINVAL, syscall);
    return 0;
  }
  int value = (int)size;
  int name = recv ? SO_RCVBUF : SO_SNDBUF;
  bool ok;
  if (s->fd < 0) {
    errno = EBADF;
    ok = false;
  } else if (value == 0) {
    socklen_t len = sizeof value;
    ok = getsockopt(s->fd, SOL_SOCKET, name, (void *)&value, &len) == 0;
  } else {
    ok = setsockopt(s->fd, SOL_SOCKET, name, (const void *)&value, sizeof value) == 0;
  }
  if (!ok) {
    scr_dgram_throw_buffer_size(errno, syscall);
    return 0;
  }
  return value;
}

double scr_dgram_get_recv_buffer_size(ScrDgramSocket *s) { return scr_dgram_buffer_size(s, 0, true); }
double scr_dgram_get_send_buffer_size(ScrDgramSocket *s) { return scr_dgram_buffer_size(s, 0, false); }
void scr_dgram_set_recv_buffer_size(ScrDgramSocket *s, double size) { (void)scr_dgram_buffer_size(s, size, true); }
void scr_dgram_set_send_buffer_size(ScrDgramSocket *s, double size) { (void)scr_dgram_buffer_size(s, size, false); }

/* Sends go out synchronously, so nothing waits in a send queue. */
double scr_dgram_get_send_queue_size(ScrDgramSocket *s) {
  (void)scr_dgram_handle_gone(s, "getSendQueueSize");
  return 0;
}

double scr_dgram_get_send_queue_count(ScrDgramSocket *s) {
  (void)scr_dgram_handle_gone(s, "getSendQueueCount");
  return 0;
}

/* disconnect(): only a socket whose connect completed ('connect' was
 * emitted) is connected, and that check comes before the handle's. An
 * AF_UNSPEC connect dissolves the association; EAFNOSUPPORT (macOS) and
 * EINVAL count as success, as in libuv. */
void scr_dgram_disconnect(ScrDgramSocket *s) {
  if (!s->connected || (s->emit_connect && !s->connected_sync)) {
    static const char msg[] = "Not connected";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_SOCKET_DGRAM_NOT_CONNECTED");
    return;
  }
  if (scr_dgram_handle_gone(s, "disconnect")) return;
  struct sockaddr_storage addr;
  memset(&addr, 0, sizeof addr);
  addr.ss_family = AF_UNSPEC;
  if (connect(s->fd, (const struct sockaddr *)&addr, sizeof addr) != 0 && errno != EAFNOSUPPORT &&
      errno != EINVAL) {
    scr_dgram_throw_errno(errno, "connect");
    return;
  }
  s->connected = false;
  s->connected_sync = false;
}

void scr_dgram_on_message(ScrDgramSocket *s, ScrClosure *cb, ScrDgramMsgFn fn, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_dgram_ls_add(&s->msg_ls, cb, (void *)fn, once);
  scr_dgram_update_read(s);
}

void scr_dgram_on_error(ScrDgramSocket *s, ScrClosure *cb, ScrChildErrFn fn, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_dgram_ls_add(&s->err_ls, cb, (void *)fn, once);
}

void scr_dgram_on_listening(ScrDgramSocket *s, ScrClosure *cb, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_dgram_ls_add(&s->listening_ls, cb, NULL, once);
}

void scr_dgram_on_close(ScrDgramSocket *s, ScrClosure *cb, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_dgram_ls_add(&s->close_ls, cb, NULL, once);
}

void scr_dgram_on_connect(ScrDgramSocket *s, ScrClosure *cb, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_dgram_ls_add(&s->conn_ls, cb, NULL, once);
}

/* The runtime-provided message adapters (msg/rinfo parts borrowed; the
 * listener owns its +1 params per the universal convention). */
void scr_dgram_msg_thunk0(ScrClosure *cb, ScrBytes *msg, ScrStr *addr, ScrStr *family,
                           double port, double size) {
  (void)msg; (void)addr; (void)family; (void)port; (void)size;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_dgram_msg_thunk1(ScrClosure *cb, ScrBytes *msg, ScrStr *addr, ScrStr *family,
                           double port, double size) {
  (void)addr; (void)family; (void)port; (void)size;
  ((void (*)(ScrClosure *, ScrBytes *))cb->fn)(cb, scr_bytes_retain(msg));
}

/* One readable wake: recvfrom until EAGAIN, one 'message' emit per
 * datagram (arrival-driven, like net's read chunks). */
static void scr_dgram_read(ScrDgramSocket *s) {
  while (s->fd >= 0 && s->msg_ls.n > 0) {
    char buf[65536];
    struct sockaddr_storage from;
    socklen_t fromlen = sizeof from;
    ssize_t n = recvfrom(s->fd, buf, sizeof buf, 0, (struct sockaddr *)&from, &fromlen);
    if (n < 0) {
      if (errno == EINTR) continue;
      return; /* EAGAIN or a transient failure: the next wake retries */
    }
    char ip[64] = "0.0.0.0";
    int rport = 0;
    bool from6 = from.ss_family == AF_INET6;
    if (from6) {
      inet_ntop(AF_INET6, &((struct sockaddr_in6 *)&from)->sin6_addr, ip, sizeof ip);
      rport = ntohs(((struct sockaddr_in6 *)&from)->sin6_port);
    } else if (from.ss_family == AF_INET) {
      inet_ntop(AF_INET, &((struct sockaddr_in *)&from)->sin_addr, ip, sizeof ip);
      rport = ntohs(((struct sockaddr_in *)&from)->sin_port);
    }
    /* receiveBlockList: a blocked source's datagram is dropped silently */
    if (s->recv_block_list != NULL && (from6 || from.ss_family == AF_INET) &&
        scr_net_block_list_blocks(s->recv_block_list, ip, from6 ? 6 : 4)) {
      continue;
    }
    ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
    chunk->is_buffer = true; /* the message is a Buffer */
    memcpy(chunk->data, buf, (size_t)n);
    ScrStr *addr = scr_str_new(ip, strlen(ip));
    ScrStr *family = scr_str_new(from6 ? "IPv6" : "IPv4", 4);
    ScrDgramL *snap;
    size_t nl = scr_dgram_ls_snapshot(&s->msg_ls, &snap);
    for (size_t i = 0; i < nl; i++) {
      if (!scr_exc_pending()) {
        ((ScrDgramMsgFn)snap[i].fn)(snap[i].cb, chunk, addr, family, (double)rport, (double)n);
      }
      scr_closure_release(snap[i].cb);
    }
    free(snap);
    scr_bytes_release(chunk);
    scr_str_release(addr);
    scr_str_release(family);
    if (scr_exc_pending()) return;
    scr_dgram_update_read(s); /* a once-listener may have been the last consumer */
  }
}

/* ── dns.lookup ──────────────────────────────────────────────────────── */

void scr_dns_lookup(ScrStr *hostname, double family, ScrClosure *cb, ScrDnsLookupFn fn) {
  (void)family; /* the frontend pinned 4; AF_INET below IS that pin */
  if (memchr(hostname->data, '\0', hostname->len) != NULL) {
    /* validateStringWithoutNullBytes: a synchronous ERR_INVALID_ARG_VALUE
     * TypeError before any lookup runs; the callback never fires. */
    scr_closure_release(cb);
    ScrStr *shown = scr_str_inspect_quoted(hostname, true);
    ScrJsonBuf msg;
    scr_jb_init(&msg);
    scr_jb_puts(&msg, "The argument 'hostname' must be a string without null bytes. Received ");
    scr_jb_put_str(&msg, shown);
    scr_str_release(shown);
    ScrStr *text = scr_jb_finish(&msg);
    scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "ERR_INVALID_ARG_VALUE");
    scr_str_release(text);
    return;
  }
#ifdef _WIN32
  /* getaddrinfo needs winsock started (WSANOTINITIALISED otherwise); the
   * poller owns WSAStartup on this arm, so a lookup-only program rides
   * the same init the socket paths do. */
  (void)scr_dgram_poller_init();
#endif
  ScrDnsPending *p = calloc(1, sizeof *p);
  if (!p) scr_dgram_oom();
  p->cb = cb; /* moves */
  p->fn = fn;
  p->family = 4;
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_DGRAM;
  struct addrinfo *res = NULL;
  int rc = getaddrinfo(hostname->data, NULL, &hints, &res);
  if (rc == 0 && res) {
    char ip[64] = "0.0.0.0";
    inet_ntop(AF_INET, &((struct sockaddr_in *)res->ai_addr)->sin_addr, ip, sizeof ip);
    p->addr = scr_str_new(ip, strlen(ip));
  } else {
    /* Node maps name-not-found (and macOS's EAI_NODATA) to ENOTFOUND;
     * everything else surfaces its EAI_* name. Message shape:
     * "getaddrinfo ENOTFOUND <hostname>". */
    const char *code =
        (rc == EAI_NONAME
#ifdef EAI_NODATA
         || rc == EAI_NODATA
#endif
         )
            ? "ENOTFOUND"
        : rc == EAI_AGAIN ? "EAI_AGAIN"
                          : "EAI_FAIL";
    char msg[192];
    snprintf(msg, sizeof msg, "getaddrinfo %s %s", code, hostname->data);
    p->errmsg = scr_str_new(msg, strlen(msg));
    p->addr = scr_str_new("", 0);
  }
  if (res) freeaddrinfo(res);
  /* FIFO append: deliveries fire in call order at the next sweep. */
  ScrDnsPending **link = &scr_dns_pending;
  while (*link) link = &(*link)->next;
  *link = p;
}

/* ── dns with Node's argument forms (dyn callbacks) ──────────────────── */

/* Calls a dyn [callback, ...args] array. */
static void scr_dns_dyn_call(const ScrDyn *call) {
  size_t argc = call->v.arr.len - 1;
  scr_dyn_release(scr_dyn_call(call->v.arr.items[0], call->v.arr.items + 1, argc, "callback"));
}

static void scr_dns_tick_fire(ScrClosure *self) {
  ScrDyn *call = (ScrDyn *)scr_box_get_ref(self->caps[0]);
  scr_dns_dyn_call(call);
  scr_dyn_release(call);
}

/* Queues callback(args...) (the args move): on the next tick, as Node's
 * process.nextTick answers for literal addresses, or with the lookup
 * deliveries. */
static void scr_dns_call_later(const ScrDyn *callback, ScrDyn **args, size_t argc, bool tick) {
  ScrDyn *call = scr_dyn_new_arr();
  scr_dyn_arr_push(call, scr_dyn_retain((ScrDyn *)callback));
  for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(call, args[i]);
  if (tick) {
    ScrClosure *clo = scr_closure_new((void *)&scr_dns_tick_fire, 1);
    ScrBox *box = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
    scr_box_set_ref(box, call);
    clo->caps[0] = box;
    scr_next_tick(clo);
    return;
  }
  ScrDnsPending *p = calloc(1, sizeof *p);
  if (!p) scr_dgram_oom();
  p->call = call;
  ScrDnsPending **link = &scr_dns_pending;
  while (*link) link = &(*link)->next;
  *link = p;
}

/* The default result order (dns.setDefaultResultOrder): 0 verbatim,
 * 1 ipv4first, 2 ipv6first. */
static SCR_TL int scr_dns_default_order = 0;
static const char *const scr_dns_orders[] = { "verbatim", "ipv4first", "ipv6first" };

static int scr_dns_order_of(const ScrDyn *v) {
  if (v->kind != SCR_DYN_STR) return -1;
  for (int i = 0; i < 3; i++) {
    size_t n = strlen(scr_dns_orders[i]);
    if (v->v.str->len == n && memcmp(v->v.str->data, scr_dns_orders[i], n) == 0) return i;
  }
  return -1;
}

/* JavaScript's ToUint32: truncate toward zero, then modulo 2^32 (NaN and
 * the infinities convert to 0). Node's validateHints receives the result
 * of `hints >>> 0`. */
static uint32_t scr_dns_to_uint32(double d) {
  if (!isfinite(d)) return 0;
  double t = trunc(d);
  double m = fmod(t, 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (uint32_t)m;
}

/* lookup options' hints, validated as Node validates them: a number, then
 * ToUint32, then only dns.ADDRCONFIG, dns.V4MAPPED and dns.ALL (the
 * getaddrinfo flags). Stores the flags for getaddrinfo. True when the
 * options carry no hints or a valid mask; otherwise the argument error is
 * pending and false is returned. Shared by the callback and promise
 * forms, which report the same errors. */
bool scr_dns_hints_flags(const ScrDyn *options, int *ai_flags) {
  const ScrDyn *v = scr_dyn_obj_get(options, "hints", 5);
  if (v == NULL || v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL) return true;
  if (v->kind != SCR_DYN_NUM) {
    scr_dyn_prop_type_fail("options.hints", "of type number", v);
    return false;
  }
  uint32_t hints = scr_dns_to_uint32(v->v.num);
  uint32_t allowed = (uint32_t)(AI_ADDRCONFIG | AI_V4MAPPED | AI_ALL);
  if ((hints & ~allowed) != 0) {
    ScrDyn *shown = scr_dyn_new_num((double)hints);
    scr_dyn_arg_value_fail("hints", "is invalid", shown);
    scr_dyn_release(shown);
    return false;
  }
  *ai_flags = (int)hints;
  return true;
}

ScrStr *scr_dns_get_default_result_order(void) {
  const char *o = scr_dns_orders[scr_dns_default_order];
  return scr_str_new(o, strlen(o));
}

void scr_dns_set_default_result_order(const ScrDyn *order) {
  int o = scr_dns_order_of(order);
  if (o < 0) {
    scr_dyn_arg_value_fail("dnsOrder", "must be one of: 'verbatim', 'ipv4first', 'ipv6first'", order);
    return;
  }
  scr_dns_default_order = o;
}

/* Node's DNSException: "<syscall> <code> <host>" with errno, code,
 * syscall and hostname. +1 dyn. */
static ScrDyn *scr_dns_exception(int rc, const char *syscall, const ScrStr *host) {
  bool notfound = rc == EAI_NONAME
#ifdef EAI_NODATA
                  || rc == EAI_NODATA
#endif
      ;
  const char *code = notfound ? "ENOTFOUND" : rc == EAI_AGAIN ? "EAI_AGAIN" : "EAI_FAIL";
  double errnum = rc == EAI_NONAME ? -3008
#ifdef EAI_NODATA
                  : rc == EAI_NODATA ? -3007
#endif
                  : rc == EAI_AGAIN ? -3001
                                    : -3002;
  char msg[320];
  int len = snprintf(msg, sizeof msg, "%s %s %.*s", syscall, code, (int)(host->len < 255 ? host->len : 255),
                     host->data);
  ScrStr *m = scr_str_new(msg, (size_t)len);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, m);
  scr_str_release(m);
  scr_error_set_code(e, code);
  e->system_call = scr_str_new(syscall, strlen(syscall));
  e->system_errno = errnum;
  scr_error_set_prop(e, "hostname", 8, scr_dyn_new_str((ScrStr *)host));
  ScrDyn *d = scr_dyn_from_error(e);
  scr_error_release(e);
  return d;
}

static double scr_dns_literal_family(const ScrStr *h) {
  unsigned char buf[16];
  char tmp[64];
  if (h->len == 0 || h->len >= sizeof tmp) return 0;
  memcpy(tmp, h->data, h->len);
  tmp[h->len] = '\0';
  if (inet_pton(AF_INET, tmp, buf) == 1) return 4;
  if (strchr(tmp, ':') != NULL) {
    char *pct = strchr(tmp, '%');
    if (pct) *pct = '\0';
    if (inet_pton(AF_INET6, tmp, buf) == 1) return 6;
  }
  return 0;
}

static SCR_TL bool scr_dns_hostname_warned = false;

/* DEP0118 on the next tick, as process.emitWarning reports it: through
 * the events unit's warning machinery when it is linked, otherwise the
 * default stderr report. */
static void scr_dns_warn_tick(ScrClosure *self) {
  ScrStr *message = (ScrStr *)scr_box_get_ref(self->caps[0]);
  if (scr_warning_emit_hook) {
    scr_warning_emit_hook("DeprecationWarning", "DEP0118", message);
  } else {
    scr_stdout_settle();
    fflush(stdout);
#ifdef _WIN32
    long pid = (long)_getpid();
#else
    long pid = (long)getpid();
#endif
    fprintf(stderr, "(node:%ld) [DEP0118] DeprecationWarning: %.*s\n", pid, (int)message->len,
            message->data);
    if (!scr_warning_trace_hint_shown) {
      scr_warning_trace_hint_shown = true;
      fputs("(Use `node --trace-deprecation ...` to show where the warning was created)\n", stderr);
    }
  }
  scr_str_release(message);
}

/* dns.lookup(hostname[, options], callback) as Node's lib/dns.js parses
 * it: options is a family number or { family, all, order, verbatim,
 * hints }, validated in Node's order. Results come back with the other
 * lookups; literal addresses and an empty hostname answer on the next
 * tick. */
static void scr_dns_lookup_plain(const ScrDyn *hostname, const ScrDyn *options, const ScrDyn *callback,
                                 bool typed);

/* `typed`: the callback declares a string address (or a LookupAddress
 * array), which cannot hold the undefined Node passes after an error;
 * it receives "" and NaN (or []) there instead. */
void scr_dns_lookup_dyn(const ScrDyn *hostname, const ScrDyn *options, const ScrDyn *callback,
                        bool typed) {
  /* a typed options record arrives by reference */
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(options);
    if (!scr_exc_pending()) scr_dns_lookup_plain(hostname, view, callback, typed);
    scr_dyn_release(view);
    return;
  }
  scr_dns_lookup_plain(hostname, options, callback, typed);
}

/* A lookup failure's callback arguments. */
static void scr_dns_fail(const ScrDyn *callback, int rc, const ScrStr *host, bool all, bool typed) {
  ScrDyn *err = scr_dns_exception(rc, "getaddrinfo", host);
  if (!typed) {
    ScrDyn *args[1] = { err };
    scr_dns_call_later(callback, args, 1, false);
  } else if (all) {
    ScrDyn *args[2] = { err, scr_dyn_new_arr() };
    scr_dns_call_later(callback, args, 2, false);
  } else {
    ScrStr *empty = scr_str_new("", 0);
    ScrDyn *args[3] = { err, scr_dyn_new_str(empty), scr_dyn_new_num(NAN) };
    scr_str_release(empty);
    scr_dns_call_later(callback, args, 3, false);
  }
}

static void scr_dns_lookup_plain(const ScrDyn *hostname, const ScrDyn *options, const ScrDyn *callback,
                                 bool typed) {
  bool host_given = scr_dyn_truthy(hostname);
  if (host_given && hostname->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("hostname", "of type string", hostname);
    return;
  }
  double family = 0;
  bool all = false;
  int order = scr_dns_default_order;
  int ai_flags = 0;
  if (options->kind == SCR_DYN_NUM) {
    double f = options->v.num;
    if (f != 0 && f != 4 && f != 6) {
      scr_dyn_arg_value_fail("family", "must be one of: 0, 4, 6", options);
      return;
    }
    family = f;
  } else if (options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_OBJ &&
             options->kind != SCR_DYN_ARR && options->kind != SCR_DYN_NULL) {
    /* Node tests `typeof options !== 'object'`, so an array is an options
     * object too (its members read as undefined). */
    scr_dyn_arg_type_fail("options", "of type object or integer", options);
    return;
  } else if (options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_ARR) {
    if (!scr_dns_hints_flags(options, &ai_flags)) return;
    const ScrDyn *v = scr_dyn_obj_get(options, "family", 6);
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL) {
      if (v->kind == SCR_DYN_STR && v->v.str->len == 4 && memcmp(v->v.str->data, "IPv4", 4) == 0) family = 4;
      else if (v->kind == SCR_DYN_STR && v->v.str->len == 4 && memcmp(v->v.str->data, "IPv6", 4) == 0) family = 6;
      else if (v->kind == SCR_DYN_NUM && (v->v.num == 0 || v->v.num == 4 || v->v.num == 6)) family = v->v.num;
      else {
        scr_dyn_arg_value_fail("options.family", "must be one of: 0, 4, 6", v);
        return;
      }
    }
    v = scr_dyn_obj_get(options, "all", 3);
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL) {
      if (v->kind != SCR_DYN_BOOL) {
        scr_dyn_prop_type_fail("options.all", "of type boolean", v);
        return;
      }
      all = v->v.b;
    }
    v = scr_dyn_obj_get(options, "verbatim", 8);
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL) {
      if (v->kind != SCR_DYN_BOOL) {
        scr_dyn_prop_type_fail("options.verbatim", "of type boolean", v);
        return;
      }
      order = v->v.b ? 0 : 1;
    }
    v = scr_dyn_obj_get(options, "order", 5);
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL) {
      int o = scr_dns_order_of(v);
      if (o < 0) {
        scr_dyn_arg_value_fail("options.order", "must be one of: 'verbatim', 'ipv4first', 'ipv6first'", v);
        return;
      }
      order = o;
    }
  }
  if (callback->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("callback", "of type function", callback);
    return;
  }
  if (!host_given) {
    if (!scr_dns_hostname_warned) {
      scr_dns_hostname_warned = true;
      ScrStr *shown = scr_dyn_string_coerce_js(hostname);
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "The provided hostname \"");
      if (shown) scr_jb_write(&b, shown->data, shown->len);
      scr_jb_puts(&b, "\" is not a valid hostname, and is supported in the dns module solely for compatibility.");
      scr_str_release(shown);
      ScrStr *message = scr_jb_finish(&b);
      ScrClosure *clo = scr_closure_new((void *)&scr_dns_warn_tick, 1);
      ScrBox *box = scr_box_new(SCR_BOX_STR);
      scr_box_set_ref(box, message);
      clo->caps[0] = box;
      scr_next_tick(clo);
    }
    if (all) {
      ScrDyn *args[2] = { scr_dyn_new_null(), scr_dyn_new_arr() };
      scr_dns_call_later(callback, args, 2, true);
    } else {
      /* Node answers `null` here. A typed callback signature declares the
       * address as a string, so the typed form substitutes the empty
       * string, as it does for a failed lookup (scr_dns_fail); the untyped
       * form gets Node's null. */
      ScrDyn *address;
      if (typed) {
        ScrStr *empty = scr_str_new("", 0);
        address = scr_dyn_new_str(empty);
        scr_str_release(empty);
      } else {
        address = scr_dyn_new_null();
      }
      ScrDyn *args[3] = { scr_dyn_new_null(), address, scr_dyn_new_num(family == 6 ? 6 : 4) };
      scr_dns_call_later(callback, args, 3, true);
    }
    return;
  }
  const ScrStr *host = hostname->v.str;
  double literal = scr_dns_literal_family(host);
  if (literal != 0) {
    if (all) {
      ScrDyn *entry = scr_dyn_new_obj();
      scr_dyn_obj_set(entry, "address", 7, scr_dyn_new_str((ScrStr *)host));
      scr_dyn_obj_set(entry, "family", 6, scr_dyn_new_num(literal));
      ScrDyn *list = scr_dyn_new_arr();
      scr_dyn_arr_push(list, entry);
      ScrDyn *args[2] = { scr_dyn_new_null(), list };
      scr_dns_call_later(callback, args, 2, true);
    } else {
      ScrDyn *args[3] = { scr_dyn_new_null(), scr_dyn_new_str((ScrStr *)host), scr_dyn_new_num(literal) };
      scr_dns_call_later(callback, args, 3, true);
    }
    return;
  }
  if (memchr(host->data, '\0', host->len) != NULL) {
    ScrStr *shown = scr_str_inspect_quoted((ScrStr *)host, true);
    ScrJsonBuf msg;
    scr_jb_init(&msg);
    scr_jb_puts(&msg, "The argument 'hostname' must be a string without null bytes. Received ");
    scr_jb_put_str(&msg, shown);
    scr_str_release(shown);
    ScrStr *text = scr_jb_finish(&msg);
    scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "ERR_INVALID_ARG_VALUE");
    scr_str_release(text);
    return;
  }
#ifdef _WIN32
  (void)scr_dgram_poller_init();
#endif
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = family == 4 ? AF_INET : family == 6 ? AF_INET6 : AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = ai_flags;
  struct addrinfo *res = NULL;
  int rc = getaddrinfo(host->data, NULL, &hints, &res);
  if (rc != 0 || res == NULL) {
    if (res) freeaddrinfo(res);
    scr_dns_fail(callback, rc != 0 ? rc : EAI_NONAME, host, all, typed);
    return;
  }
  /* the answers in order: verbatim, or one family first (stable) */
  ScrDyn *list = scr_dyn_new_arr();
  for (int pass = 0; pass < 2; pass++) {
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
      int fam = ai->ai_family == AF_INET6 ? 6 : ai->ai_family == AF_INET ? 4 : 0;
      if (fam == 0) continue;
      bool first = order == 0 || (order == 1 ? fam == 4 : fam == 6);
      if (order == 0 ? pass == 1 : first != (pass == 0)) continue;
      char ip[INET6_ADDRSTRLEN];
      const void *src = fam == 4 ? (const void *)&((struct sockaddr_in *)ai->ai_addr)->sin_addr
                                 : (const void *)&((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr;
      if (!inet_ntop(fam == 4 ? AF_INET : AF_INET6, src, ip, sizeof ip)) continue;
      ScrDyn *entry = scr_dyn_new_obj();
      ScrStr *a = scr_str_new(ip, strlen(ip));
      scr_dyn_obj_set(entry, "address", 7, scr_dyn_new_str(a));
      scr_str_release(a);
      scr_dyn_obj_set(entry, "family", 6, scr_dyn_new_num(fam));
      scr_dyn_arr_push(list, entry);
    }
  }
  freeaddrinfo(res);
  if (all) {
    ScrDyn *args[2] = { scr_dyn_new_null(), list };
    scr_dns_call_later(callback, args, 2, false);
    return;
  }
  if (list->v.arr.len == 0) {
    scr_dyn_release(list);
    scr_dns_fail(callback, EAI_NONAME, host, false, typed);
    return;
  }
  const ScrDyn *first = list->v.arr.items[0];
  ScrDyn *args[3] = { scr_dyn_new_null(), scr_dyn_retain((ScrDyn *)scr_dyn_obj_get(first, "address", 7)),
                      scr_dyn_retain((ScrDyn *)scr_dyn_obj_get(first, "family", 6)) };
  scr_dyn_release(list);
  scr_dns_call_later(callback, args, 3, false);
}

/* dns.lookupService(address, port, callback): Node's checks (an IP
 * address, a valid port), then getnameinfo with NI_NAMEREQD. */
void scr_dns_lookup_service(const ScrDyn *address, const ScrDyn *port, const ScrDyn *callback,
                            bool typed) {
  if (address->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("address", "of type string", address);
    return;
  }
  double fam = scr_dns_literal_family(address->v.str);
  if (fam == 0) {
    scr_dyn_arg_value_fail("address", "is invalid", address);
    return;
  }
  double p = NAN;
  bool numeric = (port->kind == SCR_DYN_NUM || port->kind == SCR_DYN_STR) && scr_dyn_number_coerce_js(port, &p);
  if (port->kind == SCR_DYN_STR && port->v.str->len == 0) numeric = false;
  if (!numeric || !(p >= 0 && p < 65536) || trunc(p) != p) {
    char detail[256];
    const char *d = scr_dyn_specific_type(port, detail, sizeof detail);
    char msg[320];
    int len = snprintf(msg, sizeof msg, "Port should be >= 0 and < 65536. Received %s.", d);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_SOCKET_BAD_PORT");
    return;
  }
  if (callback->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("callback", "of type function", callback);
    return;
  }
  struct sockaddr_storage ss;
  memset(&ss, 0, sizeof ss);
  socklen_t len;
  char tmp[64];
  memcpy(tmp, address->v.str->data, address->v.str->len);
  tmp[address->v.str->len] = '\0';
  if (fam == 4) {
    struct sockaddr_in *in = (struct sockaddr_in *)&ss;
    in->sin_family = AF_INET;
    in->sin_port = htons((unsigned short)p);
    inet_pton(AF_INET, tmp, &in->sin_addr);
    len = sizeof *in;
  } else {
    char *pct = strchr(tmp, '%');
    if (pct) *pct = '\0';
    struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)&ss;
    in6->sin6_family = AF_INET6;
    in6->sin6_port = htons((unsigned short)p);
    inet_pton(AF_INET6, tmp, &in6->sin6_addr);
    len = sizeof *in6;
  }
  char host[1025], serv[64];
  int rc = getnameinfo((struct sockaddr *)&ss, len, host, sizeof host, serv, sizeof serv, NI_NAMEREQD);
  if (rc != 0) {
    ScrDyn *err = scr_dns_exception(rc, "getnameinfo", address->v.str);
    if (typed) {
      ScrStr *empty = scr_str_new("", 0);
      ScrDyn *args[3] = { err, scr_dyn_new_str(empty), scr_dyn_new_str(empty) };
      scr_str_release(empty);
      scr_dns_call_later(callback, args, 3, false);
    } else {
      ScrDyn *args[1] = { err };
      scr_dns_call_later(callback, args, 1, false);
    }
    return;
  }
  ScrStr *h = scr_str_new(host, strlen(host));
  ScrStr *sv = scr_str_new(serv, strlen(serv));
  ScrDyn *args[3] = { scr_dyn_new_null(), scr_dyn_new_str(h), scr_dyn_new_str(sv) };
  scr_str_release(h);
  scr_str_release(sv);
  scr_dns_call_later(callback, args, 3, false);
}

/* util.promisify(dns.lookup) and util.promisify(dns.lookupService): the
 * callback forms with a callback that settles the returned promise. An
 * error rejects it; otherwise it fulfills with { address, family } (the
 * address array with options.all) or { hostname, service }, the objects
 * Node's custom promisified forms build. An argument error rejects the
 * promise instead of throwing. */
static ScrDyn *scr_dns_promise_settle(ScrClosure *clo, ScrDyn *const *args, size_t argc,
                                      const char *first, const char *second) {
  ScrPromise *p;
  memcpy(&p, &clo->caps[0]->slot, sizeof p);
  if (argc >= 1 && !scr_dyn_is_nullish(args[0])) {
    scr_dyn_throw(scr_dyn_retain(args[0]));
    scr_promise_reject_pending(p);
    return scr_dyn_undefined();
  }
  ScrDyn *value;
  if (argc == 2) {
    value = scr_dyn_retain(args[1]);
  } else {
    value = scr_dyn_new_obj();
    scr_dyn_obj_set(value, first, strlen(first), argc >= 2 ? scr_dyn_retain(args[1]) : scr_dyn_undefined());
    scr_dyn_obj_set(value, second, strlen(second), argc >= 3 ? scr_dyn_retain(args[2]) : scr_dyn_undefined());
  }
  scr_promise_fulfill_ref(p, value, scr_dyn_retain_v, scr_dyn_release_v, NULL);
  return scr_dyn_undefined();
}

static ScrDyn *scr_dns_lookup_settle(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  return scr_dns_promise_settle(clo, args, argc, "address", "family");
}

static ScrDyn *scr_dns_service_settle(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  return scr_dns_promise_settle(clo, args, argc, "hostname", "service");
}

static ScrDyn *scr_dns_promise_callback(ScrPromise *p, ScrDynThunk thunk) {
  ScrClosure *clo = scr_closure_new((void *)thunk, 1);
  clo->caps[0] = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, NULL);
  scr_box_set_ref(clo->caps[0], scr_promise_retain(p));
  return scr_dyn_new_func(clo, thunk, 3, "(err,a,b)", "callback");
}

ScrPromise *scr_dns_lookup_promise(const ScrDyn *hostname, const ScrDyn *options) {
  ScrPromise *p = scr_promise_new();
  ScrDyn *callback = scr_dns_promise_callback(p, scr_dns_lookup_settle);
  scr_dns_lookup_dyn(hostname, options, callback, false);
  scr_dyn_release(callback);
  if (scr_exc_pending()) scr_promise_reject_pending(p);
  return p;
}

ScrPromise *scr_dns_lookup_service_promise(const ScrDyn *address, const ScrDyn *port) {
  ScrPromise *p = scr_promise_new();
  ScrDyn *callback = scr_dns_promise_callback(p, scr_dns_service_settle);
  scr_dns_lookup_service(address, port, callback, false);
  scr_dyn_release(callback);
  if (scr_exc_pending()) scr_promise_reject_pending(p);
  return p;
}

/* dns.getServers(): the nameserver lines of /etc/resolv.conf, as c-ares
 * reads them ("[addr]:port" only for a port other than 53). +1. */
ScrDyn *scr_dns_get_servers(void) {
  if (scr_dns_servers_hook != NULL) return scr_dns_servers_hook(false);
  ScrDyn *out = scr_dyn_new_arr();
#ifndef _WIN32
  FILE *f = fopen("/etc/resolv.conf", "r");
  if (!f) return out;
  char line[512];
  while (fgets(line, sizeof line, f)) {
    char *p = line;
    while (*p == ' ' || *p == '\t') p++;
    if (strncmp(p, "nameserver", 10) != 0 || (p[10] != ' ' && p[10] != '\t')) continue;
    p += 10;
    while (*p == ' ' || *p == '\t') p++;
    char *end = p;
    while (*end && *end != ' ' && *end != '\t' && *end != '\n' && *end != '\r' && *end != '#' && *end != ';') end++;
    if (end == p) continue;
    ScrStr *s = scr_str_new(p, (size_t)(end - p));
    scr_dyn_arr_push(out, scr_dyn_new_str(s));
    scr_str_release(s);
  }
  fclose(f);
#endif
  return out;
}

void scr_dns_thunk0(ScrClosure *cb, ScrStr *errmsg, ScrStr *addr, double family) {
  (void)errmsg; (void)addr; (void)family;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* ── the sweep: deferred emits ───────────────────────────────────────── */

/* 'close' disposes the signal's listener (Node registers the removable as
 * a once('close') handler). */
static void scr_dgram_clear_abort(ScrDgramSocket *s) {
  if (s->abort_dispose == NULL) return;
  ScrDyn *dispose = s->abort_dispose;
  s->abort_dispose = NULL;
  /* Calling the removable removes the abort listener, as Node's
   * once('close', dispose) does: a signal outliving the socket keeps no
   * reference to it. */
  ScrDyn *result = scr_dyn_call(dispose, NULL, 0, "[Symbol.dispose]");
  scr_dyn_release(result);
  scr_dyn_release(dispose);
}

/* Work the next dispatch delivers now: the deferred emits and the dns
 * deliveries already queued. A query still in flight waits on the poller's
 * own keys and must not arm the wake timer, or the loop would spin for the
 * whole network wait. */
static bool scr_dgram_wake_due(void) {
  if (scr_dns_pending) return true;
  for (ScrDgramSocket *s = scr_dgram_socks; s; s = s->next) {
    if (s->pending_err || s->emit_listening || s->emit_connect) return true;
    if (s->closing && !s->close_emitted) return true;
  }
  return false;
}


static void scr_dgram_sweep(void) {
  ScrDgramSocket *s = scr_dgram_socks;
  while (s) {
    ScrDgramSocket *next = s->next; /* may unregister below */
    scr_dgram_retain(s);           /* callbacks may drop every other ref */
    /* Node's emitListeningNT/emitConnectNT emit only while the handle
     * exists; close() nulls it at once, so a close right after
     * bindSync()/connectSync() suppresses the pending emission. */
    if (s->emit_listening) {
      s->emit_listening = false;
      if (!s->closing) {
        scr_dgram_fire0(&s->listening_ls);
        if (scr_exc_pending()) {
          scr_dgram_release(s);
          return;
        }
      }
    }
    if (s->emit_connect) {
      s->emit_connect = false;
      if (!s->closing) {
        scr_dgram_fire0(&s->conn_ls);
        if (scr_exc_pending()) {
          scr_dgram_release(s);
          return;
        }
      }
    }
    if (s->pending_err) {
      ScrStr *msg = s->pending_err;
      s->pending_err = NULL;
      scr_dgram_fire_err(&s->err_ls, msg, s->pending_code, s->pending_err_obj);
      scr_error_release(s->pending_err_obj);
      s->pending_err_obj = NULL;
      s->pending_code = NULL;
      scr_str_release(msg);
      if (scr_exc_pending()) {
        scr_dgram_release(s);
        return;
      }
      /* A failed bind/connect/send on a never-opened socket leaves it
       * inert: if nothing keeps it live (not bound, not closing), settle
       * it off the registry so the loop can drain — pre-failure
       * listeners drop, the net failed-listen stance. */
      if (!s->closing && !s->close_emitted) {
        if (s->fd < 0) {
          s->close_emitted = true;
          scr_dgram_clear_abort(s);
          scr_dgram_drop_lookup(s);
          scr_dgram_ls_drop(&s->msg_ls);
          scr_dgram_ls_drop(&s->err_ls);
          scr_dgram_ls_drop(&s->listening_ls);
          scr_dgram_ls_drop(&s->close_ls);
          scr_dgram_ls_drop(&s->conn_ls);
          scr_dgram_unregister(s);
          if (scr_exc_pending()) {
            scr_dgram_release(s);
            return;
          }
        } else if (!s->bound && !s->read_armed) {
          /* a failed implicit bind leaves an unbound descriptor behind:
           * Node's never-started handle holds no loop reference, so drop
           * the descriptor and the registry slot. The socket stays usable —
           * a later operation binds afresh — and close() still works. */
          scr_dgram_close_fd_raw(s->fd);
          s->fd = -1;
          scr_dgram_unregister(s);
          if (scr_exc_pending()) {
            scr_dgram_release(s);
            return;
          }
        }
      }
    }
    if (s->closing && !s->close_emitted) {
      s->close_emitted = true;
      scr_dgram_fire0(&s->close_ls);
      scr_dgram_clear_abort(s);
      scr_dgram_drop_lookup(s);
      /* settle: listeners drop (the cycle story), off the registry */
      scr_dgram_ls_drop(&s->msg_ls);
      scr_dgram_ls_drop(&s->err_ls);
      scr_dgram_ls_drop(&s->listening_ls);
      scr_dgram_ls_drop(&s->close_ls);
      scr_dgram_ls_drop(&s->conn_ls);
      scr_dgram_unregister(s);
      if (scr_exc_pending()) {
        scr_dgram_release(s);
        return;
      }
    }
    scr_dgram_release(s);
    s = next;
  }
  /* dns deliveries AFTER the socket emits: Node's numeric/nextTick-ish
   * bind emits land before a threadpool lookup's completion — the
   * observed interleave the differential fixtures pin. */
  while (scr_dns_pending) {
    ScrDnsPending *p = scr_dns_pending;
    scr_dns_pending = p->next;
    if (!scr_exc_pending()) {
      if (p->call != NULL) scr_dns_dyn_call(p->call);
      else p->fn(p->cb, p->errmsg, p->addr, p->family);
    }
    scr_dyn_release(p->call);
    scr_closure_release(p->cb);
    scr_str_release(p->errmsg);
    scr_str_release(p->addr);
    free(p);
    if (scr_exc_pending()) return;
  }
}

/* ── the loop hooks (scr_async.c) ────────────────────────────────────── */

static bool scr_dgram_pending(void) {
  if (scr_dns_pending) return true;
  if (scr_dnsq_hooks != NULL && scr_dnsq_hooks->pending()) return true;
  for (ScrDgramSocket *s = scr_dgram_socks; s; s = s->next) {
    /* Undelivered emits hold the loop even on an unref'd socket (they
     * are due NOW); otherwise an open registered socket holds it unless
     * unref() waived that — Node's unref semantics. */
    if (s->pending_err || s->emit_listening || s->emit_connect ||
        (s->closing && !s->close_emitted)) {
      return true;
    }
    if (!s->unrefed) return true;
  }
  return false;
}

static int scr_dgram_pollfd(void) {
  return scr_dgram_poller != NULL ? scrp_poller_fd(scr_dgram_poller) : -1;
}

static void scr_dgram_dispatch(void) {
  if (!scr_dgram_socks && !scr_dns_pending &&
      (scr_dnsq_hooks == NULL || !scr_dnsq_hooks->pending()))
    return;
  /* One poller drain per call, like the net unit (the events stay queued in
   * the level-triggered poller and the loop calls back while its fd is
   * readable). "Pending" here includes work that is only WAITING on an fd or
   * a timer — a dns query in flight, a listening socket — so draining again
   * straight away would spin to the next deadline and starve the other
   * stations: a dns response answered by the program's own net server could
   * never arrive. */
  scr_dgram_sweep();
  if (scr_exc_pending()) return;
  /* Emits a callback just queued (a connect issued from a 'listening' or a
   * dns callback) are due now: keep the loop from sleeping on them. */
  if (scr_dgram_wake_due()) scr_dgram_wake();
  if (scr_dgram_poller == NULL) return;
  ScrPollerEvent evs[64];
  int n = scrp_drain(scr_dgram_poller, evs, 64);
  for (int i = 0; i < n; i++) {
    if (scr_dnsq_hooks != NULL && scr_dnsq_hooks->owns(evs[i].udata)) {
      scr_dnsq_hooks->event(evs[i].udata, evs[i].events);
      if (scr_exc_pending()) return;
      continue;
    }
    if (evs[i].udata == &scr_dgram_wake_key) {
      scr_dgram_wake_armed = false;
      continue;
    }
    if ((evs[i].events & SCRP_TIMER) != 0) {
      /* Timers on this poller belong to the dns queries. One whose query no
       * longer owns the key was copied by the same drain that delivered the
       * response finishing that query; its key is gone, so there is nothing
       * to deliver. Reading the pointer as a socket would touch freed
       * memory. */
      continue;
    }
    if (!scr_dgram_key_is_socket(evs[i].udata)) continue; /* a query's key, already freed */
    ScrDgramSocket *s = (ScrDgramSocket *)evs[i].udata;
    if (s->fd < 0) continue; /* closed earlier in this batch */
    scr_dgram_read(s);
    if (scr_exc_pending()) return;
  }
  /* Emits a drained event's callback queued (a connect issued from a dns
   * delivery) are due next turn: wake the poll for them too. */
  if (scr_dgram_wake_due()) scr_dgram_wake();
}

/* Exit-time registry cleanup (the scr_net.c precedent): sockets a
 * program legitimately leaves live at exit release their listeners and
 * registry references so the RC audit sees a clean heap. */
static void scr_dgram_cleanup_atexit(void) {
  if (scr_dnsq_hooks != NULL) scr_dnsq_hooks->cleanup();
  while (scr_dgram_socks) {
    ScrDgramSocket *s = scr_dgram_socks;
    scr_dgram_ls_drop(&s->msg_ls);
    scr_dgram_ls_drop(&s->err_ls);
    scr_dgram_ls_drop(&s->listening_ls);
    scr_dgram_ls_drop(&s->close_ls);
    scr_dgram_ls_drop(&s->conn_ls);
    scr_dgram_unregister(s);
  }
  while (scr_dns_pending) {
    ScrDnsPending *p = scr_dns_pending;
    scr_dns_pending = p->next;
    scr_dyn_release(p->call);
    scr_closure_release(p->cb);
    scr_str_release(p->errmsg);
    scr_str_release(p->addr);
    free(p);
  }
}

void scr_dgram_install(void) {
  static SCR_TL bool installed = false;
  if (installed) return;
  installed = true;
  scr_atexit(scr_dgram_cleanup_atexit);
  scr_loop_set_dgram(&scr_dgram_pending, &scr_dgram_dispatch, &scr_dgram_pollfd);
}

/* ── the send argument-validation ladder (checked-dynamic lane) ─────────
 * Node's Socket.prototype.send signature shuffle and validation order
 * over dyn arguments, ported exactly: the connected/unconnected split
 * decides whether (a1, a2) are an offset/length slice or the port/address
 * pair; sliceBuffer validates the buffer's type and bounds
 * (ERR_BUFFER_OUT_OF_BOUNDS); list payloads validate per element with the
 * LIST as the Received tail; unconnected sends validate the port
 * (ERR_SOCKET_BAD_PORT, > 0 and < 65536 with the specific-type tail and
 * Node's trailing period) and the address's string contract; a send with
 * a port or address on a connected socket answers ERR_SOCKET_DGRAM_IS_
 * CONNECTED. A validated send then runs: a list goes out as one
 * datagram, a connected socket sends to its peer, and a completion
 * callback receives (null, bytes) or the send failure after this turn
 * (scr_dgram_send_out). All dyn arguments borrowed. */

static bool scr_dgram_dyn_truthy(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL: return false;
  case SCR_DYN_BOOL: return v->v.b;
  case SCR_DYN_NUM: return v->v.num == v->v.num && v->v.num != 0;
  case SCR_DYN_STR: return v->v.str->len > 0;
  default: return true;
  }
}

static uint32_t scr_dgram_to_u32(const ScrDyn *v) {
  if (v->kind != SCR_DYN_NUM) return 0; /* >>> 0 over the ladder's shapes */
  double t = v->v.num;
  if (t != t || isinf(t)) return 0;
  t = trunc(t);
  t = fmod(t, 4294967296.0);
  if (t < 0) t += 4294967296.0;
  return (uint32_t)t;
}

static const char SCR_DGRAM_BUF_EXPECTED[] =
    "of type string or an instance of Buffer, TypedArray, or DataView";

/* A send failure as the Error Node hands a send callback: the message
 * ("send ECONNREFUSED 127.0.0.1:41234", "getaddrinfo ENOTFOUND nohost")
 * with the system error fields it names. +1. */
static ScrDyn *scr_dgram_send_error(const char *msg) {
  ScrStr *text = scr_str_new(msg, strlen(msg));
  ScrError *e = scr_system_error_from_message(text);
  if (e == NULL) e = scr_error_new(0 /* Error */, text);
  scr_str_release(text);
  ScrDyn *d = scr_dyn_from_error(e);
  scr_error_release(e);
  return d;
}

/* The sendBlockList gate: a blocked destination answers the completion
 * callback with Node's ERR_IP_BLOCKED Error and the datagram is never
 * sent. */
static bool scr_dgram_send_blocked(ScrDgramSocket *s, const char *ip, int family) {
  return s->send_block_list != NULL &&
         scr_net_block_list_blocks(s->send_block_list, ip, family);
}

static ScrDyn *scr_dgram_blocked_error(const char *ip) {
  char text[160];
  int n = snprintf(text, sizeof text, "IP(%s) is blocked by net.BlockList", ip);
  ScrStr *msg = scr_str_new(text, (size_t)n);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, "ERR_IP_BLOCKED");
  ScrDyn *d = scr_dyn_from_error(e);
  scr_error_release(e);
  return d;
}

/* The ladder's send: Node's healthCheck, then one datagram — to the
 * connected peer when host is NULL, else to host:port (an empty host is
 * Node's 127.0.0.1). With a completion callback the result defers to the
 * pending queue the dns deliveries share: (null, bytes) on success, the
 * failure (which has no 'error' event then) otherwise; without one a
 * failure is the deferred 'error', as scr_dgram_send_raw has it. */
static void scr_dgram_send_out(ScrDgramSocket *s, const char *data, size_t len, double port,
                               const ScrStr *host, const ScrDyn *callback) {
  if (s->closing || s->close_emitted) {
    scr_dgram_throw("Not running");
    return;
  }
  bool has_cb = callback != NULL && callback->kind == SCR_DYN_FUNC;
  char msg[192];
  msg[0] = '\0';
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  const char *h =
      host == NULL ? NULL : host->len > 0 ? host->data : (s->v6 ? "::1" : "127.0.0.1");
  if (h != NULL && s->lookup != NULL && !s->lookup_ready) {
    ScrDgramLkJob *job = calloc(1, sizeof *job);
    if (!job) scr_dgram_oom();
    job->op = SCR_DGRAM_LK_SEND_DYN;
    job->address = strdup(h);
    if (!job->address) scr_dgram_oom();
    job->port = port;
    job->data = malloc(len == 0 ? 1 : len);
    if (!job->data) scr_dgram_oom();
    if (len != 0) memcpy(job->data, data, len);
    job->len = len;
    if (has_cb) job->send_cb = scr_dyn_retain((ScrDyn *)callback);
    scr_dgram_lk_start(s, job);
    return;
  }
  if (h != NULL && !scr_dgram_host_addr(s, h, (uint16_t)(int)port, &sa, &salen)) {
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", h);
  } else {
    /* The kernel bind behind Node's send-before-bind: a blocked send
     * returns with the socket really bound (address(), 'listening' and
     * receiving all hold). */
    if (!scr_dgram_bind_wildcard(s)) return;
    scr_dgram_register(s); /* an open sender holds the loop, like Node */
    /* sendBlockList: Node checks the looked-up destination address of a
     * non-connected send (a connected send carries no address and is
     * never gated). A blocked datagram never reaches the wire: the
     * completion callback gets ERR_IP_BLOCKED, no-callback sends answer
     * nothing. */
    char blocked_ip[64];
    blocked_ip[0] = '\0';
    bool blocked = false;
    if (h != NULL && s->send_block_list != NULL) {
      scr_dgram_sockaddr_ip(&sa, blocked_ip, sizeof blocked_ip);
      blocked = scr_dgram_send_blocked(s, blocked_ip, sa.ss_family == AF_INET6 ? 6 : 4);
    }
    if (blocked) {
      if (has_cb) {
        ScrDyn *arg = scr_dgram_blocked_error(blocked_ip);
        scr_dns_call_later(callback, &arg, 1, false);
      }
      scr_dgram_update_read(s);
      return;
    }
    ssize_t sent = h != NULL ? sendto(s->fd, data, len, 0, (struct sockaddr *)&sa, salen)
                             : send(s->fd, data, len, 0);
    if (sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
      const char *code = scr_dgram_errname(errno);
      char ip[64] = "";
      if (h != NULL) scr_dgram_sockaddr_ip(&sa, ip, sizeof ip);
      snprintf(msg, sizeof msg, "send %s %s:%d", code, ip, (int)port);
      /* A connected send names no address ("send ECONNREFUSED"): cut the
       * message after the code (one format string keeps the unit's
       * constant data unchanged). */
      if (h == NULL) msg[5 + strlen(code)] = '\0';
    }
    scr_dgram_update_read(s);
  }
  if (!has_cb) {
    if (msg[0] != '\0') scr_dgram_defer_err(s, msg);
    return;
  }
  if (msg[0] != '\0') {
    ScrDyn *args[1] = { scr_dgram_send_error(msg) };
    scr_dns_call_later(callback, args, 1, false);
  } else {
    ScrDyn *args[2] = { scr_dyn_new_null(), scr_dyn_new_num((double)len) };
    scr_dns_call_later(callback, args, 2, false);
  }
}

void scr_dgram_send_chk(ScrDgramSocket *s, const ScrDyn *buffer, const ScrDyn *a1,
                        const ScrDyn *a2, const ScrDyn *a3, const ScrDyn *a4,
                        const ScrDyn *a5) {
  const ScrDyn *offset = a1, *length = a2, *port = a3, *address = a4;
  const ScrDyn *callback = a5;
  bool connected = s->connected;
  bool sliced = false;
  if (!connected) {
    if (scr_dgram_dyn_truthy(address) ||
        (scr_dgram_dyn_truthy(port) && port->kind != SCR_DYN_FUNC)) {
      sliced = true;
    } else {
      callback = port;
      port = offset;
      address = length;
    }
  } else {
    if (length->kind == SCR_DYN_NUM) {
      sliced = true;
      if (port->kind == SCR_DYN_FUNC) {
        callback = port;
        port = scr_dyn_undefined();
      }
    } else {
      callback = offset;
    }
  }
  size_t slice_off = 0, slice_len = 0;
  if (sliced) {
    double bytelen;
    if (buffer->kind == SCR_DYN_STR) bytelen = (double)buffer->v.str->len;
    else if (buffer->kind == SCR_DYN_BYTES) bytelen = scr_bytes_byte_len(buffer->v.bytes);
    else {
      scr_dyn_arg_type_fail("buffer", SCR_DGRAM_BUF_EXPECTED, buffer);
      return;
    }
    uint32_t off = scr_dgram_to_u32(offset);
    uint32_t len = scr_dgram_to_u32(length);
    if ((double)off > bytelen) {
      static const char msg[] = "\"offset\" is outside of buffer bounds";
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, sizeof msg - 1, "ERR_BUFFER_OUT_OF_BOUNDS");
      return;
    }
    if ((double)off + (double)len > bytelen) {
      static const char msg[] = "\"length\" is outside of buffer bounds";
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, sizeof msg - 1, "ERR_BUFFER_OUT_OF_BOUNDS");
      return;
    }
    slice_off = off;
    slice_len = len;
  } else if (buffer->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < buffer->v.arr.len; i++) {
      const ScrDyn *e = buffer->v.arr.items[i];
      if (e->kind != SCR_DYN_STR && e->kind != SCR_DYN_BYTES) {
        scr_dyn_arg_type_fail("buffer list arguments", SCR_DGRAM_BUF_EXPECTED, buffer);
        return;
      }
    }
  } else if (buffer->kind != SCR_DYN_STR && buffer->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("buffer", SCR_DGRAM_BUF_EXPECTED, buffer);
    return;
  }
  double portnum = 0;
  if (connected) {
    if (scr_dgram_dyn_truthy(port) || scr_dgram_dyn_truthy(address)) {
      scr_dgram_throw("Already connected");
      return;
    }
  } else {
    /* validatePort(port, 'Port', false): integers (or numeric strings)
     * strictly between 0 and 65536; everything else renders the specific
     * type with Node's trailing period. */
    bool ok = false;
    if (port->kind == SCR_DYN_NUM && trunc(port->v.num) == port->v.num &&
        port->v.num > 0 && port->v.num < 65536) {
      ok = true;
      portnum = port->v.num;
    } else if (port->kind == SCR_DYN_STR && port->v.str->len > 0) {
      ScrStr *ps = scr_str_retain(port->v.str);
      double n = scr_string_to_number(ps);
      scr_str_release(ps);
      if (n == n && trunc(n) == n && n > 0 && n < 65536) {
        ok = true;
        portnum = n;
      }
    }
    if (!ok) {
      char detail[64], msg[160];
      const char *d = scr_dyn_specific_type(port, detail, sizeof detail);
      int len = snprintf(msg, sizeof msg, "Port should be > 0 and < 65536. Received %s.", d);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_SOCKET_BAD_PORT");
      return;
    }
  }
  if (callback->kind != SCR_DYN_FUNC) callback = scr_dyn_undefined();
  if (address->kind == SCR_DYN_FUNC) {
    callback = address;
    address = scr_dyn_undefined();
  } else if (address->kind != SCR_DYN_UNDEF && address->kind != SCR_DYN_NULL &&
             address->kind != SCR_DYN_STR) {
    /* Node's gate is null/undefined-only: a falsy 0 still throws. */
    scr_dyn_arg_type_fail("address", "of type string", address);
    return;
  }
  /* The payload: a list concatenates into one datagram (sendmsg's
   * gather), a slice narrows the single payload. */
  char *joined = NULL;
  char *owned = NULL;
  const char *data;
  size_t datalen;
  if (buffer->kind == SCR_DYN_ARR) {
    size_t total = 0;
    for (size_t i = 0; i < buffer->v.arr.len; i++) {
      const ScrDyn *e = buffer->v.arr.items[i];
      total += e->kind == SCR_DYN_STR ? e->v.str->len : (size_t)scr_bytes_byte_len(e->v.bytes);
    }
    joined = malloc(total ? total : 1);
    if (!joined) scr_dgram_oom();
    size_t at = 0;
    for (size_t i = 0; i < buffer->v.arr.len; i++) {
      const ScrDyn *e = buffer->v.arr.items[i];
      if (e->kind == SCR_DYN_STR) {
        char *part_owned;
        const char *part = scr_str_utf8(e->v.str, &part_owned);
        memcpy(joined + at, part, e->v.str->len);
        at += e->v.str->len;
        scr_str_utf8_end(part_owned);
      } else {
        const ScrBytes *b = e->v.bytes;
        SCR_BYTES_SNAPSHOT(b);
        size_t n = (size_t)scr_bytes_byte_len(b);
        if (n) memcpy(joined + at, b->data, n);
        at += n;
      }
    }
    data = joined;
    datalen = total;
  } else {
    const ScrBytes *byte_input = buffer->kind == SCR_DYN_BYTES ? buffer->v.bytes : NULL;
    SCR_BYTES_SNAPSHOT(byte_input);
    data = buffer->kind == SCR_DYN_STR ? scr_str_utf8(buffer->v.str, &owned)
                                       : (const char *)byte_input->data;
    datalen = buffer->kind == SCR_DYN_STR ? buffer->v.str->len
                                          : (size_t)scr_bytes_byte_len(buffer->v.bytes);
    if (sliced) {
      data += slice_off;
      datalen = slice_len;
    }
  }
  if (connected) {
    scr_dgram_send_out(s, data, datalen, 0, NULL, callback);
  } else {
    ScrStr *host = address->kind == SCR_DYN_STR ? scr_str_retain(address->v.str)
                                                : scr_str_new("127.0.0.1", 9);
    scr_dgram_send_out(s, data, datalen, portnum, host, callback);
    scr_str_release(host);
  }
  scr_str_utf8_end(owned);
  free(joined);
}

/* The read arming for the checked-dynamic unit (scr_dgram_dyn.c), after
 * it removes a 'message' listener. Defined last so the functions above
 * keep their emission order. */
void scr_dgram_rearm(ScrDgramSocket *s) { scr_dgram_update_read(s); }

/* ── Unix datagram sockets for the hot-shots package shim ──────────────
 * The unix-dgram addon's surface, which hot-shots' uds transport uses: a
 * non-blocking AF_UNIX datagram socket connected to a path. Each call
 * answers its result (fd, 0) or a negative errno, as the addon's binding
 * does; send answers 1 when the socket would block (the addon's
 * "congestion"). Defined after the functions above so their emission
 * order is unchanged. */
#ifndef _WIN32
#include <sys/un.h>
#endif

double scr_dgram_unix_socket(void) {
#ifdef _WIN32
  return -(double)ENOSYS;
#else
  int fd = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd < 0) return -(double)errno;
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) (void)fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
  return (double)fd;
#endif
}

double scr_dgram_unix_connect(double fd, ScrStr *path) {
#ifdef _WIN32
  (void)fd;
  (void)path;
  return -(double)ENOSYS;
#else
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  char *owned;
  const char *bytes = scr_str_utf8(path, &owned);
  size_t n = strlen(bytes);
  if (n > sizeof addr.sun_path - 1) n = sizeof addr.sun_path - 1;
  memcpy(addr.sun_path, bytes, n);
  scr_str_utf8_end(owned);
  if (connect((int)fd, (struct sockaddr *)&addr, sizeof addr) != 0) return -(double)errno;
  return 0;
#endif
}

double scr_dgram_unix_send(double fd, ScrBytes *data) {
#ifdef _WIN32
  (void)fd;
  (void)data;
  return -(double)ENOSYS;
#else
  SCR_BYTES_SNAPSHOT(data);
  ssize_t sent;
  do {
    sent = send((int)fd, data->data, data->len, 0);
  } while (sent < 0 && errno == EINTR);
  if (sent >= 0) return 0;
  if (errno == EAGAIN || errno == EWOULDBLOCK) return 1;
  return -(double)errno;
#endif
}

double scr_dgram_unix_close(double fd) {
#ifdef _WIN32
  (void)fd;
  return -(double)ENOSYS;
#else
  return close((int)fd) != 0 ? -(double)errno : 0;
#endif
}

/* ── the stub resolver's primitives (scr_dns_resolve.c) ────────────────
 * The unit poller and its watches/timers, the forget-then-close pair,
 * and deferred delivery on the pending queue. Each is a thin spelling of
 * an internal helper above, so the resolver's queries ride the dgram
 * loop's exact lifecycle without a second poller. */
void scr_dgram_poll_ready(void) { (void)scr_dgram_poller_init(); }

void scr_dgram_poll_read(int fd, void *udata, bool on) {
  scr_dgram_watch_read(fd, udata, on);
}

void scr_dgram_poll_write(int fd, void *udata, bool on) {
  if (scr_dgram_poller == NULL || fd < 0) return;
  (void)scrp_watch_write(scr_dgram_poller, fd, udata, on);
}

void scr_dgram_poll_forget(int fd) {
  if (scr_dgram_poller == NULL || fd < 0) return;
  scrp_forget(scr_dgram_poller, fd);
}

void scr_dgram_poll_close(int fd) { scr_dgram_close_fd_raw(fd); }

bool scr_dgram_poll_timer(void *key, double ms, void *udata) {
  if (scr_dgram_poller == NULL) return false;
  return scrp_timer_arm(scr_dgram_poller, key, ms, udata);
}

void scr_dgram_poll_timer_cancel(void *key) {
  if (scr_dgram_poller == NULL) return;
  scrp_timer_cancel(scr_dgram_poller, key);
}

void scr_dns_deliver_dyn(ScrDyn *call) {
  ScrDnsPending *p = calloc(1, sizeof *p);
  if (!p) scr_dgram_oom();
  p->call = call; /* moves */
  ScrDnsPending **link = &scr_dns_pending;
  while (*link) link = &(*link)->next;
  *link = p;
}
