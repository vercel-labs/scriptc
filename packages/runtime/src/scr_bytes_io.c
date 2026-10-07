/* The OS-facing half of the typed-array/Buffer runtime: fs Buffer reads/
 * writes (scr_lib.c's throw formatting), the fs/promises bytes form
 * (scr_async.c's settled-promise minting), crypto.randomBytes, and the
 * process stream Buffer writes. Split from scr_bytes.c so the pure bytes
 * core links without the lib/async runtimes (the runtime unit tests link
 * exact source lists). */
#include "scr_runtime.h"

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
#include <utime.h>
#ifndef O_SYNC
#define O_SYNC 0 /* Windows CRT opens have no separate synchronous flag. */
#endif
/* Bionic added glob/globfree in API 28; Android packs target API 26. */
#if !defined(_WIN32) && !defined(__wasi__) && (!defined(__ANDROID__) || __ANDROID_API__ >= 28)
#include <glob.h>
#define SCR_FS_HAS_GLOB 1
#else
#define SCR_FS_HAS_GLOB 0
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

ScrStr *scr_fs_read_file_encoded(ScrStr *path, ScrStr *encoding) {
  if (!scr_fs_read_encoding_valid(encoding)) return NULL;
  return scr_fs_decode_read(scr_fs_read_file_bytes(path), encoding);
}

ScrStr *scr_fs_read_fd_encoded(double fd, ScrStr *encoding) {
  if (!scr_fs_read_encoding_valid(encoding)) return NULL;
  return scr_fs_decode_read(scr_fs_read_fd_bytes(fd), encoding);
}

/* ── fs (the Buffer forms of scr_lib.c's utf8 pair) ────────────────────── */

/* readFileSync's runtime-encoding form (a JS helper's untyped `enc`
 * parameter — test/common fixtures.js): undefined/null answer a Buffer,
 * a supported encoding answers a string, invalid names throw
 * ERR_INVALID_ARG_VALUE before reading, and an
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
    ScrStr *text = scr_fs_read_file_encoded(path, enc->v.str);
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

static double scr_fs_cb_open(const ScrStr *path, const ScrDyn *flag, double mode, const char *fallback) {
  const char *f = flag->kind == SCR_DYN_UNDEF ? fallback : flag->kind == SCR_DYN_STR ? flag->v.str->data : NULL;
  if (!f) {
    static const char message[] = "Runtime numeric filesystem flags have no portable native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return -1;
  }
  int bits;
  if (!strcmp(f, "r")) bits = O_RDONLY;
  else if (!strcmp(f, "r+")) bits = O_RDWR;
  else if (!strcmp(f, "rs") || !strcmp(f, "sr")) bits = O_RDONLY | O_SYNC;
  else if (!strcmp(f, "rs+") || !strcmp(f, "sr+")) bits = O_RDWR | O_SYNC;
  else if (!strcmp(f, "w")) bits = O_WRONLY | O_CREAT | O_TRUNC;
  else if (!strcmp(f, "w+")) bits = O_RDWR | O_CREAT | O_TRUNC;
  else if (!strcmp(f, "wx") || !strcmp(f, "xw")) bits = O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
  else if (!strcmp(f, "wx+") || !strcmp(f, "xw+")) bits = O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
  else if (!strcmp(f, "a")) bits = O_WRONLY | O_CREAT | O_APPEND;
  else if (!strcmp(f, "a+")) bits = O_RDWR | O_CREAT | O_APPEND;
  else if (!strcmp(f, "ax") || !strcmp(f, "xa")) bits = O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
  else if (!strcmp(f, "ax+") || !strcmp(f, "xa+")) bits = O_RDWR | O_CREAT | O_APPEND | O_EXCL;
  else if (!strcmp(f, "as") || !strcmp(f, "sa")) bits = O_WRONLY | O_CREAT | O_APPEND | O_SYNC;
  else if (!strcmp(f, "as+") || !strcmp(f, "sa+")) bits = O_RDWR | O_CREAT | O_APPEND | O_SYNC;
  else {
    char message[160];
    int length = snprintf(message, sizeof message, "The argument 'flags' is invalid. Received '%s'", f);
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)length, "ERR_INVALID_ARG_VALUE");
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
      ScrArr *parts = scr_arr_new_ref(scr_str_retain_v, scr_str_release_v, NULL, 3);
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

static ScrStr *scr_fs_cb_join(const ScrStr *directory, const char *name) {
  ScrStr *suffix = scr_str_new("/", 1);
  ScrStr *base = scr_str_concat((ScrStr *)directory, suffix);
  scr_str_release(suffix);
  suffix = scr_str_new(name, strlen(name));
  ScrStr *path = scr_str_concat(base, suffix);
  scr_str_release(base); scr_str_release(suffix);
  return path;
}

static void scr_fs_cb_copy(const ScrStr *source, const ScrStr *destination, bool recursive, bool force, bool preserve) {
  struct stat status;
  if (
#ifdef _WIN32
      stat(source->data, &status)
#else
      lstat(source->data, &status)
#endif
      < 0) { scr_fs_throw(errno, "stat", source); return; }
#ifndef _WIN32
  if (S_ISLNK(status.st_mode)) {
    const char *message = "Symbolic-link cp entries have no native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
    return;
  }
#endif
  if (S_ISDIR(status.st_mode)) {
    if (!recursive) { scr_fs_throw(EISDIR, "cp", source); return; }
    scr_fs_mkdir_recursive_mode((ScrStr *)destination, status.st_mode & 0777);
    if (scr_exc_pending()) return;
    DIR *directory = opendir(source->data);
    if (!directory) { scr_fs_throw(errno, "opendir", source); return; }
    struct dirent *entry;
    while (!scr_exc_pending() && (entry = readdir(directory))) {
      if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
      ScrStr *from = scr_fs_cb_join(source, entry->d_name), *to = scr_fs_cb_join(destination, entry->d_name);
      scr_fs_cb_copy(from, to, true, force, preserve);
      scr_str_release(from); scr_str_release(to);
    }
    closedir(directory);
  } else {
    if (!force && scr_fs_exists((ScrStr *)destination)) return;
    scr_fs_copyfile((ScrStr *)source, (ScrStr *)destination);
  }
  if (preserve && !scr_exc_pending()) {
    struct utimbuf times = { status.st_atime, status.st_mtime };
    if (utime(destination->data, &times) < 0) scr_fs_throw(errno, "utime", destination);
  }
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
  struct stat status;
#ifdef _WIN32
  (void)nofollow;
  int rc = path ? stat(path->data, &status) : fstat((int)fd, &status);
#else
  int rc = path ? (nofollow ? lstat(path->data, &status) : stat(path->data, &status)) : fstat((int)fd, &status);
#endif
  if (rc < 0) { scr_fs_throw(errno, path ? (nofollow ? "lstat" : "stat") : "fstat", path); return NULL; }
  bool bigint = scr_fs_cb_option_bool(options, "bigint");
  ScrDyn *object = scr_dyn_new_obj();
#define SCR_FS_STAT_FIELD(field) scr_fs_cb_stat_number(object, #field, (int64_t)status.st_##field, bigint)
  SCR_FS_STAT_FIELD(dev); SCR_FS_STAT_FIELD(ino); SCR_FS_STAT_FIELD(mode); SCR_FS_STAT_FIELD(nlink);
  SCR_FS_STAT_FIELD(uid); SCR_FS_STAT_FIELD(gid); SCR_FS_STAT_FIELD(rdev); SCR_FS_STAT_FIELD(size);
#ifndef _WIN32
  SCR_FS_STAT_FIELD(blksize); SCR_FS_STAT_FIELD(blocks);
#endif
#undef SCR_FS_STAT_FIELD
  double atime = (double)status.st_atime * 1000, mtime = (double)status.st_mtime * 1000, ctime = (double)status.st_ctime * 1000;
  double birthtime = 0;
#ifdef __APPLE__
  atime += status.st_atimespec.tv_nsec / 1000000.0; mtime += status.st_mtimespec.tv_nsec / 1000000.0;
  ctime += status.st_ctimespec.tv_nsec / 1000000.0;
  birthtime = (double)status.st_birthtimespec.tv_sec * 1000 + status.st_birthtimespec.tv_nsec / 1000000.0;
#elif !defined(_WIN32) && !defined(__wasi__)
  atime += status.st_atim.tv_nsec / 1000000.0; mtime += status.st_mtim.tv_nsec / 1000000.0;
  ctime += status.st_ctim.tv_nsec / 1000000.0;
#endif
  scr_fs_cb_stat_date(object, "atime", atime); scr_fs_cb_stat_date(object, "mtime", mtime);
  scr_fs_cb_stat_date(object, "ctime", ctime); scr_fs_cb_stat_date(object, "birthtime", birthtime);
  if (bigint) {
    scr_fs_cb_stat_number(object, "atimeMs", (int64_t)atime, true);
    scr_fs_cb_stat_number(object, "mtimeMs", (int64_t)mtime, true);
    scr_fs_cb_stat_number(object, "ctimeMs", (int64_t)ctime, true);
    scr_fs_cb_stat_number(object, "birthtimeMs", (int64_t)birthtime, true);
  } else {
    scr_dyn_obj_set(object, "atimeMs", 7, scr_dyn_new_num(atime));
    scr_dyn_obj_set(object, "mtimeMs", 7, scr_dyn_new_num(mtime));
    scr_dyn_obj_set(object, "ctimeMs", 7, scr_dyn_new_num(ctime));
    scr_dyn_obj_set(object, "birthtimeMs", 11, scr_dyn_new_num(birthtime));
  }
  scr_fs_cb_stat_method(object, "isFile", S_ISREG(status.st_mode));
  scr_fs_cb_stat_method(object, "isDirectory", S_ISDIR(status.st_mode));
#ifndef _WIN32
  scr_fs_cb_stat_method(object, "isSymbolicLink", S_ISLNK(status.st_mode));
  scr_fs_cb_stat_method(object, "isBlockDevice", S_ISBLK(status.st_mode));
  scr_fs_cb_stat_method(object, "isCharacterDevice", S_ISCHR(status.st_mode));
  scr_fs_cb_stat_method(object, "isFIFO", S_ISFIFO(status.st_mode));
  scr_fs_cb_stat_method(object, "isSocket", S_ISSOCK(status.st_mode));
#else
  scr_fs_cb_stat_method(object, "isSymbolicLink", false);
  scr_fs_cb_stat_method(object, "isBlockDevice", false);
  scr_fs_cb_stat_method(object, "isCharacterDevice", S_ISCHR(status.st_mode));
  scr_fs_cb_stat_method(object, "isFIFO", false); scr_fs_cb_stat_method(object, "isSocket", false);
#endif
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

static void scr_fs_cb_schedule(const ScrDyn *callback, ScrDyn *result, const ScrDyn *buffer) {
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
  scr_set_timeout(closure, 0);
#else
  (void)callback;
  scr_dyn_release(arguments);
  scr_throw_error_msg_code(SCR_ERR_ERROR, "Filesystem callbacks require an executable event loop", 52, "SC4005");
#endif
}

static bool scr_fs_read_validate(const ScrDyn *, const ScrDyn *, const ScrDyn *, const ScrDyn *, const ScrDyn *);
static bool scr_fs_encoding_chk(const ScrDyn *);
static bool scr_fs_int_range_chk(const ScrDyn *, const char *, double, double, const char *);
static bool scr_fs_mode_chk(const ScrDyn *, const char *);

static bool scr_fs_callback_times(const ScrDyn *atime, const ScrDyn *mtime, bool descriptor, double *access, double *modified) {
  *access = scr_fs_timestamp_value(atime, descriptor ? "atime" : "time");
  if (scr_exc_pending()) return false;
  *modified = scr_fs_timestamp_value(mtime, descriptor ? "mtime" : "time");
  return !scr_exc_pending();
}

static ScrArr *scr_fs_cb_vectors(const ScrDyn *buffers) {
  ScrDyn *snapshot = buffers->kind == SCR_DYN_TYPED_REF && scr_dyn_isl_is_array(buffers)
    ? scr_dyn_typed_ref_materialize(buffers) : NULL;
  const ScrDyn *array = snapshot ? snapshot : buffers;
  if (array->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("buffers", "an instance of Array", buffers);
    scr_dyn_release(snapshot);
    return NULL;
  }
  ScrArr *out = scr_arr_new_ref(scr_bytes_retain_v, scr_bytes_release_v, NULL, array->v.arr.len);
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
  bool newControl = !strcmp(op, "fdatasync") || !strcmp(op, "fchmod") || !strcmp(op, "ftruncate");
  if ((vector || newControl) && !scr_fs_int_range_chk(scr_fs_cb_arg(args, argc, 0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  ScrArr *vectors = vector ? scr_fs_cb_vectors(scr_fs_cb_arg(args, argc, 1)) : NULL;
  if (vector && !vectors) return NULL;
  bool fileCallback = !strcmp(op, "readFile") || !strcmp(op, "mkdtemp");
  const ScrDyn *callback = timestamp ? scr_fs_cb_arg(args, argc, 3)
    : argc >= (fileCallback ? 2u : 1u) ? args[argc - 1] : scr_dyn_undefined();
  if (!scr_fs_cb_chk(callback, fileCallback || vector || timestamp ? "cb" : "callback")) { scr_arr_release(vectors); return NULL; }
  size_t count = timestamp ? argc : argc - 1;
#define ARG(index) scr_fs_cb_arg(args, count, index)
  if (!strcmp(op, "readFile") && !scr_fs_encoding_chk(ARG(1))) return NULL;
  if (!strcmp(op, "read") && count >= 4 && !scr_fs_read_validate(ARG(0), ARG(1), ARG(2), ARG(3), ARG(4))) return NULL;
  bool descriptor = timestamp_fd || vector || newControl || !strcmp(op, "close") || !strcmp(op, "fstat") || !strcmp(op, "fsync") || !strcmp(op, "read") || !strcmp(op, "write");
  ScrStr *path = descriptor ? NULL : timestamp ? scr_fs_timestamp_path(ARG(0)) : scr_fs_cb_path(ARG(0), !strcmp(op, "mkdtemp") ? "prefix" : "path");
  if (!descriptor && !path) return NULL;
  if (timestamp && !timestamp_fd && !scr_fs_callback_times(ARG(1), ARG(2), false, &access, &modified)) { scr_str_release(path); return NULL; }
  if (timestamp_fd && !scr_fs_int_range_chk(ARG(0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  double fd = descriptor ? scr_fs_cb_number(ARG(0), "fd", -1) : -1;
  if (scr_exc_pending()) { scr_str_release(path); scr_arr_release(vectors); return NULL; }
  if (newControl && strcmp(op, "fdatasync")) {
    const ScrDyn *value = ARG(1);
    if (strcmp(op, "ftruncate") || value->kind != SCR_DYN_UNDEF) {
      bool chmod = !strcmp(op, "fchmod");
      if (chmod ? !scr_fs_mode_chk(value, "mode") : !scr_fs_int_range_chk(value, "len", -9007199254740991.0, 9007199254740991.0, ">= -9007199254740991 && <= 9007199254740991")) return NULL;
    }
  }
  ScrDyn *result = NULL;
  const ScrDyn *buffer = NULL;
  if (!strcmp(op, "readFile")) {
    const ScrDyn *options = ARG(1);
    if (options->kind != SCR_DYN_STR && (!scr_fs_cb_signal(options) || scr_fs_cb_refuse_option(options, "flag"))) goto done;
    ScrDyn *encoding = options->kind == SCR_DYN_STR ? scr_dyn_retain((ScrDyn *)options) : scr_fs_cb_option(options, "encoding");
    if (encoding) result = scr_fs_read_file_sync_dyn(path, encoding);
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
  } else if (!strcmp(op, "access")) scr_fs_access(path, scr_fs_cb_number(ARG(1), "mode", 0));
  else if (!strcmp(op, "mkdir")) {
    const ScrDyn *options = ARG(1);
    double mode = options->kind == SCR_DYN_NUM ? options->v.num : scr_fs_cb_option_number(options, "mode", 0777);
    if (scr_fs_cb_option_bool(options->kind == SCR_DYN_NUM ? scr_dyn_undefined() : options, "recursive")) scr_fs_mkdir_recursive_mode(path, mode);
    else scr_fs_mkdir_mode(path, mode);
  } else if (!strcmp(op, "mkdtemp")) result = scr_fs_cb_string(scr_fs_mkdtemp(path));
  else if (!strcmp(op, "rm")) scr_fs_rm_opts_retry(path, scr_fs_cb_option_bool(ARG(1), "recursive"), scr_fs_cb_option_bool(ARG(1), "force"), scr_fs_cb_option_number(ARG(1), "maxRetries", 0), scr_fs_cb_option_number(ARG(1), "retryDelay", 100));
  else if (!strcmp(op, "rmdir")) scr_fs_rmdir(path);
  else if (!strcmp(op, "unlink")) scr_fs_unlink(path);
  else if (!strcmp(op, "chmod")) scr_fs_chmod(path, scr_fs_cb_number(ARG(1), "mode", 0));
  else if (!strcmp(op, "chown")) scr_fs_chown(path, scr_fs_cb_number(ARG(1), "uid", 0), scr_fs_cb_number(ARG(2), "gid", 0));
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
    double opened = scr_fs_cb_open(path, ARG(1), scr_fs_cb_number(ARG(2), "mode", 0666), "r");
    if (!scr_exc_pending()) result = scr_dyn_new_num(opened);
  } else if (!strcmp(op, "cp")) {
    if (scr_fs_cb_refuse_option(ARG(2), "filter") || scr_fs_cb_refuse_option(ARG(2), "dereference") || scr_fs_cb_refuse_option(ARG(2), "verbatimSymlinks") || scr_fs_cb_refuse_option(ARG(2), "errorOnExist") || scr_fs_cb_refuse_option(ARG(2), "mode")) goto done;
    ScrStr *destination = scr_fs_cb_path(ARG(1), "dest");
    if (destination) {
      ScrDyn *force = scr_fs_cb_option(ARG(2), "force");
      scr_fs_cb_copy(path, destination, scr_fs_cb_option_bool(ARG(2), "recursive"),
        force && (force->kind == SCR_DYN_UNDEF || scr_dyn_truthy(force)), scr_fs_cb_option_bool(ARG(2), "preserveTimestamps"));
      scr_dyn_release(force); scr_str_release(destination);
    }
  } else if (!strcmp(op, "glob")) {
#if SCR_FS_HAS_GLOB
    if (strstr(path->data, "**") || scr_fs_cb_option_bool(ARG(1), "withFileTypes")) {
      const char *message = "Recursive glob patterns and Dirent results have no native lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
      goto done;
    }
    ScrDyn *cwd = scr_fs_cb_option(ARG(1), "cwd");
    ScrDyn *exclude = scr_fs_cb_option(ARG(1), "exclude");
    if (exclude && exclude->kind != SCR_DYN_UNDEF) {
      const char *message = "fs.glob exclude options have no native lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
    } else {
      ScrStr *pattern = cwd && cwd->kind == SCR_DYN_STR ? scr_fs_cb_join(cwd->v.str, path->data) : scr_str_retain(path);
      glob_t matches = {0};
      int rc = glob(pattern->data, 0, NULL, &matches);
      if (rc && rc != GLOB_NOMATCH) scr_fs_throw(rc == GLOB_NOSPACE ? ENOMEM : EIO, "glob", path);
      else {
        result = scr_dyn_new_arr();
        size_t prefix = cwd && cwd->kind == SCR_DYN_STR ? cwd->v.str->len + 1 : 0;
        for (size_t i = 0; i < matches.gl_pathc; i++) {
          const char *name = matches.gl_pathv[i] + prefix;
          scr_dyn_arr_push(result, scr_fs_cb_string(scr_str_new(name, strlen(name))));
        }
      }
      globfree(&matches); scr_str_release(pattern);
    }
    scr_dyn_release(cwd); scr_dyn_release(exclude);
#else
    scr_fs_throw(ENOSYS, "glob", path);
#endif
  } else if (!strcmp(op, "read") || !strcmp(op, "write")) {
    bool readOp = !strcmp(op, "read");
    const ScrDyn *options = ARG(1);
    ScrDyn *ownedBuffer = NULL;
    if (readOp && !scr_dyn_bytes_is(options, SCR_BYTES_U8)) { ownedBuffer = scr_fs_cb_option(options, "buffer"); buffer = ownedBuffer; }
    else buffer = options;
    ScrBytes *bytes = buffer && buffer->kind == SCR_DYN_BYTES ? scr_dyn_bytes_unbox(buffer) : NULL;
    if (!bytes) scr_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", buffer ? buffer : scr_dyn_undefined());
    else {
      double offset = ownedBuffer ? scr_fs_cb_option_number(options, "offset", 0) : scr_fs_cb_number(ARG(2), "offset", 0);
      double length = ownedBuffer ? scr_fs_cb_option_number(options, "length", bytes->len - offset) : scr_fs_cb_number(ARG(3), "length", bytes->len - offset);
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
    ScrStr *destination = scr_fs_cb_path(ARG(1), "dest");
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
      if (descriptor) scr_fs_ftruncate(fd, length);
      else if (truncate(path->data, (off_t)length) < 0) scr_fs_throw(errno, "truncate", path);
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
 * valueOf hooks keep a loud refusal rather than silently skipping hooks. */
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

ScrBytes *scr_buffer_from_dyn(const ScrDyn *value, const ScrStr *encoding) {
  if (value->kind == SCR_DYN_STR) return scr_bytes_from_str(value->v.str, encoding);
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
  if (value->kind == SCR_DYN_TYPED_REF || value->kind == SCR_DYN_HANDLE || value->kind == SCR_DYN_JSVAL) {
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

/* ── the checked-dynamic Buffer compare/equals validators ──────────────
 * Node's argument ladders for buf.equals / buf.compare / Buffer.compare
 * over dyn-boxed arguments (the invalid-input probes: string needles,
 * '0' offsets, null/object range args). A well-typed dyn still computes
 * the real answer — validation, not a constant fence. */

/* A bytes payload or the API's own ERR_INVALID_ARG_TYPE (borrowed). */
static ScrBytes *scr_bytes_chk_u8(const ScrDyn *d, const char *argname) {
  if (!scr_dyn_bytes_is(d, SCR_BYTES_U8)) {
    scr_dyn_arg_type_fail(argname, "an instance of Buffer or Uint8Array", d);
    return NULL;
  }
  return d->v.bytes;
}

double scr_buffer_compare_chk(const ScrDyn *a, const ScrDyn *b) {
  ScrBytes *b1 = scr_bytes_chk_u8(a, "buf1");
  if (!b1) return 0;
  ScrBytes *b2 = scr_bytes_chk_u8(b, "buf2");
  if (!b2) return 0;
  return scr_bytes_compare(b1, b2, 0, 0, 0, 0, 0);
}

bool scr_bytes_equals_chk(const ScrBytes *recv, const ScrDyn *other) {
  ScrBytes *o = scr_bytes_chk_u8(other, "otherBuffer");
  if (!o) return false;
  return scr_bytes_equals(recv, o);
}

/* One offset slot: undefined takes the Node default, non-numbers throw
 * ERR_INVALID_ARG_TYPE "of type number", numbers run validateOffset. */
static bool scr_bytes_chk_off(const ScrDyn *d, const char *name, double max,
                              double dflt, double *out) {
  if (d->kind == SCR_DYN_UNDEF) {
    *out = dflt;
    return true;
  }
  if (d->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", d);
    return false;
  }
  *out = d->v.num;
  return scr_bytes_validate_off(name, *out, max);
}

double scr_bytes_compare_chk(const ScrBytes *src, const ScrDyn *target,
                             const ScrDyn *ts, const ScrDyn *te,
                             const ScrDyn *ss, const ScrDyn *se) {
  ScrBytes *t = scr_bytes_chk_u8(target, "target");
  if (!t) return 0;
  double tsv, tev, ssv, sev;
  if (!scr_bytes_chk_off(ts, "targetStart", 9007199254740991.0, 0, &tsv)) return 0;
  if (!scr_bytes_chk_off(te, "targetEnd", (double)t->len, (double)t->len, &tev)) return 0;
  if (!scr_bytes_chk_off(ss, "sourceStart", 9007199254740991.0, 0, &ssv)) return 0;
  if (!scr_bytes_chk_off(se, "sourceEnd", (double)src->len, (double)src->len, &sev)) return 0;
  /* Every slot validated or defaulted above; nargs 4 revalidates the
   * now-known-good numbers (a no-op) and keeps one comparison core. */
  return scr_bytes_compare(src, t, 4, tsv, tev, ssv, sev);
}

/* new Buffer(number, encoding) — the deprecated ctor's string arm with a
 * non-string first argument: Node's exact ERR_INVALID_ARG_TYPE (the
 * throwing path never fires DEP0005, so compiled silence matches). */
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

/* assertEncoding over an options slot (a bare encoding string or an
 * options record's `encoding` member): Node throws ERR_INVALID_ARG_VALUE
 * for any truthy value Buffer.isEncoding rejects. */
static bool scr_fs_encoding_chk(const ScrDyn *opts) {
  if (opts->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(opts);
    bool valid = view && !scr_exc_pending() && scr_fs_encoding_chk(view);
    scr_dyn_release(view);
    return valid;
  }
  const ScrDyn *enc = opts;
  if (opts->kind == SCR_DYN_OBJ) {
    enc = scr_dyn_obj_get(opts, "encoding", 8);
    if (enc == NULL) return true;
  }
  if (scr_fs_dyn_absent(enc)) return true;
  if (enc->kind == SCR_DYN_STR) {
    if (enc->v.str->len == 0) return true; /* falsy: assertEncoding's `encoding &&` gate */
    if (scr_bytes_is_encoding(enc->v.str)) return true;
  }
  if (enc->kind == SCR_DYN_BOOL && !enc->v.b) return true;
  if (enc->kind == SCR_DYN_NUM && enc->v.num == 0) return true;
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
  scr_set_timeout(clo, 0);
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
        const ScrDyn *enc = e->value;
        if (!(enc->kind == SCR_DYN_STR &&
              (scr_fs_str_is(enc->v.str, "utf8") || scr_fs_str_is(enc->v.str, "utf-8")))) {
          utf8 = false;
        }
        continue;
      }
      utf8 = false; /* an unmodeled effectful option */
    }
  } else if (opts->kind == SCR_DYN_STR) {
    utf8 = scr_fs_str_is(opts->v.str, "utf8") || scr_fs_str_is(opts->v.str, "utf-8");
  } else if (!scr_fs_dyn_absent(opts)) {
    utf8 = false;
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

static bool scr_fs_read_validate(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                                 const ScrDyn *length, const ScrDyn *position) {
  if (buffer->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
    return false;
  }
  if (fd->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("fd", "of type number", fd);
    return false;
  }
  double buflen = scr_bytes_byte_len(buffer->v.bytes);
  if (!scr_fs_dyn_absent(offset)) {
    /* validateInteger's MAX_SAFE range first, the buffer bound second —
     * Node renders each with its own max. */
    if (!scr_fs_int_range_chk(offset, "offset", 0, 9007199254740991.0,
                              ">= 0 && <= 9007199254740991")) {
      return false;
    }
    if (offset->v.num > buflen) {
      char range[64];
      snprintf(range, sizeof range, ">= 0 && <= %.0f", buflen);
      if (!scr_fs_int_range_chk(offset, "offset", 0, buflen, range)) return false;
    }
  }
  double off = offset->kind == SCR_DYN_NUM ? offset->v.num : 0;
  if (!scr_fs_dyn_absent(length)) {
    if (length->kind != SCR_DYN_NUM || !(isfinite(length->v.num) && trunc(length->v.num) == length->v.num) ||
        length->v.num < 0) {
      /* Node renders the bare ">= 0" form here (checkPosition's cousin). */
      if (length->kind == SCR_DYN_NUM) {
        char recv[48], msg[160];
        scr_num_received(length->v.num, recv);
        const char *shape = (isfinite(length->v.num) && trunc(length->v.num) == length->v.num)
                                ? "It must be >= 0."
                                : "It must be an integer.";
        int len = snprintf(msg, sizeof msg,
                           "The value of \"length\" is out of range. %s Received %s", shape, recv);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
        return false;
      }
      scr_dyn_arg_type_fail("length", "of type number", length);
      return false;
    }
    if (length->v.num > buflen - off) {
      char recv[48], msg[160];
      scr_num_received(length->v.num, recv);
      int len = snprintf(msg, sizeof msg,
                         "The value of \"length\" is out of range. It must be <= %.0f. Received %s",
                         buflen - off, recv);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
      return false;
    }
  }
  if (!scr_fs_dyn_absent(position)) {
    if (position->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("position", "of type bigint or integer", position);
      return false;
    }
    if (!scr_fs_int_range_chk(position, "position", -1, 9007199254740991.0,
                              ">= -1 && <= 9007199254740991")) {
      return false;
    }
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
void scr_fs_stream_opts_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence) {
  if (!scr_fs_encoding_chk(opts)) return;
  const ScrDyn *fd = opts->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(opts, "fd", 2) : NULL;
  if (fd != NULL && !scr_fs_dyn_absent(fd)) {
    if (fd->kind != SCR_DYN_NUM) {
      scr_dyn_prop_type_fail("options.fd", "of type number or an instance of FileHandle", fd);
      return;
    }
    if (!scr_fs_int_range_chk(fd, "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return;
  } else if (!scr_fs_path_chk(path, "path")) {
    return;
  }
  scr_throw_lowering_fence(fence);
}
