#include "scr_message.h"

#include <stdlib.h>

typedef enum {
  SCR_MESSAGE_UNDEFINED,
  SCR_MESSAGE_NULL,
  SCR_MESSAGE_BOOL,
  SCR_MESSAGE_NUMBER,
  SCR_MESSAGE_STRING,
  SCR_MESSAGE_BIGINT,
  SCR_MESSAGE_ARRAY,
  SCR_MESSAGE_OBJECT,
  SCR_MESSAGE_STORAGE,
  SCR_MESSAGE_BYTES,
  SCR_MESSAGE_ARRAY_BUFFER,
  SCR_MESSAGE_ERROR,
} ScrMessageKind;

typedef struct {
  char *key;
  size_t length;
  size_t value;
} ScrMessageProperty;

typedef struct {
  ScrMessageKind kind;
  double number;
  unsigned char *data;
  ScrSharedBytes *shared;
  size_t length;
  ScrMessageProperty *properties;
  size_t count;
  size_t capacity;
  size_t storage;
  size_t offset;
  ScrBytesElem element;
  bool data_view;
} ScrMessageNode;

struct ScrMessage {
  ScrMessageNode *nodes;
  size_t count;
  size_t capacity;
};

typedef struct {
  const ScrDyn *input;
  ScrDyn *view;
  ScrDyn *keys;
  size_t cursor;
} ScrMessageVisit;

typedef struct {
  const void *identity;
  unsigned domain;
  size_t node;
} ScrMessageIdentity;

typedef struct {
  ScrMessage *message;
  ScrMessageVisit *visits;
  ScrMessageIdentity *identities;
  size_t identity_count;
  size_t identity_capacity;
  size_t *stack;
  size_t depth;
  size_t stack_capacity;
} ScrMessageEncoder;

static void *scr_message_alloc(size_t count, size_t size) {
  if (count > SIZE_MAX / size) scr_trap("scriptc: message too large\n");
  void *data = calloc(count ? count : 1, size);
  if (!data) scr_trap("scriptc: out of memory\n");
  return data;
}

static size_t scr_message_grow(size_t capacity) {
  if (capacity > SIZE_MAX / 2) scr_trap("scriptc: message too large\n");
  return capacity ? capacity * 2 : 16;
}

static unsigned char *scr_message_copy(const void *data, size_t length) {
  if (length == SIZE_MAX) scr_trap("scriptc: message too large\n");
  unsigned char *copy = scr_message_alloc(length + 1, 1);
  if (length) memcpy(copy, data, length);
  return copy;
}

static size_t scr_message_node(ScrMessageEncoder *encoder) {
  ScrMessage *message = encoder->message;
  if (message->count == message->capacity) {
    size_t capacity = scr_message_grow(message->capacity);
    ScrMessageNode *nodes = scr_message_alloc(capacity, sizeof(*nodes));
    ScrMessageVisit *visits = scr_message_alloc(capacity, sizeof(*visits));
    if (message->count) {
      memcpy(nodes, message->nodes, message->count * sizeof(*nodes));
      memcpy(visits, encoder->visits, message->count * sizeof(*visits));
    }
    free(message->nodes);
    free(encoder->visits);
    message->nodes = nodes;
    encoder->visits = visits;
    message->capacity = capacity;
  }
  return message->count++;
}

static size_t scr_message_hash(const void *identity, unsigned domain) {
  uintptr_t value = (uintptr_t)identity;
  value ^= value >> 16;
  value *= (uintptr_t)0x45d9f3b;
  value ^= value >> 16;
  return (size_t)value ^ domain;
}

static size_t scr_message_find(const ScrMessageEncoder *encoder, const void *identity,
                                unsigned domain) {
  if (!identity || !encoder->identity_capacity) return SIZE_MAX;
  size_t slot = scr_message_hash(identity, domain) & (encoder->identity_capacity - 1);
  while (encoder->identities[slot].identity) {
    const ScrMessageIdentity *entry = &encoder->identities[slot];
    if (entry->identity == identity && entry->domain == domain) return entry->node;
    slot = (slot + 1) & (encoder->identity_capacity - 1);
  }
  return SIZE_MAX;
}

static void scr_message_identify(ScrMessageEncoder *encoder, const void *identity,
                                  unsigned domain, size_t node) {
  if (!identity) return;
  if (encoder->identity_count >= encoder->identity_capacity / 2) {
    size_t capacity = scr_message_grow(encoder->identity_capacity);
    ScrMessageIdentity *entries = scr_message_alloc(capacity, sizeof(*entries));
    for (size_t i = 0; i < encoder->identity_capacity; i++) {
      ScrMessageIdentity entry = encoder->identities[i];
      if (!entry.identity) continue;
      size_t slot = scr_message_hash(entry.identity, entry.domain) & (capacity - 1);
      while (entries[slot].identity) slot = (slot + 1) & (capacity - 1);
      entries[slot] = entry;
    }
    free(encoder->identities);
    encoder->identities = entries;
    encoder->identity_capacity = capacity;
  }
  size_t slot = scr_message_hash(identity, domain) & (encoder->identity_capacity - 1);
  while (encoder->identities[slot].identity) slot = (slot + 1) & (encoder->identity_capacity - 1);
  encoder->identities[slot] = (ScrMessageIdentity){identity, domain, node};
  encoder->identity_count++;
}

static void scr_message_push(ScrMessageEncoder *encoder, size_t node) {
  if (encoder->depth == encoder->stack_capacity) {
    size_t capacity = scr_message_grow(encoder->stack_capacity);
    size_t *stack = scr_message_alloc(capacity, sizeof(*stack));
    if (encoder->depth) memcpy(stack, encoder->stack, encoder->depth * sizeof(*stack));
    free(encoder->stack);
    encoder->stack = stack;
    encoder->stack_capacity = capacity;
  }
  encoder->stack[encoder->depth++] = node;
}

static size_t scr_message_storage(ScrMessageEncoder *encoder, const ScrBytes *bytes) {
  const ScrBytes *owner = bytes->backing ? bytes->backing : bytes;
  size_t found = scr_message_find(encoder, owner, SCR_MESSAGE_STORAGE + 1);
  if (found != SIZE_MAX) return found;
  size_t node = scr_message_node(encoder);
  scr_message_identify(encoder, owner, SCR_MESSAGE_STORAGE + 1, node);
  ScrMessageNode *storage = &encoder->message->nodes[node];
  storage->kind = SCR_MESSAGE_STORAGE;
  size_t size = scr_bytes_elem_size(owner->elem);
  if (owner->len > SIZE_MAX / size) scr_trap("scriptc: message too large\n");
  storage->length = owner->len * size;
  if (owner->shared) storage->shared = scr_shared_retain(owner->shared);
  else storage->data = scr_message_copy(owner->data, storage->length);
  return node;
}

static size_t scr_message_value(ScrMessageEncoder *encoder, const ScrDyn *input) {
  const void *identity = NULL;
  unsigned domain = 0;
  switch (input->kind) {
  case SCR_DYN_TYPED_REF: identity = input->v.typed_ref.ptr; domain = 1; break;
  case SCR_DYN_OBJ:
    identity = input->v.obj.source_identity ? input->v.obj.source_identity : input;
    domain = input->v.obj.source_identity ? 1 : 2;
    break;
  case SCR_DYN_ARR: identity = input; domain = 2; break;
  case SCR_DYN_BYTES: identity = input->v.bytes; domain = 3; break;
  case SCR_DYN_HANDLE: identity = input->v.handle.ptr; domain = 4; break;
  default: break;
  }
  size_t found = scr_message_find(encoder, identity, domain);
  if (found != SIZE_MAX) return found;
  size_t id = scr_message_node(encoder);
  scr_message_identify(encoder, identity, domain, id);
  encoder->visits[id].input = scr_dyn_retain((ScrDyn *)input);
  ScrDyn *value = input->kind == SCR_DYN_TYPED_REF
      ? scr_dyn_typed_ref_materialize(input) : (ScrDyn *)input;
  encoder->visits[id].view = value;
  if (!value || scr_exc_pending()) return SIZE_MAX;
  ScrMessageNode *node = &encoder->message->nodes[id];
  ScrError *error = scr_errdyn_err_of(input);
  if (!error && value != input) error = scr_errdyn_err_of(value);
  if (error) {
    node->kind = SCR_MESSAGE_ERROR;
    node->number = SCR_ERR_ERROR;
    static const char *const names[] = {
      "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError",
    };
    static const int kinds[] = {
      SCR_ERR_ERROR, SCR_ERR_TYPE, SCR_ERR_RANGE, SCR_ERR_SYNTAX, SCR_ERR_REFERENCE, SCR_ERR_EVAL, SCR_ERR_URI,
    };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
      if (error->name->len == strlen(names[i]) && !memcmp(error->name->data, names[i], error->name->len))
        node->number = kinds[i];
    ScrDyn *keys = scr_dyn_new_arr();
    static const char *const fields[] = {"message", "stack", "cause"};
    for (size_t i = 0; i < sizeof fields / sizeof fields[0]; i++) {
      if (!scr_dyn_obj_get(value, fields[i], strlen(fields[i]))) continue;
      ScrStr *key = scr_str_new(fields[i], strlen(fields[i]));
      scr_dyn_arr_push(keys, scr_dyn_new_str(key));
      scr_str_release(key);
    }
    encoder->visits[id].keys = keys;
    scr_error_release(error);
    scr_message_push(encoder, id);
    return id;
  }
  switch (value->kind) {
  case SCR_DYN_UNDEF: node->kind = SCR_MESSAGE_UNDEFINED; break;
  case SCR_DYN_NULL: node->kind = SCR_MESSAGE_NULL; break;
  case SCR_DYN_BOOL: node->kind = SCR_MESSAGE_BOOL; node->number = value->v.b; break;
  case SCR_DYN_NUM: node->kind = SCR_MESSAGE_NUMBER; node->number = value->v.num; break;
  case SCR_DYN_STR:
    node->kind = SCR_MESSAGE_STRING;
    node->length = value->v.str->len;
    node->data = scr_message_copy(value->v.str->data, node->length);
    break;
  case SCR_DYN_BIGINT: {
    ScrStr *text = scr_bigint_to_string(value->v.bigint, 10);
    if (!text) return SIZE_MAX;
    node->kind = SCR_MESSAGE_BIGINT;
    node->length = text->len;
    node->data = scr_message_copy(text->data, text->len);
    scr_str_release(text);
    break;
  }
  case SCR_DYN_ARR:
  case SCR_DYN_OBJ:
    node->kind = value->kind == SCR_DYN_ARR ? SCR_MESSAGE_ARRAY : SCR_MESSAGE_OBJECT;
    node->length = value->kind == SCR_DYN_ARR ? value->v.arr.len : 0;
    encoder->visits[id].keys = scr_dyn_own_keys(value);
    if (!encoder->visits[id].keys) return SIZE_MAX;
    scr_message_push(encoder, id);
    break;
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE: {
    bool buffer = scr_buffer_storage_is(value);
    if (value->kind == SCR_DYN_HANDLE && !buffer) goto unsupported;
    const ScrBytes *bytes = buffer ? value->v.handle.ptr : value->v.bytes;
    size_t storage = scr_message_storage(encoder, bytes);
    /* Adding the storage node can reallocate the node array. */
    node = &encoder->message->nodes[id];
    node->kind = buffer ? SCR_MESSAGE_ARRAY_BUFFER : SCR_MESSAGE_BYTES;
    node->storage = storage;
    node->element = bytes->elem;
    node->length = bytes->len;
    node->offset = (size_t)(bytes->data - (bytes->backing ? bytes->backing : bytes)->data);
    node->data_view = bytes->is_data_view;
    break;
  }
  default:
unsupported:
    scr_throw_domex("DataCloneError", "The value could not be cloned.");
    return SIZE_MAX;
  }
  return id;
}

static void scr_message_property(ScrMessageEncoder *encoder, size_t id,
                                  const ScrStr *key, size_t value) {
  ScrMessageNode *node = &encoder->message->nodes[id];
  if (node->count == node->capacity) {
    size_t capacity = scr_message_grow(node->capacity);
    ScrMessageProperty *properties = scr_message_alloc(capacity, sizeof(*properties));
    if (node->count) memcpy(properties, node->properties, node->count * sizeof(*properties));
    free(node->properties);
    node->properties = properties;
    node->capacity = capacity;
  }
  node->properties[node->count++] = (ScrMessageProperty){
    (char *)scr_message_copy(key->data, key->len), key->len, value,
  };
}

ScrMessage *scr_message_encode(const ScrDyn *value) {
  ScrMessage *message = scr_message_alloc(1, sizeof(*message));
  ScrMessageEncoder encoder = {.message = message};
  if (scr_message_value(&encoder, value) == SIZE_MAX) goto done;
  while (encoder.depth && !scr_exc_pending()) {
    size_t id = encoder.stack[encoder.depth - 1];
    ScrMessageVisit *visit = &encoder.visits[id];
    if (visit->cursor == visit->keys->v.arr.len) { encoder.depth--; continue; }
    ScrDyn *key = visit->keys->v.arr.items[visit->cursor++];
    if (key->kind != SCR_DYN_STR ||
        (message->nodes[id].kind != SCR_MESSAGE_ERROR && !scr_dyn_property_is_enumerable(visit->view, key->v.str))) continue;
    ScrDyn *child = scr_dyn_bag_get(visit->view, key->v.str, visit->view);
    if (!child || scr_exc_pending()) { scr_dyn_release(child); break; }
    size_t next = scr_message_value(&encoder, child);
    scr_dyn_release(child);
    if (next == SIZE_MAX) break;
    scr_message_property(&encoder, id, key->v.str, next);
  }
done:
  for (size_t i = 0; i < message->count; i++) {
    ScrMessageVisit *visit = &encoder.visits[i];
    scr_dyn_release(visit->keys);
    if (visit->view != visit->input) scr_dyn_release(visit->view);
    scr_dyn_release((ScrDyn *)visit->input);
  }
  free(encoder.visits);
  free(encoder.identities);
  free(encoder.stack);
  if (scr_exc_pending()) { scr_message_free(message); return NULL; }
  return message;
}

static size_t scr_message_array_index(const char *key, size_t length, size_t limit) {
  if (!length || (length > 1 && key[0] == '0')) return SIZE_MAX;
  size_t index = 0;
  for (size_t i = 0; i < length; i++) {
    unsigned digit = (unsigned char)key[i] - '0';
    if (digit > 9 || index > (SIZE_MAX - digit) / 10) return SIZE_MAX;
    index = index * 10 + digit;
  }
  return index < limit ? index : SIZE_MAX;
}

ScrDyn *scr_message_decode(const ScrMessage *message) {
  ScrDyn **values = scr_message_alloc(message->count, sizeof(*values));
  ScrBytes **storage = scr_message_alloc(message->count, sizeof(*storage));
  for (size_t i = 0; i < message->count; i++) {
    const ScrMessageNode *node = &message->nodes[i];
    if (node->kind != SCR_MESSAGE_STORAGE) continue;
    storage[i] = node->shared ? scr_shared_wrap(node->shared) : scr_bytes_new(SCR_BYTES_U8, (double)node->length);
    if (!storage[i]) goto done;
    if (!node->shared && node->length) memcpy(storage[i]->data, node->data, node->length);
  }
  for (size_t i = 0; i < message->count; i++) {
    const ScrMessageNode *node = &message->nodes[i];
    switch (node->kind) {
    case SCR_MESSAGE_UNDEFINED: values[i] = scr_dyn_retain(scr_dyn_undefined()); break;
    case SCR_MESSAGE_NULL: values[i] = scr_dyn_new_null(); break;
    case SCR_MESSAGE_BOOL: values[i] = scr_dyn_new_bool(node->number != 0); break;
    case SCR_MESSAGE_NUMBER: values[i] = scr_dyn_new_num(node->number); break;
    case SCR_MESSAGE_STRING:
    case SCR_MESSAGE_BIGINT: {
      ScrStr *text = scr_str_new((const char *)node->data, node->length);
      if (node->kind == SCR_MESSAGE_STRING) values[i] = scr_dyn_new_str(text);
      else {
        ScrBigInt *integer = scr_bigint_parse(text);
        if (integer) { values[i] = scr_dyn_new_bigint(integer); scr_bigint_release(integer); }
      }
      scr_str_release(text);
      break;
    }
    case SCR_MESSAGE_ARRAY:
      values[i] = scr_dyn_new_arr();
      for (size_t j = 0; j < node->length; j++) scr_dyn_arr_push_hole(values[i]);
      break;
    case SCR_MESSAGE_OBJECT: values[i] = scr_dyn_new_obj(); break;
    case SCR_MESSAGE_ERROR: {
      scr_error_set_traced();
      ScrError *error = scr_error_new((int)node->number, NULL);
      values[i] = scr_dyn_from_error(error);
      scr_error_release(error);
      break;
    }
    case SCR_MESSAGE_BYTES: {
      ScrBytes *bytes = scr_bytes_buffer_view(storage[node->storage], node->element,
          (double)node->offset, true, (double)node->length);
      if (bytes) {
        bytes->is_data_view = node->data_view;
        values[i] = scr_dyn_new_bytes(bytes);
        scr_bytes_release(bytes);
      }
      break;
    }
    case SCR_MESSAGE_ARRAY_BUFFER:
      values[i] = scr_array_buffer_from_bytes(storage[node->storage]);
      break;
    case SCR_MESSAGE_STORAGE: continue;
    }
    if (!values[i] || scr_exc_pending()) goto done;
  }
  for (size_t i = 0; i < message->count; i++) {
    const ScrMessageNode *node = &message->nodes[i];
    for (size_t j = 0; j < node->count; j++) {
      const ScrMessageProperty *property = &node->properties[j];
      ScrDyn *value = scr_dyn_retain(values[property->value]);
      if (node->kind == SCR_MESSAGE_ARRAY) {
        size_t index = scr_message_array_index(property->key, property->length, node->length);
        if (index != SIZE_MAX) {
          values[i]->v.arr.items[index] = value;
          values[i]->v.arr.presence[index] = 1;
          continue;
        }
        if (!values[i]->v.arr.properties) values[i]->v.arr.properties = scr_dyn_new_obj();
        scr_dyn_obj_set(values[i]->v.arr.properties, property->key, property->length, value);
      } else scr_dyn_obj_set(values[i], property->key, property->length, value);
    }
    if (node->kind == SCR_MESSAGE_ERROR) {
      for (size_t j = 0; j < values[i]->v.obj.len; j++) values[i]->v.obj.entries[j].enumerable = false;
      ScrError *error = scr_errdyn_err_of(values[i]);
      scr_error_commit_dyn(error, values[i]);
      scr_error_release(error);
    }
  }
done:;
  ScrDyn *result = !scr_exc_pending() ? scr_dyn_retain(values[0]) : NULL;
  for (size_t i = 0; i < message->count; i++) {
    scr_dyn_release(values[i]);
    scr_bytes_release(storage[i]);
  }
  free(values);
  free(storage);
  return result;
}

void scr_message_free(ScrMessage *message) {
  if (!message) return;
  for (size_t i = 0; i < message->count; i++) {
    ScrMessageNode *node = &message->nodes[i];
    for (size_t j = 0; j < node->count; j++) free(node->properties[j].key);
    free(node->properties);
    free(node->data);
    scr_shared_release(node->shared);
  }
  free(message->nodes);
  free(message);
}
