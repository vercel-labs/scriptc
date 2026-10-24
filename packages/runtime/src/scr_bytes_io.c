/* The OS-facing half of the typed-array/Buffer runtime: fs Buffer reads/
 * writes (scr_lib.c's throw formatting), the fs/promises bytes form
 * (scr_async.c's settled-promise minting), crypto.randomBytes, and the
 * process stream Buffer writes. Split from scr_bytes.c so the pure bytes
 * core links without the lib/async runtimes (the runtime unit tests link
 * exact source lists). */
#include "scr_runtime.h"

static ScrArrOps scr_bytes_io_str_ops = { scr_str_retain_v, scr_str_release_v, NULL };
static ScrArrOps scr_bytes_io_bytes_ops = { scr_bytes_retain_v, scr_bytes_release_v, NULL };

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <fcntl.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>
#ifndef O_SYNC
#define O_SYNC 0 /* Windows CRT opens have no separate synchronous flag. */
#endif
#ifdef __APPLE__
#include <sys/stat.h> /* lchmod(2) — the fs.lchmodSync ladder's real tail */
#endif

static void scr_bytes_io_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

static bool scr_fs_read_encoding_valid(ScrStr *encoding) {
  if (encoding->len == 0 || scr_bytes_is_encoding(encoding)) return true;
  ScrDyn *value = scr_dyn_new_str(encoding);
  scr_dyn_arg_value_fail("encoding", "is invalid encoding", value);
  scr_dyn_release(value);
  return false;
}

static ScrStr *scr_fs_decode_read(ScrBytes *bytes, ScrStr *encoding) {
  if (!bytes) return NULL;
  ScrStr *text;
  if (encoding->len == 0) {
    ScrStr *utf8 = scr_str_new("utf8", 4);
    text = scr_bytes_to_str(bytes, utf8);
    scr_str_release(utf8);
  } else {
    text = scr_bytes_to_str_checked(bytes, encoding);
  }
  scr_bytes_release(bytes);
  return text;
}

/* UTF-8 reads (the common case, and the empty name's default) skip the
 * intermediate Buffer: the file is read into string storage and decoded in
 * place, with the same errors and decode as the Buffer path. */
static bool scr_fs_read_utf8(ScrStr *encoding) {
  return encoding->len == 0 || scr_bytes_encoding_is_utf8(encoding);
}

void scr_fs_check_read_encoding(ScrStr *encoding) {
  (void)scr_fs_read_encoding_valid(encoding);
}

ScrStr *scr_fs_read_file_encoded(ScrStr *path, ScrStr *encoding) {
  if (!scr_fs_read_encoding_valid(encoding)) return NULL;
  if (scr_fs_read_utf8(encoding)) return scr_fs_read_file(path);
  return scr_fs_decode_read(scr_fs_read_file_bytes(path), encoding);
}

ScrStr *scr_fs_read_fd_encoded(double fd, ScrStr *encoding) {
  if (!scr_fs_read_encoding_valid(encoding)) return NULL;
  if (scr_fs_read_utf8(encoding)) return scr_fs_read_fd(fd);
  return scr_fs_decode_read(scr_fs_read_fd_bytes(fd), encoding);
}

/* ── fs (the Buffer forms of scr_lib.c's utf8 pair) ────────────────────── */

static bool scr_fs_str_is(const ScrStr *s, const char *lit);

/* readFileSync's runtime-encoding form (a JS helper's untyped `enc`
 * parameter — test/common fixtures.js): undefined/null answer a Buffer,
 * a supported encoding answers a string, invalid names throw
 * ERR_INVALID_ARG_VALUE before reading, 'buffer' reads and then throws
 * ERR_UNKNOWN_ENCODING, and an
 * options object dispatches on its `encoding` member (Node's form). +1
 * dyn value, or NULL with the exception pending. */
ScrDyn *scr_fs_read_file_sync_dyn(ScrStr *path, const ScrDyn *enc) {
  if (enc->kind == SCR_DYN_OBJ) {
    ScrDyn *ev = scr_dyn_obj_get((ScrDyn *)enc, "encoding", 8); /* borrowed */
    return scr_fs_read_file_sync_dyn(path, ev ? ev : scr_dyn_undefined());
  }
  if (enc->kind == SCR_DYN_UNDEF || enc->kind == SCR_DYN_NULL ||
      (enc->kind == SCR_DYN_STR && enc->v.str->len == 0)) {
    ScrBytes *b = scr_fs_read_file_bytes(path);
    if (!b) return NULL;
    ScrDyn *d = scr_dyn_new_buffer(b);
    scr_bytes_release(b);
    return d;
  }
  if (enc->kind == SCR_DYN_STR) {
    ScrStr *text;
    if (scr_fs_str_is(enc->v.str, "buffer")) {
      /* getOptions lets 'buffer' through; Node reads the file, then
       * buffer.toString('buffer') throws ERR_UNKNOWN_ENCODING (an empty
       * file answers ""). */
      ScrBytes *b = scr_fs_read_file_bytes(path);
      if (!b) return NULL;
      text = scr_bytes_to_str_checked(b, enc->v.str);
      scr_bytes_release(b);
    } else text = scr_fs_read_file_encoded(path, enc->v.str);
    if (!text) return NULL;
    ScrDyn *value = scr_dyn_new_str(text);
    scr_str_release(text);
    return value;
  }
  {
    /* Kind rendering stays local: scr_dyn_specific_type lives in the
     * net/emitter-gated handle unit and this one links with bare fs. */
    const char *msg = "The \"options\" argument must be of type string or an instance of Object";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
}

static void scr_fs_write_bytes_common(ScrStr *path, const ScrBytes *data, const char *mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  SCR_BYTES_SNAPSHOT(data);
  FILE *f = fopen(path->data, mode);
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  size_t n = data->len * scr_bytes_elem_size(data->elem);
  if (n > 0 && fwrite(data->data, 1, n, f) != n) {
    int e = errno;
    fclose(f);
    scr_fs_throw(e, "write", path);
    return;
  }
  if (fclose(f) != 0) scr_fs_throw(errno, "close", path);
}

void scr_fs_write_file_bytes(ScrStr *path, const ScrBytes *data) {
  scr_fs_write_bytes_common(path, data, "wb");
}

void scr_fs_append_file_bytes(ScrStr *path, const ScrBytes *data) {
  scr_fs_write_bytes_common(path, data, "ab");
}

ScrPromise *scr_fsp_read_file_bytes(ScrStr *path) {
  ScrBytes *b = scr_fs_read_file_bytes(path);
  return scr_promise_settled_ref(b, &scr_bytes_retain_v, &scr_bytes_release_v, NULL);
}

/* Native error-first callbacks remain callable values when a platform layer
 * captures them. Argument failures throw at the call; filesystem failures
 * arrive through the callback on the next event-loop turn. The synchronous
 * filesystem spine does the work, as it does for our promise adapters. */
static bool scr_fs_dyn_absent(const ScrDyn *value);
static bool scr_fs_cb_chk(const ScrDyn *callback, const char *name);
static bool scr_fs_path_chk(const ScrDyn *value, const char *name);
static ScrDyn *scr_fs_cb_arg(ScrDyn *const *args, size_t argc, size_t index) {
  return index < argc ? args[index] : scr_dyn_undefined();
}

static ScrDyn *scr_fs_cb_option(const ScrDyn *options, const char *name) {
  if (scr_fs_dyn_absent(options)) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *object = options->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(options) : scr_dyn_retain((ScrDyn *)options);
  if (!object) return NULL;
  ScrDyn *value = scr_dyn_obj_read(object, name, strlen(name));
  scr_dyn_release(object);
  return value;
}

static double scr_fs_cb_number(const ScrDyn *value, const char *name, double fallback) {
  if (scr_fs_dyn_absent(value)) return fallback;
  if (value->kind == SCR_DYN_BIGINT) return scr_bigint_to_f64(value->v.bigint);
  if (value->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", value);
    return fallback;
  }
  return value->v.num;
}

static double scr_fs_cb_option_number(const ScrDyn *options, const char *name, double fallback) {
  ScrDyn *value = scr_fs_cb_option(options, name);
  if (!value) return fallback;
  double number = scr_fs_cb_number(value, name, fallback);
  scr_dyn_release(value);
  return number;
}

static bool scr_fs_cb_option_bool(const ScrDyn *options, const char *name) {
  ScrDyn *value = scr_fs_cb_option(options, name);
  bool answer = value && scr_dyn_truthy(value);
  scr_dyn_release(value);
  return answer;
}

static bool scr_fs_cb_refuse_option(const ScrDyn *options, const char *name) {
  ScrDyn *value = scr_fs_cb_option(options, name);
  bool present = value && value->kind != SCR_DYN_UNDEF && value->kind != SCR_DYN_NULL;
  scr_dyn_release(value);
  if (present) {
    char message[160];
    int length = snprintf(message, sizeof message, "Filesystem callback option '%s' has no native lowering", name);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)length, "SC2020");
  }
  return present;
}

/* readFile's options.buffer: validateReadFileBufferOptions' type check
 * (any value other than undefined, a function, or an ArrayBufferView
 * throws ERR_INVALID_ARG_TYPE), then a refusal for the valid forms. False
 * with the exception pending in both cases. */
static bool scr_fs_cb_read_buffer_option(const ScrDyn *options) {
  ScrDyn *value = scr_fs_cb_option(options, "buffer");
  if (!value) return false;
  bool absent = value->kind == SCR_DYN_UNDEF;
  if (!absent) {
    if (value->kind != SCR_DYN_FUNC && value->kind != SCR_DYN_BYTES) {
      scr_dyn_prop_type_fail("options.buffer",
                             "of type function or an instance of Buffer, TypedArray, or DataView", value);
    } else {
      static const char message[] = "Filesystem callback option 'buffer' has no native lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    }
  }
  scr_dyn_release(value);
  return absent;
}

static bool scr_fs_cb_signal(const ScrDyn *options) {
  ScrDyn *signal = scr_fs_cb_option(options, "signal");
  if (!signal) return false;
  if (scr_fs_dyn_absent(signal)) { scr_dyn_release(signal); return true; }
  if (signal->kind != SCR_DYN_HANDLE || signal->v.handle.tag != SCR_DYNH_ABORT_SIGNAL) {
    scr_dyn_arg_type_fail("options.signal", "an instance of AbortSignal", signal);
    scr_dyn_release(signal);
    return false;
  }
  ScrStr *key = scr_str_new("aborted", 7);
  ScrDyn *aborted = scr_dyn_handle_key_get(signal, key);
  scr_str_release(key);
  bool cancelled = aborted && scr_dyn_truthy(aborted);
  scr_dyn_release(aborted); scr_dyn_release(signal);
  if (cancelled) {
    static const char message[] = "The operation was aborted";
    ScrStr *text = scr_str_new(message, sizeof message - 1);
    ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
    scr_str_release(text);
    scr_str_release(error->name);
    error->name = scr_str_new("AbortError", 10);
    error->name_present = true;
    scr_error_set_code(error, "ABORT_ERR");
    scr_throw_obj(error, scr_error_retain_v, scr_error_release_v, scr_error_trace_arg());
  }
  return !scr_exc_pending();
}

/* stringToFlags for the string spellings; -1 for an unknown one. */
static int scr_fs_flag_bits(const char *f) {
  if (!strcmp(f, "r")) return O_RDONLY;
  if (!strcmp(f, "r+")) return O_RDWR;
  if (!strcmp(f, "rs") || !strcmp(f, "sr")) return O_RDONLY | O_SYNC;
  if (!strcmp(f, "rs+") || !strcmp(f, "sr+")) return O_RDWR | O_SYNC;
  if (!strcmp(f, "w")) return O_WRONLY | O_CREAT | O_TRUNC;
  if (!strcmp(f, "w+")) return O_RDWR | O_CREAT | O_TRUNC;
  if (!strcmp(f, "wx") || !strcmp(f, "xw")) return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
  if (!strcmp(f, "wx+") || !strcmp(f, "xw+")) return O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
  if (!strcmp(f, "a")) return O_WRONLY | O_CREAT | O_APPEND;
  if (!strcmp(f, "a+")) return O_RDWR | O_CREAT | O_APPEND;
  if (!strcmp(f, "ax") || !strcmp(f, "xa")) return O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
  if (!strcmp(f, "ax+") || !strcmp(f, "xa+")) return O_RDWR | O_CREAT | O_APPEND | O_EXCL;
  if (!strcmp(f, "as") || !strcmp(f, "sa")) return O_WRONLY | O_CREAT | O_APPEND | O_SYNC;
  if (!strcmp(f, "as+") || !strcmp(f, "sa+")) return O_RDWR | O_CREAT | O_APPEND | O_SYNC;
  return -1;
}

static void scr_fs_flag_invalid(const char *f) {
  char message[160];
  int length = snprintf(message, sizeof message, "The argument 'flags' is invalid. Received '%s'", f);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)length, "ERR_INVALID_ARG_VALUE");
}

/* open's flags check, which Node runs before its callback check. Numeric
 * flags keep their open-time refusal. */
static bool scr_fs_cb_open_flags(const ScrDyn *flag) {
  if (flag->kind != SCR_DYN_STR || scr_fs_flag_bits(flag->v.str->data) >= 0) return true;
  scr_fs_flag_invalid(flag->v.str->data);
  return false;
}

static double scr_fs_cb_open(const ScrStr *path, const ScrDyn *flag, double mode, const char *fallback) {
  const char *f = scr_fs_dyn_absent(flag) ? fallback : flag->kind == SCR_DYN_STR ? flag->v.str->data : NULL;
  if (!f) {
    static const char message[] = "Runtime numeric filesystem flags have no portable native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return -1;
  }
  int bits = scr_fs_flag_bits(f);
  if (bits < 0) {
    scr_fs_flag_invalid(f);
    return -1;
  }
  if (scr_exc_pending()) return -1;
  int fd = open(path->data, bits, (mode_t)mode);
  if (fd < 0) scr_fs_throw(errno, "open", path);
  return fd;
}

static ScrStr *scr_fs_cb_path(const ScrDyn *value, const char *name) {
  if (!scr_fs_path_chk(value, name)) return NULL;
  ScrStr *path = value->kind == SCR_DYN_STR ? scr_str_retain(value->v.str)
    : scr_bytes_string(value->v.bytes, 0, value->v.bytes->len);
  if (memchr(path->data, 0, path->len)) {
    scr_fs_invalid_named_path(value, path, name);
    scr_str_release(path);
    return NULL;
  }
  return path;
}

static ScrStr *scr_fs_checked_path(const ScrDyn *value, const char *name) {
  if (!scr_dyn_native_url_is(value)) return scr_fs_cb_path(value, name);
  ScrStr *path = scr_url_checked_to_path(value);
  if (!path) return NULL;
  ScrDyn input = { .kind = SCR_DYN_STR, .v.str = path };
  ScrStr *checked = scr_fs_cb_path(&input, name);
  scr_str_release(path);
  return checked;
}

ScrStr *scr_fs_validated_path(const ScrDyn *value, const char *name) { return scr_fs_checked_path(value, name); }

ScrDyn *scr_fs_option_get(const ScrDyn *options, const char *name) { return scr_fs_cb_option(options, name); }

static ScrStr *scr_fs_timestamp_path(const ScrDyn *value) {
  return scr_fs_checked_path(value, "path");
}

/* statfs reads options.bigint without validating/coercing the options object.
 * Undefined selects the default; null throws, and only boolean true opts in. */
static bool scr_fs_statfs_bigint(const ScrDyn *options) {
  if (options->kind == SCR_DYN_UNDEF) return false;
  if (options->kind == SCR_DYN_NULL) {
    static const char message[] = "Cannot read properties of null (reading 'bigint')";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  ScrDyn *value = scr_fs_cb_option(options, "bigint");
  bool bigint = value && value->kind == SCR_DYN_BOOL && value->v.b;
  scr_dyn_release(value);
  return bigint;
}

ScrDyn *scr_fs_statfs_checked(const ScrDyn *input, const ScrDyn *options) {
  ScrStr *path = scr_fs_checked_path(input, "path");
  if (!path) return NULL;
  bool bigint = scr_fs_statfs_bigint(options);
  ScrDyn *result = scr_exc_pending() ? NULL : scr_fs_statfs(path, bigint);
  scr_str_release(path);
  return result;
}

/* validateOneOf runs before either path, even on POSIX where the type has
 * no syscall effect. -1 means infer the target's kind on Windows. */
static int scr_fs_symlink_type(const ScrDyn *type) {
  if (scr_fs_dyn_absent(type)) return -1;
  if (type->kind == SCR_DYN_STR) {
    const ScrStr *s = type->v.str;
    if (s->len == 4 && !memcmp(s->data, "file", 4)) return 0;
    if (s->len == 3 && !memcmp(s->data, "dir", 3)) return 1;
    if (s->len == 8 && !memcmp(s->data, "junction", 8)) return 2;
  }
  scr_dyn_arg_value_fail("type", "must be one of: 'dir', 'file', 'junction', null, undefined", type);
  return -1;
}

void scr_fs_link_checked(const ScrDyn *existing, const ScrDyn *destination) {
  ScrStr *from = scr_fs_checked_path(existing, "existingPath");
  if (!from) return;
  ScrStr *to = scr_fs_checked_path(destination, "newPath");
  if (to) scr_fs_link(from, to);
  scr_str_release(from); scr_str_release(to);
}

static void scr_fs_symlink_checked_core(const ScrDyn *target, const ScrDyn *destination, const ScrDyn *type, bool promise) {
  int kind = scr_fs_symlink_type(type);
  if (scr_exc_pending()) return;
#ifdef _WIN32
  if (kind == -1) {
    // Sync/promise inference stringifies the raw destination and target before
    // getValidatedPath. Sync stat exposes null-byte errors in the resolved path;
    // the promise form catches inference failures and continues as a file link.
    ScrStr *link = scr_dyn_string_coerce_js(destination);
    ScrStr *source = !scr_exc_pending() ? scr_dyn_string_coerce_js(target) : NULL;
    ScrStr *absolute = NULL;
    if (link && source && !scr_exc_pending()) {
      ScrArr *parts = scr_arr_new_ops(&scr_bytes_io_str_ops, 3);
      scr_arr_push_ref(parts, scr_str_retain(link));
      scr_arr_push_ref(parts, scr_str_new("..", 2));
      scr_arr_push_ref(parts, scr_str_retain(source));
      absolute = scr_path_win32_resolve(parts);
      scr_arr_release(parts);
    }
    kind = 0;
    if (absolute && !scr_exc_pending()) {
      ScrDyn input = { .kind = SCR_DYN_STR, .v.str = absolute };
      ScrStr *checked = scr_fs_cb_path(&input, "path");
      if (checked) kind = scr_fs_symlink_infer(checked);
      scr_str_release(checked);
    }
    scr_str_release(link); scr_str_release(source); scr_str_release(absolute);
    if (scr_exc_pending()) {
      if (!promise) return;
      scr_caught_release(scr_exc_take());
    }
  }
#else
  (void)promise;
#endif
  ScrStr *from = scr_fs_checked_path(target, "target");
  if (!from) return;
  ScrStr *to = scr_fs_checked_path(destination, "path");
#ifdef _WIN32
  if (to && kind == 2 && scr_dyn_bytes_is(destination, SCR_BYTES_U8)) {
    scr_dyn_arg_type_fail("paths[0]", "of type string", destination);
    scr_str_release(to); to = NULL;
  }
#endif
  if (to) scr_fs_symlink(from, to, kind);
  scr_str_release(from); scr_str_release(to);
}

void scr_fs_symlink_checked(const ScrDyn *target, const ScrDyn *destination, const ScrDyn *type) {
  scr_fs_symlink_checked_core(target, destination, type, false);
}

void scr_fs_symlink_promise_checked(const ScrDyn *target, const ScrDyn *destination, const ScrDyn *type) {
  scr_fs_symlink_checked_core(target, destination, type, true);
}

/* getOptions accepts functions as defaults and validates signals without
 * cancelling readlink. Unlike readFile, an aborted signal is ignored. */
static ScrDyn *scr_fs_readlink_encoding(const ScrDyn *options) {
  if (scr_fs_dyn_absent(options) || options->kind == SCR_DYN_FUNC) return scr_dyn_retain(scr_dyn_undefined());
  if (options->kind != SCR_DYN_STR && options->kind != SCR_DYN_OBJ &&
      options->kind != SCR_DYN_ARR && options->kind != SCR_DYN_TYPED_REF &&
      options->kind != SCR_DYN_HANDLE && options->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("options", "one of type string or object", options);
    return NULL;
  }
  ScrDyn *encoding = options->kind == SCR_DYN_STR ? scr_dyn_retain((ScrDyn *)options) : scr_fs_cb_option(options, "encoding");
  if (!encoding) return NULL;
  bool buffer = encoding->kind == SCR_DYN_STR && encoding->v.str->len == 6 && !memcmp(encoding->v.str->data, "buffer", 6);
  if (!buffer && scr_dyn_truthy(encoding) &&
      (encoding->kind != SCR_DYN_STR || !scr_bytes_is_encoding(encoding->v.str))) {
    scr_dyn_arg_value_fail("encoding", "is invalid encoding", encoding);
    scr_dyn_release(encoding);
    return NULL;
  }
  if (options->kind != SCR_DYN_STR) {
    ScrDyn *signal = scr_fs_cb_option(options, "signal");
    if (!signal) { scr_dyn_release(encoding); return NULL; }
    bool valid = signal->kind == SCR_DYN_UNDEF || (signal->kind == SCR_DYN_HANDLE && signal->v.handle.tag == SCR_DYNH_ABORT_SIGNAL);
    if (!valid) scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", signal);
    scr_dyn_release(signal);
    if (!valid) { scr_dyn_release(encoding); return NULL; }
  }
  return encoding;
}

static ScrDyn *scr_fs_readlink_result(ScrStr *path, const ScrDyn *encoding) {
  ScrBytes *bytes = scr_fs_readlink_bytes(path);
  if (!bytes) return NULL;
  ScrDyn *result;
  if (encoding->kind == SCR_DYN_STR && encoding->v.str->len == 6 && !memcmp(encoding->v.str->data, "buffer", 6)) {
    result = scr_dyn_new_buffer(bytes);
  }
  else {
    ScrStr *codec = encoding->kind == SCR_DYN_STR && encoding->v.str->len ? scr_str_retain(encoding->v.str) : scr_str_new("utf8", 4);
    ScrStr *text = scr_bytes_to_str(bytes, codec);
    scr_str_release(codec);
    result = text ? scr_dyn_new_str(text) : NULL;
    scr_str_release(text);
  }
  scr_bytes_release(bytes);
  return result;
}

ScrDyn *scr_fs_readlink_checked(const ScrDyn *input, const ScrDyn *options, bool promise) {
  ScrDyn *encoding = scr_fs_readlink_encoding(options);
  if (!encoding) return NULL;
  ScrStr *path = scr_fs_checked_path(input, promise ? "oldPath" : "path");
  ScrDyn *result = path ? scr_fs_readlink_result(path, encoding) : NULL;
  scr_str_release(path); scr_dyn_release(encoding);
  return result;
}

ScrDyn *scr_fs_readlink_dyn(const ScrDyn *path, const ScrDyn *options) {
  return scr_fs_readlink_checked(path, options, false);
}

ScrStr *scr_fs_readlink_str(const ScrDyn *path, const ScrDyn *options) {
  ScrDyn *result = scr_fs_readlink_dyn(path, options);
  ScrStr *text = result && result->kind == SCR_DYN_STR ? scr_str_retain(result->v.str) : NULL;
  scr_dyn_release(result);
  return text;
}

ScrBytes *scr_fs_readlink_buffer(const ScrDyn *path, const ScrDyn *options) {
  ScrDyn *result = scr_fs_readlink_dyn(path, options);
  ScrBytes *bytes = result ? scr_dyn_bytes_unbox(result) : NULL;
  scr_dyn_release(result);
  return bytes;
}

static ScrDyn *scr_fs_cb_string(ScrStr *text) {
  if (!text) return NULL;
  ScrDyn *value = scr_dyn_new_str(text);
  scr_str_release(text);
  return value;
}

/* A path result (mkdtemp) in getOptions' encoding: a string for utf8 and
 * the default, a Buffer for 'buffer', and the UTF-8 bytes re-encoded
 * otherwise, as the binding's StringBytes::Encode does. Consumes +1 text. */
static ScrDyn *scr_fs_cb_encoded_path(ScrStr *text, const ScrDyn *options) {
  if (!text) return NULL;
  ScrDyn *encoding = options->kind == SCR_DYN_STR ? scr_dyn_retain((ScrDyn *)options) : scr_fs_cb_option(options, "encoding");
  ScrDyn *value = NULL;
  if (encoding && encoding->kind == SCR_DYN_STR && encoding->v.str->len > 0 && !scr_fs_str_is(encoding->v.str, "utf8") &&
      !scr_fs_str_is(encoding->v.str, "utf-8")) {
    ScrBytes *bytes = scr_bytes_from_data((const uint8_t *)text->data, text->len);
    if (scr_fs_str_is(encoding->v.str, "buffer")) value = scr_dyn_new_buffer(bytes);
    else {
      ScrStr *encoded = scr_bytes_to_str_checked(bytes, encoding->v.str);
      if (encoded) {
        value = scr_dyn_new_str(encoded);
        scr_str_release(encoded);
      }
    }
    scr_bytes_release(bytes);
  } else if (encoding) value = scr_dyn_new_str(text);
  scr_dyn_release(encoding);
  scr_str_release(text);
  return value;
}

static ScrStr *scr_fs_cb_join(const ScrStr *directory, const char *name) {
  ScrStr *suffix = scr_str_new("/", 1);
  ScrStr *base = scr_str_concat((ScrStr *)directory, suffix);
  scr_str_release(suffix);
  suffix = scr_str_new(name, strlen(name));
  ScrStr *path = scr_str_concat(base, suffix);
  scr_str_release(base); scr_str_release(suffix);
  return path;
}

static ScrDyn *scr_fs_cb_stat_test(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args; (void)argc;
  return scr_dyn_new_bool(scr_box_get_bool(closure->caps[0]));
}

static void scr_fs_cb_stat_method(ScrDyn *object, const char *name, bool answer) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_BOOL);
  scr_box_set_bool(closure->caps[0], answer);
  scr_dyn_obj_set(object, name, strlen(name), scr_dyn_new_func(closure, scr_fs_cb_stat_test, 0, "native:fs.Stats", name));
}

static void scr_fs_cb_stat_number(ScrDyn *object, const char *name, int64_t number, bool bigint) {
  ScrDyn *value;
  if (bigint) {
    ScrBigInt *integer = scr_bigint_from_i64(number);
    value = scr_dyn_new_bigint(integer);
    scr_bigint_release(integer);
  } else value = scr_dyn_new_num((double)number);
  scr_dyn_obj_set(object, name, strlen(name), value);
}

static void scr_fs_cb_stat_date(ScrDyn *object, const char *name, double milliseconds) {
  ScrDyn *arguments = scr_dyn_new_arr();
  scr_dyn_arr_push(arguments, scr_dyn_new_num(milliseconds));
  ScrDyn *date = scr_dyn_native_date_new(arguments);
  scr_dyn_release(arguments);
  if (date) scr_dyn_obj_set(object, name, strlen(name), date);
}

static ScrDyn *scr_fs_cb_stats(const ScrStr *path, double fd, const ScrDyn *options, bool nofollow) {
  ScrStats *snapshot = !path ? scr_fs_fstat(fd) : nofollow ? scr_fs_lstat((ScrStr *)path) : scr_fs_stat((ScrStr *)path);
  if (!snapshot) return NULL;
  ScrDyn *object = scr_stats_dyn(snapshot, scr_fs_cb_option_bool(options, "bigint"));
  scr_stats_release(snapshot);
  return object;
}

#ifndef SCR_LIB
static void scr_fs_cb_fire(ScrClosure *closure) {
  ScrDyn *callback = scr_box_get_ref(closure->caps[0]);
  ScrDyn *arguments = scr_box_get_ref(closure->caps[1]);
  ScrDyn *result = scr_dyn_apply(callback, arguments, "the filesystem callback");
  scr_dyn_release(result); scr_dyn_release(callback); scr_dyn_release(arguments);
}
#endif

void scr_fs_cb_schedule(const ScrDyn *callback, ScrDyn *result, const ScrDyn *buffer) {
  ScrDyn *arguments = scr_dyn_new_arr();
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    ScrDyn *error = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    scr_dyn_arr_push(arguments, error);
    scr_dyn_release(result);
  } else {
    scr_dyn_arr_push(arguments, scr_dyn_new_null());
    if (result) scr_dyn_arr_push(arguments, result);
    if (buffer) scr_dyn_arr_push(arguments, scr_dyn_retain((ScrDyn *)buffer));
  }
#ifndef SCR_LIB
  ScrClosure *closure = scr_closure_new((void *)scr_fs_cb_fire, 2);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  closure->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_retain((ScrDyn *)callback));
  scr_box_set_ref(closure->caps[1], arguments);
  scr_loop_defer(closure);
#else
  (void)callback;
  scr_dyn_release(arguments);
  scr_throw_error_msg_code(SCR_ERR_ERROR, "Filesystem callbacks require an executable event loop", 52, "SC4005");
#endif
}

static bool scr_fs_read_validate(const ScrDyn *, const ScrDyn *, const ScrDyn *, const ScrDyn *, const ScrDyn *);
static bool scr_fs_encoding_chk(const ScrDyn *);
static bool scr_fs_int_range_chk(const ScrDyn *, const char *, double, double, const char *);
static bool scr_fs_length_int32(const ScrDyn *, double *);
static bool scr_fs_write_validate(const ScrDyn *, const ScrDyn *, const ScrDyn *);
static bool scr_fs_mode_chk(const ScrDyn *, const char *);

/* Where Node's signature handling finds the callback: a fixed position, or
 * an earlier optional argument it takes instead when that one is a
 * function. readFile, writeFile, appendFile, readv and writev use
 * `callback ||= <previous argument>`; open treats a two-argument call as
 * (path, callback); read and write follow their own argument forms. */
static size_t scr_fs_cb_slot(const char *op, ScrDyn *const *args, size_t argc) {
  static const struct {
    const char *op;
    unsigned char slot;
    unsigned char shift; /* 0: none */
  } table[] = {
    { "access", 2, 1 }, { "copyFile", 3, 2 }, { "chmod", 2, 0 }, { "chown", 3, 0 }, { "lchown", 3, 0 },
    { "fchown", 3, 0 }, { "mkdir", 2, 1 }, { "mkdtemp", 2, 1 }, { "rmdir", 2, 1 }, { "unlink", 1, 0 },
    { "close", 1, 0 }, { "fstat", 2, 1 }, { "ftruncate", 2, 1 }, { "fsync", 1, 0 }, { "fdatasync", 1, 0 },
    { "fchmod", 2, 0 }, { "realpath", 2, 1 }, { "rename", 2, 0 }, { "stat", 2, 1 }, { "lstat", 2, 1 },
    { "truncate", 2, 1 }, { "readdir", 2, 1 },
  };
#define SCR_FS_IS_FN(i) ((i) < argc && args[(i)]->kind == SCR_DYN_FUNC)
#define SCR_FS_TRUTHY(i) ((i) < argc && scr_dyn_truthy(args[(i)]))
  for (size_t i = 0; i < sizeof table / sizeof table[0]; i++) {
    if (strcmp(op, table[i].op)) continue;
    return table[i].shift && SCR_FS_IS_FN(table[i].shift) ? table[i].shift : table[i].slot;
  }
  if (!strcmp(op, "open")) return argc < 3 ? 1 : SCR_FS_IS_FN(2) ? 2 : 3;
  if (!strcmp(op, "readFile")) return SCR_FS_TRUTHY(2) ? 2 : 1;
  if (!strcmp(op, "writeFile") || !strcmp(op, "appendFile")) return SCR_FS_TRUTHY(3) ? 3 : 2;
  if (!strcmp(op, "readv") || !strcmp(op, "writev")) return SCR_FS_TRUTHY(3) ? 3 : 2;
  if (!strcmp(op, "read")) return argc <= 4 ? (argc > 1 ? argc - 1 : 1) : 5;
  if (!strcmp(op, "write")) {
    if (argc > 1 && args[1]->kind == SCR_DYN_STR) return SCR_FS_IS_FN(4) ? 4 : SCR_FS_IS_FN(2) ? 2 : 3;
    return SCR_FS_TRUTHY(5) ? 5 : SCR_FS_TRUTHY(4) ? 4 : SCR_FS_TRUTHY(3) ? 3 : 2;
  }
#undef SCR_FS_IS_FN
#undef SCR_FS_TRUTHY
  return argc ? argc - 1 : 0;
}

/* parseFileMode(value, name): an octal string or a uint32. */
static bool scr_fs_cb_file_mode(const ScrDyn *value, const char *name, double *mode) {
  if (!scr_fs_mode_chk(value, name)) return false;
  *mode = value->kind == SCR_DYN_STR ? (double)strtoul(value->v.str->data, NULL, 8) : value->v.num;
  return true;
}

/* mkdir's options: a function (the callback) or nothing means the
 * defaults, a number or string is the mode, and an object may carry a
 * boolean recursive and a mode. */
static bool scr_fs_cb_mkdir_options(const ScrDyn *options, double *mode, bool *recursive) {
  *mode = 0777;
  *recursive = false;
  if (options->kind == SCR_DYN_FUNC) return true;
  if (options->kind == SCR_DYN_NUM || options->kind == SCR_DYN_STR) return scr_fs_cb_file_mode(options, "mode", mode);
  if (!scr_dyn_truthy(options)) return true;
  ScrDyn *value = scr_fs_cb_option(options, "recursive");
  bool ok = true;
  if (value && value->kind != SCR_DYN_UNDEF) {
    if (value->kind == SCR_DYN_BOOL) *recursive = value->v.b;
    else {
      scr_dyn_arg_type_fail("options.recursive", "of type boolean", value);
      ok = false;
    }
  }
  scr_dyn_release(value);
  if (!ok) return false;
  value = scr_fs_cb_option(options, "mode");
  if (value && value->kind != SCR_DYN_UNDEF) ok = scr_fs_cb_file_mode(value, "options.mode", mode);
  scr_dyn_release(value);
  return ok;
}

/* validateInteger(uid, 'uid', -1, 2 ** 32 - 1), then gid. */
static bool scr_fs_cb_owner_ids(const ScrDyn *uid, const ScrDyn *gid) {
  return scr_fs_int_range_chk(uid, "uid", -1, 4294967295.0, ">= -1 && <= 4294967295") &&
         scr_fs_int_range_chk(gid, "gid", -1, 4294967295.0, ">= -1 && <= 4294967295");
}

/* The binding's access mode check: undefined and null mean F_OK, other
 * non-numbers throw ERR_INVALID_ARG_TYPE. */
static bool scr_fs_cb_access_mode(const ScrDyn *mode) {
  if (scr_fs_dyn_absent(mode)) return true;
  if (mode->kind != SCR_DYN_NUM) {
    static const char message[] = "mode must be int32 or null/undefined";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
    return false;
  }
  return scr_fs_access_mode_valid(mode->v.num);
}

static bool scr_fs_callback_times(const ScrDyn *atime, const ScrDyn *mtime, bool descriptor, double *access, double *modified) {
  *access = scr_fs_timestamp_value(atime, descriptor ? "atime" : "time");
  if (scr_exc_pending()) return false;
  *modified = scr_fs_timestamp_value(mtime, descriptor ? "mtime" : "time");
  return !scr_exc_pending();
}

static ScrArr *scr_fs_cb_vectors(const ScrDyn *buffers) {
  ScrDyn *snapshot = buffers->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(buffers)
    ? scr_dyn_typed_ref_materialize(buffers) : NULL;
  const ScrDyn *array = snapshot ? snapshot : buffers;
  if (array->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("buffers", "an instance of Array", buffers);
    scr_dyn_release(snapshot);
    return NULL;
  }
  ScrArr *out = scr_arr_new_ops(&scr_bytes_io_bytes_ops, array->v.arr.len);
  for (size_t i = 0; i < array->v.arr.len; i++) {
    const ScrDyn *buffer = array->v.arr.items[i];
    if (!scr_dyn_bytes_is(buffer, SCR_BYTES_U8)) {
      scr_dyn_arg_type_fail("buffers", "an Array of ArrayBufferView", buffers);
      scr_arr_release(out);
      scr_dyn_release(snapshot);
      return NULL;
    }
    /* push_ref consumes the reference produced by unbox. */
    scr_arr_push_ref(out, scr_dyn_bytes_unbox(buffer));
  }
  scr_dyn_release(snapshot);
  return out;
}

static ScrDyn *scr_fs_cb_invoke(ScrStr *member, ScrDyn *const *args, size_t argc) {
  const char *op = member->data;
  if (!strcmp(op, "cp")) {
    /* fs.cp(src, dest[, options], callback): makeCallback, then the option
     * and path validation (thrown), then the copy, whose error reaches the
     * callback as callbackify delivers it. */
    const ScrDyn *options = scr_fs_cb_arg(args, argc, 2);
    const ScrDyn *callback = scr_fs_cb_arg(args, argc, 3);
    if (options->kind == SCR_DYN_FUNC) {
      callback = options;
      options = scr_dyn_undefined();
    }
    if (!scr_fs_cb_chk(callback, "cb")) return NULL;
    ScrFsCp *job = scr_fs_cp_begin(scr_fs_cb_arg(args, argc, 0), scr_fs_cb_arg(args, argc, 1), options);
    if (!job) return NULL;
    scr_fs_cp_run(job, true);
    scr_fs_cp_free(job);
    scr_fs_cb_schedule(callback, scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined()), NULL);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (!strcmp(op, "statfs")) {
    const ScrDyn *options = scr_fs_cb_arg(args, argc, 1);
    const ScrDyn *callback = options->kind == SCR_DYN_FUNC ? options : scr_fs_cb_arg(args, argc, 2);
    if (!scr_fs_cb_chk(callback, "cb")) return NULL;
    ScrStr *path = scr_fs_checked_path(scr_fs_cb_arg(args, argc, 0), "path");
    if (!path) return NULL;
    if (options->kind == SCR_DYN_FUNC) options = scr_dyn_undefined();
    bool bigint = scr_fs_statfs_bigint(options);
    /* FSReqCallback captures the first read; binding.statfs reads it again. */
    if (!scr_exc_pending()) (void)scr_fs_statfs_bigint(options);
    if (scr_exc_pending()) { scr_str_release(path); return NULL; }
    ScrDyn *result = scr_fs_statfs(path, bigint);
    scr_str_release(path);
    scr_fs_cb_schedule(callback, result, NULL);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (!strcmp(op, "link") || !strcmp(op, "symlink") || !strcmp(op, "readlink")) {
    const ScrDyn *first = scr_fs_cb_arg(args, argc, 0);
    const ScrDyn *second = scr_fs_cb_arg(args, argc, 1);
    bool symbolic = !strcmp(op, "symlink"), reading = !strcmp(op, "readlink");
    const ScrDyn *third = scr_fs_cb_arg(args, argc, 2);
    const ScrDyn *fourth = scr_fs_cb_arg(args, argc, 3);
    const ScrDyn *callback = symbolic && fourth->kind != SCR_DYN_UNDEF ? fourth
      : reading && second->kind == SCR_DYN_FUNC ? second : third;
    int kind = -1;
    if (symbolic && fourth->kind != SCR_DYN_UNDEF) {
      kind = scr_fs_symlink_type(third);
      if (scr_exc_pending()) return NULL;
    } else if (!scr_fs_cb_chk(callback, "cb")) return NULL;
    ScrDyn *encoding = reading ? scr_fs_readlink_encoding(second) : NULL;
    if (reading && !encoding) return NULL;
    ScrStr *from = scr_fs_checked_path(first, symbolic ? "target" : reading ? "path" : "existingPath");
    if (!from) { scr_dyn_release(encoding); return NULL; }
    ScrStr *to = reading ? NULL : scr_fs_checked_path(second, symbolic ? "path" : "newPath");
    if ((!reading && !to) || (symbolic && fourth->kind != SCR_DYN_UNDEF && !scr_fs_cb_chk(callback, "cb"))) {
      scr_str_release(from); scr_str_release(to); scr_dyn_release(encoding); return NULL;
    }
#ifdef _WIN32
    if (symbolic) {
      if (kind == 2 && scr_dyn_bytes_is(second, SCR_BYTES_U8)) {
        scr_dyn_arg_type_fail("paths[0]", "of type string", second);
        scr_str_release(from); scr_str_release(to); return NULL;
      }
      // Callback inference passes validated paths directly to path.resolve;
      // Buffer paths fail that probe and fall back to a file link.
      if (kind == -1 && (scr_dyn_bytes_is(first, SCR_BYTES_U8) || scr_dyn_bytes_is(second, SCR_BYTES_U8))) kind = 0;
    }
#endif
    ScrDyn *result = NULL;
    if (reading) result = scr_fs_readlink_result(from, encoding);
    else if (symbolic) scr_fs_symlink(from, to, kind);
    else scr_fs_link(from, to);
    scr_str_release(from); scr_str_release(to); scr_dyn_release(encoding);
    scr_fs_cb_schedule(callback, result, NULL);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  bool vector = !strcmp(op, "readv") || !strcmp(op, "writev");
  bool timestamp = !strcmp(op, "utimes") || !strcmp(op, "lutimes") || !strcmp(op, "futimes");
  bool timestamp_fd = !strcmp(op, "futimes");
  double access = 0, modified = 0;
  // futimes converts times before checking the callback; path variants do
  // callback and path validation first. Validation failures throw immediately.
  if (timestamp_fd && !scr_fs_callback_times(scr_fs_cb_arg(args, argc, 1), scr_fs_cb_arg(args, argc, 2), true, &access, &modified)) return NULL;
  if (!strcmp(op, "fchown") && !scr_fs_cb_owner_ids(scr_fs_cb_arg(args, argc, 1), scr_fs_cb_arg(args, argc, 2))) return NULL;
  bool newControl = !strcmp(op, "fdatasync") || !strcmp(op, "fchmod") || !strcmp(op, "ftruncate");
  if (vector && !scr_fs_int_range_chk(scr_fs_cb_arg(args, argc, 0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  ScrArr *vectors = vector ? scr_fs_cb_vectors(scr_fs_cb_arg(args, argc, 1)) : NULL;
  if (vector && !vectors) return NULL;
  /* glob and rm keep the last argument as their callback. */
  bool legacy = !strcmp(op, "glob") || !strcmp(op, "rm");
  size_t slot = timestamp ? 3 : legacy ? (argc ? argc - 1 : 0) : scr_fs_cb_slot(op, args, argc);
  const ScrDyn *callback = scr_fs_cb_arg(args, argc, slot);
  /* These check their callback after the arguments Node validates first
   * (below); every other form checks it here, before its path. */
  bool late = !strcmp(op, "access") || !strcmp(op, "copyFile") || !strcmp(op, "chmod") || !strcmp(op, "open") ||
              !strcmp(op, "mkdir") || !strcmp(op, "fchmod") || !strcmp(op, "ftruncate") || !strcmp(op, "truncate") ||
              !strcmp(op, "read") || !strcmp(op, "write");
  if (!late && !scr_fs_cb_chk(callback, legacy ? "callback" : "cb")) { scr_arr_release(vectors); return NULL; }
  size_t count = timestamp ? argc : slot < argc ? slot : argc;
#define ARG(index) scr_fs_cb_arg(args, count, index)
  /* fchmod and ftruncate check their mode or len, then the callback; the
   * binding checks the fd last. */
  if (newControl) {
    const ScrDyn *value = ARG(1);
    if (strcmp(op, "fdatasync") && (strcmp(op, "ftruncate") || value->kind != SCR_DYN_UNDEF)) {
      bool chmod = !strcmp(op, "fchmod");
      if (chmod ? !scr_fs_mode_chk(value, "mode") : !scr_fs_int_range_chk(value, "len", -9007199254740991.0, 9007199254740991.0, ">= -9007199254740991 && <= 9007199254740991")) return NULL;
    }
    if (strcmp(op, "fdatasync") && !scr_fs_cb_chk(callback, "cb")) return NULL;
    if (!scr_fs_int_range_chk(ARG(0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  }
  if ((!strcmp(op, "fsync") || !strcmp(op, "fstat") || !strcmp(op, "close")) &&
      !scr_fs_int_range_chk(ARG(0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  double mkdir_mode = 0777;
  bool mkdir_recursive = false;
  if (!strcmp(op, "mkdir") && (!scr_fs_cb_mkdir_options(ARG(1), &mkdir_mode, &mkdir_recursive) || !scr_fs_cb_chk(callback, "cb"))) return NULL;
  if (!strcmp(op, "mkdtemp") && !scr_fs_encoding_chk(ARG(1))) return NULL;
  if (!strcmp(op, "readFile") && (!scr_fs_encoding_chk(ARG(1)) ||
                                  (ARG(1)->kind != SCR_DYN_STR && !scr_fs_cb_read_buffer_option(ARG(1))))) return NULL;
  /* read checks its fd and the buffer of the full form before the
   * callback, and offset, length and position after it. */
  if (!strcmp(op, "read")) {
    if (!scr_fs_int_range_chk(ARG(0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
    if (count == 2 || count == 3) {
      /* read(fd, params, cb) and read(fd, buffer, options, cb): Node's
       * validateObject, nullish allowed. */
      const ScrDyn *params = count == 3 ? ARG(2) : scr_dyn_bytes_is(ARG(1), SCR_BYTES_U8) ? NULL : ARG(1);
      bool object = !params || scr_fs_dyn_absent(params) ||
                    params->kind == SCR_DYN_OBJ || params->kind == SCR_DYN_BYTES ||
                    (params->kind == SCR_DYN_TYPED_REF && !scr_dyn_ref_is_array(params)) ||
                    (params->kind == SCR_DYN_PROXY && scr_dyn_is_object(params));
      if (!object) {
        scr_dyn_arg_type_fail("options", "of type object", params);
        return NULL;
      }
    }
    if (count >= 4 && ARG(1)->kind != SCR_DYN_BYTES) {
      scr_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", ARG(1));
      return NULL;
    }
    if (!scr_fs_cb_chk(callback, "cb")) return NULL;
  }
  if (!strcmp(op, "read") && count >= 4 && !scr_fs_read_validate(ARG(0), ARG(1), ARG(2), ARG(3), ARG(4))) return NULL;
  /* write checks its fd first, then the buffer form's callback, offset and
   * length (validateOffsetLengthWrite), or the string form's data and
   * callback. */
  if (!strcmp(op, "write")) {
    if (!scr_fs_int_range_chk(ARG(0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
    if (ARG(1)->kind == SCR_DYN_BYTES) {
      if (!scr_fs_cb_chk(callback, "cb") || !scr_fs_write_validate(ARG(1), ARG(2), ARG(3))) return NULL;
    } else {
      if (ARG(1)->kind != SCR_DYN_STR) {
        scr_dyn_arg_type_fail("buffer", "of type string or an instance of Buffer, TypedArray, or DataView",
                              ARG(1));
        return NULL;
      }
      if (!scr_fs_cb_chk(callback, "cb")) return NULL;
    }
  }
  bool descriptor = timestamp_fd || vector || newControl || !strcmp(op, "close") || !strcmp(op, "fstat") || !strcmp(op, "fsync") || !strcmp(op, "read") || !strcmp(op, "write") || !strcmp(op, "fchown");
  /* truncate checks len, then the callback, before the open its request
   * starts with. */
  if (!strcmp(op, "truncate") &&
      ((ARG(1)->kind != SCR_DYN_UNDEF &&
        !scr_fs_int_range_chk(ARG(1), "len", -9007199254740991.0, 9007199254740991.0, ">= -9007199254740991 && <= 9007199254740991")) ||
       !scr_fs_cb_chk(callback, "cb"))) return NULL;
  ScrStr *path = descriptor ? NULL : timestamp ? scr_fs_timestamp_path(ARG(0)) : scr_fs_cb_path(ARG(0), !strcmp(op, "mkdtemp") ? "prefix" : !strcmp(op, "copyFile") ? "src" : !strcmp(op, "rename") ? "oldPath" : "path");
  if (!descriptor && !path) return NULL;
  if (timestamp && !timestamp_fd && !scr_fs_callback_times(ARG(1), ARG(2), false, &access, &modified)) { scr_str_release(path); return NULL; }
  if ((timestamp_fd || !strcmp(op, "fchown")) && !scr_fs_int_range_chk(ARG(0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  double chmod_mode = 0, open_mode = 0666;
  bool checked = true;
  if (!strcmp(op, "copyFile")) checked = scr_fs_path_chk(ARG(1), "dest");
  else if (!strcmp(op, "chmod")) checked = scr_fs_cb_file_mode(ARG(1), "mode", &chmod_mode);
  else if (!strcmp(op, "open")) {
    checked = ARG(2)->kind == SCR_DYN_UNDEF || scr_fs_cb_file_mode(ARG(2), "mode", &open_mode);
    if (checked) checked = scr_fs_cb_open_flags(ARG(1));
  }
  if (checked && (!strcmp(op, "access") || !strcmp(op, "copyFile") || !strcmp(op, "chmod") || !strcmp(op, "open")))
    checked = scr_fs_cb_chk(callback, "cb");
  /* Node validates these before the request starts, so they throw at the
   * call. */
  if (!checked || ((!strcmp(op, "chown") || !strcmp(op, "lchown")) && !scr_fs_cb_owner_ids(ARG(1), ARG(2))) ||
      (!strcmp(op, "access") && !scr_fs_cb_access_mode(ARG(1)))) {
    scr_str_release(path);
    return NULL;
  }
  double fd = descriptor ? scr_fs_cb_number(ARG(0), "fd", -1) : -1;
  if (scr_exc_pending()) { scr_str_release(path); scr_arr_release(vectors); return NULL; }
  ScrDyn *result = NULL;
  const ScrDyn *buffer = NULL;
  if (!strcmp(op, "readFile")) {
    const ScrDyn *options = ARG(1);
    if (options->kind != SCR_DYN_STR && !scr_fs_cb_signal(options)) goto done;
    ScrDyn *encoding = options->kind == SCR_DYN_STR ? scr_dyn_retain((ScrDyn *)options) : scr_fs_cb_option(options, "encoding");
    ScrDyn *flag = options->kind == SCR_DYN_STR ? NULL : scr_fs_cb_option(options, "flag");
    bool reading_flag = !flag || flag->kind == SCR_DYN_UNDEF || flag->kind == SCR_DYN_NULL ||
                        (flag->kind == SCR_DYN_STR && flag->v.str->len == 1 && flag->v.str->data[0] == 'r');
    if (encoding && reading_flag) result = scr_fs_read_file_sync_dyn(path, encoding);
    else if (encoding) {
      /* Node opens the file with options.flag ('w+' truncates first), then
       * reads the whole descriptor. */
      double opened = scr_fs_cb_open(path, flag, 0666, "r");
      if (opened >= 0 && !scr_exc_pending()) {
        bool text = encoding->kind == SCR_DYN_STR && encoding->v.str->len > 0;
        if (text && scr_fs_str_is(encoding->v.str, "buffer")) {
          ScrBytes *bytes = scr_fs_read_fd_bytes(opened);
          ScrStr *content = bytes ? scr_bytes_to_str_checked(bytes, encoding->v.str) : NULL;
          scr_bytes_release(bytes);
          if (content) {
            result = scr_dyn_new_str(content);
            scr_str_release(content);
          }
        } else if (text) {
          ScrStr *content = scr_fs_read_fd_encoded(opened, encoding->v.str);
          if (content) {
            result = scr_dyn_new_str(content);
            scr_str_release(content);
          }
        } else {
          ScrBytes *content = scr_fs_read_fd_bytes(opened);
          if (content) {
            result = scr_dyn_new_buffer(content);
            scr_bytes_release(content);
          }
        }
        int saved = errno;
        close((int)opened);
        errno = saved;
      }
    }
    scr_dyn_release(flag);
    scr_dyn_release(encoding);
  } else if (!strcmp(op, "writeFile") || !strcmp(op, "appendFile")) {
    const ScrDyn *options = ARG(2);
    if (options->kind != SCR_DYN_STR && !scr_fs_cb_signal(options)) goto done;
    ScrDyn *encoding = options->kind == SCR_DYN_STR ? scr_dyn_retain((ScrDyn *)options) : scr_fs_cb_option(options, "encoding");
    ScrStr *codec = encoding && encoding->kind == SCR_DYN_STR ? scr_str_retain(encoding->v.str) : scr_str_new("utf8", 4);
    ScrBytes *data = encoding ? scr_buffer_from_dyn(ARG(1), codec) : NULL;
    scr_str_release(codec);
    scr_dyn_release(encoding);
    if (data) {
      ScrDyn *flag = scr_fs_cb_option(options->kind == SCR_DYN_STR ? scr_dyn_undefined() : options, "flag");
      double mode = scr_fs_cb_option_number(options->kind == SCR_DYN_STR ? scr_dyn_undefined() : options, "mode", 0666);
      double fd = flag ? scr_fs_cb_open(path, flag, mode, !strcmp(op, "appendFile") ? "a" : "w") : -1;
      scr_dyn_release(flag);
      if (fd >= 0) {
        size_t offset = 0;
        while (offset < data->len && !scr_exc_pending()) {
          double written = scr_fs_write_sync(fd, data, (double)offset, (double)(data->len - offset), -1);
          if (written <= 0) break;
          offset += (size_t)written;
        }
        int saved = errno;
        close((int)fd);
        errno = saved;
      }
      scr_bytes_release(data);
    }
  } else if (!strcmp(op, "access")) scr_fs_access(path, scr_fs_dyn_absent(ARG(1)) ? 0 : ARG(1)->v.num);
  else if (!strcmp(op, "mkdir")) {
    if (mkdir_recursive) {
      /* The callback receives the first directory created (undefined when
       * the path already existed). */
      ScrStr *first = scr_fs_mkdir_recursive_first(path, mkdir_mode);
      if (first && !scr_exc_pending()) result = scr_fs_cb_string(first);
      else if (first) scr_str_release(first);
    } else scr_fs_mkdir_mode(path, mkdir_mode);
  } else if (!strcmp(op, "mkdtemp")) result = scr_fs_cb_encoded_path(scr_fs_mkdtemp_async(path), ARG(1));
  else if (!strcmp(op, "rm")) scr_fs_rm_opts_retry(path, scr_fs_cb_option_bool(ARG(1), "recursive"), scr_fs_cb_option_bool(ARG(1), "force"), scr_fs_cb_option_number(ARG(1), "maxRetries", 0), scr_fs_cb_option_number(ARG(1), "retryDelay", 100));
  else if (!strcmp(op, "rmdir")) scr_fs_rmdir(path);
  else if (!strcmp(op, "unlink")) scr_fs_unlink(path);
  else if (!strcmp(op, "chmod")) scr_fs_chmod(path, chmod_mode);
  else if (!strcmp(op, "chown")) scr_fs_chown(path, ARG(1)->v.num, ARG(2)->v.num);
  else if (!strcmp(op, "lchown")) scr_fs_lchown(path, ARG(1)->v.num, ARG(2)->v.num);
  else if (!strcmp(op, "fchown")) scr_fs_fchown(fd, ARG(1)->v.num, ARG(2)->v.num);
  else if (!strcmp(op, "realpath")) result = scr_fs_cb_string(scr_fs_realpath(path));
  else if (!strcmp(op, "stat") || !strcmp(op, "lstat")) result = scr_fs_cb_stats(path, -1, ARG(1), !strcmp(op, "lstat"));
  else if (!strcmp(op, "fstat")) result = scr_fs_cb_stats(NULL, fd, ARG(1), false);
  else if (!strcmp(op, "close")) scr_fs_close(fd);
  else if (!strcmp(op, "fsync")) scr_fs_fsync(fd);
  else if (!strcmp(op, "fdatasync")) scr_fs_fdatasync(fd);
  else if (!strcmp(op, "fchmod")) scr_fs_fchmod(fd, ARG(1)->kind == SCR_DYN_STR ? (double)strtol(ARG(1)->v.str->data, NULL, 8) : ARG(1)->v.num);
  else if (vector) {
    double position = ARG(2)->kind == SCR_DYN_NUM ? ARG(2)->v.num : -1;
    result = scr_dyn_new_num(!strcmp(op, "readv") ? scr_fs_readv_sync(fd, vectors, position) : scr_fs_writev_sync(fd, vectors, position));
    scr_arr_release(vectors);
    buffer = ARG(1);
  }
  else if (!strcmp(op, "open")) {
    double opened = scr_fs_cb_open(path, ARG(1), open_mode, "r");
    if (!scr_exc_pending()) result = scr_dyn_new_num(opened);
  } else if (!strcmp(op, "glob")) {
    /* Direct fs.glob calls lower to scr_fs_glob_callback (scr_glob.c); a
     * stored fs.glob value is not supported. */
    const char *message = "fs.glob stored as a value has no native lowering; call fs.glob directly";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
  } else if (!strcmp(op, "write") && ARG(1)->kind == SCR_DYN_STR) {
    /* write(fd, string[, position[, encoding]], callback): a non-number
     * position writes at the current offset; the encoding defaults to
     * utf8 (unknown names write utf8, as the binding does). */
    const ScrDyn *string = ARG(1);
    const ScrDyn *position = count >= 3 ? ARG(2) : scr_dyn_undefined();
    const ScrDyn *encoding = count >= 4 ? ARG(3) : scr_dyn_undefined();
    ScrStr *codec = encoding->kind == SCR_DYN_STR && scr_bytes_is_encoding(encoding->v.str)
        ? scr_str_retain(encoding->v.str)
        : scr_str_new("utf8", 4);
    if (codec->len == 3 && memcmp(codec->data, "hex", 3) == 0 && string->v.str->len % 2 != 0) {
      /* validateEncoding throws at the call, before any write. */
      char reason[64];
      snprintf(reason, sizeof reason, "is invalid for data of length %zu", (size_t)string->v.str->len);
      scr_dyn_arg_value_fail("encoding", reason, encoding);
      scr_str_release(codec);
      return NULL;
    } else {
      ScrBytes *bytes = scr_buffer_from_dyn(string, codec);
      if (bytes) {
        double at = position->kind == SCR_DYN_NUM ? position->v.num : -1;
        result = scr_dyn_new_num(scr_fs_write_sync(fd, bytes, 0, (double)bytes->len, at));
        scr_bytes_release(bytes);
      }
    }
    scr_str_release(codec);
    buffer = string;
  } else if (!strcmp(op, "read") || !strcmp(op, "write")) {
    bool readOp = !strcmp(op, "read");
    const ScrDyn *options = ARG(1);
    ScrDyn *ownedBuffer = NULL;
    if (readOp && !scr_dyn_bytes_is(options, SCR_BYTES_U8)) {
      ownedBuffer = scr_fs_cb_option(options, "buffer");
      if (ownedBuffer && ownedBuffer->kind == SCR_DYN_UNDEF) {
        /* read(fd, cb) and read(fd, { buffer: undefined }, cb) read into
         * a fresh 16384-byte Buffer. */
        scr_dyn_release(ownedBuffer);
        ScrBytes *fresh = scr_bytes_new(SCR_BYTES_U8, 16384);
        ownedBuffer = scr_dyn_new_buffer(fresh);
        scr_bytes_release(fresh);
      }
      buffer = ownedBuffer;
    } else if (readOp && count == 3 && ARG(2)->kind != SCR_DYN_NUM && !scr_fs_dyn_absent(ARG(2))) {
      /* read(fd, buffer, { offset, length, position }, cb) */
      ownedBuffer = scr_dyn_retain((ScrDyn *)options);
      options = ARG(2);
      buffer = ownedBuffer;
    } else buffer = options;
    ScrBytes *bytes = buffer && buffer->kind == SCR_DYN_BYTES ? scr_dyn_bytes_unbox(buffer) : NULL;
    if (!bytes) {
      /* The argument check throws at the call (Node validates before the
       * request is made). */
      scr_dyn_arg_type_fail("buffer",
                            readOp ? "an instance of Buffer, TypedArray, or DataView"
                                   : "of type string or an instance of Buffer, TypedArray, or DataView",
                            buffer ? buffer : scr_dyn_undefined());
      scr_dyn_release(ownedBuffer);
      return NULL;
    } else {
      double offset = ownedBuffer ? scr_fs_cb_option_number(options, "offset", 0) : scr_fs_cb_number(ARG(2), "offset", 0);
      double length = bytes->len - offset;
      if (ownedBuffer) length = scr_fs_cb_option_number(options, "length", length);
      else if (readOp && count >= 4) scr_fs_length_int32(ARG(3), &length);
      else length = scr_fs_cb_number(ARG(3), "length", length);
      double position = ownedBuffer ? scr_fs_cb_option_number(options, "position", -1) : scr_fs_cb_number(ARG(4), "position", -1);
      if (!scr_exc_pending()) result = scr_dyn_new_num(readOp ? scr_fs_read_sync(fd, bytes, offset, length, position) : scr_fs_write_sync(fd, bytes, offset, length, position));
    }
    scr_bytes_release(bytes);
    /* The completion retains the original buffer, including options.buffer. */
    if (ownedBuffer) {
      scr_fs_cb_schedule(callback, result, ownedBuffer);
      scr_dyn_release(ownedBuffer); scr_str_release(path);
      return scr_dyn_retain(scr_dyn_undefined());
    }
  } else if (!strcmp(op, "copyFile") || !strcmp(op, "rename")) {
    ScrStr *destination = scr_fs_cb_path(ARG(1), !strcmp(op, "rename") ? "newPath" : "dest");
    if (destination) {
      if (!strcmp(op, "rename")) scr_fs_rename(path, destination);
      else if (!strcmp(op, "copyFile")) {
        double flags = scr_fs_cb_number(ARG(2), "mode", 0);
        if (flags == 1 && scr_fs_exists(destination)) scr_fs_throw(EEXIST, "copyfile", destination);
        else if (flags != 0 && flags != 1) {
          static const char message[] = "fs.copyFile clone flags have no native lowering";
          scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
        } else if (!scr_exc_pending()) scr_fs_copyfile(path, destination);
      }
      scr_str_release(destination);
    }
  } else if (!strcmp(op, "truncate") || !strcmp(op, "ftruncate")) {
    double length = scr_fs_cb_number(ARG(1), "len", 0);
    if (!scr_exc_pending()) {
      /* truncate opens the path with 'r+' first, so a missing file
       * reports open. */
      if (descriptor) scr_fs_ftruncate(fd, length);
      else scr_fs_truncate(path, length);
    }
  } else if (timestamp) {
    if (timestamp_fd) scr_fs_futimes(fd, access, modified);
    else scr_fs_utimes(path, access, modified, !strcmp(op, "lutimes"));
  } else if (!strcmp(op, "readdir")) {
    if (scr_fs_cb_refuse_option(ARG(1), "encoding") || scr_fs_cb_option_bool(ARG(1), "withFileTypes") || scr_fs_cb_option_bool(ARG(1), "recursive")) {
      if (!scr_exc_pending()) { const char *message = "Recursive readdir and Dirent results have no native lowering"; scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020"); }
      goto done;
    }
    ScrArr *names = scr_fs_readdir(path);
    if (names) {
      result = scr_dyn_new_arr();
      for (size_t i = 0; i < (size_t)scr_arr_len(names); i++) scr_dyn_arr_push(result, scr_fs_cb_string(scr_arr_get_ref(names, (double)i)));
      scr_arr_release(names);
    }
  } else {
    char message[160];
    int length = snprintf(message, sizeof message, "Native filesystem callback fs.%s with these options has no lowering", op);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)length, "SC2020");
  }
#undef ARG
done:
  scr_str_release(path);
  scr_fs_cb_schedule(callback, result, buffer);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_fs_cb_value_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStr *member = scr_box_get_ref(closure->caps[0]);
  ScrDyn *result = scr_fs_cb_invoke(member, args, argc);
  scr_str_release(member);
  return result;
}

ScrDyn *scr_fs_callback_value(ScrStr *member) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(closure->caps[0], scr_str_retain(member));
  return scr_dyn_new_func(closure, scr_fs_cb_value_call, 0, "native:fs.callback", "filesystemCallback");
}

ScrDyn *scr_fs_callback_call(ScrStr *member, const ScrDyn *args) {
  return scr_fs_cb_invoke(member, args->v.arr.items, args->v.arr.len);
}

/* ── crypto.randomBytes → a real Buffer ────────────────────────────────── */

ScrBytes *scr_crypto_random_bytes(double n) {
  if (!(n >= 0 && n <= 2147483647)) {
    char num[32];
    size_t numlen = scr_f64_to_str(n, num);
    char msg[128];
    int mlen = snprintf(
        msg, sizeof msg,
        "The value of \"size\" is out of range. It must be >= 0 && <= 2147483647. Received %.*s",
        (int)numlen, num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, n);
  if (b->len > 0) arc4random_buf(b->data, b->len);
  return b;
}

/* ── process.stdout/stderr.write(buf) ──────────────────────────────────── */

bool scr_process_stdout_write_bytes(const ScrBytes *b, const ScrStr *encoding) {
  SCR_BYTES_SNAPSHOT(b);
  (void)encoding;
  return scr_stdio_write(1, b->data, b->len * scr_bytes_elem_size(b->elem));
}

bool scr_process_stderr_write_bytes(const ScrBytes *b, const ScrStr *encoding) {
  SCR_BYTES_SNAPSHOT(b);
  (void)encoding;
  return scr_stdio_write(2, b->data, b->len * scr_bytes_elem_size(b->elem));
}

/* Buffer.from over checked-native input. Strings use the existing codec;
 * bytes, arrays and data-only array-like/Buffer-JSON objects always COPY.
 * A dyn is not an arbitrary JS object: opaque references and custom input
 * valueOf hooks throw the 'not supported yet' Error rather than skipping hooks. */
static ScrBytes *scr_buffer_from_refusal(const char *detail) {
  char msg[192];
  int n = snprintf(msg, sizeof msg, "Buffer.from %s is not supported yet", detail);
  scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
  return NULL;
}

static ScrBytes *scr_buffer_from_array_like(const ScrDyn *value, double length) {
  if (!(length > 0)) return scr_bytes_new(SCR_BYTES_U8, 0);
  if (!isfinite(length) || length >= 9007199254740991.0 || length >= (double)SIZE_MAX) {
    static const char msg[] = "Array buffer allocation failed";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, floor(length));
  if (!out) return NULL;
  for (size_t i = 0; i < out->len; i++) {
    ScrDyn *item;
    if (value->kind == SCR_DYN_ARR) {
      item = i < value->v.arr.len ? value->v.arr.items[i] : NULL;
    } else {
      char key[32];
      int n = snprintf(key, sizeof key, "%zu", i);
      item = scr_dyn_obj_get(value, key, (size_t)n);
    }
    /* Coercion may run user code that removes or replaces this element. */
    item = scr_dyn_retain(item ? item : scr_dyn_undefined());
    double number;
    bool ok = scr_dyn_number_coerce_js(item, &number);
    scr_dyn_release(item);
    if (!ok) {
      scr_bytes_release(out);
      return NULL;
    }
    out->data[i] = (uint8_t)scr_to_uint32(number);
  }
  return out;
}

/* Buffer.concat over an untyped list: Node's checks in Node's order (an
 * Array, then the total of the two-argument form unless the list is empty,
 * then every element a Uint8Array, ERR_INVALID_ARG_TYPE otherwise), then the
 * typed concat over the elements. NULL with the exception pending. */
static ScrBytes *scr_buffer_concat_dyn_impl(const ScrDyn *list, double total, bool has_total) {
  ScrDyn *materialized = NULL;
  if (list->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(list) != NULL) {
    materialized = scr_dyn_typed_ref_materialize(list);
    list = materialized;
  }
  if (list->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("list", "an instance of Array", list);
    scr_dyn_release(materialized);
    return NULL;
  }
  size_t n = list->v.arr.len;
  if (has_total && n > 0 && !scr_bytes_validate_off("length", total, 9007199254740991.0)) {
    scr_dyn_release(materialized);
    return NULL;
  }
  ScrArr *parts = scr_arr_new(SCR_ELEM_BYTES, (double)n);
  for (size_t i = 0; i < n; i++) {
    ScrDyn *item = scr_dyn_index_get(list, (double)i);
    const ScrDyn *shown = item != NULL ? item : scr_dyn_undefined();
    if (!scr_dyn_bytes_is(shown, SCR_BYTES_U8) || shown->v.bytes->is_data_view) {
      char name[40];
      snprintf(name, sizeof name, "list[%zu]", i);
      scr_dyn_arg_type_fail(name, "an instance of Buffer or Uint8Array", shown);
      scr_dyn_release(item);
      scr_arr_release(parts);
      scr_dyn_release(materialized);
      return NULL;
    }
    scr_arr_push_ref(parts, scr_bytes_retain(shown->v.bytes));
    scr_dyn_release(item);
  }
  ScrBytes *out = has_total ? scr_buffer_concat_len(parts, total) : scr_buffer_concat(parts);
  scr_arr_release(parts);
  scr_dyn_release(materialized);
  return out;
}

ScrBytes *scr_buffer_concat_dyn(const ScrDyn *list) {
  return scr_buffer_concat_dyn_impl(list, 0, false);
}

ScrBytes *scr_buffer_concat_len_dyn(const ScrDyn *list, double total) {
  return scr_buffer_concat_dyn_impl(list, total, true);
}

/* Buffer.from(arrayBuffer, byteOffset, length) over a checked ArrayBuffer
 * or SharedArrayBuffer, as Node's fromArrayBuffer: a Buffer that shares its
 * memory. The offset converts with ToNumber, where a missing offset (NULL)
 * or undefined and NaN are 0; an offset past the end throws
 * ERR_BUFFER_OUT_OF_BOUNDS, and one at or below -1 V8's start-offset
 * RangeError. A missing length runs to the end; a given one converts with
 * ToNumber, past the end throws ERR_BUFFER_OUT_OF_BOUNDS for "length", and
 * zero, negative and NaN lengths are 0. NULL with the exception pending. */
static ScrBytes *scr_buffer_from_storage(const ScrDyn *storage, const ScrDyn *offset_value,
                                         const ScrDyn *length_value) {
  double offset = 0;
  if (offset_value && offset_value->kind != SCR_DYN_UNDEF) {
    if (!scr_dyn_number_coerce_js(offset_value, &offset)) return NULL;
    if (isnan(offset)) offset = 0;
  }
  ScrBytes *bytes = storage->v.handle.ptr;
  ScrBytes *owner = bytes->backing ? bytes->backing : bytes;
  double max_length = (double)scr_bytes_byte_len(owner) - offset;
  if (max_length < 0) {
    static const char msg[] = "\"offset\" is outside of buffer bounds";
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, sizeof msg - 1, "ERR_BUFFER_OUT_OF_BOUNDS");
    return NULL;
  }
  bool has_length = length_value && length_value->kind != SCR_DYN_UNDEF;
  double length = max_length;
  if (has_length) {
    if (!scr_dyn_number_coerce_js(length_value, &length)) return NULL;
    if (length > 0) {
      if (length > max_length) {
        static const char msg[] = "\"length\" is outside of buffer bounds";
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, sizeof msg - 1, "ERR_BUFFER_OUT_OF_BOUNDS");
        return NULL;
      }
    } else {
      length = 0;
    }
  }
  double start = trunc(offset);
  if (start < 0) {
    /* The offset as JavaScript prints it (-1.5, -1e+21, -Infinity). */
    ScrStr *parts[3] = {
        scr_str_new("Start offset ", 13),
        scr_f64_to_scrstr(offset),
        scr_str_new(" is outside the bounds of the buffer", 36),
    };
    ScrStr *message = scr_str_concat_parts(parts, 3);
    for (size_t i = 0; i < 3; i++) scr_str_release(parts[i]);
    scr_throw_error(SCR_ERR_RANGE, message);
    return NULL;
  }
  ScrBytes *out = scr_bytes_buffer_view(bytes, SCR_BYTES_U8, start, has_length, trunc(length));
  if (out) out->is_buffer = true;
  return out;
}

ScrBytes *scr_buffer_from_dyn(const ScrDyn *value, const ScrStr *encoding) {
  if (value->kind == SCR_DYN_STR) return scr_bytes_from_str(value->v.str, encoding);
  /* The second argument here is an encoding name, which as a byte offset
   * converts to NaN: offset 0. */
  if (scr_buffer_storage_is(value)) return scr_buffer_from_storage(value, NULL, NULL);
  if (value->kind == SCR_DYN_BYTES) return scr_bytes_convert(SCR_BYTES_U8, value->v.bytes);
  if (value->kind == SCR_DYN_ARR) {
    return scr_buffer_from_array_like(value, (double)value->v.arr.len);
  }
  if (value->kind == SCR_DYN_OBJ) {
    const ScrDyn *hook = scr_dyn_obj_get(value, "valueOf", 7);
    if (hook && scr_dyn_truthy(hook)) {
      return scr_buffer_from_refusal("with a custom valueOf");
    }
    const ScrDyn *length = scr_dyn_obj_get(value, "length", 6);
    if (length && length->kind != SCR_DYN_UNDEF) {
      return scr_buffer_from_array_like(value, length->kind == SCR_DYN_NUM ? length->v.num : 0);
    }
    const ScrDyn *type = scr_dyn_obj_get(value, "type", 4);
    const ScrDyn *data = scr_dyn_obj_get(value, "data", 4);
    if (type && type->kind == SCR_DYN_STR && type->v.str->len == 6 &&
        memcmp(type->v.str->data, "Buffer", 6) == 0 && data && data->kind == SCR_DYN_ARR) {
      /* Element coercion may mutate the parent and replace `data`. */
      ScrDyn *held = scr_dyn_retain((ScrDyn *)data);
      ScrBytes *out = scr_buffer_from_array_like(held, (double)held->v.arr.len);
      scr_dyn_release(held);
      return out;
    }
  }
  if (value->kind == SCR_DYN_TYPED_REF || value->kind == SCR_DYN_HANDLE) {
    return scr_buffer_from_refusal("with an opaque reference");
  }
  char detail[64];
  const char *received = scr_dyn_specific_type(value, detail, sizeof detail);
  char msg[256];
  int n = snprintf(msg, sizeof msg,
      "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received %s",
      received);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_ARG_TYPE");
  return NULL;
}

/* Buffer.from over a checked value, with Node's pooling: strings take
 * fromStringFast, typed arrays and array-likes fromArrayLike. */
ScrBytes *scr_buffer_from_dyn_pooled(const ScrDyn *value, const ScrStr *encoding) {
  if (value->kind == SCR_DYN_STR) return scr_buffer_from_str(value->v.str, encoding);
  if (value->kind == SCR_DYN_BYTES && !value->v.bytes->is_data_view)
    return scr_buffer_from_bytes(value->v.bytes);
  /* A view of an ArrayBuffer shares its memory, so it never comes from the
   * pool. The second argument here is an encoding name: offset 0. */
  if (scr_buffer_storage_is(value)) return scr_buffer_from_storage(value, NULL, NULL);
  ScrBytes *out = scr_buffer_from_dyn(value, encoding);
  if (!out) return NULL;
  out->is_buffer = true;
  return scr_buffer_pool_adopt(out);
}

/* scr_buffer_from_dyn_pooled for values that can be a typed array crossing
 * an untyped slot by reference (a number[] passed to an untyped parameter,
 * as yazl's Buffer.from(something, encoding) receives it): the array copies
 * like the array it is. Used by the runtime-encoding Buffer.from forms. */
ScrBytes *scr_buffer_from_dyn_ref_pooled(const ScrDyn *value, const ScrStr *encoding) {
  if (value->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(value) != NULL) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(value);
    if (scr_exc_pending()) {
      scr_dyn_release(materialized);
      return NULL;
    }
    ScrBytes *out = scr_buffer_from_dyn_pooled(materialized, encoding);
    scr_dyn_release(materialized);
    return out;
  }
  return scr_buffer_from_dyn_pooled(value, encoding);
}

/* Buffer.from(value, second) over checked values whose second argument is
 * not a literal encoding name: an ArrayBuffer or SharedArrayBuffer takes it
 * as the byte offset (scr_buffer_from_storage); a string takes it as the
 * encoding (Node's fromString: utf8 unless it is a non-empty string, which
 * must name a Buffer encoding or throw ERR_UNKNOWN_ENCODING); other values
 * convert as scr_buffer_from_dyn_ref_pooled with utf8. */
ScrBytes *scr_buffer_from_dyn_offset_pooled(const ScrDyn *value, const ScrDyn *second) {
  if (value->kind == SCR_DYN_STR) {
    if (second->kind == SCR_DYN_STR && second->v.str->len > 0)
      return scr_buffer_from_str_checked(value->v.str, second->v.str);
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *out = scr_buffer_from_str(value->v.str, utf8);
    scr_str_release(utf8);
    return out;
  }
  if (!scr_buffer_storage_is(value)) {
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *out = scr_buffer_from_dyn_ref_pooled(value, utf8);
    scr_str_release(utf8);
    return out;
  }
  return scr_buffer_from_storage(value, second, NULL);
}

/* Buffer.from(value, second, third): an ArrayBuffer or SharedArrayBuffer
 * takes them as its byte offset and length; other values convert as
 * scr_buffer_from_dyn_offset_pooled does, without the third argument. */
ScrBytes *scr_buffer_from_dyn_range_pooled(const ScrDyn *value, const ScrDyn *second,
                                           const ScrDyn *third) {
  if (!scr_buffer_storage_is(value)) return scr_buffer_from_dyn_offset_pooled(value, second);
  return scr_buffer_from_storage(value, second, third);
}

/* The deprecated Buffer constructor's DEP0005 state, Node's
 * bufferWarningAlreadyEmitted and nodeModulesCheckCounter: a call from
 * node_modules only counts toward the 10000-call check, and
 * scr_buffer_deprecation (scr_async_dyn.c) reports for the others. */
SCR_TL bool scr_buffer_ctor_warned = false;
SCR_TL uint64_t scr_buffer_ctor_checks = 0;

void scr_buffer_deprecation_count(void) {
  if (!scr_buffer_ctor_warned) scr_buffer_ctor_checks++;
}

/* new Buffer(number, encoding) — the deprecated ctor's string arm with a
 * non-string first argument: Node's exact ERR_INVALID_ARG_TYPE, thrown
 * after scr_buffer_deprecation has reported DEP0005. */
ScrBytes *scr_buffer_new_string_fail(const ScrDyn *got) {
  scr_dyn_arg_type_fail("string", "of type string", got);
  return NULL;
}

/* fs._toUnixTimestamp — the seconds coercion the utimes family runs on
 * its time arguments (fs.js's toUnixTimestamp, underscore-exported):
 * numeric STRINGS pass ToNumber's loose-equality gate (+time == time —
 * whitespace-only strings answer 0), finite numbers pass (negatives
 * answer now/1000, Node's "past times" shape), Dates supply milliseconds,
 * and everything else throws
 * Node's exact ERR_INVALID_ARG_TYPE. Borrowed; the throw is pending on
 * the dummy 0 return. */
double scr_fs_timestamp_value(const ScrDyn *t, const char *name) {
  if (t->kind == SCR_DYN_STR) {
    double n = scr_string_to_number(t->v.str);
    /* +time == time: NaN fails; every parsed number loosely equals its
     * own source string by construction of ToNumber. */
    if (n == n) return n;
  }
  if (t->kind == SCR_DYN_NUM && isfinite(t->v.num)) {
    if (t->v.num < 0) {
      struct timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      return ((double)ts.tv_sec * 1000.0 + (double)(ts.tv_nsec / 1000000)) / 1000.0;
    }
    return t->v.num;
  }
  if (scr_dyn_native_date_is(t)) return scr_dyn_native_date_value(t) / 1000.0;
  scr_dyn_arg_type_fail(name, "an instance of Date or an Time in seconds", t);
  return 0;
}

double scr_fs_to_unix_timestamp(const ScrDyn *t) {
  return scr_fs_timestamp_value(t, "time");
}

static void scr_fs_path_times_checked(const ScrDyn *input, const ScrDyn *atime, const ScrDyn *mtime, bool nofollow) {
  ScrStr *path = scr_fs_timestamp_path(input);
  if (!path) return;
  double access, modified;
  if (scr_fs_callback_times(atime, mtime, false, &access, &modified)) scr_fs_utimes(path, access, modified, nofollow);
  scr_str_release(path);
}

void scr_fs_utimes_checked(const ScrDyn *path, const ScrDyn *atime, const ScrDyn *mtime) {
  scr_fs_path_times_checked(path, atime, mtime, false);
}

void scr_fs_lutimes_checked(const ScrDyn *path, const ScrDyn *atime, const ScrDyn *mtime) {
  scr_fs_path_times_checked(path, atime, mtime, true);
}

void scr_fs_futimes_checked(const ScrDyn *fd, const ScrDyn *atime, const ScrDyn *mtime) {
  double access, modified;
  if (!scr_fs_callback_times(atime, mtime, true, &access, &modified)) return;
  if (scr_fs_int_range_chk(fd, "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) scr_fs_futimes(fd->v.num, access, modified);
}

/* ── the fs argument-validation ladders (checked-dynamic lane) ─────────
 * Each fs.*Chk libCall replicates its API's Node-order validation over
 * dyn values and throws Node's exact typed errors; when every validation
 * passes, the honest tail runs — the real operation where one exists
 * (mkdtempSync, lchmodSync on macOS), the compiler-rendered SC2020 fence
 * otherwise (scr_throw_lowering_fence). All arguments borrowed. */

static bool scr_fs_dyn_absent(const ScrDyn *v) {
  return v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL;
}

static bool scr_fs_str_is(const ScrStr *s, const char *lit) {
  size_t n = strlen(lit);
  return s->len == n && memcmp(s->data, lit, n) == 0;
}

/* Node's maybeCallback/validateFunction over a callback slot. */
static bool scr_fs_cb_chk(const ScrDyn *cb, const char *name) {
  if (cb->kind == SCR_DYN_FUNC) return true;
  scr_dyn_arg_type_fail(name, "of type function", cb);
  return false;
}

/* getValidatedPath: strings and Buffers pass (URL instances never reach
 * these ladders — the checked-dynamic tree has no URL kind here, and Node would accept
 * only file: URLs anyway). */
static bool scr_fs_path_chk(const ScrDyn *p, const char *name) {
  if (p->kind == SCR_DYN_STR || scr_dyn_bytes_is(p, SCR_BYTES_U8)) return true;
  scr_dyn_arg_type_fail(name, "of type string or an instance of Buffer or URL", p);
  return false;
}

/* An encoding that leaves getOptions' utf8 default: absent, falsy, or a
 * utf8 spelling. */
static bool scr_fs_utf8_encoding(const ScrDyn *enc) {
  if (scr_fs_dyn_absent(enc) || !scr_dyn_truthy(enc)) return true;
  return enc->kind == SCR_DYN_STR && (scr_fs_str_is(enc->v.str, "utf8") || scr_fs_str_is(enc->v.str, "utf-8"));
}

/* getOptions: null, undefined and functions take the defaults; a string
 * is the encoding; any other non-object throws ERR_INVALID_ARG_TYPE. The
 * encoding (the string, or an object's `encoding` member) then goes
 * through assertEncoding unless it is 'buffer': Node throws
 * ERR_INVALID_ARG_VALUE for any truthy value Buffer.isEncoding rejects. */
static bool scr_fs_encoding_chk(const ScrDyn *opts) {
  if (opts->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(opts);
    bool valid = view && !scr_exc_pending() && scr_fs_encoding_chk(view);
    scr_dyn_release(view);
    return valid;
  }
  if (scr_fs_dyn_absent(opts) || opts->kind == SCR_DYN_FUNC) return true;
  if (opts->kind == SCR_DYN_NUM || opts->kind == SCR_DYN_BOOL || opts->kind == SCR_DYN_BIGINT ||
      opts->kind == SCR_DYN_SYMBOL) {
    scr_dyn_arg_type_fail("options", "one of type string or object", opts);
    return false;
  }
  const ScrDyn *enc = opts;
  if (opts->kind != SCR_DYN_STR) {
    enc = opts->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(opts, "encoding", 8) : NULL;
    if (enc == NULL) return true;
  }
  if (scr_fs_dyn_absent(enc)) return true;
  if (enc->kind == SCR_DYN_STR) {
    if (enc->v.str->len == 0) return true; /* falsy: assertEncoding's `encoding &&` gate */
    if (scr_bytes_is_encoding(enc->v.str) || scr_fs_str_is(enc->v.str, "buffer")) return true;
  }
  if (enc->kind == SCR_DYN_BOOL && !enc->v.b) return true;
  if (enc->kind == SCR_DYN_NUM && (enc->v.num == 0 || enc->v.num != enc->v.num)) return true; /* 0, NaN */
  scr_dyn_arg_value_fail("encoding", "is invalid encoding", enc);
  return false;
}

/* parseFileMode: integers 0..2^32-1 pass, octal strings parse, and the
 * rest throw Node's exact ladder (validateUint32's wording). */
static bool scr_fs_mode_chk(const ScrDyn *m, const char *name) {
  if (m->kind == SCR_DYN_STR) {
    const ScrStr *s = m->v.str;
    bool octal = s->len > 0;
    for (size_t i = 0; octal && i < s->len; i++) {
      if (s->data[i] < '0' || s->data[i] > '7') octal = false;
    }
    if (octal) return true;
    scr_dyn_arg_value_fail(name, "must be a 32-bit unsigned integer or an octal string", m);
    return false;
  }
  if (m->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", m);
    return false;
  }
  double v = m->v.num;
  if (!(isfinite(v) && trunc(v) == v)) {
    char recv[48], msg[160];
    scr_num_received(v, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be an integer. Received %s",
                       name, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (v < 0 || v > 4294967295.0) {
    char recv[48], msg[160];
    scr_num_received(v, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be >= 0 && <= 4294967295. Received %s",
                       name, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

/* fs.exists(path, cb) — the REAL deprecated-API shape: the callback
 * validates synchronously (Node's one throwing arm), and the answer
 * arrives asynchronously through it — string/Buffer paths run the
 * existsSync probe at fire time, every other path kind answers `false`
 * (Node swallows getValidatedPath failures there). The loop-held timer
 * matches Node's I/O-completion timing closely enough for the
 * sequential CLI corpus. */
#ifndef SCR_LIB
static void scr_fs_exists_fire(ScrClosure *self) {
  ScrDyn *path = scr_box_get_ref(self->caps[0]); /* +1 */
  ScrDyn *cb = scr_box_get_ref(self->caps[1]);   /* +1 */
  bool ans = false;
  if (path->kind == SCR_DYN_STR) {
    ScrStr *p = scr_str_retain(path->v.str);
    ans = scr_fs_exists(p);
    scr_str_release(p);
  } else if (scr_dyn_bytes_is(path, SCR_BYTES_U8)) {
    ScrStr *p = scr_bytes_string(path->v.bytes, 0, path->v.bytes->len);
    ans = scr_fs_exists(p);
    scr_str_release(p);
  }
  ScrDyn *arg = scr_dyn_new_bool(ans);
  ScrDyn *r = scr_dyn_call(cb, &arg, 1, "the fs.exists callback");
  scr_dyn_release(arg);
  scr_dyn_release(r);
  scr_dyn_release(path);
  scr_dyn_release(cb);
}
#endif

ScrDyn *scr_fs_exists_async(const ScrDyn *path, const ScrDyn *cb) {
  if (!scr_fs_cb_chk(cb, "cb")) return NULL;
  if (path->kind != SCR_DYN_STR && !scr_dyn_bytes_is(path, SCR_BYTES_U8)) {
    /* Node's wart, kept exactly: a path getValidatedPath rejects answers
     * false through the callback SYNCHRONOUSLY (`return callback(false)`
     * in lib/fs.js exists). */
    ScrDyn *arg = scr_dyn_new_bool(false);
    ScrDyn *r = scr_dyn_call(cb, &arg, 1, "the fs.exists callback");
    scr_dyn_release(arg);
    scr_dyn_release(r);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }
#ifdef SCR_LIB
  /* Library links exclude the event-loop unit, and the compile-time scan
   * refuses the fs.exists surface (SC4005's family) — this arm exists
   * only so the TU links without scr_async. Unreachable by construction. */
  scr_trap("scriptc: internal error: fs.exists async fire reached in a library build — please report this");
  return NULL;
#else
  ScrClosure *clo = scr_closure_new((void *)scr_fs_exists_fire, 2);
  clo->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[0], scr_dyn_retain((ScrDyn *)path));
  clo->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[1], scr_dyn_retain((ScrDyn *)cb));
  scr_loop_defer(clo);
  return scr_dyn_retain(scr_dyn_undefined());
#endif
}

/* fs.mkdtemp(prefix, options?, cb): callback first (makeCallback), then
 * the prefix (getValidatedPath's 'prefix' slot); the async op fences. */
void scr_fs_mkdtemp_chk(const ScrDyn *prefix, const ScrDyn *cb, const ScrStr *fence) {
  if (!scr_fs_cb_chk(cb, "cb")) return;
  if (!scr_fs_path_chk(prefix, "prefix")) return;
  scr_throw_lowering_fence(fence);
}

/* fs.mkdtempSync(prefix, options?): prefix validates (Node's 'prefix'
 * slot), the options walk accepts only shapes that leave utf8 semantics
 * (absent/empty records, utf8 spellings — invalid encodings throw the
 * assertEncoding ladder, other effectful options fence), then the REAL
 * mkdtemp runs. +1 result or NULL with the exception pending. */
ScrStr *scr_fs_mkdtemp_sync_chk(const ScrDyn *prefix, const ScrDyn *opts, const ScrStr *fence) {
  if (!scr_fs_path_chk(prefix, "prefix")) return NULL;
  if (!scr_fs_encoding_chk(opts)) return NULL;
  bool utf8 = true;
  if (opts->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < opts->v.obj.len; i++) {
      const ScrDynEntry *e = &opts->v.obj.entries[i];
      if (scr_fs_dyn_absent(e->value)) continue;
      if (strcmp(e->key, "encoding") == 0) {
        if (!scr_fs_utf8_encoding(e->value)) utf8 = false;
        continue;
      }
      utf8 = false; /* an unmodeled effectful option */
    }
  } else if (opts->kind != SCR_DYN_FUNC) {
    utf8 = scr_fs_utf8_encoding(opts);
  }
  if (!utf8 || prefix->kind != SCR_DYN_STR) {
    scr_throw_lowering_fence(fence);
    return NULL;
  }
  ScrStr *p = scr_str_retain(prefix->v.str);
  ScrStr *r = scr_fs_mkdtemp(p);
  scr_str_release(p);
  return r;
}

/* fs.readFile(path, options?, cb): Node's order — the callback
 * (maybeCallback), the options walk's assertEncoding, then the path;
 * the async read itself fences. */
void scr_fs_read_file_chk(const ScrDyn *path, const ScrDyn *opts, const ScrDyn *cb,
                          const ScrStr *fence) {
  if (!scr_fs_cb_chk(cb, "cb")) return;
  if (!scr_fs_encoding_chk(opts)) return;
  if (!scr_fs_path_chk(path, "path")) return;
  scr_throw_lowering_fence(fence);
}

/* fs.opendirSync(path, options?): getValidatedPath, then getOptions'
 * assertEncoding; the Dir machinery fences. */
void scr_fs_opendir_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence) {
  if (!scr_fs_path_chk(path, "path")) return;
  if (!scr_fs_encoding_chk(opts)) return;
  scr_throw_lowering_fence(fence);
}

/* fs.watchFile(path, options?, listener): the path first, the listener's
 * function check second (Node's watchFile order); real watching fences. */
void scr_fs_watch_file_chk(const ScrDyn *path, const ScrDyn *listener, const ScrStr *fence) {
  if (!scr_fs_path_chk(path, "path")) return;
  if (listener->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("listener", "of type function", listener);
    return;
  }
  scr_throw_lowering_fence(fence);
}

/* fs.lchmod / lchmodSync / fs.promises.lchmod — macOS-only in Node (the
 * callback/sync pair is not even exported elsewhere, so non-APPLE builds
 * answer the not-a-function TypeError; the promise form rejects
 * ERR_METHOD_NOT_IMPLEMENTED, Node's own linux shape). On macOS the
 * validation ladder runs in Node's order and the real lchmod(2) applies
 * where an operation survives it. */
static bool scr_fs_lchmod_defined(const char *api) {
#ifdef __APPLE__
  (void)api;
  return true;
#else
  char msg[64];
  int len = snprintf(msg, sizeof msg, "%s is not a function", api);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
  return false;
#endif
}

void scr_fs_lchmod_chk(const ScrDyn *path, const ScrDyn *mode, const ScrDyn *cb,
                       const ScrStr *fence) {
  if (!scr_fs_lchmod_defined("fs.lchmod")) return;
  if (!scr_fs_cb_chk(cb, "cb")) return;
  if (!scr_fs_path_chk(path, "path")) return;
  if (!scr_fs_mode_chk(mode, "mode")) return;
  scr_throw_lowering_fence(fence); /* the async op + callback dispatch */
}

#ifdef __APPLE__
static void scr_fs_lchmod_apply(const ScrDyn *path, const ScrDyn *mode) {
  ScrStr *p = path->kind == SCR_DYN_STR ? scr_str_retain(path->v.str)
                                        : scr_bytes_string(path->v.bytes, 0, path->v.bytes->len);
  double m = mode->kind == SCR_DYN_NUM ? mode->v.num : (double)strtol(mode->v.str->data, NULL, 8);
  if (lchmod(p->data, (mode_t)m) != 0) scr_fs_throw(errno, "lchmod", p);
  scr_str_release(p);
}
#endif

/* Answers the dyn undefined (+1) on success — lchmodSync's JS value, so
 * return-position uses lower; NULL with the exception pending. */
ScrDyn *scr_fs_lchmod_sync_chk(const ScrDyn *path, const ScrDyn *mode) {
  if (!scr_fs_lchmod_defined("fs.lchmodSync")) return NULL;
  if (!scr_fs_path_chk(path, "path")) return NULL;
  if (!scr_fs_mode_chk(mode, "mode")) return NULL;
#ifdef __APPLE__
  scr_fs_lchmod_apply(path, mode);
  if (scr_exc_pending()) return NULL;
#endif
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrPromise *scr_fsp_lchmod_chk(const ScrDyn *path, const ScrDyn *mode) {
#ifndef __APPLE__
  (void)path;
  (void)mode;
  static const char ni[] = "The lchmod() method is not implemented";
  scr_throw_error_msg_code(SCR_ERR_ERROR, ni, sizeof ni - 1, "ERR_METHOD_NOT_IMPLEMENTED");
  return scr_promise_settled_void();
#else
  if (scr_fs_path_chk(path, "path") && scr_fs_mode_chk(mode, "mode")) {
    scr_fs_lchmod_apply(path, mode);
  }
  return scr_promise_settled_void();
#endif
}

/* fs.read(fd, buffer, offset, length, position, cb) — the full argument
 * ladder in Node's order (buffer, fd, offset, length, position); the
 * async read fences. Bounds follow lib/fs.js read(): offset within the
 * buffer, length within buffer - offset. */
static bool scr_fs_int_range_chk(const ScrDyn *v, const char *name, double min, double max,
                                 const char *range) {
  if (v->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", v);
    return false;
  }
  double n = v->v.num;
  char recv[48], msg[192];
  if (!(isfinite(n) && trunc(n) == n)) {
    scr_num_received(n, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be an integer. Received %s",
                       name, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (n < min || n > max) {
    scr_num_received(n, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be %s. Received %s",
                       name, range, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

/* `length |= 0`: ToInt32 of the length argument (a non-numeric value is
 * 0). False with the exception pending when ToNumber throws. */
static bool scr_fs_length_int32(const ScrDyn *length, double *out) {
  double n;
  if (length->kind == SCR_DYN_NUM) {
    n = length->v.num;
  } else if (!scr_dyn_number_coerce_js(length, &n)) {
    return false;
  }
  if (!isfinite(n)) {
    *out = 0;
    return true;
  }
  double m = fmod(trunc(n), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  *out = m >= 2147483648.0 ? m - 4294967296.0 : m;
  return true;
}

/* A bigint read position in [-1n, 2n ** 63n - 1n - BigInt(length)]
 * (validatePosition); false with ERR_OUT_OF_RANGE pending otherwise. The
 * received value groups the digits past 2^32 in threes, as Node's
 * ERR_OUT_OF_RANGE does for bigints. */
static bool scr_fs_bigint_position_chk(ScrBigInt *position, double length) {
  ScrBigInt *top = scr_bigint_from_i64(INT64_MAX);
  ScrBigInt *span = scr_bigint_from_f64(length);
  ScrBigInt *max = scr_bigint_sub(top, span);
  scr_bigint_release(top);
  scr_bigint_release(span);
  ScrBigInt *low = scr_bigint_from_i64(-1);
  bool ok = scr_bigint_cmp_f64(position, low) >= 0 && scr_bigint_cmp_f64(position, max) <= 0;
  scr_bigint_release(low);
  if (ok) {
    scr_bigint_release(max);
    return true;
  }
  ScrStr *limit = scr_bigint_to_string(max, 10);
  scr_bigint_release(max);
  ScrStr *decimal = scr_bigint_to_string(position, 10);
  if (!limit || !decimal) {
    if (limit) scr_str_release(limit);
    if (decimal) scr_str_release(decimal);
    return false;
  }
  ScrBigInt *bound = scr_bigint_from_i64((int64_t)1 << 32);
  ScrBigInt *negBound = scr_bigint_from_i64(-((int64_t)1 << 32));
  bool group = scr_bigint_cmp_f64(position, bound) > 0 || scr_bigint_cmp_f64(position, negBound) < 0;
  scr_bigint_release(bound);
  scr_bigint_release(negBound);
  /* addNumericalSeparator: underscores every three digits from the right,
   * after an optional sign. */
  char digits[200];
  size_t len = decimal->len < 120 ? decimal->len : 120, out = 0;
  size_t start = len > 0 && decimal->data[0] == '-' ? 1 : 0;
  for (size_t i = 0; i < len; i++) {
    if (group && i > start && (len - i) % 3 == 0) digits[out++] = '_';
    digits[out++] = (char)decimal->data[i];
  }
  digits[out] = '\0';
  char msg[384];
  int n = snprintf(msg, sizeof msg,
                   "The value of \"position\" is out of range. It must be >= -1 && <= %.*s. Received %sn",
                   (int)limit->len, (const char *)limit->data, digits);
  scr_str_release(limit);
  scr_str_release(decimal);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, n < 0 ? 0 : (size_t)n, "ERR_OUT_OF_RANGE");
  return false;
}


/* fs.read(fd, buffer, offset, length, position, cb)'s argument checks, in
 * Node's order: the fd, the buffer, the offset (an integer >= 0), the
 * length as `length |= 0`, the position (validatePosition, against that
 * length), then for a non-empty read the empty-buffer and
 * validateOffsetLengthRead checks. */
static bool scr_fs_read_validate(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                                 const ScrDyn *length, const ScrDyn *position) {
  if (fd->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("fd", "of type number", fd);
    return false;
  }
  if (buffer->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
    return false;
  }
  double buflen = scr_bytes_byte_len(buffer->v.bytes);
  double off = 0;
  if (!scr_fs_dyn_absent(offset)) {
    if (!scr_fs_int_range_chk(offset, "offset", 0, 9007199254740991.0,
                              ">= 0 && <= 9007199254740991")) {
      return false;
    }
    off = offset->v.num;
  }
  double count = 0;
  if (!scr_fs_length_int32(length, &count)) return false;
  if (!scr_fs_dyn_absent(position)) {
    if (position->kind == SCR_DYN_BIGINT) {
      if (!scr_fs_bigint_position_chk(position->v.bigint, count)) return false;
    } else if (position->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("position", "of type bigint or integer", position);
      return false;
    } else if (!scr_fs_int_range_chk(position, "position", -1, 9007199254740991.0,
                                     ">= -1 && <= 9007199254740991")) {
      return false;
    }
  }
  if (count == 0) return true;
  if (buflen == 0) {
    if (scr_bytes_is_buffer(buffer->v.bytes)) {
      static const char empty[] =
          "The argument 'buffer' is empty and cannot be written. Received <Buffer >";
      scr_throw_error_msg_code(SCR_ERR_TYPE, empty, sizeof empty - 1, "ERR_INVALID_ARG_VALUE");
    } else {
      scr_dyn_arg_value_fail("buffer", "is empty and cannot be written", buffer);
    }
    return false;
  }
  if (count < 0 || off + count > buflen) {
    char recv[48], range[64], msg[192];
    scr_num_received(count, recv);
    if (count < 0) snprintf(range, sizeof range, ">= 0");
    else snprintf(range, sizeof range, "<= %.0f", buflen - off);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"length\" is out of range. It must be %s. Received %s", range,
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}


void scr_fs_read_chk(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                     const ScrDyn *length, const ScrDyn *position, const ScrStr *fence) {
  if (scr_fs_read_validate(fd, buffer, offset, length, position)) scr_throw_lowering_fence(fence);
}

/* createReadStream/createWriteStream(path, options?): getOptions'
 * assertEncoding, the fd member's FileHandle-or-integer contract when
 * present, the path contract otherwise; the stream machinery fences. */
bool scr_fs_stream_opts_valid(const ScrDyn *path, const ScrDyn *opts) {
  if (!scr_fs_encoding_chk(opts)) return false;
  if (path == NULL) return true; /* a FileHandle's stream: options.fd is the handle */
  const ScrDyn *fd = opts->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(opts, "fd", 2) : NULL;
  if (fd != NULL && !scr_fs_dyn_absent(fd)) {
    if (fd->kind != SCR_DYN_NUM) {
      scr_dyn_prop_type_fail("options.fd", "of type number or an instance of FileHandle", fd);
      return false;
    }
    return scr_fs_int_range_chk(fd, "fd", 0, 2147483647.0, ">= 0 && <= 2147483647");
  }
  return scr_fs_path_chk(path, "path");
}

void scr_fs_stream_opts_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence) {
  if (scr_fs_stream_opts_valid(path, opts)) scr_throw_lowering_fence(fence);
}

ScrStr *scr_fs_stream_path(const ScrDyn *value) { return scr_fs_checked_path(value, "path"); }

int scr_fs_stream_flags(const ScrDyn *flag, const char *fallback) {
  const char *f = scr_fs_dyn_absent(flag) ? fallback : flag->kind == SCR_DYN_STR ? flag->v.str->data : NULL;
  if (!f) {
    static const char message[] = "Runtime numeric filesystem flags have no portable native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return -1;
  }
  int bits = scr_fs_flag_bits(f);
  if (bits < 0) scr_fs_flag_invalid(f);
  return bits;
}

bool scr_fs_stream_mode(const ScrDyn *value, double *mode) {
  if (scr_fs_dyn_absent(value)) {
    *mode = 0666;
    return true;
  }
  return scr_fs_cb_file_mode(value, "mode", mode);
}

/* fs.readSync(fd, buffer, offset, length[, position]) with arguments the
 * compiler could not type (JavaScript): Node's checks (validateBuffer
 * first, then the fd, the offset, `length |= 0` and the position, which
 * may be a bigint), then the typed read. */
double scr_fs_read_sync_dyn(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                            const ScrDyn *length, const ScrDyn *position) {
  if (buffer->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
    return 0;
  }
  if (!scr_fs_read_validate(fd, buffer, offset, length, position)) return 0;
  double count = 0;
  if (!scr_fs_length_int32(length, &count)) return 0;
  if (count == 0) return 0;
  double at = scr_fs_dyn_absent(position)                ? -1
              : position->kind == SCR_DYN_BIGINT ? scr_bigint_to_f64(position->v.bigint)
                                                   : position->v.num;
  ScrBytes *bytes = scr_dyn_bytes_unbox(buffer);
  double read = scr_fs_read_sync(fd->v.num, bytes, scr_fs_dyn_absent(offset) ? 0 : offset->v.num,
                                 count, at);
  scr_bytes_release(bytes);
  return read;
}

/* ERR_OUT_OF_RANGE for the number `n` of argument `name`. Always false. */
static bool scr_fs_num_range_fail(const char *name, const char *range, double n) {
  char recv[48], msg[192];
  scr_num_received(n, recv);
  int len = snprintf(msg, sizeof msg, "The value of \"%s\" is out of range. It must be %s. Received %s",
                     name, range, recv);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

/* fs.write(fd, buffer, offset, length, position, cb)'s buffer checks: the
 * offset (an integer >= 0 unless omitted, null or the callback), a
 * non-number length defaulting to the rest of the buffer, then
 * validateOffsetLengthWrite. An options object in the offset slot is read
 * by the write itself. */
static bool scr_fs_write_validate(const ScrDyn *buffer, const ScrDyn *offset, const ScrDyn *length) {
  if (offset->kind == SCR_DYN_OBJ || offset->kind == SCR_DYN_TYPED_REF || offset->kind == SCR_DYN_PROXY ||
      offset->kind == SCR_DYN_NULL)
    return true;
  double buflen = scr_bytes_byte_len(buffer->v.bytes);
  double off = 0;
  if (!scr_fs_dyn_absent(offset) && offset->kind != SCR_DYN_FUNC) {
    if (!scr_fs_int_range_chk(offset, "offset", 0, 9007199254740991.0, ">= 0 && <= 9007199254740991"))
      return false;
    off = offset->v.num;
  }
  double len = length->kind == SCR_DYN_NUM ? length->v.num : buflen - off;
  char range[64];
  if (off > buflen) {
    snprintf(range, sizeof range, "<= %.0f", buflen);
    return scr_fs_num_range_fail("offset", range, off);
  }
  if (len > buflen - off) {
    snprintf(range, sizeof range, "<= %.0f", buflen - off);
    return scr_fs_num_range_fail("length", range, len);
  }
  if (len < 0) return scr_fs_num_range_fail("length", ">= 0", len);
  if (!(isfinite(len) && trunc(len) == len)) return scr_fs_num_range_fail("length", "an integer", len);
  if (len > 2147483647.0) return scr_fs_num_range_fail("length", ">= 0 && <= 2147483647", len);
  return true;
}
