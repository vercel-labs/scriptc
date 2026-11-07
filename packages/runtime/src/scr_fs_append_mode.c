/* appendFileSync with a creation mode.
 *
 * A separate runtime unit, selected only by programs that pass `mode` to
 * appendFileSync, so every other executable keeps byte-identical code from
 * scr_lib.c: adding the function there changes that unit's `.eh_frame`
 * contribution, which the linker carries into every program that links it.
 *
 * The `mode` option is open(2)'s O_CREAT argument: it applies to a file the
 * append creates, and Node never chmods an existing file here. The error
 * shapes match the plain append in scr_lib.c.
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
static bool scr_fs_append_mode_ok(double mode) {
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

/* appendFileSync(p, data, { mode }): Node opens "a" with the mode as
 * O_CREAT's argument, so the mode applies at CREATION only and an existing
 * file keeps its permissions. */
void scr_fs_append_file_mode(ScrStr *path, ScrStr *data, double mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  if (!scr_fs_append_mode_ok(mode)) return;
  int fd = open(path->data, O_WRONLY | O_CREAT | O_BINARY | O_APPEND, (mode_t)mode);
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
