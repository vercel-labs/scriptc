/* Module namespace objects handed to typed code as checked-dynamic values.
 *
 * In Node a module namespace is a non-extensible null-prototype object whose
 * own properties are the module's exports in sorted order, which are
 * enumerable and read-only, whose Symbol.toStringTag is "Module", and whose
 * ToPrimitive finds no method. Every generic dynamic operation —
 * Object.keys/values/entries/getOwnPropertyNames, for-in, `in`,
 * JSON.stringify, identity, member reads and calls — already handles that
 * shape through scr_json.c's object
 * dispatch, so this unit only builds the object and links only into programs
 * that box a namespace.
 *
 * The exports stay live: each property is an accessor whose getter calls the
 * compiled namespace getter with the export name (the same getter the
 * JavaScript-source representation uses), and whose setter throws Node's
 * strict-mode read-only TypeError. An unknown name is not a member, so the
 * object's own not-extensible state answers Node's "Cannot add property".
 * One object per module keeps its identity.
 *
 * A JavaScript source takes a namespace of constant exports as a copy of
 * the values (moduleNamespaceObject); scr_module_namespace_copy_value keeps
 * the first copy per module, marks it as a module namespace and answers it
 * to every later request, so that copy has the same per-module identity.
 *
 * Node models the exports as writable data properties on a sealed object, so
 * Object.isFrozen answers false and Object.isSealed true. Live reads need
 * accessors here, and the accessor shape cannot be sealed without also
 * freezing: Object.isFrozen and Object.isExtensible answer as Node's do,
 * Object.isSealed does not. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

typedef struct ScrModuleNamespaceDyn {
  ScrStr *id;
  ScrDyn *object; /* retained for the program's lifetime */
  struct ScrModuleNamespaceDyn *next;
} ScrModuleNamespaceDyn;

static SCR_TL ScrModuleNamespaceDyn *scr_module_namespace_dyns;
static SCR_TL bool scr_module_namespace_dyn_cleanup_registered;

static void scr_module_namespace_dyn_cleanup(void) {
  while (scr_module_namespace_dyns) {
    ScrModuleNamespaceDyn *ns = scr_module_namespace_dyns;
    scr_module_namespace_dyns = ns->next;
    scr_str_release(ns->id);
    scr_dyn_release(ns->object);
    free(ns);
  }
}

/* An export's current value: the compiled getter takes the export name as a
 * dyn string and answers it +1. */
static ScrDyn *scr_module_namespace_dyn_read(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *getter = scr_box_get_ref(clo->caps[0]);
  ScrDyn *name = scr_box_get_ref(clo->caps[1]);
  ScrDyn *argument = scr_dyn_retain(name);
  ScrDyn *value = scr_dyn_call(getter, &argument, 1, "module namespace export");
  scr_dyn_release(argument);
  scr_dyn_release(name);
  scr_dyn_release(getter);
  return value;
}

/* A namespace export is read-only: Node's strict-mode TypeError names the
 * export and the namespace's [object Module] tag. */
static ScrDyn *scr_module_namespace_dyn_write(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *name = scr_box_get_ref(clo->caps[0]);
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "Cannot assign to read only property '");
  scr_jb_write(&text, name->v.str->data, name->v.str->len);
  scr_jb_puts(&text, "' of object '[object Module]'");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
  scr_str_release(message);
  scr_dyn_release(name);
  return NULL;
}

/* `thunk` as a dynamic function over one or two captured dynamic values. */
static ScrDyn *scr_module_namespace_dyn_fn(ScrDynThunk thunk, ScrDyn *first, ScrDyn *second) {
  ScrClosure *closure = scr_closure_new(NULL, second ? 2 : 1);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_retain(first));
  if (second) {
    closure->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(closure->caps[1], scr_dyn_retain(second));
  }
  return scr_dyn_new_func(closure, thunk, 0, "native:module namespace", "module namespace export");
}

/* The namespace object: null prototype, one enumerable read-only accessor per
 * export in `keys` order, a non-writable Symbol.toStringTag of "Module", and
 * not extensible. */
static ScrDyn *scr_module_namespace_dyn_build(ScrArr *keys, ScrDyn *getter, ScrDyn *tag_key) {
  ScrDyn *object = scr_dyn_new_obj_null_proto();
  for (size_t i = 0; i < keys->len; i++) {
    ScrStr *key = scr_arr_get_ref(keys, (double)i); /* +1 */
    ScrDyn *name = scr_dyn_new_str(key);
    ScrDyn *read = scr_module_namespace_dyn_fn(scr_module_namespace_dyn_read, getter, name);
    ScrDyn *write = scr_module_namespace_dyn_fn(scr_module_namespace_dyn_write, name, NULL);
    scr_dyn_obj_set_accessor(object, key->data, key->len, read, write);
    scr_dyn_release(name);
    scr_str_release(key);
  }
  ScrStr *tag = scr_str_new("Module", 6);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_str(tag));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(false));
  scr_dyn_release(scr_dyn_define_property(object, tag_key, descriptor));
  scr_str_release(tag);
  scr_dyn_release(descriptor);
  scr_dyn_release(scr_dyn_prevent_extensions(object));
  if (scr_exc_pending()) {
    /* The tag key is a well-known symbol, so this cannot fail in practice; a
     * pending exception still must not be cached. */
    scr_dyn_release(object);
    return NULL;
  }
  return object;
}

/* Node's isModuleNamespaceObject brand over this thread's boxed namespaces:
 * a program module's ("file:") box and a builtin's ES module spelling
 * ("esm:") box carry it. The sub-namespace member's box uses the bare
 * builtin id and does not, because it stands in for values Node answers
 * false for (`fs.promises` and the other sub-module members are CommonJS
 * exports objects); asked of the import binding itself the call site
 * answers without the box. */
static bool scr_module_namespace_dyn_brand(const ScrDyn *value) {
  for (ScrModuleNamespaceDyn *ns = scr_module_namespace_dyns; ns; ns = ns->next) {
    if (ns->object != value) continue;
    if (ns->id->len >= 5 && memcmp(ns->id->data, "file:", 5) == 0) return true;
    return ns->id->len >= 4 && memcmp(ns->id->data, "esm:", 4) == 0;
  }
  return false;
}

ScrDyn *scr_module_namespace_dyn_value(ScrStr *id, ScrArr *keys, ScrDyn *getter, ScrDyn *tag_key) {
  scr_module_namespace_dyn_is = scr_module_namespace_dyn_brand;
  for (ScrModuleNamespaceDyn *ns = scr_module_namespace_dyns; ns; ns = ns->next) {
    if (ns->id->len == id->len && memcmp(ns->id->data, id->data, id->len) == 0)
      return scr_dyn_retain(ns->object);
  }
  if (!scr_module_namespace_dyn_cleanup_registered) {
    scr_atexit(scr_module_namespace_dyn_cleanup);
    scr_module_namespace_dyn_cleanup_registered = true;
  }
  ScrDyn *object = scr_module_namespace_dyn_build(keys, getter, tag_key);
  if (!object) return NULL;
  ScrModuleNamespaceDyn *ns = malloc(sizeof(*ns));
  if (!ns) scr_trap("scriptc: out of memory\n");
  *ns = (ScrModuleNamespaceDyn){ scr_str_retain(id), scr_dyn_retain(object), scr_module_namespace_dyns };
  scr_module_namespace_dyns = ns;
  return object;
}

/* A JavaScript source's namespace: the object it built from the module's
 * export values (moduleNamespaceObject), which Node answers as the module's
 * one namespace object. The first copy the program builds is kept for the
 * program's lifetime, marked as a module namespace for util.types, and
 * answered to every later request for the same module, so a namespace taken
 * as a value twice is the same object as in Node. `object` is borrowed; the
 * result is +1. */
typedef struct ScrModuleNamespaceCopy {
  ScrStr *id;
  ScrDyn *object; /* retained for the program's lifetime */
  struct ScrModuleNamespaceCopy *next;
} ScrModuleNamespaceCopy;

static SCR_TL ScrModuleNamespaceCopy *scr_module_namespace_copies;
static SCR_TL bool scr_module_namespace_copy_cleanup_registered;

static void scr_module_namespace_copy_cleanup(void) {
  while (scr_module_namespace_copies) {
    ScrModuleNamespaceCopy *copy = scr_module_namespace_copies;
    scr_module_namespace_copies = copy->next;
    scr_str_release(copy->id);
    scr_dyn_release(copy->object);
    free(copy);
  }
}

ScrDyn *scr_module_namespace_copy_value(ScrStr *id, ScrDyn *object) {
  for (ScrModuleNamespaceCopy *copy = scr_module_namespace_copies; copy; copy = copy->next) {
    if (copy->id->len == id->len && memcmp(copy->id->data, id->data, id->len) == 0)
      return scr_dyn_retain(copy->object);
  }
  if (!scr_module_namespace_copy_cleanup_registered) {
    scr_atexit(scr_module_namespace_copy_cleanup);
    scr_module_namespace_copy_cleanup_registered = true;
  }
  scr_dyn_mark_module_namespace(object);
  ScrModuleNamespaceCopy *copy = malloc(sizeof(*copy));
  if (!copy) scr_trap("scriptc: out of memory\n");
  *copy = (ScrModuleNamespaceCopy){
    scr_str_retain(id), scr_dyn_retain(object), scr_module_namespace_copies
  };
  scr_module_namespace_copies = copy;
  return scr_dyn_retain(object);
}
