#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE 1
#endif
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scr_bytes.h"
#include "scr_child.h"
#include "scr_event_target.h"
#include "scr_http.h"
#include "scr_http2.h" /* the fetch TLS client's wrap, shared by wss dials */
#include "scr_net.h"
#include "scr_url.h"

/* The global WebSocket client (Node 24's WHATWG WebSocket over a native
 * connect). One ScrWs behind a checked-dynamic handle:
 *
 *  - construction coerces the URL through the WHATWG parser (so ws/wss and
 *    the http/https spellings normalize to a ws:/wss: href), rejects a
 *    fragment and any other scheme with Node's DOMException, and validates
 *    the subprotocol tokens; the connect then starts on the event loop.
 *  - the handshake is an HTTP/1.1 GET with the RFC 6455 headers through
 *    scr_http.c's client: its 'upgrade' handover gives the raw socket and
 *    the bytes after the response head, exactly what the frame parser
 *    needs next.
 *  - frames follow RFC 6455: the client masks what it sends, the server
 *    must not; text, binary and continuation frames assemble into one
 *    message, ping is answered, pong is ignored, and a close frame ends
 *    the exchange with a CloseEvent.
 *  - events are the EventTarget unit's: the `onopen`/`onmessage`/
 *    `onerror`/`onclose` attributes and addEventListener answer through
 *    scr_event_target.c's target helper, and every event dispatched is
 *    trusted, as Node's are.
 *
 * The surface stays partial: permessage-deflate is never negotiated (Node
 * asks for none either), ErrorEvent is a plain error Event here, a Blob
 * argument to send() and binaryType's Blob delivery through a message
 * event wait on the blob unit's async read, a close the peer ignores has
 * no timer, and the events module's helpers do not see this socket's
 * listeners yet. */

#define SCR_WS_ACCEPT_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/* Node's global WebSocket caps a message's payload and its fragment count
 * (the dispatcher's webSocket options default to 128 MiB and 131072), so a
 * peer cannot make the client buffer without bound. */
#define SCR_WS_MAX_PAYLOAD ((size_t)128 * 1024 * 1024)
#define SCR_WS_MAX_FRAGMENTS 131072

enum {
  SCR_WS_CONNECTING = 0,
  SCR_WS_OPEN = 1,
  SCR_WS_CLOSING = 2,
  SCR_WS_CLOSED = 3,
};

enum {
  SCR_WS_OP_CONTINUATION = 0,
  SCR_WS_OP_TEXT = 1,
  SCR_WS_OP_BINARY = 2,
  SCR_WS_OP_CLOSE = 8,
  SCR_WS_OP_PING = 9,
  SCR_WS_OP_PONG = 10,
};

typedef struct ScrWs {
  size_t rc;
  int ready_state;
  ScrStr *url;       /* owned: the normalized href */
  ScrStr *protocol;  /* owned: the negotiated subprotocol ("" until open) */
  ScrStr *offered;   /* owned: the request's Sec-WebSocket-Protocol value */
  ScrStr *key_b64;   /* owned: Sec-WebSocket-Key */
  /* bufferedAmount: the payload bytes send() queued that the socket has
   * not yet flushed (Node counts application data). */
  double buffered_amount;
  int binary_type; /* 0 blob (Node's default), 1 arraybuffer */
  ScrEventTargetCore *et;
  ScrHttpClientReq *client; /* owned while the handshake runs */
  ScrNetSocket *sock;       /* owned once the handshake upgraded */
  bool close_sent;
  bool close_dispatched;
  bool discard;      /* a terminal event already ran; ignore the rest */
  int frag_opcode;   /* 0 none, else the message's first opcode */
  unsigned char *frag; /* owned: a fragmented message's payload so far */
  size_t frag_len;     /* its used bytes */
  size_t frag_cap;     /* its allocated byte capacity (geometric growth) */
  size_t frag_frames;  /* its frames so far, capped like Node's parser */
  unsigned char *buf; /* owned: received bytes not yet parsed */
  size_t buf_len;
  size_t buf_cap;
} ScrWs;

/* ── the handle's lifetime ──────────────────────────────────────────── */

/* The reader callbacks the handshake installs (defined with the other
 * network callbacks below). */
static void scr_ws_on_data(void *ctx, const char *buf, size_t n);
static void scr_ws_on_eof(void *ctx);
static size_t scr_ws_send_frame(ScrWs *ws, int opcode, const unsigned char *payload,
                                size_t length);

static void *scr_ws_retain_v(void *p) {
  ((ScrWs *)p)->rc++;
  return p;
}

static void scr_ws_drop_client(ScrWs *ws) {
  if (ws->client == NULL) return;
  scr_http_client_release(ws->client);
  ws->client = NULL;
}

static void scr_ws_destroy_socket(ScrWs *ws) {
  if (ws->sock == NULL) return;
  scr_net_sock_clear_native_reader(ws->sock);
  scr_net_sock_destroy(ws->sock);
  scr_net_sock_release(ws->sock);
  ws->sock = NULL;
}

/* A handler that captures its own socket makes a cycle: the socket holds
 * the listeners (through its EventTarget state) and a listener's closure
 * holds the socket's handle. The socket carries a cycle header, so the
 * collector can see the listener edges and free a socket whose handlers
 * closed over it. */
static void scr_ws_trace(void *p, ScrTraceVisit visit, void *ctx) {
  ScrWs *ws = p;
  if (ws->et != NULL) scr_event_target_state_trace(ws->et, visit, ctx);
}

/* Everything the trace does not visit: the strings, the receive buffers,
 * the handshake client and socket. */
static void scr_ws_complement_free(ScrWs *ws) {
  scr_ws_drop_client(ws);
  scr_ws_destroy_socket(ws);
  scr_str_release(ws->url);
  scr_str_release(ws->protocol);
  scr_str_release(ws->offered);
  scr_str_release(ws->key_b64);
  free(ws->frag);
  free(ws->buf);
  scr_obj_free_note();
  scr_cyc_free(ws);
}

/* The collector's teardown: the traced listeners are the collector's to
 * account, so the EventTarget state leaves them unreleased. */
static void scr_ws_gcfree(void *p) {
  ScrWs *ws = p;
  if (ws->et != NULL) {
    scr_event_target_state_gcfree(ws->et);
    ws->et = NULL;
  }
  scr_ws_complement_free(ws);
}

static void scr_ws_destroy(void *p) {
  ScrWs *ws = p;
  /* A captured handle keeps the socket alive, so none is live when the
   * count reaches zero; the guard makes re-entrant releases from a
   * listener being torn down here no-ops. */
  ws->rc = SIZE_MAX;
  if (ws->et != NULL) {
    scr_et_broadcast_install();
    scr_et_broadcast_ops->core_free(ws->et);
    ws->et = NULL;
  }
  ws->rc = 0;
  scr_ws_complement_free(ws);
}

static void scr_ws_release_v(void *p) {
  ScrWs *ws = p;
  if (ws == NULL || ws->rc == SIZE_MAX) return;
  if (--ws->rc > 0) {
    scr_cyc_released(ws);
    return;
  }
  scr_cyc_dead(ws);
  scr_rc_destroy(ws, scr_ws_destroy);
}

/* ── events ─────────────────────────────────────────────────────────── */

/* A transient handle value for the event's target and for `this` in the
 * listeners; handle equality compares (tag, pointer), so it is the same
 * WebSocket the program holds. */
static ScrDyn *scr_ws_self(ScrWs *ws) {
  return scr_dyn_new_handle(ws, SCR_DYNH_WEBSOCKET);
}

static void scr_ws_emit(ScrWs *ws, ScrDyn *event /* owned */) {
  if (event == NULL) return;
  ScrDyn *self = scr_ws_self(ws);
  if (self != NULL) scr_et_dispatch(ws->et, self, event);
  scr_dyn_release(self);
  scr_dyn_release(event);
}

static void scr_ws_emit_type(ScrWs *ws, const char *type) {
  scr_et_broadcast_install();
  ScrDyn *self = scr_ws_self(ws);
  if (self != NULL) scr_et_broadcast_ops->dispatch_type(ws->et, self, type);
  scr_dyn_release(self);
}

static void scr_ws_emit_close(ScrWs *ws, int64_t code, ScrStr *reason, bool was_clean) {
  if (ws->close_dispatched) return;
  ws->close_dispatched = true;
  ws->ready_state = SCR_WS_CLOSED;
  scr_ws_emit(ws, scr_close_event_with(code, reason, was_clean, false));
}

/* The failed-connection path: one 'error' event, then close 1006, unclean,
 * as Node reports a connect or protocol failure. */
static void scr_ws_fail_impl(ScrWs *ws) {
  if (ws->discard) return;
  ws->discard = true;
  if (ws->client != NULL && ws->sock == NULL) {
    /* A failed handshake: the pending request and the connection it dialed
     * are destroyed, so a server that stalls the response cannot keep them
     * alive after the close event. */
    ScrNetSocket *pending = scr_http_client_socket(ws->client);
    scr_http_client_destroy(ws->client);
    if (pending != NULL) {
      scr_net_sock_destroy(pending);
      scr_net_sock_release(pending);
    }
  }
  scr_ws_destroy_socket(ws);
  if (ws->ready_state == SCR_WS_OPEN || ws->ready_state == SCR_WS_CONNECTING)
    scr_ws_emit_type(ws, "error");
  ScrStr *empty = scr_str_new("", 0);
  scr_ws_emit_close(ws, 1006, empty, false);
  scr_str_release(empty);
}

/* A connection-failing condition that still has a socket: the named close
 * goes out when the socket still writes; the application sees Node's
 * failed-connection pair (error, then close 1006, unclean). */
static void scr_ws_fail_close_impl(ScrWs *ws, int code) {
  if (ws->discard) return;
  if (ws->sock != NULL && !ws->close_sent) {
    /* A client masks every frame it sends, close frames included. */
    const unsigned char payload[2] = {
        (unsigned char)((unsigned)code >> 8),
        (unsigned char)((unsigned)code & 0xff),
    };
    scr_ws_send_frame(ws, SCR_WS_OP_CLOSE, payload, sizeof payload);
    ws->close_sent = true;
  }
  ws->discard = true;
  scr_ws_destroy_socket(ws);
  scr_ws_emit_type(ws, "error");
  ScrStr *empty = scr_str_new("", 0);
  scr_ws_emit_close(ws, 1006, empty, false);
  scr_str_release(empty);
}

/* A protocol violation (1002). */
static void scr_ws_fail_protocol_impl(ScrWs *ws) { scr_ws_fail_close_impl(ws, 1002); }

/* A message over Node's payload or fragment limit (1009 or 1008). */
static void scr_ws_fail_limit_impl(ScrWs *ws, int code) { scr_ws_fail_close_impl(ws, code); }

static void scr_ws_fail_limit(ScrWs *ws, int code) {
  if (ws == NULL) return;
  scr_ws_retain_v(ws);
  scr_ws_fail_limit_impl(ws, code);
  scr_ws_release_v(ws);
}

/* RFC 3629: no overlong forms, surrogates or values above U+10FFFF, and no
 * truncated sequence — the check a text message and a close reason take
 * before their bytes become a string. */
static bool scr_ws_utf8_valid(const unsigned char *p, size_t n) {
  for (size_t i = 0; i < n;) {
    unsigned char c = p[i];
    uint32_t cp;
    size_t extra;
    if (c < 0x80) {
      i++;
      continue;
    }
    if (c >= 0xC2 && c <= 0xDF) {
      extra = 1;
      cp = c & 0x1Fu;
    } else if (c >= 0xE0 && c <= 0xEF) {
      extra = 2;
      cp = c & 0x0Fu;
    } else if (c >= 0xF0 && c <= 0xF4) {
      extra = 3;
      cp = c & 0x07u;
    } else {
      return false; /* a continuation byte, C0/C1, or F5..FF */
    }
    if (extra > n - 1 - i) return false;
    for (size_t k = 1; k <= extra; k++) {
      unsigned char cc = p[i + k];
      if ((cc & 0xC0) != 0x80) return false;
      cp = (cp << 6) | (cc & 0x3Fu);
    }
    if (extra == 2 && (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF))) return false;
    if (extra == 3 && (cp < 0x10000 || cp > 0x10FFFF)) return false;
    i += extra + 1;
  }
  return true;
}

/* Invalid UTF-8 in a text message or a close reason: a 1007 close goes out
 * when the socket still writes, and the application sees the same
 * failed-connection pair as a protocol failure (error, then close 1006). */
static void scr_ws_fail_utf8_impl(ScrWs *ws) {
  if (ws->discard) return;
  if (ws->sock != NULL && !ws->close_sent) {
    /* A client masks every frame it sends, close frames included. */
    static const unsigned char payload[2] = {0x03, 0xEF}; /* close 1007 */
    scr_ws_send_frame(ws, SCR_WS_OP_CLOSE, payload, sizeof payload);
    ws->close_sent = true;
  }
  ws->discard = true;
  scr_ws_destroy_socket(ws);
  scr_ws_emit_type(ws, "error");
  ScrStr *empty = scr_str_new("", 0);
  scr_ws_emit_close(ws, 1006, empty, false);
  scr_str_release(empty);
}

static void scr_ws_read_close_impl(ScrWs *ws, const unsigned char *payload, size_t length);

/* These paths emit events and then keep using the state; a listener that
 * drops the program's last reference must not free it mid-path. */
static void scr_ws_fail(ScrWs *ws) {
  if (ws == NULL) return;
  scr_ws_retain_v(ws);
  scr_ws_fail_impl(ws);
  scr_ws_release_v(ws);
}

static void scr_ws_fail_protocol(ScrWs *ws) {
  if (ws == NULL) return;
  scr_ws_retain_v(ws);
  scr_ws_fail_protocol_impl(ws);
  scr_ws_release_v(ws);
}

static void scr_ws_fail_utf8(ScrWs *ws) {
  if (ws == NULL) return;
  scr_ws_retain_v(ws);
  scr_ws_fail_utf8_impl(ws);
  scr_ws_release_v(ws);
}

static void scr_ws_read_close(ScrWs *ws, const unsigned char *payload, size_t length) {
  scr_ws_retain_v(ws);
  scr_ws_read_close_impl(ws, payload, length);
  scr_ws_release_v(ws);
}

/* ── frames ─────────────────────────────────────────────────────────── */

/* The client's frames are masked (RFC 6455 §5.3). */
static size_t scr_ws_frame_header(unsigned char *out, int opcode, size_t length, bool fin) {
  size_t n = 0;
  out[n++] = (unsigned char)((fin ? 0x80 : 0) | opcode);
  if (length < 126) {
    out[n++] = (unsigned char)(0x80 | length);
  } else if (length <= 0xffff) {
    out[n++] = 0x80 | 126;
    out[n++] = (unsigned char)(length >> 8);
    out[n++] = (unsigned char)(length & 0xff);
  } else {
    out[n++] = 0x80 | 127;
    for (int i = 7; i >= 0; i--) out[n++] = (unsigned char)((uint64_t)length >> (8 * i));
  }
  unsigned char mask[4];
  arc4random_buf(mask, sizeof mask);
  memcpy(out + n, mask, sizeof mask);
  return n + sizeof mask;
}

/* bufferedAmount: the queued payload until the socket has written every
 * byte of the frames it came in, then zero. The socket's writable length is
 * the pending-bytes signal (bytesWritten counts accepted bytes, buffered or
 * not). */
static double scr_ws_buffered_amount(ScrWs *ws) {
  if (ws->sock == NULL || ws->buffered_amount == 0) {
    ws->buffered_amount = 0;
    return 0;
  }
  if (scr_net_sock_writable_length(ws->sock) <= 0) {
    ws->buffered_amount = 0;
    return 0;
  }
  return ws->buffered_amount;
}

static size_t scr_ws_send_frame(ScrWs *ws, int opcode, const unsigned char *payload,
                                size_t length) {
  if (ws->sock == NULL) return 0;
  unsigned char header[14];
  size_t header_len = scr_ws_frame_header(header, opcode, length, true);
  const unsigned char *mask = header + header_len - 4;
  size_t total = header_len + length;
  if (opcode == SCR_WS_OP_TEXT || opcode == SCR_WS_OP_BINARY) {
    /* send's contribution: the payload bytes queued until the socket has
     * written every byte of the frames it came in (Node counts application
     * data, not frame overhead); a send into an empty socket starts the
     * count over, because everything counted before has flushed. */
    if (scr_net_sock_writable_length(ws->sock) == 0) ws->buffered_amount = 0;
    ws->buffered_amount += (double)length;
  }
  unsigned char *frame = malloc(total ? total : 1);
  if (frame == NULL) scr_trap("scriptc: out of memory\n");
  memcpy(frame, header, header_len);
  for (size_t i = 0; i < length; i++) frame[header_len + i] = (unsigned char)(payload[i] ^ mask[i & 3]);
  scr_net_sock_write_native(ws->sock, (const char *)frame, total);
  free(frame);
  return total;
}

/* The peer's close payload: a code (0 or 2+ bytes) and a UTF-8 reason. */
static void scr_ws_read_close_impl(ScrWs *ws, const unsigned char *payload, size_t length) {
  int64_t code = 1005;
  if (length == 1) {
    scr_ws_fail_protocol(ws);
    return;
  }
  if (length >= 2) code = ((int64_t)payload[0] << 8) | (int64_t)payload[1];
  if (length > 2 && !scr_ws_utf8_valid(payload + 2, length - 2)) {
    /* The reason is not UTF-8: fail the connection with 1007 instead of
     * echoing a close whose reason cannot be a string. */
    scr_ws_fail_utf8(ws);
    return;
  }
  ScrStr *reason = scr_str_new(length >= 2 ? (const char *)payload + 2 : "",
                               length >= 2 ? length - 2 : 0);
  if (!ws->close_sent && ws->sock != NULL) {
    scr_ws_send_frame(ws, SCR_WS_OP_CLOSE, payload, length);
    ws->close_sent = true;
  }
  scr_ws_destroy_socket(ws);
  scr_ws_emit_close(ws, code, reason, true);
  scr_str_release(reason);
}

static void scr_ws_deliver(ScrWs *ws, int opcode, const unsigned char *payload, size_t length) {
  if (opcode == SCR_WS_OP_TEXT) {
    if (!scr_ws_utf8_valid(payload, length)) {
      /* RFC 6455 8.1: a text message that fails UTF-8 fails the connection
       * with 1007. The message is the reassembled one, so a sequence split
       * across fragments passes when the whole is valid. */
      scr_ws_fail_utf8(ws);
      return;
    }
    ScrStr *text = scr_str_new((const char *)(length ? payload : (const unsigned char *)""), length);
    ScrDyn *data = scr_dyn_new_str(text);
    scr_str_release(text);
    if (data != NULL) scr_ws_emit(ws, scr_message_event_with(data, false));
    scr_dyn_release(data);
    return;
  }
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)length);
  if (length > 0) memcpy(bytes->data, payload, length);
  ScrDyn *data = NULL;
  if (ws->binary_type == 1) {
    data = scr_array_buffer_from_bytes(bytes);
  } else {
    /* binaryType 'blob' (Node's default): the message is a Blob holding
     * the bytes, built through the blob unit the dyn-async feature links.
     * The part is the ArrayBuffer view of the payload, which the blob's
     * part walk copies byte for byte. */
    ScrDyn *sources = scr_dyn_new_arr();
    scr_dyn_arr_push(sources, scr_array_buffer_from_bytes(bytes));
    ScrDyn *args = scr_dyn_new_arr();
    scr_dyn_arr_push(args, sources);
    data = scr_blob_new(args);
    scr_dyn_release(args);
  }
  scr_bytes_release(bytes);
  if (data != NULL) scr_ws_emit(ws, scr_message_event_with(data, false));
  scr_dyn_release(data);
}

static void scr_ws_handle_frame(ScrWs *ws, int fin, int opcode, const unsigned char *payload,
                                size_t length);

/* Parses every complete frame in the receive buffer, leaving a partial one
 * for the next read. */
static void scr_ws_parse(ScrWs *ws) {
  size_t used = 0;
  while (ws->buf_len - used >= 2) {
    const unsigned char *p = ws->buf + used;
    size_t avail = ws->buf_len - used;
    int fin = (p[0] & 0x80) != 0;
    int rsv = p[0] & 0x70;
    int opcode = p[0] & 0x0f;
    int masked = (p[1] & 0x80) != 0;
    uint64_t length = p[1] & 0x7f;
    size_t offset = 2;
    if (rsv != 0 || masked) {
      /* No extension is negotiated, and a server never masks. */
      scr_ws_fail_protocol(ws);
      return;
    }
    if (length == 126) {
      if (avail < 4) break;
      length = ((uint64_t)p[2] << 8) | p[3];
      offset = 4;
    } else if (length == 127) {
      if (avail < 10) break;
      length = 0;
      for (int i = 0; i < 8; i++) length = (length << 8) | p[2 + i];
      offset = 10;
    }
    bool control = (opcode & 0x08) != 0;
    if (control) {
      if (!fin || length > 125 ||
          (opcode != SCR_WS_OP_CLOSE && opcode != SCR_WS_OP_PING && opcode != SCR_WS_OP_PONG)) {
        scr_ws_fail_protocol(ws);
        return;
      }
    } else if (opcode != SCR_WS_OP_CONTINUATION && opcode != SCR_WS_OP_TEXT &&
               opcode != SCR_WS_OP_BINARY) {
      scr_ws_fail_protocol(ws);
      return;
    }
    if (length > (uint64_t)(SIZE_MAX - offset)) {
      scr_ws_fail_protocol(ws);
      return;
    }
    if (!control) {
      /* Node's payload cap, counted over the whole message: a declared
       * frame is rejected from its header, before its body is buffered. */
      size_t prior = opcode == SCR_WS_OP_CONTINUATION ? ws->frag_len : 0;
      if (length > (uint64_t)(SCR_WS_MAX_PAYLOAD - prior)) {
        scr_ws_fail_limit(ws, 1009);
        return;
      }
    }
    if (avail < offset + (size_t)length) break;
    scr_ws_handle_frame(ws, fin, opcode, p + offset, (size_t)length);
    if (ws->discard || ws->sock == NULL) return;
    used += offset + (size_t)length;
  }
  if (used > 0) {
    memmove(ws->buf, ws->buf + used, ws->buf_len - used);
    ws->buf_len -= used;
  }
}

static void scr_ws_handle_frame(ScrWs *ws, int fin, int opcode, const unsigned char *payload,
                                size_t length) {
  switch (opcode) {
  case SCR_WS_OP_PING:
    if (ws->sock != NULL && !ws->close_sent) scr_ws_send_frame(ws, SCR_WS_OP_PONG, payload, length);
    return;
  case SCR_WS_OP_PONG:
    return;
  case SCR_WS_OP_CLOSE:
    scr_ws_read_close(ws, payload, length);
    return;
  case SCR_WS_OP_TEXT:
  case SCR_WS_OP_BINARY:
    /* Node dispatches no message once close() was called: frames still
     * buffered after the handler that closed are discarded, while control
     * frames (the peer's ping or close) are still answered. */
    if (ws->ready_state != SCR_WS_OPEN) return;
    if (ws->frag_opcode != 0) {
      scr_ws_fail_protocol(ws);
      return;
    }
    if (fin) {
      scr_ws_deliver(ws, opcode, payload, length);
      return;
    }
    ws->frag_opcode = opcode;
    ws->frag_frames = 1;
    if (length > 0) {
      size_t cap = 4096;
      while (cap < length) {
        if (cap > SIZE_MAX / 2) {
          cap = length;
          break;
        }
        cap *= 2;
      }
      ws->frag = malloc(cap);
      if (ws->frag == NULL) scr_trap("scriptc: out of memory\n");
      memcpy(ws->frag, payload, length);
      ws->frag_len = length;
      ws->frag_cap = cap;
    }
    return;
  case SCR_WS_OP_CONTINUATION:
    if (ws->ready_state != SCR_WS_OPEN) {
      /* The rest of a message that was arriving when close() was called is
       * not delivered; drop the partial reassembly with it. */
      free(ws->frag);
      ws->frag = NULL;
      ws->frag_len = 0;
      ws->frag_cap = 0;
      ws->frag_opcode = 0;
      ws->frag_frames = 0;
      return;
    }
    if (ws->frag_opcode == 0) {
      scr_ws_fail_protocol(ws);
      return;
    }
    if (ws->frag_frames >= SCR_WS_MAX_FRAGMENTS) {
      /* Node's fragment cap: the peer cannot keep the reassembly alive
       * with an unbounded number of frames. */
      scr_ws_fail_limit(ws, 1008);
      return;
    }
    ws->frag_frames++;
    if (length > 0) {
      size_t need = ws->frag_len + length;
      if (need < ws->frag_len) {
        scr_ws_fail_protocol(ws);
        return;
      }
      if (need > ws->frag_cap) {
        /* geometric growth: a message arriving in many small continuation
         * frames costs linear, not quadratic, copying */
        size_t cap = ws->frag_cap ? ws->frag_cap : 4096;
        while (cap < need) {
          if (cap > SIZE_MAX / 2) {
            cap = need;
            break;
          }
          cap *= 2;
        }
        unsigned char *grown = realloc(ws->frag, cap);
        if (grown == NULL) scr_trap("scriptc: out of memory\n");
        ws->frag = grown;
        ws->frag_cap = cap;
      }
      memcpy(ws->frag + ws->frag_len, payload, length);
      ws->frag_len += length;
    }
    if (fin) {
      int message_opcode = ws->frag_opcode;
      unsigned char *whole = ws->frag;
      size_t whole_len = ws->frag_len;
      ws->frag = NULL;
      ws->frag_len = 0;
      ws->frag_cap = 0;
      ws->frag_opcode = 0;
      ws->frag_frames = 0;
      scr_ws_deliver(ws, message_opcode, whole, whole_len);
      free(whole);
    }
    return;
  default:
    scr_ws_fail_protocol(ws);
  }
}

/* ── the socket reader ─────────────────────────────────────────────── */

static void scr_ws_on_data_impl(void *ctx, const char *buf, size_t n) {
  ScrWs *ws = ctx;
  if (ws->discard) return;
  if (ws->buf_len + n > ws->buf_cap) {
    size_t cap = ws->buf_cap ? ws->buf_cap : 4096;
    while (cap < ws->buf_len + n) cap *= 2;
    unsigned char *grown = realloc(ws->buf, cap);
    if (grown == NULL) scr_trap("scriptc: out of memory\n");
    ws->buf = grown;
    ws->buf_cap = cap;
  }
  memcpy(ws->buf + ws->buf_len, buf, n);
  ws->buf_len += n;
  scr_ws_parse(ws);
}

/* The peer went away without a close frame: 1006, unclean. A close the
 * program asked for that the peer never confirmed is unclean too. */
static void scr_ws_on_eof_impl(void *ctx) {
  ScrWs *ws = ctx;
  if (ws->discard || ws->close_dispatched) return;
  ws->discard = true;
  scr_ws_destroy_socket(ws);
  /* A peer that goes away without a close frame is an unclean closure:
   * Node reports 'error' before the 1006 'close', whether the client was
   * open or already closing. */
  scr_ws_emit_type(ws, "error");
  ScrStr *empty = scr_str_new("", 0);
  scr_ws_emit_close(ws, 1006, empty, false);
  scr_str_release(empty);
}

/* ── the handshake ─────────────────────────────────────────────────── */

static ScrWs *scr_ws_from(ScrClosure *cb) {
  return (ScrWs *)scr_box_get_ref(cb->caps[0]);
}

static ScrClosure *scr_ws_closure(ScrWs *ws, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(scr_ws_retain_v, scr_ws_release_v, NULL);
  scr_box_set_ref(box, scr_ws_retain_v(ws));
  cb->caps[0] = box;
  return cb;
}

static ScrStr *scr_ws_accept_for(ScrStr *key) {
  ScrStr *guid = scr_str_new(SCR_WS_ACCEPT_GUID, sizeof SCR_WS_ACCEPT_GUID - 1);
  ScrStr *joined = scr_str_concat(key, guid);
  scr_str_release(guid);
  unsigned char digest[32];
  size_t digest_len =
      scr_sha1_digest((const unsigned char *)joined->data, joined->len, digest);
  scr_str_release(joined);
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)digest_len);
  memcpy(bytes->data, digest, digest_len);
  ScrStr *enc = scr_str_new("base64", 6);
  ScrStr *encoded = scr_bytes_to_str(bytes, enc);
  scr_str_release(enc);
  scr_bytes_release(bytes);
  return encoded;
}

/* Whether `chosen` (the server's Sec-WebSocket-Protocol) names exactly one
 * of the offered subprotocols; an absent one is right when none was
 * offered. Stores the negotiated value in ws->protocol.
 *
 * The value must equal one offered token as a whole: a response that lists
 * several tokens (or pads one) is not a selected protocol, and Node rejects
 * it, as it rejects a response when the client offered protocols and the
 * server selected none. */
static bool scr_ws_protocol_ok(ScrWs *ws, ScrStr *chosen) {
  if (chosen == NULL) return ws->offered->len == 0;
  if (ws->offered->len == 0 || chosen->len == 0) return false;
  size_t at = 0;
  for (;;) {
    size_t begin = at;
    while (at < ws->offered->len && ws->offered->data[at] != ',') at++;
    size_t end = at;
    /* The request value is built as "a, b": only the joining space is
     * insignificant, and offered tokens never contain one. */
    while (begin < end && ws->offered->data[begin] == ' ') begin++;
    while (end > begin && ws->offered->data[end - 1] == ' ') end--;
    size_t token_len = end - begin;
    if (token_len == chosen->len &&
        memcmp(ws->offered->data + begin, chosen->data, token_len) == 0) {
      ScrStr *value = scr_str_new((const char *)chosen->data, chosen->len);
      scr_str_release(ws->protocol);
      ws->protocol = value;
      return true;
    }
    if (at == ws->offered->len) break;
    at++; /* the comma */
  }
  return false;
}

static void scr_ws_on_upgrade(ScrClosure *cb, ScrHttpReq *res, ScrNetSocket *socket,
                              ScrBytes *head) {
  ScrWs *ws = scr_ws_from(cb);
  scr_http_req_release(res);
  if (ws == NULL) {
    scr_bytes_release(head);
    scr_net_sock_destroy(socket);
    scr_net_sock_release(socket);
    return;
  }
  if (ws->discard || ws->ready_state == SCR_WS_CLOSED || ws->ready_state == SCR_WS_CLOSING) {
    /* A close() during the handshake fails the connection. */
    scr_bytes_release(head);
    scr_net_sock_destroy(socket);
    scr_net_sock_release(socket);
    if (ws->ready_state == SCR_WS_CLOSING) scr_ws_fail(ws);
    scr_ws_release_v(ws);
    return;
  }
  ScrStr *accept_name = scr_str_new("sec-websocket-accept", 20);
  ScrStr *accept = scr_http_req_header(res, accept_name);
  scr_str_release(accept_name);
  ScrStr *expected = scr_ws_accept_for(ws->key_b64);
  bool accept_ok = accept != NULL && expected != NULL && accept->len == expected->len &&
                   memcmp(accept->data, expected->data, accept->len) == 0;
  scr_str_release(accept);
  scr_str_release(expected);
  ScrStr *protocol_name = scr_str_new("sec-websocket-protocol", 22);
  ScrStr *chosen = scr_http_req_header(res, protocol_name);
  scr_str_release(protocol_name);
  bool protocol_ok = scr_ws_protocol_ok(ws, chosen);
  scr_str_release(chosen);
  if (!accept_ok || !protocol_ok) {
    scr_bytes_release(head);
    scr_net_sock_destroy(socket);
    scr_net_sock_release(socket);
    scr_ws_fail(ws);
    scr_ws_release_v(ws);
    return;
  }
  ws->sock = socket; /* takes the callback's reference */
  /* The HTTP parser's context stays registered on the socket (freed at its
   * death); the frame reader's callbacks receive the WebSocket instead. */
  scr_net_sock_set_native_reader_keep_ctx(ws->sock, scr_ws_on_data, scr_ws_on_eof, scr_ws_on_eof, ws);
  ws->ready_state = SCR_WS_OPEN;
  scr_ws_emit_type(ws, "open");
  if (head != NULL && head->len > 0) scr_ws_on_data(ws, (const char *)head->data, (size_t)head->len);
  scr_bytes_release(head);
  scr_ws_release_v(ws);
}

static void scr_ws_on_client_close(ScrClosure *cb) {
  ScrWs *ws = scr_ws_from(cb);
  if (ws == NULL) return;
  if (ws->ready_state == SCR_WS_CONNECTING) scr_ws_fail(ws);
  scr_ws_release_v(ws);
}

static void scr_ws_on_response(ScrClosure *cb, ScrHttpReq *res) {
  /* A response that is not the 101 handover: the exchange failed. */
  ScrWs *ws = scr_ws_from(cb);
  scr_http_req_release(res);
  if (ws == NULL) return;
  scr_ws_fail(ws);
  scr_ws_release_v(ws);
}

static void scr_ws_on_error(ScrClosure *cb, ScrStr *message) {
  /* `message` is borrowed (the error emitter owns it). */
  (void)message;
  ScrWs *ws = scr_ws_from(cb);
  if (ws == NULL) return;
  scr_ws_fail(ws);
  scr_ws_release_v(ws);
}

/* The socket reader pins its receiver: a message or error listener may drop
 * the program's last reference, and the parse loop and failure paths keep
 * using the state after the dispatch. */
static void scr_ws_on_data(void *ctx, const char *buf, size_t n) {
  ScrWs *ws = ctx;
  if (ws == NULL) return;
  scr_ws_retain_v(ws);
  scr_ws_on_data_impl(ws, buf, n);
  scr_ws_release_v(ws);
}

static void scr_ws_on_eof(void *ctx) {
  ScrWs *ws = ctx;
  if (ws == NULL) return;
  scr_ws_retain_v(ws);
  scr_ws_on_eof_impl(ws);
  scr_ws_release_v(ws);
}

/* ── the member surface ────────────────────────────────────────────── */

static bool scr_ws_method_is(const char *method, const char *want) {
  return strcmp(method, want) == 0;
}

/* The close codes close() may send (WHATWG: 1000 or 3000-4999). */
static bool scr_ws_close_code_valid(int64_t code) {
  return code == 1000 || (code >= 3000 && code <= 4999);
}

static ScrDyn *scr_ws_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what) {
  ScrWs *ws = ptr;
  (void)what;
  if (scr_ws_method_is(method, "send")) {
    if (argc == 0) {
      static const char message[] = "WebSocket.send: 1 argument required, but 0 found.";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    if (ws->ready_state == SCR_WS_CONNECTING) {
      scr_throw_domex("InvalidStateError", "Sent before connected.");
      return NULL;
    }
    if (ws->ready_state != SCR_WS_OPEN) return scr_dyn_retain(scr_dyn_undefined());
    ScrDyn *value = args[0];
    if (value->kind == SCR_DYN_STR) {
      ScrStr *text = value->v.str;
      scr_ws_send_frame(ws, SCR_WS_OP_TEXT, (const unsigned char *)text->data, text->len);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    if (value->kind == SCR_DYN_TYPED_REF) {
      ScrDyn *materialized = scr_dyn_typed_ref_materialize(value);
      if (materialized == NULL) return NULL;
      ScrDyn *out = scr_ws_invoke(ptr, self, method, &materialized, 1, what);
      scr_dyn_release(materialized);
      return out;
    }
    if (value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_BLOB) {
      static const char message[] = "Sending a Blob has no lowering yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    if (value->kind == SCR_DYN_BYTES || scr_buffer_storage_is(value)) {
      ScrBytes *view = scr_bytes_buffer_source(value);
      if (view == NULL) return NULL;
      scr_ws_send_frame(ws, SCR_WS_OP_BINARY, (const unsigned char *)view->data, (size_t)view->len);
      scr_bytes_release(view);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    /* Any other value takes ToString and goes out as text, as undici's send
     * does (`ws.send(5)` sends "5"; a symbol throws its conversion error). */
    ScrStr *text = scr_dyn_string_coerce_js(value);
    if (text == NULL) return NULL;
    scr_ws_send_frame(ws, SCR_WS_OP_TEXT, (const unsigned char *)text->data, text->len);
    scr_str_release(text);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (scr_ws_method_is(method, "close")) {
    if (ws->ready_state == SCR_WS_CLOSING || ws->ready_state == SCR_WS_CLOSED)
      return scr_dyn_retain(scr_dyn_undefined());
    int64_t code = 1000;
    bool has_code = false;
    ScrStr *reason = NULL;
    if (argc > 0 && args[0]->kind != SCR_DYN_UNDEF) {
      double raw = 0;
      if (!scr_dyn_number_coerce_js(args[0], &raw)) return NULL;
      if (!isfinite(raw)) raw = 0;
      code = (int64_t)(raw < 0 ? -1 : raw);
      has_code = true;
      if (!scr_ws_close_code_valid(code)) {
        scr_throw_domex("InvalidAccessError", "invalid code");
        return NULL;
      }
    }
    if (argc > 1 && args[1]->kind != SCR_DYN_UNDEF) {
      reason = scr_dyn_string_coerce_js(args[1]);
      if (reason == NULL) return NULL;
      if (reason->len > 123) {
        char message[80];
        int length = snprintf(message, sizeof message,
                              "Reason must be less than 123 bytes; received %zu", reason->len);
        scr_str_release(reason);
        scr_throw_domex("SyntaxError", message);
        return NULL;
      }
    }
    if (ws->ready_state == SCR_WS_CONNECTING) {
      /* Node fails the handshake: the pending request is destroyed (a
       * server that stalls the opening handshake must not keep the
       * connection alive), then 'error' and close 1006 are reported. */
      ws->ready_state = SCR_WS_CLOSING;
      scr_str_release(reason);
      if (ws->client != NULL) {
        ScrNetSocket *pending = scr_http_client_socket(ws->client);
        scr_http_client_destroy(ws->client);
        /* the dialed connection goes with the request */
        if (pending != NULL) {
          scr_net_sock_destroy(pending);
          scr_net_sock_release(pending);
        }
      }
      if (!ws->discard) {
        ws->discard = true;
        scr_ws_destroy_socket(ws);
        scr_ws_emit_type(ws, "error");
        ScrStr *empty = scr_str_new("", 0);
        scr_ws_emit_close(ws, 1006, empty, false);
        scr_str_release(empty);
      }
      return scr_dyn_retain(scr_dyn_undefined());
    }
    unsigned char payload[125];
    size_t length = 0;
    if (has_code || reason != NULL) {
      payload[0] = (unsigned char)(code >> 8);
      payload[1] = (unsigned char)(code & 0xff);
      length = 2;
      if (reason != NULL) {
        memcpy(payload + 2, reason->data, reason->len);
        length += reason->len;
      }
    }
    scr_str_release(reason);
    scr_ws_send_frame(ws, SCR_WS_OP_CLOSE, payload, length);
    ws->close_sent = true;
    ws->ready_state = SCR_WS_CLOSING;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  /* The EventTarget side: addEventListener, removeEventListener,
   * dispatchEvent. */
  scr_et_broadcast_install();
  ScrDyn *out = NULL;
  if (scr_et_broadcast_ops->method(ws->et, self, method, args, argc, &out)) return out;
  static const char message[] = "This WebSocket method is not implemented";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

/* addEventListener, removeEventListener, dispatchEvent, send and close as
 * values; each runs on the receiver its call names, as Node's methods do. */
static const char *const scr_ws_method_names[] = {"addEventListener", "removeEventListener",
                                                  "dispatchEvent", "send", "close"};
static SCR_TL ScrDyn *scr_ws_method_values[5];

static void scr_ws_method_values_cleanup(void) {
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *value = scr_ws_method_values[i];
    scr_ws_method_values[i] = NULL;
    scr_dyn_release(value);
  }
}

static ScrDyn *scr_ws_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (!scr_websocket_is(self)) {
    static const char message[] = "Illegal invocation";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_THIS");
  } else {
    size_t which = (size_t)scr_box_get_f64(closure->caps[0]);
    result = scr_ws_invoke(self->v.handle.ptr, self, scr_ws_method_names[which], args, argc,
                           "WebSocket method");
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_ws_method_value(size_t which) {
  if (scr_ws_method_values[which] == NULL) {
    static SCR_TL bool registered;
    if (!registered) {
      registered = true;
      scr_atexit(scr_ws_method_values_cleanup);
    }
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(closure->caps[0], (double)which);
    scr_ws_method_values[which] = scr_dyn_new_func(closure, scr_ws_method_call, 0, "",
                                                   scr_ws_method_names[which]);
  }
  return scr_dyn_retain(scr_ws_method_values[which]);
}

static ScrDyn *scr_ws_get(void *ptr, const char *key, size_t len) {
  ScrWs *ws = ptr;
  /* The interface constants are readable on an instance too: Node answers
   * `ws.OPEN` from the prototype, so a guard such as
   * `ws.readyState === ws.OPEN` works. */
  if (len == 10 && memcmp(key, "CONNECTING", 10) == 0) return scr_dyn_new_num(SCR_WS_CONNECTING);
  if (len == 4 && memcmp(key, "OPEN", 4) == 0) return scr_dyn_new_num(SCR_WS_OPEN);
  if (len == 7 && memcmp(key, "CLOSING", 7) == 0) return scr_dyn_new_num(SCR_WS_CLOSING);
  if (len == 6 && memcmp(key, "CLOSED", 6) == 0) return scr_dyn_new_num(SCR_WS_CLOSED);
  if (len == 3 && memcmp(key, "url", 3) == 0) return scr_dyn_new_str(ws->url);
  if (len == 10 && memcmp(key, "readyState", 10) == 0) return scr_dyn_new_num(ws->ready_state);
  if (len == 8 && memcmp(key, "protocol", 8) == 0) return scr_dyn_new_str(ws->protocol);
  if (len == 10 && memcmp(key, "extensions", 10) == 0) {
    ScrStr *empty = scr_str_new("", 0);
    ScrDyn *out = scr_dyn_new_str(empty);
    scr_str_release(empty);
    return out;
  }
  if (len == 14 && memcmp(key, "bufferedAmount", 14) == 0)
    return scr_dyn_new_num(scr_ws_buffered_amount(ws));
  if (len == 10 && memcmp(key, "binaryType", 10) == 0) {
    ScrStr *value = scr_str_new(ws->binary_type == 1 ? "arraybuffer" : "blob",
                                ws->binary_type == 1 ? 11 : 4);
    ScrDyn *out = scr_dyn_new_str(value);
    scr_str_release(value);
    return out;
  }
  if ((len == 6 && memcmp(key, "onopen", 6) == 0) ||
      (len == 9 && memcmp(key, "onmessage", 9) == 0) ||
      (len == 7 && memcmp(key, "onerror", 7) == 0) ||
      (len == 7 && memcmp(key, "onclose", 7) == 0)) {
    char type[16];
    memcpy(type, key + 2, len - 2);
    type[len - 2] = '\0';
    scr_et_broadcast_install();
    return scr_et_broadcast_ops->handler_get(ws->et, type);
  }
  for (size_t i = 0; i < 5; i++) {
    if (strlen(scr_ws_method_names[i]) == len && memcmp(scr_ws_method_names[i], key, len) == 0)
      return scr_ws_method_value(i);
  }
  return NULL;
}

static bool scr_ws_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  ScrWs *ws = ptr;
  if (len == 10 && memcmp(key, "binaryType", 10) == 0) {
    /* Web IDL enum assignment: an unknown value leaves the attribute as it
     * was, without an exception. */
    ScrStr *name = scr_dyn_string_coerce_js((ScrDyn *)value);
    if (name != NULL) {
      if (name->len == 4 && memcmp(name->data, "blob", 4) == 0) ws->binary_type = 0;
      else if (name->len == 11 && memcmp(name->data, "arraybuffer", 11) == 0) ws->binary_type = 1;
      scr_str_release(name);
    }
    return true;
  }
  if ((len == 6 && memcmp(key, "onopen", 6) == 0) ||
      (len == 9 && memcmp(key, "onmessage", 9) == 0) ||
      (len == 7 && memcmp(key, "onerror", 7) == 0) ||
      (len == 7 && memcmp(key, "onclose", 7) == 0)) {
    char type[16];
    memcpy(type, key + 2, len - 2);
    type[len - 2] = '\0';
    scr_et_broadcast_install();
    scr_et_broadcast_ops->handler_set(ws->et, type, value);
    return true;
  }
  return false;
}

static const ScrDynHandleOps scr_ws_ops = {
    .cls = "WebSocket",
    .retain = scr_ws_retain_v,
    .release = scr_ws_release_v,
    .invoke = scr_ws_invoke,
    .get = scr_ws_get,
    .set = scr_ws_set,
};

bool scr_websocket_is(const ScrDyn *value) {
  return value != NULL && value->kind == SCR_DYN_HANDLE &&
         value->v.handle.tag == SCR_DYNH_WEBSOCKET;
}

/* ── construction ──────────────────────────────────────────────────── */

/* Whether `token` is an RFC 7230 token (the subprotocol grammar). */
static bool scr_ws_is_token(const char *p, size_t n) {
  if (n == 0) return false;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)p[i];
    if (c <= 0x20 || c >= 0x7f) return false;
    if (strchr("()<>@,;:\\\"/[]?={}", c) != NULL) return false;
  }
  return true;
}

/* The Sec-WebSocket-Protocol request value. A string is one protocol, a
 * sequence contributes each element (coerced), and anything else — Node's
 * tolerates a non-iterable second argument — offers none. false = the
 * value is invalid (a bad token or a duplicate); an exception may also be
 * pending from a coercion. */
static bool scr_ws_protocols(ScrDyn *protocols, ScrStr **offered) {
  *offered = scr_str_new("", 0);
  if (protocols == NULL || protocols->kind == SCR_DYN_UNDEF || protocols->kind == SCR_DYN_NULL)
    return true;
  ScrStr *joined = NULL;
  if (protocols->kind == SCR_DYN_TYPED_REF) {
    /* A compiled value crossing as a capsule (a `string[]` or `string`
     * variable): the protocols are the value's own view. The inner call
     * fills a slot of its own; its result replaces this call's empty value
     * (which is released here, not left to the caller). */
    ScrDyn *view = scr_dyn_typed_ref_materialize(protocols);
    if (view == NULL) return false;
    ScrStr *inner = NULL;
    bool ok = scr_ws_protocols(view, &inner);
    scr_dyn_release(view);
    if (!ok) {
      scr_str_release(inner);
      return false;
    }
    scr_str_release(*offered);
    *offered = inner;
    return true;
  }
  if (protocols->kind == SCR_DYN_STR) {
    if (!scr_ws_is_token(protocols->v.str->data, protocols->v.str->len)) return false;
    joined = scr_str_retain(protocols->v.str);
  } else if (protocols->kind == SCR_DYN_ARR) {
    /* ToString on an element runs JavaScript that can grow or replace the
     * array, freeing the backing the elements were read through: snapshot
     * the elements (each retained) before the first coercion. */
    size_t count = (size_t)protocols->v.arr.len;
    ScrDyn **items = calloc(count ? count : 1, sizeof *items);
    ScrStr **tokens = calloc(count ? count : 1, sizeof *tokens);
    if (items == NULL || tokens == NULL) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < count; i++) items[i] = scr_dyn_retain(protocols->v.arr.items[i]);
    bool ok = true;
    /* Duplicates are found through a hash set: a list of distinct tokens
     * costs one probe per token, not a comparison per pair. */
    size_t slots = 16;
    while (slots <= count && slots <= (SIZE_MAX >> 3)) slots <<= 1;
    size_t *seen = calloc(slots ? slots : 1, sizeof *seen);
    if (seen == NULL) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < count && ok; i++) {
      tokens[i] = scr_dyn_string_coerce_js(items[i]);
      if (tokens[i] == NULL) {
        ok = false;
        break;
      }
      if (!scr_ws_is_token(tokens[i]->data, tokens[i]->len)) {
        ok = false;
        break;
      }
      uint64_t hash = 1469598103934665603ull;
      for (size_t at = 0; at < tokens[i]->len; at++) {
        hash ^= (unsigned char)tokens[i]->data[at];
        hash *= 1099511628211ull;
      }
      size_t slot = (size_t)hash & (slots - 1);
      for (;;) {
        if (seen[slot] == 0) {
          seen[slot] = i + 1;
          break;
        }
        ScrStr *other = tokens[seen[slot] - 1];
        if (other->len == tokens[i]->len &&
            memcmp(other->data, tokens[i]->data, tokens[i]->len) == 0) {
          ok = false;
          break;
        }
        slot = (slot + 1) & (slots - 1);
      }
    }
    free(seen);
    if (ok) {
      size_t total = 0;
      for (size_t i = 0; i < count; i++) total += tokens[i]->len + (i ? 2 : 0);
      char *text = malloc(total ? total : 1);
      if (text == NULL) scr_trap("scriptc: out of memory\n");
      size_t at = 0;
      for (size_t i = 0; i < count; i++) {
        if (i) {
          text[at++] = ',';
          text[at++] = ' ';
        }
        memcpy(text + at, tokens[i]->data, tokens[i]->len);
        at += tokens[i]->len;
      }
      joined = scr_str_new(text, total);
      free(text);
    }
    for (size_t i = 0; i < count; i++) scr_str_release(tokens[i]);
    for (size_t i = 0; i < count; i++) scr_dyn_release(items[i]);
    free(items);
    free(tokens);
    if (!ok) {
      if (joined != NULL) scr_str_release(joined);
      return false;
    }
  } else {
    return true; /* not a string or a sequence: no protocols */
  }
  scr_str_release(*offered);
  *offered = joined != NULL ? joined : scr_str_new("", 0);
  return true;
}

/* The handshake starts on the loop's next turn: construction never resolves
 * the peer's name (Node's WebSocket starts connecting from a queued task,
 * not the constructor), and the request is built exactly as it was when the
 * constructor dialed directly. */
static void scr_ws_connect(ScrClosure *cb) {
  /* Every ref box answers +1; the releases below give those back before the
   * callback returns, so the deferred connect leaves nothing alive. */
  ScrWs *ws = scr_box_get_ref(cb->caps[0]);
  if (ws == NULL) return;
  if (ws->discard || ws->ready_state != SCR_WS_CONNECTING) {
    scr_ws_release_v(ws);
    return;
  }
  ScrStr *host = scr_box_get_ref(cb->caps[1]);
  ScrStr *target = scr_box_get_ref(cb->caps[2]);
  ScrStr *method = scr_box_get_ref(cb->caps[3]);
  ScrArr *headers = scr_box_get_ref(cb->caps[4]);
  double port = scr_box_get_f64(cb->caps[5]);
  int secure = (int)scr_box_get_f64(cb->caps[6]);
  ScrStr *sni = secure ? scr_str_retain(host) : NULL;
  void *wrap_ctx = secure ? scr_tls_fetch_client_ctx(sni, true) : NULL;
  ws->client = scr_http_request_ex(host, port, target, method, 0, headers, false, NULL, NULL,
                                   secure ? 443 : 80, secure ? scr_tls_fetch_client_wrap : NULL,
                                   wrap_ctx);
  scr_str_release(sni);
  scr_str_release(host);
  scr_str_release(target);
  scr_str_release(method);
  scr_arr_release(headers);
  if (ws->client == NULL) {
    /* A request the constructor used to throw for (a malformed proxy
     * environment, say): the connection fails through the events. */
    if (scr_exc_pending()) scr_exc_clear();
    scr_ws_fail(ws);
    scr_ws_release_v(ws);
    return;
  }
  scr_http_client_on_upgrade(ws->client, scr_ws_closure(ws, (void *)&scr_ws_on_upgrade),
                             &scr_ws_on_upgrade, true);
  scr_http_client_on_response(ws->client, scr_ws_closure(ws, (void *)&scr_ws_on_response),
                              &scr_ws_on_response, true);
  scr_http_client_on_error(ws->client, scr_ws_closure(ws, (void *)&scr_ws_on_error),
                           &scr_ws_on_error, false);
  /* A transport that ends without an error before the handshake (the
   * refused-connect shape on some platforms) still fails the socket. */
  scr_http_client_on_close(ws->client, scr_ws_closure(ws, (void *)&scr_ws_on_client_close), false);
  scr_http_client_frame_any_method(ws->client);
  scr_http_client_flush_headers(ws->client);
  scr_ws_release_v(ws);
}

ScrDyn *scr_websocket_new(ScrDyn *url, ScrDyn *protocols) {
  /* The emitted main installs the net unit's loop hooks only for a program
   * whose IR uses node:net; a lone WebSocket client must do it itself (the
   * fetch entry does the same). */
  static SCR_TL bool net_installed;
  if (!net_installed) {
    net_installed = true;
    scr_net_install();
  }
  if (url == NULL || url->kind == SCR_DYN_UNDEF) {
    static const char message[] = "WebSocket constructor: 1 argument required, but 0 found.";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrStr *input = scr_dyn_string_coerce_js(url);
  if (input == NULL) return NULL;
  if (!scr_url_can_parse(input)) {
    scr_str_release(input);
    scr_throw_domex("SyntaxError", "TypeError: Invalid URL");
    return NULL;
  }
  ScrUrl *parsed = scr_url_new(input);
  scr_str_release(input);
  if (parsed == NULL) return NULL;
  ScrStr *scheme = scr_url_protocol(parsed);
  bool secure;
  if (scheme->len == 3 && memcmp(scheme->data, "ws:", 3) == 0) secure = false;
  else if (scheme->len == 4 && memcmp(scheme->data, "wss:", 4) == 0) secure = true;
  else if (scheme->len == 5 && memcmp(scheme->data, "http:", 5) == 0) secure = false;
  else if (scheme->len == 6 && memcmp(scheme->data, "https:", 6) == 0) secure = true;
  else {
    scr_str_release(scheme);
    scr_url_release(parsed);
    scr_throw_domex("SyntaxError", "expected a ws: or wss: url");
    return NULL;
  }
  scr_str_release(scheme);
  ScrStr *href = scr_url_href(parsed);
  ScrStr *ws_url;
  if (href->len >= 5 && memcmp(href->data, "http:", 5) == 0) {
    ScrStr *rest = scr_str_new(href->data + 5, href->len - 5);
    ScrStr *prefix = scr_str_new("ws:", 3);
    ws_url = scr_str_concat(prefix, rest);
    scr_str_release(prefix);
    scr_str_release(rest);
  } else if (href->len >= 6 && memcmp(href->data, "https:", 6) == 0) {
    ScrStr *rest = scr_str_new(href->data + 6, href->len - 6);
    ScrStr *prefix = scr_str_new("wss:", 4);
    ws_url = scr_str_concat(prefix, rest);
    scr_str_release(prefix);
    scr_str_release(rest);
  } else {
    ws_url = scr_str_retain(href);
  }
  scr_str_release(href);
  for (size_t i = 0; i < ws_url->len; i++) {
    if (ws_url->data[i] == '#') {
      scr_str_release(ws_url);
      scr_url_release(parsed);
      scr_throw_domex("SyntaxError", "hash");
      return NULL;
    }
  }
  ScrStr *offered = NULL;
  if (!scr_ws_protocols(protocols, &offered)) {
    scr_str_release(offered);
    scr_str_release(ws_url);
    scr_url_release(parsed);
    scr_throw_domex("SyntaxError", "Invalid Sec-WebSocket-Protocol value");
    return NULL;
  }
  ScrStr *host = scr_url_hostname(parsed);
  ScrStr *port_text = scr_url_port(parsed);
  double port = port_text->len > 0 ? strtod(port_text->data, NULL) : (secure ? 443 : 80);
  scr_str_release(port_text);
  /* The request target: the path and query of the normalized href. */
  size_t scheme_len = ws_url->len >= 6 && memcmp(ws_url->data, "wss:", 4) == 0 ? 4 : 3;
  size_t at = ws_url->len > scheme_len + 2 ? scheme_len + 2 : ws_url->len;
  while (at < ws_url->len && ws_url->data[at] != '/' && ws_url->data[at] != '?') at++;
  ScrStr *target = at < ws_url->len ? scr_str_new(ws_url->data + at, ws_url->len - at)
                                    : scr_str_new("/", 1);
  scr_url_release(parsed);

  scr_et_broadcast_install();
  static ScrCycType cyc_type = {&scr_ws_trace, &scr_ws_gcfree, SCR_CYC_KIND_NONE, 0};
  ScrWs *ws = scr_cyc_alloc(sizeof *ws, &cyc_type);
  if (ws == NULL) scr_trap("scriptc: out of memory\n");
  memset(ws, 0, sizeof *ws);
  ws->rc = 1;
  scr_obj_alloc_note();
  ws->ready_state = SCR_WS_CONNECTING;
  ws->url = ws_url;
  ws->offered = offered;
  ws->protocol = scr_str_new("", 0);
  ws->et = scr_et_broadcast_ops->core_new("WebSocket");
  unsigned char key[16];
  arc4random_buf(key, sizeof key);
  ScrBytes *key_bytes = scr_bytes_new(SCR_BYTES_U8, (double)sizeof key);
  memcpy(key_bytes->data, key, sizeof key);
  ScrStr *b64 = scr_str_new("base64", 6);
  ws->key_b64 = scr_bytes_to_str(key_bytes, b64);
  scr_str_release(b64);
  scr_bytes_release(key_bytes);

  ScrArr *headers = scr_arr_new(SCR_ELEM_STR, 10);
  scr_arr_push_ref(headers, scr_str_new("upgrade", 7));
  scr_arr_push_ref(headers, scr_str_new("websocket", 9));
  scr_arr_push_ref(headers, scr_str_new("connection", 10));
  scr_arr_push_ref(headers, scr_str_new("Upgrade", 7));
  scr_arr_push_ref(headers, scr_str_new("sec-websocket-key", 17));
  scr_arr_push_ref(headers, scr_str_retain(ws->key_b64));
  scr_arr_push_ref(headers, scr_str_new("sec-websocket-version", 21));
  scr_arr_push_ref(headers, scr_str_new("13", 2));
  if (ws->offered->len > 0) {
    scr_arr_push_ref(headers, scr_str_new("sec-websocket-protocol", 22));
    scr_arr_push_ref(headers, scr_str_retain(ws->offered));
  }
  ScrStr *method = scr_str_new("GET", 3);
  /* The connection's inputs move into a one-shot timer: the dial runs after
   * the constructor returns, so no name resolution happens in it. */
  ScrClosure *starter = scr_closure_new((void *)scr_ws_connect, 7);
  ScrBox *ws_box = scr_box_new_obj(scr_ws_retain_v, scr_ws_release_v, NULL);
  scr_box_set_ref(ws_box, scr_ws_retain_v(ws));
  ScrBox *host_box = scr_box_new_obj(scr_str_retain_v, scr_str_release_v, NULL);
  scr_box_set_ref(host_box, scr_str_retain(host));
  ScrBox *target_box = scr_box_new_obj(scr_str_retain_v, scr_str_release_v, NULL);
  scr_box_set_ref(target_box, scr_str_retain(target));
  ScrBox *method_box = scr_box_new_obj(scr_str_retain_v, scr_str_release_v, NULL);
  scr_box_set_ref(method_box, scr_str_retain(method));
  ScrBox *headers_box = scr_box_new_obj(scr_arr_retain_v, scr_arr_release_v, NULL);
  scr_box_set_ref(headers_box, scr_arr_retain(headers));
  ScrBox *port_box = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(port_box, port);
  ScrBox *secure_box = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(secure_box, secure ? 1 : 0);
  starter->caps[0] = ws_box;
  starter->caps[1] = host_box;
  starter->caps[2] = target_box;
  starter->caps[3] = method_box;
  starter->caps[4] = headers_box;
  starter->caps[5] = port_box;
  starter->caps[6] = secure_box;
  /* The dial runs with the stores that were active at construction, like
   * every other deferred callback the runtime schedules (scr_next_tick);
   * with no store active the scheduler hands the closure straight back. */
  scr_set_timeout_als(starter, 0);
  scr_str_release(method);
  scr_arr_release(headers);
  scr_str_release(target);
  scr_str_release(host);
  ScrDyn *out = scr_dyn_new_handle(ws, SCR_DYNH_WEBSOCKET);
  scr_ws_release_v(ws);
  return out;
}

__attribute__((constructor)) static void scr_ws_ops_install(void) {
  scr_dyn_handle_install(SCR_DYNH_WEBSOCKET, &scr_ws_ops);
}
