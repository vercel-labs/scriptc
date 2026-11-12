/* fs.openAsBlob's checked ladder. Apart from scr_bytes_io.c because it
 * converts the path through the path-value unit and opens the file-backed
 * record from the Blob unit: the call that emits it selects the dyn-async
 * and path-value features, and those two units link with it. A program that
 * never opens a Blob from a path links none of this. */
#include "scr_runtime.h"

#include <string.h>

/* validateObject(options, 'options') as openAsBlob runs it: an object of any
 * kind (an array or a function is not one), absent for the missing argument
 * that Node defaults to an empty object. */
static bool scr_fs_blob_options_object(const ScrDyn *options) {
  /* Node's validateObject admits an omitted (undefined) options value and
   * rejects null with the same type error as the primitives. */
  if (options->kind == SCR_DYN_UNDEF) return true;
  switch (options->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
    return true;
  case SCR_DYN_TYPED_REF: return !scr_dyn_ref_is_array(options);
  case SCR_DYN_PROXY: return scr_dyn_is_object(options);
  default: return false; /* null and the primitives, arrays, functions */
  }
}

/* fs.openAsBlob(path[, options]) — Node's SYNCHRONOUS ladder (the call
 * throws; it returns a promise that is already resolved): validateObject,
 * `options.type || ''` and its string check, getValidatedPath (the path's
 * type, a URL's conversion and the null-byte check), then the stat whose
 * failure is Node's "stat '<path>'" error. The Blob reads the file lazily,
 * re-checking the stat snapshot on every read. */
ScrPromise *scr_fs_open_as_blob_chk(const ScrDyn *path_value, const ScrDyn *options) {
  if (!scr_fs_blob_options_object(options)) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  ScrDyn *raw_type = NULL;
  if (options->kind != SCR_DYN_UNDEF) {
    raw_type = scr_fs_option_get(options, "type");
    if (!raw_type) return NULL;
  }
  ScrStr *type;
  if (raw_type != NULL && scr_dyn_truthy(raw_type)) {
    if (raw_type->kind != SCR_DYN_STR) {
      scr_dyn_prop_type_fail("options.type", "of type string", raw_type);
      scr_dyn_release(raw_type);
      return NULL;
    }
    type = scr_str_retain(raw_type->v.str);
  } else {
    type = scr_str_new("", 0);
  }
  scr_dyn_release(raw_type);
  ScrStr *name = scr_str_new("path", 4);
  ScrStr *path = scr_value_fs_path(path_value, name, false);
  scr_str_release(name);
  if (path == NULL) {
    scr_str_release(type);
    return NULL;
  }
  if (memchr(path->data, 0, path->len)) {
    scr_fs_invalid_path(path_value, path);
    scr_str_release(path);
    scr_str_release(type);
    return NULL;
  }
  int error = 0;
  ScrStats *st = scr_stats_poll_path(path, &error);
  if (st == NULL) {
    scr_fs_throw(error, "stat", path);
    scr_str_release(path);
    scr_str_release(type);
    return NULL;
  }
  ScrDyn *blob = scr_blob_open_file(path, type, scr_stats_size(st), scr_stats_mtime_nsec(st),
                                    scr_stats_dev(st), scr_stats_ino(st));
  scr_stats_release(st);
  scr_str_release(path);
  scr_str_release(type);
  return scr_promise_settled_ref(blob, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}
