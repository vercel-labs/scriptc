
#include "scr_platform.h"
#include "scr_runtime.h"

#include <errno.h>
#include <limits.h>
#include <ctype.h>
#include <math.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netdb.h> /* getaddrinfo — the client bridges' blocking lookup */
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/un.h> /* AF_UNIX: listen(path) and http's socketPath */
#if defined(__FreeBSD__) || defined(__DragonFly__) || defined(_AIX) || defined(__sun)
#include <sys/param.h>
#endif
#endif

/* MinGW's errno headers do not expose ENOTSUP on every supported toolchain.
 * Keep a stable internal value for the Node/libuv unsupported reuse-port
 * result, while preserving the platform's EOPNOTSUPP spelling when present. */
#ifndef ENOTSUP
#ifdef EOPNOTSUPP
#define ENOTSUP EOPNOTSUPP
#else
#define ENOTSUP 4095
#endif
#endif

static void scr_net_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

#ifdef _WIN32
/* ── the winsock arm ───────────────────────────────────────────────────
 * The BSD socket calls this file speaks, respelled once so every call
 * site below stays byte-identical: SOCKETs narrow through the int fd
 * contract (kernel handles fit — scr_child.c's stdio plumbing relies on
 * the same), failures land their WSA code in errno TRANSLATED to the
 * POSIX constant the call sites and the error-name table test (libuv
 * performs the same translation for Node, so the spellings agree with
 * the Windows oracle), socket reads are recv (ReadFile/_read do not
 * apply to winsock handles), and close is closesocket. WSAStartup lives
 * in scrp_poller_new (scr_loop_wsapoll.c) — every socket() site in this
 * file is preceded by scr_net_poller_init(). Two call-shape notes: a
 * pending nonblocking connect answers WSAEWOULDBLOCK where the sites
 * test EINPROGRESS (the connect wrapper translates), and SO_ERROR
 * answers a WSA code the getsockopt wrapper maps before the table sees
 * it. No SIGPIPE exists on Windows — a closed-peer send just fails. */
static int scr_w32_map_err(int e) {
  switch (e) {
  case WSAEWOULDBLOCK: return EAGAIN;
  case WSAEINTR: return EINTR;
  case WSAECONNREFUSED: return ECONNREFUSED;
  case WSAECONNRESET: return ECONNRESET;
  case WSAECONNABORTED: return ECONNABORTED;
  case WSAESHUTDOWN: return EPIPE; /* libuv's map: send-after-shutdown is EPIPE */
  case WSAEADDRINUSE: return EADDRINUSE;
  case WSAEACCES: return EACCES;
  case WSAEADDRNOTAVAIL: return EADDRNOTAVAIL;
  case WSAETIMEDOUT: return ETIMEDOUT;
  case WSAEHOSTUNREACH: return EHOSTUNREACH;
  case WSAENETUNREACH: return ENETUNREACH;
  case WSAEINVAL: return EINVAL;
  default: return e;
  }
}

static void scr_w32_seterr(void) { errno = scr_w32_map_err((int)WSAGetLastError()); }

static int scr_w32_socket(int af, int type, int proto) {
  SOCKET s = socket(af, type, proto);
  if (s == INVALID_SOCKET) {
    scr_w32_seterr();
    return -1;
  }
  return (int)s;
}

static int scr_w32_bind(int fd, const struct sockaddr *sa, socklen_t len) {
  if (bind((SOCKET)fd, sa, (int)len) != 0) {
    scr_w32_seterr();
    return -1;
  }
  return 0;
}

static int scr_w32_connect(int fd, const struct sockaddr *sa, socklen_t len) {
  if (connect((SOCKET)fd, sa, (int)len) != 0) {
    int e = (int)WSAGetLastError();
    /* pending nonblocking connect: WSAEWOULDBLOCK here is the callers'
     * EINPROGRESS, not recv's EAGAIN */
    errno = e == WSAEWOULDBLOCK ? EINPROGRESS : scr_w32_map_err(e);
    return -1;
  }
  return 0;
}

static int scr_w32_listen(int fd, int backlog) {
  if (listen((SOCKET)fd, backlog) != 0) {
    scr_w32_seterr();
    return -1;
  }
  return 0;
}

static int scr_w32_accept(int fd, struct sockaddr *sa, socklen_t *len) {
  int ilen = len != NULL ? (int)*len : 0;
  SOCKET s = accept((SOCKET)fd, sa, len != NULL ? &ilen : NULL);
  if (len != NULL) *len = (socklen_t)ilen;
  if (s == INVALID_SOCKET) {
    scr_w32_seterr();
    return -1;
  }
  return (int)s;
}

static int scr_w32_getsockname(int fd, struct sockaddr *sa, socklen_t *len) {
  int ilen = (int)*len;
  int rc = getsockname((SOCKET)fd, sa, &ilen);
  *len = (socklen_t)ilen;
  if (rc != 0) {
    scr_w32_seterr();
    return -1;
  }
  return 0;
}

static int scr_w32_setsockopt(int fd, int level, int name, const void *val, socklen_t len) {
  if (setsockopt((SOCKET)fd, level, name, (const char *)val, (int)len) != 0) {
    scr_w32_seterr();
    return -1;
  }
  return 0;
}

static int scr_w32_getsockopt(int fd, int level, int name, void *val, socklen_t *len) {
  int ilen = (int)*len;
  int rc = getsockopt((SOCKET)fd, level, name, (char *)val, &ilen);
  *len = (socklen_t)ilen;
  if (rc != 0) {
    scr_w32_seterr();
    return -1;
  }
  if (level == SOL_SOCKET && name == SO_ERROR && ilen == (int)sizeof(int)) {
    *(int *)val = scr_w32_map_err(*(int *)val); /* the table speaks POSIX */
  }
  return 0;
}

static ssize_t scr_w32_read(int fd, void *buf, size_t len) {
  int n = recv((SOCKET)fd, (char *)buf, len > 0x40000000 ? 0x40000000 : (int)len, 0);
  if (n < 0) scr_w32_seterr();
  return n;
}

static int scr_w32_close(int fd) {
  if (closesocket((SOCKET)fd) != 0) {
    scr_w32_seterr();
    return -1;
  }
  return 0;
}

#define socket(af, type, proto) scr_w32_socket((af), (type), (proto))
#define bind(fd, sa, len) scr_w32_bind((fd), (sa), (len))
#define connect(fd, sa, len) scr_w32_connect((fd), (sa), (len))
#define listen(fd, backlog) scr_w32_listen((fd), (backlog))
#define accept(fd, sa, len) scr_w32_accept((fd), (sa), (len))
#define getsockname(fd, sa, len) scr_w32_getsockname((fd), (sa), (len))
#define setsockopt(fd, l, n, v, len) scr_w32_setsockopt((fd), (l), (n), (v), (len))
#define getsockopt(fd, l, n, v, len) scr_w32_getsockopt((fd), (l), (n), (v), (len))
#define read(fd, buf, len) scr_w32_read((fd), (buf), (len))
#define close(fd) scr_w32_close(fd)
#define SHUT_WR SD_SEND
#endif /* _WIN32 */

/* Node's error-code names for the socket errors this slice can meet. */
static const char *scr_net_errname(int err) {
  switch (err) {
  case ECONNREFUSED: return "ECONNREFUSED";
  case ECONNRESET: return "ECONNRESET";
  case ECONNABORTED: return "ECONNABORTED";
  case EPIPE: return "EPIPE";
  case EADDRINUSE: return "EADDRINUSE";
  case EACCES: return "EACCES";
  case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
  case ETIMEDOUT: return "ETIMEDOUT";
  case EHOSTUNREACH: return "EHOSTUNREACH";
  case ENETUNREACH: return "ENETUNREACH";
#ifdef EHOSTDOWN
  case EHOSTDOWN: return "EHOSTDOWN"; /* absent from the win32 CRT */
#endif
  case EINVAL: return "EINVAL";
  case ENOTSUP: return "ENOTSUP";
#if defined(EOPNOTSUPP) && (!defined(ENOTSUP) || EOPNOTSUPP != ENOTSUP)
  case EOPNOTSUPP: return "EOPNOTSUPP";
#endif
  default: return "EUNKNOWN";
  }
}

/* ── listener lists (the events/child snapshot discipline) ─────────────
 * The types live in scr_runtime.h: scr_http.c reuses the whole family
 * for its request-body listener lists. */

struct ScrNetOnce {
  size_t rc;
  bool fired;
};

ScrNetOnce *scr_net_once_new(void) {
  ScrNetOnce *once = calloc(1, sizeof *once);
  if (!once) scr_net_oom();
  once->rc = 1;
  return once;
}

ScrNetOnce *scr_net_once_retain(ScrNetOnce *once) {
  once->rc++;
  return once;
}

void scr_net_once_release(ScrNetOnce *once) {
  if (once != NULL && --once->rc == 0) free(once);
}

void scr_net_ls_add(ScrNetLs *l, ScrClosure *cb, void *fn, bool once) {
  if (l->n == l->cap) {
    l->cap = l->cap ? l->cap * 2 : 2;
    l->ls = realloc(l->ls, l->cap * sizeof *l->ls);
    if (!l->ls) scr_net_oom();
  }
  l->ls[l->n].cb = cb;
  l->ls[l->n].fn = fn;
  l->ls[l->n].once = once;
  l->ls[l->n].shared_once = NULL;
  l->n++;
}

void scr_net_ls_add_shared_once(ScrNetLs *l, ScrClosure *cb, void *fn,
                                ScrNetOnce *once /*moves*/) {
  scr_net_ls_add(l, cb, fn, true);
  l->ls[l->n - 1].shared_once = once;
}

bool scr_net_ls_has_live(const ScrNetLs *l) {
  for (size_t i = 0; i < l->n; i++) {
    if (l->ls[i].shared_once == NULL || !l->ls[i].shared_once->fired) return true;
  }
  return false;
}

void scr_net_ls_drop(ScrNetLs *l) {
  for (size_t i = 0; i < l->n; i++) {
    scr_closure_release(l->ls[i].cb);
    scr_net_once_release(l->ls[i].shared_once);
  }
  free(l->ls);
  l->ls = NULL;
  l->n = l->cap = 0;
}

/* Snapshot for a firing pass: entries retained; `once` entries leave the
 * LIVE list before their callback runs (Node's once semantics — a
 * re-delivery during the callback re-registers cleanly). Caller invokes
 * each snapshot entry, releases it, and frees the vector. */
size_t scr_net_ls_snapshot(ScrNetLs *l, ScrNetL **out) {
  size_t n = l->n;
  if (n == 0) {
    *out = NULL;
    return 0;
  }
  ScrNetL *snap = malloc(n * sizeof *snap);
  if (!snap) scr_net_oom();
  size_t nsnap = 0;
  size_t w = 0;
  for (size_t i = 0; i < l->n; i++) {
    ScrNetL entry = l->ls[i];
    bool emit = entry.shared_once == NULL || !entry.shared_once->fired;
    if (emit) {
      if (entry.shared_once != NULL) entry.shared_once->fired = true;
      snap[nsnap] = entry;
      snap[nsnap].shared_once = NULL;
      scr_closure_retain(snap[nsnap].cb);
      nsnap++;
    }
    if (l->ls[i].once) {
      scr_closure_release(l->ls[i].cb);
      scr_net_once_release(l->ls[i].shared_once);
    } else {
      l->ls[w++] = l->ls[i];
    }
  }
  l->n = w;
  if (nsnap == 0) {
    free(snap);
    snap = NULL;
  }
  *out = snap;
  return nsnap;
}

/* Fire a zero-payload event list (end/close/connect/listening) with the
 * emitting handle bound as the ambient receiver for each callback (Node
 * calls listeners with `this` === the emitter — scr_runtime.h's design
 * note). `self` is BORROWED (the caller keeps the handle alive across
 * the pass); NULL binds the undefined receiver. */
void scr_net_fire0_this(ScrNetLs *l, void *self, ScrDynHandleTag tag) {
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(l, &snap);
  scr_dyn_this_push(self, tag);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
}

void scr_net_fire0(ScrNetLs *l) { scr_net_fire0_this(l, NULL, 0); }

/* A list mixing zero-argument closures (fn NULL) with dyn listeners
 * (fn = a ScrNetArgFn) — the close(hadError) and write(chunk, cb(err))
 * shapes: the dyn ones receive `arg`. */
typedef void (*ScrNetArgFn)(ScrClosure *cb, const ScrDyn *arg);

static void scr_net_fire_arg_this(ScrNetLs *l, const ScrDyn *arg, void *self, ScrDynHandleTag tag) {
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(l, &snap);
  scr_dyn_this_push(self, tag);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) {
      if (snap[i].fn != NULL) ((ScrNetArgFn)snap[i].fn)(snap[i].cb, arg);
      else ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
    }
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
}

/* The dyn listener's call with one argument (none for NULL). */
static void scr_net_dyn_fire_arg(ScrClosure *cb, const ScrDyn *arg) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *args[1] = { (ScrDyn *)arg };
  scr_dyn_release(scr_dyn_call(fn, args, arg != NULL ? 1 : 0, "listener"));
  scr_dyn_release(fn);
}

/* The JS function a listener entry stands for: the boxed function of a
 * dyn listener closure, otherwise the closure's own identity. */
static ScrClosure *scr_net_listener_root(const ScrNetL *e) {
  ScrClosure *c = e->cb;
  if (e->fn == (void *)&scr_net_dyn_fire_arg || c->fn == (void *)&scr_dyn_listener_fire0) {
    ScrDyn *boxed = scr_dyn_listener_fn(c);
    ScrClosure *inner = boxed->kind == SCR_DYN_FUNC ? boxed->v.fn.clo : NULL;
    scr_dyn_release(boxed);
    if (inner != NULL) return inner->identity ? inner->identity : inner;
  }
  return c->identity ? c->identity : c;
}

/* The listener standing for the same function as `root` (through any
 * adapter) leaves the list: removeListener's first match. */
static void scr_net_ls_remove_fn(ScrNetLs *l, ScrClosure *root) {
  root = root->identity ? root->identity : root;
  for (size_t i = 0; i < l->n; i++) {
    ScrClosure *c = l->ls[i].cb;
    if (scr_net_listener_root(&l->ls[i]) != root) continue;
    scr_closure_release(c);
    scr_net_once_release(l->ls[i].shared_once);
    memmove(&l->ls[i], &l->ls[i + 1], (l->n - i - 1) * sizeof *l->ls);
    l->n--;
    return;
  }
}

/* Fire an error list through the ScrChildErrFn adapters (msg borrowed),
 * the emitting handle bound as the ambient receiver. An 'error' with NO
 * listener is fatal, like Node's unhandled 'error' EventEmitter throw:
 * print and die 1 (_Exit skips atexit on purpose — the loop dies
 * mid-turn with registries live, like process.exit). Exported:
 * scr_http.c's req/res/client fire their 'error' the same way. */
void scr_net_fire_err_this(ScrNetLs *l, ScrStr *msg, void *self, ScrDynHandleTag tag) {
  if (l->n == 0) {
    fflush(stdout);
    fprintf(stderr, "Unhandled 'error' event: Error: %s\n", msg->data);
    _Exit(1);
  }
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(l, &snap);
  scr_dyn_this_push(self, tag);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((ScrChildErrFn)snap[i].fn)(snap[i].cb, msg);
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
}

void scr_net_fire_err(ScrNetLs *l, ScrStr *msg) { scr_net_fire_err_this(l, msg, NULL, 0); }

/* ── the handles ─────────────────────────────────────────────────────── */

enum { SCR_NET_K_SERVER = 1, SCR_NET_K_SOCKET = 2 };

struct ScrNetServer {
  int kind; /* FIRST: poller udata routes on it */
  size_t rc;
  /* The AsyncLocalStorage contexts of the listen() and close() calls
   * (+1, NULL outside a store): 'listening', 'connection' and 'error' run
   * in the first, 'close' and the close() callbacks in the second, as
   * Node runs them in its handle's and its close request's contexts. */
  ScrAlsCtx *listen_ctx, *close_ctx;
  int fd; /* -1 while not listening */
  int port;
  bool listening;
  bool unrefd;        /* server.unref(): does not keep the loop alive */
  bool closing;       /* close() called; 'close' fires when conns drain */
  bool close_emitted; /* settled: off the registry, listeners dropped */
  bool emit_listening;
  /* The writable http.Server timeout property values. Kept on the shared
   * server handle because http/https servers retain that handle identity;
   * plain net servers never expose these fields through the static type
   * surface. Indices match lower-server.ts's selector ABI. */
  double http_timeouts[5];
  /* A dynamic write may store any JS value on these ordinary writable
   * properties. Numeric writes stay in http_timeouts; every other value
   * is retained here so dynamic reads preserve kind and identity. */
  ScrDyn *http_timeout_dyn[5];
  bool http_timeout_surface; /* true only for HTTP/1 and HTTPS servers */
  bool defer_conn; /* TLS: 'connection' fires post-handshake, not at accept */
  bool bound_v6;       /* the bound family (address()'s 'IPv6'/'IPv4' split) */
  ScrStr *bound_host;  /* the explicit bind host (NULL = the host-less any:
                        * '::' when bound_v6, else '0.0.0.0' — Node's own
                        * address().address answers) */
  ScrStr *pending_err; /* deferred listen failure */
  ScrStr *unix_path;   /* listen(path): the bound socket file, removed at close */
  size_t nconns;
  ScrNetLs conn_ls, err_ls, close_ls, listening_cbs, timeout_ls;
  /* tls/https servers: 'tlsClientError' (err, tlsSocket), fired by the
   * TLS unit for a handshake that fails */
  ScrNetLs client_error_ls;
  /* server.maxConnections (unset = undefined) and its 'drop' listeners */
  bool max_conns_set;
  double max_conns;
  ScrNetLs drop_ls;
  /* server.dropMaxConnection (NULL = undefined): Node reads it only in
   * cluster mode, so here it is a stored value */
  ScrDyn *drop_max_connection;
  /* protocol layer (scr_http.c): a C-level connection consumer + its
   * context, freed with the handle */
  ScrNetNativeConnFn native_conn;
  void *native_ctx;
  void (*native_ctx_free)(void *);
  /* the HTTP-parser ctx ALIAS (borrowed — owned through the native-conn
   * chain): late 'request' installs reach it even after a TLS wrap
   * replaced native_ctx (the https/http2 servers). NULL = no parser. */
  void *http_ctx;
  /* The protocol layer's settle hook (scr_http.c): drops the ctx's OWN
   * listener lists when the server settles — the settle-releases-
   * listeners story extended across the layer seam. A request handler
   * capturing its own server through a dyn binding box would otherwise
   * cycle through edges the collector cannot trace (box → dyn → handle →
   * ctx → closure → box). Takes http_ctx; NULL = no hook. */
  void (*proto_settle)(void *http_ctx);
  /* wrapper.close = fn — the portless close-proxy idiom: when set,
   * server.close() invokes THIS closure (a compiler-emitted zero-arg
   * wrapper around the user override) instead of closing; the override
   * body reaches the real close through its bound `origClose` value
   * (scr_net_server_close_direct — never re-consults the override). */
  ScrClosure *close_override;
  /* close-REQUEST order (a global stamp set by close_direct): drained
   * servers settle in ascending order, matching Node's emission order
   * when several close in one turn (the wrapper-closes-inner idiom). */
  size_t close_seq;
  bool in_registry;
  struct ScrNetServer *next;
};

struct ScrNetSocket {
  int kind; /* FIRST: poller udata routes on it */
  size_t rc;
  /* The AsyncLocalStorage context of the socket's creation (+1, NULL
   * outside a store): its I/O events ('connect', 'data', 'end', 'close',
   * 'error', 'timeout') run in it, as Node runs them in its handle's
   * context. An accepted socket has none, except under an HTTP or TLS
   * server, whose sockets take the server's listen() context. end_ctx is
   * the end() call's context, for 'finish' and the end() callback (Node's
   * shutdown request). */
  ScrAlsCtx *als, *end_ctx;
  int fd; /* -1 once closed */
  bool unrefd; /* socket.unref(): does not keep the loop alive */
  bool connecting;
  bool rd_eof;    /* peer FIN seen (or read half abandoned) */
  bool enc_utf8;  /* setEncoding('utf8'): 'data' delivers strings */
  bool wr_ending; /* end() called: FIN when the buffer drains */
  bool wr_done;   /* FIN sent (or write half dead) */
  bool had_error;
  bool emit_close;    /* fd closed; 'close' fires at the next sweep */
  bool close_emitted; /* settled */
  bool read_armed, write_armed;
  /* write buffer: [whead, wlen) of wbuf is unsent */
  char *wbuf;
  size_t whead, wlen, wcap;
  /* receive buffer: [rhead, rlen) of rbuf is arrived-but-unconsumed —
   * fed by paused-mode reads ('readable' consumers) and unshift; drained
   * FIRST by every consumer (data listeners, the parser attach, the TLS
   * bio) so a peeked byte re-enters the stream ahead of the kernel's */
  char *rbuf;
  size_t rhead, rlen, rcap;
  ScrNetSocket *pipe_dst; /* +1; src EOF end()s the dst, Node's pipe default */
  /* peer identity for Node-shaped connect error messages */
  char peer_ip[64];
  int peer_port;
  /* remoteAddress, cached at first read like Node's _getpeername — a
   * value read while connected survives destroy; never-read sockets
   * answer undefined after close */
  ScrStr *remote_cache;
  int remote_port_cache;
  bool remote_v6_cache;
  ScrStr *pending_err; /* deferred connect failure */
  /* pending_err's code when its message does not name one (static
   * storage; NULL = the code the message maps to) */
  const char *pending_code;
  /* the caller-lookup dial (net.connect with a lookup option): true while
   * the lookup decides; dial_ips holds its answered addresses (+1 each),
   * dialed in order — a connect failure closes the fd and tries
   * dial_ips[dial_i]; the LAST failure's message surfaces (Node's
   * autoSelectFamily aggregate is the documented divergence) */
  bool lookup_wait;
  /* a deferred dial (the http agent's maxSockets queue): registered and
   * "connecting" (writes buffer), the actual dial starts on
   * scr_net_sock_dial_start */
  bool dial_deferred;
  ScrStr **dial_ips;
  size_t dial_n, dial_i;
  /* a host name the dial resolves first (+1; NULL for IP literals) */
  ScrStr *dial_host;
  /* the host a client dial was given, Node's socket._host (+1; NULL on
   * server sockets): tls.connect({ socket }) verifies against it */
  ScrStr *host_name;
  /* the in-flight dial chain's LAST failure — surfaced (moved into
   * pending_err) only when the list exhausts; a later success drops it */
  ScrStr *dial_err;
  /* a dial that is not the TCP sockaddr path (the Unix-socket connect):
   * scr_net_sock_dial_peer hands the dial to it; unix_path is its target */
  void (*dial_hook)(ScrNetSocket *s);
  ScrStr *unix_path;
  /* 'lookup' listeners and the resolutions waiting to reach them (the
   * lookup unit's records; see scr_net_lookup_ops) */
  ScrNetLs lookup_ls;
  struct ScrNetLookupEv *lookup_evs;
  ScrNetLs data_ls, end_ls, close_ls, err_ls, conn_ls, timeout_ls, readable_ls;
  /* Flow control (pause()/resume()): user_paused holds reads OFF even
   * with consumers (kernel/TCP backpressure is the buffer); flowing
   * counts as a consumer even with no 'data' listener
   * (resume()'s flow-and-discard drain, how Node reaches 'end' on an
   * unconsumed stream). resume() clears user_paused and sets flowing. */
  bool user_paused;
  bool flowing;
  /* scr_net_sock_hold: a protocol consumer (an HTTP/1 server request
   * holding unread body bytes) stops reads without touching the user's
   * pause state */
  bool hold;
  /* EOF arrived while the socket buffered for a consumer it does not have
   * yet: 'end' waits until one drains the buffer (Node's readable state) */
  bool eof_pending;
  /* destroySoon(): end() now, destroy once the FIN actually went out */
  bool destroy_on_finish;
  /* socket.bytesWritten: every byte accepted by the write paths (user
   * writes, protocol heads, pipe deliveries — plaintext on TLS sockets) */
  size_t bytes_written;
  /* end(callback)/write(chunk, callback): 'finish'-shaped callbacks fire
   * from the SWEEP (never the registering stack — Node defers them too).
   * finish_ls waits for the FIN (wr_done); wcb_ls waits for the write
   * buffer to drain (this surface's flush moment). */
  ScrNetLs finish_ls, wcb_ls;
  bool finish_pending; /* wr_done seen: fire finish_ls at the next sweep */
  ScrNetLs ready_ls;   /* 'ready': right after the client's 'connect' listeners */
  size_t bytes_read;   /* socket.bytesRead: every byte delivered from the peer */
  /* a server whose 'connection' waits for this socket's handshake — the
   * TLS defer target (+1; the socket's own `server` backref stays the
   * ACCEPTING server, which may be the demux wrapper) */
  ScrNetServer *conn_pending;
  /* the idle timer (setTimeout): a one-shot poller timer keyed by this
   * socket's pointer, re-armed on every read/write/connect activity —
   * 'timeout' fires once per idle period and never destroys the socket,
   * Node's semantics */
  double timeout_ms;
  bool timeout_armed;
  ScrNetServer *server; /* +1 backref (accepted sockets), NULL for clients */
  /* protocol layer (scr_http.c): a C-level reader — counts as a consumer
   * for read-arming; its context BORROWS this socket and is freed with it */
  ScrNetNativeDataFn native_data;
  ScrNetNativeEventFn native_eof;
  ScrNetNativeEventFn native_closed;
  ScrNetNativeEventFn native_timeout;
  ScrNetNativeTimeoutHandledFn native_http_timeout; /* HTTP req/res timeout handled */
  ScrNetNativeEventFn native_established; /* client connect completed (the
                                           * h2 session's 'connect' moment;
                                           * fires before conn_ls) */
  ScrNetNativeErrFn native_err; /* true = consumed (the protocol layer owns
                                 * the error story); false falls through to
                                 * this socket's own err_ls */
  bool (*native_idle)(void *); /* HTTP parser: no active request or partial head */
  void *native_ctx;
  void (*native_ctx_free)(void *);
  /* transport layer (scr_tls.c): reads/writes redirect through the ops
   * once set; writes buffer and readiness drives the handshake until
   * t_est. Sits BELOW the protocol layer — an https socket carries both
   * (the parser in native_*, the TLS engine here). */
  const ScrNetTransportOps *tops;
  void *tctx;
  bool t_est;
  bool t_want_write; /* a handshake send hit EAGAIN: arm the write filter */
  bool in_registry;
  struct ScrNetSocket *next;
  /* an HTTP CONNECT tunnel (scr_net_sock_set_tunnel), set from the dial
   * until the proxy answers 200: writes buffer and the transport
   * handshake waits until the tunnel is up */
  struct ScrNetTunnel *tunnel;
  /* new tls.TLSSocket(socket) and tls.connect({ socket }): on the wrapped
   * socket, the socket that took over its connection (+1; end() and
   * destroy() act on it); on that socket, the one it took over (+1; its
   * 'close' fires just before this socket's, as in Node) */
  struct ScrNetSocket *adopted_by;
  struct ScrNetSocket *adopted_from;
};

/* The CONNECT head still being sent from out_off, and the proxy's
 * response head as it arrives. */
typedef struct ScrNetTunnel {
  char *out;
  size_t out_len, out_off;
  char *in;
  size_t in_len;
  /* bytes a wrapped socket left unsent, which go out before the
   * transport's own; no response head is read */
  bool send_only;
} ScrNetTunnel;

/* The 'lookup' event's half of the runtime, installed by the first
 * 'lookup' registration: programs without a 'lookup' listener never link
 * it, and the hook sites below are a NULL check. */
typedef struct ScrNetLookupOps {
  /* a host name resolved (ip/family) or failed (err_msg, ip NULL) */
  void (*record)(ScrNetSocket *s, const char *host, size_t host_len, const char *ip, int family,
                 const char *err_msg);
  void (*flush)(ScrNetSocket *s); /* deliver the recorded resolutions */
  void (*free)(ScrNetSocket *s);
} ScrNetLookupOps;
/* Not static: the compiler must not resolve the calls through it to the
 * one implementation, which would link that half into every program. */
extern SCR_TL const ScrNetLookupOps *scr_net_lookup_ops;
SCR_TL const ScrNetLookupOps *scr_net_lookup_ops = NULL;

static void scr_net_tunnel_free(ScrNetTunnel *t) {
  if (t == NULL) return;
  free(t->out);
  free(t->in);
  free(t);
}

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_net_live = 0;
long scr_net_live_count(void) { return scr_net_live; }
#endif

static SCR_TL ScrNetServer *scr_net_servers = NULL; /* registry: +1 each, tail-appended */
static SCR_TL ScrNetSocket *scr_net_socks = NULL;
static SCR_TL ScrPoller *scr_net_poller = NULL;

/* ── RC ──────────────────────────────────────────────────────────────── */

static void scr_net_close_fd_raw(int fd); /* forget-then-close, defined below */

/* The listen() call's context: the server's 'listening', 'connection'
 * and 'error' events run in it. */
static void scr_net_server_capture_listen(ScrNetServer *s) {
  scr_als_ctx_release(s->listen_ctx);
  s->listen_ctx = scr_als_capture();
}

ScrNetServer *scr_net_server_retain(ScrNetServer *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_net_server_release(ScrNetServer *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    if (s->native_ctx_free) s->native_ctx_free(s->native_ctx);
    scr_net_ls_drop(&s->conn_ls);
    scr_net_ls_drop(&s->err_ls);
    scr_net_ls_drop(&s->close_ls);
    scr_net_ls_drop(&s->listening_cbs);
    scr_net_ls_drop(&s->timeout_ls);
    scr_net_ls_drop(&s->drop_ls);
    scr_als_ctx_release(s->listen_ctx);
    scr_als_ctx_release(s->close_ctx);
    scr_closure_release(s->close_override);
    for (size_t i = 0; i < 5; i++) scr_dyn_release(s->http_timeout_dyn[i]);
    scr_dyn_release(s->drop_max_connection);
    scr_str_release(s->bound_host);
    scr_str_release(s->pending_err);
    scr_str_release(s->unix_path);
    if (s->fd >= 0) scr_net_close_fd_raw(s->fd);
#ifdef SCR_RC_AUDIT
    scr_net_live--;
#endif
    scr_weak_dispose_inline(s); /* weak collections keyed by this socket or server */
    free(s);
  }
}

void *scr_net_server_retain_v(void *p) { return scr_net_server_retain((ScrNetServer *)p); }
void scr_net_server_release_v(void *p) { scr_net_server_release((ScrNetServer *)p); }

ScrNetSocket *scr_net_sock_retain(ScrNetSocket *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_net_sock_release(ScrNetSocket *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    if (s->native_ctx_free) s->native_ctx_free(s->native_ctx);
    if (s->tops && s->tops->free) s->tops->free(s->tctx);
    scr_net_ls_drop(&s->data_ls);
    scr_net_ls_drop(&s->end_ls);
    scr_net_ls_drop(&s->close_ls);
    scr_net_ls_drop(&s->err_ls);
    scr_net_ls_drop(&s->conn_ls);
    scr_net_ls_drop(&s->timeout_ls);
    scr_net_ls_drop(&s->readable_ls);
    scr_net_ls_drop(&s->finish_ls);
    scr_net_ls_drop(&s->wcb_ls);
    scr_net_ls_drop(&s->ready_ls);
    scr_als_ctx_release(s->als);
    scr_als_ctx_release(s->end_ctx);
    scr_str_release(s->pending_err);
    scr_str_release(s->remote_cache);
    for (size_t i = 0; i < s->dial_n; i++) scr_str_release(s->dial_ips[i]);
    free(s->dial_ips);
    scr_str_release(s->dial_err);
    scr_str_release(s->dial_host);
    scr_str_release(s->host_name);
    scr_str_release(s->unix_path);
    scr_net_ls_drop(&s->lookup_ls);
    if (s->lookup_evs != NULL) scr_net_lookup_ops->free(s);
    scr_net_tunnel_free(s->tunnel);
    free(s->wbuf);
    free(s->rbuf);
    if (s->pipe_dst) scr_net_sock_release(s->pipe_dst);
    if (s->conn_pending) scr_net_server_release(s->conn_pending);
    if (s->server) scr_net_server_release(s->server);
    if (s->adopted_by) scr_net_sock_release(s->adopted_by);
    if (s->adopted_from) scr_net_sock_release(s->adopted_from);
    if (s->fd >= 0) scr_net_close_fd_raw(s->fd);
#ifdef SCR_RC_AUDIT
    scr_net_live--;
#endif
    scr_weak_dispose_inline(s); /* weak collections keyed by this socket or server */
    free(s);
  }
}

void *scr_net_sock_retain_v(void *p) { return scr_net_sock_retain((ScrNetSocket *)p); }
void scr_net_sock_release_v(void *p) { scr_net_sock_release((ScrNetSocket *)p); }

/* ── poller plumbing (the scr_platform.h seam) ───────────────────────── */

static bool scr_net_poller_init(void) {
  if (scr_net_poller != NULL) return true;
  scr_net_poller = scrp_poller_new();
  return scr_net_poller != NULL;
}

static void scr_net_nonblock(int fd) {
#ifdef _WIN32
  u_long one = 1;
  ioctlsocket((SOCKET)fd, FIONBIO, &one);
  /* FD_CLOEXEC's spelling: spawned children must not inherit the socket */
  SetHandleInformation((HANDLE)(SOCKET)fd, HANDLE_FLAG_INHERIT, 0);
#else
  fcntl(fd, F_SETFL, O_NONBLOCK);
  fcntl(fd, F_SETFD, FD_CLOEXEC);
#ifdef SO_NOSIGPIPE
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
#endif
}

/* SO_REUSEADDR on listeners, POSIX only — libuv's exact split. On Unix
 * the flag lets a restarted server rebind its TIME_WAIT port (Node's
 * behavior, so the historical call stands). On Windows the SAME flag
 * means port hijacking: a second bind of an actively-listened port
 * SUCCEEDS and so does its listen(), so EADDRINUSE never surfaces — the
 * net-port-check/net-error-codes fixtures hang waiting for an 'error'
 * that never comes. Winsock's default already permits the TIME_WAIT
 * rebind, so omitting the flag there loses nothing and restores Node's
 * (libuv's) EADDRINUSE. */
static void scr_net_listen_reuseaddr(int fd) {
#ifdef _WIN32
  (void)fd;
#else
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
#endif
}

/* Node/libuv's TCP reuse-port matrix. SO_REUSEPORT is deliberately NOT
 * selected merely because a platform header happens to expose it: macOS's
 * meaning is not the required TCP load-balancing contract, and Windows'
 * SO_REUSEADDR is port hijacking rather than reuse-port support. FreeBSD's
 * ordinary SO_REUSEPORT does not distribute connections, so FreeBSD 12+
 * uses the load-balancing spelling instead. A setsockopt failure is returned
 * to the caller so an unsupported kernel cannot become a singleton without an error. */
static int scr_net_listen_reuseport(int fd) {
  int rc;
#if defined(__FreeBSD__) && defined(__FreeBSD_version) && \
    __FreeBSD_version >= 1200000 && defined(SO_REUSEPORT_LB)
  int one = 1;
  rc = setsockopt(fd, SOL_SOCKET, SO_REUSEPORT_LB, &one, sizeof one);
#elif (defined(__linux__) || defined(_AIX73) || \
       (defined(__DragonFly__) && defined(__DragonFly_version) && __DragonFly_version >= 300600) || \
       (defined(__sun) && !defined(__illumos__) && defined(SO_FLOW_NAME))) && \
      defined(SO_REUSEPORT)
  int one = 1;
  rc = setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
#else
  (void)fd;
  errno = ENOTSUP;
  return -1;
#endif
#if defined(__linux__) && defined(ENOPROTOOPT)
  /* Linux kernels predating 3.9 expose no reuse-port TCP support. Keep
   * Node's stable unsupported result instead of leaking ENOPROTOOPT. */
  if (rc != 0 && errno == ENOPROTOOPT) errno = ENOTSUP;
#endif
  return rc;
}

/* Shared bind setup for both host-less and explicit-interface listeners.
 * SO_REUSEADDR remains first, reuse-port is requested next, and both are
 * complete before bind/listen. The returned errno is the native failure. */
static int scr_net_bind_listen(int fd, const struct sockaddr *sa, socklen_t salen,
                               bool reuse_port) {
  scr_net_listen_reuseaddr(fd);
  if (reuse_port && scr_net_listen_reuseport(fd) != 0) return -1;
  scr_net_nonblock(fd);
  int rc = bind(fd, sa, salen);
  if (rc == 0) rc = listen(fd, 511); /* Node's default backlog */
  return rc;
}

static const char *scr_net_listen_reason(int err, bool explicit_host) {
  if (err == EADDRINUSE) return "address already in use";
#ifdef EADDRNOTAVAIL
  if (explicit_host && err == EADDRNOTAVAIL) return "address not available";
#endif
  if (err == ENOTSUP) return "operation not supported";
#if defined(EOPNOTSUPP) && (!defined(ENOTSUP) || EOPNOTSUPP != ENOTSUP)
  if (err == EOPNOTSUPP) return "operation not supported";
#endif
  return "permission denied";
}

/* write(2) to a socket with SIGPIPE suppressed. macOS sets SO_NOSIGPIPE
 * per fd above (send() path unchanged: write, exactly the historical
 * call); Linux has no SO_NOSIGPIPE — MSG_NOSIGNAL on each send is the
 * per-socket equivalent, turning a closed-peer write into EPIPE for the
 * deferred 'error' sweep instead of process death. */
static ssize_t scr_net_send(int fd, const void *buf, size_t len) {
#if defined(_WIN32)
  /* No SIGPIPE exists on Windows: a closed-peer send fails outright
   * (WSAECONNRESET/WSAESHUTDOWN, mapped) for the deferred 'error' sweep. */
  int n = send((SOCKET)fd, (const char *)buf, len > 0x40000000 ? 0x40000000 : (int)len, 0);
  if (n < 0) scr_w32_seterr();
  return n;
#elif defined(MSG_NOSIGNAL)
  return send(fd, buf, len, MSG_NOSIGNAL);
#else
  return write(fd, buf, len);
#endif
}

/* The idle timer rides the same poller: one-shot, keyed by the socket
 * pointer (kqueue: EVFILT_TIMER ident; epoll: a per-key timerfd), in
 * milliseconds. Re-arming an armed key replaces the deadline. */
static void scr_net_sock_timer_arm(ScrNetSocket *s) {
  if (scr_net_poller == NULL || s->fd < 0 || s->timeout_ms <= 0) return;
  (void)scrp_timer_arm(scr_net_poller, s, s->timeout_ms, s);
  s->timeout_armed = true;
}

static void scr_net_sock_timer_cancel(ScrNetSocket *s) {
  if (!s->timeout_armed) return;
  s->timeout_armed = false;
  if (scr_net_poller == NULL) return;
  scrp_timer_cancel(scr_net_poller, s); /* may already have fired */
}

/* Activity: every read/write/connect resets the idle clock (re-arming an
 * existing timer replaces its deadline). */
static void scr_net_sock_touch(ScrNetSocket *s) {
  if (s->timeout_ms > 0 && s->fd >= 0) scr_net_sock_timer_arm(s);
}

/* Drop a watched fd's registrations and close it — forget MUST precede
 * close(2) under epoll (see scr_platform.h; the kqueue forget is a
 * no-op). Every close of a possibly-watched fd in this unit goes through
 * here. */
static void scr_net_close_fd_raw(int fd) {
  if (fd < 0) return;
  if (scr_net_poller != NULL) scrp_forget(scr_net_poller, fd);
  close(fd);
}

/* NULL-poller-safe watch wrappers (the historical scr_net_filter guards);
 * registration failures are ignored exactly as kevent's always were. */
static void scr_net_watch_read(int fd, void *udata, bool on) {
  if (scr_net_poller == NULL) return;
  (void)scrp_watch_read(scr_net_poller, fd, udata, on);
}

static void scr_net_watch_write(int fd, void *udata, bool on) {
  if (scr_net_poller == NULL) return;
  (void)scrp_watch_write(scr_net_poller, fd, udata, on);
}

/* ── registries ──────────────────────────────────────────────────────── */

static void scr_net_server_register(ScrNetServer *s) {
  if (s->in_registry) return;
  s->in_registry = true;
  s->next = NULL;
  ScrNetServer **link = &scr_net_servers;
  while (*link) link = &(*link)->next;
  *link = scr_net_server_retain(s);
}

static void scr_net_server_unregister(ScrNetServer *s) {
  if (!s->in_registry) return;
  ScrNetServer **link = &scr_net_servers;
  while (*link && *link != s) link = &(*link)->next;
  if (*link) {
    *link = s->next;
    s->next = NULL;
    s->in_registry = false;
    scr_net_server_release(s);
  }
}

static void scr_net_sock_register(ScrNetSocket *s) {
  if (s->in_registry) return;
  s->in_registry = true;
  s->next = NULL;
  ScrNetSocket **link = &scr_net_socks;
  while (*link) link = &(*link)->next;
  *link = scr_net_sock_retain(s);
}

static void scr_net_sock_unregister(ScrNetSocket *s) {
  if (!s->in_registry) return;
  ScrNetSocket **link = &scr_net_socks;
  while (*link && *link != s) link = &(*link)->next;
  if (*link) {
    *link = s->next;
    s->next = NULL;
    s->in_registry = false;
    scr_net_sock_release(s);
  }
}

/* ── socket state machine ────────────────────────────────────────────── */

static ScrNetSocket *scr_net_sock_new(void) {
  ScrNetSocket *s = calloc(1, sizeof *s);
  if (!s) scr_net_oom();
  s->kind = SCR_NET_K_SOCKET;
  s->rc = 1;
  s->fd = -1;
  s->als = scr_als_capture();
#ifdef SCR_RC_AUDIT
  scr_net_live++;
#endif
  return s;
}

/* Consumer-driven read arming (the stdin discipline: never read a byte
 * nobody consumes — the socket buffer is the backpressure). */
/* Node's readableHighWaterMark for sockets: with no consumer the stream
 * still reads ahead this far, so a peer's close is seen. */
#define SCR_NET_READ_AHEAD 65536u

static void scr_net_sock_update_read(ScrNetSocket *s) {
  bool want = s->fd >= 0 && !s->connecting && !s->rd_eof && !s->user_paused && !s->hold &&
              (s->data_ls.n > 0 || s->pipe_dst != NULL || s->native_data != NULL ||
               (s->tunnel != NULL && !s->tunnel->send_only) /* the proxy's CONNECT answer */ ||
               s->flowing /* resume(): flow (and discard sans listeners) */ ||
               s->readable_ls.n > 0 /* paused-mode consumer: bytes buffer */ ||
               s->tops != NULL /* a transport is ALWAYS a consumer: the TLS
                                * layer must process protocol frames (the
                                * handshake, close_notify, 1.3 tickets)
                                * even when no app consumer exists, and a
                                * peer's FIN must reach the teardown —
                                * decrypted app data buffers like the
                                * paused-mode path's */ ||
               s->wr_done /* FIN sent: drain to EOF so the peer's close is
                           * seen even with no consumer — Node resumes a
                           * finished socket the same way */ ||
               (!s->eof_pending && s->rlen - s->rhead < SCR_NET_READ_AHEAD)
               /* no consumer yet: read ahead into the buffer, as Node's
                * stream does up to its high-water mark */) &&
              !(s->tunnel != NULL && s->tunnel->send_only);
  if (want && !s->read_armed) {
    scr_net_watch_read(s->fd, s, true);
    s->read_armed = true;
  } else if (!want && s->read_armed) {
    scr_net_watch_read(s->fd, s, false);
    s->read_armed = false;
  }
}

static void scr_net_sock_update_write(ScrNetSocket *s) {
  bool want = s->fd >= 0 &&
              (s->connecting || (s->tunnel != NULL ? s->tunnel->out_off < s->tunnel->out_len
                                              : s->wlen > s->whead || s->t_want_write));
  if (want && !s->write_armed) {
    scr_net_watch_write(s->fd, s, true);
    s->write_armed = true;
  } else if (!want && s->write_armed) {
    scr_net_watch_write(s->fd, s, false);
    s->write_armed = false;
  }
}

/* Close the fd (registrations dropped first — the epoll obligation) and
 * flag the 'close' sweep. */
static void scr_net_sock_close_fd(ScrNetSocket *s) {
  scr_net_sock_timer_cancel(s);
  if (s->fd >= 0) {
    scr_net_close_fd_raw(s->fd);
    s->fd = -1;
    s->read_armed = s->write_armed = false;
  }
  if (!s->close_emitted) s->emit_close = true;
}

/* The FIN half: called when the write half is ENDING and the buffer just
 * drained (or was empty). Full close once the read half is done too. */
static void scr_net_sock_maybe_finish_write(ScrNetSocket *s) {
  if (s->fd < 0 || !s->wr_ending || s->wr_done || s->wlen > s->whead || s->tunnel != NULL) return;
  /* a transport says goodbye first (TLS close_notify), best-effort */
  if (s->tops && s->t_est) s->tops->shutdown_write(s->tctx);
  shutdown(s->fd, SHUT_WR);
  s->wr_done = true;
  if (s->finish_ls.n > 0) s->finish_pending = true; /* end(cb): the sweep fires it */
  if (s->destroy_on_finish) {
    /* destroySoon(): the FIN is out — tear down now (Node's 'finish'-then-
     * destroy). The close emits through the ordinary sweep. */
    scr_net_sock_close_fd(s);
    return;
  }
  if (s->rd_eof) scr_net_sock_close_fd(s);
  else scr_net_sock_update_read(s); /* the drain-to-EOF mode arms here */
}

/* Append bytes to the write buffer (post-immediate-write remainder, or
 * everything while connecting/buffered). */
static void scr_net_sock_buffer(ScrNetSocket *s, const char *data, size_t len) {
  if (len == 0) return;
  /* compact the consumed head first */
  if (s->whead > 0) {
    memmove(s->wbuf, s->wbuf + s->whead, s->wlen - s->whead);
    s->wlen -= s->whead;
    s->whead = 0;
  }
  if (s->wlen + len > s->wcap) {
    size_t cap = s->wcap ? s->wcap : 4096;
    while (cap < s->wlen + len) cap *= 2;
    s->wbuf = realloc(s->wbuf, cap);
    if (!s->wbuf) scr_net_oom();
    s->wcap = cap;
  }
  memcpy(s->wbuf + s->wlen, data, len);
  s->wlen += len;
}

/* The write path shared by write()/end(data)/pipe delivery. Ignored on a
 * dead or ended write half (Node fires 'error' there; this slice drops —
 * SEMANTICS.md documents the bound). */
static void scr_net_sock_write_raw(ScrNetSocket *s, const char *data, size_t len) {
  if (s->adopted_by != NULL) {
    /* Node writes these bytes to the wire as they are, between the TLS
     * records of the socket that took over (the peer then fails the
     * session). Bytes the kernel cannot take now end that socket. */
    ScrNetSocket *t = s->adopted_by;
    while (len > 0 && t->fd >= 0) {
      ssize_t sent = scr_net_send(t->fd, data, len);
      if (sent < 0 && errno == EINTR) continue;
      if (sent <= 0) {
        scr_net_sock_destroy(t);
        break;
      }
      data += sent;
      len -= (size_t)sent;
    }
    return;
  }
  /* A socket whose dial hasn't STARTED yet (the agent's deferred dial,
   * the caller-lookup wait) has no fd but is logically connecting —
   * bytes buffer and flush at establishment like any mid-connect write. */
  bool pre_dial = s->fd < 0 && (s->dial_deferred || s->lookup_wait) &&
                  !s->wr_ending && !s->close_emitted;
  if (!pre_dial && (s->fd < 0 || s->wr_ending || s->close_emitted)) return;
  if (len == 0) return;
  s->bytes_written += len; /* accepted bytes (Node counts buffered ones too) */
  if (pre_dial || s->connecting || s->tunnel != NULL || s->wlen > s->whead ||
      (s->tops && !s->t_est)) {
    /* mid-connect and mid-handshake bytes buffer; the flush after
     * 'connect'/establishment sends them */
    scr_net_sock_buffer(s, data, len);
    scr_net_sock_update_write(s);
    return;
  }
  ssize_t sent = s->tops ? s->tops->xwrite(s->tctx, data, len) : scr_net_send(s->fd, data, len);
  if (sent > 0) scr_net_sock_touch(s);
  if (sent < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) sent = 0;
    else {
      /* Delivery failure (EPIPE/ECONNRESET): defer to the error sweep. */
      char msg[96];
      snprintf(msg, sizeof msg, "write %s", scr_net_errname(errno));
      if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
      s->had_error = true;
      scr_net_sock_close_fd(s);
      return;
    }
  }
  if ((size_t)sent < len) {
    scr_net_sock_buffer(s, data + sent, len - (size_t)sent);
    scr_net_sock_update_write(s);
  }
}

/* Ordered slices as ONE write (an HTTP head with its body, a chunk with
 * its framing): when the bytes would go out immediately on a plain socket
 * — the state where scr_net_sock_write_raw attempts its syscall — one
 * vectored send carries them all and any unsent tail buffers exactly as
 * write_raw's would. Every other state (connecting, already buffered, a
 * transport, ending/closed) takes write_raw per slice, which buffers or
 * drops identically to consecutive writes. The peer sees the same bytes
 * in the same order; only the segmenting differs (Node writes these
 * pieces with one writev as well). */
void scr_net_sock_writev_native(ScrNetSocket *s, const ScrNetSlice *slices, size_t n) {
#if defined(_WIN32)
  for (size_t i = 0; i < n; i++) scr_net_sock_write_raw(s, slices[i].data, slices[i].len);
#else
  struct iovec iov[8];
  int cnt = 0;
  size_t total = 0;
  bool immediate = n <= 8 && s->fd >= 0 && !s->wr_ending && !s->close_emitted &&
                   !s->connecting && s->tunnel == NULL && s->wlen == s->whead && !s->tops;
  if (immediate) {
    for (size_t i = 0; i < n; i++) {
      if (slices[i].len == 0) continue;
      iov[cnt].iov_base = (void *)slices[i].data;
      iov[cnt++].iov_len = slices[i].len;
      total += slices[i].len;
    }
  }
  if (!immediate || cnt < 2) {
    for (size_t i = 0; i < n; i++) scr_net_sock_write_raw(s, slices[i].data, slices[i].len);
    return;
  }
  s->bytes_written += total; /* accepted bytes, as write_raw counts them */
  struct msghdr msg;
  memset(&msg, 0, sizeof msg);
  msg.msg_iov = iov;
  msg.msg_iovlen = cnt;
#if defined(MSG_NOSIGNAL)
  ssize_t sent = sendmsg(s->fd, &msg, MSG_NOSIGNAL);
#else
  ssize_t sent = sendmsg(s->fd, &msg, 0);
#endif
  if (sent > 0) scr_net_sock_touch(s);
  if (sent < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) sent = 0;
    else {
      char msg_text[96];
      snprintf(msg_text, sizeof msg_text, "write %s", scr_net_errname(errno));
      if (!s->pending_err) s->pending_err = scr_str_new(msg_text, strlen(msg_text));
      s->had_error = true;
      scr_net_sock_close_fd(s);
      return;
    }
  }
  if ((size_t)sent < total) {
    size_t skip = (size_t)sent;
    for (int i = 0; i < cnt; i++) {
      size_t len = iov[i].iov_len;
      if (skip >= len) {
        skip -= len;
        continue;
      }
      scr_net_sock_buffer(s, (const char *)iov[i].iov_base + skip, len - skip);
      skip = 0;
    }
    scr_net_sock_update_write(s);
  }
#endif
}

/* Flush on write-readiness; drives the FIN when ENDING. */
static void scr_net_sock_flush(ScrNetSocket *s) {
  if (s->tunnel != NULL) return; /* nothing moves until the proxy answers */
  if (s->tops && !s->t_est) return; /* nothing moves until the handshake ends */
  while (s->fd >= 0 && s->wlen > s->whead) {
    ssize_t sent = s->tops ? s->tops->xwrite(s->tctx, s->wbuf + s->whead, s->wlen - s->whead)
                           : scr_net_send(s->fd, s->wbuf + s->whead, s->wlen - s->whead);
    if (sent < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      char msg[96];
      snprintf(msg, sizeof msg, "write %s", scr_net_errname(errno));
      if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
      s->had_error = true;
      scr_net_sock_close_fd(s);
      return;
    }
    if (sent > 0) scr_net_sock_touch(s);
    s->whead += (size_t)sent;
  }
  if (s->wlen == s->whead) {
    s->whead = s->wlen = 0;
    scr_net_sock_update_write(s);
    scr_net_sock_maybe_finish_write(s);
  }
}

/* EOF: 'end' fires now (directly — Node's poll-phase emit), then the
 * write half ends (allowHalfOpen false), and the fd closes once the FIN
 * is out. 'close' waits for the sweep. */
static void scr_net_sock_eof(ScrNetSocket *s) {
  s->rd_eof = true;
  scr_net_sock_update_read(s);
  if (s->native_eof) {
    s->native_eof(s->native_ctx);
    if (scr_exc_pending()) return;
  }
  if (s->pipe_dst) {
    /* pipe's end-the-destination default */
    ScrNetSocket *dst = s->pipe_dst;
    if (!dst->wr_ending && dst->fd >= 0) {
      dst->wr_ending = true;
      scr_net_sock_maybe_finish_write(dst);
    }
  }
  scr_net_fire0_this(&s->end_ls, s, SCR_DYNH_NET_SOCKET);
  if (scr_exc_pending()) return;
  if (!s->wr_ending) {
    s->wr_ending = true;
    scr_net_sock_maybe_finish_write(s);
  }
  if (s->wr_done) scr_net_sock_close_fd(s);
}

/* Deliver one arrived chunk to the socket's consumers (the protocol
 * layer, the pipe destination, the 'data' listeners). Returns false when
 * a callback threw (the caller bails; the loop surfaces it). */
static bool scr_net_sock_deliver(ScrNetSocket *s, const char *buf, size_t n) {
  if (s->native_data) {
    s->native_data(s->native_ctx, buf, n);
    if (scr_exc_pending()) return false;
    /* the protocol layer OWNS this chunk exclusively — an upgrade
     * handover inside the call (native reader cleared, 'data' listeners
     * registered) must not re-deliver bytes the parser consumed; the
     * next chunk takes the listener path */
    return true;
  }
  if (s->pipe_dst) scr_net_sock_write_raw(s->pipe_dst, buf, n);
  if (s->data_ls.n > 0) {
    ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
    chunk->is_buffer = true; /* Node delivers a Buffer */
    memcpy(chunk->data, buf, n);
    ScrNetL *snap;
    size_t nl = scr_net_ls_snapshot(&s->data_ls, &snap);
    scr_dyn_this_push(s, SCR_DYNH_NET_SOCKET);
    scr_dyn_chunk_enc(s->enc_utf8);
    for (size_t i = 0; i < nl; i++) {
      if (!scr_exc_pending()) ((ScrNetDataFn)snap[i].fn)(snap[i].cb, chunk);
      scr_closure_release(snap[i].cb);
    }
    scr_dyn_chunk_enc(false);
    scr_dyn_this_pop();
    free(snap);
    scr_bytes_release(chunk);
    if (scr_exc_pending()) return false;
  }
  return true;
}

/* One readable wake: read until EAGAIN/EOF OR a bounded batch, one 'data'
 * emit per read(2) chunk (Node's chunking is arrival-driven too — only the
 * reassembled bytes are contractual, the stdin stance). The batch bound is
 * the loop's fairness fence: a continuously writing peer can otherwise keep
 * every nonblocking read successful forever and strand timers plus every
 * other fd inside this function. All poller arms are level-triggered, so
 * unread kernel bytes make the socket ready again on the next loop turn.
 * Peeked/unshifted bytes in the receive buffer deliver first — they precede
 * the kernel's in the stream. A TLS socket drains those through the engine's
 * bio instead. */
static void scr_net_sock_append_rbuf(ScrNetSocket *s, const char *data, size_t len);
static void scr_net_sock_transport_pump(ScrNetSocket *s);

static void scr_net_sock_read(ScrNetSocket *s) {
  size_t reads_left = 32; /* at most 2 MiB with the 64 KiB read buffer */
  if (s->tunnel != NULL) return; /* readiness feeds the tunnel pump instead */
  if (s->tops && !s->t_est) return; /* readiness feeds the handshake pump instead */
  for (;;) {
    if (s->fd < 0 || s->user_paused || s->hold) return;
    bool flowing = s->data_ls.n > 0 || s->pipe_dst || s->native_data || s->flowing;
    /* buffered (peeked/unshifted) bytes first — they precede the
     * kernel's in the stream; a TLS engine drains them through its bio */
    if (!s->tops && flowing && s->rlen > s->rhead) {
      char buf[65536];
      size_t take = scr_net_sock_take_buffered(s, buf, sizeof buf);
      if (!scr_net_sock_deliver(s, buf, take)) return;
      scr_net_sock_update_read(s);
      continue;
    }
    if (s->rd_eof) return;
    /* No consumer: read ahead into the buffer up to the high-water mark,
     * as Node's stream does, so a peer's close is seen. An ESTABLISHED
     * transport keeps processing protocol frames (close alerts, 1.3
     * tickets) and drops app data, as a finished socket does. */
    bool read_ahead = !flowing && s->readable_ls.n == 0 && !s->wr_done &&
                      !(s->tops != NULL && s->t_est);
    if (read_ahead && (s->tops != NULL || s->eof_pending ||
                       s->rlen - s->rhead >= SCR_NET_READ_AHEAD)) {
      scr_net_sock_update_read(s);
      return;
    }
    char buf[65536];
    ssize_t n = s->tops ? s->tops->xread(s->tctx, buf, sizeof buf) : read(s->fd, buf, sizeof buf);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      char msg[96];
      snprintf(msg, sizeof msg, "read %s", scr_net_errname(errno));
      if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
      s->had_error = true;
      scr_net_sock_close_fd(s);
      return;
    }
    if (n == 0) {
      if (read_ahead && s->rlen > s->rhead) {
        /* bytes nobody has read yet: 'end' waits for a consumer to
         * drain them (the next read after the drain sees EOF again) */
        s->eof_pending = true;
        scr_net_sock_update_read(s);
        return;
      }
      /* EOF announces 'readable' first (Node: a read() there answers
       * null — the demux's dead-peer arm), then 'end' and the teardown */
      scr_net_fire0_this(&s->readable_ls, s, SCR_DYNH_NET_SOCKET);
      if (scr_exc_pending()) return;
      scr_net_sock_eof(s);
      return;
    }
    scr_net_sock_touch(s);
    s->bytes_read += (size_t)n;
    if (flowing) {
      if (!scr_net_sock_deliver(s, buf, (size_t)n)) return;
    } else if (read_ahead) {
      scr_net_sock_append_rbuf(s, buf, (size_t)n);
    } else if (s->readable_ls.n == 0) {
      /* the drain-to-EOF modes (wr_done, or an established transport
       * with no consumer): bytes arriving with nobody listening drop —
       * Node's resumed-but-unconsumed stream for the FIN-sent arm; for
       * the transport arm the peer would have to send app data at a
       * handler-less server for the difference to observe */
    } else {
      /* paused mode ('readable' consumers only): buffer and announce —
       * the listener consumes via read()/unshift */
      scr_net_sock_append_rbuf(s, buf, (size_t)n);
      scr_net_fire0_this(&s->readable_ls, s, SCR_DYNH_NET_SOCKET);
      if (scr_exc_pending()) return;
      if (s->tops && !s->t_est) {
        /* the listener routed this socket into a TLS server: the peeked
         * bytes now belong to the engine, and the poller may never signal
         * again if the whole flight is already buffered — pump NOW */
        scr_net_sock_transport_pump(s);
        return;
      }
    }
    scr_net_sock_update_read(s); /* a once-listener may have been the last consumer */
    if (--reads_left == 0) return;
    /* A short read drained the kernel buffer: return to the poller instead
     * of paying a read() that answers EAGAIN (libuv's UV_HANDLE_READ_PARTIAL
     * rule — the level-triggered poller reports any later bytes or EOF).
     * Transports keep draining: their engine may hold decrypted bytes the
     * fd no longer signals. */
    if (!s->tops && (size_t)n < sizeof buf) return;
  }
}

static void scr_net_sock_transport_pump(ScrNetSocket *s);

static void scr_net_sock_dial_next(ScrNetSocket *s);
static void scr_net_sock_connected(ScrNetSocket *s);
static void scr_net_sock_tunnel_pump(ScrNetSocket *s);

/* Connect completion (write-readiness while connecting). */
static void scr_net_sock_connect_done(ScrNetSocket *s) {
  int err = 0;
  socklen_t len = sizeof err;
  if (getsockopt(s->fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0) err = errno;
  s->connecting = false;
  if (err != 0 && s->dial_i < s->dial_n) {
    /* a caller-lookup dial with addresses left: record the failure
     * (last-wins, surfaced only on exhaustion) and retry QUIETLY — no
     * 'error'/'close' until the list runs out */
    char msg[128];
    snprintf(msg, sizeof msg, "connect %s %s:%d", scr_net_errname(err), s->peer_ip,
             s->peer_port);
    scr_str_release(s->dial_err);
    s->dial_err = scr_str_new(msg, strlen(msg));
    scr_net_close_fd_raw(s->fd); /* registrations dropped, then the fd */
    s->fd = -1;
    s->read_armed = s->write_armed = false;
    scr_net_sock_dial_next(s);
    return;
  }
  if (err != 0) {
    char msg[128];
    snprintf(msg, sizeof msg, "connect %s %s:%d", scr_net_errname(err), s->peer_ip,
             s->peer_port);
    if (s->dial_n > 0) {
      /* the dial chain's LAST address failed asynchronously */
      scr_str_release(s->dial_err);
      s->dial_err = NULL;
      if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
    } else if (!s->pending_err) {
      s->pending_err = scr_str_new(msg, strlen(msg));
    }
    s->had_error = true;
    scr_net_sock_close_fd(s);
    return;
  }
  if (s->dial_err) {
    /* an earlier address failed but THIS one connected: the recorded
     * failure never surfaces */
    scr_str_release(s->dial_err);
    s->dial_err = NULL;
  }
  if (s->tunnel != NULL) {
    /* TCP to the proxy is up: the CONNECT exchange runs first */
    scr_net_sock_touch(s);
    scr_net_sock_tunnel_pump(s);
    return;
  }
  scr_net_sock_connected(s);
}

/* The connection is usable (TCP up, and the proxy tunnel when there is
 * one): the transport handshake starts, or 'connect' fires and buffered
 * writes flush. */
static void scr_net_sock_connected(ScrNetSocket *s) {
  if (s->lookup_evs != NULL) {
    scr_net_lookup_ops->flush(s);
    if (scr_exc_pending()) return;
  }
  scr_net_sock_update_write(s); /* keeps the filter iff bytes are buffered */
  scr_net_sock_update_read(s);
  scr_net_sock_touch(s);
  if (s->tops && !s->t_est) {
    /* TCP is up; the TLS handshake starts now. 'connect' listeners wait
     * for establishment (they registered as secureConnect) and buffered
     * bytes flush there too. */
    scr_net_sock_transport_pump(s);
    return;
  }
  if (s->native_established) {
    s->native_established(s->native_ctx);
    if (scr_exc_pending()) return;
  }
  scr_net_fire0_this(&s->conn_ls, s, SCR_DYNH_NET_SOCKET);
  if (scr_exc_pending()) return;
  scr_net_fire0_this(&s->ready_ls, s, SCR_DYNH_NET_SOCKET);
  if (scr_exc_pending()) return;
  scr_net_sock_flush(s);
}

/* Fails a tunnel being set up: the message is the socket's 'error'. */
static void scr_net_sock_tunnel_fail(ScrNetSocket *s, const char *msg) {
  if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
  s->had_error = true;
  scr_net_sock_close_fd(s);
}

int scr_net_tunnel_status(const char *head, size_t len) {
  if (len >= 12 && memcmp(head, "HTTP/1.", 7) == 0 && head[8] == ' ' &&
      isdigit((unsigned char)head[9]) && isdigit((unsigned char)head[10]) &&
      isdigit((unsigned char)head[11])) {
    return (head[9] - '0') * 100 + (head[10] - '0') * 10 + (head[11] - '0');
  }
  return -1;
}

void scr_net_tunnel_failure(int status, char *msg, size_t cap) {
  if (status < 0) {
    /* llhttp's message for a response that does not start with a status line */
    snprintf(msg, cap, "Response does not match the HTTP/1.1 protocol (Expected HTTP/, RTSP/ or ICE/)");
  } else {
    snprintf(msg, cap, "Proxy response (%d) !== 200 when HTTP Tunneling", status);
  }
}

/* The proxy's response head is at most this long. */
#define SCR_NET_TUNNEL_HEAD_MAX 16384u

/* Drives the CONNECT exchange off readiness: sends the request head,
 * then reads the proxy's response head. A 200 status makes the
 * connection usable (bytes after the head belong to the tunnel); any
 * other status fails the socket with undici's message. */
static void scr_net_sock_tunnel_pump(ScrNetSocket *s) {
  ScrNetTunnel *t = s->tunnel;
  while (s->fd >= 0 && t->out_off < t->out_len) {
    ssize_t sent =
        scr_net_send(s->fd, t->out + t->out_off, t->out_len - t->out_off);
    if (sent < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      char msg[96];
      snprintf(msg, sizeof msg, "write %s", scr_net_errname(errno));
      scr_net_sock_tunnel_fail(s, msg);
      return;
    }
    t->out_off += (size_t)sent;
  }
  scr_net_sock_update_write(s);
  if (s->fd < 0 || t->out_off < t->out_len) return;
  if (t->send_only) {
    scr_net_tunnel_free(t);
    s->tunnel = NULL;
    scr_net_sock_connected(s);
    return;
  }
  for (;;) {
    char buf[4096];
    ssize_t n = read(s->fd, buf, sizeof buf);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        scr_net_sock_update_read(s);
        return;
      }
      char msg[96];
      snprintf(msg, sizeof msg, "read %s", scr_net_errname(errno));
      scr_net_sock_tunnel_fail(s, msg);
      return;
    }
    if (n == 0) {
      scr_net_sock_tunnel_fail(s, "socket hang up");
      return;
    }
    if (t->in_len + (size_t)n > SCR_NET_TUNNEL_HEAD_MAX) {
      scr_net_sock_tunnel_fail(s, "Proxy response head is too large");
      return;
    }
    char *grown = realloc(t->in, t->in_len + (size_t)n);
    if (!grown) scr_net_oom();
    t->in = grown;
    memcpy(t->in + t->in_len, buf, (size_t)n);
    t->in_len += (size_t)n;
    size_t end = 0;
    for (size_t i = 3; i < t->in_len; i++) {
      if (memcmp(t->in + i - 3, "\r\n\r\n", 4) == 0) {
        end = i + 1;
        break;
      }
    }
    if (end == 0) continue;
    int status = scr_net_tunnel_status(t->in, end);
    if (status != 200) {
      char msg[128];
      scr_net_tunnel_failure(status, msg, sizeof msg);
      scr_net_sock_tunnel_fail(s, msg);
      return;
    }
    scr_net_sock_append_rbuf(s, t->in + end, t->in_len - end);
    scr_net_tunnel_free(t);
    s->tunnel = NULL;
    scr_net_sock_touch(s);
    scr_net_sock_connected(s);
    return;
  }
}

/* Drive the transport handshake off readiness until it settles. On
 * establishment: the protocol layer attaches (https' parser), a
 * deferred server 'connection' fires ('secureConnection' timing), the
 * socket's own 'connect' listeners fire (the client's secureConnect),
 * buffered writes flush, and any plaintext that rode in with the final
 * handshake flight delivers. Failure already tore the socket down via
 * scr_net_sock_transport_error. */
static void scr_net_sock_transport_pump(ScrNetSocket *s) {
  if (!s->tops || s->t_est || s->fd < 0 || s->connecting || s->tunnel != NULL) return;
  int r = s->tops->handshake(s->tctx);
  if (r == 0) {
    scr_net_sock_update_read(s);
    scr_net_sock_update_write(s);
    return;
  }
  if (r < 0) return; /* the transport reported the failure */
  s->t_est = true;
  scr_net_sock_touch(s);
  if (s->tops->on_established) {
    s->tops->on_established(s->tctx);
    if (scr_exc_pending()) return;
  }
  if (s->conn_pending) {
    /* the deferred 'connection' ('secureConnection' timing): the target
     * is the server this socket was routed INTO — the accepting server
     * for a plain TLS accept, the emit('connection') target after a
     * demux */
    ScrNetServer *target = s->conn_pending;
    s->conn_pending = NULL;
    if (!target->close_emitted) {
      ScrNetL *snap;
      size_t n = scr_net_ls_snapshot(&target->conn_ls, &snap);
      scr_dyn_this_push(target, SCR_DYNH_NET_SERVER);
      for (size_t i = 0; i < n; i++) {
        if (!scr_exc_pending()) ((ScrNetConnFn)snap[i].fn)(snap[i].cb, scr_net_sock_retain(s));
        scr_closure_release(snap[i].cb);
      }
      scr_dyn_this_pop();
      free(snap);
    }
    scr_net_server_release(target);
    if (scr_exc_pending()) return;
  }
  if (s->native_established) {
    s->native_established(s->native_ctx);
    if (scr_exc_pending()) return;
  }
  scr_net_fire0_this(&s->conn_ls, s, SCR_DYNH_NET_SOCKET);
  if (scr_exc_pending()) return;
  scr_net_fire0_this(&s->ready_ls, s, SCR_DYNH_NET_SOCKET);
  if (scr_exc_pending()) return;
  if (s->tops->after_established) {
    s->tops->after_established(s->tctx);
    if (scr_exc_pending()) return;
  }
  scr_net_sock_flush(s);
  scr_net_sock_update_read(s);
  scr_net_sock_update_write(s);
  scr_net_sock_read(s); /* plaintext buffered inside the engine, if any */
}

/* ── the server ──────────────────────────────────────────────────────── */

static ScrNetServer *scr_net_server_new(void) {
  ScrNetServer *s = calloc(1, sizeof *s);
  if (!s) scr_net_oom();
  s->kind = SCR_NET_K_SERVER;
  s->rc = 1;
  s->fd = -1;
  s->http_timeouts[0] = 0;      /* timeout */
  s->http_timeouts[1] = 5000;   /* keepAliveTimeout */
  s->http_timeouts[2] = 60000;  /* headersTimeout */
  s->http_timeouts[3] = 300000; /* requestTimeout */
  s->http_timeouts[4] = 1000;   /* keepAliveTimeoutBuffer */
#ifdef SCR_RC_AUDIT
  scr_net_live++;
#endif
  return s;
}

ScrNetServer *scr_net_create_server(ScrClosure *handler /*moves, nullable*/, ScrNetConnFn fn) {
  ScrNetServer *s = scr_net_server_new();
  if (handler) scr_net_ls_add(&s->conn_ls, handler, (void *)fn, false);
  return s;
}

/* listen(port): bind + listen NOW (Node fails synchronously into an async
 * 'error'); success defers the listen callback ('listening') to the next
 * dispatch pass, Node's next-tick emit. Binds like Node's host-less
 * listen: IPv6 any with dual-stack when the kernel allows, IPv4 fallback. */
static void scr_net_listen_any(ScrNetServer *s, double port, bool reuse_port,
                               ScrClosure *cb /*moves, nullable*/) {
  scr_net_server_capture_listen(s);
  if (cb) scr_net_ls_add(&s->listening_cbs, cb, NULL, true);
  if (s->listening || s->close_emitted) return;
  if (!scr_net_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  int p = (int)port;
  int fd = socket(AF_INET6, SOCK_STREAM, 0);
  bool v6 = fd >= 0;
  if (v6) {
    int off = 0;
    setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &off, sizeof off);
  } else {
    fd = socket(AF_INET, SOCK_STREAM, 0);
  }
  if (fd < 0) {
    fputs("scriptc: socket() failed\n", stderr);
    abort();
  }
  int rc;
  if (v6) {
    struct sockaddr_in6 addr;
    memset(&addr, 0, sizeof addr);
    addr.sin6_family = AF_INET6;
    addr.sin6_addr = in6addr_any;
    addr.sin6_port = htons((uint16_t)p);
    rc = scr_net_bind_listen(fd, (struct sockaddr *)&addr, sizeof addr, reuse_port);
  } else {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((uint16_t)p);
    rc = scr_net_bind_listen(fd, (struct sockaddr *)&addr, sizeof addr, reuse_port);
  }
  if (rc != 0) {
    int err = errno;
    close(fd);
    char msg[128];
    /* Node: "listen EADDRINUSE: address already in use :::4000" */
    snprintf(msg, sizeof msg, "listen %s: %s %s:%d", scr_net_errname(err),
             scr_net_listen_reason(err, false),
             v6 ? "::" : "0.0.0.0", p);
    if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
    scr_net_server_register(s); /* the sweep delivers the failure */
    return;
  }
  /* the real port (ephemeral listen(0) discovers it here) */
  struct sockaddr_storage bound;
  socklen_t blen = sizeof bound;
  if (getsockname(fd, (struct sockaddr *)&bound, &blen) == 0) {
    s->port = bound.ss_family == AF_INET6
                  ? ntohs(((struct sockaddr_in6 *)&bound)->sin6_port)
                  : ntohs(((struct sockaddr_in *)&bound)->sin_port);
  }
  s->fd = fd;
  s->listening = true;
  s->emit_listening = true;
  s->bound_v6 = v6;
  scr_net_watch_read(fd, s, true);
  scr_net_server_register(s);
}

void scr_net_listen(ScrNetServer *s, double port, ScrClosure *cb /*moves, nullable*/) {
  scr_net_listen_any(s, port, false, cb);
}

/* listen({ port, host, ipv6Only, reusePort }) — the explicit-interface bind
 * (portless's listenOnProxyInterface): host is an IP literal ("" = the
 * host-less dual-stack default above; "localhost" pins to 127.0.0.1, the
 * connect-side divergence); ipv6Only sets IPV6_V6ONLY before the bind
 * (meaningful on v6 addresses — "::" with ipv6Only leaves v4 to its own
 * listener, exactly the portless pair). Failures are the async 'error'
 * with Node's listen message naming the requested host; a non-IP host is
 * the async getaddrinfo ENOTFOUND (no resolver in this slice). */
static void scr_net_listen_opts_impl(ScrNetServer *s, double port, ScrStr *host /*borrowed*/,
                                     bool ipv6_only, bool reuse_port,
                                     ScrClosure *cb /*moves, nullable*/) {
  scr_net_server_capture_listen(s);
  if (host == NULL || host->len == 0) {
    scr_net_listen_any(s, port, reuse_port, cb);
    return;
  }
  if (cb) scr_net_ls_add(&s->listening_cbs, cb, NULL, true);
  if (s->listening || s->close_emitted) return;
  if (!scr_net_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  int p = (int)port;
  char h[64];
  snprintf(h, sizeof h, "%.*s", (int)(host->len < 63 ? host->len : 63), host->data);
  if (strcmp(h, "localhost") == 0) snprintf(h, sizeof h, "127.0.0.1");
  struct sockaddr_in a4;
  struct sockaddr_in6 a6;
  struct sockaddr *sa = NULL;
  socklen_t salen = 0;
  bool v6 = false;
  memset(&a4, 0, sizeof a4);
  memset(&a6, 0, sizeof a6);
  if (inet_pton(AF_INET, h, &a4.sin_addr) == 1) {
    a4.sin_family = AF_INET;
    a4.sin_port = htons((uint16_t)p);
    sa = (struct sockaddr *)&a4;
    salen = sizeof a4;
  } else if (inet_pton(AF_INET6, h, &a6.sin6_addr) == 1) {
    a6.sin6_family = AF_INET6;
    a6.sin6_port = htons((uint16_t)p);
    sa = (struct sockaddr *)&a6;
    salen = sizeof a6;
    v6 = true;
  }
  if (!sa) {
    char msg[160];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", h);
    if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
    scr_net_server_register(s);
    return;
  }
  int fd = socket(sa->sa_family, SOCK_STREAM, 0);
  if (fd < 0) {
    fputs("scriptc: socket() failed\n", stderr);
    abort();
  }
  if (v6) {
    int only = ipv6_only ? 1 : 0;
    setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &only, sizeof only);
  }
  int rc = scr_net_bind_listen(fd, sa, salen, reuse_port);
  if (rc != 0) {
    int err = errno;
    close(fd);
    char msg[160];
    snprintf(msg, sizeof msg, "listen %s: %s %s:%d", scr_net_errname(err),
             scr_net_listen_reason(err, true),
             h, p);
    if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
    scr_net_server_register(s);
    return;
  }
  struct sockaddr_storage bound;
  socklen_t blen = sizeof bound;
  if (getsockname(fd, (struct sockaddr *)&bound, &blen) == 0) {
    s->port = bound.ss_family == AF_INET6
                  ? ntohs(((struct sockaddr_in6 *)&bound)->sin6_port)
                  : ntohs(((struct sockaddr_in *)&bound)->sin_port);
  }
  s->fd = fd;
  s->listening = true;
  s->emit_listening = true;
  s->bound_v6 = v6;
  scr_str_release(s->bound_host);
  s->bound_host = scr_str_new(h, strlen(h));
  scr_net_watch_read(fd, s, true);
  scr_net_server_register(s);
}

void scr_net_listen_opts(ScrNetServer *s, double port, ScrStr *host /*borrowed*/,
                          bool ipv6_only, ScrClosure *cb /*moves, nullable*/) {
  scr_net_listen_opts_impl(s, port, host, ipv6_only, false, cb);
}

void scr_net_listen_opts_reuse_port(ScrNetServer *s, double port, ScrStr *host /*borrowed*/,
                                    bool ipv6_only, bool reuse_port,
                                    ScrClosure *cb /*moves, nullable*/) {
  scr_net_listen_opts_impl(s, port, host, ipv6_only, reuse_port, cb);
}

double scr_net_server_port(ScrNetServer *s) { return (double)s->port; }
bool scr_net_server_listening(ScrNetServer *s) { return s->listening; }

double scr_net_server_timeout_get(ScrNetServer *s, double field) {
  static const char *const names[] = {
    "timeout", "keepAliveTimeout", "headersTimeout", "requestTimeout",
    "keepAliveTimeoutBuffer",
  };
  int i = (int)field;
  if (i < 0 || i >= 5) abort(); /* compiler/runtime ABI violation */
  if (s->http_timeout_dyn[i] != NULL) {
    scr_dyn_arg_type_fail(names[i], "of type number", s->http_timeout_dyn[i]);
    return 0; /* pending exception; typed reads validate an any-written value */
  }
  return s->http_timeouts[i];
}

void scr_net_server_timeout_set(ScrNetServer *s, double field, double value) {
  int i = (int)field;
  if (i < 0 || i >= 5) abort(); /* compiler/runtime ABI violation */
  scr_dyn_release(s->http_timeout_dyn[i]);
  s->http_timeout_dyn[i] = NULL;
  s->http_timeouts[i] = value;
}

/* The idle period a keep-alive connection gets after a response:
 * keepAliveTimeout + keepAliveTimeoutBuffer, or 0 (no timer) when
 * keepAliveTimeout is 0 or holds a non-number. */
double scr_net_server_keep_alive_ms(ScrNetServer *s) {
  if (s->http_timeout_dyn[1] != NULL || s->http_timeouts[1] <= 0) return 0;
  double buffer = s->http_timeout_dyn[4] == NULL ? s->http_timeouts[4] : 0;
  return s->http_timeouts[1] + buffer;
}

/* server.keepAliveTimeout in milliseconds (0 when unset or not a number). */
double scr_net_server_keep_alive_timeout(ScrNetServer *s) {
  return s->http_timeout_dyn[1] == NULL && s->http_timeouts[1] > 0 ? s->http_timeouts[1] : 0;
}

/* server.timeout as a socket idle period (0 = none). */
double scr_net_server_idle_ms(ScrNetServer *s) {
  return s->http_timeout_dyn[0] == NULL && s->http_timeouts[0] > 0 ? s->http_timeouts[0] : 0;
}

void scr_net_server_set_timeout_plain(ScrNetServer *s, double ms) {
  scr_net_server_timeout_set(s, 0, ms);
}

void scr_net_server_set_timeout_cb(ScrNetServer *s, double ms, ScrClosure *cb /*moves*/,
                                    ScrNetConnFn fn) {
  scr_net_server_timeout_set(s, 0, ms);
  scr_net_server_on_timeout(s, cb, fn, false);
}

void scr_net_server_enable_http_timeout_surface(ScrNetServer *s) {
  s->http_timeout_surface = true;
}

/* Constructor-option validation is intentionally separate from the plain
 * writable-property setter above. Node validates these option values as
 * non-negative safe integers, while later property assignments store the
 * number directly. */
bool scr_net_server_timeout_option_check(double field, double value) {
  static const char *const names[] = {
    "timeout", "keepAliveTimeout", "headersTimeout", "requestTimeout",
    "keepAliveTimeoutBuffer",
  };
  int i = (int)field;
  if (i < 0 || i >= 5) abort(); /* compiler/runtime ABI violation */
  char recv[48], msg[224];
  if (!(isfinite(value) && trunc(value) == value)) {
    scr_num_received(value, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be an integer. Received %s",
                       names[i], recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (value < 0 || value > 9007199254740991.0) {
    scr_num_received(value, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s",
                       names[i], recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

void scr_net_server_timeout_option_set(ScrNetServer *s, double field, const ScrDyn *value) {
  int i = (int)field;
  if (i < 0 || i >= 5) abort(); /* compiler/runtime ABI violation */
  if (value->kind == SCR_DYN_UNDEF) return; /* optional field is absent */
  if (value->kind != SCR_DYN_NUM) {
    static const char *const names[] = {
      "timeout", "keepAliveTimeout", "headersTimeout", "requestTimeout",
      "keepAliveTimeoutBuffer",
    };
    scr_dyn_arg_type_fail(names[i], "of type number", value);
    return;
  }
  if (!scr_net_server_timeout_option_check(field, value->v.num)) return;
  scr_net_server_timeout_set(s, field, value->v.num);
}

/* address()'s other two fields — the bound host ('::'/'0.0.0.0' for the
 * host-less any, the normalized explicit host otherwise) and the family
 * string. Answer the any-form defaults before listen (Node answers null
 * there — the serverPort stance, port 0). */
ScrStr *scr_net_server_addr_ip(ScrNetServer *s) {
  if (s->bound_host) return scr_str_retain(s->bound_host);
  return s->bound_v6 ? scr_str_new("::", 2) : scr_str_new("0.0.0.0", 7);
}

ScrStr *scr_net_server_addr_family(ScrNetServer *s) {
  return s->bound_v6 ? scr_str_new("IPv6", 4) : scr_str_new("IPv4", 4);
}

/* The REAL close — what the bound `origClose` value reaches (never
 * consults the override, so the portless proxy-through idiom cannot
 * recurse). */
void scr_net_server_close_direct(ScrNetServer *s, ScrClosure *cb /*moves, nullable*/) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_als_ctx_release(s->close_ctx);
  s->close_ctx = scr_als_capture();
  if (cb) scr_net_ls_add(&s->close_ls, cb, NULL, true);
  if (s->listening) {
    scr_net_close_fd_raw(s->fd); /* stops accepting NOW (registrations dropped first) */
    s->fd = -1;
    s->listening = false;
#ifndef _WIN32
    /* a Unix-socket server removes its socket file as it closes, like
     * libuv's pipe close */
    if (s->unix_path != NULL) unlink(s->unix_path->data);
#endif
  }
  /* A close BEFORE the deferred 'listening' delivered cancels it — Node's
   * emitListeningNT checks the handle close() nulled, so the listen
   * callback never runs (test-net-listen-close-server's mustNotCall). */
  if (s->emit_listening) {
    s->emit_listening = false;
    scr_net_ls_drop(&s->listening_cbs);
  }
  if (!s->closing) {
    static SCR_TL size_t scr_net_close_seq = 0;
    s->close_seq = ++scr_net_close_seq;
  }
  s->closing = true; /* the sweep fires 'close' once nconns drains */
  /* a server that never listened is not registered yet: Node still emits
   * its 'close' (and runs close callbacks) */
  scr_net_server_register(s);
  /* Node's http server.close() first closes its idle keep-alive
   * connections; busy ones end after their response (scr_http.c). Only
   * HTTP connections carry an idle probe, so plain net servers keep
   * their connections. */
  scr_net_server_close_idle_connections(s);
}

void scr_net_server_close(ScrNetServer *s, ScrClosure *cb /*moves, nullable*/) {
  if (s->close_override != NULL && !s->close_emitted) {
    /* The override runs INSTEAD of the close; a close callback still
     * fires when the override's origClose completes the close — Node's
     * behavior with the callback passed through. */
    if (cb) scr_net_ls_add(&s->close_ls, cb, NULL, true);
    ScrClosure *ov = scr_closure_retain(s->close_override);
    ((void (*)(ScrClosure *))ov->fn)(ov);
    scr_closure_release(ov);
    return;
  }
  scr_net_server_close_direct(s, cb);
}

static void scr_net_server_close_http_connections(ScrNetServer *s, bool idle_only) {
  ScrNetSocket *sock = scr_net_socks;
  while (sock) {
    ScrNetSocket *next = sock->next;
    if (sock->server == s && sock->native_idle != NULL && sock->fd >= 0 &&
        (!idle_only || sock->native_idle(sock->native_ctx))) {
      scr_net_sock_retain(sock);
      scr_net_sock_destroy(sock);
      scr_net_sock_release(sock);
    }
    sock = next;
  }
}

void scr_net_server_close_all_connections(ScrNetServer *s) {
  scr_net_server_close_http_connections(s, false);
}

void scr_net_server_close_idle_connections(ScrNetServer *s) {
  scr_net_server_close_http_connections(s, true);
}

/* server.maxConnections: undefined until set; a set number turns away
 * connections once that many are open ('drop'). Setting undefined or
 * null unsets it. +1 for the getter. */
ScrDyn *scr_net_server_max_connections_get(ScrNetServer *s) {
  return s->max_conns_set ? scr_dyn_new_num(s->max_conns) : scr_dyn_retain(scr_dyn_undefined());
}

void scr_net_server_max_connections_set(ScrNetServer *s, const ScrDyn *value /*borrowed*/) {
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    s->max_conns_set = false;
    return;
  }
  double n = NAN;
  scr_dyn_number_coerce_js(value, &n);
  s->max_conns_set = true;
  s->max_conns = n;
}

/* server.dropMaxConnection: the value as assigned (undefined until set).
 * +1 for the getter. */
ScrDyn *scr_net_server_drop_max_connection_get(ScrNetServer *s) {
  return scr_dyn_retain(s->drop_max_connection != NULL ? s->drop_max_connection : scr_dyn_undefined());
}

void scr_net_server_drop_max_connection_set(ScrNetServer *s, const ScrDyn *value /*borrowed*/) {
  scr_dyn_release(s->drop_max_connection);
  s->drop_max_connection = scr_dyn_retain((ScrDyn *)value);
}

void scr_net_server_on_drop(ScrNetServer *s, const ScrDyn *listener /*borrowed*/, bool once) {
  if (s->close_emitted) return;
  scr_net_ls_add(&s->drop_ls, scr_dyn_listener_closure_fn(listener, (void *)&scr_net_dyn_fire_arg),
                 (void *)&scr_net_dyn_fire_arg, once);
}

/* server.getConnections(cb): cb(null, count) on the next tick, with the
 * count at the call, as Node's process.nextTick(end, null, count). */
static void scr_net_get_connections_fire(ScrClosure *self) {
  ScrDyn *fn = (ScrDyn *)scr_box_get_ref(self->caps[0]);
  ScrDyn *args[2] = { scr_dyn_new_null(), scr_dyn_new_num(scr_box_get_f64(self->caps[1])) };
  scr_dyn_release(scr_dyn_call(fn, args, 2, "callback"));
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  scr_dyn_release(fn);
}

void scr_net_server_get_connections(ScrNetServer *s, const ScrDyn *callback /*borrowed*/) {
  ScrClosure *clo = scr_dyn_listener_closure_fn(callback, (void *)&scr_net_get_connections_fire);
  ScrClosure *job = scr_closure_new((void *)&scr_net_get_connections_fire, 2);
  job->caps[0] = scr_box_retain(clo->caps[0]);
  job->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(job->caps[1], (double)s->nconns);
  scr_closure_release(clo);
  scr_next_tick(job);
}

/* wrapper.close = fn: the override MOVES in (a compiler-emitted zero-arg
 * wrapper — see the struct comment); reassignment releases the old one,
 * matching JS's last-write-wins. */
void scr_net_server_set_close_override(ScrNetServer *s, ScrClosure *ov /*moves*/) {
  scr_closure_release(s->close_override);
  s->close_override = ov;
}

void scr_net_server_on_client_error(ScrNetServer *s, ScrClosure *cb /*moves*/, void *fn, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->client_error_ls, cb, fn, once);
}

typedef void (*ScrNetClientErrorFn)(ScrClosure *, ScrError *, ScrNetSocket *);

/* Node emits 'tlsClientError' from the accepted connection's handshake,
 * which has no AsyncLocalStorage store, not from the server's listen()
 * context the connection's other events run in. */
void scr_net_server_fire_client_error(ScrNetServer *s, ScrError *err /*borrowed*/,
                                      ScrNetSocket *sock /*borrowed*/) {
  if (s->client_error_ls.n == 0) return;
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(&s->client_error_ls, &snap);
  ScrAlsCtx *prev = scr_als_dispatch_enter(NULL);
  scr_dyn_this_push(s, SCR_DYNH_NET_SERVER);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((ScrNetClientErrorFn)snap[i].fn)(snap[i].cb, err, sock);
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  scr_als_dispatch_leave(prev);
  free(snap);
}

/* The 'tlsClientError' listener adapters by arity; the arguments arrive
 * borrowed and the listener takes them +1. */
void scr_net_client_error_thunk0(ScrClosure *cb, ScrError *err, ScrNetSocket *sock) {
  (void)err;
  (void)sock;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_net_client_error_thunk1(ScrClosure *cb, ScrError *err, ScrNetSocket *sock) {
  (void)sock;
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, scr_error_retain(err));
}

void scr_net_client_error_thunk2(ScrClosure *cb, ScrError *err, ScrNetSocket *sock) {
  ((void (*)(ScrClosure *, ScrError *, ScrNetSocket *))cb->fn)(cb, scr_error_retain(err),
                                                              scr_net_sock_retain(sock));
}

void scr_net_server_on_error(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn,
                              bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->err_ls, cb, (void *)fn, once);
}

void scr_net_server_on_close(ScrNetServer *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->close_ls, cb, NULL, once);
}

/* server.on('listening', cb): joins the deferred 'listening' list the
 * listen(port, cb) callback rides (the sweep fires it once after a
 * successful bind — Node's next-tick emit). A registration AFTER the
 * emit sits inert forever, exactly Node's once-per-listen event; a
 * settled (closed) server releases the closure unregistered. */
void scr_net_server_on_listening(ScrNetServer *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->listening_cbs, cb, NULL, once);
}

/* 'secureConnection': a TLS server's 'connection' list already fires at
 * handshake completion (defer_conn) — Node's secureConnection timing; on
 * a plain server the event never fires in Node, so the registration is
 * released unread. */
void scr_net_server_on_secure_connection(ScrNetServer *s, ScrClosure *cb /*moves*/,
                                          ScrNetConnFn fn, bool once) {
  if (!s->defer_conn) {
    scr_closure_release(cb);
    return;
  }
  scr_net_server_on_connection(s, cb, fn, once);
}

void scr_net_server_on_connection(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrNetConnFn fn,
                                   bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->conn_ls, cb, (void *)fn, once);
}

void scr_net_server_on_timeout(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrNetConnFn fn,
                                bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->timeout_ls, cb, (void *)fn, once);
}

/* One end of a dropped connection as Node's 'drop' data reports it. */
static void scr_net_drop_side(ScrDyn *data, const char *prefix, const struct sockaddr_storage *ss) {
  char addr[INET6_ADDRSTRLEN] = "";
  int port = 0;
  bool v6 = ss->ss_family == AF_INET6;
  if (v6) {
    inet_ntop(AF_INET6, &((const struct sockaddr_in6 *)ss)->sin6_addr, addr, sizeof addr);
    port = ntohs(((const struct sockaddr_in6 *)ss)->sin6_port);
  } else {
    inet_ntop(AF_INET, &((const struct sockaddr_in *)ss)->sin_addr, addr, sizeof addr);
    port = ntohs(((const struct sockaddr_in *)ss)->sin_port);
  }
  char key[24];
  int n = snprintf(key, sizeof key, "%sAddress", prefix);
  ScrStr *a = scr_str_new(addr, strlen(addr));
  scr_dyn_obj_set(data, key, (size_t)n, scr_dyn_new_str(a));
  scr_str_release(a);
  n = snprintf(key, sizeof key, "%sPort", prefix);
  scr_dyn_obj_set(data, key, (size_t)n, scr_dyn_new_num(port));
  n = snprintf(key, sizeof key, "%sFamily", prefix);
  ScrStr *f = scr_str_new(v6 ? "IPv6" : "IPv4", 4);
  scr_dyn_obj_set(data, key, (size_t)n, scr_dyn_new_str(f));
  scr_str_release(f);
}

/* A connection past server.maxConnections: 'drop' with the local and
 * remote addresses (a null-prototype object in Node), then the close. */
static void scr_net_server_drop_conn(ScrNetServer *srv, int fd) {
  if (srv->drop_ls.n > 0) {
    ScrDyn *data = scr_dyn_new_obj();
    data->null_proto = true;
    struct sockaddr_storage ss;
    socklen_t len = sizeof ss;
    if (getsockname(fd, (struct sockaddr *)&ss, &len) == 0) scr_net_drop_side(data, "local", &ss);
    len = sizeof ss;
    if (getpeername(fd, (struct sockaddr *)&ss, &len) == 0) scr_net_drop_side(data, "remote", &ss);
    scr_net_fire_arg_this(&srv->drop_ls, data, srv, SCR_DYNH_NET_SERVER);
    scr_dyn_release(data);
  }
  scr_net_close_fd_raw(fd);
}

/* Accept until EAGAIN; each connection fires the 'connection' listeners
 * directly (the accepted socket passes +1 per listener via the adapter). */
static void scr_net_server_accept(ScrNetServer *srv) {
  for (;;) {
    if (!srv->listening || srv->fd < 0) return;
    int fd = accept(srv->fd, NULL, NULL);
    if (fd < 0) {
      if (errno == EINTR) continue;
      return; /* EAGAIN or a transient failure: the next wake retries */
    }
    scr_net_nonblock(fd);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    if (srv->max_conns_set && (double)srv->nconns >= srv->max_conns) {
      /* server.maxConnections: Node closes the connection and emits
       * 'drop' with the addresses instead of 'connection' */
      scr_net_server_drop_conn(srv, fd);
      if (scr_exc_pending()) return;
      continue;
    }
    ScrNetSocket *sock = scr_net_sock_new();
    /* Node runs an accepted socket's own events with no store, except
     * under the protocol layer (an HTTP or TLS server), whose connections
     * run in the listen() context this accept runs in. */
    if (!srv->native_conn && !srv->defer_conn) {
      scr_als_ctx_release(sock->als);
      sock->als = NULL;
    }
    sock->fd = fd;
    sock->server = scr_net_server_retain(srv);
    srv->nconns++;
    scr_net_sock_register(sock);
    if (srv->http_timeout_surface && srv->http_timeouts[0] > 0)
      scr_net_sock_set_timeout(sock, srv->http_timeouts[0]);
    if (srv->native_conn) {
      /* the protocol layer (scr_http.c / scr_tls.c) claims the connection */
      srv->native_conn(srv->native_ctx, sock);
      if (scr_exc_pending()) return;
    }
    if (srv->defer_conn) {
      /* 'connection' waits for the handshake (secureConnection timing) */
      sock->conn_pending = scr_net_server_retain(srv);
    }
    if (!srv->defer_conn) {
      ScrNetL *snap;
      size_t n = scr_net_ls_snapshot(&srv->conn_ls, &snap);
      scr_dyn_this_push(srv, SCR_DYNH_NET_SERVER);
      for (size_t i = 0; i < n; i++) {
        if (!scr_exc_pending()) ((ScrNetConnFn)snap[i].fn)(snap[i].cb, scr_net_sock_retain(sock));
        scr_closure_release(snap[i].cb);
      }
      scr_dyn_this_pop();
      free(snap);
    }
    scr_net_sock_release(sock); /* registry + server-count refs remain */
    if (scr_exc_pending()) return;
  }
}

/* ── the client ──────────────────────────────────────────────────────── */

/* connect(port, host): numeric IPv4/IPv6 hosts, "localhost" (pinned to
 * 127.0.0.1 — the documented divergence from Node's family autoselect),
 * and host names resolved through getaddrinfo. The connect callback registers as once('connect'). Never throws: every
 * failure is the async 'error' event, like Node. */

ScrStr *scr_net_blocking_lookup(ScrStr *host /*borrowed*/) {
  if (host->len == 9 && memcmp(host->data, "localhost", 9) == 0) return scr_str_retain(host);
  struct in_addr a4;
  struct in6_addr a6;
  if (inet_pton(AF_INET, host->data, &a4) == 1 || inet_pton(AF_INET6, host->data, &a6) == 1) {
    return scr_str_retain(host);
  }
  if (!scr_net_poller_init()) return scr_str_retain(host); /* WSAStartup on win32 */
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_socktype = SOCK_STREAM;
  struct addrinfo *res = NULL;
  if (getaddrinfo(host->data, NULL, &hints, &res) != 0 || res == NULL) {
    if (res) freeaddrinfo(res);
    return scr_str_retain(host);
  }
  char ip[INET6_ADDRSTRLEN] = "";
  const char *out = NULL;
  if (res->ai_family == AF_INET) {
    out = inet_ntop(AF_INET, &((struct sockaddr_in *)res->ai_addr)->sin_addr, ip, sizeof ip);
  } else if (res->ai_family == AF_INET6) {
    out = inet_ntop(AF_INET6, &((struct sockaddr_in6 *)res->ai_addr)->sin6_addr, ip, sizeof ip);
  }
  freeaddrinfo(res);
  if (!out) return scr_str_retain(host);
  return scr_str_new(ip, strlen(ip));
}

/* Records a host connect target: IP literals dial as given, "localhost"
 * is pinned to 127.0.0.1 (the documented divergence from Node's family
 * autoselect), and any other name is resolved when the dial starts. */
static void scr_net_sock_set_peer(ScrNetSocket *s, ScrStr *host /*borrowed, nullable*/) {
  const char *h = host && host->len > 0 ? host->data : "localhost";
  scr_str_release(s->host_name);
  s->host_name = scr_str_new(h, strlen(h));
  if (strcmp(h, "localhost") == 0) {
    h = "127.0.0.1";
    if (scr_net_lookup_ops != NULL) scr_net_lookup_ops->record(s, "localhost", 9, h, 4, NULL);
  }
  snprintf(s->peer_ip, sizeof s->peer_ip, "%s", h);
  struct in_addr a4;
  struct in6_addr a6;
  if (inet_pton(AF_INET, h, &a4) != 1 && inet_pton(AF_INET6, h, &a6) != 1)
    s->dial_host = scr_str_retain(host);
}

/* Resolves dial_host the way Node's lookupAndConnect does: getaddrinfo
 * for stream sockets of any family, with AI_ADDRCONFIG except on
 * Windows. The answers are deduplicated and ordered like Node's
 * autoSelectFamily list (families alternate, starting with the first
 * answer's), then dialed in order through the address chain: a failed
 * connect tries the next address, and the last failure is the 'error'.
 * The attempt timer that starts the next address while one is still
 * pending is not modeled. A failed lookup is Node's deferred
 * "getaddrinfo <code> <host>" error. */
static void scr_net_sock_dial_host(ScrNetSocket *s) {
  ScrStr *host = s->dial_host;
  s->dial_host = NULL;
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
#ifndef _WIN32
  hints.ai_flags = AI_ADDRCONFIG;
#endif
  struct addrinfo *res = NULL;
  int rc = getaddrinfo(host->data, NULL, &hints, &res);
  size_t n = 0;
  for (struct addrinfo *ai = rc == 0 ? res : NULL; ai != NULL; ai = ai->ai_next) n++;
  ScrStr **ips = n > 0 ? calloc(n, sizeof *ips) : NULL;
  if (n > 0 && !ips) scr_net_oom();
  /* by family: [0] is the first answer's family, [1] the other */
  size_t count[2] = { 0, 0 };
  ScrStr **fam[2] = { NULL, NULL };
  int first = AF_UNSPEC;
  for (struct addrinfo *ai = rc == 0 ? res : NULL; ai != NULL; ai = ai->ai_next) {
    char ip[INET6_ADDRSTRLEN];
    const char *out = NULL;
    if (ai->ai_family == AF_INET) {
      out = inet_ntop(AF_INET, &((struct sockaddr_in *)ai->ai_addr)->sin_addr, ip, sizeof ip);
    } else if (ai->ai_family == AF_INET6) {
      out = inet_ntop(AF_INET6, &((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr, ip, sizeof ip);
    }
    if (out == NULL) continue;
    if (scr_net_lookup_ops != NULL)
      scr_net_lookup_ops->record(s, host->data, host->len, ip, ai->ai_family == AF_INET6 ? 6 : 4,
                                 NULL);
    if (first == AF_UNSPEC) first = ai->ai_family;
    size_t f = ai->ai_family == first ? 0 : 1;
    if (fam[f] == NULL) {
      fam[f] = calloc(n, sizeof *fam[f]);
      if (!fam[f]) scr_net_oom();
    }
    size_t len = strlen(ip);
    bool seen = false;
    for (size_t i = 0; i < count[f] && !seen; i++)
      seen = fam[f][i]->len == len && memcmp(fam[f][i]->data, ip, len) == 0;
    if (!seen) fam[f][count[f]++] = scr_str_new(ip, len);
  }
  if (res) freeaddrinfo(res);
  size_t total = 0;
  for (size_t i = 0; i < count[0] || i < count[1]; i++) {
    if (i < count[0]) ips[total++] = fam[0][i];
    if (i < count[1]) ips[total++] = fam[1][i];
  }
  free(fam[0]);
  free(fam[1]);
  if (total == 0) {
    bool notfound = rc == 0 || rc == EAI_NONAME
#ifdef EAI_NODATA
                    || rc == EAI_NODATA
#endif
        ;
    const char *code = notfound ? "ENOTFOUND" : rc == EAI_AGAIN ? "EAI_AGAIN" : "EAI_FAIL";
    char msg[320];
    snprintf(msg, sizeof msg, "getaddrinfo %s %.*s", code,
             (int)(host->len < 255 ? host->len : 255), host->data);
    if (scr_net_lookup_ops != NULL) scr_net_lookup_ops->record(s, host->data, host->len, NULL, 0, msg);
    free(ips);
    scr_str_release(host);
    s->pending_err = scr_str_new(msg, strlen(msg));
    s->had_error = true;
    s->emit_close = true;
    s->connecting = false;
    return;
  }
  scr_str_release(host);
  s->dial_ips = ips;
  s->dial_n = total;
  s->dial_i = 0;
  scr_net_sock_dial_next(s);
}

/* The dial itself (peer_ip/peer_port already set): the sockaddr arms,
 * socket(), and the nonblocking connect(). Shared by the immediate dial
 * (scr_net_connect) and the DEFERRED one (the http agent's maxSockets
 * queue — the socket exists, buffers writes, and dials when a slot
 * frees). */
static void scr_net_sock_dial_peer(ScrNetSocket *s) {
  if (s->dial_hook != NULL) {
    s->dial_hook(s);
    return;
  }
  if (s->dial_host != NULL) {
    scr_net_sock_dial_host(s);
    return;
  }
  const char *h = s->peer_ip;
  struct sockaddr_in a4;
  struct sockaddr_in6 a6;
  struct sockaddr *sa = NULL;
  socklen_t salen = 0;
  memset(&a4, 0, sizeof a4);
  memset(&a6, 0, sizeof a6);
  if (inet_pton(AF_INET, h, &a4.sin_addr) == 1) {
    a4.sin_family = AF_INET;
    a4.sin_port = htons((uint16_t)s->peer_port);
    sa = (struct sockaddr *)&a4;
    salen = sizeof a4;
  } else if (inet_pton(AF_INET6, h, &a6.sin6_addr) == 1) {
    a6.sin6_family = AF_INET6;
    a6.sin6_port = htons((uint16_t)s->peer_port);
    sa = (struct sockaddr *)&a6;
    salen = sizeof a6;
  }
  if (!sa) {
    /* not an IP literal and not resolved: Node's shape for a failed
     * lookup is ENOTFOUND; deliver it deferred. */
    char msg[160];
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", h);
    s->pending_err = scr_str_new(msg, strlen(msg));
    s->had_error = true;
    s->emit_close = true;
    s->connecting = false;
    return;
  }
  int fd = socket(sa->sa_family, SOCK_STREAM, 0);
  if (fd < 0) {
    fputs("scriptc: socket() failed\n", stderr);
    abort();
  }
  scr_net_nonblock(fd);
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  s->fd = fd;
  int rc = connect(fd, sa, salen);
  if (rc == 0) {
    /* Immediate success (loopback can): still async — the write filter
     * fires at once and connect_done delivers 'connect' from dispatch. */
    s->connecting = true;
    scr_net_sock_update_write(s);
  } else if (errno == EINPROGRESS) {
    s->connecting = true;
    scr_net_sock_update_write(s);
  } else {
    char msg[128];
    snprintf(msg, sizeof msg, "connect %s %s:%d", scr_net_errname(errno), s->peer_ip,
             s->peer_port);
    s->pending_err = scr_str_new(msg, strlen(msg));
    s->had_error = true;
    s->connecting = false;
    scr_net_sock_close_fd(s);
  }
}

/* lookupAndConnect's validateStringWithoutNullBytes(host, 'options.host'):
 * a host with a null byte throws ERR_INVALID_ARG_VALUE before any lookup.
 * False with the exception pending. */
bool scr_net_host_chk(const ScrStr *host /*borrowed, nullable*/) {
  if (host == NULL || memchr(host->data, '\0', host->len) == NULL) return true;
  ScrStr *shown = scr_str_inspect_quoted(host, true);
  ScrJsonBuf msg;
  scr_jb_init(&msg);
  scr_jb_puts(&msg, "The property 'options.host' must be a string without null bytes. Received ");
  scr_jb_put_str(&msg, shown);
  scr_str_release(shown);
  ScrStr *text = scr_jb_finish(&msg);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(text);
  return false;
}

ScrNetSocket *scr_net_connect(double port, ScrStr *host /*borrowed, nullable*/,
                               ScrClosure *cb /*moves, nullable*/) {
  ScrNetSocket *s = scr_net_sock_new();
  if (cb) scr_net_ls_add(&s->conn_ls, cb, NULL, true);
  s->peer_port = (int)port;
  scr_net_sock_set_peer(s, host);
  if (!scr_net_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  scr_net_sock_dial_peer(s);
  scr_net_sock_register(s);
  return s;
}

/* ── the connect option-bag validation ladders (checked-dynamic lane) ──
 * Node-order validation over dyn option values with Node's exact typed
 * errors; the honest tail (connect for the validated forms, the
 * compiler-rendered fence for bags with unmodeled keys) runs only after
 * every validation passes. */

static bool scr_net_attempt_timeout_chk(const ScrDyn *t, const char *name) {
  if (t->kind != SCR_DYN_NUM) {
    scr_dyn_prop_type_fail(name, "of type number", t);
    return false;
  }
  char recv[48], msg[192];
  if (!(isfinite(t->v.num) && trunc(t->v.num) == t->v.num)) {
    scr_num_received(t->v.num, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be an integer. Received %s",
                       name, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (t->v.num < 1 || t->v.num > 2147483647.0) {
    scr_num_received(t->v.num, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be >= 1 && <= 2147483647. Received %s",
                       name, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

/* connect({ ..., autoSelectFamilyAttemptTimeout }): the budget validates
 * (validateInt32 from 1, Node's exact texts) and is then inert — this
 * slice's single dial has nothing to time, the same simplification the
 * autoSelectFamily flag already takes. NULL with the throw pending. */
ScrNetSocket *scr_net_connect_attempt(double port, ScrStr *host, const ScrDyn *t) {
  if (!scr_net_attempt_timeout_chk(t, "options.autoSelectFamilyAttemptTimeout")) return NULL;
  if (!scr_net_host_chk(host)) return NULL;
  return scr_net_connect(port, host, NULL);
}

/* net.connect/createConnection from compiled code: the host check, then
 * the dial. NULL with the exception pending when the host is rejected. */
ScrNetSocket *scr_net_connect_checked(double port, ScrStr *host /*borrowed, nullable*/,
                                       ScrClosure *cb /*moves, nullable*/) {
  if (!scr_net_host_chk(host)) {
    scr_closure_release(cb);
    return NULL;
  }
  return scr_net_connect(port, host, cb);
}

static bool scr_net_dyn_truthy(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL: return false;
  case SCR_DYN_BOOL: return v->v.b;
  case SCR_DYN_NUM: return v->v.num == v->v.num && v->v.num != 0;
  case SCR_DYN_STR: return v->v.str->len > 0;
  default: return true;
  }
}

/* net.connect/createConnection over a RUNTIME option bag (computed keys
 * — the invalid-input probes): Node's Socket-constructor order — the
 * objectMode trio throws ERR_INVALID_ARG_VALUE first, then the port
 * (validatePort), the host's string contract, autoSelectFamily's boolean
 * contract, and the attempt budget. A bag that survives everything meets
 * the compiler-rendered fence: an unmodeled key throws instead of being
 * dropped. Always leaves an exception pending. */
void scr_net_connect_opts_chk(const ScrDyn *opts, const ScrStr *fence) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("options", "of type object",
                          opts ? opts : scr_dyn_undefined());
    return;
  }
  static const char *const om[] = { "objectMode", "readableObjectMode", "writableObjectMode" };
  for (size_t i = 0; i < 3; i++) {
    const ScrDyn *v = scr_dyn_obj_get(opts, om[i], strlen(om[i]));
    if (v != NULL && scr_net_dyn_truthy(v)) {
      char name[48];
      snprintf(name, sizeof name, "options.%s", om[i]);
      scr_dyn_arg_value_fail(name, "is not supported", v);
      return;
    }
  }
  const ScrDyn *port = scr_dyn_obj_get(opts, "port", 4);
  if (port != NULL && port->kind != SCR_DYN_UNDEF) {
    bool ok = port->kind == SCR_DYN_NUM && trunc(port->v.num) == port->v.num &&
              port->v.num >= 0 && port->v.num < 65536;
    if (!ok && port->kind == SCR_DYN_STR) {
      ScrStr *ps = scr_str_retain(port->v.str);
      double n = scr_string_to_number(ps);
      scr_str_release(ps);
      ok = n == n && trunc(n) == n && n >= 0 && n < 65536 && port->v.str->len > 0;
    }
    if (!ok) {
      char detail[64], msg[160];
      const char *d = scr_dyn_specific_type(port, detail, sizeof detail);
      int len = snprintf(msg, sizeof msg,
                         "options.port should be >= 0 and < 65536. Received %s", d);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_SOCKET_BAD_PORT");
      return;
    }
  }
  const ScrDyn *host = scr_dyn_obj_get(opts, "host", 4);
  if (host != NULL && host->kind != SCR_DYN_UNDEF && host->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("options.host", "of type string", host);
    return;
  }
  const ScrDyn *asf = scr_dyn_obj_get(opts, "autoSelectFamily", 16);
  if (asf != NULL && asf->kind != SCR_DYN_UNDEF && asf->kind != SCR_DYN_BOOL) {
    scr_dyn_prop_type_fail("options.autoSelectFamily", "of type boolean", asf);
    return;
  }
  const ScrDyn *att = scr_dyn_obj_get(opts, "autoSelectFamilyAttemptTimeout", 30);
  if (att != NULL && att->kind != SCR_DYN_UNDEF &&
      !scr_net_attempt_timeout_chk(att, "options.autoSelectFamilyAttemptTimeout")) {
    return;
  }
  scr_throw_lowering_fence(fence);
}

/* A dial the caller starts LATER (the http agent's maxSockets queue):
 * the socket exists, registers, and buffers writes as "connecting" —
 * scr_net_sock_dial_start runs the actual dial when a slot frees. */
ScrNetSocket *scr_net_connect_deferred(double port, ScrStr *host /*borrowed, nullable*/) {
  ScrNetSocket *s = scr_net_sock_new();
  s->peer_port = (int)port;
  scr_net_sock_set_peer(s, host);
  if (!scr_net_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  s->connecting = true; /* logically connecting while the dial waits */
  s->dial_deferred = true;
  scr_net_sock_register(s);
  return s;
}

/* Moves a deferred socket's buffered (never sent) bytes onto `to`, which
 * sends them in order after its own: an http agent request that waited
 * for a slot takes a pooled socket instead of dialing. */
void scr_net_sock_move_writes(ScrNetSocket *from, ScrNetSocket *to) {
  if (from->wlen > from->whead) scr_net_sock_write_native(to, from->wbuf + from->whead, from->wlen - from->whead);
  from->whead = from->wlen = 0;
}

void scr_net_sock_dial_start(ScrNetSocket *s) {
  if (!s->dial_deferred || s->close_emitted || s->emit_close || s->fd >= 0) return;
  s->dial_deferred = false;
  scr_net_sock_dial_peer(s);
}

/* ── Unix domain sockets ───────────────────────────────────────────────
 *
 * listen(path) and the http client's socketPath option. Node (libuv)
 * reports these failures with the path where a TCP error names
 * host:port: "connect ENOENT /run/x.sock", "listen EADDRINUSE: address
 * already in use /run/x.sock". Windows has no Unix-socket support here
 * (Node maps paths to named pipes there), so both forms fail with ENOTSUP. */

static const char *scr_net_unix_errname(int err) {
  switch (err) {
  case ENOENT: return "ENOENT";
  case ENOTDIR: return "ENOTDIR";
  case ENAMETOOLONG: return "ENAMETOOLONG";
  case EAGAIN: return "EAGAIN";
  case EPROTOTYPE: return "EPROTOTYPE";
  default: return scr_net_errname(err);
  }
}

static const char *scr_net_unix_reason(int err) {
  switch (err) {
  case EADDRINUSE: return "address already in use";
  case EACCES: return "permission denied";
  case ENOENT: return "no such file or directory";
  case ENOTDIR: return "not a directory";
  case ENAMETOOLONG: return "name too long";
  case EINVAL: return "invalid argument";
  default: return "operation not supported";
  }
}

/* Fills a sockaddr_un for `path`; false (with errno set) when it does not
 * fit, which libuv reports as ENAMETOOLONG too. */
#ifndef _WIN32
static bool scr_net_unix_addr(const ScrStr *path, struct sockaddr_un *sa) {
  memset(sa, 0, sizeof *sa);
  sa->sun_family = AF_UNIX;
  if (path->len >= sizeof sa->sun_path || memchr(path->data, '\0', path->len) != NULL) {
    errno = ENAMETOOLONG;
    return false;
  }
  memcpy(sa->sun_path, path->data, path->len);
  return true;
}
#endif

/* The dial_hook of a Unix-socket client: a nonblocking connect that
 * completes through the same write-readiness path as TCP. A local
 * connect usually settles at once; its failure is the deferred 'error'. */
static void scr_net_sock_dial_unix(ScrNetSocket *s) {
  int err = ENOTSUP;
#ifndef _WIN32
  struct sockaddr_un sa;
  if (scr_net_unix_addr(s->unix_path, &sa)) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
      fputs("scriptc: socket() failed\n", stderr);
      abort();
    }
    scr_net_nonblock(fd);
    s->fd = fd;
    if (connect(fd, (struct sockaddr *)&sa, sizeof sa) == 0 || errno == EINPROGRESS) {
      s->connecting = true;
      scr_net_sock_update_write(s);
      return;
    }
  }
  err = errno;
#endif
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "connect ");
  scr_jb_puts(&b, scr_net_unix_errname(err));
  scr_jb_putc(&b, ' ');
  scr_jb_write(&b, s->unix_path->data, s->unix_path->len);
  s->pending_err = scr_jb_finish(&b);
  s->had_error = true;
  s->connecting = false;
  scr_net_sock_close_fd(s);
}

/* A client socket for the Unix socket at `path` (borrowed). `deferred`
 * creates it the way scr_net_connect_deferred does: registered and
 * buffering, dialed by scr_net_sock_dial_start. +1. */
ScrNetSocket *scr_net_connect_path(ScrStr *path, bool deferred) {
  ScrNetSocket *s = scr_net_sock_new();
  s->unix_path = scr_str_retain(path);
  s->dial_hook = &scr_net_sock_dial_unix;
  if (!scr_net_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  if (deferred) {
    s->connecting = true;
    s->dial_deferred = true;
  } else {
    scr_net_sock_dial_unix(s);
  }
  scr_net_sock_register(s);
  return s;
}

/* server.address() in programs that listen on a path (the compiler links
 * these only there): the Unix-socket path a listening server answers in
 * place of the AddressInfo record (+1, "" for a TCP server), and the check
 * a record-typed address() read makes first. */
ScrStr *scr_net_server_unix_path(ScrNetServer *s) {
  return s->listening && s->unix_path != NULL ? scr_str_retain(s->unix_path) : scr_str_new("", 0);
}

void scr_net_server_address_check(ScrNetServer *s) {
  if (!s->listening || s->unix_path == NULL) return;
  static const char msg[] =
      "server.address() of a server listening on a Unix socket is the socket path string; "
      "type the result as string | AddressInfo | null (Node's declaration) to read it";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
}

/* server.listen(path[, cb]): binds a Unix socket now; a failure is the
 * deferred 'error', success the deferred 'listening', as for a port. */
void scr_net_listen_path(ScrNetServer *s, ScrStr *path /*borrowed*/,
                         ScrClosure *cb /*moves, nullable*/) {
  scr_net_server_capture_listen(s);
  /* Node's isPipeName: a string that reads as a non-negative number is a port */
  double port = scr_string_to_number(path);
  if (port >= 0) {
    scr_net_listen_any(s, port, false, cb);
    return;
  }
  if (cb) scr_net_ls_add(&s->listening_cbs, cb, NULL, true);
  if (s->listening || s->close_emitted) return;
  if (!scr_net_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  int err = ENOTSUP;
#ifndef _WIN32
  struct sockaddr_un sa;
  if (scr_net_unix_addr(path, &sa)) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
      fputs("scriptc: socket() failed\n", stderr);
      abort();
    }
    scr_net_nonblock(fd);
    if (bind(fd, (struct sockaddr *)&sa, sizeof sa) == 0 && listen(fd, 511) == 0) {
      s->fd = fd;
      s->listening = true;
      s->emit_listening = true;
      scr_str_release(s->unix_path);
      s->unix_path = scr_str_retain(path);
      scr_net_watch_read(fd, s, true);
      scr_net_server_register(s);
      return;
    }
    err = errno;
    close(fd);
  } else {
    err = errno;
  }
#endif
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "listen ");
  scr_jb_puts(&b, scr_net_unix_errname(err));
  scr_jb_puts(&b, ": ");
  scr_jb_puts(&b, scr_net_unix_reason(err));
  scr_jb_putc(&b, ' ');
  scr_jb_write(&b, path->data, path->len);
  if (!s->pending_err) s->pending_err = scr_jb_finish(&b);
  else scr_str_release(scr_jb_finish(&b));
  scr_net_server_register(s); /* the sweep delivers the failure */
}

/* ── the caller-lookup dial (net.connect with a lookup option) ─────────
 *
 * portless's createLoopbackConnection: connect({ host, port,
 * autoSelectFamily: true, lookup }) — the runtime invokes the caller's
 * resolver exactly as Node does (lookup(hostname, options, callback))
 * and dials its answered addresses IN ORDER: each connect failure closes
 * the fd and tries the next; the last failure's message is the socket's
 * 'error' (Node's AggregateError under autoSelectFamily is a documented
 * divergence). The answer callback is a runtime-minted closure over the
 * boxed socket whose fn is an emitter-synthesized per-shape thunk (the
 * SNI-answer pattern); late, repeated, or dead-socket answers are
 * ignored. */

/* Dials one IP now. Success (established or in progress) answers true;
 * failure records the message (LAST-wins — the retry chain's contract),
 * closes any fd, and answers false without emitting. */
static bool scr_net_sock_dial_ip(ScrNetSocket *s, const ScrStr *ip) {
  char h[64];
  snprintf(h, sizeof h, "%.*s", (int)(ip->len < 63 ? ip->len : 63), ip->data);
  snprintf(s->peer_ip, sizeof s->peer_ip, "%s", h);
  struct sockaddr_in a4;
  struct sockaddr_in6 a6;
  struct sockaddr *sa = NULL;
  socklen_t salen = 0;
  memset(&a4, 0, sizeof a4);
  memset(&a6, 0, sizeof a6);
  if (inet_pton(AF_INET, h, &a4.sin_addr) == 1) {
    a4.sin_family = AF_INET;
    a4.sin_port = htons((uint16_t)s->peer_port);
    sa = (struct sockaddr *)&a4;
    salen = sizeof a4;
  } else if (inet_pton(AF_INET6, h, &a6.sin6_addr) == 1) {
    a6.sin6_family = AF_INET6;
    a6.sin6_port = htons((uint16_t)s->peer_port);
    sa = (struct sockaddr *)&a6;
    salen = sizeof a6;
  }
  char msg[160];
  if (!sa) {
    /* a non-IP answer: the lookup was supposed to resolve — Node's
     * lookup-failure shape */
    snprintf(msg, sizeof msg, "getaddrinfo ENOTFOUND %s", h);
    scr_str_release(s->dial_err);
    s->dial_err = scr_str_new(msg, strlen(msg));
    return false;
  }
  int fd = socket(sa->sa_family, SOCK_STREAM, 0);
  if (fd < 0) {
    fputs("scriptc: socket() failed\n", stderr);
    abort();
  }
  scr_net_nonblock(fd);
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  int rc = connect(fd, sa, salen);
  if (rc == 0 || errno == EINPROGRESS) {
    s->fd = fd;
    s->connecting = true;
    scr_net_sock_update_write(s);
    return true;
  }
  snprintf(msg, sizeof msg, "connect %s %s:%d", scr_net_errname(errno), s->peer_ip, s->peer_port);
  scr_str_release(s->dial_err);
  s->dial_err = scr_str_new(msg, strlen(msg));
  close(fd);
  return false;
}

/* Dials the next answered addresses until one starts; exhaustion flags
 * the deferred 'error' + 'close' (the last dial's message stands). */
static void scr_net_sock_dial_next(ScrNetSocket *s) {
  while (s->dial_i < s->dial_n) {
    const ScrStr *ip = s->dial_ips[s->dial_i++];
    if (scr_net_sock_dial_ip(s, ip)) return;
  }
  /* exhausted: the last failure surfaces now */
  if (s->dial_err != NULL && s->pending_err == NULL) {
    s->pending_err = s->dial_err;
    s->dial_err = NULL;
  }
  s->connecting = false;
  s->had_error = true;
  s->emit_close = true;
}

ScrNetSocket *scr_net_connect_lookup(double port, ScrStr *host /*borrowed*/,
                                      ScrClosure *lookup /*moves*/, void *answer_fn) {
  if (!scr_net_host_chk(host)) {
    scr_closure_release(lookup);
    return NULL;
  }
  ScrNetSocket *s = scr_net_sock_new();
  s->peer_port = (int)port;
  snprintf(s->peer_ip, sizeof s->peer_ip, "%.*s",
           (int)(host->len < 63 ? host->len : 63), host->data);
  if (!scr_net_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  s->connecting = true; /* logically connecting while the lookup decides */
  s->lookup_wait = true;
  scr_net_sock_register(s);
  ScrClosure *ans = scr_closure_new(answer_fn, 1);
  ScrBox *box = scr_box_new_obj(&scr_net_sock_retain_v, &scr_net_sock_release_v, NULL);
  scr_box_set_ref(box, scr_net_sock_retain(s));
  ans->caps[0] = box;
  /* the lookup owns its +1 params per the universal convention; options
   * crosses as the dyn undefined (Node passes its option bag — the
   * lowered resolver shape types it `unknown` and portless ignores it) */
  ((void (*)(ScrClosure *, ScrStr *, ScrDyn *, ScrClosure *))lookup->fn)(
      lookup, scr_str_retain(host), scr_dyn_undefined(), ans);
  scr_closure_release(lookup);
  /* a synchronous throw inside the lookup left the exception pending —
   * the emitter's may-throw check unwinds past this return */
  return s;
}

/* The callback a checked-dynamic lookup function receives (Node's own
 * shape, `(err, address, family)`): with `all: true` the address is a list
 * of { address, family } records, otherwise one address string. caps[0]
 * boxes the socket, as for the typed answer closure. */
static ScrDyn *scr_net_lookup_dyn_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  const ScrDyn *err = argc > 0 ? args[0] : scr_dyn_undefined();
  const ScrDyn *addr = argc > 1 ? args[1] : scr_dyn_undefined();
  ScrStr *msg = NULL;
  ScrArr *ips = NULL;
  bool failed = scr_dyn_truthy(err);
  if (failed) {
    const ScrDyn *m = err->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(err, "message", 7) : NULL;
    msg = m != NULL && m->kind == SCR_DYN_STR ? scr_str_retain(m->v.str) : scr_dyn_string_coerce_js(err);
  } else {
    ScrDyn *view = addr->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(addr) : NULL;
    const ScrDyn *list = view != NULL ? view : addr;
    ips = scr_arr_new(SCR_ELEM_STR, 0);
    if (list->kind == SCR_DYN_STR) {
      scr_arr_push_ref(ips, scr_str_retain(list->v.str));
    } else if (list->kind == SCR_DYN_ARR) {
      for (size_t i = 0; i < list->v.arr.len; i++) {
        const ScrDyn *entry = list->v.arr.items[i];
        ScrDyn *ev = entry->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(entry) : NULL;
        const ScrDyn *rec = ev != NULL ? ev : entry;
        const ScrDyn *a = rec->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(rec, "address", 7) : NULL;
        if (a != NULL && a->kind == SCR_DYN_STR) scr_arr_push_ref(ips, scr_str_retain(a->v.str));
        scr_dyn_release(ev);
      }
    }
    scr_dyn_release(view);
  }
  scr_net_lookup_answer(clo, failed, msg, ips);
  scr_str_release(msg);
  if (ips != NULL) scr_arr_release(ips);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* net.connect({ host, port, lookup }) with a lookup of Node's own type
 * (`(hostname, options, callback)` whose callback takes a string or an
 * address list), held as a checked-dynamic function: the runtime calls it
 * as Node's autoSelectFamily dial does, with { hints, all: true }, and dials
 * the answered addresses in order. NULL with the exception pending. */
ScrNetSocket *scr_net_connect_lookup_dyn(double port, ScrStr *host /*borrowed*/,
                                          const ScrDyn *lookup /*borrowed*/) {
  if (!scr_net_host_chk(host)) return NULL;
  ScrNetSocket *s = scr_net_sock_new();
  s->peer_port = (int)port;
  snprintf(s->peer_ip, sizeof s->peer_ip, "%.*s",
           (int)(host->len < 63 ? host->len : 63), host->data);
  if (!scr_net_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  s->connecting = true;
  s->lookup_wait = true;
  scr_net_sock_register(s);
  ScrClosure *ans = scr_closure_new((void *)&scr_net_lookup_dyn_thunk, 1);
  ScrBox *box = scr_box_new_obj(&scr_net_sock_retain_v, &scr_net_sock_release_v, NULL);
  scr_box_set_ref(box, scr_net_sock_retain(s));
  ans->caps[0] = box;
  ScrDyn *callback = scr_dyn_new_func(ans, &scr_net_lookup_dyn_thunk, 3, "(err, address, family)", "callback");
  ScrDyn *options = scr_dyn_new_obj();
#ifndef _WIN32
  scr_dyn_obj_set(options, "hints", 5, scr_dyn_new_num((double)AI_ADDRCONFIG));
#endif
  scr_dyn_obj_set(options, "all", 3, scr_dyn_new_bool(true));
  ScrDyn *name = scr_dyn_new_str(host);
  ScrDyn *args[3] = { name, options, callback };
  scr_dyn_release(scr_dyn_call(lookup, args, 3, "lookup"));
  scr_dyn_release(name);
  scr_dyn_release(options);
  scr_dyn_release(callback);
  return s;
}

/* The answer closure's runtime half (its fn is the emitted per-shape
 * thunk; caps[0] boxes the socket). msg/ips are borrowed (nullable). */
void scr_net_lookup_answer(ScrClosure *self, bool has_err, ScrStr *msg /*borrowed, nullable*/,
                            ScrArr *ips /*borrowed, nullable*/) {
  ScrNetSocket *s = (ScrNetSocket *)scr_box_get_ref(self->caps[0]);
  if (s == NULL) return;
  if (!s->lookup_wait || s->close_emitted || s->fd >= 0) {
    scr_net_sock_release(s);
    return; /* late/repeated/dead-socket answers: the first decided */
  }
  s->lookup_wait = false;
  size_t n = ips != NULL ? (size_t)scr_arr_len(ips) : 0;
  if (has_err || n == 0) {
    /* lookup failure: the deferred 'error' (Node defers these too); an
     * EMPTY answer wears getaddrinfo's shape */
    if (msg != NULL && msg->len > 0) {
      scr_str_release(s->pending_err);
      s->pending_err = scr_str_retain(msg);
    } else if (s->pending_err == NULL) {
      char fb[160];
      snprintf(fb, sizeof fb, "getaddrinfo ENOTFOUND %s", s->peer_ip);
      s->pending_err = scr_str_new(fb, strlen(fb));
    }
    s->connecting = false;
    s->had_error = true;
    s->emit_close = true;
    scr_net_sock_release(s);
    return;
  }
  s->dial_ips = malloc(n * sizeof *s->dial_ips);
  if (!s->dial_ips) scr_net_oom();
  for (size_t i = 0; i < n; i++) s->dial_ips[i] = (ScrStr *)scr_arr_get_ref(ips, (double)i);
  s->dial_n = n;
  s->dial_i = 0;
  scr_net_sock_dial_next(s);
  scr_net_sock_release(s);
}

/* ── the socket surface ──────────────────────────────────────────────── */

void scr_net_sock_write_str(ScrNetSocket *s, ScrStr *data /*borrowed*/) {
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  scr_net_sock_write_raw(s, bytes, data->len);
  scr_str_utf8_end(owned);
}

void scr_net_sock_write_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/) {
  SCR_BYTES_SNAPSHOT(data);
  scr_net_sock_write_raw(s, (const char *)data->data, (data->len * scr_bytes_elem_size(data->elem)));
}

void scr_net_sock_end(ScrNetSocket *s) {
  if (s->adopted_by != NULL) {
    scr_net_sock_end(s->adopted_by);
    return;
  }
  if (s->fd < 0 || s->wr_ending) return;
  s->wr_ending = true;
  scr_als_ctx_release(s->end_ctx);
  s->end_ctx = scr_als_capture();
  scr_net_sock_maybe_finish_write(s);
  if (s->rd_eof && s->wr_done) scr_net_sock_close_fd(s);
}

void scr_net_sock_end_str(ScrNetSocket *s, ScrStr *data /*borrowed*/) {
  scr_net_sock_write_str(s, data);
  scr_net_sock_end(s);
}

void scr_net_sock_end_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/) {
  scr_net_sock_write_bytes(s, data);
  scr_net_sock_end(s);
}

/* socket.pause(): reads stay off — the kernel buffer (and TCP flow
 * control) holds arrived bytes. Delivery restarts on
 * resume(), always from the poller/sweep, never this stack. Answers the
 * socket (+1) — Node's chaining. */
ScrNetSocket *scr_net_sock_pause(ScrNetSocket *s) {
  s->user_paused = true;
  scr_net_sock_update_read(s);
  return scr_net_sock_retain(s);
}

/* Stops (hold) or restarts reads for a protocol consumer that has
 * buffered as much as it accepts, as Node's readStop when push() returns
 * false. Separate from pause()/resume(), which stay the user's. */
void scr_net_sock_hold(ScrNetSocket *s, bool hold) {
  if (s->hold == hold) return;
  s->hold = hold;
  scr_net_sock_update_read(s);
}

/* socket.resume(): flowing mode — a consumer even with no 'data'
 * listener (arrived bytes discard, so 'end' can be reached, Node's
 * resumed-but-unconsumed stream). Buffered bytes deliver from the next
 * sweep (flags_pending sees the flowing consumer), not this stack.
 * Answers the socket (+1) — Node's chaining. */
ScrNetSocket *scr_net_sock_resume(ScrNetSocket *s) {
  s->user_paused = false;
  s->flowing = true;
  scr_net_sock_update_read(s);
  return scr_net_sock_retain(s);
}

/* socket.setNoDelay(enable): TCP_NODELAY on the live fd (client dials
 * already set it — Node's default there is off, a documented divergence
 * in the dial path; this call makes the state explicit either way).
 * Answers the socket (+1) — Node's chaining. */
ScrNetSocket *scr_net_sock_set_nodelay(ScrNetSocket *s, bool enable) {
  if (s->fd >= 0) {
    int v = enable ? 1 : 0;
    setsockopt(s->fd, IPPROTO_TCP, TCP_NODELAY, &v, sizeof v);
  }
  return scr_net_sock_retain(s);
}

void scr_net_sock_set_keepalive(ScrNetSocket *s, bool enable, double delay_ms) {
  if (s->fd < 0) return;
  int value = enable ? 1 : 0;
  setsockopt(s->fd, SOL_SOCKET, SO_KEEPALIVE, &value, sizeof value);
  if (!enable || !(delay_ms > 0) || !isfinite(delay_ms)) return;
  int seconds = (int)fmin((double)INT_MAX, fmax(1.0, floor(delay_ms / 1000.0)));
#if defined(TCP_KEEPIDLE)
  setsockopt(s->fd, IPPROTO_TCP, TCP_KEEPIDLE, &seconds, sizeof seconds);
#elif defined(TCP_KEEPALIVE)
  setsockopt(s->fd, IPPROTO_TCP, TCP_KEEPALIVE, &seconds, sizeof seconds);
#endif
}

/* socket.setKeepAlive(enable, initialDelay) as the program calls it:
 * answers the socket (+1), Node's chaining. */
ScrNetSocket *scr_net_sock_set_keepalive_ret(ScrNetSocket *s, bool enable, double delay_ms) {
  scr_net_sock_set_keepalive(s, enable, delay_ms);
  return scr_net_sock_retain(s);
}

/* end(callback) with a dyn callback: once 'finish', called without
 * arguments. */
void scr_net_sock_on_finish_dyn(ScrNetSocket *s, const ScrDyn *listener /*borrowed*/) {
  scr_net_sock_on_finish(s, scr_dyn_listener_closure0(listener));
}

/* socket.destroySoon(): end the write half now, destroy once the FIN is
 * actually out (buffered bytes flush first — Node's 'finish'-then-destroy). */
void scr_net_sock_destroy_soon(ScrNetSocket *s) {
  if (s->fd < 0) return;
  if (s->wr_done) {
    scr_net_sock_close_fd(s);
    return;
  }
  s->destroy_on_finish = true;
  s->wr_ending = true;
  scr_net_sock_maybe_finish_write(s);
}

/* end(callback): fires once the FIN went out ('finish'), from the sweep. */
void scr_net_sock_on_finish(ScrNetSocket *s, ScrClosure *cb /*moves*/) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->finish_ls, cb, NULL, true);
  if (s->wr_done) s->finish_pending = true; /* already finished: next sweep */
}

/* The context the socket's events run in from now on (borrowed): an HTTP
 * agent hands a pooled socket to another request. */
void scr_net_sock_set_context(ScrNetSocket *s, ScrAlsCtx *ctx) {
  ScrAlsCtx *next = scr_als_ctx_retain(ctx);
  scr_als_ctx_release(s->als);
  s->als = next;
}

/* A write callback runs in the write() call's AsyncLocalStorage context
 * (Node's write request): with a store active, the list holds a closure
 * that enters it around the callback. caps[0] is the callback, caps[1]
 * the context. */
static void *scr_net_ctx_retain_v(void *c) { return scr_als_ctx_retain(c); }
static void scr_net_ctx_release_v(void *c) { scr_als_ctx_release(c); }

static void scr_net_ctx_fire0(ScrClosure *self) {
  ScrClosure *cb = scr_box_get_ref(self->caps[0]);
  ScrAlsCtx *ctx = scr_box_get_ref(self->caps[1]);
  ScrAlsCtx *prev = scr_als_dispatch_enter(ctx);
  ((void (*)(ScrClosure *))cb->fn)(cb);
  scr_als_dispatch_leave(prev);
  scr_als_ctx_release(ctx);
  scr_closure_release(cb);
}

static void scr_net_dyn_fire_arg(ScrClosure *cb, const ScrDyn *arg);

static void scr_net_ctx_fire_arg(ScrClosure *self, const ScrDyn *arg) {
  ScrClosure *cb = scr_box_get_ref(self->caps[0]);
  ScrAlsCtx *ctx = scr_box_get_ref(self->caps[1]);
  ScrAlsCtx *prev = scr_als_dispatch_enter(ctx);
  scr_net_dyn_fire_arg(cb, arg);
  scr_als_dispatch_leave(prev);
  scr_als_ctx_release(ctx);
  scr_closure_release(cb);
}

/* Adds a write callback (moves) with its firing adapter (NULL: a
 * zero-argument closure; scr_net_dyn_fire_arg: a dyn listener). */
static __attribute__((noinline)) ScrClosure *scr_net_bind_write_cb(ScrClosure *cb /*moves*/, void **fn,
                                                                    ScrAlsCtx *active) {
  ScrClosure *bound = scr_closure_new(*fn == NULL ? (void *)scr_net_ctx_fire0 : NULL, 2);
  bound->caps[0] = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(bound->caps[0], cb);
  bound->caps[1] = scr_box_new_obj(scr_net_ctx_retain_v, scr_net_ctx_release_v, NULL);
  scr_box_set_ref(bound->caps[1], scr_als_ctx_retain(active));
  if (*fn != NULL) *fn = (void *)&scr_net_ctx_fire_arg;
  return bound;
}

static void scr_net_sock_add_write_cb(ScrNetSocket *s, ScrClosure *cb, void *fn) {
  ScrAlsCtx *active = *SCR_ALS_SLOT();
  if (active != NULL) cb = scr_net_bind_write_cb(cb, &fn, active);
  scr_net_ls_add(&s->wcb_ls, cb, fn, true);
}

/* write(chunk, callback): fires when the write buffer drains (this
 * surface's flush moment), from the sweep. */
void scr_net_sock_on_write_flush(ScrNetSocket *s, ScrClosure *cb /*moves*/) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_sock_add_write_cb(s, cb, NULL);
}

double scr_net_sock_bytes_written(ScrNetSocket *s) { return (double)s->bytes_written; }

/* socket.readable: true until the read half is done (peer FIN / destroy). */
bool scr_net_sock_readable(ScrNetSocket *s) {
  if (s->adopted_by != NULL) return scr_net_sock_readable(s->adopted_by);
  return s->fd >= 0 && !s->rd_eof;
}

/* socket.setTimeout(ms): ms > 0 arms the idle timer NOW (Node starts the
 * clock at the call — connecting time counts), ms <= 0 disables. */
void scr_net_sock_set_timeout(ScrNetSocket *s, double ms) {
  if (ms > 0 && s->fd >= 0) {
    s->timeout_ms = ms;
    scr_net_sock_timer_arm(s);
  } else {
    s->timeout_ms = 0;
    scr_net_sock_timer_cancel(s);
  }
}

void scr_net_sock_on_timeout(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->timeout_ls, cb, NULL, once);
}

/* socket.remoteAddress: the peer's address (+1), cached at first read
 * (Node's _getpeername cache: a value read while connected survives
 * destroy), or NULL — the undefined arm — for a never-read socket after
 * close. A dual-stack accept of an IPv4 peer reads "::ffff:a.b.c.d",
 * like Node. */
/* socket.encrypted: true iff the socket carries a TLS transport (Node
 * types `encrypted: true` on TLSSocket from construction; plain sockets
 * answer the undefined arm — the emitter maps false to it). */
bool scr_net_sock_encrypted(ScrNetSocket *s) { return s->tops != NULL; }

ScrStr *scr_net_sock_remote_address(ScrNetSocket *s) {
  if (s->remote_cache) return scr_str_retain(s->remote_cache);
  /* Node's _getpeername answers {} while connecting */
  if (s->fd < 0 || scr_net_sock_connecting(s)) return NULL;
  struct sockaddr_storage ss;
  socklen_t len = sizeof ss;
  if (getpeername(s->fd, (struct sockaddr *)&ss, &len) != 0) return NULL;
  char buf[INET6_ADDRSTRLEN];
  const char *out = NULL;
  if (ss.ss_family == AF_INET) {
    out = inet_ntop(AF_INET, &((struct sockaddr_in *)&ss)->sin_addr, buf, sizeof buf);
  } else if (ss.ss_family == AF_INET6) {
    out = inet_ntop(AF_INET6, &((struct sockaddr_in6 *)&ss)->sin6_addr, buf, sizeof buf);
  }
  if (!out) return NULL;
  s->remote_cache = scr_str_new(out, strlen(out));
  s->remote_v6_cache = ss.ss_family == AF_INET6;
  s->remote_port_cache = ntohs(ss.ss_family == AF_INET6 ? ((struct sockaddr_in6 *)&ss)->sin6_port
                                                         : ((struct sockaddr_in *)&ss)->sin_port);
  return scr_str_retain(s->remote_cache);
}

/* socket.remotePort / remoteFamily: the same cached peer read as
 * remoteAddress; NaN / NULL answer undefined. */
double scr_net_sock_remote_port(ScrNetSocket *s) {
  scr_str_release(scr_net_sock_remote_address(s));
  return s->remote_cache ? (double)s->remote_port_cache : NAN;
}

ScrStr *scr_net_sock_remote_family(ScrNetSocket *s) {
  scr_str_release(scr_net_sock_remote_address(s));
  if (!s->remote_cache) return NULL;
  return s->remote_v6_cache ? scr_str_new("IPv6", 4) : scr_str_new("IPv4", 4);
}

/* socket.localAddress / localPort / localFamily: read from the open
 * socket (undefined while connecting and after close, as in Node). */
static bool scr_net_sock_local(ScrNetSocket *s, char *addr, size_t cap, int *port, bool *v6) {
  if (s->adopted_by != NULL) return scr_net_sock_local(s->adopted_by, addr, cap, port, v6);
  if (s->fd < 0 || s->connecting || s->dial_deferred || s->lookup_wait) return false;
  struct sockaddr_storage ss;
  socklen_t len = sizeof ss;
  if (getsockname(s->fd, (struct sockaddr *)&ss, &len) != 0) return false;
  if (ss.ss_family == AF_INET) {
    if (!inet_ntop(AF_INET, &((struct sockaddr_in *)&ss)->sin_addr, addr, (socklen_t)cap)) return false;
    *port = ntohs(((struct sockaddr_in *)&ss)->sin_port);
    *v6 = false;
    return true;
  }
  if (ss.ss_family == AF_INET6) {
    if (!inet_ntop(AF_INET6, &((struct sockaddr_in6 *)&ss)->sin6_addr, addr, (socklen_t)cap)) return false;
    *port = ntohs(((struct sockaddr_in6 *)&ss)->sin6_port);
    *v6 = true;
    return true;
  }
  return false;
}

ScrStr *scr_net_sock_local_address(ScrNetSocket *s) {
  char addr[INET6_ADDRSTRLEN];
  int port;
  bool v6;
  return scr_net_sock_local(s, addr, sizeof addr, &port, &v6) ? scr_str_new(addr, strlen(addr)) : NULL;
}

double scr_net_sock_local_port(ScrNetSocket *s) {
  char addr[INET6_ADDRSTRLEN];
  int port;
  bool v6;
  return scr_net_sock_local(s, addr, sizeof addr, &port, &v6) ? (double)port : NAN;
}

ScrStr *scr_net_sock_local_family(ScrNetSocket *s) {
  char addr[INET6_ADDRSTRLEN];
  int port;
  bool v6;
  if (!scr_net_sock_local(s, addr, sizeof addr, &port, &v6)) return NULL;
  return v6 ? scr_str_new("IPv6", 4) : scr_str_new("IPv4", 4);
}

/* socket.address(): { address, family, port } while the socket has a
 * local address, {} while it connects or once it is destroyed, as Node's
 * _getsockname answers. +1. */
ScrDyn *scr_net_sock_address(ScrNetSocket *s) {
  ScrDyn *out = scr_dyn_new_obj();
  char addr[INET6_ADDRSTRLEN];
  int port;
  bool v6;
  if (s->connecting || !scr_net_sock_local(s, addr, sizeof addr, &port, &v6)) return out;
  ScrStr *a = scr_str_new(addr, strlen(addr));
  scr_dyn_obj_set(out, "address", 7, scr_dyn_new_str(a));
  scr_str_release(a);
  ScrStr *f = v6 ? scr_str_new("IPv6", 4) : scr_str_new("IPv4", 4);
  scr_dyn_obj_set(out, "family", 6, scr_dyn_new_str(f));
  scr_str_release(f);
  scr_dyn_obj_set(out, "port", 4, scr_dyn_new_num((double)port));
  return out;
}

/* socket.resetAndDestroy(): the connection closes with an RST instead of
 * a FIN (SO_LINGER with a zero timeout, then close), like Node's TCP
 * reset; 'close' reports hadError false. A connecting socket resets once
 * it connects: Node registers the reset as a once('connect') listener,
 * so it runs at that place among the 'connect' listeners. A destroyed
 * socket is left as it is, and a TLS socket throws Node's
 * ERR_INVALID_HANDLE_TYPE. +1: chaining. */
static void scr_net_sock_reset_now(ScrNetSocket *s) {
  if (s->fd >= 0) {
    struct linger l;
    l.l_onoff = 1;
    l.l_linger = 0;
    setsockopt(s->fd, SOL_SOCKET, SO_LINGER, (const void *)&l, sizeof l);
  }
  scr_net_sock_destroy(s);
}

static void scr_net_sock_reset_on_connect(ScrClosure *self) {
  ScrNetSocket *s = scr_box_get_ref(self->caps[0]);
  scr_net_sock_reset_now(s);
  scr_net_sock_release(s);
}

ScrNetSocket *scr_net_sock_reset_and_destroy(ScrNetSocket *s) {
  if (scr_net_sock_destroyed(s)) return scr_net_sock_retain(s);
  if (s->tops != NULL) {
    static const char msg[] = "This handle type cannot be sent";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_HANDLE_TYPE");
    return scr_net_sock_retain(s);
  }
  if (s->connecting) {
    ScrClosure *cb = scr_closure_new((void *)&scr_net_sock_reset_on_connect, 1);
    cb->caps[0] = scr_box_new_obj(&scr_net_sock_retain_v, &scr_net_sock_release_v, NULL);
    scr_box_set_ref(cb->caps[0], scr_net_sock_retain(s));
    scr_net_ls_add(&s->conn_ls, cb, NULL, true);
  } else {
    scr_net_sock_reset_now(s);
  }
  return scr_net_sock_retain(s);
}


/* ── net.SocketAddress and net.BlockList ──────────────────────────────────
 * Both are native checked-dynamic handles. SocketAddress follows
 * lib/internal/socketaddress.js (the option checks in Node's order, then
 * the address parse, which fails as ERR_INVALID_ADDRESS); BlockList
 * follows lib/internal/blocklist.js over Node's C++ rules: an address
 * matches an address rule when it compares the same, a range when it lies
 * between the ends, and a subnet by prefix. Across families an IPv4
 * address compares as its IPv4-mapped IPv6 form (::ffff:a.b.c.d), as
 * Node's SocketAddress::compare and is_in_network do. */

typedef struct {
  int family;           /* 4 or 6 */
  unsigned char b[16];  /* network order; IPv4 uses the first 4 bytes */
} ScrNetIp;

typedef struct ScrNetSockAddr {
  size_t rc;
  ScrNetIp ip;
  double port;
  double flowlabel;
} ScrNetSockAddr;

static void *scr_net_sockaddr_retain(void *p) {
  ScrNetSockAddr *a = p;
  a->rc++;
  return a;
}

static void scr_net_sockaddr_release(void *p) {
  ScrNetSockAddr *a = p;
  if (a != NULL && --a->rc == 0) free(a);
}

static void scr_net_addr_install(void);

/* uv_ip4_addr / uv_ip6_addr: the IPv6 form may carry a %scope, which the
 * address keeps out of its text, as uv_ip6_name prints it. */
static bool scr_net_ip_parse(const ScrStr *text, int family, ScrNetIp *out) {
  char buf[INET6_ADDRSTRLEN + 64];
  if (text->len >= sizeof buf || memchr(text->data, '\0', text->len) != NULL) return false;
  memcpy(buf, text->data, text->len);
  buf[text->len] = '\0';
  memset(out, 0, sizeof *out);
  out->family = family;
  if (family == 4) return inet_pton(AF_INET, buf, out->b) == 1;
  char *pct = strchr(buf, '%');
  if (pct != NULL) *pct = '\0';
  return inet_pton(AF_INET6, buf, out->b) == 1;
}

static ScrStr *scr_net_ip_text(const ScrNetIp *ip) {
  char buf[INET6_ADDRSTRLEN];
  if (!inet_ntop(ip->family == 4 ? AF_INET : AF_INET6, ip->b, buf, sizeof buf)) buf[0] = '\0';
  return scr_str_new(buf, strlen(buf));
}

static ScrDyn *scr_net_sockaddr_box(const ScrNetIp *ip, double port, double flowlabel) {
  scr_net_addr_install();
  ScrNetSockAddr *a = malloc(sizeof *a);
  if (!a) scr_net_oom();
  a->rc = 1;
  a->ip = *ip;
  a->port = port;
  a->flowlabel = flowlabel;
  ScrDyn *box = scr_dyn_new_handle(a, SCR_DYNH_NET_SOCKET_ADDRESS);
  scr_net_sockaddr_release(a);
  return box;
}

static const ScrNetSockAddr *scr_net_sockaddr_of(const ScrDyn *v) {
  if (v == NULL || v->kind != SCR_DYN_HANDLE || v->v.handle.tag != SCR_DYNH_NET_SOCKET_ADDRESS) return NULL;
  return (const ScrNetSockAddr *)v->v.handle.ptr;
}

static ScrDyn *scr_net_dyn_str(const char *s) {
  ScrStr *str = scr_str_new(s, strlen(s));
  ScrDyn *d = scr_dyn_new_str(str);
  scr_str_release(str);
  return d;
}

/* { address, port, family, flowlabel }: toJSON() and the inspect view. */
static ScrDyn *scr_net_sockaddr_detail(const ScrNetSockAddr *a) {
  ScrDyn *out = scr_dyn_new_obj();
  ScrStr *text = scr_net_ip_text(&a->ip);
  scr_dyn_obj_set(out, "address", 7, scr_dyn_new_str(text));
  scr_str_release(text);
  scr_dyn_obj_set(out, "port", 4, scr_dyn_new_num(a->port));
  scr_dyn_obj_set(out, "family", 6, scr_net_dyn_str(a->ip.family == 4 ? "ipv4" : "ipv6"));
  scr_dyn_obj_set(out, "flowlabel", 9, scr_dyn_new_num(a->flowlabel));
  return out;
}

/* The inspect text of a SocketAddress, as ERR_INVALID_ARG_VALUE's
 * "Received" renders it. */
static int scr_net_sockaddr_inspect_text(const ScrNetSockAddr *a, char *out, size_t cap) {
  char ip[INET6_ADDRSTRLEN];
  if (!inet_ntop(a->ip.family == 4 ? AF_INET : AF_INET6, a->ip.b, ip, sizeof ip)) ip[0] = '\0';
  char port[48], flow[48];
  scr_num_received(a->port, port);
  scr_num_received(a->flowlabel, flow);
  return snprintf(out, cap, "SocketAddress { address: '%s', port: %s, family: '%s', flowlabel: %s }", ip,
                  port, a->ip.family == 4 ? "ipv4" : "ipv6", flow);
}

static bool scr_net_is_plain_object(const ScrDyn *v) {
  return v->kind == SCR_DYN_OBJ;
}

/* ERR_OUT_OF_RANGE: The value of "<name>" is out of range. It must be <range>. Received <n> */
static void scr_net_out_of_range(const char *name, const char *range, double got) {
  char rec[48], msg[256];
  scr_num_received(got, rec);
  int n = snprintf(msg, sizeof msg, "The value of \"%s\" is out of range. It must be %s. Received %s", name,
                   range, rec);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, n < 0 ? 0 : (size_t)n, "ERR_OUT_OF_RANGE");
}

static void scr_net_invalid_address(void) {
  static const char msg[] = "Invalid socket address";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_INVALID_ADDRESS");
}

/* new SocketAddress(options): validateObject, the destructuring defaults
 * (the address default reads the family as given), the family switch
 * after toLowerCase(), validateString(address), validatePort(port) and
 * validateUint32(flowlabel), then the address parse. NULL with the
 * exception pending on failure. */
static ScrDyn *scr_net_sockaddr_from_options(const ScrDyn *options) {
  if (options == NULL || options->kind == SCR_DYN_UNDEF) options = NULL;
  else if (!scr_net_is_plain_object(options)) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  const ScrDyn *family = options ? scr_dyn_obj_get(options, "family", 6) : NULL;
  const ScrDyn *address = options ? scr_dyn_obj_get(options, "address", 7) : NULL;
  const ScrDyn *port = options ? scr_dyn_obj_get(options, "port", 4) : NULL;
  const ScrDyn *flowlabel = options ? scr_dyn_obj_get(options, "flowlabel", 9) : NULL;
  if (family != NULL && family->kind == SCR_DYN_UNDEF) family = NULL;
  if (address != NULL && address->kind == SCR_DYN_UNDEF) address = NULL;
  if (port != NULL && port->kind == SCR_DYN_UNDEF) port = NULL;
  if (flowlabel != NULL && flowlabel->kind == SCR_DYN_UNDEF) flowlabel = NULL;
  bool raw_ipv4 = family == NULL ||
                  (family->kind == SCR_DYN_STR && family->v.str->len == 4 &&
                   memcmp(family->v.str->data, "ipv4", 4) == 0);
  int fam = 0;
  if (family == NULL) {
    fam = 4;
  } else if (family->kind == SCR_DYN_STR && family->v.str->len == 4) {
    char lower[4];
    for (size_t i = 0; i < 4; i++) {
      unsigned char c = (unsigned char)family->v.str->data[i];
      lower[i] = (char)(c >= 'A' && c <= 'Z' ? c + 32 : c);
    }
    if (memcmp(lower, "ipv4", 4) == 0) fam = 4;
    else if (memcmp(lower, "ipv6", 4) == 0) fam = 6;
  }
  if (fam == 0) {
    scr_dyn_arg_value_fail("options.family", NULL, family);
    return NULL;
  }
  if (address != NULL && address->kind != SCR_DYN_STR) {
    scr_dyn_prop_type_fail("options.address", "of type string", address);
    return NULL;
  }
  double port_num = 0;
  if (port != NULL) {
    bool ok = false;
    if (port->kind == SCR_DYN_NUM) {
      port_num = port->v.num;
      ok = true;
    } else if (port->kind == SCR_DYN_STR) {
      ScrStr *ps = scr_str_retain(port->v.str);
      ScrStr *trimmed = scr_str_trim(ps);
      ok = trimmed->len > 0;
      scr_str_release(trimmed);
      port_num = scr_string_to_number(ps);
      scr_str_release(ps);
    }
    ok = ok && port_num == port_num && port_num >= 0 && port_num <= 4294967295.0 &&
         trunc(port_num) == port_num && port_num <= 65535;
    if (!ok) {
      char detail[64], msg[160];
      const char *d = scr_dyn_specific_type(port, detail, sizeof detail);
      int n = snprintf(msg, sizeof msg, "options.port should be >= 0 and < 65536. Received %s.", d);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, n < 0 ? 0 : (size_t)n, "ERR_SOCKET_BAD_PORT");
      return NULL;
    }
  }
  double flow = 0;
  if (flowlabel != NULL) {
    if (flowlabel->kind != SCR_DYN_NUM) {
      scr_dyn_prop_type_fail("options.flowlabel", "of type number", flowlabel);
      return NULL;
    }
    flow = flowlabel->v.num;
    if (!(isfinite(flow) && trunc(flow) == flow)) {
      scr_net_out_of_range("options.flowlabel", "an integer", flow);
      return NULL;
    }
    if (flow < 0 || flow > 4294967295.0) {
      scr_net_out_of_range("options.flowlabel", ">= 0 && <= 4294967295", flow);
      return NULL;
    }
  }
  ScrNetIp ip;
  bool parsed;
  if (address != NULL) {
    parsed = scr_net_ip_parse(address->v.str, fam, &ip);
  } else {
    ScrStr *def = raw_ipv4 ? scr_str_new("127.0.0.1", 9) : scr_str_new("::", 2);
    parsed = scr_net_ip_parse(def, fam, &ip);
    scr_str_release(def);
  }
  if (!parsed) {
    scr_net_invalid_address();
    return NULL;
  }
  /* `port | 0` and `flowlabel | 0` (the binding reads the flow label
   * back as unsigned) */
  return scr_net_sockaddr_box(&ip, (double)(int32_t)(uint32_t)port_num, flow);
}

/* new net.SocketAddress([options]) — args is the argument array. +1. */
ScrDyn *scr_net_socket_address_new(const ScrDyn *args) {
  const ScrDyn *options =
      args->kind == SCR_DYN_ARR && args->v.arr.len > 0 && scr_dyn_arr_has_index(args, 0) ? args->v.arr.items[0] : NULL;
  ScrDyn *out = scr_net_sockaddr_from_options(options);
  return out != NULL ? out : scr_dyn_retain(scr_dyn_undefined());
}

/* SocketAddress.parse(input): URL.parse(`http://${input}`)'s hostname and
 * port; a bracketed hostname is an IPv6 address. Any failure answers
 * undefined. +1. */
ScrDyn *scr_net_socket_address_parse(const ScrDyn *input) {
  if (input->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("input", "of type string", input);
    return NULL;
  }
  ScrStr *prefix = scr_str_new("http://", 7);
  ScrStr *url_text = scr_str_concat(prefix, input->v.str);
  scr_str_release(prefix);
  ScrDyn *result = NULL;
  if (scr_url_can_parse(url_text)) {
    ScrUrl *url = scr_url_new(url_text);
    ScrStr *host = scr_url_hostname(url);
    ScrStr *port = scr_url_port(url);
    double port_num = port->len > 0 ? scr_string_to_number(port) : 0;
    ScrDyn *options = scr_dyn_new_obj();
    bool v6 = host->len >= 2 && host->data[0] == '[' && host->data[host->len - 1] == ']';
    ScrStr *addr = v6 ? scr_str_new(host->data + 1, host->len - 2) : scr_str_retain(host);
    scr_dyn_obj_set(options, "address", 7, scr_dyn_new_str(addr));
    scr_str_release(addr);
    scr_dyn_obj_set(options, "port", 4, scr_dyn_new_num((double)(int32_t)(uint32_t)port_num));
    if (v6) scr_dyn_obj_set(options, "family", 6, scr_net_dyn_str("ipv6"));
    result = scr_net_sockaddr_from_options(options);
    if (result == NULL) scr_exc_clear();
    scr_dyn_release(options);
    scr_str_release(port);
    scr_str_release(host);
    scr_url_release(url);
  }
  scr_str_release(url_text);
  return result != NULL ? result : scr_dyn_retain(scr_dyn_undefined());
}

bool scr_net_is_socket_address(const ScrDyn *v) { return scr_net_sockaddr_of(v) != NULL; }

static ScrDyn *scr_net_sockaddr_get(void *h, const char *key, size_t len) {
  const ScrNetSockAddr *a = h;
  if (len == 7 && memcmp(key, "address", 7) == 0) {
    ScrStr *text = scr_net_ip_text(&a->ip);
    ScrDyn *d = scr_dyn_new_str(text);
    scr_str_release(text);
    return d;
  }
  if (len == 4 && memcmp(key, "port", 4) == 0) return scr_dyn_new_num(a->port);
  if (len == 6 && memcmp(key, "family", 6) == 0) return scr_net_dyn_str(a->ip.family == 4 ? "ipv4" : "ipv6");
  if (len == 9 && memcmp(key, "flowlabel", 9) == 0) return scr_dyn_new_num(a->flowlabel);
  return NULL;
}

/* The getters have no setters (strict-mode TypeError). */
static bool scr_net_getter_only_set(const char *cls, const char *const *names, const char *key, size_t len) {
  for (size_t i = 0; names[i] != NULL; i++) {
    if (strlen(names[i]) == len && memcmp(names[i], key, len) == 0) {
      char msg[160];
      int n = snprintf(msg, sizeof msg, "Cannot set property %.*s of #<%s> which has only a getter", (int)len,
                       key, cls);
      scr_throw_error_msg(SCR_ERR_TYPE, msg, n < 0 ? 0 : (size_t)n);
      return true;
    }
  }
  return false;
}

static bool scr_net_sockaddr_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)value;
  static const char *const names[] = { "address", "port", "family", "flowlabel", NULL };
  return scr_net_getter_only_set("SocketAddress", names, key, len);
}

static void scr_net_not_a_function(const char *what) {
  char msg[160];
  int n = snprintf(msg, sizeof msg, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, n < 0 ? 0 : (size_t)n);
}

static ScrDyn *scr_net_sockaddr_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                       size_t argc, const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  if (strcmp(method, "toJSON") == 0) return scr_net_sockaddr_detail((const ScrNetSockAddr *)h);
  scr_net_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_net_sockaddr_inspect_view(void *h) {
  return scr_net_sockaddr_detail((const ScrNetSockAddr *)h);
}

static const unsigned char scr_net_v4_mapped[12] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff };

/* SocketAddress::compare: -1, 0 or 1, or 2 when the two cannot compare
 * (an IPv6 address that is not IPv4-mapped against an IPv4 one). */
static int scr_net_ip_compare(const ScrNetIp *a, const ScrNetIp *b) {
  if (a->family == b->family) {
    int c = memcmp(a->b, b->b, a->family == 4 ? 4 : 16);
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  }
  const ScrNetIp *v4 = a->family == 4 ? a : b;
  const ScrNetIp *v6 = a->family == 4 ? b : a;
  if (memcmp(v6->b, scr_net_v4_mapped, 12) != 0) return 2;
  int c = memcmp(v4->b, v6->b + 12, 4);
  c = c < 0 ? -1 : c > 0 ? 1 : 0;
  return a->family == 4 ? c : -c;
}

static bool scr_net_prefix_match(const unsigned char *a, const unsigned char *net, int prefix) {
  int full = prefix / 8, rest = prefix % 8;
  if (memcmp(a, net, (size_t)full) != 0) return false;
  if (rest == 0) return true;
  unsigned char mask = (unsigned char)(0xff << (8 - rest));
  return (a[full] & mask) == (net[full] & mask);
}

/* SocketAddress::is_in_network. */
static bool scr_net_ip_in_subnet(const ScrNetIp *a, const ScrNetIp *net, int prefix) {
  if (a->family == net->family) return scr_net_prefix_match(a->b, net->b, prefix);
  if (prefix == 0) return true;
  if (a->family == 4) {
    if (prefix > 128) return false;
    unsigned char mapped[16];
    memcpy(mapped, scr_net_v4_mapped, 12);
    memcpy(mapped + 12, a->b, 4);
    return scr_net_prefix_match(mapped, net->b, prefix);
  }
  if (prefix > 32 || memcmp(a->b, scr_net_v4_mapped, 12) != 0) return false;
  return scr_net_prefix_match(a->b + 12, net->b, prefix);
}

enum { SCR_NET_RULE_ADDRESS, SCR_NET_RULE_SUBNET, SCR_NET_RULE_RANGE };

typedef struct {
  int kind;
  ScrNetIp a; /* the address, the subnet's network or the range start */
  ScrNetIp b; /* the range end */
  int prefix;
  size_t seq;
} ScrNetBlockRule;

typedef struct ScrNetBlockList {
  size_t rc;
  ScrNetBlockRule *rules;
  size_t n, cap, seq;
} ScrNetBlockList;

static void *scr_net_blocklist_retain(void *p) {
  ScrNetBlockList *l = p;
  l->rc++;
  return l;
}

static void scr_net_blocklist_release(void *p) {
  ScrNetBlockList *l = p;
  if (l == NULL || --l->rc != 0) return;
  free(l->rules);
  free(l);
}

ScrDyn *scr_net_block_list_new(const ScrDyn *args) {
  (void)args;
  scr_net_addr_install();
  ScrNetBlockList *l = calloc(1, sizeof *l);
  if (!l) scr_net_oom();
  l->rc = 1;
  ScrDyn *box = scr_dyn_new_handle(l, SCR_DYNH_NET_BLOCK_LIST);
  scr_net_blocklist_release(l);
  return box;
}

bool scr_net_is_block_list(const ScrDyn *v) {
  return v != NULL && v->kind == SCR_DYN_HANDLE && v->v.handle.tag == SCR_DYNH_NET_BLOCK_LIST;
}

static void scr_net_blocklist_push(ScrNetBlockList *l, const ScrNetBlockRule *rule) {
  if (l->n == l->cap) {
    l->cap = l->cap ? l->cap * 2 : 8;
    l->rules = realloc(l->rules, l->cap * sizeof *l->rules);
    if (!l->rules) scr_net_oom();
  }
  l->rules[l->n] = *rule;
  l->rules[l->n].seq = l->seq++;
  l->n++;
}

/* Node lists IPv4 address rules, then IPv6 ones, then subnets, then
 * ranges, each group newest first. */
static int scr_net_rule_group(const ScrNetBlockRule *r) {
  if (r->kind == SCR_NET_RULE_ADDRESS) return r->a.family == 4 ? 0 : 1;
  return r->kind == SCR_NET_RULE_SUBNET ? 2 : 3;
}

static int scr_net_rule_order(const void *x, const void *y) {
  const ScrNetBlockRule *a = *(const ScrNetBlockRule *const *)x;
  const ScrNetBlockRule *b = *(const ScrNetBlockRule *const *)y;
  int ga = scr_net_rule_group(a), gb = scr_net_rule_group(b);
  if (ga != gb) return ga < gb ? -1 : 1;
  return a->seq > b->seq ? -1 : a->seq < b->seq ? 1 : 0;
}

static ScrStr *scr_net_rule_text(const ScrNetBlockRule *r) {
  char a[INET6_ADDRSTRLEN], b[INET6_ADDRSTRLEN], out[160];
  if (!inet_ntop(r->a.family == 4 ? AF_INET : AF_INET6, r->a.b, a, sizeof a)) a[0] = '\0';
  const char *fam = r->a.family == 4 ? "IPv4" : "IPv6";
  int n;
  if (r->kind == SCR_NET_RULE_ADDRESS) {
    n = snprintf(out, sizeof out, "Address: %s %s", fam, a);
  } else if (r->kind == SCR_NET_RULE_SUBNET) {
    n = snprintf(out, sizeof out, "Subnet: %s %s/%d", fam, a, r->prefix);
  } else {
    if (!inet_ntop(r->b.family == 4 ? AF_INET : AF_INET6, r->b.b, b, sizeof b)) b[0] = '\0';
    n = snprintf(out, sizeof out, "Range: %s %s-%s", fam, a, b);
  }
  return scr_str_new(out, n < 0 ? 0 : (size_t)n);
}

static ScrDyn *scr_net_blocklist_rules(const ScrNetBlockList *l) {
  ScrDyn *out = scr_dyn_new_arr();
  if (l->n == 0) return out;
  const ScrNetBlockRule **order = malloc(l->n * sizeof *order);
  if (!order) scr_net_oom();
  for (size_t i = 0; i < l->n; i++) order[i] = &l->rules[i];
  qsort(order, l->n, sizeof *order, scr_net_rule_order);
  for (size_t i = 0; i < l->n; i++) {
    ScrStr *text = scr_net_rule_text(order[i]);
    scr_dyn_arr_push(out, scr_dyn_new_str(text));
    scr_str_release(text);
  }
  free(order);
  return out;
}

static bool scr_net_blocklist_check_ip(const ScrNetBlockList *l, const ScrNetIp *ip) {
  for (size_t i = 0; i < l->n; i++) {
    const ScrNetBlockRule *r = &l->rules[i];
    if (r->kind == SCR_NET_RULE_ADDRESS && scr_net_ip_compare(ip, &r->a) == 0) return true;
    if (r->kind == SCR_NET_RULE_SUBNET && scr_net_ip_in_subnet(ip, &r->a, r->prefix)) return true;
    if (r->kind == SCR_NET_RULE_RANGE) {
      int lo = scr_net_ip_compare(ip, &r->a), hi = scr_net_ip_compare(ip, &r->b);
      if ((lo == 0 || lo == 1) && (hi == 0 || hi == -1)) return true;
    }
  }
  return false;
}

static void scr_net_blocklist_remove(ScrNetBlockList *l, const ScrNetBlockRule *rule);
static bool scr_net_blocklist_has_address(const ScrNetBlockList *l, const ScrNetIp *ip);
static bool scr_net_subnet_prefix(const ScrDyn *prefix, int family, int *out);
static bool scr_net_parse_cidr(const ScrDyn *cidr, ScrDyn **address, double *prefix, const char **family);

/* The `family` argument: validateString, then the SocketAddress family
 * switch. */
static const ScrDyn *scr_net_family_arg(ScrDyn *const *args, size_t argc, size_t i) {
  if (i < argc && args[i]->kind != SCR_DYN_UNDEF) return args[i];
  return NULL;
}

/* A rule's address argument: a SocketAddress as is, or validateString
 * and `new SocketAddress({ address, family })`. false with the exception
 * pending. */
static bool scr_net_rule_address(ScrDyn *const *args, size_t argc, size_t i, const char *name,
                                 const ScrDyn *family, ScrNetIp *out, const ScrNetSockAddr **sa) {
  const ScrDyn *v = i < argc ? args[i] : scr_dyn_undefined();
  const ScrNetSockAddr *given = scr_net_sockaddr_of(v);
  if (given != NULL) {
    *out = given->ip;
    if (sa != NULL) *sa = given;
    return true;
  }
  if (v->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail(name, "of type string", v);
    return false;
  }
  if (family != NULL && family->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("family", "of type string", family);
    return false;
  }
  ScrDyn *options = scr_dyn_new_obj();
  scr_dyn_obj_set(options, "address", 7, scr_dyn_retain((ScrDyn *)v));
  if (family != NULL) scr_dyn_obj_set(options, "family", 6, scr_dyn_retain((ScrDyn *)family));
  ScrDyn *made = scr_net_sockaddr_from_options(options);
  scr_dyn_release(options);
  if (made == NULL) return false;
  *out = scr_net_sockaddr_of(made)->ip;
  scr_dyn_release(made);
  if (sa != NULL) *sa = NULL;
  return true;
}

static void scr_net_blocklist_add_address(ScrNetBlockList *l, ScrDyn *const *args, size_t argc,
                                          bool remove) {
  ScrNetBlockRule rule = { .kind = SCR_NET_RULE_ADDRESS };
  if (!scr_net_rule_address(args, argc, 0, "address", scr_net_family_arg(args, argc, 1), &rule.a, NULL))
    return;
  if (remove) {
    scr_net_blocklist_remove(l, &rule);
    return;
  }
  if (scr_net_blocklist_has_address(l, &rule.a)) return; /* already listed: the rule keeps its place */
  scr_net_blocklist_push(l, &rule);
}

static void scr_net_blocklist_add_range(ScrNetBlockList *l, ScrDyn *const *args, size_t argc,
                                        bool remove) {
  ScrNetBlockRule rule = { .kind = SCR_NET_RULE_RANGE };
  const ScrDyn *family = scr_net_family_arg(args, argc, 2);
  const ScrNetSockAddr *start_sa = NULL;
  if (!scr_net_rule_address(args, argc, 0, "start", family, &rule.a, &start_sa)) return;
  if (!scr_net_rule_address(args, argc, 1, "end", family, &rule.b, NULL)) return;
  if (remove) {
    scr_net_blocklist_remove(l, &rule);
    return;
  }
  if (scr_net_ip_compare(&rule.a, &rule.b) == 1) {
    /* ERR_INVALID_ARG_VALUE('start', start, 'must come before end'),
     * with `start` the SocketAddress the call built or was given */
    ScrNetSockAddr shown = { .rc = 1, .ip = rule.a, .port = 0, .flowlabel = 0 };
    if (start_sa != NULL) shown = *start_sa;
    char insp[192], msg[320];
    scr_net_sockaddr_inspect_text(&shown, insp, sizeof insp);
    int n = snprintf(msg, sizeof msg, "The argument 'start' must come before end. Received %s", insp);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, n < 0 ? 0 : (size_t)n, "ERR_INVALID_ARG_VALUE");
    return;
  }
  scr_net_blocklist_push(l, &rule);
}

static void scr_net_blocklist_subnet(ScrNetBlockList *l, ScrDyn *const *args, size_t argc, bool remove) {
  ScrNetBlockRule rule = { .kind = SCR_NET_RULE_SUBNET };
  if (!scr_net_rule_address(args, argc, 0, "network", scr_net_family_arg(args, argc, 2), &rule.a, NULL))
    return;
  if (!scr_net_subnet_prefix(1 < argc ? args[1] : scr_dyn_undefined(), rule.a.family, &rule.prefix)) return;
  if (remove) scr_net_blocklist_remove(l, &rule);
  else scr_net_blocklist_push(l, &rule);
}

/* addCIDR / removeCIDR: parseCIDR, then addSubnet(address, prefix, family). */
static void scr_net_blocklist_cidr(ScrNetBlockList *l, const ScrDyn *cidr, bool remove) {
  ScrDyn *address = NULL;
  double prefix = 0;
  const char *family = NULL;
  if (!scr_net_parse_cidr(cidr, &address, &prefix, &family)) return;
  ScrDyn *sub[3] = { address, scr_dyn_new_num(prefix), scr_net_dyn_str(family) };
  scr_net_blocklist_subnet(l, sub, 3, remove);
  for (size_t i = 0; i < 3; i++) scr_dyn_release(sub[i]);
}

/* addAddresses(addresses[, family]) and addCIDRs(cidrs): every entry is
 * validated and parsed before any rule is added. */
static void scr_net_blocklist_add_addresses(ScrNetBlockList *l, ScrDyn *const *args, size_t argc) {
  const ScrDyn *list = argc > 0 ? args[0] : scr_dyn_undefined();
  if (list->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("addresses", "an instance of Array", list);
    return;
  }
  const ScrDyn *family = scr_net_family_arg(args, argc, 1);
  if (family != NULL && family->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("family", "of type string", family);
    return;
  }
  size_t n = list->v.arr.len;
  ScrNetIp *ips = malloc((n ? n : 1) * sizeof *ips);
  if (!ips) scr_net_oom();
  for (size_t i = 0; i < n; i++) {
    ScrDyn *item = scr_dyn_arr_has_index(list, i) ? list->v.arr.items[i] : (ScrDyn *)scr_dyn_undefined();
    if (scr_net_sockaddr_of(item) == NULL && item->kind != SCR_DYN_STR) {
      char name[48];
      snprintf(name, sizeof name, "addresses[%zu]", i);
      scr_dyn_arg_type_fail(name, "of type string", item);
      free(ips);
      return;
    }
    ScrDyn *one[2] = { item, (ScrDyn *)(family != NULL ? family : scr_dyn_undefined()) };
    if (!scr_net_rule_address(one, 2, 0, "address", family, &ips[i], NULL)) {
      free(ips);
      return;
    }
  }
  for (size_t i = 0; i < n; i++) {
    if (scr_net_blocklist_has_address(l, &ips[i])) continue;
    ScrNetBlockRule rule = { .kind = SCR_NET_RULE_ADDRESS, .a = ips[i] };
    scr_net_blocklist_push(l, &rule);
  }
  free(ips);
}

static void scr_net_blocklist_add_cidrs(ScrNetBlockList *l, ScrDyn *const *args, size_t argc) {
  const ScrDyn *list = argc > 0 ? args[0] : scr_dyn_undefined();
  if (list->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("cidrs", "an instance of Array", list);
    return;
  }
  size_t n = list->v.arr.len;
  for (size_t i = 0; i < n; i++) {
    const ScrDyn *item = scr_dyn_arr_has_index(list, i) ? list->v.arr.items[i] : scr_dyn_undefined();
    if (item->kind != SCR_DYN_STR) {
      char name[48];
      snprintf(name, sizeof name, "cidrs[%zu]", i);
      scr_dyn_arg_type_fail(name, "of type string", item);
      return;
    }
    ScrDyn *address = NULL;
    double prefix = 0;
    const char *family = NULL;
    if (!scr_net_parse_cidr(item, &address, &prefix, &family)) return;
    scr_dyn_release(address);
  }
  for (size_t i = 0; i < n && !scr_exc_pending(); i++) scr_net_blocklist_cidr(l, list->v.arr.items[i], false);
}

/* check(address[, family]): a SocketAddress applies as is; a string is
 * parsed with inet_pton in the family's form (any family other than
 * "ipv4", in any case, means IPv6), and one that does not parse answers
 * false, as Node's checkString does. */
static ScrDyn *scr_net_blocklist_check(const ScrNetBlockList *l, ScrDyn *const *args, size_t argc) {
  const ScrDyn *v = argc > 0 ? args[0] : scr_dyn_undefined();
  const ScrNetSockAddr *given = scr_net_sockaddr_of(v);
  if (given != NULL) return scr_dyn_new_bool(scr_net_blocklist_check_ip(l, &given->ip));
  const ScrDyn *family = scr_net_family_arg(args, argc, 1);
  if (v->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("address", "of type string", v);
    return NULL;
  }
  if (family != NULL && family->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("family", "of type string", family);
    return NULL;
  }
  bool v4 = family == NULL;
  if (family != NULL && family->v.str->len == 4) {
    char lower[4];
    for (size_t i = 0; i < 4; i++) {
      unsigned char c = (unsigned char)family->v.str->data[i];
      lower[i] = (char)(c >= 'A' && c <= 'Z' ? c + 32 : c);
    }
    v4 = memcmp(lower, "ipv4", 4) == 0;
  }
  char buf[INET6_ADDRSTRLEN + 8];
  const ScrStr *text = v->v.str;
  if (text->len >= sizeof buf || memchr(text->data, '\0', text->len) != NULL) return scr_dyn_new_bool(false);
  memcpy(buf, text->data, text->len);
  buf[text->len] = '\0';
  ScrNetIp ip;
  memset(&ip, 0, sizeof ip);
  ip.family = v4 ? 4 : 6;
  if (inet_pton(v4 ? AF_INET : AF_INET6, buf, ip.b) != 1) return scr_dyn_new_bool(false);
  return scr_dyn_new_bool(scr_net_blocklist_check_ip(l, &ip));
}

/* The remove* calls drop every rule equal to the one given. */
static void scr_net_blocklist_remove(ScrNetBlockList *l, const ScrNetBlockRule *rule) {
  size_t w = 0;
  for (size_t i = 0; i < l->n; i++) {
    const ScrNetBlockRule *r = &l->rules[i];
    bool same = r->kind == rule->kind && r->a.family == rule->a.family &&
                memcmp(r->a.b, rule->a.b, 16) == 0 &&
                (rule->kind != SCR_NET_RULE_SUBNET || r->prefix == rule->prefix) &&
                (rule->kind != SCR_NET_RULE_RANGE ||
                 (r->b.family == rule->b.family && memcmp(r->b.b, rule->b.b, 16) == 0));
    if (!same) l->rules[w++] = *r;
  }
  l->n = w;
}

static bool scr_net_blocklist_has_address(const ScrNetBlockList *l, const ScrNetIp *ip) {
  for (size_t i = 0; i < l->n; i++) {
    const ScrNetBlockRule *r = &l->rules[i];
    if (r->kind == SCR_NET_RULE_ADDRESS && r->a.family == ip->family && memcmp(r->a.b, ip->b, 16) == 0)
      return true;
  }
  return false;
}

/* validateInt32(prefix, 'prefix', 0, max) for the network's family. */
static bool scr_net_subnet_prefix(const ScrDyn *prefix, int family, int *out) {
  if (prefix->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("prefix", "of type number", prefix);
    return false;
  }
  double p = prefix->v.num;
  if (!(isfinite(p) && trunc(p) == p)) {
    scr_net_out_of_range("prefix", "an integer", p);
    return false;
  }
  if (p < 0 || p > (family == 4 ? 32 : 128)) {
    scr_net_out_of_range("prefix", family == 4 ? ">= 0 && <= 32" : ">= 0 && <= 128", p);
    return false;
  }
  *out = (int)p;
  return true;
}

/* parseCIDR(cidr): the text before the last '/', and a prefix that reads
 * back as the same decimal integer; a ':' makes it IPv6. */
static bool scr_net_parse_cidr(const ScrDyn *cidr, ScrDyn **address, double *prefix, const char **family) {
  if (cidr->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("cidr", "of type string", cidr);
    return false;
  }
  const ScrStr *text = cidr->v.str;
  size_t slash = text->len;
  for (size_t i = text->len; i > 0; i--) {
    if (text->data[i - 1] == '/') {
      slash = i - 1;
      break;
    }
  }
  if (slash == text->len) {
    scr_dyn_arg_value_fail("cidr", "must contain a prefix length (e.g. \"10.0.0.0/8\")", cidr);
    return false;
  }
  const char *digits = text->data + slash + 1;
  size_t ndigits = text->len - slash - 1;
  /* NumberParseInt(prefixStr, 10) and `${prefix}` === prefixStr: an
   * optional '-' and decimal digits with no leading zero (except "0") */
  bool neg = ndigits > 0 && digits[0] == '-';
  size_t start = neg ? 1 : 0;
  bool ok = ndigits > start && ndigits - start <= 9;
  for (size_t i = start; ok && i < ndigits; i++) ok = digits[i] >= '0' && digits[i] <= '9';
  if (ok && ndigits - start > 1 && digits[start] == '0') ok = false;
  if (ok && neg && ndigits - start == 1 && digits[start] == '0') ok = false; /* "-0" reads back as "0" */
  if (!ok) {
    scr_dyn_arg_value_fail("cidr", "prefix length must be a valid integer", cidr);
    return false;
  }
  double value = 0;
  for (size_t i = start; i < ndigits; i++) value = value * 10 + (digits[i] - '0');
  *prefix = neg ? -value : value;
  ScrStr *addr = scr_str_new(text->data, slash);
  *family = memchr(addr->data, ':', addr->len) != NULL ? "ipv6" : "ipv4";
  *address = scr_dyn_new_str(addr);
  scr_str_release(addr);
  return true;
}

/* fromJSON(data): a JSON string or an array of rule strings, each added
 * with addSubnet, addAddress or addRange; other strings are ignored. */
static void scr_net_blocklist_from_json(ScrNetBlockList *l, ScrDyn *const *args, size_t argc);

static ScrDyn *scr_net_blocklist_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                        size_t argc, const char *what) {
  (void)self;
  ScrNetBlockList *l = h;
  const ScrDyn *first = argc > 0 ? args[0] : scr_dyn_undefined();
  if (strcmp(method, "addAddress") == 0) scr_net_blocklist_add_address(l, args, argc, false);
  else if (strcmp(method, "addAddresses") == 0) scr_net_blocklist_add_addresses(l, args, argc);
  else if (strcmp(method, "addRange") == 0) scr_net_blocklist_add_range(l, args, argc, false);
  else if (strcmp(method, "addSubnet") == 0) scr_net_blocklist_subnet(l, args, argc, false);
  else if (strcmp(method, "addCIDR") == 0) scr_net_blocklist_cidr(l, first, false);
  else if (strcmp(method, "addCIDRs") == 0) scr_net_blocklist_add_cidrs(l, args, argc);
  else if (strcmp(method, "removeAddress") == 0) scr_net_blocklist_add_address(l, args, argc, true);
  else if (strcmp(method, "removeRange") == 0) scr_net_blocklist_add_range(l, args, argc, true);
  else if (strcmp(method, "removeSubnet") == 0) scr_net_blocklist_subnet(l, args, argc, true);
  else if (strcmp(method, "removeCIDR") == 0) scr_net_blocklist_cidr(l, first, true);
  else if (strcmp(method, "clear") == 0) l->n = 0;
  else if (strcmp(method, "check") == 0) return scr_net_blocklist_check(l, args, argc);
  else if (strcmp(method, "toJSON") == 0) return scr_net_blocklist_rules(l);
  else if (strcmp(method, "fromJSON") == 0) scr_net_blocklist_from_json(l, args, argc);
  else {
    scr_net_not_a_function(what);
    return NULL;
  }
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_net_blocklist_get(void *h, const char *key, size_t len) {
  if (len == 5 && memcmp(key, "rules", 5) == 0) return scr_net_blocklist_rules((const ScrNetBlockList *)h);
  if (len == 4 && memcmp(key, "size", 4) == 0) return scr_dyn_new_num((double)((const ScrNetBlockList *)h)->n);
  return NULL;
}

static bool scr_net_blocklist_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)value;
  static const char *const names[] = { "rules", "size", NULL };
  return scr_net_getter_only_set("BlockList", names, key, len);
}

static ScrDyn *scr_net_blocklist_inspect_view(void *h) {
  ScrDyn *out = scr_dyn_new_obj();
  scr_dyn_obj_set(out, "rules", 5, scr_net_blocklist_rules((const ScrNetBlockList *)h));
  return out;
}

static const ScrDynHandleOps scr_net_sockaddr_ops = {
    .cls = "SocketAddress",
    .retain = scr_net_sockaddr_retain,
    .release = scr_net_sockaddr_release,
    .invoke = scr_net_sockaddr_invoke,
    .get = scr_net_sockaddr_get,
    .set = scr_net_sockaddr_set,
    .inspect_view = scr_net_sockaddr_inspect_view,
};

static const ScrDynHandleOps scr_net_blocklist_ops = {
    .cls = "BlockList",
    .retain = scr_net_blocklist_retain,
    .release = scr_net_blocklist_release,
    .invoke = scr_net_blocklist_invoke,
    .get = scr_net_blocklist_get,
    .set = scr_net_blocklist_set,
    .inspect_view = scr_net_blocklist_inspect_view,
};

static void scr_net_addr_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_NET_SOCKET_ADDRESS, &scr_net_sockaddr_ops);
  scr_dyn_handle_install(SCR_DYNH_NET_BLOCK_LIST, &scr_net_blocklist_ops);
}

/* The JSON forms of the handles (scr_json.c calls toJSON through invoke). */

/* fromJSON's patterns (lib/internal/blocklist.js #parseIPInfo), matched
 * at the leftmost position as the regular expressions are: a dotted quad
 * of 1-3 digit groups for IPv4, and 1-45 of [0-9a-fA-F:.] for IPv6, whose
 * patterns also ignore case. */
static size_t scr_net_match_quad(const char *s, size_t n) {
  size_t i = 0;
  for (int part = 0; part < 4; part++) {
    if (part > 0) {
      if (i >= n || s[i] != '.') return 0;
      i++;
    }
    size_t d = 0;
    while (i < n && d < 3 && s[i] >= '0' && s[i] <= '9') i++, d++;
    if (d == 0) return 0;
  }
  return i;
}

static size_t scr_net_match_v6(const char *s, size_t n) {
  size_t i = 0;
  while (i < n && i < 45 &&
         ((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f') || (s[i] >= 'A' && s[i] <= 'F') ||
          s[i] == ':' || s[i] == '.'))
    i++;
  return i;
}

static size_t scr_net_match_digits(const char *s, size_t n, size_t max) {
  size_t i = 0;
  while (i < n && i < max && s[i] >= '0' && s[i] <= '9') i++;
  return i;
}

static bool scr_net_lit_at(const char *s, size_t n, const char *lit, bool fold) {
  size_t m = strlen(lit);
  if (m > n) return false;
  for (size_t i = 0; i < m; i++) {
    unsigned char a = (unsigned char)s[i], b = (unsigned char)lit[i];
    if (fold) {
      if (a >= 'A' && a <= 'Z') a += 32;
      if (b >= 'A' && b <= 'Z') b += 32;
    }
    if (a != b) return false;
  }
  return true;
}

/* One pattern: `<lit><ip>`, `<lit><ip>/<digits>` or `<lit><ip>-<ip>`.
 * Fills the captured spans; false when no position matches. */
typedef struct {
  const char *a;
  size_t alen;
  const char *b;
  size_t blen;
} ScrNetCapture;

static bool scr_net_match_rule(const ScrStr *item, const char *lit, bool v6, char tail, size_t tail_max,
                               ScrNetCapture *cap) {
  const char *s = item->data;
  size_t n = item->len, m = strlen(lit);
  for (size_t at = 0; at + m <= n; at++) {
    if (!scr_net_lit_at(s + at, n - at, lit, v6)) continue;
    size_t i = at + m;
    size_t a = v6 ? scr_net_match_v6(s + i, n - i) : scr_net_match_quad(s + i, n - i);
    if (a == 0) continue;
    cap->a = s + i;
    cap->alen = a;
    if (tail == 0) return true;
    i += a;
    if (i >= n || s[i] != tail) continue;
    i++;
    size_t b = tail == '/' ? scr_net_match_digits(s + i, n - i, tail_max)
               : v6        ? scr_net_match_v6(s + i, n - i)
                           : scr_net_match_quad(s + i, n - i);
    if (b == 0) continue;
    cap->b = s + i;
    cap->blen = b;
    return true;
  }
  return false;
}

static bool scr_net_str_has(const ScrStr *s, const char *needle) {
  size_t m = strlen(needle);
  for (size_t i = 0; i + m <= s->len; i++)
    if (memcmp(s->data + i, needle, m) == 0) return true;
  return false;
}

static ScrDyn *scr_net_span_dyn(const char *p, size_t n) {
  ScrStr *s = scr_str_new(p, n);
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

/* Runs one parsed rule through the add* entry point, as #parseIPInfo
 * calls this.addSubnet / addAddress / addRange. */
static void scr_net_from_json_item(ScrNetBlockList *l, const ScrStr *item) {
  ScrNetCapture c;
  for (int pass = 0; pass < 2; pass++) {
    bool v6 = pass == 1;
    if (!scr_net_str_has(item, v6 ? "IPv6" : "IPv4")) continue;
    ScrDyn *family = scr_net_dyn_str(v6 ? "ipv6" : "ipv4");
    ScrDyn *args[3] = { NULL, NULL, family };
    bool done = true;
    if (scr_net_match_rule(item, v6 ? "Subnet: IPv6 " : "Subnet: IPv4 ", v6, '/', v6 ? 3 : 2, &c)) {
      args[0] = scr_net_span_dyn(c.a, c.alen);
      double prefix = 0;
      for (size_t i = 0; i < c.blen; i++) prefix = prefix * 10 + (c.b[i] - '0');
      args[1] = scr_dyn_new_num(prefix);
      scr_net_blocklist_subnet(l, args, 3, false);
    } else if (scr_net_match_rule(item, v6 ? "Address: IPv6 " : "Address: IPv4 ", v6, 0, 0, &c)) {
      args[0] = scr_net_span_dyn(c.a, c.alen);
      args[1] = family;
      scr_net_blocklist_add_address(l, args, 2, false);
      args[1] = NULL;
    } else if (scr_net_match_rule(item, v6 ? "Range: IPv6 " : "Range: IPv4 ", v6, '-', 0, &c)) {
      args[0] = scr_net_span_dyn(c.a, c.alen);
      args[1] = scr_net_span_dyn(c.b, c.blen);
      scr_net_blocklist_add_range(l, args, 3, false);
    } else {
      done = false;
    }
    scr_dyn_release(args[0]);
    scr_dyn_release(args[1]);
    scr_dyn_release(family);
    if (done) return;
  }
}

static bool scr_net_all_strings(const ScrDyn *v) {
  for (size_t i = 0; i < v->v.arr.len; i++) {
    const ScrDyn *item = scr_dyn_arr_has_index(v, i) ? v->v.arr.items[i] : scr_dyn_undefined();
    if (item->kind != SCR_DYN_STR) return false;
  }
  return true;
}

static void scr_net_blocklist_from_json(ScrNetBlockList *l, ScrDyn *const *args, size_t argc) {
  const ScrDyn *data = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrDyn *parsed = NULL;
  if (data->kind == SCR_DYN_STR) {
    parsed = scr_json_parse(data->v.str);
    if (parsed == NULL || scr_exc_pending()) {
      scr_dyn_release(parsed);
      return;
    }
    data = parsed;
  }
  if (data->kind != SCR_DYN_ARR || !scr_net_all_strings(data)) {
    scr_dyn_arg_type_fail("data", "of type string or string[]", data);
    scr_dyn_release(parsed);
    return;
  }
  for (size_t i = 0; i < data->v.arr.len && !scr_exc_pending(); i++)
    scr_net_from_json_item(l, data->v.arr.items[i]->v.str);
  scr_dyn_release(parsed);
}

/* BlockList.PRIVATE_RANGES: one frozen array of Node's CIDR strings,
 * released at exit. +1. */
static SCR_TL ScrDyn *scr_net_private_ranges;

static void scr_net_private_ranges_cleanup(void) {
  ScrDyn *ranges = scr_net_private_ranges;
  scr_net_private_ranges = NULL;
  scr_dyn_release(ranges);
}

ScrDyn *scr_net_block_list_private_ranges(void) {
  ScrDyn *ranges = scr_net_private_ranges;
  if (ranges == NULL) {
    static const char *const cidrs[] = { "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
                                         "::1/128", "169.254.0.0/16", "fe80::/10", "fc00::/7" };
    ScrDyn *arr = scr_dyn_new_arr();
    for (size_t i = 0; i < sizeof cidrs / sizeof cidrs[0]; i++) scr_dyn_arr_push(arr, scr_net_dyn_str(cidrs[i]));
    ranges = scr_dyn_freeze_data(arr); /* +1 on the same array */
    scr_dyn_release(arr);
    scr_net_private_ranges = ranges;
    scr_atexit(scr_net_private_ranges_cleanup);
  }
  return scr_dyn_retain(ranges);
}

/* The address fields as dyn values (+1): remotePort (0), remoteFamily
 * (1), localAddress (2), localPort (3) and localFamily (4), each
 * undefined when unknown. */
ScrDyn *scr_net_sock_addr_field(ScrNetSocket *s, double field) {
  int f = (int)field;
  if (f == 0 || f == 3) {
    double port = f == 0 ? scr_net_sock_remote_port(s) : scr_net_sock_local_port(s);
    return isnan(port) ? scr_dyn_retain(scr_dyn_undefined()) : scr_dyn_new_num(port);
  }
  ScrStr *v = f == 1 ? scr_net_sock_remote_family(s)
              : f == 2 ? scr_net_sock_local_address(s)
                       : scr_net_sock_local_family(s);
  if (v == NULL) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *d = scr_dyn_new_str(v);
  scr_str_release(v);
  return d;
}

double scr_net_sock_bytes_read(ScrNetSocket *s) { return (double)s->bytes_read; }

/* socket.connecting: a dial in progress (deferred, looking up, or
 * awaiting the TCP handshake or the proxy tunnel). */
bool scr_net_sock_connecting(ScrNetSocket *s) {
  return s->fd >= 0 ? s->connecting || s->tunnel != NULL : (s->dial_deferred || s->lookup_wait);
}

/* socket.pending: no open handle yet (or anymore), or still connecting. */
bool scr_net_sock_pending(ScrNetSocket *s) { return s->fd < 0 || scr_net_sock_connecting(s); }

/* socket.readyState, Node's getter: opening while connecting, then by
 * which halves are still readable and writable. +1. */
ScrStr *scr_net_sock_ready_state(ScrNetSocket *s) {
  const char *state;
  if (scr_net_sock_connecting(s)) state = "opening";
  else {
    bool r = scr_net_sock_readable(s), w = scr_net_sock_writable(s);
    state = r && w ? "open" : r ? "readOnly" : w ? "writeOnly" : "closed";
  }
  return scr_str_new(state, strlen(state));
}

void scr_net_sock_on_ready(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->ready_ls, cb, NULL, once);
}

/* close(hadError) and write(chunk, cb(err)) listeners as dyn functions,
 * called with the hadError boolean and null. */
void scr_net_sock_on_close_dyn(ScrNetSocket *s, const ScrDyn *listener /*borrowed*/, bool once) {
  if (s->close_emitted) return;
  scr_net_ls_add(&s->close_ls, scr_dyn_listener_closure_fn(listener, (void *)&scr_net_dyn_fire_arg),
                 (void *)&scr_net_dyn_fire_arg, once);
}

/* ── 'lookup' ─────────────────────────────────────────────────────────── */

typedef struct ScrNetLookupEv {
  struct ScrNetLookupEv *next;
  ScrStr *host;
  ScrStr *ip;      /* NULL with err_msg */
  int family;
  ScrStr *err_msg; /* "getaddrinfo ENOTFOUND host" */
} ScrNetLookupEv;

static void scr_net_lookup_record(ScrNetSocket *s, const char *host, size_t host_len,
                                  const char *ip, int family, const char *err_msg) {
  ScrNetLookupEv *ev = calloc(1, sizeof *ev);
  if (!ev) scr_net_oom();
  ev->host = scr_str_new(host, host_len);
  ev->ip = ip != NULL ? scr_str_new(ip, strlen(ip)) : NULL;
  ev->family = family;
  ev->err_msg = err_msg != NULL ? scr_str_new(err_msg, strlen(err_msg)) : NULL;
  ScrNetLookupEv **link = &s->lookup_evs;
  while (*link) link = &(*link)->next;
  *link = ev;
}

static void scr_net_lookup_ev_free(ScrNetLookupEv *ev) {
  scr_str_release(ev->host);
  scr_str_release(ev->ip);
  scr_str_release(ev->err_msg);
  free(ev);
}

static void scr_net_lookup_free(ScrNetSocket *s) {
  while (s->lookup_evs) {
    ScrNetLookupEv *ev = s->lookup_evs;
    s->lookup_evs = ev->next;
    scr_net_lookup_ev_free(ev);
  }
}

/* Node emits ('lookup', err, address, family, host) from the resolver's
 * answer, before it dials: here the resolutions recorded at the dial reach
 * the listeners just before 'connect' (or the lookup's 'error'). */
static void scr_net_lookup_flush(ScrNetSocket *s) {
  while (s->lookup_evs && !scr_exc_pending()) {
    ScrNetLookupEv *ev = s->lookup_evs;
    s->lookup_evs = ev->next;
    if (s->lookup_ls.n > 0) {
      ScrDyn *args[4];
      if (ev->err_msg != NULL) {
        ScrError *e = scr_error_new(SCR_ERR_ERROR, ev->err_msg);
        const char *code = strchr(ev->err_msg->data, ' ');
        if (code != NULL) {
          char buf[32];
          size_t n = strcspn(code + 1, " ");
          if (n < sizeof buf) {
            memcpy(buf, code + 1, n);
            buf[n] = '\0';
            scr_error_set_code(e, buf);
          }
        }
        args[0] = scr_dyn_from_error(e);
        scr_error_release(e);
        args[1] = scr_dyn_retain(scr_dyn_undefined());
        args[2] = scr_dyn_retain(scr_dyn_undefined());
      } else {
        args[0] = scr_dyn_new_null();
        args[1] = scr_dyn_new_str(ev->ip);
        args[2] = scr_dyn_new_num((double)ev->family);
      }
      args[3] = scr_dyn_new_str(ev->host);
      ScrNetL *snap;
      size_t n = scr_net_ls_snapshot(&s->lookup_ls, &snap);
      scr_dyn_this_push(s, SCR_DYNH_NET_SOCKET);
      for (size_t i = 0; i < n; i++) {
        if (!scr_exc_pending()) {
          ScrDyn *fn = scr_dyn_listener_fn(snap[i].cb);
          scr_dyn_release(scr_dyn_call(fn, args, 4, "listener"));
          scr_dyn_release(fn);
        }
        scr_closure_release(snap[i].cb);
      }
      scr_dyn_this_pop();
      free(snap);
      for (size_t i = 0; i < 4; i++) scr_dyn_release(args[i]);
    }
    scr_net_lookup_ev_free(ev);
  }
}

static const ScrNetLookupOps scr_net_lookup_ops_impl = {
  &scr_net_lookup_record,
  &scr_net_lookup_flush,
  &scr_net_lookup_free,
};

/* The C main of a program with a 'lookup' listener installs the lookup
 * records before any socket dials. */
void scr_net_lookup_install(void) { scr_net_lookup_ops = &scr_net_lookup_ops_impl; }

/* socket.on/once('lookup', listener) with a dyn function listener. The
 * socket resolved when net.connect ran, before the listener was added; it
 * delivers its recorded answers at the connect, like Node's asynchronous
 * lookup. */
void scr_net_sock_on_lookup(ScrNetSocket *s, const ScrDyn *listener /*borrowed*/, bool once) {
  if (s->close_emitted) return;
  scr_net_ls_add(&s->lookup_ls, scr_dyn_listener_closure_fn(listener, (void *)&scr_net_dyn_fire_arg),
                 (void *)&scr_net_dyn_fire_arg, once);
}

/* server.close((err) => ...): the callback runs at 'close' with undefined,
 * or with Node's ERR_SERVER_NOT_RUNNING when the server was not listening. */
static void scr_net_close_not_running_fire(ScrClosure *cb) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  static const char msg[] = "Server is not running.";
  ScrStr *text = scr_str_new(msg, sizeof msg - 1);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_code(e, "ERR_SERVER_NOT_RUNNING");
  ScrDyn *err = scr_dyn_from_error(e);
  scr_error_release(e);
  scr_dyn_release(scr_dyn_call(fn, &err, 1, "listener"));
  scr_dyn_release(err);
  scr_dyn_release(fn);
}

void scr_net_server_close_dyn(ScrNetServer *s, const ScrDyn *listener /*borrowed*/) {
  ScrClosure *cb = scr_dyn_listener_closure_fn(
      listener, s->listening ? (void *)&scr_dyn_listener_fire0 : (void *)&scr_net_close_not_running_fire);
  scr_net_server_close(s, cb);
}

void scr_net_sock_on_write_flush_dyn(ScrNetSocket *s, const ScrDyn *listener /*borrowed*/) {
  if (s->close_emitted) return;
  scr_net_sock_add_write_cb(s, scr_dyn_listener_closure_fn(listener, (void *)&scr_net_dyn_fire_arg),
                            (void *)&scr_net_dyn_fire_arg);
}

/* socket.setTimeout(ms[, callback]) as the program calls it: Node's
 * msecs check (a non-negative finite number), then the timer; a callback
 * becomes a once('timeout') listener, and with 0 it is removed. */
static bool scr_net_timeout_msecs_valid(double ms) {
  if (isfinite(ms) && ms >= 0) return true;
  char recv[48], msg[160];
  scr_num_received(ms, recv);
  int len = snprintf(msg, sizeof msg,
                     "The value of \"msecs\" is out of range. It must be a non-negative finite number. "
                     "Received %s",
                     recv);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

void scr_net_sock_set_timeout_checked(ScrNetSocket *s, double ms) {
  if (!scr_net_timeout_msecs_valid(ms)) return;
  scr_net_sock_set_timeout(s, ms);
}

void scr_net_sock_set_timeout_cb(ScrNetSocket *s, double ms, ScrClosure *cb /*moves*/) {
  if (!scr_net_timeout_msecs_valid(ms)) {
    scr_closure_release(cb);
    return;
  }
  scr_net_sock_set_timeout(s, ms);
  if (ms == 0) {
    scr_net_ls_remove_fn(&s->timeout_ls, cb);
    scr_closure_release(cb);
    return;
  }
  scr_net_sock_on_timeout(s, cb, true);
}

/* net.isIP / isIPv4 / isIPv6, as Node's IPv4Reg and IPv6Reg match: dotted
 * decimal without leading zeros, and the RFC 4291 text forms (one "::"
 * standing for at least one group, an IPv4 tail as two groups) with an
 * optional %zone. */
static bool scr_net_ipv4_text(const char *p, size_t n) {
  size_t i = 0;
  for (int part = 0; part < 4; part++) {
    if (part > 0) {
      if (i >= n || p[i] != '.') return false;
      i++;
    }
    size_t start = i;
    int value = 0;
    while (i < n && p[i] >= '0' && p[i] <= '9' && i - start < 3) value = value * 10 + (p[i++] - '0');
    size_t digits = i - start;
    if (digits == 0 || (digits > 1 && p[start] == '0') || value > 255) return false;
  }
  return i == n;
}

static bool scr_net_ipv6_text(const char *p, size_t n) {
  /* an optional zone: '%' and at least one of [0-9a-zA-Z-.:] */
  for (size_t i = 0; i < n; i++) {
    if (p[i] != '%') continue;
    if (i + 1 == n) return false;
    for (size_t j = i + 1; j < n; j++) {
      char c = p[j];
      if (!(isalnum((unsigned char)c) || c == '-' || c == '.' || c == ':')) return false;
    }
    n = i;
    break;
  }
  int groups = 0;
  bool compressed = false;
  size_t i = 0;
  if (n >= 2 && p[0] == ':' && p[1] == ':') {
    compressed = true;
    i = 2;
    if (i == n) return true;
  } else if (n >= 1 && p[0] == ':') {
    return false;
  }
  while (i < n) {
    size_t start = i;
    while (i < n && isxdigit((unsigned char)p[i]) && i - start < 5) i++;
    size_t digits = i - start;
    if (i < n && p[i] == '.') {
      /* the IPv4 tail ends the address */
      if (!scr_net_ipv4_text(p + start, n - start)) return false;
      groups += 2;
      i = n;
      break;
    }
    if (digits == 0 || digits > 4) return false;
    groups++;
    if (i == n) break;
    if (p[i] != ':') return false;
    i++;
    if (i < n && p[i] == ':') {
      if (compressed) return false;
      compressed = true;
      i++;
      if (i == n) break;
    } else if (i == n) {
      return false; /* a single trailing ':' */
    }
  }
  return compressed ? groups <= 7 : groups == 8;
}

static ScrStr *scr_net_ip_input(const ScrDyn *input) {
  return input->kind == SCR_DYN_STR ? scr_str_retain(input->v.str) : scr_dyn_string_coerce_js(input);
}

double scr_net_is_ip(const ScrDyn *input) {
  ScrStr *t = scr_net_ip_input(input);
  if (!t) return 0;
  double r = scr_net_ipv4_text(t->data, t->len) ? 4 : scr_net_ipv6_text(t->data, t->len) ? 6 : 0;
  scr_str_release(t);
  return r;
}

bool scr_net_is_ipv4(const ScrDyn *input) { return scr_net_is_ip(input) == 4; }
bool scr_net_is_ipv6(const ScrDyn *input) { return scr_net_is_ip(input) == 6; }

void scr_net_sock_destroy(ScrNetSocket *s) {
  if (s->adopted_by != NULL) {
    scr_net_sock_destroy(s->adopted_by);
    return;
  }
  if (s->fd < 0 && !s->in_registry) return;
  s->rd_eof = true;
  s->wr_done = true;
  scr_net_sock_close_fd(s); /* 'close' fires at the next sweep */
}

/* ── the paused-mode surface (the demux path: once('readable') +
 * read(1) + unshift) ─────────────────────────────────────────────────── */

/* Append arrived bytes to the receive buffer (paused-mode reads). */
static void scr_net_sock_append_rbuf(ScrNetSocket *s, const char *data, size_t len) {
  if (len == 0) return;
  if (s->rhead > 0) {
    memmove(s->rbuf, s->rbuf + s->rhead, s->rlen - s->rhead);
    s->rlen -= s->rhead;
    s->rhead = 0;
  }
  if (s->rlen + len > s->rcap) {
    size_t cap = s->rcap ? s->rcap : 4096;
    while (cap < s->rlen + len) cap *= 2;
    s->rbuf = realloc(s->rbuf, cap);
    if (!s->rbuf) scr_net_oom();
    s->rcap = cap;
  }
  memcpy(s->rbuf + s->rlen, data, len);
  s->rlen += len;
}

void scr_net_sock_on_readable(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted || s->rd_eof) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->readable_ls, cb, NULL, once);
  scr_net_sock_update_read(s);
}

/* socket.read(n): n > 0 answers exactly n buffered bytes or NULL (Node's
 * less-than-n-buffered answer); n <= 0 (the read() form) drains the
 * whole buffer, NULL when empty. Always +1. */
ScrBytes *scr_net_sock_read_bytes(ScrNetSocket *s, double n) {
  size_t avail = s->rlen - s->rhead;
  size_t want = n > 0 ? (size_t)n : avail;
  if (avail == 0 || want == 0 || want > avail) return NULL;
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)want);
  out->is_buffer = true; /* socket.read() answers a Buffer */
  size_t took = scr_net_sock_take_buffered(s, (char *)out->data, want);
  (void)took;
  return out;
}

/* socket.unshift(buf): the bytes re-enter the FRONT of the receive
 * buffer — every consumer (data listeners, an http parser, a TLS bio)
 * sees them before anything still in the kernel. */
void scr_net_sock_unshift_bytes(ScrNetSocket *s, ScrBytes *data /*borrowed*/) {
  SCR_BYTES_SNAPSHOT(data);
  if (data->len == 0) return;
  size_t avail = s->rlen - s->rhead;
  if (s->rhead >= data->len) {
    /* room at the front (the read(1)-then-unshift shape: the byte slots
     * straight back where it came from) */
    s->rhead -= data->len;
    memcpy(s->rbuf + s->rhead, data->data, data->len);
    return;
  }
  size_t total = data->len + avail;
  char *fresh = malloc(total > 0 ? total : 1);
  if (!fresh) scr_net_oom();
  memcpy(fresh, data->data, data->len);
  if (avail > 0) memcpy(fresh + data->len, s->rbuf + s->rhead, avail);
  free(s->rbuf);
  s->rbuf = fresh;
  s->rhead = 0;
  s->rlen = total;
  s->rcap = total > 0 ? total : 1;
}

/* server.emit('connection', socket): route an accepted socket into
 * ANOTHER server — the demux pattern (portless's first-byte TLS peek).
 * The target's protocol layer claims the socket (the http parser, or
 * the TLS transport whose deferred 'connection' fires post-handshake);
 * the socket's owning server stays the accepting one, exactly Node's
 * connection accounting. */
void scr_net_server_emit_connection(ScrNetServer *srv, ScrNetSocket *sock) {
  if (srv->close_emitted) return;
  if (srv->native_conn) {
    srv->native_conn(srv->native_ctx, sock);
    if (scr_exc_pending()) return;
  }
  if (srv->defer_conn) {
    if (sock->conn_pending) scr_net_server_release(sock->conn_pending);
    sock->conn_pending = scr_net_server_retain(srv);
    return;
  }
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(&srv->conn_ls, &snap);
  scr_dyn_this_push(srv, SCR_DYNH_NET_SERVER);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((ScrNetConnFn)snap[i].fn)(snap[i].cb, scr_net_sock_retain(sock));
    scr_closure_release(snap[i].cb);
  }
  scr_dyn_this_pop();
  free(snap);
}

/* The accepting server of a server-side socket (BORROWED; NULL on client
 * sockets) — the protocol layer binds it as the ambient receiver when
 * firing server-level events ('request': Node's this === server). */
ScrNetServer *scr_net_sock_server(ScrNetSocket *s) { return s->server; }

/* socket.setEncoding(enc) — the req twin (scr_http_req_set_encoding's
 * contract: utf8 flips 'data' to strings, real-but-unsupported encodings
 * throw the 'not supported yet' Error, unknown names throw
 * ERR_UNKNOWN_ENCODING). */
void scr_net_sock_set_encoding(ScrNetSocket *s, ScrStr *enc /*borrowed*/) {
  if ((enc->len == 4 && memcmp(enc->data, "utf8", 4) == 0) ||
      (enc->len == 5 && memcmp(enc->data, "utf-8", 5) == 0)) {
    s->enc_utf8 = true;
    return;
  }
  static const char *const known[] = { "ascii", "latin1", "binary", "base64",
    "base64url", "hex", "ucs2", "ucs-2", "utf16le", "utf-16le", NULL };
  for (size_t i = 0; known[i]; i++) {
    if (enc->len == strlen(known[i]) && memcmp(enc->data, known[i], enc->len) == 0) {
      char msg[128];
      int n = snprintf(msg, sizeof msg, "setEncoding('%s') is not supported yet (only 'utf8' here)",
                       known[i]);
      scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
      return;
    }
  }
  char msg[128];
  int n = snprintf(msg, sizeof msg, "Unknown encoding: %.*s",
                   (int)(enc->len < 64 ? enc->len : 64), enc->data);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_UNKNOWN_ENCODING");
}

/* pipe(dst): every arrived chunk forwards to dst; src EOF end()s dst
 * (Node's default). Also arms the read side — a pipe is a consumer. */
void scr_net_sock_pipe(ScrNetSocket *src, ScrNetSocket *dst) {
  if (src->pipe_dst) scr_net_sock_release(src->pipe_dst);
  src->pipe_dst = scr_net_sock_retain(dst);
  scr_net_sock_update_read(src);
}

void scr_net_sock_on_data(ScrNetSocket *s, ScrClosure *cb /*moves*/, ScrNetDataFn fn,
                           bool once) {
  if (s->close_emitted || s->rd_eof) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->data_ls, cb, (void *)fn, once);
  scr_net_sock_update_read(s);
}

void scr_net_sock_on_end(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted || s->rd_eof) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->end_ls, cb, NULL, once);
}

void scr_net_sock_on_close(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->close_ls, cb, NULL, once);
}

void scr_net_sock_on_error(ScrNetSocket *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn,
                            bool once) {
  if (s->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->err_ls, cb, (void *)fn, once);
}

void scr_net_sock_on_connect(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  /* a socket that took over another's connection never emits 'connect' */
  if (s->close_emitted || (!s->connecting && s->fd < 0) || s->adopted_from != NULL) {
    scr_closure_release(cb);
    return;
  }
  if (!s->connecting && s->tunnel == NULL) {
    /* already connected: Node fires a late once('connect')… never — the
     * event is past. Release, like listeners after 'exit'. */
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->conn_ls, cb, NULL, once);
}

/* The runtime-provided data adapters (the child/stdin thunk pattern). */
void scr_net_data_thunk0(ScrClosure *cb, ScrBytes *chunk) {
  (void)chunk;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_net_data_thunk_bytes(ScrClosure *cb, ScrBytes *chunk) {
  /* the listener owns its +1 param per the universal convention */
  ((void (*)(ScrClosure *, ScrBytes *))cb->fn)(cb, scr_bytes_retain(chunk));
}

/* The checked-dynamic data listener (a dynCheck-adapted (dyn) => void
 * closure): the chunk boxes BUFFER-flavored — Node hands Buffers to
 * 'data', so toString()/string coercion decode utf8 (the stream lane's
 * box-by-tag stance). The adapter owns its +1 dyn param. */
void scr_net_data_thunk_dyn(ScrClosure *cb, ScrBytes *chunk) {
  ScrDyn *d = scr_dyn_new_chunk(chunk);
  ((void (*)(ScrClosure *, ScrDyn *))cb->fn)(cb, d);
}

/* The string-TYPED data listener ((chunk: string) => void — the
 * setEncoding('utf8') shape): the chunk decodes as UTF-8 (WHATWG
 * replacement, Buffer.toString's algorithm) into the string the
 * annotation promises. Without setEncoding Node would hand a Buffer —
 * a string-typed listener there mistypes its own input, and the decode
 * is the honest reading of the annotation. */
void scr_net_data_thunk_str(ScrClosure *cb, ScrBytes *chunk) {
  ScrStr *enc = scr_str_new("utf8", 4);
  ScrStr *text = scr_bytes_to_str(chunk, enc);
  scr_str_release(enc);
  ((void (*)(ScrClosure *, ScrStr *))cb->fn)(cb, text);
}

/* The connection-handler adapters: the socket arrives +1 from the firing
 * site; the zero-param shape releases it. */
void scr_net_conn_thunk0(ScrClosure *cb, ScrNetSocket *sock) {
  scr_net_sock_release(sock);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_net_conn_thunk_sock(ScrClosure *cb, ScrNetSocket *sock) {
  ((void (*)(ScrClosure *, ScrNetSocket *))cb->fn)(cb, sock);
}

/* ── the protocol-layer hooks (scr_http.c) ───────────────────────────── */

void scr_net_server_set_native_conn(ScrNetServer *s, ScrNetNativeConnFn fn, void *ctx,
                                     void (*ctx_free)(void *)) {
  s->native_conn = fn;
  s->native_ctx = ctx;
  s->native_ctx_free = ctx_free;
}

void scr_net_server_set_proto_settle(ScrNetServer *s, void (*fn)(void *)) {
  s->proto_settle = fn;
}

bool scr_net_server_settled(ScrNetServer *s) { return s->close_emitted; }

void scr_net_server_set_http_ctx(ScrNetServer *s, void *ctx) { s->http_ctx = ctx; }
void *scr_net_server_get_http_ctx(ScrNetServer *s) { return s->http_ctx; }

void scr_net_sock_set_native_reader(ScrNetSocket *s, ScrNetNativeDataFn data,
                                     ScrNetNativeEventFn eof, ScrNetNativeEventFn closed,
                                     void *ctx, void (*ctx_free)(void *)) {
  s->native_data = data;
  s->native_eof = eof;
  s->native_closed = closed;
  s->native_idle = NULL;
  s->native_ctx = ctx;
  s->native_ctx_free = ctx_free;
  scr_net_sock_update_read(s);
}

void scr_net_sock_set_native_idle_checker(ScrNetSocket *s, bool (*fn)(void *)) {
  s->native_idle = fn;
}

/* The upgrade handover: clear the native reader's FN POINTERS but keep
 * the ctx (still freed at socket death as registered) — the protocol
 * parser steps aside mid-call and 'data'/pipe consumers take the raw
 * stream from the next byte on. */
void scr_net_sock_clear_native_reader(ScrNetSocket *s) {
  s->native_data = NULL;
  s->native_eof = NULL;
  s->native_closed = NULL;
  s->native_idle = NULL; /* upgraded and CONNECT sockets are outside HTTP close sweeps */
  s->native_http_timeout = NULL;
  scr_net_sock_update_read(s);
}

/* socket.destroyed — true once the fd is gone (destroy() or full close),
 * Node's flag for "this stream is done". */
bool scr_net_sock_destroyed(ScrNetSocket *s) {
  return s->adopted_by != NULL ? scr_net_sock_destroyed(s->adopted_by) : s->fd < 0;
}

/* socket.writable — Node's stream flag: the write half is open (no end()
 * yet, no FIN sent, fd alive). Connecting sockets answer true — writes
 * queue, exactly Node. */
bool scr_net_sock_writable(ScrNetSocket *s) {
  if (s->adopted_by != NULL) return scr_net_sock_writable(s->adopted_by);
  return s->fd >= 0 && !s->wr_ending && !s->wr_done;
}

bool scr_net_sock_established(ScrNetSocket *s) {
  return s->fd >= 0 && !s->connecting && s->tunnel == NULL && (!s->tops || s->t_est);
}

/* The protocol layer's timeout/error hooks (scr_http.c's client and the
 * server parser's error swallowing). */
void scr_net_sock_set_native_events(ScrNetSocket *s, ScrNetNativeEventFn timeout,
                                     ScrNetNativeErrFn err) {
  s->native_timeout = timeout;
  s->native_err = err;
}

void scr_net_sock_set_native_http_timeout(ScrNetSocket *s, ScrNetNativeTimeoutHandledFn fn) {
  s->native_http_timeout = fn;
}

/* Client connect completion for the protocol layer (the h2 session's
 * 'connect' moment) — fires before the socket's own conn_ls. */
void scr_net_sock_set_native_established(ScrNetSocket *s, ScrNetNativeEventFn fn) {
  s->native_established = fn;
}

/* Raw bytes from the protocol layer (head/framing text). */
void scr_net_sock_write_native(ScrNetSocket *s, const char *buf, size_t n) {
  scr_net_sock_write_raw(s, buf, n);
}

/* ── the transport hooks (scr_tls.c) ─────────────────────────────────── */

void scr_net_sock_set_tunnel(ScrNetSocket *s, const char *request, size_t len) {
  if (s->fd < 0 || !s->connecting || s->tunnel != NULL) return;
  ScrNetTunnel *t = calloc(1, sizeof *t);
  if (!t) scr_net_oom();
  t->out = malloc(len);
  if (!t->out) scr_net_oom();
  memcpy(t->out, request, len);
  t->out_len = len;
  s->tunnel = t;
}

void scr_net_sock_set_transport(ScrNetSocket *s, const ScrNetTransportOps *ops, void *tctx) {
  s->tops = ops;
  s->tctx = tctx;
  s->t_est = false;
  scr_net_sock_update_read(s); /* the handshake is a consumer */
  scr_net_sock_update_write(s);
}

/* A fresh socket takes over raw's open connection: the fd, the bytes it
 * buffered either way and the peer identity. raw keeps its listeners and
 * its server's accounting but does no I/O of its own; end() and destroy()
 * on it act on the new socket, and its 'close' fires just before the new
 * socket's. Bytes raw had not sent yet go out first. +1; the caller sets
 * the transport, then starts it with scr_net_sock_adopt_start. NULL when
 * raw has no open, idle connection to give (connecting, closed, already
 * wrapped, or carrying a transport). */
ScrNetSocket *scr_net_sock_adopt(ScrNetSocket *raw) {
  if (raw->fd < 0 || scr_net_sock_connecting(raw) || raw->adopted_by != NULL || raw->tops != NULL)
    return NULL;
  ScrNetSocket *t = scr_net_sock_new();
  scr_str_release(scr_net_sock_remote_address(raw)); /* cache the peer while the fd is raw's */
  if (raw->remote_cache) {
    t->remote_cache = scr_str_retain(raw->remote_cache);
    t->remote_port_cache = raw->remote_port_cache;
    t->remote_v6_cache = raw->remote_v6_cache;
  }
  memcpy(t->peer_ip, raw->peer_ip, sizeof t->peer_ip);
  t->peer_port = raw->peer_port;
  t->unrefd = raw->unrefd;
  t->rd_eof = raw->rd_eof;
  scr_net_sock_timer_cancel(raw);
  if (raw->read_armed) scr_net_watch_read(raw->fd, raw, false);
  if (raw->write_armed) scr_net_watch_write(raw->fd, raw, false);
  raw->read_armed = raw->write_armed = false;
  t->fd = raw->fd;
  raw->fd = -1;
  if (raw->rlen > raw->rhead) scr_net_sock_append_rbuf(t, raw->rbuf + raw->rhead, raw->rlen - raw->rhead);
  raw->rhead = raw->rlen = 0;
  while (raw->wlen > raw->whead) {
    ssize_t sent = scr_net_send(t->fd, raw->wbuf + raw->whead, raw->wlen - raw->whead);
    if (sent < 0 && errno == EINTR) continue;
    if (sent <= 0) break; /* EAGAIN, or an error the transport will meet */
    raw->whead += (size_t)sent;
  }
  if (raw->wlen > raw->whead) {
    ScrNetTunnel *tun = calloc(1, sizeof *tun);
    if (!tun) scr_net_oom();
    tun->out_len = raw->wlen - raw->whead;
    tun->out = malloc(tun->out_len);
    if (!tun->out) scr_net_oom();
    memcpy(tun->out, raw->wbuf + raw->whead, tun->out_len);
    tun->send_only = true;
    t->tunnel = tun;
  }
  raw->whead = raw->wlen = 0;
  raw->adopted_by = scr_net_sock_retain(t);
  t->adopted_from = scr_net_sock_retain(raw);
  scr_net_sock_register(t);
  return t;
}

/* Starts an adopted socket once its transport is set: the unsent bytes
 * drain first, then the handshake runs (over any bytes raw had already
 * read). */
void scr_net_sock_adopt_start(ScrNetSocket *t) {
  if (t->tunnel != NULL) {
    scr_net_sock_update_write(t);
    return;
  }
  /* the handshake starts from the poller (the socket is writable), never
   * the constructing stack — Node's start is asynchronous too */
  scr_net_sock_transport_want_write(t);
}

int scr_net_sock_fd(ScrNetSocket *s) { return s->fd; }

/* The host a client socket was told to dial (Node's socket._host). +1;
 * NULL on server sockets. */
ScrStr *scr_net_sock_dial_name(ScrNetSocket *s) { return scr_str_retain(s->host_name); }

/* Drain up to n bytes of the receive buffer (peeked/unshifted bytes) —
 * consumers call this BEFORE the fd so re-queued bytes keep their
 * position in the stream. */
size_t scr_net_sock_take_buffered(ScrNetSocket *s, char *buf, size_t n) {
  size_t avail = s->rlen - s->rhead;
  if (avail == 0) return 0;
  size_t take = n < avail ? n : avail;
  memcpy(buf, s->rbuf + s->rhead, take);
  s->rhead += take;
  if (s->rhead == s->rlen) s->rhead = s->rlen = 0;
  return take;
}

void scr_net_sock_transport_want_write(ScrNetSocket *s) {
  s->t_want_write = true;
  scr_net_sock_update_write(s);
}

/* The transport context, guarded by ops identity — the SNI answer path
 * re-finds its engine from the boxed socket, which may have died (or
 * been re-routed) between the callback and the answer. */
void *scr_net_sock_transport_ctx_for(ScrNetSocket *s, const ScrNetTransportOps *ops) {
  return s->tops == ops ? s->tctx : NULL;
}

/* Re-drive a parked handshake (the asynchronous SNI answer arrived; no
 * fd readiness is coming — the client is waiting for the ServerHello). */
void scr_net_sock_transport_resume(ScrNetSocket *s) { scr_net_sock_transport_pump(s); }

/* Replay raw bytes at the FRONT of the receive buffer (the SNI
 * pre-parse handing the consumed ClientHello back to the TLS bio) —
 * unshift's shape over a raw span. */
void scr_net_sock_replay(ScrNetSocket *s, const char *data, size_t len) {
  if (len == 0) return;
  size_t avail = s->rlen - s->rhead;
  if (s->rhead >= len) {
    s->rhead -= len;
    memcpy(s->rbuf + s->rhead, data, len);
    return;
  }
  size_t total = len + avail;
  char *fresh = malloc(total);
  if (!fresh) scr_net_oom();
  memcpy(fresh, data, len);
  if (avail > 0) memcpy(fresh + len, s->rbuf + s->rhead, avail);
  free(s->rbuf);
  s->rbuf = fresh;
  s->rhead = 0;
  s->rlen = total;
  s->rcap = total;
}

/* The peer closed before the handshake finished, on a socket whose
 * stream the program already holds (new tls.TLSSocket): 'end', then
 * 'close' without an error, as Node reports it. */
void scr_net_sock_transport_eof(ScrNetSocket *s) {
  scr_net_sock_eof(s);
  if (s->fd >= 0) scr_net_sock_close_fd(s);
}

/* A listener for the handshake's completion once TCP is up (a socket
 * tls.connect({ socket }) took over is up from the start): it registers
 * until the transport establishes. */
void scr_net_sock_on_established(ScrNetSocket *s, ScrClosure *cb /*moves*/, bool once) {
  if (s->close_emitted || s->fd < 0 || s->tops == NULL || s->t_est) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&s->conn_ls, cb, NULL, once);
}

/* scr_net_sock_transport_error with the error's code given (static
 * storage), for messages whose text does not name it. */
void scr_net_sock_transport_error_code(ScrNetSocket *s, const char *msg, const char *code) {
  if (!s->pending_err) s->pending_code = code;
  scr_net_sock_transport_error(s, msg);
}

void scr_net_sock_transport_report(ScrNetSocket *s, const char *msg, const char *code) {
  if (s->pending_err) return;
  s->pending_err = scr_str_new(msg, strlen(msg));
  s->pending_code = code;
}

void scr_net_sock_transport_ended(ScrNetSocket *s) {
  s->rd_eof = true;
  scr_net_fire0_this(&s->end_ls, s, SCR_DYNH_NET_SOCKET);
}

void scr_net_sock_transport_error(ScrNetSocket *s, const char *msg) {
  if (msg != NULL) {
    if (!s->pending_err) s->pending_err = scr_str_new(msg, strlen(msg));
    s->had_error = true;
  }
  scr_net_sock_close_fd(s); /* the sweep delivers 'error' (if any) then 'close' */
}

void scr_net_server_defer_connections(ScrNetServer *s) { s->defer_conn = true; }

void scr_net_server_get_native_conn(ScrNetServer *s, ScrNetNativeConnFn *fn, void **ctx,
                                     void (**ctx_free)(void *)) {
  *fn = s->native_conn;
  *ctx = s->native_ctx;
  *ctx_free = s->native_ctx_free;
}

/* ── the sweep: deferred emits ───────────────────────────────────────── */

/* The protocol layer's deferred-emit hook (scr_http.c: response/request
 * 'close' events and the client teardown queue fire from the sweep, one
 * pass after the work that flagged them — Node's later-than-the-handler
 * emits). Registered once by scr_http install-time code. */
enum { SCR_NET_PROTO_SLOTS = 4 };
static SCR_TL bool (*scr_net_proto_pendings[SCR_NET_PROTO_SLOTS])(void);
static SCR_TL void (*scr_net_proto_sweeps[SCR_NET_PROTO_SLOTS])(void);
static SCR_TL size_t scr_net_proto_n = 0;

/* ADDITIVE registration (each protocol unit — scr_http.c, scr_http2.c —
 * claims a slot at its install; both can co-link in one binary). */
void scr_net_set_proto_sweep(bool (*pending)(void), void (*sweep)(void)) {
  if (scr_net_proto_n == SCR_NET_PROTO_SLOTS) abort();
  scr_net_proto_pendings[scr_net_proto_n] = pending;
  scr_net_proto_sweeps[scr_net_proto_n] = sweep;
  scr_net_proto_n++;
}

static bool scr_net_proto_pending(void) {
  for (size_t i = 0; i < scr_net_proto_n; i++) {
    if (scr_net_proto_pendings[i]()) return true;
  }
  return false;
}

static void scr_net_proto_sweep(void) {
  for (size_t i = 0; i < scr_net_proto_n; i++) {
    scr_net_proto_sweeps[i]();
    if (scr_exc_pending()) return;
  }
}

static bool scr_net_flags_pending(void) {
  if (scr_net_proto_pending()) return true;
  for (ScrNetSocket *s = scr_net_socks; s; s = s->next) {
    if (s->pending_err || (s->emit_close && !s->close_emitted)) return true;
    if (s->finish_pending && s->finish_ls.n > 0) return true;
    if (s->wcb_ls.n > 0 && (s->wlen == s->whead || s->fd < 0)) return true;
    /* bytes already out of the kernel with a consumer waiting — decrypted
     * plaintext inside a transport, or unshifted bytes in the receive
     * buffer: the poller can't re-signal them, the sweep must deliver */
    bool consumers = (s->data_ls.n > 0 || s->pipe_dst || s->native_data || s->flowing) &&
                     !s->user_paused && !s->hold;
    if (consumers && s->fd >= 0) {
      if (s->tops && s->t_est && s->tops->pending && s->tops->pending(s->tctx)) return true;
      if (!s->tops && s->rlen > s->rhead) return true;
    }
  }
  for (ScrNetServer *s = scr_net_servers; s; s = s->next) {
    if (s->pending_err || s->emit_listening) return true;
    if (s->closing && s->nconns == 0 && !s->close_emitted) return true;
  }
  return false;
}

/* Settles a server whose 'close' is due: fires the close callbacks and
 * listeners, drops every listener list (the cycle story), and leaves the
 * registry. Shared by the server sweep and the socket settle below —
 * Node emits a DRAINED server's 'close' before the dying socket's own
 * 'close', so the socket settle calls this mid-flight. */
static void scr_net_server_settle(ScrNetServer *srv) {
  srv->close_emitted = true;
  scr_net_fire0_this(&srv->close_ls, srv, SCR_DYNH_NET_SERVER);
  scr_net_ls_drop(&srv->conn_ls);
  scr_net_ls_drop(&srv->err_ls);
  scr_net_ls_drop(&srv->close_ls);
  scr_net_ls_drop(&srv->listening_cbs);
  scr_net_ls_drop(&srv->timeout_ls);
  scr_net_ls_drop(&srv->client_error_ls);
  if (srv->proto_settle && srv->http_ctx) srv->proto_settle(srv->http_ctx);
  scr_net_server_unregister(srv);
}

/* Fires a closed socket's 'close' and settles it: its server's count
 * drains, the protocol layer hears it, listeners drop and it leaves the
 * registry. A socket that took over another's connection settles that one
 * first, so the wrapped socket's 'close' comes just before its own. False
 * with an exception pending. */
static bool scr_net_sock_settle(ScrNetSocket *sock) {
  ScrNetSocket *raw = sock->adopted_from;
  if (raw != NULL) {
    sock->adopted_from = NULL;
    if (raw->adopted_by == sock) {
      raw->adopted_by = NULL;
      scr_net_sock_release(sock);
    }
    bool ok = raw->close_emitted || scr_net_sock_settle(raw);
    scr_net_sock_release(raw);
    if (!ok) return false;
  }
  sock->close_emitted = true;
  sock->emit_close = false;
  /* The owning server's count drains FIRST, and a now-drained closing
   * server settles before this socket's own 'close' fires — Node's
   * observed order (differential: the net-echo fixture). */
  if (sock->server) {
    ScrNetServer *srv = sock->server;
    sock->server = NULL;
    srv->nconns--;
    if (srv->closing && srv->nconns == 0 && !srv->close_emitted) {
      scr_net_server_settle(srv);
    }
    scr_net_server_release(srv);
    if (scr_exc_pending()) return false;
  }
  if (sock->native_closed) {
    sock->native_closed(sock->native_ctx);
    if (scr_exc_pending()) return false;
  }
  {
    ScrDyn *had_error = scr_dyn_new_bool(sock->had_error);
    scr_net_fire_arg_this(&sock->close_ls, had_error, sock, SCR_DYNH_NET_SOCKET);
    scr_dyn_release(had_error);
  }
  /* the transport settles first: a listener its last events add (a TLS
   * server's 'tlsClientError') drops with the rest */
  if (sock->tops && sock->tops->settle) sock->tops->settle(sock->tctx);
  /* settle: listeners drop (cycle story) */
  scr_net_ls_drop(&sock->data_ls);
  scr_net_ls_drop(&sock->end_ls);
  scr_net_ls_drop(&sock->close_ls);
  scr_net_ls_drop(&sock->err_ls);
  scr_net_ls_drop(&sock->conn_ls);
  scr_net_ls_drop(&sock->timeout_ls);
  scr_net_ls_drop(&sock->readable_ls);
  scr_net_ls_drop(&sock->finish_ls);
  scr_net_ls_drop(&sock->wcb_ls);
  scr_net_ls_drop(&sock->ready_ls);
  scr_net_ls_drop(&sock->lookup_ls);
  if (sock->pipe_dst) {
    scr_net_sock_release(sock->pipe_dst);
    sock->pipe_dst = NULL;
  }
  if (sock->conn_pending) {
    scr_net_server_release(sock->conn_pending);
    sock->conn_pending = NULL;
  }
  scr_net_sock_unregister(sock);
  return !scr_exc_pending();
}

/* Sockets first (a dying connection may drain its server), servers after.
 * Every fire checks for a pending exception and bails — the loop surfaces
 * it as an uncaught throw. */
static void scr_net_sweep(void) {
  scr_net_proto_sweep();
  if (scr_exc_pending()) return;
  ScrNetSocket *sock = scr_net_socks;
  while (sock) {
    ScrNetSocket *next = sock->next; /* may unregister below */
    scr_net_sock_retain(sock);      /* callbacks may drop every other ref */
    if (sock->fd >= 0 && !sock->user_paused && !sock->hold &&
        (sock->data_ls.n > 0 || sock->pipe_dst || sock->native_data || sock->flowing) &&
        ((sock->tops && sock->t_est && sock->tops->pending && sock->tops->pending(sock->tctx)) ||
         (!sock->tops && sock->rlen > sock->rhead))) {
      /* deliver bytes the kernel can't re-signal (see flags_pending) */
      ScrAlsCtx *prev = scr_als_dispatch_enter(sock->als);
      scr_net_sock_read(sock);
      scr_als_dispatch_leave(prev);
      if (scr_exc_pending()) {
        scr_net_sock_release(sock);
        return;
      }
    }
    if (sock->wcb_ls.n > 0 && (sock->wlen == sock->whead || sock->fd < 0)) {
      /* write(chunk, cb): the buffer drained (this surface's flush
       * moment) — the callbacks fire off the sweep, never the writing
       * stack. A dead socket fires them too (the buffered bytes are
       * gone either way; Node errors them — documented divergence,
       * the no-backpressure stance). */
      ScrDyn *no_error = scr_dyn_new_null();
      scr_net_fire_arg_this(&sock->wcb_ls, no_error, sock, SCR_DYNH_NET_SOCKET);
      scr_dyn_release(no_error);
      if (scr_exc_pending()) {
        scr_net_sock_release(sock);
        return;
      }
    }
    if (sock->finish_pending) {
      sock->finish_pending = false;
      ScrAlsCtx *prev = scr_als_dispatch_enter(sock->end_ctx);
      scr_net_fire0_this(&sock->finish_ls, sock, SCR_DYNH_NET_SOCKET);
      scr_als_dispatch_leave(prev);
      if (scr_exc_pending()) {
        scr_net_sock_release(sock);
        return;
      }
    }
    if (sock->lookup_evs != NULL && sock->pending_err) {
      ScrAlsCtx *prev = scr_als_dispatch_enter(sock->als);
      scr_net_lookup_ops->flush(sock);
      scr_als_dispatch_leave(prev);
      if (scr_exc_pending()) {
        scr_net_sock_release(sock);
        return;
      }
    }
    if (sock->pending_err) {
      ScrStr *msg = sock->pending_err;
      sock->pending_err = NULL;
      /* the protocol layer gets first claim (the http conn/client owns
       * the error story: 'error' on the req, or Node's server-side
       * teardown without an event); unconsumed errors fall through to the socket's own
       * listeners — and the unhandled-'error' exit */
      bool consumed = false;
      ScrAlsCtx *prev = scr_als_dispatch_enter(sock->als);
      if (sock->native_err) consumed = sock->native_err(sock->native_ctx, msg);
      if (!consumed && !scr_exc_pending()) {
        ScrError *coded = NULL;
        ScrError *saved = scr_event_error_payload;
        if (sock->pending_code != NULL) {
          coded = scr_error_new(SCR_ERR_ERROR, msg);
          coded->code = scr_str_new(sock->pending_code, strlen(sock->pending_code));
          scr_event_error_payload = coded;
        }
        scr_net_fire_err_this(&sock->err_ls, msg, sock, SCR_DYNH_NET_SOCKET);
        scr_event_error_payload = saved;
        if (coded != NULL) scr_error_release(coded);
      }
      scr_als_dispatch_leave(prev);
      sock->pending_code = NULL;
      scr_str_release(msg);
      if (scr_exc_pending()) {
        scr_net_sock_release(sock);
        return;
      }
    }
    if (sock->emit_close && !sock->close_emitted && sock->fd < 0) {
      ScrAlsCtx *prev = scr_als_dispatch_enter(sock->als);
      bool settled = scr_net_sock_settle(sock);
      scr_als_dispatch_leave(prev);
      if (!settled) {
        scr_net_sock_release(sock);
        return;
      }
    }
    scr_net_sock_release(sock);
    sock = next;
  }
  ScrNetServer *srv = scr_net_servers;
  while (srv) {
    ScrNetServer *next = srv->next;
    scr_net_server_retain(srv);
    if (srv->emit_listening) {
      srv->emit_listening = false;
      ScrAlsCtx *prev = scr_als_dispatch_enter(srv->listen_ctx);
      scr_net_fire0_this(&srv->listening_cbs, srv, SCR_DYNH_NET_SERVER);
      scr_als_dispatch_leave(prev);
      if (scr_exc_pending()) {
        scr_net_server_release(srv);
        return;
      }
    }
    if (srv->pending_err) {
      ScrStr *msg = srv->pending_err;
      srv->pending_err = NULL;
      ScrAlsCtx *prev = scr_als_dispatch_enter(srv->listen_ctx);
      scr_net_fire_err_this(&srv->err_ls, msg, srv, SCR_DYNH_NET_SERVER);
      scr_als_dispatch_leave(prev);
      scr_str_release(msg);
      /* A failed listen SETTLES the handle: listeners drop (an error
       * listener capturing its own server would otherwise cycle forever —
       * the RC audit caught exactly that) and it leaves the registry. A
       * later listen() starts fresh; pre-failure listeners are gone,
       * where Node's would survive (SEMANTICS.md divergence 48). */
      if (!srv->listening && !srv->closing) {
        scr_net_ls_drop(&srv->conn_ls);
        scr_net_ls_drop(&srv->err_ls);
        scr_net_ls_drop(&srv->close_ls);
        scr_net_ls_drop(&srv->listening_cbs);
        scr_net_ls_drop(&srv->timeout_ls);
        scr_net_server_unregister(srv);
      }
      if (scr_exc_pending()) {
        scr_net_server_release(srv);
        return;
      }
    }
    scr_net_server_release(srv);
    srv = next;
  }
  /* Drained closing servers settle in close-REQUEST order (close_seq),
   * not registry order — Node emits 'close' in the order close() was
   * called when several drain in one turn. */
  for (;;) {
    ScrNetServer *due = NULL;
    for (ScrNetServer *it = scr_net_servers; it; it = it->next) {
      if (it->closing && it->nconns == 0 && !it->close_emitted &&
          (due == NULL || it->close_seq < due->close_seq)) {
        due = it;
      }
    }
    if (due == NULL) return;
    scr_net_server_retain(due);
    ScrAlsCtx *prev = scr_als_dispatch_enter(due->close_ctx);
    scr_net_server_settle(due);
    scr_als_dispatch_leave(prev);
    scr_net_server_release(due);
    if (scr_exc_pending()) return;
  }
}

/* ── the loop hooks (scr_async.c) ────────────────────────────────────── */

/* Loop liveness: a ref'd server or socket, or pending protocol work. */
static bool scr_net_pending(void) {
  for (ScrNetServer *srv = scr_net_servers; srv; srv = srv->next)
    if (!srv->unrefd) return true;
  for (ScrNetSocket *sock = scr_net_socks; sock; sock = sock->next)
    if (!sock->unrefd) return true;
  return scr_net_proto_pending();
}

/* Any handle, ref'd or not: the loop polls the net fd while it runs. */
static bool scr_net_io(void) { return scr_net_servers != NULL || scr_net_socks != NULL; }

/* socket.ref() / socket.unref() and the server pair: whether the handle
 * keeps the event loop alive (Node's default is ref'd). */
void scr_net_sock_set_ref(ScrNetSocket *s, bool ref) { s->unrefd = !ref; }
void scr_net_server_set_ref(ScrNetServer *s, bool ref) { s->unrefd = !ref; }
bool scr_net_sock_has_ref(ScrNetSocket *s) { return !s->unrefd; }

static int scr_net_pollfd(void) {
  return scr_net_poller != NULL ? scrp_poller_fd(scr_net_poller) : -1;
}

bool scr_loop_io_take(void);
bool scr_loop_io_more(void);
void scr_loop_io_reopen(void);

/* One poller event of a socket; false with an exception pending. */
static bool scr_net_sock_event(ScrNetSocket *s, unsigned events) {
  if (events & SCRP_TIMER) {
    /* the idle period elapsed: 'timeout' fires once (one-shot — the
     * next activity re-arms); the socket stays open, like Node */
    s->timeout_armed = false;
    if (s->native_timeout) {
      s->native_timeout(s->native_ctx);
      if (scr_exc_pending()) return false;
    }
    if (s->server && s->server->http_timeout_surface &&
        s->native_http_timeout) {
      ScrNetServer *srv = scr_net_server_retain(s->server);
      bool handled = s->native_http_timeout(s->native_ctx);
      if (scr_exc_pending()) {
        scr_net_server_release(srv);
        return false;
      }
      bool server_handled = srv->timeout_ls.n > 0;
      if (server_handled) {
        ScrNetL *snap;
        size_t count = scr_net_ls_snapshot(&srv->timeout_ls, &snap);
        scr_dyn_this_push(srv, SCR_DYNH_NET_SERVER);
        for (size_t j = 0; j < count; j++) {
          if (!scr_exc_pending()) ((ScrNetConnFn)snap[j].fn)(snap[j].cb, scr_net_sock_retain(s));
          scr_closure_release(snap[j].cb);
        }
        scr_dyn_this_pop();
        free(snap);
      }
      if (!handled && !server_handled && !scr_exc_pending())
        scr_net_sock_destroy(s); /* Node's unhandled server timeout */
      scr_net_server_release(srv);
      if (scr_exc_pending()) return false;
    }
    scr_net_fire0_this(&s->timeout_ls, s, SCR_DYNH_NET_SOCKET);
    if (scr_exc_pending()) return false;
    if (s->fd < 0) return true;
  }
  /* kqueue delivers one direction per event (today's exact order);
   * epoll may coalesce both into one — writes first (connect
   * completion, flushes), then reads, re-checking the fd a write
   * failure may have closed. */
  if (events & SCRP_WRITABLE) {
    if (s->connecting) scr_net_sock_connect_done(s);
    else if (s->tunnel != NULL) scr_net_sock_tunnel_pump(s);
    else if (s->tops && !s->t_est) {
      s->t_want_write = false;
      scr_net_sock_transport_pump(s);
      if (!scr_exc_pending() && s->fd >= 0) scr_net_sock_update_write(s);
    } else {
      s->t_want_write = false;
      if (s->tops && s->tops->drain) s->tops->drain(s->tctx);
      scr_net_sock_flush(s);
    }
  }
  if ((events & SCRP_READABLE) && !scr_exc_pending() && s->fd >= 0) {
    if (s->tunnel != NULL) scr_net_sock_tunnel_pump(s);
    else if (s->tops && !s->t_est) scr_net_sock_transport_pump(s);
    else scr_net_sock_read(s);
  }
  return true;
}

static void scr_net_dispatch(void) {
  if (!scr_net_servers && !scr_net_socks &&
      !scr_net_proto_pending()) {
    return;
  }
  /* One poller drain per loop iteration (scr_loop_io_take); a full batch
   * keeps draining within the phase's batch budget (scr_loop_io_more), like
   * libuv's poll phase. Deferred emits (the sweep) still run on every
   * call. */
  bool may_drain = scr_loop_io_take();
  for (;;) {
    scr_net_sweep();
    if (scr_exc_pending()) return;
    if (scr_net_poller == NULL) return;
    ScrPollerEvent evs[64];
    int n = 0;
    if (may_drain) {
      n = scrp_drain(scr_net_poller, evs, 64);
      may_drain = n == 64 && scr_loop_io_more();
    }
    for (int i = 0; i < n; i++) {
      void *udata = evs[i].udata;
      if (!udata) continue;
      int kind = *(int *)udata;
      if (kind == SCR_NET_K_SERVER) {
        /* 'connection' runs in the context of the listen() call. */
        ScrNetServer *srv = (ScrNetServer *)udata;
        ScrAlsCtx *prev = scr_als_dispatch_enter(srv->listen_ctx);
        scr_net_server_accept(srv);
        scr_als_dispatch_leave(prev);
      } else if (kind == SCR_NET_K_SOCKET) {
        ScrNetSocket *s = (ScrNetSocket *)udata;
        /* A callback earlier in this batch may have closed this fd
         * (destroy inside a data listener) — its remaining events are
         * stale; the handle itself stays alive until the sweep. */
        if (s->fd < 0) continue;
        /* The socket's events run in its AsyncLocalStorage context. */
        ScrAlsCtx *prev = scr_als_dispatch_enter(s->als);
        bool ok = scr_net_sock_event(s, evs[i].events);
        scr_als_dispatch_leave(prev);
        if (!ok) return;
      }
      if (scr_exc_pending()) return;
    }
    if (!scr_net_flags_pending() && !may_drain) return;
    if (scr_loop_has_ready()) {
      /* microtasks interleave first; a full batch's rest drains on the
       * next call, still within this poll phase */
      if (may_drain) scr_loop_io_reopen();
      return;
    }
  }
}

/* Exit-time registry cleanup (the events-unit precedent): handles a
 * program legitimately leaves live at exit — a server running until
 * SIGTERM, sockets the peer never closed — release their listeners and
 * registry references so the RC audit sees a clean heap. */
static void scr_net_cleanup_atexit(void) {
  while (scr_net_socks) {
    ScrNetSocket *s = scr_net_socks;
    scr_net_ls_drop(&s->data_ls);
    scr_net_ls_drop(&s->end_ls);
    scr_net_ls_drop(&s->close_ls);
    scr_net_ls_drop(&s->err_ls);
    scr_net_ls_drop(&s->conn_ls);
    scr_net_ls_drop(&s->timeout_ls);
    scr_net_ls_drop(&s->readable_ls);
    scr_net_ls_drop(&s->lookup_ls);
    /* Tear down the protocol layer's parser NOW: an in-flight http
     * exchange (a handler that threw before res.end()) holds req/res,
     * and the res holds this socket back — a cycle the lean untraced
     * handles cannot collect, visible only to the RC audit. No reads
     * follow at exit, so the parser hooks unhook first and the ctx
     * frees (scr_http_conn_free drops the in-flight pair; its close
     * emits are discarded at exit — the http unit's exiting flag). */
    if (s->native_ctx_free) {
      void (*ctx_free)(void *) = s->native_ctx_free;
      void *ctx = s->native_ctx;
      s->native_ctx_free = NULL;
      s->native_ctx = NULL;
      s->native_data = NULL;
      s->native_eof = NULL;
      s->native_closed = NULL;
      s->native_timeout = NULL;
      s->native_http_timeout = NULL;
      s->native_established = NULL;
      s->native_err = NULL;
      ctx_free(ctx);
    }
    if (s->pipe_dst) {
      scr_net_sock_release(s->pipe_dst);
      s->pipe_dst = NULL;
    }
    if (s->conn_pending) {
      scr_net_server_release(s->conn_pending);
      s->conn_pending = NULL;
    }
    if (s->server) {
      s->server->nconns--;
      scr_net_server_release(s->server);
      s->server = NULL;
    }
    /* a wrapped socket and the socket that took it over hold each other */
    if (s->adopted_by) {
      ScrNetSocket *t = s->adopted_by;
      s->adopted_by = NULL;
      scr_net_sock_release(t);
    }
    if (s->adopted_from) {
      ScrNetSocket *raw = s->adopted_from;
      s->adopted_from = NULL;
      scr_net_sock_release(raw);
    }
    scr_net_sock_unregister(s);
  }
  while (scr_net_servers) {
    ScrNetServer *s = scr_net_servers;
    scr_net_ls_drop(&s->conn_ls);
    scr_net_ls_drop(&s->err_ls);
    scr_net_ls_drop(&s->close_ls);
    scr_net_ls_drop(&s->listening_cbs);
    scr_closure_release(s->close_override);
    s->close_override = NULL;
    scr_net_server_unregister(s);
  }
}

void scr_net_install(void) {
  static SCR_TL bool installed = false;
  if (installed) return;
  installed = true;
  scr_atexit(scr_net_cleanup_atexit);
  scr_loop_set_net(&scr_net_pending, &scr_net_dispatch, &scr_net_pollfd);
  scr_loop_set_net_io(&scr_net_io);
}

/* ── checked-dynamic handle dispatch (SCR_DYNH_NET_SOCKET ops) ─────────
 * The socket half of the HANDLE crossing (scr_http.c hosts the req/res
 * half and the shared design comment): members dispatch onto the same
 * entry points the static lowerings use; real-but-unmodeled members meet
 * the "not supported yet" error path; unknown names answer Node's own
 * shapes ("<what> is not a function" / the undefined singleton). */

static void scr_net_dynh_unsupported(const char *member, const char *why) {
  char msg[160];
  int n = snprintf(msg, sizeof msg, "'Socket.prototype.%s' on a dynamic value is not supported yet%s%s",
                   member, why ? " — " : "", why ? why : "");
  scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
}

/* The TLS-member hooks (scr_tls.c registers them when linked): TLSSocket
 * property reads, event names, and method names layer over the plain
 * socket dispatch without this unit naming that one's symbols. */
static SCR_TL const ScrNetDynhTlsHooks *scr_net_dynh_tls = NULL;
void scr_net_set_dynh_tls(const ScrNetDynhTlsHooks *hooks) { scr_net_dynh_tls = hooks; }

static bool scr_net_dynh_name_is(const ScrDyn *name, const char *lit) {
  size_t n = strlen(lit);
  return name->kind == SCR_DYN_STR && name->v.str->len == n &&
         memcmp(name->v.str->data, lit, n) == 0;
}

static ScrDyn *scr_net_dynh_sock_invoke(void *h, ScrDyn *self, const char *method,
                                        ScrDyn *const *args, size_t argc, const char *what) {
  ScrNetSocket *s = (ScrNetSocket *)h;
  bool reg = false, once = false;
  if (strcmp(method, "on") == 0 || strcmp(method, "addListener") == 0) reg = true;
  else if (strcmp(method, "once") == 0) { reg = true; once = true; }
  if (reg) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    const ScrDyn *cb = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(cb, "listener");
    if (scr_exc_pending()) return NULL;
    if (scr_net_dynh_name_is(name, "data")) {
      scr_net_sock_on_data(s, scr_dyn_listener_closure_data(cb), (ScrNetDataFn)&scr_dyn_listener_fire_data, once);
    } else if (scr_net_dynh_name_is(name, "end")) {
      scr_net_sock_on_end(s, scr_dyn_listener_closure0(cb), once);
    } else if (scr_net_dynh_name_is(name, "close")) {
      scr_net_sock_on_close(s, scr_dyn_listener_closure0(cb), once);
    } else if (scr_net_dynh_name_is(name, "error")) {
      scr_net_sock_on_error(s, scr_dyn_listener_closure_err(cb), (ScrChildErrFn)&scr_dyn_listener_fire_err, once);
    } else if (scr_net_dynh_name_is(name, "connect")) {
      scr_net_sock_on_connect(s, scr_dyn_listener_closure0(cb), once);
    } else if (scr_net_dynh_name_is(name, "timeout")) {
      scr_net_sock_on_timeout(s, scr_dyn_listener_closure0(cb), once);
    } else if (scr_net_dynh_name_is(name, "readable")) {
      scr_net_sock_on_readable(s, scr_dyn_listener_closure0(cb), once);
    } else if (scr_net_dynh_name_is(name, "finish")) {
      /* fires once when the FIN goes out — once either way */
      scr_net_sock_on_finish(s, scr_dyn_listener_closure0(cb));
    } else if (scr_net_dynh_name_is(name, "drain")) {
      /* This surface never backpressures (write answers true) — an
       * accepted, never-fired registration is the consistent answer. */
    } else if (scr_net_dynh_tls != NULL && name->kind == SCR_DYN_STR &&
               scr_net_dynh_tls->on(s, name->v.str->data, cb, once)) {
      /* a TLS event name ('secureConnect'), handled by the TLS unit */
    } else {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "listening for '");
      if (name->kind == SCR_DYN_STR) {
        scr_jb_write(&b, name->v.str->data, name->v.str->len);
      }
      scr_jb_puts(&b, "' on a dynamic Socket is not supported yet");
      scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "write") == 0) {
    const ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
    if (chunk->kind != SCR_DYN_STR && chunk->kind != SCR_DYN_BYTES) {
      scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", chunk);
      return NULL;
    }
    if (chunk->kind == SCR_DYN_STR) scr_net_sock_write_str(s, chunk->v.str);
    else scr_net_sock_write_bytes(s, chunk->v.bytes);
    if (argc > 1 && args[1]->kind == SCR_DYN_FUNC) {
      /* write(chunk, cb): fires when the buffer drains (sweep-deferred) */
      scr_net_sock_on_write_flush(s, scr_dyn_listener_closure0(args[1]));
    }
    return scr_dyn_new_bool(true); /* backpressure is not modeled (SEMANTICS.md) */
  }
  if (strcmp(method, "end") == 0) {
    const ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
    const ScrDyn *cb = NULL;
    if (chunk->kind == SCR_DYN_FUNC) { /* end(callback) */
      cb = chunk;
      chunk = scr_dyn_undefined();
    } else if (argc > 1 && args[1]->kind == SCR_DYN_FUNC) {
      cb = args[1]; /* end(chunk, callback) */
    }
    if (cb != NULL) scr_net_sock_on_finish(s, scr_dyn_listener_closure0(cb));
    if (chunk->kind == SCR_DYN_STR) scr_net_sock_end_str(s, chunk->v.str);
    else if (chunk->kind == SCR_DYN_BYTES) scr_net_sock_end_bytes(s, chunk->v.bytes);
    else if (chunk->kind == SCR_DYN_UNDEF || argc == 0) scr_net_sock_end(s);
    else {
      scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", chunk);
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "pause") == 0) {
    scr_net_sock_release(scr_net_sock_pause(s)); /* the chaining +1; self answers */
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "resume") == 0) {
    scr_net_sock_release(scr_net_sock_resume(s));
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "setNoDelay") == 0) {
    /* setNoDelay([enable]) — missing/undefined means true, Node */
    bool enable = argc == 0 || args[0]->kind == SCR_DYN_UNDEF || scr_dyn_truthy(args[0]);
    scr_net_sock_release(scr_net_sock_set_nodelay(s, enable));
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "destroySoon") == 0) {
    scr_net_sock_destroy_soon(s);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "destroy") == 0) {
    if (argc > 0 && args[0]->kind != SCR_DYN_UNDEF) {
      scr_net_dynh_unsupported("destroy", "destroy(error) carries a payload this surface does not model");
      return NULL;
    }
    scr_net_sock_destroy(s);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "setTimeout") == 0) {
    const ScrDyn *ms = argc > 0 ? args[0] : scr_dyn_undefined();
    if (ms->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("msecs", "of type number", ms);
      return NULL;
    }
    if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF && args[1]->kind != SCR_DYN_FUNC) {
      scr_dyn_check_listener(args[1], "callback");
      return NULL;
    }
    if (!scr_net_timeout_msecs_valid(ms->v.num)) return NULL;
    scr_net_sock_set_timeout(s, ms->v.num);
    if (argc > 1 && args[1]->kind == SCR_DYN_FUNC) {
      if (ms->v.num == 0) scr_net_ls_remove_fn(&s->timeout_ls, args[1]->v.fn.clo);
      else scr_net_sock_on_timeout(s, scr_dyn_listener_closure0(args[1]), true);
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "setKeepAlive") == 0) {
    bool enable = argc > 0 && scr_dyn_truthy(args[0]);
    double delay = 0;
    if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF) scr_dyn_number_coerce_js(args[1], &delay);
    scr_net_sock_set_keepalive(s, enable, delay);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "setEncoding") == 0) {
    const ScrDyn *enc = argc > 0 ? args[0] : scr_dyn_undefined();
    if (enc->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("encoding", "of type string", enc);
      return NULL;
    }
    scr_net_sock_set_encoding(s, enc->v.str);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "pipe") == 0) {
    const ScrDyn *dst = argc > 0 ? args[0] : scr_dyn_undefined();
    if (dst->kind == SCR_DYN_HANDLE && dst->v.handle.tag == SCR_DYNH_NET_SOCKET) {
      scr_net_sock_pipe(s, (ScrNetSocket *)dst->v.handle.ptr);
      return scr_dyn_retain((ScrDyn *)dst);
    }
    if (dst->kind == SCR_DYN_HANDLE) {
      /* Cross-unit destinations (a ServerResponse) accept the source
       * through their pipe_from hook — this unit cannot name theirs. */
      const ScrDynHandleOps *dops = scr_dyn_handle_ops_of(dst);
      if (dops->pipe_from && dops->pipe_from(dst->v.handle.ptr, self)) {
        return scr_dyn_retain((ScrDyn *)dst);
      }
    }
    scr_net_dynh_unsupported("pipe", "only Socket and ServerResponse destinations are modeled");
    return NULL;
  }
  if (strcmp(method, "toString") == 0) {
    ScrStr *str = scr_str_new("[object Object]", 15);
    ScrDyn *d = scr_dyn_new_str(str);
    scr_str_release(str);
    return d;
  }
  if (strcmp(method, "ref") == 0 || strcmp(method, "unref") == 0) {
    scr_net_sock_set_ref(s, method[0] == 'r');
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "address") == 0) return scr_net_sock_address(s);
  if (strcmp(method, "resetAndDestroy") == 0) {
    scr_net_sock_release(scr_net_sock_reset_and_destroy(s));
    return scr_exc_pending() ? NULL : scr_dyn_retain(self);
  }
  if (scr_net_dynh_tls != NULL) {
    ScrDyn *out = NULL;
    if (scr_net_dynh_tls->invoke(s, method, args, argc, &out)) return out;
  }
  {
    static const char *const known[] = { "connect",
      "cork", "uncork", "read", "unpipe",
      "off", "removeListener", "removeAllListeners", "emit", "prependListener",
      "prependOnceListener", "listenerCount", "listeners", NULL };
    for (size_t i = 0; known[i]; i++) {
      if (strcmp(method, known[i]) == 0) {
        scr_net_dynh_unsupported(method, NULL);
        return NULL;
      }
    }
  }
  {
    char msg[160];
    int n = snprintf(msg, sizeof msg, "%s is not a function", what);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
  }
  return NULL;
}

static ScrDyn *scr_net_dynh_sock_get(void *h, const char *key, size_t key_len) {
  ScrNetSocket *s = (ScrNetSocket *)h;
  (void)key_len;
  if (strcmp(key, "destroyed") == 0) return scr_dyn_new_bool(scr_net_sock_destroyed(s));
  if (strcmp(key, "writable") == 0) return scr_dyn_new_bool(scr_net_sock_writable(s));
  if (strcmp(key, "remoteAddress") == 0) {
    ScrStr *a = scr_net_sock_remote_address(s);
    if (!a) return NULL; /* the undefined arm, the static lane's split */
    ScrDyn *d = scr_dyn_new_str(a);
    scr_str_release(a);
    return d;
  }
  if (strcmp(key, "encrypted") == 0) {
    /* Node types `encrypted: true` on TLSSocket only; plain sockets read
     * undefined — the static lane's false→undefined mapping. */
    return scr_net_sock_encrypted(s) ? scr_dyn_new_bool(true) : NULL;
  }
  if (strcmp(key, "bytesWritten") == 0) return scr_dyn_new_num(scr_net_sock_bytes_written(s));
  if (strcmp(key, "bytesRead") == 0) return scr_dyn_new_num(scr_net_sock_bytes_read(s));
  if (strcmp(key, "connecting") == 0) return scr_dyn_new_bool(scr_net_sock_connecting(s));
  if (strcmp(key, "pending") == 0) return scr_dyn_new_bool(scr_net_sock_pending(s));
  if (strcmp(key, "readyState") == 0) {
    ScrStr *state = scr_net_sock_ready_state(s);
    ScrDyn *d = scr_dyn_new_str(state);
    scr_str_release(state);
    return d;
  }
  {
    static const char *const fields[] = { "remotePort", "remoteFamily", "localAddress", "localPort",
                                          "localFamily", NULL };
    for (size_t i = 0; fields[i]; i++) {
      if (strcmp(key, fields[i]) != 0) continue;
      ScrDyn *d = scr_net_sock_addr_field(s, (double)i);
      if (d->kind == SCR_DYN_UNDEF) {
        scr_dyn_release(d);
        return NULL;
      }
      return d;
    }
  }
  if (strcmp(key, "readable") == 0) return scr_dyn_new_bool(scr_net_sock_readable(s));
  if (strcmp(key, "writableHighWaterMark") == 0 || strcmp(key, "readableHighWaterMark") == 0) {
    /* Node's default stream highWaterMark — a constant here (backpressure
     * is not modeled; SEMANTICS.md) */
    return scr_dyn_new_num(16384);
  }
  if (scr_net_dynh_tls != NULL) {
    ScrDyn *out = NULL;
    if (scr_net_dynh_tls->get(s, key, &out)) return out;
  }
  {
    static const char *const known[] = { "bufferSize", "timeout", "closed", "errored", NULL };
    for (size_t i = 0; known[i]; i++) {
      if (strcmp(key, known[i]) == 0) {
        scr_net_dynh_unsupported(key, NULL);
        return NULL;
      }
    }
  }
  return NULL;
}

static bool scr_net_dynh_sock_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  return false;
}

static const ScrDynHandleOps scr_net_dynh_sock_ops = {
  "Socket",
  &scr_net_sock_retain_v,
  &scr_net_sock_release_v,
  &scr_net_dynh_sock_invoke,
  &scr_net_dynh_sock_get,
  &scr_net_dynh_sock_set,
  NULL,
};

/* ── checked-dynamic handle dispatch (SCR_DYNH_NET_SERVER ops) ─────────
 * The server half: `let server; server = createServer(...)` puts the
 * handle into a dyn binding, and every listener body's `this` answers
 * the emitting server (the ambient receiver) — both dispatch here.
 * Members ride the same entry points the static lowerings use. HTTP
 * server events ('request') route through the hook scr_http.c registers
 * at its dyn install — this unit cannot name http entry points without
 * breaking the link gate. */

static SCR_TL bool (*scr_net_dynh_http_on)(ScrNetServer *s, const char *event, const ScrDyn *cb,
                                    bool once);
void scr_net_set_dynh_http_on(bool (*fn)(ScrNetServer *, const char *, const ScrDyn *, bool)) {
  scr_net_dynh_http_on = fn;
}

static void scr_net_dynh_srv_unsupported(const char *member, const char *why) {
  char msg[160];
  int n = snprintf(msg, sizeof msg, "'Server.prototype.%s' on a dynamic value is not supported yet%s%s",
                   member, why ? " — " : "", why ? why : "");
  scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
}

/* The 'connection' fire for a dyn listener: box the socket by reference
 * and call through the checked-dynamic machinery (the ScrNetConnFn ABI —
 * sock arrives +1 and the adapter owns it, like the static adapters). */
static void scr_net_dynh_fire_conn(ScrClosure *cb, ScrNetSocket *sock /* +1 */) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *dsock = scr_dyn_new_handle(sock, SCR_DYNH_NET_SOCKET);
  ScrDyn *args[1] = { dsock };
  ScrDyn *r = scr_dyn_call(fn, args, 1, "listener");
  scr_dyn_release(r);
  scr_dyn_release(dsock);
  scr_dyn_release(fn);
  scr_net_sock_release(sock);
}

/* server.address() — Node's { address, family, port } object, null while
 * not listening (never bound, or already closed). */
static ScrDyn *scr_net_dynh_srv_address(ScrNetServer *s) {
  if (!s->listening || s->fd < 0) return scr_dyn_new_null();
  ScrDyn *o = scr_dyn_new_obj();
  {
    ScrStr *a = s->bound_host ? scr_str_retain(s->bound_host)
                              : scr_str_new(s->bound_v6 ? "::" : "0.0.0.0", s->bound_v6 ? 2 : 7);
    scr_dyn_obj_set(o, "address", 7, scr_dyn_new_str(a));
    scr_str_release(a);
  }
  {
    const char *fam = s->bound_v6 ? "IPv6" : "IPv4";
    ScrStr *f = scr_str_new(fam, 4);
    scr_dyn_obj_set(o, "family", 6, scr_dyn_new_str(f));
    scr_str_release(f);
  }
  scr_dyn_obj_set(o, "port", 4, scr_dyn_new_num((double)s->port));
  return o;
}

static ScrDyn *scr_net_dynh_srv_invoke(void *h, ScrDyn *self, const char *method,
                                       ScrDyn *const *args, size_t argc, const char *what) {
  ScrNetServer *s = (ScrNetServer *)h;
  bool reg = false, once = false;
  if (strcmp(method, "on") == 0 || strcmp(method, "addListener") == 0) reg = true;
  else if (strcmp(method, "once") == 0) { reg = true; once = true; }
  if (reg) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    const ScrDyn *cb = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(cb, "listener");
    if (scr_exc_pending()) return NULL;
    if (scr_net_dynh_name_is(name, "listening")) {
      scr_net_server_on_listening(s, scr_dyn_listener_closure0(cb), once);
    } else if (scr_net_dynh_name_is(name, "close")) {
      scr_net_server_on_close(s, scr_dyn_listener_closure0(cb), once);
    } else if (scr_net_dynh_name_is(name, "error")) {
      scr_net_server_on_error(s, scr_dyn_listener_closure_err(cb),
                              (ScrChildErrFn)&scr_dyn_listener_fire_err, once);
    } else if (scr_net_dynh_name_is(name, "connection")) {
      scr_net_server_on_connection(s, scr_dyn_listener_closure_fn(cb, (void *)&scr_net_dynh_fire_conn),
                                   (ScrNetConnFn)&scr_net_dynh_fire_conn, once);
    } else if (scr_net_dynh_name_is(name, "secureConnection") && s->defer_conn) {
      /* a TLS server's 'connection' list IS post-handshake (deferred) —
       * exactly Node's secureConnection timing; on a plain server the
       * name falls through to the fence below */
      scr_net_server_on_connection(s, scr_dyn_listener_closure_fn(cb, (void *)&scr_net_dynh_fire_conn),
                                   (ScrNetConnFn)&scr_net_dynh_fire_conn, once);
    } else if (name->kind == SCR_DYN_STR && scr_net_dynh_http_on &&
               scr_net_dynh_http_on(s, name->v.str->data, cb, once)) {
      /* the http layer accepted the event ('request') */
    } else {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "listening for '");
      if (name->kind == SCR_DYN_STR) {
        scr_jb_write(&b, name->v.str->data, name->v.str->len);
      }
      scr_jb_puts(&b, "' on a dynamic Server is not supported yet");
      scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "listen") == 0) {
    /* listen([port][, host][, cb]) — the static lowering's shapes over
     * dyn arguments; the options-object form throws the 'not supported yet'
     * Error. */
    double port = 0;
    ScrStr *host = NULL;
    const ScrDyn *cb = NULL;
    size_t i = 0;
    if (i < argc && args[i]->kind == SCR_DYN_NUM) { port = args[i]->v.num; i++; }
    else if (i < argc && args[i]->kind == SCR_DYN_STR && args[i]->v.str->len > 0 &&
             args[i]->v.str->data[0] >= '0' && args[i]->v.str->data[0] <= '9') {
      /* Node coerces a numeric port string */
      port = strtod(args[i]->v.str->data, NULL);
      i++;
    } else if (i < argc && args[i]->kind == SCR_DYN_OBJ) {
      scr_net_dynh_srv_unsupported("listen", "the options-object form on a dynamic value is not modeled (use listen(port[, host][, cb]))");
      return NULL;
    }
    if (i < argc && args[i]->kind == SCR_DYN_STR) { host = args[i]->v.str; i++; }
    if (i < argc && args[i]->kind == SCR_DYN_FUNC) { cb = args[i]; i++; }
    if (i < argc && args[i]->kind != SCR_DYN_UNDEF && args[i]->kind != SCR_DYN_NULL) {
      scr_net_dynh_srv_unsupported("listen", "unrecognized arguments (the modeled shape is listen(port[, host][, cb]))");
      return NULL;
    }
    ScrClosure *clo = cb ? scr_dyn_listener_closure0(cb) : NULL;
    if (host) scr_net_listen_opts(s, port, host, false, clo);
    else scr_net_listen(s, port, clo);
    return scr_dyn_retain(self); /* Node's `return this` chaining */
  }
  if (strcmp(method, "close") == 0) {
    const ScrDyn *cb = argc > 0 ? args[0] : scr_dyn_undefined();
    if (cb->kind == SCR_DYN_FUNC) {
      scr_net_server_close(s, scr_dyn_listener_closure0(cb));
    } else if (cb->kind == SCR_DYN_UNDEF || argc == 0) {
      scr_net_server_close(s, NULL);
    } else {
      scr_dyn_check_listener(cb, "callback");
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "address") == 0) {
    return scr_net_dynh_srv_address(s);
  }
  if (strcmp(method, "emit") == 0 && argc > 0 && scr_net_dynh_name_is(args[0], "connection")) {
    const ScrDyn *sockd = argc > 1 ? args[1] : scr_dyn_undefined();
    if (sockd->kind == SCR_DYN_HANDLE && sockd->v.handle.tag == SCR_DYNH_NET_SOCKET) {
      scr_net_server_emit_connection(s, (ScrNetSocket *)sockd->v.handle.ptr);
      return scr_dyn_new_bool(true);
    }
    scr_dyn_arg_type_fail("socket", "an instance of Socket", sockd);
    return NULL;
  }
  if (strcmp(method, "ref") == 0 || strcmp(method, "unref") == 0) {
    scr_net_server_set_ref((ScrNetServer *)h, method[0] == 'r');
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "getConnections") == 0) {
    const ScrDyn *cb = argc > 0 ? args[0] : scr_dyn_undefined();
    if (cb->kind != SCR_DYN_FUNC) {
      scr_dyn_check_listener(cb, "callback");
      return NULL;
    }
    scr_net_server_get_connections((ScrNetServer *)h, cb);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "toString") == 0) {
    ScrStr *str = scr_str_new("[object Object]", 15);
    ScrDyn *d = scr_dyn_new_str(str);
    scr_str_release(str);
    return d;
  }
  {
    static const char *const known[] = { "setTimeout",
      "off", "removeListener", "removeAllListeners", "emit", "prependListener",
      "prependOnceListener", "listenerCount", "listeners", "closeAllConnections",
      "closeIdleConnections", NULL };
    for (size_t i = 0; known[i]; i++) {
      if (strcmp(method, known[i]) == 0) {
        scr_net_dynh_srv_unsupported(method, NULL);
        return NULL;
      }
    }
  }
  {
    char msg[160];
    int n = snprintf(msg, sizeof msg, "%s is not a function", what);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
  }
  return NULL;
}

static int scr_net_dynh_srv_timeout_field(const char *key) {
  if (strcmp(key, "timeout") == 0) return 0;
  if (strcmp(key, "keepAliveTimeout") == 0) return 1;
  if (strcmp(key, "headersTimeout") == 0) return 2;
  if (strcmp(key, "requestTimeout") == 0) return 3;
  if (strcmp(key, "keepAliveTimeoutBuffer") == 0) return 4;
  return -1;
}

static ScrDyn *scr_net_dynh_srv_get(void *h, const char *key, size_t key_len) {
  ScrNetServer *s = (ScrNetServer *)h;
  (void)key_len;
  if (strcmp(key, "listening") == 0) return scr_dyn_new_bool(s->listening);
  int timeout_field = scr_net_dynh_srv_timeout_field(key);
  if (timeout_field >= 0 && s->http_timeout_surface) {
    if (s->http_timeout_dyn[timeout_field] != NULL) {
      return scr_dyn_retain(s->http_timeout_dyn[timeout_field]);
    }
    return scr_dyn_new_num(scr_net_server_timeout_get(s, (double)timeout_field));
  }
  {
    if (strcmp(key, "maxConnections") == 0) return s->max_conns_set ? scr_dyn_new_num(s->max_conns) : NULL;
    if (strcmp(key, "dropMaxConnection") == 0)
      return s->drop_max_connection != NULL ? scr_dyn_retain(s->drop_max_connection) : NULL;
    static const char *const known[] = { "connections", "maxHeadersCount", NULL };
    for (size_t i = 0; known[i]; i++) {
      if (strcmp(key, known[i]) == 0) {
        scr_net_dynh_srv_unsupported(key, NULL);
        return NULL;
      }
    }
  }
  return NULL;
}

static bool scr_net_dynh_srv_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrNetServer *s = (ScrNetServer *)h;
  (void)key_len;
  int timeout_field = scr_net_dynh_srv_timeout_field(key);
  if (timeout_field >= 0 && s->http_timeout_surface) {
    if (value->kind == SCR_DYN_NUM) {
      scr_net_server_timeout_set(s, (double)timeout_field, value->v.num);
    } else {
      scr_dyn_release(s->http_timeout_dyn[timeout_field]);
      s->http_timeout_dyn[timeout_field] = scr_dyn_retain((ScrDyn *)value);
    }
    return true;
  }
  if (strcmp(key, "maxConnections") == 0) {
    scr_net_server_max_connections_set(s, value);
    return true;
  }
  if (strcmp(key, "dropMaxConnection") == 0) {
    scr_net_server_drop_max_connection_set(s, value);
    return true;
  }
  return false;
}

static const ScrDynHandleOps scr_net_dynh_srv_ops = {
  "Server",
  &scr_net_server_retain_v,
  &scr_net_server_release_v,
  &scr_net_dynh_srv_invoke,
  &scr_net_dynh_srv_get,
  &scr_net_dynh_srv_set,
  NULL,
};

void scr_net_dyn_install(void) {
  scr_dyn_handle_install(SCR_DYNH_NET_SOCKET, &scr_net_dynh_sock_ops);
  scr_dyn_handle_install(SCR_DYNH_NET_SERVER, &scr_net_dynh_srv_ops);
}

/* Checked-dynamic chunks into a TYPED socket (an untyped JS payload
 * flowing into socket.write/end — the static lowering's dyn-data arm):
 * STR/BYTES dispatch onto the typed entries; undefined/null end()s plain
 * (Node accepts them); anything else throws Node's ERR_INVALID_ARG_TYPE
 * chunk TypeError. Both borrowed. */
void scr_net_sock_write_dynv(ScrNetSocket *s, const ScrDyn *d) {
  if (d->kind == SCR_DYN_STR) scr_net_sock_write_str(s, d->v.str);
  else if (d->kind == SCR_DYN_BYTES) scr_net_sock_write_bytes(s, d->v.bytes);
  else scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", d);
}

void scr_net_sock_end_dynv(ScrNetSocket *s, const ScrDyn *d) {
  if (d->kind == SCR_DYN_STR) scr_net_sock_end_str(s, d->v.str);
  else if (d->kind == SCR_DYN_BYTES) scr_net_sock_end_bytes(s, d->v.bytes);
  else if (d->kind == SCR_DYN_UNDEF || d->kind == SCR_DYN_NULL) scr_net_sock_end(s);
  else scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", d);
}
