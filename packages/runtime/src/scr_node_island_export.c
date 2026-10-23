/* Node islands: native values in Node (scope-B milestone NI-5). Links with
 * scr_node_island.c (the `nodeIsland` runtime feature) and nothing else.
 *
 * The export table. A native value that crosses into Node by reference (a
 * closure, a promise, a record or class instance, a checked-dynamic object
 * or array) gets an export id: the table holds it strongly (+1) and the
 * bridge keeps one V8 representative per id, weakly. The same native value
 * always gets the same id, so it always meets the same V8 object, and a
 * representative crossing back is answered with the original value
 * (SCR_NV_EXPORT), so identity holds both ways. Identity is the referent,
 * not the dyn box: a record boxed twice is two capsules over one record.
 *
 * What the representative does (scr_node_bridge.cc):
 *  - closures are V8 functions whose calls run export_call: the arguments
 *    cross into the runtime per the boundary rules and meet the closure's
 *    declared parameter types through its dyn thunk (a mismatch throws the
 *    runtime's TypeError into JavaScript); the result crosses back; a
 *    runtime exception becomes a JavaScript throw and a JavaScript throw
 *    inside a nested island call propagates out as a runtime exception;
 *  - promises are V8 promises resolved inside the runtime promise's own
 *    settlement (export_watch), so their reactions queue exactly when a
 *    JavaScript promise's would;
 *  - objects use interceptors: every property read, write, `in`, delete
 *    and key enumeration goes to the native storage (Reflect.get/set over
 *    the dyn value: a typed record capsule reads and commits its fields).
 *
 * When V8 collects a representative, the bridge reports export_release at
 * its next entry (never inside a GC) and the table drops its reference.
 * Cycles through both heaps leak until NI-8. */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

const ScrDynHandleOps *scr_dyn_handle_ops_of(const ScrDyn *d); /* scr_json.c */

typedef struct {
  ScrDyn *value; /* +1; NULL for a free slot */
  const void *identity;
  uint32_t flags;
} NiExport;

static NiExport *ni_exports = NULL; /* index = id; id 0 unused */
static uint32_t ni_exports_len = 1, ni_exports_cap = 0;
static uint32_t *ni_free = NULL;
static uint32_t ni_nfree = 0, ni_free_cap = 0;

/* identity -> id, open addressing over a power-of-two table. */
typedef struct {
  const void *key;
  uint32_t id;
} NiIdEntry;
static NiIdEntry *ni_ids = NULL;
static size_t ni_ids_cap = 0, ni_ids_len = 0, ni_ids_dead = 0;
static const char ni_tomb;

SCR_COLD static void ni_export_oom(void) { scr_trap("scriptc: out of memory\n"); }

static size_t ni_hash(const void *p) {
  uintptr_t x = (uintptr_t)p;
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33;
  return (size_t)x;
}

static void ni_ids_put(const void *key, uint32_t id);

static void ni_ids_grow(void) {
  NiIdEntry *old = ni_ids;
  size_t old_cap = ni_ids_cap;
  ni_ids_cap = old_cap ? old_cap * 2 : 64;
  while (ni_ids_len * 2 >= ni_ids_cap) ni_ids_cap *= 2;
  ni_ids = calloc(ni_ids_cap, sizeof *ni_ids);
  if (ni_ids == NULL) ni_export_oom();
  ni_ids_len = 0;
  ni_ids_dead = 0;
  for (size_t i = 0; i < old_cap; i++)
    if (old[i].key != NULL && old[i].key != &ni_tomb) ni_ids_put(old[i].key, old[i].id);
  free(old);
}

static void ni_ids_put(const void *key, uint32_t id) {
  if ((ni_ids_len + ni_ids_dead + 1) * 2 > ni_ids_cap) ni_ids_grow();
  size_t mask = ni_ids_cap - 1;
  for (size_t i = ni_hash(key) & mask;; i = (i + 1) & mask) {
    if (ni_ids[i].key == NULL || ni_ids[i].key == &ni_tomb) {
      if (ni_ids[i].key == &ni_tomb) ni_ids_dead--;
      ni_ids[i].key = key;
      ni_ids[i].id = id;
      ni_ids_len++;
      return;
    }
  }
}

static uint32_t ni_ids_get(const void *key) {
  if (ni_ids_cap == 0) return 0;
  size_t mask = ni_ids_cap - 1;
  for (size_t i = ni_hash(key) & mask;; i = (i + 1) & mask) {
    if (ni_ids[i].key == NULL) return 0;
    if (ni_ids[i].key == key) return ni_ids[i].id;
  }
}

static void ni_ids_del(const void *key) {
  if (ni_ids_cap == 0) return;
  size_t mask = ni_ids_cap - 1;
  for (size_t i = ni_hash(key) & mask;; i = (i + 1) & mask) {
    if (ni_ids[i].key == NULL) return;
    if (ni_ids[i].key == key) {
      ni_ids[i].key = &ni_tomb;
      ni_ids_len--;
      ni_ids_dead++;
      return;
    }
  }
}

/* The identity of a value that crosses by reference: the referent for
 * boxes that wrap one (closures, promises, typed capsules), else the box. */
static const void *ni_identity(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_FUNC:
    /* A class value is boxed afresh per read: its identity is the class. */
    if (v->v.fn.class_obj != NULL) return v->v.fn.class_obj;
    return v->v.fn.clo != NULL ? (const void *)v->v.fn.clo : (const void *)v;
  case SCR_DYN_PROMISE:
    return v->v.promise;
  case SCR_DYN_TYPED_REF:
    return v->v.typed_ref.ptr;
  case SCR_DYN_HANDLE:
    return v->v.handle.ptr; /* a Map or Set: its native storage */
  default:
    return v;
  }
}

static bool ni_index_key(const ScrStr *s) {
  if (s->len == 0 || s->len > 10) return false;
  if (s->len > 1 && s->data[0] == '0') return false;
  for (size_t i = 0; i < s->len; i++)
    if (s->data[i] < '0' || s->data[i] > '9') return false;
  return true;
}

/* A dyn array, a live array capsule, or a capsule whose view is an array
 * (a tuple). */
static bool ni_is_array(const ScrDyn *v) {
  if (v->kind == SCR_DYN_ARR) return true;
  if (v->kind != SCR_DYN_TYPED_REF) return false;
  if (scr_dyn_typed_ref_array_ops(v) != NULL) return true;
  if (v->v.typed_ref.record || v->v.typed_ref.klass) return false;
  ScrDyn *view = scr_dyn_typed_ref_materialize(v);
  bool array = view != NULL && view->kind == SCR_DYN_ARR;
  scr_dyn_release(view);
  if (scr_exc_pending()) scr_exc_clear();
  return array;
}

/* The live Map or Set a value is (a dyn handle, or a typed capsule whose
 * view is one): +1 view with *set telling which, or NULL. */
static ScrDyn *ni_collection(const ScrDyn *v, bool *set) {
  ScrDyn *view = NULL;
  if (v->kind == SCR_DYN_HANDLE) view = scr_dyn_retain((ScrDyn *)v);
  else if (v->kind == SCR_DYN_TYPED_REF && !v->v.typed_ref.record && !v->v.typed_ref.klass &&
           scr_dyn_typed_ref_array_ops(v) == NULL) {
    view = scr_dyn_typed_ref_materialize(v);
    if (scr_exc_pending()) scr_exc_clear();
  }
  if (view != NULL && view->kind == SCR_DYN_HANDLE &&
      (view->v.handle.tag == SCR_DYNH_MAP || view->v.handle.tag == SCR_DYNH_SET)) {
    *set = view->v.handle.tag == SCR_DYNH_SET;
    return view;
  }
  scr_dyn_release(view);
  return NULL;
}

uint32_t scr_ni_export_flags(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_FUNC:
    return v->v.fn.class_obj != NULL ? SCR_NVF_FUNCTION | SCR_NVF_CONSTRUCTOR : SCR_NVF_FUNCTION;
  case SCR_DYN_PROMISE:
    return SCR_NVF_PROMISE;
  case SCR_DYN_ARR:
    return SCR_NVF_ARRAY;
  case SCR_DYN_HANDLE:
  case SCR_DYN_TYPED_REF: {
    if (v->kind == SCR_DYN_TYPED_REF && ni_is_array(v)) return SCR_NVF_ARRAY;
    bool set = false;
    ScrDyn *c = ni_collection(v, &set);
    if (c == NULL) return 0;
    scr_dyn_release(c);
    return set ? SCR_NVF_SET : SCR_NVF_MAP;
  }
  default:
    return 0;
  }
}

/* Whether `v` crosses into Node as an export (by reference). */
bool scr_ni_exportable(const ScrDyn *v);
bool scr_ni_exportable(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_FUNC:
  case SCR_DYN_PROMISE:
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR: /* a Proxy over an Array in V8 (NI-5b) */
  case SCR_DYN_TYPED_REF:
    return true;
  case SCR_DYN_HANDLE: /* Maps and Sets (NI-5b) */
    return v->v.handle.tag == SCR_DYNH_MAP || v->v.handle.tag == SCR_DYNH_SET;
  default:
    return false;
  }
}


/* The export id of `v` (borrowed), minting one on first crossing. */
uint32_t scr_ni_export_id(ScrDyn *v) {
  const void *identity = ni_identity(v);
  uint32_t id = ni_ids_get(identity);
  if (id != 0) return id;
  if (ni_nfree > 0) {
    id = ni_free[--ni_nfree];
  } else {
    if (ni_exports_len >= ni_exports_cap) {
      uint32_t cap = ni_exports_cap ? ni_exports_cap * 2 : 64;
      NiExport *grown = realloc(ni_exports, cap * sizeof *grown);
      if (grown == NULL) ni_export_oom();
      ni_exports = grown;
      ni_exports_cap = cap;
      if (ni_exports_len == 1) memset(&ni_exports[0], 0, sizeof ni_exports[0]);
    }
    id = ni_exports_len++;
  }
  ni_exports[id].value = scr_dyn_retain(v);
  ni_exports[id].identity = identity;
  ni_exports[id].flags = scr_ni_export_flags(v);
  ni_ids_put(identity, id);
  return id;
}

/* The value of export `id` (borrowed), or NULL. */
ScrDyn *scr_ni_export_value(uint32_t id) {
  if (id == 0 || id >= ni_exports_len) return NULL;
  return ni_exports[id].value;
}

/* Fills `out` with the export of `v` (borrowed). */
void scr_ni_export_out(ScrDyn *v, ScrNodeValue *out) {
  uint32_t id = scr_ni_export_id(v);
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_EXPORT;
  out->flags = ni_exports[id].flags;
  out->u.exp.id = id;
  if (v->kind == SCR_DYN_FUNC) {
    out->u.exp.length = v->v.fn.arity;
    if (v->v.fn.name != NULL) {
      out->u.exp.name = v->v.fn.name;
      out->u.exp.name_len = strlen(v->v.fn.name);
    }
  }
}

uint32_t scr_ni_live_exports(void) {
  uint32_t n = 0;
  for (uint32_t i = 1; i < ni_exports_len; i++) n += ni_exports[i].value != NULL;
  return n;
}

/* ── host callbacks ───────────────────────────────────────────────────── */

/* Values the runtime hands the bridge stay alive until the next host call
 * (their string data points into them). */
static ScrDyn *ni_keep = NULL;

static void ni_keep_set(ScrDyn *v) {
  ScrDyn *old = ni_keep;
  ni_keep = v;
  scr_dyn_release(old);
}

/* The pending runtime exception as an out value: 1. */
static int ni_threw(ScrNodeValue *out) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *thrown = scr_caught_to_dyn(caught);
  scr_caught_release(caught);
  if (thrown == NULL) thrown = scr_dyn_retain(scr_dyn_undefined());
  if (!scr_ni_value_out(thrown, out)) {
    /* The thrown value itself cannot cross: throw what that raised. */
    scr_dyn_release(thrown);
    caught = scr_exc_take();
    thrown = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    if (thrown == NULL || !scr_ni_value_out(thrown, out)) {
      scr_exc_clear();
      memset(out, 0, sizeof *out);
      out->tag = SCR_NV_UNDEFINED;
    }
  }
  ni_keep_set(thrown);
  return 1;
}

/* A runtime result as an out value: 0, or 1 when it cannot cross. */
static int ni_returned(ScrDyn *result, ScrNodeValue *out) {
  if (!scr_ni_value_out(result, out)) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  ni_keep_set(result);
  return 0;
}

/* Arguments as runtime values (+1 each). */
static ScrDyn **ni_args_in(const ScrNodeValue *args, size_t argc, ScrDyn **small, size_t nsmall) {
  ScrDyn **out = argc <= nsmall ? small : malloc(argc * sizeof *out);
  if (out == NULL) ni_export_oom();
  for (size_t i = 0; i < argc; i++) out[i] = scr_ni_arg_in(&args[i]);
  return out;
}

static void ni_args_free(ScrDyn **args, size_t argc, ScrDyn **small) {
  for (size_t i = 0; i < argc; i++) scr_dyn_release(args[i]);
  if (args != small) free(args);
}

int scr_ni_host_export_call(uint32_t id, const ScrNodeValue *this_, const ScrNodeValue *args,
                            size_t argc, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *fn = scr_ni_export_value(id);
  if (fn == NULL) {
    scr_throw_error_msg(SCR_ERR_TYPE, "native function is gone", 23);
    return ni_threw(out);
  }
  scr_dyn_retain(fn);
  ScrDyn *small[8];
  ScrDyn **in = ni_args_in(args, argc, small, 8);
  ScrDyn *self = this_ != NULL ? scr_ni_value_in(this_) : scr_dyn_retain(scr_dyn_undefined());
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, in, argc, "callback");
  scr_dyn_this_pop();
  scr_dyn_release(self);
  ni_args_free(in, argc, small);
  scr_dyn_release(fn);
  scr_ni_shared_refresh();
  if (result == NULL || scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  return ni_returned(result, out);
}

static ScrDyn *ni_class_ctor(const ScrDyn *cls);

int scr_ni_host_export_construct(uint32_t id, const ScrNodeValue *args, size_t argc,
                                 ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *ctor = scr_ni_export_value(id);
  if (ctor == NULL) {
    scr_throw_error_msg(SCR_ERR_TYPE, "native function is gone", 23);
    return ni_threw(out);
  }
  scr_dyn_retain(ctor);
  ScrDyn *result;
  ScrDyn *helper = ni_class_ctor(ctor);
  if (helper != NULL) {
    /* A native class of a shared module (NI-6): its helper's thunk checks
     * the arguments against the constructor's parameters. */
    ScrDyn *small[8];
    ScrDyn **in = ni_args_in(args, argc, small, 8);
    result = scr_dyn_call(helper, in, argc, "constructor");
    ni_args_free(in, argc, small);
  } else {
    ScrDyn *list = scr_dyn_new_arr();
    for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(list, scr_ni_value_in(&args[i]));
    ScrStr *what = scr_str_new("constructor", 11);
    result = scr_dyn_construct(ctor, list, what);
    scr_str_release(what);
    scr_dyn_release(list);
  }
  scr_dyn_release(ctor);
  scr_ni_shared_refresh();
  if (result == NULL || scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  return ni_returned(result, out);
}

/* ── class method tables ──────────────────────────────────────────────
 * A class instance's capsule holds its fields; its prototype methods come
 * from a table the compiler's builder makes once per class (name -> the
 * unbound method value, a dyn function whose thunk checks the receiver),
 * keyed by the capsule's type key. */
typedef struct {
  const char *key;
  size_t key_len;
  ScrDyn *table; /* +1 dyn object */
  ScrDyn *ctor;  /* +1 dyn function constructing an instance (NI-6), or NULL */
} NiMethods;
static NiMethods *ni_methods = NULL;
static size_t ni_nmethods = 0, ni_methods_cap = 0;

static ScrDyn *ni_methods_of(const ScrDyn *v) {
  if (v->kind != SCR_DYN_TYPED_REF || v->v.typed_ref.type_key == NULL) return NULL;
  const char *key = v->v.typed_ref.type_key;
  size_t len = v->v.typed_ref.type_key_len;
  for (size_t i = 0; i < ni_nmethods; i++)
    if (ni_methods[i].key_len == len && memcmp(ni_methods[i].key, key, len) == 0)
      return ni_methods[i].table;
  return NULL;
}

ScrDyn *scr_node_island_class_methods(ScrDyn *value, ScrDyn *builder) {
  if (value->kind == SCR_DYN_TYPED_REF && value->v.typed_ref.type_key != NULL &&
      ni_methods_of(value) == NULL) {
    ScrDyn *table = scr_dyn_call(builder, NULL, 0, "class methods");
    if (table == NULL) return NULL;
    if (ni_nmethods == ni_methods_cap) {
      ni_methods_cap = ni_methods_cap ? ni_methods_cap * 2 : 8;
      NiMethods *grown = realloc(ni_methods, ni_methods_cap * sizeof *grown);
      if (grown == NULL) ni_export_oom();
      ni_methods = grown;
    }
    ni_methods[ni_nmethods].key = value->v.typed_ref.type_key; /* static */
    ni_methods[ni_nmethods].key_len = value->v.typed_ref.type_key_len;
    ni_methods[ni_nmethods].table = table;
    ni_methods[ni_nmethods].ctor = NULL;
    ni_nmethods++;
  }
  return scr_dyn_retain(value);
}

/* NI-6: the method table of a class registered through its class value
 * (a shared module's exported class), keyed by the same type key its
 * instances carry. Answers the class value. */
/* The type key a class value's instances carry: "classval:C" -> "object:C".
 * Answers whether `key`/`len` is it. */
static bool ni_instance_key_is(const char *sig, const char *key, size_t len) {
  if (sig == NULL || key == NULL || strncmp(sig, "classval:", 9) != 0) return false;
  size_t rest = strlen(sig + 9);
  return len == 7 + rest && memcmp(key, "object:", 7) == 0 && memcmp(key + 7, sig + 9, rest) == 0;
}

static NiMethods *ni_methods_of_class(const ScrDyn *cls) {
  if (cls->kind != SCR_DYN_FUNC || cls->v.fn.class_obj == NULL) return NULL;
  for (size_t i = 0; i < ni_nmethods; i++)
    if (ni_instance_key_is(cls->v.fn.sig, ni_methods[i].key, ni_methods[i].key_len))
      return &ni_methods[i];
  return NULL;
}

ScrDyn *scr_node_island_class_methods_of(ScrDyn *cls, ScrDyn *builder, ScrDyn *ctor) {
  if (cls->kind != SCR_DYN_FUNC || cls->v.fn.class_obj == NULL || cls->v.fn.sig == NULL ||
      strncmp(cls->v.fn.sig, "classval:", 9) != 0)
    return scr_dyn_retain(cls);
  NiMethods *known = ni_methods_of_class(cls);
  if (known != NULL) {
    if (known->ctor == NULL && ctor->kind == SCR_DYN_FUNC) known->ctor = scr_dyn_retain(ctor);
    return scr_dyn_retain(cls);
  }
  ScrDyn *table = builder->kind == SCR_DYN_FUNC ? scr_dyn_call(builder, NULL, 0, "class methods")
                                                : scr_dyn_new_obj();
  if (table == NULL) return NULL;
  if (ni_nmethods == ni_methods_cap) {
    ni_methods_cap = ni_methods_cap ? ni_methods_cap * 2 : 8;
    NiMethods *grown = realloc(ni_methods, ni_methods_cap * sizeof *grown);
    if (grown == NULL) ni_export_oom();
    ni_methods = grown;
  }
  size_t rest = strlen(cls->v.fn.sig + 9);
  char *key = malloc(7 + rest + 1); /* lives as long as the program */
  if (key == NULL) ni_export_oom();
  memcpy(key, "object:", 7);
  memcpy(key + 7, cls->v.fn.sig + 9, rest + 1);
  ni_methods[ni_nmethods].key = key;
  ni_methods[ni_nmethods].key_len = 7 + rest;
  ni_methods[ni_nmethods].table = table;
  ni_methods[ni_nmethods].ctor = ctor->kind == SCR_DYN_FUNC ? scr_dyn_retain(ctor) : NULL;
  ni_nmethods++;
  return scr_dyn_retain(cls);
}

/* The constructor helper of a native class value (borrowed), or NULL. */
static ScrDyn *ni_class_ctor(const ScrDyn *cls) {
  NiMethods *m = ni_methods_of_class(cls);
  return m != NULL ? m->ctor : NULL;
}

/* A prototype method of a class capsule (+1), or NULL. */
static ScrDyn *ni_class_method(const ScrDyn *target, const ScrDyn *key) {
  if (key->kind != SCR_DYN_STR) return NULL;
  ScrDyn *table = ni_methods_of(target);
  if (table == NULL) return NULL;
  ScrDyn *m = scr_dyn_obj_get(table, key->v.str->data, key->v.str->len);
  return m != NULL ? scr_dyn_retain(m) : NULL;
}

int scr_ni_host_export_get(uint32_t id, const ScrNodeValue *key, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL) return 2;
  ScrDyn *k = scr_ni_value_in(key);
  ScrDyn *pk = scr_dyn_property_key_value(k);
  if (pk == NULL) {
    scr_dyn_release(k);
    return ni_threw(out);
  }
  if (ni_is_array(target) && pk->kind == SCR_DYN_STR) {
    /* length and elements straight from the native array: a live array
     * capsule answers them without rebuilding its snapshot. */
    ScrDyn *fast = NULL;
    if (target->kind == SCR_DYN_TYPED_REF) {
      fast = scr_dyn_typed_ref_key_get(target, pk->v.str);
    } else if (pk->v.str->len == 6 && memcmp(pk->v.str->data, "length", 6) == 0) {
      fast = scr_dyn_new_num((double)target->v.arr.len);
    }
    if (fast != NULL) {
      scr_dyn_release(pk);
      scr_dyn_release(k);
      return ni_returned(fast, out);
    }
    /* Anything but an index is Array.prototype's (the Proxy target's). */
    if (!ni_index_key(pk->v.str) &&
        !(pk->v.str->len == 6 && memcmp(pk->v.str->data, "length", 6) == 0)) {
      scr_dyn_release(pk);
      scr_dyn_release(k);
      return 2;
    }
    ScrDyn *element = scr_dyn_reflect_get(target, pk, target);
    scr_dyn_release(pk);
    scr_dyn_release(k);
    if (element == NULL || scr_exc_pending()) {
      scr_dyn_release(element);
      return ni_threw(out);
    }
    return ni_returned(element, out);
  }
  int present = 0;
  if (pk->kind == SCR_DYN_STR) present = scr_dyn_in(target, pk->v.str);
  if (!present && !scr_exc_pending()) {
    /* A prototype method of a class instance (its table). */
    ScrDyn *method = ni_class_method(target, pk);
    scr_dyn_release(pk);
    scr_dyn_release(k);
    if (method != NULL) return ni_returned(method, out);
    return 2;
  }
  ScrDyn *result = scr_exc_pending() ? NULL : scr_dyn_reflect_get(target, pk, target);
  if (result != NULL && result->kind == SCR_DYN_UNDEF) {
    ScrDyn *method = ni_class_method(target, pk);
    if (method != NULL) {
      scr_dyn_release(result);
      result = method;
    }
  }
  scr_dyn_release(pk);
  scr_dyn_release(k);
  if (result == NULL || scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  return ni_returned(result, out);
}

int scr_ni_host_export_set(uint32_t id, const ScrNodeValue *key, const ScrNodeValue *value,
                           ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL) return 2;
  ScrDyn *k = scr_ni_value_in(key);
  ScrDyn *v = scr_ni_value_in(value);
  bool ok = scr_dyn_reflect_set(target, k, v, target);
  scr_dyn_release(v);
  scr_dyn_release(k);
  scr_ni_shared_refresh();
  if (scr_exc_pending()) return ni_threw(out);
  (void)ok; /* a refused write is silent outside strict mode; Node's setter
             * interceptor reports the same */
  memset(out, 0, sizeof *out);
  return 0;
}

int scr_ni_host_export_has(uint32_t id, const ScrNodeValue *key) {
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL) return 0;
  ScrDyn *k = scr_ni_value_in(key);
  ScrDyn *pk = scr_dyn_property_key_value(k);
  int present = 0;
  if (pk != NULL && pk->kind == SCR_DYN_STR && ni_is_array(target)) {
    if (ni_index_key(pk->v.str)) {
      ScrStr *lk = scr_str_new("length", 6);
      ScrDyn *lkey = scr_dyn_new_str(lk);
      scr_str_release(lk);
      ScrDyn *len = scr_dyn_reflect_get(target, lkey, target);
      scr_dyn_release(lkey);
      double index = strtod(pk->v.str->data, NULL);
      present = len != NULL && len->kind == SCR_DYN_NUM && index < len->v.num;
      scr_dyn_release(len);
    }
  } else if (pk != NULL && pk->kind == SCR_DYN_STR) {
    present = scr_dyn_in(target, pk->v.str);
  }
  if (scr_exc_pending()) scr_exc_clear();
  if (!present && pk != NULL) {
    ScrDyn *method = ni_class_method(target, pk);
    present = method != NULL;
    scr_dyn_release(method);
  }
  scr_dyn_release(pk);
  scr_dyn_release(k);
  return present;
}

int scr_ni_host_export_delete(uint32_t id, const ScrNodeValue *key, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  if (target == NULL) return 2;
  ScrDyn *k = scr_ni_value_in(key);
  scr_dyn_key_delete_computed(target, k, false);
  scr_dyn_release(k);
  if (scr_exc_pending()) return ni_threw(out);
  memset(out, 0, sizeof *out);
  return 0;
}

/* Own enumerable string keys, in JS order, as an array value. */
int scr_ni_host_export_keys(uint32_t id, ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  ScrDyn *keys = target != NULL ? scr_dyn_obj_keys(target) : scr_dyn_new_arr();
  if (keys == NULL || scr_exc_pending()) {
    scr_dyn_release(keys);
    return ni_threw(out);
  }
  /* Keys cross as a JSON copy: an array of strings. */
  ScrStr *gap = scr_str_new("", 0);
  ScrDyn *json = scr_json_stringify_replacer(keys, scr_dyn_undefined(), gap);
  scr_str_release(gap);
  scr_dyn_release(keys);
  if (json == NULL || json->kind != SCR_DYN_STR) {
    scr_dyn_release(json);
    if (scr_exc_pending()) return ni_threw(out);
    ScrStr *empty = scr_str_new("[]", 2);
    json = scr_dyn_new_str(empty);
    scr_str_release(empty);
  }
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_JSON;
  out->u.str.data = json->v.str->data;
  out->u.str.len = json->v.str->len;
  ni_keep_set(json);
  return 0;
}

int scr_ni_host_export_op(uint32_t id, uint32_t op, const ScrNodeValue *args, size_t argc,
                          ScrNodeValue *out) {
  ni_keep_set(NULL);
  ScrDyn *target = scr_ni_export_value(id);
  bool set = false;
  ScrDyn *view = target != NULL ? ni_collection(target, &set) : NULL;
  if (view == NULL) {
    scr_throw_error_msg(SCR_ERR_TYPE, "native collection is gone", 25);
    return ni_threw(out);
  }
  ScrDyn *small[4];
  ScrDyn **in = ni_args_in(args, argc, small, 4);
  /* The collection's own handle operations (scr_json.c), which every
   * program with Maps or Sets links. */
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(view);
  void *ptr = view->v.handle.ptr;
  static const char *const names[] = {"get", "set", "has", "delete", "clear"};
  ScrDyn *result = NULL;
  if (op <= SCR_NODE_COLLECTION_CLEAR) {
    const char *name = op == SCR_NODE_COLLECTION_SET && set ? "add" : names[op];
    result = ops->invoke(ptr, view, name, in, op == SCR_NODE_COLLECTION_CLEAR ? 0 : argc, name);
  } else if (op == SCR_NODE_COLLECTION_SIZE) {
    result = ops->get(ptr, "size", 4);
  } else {
    result = ops->iter_pack != NULL ? ops->iter_pack(ptr) : scr_dyn_new_arr();
  }
  ni_args_free(in, argc, small);
  scr_dyn_release(view);
  if (op == SCR_NODE_COLLECTION_SET && result != NULL) {
    scr_dyn_release(result); /* the JS side answers itself */
    result = scr_dyn_retain(scr_dyn_undefined());
  }
  if (result == NULL || scr_exc_pending()) {
    scr_dyn_release(result);
    return ni_threw(out);
  }
  return ni_returned(result, out);
}

void scr_ni_host_export_release(uint32_t id) {
  if (id == 0 || id >= ni_exports_len || ni_exports[id].value == NULL) return;
  ScrDyn *v = ni_exports[id].value;
  ni_ids_del(ni_exports[id].identity);
  ni_exports[id].value = NULL;
  ni_exports[id].identity = NULL;
  if (ni_nfree == ni_free_cap) {
    uint32_t cap = ni_free_cap ? ni_free_cap * 2 : 64;
    uint32_t *grown = realloc(ni_free, cap * sizeof *grown);
    if (grown == NULL) ni_export_oom();
    ni_free = grown;
    ni_free_cap = cap;
  }
  ni_free[ni_nfree++] = id;
  scr_dyn_release(v);
}

/* `value instanceof C` for the representative of native class C: the
 * value is an instance of C's own type key (NI-6 shortcut: instances of
 * native subclasses of C answer false; NOTES.md). */
int scr_ni_host_export_instance_of(uint32_t id, const ScrNodeValue *value) {
  ScrDyn *ctor = scr_ni_export_value(id);
  if (ctor == NULL || ctor->kind != SCR_DYN_FUNC || ctor->v.fn.class_obj == NULL) return 0;
  ScrDyn *v = scr_ni_value_in(value);
  int is = v->kind == SCR_DYN_TYPED_REF &&
           ni_instance_key_is(ctor->v.fn.sig, v->v.typed_ref.type_key, v->v.typed_ref.type_key_len);
  scr_dyn_release(v);
  return is;
}

/* ── promises into Node ───────────────────────────────────────────────── */

typedef struct {
  uint32_t id;
  int rejected;
  const ScrNodeValue *value;
} NiSettle;

static void ni_settle_job(void *p) {
  NiSettle *a = p;
  scr_ni_bridge_loaded()->export_settle(a->id, a->rejected, a->value);
}

void scr_ni_bridge_export_settle(uint32_t id, int rejected, const ScrNodeValue *value) {
  if (scr_ni_bridge_loaded() == NULL) return;
  NiSettle a = {id, rejected, value};
  scr_ni_on_node_stack(ni_settle_job, &a);
}

/* Settles the V8 promise of export `id` from the settled runtime promise. */
static void ni_settle_export(uint32_t id, ScrPromise *p) {
  ScrNodeValue value;
  ScrDyn *payload;
  int rejected = scr_promise_is_rejected(p);
  if (rejected) {
    payload = scr_promise_reason_dyn(p);
  } else if (scr_promise_payload_is_dyn(p)) {
    payload = (ScrDyn *)scr_promise_payload_ref(p);
  } else {
    payload = NULL; /* a void fulfillment */
  }
  if (payload == NULL) payload = scr_dyn_retain(scr_dyn_undefined());
  if (!scr_ni_value_out(payload, &value)) {
    /* The payload cannot cross: the promise rejects with that error. */
    scr_dyn_release(payload);
    ScrCaught *caught = scr_exc_take();
    payload = scr_caught_to_dyn(caught);
    scr_caught_release(caught);
    rejected = 1;
    if (payload == NULL || !scr_ni_value_out(payload, &value)) {
      scr_exc_clear();
      memset(&value, 0, sizeof value);
    }
  }
  scr_ni_bridge_export_settle(id, rejected, &value);
  scr_dyn_release(payload);
}

static void ni_promise_settled(ScrPromise *dst, ScrPromise *src) {
  (void)dst;
  uint32_t id = ni_ids_get(src);
  if (id != 0) ni_settle_export(id, src);
}

/* The bridge created the V8 promise of export `id`: it settles inside the
 * runtime promise's settlement, or now when that already happened. The
 * runtime promise counts as handled from here on; the V8 promise carries
 * Node's own unhandled-rejection tracking. */
void scr_ni_host_export_watch(uint32_t id) {
  ScrDyn *v = scr_ni_export_value(id);
  if (v == NULL || v->kind != SCR_DYN_PROMISE) return;
  ScrPromise *p = v->v.promise;
  scr_promise_mark_handled(p);
  if (!scr_promise_is_pending(p)) {
    ni_settle_export(id, p);
    return;
  }
  scr_promise_on_settle_sync(p, ni_promise_settled);
}

/* ── shared modules (scope-B NI-6) ────────────────────────────────────
 * A module the program compiled and island code also imports exists once:
 * the program registers it (nodeIsland.share) with its accessor, a
 * compiler-generated function answering the current values of its exports
 * as a dyn array (the TDZ sentinel for a binding whose declaration has not
 * run). The bootstrap's loader hooks (scr_node_island_hooks.cjs) resolve
 * island imports of the module to a generated ES module whose bindings
 * read those values; the bindings that can change (exported lets, and
 * bindings still in their temporal dead zone when the generated module
 * linked) are kept current by pushes: at each entry into Node and before
 * each return from a native callback, the runtime compares the bound
 * values with the last pushed ones and pushes the changes. Island code only
 * runs inside those entries, so it never observes a stale binding. */

typedef struct {
  ScrStr *path;     /* +1 */
  ScrStr *exports;  /* +1 JSON [{"name","kind"}] */
  ScrDyn *accessor; /* +1 */
  uint32_t nslots;
  ScrDyn **last;    /* +1 each, NULL when unbound */
  uint8_t *bound;   /* 0 unbound, 1 bound, 2 bound late (not yet pushed) */
  uint32_t nbound;
} NiShared;

static NiShared *ni_shared = NULL;
static uint32_t ni_nshared = 0, ni_shared_cap = 0;
static uint32_t ni_shared_bound = 0; /* bound slots over all modules */
static bool ni_refreshing = false;
static ScrDyn *ni_tdz = NULL;

static ScrDyn *ni_tdz_value(void) {
  if (ni_tdz == NULL) ni_tdz = scr_dyn_new_obj();
  return ni_tdz;
}

/* nodeIsland.sharedTdz: the sentinel an accessor answers for a binding in
 * its temporal dead zone (+1). */
ScrDyn *scr_node_island_shared_tdz(void) { return scr_dyn_retain(ni_tdz_value()); }

/* nodeIsland.share(path, exports JSON, accessor): registers a shared
 * module before any island code runs. Never loads Node. */
void scr_node_island_share(ScrStr *path, ScrStr *exports, ScrDyn *accessor) {
  for (uint32_t i = 0; i < ni_nshared; i++)
    if (ni_shared[i].path->len == path->len &&
        memcmp(ni_shared[i].path->data, path->data, path->len) == 0)
      return;
  /* Released at exit (after Node stopped, when it started: atexit order). */
  if (ni_nshared == 0 && ni_shared_cap == 0) scr_atexit(scr_ni_exports_release_all);
  if (ni_nshared == ni_shared_cap) {
    ni_shared_cap = ni_shared_cap ? ni_shared_cap * 2 : 8;
    NiShared *grown = realloc(ni_shared, ni_shared_cap * sizeof *grown);
    if (grown == NULL) ni_export_oom();
    ni_shared = grown;
  }
  NiShared *m = &ni_shared[ni_nshared++];
  memset(m, 0, sizeof *m);
  m->path = scr_str_retain(path);
  m->exports = scr_str_retain(exports);
  m->accessor = scr_dyn_retain(accessor);
  /* The slot count: the accessor's array length is the export count. */
  uint32_t n = 0;
  for (size_t i = 0; i < exports->len; i++) n += exports->data[i] == '{';
  m->nslots = n;
  m->last = calloc(n > 0 ? n : 1, sizeof *m->last);
  m->bound = calloc(n > 0 ? n : 1, 1);
  if (m->last == NULL || m->bound == NULL) ni_export_oom();
}

/* The current export values of module `m` (+1 dyn array), or NULL. */
static ScrDyn *ni_shared_values(NiShared *m) {
  ScrDyn *values = scr_dyn_call(m->accessor, NULL, 0, "shared module");
  if (values == NULL) scr_exc_clear();
  return values;
}

void scr_ni_host_shared_table(ScrNodeValue *out) {
  ni_keep_set(NULL);
  size_t len = 2;
  for (uint32_t i = 0; i < ni_nshared; i++)
    len += ni_shared[i].path->len * 2 + ni_shared[i].exports->len + 32;
  char *buf = malloc(len);
  if (buf == NULL) ni_export_oom();
  size_t at = 0;
  buf[at++] = '[';
  for (uint32_t i = 0; i < ni_nshared; i++) {
    NiShared *m = &ni_shared[i];
    if (i > 0) buf[at++] = ',';
    at += (size_t)sprintf(buf + at, "{\"path\":\"");
    for (size_t j = 0; j < m->path->len; j++) {
      char c = m->path->data[j];
      if (c == '"' || c == '\\') buf[at++] = '\\';
      buf[at++] = c;
    }
    at += (size_t)sprintf(buf + at, "\",\"exports\":");
    memcpy(buf + at, m->exports->data, m->exports->len);
    at += m->exports->len;
    buf[at++] = '}';
  }
  buf[at++] = ']';
  ScrStr *text = scr_str_new(buf, at);
  ScrDyn *json = scr_dyn_new_str(text);
  scr_str_release(text);
  free(buf);
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_STRING;
  out->u.str.data = json->v.str->data;
  out->u.str.len = json->v.str->len;
  ni_keep_set(json);
}

static void ni_shared_bind(NiShared *m, uint32_t slot, ScrDyn *value, uint8_t how) {
  if (m->bound[slot] == 0) {
    m->nbound++;
    ni_shared_bound++;
  }
  m->bound[slot] = how;
  scr_dyn_release(m->last[slot]);
  m->last[slot] = value != NULL ? scr_dyn_retain(value) : NULL;
}

int scr_ni_host_shared_get(uint32_t mod, uint32_t slot, int mode, ScrNodeValue *out) {
  ni_keep_set(NULL);
  memset(out, 0, sizeof *out);
  if (mod >= ni_nshared || slot >= ni_shared[mod].nslots) return 3;
  NiShared *m = &ni_shared[mod];
  ScrDyn *values = ni_shared_values(m);
  if (values == NULL) return 3;
  ScrDyn *v = scr_dyn_arr_at(values, slot);
  scr_dyn_release(values);
  if (v == ni_tdz) {
    scr_dyn_release(v);
    if (mode == 2) ni_shared_bind(m, slot, NULL, 2);
    return 3;
  }
  /* Arrays still cross as copies (NI-5): a copy of shared state would
   * diverge silently, so the island read throws instead. */
  if (v->kind == SCR_DYN_ARR ||
      (v->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(v) != NULL)) {
    scr_dyn_release(v);
    static const char message[] =
        "scriptc: an array exported by a shared module cannot cross into a Node island yet";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return ni_threw(out);
  }
  if (mode == 1 || mode == 2) ni_shared_bind(m, slot, v, 1);
  return ni_returned(v, out);
}

void scr_ni_host_shared_tdz(ScrNodeValue *out) {
  ni_keep_set(NULL);
  size_t cap = 64, at = 0;
  char *buf = malloc(cap);
  if (buf == NULL) ni_export_oom();
  buf[at++] = '[';
  for (uint32_t i = 0; i < ni_nshared; i++) {
    NiShared *m = &ni_shared[i];
    ScrDyn *values = ni_shared_values(m);
    if (values == NULL) continue;
    for (uint32_t j = 0; j < m->nslots; j++) {
      ScrDyn *v = scr_dyn_arr_at(values, j);
      if (v == ni_tdz) {
        if (at + 32 > cap) {
          cap *= 2;
          char *grown = realloc(buf, cap);
          if (grown == NULL) ni_export_oom();
          buf = grown;
        }
        at += (size_t)sprintf(buf + at, "%s[%u,%u]", at > 1 ? "," : "", i, j);
      }
      scr_dyn_release(v);
    }
    scr_dyn_release(values);
  }
  buf[at++] = ']';
  ScrStr *text = scr_str_new(buf, at);
  ScrDyn *json = scr_dyn_new_str(text);
  scr_str_release(text);
  free(buf);
  memset(out, 0, sizeof *out);
  out->tag = SCR_NV_STRING;
  out->u.str.data = json->v.str->data;
  out->u.str.len = json->v.str->len;
  ni_keep_set(json);
}

typedef struct {
  uint32_t mod, slot;
  const ScrNodeValue *value;
} NiPush;

static void ni_push_job(void *p) {
  NiPush *a = p;
  scr_ni_bridge_loaded()->shared_push(a->mod, a->slot, a->value);
}

/* Pushes the bound exports whose native values changed since the last
 * push. Cheap when nothing is bound. */
void scr_ni_shared_refresh(void) {
  if (ni_shared_bound == 0 || ni_refreshing || scr_ni_bridge_loaded() == NULL) return;
  ni_refreshing = true;
  bool pending = scr_exc_pending();
  ScrCaught *saved = pending ? scr_exc_take() : NULL;
  for (uint32_t i = 0; i < ni_nshared; i++) {
    NiShared *m = &ni_shared[i];
    if (m->nbound == 0) continue;
    ScrDyn *values = ni_shared_values(m);
    if (values == NULL) continue;
    for (uint32_t j = 0; j < m->nslots; j++) {
      if (m->bound[j] == 0) continue;
      ScrDyn *v = scr_dyn_arr_at(values, j);
      if (v == ni_tdz || (m->bound[j] == 1 && m->last[j] != NULL && scr_dyn_strict_eq(v, m->last[j]))) {
        scr_dyn_release(v);
        continue;
      }
      ScrNodeValue nv;
      bool ok = false;
      void *keep = scr_ni_value_out_begin(v, &nv, &ok);
      if (ok) {
        NiPush a = {i, j, &nv};
        scr_ni_on_node_stack(ni_push_job, &a);
      } else {
        scr_exc_clear();
      }
      scr_ni_value_out_end(keep);
      scr_dyn_release(m->last[j]);
      m->last[j] = v;
      m->bound[j] = 1;
    }
    scr_dyn_release(values);
  }
  if (saved != NULL) {
    scr_rethrow(saved);
    scr_caught_release(saved);
  }
  ni_refreshing = false;
}

/* At exit, once Node stopped: everything the export table, the class
 * tables and the shared modules hold (the RC audit counts them). */
void scr_ni_exports_release_all(void) {
  ni_keep_set(NULL);
  for (uint32_t i = 1; i < ni_exports_len; i++) {
    ScrDyn *v = ni_exports[i].value;
    ni_exports[i].value = NULL;
    scr_dyn_release(v);
  }
  ni_exports_len = 1;
  ni_nfree = 0;
  free(ni_ids);
  ni_ids = NULL;
  ni_ids_cap = ni_ids_len = ni_ids_dead = 0;
  for (size_t i = 0; i < ni_nmethods; i++) {
    scr_dyn_release(ni_methods[i].table);
    scr_dyn_release(ni_methods[i].ctor);
  }
  ni_nmethods = 0;
  for (uint32_t i = 0; i < ni_nshared; i++) {
    NiShared *m = &ni_shared[i];
    for (uint32_t j = 0; j < m->nslots; j++) scr_dyn_release(m->last[j]);
    free(m->last);
    free(m->bound);
    scr_str_release(m->path);
    scr_str_release(m->exports);
    scr_dyn_release(m->accessor);
  }
  ni_nshared = 0;
  ni_shared_bound = 0;
  scr_dyn_release(ni_tdz);
  ni_tdz = NULL;
}

#endif

#if !defined(_WIN32) && !defined(__wasi__)
/* ── native classes extending island classes (scope-B NI-5b) ───────────
 * The class is a JavaScript constructor made by the bootstrap's helpers
 * (scr_node_island_host.cjs, module "scriptc:island-helpers"); its
 * constructor, field initializers, methods and accessors are native
 * closures exported into Node, and its instances are island objects. */
static ScrDyn *ni_helpers = NULL;

/* At exit the helpers module is the unit's own reference, not the
 * program's: release it so the reference audit sees only program objects. */
static void ni_helpers_cleanup(void) {
  if (ni_helpers == NULL) return;
  scr_dyn_release(ni_helpers);
  ni_helpers = NULL;
}

static ScrDyn *ni_helper(const char *name, ScrDyn *const *args, size_t argc) {
  if (ni_helpers == NULL) {
    ScrStr *path = scr_str_new("scriptc:island-helpers", 22);
    ni_helpers = scr_ni_require(path);
    scr_str_release(path);
    if (ni_helpers == NULL) return NULL;
    scr_atexit(ni_helpers_cleanup);
  }
  return scr_ni_call_method(ni_helpers, name, strlen(name), args, argc);
}

/* args: a dyn array whose items cross one by one (never as a copy). */
static ScrDyn *ni_helper_spread(const char *name, ScrDyn **lead, size_t nlead, ScrDyn *args) {
  size_t n = args != NULL && args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *small[16];
  ScrDyn **all = nlead + n <= 16 ? small : malloc((nlead + n) * sizeof *all);
  if (all == NULL) ni_export_oom();
  for (size_t i = 0; i < nlead; i++) all[i] = lead[i];
  for (size_t i = 0; i < n; i++) all[nlead + i] = args->v.arr.items[i];
  ScrDyn *r = ni_helper(name, all, nlead + n);
  if (all != small) free(all);
  return r;
}

/* Creates the JavaScript class (base, name, ctor, fields, methods, getters,
 * setters): +1 island handle, or NULL with the error pending. */
ScrDyn *scr_ni_subclass_create(ScrDyn *const *args) {
  return ni_helper("subclass", args, 7);
}

/* NI-5d: before Node has started (the base is a deferred island class's
 * stub), the class is a lazy ref: its name and typeof answer without Node,
 * and the first operation that needs the class creates it
 * (scr_node_island_handle.c, nh_live). */
ScrDyn *scr_node_island_subclass(ScrDyn *base, ScrStr *name, ScrDyn *ctor, ScrDyn *fields,
                                 ScrDyn *methods, ScrDyn *getters, ScrDyn *setters) {
  ScrDyn *n = scr_dyn_new_str(name);
  ScrDyn *args[] = {base, n, ctor, fields, methods, getters, setters};
  ScrDyn *r = scr_ni_bridge_loaded() == NULL ? scr_ni_lazy_subclass_new(args)
                                              : scr_ni_subclass_create(args);
  scr_dyn_release(n);
  return r;
}

ScrDyn *scr_node_island_super_construct(ScrDyn *box, ScrDyn *args) {
  ScrDyn *lead[] = {box};
  return ni_helper_spread("superConstruct", lead, 1, args);
}

ScrDyn *scr_node_island_super_method(ScrDyn *base, ScrDyn *self, ScrStr *name, ScrDyn *args) {
  ScrDyn *n = scr_dyn_new_str(name);
  ScrDyn *lead[] = {base, self, n};
  ScrDyn *r = ni_helper_spread("superMethod", lead, 3, args);
  scr_dyn_release(n);
  return r;
}

void scr_node_island_define_field(ScrDyn *self, ScrStr *key, ScrDyn *value) {
  ScrDyn *k = scr_dyn_new_str(key);
  ScrDyn *args[] = {self, k, value};
  ScrDyn *r = ni_helper("defineField", args, 3);
  scr_dyn_release(k);
  scr_dyn_release(r);
}

/* `value instanceof Error` (or a builtin Error subclass, `name`) for an
 * island value: Node's own answer. False for every other value, which the
 * native test answers. */
bool scr_node_island_instanceof_global(ScrDyn *value, ScrStr *name) {
  if (value == NULL || !scr_ni_is_handle(value)) return false;
  ScrDyn *n = scr_dyn_new_str(name);
  ScrDyn *args[] = {value, n};
  ScrDyn *r = ni_helper("isInstance", args, 2);
  scr_dyn_release(n);
  bool yes = r != NULL && r->kind == SCR_DYN_BOOL && r->v.b;
  scr_dyn_release(r);
  if (scr_exc_pending()) scr_exc_clear();
  return yes;
}

/* util.promisify of an island function: Node's own, in the island. */
ScrDyn *scr_node_island_promisify(ScrDyn *fn) {
  ScrDyn *args[] = {fn};
  return ni_helper("promisify", args, 1);
}
#endif
