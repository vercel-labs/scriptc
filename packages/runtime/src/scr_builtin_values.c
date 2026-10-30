/* Builtin functions called as function values in JavaScript dependencies
 * (`Buffer.byteLength.bind(Buffer)`, `var alloc = Buffer.alloc`, a stored
 * `fs.realpathSync`): the arguments arrive unchecked, so these entries apply
 * Node's argument handling before the ordinary operation. A separate unit,
 * linked only by programs that read these values. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

/* Buffer.byteLength called as a function value (`Buffer.byteLength.bind(
 * Buffer)` in truncate-utf8-bytes), with the encoding known only at run
 * time. Node's ladder: a non-string source answers its byte length or
 * throws before the encoding is read; an empty string answers 0; a falsy
 * encoding, or one getEncodingOps does not know after ToString (any ASCII
 * case), counts UTF-8. */
double scr_buffer_byte_length_value(ScrDyn *value, ScrDyn *encoding) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"},
    {"base64", "base64"}, {"base64url", "base64url"},
    {"latin1", "latin1"}, {"binary", "latin1"}, {"ascii", "ascii"},
    {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"},
  };
  const char *name = "utf8";
  if (value->kind == SCR_DYN_STR && value->v.str->len > 0 && scr_dyn_truthy(encoding)) {
    ScrStr *raw = scr_dyn_string_coerce_js(encoding);
    if (!raw) return 0;
    for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
      size_t n = strlen(map[i].from);
      bool same = raw->len == n;
      for (size_t k = 0; same && k < n; k++) {
        char c = raw->data[k];
        if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
        same = c == map[i].from[k];
      }
      if (same) {
        name = map[i].to;
        break;
      }
    }
    scr_str_release(raw);
  }
  ScrStr *canonical = scr_str_new(name, strlen(name));
  double length = scr_buffer_byte_length_dyn(value, canonical);
  scr_str_release(canonical);
  return length;
}

/* Node's normalizeEncoding: the canonical name for a string encoding
 * (any ASCII case; null, undefined and "" read as utf8), or NULL. */
static const char *scr_bv_encoding(const ScrDyn *encoding) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"},
    {"base64", "base64"}, {"base64url", "base64url"},
    {"latin1", "latin1"}, {"binary", "latin1"}, {"ascii", "ascii"},
    {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"},
  };
  if (encoding->kind == SCR_DYN_UNDEF || encoding->kind == SCR_DYN_NULL) return "utf8";
  if (encoding->kind != SCR_DYN_STR) return NULL;
  const ScrStr *name = encoding->v.str;
  if (name->len == 0) return "utf8";
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
    size_t n = strlen(map[i].from);
    bool same = name->len == n;
    for (size_t k = 0; same && k < n; k++) {
      char c = name->data[k];
      if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
      same = c == map[i].from[k];
    }
    if (same) return map[i].to;
  }
  return NULL;
}

static void scr_bv_invalid_value(const ScrDyn *value) {
  char rendered[160];
  /* The rejected views are empty, which util.inspect prints whole. */
  const char *text = value->kind == SCR_DYN_BYTES && value->v.bytes->len == 0 && value->buffer ? "<Buffer >"
                     : scr_dyn_inspect_lite(value, rendered, sizeof rendered);
  char message[224];
  int n = snprintf(message, sizeof message, "The argument 'value' is invalid. Received %s", text);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, "ERR_INVALID_ARG_VALUE");
}

/* Buffer.alloc called as a function value (`var alloc = Buffer.alloc` in
 * tar-stream), with Node's alloc and _fill: the size must be a number,
 * ERR_INVALID_ARG_TYPE otherwise, then the allocation and range checks.
 * A fill that is undefined or 0, or a size of 0, leaves the buffer zeroed.
 * A string fill encodes with the encoding (ERR_INVALID_ARG_TYPE for a
 * non-string encoding Node cannot normalize, ERR_UNKNOWN_ENCODING for an
 * unknown name), an empty string zero-fills, and a non-empty string that
 * encodes to no bytes throws ERR_INVALID_ARG_VALUE. A view fills with
 * its bytes (ERR_INVALID_ARG_VALUE when it is empty); any other value
 * fills with ToUint32(ToNumber(value)) & 255. +1, or NULL with the
 * exception pending. */
ScrBytes *scr_buffer_alloc_value(const ScrDyn *size, const ScrDyn *fill, const ScrDyn *encoding) {
  if (size->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("size", "of type number", size);
    return NULL;
  }
  ScrBytes *buf = scr_buffer_alloc(size->v.num);
  if (!buf) return NULL;
  if (fill->kind == SCR_DYN_UNDEF || (fill->kind == SCR_DYN_NUM && fill->v.num == 0) || buf->len == 0)
    return buf;
  if (fill->kind == SCR_DYN_STR) {
    const char *name = scr_bv_encoding(encoding);
    if (!name) {
      if (encoding->kind != SCR_DYN_STR) {
        scr_dyn_arg_type_fail("encoding", "of type string", encoding);
      } else {
        ScrJsonBuf b;
        scr_jb_init(&b);
        scr_jb_puts(&b, "Unknown encoding: ");
        scr_jb_put_str(&b, encoding->v.str);
        ScrStr *message = scr_jb_finish(&b);
        scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_UNKNOWN_ENCODING");
        scr_str_release(message);
      }
      scr_bytes_release(buf);
      return NULL;
    }
    if (fill->v.str->len == 0) return buf;
    ScrStr *canonical = scr_str_new(name, strlen(name));
    ScrBytes *pattern = scr_bytes_from_str(fill->v.str, canonical);
    scr_str_release(canonical);
    if (!pattern || pattern->len == 0) {
      scr_bytes_release(pattern);
      scr_bytes_release(buf);
      scr_bv_invalid_value(fill);
      return NULL;
    }
    ScrBytes *filled = scr_bytes_fill(buf, pattern, 0, 0, 0);
    scr_bytes_release(pattern);
    scr_bytes_release(filled);
    return buf;
  }
  if (fill->kind == SCR_DYN_BYTES) {
    ScrBytes *pattern = scr_bytes_buffer_source(fill);
    if (!pattern || pattern->len == 0) {
      scr_bytes_release(pattern);
      scr_bytes_release(buf);
      scr_bv_invalid_value(fill);
      return NULL;
    }
    ScrBytes *filled = scr_bytes_fill(buf, pattern, 0, 0, 0);
    scr_bytes_release(pattern);
    scr_bytes_release(filled);
    return buf;
  }
  double value;
  if (!scr_dyn_number_coerce_js(fill, &value)) {
    scr_bytes_release(buf);
    return NULL;
  }
  double byte = isfinite(value) ? fmod(trunc(value), 256.0) : 0;
  if (byte < 0) byte += 256;
  memset(buf->data, (int)byte, buf->len);
  return buf;
}

/* fs.realpathSync and fs.realpathSync.native called as function values
 * (fs.realpath keeps `var origRealpathSync = fs.realpathSync`). Node's
 * argument handling: options that are null, undefined or a function mean
 * none, a string is the encoding, an object supplies `encoding`, anything
 * else throws ERR_INVALID_ARG_TYPE; a file URL is its path (toPathIfFileURL,
 * with fileURLToPath's errors for other URLs). The JavaScript form converts
 * any other path that is not a string with ToString (a Buffer decodes as
 * UTF-8); the native form takes a Uint8Array's bytes and throws
 * ERR_INVALID_ARG_TYPE for other values. The result is a string for
 * utf8, a Buffer for "buffer", and the UTF-8 bytes decoded in any other
 * encoding, whose name must be one Node knows. +1 or NULL. */
ScrDyn *scr_fs_realpath_value(const ScrDyn *path, const ScrDyn *options, bool native) {
  const ScrDyn *encoding = NULL;
  if (options->kind == SCR_DYN_STR) {
    encoding = options;
  } else if (options->kind == SCR_DYN_OBJ) {
    encoding = scr_dyn_obj_get(options, "encoding", 8);
  } else if (options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL &&
             options->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("options", "of type string or an instance of Object", options);
    return NULL;
  }
  static const struct { const char *from; const char *to; } names[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"}, {"base64", "base64"},
    {"base64url", "base64url"}, {"latin1", "latin1"}, {"binary", "latin1"},
    {"ascii", "ascii"}, {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"}, {"buffer", "buffer"},
  };
  const char *canonical = "utf8";
  if (encoding && encoding->kind != SCR_DYN_UNDEF && encoding->kind != SCR_DYN_NULL &&
      !(encoding->kind == SCR_DYN_STR && encoding->v.str->len == 0)) {
    const char *found = NULL;
    if (encoding->kind == SCR_DYN_STR) {
      for (size_t i = 0; i < sizeof names / sizeof names[0] && !found; i++) {
        size_t n = strlen(names[i].from);
        if (encoding->v.str->len != n) continue;
        bool same = true;
        for (size_t k = 0; k < n && same; k++) {
          char c = encoding->v.str->data[k];
          if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
          same = c == names[i].from[k];
        }
        if (same) found = names[i].to;
      }
    }
    if (!found) {
      ScrStr *shown = scr_dyn_string_coerce_js(encoding);
      if (!shown) return NULL;
      char msg[256];
      int n = snprintf(msg, sizeof msg, "The argument 'encoding' is invalid encoding. Received '%.*s'",
                       (int)(shown->len > 160 ? 160 : shown->len), shown->data);
      scr_str_release(shown);
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_ARG_VALUE");
      return NULL;
    }
    canonical = found;
  }
  ScrStr *p;
  if (scr_dyn_native_url_is(path)) {
    p = scr_url_to_path(path->v.handle.ptr);
  } else if (path->kind == SCR_DYN_STR) {
    p = scr_str_retain(path->v.str);
  } else if (native && path->kind == SCR_DYN_BYTES && path->v.bytes->elem == SCR_BYTES_U8) {
    /* getValidatedPath takes a Uint8Array's bytes as the path. */
    ScrStr *utf8 = scr_str_new("utf8", 4);
    p = scr_bytes_to_str(path->v.bytes, utf8);
    scr_str_release(utf8);
  } else if (native) {
    scr_dyn_arg_type_fail("path", "of type string or an instance of Buffer or URL", path);
    return NULL;
  } else {
    p = scr_dyn_string_coerce_js(path);
  }
  if (!p) return NULL;
  ScrStr *resolved = native ? scr_fs_realpath_promise(p) : scr_fs_realpath(p);
  scr_str_release(p);
  if (!resolved) return NULL;
  ScrDyn *out;
  if (!strcmp(canonical, "utf8")) {
    out = scr_dyn_new_str(resolved);
  } else {
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *bytes = scr_buffer_from_str(resolved, utf8);
    scr_str_release(utf8);
    if (!strcmp(canonical, "buffer")) {
      out = scr_dyn_new_buffer(bytes);
    } else {
      ScrStr *enc = scr_str_new(canonical, strlen(canonical));
      ScrStr *text = scr_bytes_to_str(bytes, enc);
      scr_str_release(enc);
      out = scr_dyn_new_str(text);
      scr_str_release(text);
    }
    scr_bytes_release(bytes);
  }
  scr_str_release(resolved);
  return out;
}

/* ── Buffer as a value ───────────────────────────────────────────────────
 * The Buffer function read as a value in JavaScript (bn.js assigns
 * `require('buffer').Buffer` to a variable and passes it to
 * `allocate(ArrayType, size)`): one function per thread, named Buffer
 * with length 3, whose own enumerable properties are Node's, in Node's
 * order: poolSize, the statics and Symbol(kIsEncodingSymbol). The statics
 * apply Node's argument handling. Calling or constructing Buffer through
 * the value, reading its prototype, and the copyBytesFrom and of statics
 * throw SC2020. poolSize is a data property the pool reads before each
 * decision (scr_buffer_pool_refresh_hook). */
static SCR_TL ScrDyn *scr_bv_buffer;

#define SCR_BV_ARG(i) ((i) < argc ? args[i] : scr_dyn_undefined())

static ScrDyn *scr_bv_unsupported(const char *what) {
  char message[160];
  int n = snprintf(message, sizeof message, "%s through a stored Buffer value is not supported yet", what);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)n, "SC2020");
  return NULL;
}

/* A Buffer result as a value: +1, or NULL with the exception pending. */
static ScrDyn *scr_bv_bytes(ScrBytes *bytes) {
  if (!bytes) return NULL;
  ScrBytes *buffer = scr_bytes_as_buffer(bytes);
  scr_bytes_release(bytes);
  ScrDyn *value = scr_dyn_new_bytes(buffer);
  scr_bytes_release(buffer);
  return value;
}

static ScrDyn *scr_bv_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_bv_unsupported("Calling or constructing Buffer");
}

static ScrDyn *scr_bv_from(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  const ScrDyn *value = SCR_BV_ARG(0), *second = SCR_BV_ARG(1), *third = SCR_BV_ARG(2);
  if (value->kind != SCR_DYN_STR) return scr_bv_bytes(scr_buffer_from_dyn_range_pooled(value, second, third));
  /* fromString: an encoding that is not a non-empty string means utf8. */
  if (second->kind == SCR_DYN_STR && second->v.str->len > 0)
    return scr_bv_bytes(scr_buffer_from_str_checked(value->v.str, second->v.str));
  ScrStr *utf8 = scr_str_new("utf8", 4);
  ScrBytes *bytes = scr_buffer_from_str_checked(value->v.str, utf8);
  scr_str_release(utf8);
  return scr_bv_bytes(bytes);
}

static ScrDyn *scr_bv_copy_bytes_from(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_bv_unsupported("Buffer.copyBytesFrom");
}

static ScrDyn *scr_bv_of(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_bv_unsupported("Buffer.of");
}

static ScrDyn *scr_bv_alloc(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return scr_bv_bytes(scr_buffer_alloc_value(SCR_BV_ARG(0), SCR_BV_ARG(1), SCR_BV_ARG(2)));
}

static ScrDyn *scr_bv_alloc_unsafe(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  const ScrDyn *size = SCR_BV_ARG(0);
  if (size->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("size", "of type number", size);
    return NULL;
  }
  return scr_bv_bytes(scr_buffer_alloc_unsafe(size->v.num));
}

static ScrDyn *scr_bv_alloc_unsafe_slow(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  const ScrDyn *size = SCR_BV_ARG(0);
  if (size->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("size", "of type number", size);
    return NULL;
  }
  return scr_bv_bytes(scr_buffer_alloc_unsafe_slow(size->v.num));
}

static ScrDyn *scr_bv_is_buffer(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  const ScrDyn *value = SCR_BV_ARG(0);
  return scr_dyn_new_bool(value->kind == SCR_DYN_BYTES && value->buffer);
}

static ScrDyn *scr_bv_compare(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  double order = scr_buffer_compare_chk(SCR_BV_ARG(0), SCR_BV_ARG(1));
  return scr_exc_pending() ? NULL : scr_dyn_new_num(order);
}

static ScrDyn *scr_bv_is_encoding(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  const ScrDyn *encoding = SCR_BV_ARG(0);
  return scr_dyn_new_bool(encoding->kind == SCR_DYN_STR && encoding->v.str->len > 0 &&
                          scr_bytes_is_encoding(encoding->v.str));
}

/* Buffer.concat(list, length): Node validates the list, answers an empty
 * Buffer for an empty list before it reads the length, and otherwise
 * validates the length as an offset. */
static ScrDyn *scr_bv_concat(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  const ScrDyn *list = SCR_BV_ARG(0), *length = SCR_BV_ARG(1);
  bool empty = list->kind == SCR_DYN_ARR && list->v.arr.len == 0;
  if (length->kind == SCR_DYN_UNDEF || empty || list->kind != SCR_DYN_ARR)
    return scr_bv_bytes(scr_buffer_concat_dyn(list));
  if (length->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("length", "of type number", length);
    return NULL;
  }
  return scr_bv_bytes(scr_buffer_concat_len_dyn(list, length->v.num));
}

static ScrDyn *scr_bv_byte_length(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  double length = scr_buffer_byte_length_value((ScrDyn *)SCR_BV_ARG(0), (ScrDyn *)SCR_BV_ARG(1));
  return scr_exc_pending() ? NULL : scr_dyn_new_num(length);
}

static ScrDyn *scr_bv_prototype(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_bv_unsupported("Buffer.prototype");
}

/* The pool's setting is the value's poolSize: a number as it is, another
 * primitive through ToNumber, anything else NaN (no pooling). */
static void scr_bv_pool_refresh(void) {
  ScrDyn *table = scr_dyn_function_properties(scr_bv_buffer);
  const ScrDyn *size = scr_dyn_obj_get(table, "poolSize", 8);
  double setting = NAN;
  if (size && size->kind == SCR_DYN_NUM) {
    setting = size->v.num;
  } else if (size && (size->kind == SCR_DYN_STR || size->kind == SCR_DYN_BOOL || size->kind == SCR_DYN_NULL ||
                      size->kind == SCR_DYN_UNDEF)) {
    if (!scr_dyn_number_coerce_js(size, &setting)) setting = NAN;
  }
  scr_dyn_release(table);
  scr_buffer_pool_apply(setting);
}

/* A static `Buffer.poolSize = n` write updates the value's property. */
static void scr_bv_pool_publish(double size) {
  ScrDyn *table = scr_dyn_function_properties(scr_bv_buffer);
  scr_dyn_obj_set(table, "poolSize", 8, scr_dyn_new_num(size));
  scr_dyn_release(table);
}

static void scr_bv_cleanup(void) {
  scr_buffer_pool_refresh_hook = NULL;
  scr_buffer_pool_publish_hook = NULL;
  scr_dyn_release(scr_bv_buffer);
  scr_bv_buffer = NULL;
}

ScrDyn *scr_buffer_constructor_value(void) {
  if (scr_bv_buffer) return scr_dyn_retain(scr_bv_buffer);
  static const struct { const char *name; uint32_t length; ScrDynThunk thunk; } statics[] = {
    {"from", 3, scr_bv_from},
    {"copyBytesFrom", 3, scr_bv_copy_bytes_from},
    {"of", 0, scr_bv_of},
    {"alloc", 3, scr_bv_alloc},
    {"allocUnsafe", 1, scr_bv_alloc_unsafe},
    {"allocUnsafeSlow", 1, scr_bv_alloc_unsafe_slow},
    {"isBuffer", 1, scr_bv_is_buffer},
    {"compare", 2, scr_bv_compare},
    {"isEncoding", 1, scr_bv_is_encoding},
    {"concat", 2, scr_bv_concat},
    {"byteLength", 2, scr_bv_byte_length},
  };
  double pool_size = scr_buffer_pool_size();
  scr_bv_buffer = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_bv_call, 3, "native:Buffer", "Buffer");
  scr_atexit(scr_bv_cleanup);
  ScrDyn *table = scr_dyn_function_properties(scr_bv_buffer);
  ScrDyn *getter = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_bv_prototype, 0, "native:function", "get prototype");
  scr_dyn_obj_set_accessor(table, "prototype", 9, getter, NULL);
  scr_dyn_obj_set_attrs_at(table, scr_dyn_obj_count(table) - 1, false, false, false);
  scr_dyn_obj_set(table, "poolSize", 8, scr_dyn_new_num(pool_size));
  ScrDyn *is_encoding = NULL;
  for (size_t i = 0; i < sizeof statics / sizeof statics[0]; i++) {
    ScrDyn *fn = scr_dyn_new_func(scr_closure_new(NULL, 0), statics[i].thunk, statics[i].length, "native:function",
                                  statics[i].name);
    if (statics[i].thunk == scr_bv_is_encoding) is_encoding = scr_dyn_retain(fn);
    scr_dyn_obj_set(table, statics[i].name, strlen(statics[i].name), fn);
  }
  scr_dyn_release(table);
  ScrStr *description = scr_str_new("kIsEncodingSymbol", 17);
  ScrSym *symbol = scr_sym_new(description);
  scr_str_release(description);
  ScrDyn *key = scr_dyn_new_symbol(symbol);
  scr_sym_release(symbol);
  scr_dyn_symbol_key_set(scr_bv_buffer, key, is_encoding);
  scr_dyn_release(key);
  scr_dyn_release(is_encoding);
  scr_buffer_pool_refresh_hook = scr_bv_pool_refresh;
  scr_buffer_pool_publish_hook = scr_bv_pool_publish;
  return scr_dyn_retain(scr_bv_buffer);
}

void scr_buffer_install_value(void) { scr_bytes_buffer_constructor_fn = scr_buffer_constructor_value; }

ScrDyn *scr_buffer_static_value(const ScrStr *name) {
  ScrDyn *buffer = scr_buffer_constructor_value();
  ScrDyn *member = scr_dyn_fn_get(buffer, name->data, name->len);
  scr_dyn_release(buffer);
  return member;
}

/* ── node:path functions read as values ──────────────────────────────
 * A stored `path.posix.join` or a `path.win32` namespace passed around
 * receives unchecked arguments, so these entries apply lib/path.js's
 * validators (validateString, validateObject) under Node's argument names
 * before the string algorithms in scr_path.c run. All borrow; results are
 * +1, or NULL with Node's ERR_INVALID_ARG_TYPE pending. */

/* validateString(value, name) */
static bool scr_bv_path_string(const ScrDyn *value, const char *name, size_t name_len) {
  if (value->kind == SCR_DYN_STR) return true;
  char text[64];
  int n = snprintf(text, sizeof text, "%.*s", (int)name_len, name);
  if (n < 0) text[0] = 0;
  scr_dyn_arg_type_fail(text, "of type string", value);
  return false;
}

ScrStr *scr_value_string(const ScrDyn *value, ScrStr *name) {
  if (!scr_bv_path_string(value, name->data, name->len)) return NULL;
  return scr_str_retain(value->v.str);
}

/* validateString over every argument of a rest list, in order (join's). */
ScrArr *scr_value_strings(const ScrDyn *args, ScrStr *name) {
  size_t n = (size_t)scr_dyn_arr_len(args);
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i < n; i++) {
    ScrDyn *arg = scr_dyn_arr_at(args, (double)i);
    bool ok = scr_bv_path_string(arg, name->data, name->len);
    if (ok) scr_arr_push_ref(out, scr_str_retain(arg->v.str));
    scr_dyn_release(arg);
    if (!ok) {
      scr_arr_release(out);
      return NULL;
    }
  }
  return out;
}

static bool scr_bv_w32_sep(char c) { return c == '/' || c == '\\'; }

static bool scr_bv_w32_ieq(const char *a, const char *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    char x = a[i] >= 'A' && a[i] <= 'Z' ? (char)(a[i] + 32) : a[i];
    char y = b[i] >= 'A' && b[i] <= 'Z' ? (char)(b[i] + 32) : b[i];
    if (x != y) return false;
  }
  return true;
}

/* win32.resolve's root match for one argument: the device it names (a UNC
 * share, a device namespace or a drive letter) written into `device`
 * (capacity len + 4), its length returned, and whether it is absolute. */
static size_t scr_bv_w32_device(const char *path, size_t len, char *device, bool *absolute) {
  *absolute = false;
  char code = path[0];
  if (len == 1) {
    *absolute = scr_bv_w32_sep(code);
    return 0;
  }
  if (scr_bv_w32_sep(code)) {
    *absolute = true;
    if (!scr_bv_w32_sep(path[1])) return 0;
    size_t j = 2, last = 2;
    while (j < len && !scr_bv_w32_sep(path[j])) j++;
    if (!(j < len && j != last)) return 0;
    size_t first = last, first_len = j - last;
    last = j;
    while (j < len && scr_bv_w32_sep(path[j])) j++;
    if (!(j < len && j != last)) return 0;
    last = j;
    while (j < len && !scr_bv_w32_sep(path[j])) j++;
    if (!(j == len || j != last)) return 0;
    size_t n = 0;
    device[n++] = '\\';
    device[n++] = '\\';
    memcpy(device + n, path + first, first_len);
    n += first_len;
    if (!(first_len == 1 && (path[first] == '.' || path[first] == '?'))) {
      device[n++] = '\\';
      memcpy(device + n, path + last, j - last);
      n += j - last;
    }
    return n;
  }
  if (((code >= 'A' && code <= 'Z') || (code >= 'a' && code <= 'z')) && path[1] == ':') {
    device[0] = path[0];
    device[1] = ':';
    *absolute = len > 2 && scr_bv_w32_sep(path[2]);
    return 2;
  }
  return 0;
}

/* Whether resolve's last-first walk over args[from, n) — all strings —
 * stops before it reaches args[from - 1]: posix stops at the first absolute
 * argument, win32 once it has an absolute path on a resolved device. */
static bool scr_bv_resolve_stops(const ScrDyn *args, long from, long n, bool win32) {
  bool stops = false, absolute = false;
  char *dev = NULL;
  size_t dev_len = 0;
  for (long i = n - 1; i >= from && !stops; i--) {
    ScrDyn *arg = scr_dyn_arr_at(args, (double)i);
    const ScrStr *s = arg->v.str;
    if (s->len > 0 && !win32) {
      stops = s->data[0] == '/';
    } else if (s->len > 0) {
      char *device = malloc(s->len + 4);
      if (!device) scr_trap("scriptc: out of memory\n");
      bool is_absolute;
      size_t len = scr_bv_w32_device(s->data, s->len, device, &is_absolute);
      bool other = false;
      if (len > 0 && dev_len > 0) {
        other = !(len == dev_len && scr_bv_w32_ieq(device, dev, len));
      } else if (len > 0) {
        free(dev);
        dev = device;
        dev_len = len;
        device = NULL;
      }
      free(device);
      if (!other && absolute) {
        stops = dev_len > 0;
      } else if (!other) {
        absolute = is_absolute;
        stops = is_absolute && dev_len > 0;
      }
    }
    scr_dyn_release(arg);
  }
  free(dev);
  return stops;
}

/* resolve(...args): Node validates `paths[i]` as its walk reaches each
 * argument, last first, and the walk ends at an absolute path, so a
 * non-string before that point is never read. */
ScrStr *scr_path_resolve_value(const ScrDyn *args, bool win32) {
  long n = (long)scr_dyn_arr_len(args);
  long last_bad = n - 1;
  for (; last_bad >= 0; last_bad--) {
    ScrDyn *arg = scr_dyn_arr_at(args, (double)last_bad);
    bool string = arg->kind == SCR_DYN_STR;
    scr_dyn_release(arg);
    if (!string) break;
  }
  if (last_bad >= 0 && !scr_bv_resolve_stops(args, last_bad + 1, n, win32)) {
    char name[32];
    int len = snprintf(name, sizeof name, "paths[%ld]", last_bad);
    ScrDyn *arg = scr_dyn_arr_at(args, (double)last_bad);
    scr_bv_path_string(arg, name, len < 0 ? 0 : (size_t)len);
    scr_dyn_release(arg);
    return NULL;
  }
  ScrArr *parts = scr_arr_new(SCR_ELEM_STR, (size_t)(n - last_bad - 1));
  for (long i = last_bad + 1; i < n; i++) {
    ScrDyn *arg = scr_dyn_arr_at(args, (double)i);
    scr_arr_push_ref(parts, scr_str_retain(arg->v.str));
    scr_dyn_release(arg);
  }
  ScrStr *out = win32 ? scr_path_win32_resolve(parts) : scr_path_resolve(parts);
  scr_arr_release(parts);
  return out;
}

/* parse(path): validateString, then a fresh { root, dir, base, ext, name }. */
ScrDyn *scr_path_parse_value(const ScrDyn *path, bool win32) {
  if (!scr_bv_path_string(path, "path", 4)) return NULL;
  ScrArr *parts = win32 ? scr_path_win32_parse(path->v.str) : scr_path_parse(path->v.str);
  static const char *const keys[] = {"root", "dir", "base", "ext", "name"};
  ScrDyn *out = scr_dyn_new_obj();
  for (size_t i = 0; i < 5; i++) {
    ScrStr *part = scr_arr_get_ref(parts, (double)i);
    scr_dyn_obj_set(out, keys[i], strlen(keys[i]), scr_dyn_new_str(part));
    scr_str_release(part);
  }
  scr_arr_release(parts);
  return out;
}

/* ToString for a template position (`${value}`); NULL with the error
 * pending (a Symbol). */
static bool scr_bv_append(ScrJsonBuf *b, const ScrDyn *value) {
  ScrStr *text = scr_dyn_string_coerce_js(value);
  if (!text) return false;
  scr_jb_write(b, text->data, text->len);
  scr_str_release(text);
  return true;
}

/* format(pathObject): lib/path.js's _format and formatExt over any object,
 * reading each property as Node does. The result is `base` itself when
 * there is no dir, so it need not be a string. */
ScrDyn *scr_path_format_value(const ScrDyn *object, bool win32) {
  ScrStr *type = scr_dyn_typeof(object);
  bool is_object = type->len == 6 && memcmp(type->data, "object", 6) == 0;
  scr_str_release(type);
  if (!is_object || object->kind == SCR_DYN_NULL || object->kind == SCR_DYN_ARR) {
    scr_dyn_arg_type_fail("pathObject", "of type object", object);
    return NULL;
  }
  ScrDyn *dir = scr_dyn_obj_read(object, "dir", 3);
  if (!dir) return NULL;
  if (!scr_dyn_truthy(dir)) {
    scr_dyn_release(dir);
    dir = scr_dyn_obj_read(object, "root", 4);
    if (!dir) return NULL;
  }
  ScrDyn *base = scr_dyn_obj_read(object, "base", 4);
  if (!base) goto fail_dir;
  if (!scr_dyn_truthy(base)) {
    scr_dyn_release(base);
    base = NULL;
    ScrJsonBuf b;
    scr_jb_init(&b);
    ScrDyn *name = scr_dyn_obj_read(object, "name", 4);
    bool ok = name != NULL && (!scr_dyn_truthy(name) || scr_bv_append(&b, name));
    if (name) scr_dyn_release(name);
    ScrDyn *ext = ok ? scr_dyn_obj_read(object, "ext", 3) : NULL;
    ok = ext != NULL;
    if (ok && scr_dyn_truthy(ext)) {
      /* `${ext[0] === '.' ? '' : '.'}${ext}` */
      bool dot = false;
      if (ext->kind == SCR_DYN_STR) {
        dot = ext->v.str->len > 0 && ext->v.str->data[0] == '.';
      } else if (ext->kind == SCR_DYN_OBJ || ext->kind == SCR_DYN_ARR || ext->kind == SCR_DYN_FUNC) {
        ScrDyn *first = ext->kind == SCR_DYN_ARR ? scr_dyn_arr_at(ext, 0) : scr_dyn_obj_read(ext, "0", 1);
        ok = first != NULL;
        dot = ok && first->kind == SCR_DYN_STR && first->v.str->len == 1 && first->v.str->data[0] == '.';
        if (first) scr_dyn_release(first);
      }
      if (ok && !dot) scr_jb_putc(&b, '.');
      ok = ok && scr_bv_append(&b, ext);
    }
    if (ext) scr_dyn_release(ext);
    ScrStr *text = scr_jb_finish(&b);
    if (!ok) {
      scr_str_release(text);
      goto fail_dir;
    }
    base = scr_dyn_new_str(text);
    scr_str_release(text);
  }
  if (!scr_dyn_truthy(dir)) {
    scr_dyn_release(dir);
    return base;
  }
  ScrDyn *root = scr_dyn_obj_read(object, "root", 4);
  if (!root) goto fail_base;
  bool same = scr_dyn_strict_eq(dir, root);
  scr_dyn_release(root);
  ScrJsonBuf b;
  scr_jb_init(&b);
  bool ok = scr_bv_append(&b, dir);
  if (ok && !same) scr_jb_putc(&b, win32 ? '\\' : '/');
  ok = ok && scr_bv_append(&b, base);
  ScrStr *text = scr_jb_finish(&b);
  scr_dyn_release(dir);
  scr_dyn_release(base);
  if (!ok) {
    scr_str_release(text);
    return NULL;
  }
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
fail_base:
  scr_dyn_release(base);
fail_dir:
  scr_dyn_release(dir);
  return NULL;
}

/* toNamespacedPath(path): posix answers its argument; win32 answers a
 * non-string or empty argument as it is and namespaces a string. */
ScrDyn *scr_path_to_namespaced_value(ScrDyn *path, bool win32) {
  if (!win32 || path->kind != SCR_DYN_STR || path->v.str->len == 0) return scr_dyn_retain(path);
  ScrStr *text = scr_path_win32_to_namespaced_path(path->v.str);
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}
