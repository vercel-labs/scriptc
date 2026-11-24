/* fs.Utf8Stream (scr_fs_utf8_stream.c) — Node's buffered file writer.
 *
 * Node's class is an EventEmitter rather than a Writable: it buffers writes
 * in memory, flushes them to a file descriptor when the buffer reaches
 * minLength (or on flush/flushSync/end), drops a write that would push the
 * buffer past maxLength (emitting "drop" with it), and reports "ready",
 * "write", "finish" and "close".
 *
 * EVENT TIMING. The writes themselves are performed inline (Node's ride the
 * threadpool), but every event keeps Node's timing:
 *   - 'ready' is emitted once the open has completed: a process.nextTick
 *     when the descriptor was passed in or the stream is synchronous
 *     (openSync), a threadpool completion otherwise — a deferred
 *     macrotask, so a nextTick or microtask queued around the constructor
 *     runs first. A listener registered on the caller's next statement
 *     still sees it, and so does every listener registered before the
 *     emission.
 *   - 'write' carries the number of bytes the flush wrote. In sync mode it
 *     is emitted from the writeSync inside write()/end()/flushSync; in the
 *     default mode it is the deferred completion of that write, one per
 *     flush, followed by 'drain' when the buffer fell to minLength.
 *   - 'drop' is emitted at the call, with the refused data.
 *   - 'finish' and 'close' are the deferred completion of the close
 *     (Node's fs.close callback): end() flushes and starts the close,
 *     which emits 'finish' (only when the stream is ending) and 'close'
 *     on the following macrotask.
 * A supplied descriptor is closed by end()/destroy() unless it is a
 * stdio descriptor (0, 1 or 2), which Node leaves open.
 */
#include "scr_runtime.h"

#include <fcntl.h>

typedef enum {
  SCR_U8_READY,
  SCR_U8_WRITE,
  SCR_U8_DROP,
  SCR_U8_ERROR,
  SCR_U8_CLOSE,
  SCR_U8_FINISH,
  SCR_U8_DRAIN,
  SCR_U8_EVENT_COUNT
} ScrU8Event;

typedef struct ScrU8Listener {
  struct ScrU8Listener *next;
  ScrDyn *fn; /* +1 */
  int event;
  bool once;
} ScrU8Listener;

typedef struct ScrU8FlushCb {
  struct ScrU8FlushCb *next;
  ScrDyn *cb; /* +1 */
} ScrU8FlushCb;

typedef struct ScrUtf8Stream {
  size_t rc;
  double fd; /* Node keeps the number after close (#fd is not reset) */
  ScrStr *file;
  ScrDyn *mode_value; /* options.mode as given (+1), for the getter */
  double open_mode;   /* parseFileMode's result (0o666 by default) */
  bool append, fsync, mkdir, sync;
  bool writing;      /* a write completion is deferred */
  bool closed;       /* the close began (Node's #destroyed) */
  bool ending;       /* end() ran */
  bool ready_queued; /* a 'ready' emission is queued */
  bool drain_queued; /* a sync-mode 'drain' tick is queued */
  int content_mode;  /* 0 = utf8, 1 = buffer */
  size_t max_length, min_length, hwm;
  double periodic_flush;
  uint8_t *buf;
  size_t len, cap;
  size_t release_bytes; /* the flush a deferred completion reports */
  ScrU8FlushCb *flush_cbs;
  ScrU8Listener *listeners;
} ScrUtf8Stream;

static void scr_u8_oom(void) { scr_trap("scriptc: out of memory\n"); }

static void scr_u8_listener_drop(ScrU8Listener *l) {
  while (l != NULL) {
    ScrU8Listener *next = l->next;
    scr_dyn_release(l->fn);
    free(l);
    l = next;
  }
}

static ScrUtf8Stream *scr_u8_retain(ScrUtf8Stream *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

static void scr_u8_release(ScrUtf8Stream *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc != 0) return;
  if (!s->closed && s->fd >= 0 && s->fd != 1 && s->fd != 2) {
    scr_fs_close(s->fd);
    if (scr_exc_pending()) scr_exc_clear();
  }
  scr_str_release(s->file);
  scr_dyn_release(s->mode_value);
  scr_u8_listener_drop(s->listeners);
  while (s->flush_cbs != NULL) {
    ScrU8FlushCb *next = s->flush_cbs->next;
    scr_dyn_release(s->flush_cbs->cb);
    free(s->flush_cbs);
    s->flush_cbs = next;
  }
  free(s->buf);
  free(s);
}

static void *scr_u8_retain_v(void *h) { return scr_u8_retain(h); }
static void scr_u8_release_v(void *h) { scr_u8_release(h); }

/* One event's listeners, called in registration order. The matching
 * listeners are snapshotted first: a callback that registers or removes a
 * listener — or that closes the stream, which drops the list — must not
 * invalidate this walk. A once listener is unlinked as the snapshot is
 * taken, before its call, as EventEmitter does. */
static void scr_u8_emit(ScrUtf8Stream *s, int event, ScrDyn *arg) {
  size_t count = 0;
  for (ScrU8Listener *l = s->listeners; l != NULL; l = l->next) {
    if (l->event == event) count++;
  }
  if (count == 0) return;
  ScrDyn **fns = malloc(count * sizeof *fns);
  if (fns == NULL) scr_u8_oom();
  size_t at = 0;
  ScrU8Listener **link = &s->listeners;
  while (*link != NULL && at < count) {
    ScrU8Listener *l = *link;
    if (l->event != event) {
      link = &l->next;
      continue;
    }
    if (l->once) {
      fns[at++] = l->fn; /* the snapshot takes the unlinking listener's reference */
      *link = l->next;
      l->next = NULL;
      l->fn = NULL;
      scr_u8_listener_drop(l);
    } else {
      fns[at++] = scr_dyn_retain(l->fn); /* the list keeps its own */
      link = &l->next;
    }
  }
  ScrDyn *argv[1];
  size_t argc = arg != NULL ? 1 : 0;
  if (argc) argv[0] = arg;
  for (size_t i = 0; i < at; i++) {
    ScrDyn *r = scr_dyn_call(fns[i], argv, argc, "listener");
    if (r) scr_dyn_release(r);
    scr_dyn_release(fns[i]);
    if (scr_exc_pending()) break;
  }
  for (size_t i = at; i < count; i++) scr_dyn_release(fns[i]);
  free(fns);
}

/* ── deferred steps ───────────────────────────────────────────────────
 * Node's open, write and close completions arrive on threadpool callbacks,
 * which the loop delivers as macrotasks (one per turn, with the tick and
 * microtask checkpoints between them). scr_loop_defer is that queue: one
 * closure per step, the stream captured in a box so the step cannot run
 * against a freed stream, and the queue's own shutdown releases whatever
 * the loop never delivered. */
static void scr_u8_step_ready(ScrClosure *self);
static void scr_u8_step_release(ScrClosure *self);
static void scr_u8_step_close(ScrClosure *self);
static void scr_u8_flush_cbs_run(ScrUtf8Stream *s);

static void scr_u8_defer(ScrUtf8Stream *s, void (*step)(ScrClosure *)) {
  ScrClosure *cb = scr_closure_new((void *)step, 1);
  cb->caps[0] = scr_box_new_obj(scr_u8_retain_v, scr_u8_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_u8_retain(s));
  scr_loop_defer(cb);
}

/* A threadpool-style completion still runs in the AsyncLocalStorage
 * context of the call that queued it, as Node's does. */
static ScrUtf8Stream *scr_u8_step_stream(ScrClosure *self) {
  return scr_box_get_ref(self->caps[0]); /* +1, released by the caller */
}

/* ── nextTick emissions ───────────────────────────────────────────────
 * The sync-mode 'drain' and the 'ready' of a stream whose descriptor was
 * already open are process.nextTicks in Node. Each is posted on the user
 * tick queue through a raw marker; the entry owns a stream reference and
 * the atexit hook releases entries the loop never reached. */
typedef struct ScrU8Tick {
  struct ScrU8Tick *next;
  ScrUtf8Stream *s; /* +1 */
  int event;
} ScrU8Tick;

static SCR_TL ScrU8Tick *scr_u8_tick_head = NULL;
static SCR_TL ScrU8Tick *scr_u8_tick_tail = NULL;
static SCR_TL bool scr_u8_tick_cleanup = false;

static void scr_u8_tick_shutdown(void) {
  while (scr_u8_tick_head != NULL) {
    ScrU8Tick *t = scr_u8_tick_head;
    scr_u8_tick_head = t->next;
    scr_u8_release(t->s);
    free(t);
  }
  scr_u8_tick_tail = NULL;
}

static void scr_u8_tick_dispatch(void) {
  ScrU8Tick *t = scr_u8_tick_head;
  if (t == NULL) return;
  scr_u8_tick_head = t->next;
  if (scr_u8_tick_head == NULL) scr_u8_tick_tail = NULL;
  ScrUtf8Stream *s = t->s;
  if (!scr_exc_pending()) {
    if (t->event == SCR_U8_DRAIN) s->drain_queued = false;
    else if (t->event == SCR_U8_READY) s->ready_queued = false;
    scr_u8_emit(s, t->event, NULL);
    if (t->event == SCR_U8_DRAIN && !scr_exc_pending()) scr_u8_flush_cbs_run(s);
  }
  scr_u8_release(s);
  free(t);
}

static void scr_u8_tick(ScrUtf8Stream *s, int event) {
  if (!scr_u8_tick_cleanup) {
    scr_atexit(scr_u8_tick_shutdown);
    scr_u8_tick_cleanup = true;
  }
  ScrU8Tick *t = malloc(sizeof *t);
  if (t == NULL) scr_u8_oom();
  t->next = NULL;
  t->s = scr_u8_retain(s);
  t->event = event;
  if (scr_u8_tick_tail != NULL) scr_u8_tick_tail->next = t;
  else scr_u8_tick_head = t;
  scr_u8_tick_tail = t;
  scr_next_tick_raw(&scr_u8_tick_dispatch);
}

/* ── errors and helpers ─────────────────────────────────────────────── */

/* Node's ERR_INVALID_STATE ("Invalid state: <detail>") as a thrown error. */
static void scr_u8_throw_invalid_state(const char *message, size_t len) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, len, "ERR_INVALID_STATE");
}

/* The same error as a dyn value, for a flush callback's argument. */
static ScrDyn *scr_u8_invalid_state_value(const char *message, size_t len) {
  ScrStr *text = scr_str_new(message, len);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_code(e, "ERR_INVALID_STATE");
  ScrDyn *value = scr_dyn_from_error(e);
  scr_error_release(e);
  return value;
}

static bool scr_u8_is_bytes(const ScrDyn *v) {
  return v->kind == SCR_DYN_BYTES || scr_array_buffer_is(v) || scr_shared_array_buffer_is(v);
}

/* The bytes a write's data stands for (+1): a string in utf8 mode, a
 * buffer or view in buffer mode — Node refuses the other kind in each. */
static ScrBytes *scr_u8_data(const ScrUtf8Stream *s, const ScrDyn *data) {
  if (data == NULL) {
    scr_dyn_arg_type_fail("data", "of type string", NULL);
    return NULL;
  }
  if (s->content_mode == 0) {
    if (data->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("data", "of type string", data);
      return NULL;
    }
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *bytes = scr_bytes_from_str(data->v.str, utf8);
    scr_str_release(utf8);
    return bytes;
  }
  if (!scr_u8_is_bytes(data)) {
    scr_dyn_arg_type_fail("data",
                          "of type Buffer or an instance of TypedArray or DataView", data);
    return NULL;
  }
  return scr_bytes_buffer_source(data);
}

static void scr_u8_append(ScrUtf8Stream *s, const uint8_t *data, size_t len) {
  if (len == 0) return;
  if (s->len + len > s->cap) {
    size_t cap = s->cap ? s->cap : 256;
    while (cap < s->len + len) cap *= 2;
    uint8_t *grown = realloc(s->buf, cap);
    if (grown == NULL) scr_u8_oom();
    s->buf = grown;
    s->cap = cap;
  }
  memcpy(s->buf + s->len, data, len);
  s->len += len;
}

/* The buffered bytes, written (and fsynced when asked) at the descriptor.
 * *written reports the bytes flushed. False with an exception pending. */
static bool scr_u8_write_out(ScrUtf8Stream *s, size_t *written) {
  *written = 0;
  if (s->len != 0) {
    if (s->closed || s->fd < 0) {
      s->len = 0;
      return false;
    }
    size_t at = 0;
    while (at < s->len) {
      double wrote = scr_fs_write_mem(s->fd, s->buf + at, s->len - at, -1);
      if (scr_exc_pending()) return false;
      if (!(wrote > 0)) {
        s->len = 0;
        return false;
      }
      at += (size_t)wrote;
    }
    s->len = 0;
    *written = at;
  }
  if (s->fsync && s->fd >= 0) {
    scr_fs_fsync(s->fd);
    if (scr_exc_pending()) return false;
  }
  return true;
}

static void scr_u8_actual_write(ScrUtf8Stream *s);
static void scr_u8_begin_close(ScrUtf8Stream *s);

/* The flush callbacks a drain completes. Node answers them from the drain
 * listener it registered, i.e. right after the event's listeners. */
static void scr_u8_flush_cbs_run(ScrUtf8Stream *s) {
  while (s->flush_cbs != NULL) {
    ScrU8FlushCb *head = s->flush_cbs;
    s->flush_cbs = head->next;
    /* Node answers these from the fsync completion, whose error slot is
     * null; the immediate minLength-0 path calls the callback with no
     * arguments instead. */
    ScrDyn *argv[1] = {scr_dyn_new_null()};
    ScrDyn *r = scr_dyn_call(head->cb, argv, 1, "callback");
    if (r) scr_dyn_release(r);
    scr_dyn_release(argv[0]);
    scr_dyn_release(head->cb);
    free(head);
    if (scr_exc_pending()) return;
  }
}

/* The completion of one flush (Node's #release): report the bytes, then
 * either flush what is left, close for an ending stream, or announce the
 * drain. */
static void scr_u8_release_done(ScrUtf8Stream *s, size_t written) {
  s->writing = false;
  ScrDyn *count = scr_dyn_new_num((double)written);
  scr_u8_emit(s, SCR_U8_WRITE, count);
  scr_dyn_release(count);
  if (scr_exc_pending()) return;
  if (s->len > s->min_length) {
    scr_u8_actual_write(s);
    return;
  }
  if (s->ending) {
    if (s->len > 0) scr_u8_actual_write(s);
    else scr_u8_begin_close(s);
    return;
  }
  if (s->sync) {
    if (!s->drain_queued) {
      s->drain_queued = true;
      scr_u8_tick(s, SCR_U8_DRAIN);
    }
    return;
  }
  scr_u8_emit(s, SCR_U8_DRAIN, NULL);
  if (!scr_exc_pending()) scr_u8_flush_cbs_run(s);
}

/* Flush the buffer: synchronously in sync mode (the 'write' event fires at
 * the call, as writeSync's completion does), otherwise as a deferred
 * completion carrying the byte count. */
static void scr_u8_actual_write(ScrUtf8Stream *s) {
  if (s->writing || s->closed || s->fd < 0) return;
  size_t written = 0;
  if (!scr_u8_write_out(s, &written)) return;
  s->writing = true;
  if (s->sync) {
    scr_u8_release_done(s, written);
    return;
  }
  s->release_bytes = written;
  scr_u8_defer(s, scr_u8_step_release);
}

static void scr_u8_step_release(ScrClosure *self) {
  ScrUtf8Stream *s = scr_u8_step_stream(self);
  if (s != NULL && !scr_exc_pending()) scr_u8_release_done(s, s->release_bytes);
  scr_u8_release(s);
}

static void scr_u8_step_ready(ScrClosure *self) {
  ScrUtf8Stream *s = scr_u8_step_stream(self);
  if (s != NULL && !scr_exc_pending()) {
    s->ready_queued = false;
    scr_u8_emit(s, SCR_U8_READY, NULL);
  }
  scr_u8_release(s);
}

/* The close's completion: 'finish' for an ending stream, then 'close'. The
 * class's listeners go with the closed stream — a listener often closes
 * over the stream itself, and nothing fires after close. */
static void scr_u8_step_close(ScrClosure *self) {
  ScrUtf8Stream *s = scr_u8_step_stream(self);
  if (s != NULL && !scr_exc_pending()) {
    if (s->ending) {
      scr_u8_emit(s, SCR_U8_FINISH, NULL);
      if (scr_exc_pending()) {
        scr_u8_release(s);
        return;
      }
    }
    scr_u8_emit(s, SCR_U8_CLOSE, NULL);
    scr_u8_flush_cbs_run(s);
    s->flush_cbs = NULL;
    scr_u8_listener_drop(s->listeners);
    s->listeners = NULL;
  } else if (s != NULL) {
    scr_u8_listener_drop(s->listeners);
    s->listeners = NULL;
    while (s->flush_cbs != NULL) scr_u8_flush_cbs_run(s);
  }
  scr_u8_release(s);
}

/* end()/destroy(): stop taking writes, flush nothing more, and let the
 * descriptor go — except a stdio one, which Node leaves open. */
static void scr_u8_begin_close(ScrUtf8Stream *s) {
  if (s->closed) return;
  s->closed = true;
  s->len = 0;
  if (s->fd >= 0 && s->fd != 1 && s->fd != 2) {
    scr_fs_close(s->fd);
    if (scr_exc_pending()) scr_exc_clear();
  }
  scr_u8_defer(s, scr_u8_step_close);
}

/* 'ready' once the stream is open: a tick when the descriptor is already
 * open (passed in, or opened by openSync in sync mode), the deferred
 * completion of the open otherwise. */
static void scr_u8_queue_ready(ScrUtf8Stream *s, bool descriptor_open) {
  if (s->ready_queued) return;
  s->ready_queued = true;
  if (descriptor_open) scr_u8_tick(s, SCR_U8_READY);
  else scr_u8_defer(s, scr_u8_step_ready);
}

/* write(data): false when the buffer is at Node's high-water mark. */
static ScrDyn *scr_u8_write(ScrUtf8Stream *s, const ScrDyn *data) {
  if (s->closed) {
    static const char message[] = "Invalid state: Utf8Stream is destroyed";
    scr_u8_throw_invalid_state(message, sizeof message - 1);
    return NULL;
  }
  ScrBytes *bytes = scr_u8_data(s, data);
  if (bytes == NULL) return NULL;
  size_t total = s->len + bytes->len;
  if (s->max_length != 0 && total > s->max_length) {
    /* Node reports the refused value itself, at the call. */
    scr_u8_emit(s, SCR_U8_DROP, (ScrDyn *)data);
    scr_bytes_release(bytes);
    return scr_dyn_new_bool(s->len < s->hwm);
  }
  scr_u8_append(s, bytes->data, bytes->len);
  scr_bytes_release(bytes);
  if (!s->writing && s->len >= s->min_length) {
    scr_u8_actual_write(s);
    if (scr_exc_pending()) return NULL;
  }
  return scr_dyn_new_bool(s->len < s->hwm);
}

static ScrDyn *scr_u8_end(ScrUtf8Stream *s) {
  if (s->closed) {
    static const char message[] = "Invalid state: Utf8Stream is destroyed";
    scr_u8_throw_invalid_state(message, sizeof message - 1);
    return NULL;
  }
  if (s->ending) return scr_dyn_retain(scr_dyn_undefined());
  s->ending = true;
  if (s->writing) return scr_dyn_retain(scr_dyn_undefined()); /* the completion closes */
  if (s->len > 0 && s->fd >= 0) scr_u8_actual_write(s);
  else scr_u8_begin_close(s);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_u8_destroy(ScrUtf8Stream *s) {
  scr_u8_begin_close(s);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_u8_flush_sync(ScrUtf8Stream *s) {
  static const char destroyed[] = "Invalid state: Utf8Stream is destroyed";
  static const char no_fd[] = "Invalid state: Invalid file descriptor";
  if (s->closed) {
    scr_u8_throw_invalid_state(destroyed, sizeof destroyed - 1);
    return NULL;
  }
  if (s->fd < 0) {
    scr_u8_throw_invalid_state(no_fd, sizeof no_fd - 1);
    return NULL;
  }
  size_t written = 0;
  if (!scr_u8_write_out(s, &written)) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

/* flush([cb]): with a positive minLength the buffer is written and the
 * callback answers on the drain, as Node's does; at minLength 0 writes
 * already flush themselves and the callback runs at the call. */
static ScrDyn *scr_u8_flush(ScrUtf8Stream *s, ScrDyn *const *args, size_t argc) {
  ScrDyn *cb = NULL;
  if (argc > 0 && args[0] != NULL && args[0]->kind != SCR_DYN_UNDEF &&
      args[0]->kind != SCR_DYN_NULL) {
    if (args[0]->kind != SCR_DYN_FUNC) {
      scr_dyn_arg_type_fail("cb", "of type function", args[0]);
      return NULL;
    }
    cb = args[0];
  }
  if (s->closed) {
    static const char message[] = "Invalid state: Utf8Stream is destroyed";
    if (cb != NULL) {
      ScrDyn *error = scr_u8_invalid_state_value(message, sizeof message - 1);
      ScrDyn *argv[1] = {error};
      ScrDyn *r = scr_dyn_call(cb, argv, 1, "callback");
      if (r) scr_dyn_release(r);
      scr_dyn_release(error);
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (s->min_length <= 0) {
    if (cb != NULL) {
      ScrDyn *r = scr_dyn_call(cb, NULL, 0, "callback");
      if (r) scr_dyn_release(r);
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (cb != NULL) {
    ScrU8FlushCb *entry = malloc(sizeof *entry);
    if (entry == NULL) scr_u8_oom();
    entry->next = NULL;
    entry->cb = scr_dyn_retain(cb);
    ScrU8FlushCb **tail = &s->flush_cbs;
    while (*tail != NULL) tail = &(*tail)->next;
    *tail = entry;
  }
  /* The flush's completion (drain, or close for an ending stream) answers
   * the queued callbacks. */
  scr_u8_actual_write(s);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_u8_reopen(ScrUtf8Stream *s, const ScrDyn *file) {
  static const char destroyed[] = "Invalid state: Utf8Stream is destroyed";
  static const char no_file[] =
      "Operation failed: Unable to reopen a file descriptor, you must pass a file to SonicBoom";
  if (s->closed) {
    scr_u8_throw_invalid_state(destroyed, sizeof destroyed - 1);
    return NULL;
  }
  if (s->ending) return scr_dyn_retain(scr_dyn_undefined());
  if (s->file == NULL && (file == NULL || file->kind == SCR_DYN_UNDEF)) {
    scr_throw_error_msg_code(SCR_ERR_ERROR, no_file, sizeof no_file - 1, "ERR_OPERATION_FAILED");
    return NULL;
  }
  size_t written = 0;
  if (!scr_u8_write_out(s, &written)) return NULL;
  ScrStr *path = NULL;
  if (file != NULL && file->kind != SCR_DYN_UNDEF && file->kind != SCR_DYN_NULL) {
    path = scr_dyn_string_coerce_js(file);
    if (path == NULL) return NULL;
  }
  if (s->fd >= 0 && s->fd != 1 && s->fd != 2) {
    scr_fs_close(s->fd);
    if (scr_exc_pending()) {
      scr_str_release(path);
      return NULL;
    }
  }
  if (path != NULL) {
    if (!scr_fs_path_ok(path, "path")) {
      scr_str_release(path);
      return NULL;
    }
    double fd = scr_fs_open_flags(path, O_WRONLY | O_CREAT | O_NONBLOCK | (s->append ? O_APPEND : O_TRUNC),
                                  s->open_mode);
    if (scr_exc_pending()) {
      scr_str_release(path);
      return NULL;
    }
    scr_str_release(s->file);
    s->file = path;
    s->fd = fd;
  }
  scr_u8_queue_ready(s, s->sync);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* ── the constructor ────────────────────────────────────────────────── */

static void scr_u8_install(void);

/* parseFileMode: a nullish mode takes 0o666, an octal string parses base
 * 8, a number goes through validateUint32 — the rule Node's fs.open
 * applies to the mode this class passes through. */
static bool scr_u8_parse_mode(const ScrDyn *value, double *out) {
  if (value == NULL || value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    *out = 438; /* 0o666 */
    return true;
  }
  if (value->kind == SCR_DYN_STR) return scr_fs_mode_octal(value->v.str, "mode", out);
  if (value->kind == SCR_DYN_NUM) return scr_fs_mode_number_valid(value->v.num, "mode", out);
  scr_dyn_arg_type_fail("mode", "of type number", value);
  return false;
}

static void scr_u8_option_bool(const ScrDyn *options, const char *key, size_t key_len, bool *out) {
  const ScrDyn *v = scr_dyn_obj_get(options, key, key_len);
  if (v != NULL && v->kind != SCR_DYN_UNDEF) *out = scr_dyn_truthy(v);
}

ScrDyn *scr_fs_utf8_stream_new(ScrDyn *options) {
  scr_u8_install();
  ScrUtf8Stream *s = calloc(1, sizeof *s);
  if (s == NULL) scr_u8_oom();
  s->rc = 1;
  s->fd = -1;
  s->append = true;
  s->open_mode = 438; /* 0o666 */
  /* Node's #hwm: writes answer false once the buffer reaches it. */
  s->hwm = 16387;
  bool descriptor_given = false;
  if (options != NULL && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL) {
    if (options->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "of type object", options);
      scr_u8_release(s);
      return NULL;
    }
    const ScrDyn *v;
    scr_u8_option_bool(options, "append", 6, &s->append);
    scr_u8_option_bool(options, "fsync", 5, &s->fsync);
    scr_u8_option_bool(options, "mkdir", 5, &s->mkdir);
    scr_u8_option_bool(options, "sync", 4, &s->sync);
    if ((v = scr_dyn_obj_get(options, "contentMode", 11)) != NULL && v->kind == SCR_DYN_STR) {
      s->content_mode = v->v.str->len == 6 && memcmp(v->v.str->data, "buffer", 6) == 0 ? 1 : 0;
    }
    if ((v = scr_dyn_obj_get(options, "maxLength", 9)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->max_length = (size_t)scr_dyn_number_coerce(v);
    if ((v = scr_dyn_obj_get(options, "minLength", 9)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->min_length = (size_t)scr_dyn_number_coerce(v);
    if ((v = scr_dyn_obj_get(options, "periodicFlush", 13)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->periodic_flush = scr_dyn_number_coerce(v);
    if (scr_exc_pending()) {
      scr_u8_release(s);
      return NULL;
    }
    if (s->min_length > s->hwm) s->hwm = s->min_length;
    if ((v = scr_dyn_obj_get(options, "mode", 4)) != NULL && v->kind != SCR_DYN_UNDEF) {
      s->mode_value = scr_dyn_retain((ScrDyn *)v);
    }
    if ((v = scr_dyn_obj_get(options, "fd", 2)) != NULL && v->kind != SCR_DYN_UNDEF) {
      /* Node accepts a number (an open descriptor) or a path string. */
      if (v->kind == SCR_DYN_NUM) {
        s->fd = v->v.num;
        descriptor_given = true;
      } else if (v->kind == SCR_DYN_STR) {
        s->file = scr_str_retain(v->v.str);
      } else {
        scr_dyn_arg_type_fail("fd", "one of type number or string", v);
        scr_u8_release(s);
        return NULL;
      }
    } else if ((v = scr_dyn_obj_get(options, "dest", 4)) != NULL && v->kind == SCR_DYN_STR) {
      s->file = scr_str_retain(v->v.str);
    }
  }

  if (!descriptor_given) {
    if (s->file == NULL) {
      scr_dyn_arg_type_fail("fd", "one of type number or string", scr_dyn_undefined());
      scr_u8_release(s);
      return NULL;
    }
    /* The path is validated before anything is created, as Node's open
     * does: a NUL byte reports the invalid path. */
    if (!scr_fs_path_ok(s->file, "path")) {
      scr_u8_release(s);
      return NULL;
    }
    if (!scr_u8_parse_mode(s->mode_value, &s->open_mode)) {
      scr_u8_release(s);
      return NULL;
    }
    if (s->mkdir) {
      /* mkdir: true creates the destination's directory. */
      ScrStr *dir = scr_path_dirname(s->file);
      scr_fs_mkdir_recursive(dir);
      scr_str_release(dir);
      if (scr_exc_pending()) {
        scr_u8_release(s);
        return NULL;
      }
    }
    /* O_NONBLOCK keeps the inline open from parking the loop when the
     * path is a FIFO with no writer: the open answers ENXIO instead of
     * waiting for one. Node's default (sync: false) waits on the thread
     * pool, so it opens once a writer arrives; the bytes and errors that
     * follow are otherwise the same. */
    double fd = scr_fs_open_flags(s->file, O_WRONLY | O_CREAT | O_NONBLOCK | (s->append ? O_APPEND : O_TRUNC),
                                  s->open_mode);
    if (scr_exc_pending()) {
      scr_u8_release(s);
      return NULL;
    }
    s->fd = fd;
  }

  ScrDyn *box = scr_dyn_new_handle(s, SCR_DYNH_UTF8_STREAM);
  scr_u8_queue_ready(s, descriptor_given || s->sync);
  scr_u8_release(s);
  return box;
}

/* ── the class's checked-dynamic surface ─────────────────────────────── */

static int scr_u8_event_of(const ScrDyn *v) {
  static const char *names[] = {"ready", "write", "drop", "error", "close", "finish", "drain"};
  if (v == NULL || v->kind != SCR_DYN_STR) return -1;
  for (int i = 0; i < SCR_U8_EVENT_COUNT; i++) {
    size_t len = strlen(names[i]);
    if (v->v.str->len == len && memcmp(v->v.str->data, names[i], len) == 0) return i;
  }
  return -1;
}

static ScrDyn *scr_u8_on(ScrUtf8Stream *s, ScrDyn *self, ScrDyn *const *args, size_t argc, bool once,
                         bool prepend) {
  if (argc < 2 || args[1] == NULL || args[1]->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("listener", "of type function", argc >= 2 ? args[1] : NULL);
    return NULL;
  }
  int event = scr_u8_event_of(args[0]);
  if (event < 0) {
    /* EventEmitter accepts any event name; the ones this class emits are
     * the seven above, and a listener on another name never fires. */
    return scr_dyn_retain(self);
  }
  ScrU8Listener *l = calloc(1, sizeof *l);
  if (l == NULL) scr_u8_oom();
  l->fn = scr_dyn_retain(args[1]);
  l->event = event;
  l->once = once;
  if (prepend || s->listeners == NULL) {
    l->next = s->listeners;
    s->listeners = l;
  } else {
    ScrU8Listener *tail = s->listeners;
    while (tail->next != NULL) tail = tail->next;
    tail->next = l;
  }
  /* Node clears the drain-collapse flag when a drain listener is added, so
   * a drain scheduled before the registration still answers it. */
  if (event == SCR_U8_DRAIN) s->drain_queued = false;
  return scr_dyn_retain(self);
}

static ScrDyn *scr_u8_off(ScrUtf8Stream *s, ScrDyn *self, ScrDyn *const *args, size_t argc) {
  if (argc < 2) return scr_dyn_retain(self);
  int event = scr_u8_event_of(args[0]);
  ScrU8Listener **link = &s->listeners;
  while (*link != NULL) {
    ScrU8Listener *l = *link;
    if (l->event == event && l->fn == args[1]) {
      *link = l->next;
      l->next = NULL;
      scr_u8_listener_drop(l);
      if (argc < 3) break;
      continue;
    }
    link = &l->next;
  }
  return scr_dyn_retain(self);
}

static ScrDyn *scr_u8_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                             size_t argc, const char *what) {
  ScrUtf8Stream *s = h;
  (void)what;
  if (strcmp(method, "write") == 0) {
    if (argc < 1) {
      scr_dyn_arg_type_fail("data", "of type string", NULL);
      return NULL;
    }
    return scr_u8_write(s, args[0]);
  }
  if (strcmp(method, "end") == 0) return scr_u8_end(s);
  if (strcmp(method, "destroy") == 0) return scr_u8_destroy(s);
  if (strcmp(method, "flushSync") == 0) return scr_u8_flush_sync(s);
  if (strcmp(method, "flush") == 0) return scr_u8_flush(s, args, argc);
  if (strcmp(method, "reopen") == 0) return scr_u8_reopen(s, argc > 0 ? args[0] : NULL);
  if (strcmp(method, "on") == 0 || strcmp(method, "addListener") == 0)
    return scr_u8_on(s, self, args, argc, false, false);
  if (strcmp(method, "once") == 0) return scr_u8_on(s, self, args, argc, true, false);
  if (strcmp(method, "prependListener") == 0) return scr_u8_on(s, self, args, argc, false, true);
  if (strcmp(method, "prependOnceListener") == 0) return scr_u8_on(s, self, args, argc, true, true);
  if (strcmp(method, "off") == 0 || strcmp(method, "removeListener") == 0)
    return scr_u8_off(s, self, args, argc);
  static const char message[] = "fs.Utf8Stream member is not supported yet [SC2020]";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_NOT_SUPPORTED");
  return NULL;
}

static ScrDyn *scr_u8_get(void *h, const char *key, size_t key_len) {
  ScrUtf8Stream *s = h;
#define SCR_U8_KEY(k) (key_len == sizeof(k) - 1 && memcmp(key, k, sizeof(k) - 1) == 0)
  if (SCR_U8_KEY("append")) return scr_dyn_new_bool(s->append);
  if (SCR_U8_KEY("contentMode")) {
    ScrStr *mode = s->content_mode ? scr_str_new("buffer", 6) : scr_str_new("utf8", 4);
    ScrDyn *value = scr_dyn_new_str(mode);
    scr_str_release(mode); /* the value holds its own reference */
    return value;
  }
  if (SCR_U8_KEY("fd")) return scr_dyn_new_num(s->fd);
  if (SCR_U8_KEY("file")) {
    if (s->file == NULL) return scr_dyn_new_null();
    return scr_dyn_new_str(s->file);
  }
  if (SCR_U8_KEY("fsync")) return scr_dyn_new_bool(s->fsync);
  if (SCR_U8_KEY("maxLength")) return scr_dyn_new_num((double)s->max_length);
  if (SCR_U8_KEY("minLength")) return scr_dyn_new_num((double)s->min_length);
  if (SCR_U8_KEY("mkdir")) return scr_dyn_new_bool(s->mkdir);
  if (SCR_U8_KEY("mode"))
    return s->mode_value != NULL ? scr_dyn_retain(s->mode_value) : scr_dyn_retain(scr_dyn_undefined());
  if (SCR_U8_KEY("periodicFlush")) return scr_dyn_new_num(s->periodic_flush);
  if (SCR_U8_KEY("sync")) return scr_dyn_new_bool(s->sync);
  if (SCR_U8_KEY("writing")) return scr_dyn_new_bool(s->writing);
#undef SCR_U8_KEY
  return NULL;
}

static const ScrDynHandleOps scr_u8_ops = {
    .cls = "Utf8Stream",
    .retain = scr_u8_retain_v,
    .release = scr_u8_release_v,
    .invoke = scr_u8_invoke,
    .get = scr_u8_get,
};

static void scr_u8_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_UTF8_STREAM, &scr_u8_ops);
}
