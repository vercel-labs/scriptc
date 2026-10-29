/* fs writes that pass an options record, and the fs/promises bytes write.
 *
 * A separate runtime unit, selected only by programs that call one of its
 * entries (writeFile/writeFileSync with `mode` or `flag`, appendFileSync
 * with `mode`, writeFile over Uint8Array data), so every other executable
 * keeps byte-identical code from scr_lib.c, scr_bytes_io.c and scr_async.c:
 * adding these functions there changes those units' `.eh_frame`
 * contribution, which the linker carries into every program that links
 * them.
 *
 * The `mode` option is open(2)'s O_CREAT argument — Node never chmods an
 * existing file here — and `flag: "wx"` is O_EXCL, so a path that already
 * exists fails with EEXIST instead of being truncated. Error shapes match
 * the plain forms in scr_lib.c/scr_bytes_io.c.
 */
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <unistd.h>

#ifndef O_BINARY
#define O_BINARY 0 /* POSIX: no text mode; Windows CRT keeps fd writes untranslated. */
#endif

/* Node's own range check on a `mode` number: a non-integer or an
 * out-of-range value throws before any syscall. */
static bool scr_fs_write_mode_ok(double mode) {
  char recv[48], msg[176];
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

/* A string write opened with an explicit creation mode: the mode applies
 * at CREATION only, and an existing file keeps its permissions. `append` is
 * Node's "a" disposition (write at the end) and `exclusive` its "wx". */
static void scr_fs_write_text_disposition(ScrStr *path, ScrStr *data, double mode, bool append,
                                          bool exclusive) {
  if (!scr_fs_path_ok(path, "path")) return;
  if (!scr_fs_write_mode_ok(mode)) return;
  int flags = O_WRONLY | O_CREAT | O_BINARY | (append ? O_APPEND : O_TRUNC);
  if (exclusive) flags |= O_EXCL;
  int fd = open(path->data, flags, (mode_t)mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  size_t at = 0;
  while (at < data->len) {
    ssize_t wrote = write(fd, bytes + at, data->len - at);
    if (wrote < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      close(fd);
      scr_str_utf8_end(owned);
      scr_fs_throw(e, "write", path);
      return;
    }
    at += (size_t)wrote;
  }
  scr_str_utf8_end(owned);
  if (close(fd) != 0) scr_fs_throw(errno, "close", path);
}

/* writeFileSync/writeFile with `flag: "w" | "wx"`: the exclusive form is
 * open(2)'s O_EXCL. */
void scr_fs_write_file_text_flags(ScrStr *path, ScrStr *data, double mode, double exclusive) {
  scr_fs_write_text_disposition(path, data, mode, false, exclusive != 0);
}

/* appendFileSync(p, data, { mode }): Node opens "a" with the mode as
 * O_CREAT's argument. */
void scr_fs_append_file_mode(ScrStr *path, ScrStr *data, double mode) {
  scr_fs_write_text_disposition(path, data, mode, true, false);
}

/* writeFile(p, bytes, { mode, flag: "w" | "wx" }): the bytes twin of
 * scr_fs_write_file_text_flags. */
void scr_fs_write_file_bytes_flags(ScrStr *path, const ScrBytes *data, double mode,
                                   double exclusive) {
  if (!scr_fs_path_ok(path, "path")) return;
  if (!scr_fs_write_mode_ok(mode)) return;
  SCR_BYTES_SNAPSHOT(data);
  int flags = O_WRONLY | O_CREAT | O_TRUNC | O_BINARY;
  if (exclusive != 0) flags |= O_EXCL;
  int fd = open(path->data, flags, (mode_t)mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  size_t n = data->len * scr_bytes_elem_size(data->elem);
  const char *bytes = data->data;
  size_t at = 0;
  while (at < n) {
    ssize_t wrote = write(fd, bytes + at, n - at);
    if (wrote < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      close(fd);
      scr_fs_throw(e, "write", path);
      return;
    }
    at += (size_t)wrote;
  }
  if (close(fd) != 0) scr_fs_throw(errno, "close", path);
}

/* fs/promises writeFile over string or Uint8Array data: the sync write
 * above THROWS into the promise boundary, which rejects at the await,
 * exactly Node — the same already-settled-promise shape as scr_async.c's
 * other fs/promises entries. The plain two-argument bytes form lowers with
 * Node's default creation mode and no exclusive flag. */
ScrPromise *scr_fsp_write_file_text_flags(ScrStr *path, ScrStr *data, double mode,
                                          double exclusive) {
  scr_fs_write_file_text_flags(path, data, mode, exclusive);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_write_file_bytes_flags(ScrStr *path, ScrBytes *data, double mode,
                                           double exclusive) {
  scr_fs_write_file_bytes_flags(path, data, mode, exclusive);
  return scr_promise_settled_void();
}
