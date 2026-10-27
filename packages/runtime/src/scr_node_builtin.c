/* Native builtin export objects. The compiler supplies the existing static
 * callable implementations; this unit owns lookup, identity, and mutations. */
#include "scr_runtime.h"
#include "scr_system_errors.h"

#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct { int value; const char *name; const char *message; } ScrSystemError;
#define SCR_SYSTEM_ERROR(name, message) { SCR_NODE_UV__##name, #name, message },
static const ScrSystemError scr_system_errors[] = {
  SCR_NODE_UV_ERRNO_MAP(SCR_SYSTEM_ERROR)
};
#undef SCR_SYSTEM_ERROR

static bool scr_system_error_number(const ScrDyn *error, double *number) {
  if (!error || error->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("err", "of type number", error ? error : scr_dyn_undefined());
    return false;
  }
  double n = error->v.num;
  if (!(isfinite(n) && n < 0 && trunc(n) == n && n >= -9007199254740991.0)) {
    char received[48];
    scr_num_received(n, received);
    if (n == 0 && signbit(n)) strcpy(received, "-0");
    ScrJsonBuf buffer;
    scr_jb_init(&buffer);
    scr_jb_puts(&buffer, "The value of \"err\" is out of range. It must be a negative integer. Received ");
    scr_jb_puts(&buffer, received);
    ScrStr *message = scr_jb_finish(&buffer);
    scr_throw_error_msg_code(SCR_ERR_RANGE, message->data, message->len, "ERR_OUT_OF_RANGE");
    scr_str_release(message);
    return false;
  }
  *number = n;
  return true;
}

static ScrStr *scr_system_error_lookup(double number, bool message) {
  /* Node's name helper looks up the original safe integer. Its message
   * binding uses V8's saturating Int32 extraction instead. */
  double lookup = message && number < -2147483648.0 ? -2147483648.0 : number;
  for (size_t i = 0; i < sizeof scr_system_errors / sizeof scr_system_errors[0]; i++) {
    if (lookup == scr_system_errors[i].value) {
      const char *text = message ? scr_system_errors[i].message : scr_system_errors[i].name;
      return scr_str_new(text, strlen(text));
    }
  }
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  scr_jb_puts(&buffer, "Unknown system error ");
  ScrStr *rendered = scr_f64_to_scrstr(lookup);
  scr_jb_put_str(&buffer, rendered);
  scr_str_release(rendered);
  return scr_jb_finish(&buffer);
}

ScrStr *scr_util_system_error_name(const ScrDyn *error) {
  double number;
  return scr_system_error_number(error, &number) ? scr_system_error_lookup(number, false) : NULL;
}

ScrStr *scr_util_system_error_message(const ScrDyn *error) {
  double number;
  return scr_system_error_number(error, &number) ? scr_system_error_lookup(number, true) : NULL;
}

ScrDyn *scr_util_system_error_entries(void) {
  ScrDyn *entries = scr_dyn_new_arr();
  for (size_t i = 0; i < sizeof scr_system_errors / sizeof scr_system_errors[0]; i++) {
    const ScrSystemError *error = &scr_system_errors[i];
    ScrDyn *entry = scr_dyn_new_arr(), *pair = scr_dyn_new_arr();
    ScrStr *name = scr_str_new(error->name, strlen(error->name));
    ScrStr *message = scr_str_new(error->message, strlen(error->message));
    scr_dyn_arr_push(pair, scr_dyn_new_str(name));
    scr_dyn_arr_push(pair, scr_dyn_new_str(message));
    scr_str_release(name);
    scr_str_release(message);
    scr_dyn_arr_push(entry, scr_dyn_new_num(error->value));
    scr_dyn_arr_push(entry, pair);
    scr_dyn_arr_push(entries, entry);
  }
  return entries;
}

static SCR_TL ScrDyn *scr_global_known;
static SCR_TL ScrDyn *scr_global_own;
/* The one box denoting this thread's global object. Symbol-keyed properties
 * live on the box (string-keyed ones in scr_global_own), so every spelling
 * of the global object answers this box. */
static SCR_TL ScrDyn *scr_global_box;
/* The compiler's immortal name table (one per program) whose names
 * scr_global_known holds; cleared with the tables, so a library re-init
 * registers the names again. */
static SCR_TL const ScrArr *scr_global_registered;
static SCR_TL bool scr_global_cleanup_registered;
static SCR_TL ScrDyn *(*scr_global_console_get)(void);
static SCR_TL ScrDyn *(*scr_global_fetch_get)(void);
/* The program's builtin-global lookup (scr_global_values_install), or
 * NULL: a dyn function from a name to the value its static spelling reads,
 * undefined for the opaque identity token, or null for a name without one. */
static SCR_TL ScrDyn *scr_global_values;

void scr_global_fetch_install(ScrDyn *(*get)(void)) { scr_global_fetch_get = get; }

static SCR_TL ScrDyn *scr_hrtime_value;
static void scr_hrtime_cleanup(void) {
  ScrDyn *value = scr_hrtime_value;
  scr_hrtime_value = NULL;
  scr_dyn_release(value);
}

static ScrDyn *scr_hrtime_bigint_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrBigInt *time = scr_bigint_from_u64(scr_hrtime_ns());
  ScrDyn *value = scr_dyn_new_bigint(time);
  scr_bigint_release(time);
  return value;
}

static ScrDyn *scr_hrtime_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  if (argc && args[0]->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(args[0]);
    ScrDyn *result = view && !scr_exc_pending() ? scr_hrtime_call(closure, &view, 1) : NULL;
    scr_dyn_release(view);
    return result;
  }
  uint64_t time = scr_hrtime_ns();
  double seconds = (double)(time / UINT64_C(1000000000));
  double nanos = (double)(time % UINT64_C(1000000000));
  if (argc && args[0]->kind != SCR_DYN_UNDEF) {
    const ScrDyn *previous = args[0];
    if (previous->kind != SCR_DYN_ARR) {
      scr_dyn_arg_type_fail("time", "an instance of Array", previous);
      return NULL;
    }
    if (previous->v.arr.len != 2) {
      ScrJsonBuf message;
      scr_jb_init(&message);
      scr_jb_puts(&message, "The value of \"time\" is out of range. It must be 2. Received ");
      ScrStr *length = scr_f64_to_scrstr((double)previous->v.arr.len);
      scr_jb_put_str(&message, length);
      scr_str_release(length);
      ScrStr *text = scr_jb_finish(&message);
      scr_throw_error_msg_code(SCR_ERR_RANGE, text->data, text->len, "ERR_OUT_OF_RANGE");
      scr_str_release(text);
      return NULL;
    }
    ScrDyn *prior = scr_dyn_arr_at(previous, 0);
    if (prior->kind == SCR_DYN_BIGINT) {
      scr_dyn_release(prior);
      static const char message[] = "Cannot mix BigInt and other types, use explicit conversions";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    double priorSeconds = scr_dyn_number_coerce(prior);
    scr_dyn_release(prior);
    if (scr_exc_pending()) return NULL;
    prior = scr_dyn_arr_at(previous, 1);
    if (prior->kind == SCR_DYN_BIGINT) {
      scr_dyn_release(prior);
      static const char message[] = "Cannot mix BigInt and other types, use explicit conversions";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    double priorNanos = scr_dyn_number_coerce(prior);
    scr_dyn_release(prior);
    if (scr_exc_pending()) return NULL;
    seconds -= priorSeconds;
    nanos -= priorNanos;
    if (nanos < 0) { seconds--; nanos += 1e9; }
  }
  ScrDyn *result = scr_dyn_new_arr();
  scr_dyn_arr_push(result, scr_dyn_new_num(seconds));
  scr_dyn_arr_push(result, scr_dyn_new_num(nanos));
  return result;
}

ScrDyn *scr_process_hrtime_value(void) {
  if (!scr_hrtime_value) {
    scr_hrtime_value = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_hrtime_call, 1, "native:process.hrtime", "hrtime");
    ScrDyn *bigint = scr_dyn_new_func(scr_closure_new(NULL, 0), scr_hrtime_bigint_call, 0, "native:process.hrtime.bigint", "hrtimeBigInt");
    ScrStr *key = scr_str_new("bigint", 6);
    scr_dyn_key_set(scr_hrtime_value, key, bigint);
    scr_str_release(key);
    scr_dyn_release(bigint);
    scr_atexit(scr_hrtime_cleanup);
  }
  return scr_dyn_retain(scr_hrtime_value);
}

static void scr_global_cleanup(void) {
  scr_dyn_release(scr_global_box);
  scr_global_box = NULL;
  scr_dyn_release(scr_global_known);
  scr_dyn_release(scr_global_own);
  scr_global_known = NULL;
  scr_global_own = NULL;
  scr_global_registered = NULL;
}

static void *scr_global_retain(void *handle) { return handle; }
static void scr_global_release(void *handle) { (void)handle; }

/* A dyn string holding `s` (+1); takes over the caller's reference. */
static ScrDyn *scr_global_take_str(ScrStr *s) {
  ScrDyn *value = scr_dyn_new_str(s);
  scr_str_release(s);
  return value;
}

static ScrDyn *scr_global_get(void *handle, const char *key, size_t length) {
  (void)handle;
  ScrDyn *own = scr_global_own ? scr_dyn_obj_get(scr_global_own, key, length) : NULL;
  if (own) return scr_dyn_retain(own);
  if ((length == 10 && memcmp(key, "globalThis", length) == 0) ||
      (length == 6 && memcmp(key, "global", length) == 0))
    return scr_dyn_retain(scr_global_box);
  if (length == 7 && memcmp(key, "console", length) == 0 && scr_global_console_get)
    return scr_global_console_get();
  if (length == 5 && memcmp(key, "fetch", length) == 0 && scr_global_fetch_get) return scr_global_fetch_get();
  if (length == 9 && memcmp(key, "navigator", length) == 0) return scr_navigator_object();
  if (length == 9 && memcmp(key, "undefined", length) == 0) return scr_dyn_undefined();
  if (length == 3 && memcmp(key, "NaN", length) == 0) return scr_dyn_new_num(NAN);
  if (length == 8 && memcmp(key, "Infinity", length) == 0) return scr_dyn_new_num(INFINITY);
  if (!scr_dyn_obj_get(scr_global_known, key, length)) return scr_dyn_undefined();
  if (scr_global_values) {
    ScrDyn *name = scr_global_take_str(scr_str_new(key, length));
    ScrDyn *value = scr_global_values->v.fn.thunk(scr_global_values->v.fn.clo, &name, 1);
    scr_dyn_release(name);
    if (!value) return NULL;
    if (value->kind == SCR_DYN_UNDEF) {
      /* The opaque identity token a JavaScript source reads for the name. */
      scr_dyn_release(value);
      ScrJsonBuf token;
      scr_jb_init(&token);
      scr_jb_puts(&token, "[builtin ");
      for (size_t i = 0; i < length; i++) scr_jb_putc(&token, key[i]);
      scr_jb_putc(&token, ']');
      return scr_global_take_str(scr_jb_finish(&token));
    }
    if (value->kind != SCR_DYN_NULL) return value;
    scr_dyn_release(value);
  }
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "reading globalThis.");
  for (size_t i = 0; i < length; i++) scr_jb_putc(&text, key[i]);
  scr_jb_puts(&text, " through a stored global object is not supported yet [SC2020]");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
  return NULL;
}

static bool scr_global_set(void *handle, const char *key, size_t length, const ScrDyn *value) {
  (void)handle;
  // Builtin globals have separate native implementations. Preserve their
  // explicit mutation boundary instead of shadowing only one access path.
  if (scr_dyn_obj_get(scr_global_known, key, length)) return false;
  scr_dyn_obj_set(scr_global_own, key, length, scr_dyn_retain((ScrDyn *)value));
  return true;
}

ScrDyn *scr_global_object(void) {
  static const ScrDynHandleOps ops = {
    .cls = "Object", .retain = scr_global_retain, .release = scr_global_release,
    .get = scr_global_get, .set = scr_global_set,
  };
  scr_dyn_handle_install(SCR_DYNH_GLOBAL, &ops);
  if (!scr_global_known) scr_global_known = scr_dyn_new_obj();
  if (!scr_global_own) scr_global_own = scr_dyn_new_obj();
  if (!scr_global_box) scr_global_box = scr_dyn_new_handle(&scr_global_known, SCR_DYNH_GLOBAL);
  if (!scr_global_cleanup_registered) {
    scr_atexit(scr_global_cleanup);
    scr_global_cleanup_registered = true;
  }
  return scr_global_box;
}

/* Installs the program's builtin-global lookup (borrowed): reads of
 * builtin names through the global object answer what their static
 * spellings read. The first installation stands; modules that read the
 * global object by computed names each install the same function. */
static void scr_global_values_cleanup(void) {
  if (scr_global_values) scr_dyn_release(scr_global_values);
  scr_global_values = NULL;
}

void scr_global_values_install(ScrDyn *lookup) {
  if (scr_global_values || lookup->kind != SCR_DYN_FUNC) return;
  scr_global_values = scr_dyn_retain(lookup);
  scr_atexit(scr_global_values_cleanup);
}

/* What `for (key in globalThis)` visits (+1): Node 24's enumerable global
 * properties in its order, then the program's own global properties in
 * creation order, as keys of a fresh object. */
ScrDyn *scr_global_for_in_object(void) {
  static const char *const node_names[] = {
    "global", "clearImmediate", "setImmediate", "clearInterval", "clearTimeout",
    "setInterval", "setTimeout", "queueMicrotask", "structuredClone", "atob",
    "btoa", "performance", "fetch", "crypto", "navigator",
  };
  ScrDyn *object = scr_dyn_new_obj();
  for (size_t i = 0; i < sizeof node_names / sizeof node_names[0]; i++)
    scr_dyn_obj_set(object, node_names[i], strlen(node_names[i]), scr_dyn_undefined());
  if (scr_global_own) {
    ScrDyn *keys = scr_dyn_obj_keys(scr_global_own);
    double count = scr_dyn_arr_len(keys);
    for (double i = 0; i < count; i++) {
      ScrDyn *key = scr_dyn_arr_at(keys, i);
      if (key->kind == SCR_DYN_STR && !scr_dyn_obj_get(object, key->v.str->data, key->v.str->len))
        scr_dyn_obj_set(object, key->v.str->data, key->v.str->len, scr_dyn_undefined());
      scr_dyn_release(key);
    }
    scr_dyn_release(keys);
  }
  return object;
}

ScrDyn *scr_global_native_init(ScrArr *known, ScrDyn *(*console_get)(void)) {
  /* The compiler passes one immortal name table per program: once it is
   * registered, later reads of the global object only take a reference. */
  if (known == scr_global_registered && scr_global_box) return scr_dyn_retain(scr_global_box);
  ScrDyn *global = scr_global_object();
  scr_global_console_get = console_get;
  if (known->rc == SIZE_MAX) scr_global_registered = known;
  for (size_t i = 0; i < known->len; i++) {
    ScrStr *key = (ScrStr *)scr_arr_get_ref(known, (double)i);
    if (!scr_dyn_obj_get(scr_global_known, key->data, key->len))
      scr_dyn_obj_set(scr_global_known, key->data, key->len, scr_dyn_new_bool(true));
    scr_str_release(key);
  }
  return scr_dyn_retain(global);
}

typedef struct ScrBuiltinModule {
  size_t rc;
  ScrStr *id;
  ScrDyn *getter;
  ScrDyn *exports;
  struct ScrBuiltinModule *next;
} ScrBuiltinModule;

static SCR_TL ScrBuiltinModule *scr_builtin_modules;
static SCR_TL bool scr_builtin_cleanup_registered;

static void *scr_builtin_retain(void *handle) {
  ScrBuiltinModule *module = handle;
  module->rc++;
  return module;
}

static void scr_builtin_release(void *handle) {
  ScrBuiltinModule *module = handle;
  if (--module->rc) return;
  scr_str_release(module->id);
  scr_dyn_release(module->getter);
  scr_dyn_release(module->exports);
  free(module);
}

static void scr_builtin_cleanup(void) {
  while (scr_builtin_modules) {
    ScrBuiltinModule *module = scr_builtin_modules;
    scr_builtin_modules = module->next;
    scr_builtin_release(module);
  }
}

static ScrDyn *scr_builtin_get(void *handle, const char *key, size_t length) {
  ScrBuiltinModule *module = handle;
  ScrDyn *cached = scr_dyn_obj_get(module->exports, key, length);
  if (cached) return scr_dyn_retain(cached);
  ScrStr *name = scr_str_new(key, length);
  ScrDyn *arg = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *result = scr_dyn_call(module->getter, &arg, 1, "builtin export");
  scr_dyn_release(arg);
  if (!result) return NULL;
  // Nested path aliases are handles rooted in the registry. Caching them
  // would add path.posix/path.win32 cycles to the reference-counted graph.
  if (!(result->kind == SCR_DYN_HANDLE && result->v.handle.tag == SCR_DYNH_BUILTIN_MODULE))
    scr_dyn_obj_set(module->exports, key, length, scr_dyn_retain(result));
  return result;
}

static bool scr_builtin_set(void *handle, const char *key, size_t length, const ScrDyn *value) {
  ScrBuiltinModule *module = handle;
  scr_dyn_obj_set(module->exports, key, length, scr_dyn_retain((ScrDyn *)value));
  return true;
}

static ScrDyn *scr_builtin_invoke(void *handle, ScrDyn *self, const char *key,
                                ScrDyn *const *args, size_t argc, const char *what) {
  ScrDyn *fn = scr_builtin_get(handle, key, strlen(key));
  if (!fn) return NULL;
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

ScrStr *scr_process_builtin_id(ScrDyn *id, ScrArr *known) {
  if (id->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("id", "of type string", id);
    return NULL;
  }
  ScrStr *value = id->v.str;
  bool prefix = value->len >= 5 && memcmp(value->data, "node:", 5) == 0;
  for (size_t i = 0; i < known->len; i++) {
    ScrStr *entry = (ScrStr *)scr_arr_get_ref(known, (double)i);
    bool exact = entry->len == value->len && memcmp(entry->data, value->data, value->len) == 0;
    bool prefix_only = entry->len >= 5 && memcmp(entry->data, "node:", 5) == 0;
    bool bare = prefix && !prefix_only && entry->len == value->len - 5 && memcmp(entry->data, value->data + 5, entry->len) == 0;
    scr_str_release(entry);
    if (exact || bare) return scr_str_new(value->data + (prefix ? 5 : 0), value->len - (prefix ? 5 : 0));
  }
  return scr_str_new("", 0);
}

ScrDyn *scr_process_builtin_module(ScrStr *id, ScrDyn *getter) {
  static const ScrDynHandleOps ops = {
    .cls = "Object", .retain = scr_builtin_retain, .release = scr_builtin_release,
    .get = scr_builtin_get, .set = scr_builtin_set, .invoke = scr_builtin_invoke,
  };
  scr_dyn_handle_install(SCR_DYNH_BUILTIN_MODULE, &ops);
  for (ScrBuiltinModule *module = scr_builtin_modules; module; module = module->next) {
    if (module->id->len == id->len && memcmp(module->id->data, id->data, id->len) == 0)
      return scr_dyn_new_handle(module, SCR_DYNH_BUILTIN_MODULE);
  }
  if (!scr_builtin_cleanup_registered) {
    scr_atexit(scr_builtin_cleanup);
    scr_builtin_cleanup_registered = true;
  }
  ScrBuiltinModule *module = malloc(sizeof(*module));
  if (!module) scr_trap("scriptc: out of memory\n");
  *module = (ScrBuiltinModule){ 1, scr_str_retain(id), scr_dyn_retain(getter), scr_dyn_new_obj(), scr_builtin_modules };
  scr_builtin_modules = module;
  return scr_dyn_new_handle(module, SCR_DYNH_BUILTIN_MODULE);
}

ScrDyn *scr_process_builtin_unsupported(ScrStr *id, ScrStr *member) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "native builtin '");
  scr_jb_write(&text, id->data, id->len);
  if (member->len) {
    scr_jb_putc(&text, '.');
    scr_jb_write(&text, member->data, member->len);
  }
  scr_jb_puts(&text, "' is not supported through process.getBuiltinModule yet [SC2020]");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
  return NULL;
}

/* ── Node's navigator global (lib/internal/navigator.js) ─────────────────
 * hardwareConcurrency is os.availableParallelism(), language the default
 * locale as Node's ICU answers it from the environment, languages a frozen
 * one-element array of it, platform Node's name for the process platform
 * and architecture, and userAgent `Node.js/<major>`. locks has no lowering.
 * The members are getters on Navigator.prototype, so the object owns no
 * properties: Object.keys answers [] and JSON.stringify `{}`. */

static SCR_TL ScrDyn *scr_navigator_box;
static SCR_TL ScrDyn *scr_navigator_langs;
static SCR_TL ScrStr *scr_navigator_lang;
static SCR_TL bool scr_navigator_cleanup_registered;

static void scr_navigator_cleanup(void);

/* Registers the release of the cached navigator values at exit, once per
 * thread: a program can read navigator.language or navigator.languages
 * without ever taking the navigator object. */
static void scr_navigator_keep(void) {
  if (scr_navigator_cleanup_registered) return;
  scr_navigator_cleanup_registered = true;
  scr_atexit(scr_navigator_cleanup);
}

static void scr_navigator_refuse(const char *what) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "'");
  scr_jb_puts(&text, what);
  scr_jb_puts(&text, "' is part of the standard library types but has no scriptc lowering yet [SC2020]");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
}

static bool scr_navigator_alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
static bool scr_navigator_digit(char c) { return c >= '0' && c <= '9'; }
static char scr_navigator_lower(char c) { return c >= 'A' && c <= 'Z' ? (char)(c + 32) : c; }
static char scr_navigator_upper(char c) { return c >= 'a' && c <= 'z' ? (char)(c - 32) : c; }

/* The BCP 47 tag of the POSIX locale ID `id`, as ICU derives the default
 * locale: `language[_TERRITORY][.codeset][@modifier]`, the codeset
 * dropped, the C and POSIX locales and en_US_POSIX as en-US, the ISO 639
 * codes ICU replaces, and the modifier as a variant (5 to 8 characters) or
 * an lvariant private-use subtag (1 to 4). NULL for an ID outside that
 * grammar, whose tag needs ICU's tables. */
static ScrStr *scr_navigator_tag(const char *id) {
  if (!id) return scr_str_new("en-US", 5);
  const char *end = id + strlen(id);
  const char *at = strchr(id, '@');
  const char *dot = strchr(id, '.');
  const char *base_end = dot && (!at || dot < at) ? dot : at ? at : end;
  const char *modifier = at ? at + 1 : NULL;
  size_t base_len = (size_t)(base_end - id);
  if (base_len == 0 && !modifier) return scr_str_new("und", 3);
  if ((base_len == 1 && id[0] == 'C') || (base_len == 5 && memcmp(id, "POSIX", 5) == 0)) {
    if (modifier) return NULL;
    return scr_str_new("en-US", 5);
  }
  const char *underscore = memchr(id, '_', base_len);
  size_t lang_len = underscore ? (size_t)(underscore - id) : base_len;
  const char *region = underscore ? underscore + 1 : NULL;
  size_t region_len = region ? (size_t)(base_end - region) : 0;
  if (region && memchr(region, '_', region_len)) {
    /* en_US_POSIX is ICU's name for the C locale. */
    if (lang_len == 2 && scr_navigator_lower(id[0]) == 'e' && scr_navigator_lower(id[1]) == 'n' &&
        region_len == 8 && scr_navigator_upper(region[0]) == 'U' && scr_navigator_upper(region[1]) == 'S' &&
        region[2] == '_') {
      bool posix = true;
      for (size_t i = 0; i < 5; i++) posix = posix && scr_navigator_upper(region[3 + i]) == "POSIX"[i];
      if (posix && !modifier) return scr_str_new("en-US", 5);
    }
    return NULL;
  }
  for (size_t i = 0; i < lang_len; i++)
    if (!scr_navigator_alpha(id[i])) return NULL;
  if (lang_len == 1 || lang_len == 4 || lang_len > 8) return NULL;
  ScrJsonBuf tag;
  scr_jb_init(&tag);
  char lang[9] = {0};
  for (size_t i = 0; i < lang_len; i++) lang[i] = scr_navigator_lower(id[i]);
  static const char *const replaced[][2] = {
    {"in", "id"}, {"iw", "he"}, {"ji", "yi"}, {"jw", "jv"}, {"mo", "ro"},
  };
  const char *language = lang_len == 0 ? "und" : lang;
  for (size_t i = 0; i < sizeof replaced / sizeof replaced[0]; i++)
    if (!strcmp(lang, replaced[i][0])) language = replaced[i][1];
  scr_jb_puts(&tag, language);
  if (region_len > 0) {
    bool alpha2 = region_len == 2 && scr_navigator_alpha(region[0]) && scr_navigator_alpha(region[1]);
    bool digits3 = region_len == 3 && scr_navigator_digit(region[0]) && scr_navigator_digit(region[1]) &&
                   scr_navigator_digit(region[2]);
    if (!alpha2 && !digits3) {
      scr_str_release(scr_jb_finish(&tag));
      return NULL;
    }
    scr_jb_putc(&tag, '-');
    for (size_t i = 0; i < region_len; i++) scr_jb_putc(&tag, scr_navigator_upper(region[i]));
  }
  if (modifier && *modifier) {
    size_t length = (size_t)(end - modifier);
    bool alnum = length <= 8;
    for (size_t i = 0; i < length && alnum; i++)
      alnum = scr_navigator_alpha(modifier[i]) || scr_navigator_digit(modifier[i]);
    if (!alnum || (length == 7 && !memcmp(modifier, "nynorsk", 7))) {
      scr_str_release(scr_jb_finish(&tag));
      return NULL;
    }
    scr_jb_puts(&tag, length >= 5 ? "-" : "-x-lvariant-");
    for (size_t i = 0; i < length; i++) scr_jb_putc(&tag, scr_navigator_lower(modifier[i]));
  }
  return scr_jb_finish(&tag);
}

ScrStr *scr_navigator_language(void) {
  if (!scr_navigator_lang) {
    /* ICU reads LC_ALL, then LC_MESSAGES, then LANG; a variable that is
     * set, even to the empty string, decides. */
    const char *id = getenv("LC_ALL");
    if (!id) id = getenv("LC_MESSAGES");
    if (!id) id = getenv("LANG");
    ScrStr *tag = scr_navigator_tag(id);
    if (!tag) {
      scr_navigator_refuse("navigator.language for this locale");
      return NULL;
    }
    scr_navigator_lang = tag;
    scr_navigator_keep();
  }
  return scr_str_retain(scr_navigator_lang);
}

ScrDyn *scr_navigator_languages(void) {
  if (!scr_navigator_langs) {
    ScrStr *language = scr_navigator_language();
    if (!language) return NULL;
    ScrDyn *languages = scr_dyn_new_arr();
    scr_dyn_arr_push(languages, scr_global_take_str(language));
    scr_dyn_release(scr_dyn_freeze_data(languages));
    scr_navigator_langs = languages;
    scr_navigator_keep();
  }
  return scr_dyn_retain(scr_navigator_langs);
}

ScrStr *scr_navigator_platform(void) {
  ScrStr *platform = scr_process_platform();
  ScrStr *arch = scr_process_arch();
  const char *p = platform->data, *a = arch->data;
  ScrJsonBuf text;
  scr_jb_init(&text);
  bool ia32 = !strcmp(a, "ia32"), x64 = !strcmp(a, "x64");
  if (!strcmp(p, "darwin")) scr_jb_puts(&text, "MacIntel");
  else if (!strcmp(p, "win32")) scr_jb_puts(&text, "Win32");
  else if (!strcmp(p, "linux")) {
    scr_jb_puts(&text, ia32 ? "Linux i686" : x64 ? "Linux x86_64" : "Linux ");
    if (!ia32 && !x64) scr_jb_puts(&text, a);
  } else if (!strcmp(p, "freebsd") || !strcmp(p, "openbsd")) {
    scr_jb_puts(&text, p[0] == 'f' ? "FreeBSD " : "OpenBSD ");
    scr_jb_puts(&text, ia32 ? "i386" : x64 ? "amd64" : a);
  } else if (!strcmp(p, "sunos")) {
    scr_jb_puts(&text, "SunOS ");
    scr_jb_puts(&text, ia32 ? "i86pc" : a);
  } else if (!strcmp(p, "aix")) scr_jb_puts(&text, "AIX");
  else {
    scr_jb_putc(&text, scr_navigator_upper(p[0]));
    if (p[0]) scr_jb_puts(&text, p + 1);
    scr_jb_putc(&text, ' ');
    scr_jb_puts(&text, a);
  }
  scr_str_release(platform);
  scr_str_release(arch);
  return scr_jb_finish(&text);
}

static ScrDyn *scr_navigator_get(void *handle, const char *key, size_t length) {
  (void)handle;
  if (length == 19 && !memcmp(key, "hardwareConcurrency", length))
    return scr_dyn_new_num(scr_os_available_parallelism());
  if (length == 8 && !memcmp(key, "language", length)) {
    ScrStr *language = scr_navigator_language();
    return language ? scr_global_take_str(language) : NULL;
  }
  if (length == 9 && !memcmp(key, "languages", length)) return scr_navigator_languages();
  if (length == 8 && !memcmp(key, "platform", length)) return scr_global_take_str(scr_navigator_platform());
  if (length == 9 && !memcmp(key, "userAgent", length)) {
    ScrStr *version = scr_process_versions_node();
    const char *dot = memchr(version->data, '.', version->len);
    size_t major = dot ? (size_t)(dot - version->data) : version->len;
    ScrJsonBuf text;
    scr_jb_init(&text);
    scr_jb_puts(&text, "Node.js/");
    for (size_t i = 0; i < major; i++) scr_jb_putc(&text, version->data[i]);
    scr_str_release(version);
    return scr_global_take_str(scr_jb_finish(&text));
  }
  if (length == 5 && !memcmp(key, "locks", length)) {
    scr_navigator_refuse("navigator.locks");
    return NULL;
  }
  return NULL;
}

static ScrDyn *scr_navigator_inspect_view(void *handle) {
  (void)handle;
  return scr_dyn_new_obj();
}

static void scr_navigator_cleanup(void) {
  if (scr_navigator_box) scr_dyn_release(scr_navigator_box);
  if (scr_navigator_langs) scr_dyn_release(scr_navigator_langs);
  if (scr_navigator_lang) scr_str_release(scr_navigator_lang);
  scr_navigator_box = NULL;
  scr_navigator_langs = NULL;
  scr_navigator_lang = NULL;
  scr_navigator_cleanup_registered = false;
}

ScrDyn *scr_navigator_object(void) {
  static const ScrDynHandleOps ops = {
    .cls = "Navigator", .retain = scr_global_retain, .release = scr_global_release,
    .get = scr_navigator_get, .inspect_view = scr_navigator_inspect_view,
    .json_empty_object = true, .inspect_view_empty = true,
  };
  if (!scr_navigator_box) {
    scr_dyn_handle_install(SCR_DYNH_NAVIGATOR, &ops);
    static SCR_TL char token;
    scr_navigator_box = scr_dyn_new_handle(&token, SCR_DYNH_NAVIGATOR);
    scr_navigator_keep();
  }
  return scr_dyn_retain(scr_navigator_box);
}
