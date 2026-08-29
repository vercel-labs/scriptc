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

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifndef _WIN32
#ifndef __wasi__
#include <pthread.h> /* the resolve threadpool (the fs rename pool's shape) */
#endif
#endif
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h> /* getaddrinfo/EAI_*, inet_pton/ntop, socklen_t */
#else
#include <netdb.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#endif

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
  default: return "EUNKNOWN";
  }
}

/* ── listener lists (the scr_net.c snapshot discipline, restated so this
 * unit links without scr_net.c) ─────────────────────────────────────── */

typedef struct {
  ScrClosure *cb;
  void *fn;
  bool once;
} ScrDgramL;

typedef struct {
  ScrDgramL *ls;
  size_t n, cap;
} ScrDgramLs;

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

/* 'error' with NO listener is fatal, like Node's unhandled EventEmitter
 * 'error' (the scr_net.c stance — _Exit skips atexit on purpose). */
static void scr_dgram_fire_err(ScrDgramLs *l, ScrStr *msg) {
  if (l->n == 0) {
    fflush(stdout);
    fprintf(stderr, "Unhandled 'error' event: Error: %s\n", msg->data);
    _Exit(1);
  }
  ScrDgramL *snap;
  size_t n = scr_dgram_ls_snapshot(l, &snap);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((ScrChildErrFn)snap[i].fn)(snap[i].cb, msg);
    scr_closure_release(snap[i].cb);
  }
  free(snap);
}

/* ── the handle ──────────────────────────────────────────────────────── */

struct ScrDgramSocket {
  size_t rc;
  int fd; /* -1 until bound/connected, -1 again once closed */
  bool reuse_addr;
  bool bound;
  bool connected;
  bool closing;       /* close() called; 'close' fires at the next sweep */
  bool close_emitted; /* settled: off the registry, listeners dropped */
  bool unrefed;       /* waives loop liveness, Node's unref */
  bool read_armed;
  bool emit_listening;
  bool emit_connect;
  ScrStr *pending_err; /* deferred bind/connect/send failure */
  ScrDgramLs msg_ls, err_ls, listening_ls, close_ls, conn_ls;
  bool in_registry;
  struct ScrDgramSocket *next;
};

#ifdef SCR_RC_AUDIT
static long scr_dgram_live = 0;
long scr_dgram_live_count(void) { return scr_dgram_live; }
#endif

static ScrDgramSocket *scr_dgram_socks = NULL; /* registry: +1 each, tail-appended */
static ScrPoller *scr_dgram_poller = NULL;

/* Pending dns.lookup deliveries (already resolved — getaddrinfo ran at
 * the call; the sweep fires them FIFO). */
typedef struct ScrDnsPending {
  ScrClosure *cb; /* +1 */
  ScrDnsLookupFn fn;
  ScrStr *errmsg; /* +1 or NULL (success) */
  ScrStr *addr;   /* +1 ("" on failure) */
  double family;
  struct ScrDnsPending *next;
} ScrDnsPending;

static ScrDnsPending *scr_dns_pending = NULL;

/* ── the dns resolve and reverse threadpool (T3 native slice) ────────────
 * resolve4/resolve6/reverse run their netdb call (getaddrinfo with the
 * pinned family, or getnameinfo for reverse) on a small pool of worker
 * threads — the fs rename pool's exact shape (a real threadpool, NOT
 * the synchronous-at-call dns.lookup above: c-ares-equivalent timing,
 * a slow resolver cannot stall the runtime thread). Completions land on
 * a mutex-guarded done list; the loop's sweep delivers them FIFO on the
 * runtime thread. Windows and WASI have no usable thread story here
 * (no threads at all on WASI), so those arms run the netdb call at
 * call time and queue the delivery — the dns.lookup arm's stance. */
typedef struct ScrDnsJob {
  int family;     /* 4 | 6 resolve; 0 = reverse */
  char *host;     /* malloc'd NUL-terminated copy */
  ScrClosure *cb; /* +1 */
  ScrDnsResolveFn fn;
  struct ScrDnsJob *next;
} ScrDnsJob;

/* A completed resolution awaiting its runtime-thread delivery. */
typedef struct ScrDnsDone {
  ScrClosure *cb; /* +1 */
  ScrDnsResolveFn fn;
  ScrStr *errmsg; /* +1 (failure) or NULL (success) */
  ScrArr *addrs;  /* +1 (success: string[]) or NULL (failure) */
  struct ScrDnsDone *next;
} ScrDnsDone;

static ScrDnsJob *scr_dns_jobq = NULL;   /* guarded */
static ScrDnsDone *scr_dns_doneq = NULL; /* guarded */
static size_t scr_dns_inflight = 0;      /* guarded */
#if !defined(_WIN32) && !defined(__wasi__)
#define SCR_DNS_WORKERS 3
static pthread_mutex_t scr_dns_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t scr_dns_cv = PTHREAD_COND_INITIALIZER;
static pthread_t scr_dns_workers[SCR_DNS_WORKERS];
static bool scr_dns_workers_up = false;
#else
/* The sync arms are single-threaded: no pthread dependency (the
 * scr_async.c arm convention), the lock calls fold away. */
static void scr_dns_lock_enter(void) {}
static void scr_dns_lock_leave(void) {}
#endif

#if !defined(_WIN32) && !defined(__wasi__)
static void scr_dns_lock_enter(void) { (void)pthread_mutex_lock(&scr_dns_lock); }
static void scr_dns_lock_leave(void) { (void)pthread_mutex_unlock(&scr_dns_lock); }
#endif

/* Node's EAI_* → code name mapping (the dns.lookup arm's exact table). */
static const char *scr_dns_eai_code(int rc) {
  return (rc == EAI_NONAME
#ifdef EAI_NODATA
          || rc == EAI_NODATA
#endif
          )
             ? "ENOTFOUND"
         : rc == EAI_AGAIN ? "EAI_AGAIN"
                           : "EAI_FAIL";
}

/* The done-node builder: takes ownership of errmsg/addrs as they sit. */
static void scr_dns_done_push(ScrClosure *cb, ScrDnsResolveFn fn, ScrStr *errmsg,
                              ScrArr *addrs) {
  ScrDnsDone *d = calloc(1, sizeof *d);
  if (!d) scr_dgram_oom();
  d->cb = cb;
  d->fn = fn;
  d->errmsg = errmsg;
  d->addrs = addrs;
  scr_dns_lock_enter();
  ScrDnsDone **link = &scr_dns_doneq;
  while (*link) link = &(*link)->next;
  *link = d;
  scr_dns_lock_leave();
}

/* The blocking netdb call — the worker's whole body, and the sync
 * arms' inline path. Produces the address list (unique, in answer
 * order) or Node's message shape. */
static void scr_dns_job_run(const ScrDnsJob *j, ScrStr **errmsg, ScrArr **addrs) {
  *errmsg = NULL;
  *addrs = NULL;
  if (j->family == 0) {
    /* reverse: the validated IP becomes a sockaddr for getnameinfo. */
    struct sockaddr_in sa4;
    struct sockaddr_in6 sa6;
    const struct sockaddr *sa;
    socklen_t salen;
    memset(&sa4, 0, sizeof sa4);
    memset(&sa6, 0, sizeof sa6);
    if (inet_pton(AF_INET, j->host, &sa4.sin_addr) == 1) {
      sa4.sin_family = AF_INET;
      sa = (struct sockaddr *)&sa4;
      salen = sizeof sa4;
    } else {
      sa6.sin6_family = AF_INET6;
      (void)inet_pton(AF_INET6, j->host, &sa6.sin6_addr);
      sa = (struct sockaddr *)&sa6;
      salen = sizeof sa6;
    }
    char hostbuf[1025];
    int rc = getnameinfo(sa, salen, hostbuf, sizeof hostbuf, NULL, 0, 0);
    if (rc == 0) {
      *addrs = scr_arr_new(SCR_ELEM_STR, 1);
      if (!*addrs) scr_dgram_oom();
      scr_arr_push_ref(*addrs, scr_str_new(hostbuf, strlen(hostbuf)));
    } else {
      const char *code = scr_dns_eai_code(rc);
      char msg[192];
      int mlen = snprintf(msg, sizeof msg, "getnameinfo %s %s", code, j->host);
      *errmsg = scr_str_new(msg, (size_t)mlen);
    }
    return;
  }
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = j->family == 6 ? AF_INET6 : AF_INET;
  hints.ai_socktype = SOCK_DGRAM; /* the dns.lookup arm's hints */
  struct addrinfo *res = NULL;
  int rc = getaddrinfo(j->host, NULL, &hints, &res);
  if (rc == 0 && res) {
    *addrs = scr_arr_new(SCR_ELEM_STR, 4);
    if (!*addrs) scr_dgram_oom();
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
      char ip[64];
      if (ai->ai_family == AF_INET6) {
        inet_ntop(AF_INET6, &((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr, ip, sizeof ip);
      } else {
        inet_ntop(AF_INET, &((struct sockaddr_in *)ai->ai_addr)->sin_addr, ip, sizeof ip);
      }
      size_t n = strlen(ip);
      /* Dedup: getaddrinfo may answer one address several times. */
      bool seen = false;
      for (size_t i = 0; i < scr_arr_len(*addrs) && !seen; i++) {
        ScrStr *have = (ScrStr *)scr_arr_get_ref(*addrs, (double)i);
        seen = have->len == n && memcmp(have->data, ip, n) == 0;
      }
      if (!seen) scr_arr_push_ref(*addrs, scr_str_new(ip, n));
    }
  } else {
    const char *code = scr_dns_eai_code(rc);
    char msg[192];
    int mlen = snprintf(msg, sizeof msg, "getaddrinfo %s %s", code, j->host);
    *errmsg = scr_str_new(msg, (size_t)mlen);
  }
  if (res) freeaddrinfo(res);
}

#if !defined(_WIN32) && !defined(__wasi__)
static void *scr_dns_worker(void *unused) {
  (void)unused;
  for (;;) {
    scr_dns_lock_enter();
    while (scr_dns_jobq == NULL) (void)pthread_cond_wait(&scr_dns_cv, &scr_dns_lock);
    ScrDnsJob *j = scr_dns_jobq;
    scr_dns_jobq = j->next;
    scr_dns_lock_leave();
    /* The blocking call runs OUTSIDE the lock. */
    ScrStr *errmsg = NULL;
    ScrArr *addrs = NULL;
    scr_dns_job_run(j, &errmsg, &addrs);
    scr_dns_done_push(j->cb, j->fn, errmsg, addrs);
    free(j->host);
    free(j);
    scr_dns_lock_enter();
    scr_dns_inflight--;
    scr_dns_lock_leave();
  }
  return NULL;
}

/* Bring the pool up on first use. A failed spawn leaves one fewer
 * worker; the jobs still complete when any worker survives, and the
 * queue is drained at process exit (the threads die with it). */
static void scr_dns_workers_start(void) {
  if (scr_dns_workers_up) return;
  scr_dns_workers_up = true;
  for (int i = 0; i < SCR_DNS_WORKERS; i++) {
    (void)pthread_create(&scr_dns_workers[i], NULL, scr_dns_worker, NULL);
  }
}
#endif /* !_WIN32 && !__wasi__ */

/* The public entry's shared enqueue: takes cb (+1) and host (malloc'd).
 * POSIX runs it on the pool; Windows/WASI run the call inline and queue
 * the delivery only. */
static void scr_dns_job_push(int family, char *host, ScrClosure *cb, ScrDnsResolveFn fn) {
  ScrDnsJob *j = calloc(1, sizeof *j);
  if (!j) scr_dgram_oom();
  j->family = family;
  j->host = host;
  j->cb = cb;
  j->fn = fn;
#if !defined(_WIN32) && !defined(__wasi__)
  scr_dns_lock_enter();
  ScrDnsJob **link = &scr_dns_jobq;
  while (*link) link = &(*link)->next;
  *link = j;
  scr_dns_inflight++;
  scr_dns_lock_leave();
  (void)pthread_cond_broadcast(&scr_dns_cv);
#else
  ScrStr *errmsg = NULL;
  ScrArr *addrs = NULL;
  scr_dns_job_run(j, &errmsg, &addrs);
  scr_dns_done_push(j->cb, j->fn, errmsg, addrs);
  free(j->host);
  free(j);
#endif
}

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

/* ── the surface ─────────────────────────────────────────────────────── */

ScrDgramSocket *scr_dgram_create(bool reuse_addr) {
  ScrDgramSocket *s = calloc(1, sizeof *s);
  if (!s) scr_dgram_oom();
  s->rc = 1;
  s->fd = -1;
  s->reuse_addr = reuse_addr;
#ifdef SCR_RC_AUDIT
  scr_dgram_live++;
#endif
  return s;
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

/* Resolve a numeric host into a sockaddr_in; "" means any (bind's
 * default), "localhost" pins to 127.0.0.1 (the net stance). False for
 * non-numeric hosts — the caller defers Node's ENOTFOUND. */
static bool scr_dgram_host4(const char *host, uint16_t port, struct sockaddr_in *out) {
  memset(out, 0, sizeof *out);
  out->sin_family = AF_INET;
  out->sin_port = htons(port);
  if (host[0] == '\0') {
    out->sin_addr.s_addr = INADDR_ANY;
    return true;
  }
  if (strcmp(host, "localhost") == 0) host = "127.0.0.1";
  return inet_pton(AF_INET, host, &out->sin_addr) == 1;
}

/* Create the fd (idempotent). Aborts only on resource exhaustion, the
 * scr_net.c socket() stance. */
static void scr_dgram_ensure_fd(ScrDgramSocket *s) {
  if (s->fd >= 0) return;
  if (!scr_dgram_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) {
    fputs("scriptc: socket() failed\n", stderr);
    abort();
  }
  scr_dgram_nonblock(fd);
  if (s->reuse_addr) {
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  }
  s->fd = fd;
}

static void scr_dgram_defer_err(ScrDgramSocket *s, const char *msg) {
  if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
  scr_dgram_register(s); /* the sweep delivers it */
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
  if (cb) scr_dgram_ls_add(&s->listening_ls, cb, NULL, true);
  struct sockaddr_in a4;
  if (!scr_dgram_host4(host->data, (uint16_t)(int)port, &a4)) {
    char msg[160];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", host->data);
    scr_dgram_defer_err(s, msg);
    return;
  }
  scr_dgram_ensure_fd(s);
  if (bind(s->fd, (struct sockaddr *)&a4, sizeof a4) != 0) {
    int err = errno;
    char ip[64];
    inet_ntop(AF_INET, &a4.sin_addr, ip, sizeof ip);
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
  scr_dgram_register(s);
  scr_dgram_update_read(s);
}

/* connect(port, host): implicit-binds (Node emits 'listening' for that,
 * then 'connect'); UDP connect(2) is local and immediate, so failures
 * here are deferred 'error's only for bad hosts. */
void scr_dgram_connect(ScrDgramSocket *s, double port, ScrStr *host, ScrClosure *cb) {
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
  if (cb) scr_dgram_ls_add(&s->conn_ls, cb, NULL, true);
  struct sockaddr_in a4;
  if (!scr_dgram_host4(host->data, (uint16_t)(int)port, &a4) || host->len == 0) {
    char msg[160];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", host->data);
    scr_dgram_defer_err(s, msg);
    return;
  }
  scr_dgram_ensure_fd(s);
  if (!s->bound) {
    s->bound = true;
    s->emit_listening = true; /* Node's implicit bind emits 'listening' */
  }
  if (connect(s->fd, (struct sockaddr *)&a4, sizeof a4) != 0) {
    char msg[128];
    char ip[64];
    inet_ntop(AF_INET, &a4.sin_addr, ip, sizeof ip);
    snprintf(msg, sizeof msg, "connect %s %s:%d", scr_dgram_errname(errno), ip, (int)port);
    scr_dgram_defer_err(s, msg);
    return;
  }
  s->connected = true;
  s->emit_connect = true;
  scr_dgram_register(s);
  scr_dgram_update_read(s);
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
  struct sockaddr_in a4;
  if (!scr_dgram_host4(host->data, (uint16_t)(int)port, &a4) || host->len == 0) {
    char msg[160];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", host->data);
    scr_dgram_defer_err(s, msg);
    return;
  }
  scr_dgram_ensure_fd(s);
  if (!s->bound) {
    /* Implicit ephemeral bind — Node's send-before-bind, 'listening'
     * emits for it there too. */
    s->bound = true;
    s->emit_listening = true;
  }
  scr_dgram_register(s); /* an open sender holds the loop, like Node */
  if (sendto(s->fd, data, len, 0, (struct sockaddr *)&a4, sizeof a4) < 0 &&
      errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
    char ip[64];
    inet_ntop(AF_INET, &a4.sin_addr, ip, sizeof ip);
    char msg[128];
    snprintf(msg, sizeof msg, "send %s %s:%d", scr_dgram_errname(errno), ip, (int)port);
    scr_dgram_defer_err(s, msg);
  }
  scr_dgram_update_read(s);
}

void scr_dgram_send_str(ScrDgramSocket *s, ScrStr *data, double port, ScrStr *host) {
  scr_dgram_send_raw(s, data->data, data->len, port, host);
}

void scr_dgram_send_bytes(ScrDgramSocket *s, ScrBytes *data, double port, ScrStr *host) {
  scr_dgram_send_raw(s, (const char *)data->data, data->len, port, host);
}

/* address() parts. The ip read carries the "Not running" throw; family
 * and port only run after it succeeded. */
ScrStr *scr_dgram_addr_ip(ScrDgramSocket *s) {
  if (s->fd < 0 || !s->bound) {
    scr_dgram_throw("Not running");
    return NULL;
  }
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  char ip[64] = "0.0.0.0";
  if (getsockname(s->fd, (struct sockaddr *)&sa, &salen) == 0 && sa.ss_family == AF_INET) {
    inet_ntop(AF_INET, &((struct sockaddr_in *)&sa)->sin_addr, ip, sizeof ip);
  }
  return scr_str_new(ip, strlen(ip));
}

ScrStr *scr_dgram_addr_family(ScrDgramSocket *s) {
  (void)s; /* udp4 is the one lowered type */
  return scr_str_new("IPv4", 4);
}

double scr_dgram_addr_port(ScrDgramSocket *s) {
  struct sockaddr_storage sa;
  socklen_t salen = sizeof sa;
  if (s->fd >= 0 && getsockname(s->fd, (struct sockaddr *)&sa, &salen) == 0 &&
      sa.ss_family == AF_INET) {
    return (double)ntohs(((struct sockaddr_in *)&sa)->sin_port);
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
    if (from.ss_family == AF_INET) {
      inet_ntop(AF_INET, &((struct sockaddr_in *)&from)->sin_addr, ip, sizeof ip);
      rport = ntohs(((struct sockaddr_in *)&from)->sin_port);
    }
    ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
    memcpy(chunk->data, buf, (size_t)n);
    ScrStr *addr = scr_str_new(ip, strlen(ip));
    ScrStr *family = scr_str_new("IPv4", 4);
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

void scr_dns_thunk0(ScrClosure *cb, ScrStr *errmsg, ScrStr *addr, double family) {
  (void)errmsg; (void)addr; (void)family;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* ── dns.resolve4 / resolve6 / reverse (the T3 native slice) ──────────
 * The threadpool arm above carries the netdb call; this is the entry:
 * queue the job, delivery via FN on a later sweep. The callback shape
 * is (err, addresses): errmsg NULL + a string[] on success, Node's
 * message string on failure (the frontend's adapter wraps it). An IP
 * that fails inet_pton validation throws synchronously like Node's
 * ERR_INVALID_IP_ADDRESS. */
static void scr_dns_resolve_impl(int family, ScrStr *hostname, ScrClosure *cb,
                                 ScrDnsResolveFn fn) {
  char *host = malloc(hostname->len + 1);
  if (!host) scr_dgram_oom();
  memcpy(host, hostname->data, hostname->len);
  host[hostname->len] = 0;
  scr_dns_job_push(family, host, cb, fn); /* takes cb (+1) and host */
#if !defined(_WIN32) && !defined(__wasi__)
  scr_dns_workers_start();
#endif
}

void scr_dns_resolve(ScrStr *hostname, double family, ScrClosure *cb, ScrDnsResolveFn fn) {
  scr_dns_resolve_impl(family == 6 ? 6 : 4, hostname, cb, fn);
}

void scr_dns_reverse(ScrStr *ip, ScrClosure *cb, ScrDnsResolveFn fn) {
  /* Validate NOW (the throw is synchronous, Node's stance): the worker
   * thread cannot throw into the runtime. */
  unsigned char v6[16];
  unsigned char v4[4];
  bool ok = inet_pton(AF_INET, ip->data, v4) == 1 ||
            inet_pton(AF_INET6, ip->data, v6) == 1;
  if (!ok) {
    scr_closure_release(cb);
    char msg[64 + 64];
    int mlen = snprintf(msg, sizeof msg, "Invalid IP address: %.*s", (int)ip->len, ip->data);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)mlen, "ERR_INVALID_IP_ADDRESS");
    return;
  }
#ifdef _WIN32
  /* getnameinfo needs winsock started (WSANOTINITIALISED otherwise). */
  (void)scr_dgram_poller_init();
#endif
  char *host = malloc(ip->len + 1);
  if (!host) scr_dgram_oom();
  memcpy(host, ip->data, ip->len);
  host[ip->len] = 0;
  scr_dns_job_push(0, host, cb, fn); /* takes cb (+1) and host */
#if !defined(_WIN32) && !defined(__wasi__)
  scr_dns_workers_start();
#endif
}

/* In-flight or undelivered resolve work — the loop's liveness and the
 * sleep cap both read this (the callback owns no runtime liveness). */
bool scr_dns_jobs_pending(void) {
  scr_dns_lock_enter();
  bool pending = scr_dns_jobq != NULL || scr_dns_doneq != NULL || scr_dns_inflight > 0;
  scr_dns_lock_leave();
  return pending;
}

/* The sweep's resolve deliveries: FIFO, on the runtime thread. */
static void scr_dns_drain_done(void) {
  for (;;) {
    scr_dns_lock_enter();
    ScrDnsDone *d = scr_dns_doneq;
    if (d) scr_dns_doneq = d->next;
    scr_dns_lock_leave();
    if (!d) return;
    if (!scr_exc_pending()) d->fn(d->cb, d->errmsg, d->addrs);
    scr_closure_release(d->cb);
    scr_str_release(d->errmsg);
    if (d->addrs) scr_arr_release(d->addrs);
    free(d);
    if (scr_exc_pending()) return; /* the rest wait for a calmer sweep */
  }
}

/* ── the sweep: deferred emits ───────────────────────────────────────── */

static bool scr_dgram_flags_pending(void) {
  if (scr_dns_pending || scr_dns_jobs_pending()) return true;
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
    if (s->emit_listening) {
      s->emit_listening = false;
      scr_dgram_fire0(&s->listening_ls);
      if (scr_exc_pending()) {
        scr_dgram_release(s);
        return;
      }
    }
    if (s->emit_connect) {
      s->emit_connect = false;
      scr_dgram_fire0(&s->conn_ls);
      if (scr_exc_pending()) {
        scr_dgram_release(s);
        return;
      }
    }
    if (s->pending_err) {
      ScrStr *msg = s->pending_err;
      s->pending_err = NULL;
      scr_dgram_fire_err(&s->err_ls, msg);
      scr_str_release(msg);
      if (scr_exc_pending()) {
        scr_dgram_release(s);
        return;
      }
      /* A failed bind/connect/send on a never-opened socket leaves it
       * inert: if nothing keeps it live (not bound, not closing), settle
       * it off the registry so the loop can drain — pre-failure
       * listeners drop, the net failed-listen stance. */
      if (s->fd < 0 && !s->closing && !s->close_emitted) {
        s->close_emitted = true;
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
    }
    if (s->closing && !s->close_emitted) {
      s->close_emitted = true;
      scr_dgram_fire0(&s->close_ls);
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
    if (!scr_exc_pending()) p->fn(p->cb, p->errmsg, p->addr, p->family);
    scr_closure_release(p->cb);
    scr_str_release(p->errmsg);
    scr_str_release(p->addr);
    free(p);
    if (scr_exc_pending()) return;
  }
  /* resolve and reverse deliveries after both (a worker may have landed a
   * completion while the lookup sweeps ran — FIFO per queue, queues in
   * call order). */
  scr_dns_drain_done();
}

/* ── the loop hooks (scr_async.c) ────────────────────────────────────── */

static bool scr_dgram_pending(void) {
  if (scr_dns_pending || scr_dns_jobs_pending()) return true;
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
  if (!scr_dgram_socks && !scr_dns_pending && !scr_dns_jobs_pending()) return;
  for (;;) {
    scr_dgram_sweep();
    if (scr_exc_pending()) return;
    if (scr_dgram_poller == NULL) return;
    ScrPollerEvent evs[64];
    int n = scrp_drain(scr_dgram_poller, evs, 64);
    for (int i = 0; i < n; i++) {
      ScrDgramSocket *s = (ScrDgramSocket *)evs[i].udata;
      if (!s || s->fd < 0) continue; /* closed earlier in this batch */
      scr_dgram_read(s);
      if (scr_exc_pending()) return;
    }
    if (!scr_dgram_flags_pending()) return;
    if (scr_loop_has_ready()) return; /* microtasks interleave first */
  }
}

/* Exit-time registry cleanup (the scr_net.c precedent): sockets a
 * program legitimately leaves live at exit release their listeners and
 * registry references so the RC audit sees a clean heap. */
static void scr_dgram_cleanup_atexit(void) {
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
    scr_closure_release(p->cb);
    scr_str_release(p->errmsg);
    scr_str_release(p->addr);
    free(p);
  }
}

void scr_dgram_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  atexit(scr_dgram_cleanup_atexit);
  scr_loop_set_dgram(&scr_dgram_pending, &scr_dgram_dispatch, &scr_dgram_pollfd);
  scr_loop_set_dns_jobs(&scr_dns_jobs_pending);
}

/* ── the send argument-validation ladder (checked-dynamic lane) ─────────
 * Node's Socket.prototype.send signature shuffle and validation order
 * over dyn arguments, byte-for-byte: the connected/unconnected split
 * decides whether (a1, a2) are an offset/length slice or the port/address
 * pair; sliceBuffer validates the buffer's type and bounds
 * (ERR_BUFFER_OUT_OF_BOUNDS); list payloads validate per element with the
 * LIST as the Received tail; unconnected sends validate the port
 * (ERR_SOCKET_BAD_PORT, > 0 and < 65536 with the specific-type tail and
 * Node's trailing period) and the address's string contract; a send with
 * a port or address on a connected socket answers ERR_SOCKET_DGRAM_IS_
 * CONNECTED. A fully-validated unconnected single-payload send RUNS —
 * the callback form and the connected sends keep the compiler-rendered
 * fence. All dyn arguments borrowed. */

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

void scr_dgram_send_chk(ScrDgramSocket *s, const ScrDyn *buffer, const ScrDyn *a1,
                        const ScrDyn *a2, const ScrDyn *a3, const ScrDyn *a4,
                        const ScrStr *fence) {
  const ScrDyn *offset = a1, *length = a2, *port = a3, *address = a4;
  const ScrDyn *callback = scr_dyn_undefined();
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
      if (port->kind == SCR_DYN_FUNC) callback = port;
    } else {
      callback = offset;
      port = a3;
      address = a4;
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
  if (connected) {
    if (scr_dgram_dyn_truthy(port) || scr_dgram_dyn_truthy(address)) {
      scr_dgram_throw("Already connected");
      return;
    }
    scr_throw_lowering_fence(fence); /* connected sends have no lowering yet */
    return;
  }
  /* validatePort(port, 'Port', false): integers (or numeric strings)
   * strictly between 0 and 65536; everything else renders the specific
   * type with Node's trailing period. */
  double portnum = -1;
  {
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
  if (address->kind == SCR_DYN_FUNC) {
    callback = address;
    address = scr_dyn_undefined();
  } else if (address->kind != SCR_DYN_UNDEF && address->kind != SCR_DYN_NULL &&
             address->kind != SCR_DYN_STR) {
    /* Node's gate is null/undefined-only: a falsy 0 still throws. */
    scr_dyn_arg_type_fail("address", "of type string", address);
    return;
  }
  if (callback->kind == SCR_DYN_FUNC || buffer->kind == SCR_DYN_ARR) {
    /* completion callbacks and list concatenation have no lowering yet —
     * refuse loudly after the full validation ladder, never drop */
    scr_throw_lowering_fence(fence);
    return;
  }
  const char *data = buffer->kind == SCR_DYN_STR ? buffer->v.str->data
                                                 : (const char *)buffer->v.bytes->data;
  size_t datalen = buffer->kind == SCR_DYN_STR ? buffer->v.str->len
                                               : (size_t)scr_bytes_byte_len(buffer->v.bytes);
  if (sliced) {
    data += slice_off;
    datalen = slice_len;
  }
  ScrStr *host = address->kind == SCR_DYN_STR ? scr_str_retain(address->v.str)
                                              : scr_str_new("127.0.0.1", 9);
  scr_dgram_send_raw(s, data, datalen, portnum, host);
  scr_str_release(host);
}
