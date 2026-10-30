/* Native Fetch, AbortSignal, Headers, and ReadableStream implementations.
 * Requests use the native socket, TLS, and event-loop runtime. */
/* Fetch's bad-port table applies to the initial request and each redirect. */
#define SCR_FETCH_BAD_PORTS \
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, \
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, \
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,   \
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,   \
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,   \
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080

#include "scr_runtime.h"
#include "scr_system_errors.h"
#include "scr_url_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef SCR_FETCH_SIGNAL_ONLY
#include <zlib.h>
#else
static void sf_signal_install(void);
#endif

typedef struct SfTransfer SfTransfer;
typedef struct SfSignal SfSignal;
typedef struct SfSignalWatch SfSignalWatch;
typedef struct SfStream SfStream;
typedef struct SfReader SfReader;
typedef struct SfResponse SfResponse;
typedef struct SfHeaders SfHeaders;
typedef struct SfCollector SfCollector;
typedef struct SfReadRequest SfReadRequest;
typedef struct SfPullWait SfPullWait;
typedef struct SfStartWait SfStartWait;
typedef struct SfCancelWait SfCancelWait;
typedef struct SfTypedRef SfTypedRef;

typedef struct SfChunk {
  ScrDyn *value;
  struct SfChunk *next;
} SfChunk;

struct SfReadRequest {
  ScrPromise *promise;            /* or NULL for a sink request */
  const ScrFetchReadSink *sink;   /* readableStreamDefaultReaderRead's read request */
  void *sink_ctx;
  SfReadRequest *next;
};

struct SfTypedRef {
  ScrDyn *value;
  SfTypedRef *next;
};

struct SfSignalWatch {
  SfSignal *source; /* weak; NULL after the source fires */
  void *owner;      /* owner keeps source alive */
  void (*fire)(SfSignalWatch *, SfSignal *);
  SfSignalWatch *next;
};

struct SfSignal {
  size_t rc;
  bool aborted;
  ScrDyn *reason;
  ScrError *error_reason;
  bool reason_self;
  ScrDynHandleTag reason_self_tag;
  bool reason_tracked;
  SfSignal *reason_next;
  ScrEventTargetCore core; /* listeners and the onabort attribute */
  SfSignalWatch *watchers;
  SfSignal **sources;
  SfSignalWatch **source_watches;
  size_t source_count;
  double timer_id;
};

struct SfReader {
  size_t rc;
  size_t handle_refs;
  SfStream *stream; /* weak; handle refs retain it while the lock is live */
  SfReadRequest *pending_head;
  SfReadRequest *pending_tail;
  ScrPromise *closed;
};

enum {
  SF_COLLECT_JSON,
  SF_COLLECT_TEXT,
  SF_COLLECT_BYTES,
  SF_COLLECT_ARRAY_BUFFER,
};

enum {
  SF_REDIRECT_FOLLOW,
  SF_REDIRECT_ERROR,
  SF_REDIRECT_MANUAL,
};

struct SfCollector {
  ScrPromise *promise;
  SfStream *held_stream;
  char *data;
  size_t len;
  size_t cap;
  int mode;
};

struct SfPullWait {
  SfStream *stream;
  ScrPromise *promise;
};

struct SfStartWait {
  SfStream *stream;
  ScrPromise *promise;
};

struct SfCancelWait {
  ScrPromise *source;
  ScrPromise *result;
};

typedef struct SfThenState {
  size_t rc;
  bool called;
  ScrPromise *promise;
} SfThenState;

struct SfStream {
  size_t rc;
  SfChunk *head;
  SfChunk *tail;
  size_t queued;
  bool started;
  bool close_requested;
  bool closed;
  bool disturbed;
  bool internal_lock;
  bool initial_pull_pending;
  bool enqueue_draining;
  bool pulling;
  bool pull_again;
  bool discarded;
  bool request_discarding;
  /* A zero high-water mark (a TransformStream's readable side): pull only
   * while a read is pending. */
  bool hwm_zero;
  ScrDyn *error;
  SfReader *reader;       /* owned while locked */
  SfCollector *collector; /* owned while a body reader is active */
  ScrDyn *pull_cb;
  ScrDyn *cancel_cb;
  ScrDyn *source_this;
  ScrDyn *from_dyn;
#ifdef SCR_HANDLE_CLASSES
  /* A body made from a checked-dynamic web ReadableStream: that stream's
   * reader (+1), read one chunk per pull through scr_web_stream_bridge. */
  ScrDyn *web_reader;
  /* Consuming the body takes Uint8Array chunks only: set on a body from a
   * web ReadableStream and on the tee branches of such a body. */
  bool u8_chunks;
  /* The web ReadableStream this stream's checked-dynamic handles stand
   * for once a member the fetch stream lacks is used (+1, or NULL; see
   * sf_stream_web_view). It reads this stream; from then on every member
   * and every use of the body go through it. */
  ScrDyn *web_view;
  /* A reader of web_view (+1) that keeps it locked while this stream was
   * locked when web_view was made: by a reader of its own, released
   * later, or by reading the body. */
  ScrDyn *web_view_lock;
  /* web_view's reader of this stream, taken at its first pull (owned
   * through `reader`). */
  SfReader *view_reader;
  /* web_view's source holds a reference to this stream. */
  bool view_source_live;
#endif
  ScrArr *from_array;
  ScrBytes *from_bytes;
  ScrStr *from_string;
  ScrDyn *(*from_array_item)(ScrArr *, double);
  double from_index;
  /* Canonical transit capsules for repeated references in a typed source
   * array. Keeping one capsule per source identity gives both typed
   * structural conversions and unknown/any reads one stable JS object. */
  SfTypedRef *typed_refs;
  SfTransfer *request_owner;  /* weak; transfer owns the stream */
  SfTransfer *response_owner; /* weak; transfer owns the stream */
  bool callbacks_tracked;
  SfStream *callbacks_next;
  /* Told when the stream errors (a tee watching its source's closed
   * promise); ctx is borrowed and the watcher clears it before it goes. */
  void (*error_watch)(void *ctx, ScrDyn *reason);
  void *error_watch_ctx;
};

struct SfHeaders {
  size_t rc;
  ScrArr *pairs;
  /* Fetch's "sort and combine" list of `pairs` as flat name/value pairs,
   * built on the first iteration step and dropped by every mutation. */
  ScrArr *sorted;
  bool immutable;
  /* `pairs` is in the form sf_add_converted_headers builds: lowercase valid
   * names, trimmed valid UTF-8 values, one combined pair per name except
   * set-cookie. Headers built from wire lines are not (duplicates stay). */
  bool canonical;
};

struct SfResponse {
  size_t rc;
  SfStream *body;
  SfHeaders *headers;
  ScrStr *url;
  ScrStr *status_text;
  int status;
  bool redirected;
  bool null_body;
  /* @hono/node-server's lightweight-response state (scr_fetch_response_light):
   * whether a constructed Response is still one the package would write
   * from its constructor arguments, and in which header form. 0: not (it
   * was materialized by a body/metadata read, or never qualified); 1: no
   * init headers; 2: a Headers (or pair list) form; 3: a plain record,
   * whose raw entries light_record keeps in order. */
  int8_t light;
  /* Form 2 reached from form 1 by a headers read: the package's Headers
   * start with its default text content type when the body is not null. */
  bool light_default_ct;
  /* The constructor added the text content type (a string body without
   * one), which the package's lightweight headers never hold. */
  bool auto_ct;
  /* The body's byte length (string or Uint8Array), -1 for a null body,
   * -2 for a stream. */
  double light_length;
  ScrArr *light_record;
};

#ifndef SCR_FETCH_SIGNAL_ONLY
struct SfTransfer {
  size_t rc;                 /* live registry + one per listener closure */
  ScrPromise *promise;       /* owned */
  ScrUrl *url;               /* current hop, owned */
  ScrStr *method;            /* current method, owned */
  ScrArr *headers;           /* user header pairs, owned */
  ScrDyn *body;              /* replayable body or source stream, owned */
  int redirect_mode;
  int hops;
  bool redirected;
  ScrHttpClientReq *client;  /* owned */
  ScrNetSocket *response_socket; /* owned while the response is live */
  bool response_paused;
  bool response_null_body;
  SfSignal *signal;          /* owned */
  SfSignalWatch *signal_watch;
  SfStream *request_stream;  /* owned */
  SfStream *response_stream; /* owned */
  bool request_has_content_length;
  size_t request_content_length;
  size_t request_body_sent;
  z_stream zs;
  ScrBytes *inflate_pending;
  bool inflating;
  bool inflate_member_end;
  bool inflate_needs_drain;
  bool inflate_draining;
  bool response_ended;
  bool response_sent;
  bool done;
  bool live; /* listed in sf_live */
  struct SfTransfer *prev, *next;
};

/* the transfers in flight: +1 each, most recent first */
static SfTransfer *sf_live;
#endif
/* Weak registries: owners unlink themselves on destruction. They let the
 * fetch teardown sever opaque native→dyn edges before final cycle collection,
 * including otherwise-untraceable callback/reason→handle backedges. */
static SfSignal *sf_reason_signals;
#ifndef SCR_FETCH_SIGNAL_ONLY
static SfStream *sf_callback_streams;
#endif

static void sf_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static bool sf_name(const char *key, size_t len, const char *want) {
  return strlen(want) == len && memcmp(key, want, len) == 0;
}

static void sf_type_error(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

static void sf_not_function(const char *what) {
  size_t n = strlen(what);
  char *message = malloc(n + 19);
  if (!message) sf_oom();
  memcpy(message, what, n);
  memcpy(message + n, " is not a function", 19);
  scr_throw_error_msg(SCR_ERR_TYPE, message, n + 18);
  free(message);
}

static bool sf_is_error_dyn(const ScrDyn *d) {
  if (!d || d->kind != SCR_DYN_OBJ) return false;
  const ScrDyn *mark = scr_dyn_obj_get(d, "%error", 6);
  return mark && mark->kind == SCR_DYN_BOOL && mark->v.b;
}

static void sf_throw_dyn_reason(ScrDyn *reason) {
  if (sf_is_error_dyn(reason)) {
    ScrError *e = scr_error_from_dyn(reason);
    scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    return;
  }
  switch (reason ? reason->kind : SCR_DYN_UNDEF) {
  case SCR_DYN_NUM:
    scr_throw_f64(reason->v.num);
    return;
  case SCR_DYN_BOOL:
    scr_throw_bool(reason->v.b);
    return;
  case SCR_DYN_STR:
    scr_throw_str(scr_str_retain(reason->v.str));
    return;
  default:
    scr_throw_ref_classified(scr_dyn_retain(reason ? reason : scr_dyn_undefined()),
                             &scr_dyn_retain_v, &scr_dyn_release_v, NULL,
                             scr_dyn_is_object(reason ? reason : scr_dyn_undefined()));
    return;
  }
}

static void sf_reject_promise_reason(ScrPromise *p, ScrDyn *reason) {
  sf_throw_dyn_reason(reason);
  scr_promise_reject_pending(p);
}

static ScrDyn *sf_dom_reason(const char *name, const char *message,
                            ScrError **error_out) {
  ScrStr *message_str = scr_str_new(message, strlen(message));
  ScrStr *name_str = scr_str_new(name, strlen(name));
  ScrDyn *m = scr_dyn_new_str(message_str);
  ScrDyn *n = scr_dyn_new_str(name_str);
  scr_str_release(message_str);
  scr_str_release(name_str);
  ScrError *e = scr_domex_new(m, n);
  scr_dyn_release(m);
  scr_dyn_release(n);
  ScrDyn *d = scr_dyn_from_error(e);
  *error_out = e; /* constructor +1 moves to the signal */
  return d;
}

static ScrDyn *sf_type_reason(const char *message, ScrError **error_out) {
  ScrStr *message_str = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_TYPE, message_str);
  scr_str_release(message_str);
  ScrDyn *d = scr_dyn_from_error(e);
  *error_out = e;
  return d;
}

/* Request's URL parse failure: with the URL parser's TypeError pending,
 * replace it by undici's TypeError "Failed to parse URL from <input>"
 * whose (non-enumerable) cause is the parser error. */
static void sf_throw_url_parse_failure(const ScrStr *input) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *cause = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  /* Sized without the NUL so it stays out of the unit's shared mergeable
   * string section (which every program linking this unit carries). */
  static const char prefix[25] = "Failed to parse URL from ";
  size_t message_len = sizeof prefix + input->len;
  char *message = malloc(message_len);
  if (!message) sf_oom();
  memcpy(message, prefix, sizeof prefix);
  memcpy(message + sizeof prefix, input->data, input->len);
  ScrStr *text = scr_str_new(message, message_len);
  free(message);
  ScrError *e = scr_error_new(SCR_ERR_TYPE, text);
  scr_str_release(text);
  scr_error_set_cause(e, cause);
  e->cause_enumerable = false;
  scr_dyn_release(cause);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* ── AbortSignal ─────────────────────────────────────────────────── */

static void sf_signal_track_reason(SfSignal *s) {
  if (s->reason_tracked) return;
  s->reason_tracked = true;
  s->reason_next = sf_reason_signals;
  sf_reason_signals = s;
}

static void sf_signal_untrack_reason(SfSignal *s) {
  if (!s->reason_tracked) return;
  for (SfSignal **at = &sf_reason_signals; *at;
       at = &(*at)->reason_next) {
    if (*at == s) {
      *at = s->reason_next;
      break;
    }
  }
  s->reason_tracked = false;
  s->reason_next = NULL;
}

/* A controller may abort with itself or its own signal as the reason.
 * Those handles point back to this SfSignal, so retaining their ScrDyn box
 * would create an opaque RC cycle. Remember the identity as tag + pointer
 * instead and mint an equivalent handle whenever the reason is observed;
 * checked-dynamic strict equality uses that same pair. Other reasons stay
 * strongly owned and join the teardown registry so larger reason/handle
 * cycles can be severed once no Web object remains observable. */
static ScrDyn *sf_signal_reason_ref(SfSignal *s) {
  if (s->reason_self) {
    return scr_dyn_new_handle(s, s->reason_self_tag);
  }
  return scr_dyn_retain(s->reason);
}

static void sf_signal_drop_reason(SfSignal *s) {
  ScrDyn *reason = s->reason;
  ScrError *error_reason = s->error_reason;
  sf_signal_untrack_reason(s);
  s->reason = NULL;
  s->error_reason = NULL;
  s->reason_self = false;
  scr_error_release(error_reason);
  /* May release a handle that owns s and destroy it reentrantly. All s
   * fields used by this cleanup are therefore cleared before this call. */
  scr_dyn_release(reason);
}

static SfSignal *sf_signal_new(void) {
#ifdef SCR_FETCH_SIGNAL_ONLY
  sf_signal_install();
#endif
  SfSignal *s = calloc(1, sizeof *s);
  if (!s) sf_oom();
  s->rc = 1;
  /* AbortSignal sets kMaxEventTargetListeners to 0: no leak warning. */
  scr_et_core_init(&s->core, 0, "AbortSignal");
  return s;
}

static SfSignal *sf_signal_retain(SfSignal *s) {
  s->rc++;
  return s;
}

static void sf_signal_release(SfSignal *s);

static void sf_watch_free(SfSignalWatch *w) {
  if (!w) return;
  if (w->source) {
    for (SfSignalWatch **at = &w->source->watchers; *at; at = &(*at)->next) {
      if (*at == w) {
        *at = w->next;
        break;
      }
    }
  }
  free(w);
}

static void sf_signal_release(SfSignal *s) {
  if (!s || --s->rc > 0) return;
  for (size_t i = 0; i < s->source_count; i++) {
    sf_watch_free(s->source_watches[i]);
    sf_signal_release(s->sources[i]);
  }
  free(s->source_watches);
  free(s->sources);
  scr_et_core_drop(&s->core);
  sf_signal_drop_reason(s);
  free(s);
}

static void *sf_signal_retain_v(void *p) {
  return sf_signal_retain((SfSignal *)p);
}
static void sf_signal_release_v(void *p) {
  sf_signal_release((SfSignal *)p);
}

static SfSignalWatch *sf_signal_watch(SfSignal *source, void *owner,
                                     void (*fire)(SfSignalWatch *,
                                                  SfSignal *)) {
  SfSignalWatch *w = calloc(1, sizeof *w);
  if (!w) sf_oom();
  w->source = source;
  w->owner = owner;
  w->fire = fire;
  w->next = source->watchers;
  source->watchers = w;
  return w;
}

/* runAbort: a trusted 'abort' Event through the signal's EventTarget. */
static void sf_signal_dispatch_abort(SfSignal *s) {
  ScrDyn *event = scr_event_new_trusted("abort");
  ScrDyn *self = scr_dyn_new_handle(s, SCR_DYNH_ABORT_SIGNAL);
  scr_et_dispatch(&s->core, self, event);
  scr_dyn_release(self);
  scr_dyn_release(event);
}

static void sf_signal_abort_full(SfSignal *s, ScrDyn *reason,
                                 ScrError *error_reason) {
  if (s->aborted) return;
  s->aborted = true;
  if (reason && reason->kind == SCR_DYN_HANDLE &&
      reason->v.handle.ptr == s &&
      (reason->v.handle.tag == SCR_DYNH_ABORT_SIGNAL ||
       reason->v.handle.tag == SCR_DYNH_ABORT_CONTROLLER)) {
    s->reason_self = true;
    s->reason_self_tag = reason->v.handle.tag;
  } else {
    s->reason = scr_dyn_retain(reason);
    sf_signal_track_reason(s);
  }
  s->error_reason = error_reason ? scr_error_retain(error_reason) : NULL;
  while (s->watchers) {
    SfSignalWatch *w = s->watchers;
    s->watchers = w->next;
    w->source = NULL;
    w->fire(w, s); /* the owner may free w */
  }
  sf_signal_dispatch_abort(s);
}

static void sf_signal_abort_default(SfSignal *s, bool timeout) {
  ScrError *e = NULL;
  ScrDyn *reason = sf_dom_reason(
      timeout ? "TimeoutError" : "AbortError",
      timeout ? "The operation was aborted due to timeout"
              : "This operation was aborted",
      &e);
  sf_signal_abort_full(s, reason, e);
  scr_dyn_release(reason);
  scr_error_release(e);
}

static SfSignal *sf_signal_of(const ScrDyn *d, const char *where) {
  if (!d || d->kind != SCR_DYN_HANDLE ||
      d->v.handle.tag != SCR_DYNH_ABORT_SIGNAL) {
    sf_type_error(where);
    return NULL;
  }
  return (SfSignal *)d->v.handle.ptr;
}

/* options.signal for the EventTarget engine. */
static ScrEventTargetCore *sf_signal_core_of(const ScrDyn *d, bool *aborted) {
  if (!d || d->kind != SCR_DYN_HANDLE || d->v.handle.tag != SCR_DYNH_ABORT_SIGNAL) return NULL;
  SfSignal *s = (SfSignal *)d->v.handle.ptr;
  *aborted = s->aborted;
  return &s->core;
}

static void sf_signal_timer_fire(ScrClosure *cb) {
  SfSignal *s = (SfSignal *)scr_box_get_ref(cb->caps[0]);
  if (!s) return;
  s->timer_id = 0;
  sf_signal_abort_default(s, true);
  sf_signal_release(s);
}

/* The mocked AbortSignal.timeout's timer: Node's mock calls abort() on
 * the signal's controller, so the reason is the AbortError. */
static void sf_signal_mock_timer_fire(ScrClosure *cb) {
  SfSignal *s = (SfSignal *)scr_box_get_ref(cb->caps[0]);
  if (!s) return;
  if (!s->aborted) sf_signal_abort_default(s, false);
  sf_signal_release(s);
}

ScrDyn *scr_fetch_abort_timeout(ScrDyn *delay) {
  if (!delay || delay->kind != SCR_DYN_NUM) {
    if (delay) {
      scr_dyn_arg_type_fail("delay", "of type number", delay);
    } else {
      static const char message[] =
          "The \"delay\" argument must be of type number. Received undefined";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1,
                               "ERR_INVALID_ARG_TYPE");
    }
    return NULL;
  }
  double ms = delay->v.num;
  if (!isfinite(ms) || trunc(ms) != ms || ms < 0 || ms > 4294967295.0) {
    char received[48];
    scr_num_received(ms, received);
    const char *range =
        !isfinite(ms) || trunc(ms) != ms
            ? "an integer"
            : ">= 0 && <= 4294967295";
    char message[224];
    int len = snprintf(
        message, sizeof message,
        "The value of \"delay\" is out of range. It must be %s. Received %s",
        range, received);
    if (len < 0 || (size_t)len >= sizeof message) sf_oom();
    scr_throw_error_msg_code(SCR_ERR_RANGE, message, (size_t)len,
                             "ERR_OUT_OF_RANGE");
    return NULL;
  }
  SfSignal *s = sf_signal_new();
  bool mocked = scr_mt_abort_timeout_arm != NULL;
  ScrClosure *cb = scr_closure_new(
      mocked ? (void *)&sf_signal_mock_timer_fire : (void *)&sf_signal_timer_fire, 1);
  ScrBox *box =
      scr_box_new_obj(&sf_signal_retain_v, &sf_signal_release_v, NULL);
  scr_box_set_ref(box, sf_signal_retain(s));
  cb->caps[0] = box;
  if (mocked) {
    scr_mt_abort_timeout_arm(cb, ms);
  } else {
    s->timer_id = scr_set_timeout_handle(cb, ms);
    scr_timer_unref(s->timer_id);
  }
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_ABORT_SIGNAL);
  sf_signal_release(s);
  return out;
}

ScrDyn *scr_fetch_abort_now(ScrDyn *reason) {
  SfSignal *s = sf_signal_new();
  if (!reason || reason->kind == SCR_DYN_UNDEF) {
    sf_signal_abort_default(s, false);
  } else {
    ScrError *e = sf_is_error_dyn(reason) ? scr_error_from_dyn(reason) : NULL;
    sf_signal_abort_full(s, reason, e);
    scr_error_release(e);
  }
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_ABORT_SIGNAL);
  sf_signal_release(s);
  return out;
}

static void sf_any_source_abort(SfSignalWatch *w, SfSignal *source) {
  SfSignal *out = (SfSignal *)w->owner;
  ScrDyn *reason = sf_signal_reason_ref(source);
  sf_signal_abort_full(out, reason, source->error_reason);
  scr_dyn_release(reason);
}

ScrDyn *scr_fetch_abort_any(ScrDyn *signals) {
  if (!signals || signals->kind != SCR_DYN_ARR) {
    static const char message[] =
        "signals cannot be converted to sequence.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1,
                             "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  SfSignal *out = sf_signal_new();
  out->source_count = signals->v.arr.len;
  if (out->source_count) {
    out->sources = calloc(out->source_count, sizeof *out->sources);
    out->source_watches =
        calloc(out->source_count, sizeof *out->source_watches);
    if (!out->sources || !out->source_watches) sf_oom();
  }
  for (size_t i = 0; i < out->source_count; i++) {
    SfSignal *source =
        sf_signal_of(signals->v.arr.items[i],
                     "AbortSignal.any requires an array of AbortSignals");
    if (!source) {
      sf_signal_release(out);
      return NULL;
    }
    out->sources[i] = sf_signal_retain(source);
    if (source->aborted) {
      ScrDyn *reason = sf_signal_reason_ref(source);
      sf_signal_abort_full(out, reason, source->error_reason);
      scr_dyn_release(reason);
    } else {
      out->source_watches[i] =
          sf_signal_watch(source, out, &sf_any_source_abort);
    }
  }
  ScrDyn *boxed = scr_dyn_new_handle(out, SCR_DYNH_ABORT_SIGNAL);
  sf_signal_release(out);
  return boxed;
}

/* AbortController is a distinct public handle over the same native signal
 * state fetch and AbortSignal.any observe. Reading `.signal` boxes that
 * state with the AbortSignal tag, so repeated reads preserve JS identity
 * through the checked-dynamic handle equality rule (tag + pointer). */
ScrDyn *scr_fetch_abort_controller_new(void) {
  SfSignal *s = sf_signal_new();
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_ABORT_CONTROLLER);
  sf_signal_release(s);
  return out;
}

static ScrDyn *sf_abort_controller_invoke(
    void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
    size_t argc, const char *what) {
  SfSignal *s = ptr;
  if (strcmp(method, "abort") == 0) {
    if (!s->aborted) {
      ScrDyn *reason = argc > 0 ? args[0] : NULL;
      if (!reason || reason->kind == SCR_DYN_UNDEF) {
        sf_signal_abort_default(s, false);
      } else {
        ScrError *e = sf_is_error_dyn(reason) ? scr_error_from_dyn(reason) : NULL;
        sf_signal_abort_full(s, reason, e);
        scr_error_release(e);
      }
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_abort_controller_get(
    void *ptr, const char *key, size_t len) {
  if (sf_name(key, len, "signal")) {
    return scr_dyn_new_handle(ptr, SCR_DYNH_ABORT_SIGNAL);
  }
  return NULL;
}

static ScrDyn *sf_signal_invoke(void *ptr, ScrDyn *self, const char *method,
                                ScrDyn *const *args, size_t argc,
                                const char *what) {
  SfSignal *s = ptr;
  if (strcmp(method, "throwIfAborted") == 0) {
    if (s->aborted) {
      ScrDyn *reason = sf_signal_reason_ref(s);
      sf_throw_dyn_reason(reason);
      scr_dyn_release(reason);
      return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "addEventListener") == 0) return scr_et_add_listener(&s->core, args, argc);
  if (strcmp(method, "removeEventListener") == 0)
    return scr_et_remove_listener(&s->core, args, argc);
  if (strcmp(method, "dispatchEvent") == 0)
    return scr_et_dispatch_event(&s->core, self, args, argc);
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_signal_get(void *ptr, const char *key, size_t len) {
  SfSignal *s = ptr;
  if (sf_name(key, len, "aborted")) return scr_dyn_new_bool(s->aborted);
  if (sf_name(key, len, "reason")) {
    return s->aborted ? sf_signal_reason_ref(s)
                      : scr_dyn_retain(scr_dyn_undefined());
  }
  if (sf_name(key, len, "onabort")) return scr_et_handler_get(&s->core, "abort");
  /* Inherited from EventTarget: the function every target shares. */
  return scr_event_target_method_value(key, len);
}

static bool sf_signal_set(void *ptr, const char *key, size_t len,
                          const ScrDyn *value) {
  SfSignal *s = ptr;
  if (!sf_name(key, len, "onabort")) return false;
  scr_et_handler_set(&s->core, "abort", value);
  return true;
}

/* ── ReadableStream ──────────────────────────────────────────────── */

#ifndef SCR_FETCH_SIGNAL_ONLY

static void sf_stream_track_callbacks(SfStream *s) {
  if (s->callbacks_tracked || (!s->pull_cb && !s->cancel_cb)) return;
  s->callbacks_tracked = true;
  s->callbacks_next = sf_callback_streams;
  sf_callback_streams = s;
}

static void sf_stream_untrack_callbacks(SfStream *s) {
  if (!s->callbacks_tracked) return;
  for (SfStream **at = &sf_callback_streams; *at;
       at = &(*at)->callbacks_next) {
    if (*at == s) {
      *at = s->callbacks_next;
      break;
    }
  }
  s->callbacks_tracked = false;
  s->callbacks_next = NULL;
}

static SfStream *sf_stream_new_native(void) {
  SfStream *s = calloc(1, sizeof *s);
  if (!s) sf_oom();
  s->rc = 1;
  s->started = true;
  return s;
}

static SfStream *sf_stream_retain(SfStream *s) {
  s->rc++;
  return s;
}

static SfReader *sf_reader_retain(SfReader *r) {
  r->rc++;
  return r;
}

static SfReadRequest *sf_reader_take_request(SfReader *r) {
  SfReadRequest *request = r->pending_head;
  if (!request) return NULL;
  r->pending_head = request->next;
  if (!r->pending_head) r->pending_tail = NULL;
  request->next = NULL;
  return request;
}

static void sf_reader_reject_message_all(SfReader *r, const char *message) {
  SfReadRequest *request;
  while ((request = sf_reader_take_request(r)) != NULL) {
    if (request->sink) {
      request->sink->error(request->sink_ctx, NULL);
      free(request);
      continue;
    }
    sf_type_error(message);
    scr_promise_reject_pending(request->promise);
    scr_promise_release(request->promise);
    free(request);
  }
}

static void sf_reader_release(SfReader *r) {
  if (!r || --r->rc > 0) return;
  sf_reader_reject_message_all(r, "ReadableStream was released");
  scr_promise_release(r->closed);
  free(r);
}

static void sf_chunk_release(SfChunk *c) {
  if (!c) return;
  scr_dyn_release(c->value);
  free(c);
}

static void sf_stream_drop_chunks(SfStream *s) {
  while (s->head) {
    SfChunk *c = s->head;
    s->head = c->next;
    sf_chunk_release(c);
  }
  s->tail = NULL;
  s->queued = 0;
}

static void sf_inflate_finish_if_ended(SfTransfer *t);

/*
 * The live transfer owns one stream reference. When every user-visible
 * Response/body/reader/collector reference is gone, only that transfer
 * reference remains. Stop queueing at that point and drain the wire so a
 * paused unread response cannot keep the process alive forever.
 *
 * A pending read remains a consumer even if its reader handle was dropped:
 * fulfill that request first, then reconsider from sf_stream_drain().
 */
static void sf_response_discard_if_unobserved(SfStream *s) {
  if (s->rc != 1 || s->discarded || !s->response_owner ||
      s->collector || (s->reader && s->reader->pending_head)) {
    return;
  }
  s->discarded = true;
  sf_stream_drop_chunks(s);
  SfTransfer *t = s->response_owner;
  scr_bytes_release(t->inflate_pending);
  t->inflate_pending = NULL;
  t->inflate_needs_drain = false;
  if (!t->inflate_draining) {
    t->zs.next_in = Z_NULL;
    t->zs.avail_in = 0;
  }
  /*
   * EOF may already have arrived while the decoded high-water-mark chunk
   * kept sf_inflate_finish_if_ended() from settling. Dropping that last
   * chunk removes the only remaining blocker. Finish before attempting to
   * resume an already-ended socket; settlement may release both t and s.
   */
  if (t->response_ended) {
    sf_inflate_finish_if_ended(t);
    return;
  }
  if (!t->done && t->response_paused && t->response_socket) {
    t->response_paused = false;
    scr_net_sock_release(scr_net_sock_resume(t->response_socket));
  }
}

static void sf_stream_drop_source_callbacks(
    SfStream *s, bool include_cancel) {
  ScrDyn *pull = s->pull_cb;
  ScrDyn *cancel = include_cancel ? s->cancel_cb : NULL;
  ScrDyn *source_this = NULL;
  s->pull_cb = NULL;
  if (include_cancel) s->cancel_cb = NULL;
  if (!s->pull_cb && !s->cancel_cb) {
    source_this = s->source_this;
    s->source_this = NULL;
    sf_stream_untrack_callbacks(s);
  }
  /* Unlink both edges before either closure release can re-enter through a
   * captured stream handle. */
  scr_dyn_release(pull);
  scr_dyn_release(cancel);
  scr_dyn_release(source_this);
}

static void sf_stream_release(SfStream *s) {
  if (!s) return;
  if (--s->rc > 0) {
#ifdef SCR_HANDLE_CLASSES
    /* Only the web view's source still holds the stream, with the transfer
     * that fills it while the response runs: the view no longer needs to be
     * found from it, and the view, which reads it, keeps it while anything
     * else holds the view. A view nothing else holds releases its source,
     * and the stream then takes the unobserved-response discard below. */
    if (s->rc == (s->response_owner ? 2u : 1u) && s->view_source_live && s->web_view) {
      ScrDyn *view = s->web_view, *lock = s->web_view_lock;
      s->web_view = s->web_view_lock = NULL;
      scr_dyn_release(lock);
      scr_dyn_release(view); /* may release s */
      return;
    }
#endif
    sf_response_discard_if_unobserved(s);
    return;
  }
  scr_weak_dispose_inline(s);
  sf_stream_drop_chunks(s);
  if (s->reader) {
    s->reader->stream = NULL;
    sf_reader_reject_message_all(s->reader, "ReadableStream was released");
    sf_reader_release(s->reader);
    s->reader = NULL;
  }
  scr_dyn_release(s->error);
  sf_stream_drop_source_callbacks(s, true);
  scr_dyn_release(s->from_dyn);
#ifdef SCR_HANDLE_CLASSES
  scr_dyn_release(s->web_reader);
  scr_dyn_release(s->web_view_lock);
  scr_dyn_release(s->web_view);
#endif
  scr_arr_release(s->from_array);
  scr_bytes_release(s->from_bytes);
  scr_str_release(s->from_string);
  while (s->typed_refs) {
    SfTypedRef *ref = s->typed_refs;
    s->typed_refs = ref->next;
    scr_dyn_release(ref->value);
    free(ref);
  }
  free(s);
}

static void *sf_stream_retain_v(void *p) {
  return sf_stream_retain((SfStream *)p);
}
static void sf_stream_release_v(void *p) {
  sf_stream_release((SfStream *)p);
}

/*
 * The stream owns its active reader so the lock survives loss of the
 * user-visible reader box. Conversely, every reader HANDLE retains the
 * stream while the lock is live. Keeping those two ownership classes
 * distinct avoids a permanent stream↔reader cycle while making chained
 * expressions such as `new ReadableStream(...).getReader()` safe.
 */
static void *sf_reader_handle_retain_v(void *p) {
  SfReader *r = p;
  sf_reader_retain(r);
  r->handle_refs++;
  if (r->stream) sf_stream_retain(r->stream);
  return r;
}

static void sf_reader_handle_release_v(void *p) {
  SfReader *r = p;
  SfStream *stream = r->stream;
  if (r->handle_refs > 0) r->handle_refs--;
  sf_reader_release(r);
  sf_stream_release(stream);
}

static ScrBytes *sf_chunk_bytes(const ScrDyn *chunk) {
  if (chunk && chunk->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(chunk);
    ScrBytes *bytes = sf_chunk_bytes(materialized);
    scr_dyn_release(materialized);
    return bytes;
  }
  if (chunk && scr_dyn_bytes_is(chunk, SCR_BYTES_U8)) {
    return scr_bytes_copy(chunk->v.bytes);
  }
  if (chunk && chunk->kind == SCR_DYN_STR) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)chunk->v.str->len);
    memcpy(b->data, chunk->v.str->data, chunk->v.str->len);
    if (!chunk->v.str->ascii) scr_wtf8_to_utf8((char *)b->data, chunk->v.str->len);
    return b;
  }
  sf_type_error("ReadableStream chunks must be Uint8Array or string values");
  return NULL;
}

static ScrDyn *sf_read_result(bool done, ScrDyn *value) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5,
                  value ? scr_dyn_retain(value)
                        : scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

static void sf_reader_fulfill_one(SfReader *r, bool done, ScrDyn *value) {
  if (!r) return;
  SfReadRequest *request = sf_reader_take_request(r);
  if (!request) return;
  if (request->sink) {
    if (done) request->sink->close(request->sink_ctx);
    else request->sink->chunk(request->sink_ctx, value);
    free(request);
    return;
  }
  scr_promise_fulfill_ref(request->promise, sf_read_result(done, value),
                          &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_promise_release(request->promise);
  free(request);
}

static void sf_reader_reject_all(SfReader *r, ScrDyn *reason) {
  if (!r) return;
  SfReadRequest *request;
  while ((request = sf_reader_take_request(r)) != NULL) {
    if (request->sink) {
      request->sink->error(request->sink_ctx, reason);
      free(request);
      continue;
    }
    sf_reject_promise_reason(request->promise, reason);
    scr_promise_release(request->promise);
    free(request);
  }
}

static void sf_collector_append(SfCollector *c, const ScrBytes *bytes) {
  if (bytes->len == 0) return;
  if (c->len > SIZE_MAX - bytes->len) sf_oom();
  size_t need = c->len + bytes->len;
  if (need > c->cap) {
    size_t cap = c->cap ? c->cap : 4096;
    while (cap < need) {
      if (cap > SIZE_MAX / 2) {
        cap = need;
        break;
      }
      cap *= 2;
    }
    char *next = realloc(c->data, cap);
    if (!next) sf_oom();
    c->data = next;
    c->cap = cap;
  }
  scr_bytes_read(bytes, 0, c->data + c->len, bytes->len);
  c->len = need;
}

static void sf_collector_drop(SfStream *s) {
  SfCollector *c = s->collector;
  if (!c) return;
  s->collector = NULL;
  /*
   * Body-mixin consumption acquires a reader that is never exposed or
   * released. Keep that lock after text()/json()/bytes() settles: Node
   * reports response.body.locked === true and rejects a later getReader(),
   * on both fulfillment and rejection.
   */
  scr_promise_release(c->promise);
  free(c->data);
  SfStream *held = c->held_stream;
  free(c);
  sf_stream_release(held);
}

static void sf_collector_finish(SfStream *s) {
  SfCollector *c = s->collector;
  if (!c) return;
  ScrDyn *value = NULL;
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)c->len);
  if (c->len) memcpy(bytes->data, c->data, c->len);
  if (c->mode == SF_COLLECT_JSON) {
    ScrStr *text = scr_text_decode(bytes);
    value = scr_json_parse(text);
    scr_str_release(text);
  } else if (c->mode == SF_COLLECT_TEXT) {
    ScrStr *text = scr_text_decode(bytes);
    value = scr_dyn_new_str(text);
    scr_str_release(text);
  } else if (c->mode == SF_COLLECT_ARRAY_BUFFER) {
    value = scr_array_buffer_from_bytes(bytes);
  } else {
    value = scr_dyn_new_bytes(bytes);
  }
  scr_bytes_release(bytes);
  if (scr_exc_pending()) {
    scr_dyn_release(value);
    scr_promise_reject_pending(c->promise);
  } else {
    scr_promise_fulfill_ref(c->promise, value, &scr_dyn_retain_v,
                            &scr_dyn_release_v, NULL);
  }
  sf_collector_drop(s);
}

static void sf_collector_reject(SfStream *s, ScrDyn *reason) {
  if (!s->collector) return;
  sf_reject_promise_reason(s->collector->promise, reason);
  sf_collector_drop(s);
}

static void sf_stream_request_flush(SfStream *s);
static void sf_transfer_stream_error(SfTransfer *t, ScrDyn *reason);
static void sf_settle(SfTransfer *t);
static SfTransfer *sf_retain(SfTransfer *t);
static void sf_release(SfTransfer *t);
static void sf_inflate_resume(SfTransfer *t);
static void sf_stream_pull(SfStream *s);
static void sf_stream_schedule_initial_pull(SfStream *s);

/*
 * A default ReadableStream has a one-chunk high-water mark. Apply that
 * bound to the transport itself: pausing the IncomingMessage only moves
 * bytes into its parser-side buffer, while pausing the socket leaves them
 * in the kernel/TCP window. resume() merely re-arms the poller, so calling
 * it while satisfying a read never re-enters this stack.
 */
static void sf_response_pause_if_full(SfStream *s) {
  SfTransfer *t = s->response_owner;
  if (s->discarded || !t || t->done || t->response_paused ||
      !t->response_socket ||
      s->queued < 1) {
    return;
  }
  t->response_paused = true;
  scr_net_sock_release(scr_net_sock_pause(t->response_socket));
}

static void sf_response_resume_if_ready(SfStream *s) {
  SfTransfer *t = s->response_owner;
  if (!t || t->done || s->queued >= 1 || s->close_requested || s->closed ||
      s->error || t->inflate_draining) {
    return;
  }
  /* Compressed input or decoder output still buffered drains on demand:
   * while the socket is paused, and after 'end', when the transfer no
   * longer holds the socket and no more data arrives. */
  if (t->inflating && (t->inflate_pending || t->inflate_needs_drain) &&
      (t->response_paused || t->response_ended)) {
    sf_inflate_resume(t);
    return;
  }
  if (!t->response_paused || !t->response_socket) return;
  t->response_paused = false;
  scr_net_sock_release(scr_net_sock_resume(t->response_socket));
}

static void sf_stream_finish_close(SfStream *s) {
  if (!s->close_requested || s->head || s->closed || s->error) return;
  s->closed = true;
  sf_stream_drop_source_callbacks(s, true);
  if (s->reader) scr_promise_fulfill_void(s->reader->closed);
}

static void sf_stream_drain(SfStream *s) {
  if (s->request_owner) {
    sf_stream_request_flush(s);
    return;
  }
  if (s->request_discarding) {
    /* Fetch keeps a reader attached to an upload body after aborting the
     * transfer. Its chunks are no longer written, but demand continues
     * until the source closes/errors; notably, source.cancel is not run. */
    sf_stream_drop_chunks(s);
    sf_stream_finish_close(s);
    return;
  }
  if (s->collector) {
    while (s->head) {
      SfChunk *c = s->head;
      s->head = c->next;
      if (!s->head) s->tail = NULL;
      s->queued--;
#ifdef SCR_HANDLE_CLASSES
      ScrBytes *bytes;
      /* A body read from a JavaScript ReadableStream, or from a clone or
       * tee branch of one, takes Uint8Array chunks only, as Node's body
       * mixin does. */
      if (s->u8_chunks && !scr_dyn_bytes_is(c->value, SCR_BYTES_U8)) {
        sf_type_error("Received non-Uint8Array chunk");
        bytes = NULL;
      } else {
        bytes = sf_chunk_bytes(c->value);
      }
#else
      ScrBytes *bytes = sf_chunk_bytes(c->value);
#endif
      if (!bytes) {
        sf_chunk_release(c);
        scr_promise_reject_pending(s->collector->promise);
        sf_collector_drop(s);
        sf_stream_drop_chunks(s);
        return;
      }
      sf_collector_append(s->collector, bytes);
      scr_bytes_release(bytes);
      sf_chunk_release(c);
    }
    sf_stream_finish_close(s);
    sf_response_resume_if_ready(s);
    if (s->error) sf_collector_reject(s, s->error);
    else if (s->closed) sf_collector_finish(s);
    return;
  }
  if (s->reader) {
    bool dequeued = false;
    while (s->reader->pending_head && s->head) {
      SfChunk *c = s->head;
      s->head = c->next;
      if (!s->head) s->tail = NULL;
      s->queued--;
      dequeued = true;
      sf_reader_fulfill_one(s->reader, false, c->value);
      sf_chunk_release(c);
    }
    sf_stream_finish_close(s);
    if (s->error) {
      sf_reader_reject_all(s->reader, s->error);
    } else if (s->closed) {
      while (s->reader->pending_head) {
        sf_reader_fulfill_one(s->reader, true, NULL);
      }
    }
    /* Consuming the last queued chunk raises desiredSize above zero even
     * when no read request remains. That transition is fresh demand and
     * must replenish the queue up to its default high-water mark. */
    if (dequeued && !s->enqueue_draining && !s->head &&
        !s->close_requested && !s->closed && !s->error) {
      sf_stream_pull(s);
    }
    sf_response_resume_if_ready(s);
    sf_response_discard_if_unobserved(s);
    return;
  }
  sf_stream_finish_close(s);
  sf_response_resume_if_ready(s);
}

static void sf_stream_enqueue_value(SfStream *s, ScrDyn *value) {
  if (s->close_requested || s->closed || s->error) {
    sf_type_error("Invalid state: the ReadableStream is already closed");
    return;
  }
  SfChunk *c = calloc(1, sizeof *c);
  if (!c) sf_oom();
  ScrDyn *stored = value;
  if (value->kind == SCR_DYN_TYPED_REF) {
    for (SfTypedRef **at = &s->typed_refs; *at;) {
      SfTypedRef *ref = *at;
      /* A typed ReadableStream.from(array) retains the source array for the
       * stream's lifetime, so a source object can recur after an arbitrary
       * number of pulls and must still denote the same JS object. Keep its
       * capsule as long as that source is live. Callback-fed streams have no
       * such bounded owner; drop an otherwise-unobserved capsule there so a
       * long-running producer does not retain every object it ever emitted. */
      if (!s->from_array && ref->value->rc == 1) {
        *at = ref->next;
        scr_dyn_release(ref->value);
        free(ref);
        continue;
      }
      if (scr_dyn_strict_eq(ref->value, value)) {
        stored = ref->value;
        break;
      }
      at = &ref->next;
    }
    if (stored == value) {
      SfTypedRef *ref = malloc(sizeof *ref);
      if (!ref) sf_oom();
      ref->value = scr_dyn_retain(value);
      ref->next = s->typed_refs;
      s->typed_refs = ref;
    }
  }
  c->value = scr_dyn_retain(stored);
  if (s->tail) s->tail->next = c;
  else s->head = c;
  s->tail = c;
  s->queued++;
  bool was_enqueue_draining = s->enqueue_draining;
  s->enqueue_draining = true;
  sf_stream_drain(s);
  s->enqueue_draining = was_enqueue_draining;
  /* Enqueue is the event that can create fresh demand after a deferred
   * pull. Merely having a waiting reader/request is not: looping on that
   * state re-enters pull synchronously and starves timers. */
  if (
    s->started &&
    !s->close_requested &&
    !s->closed &&
    !s->error &&
    (s->request_owner || s->request_discarding ||
     (s->reader && s->reader->pending_head) || !s->head)
  ) {
    sf_stream_pull(s);
  }
  sf_response_pause_if_full(s);
}

static void sf_stream_enqueue_bytes(SfStream *s, ScrBytes *bytes) {
  ScrDyn *value = scr_dyn_new_bytes(bytes);
  sf_stream_enqueue_value(s, value);
  scr_dyn_release(value);
}

static void sf_stream_close(SfStream *s) {
  if (s->close_requested || s->closed || s->error) return;
  s->close_requested = true;
  /* pull can never run again once close is requested. Keep cancel until
   * the queued tail drains because cancel() may still invoke it. */
  sf_stream_drop_source_callbacks(s, false);
  sf_stream_drain(s);
  sf_stream_finish_close(s);
}

static void sf_stream_error(SfStream *s, ScrDyn *reason) {
  if (s->closed || s->error) return;
  s->error = scr_dyn_retain(reason);
  sf_stream_drop_chunks(s);
  sf_stream_drain(s);
  if (s->reader) {
    sf_reject_promise_reason(s->reader->closed, reason);
  }
  if (s->error_watch) s->error_watch(s->error_watch_ctx, reason);
  if (s->request_owner) {
    sf_transfer_stream_error(s->request_owner, reason);
  }
  sf_stream_drop_source_callbacks(s, true);
}

/* Web Streams adopts promise-like results from start/pull/cancel through
 * PromiseResolve, not merely native Promise instances. Keep that adoption
 * local to this surface: the checked-dynamic language intentionally does
 * not otherwise assimilate arbitrary objects carrying a `then` member. */
static SfThenState *sf_then_state_retain(SfThenState *state) {
  state->rc++;
  return state;
}

static void sf_then_state_release(SfThenState *state) {
  if (--state->rc > 0) return;
  scr_promise_release(state->promise);
  free(state);
}

static void *sf_then_state_retain_v(void *ptr) {
  return sf_then_state_retain((SfThenState *)ptr);
}

static void sf_then_state_release_v(void *ptr) {
  sf_then_state_release((SfThenState *)ptr);
}

static ScrBox *sf_then_state_box(SfThenState *state) {
  ScrBox *box = scr_box_new_obj(
      &sf_then_state_retain_v, &sf_then_state_release_v, NULL);
  scr_box_set_ref(box, sf_then_state_retain(state));
  return box;
}

static void sf_then_adopt(ScrPromise *target, ScrDyn *value);

static ScrDyn *sf_then_resolve_thunk(
    ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  SfThenState *state = (SfThenState *)scr_box_get_ref(cb->caps[0]);
  if (!state->called) {
    state->called = true;
    sf_then_adopt(
        state->promise, argc ? args[0] : scr_dyn_undefined());
  }
  sf_then_state_release(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sf_then_reject_thunk(
    ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  SfThenState *state = (SfThenState *)scr_box_get_ref(cb->caps[0]);
  if (!state->called) {
    state->called = true;
    sf_reject_promise_reason(
        state->promise, argc ? args[0] : scr_dyn_undefined());
  }
  sf_then_state_release(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static void sf_then_call_task(ScrClosure *cb) {
  SfThenState *state = (SfThenState *)scr_box_get_ref(cb->caps[0]);
  ScrDyn *thenable = (ScrDyn *)scr_box_get_ref(cb->caps[1]);
  ScrDyn *then_fn = (ScrDyn *)scr_box_get_ref(cb->caps[2]);

  ScrClosure *resolve_cb =
      scr_closure_new((void *)&sf_then_resolve_thunk, 1);
  resolve_cb->caps[0] = sf_then_state_box(state);
  ScrDyn *resolve = scr_dyn_new_func(
      resolve_cb, &sf_then_resolve_thunk, 1, "(value)", "resolve");

  ScrClosure *reject_cb =
      scr_closure_new((void *)&sf_then_reject_thunk, 1);
  reject_cb->caps[0] = sf_then_state_box(state);
  ScrDyn *reject = scr_dyn_new_func(
      reject_cb, &sf_then_reject_thunk, 1, "(reason)", "reject");

  ScrDyn *args[2] = {resolve, reject};
  scr_dyn_this_push_dyn(thenable);
  ScrDyn *result =
      scr_dyn_call(then_fn, args, 2, "thenable.then");
  scr_dyn_this_pop();
  if (result) {
    scr_dyn_release(result);
  } else if (!state->called) {
    state->called = true;
    scr_promise_reject_pending(state->promise);
  } else {
    /* A throw after either resolving function ran is ignored. */
    scr_exc_clear();
  }

  scr_dyn_release(resolve);
  scr_dyn_release(reject);
  scr_dyn_release(then_fn);
  scr_dyn_release(thenable);
  sf_then_state_release(state);
}

static void sf_then_schedule(
    ScrPromise *target, ScrDyn *thenable, ScrDyn *then_fn) {
  SfThenState *state = calloc(1, sizeof *state);
  if (!state) sf_oom();
  state->rc = 1;
  state->promise = scr_promise_retain(target);

  ScrClosure *task =
      scr_closure_new((void *)&sf_then_call_task, 3);
  task->caps[0] = sf_then_state_box(state);
  task->caps[1] =
      scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(task->caps[1], scr_dyn_retain(thenable));
  task->caps[2] =
      scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(task->caps[2], scr_dyn_retain(then_fn));
  sf_then_state_release(state);
  scr_queue_microtask(task);
}

static void sf_then_adopt(ScrPromise *target, ScrDyn *value) {
  if (value->kind == SCR_DYN_PROMISE) {
    scr_promise_race_add(
        target, value->v.promise, &scr_promise_adapt_copy);
    return;
  }
  if (value->kind == SCR_DYN_OBJ) {
    const ScrDyn *then_fn = scr_dyn_obj_get(value, "then", 4);
    if (then_fn && then_fn->kind == SCR_DYN_FUNC) {
      sf_then_schedule(target, value, (ScrDyn *)then_fn);
      return;
    }
  }
  scr_promise_fulfill_ref(
      target, scr_dyn_retain(value), &scr_dyn_retain_v,
      &scr_dyn_release_v, NULL);
}

/* +1 when the callback result must be awaited; NULL for a plain value. */
static ScrPromise *sf_stream_callback_promise(ScrDyn *value) {
  if (value->kind == SCR_DYN_PROMISE) {
    return scr_promise_retain(value->v.promise);
  }
  if (value->kind != SCR_DYN_OBJ) return NULL;
  const ScrDyn *then_fn = scr_dyn_obj_get(value, "then", 4);
  if (!then_fn || then_fn->kind != SCR_DYN_FUNC) return NULL;
  ScrPromise *promise = scr_promise_new();
  sf_then_schedule(promise, value, (ScrDyn *)then_fn);
  return promise;
}

static void sf_stream_pull_wait_entry(ScrFiber *self, void *arg) {
  (void)self;
  SfPullWait *wait = arg;
  SfStream *s = wait->stream;
  ScrDyn *value = scr_await_dyn(wait->promise);
  bool rejected = scr_exc_pending();
  ScrCaught *caught = rejected ? scr_exc_take() : NULL;
  scr_dyn_release(value);
  scr_promise_release(wait->promise);
  free(wait);

  s->pulling = false;
  if (rejected) {
    s->pull_again = false;
    ScrDyn *reason = scr_caught_to_dyn(caught);
    sf_stream_error(s, reason);
    scr_dyn_release(reason);
  } else {
    bool again = s->pull_again;
    s->pull_again = false;
    if (again && !s->close_requested && !s->closed && !s->error) {
      sf_stream_pull(s);
    }
  }
  scr_caught_release(caught);
  sf_stream_release(s);
}

static void sf_stream_start_wait_entry(ScrFiber *self, void *arg) {
  (void)self;
  SfStartWait *wait = arg;
  SfStream *s = wait->stream;
  ScrDyn *value = scr_await_dyn(wait->promise);
  bool rejected = scr_exc_pending();
  ScrCaught *caught = rejected ? scr_exc_take() : NULL;
  scr_dyn_release(value);
  scr_promise_release(wait->promise);
  free(wait);

  if (rejected) {
    ScrDyn *reason = scr_caught_to_dyn(caught);
    sf_stream_error(s, reason);
    scr_dyn_release(reason);
  } else {
    s->started = true;
    sf_stream_drain(s);
    if (!s->close_requested && !s->closed && !s->error &&
        s->queued == 0) {
      sf_stream_pull(s);
      sf_stream_drain(s);
    }
  }
  scr_caught_release(caught);
  sf_stream_release(s);
}

static ScrDyn *sf_controller_box(SfStream *s) {
  return scr_dyn_new_handle(s, SCR_DYNH_WEB_CONTROLLER);
}

static bool sf_stream_has_from_source(const SfStream *s) {
#ifdef SCR_HANDLE_CLASSES
  if (s->web_reader) return true;
#endif
  return s->from_dyn || s->from_array || s->from_bytes || s->from_string;
}

/* A Response, Request or fetch body of a ReadableStream: the fetch unit's
 * own streams, and in the build that programs with JavaScript web streams
 * link (SCR_HANDLE_CLASSES), theirs. */
static bool sf_is_stream_body(const ScrDyn *body) {
  if (body->kind != SCR_DYN_HANDLE) return false;
#ifdef SCR_HANDLE_CLASSES
  if (body->v.handle.tag == SCR_DYNH_WS_READABLE) return true;
#endif
  return body->v.handle.tag == SCR_DYNH_WEB_STREAM;
}

#ifdef SCR_HANDLE_CLASSES
static void sf_stream_schedule_pull_complete(SfStream *s);

/* The web stream reader's answer to one pull. */
static void sf_web_chunk(void *ctx, ScrDyn *chunk) {
  SfStream *s = ctx;
  if (!s->close_requested && !s->closed && !s->error) {
    sf_stream_enqueue_value(s, chunk);
    sf_stream_drain(s);
  }
  sf_stream_schedule_pull_complete(s);
  sf_stream_release(s);
}

static void sf_web_close(void *ctx) {
  SfStream *s = ctx;
  s->pulling = false;
  sf_stream_close(s);
  sf_stream_release(s);
}

static void sf_web_error(void *ctx, ScrDyn *reason) {
  SfStream *s = ctx;
  s->pulling = false;
  sf_stream_error(s, reason ? reason : scr_dyn_undefined());
  sf_stream_release(s);
}

static const ScrFetchReadSink sf_web_sink = {sf_web_chunk, sf_web_close, sf_web_error};

static void sf_stream_pull_from_web(SfStream *s) {
  s->pulling = true;
  sf_stream_retain(s);
  if (!scr_web_stream_bridge->reader_read_into(s->web_reader, &sf_web_sink, s)) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *reason = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    sf_web_error(s, reason);
    scr_dyn_release(reason);
  }
}

/* A body from a checked-dynamic web ReadableStream (borrowed): a native
 * stream that reads it (+1 handle), or NULL with the TypeError pending
 * for one that is locked or disturbed. */
static ScrDyn *sf_web_body(const ScrDyn *body) {
  if (!scr_web_stream_bridge || scr_web_stream_bridge->unusable(body)) {
    sf_type_error("Response body object should not be disturbed or locked");
    return NULL;
  }
  ScrDyn *reader = scr_dyn_invoke((ScrDyn *)body, "getReader", NULL, 0, "ReadableStream.getReader");
  if (!reader) return NULL;
  SfStream *s = sf_stream_new_native();
  s->web_reader = reader;
  s->u8_chunks = true;
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  return out;
}

static bool sf_is_web_body(const ScrDyn *body) {
  return body && body->kind == SCR_DYN_HANDLE && body->v.handle.tag == SCR_DYNH_WS_READABLE;
}

static SfReader *sf_stream_get_reader(SfStream *s);
static bool sf_reader_read_request(SfReader *r, ScrPromise *p, const ScrFetchReadSink *sink, void *sink_ctx);
static ScrPromise *sf_stream_cancel(SfStream *s, ScrDyn *reason, bool through_reader);

/* The web view's source (scr_webstream_readable_over): it reads the stream
 * through a reader of its own, taken at the first pull. */
static bool sf_view_read_into(void *ctx, const ScrFetchReadSink *sink, void *sink_ctx) {
  SfStream *s = ctx;
  if (!s->view_reader) {
    SfReader *r = sf_stream_get_reader(s);
    if (!r) return false;
    s->view_reader = r; /* the stream owns it as its reader */
    sf_reader_release(r);
  }
  /* A chunk the request takes at once can close the view, whose source
   * then lets the stream go while it still drains. */
  sf_stream_retain(s);
  bool ok = sf_reader_read_request(s->view_reader, NULL, sink, sink_ctx);
  sf_stream_release(s);
  return ok;
}

static ScrPromise *sf_view_cancel(void *ctx, ScrDyn *reason) {
  SfStream *s = ctx;
  return sf_stream_cancel(s, reason, s->view_reader != NULL && s->reader == s->view_reader);
}

static void sf_view_release(void *ctx) {
  SfStream *s = ctx;
  s->view_source_live = false;
  sf_stream_release(s);
}

static const ScrWebStreamSource sf_view_source = {sf_view_read_into, sf_view_cancel, sf_view_release};

/* The web ReadableStream the stream's checked-dynamic handles stand for
 * (borrowed), made on first use. Node's Response.body is one; the fetch
 * stream answers getReader, cancel and locked itself until a member it
 * lacks is used, and a lock it holds then keeps the view locked. */
static ScrDyn *sf_stream_web_view(SfStream *s) {
  if (s->web_view) return s->web_view;
  s->web_view = scr_webstream_readable_over(&sf_view_source, sf_stream_retain(s));
  s->view_source_live = true;
  if (s->reader || s->internal_lock) {
    s->web_view_lock = scr_dyn_invoke(s->web_view, "getReader", NULL, 0, "ReadableStream.getReader");
    if (!s->web_view_lock) return NULL;
  }
  return s->web_view;
}

/* Whether `key` names one of the fetch stream's own methods (its ops'
 * method table). */
static bool sf_stream_own_method(const char *key, size_t len) {
  ScrDyn probe;
  memset(&probe, 0, sizeof probe);
  probe.kind = SCR_DYN_HANDLE;
  probe.v.handle.tag = SCR_DYNH_WEB_STREAM;
  for (const ScrDynHandleMethod *m = scr_dyn_handle_ops_of(&probe)->methods; m && m->name; m++)
    if (sf_name(key, len, m->name)) return true;
  return false;
}

/* scr_dyn_handle_class_alias_view for the stream's handles (+1). */
static ScrDyn *sf_stream_view_of(ScrDyn *handle) {
  ScrDyn *view = sf_stream_web_view((SfStream *)handle->v.handle.ptr);
  return view ? scr_dyn_retain(view) : NULL;
}

/* A body whose stream has a web view is read through the view, which
 * locks it as reading a body locks Node's stream: a native stream that
 * reads the view (+1), or NULL with the TypeError pending. Otherwise the
 * stream itself (+1). */
static SfStream *sf_stream_body_source(SfStream *s) {
  if (!s->web_view) return sf_stream_retain(s);
  ScrDyn *reading = sf_web_body(s->web_view);
  if (!reading) return NULL;
  SfStream *out = sf_stream_retain((SfStream *)reading->v.handle.ptr);
  scr_dyn_release(reading);
  return out;
}
#endif

/* Whether a body's web view is locked or disturbed, which makes the body
 * unusable as one, as its own lock and disturbed state do. */
#ifdef SCR_HANDLE_CLASSES
static bool sf_view_unusable(const SfStream *s) {
  return s->web_view && scr_web_stream_bridge->unusable(s->web_view);
}
#else
#define sf_view_unusable(s) false
#endif

static void sf_stream_pull_from_source(SfStream *s) {
  ScrDyn *value = NULL;
  if (s->from_array) {
    if (s->from_index >= scr_arr_len(s->from_array)) {
      sf_stream_close(s);
      return;
    }
    value = s->from_array_item(s->from_array, s->from_index++);
  } else if (s->from_bytes) {
    if (s->from_index >= scr_bytes_len(s->from_bytes)) {
      sf_stream_close(s);
      return;
    }
    value = scr_dyn_new_num(
        scr_bytes_get(s->from_bytes, s->from_index++));
  } else if (s->from_string) {
    double len = scr_str_utf16_len(s->from_string);
    if (s->from_index >= len) {
      sf_stream_close(s);
      return;
    }
    ScrStr *cp = scr_str_cp_at(s->from_string, s->from_index);
    s->from_index += scr_str_utf16_len(cp);
    value = scr_dyn_new_str(cp);
    scr_str_release(cp);
  } else if (s->from_dyn->kind == SCR_DYN_ARR) {
    if (s->from_index >= (double)s->from_dyn->v.arr.len) {
      sf_stream_close(s);
      return;
    }
    value = scr_dyn_retain(
        s->from_dyn->v.arr.items[(size_t)s->from_index++]);
  } else if (s->from_dyn->kind == SCR_DYN_BYTES) {
    if (s->from_index >= scr_bytes_len(s->from_dyn->v.bytes)) {
      sf_stream_close(s);
      return;
    }
    value = scr_dyn_new_num(
        scr_bytes_get(s->from_dyn->v.bytes, s->from_index++));
  } else {
    double len = scr_str_utf16_len(s->from_dyn->v.str);
    if (s->from_index >= len) {
      sf_stream_close(s);
      return;
    }
    ScrStr *cp = scr_str_cp_at(s->from_dyn->v.str, s->from_index);
    s->from_index += scr_str_utf16_len(cp);
    value = scr_dyn_new_str(cp);
    scr_str_release(cp);
  }
  sf_stream_enqueue_value(s, value);
  scr_dyn_release(value);
}

static void sf_stream_initial_pull_task(ScrClosure *cb) {
  SfStream *s = (SfStream *)scr_box_get_ref(cb->caps[0]);
  if (!s) return;
  s->initial_pull_pending = false;
  if (s->started && !s->close_requested && !s->closed && !s->error &&
      s->queued == 0) {
    sf_stream_pull(s);
    sf_stream_drain(s);
  }
  sf_stream_release(s);
}

static void sf_stream_schedule_initial_pull(SfStream *s) {
  if ((!s->pull_cb && !sf_stream_has_from_source(s)) ||
      s->initial_pull_pending || s->close_requested || s->closed ||
      s->error) {
    return;
  }
  s->initial_pull_pending = true;
  ScrClosure *cb =
      scr_closure_new((void *)&sf_stream_initial_pull_task, 1);
  ScrBox *box =
      scr_box_new_obj(&sf_stream_retain_v, &sf_stream_release_v, NULL);
  scr_box_set_ref(box, sf_stream_retain(s));
  cb->caps[0] = box;
  scr_queue_microtask(cb);
}

/* Web Streams wraps an underlying source's plain pull return in a resolved
 * promise. Its fulfillment step therefore runs as a promise job, never in
 * the pull callback's stack. In particular, enqueueing into a pending read
 * wakes that read's awaiter before a desiredSize-driven repull: the awaiter
 * can cancel or release the reader first. Keep pulling=true through this
 * microtask so demand raised by enqueue/read records pull_again exactly as
 * it does while awaiting a genuinely asynchronous pull result. */
static void sf_stream_pull_complete_task(ScrClosure *cb) {
  SfStream *s = (SfStream *)scr_box_get_ref(cb->caps[0]);
  if (!s) return;
  s->pulling = false;
  bool again = s->pull_again;
  s->pull_again = false;
  if (again && !s->close_requested && !s->closed && !s->error) {
    sf_stream_pull(s);
  }
  sf_stream_release(s);
}

static void sf_stream_schedule_pull_complete(SfStream *s) {
  ScrClosure *cb =
      scr_closure_new((void *)&sf_stream_pull_complete_task, 1);
  ScrBox *box =
      scr_box_new_obj(&sf_stream_retain_v, &sf_stream_release_v, NULL);
  scr_box_set_ref(box, sf_stream_retain(s));
  cb->caps[0] = box;
  scr_queue_microtask(cb);
}

/* A consumer waiting for the stream's next chunk: a pending read, a body
 * collector, or a fetch upload (fetch keeps reading the request body,
 * including after an aborted transfer stops writing it). */
static bool sf_stream_has_consumer(const SfStream *s) {
  return s->collector || (s->reader && s->reader->pending_head) || s->request_owner ||
         s->request_discarding;
}

static void sf_stream_pull(SfStream *s) {
  if (!s->started ||
      (!s->pull_cb && !sf_stream_has_from_source(s)) ||
      s->initial_pull_pending || s->close_requested || s->closed ||
      s->error) {
    return;
  }
  /* ReadableStreamDefaultControllerShouldCallPull: with no room in the
   * queue, only a consumer asks for a chunk: a pending read, a body
   * collector, or a fetch upload, whose reader is always waiting. */
  if (s->hwm_zero && !sf_stream_has_consumer(s)) return;
  if (s->pulling) {
    s->pull_again = true;
    return;
  }
#ifdef SCR_HANDLE_CLASSES
  if (s->web_reader) {
    sf_stream_pull_from_web(s);
    return;
  }
#endif
  if (sf_stream_has_from_source(s)) {
    s->pulling = true;
    sf_stream_pull_from_source(s);
    sf_stream_schedule_pull_complete(s);
    return;
  }
  s->pulling = true;
  ScrDyn *controller = sf_controller_box(s);
  ScrDyn *args[1] = {controller};
  ScrDyn *pull_cb = scr_dyn_retain(s->pull_cb);
  scr_dyn_this_push_dyn(s->source_this);
  ScrDyn *r =
      scr_dyn_call(pull_cb, args, 1, "underlyingSource.pull");
  scr_dyn_this_pop();
  scr_dyn_release(pull_cb);
  scr_dyn_release(controller);
  if (!r) {
    s->pulling = false;
    s->pull_again = false;
    ScrCaught *caught = scr_exc_take();
    ScrDyn *reason = scr_caught_to_dyn(caught);
    sf_stream_error(s, reason);
    scr_dyn_release(reason);
    scr_caught_release(caught);
    return;
  }
  ScrPromise *callback_promise = sf_stream_callback_promise(r);
  if (callback_promise) {
    SfPullWait *wait = malloc(sizeof *wait);
    if (!wait) sf_oom();
    wait->stream = sf_stream_retain(s);
    wait->promise = callback_promise;
    ScrPromise *watcher =
        scr_async_spawn(&sf_stream_pull_wait_entry, wait);
    scr_promise_release(watcher);
    scr_dyn_release(r);
    return;
  }
  scr_dyn_release(r);
  sf_stream_schedule_pull_complete(s);
}

static SfReader *sf_stream_get_reader(SfStream *s) {
  if (s->reader || s->internal_lock) {
    sf_type_error("Invalid state: ReadableStream is locked");
    return NULL;
  }
  SfReader *r = calloc(1, sizeof *r);
  if (!r) sf_oom();
  r->rc = 1;
  r->stream = s;
  r->closed = scr_promise_new();
  /* A reader's internal closed capability never reports as an unhandled
   * rejection merely because user code does not read the property. */
  scr_promise_mark_handled(r->closed);
  if (s->closed) scr_promise_fulfill_void(r->closed);
  else if (s->error) sf_reject_promise_reason(r->closed, s->error);
  s->reader = sf_reader_retain(r);
  return r;
}

/* readableStreamDefaultReaderRead: queue the request, then serve it from
 * the queue or a pull. false (TypeError pending) for a released reader. */
static bool sf_reader_read_request(SfReader *r, ScrPromise *p, const ScrFetchReadSink *sink,
                                   void *sink_ctx) {
  SfStream *s = r->stream;
  if (!s || s->reader != r) {
    sf_type_error("This reader has been released");
    return false;
  }
  s->disturbed = true;
  SfReadRequest *request = calloc(1, sizeof *request);
  if (!request) sf_oom();
  request->promise = p ? scr_promise_retain(p) : NULL;
  request->sink = sink;
  request->sink_ctx = sink_ctx;
  if (r->pending_tail) r->pending_tail->next = request;
  else r->pending_head = request;
  r->pending_tail = request;
  sf_stream_drain(s);
  if (r->pending_head && !s->head && !s->closed && !s->error) {
    sf_stream_pull(s);
    sf_stream_drain(s);
  }
  return true;
}

static ScrPromise *sf_reader_read(SfReader *r) {
  ScrPromise *p = scr_promise_new();
  if (!sf_reader_read_request(r, p, NULL, NULL)) scr_promise_reject_pending(p);
  return p;
}

static void sf_reader_release_lock(SfReader *r) {
  SfStream *s = r->stream;
  if (!s || s->reader != r) return;

  ScrPromise *old_closed = r->closed;
  if (!s->closed && !s->error) {
    sf_type_error("Invalid state: Reader released");
    scr_promise_reject_pending(old_closed);
  } else {
    r->closed = scr_promise_new();
    scr_promise_mark_handled(r->closed);
    sf_type_error("Invalid state: Reader released");
    scr_promise_reject_pending(r->closed);
    scr_promise_release(old_closed);
  }

  sf_reader_reject_message_all(r, "Invalid state: Releasing reader");

#ifdef SCR_HANDLE_CLASSES
  /* The web view was made while this reader held the lock. */
  ScrDyn *view_lock = r != s->view_reader ? s->web_view_lock : NULL;
  if (view_lock) s->web_view_lock = NULL;
#endif
  size_t handle_refs = r->handle_refs;
  s->reader = NULL;
  r->stream = NULL;
  sf_reader_release(r); /* stream's ownership */
#ifdef SCR_HANDLE_CLASSES
  if (view_lock) {
    ScrDyn *released = scr_dyn_invoke(view_lock, "releaseLock", NULL, 0, "ReadableStreamDefaultReader.releaseLock");
    if (released) scr_dyn_release(released);
    scr_dyn_release(view_lock);
  }
#endif
  while (handle_refs-- > 0) sf_stream_release(s);
}

static void sf_stream_cancel_wait_entry(ScrFiber *self, void *arg) {
  (void)self;
  SfCancelWait *wait = arg;
  ScrDyn *value = scr_await_dyn(wait->source);
  bool rejected = scr_exc_pending();
  ScrCaught *caught = rejected ? scr_exc_take() : NULL;
  scr_dyn_release(value);
  if (rejected) {
    ScrDyn *reason = scr_caught_to_dyn(caught);
    sf_reject_promise_reason(wait->result, reason);
    scr_dyn_release(reason);
  } else {
    scr_promise_fulfill_void(wait->result);
  }
  scr_caught_release(caught);
  scr_promise_release(wait->source);
  scr_promise_release(wait->result);
  free(wait);
}

static ScrPromise *sf_stream_cancel(SfStream *s, ScrDyn *reason,
                                    bool through_reader) {
  ScrPromise *p = scr_promise_new();
  if (!through_reader && (s->reader || s->internal_lock)) {
    sf_type_error("Invalid state: cannot cancel a locked ReadableStream");
    scr_promise_reject_pending(p);
    return p;
  }
  /*
   * ReadableStreamCancel disturbs the stream before inspecting its state.
   * This remains observable through Response.bodyUsed even when the
   * stream had already closed or errored.
   */
  s->disturbed = true;
  if (s->closed) {
    /* WHATWG cancel is a no-op once the stream is closed. */
    scr_promise_fulfill_void(p);
    return p;
  }
  if (s->error) {
    /* An errored stream preserves and rejects with its stored reason. */
    sf_reject_promise_reason(p, s->error);
    return p;
  }
  ScrDyn *cancel_cb =
      s->cancel_cb ? scr_dyn_retain(s->cancel_cb) : NULL;
  ScrDyn *cancel_this =
      cancel_cb ? scr_dyn_retain(s->source_this) : NULL;
#ifdef SCR_HANDLE_CLASSES
  ScrDyn *web_reader = s->web_reader ? scr_dyn_retain(s->web_reader) : NULL;
#endif
  sf_stream_drop_chunks(s);
  SfTransfer *response_owner = s->response_owner;
  if (response_owner && response_owner->client) {
    scr_http_client_destroy(response_owner->client);
  }
  if (s->close_requested) sf_stream_finish_close(s);
  else sf_stream_close(s);
  if (response_owner && !response_owner->done) sf_settle(response_owner);

#ifdef SCR_HANDLE_CLASSES
  if (cancel_cb || web_reader) {
    ScrDyn *args[1] = {reason ? reason : scr_dyn_undefined()};
    ScrDyn *r;
    if (web_reader) {
      /* The web stream's cancel through its reader. */
      r = scr_dyn_invoke(web_reader, "cancel", args, 1, "ReadableStreamDefaultReader.cancel");
      scr_dyn_release(web_reader);
    } else {
      scr_dyn_this_push_dyn(cancel_this);
      r = scr_dyn_call(cancel_cb, args, 1, "underlyingSource.cancel");
      scr_dyn_this_pop();
      scr_dyn_release(cancel_cb);
      scr_dyn_release(cancel_this);
    }
#else
  if (cancel_cb) {
    ScrDyn *args[1] = {reason ? reason : scr_dyn_undefined()};
    scr_dyn_this_push_dyn(cancel_this);
    ScrDyn *r =
        scr_dyn_call(cancel_cb, args, 1, "underlyingSource.cancel");
    scr_dyn_this_pop();
    scr_dyn_release(cancel_cb);
    scr_dyn_release(cancel_this);
#endif
    if (!r) {
      scr_promise_reject_pending(p);
      return p;
    }
    ScrPromise *callback_promise = sf_stream_callback_promise(r);
    if (callback_promise) {
      SfCancelWait *wait = malloc(sizeof *wait);
      if (!wait) sf_oom();
      wait->source = callback_promise;
      wait->result = scr_promise_retain(p);
      ScrPromise *watcher =
          scr_async_spawn(&sf_stream_cancel_wait_entry, wait);
      scr_promise_release(watcher);
      scr_dyn_release(r);
      return p;
    }
    scr_dyn_release(r);
  } else {
    scr_dyn_release(cancel_cb);
  }
  scr_promise_fulfill_void(p);
  return p;
}

static ScrPromise *sf_stream_collect(SfStream *s, int mode) {
#ifdef SCR_HANDLE_CLASSES
  if (s->web_view && !(s->disturbed || s->reader || s->internal_lock || sf_view_unusable(s))) {
    SfStream *source = sf_stream_body_source(s);
    if (!source) {
      ScrPromise *p = scr_promise_new();
      scr_promise_reject_pending(p);
      return p;
    }
    ScrPromise *p = sf_stream_collect(source, mode);
    sf_stream_release(source);
    return p;
  }
#endif
  ScrPromise *p = scr_promise_new();
  if (s->disturbed || s->reader || s->internal_lock || sf_view_unusable(s)) {
    sf_type_error("Body is unusable: Body has already been read");
    scr_promise_reject_pending(p);
    return p;
  }
  s->disturbed = true;
  s->internal_lock = true;
  SfCollector *c = calloc(1, sizeof *c);
  if (!c) sf_oom();
  c->promise = scr_promise_retain(p);
  c->held_stream = sf_stream_retain(s);
  c->mode = mode;
  s->collector = c;
  sf_stream_drain(s);
  /* The collector reads to the end: a queue it emptied asks the source
   * for the next chunk, also when the queue had filled before. */
  if (!s->head) sf_stream_pull(s);
  return p;
}

/* ── ReadableStreamDefaultTee ────────────────────────────────────── */

/*
 * The streams spec's ReadableStreamDefaultTee over a native stream: the
 * tee locks the source with a reader and feeds two native branches whose
 * pull and cancel algorithms are native functions. A pull on either branch
 * reads one chunk from the source and enqueues it into every branch that
 * was not canceled; canceling both branches cancels the source with both
 * reasons. Response.clone and Request.clone use it (undici's cloneBody).
 *
 * Ownership: the tee owns the source, its reader and both branches; each
 * branch's callbacks and every pending read own the tee. Closing, erroring
 * or canceling a branch drops its callbacks (sf_stream_drop_source_callbacks),
 * and fetch teardown drops the callbacks of branches nobody finished.
 */
typedef struct SfTee {
  size_t rc;
  SfStream *source;
  SfReader *reader;
  SfStream *branch[2];
  bool reading;
  bool read_again;
  bool canceled[2];
  ScrDyn *reason[2];
  ScrPromise *cancel_promise;
} SfTee;

static SfTee *sf_tee_retain(SfTee *t) {
  t->rc++;
  return t;
}

static void sf_tee_release(SfTee *t) {
  if (!t || --t->rc > 0) return;
  if (t->source->error_watch_ctx == t) {
    t->source->error_watch = NULL;
    t->source->error_watch_ctx = NULL;
  }
  sf_stream_release(t->branch[0]);
  sf_stream_release(t->branch[1]);
  sf_reader_release(t->reader);
  sf_stream_release(t->source);
  scr_dyn_release(t->reason[0]);
  scr_dyn_release(t->reason[1]);
  scr_promise_release(t->cancel_promise);
  free(t);
}

static void *sf_tee_retain_v(void *p) { return sf_tee_retain((SfTee *)p); }
static void sf_tee_release_v(void *p) { sf_tee_release((SfTee *)p); }

static ScrBox *sf_tee_box(SfTee *t) {
  ScrBox *box = scr_box_new_obj(&sf_tee_retain_v, &sf_tee_release_v, NULL);
  scr_box_set_ref(box, sf_tee_retain(t));
  return box;
}

static void sf_tee_pull(SfTee *t);

/* The read request's chunk steps run in a microtask (spec: "queue a
 * microtask"), after the read that produced the chunk settles. */
static void sf_tee_chunk_task(ScrClosure *cb) {
  SfTee *t = (SfTee *)scr_box_get_ref(cb->caps[0]);
  ScrDyn *chunk = (ScrDyn *)scr_box_get_ref(cb->caps[1]);
  t->read_again = false;
  for (int i = 0; i < 2; i++) {
    if (t->canceled[i]) continue;
    SfStream *b = t->branch[i];
    if (b->close_requested || b->closed || b->error) continue;
    sf_stream_enqueue_value(b, chunk);
    if (scr_exc_pending()) scr_exc_clear();
  }
  t->reading = false;
  if (t->read_again) sf_tee_pull(t);
  scr_dyn_release(chunk);
  sf_tee_release(t);
}

static void sf_tee_sink_chunk(void *ctx, ScrDyn *value) {
  SfTee *t = ctx;
  ScrClosure *cb = scr_closure_new((void *)&sf_tee_chunk_task, 2);
  cb->caps[0] = sf_tee_box(t);
  cb->caps[1] = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(cb->caps[1], scr_dyn_retain(value));
  scr_queue_microtask(cb);
  sf_tee_release(t); /* the read request's reference */
}

static void sf_tee_sink_close(void *ctx) {
  SfTee *t = ctx;
  t->reading = false;
  for (int i = 0; i < 2; i++) {
    if (!t->canceled[i]) sf_stream_close(t->branch[i]);
  }
  if (!t->canceled[0] || !t->canceled[1]) {
    scr_promise_fulfill_void(t->cancel_promise);
  }
  sf_tee_release(t);
}

/* The source reader's closed promise rejected (spec: upon its rejection
 * with r, error both branches, and resolve cancelPromise unless both
 * branches were canceled), as a promise reaction: in a microtask. */
static void sf_tee_source_errored_task(ScrClosure *cb) {
  SfTee *t = (SfTee *)scr_box_get_ref(cb->caps[0]);
  ScrDyn *reason = (ScrDyn *)scr_box_get_ref(cb->caps[1]);
  sf_stream_error(t->branch[0], reason);
  sf_stream_error(t->branch[1], reason);
  if (!t->canceled[0] || !t->canceled[1]) scr_promise_fulfill_void(t->cancel_promise);
  scr_dyn_release(reason);
  sf_tee_release(t);
}

/* The source errored, with or without a read of it pending. */
static void sf_tee_source_errored(void *ctx, ScrDyn *reason) {
  SfTee *t = ctx;
  t->source->error_watch = NULL;
  t->source->error_watch_ctx = NULL;
  ScrClosure *cb = scr_closure_new((void *)&sf_tee_source_errored_task, 2);
  cb->caps[0] = sf_tee_box(t);
  cb->caps[1] = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(cb->caps[1], scr_dyn_retain(reason));
  scr_queue_microtask(cb);
}

/* A read request's error steps only end the read: the source's error
 * reaches the branches through sf_tee_source_errored. */
static void sf_tee_sink_error(void *ctx, ScrDyn *reason) {
  (void)reason;
  SfTee *t = ctx;
  t->reading = false;
  sf_tee_release(t);
}

static const ScrFetchReadSink sf_tee_sink = {
    &sf_tee_sink_chunk, &sf_tee_sink_close, &sf_tee_sink_error};

static void sf_tee_pull(SfTee *t) {
  if (t->reading) {
    t->read_again = true;
    return;
  }
  t->reading = true;
  sf_tee_retain(t); /* owned by the read request */
  if (!sf_reader_read_request(t->reader, NULL, &sf_tee_sink, t)) {
    scr_exc_clear();
    t->reading = false;
    sf_tee_release(t);
  }
}

static ScrDyn *sf_tee_pull_thunk(ScrClosure *cb, ScrDyn *const *args,
                                 size_t argc) {
  (void)args;
  (void)argc;
  SfTee *t = (SfTee *)scr_box_get_ref(cb->caps[0]);
  sf_tee_pull(t);
  sf_tee_release(t);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sf_tee_cancel(SfTee *t, int i, ScrDyn *reason) {
  t->canceled[i] = true;
  scr_dyn_release(t->reason[i]);
  t->reason[i] = scr_dyn_retain(reason);
  if (t->canceled[0] && t->canceled[1]) {
    ScrDyn *composite = scr_dyn_new_arr();
    scr_dyn_arr_push(composite, scr_dyn_retain(t->reason[0]));
    scr_dyn_arr_push(composite, scr_dyn_retain(t->reason[1]));
    ScrPromise *result = sf_stream_cancel(t->source, composite, true);
    scr_dyn_release(composite);
    ScrDyn *boxed = scr_dyn_new_promise(result);
    scr_promise_release(result);
    sf_then_adopt(t->cancel_promise, boxed);
    scr_dyn_release(boxed);
  }
  return scr_dyn_new_promise(t->cancel_promise);
}

static ScrDyn *sf_tee_cancel_thunk_0(ScrClosure *cb, ScrDyn *const *args,
                                     size_t argc) {
  SfTee *t = (SfTee *)scr_box_get_ref(cb->caps[0]);
  ScrDyn *out = sf_tee_cancel(t, 0, argc ? args[0] : scr_dyn_undefined());
  sf_tee_release(t);
  return out;
}

static ScrDyn *sf_tee_cancel_thunk_1(ScrClosure *cb, ScrDyn *const *args,
                                     size_t argc) {
  SfTee *t = (SfTee *)scr_box_get_ref(cb->caps[0]);
  ScrDyn *out = sf_tee_cancel(t, 1, argc ? args[0] : scr_dyn_undefined());
  sf_tee_release(t);
  return out;
}

static ScrDyn *sf_tee_func(SfTee *t, ScrDynThunk thunk, const char *name) {
  ScrClosure *cb = scr_closure_new((void *)thunk, 1);
  cb->caps[0] = sf_tee_box(t);
  return scr_dyn_new_func(cb, thunk, 1, "(controller)", name);
}

/* Tees an unlocked, undisturbed stream: +1 branches in out[0] and out[1].
 * The source stays locked by the tee. */
static void sf_stream_tee(SfStream *s, SfStream *out[2]) {
  SfTee *t = calloc(1, sizeof *t);
  if (!t) sf_oom();
  t->rc = 1;
  t->source = sf_stream_retain(s);
  t->reader = sf_stream_get_reader(s);
  s->error_watch = &sf_tee_source_errored;
  s->error_watch_ctx = t;
  t->cancel_promise = scr_promise_new();
  scr_promise_mark_handled(t->cancel_promise);
  for (int i = 0; i < 2; i++) {
    SfStream *b = sf_stream_new_native();
    b->pull_cb = sf_tee_func(t, &sf_tee_pull_thunk, "pull");
    b->cancel_cb = sf_tee_func(
        t, i == 0 ? &sf_tee_cancel_thunk_0 : &sf_tee_cancel_thunk_1, "cancel");
    b->source_this = scr_dyn_retain(scr_dyn_undefined());
#ifdef SCR_HANDLE_CLASSES
    b->u8_chunks = s->u8_chunks;
#endif
    sf_stream_track_callbacks(b);
    t->branch[i] = sf_stream_retain(b);
    out[i] = b;
  }
  /* An errored source's closed promise has already rejected. */
  if (s->error) sf_tee_source_errored(t, s->error);
  /* The branches start at once; a branch with room then pulls. */
  sf_stream_schedule_initial_pull(out[0]);
  sf_stream_schedule_initial_pull(out[1]);
  sf_tee_release(t);
}

ScrDyn *scr_fetch_stream_new(ScrDyn *source) {
  ScrDyn *source_view = source;
  ScrDyn *materialized = NULL;
  if (source && source->kind == SCR_DYN_TYPED_REF) {
    materialized = scr_dyn_typed_ref_materialize(source);
    source_view = materialized;
  }
  if (source_view && source_view->kind != SCR_DYN_UNDEF &&
      source_view->kind != SCR_DYN_OBJ) {
    scr_dyn_release(materialized);
    sf_type_error("ReadableStream source must be an object");
    return NULL;
  }
  SfStream *s = sf_stream_new_native();
  if (source_view && source_view->kind == SCR_DYN_OBJ) {
    const ScrDyn *type = scr_dyn_obj_get(source_view, "type", 4);
    if (type && type->kind != SCR_DYN_UNDEF) {
      sf_stream_release(s);
      scr_dyn_release(materialized);
      sf_type_error("byte streams are not supported by static ReadableStream");
      return NULL;
    }
    const ScrDyn *pull = scr_dyn_obj_get(source_view, "pull", 4);
    const ScrDyn *cancel = scr_dyn_obj_get(source_view, "cancel", 6);
    const ScrDyn *start = scr_dyn_obj_get(source_view, "start", 5);
    if (pull && pull->kind != SCR_DYN_UNDEF) {
      if (pull->kind != SCR_DYN_FUNC) {
        sf_stream_release(s);
        scr_dyn_release(materialized);
        sf_type_error("ReadableStream source.pull must be a function");
        return NULL;
      }
      s->pull_cb = scr_dyn_retain((ScrDyn *)pull);
    }
    if (cancel && cancel->kind != SCR_DYN_UNDEF) {
      if (cancel->kind != SCR_DYN_FUNC) {
        sf_stream_release(s);
        scr_dyn_release(materialized);
        sf_type_error("ReadableStream source.cancel must be a function");
        return NULL;
      }
      s->cancel_cb = scr_dyn_retain((ScrDyn *)cancel);
    }
    if (s->pull_cb || s->cancel_cb) {
      s->source_this = scr_dyn_retain(source);
    }
    sf_stream_track_callbacks(s);
    if (start && start->kind != SCR_DYN_UNDEF) {
      if (start->kind != SCR_DYN_FUNC) {
        sf_stream_release(s);
        scr_dyn_release(materialized);
        sf_type_error("ReadableStream source.start must be a function");
        return NULL;
      }
      s->started = false;
      /* `this` may be a live typed capsule. A property write from start()
       * refreshes its cached object and releases the old field snapshot,
       * so retain the borrowed callback across that refresh. */
      ScrDyn *start_cb = scr_dyn_retain((ScrDyn *)start);
      ScrDyn *controller = sf_controller_box(s);
      ScrDyn *args[1] = {controller};
      scr_dyn_this_push_dyn(source);
      ScrDyn *r =
          scr_dyn_call(start_cb, args, 1, "underlyingSource.start");
      scr_dyn_this_pop();
      scr_dyn_release(start_cb);
      scr_dyn_release(controller);
      if (!r) {
        sf_stream_release(s);
        scr_dyn_release(materialized);
        return NULL;
      }
      ScrPromise *callback_promise = sf_stream_callback_promise(r);
      if (callback_promise) {
        SfStartWait *wait = malloc(sizeof *wait);
        if (!wait) sf_oom();
        wait->stream = sf_stream_retain(s);
        wait->promise = callback_promise;
        ScrPromise *watcher =
            scr_async_spawn(&sf_stream_start_wait_entry, wait);
        scr_promise_release(watcher);
      } else {
        s->started = true;
      }
      scr_dyn_release(r);
    }
  }
  if (s->started) sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  scr_dyn_release(materialized);
  return out;
}

ScrDyn *scr_fetch_stream_from(ScrDyn *iterable) {
  if (!iterable) {
    sf_type_error("ReadableStream.from requires an iterable");
    return NULL;
  }
  if (iterable->kind == SCR_DYN_UNDEF) {
    sf_type_error(
        "Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')");
    return NULL;
  }
  if (iterable->kind != SCR_DYN_ARR && iterable->kind != SCR_DYN_BYTES && iterable->kind != SCR_DYN_STR) {
    /* Reuse the checked-dynamic iterable error wording. */
    ScrDyn *packed = scr_dyn_iter_pack(iterable, NULL);
    scr_dyn_release(packed);
    return NULL;
  }
  ScrDyn *source = iterable;

  SfStream *s = sf_stream_new_native();
  s->from_dyn = scr_dyn_retain(source);
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  if (source != iterable) scr_dyn_release(source);
  return out;
}

ScrDyn *scr_fetch_stream_from_array(
    ScrArr *iterable, ScrDyn *(*item)(ScrArr *, double)) {
  SfStream *s = sf_stream_new_native();
  s->from_array = scr_arr_retain(iterable);
  s->from_array_item = item;
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  return out;
}

ScrDyn *scr_fetch_stream_from_bytes(ScrBytes *iterable) {
  SfStream *s = sf_stream_new_native();
  s->from_bytes = scr_bytes_retain(iterable);
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  return out;
}

ScrDyn *scr_fetch_stream_from_string(ScrStr *iterable) {
  SfStream *s = sf_stream_new_native();
  s->from_string = scr_str_retain(iterable);
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  return out;
}

bool scr_fetch_reader_read_into(ScrDyn *reader, const ScrFetchReadSink *sink, void *ctx) {
#ifdef SCR_HANDLE_CLASSES
  if (scr_web_stream_bridge && reader && reader->kind == SCR_DYN_HANDLE &&
      reader->v.handle.tag == SCR_DYNH_WS_READER)
    return scr_web_stream_bridge->reader_read_into(reader, sink, ctx);
#endif
  if (!reader || reader->kind != SCR_DYN_HANDLE ||
      reader->v.handle.tag != SCR_DYNH_WEB_READER) {
    sf_type_error("Expected a ReadableStreamDefaultReader");
    return false;
  }
  return sf_reader_read_request((SfReader *)reader->v.handle.ptr, NULL, sink, ctx);
}

ScrPromise *scr_fetch_reader_read(ScrDyn *reader) {
#ifdef SCR_HANDLE_CLASSES
  /* A checked-dynamic web stream's reader answers its own read(). */
  if (reader && reader->kind == SCR_DYN_HANDLE && reader->v.handle.tag == SCR_DYNH_WS_READER) {
    ScrDyn *result = scr_dyn_invoke(reader, "read", NULL, 0, "reader.read");
    if (!result) {
      ScrPromise *p = scr_promise_new();
      scr_promise_reject_pending(p);
      return p;
    }
    ScrPromise *p = scr_promise_retain(result->v.promise);
    scr_dyn_release(result);
    return p;
  }
#endif
  if (!reader || reader->kind != SCR_DYN_HANDLE ||
      reader->v.handle.tag != SCR_DYNH_WEB_READER) {
    sf_type_error("Expected a ReadableStreamDefaultReader");
    ScrPromise *p = scr_promise_new();
    scr_promise_reject_pending(p);
    return p;
  }
  return sf_reader_read((SfReader *)reader->v.handle.ptr);
}

static SfStream *sf_stream_of(const ScrDyn *d) {
  if (!d || d->kind != SCR_DYN_HANDLE ||
      d->v.handle.tag != SCR_DYNH_WEB_STREAM) {
    sf_type_error("Expected a ReadableStream");
    return NULL;
  }
  return (SfStream *)d->v.handle.ptr;
}

static ScrDyn *sf_stream_invoke(void *ptr, ScrDyn *self, const char *method,
                                ScrDyn *const *args, size_t argc,
                                const char *what) {
  SfStream *s = ptr;
#ifdef SCR_HANDLE_CLASSES
  /* Any other member, and every member once the web view exists, is the
   * view's. */
  if (s->web_view || !sf_stream_own_method(method, strlen(method))) {
    ScrDyn *view = sf_stream_web_view(s);
    return view ? scr_dyn_invoke(view, method, args, argc, what) : NULL;
  }
#endif
  if (strcmp(method, "getReader") == 0) {
    ScrDyn *options = argc ? args[0] : NULL;
    ScrDyn *materialized = NULL;
    ScrDyn *mode = NULL;
    if (options && options->kind == SCR_DYN_TYPED_REF) {
      materialized = scr_dyn_typed_ref_materialize(options);
      options = materialized;
    }
    if (options && options->kind == SCR_DYN_OBJ) {
      mode = scr_dyn_obj_get(options, "mode", 4);
    }
    bool byob = mode && mode->kind != SCR_DYN_UNDEF;
    scr_dyn_release(materialized);
    if (scr_exc_pending()) return NULL;
    if (byob) {
      sf_type_error("BYOB readers are not supported");
      return NULL;
    }
    SfReader *r = sf_stream_get_reader(s);
    if (!r) return NULL;
    ScrDyn *out = scr_dyn_new_handle(r, SCR_DYNH_WEB_READER);
    sf_reader_release(r);
    return out;
  }
  if (strcmp(method, "cancel") == 0) {
    ScrPromise *p =
        sf_stream_cancel(s, argc ? args[0] : scr_dyn_undefined(), false);
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_stream_get(void *ptr, const char *key, size_t len) {
  SfStream *s = ptr;
#ifdef SCR_HANDLE_CLASSES
  /* The stream's own members are its own until the web view exists; any
   * other member makes the view and is the view's. */
  if (s->web_view || !(sf_name(key, len, "locked") || sf_stream_own_method(key, len))) {
    ScrDyn *view = sf_stream_web_view(s);
    if (!view) return NULL;
    ScrStr *name = scr_str_new(key, len);
    ScrDyn *value = scr_dyn_handle_key_get(view, name);
    scr_str_release(name);
    return value;
  }
#endif
  if (sf_name(key, len, "locked")) {
    return scr_dyn_new_bool(s->reader != NULL || s->internal_lock);
  }
  return NULL;
}

#ifdef SCR_HANDLE_CLASSES
/* Symbol.asyncIterator is the web view's. */
static ScrDyn *sf_stream_symbol_get(void *ptr, const ScrDyn *key) {
  if (!scr_dyn_is_async_iterator_symbol(key)) return NULL;
  ScrDyn *view = sf_stream_web_view(ptr);
  if (!view) return NULL;
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(view);
  return ops->symbol_get ? ops->symbol_get(view->v.handle.ptr, key) : NULL;
}
#endif

static ScrDyn *sf_reader_invoke(void *ptr, ScrDyn *self, const char *method,
                                ScrDyn *const *args, size_t argc,
                                const char *what) {
  SfReader *r = ptr;
  if (strcmp(method, "read") == 0) {
    ScrPromise *p = sf_reader_read(r);
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  if (strcmp(method, "cancel") == 0) {
    ScrPromise *p;
    if (!r->stream) {
      sf_type_error("This reader has been released");
      p = scr_promise_new();
      scr_promise_reject_pending(p);
    } else {
      p = sf_stream_cancel(
          r->stream, argc ? args[0] : scr_dyn_undefined(), true);
    }
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  if (strcmp(method, "releaseLock") == 0) {
    sf_reader_release_lock(r);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_reader_get(void *ptr, const char *key, size_t len) {
  SfReader *r = ptr;
  if (sf_name(key, len, "closed")) return scr_dyn_new_promise(r->closed);
  return NULL;
}

static ScrDyn *sf_controller_invoke(void *ptr, ScrDyn *self,
                                    const char *method,
                                    ScrDyn *const *args, size_t argc,
                                    const char *what) {
  SfStream *s = ptr;
  if (strcmp(method, "enqueue") == 0) {
    sf_stream_enqueue_value(
        s, argc ? args[0] : scr_dyn_undefined());
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "close") == 0) {
    if (s->close_requested || s->closed || s->error) {
      sf_type_error("Invalid state: Controller is already closed");
      return NULL;
    }
    sf_stream_close(s);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "error") == 0) {
    sf_stream_error(s, argc ? args[0] : scr_dyn_undefined());
    return scr_dyn_retain(scr_dyn_undefined());
  }
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_controller_get(void *ptr, const char *key, size_t len) {
  SfStream *s = ptr;
  if (sf_name(key, len, "desiredSize")) {
    if (s->error) return scr_dyn_new_null();
    if (s->closed) return scr_dyn_new_num(0);
    return scr_dyn_new_num(1.0 - (double)s->queued);
  }
  return NULL;
}

/* ── Headers ─────────────────────────────────────────────────────── */

static bool sf_header_name_ok(const char *s, size_t len);

/* A borrowed element of a runtime-built header pair array. These arrays are
 * only ever appended to or rewritten whole, so they are dense. */
static inline ScrStr *sf_pair_at(ScrArr *pairs, size_t i) {
  if (i < pairs->filled) return (ScrStr *)(uintptr_t)scr_arr_dense_get(pairs, i);
  return (ScrStr *)scr_arr_peek_ref(pairs, (double)i);
}

static ScrStr *sf_header_name_lower(const char *data, size_t len);

/* `name` in lowercase, +1: the same string when it has no uppercase byte. */
static ScrStr *sf_header_name_lower_str(ScrStr *name) {
  for (size_t i = 0; i < name->len; i++) {
    char c = name->data[i];
    if (c >= 'A' && c <= 'Z') return sf_header_name_lower(name->data, name->len);
  }
  return scr_str_retain(name);
}

static ScrStr *sf_header_name_lower(const char *data, size_t len) {
  char *lower = malloc(len ? len : 1);
  if (!lower) sf_oom();
  for (size_t i = 0; i < len; i++) {
    char c = data[i];
    lower[i] = c >= 'A' && c <= 'Z' ? (char)(c - 'A' + 'a') : c;
  }
  ScrStr *out = scr_str_new(lower, len);
  free(lower);
  return out;
}

/* HTTP field values are ByteStrings: each wire octet becomes the same
 * U+00XX code point in the JS string. ScrStr stores UTF-8, so obs-text
 * bytes need a real Latin-1→UTF-8 expansion before they enter a Headers
 * handle (and before string methods assume the storage invariant). */
static ScrStr *sf_latin1_to_utf8(const ScrStr *raw) {
  size_t extra = 0;
  for (size_t i = 0; i < raw->len; i++) {
    if ((unsigned char)raw->data[i] >= 0x80) extra++;
  }
  if (extra == 0) return scr_str_retain((ScrStr *)raw);
  char *utf8 = malloc(raw->len + extra);
  if (!utf8) sf_oom();
  size_t at = 0;
  for (size_t i = 0; i < raw->len; i++) {
    unsigned char byte = (unsigned char)raw->data[i];
    if (byte < 0x80) {
      utf8[at++] = (char)byte;
    } else {
      utf8[at++] = (char)(0xc0 | (byte >> 6));
      utf8[at++] = (char)(0x80 | (byte & 0x3f));
    }
  }
  ScrStr *out = scr_str_new(utf8, at);
  free(utf8);
  return out;
}

/*
 * Redirect Location values are byte sequences until Fetch's header-value
 * extraction decodes them as UTF-8. Invalid wire sequences become U+FFFD;
 * treating the bytes as an already-valid ScrStr instead percent-encodes
 * each invalid octet and can follow a different resource.
 */
static ScrStr *sf_location_to_utf8(const ScrStr *raw) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)raw->len);
  if (raw->len > 0) memcpy(bytes->data, raw->data, raw->len);
  ScrStr *encoding = scr_str_new("utf8", 4);
  ScrStr *out = scr_bytes_to_str(bytes, encoding);
  scr_str_release(encoding);
  scr_bytes_release(bytes);
  return out;
}

static SfHeaders *sf_headers_new(ScrArr *pairs, bool immutable) {
  SfHeaders *h = calloc(1, sizeof *h);
  if (!h) sf_oom();
  h->rc = 1;
  h->pairs = pairs;
  h->immutable = immutable;
  return h;
}

static SfHeaders *sf_headers_new_response(ScrArr *raw_pairs) {
  size_t n = (size_t)scr_arr_len(raw_pairs);
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    scr_arr_push_ref(pairs, sf_header_name_lower_str(sf_pair_at(raw_pairs, i)));
    scr_arr_push_ref(pairs, sf_latin1_to_utf8(sf_pair_at(raw_pairs, i + 1)));
  }
  scr_arr_release(raw_pairs);
  return sf_headers_new(pairs, true);
}

static SfHeaders *sf_headers_retain(SfHeaders *h) {
  h->rc++;
  return h;
}

static void sf_headers_release(SfHeaders *h) {
  if (!h || --h->rc > 0) return;
  scr_arr_release(h->pairs);
  if (h->sorted) scr_arr_release(h->sorted);
  free(h);
}

/* Every change to h->pairs goes through here first. */
static void sf_headers_changed(SfHeaders *h) {
  if (!h->sorted) return;
  scr_arr_release(h->sorted);
  h->sorted = NULL;
}

static void *sf_headers_retain_v(void *p) {
  return sf_headers_retain((SfHeaders *)p);
}

static void sf_headers_release_v(void *p) {
  sf_headers_release((SfHeaders *)p);
}

static bool sf_header_value_ok(const ScrStr *value);
static ScrStr *sf_header_value_bytestring(ScrStr *value);
static ScrStr *sf_trim_header_value(const ScrStr *value);

static void sf_headers_invalid(
    const char *method, const ScrStr *value, const char *kind) {
  size_t cap = strlen(method) + value->len + strlen(kind) + 48;
  char *message = malloc(cap);
  if (!message) sf_oom();
  int head = snprintf(message, cap, "Headers.%s: \"", method);
  if (head < 0 || (size_t)head >= cap) sf_oom();
  size_t at = (size_t)head;
  memcpy(message + at, value->data, value->len);
  at += value->len;
  int tail = snprintf(
      message + at, cap - at,
      "\" is an invalid header %s.", kind);
  if (tail < 0 || (size_t)tail >= cap - at) sf_oom();
  scr_throw_error_msg(SCR_ERR_TYPE, message, at + (size_t)tail);
  free(message);
}

static ScrStr *sf_headers_name(const ScrDyn *value, const char *method) {
  ScrStr *raw =
      scr_dyn_string_coerce_js(value ? value : scr_dyn_undefined());
  if (!raw) return NULL;
  if (!sf_header_name_ok(raw->data, raw->len)) {
    sf_headers_invalid(method, raw, "name");
    scr_str_release(raw);
    return NULL;
  }
  ScrStr *out = sf_header_name_lower_str(raw);
  scr_str_release(raw);
  return out;
}

static bool sf_headers_key_eq(const ScrStr *left, const ScrStr *right) {
  return left->len == right->len &&
         memcmp(left->data, right->data, left->len) == 0;
}

static ScrStr *sf_headers_get_value(SfHeaders *h, const ScrStr *name) {
  ScrArr *pairs = h->pairs;
  size_t n = (size_t)scr_arr_len(pairs);
  size_t count = 0;
  size_t total = 0;
  ScrStr *first = NULL;
  for (size_t i = 0; i + 1 < n; i += 2) {
    if (!sf_headers_key_eq(sf_pair_at(pairs, i), name)) continue;
    ScrStr *value = sf_pair_at(pairs, i + 1);
    if (count > 0) total += 2;
    else first = value;
    total += value->len;
    count++;
  }
  if (count == 0) return NULL;
  if (count == 1) return scr_str_retain(first);

  char *joined = malloc(total > 0 ? total : 1);
  if (!joined) sf_oom();
  size_t at = 0;
  size_t emitted = 0;
  for (size_t i = 0; i + 1 < n; i += 2) {
    if (!sf_headers_key_eq(sf_pair_at(pairs, i), name)) continue;
    ScrStr *value = sf_pair_at(pairs, i + 1);
    if (emitted > 0) {
      joined[at++] = ',';
      joined[at++] = ' ';
    }
    memcpy(joined + at, value->data, value->len);
    at += value->len;
    emitted++;
  }
  ScrStr *out = scr_str_new(joined, total);
  free(joined);
  return out;
}

static void sf_headers_delete_name(SfHeaders *h, const ScrStr *name) {
  ScrArr *old = h->pairs;
  size_t n = (size_t)scr_arr_len(old);
  bool present = false;
  for (size_t i = 0; i + 1 < n && !present; i += 2)
    present = sf_headers_key_eq(sf_pair_at(old, i), name);
  if (!present) return;
  sf_headers_changed(h);
  ScrArr *next = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = sf_pair_at(old, i);
    if (sf_headers_key_eq(key, name)) continue;
    scr_arr_push_ref(next, scr_str_retain(key));
    scr_arr_push_ref(next, scr_str_retain(sf_pair_at(old, i + 1)));
  }
  h->pairs = next;
  scr_arr_release(old);
}

static bool sf_headers_convert_pair(
    const ScrDyn *name_value, const ScrDyn *value_value,
    const char *method, ScrStr **name_out, ScrStr **value_out) {
  ScrStr *name = sf_headers_name(name_value, method);
  if (!name) return false;
  ScrStr *raw = scr_dyn_string_coerce_js(
      value_value ? value_value : scr_dyn_undefined());
  ScrStr *bytes = raw ? sf_header_value_bytestring(raw) : NULL;
  scr_str_release(raw);
  if (!bytes) {
    scr_str_release(name);
    return false;
  }
  if (!sf_header_value_ok(bytes)) {
    ScrStr *display = sf_latin1_to_utf8(bytes);
    sf_headers_invalid(method, display, "value");
    scr_str_release(display);
    scr_str_release(bytes);
    scr_str_release(name);
    return false;
  }
  ScrStr *trimmed = sf_trim_header_value(bytes);
  scr_str_release(bytes);
  ScrStr *normalized = sf_latin1_to_utf8(trimmed);
  scr_str_release(trimmed);
  *name_out = name;
  *value_out = normalized;
  return true;
}

/* Consumes a normalized lowercase name and UTF-8 value. Headers stores one
 * joined value for ordinary fields, separate values for Set-Cookie, and the
 * Fetch-specific semicolon separator for Cookie. */
static void sf_headers_append_pair(
    SfHeaders *h, ScrStr *name, ScrStr *value) {
  sf_headers_changed(h);
  if (!(name->len == 10 && memcmp(name->data, "set-cookie", 10) == 0)) {
    size_t n = (size_t)scr_arr_len(h->pairs);
    for (size_t i = 0; i + 1 < n; i += 2) {
      if (!sf_headers_key_eq(sf_pair_at(h->pairs, i), name)) continue;

      ScrStr *previous = sf_pair_at(h->pairs, i + 1);
      const char *separator =
          name->len == 6 && memcmp(name->data, "cookie", 6) == 0
              ? "; "
              : ", ";
      size_t joined_len = previous->len + 2 + value->len;
      char *joined_data = malloc(joined_len ? joined_len : 1);
      if (!joined_data) sf_oom();
      memcpy(joined_data, previous->data, previous->len);
      memcpy(joined_data + previous->len, separator, 2);
      memcpy(joined_data + previous->len + 2, value->data, value->len);
      ScrStr *joined = scr_str_new(joined_data, joined_len);
      free(joined_data);
      /* Appending an empty value leaves the separator's space at the end of
       * the combined value, which a copy trims again: the pairs are no
       * longer in their canonical, trimmed form. */
      if (value->len == 0) h->canonical = false;
      scr_str_release(name);
      scr_str_release(value);
      scr_arr_set_ref(h->pairs, (double)(i + 1), joined);
      return;
    }
  }
  scr_arr_push_ref(h->pairs, name);
  scr_arr_push_ref(h->pairs, value);
}

static int sf_headers_name_cmp(const void *left, const void *right) {
  const ScrStr *a = *(ScrStr *const *)left;
  const ScrStr *b = *(ScrStr *const *)right;
  size_t shared = a->len < b->len ? a->len : b->len;
  int cmp = memcmp(a->data, b->data, shared);
  if (cmp != 0) return cmp;
  return a->len < b->len ? -1 : a->len > b->len ? 1 : 0;
}

static ScrStr **sf_headers_sorted_names(SfHeaders *h, size_t *count_out) {
  size_t n = (size_t)scr_arr_len(h->pairs);
  size_t capacity = n / 2;
  ScrStr **names = capacity ? malloc(capacity * sizeof *names) : NULL;
  if (capacity && !names) sf_oom();
  size_t count = 0;
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = sf_pair_at(h->pairs, i);
    bool seen = false;
    for (size_t j = 0; j < count; j++) {
      if (sf_headers_key_eq(names[j], key)) {
        seen = true;
        break;
      }
    }
    if (!seen) names[count++] = key;
  }
  if (count > 1) {
    qsort(names, count, sizeof *names, &sf_headers_name_cmp);
  }
  *count_out = count;
  return names;
}

static bool sf_headers_is_set_cookie(const ScrStr *name) {
  return name->len == 10 && memcmp(name->data, "set-cookie", 10) == 0;
}

/* Fetch's "sort and combine" list as flat name/value pairs: names in byte
 * order, each with its combined value, except that every set-cookie value
 * is its own entry (in insertion order), as Node's Headers iterator yields
 * them. Cached until the next mutation; borrowed. */
static ScrArr *sf_headers_sorted(SfHeaders *h) {
  if (h->sorted) return h->sorted;
  size_t count = 0;
  ScrStr **names = sf_headers_sorted_names(h, &count); /* borrowed names */
  size_t n = (size_t)scr_arr_len(h->pairs);
  ScrArr *sorted = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i < count; i++) {
    if (!sf_headers_is_set_cookie(names[i])) {
      scr_arr_push_ref(sorted, scr_str_retain(names[i]));
      scr_arr_push_ref(sorted, sf_headers_get_value(h, names[i]));
      continue;
    }
    for (size_t j = 0; j + 1 < n; j += 2) {
      if (!sf_headers_is_set_cookie(sf_pair_at(h->pairs, j))) continue;
      scr_arr_push_ref(sorted, scr_str_retain(names[i]));
      scr_arr_push_ref(sorted, scr_str_retain(sf_pair_at(h->pairs, j + 1)));
    }
  }
  free(names);
  h->sorted = sorted;
  return sorted;
}

/* The `index`th entry of the sort-and-combine list (sf_headers_sorted).
 * False past the end. Outputs are +1. */
static bool sf_headers_sorted_entry(SfHeaders *h, size_t index,
                                    ScrStr **name_out,
                                    ScrStr **value_out) {
  ScrArr *sorted = sf_headers_sorted(h);
  size_t entries = (size_t)scr_arr_len(sorted) / 2;
  if (index >= entries) return false;
  *name_out = scr_str_retain(sf_pair_at(sorted, 2 * index));
  *value_out = scr_str_retain(sf_pair_at(sorted, 2 * index + 1));
  return true;
}

/* One step of a live Headers iterator (entries, keys or values): the
 * `*index`th entry of the current sorted list, as Node's iterator re-reads
 * the list on every step. The result is { value, done }. */
static ScrDyn *sf_headers_step(void *ptr, double *index, unsigned selection) {
  ScrStr *name = NULL;
  ScrStr *value = NULL;
  bool found = sf_headers_sorted_entry(ptr, (size_t)*index, &name, &value);
  ScrDyn *item;
  if (found) {
    (*index)++;
    if (selection == 2) {
      item = scr_dyn_new_arr();
      scr_dyn_arr_push(item, scr_dyn_new_str(name));
      scr_dyn_arr_push(item, scr_dyn_new_str(value));
    } else {
      item = scr_dyn_new_str(selection == 1 ? name : value);
    }
    scr_str_release(name);
    scr_str_release(value);
  } else {
    item = scr_dyn_retain(scr_dyn_undefined());
  }
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, item);
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(!found));
  return result;
}

static ScrDyn *sf_headers_invoke(void *ptr, ScrDyn *self,
                                 const char *method,
                                 ScrDyn *const *args, size_t argc,
                                 const char *what) {
  SfHeaders *h = ptr;
  if (strcmp(method, "entries") == 0 || strcmp(method, "keys") == 0 ||
      strcmp(method, "values") == 0) {
    return scr_dyn_native_handle_iterator(
        self, strcmp(method, "entries") == 0 ? 2 : strcmp(method, "keys") == 0 ? 1 : 0);
  }
  if (strcmp(method, "get") == 0 || strcmp(method, "has") == 0) {
    if (argc < 1) {
      sf_type_error("Headers.get/has requires a header name");
      return NULL;
    }
    ScrStr *name = sf_headers_name(args[0], method);
    if (!name) return NULL;
    ScrStr *value = sf_headers_get_value(h, name);
    scr_str_release(name);
    if (strcmp(method, "has") == 0) {
      bool present = value != NULL;
      scr_str_release(value);
      return scr_dyn_new_bool(present);
    }
    if (!value) return scr_dyn_new_null();
    ScrDyn *out = scr_dyn_new_str(value);
    scr_str_release(value);
    return out;
  }
  if (strcmp(method, "getSetCookie") == 0) {
    ScrDyn *out = scr_dyn_new_arr();
    size_t n = (size_t)scr_arr_len(h->pairs);
    for (size_t i = 0; i + 1 < n; i += 2) {
      if (sf_headers_is_set_cookie(sf_pair_at(h->pairs, i)))
        scr_dyn_arr_push(out, scr_dyn_new_str(sf_pair_at(h->pairs, i + 1)));
    }
    return out;
  }
  if (strcmp(method, "forEach") == 0) {
    if (argc < 1 || args[0]->kind != SCR_DYN_FUNC) {
      sf_type_error("Headers.forEach requires a callback function");
      return NULL;
    }
    ScrDyn *callback = args[0];
    const ScrDyn *this_arg =
        argc > 1 ? args[1] : scr_dyn_undefined();
    /* Headers iteration is live. Re-sort the current list for each numeric
     * index so callback mutations have the same effects as Node: deleting
     * a future name skips it, inserting a later name visits it, and
     * inserting before the current index can make the current name appear
     * again. The old one-time snapshot was only safe while every native
     * Headers handle was immutable. Set-Cookie values are visited one by
     * one (sf_headers_sorted_entry). */
    for (size_t i = 0;; i++) {
      ScrStr *name = NULL;
      ScrStr *value = NULL;
      if (!sf_headers_sorted_entry(h, i, &name, &value)) break;
      ScrDyn *boxed_value = scr_dyn_new_str(value);
      ScrDyn *boxed_name = scr_dyn_new_str(name);
      scr_str_release(name);
      ScrDyn *call_args[3] = {boxed_value, boxed_name, self};
      scr_dyn_this_push_dyn(this_arg);
      ScrDyn *result =
          scr_dyn_call(callback, call_args, 3, "Headers.forEach callback");
      scr_dyn_this_pop();
      scr_dyn_release(boxed_value);
      scr_dyn_release(boxed_name);
      scr_str_release(value);
      if (!result) {
        return NULL;
      }
      scr_dyn_release(result);
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "append") == 0 || strcmp(method, "delete") == 0 ||
      strcmp(method, "set") == 0) {
    size_t required = strcmp(method, "delete") == 0 ? 1 : 2;
    if (argc < required) {
      sf_type_error("Headers mutation requires its declared arguments");
      return NULL;
    }
    if (strcmp(method, "delete") == 0) {
      ScrStr *name = sf_headers_name(args[0], method);
      if (!name) return NULL;
      if (h->immutable) {
        scr_str_release(name);
        sf_type_error("immutable");
        return NULL;
      }
      sf_headers_delete_name(h, name);
      scr_str_release(name);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    ScrStr *name = NULL;
    ScrStr *value = NULL;
    if (!sf_headers_convert_pair(
            args[0], args[1], method, &name, &value)) {
      return NULL;
    }
    if (h->immutable) {
      scr_str_release(name);
      scr_str_release(value);
      sf_type_error("immutable");
      return NULL;
    }
    if (strcmp(method, "set") == 0) sf_headers_delete_name(h, name);
    sf_headers_append_pair(h, name, value);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_headers_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  (void)key;
  (void)len;
  return NULL;
}

/* ── TransformStream / WritableStream ────────────────────────────── */

/*
 * The identity TransformStream (`new TransformStream()`): a native
 * readable side (an SfStream with a zero high-water mark, fed by the
 * transform) and a writable side implemented here with the streams spec's
 * WritableStream state machine (default high-water mark 1, chunk size 1).
 * The writable side has no other sink, so the TransformStream object, its
 * WritableStream and the sink share one SfTransform; the handles differ
 * only by tag. Promise reactions the spec chains on already-settled
 * promises run after the same number of microtask turns as in Node's
 * implementation (lib/internal/webstreams), so interleavings with user
 * code match.
 *
 * Ownership: the transform owns its readable side and its writer; the
 * readable side's pull/cancel callbacks own the transform until that side
 * closes or errors (fetch teardown drops the callbacks of transforms
 * nobody finished). A writer handle retains the transform while bound,
 * like a reader handle retains its stream.
 */
enum { SFW_WRITABLE, SFW_ERRORING, SFW_ERRORED, SFW_CLOSED };

typedef struct SfTransform SfTransform;

typedef struct SfWriteReq {
  ScrDyn *chunk;
  ScrPromise *promise;
  struct SfWriteReq *next;
} SfWriteReq;

typedef struct SfWriter {
  size_t rc;
  size_t handle_refs;
  SfTransform *stream; /* weak; handle refs retain it while bound */
  ScrPromise *ready;
  ScrPromise *closed;
} SfWriter;

struct SfTransform {
  size_t rc;
  SfStream *readable;
  /* WritableStream */
  bool started; /* the start algorithm's promise settled (one turn) */
  int state;
  ScrDyn *stored_error;
  SfWriter *writer; /* owned while locked */
  SfWriteReq *head; /* queued writes (chunk + request promise) */
  SfWriteReq *tail;
  SfWriteReq *in_flight;
  size_t queue_size; /* queueTotalSize: queued chunks + the in-flight one */
  bool close_queued; /* the close sentinel is in the queue */
  ScrPromise *close_request;
  ScrPromise *in_flight_close;
  bool has_pending_abort;
  ScrPromise *pending_abort;
  /* The sink abort found a finish promise from a cancel or close, which
   * settles the abort instead (Node returns that promise). */
  bool abort_joins_finish;
  /* The abort request's outcome between SFT_ABORT_DONE and
   * SFT_ABORT_SETTLE: a rejection reason (+1), or NULL to fulfill. */
  ScrDyn *abort_settle_error;
  ScrDyn *pending_abort_reason;
  bool pending_abort_was_erroring;
  bool backpressure;
  /* TransformStream */
  bool t_backpressure;
  ScrPromise *bp_change;
  bool write_waiting; /* the in-flight write waits for bp_change */
  ScrDyn *write_error; /* the in-flight write's failure, if any */
  ScrDyn *cancel_reason; /* the readable side's cancel reason, until it reacts */
  ScrPromise *finish; /* finishPromise of close/abort/cancel */
};

static SfTransform *sf_transform_retain(SfTransform *t) {
  t->rc++;
  return t;
}

static void sf_write_req_free(SfWriteReq *w) {
  if (!w) return;
  scr_dyn_release(w->chunk);
  scr_promise_release(w->promise);
  free(w);
}

static void sf_writer_release(SfWriter *w) {
  if (!w || --w->rc > 0) return;
  scr_promise_release(w->ready);
  scr_promise_release(w->closed);
  free(w);
}

static void sf_transform_release(SfTransform *t) {
  if (!t || --t->rc > 0) return;
  sf_stream_release(t->readable);
  scr_dyn_release(t->stored_error);
  if (t->writer) {
    t->writer->stream = NULL;
    sf_writer_release(t->writer);
  }
  while (t->head) {
    SfWriteReq *w = t->head;
    t->head = w->next;
    sf_write_req_free(w);
  }
  sf_write_req_free(t->in_flight);
  scr_promise_release(t->close_request);
  scr_promise_release(t->in_flight_close);
  scr_promise_release(t->pending_abort);
  scr_dyn_release(t->pending_abort_reason);
  scr_dyn_release(t->abort_settle_error);
  scr_promise_release(t->bp_change);
  scr_promise_release(t->finish);
  scr_dyn_release(t->write_error);
  scr_dyn_release(t->cancel_reason);
  free(t);
}

static void *sf_transform_retain_v(void *p) {
  return sf_transform_retain((SfTransform *)p);
}
static void sf_transform_release_v(void *p) {
  sf_transform_release((SfTransform *)p);
}

static void *sf_writer_handle_retain_v(void *p) {
  SfWriter *w = p;
  w->rc++;
  w->handle_refs++;
  if (w->stream) sf_transform_retain(w->stream);
  return w;
}

static void sf_writer_handle_release_v(void *p) {
  SfWriter *w = p;
  SfTransform *t = w->stream;
  if (w->handle_refs > 0) w->handle_refs--;
  sf_writer_release(w);
  sf_transform_release(t);
}

static ScrBox *sf_transform_box(SfTransform *t) {
  ScrBox *box = scr_box_new_obj(&sf_transform_retain_v,
                                &sf_transform_release_v, NULL);
  scr_box_set_ref(box, sf_transform_retain(t));
  return box;
}

static void sf_invalid_state(const char *message) {
  char buf[96];
  int n = snprintf(buf, sizeof buf, "Invalid state: %s", message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, buf, (size_t)n, "ERR_INVALID_STATE");
}

static ScrPromise *sf_promise_invalid_state(const char *message) {
  ScrPromise *p = scr_promise_new();
  sf_invalid_state(message);
  scr_promise_reject_pending(p);
  return p;
}

static ScrPromise *sf_promise_rejected_with(ScrDyn *reason) {
  ScrPromise *p = scr_promise_new();
  sf_reject_promise_reason(p, reason);
  return p;
}

static ScrPromise *sf_promise_resolved(void) {
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_void(p);
  return p;
}

/* Deferred steps: the reaction `op` after `ticks` microtask turns. */
enum {
  SFT_WRITE_DONE,
  SFT_WRITE_CONTINUE,
  SFT_CLOSE_DONE,
  SFT_ABORT_DONE,
  SFT_START,
  SFT_CANCEL_DONE,
  SFT_ABORT_SETTLE,
};

static void sf_transform_step(SfTransform *t, int op);

typedef struct SfTransformTask {
  size_t rc;
  SfTransform *t;
  int op;
  int ticks;
} SfTransformTask;

static void *sf_transform_task_retain_v(void *p) {
  ((SfTransformTask *)p)->rc++;
  return p;
}

static void sf_transform_task_release_v(void *p) {
  SfTransformTask *task = p;
  if (--task->rc > 0) return;
  sf_transform_release(task->t);
  free(task);
}

static void sf_transform_tick_task(ScrClosure *cb) {
  SfTransformTask *task = (SfTransformTask *)scr_box_get_ref(cb->caps[0]);
  if (--task->ticks > 0) {
    ScrClosure *next = scr_closure_new((void *)&sf_transform_tick_task, 1);
    next->caps[0] = scr_box_new_obj(&sf_transform_task_retain_v,
                                    &sf_transform_task_release_v, NULL);
    scr_box_set_ref(next->caps[0], sf_transform_task_retain_v(task));
    scr_queue_microtask(next);
  } else {
    sf_transform_step(task->t, task->op);
  }
  sf_transform_task_release_v(task);
}

static void sf_transform_defer(SfTransform *t, int op, int ticks) {
  SfTransformTask *task = calloc(1, sizeof *task);
  if (!task) sf_oom();
  task->rc = 1;
  task->t = sf_transform_retain(t);
  task->op = op;
  task->ticks = ticks;
  ScrClosure *cb = scr_closure_new((void *)&sf_transform_tick_task, 1);
  cb->caps[0] = scr_box_new_obj(&sf_transform_task_retain_v,
                                &sf_transform_task_release_v, NULL);
  scr_box_set_ref(cb->caps[0], task); /* the box takes the reference */
  scr_queue_microtask(cb);
}

/* ── WritableStream abstract operations ── */

static bool sfw_close_queued_or_in_flight(const SfTransform *t) {
  return t->close_request || t->in_flight_close;
}

static bool sfw_has_operation_in_flight(const SfTransform *t) {
  return t->in_flight || t->in_flight_close;
}

static void sfw_writer_ensure_ready_rejected(SfWriter *w, ScrDyn *reason) {
  if (!scr_promise_is_pending(w->ready)) {
    scr_promise_release(w->ready);
    w->ready = scr_promise_new();
  }
  sf_reject_promise_reason(w->ready, reason);
  scr_promise_mark_handled(w->ready);
}

static void sfw_writer_ensure_closed_rejected(SfWriter *w, ScrDyn *reason) {
  if (!scr_promise_is_pending(w->closed)) {
    scr_promise_release(w->closed);
    w->closed = scr_promise_new();
  }
  sf_reject_promise_reason(w->closed, reason);
  scr_promise_mark_handled(w->closed);
}

static void sfw_update_backpressure(SfTransform *t, bool backpressure) {
  SfWriter *w = t->writer;
  if (w && backpressure != t->backpressure) {
    if (backpressure) {
      scr_promise_release(w->ready);
      w->ready = scr_promise_new();
      scr_promise_mark_handled(w->ready);
    } else {
      scr_promise_fulfill_void(w->ready);
    }
  }
  t->backpressure = backpressure;
}

static void sfw_reject_close_and_closed(SfTransform *t) {
  if (t->close_request) {
    sf_reject_promise_reason(t->close_request, t->stored_error);
    scr_promise_release(t->close_request);
    t->close_request = NULL;
  }
  if (t->writer) {
    sf_reject_promise_reason(t->writer->closed, t->stored_error);
    scr_promise_mark_handled(t->writer->closed);
  }
}

static void sft_abort_algorithm(SfTransform *t, ScrDyn *reason);

static void sfw_finish_erroring(SfTransform *t) {
  t->state = SFW_ERRORED;
  /* The controller's queue resets; every queued write rejects. */
  while (t->head) {
    SfWriteReq *w = t->head;
    t->head = w->next;
    sf_reject_promise_reason(w->promise, t->stored_error);
    sf_write_req_free(w);
  }
  t->tail = NULL;
  t->queue_size = 0;
  t->close_queued = false;
  if (!t->has_pending_abort) {
    sfw_reject_close_and_closed(t);
    return;
  }
  if (t->pending_abort_was_erroring) {
    t->has_pending_abort = false;
    sf_reject_promise_reason(t->pending_abort, t->stored_error);
    scr_promise_release(t->pending_abort);
    t->pending_abort = NULL;
    scr_dyn_release(t->pending_abort_reason);
    t->pending_abort_reason = NULL;
    sfw_reject_close_and_closed(t);
    return;
  }
  /* The sink's abort runs; its promise settles the abort request. */
  sft_abort_algorithm(t, t->pending_abort_reason);
}

static void sfw_start_erroring(SfTransform *t, ScrDyn *reason) {
  t->state = SFW_ERRORING;
  scr_dyn_release(t->stored_error);
  t->stored_error = scr_dyn_retain(reason);
  if (t->writer) sfw_writer_ensure_ready_rejected(t->writer, reason);
  if (!sfw_has_operation_in_flight(t) && t->started) sfw_finish_erroring(t);
}

static void sfw_deal_with_rejection(SfTransform *t, ScrDyn *error) {
  if (t->state == SFW_WRITABLE) {
    sfw_start_erroring(t, error);
    return;
  }
  sfw_finish_erroring(t);
}

static void sfw_error_if_needed(SfTransform *t, ScrDyn *error) {
  if (t->state == SFW_WRITABLE) sfw_start_erroring(t, error);
}

static void sft_set_backpressure(SfTransform *t, bool backpressure);
static void sft_sink_write(SfTransform *t);
static void sft_sink_close(SfTransform *t);

static void sfw_advance_queue(SfTransform *t) {
  if (!t->started || t->in_flight || t->in_flight_close) return;
  if (t->state == SFW_ERRORING) {
    sfw_finish_erroring(t);
    return;
  }
  if (t->head) {
    SfWriteReq *w = t->head;
    t->head = w->next;
    if (!t->head) t->tail = NULL;
    w->next = NULL;
    t->in_flight = w;
    sft_sink_write(t);
    return;
  }
  if (t->close_queued) {
    t->close_queued = false;
    t->in_flight_close = t->close_request;
    t->close_request = NULL;
    sft_sink_close(t);
  }
}

static void sfw_finish_write(SfTransform *t, ScrDyn *error) {
  SfWriteReq *w = t->in_flight;
  t->in_flight = NULL;
  if (error) {
    sf_reject_promise_reason(w->promise, error);
    sf_write_req_free(w);
    sfw_deal_with_rejection(t, error);
    return;
  }
  scr_promise_fulfill_void(w->promise);
  sf_write_req_free(w);
  if (t->queue_size) t->queue_size--;
  if (!sfw_close_queued_or_in_flight(t) && t->state == SFW_WRITABLE) {
    sfw_update_backpressure(t, t->queue_size >= 1);
  }
  sfw_advance_queue(t);
}

static void sfw_finish_close(SfTransform *t, ScrDyn *error) {
  ScrPromise *p = t->in_flight_close;
  t->in_flight_close = NULL;
  if (error) {
    sf_reject_promise_reason(p, error);
    scr_promise_release(p);
    if (t->has_pending_abort) {
      t->has_pending_abort = false;
      sf_reject_promise_reason(t->pending_abort, error);
      scr_promise_release(t->pending_abort);
      t->pending_abort = NULL;
      scr_dyn_release(t->pending_abort_reason);
      t->pending_abort_reason = NULL;
    }
    sfw_deal_with_rejection(t, error);
    return;
  }
  scr_promise_fulfill_void(p);
  scr_promise_release(p);
  if (t->state == SFW_ERRORING) {
    scr_dyn_release(t->stored_error);
    t->stored_error = NULL;
    if (t->has_pending_abort) {
      t->has_pending_abort = false;
      scr_promise_fulfill_void(t->pending_abort);
      scr_promise_release(t->pending_abort);
      t->pending_abort = NULL;
      scr_dyn_release(t->pending_abort_reason);
      t->pending_abort_reason = NULL;
    }
  }
  t->state = SFW_CLOSED;
  if (t->writer) scr_promise_fulfill_void(t->writer->closed);
}

/* WritableStreamAbort: +1 promise. */
static ScrPromise *sfw_abort(SfTransform *t, ScrDyn *reason) {
  if (t->state == SFW_CLOSED || t->state == SFW_ERRORED) {
    return sf_promise_resolved();
  }
  if (t->has_pending_abort) return scr_promise_retain(t->pending_abort);
  bool was_erroring = t->state == SFW_ERRORING;
  ScrPromise *p = scr_promise_new();
  t->has_pending_abort = true;
  t->pending_abort = scr_promise_retain(p);
  t->pending_abort_reason =
      scr_dyn_retain(was_erroring ? scr_dyn_undefined() : reason);
  t->pending_abort_was_erroring = was_erroring;
  if (!was_erroring) sfw_start_erroring(t, reason);
  return p;
}

/* WritableStreamClose: +1 promise. */
static ScrPromise *sfw_close(SfTransform *t) {
  if (t->state == SFW_CLOSED || t->state == SFW_ERRORED) {
    char message[64];
    snprintf(message, sizeof message, "WritableStream is %s",
             t->state == SFW_CLOSED ? "closed" : "errored");
    return sf_promise_invalid_state(message);
  }
  ScrPromise *p = scr_promise_new();
  t->close_request = scr_promise_retain(p);
  if (t->writer && t->backpressure && t->state == SFW_WRITABLE) {
    scr_promise_fulfill_void(t->writer->ready);
  }
  t->close_queued = true;
  sfw_advance_queue(t);
  return p;
}

/* WritableStreamDefaultWriterWrite: +1 promise. */
static ScrPromise *sfw_writer_write(SfWriter *w, ScrDyn *chunk) {
  SfTransform *t = w->stream;
  if (!t) return sf_promise_invalid_state("Writer is not bound to a WritableStream");
  if (t->state == SFW_ERRORED || t->state == SFW_ERRORING) {
    return sf_promise_rejected_with(t->stored_error);
  }
  if (sfw_close_queued_or_in_flight(t) || t->state == SFW_CLOSED) {
    return sf_promise_invalid_state("WritableStream is closed");
  }
  SfWriteReq *req = calloc(1, sizeof *req);
  if (!req) sf_oom();
  req->chunk = scr_dyn_retain(chunk);
  req->promise = scr_promise_new();
  ScrPromise *p = scr_promise_retain(req->promise);
  if (t->tail) t->tail->next = req;
  else t->head = req;
  t->tail = req;
  t->queue_size++;
  sfw_update_backpressure(t, t->queue_size >= 1);
  sfw_advance_queue(t);
  return p;
}

static SfWriter *sfw_get_writer(SfTransform *t) {
  if (t->writer) {
    sf_invalid_state("WritableStream is locked");
    return NULL;
  }
  SfWriter *w = calloc(1, sizeof *w);
  if (!w) sf_oom();
  w->rc = 1;
  w->stream = t;
  w->ready = scr_promise_new();
  w->closed = scr_promise_new();
  scr_promise_mark_handled(w->ready);
  scr_promise_mark_handled(w->closed);
  switch (t->state) {
    case SFW_WRITABLE:
      if (sfw_close_queued_or_in_flight(t) || !t->backpressure) {
        scr_promise_fulfill_void(w->ready);
      }
      break;
    case SFW_ERRORING:
      sf_reject_promise_reason(w->ready, t->stored_error);
      break;
    case SFW_CLOSED:
      scr_promise_fulfill_void(w->ready);
      scr_promise_fulfill_void(w->closed);
      break;
    default:
      sf_reject_promise_reason(w->ready, t->stored_error);
      sf_reject_promise_reason(w->closed, t->stored_error);
      break;
  }
  t->writer = w;
  w->rc++; /* the stream's ownership */
  return w;
}

static void sfw_writer_release_lock(SfWriter *w) {
  SfTransform *t = w->stream;
  if (!t) return;
  sf_invalid_state("Writer has been released");
  ScrCaught *caught = scr_exc_take();
  ScrDyn *released = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  sfw_writer_ensure_ready_rejected(w, released);
  sfw_writer_ensure_closed_rejected(w, released);
  scr_dyn_release(released);
  size_t handle_refs = w->handle_refs;
  t->writer = NULL;
  w->stream = NULL;
  sf_writer_release(w); /* the stream's ownership */
  while (handle_refs-- > 0) sf_transform_release(t);
}

/* ── TransformStream algorithms (identity transformer) ── */

static void sft_set_backpressure(SfTransform *t, bool backpressure) {
  if (t->bp_change) {
    scr_promise_fulfill_void(t->bp_change);
    scr_promise_release(t->bp_change);
  }
  t->bp_change = scr_promise_new();
  t->t_backpressure = backpressure;
  if (t->write_waiting) {
    t->write_waiting = false;
    sf_transform_defer(t, SFT_WRITE_CONTINUE, 1);
  }
}

/* After an enqueue: whether a read is still waiting. A fetch upload's read
 * was just satisfied by the chunk, and it reads again through the next
 * pull, as a reader's next read() does. */
static bool sft_readable_wants_chunk(const SfStream *r) {
  return r->collector || (r->reader && r->reader->pending_head);
}

/* The readable side is closed or errored: a pull still waiting on
 * bp_change can no longer receive a chunk, so complete it. */
static void sft_finish_pull(SfTransform *t) {
  if (t->bp_change && scr_promise_is_pending(t->bp_change)) scr_promise_fulfill_void(t->bp_change);
}

static bool sft_readable_can_enqueue(const SfStream *r) {
  return !r->close_requested && !r->closed && !r->error;
}

/* TransformStreamErrorWritableAndUnblockWrite */
static void sft_error_writable(SfTransform *t, ScrDyn *error) {
  sfw_error_if_needed(t, error);
  if (t->t_backpressure) sft_set_backpressure(t, false);
}

/* The identity transform's enqueue: NULL on success, else +1 error. */
static ScrDyn *sft_perform_transform(SfTransform *t, ScrDyn *chunk) {
  SfStream *r = t->readable;
  if (!sft_readable_can_enqueue(r)) {
    sf_invalid_state("Unable to enqueue");
    ScrCaught *caught = scr_exc_take();
    ScrDyn *error = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    sft_error_writable(t, error);
    return error;
  }
  sf_stream_enqueue_value(r, chunk);
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *error = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    sf_stream_error(r, error);
    sft_error_writable(t, error);
    return error;
  }
  bool backpressure = !sft_readable_wants_chunk(r);
  if (backpressure != t->t_backpressure) sft_set_backpressure(t, true);
  return NULL;
}

static void sft_sink_write(SfTransform *t) {
  if (t->t_backpressure) {
    t->write_waiting = true;
    return;
  }
  ScrDyn *error = sft_perform_transform(t, t->in_flight->chunk);
  if (error) {
    scr_dyn_release(t->write_error);
    t->write_error = error;
  }
  sf_transform_defer(t, SFT_WRITE_DONE, 2);
}

static void sft_sink_close(SfTransform *t) {
  if (!t->finish) {
    t->finish = scr_promise_new();
    scr_promise_mark_handled(t->finish);
    sf_transform_defer(t, SFT_CLOSE_DONE, 1);
    return;
  }
  /* A cancel or abort already finished the transform. */
  sf_transform_defer(t, SFT_CLOSE_DONE, 1);
}

static void sft_abort_algorithm(SfTransform *t, ScrDyn *reason) {
  (void)reason;
  t->abort_joins_finish = t->finish != NULL;
  if (!t->finish) {
    t->finish = scr_promise_new();
    scr_promise_mark_handled(t->finish);
  }
  sf_transform_defer(t, SFT_ABORT_DONE, 1);
}

static void sf_transform_step(SfTransform *t, int op) {
  switch (op) {
    case SFT_WRITE_CONTINUE: {
      if (!t->in_flight) return;
      if (t->state == SFW_ERRORING) {
        ScrDyn *error = scr_dyn_retain(t->stored_error);
        scr_dyn_release(t->write_error);
        t->write_error = error;
      } else {
        ScrDyn *error = sft_perform_transform(t, t->in_flight->chunk);
        if (error) {
          scr_dyn_release(t->write_error);
          t->write_error = error;
        }
      }
      sf_transform_defer(t, SFT_WRITE_DONE, 3);
      return;
    }
    case SFT_WRITE_DONE: {
      if (!t->in_flight) return;
      ScrDyn *error = t->write_error;
      t->write_error = NULL;
      sfw_finish_write(t, error);
      scr_dyn_release(error);
      return;
    }
    case SFT_CLOSE_DONE: {
      SfStream *r = t->readable;
      ScrDyn *error = NULL;
      if (r->error) {
        error = scr_dyn_retain(r->error);
      } else {
        sf_stream_close(r);
      }
      sft_finish_pull(t);
      if (error) sf_reject_promise_reason(t->finish, error);
      else scr_promise_fulfill_void(t->finish);
      if (t->in_flight_close) sfw_finish_close(t, error);
      scr_dyn_release(error);
      return;
    }
    case SFT_ABORT_DONE: {
      SfStream *r = t->readable;
      scr_dyn_release(t->abort_settle_error);
      t->abort_settle_error = NULL;
      if (t->abort_joins_finish && !scr_promise_is_pending(t->finish)) {
        /* The cancel or close that created the finish promise settled
         * it; the abort request takes its result. */
        if (scr_promise_is_rejected(t->finish))
          t->abort_settle_error = scr_promise_reason_dyn(t->finish);
      } else {
        ScrDyn *reason = t->pending_abort_reason
                             ? scr_dyn_retain(t->pending_abort_reason)
                             : scr_dyn_retain(scr_dyn_undefined());
        bool readable_errored = r->error != NULL;
        if (!readable_errored) sf_stream_error(r, reason);
        sft_finish_pull(t);
        /* The sink abort algorithm's finish promise, which a
         * readable.cancel() after the abort answers too: rejected with the
         * readable side's stored error when it had already errored, else
         * resolved. */
        if (t->finish && scr_promise_is_pending(t->finish)) {
          if (readable_errored) sf_reject_promise_reason(t->finish, r->error);
          else scr_promise_fulfill_void(t->finish);
        }
        if (readable_errored) t->abort_settle_error = scr_dyn_retain(r->error);
        scr_dyn_release(reason);
      }
      /* WritableStreamFinishErroring settles the abort request in a
       * reaction to the sink abort's promise, two turns after it. */
      sf_transform_defer(t, SFT_ABORT_SETTLE, 2);
      return;
    }
    case SFT_ABORT_SETTLE: {
      ScrDyn *error = t->abort_settle_error;
      t->abort_settle_error = NULL;
      if (t->has_pending_abort) {
        t->has_pending_abort = false;
        if (error) sf_reject_promise_reason(t->pending_abort, error);
        else scr_promise_fulfill_void(t->pending_abort);
        scr_promise_release(t->pending_abort);
        t->pending_abort = NULL;
        scr_dyn_release(t->pending_abort_reason);
        t->pending_abort_reason = NULL;
      }
      sfw_reject_close_and_closed(t);
      scr_dyn_release(error);
      return;
    }
    case SFT_CANCEL_DONE: {
      ScrDyn *reason = t->cancel_reason;
      t->cancel_reason = NULL;
      if (t->state == SFW_ERRORED) {
        sf_reject_promise_reason(t->finish, t->stored_error);
      } else {
        sfw_error_if_needed(t, reason ? reason : scr_dyn_undefined());
        if (t->t_backpressure) sft_set_backpressure(t, false);
        sft_finish_pull(t);
        scr_promise_fulfill_void(t->finish);
      }
      scr_dyn_release(reason);
      return;
    }
    case SFT_START: {
      /* Both sides start one turn after construction, the writable side
       * first (Node registers its start reaction first). */
      t->started = true;
      sfw_advance_queue(t);
      SfStream *r = t->readable;
      r->started = true;
      if (!r->close_requested && !r->closed && !r->error) {
        sf_stream_drain(r);
        sf_stream_pull(r);
      }
      return;
    }
  }
}

/* The readable side's pull: release backpressure; the pull completes when
 * backpressure changes again. */
static ScrDyn *sft_pull_thunk(ScrClosure *cb, ScrDyn *const *args,
                              size_t argc) {
  (void)args;
  (void)argc;
  SfTransform *t = (SfTransform *)scr_box_get_ref(cb->caps[0]);
  sft_set_backpressure(t, false);
  ScrDyn *out = scr_dyn_new_promise(t->bp_change);
  sf_transform_release(t);
  return out;
}

/* The readable side's cancel (TransformStreamDefaultSourceCancelAlgorithm):
 * errors the writable side with the reason and unblocks a waiting write. */
static ScrDyn *sft_cancel_thunk(ScrClosure *cb, ScrDyn *const *args,
                                size_t argc) {
  SfTransform *t = (SfTransform *)scr_box_get_ref(cb->caps[0]);
  ScrDyn *reason = argc ? args[0] : scr_dyn_undefined();
  if (!t->finish) {
    t->finish = scr_promise_new();
    scr_promise_mark_handled(t->finish);
    scr_dyn_release(t->cancel_reason);
    t->cancel_reason = scr_dyn_retain(reason);
    /* The (identity) cancel algorithm's resolved promise reacts a turn
     * later. */
    sf_transform_defer(t, SFT_CANCEL_DONE, 1);
  }
  ScrDyn *out = scr_dyn_new_promise(t->finish);
  sf_transform_release(t);
  return out;
}

static ScrDyn *sft_func(SfTransform *t, ScrDynThunk thunk, const char *name) {
  ScrClosure *cb = scr_closure_new((void *)thunk, 1);
  cb->caps[0] = sf_transform_box(t);
  return scr_dyn_new_func(cb, thunk, 1, "(controller)", name);
}

ScrDyn *scr_fetch_transform_new(void) {
  SfTransform *t = calloc(1, sizeof *t);
  if (!t) sf_oom();
  t->rc = 1;
  t->state = SFW_WRITABLE;
  SfStream *r = sf_stream_new_native();
  r->started = false;
  r->hwm_zero = true;
  r->pull_cb = sft_func(t, &sft_pull_thunk, "pull");
  r->cancel_cb = sft_func(t, &sft_cancel_thunk, "cancel");
  r->source_this = scr_dyn_retain(scr_dyn_undefined());
  sf_stream_track_callbacks(r);
  t->readable = r;
  /* The writable side's high-water mark of 1 leaves room: no backpressure.
   * The readable side's 0 does: writes wait for a read. */
  t->backpressure = false;
  sft_set_backpressure(t, true);
  sf_transform_defer(t, SFT_START, 1);
  ScrDyn *out = scr_dyn_new_handle(t, SCR_DYNH_WEB_TRANSFORM);
  sf_transform_release(t);
  return out;
}

static ScrDyn *sf_transform_get(void *ptr, const char *key, size_t len) {
  SfTransform *t = ptr;
  if (sf_name(key, len, "readable")) {
    return scr_dyn_new_handle(t->readable, SCR_DYNH_WEB_STREAM);
  }
  if (sf_name(key, len, "writable")) {
    return scr_dyn_new_handle(t, SCR_DYNH_WEB_WRITABLE);
  }
  return NULL;
}

static ScrDyn *sf_transform_invoke(void *ptr, ScrDyn *self,
                                   const char *method, ScrDyn *const *args,
                                   size_t argc, const char *what) {
  (void)ptr;
  (void)self;
  (void)args;
  (void)argc;
  (void)method;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_promise_dyn(ScrPromise *p) {
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return out;
}

static ScrDyn *sf_writable_invoke(void *ptr, ScrDyn *self,
                                  const char *method, ScrDyn *const *args,
                                  size_t argc, const char *what) {
  SfTransform *t = ptr;
  (void)self;
  if (strcmp(method, "getWriter") == 0) {
    SfWriter *w = sfw_get_writer(t);
    if (!w) return NULL;
    ScrDyn *out = scr_dyn_new_handle(w, SCR_DYNH_WEB_WRITER);
    sf_writer_release(w);
    return out;
  }
  if (strcmp(method, "abort") == 0) {
    if (t->writer) {
      return sf_promise_dyn(
          sf_promise_invalid_state("WritableStream is locked"));
    }
    return sf_promise_dyn(sfw_abort(t, argc ? args[0] : scr_dyn_undefined()));
  }
  if (strcmp(method, "close") == 0) {
    if (t->writer) {
      return sf_promise_dyn(
          sf_promise_invalid_state("WritableStream is locked"));
    }
    if (sfw_close_queued_or_in_flight(t)) {
      return sf_promise_dyn(
          sf_promise_invalid_state("WritableStream is closed"));
    }
    return sf_promise_dyn(sfw_close(t));
  }
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_writable_get(void *ptr, const char *key, size_t len) {
  SfTransform *t = ptr;
  if (sf_name(key, len, "locked")) return scr_dyn_new_bool(t->writer != NULL);
  return NULL;
}

static ScrDyn *sf_writer_invoke(void *ptr, ScrDyn *self, const char *method,
                                ScrDyn *const *args, size_t argc,
                                const char *what) {
  SfWriter *w = ptr;
  (void)self;
  if (strcmp(method, "write") == 0) {
    return sf_promise_dyn(
        sfw_writer_write(w, argc ? args[0] : scr_dyn_undefined()));
  }
  if (strcmp(method, "close") == 0) {
    SfTransform *t = w->stream;
    if (!t) {
      return sf_promise_dyn(sf_promise_invalid_state(
          "Writer is not bound to a WritableStream"));
    }
    if (sfw_close_queued_or_in_flight(t)) {
      return sf_promise_dyn(
          sf_promise_invalid_state("WritableStream is closed"));
    }
    return sf_promise_dyn(sfw_close(t));
  }
  if (strcmp(method, "abort") == 0) {
    SfTransform *t = w->stream;
    if (!t) {
      return sf_promise_dyn(sf_promise_invalid_state(
          "Writer is not bound to a WritableStream"));
    }
    return sf_promise_dyn(sfw_abort(t, argc ? args[0] : scr_dyn_undefined()));
  }
  if (strcmp(method, "releaseLock") == 0) {
    sfw_writer_release_lock(w);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_writer_get(void *ptr, const char *key, size_t len) {
  SfWriter *w = ptr;
  if (sf_name(key, len, "ready")) return scr_dyn_new_promise(w->ready);
  if (sf_name(key, len, "closed")) return scr_dyn_new_promise(w->closed);
  if (sf_name(key, len, "desiredSize")) {
    SfTransform *t = w->stream;
    if (!t) {
      sf_invalid_state("Writer is not bound to a WritableStream");
      return NULL;
    }
    if (t->state == SFW_ERRORED || t->state == SFW_ERRORING) {
      return scr_dyn_new_null();
    }
    if (t->state == SFW_CLOSED) return scr_dyn_new_num(0);
    return scr_dyn_new_num(1.0 - (double)t->queue_size);
  }
  return NULL;
}

/* ── Response ────────────────────────────────────────────────────── */

static SfResponse *sf_response_retain(SfResponse *r) {
  r->rc++;
  return r;
}

static void sf_response_release(SfResponse *r) {
  if (!r || --r->rc > 0) return;
  scr_weak_dispose_inline(r);
  sf_stream_release(r->body);
  sf_headers_release(r->headers);
  scr_str_release(r->url);
  scr_str_release(r->status_text);
  scr_arr_release(r->light_record);
  free(r);
}

static void *sf_response_retain_v(void *p) {
  return sf_response_retain((SfResponse *)p);
}
static void sf_response_release_v(void *p) {
  sf_response_release((SfResponse *)p);
}

/* A read the package's lightweight Response answers from its native
 * response materializes it; status, ok and headers keep it light, and a
 * headers read turns the header form into a Headers object. */
static void sf_response_materialize(SfResponse *r) {
  r->light = 0;
}

static ScrPromise *sf_response_collect(SfResponse *r, int mode) {
  if (!r->null_body) return sf_stream_collect(r->body, mode);

  /*
   * A null body is not a disturbed empty stream: body stays null,
   * bodyUsed stays false, and the body readers may be called repeatedly.
   * Each call therefore consumes its own empty payload.
   */
  ScrPromise *p = scr_promise_new();
  ScrDyn *value = NULL;
  if (mode == SF_COLLECT_JSON) {
    ScrStr *empty = scr_str_new("", 0);
    value = scr_json_parse(empty);
    scr_str_release(empty);
  } else if (mode == SF_COLLECT_TEXT) {
    ScrStr *empty = scr_str_new("", 0);
    value = scr_dyn_new_str(empty);
    scr_str_release(empty);
  } else {
    ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);
    value = mode == SF_COLLECT_ARRAY_BUFFER ? scr_array_buffer_from_bytes(empty) : scr_dyn_new_bytes(empty);
    scr_bytes_release(empty);
  }
  if (scr_exc_pending()) {
    scr_dyn_release(value);
    scr_promise_reject_pending(p);
  } else {
    scr_promise_fulfill_ref(p, value, &scr_dyn_retain_v,
                            &scr_dyn_release_v, NULL);
  }
  return p;
}

/* The body and metadata copy of Response.clone and Request.clone (undici
 * cloneResponse/cloneBody): the body tees, so the original and the clone
 * each keep one branch, and the clone's headers are a copy with the same
 * guard. NULL with a TypeError pending when the body is unusable. */
static SfResponse *sf_response_clone(SfResponse *r, const char *unusable) {
  if (!r->null_body &&
      (r->body->disturbed || r->body->reader || r->body->internal_lock || sf_view_unusable(r->body))) {
    sf_type_error(unusable);
    return NULL;
  }
#ifdef SCR_HANDLE_CLASSES
  /* A body with a web view tees through it; each side reads one branch. */
  SfStream *viewed[2] = {NULL, NULL};
  if (!r->null_body && r->body->web_view) {
    ScrDyn *branches = scr_dyn_invoke(r->body->web_view, "tee", NULL, 0, "ReadableStream.tee");
    if (!branches) return NULL;
    for (int i = 0; i < 2; i++) {
      ScrDyn *reading = sf_web_body(branches->v.arr.items[i]);
      if (!reading) {
        sf_stream_release(viewed[0]);
        scr_dyn_release(branches);
        return NULL;
      }
      viewed[i] = sf_stream_retain((SfStream *)reading->v.handle.ptr);
      viewed[i]->u8_chunks = r->body->u8_chunks;
      scr_dyn_release(reading);
    }
    scr_dyn_release(branches);
  }
#endif
  SfResponse *c = calloc(1, sizeof *c);
  if (!c) sf_oom();
  c->rc = 1;
  if (r->null_body) {
    c->body = sf_stream_new_native();
    sf_stream_close(c->body);
  } else {
    SfStream *branches[2];
#ifdef SCR_HANDLE_CLASSES
    if (viewed[0]) {
      branches[0] = viewed[0];
      branches[1] = viewed[1];
    } else {
      sf_stream_tee(r->body, branches);
    }
#else
    sf_stream_tee(r->body, branches);
#endif
    sf_stream_release(r->body);
    r->body = branches[0];
    c->body = branches[1];
  }
  c->headers = sf_headers_new(scr_arr_slice(r->headers->pairs, 0, INFINITY),
                              r->headers->immutable);
  c->url = scr_str_retain(r->url);
  c->status_text = scr_str_retain(r->status_text);
  c->status = r->status;
  c->redirected = r->redirected;
  c->null_body = r->null_body;
  c->light_length = r->light_length;
  return c;
}

static ScrDyn *sf_response_invoke(void *ptr, ScrDyn *self,
                                  const char *method,
                                  ScrDyn *const *args, size_t argc,
                                  const char *what) {
  SfResponse *r = ptr;
  sf_response_materialize(r);
  if (strcmp(method, "clone") == 0) {
    SfResponse *c = sf_response_clone(
        r, "Response.clone: Body has already been consumed.");
    if (!c) return NULL;
    ScrDyn *out = scr_dyn_new_handle(c, SCR_DYNH_FETCH_RESPONSE);
    sf_response_release(c);
    return out;
  }
  int mode = -1;
  if (strcmp(method, "json") == 0) mode = SF_COLLECT_JSON;
  else if (strcmp(method, "text") == 0) mode = SF_COLLECT_TEXT;
  else if (strcmp(method, "bytes") == 0) mode = SF_COLLECT_BYTES;
  else if (strcmp(method, "arrayBuffer") == 0) mode = SF_COLLECT_ARRAY_BUFFER;
  if (mode >= 0) {
    ScrPromise *p = sf_response_collect(r, mode);
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  (void)args;
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_response_get(void *ptr, const char *key, size_t len) {
  SfResponse *r = ptr;
  if (sf_name(key, len, "status")) return scr_dyn_new_num((double)r->status);
  if (sf_name(key, len, "ok")) {
    return scr_dyn_new_bool(r->status >= 200 && r->status <= 299);
  }
  if (sf_name(key, len, "headers")) {
    if (r->light == 1) {
      r->light = 2;
      r->light_default_ct = !r->null_body;
    } else if (r->light == 3) {
      r->light = 2;
    }
    return scr_dyn_new_handle(r->headers, SCR_DYNH_FETCH_HEADERS);
  }
  if (sf_name(key, len, "body") || sf_name(key, len, "bodyUsed") ||
      sf_name(key, len, "url") || sf_name(key, len, "redirected") ||
      sf_name(key, len, "statusText"))
    sf_response_materialize(r);
  if (sf_name(key, len, "bodyUsed")) {
#ifdef SCR_HANDLE_CLASSES
    /* A read, cancel or pipe started on the web view disturbs it at once,
     * before its pull reaches this stream. */
    if (!r->null_body && r->body->web_view && scr_web_stream_bridge->disturbed(r->body->web_view))
      return scr_dyn_new_bool(true);
#endif
    return scr_dyn_new_bool(!r->null_body && r->body->disturbed);
  }
  if (sf_name(key, len, "body")) {
    return r->null_body
               ? scr_dyn_new_null()
               : scr_dyn_new_handle(r->body, SCR_DYNH_WEB_STREAM);
  }
  if (sf_name(key, len, "url")) return scr_dyn_new_str(r->url);
  if (sf_name(key, len, "redirected")) {
    return scr_dyn_new_bool(r->redirected);
  }
  if (sf_name(key, len, "statusText")) {
    return scr_dyn_new_str(r->status_text);
  }
  return NULL;
}

static ScrPromise *sf_response_collect_dyn(ScrDyn *response, int mode) {
  if (!response || response->kind != SCR_DYN_HANDLE ||
      response->v.handle.tag != SCR_DYNH_FETCH_RESPONSE) {
    sf_type_error("Illegal invocation");
    return scr_promise_settled_ref(NULL, &scr_dyn_retain_v,
                                   &scr_dyn_release_v, NULL);
  }
  SfResponse *r = response->v.handle.ptr;
  sf_response_materialize(r);
  return sf_response_collect(r, mode);
}

ScrPromise *scr_fetch_response_json(ScrDyn *response) {
  return sf_response_collect_dyn(response, SF_COLLECT_JSON);
}

ScrPromise *scr_fetch_response_text(ScrDyn *response) {
  return sf_response_collect_dyn(response, SF_COLLECT_TEXT);
}

ScrPromise *scr_fetch_response_array_buffer(ScrDyn *response) {
  return sf_response_collect_dyn(response, SF_COLLECT_ARRAY_BUFFER);
}

ScrPromise *scr_fetch_response_bytes(ScrDyn *response) {
  return sf_response_collect_dyn(response, SF_COLLECT_BYTES);
}

/* ── fetch transfer ──────────────────────────────────────────────── */

static SfTransfer *sf_retain(SfTransfer *t) {
  t->rc++;
  return t;
}

static void sf_release(SfTransfer *t) {
  if (--t->rc > 0) return;
  scr_promise_release(t->promise);
  scr_url_release(t->url);
  scr_str_release(t->method);
  scr_arr_release(t->headers);
  scr_dyn_release(t->body);
  if (t->client) scr_http_client_release(t->client);
  scr_net_sock_release(t->response_socket);
  scr_bytes_release(t->inflate_pending);
  if (t->inflating) inflateEnd(&t->zs);
  sf_watch_free(t->signal_watch);
  sf_signal_release(t->signal);
  sf_stream_release(t->request_stream);
  sf_stream_release(t->response_stream);
  free(t);
}

static void *sf_retain_v(void *p) { return sf_retain((SfTransfer *)p); }
static void sf_release_v(void *p) { sf_release((SfTransfer *)p); }

static ScrClosure *sf_closure(SfTransfer *t, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(&sf_retain_v, &sf_release_v, NULL);
  scr_box_set_ref(box, sf_retain(t));
  cb->caps[0] = box;
  return cb;
}

static SfTransfer *sf_from(ScrClosure *cb) {
  return (SfTransfer *)scr_box_get_ref(cb->caps[0]);
}

static void sf_settle(SfTransfer *t) {
  if (t->done) return;
  t->done = true;
  if (t->signal_watch) {
    sf_watch_free(t->signal_watch);
    t->signal_watch = NULL;
  }
  if (t->request_stream && t->request_stream->request_owner == t) {
    t->request_stream->request_owner = NULL;
  }
  if (t->response_stream && t->response_stream->response_owner == t) {
    t->response_stream->response_owner = NULL;
  }
  if (t->client) {
    scr_http_client_release(t->client);
    t->client = NULL;
  }
  if (t->response_socket) {
    scr_net_sock_release(t->response_socket);
    t->response_socket = NULL;
    t->response_paused = false;
  }
  if (t->live) {
#ifdef SCR_RC_AUDIT
    /* the transfer is reachable from the head and its neighbors point
     * back at it */
    const SfTransfer *it = sf_live;
    while (it != NULL && it != t) it = it->next;
    if (it == NULL || (t->prev ? t->prev->next != t : sf_live != t) ||
        (t->next != NULL && t->next->prev != t)) {
      fprintf(stderr, "scr_fetch: the live transfer list's links disagree\n");
      abort();
    }
#endif
    t->live = false;
    if (t->prev) t->prev->next = t->next;
    else sf_live = t->next;
    if (t->next) t->next->prev = t->prev;
    t->prev = t->next = NULL;
    sf_release(t); /* registry reference */
  }
}

static void sf_reject(SfTransfer *t, const char *message) {
  if (t->done) return;
  sf_type_error(message);
  scr_promise_reject_pending(t->promise);
  sf_settle(t);
}

static void sf_reject_reason(SfTransfer *t, ScrDyn *reason) {
  if (t->done) return;
  sf_reject_promise_reason(t->promise, reason);
  sf_settle(t);
}

static void sf_transfer_abort_watch(SfSignalWatch *w, SfSignal *signal) {
  SfTransfer *t = w->owner;
  if (t->done) return;
  ScrDyn *reason = sf_signal_reason_ref(signal);
  if (t->request_stream && t->request_stream->request_owner == t) {
    SfStream *request = t->request_stream;
    request->request_owner = NULL;
    if (!request->close_requested && !request->closed && !request->error) {
      request->request_discarding = true;
      sf_stream_drain(request);
      sf_stream_pull(request);
    }
  }
  if (t->client) scr_http_client_destroy(t->client);
  if (t->response_sent && t->response_stream) {
    sf_stream_error(t->response_stream, reason);
    sf_settle(t);
  } else {
    sf_reject_reason(t, reason);
  }
  scr_dyn_release(reason);
}

static void sf_transfer_stream_error(SfTransfer *t, ScrDyn *reason) {
  if (!t || t->done) return;
  if (t->client) scr_http_client_destroy(t->client);
  if (t->response_sent && t->response_stream) {
    sf_stream_error(t->response_stream, reason);
    sf_settle(t);
  } else {
    sf_reject(t, "fetch failed");
  }
}

static bool sf_eq_ci(const ScrStr *s, const char *lit) {
  size_t n = strlen(lit);
  if (s->len != n) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s->data[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != lit[i]) return false;
  }
  return true;
}

static ScrStr *sf_bare_host(const ScrStr *host) {
  if (host->len >= 2 && host->data[0] == '[' &&
      host->data[host->len - 1] == ']') {
    return scr_str_new(host->data + 1, host->len - 2);
  }
  return scr_str_retain((ScrStr *)host);
}

static int sf_port(const ScrUrl *u, int dflt) {
  if (u->port->len == 0) return dflt;
  int p = 0;
  for (size_t i = 0; i < u->port->len; i++) {
    p = p * 10 + (u->port->data[i] - '0');
  }
  return p;
}

static bool sf_bad_port(int port) {
  static const int ports[] = {SCR_FETCH_BAD_PORTS};
  for (size_t i = 0; i < sizeof ports / sizeof ports[0]; i++) {
    if (port == ports[i]) return true;
  }
  return false;
}

static ScrStr *sf_path(const ScrUrl *u) {
  size_t plen = (u->path->len > 0 ? u->path->len : 1) + u->query->len;
  char *buf = malloc(plen);
  if (!buf) sf_oom();
  size_t n = 0;
  if (u->path->len > 0) {
    memcpy(buf, u->path->data, u->path->len);
    n = u->path->len;
  } else {
    buf[n++] = '/';
  }
  memcpy(buf + n, u->query->data, u->query->len);
  n += u->query->len;
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

static ScrStr *sf_url_serialize(const ScrUrl *u) {
  size_t cap = u->scheme->len + u->userinfo->len + u->host->len +
               u->port->len + u->path->len + u->query->len + 8;
  char *buf = malloc(cap);
  if (!buf) sf_oom();
  size_t n = 0;
  memcpy(buf + n, u->scheme->data, u->scheme->len);
  n += u->scheme->len;
  buf[n++] = ':';
  if (u->has_authority) {
    buf[n++] = '/';
    buf[n++] = '/';
    if (u->userinfo->len > 0) {
      memcpy(buf + n, u->userinfo->data, u->userinfo->len);
      n += u->userinfo->len;
      buf[n++] = '@';
    }
    memcpy(buf + n, u->host->data, u->host->len);
    n += u->host->len;
    if (u->port->len > 0) {
      buf[n++] = ':';
      memcpy(buf + n, u->port->data, u->port->len);
      n += u->port->len;
    }
  }
  if (u->path->len > 0) {
    memcpy(buf + n, u->path->data, u->path->len);
    n += u->path->len;
  } else {
    buf[n++] = '/';
  }
  memcpy(buf + n, u->query->data, u->query->len);
  n += u->query->len;
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

static ScrUrl *sf_url_parse_quiet(ScrStr *text) {
  ScrUrl *url = scr_url_new(text);
  if (!url) scr_exc_clear();
  return url;
}

static bool sf_proxy_enabled;
static char *sf_http_proxy;
static char *sf_https_proxy;
static char *sf_all_proxy;
static char *sf_no_proxy;

static char *sf_env_copy(const char *lower, const char *upper) {
  const char *value = scr_getenv(lower);
  if (!value || value[0] == '\0') value = scr_getenv(upper);
  if (!value || value[0] == '\0') return NULL;
  size_t len = strlen(value);
  char *copy = malloc(len + 1);
  if (!copy) sf_oom();
  memcpy(copy, value, len + 1);
  return copy;
}

static void sf_proxy_snapshot(void) {
  const char *optin = scr_getenv("NODE_USE_ENV_PROXY");
  sf_proxy_enabled = optin && strcmp(optin, "1") == 0;
  if (!sf_proxy_enabled) return;
  sf_http_proxy = sf_env_copy("http_proxy", "HTTP_PROXY");
  sf_https_proxy = sf_env_copy("https_proxy", "HTTPS_PROXY");
  sf_all_proxy = sf_env_copy("all_proxy", "ALL_PROXY");
  sf_no_proxy = sf_env_copy("no_proxy", "NO_PROXY");
}

static void sf_proxy_snapshot_free(void) {
  free(sf_http_proxy);
  free(sf_https_proxy);
  free(sf_all_proxy);
  free(sf_no_proxy);
  sf_http_proxy = sf_https_proxy = sf_all_proxy = sf_no_proxy = NULL;
}

static int sf_hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* EnvHttpProxyAgent sends Basic proxy authentication only when the proxy
 * URL has both a username and a password. */
static bool sf_proxy_has_credentials(const ScrStr *userinfo) {
  const char *colon = memchr(userinfo->data, ':', userinfo->len);
  return colon != NULL && colon != userinfo->data &&
         colon + 1 < userinfo->data + userinfo->len;
}

/* EnvHttpProxyAgent derives Basic proxy authentication from the proxy URL's
 * decoded username/password. ScrUrl keeps the encoded userinfo as one string,
 * so decode it here. */
static ScrStr *sf_proxy_authorization(const ScrStr *userinfo) {
  char *plain = malloc(userinfo->len + 1);
  if (!plain) sf_oom();
  size_t plain_len = 0;
  for (size_t i = 0; i < userinfo->len;) {
    char c = userinfo->data[i];
    if (c == '%' && i + 2 < userinfo->len) {
      int hi = sf_hex_value(userinfo->data[i + 1]);
      int lo = sf_hex_value(userinfo->data[i + 2]);
      if (hi >= 0 && lo >= 0) {
        plain[plain_len++] = (char)((hi << 4) | lo);
        i += 3;
        continue;
      }
    }
    plain[plain_len++] = c;
    i++;
  }

  static const char b64[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t encoded_len = ((plain_len + 2) / 3) * 4;
  char *header = malloc(6 + encoded_len);
  if (!header) sf_oom();
  memcpy(header, "Basic ", 6);
  size_t out = 6;
  for (size_t i = 0; i < plain_len; i += 3) {
    unsigned b0 = (unsigned char)plain[i];
    unsigned b1 = i + 1 < plain_len ? (unsigned char)plain[i + 1] : 0;
    unsigned b2 = i + 2 < plain_len ? (unsigned char)plain[i + 2] : 0;
    unsigned triple = (b0 << 16) | (b1 << 8) | b2;
    header[out++] = b64[(triple >> 18) & 63];
    header[out++] = b64[(triple >> 12) & 63];
    header[out++] = i + 1 < plain_len ? b64[(triple >> 6) & 63] : '=';
    header[out++] = i + 2 < plain_len ? b64[triple & 63] : '=';
  }
  free(plain);
  ScrStr *result = scr_str_new(header, out);
  free(header);
  return result;
}

static bool sf_no_proxy_match(const char *list, const ScrStr *host,
                              int port) {
  const char *p = list;
  while (*p) {
    while (*p == ',' || *p == ' ' || *p == '\t') p++;
    const char *start = p;
    while (*p && *p != ',' && *p != ' ' && *p != '\t') p++;
    size_t len = (size_t)(p - start);
    if (len == 0) continue;
    if (len == 1 && start[0] == '*') return true;
    size_t host_len = len;
    long entry_port = -1;
    if (start[0] == '[') {
      size_t close = 1;
      while (close < len && start[close] != ']') close++;
      if (close < len && close + 1 < len && start[close + 1] == ':') {
        host_len = close + 1;
        entry_port = strtol(start + close + 2, NULL, 10);
      }
    } else {
      for (size_t i = 0; i < len; i++) {
        if (start[i] == ':') {
          host_len = i;
          entry_port = strtol(start + i + 1, NULL, 10);
          break;
        }
      }
    }
    if (host_len >= 2 && start[0] == '*' && start[1] == '.') {
      start += 2;
      host_len -= 2;
    } else if (host_len > 0 && start[0] == '.') {
      start++;
      host_len--;
    }
    if (host_len == 0 || (entry_port >= 0 && entry_port != port)) {
      continue;
    }
    size_t offset = host->len >= host_len ? host->len - host_len : 0;
    bool boundary =
        host->len == host_len ||
        (host->len > host_len && host->data[offset - 1] == '.');
    if (!boundary) continue;
    bool equal = true;
    for (size_t i = 0; i < host_len; i++) {
      char a = host->data[offset + i];
      char b = start[i];
      if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
      if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
      if (a != b) {
        equal = false;
        break;
      }
    }
    if (equal) return true;
  }
  return false;
}

static ScrUrl *sf_proxy_for(const ScrUrl *target, bool https,
                            int target_port, bool *invalid) {
  *invalid = false;
  if (!sf_proxy_enabled) return NULL;
  const char *proxy = https ? sf_https_proxy : sf_http_proxy;
  if (!proxy) proxy = sf_all_proxy;
  if (!proxy) return NULL;
  if (sf_no_proxy &&
      sf_no_proxy_match(sf_no_proxy, target->host, target_port)) {
    return NULL;
  }
  ScrStr *text = scr_str_new(proxy, strlen(proxy));
  ScrUrl *url = sf_url_parse_quiet(text);
  scr_str_release(text);
  *invalid = url == NULL;
  return url;
}

static bool sf_same_scheme_relative(const ScrUrl *base,
                                    const ScrStr *location) {
  if (location->len <= base->scheme->len ||
      location->data[base->scheme->len] != ':') {
    return false;
  }
  for (size_t i = 0; i < base->scheme->len; i++) {
    char a = location->data[i];
    char b = base->scheme->data[i];
    if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
    if (a != b) return false;
  }
  size_t tail = base->scheme->len + 1;
  return location->len - tail < 2 ||
         !((location->data[tail] == '/' ||
            location->data[tail] == '\\') &&
           (location->data[tail + 1] == '/' ||
            location->data[tail + 1] == '\\'));
}

static ScrUrl *sf_resolve_url(const ScrUrl *base, const ScrStr *location) {
  bool same_scheme_relative = sf_same_scheme_relative(base, location);
  const char *ref_data =
      location->data +
      (same_scheme_relative ? base->scheme->len + 1 : 0);
  size_t ref_len =
      location->len -
      (same_scheme_relative ? base->scheme->len + 1 : 0);
  if (!same_scheme_relative) {
    ScrStr *absolute = scr_str_new(location->data, location->len);
    ScrUrl *parsed = sf_url_parse_quiet(absolute);
    scr_str_release(absolute);
    if (parsed) return parsed;
  }

  /*
   * Empty and fragment-only references preserve the complete base path
   * and query. The request serializer drops the resulting fragment, but
   * resolving it first is significant: `Location: #next` re-requests
   * `/a/start`, not its parent `/a/`.
   */
  if (ref_len == 0 || ref_data[0] == '#') {
    ScrStr *base_text = sf_url_serialize(base);
    size_t len = base_text->len + ref_len;
    char *joined = malloc(len);
    if (!joined) sf_oom();
    memcpy(joined, base_text->data, base_text->len);
    memcpy(joined + base_text->len, ref_data, ref_len);
    ScrStr *text = scr_str_new(joined, len);
    free(joined);
    scr_str_release(base_text);
    ScrUrl *out = sf_url_parse_quiet(text);
    scr_str_release(text);
    return out;
  }

  size_t cap = base->scheme->len + base->userinfo->len + base->host->len +
               base->port->len + base->path->len + base->query->len +
               ref_len + 16;
  char *buf = malloc(cap);
  if (!buf) sf_oom();
  size_t n = 0;
  memcpy(buf + n, base->scheme->data, base->scheme->len);
  n += base->scheme->len;
  buf[n++] = ':';
  if (ref_len >= 2 &&
      (ref_data[0] == '/' || ref_data[0] == '\\') &&
      (ref_data[1] == '/' || ref_data[1] == '\\')) {
    memcpy(buf + n, ref_data, ref_len);
    n += ref_len;
  } else {
    buf[n++] = '/';
    buf[n++] = '/';
    if (base->userinfo->len > 0) {
      memcpy(buf + n, base->userinfo->data, base->userinfo->len);
      n += base->userinfo->len;
      buf[n++] = '@';
    }
    memcpy(buf + n, base->host->data, base->host->len);
    n += base->host->len;
    if (base->port->len > 0) {
      buf[n++] = ':';
      memcpy(buf + n, base->port->data, base->port->len);
      n += base->port->len;
    }
    if (ref_len > 0 &&
        (ref_data[0] == '/' || ref_data[0] == '\\')) {
      memcpy(buf + n, ref_data, ref_len);
      n += ref_len;
    } else if (ref_len > 0 && ref_data[0] == '?') {
      memcpy(buf + n, base->path->data, base->path->len);
      n += base->path->len;
      memcpy(buf + n, ref_data, ref_len);
      n += ref_len;
    } else {
      size_t keep = 0;
      for (size_t i = 0; i < base->path->len; i++) {
        if (base->path->data[i] == '/') keep = i + 1;
      }
      memcpy(buf + n, base->path->data, keep);
      n += keep;
      if (keep == 0) buf[n++] = '/';
      memcpy(buf + n, ref_data, ref_len);
      n += ref_len;
    }
  }
  ScrStr *text = scr_str_new(buf, n);
  free(buf);
  ScrUrl *out = sf_url_parse_quiet(text);
  scr_str_release(text);
  return out;
}

static bool sf_pairs_have(ScrArr *pairs, const char *name) {
  size_t n = (size_t)scr_arr_len(pairs);
  size_t want = strlen(name);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = sf_pair_at(pairs, i);
    bool same = key->len == want;
    for (size_t j = 0; j < want && same; j++) {
      char c = key->data[j];
      if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
      same = c == name[j];
    }
    if (same) return true;
  }
  return false;
}

static bool sf_header_name_ok(const char *s, size_t len) {
  if (len == 0) return false;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') ||
          strchr("!#$%&'*+-.^_`|~", c) != NULL)) {
      return false;
    }
  }
  return true;
}

static bool sf_header_value_ok(const ScrStr *value) {
  for (size_t i = 0; i < value->len; i++) {
    unsigned char c = (unsigned char)value->data[i];
    if ((c < 0x20 && c != '\t') || c == 0x7f) return false;
  }
  return true;
}

static ScrStr *sf_header_value_bytestring(ScrStr *value) {
  /* An ASCII value is its own ByteString: each byte is one UTF-16 unit. */
  size_t ascii = 0;
  while (ascii < value->len && (unsigned char)value->data[ascii] < 0x80) ascii++;
  if (ascii == value->len) return scr_str_retain(value);
  size_t len = (size_t)scr_str_utf16_len(value);
  char *bytes = malloc(len ? len : 1);
  if (!bytes) sf_oom();
  for (size_t i = 0; i < len; i++) {
    double code = scr_str_char_code_at(value, (double)i);
    if (code > 255) {
      char message[192];
      int message_len = snprintf(
          message, sizeof message,
          "Cannot convert argument to a ByteString because the character "
          "at index %zu has a value of %.0f which is greater than 255.",
          i, code);
      free(bytes);
      if (message_len < 0 || (size_t)message_len >= sizeof message) {
        sf_oom();
      }
      sf_type_error(message);
      return NULL;
    }
    bytes[i] = (char)(unsigned char)code;
  }
  ScrStr *out = scr_str_new(bytes, len);
  free(bytes);
  return out;
}

static bool sf_header_name_ci(
    const char *name, size_t name_len, const char *want) {
  size_t want_len = strlen(want);
  if (name_len != want_len) return false;
  for (size_t i = 0; i < name_len; i++) {
    char c = name[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != want[i]) return false;
  }
  return true;
}

/* Undici's connection rule: a comma list whose trimmed entries are all
 * HTTP tokens. Answers whether one of them is "close" in *close. */
static bool sf_connection_tokens(const ScrStr *value, bool *close) {
  *close = false;
  size_t start = 0;
  for (size_t i = 0; i <= value->len; i++) {
    if (i < value->len && value->data[i] != ',') continue;
    size_t a = start, b = i;
    while (a < b && (value->data[a] == ' ' || value->data[a] == '\t')) a++;
    while (b > a && (value->data[b - 1] == ' ' || value->data[b - 1] == '\t')) b--;
    if (!sf_header_name_ok(value->data + a, b - a)) return false;
    if (sf_header_name_ci(value->data + a, b - a, "close")) *close = true;
    start = i + 1;
  }
  return true;
}

static bool sf_request_header_ok(
    const char *name, size_t name_len, const ScrStr *value) {
  if (sf_header_name_ci(name, name_len, "connection")) {
    bool close;
    return sf_connection_tokens(value, &close);
  }
  return
      !sf_header_name_ci(name, name_len, "transfer-encoding") &&
      !sf_header_name_ci(name, name_len, "keep-alive") &&
      !sf_header_name_ci(name, name_len, "upgrade") &&
      !sf_header_name_ci(name, name_len, "expect");
}

/* Whether every value in `pairs` is already trimmed (sf_trim_header_value
 * would keep it): the form a copy can take unchanged (SfHeaders.canonical).
 * Combining duplicate names with an empty value leaves the separator's
 * space at the end of the combined value, which a copy trims again. */
static bool sf_header_values_trimmed(ScrArr *pairs) {
  size_t n = (size_t)scr_arr_len(pairs);
  for (size_t i = 1; i < n; i += 2) {
    const ScrStr *value = sf_pair_at(pairs, i);
    if (value->len == 0) continue;
    char first = value->data[0], last = value->data[value->len - 1];
    if (first == ' ' || first == '\t' || last == ' ' || last == '\t') return false;
  }
  return true;
}

static ScrStr *sf_trim_header_value(const ScrStr *value) {
  size_t start = 0;
  size_t end = value->len;
  while (start < end &&
         (value->data[start] == ' ' || value->data[start] == '\t')) {
    start++;
  }
  while (end > start &&
         (value->data[end - 1] == ' ' || value->data[end - 1] == '\t')) {
    end--;
  }
  if (start == 0 && end == value->len) return scr_str_retain((ScrStr *)value);
  return scr_str_new(value->data + start, end - start);
}

static bool sf_push_header(ScrArr *pairs, ScrStr *name_str,
                           ScrStr *value, bool request_guard) {
  const char *name = name_str->data;
  size_t name_len = name_str->len;
  if (!sf_header_name_ok(name, name_len)) {
    ScrStr *display = scr_str_new(name, name_len);
    sf_headers_invalid("append", display, "name");
    scr_str_release(display);
    return false;
  }
  ScrStr *byte_value = sf_header_value_bytestring(value);
  if (!byte_value) return false;
  if (!sf_header_value_ok(byte_value)) {
    ScrStr *display = sf_latin1_to_utf8(byte_value);
    sf_headers_invalid("append", display, "value");
    scr_str_release(display);
    scr_str_release(byte_value);
    return false;
  }
  ScrStr *normalized = sf_trim_header_value(byte_value);
  scr_str_release(byte_value);
  if (!request_guard) {
    ScrStr *utf8 = sf_latin1_to_utf8(normalized);
    scr_str_release(normalized);
    normalized = utf8;
  }
  if (!sf_header_name_ci(name, name_len, "set-cookie")) {
    size_t n = (size_t)scr_arr_len(pairs);
    for (size_t i = 0; i + 1 < n; i += 2) {
      ScrStr *key = sf_pair_at(pairs, i);
      bool match = key->len == name_len;
      for (size_t j = 0; j < name_len && match; j++) {
        unsigned char a = (unsigned char)key->data[j];
        unsigned char b = (unsigned char)name[j];
        if (a >= 'A' && a <= 'Z') a = (unsigned char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (unsigned char)(b - 'A' + 'a');
        match = a == b;
      }
      if (!match) continue;

      ScrStr *previous = sf_pair_at(pairs, i + 1);
      const char *separator =
          sf_header_name_ci(name, name_len, "cookie") ? "; " : ", ";
      size_t separator_len = 2;
      size_t joined_len =
          previous->len + separator_len + normalized->len;
      char *joined_data = malloc(joined_len ? joined_len : 1);
      if (!joined_data) sf_oom();
      memcpy(joined_data, previous->data, previous->len);
      memcpy(joined_data + previous->len, separator, separator_len);
      memcpy(joined_data + previous->len + separator_len,
             normalized->data, normalized->len);
      ScrStr *joined = scr_str_new(joined_data, joined_len);
      free(joined_data);
      scr_str_release(normalized);
      if (request_guard && !sf_request_header_ok(name, name_len, joined)) {
        scr_str_release(joined);
        sf_type_error("fetch failed");
        return false;
      }
      scr_arr_set_ref(pairs, (double)(i + 1), joined);
      return true;
    }
  }
  if (request_guard && !sf_request_header_ok(name, name_len, normalized)) {
    scr_str_release(normalized);
    sf_type_error("fetch failed");
    return false;
  }
  scr_arr_push_ref(
      pairs,
      request_guard
          ? scr_str_retain(name_str)
          : sf_header_name_lower_str(name_str));
  scr_arr_push_ref(pairs, normalized);
  return true;
}

static void sf_headers_constructor_type_error(void) {
  static const char message[] =
      "Headers constructor: Argument 1 could not be converted to one of: "
      "sequence<sequence<ByteString>>, record<ByteString, ByteString>.";
  sf_type_error(message);
}

static void sf_headers_pair_length_error(size_t len) {
  char message[96];
  int n = snprintf(
      message, sizeof message,
      "Headers constructor: expected name/value pair to be length 2, "
      "found %zu.", len);
  if (n < 0 || (size_t)n >= sizeof message) sf_oom();
  sf_type_error(message);
}

/* The WebIDL HeadersInit conversion phase. It performs the observable
 * sequence/record walk and every ByteString coercion, but deliberately
 * leaves header-name/value syntax validation for initialization. Response
 * construction converts this snapshot before status/statusText and only
 * validates it after body extraction, matching Undici's two phases. */
/* *canonical_out reports that the result copies a canonical Headers
 * object's pairs (SfHeaders.canonical). */
static ScrArr *sf_headers_convert_init(const ScrDyn *headers, bool *canonical_out) {
  *canonical_out = false;
  if (headers && headers->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(headers);
    ScrArr *converted = sf_headers_convert_init(materialized, canonical_out);
    scr_dyn_release(materialized);
    return converted;
  }
  ScrArr *converted = scr_arr_new(SCR_ELEM_STR, 8);
  if (!headers || headers->kind == SCR_DYN_UNDEF) {
    return converted;
  }
  if (headers->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < scr_dyn_obj_count(headers); i++) {
      ScrDynProp e = scr_dyn_obj_prop_at(headers, i);
      ScrStr *raw_name = scr_str_new(e.key, e.key_len);
      ScrStr *name_bytes = sf_header_value_bytestring(raw_name);
      ScrStr *name = name_bytes ? sf_latin1_to_utf8(name_bytes) : NULL;
      scr_str_release(name_bytes);
      scr_str_release(raw_name);
      ScrDyn *source = scr_dyn_retain(e.value);
      ScrStr *raw_value = name ? scr_dyn_string_coerce_js(source) : NULL;
      scr_dyn_release(source);
      ScrStr *value_bytes = raw_value
          ? sf_header_value_bytestring(raw_value)
          : NULL;
      ScrStr *value = value_bytes ? sf_latin1_to_utf8(value_bytes) : NULL;
      scr_str_release(value_bytes);
      scr_str_release(raw_value);
      if (!name || !value) {
        scr_str_release(name);
        scr_str_release(value);
        goto fail;
      }
      scr_arr_push_ref(converted, name);
      scr_arr_push_ref(converted, value);
    }
    return converted;
  }
  if (headers->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < headers->v.arr.len; i++) {
      ScrDyn *pair = scr_dyn_retain(headers->v.arr.items[i]);
      if (pair->kind == SCR_DYN_TYPED_REF) {
        ScrDyn *materialized = scr_dyn_typed_ref_materialize(pair);
        scr_dyn_release(pair);
        pair = materialized;
      }
      if (pair->kind != SCR_DYN_ARR || pair->v.arr.len != 2) {
        bool sequence = pair->kind == SCR_DYN_ARR;
        size_t pair_len = pair->kind == SCR_DYN_ARR ? pair->v.arr.len : 0;
        scr_dyn_release(pair);
        if (!scr_exc_pending()) {
          if (sequence) {
            sf_headers_pair_length_error(pair_len);
          } else {
            sf_headers_constructor_type_error();
          }
        }
        goto fail;
      }
      ScrDyn *name_source = scr_dyn_retain(pair->v.arr.items[0]);
      ScrDyn *value_source = scr_dyn_retain(pair->v.arr.items[1]);
      scr_dyn_release(pair);
      ScrStr *raw_name = scr_dyn_string_coerce_js(name_source);
      scr_dyn_release(name_source);
      ScrStr *name_bytes = raw_name
          ? sf_header_value_bytestring(raw_name)
          : NULL;
      ScrStr *name = name_bytes ? sf_latin1_to_utf8(name_bytes) : NULL;
      scr_str_release(name_bytes);
      scr_str_release(raw_name);
      ScrStr *raw_value = name
          ? scr_dyn_string_coerce_js(value_source)
          : NULL;
      scr_dyn_release(value_source);
      ScrStr *value_bytes = raw_value
          ? sf_header_value_bytestring(raw_value)
          : NULL;
      ScrStr *value = value_bytes ? sf_latin1_to_utf8(value_bytes) : NULL;
      scr_str_release(value_bytes);
      scr_str_release(raw_value);
      if (!name || !value) {
        scr_str_release(name);
        scr_str_release(value);
        goto fail;
      }
      scr_arr_push_ref(converted, name);
      scr_arr_push_ref(converted, value);
    }
    return converted;
  }
  if (headers->kind == SCR_DYN_HANDLE &&
      headers->v.handle.tag == SCR_DYNH_FETCH_HEADERS) {
    SfHeaders *source = (SfHeaders *)headers->v.handle.ptr;
    size_t n = (size_t)scr_arr_len(source->pairs);
    for (size_t i = 0; i < n - n % 2; i++)
      scr_arr_push_ref(converted, scr_str_retain(sf_pair_at(source->pairs, i)));
    *canonical_out = source->canonical;
    return converted;
  }
  /* Functions are WebIDL objects and an ordinary function has no
   * enumerable HeadersInit entries. The checked-dynamic function model's
   * expando properties are non-enumerable by construction. */
  if (headers->kind == SCR_DYN_FUNC) return converted;
  sf_headers_constructor_type_error();

fail:
  scr_arr_release(converted);
  return NULL;
}

static bool sf_add_converted_headers(
    ScrArr *pairs, ScrArr *converted, bool request_guard, bool canonical) {
  size_t n = (size_t)scr_arr_len(converted);
  /* Pushing canonical pairs into an empty list one by one through
   * sf_push_header would reproduce them exactly. */
  if (canonical && !request_guard && scr_arr_len(pairs) == 0) {
    for (size_t i = 0; i < n; i++)
      scr_arr_push_ref(pairs, scr_str_retain(sf_pair_at(converted, i)));
    return true;
  }
  for (size_t i = 0; i + 1 < n; i += 2) {
    if (!sf_push_header(pairs, sf_pair_at(converted, i),
                        sf_pair_at(converted, i + 1), request_guard))
      return false;
  }
  return true;
}

static bool sf_add_headers(
    ScrArr *pairs, const ScrDyn *headers, bool request_guard) {
  bool canonical = false;
  ScrArr *converted = sf_headers_convert_init(headers, &canonical);
  if (!converted) return false;
  bool ok = sf_add_converted_headers(pairs, converted, request_guard, canonical);
  scr_arr_release(converted);
  return ok;
}

static void sf_push_header_text(ScrArr *pairs, const char *name,
                                const char *value, size_t value_len) {
  scr_arr_push_ref(pairs, scr_str_new(name, strlen(name)));
  scr_arr_push_ref(pairs, scr_str_new(value, value_len));
}

static void sf_strip_header(ScrArr **headers, const char *name) {
  ScrArr *old = *headers;
  size_t n = (size_t)scr_arr_len(old);
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = (ScrStr *)scr_arr_get_ref(old, (double)i);
    if (sf_eq_ci(key, name)) {
      scr_str_release(key);
      continue;
    }
    scr_arr_push_ref(out, key);
    scr_arr_push_ref(out, scr_arr_get_ref(old, (double)(i + 1)));
  }
  scr_arr_release(old);
  *headers = out;
}

static bool sf_content_length(ScrArr *headers, bool *present_out,
                              size_t *length_out) {
  bool present = false;
  size_t length = 0;
  size_t n = (size_t)scr_arr_len(headers);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *name = scr_arr_get_ref(headers, (double)i);
    ScrStr *value = scr_arr_get_ref(headers, (double)(i + 1));
    if (!sf_eq_ci(name, "content-length")) {
      scr_str_release(name);
      scr_str_release(value);
      continue;
    }
    if (present) {
      scr_str_release(name);
      scr_str_release(value);
      sf_type_error("fetch failed");
      return false;
    }
    size_t start = 0;
    size_t end = value->len;
    while (start < end &&
           (value->data[start] == ' ' || value->data[start] == '\t')) {
      start++;
    }
    while (end > start &&
           (value->data[end - 1] == ' ' ||
            value->data[end - 1] == '\t')) {
      end--;
    }
    bool valid = start < end;
    size_t parsed = 0;
    for (size_t j = start; j < end && valid; j++) {
      unsigned char c = (unsigned char)value->data[j];
      if (c < '0' || c > '9') {
        valid = false;
        break;
      }
      size_t digit = (size_t)(c - '0');
      if (parsed > (SIZE_MAX - digit) / 10) {
        valid = false;
        break;
      }
      parsed = parsed * 10 + digit;
    }
    scr_str_release(name);
    scr_str_release(value);
    if (!valid) {
      sf_type_error("fetch failed");
      return false;
    }
    present = true;
    length = parsed;
  }
  *present_out = present;
  *length_out = length;
  return true;
}

/* RequestInit dictionary conversion coerces every member before Request's
 * method validation runs. Keep ToString separate so later members
 * (redirect and signal) are still observed when the resulting method is
 * syntactically invalid or forbidden. */
static ScrStr *sf_method_value(const ScrDyn *init) {
  const ScrDyn *value =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "method", 6)
          : NULL;
  if (!value || value->kind == SCR_DYN_UNDEF) return scr_str_new("GET", 3);
  return scr_dyn_string_coerce_js(value);
}

static bool sf_method_validate(ScrStr **method_out) {
  ScrStr *method = *method_out;
  static const char *normalized[] = {
      "DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"};
  for (size_t i = 0; i < sizeof normalized / sizeof normalized[0]; i++) {
    const char *candidate = normalized[i];
    size_t n = strlen(candidate);
    if (method->len != n) continue;
    bool same = true;
    for (size_t j = 0; j < n && same; j++) {
      char c = method->data[j];
      if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
      same = c == candidate[j];
    }
    if (same) {
      scr_str_release(method);
      *method_out = scr_str_new(candidate, n);
      return true;
    }
  }
  bool valid = method->len > 0;
  for (size_t i = 0; i < method->len && valid; i++) {
    unsigned char c = (unsigned char)method->data[i];
    valid = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            strchr("!#$%&'*+-.^_`|~", c) != NULL;
  }
  if (!valid) {
    sf_type_error("fetch failed");
    return false;
  }
  if (sf_eq_ci(method, "connect") || sf_eq_ci(method, "trace") ||
      sf_eq_ci(method, "track")) {
    size_t message_len = method->len + 31;
    char *message = malloc(message_len + 1);
    if (!message) sf_oom();
    int len = snprintf(message, message_len + 1, "'%.*s' HTTP method is unsupported.",
                       (int)method->len, method->data);
    if (len < 0 || (size_t)len > message_len) sf_oom();
    sf_type_error(message);
    free(message);
    return false;
  }
  return true;
}

static bool sf_redirect_mode(const ScrDyn *init, int *out) {
  const ScrDyn *value =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "redirect", 8)
          : NULL;
  if (!value || value->kind == SCR_DYN_UNDEF) {
    *out = SF_REDIRECT_FOLLOW;
    return true;
  }
  ScrStr *mode = scr_dyn_string_coerce_js(value);
  if (!mode) return false;
  if (mode->len == 6 && memcmp(mode->data, "follow", 6) == 0) {
    *out = SF_REDIRECT_FOLLOW;
    scr_str_release(mode);
    return true;
  }
  if (mode->len == 5 && memcmp(mode->data, "error", 5) == 0) {
    *out = SF_REDIRECT_ERROR;
    scr_str_release(mode);
    return true;
  }
  if (mode->len == 6 && memcmp(mode->data, "manual", 6) == 0) {
    *out = SF_REDIRECT_MANUAL;
    scr_str_release(mode);
    return true;
  }
  static const char prefix[] = "undefined: ";
  static const char suffix[] =
      " is not an accepted type. Expected one of follow, manual, error.";
  size_t message_len =
      sizeof prefix - 1 + mode->len + sizeof suffix - 1;
  char *message = malloc(message_len + 1);
  if (!message) sf_oom();
  memcpy(message, prefix, sizeof prefix - 1);
  memcpy(message + sizeof prefix - 1, mode->data, mode->len);
  memcpy(message + sizeof prefix - 1 + mode->len,
         suffix, sizeof suffix - 1);
  message[message_len] = '\0';
  scr_str_release(mode);
  sf_type_error(message);
  free(message);
  return false;
}

static ScrPromise *sf_reject_now(ScrPromise *promise, const char *message) {
  if (!scr_exc_pending()) sf_type_error(message);
  scr_promise_reject_pending(promise);
  return promise;
}

static void sf_request_length_mismatch(SfTransfer *t) {
  if (t->client) scr_http_client_destroy(t->client);
  sf_reject(t, "fetch failed");
}

static void sf_stream_request_flush(SfStream *s) {
  SfTransfer *t = s->request_owner;
  if (!t || t->done || !t->client) return;
  while (s->head) {
    SfChunk *c = s->head;
    s->head = c->next;
    if (!s->head) s->tail = NULL;
    s->queued--;
    ScrBytes *bytes = sf_chunk_bytes(c->value);
    if (!bytes) {
      sf_chunk_release(c);
      sf_stream_drop_chunks(s);
      ScrCaught *caught = scr_exc_take();
      ScrDyn *reason = scr_caught_to_dyn(caught);
      sf_transfer_stream_error(t, reason);
      scr_dyn_release(reason);
      scr_caught_release(caught);
      return;
    }
    if (t->request_has_content_length &&
        (t->request_body_sent > t->request_content_length ||
         bytes->len >
             t->request_content_length - t->request_body_sent)) {
      scr_bytes_release(bytes);
      sf_chunk_release(c);
      sf_stream_drop_chunks(s);
      sf_request_length_mismatch(t);
      return;
    }
    t->request_body_sent += bytes->len;
    scr_http_client_write_bytes(t->client, bytes);
    scr_bytes_release(bytes);
    sf_chunk_release(c);
  }
  /* A response body reused as an upload may have paused its source socket
   * before fetch attached this consumer. Draining its queue creates demand
   * just as a reader.read() does, so let the source transport deliver more. */
  sf_response_resume_if_ready(s);
  if (s->error) {
    sf_transfer_stream_error(t, s->error);
  } else if (s->close_requested) {
    if (t->request_has_content_length &&
        t->request_body_sent != t->request_content_length) {
      sf_request_length_mismatch(t);
      return;
    }
    sf_stream_finish_close(s);
    scr_http_client_end(t->client);
  }
}

static bool sf_start_hop(SfTransfer *t);
static bool sf_redirect(SfTransfer *t, int status, const ScrStr *location);

static void sf_response_terminate(SfTransfer *t) {
  if (!t || t->done || !t->response_stream) return;
  if (t->client) scr_http_client_destroy(t->client);
  ScrError *e = NULL;
  ScrDyn *reason = sf_type_reason("terminated", &e);
  sf_stream_error(t->response_stream, reason);
  scr_dyn_release(reason);
  scr_error_release(e);
  sf_settle(t);
}

static void sf_inflate_append(
    SfTransfer *t, const unsigned char *data, size_t len) {
  if (len == 0) return;
  size_t prior = t->inflate_pending ? t->inflate_pending->len : 0;
  if (len > SIZE_MAX - prior) sf_oom();
  ScrBytes *combined =
      scr_bytes_new(SCR_BYTES_U8, (double)(prior + len));
  if (prior > 0) {
    memcpy(combined->data, t->inflate_pending->data, prior);
  }
  memcpy(combined->data + prior, data, len);
  scr_bytes_release(t->inflate_pending);
  t->inflate_pending = combined;
}

/*
 * Inflate only while the decoded stream has demand. zlib keeps a small
 * amount of output internally, while the unconsumed compressed suffix lives
 * in inflate_pending so the network callback's borrowed chunk can return.
 */
static void sf_inflate_process(SfTransfer *t) {
  if (!t || t->done || t->inflate_draining || !t->response_stream ||
      t->response_stream->discarded ||
      (!t->inflate_pending && !t->inflate_needs_drain) ||
      t->response_stream->queued >= 1) {
    return;
  }
  t->inflate_draining = true;
  ScrBytes *input = t->inflate_pending;
  t->inflate_pending = NULL;
  t->zs.next_in = input ? (Bytef *)input->data : Z_NULL;
  t->zs.avail_in = input ? (uInt)input->len : 0;
  bool drain_internal = t->inflate_needs_drain;
  t->inflate_needs_drain = false;
  unsigned char out[16384];

  while (!t->done && !t->response_stream->discarded &&
         t->response_stream->queued < 1 &&
         (t->zs.avail_in > 0 || drain_internal)) {
    if (t->inflate_member_end) {
      if (t->zs.avail_in == 0) break;
      if (inflateReset(&t->zs) != Z_OK) {
        sf_response_terminate(t);
        break;
      }
      t->inflate_member_end = false;
    }

    t->zs.next_out = out;
    t->zs.avail_out = sizeof out;
    int result = inflate(&t->zs, Z_NO_FLUSH);
    size_t produced = sizeof out - t->zs.avail_out;
    drain_internal = false;
    if (produced > 0) {
      ScrBytes *decoded = scr_bytes_new(SCR_BYTES_U8, (double)produced);
      memcpy(decoded->data, out, produced);
      sf_stream_enqueue_bytes(t->response_stream, decoded);
      scr_bytes_release(decoded);
    }
    if (result == Z_STREAM_END) {
      /* RFC 1952 permits concatenated gzip members. */
      t->inflate_member_end = true;
      if (t->zs.avail_in == 0) break;
      continue;
    }
    if (result != Z_OK && result != Z_BUF_ERROR) {
      sf_response_terminate(t);
      break;
    }
    if (t->done || t->response_stream->discarded) break;
    if (t->response_stream->queued >= 1) {
      if (result == Z_OK && t->zs.avail_out == 0) {
        t->inflate_needs_drain = true;
      }
      break;
    }
    if (result == Z_BUF_ERROR && produced == 0) break;
    if (t->zs.avail_in == 0) {
      if (result == Z_OK && t->zs.avail_out == 0) {
        drain_internal = true;
        continue;
      }
      break;
    }
  }

  if (!t->done && !t->response_stream->discarded &&
      t->zs.avail_in > 0) {
    sf_inflate_append(t, t->zs.next_in, t->zs.avail_in);
  }
  t->zs.next_in = Z_NULL;
  t->zs.avail_in = 0;
  if (t->response_stream->discarded) {
    scr_bytes_release(t->inflate_pending);
    t->inflate_pending = NULL;
    t->inflate_needs_drain = false;
  }
  scr_bytes_release(input);
  t->inflate_draining = false;
}

static void sf_inflate_finish_if_ended(SfTransfer *t) {
  if (!t || t->done || !t->response_ended || t->inflate_draining ||
      !t->response_stream) {
    return;
  }
  if (t->response_stream->discarded) {
    sf_stream_close(t->response_stream);
    sf_settle(t);
    return;
  }
  if (t->inflate_pending || t->inflate_needs_drain) {
    if (t->response_stream->queued >= 1) return;
    sf_inflate_process(t);
    if (t->done) return;
    if (t->inflate_pending || t->inflate_needs_drain) {
      /*
       * Node fetch accepts a clean HTTP EOF even when the compressed
       * representation ends before zlib reaches Z_STREAM_END, exposing the
       * decoded prefix. Discard the suffix that still needs wire input.
       */
      scr_bytes_release(t->inflate_pending);
      t->inflate_pending = NULL;
      t->inflate_needs_drain = false;
    }
  }
  sf_stream_close(t->response_stream);
  sf_settle(t);
}

static void sf_inflate_resume(SfTransfer *t) {
  if (!t || t->done || t->inflate_draining) return;
  sf_retain(t);
  sf_inflate_process(t);
  sf_inflate_finish_if_ended(t);
  if (!t->done && t->response_paused && t->response_socket &&
      t->response_stream && t->response_stream->queued < 1 &&
      !t->response_stream->close_requested &&
      !t->response_stream->closed && !t->response_stream->error) {
    t->response_paused = false;
    scr_net_sock_release(scr_net_sock_resume(t->response_socket));
  }
  sf_release(t);
}

static void sf_on_data(ScrClosure *cb, ScrBytes *chunk) {
  SfTransfer *t = sf_from(cb);
  if (!t) return;
  if (t->done || !t->response_stream) {
    sf_release(t);
    return;
  }
  /*
   * Fetch exposes no body for HEAD/204/205/304 responses. The shared HTTP
   * parser still drains an invalid payload on 205, so discard those bytes
   * here instead of queueing them into an inaccessible stream that would
   * apply backpressure forever.
   */
  if (t->response_null_body) {
    sf_release(t);
    return;
  }
  if (t->response_stream->discarded) {
    sf_release(t);
    return;
  }
  if (!t->inflating) {
    sf_stream_enqueue_bytes(t->response_stream, chunk);
    sf_release(t);
    return;
  }

  SCR_BYTES_SNAPSHOT(chunk);
  sf_inflate_append(t, chunk->data, chunk->len);
  sf_inflate_process(t);
  sf_release(t);
}

/* After 'end' the keep-alive agent can hand the socket to the next request
 * on the connection, so the transfer leaves it reading and stops pausing
 * and resuming it. */
static void sf_drop_response_socket(SfTransfer *t) {
  if (!t->response_socket) return;
  if (t->response_paused) scr_net_sock_release(scr_net_sock_resume(t->response_socket));
  t->response_paused = false;
  scr_net_sock_release(t->response_socket);
  t->response_socket = NULL;
}

static void sf_on_end(ScrClosure *cb) {
  SfTransfer *t = sf_from(cb);
  if (!t) return;
  sf_drop_response_socket(t);
  if (!t->done) {
    if (t->inflating && t->response_stream &&
        !t->response_stream->discarded) {
      t->response_ended = true;
      sf_inflate_finish_if_ended(t);
    } else {
      if (t->response_stream) sf_stream_close(t->response_stream);
      sf_settle(t);
    }
  }
  sf_release(t);
}

static void sf_on_res_error(ScrClosure *cb, ScrStr *message) {
  (void)message;
  SfTransfer *t = sf_from(cb);
  if (!t) return;
  if (!t->done && t->response_stream) {
    sf_response_terminate(t);
  } else {
    sf_reject(t, "fetch failed");
  }
  sf_release(t);
}

static bool sf_response_has_null_body(const SfTransfer *t, int status) {
  return sf_eq_ci(t->method, "head") || status == 101 ||
         status == 204 || status == 205 || status == 304;
}

static void sf_on_response(ScrClosure *cb, ScrHttpReq *res) {
  SfTransfer *t = sf_from(cb);
  if (!t) {
    scr_http_req_release(res);
    return;
  }
  if (t->done) {
    scr_http_req_release(res);
    sf_release(t);
    return;
  }
  int status = (int)scr_http_req_status(res);
  if (status == 301 || status == 302 || status == 303 ||
      status == 307 || status == 308) {
    ScrStr *name = scr_str_new("location", 8);
    ScrStr *location = scr_http_req_header(res, name);
    scr_str_release(name);
    if (location) {
      if (t->redirect_mode == SF_REDIRECT_MANUAL) {
        scr_str_release(location);
      } else {
        ScrHttpClientReq *old = t->client;
        t->client = NULL;
        if (old) {
          scr_http_client_destroy(old);
          scr_http_client_release(old);
        }
        if (t->redirect_mode == SF_REDIRECT_ERROR) {
          sf_reject(t, "fetch failed");
          scr_str_release(location);
          scr_http_req_release(res);
          sf_release(t);
          return;
        }
        ScrStr *decoded_location = sf_location_to_utf8(location);
        bool follow = sf_redirect(t, status, decoded_location);
        scr_str_release(decoded_location);
        scr_str_release(location);
        if (follow) sf_start_hop(t);
        scr_http_req_release(res);
        sf_release(t);
        return;
      }
    }
  }
  bool null_body = sf_response_has_null_body(t, status);
  t->response_null_body = null_body;
  if (!null_body) {
    ScrStr *name = scr_str_new("content-encoding", 16);
    ScrStr *encoding = scr_http_req_header(res, name);
    scr_str_release(name);
    if (encoding) {
      if (sf_eq_ci(encoding, "gzip") || sf_eq_ci(encoding, "x-gzip") ||
          sf_eq_ci(encoding, "deflate")) {
        memset(&t->zs, 0, sizeof t->zs);
        if (inflateInit2(&t->zs, 15 + 32) != Z_OK) sf_oom();
        t->inflating = true;
      }
      scr_str_release(encoding);
    }
  }
  SfStream *body = sf_stream_new_native();
  body->response_owner = t;
  t->response_stream = sf_stream_retain(body);
  t->response_socket = scr_http_req_socket(res);
  SfResponse *response = calloc(1, sizeof *response);
  if (!response) sf_oom();
  response->rc = 1;
  response->body = sf_stream_retain(body);
  response->headers =
      sf_headers_new_response(scr_http_req_header_lines(res));
  response->url = sf_url_serialize(t->url);
  ScrStr *raw_status_text = scr_http_req_status_message(res);
  response->status_text =
      raw_status_text ? sf_latin1_to_utf8(raw_status_text)
                      : scr_str_new("", 0);
  scr_str_release(raw_status_text);
  response->status = status;
  response->redirected = t->redirected;
  response->null_body = null_body;
  ScrDyn *boxed = scr_dyn_new_handle(response, SCR_DYNH_FETCH_RESPONSE);
  sf_response_release(response);
  sf_stream_release(body);

  scr_http_req_on_data(res, sf_closure(t, (void *)&sf_on_data),
                       &sf_on_data, false);
  scr_http_req_on_end(res, sf_closure(t, (void *)&sf_on_end), false);
  scr_http_req_on_error(res, sf_closure(t, (void *)&sf_on_res_error),
                        &sf_on_res_error, false);
  t->response_sent = true;
  ScrPromise *promise = t->promise;
  t->promise = NULL;
  scr_promise_fulfill_ref(promise, boxed, &scr_dyn_retain_v,
                          &scr_dyn_release_v, NULL);
  scr_promise_release(promise);
  scr_http_req_release(res);
  sf_release(t);
}

typedef struct { int value; const char *name; } SfUvError;
#define SF_UV_ERROR(name, message) { SCR_NODE_UV__##name, #name },
static const SfUvError sf_uv_errors[] = { SCR_NODE_UV_ERRNO_MAP(SF_UV_ERROR) };
#undef SF_UV_ERROR

/* libuv's errno value for a code name; getaddrinfo's ENOTFOUND is
 * EAI_NONAME. 0 when the name is not a libuv code. */
static int sf_uv_errno(const char *name) {
  if (strcmp(name, "ENOTFOUND") == 0) return SCR_NODE_UV__EAI_NONAME;
  for (size_t i = 0; i < sizeof sf_uv_errors / sizeof sf_uv_errors[0]; i++) {
    if (strcmp(sf_uv_errors[i].name, name) == 0) return sf_uv_errors[i].value;
  }
  return 0;
}

static const char sf_tunnel_prefix[] = "Proxy response (";
static const char sf_not_http_prefix[] = "Response does not match the HTTP/1.1 protocol";

/* The cause Node's fetch gives a transport failure, built from the
 * runtime's failure message. "<syscall> <CODE>[ <detail>]" messages
 * become Node's system error with code, errno and syscall (plus address
 * and port for connect, hostname for getaddrinfo). A tunnel the proxy
 * refused becomes undici's DOMException "Request was cancelled." whose
 * cause is the AbortError carrying the proxy status, and a proxy reply
 * that is not HTTP becomes the HTTPParserError. NULL (no cause) for
 * every other message. +1. */
static ScrDyn *sf_failure_cause(const ScrStr *message) {
  if (message->len > sizeof sf_tunnel_prefix - 1 &&
      memcmp(message->data, sf_tunnel_prefix, sizeof sf_tunnel_prefix - 1) == 0) {
    ScrError *aborted = scr_error_new(SCR_ERR_ERROR, (ScrStr *)message);
    scr_str_release(aborted->name);
    aborted->name = scr_str_new("AbortError", 10);
    aborted->name_present = true;
    scr_error_set_code(aborted, "UND_ERR_ABORTED");
    ScrDyn *inner = scr_dyn_from_error(aborted);
    scr_error_release(aborted);
    ScrDyn *options = scr_dyn_new_obj();
    ScrStr *name = scr_str_new("Error", 5);
    scr_dyn_obj_set(options, "name", 4, scr_dyn_new_str(name));
    scr_str_release(name);
    scr_dyn_obj_set(options, "cause", 5, inner);
    ScrStr *text = scr_str_new("Request was cancelled.", 22);
    ScrDyn *m = scr_dyn_new_str(text);
    scr_str_release(text);
    ScrError *dom = scr_domex_new(m, options);
    scr_dyn_release(m);
    scr_dyn_release(options);
    ScrDyn *cause = scr_dyn_from_error(dom);
    scr_error_release(dom);
    return cause;
  }
  if (message->len >= sizeof sf_not_http_prefix - 1 &&
      memcmp(message->data, sf_not_http_prefix, sizeof sf_not_http_prefix - 1) == 0) {
    ScrError *parser = scr_error_new(SCR_ERR_ERROR, (ScrStr *)message);
    scr_str_release(parser->name);
    parser->name = scr_str_new("HTTPParserError", 15);
    parser->name_present = true;
    ScrDyn *cause = scr_dyn_from_error(parser);
    scr_error_release(parser);
    return cause;
  }
  const char *data = message->data;
  const char *space = memchr(data, ' ', message->len);
  if (space == NULL || space == data) return NULL;
  size_t syscall_len = (size_t)(space - data);
  const char *code = space + 1;
  const char *end = data + message->len;
  const char *code_end = code;
  while (code_end < end && *code_end != ' ') code_end++;
  char code_buf[32];
  size_t code_len = (size_t)(code_end - code);
  if (code_len < 2 || code_len >= sizeof code_buf || code[0] != 'E') return NULL;
  for (size_t i = 0; i < code_len; i++) {
    char c = code[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) return NULL;
  }
  memcpy(code_buf, code, code_len);
  code_buf[code_len] = '\0';
  int uv = sf_uv_errno(code_buf);
  if (uv == 0) return NULL;
  ScrError *e = scr_error_new(SCR_ERR_ERROR, (ScrStr *)message);
  scr_error_set_code(e, code_buf);
  e->system_errno = uv;
  e->system_call = scr_str_new(data, syscall_len);
  ScrDyn *cause = scr_dyn_from_error(e);
  scr_error_release(e);
  const char *detail = code_end < end ? code_end + 1 : end;
  size_t detail_len = (size_t)(end - detail);
  if (syscall_len == 7 && memcmp(data, "connect", 7) == 0 && detail_len > 0) {
    const char *colon = NULL;
    for (const char *q = detail; q < end; q++) {
      if (*q == ':') colon = q;
    }
    if (colon != NULL && colon > detail && colon + 1 < end) {
      ScrStr *address = scr_str_new(detail, (size_t)(colon - detail));
      scr_dyn_obj_set(cause, "address", 7, scr_dyn_new_str(address));
      scr_str_release(address);
      scr_dyn_obj_set(cause, "port", 4, scr_dyn_new_num(strtod(colon + 1, NULL)));
    }
  } else if (syscall_len == 11 && memcmp(data, "getaddrinfo", 11) == 0 && detail_len > 0) {
    ScrStr *hostname = scr_str_new(detail, detail_len);
    scr_dyn_obj_set(cause, "hostname", 8, scr_dyn_new_str(hostname));
    scr_str_release(hostname);
  }
  return cause;
}

/* A plain Error cause. +1. */
static ScrDyn *sf_plain_cause(const char *message) {
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  ScrDyn *cause = scr_dyn_from_error(e);
  scr_error_release(e);
  return cause;
}

/* Rejects with TypeError "fetch failed" whose cause is `cause` (moves;
 * NULL rejects without a cause). */
static void sf_reject_cause(SfTransfer *t, ScrDyn *cause) {
  if (t->done || cause == NULL) {
    scr_dyn_release(cause);
    sf_reject(t, "fetch failed");
    return;
  }
  ScrError *e = NULL;
  ScrDyn *reason = sf_type_reason("fetch failed", &e);
  scr_error_set_cause(e, cause);
  scr_dyn_release(cause);
  scr_error_release(e);
  sf_reject_reason(t, reason);
  scr_dyn_release(reason);
}

/* Rejects with TypeError "fetch failed", with Node's cause when the
 * failure message has one. */
static void sf_reject_failure(SfTransfer *t, const ScrStr *message) {
  sf_reject_cause(t, message != NULL ? sf_failure_cause(message) : NULL);
}

static void sf_on_client_error(ScrClosure *cb, ScrStr *message) {
  SfTransfer *t = sf_from(cb);
  if (!t) return;
  if (!t->done) {
    if (t->response_sent && t->response_stream) {
      sf_response_terminate(t);
    } else {
      sf_reject_failure(t, message);
    }
  }
  sf_release(t);
}

static void sf_on_upgrade(
    ScrClosure *cb, ScrHttpReq *res, ScrNetSocket *socket,
    ScrBytes *head) {
  SfTransfer *t = sf_from(cb);
  scr_http_req_release(res);
  scr_bytes_release(head);
  scr_net_sock_destroy(socket);
  scr_net_sock_release(socket);
  if (!t) return;
  if (!t->done) sf_reject(t, "fetch failed");
  sf_release(t);
}

static bool sf_body_is_stream(const ScrDyn *body) {
  return body &&
         body->kind == SCR_DYN_HANDLE &&
         body->v.handle.tag == SCR_DYNH_WEB_STREAM;
}

static bool sf_redirect(SfTransfer *t, int status,
                        const ScrStr *location) {
  if (t->hops >= 20) {
    sf_reject(t, "fetch failed");
    return false;
  }
  ScrUrl *next = sf_resolve_url(t->url, location);
  if (!next ||
      !(sf_eq_ci(next->scheme, "http") ||
        sf_eq_ci(next->scheme, "https")) ||
      next->userinfo->len > 0) {
    scr_url_release(next);
    sf_reject(t, "fetch failed");
    return false;
  }

  bool is_get = sf_eq_ci(t->method, "get");
  bool is_head = sf_eq_ci(t->method, "head");
  bool rewrite =
      (status == 303 && !is_get && !is_head) ||
      ((status == 301 || status == 302) &&
       sf_eq_ci(t->method, "post"));
  if (sf_body_is_stream(t->body) && status != 303) {
    scr_url_release(next);
    sf_reject(t, "fetch failed");
    return false;
  }
  if (rewrite) {
    scr_str_release(t->method);
    t->method = scr_str_new("GET", 3);
    scr_dyn_release(t->body);
    t->body = NULL;
    sf_strip_header(&t->headers, "content-type");
    sf_strip_header(&t->headers, "content-length");
    sf_strip_header(&t->headers, "content-encoding");
    sf_strip_header(&t->headers, "content-language");
    sf_strip_header(&t->headers, "content-location");
  }

  bool same_origin =
      t->url->host->len == next->host->len &&
      memcmp(t->url->host->data, next->host->data, next->host->len) == 0 &&
      sf_port(t->url, 0) == sf_port(next, 0) &&
      t->url->scheme->len == next->scheme->len &&
      memcmp(t->url->scheme->data, next->scheme->data,
             next->scheme->len) == 0;
  if (!same_origin) {
    sf_strip_header(&t->headers, "authorization");
    sf_strip_header(&t->headers, "proxy-authorization");
    sf_strip_header(&t->headers, "cookie");
  }

  scr_url_release(t->url);
  t->url = next;
  t->hops++;
  t->redirected = true;
  return true;
}

/* A CONNECT tunnel for one request: the head sent to the proxy, and the
 * target's TLS client context when the target is https. */
typedef struct {
  char *head;
  size_t head_len;
  void *tls_ctx;
} SfTunnel;

/* undici's CONNECT head: the target as host:port, its Host value, and
 * the proxy credentials from the proxy URL. Returns malloc'd storage. */
static char *sf_tunnel_head(const ScrUrl *url, int port, const char *authority,
                            size_t authority_len, const ScrUrl *proxy, size_t *len_out) {
  ScrStr *authorization = sf_proxy_has_credentials(proxy->userinfo)
                              ? sf_proxy_authorization(proxy->userinfo)
                              : NULL;
  size_t cap = url->host->len + authority_len + 160 + (authorization ? authorization->len : 0);
  char *head = malloc(cap);
  if (!head) sf_oom();
  int n = snprintf(head, cap, "CONNECT %.*s:%d HTTP/1.1\r\nhost: %.*s\r\nconnection: close\r\n",
                   (int)url->host->len, url->host->data, port, (int)authority_len, authority);
  if (authorization) {
    n += snprintf(head + n, cap - (size_t)n, "proxy-authorization: %.*s\r\n",
                  (int)authorization->len, authorization->data);
    scr_str_release(authorization);
  }
  n += snprintf(head + n, cap - (size_t)n, "proxy-connection: keep-alive\r\n\r\n");
  *len_out = (size_t)n;
  return head;
}

static SfTunnel *sf_tunnel_new(const ScrUrl *url, int port, const char *authority,
                               size_t authority_len, const ScrUrl *proxy, void *tls_ctx) {
  SfTunnel *tunnel = malloc(sizeof *tunnel);
  if (!tunnel) sf_oom();
  tunnel->head = sf_tunnel_head(url, port, authority, authority_len, proxy, &tunnel->head_len);
  tunnel->tls_ctx = tls_ctx;
  return tunnel;
}

/* The client's wrap hook for a tunneled request: the CONNECT exchange
 * runs on the proxy socket, then the target's TLS session (if any) runs
 * inside the tunnel. */
static void sf_tunnel_wrap(ScrNetSocket *sock, void *ctx) {
  SfTunnel *tunnel = ctx;
  scr_net_sock_set_tunnel(sock, tunnel->head, tunnel->head_len);
  if (tunnel->tls_ctx) scr_tls_fetch_client_wrap(sock, tunnel->tls_ctx);
  free(tunnel->head);
  free(tunnel);
}

static bool sf_start_hop(SfTransfer *t) {
  ScrUrl *url = t->url;
  bool https = sf_eq_ci(url->scheme, "https");
  int default_port = https ? 443 : 80;
  int port = sf_port(url, default_port);
  if (sf_bad_port(port)) {
    sf_reject_cause(t, sf_plain_cause("bad port"));
    return false;
  }
  bool invalid_proxy = false;
  ScrUrl *proxy = sf_proxy_for(url, https, port, &invalid_proxy);
  bool proxy_http = proxy && sf_eq_ci(proxy->scheme, "http");
  bool proxy_https = proxy && sf_eq_ci(proxy->scheme, "https");
  if (invalid_proxy || (proxy && !proxy_http && !proxy_https)) {
    scr_url_release(proxy);
    sf_reject(t, "fetch failed");
    return false;
  }
  /* A proxy carries every request through a CONNECT tunnel, as undici's
   * ProxyAgent does; an https:// proxy runs the tunnel inside a TLS
   * session to the proxy. */
  size_t user_len = (size_t)scr_arr_len(t->headers);
  ScrArr *headers = scr_arr_new(SCR_ELEM_STR, user_len + 16);

  char authority[384];
  int authority_len =
      port == default_port
          ? snprintf(authority, sizeof authority, "%.*s",
                     (int)url->host->len, url->host->data)
          : snprintf(authority, sizeof authority, "%.*s:%d",
                     (int)url->host->len, url->host->data, port);
  if (authority_len < 0 ||
      (size_t)authority_len >= sizeof authority) {
    scr_arr_release(headers);
    scr_url_release(proxy);
    sf_reject(t, "fetch failed");
    return false;
  }
  sf_push_header_text(headers, "host", authority,
                      (size_t)authority_len);
  /* The user's connection header only chooses close over keep-alive (a
   * "close" token); the transport writes its own value after host. */
  bool connection_close = false;
  for (size_t i = 0; i + 1 < user_len; i += 2) {
    ScrStr *name = scr_arr_get_ref(t->headers, (double)i);
    if (sf_eq_ci(name, "connection")) {
      ScrStr *value = scr_arr_get_ref(t->headers, (double)(i + 1));
      bool close;
      if (sf_connection_tokens(value, &close) && close) connection_close = true;
      scr_str_release(value);
    }
    scr_str_release(name);
  }
  if (connection_close) sf_push_header_text(headers, "connection", "close", 5);
  else sf_push_header_text(headers, "connection", "keep-alive", 10);
  /* Headers keeps each Set-Cookie value separately, but undici sends its
   * header list's combined value: one line, the values joined by ", ",
   * at the position of the first one. */
  bool set_cookie_sent = false;
  for (size_t i = 0; i + 1 < user_len; i += 2) {
    ScrStr *name = scr_arr_get_ref(t->headers, (double)i);
    ScrStr *value = scr_arr_get_ref(t->headers, (double)(i + 1));
    if (sf_eq_ci(name, "host") || sf_eq_ci(name, "connection") ||
        (set_cookie_sent && sf_eq_ci(name, "set-cookie"))) {
      scr_str_release(name);
      scr_str_release(value);
      continue;
    }
    if (sf_eq_ci(name, "set-cookie")) {
      set_cookie_sent = true;
      for (size_t j = i + 2; j + 1 < user_len; j += 2) {
        ScrStr *later = scr_arr_get_ref(t->headers, (double)j);
        bool match = sf_eq_ci(later, "set-cookie");
        scr_str_release(later);
        if (!match) continue;
        ScrStr *next = scr_arr_get_ref(t->headers, (double)(j + 1));
        size_t joined_len = value->len + 2 + next->len;
        char *joined = malloc(joined_len ? joined_len : 1);
        if (!joined) sf_oom();
        memcpy(joined, value->data, value->len);
        memcpy(joined + value->len, ", ", 2);
        memcpy(joined + value->len + 2, next->data, next->len);
        scr_str_release(next);
        scr_str_release(value);
        value = scr_str_new(joined, joined_len);
        free(joined);
      }
    }
    scr_arr_push_ref(headers, name);
    scr_arr_push_ref(headers, value);
  }
  if (!sf_pairs_have(t->headers, "accept")) {
    sf_push_header_text(headers, "accept", "*/*", 3);
  }
  if (!sf_pairs_have(t->headers, "accept-language")) {
    sf_push_header_text(headers, "accept-language", "*", 1);
  }
  if (!sf_pairs_have(t->headers, "sec-fetch-mode")) {
    sf_push_header_text(headers, "sec-fetch-mode", "cors", 4);
  }
  if (!sf_pairs_have(t->headers, "user-agent")) {
    sf_push_header_text(headers, "user-agent", "node", 4);
  }
  if (!sf_pairs_have(t->headers, "accept-encoding")) {
    sf_push_header_text(headers, "accept-encoding", "gzip, deflate", 13);
  }

  ScrStr *bare =
      sf_bare_host(proxy ? proxy->host : url->host);
  ScrStr *dial = scr_net_blocking_lookup(bare);
  ScrStr *path = sf_path(url);
  int dial_port =
      proxy ? sf_port(proxy, proxy_https ? 443 : 80) : port;
  ScrStr *sni = https ? sf_bare_host(url->host) : NULL;
  void (*wrap)(ScrNetSocket *, void *) = NULL;
  void *wrap_ctx = NULL;
  if (proxy_https) {
    size_t head_len = 0;
    char *head = sf_tunnel_head(url, port, authority, (size_t)authority_len, proxy, &head_len);
    wrap_ctx = scr_tls_fetch_tunnel_ctx(bare, sni, head, head_len);
    wrap = &scr_tls_fetch_tunnel_wrap;
    free(head);
  } else if (proxy_http) {
    void *tls_ctx = sni ? scr_tls_fetch_client_ctx(sni, true) : NULL;
    wrap_ctx = sf_tunnel_new(url, port, authority, (size_t)authority_len, proxy, tls_ctx);
    wrap = &sf_tunnel_wrap;
  } else if (sni) {
    wrap_ctx = scr_tls_fetch_client_ctx(sni, true);
    wrap = &scr_tls_fetch_client_wrap;
  }
  /* A direct connection goes through fetch's keep-alive agent, which hands
   * an idle connection to the next request for the same origin, as
   * undici's dispatcher does; the bare host keys the pool, so origins that
   * share an address keep their own connections. A proxied request dials
   * its own connection. */
  ScrHttpClientReq *client =
      proxy ? scr_http_request_ex(dial, dial_port, path, t->method, 0, headers, false, NULL,
                                  NULL, default_port, wrap, wrap_ctx)
            : scr_http_fetch_request(https, dial, dial_port, path, t->method, headers,
                                     default_port, wrap, wrap_ctx, bare);
  scr_arr_release(headers);
  scr_str_release(path);
  scr_str_release(dial);
  scr_str_release(bare);
  scr_str_release(sni);
  scr_url_release(proxy);
  if (!client) {
    sf_reject_now(t->promise, "fetch failed");
    sf_settle(t);
    return false;
  }
  t->client = client;

  scr_http_client_on_response(
      client, sf_closure(t, (void *)&sf_on_response),
      &sf_on_response, true);
  scr_http_client_on_upgrade(
      client, sf_closure(t, (void *)&sf_on_upgrade),
      &sf_on_upgrade, true);
  scr_http_client_on_error(
      client, sf_closure(t, (void *)&sf_on_client_error),
      &sf_on_client_error, false);

  ScrDyn *body = t->body;
  if (body && body->kind == SCR_DYN_STR) {
    scr_http_client_end_str(client, body->v.str);
  } else if (body && body->kind == SCR_DYN_BYTES) {
    scr_http_client_end_bytes(client, body->v.bytes);
  } else if (sf_body_is_stream(body)) {
    SfStream *stream = NULL;
    ScrDyn *seeded = NULL;
    if (body->kind == SCR_DYN_ARR) {
      seeded = scr_fetch_stream_from(body);
      if (!seeded) {
        if (t->client) scr_http_client_destroy(t->client);
        sf_reject_now(t->promise, "fetch failed");
        sf_settle(t);
        return false;
      }
      stream = sf_stream_of(seeded);
    } else {
      stream = sf_stream_of(body);
    }
    if (!stream || stream->reader || stream->internal_lock ||
        stream->disturbed || sf_view_unusable(stream)) {
      scr_dyn_release(seeded);
      if (t->client) scr_http_client_destroy(t->client);
      sf_reject(t,
                "Response body object should not be disturbed or locked");
      return false;
    }
#ifdef SCR_HANDLE_CLASSES
    /* A stream with a web view uploads through it; the transfer holds the
     * stream that reads the view. */
    SfStream *through = NULL;
    if (stream->web_view) {
      through = sf_stream_body_source(stream);
      if (!through) {
        scr_dyn_release(seeded);
        if (t->client) scr_http_client_destroy(t->client);
        sf_reject(t, "Response body object should not be disturbed or locked");
        return false;
      }
      stream = through;
    }
#endif
    stream->disturbed = true;
    stream->internal_lock = true;
    stream->request_owner = t;
    t->request_stream = sf_stream_retain(stream);
    sf_stream_request_flush(stream);
    if (stream->started && !stream->close_requested && !stream->closed &&
        !stream->error && !t->done && t->client) {
      sf_stream_pull(stream);
    }
#ifdef SCR_HANDLE_CLASSES
    sf_stream_release(through);
#endif
    scr_dyn_release(seeded);
  } else {
    scr_http_client_end(client);
  }
  return true;
}

static bool sf_response_init_object_like(const ScrDyn *init) {
  if (!init) return false;
  switch (init->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_BYTES:
  case SCR_DYN_FUNC:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_TYPED_REF:

    return true;
  default:
    return false;
  }
}

/* Owned property read for the checked-dynamic object kinds that can carry
 * ResponseInit dictionary members. Arrays/bytes/native handles/promises
 * have no such expandos in the static model and therefore answer absent. */
static ScrDyn *sf_response_init_get(
    const ScrDyn *init, const char *key, size_t len) {
  if (!init) return NULL;
  if (init->kind == SCR_DYN_OBJ) {
    ScrDyn *value = scr_dyn_obj_get(init, key, len);
    return value ? scr_dyn_retain(value) : NULL;
  }
  if (init->kind == SCR_DYN_FUNC) {
    return scr_dyn_fn_get(init, key, len);
  }
  if (init->kind == SCR_DYN_HANDLE &&
      init->v.handle.tag == SCR_DYNH_FETCH_RESPONSE) {
    return sf_response_get(init->v.handle.ptr, key, len);
  }
  if (init->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(init);
    ScrDyn *value = sf_response_init_get(materialized, key, len);
    scr_dyn_release(materialized);
    return value;
  }
  return NULL;
}

/* The Response constructor, and Response.json(data, init) when json_data
 * is non-NULL: undici converts ResponseInit, serializes the data (TypeError
 * "Value is not JSON serializable" when JSON.stringify answers undefined),
 * then initializes the response exactly as the constructor does, with
 * "application/json" as the default content type. */
typedef ScrDyn *(*SfJsonSerialize)(const ScrDyn *value);

/* The JSON serializer reaches the constructor only through Response.json's
 * entry point, so programs that never call it link no JSON walker. */
static ScrDyn *sf_response_json_serialize(const ScrDyn *value) {
  ScrStr *gap = scr_str_new("", 0);
  ScrDyn *serialized = scr_json_stringify_replacer(value, scr_dyn_undefined(), gap);
  scr_str_release(gap);
  return serialized;
}

/* The lightweight header form of a constructor's init headers (see
 * SfResponse.light): absent headers are form 1 (Response.json's plain
 * {"content-type": "application/json"} record is form 3), a Headers object
 * or pair list form 2, and a plain record form 3, whose names and values
 * *record receives in order (an array value contributes one entry per
 * element, as writeHead writes it). Response.json with init headers is
 * form 2 whatever their shape: the package's Response.json passes them on
 * as a Headers object, adding the JSON content type when they lack one.
 * 0 for any other init. */
static int8_t sf_light_header_form(const ScrDyn *headers, bool json_body,
                                   ScrArr **record) {
  if (!headers || headers->kind == SCR_DYN_UNDEF) {
    if (!json_body) return 1;
    *record = scr_arr_new(SCR_ELEM_STR, 2);
    sf_push_header_text(*record, "content-type", "application/json", 16);
    return 3;
  }
  if (json_body) return 2;
  if (headers->kind == SCR_DYN_ARR ||
      (headers->kind == SCR_DYN_HANDLE &&
       headers->v.handle.tag == SCR_DYNH_FETCH_HEADERS))
    return 2;
  ScrDyn *materialized = NULL;
  if (headers->kind == SCR_DYN_TYPED_REF) {
    materialized = scr_dyn_typed_ref_materialize(headers);
    if (!materialized) return 0;
    headers = materialized;
  }
  int8_t form = 0;
  if (headers->kind == SCR_DYN_OBJ) {
    ScrArr *out = scr_arr_new(SCR_ELEM_STR, 2 * scr_dyn_obj_count(headers));
    form = 3;
    for (size_t i = 0; i < scr_dyn_obj_count(headers) && form == 3; i++) {
      ScrDynProp e = scr_dyn_obj_prop_at(headers, i);
      const ScrDyn *value = e.value;
      size_t count = value->kind == SCR_DYN_ARR ? value->v.arr.len : 1;
      for (size_t j = 0; j < count; j++) {
        const ScrDyn *item = value->kind == SCR_DYN_ARR ? value->v.arr.items[j] : value;
        if (item->kind != SCR_DYN_STR && item->kind != SCR_DYN_NUM &&
            item->kind != SCR_DYN_BOOL) {
          form = 0;
          break;
        }
        ScrStr *text = scr_dyn_string_coerce_js(item);
        if (!text) {
          form = 0;
          break;
        }
        scr_arr_push_ref(out, scr_str_new(e.key, e.key_len));
        scr_arr_push_ref(out, text);
      }
    }
    if (form == 3) *record = out;
    else scr_arr_release(out);
  }
  scr_dyn_release(materialized);
  return form;
}

static ScrDyn *sf_response_construct(ScrDyn *body, ScrDyn *init,
                                     const ScrDyn *json_data,
                                     SfJsonSerialize serialize) {
  ScrArr *header_pairs = NULL;
  ScrArr *converted_headers = NULL;
  bool converted_canonical = false;
  ScrBytes *body_bytes = NULL;
  ScrStr *status_text = NULL;
  SfStream *stream = NULL;
  bool json_body = json_data != NULL;
  bool null_body = !json_body &&
      (!body || body->kind == SCR_DYN_UNDEF || body->kind == SCR_DYN_NULL);
  bool text_body = false;
  int status = 200;
  bool status_range_error = false;
  /* The lightweight-response classification (see SfResponse.light): a
   * Response init qualifies only while it is itself still light. */
  bool light_ok = !(init && init->kind == SCR_DYN_HANDLE &&
                    init->v.handle.tag == SCR_DYNH_FETCH_RESPONSE &&
                    ((SfResponse *)init->v.handle.ptr)->light == 0);
  if (!json_body && !null_body) {
    if (body->kind == SCR_DYN_BYTES)
      light_ok = light_ok && body->v.bytes->elem == SCR_BYTES_U8 &&
                 !body->v.bytes->is_data_view;
    else if (!(body->kind == SCR_DYN_STR ||
               (body->kind == SCR_DYN_HANDLE &&
                body->v.handle.tag == SCR_DYNH_WEB_STREAM)))
      light_ok = false;
  }
  int8_t light_form = 0;
  ScrArr *light_record = NULL;
  size_t light_length_bytes = 0;

  /* WebIDL converts constructor arguments from left to right. BodyInit's
   * string arm therefore runs before ResponseInit's dictionary conversion,
   * while a ReadableStream is only brand-converted here — its locked/
   * disturbed state belongs to the later body-extraction phase. */
  if (!null_body && !json_body && !sf_is_stream_body(body)) {
    if (body->kind == SCR_DYN_BYTES) {
      ScrBytes *raw = scr_bytes_raw_view(body->v.bytes);
      body_bytes = scr_bytes_copy(raw);
      scr_bytes_release(raw);
    } else {
      ScrStr *text =
          body->kind == SCR_DYN_STR
              ? scr_str_retain(body->v.str)
              : scr_dyn_string_coerce_js(body);
      if (!text) goto fail;
      ScrStr *encoding = scr_str_new("utf8", 4);
      body_bytes = scr_bytes_from_str(text, encoding);
      scr_str_release(encoding);
      scr_str_release(text);
      text_body = true;
    }
  }

  if (init && init->kind != SCR_DYN_UNDEF && init->kind != SCR_DYN_NULL &&
      !sf_response_init_object_like(init)) {
    sf_type_error("Response constructor init must be an object");
    goto fail;
  }

  /* ResponseInit's WebIDL dictionary conversion is lexicographic and the
   * nested HeadersInit conversion is observable: headers' ByteString
   * coercions precede status and statusText. Header syntax validation is a
   * later response-initialization step, after body extraction. */
  ScrDyn *init_headers = sf_response_init_get(init, "headers", 7);
  if (light_ok) light_form = sf_light_header_form(init_headers, json_body, &light_record);
  converted_headers = sf_headers_convert_init(init_headers, &converted_canonical);
  scr_dyn_release(init_headers);
  if (!converted_headers) goto fail;

  if (init && sf_response_init_object_like(init)) {
    ScrDyn *status_value = sf_response_init_get(init, "status", 6);
    if (status_value && status_value->kind != SCR_DYN_UNDEF) {
      double converted;
      if (!scr_dyn_number_coerce_js(status_value, &converted)) {
        scr_dyn_release(status_value);
        goto fail;
      }
      converted = trunc(converted);
      if (!isfinite(converted) || converted < 0.0) {
        status_range_error = true;
      } else {
        if (converted > 65535.0) converted = fmod(converted, 65536.0);
        status = (int)converted;
      }
    }
    scr_dyn_release(status_value);

    ScrDyn *status_text_value =
        sf_response_init_get(init, "statusText", 10);
    if (status_text_value && status_text_value->kind != SCR_DYN_UNDEF) {
      ScrStr *raw = scr_dyn_string_coerce_js(status_text_value);
      ScrStr *bytes = raw ? sf_header_value_bytestring(raw) : NULL;
      scr_str_release(raw);
      status_text = bytes ? sf_latin1_to_utf8(bytes) : NULL;
      scr_str_release(bytes);
      if (!status_text) {
        scr_dyn_release(status_text_value);
        goto fail;
      }
    }
    scr_dyn_release(status_text_value);
  }
  if (!status_text) status_text = scr_str_new("", 0);

  /* Extract BodyInit before validating the response metadata. This makes a
   * locked/disturbed stream win over the later status range, statusText HTTP
   * reason-phrase, and HeadersInit validation exactly as in pinned Node. */
  if (json_body) {
    ScrDyn *serialized = serialize(json_data);
    if (!serialized) goto fail;
    if (serialized->kind != SCR_DYN_STR) {
      static const char unserializable[30] = "Value is not JSON serializable";
      scr_dyn_release(serialized);
      scr_throw_error_msg(SCR_ERR_TYPE, unserializable, sizeof unserializable);
      goto fail;
    }
    ScrStr *encoding = scr_str_new("utf8", 4);
    body_bytes = scr_bytes_from_str(serialized->v.str, encoding);
    scr_str_release(encoding);
    scr_dyn_release(serialized);
    stream = sf_stream_new_native();
    light_length_bytes = body_bytes->len;
    sf_stream_enqueue_bytes(stream, body_bytes);
    sf_stream_close(stream);
    scr_bytes_release(body_bytes);
    body_bytes = NULL;
  } else if (null_body) {
    stream = sf_stream_new_native();
    sf_stream_close(stream);
  } else if (body->kind == SCR_DYN_HANDLE &&
             body->v.handle.tag == SCR_DYNH_WEB_STREAM) {
    stream = (SfStream *)body->v.handle.ptr;
    if (stream->reader || stream->internal_lock || stream->disturbed || sf_view_unusable(stream)) {
      stream = NULL; /* borrowed until the successful retain below */
      sf_type_error("Response body object should not be disturbed or locked");
      goto fail;
    }
#ifdef SCR_HANDLE_CLASSES
    stream = sf_stream_body_source(stream);
    if (!stream) goto fail;
#else
    sf_stream_retain(stream);
#endif
#ifdef SCR_HANDLE_CLASSES
  } else if (sf_is_web_body(body)) {
    ScrDyn *web = sf_web_body(body);
    if (!web) goto fail;
    stream = sf_stream_retain((SfStream *)web->v.handle.ptr);
    scr_dyn_release(web);
#endif
  } else {
    stream = sf_stream_new_native();
    light_length_bytes = body_bytes->len;
    sf_stream_enqueue_bytes(stream, body_bytes);
    sf_stream_close(stream);
    scr_bytes_release(body_bytes);
    body_bytes = NULL;
  }

  if (status_range_error || status < 200 || status > 599) {
    static const char message[] =
        "init[\"status\"] must be in the range of 200 to 599, inclusive.";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    goto fail;
  }
  if (!sf_header_value_ok(status_text)) {
    sf_type_error("Invalid statusText");
    goto fail;
  }

  header_pairs = scr_arr_new(SCR_ELEM_STR, 8);
  if (!sf_add_converted_headers(
          header_pairs, converted_headers, false, converted_canonical)) goto fail;
  scr_arr_release(converted_headers);
  converted_headers = NULL;

  if (!null_body &&
      (status == 204 || status == 205 || status == 304)) {
    char message[80];
    int len = snprintf(message, sizeof message,
                       "Response constructor: Invalid response status code %d",
                       status);
    if (len < 0 || (size_t)len >= sizeof message) sf_oom();
    sf_type_error(message);
    goto fail;
  }
  bool auto_ct = false;
  if (text_body && !sf_pairs_have(header_pairs, "content-type")) {
    sf_push_header_text(header_pairs, "content-type",
                        "text/plain;charset=UTF-8", 24);
    auto_ct = true;
  }
  if (json_body && !sf_pairs_have(header_pairs, "content-type")) {
    static const char json_type[16] = "application/json";
    scr_arr_push_ref(header_pairs, scr_str_new("content-type", 12));
    scr_arr_push_ref(header_pairs, scr_str_new(json_type, sizeof json_type));
  }

  SfResponse *response = calloc(1, sizeof *response);
  if (!response) sf_oom();
  response->rc = 1;
  response->body = stream;
  response->headers = sf_headers_new(header_pairs, false);
  response->headers->canonical = sf_header_values_trimmed(header_pairs);
  response->url = scr_str_new("", 0);
  response->status_text = status_text;
  response->status = status;
  response->redirected = false;
  response->null_body = null_body;
  response->light = light_form;
  response->auto_ct = auto_ct;
  response->light_record = light_record;
  light_record = NULL;
  response->light_length =
      null_body ? -1.0
      : (!json_body && body->kind == SCR_DYN_HANDLE) ? -2.0
      : (double)light_length_bytes;
  ScrDyn *out =
      scr_dyn_new_handle(response, SCR_DYNH_FETCH_RESPONSE);
  sf_response_release(response);
  return out;

fail:
  sf_stream_release(stream);
  scr_bytes_release(body_bytes);
  scr_str_release(status_text);
  scr_arr_release(header_pairs);
  scr_arr_release(converted_headers);
  scr_arr_release(light_record);
  return NULL;
}

/* @hono/node-server's built-in implementation reads a Response's
 * lightweight state to write it as the package does: [form, flags,
 * byte length, ...raw record name/value pairs], with form as in
 * SfResponse.light ("0" alone when the response is not light), flags "d"
 * (the package's Headers hold its default content type) and "a" (the
 * constructor added the text content type), and the length -1 for a null
 * body or -2 for a stream. */
ScrArr *scr_fetch_response_light(ScrDyn *response) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 4);
  if (!response || response->kind != SCR_DYN_HANDLE ||
      response->v.handle.tag != SCR_DYNH_FETCH_RESPONSE) {
    scr_arr_push_ref(out, scr_str_new("0", 1));
    return out;
  }
  SfResponse *r = response->v.handle.ptr;
  char buf[32];
  int n = snprintf(buf, sizeof buf, "%d", (int)r->light);
  scr_arr_push_ref(out, scr_str_new(buf, (size_t)n));
  if (r->light == 0) return out;
  char flags[3];
  size_t f = 0;
  if (r->light_default_ct) flags[f++] = 'd';
  if (r->auto_ct) flags[f++] = 'a';
  scr_arr_push_ref(out, scr_str_new(flags, f));
  n = snprintf(buf, sizeof buf, "%.0f", r->light_length);
  scr_arr_push_ref(out, scr_str_new(buf, (size_t)n));
  if (r->light == 3 && r->light_record) {
    for (size_t i = 0; i < r->light_record->len; i++)
      scr_arr_push_ref(out, scr_arr_get_ref(r->light_record, (double)i));
  }
  return out;
}

ScrDyn *scr_fetch_response_new(ScrDyn *body, ScrDyn *init) {
  return sf_response_construct(body, init, NULL, NULL);
}

ScrDyn *scr_fetch_response_json_static(ScrDyn *data, ScrDyn *init) {
  return sf_response_construct(NULL, init, data ? data : scr_dyn_undefined(),
                               &sf_response_json_serialize);
}

/* Request uses the same body stream and Headers ownership as Response. */
typedef struct SfRequest {
  size_t rc;
  SfResponse *payload;
  ScrStr *url;
  ScrStr *method;
  ScrStr *redirect;
  SfSignal *signal;
} SfRequest;

static void *sf_request_retain_v(void *ptr) {
  SfRequest *r = ptr; r->rc++; return r;
}
static void sf_request_release_v(void *ptr) {
  SfRequest *r = ptr;
  if (--r->rc) return;
  scr_weak_dispose_inline(r);
  sf_response_release(r->payload);
  scr_str_release(r->url); scr_str_release(r->method); scr_str_release(r->redirect);
  sf_signal_release(r->signal); free(r);
}
static ScrDyn *sf_request_get(void *ptr, const char *key, size_t len) {
  SfRequest *r = ptr;
  if (sf_name(key, len, "url")) return scr_dyn_new_str(r->url);
  if (sf_name(key, len, "method")) return scr_dyn_new_str(r->method);
  if (sf_name(key, len, "redirect")) return scr_dyn_new_str(r->redirect);
  if (sf_name(key, len, "signal")) return scr_dyn_new_handle(r->signal, SCR_DYNH_ABORT_SIGNAL);
  if (sf_name(key, len, "duplex")) { ScrStr *s = scr_str_new("half", 4); ScrDyn *v = scr_dyn_new_str(s); scr_str_release(s); return v; }
  const char *default_value = NULL;
  if (sf_name(key, len, "destination") || sf_name(key, len, "integrity") || sf_name(key, len, "referrerPolicy")) default_value = "";
  if (sf_name(key, len, "mode")) default_value = "cors";
  if (sf_name(key, len, "credentials")) default_value = "same-origin";
  if (sf_name(key, len, "cache")) default_value = "default";
  if (sf_name(key, len, "referrer")) default_value = "about:client";
  if (default_value) { ScrStr *s = scr_str_new(default_value, strlen(default_value)); ScrDyn *v = scr_dyn_new_str(s); scr_str_release(s); return v; }
  if (sf_name(key, len, "keepalive") || sf_name(key, len, "isReloadNavigation") || sf_name(key, len, "isHistoryNavigation")) return scr_dyn_new_bool(false);
  if (sf_name(key, len, "body") || sf_name(key, len, "bodyUsed") || sf_name(key, len, "headers")) return sf_response_get(r->payload, key, len);
  return NULL;
}
/* Request.clone: the payload clones as a Response does, and the clone's
 * signal follows the original's (undici: an AbortController aborted with
 * the original signal's reason, at once when it already aborted). */
static ScrDyn *sf_request_clone(SfRequest *r) {
  SfResponse *payload = sf_response_clone(r->payload, "unusable");
  if (!payload) return NULL;
  ScrDyn *sources = scr_dyn_new_arr();
  scr_dyn_arr_push(sources,
                   scr_dyn_new_handle(r->signal, SCR_DYNH_ABORT_SIGNAL));
  ScrDyn *follower = scr_fetch_abort_any(sources);
  scr_dyn_release(sources);
  if (!follower) {
    sf_response_release(payload);
    return NULL;
  }
  SfRequest *c = calloc(1, sizeof *c);
  if (!c) sf_oom();
  c->rc = 1;
  c->payload = payload;
  c->url = scr_str_retain(r->url);
  c->method = scr_str_retain(r->method);
  c->redirect = scr_str_retain(r->redirect);
  c->signal = sf_signal_retain((SfSignal *)follower->v.handle.ptr);
  scr_dyn_release(follower);
  ScrDyn *out = scr_dyn_new_handle(c, SCR_DYNH_FETCH_REQUEST);
  sf_request_release_v(c);
  return out;
}
static ScrDyn *sf_request_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc, const char *what) {
  SfRequest *r = ptr;
  if (strcmp(method, "clone") == 0) return sf_request_clone(r);
  return sf_response_invoke(r->payload, self, method, args, argc, what);
}

ScrDyn *scr_fetch_headers_new(ScrDyn *init) {
  bool canonical = false;
  ScrArr *converted = sf_headers_convert_init(init, &canonical);
  if (!converted) return NULL;
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, 8);
  bool ok = sf_add_converted_headers(pairs, converted, false, canonical);
  scr_arr_release(converted);
  if (!ok) { scr_arr_release(pairs); return NULL; }
  SfHeaders *headers = sf_headers_new(pairs, false);
  headers->canonical = sf_header_values_trimmed(pairs);
  ScrDyn *result = scr_dyn_new_handle(headers, SCR_DYNH_FETCH_HEADERS);
  sf_headers_release(headers);
  return result;
}

ScrDyn *scr_fetch_request_new(ScrDyn *input, ScrDyn *init) {
  SfRequest *source = input && input->kind == SCR_DYN_HANDLE && input->v.handle.tag == SCR_DYNH_FETCH_REQUEST ? input->v.handle.ptr : NULL;
  if (init && init->kind != SCR_DYN_UNDEF && init->kind != SCR_DYN_NULL && !sf_response_init_object_like(init)) {
    sf_type_error("Request constructor init must be an object"); return NULL;
  }
  ScrStr *url_text = source ? scr_str_retain(source->url) : scr_dyn_string_coerce_js(input);
  if (!url_text) return NULL;
  ScrUrl *url = scr_url_new(url_text);
  if (!url) sf_throw_url_parse_failure(url_text);
  scr_str_release(url_text);
  if (!url) return NULL;
  if (url->userinfo->len) { scr_url_release(url); sf_type_error("Request cannot be constructed from a URL that includes credentials"); return NULL; }
  ScrDyn *dictionary = scr_dyn_new_obj();
  ScrDyn *method = sf_response_init_get(init, "method", 6);
  if ((!method || method->kind == SCR_DYN_UNDEF) && source) { scr_dyn_release(method); method = scr_dyn_new_str(source->method); }
  if (method) scr_dyn_obj_set(dictionary, "method", 6, method);
  ScrStr *method_text = sf_method_value(dictionary);
  scr_dyn_release(dictionary);
  if (!method_text || !sf_method_validate(&method_text)) { scr_str_release(method_text); scr_url_release(url); return NULL; }
  ScrDyn *body = sf_response_init_get(init, "body", 4);
  bool supplied = body && body->kind != SCR_DYN_UNDEF && body->kind != SCR_DYN_NULL;
  if (!supplied && source && !source->payload->null_body) {
    if (source->payload->body->disturbed || source->payload->body->reader || source->payload->body->internal_lock ||
        sf_view_unusable(source->payload->body)) {
      scr_dyn_release(body); scr_str_release(method_text); scr_url_release(url);
      sf_type_error("Cannot construct a Request with a Request object that has already been used."); return NULL;
    }
    scr_dyn_release(body); body = scr_dyn_new_handle(source->payload->body, SCR_DYNH_WEB_STREAM);
  }
  bool has_body = body && body->kind != SCR_DYN_UNDEF && body->kind != SCR_DYN_NULL;
  if (has_body && (sf_name(method_text->data, method_text->len, "GET") || sf_name(method_text->data, method_text->len, "HEAD"))) {
    scr_dyn_release(body); scr_str_release(method_text); scr_url_release(url); sf_type_error("Request with GET/HEAD method cannot have body."); return NULL;
  }
  if (supplied && sf_is_stream_body(body)) {
    ScrDyn *duplex = sf_response_init_get(init, "duplex", 6);
    ScrStr *text = duplex && duplex->kind != SCR_DYN_UNDEF ? scr_dyn_string_coerce_js(duplex) : NULL;
    scr_dyn_release(duplex);
    bool half = text && sf_name(text->data, text->len, "half"); scr_str_release(text);
    if (!half) { scr_dyn_release(body); scr_str_release(method_text); scr_url_release(url); sf_type_error("RequestInit: duplex option is required when sending a body."); return NULL; }
  }
  ScrDyn *headers = sf_response_init_get(init, "headers", 7);
  if ((!headers || headers->kind == SCR_DYN_UNDEF) && source) { scr_dyn_release(headers); headers = scr_dyn_new_handle(source->payload->headers, SCR_DYNH_FETCH_HEADERS); }
  ScrDyn *payload_init = scr_dyn_new_obj();
  if (headers) scr_dyn_obj_set(payload_init, "headers", 7, headers);
  ScrDyn *payload = scr_fetch_response_new(body, payload_init);
  scr_dyn_release(payload_init); scr_dyn_release(body);
  if (!payload) { scr_str_release(method_text); scr_url_release(url); return NULL; }
  ScrDyn *signal = sf_response_init_get(init, "signal", 6);
  if ((!signal || signal->kind == SCR_DYN_UNDEF) && source) { scr_dyn_release(signal); signal = scr_dyn_new_handle(source->signal, SCR_DYNH_ABORT_SIGNAL); }
  SfSignal *following = NULL;
  if (signal && signal->kind != SCR_DYN_UNDEF && signal->kind != SCR_DYN_NULL) {
    ScrDyn *signals = scr_dyn_new_arr(); scr_dyn_arr_push(signals, scr_dyn_retain(signal));
    ScrDyn *dependent = scr_fetch_abort_any(signals); scr_dyn_release(signals);
    if (dependent) { following = sf_signal_retain(dependent->v.handle.ptr); scr_dyn_release(dependent); }
  } else following = sf_signal_new();
  scr_dyn_release(signal);
  if (!following) { scr_dyn_release(payload); scr_str_release(method_text); scr_url_release(url); return NULL; }
  ScrDyn *redirect = sf_response_init_get(init, "redirect", 8);
  ScrStr *redirect_text = redirect && redirect->kind != SCR_DYN_UNDEF ? scr_dyn_string_coerce_js(redirect) : source ? scr_str_retain(source->redirect) : scr_str_new("follow", 6);
  scr_dyn_release(redirect);
  if (!redirect_text || !(sf_name(redirect_text->data, redirect_text->len, "follow") || sf_name(redirect_text->data, redirect_text->len, "manual") || sf_name(redirect_text->data, redirect_text->len, "error"))) {
    scr_str_release(redirect_text); sf_signal_release(following); scr_dyn_release(payload); scr_str_release(method_text); scr_url_release(url); sf_type_error("Invalid Request redirect value"); return NULL;
  }
  SfRequest *r = calloc(1, sizeof *r); if (!r) sf_oom();
  r->rc = 1; r->payload = sf_response_retain(payload->v.handle.ptr); scr_dyn_release(payload);
  r->url = scr_url_href(url); scr_url_release(url); r->method = method_text; r->redirect = redirect_text; r->signal = following;
  ScrDyn *result = scr_dyn_new_handle(r, SCR_DYNH_FETCH_REQUEST); sf_request_release_v(r); return result;
}

ScrPromise *scr_fetch_input(ScrDyn *input, ScrDyn *init) {
  if (init && init->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(init);
    if (scr_exc_pending()) { scr_dyn_release(view); ScrPromise *p = scr_promise_new(); scr_promise_reject_pending(p); return p; }
    ScrPromise *result = scr_fetch_input(input, view);
    scr_dyn_release(view);
    return result;
  }
  if (input && input->kind == SCR_DYN_HANDLE && input->v.handle.tag == SCR_DYNH_FETCH_REQUEST) {
    ScrDyn *converted = scr_fetch_request_new(input, init);
    if (!converted) { ScrPromise *p = scr_promise_new(); scr_promise_reject_pending(p); return p; }
    SfRequest *r = converted->v.handle.ptr;
    ScrDyn *dictionary = scr_dyn_new_obj();
    scr_dyn_obj_set(dictionary, "method", 6, scr_dyn_new_str(r->method));
    scr_dyn_obj_set(dictionary, "headers", 7, scr_dyn_new_handle(r->payload->headers, SCR_DYNH_FETCH_HEADERS));
    scr_dyn_obj_set(dictionary, "signal", 6, scr_dyn_new_handle(r->signal, SCR_DYNH_ABORT_SIGNAL));
    scr_dyn_obj_set(dictionary, "redirect", 8, scr_dyn_new_str(r->redirect));
    if (!r->payload->null_body) {
      scr_dyn_obj_set(dictionary, "body", 4, scr_dyn_new_handle(r->payload->body, SCR_DYNH_WEB_STREAM));
      ScrStr *half = scr_str_new("half", 4); scr_dyn_obj_set(dictionary, "duplex", 6, scr_dyn_new_str(half)); scr_str_release(half);
    }
    ScrPromise *result = scr_fetch_static(r->url, dictionary);
    scr_dyn_release(dictionary); scr_dyn_release(converted); return result;
  }
  ScrStr *url = scr_dyn_string_coerce_js(input);
  if (!url) { ScrPromise *p = scr_promise_new(); scr_promise_reject_pending(p); return p; }
  ScrPromise *result = scr_fetch_static(url, init); scr_str_release(url); return result;
}

static ScrDyn *sf_fetch_function_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrPromise *p = scr_fetch_input(argc ? args[0] : scr_dyn_undefined(), argc > 1 ? args[1] : scr_dyn_undefined());
  ScrDyn *result = scr_dyn_new_promise(p); scr_promise_release(p); return result;
}
static ScrDyn *sf_fetch_function_value;
static void sf_fetch_function_cleanup(void) {
  ScrDyn *value = sf_fetch_function_value;
  sf_fetch_function_value = NULL;
  scr_dyn_release(value);
}
bool scr_fetch_web_is(const ScrDyn *value, const ScrStr *name) {
  if (value->kind != SCR_DYN_HANDLE) return false;
  if (sf_name(name->data, name->len, "Response")) return value->v.handle.tag == SCR_DYNH_FETCH_RESPONSE;
  if (sf_name(name->data, name->len, "Request")) return value->v.handle.tag == SCR_DYNH_FETCH_REQUEST;
  return sf_name(name->data, name->len, "Headers") && value->v.handle.tag == SCR_DYNH_FETCH_HEADERS;
}

bool scr_fetch_stream_is(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_WEB_STREAM;
}
ScrDyn *scr_fetch_function(void) {
  if (!sf_fetch_function_value) {
    sf_fetch_function_value = scr_dyn_new_func(scr_closure_new(NULL, 0), sf_fetch_function_call, 1, "fetch", "fetch");
    scr_atexit(sf_fetch_function_cleanup);
  }
  return scr_dyn_retain(sf_fetch_function_value);
}

static int sf_data_hex(unsigned char ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
  if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
  return -1;
}

static ScrDyn *sf_data_response(ScrStr *url) {
  size_t end = url->len;
  for (size_t i = 5; i < end; i++) if (url->data[i] == '#') { end = i; break; }
  size_t comma = 5;
  while (comma < end && url->data[comma] != ',') comma++;
  if (comma == end) { sf_type_error("fetch failed"); return NULL; }
  size_t meta_end = comma;
  bool base64 = meta_end >= 12 && strncasecmp(url->data + meta_end - 7, ";base64", 7) == 0;
  if (base64) meta_end -= 7;
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)(end - comma - 1));
  size_t n = 0;
  for (size_t i = comma + 1; i < end; i++) {
    int a, b;
    if (url->data[i] == '%' && i + 2 < end && (a = sf_data_hex(url->data[i + 1])) >= 0 && (b = sf_data_hex(url->data[i + 2])) >= 0) {
      bytes->data[n++] = (unsigned char)((a << 4) | b); i += 2;
    } else bytes->data[n++] = (unsigned char)url->data[i];
  }
  bytes->len = n;
  if (base64) {
    ScrStr *encoded = scr_bytes_string(bytes, 0, bytes->len);
    ScrStr *encoding = scr_str_new("base64", 6);
    ScrBytes *decoded = scr_bytes_from_str(encoded, encoding);
    scr_str_release(encoded); scr_str_release(encoding); scr_bytes_release(bytes); bytes = decoded;
  }
  ScrDyn *body = scr_dyn_new_bytes(bytes); scr_bytes_release(bytes);
  ScrStr *mime = meta_end == 5 ? scr_str_new("text/plain;charset=US-ASCII", 26) : scr_str_new(url->data + 5, meta_end - 5);
  if (mime->len && mime->data[0] == ';') {
    ScrJsonBuf b; scr_jb_init(&b); scr_jb_puts(&b, "text/plain"); scr_jb_write(&b, mime->data, mime->len);
    scr_str_release(mime); mime = scr_jb_finish(&b);
  }
  ScrDyn *headers = scr_dyn_new_obj(); scr_dyn_obj_set(headers, "content-type", 12, scr_dyn_new_str(mime)); scr_str_release(mime);
  ScrDyn *init = scr_dyn_new_obj(); scr_dyn_obj_set(init, "headers", 7, headers);
  ScrStr *ok = scr_str_new("OK", 2); scr_dyn_obj_set(init, "statusText", 10, scr_dyn_new_str(ok)); scr_str_release(ok);
  ScrDyn *result = scr_fetch_response_new(body, init); scr_dyn_release(body); scr_dyn_release(init);
  if (result) {
    SfResponse *response = result->v.handle.ptr;
    scr_str_release(response->url); response->url = scr_str_new(url->data, end);
    response->headers->immutable = true;
  }
  return result;
}

ScrPromise *scr_fetch_static(ScrStr *url, ScrDyn *init) {
  if (init && init->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(init);
    if (scr_exc_pending()) {
      scr_dyn_release(view);
      ScrPromise *promise = scr_promise_new();
      scr_promise_reject_pending(promise);
      return promise;
    }
    ScrPromise *result = scr_fetch_static(url, view);
    scr_dyn_release(view);
    return result;
  }
  ScrPromise *promise = scr_promise_new();
  if (init && init->kind != SCR_DYN_OBJ &&
      init->kind != SCR_DYN_UNDEF && init->kind != SCR_DYN_NULL) {
    return sf_reject_now(promise, "fetch failed");
  }
  if (init && init->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < scr_dyn_obj_count(init); i++) {
      ScrDynProp entry = scr_dyn_obj_prop_at(init, i);
      bool supported = sf_name(entry.key, entry.key_len, "method") ||
                       sf_name(entry.key, entry.key_len, "headers") ||
                       sf_name(entry.key, entry.key_len, "body") ||
                       sf_name(entry.key, entry.key_len, "duplex") ||
                       sf_name(entry.key, entry.key_len, "redirect") ||
                       sf_name(entry.key, entry.key_len, "signal");
      bool recognized_unsupported =
          sf_name(entry.key, entry.key_len, "cache") ||
          sf_name(entry.key, entry.key_len, "credentials") ||
          sf_name(entry.key, entry.key_len, "dispatcher") ||
          sf_name(entry.key, entry.key_len, "integrity") ||
          sf_name(entry.key, entry.key_len, "keepalive") ||
          sf_name(entry.key, entry.key_len, "mode") ||
          sf_name(entry.key, entry.key_len, "priority") ||
          sf_name(entry.key, entry.key_len, "referrer") ||
          sf_name(entry.key, entry.key_len, "referrerPolicy") ||
          sf_name(entry.key, entry.key_len, "window");
      if (!supported && recognized_unsupported && entry.value &&
          entry.value->kind != SCR_DYN_UNDEF) {
        return sf_reject_now(promise, "fetch failed");
      }
    }
  }
  /* WebIDL converts dictionary members by name, not object insertion
   * order: body, duplex, headers, method, redirect, signal. Every
   * observable conversion completes before Request validates the URL,
   * method/body combination, or an already-aborted signal. */
  const ScrDyn *body =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "body", 4)
          : NULL;
  bool body_present =
      body && body->kind != SCR_DYN_UNDEF && body->kind != SCR_DYN_NULL;
  bool body_stream =
      body_present &&
      body->kind == SCR_DYN_HANDLE &&
      body->v.handle.tag == SCR_DYNH_WEB_STREAM;
  /* BodyInit's USVString fallback applies to every ordinary value that
   * is not already bytes or a ReadableStream. This includes scalars,
   * arrays, and plain objects (with the ordinary JS object coercion
   * protocol), while null and undefined continue to mean no body. */
  ScrDyn *coerced_body = NULL;
#ifdef SCR_HANDLE_CLASSES
  if (body_present && sf_is_web_body(body)) {
    coerced_body = sf_web_body(body);
    if (!coerced_body) {
      scr_promise_reject_pending(promise);
      return promise;
    }
    body = coerced_body;
    body_stream = true;
  }
#endif
  /* A URLSearchParams body is its serialization, sent as
   * application/x-www-form-urlencoded;charset=UTF-8 (extract a body). */
  bool form_body = false;
  if (body_present && body->kind == SCR_DYN_HANDLE &&
      body->v.handle.tag == SCR_DYNH_SEARCH_PARAMS) {
    coerced_body = scr_dyn_handle_ops_of(body)->invoke(body->v.handle.ptr, (ScrDyn *)body,
                                                       "toString", NULL, 0, "URLSearchParams");
    if (!coerced_body || coerced_body->kind != SCR_DYN_STR) {
      scr_dyn_release(coerced_body);
      return sf_reject_now(promise, "fetch failed");
    }
    body = coerced_body;
    form_body = true;
  }
  if (body_present && !form_body && body->kind != SCR_DYN_STR &&
      body->kind != SCR_DYN_BYTES && !body_stream) {
    ScrStr *text = scr_dyn_string_coerce_js(body);
    if (!text) {
      return sf_reject_now(promise, "fetch failed");
    }
    coerced_body = scr_dyn_new_str(text);
    scr_str_release(text);
    body = coerced_body;
  }

  const ScrDyn *duplex =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "duplex", 6)
          : NULL;
  bool duplex_present =
      duplex && duplex->kind != SCR_DYN_UNDEF;
  bool duplex_half = false;
  if (duplex_present) {
    ScrStr *duplex_mode = scr_dyn_string_coerce_js(duplex);
    if (!duplex_mode) {
      scr_dyn_release(coerced_body);
      return sf_reject_now(promise, "fetch failed");
    }
    duplex_half =
        duplex_mode->len == 4 &&
        memcmp(duplex_mode->data, "half", 4) == 0;
    scr_str_release(duplex_mode);
  }
  if (duplex_present && !duplex_half) {
    scr_dyn_release(coerced_body);
    return sf_reject_now(
        promise, "RequestInit.duplex must be 'half'");
  }

  ScrArr *headers = scr_arr_new(SCR_ELEM_STR, 16);
  const ScrDyn *init_headers =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "headers", 7)
          : NULL;
  if (!sf_add_headers(headers, init_headers, true)) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    return sf_reject_now(promise, "fetch failed");
  }

  ScrStr *method = sf_method_value(init);
  if (!method) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    return sf_reject_now(promise, "fetch failed");
  }

  int redirect_mode;
  if (!sf_redirect_mode(init, &redirect_mode)) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    return sf_reject_now(promise, "fetch failed");
  }

  const ScrDyn *signal_dyn =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "signal", 6)
          : NULL;
  SfSignal *signal = NULL;
  if (signal_dyn && signal_dyn->kind != SCR_DYN_UNDEF &&
      signal_dyn->kind != SCR_DYN_NULL) {
    signal = sf_signal_of(signal_dyn,
                          "Request init.signal must be an AbortSignal");
    if (!signal) {
      scr_dyn_release(coerced_body);
      scr_arr_release(headers);
      scr_str_release(method);
      return sf_reject_now(promise, "fetch failed");
    }
  }

  ScrUrl *u = scr_url_new(url);
  if (!u) {
    sf_throw_url_parse_failure(url);
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    scr_promise_reject_pending(promise);
    return promise;
  }
  if (u->userinfo->len > 0) {
    static const char prefix[] =
        "Request cannot be constructed from a URL that includes credentials: ";
    size_t message_len = sizeof prefix - 1 + url->len;
    char *message = malloc(message_len + 1);
    if (!message) sf_oom();
    memcpy(message, prefix, sizeof prefix - 1);
    memcpy(message + sizeof prefix - 1, url->data, url->len);
    message[message_len] = '\0';
    sf_type_error(message);
    free(message);
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  bool https = sf_eq_ci(u->scheme, "https");
  bool data_url = sf_eq_ci(u->scheme, "data");
  if (!https && !sf_eq_ci(u->scheme, "http") && !data_url) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  if (!sf_method_validate(&method)) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  if (body_stream && !duplex_half) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(
        promise,
        "RequestInit: duplex option is required when sending a body.");
  }
  if (body_present &&
      ((method->len == 3 && memcmp(method->data, "GET", 3) == 0) ||
       (method->len == 4 && memcmp(method->data, "HEAD", 4) == 0))) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(
        promise, "Request with GET/HEAD method cannot have body.");
  }

  /* Fetch Metadata is controlled by the fetch implementation. Undici
   * replaces a caller-provided sec-fetch-mode with "cors". */
  sf_strip_header(&headers, "sec-fetch-mode");
  if (form_body && !sf_pairs_have(headers, "content-type")) {
    sf_push_header_text(headers, "content-type",
                        "application/x-www-form-urlencoded;charset=UTF-8", 47);
  } else if (body && body->kind == SCR_DYN_STR &&
      !sf_pairs_have(headers, "content-type")) {
    sf_push_header_text(headers, "content-type",
                        "text/plain;charset=UTF-8", 24);
  }
  bool has_content_length = false;
  size_t content_length = 0;
  if (!sf_content_length(headers, &has_content_length, &content_length)) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  if (has_content_length && !body_stream) {
    size_t body_length =
        !body_present
            ? 0
            : body->kind == SCR_DYN_STR
                ? body->v.str->len
                : body->v.bytes->len;
    if (body_length != content_length) {
      scr_dyn_release(coerced_body);
      scr_arr_release(headers);
      scr_str_release(method);
      scr_url_release(u);
      return sf_reject_now(promise, "fetch failed");
    }
  }
  /*
   * Request construction validates URL/method/body/headers before fetch
   * observes an already-aborted signal. Undici does the same: abort wins
   * over starting I/O, but never masks a RequestInit validation error.
   */
  if (signal && signal->aborted) {
    scr_dyn_release(coerced_body);
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    ScrDyn *reason = sf_signal_reason_ref(signal);
    sf_reject_promise_reason(promise, reason);
    scr_dyn_release(reason);
    return promise;
  }

  if (data_url) {
    ScrDyn *response = sf_data_response(url);
    scr_dyn_release(coerced_body); scr_arr_release(headers); scr_str_release(method); scr_url_release(u);
    if (response) { scr_promise_resolve_dyn(promise, response); }
    else scr_promise_reject_pending(promise);
    return promise;
  }

  SfTransfer *t = calloc(1, sizeof *t);
  if (!t) sf_oom();
  t->rc = 1; /* registry */
  t->promise = scr_promise_retain(promise);
  t->url = u;
  t->method = method;
  t->headers = headers;
  t->body = body_present ? scr_dyn_retain((ScrDyn *)body) : NULL;
  scr_dyn_release(coerced_body);
  t->redirect_mode = redirect_mode;
  t->request_has_content_length = has_content_length;
  t->request_content_length = content_length;
  if (signal) {
    t->signal = sf_signal_retain(signal);
    t->signal_watch =
        sf_signal_watch(signal, t, &sf_transfer_abort_watch);
  }
  t->live = true;
  t->prev = NULL;
  t->next = sf_live;
  if (sf_live) sf_live->prev = t;
  sf_live = t;
  sf_start_hop(t);
  return promise;
}

/* ── handle dispatch tables + teardown ───────────────────────────── */

static bool sf_no_set(void *ptr, const char *key, size_t len,
                      const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

/* The members invoke answers, as values (ScrDynHandleMethod), with Node's
 * lengths and the brand check each one runs on another receiver. The
 * signal's EventTarget methods are EventTarget's own (sf_signal_get). */
static const ScrDynHandleMethod sf_signal_methods[] = {
    {"throwIfAborted", 0, false}, {NULL, 0, false}};
static const ScrDynHandleMethod sf_stream_methods[] = {
    {"cancel", 0, true}, {"getReader", 0, false}, {NULL, 0, false}};
static const ScrDynHandleMethod sf_reader_methods[] = {
    {"read", 0, true}, {"releaseLock", 0, false}, {"cancel", 0, true},
    {NULL, 0, false}};
static const ScrDynHandleMethod sf_body_methods[] = {
    {"json", 0, true}, {"text", 0, true}, {"bytes", 0, true},
    {"arrayBuffer", 0, true}, {"clone", 0, false}, {NULL, 0, false}};
static const ScrDynHandleMethod sf_headers_methods[] = {
    {"append", 2, false}, {"delete", 1, false}, {"entries", 0, false},
    {"forEach", 1, false}, {"get", 1, false}, {"getSetCookie", 0, false},
    {"has", 1, false}, {"keys", 0, false}, {"set", 2, false},
    {"values", 0, false}, {NULL, 0, false}};

static const ScrDynHandleMethod sf_writable_methods[] = {
    {"abort", 0, true}, {"close", 0, true}, {"getWriter", 0, false},
    {NULL, 0, false}};
static const ScrDynHandleMethod sf_writer_methods[] = {
    {"abort", 0, true}, {"close", 0, true}, {"releaseLock", 0, false},
    {"write", 0, true}, {NULL, 0, false}};

static ScrDyn *sf_rejected(void) {
  ScrPromise *p = scr_promise_settled_ref(NULL, &scr_dyn_retain_v,
                                          &scr_dyn_release_v, NULL);
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return out;
}

static const ScrDynHandleOps sf_signal_ops = {
    "AbortSignal", &sf_signal_retain_v, &sf_signal_release_v,
    &sf_signal_invoke, &sf_signal_get, &sf_signal_set, NULL,
    .methods = sf_signal_methods,
    .invalid_this = "Value of \"this\" must be of type AbortSignal"};
static const ScrDynHandleOps sf_abort_controller_ops = {
    "AbortController", &sf_signal_retain_v, &sf_signal_release_v,
    &sf_abort_controller_invoke, &sf_abort_controller_get, &sf_no_set, NULL};
static const ScrDynHandleOps sf_stream_ops = {
    "ReadableStream", &sf_stream_retain_v, &sf_stream_release_v,
    &sf_stream_invoke, &sf_stream_get, &sf_no_set, NULL,
#ifdef SCR_HANDLE_CLASSES
    .symbol_get = &sf_stream_symbol_get,
#endif
    .methods = sf_stream_methods,
    .invalid_this = "Value of \"this\" must be of type ReadableStream",
    .rejected = &sf_rejected};
static const ScrDynHandleOps sf_reader_ops = {
    "ReadableStreamDefaultReader", &sf_reader_handle_retain_v,
    &sf_reader_handle_release_v, &sf_reader_invoke, &sf_reader_get,
    &sf_no_set, NULL, .methods = sf_reader_methods,
    .invalid_this =
        "Value of \"this\" must be of type ReadableStreamDefaultReader",
    .rejected = &sf_rejected};
static const ScrDynHandleOps sf_controller_ops = {
    "ReadableStreamDefaultController", &sf_stream_retain_v,
    &sf_stream_release_v, &sf_controller_invoke, &sf_controller_get,
    &sf_no_set, NULL};
static const ScrDynHandleOps sf_request_ops = {
    "Request", &sf_request_retain_v, &sf_request_release_v,
    &sf_request_invoke, &sf_request_get, &sf_no_set, NULL,
    .methods = sf_body_methods, .rejected = &sf_rejected};
static const ScrDynHandleOps sf_response_ops = {
    "Response", &sf_response_retain_v, &sf_response_release_v,
    &sf_response_invoke, &sf_response_get, &sf_no_set, NULL,
    .methods = sf_body_methods, .rejected = &sf_rejected};
static const ScrDynHandleOps sf_headers_ops = {
    "Headers", &sf_headers_retain_v, &sf_headers_release_v,
    &sf_headers_invoke, &sf_headers_get, &sf_no_set, NULL, NULL,
    &sf_headers_step, .methods = sf_headers_methods};

static const ScrDynHandleOps sf_transform_ops = {
    "TransformStream", &sf_transform_retain_v, &sf_transform_release_v,
    &sf_transform_invoke, &sf_transform_get, &sf_no_set, NULL};
static const ScrDynHandleOps sf_writable_ops = {
    "WritableStream", &sf_transform_retain_v, &sf_transform_release_v,
    &sf_writable_invoke, &sf_writable_get, &sf_no_set, NULL,
    .methods = sf_writable_methods,
    .invalid_this = "Value of \"this\" must be of type WritableStream",
    .rejected = &sf_rejected};
static const ScrDynHandleOps sf_writer_ops = {
    "WritableStreamDefaultWriter", &sf_writer_handle_retain_v,
    &sf_writer_handle_release_v, &sf_writer_invoke, &sf_writer_get,
    &sf_no_set, NULL, .methods = sf_writer_methods,
    .invalid_this =
        "Value of \"this\" must be of type WritableStreamDefaultWriter",
    .rejected = &sf_rejected};

static void sf_teardown(void) {
  while (sf_live) {
    SfTransfer *t = sf_live;
    if (t->client) scr_http_client_destroy(t->client);
    if (t->response_stream) sf_stream_close(t->response_stream);
    sf_settle(t);
  }
  /*
   * Dyn function boxes deliberately do not participate in trial deletion.
   * At process/session teardown no Web object remains observable, so sever
   * every native callback edge before the collector and RC audit run.
   * Releasing a callback may destroy and unlink another tracked owner.
   */
  while (sf_callback_streams) {
    sf_stream_drop_source_callbacks(sf_callback_streams, true);
  }
  while (sf_reason_signals) {
    sf_signal_drop_reason(sf_reason_signals);
  }
  sf_proxy_snapshot_free();
}

void scr_fetch_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_tls_ca_install();
  scr_global_fetch_install(scr_fetch_function);
  sf_proxy_snapshot();
  scr_net_install();
  scr_dyn_handle_install(SCR_DYNH_ABORT_SIGNAL, &sf_signal_ops);
  scr_dyn_handle_install(SCR_DYNH_ABORT_CONTROLLER,
                         &sf_abort_controller_ops);
  scr_dyn_handle_install(SCR_DYNH_WEB_STREAM, &sf_stream_ops);
#ifdef SCR_HANDLE_CLASSES
  scr_dyn_handle_class_alias_view(SCR_DYNH_WEB_STREAM, &sf_stream_view_of);
#endif
  scr_dyn_handle_install(SCR_DYNH_WEB_READER, &sf_reader_ops);
  scr_dyn_handle_install(SCR_DYNH_WEB_CONTROLLER, &sf_controller_ops);
  scr_dyn_handle_install(SCR_DYNH_FETCH_REQUEST, &sf_request_ops);
  scr_dyn_handle_install(SCR_DYNH_FETCH_RESPONSE, &sf_response_ops);
  scr_dyn_handle_install(SCR_DYNH_FETCH_HEADERS, &sf_headers_ops);
  scr_dyn_handle_install(SCR_DYNH_WEB_TRANSFORM, &sf_transform_ops);
  scr_dyn_handle_install(SCR_DYNH_WEB_WRITABLE, &sf_writable_ops);
  scr_dyn_handle_install(SCR_DYNH_WEB_WRITER, &sf_writer_ops);
  scr_et_signal_core_fn = sf_signal_core_of;
  scr_atexit(sf_teardown);
}

#else /* SCR_FETCH_SIGNAL_ONLY */

static bool sf_no_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr; (void)key; (void)len; (void)value;
  return false;
}
static const ScrDynHandleMethod sf_signal_methods[] = {
    {"throwIfAborted", 0, false}, {NULL, 0, false}};
static const ScrDynHandleOps sf_signal_ops = {
  "AbortSignal", &sf_signal_retain_v, &sf_signal_release_v,
  &sf_signal_invoke, &sf_signal_get, &sf_signal_set, NULL,
  .methods = sf_signal_methods,
  .invalid_this = "Value of \"this\" must be of type AbortSignal" };
static const ScrDynHandleOps sf_abort_controller_ops = {
  "AbortController", &sf_signal_retain_v, &sf_signal_release_v,
  &sf_abort_controller_invoke, &sf_abort_controller_get, &sf_no_set, NULL };
static void sf_signal_teardown(void) {
  while (sf_reason_signals) sf_signal_drop_reason(sf_reason_signals);
}
static void sf_signal_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_ABORT_SIGNAL, &sf_signal_ops);
  scr_dyn_handle_install(SCR_DYNH_ABORT_CONTROLLER, &sf_abort_controller_ops);
  scr_et_signal_core_fn = sf_signal_core_of;
  scr_atexit(sf_signal_teardown);
}

#endif /* SCR_FETCH_SIGNAL_ONLY */

#undef SCR_FETCH_BAD_PORTS
