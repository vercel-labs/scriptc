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
 * validated and otherwise ignored, exactly Node. The bytes are snapshotted
 * like the plain byte write's, so a shared payload reaches write() as a
 * local copy rather than as storage another thread may change. */
static void scr_fs_write_blob(ScrStr *path, const ScrBytes *data, ScrStr *encoding, double mode,
                              const ScrStr *flags, const char *defaultFlag) {
  if (!scr_fs_write_encoding_ok(encoding)) return;
  int bits = 0;
  if (!scr_fs_write_flags_ok(flags, defaultFlag, &bits)) return;
  if (!scr_fs_write_mode_ok(mode)) return;
  SCR_BYTES_SNAPSHOT(data);
  scr_fs_write_bytes_at(path, data->data, data->len * scr_bytes_elem_size(data->elem), (mode_t)mode,
                        bits);
}

/* ── the general options record of fs.promises.writeFile ─────────────────
 *
 * fs.promises.writeFile reads its third argument through getOptions — null,
 * undefined and functions are the defaults, a string is the encoding alone,
 * and any other primitive is ERR_INVALID_ARG_TYPE — and then, in this order:
 * the encoding (assertEncoding unless it is "buffer"), the signal's type,
 * `options.flag || "w"`, `options.flush ?? false` (a boolean), the data (a
 * string encoded with `options.encoding || "utf8"`, a view as its bytes),
 * the abort check, and only then open(): the path, stringToFlags(flag) and
 * parseFileMode(options.mode, "mode", 0666). Each step reports its own
 * error before the next, so the checks below run in that order; a failure
 * leaves the exception pending and the promise mint turns it into the
 * rejection. appendFile funnels into the same write with its own default
 * flag ("a") and the same options. */

/* What one call reads out of the record. The dyn values are owned and
 * released by scr_fs_write_opts_clear; `encoding` borrows its string from
 * `encoding_value`, which the struct owns so that a getter's returned
 * string outlives the reach for the data. */
typedef struct {
  const ScrDyn *options; /* borrowed; open() reads `mode` from it last */
  ScrDyn *encoding_value; /* owned; NULL when the record named no encoding */
  ScrStr *encoding;      /* borrows from encoding_value; NULL for utf8 */
  bool buffer_encoding;  /* encoding === "buffer" */
  ScrDyn *flag;
  ScrDyn *flush;
  ScrDyn *signal; /* NULL when absent or undefined */
  bool flush_on;
} ScrFsWriteOpts;

static void scr_fs_write_opts_clear(ScrFsWriteOpts *o) {
  scr_dyn_release(o->flag);
  scr_dyn_release(o->flush);
  scr_dyn_release(o->signal);
  scr_dyn_release(o->encoding_value);
}

static bool scr_fs_write_opts_encoding(ScrFsWriteOpts *o, const ScrDyn *options) {
  ScrDyn *value =
      options->kind == SCR_DYN_STR ? scr_dyn_retain((ScrDyn *)options)
                                   : scr_fs_option_get(options, "encoding");
  if (!value) return false;
  bool ok = true;
  if (value->kind == SCR_DYN_STR) {
    ScrStr *name = value->v.str;
    if (name->len > 0) {
      if (name->len == 6 && memcmp(name->data, "buffer", 6) == 0) {
        /* assertEncoding skips exactly this name; Buffer.from reports it
         * when the data is a string (see scr_fs_write_opts_run). */
        o->buffer_encoding = true;
      } else if (scr_bytes_is_encoding(name)) {
        o->encoding = name;
      } else {
        scr_dyn_arg_value_fail("encoding", "is invalid encoding", value);
        ok = false;
      }
    }
  } else if (scr_dyn_truthy(value)) {
    /* assertEncoding: only falsy non-strings pass unvalidated. */
    scr_dyn_arg_value_fail("encoding", "is invalid encoding", value);
    ok = false;
  }
  /* `o->encoding` borrows this value's string: the struct keeps it alive
   * until scr_fs_write_opts_clear, by which point the data is encoded. */
  o->encoding_value = value;
  return ok;
}

/* getOptions' own gate: a string is the encoding-only spelling and any
 * other primitive is Node's ERR_INVALID_ARG_TYPE. */
static bool scr_fs_write_opts_type_ok(const ScrDyn *options) {
  switch (options->kind) {
    case SCR_DYN_NULL:
    case SCR_DYN_UNDEF:
    case SCR_DYN_FUNC:
    case SCR_DYN_STR:
      return true;
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

static bool scr_fs_write_opts_read(ScrFsWriteOpts *o, const ScrDyn *options) {
  memset(o, 0, sizeof *o);
  o->options = options;
  if (!scr_fs_write_opts_type_ok(options)) return false;
  if (!scr_fs_write_opts_encoding(o, options)) return false;
  o->flag = scr_fs_option_get(options, "flag");
  if (!o->flag) return false;
  /* `options.flush ?? false` through validateBoolean: null and undefined
   * are the false default, every other non-boolean throws. */
  o->flush = scr_fs_option_get(options, "flush");
  if (!o->flush) return false;
  if (o->flush->kind != SCR_DYN_NULL && o->flush->kind != SCR_DYN_UNDEF) {
    if (o->flush->kind != SCR_DYN_BOOL) {
      scr_dyn_prop_type_fail("options.flush", "of type boolean", o->flush);
      return false;
    }
    o->flush_on = o->flush->v.b;
  }
  /* getOptions validates the signal's type (`!== undefined`), and
   * checkAborted reads `aborted` later, after the data. */
  o->signal = scr_fs_option_get(options, "signal");
  if (!o->signal) return false;
  if (o->signal->kind != SCR_DYN_UNDEF) {
    if (o->signal->kind != SCR_DYN_HANDLE ||
        o->signal->v.handle.tag != SCR_DYNH_ABORT_SIGNAL) {
      scr_dyn_arg_type_fail("options.signal", "an instance of AbortSignal", o->signal);
      return false;
    }
  } else {
    scr_dyn_release(o->signal);
    o->signal = NULL;
  }
  return true;
}

/* checkAborted: an aborted signal rejects with Node's AbortError (the
 * signal's reason as `cause`) before the path is opened. */
static bool scr_fs_write_opts_aborted(const ScrFsWriteOpts *o) {
  if (!o->signal) return false;
  ScrStr *key = scr_str_new("aborted", 7);
  ScrDyn *aborted = scr_dyn_handle_key_get(o->signal, key);
  scr_str_release(key);
  bool cancelled = aborted && scr_dyn_truthy(aborted);
  scr_dyn_release(aborted);
  if (!cancelled) return false;
  ScrStr *reason_key = scr_str_new("reason", 6);
  ScrDyn *reason = scr_dyn_handle_key_get(o->signal, reason_key);
  scr_str_release(reason_key);
  ScrError *error = scr_error_abort(reason);
  scr_dyn_release(reason);
  scr_throw_obj(error, scr_error_retain_v, scr_error_release_v, scr_error_trace_arg());
  return true;
}

/* stringToFlags over the record's flag: the default when the value is
 * absent or falsy (`options.flag || "w"`), the name table for a string, and
 * validateInt32 for a number. Every other value is ERR_INVALID_ARG_VALUE
 * with the value's inspect, the same message the string table's miss
 * reports. */
static bool scr_fs_write_opts_bits(const ScrFsWriteOpts *o, const char *dflt, int *bits) {
  if (o->flag->kind == SCR_DYN_STR)
    return scr_fs_write_flags_ok(o->flag->v.str, dflt, bits);
  if (!scr_dyn_truthy(o->flag)) {
    *bits = scr_fs_write_flag_bits(dflt, strlen(dflt));
    return true;
  }
  if (o->flag->kind == SCR_DYN_NUM) {
    double flags = o->flag->v.num;
    char recv[48], msg[192];
    scr_num_received(flags, recv);
    if (!(isfinite(flags) && trunc(flags) == flags)) {
      int len = snprintf(msg, sizeof msg,
                         "The value of \"flags\" is out of range. It must be an integer. Received %s",
                         recv);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
      return false;
    }
    if (flags < -2147483648.0 || flags > 2147483647.0) {
      int len = snprintf(
          msg, sizeof msg,
          "The value of \"flags\" is out of range. It must be >= -2147483648 && <= 2147483647. Received %s",
          recv);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
      return false;
    }
    *bits = (int)flags;
    return true;
  }
  scr_dyn_arg_value_fail("flags", NULL, o->flag);
  return false;
}

/* parseFileMode(options.mode, "mode", 0666): an octal string or a number,
 * validated as a 32-bit unsigned integer. Read here because open() reads
 * the record's mode last, after the data and the abort check. */
static bool scr_fs_write_opts_mode(const ScrFsWriteOpts *o, double *mode) {
  ScrDyn *value = scr_fs_option_get(o->options, "mode");
  if (!value) return false;
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    *mode = 0666;
    return true;
  }
  double out;
  bool ok = true;
  if (value->kind == SCR_DYN_STR) {
    const ScrStr *text = value->v.str;
    bool octal = text->len > 0;
    for (size_t i = 0; octal && i < text->len; i++)
      if (text->data[i] < '0' || text->data[i] > '7') octal = false;
    if (!octal) {
      scr_dyn_arg_value_fail("mode", "must be a 32-bit unsigned integer or an octal string", value);
      ok = false;
    } else {
      out = 0;
      for (size_t i = 0; i < text->len; i++) out = out * 8 + (double)(text->data[i] - '0');
    }
  } else if (value->kind == SCR_DYN_NUM) {
    out = value->v.num;
  } else {
    scr_dyn_arg_type_fail("mode", "of type number", value);
    ok = false;
  }
  if (ok && !scr_fs_write_mode_ok(out)) ok = false;
  if (ok) *mode = out;
  scr_dyn_release(value);
  return ok;
}

/* The open(2) write with the flush option: fsync before the close. The
 * write, fsync and close syscalls report without a path, as Node's
 * descriptor-based ones do. */
static void scr_fs_write_bytes_flush(ScrStr *path, const uint8_t *bytes, size_t len, mode_t mode,
                                     int flags, bool flush) {
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
      scr_fs_throw(e, "write", NULL);
      return;
    }
    at += (size_t)wrote;
  }
  if (flush) {
    /* The portable flush: `_commit` on Windows, where the CRT declares no
     * fsync, and fsync everywhere else (scr_lib.c's scr_fs_raw_fsync). */
    int synced = scr_fs_raw_fsync(fd);
    if (synced != 0) {
      close(fd);
      scr_fs_throw(-synced, "fsync", NULL);
      return;
    }
  }
  if (close(fd) != 0) scr_fs_throw(errno, "close", NULL);
}

/* The data of the general form: exactly one of the three spellings. */
typedef struct {
  ScrStr *str;           /* borrowed */
  const ScrBytes *bytes; /* borrowed */
  const ScrDyn *dyn;     /* borrowed; the checked-data spelling */
} ScrFsWritePayload;

/* One general options write. Node's step order runs first (encoding and
 * signal in the record, flag, flush, data, abort, path, flag bits, mode);
 * only then is the file opened. The encoded data and the byte snapshot are
 * released on every exit. */
static void scr_fs_write_options_run(ScrStr *path, const ScrFsWritePayload *payload,
                                     const ScrDyn *options, const char *default_flag) {
  ScrFsWriteOpts o;
  if (!scr_fs_write_opts_read(&o, options)) {
    scr_fs_write_opts_clear(&o);
    return;
  }
  ScrFsWritePayload data = *payload;
  if (!data.str && !data.bytes) {
    if (data.dyn->kind == SCR_DYN_STR) {
      data.str = data.dyn->v.str;
    } else if (data.dyn->kind == SCR_DYN_BYTES) {
      data.bytes = data.dyn->v.bytes;
    } else {
      scr_dyn_arg_type_fail("data", "of type string or an instance of Buffer, TypedArray, or DataView",
                            data.dyn);
      scr_fs_write_opts_clear(&o);
      return;
    }
  }
  const uint8_t *bytes = NULL;
  size_t len = 0;
  ScrBytes *encoded = NULL;
  char *owned = NULL;
  /* The snapshot of a shared payload has to outlive the write below, so it
   * is taken for the whole function rather than inside the byte branch,
   * whose scope ends before the bytes reach write(2). */
  const ScrBytes *view = data.bytes;
  SCR_BYTES_SNAPSHOT(view);
  if (data.str) {
    if (o.encoding != NULL) {
      /* Buffer.from(data, encoding): the requested encoding, or the
       * ERR_UNKNOWN_ENCODING "buffer" carries when it was named as the
       * record's encoding for string data. */
      encoded = scr_bytes_from_str_checked(data.str, o.encoding);
      if (!encoded) {
        scr_fs_write_opts_clear(&o);
        return;
      }
      bytes = encoded->data;
      len = encoded->len * scr_bytes_elem_size(encoded->elem);
    } else if (o.buffer_encoding) {
      ScrStr *name = scr_str_new("buffer", 6);
      encoded = scr_bytes_from_str_checked(data.str, name);
      scr_str_release(name);
      if (!encoded) {
        scr_fs_write_opts_clear(&o);
        return;
      }
      bytes = encoded->data;
      len = encoded->len * scr_bytes_elem_size(encoded->elem);
    } else {
      bytes = (const uint8_t *)scr_str_utf8(data.str, &owned);
      len = data.str->len;
    }
  } else {
    bytes = view->data;
    len = view->len * scr_bytes_elem_size(view->elem);
  }
  int bits = 0;
  double mode = 0666;
  if (!scr_fs_write_opts_aborted(&o) && scr_fs_path_ok(path, "path") &&
      scr_fs_write_opts_bits(&o, default_flag, &bits) && scr_fs_write_opts_mode(&o, &mode))
    scr_fs_write_bytes_flush(path, bytes, len, (mode_t)mode, bits, o.flush_on);
  scr_str_utf8_end(owned);
  scr_bytes_release(encoded);
  scr_fs_write_opts_clear(&o);
}

/* fs.promises.writeFile(path, data, options): every documented option
 * (encoding, mode, flag, flush, signal) over a string, a view or a value
 * whose type the call site did not pin down. */
ScrPromise *scr_fsp_write_file_options(ScrStr *path, ScrStr *data, const ScrDyn *options) {
  ScrFsWritePayload payload = {data, NULL, NULL};
  scr_fs_write_options_run(path, &payload, options, "w");
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_write_file_options_bytes(ScrStr *path, const ScrBytes *data,
                                             const ScrDyn *options) {
  ScrFsWritePayload payload = {NULL, data, NULL};
  scr_fs_write_options_run(path, &payload, options, "w");
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_write_file_options_data(ScrStr *path, const ScrDyn *data,
                                            const ScrDyn *options) {
  ScrFsWritePayload payload = {NULL, NULL, data};
  scr_fs_write_options_run(path, &payload, options, "w");
  return scr_promise_settled_void();
}

/* fs.promises.appendFile reads the same record and writes it with append's
 * default flag: the flag option may still pick truncation, exactly Node. */
ScrPromise *scr_fsp_append_file_options(ScrStr *path, ScrStr *data, const ScrDyn *options) {
  ScrFsWritePayload payload = {data, NULL, NULL};
  scr_fs_write_options_run(path, &payload, options, "a");
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_append_file_options_bytes(ScrStr *path, const ScrBytes *data,
                                              const ScrDyn *options) {
  ScrFsWritePayload payload = {NULL, data, NULL};
  scr_fs_write_options_run(path, &payload, options, "a");
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_append_file_options_data(ScrStr *path, const ScrDyn *data,
                                             const ScrDyn *options) {
  ScrFsWritePayload payload = {NULL, NULL, data};
  scr_fs_write_options_run(path, &payload, options, "a");
  return scr_promise_settled_void();
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
