/* The fs/promises FileHandle slice. Kept in its own gated translation unit
 * so programs that never open a handle retain the base runtime's size class.
 * Operations settle through scr_async.c's ordinary promise helpers: a pending
 * synchronous exception becomes a rejection with the same Error payload. */
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#ifdef _WIN32
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

#ifndef O_BINARY
#define O_BINARY 0
#endif
#ifndef O_SYNC
#define O_SYNC 0
#endif

/* One shared mutable descriptor slot gives aliases Node's close/fd behavior.
 * The last native reference closes a still-open descriptor; explicit close
 * reports errors through its promise wrapper instead. */
struct ScrFileHandle {
  size_t rc;
  int fd;
  /* Node's kRefs: the handle itself counts 1, every stream over it one
   * more. close() resolves once the count reaches zero. */
  size_t refs;
  ScrFileHandleHook *hooks; /* 'close' listeners (the streams' close()) */
  ScrPromise *close_wait;   /* close() waiting for the streams, or NULL */
};

struct ScrFileHandleHook {
  void (*fn)(void *ctx);
  void *ctx;
  ScrFileHandleHook *next;
};

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} ScrFileHandleBuf;

static void scr_file_handle_buf_grow(ScrFileHandleBuf *b, size_t need) {
  if (need <= b->cap - b->len) return;
  if (need > SIZE_MAX - b->len) scr_trap("scriptc: out of memory\n");
  size_t want = b->len + need;
  size_t cap = b->cap ? b->cap : 64;
  while (cap < want) {
    if (cap > SIZE_MAX / 2) {
      cap = want;
      break;
    }
    cap *= 2;
  }
  char *data = realloc(b->data, cap);
  if (!data) scr_trap("scriptc: out of memory\n");
  b->data = data;
  b->cap = cap;
}

static void scr_file_handle_buf_bytes(ScrFileHandleBuf *b, const char *data,
                                      size_t len) {
  scr_file_handle_buf_grow(b, len);
  memcpy(b->data + b->len, data, len);
  b->len += len;
}

static void scr_file_handle_buf_cstr(ScrFileHandleBuf *b, const char *data) {
  scr_file_handle_buf_bytes(b, data, strlen(data));
}

static void scr_file_handle_buf_char(ScrFileHandleBuf *b, char c) {
  scr_file_handle_buf_bytes(b, &c, 1);
}

static bool scr_file_handle_has_dollar_brace(const ScrStr *value) {
  for (size_t i = 0; i + 1 < value->len; i++) {
    if (value->data[i] == '$' && value->data[i + 1] == '{') return true;
  }
  return false;
}

static char scr_file_handle_inspect_quote(const ScrStr *value) {
  if (!memchr(value->data, '\'', value->len)) return '\'';
  if (!memchr(value->data, '"', value->len)) return '"';
  if (!memchr(value->data, '`', value->len) &&
      !scr_file_handle_has_dollar_brace(value)) {
    return '`';
  }
  return '\'';
}

/* Node's ERR_INVALID_ARG_VALUE renderer runs util.inspect on the value and
 * truncates that rendered text to 128 UTF-16 units before appending "...".
 * FileHandle flags and paths use the static ScrStr representation, so this
 * scalar slice is all this translation unit needs from the optional inspect
 * runtime. */
static ScrStr *scr_file_handle_inspect(const ScrStr *value) {
  ScrFileHandleBuf b = {0};
  char quote = scr_file_handle_inspect_quote(value);
  scr_file_handle_buf_char(&b, quote);
  for (size_t i = 0; i < value->len; i++) {
    unsigned char c = (unsigned char)value->data[i];
    if (c == '\\' || (c == '\'' && quote == '\'')) {
      scr_file_handle_buf_char(&b, '\\');
      scr_file_handle_buf_char(&b, (char)c);
    } else if (c == '\b') {
      scr_file_handle_buf_cstr(&b, "\\b");
    } else if (c == '\t') {
      scr_file_handle_buf_cstr(&b, "\\t");
    } else if (c == '\n') {
      scr_file_handle_buf_cstr(&b, "\\n");
    } else if (c == '\f') {
      scr_file_handle_buf_cstr(&b, "\\f");
    } else if (c == '\r') {
      scr_file_handle_buf_cstr(&b, "\\r");
    } else if (c < 0x20 || c == 0x7f) {
      char escaped[5];
      int len = snprintf(escaped, sizeof escaped, "\\x%02X", c);
      scr_file_handle_buf_bytes(&b, escaped, (size_t)len);
    } else if (c == 0xc2 && i + 1 < value->len &&
               (unsigned char)value->data[i + 1] >= 0x80 &&
               (unsigned char)value->data[i + 1] <= 0x9f) {
      char escaped[5];
      int len = snprintf(escaped, sizeof escaped, "\\x%02X",
                         (unsigned char)value->data[++i]);
      scr_file_handle_buf_bytes(&b, escaped, (size_t)len);
    } else {
      scr_file_handle_buf_char(&b, (char)c);
    }
  }
  scr_file_handle_buf_char(&b, quote);
  ScrStr *full = scr_str_new(b.data ? b.data : "", b.len);
  free(b.data);
  if (scr_str_utf16_len(full) <= 128) return full;
  ScrStr *head = scr_str_slice(full, 0, 128);
  scr_str_release(full);
  ScrFileHandleBuf truncated = {0};
  scr_file_handle_buf_bytes(&truncated, head->data, head->len);
  scr_file_handle_buf_cstr(&truncated, "...");
  scr_str_release(head);
  ScrStr *out = scr_str_new(truncated.data, truncated.len);
  free(truncated.data);
  return out;
}

static void scr_file_handle_arg_value_error(const char *prefix,
                                            const ScrStr *value) {
  ScrStr *inspected = scr_file_handle_inspect(value);
  ScrFileHandleBuf msg = {0};
  scr_file_handle_buf_cstr(&msg, prefix);
  scr_file_handle_buf_bytes(&msg, inspected->data, inspected->len);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg.data, msg.len,
                           "ERR_INVALID_ARG_VALUE");
  free(msg.data);
  scr_str_release(inspected);
}

static bool scr_file_handle_flag_eq(const ScrStr *flags, const char *want) {
  size_t len = strlen(want);
  return flags->len == len && memcmp(flags->data, want, len) == 0;
}

static void scr_file_handle_invalid_flags(const ScrStr *flags) {
  scr_file_handle_arg_value_error(
      "The argument 'flags' is invalid. Received ", flags);
}

static bool scr_file_handle_path_valid(const ScrStr *path) {
  if (!memchr(path->data, 0, path->len)) return true;
  scr_file_handle_arg_value_error(
      "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received ",
      path);
  return false;
}

static int scr_file_handle_open_flags(ScrStr *flags) {
  int of;
  if (scr_file_handle_flag_eq(flags, "r")) of = O_RDONLY;
  else if (scr_file_handle_flag_eq(flags, "rs") || scr_file_handle_flag_eq(flags, "sr")) of = O_RDONLY | O_SYNC;
  else if (scr_file_handle_flag_eq(flags, "r+")) of = O_RDWR;
  else if (scr_file_handle_flag_eq(flags, "rs+") || scr_file_handle_flag_eq(flags, "sr+")) of = O_RDWR | O_SYNC;
  else if (scr_file_handle_flag_eq(flags, "w")) of = O_TRUNC | O_CREAT | O_WRONLY;
  else if (scr_file_handle_flag_eq(flags, "wx") || scr_file_handle_flag_eq(flags, "xw")) of = O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
  else if (scr_file_handle_flag_eq(flags, "w+")) of = O_TRUNC | O_CREAT | O_RDWR;
  else if (scr_file_handle_flag_eq(flags, "wx+") || scr_file_handle_flag_eq(flags, "xw+")) of = O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
  else if (scr_file_handle_flag_eq(flags, "a")) of = O_APPEND | O_CREAT | O_WRONLY;
  else if (scr_file_handle_flag_eq(flags, "ax") || scr_file_handle_flag_eq(flags, "xa")) of = O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
  else if (scr_file_handle_flag_eq(flags, "as") || scr_file_handle_flag_eq(flags, "sa")) of = O_APPEND | O_CREAT | O_WRONLY | O_SYNC;
  else if (scr_file_handle_flag_eq(flags, "a+")) of = O_APPEND | O_CREAT | O_RDWR;
  else if (scr_file_handle_flag_eq(flags, "ax+") || scr_file_handle_flag_eq(flags, "xa+")) of = O_APPEND | O_CREAT | O_RDWR | O_EXCL;
  else if (scr_file_handle_flag_eq(flags, "as+") || scr_file_handle_flag_eq(flags, "sa+")) of = O_APPEND | O_CREAT | O_RDWR | O_SYNC;
  else {
    scr_file_handle_invalid_flags(flags);
    return -1;
  }
  return of;
}

/* Node's stringToFlags for the number arm: validateInt32's ladder, whose
 * received rendering shares scr_num_received with the mode checks. */
static bool scr_file_handle_flags_valid(double flags) {
  char msg[192];
  char recv[48];
  scr_num_received(flags, recv);
  if (!(isfinite(flags) && trunc(flags) == flags)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"flags\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (flags < -2147483648.0 || flags > 2147483647.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"flags\" is out of range. It must be >= -2147483648 && <= 2147483647. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

static bool scr_file_handle_mode_valid(double mode) {
  char msg[160];
  char recv[48];
  scr_num_received(mode, recv);
  if (!(isfinite(mode) && trunc(mode) == mode)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"mode\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (mode < 0 || mode > 4294967295.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"mode\" is out of range. It must be >= 0 && <= 4294967295. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

/* The shared tail of every open(): the creation mode is validated, then the
 * descriptor opens and is wrapped in the shared handle representation. The
 * callers have already validated the path and resolved the flag bits, in
 * Node's path → flags → mode order. */
static ScrFileHandle *scr_file_handle_open_fd(ScrStr *path, int of, double mode) {
  if (!scr_file_handle_mode_valid(mode)) return NULL;
  int fd = open(path->data, of | O_BINARY, (mode_t)mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return NULL;
  }
  ScrFileHandle *h = calloc(1, sizeof(ScrFileHandle));
  if (!h) scr_trap("scriptc: out of memory\n");
  h->rc = 1;
  h->fd = fd;
  h->refs = 1;
  return h;
}

/* parseFileMode's string arm: the value must spell an octal number, which
 * then takes the same uint32 ladder as a numeric mode. */
static bool scr_file_handle_parse_mode(const ScrStr *text, double *mode) {
  bool octal = text->len > 0;
  for (size_t i = 0; i < text->len && octal; i++) {
    unsigned char c = (unsigned char)text->data[i];
    if (c < '0' || c > '7') octal = false;
  }
  if (!octal) {
    scr_file_handle_arg_value_error(
        "The argument 'mode' must be a 32-bit unsigned integer or an octal string. Received ",
        text);
    return false;
  }
  double parsed = 0;
  for (size_t i = 0; i < text->len; i++) parsed = parsed * 8 + (text->data[i] - '0');
  if (!scr_file_handle_mode_valid(parsed)) return false;
  *mode = parsed;
  return true;
}

ScrFileHandle *scr_file_handle_open(ScrStr *path, ScrStr *flags, double mode) {
  scr_file_handle_dyn_install();
  if (!scr_file_handle_path_valid(path)) return NULL;
  int of = scr_file_handle_open_flags(flags);
  if (of < 0) return NULL;
  return scr_file_handle_open_fd(path, of, mode);
}

/* fs.promises.open's general form: Node's stringToFlags and parseFileMode
 * read the argument VALUE, so a flag mask, a flag name, an octal-string
 * mode, and an absent argument all resolve here. The all-static spelling
 * keeps scr_fsp_open; this entry serves the forms whose kind the compiler
 * cannot fold into the signature. */
ScrFileHandle *scr_file_handle_open_options(ScrStr *path, const ScrDyn *flags,
                                            const ScrDyn *mode) {
  scr_file_handle_dyn_install();
  if (!scr_file_handle_path_valid(path)) return NULL;
  int of;
  if (flags->kind == SCR_DYN_UNDEF || flags->kind == SCR_DYN_NULL) {
    of = O_RDONLY;
  } else if (flags->kind == SCR_DYN_NUM) {
    if (!scr_file_handle_flags_valid(flags->v.num)) return NULL;
    of = (int)flags->v.num;
  } else if (flags->kind == SCR_DYN_STR) {
    of = scr_file_handle_open_flags(flags->v.str);
    if (of < 0) return NULL;
  } else {
    char rendered[128];
    const char *text = scr_dyn_inspect_lite(flags, rendered, sizeof rendered);
    char msg[256];
    int len = snprintf(msg, sizeof msg, "The argument 'flags' is invalid. Received %s", text);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  double created;
  if (mode->kind == SCR_DYN_UNDEF || mode->kind == SCR_DYN_NULL) {
    created = 0666;
  } else if (mode->kind == SCR_DYN_NUM) {
    created = mode->v.num;
  } else if (mode->kind == SCR_DYN_STR) {
    if (!scr_file_handle_parse_mode(mode->v.str, &created)) return NULL;
  } else {
    scr_dyn_arg_type_fail("mode", "number", mode);
    return NULL;
  }
  return scr_file_handle_open_fd(path, of, created);
}

ScrFileHandle *scr_file_handle_retain(ScrFileHandle *h) {
  if (h->rc != SIZE_MAX) h->rc++;
  return h;
}

void scr_file_handle_release(ScrFileHandle *h) {
  if (!h || h->rc == SIZE_MAX) return;
  if (--h->rc != 0) return;
  if (h->fd >= 0) (void)close(h->fd);
  while (h->hooks) {
    ScrFileHandleHook *next = h->hooks->next;
    free(h->hooks);
    h->hooks = next;
  }
  if (h->close_wait) scr_promise_release(h->close_wait);
  free(h);
}

void *scr_file_handle_retain_v(void *p) { return scr_file_handle_retain(p); }
void scr_file_handle_release_v(void *p) { scr_file_handle_release(p); }

double scr_file_handle_fd(ScrFileHandle *h) { return (double)h->fd; }

/* fsCall's closed-handle gate: Node's own Error ("file closed", code
 * EBADF) carrying the native call's name as `syscall` and, unlike an
 * ErrnoException, no `errno` at all. */
static bool scr_file_handle_require_open(ScrFileHandle *h, const char *syscall) {
  if (h->fd >= 0) return true;
  static const char msg[] = "file closed";
  ScrStr *text = scr_str_new(msg, sizeof msg - 1);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_code(error, "EBADF");
  error->system_call = scr_str_new(syscall, strlen(syscall));
  scr_throw_obj(error, scr_error_retain_v, scr_error_release_v, scr_error_trace_arg());
  return false;
}

void scr_file_handle_close(ScrFileHandle *h) {
  if (h->fd < 0) return; /* Node's FileHandle.close() is idempotent. */
  int fd = h->fd;
  h->fd = -1;
  scr_fs_close((double)fd);
}

/* FileHandle.close() with Node's reference count: the last reference
 * closes the descriptor; while streams hold the handle the promise waits
 * for them. Either way 'close' runs the streams' close(). */
static ScrPromise *scr_file_handle_close_refs(ScrFileHandle *h, int *detached) {
  if (h->fd < 0) return scr_promise_settled_void();
  if (h->close_wait) return scr_promise_retain(h->close_wait);
  ScrPromise *out;
  if (h->refs > 0) h->refs--;
  if (h->refs == 0) {
    if (detached) {
      *detached = h->fd; /* the stream closes it on the worker pool */
      h->fd = -1;
    } else {
      scr_file_handle_close(h);
      if (scr_exc_pending()) return NULL;
    }
    out = scr_promise_settled_void();
  } else {
    h->close_wait = scr_promise_new();
    out = scr_promise_retain(h->close_wait);
  }
  scr_file_handle_retain(h);
  for (ScrFileHandleHook *k = h->hooks; k && !scr_exc_pending();) {
    ScrFileHandleHook *next = k->next;
    k->fn(k->ctx);
    k = next;
  }
  scr_file_handle_release(h);
  return out;
}

void scr_file_handle_ref(ScrFileHandle *h) { h->refs++; }

/* kUnref then close() for a stream over the handle: answers the
 * descriptor the caller closes, or -1 while other references remain. */
int scr_file_handle_stream_unref(ScrFileHandle *h) {
  if (h->fd < 0) return -1;
  if (h->refs > 0) h->refs--;
  if (h->refs == 0) {
    int fd = h->fd;
    h->fd = -1;
    if (h->close_wait) {
      ScrPromise *w = h->close_wait;
      h->close_wait = NULL;
      scr_promise_fulfill_void(w);
      scr_promise_release(w);
    }
    return fd;
  }
  int fd = -1;
  ScrPromise *p = scr_file_handle_close_refs(h, &fd);
  if (p) scr_promise_release(p);
  return fd;
}

ScrFileHandleHook *scr_file_handle_on_close(ScrFileHandle *h, void (*fn)(void *ctx), void *ctx) {
  ScrFileHandleHook *k = malloc(sizeof *k);
  if (!k) scr_trap("scriptc: out of memory\n");
  k->fn = fn;
  k->ctx = ctx;
  k->next = h->hooks;
  h->hooks = k;
  return k;
}

void scr_file_handle_off_close(ScrFileHandle *h, ScrFileHandleHook *hook) {
  for (ScrFileHandleHook **p = &h->hooks; *p; p = &(*p)->next) {
    if (*p == hook) {
      *p = hook->next;
      free(hook);
      return;
    }
  }
}

double scr_file_handle_read(ScrFileHandle *h, ScrBytes *buf, double offset,
                            double length, double position,
                            bool length_default) {
  if (!scr_file_handle_require_open(h, "read")) return 0;
  if (buf->len == 0) {
    /* FileHandle.read's empty-buffer ladder differs from readSync's generic
     * window check: validate offset intrinsically first, then a zero request
     * succeeds without consulting position/the descriptor; every other
     * request rejects with Node's dedicated invalid-buffer error. Reusing a
     * zero-length read performs exactly that offset-only validation. */
    double checked = scr_fs_read_sync((double)h->fd, buf, offset, 0, position);
    if (scr_exc_pending()) return 0;
    if ((!length_default && length >= 0 && length < 1) ||
        (length_default && offset == 0)) {
      return checked;
    }
    static const char msg[] =
        "The argument 'buffer' is empty and cannot be written. Received <Buffer >";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1,
                             "ERR_INVALID_ARG_VALUE");
    return 0;
  }
  if (length_default && isfinite(offset) && trunc(offset) == offset &&
      offset >= 0 && offset <= (double)buf->len) {
    length = (double)buf->len - offset;
  }
  return scr_fs_read_sync((double)h->fd, buf, offset, length, position);
}

double scr_file_handle_write_bytes(ScrFileHandle *h, ScrBytes *buf,
                                   double offset, double length,
                                   double position, bool length_default) {
  if (!scr_file_handle_require_open(h, "write")) return 0;
  /* Node completes an empty Buffer write before validating offset/length/
   * position or testing whether the descriptor is writable. */
  if (buf->len == 0) return 0;
  if (length_default && isfinite(offset) && trunc(offset) == offset &&
      offset >= 0 && offset <= (double)buf->len) {
    length = (double)buf->len - offset;
  }
  return scr_fs_write_sync((double)h->fd, buf, offset, length, position);
}

double scr_file_handle_write_str(ScrFileHandle *h, ScrStr *data,
                                 double position, ScrStr *encoding) {
  if (!scr_file_handle_require_open(h, "write")) return 0;
  return scr_fs_write_str_sync((double)h->fd, data, position, encoding);
}

/* Node's assertEncoding over a whole-file write's encoding: an empty name,
 * a Buffer encoding name and the literal "buffer" pass; "buffer" is
 * Buffer.from's/toString's unknown encoding, reported when the data is
 * encoded. Any other name is ERR_INVALID_ARG_VALUE. False with the
 * exception pending. */
static bool scr_file_handle_encoding_check(ScrStr *encoding) {
  if (encoding == NULL || encoding->len == 0) return true;
  if (encoding->len == 6 && memcmp(encoding->data, "buffer", 6) == 0) return true;
  if (scr_bytes_is_encoding(encoding)) return true;
  ScrDyn *value = scr_dyn_new_str(encoding);
  scr_dyn_arg_value_fail("encoding", "is invalid encoding", value);
  scr_dyn_release(value);
  return false;
}

/* FileHandle.readFile's encoding ladder: the closed check, assertEncoding,
 * then Buffer's resolution of the name — "buffer" reports
 * ERR_UNKNOWN_ENCODING before the descriptor is read — and the decode. */
ScrStr *scr_file_handle_read_file(ScrFileHandle *h, ScrStr *encoding) {
  if (!scr_file_handle_require_open(h, "readFile")) return NULL;
  if (encoding->len == 0) return scr_fs_read_fd((double)h->fd);
  if (!(encoding->len == 6 && memcmp(encoding->data, "buffer", 6) == 0) &&
      !scr_bytes_is_encoding(encoding)) {
    ScrDyn *value = scr_dyn_new_str(encoding);
    scr_dyn_arg_value_fail("encoding", "is invalid encoding", value);
    scr_dyn_release(value);
    return NULL;
  }
  ScrStr *normalized = scr_bytes_normalize_encoding(encoding);
  if (normalized == NULL) return NULL;
  if (scr_bytes_encoding_is_utf8(normalized)) {
    scr_str_release(normalized);
    return scr_fs_read_fd((double)h->fd);
  }
  ScrBytes *bytes = scr_fs_read_fd_bytes((double)h->fd);
  ScrStr *text = bytes ? scr_bytes_to_str(bytes, normalized) : NULL;
  scr_bytes_release(bytes);
  scr_str_release(normalized);
  return text;
}

ScrBytes *scr_file_handle_read_file_bytes(ScrFileHandle *h) {
  if (!scr_file_handle_require_open(h, "readFile")) return NULL;
  return scr_fs_read_fd_bytes((double)h->fd);
}

static void scr_file_handle_write_all(ScrFileHandle *h, const void *data,
                                      size_t length) {
  if (!scr_file_handle_require_open(h, "writeFile")) return;
  ScrBytes bytes = {.rc = SIZE_MAX, .len = length, .elem = SCR_BYTES_U8, .data = (uint8_t *)data};
  size_t at = 0;
  while (at < length) {
    double count = scr_fs_write_sync((double)h->fd, &bytes, (double)at,
                                     (double)(length - at), -1);
    if (scr_exc_pending()) return;
    if (count <= 0) {
      static const char msg[] = "EIO: i/o error, write";
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "EIO");
      return;
    }
    at += (size_t)count;
  }
}

/* The string payload of FileHandle.writeFile: Buffer.from(data, encoding),
 * with the empty name and utf8 copying the string's own bytes. A "buffer"
 * name reports Buffer.from's ERR_UNKNOWN_ENCODING; the caller ran
 * assertEncoding first, so no other unknown name reaches here. */
static void scr_file_handle_write_string(ScrFileHandle *h, ScrStr *data,
                                         ScrStr *encoding) {
  if (encoding == NULL || encoding->len == 0 || scr_bytes_encoding_is_utf8(encoding)) {
    char *owned;
    const char *bytes = scr_str_utf8(data, &owned);
    scr_file_handle_write_all(h, bytes, data->len);
    scr_str_utf8_end(owned);
    return;
  }
  ScrBytes *bytes = scr_bytes_from_str_checked(data, encoding);
  if (bytes == NULL) return;
  scr_file_handle_write_all(h, (const char *)bytes->data,
                            bytes->len * scr_bytes_elem_size(bytes->elem));
  scr_bytes_release(bytes);
}

void scr_file_handle_write_file(ScrFileHandle *h, ScrStr *data, ScrStr *encoding) {
  scr_file_handle_write_string(h, data, encoding);
}

void scr_file_handle_write_file_bytes(ScrFileHandle *h, ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  scr_file_handle_write_all(h, data->data,
                            data->len * scr_bytes_elem_size(data->elem));
}

/* FileHandle.writeFile over a checked data argument: a string encoded with
 * the requested name, or any Buffer/TypedArray/DataView, whose bytes are
 * written as they are. */
static void scr_file_handle_write_file_data(ScrFileHandle *h, const ScrDyn *data,
                                            ScrStr *encoding) {
  if (data->kind == SCR_DYN_STR) {
    scr_file_handle_write_string(h, data->v.str, encoding);
    return;
  }
  if (data->kind == SCR_DYN_BYTES) {
    scr_file_handle_write_file_bytes(h, data->v.bytes);
    return;
  }
  scr_dyn_arg_type_fail("data", "of type string or an instance of Buffer, TypedArray, or DataView",
                        data);
}

ScrStats *scr_file_handle_stat(ScrFileHandle *h) {
  if (!scr_file_handle_require_open(h, "fstat")) return NULL;
  int err = 0;
  ScrStats *out = scr_stats_of_fd(h->fd, &err);
  if (!out) {
    const char *name = err == EBADF ? "EBADF" : err == EIO ? "EIO" : "EUNKNOWN";
    const char *text = err == EBADF ? "bad file descriptor" :
                       err == EIO ? "i/o error" : strerror(err);
    char msg[256];
    int len = snprintf(msg, sizeof msg, "%s: %s, fstat", name, text);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
    return NULL;
  }
  return out;
}

ScrPromise *scr_fsp_open(ScrStr *path, ScrStr *flags, double mode) {
  ScrFileHandle *h = scr_file_handle_open(path, flags, mode);
  return scr_promise_settled_ref(h, &scr_file_handle_retain_v,
                                 &scr_file_handle_release_v, NULL);
}

ScrPromise *scr_fsp_open_options(ScrStr *path, const ScrDyn *flags, const ScrDyn *mode) {
  ScrFileHandle *h = scr_file_handle_open_options(path, flags, mode);
  return scr_promise_settled_ref(h, &scr_file_handle_retain_v,
                                 &scr_file_handle_release_v, NULL);
}

ScrPromise *scr_file_handle_close_promise(ScrFileHandle *h) {
  ScrPromise *p = scr_file_handle_close_refs(h, NULL);
  return p ? p : scr_promise_settled_void();
}

ScrPromise *scr_file_handle_sync_promise(ScrFileHandle *h) {
  if (scr_file_handle_require_open(h, "fsync")) scr_fs_fsync((double)h->fd);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_datasync_promise(ScrFileHandle *h) {
  if (scr_file_handle_require_open(h, "fdatasync")) scr_fs_fdatasync((double)h->fd);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_truncate_promise(ScrFileHandle *h, double length) {
  if (scr_file_handle_require_open(h, "ftruncate")) scr_fs_ftruncate((double)h->fd, length);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_chmod_promise(ScrFileHandle *h, double mode) {
  if (scr_file_handle_require_open(h, "fchmod") && scr_file_handle_mode_valid(mode))
    scr_fs_fchmod((double)h->fd, mode);
  return scr_promise_settled_void();
}

/* FileHandle.chown(uid, gid): the closed check, then Node's uid/gid range
 * validation, then fchown — all before the promise settles, like chmod. */
ScrPromise *scr_file_handle_chown_promise(ScrFileHandle *h, double uid, double gid) {
  if (scr_file_handle_require_open(h, "fchown")) scr_fs_fchown((double)h->fd, uid, gid);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_utimes_promise(ScrFileHandle *h, const ScrDyn *atime, const ScrDyn *mtime) {
  if (scr_file_handle_require_open(h, "futimes")) {
    double access = scr_fs_timestamp_value(atime, "atime");
    if (!scr_exc_pending()) {
      double modified = scr_fs_timestamp_value(mtime, "mtime");
      if (!scr_exc_pending()) scr_fs_futimes((double)h->fd, access, modified);
    }
  }
  return scr_promise_settled_void();
}

double scr_file_handle_readv(ScrFileHandle *h, ScrArr *buffers, double position) {
  if (!scr_file_handle_require_open(h, "readv")) return 0;
  return scr_fs_readv_sync((double)h->fd, buffers, position);
}

double scr_file_handle_writev(ScrFileHandle *h, ScrArr *buffers, double position) {
  if (!scr_file_handle_require_open(h, "writev")) return 0;
  return scr_fs_writev_sync((double)h->fd, buffers, position);
}

ScrPromise *scr_file_handle_read_file_promise(ScrFileHandle *h,
                                              ScrStr *encoding) {
  return scr_promise_settled_str(scr_file_handle_read_file(h, encoding));
}

ScrPromise *scr_file_handle_read_file_bytes_promise(ScrFileHandle *h,
                                                    ScrStr *encoding) {
  (void)encoding; /* evaluates the explicit undefined/null default in order */
  ScrBytes *data = scr_file_handle_read_file_bytes(h);
  return scr_promise_settled_ref(data, &scr_bytes_retain_v,
                                 &scr_bytes_release_v, NULL);
}

/* The closed handle reports first (Node's FileHandle members all check it
 * before validating arguments), then the encoding, then the write. */
ScrPromise *scr_file_handle_write_file_promise(ScrFileHandle *h,
                                               ScrStr *data,
                                               ScrStr *encoding) {
  if (!scr_file_handle_require_open(h, "writeFile")) return scr_promise_settled_void();
  if (scr_file_handle_encoding_check(encoding)) scr_file_handle_write_file(h, data, encoding);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_write_file_bytes_promise(ScrFileHandle *h,
                                                     ScrBytes *data,
                                                     ScrStr *encoding) {
  if (!scr_file_handle_require_open(h, "writeFile")) return scr_promise_settled_void();
  /* The encoding is validated even though byte data is written as it is. */
  if (scr_file_handle_encoding_check(encoding)) scr_file_handle_write_file_bytes(h, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_write_file_data_promise(ScrFileHandle *h,
                                                    const ScrDyn *data,
                                                    ScrStr *encoding) {
  if (!scr_file_handle_require_open(h, "writeFile")) return scr_promise_settled_void();
  if (scr_file_handle_encoding_check(encoding)) scr_file_handle_write_file_data(h, data, encoding);
  return scr_promise_settled_void();
}

/* ── FileHandle.writeFile/appendFile over Node's options record ─────────
 *
 * FileHandle.writeFile and appendFile both route through fs/promises'
 * writeFile, so the record runs Node's whole ladder: getOptions (the type,
 * then the encoding, then the signal's type), the flush boolean, the data's
 * type, Buffer.from's encode of a string, then checkAborted — and only then
 * the write. appendFile differs only in the flag its own path form would
 * open with, which a descriptor has already settled. */

typedef struct {
  const ScrDyn *record; /* borrowed; flush is read from it in the data's step */
  ScrStr *encoding;     /* +1; the raw name ("buffer" included); NULL for utf8 */
  ScrDyn *signal;       /* +1; NULL when absent or undefined */
} ScrFileHandleWriteOptions;

static void scr_file_handle_write_options_clear(ScrFileHandleWriteOptions *o) {
  scr_str_release(o->encoding);
  scr_dyn_release(o->signal);
}

/* getOptions' own gate: a string is the encoding-only spelling, a function
 * means the defaults, and any other primitive is ERR_INVALID_ARG_TYPE. */
static bool scr_file_handle_write_options_type_ok(const ScrDyn *options) {
  switch (options->kind) {
    case SCR_DYN_NUM:
    case SCR_DYN_BOOL:
    case SCR_DYN_BIGINT:
    case SCR_DYN_SYMBOL:
      scr_dyn_arg_type_fail("options", "one of type string or object", options);
      return false;
    default:
      return true;
  }
}

static bool scr_file_handle_write_options_read(const ScrDyn *options,
                                               ScrFileHandleWriteOptions *o) {
  memset(o, 0, sizeof *o);
  o->record = options;
  if (!scr_file_handle_write_options_type_ok(options)) return false;
  /* getOptions' encoding: the string spelling is the encoding alone, and
   * assertEncoding runs unless the record names "buffer". A "buffer" name
   * stays in the raw form so Buffer.from reports it for string data. */
  ScrDyn *value = options->kind == SCR_DYN_STR ? scr_dyn_retain((ScrDyn *)options)
                                               : scr_fs_option_get(options, "encoding");
  if (value == NULL) return false;
  bool ok = true;
  if (value->kind == SCR_DYN_STR) {
    if (value->v.str->len > 0) {
      if (!scr_file_handle_encoding_check(value->v.str)) ok = false;
      else o->encoding = scr_str_retain(value->v.str);
    }
  } else if (scr_dyn_truthy(value)) {
    /* assertEncoding: only falsy non-strings pass unvalidated. */
    scr_dyn_arg_value_fail("encoding", "is invalid encoding", value);
    ok = false;
  }
  scr_dyn_release(value);
  if (!ok) return false;
  /* getOptions validates the signal's type when it is not undefined;
   * checkAborted reads `aborted` later, after the data. */
  ScrDyn *signal = scr_fs_option_get(options, "signal");
  if (signal == NULL) return false;
  if (signal->kind != SCR_DYN_UNDEF) {
    if (signal->kind != SCR_DYN_HANDLE || signal->v.handle.tag != SCR_DYNH_ABORT_SIGNAL) {
      scr_dyn_arg_type_fail("options.signal", "an instance of AbortSignal", signal);
      scr_dyn_release(signal);
      return false;
    }
    o->signal = signal;
  } else {
    scr_dyn_release(signal);
  }
  return true;
}

/* `options.flush ?? false` through validateBoolean: null and undefined are
 * the false default, every other non-boolean throws. A handle's writeFile
 * never syncs, but Node validates the option before it reads the data. */
static bool scr_file_handle_write_options_flush(const ScrFileHandleWriteOptions *o) {
  ScrDyn *flush = scr_fs_option_get(o->record, "flush");
  if (flush == NULL) return false;
  bool ok = true;
  if (flush->kind != SCR_DYN_NULL && flush->kind != SCR_DYN_UNDEF &&
      flush->kind != SCR_DYN_BOOL) {
    scr_dyn_prop_type_fail("options.flush", "of type boolean", flush);
    ok = false;
  }
  scr_dyn_release(flush);
  return ok;
}

/* checkAborted: an aborted signal rejects with Node's AbortError (the
 * signal's reason as `cause`) before the first byte is written. */
static bool scr_file_handle_check_aborted(const ScrDyn *signal) {
  if (signal == NULL) return false;
  ScrStr *key = scr_str_new("aborted", 7);
  ScrDyn *aborted = scr_dyn_handle_key_get(signal, key);
  scr_str_release(key);
  bool cancelled = aborted && scr_dyn_truthy(aborted);
  scr_dyn_release(aborted);
  if (!cancelled) return false;
  ScrStr *reason_key = scr_str_new("reason", 6);
  ScrDyn *reason = scr_dyn_handle_key_get(signal, reason_key);
  scr_str_release(reason_key);
  ScrError *error = scr_error_abort(reason);
  scr_dyn_release(reason);
  scr_throw_obj(error, scr_error_retain_v, scr_error_release_v, scr_error_trace_arg());
  return true;
}

/* The data of the options form: exactly one of the three spellings. */
typedef struct {
  ScrStr *str;           /* borrowed */
  const ScrBytes *bytes; /* borrowed */
  const ScrDyn *dyn;     /* borrowed; the checked-data spelling */
} ScrFileHandleWritePayload;

/* Node's steps after getOptions: the flush option, the data's type,
 * Buffer.from's encode of a string, then checkAborted — and only then the
 * writes. A handle's writeFile ignores the flag and mode it never opens
 * with, and writes at the descriptor's current offset. */
static void scr_file_handle_write_options_run(ScrFileHandle *h,
                                              const ScrFileHandleWritePayload *payload,
                                              const ScrFileHandleWriteOptions *o) {
  if (!scr_file_handle_write_options_flush(o)) return;
  ScrStr *text = payload->str;
  const ScrBytes *view = payload->bytes;
  if (text == NULL && view == NULL) {
    if (payload->dyn->kind == SCR_DYN_STR) {
      text = payload->dyn->v.str;
    } else if (payload->dyn->kind == SCR_DYN_BYTES) {
      view = payload->dyn->v.bytes;
    } else {
      scr_dyn_arg_type_fail("data",
                            "of type string or an instance of Buffer, TypedArray, or DataView",
                            payload->dyn);
      return;
    }
  }
  /* The snapshot of a shared view outlives this function's block. */
  SCR_BYTES_SNAPSHOT(view);
  char *owned = NULL;
  ScrBytes *encoded = NULL;
  const void *bytes = NULL;
  size_t len = 0;
  if (text != NULL) {
    if (o->encoding == NULL || o->encoding->len == 0 ||
        scr_bytes_encoding_is_utf8(o->encoding)) {
      bytes = scr_str_utf8(text, &owned);
      len = text->len;
    } else {
      /* "buffer" reaches Buffer.from's ERR_UNKNOWN_ENCODING here, after the
       * flush option was validated. */
      encoded = scr_bytes_from_str_checked(text, o->encoding);
      if (encoded != NULL) {
        bytes = encoded->data;
        len = encoded->len * scr_bytes_elem_size(encoded->elem);
      }
    }
  } else {
    bytes = view->data;
    len = view->len * scr_bytes_elem_size(view->elem);
  }
  if (bytes != NULL && !scr_file_handle_check_aborted(o->signal))
    scr_file_handle_write_all(h, bytes, len);
  scr_str_utf8_end(owned);
  scr_bytes_release(encoded);
}

/* One options write: the closed check, the record's ladder, then the data. */
static ScrPromise *scr_file_handle_write_options_promise(ScrFileHandle *h,
                                                         const ScrFileHandleWritePayload *payload,
                                                         const ScrDyn *options) {
  if (!scr_file_handle_require_open(h, "writeFile")) return scr_promise_settled_void();
  ScrFileHandleWriteOptions o;
  if (scr_file_handle_write_options_read(options, &o))
    scr_file_handle_write_options_run(h, payload, &o);
  scr_file_handle_write_options_clear(&o);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_write_file_options_promise(ScrFileHandle *h,
                                                       ScrStr *data,
                                                       const ScrDyn *options) {
  const ScrFileHandleWritePayload payload = {.str = data};
  return scr_file_handle_write_options_promise(h, &payload, options);
}

ScrPromise *scr_file_handle_write_file_options_bytes_promise(ScrFileHandle *h,
                                                             ScrBytes *data,
                                                             const ScrDyn *options) {
  const ScrFileHandleWritePayload payload = {.bytes = data};
  return scr_file_handle_write_options_promise(h, &payload, options);
}

ScrPromise *scr_file_handle_write_file_options_data_promise(ScrFileHandle *h,
                                                            const ScrDyn *data,
                                                            const ScrDyn *options) {
  const ScrFileHandleWritePayload payload = {.dyn = data};
  return scr_file_handle_write_options_promise(h, &payload, options);
}

ScrPromise *scr_file_handle_stat_promise(ScrFileHandle *h) {
  ScrStats *st = scr_file_handle_stat(h);
  return scr_promise_settled_ref(st, &scr_stats_retain_v,
                                 &scr_stats_release_v, NULL);
}

/* The checked boundary retains the shared descriptor slot. Statically
 * typed uses unwrap it before invoking the existing FileHandle surface. */
static ScrDyn *scr_file_handle_dyn_invoke(
    void *h, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  (void)what;
  if (strcmp(method, "close") == 0) {
    ScrPromise *closing = scr_file_handle_close_refs(h, NULL);
    if (closing == NULL) return NULL;
    ScrPromise *p = scr_promise_settled_ref(
        scr_dyn_retain(scr_dyn_undefined()), &scr_dyn_retain_v,
        &scr_dyn_release_v, NULL);
    scr_promise_release(closing);
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  static const char msg[] =
      "FileHandle method calls through an 'unknown' value are not supported yet — narrow the value to FileHandle first";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
  return NULL;
}

static ScrDyn *scr_file_handle_dyn_get(void *h, const char *key, size_t len) {
  if (len == 2 && memcmp(key, "fd", 2) == 0) {
    return scr_dyn_new_num(scr_file_handle_fd(h));
  }
  return NULL;
}

static bool scr_file_handle_dyn_set(
    void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

void scr_file_handle_dyn_install(void) {
  static const ScrDynHandleOps ops = {
    "FileHandle", &scr_file_handle_retain_v, &scr_file_handle_release_v,
    &scr_file_handle_dyn_invoke, &scr_file_handle_dyn_get,
    &scr_file_handle_dyn_set, NULL,
  };
  scr_dyn_handle_install(SCR_DYNH_FILE_HANDLE, &ops);
}
