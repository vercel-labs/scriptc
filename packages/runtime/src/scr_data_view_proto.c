/* DataView.prototype as a value — the getter/setter family.
 *
 * A JavaScript source reading `DataView.prototype` used to reach the
 * standard-library member fence: the checker types the read as a DataView,
 * and there was no prototype object to hand out, so the family's own
 * existence tests (`Object.getOwnPropertyDescriptor(DataView.prototype,
 * "getInt8")`, `DataView.prototype.getInt8.name`) and its
 * call-with-a-foreign-receiver tests could not compile at all.
 *
 * This unit builds the object the language defines: an ordinary object whose
 * prototype is Object.prototype, carrying the twenty getter/setter methods
 * (one function object each, so `DataView.prototype.getInt8 ===
 * DataView.prototype.getInt8`), the buffer/byteLength/byteOffset accessors,
 * and the constructor — every property non-enumerable and configurable, the
 * methods writable, as the specification's MakeConstructor/DefineMethod
 * shape requires. One object per thread, so `DataView.prototype` read twice
 * is the same object.
 *
 * The methods carry the specification's algorithms, not the invoke unit's
 * dispatch: a method taken from the prototype IGNORES an own property the
 * view happens to carry, so routing through scr_dyn_invoke would answer a
 * shadowing function where the language answers the built-in. Each thunk
 * brand-checks its receiver (a checked-dynamic value over a view with
 * DataView's internal slots), runs ToIndex on the offset with the view's one
 * RangeError, and then reads or writes through the base units' primitives
 * (scr_bytes.c and scr_bigint.c), which perform the bounds and detached
 * checks. The three accessors read the view's internal slots as well, so an
 * own property a program defined on the instance does not reach them.
 * %DataView.prototype% itself carries no [[DataView]] internal slot, so like
 * any other non-view receiver it answers every member (the accessors
 * included) with the brand check's TypeError.
 *
 * The unit links only into programs that read `DataView.prototype` as a
 * value in a JavaScript source (the frontend marks dyn.dataViewPrototype
 * there), so typed programs keep their exact executables and no
 * always-linked unit changes. */
#include "scr_runtime.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* The getter/setter family in V8's own-property order. `kind` is the
 * ScrDataViewGet the base unit reads or writes; the BIG kinds take the
 * bigint path instead, whose sign is their only difference. */
typedef struct {
  const char *name;
  size_t length;
  ScrDataViewGet kind;
  bool get;
  bool big;
  bool sign; /* the BIG kinds: a signed read */
} ScrDataViewProtoMethod;

static const ScrDataViewProtoMethod scr_dv_proto_methods[] = {
  {"getInt8", 1, SCR_DV_I8, true, false, false},
  {"setInt8", 2, SCR_DV_I8, false, false, false},
  {"getUint8", 1, SCR_DV_U8, true, false, false},
  {"setUint8", 2, SCR_DV_U8, false, false, false},
  {"getInt16", 1, SCR_DV_I16, true, false, false},
  {"setInt16", 2, SCR_DV_I16, false, false, false},
  {"getUint16", 1, SCR_DV_U16, true, false, false},
  {"setUint16", 2, SCR_DV_U16, false, false, false},
  {"getInt32", 1, SCR_DV_I32, true, false, false},
  {"setInt32", 2, SCR_DV_I32, false, false, false},
  {"getUint32", 1, SCR_DV_U32, true, false, false},
  {"setUint32", 2, SCR_DV_U32, false, false, false},
  {"getFloat32", 1, SCR_DV_F32, true, false, false},
  {"setFloat32", 2, SCR_DV_F32, false, false, false},
  {"getFloat64", 1, SCR_DV_F64, true, false, false},
  {"setFloat64", 2, SCR_DV_F64, false, false, false},
  {"getBigInt64", 1, SCR_DV_BIGI64, true, true, true},
  {"setBigInt64", 2, SCR_DV_BIGI64, false, true, true},
  {"getBigUint64", 1, SCR_DV_BIGU64, true, true, false},
  {"setBigUint64", 2, SCR_DV_BIGU64, false, true, false},
  {"getFloat16", 1, SCR_DV_F16, true, false, false},
  {"setFloat16", 2, SCR_DV_F16, false, false, false},
};

/* The three see-through properties, in the specification's order. Each
 * accessor function's own `name` is "get " plus its property name, and a
 * function box keeps the pointer rather than a copy, so both strings need
 * static storage. */
typedef struct {
  const char *property;
  const char *fn_name;
} ScrDvProtoAccessor;

static const ScrDvProtoAccessor scr_dv_proto_accessors[] = {
  {"buffer", "get buffer"},
  {"byteLength", "get byteLength"},
  {"byteOffset", "get byteOffset"},
};

/* %DataView.prototype% itself, one per thread, kept for the lifetime of the
 * program (the accessors and the brand-failure messages read it). */
static SCR_TL ScrDyn *scr_dv_proto_object;

static void scr_dv_proto_cleanup(void) {
  scr_dyn_release(scr_dv_proto_object);
  scr_dv_proto_object = NULL;
}

/* Defines `value` (borrowed) on `target` as a non-enumerable data property
 * named `name`, writable and configurable as built-in prototype methods
 * are. */
static void scr_dv_define(ScrDyn *target, ScrStr *name, ScrDyn *value) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *key = scr_dyn_new_str(name); /* retains */
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
}

/* `method`'s ECMAScript `length`: the argument count of the interface
 * function, as an own data property with the attributes every built-in
 * function's length has (non-writable, non-enumerable, configurable). The
 * function object is created with that arity already; writing the property
 * here keeps it identical to the ones the invoke unit's method table
 * carries. */
static void scr_dv_define_length(ScrDyn *method, size_t length) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num((double)length));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrStr *length_name = scr_str_new("length", sizeof "length" - 1);
  ScrDyn *key = scr_dyn_new_str(length_name); /* retains */
  scr_str_release(length_name);
  ScrDyn *defined = scr_dyn_define_property(method, key, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
}

/* The receiver's view when it is a DataView — a checked-dynamic value over
 * bytes with DataView's internal slots — or NULL with Node's TypeError
 * pending. %DataView.prototype% itself has the slots and no buffer, which
 * the primitives answer with the same TypeError the language's
 * GetViewValue raises for it. */
static ScrBytes *scr_dv_view(ScrDyn *receiver, const char *method) {
  if (receiver->kind == SCR_DYN_BYTES && receiver->v.bytes->is_data_view)
    return receiver->v.bytes;
  char message[128];
  int length = snprintf(message, sizeof message,
                        "Method DataView.prototype.%s called on incompatible receiver", method);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)length);
  return NULL;
}

/* ToIndex of the method family's offset argument: ToNumber (a Symbol or an
 * object whose valueOf throws propagates), NaN to 0, truncation toward
 * zero, then the view's one RangeError for a negative or out-of-range
 * offset. */
static bool scr_dv_to_index(const ScrDyn *value, double *out) {
  double number;
  if (!scr_dyn_number_coerce_js(value, &number)) return false;
  number = isnan(number) ? 0 : trunc(number);
  if (!(number >= 0) || number > 9007199254740991.0) {
    static const char message[] = "Offset is outside the bounds of the DataView";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return false;
  }
  *out = number;
  return true;
}

/* One getter/setter method: `this` is the view, args[0] the offset, then
 * the value (setters) and the optional littleEndian flag. The closure's
 * function slot indexes scr_dv_proto_methods. */
static ScrDyn *scr_dv_proto_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  const ScrDataViewProtoMethod *member = &scr_dv_proto_methods[(size_t)(uintptr_t)closure->fn];
  ScrDyn *receiver = scr_dyn_this_get();
  ScrBytes *view = scr_dv_view(receiver, member->name);
  if (!view) {
    scr_dyn_release(receiver);
    return NULL;
  }
  double offset;
  if (!scr_dv_to_index(argc > 0 ? args[0] : scr_dyn_undefined(), &offset)) {
    scr_dyn_release(receiver);
    return NULL;
  }
  const bool le = argc > (member->get ? 1 : 2) && scr_dyn_truthy(args[member->get ? 1 : 2]);
  ScrDyn *result = NULL;
  if (member->get) {
    if (member->big) {
      ScrBigInt *value = scr_bigint_dataview_get(view, offset, member->sign, le);
      if (!scr_exc_pending()) result = scr_dyn_new_bigint(value);
      scr_bigint_release(value);
    } else {
      double value = scr_dataview_get(view, offset, member->kind, le);
      if (!scr_exc_pending()) result = scr_dyn_new_num(value);
    }
  } else if (member->big) {
    ScrBigInt *value = scr_dyn_bigint_coerce(argc > 1 ? args[1] : scr_dyn_undefined());
    if (value) {
      scr_bigint_dataview_set(view, offset, value, le);
      scr_bigint_release(value);
    }
    if (!scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
  } else {
    double value;
    if (scr_dyn_number_coerce_js(argc > 1 ? args[1] : scr_dyn_undefined(), &value)) {
      scr_dataview_set(view, offset, value, member->kind, le);
      if (!scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
    }
  }
  scr_dyn_release(receiver);
  return result;
}

/* The buffer/byteLength/byteOffset getters (no setters). The closure's
 * function slot names the property. They answer the receiver's internal
 * slots, not its properties: a view the program gave its own `buffer`,
 * `byteLength` or `byteOffset` still answers the slots here, as the
 * specification's [[ViewedArrayBuffer]]/[[ByteLength]]/[[ByteOffset]] reads
 * do, while an ordinary property read still finds the own property first.
 * %DataView.prototype% carries no [[DataView]] internal slot, so it is an
 * incompatible receiver like any other value — the specification's brand
 * check. */
static ScrDyn *scr_dv_proto_accessor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  const char *which = closure->fn;
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (receiver->kind == SCR_DYN_BYTES && receiver->v.bytes->is_data_view) {
    ScrBytes *view = receiver->v.bytes;
    if (strcmp(which, "buffer") == 0) {
      result = scr_array_buffer_from_bytes(view);
    } else {
      /* A detached or out-of-bounds view throws the accessor's own
       * TypeError, the same one the property read raises. */
#ifdef SCR_JS_OBJECT_MODEL
      double value = strcmp(which, "byteLength") == 0 ? scr_js_bytes_byte_length(view)
                                                      : scr_js_bytes_byte_offset(view);
#else
      double value = strcmp(which, "byteLength") == 0 ? scr_bytes_byte_len(view)
                                                      : scr_bytes_byte_offset(view);
#endif
      if (!scr_exc_pending()) result = scr_dyn_new_num(value);
    }
  } else {
    char message[128];
    int length = snprintf(message, sizeof message,
                          "Method get DataView.prototype.%s called on incompatible receiver", which);
    scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)length);
  }
  scr_dyn_release(receiver);
  return result;
}

/* One method's function object: a zero-capture closure whose function slot
 * indexes the table, so every read answers the same value. */
static ScrDyn *scr_dv_proto_method(size_t at) {
  const ScrDataViewProtoMethod *member = &scr_dv_proto_methods[at];
  ScrDyn *value = scr_dyn_new_func(scr_closure_new((void *)(uintptr_t)at, 0), scr_dv_proto_method_call,
                                   (uint32_t)member->length, "native:prototype", member->name);
  scr_dv_define_length(value, member->length);
  return value;
}

static ScrDyn *scr_dv_proto_accessor(const ScrDvProtoAccessor *accessor) {
  return scr_dyn_new_func(scr_closure_new((void *)accessor->property, 0),
                          scr_dv_proto_accessor_call, 0, "native:prototype", accessor->fn_name);
}

/* DataView.prototype[@@toStringTag] is "DataView": a non-writable,
 * non-enumerable, configurable own data property. `tag_key` (borrowed) is the
 * Symbol.toStringTag key the frontend emitted. */
static void scr_dv_define_tag(ScrDyn *target, ScrDyn *tag_key) {
  ScrStr *tag = scr_str_new("DataView", sizeof "DataView" - 1);
  ScrDyn *value = scr_dyn_new_str(tag);
  scr_str_release(tag);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_release(value);
  ScrDyn *defined = scr_dyn_define_property(target, tag_key, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(descriptor);
}

/* `DataView.prototype` as a value. */
ScrDyn *scr_data_view_prototype(ScrDyn *tag_key) {
  if (scr_dv_proto_object) return scr_dyn_retain(scr_dv_proto_object);
  ScrDyn *prototype = scr_dyn_new_obj(); /* an ordinary object: Object.prototype behind it */
  scr_dv_define_tag(prototype, tag_key);
  for (size_t i = 0; i < sizeof scr_dv_proto_methods / sizeof scr_dv_proto_methods[0]; i++) {
    ScrStr *property = scr_str_new(scr_dv_proto_methods[i].name, strlen(scr_dv_proto_methods[i].name));
    ScrDyn *value = scr_dv_proto_method(i);
    scr_dv_define(prototype, property, value);
    scr_str_release(property);
    scr_dyn_release(value);
  }
  for (size_t i = 0; i < sizeof scr_dv_proto_accessors / sizeof scr_dv_proto_accessors[0]; i++) {
    const ScrDvProtoAccessor *accessor = &scr_dv_proto_accessors[i];
    const char *which = accessor->property;
    size_t length = strlen(which);
    scr_dyn_obj_set_accessor(prototype, which, length, scr_dv_proto_accessor(accessor), NULL);
    /* An accessor property of a built-in prototype is non-enumerable (the
     * setter takes the language's default, which is enumerable). */
    scr_dyn_obj_set_attrs_at(prototype, scr_dyn_obj_index_of(prototype, which, length), false, false, true);
  }
  /* DataView.prototype.constructor, and the constructor's own `prototype`,
   * are this same object, so both directions of the link agree. */
  scr_dv_proto_object = prototype;
  ScrStr *constructor_name = scr_str_new("DataView", sizeof "DataView" - 1);
  ScrDyn *ctor = scr_dyn_global_constructor(constructor_name);
  scr_str_release(constructor_name);
  ScrStr *constructor = scr_str_new("constructor", sizeof "constructor" - 1);
  scr_dv_define(prototype, constructor, ctor);
  scr_str_release(constructor);
  scr_dyn_fn_seed_prototype(ctor, scr_dyn_retain(prototype));
  scr_dyn_release(ctor);
  scr_atexit(scr_dv_proto_cleanup);
  return scr_dyn_retain(scr_dv_proto_object);
}
