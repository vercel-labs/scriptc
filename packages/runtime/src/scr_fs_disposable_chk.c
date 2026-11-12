/* The checked ladders of the disposable mkdtemp family:
 * fs.mkdtempDisposableSync(prefix, options) and
 * fs.promises.mkdtempDisposable(prefix, options), where the prefix is a
 * checked-dynamic value and the options walk runs Node's getOptions first.
 *
 * Apart from scr_fs_disposable.c, which holds the record builders and the
 * statically typed entry points, because these ladders also convert the
 * prefix through the path-value unit: the calls that emit them select the
 * dyn-async, symbol and path-value features together, so the unit links only
 * where all three units do. */
#include "scr_runtime.h"

/* The untyped ladder: Node's getOptions (options shape, then the encoding
 * name), then getValidatedPath's 'prefix' slot, then the real mkdtemp. */
ScrDyn *scr_fs_mkdtemp_disposable_sync_chk(const ScrDyn *prefix, const ScrDyn *opts) {
  if (!scr_fs_encoding_chk(opts)) return NULL;
  ScrStr *name = scr_str_new("prefix", 6);
  ScrStr *path = scr_value_fs_path(prefix, name, false);
  scr_str_release(name);
  if (path == NULL) return NULL;
  ScrStr *created = scr_fs_mkdtemp(path);
  scr_str_release(path);
  if (created == NULL) return NULL;
  ScrStr *encoding = scr_fs_mkdtemp_encoding_name(opts);
  ScrDyn *record = scr_fs_mkdtemp_disposable_build(created, encoding, false);
  scr_str_release(encoding);
  return record;
}

ScrPromise *scr_fsp_mkdtemp_disposable_chk(const ScrDyn *prefix, const ScrDyn *opts) {
  ScrDyn *record = NULL;
  if (scr_fs_encoding_chk(opts)) {
    ScrStr *name = scr_str_new("prefix", 6);
    ScrStr *path = scr_value_fs_path(prefix, name, false);
    scr_str_release(name);
    if (path != NULL) {
      ScrStr *created = scr_fs_mkdtemp_async(path);
      scr_str_release(path);
      if (created != NULL) {
        ScrStr *encoding = scr_fs_mkdtemp_encoding_name(opts);
        record = scr_fs_mkdtemp_disposable_build(created, encoding, true);
        scr_str_release(encoding);
      }
    }
  }
  return scr_promise_settled_ref(record, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}
