/* fs.mkdtempDisposableSync and fs.promises.mkdtempDisposable: Node 24's
 * disposable temporary directories (lib/fs.js and internal/fs/promises).
 *
 * Both create the directory first, report it through `path` in the requested
 * encoding, and stash `path.resolve(shown)` for a `remove()` that keeps
 * working after process.chdir(). The sync record is an ordinary object whose
 * remove and [Symbol.dispose] are separate functions that delete the tree
 * synchronously; the promise record has a null prototype, an async
 * remove / [Symbol.asyncDispose], and is what `await using` calls.
 *
 * The record builders live in this unit rather than beside the fs ladders in
 * scr_bytes_io.c: they key the dispose member with the symbol unit's
 * well-known symbols and box the async form's outcome through the dyn-promise
 * unit, and the entry points that call them select both features. A program
 * that never creates one links none of this, and the always-linked
 * scr_bytes_io.c names no optional unit. The checked ladders that also
 * convert a prefix through the path-value unit share the builder from
 * scr_fs_disposable_chk.c. */
#include "scr_runtime.h"

#include <string.h>

static bool scr_fs_disposable_str_is(const ScrStr *s, const char *lit) {
  size_t n = strlen(lit);
  return s->len == n && memcmp(s->data, lit, n) == 0;
}

/* The reported path in `encoding` (Node's binding mkdtemp re-encodes the
 * UTF-8 path through StringBytes::Encode); "buffer" is handled by the
 * caller because Node's own resolve then throws. Consumes +1 path. */
static ScrStr *scr_fs_mkdtemp_encoded_path(ScrStr *path, const ScrStr *encoding) {
  if (encoding == NULL || encoding->len == 0 ||
      scr_fs_disposable_str_is(encoding, "utf8") ||
      scr_fs_disposable_str_is(encoding, "utf-8"))
    return path;
  ScrBytes *bytes = scr_bytes_from_data((const uint8_t *)path->data, path->len);
  ScrStr *text = scr_bytes_to_str(bytes, encoding);
  scr_bytes_release(bytes);
  scr_str_release(path);
  return text;
}

/* The encoding name of a mkdtemp options value: absent, false, 0, NaN and
 * the empty string keep the utf8 default (NULL), a truthy string names the
 * encoding (+1). The options shape and the name itself were validated by
 * scr_fs_encoding_chk first, exactly where Node's getOptions runs. */
ScrStr *scr_fs_mkdtemp_encoding_name(const ScrDyn *opts) {
  ScrDyn *materialized = NULL;
  if (opts->kind == SCR_DYN_TYPED_REF) {
    materialized = scr_dyn_typed_ref_materialize(opts);
    if (!materialized || scr_exc_pending()) {
      scr_dyn_release(materialized);
      return NULL;
    }
    opts = materialized;
  }
  ScrStr *name = NULL;
  const ScrDyn *enc = opts;
  if (opts->kind == SCR_DYN_OBJ) enc = scr_dyn_obj_get(opts, "encoding", 8);
  if (enc != NULL && enc->kind == SCR_DYN_STR && enc->v.str->len > 0)
    name = scr_str_retain(enc->v.str);
  scr_dyn_release(materialized);
  return name;
}

/* A closure over the stashed absolute path the record's functions remove. */
static ScrClosure *scr_fs_disposable_capture(const ScrStr *full) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(closure->caps[0], scr_dyn_new_str((ScrStr *)full));
  return closure;
}

static ScrStr *scr_fs_disposable_captured(ScrClosure *closure) {
  ScrDyn *path = scr_box_get_ref(closure->caps[0]);
  ScrStr *full = path != NULL && path->kind == SCR_DYN_STR ? scr_str_retain(path->v.str) : NULL;
  scr_dyn_release(path);
  return full;
}

/* remove(): Node's binding.rmSync(fullPath, 0, true, 100) — recursive and
 * force-like, so a second call is harmless. */
static ScrDyn *scr_fs_disposable_remove_call(ScrClosure *closure, ScrDyn *const *args,
                                             size_t argc) {
  (void)args;
  (void)argc;
  ScrStr *full = scr_fs_disposable_captured(closure);
  if (full != NULL) {
    scr_fs_rm_opts(full, true, true);
    scr_str_release(full);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The async form's remove(): the same synchronous delete, its outcome moved
 * into the promise (the fs/promises bridge's settled shape). */
static ScrDyn *scr_fs_disposable_remove_async_call(ScrClosure *closure, ScrDyn *const *args,
                                                   size_t argc) {
  (void)args;
  (void)argc;
  ScrStr *full = scr_fs_disposable_captured(closure);
  if (full != NULL) {
    scr_fs_rm_opts(full, true, true);
    scr_str_release(full);
  }
  ScrPromise *promise = scr_promise_settled_void();
  ScrDyn *boxed = scr_dyn_new_promise(promise);
  scr_promise_release(promise);
  return boxed;
}

/* Builds the record. Consumes +1 `created` (the binding's raw UTF-8 path).
 * `async` selects the promise form's shape: null prototype, async remove,
 * [Symbol.asyncDispose]. Answers +1, or NULL with the exception pending. */
ScrDyn *scr_fs_mkdtemp_disposable_build(ScrStr *created, const ScrStr *encoding, bool async) {
  if (encoding != NULL && scr_fs_disposable_str_is(encoding, "buffer")) {
    /* Node hands path.resolve(process.cwd(), <Buffer>) its second argument:
     * validateString names paths[1]. The directory has already been
     * created, exactly as in Node. */
    ScrBytes *bytes = scr_bytes_from_data((const uint8_t *)created->data, created->len);
    bytes->is_buffer = true;
    ScrDyn *got = scr_dyn_new_bytes(bytes);
    scr_bytes_release(bytes);
    scr_dyn_arg_type_fail("paths[1]", "of type string", got);
    scr_dyn_release(got);
    scr_str_release(created);
    return NULL;
  }
  ScrStr *shown = scr_fs_mkdtemp_encoded_path(created, encoding);
  ScrArr *parts = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(parts, scr_str_retain(shown));
  ScrStr *full = scr_path_resolve(parts);
  scr_arr_release(parts);

  ScrDyn *record = async ? scr_dyn_new_obj_null_proto() : scr_dyn_new_obj();
  scr_dyn_obj_set(record, "path", 4, scr_dyn_new_str(shown));
  ScrDynThunk remove = async ? scr_fs_disposable_remove_async_call : scr_fs_disposable_remove_call;
  scr_dyn_obj_set(record, "remove", 6,
                  scr_dyn_new_func(scr_fs_disposable_capture(full), remove, 0, "()", "remove"));
  ScrDyn *dispose =
      scr_dyn_new_func(scr_fs_disposable_capture(full), remove, 0, "()",
                       async ? "[Symbol.asyncDispose]" : "[Symbol.dispose]");
  ScrStr *symbol_name = scr_str_new(async ? "asyncDispose" : "dispose", async ? 12 : 7);
  ScrSym *symbol = scr_sym_well_known(symbol_name);
  scr_str_release(symbol_name);
  ScrDyn *key = scr_dyn_new_symbol(symbol);
  scr_sym_release(symbol);
  scr_dyn_symbol_key_set(record, key, dispose);
  scr_dyn_release(key);
  scr_dyn_release(dispose);
  scr_str_release(shown);
  scr_str_release(full);
  return record;
}

/* fs.mkdtempDisposableSync(prefix): the statically typed one-argument
 * form. */
ScrDyn *scr_fs_mkdtemp_disposable_sync(ScrStr *prefix) {
  ScrStr *created = scr_fs_mkdtemp(prefix);
  return created != NULL ? scr_fs_mkdtemp_disposable_build(created, NULL, false) : NULL;
}

/* fs.promises.mkdtempDisposable(prefix): Node's async function turns every
 * validation and mkdtemp failure into a rejection. */
ScrPromise *scr_fsp_mkdtemp_disposable(ScrStr *prefix) {
  ScrStr *created = scr_fs_mkdtemp_async(prefix);
  ScrDyn *record = created != NULL ? scr_fs_mkdtemp_disposable_build(created, NULL, true) : NULL;
  return scr_promise_settled_ref(record, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}
