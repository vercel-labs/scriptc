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
  scr_context_cleanup();
  puts("message graphs preserve identity, sparse values, byte aliases and getter order");
}
