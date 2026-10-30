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

/* A message larger than the encoder's inline arrays (nodes, properties,
 * identities and the visit stack) keeps its key order, shared values and
 * text, and an encode started from a getter during another encode
 * produces its own message. */
static SCR_TL ScrMessage *nested_message;
static ScrDyn *nested_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *inner = scr_dyn_new_arr();
  scr_dyn_arr_push(inner, scr_dyn_new_num(41));
  nested_message = scr_message_encode(inner);
  scr_dyn_release(inner);
  return scr_dyn_new_num(42);
}

static void check_large(void) {
  ScrDyn *root = scr_dyn_new_obj();
  ScrDyn *shared = scr_dyn_new_obj();
  put_number(shared, "shared", 1);
  ScrDyn *chain = root;
  char key[32];
  for (int i = 0; i < 40; i++) {
    ScrDyn *item = scr_dyn_new_obj();
    put_number(item, "index", i);
    snprintf(key, sizeof key, "label-%d", i);
    ScrStr *text = scr_str_new(key, strlen(key));
    scr_dyn_obj_set(item, "label", 5, scr_dyn_new_str(text));
    scr_str_release(text);
    scr_dyn_obj_set(item, "shared", 6, scr_dyn_retain(shared));
    snprintf(key, sizeof key, "item%d", i);
    scr_dyn_obj_set(root, key, strlen(key), item);
    /* A chain 40 objects deep grows the visit stack. */
    ScrDyn *next = scr_dyn_new_obj();
    scr_dyn_obj_set(chain, "next", 4, next);
    chain = next;
  }
  scr_dyn_release(shared);
  ScrClosure *closure = scr_closure_new(NULL, 0);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_new_func(closure, nested_getter, 0, "", ""));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  ScrStr *name = scr_str_new("nested", 6);
  ScrDyn *name_value = scr_dyn_new_str(name);
  scr_dyn_release(scr_dyn_define_property(root, name_value, descriptor));
  scr_dyn_release(name_value);
  scr_dyn_release(descriptor);
  scr_str_release(name);
  ScrMessage *message = scr_message_encode(root);
  assert(message && !scr_exc_pending() && nested_message);
  scr_dyn_release(root);
  scr_collect_cycles();
  ScrDyn *decoded = scr_message_decode(message);
  assert(decoded && !scr_exc_pending());
  assert(decoded->v.obj.len == 42);
  size_t member_len;
  const char *member = scr_dyn_obj_key_at(decoded, 0, &member_len);
  assert(member_len == 5 && !memcmp(member, "item0", 5));
  member = scr_dyn_obj_key_at(decoded, 41, &member_len);
  assert(member_len == 6 && !memcmp(member, "nested", 6));
  assert(scr_dyn_obj_get(decoded, "nested", 6)->v.num == 42);
  ScrDyn *first = scr_dyn_obj_get(decoded, "item0", 5);
  for (int i = 0; i < 40; i++) {
    snprintf(key, sizeof key, "item%d", i);
    ScrDyn *item = scr_dyn_obj_get(decoded, key, strlen(key));
    assert(item && scr_dyn_obj_get(item, "index", 5)->v.num == i);
    assert(scr_dyn_obj_get(item, "shared", 6) == scr_dyn_obj_get(first, "shared", 6));
    snprintf(key, sizeof key, "label-%d", i);
    ScrStr *label = scr_dyn_obj_get(item, "label", 5)->v.str;
    assert(label->len == strlen(key) && !memcmp(label->data, key, label->len));
  }
  ScrDyn *link = decoded;
  for (int i = 0; i < 40; i++) link = scr_dyn_obj_get(link, "next", 4);
  assert(link && link->kind == SCR_DYN_OBJ && link->v.obj.len == 0);
  scr_dyn_release(decoded);
  ScrDyn *inner = scr_message_decode(nested_message);
  assert(inner && inner->v.arr.len == 1 && inner->v.arr.items[0]->v.num == 41);
  scr_dyn_release(inner);
  scr_collect_cycles();
  scr_message_free(nested_message);
  scr_message_free(message);
}

/* The readers compiled 'message' listeners use: node kinds and values, a
 * record's keys in order, and which messages they may read. */
static void check_readers(void) {
  ScrDyn *root = scr_dyn_new_obj();
  put_number(root, "id", 7);
  ScrStr *text = scr_str_new("seven", 5);
  scr_dyn_obj_set(root, "name", 4, scr_dyn_new_str(text));
  scr_str_release(text);
  scr_dyn_obj_set(root, "done", 4, scr_dyn_new_bool(true));
  ScrMessage *message = scr_message_encode(root);
  assert(message && scr_message_readable(message));
  assert(scr_message_kind(message, 0) == SCR_MESSAGE_OBJECT);
  static const char *const names[] = {"id", "name", "done"};
  static const size_t lengths[] = {2, 4, 4};
  size_t values[3];
  assert(scr_message_fields(message, 0, names, lengths, 3, values));
  assert(scr_message_kind(message, values[0]) == SCR_MESSAGE_NUMBER);
  assert(scr_message_number(message, values[0]) == 7);
  assert(scr_message_kind(message, values[1]) == SCR_MESSAGE_STRING);
  ScrStr *name = scr_message_string(message, values[1]);
  assert(name->len == 5 && !memcmp(name->data, "seven", 5));
  scr_str_release(name);
  assert(scr_message_kind(message, values[2]) == SCR_MESSAGE_BOOL);
  assert(scr_message_number(message, values[2]) == 1);
  /* Another order, a missing key or an extra key does not match. */
  static const char *const reordered[] = {"name", "id", "done"};
  static const size_t reordered_lengths[] = {4, 2, 4};
  assert(!scr_message_fields(message, 0, reordered, reordered_lengths, 3, values));
  assert(!scr_message_fields(message, 0, names, lengths, 2, values));
  assert(!scr_message_fields(message, values[0], names, lengths, 3, values));
  scr_message_free(message);
  put_number(root, "extra", 1);
  message = scr_message_encode(root);
  assert(!scr_message_fields(message, 0, names, lengths, 3, values));
  scr_message_free(message);
  /* A value reached twice makes the message unreadable. */
  ScrDyn *shared = scr_dyn_new_obj();
  scr_dyn_obj_set(root, "first", 5, scr_dyn_retain(shared));
  scr_dyn_obj_set(root, "second", 6, shared);
  message = scr_message_encode(root);
  assert(message && !scr_message_readable(message));
  scr_message_free(message);
  scr_dyn_release(root);
  scr_collect_cycles();
}

/* A link-gated unit's handle crosses threads through the transfer hooks in
 * its ops: share on the sender, adopt on the receiver, drop with the
 * message. The test borrows the last capacity slot, which no unit uses, so
 * it also proves that slots past the tags in use work. */
#define TRANSFER_TAG ((ScrDynHandleTag)(SCR_DYNH_CAPACITY - 1))
typedef struct {
  _Atomic size_t rc;
  int value;
} TransferBox;
static _Atomic int transfer_shares, transfer_adopts, transfer_drops;
static void *transfer_retain(void *h) {
  ((TransferBox *)h)->rc++;
  return h;
}
static void transfer_release(void *h) {
  if (--((TransferBox *)h)->rc == 0) free(h);
}
static void *transfer_share(void *h) {
  TransferBox *source = h;
  if (source->value < 0) return NULL;
  transfer_shares++;
  TransferBox *copy = malloc(sizeof *copy);
  copy->rc = 1;
  copy->value = source->value;
  return copy;
}
static ScrDyn *transfer_adopt(void *payload) {
  transfer_adopts++;
  return scr_dyn_new_handle(payload, TRANSFER_TAG);
}
static void transfer_drop(void *payload) {
  transfer_drops++;
  transfer_release(payload);
}
static const ScrDynHandleTransfer transfer_hooks = {transfer_share, transfer_adopt, transfer_drop};
static const ScrDynHandleOps transfer_ops = {
    .cls = "Transferable",
    .retain = transfer_retain,
    .release = transfer_release,
    .transfer = &transfer_hooks,
};
static const ScrDynHandleOps opaque_ops = {
    .cls = "Opaque",
    .retain = transfer_retain,
    .release = transfer_release,
};

static void *receive_handles(void *data) {
  scr_context_enter(1);
  scr_init();
  scr_lib_init(0, NULL);
  scr_dyn_handle_install(TRANSFER_TAG, &transfer_ops);
  ScrDyn *root = scr_message_decode(data);
  assert(root && !scr_exc_pending());
  ScrDyn *first = scr_dyn_obj_get(root, "first", 5);
  assert(first->kind == SCR_DYN_HANDLE && first->v.handle.tag == TRANSFER_TAG);
  assert(((TransferBox *)first->v.handle.ptr)->value == 7);
  /* One handle reached twice decodes to one box. */
  assert(first == scr_dyn_obj_get(root, "again", 5));
  assert(transfer_adopts == 1);
  scr_dyn_release(root);
  scr_collect_cycles();
  scr_context_cleanup();
  return NULL;
}

static ScrDyn *transfer_handle(int value, const ScrDynHandleOps *ops) {
  scr_dyn_handle_install(TRANSFER_TAG, ops);
  TransferBox *box = malloc(sizeof *box);
  box->rc = 1;
  box->value = value;
  ScrDyn *handle = scr_dyn_new_handle(box, TRANSFER_TAG);
  transfer_release(box);
  return handle;
}

static void check_handle_transfer(void) {
  ScrDyn *root = scr_dyn_new_obj();
  ScrDyn *handle = transfer_handle(7, &transfer_ops);
  scr_dyn_obj_set(root, "first", 5, scr_dyn_retain(handle));
  scr_dyn_obj_set(root, "again", 5, handle);
  ScrMessage *message = scr_message_encode(root);
  assert(message && !scr_exc_pending());
  assert(transfer_shares == 1);
  scr_dyn_release(root);
  pthread_t receiver;
  assert(pthread_create(&receiver, NULL, receive_handles, message) == 0);
  assert(pthread_join(receiver, NULL) == 0);
  assert(transfer_drops == 0);
  scr_message_free(message);
  assert(transfer_drops == 1);

  /* A handle whose unit declines (share answers NULL) and a handle with no
   * transfer hooks both throw DataCloneError, releasing what was shared. */
  root = scr_dyn_new_arr();
  scr_dyn_arr_push(root, transfer_handle(1, &transfer_ops));
  scr_dyn_arr_push(root, transfer_handle(-1, &transfer_ops));
  assert(!scr_message_encode(root) && scr_exc_pending());
  scr_exc_clear();
  assert(transfer_shares == 2 && transfer_drops == 2);
  scr_dyn_release(root);
  root = transfer_handle(3, &opaque_ops);
  assert(!scr_message_encode(root) && scr_exc_pending());
  scr_exc_clear();
  assert(transfer_shares == 2);
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
  check_documents();
  check_large();
  check_readers();
  check_handle_transfer();
  scr_context_cleanup();
  puts("message graphs preserve identity, sparse values, byte aliases and getter order");
  puts("native handles cross threads through their transfer hooks");
}
