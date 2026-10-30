/* Module namespace objects as checked-dynamic values
 * (module-namespace-elements.ts lowers `import * as ns` values here). */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

/* A module namespace object taken as a checked-dynamic value
 * (module-namespace-elements.ts). The compiled getter answers an export's
 * current value by name, so reads see live bindings; `keys` lists the
 * namespace's export names. One object per module keeps its identity.
 * Writes throw Node's strict-mode TypeError for a frozen namespace. */
typedef struct ScrModuleNamespace {
  size_t rc;
  ScrStr *id;
  ScrDyn *getter;
  ScrArr *keys;
  struct ScrModuleNamespace *next;
} ScrModuleNamespace;

static SCR_TL ScrModuleNamespace *scr_module_namespaces;
static SCR_TL bool scr_module_namespace_cleanup_registered;

static void *scr_module_namespace_retain(void *handle) {
  ScrModuleNamespace *ns = handle;
  ns->rc++;
  return ns;
}

static void scr_module_namespace_release(void *handle) {
  ScrModuleNamespace *ns = handle;
  if (--ns->rc) return;
  scr_str_release(ns->id);
  scr_dyn_release(ns->getter);
  scr_arr_release(ns->keys);
  free(ns);
}

static void scr_module_namespace_cleanup(void) {
  while (scr_module_namespaces) {
    ScrModuleNamespace *ns = scr_module_namespaces;
    scr_module_namespaces = ns->next;
    scr_module_namespace_release(ns);
  }
}

static bool scr_module_namespace_has(const ScrModuleNamespace *ns, const char *key, size_t length) {
  for (size_t i = 0; i < ns->keys->len; i++) {
    ScrStr *entry = (ScrStr *)scr_arr_get_ref(ns->keys, (double)i);
    bool same = entry->len == length && memcmp(entry->data, key, length) == 0;
    scr_str_release(entry);
    if (same) return true;
  }
  return false;
}

static ScrDyn *scr_module_namespace_get(void *handle, const char *key, size_t length) {
  ScrModuleNamespace *ns = handle;
  if (!scr_module_namespace_has(ns, key, length)) return NULL;
  ScrStr *name = scr_str_new(key, length);
  ScrDyn *arg = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *result = scr_dyn_call(ns->getter, &arg, 1, "module namespace export");
  scr_dyn_release(arg);
  return result;
}

static bool scr_module_namespace_set(void *handle, const char *key, size_t length, const ScrDyn *value) {
  (void)value;
  ScrModuleNamespace *ns = handle;
  ScrJsonBuf text;
  scr_jb_init(&text);
  if (scr_module_namespace_has(ns, key, length)) {
    scr_jb_puts(&text, "Cannot assign to read only property '");
    scr_jb_write(&text, key, length);
    scr_jb_puts(&text, "' of object '[object Module]'");
  } else {
    scr_jb_puts(&text, "Cannot add property ");
    scr_jb_write(&text, key, length);
    scr_jb_puts(&text, ", object is not extensible");
  }
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
  scr_str_release(message);
  return true;
}

static ScrDyn *scr_module_namespace_invoke(void *handle, ScrDyn *self, const char *key,
                                           ScrDyn *const *args, size_t argc, const char *what) {
  ScrDyn *fn = scr_module_namespace_get(handle, key, strlen(key));
  if (fn == NULL) {
    if (scr_exc_pending()) return NULL;
    fn = scr_dyn_retain(scr_dyn_undefined());
  }
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

ScrDyn *scr_module_namespace_value(ScrStr *id, ScrArr *keys, ScrDyn *getter) {
  static const ScrDynHandleOps ops = {
    .cls = "Module", .retain = scr_module_namespace_retain, .release = scr_module_namespace_release,
    .get = scr_module_namespace_get, .set = scr_module_namespace_set, .invoke = scr_module_namespace_invoke,
  };
  scr_dyn_handle_install(SCR_DYNH_MODULE_NAMESPACE, &ops);
  for (ScrModuleNamespace *ns = scr_module_namespaces; ns; ns = ns->next) {
    if (ns->id->len == id->len && memcmp(ns->id->data, id->data, id->len) == 0)
      return scr_dyn_new_handle(ns, SCR_DYNH_MODULE_NAMESPACE);
  }
  if (!scr_module_namespace_cleanup_registered) {
    scr_atexit(scr_module_namespace_cleanup);
    scr_module_namespace_cleanup_registered = true;
  }
  ScrModuleNamespace *ns = malloc(sizeof(*ns));
  if (!ns) scr_trap("scriptc: out of memory\n");
  *ns = (ScrModuleNamespace){ 1, scr_str_retain(id), scr_dyn_retain(getter), scr_arr_retain(keys), scr_module_namespaces };
  scr_module_namespaces = ns;
  return scr_dyn_new_handle(ns, SCR_DYNH_MODULE_NAMESPACE);
}
