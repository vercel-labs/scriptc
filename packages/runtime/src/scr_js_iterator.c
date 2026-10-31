/* %Iterator%, %Iterator.prototype% and %WrapForValidIteratorPrototype%
 * (ES2025 iterator helpers) as live objects, linked only into programs
 * that reach `Iterator` or `Iterator.prototype` as a value.
 *
 * %Iterator.prototype% is an ordinary dictionary-mode object (SCR_DYN_OBJ)
 * whose prototype is Object.prototype. Its helper members are the same
 * interned function values the runtime already answers for a native
 * iterator's, a generator's or a helper object's `map`, `filter`, ...
 * (scr_dyn_iterator_helper_method, scr_json.c), so `g().map ===
 * Iterator.prototype.map` and every receiver runs the one implementation
 * of the helpers (GetIteratorDirect, the lazy stages, IteratorClose).
 * `constructor` is the ES2025 accessor pair with the setter that ignores
 * the prototype itself.
 *
 * %Iterator% is a function value: calling it throws Node's TypeError;
 * `new Iterator()` is lowered to scr_js_iterator_construct, which throws
 * the abstract-class TypeError. Its own properties are `prototype`
 * (non-writable, non-enumerable, non-configurable) and `from`.
 *
 * Iterator.from(O) answers O's iterator (or O itself when O has no
 * Symbol.iterator method) when that object inherits from
 * %Iterator.prototype% (native iterators, generators and helper objects
 * do); otherwise a wrapper object whose prototype is
 * %WrapForValidIteratorPrototype% and whose [[Iterated]] record (the
 * iterator and the next method read once) rides the object's source
 * identity, as the primitive wrappers' slot does (scr_js_wrapper.c). */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static SCR_TL ScrDyn *scr_js_iterator_proto;
static SCR_TL ScrDyn *scr_js_iterator_ctor;
static SCR_TL ScrDyn *scr_js_iterator_wrap_proto;
static SCR_TL bool scr_js_iterator_cleanup_registered;

static void scr_js_iterator_cleanup(void) {
  ScrDyn *proto = scr_js_iterator_proto, *ctor = scr_js_iterator_ctor, *wrap = scr_js_iterator_wrap_proto;
  scr_js_iterator_proto = scr_js_iterator_ctor = scr_js_iterator_wrap_proto = NULL;
  scr_dyn_release(wrap);
  scr_dyn_release(ctor);
  scr_dyn_release(proto);
}

static void scr_js_iterator_type_error(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

/* ECMAScript's "is an Object". */
static bool scr_js_iterator_is_object(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_SYMBOL:
  case SCR_DYN_BIGINT: return false;
  default: return true;
  }
}

/* V8's "<value> is not a function" description (the helpers' wording). */
static void scr_js_iterator_not_callable(const ScrDyn *v) {
  char text[160];
  const char *what = "object";
  switch (v->kind) {
  case SCR_DYN_UNDEF: what = "undefined"; break;
  case SCR_DYN_NULL: what = "object null"; break;
  case SCR_DYN_BOOL: what = v->v.b ? "boolean true" : "boolean false"; break;
  case SCR_DYN_NUM: {
    ScrStr *n = scr_f64_to_scrstr(v->v.num);
    snprintf(text, sizeof text, "number %.*s is not a function", (int)n->len, n->data);
    scr_str_release(n);
    scr_js_iterator_type_error(text);
    return;
  }
  case SCR_DYN_STR:
    snprintf(text, sizeof text, "string \"%.*s\" is not a function", (int)(v->v.str->len > 100 ? 100 : v->v.str->len),
             v->v.str->data);
    scr_js_iterator_type_error(text);
    return;
  case SCR_DYN_SYMBOL: what = "symbol"; break;
  case SCR_DYN_BIGINT: what = "bigint"; break;
  default: break;
  }
  snprintf(text, sizeof text, "%s is not a function", what);
  scr_js_iterator_type_error(text);
}

/* Call(fn, receiver, args). +1, or NULL with the exception pending. */
static ScrDyn *scr_js_iterator_call(const ScrDyn *fn, const ScrDyn *receiver, ScrDyn *const *args, size_t argc,
                                    const char *what) {
  if (!scr_dyn_is_callable(fn)) {
    scr_js_iterator_not_callable(fn);
    return NULL;
  }
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  return result;
}

/* Defines `key` on `object` as a writable, non-enumerable, configurable
 * data property: a builtin prototype member. Consumes value. */
static void scr_js_iterator_define_hidden(ScrDyn *object, const char *key, ScrDyn *value) {
  size_t len = strlen(key);
  scr_dyn_obj_set(object, key, len, value);
  scr_dyn_obj_set_attrs_at(object, scr_dyn_obj_index_of(object, key, len), true, false, true);
}

static ScrDyn *scr_js_iterator_function(ScrDynThunk thunk, uint32_t length, const char *name) {
  return scr_dyn_new_func(scr_closure_new(NULL, 0), thunk, length, "native:iterator", name);
}

/* CreateIteratorResultObject(undefined, true). */
static ScrDyn *scr_js_iterator_done_result(void) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(true));
  return result;
}

/* ── %Iterator% ─────────────────────────────────────────────────────── */

static ScrDyn *scr_js_iterator_ctor_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  scr_js_iterator_type_error("Constructor Iterator requires 'new'");
  return NULL;
}

ScrDyn *scr_js_iterator_construct(void) {
  scr_js_iterator_type_error("Abstract class Iterator not directly constructable");
  return NULL;
}

/* ── %Iterator.prototype%.constructor ───────────────────────────────── */

static ScrDyn *scr_js_iterator_constructor_get(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  return scr_dyn_retain(scr_js_iterator_ctor);
}

/* SetterThatIgnoresPrototypeProperties(this, %Iterator.prototype%, p, v). */
static ScrDyn *scr_js_iterator_constructor_set(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *value = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrDyn *result = NULL;
  if (!scr_js_iterator_is_object(self)) {
    scr_js_iterator_type_error("Iterator.prototype.constructor setter called on non-object");
  } else if (self == scr_js_iterator_proto) {
    scr_js_iterator_type_error("Cannot assign to read only property 'constructor' of object '[object Iterator]'");
  } else if (self->kind == SCR_DYN_OBJ && !scr_dyn_obj_get(self, "constructor", 11)) {
    /* CreateDataPropertyOrThrow: an enumerable, writable, configurable data
     * property, created even though the chain holds the accessor. */
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
    scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
    scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    ScrStr *name = scr_str_new("constructor", 11);
    ScrDyn *key = scr_dyn_new_str(name);
    scr_str_release(name);
    ScrDyn *defined = scr_dyn_define_property(self, key, descriptor);
    scr_dyn_release(defined);
    scr_dyn_release(key);
    scr_dyn_release(descriptor);
    if (!scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
  } else {
    ScrStr *name = scr_str_new("constructor", 11);
    scr_dyn_key_set(self, name, value);
    scr_str_release(name);
    if (!scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
  }
  scr_dyn_release(self);
  return result;
}

/* %Iterator.prototype%[@@iterator]: the receiver itself. */
static ScrDyn *scr_js_iterator_self(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  return scr_dyn_this_get();
}

/* %Iterator.prototype%[@@dispose]: calls the receiver's return method when
 * it has one; answers undefined. */
static ScrDyn *scr_js_iterator_dispose(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *method = scr_dyn_iterator_result_get(self, "return", 6);
  ScrDyn *result = NULL;
  if (method) {
    if (method->kind == SCR_DYN_UNDEF || method->kind == SCR_DYN_NULL) result = scr_dyn_retain(scr_dyn_undefined());
    else {
      ScrDyn *returned = scr_js_iterator_call(method, self, NULL, 0, "return");
      if (returned) {
        scr_dyn_release(returned);
        result = scr_dyn_retain(scr_dyn_undefined());
      }
    }
    scr_dyn_release(method);
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_js_iterator_tag_get(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  ScrStr *tag = scr_str_new("Iterator", 8);
  ScrDyn *result = scr_dyn_new_str(tag);
  scr_str_release(tag);
  return result;
}

/* SetterThatIgnoresPrototypeProperties for Symbol.toStringTag. */
static ScrDyn *scr_js_iterator_tag_set(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *value = argc > 0 ? args[0] : scr_dyn_undefined();
  ScrDyn *result = NULL;
  ScrStr *name = scr_str_new("toStringTag", 11);
  ScrSym *symbol = scr_sym_well_known(name);
  scr_str_release(name);
  ScrDyn *key = scr_dyn_new_symbol(symbol);
  scr_sym_release(symbol);
  if (!scr_js_iterator_is_object(self)) {
    scr_js_iterator_type_error("Iterator.prototype[Symbol.toStringTag] setter called on non-object");
  } else if (self == scr_js_iterator_proto) {
    scr_js_iterator_type_error(
        "Cannot assign to read only property 'Symbol(Symbol.toStringTag)' of object '[object Iterator]'");
  } else {
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
    scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
    scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    scr_dyn_release(scr_dyn_define_property(self, key, descriptor));
    scr_dyn_release(descriptor);
    if (!scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
  }
  scr_dyn_release(key);
  scr_dyn_release(self);
  return result;
}

/* Defines a well-known-symbol-keyed member of %Iterator.prototype%: a
 * writable data property (`getter` NULL) or an accessor pair, both
 * non-enumerable and configurable. Consumes the function values. */
static void scr_js_iterator_define_symbol(ScrDyn *proto, const char *name, ScrDyn *value, ScrDyn *getter,
                                          ScrDyn *setter) {
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrSym *symbol = scr_sym_well_known(text);
  scr_str_release(text);
  ScrDyn *key = scr_dyn_new_symbol(symbol);
  scr_sym_release(symbol);
  ScrDyn *descriptor = scr_dyn_new_obj();
  if (value) {
    scr_dyn_obj_set(descriptor, "value", 5, value);
    scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  } else {
    scr_dyn_obj_set(descriptor, "get", 3, getter);
    scr_dyn_obj_set(descriptor, "set", 3, setter);
  }
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_release(scr_dyn_define_property(proto, key, descriptor));
  scr_dyn_release(descriptor);
  scr_dyn_release(key);
}

/* Node's `length` of each helper, in Node's own key order. */
static const struct { const char *name; uint32_t length; } scr_js_iterator_helpers[] = {
  {"reduce", 1}, {"toArray", 0}, {"forEach", 1}, {"some", 1}, {"every", 1}, {"find", 1},
  {"map", 1},    {"filter", 1},  {"take", 1},    {"drop", 1}, {"flatMap", 1},
};

static ScrDyn *scr_js_iterator_from_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  return scr_js_iterator_from(argc > 0 ? args[0] : scr_dyn_undefined());
}

static void scr_js_iterator_build(void) {
  if (scr_js_iterator_proto) return;
  if (!scr_js_iterator_cleanup_registered) {
    scr_js_iterator_cleanup_registered = true;
    scr_atexit(scr_js_iterator_cleanup);
  }
  ScrDyn *proto = scr_dyn_new_obj();
  scr_js_iterator_proto = proto;
  ScrDyn *ctor = scr_js_iterator_function(scr_js_iterator_ctor_call, 0, "Iterator");
  scr_js_iterator_ctor = ctor;
  /* The constructor's property table takes its own reference. */
  scr_dyn_fn_seed_prototype(ctor, scr_dyn_retain(proto));
  ScrDyn *table = scr_dyn_function_properties(ctor);
  scr_js_iterator_define_hidden(table, "from", scr_js_iterator_function(scr_js_iterator_from_call, 1, "from"));
  scr_dyn_release(table);

  scr_dyn_obj_set_accessor(proto, "constructor", 11,
                           scr_js_iterator_function(scr_js_iterator_constructor_get, 0, "get constructor"),
                           scr_js_iterator_function(scr_js_iterator_constructor_set, 1, "set constructor"));
  scr_dyn_obj_set_attrs_at(proto, scr_dyn_obj_index_of(proto, "constructor", 11), false, false, true);
  for (size_t i = 0; i < sizeof scr_js_iterator_helpers / sizeof scr_js_iterator_helpers[0]; i++) {
    const char *name = scr_js_iterator_helpers[i].name;
    ScrStr *text = scr_str_new(name, strlen(name));
    ScrDyn *method = scr_dyn_iterator_helper_method(text);
    scr_str_release(text);
    /* The interned helper value is the one every iterator answers; it is
     * made with length 0, so give it Node's length here. */
    if (method->kind == SCR_DYN_FUNC) method->v.fn.arity = scr_js_iterator_helpers[i].length;
    scr_js_iterator_define_hidden(proto, name, method);
  }
  scr_js_iterator_define_symbol(proto, "iterator", scr_js_iterator_function(scr_js_iterator_self, 0, "[Symbol.iterator]"),
                                NULL, NULL);
  scr_js_iterator_define_symbol(proto, "toStringTag", NULL,
                                scr_js_iterator_function(scr_js_iterator_tag_get, 0, "get [Symbol.toStringTag]"),
                                scr_js_iterator_function(scr_js_iterator_tag_set, 1, "set [Symbol.toStringTag]"));
  scr_js_iterator_define_symbol(proto, "dispose", scr_js_iterator_function(scr_js_iterator_dispose, 0, "[Symbol.dispose]"),
                                NULL, NULL);
}

ScrDyn *scr_js_iterator_prototype(void) {
  scr_js_iterator_build();
  return scr_dyn_retain(scr_js_iterator_proto);
}

ScrDyn *scr_js_iterator_constructor(void) {
  scr_js_iterator_build();
  return scr_dyn_retain(scr_js_iterator_ctor);
}

/* OrdinaryHasInstance(%Iterator%, value): the builtin iterators inherit
 * from %Iterator.prototype% (native iterators, helper objects and
 * synchronous generators), and so does any object whose chain reaches it. */
bool scr_js_iterator_instance_of(ScrDyn *value) {
  if (value->kind == SCR_DYN_HANDLE &&
      (value->v.handle.tag == SCR_DYNH_ITERATOR || value->v.handle.tag == SCR_DYNH_ITERATOR_HELPER))
    return true;
  if (scr_dyn_iterates_by_protocol(value)) return true;
  if (!scr_js_iterator_proto) return false;
  /* A compiled class instance: its view's prototype chain (an iterator
   * subclass's prototype data inherits from %Iterator.prototype%). */
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    bool found = false;
    if (view && !scr_exc_pending())
      for (const ScrDyn *current = view->prototype; current && !found; current = current->prototype)
        found = current == scr_js_iterator_proto;
    scr_dyn_release(view);
    return found;
  }
  for (const ScrDyn *current = value->prototype; current; current = current->prototype)
    if (current == scr_js_iterator_proto) return true;
  return false;
}

/* ── %WrapForValidIteratorPrototype% ────────────────────────────────── */

typedef struct ScrJsIteratorRecord {
  size_t rc;
  ScrDyn *iterator; /* owned */
  ScrDyn *next;     /* owned: the next method, read once */
  ScrDyn *object;   /* borrowed: the wrapper that owns this record */
} ScrJsIteratorRecord;

static void *scr_js_iterator_record_retain(void *p) {
  ((ScrJsIteratorRecord *)p)->rc++;
  return p;
}

static ScrDyn *scr_js_iterator_record_access(void *p, bool materialize) {
  ScrJsIteratorRecord *record = p;
  if (materialize) return scr_dyn_retain(record->object);
  if (--record->rc == 0) {
    scr_dyn_release(record->next);
    scr_dyn_release(record->iterator);
    free(record);
  }
  return NULL;
}

/* The [[Iterated]] record of a wrapper (+1), or NULL with the receiver
 * TypeError pending. */
static ScrJsIteratorRecord *scr_js_iterator_record_of(const ScrDyn *self, const char *method) {
  ScrJsIteratorRecord *record =
      self->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_source_cast(self, scr_js_iterator_record_access, scr_js_iterator_record_retain)
          : NULL;
  if (!record) {
    char text[128];
    snprintf(text, sizeof text, "Method %s called on incompatible receiver", method);
    scr_js_iterator_type_error(text);
  }
  return record;
}

static ScrDyn *scr_js_iterator_wrap_next(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrJsIteratorRecord *record = scr_js_iterator_record_of(self, "WrapForValidIteratorPrototype.next");
  scr_dyn_release(self);
  if (!record) return NULL;
  ScrDyn *result = scr_js_iterator_call(record->next, record->iterator, NULL, 0, "next");
  scr_js_iterator_record_access(record, false);
  return result;
}

static ScrDyn *scr_js_iterator_wrap_return(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  ScrDyn *self = scr_dyn_this_get();
  ScrJsIteratorRecord *record = scr_js_iterator_record_of(self, "WrapForValidIteratorPrototype.return");
  scr_dyn_release(self);
  if (!record) return NULL;
  ScrDyn *result = NULL;
  ScrDyn *method = scr_dyn_iterator_result_get(record->iterator, "return", 6);
  if (method) {
    if (method->kind == SCR_DYN_UNDEF || method->kind == SCR_DYN_NULL) result = scr_js_iterator_done_result();
    else result = scr_js_iterator_call(method, record->iterator, NULL, 0, "return");
    scr_dyn_release(method);
  }
  scr_js_iterator_record_access(record, false);
  return result;
}

static ScrDyn *scr_js_iterator_wrap_prototype(void) {
  if (scr_js_iterator_wrap_proto) return scr_js_iterator_wrap_proto;
  ScrDyn *wrap = scr_dyn_obj_create(scr_js_iterator_proto);
  scr_js_iterator_define_hidden(wrap, "next", scr_js_iterator_function(scr_js_iterator_wrap_next, 0, "next"));
  scr_js_iterator_define_hidden(wrap, "return", scr_js_iterator_function(scr_js_iterator_wrap_return, 0, "return"));
  scr_js_iterator_wrap_proto = wrap;
  return wrap;
}

/* Iterator.from(value): GetIteratorFlattenable(value, iterate-string-
 * primitives), then the iterator itself when it inherits from
 * %Iterator.prototype%, else a wrapper. +1, or NULL with the exception
 * pending. Borrows value. */
ScrDyn *scr_js_iterator_from(ScrDyn *value) {
  scr_js_iterator_build();
  if (!scr_js_iterator_is_object(value) && value->kind != SCR_DYN_STR) {
    scr_js_iterator_type_error("Iterator.from called on non-object");
    return NULL;
  }
  /* GetMethod(value, @@iterator), and its result when it has one (which
   * must be an object); otherwise the value itself. */
  ScrDyn *iterator = scr_dyn_iterator_optional(value);
  if (!iterator) {
    if (scr_exc_pending()) return NULL;
    iterator = scr_dyn_retain(value);
  }
  /* The builtin iterators inherit from %Iterator.prototype%; their next
   * method is not observable, so it is not read here. */
  if (value->kind != SCR_DYN_STR && iterator->kind == SCR_DYN_HANDLE &&
      (iterator->v.handle.tag == SCR_DYNH_ITERATOR || iterator->v.handle.tag == SCR_DYNH_ITERATOR_HELPER))
    return iterator;
  if (scr_dyn_iterates_by_protocol(iterator)) return iterator;
  if (value->kind == SCR_DYN_STR && iterator->kind == SCR_DYN_HANDLE) return iterator;
  /* GetIteratorDirect: next is read once, now. */
  ScrDyn *next = scr_dyn_iterator_result_get(iterator, "next", 4);
  if (!next) {
    scr_dyn_release(iterator);
    return NULL;
  }
  if (scr_js_iterator_instance_of(iterator)) {
    scr_dyn_release(next);
    return iterator;
  }
  ScrJsIteratorRecord *record = malloc(sizeof *record);
  if (!record) scr_trap("scriptc: out of memory\n");
  *record = (ScrJsIteratorRecord){ 0, iterator, next, NULL };
  ScrDyn *object = scr_dyn_new_obj_with_identity(record, scr_js_iterator_record_retain, scr_js_iterator_record_access);
  record->object = object;
  object->prototype = scr_dyn_retain(scr_js_iterator_wrap_prototype());
  return object;
}
