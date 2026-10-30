/* Set values in the checked-dynamic tier: the ES2025 compositions
 * (union/intersection/difference/symmetricDifference/isSubsetOf/
 * isSupersetOf/isDisjointFrom) over an arbitrary set-like argument, the
 * %Set.prototype% object, and the brand-checked method values that make
 * `Set.prototype.has.call(Set.prototype, 1)` and `s.forEach(1)` throw
 * Node's TypeErrors.
 *
 * The compiler emits the entries only from JavaScript sources, and only on
 * paths whose statically typed lowering refuses (a set-like argument, a
 * non-callable callback, `Set.prototype` as a value). Typed programs keep
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

/* %Set.prototype%, created on first use (the object section below). */
static SCR_TL ScrDyn *scr_set_prototype_object;

static void scr_set_throw_type(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

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
    cls = scr_set_prototype_object && receiver == scr_set_prototype_object ? "Set" : "Object";
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

/* `Method Set.prototype.<name> called on incompatible receiver <value>`. */
static ScrDyn *scr_set_incompatible(const char *name, const ScrDyn *receiver) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "Method Set.prototype.");
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
  ScrDyn *result = scr_dyn_call(iter->next, &iter->iterator, 1, "next");
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

static bool scr_set_is_predicate(const char *name) {
  return !strcmp(name, "isSubsetOf") || !strcmp(name, "isSupersetOf") ||
         !strcmp(name, "isDisjointFrom");
}

/* The size-branch walk over the receiver's LIVE data: user code the walk
 * calls (`has`) may mutate the set, so the entry count is re-read every
 * step, as the spec does. */
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

static int scr_set_intersection_visit(void *context, ScrDyn *value) {
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
    if (scr_set_walk_this(set, scr_set_difference_has_visit, &context) < 0) {
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

/* The receiver's data, or NULL with Node's brand-check TypeError. */
static ScrMap *scr_set_receiver(ScrDyn *receiver, const char *name) {
  if (scr_dyn_native_set_is(receiver)) return (ScrMap *)receiver->v.handle.ptr;
  scr_set_incompatible(name, receiver);
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
    return scr_set_incompatible(name, receiver);
  }
  scr_set_record_release(&record);
  return result;
}

ScrDyn *scr_dyn_set_combine(ScrDyn *receiver, const ScrStr *name, ScrDyn *other) {
  return scr_set_combine(receiver, name->data, other);
}

/* The classic instance methods run the runtime's native-set dispatch
 * (scr_native_set_invoke, whose own brand check and Node error texts the
 * method values already use). */
static ScrDyn *scr_set_delegate(ScrDyn *receiver, const char *name, ScrDyn *const *args,
                                size_t argc) {
  return scr_dyn_invoke(receiver, name, args, argc, name);
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

ScrDyn *scr_dyn_set_for_each(ScrDyn *receiver, ScrDyn *callback, ScrDyn *this_arg) {
  ScrMap *set = scr_set_receiver(receiver, "forEach");
  if (!set) return NULL;
  if (!scr_dyn_is_callable(callback)) {
    scr_set_throw_not_callable(callback);
    return NULL;
  }
  scr_map_iter_enter(set);
  for (double i = 0; i < scr_map_iter_count(set); i++) {
    if (!scr_map_iter_live(set, i)) continue;
    ScrDyn *entry = scr_map_dyn_key(set, i);
    ScrDyn *args[] = {entry, entry, receiver};
    scr_dyn_this_push_dyn(this_arg);
    ScrDyn *result = scr_dyn_call(callback, args, 3, "callback");
    scr_dyn_this_pop();
    scr_dyn_release(entry);
    scr_dyn_release(result);
    if (scr_exc_pending()) break;
  }
  scr_map_iter_exit(set);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

/* The method value of one Set.prototype member. */
static ScrDyn *scr_dyn_set_proto_method(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStr *name = scr_box_get_ref(closure->caps[0]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result;
  if (scr_set_is_combine(name->data)) {
    ScrDyn *other = argc ? args[0] : scr_dyn_undefined();
    result = scr_set_combine(receiver, name->data, other);
  } else if (!strcmp(name->data, "forEach")) {
    if (argc < 1 || !scr_dyn_is_callable(args[0])) {
      if (scr_set_receiver(receiver, name->data))
        scr_set_throw_not_callable(argc ? args[0] : scr_dyn_undefined());
      result = NULL;
    } else {
      result = scr_set_delegate(receiver, name->data, args, argc);
    }
  } else {
    if (!scr_set_receiver(receiver, name->data)) result = NULL;
    else result = scr_set_delegate(receiver, name->data, args, argc);
  }
  scr_dyn_release(receiver);
  scr_str_release(name);
  return result;
}

/* ── %Set.prototype% ──────────────────────────────────────────────────── */

static SCR_TL ScrDyn *scr_set_methods; /* interned method values, own props */

static void scr_set_prototype_cleanup(void) {
  scr_dyn_release(scr_set_prototype_object);
  scr_set_prototype_object = NULL;
  scr_dyn_release(scr_set_methods);
  scr_set_methods = NULL;
}

/* The interned method value for one Set.prototype member: the ES2025
 * entries are this unit's thunks, the classic ones the runtime's own
 * per-name function (the same value `s.add` reads). */
static ScrDyn *scr_dyn_set_method_value(const char *name) {
  if (!scr_set_methods) {
    scr_set_methods = scr_dyn_new_obj_null_proto();
    scr_atexit(scr_set_prototype_cleanup);
  }
  ScrDyn *existing = scr_dyn_obj_get(scr_set_methods, name, strlen(name));
  if (existing) return scr_dyn_retain(existing);
  ScrDyn *value;
  if (scr_set_is_combine(name)) {
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(closure->caps[0], scr_str_new(name, strlen(name)));
    value = scr_dyn_new_func(closure, scr_dyn_set_proto_method, 1, "native:Set.prototype", name);
  } else {
    ScrStr *prototype = scr_str_new("Set", 3);
    ScrStr *method = scr_str_new(name, strlen(name));
    value = scr_dyn_builtin_method(prototype, method);
    scr_str_release(prototype);
    scr_str_release(method);
  }
  if (!value) return NULL;
  scr_dyn_obj_set(scr_set_methods, name, strlen(name), scr_dyn_retain(value));
  return value;
}

ScrDyn *scr_dyn_set_method(const ScrStr *name) {
  return scr_dyn_set_method_value(name->data);
}

/* `Set.prototype.size`'s getter: the receiver's size, or Node's brand-check
 * TypeError (reading it off %Set.prototype% itself throws). */
static ScrDyn *scr_dyn_set_size_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  ScrDyn *receiver = scr_dyn_this_get();
  if (!scr_dyn_native_set_is(receiver)) {
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, "Method get Set.prototype.size called on incompatible receiver ");
    scr_set_put_receiver(&message, receiver);
    scr_dyn_release(receiver);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return NULL;
  }
  ScrMap *set = (ScrMap *)receiver->v.handle.ptr;
  double size = scr_map_size(set);
  scr_dyn_release(receiver);
  return scr_dyn_new_num(size);
}

static const struct {
  const char *name;
} scr_set_prototype_members[] = {
    {"add"},      {"has"},        {"delete"},       {"clear"},
    {"values"},   {"keys"},       {"entries"},      {"forEach"},
    {"union"},    {"intersection"}, {"difference"}, {"symmetricDifference"},
    {"isSubsetOf"}, {"isSupersetOf"}, {"isDisjointFrom"},
};

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

ScrDyn *scr_dyn_set_prototype_object(void) {
  if (scr_set_prototype_object) return scr_dyn_retain(scr_set_prototype_object);
  ScrDyn *prototype = scr_dyn_new_obj();
  for (size_t i = 0; i < sizeof scr_set_prototype_members / sizeof scr_set_prototype_members[0];
       i++) {
    ScrDyn *method = scr_dyn_set_method_value(scr_set_prototype_members[i].name);
    if (!method) {
      scr_dyn_release(prototype);
      return NULL;
    }
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "value", 5, method);
    scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    ScrStr *name = scr_str_new(scr_set_prototype_members[i].name,
                               strlen(scr_set_prototype_members[i].name));
    ScrDyn *key = scr_dyn_new_str(name);
    ScrDyn *defined = scr_dyn_define_property(prototype, key, descriptor);
    scr_dyn_release(defined);
    scr_dyn_release(key);
    scr_dyn_release(descriptor);
    scr_str_release(name);
    if (scr_exc_pending()) {
      scr_dyn_release(prototype);
      return NULL;
    }
  }
  {
    ScrClosure *closure = scr_closure_new(NULL, 0);
    ScrDyn *getter = scr_dyn_new_func(closure, scr_dyn_set_size_getter, 0, "native:Set.prototype",
                                      "get size");
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "get", 3, getter);
    scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    ScrStr *name = scr_str_new("size", 4);
    ScrDyn *key = scr_dyn_new_str(name);
    ScrDyn *defined = scr_dyn_define_property(prototype, key, descriptor);
    scr_dyn_release(defined);
    scr_dyn_release(key);
    scr_dyn_release(descriptor);
    scr_str_release(name);
    if (scr_exc_pending()) {
      scr_dyn_release(prototype);
      return NULL;
    }
  }
  const ScrDyn *tag = scr_set_to_string_tag();
  if (tag) {
    ScrStr *tag_value = scr_str_new("Set", 3);
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
  /* scr_dyn_set_method_value registered the cleanup with its table. */
  scr_set_prototype_object = prototype;
  return scr_dyn_retain(prototype);
}

ScrDyn *scr_dyn_set_get_prototype(ScrDyn *value) {
  if (scr_dyn_native_set_is(value)) return scr_dyn_set_prototype_object();
  return scr_dyn_get_prototype(value);
}
