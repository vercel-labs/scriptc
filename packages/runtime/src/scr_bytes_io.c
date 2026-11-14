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
static bool scr_fs_cb_open_bits(const ScrDyn *flag, const char *fallback, int *bits);

/* ── readFileSync's options argument ────────────────────────────────────
 *
 * Node's readFileSync runs getOptions over the second argument: a string is
 * { encoding }, a function or a nullish value is the defaults, any other
 * non-object is ERR_INVALID_ARG_TYPE, and the encoding (the literal
 * 'buffer' excepted) and the signal are validated, in that order. The path
 * is validated next, then stringToFlags reads the `flag` member (absent or
 * null is O_RDONLY, a number is validateInt32-checked open(2) bits, a name
 * is one of the documented spellings). The file opens with mode 0o666, the
 * whole descriptor is read and closed before a read error propagates, and
 * only a truthy encoding decodes — '' and null answer a Buffer, 'buffer'
 * answers the post-read ERR_UNKNOWN_ENCODING. */

/* One member read off the options argument, the way scr_fs_cb_option does
 * it (a typed-ref box materializes first). +1; NULL with the exception
 * pending. */
static ScrDyn *scr_fs_read_member(const ScrDyn *options, const char *name) {
  ScrDyn *object = (ScrDyn *)options;
  bool materialized = false;
  if (options->kind == SCR_DYN_TYPED_REF) {
    object = scr_dyn_typed_ref_materialize(options);
    if (!object) return NULL;
    materialized = true;
  }
  ScrDyn *value = scr_dyn_obj_read(object, name, strlen(name));
  if (materialized) scr_dyn_release(object);
  return value;
}

/* getOptions' assertEncoding over the value read from `encoding`, or the
 * whole argument when it is a string. Only a truthy value is checked, and
 * 'buffer' is the one name getOptions leaves to the decoder. */
static bool scr_fs_read_encoding_check(const ScrDyn *encoding) {
  if (!encoding || !scr_dyn_truthy(encoding)) return true;
  if (encoding->kind == SCR_DYN_STR &&
      (scr_fs_str_is(encoding->v.str, "buffer") || scr_bytes_is_encoding(encoding->v.str)))
    return true;
  scr_dyn_arg_value_fail("encoding", "is invalid encoding", encoding);
  return false;
}

/* getOptions' validateAbortSignal over the member: only undefined skips it,
 * and the synchronous read validates the signal without acting on an
 * aborted one (no checkAborted in readFileSync). */
static bool scr_fs_read_signal_check(const ScrDyn *signal) {
  if (signal->kind == SCR_DYN_UNDEF) return true;
  if (signal->kind == SCR_DYN_HANDLE && signal->v.handle.tag == SCR_DYNH_ABORT_SIGNAL) return true;
  scr_dyn_arg_type_fail("options.signal", "an instance of AbortSignal", signal);
  return false;
}

/* validateReadFileBufferOptions over a view options argument: reading
 * options.buffer finds the TypedArray prototype's ArrayBuffer, never a
 * view, so every ArrayBufferView is rejected while a plain ArrayBuffer or
 * SharedArrayBuffer carries no such member and passes. Always false with
 * the exception pending. */
static bool scr_fs_view_options_fail(void) {
  static const char msg[] =
      "The \"options.buffer\" property must be of type function or an instance of "
      "Buffer, TypedArray, or DataView. Received an instance of ArrayBuffer";
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
  return false;
}

/* The normalized options argument: the bag itself when it is one (NULL
 * otherwise), the encoding member (+1, NULL when absent or falsy), and the
 * user buffer (+1, NULL when absent): a factory or a Buffer/TypedArray/
 * DataView to read into. */
typedef struct {
  const ScrDyn *object;
  ScrDyn *encoding;
  ScrDyn *buffer;
} ScrFsReadOptions;

static void scr_fs_read_options_release(ScrFsReadOptions *options) {
  if (options->encoding) scr_dyn_release(options->encoding);
  if (options->buffer) scr_dyn_release(options->buffer);
  options->encoding = NULL;
  options->buffer = NULL;
}

/* getOptions' normalization and checks. False with the exception pending. */
static bool scr_fs_read_options_read(const ScrDyn *options, ScrFsReadOptions *out) {
  out->object = NULL;
  out->encoding = NULL;
  out->buffer = NULL;
  if (options->kind == SCR_DYN_UNDEF || options->kind == SCR_DYN_NULL ||
      options->kind == SCR_DYN_FUNC)
    return true;
  if (options->kind == SCR_DYN_STR) {
    /* getOptions turns a string into { encoding: string }; a falsy encoding
     * is Node's Buffer answer. */
    ScrDyn *encoding = scr_dyn_retain((ScrDyn *)options);
    if (!scr_fs_read_encoding_check(encoding)) {
      scr_dyn_release(encoding);
      return false;
    }
    if (scr_dyn_truthy(encoding)) out->encoding = encoding;
    else scr_dyn_release(encoding);
    return true;
  }
  switch (options->kind) {
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_BIGINT:
  case SCR_DYN_SYMBOL:
    scr_dyn_arg_type_fail("options", "one of type string or object", options);
    return false;
  case SCR_DYN_BYTES: {
    /* An object reaches assertEncoding with its own `encoding` before the
     * binding's buffer check rejects the view. */
    ScrDyn *encoding = scr_fs_read_member(options, "encoding");
    bool valid = encoding && scr_fs_read_encoding_check(encoding);
    scr_dyn_release(encoding);
    if (!valid) return false;
    return scr_fs_view_options_fail();
  }
  default:
    break;
  }
  out->object = options;
  ScrDyn *encoding = scr_fs_read_member(options, "encoding");
  if (!encoding) return false;
  if (!scr_fs_read_encoding_check(encoding)) {
    scr_dyn_release(encoding);
    return false;
  }
  if (scr_dyn_truthy(encoding)) out->encoding = encoding;
  else scr_dyn_release(encoding);
  ScrDyn *signal = scr_fs_read_member(options, "signal");
  if (!signal) {
    scr_fs_read_options_release(out);
    return false;
  }
  bool ok = scr_fs_read_signal_check(signal);
  scr_dyn_release(signal);
  if (!ok) {
    scr_fs_read_options_release(out);
    return false;
  }
  /* validateReadFileBufferOptions reads `buffer` last, before the path is
   * validated and the file opens: an invalid value must not truncate a file
   * a 'w+' flag would open. Only undefined, a function and an
   * ArrayBufferView pass; a view is read into directly, a function is called
   * with the file size. */
  ScrDyn *buffer = scr_fs_read_member(options, "buffer");
  if (!buffer) {
    scr_fs_read_options_release(out);
    return false;
  }
  if (buffer->kind != SCR_DYN_UNDEF) {
    if (buffer->kind != SCR_DYN_FUNC && buffer->kind != SCR_DYN_BYTES) {
      scr_dyn_prop_type_fail("options.buffer",
                             "of type function or an instance of Buffer, TypedArray, or DataView",
                             buffer);
      scr_dyn_release(buffer);
      scr_fs_read_options_release(out);
      return false;
    }
    out->buffer = buffer;
  } else {
    scr_dyn_release(buffer);
  }
  return true;
}

/* getValidatedPath, then stringToFlags over the `flag` member, then open(2)
 * with Node's 0o666: the descriptor, or -1 with the exception pending. */
static int scr_fs_read_options_open(const ScrStr *path, const ScrDyn *options, const ScrFsReadOptions *read) {
  if (!scr_fs_path_ok(path, "path")) return -1;
  ScrDyn *flag = read->object ? scr_fs_read_member(read->object, "flag") : NULL;
  if (!flag && scr_exc_pending()) return -1;
  int bits;
  bool ok = scr_fs_cb_open_bits(flag, "r", &bits);
  if (flag) scr_dyn_release(flag);
  if (!ok) return -1;
  int fd = scr_fs_raw_open(path->data, bits, 0666);
  if (fd < 0) scr_fs_throw(-fd, "open", path);
  return fd;
}

/* tryStatSync's size: a regular file's size, else 0 (the descriptor then
 * reads to EOF, which is what a pipe or character device needs). Never
 * throws. */
static double scr_fs_file_size(int fd) {
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
  return (double)st.st_size;
}

/* The name Node's too-small ERR_INVALID_ARG_VALUE reports: the property it
 * read the byteLength from. */
static const char *scr_fs_user_buffer_len_name(const ScrDyn *option) {
  return option->kind == SCR_DYN_FUNC ? "options.buffer().byteLength"
                                      : "options.buffer.byteLength";
}

/* getReadFileBuffer: a factory is called as a method of the options object
 * (`options.buffer(size)`), so `this` is the options; its answer must be an
 * ArrayBufferView. A non-Buffer view becomes a u8 Buffer over exactly its
 * bytes (Node's Buffer.from(buffer.buffer, byteOffset, byteLength)); a buffer
 * smaller than the file throws. +1; NULL with the exception pending. */
static ScrBytes *scr_fs_user_buffer(const ScrDyn *option, double size, const ScrDyn *receiver) {
  bool factory = option->kind == SCR_DYN_FUNC;
  ScrDyn *value;
  if (factory) {
    ScrDyn *arg = scr_dyn_new_num(size);
    scr_dyn_this_push_dyn(receiver);
    value = scr_dyn_call(option, &arg, 1, "options.buffer");
    scr_dyn_this_pop();
    scr_dyn_release(arg);
    if (!value) return NULL;
    if (value->kind != SCR_DYN_BYTES) {
      scr_dyn_prop_type_fail("options.buffer()",
                             "an instance of Buffer, TypedArray, or DataView", value);
      scr_dyn_release(value);
      return NULL;
    }
  } else {
    value = scr_dyn_retain((ScrDyn *)option);
  }
  ScrBytes *src = scr_dyn_bytes_unbox(value);
  double byte_length = scr_bytes_byte_len(src);
  if (size > byte_length) {
    char reason[64];
    snprintf(reason, sizeof reason, "is smaller than the file size of %.0f bytes", size);
    ScrDyn *got = scr_dyn_new_num(byte_length);
    scr_dyn_arg_value_fail(scr_fs_user_buffer_len_name(option), reason, got);
    scr_dyn_release(got);
    scr_bytes_release(src);
    scr_dyn_release(value);
    return NULL;
  }
  if (value->buffer) {
    scr_dyn_release(value);
    return src;
  }
  ScrBytes *view = scr_bytes_buffer_view(src, SCR_BYTES_U8, scr_bytes_byte_offset(src), true,
                                         byte_length);
  scr_bytes_release(src);
  scr_dyn_release(value);
  if (!view) return NULL;
  ScrBytes *buffer = scr_bytes_as_buffer(view);
  scr_bytes_release(view);
  return buffer;
}

/* Node's user-buffer read ladder over an open descriptor: a regular file's
 * size bytes, else the buffer is filled and one extra byte decides whether
 * it holds the entire file. Returns the bytes read, or -1 with the
 * exception pending. */
static double scr_fs_read_user_buffer(int fd, ScrBytes *buffer, double size, const ScrDyn *option) {
  double pos = 0;
  if (size != 0) {
    double n;
    do {
      n = scr_fs_read_sync(fd, buffer, pos, size - pos, -1);
      if (scr_exc_pending()) return -1;
      pos += n;
    } while (n != 0 && pos < size);
    return pos;
  }
  while (pos < (double)buffer->len) {
    double n = scr_fs_read_sync(fd, buffer, pos, (double)buffer->len - pos, -1);
    if (scr_exc_pending()) return -1;
    pos += n;
    if (n == 0) return pos;
  }
  ScrBytes *extra = scr_bytes_new(SCR_BYTES_U8, 1);
  double n = scr_fs_read_sync(fd, extra, 0, 1, -1);
  scr_bytes_release(extra);
  if (scr_exc_pending()) return -1;
  if (n != 0) {
    ScrDyn *got = scr_dyn_new_num((double)buffer->len);
    scr_dyn_arg_value_fail(scr_fs_user_buffer_len_name(option),
                           "is too small to contain the entire file", got);
    scr_dyn_release(got);
    return -1;
  }
  return pos;
}

/* Reads an open descriptor to its end and closes it: into options.buffer
 * when the options named one (answering the view of the bytes read), else
 * into a fresh Buffer. +1; NULL with the exception pending. The descriptor
 * is closed either way. */
static ScrBytes *scr_fs_read_sync_result(int fd, const ScrFsReadOptions *read) {
  if (!read->buffer) {
    ScrBytes *bytes = scr_fs_read_fd_bytes((double)fd);
    int saved = errno;
    scr_fs_raw_close(fd);
    errno = saved;
    return bytes;
  }
  double size = scr_fs_file_size(fd);
  ScrBytes *buffer = scr_fs_user_buffer(read->buffer, size, read->object);
  double pos = buffer ? scr_fs_read_user_buffer(fd, buffer, size, read->buffer) : -1;
  int saved = errno;
  scr_fs_raw_close(fd);
  errno = saved;
  if (pos < 0) {
    scr_bytes_release(buffer);
    return NULL;
  }
  ScrBytes *answer = scr_bytes_subarray(buffer, 0, pos);
  scr_bytes_release(buffer);
  return answer;
}

/* readFileSync(path, { encoding, flag }) answering a string: the truthy
 * encoding decodes (a falsy one is Node's Buffer answer, which this entry
 * cannot carry; the call site's type selected the string arm). */
ScrStr *scr_fs_read_file_str_opts(ScrStr *path, const ScrDyn *options) {
  ScrFsReadOptions read;
  if (!scr_fs_read_options_read(options, &read)) return NULL;
  int fd = scr_fs_read_options_open(path, options, &read);
  if (fd < 0) {
    scr_fs_read_options_release(&read);
    return NULL;
  }
  ScrStr *text;
  if (read.buffer) {
    /* A user buffer takes Node's buffer path even for utf8: the bytes fill
     * the buffer and a truthy encoding decodes from there. */
    ScrBytes *bytes = scr_fs_read_sync_result(fd, &read);
    if (!bytes) {
      scr_fs_read_options_release(&read);
      return NULL;
    }
    if (read.encoding) text = scr_fs_decode_read(bytes, read.encoding->v.str);
    else {
      ScrStr *utf8 = scr_str_new("utf8", 4);
      text = scr_bytes_to_str(bytes, utf8);
      scr_str_release(utf8);
      scr_bytes_release(bytes);
    }
  } else {
    if (read.encoding && !scr_bytes_encoding_is_utf8(read.encoding->v.str))
      text = scr_fs_decode_read(scr_fs_read_fd_bytes((double)fd), read.encoding->v.str);
    else text = scr_fs_read_fd((double)fd);
    scr_fs_raw_close(fd);
  }
  scr_fs_read_options_release(&read);
  return text;
}

/* readFileSync(path, { encoding, flag }) answering a Buffer: the same
 * ladder; a statically Buffer-typed call has no encoding, so the raw bytes
 * are the answer. */
ScrBytes *scr_fs_read_file_bytes_opts(ScrStr *path, const ScrDyn *options) {
  ScrFsReadOptions read;
  if (!scr_fs_read_options_read(options, &read)) return NULL;
  int fd = scr_fs_read_options_open(path, options, &read);
  if (fd < 0) {
    scr_fs_read_options_release(&read);
    return NULL;
  }
  ScrBytes *bytes = scr_fs_read_sync_result(fd, &read);
  scr_fs_read_options_release(&read);
  return bytes;
}

/* The unchecked answer (a JS helper's untyped `enc` parameter —
 * test/common fixtures.js): a string or Buffer dyn value, chosen by the
 * encoding at run time. +1 dyn value, or NULL with the exception pending. */
ScrDyn *scr_fs_read_file_sync_dyn(ScrStr *path, const ScrDyn *options) {
  ScrFsReadOptions read;
  if (!scr_fs_read_options_read(options, &read)) return NULL;
  int fd = scr_fs_read_options_open(path, options, &read);
  if (fd < 0) {
    scr_fs_read_options_release(&read);
    return NULL;
  }
  ScrDyn *value = NULL;
  if (!read.buffer && read.encoding && scr_bytes_encoding_is_utf8(read.encoding->v.str)) {
    /* Node's utf8 binding reads straight into string storage; a user buffer
     * cannot be in the way here. */
    ScrStr *text = scr_fs_read_fd((double)fd);
    scr_fs_raw_close(fd);
    if (text) {
      value = scr_dyn_new_str(text);
      scr_str_release(text);
    }
  } else {
    ScrBytes *bytes = scr_fs_read_sync_result(fd, &read);
    if (bytes) {
      if (!read.encoding) {
        value = scr_dyn_new_buffer(bytes);
        scr_bytes_release(bytes);
      } else {
        /* scr_fs_decode_read consumes the bytes. */
        ScrStr *text = scr_fs_decode_read(bytes, read.encoding->v.str);
        if (text) {
          value = scr_dyn_new_str(text);
          scr_str_release(text);
        }
      }
    }
  }
  scr_fs_read_options_release(&read);
  return value;
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

static bool scr_fs_bigint_position_chk(ScrBigInt *position, double length);
static double scr_fs_int32(double n);

static ScrDyn *scr_fs_cb_option(const ScrDyn *options, const char *name) {
  if (scr_fs_dyn_absent(options)) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *object = options->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(options) : scr_dyn_retain((ScrDyn *)options);
  if (!object) return NULL;
  ScrDyn *value = scr_dyn_obj_read(object, name, strlen(name));
  scr_dyn_release(object);
  return value;
}

/* Whether the options bag carries `name` as an own key. Node validates the
 * value even when it is undefined, so presence differs from a non-absent
 * read. */
static bool scr_fs_cb_option_present(const ScrDyn *options, const char *name) {
  if (scr_fs_dyn_absent(options)) return false;
  ScrStr *key = scr_str_new(name, strlen(name));
  bool present = scr_dyn_has_own(options, key);
  scr_str_release(key);
  return present;
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

/* checkAborted's `signal.aborted` and `signal.reason` reads. Node reaches
 * them through an ordinary property access on its own fresh read of
 * options.signal, so the value need not be the AbortSignal that
 * validateAbortSignal saw: a stateful getter may answer an array, a number
 * or a plain object on that read. scr_dyn_obj_read answers those values'
 * members (undefined when the value has none) and never dispatches a
 * non-handle as a native handle. */
static ScrDyn *scr_fs_cb_aborted_member(const ScrDyn *signal, const char *name) {
  return scr_dyn_obj_read(signal, name, strlen(name));
}

/* The AbortError Node's checkAborted hands the stat callback: name
 * AbortError, code ABORT_ERR, the signal's reason as cause. +1 dyn error. */
static ScrDyn *scr_fs_cb_abort_error_dyn(const ScrDyn *signal) {
  static const char message[] = "The operation was aborted";
  ScrStr *text = scr_str_new(message, sizeof message - 1);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_str_release(error->name);
  error->name = scr_str_new("AbortError", 10);
  error->name_present = true;
  scr_error_set_code(error, "ABORT_ERR");
  ScrDyn *reason = scr_fs_cb_aborted_member(signal, "reason");
  if (reason) {
    if (reason->kind != SCR_DYN_UNDEF) scr_error_set_cause(error, reason);
    scr_dyn_release(reason);
  }
  scr_throw_obj(error, scr_error_retain_v, scr_error_release_v, scr_error_trace_arg());
  ScrCaught *caught = scr_exc_take();
  ScrDyn *value = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  return value;
}

/* Node's checkAborted(signal, callback) after fs.stat's path check: an
 * aborted signal runs the callback SYNCHRONOUSLY with the AbortError and the
 * call answers undefined — not a later turn. True when the stat proceeds. */
static bool scr_fs_cb_stat_aborted(const ScrDyn *options, const ScrDyn *callback) {
  ScrDyn *signal = scr_fs_cb_option(options, "signal");
  if (!signal) return false;
  if (scr_fs_dyn_absent(signal)) { scr_dyn_release(signal); return true; }
  ScrDyn *aborted = scr_fs_cb_aborted_member(signal, "aborted");
  bool cancelled = aborted && scr_dyn_truthy(aborted);
  scr_dyn_release(aborted);
  if (!cancelled) { scr_dyn_release(signal); return true; }
  ScrDyn *error = scr_fs_cb_abort_error_dyn(signal);
  scr_dyn_release(signal);
  if (!error) return false;
  ScrDyn *arguments = scr_dyn_new_arr();
  scr_dyn_arr_push(arguments, error);
  ScrDyn *result = scr_dyn_apply(callback, arguments, "the filesystem callback");
  scr_dyn_release(result);
  scr_dyn_release(arguments);
  return false;
}

/* fs.stat's getOptions, run before its callback check: a function, null or
 * non-object options value is the empty default; an object's encoding is
 * read for the 'buffer' comparison and, when it is not that, read again for
 * assertEncoding (falsy values pass), then a signal member that is not
 * undefined goes through validateAbortSignal (a second read). *normalized
 * is the value the binding then reads (undefined for the empty default). */
static bool scr_fs_cb_stat_options(const ScrDyn *options, const ScrDyn **normalized) {
  *normalized = options;
  if (scr_fs_dyn_absent(options) || options->kind == SCR_DYN_FUNC) { *normalized = scr_dyn_undefined(); return true; }
  if (options->kind != SCR_DYN_OBJ && options->kind != SCR_DYN_ARR &&
      options->kind != SCR_DYN_TYPED_REF && options->kind != SCR_DYN_BYTES &&
      options->kind != SCR_DYN_HANDLE && options->kind != SCR_DYN_PROXY) {
    *normalized = scr_dyn_undefined();
    return true;
  }
  ScrDyn *encoding = scr_fs_cb_option(options, "encoding");
  if (!encoding) return false;
  bool buffer = encoding->kind == SCR_DYN_STR && scr_fs_str_is(encoding->v.str, "buffer");
  scr_dyn_release(encoding);
  if (!buffer) {
    ScrDyn *value = scr_fs_cb_option(options, "encoding");
    if (!value) return false;
    bool valid = scr_fs_read_encoding_check(value);
    scr_dyn_release(value);
    if (!valid) return false;
  }
  ScrDyn *signal = scr_fs_cb_option(options, "signal");
  if (!signal) return false;
  if (signal->kind == SCR_DYN_UNDEF) { scr_dyn_release(signal); return true; }
  ScrDyn *value = scr_fs_cb_option(options, "signal");
  if (!value) { scr_dyn_release(signal); return false; }
  bool valid = scr_fs_read_signal_check(value);
  scr_dyn_release(value);
  scr_dyn_release(signal);
  return valid;
}

/* writeFile/appendFile's getOptions, run before the path is looked at:
 * null, undefined and functions take the defaults; a string is the
 * encoding; any other non-object throws. An object's `encoding` is read
 * for the 'buffer' comparison and, unless it is that name, read again for
 * assertEncoding; a `signal` member that is not undefined is validated
 * after the encoding (Node's order), with `options.signal` read twice. */
static bool scr_fs_cb_write_options(const ScrDyn *options) {
  if (scr_fs_dyn_absent(options) || options->kind == SCR_DYN_FUNC) return true;
  if (options->kind == SCR_DYN_STR) return scr_fs_read_encoding_check(options);
  /* getOptions tests typeof: every object-like box is an options record
   * (its reads answer undefined for the keys it does not carry), and the
   * primitives other than a string are the type error. */
  if (options->kind == SCR_DYN_BOOL || options->kind == SCR_DYN_NUM ||
      options->kind == SCR_DYN_BIGINT || options->kind == SCR_DYN_SYMBOL) {
    scr_dyn_arg_type_fail("options", "one of type string or object", options);
    return false;
  }
  ScrDyn *encoding = scr_fs_cb_option(options, "encoding");
  if (!encoding) return false;
  bool buffer = encoding->kind == SCR_DYN_STR && encoding->v.str->len == 6 &&
                memcmp(encoding->v.str->data, "buffer", 6) == 0;
  scr_dyn_release(encoding);
  if (!buffer) {
    ScrDyn *value = scr_fs_cb_option(options, "encoding");
    if (!value) return false;
    bool valid = scr_fs_read_encoding_check(value);
    scr_dyn_release(value);
    if (!valid) return false;
  }
  ScrDyn *signal = scr_fs_cb_option(options, "signal");
  if (!signal) return false;
  if (signal->kind == SCR_DYN_UNDEF) { scr_dyn_release(signal); return true; }
  ScrDyn *value = scr_fs_cb_option(options, "signal");
  if (!value) { scr_dyn_release(signal); return false; }
  bool valid = scr_fs_read_signal_check(value);
  scr_dyn_release(value);
  scr_dyn_release(signal);
  return valid;
}

/* writeFile's `const flush = options.flush ?? false; validateBoolean(flush,
 * 'options.flush')`: undefined, null and booleans pass, every other value
 * throws Node's property-shaped ERR_INVALID_ARG_TYPE. A function in the
 * options position is the callback, and a string supplies the encoding
 * only; both are the defaults record here, whose flush is false. */
static bool scr_fs_cb_write_flush(const ScrDyn *options, bool *flush) {
  *flush = false;
  if (scr_fs_dyn_absent(options) || options->kind == SCR_DYN_FUNC || options->kind == SCR_DYN_STR)
    return true;
  ScrDyn *value = scr_fs_cb_option(options, "flush");
  if (!value) return false;
  bool ok = true;
  if (value->kind == SCR_DYN_BOOL) *flush = value->v.b;
  else if (value->kind != SCR_DYN_UNDEF && value->kind != SCR_DYN_NULL) {
    scr_dyn_prop_type_fail("options.flush", "of type boolean", value);
    ok = false;
  }
  scr_dyn_release(value);
  return ok;
}

/* Buffer.from(string, "buffer"), the one name assertEncoding lets through:
 * the decoder rejects it with ERR_UNKNOWN_ENCODING. */
static void scr_fs_cb_write_unknown_buffer(const ScrStr *encoding) {
  ScrStr *normalized = scr_bytes_normalize_encoding(encoding);
  scr_str_release(normalized);
}

/* writeFile's data check, then the string conversion it does at the call:
 * a value that is not an ArrayBufferView must be a string (Node's
 * validateStringAfterArrayBufferView), and a string encoded through
 * "buffer" throws at Buffer.from before the path is seen. */
static bool scr_fs_cb_write_data(const ScrDyn *data, const ScrDyn *options) {
  if (data->kind == SCR_DYN_STR) {
    ScrDyn *encoding = options->kind == SCR_DYN_STR
                           ? scr_dyn_retain((ScrDyn *)options)
                           : scr_fs_cb_option(options, "encoding");
    if (!encoding) return false;
    bool buffer = encoding->kind == SCR_DYN_STR && encoding->v.str->len == 6 &&
                  memcmp(encoding->v.str->data, "buffer", 6) == 0;
    if (buffer) scr_fs_cb_write_unknown_buffer(encoding->v.str);
    scr_dyn_release(encoding);
    if (buffer) return false;
    return true;
  }
  if (data->kind == SCR_DYN_BYTES) return true;
  scr_dyn_arg_type_fail("data", "of type string or an instance of Buffer, TypedArray, or DataView",
                        data);
  return false;
}

/* Node's isFd = isInt32: an int32 path is the descriptor the write targets
 * without an open, negative values included (the write binding is what
 * rejects those, with its fd range check). */
static bool scr_fs_cb_write_fd(const ScrDyn *path, double *fd) {
  if (path->kind != SCR_DYN_NUM) return false;
  double value = path->v.num;
  if (!(isfinite(value) && trunc(value) == value) || value < -2147483648.0 ||
      value > 2147483647.0)
    return false;
  *fd = value;
  return true;
}

/* Node's checkAborted for writeFile's path form (writeAll's own check for
 * the descriptor form): an aborted signal runs the callback SYNCHRONOUSLY
 * with the AbortError and the call answers undefined. True when the
 * callback ran, so the call is over. */
static bool scr_fs_cb_write_aborted(const ScrDyn *options, const ScrDyn *callback) {
  if (scr_fs_dyn_absent(options) || options->kind == SCR_DYN_FUNC || options->kind == SCR_DYN_STR)
    return false;
  ScrDyn *signal = scr_fs_cb_option(options, "signal");
  if (!signal) return false;
  if (scr_fs_dyn_absent(signal)) { scr_dyn_release(signal); return false; }
  ScrDyn *aborted = scr_fs_cb_aborted_member(signal, "aborted");
  bool cancelled = aborted && scr_dyn_truthy(aborted);
  scr_dyn_release(aborted);
  if (!cancelled) { scr_dyn_release(signal); return false; }
  ScrDyn *error = scr_fs_cb_abort_error_dyn(signal);
  scr_dyn_release(signal);
  if (!error) return false;
  ScrDyn *arguments = scr_dyn_new_arr();
  scr_dyn_arr_push(arguments, error);
  ScrDyn *result = scr_dyn_apply(callback, arguments, "the filesystem callback");
  scr_dyn_release(result);
  scr_dyn_release(arguments);
  return true;
}

/* Whether a length-delimited name is one of stringToFlags' spellings. The
 * length is the string's own, so an embedded NUL is part of the name and
 * never a terminator: "r\0x" is not "r" to Node either. */
static bool scr_fs_flag_is(const char *s, size_t len, const char *want) {
  size_t want_len = strlen(want);
  return len == want_len && memcmp(s, want, want_len) == 0;
}

/* stringToFlags for the string spellings; -1 for an unknown one. */
static int scr_fs_flag_bits(const char *s, size_t len) {
  if (scr_fs_flag_is(s, len, "r")) return O_RDONLY;
  if (scr_fs_flag_is(s, len, "r+")) return O_RDWR;
  if (scr_fs_flag_is(s, len, "rs") || scr_fs_flag_is(s, len, "sr")) return O_RDONLY | O_SYNC;
  if (scr_fs_flag_is(s, len, "rs+") || scr_fs_flag_is(s, len, "sr+")) return O_RDWR | O_SYNC;
  if (scr_fs_flag_is(s, len, "w")) return O_WRONLY | O_CREAT | O_TRUNC;
  if (scr_fs_flag_is(s, len, "w+")) return O_RDWR | O_CREAT | O_TRUNC;
  if (scr_fs_flag_is(s, len, "wx") || scr_fs_flag_is(s, len, "xw"))
    return O_WRONLY | O_CREAT | O_TRUNC | O_EXCL;
  if (scr_fs_flag_is(s, len, "wx+") || scr_fs_flag_is(s, len, "xw+"))
    return O_RDWR | O_CREAT | O_TRUNC | O_EXCL;
  if (scr_fs_flag_is(s, len, "a")) return O_WRONLY | O_CREAT | O_APPEND;
  if (scr_fs_flag_is(s, len, "a+")) return O_RDWR | O_CREAT | O_APPEND;
  if (scr_fs_flag_is(s, len, "ax") || scr_fs_flag_is(s, len, "xa"))
    return O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
  if (scr_fs_flag_is(s, len, "ax+") || scr_fs_flag_is(s, len, "xa+"))
    return O_RDWR | O_CREAT | O_APPEND | O_EXCL;
  if (scr_fs_flag_is(s, len, "as") || scr_fs_flag_is(s, len, "sa"))
    return O_WRONLY | O_CREAT | O_APPEND | O_SYNC;
  if (scr_fs_flag_is(s, len, "as+") || scr_fs_flag_is(s, len, "sa+"))
    return O_RDWR | O_CREAT | O_APPEND | O_SYNC;
  return -1;
}

/* stringToFlags' refusal: Node's ERR_INVALID_ARG_VALUE with the received
 * flag rendered by util.inspect and truncated the way errors.js truncates
 * it (128 UTF-16 units plus "..."), so the message is sized from the
 * string it shows. A flag of any length, NUL bytes included, stays inside
 * the string's own bytes. */
static void scr_fs_flag_invalid(const ScrStr *f) {
  ScrStr *shown = scr_str_inspect_quoted(f, true);
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "The argument 'flags' is invalid. Received ");
  scr_jb_put_str(&message, shown);
  scr_str_release(shown);
  ScrStr *text = scr_jb_finish(&message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(text);
}

/* stringToFlags over a dynamic value: an absent flag is the caller's
 * fallback string, a number goes through validateInt32 and IS the open(2)
 * bit set the binding receives under Node, a string is one of the
 * documented spellings, and anything else is Node's
 * ERR_INVALID_ARG_VALUE. False with the error thrown; a passing value
 * reaches *bits. */
static bool scr_fs_cb_open_bits(const ScrDyn *flag, const char *fallback, int *bits) {
  if (flag == NULL || scr_fs_dyn_absent(flag)) {
    *bits = scr_fs_flag_bits(fallback, strlen(fallback));
    return true;
  }
  if (flag->kind == SCR_DYN_NUM) {
    double parsed;
    if (!scr_fs_flags_number_valid(flag->v.num, &parsed)) return false;
    *bits = (int)parsed;
    return true;
  }
  if (flag->kind != SCR_DYN_STR) {
    scr_dyn_arg_value_fail("flags", NULL, flag);
    return false;
  }
  int of = scr_fs_flag_bits(flag->v.str->data, flag->v.str->len);
  if (of < 0) {
    scr_fs_flag_invalid(flag->v.str);
    return false;
  }
  *bits = of;
  return true;
}

/* open's flags check, which Node runs before its callback check. */
static bool scr_fs_cb_open_flags(const ScrDyn *flag) {
  int bits;
  return scr_fs_cb_open_bits(flag, "r", &bits);
}

static double scr_fs_cb_open(const ScrStr *path, const ScrDyn *flag, double mode, const char *fallback) {
  int bits;
  if (!scr_fs_cb_open_bits(flag, fallback, &bits)) return -1;
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

/* The stat family's options member read at run time. Node passes the value
 * straight to the binding: `options.bigint` picks the BigIntStats member
 * table on the literal true only, and `options.throwIfNoEntry` answers
 * undefined for a missing entry on the literal false only. A member read is
 * an ordinary JavaScript property read, so a null options value throws
 * V8's TypeError and primitives simply have no member. `options` is never
 * undefined here: the signature's default applies for an undefined
 * argument, which the callback forms spell as an empty options value. */
static ScrDyn *scr_fs_stat_member(const ScrDyn *options, const char *name, bool *ok) {
  *ok = true;
  if (options->kind == SCR_DYN_NULL) {
    char message[80];
    int length = snprintf(message, sizeof message, "Cannot read properties of null (reading '%s')", name);
    scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)length);
    *ok = false;
    return NULL;
  }
  return scr_fs_cb_option(options, name);
}

static bool scr_fs_int_range_chk(const ScrDyn *, const char *, double, double, const char *);

static bool scr_fs_stat_bigint_member(const ScrDyn *options) {
  bool ok;
  ScrDyn *value = scr_fs_stat_member(options, "bigint", &ok);
  if (!ok) return false;
  bool bigint = value && value->kind == SCR_DYN_BOOL && value->v.b;
  scr_dyn_release(value);
  return bigint;
}

/* Whether a missing entry throws: the binding swallows it for the literal
 * false alone. *ok is false with the exception a member read threw. */
static bool scr_fs_stat_throws_member(const ScrDyn *options, bool *ok) {
  ScrDyn *value = scr_fs_stat_member(options, "throwIfNoEntry", ok);
  if (!*ok) return true;
  bool suppress = value && value->kind == SCR_DYN_BOOL && !value->v.b;
  scr_dyn_release(value);
  return !suppress;
}

/* statSync/lstatSync(path, options) with a run-time options value: bigint
 * selects the member table, then throwIfNoEntry selects the missing-entry
 * answer. A suppressed miss answers the dynamic undefined value. */
static ScrDyn *scr_fs_stat_sync_dyn_core(ScrStr *path, const ScrDyn *options, bool no_follow) {
  bool bigint = scr_fs_stat_bigint_member(options);
  if (scr_exc_pending()) return NULL;
  bool ok;
  bool throws = scr_fs_stat_throws_member(options, &ok);
  if (!ok) return NULL;
  ScrStats *snapshot = scr_fs_stat_probe(path, no_follow, throws);
  if (!snapshot) {
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  ScrDyn *object = scr_stats_dyn(snapshot, bigint);
  scr_stats_release(snapshot);
  return object;
}

ScrDyn *scr_fs_stat_sync_dyn(ScrStr *path, const ScrDyn *options) {
  return scr_fs_stat_sync_dyn_core(path, options, false);
}

ScrDyn *scr_fs_lstat_sync_dyn(ScrStr *path, const ScrDyn *options) {
  return scr_fs_stat_sync_dyn_core(path, options, true);
}

/* fstatSync(fd, options): an open descriptor cannot miss, so Node passes the
 * throw flag as the literal false. The option is read before the binding
 * validates the descriptor, so a throwing bigint read beats a bad fd. */
ScrDyn *scr_fs_fstat_sync_dyn(const ScrDyn *fd, const ScrDyn *options) {
  bool bigint = scr_fs_stat_bigint_member(options);
  if (scr_exc_pending()) return NULL;
  if (!scr_fs_int_range_chk(fd, "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  ScrStats *snapshot = scr_fs_fstat(fd->v.num);
  if (!snapshot) return NULL;
  ScrDyn *object = scr_stats_dyn(snapshot, bigint);
  scr_stats_release(snapshot);
  return object;
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

/* Node hands stat's binding the throwIfNoEntry value; the binding suppresses
 * a missing entry for the LITERAL false alone. lstat and fstat never pass it
 * (their options.throwIfNoEntry is ignored), and a non-boolean value keeps
 * the error. */
static bool scr_fs_cb_stat_suppressed(const ScrDyn *options) {
  ScrDyn *value = scr_fs_cb_option(options, "throwIfNoEntry");
  bool suppressed = value && value->kind == SCR_DYN_BOOL && !value->v.b;
  scr_dyn_release(value);
  return suppressed;
}

static ScrDyn *scr_fs_cb_stats(const ScrStr *path, double fd, bool nofollow, bool suppressed,
                               bool bigint) {
  ScrStats *snapshot;
  if (!path) snapshot = scr_fs_fstat(fd);
  else if (nofollow) snapshot = scr_fs_lstat((ScrStr *)path);
  else if (suppressed) {
    /* A missing entry answers the callback's (null, undefined) — the
     * second argument is present and undefined, as Node's
     * makeStatsCallback reports it; any other failure still throws. */
    snapshot = scr_fs_stat_probe((ScrStr *)path, false, false);
    if (!snapshot && !scr_exc_pending()) return scr_dyn_retain(scr_dyn_undefined());
  } else snapshot = scr_fs_stat((ScrStr *)path);
  if (!snapshot) return NULL;
  ScrDyn *object = scr_stats_dyn(snapshot, bigint);
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

#ifndef SCR_LIB
static void scr_fs_cb_throw_thunk(ScrClosure *closure) {
  ScrDyn *error = scr_box_get_ref(closure->caps[0]);
  scr_dyn_throw(error); /* moves */
}

/* fs.close(fd) with no callback runs Node's defaultCloseCallback, which
 * throws a failed close when the request's completion runs: the loop's I/O
 * phase, after timers, as an uncaught exception. */
static void scr_fs_cb_defer_throw(ScrDyn *error) {
  ScrClosure *closure = scr_closure_new((void *)scr_fs_cb_throw_thunk, 1);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], error);
  scr_loop_defer(closure);
}
#endif

static bool scr_fs_read_validate(const ScrDyn *, const ScrDyn *, const ScrDyn *, const ScrDyn *, const ScrDyn *,
                                 double *);
static bool scr_fs_encoding_chk(const ScrDyn *);
static bool scr_fs_int_range_chk(const ScrDyn *, const char *, double, double, const char *);
static bool scr_fs_length_int32(const ScrDyn *, double *);
static bool scr_fs_write_validate(const ScrDyn *, const ScrDyn *, const ScrDyn *);
static bool scr_fs_mode_chk(const ScrDyn *, const char *);
static bool scr_fs_parse_file_mode(const ScrDyn *, const char *, bool, double, double *);

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
  return scr_fs_parse_file_mode(value, name, false, 0, mode);
}

/* Node tests an option member against undefined and then reads it again for
 * its value, so a getter runs twice; a read that throws answers NULL with
 * the exception pending, before anything the option licenses happens. */
static bool scr_fs_cb_member_present(const ScrDyn *options, const char *name, bool *present) {
  ScrDyn *value = scr_fs_cb_option(options, name);
  if (!value) return false;
  *present = value->kind != SCR_DYN_UNDEF;
  scr_dyn_release(value);
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
  bool present = false;
  if (!scr_fs_cb_member_present(options, "recursive", &present)) return false;
  if (present) {
    ScrDyn *value = scr_fs_cb_option(options, "recursive");
    if (!value) return false;
    bool ok = true;
    if (value->kind == SCR_DYN_BOOL) *recursive = value->v.b;
    else {
      scr_dyn_arg_type_fail("options.recursive", "of type boolean", value);
      ok = false;
    }
    scr_dyn_release(value);
    if (!ok) return false;
  }
  if (!scr_fs_cb_member_present(options, "mode", &present)) return false;
  if (present) {
    ScrDyn *value = scr_fs_cb_option(options, "mode");
    if (!value) return false;
    bool ok = scr_fs_cb_file_mode(value, "options.mode", mode);
    scr_dyn_release(value);
    if (!ok) return false;
  }
  return true;
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
  /* fs.realpath.native is Node's realpath binding under a second name, so
   * both spellings take the realpath path. */
  const char *op = !strcmp(member->data, "realpath.native") ? "realpath" : member->data;
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
  if (!strcmp(op, "opendir")) {
    /* fs.opendir(path[, options], callback): validateFunction('callback'),
     * then the path, then the options encoding, then the open. The
     * bufferSize check runs in the Dir constructor, after the open, so an
     * open error still reaches the callback. */
    const ScrDyn *options = scr_fs_cb_arg(args, argc, 1);
    const ScrDyn *callback = options->kind == SCR_DYN_FUNC ? options : scr_fs_cb_arg(args, argc, 2);
    if (!scr_fs_cb_chk(callback, "callback")) return NULL;
    ScrStr *path = scr_fs_checked_path(scr_fs_cb_arg(args, argc, 0), "path");
    if (!path) return NULL;
    if (options->kind == SCR_DYN_FUNC) options = scr_dyn_undefined();
    if (!scr_fs_encoding_chk(options)) { scr_str_release(path); return NULL; }
    bool has_buffer_size = scr_fs_cb_option_present(options, "bufferSize");
    ScrDyn *buffer_value = has_buffer_size ? scr_fs_cb_option(options, "bufferSize") : NULL;
    ScrDir *dir = scr_exc_pending() ? NULL : scr_fs_opendir_raw(path);
    scr_str_release(path);
    if (!dir) {
      scr_dyn_release(buffer_value);
      scr_fs_cb_schedule(callback, NULL, NULL);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    double buffer_size = 32;
    bool valid = !scr_exc_pending();
    if (valid && has_buffer_size) {
      if (!buffer_value || buffer_value->kind != SCR_DYN_NUM) {
        scr_dyn_arg_type_fail("options.bufferSize", "of type number",
                              buffer_value ? buffer_value : scr_dyn_undefined());
        valid = false;
      } else {
        buffer_size = buffer_value->v.num;
      }
    }
    scr_dyn_release(buffer_value);
    if (valid) valid = scr_dir_buffer_size_ok(buffer_size);
    if (!valid) {
      /* The Dir constructor closes the handle, then throws; the throw is
       * the uncaught exception of the completion turn. Library links carry
       * no event loop and refuse the callback surfaces before emission. */
      scr_dir_close(dir);
      scr_dir_release(dir);
#ifndef SCR_LIB
      scr_defer_pending_throw();
#endif
      return scr_dyn_retain(scr_dyn_undefined());
    }
    scr_dir_buffer_size_set(dir, buffer_size);
    ScrDyn *handle = scr_dir_dyn_handle(dir);
    scr_dir_release(dir);
    scr_fs_cb_schedule(callback, handle, NULL);
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
   * (below); every other form checks it here, before its path. fs.close's
   * callback defaults only when it is OMITTED or undefined (Node's
   * `callback = defaultCloseCallback`); null and every other non-callable
   * value goes through makeCallback's check and throws, leaving the
   * descriptor open. */
  bool late = !strcmp(op, "access") || !strcmp(op, "copyFile") || !strcmp(op, "chmod") || !strcmp(op, "open") ||
              !strcmp(op, "mkdir") || !strcmp(op, "fchmod") || !strcmp(op, "ftruncate") || !strcmp(op, "truncate") ||
              !strcmp(op, "read") || !strcmp(op, "write");
  bool optional_callback = !strcmp(op, "close") && callback->kind == SCR_DYN_UNDEF;
  /* fs.stat normalizes its options (getOptions: the encoding check and
   * validateAbortSignal) before makeStatsCallback checks the callback. */
  const ScrDyn *stat_options = NULL;
  if (!strcmp(op, "stat") && !scr_fs_cb_stat_options(scr_fs_cb_arg(args, argc, 1), &stat_options)) {
    scr_arr_release(vectors);
    return NULL;
  }
  if (!late && !optional_callback && !scr_fs_cb_chk(callback, legacy ? "callback" : "cb")) { scr_arr_release(vectors); return NULL; }
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
  /* fstat reads options.bigint (FSReqCallback then the binding) before the
   * binding checks its descriptor; null options fail on that first read. */
  bool fstat_bigint = false;
  if (!strcmp(op, "fstat")) {
    /* A function in the options position is the callback: Node replaces it
     * with the empty default before reading anything from it. */
    const ScrDyn *options = scr_fs_cb_arg(args, argc, 1);
    if (options->kind == SCR_DYN_FUNC) options = scr_dyn_undefined();
    fstat_bigint = scr_fs_stat_bigint_member(options);
    if (!scr_exc_pending()) fstat_bigint = scr_fs_stat_bigint_member(options);
    if (scr_exc_pending()) return NULL;
  }
  if ((!strcmp(op, "fsync") || !strcmp(op, "fstat") || !strcmp(op, "close")) &&
      !scr_fs_int_range_chk(ARG(0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  double mkdir_mode = 0777;
  bool mkdir_recursive = false;
  if (!strcmp(op, "mkdir") && (!scr_fs_cb_mkdir_options(ARG(1), &mkdir_mode, &mkdir_recursive) || !scr_fs_cb_chk(callback, "cb"))) return NULL;
  if (!strcmp(op, "mkdtemp") && !scr_fs_encoding_chk(ARG(1))) return NULL;
  if (!strcmp(op, "readFile")) {
    const ScrDyn *options = ARG(1);
    if (!scr_fs_encoding_chk(options)) return NULL;
    if (options->kind == SCR_DYN_BYTES) {
      /* getOptions takes a view as the options object, so its own
       * `encoding` goes through assertEncoding before the binding's buffer
       * check rejects the view's options.buffer. */
      ScrDyn *encoding = scr_fs_cb_option(options, "encoding");
      bool valid = encoding && scr_fs_read_encoding_check(encoding);
      scr_dyn_release(encoding);
      if (!valid) return NULL;
      scr_fs_view_options_fail();
      return NULL;
    }
    if (options->kind != SCR_DYN_STR && !scr_fs_cb_read_buffer_option(options)) return NULL;
  }
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
  /* The read length after `length |= 0`, converted once (a valueOf call
   * runs once, as in Node). */
  double readLength = 0;
  if (!strcmp(op, "read") && count >= 4 &&
      !scr_fs_read_validate(ARG(0), ARG(1), ARG(2), ARG(3), ARG(4), &readLength))
    return NULL;
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
  /* writeFile and appendFile normalize their options (getOptions, the flush
   * check, then the data conversion), inspect the path for a descriptor and
   * check the signal, all before the path itself is validated: an aborted
   * write runs its callback synchronously and never looks at the path, and
   * an int32 path is a descriptor the write targets without an open, so no
   * flag or mode is parsed for it. A negative descriptor fails fs.write's
   * own fd check with a synchronous throw. */
  bool write_descriptor = false;
  double write_fd = -1;
  bool write_flush = false;
  if (!strcmp(op, "writeFile") || !strcmp(op, "appendFile")) {
    const ScrDyn *options = ARG(2);
    if (!scr_fs_cb_write_options(options) || !scr_fs_cb_write_flush(options, &write_flush) ||
        !scr_fs_cb_write_data(ARG(1), options))
      return NULL;
    write_descriptor = scr_fs_cb_write_fd(ARG(0), &write_fd);
    if (scr_fs_cb_write_aborted(options, callback)) return scr_dyn_retain(scr_dyn_undefined());
    if (write_descriptor) {
      ScrDyn *value = scr_dyn_new_num(write_fd);
      bool ok = scr_fs_int_range_chk(value, "fd", 0, 2147483647.0, ">= 0 && <= 2147483647");
      scr_dyn_release(value);
      if (!ok) return NULL;
    }
  }
  ScrStr *path = descriptor || write_descriptor ? NULL : timestamp ? scr_fs_timestamp_path(ARG(0)) : scr_fs_cb_path(ARG(0), !strcmp(op, "mkdtemp") ? "prefix" : !strcmp(op, "copyFile") ? "src" : !strcmp(op, "rename") ? "oldPath" : "path");
  if (!descriptor && !write_descriptor && !path) return NULL;
  /* writeFile's path form hands fs.open the flag and the mode, and open
   * parses the mode before the flag — both synchronously, after the path
   * check. The descriptor form never parses either. */
  int write_bits = 0;
  double write_mode = 0666;
  if (!descriptor && !write_descriptor && (!strcmp(op, "writeFile") || !strcmp(op, "appendFile"))) {
    const ScrDyn *options = ARG(2);
    const ScrDyn *object = options->kind == SCR_DYN_STR || options->kind == SCR_DYN_FUNC ? NULL : options;
    if (object != NULL) {
      ScrDyn *value = scr_fs_cb_option(object, "mode");
      bool ok = !scr_exc_pending() &&
                scr_fs_parse_file_mode(value, "mode", true, 0666, &write_mode);
      scr_dyn_release(value);
      if (!ok) { scr_str_release(path); return NULL; }
      ScrDyn *flag = scr_fs_cb_option(object, "flag");
      ok = !scr_exc_pending() &&
           scr_fs_cb_open_bits(flag && scr_dyn_truthy(flag) ? flag : NULL,
                               !strcmp(op, "appendFile") ? "a" : "w", &write_bits);
      scr_dyn_release(flag);
      if (!ok) { scr_str_release(path); return NULL; }
    } else {
      scr_fs_cb_open_bits(NULL, !strcmp(op, "appendFile") ? "a" : "w", &write_bits);
    }
  }
  /* fs.stat's checkAborted runs after the path check and before the
   * request: an aborted signal runs the callback synchronously and the
   * call answers undefined. */
  if (!strcmp(op, "stat") && !descriptor && !scr_fs_cb_stat_aborted(stat_options, callback)) {
    scr_str_release(path);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (timestamp && !timestamp_fd && !scr_fs_callback_times(ARG(1), ARG(2), false, &access, &modified)) { scr_str_release(path); return NULL; }
  if ((timestamp_fd || !strcmp(op, "fchown")) && !scr_fs_int_range_chk(ARG(0), "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return NULL;
  double chmod_mode = 0, open_mode = 0666;
  bool checked = true;
  if (!strcmp(op, "copyFile")) checked = scr_fs_path_chk(ARG(1), "dest");
  else if (!strcmp(op, "chmod")) checked = scr_fs_cb_file_mode(ARG(1), "mode", &chmod_mode);
  else if (!strcmp(op, "open")) {
    /* parseFileMode's 0o666 default: Node's open passes it to the mode
     * position, so an omitted, null or undefined mode opens with it. */
    checked = scr_fs_dyn_absent(ARG(2)) || scr_fs_cb_file_mode(ARG(2), "mode", &open_mode);
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
    ScrDyn *encoding = options->kind == SCR_DYN_STR ? scr_dyn_retain((ScrDyn *)options) : scr_fs_cb_option(options, "encoding");
    ScrStr *codec = encoding && encoding->kind == SCR_DYN_STR ? scr_str_retain(encoding->v.str) : scr_str_new("utf8", 4);
    ScrBytes *data = encoding ? scr_buffer_from_dyn(ARG(1), codec) : NULL;
    scr_str_release(codec);
    scr_dyn_release(encoding);
    if (data) {
      double fd = write_descriptor ? write_fd : -1;
      if (!write_descriptor) {
        /* The mode and flag were parsed synchronously above, after the path
         * check; this is the request itself. */
        fd = open(path->data, write_bits, (mode_t)write_mode);
        if (fd < 0) scr_fs_throw(errno, "open", path);
      }
      if (fd >= 0) {
        size_t offset = 0;
        while (offset < data->len && !scr_exc_pending()) {
          double written = scr_fs_write_sync(fd, data, (double)offset, (double)(data->len - offset), -1);
          if (written <= 0) break;
          offset += (size_t)written;
        }
        if (write_flush && !scr_exc_pending()) scr_fs_fsync(fd);
        int saved = errno;
        if (!write_descriptor) close((int)fd);
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
  else if (!strcmp(op, "realpath")) {
    /* getOptions' encoding check, then the walk: the binding (the .native
     * spelling) reports its failure as the 'realpath' syscall, the JS walk
     * as 'lstat'. */
    ScrDyn *encoding = scr_fs_readlink_encoding(count == 2 ? ARG(1) : scr_dyn_undefined());
    if (!encoding) {
      scr_str_release(path);
      return NULL;
    }
    ScrStr *resolved = !strcmp(member->data, "realpath.native") ? scr_fs_realpath_promise(path)
                                                                : scr_fs_realpath(path);
    if (resolved) result = scr_fs_cb_encoded_path(resolved, encoding);
    scr_dyn_release(encoding);
  }
  else if (!strcmp(op, "stat") || !strcmp(op, "lstat")) {
    bool stat = !strcmp(op, "stat");
    /* A function in the options position is the callback (Node's
     * typeof check): lstat reads nothing from it. */
    const ScrDyn *options = scr_fs_cb_arg(args, argc, 1);
    if (options->kind == SCR_DYN_FUNC) options = scr_dyn_undefined();
    if (stat) options = stat_options;
    /* FSReqCallback(options.bigint), then the binding's own read; stat then
     * reads throwIfNoEntry. A throwing read throws at the call. */
    bool bigint = scr_fs_stat_bigint_member(options);
    if (!scr_exc_pending()) bigint = scr_fs_stat_bigint_member(options);
    bool suppressed = stat && scr_fs_cb_stat_suppressed(options);
    if (scr_exc_pending()) { scr_str_release(path); return NULL; }
    result = scr_fs_cb_stats(path, -1, !stat, suppressed, bigint);
  } else if (!strcmp(op, "fstat")) result = scr_fs_cb_stats(NULL, fd, false, false, fstat_bigint);
  else if (!strcmp(op, "close")) {
    if (!optional_callback) scr_fs_close(fd);
    else {
      /* fs.close(fd) without a callback runs Node's defaultCloseCallback,
       * which throws a failed close from a later turn — not at the call.
       * A library link has no event loop, so the exception stays pending
       * there. */
      int status = scr_fs_raw_close((int)fd);
      if (status < 0) {
        scr_fs_throw(-status, "close", NULL);
#ifndef SCR_LIB
        ScrCaught *caught = scr_exc_take();
        ScrDyn *error = scr_caught_to_dyn(caught);
        scr_caught_release(caught);
        scr_fs_cb_defer_throw(error);
#endif
      }
    }
  }
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
      else if (readOp && count >= 4) length = readLength;
      else length = scr_fs_cb_number(ARG(3), "length", length);
      /* The position option is read once, so a getter runs once. A bigint
       * read position takes readSync's range check against `length |= 0`
       * and reads at its exact value: a double would round it past 2^53. */
      ScrDyn *positionValue = ownedBuffer ? scr_fs_cb_option(options, "position")
                                          : scr_dyn_retain(ARG(4));
      bool bigPosition = readOp && positionValue && positionValue->kind == SCR_DYN_BIGINT;
      double position = bigPosition || !positionValue
                            ? -1
                            : scr_fs_cb_number(positionValue, "position", -1);
      if (!scr_exc_pending()) {
        if (bigPosition) {
          double count32 = scr_fs_int32(length);
          if (scr_fs_read_offset_chk(offset) &&
              scr_fs_bigint_position_chk(positionValue->v.bigint, count32))
            result = scr_dyn_new_num(scr_fs_read_sync_at(fd, bytes, offset, count32,
                                                         scr_bigint_to_i64(positionValue->v.bigint)));
        } else {
          result = scr_dyn_new_num(readOp ? scr_fs_read_sync(fd, bytes, offset, length, position)
                                          : scr_fs_write_sync(fd, bytes, offset, length, position));
        }
      }
      scr_dyn_release(positionValue);
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
        if (flags == 1 && scr_fs_exists(destination)) scr_fs_throw2(EEXIST, "copyfile", path, destination);
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
  if (optional_callback) {
    scr_dyn_release(result);
    scr_dyn_release(buffer);
  } else {
    scr_fs_cb_schedule(callback, result, buffer);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_fs_cb_value_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStr *member = scr_box_get_ref(closure->caps[0]);
  ScrDyn *result = scr_fs_cb_invoke(member, args, argc);
  scr_str_release(member);
  return result;
}

ScrDyn *scr_fs_callback_value(ScrStr *member, double length) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(closure->caps[0], scr_str_retain(member));
  /* Node names each callback after its member; the compiler supplies the
   * declared length (fs.readFile.length is 3). fs.realpath.native is the
   * realpath binding itself, whose name is empty. The member is a compiler
   * string literal, which lives for the whole run. */
  const char *name = !strcmp(member->data, "realpath.native") ? "" : member->data;
  return scr_dyn_new_func(closure, scr_fs_cb_value_call, (uint32_t)length, "native:fs.callback",
                          name);
}

ScrDyn *scr_fs_callback_call(ScrStr *member, const ScrDyn *args) {
  return scr_fs_cb_invoke(member, args->v.arr.items, args->v.arr.len);
}

/* ── process.stdout/stderr.write(buf) ──────────────────────────────────── */

/* Where another thread can write shared bytes (where SCR_BYTES_SNAPSHOT
 * copies them), they are read with scr_shared_load, so no shared raw memory
 * reaches the system call. Written to the stream itself, they go through a
 * bounded local buffer, so a large shared view is not copied whole first.
 * With a write hook (the program reads process.stdout or process.stderr as
 * a value, and may have replaced its write), the view is copied whole: a
 * replaced write receives it in one call, as in Node, whatever it returns. */
static bool scr_stdio_write_bytes(int fd, const ScrBytes *b) {
  size_t n = b->len * scr_bytes_elem_size(b->elem);
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
  if (!b->shared) return scr_stdio_write(fd, b->data, n);
  if (scr_stdio_write_hook) {
    unsigned char *copy = scr_mem_alloc(n ? n : 1);
    scr_shared_load(copy, b->data, n);
    bool ok = scr_stdio_write(fd, copy, n);
    scr_mem_free(copy);
    return ok;
  }
  enum { CHUNK = 64 * 1024 };
  unsigned char *chunk = scr_mem_alloc(n < CHUNK ? (n ? n : 1) : CHUNK);
  for (size_t off = 0; off < n; off += CHUNK) {
    size_t k = n - off < CHUNK ? n - off : CHUNK;
    scr_shared_load(chunk, b->data + off, k);
    (void)scr_stdio_write_raw(fd, chunk, k);
  }
  scr_mem_free(chunk);
  return true;
#else
  return scr_stdio_write(fd, b->data, n);
#endif
}

bool scr_process_stdout_write_bytes(const ScrBytes *b, const ScrStr *encoding) {
  (void)encoding;
  return scr_stdio_write_bytes(1, b);
}

bool scr_process_stderr_write_bytes(const ScrBytes *b, const ScrStr *encoding) {
  (void)encoding;
  return scr_stdio_write_bytes(2, b);
}

/* Buffer.from over checked-native input. Strings use the existing codec;
 * bytes, arrays and data-only array-like/Buffer-JSON objects always COPY.
 * A dyn is not an arbitrary JS object: opaque references and custom input
 * valueOf hooks throw the 'not supported yet' Error rather than skipping hooks. */
static ScrBytes *scr_buffer_from_refusal(const char *detail) {
  char msg[192];
  int n = snprintf(msg, sizeof msg, "Buffer.from %s is not supported yet", detail);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)n, "SC2020");
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

/* Node's parseFileMode(value, name, def): a nullish value takes the
 * default, or reports "Received undefined" when the call has none (the
 * `value ??= def` falls through to validateUint32), an octal string parses
 * base 8, and a number goes through validateUint32. False with the error
 * thrown; a passing mode reaches *out as Node's `value + 0`. */
static bool scr_fs_parse_file_mode(const ScrDyn *value, const char *name, bool has_default,
                                   double def, double *out) {
  if (value == NULL || value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    if (!has_default) {
      scr_dyn_arg_type_fail(name, "of type number", scr_dyn_undefined());
      return false;
    }
    *out = def;
    return true;
  }
  if (value->kind == SCR_DYN_STR) return scr_fs_mode_octal(value->v.str, name, out);
  if (value->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", value);
    return false;
  }
  return scr_fs_mode_number_valid(value->v.num, name, out);
}

/* The parse without a resolved value, for callers that only validate. */
static bool scr_fs_mode_chk(const ScrDyn *m, const char *name) {
  double parsed;
  return scr_fs_parse_file_mode(m, name, false, 0, &parsed);
}

/* chmodSync(path, mode) for a mode whose static type is not a bare number:
 * Node validates the path first, then parseFileMode. */
void scr_fs_chmod_dyn(ScrStr *path, const ScrDyn *mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  double parsed;
  if (!scr_fs_parse_file_mode(mode, "mode", false, 0, &parsed)) return;
  scr_fs_chmod(path, parsed);
}

/* fchmodSync(fd, mode): the mode parses before the fd, like Node (the
 * descriptor validates in the binding, which is where a dynamic fd is
 * checked). */
void scr_fs_fchmod_dyn(const ScrDyn *fd, const ScrDyn *mode) {
  double parsed;
  if (!scr_fs_parse_file_mode(mode, "mode", false, 0, &parsed)) return;
  if (!scr_fs_int_range_chk(fd, "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return;
  scr_fs_fchmod(fd->v.num, parsed);
}

/* mkdirSync with an options argument the compiler could not resolve to a
 * literal shape: Node's ladder over the dynamic value. Answers the first
 * created directory in the recursive form (+1), NULL otherwise. */
ScrStr *scr_fs_mkdir_dyn(ScrStr *path, const ScrDyn *options) {
  /* Node reads the options' members before it validates the path's type,
   * and a member read that throws propagates before anything the options
   * license happens. */
  double mode = 0777;
  bool recursive = false;
  if (options != NULL && !scr_fs_dyn_absent(options)) {
    if (options->kind == SCR_DYN_NUM || options->kind == SCR_DYN_STR) {
      if (!scr_fs_parse_file_mode(options, "mode", false, 0, &mode)) return NULL;
    } else if (scr_dyn_truthy(options)) {
      bool present = false;
      if (!scr_fs_cb_member_present(options, "recursive", &present)) return NULL;
      if (present) {
        ScrDyn *value = scr_fs_cb_option(options, "recursive");
        if (!value) return NULL;
        bool ok = true;
        if (value->kind == SCR_DYN_BOOL) recursive = value->v.b;
        else {
          scr_dyn_arg_type_fail("options.recursive", "of type boolean", value);
          ok = false;
        }
        scr_dyn_release(value);
        if (!ok) return NULL;
      }
      if (!scr_fs_cb_member_present(options, "mode", &present)) return NULL;
      if (present) {
        ScrDyn *value = scr_fs_cb_option(options, "mode");
        if (!value) return NULL;
        bool ok = scr_fs_parse_file_mode(value, "options.mode", false, 0, &mode);
        scr_dyn_release(value);
        if (!ok) return NULL;
      }
    }
  }
  return scr_fs_mkdir_obj_number(path, mode, recursive);
}

void scr_fs_mkdir_dyn_void(ScrStr *path, const ScrDyn *options) {
  ScrStr *first = scr_fs_mkdir_dyn(path, options);
  if (first) scr_str_release(first);
}

/* openSync for flags and mode whose static types are not pinned:
 * getValidatedPath, then stringToFlags (nullish is O_RDONLY, a number is
 * the raw bits), then parseFileMode with Node's 0o666 default. */
double scr_fs_open_dyn(ScrStr *path, const ScrDyn *flags, const ScrDyn *mode) {
  if (!scr_fs_path_ok(path, "path")) return 0;
  int of;
  if (flags == NULL || scr_fs_dyn_absent(flags)) of = O_RDONLY;
  else if (flags->kind == SCR_DYN_NUM) {
    double parsed;
    if (!scr_fs_flags_number_valid(flags->v.num, &parsed)) return 0;
    of = (int)parsed;
  } else if (flags->kind == SCR_DYN_STR) {
    if (!scr_fs_flag_string(flags->v.str, &of)) return 0;
  } else {
    scr_dyn_arg_value_fail("flags", NULL, flags);
    return 0;
  }
  double parsed_mode;
  if (!scr_fs_parse_file_mode(mode, "mode", true, 0666, &parsed_mode)) return 0;
  return scr_fs_open_flags(path, of, parsed_mode);
}

/* openSync with string flags and a mode the compiler could not resolve to a
 * number: parseFileMode's arms over the dynamic value. */
double scr_fs_open_mode_dyn(ScrStr *path, ScrStr *flags, const ScrDyn *mode) {
  if (!scr_fs_path_ok(path, "path")) return 0;
  int of;
  if (!scr_fs_flag_string(flags, &of)) return 0;
  double parsed_mode;
  if (!scr_fs_parse_file_mode(mode, "mode", true, 0666, &parsed_mode)) return 0;
  return scr_fs_open_flags(path, of, parsed_mode);
}

/* openSync over the frontend's inline fs.constants mask with an
 * octal-string creation mode. */
double scr_fs_open_numeric_str(ScrStr *path, double flags, ScrStr *mode) {
  if (!scr_fs_path_ok(path, "path")) return 0;
  double parsed_mode;
  if (!scr_fs_mode_octal(mode, "mode", &parsed_mode)) return 0;
  return scr_fs_open_mask(path, flags, parsed_mode);
}

/* The same with a creation mode only the runtime can read. */
double scr_fs_open_numeric_dyn(ScrStr *path, double flags, const ScrDyn *mode) {
  if (!scr_fs_path_ok(path, "path")) return 0;
  double parsed_mode;
  if (!scr_fs_parse_file_mode(mode, "mode", true, 0666, &parsed_mode)) return 0;
  return scr_fs_open_mask(path, flags, parsed_mode);
}

/* openSync over raw open(2) flag bits with an octal-string creation mode. */
double scr_fs_open_native_str(ScrStr *path, double flags, ScrStr *mode) {
  if (!scr_fs_path_ok(path, "path")) return 0;
  double parsed_flags;
  if (!scr_fs_flags_number_valid(flags, &parsed_flags)) return 0;
  double parsed_mode;
  if (!scr_fs_mode_octal(mode, "mode", &parsed_mode)) return 0;
  return scr_fs_open_native(path, parsed_flags, parsed_mode);
}

/* The same with a creation mode only the runtime can read. */
double scr_fs_open_native_dyn(ScrStr *path, double flags, const ScrDyn *mode) {
  if (!scr_fs_path_ok(path, "path")) return 0;
  double parsed_flags;
  if (!scr_fs_flags_number_valid(flags, &parsed_flags)) return 0;
  double parsed_mode;
  if (!scr_fs_parse_file_mode(mode, "mode", true, 0666, &parsed_mode)) return 0;
  return scr_fs_open_native(path, parsed_flags, parsed_mode);
}

/* fs.exists(path, cb) — the REAL deprecated-API shape: the callback
 * validates synchronously (Node's one throwing arm), and a path that
 * getValidatedPath accepts — a string, a Uint8Array or a file: URL without
 * a null byte — runs the existsSync probe asynchronously through the
 * callback. Every other path answers `false` synchronously: Node calls
 * fs.access inside a try, the path validation throws, and the catch runs
 * `return callback(false)` before exists returns. */
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

/* validatePath over the kinds that reach the async probe: a string or
 * Uint8Array without a null byte passes (a URL is converted first), and
 * every other value kind is an invalid argument. */
static bool scr_fs_exists_path_ok(const ScrDyn *path) {
  if (path->kind == SCR_DYN_STR) return memchr(path->v.str->data, 0, path->v.str->len) == NULL;
  if (scr_dyn_bytes_is(path, SCR_BYTES_U8))
    return memchr(path->v.bytes->data, 0, path->v.bytes->len) == NULL;
  return false;
}

/* The synchronous false arm: exists' catch block. */
static ScrDyn *scr_fs_exists_false(const ScrDyn *cb) {
  ScrDyn *arg = scr_dyn_new_bool(false);
  ScrDyn *r = scr_dyn_call(cb, &arg, 1, "the fs.exists callback");
  scr_dyn_release(arg);
  scr_dyn_release(r);
  if (scr_exc_pending()) return NULL;
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_fs_exists_async(const ScrDyn *path, const ScrDyn *cb) {
  if (!scr_fs_cb_chk(cb, "cb")) return NULL;
  ScrDyn *converted = NULL; /* +1: a file: URL's path, once converted */
  const ScrDyn *probe = path;
  if (scr_dyn_native_url_is(path)) {
    /* toPathIfFileURL: only file: URLs name a path, and a conversion error
     * (or a decoded path validatePath rejects, a null byte) is the same
     * caught throw as any other rejected path. */
    converted = scr_url_to_path_value(path->v.handle.ptr);
    if (converted->kind != SCR_DYN_STR || !scr_fs_exists_path_ok(converted)) {
      scr_dyn_release(converted);
      return scr_fs_exists_false(cb);
    }
    probe = converted;
  } else if (!scr_fs_exists_path_ok(path)) {
    return scr_fs_exists_false(cb);
  }
#ifdef SCR_LIB
  /* Library links exclude the event-loop unit, and the compile-time scan
   * refuses the fs.exists surface (SC4005's family) — this arm exists
   * only so the TU links without scr_async. Unreachable by construction. */
  if (converted) scr_dyn_release(converted);
  scr_trap("scriptc: internal error: fs.exists async fire reached in a library build — please report this");
  return NULL;
#else
  ScrClosure *clo = scr_closure_new((void *)scr_fs_exists_fire, 2);
  clo->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[0], scr_dyn_retain((ScrDyn *)probe));
  clo->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[1], scr_dyn_retain((ScrDyn *)cb));
  scr_loop_defer(clo);
  if (converted) scr_dyn_release(converted);
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
    for (size_t i = 0; i < scr_dyn_obj_count(opts); i++) {
      ScrDynProp e = scr_dyn_obj_prop_at(opts, i);
      if (scr_fs_dyn_absent(e.value)) continue;
      if (strcmp(e.key, "encoding") == 0) {
        if (!scr_fs_utf8_encoding(e.value)) utf8 = false;
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
  } else if (length->kind == SCR_DYN_BIGINT) {
    /* `length |= 0` on a BigInt is JavaScript's mixed-operand error. */
    static const char message[] = "Cannot mix BigInt and other types, use explicit conversions";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  } else if (!scr_dyn_number_coerce_js(length, &n)) {
    return false;
  }
  *out = scr_fs_int32(n);
  return true;
}

/* ToInt32 of a number: 0 for NaN and the infinities. */
static double scr_fs_int32(double n) {
  if (!isfinite(n)) return 0;
  double m = fmod(trunc(n), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return m >= 2147483648.0 ? m - 4294967296.0 : m;
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


/* The empty-view ERR_INVALID_ARG_VALUE the read and write ladders share:
 * Node prints the view's own inspect after "Received " ("<Buffer >" for a
 * Buffer, "Uint8Array(0) []" for a typed array, the DataView body for one).
 * Always throws catchably. */
static void scr_fs_empty_buffer_fail(const ScrDyn *buffer) {
  ScrStr *inspected = scr_dyn_empty_view_inspect(buffer);
  char msg[320];
  int len = snprintf(msg, sizeof msg,
                     "The argument 'buffer' is empty and cannot be written. Received %.*s",
                     (int)inspected->len, inspected->data);
  scr_str_release(inspected);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_VALUE");
}

/* fs.read(fd, buffer, offset, length, position, cb)'s argument checks, in
 * Node's order: the fd, the buffer, the offset (an integer >= 0), the
 * length as `length |= 0`, the position (validatePosition, against that
 * length), then for a non-empty read the empty-buffer and
 * validateOffsetLengthRead checks. The converted length goes to
 * *length_out when it is not NULL, so the read does not convert again. */
static bool scr_fs_read_validate(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                                 const ScrDyn *length, const ScrDyn *position, double *length_out) {
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
  if (length_out) *length_out = count;
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
    scr_fs_empty_buffer_fail(buffer);
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
  if (scr_fs_read_validate(fd, buffer, offset, length, position, NULL)) scr_throw_lowering_fence(fence);
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
  bool absent = scr_fs_dyn_absent(flag);
  const char *f = absent ? fallback : flag->kind == SCR_DYN_STR ? flag->v.str->data : NULL;
  if (!f) {
    static const char message[] = "Runtime numeric filesystem flags have no portable native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return -1;
  }
  int bits = absent ? scr_fs_flag_bits(fallback, strlen(fallback))
                    : scr_fs_flag_bits(flag->v.str->data, flag->v.str->len);
  if (bits < 0) {
    if (!absent) {
      scr_fs_flag_invalid(flag->v.str);
    } else {
      /* the compiler's own fallback is a name from the table; a miss here
       * still refuses through the same safe message */
      ScrStr *text = scr_str_new(fallback, strlen(fallback));
      scr_fs_flag_invalid(text);
      scr_str_release(text);
    }
  }
  return bits;
}

bool scr_fs_stream_mode(const ScrDyn *value, double *mode) {
  if (scr_fs_dyn_absent(value)) {
    *mode = 0666;
    return true;
  }
  return scr_fs_cb_file_mode(value, "mode", mode);
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

/* ── the sync fd ladders (checked-dynamic lane) ─────────────────────────
 * The fs.*Sync calls whose argument kinds the compiler could not pin down.
 * Each runs Node's own checks over the dynamic values in Node's own order,
 * then the same typed operation the fully typed lane uses. */

/* typeof value === 'object': null included; undefined and the primitive and
 * callable kinds excluded. */
static bool scr_fs_dyn_objectish(const ScrDyn *v) {
  switch (v->kind) {
    case SCR_DYN_OBJ:
    case SCR_DYN_ARR:
    case SCR_DYN_BYTES:
    case SCR_DYN_NULL:
    case SCR_DYN_HANDLE:
    case SCR_DYN_PROMISE:
    case SCR_DYN_TYPED_REF:
    case SCR_DYN_PROXY:
      return true;
    default:
      return false;
  }
}

/* `buffer.byteLength` at the points Node reads it. A DataView whose owner
 * is detached throws its catchable TypeError from the getter there; this
 * answers false with the exception pending, so the ladder stops before it
 * runs any I/O. */
static bool scr_fs_dyn_byte_len(const ScrDyn *buffer, double *length) {
  return scr_bytes_view_byte_length(buffer->v.bytes, length);
}

/* An ArrayBufferView's bytes as a Uint8 view over the same memory (+1), so
 * a read onto it or a write from it reaches the original view. A view Node
 * counts as having no bytes (detached, or out of bounds past a shrink) has
 * nothing to reach, and answers an empty view; NULL means the conversion
 * raised (the exception is pending) and the caller must skip its I/O. */
static ScrBytes *scr_fs_dyn_view(const ScrDyn *buffer) {
  ScrBytes *raw = scr_dyn_bytes_unbox(buffer);
  ScrBytes *view = scr_bytes_view_usable(raw) ? scr_bytes_raw_view(raw)
                                              : scr_bytes_from_data(NULL, 0);
  scr_bytes_release(raw);
  return view;
}

/* Node's GetOffset: a safe nonnegative integer is the position; anything
 * else (including a negative number, a fraction and a non-number) is the
 * current descriptor offset, which libuv spells -1. */
static double scr_fs_dyn_position(const ScrDyn *position) {
  if (position->kind != SCR_DYN_NUM || !isfinite(position->v.num) ||
      trunc(position->v.num) != position->v.num || position->v.num < 0 ||
      position->v.num > 9007199254740991.0)
    return -1;
  return position->v.num;
}

/* getValidatedFd over a dynamic value. */
static bool scr_fs_dyn_fd_chk(const ScrDyn *fd) {
  return scr_fs_int_range_chk(fd, "fd", 0, 2147483647.0, ">= 0 && <= 2147483647");
}

/* fs.readSync(fd, buffer[, offset[, length[, position]]]) including the
 * options-object form, with argument kinds the compiler could not pin down:
 * validateBuffer, the options object and its members (in destructuring
 * order), the offset integer, `length |= 0`, the position (which may be a
 * bigint), the zero-length early return, the empty-buffer check,
 * validateOffsetLengthRead, then the descriptor and the read. `argc` is the
 * call's own argument count, which decides the options form. */
double scr_fs_read_sync_args(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                             const ScrDyn *length, const ScrDyn *position, double argc) {
  ScrDyn *own_offset = NULL, *own_length = NULL, *own_position = NULL;
  const ScrDyn *offv = offset, *lenv = length, *posv = position;
  double buflen = 0, off = 0, count = 0, result = 0, default_len = 0;
  bool options_form = false, defaulted = false, have_len = false;
  int64_t at = -1;
  if (buffer->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
    return 0;
  }
  options_form = argc <= 3 || scr_fs_dyn_objectish(offset);
  if (options_form) {
    /* validateObject(options, kValidateObjectAllowNullable): null and the
     * object kinds pass; a function or a primitive does not. */
    if (offset->kind != SCR_DYN_UNDEF && !scr_fs_dyn_objectish(offset)) {
      scr_dyn_arg_type_fail("options", "of type object", offset);
      return 0;
    }
    offv = lenv = posv = scr_dyn_undefined();
    if (!scr_fs_dyn_absent(offset)) {
      own_offset = scr_fs_cb_option(offset, "offset");
      if (own_offset) own_length = scr_fs_cb_option(offset, "length");
      if (own_length) own_position = scr_fs_cb_option(offset, "position");
      if (!own_position) goto done;
      offv = own_offset;
      lenv = own_length;
      posv = own_position;
    }
    /* The destructuring's own defaults: offset = 0, then
     * length = buffer.byteLength - offset. The subtraction runs on the raw
     * offset value, so a Symbol or a BigInt there throws its conversion
     * error before the offset is validated. */
    if (lenv->kind == SCR_DYN_UNDEF) {
      double offnum = 0;
      /* The subtraction's left operand, evaluated first. */
      if (!scr_fs_dyn_byte_len(buffer, &buflen)) goto done;
      have_len = true;
      if (offv->kind == SCR_DYN_BIGINT) {
        static const char mix[] =
            "Cannot mix BigInt and other types, use explicit conversions";
        scr_throw_error_msg(SCR_ERR_TYPE, mix, sizeof mix - 1);
        goto done;
      }
      if (offv->kind != SCR_DYN_UNDEF && !scr_dyn_number_coerce_js(offv, &offnum)) goto done;
      default_len = buflen - offnum;
      defaulted = true;
    }
  }
  if (offv->kind != SCR_DYN_UNDEF) {
    if (!scr_fs_int_range_chk(offv, "offset", 0, 9007199254740991.0,
                              ">= 0 && <= 9007199254740991"))
      goto done;
    off = offv->v.num;
  }
  /* `length |= 0`, on the destructured default or the given argument. */
  if (defaulted) {
    count = scr_fs_int32(default_len);
  } else if (!scr_fs_length_int32(lenv, &count)) {
    goto done;
  }
  if (!scr_fs_dyn_absent(posv)) {
    if (posv->kind == SCR_DYN_BIGINT) {
      if (!scr_fs_bigint_position_chk(posv->v.bigint, count)) goto done;
      /* The exact value: a double would round past 2^53. */
      at = scr_bigint_to_i64(posv->v.bigint);
    } else if (posv->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("position", "of type bigint or integer", posv);
      goto done;
    } else if (!scr_fs_int_range_chk(posv, "position", -1, 9007199254740991.0,
                                     ">= -1 && <= 9007199254740991")) {
      goto done;
    } else {
      at = (int64_t)posv->v.num;
    }
  }
  if (count == 0) goto done;
  /* The empty-buffer check and validateOffsetLengthRead read byteLength;
   * a detached DataView's getter throws at the first one. */
  if (!have_len && !scr_fs_dyn_byte_len(buffer, &buflen)) goto done;
  if (buflen == 0) {
    scr_fs_empty_buffer_fail(buffer);
    goto done;
  }
  if (count < 0 || off + count > buflen) {
    char recv[48], range[64], msg[192];
    scr_num_received(count, recv);
    if (count < 0) {
      snprintf(range, sizeof range, ">= 0");
    } else {
      snprintf(range, sizeof range, "<= %.0f", buflen - off);
    }
    int len = snprintf(msg, sizeof msg,
                       "The value of \"length\" is out of range. It must be %s. Received %s", range,
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    goto done;
  }
  if (!scr_fs_dyn_fd_chk(fd)) goto done;
  {
    ScrBytes *view = scr_fs_dyn_view(buffer);
    if (view != NULL) {
      result = scr_fs_read_sync_at(fd->v.num, view, off, count, at);
      scr_bytes_release(view);
    }
  }
done:
  if (own_offset) scr_dyn_release(own_offset);
  if (own_length) scr_dyn_release(own_length);
  if (own_position) scr_dyn_release(own_position);
  return result;
}

/* fs.writeSync(fd, buffer[, offset[, length[, position]]]) with argument
 * kinds the compiler could not pin down. The view form runs Node's
 * validateOffsetLengthWrite ladder (the options object's members when the
 * offset slot holds one, then the offset, the defaulted length and the
 * int32 bound), the descriptor, and a write at GetOffset's position; the
 * string form runs validateEncoding's hex check, the descriptor, and one
 * write of the encoded bytes. */
double scr_fs_write_sync_args(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                              const ScrDyn *length, const ScrDyn *position) {
  ScrDyn *own_offset = NULL, *own_length = NULL, *own_position = NULL;
  const ScrDyn *offv = offset, *lenv = length, *posv = position;
  double buflen = 0, off = 0, len = 0, at = -1, result = 0;
  bool have_len = false;
  char range[64];
  if (buffer->kind == SCR_DYN_BYTES) {
    if (scr_fs_dyn_objectish(offset) && !scr_fs_dyn_absent(offset)) {
      /* The destructuring reads the members in source order. */
      own_offset = scr_fs_cb_option(offset, "offset");
      if (own_offset) own_length = scr_fs_cb_option(offset, "length");
      if (own_length) own_position = scr_fs_cb_option(offset, "position");
      if (!own_position) goto done;
      offv = own_offset;
      lenv = own_length;
      posv = own_position;
      /* An absent length takes the destructuring's default, which reads
       * buffer.byteLength before the offset is validated. */
      if (lenv->kind == SCR_DYN_UNDEF && !scr_fs_dyn_byte_len(buffer, &buflen)) goto done;
      have_len = lenv->kind == SCR_DYN_UNDEF;
    } else if (scr_fs_dyn_absent(offset)) {
      offv = lenv = posv = scr_dyn_undefined();
    }
    if (offv->kind != SCR_DYN_UNDEF && offv->kind != SCR_DYN_NULL) {
      if (!scr_fs_int_range_chk(offv, "offset", 0, 9007199254740991.0,
                                ">= 0 && <= 9007199254740991"))
        goto done;
      off = offv->v.num;
    }
    /* The length default and validateOffsetLengthWrite both read
     * buffer.byteLength after the offset check. */
    if (!have_len && !scr_fs_dyn_byte_len(buffer, &buflen)) goto done;
    len = lenv->kind == SCR_DYN_NUM ? lenv->v.num : buflen - off;
    if (off > buflen) {
      snprintf(range, sizeof range, "<= %.0f", buflen);
      scr_fs_num_range_fail("offset", range, off);
      goto done;
    }
    if (len > buflen - off) {
      snprintf(range, sizeof range, "<= %.0f", buflen - off);
      scr_fs_num_range_fail("length", range, len);
      goto done;
    }
    if (len < 0) {
      scr_fs_num_range_fail("length", ">= 0", len);
      goto done;
    }
    if (!(isfinite(len) && trunc(len) == len)) {
      scr_fs_num_range_fail("length", "an integer", len);
      goto done;
    }
    if (len > 2147483647.0) {
      scr_fs_num_range_fail("length", ">= 0 && <= 2147483647", len);
      goto done;
    }
    if (!scr_fs_dyn_fd_chk(fd)) goto done;
    at = scr_fs_dyn_position(posv);
    {
      ScrBytes *view = scr_fs_dyn_view(buffer);
      if (view != NULL) {
        result = scr_fs_write_sync(fd->v.num, view, off, len, at);
        scr_bytes_release(view);
      }
    }
  } else {
    if (buffer->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("buffer",
                            "of type string or an instance of Buffer, TypedArray, or DataView",
                            buffer);
      goto done;
    }
    /* The string arm is the typed lane's own: validateEncoding (the `length`
     * argument stands in as the encoding; a non-string name normalizes to
     * utf8 and never fails it) reads the string before getValidatedFd does,
     * then the encoded write at GetOffset's position. */
    ScrStr *encoding = length->kind == SCR_DYN_STR ? length->v.str : NULL;
    if (!scr_fs_write_str_encoding_ok(buffer->v.str, encoding)) goto done;
    if (!scr_fs_dyn_fd_chk(fd)) goto done;
    result = scr_fs_write_str_sync(fd->v.num, buffer->v.str, scr_fs_dyn_position(offset),
                                   encoding);
  }
done:
  if (own_offset) scr_dyn_release(own_offset);
  if (own_length) scr_dyn_release(own_length);
  if (own_position) scr_dyn_release(own_position);
  return result;
}

/* The vector arguments as Uint8 views over the same memory (+1 array), or
 * NULL with Node's "ArrayBufferView[]" TypeError. A typed array the call
 * site only knows as a dynamic value arrives as a typed reference, which is
 * materialized so its elements can be read like a literal array's. */
static ScrArr *scr_fs_dyn_views(const ScrDyn *buffers) {
  ScrDyn *materialized = NULL;
  if (buffers->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(buffers) != NULL) {
    materialized = scr_dyn_typed_ref_materialize(buffers);
    buffers = materialized;
  }
  if (buffers->kind != SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("buffers", "an ArrayBufferView[]", buffers);
    scr_dyn_release(materialized);
    return NULL;
  }
  double count = scr_dyn_arr_len(buffers);
  ScrArr *views = scr_arr_new_ops(&scr_bytes_io_bytes_ops, (size_t)count);
  for (double i = 0; i < count; i++) {
    ScrDyn *item = scr_dyn_index_get(buffers, i);
    if (item == NULL || item->kind != SCR_DYN_BYTES) {
      if (item) scr_dyn_release(item);
      scr_dyn_arg_type_fail("buffers", "an ArrayBufferView[]", buffers);
      scr_arr_release(views);
      scr_dyn_release(materialized);
      return NULL;
    }
    /* A conversion that raised leaves the exception pending: drop the
     * vector it had built rather than hand a missing view to the I/O. */
    ScrBytes *view = scr_fs_dyn_view(item);
    scr_dyn_release(item);
    if (view == NULL) {
      scr_arr_release(views);
      scr_dyn_release(materialized);
      return NULL;
    }
    scr_arr_push_ref(views, view);
  }
  scr_dyn_release(materialized);
  return views;
}

double scr_fs_readv_sync_dyn(const ScrDyn *fd, const ScrDyn *buffers, const ScrDyn *position) {
  ScrArr *views = scr_fs_dyn_views(buffers);
  double result = 0;
  if (!views) return 0;
  if (scr_fs_dyn_fd_chk(fd))
    result = scr_fs_readv_sync(fd->v.num, views, scr_fs_dyn_position(position));
  scr_arr_release(views);
  return result;
}

double scr_fs_writev_sync_dyn(const ScrDyn *fd, const ScrDyn *buffers, const ScrDyn *position) {
  ScrArr *views = scr_fs_dyn_views(buffers);
  double result = 0;
  if (!views) return 0;
  /* An empty vector writes nothing before the descriptor is checked. */
  if (scr_arr_len(views) != 0 && scr_fs_dyn_fd_chk(fd))
    result = scr_fs_writev_sync(fd->v.num, views, scr_fs_dyn_position(position));
  scr_arr_release(views);
  return result;
}

void scr_fs_close_sync_dyn(const ScrDyn *fd) {
  if (scr_fs_dyn_fd_chk(fd)) scr_fs_close(fd->v.num);
}

void scr_fs_fsync_sync_dyn(const ScrDyn *fd) {
  if (scr_fs_dyn_fd_chk(fd)) scr_fs_fsync(fd->v.num);
}

void scr_fs_fdatasync_sync_dyn(const ScrDyn *fd) {
  if (scr_fs_dyn_fd_chk(fd)) scr_fs_fdatasync(fd->v.num);
}

void scr_fs_ftruncate_sync_dyn(const ScrDyn *fd, const ScrDyn *len) {
  double length = 0;
  /* ftruncateSync's default applies to an omitted or undefined len alone. */
  if (len->kind != SCR_DYN_UNDEF) {
    if (!scr_fs_int_range_chk(len, "len", -9007199254740991.0, 9007199254740991.0,
                              ">= -9007199254740991 && <= 9007199254740991"))
      return;
    length = len->v.num;
  }
  if (!scr_fs_dyn_fd_chk(fd)) return;
  scr_fs_ftruncate(fd->v.num, length);
}

void scr_fs_fchown_sync_dyn(const ScrDyn *fd, const ScrDyn *uid, const ScrDyn *gid) {
  if (!scr_fs_int_range_chk(uid, "uid", -1, 4294967295.0, ">= -1 && <= 4294967295")) return;
  if (!scr_fs_int_range_chk(gid, "gid", -1, 4294967295.0, ">= -1 && <= 4294967295")) return;
  if (!scr_fs_dyn_fd_chk(fd)) return;
  scr_fs_fchown(fd->v.num, uid->v.num, gid->v.num);
}
