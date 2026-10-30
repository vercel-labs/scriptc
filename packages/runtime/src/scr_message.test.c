#undef NDEBUG
#include "scr_message.h"
#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>

static void put_number(ScrDyn *object, const char *key, double value) {
  scr_dyn_obj_set(object, key, strlen(key), scr_dyn_new_num(value));
}

static ScrDyn *make_graph(void) {
  ScrDyn *root = scr_dyn_new_obj();
  ScrDyn *shared = scr_dyn_new_obj();
  put_number(shared, "value", 17);
  scr_dyn_obj_set(root, "first", 5, scr_dyn_retain(shared));
  scr_dyn_obj_set(root, "second", 6, shared);
  scr_dyn_obj_set(root, "self", 4, scr_dyn_retain(root));
  put_number(root, "negativeZero", -0.0);
  put_number(root, "nan", NAN);
  put_number(root, "infinity", INFINITY);
  ScrStr *text = scr_str_new("a\0\xf0\x9f\x98\x80", 6);
  scr_dyn_obj_set(root, "text", 4, scr_dyn_new_str(text));
  scr_str_release(text);
  text = scr_str_new("123456789012345678901234567890", 30);
  ScrBigInt *integer = scr_bigint_parse(text);
  scr_str_release(text);
  scr_dyn_obj_set(root, "integer", 7, scr_dyn_new_bigint(integer));
  scr_bigint_release(integer);

  ScrDyn *array = scr_dyn_new_arr();
  scr_dyn_arr_push_hole(array);
  scr_dyn_arr_push(array, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_arr_push_hole(array);
  scr_dyn_arr_push(array, scr_dyn_retain(shared));
  scr_dyn_obj_set(root, "array", 5, array);

  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 16);
  for (size_t i = 0; i < bytes->len; i++) bytes->data[i] = (unsigned char)i;
  ScrBytes *view = scr_bytes_buffer_view(bytes, SCR_BYTES_U16, 4, true, 3);
  scr_dyn_obj_set(root, "bytes", 5, scr_dyn_new_bytes(view));
  scr_dyn_obj_set(root, "again", 5, scr_dyn_new_bytes(view));
  scr_dyn_obj_set(root, "buffer", 6, scr_array_buffer_from_bytes(bytes));
  scr_bytes_release(view);
  scr_bytes_release(bytes);
  return root;
}

static void *receive_graph(void *data) {
  scr_context_enter(1);
  scr_init();
  scr_lib_init(0, NULL);
  ScrDyn *root = scr_message_decode(data);
  assert(root && !scr_exc_pending());
  ScrDyn *first = scr_dyn_obj_get(root, "first", 5);
  assert(first == scr_dyn_obj_get(root, "second", 6));
  assert(root == scr_dyn_obj_get(root, "self", 4));
  assert(signbit(scr_dyn_obj_get(root, "negativeZero", 12)->v.num));
  assert(isnan(scr_dyn_obj_get(root, "nan", 3)->v.num));
  assert(isinf(scr_dyn_obj_get(root, "infinity", 8)->v.num));
  ScrStr *text = scr_dyn_obj_get(root, "text", 4)->v.str;
  assert(text->len == 6 && !memcmp(text->data, "a\0\xf0\x9f\x98\x80", 6));
  text = scr_bigint_to_string(scr_dyn_obj_get(root, "integer", 7)->v.bigint, 10);
  assert(text->len == 30 && !memcmp(text->data, "123456789012345678901234567890", 30));
  scr_str_release(text);
  ScrDyn *array = scr_dyn_obj_get(root, "array", 5);
  assert(array->v.arr.len == 4);
  assert(!scr_dyn_arr_has_index(array, 0) && scr_dyn_arr_has_index(array, 1));
  assert(!scr_dyn_arr_has_index(array, 2) && scr_dyn_arr_has_index(array, 3));
  assert(array->v.arr.items[3] == first);
  ScrDyn *bytes = scr_dyn_obj_get(root, "bytes", 5);
  assert(bytes == scr_dyn_obj_get(root, "again", 5));
  assert(bytes->v.bytes->elem == SCR_BYTES_U16 && bytes->v.bytes->len == 3);
  assert(scr_bytes_byte_offset(bytes->v.bytes) == 4);
  ScrBytes *buffer = scr_dyn_obj_get(root, "buffer", 6)->v.handle.ptr;
  assert(bytes->v.bytes->backing == buffer && buffer->len == 16);
  bytes->v.bytes->data[0] = 91;
  assert(buffer->data[4] == 91);
  scr_dyn_release(root);
  scr_context_cleanup();
  return NULL;
}

static SCR_TL char getters[4];
static SCR_TL size_t getter_count;
static ScrDyn *read_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args; (void)argc;
  double value = scr_box_get_f64(closure->caps[0]);
  getters[getter_count++] = (char)value;
  return scr_dyn_new_num(value);
}

static void define_getter(ScrDyn *object, const char *key, char marker) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[0], marker);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_new_func(closure, read_getter, 0, "", ""));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  ScrStr *name = scr_str_new(key, strlen(key));
  ScrDyn *name_value = scr_dyn_new_str(name);
  ScrDyn *result = scr_dyn_define_property(object, name_value, descriptor);
  assert(result && !scr_exc_pending());
  scr_dyn_release(result);
  scr_dyn_release(name_value);
  scr_dyn_release(descriptor);
  scr_str_release(name);
}

static void check_getters(void) {
  ScrDyn *root = scr_dyn_new_obj();
  ScrDyn *nested = scr_dyn_new_obj();
  define_getter(nested, "inner", 'a');
  scr_dyn_obj_set(root, "first", 5, nested);
  define_getter(root, "last", 'b');
  ScrMessage *message = scr_message_encode(root);
  assert(message && !scr_exc_pending());
  assert(getter_count == 2 && !memcmp(getters, "ab", 2));
  scr_message_free(message);
  scr_dyn_release(root);
  scr_collect_cycles();
}

static void check_rejection(void) {
  ScrDyn *root = scr_dyn_new_obj();
  ScrClosure *closure = scr_closure_new(NULL, 0);
  ScrDyn *function = scr_dyn_new_func(closure, read_getter, 0, "", "");
  scr_dyn_obj_set(root, "function", 8, function);
  assert(!scr_message_encode(root) && scr_exc_pending());
  scr_exc_clear();
  scr_dyn_release(root);
  scr_collect_cycles();
}

/* Plain JSON-shaped documents decode as an intact region (ScrDynRegion);
 * a later back edge clears it, so the cycle is still collected. */
static void check_documents(void) {
  ScrDyn *root = scr_dyn_new_obj();
  ScrDyn *child = scr_dyn_new_obj();
  ScrDyn *list = scr_dyn_new_arr();
  scr_dyn_arr_push(list, scr_dyn_new_num(1));
  ScrStr *text = scr_str_new("x", 1);
  scr_dyn_arr_push(list, scr_dyn_new_str(text));
  scr_str_release(text);
  scr_dyn_obj_set(child, "list", 4, list);
  scr_dyn_obj_set(root, "child", 5, child);
  scr_dyn_obj_set(root, "none", 4, scr_dyn_new_null());
  ScrMessage *message = scr_message_encode(root);
  assert(message && !scr_exc_pending());
  scr_dyn_release(root);
  ScrDyn *decoded = scr_message_decode(message);
  assert(decoded && !scr_exc_pending());
  ScrDyn *decoded_child = scr_dyn_obj_get(decoded, "child", 5);
  const ScrDynRegion *region = scr_dyn_region_of(decoded);
  assert(region && region->intact);
  assert(scr_dyn_region_of(decoded_child) == region);
  assert(scr_dyn_region_of(scr_dyn_obj_get(decoded_child, "list", 4)) == region);
  scr_dyn_obj_set(decoded_child, "parent", 6, scr_dyn_retain(decoded));
  assert(!region->intact);
  scr_dyn_release(decoded);
  scr_collect_cycles();
  scr_message_free(message);

  /* Shared subtrees and cycles (make_graph) stay untagged. */
  ScrDyn *graph = make_graph();
  message = scr_message_encode(graph);
  scr_dyn_release(graph);
  decoded = scr_message_decode(message);
  assert(decoded && !scr_dyn_region_of(decoded));
  scr_dyn_release(decoded);
  scr_collect_cycles();
  scr_message_free(message);
}

static SCR_TL size_t capsule_snapshots;
static ScrDyn *capsule_array_get(void *array, double index) {
  return scr_dyn_new_num(scr_arr_get_f64(array, index));
}
static ScrDynArrayWrite capsule_array_set(void *array, double index, const ScrDyn *value, bool strict) {
  if (value->kind != SCR_DYN_NUM) return SCR_DYN_ARRAY_TYPE_MISMATCH;
  if (!scr_arr_check_set_mode(array, index, strict)) return SCR_DYN_ARRAY_REFUSED;
  scr_arr_set_f64(array, index, value->v.num);
  return SCR_DYN_ARRAY_STORED;
}
static ScrDyn *capsule_array_view(void *array) {
  capsule_snapshots++;
  ScrDyn *view = scr_dyn_new_arr();
  scr_dyn_arr_push(view, capsule_array_get(array, 0));
  return view;
}
static ScrDyn *capsule_array_box(uint64_t slot) {
  double number;
  memcpy(&number, &slot, sizeof number);
  return scr_dyn_new_num(number);
}
static bool capsule_array_unbox(const ScrDyn *value, uint64_t *out) {
  if (value->kind != SCR_DYN_NUM) return false;
  memcpy(out, &value->v.num, sizeof *out);
  return true;
}
static const ScrDynTypedArrayOps capsule_array_ops = {capsule_array_get, capsule_array_set, capsule_array_box, capsule_array_unbox};
static void publish_array(void *array, ScrPub *ctx) { scr_pub_arr(array, ctx, NULL); }

/* These immortal native sources model the emitted adapter contract without
 * sharing a checked view or allocating recipient-owned state on the sender. */
static struct { size_t rc; double value; } capsule_source = {SIZE_MAX, 23};
static void *capsule_source_retain(void *source) { return source; }
static void capsule_source_release(void *source) { (void)source; }
static ScrDyn *capsule_source_view(void *source) {
  (void)source;
  capsule_snapshots++;
  ScrDyn *view = scr_dyn_new_obj();
  put_number(view, "value", capsule_source.value);
  return view;
}
static bool capsule_record_has(void *source, size_t index) { (void)source; return index == 0; }
static ScrDyn *capsule_record_get(void *source, size_t index) {
  (void)source;
  assert(index == 0);
  return scr_dyn_new_num(capsule_source.value);
}

typedef struct {
  ScrMessage *message;
  const ScrDynTypedRecordOps *record_ops;
  const ScrDynTypedClassOps *class_ops;
  const ScrDynNativeObjectOps *native_ops;
} CapsuleMessage;

static void *receive_capsules(void *argument) {
  CapsuleMessage *sent = argument;
  scr_context_enter(1);
  scr_init();
  scr_lib_init(0, NULL);
  capsule_snapshots = 0;
  ScrDyn *root = scr_message_decode(sent->message);
  assert(root && !scr_exc_pending());
  ScrDyn *array = scr_dyn_obj_get(root, "array", 5);
  ScrDyn *record = scr_dyn_obj_get(root, "record", 6);
  ScrDyn *klass = scr_dyn_obj_get(root, "class", 5);
  ScrDyn *opaque = scr_dyn_obj_get(root, "opaque", 6);
  assert(array->kind == SCR_DYN_TYPED_REF && record->kind == SCR_DYN_TYPED_REF &&
      klass->kind == SCR_DYN_TYPED_REF);
  assert(scr_dyn_typed_ref_array_ops(array) == &capsule_array_ops);
  assert(record->v.typed_ref.record && !record->v.typed_ref.klass &&
      record->v.typed_ref.array == (const void *)sent->record_ops);
  assert(klass->v.typed_ref.klass && !klass->v.typed_ref.record &&
      klass->v.typed_ref.array == (const void *)sent->class_ops);
  assert(!array->v.typed_ref.native_object);
  assert(record->v.typed_ref.native_object == sent->native_ops &&
      klass->v.typed_ref.native_object == sent->native_ops);
  assert(opaque->kind == SCR_DYN_TYPED_REF && !opaque->v.typed_ref.array &&
      opaque->v.typed_ref.native_object == sent->native_ops && !opaque->v.typed_ref.materialized);
  assert(!array->v.typed_ref.materialized && !record->v.typed_ref.materialized &&
      !klass->v.typed_ref.materialized);
  ScrStr *zero = scr_str_new("0", 1), *value = scr_str_new("value", 5);
  ScrDyn *number = scr_dyn_typed_ref_key_get(array, zero);
  assert(number && number->kind == SCR_DYN_NUM && number->v.num == 17);
  scr_dyn_release(number);
  number = scr_dyn_typed_ref_key_get(record, value);
  assert(number && number->kind == SCR_DYN_NUM && number->v.num == 23);
  scr_dyn_release(number);
  assert(scr_dyn_typed_ref_class_has(klass, value));
  assert(scr_dyn_typed_ref_class_name(klass) == sent->class_ops->class_name->data);
  number = scr_dyn_new_num(9);
  scr_dyn_key_set(array, zero, number);
  assert(scr_exc_pending() && scr_arr_get_f64(array->v.typed_ref.ptr, 0) == 17);
  scr_exc_clear();
  scr_dyn_release(number);
  ScrStr *missing = scr_str_new("4", 1);
  scr_dyn_key_delete(array, missing, true);
  assert(!scr_exc_pending() && capsule_snapshots == 0);

  /* Native publication retires scalar restrictions; a prototype walk must
   * recover readonly descriptors from the array owner's immutable state. */
  ScrDyn *target = scr_dyn_new_obj(), *other = scr_dyn_new_obj();
  scr_dyn_release(scr_dyn_set_prototype(target, array));
  ScrDyn *write = scr_dyn_new_num(9);
  const char *keys[] = {"0", "length"};
  for (size_t i = 0; i < 2; i++) {
    ScrStr *name = scr_str_new(keys[i], strlen(keys[i]));
    ScrDyn *key = scr_dyn_new_str(name);
    assert(!scr_dyn_reflect_set(target, key, write, other));
    assert(!scr_exc_pending() && !scr_dyn_has_own_computed(other, key));
    scr_dyn_release(key); scr_str_release(name);
  }
  scr_dyn_release(write); scr_dyn_release(other); scr_dyn_release(target);

  scr_str_release(missing);
  scr_str_release(zero);
  scr_str_release(value);
  scr_dyn_release(root);
  scr_context_cleanup();
  return NULL;
}

static void check_published_capsules(void) {
  static const ScrDynNativeObjectOps native_ops = {0};
  ScrStr *name = scr_str_new("value", 5), *class_name = scr_str_new("PublishedValue", 14);
  ScrStr *names[] = {name};
  const ScrDynTypedRecordOps record_ops = {
    .count = 1, .names = names, .has = capsule_record_has, .get = capsule_record_get, .fixed = true,
  };
  const ScrDynTypedClassOps class_ops = {.count = 1, .names = names, .class_name = class_name};
  ScrArr *storage = scr_arr_new(SCR_ELEM_F64, 1);
  scr_arr_push_f64(storage, 17);
  scr_publish(storage, publish_array);
  assert(storage->rc == SIZE_MAX && !scr_exc_pending());
  ScrDyn *array = scr_dyn_new_typed_ref(storage, scr_arr_retain_v, scr_arr_release_v,
      "array<f64>", 10, capsule_array_view, NULL);
  scr_dyn_typed_ref_bind_array(array, &capsule_array_ops);
  ScrDyn *record = scr_dyn_new_typed_ref(&capsule_source, capsule_source_retain, capsule_source_release,
      "record", 6, capsule_source_view, NULL);
  scr_dyn_typed_ref_bind_record(record, &record_ops);
  scr_dyn_typed_ref_bind_native_object(record, &native_ops);
  /* Distinct source identities keep the message graph's alias interning honest. */
  static struct { size_t rc; double value; } class_source = {SIZE_MAX, 23};
  ScrDyn *klass = scr_dyn_new_typed_ref(&class_source, capsule_source_retain, capsule_source_release,
      "class", 5, capsule_source_view, NULL);
  scr_dyn_typed_ref_bind_class(klass, &class_ops);
  scr_dyn_typed_ref_bind_native_object(klass, &native_ops);
  static struct { size_t rc; double value; } opaque_source = {SIZE_MAX, 41};
  ScrDyn *opaque = scr_dyn_new_typed_ref(&opaque_source, capsule_source_retain, capsule_source_release,
      "opaque", 6, capsule_source_view, NULL);
  scr_dyn_typed_ref_bind_native_object(opaque, &native_ops);
  ScrDyn *root = scr_dyn_new_obj();
  scr_dyn_obj_set(root, "array", 5, array);
  scr_dyn_obj_set(root, "record", 6, record);
  scr_dyn_obj_set(root, "class", 5, klass);
  scr_dyn_obj_set(root, "opaque", 6, opaque);
  /* Populate sender-owned caches before encoding; the recipient must create
   * its own views after the sender graph and these caches have been freed. */
  capsule_snapshots = 0;
  ScrDyn *capsules[] = {array, record, klass};
  for (size_t i = 0; i < sizeof capsules / sizeof *capsules; i++) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(capsules[i]);
    assert(view == capsules[i]->v.typed_ref.materialized && !scr_exc_pending());
    scr_dyn_release(view);
  }
  assert(capsule_snapshots == 3);
  CapsuleMessage sent = {.message = scr_message_encode(root), .record_ops = &record_ops,
      .class_ops = &class_ops, .native_ops = &native_ops};
  assert(sent.message && !scr_exc_pending());
  scr_dyn_release(root);
  scr_collect_cycles();
  pthread_t receiver;
  assert(pthread_create(&receiver, NULL, receive_capsules, &sent) == 0);
  assert(pthread_join(receiver, NULL) == 0);
  scr_message_free(sent.message);
  scr_str_release(name);
  scr_str_release(class_name);
}

static void check_prototype_metadata_clone(void) {
  ScrDyn *prototype = scr_dyn_new_obj();
  prototype->v.obj.class_name = "Unobserved";
  scr_dyn_release(scr_dyn_freeze(prototype));
  ScrMessage *message = scr_message_encode(prototype);
  assert(message && !scr_exc_pending());
  ScrDyn *copy = scr_message_decode(message);
  assert(copy && copy != prototype && copy->kind == SCR_DYN_OBJ);
  assert(!copy->v.obj.class_name && !copy->prototype);
  scr_dyn_release(copy); scr_message_free(message); scr_dyn_release(prototype);
  ScrDyn *fresh = scr_dyn_new_obj();
  assert(!fresh->v.obj.class_name);
  scr_dyn_release(fresh);
}

int main(void) {
  scr_init();
  scr_lib_init(0, NULL);
  ScrDyn *source = make_graph();
  ScrMessage *message = scr_message_encode(source);
  assert(message && !scr_exc_pending());
  scr_dyn_release(source);
  /* The sender's graph is gone before any recipient starts decoding. */
  scr_collect_cycles();
  pthread_t receiver;
  assert(pthread_create(&receiver, NULL, receive_graph, message) == 0);
  assert(pthread_join(receiver, NULL) == 0);
  scr_message_free(message);
  check_getters();
  check_rejection();
  check_documents();
  check_published_capsules();
  check_prototype_metadata_clone();
  scr_context_cleanup();
  puts("message graphs preserve identity, sparse values, byte aliases and getter order");
}
