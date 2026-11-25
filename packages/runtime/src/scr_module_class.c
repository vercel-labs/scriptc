/* node:module's `Module` class as a value (feature moduleClass).
 *
 * In Node every CommonJS `module` is an instance of this class: the
 * prototype the module object exposes through Object.getPrototypeOf is
 * Module.prototype, `module instanceof Module` holds, and its constructor
 * is the `Module` export. A compiled program loads no JavaScript at run
 * time, so the class's loading surface cannot run: `Module.prototype
 * .require` and `load`/`_compile` refuse when called, exactly as the
 * compiler refuses the same operations statically, and `new Module()`
 * refuses because no module can exist outside the build-time graph.
 *
 * The class object itself is the runtime's ordinary handle class (the one
 * url.Url and the dns resolvers use), so `.prototype`, `.name`, `.length`
 * and instanceof answer through the same machinery. Module views adopt the
 * prototype through scr_module_class_prototype below, which scr_lib.c
 * reaches through a weak declaration: a program that never names `Module`
 * links no part of this unit and its module objects pay nothing.
 */
#include "scr_runtime.h"

static ScrDyn *scr_module_class_refuse(const char *what) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "'");
  scr_jb_puts(&text, what);
  scr_jb_puts(&text, "' is part of the standard library types but has no scriptc lowering yet");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
  return NULL;
}

static ScrDyn *scr_module_class_construct(ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  return scr_module_class_refuse("new Module()");
}

static ScrDyn *scr_module_class_method(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  const char *what = (const char *)clo->fn;
  return scr_module_class_refuse(what);
}

static ScrDyn *scr_module_class_false_member(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  (void)args;
  (void)argc;
  return scr_dyn_new_bool(false);
}

static ScrDyn *scr_module_class_undefined_member(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  (void)args;
  (void)argc;
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_module_class_method_value(const char *what, uint32_t arity, const char *name) {
  ScrClosure *closure = scr_closure_new((void *)what, 0);
  return scr_dyn_new_func(closure, scr_module_class_method, arity, "native:module", name);
}

static void *scr_module_class_retain(void *h) { return h; }
static void scr_module_class_release(void *h) { (void)h; }

static const ScrDynHandleOps scr_module_class_ops = {
  .cls = "Module",
  .retain = scr_module_class_retain,
  .release = scr_module_class_release,
};

static const ScrDynHandleClass scr_module_class_kt = {
  .name = "Module",
  /* Node's Module.length is 0: its constructor takes only the optional id. */
  .length = 0,
  .construct = scr_module_class_construct,
};

static bool scr_module_class_ready;

static void scr_module_class_ensure(void) {
  if (scr_module_class_ready) return;
  scr_dyn_handle_class_install(SCR_DYNH_MODULE_CLASS, &scr_module_class_ops, &scr_module_class_kt);
  ScrDyn *prototype = scr_dyn_handle_class_prototype(SCR_DYNH_MODULE_CLASS);
  if (prototype != NULL) {
    scr_dyn_obj_set(prototype, "require", 7, scr_module_class_method_value("module.require", 1, "require"));
    scr_dyn_obj_set(prototype, "load", 4, scr_module_class_method_value("module.load", 1, "load"));
    scr_dyn_obj_set(prototype, "_compile", 8, scr_module_class_method_value("module._compile", 3, "_compile"));
    ScrDyn *parent_get = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_module_class_undefined_member, 0,
                                          "native:module", "get parent");
    ScrDyn *preloading_get = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_module_class_false_member, 0,
                                              "native:module", "get isPreloading");
    scr_dyn_obj_set_accessor(prototype, "parent", 6, parent_get, NULL);
    scr_dyn_obj_set_accessor(prototype, "isPreloading", 12, preloading_get, NULL);
    scr_dyn_release(prototype);
  }
  scr_module_class_ready = true;
}

ScrDyn *scr_module_class_value(void) {
  scr_module_class_ensure();
  return scr_dyn_handle_class_value(SCR_DYNH_MODULE_CLASS);
}

ScrDyn *scr_module_class_prototype(void) {
  scr_module_class_ensure();
  return scr_dyn_handle_class_prototype(SCR_DYNH_MODULE_CLASS);
}
