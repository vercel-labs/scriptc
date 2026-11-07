/* fs.writeFile's write options (encoding, mode, flag) and the fs/promises
 * twins of the flag-aware write and copy forms.
 *
 * The write is scr_lib.c's scr_fs_write_file_mode body with the encoded data
 * and the disposition flag added (the same portable open(2) calls, so it
 * builds for every target). It lives in this unit rather than beside that
 * function so a program that never passes options keeps scr_lib.c's object
 * unchanged; the fs.copyFile mode form rides scr_fs_cp.c's SCR_FS_FLAGS
 * build, whose reflink helper it reuses, and that form's Windows arm sits
 * beside the Win32 path helpers in scr_lib.c. */
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
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

/* O_SYNC: Windows CRT opens have no separate synchronous flag, so the
 * "s" flags there are plain opens, as they are for Node's own reads. */
#ifndef O_SYNC
#define O_SYNC 0
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

/* writeFileSync(p, data, { mode, flag }): Node's open(2) with the
 * disposition flag. `exclusive` is "wx" (O_EXCL: EEXIST when the path
 * exists); 0 is "w", the default truncate-or-create. */
void scr_fs_write_file_flags(ScrStr *path, ScrStr *data, double mode, double exclusive) {
  if (!scr_fs_write_mode_ok(mode)) return;
  scr_fs_write_file_open(path, data, (mode_t)mode, exclusive != 0 ? O_EXCL : 0);
}

/* One flag-name comparison: the whole name must match, so a name with an
 * embedded NUL ("w\0invalid") is unknown instead of reading as the prefix
 * "w" and truncating the target the way Node refuses to. */
static bool scr_fs_write_flag_is(const char *s, size_t len, const char *want) {
  size_t want_len = strlen(want);
  return len == want_len && memcmp(s, want, want_len) == 0;
}

/* stringToFlags for the write options' flag names — the same table
 * openSync uses, spelled here because the two units build independently.
 * Answers open(2) bits, or -1 for a name Node rejects. */
static int scr_fs_write_flag_bits(const char *s, size_t len) {
  if (scr_fs_write_flag_is(s, len, "r")) return O_RDONLY;
  if (scr_fs_write_flag_is(s, len, "r+")) return O_RDWR;
  if (scr_fs_write_flag_is(s, len, "rs") || scr_fs_write_flag_is(s, len, "sr"))
    return O_RDONLY | O_SYNC;
  if (scr_fs_write_flag_is(s, len, "rs+") || scr_fs_write_flag_is(s, len, "sr+"))
    return O_RDWR | O_SYNC;
  if (scr_fs_write_flag_is(s, len, "w")) return O_WRONLY | O_CREAT | O_TRUNC;
  if (scr_fs_write_flag_is(s, len, "w+")) return O_RDWR | O_CREAT | O_TRUNC;
  if (scr_fs_write_flag_is(s, len, "wx") || scr_fs_write_flag_is(s, len, "xw"))
    return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
  if (scr_fs_write_flag_is(s, len, "wx+") || scr_fs_write_flag_is(s, len, "xw+"))
    return O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
  if (scr_fs_write_flag_is(s, len, "a")) return O_WRONLY | O_CREAT | O_APPEND;
  if (scr_fs_write_flag_is(s, len, "a+")) return O_RDWR | O_CREAT | O_APPEND;
  if (scr_fs_write_flag_is(s, len, "ax") || scr_fs_write_flag_is(s, len, "xa"))
    return O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
  if (scr_fs_write_flag_is(s, len, "ax+") || scr_fs_write_flag_is(s, len, "xa+"))
    return O_RDWR | O_CREAT | O_APPEND | O_EXCL;
  if (scr_fs_write_flag_is(s, len, "as") || scr_fs_write_flag_is(s, len, "sa"))
    return O_WRONLY | O_CREAT | O_APPEND | O_SYNC;
  if (scr_fs_write_flag_is(s, len, "as+") || scr_fs_write_flag_is(s, len, "sa+"))
    return O_RDWR | O_CREAT | O_APPEND | O_SYNC;
  return -1;
}

/* Node's flag check for the write options: an empty name is the form's own
 * default ("w" for writeFileSync, "a" for appendFileSync), and an unknown
 * one throws ERR_INVALID_ARG_VALUE before the path is opened. The received
 * value is quoted the way util.inspect quotes it, so an embedded NUL shows
 * as \x00 rather than cutting the message short. */
static bool scr_fs_write_flags_ok(const ScrStr *flags, const char *dflt, int *bits) {
  *bits = flags->len == 0 ? scr_fs_write_flag_bits(dflt, strlen(dflt))
                          : scr_fs_write_flag_bits(flags->data, flags->len);
  if (*bits >= 0) return true;
  ScrStr *shown = scr_str_inspect_quoted(flags, true);
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "The argument 'flags' is invalid. Received ");
  scr_jb_put_str(&message, shown);
  scr_str_release(shown);
  ScrStr *text = scr_jb_finish(&message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(text);
  return false;
}

/* The open(2) write behind the options form: the flags decide whether an
 * existing file is truncated, appended to or left alone, and the creation
 * mode applies at CREATION only (umask applying) — an existing file keeps
 * its permissions, exactly Node. Same error shapes as the plain form,
 * with the syscall name Node reports for each step. */
static void scr_fs_write_bytes_at(ScrStr *path, const uint8_t *bytes, size_t len, mode_t mode,
                                  int flags) {
  if (!scr_fs_path_ok(path, "path")) return;
  int fd = open(path->data, flags | O_BINARY, mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return;
  }
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

/* The encoding name check both data kinds share: Node validates the
 * encoding option before it looks at the data, so an invalid name throws
 * even though Buffer data is written without it. An empty name is utf8. */
static bool scr_fs_write_encoding_ok(ScrStr *encoding) {
  if (encoding->len == 0 || scr_bytes_is_encoding(encoding)) return true;
  ScrDyn *value = scr_dyn_new_str(encoding);
  scr_dyn_arg_value_fail("encoding", "is invalid encoding", value);
  scr_dyn_release(value);
  return false;
}

/* The string data of an options-form write, encoded with the requested
 * encoding (Node's Buffer.from(data, encoding) — "utf8" and the empty name
 * copy the bytes). An invalid name throws ERR_INVALID_ARG_VALUE before the
 * file is touched. */
static void scr_fs_write_string(ScrStr *path, ScrStr *data, ScrStr *encoding, double mode,
                                const ScrStr *flags, const char *defaultFlag) {
  /* Node reads the options in this order: encoding, flag, mode, and only
   * then the path, so each invalid value reports before the next. */
  if (!scr_fs_write_encoding_ok(encoding)) return;
  int bits = 0;
  if (!scr_fs_write_flags_ok(flags, defaultFlag, &bits)) return;
  if (!scr_fs_write_mode_ok(mode)) return;
  if (encoding->len == 0 || scr_bytes_encoding_is_utf8(encoding)) {
    char *owned;
    const char *bytes = scr_str_utf8(data, &owned);
    scr_fs_write_bytes_at(path, (const uint8_t *)bytes, data->len, (mode_t)mode, bits);
    scr_str_utf8_end(owned);
    return;
  }
  ScrBytes *encoded = scr_bytes_from_str_checked(data, encoding);
  if (!encoded) return;
  scr_fs_write_bytes_at(path, encoded->data, encoded->len * scr_bytes_elem_size(encoded->elem),
                        (mode_t)mode, bits);
  scr_bytes_release(encoded);
}

/* The Buffer data of an options-form write: the bytes are already what
 * Node writes, so only the mode and flags matter — the encoding is
 * validated and otherwise ignored, exactly Node. */
static void scr_fs_write_blob(ScrStr *path, const ScrBytes *data, ScrStr *encoding, double mode,
                              const ScrStr *flags, const char *defaultFlag) {
  if (!scr_fs_write_encoding_ok(encoding)) return;
  int bits = 0;
  if (!scr_fs_write_flags_ok(flags, defaultFlag, &bits)) return;
  if (!scr_fs_write_mode_ok(mode)) return;
  scr_fs_write_bytes_at(path, data->data, data->len * scr_bytes_elem_size(data->elem), (mode_t)mode,
                        bits);
}

/* writeFileSync(p, data, { encoding, mode, flag }) and appendFileSync's
 * three-argument form: the same open(2) write with the option names Node
 * documents. */
void scr_fs_write_file_options(ScrStr *path, ScrStr *data, ScrStr *encoding, double mode,
                               ScrStr *flags) {
  scr_fs_write_string(path, data, encoding, mode, flags, "w");
}

void scr_fs_append_file_options(ScrStr *path, ScrStr *data, ScrStr *encoding, double mode,
                                ScrStr *flags) {
  scr_fs_write_string(path, data, encoding, mode, flags, "a");
}

void scr_fs_write_file_bytes_options(ScrStr *path, const ScrBytes *data, ScrStr *encoding,
                                     double mode, ScrStr *flags) {
  scr_fs_write_blob(path, data, encoding, mode, flags, "w");
}

void scr_fs_append_file_bytes_options(ScrStr *path, const ScrBytes *data, ScrStr *encoding,
                                      double mode, ScrStr *flags) {
  scr_fs_write_blob(path, data, encoding, mode, flags, "a");
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
