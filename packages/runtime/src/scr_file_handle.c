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
};

/* ScrStats is opaque at the public runtime boundary. FileHandle's fstat
 * snapshot completes the same layout privately in this translation unit. */
struct ScrStats {
  size_t rc;
  bool is_file;
  bool is_dir;
  bool is_symlink;
  double size;
  double blocks;
  double nlink;
  double atime_ms;
  double mtime_ms;
};

#ifdef _WIN32
/* Keep the FILETIME conversion byte-for-byte with scr_lib.c's path-stat arm:
 * libuv splits the 100ns count into Unix seconds and nanoseconds before Node
 * combines it into the public millisecond value. */
static double scr_file_handle_filetime_ms(FILETIME ft) {
  ULARGE_INTEGER raw;
  raw.LowPart = ft.dwLowDateTime;
  raw.HighPart = ft.dwHighDateTime;
  int64_t ticks = (int64_t)raw.QuadPart - INT64_C(116444736000000000);
  int64_t sec = ticks / INT64_C(10000000);
  int64_t rem = ticks % INT64_C(10000000);
  if (rem < 0) {
    sec--;
    rem += INT64_C(10000000);
  }
  return (double)sec * 1000.0 + (double)rem / 10000.0;
}
#endif

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

ScrFileHandle *scr_file_handle_open(ScrStr *path, ScrStr *flags, double mode) {
  if (!scr_file_handle_path_valid(path)) return NULL;
  int of = scr_file_handle_open_flags(flags);
  if (of < 0) return NULL;
  if (!scr_file_handle_mode_valid(mode)) return NULL;
  int fd = open(path->data, of | O_BINARY, (mode_t)mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return NULL;
  }
  ScrFileHandle *h = malloc(sizeof(ScrFileHandle));
  if (!h) scr_trap("scriptc: out of memory\n");
  h->rc = 1;
  h->fd = fd;
  return h;
}

ScrFileHandle *scr_file_handle_retain(ScrFileHandle *h) {
  if (h->rc != SIZE_MAX) h->rc++;
  return h;
}

void scr_file_handle_release(ScrFileHandle *h) {
  if (!h || h->rc == SIZE_MAX) return;
  if (--h->rc != 0) return;
  if (h->fd >= 0) (void)close(h->fd);
  free(h);
}

void *scr_file_handle_retain_v(void *p) { return scr_file_handle_retain(p); }
void scr_file_handle_release_v(void *p) { scr_file_handle_release(p); }

double scr_file_handle_fd(ScrFileHandle *h) { return (double)h->fd; }

static bool scr_file_handle_require_open(ScrFileHandle *h) {
  if (h->fd >= 0) return true;
  static const char msg[] = "file closed";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "EBADF");
  return false;
}

void scr_file_handle_close(ScrFileHandle *h) {
  if (h->fd < 0) return; /* Node's FileHandle.close() is idempotent. */
  int fd = h->fd;
  h->fd = -1;
  scr_fs_close((double)fd);
}

double scr_file_handle_read(ScrFileHandle *h, ScrBytes *buf, double offset,
                            double length, double position,
                            bool length_default) {
  if (!scr_file_handle_require_open(h)) return 0;
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
  if (!scr_file_handle_require_open(h)) return 0;
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
  if (!scr_file_handle_require_open(h)) return 0;
  return scr_fs_write_str_sync((double)h->fd, data, position, encoding);
}

ScrStr *scr_file_handle_read_file(ScrFileHandle *h) {
  if (!scr_file_handle_require_open(h)) return NULL;
  return scr_fs_read_fd((double)h->fd);
}

ScrBytes *scr_file_handle_read_file_bytes(ScrFileHandle *h) {
  if (!scr_file_handle_require_open(h)) return NULL;
  return scr_fs_read_fd_bytes((double)h->fd);
}

static void scr_file_handle_write_all(ScrFileHandle *h, const void *data,
                                      size_t length) {
  if (!scr_file_handle_require_open(h)) return;
  ScrBytes bytes = {SIZE_MAX, length, SCR_BYTES_U8, (uint8_t *)data, NULL};
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

void scr_file_handle_write_file(ScrFileHandle *h, ScrStr *data) {
  scr_file_handle_write_all(h, data->data, data->len);
}

void scr_file_handle_write_file_bytes(ScrFileHandle *h, ScrBytes *data) {
  scr_file_handle_write_all(h, data->data,
                            data->len * scr_bytes_elem_size(data->elem));
}

ScrStats *scr_file_handle_stat(ScrFileHandle *h) {
  if (!scr_file_handle_require_open(h)) return NULL;
  struct stat st;
  if (fstat(h->fd, &st) != 0) {
    int err = errno;
    const char *name = err == EBADF ? "EBADF" : err == EIO ? "EIO" : "EUNKNOWN";
    const char *text = err == EBADF ? "bad file descriptor" :
                       err == EIO ? "i/o error" : strerror(err);
    char msg[256];
    int len = snprintf(msg, sizeof msg, "%s: %s, fstat", name, text);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
    return NULL;
  }
  ScrStats *out = malloc(sizeof(ScrStats));
  if (!out) scr_trap("scriptc: out of memory\n");
  out->rc = 1;
  out->is_file = S_ISREG(st.st_mode);
  out->is_dir = S_ISDIR(st.st_mode);
  out->is_symlink = false; /* fstat follows the open descriptor. */
  out->size = (double)st.st_size;
#if defined(_WIN32)
  out->blocks = st.st_size <= 0 ? 0.0 : (double)(((uint64_t)st.st_size + 511) >> 9);
  out->nlink = (double)st.st_nlink;
  out->atime_ms = (double)st.st_atime * 1000.0;
  out->mtime_ms = (double)st.st_mtime * 1000.0;
  HANDLE os_handle = (HANDLE)_get_osfhandle(h->fd);
  if (os_handle != INVALID_HANDLE_VALUE) {
    BY_HANDLE_FILE_INFORMATION basic;
    if (GetFileInformationByHandle(os_handle, &basic)) {
      out->nlink = (double)basic.nNumberOfLinks;
      out->atime_ms = scr_file_handle_filetime_ms(basic.ftLastAccessTime);
      out->mtime_ms = scr_file_handle_filetime_ms(basic.ftLastWriteTime);
    }
    FILE_STANDARD_INFO standard;
    if (GetFileInformationByHandleEx(
          os_handle, FileStandardInfo, &standard, sizeof standard)) {
      out->blocks = (double)((uint64_t)standard.AllocationSize.QuadPart >> 9);
      out->nlink = (double)standard.NumberOfLinks;
    }
  }
#elif defined(__APPLE__)
  out->blocks = (double)st.st_blocks;
  out->nlink = (double)st.st_nlink;
  out->atime_ms = (double)st.st_atimespec.tv_sec * 1000.0 +
                  (double)st.st_atimespec.tv_nsec / 1e6;
  out->mtime_ms = (double)st.st_mtimespec.tv_sec * 1000.0 +
                  (double)st.st_mtimespec.tv_nsec / 1e6;
#else
  out->blocks = (double)st.st_blocks;
  out->nlink = (double)st.st_nlink;
  out->atime_ms = (double)st.st_atim.tv_sec * 1000.0 +
                  (double)st.st_atim.tv_nsec / 1e6;
  out->mtime_ms = (double)st.st_mtim.tv_sec * 1000.0 +
                  (double)st.st_mtim.tv_nsec / 1e6;
#endif
  return out;
}

ScrPromise *scr_fsp_open(ScrStr *path, ScrStr *flags, double mode) {
  ScrFileHandle *h = scr_file_handle_open(path, flags, mode);
  return scr_promise_settled_ref(h, &scr_file_handle_retain_v,
                                 &scr_file_handle_release_v, NULL);
}

ScrPromise *scr_file_handle_close_promise(ScrFileHandle *h) {
  scr_file_handle_close(h);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_read_file_promise(ScrFileHandle *h,
                                              ScrStr *encoding) {
  (void)encoding;
  return scr_promise_settled_str(scr_file_handle_read_file(h));
}

ScrPromise *scr_file_handle_read_file_bytes_promise(ScrFileHandle *h,
                                                    ScrStr *encoding) {
  (void)encoding; /* evaluates the explicit undefined/null default in order */
  ScrBytes *data = scr_file_handle_read_file_bytes(h);
  return scr_promise_settled_ref(data, &scr_bytes_retain_v,
                                 &scr_bytes_release_v, NULL);
}

ScrPromise *scr_file_handle_write_file_promise(ScrFileHandle *h,
                                               ScrStr *data,
                                               ScrStr *encoding) {
  (void)encoding; /* frontend admits utf8 only; evaluation is observable */
  scr_file_handle_write_file(h, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_write_file_bytes_promise(ScrFileHandle *h,
                                                     ScrBytes *data,
                                                     ScrStr *encoding) {
  (void)encoding;
  scr_file_handle_write_file_bytes(h, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_file_handle_stat_promise(ScrFileHandle *h) {
  ScrStats *st = scr_file_handle_stat(h);
  return scr_promise_settled_ref(st, &scr_stats_retain_v,
                                 &scr_stats_release_v, NULL);
}
