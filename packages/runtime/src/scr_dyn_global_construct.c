/* `new C(...args)` through the interned builtin constructors
 * (scr_dyn_inherited.c): the collections and dates they build reference the
 * date, time-zone and collection code, so only programs that can construct
 * through such a value link this unit (the dyn-invoke unit, and programs
 * that construct dynamic values and read inherited members, which install
 * it at start through dyn.globalConstructInstall). */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

#if defined(__APPLE__)
#define SCR_DYN_COMPAT_STR __attribute__((section("__TEXT,__scr_dyn_compat")))
#elif defined(_WIN32)
#define SCR_DYN_COMPAT_STR
#else
#define SCR_DYN_COMPAT_STR __attribute__((section(".rodata.scr_dyn_compat")))
#endif
static const char dyn_s22[] SCR_DYN_COMPAT_STR = "WeakMap";
static const char dyn_s24[] SCR_DYN_COMPAT_STR = "WeakSet";
static const char dyn_s26[] SCR_DYN_COMPAT_STR = "Object";
static const char dyn_s27[] SCR_DYN_COMPAT_STR = "SC2020";
static const char dyn_s29[] SCR_DYN_COMPAT_STR = "Date";
static const char dyn_s30[] SCR_DYN_COMPAT_STR = "Map";
static const char dyn_s31[] SCR_DYN_COMPAT_STR = "Set";
static const char dyn_s32[] SCR_DYN_COMPAT_STR = "";
static const char dyn_s33[] SCR_DYN_COMPAT_STR = "constructing %s%s through a stored value is not supported yet";
static const char dyn_s34[] SCR_DYN_COMPAT_STR = " from a primitive";

/* `new C(...args)` through a stored Object, Date, Map, Set, WeakMap or
 * WeakSet builds what the `new` expression builds. RegExp, Promise, and
 * Object over a primitive (a wrapper object) are fenced. */
static bool dyn_global_construct(const ScrDyn *callee, const ScrDyn *args, ScrDyn **result) {
  if (callee->kind != SCR_DYN_FUNC || callee->v.fn.thunk != scr_dyn_global_ctor_call) return false;
  const char *name = callee->v.fn.clo->fn;
  ScrDyn *const *items = args->v.arr.items;
  size_t argc = args->v.arr.len;
  const ScrDyn *first = argc ? items[0] : scr_dyn_undefined();
  bool primitive = first->kind == SCR_DYN_NUM || first->kind == SCR_DYN_STR || first->kind == SCR_DYN_BOOL ||
                   first->kind == SCR_DYN_BIGINT || first->kind == SCR_DYN_SYMBOL;
  if (strcmp(name, dyn_s26) == 0 && !primitive) *result = scr_dyn_global_ctor_call(callee->v.fn.clo, items, argc);
  else if (strcmp(name, dyn_s29) == 0)
    *result = argc == 0 ? scr_dyn_native_date_new(args)
            : argc == 1 ? scr_dyn_native_date_new_value(args)
            : scr_dyn_native_date_new_fields(args);
  else if (strcmp(name, dyn_s30) == 0) *result = scr_dyn_native_map_new(first);
  else if (strcmp(name, dyn_s31) == 0) *result = scr_dyn_native_set_new(first);
  else if (strcmp(name, dyn_s22) == 0) *result = scr_weak_map_new((ScrDyn *)first);
  else if (strcmp(name, dyn_s24) == 0) *result = scr_weak_set_new((ScrDyn *)first);
  else {
    char message[128];
    int length = snprintf(message, sizeof message, dyn_s33, name, strcmp(name, dyn_s26) == 0 ? dyn_s34 : dyn_s32);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)length, dyn_s27);
    *result = NULL;
  }
  return true;
}

void scr_dyn_global_construct_install(void) {
  scr_dyn_global_ctor_construct = dyn_global_construct;
  scr_dyn_global_construct_fn = dyn_global_construct;
}
