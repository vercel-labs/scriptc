/* The BYTE-data spellings of writeFile and writeFileSync: the options
 * record's creation mode and disposition flag over a Uint8Array/Buffer
 * payload, beside the string forms in scr_fs_flags.c, and
 * fs.promises.writeFile(path, bytes) without options.
 *
 * These live in a unit of their own rather than in scr_fs_flags.c or the
 * core scr_bytes_io.c so a program that writes no byte payload keeps both
 * objects byte for byte: the gated unit is linked only by programs that
 * reach one of these forms (fsBytesWrites). */
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

#ifndef O_BINARY
#define O_BINARY 0
#endif

/* Node's mode validation for the options-record write: an integer in
 * open(2)'s mode_t range. Throws ERR_OUT_OF_RANGE and answers false. The
 * static copy in scr_fs_flags.c stays there because that unit's own flag
 * writes answer the same validation; sharing one global would put a symbol
 * into the object every flag-writing program links. */
static bool scr_fs_bytes_write_mode_ok(double mode) {
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

/* The open(2) write over byte data: O_TRUNC plus `extra` (only O_EXCL
 * today), creation mode applying at CREATION only. Same error shapes as the
 * string form in scr_fs_flags.c. */
static void scr_fs_write_file_open_bytes(ScrStr *path, const ScrBytes *data, mode_t mode,
                                         int extra) {
  if (!scr_fs_path_ok(path, "path")) return;
  SCR_BYTES_SNAPSHOT(data);
  int fd = open(path->data, O_WRONLY | O_CREAT | O_TRUNC | O_BINARY | extra, mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  size_t len = data->len * scr_bytes_elem_size(data->elem);
  const char *bytes = (const char *)data->data;
  size_t at = 0;
  while (at < len) {
    ssize_t wrote = write(fd, bytes + at, len - at);
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

/* writeFileSync(p, bytes, { mode, flag }): the byte-data spelling of the
 * options write, with the same mode validation and flag semantics. */
void scr_fs_write_file_flags_bytes(ScrStr *path, const ScrBytes *data, double mode,
                                   double exclusive) {
  if (!scr_fs_bytes_write_mode_ok(mode)) return;
  scr_fs_write_file_open_bytes(path, data, (mode_t)mode, exclusive != 0 ? O_EXCL : 0);
}

/* fs.promises.writeFile(path, bytes, { mode, flag }): the settled-promise
 * twin of fs.writeFileSyncBytesFlags. */
ScrPromise *scr_fsp_write_file_flags_bytes(ScrStr *path, ScrBytes *data, double mode,
                                           double exclusive) {
  scr_fs_write_file_flags_bytes(path, data, mode, exclusive);
  return scr_promise_settled_void();
}

/* fs.promises.writeFile(path, bytes): the TRUNCATING write, unlike its
 * appendFile twin (the two-argument string forms differ the same way). */
ScrPromise *scr_fsp_write_file_bytes(ScrStr *path, ScrBytes *data) {
  scr_fs_write_file_bytes(path, data);
  return scr_promise_settled_void();
}
