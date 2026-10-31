/* Keyed collections in the checked-dynamic tier: the %Set.prototype%,
 * %Map.prototype%, %WeakMap.prototype% and %WeakSet.prototype% objects, the
 * brand-checked method values that make `Map.prototype.get.call([], 1)`,
 * `w.get.call(new Set(), 1)` and `m.forEach(1)` throw Node's TypeErrors, the
 * constructors' adder lookup (`Map ( [ iterable ] )` calls a program's own
 * `set`), Map's dynamic-callback forEach, and Set's ES2025 compositions
 * (union/intersection/difference/symmetricDifference/isSubsetOf/
 * isSupersetOf/isDisjointFrom) over an arbitrary set-like argument.
 *
 * One table drives every class (ScrCollectionClass): the prototype's member
 * list, the constructor's adder name and whether the class carries `size`
 * and iteration. The storage itself stays in the handle ops of scr_json.c
 * (Set, Map, WeakMap, WeakSet), so a member call delegates through
 * scr_dyn_invoke to the one implementation that already exists.
 *
 * The compiler emits the entries only from JavaScript sources, and only on
 * paths whose statically typed lowering refuses (a set-like argument, a
 * non-callable callback, `<Class>.prototype` as a value). Typed programs keep
 * their own lowering and never link this unit. */
#include "scr_runtime.h"

#include <math.h>
#include <string.h>

/* ── object kinds ─────────────────────────────────────────────────────── */

/* An ECMAScript Object: everything except the primitive kinds. */
static bool scr_set_is_object(const ScrDyn *v) {
  switch (v->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_FUNC:
  case SCR_DYN_HANDLE:
  case SCR_DYN_TYPED_REF:
  case SCR_DYN_PROMISE:
  case SCR_DYN_BYTES:
  case SCR_DYN_PROXY:
    return true;
  default:
    return false;
  }
}

/* ── the collection classes ───────────────────────────────────────────── */

/* One row per keyed collection the dynamic tier can hold. `members` are the
 * prototype's own function-valued data properties (the prototype builder adds
 * the `size` accessor, Symbol.iterator, Symbol.toStringTag and constructor);
 * `adder` is the member the constructor reads off the new collection
 * (through the prototype, with the collection as the getter's `this`) and
 * calls per iterated value. The storage of every class lives in its handle
 * ops (scr_json.c), so a member call delegates through scr_dyn_invoke. */
typedef struct {
  const char *klass;
  const char *adder;
  bool is_map;   /* entries carry a value (Map, WeakMap) */
  bool iterable; /* keys/values/entries and Symbol.iterator (Set, Map) */
  const char *const *members;
  size_t member_count;
} ScrCollectionClass;

/* The member lists are in Node's creation order, and name the `size`
 * accessor in its position, so Object.getOwnPropertyNames of the built
 * prototype enumerates the class's members in the order Node defines them. */
static const char *const scr_set_members[] = {
    "has",        "add",        "delete",     "clear",     "entries",
    "forEach",    "size",       "values",     "keys",      "union",
    "intersection", "difference", "symmetricDifference", "isSubsetOf",
    "isSupersetOf", "isDisjointFrom",
};

static const char *const scr_map_members[] = {
    "get", "set", "has", "delete", "clear", "entries", "forEach", "keys", "size", "values",
};

static const char *const scr_weak_map_members[] = {"delete", "get", "set", "has"};
static const char *const scr_weak_set_members[] = {"delete", "has", "add"};

#define SCR_COLLECTION_ROW_COUNT(a) (sizeof a / sizeof a[0])

static const ScrCollectionClass scr_collection_classes[] = {
    {"Set", "add", false, true, scr_set_members,
     SCR_COLLECTION_ROW_COUNT(scr_set_members)},
    {"Map", "set", true, true, scr_map_members,
     SCR_COLLECTION_ROW_COUNT(scr_map_members)},
    {"WeakMap", "set", true, false, scr_weak_map_members,
     SCR_COLLECTION_ROW_COUNT(scr_weak_map_members)},
    {"WeakSet", "add", false, false, scr_weak_set_members,
     SCR_COLLECTION_ROW_COUNT(scr_weak_set_members)},
};

#define SCR_COLLECTION_CLASS_COUNT \
  (sizeof scr_collection_classes / sizeof scr_collection_classes[0])

static const ScrCollectionClass *scr_collection_class(const char *klass) {
  for (size_t i = 0; i < SCR_COLLECTION_CLASS_COUNT; i++)
    if (!strcmp(scr_collection_classes[i].klass, klass)) return &scr_collection_classes[i];
  return NULL;
}

/* The class of the collection HANDLE `value` holds, or NULL for anything
 * else (a plain object, a primitive, another handle kind). */
static const ScrCollectionClass *scr_collection_class_of(const ScrDyn *value) {
  if (!value || value->kind != SCR_DYN_HANDLE) return NULL;
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(value);
  if (!ops || !ops->cls) return NULL;
  return scr_collection_class(ops->cls);
}

/* The brand check: a real collection of exactly this class. */
static bool scr_collection_is(const ScrDyn *value, const ScrCollectionClass *cls) {
  return value && value->kind == SCR_DYN_HANDLE && cls != NULL &&
         scr_collection_class_of(value) == cls;
}

/* %Set.prototype%, %Map.prototype%, %WeakMap.prototype% and
 * %WeakSet.prototype%, created on first use (the object section below). */
static SCR_TL ScrDyn *scr_collection_prototypes[SCR_COLLECTION_CLASS_COUNT];

/* A property read the set-like protocol makes on a value that may be a
 * native Set or Map HANDLE (`set.size`, `set.has`), a compiled generator
 * (a typed capsule whose `next` lives in the generator tables) or an
 * ordinary object: the same dispatch the compiled keyed read performs.
 * +1, or NULL with an exception pending. */
static ScrDyn *scr_set_prop(const ScrDyn *object, const char *key) {
  size_t len = strlen(key);
  if (object->kind == SCR_DYN_TYPED_REF) {
    ScrStr *name = scr_str_new(key, len);
    ScrDyn *fast = scr_dyn_typed_ref_key_get(object, name);
    scr_str_release(name);
    if (fast) return fast;
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    if (!view) return NULL;
    ScrDyn *out = scr_set_prop(view, key);
    scr_dyn_release_v(view);
    return out;
  }
  if (object->kind == SCR_DYN_HANDLE || object->kind == SCR_DYN_PROXY ||
      object->kind == SCR_DYN_PROMISE) {
    ScrStr *name = scr_str_new(key, len);
    ScrDyn *out = object->kind == SCR_DYN_HANDLE
      ? scr_dyn_handle_key_get(object, name)
      : object->kind == SCR_DYN_PROXY
        ? scr_dyn_proxy_get(object, name)
        : scr_dyn_promise_key_get(object, name);
    scr_str_release(name);
    return out;
  }
  if (object->kind == SCR_DYN_FUNC) {
    ScrDyn *out = scr_dyn_fn_get(object, key, len);
    return out ? out : scr_dyn_retain(scr_dyn_undefined());
  }
  return scr_dyn_obj_read(object, key, len);
}

/* V8's rendering of a receiver in a brand-check message: an ordinary
 * object or a native handle names its class (`#<Object>`, `#<Set>`,
 * `#<Map>` — a toStringTag does not enter it), every other value its
 * String() form. */
static void scr_set_put_receiver(ScrJsonBuf *message, const ScrDyn *receiver) {
  const char *cls = NULL;
  if (receiver->kind == SCR_DYN_OBJ) {
    cls = "Object";
    for (size_t i = 0; i < SCR_COLLECTION_CLASS_COUNT; i++)
      if (scr_collection_prototypes[i] && receiver == scr_collection_prototypes[i])
        cls = scr_collection_classes[i].klass;
  } else if (receiver->kind == SCR_DYN_HANDLE) {
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(receiver);
    cls = ops && ops->cls ? ops->cls : "Object";
  }
  if (cls) {
    scr_jb_puts(message, "#<");
    scr_jb_puts(message, cls);
    scr_jb_puts(message, ">");
    return;
  }
  ScrStr *shown = scr_dyn_string_coerce_js(receiver);
  if (shown) {
    scr_jb_put_str(message, shown);
    scr_str_release(shown);
  }
}

/* `Method <Class>.prototype.<name> called on incompatible receiver <value>`. */
static ScrDyn *scr_set_incompatible(const ScrCollectionClass *cls, const char *name,
                                    const ScrDyn *receiver) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "Method ");
  scr_jb_puts(&message, cls->klass);
  scr_jb_puts(&message, ".prototype.");
  scr_jb_puts(&message, name);
  scr_jb_puts(&message, " called on incompatible receiver ");
  scr_set_put_receiver(&message, receiver);
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

/* CanonicalizeKeyedCollectionKey: -0 is stored as +0. */
static ScrDyn *scr_set_canonical(const ScrDyn *value) {
  if (value->kind == SCR_DYN_NUM && value->v.num == 0) return scr_dyn_new_num(0);
  return scr_dyn_retain((ScrDyn *)value);
}

/* ── scratch set data ─────────────────────────────────────────────────── */

static ScrMap *scr_set_scratch(void) {
  return scr_map_new(SCR_MAP_KEY_DYN, SCR_MAP_VAL_F64, &scr_map_dyn_set_ops);
}

static void scr_set_add(ScrMap *data, const ScrDyn *value) {
  scr_map_dyn_set(data, value, NULL, true);
}

static bool scr_set_has(const ScrMap *data, const ScrDyn *value) {
  return scr_map_dyn_has((ScrMap *)data, value, false);
}

static void scr_set_remove(ScrMap *data, const ScrDyn *value) {
  (void)scr_map_dyn_has(data, value, true);
}

static ScrMap *scr_set_copy(const ScrMap *source) {
  ScrMap *out = scr_set_scratch();
  scr_map_iter_enter((ScrMap *)source);
  for (double i = 0; i < scr_map_iter_count(source); i++) {
    if (!scr_map_iter_live(source, i)) continue;
    ScrDyn *key = scr_map_dyn_key(source, i);
    scr_set_add(out, key);
    scr_dyn_release(key);
  }
  scr_map_iter_exit((ScrMap *)source);
  return out;
}

/* The algorithm's result: an ordinary Set over the scratch data. */
static ScrDyn *scr_set_result(ScrMap *data) {
  ScrDyn *result = scr_dyn_native_set(data);
  scr_map_release(data);
  return result;
}

/* ── GetSetRecord ─────────────────────────────────────────────────────── */

typedef struct {
  ScrDyn *object; /* owned */
  double size;    /* [[Size]], ToIntegerOrInfinity of ToNumber(size) */
  ScrDyn *has;    /* owned */
  ScrDyn *keys;   /* owned */
} ScrSetRecord;

static void scr_set_record_release(ScrSetRecord *record) {
  scr_dyn_release(record->has);
  scr_dyn_release(record->keys);
  scr_dyn_release(record->object);
  memset(record, 0, sizeof *record);
}

/* The interned function value of one Set/Map prototype method (the value
 * `set.has` reads). +1, or NULL with an exception pending. */
static ScrDyn *scr_set_builtin_method(const char *klass, const char *name) {
  ScrStr *prototype = scr_str_new(klass, strlen(klass));
  ScrStr *method = scr_str_new(name, strlen(name));
  ScrDyn *value = scr_dyn_builtin_method(prototype, method);
  scr_str_release(prototype);
  scr_str_release(method);
  return value;
}

/* GetSetRecord(other) with Node's error texts; false with an exception
 * pending. */
static bool scr_set_record(const char *name, ScrDyn *other, ScrSetRecord *record) {
  memset(record, 0, sizeof *record);
  if (!scr_set_is_object(other)) {
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "Set.prototype.");
    scr_jb_puts(&message, name);
    scr_jb_puts(&message, " argument must be an object");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return false;
  }
  record->object = scr_dyn_retain(other);
  /* A native Set or Map keeps its members in internal slots: the handle's
   * plain property read answers size but refuses the method VALUES
   * ("Native Set method values have no lowering"), so the record takes the
   * interned per-name functions — the same values `set.has` reads — and
   * the collection's size. (A handle cannot carry own overrides, so the
   * property reads the spec spells would answer these anyway.) */
  if (scr_dyn_native_set_is(other) || scr_dyn_native_map_is(other)) {
    const char *klass = scr_dyn_native_set_is(other) ? "Set" : "Map";
    record->size = scr_map_size((ScrMap *)other->v.handle.ptr);
    record->has = scr_set_builtin_method(klass, "has");
    record->keys = scr_set_builtin_method(klass, "keys");
    if (!record->has || !record->keys) {
      scr_set_record_release(record);
      return false;
    }
    return true;
  }
  ScrDyn *raw_size = scr_set_prop(other, "size");
  if (!raw_size) {
    scr_set_record_release(record);
    return false;
  }
  double number_size;
  bool coerced = scr_dyn_number_coerce_js(raw_size, &number_size);
  if (!coerced || scr_exc_pending()) {
    scr_dyn_release(raw_size);
    scr_set_record_release(record);
    return false;
  }
  if (isnan(number_size)) {
    scr_dyn_release(raw_size);
    scr_set_record_release(record);
    static const char message[] = "The .size property is NaN";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  double int_size = isinf(number_size) ? number_size : trunc(number_size);
  if (int_size < 0) {
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "'");
    scr_jb_put_f64(&message, int_size);
    scr_jb_puts(&message, "' is an invalid size");
    scr_dyn_release(raw_size);
    scr_set_record_release(record);
    scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&message));
    return false;
  }
  scr_dyn_release(raw_size);
  record->size = int_size;
  record->has = scr_set_prop(other, "has");
  if (!record->has) {
    scr_set_record_release(record);
    return false;
  }
  if (!scr_dyn_is_callable(record->has)) {
    /* V8 reports the property NAME as the non-callable value here. */
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "string \"has\" is not a function");
    scr_set_record_release(record);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return false;
  }
  record->keys = scr_set_prop(other, "keys");
  if (!record->keys) {
    scr_set_record_release(record);
    return false;
  }
  if (!scr_dyn_is_callable(record->keys)) {
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "string \"keys\" is not a function");
    scr_set_record_release(record);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return false;
  }
  return true;
}

/* Call(record.[[Has]], record.[[SetObject]], « value ») as a boolean. */
static int scr_set_record_has(ScrSetRecord *record, ScrDyn *value, bool *out) {
  scr_dyn_this_push_dyn(record->object);
  ScrDyn *result = scr_dyn_call(record->has, &value, 1, "has");
  scr_dyn_this_pop();
  if (!result) return 0;
  *out = scr_dyn_truthy(result);
  scr_dyn_release(result);
  return 1;
}

/* ── the keys iterator ────────────────────────────────────────────────── */

typedef struct {
  ScrDyn *iterator; /* owned */
  ScrDyn *next;     /* owned */
} ScrSetIterator;

static void scr_set_iterator_release(ScrSetIterator *iter) {
  scr_dyn_release(iter->next);
  scr_dyn_release(iter->iterator);
  memset(iter, 0, sizeof *iter);
}

/* GetIteratorFromMethod(record.[[SetObject]], record.[[Keys]]). */
static bool scr_set_iterator_open(ScrSetRecord *record, ScrSetIterator *iter) {
  memset(iter, 0, sizeof *iter);
  scr_dyn_this_push_dyn(record->object);
  ScrDyn *iterator = scr_dyn_call(record->keys, NULL, 0, "keys");
  scr_dyn_this_pop();
  if (!iterator) return false;
  if (!scr_set_is_object(iterator)) {
    scr_dyn_release(iterator);
    static const char message[] = "Result of the keys method is not an object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return false;
  }
  ScrDyn *next = scr_set_prop(iterator, "next");
  if (!next) {
    scr_dyn_release(iterator);
    return false;
  }
  iter->iterator = iterator;
  iter->next = next;
  return true;
}

/* IteratorStepValue: 1 with *value owned, 0 at the end, -1 with an
 * exception pending. */
static int scr_set_iterator_step(ScrSetIterator *iter, ScrDyn **value) {
  *value = NULL;
  scr_dyn_this_push_dyn(iter->iterator);
  ScrDyn *result = scr_dyn_call(iter->next, NULL, 0, "next");
  scr_dyn_this_pop();
  if (!result) return -1;
  if (!scr_set_is_object(result)) {
    scr_dyn_release(result);
    static const char message[] = "Iterator result is not an object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return -1;
  }
  ScrDyn *done = scr_set_prop(result, "done");
  if (!done) {
    scr_dyn_release(result);
    return -1;
  }
  bool finished = scr_dyn_truthy(done);
  scr_dyn_release(done);
  if (finished) {
    scr_dyn_release(result);
    return 0;
  }
  ScrDyn *item = scr_set_prop(result, "value");
  scr_dyn_release(result);
  if (!item) return -1;
  *value = item;
  return 1;
}

static void scr_set_throw_not_callable(ScrDyn *value);

/* IteratorClose(iterator, NormalCompletion(empty)): a `return` of null or
 * undefined finishes the close, any other value must be callable, the call's
 * result must be an object, and a throw from the read or the call
 * propagates. false with the exception pending. */
static bool scr_set_iterator_close(ScrSetIterator *iter) {
  ScrDyn *closer = scr_set_prop(iter->iterator, "return");
  if (!closer) return false;
  bool closed = true;
  if (closer->kind != SCR_DYN_UNDEF && closer->kind != SCR_DYN_NULL) {
    if (!scr_dyn_is_callable(closer)) {
      scr_set_throw_not_callable(closer);
      closed = false;
    } else {
      scr_dyn_this_push_dyn(iter->iterator);
      ScrDyn *result = scr_dyn_call(closer, NULL, 0, "return");
      scr_dyn_this_pop();
      if (!result) closed = false;
      else {
        if (!scr_set_is_object(result)) {
          static const char message[] = "return called on non-object";
          scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
          closed = false;
        }
        scr_dyn_release(result);
      }
    }
  }
  scr_dyn_release(closer);
  return closed;
}

/* ── the ES2025 compositions ──────────────────────────────────────────── */

static const char *const scr_set_combine_names[] = {
    "union", "intersection", "difference", "symmetricDifference",
    "isSubsetOf", "isSupersetOf", "isDisjointFrom",
};

static bool scr_set_is_combine(const char *name) {
  for (size_t i = 0; i < sizeof scr_set_combine_names / sizeof scr_set_combine_names[0]; i++)
    if (!strcmp(scr_set_combine_names[i], name)) return true;
  return false;
}

/* Walks a set's entries in insertion order, re-reading the entry count every
 * step: entries appended during the walk are visited and removals leave
 * tombstones the walk skips. intersection, isSubsetOf and isDisjointFrom walk
 * the receiver live, because `has` may mutate it; difference walks its own
 * copy, whose visit removes the entries `has` rules out. */
typedef int (*ScrSetVisit)(void *context, ScrDyn *entry);

static int scr_set_walk_this(ScrMap *set, ScrSetVisit visit, void *context) {
  scr_map_iter_enter(set);
  for (double i = 0; i < scr_map_iter_count(set); i++) {
    if (!scr_map_iter_live(set, i)) continue;
    ScrDyn *entry = scr_map_dyn_key(set, i);
    int status = visit(context, entry);
    scr_dyn_release(entry);
    if (status <= 0) {
      scr_map_iter_exit(set);
      return status;
    }
  }
  scr_map_iter_exit(set);
  return 1;
}

/* Walks the set-like's keys, handing each canonicalized value to `visit`;
 * 1 = finished, 0 = stopped by the visitor, -1 = exception pending. */
typedef int (*ScrSetKeyVisit)(void *context, ScrDyn *value);

static int scr_set_walk_keys(ScrSetRecord *record, ScrSetIterator *iter, ScrSetKeyVisit visit,
                             void *context) {
  for (;;) {
    ScrDyn *value = NULL;
    int status = scr_set_iterator_step(iter, &value);
    if (status < 0) return -1;
    if (status == 0) return 1;
    ScrDyn *canonical = scr_set_canonical(value);
    scr_dyn_release(value);
    if (!canonical) return -1;
    int stopped = visit(context, canonical);
    scr_dyn_release(canonical);
    if (stopped < 0) return -1;
    if (stopped == 0) return 0;
  }
}

typedef struct {
  ScrMap *data;
} ScrSetAddContext;

static int scr_set_union_visit(void *context, ScrDyn *value) {
  ScrSetAddContext *add = context;
  if (!scr_set_has(add->data, value)) scr_set_add(add->data, value);
  return 1;
}

typedef struct {
  ScrSetRecord *record;
  ScrMap *data;
  ScrMap *set;
  int status; /* 0 = predicate answered false */
} ScrSetHasContext;

static int scr_set_intersection_has_visit(void *context, ScrDyn *entry) {
  ScrSetHasContext *state = context;
  bool in_other;
  if (!scr_set_record_has(state->record, entry, &in_other)) return -1;
  if (in_other && !scr_set_has(state->data, entry)) scr_set_add(state->data, entry);
  return 1;
}

static int scr_set_intersection_key_visit(void *context, ScrDyn *value) {
  ScrSetHasContext *state = context;
  if (scr_set_has(state->set, value) && !scr_set_has(state->data, value))
    scr_set_add(state->data, value);
  return 1;
}

static int scr_set_difference_has_visit(void *context, ScrDyn *entry) {
  ScrSetHasContext *state = context;
  bool in_other;
  if (!scr_set_record_has(state->record, entry, &in_other)) return -1;
  if (in_other) scr_set_remove(state->data, entry);
  return 1;
}

static int scr_set_difference_key_visit(void *context, ScrDyn *value) {
  ScrSetHasContext *state = context;
  if (scr_set_has(state->data, value)) scr_set_remove(state->data, value);
  return 1;
}

static int scr_set_symmetric_visit(void *context, ScrDyn *value) {
  ScrSetHasContext *state = context;
  if (scr_set_has(state->set, value)) scr_set_remove(state->data, value);
  else if (!scr_set_has(state->data, value)) scr_set_add(state->data, value);
  return 1;
}

static int scr_set_subset_visit(void *context, ScrDyn *entry) {
  ScrSetHasContext *state = context;
  bool in_other;
  if (!scr_set_record_has(state->record, entry, &in_other)) return -1;
  if (!in_other) {
    state->status = 0;
    return 0;
  }
  return 1;
}

/* isDisjointFrom's receiver walk: the first member the set-like has ends it. */
static int scr_set_disjoint_this_visit(void *context, ScrDyn *entry) {
  ScrSetHasContext *state = context;
  bool in_other;
  if (!scr_set_record_has(state->record, entry, &in_other)) return -1;
  if (in_other) {
    state->status = 0;
    return 0;
  }
  return 1;
}

static int scr_set_superset_visit(void *context, ScrDyn *value) {
  ScrSetHasContext *state = context;
  if (!scr_set_has(state->set, value)) {
    state->status = 0;
    return 0;
  }
  return 1;
}

static int scr_set_disjoint_visit(void *context, ScrDyn *value) {
  ScrSetHasContext *state = context;
  if (scr_set_has(state->set, value)) {
    state->status = 0;
    return 0;
  }
  return 1;
}

static ScrDyn *scr_set_union(ScrSetRecord *record, ScrMap *set) {
  ScrMap *data = scr_set_copy(set);
  ScrSetIterator iter;
  if (!scr_set_iterator_open(record, &iter)) {
    scr_map_release(data);
    return NULL;
  }
  ScrSetAddContext context = {data};
  int status = scr_set_walk_keys(record, &iter, scr_set_union_visit, &context);
  scr_set_iterator_release(&iter);
  if (status < 0) {
    scr_map_release(data);
    return NULL;
  }
  return scr_set_result(data);
}

static ScrDyn *scr_set_intersection(ScrSetRecord *record, ScrMap *set) {
  ScrMap *data = scr_set_scratch();
  ScrSetHasContext context = {record, data, set, 1};
  if (scr_map_size(set) <= record->size) {
    if (scr_set_walk_this(set, scr_set_intersection_has_visit, &context) < 0) {
      scr_map_release(data);
      return NULL;
    }
    return scr_set_result(data);
  }
  ScrSetIterator iter;
  if (!scr_set_iterator_open(record, &iter)) {
    scr_map_release(data);
    return NULL;
  }
  int status = scr_set_walk_keys(record, &iter, scr_set_intersection_key_visit, &context);
  scr_set_iterator_release(&iter);
  if (status < 0) {
    scr_map_release(data);
    return NULL;
  }
  return scr_set_result(data);
}

static ScrDyn *scr_set_difference(ScrSetRecord *record, ScrMap *set) {
  ScrMap *data = scr_set_copy(set);
  ScrSetHasContext context = {record, data, set, 1};
  if (scr_map_size(set) <= record->size) {
    /* The result comes from the copy taken before the walk: `has` may add to
     * or delete from the receiver, and neither reaches this walk. */
    if (scr_set_walk_this(data, scr_set_difference_has_visit, &context) < 0) {
      scr_map_release(data);
      return NULL;
    }
    return scr_set_result(data);
  }
  ScrSetIterator iter;
  if (!scr_set_iterator_open(record, &iter)) {
    scr_map_release(data);
    return NULL;
  }
  int status = scr_set_walk_keys(record, &iter, scr_set_difference_key_visit, &context);
  scr_set_iterator_release(&iter);
  if (status < 0) {
    scr_map_release(data);
    return NULL;
  }
  return scr_set_result(data);
}

static ScrDyn *scr_set_symmetric_difference(ScrSetRecord *record, ScrMap *set) {
  ScrMap *data = scr_set_copy(set);
  ScrSetHasContext context = {record, data, set, 1};
  ScrSetIterator iter;
  if (!scr_set_iterator_open(record, &iter)) {
    scr_map_release(data);
    return NULL;
  }
  int status = scr_set_walk_keys(record, &iter, scr_set_symmetric_visit, &context);
  scr_set_iterator_release(&iter);
  if (status < 0) {
    scr_map_release(data);
    return NULL;
  }
  return scr_set_result(data);
}

static ScrDyn *scr_set_is_subset_of(ScrSetRecord *record, ScrMap *set) {
  if (scr_map_size(set) > record->size) return scr_dyn_new_bool(false);
  ScrSetHasContext context = {record, NULL, set, 1};
  if (scr_set_walk_this(set, scr_set_subset_visit, &context) < 0) return NULL;
  return scr_dyn_new_bool(context.status != 0);
}

static ScrDyn *scr_set_is_superset_of(ScrSetRecord *record, ScrMap *set) {
  if (scr_map_size(set) < record->size) return scr_dyn_new_bool(false);
  ScrSetIterator iter;
  if (!scr_set_iterator_open(record, &iter)) return NULL;
  ScrSetHasContext context = {record, NULL, set, 1};
  int status = scr_set_walk_keys(record, &iter, scr_set_superset_visit, &context);
  if (status == 0 && !scr_set_iterator_close(&iter)) status = -1;
  scr_set_iterator_release(&iter);
  if (status < 0) return NULL;
  return scr_dyn_new_bool(context.status != 0);
}

static ScrDyn *scr_set_is_disjoint_from(ScrSetRecord *record, ScrMap *set) {
  ScrSetHasContext context = {record, NULL, set, 1};
  if (scr_map_size(set) <= record->size) {
    if (scr_set_walk_this(set, scr_set_disjoint_this_visit, &context) < 0) return NULL;
    return scr_dyn_new_bool(context.status != 0);
  }
  ScrSetIterator iter;
  if (!scr_set_iterator_open(record, &iter)) return NULL;
  int status = scr_set_walk_keys(record, &iter, scr_set_disjoint_visit, &context);
  if (status == 0 && !scr_set_iterator_close(&iter)) status = -1;
  scr_set_iterator_release(&iter);
  if (status < 0) return NULL;
  return scr_dyn_new_bool(context.status != 0);
}

/* ── the entries the compiler and the method values call ──────────────── */

/* The receiver's data, or NULL with Node's brand-check TypeError. The ES2025
 * Set compositions take only a Set; the classic members brand-check their own
 * class inside the invoke unit. */
static ScrMap *scr_set_receiver(ScrDyn *receiver, const char *name) {
  if (scr_dyn_native_set_is(receiver)) return (ScrMap *)receiver->v.handle.ptr;
  scr_set_incompatible(scr_collection_class("Set"), name, receiver);
  return NULL;
}

static ScrDyn *scr_set_combine(ScrDyn *receiver, const char *name, ScrDyn *other) {
  ScrMap *set = scr_set_receiver(receiver, name);
  if (!set) return NULL;
  ScrSetRecord record;
  if (!scr_set_record(name, other, &record)) return NULL;
  ScrDyn *result;
  if (!strcmp(name, "union")) result = scr_set_union(&record, set);
  else if (!strcmp(name, "intersection")) result = scr_set_intersection(&record, set);
  else if (!strcmp(name, "difference")) result = scr_set_difference(&record, set);
  else if (!strcmp(name, "symmetricDifference")) result = scr_set_symmetric_difference(&record, set);
  else if (!strcmp(name, "isSubsetOf")) result = scr_set_is_subset_of(&record, set);
  else if (!strcmp(name, "isSupersetOf")) result = scr_set_is_superset_of(&record, set);
  else if (!strcmp(name, "isDisjointFrom")) result = scr_set_is_disjoint_from(&record, set);
  else {
    scr_set_record_release(&record);
    return scr_set_incompatible(scr_collection_class("Set"), name, receiver);
  }
  scr_set_record_release(&record);
  return result;
}

ScrDyn *scr_dyn_set_combine(ScrDyn *receiver, const ScrStr *name, ScrDyn *other) {
  return scr_set_combine(receiver, name->data, other);
}

/* Node's `<value> is not a function` for a non-callable callback. */
static void scr_set_throw_not_callable(ScrDyn *value) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  switch (value->kind) {
  case SCR_DYN_UNDEF:
    scr_jb_puts(&message, "undefined");
    break;
  case SCR_DYN_NULL:
    scr_jb_puts(&message, "object null");
    break;
  case SCR_DYN_NUM:
    scr_jb_puts(&message, "number ");
    scr_jb_put_f64(&message, value->v.num);
    break;
  case SCR_DYN_BOOL:
    scr_jb_puts(&message, value->v.b ? "boolean true" : "boolean false");
    break;
  case SCR_DYN_STR:
    scr_jb_puts(&message, "string ");
    scr_jb_put_json_str(&message, value->v.str);
    break;
  case SCR_DYN_BIGINT:
    scr_jb_puts(&message, "bigint");
    break;
  case SCR_DYN_SYMBOL:
    scr_jb_puts(&message, "symbol");
    break;
  default:
    scr_jb_puts(&message, "object");
    break;
  }
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
}

/* `<Class>.prototype.forEach` with a callback the static lowering cannot
 * take: Node's `<value> is not a function` for a non-callable one, and
 * (value, key, collection) visits for a Map, (value, value, collection) for a
 * Set. */
ScrDyn *scr_dyn_collection_for_each(ScrDyn *receiver, const ScrStr *klass, ScrDyn *callback,
                                    ScrDyn *this_arg) {
  const ScrCollectionClass *cls = scr_collection_class(klass->data);
  if (!cls || !cls->iterable) {
    static const char message[] = "collection forEach expected";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  if (!scr_collection_is(receiver, cls)) {
    scr_set_incompatible(cls, "forEach", receiver);
    return NULL;
  }
  if (!scr_dyn_is_callable(callback)) {
    scr_set_throw_not_callable(callback);
    return NULL;
  }
  ScrMap *data = (ScrMap *)receiver->v.handle.ptr;
  scr_map_iter_enter(data);
  for (double i = 0; i < scr_map_iter_count(data); i++) {
    if (!scr_map_iter_live(data, i)) continue;
    ScrDyn *key = scr_map_dyn_key(data, i);
    ScrDyn *value = cls->is_map ? scr_map_dyn_value(data, i) : scr_dyn_retain(key);
    ScrDyn *args[] = {value, key, receiver};
    scr_dyn_this_push_dyn(this_arg);
    ScrDyn *result = scr_dyn_call(callback, args, 3, "callback");
    scr_dyn_this_pop();
    scr_dyn_release(value);
    scr_dyn_release(key);
    scr_dyn_release(result);
    if (scr_exc_pending()) break;
  }
  scr_map_iter_exit(data);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

/* ── Set(iterable) and Map(iterable) ──────────────────────────────────── */

/* A fresh collection of `cls` built from `seed` by the runtime's own bulk
 * insert, or NULL with an exception pending. */
static ScrDyn *scr_collection_new(const ScrCollectionClass *cls, const ScrDyn *seed) {
  return cls->is_map ? scr_dyn_native_map_new(seed) : scr_dyn_native_set_new(seed);
}

/* Node's TypeError for an adder the constructor read that is not callable:
 * `'null' returned for property 'add' of object '#<Set>' is not a function`,
 * with the class's own member name and brand. */
static void scr_set_throw_adder_not_callable(const ScrCollectionClass *cls, ScrDyn *value) {
  ScrStr *shown = scr_dyn_string_coerce_js(value);
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "'");
  if (shown) {
    scr_jb_put_str(&message, shown);
    scr_str_release(shown);
  }
  scr_jb_puts(&message, "' returned for property '");
  scr_jb_puts(&message, cls->adder);
  scr_jb_puts(&message, "' of object '#<");
  scr_jb_puts(&message, cls->klass);
  scr_jb_puts(&message, ">' is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
}

/* entry[0] / entry[1] of a Map constructor entry, through the same property
 * read the rest of this unit uses: an array element directly (0 and 1 are
 * data properties of the array the walk hands over), everything else by the
 * key. +1, or NULL with the exception pending. */
static ScrDyn *scr_collection_entry_member(const ScrDyn *entry, unsigned index) {
  if (entry->kind == SCR_DYN_ARR)
    return scr_dyn_retain(index < entry->v.arr.len ? entry->v.arr.items[index]
                                                   : scr_dyn_undefined());
  char name[2] = {(char)(index ? '1' : '0'), '\0'};
  return scr_set_prop(entry, name);
}

/* Call(adder, collection, the iterated value's arguments): `add` takes the
 * value, `set` takes a Map entry's 0 and 1 members (AddEntriesFromIterable
 * validates the entry object before the call). False with the exception
 * pending. */
static bool scr_set_construct_add(const ScrCollectionClass *cls, ScrDyn *collection,
                                  ScrDyn *adder, ScrDyn *value) {
  ScrDyn *call_args[2];
  size_t argc;
  if (cls->is_map) {
    ScrDyn *entry = scr_dyn_map_seed_entry(value);
    if (!entry) return false;
    call_args[0] = scr_collection_entry_member(entry, 0);
    call_args[1] = call_args[0] && !scr_exc_pending() ? scr_collection_entry_member(entry, 1) : NULL;
    scr_dyn_release(entry);
    if (!call_args[1]) {
      scr_dyn_release(call_args[0]);
      return false;
    }
    argc = 2;
  } else {
    call_args[0] = value;
    argc = 1;
  }
  scr_dyn_this_push_dyn(collection);
  ScrDyn *result = scr_dyn_call(adder, call_args, argc, cls->adder);
  scr_dyn_this_pop();
  if (cls->is_map) {
    scr_dyn_release(call_args[0]);
    scr_dyn_release(call_args[1]);
  }
  if (!result) return false;
  scr_dyn_release(result);
  return true;
}

/* IteratorStepValue over (iterator, next): the value, or NULL with the
 * exception pending. */
static ScrDyn *scr_set_iterable_step(ScrDyn *iterator, ScrDyn *next, bool *done) {
  *done = false;
  if (scr_dyn_iterator_can_step(iterator, next)) {
    ScrDyn *value = scr_dyn_iterator_step(iterator);
    if (!value) return NULL;
    *done = scr_dyn_iterator_step_done(iterator);
    return value;
  }
  scr_dyn_this_push_dyn(iterator);
  ScrDyn *raw = scr_dyn_call(next, NULL, 0, "next");
  scr_dyn_this_pop();
  if (!raw) return NULL;
  /* A primitive result is Node's TypeError, which names the value. */
  ScrDyn *result = scr_dyn_iterator_result(raw);
  scr_dyn_release(raw);
  if (!result) return NULL;
  ScrDyn *finished = scr_set_prop(result, "done");
  if (!finished) {
    scr_dyn_release(result);
    return NULL;
  }
  *done = scr_dyn_truthy(finished);
  scr_dyn_release(finished);
  ScrDyn *value = *done ? scr_dyn_retain(scr_dyn_undefined()) : scr_set_prop(result, "value");
  scr_dyn_release(result);
  return value;
}

/* IteratorClose(iterator, the pending throw completion): `return` runs
 * unobserved, a throw from its read or its call replaces the pending
 * exception, and the result is not checked for object-ness. */
static void scr_set_iterator_close_abrupt(ScrDyn *iterator) {
  ScrCaught *first = scr_exc_pending() ? scr_exc_take() : NULL;
  ScrDyn *closer = scr_set_prop(iterator, "return");
  if (closer) {
    if (closer->kind != SCR_DYN_UNDEF && closer->kind != SCR_DYN_NULL) {
      if (!scr_dyn_is_callable(closer)) {
        scr_set_throw_not_callable(closer);
      } else {
        scr_dyn_this_push_dyn(iterator);
        ScrDyn *result = scr_dyn_call(closer, NULL, 0, "return");
        scr_dyn_this_pop();
        if (result) scr_dyn_release(result);
      }
    }
    scr_dyn_release(closer);
  }
  if (first) {
    if (scr_exc_pending()) {
      ScrCaught *dropped = scr_exc_take();
      if (dropped) scr_caught_release(dropped);
    }
    scr_rethrow(first);
    scr_caught_release(first);
  }
}

ScrDyn *scr_dyn_collection_construct(const ScrStr *klass, ScrDyn *seed) {
  const ScrCollectionClass *cls = scr_collection_class(klass->data);
  if (!cls || !cls->iterable) {
    static const char message[] = "keyed collection constructor expected";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  /* A nullish iterable returns the empty collection without reading the
   * adder. */
  if (seed->kind == SCR_DYN_NULL || seed->kind == SCR_DYN_UNDEF)
    return scr_collection_new(cls, scr_dyn_undefined());
  /* A program that never materialized %<Class>.prototype% cannot have
   * replaced the adder, so the native constructor's bulk insert runs. */
  ScrDyn *prototype = scr_collection_prototypes[cls - scr_collection_classes];
  if (!prototype) return scr_collection_new(cls, seed);
  /* Map/Set ( [ iterable ] ) creates the collection and then reads the adder
   * off it, so a getter-installed `set`/`add` runs with the new collection as
   * `this`. */
  ScrDyn *collection = scr_collection_new(cls, scr_dyn_undefined());
  if (!collection) return NULL;
  ScrDyn *adder = scr_dyn_obj_read_with_receiver(prototype, cls->adder, strlen(cls->adder),
                                                 collection);
  if (!adder) {
    scr_dyn_release(collection);
    return NULL;
  }
  ScrStr *klass_name = scr_str_new(cls->klass, strlen(cls->klass));
  ScrStr *adder_name = scr_str_new(cls->adder, strlen(cls->adder));
  ScrDyn *builtin = scr_dyn_builtin_method(klass_name, adder_name);
  scr_str_release(klass_name);
  scr_str_release(adder_name);
  if (!builtin) {
    scr_dyn_release(adder);
    scr_dyn_release(collection);
    return NULL;
  }
  bool overridden = adder != builtin;
  scr_dyn_release(builtin);
  /* The collection exists already; an adder that is still the builtin fills
   * it with the native bulk insert. */
  if (!overridden) {
    scr_dyn_release(adder);
    if (!scr_dyn_native_collection_insert_seed(collection, seed)) {
      scr_dyn_release(collection);
      return NULL;
    }
    return collection;
  }
  bool ok = true;
  if (!scr_dyn_is_callable(adder)) {
    scr_set_throw_adder_not_callable(cls, adder);
    ok = false;
  } else {
    /* Every seed iterates as it stands at each step: the walk runs the
     * program's adder, which may add to or delete from the seed, and the
     * pack a spread or a rest pattern takes would freeze the entries before
     * the first adder call. Only the adder's throw closes the iterator;
     * a throw from `next`, from a result accessor or a primitive result
     * propagates on its own (AddEntriesFromIterable). */
    ScrDyn *iterator = scr_dyn_iterator(seed, NULL);
    ok = iterator != NULL;
    if (iterator) {
      ScrDyn *next = scr_set_prop(iterator, "next");
      ok = next != NULL;
      while (ok) {
        bool done = false;
        ScrDyn *value = scr_set_iterable_step(iterator, next, &done);
        if (!value) {
          ok = false;
          break;
        }
        if (done) {
          scr_dyn_release(value);
          break;
        }
        ok = scr_set_construct_add(cls, collection, adder, value);
        scr_dyn_release(value);
        if (!ok) scr_set_iterator_close_abrupt(iterator);
      }
      if (next) scr_dyn_release(next);
      scr_dyn_release(iterator);
    }
  }
  scr_dyn_release(adder);
  if (!ok) {
    scr_dyn_release(collection);
    return NULL;
  }
  return collection;
}

/* The values of a Set handle as a checked-dynamic array, in insertion
 * order. The typed constructor path (`new Set(seed)` into `Set<T>`) adds
 * them to its native set after a program's own `add` has run. */
ScrDyn *scr_dyn_set_values(ScrDyn *set) {
  if (!scr_dyn_native_set_is(set)) {
    static const char message[] = "Set values expected";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  return scr_dyn_destructure_rest(set, NULL);
}

/* The method value of one ES2025 Set composition: it applies the set-like
 * protocol to the receiver it is called on, so `Set.prototype.union` and
 * `s.union` answer the same function. A classic member is the invoke unit's
 * interned function for the same (class, name) pair instead, which is what
 * `s.has` answers. */
static ScrDyn *scr_dyn_collection_combine_method(ScrClosure *closure, ScrDyn *const *args,
                                                 size_t argc) {
  ScrStr *name = scr_box_get_ref(closure->caps[0]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *other = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *result = scr_set_combine(receiver, name->data, other);
  scr_dyn_release(receiver);
  scr_str_release(name);
  return result;
}

/* ── %Set.prototype%, %Map.prototype%, %WeakMap.prototype%,
 *    %WeakSet.prototype% ─────────────────────────────────────────────── */

/* Interned method values keyed by "<Class>.<name>", so every spelling of one
 * prototype member — the property the prototype object holds, a member read
 * off a collection value — answers the same function object. */
static SCR_TL ScrDyn *scr_collection_methods;

static void scr_collection_cleanup(void) {
  for (size_t i = 0; i < SCR_COLLECTION_CLASS_COUNT; i++) {
    scr_dyn_release(scr_collection_prototypes[i]);
    scr_collection_prototypes[i] = NULL;
  }
  scr_dyn_release(scr_collection_methods);
  scr_collection_methods = NULL;
}

static ScrDyn *scr_dyn_collection_method_value(const ScrCollectionClass *cls, const char *name) {
  if (!scr_collection_methods) {
    scr_collection_methods = scr_dyn_new_obj_null_proto();
    scr_atexit(scr_collection_cleanup);
  }
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  scr_jb_puts(&buffer, cls->klass);
  scr_jb_putc(&buffer, '.');
  scr_jb_puts(&buffer, name);
  ScrStr *key = scr_jb_finish(&buffer);
  ScrDyn *existing = scr_dyn_obj_get(scr_collection_methods, key->data, key->len);
  if (existing) {
    scr_str_release(key);
    return scr_dyn_retain(existing);
  }
  ScrDyn *value;
  if (cls == scr_collection_class("Set") && scr_set_is_combine(name)) {
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(closure->caps[0], scr_str_new(name, strlen(name)));
    value = scr_dyn_new_func(closure, scr_dyn_collection_combine_method, 1, "native:Set.prototype",
                             name);
  } else {
    ScrStr *prototype = scr_str_new(cls->klass, strlen(cls->klass));
    ScrStr *method = scr_str_new(name, strlen(name));
    value = scr_dyn_builtin_method(prototype, method);
    scr_str_release(prototype);
    scr_str_release(method);
  }
  if (!value) {
    scr_str_release(key);
    return NULL;
  }
  scr_dyn_obj_set(scr_collection_methods, key->data, key->len, scr_dyn_retain(value));
  scr_str_release(key);
  return value;
}

/* The method value of one <Class>.prototype member; dyn.collectionMethod's
 * implementation. `klass` and `name` are literals the frontend emitted, so
 * an unknown pair is a compiler/runtime mismatch. */
ScrDyn *scr_dyn_collection_method(const ScrStr *klass, const ScrStr *name) {
  const ScrCollectionClass *cls = scr_collection_class(klass->data);
  if (!cls) {
    static const char message[] = "scriptc: unknown collection class\n";
    scr_trap(message);
  }
  return scr_dyn_collection_method_value(cls, name->data);
}

/* Defines `value` on `target` as a non-enumerable, writable, configurable
 * data property named `name` — the shape every built-in prototype method
 * has (and `constructor`). */
static void scr_collection_define(ScrDyn *target, const char *name, ScrDyn *value) {
  ScrStr *str = scr_str_new(name, strlen(name));
  ScrDyn *key = scr_dyn_new_str(str); /* retains */
  scr_str_release(str);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, value);
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
}

/* `get <Class>.prototype.size`: the receiver's entry count, or Node's
 * brand-check TypeError (reading it off the prototype object itself
 * throws). */
static ScrDyn *scr_dyn_collection_size_getter(ScrClosure *closure, ScrDyn *const *args,
                                              size_t argc) {
  (void)args;
  (void)argc;
  ScrStr *klass = scr_box_get_ref(closure->caps[0]);
  const ScrCollectionClass *cls = scr_collection_class(klass->data);
  ScrDyn *receiver = scr_dyn_this_get();
  bool compatible = cls && ((cls->is_map && scr_dyn_native_map_is(receiver)) ||
                            (!cls->is_map && scr_dyn_native_set_is(receiver)));
  if (!compatible) {
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "Method get ");
    scr_jb_puts(&message, cls->klass);
    scr_jb_puts(&message, ".prototype.size called on incompatible receiver ");
    scr_set_put_receiver(&message, receiver);
    scr_dyn_release(receiver);
    scr_str_release(klass);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return NULL;
  }
  ScrMap *storage = (ScrMap *)receiver->v.handle.ptr;
  double size = scr_map_size(storage);
  scr_dyn_release(receiver);
  scr_str_release(klass);
  return scr_dyn_new_num(size);
}

/* Symbol.toStringTag, created when the program has not evaluated it yet:
 * the well-known registry interns one symbol per description, so the
 * program's later `Symbol.toStringTag` is this key. */
static const ScrDyn *scr_set_to_string_tag(void) {
  const ScrDyn *key = scr_dyn_to_string_tag_symbol();
  if (key) return key;
  ScrStr *name = scr_str_new("toStringTag", 11);
  ScrSym *symbol = scr_sym_well_known(name);
  scr_str_release(name);
  ScrDyn *box = scr_dyn_new_symbol(symbol);
  scr_sym_release(symbol);
  scr_dyn_install_to_string_tag_symbol(box);
  scr_dyn_release(box);
  return scr_dyn_to_string_tag_symbol();
}

/* Defines the `size` accessor on a prototype: Node's descriptor for
 * `get <Class>.prototype.size`, non-enumerable and configurable. */
static void scr_collection_define_size(ScrDyn *prototype, const ScrCollectionClass *cls) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(closure->caps[0], scr_str_new(cls->klass, strlen(cls->klass)));
  ScrDyn *getter = scr_dyn_new_func(closure, scr_dyn_collection_size_getter, 0,
                                    "native:prototype", "get size");
  ScrStr *name = scr_str_new("size", 4);
  ScrDyn *key = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3, getter);
  /* Node's descriptor carries the absent setter too (`"set" in d` is true). */
  scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_undefined());
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *defined = scr_dyn_define_property(prototype, key, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
}

/* The class's prototype object, created on first use: `constructor` and the
 * members as non-enumerable functions (`size` as its accessor), then
 * Symbol.toStringTag and Symbol.iterator. The order is Node's creation
 * order, so own-property enumeration agrees, and Symbol.iterator is the same
 * function object as values (Set) or entries (Map). */
static ScrDyn *scr_collection_prototype_build(const ScrCollectionClass *cls) {
  ScrDyn *prototype = scr_dyn_new_obj();
  /* <Class>.prototype.constructor, and the constructor's own `prototype`,
   * are this same object, so both directions of the link agree. */
  {
    ScrStr *name = scr_str_new(cls->klass, strlen(cls->klass));
    ScrDyn *ctor = scr_dyn_global_constructor(name); /* the lookup's +1 */
    if (ctor) {
      /* scr_collection_define owns the value it is given; the interned
       * constructor keeps its own reference until the release below. */
      scr_collection_define(prototype, "constructor", scr_dyn_retain(ctor));
      scr_dyn_fn_seed_prototype(ctor, scr_dyn_retain(prototype));
      scr_dyn_release(ctor);
    }
    scr_str_release(name);
    if (scr_exc_pending()) {
      scr_dyn_release(prototype);
      return NULL;
    }
  }
  for (size_t i = 0; i < cls->member_count; i++) {
    if (!strcmp(cls->members[i], "size")) {
      scr_collection_define_size(prototype, cls);
    } else {
      ScrDyn *method = scr_dyn_collection_method_value(cls, cls->members[i]);
      if (!method) {
        scr_dyn_release(prototype);
        return NULL;
      }
      scr_collection_define(prototype, cls->members[i], method);
    }
    if (scr_exc_pending()) {
      scr_dyn_release(prototype);
      return NULL;
    }
  }
  const ScrDyn *tag = scr_set_to_string_tag();
  if (tag) {
    ScrStr *tag_value = scr_str_new(cls->klass, strlen(cls->klass));
    ScrDyn *value = scr_dyn_new_str(tag_value);
    scr_str_release(tag_value);
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "value", 5, value);
    scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
    scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    ScrDyn *defined = scr_dyn_define_property(prototype, (ScrDyn *)tag, descriptor);
    scr_dyn_release(defined);
    scr_dyn_release(descriptor);
    if (scr_exc_pending()) {
      scr_dyn_release(prototype);
      return NULL;
    }
  }
  if (cls->iterable) {
    /* @@iterator is the same function object as values (Set) or entries
     * (Map). */
    const char *alias = cls->is_map ? "entries" : "values";
    ScrDyn *method = scr_dyn_collection_method_value(cls, alias);
    if (method) {
      /* The well-known registry interns one symbol per description, so the
       * program's later `Symbol.iterator` is this key. */
      ScrStr *name = scr_str_new("iterator", sizeof "iterator" - 1);
      ScrSym *symbol = scr_sym_well_known(name);
      scr_str_release(name);
      if (symbol) {
        ScrDyn *key = scr_dyn_new_symbol(symbol);
        scr_sym_release(symbol);
        ScrDyn *descriptor = scr_dyn_new_obj();
        scr_dyn_obj_set(descriptor, "value", 5, method);
        scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
        scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
        scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
        ScrDyn *defined = scr_dyn_define_property(prototype, key, descriptor);
        scr_dyn_release(defined);
        scr_dyn_release(key);
        scr_dyn_release(descriptor);
      } else {
        scr_dyn_release(method);
      }
    }
    if (scr_exc_pending()) {
      scr_dyn_release(prototype);
      return NULL;
    }
  }
  /* scr_dyn_collection_method_value registered the cleanup with its table. */
  scr_collection_prototypes[cls - scr_collection_classes] = prototype;
  return scr_dyn_retain(prototype);
}

/* %<Class>.prototype% as a value; dyn.collectionPrototype's implementation. */
ScrDyn *scr_dyn_collection_prototype(const ScrStr *klass) {
  const ScrCollectionClass *cls = scr_collection_class(klass->data);
  if (!cls) {
    static const char message[] = "scriptc: unknown collection class\n";
    scr_trap(message);
  }
  ScrDyn *prototype = scr_collection_prototypes[cls - scr_collection_classes];
  if (prototype) return scr_dyn_retain(prototype);
  return scr_collection_prototype_build(cls);
}

/* Object.getPrototypeOf on a collection value: its class prototype. */
ScrDyn *scr_dyn_collection_get_prototype(ScrDyn *value) {
  const ScrCollectionClass *cls = scr_collection_class_of(value);
  if (cls) {
    ScrStr *name = scr_str_new(cls->klass, strlen(cls->klass));
    ScrDyn *prototype = scr_dyn_collection_prototype(name);
    scr_str_release(name);
    return prototype;
  }
  return scr_dyn_get_prototype(value);
}
