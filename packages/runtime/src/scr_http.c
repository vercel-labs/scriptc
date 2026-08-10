/* node:http — the SERVER and CLIENT slices, layered on scr_net.c's
 * native hooks: a hand-written HTTP/1.1 parser (request OR status line,
 * headers, Content-Length / chunked / read-to-EOF bodies, keep-alive)
 * and Node-shaped serializers (the response's writeHead/setHeader/end
 * with Content-Length or chunked framing, the Date header, keep-alive
 * Connection headers; the client's request head with Node's exact
 * header order and framing decisions).
 *
 * The CLIENT (scr_http_request — http.request/http.get): one dialed
 * connection per request, NO agent pooling (the wire still carries
 * Node's Connection: keep-alive; the socket closes when the response
 * completes — SEMANTICS.md). The response is an ordinary ScrHttpReq
 * (IncomingMessage) parsed in RESPONSE mode: status line instead of
 * request line, and a body that may be EOF-delimited; HEAD/204/304
 * responses have none. Error shapes are Node's: the net layer's
 * 'connect ECONNREFUSED ip:port' via the socket's native error hook, a
 * premature close before any response is 'socket hang up' on the
 * request, and mid-body death is 'aborted' on the RESPONSE (the request
 * just closes) — all pinned by the client differential fixtures.
 * Deferred 'close' emits ride the emit QUEUE drained from scr_net.c's
 * proto sweep, so req/res 'close' fire a pass after the work that
 * flagged them, Node's later-than-the-handler ordering (client order:
 * res 'end', req 'close', res 'close').
 * NO external dependencies — the parser implements exactly what the
 * differential fixtures and portless-shaped handlers exercise, and
 * SEMANTICS.md states its bounds honestly.
 *
 * Object model: http.createServer returns an ORDINARY ScrNetServer (the
 * frontend maps http.Server to the same netServer kind — listen/close/
 * address()/error all reuse the net lowering) whose native-connection
 * hook installs one ScrHttpConn parser per accepted socket. ScrHttpReq /
 * ScrHttpRes are lean refcounted handles (the ScrChild story): the req
 * holds the parsed method/url/headers and the body listener lists
 * (dropped when the body completes or the connection dies); the res
 * holds the socket (+1), the pending header list, and the framing state.
 *
 * Keep-alive: HTTP/1.1 requests keep the connection open (1.0 opts in
 * with Connection: keep-alive) and the parser resets for the next
 * request on the same socket, pipelining included; Connection: close —
 * either side — ends the socket after the response finishes. There is NO
 * idle keep-alive timeout in this slice (Node reaps idle connections
 * after server.keepAliveTimeout, 5s — SEMANTICS.md); real clients close
 * their idle sockets and the fixtures' drivers do too.
 *
 * Event dispatch rides scr_net.c wholesale: the request handler and the
 * req 'data'/'end' listeners fire from the socket read path (macrotasks,
 * snapshot semantics, once-before-run), and errors/teardown follow the
 * socket's own story. */
#include "scr_runtime.h"

#include <ctype.h>
#include <math.h> /* INFINITY — the Agent's maxSockets default */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void scr_http_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* Node's STATUS_CODES reason phrases (the slice's subset; everything the
 * fixtures and portless's handlers send, plus the common neighbors). */
static const char *scr_http_reason(int code) {
  switch (code) {
  case 100: return "Continue";
  case 101: return "Switching Protocols";
  case 200: return "OK";
  case 201: return "Created";
  case 202: return "Accepted";
  case 204: return "No Content";
  case 206: return "Partial Content";
  case 301: return "Moved Permanently";
  case 302: return "Found";
  case 303: return "See Other";
  case 304: return "Not Modified";
  case 307: return "Temporary Redirect";
  case 308: return "Permanent Redirect";
  case 400: return "Bad Request";
  case 401: return "Unauthorized";
  case 403: return "Forbidden";
  case 404: return "Not Found";
  case 405: return "Method Not Allowed";
  case 408: return "Request Timeout";
  case 409: return "Conflict";
  case 410: return "Gone";
  case 413: return "Payload Too Large";
  case 414: return "URI Too Long";
  case 415: return "Unsupported Media Type";
  case 429: return "Too Many Requests";
  case 431: return "Request Header Fields Too Large";
  case 500: return "Internal Server Error";
  case 501: return "Not Implemented";
  case 502: return "Bad Gateway";
  case 503: return "Service Unavailable";
  case 504: return "Gateway Timeout";
  case 508: return "Loop Detected";
  default: return "unknown";
  }
}

/* ── the h2 compat transport seam ────────────────────────────────────────
 *
 * Http2ServerRequest/Http2ServerResponse ARE these req/res handles: the
 * http/1 surface is the API template, the h2 stream machinery is the
 * transport. scr_http2.c (linked exactly when the program uses the real
 * h2 surface — this unit can link WITHOUT it) installs a vtable for the
 * response write paths (HEADERS/DATA frames instead of HTTP/1 bytes) and
 * a request-registration hook so server.on("request", ...) on an
 * h2-tagged server ctx routes to the h2 request list. The vtable's
 * typedef lives in scr_runtime.h (both units name it). */
static const ScrHttpH2Ops *scr_http_h2_ops = NULL;
static void (*scr_http_h2_request_hook)(void *h2ctx, ScrClosure *cb /*moves*/,
                                        void *fn, bool once) = NULL;

void scr_http_set_h2_ops(const ScrHttpH2Ops *ops) { scr_http_h2_ops = ops; }

void scr_http_set_h2_request_hook(void (*hook)(void *h2ctx, ScrClosure *cb, void *fn, bool once)) {
  scr_http_h2_request_hook = hook;
}

/* ── the request handle ──────────────────────────────────────────────── */

struct ScrHttpReq {
  size_t rc;
  int status;      /* -1 on server requests (Node's undefined statusCode) */
  ScrStr *method;
  ScrStr *url;
  ScrNetSocket *sock; /* +1 — req.socket, may be NULL defensively */
  void *h2_stream; /* +1 through scr_http_h2_ops — the h2 compat request's
                    * stream (destroy() RSTs it, never the shared socket) */
  ScrStr **hnames;  /* lowercased */
  ScrStr **hnames_raw; /* arrival case — rawHeaders */
  ScrStr **hvalues;
  size_t nheaders;
  ScrStr *status_msg; /* client responses' reason phrase; NULL on server requests */
  ScrNetLs data_ls, end_ls, err_ls, close_ls;
  /* pipe destinations (req.pipe(...) — one of each kind, +1; released at
   * finish, so a piped destination never outlives the body) */
  ScrHttpRes *pipe_res;
  struct ScrHttpClientReq *pipe_client;
  ScrNetSocket *pipe_sock;
  bool ended; /* body complete (or connection dead): data/end drop */
  bool enc_utf8; /* setEncoding('utf8'): 'data' delivers strings */
  bool http10;   /* the parsed request/status line's version (httpVersion) */
  bool http2;    /* an h2 compat request (httpVersion "2.0") */
  bool aborted;  /* h2: the stream died with our writable side open */
  bool close_queued;
  bool close_emitted; /* settled: err/close listeners dropped */
  bool join_dup; /* joinDuplicateHeaders: repeated names read joined ", " */
  /* pause(): delivery holds — arrived body bytes buffer in pend (the
   * parser keeps consuming; memory is the buffer, a documented bound)
   * and 'end' defers (end_pending) until resume() drains through the
   * emit queue, never the resuming stack. */
  bool paused;
  bool end_pending;
  bool drain_queued;
  char *pend;
  size_t pend_len, pend_cap;
  bool destroyed; /* req.destroy()/the teardown ran — req.destroyed */
  ScrNetLs aborted_ls; /* req.on('aborted') — the h2 compat event */
};

#ifdef SCR_RC_AUDIT
static long scr_http_live = 0;
long scr_http_live_count(void) { return scr_http_live; }
#endif

ScrHttpReq *scr_http_req_retain(ScrHttpReq *r) {
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

/* req.setEncoding(enc) — IncomingMessage's readable setEncoding (server
 * requests and client responses alike): utf8 flips 'data' delivery to
 * strings (the chunk-encoding window); other REAL Node encodings meet
 * the loud not-supported ladder; unknown names throw Node's
 * ERR_UNKNOWN_ENCODING TypeError. */
void scr_http_req_set_encoding(ScrHttpReq *r, ScrStr *enc /*borrowed*/) {
  if ((enc->len == 4 && memcmp(enc->data, "utf8", 4) == 0) ||
      (enc->len == 5 && memcmp(enc->data, "utf-8", 5) == 0)) {
    r->enc_utf8 = true;
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

void scr_http_req_release(ScrHttpReq *r) {
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    scr_str_release(r->method);
    scr_str_release(r->url);
    for (size_t i = 0; i < r->nheaders; i++) {
      scr_str_release(r->hnames[i]);
      scr_str_release(r->hnames_raw[i]);
      scr_str_release(r->hvalues[i]);
    }
    free(r->hnames);
    free(r->hnames_raw);
    free(r->hvalues);
    scr_str_release(r->status_msg);
    scr_net_ls_drop(&r->data_ls);
    scr_net_ls_drop(&r->end_ls);
    scr_net_ls_drop(&r->err_ls);
    scr_net_ls_drop(&r->close_ls);
    scr_net_ls_drop(&r->aborted_ls);
    scr_http_res_release(r->pipe_res);
    scr_http_client_release(r->pipe_client);
    scr_net_sock_release(r->pipe_sock);
    free(r->pend);
    if (r->sock) scr_net_sock_release(r->sock);
    if (r->h2_stream) scr_http_h2_ops->release(r->h2_stream);
#ifdef SCR_RC_AUDIT
    scr_http_live--;
#endif
    free(r);
  }
}

void *scr_http_req_retain_v(void *p) { return scr_http_req_retain((ScrHttpReq *)p); }
void scr_http_req_release_v(void *p) { scr_http_req_release((ScrHttpReq *)p); }

ScrStr *scr_http_req_url(ScrHttpReq *r) { return scr_str_retain(r->url); }
ScrStr *scr_http_req_method(ScrHttpReq *r) { return scr_str_retain(r->method); }

/* Case-insensitive equality of two lowercased-vs-any names. */
static bool scr_http_name_eq(const ScrStr *lower, const ScrStr *name) {
  if (lower->len != name->len) return false;
  for (size_t j = 0; j < name->len; j++) {
    if (lower->data[j] != (char)tolower((unsigned char)name->data[j])) return false;
  }
  return true;
}

/* The joined ", " value of every occurrence of hnames[i]'s name — the
 * joinDuplicateHeaders read (createServer option): Node joins repeats
 * where the default keeps the first. Always +1. */
static ScrStr *scr_http_req_joined_value(ScrHttpReq *r, size_t i) {
  size_t total = 0, count = 0;
  for (size_t k = 0; k < r->nheaders; k++) {
    if (scr_http_name_eq(r->hnames[k], r->hnames[i])) {
      total += r->hvalues[k]->len;
      count++;
    }
  }
  if (count == 1) return scr_str_retain(r->hvalues[i]);
  char *buf = malloc(total + (count - 1) * 2 + 1);
  if (!buf) scr_http_oom();
  size_t off = 0;
  for (size_t k = 0; k < r->nheaders; k++) {
    if (!scr_http_name_eq(r->hnames[k], r->hnames[i])) continue;
    if (off > 0) {
      memcpy(buf + off, ", ", 2);
      off += 2;
    }
    memcpy(buf + off, r->hvalues[k]->data, r->hvalues[k]->len);
    off += r->hvalues[k]->len;
  }
  ScrStr *out = scr_str_new(buf, off);
  free(buf);
  return out;
}

/* The snapshot pairs behind `{ ...req.headers }` (the record-building
 * helper's feed): [lowercased name, value, ...] in arrival order — the
 * same keys the per-name reads answer (under joinDuplicateHeaders a
 * repeated name appears once, at its first position, joined). Always a
 * fresh +1 array. */
ScrArr *scr_http_req_header_pairs(ScrHttpReq *r) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, r->nheaders * 2);
  for (size_t i = 0; i < r->nheaders; i++) {
    if (r->join_dup) {
      bool seen = false;
      for (size_t k = 0; k < i && !seen; k++) {
        seen = scr_http_name_eq(r->hnames[k], r->hnames[i]);
      }
      if (seen) continue;
      scr_arr_push_ref(out, scr_str_retain(r->hnames[i]));
      scr_arr_push_ref(out, scr_http_req_joined_value(r, i));
      continue;
    }
    scr_arr_push_ref(out, scr_str_retain(r->hnames[i]));
    scr_arr_push_ref(out, scr_str_retain(r->hvalues[i]));
  }
  return out;
}

/* req.rawHeaders: [name, value, name, value, ...] in arrival order, names
 * in their ORIGINAL case (Node's shape). Always a fresh +1 array. */
ScrArr *scr_http_req_raw_headers(ScrHttpReq *r) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, r->nheaders * 2);
  for (size_t i = 0; i < r->nheaders; i++) {
    scr_arr_push_ref(out, scr_str_retain(r->hnames_raw[i]));
    scr_arr_push_ref(out, scr_str_retain(r->hvalues[i]));
  }
  return out;
}

/* res.statusMessage: the reason phrase on client responses (+1, "" when
 * the status line carried none); NULL on server requests — the
 * compiler's undefined arm, the statusCode split. */
ScrStr *scr_http_req_status_message(ScrHttpReq *r) {
  return r->status_msg ? scr_str_retain(r->status_msg) : NULL;
}

/* Header lookup by (case-insensitively matched) name: +1 value, or NULL —
 * the compiler's undefined arm, exactly process.envGet's contract. */
ScrStr *scr_http_req_header(ScrHttpReq *r, ScrStr *name) {
  for (size_t i = 0; i < r->nheaders; i++) {
    if (scr_http_name_eq(r->hnames[i], name)) {
      /* joinDuplicateHeaders: every occurrence joins ", " (Node's option);
       * the default answers the first, Node's keep-first rule. */
      return r->join_dup ? scr_http_req_joined_value(r, i) : scr_str_retain(r->hvalues[i]);
    }
  }
  return NULL;
}

/* req.pipe(dest) — the proxy legs: an IncomingMessage body streams into
 * a ServerResponse, a ClientRequest, or a raw socket (chunk-for-chunk, no
 * backpressure — divergence 54's stream model); the body's natural end
 * ends the destination, Node's pipe default. A body that already ended
 * ends the destination NOW (nothing more will flow). */
void scr_http_req_pipe_res(ScrHttpReq *r, ScrHttpRes *dst /*borrowed*/) {
  if (r->ended) {
    scr_http_res_end(dst);
    return;
  }
  if (r->pipe_res) scr_http_res_release(r->pipe_res);
  r->pipe_res = scr_http_res_retain(dst);
}

/* socket.pipe(res) — the extended-CONNECT bridge leg: a native reader on
 * the SOURCE socket turns raw chunks into response body writes (the
 * response's own framing applies) and EOF into res.end(), pipe's
 * default. The ctx owns the response (+1, released with the socket's
 * native-reader teardown); errors/closes need no handling here — the
 * caller registers its own socket listeners (the portless cleanup). */
typedef struct {
  ScrHttpRes *res; /* +1 */
} ScrSockResPipe;

static void scr_http_sock_res_data(void *ctx, const char *buf, size_t n) {
  ScrSockResPipe *p = (ScrSockResPipe *)ctx;
  ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
  if (n > 0) memcpy(chunk->data, buf, n);
  scr_http_res_write_bytes(p->res, chunk);
  scr_bytes_release(chunk);
}

static void scr_http_sock_res_eof(void *ctx) {
  ScrSockResPipe *p = (ScrSockResPipe *)ctx;
  scr_http_res_end(p->res);
}

static void scr_http_sock_res_closed(void *ctx) { (void)ctx; }

static void scr_http_sock_res_free(void *ctx) {
  ScrSockResPipe *p = (ScrSockResPipe *)ctx;
  scr_http_res_release(p->res);
  free(p);
}

void scr_http_sock_pipe_res(ScrNetSocket *src, ScrHttpRes *dst /*borrowed*/) {
  ScrSockResPipe *p = calloc(1, sizeof *p);
  if (!p) scr_http_oom();
  p->res = scr_http_res_retain(dst);
  scr_net_sock_set_native_reader(src, &scr_http_sock_res_data, &scr_http_sock_res_eof,
                                  &scr_http_sock_res_closed, p, &scr_http_sock_res_free);
}

void scr_http_req_pipe_client(ScrHttpReq *r, ScrHttpClientReq *dst /*borrowed*/) {
  if (r->ended) {
    scr_http_client_end(dst);
    return;
  }
  if (r->pipe_client) scr_http_client_release(r->pipe_client);
  r->pipe_client = scr_http_client_retain(dst);
}

void scr_http_req_pipe_sock(ScrHttpReq *r, ScrNetSocket *dst /*borrowed*/) {
  if (r->ended) {
    scr_net_sock_end(dst);
    return;
  }
  if (r->pipe_sock) scr_net_sock_release(r->pipe_sock);
  r->pipe_sock = scr_net_sock_retain(dst);
}

void scr_http_req_on_data(ScrHttpReq *r, ScrClosure *cb /*moves*/, ScrNetDataFn fn, bool once) {
  if (r->ended) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->data_ls, cb, (void *)fn, once);
}

void scr_http_req_on_end(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once) {
  if (r->ended) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->end_ls, cb, NULL, once);
}

double scr_http_req_status(ScrHttpReq *r) { return (double)r->status; }

ScrNetSocket *scr_http_req_socket(ScrHttpReq *r) {
  /* +1; a NULL socket cannot reach the program (every req is built over
   * a live connection), but stay defensive for the emitter's contract */
  return r->sock ? scr_net_sock_retain(r->sock) : NULL;
}

/* the deferred-emit queue lives below (the proto sweep) — resume()'s
 * drain rides it; the parser's deliver and the cork flush live below
 * their callers too */
static void scr_http_emit_push(int kind, void *h /*moves +1*/);
static void scr_http_req_deliver(ScrHttpReq *r, const char *data, size_t n);
static void scr_http_res_cork_flush(ScrHttpRes *r);
#define SCR_HTTP_EMIT_REQ_DRAIN_K 6

/* resume(): a flow-control no-op unless pause() held delivery — then the
 * buffered bytes (and a deferred 'end') drain through the emit queue,
 * never the resuming stack. This parser always consumes body bytes
 * (SEMANTICS.md; Node requires the stream to flow). */
void scr_http_req_resume(ScrHttpReq *r) {
  if (!r->paused) return;
  r->paused = false;
  if ((r->pend_len > 0 || r->end_pending) && !r->drain_queued) {
    r->drain_queued = true;
    scr_http_emit_push(SCR_HTTP_EMIT_REQ_DRAIN_K, scr_http_req_retain(r));
  }
}

/* pause(): delivery holds until resume() (scr_http_req_deliver buffers;
 * a completed body's 'end' waits too). */
void scr_http_req_pause(ScrHttpReq *r) {
  if (!r->ended) r->paused = true;
}

/* req.setTimeout(ms[, cb]): the underlying socket's idle timer — the cb
 * registers once('timeout') there, Node's delegation. Finished/destroyed
 * messages skip (Node no-ops once the stream is done). */
void scr_http_req_set_timeout(ScrHttpReq *r, double ms, ScrClosure *cb /*moves, nullable*/) {
  if (r->ended || r->destroyed || r->close_emitted || !r->sock) {
    /* the message is done — Node no-ops there (never arms, never fires) */
    if (cb) scr_closure_release(cb);
    return;
  }
  scr_net_sock_set_timeout(r->sock, ms);
  if (cb) scr_net_sock_on_timeout(r->sock, cb, true);
}

bool scr_http_req_destroyed_flag(ScrHttpReq *r) { return r->destroyed; }
bool scr_http_req_readable(ScrHttpReq *r) { return !r->ended && !r->destroyed; }

/* destroy(): tears the underlying connection down NOW; the teardown
 * events flow through the socket's native hooks like a peer close. */
void scr_http_req_destroy(ScrHttpReq *r) {
  r->destroyed = true;
  if (r->h2_stream != NULL) {
    scr_http_h2_ops->destroy(r->h2_stream);
    return;
  }
  if (r->sock) scr_net_sock_destroy(r->sock);
}

void scr_http_req_on_error(ScrHttpReq *r, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once) {
  if (r->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->err_ls, cb, (void *)fn, once);
}

void scr_http_req_on_close(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once) {
  if (r->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->close_ls, cb, NULL, once);
}

/* req.on('aborted') — the h2 compat event (an http/1 request registers
 * too; the parser lane never fires it, matching its 'error'-only story). */
void scr_http_req_on_aborted(ScrHttpReq *r, ScrClosure *cb /*moves*/, bool once) {
  if (r->close_emitted || r->aborted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->aborted_ls, cb, NULL, once);
}

/* Body completion: 'end' fires, then both listener lists drop (the
 * settle-releases-listeners story — a handler closure capturing its own
 * req cannot cycle past the body). */
static void scr_http_req_finish(ScrHttpReq *r, bool fire) {
  if (r->ended) return;
  if (fire && r->paused) {
    /* pause() holds 'end' too — resume()'s drain finishes the body */
    r->end_pending = true;
    return;
  }
  r->ended = true;
  if (fire) scr_net_fire0_this(&r->end_ls, r, SCR_DYNH_HTTP_REQ);
  scr_net_ls_drop(&r->data_ls);
  scr_net_ls_drop(&r->end_ls);
  /* pipes: a NATURAL end ends the destination (Node's pipe end:true
   * default); an aborted body just drops the edge — the destination's
   * own error/close story is already running */
  if (r->pipe_res) {
    if (fire) scr_http_res_end(r->pipe_res);
    scr_http_res_release(r->pipe_res);
    r->pipe_res = NULL;
  }
  if (r->pipe_client) {
    if (fire) scr_http_client_end(r->pipe_client);
    scr_http_client_release(r->pipe_client);
    r->pipe_client = NULL;
  }
  if (r->pipe_sock) {
    if (fire) scr_net_sock_end(r->pipe_sock);
    scr_net_sock_release(r->pipe_sock);
    r->pipe_sock = NULL;
  }
}

/* ── the response handle ─────────────────────────────────────────────── */

struct ScrHttpRes {
  size_t rc;
  ScrNetSocket *sock; /* +1; writes after the connection died are no-ops */
  void *h2_stream; /* +1 through scr_http_h2_ops — set on h2 compat
                    * responses; every write path routes to frames */
  struct ScrHttpConn *conn; /* backref, no ref (conn outlives via socket ctx) */
  int status;
  ScrStr *status_msg; /* res.statusMessage / writeHead's reason phrase;
                       * NULL = the status code's default phrase */
  ScrStr **hnames; /* as-set (serialized verbatim, Node keeps the case) */
  ScrStr **hvalues;
  size_t nheaders, cap_headers;
  bool head_sent;
  bool chunked;
  bool finished;
  bool no_date; /* res.sendDate = false: suppress the implicit Date header */
  bool keep_alive; /* the REQUEST's verdict; Connection: close overrides */
  bool destroyed; /* res.destroy()/teardown — res.destroyed (true in 'close') */
  /* cork()/uncork(): corked counts the nesting (res.writableCorked);
   * writes while corked coalesce in cork_buf and flush as ONE write when
   * the count reaches zero (or at end()) — Node's coalescing, and the
   * h2 lane's single DATA frame. */
  int corked;
  char *cork_buf;
  size_t cork_len, cork_cap;
  /* res.req: the paired request (+1; req never points back — no cycle).
   * A `res.req = null` write clears the READ (req_cleared) — Node's
   * plain-property write. */
  ScrHttpReq *req_ref;
  bool req_cleared;
  ScrNetLs close_ls;
  ScrNetLs finish_ls; /* res.end(cb) — fires deferred once the body went out */
  ScrNetLs wcb_ls;    /* res.write(chunk, cb) — fires from the queue */
  bool finish_queued;
  bool wcb_queued;
  bool close_queued;
  bool close_emitted;
};

ScrHttpRes *scr_http_res_retain(ScrHttpRes *r) {
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

void scr_http_res_release(ScrHttpRes *r) {
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    for (size_t i = 0; i < r->nheaders; i++) {
      scr_str_release(r->hnames[i]);
      scr_str_release(r->hvalues[i]);
    }
    free(r->hnames);
    free(r->hvalues);
    scr_str_release(r->status_msg);
    scr_net_ls_drop(&r->close_ls);
    scr_net_ls_drop(&r->finish_ls);
    scr_net_ls_drop(&r->wcb_ls);
    free(r->cork_buf);
    if (r->req_ref) scr_http_req_release(r->req_ref);
    if (r->sock) scr_net_sock_release(r->sock);
    if (r->h2_stream) scr_http_h2_ops->release(r->h2_stream);
#ifdef SCR_RC_AUDIT
    scr_http_live--;
#endif
    free(r);
  }
}

void *scr_http_res_retain_v(void *p) { return scr_http_res_retain((ScrHttpRes *)p); }
void scr_http_res_release_v(void *p) { scr_http_res_release((ScrHttpRes *)p); }

bool scr_http_res_headers_sent(ScrHttpRes *r) { return r->head_sent; }

/* res.statusCode: 200 until assigned (Node's fresh-response default);
 * assignment after the head went out is inert (Node throws on the WRITE
 * paths, not the property — the sent head simply no longer changes). */
double scr_http_res_status_get(ScrHttpRes *r) { return r->status > 0 ? (double)r->status : 200; }

void scr_http_res_status_set(ScrHttpRes *r, double status) {
  if (r->head_sent) return;
  r->status = (int)status;
}

/* res.statusMessage: the assigned reason phrase, or the current status
 * code's default once none was set (Node answers undefined before the
 * head goes out — divergence: this surface is string-typed). */
ScrStr *scr_http_res_status_msg_get(ScrHttpRes *r) {
  if (r->status_msg) return scr_str_retain(r->status_msg);
  const char *reason = scr_http_reason(r->status > 0 ? r->status : 200);
  return scr_str_new(reason, strlen(reason));
}

void scr_http_res_status_msg_set(ScrHttpRes *r, ScrStr *msg /*borrowed*/) {
  if (r->head_sent) return;
  scr_str_release(r->status_msg);
  r->status_msg = scr_str_retain(msg);
}

/* getHeader(name): the value as SET (case-insensitive lookup), +1, or
 * NULL — the compiler's undefined arm. */
ScrStr *scr_http_res_get_header(ScrHttpRes *r, ScrStr *name) {
  for (size_t i = 0; i < r->nheaders; i++) {
    if (r->hnames[i]->len == name->len) {
      bool eq = true;
      for (size_t j = 0; j < name->len && eq; j++) {
        if (tolower((unsigned char)r->hnames[i]->data[j]) !=
            tolower((unsigned char)name->data[j])) eq = false;
      }
      if (eq) return scr_str_retain(r->hvalues[i]);
    }
  }
  return NULL;
}

bool scr_http_res_has_header_named(ScrHttpRes *r, ScrStr *name) {
  ScrStr *v = scr_http_res_get_header(r, name);
  if (v) scr_str_release(v);
  return v != NULL;
}

/* removeHeader(name): drops every case-insensitive match (setHeader keeps
 * one entry per name, but the array-valued writeHead appends repeats). */
void scr_http_res_remove_header(ScrHttpRes *r, ScrStr *name) {
  if (r->head_sent) return; /* Node throws ERR_HTTP_HEADERS_SENT; this slice drops */
  size_t w = 0;
  for (size_t i = 0; i < r->nheaders; i++) {
    bool eq = r->hnames[i]->len == name->len;
    for (size_t j = 0; j < name->len && eq; j++) {
      if (tolower((unsigned char)r->hnames[i]->data[j]) !=
          tolower((unsigned char)name->data[j])) eq = false;
    }
    if (eq) {
      scr_str_release(r->hnames[i]);
      scr_str_release(r->hvalues[i]);
    } else {
      r->hnames[w] = r->hnames[i];
      r->hvalues[w] = r->hvalues[i];
      w++;
    }
  }
  r->nheaders = w;
}

static bool scr_http_res_has_header(ScrHttpRes *r, const char *name) {
  size_t len = strlen(name);
  for (size_t i = 0; i < r->nheaders; i++) {
    if (r->hnames[i]->len == len) {
      bool eq = true;
      for (size_t j = 0; j < len && eq; j++) {
        if (tolower((unsigned char)r->hnames[i]->data[j]) != tolower((unsigned char)name[j])) eq = false;
      }
      if (eq) return true;
    }
  }
  return false;
}

/* Append one header line verbatim (the array-valued writeHead expansion:
 * repeated names each get their own line). */
static void scr_http_res_append_header(ScrHttpRes *r, ScrStr *name /*borrowed*/,
                                        ScrStr *value /*borrowed*/) {
  if (r->head_sent) return;
  if (r->nheaders == r->cap_headers) {
    r->cap_headers = r->cap_headers ? r->cap_headers * 2 : 8;
    r->hnames = realloc(r->hnames, r->cap_headers * sizeof *r->hnames);
    r->hvalues = realloc(r->hvalues, r->cap_headers * sizeof *r->hvalues);
    if (!r->hnames || !r->hvalues) scr_http_oom();
  }
  r->hnames[r->nheaders] = scr_str_retain(name);
  r->hvalues[r->nheaders] = scr_str_retain(value);
  r->nheaders++;
}

/* setHeader: replace-by-name (case-insensitive), Node's semantics. */
void scr_http_res_set_header(ScrHttpRes *r, ScrStr *name /*borrowed*/, ScrStr *value /*borrowed*/) {
  if (r->head_sent) return; /* Node throws ERR_HTTP_HEADERS_SENT; slice drops (SEMANTICS) */
  for (size_t i = 0; i < r->nheaders; i++) {
    if (r->hnames[i]->len == name->len) {
      bool eq = true;
      for (size_t j = 0; j < name->len && eq; j++) {
        if (tolower((unsigned char)r->hnames[i]->data[j]) != tolower((unsigned char)name->data[j])) eq = false;
      }
      if (eq) {
        scr_str_release(r->hvalues[i]);
        r->hvalues[i] = scr_str_retain(value);
        return;
      }
    }
  }
  if (r->nheaders == r->cap_headers) {
    r->cap_headers = r->cap_headers ? r->cap_headers * 2 : 8;
    r->hnames = realloc(r->hnames, r->cap_headers * sizeof *r->hnames);
    r->hvalues = realloc(r->hvalues, r->cap_headers * sizeof *r->hvalues);
    if (!r->hnames || !r->hvalues) scr_http_oom();
  }
  r->hnames[r->nheaders] = scr_str_retain(name);
  r->hvalues[r->nheaders] = scr_str_retain(value);
  r->nheaders++;
}

/* Grow-and-append head builder. */
typedef struct {
  char *data;
  size_t len, cap;
} ScrHttpBuf;

static void scr_http_buf_append(ScrHttpBuf *b, const char *s, size_t n) {
  if (b->len + n > b->cap) {
    size_t cap = b->cap ? b->cap : 512;
    while (cap < b->len + n) cap *= 2;
    b->data = realloc(b->data, cap);
    if (!b->data) scr_http_oom();
    b->cap = cap;
  }
  memcpy(b->data + b->len, s, n);
  b->len += n;
}

static void scr_http_buf_str(ScrHttpBuf *b, const char *s) { scr_http_buf_append(b, s, strlen(s)); }

/* Serializes and sends the head. `body_len` >= 0 fixes Content-Length
 * (the end(data)-before-head path); -1 means chunked unless the user set
 * Content-Length or Transfer-Encoding (Node's useChunkedEncodingByDefault
 * for 1.1). Header order matches Node's storeHeader: user headers as set,
 * then the injected Date / Connection (+Keep-Alive) / framing header. */
static void scr_http_res_send_head(ScrHttpRes *r, long long body_len) {
  if (r->head_sent) return;
  r->head_sent = true;
  int status = r->status > 0 ? r->status : 200;
  if (r->h2_stream != NULL) {
    /* the h2 transport: a HEADERS frame — no HTTP/1 framing headers */
    (void)body_len;
    scr_http_h2_ops->respond(r->h2_stream, (double)status, r->hnames, r->hvalues,
                             r->nheaders, !r->no_date);
    return;
  }
  ScrHttpBuf b = {NULL, 0, 0};
  char line[96];
  snprintf(line, sizeof line, "HTTP/1.1 %d ", status);
  scr_http_buf_str(&b, line);
  /* the assigned reason phrase wins (writeHead's statusMessage argument /
   * the res.statusMessage assignment — "" serializes as an empty phrase,
   * Node's "HTTP/1.1 200 " line) */
  if (r->status_msg) scr_http_buf_append(&b, r->status_msg->data, r->status_msg->len);
  else scr_http_buf_str(&b, scr_http_reason(status));
  scr_http_buf_str(&b, "\r\n");
  for (size_t i = 0; i < r->nheaders; i++) {
    scr_http_buf_append(&b, r->hnames[i]->data, r->hnames[i]->len);
    scr_http_buf_str(&b, ": ");
    scr_http_buf_append(&b, r->hvalues[i]->data, r->hvalues[i]->len);
    scr_http_buf_str(&b, "\r\n");
  }
  if (!r->no_date && !scr_http_res_has_header(r, "date")) {
    /* Node's utcDate: "Date: Wed, 16 Jul 2026 04:20:00 GMT" */
    time_t now = time(NULL);
    struct tm tm;
    gmtime_r(&now, &tm);
    static const char *days[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
    static const char *months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    char date[64];
    snprintf(date, sizeof date, "Date: %s, %02d %s %04d %02d:%02d:%02d GMT\r\n",
             days[tm.tm_wday], tm.tm_mday, months[tm.tm_mon], tm.tm_year + 1900,
             tm.tm_hour, tm.tm_min, tm.tm_sec);
    scr_http_buf_str(&b, date);
  }
  bool user_close = false;
  if (scr_http_res_has_header(r, "connection")) {
    /* the user's own Connection header decides (already serialized) */
    user_close = true; /* trust their framing intent; keep-alive logic off */
  } else if (r->keep_alive) {
    scr_http_buf_str(&b, "Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n");
  } else {
    scr_http_buf_str(&b, "Connection: close\r\n");
  }
  (void)user_close;
  bool have_len = scr_http_res_has_header(r, "content-length") ||
                  scr_http_res_has_header(r, "transfer-encoding");
  if (!have_len) {
    if (body_len >= 0) {
      char cl[48];
      snprintf(cl, sizeof cl, "Content-Length: %lld\r\n", body_len);
      scr_http_buf_str(&b, cl);
    } else {
      scr_http_buf_str(&b, "Transfer-Encoding: chunked\r\n");
      r->chunked = true;
    }
  }
  scr_http_buf_str(&b, "\r\n");
  if (r->sock) scr_net_sock_write_native(r->sock, b.data, b.len);
  free(b.data);
}

/* Writes while corked coalesce here and flush as ONE write when the
 * cork count reaches zero (or at end()) — Node's coalescing, and one
 * DATA frame on the h2 lane. */
static void scr_http_res_cork_buffer(ScrHttpRes *r, const char *data, size_t len) {
  if (len == 0) return;
  if (r->cork_len + len > r->cork_cap) {
    size_t cap = r->cork_cap ? r->cork_cap : 1024;
    while (cap < r->cork_len + len) cap *= 2;
    r->cork_buf = realloc(r->cork_buf, cap);
    if (!r->cork_buf) scr_http_oom();
    r->cork_cap = cap;
  }
  memcpy(r->cork_buf + r->cork_len, data, len);
  r->cork_len += len;
}

static void scr_http_res_write_raw(ScrHttpRes *r, const char *data, size_t len) {
  if (r->finished) return;
  if (r->corked > 0) {
    scr_http_res_cork_buffer(r, data, len);
    return;
  }
  if (!r->head_sent) scr_http_res_send_head(r, -1); /* streaming: chunked */
  if (r->h2_stream != NULL) {
    scr_http_h2_ops->write(r->h2_stream, data, len);
    return;
  }
  if (!r->sock) return;
  if (r->chunked) {
    char size[32];
    snprintf(size, sizeof size, "%zx\r\n", len);
    if (len > 0) {
      scr_net_sock_write_native(r->sock, size, strlen(size));
      scr_net_sock_write_native(r->sock, data, len);
      scr_net_sock_write_native(r->sock, "\r\n", 2);
    }
  } else {
    scr_net_sock_write_native(r->sock, data, len);
  }
}

void scr_http_res_write_str(ScrHttpRes *r, ScrStr *data /*borrowed*/) {
  scr_http_res_write_raw(r, data->data, data->len);
}

void scr_http_res_write_bytes(ScrHttpRes *r, ScrBytes *data /*borrowed*/) {
  scr_http_res_write_raw(r, (const char *)data->data, data->len);
}

/* res.flushHeaders(): the head goes out NOW (streaming framing — chunked
 * unless the user fixed the length; the h2 lane's HEADERS frame). */
void scr_http_res_flush_headers(ScrHttpRes *r) {
  if (!r->head_sent && !r->finished) scr_http_res_send_head(r, -1);
}

/* cork()/uncork(): the count IS res.writableCorked; the last uncork
 * flushes the coalesced bytes as one write. */
void scr_http_res_cork(ScrHttpRes *r) { r->corked++; }

void scr_http_res_uncork(ScrHttpRes *r) {
  if (r->corked == 0) return;
  if (--r->corked == 0) scr_http_res_cork_flush(r);
}

double scr_http_res_writable_corked(ScrHttpRes *r) { return (double)r->corked; }

bool scr_http_res_destroyed_flag(ScrHttpRes *r) { return r->destroyed || r->close_emitted; }

/* res.req — the paired request; a res.req = null write cleared it. */
void scr_http_res_set_req(ScrHttpRes *r, ScrHttpReq *req /*borrowed*/) {
  if (r->req_ref) scr_http_req_release(r->req_ref);
  r->req_ref = req ? scr_http_req_retain(req) : NULL;
}

/* res.setTimeout(ms[, cb]): the socket's idle timer, Node's delegation. */
void scr_http_res_set_timeout(ScrHttpRes *r, double ms, ScrClosure *cb /*moves, nullable*/) {
  if (r->finished || r->close_emitted || !r->sock) {
    if (cb) scr_closure_release(cb);
    return;
  }
  scr_net_sock_set_timeout(r->sock, ms);
  if (cb) scr_net_sock_on_timeout(r->sock, cb, true);
}

static void scr_http_conn_response_finished(struct ScrHttpConn *conn, bool keep_alive);
static void scr_http_queue_res_finish(ScrHttpRes *res);

/* Flush corked bytes as one write (corked already zero, or forced by
 * end()). */
static void scr_http_res_cork_flush(ScrHttpRes *r) {
  if (r->cork_len == 0) return;
  char *held = r->cork_buf;
  size_t held_len = r->cork_len;
  r->cork_buf = NULL;
  r->cork_len = r->cork_cap = 0;
  scr_http_res_write_raw(r, held, held_len);
  free(held);
}

static void scr_http_res_end_raw(ScrHttpRes *r, const char *data, size_t len) {
  if (r->finished) return;
  if (r->corked > 0 || r->cork_len > 0) {
    /* end() flushes every cork level (Node) — the body streamed, so the
     * framing below takes the already-committed streaming path */
    r->corked = 0;
    scr_http_res_cork_flush(r);
    if (r->finished) return; /* a teardown inside the flush */
  }
  if (r->h2_stream != NULL) {
    if (!r->head_sent) scr_http_res_send_head(r, (long long)len);
    scr_http_h2_ops->end(r->h2_stream, data, len);
    r->finished = true;
    if (r->finish_ls.n > 0) scr_http_queue_res_finish(r);
    return;
  }
  if (!r->head_sent) {
    /* whole body known NOW: Content-Length framing, Node's implicit head */
    scr_http_res_send_head(r, (long long)len);
    if (r->sock && len > 0) scr_net_sock_write_native(r->sock, data, len);
  } else {
    scr_http_res_write_raw(r, data, len);
    if (r->chunked && r->sock) scr_net_sock_write_native(r->sock, "0\r\n\r\n", 5);
  }
  r->finished = true;
  if (r->finish_ls.n > 0) scr_http_queue_res_finish(r);
  if (r->conn) scr_http_conn_response_finished(r->conn, r->keep_alive);
}

void scr_http_res_end(ScrHttpRes *r) { scr_http_res_end_raw(r, "", 0); }

void scr_http_res_end_str(ScrHttpRes *r, ScrStr *data /*borrowed*/) {
  scr_http_res_end_raw(r, data->data, data->len);
}

void scr_http_res_end_bytes(ScrHttpRes *r, ScrBytes *data /*borrowed*/) {
  scr_http_res_end_raw(r, (const char *)data->data, data->len);
}

void scr_http_res_write_head(ScrHttpRes *r, double status) {
  if (r->head_sent) return;
  r->status = (int)status;
  scr_http_res_send_head(r, -1); /* Node: an explicit writeHead means chunked unless CL was set */
}

/* writeHead(status, { ...literal headers... }): the packed form — names
 * and values arrive as parallel string arrays (evaluation order was the
 * literal's), each setHeader'd, then the head goes out. */
/* writeHead(status, headers) with a CHECKED-DYNAMIC headers value (an
 * untyped JS helper's parameter — the suite's test(headers) idiom): OBJ
 * entries setHeader in insertion order (string values verbatim, numbers
 * via ToString, string arrays one line per element via the append path),
 * then the head goes out. undefined/null headers are the plain head;
 * other kinds throw the ERR_INVALID_ARG_TYPE-flavored fence. */
void scr_http_res_write_head_dyn(ScrHttpRes *r, double status, const ScrDyn *headers) {
  if (r->head_sent) return;
  if (headers->kind == SCR_DYN_UNDEF || headers->kind == SCR_DYN_NULL) {
    scr_http_res_write_head(r, status);
    return;
  }
  if (headers->kind != SCR_DYN_OBJ) {
    scr_dyn_arg_type_fail("headers", "an instance of Object", headers);
    return;
  }
  for (size_t i = 0; i < headers->v.obj.len; i++) {
    const ScrDynEntry *e = &headers->v.obj.entries[i];
    const ScrDyn *v = e->value;
    ScrStr *name = scr_str_new(e->key, e->key_len);
    if (v->kind == SCR_DYN_STR) {
      scr_http_res_set_header(r, name, v->v.str);
    } else if (v->kind == SCR_DYN_NUM) {
      char num[32];
      size_t n = scr_f64_to_str(v->v.num, num);
      ScrStr *value = scr_str_new(num, n);
      scr_http_res_set_header(r, name, value);
      scr_str_release(value);
    } else {
      scr_str_release(name);
      scr_dyn_arg_type_fail("value", "of type string or number", v);
      return;
    }
    scr_str_release(name);
  }
  scr_http_res_write_head(r, status);
}

void scr_http_res_write_head_n(ScrHttpRes *r, double status, ScrArr *names, ScrArr *values) {
  if (r->head_sent) return;
  size_t n = (size_t)scr_arr_len(names);
  for (size_t i = 0; i < n; i++) {
    ScrStr *name = (ScrStr *)scr_arr_get_ref(names, (double)i);
    ScrStr *value = (ScrStr *)scr_arr_get_ref(values, (double)i);
    scr_http_res_set_header(r, name, value);
    scr_str_release(name);
    scr_str_release(value);
  }
  scr_http_res_write_head(r, status);
}

/* writeHead(status, record): the flat [k0, v0, k1, v1, ...] pairs the
 * env.pairs helper produces — each entry setHeader'd, then the head goes
 * out (undefined-valued entries were dropped by the helper, the Node-
 * drops-undefined env rule; Node's writeHead would throw on them). */
void scr_http_res_write_head_pairs(ScrHttpRes *r, double status, ScrArr *pairs /*borrowed*/) {
  if (r->head_sent) return;
  size_t n = (size_t)scr_arr_len(pairs);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *name = (ScrStr *)scr_arr_get_ref(pairs, (double)i);
    ScrStr *value = (ScrStr *)scr_arr_get_ref(pairs, (double)(i + 1));
    /* A REPEATED name within this pairs array is an ARRAY-VALUED header
     * (["a", "b"] expands to consecutive same-name pairs): the first
     * occurrence replaces any earlier setHeader (Node's writeHead-wins
     * merge), the repeats APPEND — Node writes one line per element. */
    bool repeat = false;
    for (size_t j = 0; j < i && !repeat; j += 2) {
      ScrStr *prev = (ScrStr *)scr_arr_get_ref(pairs, (double)j);
      if (prev->len == name->len) {
        bool eq = true;
        for (size_t k = 0; k < name->len && eq; k++) {
          if (tolower((unsigned char)prev->data[k]) != tolower((unsigned char)name->data[k])) eq = false;
        }
        repeat = eq;
      }
      scr_str_release(prev);
    }
    if (repeat) scr_http_res_append_header(r, name, value);
    else scr_http_res_set_header(r, name, value);
    scr_str_release(name);
    scr_str_release(value);
  }
  scr_http_res_write_head(r, status);
}

/* res.destroy(): tears the connection down NOW (mid-stream RST is the
 * point — portless aborts a proxied response with it); 'close' follows
 * through the teardown path. Node-matched: no 'error' from a destroy. */
void scr_http_res_destroy(ScrHttpRes *r) {
  r->destroyed = true;
  if (r->h2_stream != NULL) {
    /* h2 compat: destroy the STREAM (RST), never the shared session */
    scr_http_h2_ops->destroy(r->h2_stream);
    return;
  }
  if (r->sock) scr_net_sock_destroy(r->sock);
}

void scr_http_res_on_close(ScrHttpRes *r, ScrClosure *cb /*moves*/, bool once) {
  if (r->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&r->close_ls, cb, NULL, once);
}

/* ── the deferred-emit queue (scr_net.c's proto sweep drains it) ───────
 *
 * 'close' on requests/responses and the client's own 'close' fire a
 * sweep pass AFTER the work that flagged them — Node's ordering (the
 * handler's synchronous tail runs first; res 'close' precedes req
 * 'close'; the client's res 'end' precedes req 'close' precedes res
 * 'close'). RES_ABORTED is the mid-body premature-close 'error' on a
 * client response ("aborted", Node's message) — queued between the
 * client close and the response close, the oracle-pinned order. Each
 * entry holds +1 on its handle; firing settles the handle (listener
 * lists drop — the cycle story). */

enum {
  SCR_HTTP_EMIT_RES_CLOSE = 1,   /* ScrHttpRes */
  SCR_HTTP_EMIT_REQ_CLOSE = 2,   /* ScrHttpReq */
  SCR_HTTP_EMIT_REQ_ABORTED = 3, /* ScrHttpReq: 'error' ("aborted") */
  SCR_HTTP_EMIT_CLIENT_CLOSE = 4, /* ScrHttpClientReq */
  SCR_HTTP_EMIT_RES_FINISH = 5,  /* ScrHttpRes: the end(cb) callbacks */
  SCR_HTTP_EMIT_REQ_DRAIN = SCR_HTTP_EMIT_REQ_DRAIN_K, /* ScrHttpReq: resume()'s drain */
  SCR_HTTP_EMIT_RES_WCB = 7      /* ScrHttpRes: write(chunk, cb) callbacks */
};

typedef struct {
  int kind;
  void *h; /* +1 */
} ScrHttpEmit;

static ScrHttpEmit *scr_http_emits = NULL;
static size_t scr_http_emits_head = 0, scr_http_emits_len = 0, scr_http_emits_cap = 0;

static void scr_http_client_release_internal(struct ScrHttpClientReq *c);
static void scr_http_client_settle(struct ScrHttpClientReq *c);

/* Exit-time flag (set by the atexit cleanup, which runs BEFORE the net
 * unit's — atexit LIFO, http installs after net): once the emits queue
 * has drained for the last time, teardown paths that would queue close
 * emits (scr_net_cleanup_atexit freeing in-flight parsers) discard the
 * payload instead — nothing will ever sweep again. */
static bool scr_http_exiting = false;

static void scr_http_emit_release(ScrHttpEmit *e);

static void scr_http_emit_push(int kind, void *h /*moves +1*/) {
  if (scr_http_exiting) {
    ScrHttpEmit e = { kind, h };
    scr_http_emit_release(&e);
    return;
  }
  if (scr_http_emits_len == scr_http_emits_cap) {
    /* compact the consumed head first */
    if (scr_http_emits_head > 0) {
      memmove(scr_http_emits, scr_http_emits + scr_http_emits_head,
              (scr_http_emits_len - scr_http_emits_head) * sizeof *scr_http_emits);
      scr_http_emits_len -= scr_http_emits_head;
      scr_http_emits_head = 0;
    }
    if (scr_http_emits_len == scr_http_emits_cap) {
      scr_http_emits_cap = scr_http_emits_cap ? scr_http_emits_cap * 2 : 8;
      scr_http_emits = realloc(scr_http_emits, scr_http_emits_cap * sizeof *scr_http_emits);
      if (!scr_http_emits) scr_http_oom();
    }
  }
  scr_http_emits[scr_http_emits_len].kind = kind;
  scr_http_emits[scr_http_emits_len].h = h;
  scr_http_emits_len++;
}

static void scr_http_emit_release(ScrHttpEmit *e) {
  switch (e->kind) {
  case SCR_HTTP_EMIT_RES_CLOSE:
  case SCR_HTTP_EMIT_RES_WCB:
  case SCR_HTTP_EMIT_RES_FINISH: scr_http_res_release((ScrHttpRes *)e->h); break;
  case SCR_HTTP_EMIT_REQ_CLOSE:
  case SCR_HTTP_EMIT_REQ_DRAIN:
  case SCR_HTTP_EMIT_REQ_ABORTED: scr_http_req_release((ScrHttpReq *)e->h); break;
  case SCR_HTTP_EMIT_CLIENT_CLOSE:
    scr_http_client_release_internal((struct ScrHttpClientReq *)e->h);
    break;
  }
}

/* Enqueue helpers: idempotent per handle (the close_queued flags). */
static void scr_http_queue_res_close(ScrHttpRes *res) {
  if (res->close_queued || res->close_emitted) return;
  res->close_queued = true;
  scr_http_emit_push(SCR_HTTP_EMIT_RES_CLOSE, scr_http_res_retain(res));
}

static void scr_http_queue_req_close(ScrHttpReq *req) {
  if (req->close_queued || req->close_emitted) return;
  req->close_queued = true;
  scr_http_emit_push(SCR_HTTP_EMIT_REQ_CLOSE, scr_http_req_retain(req));
}

static void scr_http_queue_req_aborted(ScrHttpReq *req) {
  scr_http_emit_push(SCR_HTTP_EMIT_REQ_ABORTED, scr_http_req_retain(req));
}

/* The end(cb) deferral: 'finish'-time callbacks fire one sweep after the
 * body went out (the handler's synchronous tail runs first, Node's
 * deferred emit — the res 'close' precedent). */
static void scr_http_queue_res_finish(ScrHttpRes *res) {
  if (res->finish_queued) return;
  res->finish_queued = true;
  scr_http_emit_push(SCR_HTTP_EMIT_RES_FINISH, scr_http_res_retain(res));
}

/* res.end(cb)'s callback slot: registered just before the end call; a
 * response that already finished (a second end) still fires it deferred
 * — Node errbacks ERR_STREAM_ALREADY_FINISHED there (divergence: this
 * surface's callbacks take no arguments, so it fires plainly). */
void scr_http_res_on_finish(ScrHttpRes *r, ScrClosure *cb /*moves*/) {
  scr_net_ls_add(&r->finish_ls, cb, NULL, true);
  if (r->finished) scr_http_queue_res_finish(r);
}

/* res.write(chunk, cb): the callback fires from the queue (this surface
 * flushes synchronously into the socket buffer — the deferral keeps the
 * cb off the writing stack, Node's contract). */
void scr_http_res_on_write_flush(ScrHttpRes *r, ScrClosure *cb /*moves*/) {
  scr_net_ls_add(&r->wcb_ls, cb, NULL, true);
  if (!r->wcb_queued) {
    r->wcb_queued = true;
    scr_http_emit_push(SCR_HTTP_EMIT_RES_WCB, scr_http_res_retain(r));
  }
}

static bool scr_http_proto_pending(void) { return scr_http_emits_head < scr_http_emits_len; }

static void scr_http_proto_sweep(void) {
  while (scr_http_emits_head < scr_http_emits_len) {
    ScrHttpEmit e = scr_http_emits[scr_http_emits_head++];
    switch (e.kind) {
    case SCR_HTTP_EMIT_RES_CLOSE: {
      ScrHttpRes *res = (ScrHttpRes *)e.h;
      if (!res->close_emitted) {
        res->close_emitted = true;
        res->destroyed = true; /* Node: destroyed reads true inside 'close' */
        scr_net_fire0_this(&res->close_ls, res, SCR_DYNH_HTTP_RES);
        scr_net_ls_drop(&res->close_ls);
      }
      break;
    }
    case SCR_HTTP_EMIT_RES_WCB: {
      ScrHttpRes *res = (ScrHttpRes *)e.h;
      res->wcb_queued = false; /* later write(chunk, cb)s re-queue */
      scr_net_fire0_this(&res->wcb_ls, res, SCR_DYNH_HTTP_RES);
      break;
    }
    case SCR_HTTP_EMIT_REQ_CLOSE: {
      ScrHttpReq *req = (ScrHttpReq *)e.h;
      if (!req->close_emitted) {
        req->close_emitted = true;
        req->destroyed = true; /* Node: destroyed reads true inside 'close' */
        scr_net_fire0_this(&req->close_ls, req, SCR_DYNH_HTTP_REQ);
        scr_net_ls_drop(&req->err_ls);
        scr_net_ls_drop(&req->close_ls);
        scr_net_ls_drop(&req->aborted_ls);
      }
      break;
    }
    case SCR_HTTP_EMIT_REQ_DRAIN: {
      /* resume() after pause(): the held bytes deliver as one chunk (the
       * reassembled body is the contract), then a deferred 'end'. A
       * re-pause mid-drain re-buffers — the swap keeps the walk sound. */
      ScrHttpReq *req = (ScrHttpReq *)e.h;
      req->drain_queued = false;
      if (!req->paused) {
        char *held = req->pend;
        size_t held_len = req->pend_len;
        req->pend = NULL;
        req->pend_len = req->pend_cap = 0;
        if (held_len > 0) scr_http_req_deliver(req, held, held_len);
        free(held);
        if (!scr_exc_pending() && !req->paused && req->end_pending) {
          req->end_pending = false;
          scr_http_req_finish(req, true);
        }
      }
      break;
    }
    case SCR_HTTP_EMIT_REQ_ABORTED: {
      ScrHttpReq *req = (ScrHttpReq *)e.h;
      if (!req->close_emitted) {
        ScrStr *msg = scr_str_new("aborted", 7);
        scr_net_fire_err_this(&req->err_ls, msg, req, SCR_DYNH_HTTP_REQ);
        scr_str_release(msg);
      }
      break;
    }
    case SCR_HTTP_EMIT_CLIENT_CLOSE:
      scr_http_client_settle((struct ScrHttpClientReq *)e.h);
      break;
    case SCR_HTTP_EMIT_RES_FINISH: {
      ScrHttpRes *res = (ScrHttpRes *)e.h;
      res->finish_queued = false; /* a later end(cb) on the finished res re-queues */
      scr_net_fire0_this(&res->finish_ls, res, SCR_DYNH_HTTP_RES);
      break;
    }
    }
    scr_http_emit_release(&e);
    if (scr_exc_pending()) return;
  }
  scr_http_emits_head = scr_http_emits_len = 0;
}

static void scr_http_clients_cleanup(void);
static void scr_http_agents_cleanup(void);

static void scr_http_cleanup_atexit(void) {
  scr_http_exiting = true;
  while (scr_http_emits_head < scr_http_emits_len) {
    ScrHttpEmit e = scr_http_emits[scr_http_emits_head++];
    scr_http_emit_release(&e);
  }
  free(scr_http_emits);
  scr_http_emits = NULL;
  scr_http_emits_head = scr_http_emits_len = scr_http_emits_cap = 0;
  scr_http_agents_cleanup(); /* break agent↔client edges first */
  scr_http_clients_cleanup();
}

/* One-time wiring into the net sweep (both createServer and request call
 * through here). */
static void scr_http_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  atexit(scr_http_cleanup_atexit);
  scr_net_set_proto_sweep(&scr_http_proto_pending, &scr_http_proto_sweep);
}

/* ── the per-connection parser ───────────────────────────────────────── */

typedef enum {
  SCR_HTTP_HEAD = 0,
  SCR_HTTP_BODY_CL,
  SCR_HTTP_CHUNK_SIZE,
  SCR_HTTP_CHUNK_DATA,
  SCR_HTTP_CHUNK_CRLF,
  SCR_HTTP_CHUNK_TRAILER,
  SCR_HTTP_BODY_EOF, /* RESPONSE mode: no framing header — body until EOF */
} ScrHttpParseState;

typedef struct ScrHttpConn {
  ScrNetSocket *sock;  /* BORROWED: the ctx lives and dies with the socket
                        * (a retained ref here would be a cycle the RC
                        * could never break) */
  struct ScrHttpSrvCtx *srv; /* +1; NULL in client mode — the server ctx
                              * whose 'request' listeners fire per parsed
                              * request (EMIT-time resolution, Node's
                              * dispatch: a listener installed after the
                              * accept but before the request still runs) */
  char *buf;
  size_t len, cap;
  ScrHttpParseState state;
  size_t body_remaining;
  ScrHttpReq *req; /* the in-flight request (server) or response (client),
                    * +1; NULL between requests / before the head */
  ScrHttpRes *res; /* +1; server mode only */
  bool close_after; /* the response said Connection: close */
  bool client_mode; /* RESPONSE parsing: status line, EOF bodies */
  bool client_resp_started; /* the status line parsed (conn-level twin of
                             * the client's response_started — the pump
                             * runs below the client struct's definition) */
  struct ScrHttpClientReq *client; /* +1 in client mode; released at close */
} ScrHttpConn;

/* Client-mode forward declarations (implementations live with the client
 * below the server parser). */
static bool scr_http_client_parse_head(ScrHttpConn *conn, size_t head_len);
static void scr_http_client_head_overflow(ScrHttpConn *conn);

/* The server-side ctx: the 'request' listener list, shared by every
 * connection. REFCOUNTED: the server's native-conn chain holds one ref
 * (released through scr_http_srv_ctx_free) and each live connection
 * holds one — a socket can outlive its server handle. createServer's
 * eager handler is just the first listener; server.on("request", ...)
 * appends (scr_http_server_on_request), and requests fire the list
 * snapshot-at-emit like every other event here. */
typedef struct ScrHttpSrvCtx {
  int proto; /* SCR_NET_PROTO_HTTP1 — FIRST: the http_ctx alias slot is
              * shared with scr_http2.c's ScrH2SrvCtx; each family checks
              * the tag before treating the ctx as its own */
  size_t rc;
  ScrNetLs request_ls;
  ScrNetLs upgrade_ls;
  ScrNetLs connect_ls; /* HTTP CONNECT — the upgrade machinery's twin */
  bool join_dup; /* createServer({ joinDuplicateHeaders: true }) */
} ScrHttpSrvCtx;

static ScrHttpSrvCtx *scr_http_srv_ctx_retain(ScrHttpSrvCtx *ctx) {
  ctx->rc++;
  return ctx;
}

static void scr_http_srv_ctx_release(ScrHttpSrvCtx *ctx) {
  if (--ctx->rc > 0) return;
  scr_net_ls_drop(&ctx->request_ls);
  scr_net_ls_drop(&ctx->upgrade_ls);
  scr_net_ls_drop(&ctx->connect_ls);
  free(ctx);
}

static void scr_http_srv_ctx_free(void *p) { scr_http_srv_ctx_release((ScrHttpSrvCtx *)p); }

/* The server-settle hook (scr_net_server_set_proto_settle): the ctx's own
 * listener lists drop when the server settles — no request can fire past
 * the settle (the fd is closed and every connection drained), and a
 * handler closure capturing its own server through a dyn binding box
 * would otherwise cycle through collector-invisible edges. */
static void scr_http_srv_ctx_settle(void *p) {
  ScrHttpSrvCtx *ctx = (ScrHttpSrvCtx *)p;
  scr_net_ls_drop(&ctx->request_ls);
  scr_net_ls_drop(&ctx->upgrade_ls);
  scr_net_ls_drop(&ctx->connect_ls);
}

static void scr_http_conn_drop_request(ScrHttpConn *conn, bool fire_end) {
  /* the deferred 'close' emits: res before req, Node's order */
  if (conn->res) scr_http_queue_res_close(conn->res);
  if (conn->req) scr_http_queue_req_close(conn->req);
  if (conn->req) {
    scr_http_req_finish(conn->req, fire_end);
    scr_http_req_release(conn->req);
    conn->req = NULL;
  }
  if (conn->res) {
    conn->res->conn = NULL;
    scr_http_res_release(conn->res);
    conn->res = NULL;
  }
}

/* The response finished: with keep-alive the parser waits for the next
 * request (pipelined bytes may already sit in the buffer — the read path
 * keeps parsing); without it the socket half-closes, Node's teardown. */
static void scr_http_conn_response_finished(ScrHttpConn *conn, bool keep_alive) {
  bool fire_end = conn->req != NULL && conn->state == SCR_HTTP_HEAD;
  /* the handler answered before consuming the whole body: the request
   * settles quietly (Node destroys unconsumed bodies on 'close') */
  scr_http_conn_drop_request(conn, fire_end && false);
  if (!keep_alive || conn->close_after) {
    scr_net_sock_end(conn->sock);
  } else {
    scr_net_sock_apply_keep_alive_timeout(conn->sock);
  }
}

/* One parsed header line (name lowercased into the req). */
static void scr_http_req_add_header(ScrHttpReq *r, const char *name, size_t nlen,
                                     const char *value, size_t vlen) {
  char *lower = malloc(nlen);
  if (!lower && nlen > 0) scr_http_oom();
  for (size_t i = 0; i < nlen; i++) lower[i] = (char)tolower((unsigned char)name[i]);
  r->hnames = realloc(r->hnames, (r->nheaders + 1) * sizeof *r->hnames);
  r->hnames_raw = realloc(r->hnames_raw, (r->nheaders + 1) * sizeof *r->hnames_raw);
  r->hvalues = realloc(r->hvalues, (r->nheaders + 1) * sizeof *r->hvalues);
  if (!r->hnames || !r->hnames_raw || !r->hvalues) scr_http_oom();
  r->hnames[r->nheaders] = scr_str_new(lower, nlen);
  r->hnames_raw[r->nheaders] = scr_str_new(name, nlen);
  r->hvalues[r->nheaders] = scr_str_new(value, vlen);
  r->nheaders++;
  free(lower);
}

/* Malformed input: this slice answers 400 and closes — Node's lenient
 * spots (bare LF line endings, obsolete folding) are NOT accepted;
 * SEMANTICS.md states the bound. */
static void scr_http_conn_bad_request(ScrHttpConn *conn) {
  static const char bad[] =
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
  scr_net_sock_write_native(conn->sock, bad, sizeof bad - 1);
  scr_net_sock_end(conn->sock);
  conn->len = 0;
  scr_http_conn_drop_request(conn, false);
}

/* Delivers a body slice to a request's data listeners (the parser's
 * feed, and the h2 compat DATA-frame feed). */
static void scr_http_req_deliver(ScrHttpReq *r, const char *data, size_t n) {
  if (!r || n == 0 || r->ended) return;
  if (r->paused) {
    /* req.pause(): the parser keeps consuming (memory is the buffer —
     * a documented bound), delivery waits for resume()'s drain */
    if (r->pend_len + n > r->pend_cap) {
      size_t cap = r->pend_cap ? r->pend_cap : 4096;
      while (cap < r->pend_len + n) cap *= 2;
      r->pend = realloc(r->pend, cap);
      if (!r->pend) scr_http_oom();
      r->pend_cap = cap;
    }
    memcpy(r->pend + r->pend_len, data, n);
    r->pend_len += n;
    return;
  }
  bool piped = r->pipe_res != NULL || r->pipe_client != NULL || r->pipe_sock != NULL;
  if (r->data_ls.n == 0 && !piped) return;
  ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
  memcpy(chunk->data, data, n);
  if (r->data_ls.n > 0) {
    ScrNetL *snap;
    size_t nl = scr_net_ls_snapshot(&r->data_ls, &snap);
    scr_dyn_this_push(r, SCR_DYNH_HTTP_REQ);
    scr_dyn_chunk_enc(r->enc_utf8);
    for (size_t i = 0; i < nl; i++) {
      if (!scr_exc_pending()) ((ScrNetDataFn)snap[i].fn)(snap[i].cb, chunk);
      scr_closure_release(snap[i].cb);
    }
    scr_dyn_chunk_enc(false);
    scr_dyn_this_pop();
    free(snap);
  }
  if (!scr_exc_pending()) {
    if (r->pipe_res) scr_http_res_write_bytes(r->pipe_res, chunk);
    if (r->pipe_client) scr_http_client_write_bytes(r->pipe_client, chunk);
    if (r->pipe_sock) scr_net_sock_write_bytes(r->pipe_sock, chunk);
  }
  scr_bytes_release(chunk);
}

static void scr_http_conn_body_data(ScrHttpConn *conn, const char *data, size_t n) {
  scr_http_req_deliver(conn->req, data, n);
}

static void scr_http_client_response_done(ScrHttpConn *conn);

/* Body complete: 'end' fires on the request; the response may already be
 * finished (handler answered from the head alone) — then the connection
 * resets here instead. Client mode: 'end' on the response, then the
 * whole exchange tears down (one request per connection). */
static void scr_http_conn_body_done(ScrHttpConn *conn) {
  conn->state = SCR_HTTP_HEAD;
  conn->body_remaining = 0;
  if (conn->client_mode) {
    scr_http_client_response_done(conn);
    return;
  }
  ScrHttpReq *r = conn->req;
  if (r) {
    scr_http_req_retain(r);
    scr_http_req_finish(r, true);
    scr_http_req_release(r);
  }
  if (conn->res && conn->res->finished) {
    bool keep = conn->res->keep_alive && !conn->close_after;
    scr_http_conn_drop_request(conn, false);
    if (!keep) scr_net_sock_end(conn->sock);
  }
}

/* Parses one complete request HEAD sitting at buf[0..head_len). Returns
 * false on malformed input (already answered). */
static bool scr_http_conn_parse_head(ScrHttpConn *conn, size_t head_len) {
  const char *buf = conn->buf;
  const char *line_end = memchr(buf, '\r', head_len);
  if (!line_end || line_end + 1 >= buf + head_len || line_end[1] != '\n') return false;
  /* METHOD SP request-target SP HTTP/1.x */
  const char *sp1 = memchr(buf, ' ', (size_t)(line_end - buf));
  if (!sp1) return false;
  const char *sp2 = memchr(sp1 + 1, ' ', (size_t)(line_end - sp1 - 1));
  if (!sp2) return false;
  const char *ver = sp2 + 1;
  size_t verlen = (size_t)(line_end - ver);
  bool http10;
  if (verlen == 8 && memcmp(ver, "HTTP/1.1", 8) == 0) http10 = false;
  else if (verlen == 8 && memcmp(ver, "HTTP/1.0", 8) == 0) http10 = true;
  else return false;

  ScrHttpReq *req = calloc(1, sizeof *req);
  if (!req) scr_http_oom();
  req->rc = 1;
  req->status = -1; /* Node: statusCode is undefined on server requests */
  req->join_dup = conn->srv != NULL && conn->srv->join_dup;
  req->sock = scr_net_sock_retain(conn->sock);
#ifdef SCR_RC_AUDIT
  scr_http_live++;
#endif
  req->method = scr_str_new(buf, (size_t)(sp1 - buf));
  req->url = scr_str_new(sp1 + 1, (size_t)(sp2 - sp1 - 1));
  req->http10 = http10;

  /* header lines until the blank line */
  const char *p = line_end + 2;
  const char *end = buf + head_len;
  bool ok = true;
  while (p < end) {
    const char *eol = memchr(p, '\r', (size_t)(end - p));
    if (!eol || eol + 1 >= end || eol[1] != '\n') {
      ok = false;
      break;
    }
    if (eol == p) {
      p += 2; /* the blank line */
      break;
    }
    const char *colon = memchr(p, ':', (size_t)(eol - p));
    if (!colon || colon == p) {
      ok = false;
      break;
    }
    const char *v = colon + 1;
    while (v < eol && (*v == ' ' || *v == '\t')) v++;
    const char *ve = eol;
    while (ve > v && (ve[-1] == ' ' || ve[-1] == '\t')) ve--;
    scr_http_req_add_header(req, p, (size_t)(colon - p), v, (size_t)(ve - v));
    p = eol + 2;
  }
  if (!ok) {
    scr_http_req_release(req);
    return false;
  }

  /* framing: chunked wins over Content-Length (RFC 9112) */
  bool chunked = false;
  long long content_length = 0;
  bool req_keep_alive = !http10;
  bool has_upgrade_hdr = false;
  bool conn_upgrade_token = false;
  for (size_t i = 0; i < req->nheaders; i++) {
    const ScrStr *n = req->hnames[i];
    const ScrStr *v = req->hvalues[i];
    if (n->len == 17 && memcmp(n->data, "transfer-encoding", 17) == 0) {
      if (v->len >= 7 && strstr(v->data, "chunked") != NULL) chunked = true;
    } else if (n->len == 14 && memcmp(n->data, "content-length", 14) == 0) {
      content_length = atoll(v->data);
      if (content_length < 0) content_length = 0;
    } else if (n->len == 7 && memcmp(n->data, "upgrade", 7) == 0) {
      has_upgrade_hdr = true;
    } else if (n->len == 10 && memcmp(n->data, "connection", 10) == 0) {
      /* token scan, case-insensitive enough for close/keep-alive */
      if (strcasestr(v->data, "upgrade") != NULL) conn_upgrade_token = true;
      if (strcasestr(v->data, "close") != NULL) req_keep_alive = false;
      else if (strcasestr(v->data, "keep-alive") != NULL) req_keep_alive = true;
    }
  }

  /* A CONNECT request: 'connect' fires INSTEAD of 'request' — the
   * upgrade machinery's exact shape ((req, socket, head); the parser
   * steps aside; no listener destroys the socket, Node's default). The
   * h2 compat server's HTTP/1.1 arm lands here too — under the
   * allowHTTP1 lowering it is the ONLY arm (SEMANTICS.md divergence
   * 57), so a portless-style listener always takes the raw socket. */
  if (req->method->len == 7 && memcmp(req->method->data, "CONNECT", 7) == 0) {
    memmove(conn->buf, conn->buf + head_len, conn->len - head_len);
    conn->len -= head_len;
    if (conn->srv->connect_ls.n == 0) {
      scr_http_req_release(req);
      conn->len = 0;
      scr_net_sock_destroy(conn->sock);
      return true;
    }
    ScrBytes *head = scr_bytes_new(SCR_BYTES_U8, (double)conn->len);
    if (conn->len > 0) memcpy(head->data, conn->buf, conn->len);
    conn->len = 0;
    scr_net_sock_clear_native_reader(conn->sock);
    ScrNetL *snap;
    size_t n = scr_net_ls_snapshot(&conn->srv->connect_ls, &snap);
    scr_dyn_this_push(scr_net_sock_server(conn->sock), SCR_DYNH_NET_SERVER);
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) {
        ((ScrHttpUpgradeFn)snap[i].fn)(snap[i].cb, scr_http_req_retain(req),
                                       scr_net_sock_retain(conn->sock), scr_bytes_retain(head));
      }
      scr_closure_release(snap[i].cb);
    }
    scr_dyn_this_pop();
    free(snap);
    scr_bytes_release(head);
    scr_http_req_release(req);
    return true;
  }

  /* An Upgrade request (Connection: upgrade + an Upgrade header): the
   * 'upgrade' listeners take the socket RAW — the parser steps aside
   * (fn pointers clear; the conn ctx stays until the socket dies), bytes
   * already read past the head travel as `head`, and no 'request' fires.
   * With no listener Node destroys the socket; so does this slice. */
  if (has_upgrade_hdr && conn_upgrade_token) {
    memmove(conn->buf, conn->buf + head_len, conn->len - head_len);
    conn->len -= head_len;
    if (conn->srv->upgrade_ls.n == 0) {
      scr_http_req_release(req);
      conn->len = 0;
      scr_net_sock_destroy(conn->sock);
      return true;
    }
    ScrBytes *head = scr_bytes_new(SCR_BYTES_U8, (double)conn->len);
    if (conn->len > 0) memcpy(head->data, conn->buf, conn->len);
    conn->len = 0;
    scr_net_sock_clear_native_reader(conn->sock);
    ScrNetL *snap;
    size_t n = scr_net_ls_snapshot(&conn->srv->upgrade_ls, &snap);
    scr_dyn_this_push(scr_net_sock_server(conn->sock), SCR_DYNH_NET_SERVER);
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) {
        ((ScrHttpUpgradeFn)snap[i].fn)(snap[i].cb, scr_http_req_retain(req),
                                       scr_net_sock_retain(conn->sock), scr_bytes_retain(head));
      }
      scr_closure_release(snap[i].cb);
    }
    scr_dyn_this_pop();
    free(snap);
    scr_bytes_release(head);
    scr_http_req_release(req);
    return true;
  }

  ScrHttpRes *res = calloc(1, sizeof *res);
  if (!res) scr_http_oom();
  res->rc = 1;
#ifdef SCR_RC_AUDIT
  scr_http_live++;
#endif
  res->sock = scr_net_sock_retain(conn->sock);
  res->conn = conn;
  res->keep_alive = req_keep_alive;
  res->req_ref = scr_http_req_retain(req); /* res.req — req never points back */
  conn->req = req; /* conn's +1 */
  conn->res = res;
  conn->close_after = !req_keep_alive;

  if (chunked) {
    conn->state = SCR_HTTP_CHUNK_SIZE;
  } else if (content_length > 0) {
    conn->state = SCR_HTTP_BODY_CL;
    conn->body_remaining = (size_t)content_length;
  } else {
    conn->state = SCR_HTTP_HEAD; /* no body */
  }

  /* consume the head bytes */
  memmove(conn->buf, conn->buf + head_len, conn->len - head_len);
  conn->len -= head_len;

  /* fire the 'request' listeners (macrotask, main stack) — snapshot at
   * emit time, the scr_net_fire0 discipline; each listener gets its own
   * req/res refs (the adapters release what their shape drops) */
  {
    ScrNetL *snap;
    size_t n = scr_net_ls_snapshot(&conn->srv->request_ls, &snap);
    scr_dyn_this_push(scr_net_sock_server(conn->sock), SCR_DYNH_NET_SERVER);
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) {
        ((ScrHttpReqFn)snap[i].fn)(snap[i].cb, scr_http_req_retain(req), scr_http_res_retain(res));
      }
      scr_closure_release(snap[i].cb);
    }
    scr_dyn_this_pop();
    free(snap);
  }
  if (scr_exc_pending()) return true; /* the loop surfaces it */
  if (!chunked && content_length == 0) {
    /* headless body: 'end' delivers to the listeners the handler attached */
    scr_http_conn_body_done(conn);
  }
  return true;
}

/* The parse pump: consume as much of conn->buf as the state machine can. */
static void scr_http_conn_pump(ScrHttpConn *conn) {
  for (;;) {
    if (scr_exc_pending()) return;
    if (conn->state == SCR_HTTP_HEAD) {
      if (conn->client_mode) {
        if (conn->client == NULL || conn->client_resp_started) {
          /* response already delivered (or torn down): stray bytes after
           * the exchange are discarded — the socket is closing anyway */
          conn->len = 0;
          return;
        }
      } else if (conn->req != NULL && conn->res == NULL) {
        return; /* torn down */
      }
      /* between requests, or awaiting a head */
      if (conn->len == 0) return;
      /* find CRLFCRLF */
      char *hit = NULL;
      if (conn->len >= 4) {
        for (size_t i = 0; i + 3 < conn->len; i++) {
          if (conn->buf[i] == '\r' && conn->buf[i + 1] == '\n' && conn->buf[i + 2] == '\r' &&
              conn->buf[i + 3] == '\n') {
            hit = conn->buf + i;
            break;
          }
        }
      }
      if (!hit) {
        if (conn->len > 65536) {
          if (conn->client_mode) scr_http_client_head_overflow(conn);
          else scr_http_conn_bad_request(conn); /* header cap */
        }
        return;
      }
      size_t head_len = (size_t)(hit - conn->buf) + 4;
      if (conn->client_mode) {
        if (!scr_http_client_parse_head(conn, head_len)) {
          scr_http_client_head_overflow(conn); /* malformed: hang up */
        }
        if (scr_exc_pending()) return;
        continue;
      }
      /* a previous exchange must be COMPLETE before the next parses: the
       * response may still be streaming (keep-alive pipelining waits) */
      if (conn->res != NULL && !conn->res->finished) return;
      if (conn->res != NULL) scr_http_conn_drop_request(conn, false);
      if (!scr_http_conn_parse_head(conn, head_len)) {
        scr_http_conn_bad_request(conn);
        return;
      }
      continue;
    }
    if (conn->state == SCR_HTTP_BODY_CL) {
      if (conn->len == 0) return;
      size_t take = conn->len < conn->body_remaining ? conn->len : conn->body_remaining;
      scr_http_conn_body_data(conn, conn->buf, take);
      memmove(conn->buf, conn->buf + take, conn->len - take);
      conn->len -= take;
      conn->body_remaining -= take;
      if (conn->body_remaining == 0) scr_http_conn_body_done(conn);
      else return;
      continue;
    }
    if (conn->state == SCR_HTTP_CHUNK_SIZE) {
      char *eol = NULL;
      for (size_t i = 0; i + 1 < conn->len; i++) {
        if (conn->buf[i] == '\r' && conn->buf[i + 1] == '\n') {
          eol = conn->buf + i;
          break;
        }
      }
      if (!eol) return;
      size_t size = 0;
      bool any = false;
      for (char *p = conn->buf; p < eol; p++) {
        char c = *p;
        if (c == ';') break; /* chunk extensions: ignored */
        int digit;
        if (c >= '0' && c <= '9') digit = c - '0';
        else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
        else {
          scr_http_conn_bad_request(conn);
          return;
        }
        size = size * 16 + (size_t)digit;
        any = true;
      }
      if (!any) {
        scr_http_conn_bad_request(conn);
        return;
      }
      size_t consumed = (size_t)(eol - conn->buf) + 2;
      memmove(conn->buf, conn->buf + consumed, conn->len - consumed);
      conn->len -= consumed;
      if (size == 0) {
        conn->state = SCR_HTTP_CHUNK_TRAILER;
      } else {
        conn->state = SCR_HTTP_CHUNK_DATA;
        conn->body_remaining = size;
      }
      continue;
    }
    if (conn->state == SCR_HTTP_CHUNK_DATA) {
      if (conn->len == 0) return;
      size_t take = conn->len < conn->body_remaining ? conn->len : conn->body_remaining;
      scr_http_conn_body_data(conn, conn->buf, take);
      memmove(conn->buf, conn->buf + take, conn->len - take);
      conn->len -= take;
      conn->body_remaining -= take;
      if (conn->body_remaining == 0) conn->state = SCR_HTTP_CHUNK_CRLF;
      else return;
      continue;
    }
    if (conn->state == SCR_HTTP_CHUNK_CRLF) {
      if (conn->len < 2) return;
      if (conn->buf[0] != '\r' || conn->buf[1] != '\n') {
        scr_http_conn_bad_request(conn);
        return;
      }
      memmove(conn->buf, conn->buf + 2, conn->len - 2);
      conn->len -= 2;
      conn->state = SCR_HTTP_CHUNK_SIZE;
      continue;
    }
    if (conn->state == SCR_HTTP_BODY_EOF) {
      /* RESPONSE mode, no framing header: every arrived byte is body;
       * EOF completes it (the eof hook calls body_done). */
      if (conn->len == 0) return;
      scr_http_conn_body_data(conn, conn->buf, conn->len);
      conn->len = 0;
      return;
    }
    if (conn->state == SCR_HTTP_CHUNK_TRAILER) {
      /* trailers until the blank line; all discarded */
      if (conn->len < 2) return;
      if (conn->buf[0] == '\r' && conn->buf[1] == '\n') {
        memmove(conn->buf, conn->buf + 2, conn->len - 2);
        conn->len -= 2;
        scr_http_conn_body_done(conn);
        continue;
      }
      char *eol = NULL;
      for (size_t i = 0; i + 1 < conn->len; i++) {
        if (conn->buf[i] == '\r' && conn->buf[i + 1] == '\n') {
          eol = conn->buf + i;
          break;
        }
      }
      if (!eol) return;
      size_t consumed = (size_t)(eol - conn->buf) + 2;
      memmove(conn->buf, conn->buf + consumed, conn->len - consumed);
      conn->len -= consumed;
      continue;
    }
    return;
  }
}

/* ── the native socket hooks ─────────────────────────────────────────── */

static void scr_http_conn_data(void *ctx, const char *buf, size_t n) {
  ScrHttpConn *conn = (ScrHttpConn *)ctx;
  if (conn->len + n > conn->cap) {
    size_t cap = conn->cap ? conn->cap : 8192;
    while (cap < conn->len + n) cap *= 2;
    conn->buf = realloc(conn->buf, cap);
    if (!conn->buf) scr_http_oom();
    conn->cap = cap;
  }
  memcpy(conn->buf + conn->len, buf, n);
  conn->len += n;
  scr_http_conn_pump(conn);
}

static void scr_http_client_eof(ScrHttpConn *conn);
static void scr_http_client_closed(ScrHttpConn *conn);
static void scr_http_client_conn_free(ScrHttpConn *conn);

static void scr_http_conn_eof(void *ctx) {
  ScrHttpConn *conn = (ScrHttpConn *)ctx;
  if (conn->client_mode) {
    scr_http_client_eof(conn);
    return;
  }
  /* client FIN between requests: our half closes too (keep-alive over);
   * mid-request it is an aborted request — everything settles quietly */
  scr_http_conn_drop_request(conn, false);
  conn->len = 0;
}

static void scr_http_conn_closed(void *ctx) {
  ScrHttpConn *conn = (ScrHttpConn *)ctx;
  if (conn->client_mode) {
    scr_http_client_closed(conn);
    return;
  }
  scr_http_conn_drop_request(conn, false);
}

/* Socket errors under a parser: the protocol layer owns the story. On
 * the SERVER an abrupt client death (ECONNRESET mid-request) must never
 * crash the process — Node's http server swallows these into request
 * teardown ('error' listeners on the req get "aborted"); the CLIENT
 * routes them to the request handle's 'error'. Always consumed: the
 * underlying socket's own listeners never see a parser-owned error. */
static bool scr_http_client_sock_err(ScrHttpConn *conn, ScrStr *msg);

static void scr_http_conn_headers_timeout(void *ctx) {
  ScrHttpConn *conn = (ScrHttpConn *)ctx;
  if (conn->client_mode || conn->req != NULL || conn->sock == NULL) return;
  static const char timeout[] =
      "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
  scr_net_sock_write_native(conn->sock, timeout, sizeof timeout - 1);
  scr_net_sock_end(conn->sock);
  conn->len = 0;
}

static bool scr_http_conn_err(void *ctx, ScrStr *msg) {
  ScrHttpConn *conn = (ScrHttpConn *)ctx;
  if (conn->client_mode) return scr_http_client_sock_err(conn, msg);
  if (conn->req && conn->req->err_ls.n > 0) {
    ScrStr *aborted = scr_str_new("aborted", 7);
    scr_net_fire_err_this(&conn->req->err_ls, aborted, conn->req, SCR_DYNH_HTTP_REQ);
    scr_str_release(aborted);
  }
  scr_http_conn_drop_request(conn, false);
  return true;
}

static void scr_http_conn_free(void *ctx) {
  ScrHttpConn *conn = (ScrHttpConn *)ctx;
  if (conn->client_mode) {
    scr_http_client_conn_free(conn);
    return;
  }
  scr_http_conn_drop_request(conn, false);
  if (conn->srv) scr_http_srv_ctx_release(conn->srv);
  free(conn->buf);
  free(conn);
}

/* The server's native connection hook: one parser per accepted socket. */
static void scr_http_on_connection(void *ctx, ScrNetSocket *sock) {
  ScrHttpSrvCtx *srv = (ScrHttpSrvCtx *)ctx;
  ScrHttpConn *conn = calloc(1, sizeof *conn);
  if (!conn) scr_http_oom();
  conn->sock = sock; /* borrowed — see the struct comment */
  conn->srv = scr_http_srv_ctx_retain(srv);
  scr_net_sock_set_native_reader(sock, &scr_http_conn_data, &scr_http_conn_eof,
                                  &scr_http_conn_closed, conn, &scr_http_conn_free);
  scr_net_sock_set_native_events(sock, &scr_http_conn_headers_timeout, &scr_http_conn_err);
  scr_net_sock_apply_headers_timeout(sock);
}

/* The unguarded h2-only stream call (`req.stream.on(...)`): stream IS
 * undefined on every connection this lowering accepts — and on every
 * HTTP/1.1 connection of Node's own allowHTTP1 server — so calling
 * through it is Node's member read on undefined: the exact catchable
 * TypeError, member name interpolated. Borrows the name; never returns. */
void scr_http2_stream_undef_call(ScrStr *member) {
  char msg[128];
  int n = snprintf(msg, sizeof msg, "Cannot read properties of undefined (reading '%.*s')",
                   (int)member->len, member->data);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
}

/* http.createServer(handler): an ordinary net server whose connections
 * feed the parser; listen/close/address/'error' all ride the net surface.
 * A NULL handler (http2.createSecureServer's route) creates the server
 * with an empty 'request' list — server.on("request", ...) fills it. */
ScrNetServer *scr_http_create_server(ScrClosure *handler /*moves, nullable*/, ScrHttpReqFn fn) {
  scr_http_install();
  ScrNetServer *s = scr_net_create_server(NULL, NULL);
  ScrHttpSrvCtx *ctx = calloc(1, sizeof *ctx);
  if (!ctx) scr_http_oom();
  ctx->proto = SCR_NET_PROTO_HTTP1;
  ctx->rc = 1;
  if (handler != NULL) scr_net_ls_add(&ctx->request_ls, handler, (void *)fn, false);
  scr_net_server_set_native_conn(s, &scr_http_on_connection, ctx, &scr_http_srv_ctx_free);
  scr_net_server_set_http_ctx(s, ctx);
  scr_net_server_set_proto_settle(s, &scr_http_srv_ctx_settle);
  return s;
}

/* createServer({ joinDuplicateHeaders: true, ... }): repeated request
 * header names read back joined with ", " where Node's default (and this
 * parser's) keeps the first occurrence. A no-op on parserless servers. */
void scr_http_server_join_duplicate_headers(ScrNetServer *s) {
  ScrHttpSrvCtx *ctx = (ScrHttpSrvCtx *)scr_net_server_get_http_ctx(s);
  if (ctx != NULL && ctx->proto == SCR_NET_PROTO_HTTP1) ctx->join_dup = true;
}

/* Late 'request' listener installs (server.on/once("request", ...)): the
 * http2 allowHTTP1 server's handler route, and http.Server's 'request'
 * event. On a server with no HTTP parser the closure releases
 * unregistered — 'request' never fires there, like Node. */
void scr_http_server_on_request(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrHttpReqFn fn,
                                 bool once) {
  ScrHttpSrvCtx *ctx = (ScrHttpSrvCtx *)scr_net_server_get_http_ctx(s);
  if (ctx != NULL && ctx->proto != SCR_NET_PROTO_HTTP1) {
    /* an h2 server's ctx: the compat seam — scr_http2.c's hook owns the
     * registration (Http2ServerRequest/Response over h2 streams) */
    if (scr_http_h2_request_hook != NULL && !scr_net_server_settled(s)) {
      scr_http_h2_request_hook(ctx, cb, (void *)fn, once);
      return;
    }
    ctx = NULL;
  }
  if (ctx == NULL || scr_net_server_settled(s)) {
    /* no parser, or the server already settled ('request' can never fire
     * again — an install would only re-arm the cycle the settle broke) */
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&ctx->request_ls, cb, (void *)fn, once);
}

/* ── the h2 compat pair (built by scr_http2.c per server stream) ───────
 *
 * The request materializes from the decoded header list (:method/:path
 * feed the line; EVERY pair — pseudo-headers included — lands in
 * req.headers, Node's compat shape); the response routes its write paths
 * through the h2 ops vtable. Body DATA frames and END_STREAM feed the
 * req exactly like the parser's body states; 'close' rides this unit's
 * deferred-emit queue so ordering matches the http/1 story (res before
 * req). */

ScrHttpReq *scr_http_h2_req_new(ScrNetSocket *sock /*borrowed, nullable*/,
                                 void *stream /*borrowed, nullable*/) {
  scr_http_install();
  ScrHttpReq *req = calloc(1, sizeof *req);
  if (!req) scr_http_oom();
  req->rc = 1;
  req->status = -1; /* server requests: statusCode is Node's undefined */
  req->http2 = true;
  req->sock = sock ? scr_net_sock_retain(sock) : NULL;
  req->h2_stream = stream != NULL ? scr_http_h2_ops->retain(stream) : NULL;
  req->method = scr_str_new("GET", 3); /* :method replaces it */
  req->url = scr_str_new("/", 1);      /* :path replaces it */
#ifdef SCR_RC_AUDIT
  scr_http_live++;
#endif
  return req;
}

void scr_http_h2_req_line(ScrHttpReq *r, ScrStr *method /*borrowed, nullable*/,
                           ScrStr *url /*borrowed, nullable*/) {
  if (method != NULL) {
    scr_str_release(r->method);
    r->method = scr_str_retain(method);
  }
  if (url != NULL) {
    scr_str_release(r->url);
    r->url = scr_str_retain(url);
  }
}

void scr_http_h2_req_header(ScrHttpReq *r, ScrStr *name /*borrowed*/, ScrStr *value /*borrowed*/) {
  scr_http_req_add_header(r, name->data, name->len, value->data, value->len);
}

void scr_http_h2_req_data(ScrHttpReq *r, const char *data, size_t n) {
  scr_http_req_deliver(r, data, n);
}

void scr_http_h2_req_end(ScrHttpReq *r) { scr_http_req_finish(r, true); }

/* Typed member reads shared by both parser lanes: the version triple and
 * the compat pair's aborted/complete flags. */
ScrStr *scr_http_req_http_version(ScrHttpReq *r) {
  return scr_str_new(r->http2 ? "2.0" : r->http10 ? "1.0" : "1.1", 3);
}
double scr_http_req_http_version_major(ScrHttpReq *r) { return r->http2 ? 2 : 1; }
double scr_http_req_http_version_minor(ScrHttpReq *r) { return r->http2 || r->http10 ? 0 : 1; }
bool scr_http_req_aborted_flag(ScrHttpReq *r) { return r->aborted; }
bool scr_http_req_complete(ScrHttpReq *r) { return r->ended; }

/* The stream died with the response side open: 'aborted' fires NOW (the
 * teardown macrotask, Node's position), then the close rides the sweep. */
void scr_http_h2_req_aborted(ScrHttpReq *r) {
  if (r->close_emitted || r->aborted) return;
  r->aborted = true;
  scr_net_fire0_this(&r->aborted_ls, r, SCR_DYNH_HTTP_REQ);
  scr_net_ls_drop(&r->aborted_ls);
}

void scr_http_h2_req_close(ScrHttpReq *r) { scr_http_queue_req_close(r); }

ScrHttpRes *scr_http_h2_res_new(ScrNetSocket *sock /*borrowed, nullable*/,
                                 void *stream /*borrowed*/) {
  scr_http_install();
  ScrHttpRes *res = calloc(1, sizeof *res);
  if (!res) scr_http_oom();
  res->rc = 1;
  res->sock = sock ? scr_net_sock_retain(sock) : NULL;
  res->h2_stream = scr_http_h2_ops->retain(stream);
  res->keep_alive = true; /* inert on h2 — no Connection header exists */
#ifdef SCR_RC_AUDIT
  scr_http_live++;
#endif
  return res;
}

void scr_http_h2_res_close(ScrHttpRes *r) { scr_http_queue_res_close(r); }

bool scr_http_h2_res_finished(ScrHttpRes *r) { return r->finished; }

/* server.on("connect", (req, socket, head) => ...) — HTTP CONNECT, and
 * server.on("upgrade", ...) below: the registration twins of on_request.
 * On a server with no HTTP parser neither list ever fires — honest dead
 * weight, Node's shape. */
void scr_http_server_on_connect(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn,
                                 bool once) {
  ScrHttpSrvCtx *ctx = (ScrHttpSrvCtx *)scr_net_server_get_http_ctx(s);
  if (ctx != NULL && ctx->proto != SCR_NET_PROTO_HTTP1) ctx = NULL; /* an h2 server's ctx */
  if (ctx == NULL) {
    /* no HTTP parser on this server: the event can never fire (Node's
     * net server never emits 'connect' either) — honest dead weight */
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&ctx->connect_ls, cb, (void *)fn, once);
}

void scr_http_server_on_upgrade(ScrNetServer *s, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn,
                                 bool once) {
  ScrHttpSrvCtx *ctx = (ScrHttpSrvCtx *)scr_net_server_get_http_ctx(s);
  if (ctx != NULL && ctx->proto != SCR_NET_PROTO_HTTP1) ctx = NULL; /* an h2 server's ctx */
  if (ctx == NULL) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&ctx->upgrade_ls, cb, (void *)fn, once);
}

/* The upgrade adapters: (req, socket, head), and every shorter prefix.
 * All three arrive +1; unused ones release here. */
void scr_http_upgrade_thunk3(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head) {
  ((void (*)(ScrClosure *, ScrHttpReq *, ScrNetSocket *, ScrBytes *))cb->fn)(cb, req, sock, head);
}

void scr_http_upgrade_thunk2(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head) {
  scr_bytes_release(head);
  ((void (*)(ScrClosure *, ScrHttpReq *, ScrNetSocket *))cb->fn)(cb, req, sock);
}

void scr_http_upgrade_thunk1(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head) {
  scr_bytes_release(head);
  scr_net_sock_release(sock);
  ((void (*)(ScrClosure *, ScrHttpReq *))cb->fn)(cb, req);
}

void scr_http_upgrade_thunk0(ScrClosure *cb, ScrHttpReq *req, ScrNetSocket *sock, ScrBytes *head) {
  scr_bytes_release(head);
  scr_net_sock_release(sock);
  scr_http_req_release(req);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* The handler adapters: (req, res), (req), and (). Both handles arrive
 * +1; unused ones release here. */
void scr_http_handler_thunk2(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res) {
  ((void (*)(ScrClosure *, ScrHttpReq *, ScrHttpRes *))cb->fn)(cb, req, res);
}

void scr_http_handler_thunk1(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res) {
  scr_http_res_release(res);
  ((void (*)(ScrClosure *, ScrHttpReq *))cb->fn)(cb, req);
}

void scr_http_handler_thunk0(ScrClosure *cb, ScrHttpReq *req, ScrHttpRes *res) {
  scr_http_req_release(req);
  scr_http_res_release(res);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* ── the CLIENT (http.request / http.get) ────────────────────────────────
 *
 * One handle per request, one dialed connection per handle (no agent
 * pooling — SEMANTICS.md; the wire is Node's regardless, Connection:
 * keep-alive included, and the socket closes when the response
 * completes). Ownership: the handle holds the socket (+1) and, once
 * parsed, the response req (+1); the socket's parser ctx holds the
 * handle (+1) until the connection dies — the registry-shaped cycle
 * breaks at teardown exactly like the server's conn→req edge. A live
 * client is registered (+1, atexit-cleaned) so abandoned handles behave
 * like abandoned sockets. */

struct ScrHttpClientReq {
  size_t rc;
  ScrNetSocket *sock; /* +1 */
  ScrHttpConn *conn;  /* borrowed backref (the socket's ctx); NULL after free */
  ScrStr *host, *path, *method;
  int port;
  int default_port; /* the Host header omits it (80 http, 443 https) */
  ScrStr **hnames; /* user headers, verbatim case */
  ScrStr **hvalues;
  size_t nheaders;
  bool user_cl;      /* caller set content-length/transfer-encoding */
  bool head_sent;
  bool chunked;      /* streaming framing committed */
  bool ended;
  bool destroyed;
  bool response_started; /* head parsed, res exists */
  bool response_done;
  bool had_error;
  bool close_queued;
  bool close_emitted; /* settled: listeners dropped, off the registry */
  ScrHttpReq *res; /* +1 once the head parses */
  ScrNetLs resp_ls, err_ls, timeout_ls, close_ls, upgrade_ls;
  /* the owning Agent (+1; the agent's entry holds this client +1 too —
   * the cycle breaks at settle, or at the atexit agent sweep) */
  struct ScrHttpAgent *agent;
  bool in_registry;
  struct ScrHttpClientReq *next;
};

static ScrHttpClientReq *scr_http_clients = NULL; /* registry: +1 each */

ScrHttpClientReq *scr_http_client_retain(ScrHttpClientReq *c) {
  if (c->rc != SIZE_MAX) c->rc++;
  return c;
}

void scr_http_client_release(ScrHttpClientReq *c) {
  if (!c || c->rc == SIZE_MAX) return;
  if (--c->rc == 0) {
    scr_net_ls_drop(&c->resp_ls);
    scr_net_ls_drop(&c->err_ls);
    scr_net_ls_drop(&c->timeout_ls);
    scr_net_ls_drop(&c->close_ls);
    scr_net_ls_drop(&c->upgrade_ls);
    scr_str_release(c->host);
    scr_str_release(c->path);
    scr_str_release(c->method);
    for (size_t i = 0; i < c->nheaders; i++) {
      scr_str_release(c->hnames[i]);
      scr_str_release(c->hvalues[i]);
    }
    free(c->hnames);
    free(c->hvalues);
    if (c->res) scr_http_req_release(c->res);
    if (c->sock) scr_net_sock_release(c->sock);
#ifdef SCR_RC_AUDIT
    scr_http_live--;
#endif
    free(c);
  }
}

static void scr_http_client_release_internal(struct ScrHttpClientReq *c) {
  scr_http_client_release(c);
}

void *scr_http_client_retain_v(void *p) { return scr_http_client_retain((ScrHttpClientReq *)p); }
void scr_http_client_release_v(void *p) { scr_http_client_release((ScrHttpClientReq *)p); }

static void scr_http_client_register(ScrHttpClientReq *c) {
  if (c->in_registry) return;
  c->in_registry = true;
  c->next = NULL;
  ScrHttpClientReq **link = &scr_http_clients;
  while (*link) link = &(*link)->next;
  *link = scr_http_client_retain(c);
}

static void scr_http_client_unregister(ScrHttpClientReq *c) {
  if (!c->in_registry) return;
  ScrHttpClientReq **link = &scr_http_clients;
  while (*link && *link != c) link = &(*link)->next;
  if (*link) {
    *link = c->next;
    c->next = NULL;
    c->in_registry = false;
    scr_http_client_release(c);
  }
}

/* Agent bookkeeping (implementation below, with the Agent unit): the
 * settling client leaves its agent's lists and frees a slot. */
static void scr_http_agent_client_done(struct ScrHttpAgent *ag, struct ScrHttpClientReq *c);
static struct ScrHttpAgent *scr_http_agent_release_p(struct ScrHttpAgent *ag);
static void scr_http_client_agent_detach(struct ScrHttpClientReq *c);

/* The queue's CLIENT_CLOSE emit: 'close' fires, the handle settles
 * (listeners drop — the cycle story) and leaves the registry. */
static void scr_http_client_settle(struct ScrHttpClientReq *c) {
  if (c->close_emitted) return;
  c->close_emitted = true;
  c->destroyed = true;
  scr_http_client_agent_detach(c); /* usually already detached at socket close */
  scr_net_fire0(&c->close_ls);
  scr_net_ls_drop(&c->resp_ls);
  scr_net_ls_drop(&c->err_ls);
  scr_net_ls_drop(&c->timeout_ls);
  scr_net_ls_drop(&c->close_ls);
  scr_http_client_unregister(c);
}

static void scr_http_client_queue_close(ScrHttpClientReq *c) {
  if (c->close_queued || c->close_emitted) return;
  c->close_queued = true;
  scr_http_emit_push(SCR_HTTP_EMIT_CLIENT_CLOSE, scr_http_client_retain(c));
}

/* 'error' on the request handle: fires NOW (the callers sit in the net
 * sweep / dispatch, Node's own emit spots); no listener exits 1, the
 * unhandled-'error' story. The close follows through the queue. */
static void scr_http_client_error(ScrHttpClientReq *c, ScrStr *msg /*borrowed*/) {
  if (c->close_emitted) return;
  c->had_error = true;
  scr_net_fire_err(&c->err_ls, msg);
}

/* ── the wire: Node's exact request head ─────────────────────────────── */

static bool scr_http_client_has_header(ScrHttpClientReq *c, const char *name) {
  size_t len = strlen(name);
  for (size_t i = 0; i < c->nheaders; i++) {
    if (c->hnames[i]->len == len) {
      bool eq = true;
      for (size_t j = 0; j < len && eq; j++) {
        if (tolower((unsigned char)c->hnames[i]->data[j]) != tolower((unsigned char)name[j])) eq = false;
      }
      if (eq) return true;
    }
  }
  return false;
}

/* Serializes and sends the head. `body_len` >= 0 fixes Content-Length
 * (the end(data) path — and Node's Content-Length: 0 for empty POST/PUT/
 * PATCH bodies); -1 means STREAMING: chunked unless the caller set the
 * framing. Node's order: user headers verbatim, then Host (unless user-
 * set), Connection: keep-alive, and the framing header. */
static void scr_http_client_send_head(ScrHttpClientReq *c, long long body_len) {
  if (c->head_sent) return;
  c->head_sent = true;
  ScrHttpBuf b = {NULL, 0, 0};
  scr_http_buf_append(&b, c->method->data, c->method->len);
  scr_http_buf_str(&b, " ");
  scr_http_buf_append(&b, c->path->data, c->path->len);
  scr_http_buf_str(&b, " HTTP/1.1\r\n");
  for (size_t i = 0; i < c->nheaders; i++) {
    scr_http_buf_append(&b, c->hnames[i]->data, c->hnames[i]->len);
    scr_http_buf_str(&b, ": ");
    scr_http_buf_append(&b, c->hvalues[i]->data, c->hvalues[i]->len);
    scr_http_buf_str(&b, "\r\n");
  }
  if (!scr_http_client_has_header(c, "host")) {
    /* Host: name[:port] — the scheme's default port omitted (80 http,
     * 443 https), IPv6 literals bracketed (Node) */
    bool v6 = memchr(c->host->data, ':', c->host->len) != NULL;
    scr_http_buf_str(&b, "Host: ");
    if (v6) scr_http_buf_str(&b, "[");
    scr_http_buf_append(&b, c->host->data, c->host->len);
    if (v6) scr_http_buf_str(&b, "]");
    if (c->port != c->default_port) {
      char pbuf[16];
      snprintf(pbuf, sizeof pbuf, ":%d", c->port);
      scr_http_buf_str(&b, pbuf);
    }
    scr_http_buf_str(&b, "\r\n");
  }
  if (!scr_http_client_has_header(c, "connection")) {
    scr_http_buf_str(&b, "Connection: keep-alive\r\n");
  }
  if (!c->user_cl) {
    if (body_len < 0) {
      scr_http_buf_str(&b, "Transfer-Encoding: chunked\r\n");
      c->chunked = true;
    } else if (body_len > 0) {
      char cl[48];
      snprintf(cl, sizeof cl, "Content-Length: %lld\r\n", body_len);
      scr_http_buf_str(&b, cl);
    } else {
      /* empty body: POST/PUT/PATCH send Content-Length: 0, everything
       * else sends no framing header at all — Node's method split */
      const ScrStr *m = c->method;
      bool bodied = (m->len == 4 && memcmp(m->data, "POST", 4) == 0) ||
                    (m->len == 3 && memcmp(m->data, "PUT", 3) == 0) ||
                    (m->len == 5 && memcmp(m->data, "PATCH", 5) == 0);
      if (bodied) scr_http_buf_str(&b, "Content-Length: 0\r\n");
    }
  }
  scr_http_buf_str(&b, "\r\n");
  if (c->sock) scr_net_sock_write_native(c->sock, b.data, b.len);
  free(b.data);
}

static void scr_http_client_write_raw(ScrHttpClientReq *c, const char *data, size_t len) {
  if (c->ended || c->destroyed || c->close_emitted) return; /* write-after-end drops (divergence 48's stance) */
  if (!c->head_sent) scr_http_client_send_head(c, -1); /* streaming: chunked */
  if (!c->sock || len == 0) return;
  if (c->chunked) {
    char size[32];
    snprintf(size, sizeof size, "%zx\r\n", len);
    scr_net_sock_write_native(c->sock, size, strlen(size));
    scr_net_sock_write_native(c->sock, data, len);
    scr_net_sock_write_native(c->sock, "\r\n", 2);
  } else {
    scr_net_sock_write_native(c->sock, data, len);
  }
}

void scr_http_client_write_str(ScrHttpClientReq *c, ScrStr *data /*borrowed*/) {
  scr_http_client_write_raw(c, data->data, data->len);
}

void scr_http_client_write_bytes(ScrHttpClientReq *c, ScrBytes *data /*borrowed*/) {
  scr_http_client_write_raw(c, (const char *)data->data, data->len);
}

static void scr_http_client_end_raw(ScrHttpClientReq *c, const char *data, size_t len) {
  if (c->ended || c->destroyed || c->close_emitted) return;
  if (!c->head_sent) {
    /* whole body known NOW: Content-Length framing (or none — the head
     * serializer's empty-body method split) */
    scr_http_client_send_head(c, (long long)len);
    if (c->sock && len > 0) scr_net_sock_write_native(c->sock, data, len);
  } else {
    scr_http_client_write_raw(c, data, len);
    if (c->chunked && c->sock) scr_net_sock_write_native(c->sock, "0\r\n\r\n", 5);
  }
  c->ended = true;
}

void scr_http_client_end(ScrHttpClientReq *c) { scr_http_client_end_raw(c, "", 0); }

void scr_http_client_end_str(ScrHttpClientReq *c, ScrStr *data /*borrowed*/) {
  scr_http_client_end_raw(c, data->data, data->len);
}

void scr_http_client_end_bytes(ScrHttpClientReq *c, ScrBytes *data /*borrowed*/) {
  scr_http_client_end_raw(c, (const char *)data->data, data->len);
}

/* req.setTimeout(ms) after construction (the island bridge's late arm —
 * the constructor's timeout_ms is the static lane's route). */
void scr_http_client_set_timeout(ScrHttpClientReq *c, double ms) {
  if (c->sock) scr_net_sock_set_timeout(c->sock, ms);
}

/* destroy(): tears the connection down NOW. A destroy after the response
 * completed is a quiet no-op past the socket close (Node: just 'close');
 * before it, the teardown surfaces as 'socket hang up' — both flow
 * through the closed hook below. */
void scr_http_client_destroy(ScrHttpClientReq *c) {
  if (c->destroyed) return;
  c->destroyed = true;
  if (c->sock) scr_net_sock_destroy(c->sock);
}

bool scr_http_client_destroyed(ScrHttpClientReq *c) {
  return c->destroyed || c->close_emitted;
}

void scr_http_client_on_response(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrHttpRespFn fn, bool once) {
  if (c->close_emitted || c->response_started) {
    /* the event is past (or the handle settled): never fires */
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&c->resp_ls, cb, (void *)fn, once);
}

void scr_http_client_on_error(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once) {
  if (c->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&c->err_ls, cb, (void *)fn, once);
}

void scr_http_client_on_upgrade(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, ScrHttpUpgradeFn fn, bool once) {
  if (c->close_emitted || c->response_started) {
    /* the exchange already resolved (a 101 fired or a response landed) */
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&c->upgrade_ls, cb, (void *)fn, once);
}

void scr_http_client_on_timeout(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once) {
  if (c->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&c->timeout_ls, cb, NULL, once);
}

void scr_http_client_on_close(ScrHttpClientReq *c, ScrClosure *cb /*moves*/, bool once) {
  if (c->close_emitted) {
    scr_closure_release(cb);
    return;
  }
  scr_net_ls_add(&c->close_ls, cb, NULL, once);
}

/* ── response parsing (the conn's client mode) ───────────────────────── */

/* Parses one complete response HEAD sitting at buf[0..head_len):
 * "HTTP/1.x SP status SP reason CRLF" then headers. Returns false on
 * malformed input (the caller hangs up). */
static bool scr_http_client_parse_head(ScrHttpConn *conn, size_t head_len) {
  ScrHttpClientReq *c = conn->client;
  if (!c) return false;
  const char *buf = conn->buf;
  const char *line_end = memchr(buf, '\r', head_len);
  if (!line_end || line_end + 1 >= buf + head_len || line_end[1] != '\n') return false;
  const char *sp1 = memchr(buf, ' ', (size_t)(line_end - buf));
  if (!sp1) return false;
  size_t verlen = (size_t)(sp1 - buf);
  if (!(verlen == 8 && (memcmp(buf, "HTTP/1.1", 8) == 0 || memcmp(buf, "HTTP/1.0", 8) == 0))) {
    return false;
  }
  const char *st = sp1 + 1;
  int status = 0;
  int digits = 0;
  while (st < line_end && *st >= '0' && *st <= '9' && digits < 3) {
    status = status * 10 + (*st - '0');
    st++;
    digits++;
  }
  if (digits != 3) return false;

  ScrHttpReq *res = calloc(1, sizeof *res);
  if (!res) scr_http_oom();
  res->rc = 1;
  res->status = status;
  res->sock = scr_net_sock_retain(conn->sock);
#ifdef SCR_RC_AUDIT
  scr_http_live++;
#endif
  res->method = scr_str_new("", 0);
  res->url = scr_str_new("", 0); /* Node: res.url is "" on client responses */
  res->http10 = memcmp(buf, "HTTP/1.0", 8) == 0;
  {
    /* the reason phrase — res.statusMessage ("" when absent, Node) */
    const char *reason = st;
    if (reason < line_end && *reason == ' ') reason++;
    res->status_msg = scr_str_new(reason, (size_t)(line_end - reason));
  }

  /* header lines until the blank line */
  const char *p = line_end + 2;
  const char *end = buf + head_len;
  bool ok = true;
  while (p < end) {
    const char *eol = memchr(p, '\r', (size_t)(end - p));
    if (!eol || eol + 1 >= end || eol[1] != '\n') {
      ok = false;
      break;
    }
    if (eol == p) break; /* the blank line */
    const char *colon = memchr(p, ':', (size_t)(eol - p));
    if (!colon || colon == p) {
      ok = false;
      break;
    }
    const char *v = colon + 1;
    while (v < eol && (*v == ' ' || *v == '\t')) v++;
    const char *ve = eol;
    while (ve > v && (ve[-1] == ' ' || ve[-1] == '\t')) ve--;
    scr_http_req_add_header(res, p, (size_t)(colon - p), v, (size_t)(ve - v));
    p = eol + 2;
  }
  if (!ok) {
    scr_http_req_release(res);
    return false;
  }

  /*
   * Informational responses do not settle the request. Node emits an
   * `information` event for these and keeps parsing until the final
   * response; this runtime has no information listener surface yet, so
   * consume the head and continue. 101 is the upgrade case below.
   */
  if (status >= 100 && status < 200 && status != 101) {
    memmove(conn->buf, conn->buf + head_len, conn->len - head_len);
    conn->len -= head_len;
    scr_http_req_release(res);
    return true;
  }

  /* framing: HEAD requests and 204/304 responses have NO body; chunked
   * wins over Content-Length; neither means EOF-delimited */
  bool chunked = false;
  long long content_length = -1;
  for (size_t i = 0; i < res->nheaders; i++) {
    const ScrStr *n = res->hnames[i];
    const ScrStr *v = res->hvalues[i];
    if (n->len == 17 && memcmp(n->data, "transfer-encoding", 17) == 0) {
      if (strstr(v->data, "chunked") != NULL) chunked = true;
    } else if (n->len == 14 && memcmp(n->data, "content-length", 14) == 0) {
      content_length = atoll(v->data);
      if (content_length < 0) content_length = 0;
    }
  }
  bool head_req = c->method->len == 4 && memcmp(c->method->data, "HEAD", 4) == 0;
  bool no_body = head_req || status == 204 || status == 304;

  /* 101 Switching Protocols: 'upgrade' fires INSTEAD of 'response' with
   * (res, socket, head) — the parser steps aside and the raw socket is
   * the listener's (the server-side handover, mirrored). With no
   * listener Node destroys the connection; so does this slice. */
  if (status == 101) {
    conn->client_resp_started = true;
    c->response_started = true;
    c->response_done = true; /* the exchange settled: no timeout/hang-up paths */
    c->res = scr_http_req_retain(res);
    memmove(conn->buf, conn->buf + head_len, conn->len - head_len);
    conn->len -= head_len;
    if (c->upgrade_ls.n == 0) {
      scr_http_req_release(res);
      conn->len = 0;
      scr_net_sock_destroy(conn->sock);
      return true;
    }
    ScrBytes *head = scr_bytes_new(SCR_BYTES_U8, (double)conn->len);
    if (conn->len > 0) memcpy(head->data, conn->buf, conn->len);
    conn->len = 0;
    scr_net_sock_clear_native_reader(conn->sock);
    ScrNetL *snap;
    size_t n = scr_net_ls_snapshot(&c->upgrade_ls, &snap);
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) {
        ((ScrHttpUpgradeFn)snap[i].fn)(snap[i].cb, scr_http_req_retain(res),
                                       scr_net_sock_retain(conn->sock), scr_bytes_retain(head));
      }
      scr_closure_release(snap[i].cb);
    }
    free(snap);
    scr_bytes_release(head);
    scr_http_req_release(res);
    /* The REQUEST handle's exchange is over: break the ctx→client edge
     * (the parser's native hooks are cleared, so the socket's 'closed'
     * would never break it — the cycle story) and settle 'close' through
     * the queue, Node's req 'close' after an upgrade. The handed-over
     * SOCKET lives on through its own refs. */
    conn->client = NULL;
    scr_http_client_queue_close(c);
    scr_http_client_release(c);
    return true;
  }

  conn->req = res; /* conn's +1 */
  conn->client_resp_started = true;
  c->response_started = true;
  c->res = scr_http_req_retain(res);

  /* consume the head bytes */
  memmove(conn->buf, conn->buf + head_len, conn->len - head_len);
  conn->len -= head_len;

  if (no_body) {
    conn->state = SCR_HTTP_HEAD;
  } else if (chunked) {
    conn->state = SCR_HTTP_CHUNK_SIZE;
  } else if (content_length > 0) {
    conn->state = SCR_HTTP_BODY_CL;
    conn->body_remaining = (size_t)content_length;
  } else if (content_length == 0) {
    conn->state = SCR_HTTP_HEAD;
  } else {
    conn->state = SCR_HTTP_BODY_EOF;
  }

  /* 'response' fires NOW (macrotask, main stack — Node emits it from the
   * socket's data path too) */
  ScrNetL *snap;
  size_t n = scr_net_ls_snapshot(&c->resp_ls, &snap);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((ScrHttpRespFn)snap[i].fn)(snap[i].cb, scr_http_req_retain(res));
    scr_closure_release(snap[i].cb);
  }
  free(snap);
  if (scr_exc_pending()) return true;

  if (conn->state == SCR_HTTP_HEAD) {
    /* bodiless response: 'end' + teardown immediately */
    scr_http_conn_body_done(conn);
  }
  return true;
}

/* The response completed: 'end' on the response, then the exchange tears
 * down — the socket closes (no pooling) and the deferred closes queue in
 * Node's order (req 'close' before res 'close'). */
static void scr_http_client_response_done(ScrHttpConn *conn) {
  ScrHttpClientReq *c = conn->client;
  ScrHttpReq *res = conn->req;
  if (!c || c->response_done) return;
  c->response_done = true;
  if (res) {
    scr_http_req_retain(res);
    scr_http_req_finish(res, true); /* fires 'end' */
  }
  /* Node's order: the REQUEST's 'close' precedes the response's */
  scr_http_client_queue_close(c);
  if (res) {
    scr_http_queue_req_close(res);
    scr_http_req_release(res);
    /* drop the conn's ref NOW: the response outlives the exchange only
     * through user refs / c->res — a retained conn->req would cycle
     * (res→sock→ctx→res) past every settle */
    conn->req = NULL;
    scr_http_req_release(res);
  }
  if (c->sock) scr_net_sock_destroy(c->sock); /* quiet close, no pooling */
}

/* Premature teardown classification, shared by eof/closed/error:
 * before any response head → 'socket hang up' on the REQUEST; mid-body →
 * 'aborted' on the RESPONSE (the request just closes) — both orders
 * oracle-pinned. */
static void scr_http_client_premature(ScrHttpConn *conn) {
  ScrHttpClientReq *c = conn->client;
  if (!c || c->response_done || c->close_emitted) return;
  c->response_done = true; /* the exchange is over, one way or another */
  if (!c->response_started) {
    if (!c->had_error) {
      ScrStr *msg = scr_str_new("socket hang up", 14);
      scr_http_client_error(c, msg);
      scr_str_release(msg);
      if (scr_exc_pending()) return;
    }
    scr_http_client_queue_close(c);
  } else {
    /* mid-head-to-body death: req close, then 'aborted' on the res, then
     * res close (the queue preserves push order) */
    scr_http_client_queue_close(c);
    if (conn->req) {
      ScrHttpReq *res = conn->req;
      scr_http_queue_req_aborted(res);
      scr_http_queue_req_close(res);
      scr_http_req_finish(res, false); /* body never completes */
      conn->req = NULL; /* break the res→sock→ctx→res cycle */
      scr_http_req_release(res);
    }
  }
}

static void scr_http_client_eof(ScrHttpConn *conn) {
  ScrHttpClientReq *c = conn->client;
  if (!c) return;
  if (conn->state == SCR_HTTP_BODY_EOF && c->response_started && !c->response_done) {
    /* EOF-delimited body: this IS completion */
    scr_http_conn_body_done(conn);
    return;
  }
  scr_http_client_premature(conn);
}

/* Detach a client from its agent (the socket died, or the handle
 * settled): the entry leaves the lists BEFORE the socket's own 'close'
 * listeners run — Node's agent removes its socket first too, so
 * agent.sockets no longer names it inside a user 'close' handler. */
static void scr_http_client_agent_detach(ScrHttpClientReq *c) {
  if (!c->agent) return;
  struct ScrHttpAgent *ag = c->agent;
  c->agent = NULL;
  scr_http_agent_client_done(ag, c); /* frees the slot; may dial the next */
  scr_http_agent_release_p(ag);
}

static void scr_http_client_closed(ScrHttpConn *conn) {
  ScrHttpClientReq *c = conn->client;
  if (!c) return;
  scr_http_client_agent_detach(c);
  scr_http_client_premature(conn);
  /* the connection is gone: break the ctx→client edge (the client stays
   * alive through user refs / the queue until its 'close' settles) */
  conn->client = NULL;
  scr_http_client_release(c);
}

static bool scr_http_client_sock_err(ScrHttpConn *conn, ScrStr *msg) {
  ScrHttpClientReq *c = conn->client;
  if (!c) return true;
  if (c->response_done || c->close_emitted) return true; /* teardown noise */
  if (!c->response_started) {
    /* connect/read failure before any response: the socket's message IS
     * Node's ('connect ECONNREFUSED ip:port') — fire it on the request */
    c->response_done = true;
    scr_http_client_error(c, msg);
    if (!scr_exc_pending()) scr_http_client_queue_close(c);
  } else {
    scr_http_client_premature(conn);
  }
  return true;
}

/* Header-cap overflow / malformed response head: Node surfaces a parse
 * error on the request; this slice hangs up with the same teardown shape
 * ('socket hang up' when nothing parsed yet). */
static void scr_http_client_head_overflow(ScrHttpConn *conn) {
  conn->len = 0;
  scr_http_client_premature(conn);
  if (conn->client && conn->client->sock) scr_net_sock_destroy(conn->client->sock);
}

/* The client socket's idle timeout: 'timeout' on the request handle
 * (never destroys anything — Node; the caller destroys). */
static void scr_http_client_sock_timeout(void *ctx) {
  ScrHttpConn *conn = (ScrHttpConn *)ctx;
  ScrHttpClientReq *c = conn->client;
  if (!c || c->response_done || c->close_emitted) return;
  scr_net_fire0(&c->timeout_ls);
}

static void scr_http_client_conn_free(ScrHttpConn *conn) {
  if (conn->req) {
    scr_http_req_finish(conn->req, false);
    scr_http_req_release(conn->req);
    conn->req = NULL;
  }
  if (conn->client) {
    ScrHttpClientReq *c = conn->client;
    conn->client = NULL;
    scr_http_client_release(c);
  }
  free(conn->buf);
  free(conn);
}

/* ── http.request / http.get ─────────────────────────────────────────── */

static ScrHttpClientReq *scr_http_request_impl(ScrStr *host /*borrowed*/, double port,
                                                ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                                double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                                bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                                ScrHttpRespFn fn, int default_port,
                                                void (*wrap)(ScrNetSocket *, void *), void *wrap_ctx,
                                                ScrNetSocket *presock /*moves, nullable*/) {
  /* Node's ClientRequest constructor validates the method token
   * SYNCHRONOUSLY (RFC 9110 tchar, at least one): the catchable
   * ERR_INVALID_HTTP_TOKEN TypeError with Node's exact message, the raw
   * method text inside the quotes. Moved-in arguments release — the
   * request never exists. */
  bool method_ok = method->len > 0;
  for (size_t i = 0; i < method->len && method_ok; i++) {
    unsigned char ch = (unsigned char)method->data[i];
    method_ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                (ch >= '0' && ch <= '9') ||
                (ch != 0 && strchr("!#$%&'*+-.^_`|~", ch) != NULL);
  }
  if (!method_ok) {
    if (cb) scr_closure_release(cb);
    if (presock) scr_net_sock_release(presock);
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "Method must be a valid HTTP token [\"");
    for (size_t i = 0; i < method->len; i++) scr_jb_putc(&b, method->data[i]);
    scr_jb_puts(&b, "\"]");
    ScrStr *msg = scr_jb_finish(&b);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len, "ERR_INVALID_HTTP_TOKEN");
    scr_str_release(msg);
    return NULL;
  }
  scr_http_install();
  ScrHttpClientReq *c = calloc(1, sizeof *c);
  if (!c) scr_http_oom();
  c->rc = 1;
#ifdef SCR_RC_AUDIT
  scr_http_live++;
#endif
  c->host = scr_str_retain(host);
  c->path = scr_str_retain(path);
  c->method = scr_str_retain(method);
  c->port = (int)port;
  c->default_port = default_port;
  size_t npairs = (size_t)scr_arr_len(header_pairs);
  if (npairs >= 2) {
    c->hnames = malloc((npairs / 2) * sizeof *c->hnames);
    c->hvalues = malloc((npairs / 2) * sizeof *c->hvalues);
    if (!c->hnames || !c->hvalues) scr_http_oom();
    for (size_t i = 0; i + 1 < npairs; i += 2) {
      c->hnames[c->nheaders] = (ScrStr *)scr_arr_get_ref(header_pairs, (double)i);
      c->hvalues[c->nheaders] = (ScrStr *)scr_arr_get_ref(header_pairs, (double)(i + 1));
      c->nheaders++;
    }
  }
  c->user_cl = scr_http_client_has_header(c, "content-length") ||
               scr_http_client_has_header(c, "transfer-encoding");
  if (cb) scr_net_ls_add(&c->resp_ls, cb, (void *)fn, true);

  /* dial — or take the caller's pre-made socket (createConnection); dial
   * failures are the async 'error' either way, the net story.
   *
   * The hostname resolves HERE, at the client dial, the way the island's
   * client and the native fetch resolve at theirs: node:net's own connect
   * surface stays resolver-less on purpose (Node's async lookup semantics
   * are not this), so a client that dials by name has to ask. Only the
   * dial takes the address — c->host keeps the ORIGINAL name, which is
   * what the Host header carries and what the caller built the TLS
   * client's SNI from. An unresolvable name comes back unchanged and the
   * dial delivers Node's deferred ENOTFOUND. */
  if (presock != NULL) {
    c->sock = presock;
  } else {
    ScrStr *dial = scr_net_blocking_lookup(host);
    c->sock = scr_net_connect(port, dial, NULL);
    scr_str_release(dial);
  }
  ScrHttpConn *conn = calloc(1, sizeof *conn);
  if (!conn) scr_http_oom();
  conn->sock = c->sock; /* borrowed */
  conn->client_mode = true;
  conn->client = scr_http_client_retain(c);
  c->conn = conn;
  scr_net_sock_set_native_reader(c->sock, &scr_http_conn_data, &scr_http_conn_eof,
                                  &scr_http_conn_closed, conn, &scr_http_conn_free);
  scr_net_sock_set_native_events(c->sock, &scr_http_client_sock_timeout, &scr_http_conn_err);
  /* the transport (scr_tls.c's https) wraps the dialed socket before any
   * bytes go out — everything below buffers until its handshake ends */
  if (wrap) wrap(c->sock, wrap_ctx);
  if (timeout_ms > 0) scr_net_sock_set_timeout(c->sock, timeout_ms);
  scr_http_client_register(c);
  if (auto_end) scr_http_client_end(c);
  return c;
}

ScrHttpClientReq *scr_http_request_ex(ScrStr *host /*borrowed*/, double port,
                                       ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                       double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                       bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                       ScrHttpRespFn fn, int default_port,
                                       void (*wrap)(ScrNetSocket *, void *), void *wrap_ctx) {
  return scr_http_request_impl(host, port, path, method, timeout_ms, header_pairs, auto_end,
                                cb, fn, default_port, wrap, wrap_ctx, NULL);
}

/* http.request({ createConnection, ... }): the caller's DIALER supplies
 * the socket — conn_cb runs ONCE, synchronously (Node invokes it from
 * the request constructor's onSocket path), and its socket carries the
 * exchange exactly like a dialed one (head bytes buffer through connect
 * and flush on establishment). The Host header defaults to "localhost"
 * — the proxy shape sets headers.host itself, which wins verbatim. */
ScrHttpClientReq *scr_http_request_conn(ScrClosure *conn_cb /*moves*/, ScrStr *path /*borrowed*/,
                                         ScrStr *method /*borrowed*/, double timeout_ms,
                                         ScrArr *header_pairs /*borrowed*/, bool auto_end,
                                         ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn) {
  ScrNetSocket *sock = ((ScrNetSocket *(*)(ScrClosure *))conn_cb->fn)(conn_cb); /* +1 result */
  scr_closure_release(conn_cb);
  if (scr_exc_pending() || sock == NULL) {
    /* the dialer threw: NULL result, dummy-released past the emitted
     * pending check (the libCall is in the may-throw seed set) */
    if (cb != NULL) scr_closure_release(cb);
    scr_net_sock_release(sock);
    return NULL;
  }
  ScrStr *host = scr_str_new("localhost", 9);
  ScrHttpClientReq *c = scr_http_request_impl(host, 80, path, method, timeout_ms, header_pairs,
                                               auto_end, cb, fn, 80, NULL, NULL, sock);
  scr_str_release(host);
  return c;
}

ScrHttpClientReq *scr_http_request(ScrStr *host /*borrowed*/, double port,
                                    ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                    double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                    bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                    ScrHttpRespFn fn) {
  return scr_http_request_ex(host, port, path, method, timeout_ms, header_pairs, auto_end, cb,
                              fn, 80, NULL, NULL);
}

/* ── the http Agent ──────────────────────────────────────────────────────
 *
 * Options, getName, destroy, and REAL maxSockets accounting over the
 * one-dial-per-request connection model: an over-limit request's socket
 * defers its dial (scr_net_connect_deferred) and queues; a dying
 * active connection frees the slot and starts the next dial. What the
 * runtime cannot express stays a NAMED fence: keep-alive socket POOLING
 * (keepAlive: true) fences at construction — agent.freeSockets is
 * always empty; the runtime does not emulate a pool.
 *
 * Ownership: the agent registers (+1, atexit-swept); entries hold their
 * client +1 and the client holds the agent +1 — the cycle breaks when
 * the client's socket dies (scr_http_client_agent_detach) or at the
 * atexit sweep. */

typedef struct ScrHttpAgentEnt {
  ScrStr *name; /* getName's shape: "host:port:" */
  ScrHttpClientReq *client; /* +1 while listed */
  bool queued;              /* waiting for a slot: the dial is deferred */
  struct ScrHttpAgentEnt *next;
} ScrHttpAgentEnt;

typedef struct ScrHttpAgent {
  size_t rc;
  bool secure;      /* https.Agent: protocol/defaultPort answers */
  bool keep_alive;  /* always false here (true fences at construction) */
  double ka_msecs;
  double max_sockets; /* INFINITY = Node's default */
  double max_free;
  double timeout_ms; /* < 0 = unset */
  double default_port; /* settable (agent.defaultPort = p) */
  bool destroyed;
  ScrHttpAgentEnt *ents; /* append order — Node's FIFO queue */
  bool in_registry;
  struct ScrHttpAgent *next;
} ScrHttpAgent;

static ScrHttpAgent *scr_http_agents = NULL; /* registry: +1 each, atexit-swept */

static ScrHttpAgent *scr_http_agent_retain(ScrHttpAgent *a) {
  a->rc++;
  return a;
}

static void scr_http_agent_release(ScrHttpAgent *a) {
  if (!a || --a->rc > 0) return;
  ScrHttpAgentEnt *e = a->ents;
  while (e) {
    ScrHttpAgentEnt *next = e->next;
    scr_str_release(e->name);
    scr_http_client_release(e->client);
    free(e);
    e = next;
  }
  free(a);
}

static struct ScrHttpAgent *scr_http_agent_release_p(struct ScrHttpAgent *ag) {
  scr_http_agent_release(ag);
  return NULL;
}

static void *scr_http_agent_retain_v(void *p) { return scr_http_agent_retain((ScrHttpAgent *)p); }
static void scr_http_agent_release_v(void *p) { scr_http_agent_release((ScrHttpAgent *)p); }

/* Actives (dialed, not settled) under a name. */
static size_t scr_http_agent_active(const ScrHttpAgent *a, const ScrStr *name) {
  size_t n = 0;
  for (const ScrHttpAgentEnt *e = a->ents; e; e = e->next) {
    if (!e->queued && e->name->len == name->len &&
        memcmp(e->name->data, name->data, name->len) == 0) n++;
  }
  return n;
}

/* The settling/dying client leaves the lists; a freed slot starts the
 * first queued dial for the same name (Node's FIFO). */
static void scr_http_agent_client_done(struct ScrHttpAgent *ag, struct ScrHttpClientReq *c) {
  ScrHttpAgentEnt **link = &ag->ents;
  ScrStr *name = NULL;
  while (*link && (*link)->client != c) link = &(*link)->next;
  if (*link) {
    ScrHttpAgentEnt *e = *link;
    *link = e->next;
    name = e->name; /* ownership moves out for the pump below */
    scr_http_client_release(e->client);
    free(e);
  }
  if (name != NULL && !ag->destroyed) {
    for (ScrHttpAgentEnt *e = ag->ents; e; e = e->next) {
      if (e->queued && e->name->len == name->len &&
          memcmp(e->name->data, name->data, name->len) == 0) {
        if (scr_http_agent_active(ag, name) < ag->max_sockets) {
          e->queued = false;
          if (e->client->sock) scr_net_sock_dial_start(e->client->sock);
        }
        break;
      }
    }
  }
  scr_str_release(name);
}

/* getName's string builder — Node's exact shape:
 * host:port:localAddress[:family][:socketPath]. */
static ScrStr *scr_http_agent_name(const char *host, size_t host_len, const char *port,
                                    size_t port_len, const char *laddr, size_t laddr_len,
                                    int family, const char *spath, size_t spath_len) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  if (host_len == 0) { scr_jb_puts(&b, "localhost"); }
  else for (size_t i = 0; i < host_len; i++) scr_jb_putc(&b, host[i]);
  scr_jb_putc(&b, ':');
  for (size_t i = 0; i < port_len; i++) scr_jb_putc(&b, port[i]);
  scr_jb_putc(&b, ':');
  for (size_t i = 0; i < laddr_len; i++) scr_jb_putc(&b, laddr[i]);
  if (family == 4 || family == 6) {
    scr_jb_putc(&b, ':');
    scr_jb_putc(&b, family == 4 ? '4' : '6');
  }
  if (spath_len > 0) {
    scr_jb_putc(&b, ':');
    for (size_t i = 0; i < spath_len; i++) scr_jb_putc(&b, spath[i]);
  }
  return scr_jb_finish(&b);
}

ScrDyn *scr_http_agent_new(bool secure, bool keep_alive, double ka_msecs,
                            double max_sockets, double max_free, double timeout_ms,
                            double port /* < 0 = unset */) {
  if (keep_alive) {
    static const char msg[] =
        "an http Agent with keepAlive: true (socket pooling and reuse — compiled clients "
        "dial one connection per request and close it with the response) is not supported "
        "yet — construct the Agent without keepAlive, or drop the agent option";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return NULL;
  }
  scr_http_install();
  ScrHttpAgent *a = calloc(1, sizeof *a);
  if (!a) scr_http_oom();
  a->rc = 1;
  a->secure = secure;
  a->keep_alive = false;
  a->ka_msecs = ka_msecs >= 0 ? ka_msecs : 1000;
  a->max_sockets = max_sockets >= 0 ? max_sockets : (double)INFINITY;
  a->max_free = max_free >= 0 ? max_free : 256;
  a->timeout_ms = timeout_ms;
  /* an agent-options `port` merges under portless request options (Node
   * merges agent options into each connection) — the settable
   * defaultPort carries it */
  a->default_port = port >= 0 ? port : secure ? 443 : 80;
  /* registry (+1): the atexit sweep breaks agent↔client edges a program
   * legitimately leaves in flight */
  a->in_registry = true;
  a->next = scr_http_agents;
  scr_http_agents = scr_http_agent_retain(a);
  ScrDyn *d = scr_dyn_new_handle(a, SCR_DYNH_HTTP_AGENT);
  scr_http_agent_release(a); /* the handle's retain holds it */
  return d;
}

/* agent.destroy(): tears down every listed connection (actives destroy
 * their sockets, queued dials never start) — Node destroys in-use
 * sockets too; there is no free pool here. */
static void scr_http_agent_destroy(ScrHttpAgent *a) {
  a->destroyed = true;
  /* destroying sockets detaches entries re-entrantly — walk a snapshot */
  for (;;) {
    ScrHttpClientReq *victim = NULL;
    for (ScrHttpAgentEnt *e = a->ents; e; e = e->next) {
      if (e->client->sock && !e->client->close_emitted) {
        victim = e->client;
        break;
      }
    }
    if (!victim) break;
    scr_http_client_agent_detach(victim); /* leaves the list first */
    scr_net_sock_destroy(victim->sock);
  }
}

ScrHttpClientReq *scr_http_request_agent_ex(ScrStr *host /*borrowed*/, double port,
                                             ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                             double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                             bool auto_end, const ScrDyn *agent /*borrowed*/,
                                             ScrClosure *cb /*moves, nullable*/,
                                             ScrHttpRespFn fn, int default_port,
                                             void (*wrap)(ScrNetSocket *, void *), void *wrap_ctx) {
  /* the null/undefined arms: the default path (port < 0 = no port option) */
  if (agent == NULL || agent->kind == SCR_DYN_UNDEF || agent->kind == SCR_DYN_NULL) {
    double p = port >= 0 ? port : (double)default_port;
    return scr_http_request_impl(host, p, path, method, timeout_ms, header_pairs, auto_end,
                                  cb, fn, default_port, wrap, wrap_ctx, NULL);
  }
  /* agent: false — Node's one-shot Agent: exactly this client's model,
   * plus its Connection: close request header (unless the caller set one) */
  if (agent->kind == SCR_DYN_BOOL && !agent->v.b) {
    double p = port >= 0 ? port : (double)default_port;
    bool has_conn = false;
    size_t npairs = (size_t)scr_arr_len(header_pairs);
    for (size_t i = 0; i + 1 < npairs && !has_conn; i += 2) {
      ScrStr *n = (ScrStr *)scr_arr_get_ref(header_pairs, (double)i);
      if (n->len == 10) {
        bool eq = true;
        for (size_t j = 0; j < 10 && eq; j++) {
          if (tolower((unsigned char)n->data[j]) != "connection"[j]) eq = false;
        }
        has_conn = eq;
      }
      scr_str_release(n);
    }
    ScrArr *pairs = header_pairs;
    ScrArr *copy = NULL;
    if (!has_conn) {
      copy = scr_arr_new(SCR_ELEM_STR, npairs + 2);
      for (size_t i = 0; i < npairs; i++) scr_arr_push_ref(copy, scr_arr_get_ref(header_pairs, (double)i));
      scr_arr_push_ref(copy, scr_str_new("Connection", 10));
      scr_arr_push_ref(copy, scr_str_new("close", 5));
      pairs = copy;
    }
    ScrHttpClientReq *c = scr_http_request_impl(host, p, path, method, timeout_ms, pairs,
                                                 auto_end, cb, fn, default_port, wrap, wrap_ctx, NULL);
    if (copy) scr_arr_release(copy);
    return c;
  }
  if (agent->kind != SCR_DYN_HANDLE || agent->v.handle.tag != SCR_DYNH_HTTP_AGENT) {
    if (cb) scr_closure_release(cb);
    scr_dyn_arg_type_fail("options.agent", "an instance of http.Agent, false, null, or undefined", agent);
    return NULL;
  }
  ScrHttpAgent *ag = (ScrHttpAgent *)agent->v.handle.ptr;
  double p = port >= 0 ? port
           : ag->default_port > 0 ? ag->default_port
           : (double)default_port;
  char portbuf[16];
  int portn = snprintf(portbuf, sizeof portbuf, "%d", (int)p);
  ScrStr *name = scr_http_agent_name(host->data, host->len, portbuf, (size_t)portn,
                                      NULL, 0, 0, NULL, 0);
  bool queue = scr_http_agent_active(ag, name) >= ag->max_sockets;
  ScrNetSocket *presock = queue ? scr_net_connect_deferred(p, host) : NULL;
  ScrHttpClientReq *c = scr_http_request_impl(host, p, path, method, timeout_ms, header_pairs,
                                               auto_end, cb, fn, default_port, wrap, wrap_ctx,
                                               presock);
  if (c == NULL) { /* the method-token throw: nothing registered */
    scr_str_release(name);
    return NULL;
  }
  if (ag->timeout_ms >= 0 && timeout_ms <= 0) scr_net_sock_set_timeout(c->sock, ag->timeout_ms);
  c->agent = scr_http_agent_retain(ag);
  ScrHttpAgentEnt *e = calloc(1, sizeof *e);
  if (!e) scr_http_oom();
  e->name = name; /* ownership moves */
  e->client = scr_http_client_retain(c);
  e->queued = queue;
  ScrHttpAgentEnt **link = &ag->ents;
  while (*link) link = &(*link)->next;
  *link = e;
  return c;
}

ScrHttpClientReq *scr_http_request_agent(ScrStr *host /*borrowed*/, double port,
                                          ScrStr *path /*borrowed*/, ScrStr *method /*borrowed*/,
                                          double timeout_ms, ScrArr *header_pairs /*borrowed*/,
                                          bool auto_end, const ScrDyn *agent /*borrowed*/,
                                          ScrClosure *cb /*moves, nullable*/, ScrHttpRespFn fn) {
  return scr_http_request_agent_ex(host, port, path, method, timeout_ms, header_pairs, auto_end,
                                    agent, cb, fn, 80, NULL, NULL);
}

/* The atexit sweep: break agent↔client edges a program leaves in flight
 * (queued dials that never ran) so the RC audit sees a clean heap. */
static void scr_http_agents_cleanup(void) {
  while (scr_http_agents) {
    ScrHttpAgent *a = scr_http_agents;
    scr_http_agents = a->next;
    a->in_registry = false;
    ScrHttpAgentEnt *e = a->ents;
    a->ents = NULL;
    while (e) {
      ScrHttpAgentEnt *next = e->next;
      if (e->client->agent) {
        scr_http_agent_release(e->client->agent);
        e->client->agent = NULL;
      }
      scr_str_release(e->name);
      scr_http_client_release(e->client);
      free(e);
      e = next;
    }
    scr_http_agent_release(a);
  }
}

/* Exit-time registry cleanup (the net-unit precedent): clients a program
 * legitimately leaves in flight at exit release their listeners and
 * registry references so the RC audit sees a clean heap. */
static void scr_http_clients_cleanup(void) {
  while (scr_http_clients) {
    ScrHttpClientReq *c = scr_http_clients;
    scr_net_ls_drop(&c->resp_ls);
    scr_net_ls_drop(&c->err_ls);
    scr_net_ls_drop(&c->timeout_ls);
    scr_net_ls_drop(&c->close_ls);
    scr_net_ls_drop(&c->upgrade_ls);
    scr_http_client_unregister(c);
  }
}

/* The response-callback adapters: res arrives +1; the zero-param shape
 * releases it. */
void scr_http_resp_thunk0(ScrClosure *cb, ScrHttpReq *res) {
  scr_http_req_release(res);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_http_resp_thunk_res(ScrClosure *cb, ScrHttpReq *res) {
  ((void (*)(ScrClosure *, ScrHttpReq *))cb->fn)(cb, res);
}

/* ── checked-dynamic handle dispatch (SCR_DYN_HANDLE ops) ──────────────
 *
 * The receiver surface behind `server.on('request', mustCall((req, res)
 * => ...))`: the mustCall wrapper makes the listener dyn, req/res box
 * into the checked-dynamic tree as HANDLE values, and member uses inside the listener
 * body dispatch HERE — onto the very entry points the static lowerings
 * use, with per-argument gates shaped like Node's (the libCall signature
 * table in validate.ts is the modeled surface; this dispatcher mirrors
 * it name for name).
 *
 * Honesty ladder (the scr_dyn_invoke stance):
 *   - modeled member: the static entry point's exact semantics;
 *   - a member the class HAS but this table does not model: a LOUD
 *     "not supported yet" Error — never a silent wrong answer;
 *   - anything else: Node's "<spelling> is not a function" for calls,
 *     the undefined singleton for reads (the checked-dynamic tree's own-property answer;
 *     SEMANTICS.md documents the remainder).
 *
 * Ownership: invoke/get/set receive BORROWED handles/args and answer
 * owned (+1) results; listener registrations retain the dyn callback
 * into a runtime-built adapter closure (scr_dyn_listener_closure*). */

static void scr_http_dynh_unsupported(const char *cls, const char *member, const char *what) {
  char msg[160];
  int n = snprintf(msg, sizeof msg, "'%s.prototype.%s' on a dynamic value is not supported yet%s%s",
                   cls, member, what ? " — " : "", what ? what : "");
  scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
}

static void scr_http_dynh_not_fn(const char *what) {
  char msg[160];
  int n = snprintf(msg, sizeof msg, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
}

static void scr_http_dynh_event_unsupported(const char *cls, const ScrDyn *name) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "listening for '");
  if (name->kind == SCR_DYN_STR) {
    for (size_t i = 0; i < name->v.str->len; i++) scr_jb_putc(&b, name->v.str->data[i]);
  }
  scr_jb_puts(&b, "' on a dynamic ");
  scr_jb_puts(&b, cls);
  scr_jb_puts(&b, " is not supported yet");
  scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
}

static bool scr_http_dynh_name_is(const ScrDyn *name, const char *lit) {
  size_t n = strlen(lit);
  return name->kind == SCR_DYN_STR && name->v.str->len == n &&
         memcmp(name->v.str->data, lit, n) == 0;
}

static bool scr_http_dynh_in(const char *m, const char *const *names) {
  for (size_t i = 0; names[i]; i++) {
    if (strcmp(m, names[i]) == 0) return true;
  }
  return false;
}

/* The registration-family gate shared by every handle class: on/once/
 * addListener (prepend* is unmodeled — these per-event lists know no
 * front). Answers the once flag; leaves reg=false for other names. */
static bool scr_http_dynh_reg(const char *method, bool *once) {
  if (strcmp(method, "on") == 0 || strcmp(method, "addListener") == 0) {
    *once = false;
    return true;
  }
  if (strcmp(method, "once") == 0) {
    *once = true;
    return true;
  }
  return false;
}

/* String/Buffer chunk gate (res.end/res.write/socket.write): answers
 * which flavor, throws Node's ERR_INVALID_ARG_TYPE otherwise. */
static bool scr_http_dynh_chunk_ok(const ScrDyn *chunk) {
  if (chunk->kind == SCR_DYN_STR || chunk->kind == SCR_DYN_BYTES) return true;
  scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", chunk);
  return false;
}

/* An optional trailing encoding argument on write/end: utf8 spellings
 * pass through (string chunks already carry utf8 bytes); every other
 * real Node encoding decodes the STRING chunk through Buffer.from's
 * decoder into *out (+1; buffer chunks ignore the encoding, Node);
 * unknown names throw Node's ERR_UNKNOWN_ENCODING. False = exception
 * pending. */
static bool scr_http_dynh_encode(const ScrDyn *chunk, const ScrDyn *enc, ScrBytes **out) {
  *out = NULL;
  if (enc->kind != SCR_DYN_STR || !scr_bytes_is_encoding(enc->v.str)) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "Unknown encoding: ");
    if (enc->kind == SCR_DYN_STR) {
      for (size_t i = 0; i < enc->v.str->len && i < 64; i++) scr_jb_putc(&b, enc->v.str->data[i]);
    }
    ScrStr *msg = scr_jb_finish(&b);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len, "ERR_UNKNOWN_ENCODING");
    scr_str_release(msg);
    return false;
  }
  if (chunk->kind != SCR_DYN_STR) return true; /* buffers carry their bytes */
  /* lowercase + alias normalization down to scr_bytes_from_str's arms */
  char low[10];
  size_t n = enc->v.str->len < 9 ? enc->v.str->len : 9;
  for (size_t i = 0; i < n; i++) {
    char c = enc->v.str->data[i];
    low[i] = c >= 'A' && c <= 'Z' ? (char)(c + 32) : c;
  }
  low[n] = 0;
  const char *canon = low;
  if (strcmp(low, "utf8") == 0 || strcmp(low, "utf-8") == 0) return true; /* passthrough */
  if (strcmp(low, "binary") == 0) canon = "latin1";
  else if (strcmp(low, "ucs2") == 0 || strcmp(low, "ucs-2") == 0 || strcmp(low, "utf-16le") == 0) canon = "utf16le";
  ScrStr *cs = scr_str_new(canon, strlen(canon));
  *out = scr_bytes_from_str(chunk->v.str, cs);
  scr_str_release(cs);
  return true;
}

/* ── IncomingMessage (SCR_DYNH_HTTP_REQ) ─────────────────────────────── */

static ScrDyn *scr_http_dynh_req_invoke(void *h, ScrDyn *self, const char *method,
                                        ScrDyn *const *args, size_t argc, const char *what) {
  ScrHttpReq *r = (ScrHttpReq *)h;
  bool once = false;
  if (scr_http_dynh_reg(method, &once)) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    const ScrDyn *cb = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(cb, "listener");
    if (scr_exc_pending()) return NULL;
    if (scr_http_dynh_name_is(name, "data")) {
      scr_http_req_on_data(r, scr_dyn_listener_closure_data(cb), (ScrNetDataFn)&scr_dyn_listener_fire_data, once);
    } else if (scr_http_dynh_name_is(name, "end")) {
      scr_http_req_on_end(r, scr_dyn_listener_closure0(cb), once);
    } else if (scr_http_dynh_name_is(name, "error")) {
      scr_http_req_on_error(r, scr_dyn_listener_closure_err(cb), (ScrChildErrFn)&scr_dyn_listener_fire_err, once);
    } else if (scr_http_dynh_name_is(name, "close")) {
      scr_http_req_on_close(r, scr_dyn_listener_closure0(cb), once);
    } else if (scr_http_dynh_name_is(name, "aborted")) {
      scr_http_req_on_aborted(r, scr_dyn_listener_closure0(cb), once);
    } else if (scr_http_dynh_name_is(name, "timeout") && r->sock != NULL) {
      /* the socket's idle timer — req.setTimeout's event, Node's delegation */
      scr_net_sock_on_timeout(r->sock, scr_dyn_listener_closure0(cb), once);
    } else {
      scr_http_dynh_event_unsupported("IncomingMessage", name);
      return NULL;
    }
    return scr_dyn_retain(self); /* chaining, like Node */
  }
  if (strcmp(method, "resume") == 0) {
    scr_http_req_resume(r);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "pause") == 0) {
    scr_http_req_pause(r);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "setTimeout") == 0) {
    const ScrDyn *ms = argc > 0 ? args[0] : scr_dyn_undefined();
    if (ms->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("msecs", "of type number", ms);
      return NULL;
    }
    ScrClosure *cb = NULL;
    if (argc > 1 && args[1]->kind == SCR_DYN_FUNC) cb = scr_dyn_listener_closure0(args[1]);
    else if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF) {
      scr_dyn_check_listener(args[1], "callback");
      return NULL;
    }
    scr_http_req_set_timeout(r, ms->v.num, cb);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "setEncoding") == 0) {
    const ScrDyn *enc = argc > 0 ? args[0] : scr_dyn_undefined();
    if (enc->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("encoding", "of type string", enc);
      return NULL;
    }
    scr_http_req_set_encoding(r, enc->v.str);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "destroy") == 0) {
    if (argc > 0 && args[0]->kind != SCR_DYN_UNDEF) {
      scr_http_dynh_unsupported("IncomingMessage", "destroy", "destroy(error) carries a payload this surface does not model");
      return NULL;
    }
    scr_http_req_destroy(r);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "pipe") == 0) {
    const ScrDyn *dst = argc > 0 ? args[0] : scr_dyn_undefined();
    if (dst->kind == SCR_DYN_HANDLE && dst->v.handle.tag == SCR_DYNH_HTTP_RES) {
      scr_http_req_pipe_res(r, (ScrHttpRes *)dst->v.handle.ptr);
      return scr_dyn_retain((ScrDyn *)dst); /* pipe answers the destination */
    }
    if (dst->kind == SCR_DYN_HANDLE && dst->v.handle.tag == SCR_DYNH_NET_SOCKET) {
      scr_http_req_pipe_sock(r, (ScrNetSocket *)dst->v.handle.ptr);
      return scr_dyn_retain((ScrDyn *)dst);
    }
    scr_http_dynh_unsupported("IncomingMessage", "pipe", "only ServerResponse and Socket destinations are modeled");
    return NULL;
  }
  if (strcmp(method, "toString") == 0) {
    ScrStr *s = scr_str_new("[object Object]", 15);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  {
    /* Real prototype members without a modeled dispatch: loud. */
    static const char *const known[] = { "unpipe",
      "read", "push", "off", "removeListener", "removeAllListeners", "emit",
      "prependListener", "prependOnceListener", "listenerCount", "listeners",
      "isPaused", "wrap", "cork", "uncork", NULL };
    if (scr_http_dynh_in(method, known)) {
      scr_http_dynh_unsupported("IncomingMessage", method, NULL);
      return NULL;
    }
  }
  scr_http_dynh_not_fn(what);
  return NULL;
}

static ScrDyn *scr_http_dynh_req_get(void *h, const char *key, size_t key_len) {
  ScrHttpReq *r = (ScrHttpReq *)h;
  (void)key_len;
  if (strcmp(key, "url") == 0) {
    ScrStr *s = scr_http_req_url(r);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  if (strcmp(key, "httpVersion") == 0) {
    /* The parsed request/status line's version — the 1.0 tests read it;
     * the h2 compat request answers Node's "2.0". */
    ScrStr *v = scr_str_new(r->http2 ? "2.0" : r->http10 ? "1.0" : "1.1", 3);
    ScrDyn *d = scr_dyn_new_str(v);
    scr_str_release(v);
    return d;
  }
  if (strcmp(key, "httpVersionMajor") == 0) return scr_dyn_new_num(r->http2 ? 2 : 1);
  if (strcmp(key, "httpVersionMinor") == 0) return scr_dyn_new_num(r->http2 ? 0 : r->http10 ? 0 : 1);
  if (strcmp(key, "method") == 0) {
    ScrStr *s = scr_http_req_method(r);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  if (strcmp(key, "headers") == 0) {
    /* The snapshot object `{ ...req.headers }` builds — lowercased
     * names, arrival order, keep-first duplicates (joined under the
     * joinDuplicateHeaders option), the static lane's exact feed. */
    ScrArr *pairs = scr_http_req_header_pairs(r);
    ScrDyn *obj = scr_dyn_new_obj();
    size_t n = (size_t)scr_arr_len(pairs);
    for (size_t i = 0; i + 1 < n; i += 2) {
      ScrStr *name = (ScrStr *)scr_arr_get_ref(pairs, (double)i);
      ScrStr *value = (ScrStr *)scr_arr_get_ref(pairs, (double)(i + 1));
      /* Keep-FIRST on repeated names (scr_dyn_obj_set is later-wins) —
       * the per-name read's rule (scr_http_req_header), so h.headers.x
       * and h.headers['x'] agree; joinDuplicateHeaders pairs arrive
       * pre-joined and unique. */
      if (!scr_dyn_obj_get(obj, name->data, name->len)) {
        scr_dyn_obj_set(obj, name->data, name->len, scr_dyn_new_str(value));
      }
      scr_str_release(name);
      scr_str_release(value);
    }
    scr_arr_release(pairs);
    return obj;
  }
  if (strcmp(key, "rawHeaders") == 0) {
    ScrArr *raw = scr_http_req_raw_headers(r);
    ScrDyn *arr = scr_dyn_new_arr();
    size_t n = (size_t)scr_arr_len(raw);
    for (size_t i = 0; i < n; i++) {
      ScrStr *s = (ScrStr *)scr_arr_get_ref(raw, (double)i);
      scr_dyn_arr_push(arr, scr_dyn_new_str(s));
      scr_str_release(s);
    }
    scr_arr_release(raw);
    return arr;
  }
  if (strcmp(key, "statusCode") == 0) {
    double st = scr_http_req_status(r);
    /* Node's IncomingMessage constructor sets statusCode = null; only a
     * client response assigns a number (the static lane's typed surface
     * spells this number|undefined — the checked-dynamic tree can afford Node's null). */
    return st < 0 ? scr_dyn_new_null() : scr_dyn_new_num(st);
  }
  if (strcmp(key, "statusMessage") == 0) {
    ScrStr *s = scr_http_req_status_message(r);
    if (!s) return scr_dyn_new_null(); /* null on server requests, like statusCode */
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  if (strcmp(key, "socket") == 0 || strcmp(key, "connection") == 0) {
    ScrNetSocket *s = scr_http_req_socket(r);
    if (!s) return NULL;
    ScrDyn *d = scr_dyn_new_handle(s, SCR_DYNH_NET_SOCKET);
    scr_net_sock_release(s);
    return d;
  }
  if (strcmp(key, "aborted") == 0) return scr_dyn_new_bool(r->aborted);
  if (strcmp(key, "complete") == 0) return scr_dyn_new_bool(r->ended);
  if (strcmp(key, "destroyed") == 0) return scr_dyn_new_bool(scr_http_req_destroyed_flag(r));
  if (strcmp(key, "readable") == 0) return scr_dyn_new_bool(scr_http_req_readable(r));
  if (strcmp(key, "readableEnded") == 0) return scr_dyn_new_bool(r->ended);
  if (strcmp(key, "closed") == 0) return scr_dyn_new_bool(r->close_emitted);
  {
    /* Real instance properties without a modeled read: loud, never a
     * silent undefined where Node has a value. */
    static const char *const known[] = {
      "trailers", "rawTrailers", NULL };
    if (scr_http_dynh_in(key, known)) {
      scr_http_dynh_unsupported("IncomingMessage", key, NULL);
      return NULL;
    }
  }
  return NULL; /* unknown key: the undefined singleton (SEMANTICS.md) */
}

static bool scr_http_dynh_req_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  return false; /* no modeled writable properties — the caller's loud fence */
}

/* ── ServerResponse (SCR_DYNH_HTTP_RES) ──────────────────────────────── */

/* writeHead's header-object form over a dyn OBJ: flatten into the
 * [k0, v0, k1, v1, ...] pairs the static lowering feeds
 * scr_http_res_write_head_pairs (repeats append — array values expand to
 * consecutive same-name pairs). Numbers format through String(n). NULL =
 * a value this surface cannot honestly carry (exception pending). */
static ScrArr *scr_http_dynh_pairs(const ScrDyn *headers) {
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, headers->v.obj.len * 2);
  for (size_t i = 0; i < headers->v.obj.len; i++) {
    const ScrDynEntry *e = &headers->v.obj.entries[i];
    const ScrDyn *v = e->value;
    size_t reps = v->kind == SCR_DYN_ARR ? v->v.arr.len : 1;
    for (size_t k = 0; k < reps; k++) {
      const ScrDyn *one = v->kind == SCR_DYN_ARR ? v->v.arr.items[k] : v;
      ScrStr *vs;
      if (one->kind == SCR_DYN_STR) {
        vs = scr_str_retain(one->v.str);
      } else if (one->kind == SCR_DYN_NUM) {
        vs = scr_f64_to_scrstr(one->v.num);
      } else {
        ScrJsonBuf b;
        scr_jb_init(&b);
        scr_jb_puts(&b, "Invalid value \"");
        scr_jb_puts(&b, one->kind == SCR_DYN_UNDEF ? "undefined" : "object");
        scr_jb_puts(&b, "\" for header \"");
        for (size_t c = 0; c < e->key_len; c++) scr_jb_putc(&b, e->key[c]);
        scr_jb_putc(&b, '"');
        ScrStr *msg = scr_jb_finish(&b);
        scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len, "ERR_HTTP_INVALID_HEADER_VALUE");
        scr_str_release(msg);
        scr_arr_release(pairs);
        return NULL;
      }
      scr_arr_push_ref(pairs, scr_str_new(e->key, e->key_len));
      scr_arr_push_ref(pairs, vs);
    }
  }
  return pairs;
}

/* writeHead's RAW-array form over a dyn ARR: [k0, v0, k1, v1, ...]
 * flattens into the same pairs feed; an odd length throws Node's
 * ERR_INVALID_ARG_VALUE; value slots may be arrays (consecutive
 * same-name lines) or numbers (String(n)). NULL = exception pending. */
static ScrArr *scr_http_dynh_flat_pairs(const ScrDyn *list) {
  size_t n = list->v.arr.len;
  if (n % 2 != 0) {
    static const char msg[] = "The argument 'headers' is invalid.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    const ScrDyn *k = list->v.arr.items[i];
    const ScrDyn *v = list->v.arr.items[i + 1];
    if (k->kind != SCR_DYN_STR) {
      scr_arr_release(pairs);
      scr_dyn_arg_type_fail("name", "of type string", k);
      return NULL;
    }
    size_t reps = v->kind == SCR_DYN_ARR ? v->v.arr.len : 1;
    for (size_t rep = 0; rep < reps; rep++) {
      const ScrDyn *one = v->kind == SCR_DYN_ARR ? v->v.arr.items[rep] : v;
      ScrStr *vs;
      if (one->kind == SCR_DYN_STR) {
        vs = scr_str_retain(one->v.str);
      } else if (one->kind == SCR_DYN_NUM) {
        vs = scr_f64_to_scrstr(one->v.num);
      } else {
        ScrJsonBuf b;
        scr_jb_init(&b);
        scr_jb_puts(&b, "Invalid value \"");
        scr_jb_puts(&b, one->kind == SCR_DYN_UNDEF ? "undefined" : "object");
        scr_jb_puts(&b, "\" for header \"");
        for (size_t c = 0; c < k->v.str->len; c++) scr_jb_putc(&b, k->v.str->data[c]);
        scr_jb_putc(&b, '"');
        ScrStr *msg = scr_jb_finish(&b);
        scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len, "ERR_HTTP_INVALID_HEADER_VALUE");
        scr_str_release(msg);
        scr_arr_release(pairs);
        return NULL;
      }
      scr_arr_push_ref(pairs, scr_str_new(k->v.str->data, k->v.str->len));
      scr_arr_push_ref(pairs, vs);
    }
  }
  return pairs;
}

static ScrDyn *scr_http_dynh_res_invoke(void *h, ScrDyn *self, const char *method,
                                        ScrDyn *const *args, size_t argc, const char *what) {
  ScrHttpRes *r = (ScrHttpRes *)h;
  bool once = false;
  if (scr_http_dynh_reg(method, &once)) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    const ScrDyn *cb = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(cb, "listener");
    if (scr_exc_pending()) return NULL;
    if (scr_http_dynh_name_is(name, "close")) {
      scr_http_res_on_close(r, scr_dyn_listener_closure0(cb), once);
    } else if (scr_http_dynh_name_is(name, "finish")) {
      scr_http_res_on_finish(r, scr_dyn_listener_closure0(cb));
    } else if (scr_http_dynh_name_is(name, "drain")) {
      /* This surface never backpressures (write answers true), so Node's
       * contract says 'drain' never fires — an accepted, never-fired
       * registration is the consistent answer (SEMANTICS.md). */
    } else if (scr_http_dynh_name_is(name, "timeout") && r->sock != NULL) {
      /* the socket's idle timer — res.setTimeout's event, Node's delegation */
      scr_net_sock_on_timeout(r->sock, scr_dyn_listener_closure0(cb), once);
    } else {
      scr_http_dynh_event_unsupported("ServerResponse", name);
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "end") == 0) {
    /* end() / end(chunk) / end(chunk, enc) / end(cb) / end(chunk, cb) /
     * end(chunk, enc, cb) — Node's whole shape family. */
    size_t i = 0;
    const ScrDyn *chunk = NULL;
    const ScrDyn *cb = NULL;
    ScrBytes *decoded = NULL;
    if (i < argc && args[i]->kind == SCR_DYN_FUNC) {
      cb = args[i++];
    } else if (i < argc && args[i]->kind != SCR_DYN_UNDEF && args[i]->kind != SCR_DYN_NULL) {
      if (!scr_http_dynh_chunk_ok(args[i])) return NULL;
      chunk = args[i++];
      if (i < argc && args[i]->kind == SCR_DYN_STR) { /* encoding */
        if (!scr_http_dynh_encode(chunk, args[i], &decoded)) return NULL;
        i++;
      }
      if (i < argc && args[i]->kind == SCR_DYN_FUNC) cb = args[i++];
    }
    if (i < argc && args[i]->kind != SCR_DYN_UNDEF) {
      scr_bytes_release(decoded);
      scr_http_dynh_unsupported("ServerResponse", "end", "this argument shape is not modeled");
      return NULL;
    }
    if (cb) scr_http_res_on_finish(r, scr_dyn_listener_closure0(cb));
    if (decoded != NULL) {
      scr_http_res_end_bytes(r, decoded);
      scr_bytes_release(decoded);
    } else if (chunk == NULL) {
      scr_http_res_end(r);
    } else if (chunk->kind == SCR_DYN_STR) {
      scr_http_res_end_str(r, chunk->v.str);
    } else {
      scr_http_res_end_bytes(r, chunk->v.bytes);
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "write") == 0) {
    const ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
    if (!scr_http_dynh_chunk_ok(chunk)) return NULL;
    ScrBytes *decoded = NULL;
    size_t i = 1;
    if (i < argc && args[i]->kind == SCR_DYN_STR) { /* encoding */
      if (!scr_http_dynh_encode(chunk, args[i], &decoded)) return NULL;
      i++;
    }
    if (i < argc && args[i]->kind == SCR_DYN_FUNC) {
      /* write(chunk[, enc], cb): fires from the queue once the chunk
       * entered the socket buffer — this surface's flush moment */
      scr_http_res_on_write_flush(r, scr_dyn_listener_closure0(args[i]));
      i++;
    }
    if (decoded != NULL) {
      scr_http_res_write_bytes(r, decoded);
      scr_bytes_release(decoded);
    } else if (chunk->kind == SCR_DYN_STR) {
      scr_http_res_write_str(r, chunk->v.str);
    } else {
      scr_http_res_write_bytes(r, chunk->v.bytes);
    }
    /* Always-true: this surface buffers without a highWaterMark verdict
     * (SEMANTICS.md — backpressure is not modeled). */
    return scr_dyn_new_bool(true);
  }
  if (strcmp(method, "flushHeaders") == 0) {
    scr_http_res_flush_headers(r);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "cork") == 0) {
    scr_http_res_cork(r);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "uncork") == 0) {
    scr_http_res_uncork(r);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "setTimeout") == 0) {
    const ScrDyn *ms = argc > 0 ? args[0] : scr_dyn_undefined();
    if (ms->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("msecs", "of type number", ms);
      return NULL;
    }
    ScrClosure *tcb = NULL;
    if (argc > 1 && args[1]->kind == SCR_DYN_FUNC) tcb = scr_dyn_listener_closure0(args[1]);
    else if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF) {
      scr_dyn_check_listener(args[1], "callback");
      return NULL;
    }
    scr_http_res_set_timeout(r, ms->v.num, tcb);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "getHeaders") == 0) {
    /* the snapshot object — lowercased names; repeated names read as an
     * array in set order (Node's outgoing shape) */
    ScrDyn *obj = scr_dyn_new_obj();
    for (size_t k = 0; k < r->nheaders; k++) {
      const ScrStr *n = r->hnames[k];
      char lower[256];
      size_t nl = n->len < sizeof lower ? n->len : sizeof lower - 1;
      for (size_t c = 0; c < nl; c++) {
        char ch = n->data[c];
        lower[c] = ch >= 'A' && ch <= 'Z' ? (char)(ch + 32) : ch;
      }
      ScrDyn *prev = scr_dyn_obj_get(obj, lower, nl);
      ScrDyn *val = scr_dyn_new_str(r->hvalues[k]);
      if (prev == NULL) {
        scr_dyn_obj_set(obj, lower, nl, val); /* moves */
      } else if (prev->kind == SCR_DYN_ARR) {
        scr_dyn_arr_push(prev, val); /* moves */
      } else {
        ScrDyn *arr = scr_dyn_new_arr();
        scr_dyn_arr_push(arr, scr_dyn_retain(prev));
        scr_dyn_arr_push(arr, val);
        scr_dyn_obj_set(obj, lower, nl, arr); /* moves; releases prev */
      }
    }
    return obj;
  }
  if (strcmp(method, "writeHead") == 0) {
    const ScrDyn *st = argc > 0 ? args[0] : scr_dyn_undefined();
    if (st->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("statusCode", "of type number", st);
      return NULL;
    }
    size_t i = 1;
    if (i < argc && args[i]->kind == SCR_DYN_STR) {
      scr_http_res_status_msg_set(r, args[i]->v.str);
      i++;
    }
    if (i < argc && args[i]->kind == SCR_DYN_OBJ) {
      ScrArr *pairs = scr_http_dynh_pairs(args[i]);
      if (!pairs) return NULL;
      scr_http_res_write_head_pairs(r, st->v.num, pairs);
      scr_arr_release(pairs);
      i++;
    } else if (i < argc && args[i]->kind == SCR_DYN_ARR) {
      /* the RAW-array form: [k0, v0, k1, v1, ...] — an even length is
       * Node's contract (ERR_INVALID_ARG_VALUE otherwise), values may be
       * arrays (consecutive same-name lines, the setHeader expansion),
       * and per NAME the list overrides what setHeader() stored while
       * other names survive — the object form's writeHead-wins merge
       * (oracle-pinned: a res with setHeader('a') plus writeHead(200,
       * ['test', ...]) sends both). */
      ScrArr *pairs = scr_http_dynh_flat_pairs(args[i]);
      if (!pairs) return NULL;
      scr_http_res_write_head_pairs(r, st->v.num, pairs);
      scr_arr_release(pairs);
      i++;
    } else if (i < argc && args[i]->kind != SCR_DYN_UNDEF) {
      scr_http_dynh_unsupported("ServerResponse", "writeHead", "only the header-object and raw-array forms are modeled");
      return NULL;
    } else {
      scr_http_res_write_head(r, st->v.num);
    }
    return scr_dyn_retain(self); /* chaining: writeHead(...).end(...) */
  }
  if (strcmp(method, "setHeader") == 0) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    const ScrDyn *value = argc > 1 ? args[1] : scr_dyn_undefined();
    if (name->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("name", "of type string", name);
      return NULL;
    }
    if (value->kind == SCR_DYN_STR || value->kind == SCR_DYN_NUM) {
      ScrStr *vs = value->kind == SCR_DYN_STR ? scr_str_retain(value->v.str)
                                              : scr_f64_to_scrstr(value->v.num);
      scr_http_res_set_header(r, name->v.str, vs);
      scr_str_release(vs);
      return scr_dyn_retain(self);
    }
    if (value->kind == SCR_DYN_ARR) {
      for (size_t k = 0; k < value->v.arr.len; k++) {
        const ScrDyn *one = value->v.arr.items[k];
        ScrStr *vs;
        if (one->kind == SCR_DYN_STR) vs = scr_str_retain(one->v.str);
        else if (one->kind == SCR_DYN_NUM) vs = scr_f64_to_scrstr(one->v.num);
        else {
          scr_http_dynh_unsupported("ServerResponse", "setHeader", "array header values must be strings or numbers");
          return NULL;
        }
        if (k == 0) scr_http_res_set_header(r, name->v.str, vs);
        else scr_http_res_append_header(r, name->v.str, vs);
        scr_str_release(vs);
      }
      return scr_dyn_retain(self);
    }
    scr_http_dynh_unsupported("ServerResponse", "setHeader", "only string, number, and array values are modeled");
    return NULL;
  }
  if (strcmp(method, "getHeader") == 0) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    if (name->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("name", "of type string", name);
      return NULL;
    }
    ScrStr *v = scr_http_res_get_header(r, name->v.str);
    if (!v) return scr_dyn_retain(scr_dyn_undefined());
    ScrDyn *d = scr_dyn_new_str(v);
    scr_str_release(v);
    return d;
  }
  if (strcmp(method, "hasHeader") == 0) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    if (name->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("name", "of type string", name);
      return NULL;
    }
    return scr_dyn_new_bool(scr_http_res_has_header_named(r, name->v.str));
  }
  if (strcmp(method, "removeHeader") == 0) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    if (name->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("name", "of type string", name);
      return NULL;
    }
    scr_http_res_remove_header(r, name->v.str);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "destroy") == 0) {
    scr_http_res_destroy(r);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "toString") == 0) {
    ScrStr *s = scr_str_new("[object Object]", 15);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  {
    static const char *const known[] = { "writeContinue", "writeEarlyHints",
      "getHeaderNames", "appendHeader",
      "addTrailers", "off", "removeListener", "removeAllListeners", "emit",
      "prependListener", "prependOnceListener", "listenerCount", "listeners", "setDefaultEncoding", NULL };
    if (scr_http_dynh_in(method, known)) {
      scr_http_dynh_unsupported("ServerResponse", method, NULL);
      return NULL;
    }
  }
  scr_http_dynh_not_fn(what);
  return NULL;
}

static ScrDyn *scr_http_dynh_res_get(void *h, const char *key, size_t key_len) {
  ScrHttpRes *r = (ScrHttpRes *)h;
  (void)key_len;
  if (strcmp(key, "statusCode") == 0) return scr_dyn_new_num(scr_http_res_status_get(r));
  if (strcmp(key, "statusMessage") == 0) {
    ScrStr *s = scr_http_res_status_msg_get(r);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  if (strcmp(key, "headersSent") == 0) return scr_dyn_new_bool(scr_http_res_headers_sent(r));
  if (strcmp(key, "finished") == 0 || strcmp(key, "writableEnded") == 0) {
    /* One flag serves both (Node splits ended-vs-flushed; this surface
     * flushes synchronously into the socket buffer — SEMANTICS.md). */
    return scr_dyn_new_bool(r->finished);
  }
  if (strcmp(key, "socket") == 0 || strcmp(key, "connection") == 0) {
    if (!r->sock) return scr_dyn_new_null(); /* destroyed: Node nulls it */
    return scr_dyn_new_handle(r->sock, SCR_DYNH_NET_SOCKET);
  }
  if (strcmp(key, "req") == 0) {
    if (r->req_cleared || r->req_ref == NULL) return scr_dyn_new_null();
    return scr_dyn_new_handle(r->req_ref, SCR_DYNH_HTTP_REQ);
  }
  if (strcmp(key, "writableCorked") == 0) return scr_dyn_new_num(scr_http_res_writable_corked(r));
  if (strcmp(key, "writableFinished") == 0) return scr_dyn_new_bool(r->finished);
  if (strcmp(key, "writableHighWaterMark") == 0) {
    /* Node's default socket highWaterMark — a constant here (backpressure
     * is not modeled; SEMANTICS.md) */
    return scr_dyn_new_num(16384);
  }
  if (strcmp(key, "destroyed") == 0) return scr_dyn_new_bool(scr_http_res_destroyed_flag(r));
  if (strcmp(key, "closed") == 0) return scr_dyn_new_bool(r->close_emitted);
  {
    static const char *const known[] = { "chunkedEncoding", "sendDate",
      "strictContentLength", "writableLength",
      "writableObjectMode", "errored", NULL };
    if (scr_http_dynh_in(key, known)) {
      scr_http_dynh_unsupported("ServerResponse", key, NULL);
      return NULL;
    }
  }
  return NULL;
}

static bool scr_http_dynh_res_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrHttpRes *r = (ScrHttpRes *)h;
  (void)key_len;
  if (strcmp(key, "statusCode") == 0) {
    if (value->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("statusCode", "of type number", value);
      return true; /* handled: the exception is pending */
    }
    scr_http_res_status_set(r, value->v.num);
    return true;
  }
  if (strcmp(key, "statusMessage") == 0) {
    if (value->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("statusMessage", "of type string", value);
      return true;
    }
    scr_http_res_status_msg_set(r, value->v.str);
    return true;
  }
  if (strcmp(key, "sendDate") == 0) {
    /* Node's boolean flag over the implicit Date header (ToBoolean, like
     * the property's own coercion). */
    r->no_date = !scr_dyn_truthy(value);
    return true;
  }
  if (strcmp(key, "req") == 0 &&
      (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF)) {
    /* res.req is a plain property in Node — a null/undefined write
     * clears the read; other writes raise the named fence (the handle
     * cannot carry arbitrary values). */
    r->req_cleared = true;
    return true;
  }
  return false;
}

/* Pipe DESTINATION hook: `req.pipe(res)` dispatches inside this unit,
 * but `socket.pipe(res)` arrives from scr_net.c, which cannot name this
 * unit's entry points — the destination accepts the source here. */
static bool scr_http_dynh_res_pipe_from(void *dst, const ScrDyn *src) {
  ScrHttpRes *r = (ScrHttpRes *)dst;
  if (src->kind == SCR_DYN_HANDLE && src->v.handle.tag == SCR_DYNH_NET_SOCKET) {
    scr_http_sock_pipe_res((ScrNetSocket *)src->v.handle.ptr, r);
    return true;
  }
  if (src->kind == SCR_DYN_HANDLE && src->v.handle.tag == SCR_DYNH_HTTP_REQ) {
    scr_http_req_pipe_res((ScrHttpReq *)src->v.handle.ptr, r);
    return true;
  }
  return false;
}

static const ScrDynHandleOps scr_http_dynh_req_ops = {
  "IncomingMessage",
  &scr_http_req_retain_v,
  &scr_http_req_release_v,
  &scr_http_dynh_req_invoke,
  &scr_http_dynh_req_get,
  &scr_http_dynh_req_set,
  NULL,
};

static const ScrDynHandleOps scr_http_dynh_res_ops = {
  "ServerResponse",
  &scr_http_res_retain_v,
  &scr_http_res_release_v,
  &scr_http_dynh_res_invoke,
  &scr_http_dynh_res_get,
  &scr_http_dynh_res_set,
  &scr_http_dynh_res_pipe_from,
};

/* The 'request' fire for a DYN listener registered through the netServer
 * handle dispatch (`server.on('request', wrapper)` where `server` lives
 * in a dyn binding): box req/res by reference and call through the
 * checked-dynamic machinery. The ScrHttpReqFn ABI — req/res arrive +1
 * and the adapter owns them, like the compiler-emitted adapters. */
static void scr_http_dynh_fire_reqres(ScrClosure *cb, ScrHttpReq *req /* +1 */,
                                      ScrHttpRes *res /* +1 */) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *dreq = scr_dyn_new_handle(req, SCR_DYNH_HTTP_REQ);
  ScrDyn *dres = scr_dyn_new_handle(res, SCR_DYNH_HTTP_RES);
  ScrDyn *args[2] = { dreq, dres };
  ScrDyn *r = scr_dyn_call(fn, args, 2, "listener");
  scr_dyn_release(r);
  scr_dyn_release(dres);
  scr_dyn_release(dreq);
  scr_dyn_release(fn);
  scr_http_req_release(req);
  scr_http_res_release(res);
}

/* The netServer dyn dispatch's http-event hook (scr_net_set_dynh_http_on):
 * 'request' registers; anything else answers false and the net side
 * fences loudly. */
static bool scr_http_dynh_server_on(ScrNetServer *s, const char *event, const ScrDyn *cb,
                                    bool once) {
  if (strcmp(event, "request") == 0) {
    scr_http_server_on_request(s, scr_dyn_listener_closure_fn(cb, (void *)&scr_http_dynh_fire_reqres),
                               (ScrHttpReqFn)&scr_http_dynh_fire_reqres, once);
    return true;
  }
  return false;
}

/* ── ClientRequest (SCR_DYNH_HTTP_CLIENT) ────────────────────────────── */

/* The 'response' fire for a DYN listener (the reqres adapter's shape):
 * res arrives +1, boxes, and the checked-dynamic call runs. */
static void scr_http_dynh_fire_resp(ScrClosure *cb, ScrHttpReq *res /* +1 */) {
  ScrDyn *fn = scr_dyn_listener_fn(cb);
  ScrDyn *dres = scr_dyn_new_handle(res, SCR_DYNH_HTTP_REQ);
  ScrDyn *args1[1] = { dres };
  ScrDyn *r = scr_dyn_call(fn, args1, 1, "listener");
  scr_dyn_release(r);
  scr_dyn_release(dres);
  scr_dyn_release(fn);
  scr_http_req_release(res);
}

static ScrDyn *scr_http_dynh_client_invoke(void *h, ScrDyn *self, const char *method,
                                           ScrDyn *const *args, size_t argc, const char *what) {
  ScrHttpClientReq *c = (ScrHttpClientReq *)h;
  bool once = false;
  if (scr_http_dynh_reg(method, &once)) {
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    const ScrDyn *cb = argc > 1 ? args[1] : scr_dyn_undefined();
    scr_dyn_check_listener(cb, "listener");
    if (scr_exc_pending()) return NULL;
    if (scr_http_dynh_name_is(name, "response")) {
      scr_http_client_on_response(c, scr_dyn_listener_closure_fn(cb, (void *)&scr_http_dynh_fire_resp),
                                  (ScrHttpRespFn)&scr_http_dynh_fire_resp, once);
    } else if (scr_http_dynh_name_is(name, "error")) {
      scr_http_client_on_error(c, scr_dyn_listener_closure_err(cb), (ScrChildErrFn)&scr_dyn_listener_fire_err, once);
    } else if (scr_http_dynh_name_is(name, "close")) {
      scr_http_client_on_close(c, scr_dyn_listener_closure0(cb), once);
    } else if (scr_http_dynh_name_is(name, "timeout")) {
      scr_http_client_on_timeout(c, scr_dyn_listener_closure0(cb), once);
    } else {
      scr_http_dynh_event_unsupported("ClientRequest", name);
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "end") == 0) {
    const ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
    if (chunk->kind == SCR_DYN_STR) scr_http_client_end_str(c, chunk->v.str);
    else if (chunk->kind == SCR_DYN_BYTES) scr_http_client_end_bytes(c, chunk->v.bytes);
    else if (chunk->kind == SCR_DYN_UNDEF || chunk->kind == SCR_DYN_NULL) scr_http_client_end(c);
    else {
      scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", chunk);
      return NULL;
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "write") == 0) {
    const ScrDyn *chunk = argc > 0 ? args[0] : scr_dyn_undefined();
    if (!scr_http_dynh_chunk_ok(chunk)) return NULL;
    if (chunk->kind == SCR_DYN_STR) scr_http_client_write_str(c, chunk->v.str);
    else scr_http_client_write_bytes(c, chunk->v.bytes);
    return scr_dyn_new_bool(true);
  }
  if (strcmp(method, "destroy") == 0) {
    scr_http_client_destroy(c);
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "setTimeout") == 0) {
    const ScrDyn *ms = argc > 0 ? args[0] : scr_dyn_undefined();
    if (ms->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("msecs", "of type number", ms);
      return NULL;
    }
    scr_http_client_set_timeout(c, ms->v.num);
    if (argc > 1 && args[1]->kind == SCR_DYN_FUNC) {
      scr_http_client_on_timeout(c, scr_dyn_listener_closure0(args[1]), true);
    }
    return scr_dyn_retain(self);
  }
  if (strcmp(method, "flushHeaders") == 0) {
    if (!c->head_sent && !c->destroyed) scr_http_client_send_head(c, -1);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "toString") == 0) {
    ScrStr *s = scr_str_new("[object Object]", 15);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  {
    static const char *const known[] = { "abort", "setNoDelay", "setSocketKeepAlive",
      "getHeader", "setHeader", "removeHeader", "getHeaders", "getHeaderNames", "hasHeader",
      "cork", "uncork", "pipe", "off", "removeListener", "removeAllListeners", "emit",
      "prependListener", "prependOnceListener", "listenerCount", "listeners", NULL };
    if (scr_http_dynh_in(method, known)) {
      scr_http_dynh_unsupported("ClientRequest", method, NULL);
      return NULL;
    }
  }
  scr_http_dynh_not_fn(what);
  return NULL;
}

static ScrDyn *scr_http_dynh_client_get(void *h, const char *key, size_t key_len) {
  ScrHttpClientReq *c = (ScrHttpClientReq *)h;
  (void)key_len;
  if (strcmp(key, "socket") == 0 || strcmp(key, "connection") == 0) {
    if (!c->sock) return scr_dyn_new_null();
    return scr_dyn_new_handle(c->sock, SCR_DYNH_NET_SOCKET);
  }
  if (strcmp(key, "destroyed") == 0) return scr_dyn_new_bool(scr_http_client_destroyed(c));
  if (strcmp(key, "writableEnded") == 0) return scr_dyn_new_bool(c->ended);
  if (strcmp(key, "path") == 0) {
    ScrDyn *d = scr_dyn_new_str(c->path);
    return d;
  }
  if (strcmp(key, "method") == 0) return scr_dyn_new_str(c->method);
  {
    static const char *const known[] = { "aborted", "host", "protocol", "res",
      "reusedSocket", "maxHeadersCount", "headersSent", "writableFinished", NULL };
    if (scr_http_dynh_in(key, known)) {
      scr_http_dynh_unsupported("ClientRequest", key, NULL);
      return NULL;
    }
  }
  return NULL;
}

static bool scr_http_dynh_client_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h; (void)key; (void)key_len; (void)value;
  return false;
}

static const ScrDynHandleOps scr_http_dynh_client_ops = {
  "ClientRequest",
  &scr_http_client_retain_v,
  &scr_http_client_release_v,
  &scr_http_dynh_client_invoke,
  &scr_http_dynh_client_get,
  &scr_http_dynh_client_set,
  NULL,
};

/* ── Agent (SCR_DYNH_HTTP_AGENT) ─────────────────────────────────────── */

/* A string-ish option field out of a dyn OBJ: STR answers its bytes,
 * NUM formats (the port), everything else reads as absent. */
static ScrStr *scr_http_dynh_opt_str(const ScrDyn *opts, const char *key) {
  if (opts == NULL || opts->kind != SCR_DYN_OBJ) return NULL;
  const ScrDyn *v = scr_dyn_obj_get(opts, key, strlen(key));
  if (v == NULL) return NULL;
  if (v->kind == SCR_DYN_STR) return scr_str_retain(v->v.str);
  if (v->kind == SCR_DYN_NUM) return scr_f64_to_scrstr(v->v.num);
  return NULL;
}

static ScrDyn *scr_http_dynh_agent_invoke(void *h, ScrDyn *self, const char *method,
                                          ScrDyn *const *args, size_t argc, const char *what) {
  ScrHttpAgent *a = (ScrHttpAgent *)h;
  bool once = false;
  if (scr_http_dynh_reg(method, &once)) {
    /* Agent events ('free'/'timeout') ride the pooling the runtime does
     * not have — a named error, never an inert listener. */
    const ScrDyn *name = argc > 0 ? args[0] : scr_dyn_undefined();
    scr_http_dynh_event_unsupported("Agent", name);
    return NULL;
  }
  if (strcmp(method, "getName") == 0) {
    const ScrDyn *opts = argc > 0 ? args[0] : scr_dyn_undefined();
    ScrStr *host = scr_http_dynh_opt_str(opts, "host");
    ScrStr *port = scr_http_dynh_opt_str(opts, "port");
    ScrStr *laddr = scr_http_dynh_opt_str(opts, "localAddress");
    ScrStr *spath = scr_http_dynh_opt_str(opts, "socketPath");
    int family = 0;
    if (opts != NULL && opts->kind == SCR_DYN_OBJ) {
      const ScrDyn *f = scr_dyn_obj_get(opts, "family", 6);
      if (f != NULL && f->kind == SCR_DYN_NUM && (f->v.num == 4 || f->v.num == 6)) {
        family = (int)f->v.num;
      }
    }
    ScrStr *name = scr_http_agent_name(host ? host->data : NULL, host ? host->len : 0,
                                        port ? port->data : NULL, port ? port->len : 0,
                                        laddr ? laddr->data : NULL, laddr ? laddr->len : 0,
                                        family, spath ? spath->data : NULL,
                                        spath ? spath->len : 0);
    scr_str_release(host);
    scr_str_release(port);
    scr_str_release(laddr);
    scr_str_release(spath);
    ScrDyn *d = scr_dyn_new_str(name);
    scr_str_release(name);
    return d;
  }
  if (strcmp(method, "destroy") == 0) {
    scr_http_agent_destroy(a);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "toString") == 0) {
    ScrStr *s = scr_str_new("[object Object]", 15);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  {
    static const char *const known[] = { "createConnection", "createSocket", "keepSocketAlive",
      "reuseSocket", "addRequest", "removeSocket", "off", "removeListener",
      "removeAllListeners", "emit", "prependListener", "prependOnceListener",
      "listenerCount", "listeners", NULL };
    if (scr_http_dynh_in(method, known)) {
      scr_http_dynh_unsupported("Agent", method, NULL);
      return NULL;
    }
  }
  scr_http_dynh_not_fn(what);
  (void)self;
  return NULL;
}

/* The sockets/requests snapshots: name → array (fresh objects per read;
 * the tests read lengths, membership, and key presence — empty buckets
 * are OMITTED, Node deletes drained keys). */
static ScrDyn *scr_http_dynh_agent_table(ScrHttpAgent *a, bool queued) {
  ScrDyn *obj = scr_dyn_new_obj();
  for (ScrHttpAgentEnt *e = a->ents; e; e = e->next) {
    if (e->queued != queued) continue;
    ScrDyn *item = queued
        ? scr_dyn_new_handle(e->client, SCR_DYNH_HTTP_CLIENT)
        : e->client->sock ? scr_dyn_new_handle(e->client->sock, SCR_DYNH_NET_SOCKET) : NULL;
    if (item == NULL) continue;
    ScrDyn *arr = scr_dyn_obj_get(obj, e->name->data, e->name->len); /* borrowed */
    if (arr == NULL || arr->kind != SCR_DYN_ARR) {
      ScrDyn *fresh = scr_dyn_new_arr();
      scr_dyn_arr_push(fresh, item); /* moves */
      scr_dyn_obj_set(obj, e->name->data, e->name->len, fresh); /* moves */
    } else {
      scr_dyn_arr_push(arr, item); /* moves */
    }
  }
  return obj;
}

static ScrDyn *scr_http_dynh_agent_get(void *h, const char *key, size_t key_len) {
  ScrHttpAgent *a = (ScrHttpAgent *)h;
  (void)key_len;
  if (strcmp(key, "maxSockets") == 0) return scr_dyn_new_num(a->max_sockets);
  if (strcmp(key, "maxFreeSockets") == 0) return scr_dyn_new_num(a->max_free);
  if (strcmp(key, "keepAlive") == 0) return scr_dyn_new_bool(a->keep_alive);
  if (strcmp(key, "keepAliveMsecs") == 0) return scr_dyn_new_num(a->ka_msecs);
  if (strcmp(key, "defaultPort") == 0) return scr_dyn_new_num(a->default_port);
  if (strcmp(key, "protocol") == 0) {
    ScrStr *s = scr_str_new(a->secure ? "https:" : "http:", a->secure ? 6 : 5);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  if (strcmp(key, "sockets") == 0) return scr_http_dynh_agent_table(a, false);
  if (strcmp(key, "requests") == 0) return scr_http_dynh_agent_table(a, true);
  if (strcmp(key, "freeSockets") == 0) {
    /* Always empty: the runtime pools nothing (keepAlive fences). */
    return scr_dyn_new_obj();
  }
  if (strcmp(key, "totalSocketCount") == 0) {
    size_t n = 0;
    for (ScrHttpAgentEnt *e = a->ents; e; e = e->next) {
      if (!e->queued) n++;
    }
    return scr_dyn_new_num((double)n);
  }
  {
    static const char *const known[] = { "options", "maxTotalSockets", "scheduling", NULL };
    if (scr_http_dynh_in(key, known)) {
      scr_http_dynh_unsupported("Agent", key, NULL);
      return NULL;
    }
  }
  return NULL;
}

static bool scr_http_dynh_agent_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrHttpAgent *a = (ScrHttpAgent *)h;
  (void)key_len;
  if (strcmp(key, "defaultPort") == 0 || strcmp(key, "maxSockets") == 0 ||
      strcmp(key, "maxFreeSockets") == 0 || strcmp(key, "keepAliveMsecs") == 0) {
    if (value->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail(key, "of type number", value);
      return true; /* handled: the exception is pending */
    }
    if (strcmp(key, "defaultPort") == 0) a->default_port = value->v.num;
    else if (strcmp(key, "maxSockets") == 0) a->max_sockets = value->v.num;
    else if (strcmp(key, "maxFreeSockets") == 0) a->max_free = value->v.num;
    else a->ka_msecs = value->v.num;
    return true;
  }
  return false; /* createSocket/createConnection installs: the named fence */
}

static const ScrDynHandleOps scr_http_dynh_agent_ops = {
  "Agent",
  &scr_http_agent_retain_v,
  &scr_http_agent_release_v,
  &scr_http_dynh_agent_invoke,
  &scr_http_dynh_agent_get,
  &scr_http_dynh_agent_set,
  NULL,
};

void scr_http_dyn_install(void) {
  scr_dyn_handle_install(SCR_DYNH_HTTP_REQ, &scr_http_dynh_req_ops);
  scr_dyn_handle_install(SCR_DYNH_HTTP_RES, &scr_http_dynh_res_ops);
  scr_dyn_handle_install(SCR_DYNH_HTTP_CLIENT, &scr_http_dynh_client_ops);
  scr_dyn_handle_install(SCR_DYNH_HTTP_AGENT, &scr_http_dynh_agent_ops);
  scr_net_set_dynh_http_on(&scr_http_dynh_server_on);
}

/* Checked-dynamic chunks into TYPED res/client handles — the
 * scr_net_sock_write_dynv story (the static lowering's dyn-data arm). */
void scr_http_res_write_dynv(ScrHttpRes *r, const ScrDyn *d) {
  if (d->kind == SCR_DYN_STR) scr_http_res_write_str(r, d->v.str);
  else if (d->kind == SCR_DYN_BYTES) scr_http_res_write_bytes(r, d->v.bytes);
  else scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", d);
}

void scr_http_res_end_dynv(ScrHttpRes *r, const ScrDyn *d) {
  if (d->kind == SCR_DYN_STR) scr_http_res_end_str(r, d->v.str);
  else if (d->kind == SCR_DYN_BYTES) scr_http_res_end_bytes(r, d->v.bytes);
  else if (d->kind == SCR_DYN_UNDEF || d->kind == SCR_DYN_NULL) scr_http_res_end(r);
  else scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", d);
}

void scr_http_client_write_dynv(ScrHttpClientReq *c, const ScrDyn *d) {
  if (d->kind == SCR_DYN_STR) scr_http_client_write_str(c, d->v.str);
  else if (d->kind == SCR_DYN_BYTES) scr_http_client_write_bytes(c, d->v.bytes);
  else scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", d);
}

void scr_http_client_end_dynv(ScrHttpClientReq *c, const ScrDyn *d) {
  if (d->kind == SCR_DYN_STR) scr_http_client_end_str(c, d->v.str);
  else if (d->kind == SCR_DYN_BYTES) scr_http_client_end_bytes(c, d->v.bytes);
  else if (d->kind == SCR_DYN_UNDEF || d->kind == SCR_DYN_NULL) scr_http_client_end(c);
  else scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer or Uint8Array", d);
}

/* http.request/get with a URL-STRING first argument — the suite's
 * `http.get(`http://127.0.0.1:${port}/x`)` spelling. Parses through the
 * WHATWG unit (scr_url.c, always linked): an unparsable input throws
 * scr_url_new's catchable "Invalid URL" TypeError; a non-http scheme
 * throws Node's ERR_INVALID_PROTOCOL shape. Path is pathname + search
 * (fragment dropped, Node's client behavior). cb MOVES (nullable);
 * result +1 or NULL with the exception pending. */
#include "scr_url_internal.h"

bool scr_http_url_parts(ScrStr *url /*borrowed*/, bool secure, ScrStr **host_out /*+1*/,
                         double *port_out, ScrStr **path_out /*+1*/) {
  ScrUrl *u = scr_url_new(url);
  if (!u) return false; /* Invalid URL pending */
  /* The scheme is checked against the MODULE the call came from, not read
   * off the URL: http.get('https://…') is Node's ERR_INVALID_PROTOCOL, not
   * a silent upgrade. Hence `secure` as a parameter. */
  const char *want = secure ? "https" : "http";
  const size_t wantlen = secure ? 5 : 4;
  if (!(u->scheme->len == wantlen && memcmp(u->scheme->data, want, wantlen) == 0)) {
    char msg[128];
    int n = snprintf(msg, sizeof msg, "Protocol \"%.*s:\" not supported. Expected \"%s:\"",
                     (int)(u->scheme->len < 32 ? u->scheme->len : 32), u->scheme->data, want);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_PROTOCOL");
    scr_url_release(u);
    return false;
  }
  double port = secure ? 443 : 80;
  if (u->port->len > 0) {
    port = 0;
    for (size_t i = 0; i < u->port->len; i++) port = port * 10 + (u->port->data[i] - '0');
  }
  /* IPv6 authority arrives bracketed ("[::1]") — the dial wants the bare
   * address, like Node's client strips them. */
  if (u->host->len >= 2 && u->host->data[0] == '[' && u->host->data[u->host->len - 1] == ']') {
    *host_out = scr_str_new(u->host->data + 1, u->host->len - 2);
  } else {
    *host_out = scr_str_retain(u->host);
  }
  if (u->query->len > 0) {
    *path_out = scr_str_concat(u->path, u->query);
  } else {
    *path_out = u->path->len > 0 ? scr_str_retain(u->path) : scr_str_new("/", 1);
  }
  *port_out = port;
  scr_url_release(u);
  return true;
}

ScrHttpClientReq *scr_http_request_url(ScrStr *url /*borrowed*/, ScrStr *method /*borrowed*/,
                                        bool auto_end, ScrClosure *cb /*moves, nullable*/,
                                        ScrHttpRespFn fn) {
  ScrStr *host;
  ScrStr *path;
  double port;
  if (!scr_http_url_parts(url, false, &host, &port, &path)) {
    if (cb) scr_closure_release(cb);
    return NULL; /* Invalid URL / ERR_INVALID_PROTOCOL pending */
  }
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, 0); /* request_impl reads the pairs array */
  ScrHttpClientReq *c = scr_http_request_ex(host, port, path, method, 0, pairs, auto_end,
                                             cb, fn, 80, NULL, NULL);
  scr_arr_release(pairs);
  scr_str_release(host);
  scr_str_release(path);
  return c;
}
