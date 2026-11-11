/* The BYTE-data spellings of writeFile and writeFileSync: the options
 * record's creation mode and disposition flag over a Uint8Array/Buffer
 * payload, beside the string forms in scr_fs_flags.c, and
 * fs.promises.writeFile(path, bytes) without options. The checked-data
 * forms live here too: a data argument whose type the call site did not
 * pin down is validated at runtime and written as a string or as the
 * bytes of whichever view reaches it.
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

/* ── the checked data argument ───────────────────────────────────────────
 * Node's write data is a string, a Buffer, a TypedArray or a DataView; the
 * views write the bytes they cover (a subarray's window, a DataView's, the
 * whole of a typed array) whatever buffer backs them. A checked-dynamic
 * value that reaches a write is one of those kinds or is refused with
 * Node's message before any path is opened. */
typedef struct {
  ScrStr *str;           /* borrowed; NULL when the data is a view */
  const ScrBytes *bytes; /* borrowed; NULL when the data is a string */
} ScrFsWriteData;

static bool scr_fs_write_data_arg(const ScrDyn *data, ScrFsWriteData *out) {
  out->str = NULL;
  out->bytes = NULL;
  if (data->kind == SCR_DYN_STR) {
    out->str = data->v.str;
    return true;
  }
  if (data->kind == SCR_DYN_BYTES) {
    out->bytes = data->v.bytes;
    return true;
  }
  scr_dyn_arg_type_fail("data", "of type string or an instance of Buffer, TypedArray, or DataView",
                        data);
  return false;
}

/* The byte length of a view's window: element count times element width,
 * read from the view's own data pointer (which already includes the
 * window's offset into its storage). */
static size_t scr_fs_write_data_len(const ScrBytes *bytes) {
  return bytes->len * scr_bytes_elem_size(bytes->elem);
}

/* Node's encoding-name validation for the options-record write: an empty
 * name is utf8 and any other name must be one Node decodes. Throws
 * ERR_INVALID_ARG_VALUE and answers false. Node checks the encoding before
 * it looks at the data, so the checked-data options forms call this first.
 * A local copy of scr_fs_flags.c's check keeps this gated unit free of
 * that one's symbols (see scr_fs_bytes_write_mode_ok above). */
static bool scr_fs_bytes_write_encoding_ok(ScrStr *encoding) {
  if (encoding->len == 0 || scr_bytes_is_encoding(encoding)) return true;
  ScrDyn *value = scr_dyn_new_str(encoding);
  scr_dyn_arg_value_fail("encoding", "is invalid encoding", value);
  scr_dyn_release(value);
  return false;
}

/* writeFileSync(path, data) and appendFileSync(path, data) over a data
 * argument whose type the call site did not pin down. The string arm keeps
 * the plain write of its own shape; the view arm writes the raw bytes. */
void scr_fs_write_file_data(ScrStr *path, const ScrDyn *data) {
  ScrFsWriteData arg;
  if (!scr_fs_write_data_arg(data, &arg)) return;
  if (arg.str) scr_fs_write_file(path, arg.str);
  else scr_fs_write_file_bytes(path, arg.bytes);
}

void scr_fs_append_file_data(ScrStr *path, const ScrDyn *data) {
  ScrFsWriteData arg;
  if (!scr_fs_write_data_arg(data, &arg)) return;
  if (arg.str) scr_fs_append_file(path, arg.str);
  else scr_fs_append_file_bytes(path, arg.bytes);
}

ScrPromise *scr_fsp_write_file_data(ScrStr *path, const ScrDyn *data) {
  scr_fs_write_file_data(path, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_append_file_data(ScrStr *path, const ScrDyn *data) {
  scr_fs_append_file_data(path, data);
  return scr_promise_settled_void();
}

/* writeFileSync(p, data, { mode, flag }) over the same checked data. */
void scr_fs_write_file_flags_data(ScrStr *path, const ScrDyn *data, double mode,
                                  double exclusive) {
  ScrFsWriteData arg;
  if (!scr_fs_write_data_arg(data, &arg)) return;
  if (arg.str) scr_fs_write_file_flags(path, arg.str, mode, exclusive);
  else scr_fs_write_file_flags_bytes(path, arg.bytes, mode, exclusive);
}

ScrPromise *scr_fsp_write_file_flags_data(ScrStr *path, const ScrDyn *data, double mode,
                                          double exclusive) {
  scr_fs_write_file_flags_data(path, data, mode, exclusive);
  return scr_promise_settled_void();
}

/* The options-record writes (encoding, creation mode, disposition flag)
 * over the checked data: the encoding name is validated first, as Node
 * does before it looks at the data, then the data kind, and each arm
 * validates the flag and mode in Node's order, so an invalid option
 * reports even when the data is not writable. */
void scr_fs_write_file_data_options(ScrStr *path, const ScrDyn *data, ScrStr *encoding,
                                    double mode, ScrStr *flags) {
  if (!scr_fs_bytes_write_encoding_ok(encoding)) return;
  ScrFsWriteData arg;
  if (!scr_fs_write_data_arg(data, &arg)) return;
  if (arg.str) scr_fs_write_file_options(path, arg.str, encoding, mode, flags);
  else scr_fs_write_file_bytes_options(path, arg.bytes, encoding, mode, flags);
}

void scr_fs_append_file_data_options(ScrStr *path, const ScrDyn *data, ScrStr *encoding,
                                     double mode, ScrStr *flags) {
  if (!scr_fs_bytes_write_encoding_ok(encoding)) return;
  ScrFsWriteData arg;
  if (!scr_fs_write_data_arg(data, &arg)) return;
  if (arg.str) scr_fs_append_file_options(path, arg.str, encoding, mode, flags);
  else scr_fs_append_file_bytes_options(path, arg.bytes, encoding, mode, flags);
}

/* writeFileSync(fd, data): the descriptor form over the checked data. The
 * descriptor stays open and its offset advances, like the string form. */
void scr_fs_write_file_fd_data(double fd, const ScrDyn *data) {
  ScrFsWriteData arg;
  if (!scr_fs_write_data_arg(data, &arg)) return;
  if (arg.str) {
    scr_fs_write_file_fd(fd, arg.str);
    return;
  }
  const ScrBytes *bytes = arg.bytes;
  SCR_BYTES_SNAPSHOT(bytes);
  size_t len = scr_fs_write_data_len(bytes);
  const char *from = (const char *)bytes->data;
  size_t at = 0;
  while (at < len) {
    double wrote = scr_fs_write_mem(fd, from + at, len - at, -1);
    if (wrote <= 0) break;
    at += (size_t)wrote;
  }
}
