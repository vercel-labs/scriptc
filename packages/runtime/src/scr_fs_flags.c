/* fs.writeFile's `flag` option ("w", "wx") and the fs/promises twins of the
 * flag-aware write and copy forms.
 *
 * The write is scr_lib.c's scr_fs_write_file_mode body with the disposition
 * flag added (the same portable open(2) calls, so it builds for every
 * target). It lives in this unit rather than beside that function so a
 * program that never passes `flag` keeps scr_lib.c's object byte for byte;
 * the fs.copyFile mode form rides scr_fs_cp.c's SCR_FS_FLAGS build, whose
 * reflink helper it reuses, and that form's Windows arm sits beside the
 * Win32 path helpers in scr_lib.c. */
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

/* O_BINARY: Windows-only (CRT text mode would translate \n on fd writes);
 * zero everywhere else. scr_lib.c carries the same guard for its writes. */
#ifndef O_BINARY
#define O_BINARY 0
#endif

/* Node's mode validation for the options-record write: an integer in
 * open(2)'s mode_t range. Throws ERR_OUT_OF_RANGE and answers false. */
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

/* The open(2) write behind the flag form: O_TRUNC plus `extra` (only O_EXCL
 * today), creation mode applying at CREATION only (umask applying) — an
 * existing file keeps its permissions, exactly Node (which never chmods
 * here). Same error shapes as the plain form. */
static void scr_fs_write_file_open(ScrStr *path, ScrStr *data, mode_t mode, int extra) {
  if (!scr_fs_path_ok(path, "path")) return;
  /* O_BINARY: zero on POSIX; on Windows it keeps the CRT from translating
   * \n in these byte-exact writes (fopen's "wb" path already does). */
  int fd = open(path->data, O_WRONLY | O_CREAT | O_TRUNC | O_BINARY | extra, mode);
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

/* The same open(2) write over BYTE data (Uint8Array/Buffer): writeFileSync
 * and fs.promises.writeFile accept the same options record with either data
 * kind, and a Buffer writes exactly its bytes. The string form's loop is
 * left untouched so programs that only write strings keep its object. */
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
  if (!scr_fs_write_mode_ok(mode)) return;
  scr_fs_write_file_open_bytes(path, data, (mode_t)mode, exclusive != 0 ? O_EXCL : 0);
}

/* fs.promises.writeFile(path, bytes, { mode, flag }): the settled-promise
 * twin of fs.writeFileSyncBytesFlags. */
ScrPromise *scr_fsp_write_file_flags_bytes(ScrStr *path, ScrBytes *data, double mode,
                                           double exclusive) {
  scr_fs_write_file_flags_bytes(path, data, mode, exclusive);
  return scr_promise_settled_void();
}

/* writeFileSync(p, data, { mode, flag }): Node's open(2) with the
 * disposition flag. `exclusive` is "wx" (O_EXCL: EEXIST when the path
 * exists); 0 is "w", the default truncate-or-create. */
void scr_fs_write_file_flags(ScrStr *path, ScrStr *data, double mode, double exclusive) {
  if (!scr_fs_write_mode_ok(mode)) return;
  scr_fs_write_file_open(path, data, (mode_t)mode, exclusive != 0 ? O_EXCL : 0);
}

/* fs.promises.writeFile(path, data, { mode, flag }) and
 * fs.promises.copyFile(src, dest, mode): the settled-promise twins of
 * fs.writeFileFlagsSync and fs.copyFileFlagsSync. */
ScrPromise *scr_fsp_write_file_flags(ScrStr *path, ScrStr *data, double mode, double exclusive) {
  scr_fs_write_file_flags(path, data, mode, exclusive);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_copyfile_flags(ScrStr *src, ScrStr *dest, double mode) {
  scr_fs_copyfile_flags(src, dest, mode);
  return scr_promise_settled_void();
}
