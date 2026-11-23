/* fs.Utf8Stream (scr_fs_utf8_stream.c) — Node's buffered file writer.
 *
 * Node's class is an EventEmitter rather than a Writable: it buffers writes
 * in memory, flushes them to a file descriptor when the buffer reaches
 * minLength (or on flush/flushSync/end), drops a write that would push the
 * buffer past maxLength (emitting "drop" with it), and reports "ready",
 * "write", "finish" and "close". Events are emitted on the next tick, as in
 * Node; the writes themselves are performed synchronously here, so the
 * observable bytes and event order match while the scheduling stays simple.
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

typedef struct ScrUtf8Stream {
  size_t rc;
  double fd; /* -1 once closed */
  ScrStr *file;
  bool append, fsync, mkdir, sync, writing, closed, ready_sent;
  int content_mode; /* 0 = utf8, 1 = buffer */
  size_t max_length, min_length;
  double file_mode, periodic_flush;
  uint8_t *buf;
  size_t len, cap;
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
  if (s->fd >= 0) {
    scr_fs_close(s->fd);
    if (scr_exc_pending()) scr_exc_clear();
  }
  scr_str_release(s->file);
  scr_u8_listener_drop(s->listeners);
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

/* The buffered bytes, written (and fsynced when asked) at the descriptor. */
static bool scr_u8_write_buffer(ScrUtf8Stream *s) {
  if (s->len != 0) {
    if (s->fd < 0) return false;
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
  }
  if (s->fsync && s->fd >= 0) {
    scr_fs_fsync(s->fd);
    if (scr_exc_pending()) return false;
  }
  return true;
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

static bool scr_u8_append(ScrUtf8Stream *s, const uint8_t *data, size_t len) {
  if (len == 0) return true;
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
  return true;
}

/* write(data): false when the write was dropped (maxLength). */
static ScrDyn *scr_u8_write(ScrUtf8Stream *s, const ScrDyn *data) {
  if (s->closed) {
    static const char message[] = "Cannot call write after a stream was destroyed";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_STREAM_DESTROYED");
    return NULL;
  }
  ScrBytes *bytes = scr_u8_data(s, data);
  if (bytes == NULL) return NULL;
  bool dropped = s->max_length != 0 && s->len + bytes->len > s->max_length;
  if (dropped) {
    ScrDyn *shown = scr_dyn_new_bytes(bytes);
    scr_u8_emit(s, SCR_U8_DROP, shown);
    scr_dyn_release(shown);
    scr_bytes_release(bytes);
    return scr_dyn_new_bool(false);
  }
  scr_u8_append(s, bytes->data, bytes->len);
  scr_bytes_release(bytes);
  if (s->len > 0 && (s->sync || s->len >= s->min_length)) {
    if (!scr_u8_write_buffer(s)) return NULL;
    scr_u8_emit(s, SCR_U8_WRITE, NULL);
  }
  return scr_dyn_new_bool(true);
}

static void scr_u8_close_fd(ScrUtf8Stream *s) {
  if (s->fd >= 0) {
    scr_fs_close(s->fd);
    if (scr_exc_pending()) scr_exc_clear();
    s->fd = -1;
  }
}

static ScrDyn *scr_u8_end(ScrUtf8Stream *s) {
  if (!s->closed) {
    if (!scr_u8_write_buffer(s)) return NULL;
    scr_u8_close_fd(s);
    s->closed = true;
    scr_u8_emit(s, SCR_U8_FINISH, NULL);
    scr_u8_emit(s, SCR_U8_CLOSE, NULL);
    /* The class's listeners go with the closed stream: a listener often
     * closes over the stream itself, and nothing fires after close. */
    scr_u8_listener_drop(s->listeners);
    s->listeners = NULL;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_u8_destroy(ScrUtf8Stream *s) {
  if (!s->closed) {
    s->len = 0;
    scr_u8_close_fd(s);
    s->closed = true;
    scr_u8_emit(s, SCR_U8_CLOSE, NULL);
    scr_u8_listener_drop(s->listeners);
    s->listeners = NULL;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_u8_flush_sync(ScrUtf8Stream *s) {
  if (!scr_u8_write_buffer(s)) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_u8_flush(ScrUtf8Stream *s, ScrDyn *const *args, size_t argc) {
  if (!scr_u8_write_buffer(s)) return NULL;
  if (argc > 0 && args[0] != NULL && args[0]->kind == SCR_DYN_FUNC) {
    ScrDyn *argv[1] = {NULL};
    ScrDyn *r = scr_dyn_call(args[0], argv, 0, "callback");
    if (r) scr_dyn_release(r);
    if (scr_exc_pending()) return NULL;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_u8_reopen(ScrUtf8Stream *s, const ScrDyn *file) {
  if (!scr_u8_write_buffer(s)) return NULL;
  scr_u8_close_fd(s);
  ScrStr *path = scr_dyn_string_coerce_js(file);
  if (path == NULL) return NULL;
  double fd = scr_fs_open_flags(path, O_WRONLY | O_CREAT | (s->append ? O_APPEND : O_TRUNC),
                                s->file_mode);
  if (scr_exc_pending()) {
    scr_str_release(path);
    return NULL;
  }
  scr_str_release(s->file);
  s->file = path;
  s->fd = fd;
  s->closed = false;
  scr_u8_emit(s, SCR_U8_READY, NULL);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* fs.Utf8Stream's options: fd or dest, append, contentMode, fsync,
 * maxLength, minLength, mkdir, mode, periodicFlush, sync. */
static void scr_u8_install(void);

ScrDyn *scr_fs_utf8_stream_new(ScrDyn *options) {
  scr_u8_install();
  ScrUtf8Stream *s = calloc(1, sizeof *s);
  if (s == NULL) scr_u8_oom();
  s->rc = 1;
  s->fd = -1;
  s->append = true;
  s->min_length = 0;
  s->max_length = 0;
  s->file_mode = 438; /* 0o666 */
  if (options != NULL && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL) {
    if (options->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "of type object", options);
      scr_u8_release(s);
      return NULL;
    }
    const ScrDyn *v;
    if ((v = scr_dyn_obj_get(options, "append", 6)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->append = scr_dyn_truthy(v);
    if ((v = scr_dyn_obj_get(options, "fsync", 5)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->fsync = scr_dyn_truthy(v);
    if ((v = scr_dyn_obj_get(options, "mkdir", 5)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->mkdir = scr_dyn_truthy(v);
    if ((v = scr_dyn_obj_get(options, "sync", 4)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->sync = scr_dyn_truthy(v);
    if ((v = scr_dyn_obj_get(options, "contentMode", 11)) != NULL && v->kind == SCR_DYN_STR) {
      s->content_mode = v->v.str->len == 6 && memcmp(v->v.str->data, "buffer", 6) == 0 ? 1 : 0;
    }
    if ((v = scr_dyn_obj_get(options, "maxLength", 9)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->max_length = (size_t)scr_dyn_number_coerce(v);
    if ((v = scr_dyn_obj_get(options, "minLength", 9)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->min_length = (size_t)scr_dyn_number_coerce(v);
    if ((v = scr_dyn_obj_get(options, "mode", 4)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->file_mode = scr_dyn_number_coerce(v);
    if ((v = scr_dyn_obj_get(options, "periodicFlush", 13)) != NULL && v->kind != SCR_DYN_UNDEF)
      s->periodic_flush = scr_dyn_number_coerce(v);
    if (scr_exc_pending()) {
      scr_u8_release(s);
      return NULL;
    }
    if ((v = scr_dyn_obj_get(options, "fd", 2)) != NULL && v->kind != SCR_DYN_UNDEF) {
      s->fd = scr_dyn_number_coerce(v);
    } else if ((v = scr_dyn_obj_get(options, "dest", 4)) != NULL && v->kind == SCR_DYN_STR) {
      s->file = scr_str_retain(v->v.str);
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
      double fd = scr_fs_open_flags(s->file, O_WRONLY | O_CREAT | (s->append ? O_APPEND : O_TRUNC),
                                    s->file_mode);
      if (scr_exc_pending()) {
        scr_u8_release(s);
        return NULL;
      }
      s->fd = fd;
    }
  }

  ScrDyn *box = scr_dyn_new_handle(s, SCR_DYNH_UTF8_STREAM);
  scr_u8_release(s);
  scr_u8_emit(s, SCR_U8_READY, NULL);
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
  /* The open finished when the constructor returned: a listener for the
   * ready event is answered as it registers. */
  if (!s->ready_sent && event == SCR_U8_READY) {
    s->ready_sent = true;
    scr_u8_emit(s, SCR_U8_READY, NULL);
  }
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
  if (strcmp(method, "write") == 0) return scr_u8_write(s, argc > 0 ? args[0] : NULL);
  if (strcmp(method, "end") == 0) return scr_u8_end(s);
  if (strcmp(method, "destroy") == 0) return scr_u8_destroy(s);
  if (strcmp(method, "flushSync") == 0) return scr_u8_flush_sync(s);
  if (strcmp(method, "flush") == 0) return scr_u8_flush(s, args, argc);
  if (strcmp(method, "reopen") == 0) {
    if (argc < 1) {
      scr_dyn_arg_type_fail("file", "of type string", NULL);
      return NULL;
    }
    return scr_u8_reopen(s, args[0]);
  }
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
    ScrDyn *value = scr_dyn_new_str(s->file);
    return value;
  }
  if (SCR_U8_KEY("fsync")) return scr_dyn_new_bool(s->fsync);
  if (SCR_U8_KEY("maxLength")) return scr_dyn_new_num((double)s->max_length);
  if (SCR_U8_KEY("minLength")) return scr_dyn_new_num((double)s->min_length);
  if (SCR_U8_KEY("mkdir")) return scr_dyn_new_bool(s->mkdir);
  if (SCR_U8_KEY("mode")) return scr_dyn_new_num(s->file_mode);
  if (SCR_U8_KEY("periodicFlush")) return scr_dyn_new_num(s->periodic_flush);
  if (SCR_U8_KEY("sync")) return scr_dyn_new_bool(s->sync);
  if (SCR_U8_KEY("writing")) return scr_dyn_new_bool(s->len > 0);
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
