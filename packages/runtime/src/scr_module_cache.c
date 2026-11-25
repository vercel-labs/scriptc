/* node:module's compile cache family: enableCompileCache, getCompileCacheDir,
 * flushCompileCache and constants.compileCacheStatus.
 *
 * Node's compile cache stores V8's code cache of the JavaScript a process
 * loads. A compiled program loads none, so there is nothing to store: the
 * calls validate their arguments as Node's do and answer what Node answers
 * when the cache is disabled, the one status the documentation gives for "the
 * cache cannot be enabled, and that is not an error". A Node island keeps its
 * own cache, which the runtime decides before any island module loads; these
 * calls do not start Node and do not reach it.
 *
 * The unit is linked only by a program that names one of the four members. */
#include "scr_runtime.h"

#include <string.h>

/* Node's compileCacheStatus, in its order: the value is the index. */
static const char *const scr_module_cache_statuses[] = {"FAILED", "ENABLED", "ALREADY_ENABLED",
                                                        "DISABLED"};
#define SCR_MODULE_CACHE_DISABLED 3

/* Reads `key` off the options object the way a property read in the program
 * does: a checked record or class instance boxed as a dynamic value answers
 * from its native fields or its view. NULL with the error pending when a
 * getter throws. */
static ScrDyn *scr_module_cache_member(const ScrDyn *object, const char *key, size_t key_len) {
  if (object->kind != SCR_DYN_TYPED_REF) return scr_dyn_obj_read(object, key, key_len);
  ScrStr *name = scr_str_new(key, key_len);
  ScrDyn *value = scr_dyn_typed_ref_own_get(object, name);
  if (!value) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    if (view) {
      value = scr_dyn_obj_read(view, key, key_len);
      scr_dyn_release(view);
    }
  }
  scr_str_release(name);
  return value;
}

/* lib/internal/modules/helpers.js's enableCompileCache: an object names the
 * directory in its `directory` property (and `portable`, read after it), any
 * other value is the directory; undefined selects the default directory, and
 * anything else that is not a string is src/node_modules.cc's TypeError. */
ScrDyn *scr_module_enable_compile_cache(const ScrDyn *options) {
  ScrDyn *directory;
  if (options->kind != SCR_DYN_NULL && scr_dyn_is_object(options)) {
    directory = scr_module_cache_member(options, "directory", 9);
    if (!directory) return NULL;
    ScrDyn *portable = scr_module_cache_member(options, "portable", 8);
    if (!portable) {
      scr_dyn_release(directory);
      return NULL;
    }
    scr_dyn_release(portable);
  } else {
    directory = scr_dyn_retain((ScrDyn *)options);
  }
  bool valid = directory->kind == SCR_DYN_UNDEF || directory->kind == SCR_DYN_STR;
  scr_dyn_release(directory);
  if (!valid) {
    static const char text[] = "cacheDir should be a string";
    scr_throw_error_msg_code(SCR_ERR_TYPE, text, sizeof text - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  /* Node's own message when the variable is set (any value, the empty string
   * included); otherwise the reason that holds here. */
  static const char by_variable[] = "Disabled by NODE_DISABLE_COMPILE_CACHE";
  static const char by_build[] = "Disabled: a natively compiled program has no compile cache";
  ScrStr *name = scr_str_new("NODE_DISABLE_COMPILE_CACHE", 26);
  ScrStr *set = scr_env_get(name);
  scr_str_release(name);
  ScrStr *message = set ? scr_str_new(by_variable, sizeof by_variable - 1)
                        : scr_str_new(by_build, sizeof by_build - 1);
  if (set) scr_str_release(set);
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "status", 6, scr_dyn_new_num(SCR_MODULE_CACHE_DISABLED));
  scr_dyn_obj_set(result, "message", 7, scr_dyn_new_str(message));
  scr_str_release(message);
  return result;
}

ScrDyn *scr_module_compile_cache_dir(void) { return scr_dyn_undefined(); }

ScrDyn *scr_module_flush_compile_cache(const ScrDyn *keep) {
  if (keep->kind == SCR_DYN_UNDEF || keep->kind == SCR_DYN_BOOL) return scr_dyn_undefined();
  static const char text[] = "keepDeserializedCache should be a boolean";
  scr_throw_error_msg_code(SCR_ERR_TYPE, text, sizeof text - 1, "ERR_INVALID_ARG_TYPE");
  return NULL;
}

static SCR_TL ScrDyn *scr_module_constants_value;
static void scr_module_constants_clear(void) {
  ScrDyn *value = scr_module_constants_value;
  scr_module_constants_value = NULL;
  scr_dyn_release(value);
}

ScrDyn *scr_module_constants(void) {
  if (scr_module_constants_value) return scr_dyn_retain(scr_module_constants_value);
  ScrDyn *constants = scr_dyn_new_obj_null_proto();
  ScrDyn *statuses = scr_dyn_new_obj_null_proto();
  for (size_t i = 0; i < sizeof scr_module_cache_statuses / sizeof *scr_module_cache_statuses; i++) {
    const char *name = scr_module_cache_statuses[i];
    scr_dyn_obj_set(statuses, name, strlen(name), scr_dyn_new_num((double)i));
  }
  scr_dyn_release(scr_dyn_freeze_data(statuses));
  scr_dyn_obj_set(constants, "compileCacheStatus", 18, statuses);
  scr_dyn_release(scr_dyn_freeze_data(constants));
  scr_module_constants_value = constants;
  scr_atexit(scr_module_constants_clear);
  return scr_dyn_retain(constants);
}
