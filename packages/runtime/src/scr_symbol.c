/* ES Symbol values (scr_runtime.h has the API contract): a runtime-unique
 * identity value — the POINTER is the identity, so `Symbol('a') ===
 * Symbol('a')` is false and a symbol equals exactly itself, JS's spec
 * without approximation. A symbol owns at most a description string and
 * (for Symbol.for symbols) its registry key: pure immutable data, never
 * part of a cycle, no trace header.
 *
 * The Symbol.for registry is the spec's GlobalSymbolRegistry: one symbol
 * per key (byte equality), never evicted for the program's lifetime. The
 * chain is intrusive (reg_next) and holds one reference per entry; the
 * atexit cleanup releases the chain — registered at FIRST use, which is
 * always after scr_init registered the RC audit, so atexit's LIFO order
 * runs it before the audit and the audited string counts stay exact. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct ScrSym {
  size_t rc;
  ScrStr *desc;    /* owned; NULL = no description (Symbol()) */
  ScrStr *reg_key; /* owned; non-NULL exactly for Symbol.for symbols */
  struct ScrSym *reg_next; /* the registry's intrusive chain */
};

ScrSym *scr_sym_retain(ScrSym *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_sym_release(ScrSym *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    scr_str_release(s->desc);
    scr_str_release(s->reg_key);
    free(s);
  }
}

void *scr_sym_retain_v(void *p) { return scr_sym_retain(p); }
void scr_sym_release_v(void *p) { scr_sym_release(p); }

ScrSym *scr_sym_new(ScrStr *desc) {
  ScrSym *s = malloc(sizeof(ScrSym));
  if (!s) {
    scr_trap("scriptc: out of memory\n");
  }
  s->rc = 1;
  s->desc = desc ? scr_str_retain(desc) : NULL;
  s->reg_key = NULL;
  s->reg_next = NULL;
  return s;
}

/* ── the Symbol.for global registry ──────────────────────────────────── */

static SCR_TL ScrSym *g_sym_registry = NULL;
static SCR_TL ScrSym *g_sym_well_known = NULL;

static void scr_sym_well_known_cleanup(void) {
  while (g_sym_well_known) {
    ScrSym *symbol = g_sym_well_known;
    g_sym_well_known = symbol->reg_next;
    scr_sym_release(symbol);
  }
}

ScrSym *scr_sym_well_known(ScrStr *name) {
  ScrStr *prefix = scr_str_new("Symbol.", 7);
  ScrStr *description = scr_str_concat(prefix, name);
  scr_str_release(prefix);
  for (ScrSym *symbol = g_sym_well_known; symbol; symbol = symbol->reg_next) {
    if (!scr_str_eq(description, symbol->desc)) continue;
    scr_str_release(description);
    return scr_sym_retain(symbol);
  }
  if (!g_sym_well_known) scr_atexit(scr_sym_well_known_cleanup);
  ScrSym *symbol = scr_sym_new(description);
  scr_str_release(description);
  symbol->reg_next = g_sym_well_known;
  g_sym_well_known = scr_sym_retain(symbol);
  if (name->len == 8 && !memcmp(name->data, "iterator", 8)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_iterator_symbol(key);
    scr_dyn_release(key);
  }
  if (name->len == 11 && !memcmp(name->data, "hasInstance", 11)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_has_instance_symbol(key);
    scr_dyn_release(key);
  }
  if (name->len == 11 && !memcmp(name->data, "toStringTag", 11)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_to_string_tag_symbol(key);
    scr_dyn_release(key);
  }
  if (name->len == 13 && !memcmp(name->data, "asyncIterator", 13)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_async_iterator_symbol(key);
    scr_dyn_release(key);
  }
  if (name->len == 12 && !memcmp(name->data, "asyncDispose", 12)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_async_dispose_symbol(key);
    scr_dyn_release(key);
  }
  if (name->len == 11 && !memcmp(name->data, "toPrimitive", 11)) {
    ScrDyn *key = scr_dyn_new_symbol(symbol);
    scr_dyn_install_to_primitive_symbol(key);
    scr_dyn_release(key);
  }
  return symbol;
}

static void scr_sym_registry_cleanup(void) {
  ScrSym *s = g_sym_registry;
  g_sym_registry = NULL;
  while (s) {
    ScrSym *next = s->reg_next;
    scr_sym_release(s);
    s = next;
  }
}

ScrSym *scr_sym_for(ScrStr *key) {
  for (ScrSym *s = g_sym_registry; s; s = s->reg_next) {
    if (scr_str_eq(s->reg_key, key)) return scr_sym_retain(s);
  }
  /* First request for this key: a fresh symbol whose description IS the
   * key (the spec's Symbol.for behavior), chained into the registry with
   * the registry's own reference. */
  if (!g_sym_registry) scr_atexit(scr_sym_registry_cleanup);
  ScrSym *s = scr_sym_new(key);
  s->reg_key = scr_str_retain(key);
  s->reg_next = g_sym_registry;
  g_sym_registry = scr_sym_retain(s);
  if (key->len == 26 && !memcmp(key->data, "nodejs.util.inspect.custom", 26)) {
    ScrDyn *custom = scr_dyn_new_symbol(s);
    scr_dyn_install_inspect_custom_symbol(custom);
    scr_dyn_release(custom);
  }
  return s;
}

ScrStr *scr_sym_desc(ScrSym *s) { return s->desc ? scr_str_retain(s->desc) : NULL; }

ScrStr *scr_sym_key_for(ScrSym *s) { return s->reg_key ? scr_str_retain(s->reg_key) : NULL; }

ScrDyn *scr_dyn_new_symbol(ScrSym *value) {
  return scr_dyn_symbol_ref(scr_sym_retain(value), scr_sym_release, scr_sym_to_string, scr_sym_desc);
}

ScrStr *scr_sym_to_string(ScrSym *s) {
  /* "Symbol(desc)" — Symbol.prototype.toString: an absent description
   * prints as the empty parenthesis pair ("Symbol()"), exactly Node
   * (Symbol() and Symbol(undefined) alike). */
  size_t dlen = s->desc ? s->desc->len : 0;
  size_t len = 7 + dlen + 1; /* "Symbol(" + desc + ")" */
  ScrStr *out = scr_str_alloc_raw(len, len);
  memcpy(out->data, "Symbol(", 7);
  if (dlen > 0) memcpy(out->data + 7, s->desc->data, dlen);
  out->data[7 + dlen] = ')';
  out->data[len] = '\0';
  out->len = len;
  return out;
}

/* ── assert strict equality over symbols (lives here for the same reason
 * assert.match lives in scr_regex.c: it needs the symbol rendering, and
 * every call site carries symbol values, so the symbol link switch is
 * already on; the assert switch pulls scr_assert.c alongside) ─────────
 * strictEqual IS deepStrictEqual for symbols (a primitive under
 * SameValue): pointer identity — every scr_sym_new is a distinct
 * identity, Symbol.for interns per key. Failing messages are v24's
 * string-style forms over the "Symbol(desc)" rendering: symbols take the
 * stacked diff with the first-difference `^` indicator (the shared
 * "Symbol(" prefix keeps the indicator past the i >= 3 skip; equal
 * renderings of distinct symbols print the +/- pair with no indicator),
 * and never the 12-char short form ("Symbol()" twice is already 16). */
void scr_assert_eq_sym(ScrSym *a, ScrSym *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg) {
  bool same = a == b;
  if ((negated && !same) || (!negated && same)) return;
  scr_assert_record(scr_dyn_new_symbol(a), scr_dyn_new_symbol(b), scr_assert_eq_operator(negated, deep));
  ScrStr *ia = scr_sym_to_string(a);
  if (negated) {
    scr_assert_neq_fail(ia->data, ia->len, deep, msg, has_msg);
    scr_str_release(ia);
    return;
  }
  ScrStr *ib = scr_sym_to_string(b);
  scr_assert_eq_fail(ia->data, ia->len, ib->data, ib->len, 0, false, true, deep,
                     msg, has_msg);
  scr_str_release(ia);
  scr_str_release(ib);
}

/* Direct `globalThis[symbol]` accesses use the symbol-keyed properties of
 * the global object's box (scr_global_object), the storage every other
 * spelling of the global object reaches, so all of them see one property. */
ScrDyn *scr_dyn_global_symbol_get(ScrSym *key) {
  ScrDyn *k = scr_dyn_new_symbol(key);
  ScrDyn *value = scr_dyn_symbol_key_get(scr_global_object(), k, false);
  scr_dyn_release(k);
  return value;
}

void scr_dyn_global_symbol_set(ScrSym *key, ScrDyn *value) {
  ScrDyn *k = scr_dyn_new_symbol(key);
  scr_dyn_symbol_key_set(scr_global_object(), k, value);
  scr_dyn_release(k);
}

bool scr_dyn_global_symbol_has(ScrSym *key) {
  ScrDyn *k = scr_dyn_new_symbol(key);
  bool present = scr_dyn_has_own_computed(scr_global_object(), k);
  scr_dyn_release(k);
  return present;
}

void scr_dyn_global_symbol_delete(ScrSym *key) {
  ScrDyn *k = scr_dyn_new_symbol(key);
  scr_dyn_key_delete_computed(scr_global_object(), k, false);
  scr_dyn_release(k);
}

/* ── fs.Dirent as a dynamic value ────────────────────────────────────
 * A Dirent row converted to dyn (untyped JavaScript, `unknown` slots)
 * takes Node's shape: own enumerable name and parentPath, the entry kind
 * under an own enumerable Symbol(type) key, and the type probes on a
 * shared Dirent prototype as non-enumerable methods. The %dtype field
 * stays an own, non-enumerable property so a dyn Dirent converts back to
 * the typed row. It lives in this unit because the Symbol(type) key needs
 * it; the compiler links the unit whenever the program has the Dirent
 * record shape. */
static SCR_TL ScrDyn *scr_dirent_prototype;
static SCR_TL ScrDyn *scr_dirent_type_key;
static SCR_TL ScrStr *scr_dirent_type_storage;

static ScrDyn *scr_dirent_probe(double code) {
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *view = self->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(self) : scr_dyn_retain(self);
  scr_dyn_release(self);
  if (scr_exc_pending()) {
    scr_dyn_release(view);
    return NULL;
  }
  if (view->kind == SCR_DYN_UNDEF || view->kind == SCR_DYN_NULL) {
    char message[64];
    int n = snprintf(message, sizeof message, "Cannot read properties of %s (reading 'Symbol(type)')",
                     view->kind == SCR_DYN_UNDEF ? "undefined" : "null");
    scr_dyn_release(view);
    scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)n);
    return NULL;
  }
  const ScrDyn *kind = view->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(view, "%dtype", 6) : NULL;
  bool match = kind && kind->kind == SCR_DYN_NUM && kind->v.num == code;
  scr_dyn_release(view);
  return scr_dyn_new_bool(match);
}

#define SCR_DIRENT_PROBE(name, code)                                                  \
  static ScrDyn *scr_dirent_##name(ScrClosure *closure, ScrDyn *const *args, size_t argc) { \
    (void)closure;                                                                    \
    (void)args;                                                                       \
    (void)argc;                                                                       \
    return scr_dirent_probe(code);                                                    \
  }
SCR_DIRENT_PROBE(isDirectory, 2)
SCR_DIRENT_PROBE(isFile, 1)
SCR_DIRENT_PROBE(isBlockDevice, 7)
SCR_DIRENT_PROBE(isCharacterDevice, 6)
SCR_DIRENT_PROBE(isSymbolicLink, 3)
SCR_DIRENT_PROBE(isFIFO, 4)
SCR_DIRENT_PROBE(isSocket, 5)
#undef SCR_DIRENT_PROBE

static void scr_dirent_teardown(void) {
  if (scr_dirent_prototype) {
    scr_dirent_prototype->v.obj.class_name = NULL;
    scr_dyn_release(scr_dirent_prototype);
    scr_dirent_prototype = NULL;
  }
  scr_dyn_release(scr_dirent_type_key);
  scr_dirent_type_key = NULL;
  scr_str_release(scr_dirent_type_storage);
  scr_dirent_type_storage = NULL;
}

static void scr_dirent_init(void) {
  if (scr_dirent_prototype) return;
  /* Node's class body order. */
  static const struct {
    const char *name;
    ScrDynThunk thunk;
  } methods[] = {
      {"isDirectory", scr_dirent_isDirectory},
      {"isFile", scr_dirent_isFile},
      {"isBlockDevice", scr_dirent_isBlockDevice},
      {"isCharacterDevice", scr_dirent_isCharacterDevice},
      {"isSymbolicLink", scr_dirent_isSymbolicLink},
      {"isFIFO", scr_dirent_isFIFO},
      {"isSocket", scr_dirent_isSocket},
  };
  ScrDyn *proto = scr_dyn_new_obj();
  proto->v.obj.class_name = "Dirent";
  for (size_t i = 0; i < sizeof methods / sizeof methods[0]; i++) {
    scr_dyn_obj_set(proto, methods[i].name, strlen(methods[i].name),
                    scr_dyn_new_func(scr_closure_new(NULL, 0), methods[i].thunk, 0, "native:fs.Dirent",
                                     methods[i].name));
    proto->v.obj.entries[proto->v.obj.len - 1].enumerable = false;
  }
  ScrStr *desc = scr_str_new("type", 4);
  ScrSym *sym = scr_sym_new(desc);
  scr_str_release(desc);
  scr_dirent_type_key = scr_dyn_new_symbol(sym);
  scr_sym_release(sym);
  scr_dirent_type_storage = scr_dyn_symbol_storage_name(scr_dirent_type_key);
  scr_dirent_prototype = proto;
  scr_atexit(scr_dirent_teardown);
}

void scr_dyn_dirent_finish(ScrDyn *obj) {
  scr_dirent_init();
  scr_dyn_region_store(obj, NULL); /* a prototype store (ScrDynRegion) */
  scr_dyn_release(obj->prototype);
  obj->prototype = scr_dyn_retain(scr_dirent_prototype);
  for (size_t i = 0; i < obj->v.obj.len; i++) {
    ScrDynEntry *ent = &obj->v.obj.entries[i];
    if (ent->key_len != 6 || memcmp(ent->key, "%dtype", 6) != 0) continue;
    ent->enumerable = false;
    if (!obj->symbol_properties && !obj->symbol_keys)
      scr_dyn_symbol_init_own(obj, scr_dirent_type_key, scr_dirent_type_storage, ent->value);
    else
      scr_dyn_symbol_key_set(obj, scr_dirent_type_key, ent->value);
    break;
  }
}

/* The well-known symbol `Symbol.<name>` as a dyn key (+1). */
static ScrDyn *scr_using_key(const char *name, size_t len) {
  ScrStr *text = scr_str_new(name, len);
  ScrSym *symbol = scr_sym_well_known(text);
  scr_str_release(text);
  ScrDyn *key = scr_dyn_new_symbol(symbol);
  scr_sym_release(symbol);
  return key;
}

static bool scr_using_typeof_is(const ScrDyn *value, const char *name, size_t len) {
  ScrStr *type = scr_dyn_typeof(value);
  bool match = type->len == len && !memcmp(type->data, name, len);
  scr_str_release(type);
  return match;
}

/* The [Symbol.<name>] method of a `using` value: NULL for an absent member
 * (undefined or null), the callable member (+1), or NULL with a pending
 * TypeError when the member is not callable. */
static ScrDyn *scr_using_get_method(const ScrDyn *value, const char *name, size_t len, bool *absent) {
  ScrDyn *key = scr_using_key(name, len);
  ScrDyn *method = scr_dyn_symbol_key_get(value, key, false);
  scr_dyn_release(key);
  *absent = false;
  if (!method) return NULL;
  if (method->kind == SCR_DYN_UNDEF || method->kind == SCR_DYN_NULL) {
    scr_dyn_release(method);
    *absent = true;
    return NULL;
  }
  if (!scr_using_typeof_is(method, "function", 8)) {
    scr_dyn_release(method);
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "Symbol(Symbol.");
    scr_jb_write(&message, name, len);
    scr_jb_puts(&message, ") is not a function");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return NULL;
  }
  return method;
}

ScrDyn *scr_dyn_using_method(const ScrDyn *value, bool async) {
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) return scr_dyn_retain(scr_dyn_undefined());
  if (!scr_using_typeof_is(value, "object", 6) && !scr_using_typeof_is(value, "function", 8)) {
    static const char message[] = "An object is expected with `using` declarations";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  bool absent = false;
  if (async) {
    ScrDyn *method = scr_using_get_method(value, "asyncDispose", 12, &absent);
    if (!method && !absent) return NULL;
    if (method) {
      ScrDyn *record = scr_dyn_new_arr();
      scr_dyn_arr_push(record, method);
      scr_dyn_arr_push(record, scr_dyn_new_bool(false));
      return record;
    }
  }
  ScrDyn *method = scr_using_get_method(value, "dispose", 7, &absent);
  if (!method) {
    if (absent && value->kind == SCR_DYN_TYPED_REF && value->v.typed_ref.type_key_len > 7 &&
        !memcmp(value->v.typed_ref.type_key, "object:", 7)) {
      /* A class instance seen through an `unknown` or Disposable-typed
       * value: its dyn view carries no methods. */
      static const char message[] =
          "disposing a class instance through a Disposable- or unknown-typed value has no lowering "
          "yet (declare the variable with the class type)";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    } else if (absent) {
      static const char message[] = "Symbol(Symbol.dispose) is not a function";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    }
    return NULL;
  }
  if (!async) return method;
  ScrDyn *record = scr_dyn_new_arr();
  scr_dyn_arr_push(record, method);
  scr_dyn_arr_push(record, scr_dyn_new_bool(true));
  return record;
}

ScrDyn *scr_dyn_using_dispose(const ScrDyn *method, const ScrDyn *value) {
  if (method->kind == SCR_DYN_UNDEF) return scr_dyn_retain(scr_dyn_undefined());
  bool sync_fallback = false;
  const ScrDyn *callee = method;
  if (method->kind == SCR_DYN_ARR) {
    callee = method->v.arr.items[0];
    sync_fallback = method->v.arr.items[1]->v.b;
  }
  scr_dyn_this_push_dyn(value);
  ScrDyn *result = scr_dyn_call(callee, NULL, 0, "[Symbol.dispose]");
  scr_dyn_this_pop();
  if (!result || !sync_fallback) return result;
  scr_dyn_release(result);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* ── DisposableStack ───────────────────────────────────────────────────
 * The stack is a collector-headered object behind a traced dyn handle: its
 * resources hold callbacks that can capture the stack itself. Each entry
 * records how disposal calls it: `use` calls the value's dispose method
 * with the value as `this`, `adopt` calls the callback with the value, and
 * `defer` calls the callback with no arguments. Disposal runs the entries
 * in reverse order; each later failure becomes a SuppressedError over the
 * error so far, and a single failure is rethrown as it was thrown. */
enum { SCR_DS_USE, SCR_DS_ADOPT, SCR_DS_DEFER };

typedef struct {
  ScrDyn *value; /* the resource (use, adopt); NULL for defer */
  ScrDyn *method;
  unsigned kind;
  /* Which members the last trace visited: the collector frees those
   * itself, and gcfree must not read them afterwards. */
  bool value_traced, method_traced;
} ScrDisposableResource;

typedef struct {
  size_t rc;
  bool disposed;
  ScrDisposableResource *items;
  size_t len, cap;
} ScrDisposableStack;

static bool scr_ds_traced(const ScrDyn *value) {
  return value && value->kind > SCR_DYN_STR && value->kind != SCR_DYN_UNDEF;
}

static void scr_ds_trace(void *ptr, ScrTraceVisit visit, void *ctx) {
  ScrDisposableStack *s = ptr;
  for (size_t i = 0; i < s->len; i++) {
    ScrDisposableResource *r = &s->items[i];
    r->value_traced = scr_ds_traced(r->value);
    r->method_traced = scr_ds_traced(r->method);
    if (r->value_traced) visit(r->value, ctx);
    if (r->method_traced) visit(r->method, ctx);
  }
}

/* The collector frees traced members itself; the rest are released here. */
static void scr_ds_gcfree(void *ptr) {
  ScrDisposableStack *s = ptr;
  for (size_t i = 0; i < s->len; i++) {
    if (!s->items[i].value_traced) scr_dyn_release(s->items[i].value);
    if (!s->items[i].method_traced) scr_dyn_release(s->items[i].method);
  }
  free(s->items);
  scr_obj_free_note();
  scr_cyc_free(ptr);
}

static void scr_ds_destroy(void *ptr) {
  ScrDisposableStack *s = ptr;
  for (size_t i = 0; i < s->len; i++) {
    scr_dyn_release(s->items[i].value);
    scr_dyn_release(s->items[i].method);
  }
  s->len = 0;
  scr_ds_gcfree(ptr);
}

static void *scr_ds_retain(void *ptr) {
  ((ScrDisposableStack *)ptr)->rc++;
  return ptr;
}

static void scr_ds_release(void *ptr) {
  ScrDisposableStack *s = ptr;
  if (!s) return;
  if (--s->rc == 0) {
    scr_cyc_dead(s);
    scr_rc_destroy(s, scr_ds_destroy);
  } else scr_cyc_released(s);
}

static void scr_ds_push(ScrDisposableStack *s, ScrDyn *value, ScrDyn *method, unsigned kind) {
  if (s->len == s->cap) {
    size_t cap = s->cap ? s->cap * 2 : 4;
    ScrDisposableResource *items = realloc(s->items, cap * sizeof *items);
    if (!items) scr_trap("scriptc: out of memory\n");
    s->items = items;
    s->cap = cap;
  }
  s->items[s->len++] = (ScrDisposableResource){value, method, kind, false, false};
}

/* V8's rendering of a value in a TypeError: primitives by ToString,
 * arrays as [object Array], other objects as #<Constructor>. */
static void scr_ds_put_value(ScrJsonBuf *b, const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_UNDEF: scr_jb_puts(b, "undefined"); return;
  case SCR_DYN_NULL: scr_jb_puts(b, "null"); return;
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_BIGINT: {
    ScrStr *text = scr_dyn_to_string(value, NULL);
    if (text) scr_jb_write(b, text->data, text->len);
    scr_str_release(text);
    return;
  }
  case SCR_DYN_SYMBOL: {
    ScrStr *text = value->v.symbol.render(value->v.symbol.value);
    scr_jb_write(b, text->data, text->len);
    scr_str_release(text);
    return;
  }
  case SCR_DYN_ARR: scr_jb_puts(b, "[object Array]"); return;
  case SCR_DYN_HANDLE:
    scr_jb_puts(b, "#<");
    scr_jb_puts(b, scr_dyn_handle_cls(value));
    scr_jb_putc(b, '>');
    return;
  default: scr_jb_puts(b, "#<Object>"); return;
  }
}

static ScrDisposableStack *scr_ds_of(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_DISPOSABLE_STACK
    ? value->v.handle.ptr : NULL;
}

bool scr_disposable_stack_is(const ScrDyn *value) { return scr_ds_of(value) != NULL; }

/* The receiver of DisposableStack.prototype.<name>, or NULL with Node's
 * TypeError (an incompatible receiver) or ReferenceError (a disposed
 * stack, when `live` is required) pending. */
static ScrDisposableStack *scr_ds_receiver(const ScrDyn *self, const char *name, bool getter, bool live) {
  ScrDisposableStack *s = scr_ds_of(self);
  ScrJsonBuf message;
  if (!s) {
    scr_jb_init(&message);
    scr_jb_puts(&message, getter ? "Method get DisposableStack.prototype." : "Method DisposableStack.prototype.");
    scr_jb_puts(&message, name);
    scr_jb_puts(&message, " called on incompatible receiver ");
    scr_ds_put_value(&message, self);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return NULL;
  }
  if (live && s->disposed) {
    scr_jb_init(&message);
    scr_jb_puts(&message, "Cannot call DisposableStack.prototype.");
    scr_jb_puts(&message, name);
    scr_jb_puts(&message, " on an already-disposed DisposableStack");
    scr_throw_error(SCR_ERR_REFERENCE, scr_jb_finish(&message));
    return NULL;
  }
  return s;
}

static bool scr_ds_callable(const ScrDyn *value) {
  if (scr_using_typeof_is(value, "function", 8)) return true;
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_ds_put_value(&message, value);
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return false;
}

bool scr_disposable_stack_use(const ScrDyn *stack, const ScrDyn *value) {
  ScrDisposableStack *s = scr_ds_receiver(stack, "use", false, true);
  if (!s) return false;
  if (value->kind == SCR_DYN_NULL || value->kind == SCR_DYN_UNDEF) return true;
  ScrDyn *method = scr_dyn_using_method(value, false);
  if (!method) return false;
  scr_ds_push(s, scr_dyn_retain((ScrDyn *)value), method, SCR_DS_USE);
  return true;
}

bool scr_disposable_stack_use_callback(const ScrDyn *stack, const ScrDyn *value, const ScrDyn *dispose) {
  ScrDisposableStack *s = scr_ds_receiver(stack, "use", false, true);
  if (!s) return false;
  scr_ds_push(s, scr_dyn_retain((ScrDyn *)value), scr_dyn_retain((ScrDyn *)dispose), SCR_DS_ADOPT);
  return true;
}

bool scr_disposable_stack_adopt(const ScrDyn *stack, const ScrDyn *value, const ScrDyn *on_dispose) {
  ScrDisposableStack *s = scr_ds_receiver(stack, "adopt", false, true);
  if (!s || !scr_ds_callable(on_dispose)) return false;
  scr_ds_push(s, scr_dyn_retain((ScrDyn *)value), scr_dyn_retain((ScrDyn *)on_dispose), SCR_DS_ADOPT);
  return true;
}

static bool scr_disposable_stack_defer(const ScrDyn *stack, const ScrDyn *on_dispose) {
  ScrDisposableStack *s = scr_ds_receiver(stack, "defer", false, true);
  if (!s || !scr_ds_callable(on_dispose)) return false;
  scr_ds_push(s, NULL, scr_dyn_retain((ScrDyn *)on_dispose), SCR_DS_DEFER);
  return true;
}

/* DisposeResources over the stack's entries: NULL with the disposal error
 * pending, or undefined (+1). */
static ScrDyn *scr_ds_dispose(ScrDisposableStack *s) {
  if (s->disposed) return scr_dyn_retain(scr_dyn_undefined());
  s->disposed = true;
  ScrDisposableResource *items = s->items;
  size_t len = s->len;
  s->items = NULL;
  s->len = s->cap = 0;
  ScrCaught *error = NULL;
  for (size_t i = len; i-- > 0;) {
    ScrDisposableResource *r = &items[i];
    ScrDyn *result;
    if (r->kind == SCR_DS_USE) {
      result = scr_dyn_using_dispose(r->method, r->value);
    } else {
      scr_dyn_this_push_dyn(scr_dyn_undefined());
      result = r->kind == SCR_DS_ADOPT ? scr_dyn_call(r->method, &r->value, 1, "onDispose")
                                       : scr_dyn_call(r->method, NULL, 0, "onDispose");
      scr_dyn_this_pop();
    }
    if (result) {
      scr_dyn_release(result);
    } else {
      if (error) scr_exc_suppress(error);
      error = scr_exc_take();
    }
    scr_dyn_release(r->value);
    scr_dyn_release(r->method);
  }
  free(items);
  if (!error) return scr_dyn_retain(scr_dyn_undefined());
  scr_rethrow(error);
  scr_caught_release(error);
  return NULL;
}

static SCR_TL ScrDyn *scr_ds_method_values[6];
static const char *const scr_ds_method_names[] = {"use", "adopt", "defer", "move", "dispose", "disposed"};
static const uint32_t scr_ds_method_lengths[] = {1, 2, 1, 0, 0, 0};
enum { SCR_DS_M_USE, SCR_DS_M_ADOPT, SCR_DS_M_DEFER, SCR_DS_M_MOVE, SCR_DS_M_DISPOSE, SCR_DS_M_DISPOSED };

static ScrDisposableStack *scr_ds_alloc(void);
static ScrDyn *scr_ds_box(ScrDisposableStack *s);

static ScrDyn *scr_ds_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  unsigned index = (unsigned)scr_box_get_f64(clo->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  const ScrDyn *arg0 = argc > 0 ? args[0] : scr_dyn_undefined();
  const ScrDyn *arg1 = argc > 1 ? args[1] : scr_dyn_undefined();
  ScrDyn *out = NULL;
  switch (index) {
  case SCR_DS_M_USE:
    if (scr_disposable_stack_use(self, arg0)) out = scr_dyn_retain((ScrDyn *)arg0);
    break;
  case SCR_DS_M_ADOPT:
    if (scr_disposable_stack_adopt(self, arg0, arg1)) out = scr_dyn_retain((ScrDyn *)arg0);
    break;
  case SCR_DS_M_DEFER:
    if (scr_disposable_stack_defer(self, arg0)) out = scr_dyn_retain(scr_dyn_undefined());
    break;
  case SCR_DS_M_MOVE: {
    /* The new stack takes the entries; this one becomes disposed. */
    ScrDisposableStack *s = scr_ds_receiver(self, "move", false, true);
    if (!s) break;
    ScrDisposableStack *moved = scr_ds_alloc();
    moved->items = s->items;
    moved->len = s->len;
    moved->cap = s->cap;
    s->items = NULL;
    s->len = s->cap = 0;
    s->disposed = true;
    out = scr_ds_box(moved);
    scr_ds_release(moved);
    break;
  }
  default: {
    ScrDisposableStack *s = scr_ds_receiver(self, "dispose", false, false);
    if (s) out = scr_ds_dispose(s);
    break;
  }
  }
  scr_dyn_release(self);
  return out;
}

/* The function value of method `index` (+1), cached per thread. */
static ScrDyn *scr_ds_method_value(unsigned index) {
  if (!scr_ds_method_values[index]) {
    ScrClosure *clo = scr_closure_new(NULL, 1);
    clo->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(clo->caps[0], (double)index);
    scr_ds_method_values[index] = scr_dyn_new_func(clo, scr_ds_method_call, scr_ds_method_lengths[index],
                                                   "", scr_ds_method_names[index]);
  }
  return scr_dyn_retain(scr_ds_method_values[index]);
}

static ScrDyn *scr_ds_get(void *ptr, const char *key, size_t len) {
  ScrDisposableStack *s = ptr;
  if (len == 8 && memcmp(key, "disposed", 8) == 0) return scr_dyn_new_bool(s->disposed);
  for (unsigned i = 0; i < SCR_DS_M_DISPOSED; i++) {
    if (strlen(scr_ds_method_names[i]) == len && memcmp(key, scr_ds_method_names[i], len) == 0)
      return scr_ds_method_value(i);
  }
  return NULL;
}

static bool scr_ds_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

/* [Symbol.dispose] is the dispose method itself, as in Node. */
static ScrDyn *scr_ds_symbol_get(void *ptr, const ScrDyn *key) {
  (void)ptr;
  if (key->kind != SCR_DYN_SYMBOL) return NULL;
  ScrStr *name = scr_str_new("dispose", 7);
  ScrSym *dispose = scr_sym_well_known(name);
  scr_str_release(name);
  bool match = key->v.symbol.value == dispose;
  scr_sym_release(dispose);
  return match ? scr_ds_method_value(SCR_DS_M_DISPOSE) : NULL;
}

static ScrDyn *scr_ds_inspect_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

static void scr_ds_teardown(void) {
  for (size_t i = 0; i < sizeof scr_ds_method_values / sizeof scr_ds_method_values[0]; i++) {
    scr_dyn_release(scr_ds_method_values[i]);
    scr_ds_method_values[i] = NULL;
  }
}

static const ScrDynHandleOps scr_ds_ops = {
    .cls = "DisposableStack",
    .retain = scr_ds_retain,
    .release = scr_ds_release,
    .get = scr_ds_get,
    .set = scr_ds_set,
    .inspect_view = scr_ds_inspect_view,
    .json_empty_object = true,
    .inspect_view_empty = true,
    .symbol_get = scr_ds_symbol_get,
};

static ScrDisposableStack *scr_ds_alloc(void) {
  static SCR_TL bool installed;
  if (!installed) {
    installed = true;
    scr_dyn_handle_install(SCR_DYNH_DISPOSABLE_STACK, &scr_ds_ops);
    scr_atexit(scr_ds_teardown);
  }
  static ScrCycType cyc_type = {&scr_ds_trace, &scr_ds_gcfree, SCR_CYC_KIND_NONE, 0};
  ScrDisposableStack *s = scr_cyc_alloc(sizeof *s, &cyc_type);
  s->rc = 1;
  scr_obj_alloc_note();
  return s;
}

static ScrDyn *scr_ds_box(ScrDisposableStack *s) { return scr_dyn_new_handle(s, SCR_DYNH_DISPOSABLE_STACK); }

ScrDyn *scr_disposable_stack_new(void) {
  ScrDisposableStack *s = scr_ds_alloc();
  ScrDyn *out = scr_ds_box(s);
  scr_ds_release(s);
  return out;
}
