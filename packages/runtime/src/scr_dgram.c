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


#ifdef SCR_RC_AUDIT
static SCR_TL long scr_dgram_live = 0;
long scr_dgram_live_count(void) { return scr_dgram_live; }
#endif

static SCR_TL ScrDgramSocket *scr_dgram_socks = NULL; /* registry: +1 each, tail-appended */
static SCR_TL ScrPoller *scr_dgram_poller = NULL;

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
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  scr_dgram_send_raw(s, bytes, data->len, port, host);
  scr_str_utf8_end(owned);
}

void scr_dgram_send_bytes(ScrDgramSocket *s, ScrBytes *data, double port, ScrStr *host) {
  SCR_BYTES_SNAPSHOT(data);
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

/* ── socket options (dgram.Socket's setters and getters) ───────────────
 * Each follows Node's dgram.js plus the libuv call under it: the value
 * checks run first, then the option goes to the descriptor, so a socket
 * that has no descriptor yet (never bound) answers EBADF. After close()
 * Node's handle is null, so most members throw the TypeError reading a
 * property of null; the ones that call healthCheck() throw "Not running". */

typedef struct { int value; const char *name; const char *message; } ScrDgramUvError;
#define SCR_DGRAM_UV_ERROR(name, message) { SCR_NODE_UV__##name, #name, message },
static const ScrDgramUvError scr_dgram_uv_errors[] = { SCR_NODE_UV_ERRNO_MAP(SCR_DGRAM_UV_ERROR) };
#undef SCR_DGRAM_UV_ERROR

/* The libuv name, number and message for an errno value (by name, so
 * the win32 arm's translated errno values find the same entries). */
static const ScrDgramUvError *scr_dgram_uv_error(int err) {
  static const ScrDgramUvError unknown = { SCR_NODE_UV__UNKNOWN, "UNKNOWN", "unknown error" };
  const char *name = scr_dgram_errname(err);
  for (size_t i = 0; i < sizeof scr_dgram_uv_errors / sizeof scr_dgram_uv_errors[0]; i++) {
    if (strcmp(scr_dgram_uv_errors[i].name, name) == 0) return &scr_dgram_uv_errors[i];
  }
  return &unknown;
}

/* Node's ErrnoException: "<syscall> <CODE>" with code, errno and syscall. */
static void scr_dgram_throw_errno(int err, const char *syscall) {
  const ScrDgramUvError *uv = scr_dgram_uv_error(err);
  char text[96];
  int n = snprintf(text, sizeof text, "%s %s", syscall, uv->name);
  ScrStr *msg = scr_str_new(text, n < 0 ? 0 : (size_t)n);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  scr_str_release(msg);
  scr_error_set_code(e, uv->name);
  e->system_errno = uv->value;
  e->system_call = scr_str_new(syscall, strlen(syscall));
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* Node's ERR_SOCKET_BUFFER_SIZE SystemError for a failed libuv buffer
 * size call. */
static void scr_dgram_throw_buffer_size(int err, const char *syscall) {
  const ScrDgramUvError *uv = scr_dgram_uv_error(err);
  char text[192];
  int n = snprintf(text, sizeof text, "Could not get or set buffer size: %s returned %s (%s)", syscall,
                   uv->name, uv->message);
  ScrStr *msg = scr_str_new(text, n < 0 ? 0 : (size_t)n);
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
  scr_throw_error_msg(SCR_ERR_TYPE, text, n < 0 ? 0 : (size_t)n);
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

double scr_dgram_set_ttl(ScrDgramSocket *s, double ttl) {
  if (scr_dgram_handle_gone(s, "setTTL")) return ttl;
  int value = scr_dgram_to_int32(ttl);
  if (value < 1 || value > 255) {
    scr_dgram_throw_errno(EINVAL, "setTTL");
  } else if (!scr_dgram_setopt_int(s, IPPROTO_IP, IP_TTL, value)) {
    scr_dgram_throw_errno(errno, "setTTL");
  }
  return ttl;
}

double scr_dgram_set_multicast_ttl(ScrDgramSocket *s, double ttl) {
  if (scr_dgram_handle_gone(s, "setMulticastTTL")) return ttl;
  int value = scr_dgram_to_int32(ttl);
  if (value < 0 || value > 255) {
    scr_dgram_throw_errno(EINVAL, "setMulticastTTL");
  } else if (!scr_dgram_setopt_int(s, IPPROTO_IP, IP_MULTICAST_TTL, value)) {
    scr_dgram_throw_errno(errno, "setMulticastTTL");
  }
  return ttl;
}

bool scr_dgram_set_multicast_loopback(ScrDgramSocket *s, bool flag) {
  if (scr_dgram_handle_gone(s, "setMulticastLoopback")) return flag;
  if (!scr_dgram_setopt_int(s, IPPROTO_IP, IP_MULTICAST_LOOP, flag ? 1 : 0))
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
  if (s->fd < 0) {
    char text[96];
    int n = snprintf(text, sizeof text, "dgram.Socket.%s before bind() is not supported yet", syscall);
    scr_throw_error_msg_code(SCR_ERR_ERROR, text, n < 0 ? 0 : (size_t)n, "SC2020");
    return;
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
  if (!s->connected || s->emit_connect) {
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
    if (from.ss_family == AF_INET) {
      inet_ntop(AF_INET, &((struct sockaddr_in *)&from)->sin_addr, ip, sizeof ip);
      rport = ntohs(((struct sockaddr_in *)&from)->sin_port);
    }
    ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
    chunk->is_buffer = true; /* the message is a Buffer */
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
             options->kind != SCR_DYN_NULL) {
    scr_dyn_arg_type_fail("options", "of type integer or an instance of Object", options);
    return;
  } else if (options->kind == SCR_DYN_OBJ) {
    const ScrDyn *v = scr_dyn_obj_get(options, "hints", 5);
    if (v != NULL && v->kind != SCR_DYN_UNDEF && v->kind != SCR_DYN_NULL) {
      if (v->kind != SCR_DYN_NUM) {
        scr_dyn_prop_type_fail("options.hints", "of type number", v);
        return;
      }
      /* Node's validateHints: only dns.ADDRCONFIG, dns.V4MAPPED and
       * dns.ALL (getaddrinfo's own flags), which then reach getaddrinfo */
      double h = v->v.num;
      int allowed = AI_ADDRCONFIG | AI_V4MAPPED | AI_ALL;
      if (!(h == h && trunc(h) == h && h >= 0 && h <= 0x7fffffff) || ((int)h & ~allowed) != 0) {
        scr_dyn_arg_value_fail("hints", "is invalid", v);
        return;
      }
      ai_flags = (int)h;
    }
    v = scr_dyn_obj_get(options, "family", 6);
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
      ScrDyn *args[3] = { scr_dyn_new_null(), scr_dyn_new_null(), scr_dyn_new_num(family == 6 ? 6 : 4) };
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

static bool scr_dgram_flags_pending(void) {
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
  if (!scr_dgram_socks && !scr_dns_pending) return;
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
 * with the code its second word names. +1. */
static ScrDyn *scr_dgram_send_error(const char *msg) {
  ScrStr *text = scr_str_new(msg, strlen(msg));
  ScrError *e = scr_error_new(0 /* Error */, text);
  scr_str_release(text);
  const char *sp = strchr(msg, ' ');
  if (sp != NULL) {
    char code[48];
    size_t n = 0;
    while (sp[1 + n] != '\0' && sp[1 + n] != ' ') n++;
    if (n > 0 && n < sizeof code) {
      memcpy(code, sp + 1, n);
      code[n] = '\0';
      scr_error_set_code(e, code);
    }
  }
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
  bool has_cb = callback->kind == SCR_DYN_FUNC;
  char msg[192];
  msg[0] = '\0';
  struct sockaddr_in a4;
  const char *h = host == NULL ? NULL : host->len > 0 ? host->data : "127.0.0.1";
  if (h != NULL && !scr_dgram_host4(h, (uint16_t)(int)port, &a4)) {
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", h);
  } else {
    scr_dgram_ensure_fd(s);
    if (!s->bound) {
      /* Implicit ephemeral bind — Node's send-before-bind emits
       * 'listening' for it. */
      s->bound = true;
      s->emit_listening = true;
    }
    scr_dgram_register(s); /* an open sender holds the loop, like Node */
    ssize_t sent = h != NULL ? sendto(s->fd, data, len, 0, (struct sockaddr *)&a4, sizeof a4)
                             : send(s->fd, data, len, 0);
    if (sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
      const char *code = scr_dgram_errname(errno);
      char ip[64] = "";
      if (h != NULL) inet_ntop(AF_INET, &a4.sin_addr, ip, sizeof ip);
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
