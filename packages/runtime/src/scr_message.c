#include "scr_message.h"

#include <stdio.h>
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
  /* A deeply frozen plain-data graph shared by pointer (see publication). */
  SCR_MESSAGE_PUBLISHED,
  /* A typed value published with @scriptc/threads (immortal), delivered as
   * a fresh typed-ref capsule over the same pointer. */
  SCR_MESSAGE_TYPED_REF,
  /* A transferred MessagePort: its channel end (+1), the side in number. */
  SCR_MESSAGE_PORT,
} ScrMessageKind;

const ScrMessagePortOps *scr_message_port_ops = NULL;

typedef struct {
  char *key;
  size_t length;
  size_t value;
  bool hidden; /* an Error's non-enumerable or inherited property */
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
  ScrDyn *published; /* SCR_MESSAGE_PUBLISHED: immortal root, owns nothing */
  ScrChannel *channel; /* SCR_MESSAGE_PORT */
  /* SCR_MESSAGE_TYPED_REF: the capsule's process-wide adapters and type key
   * (vtables, adapters and type keys are shared by every thread). */
  struct {
    void *ptr;
    void *(*retain)(void *);
    void (*release)(void *);
    const char *type_key;
    size_t type_key_len;
    ScrDyn *(*materialize)(void *);
    void (*commit)(void *, const ScrDyn *);
    bool traced;
  } typed;
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
  bool uncaught; /* an Error encoded as an uncaught exception */
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
  const ScrDyn *transfer; /* the transfer list (a dyn array), or NULL */
  bool uncaught; /* the next value is an uncaught exception or its cause */
} ScrMessageEncoder;

static bool scr_message_listed(const ScrMessageEncoder *encoder, const ScrDyn *value) {
  if (!encoder->transfer) return false;
  for (size_t i = 0; i < encoder->transfer->v.arr.len; i++) {
    const ScrDyn *item = encoder->transfer->v.arr.items[i];
    if (item && item->kind == SCR_DYN_HANDLE && item->v.handle.ptr == value->v.handle.ptr) return true;
  }
  return false;
}

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

/* The nearest built-in constructor an uncaught Error keeps: Node's
 * serializer knows Error and its six native subclasses. */
static int scr_message_error_kind(const ScrError *error) {
  static const int kinds[] = {
    SCR_ERR_TYPE, SCR_ERR_RANGE, SCR_ERR_SYNTAX, SCR_ERR_REFERENCE, SCR_ERR_EVAL, SCR_ERR_URI,
  };
  for (size_t i = 0; i < sizeof kinds / sizeof kinds[0]; i++)
    if (scr_error_vts[kinds[i]].pre <= error->vt->pre && error->vt->pre <= scr_error_vts[kinds[i]].post)
      return kinds[i];
  return SCR_ERR_ERROR;
}

/* An uncaught Error's keys: name and message, which it may inherit, then
 * its other own properties in order. */
static ScrDyn *scr_message_uncaught_keys(const ScrDyn *view) {
  ScrDyn *own = scr_dyn_get_own_property_names(view);
  if (!own) return NULL;
  ScrDyn *keys = scr_dyn_new_arr();
  static const char *const first[] = {"name", "message"};
  for (size_t i = 0; i < 2; i++) {
    ScrStr *key = scr_str_new(first[i], strlen(first[i]));
    scr_dyn_arr_push(keys, scr_dyn_new_str(key));
    scr_str_release(key);
  }
  for (size_t i = 0; i < own->v.arr.len; i++) {
    const ScrStr *key = own->v.arr.items[i]->v.str;
    if ((key->len == 4 && !memcmp(key->data, "name", 4)) || (key->len == 7 && !memcmp(key->data, "message", 7)) ||
        (key->len && key->data[0] == '%'))
      continue;
    scr_dyn_arr_push(keys, scr_dyn_retain(own->v.arr.items[i]));
  }
  scr_dyn_release(own);
  return keys;
}

static size_t scr_message_value(ScrMessageEncoder *encoder, const ScrDyn *input) {
  bool uncaught = encoder->uncaught;
  encoder->uncaught = false;
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
  /* Published values (immortal) travel by pointer: a typed value as a
   * capsule over the same object, a dyn graph as itself. */
  if (input->kind == SCR_DYN_TYPED_REF && input->v.typed_ref.ptr &&
      *(const size_t *)input->v.typed_ref.ptr == SIZE_MAX) {
    encoder->visits[id].view = (ScrDyn *)input;
    ScrMessageNode *node = &encoder->message->nodes[id];
    node->kind = SCR_MESSAGE_TYPED_REF;
    node->typed.ptr = input->v.typed_ref.ptr;
    node->typed.retain = input->v.typed_ref.retain;
    node->typed.release = input->v.typed_ref.release;
    node->typed.type_key = input->v.typed_ref.type_key;
    node->typed.type_key_len = input->v.typed_ref.type_key_len;
    node->typed.materialize = input->v.typed_ref.materialize;
    node->typed.commit = input->v.typed_ref.commit;
    node->typed.traced = input->v.typed_ref.traced;
    if (getenv("SCRIPTC_PUBLISH_TRACE"))
      fprintf(stderr, "scriptc: published %.*s shared by reference\n", (int)node->typed.type_key_len,
              node->typed.type_key);
    return id;
  }
  if ((input->kind == SCR_DYN_OBJ || input->kind == SCR_DYN_ARR) && input->rc == SIZE_MAX) {
    encoder->visits[id].view = (ScrDyn *)input;
    ScrMessageNode *node = &encoder->message->nodes[id];
    node->kind = SCR_MESSAGE_PUBLISHED;
    node->published = (ScrDyn *)input;
    return id;
  }
  ScrDyn *value = input->kind == SCR_DYN_TYPED_REF
      ? scr_dyn_typed_ref_materialize(input) : (ScrDyn *)input;
  encoder->visits[id].view = value;
  if (!value || scr_exc_pending()) return SIZE_MAX;
  ScrMessageNode *node = &encoder->message->nodes[id];
  ScrError *error = scr_errdyn_err_of(input);
  if (!error && value != input) error = scr_errdyn_err_of(value);
  if (error && uncaught && error->vt != &scr_error_vts[SCR_ERR_DOMEX]) {
    node->kind = SCR_MESSAGE_ERROR;
    node->number = scr_message_error_kind(error);
    scr_error_release(error);
    encoder->visits[id].uncaught = true;
    encoder->visits[id].keys = scr_message_uncaught_keys(value);
    if (!encoder->visits[id].keys) return SIZE_MAX;
    scr_message_push(encoder, id);
    return id;
  }
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
    if (value->kind == SCR_DYN_HANDLE && scr_message_port_ops && scr_message_port_ops->is_port(value)) {
      int side = 0;
      ScrChannel *channel = scr_message_listed(encoder, value)
          ? scr_message_port_ops->channel_of(value, &side) : NULL;
      if (!channel) {
        scr_throw_domex("DataCloneError",
                        "Object that needs transfer was found in message but not listed in transferList");
        return SIZE_MAX;
      }
      node->kind = SCR_MESSAGE_PORT;
      node->channel = channel;
      node->number = side;
      break;
    }
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
                                  const ScrStr *key, size_t value, bool hidden) {
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
    (char *)scr_message_copy(key->data, key->len), key->len, value, hidden,
  };
}


/* ── publication: zero-copy delivery of deeply frozen plain-data graphs ──
 * Structured clone of a graph that is immutable on BOTH sides is observably
 * a share, as long as the receiver freezes what it receives (Node's clone is
 * not frozen) and does not compare identity across messages. A graph whose
 * every object and array is frozen, ordinary (no prototype, accessors,
 * symbols, non-enumerable or native-copied members) and holds only
 * primitives, strings and such containers is published instead of encoded:
 * every node and string becomes immortal (rc == SIZE_MAX: retains and
 * releases skip it, the collector never walks into it, nothing frees it)
 * and the receiver gets the same pointers. Strings cache their Map key hash
 * first, because no thread may write an immortal header. Object keys stay
 * owned by their (never released) entries. SCRIPTC_PUBLISH=0 turns this off
 * for A/B comparisons. */
typedef struct {
  ScrDyn **nodes;
  size_t count, capacity;
  const void **seen;
  size_t seen_count, seen_capacity;
} ScrPublish;

static bool scr_publish_seen(ScrPublish *p, const void *ptr) {
  if (p->seen_count >= p->seen_capacity / 2) {
    size_t capacity = scr_message_grow(p->seen_capacity);
    const void **seen = scr_message_alloc(capacity, sizeof(*seen));
    for (size_t i = 0; i < p->seen_capacity; i++) {
      const void *e = p->seen[i];
      if (!e) continue;
      size_t slot = scr_message_hash(e, 0) & (capacity - 1);
      while (seen[slot]) slot = (slot + 1) & (capacity - 1);
      seen[slot] = e;
    }
    free(p->seen);
    p->seen = seen;
    p->seen_capacity = capacity;
  }
  size_t slot = scr_message_hash(ptr, 0) & (p->seen_capacity - 1);
  while (p->seen[slot]) {
    if (p->seen[slot] == ptr) return true;
    slot = (slot + 1) & (p->seen_capacity - 1);
  }
  p->seen[slot] = ptr;
  p->seen_count++;
  return false;
}

static void scr_publish_push(ScrPublish *p, ScrDyn *node) {
  if (p->count == p->capacity) {
    size_t capacity = scr_message_grow(p->capacity);
    ScrDyn **nodes = scr_message_alloc(capacity, sizeof(*nodes));
    if (p->count) memcpy(nodes, p->nodes, p->count * sizeof(*nodes));
    free(p->nodes);
    p->nodes = nodes;
    p->capacity = capacity;
  }
  p->nodes[p->count++] = node;
}

static bool scr_publish_container_ok(const ScrDyn *d) {
  if (d->prototype || d->symbol_properties || d->symbol_keys || d->copied_from_native) return false;
  if (!scr_dyn_is_frozen(d)) return false;
  if (d->kind == SCR_DYN_ARR) return d->v.arr.properties == NULL;
  if (d->null_proto || d->v.obj.source_identity || d->v.obj.source_access) return false;
  for (size_t i = 0; i < d->v.obj.len; i++) {
    const ScrDynEntry *e = &d->v.obj.entries[i];
    if (e->accessor || !e->enumerable) return false;
  }
  return true;
}

/* Collects the graph's containers and heap strings into p->nodes (strings
 * tagged with the low pointer bit); false when any node is ineligible. */
static bool scr_publish_collect(ScrPublish *p, ScrDyn *root) {
  size_t cursor = p->count;
  if (!scr_publish_seen(p, root)) scr_publish_push(p, root);
  while (cursor < p->count) {
    ScrDyn *d = p->nodes[cursor++];
    if ((uintptr_t)d & 1) continue;
    switch (d->kind) {
    case SCR_DYN_NULL: case SCR_DYN_UNDEF: case SCR_DYN_BOOL: case SCR_DYN_NUM: break;
    case SCR_DYN_STR:
      if (d->v.str->rc != SIZE_MAX && !scr_publish_seen(p, d->v.str))
        scr_publish_push(p, (ScrDyn *)((uintptr_t)d->v.str | 1));
      break;
    case SCR_DYN_ARR:
      if (!scr_publish_container_ok(d)) return false;
      for (size_t i = 0; i < d->v.arr.len; i++) {
        ScrDyn *child = d->v.arr.items[i];
        if (child && !scr_publish_seen(p, child)) scr_publish_push(p, child);
      }
      break;
    case SCR_DYN_OBJ:
      if (!scr_publish_container_ok(d)) return false;
      for (size_t i = 0; i < d->v.obj.len; i++) {
        ScrDyn *child = d->v.obj.entries[i].value;
        if (child && !scr_publish_seen(p, child)) scr_publish_push(p, child);
      }
      break;
    default: return false;
    }
  }
  return true;
}

static int scr_publish_enabled = -1;

static ScrMessage *scr_message_try_publish(const ScrDyn *value) {
  if (scr_publish_enabled < 0) {
    const char *env = getenv("SCRIPTC_PUBLISH");
    scr_publish_enabled = !(env && env[0] == '0');
  }
  if (!scr_publish_enabled || (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_ARR)) return NULL;
  ScrMessage *message = NULL;
  ScrPublish p = {0};
  if (value->rc == SIZE_MAX || scr_publish_collect(&p, (ScrDyn *)value)) {
    for (size_t i = 0; i < p.count; i++) {
      ScrDyn *d = p.nodes[i];
      if ((uintptr_t)d & 1) {
        ScrStr *text = (ScrStr *)((uintptr_t)d & ~(uintptr_t)1);
        scr_str_hash_prime(text);
        text->rc = SIZE_MAX;
#ifdef SCR_RC_AUDIT
        scr_str_live_forget();
#endif
        scr_lsan_immortal(text);
      } else if (d->rc != SIZE_MAX) {
        scr_cyc_on_dead(d); /* leave the candidate and tenured buffers */
        d->rc = SIZE_MAX;
#ifdef SCR_RC_AUDIT
        scr_dyn_live_forget();
#endif
        scr_lsan_immortal(d);
      }
    }
    message = scr_message_alloc(1, sizeof(*message));
    message->nodes = scr_message_alloc(1, sizeof(*message->nodes));
    message->count = message->capacity = 1;
    message->nodes[0].kind = SCR_MESSAGE_PUBLISHED;
    message->nodes[0].published = (ScrDyn *)value;
    if (getenv("SCRIPTC_PUBLISH_TRACE"))
      fprintf(stderr, "scriptc: published %zu nodes zero-copy%s\n", p.count,
              value->rc == SIZE_MAX && !p.count ? " (already published)" : "");
  } else if (getenv("SCRIPTC_PUBLISH_TRACE")) {
    fprintf(stderr, "scriptc: graph not deeply frozen plain data; cloned\n");
  }
  free(p.nodes);
  free(p.seen);
  return message;
}

static ScrMessage *scr_message_encode_with(const ScrDyn *value, const ScrDyn *transfer);
static ScrMessage *scr_message_encode_run(ScrMessageEncoder encoder, const ScrDyn *value);

ScrMessage *scr_message_encode(const ScrDyn *value) { return scr_message_encode_with(value, NULL); }

ScrMessage *scr_message_encode_uncaught(const ScrDyn *value) {
  ScrMessage *message = scr_message_alloc(1, sizeof(*message));
  return scr_message_encode_run((ScrMessageEncoder){.message = message, .uncaught = true}, value);
}

ScrMessage *scr_message_encode_transfer(const ScrDyn *value, const ScrDyn *transfer) {
  if (!transfer || transfer->kind != SCR_DYN_ARR || transfer->v.arr.len == 0)
    return scr_message_encode_with(value, NULL);
  for (size_t i = 0; i < transfer->v.arr.len; i++) {
    const ScrDyn *item = transfer->v.arr.items[i];
    int side = 0;
    ScrChannel *channel = item && item->kind == SCR_DYN_HANDLE && scr_message_port_ops
        ? scr_message_port_ops->channel_of(item, &side) : NULL;
    if (!channel) {
      static const char text[] = "Transfer lists with values other than MessagePorts are not supported yet";
      ScrStr *m = scr_str_new(text, sizeof text - 1);
      scr_throw_lowering_fence(m);
      scr_str_release(m);
      return NULL;
    }
    scr_message_port_ops->release(channel);
  }
  ScrMessage *message = scr_message_encode_with(value, transfer);
  if (!message) return NULL;
  /* the listed ports now belong to the message */
  for (size_t i = 0; i < transfer->v.arr.len; i++) scr_message_port_ops->detach(transfer->v.arr.items[i]);
  return message;
}

static ScrMessage *scr_message_encode_with(const ScrDyn *value, const ScrDyn *transfer) {
  ScrMessage *published = transfer ? NULL : scr_message_try_publish(value);
  if (published) return published;
  ScrMessage *message = scr_message_alloc(1, sizeof(*message));
  return scr_message_encode_run((ScrMessageEncoder){.message = message, .transfer = transfer}, value);
}

static ScrMessage *scr_message_encode_run(ScrMessageEncoder encoder, const ScrDyn *value) {
  ScrMessage *message = encoder.message;
  if (scr_message_value(&encoder, value) == SIZE_MAX) goto done;
  while (encoder.depth && !scr_exc_pending()) {
    size_t id = encoder.stack[encoder.depth - 1];
    ScrMessageVisit *visit = &encoder.visits[id];
    if (visit->cursor == visit->keys->v.arr.len) { encoder.depth--; continue; }
    ScrDyn *key = visit->keys->v.arr.items[visit->cursor++];
    bool error = message->nodes[id].kind == SCR_MESSAGE_ERROR;
    if (key->kind != SCR_DYN_STR || (!error && !scr_dyn_property_is_enumerable(visit->view, key->v.str))) continue;
    ScrDyn *child = scr_dyn_bag_get(visit->view, key->v.str, visit->view);
    if (!child || scr_exc_pending()) { scr_dyn_release(child); break; }
    bool hidden = error;
    if (visit->uncaught) {
      /* Node keeps an uncaught Error's data properties except functions
       * and symbols, and serializes its cause the same way. */
      if (child->kind == SCR_DYN_FUNC || child->kind == SCR_DYN_SYMBOL) { scr_dyn_release(child); continue; }
      hidden = !scr_dyn_has_own(visit->view, key->v.str) || !scr_dyn_property_is_enumerable(visit->view, key->v.str);
      encoder.uncaught = key->v.str->len == 5 && !memcmp(key->v.str->data, "cause", 5);
    }
    size_t next = scr_message_value(&encoder, child);
    scr_dyn_release(child);
    if (next == SIZE_MAX) break;
    scr_message_property(&encoder, id, key->v.str, next, hidden);
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

/* A decoded message that is plain JSON-shaped data is tagged like a parse
 * result (ScrDynRegion), so dropping the decoder's references does not
 * make every container a cycle candidate. Encoder ids are assigned when a
 * value is first reached, parents first; requiring every container edge to
 * lead to a higher id proves the graph acyclic (a subtree reached again
 * from a later node, or a cycle, leaves the document untagged). Leaves
 * must be inert and arrays free of named properties. */
static void scr_message_tag_document(const ScrMessage *message, ScrDyn **values) {
  for (size_t i = 0; i < message->count; i++) {
    const ScrMessageNode *node = &message->nodes[i];
    switch (node->kind) {
    case SCR_MESSAGE_UNDEFINED: case SCR_MESSAGE_NULL: case SCR_MESSAGE_BOOL:
    case SCR_MESSAGE_NUMBER: case SCR_MESSAGE_STRING:
      continue;
    case SCR_MESSAGE_ARRAY: case SCR_MESSAGE_OBJECT:
      break;
    default:
      return;
    }
    if (node->kind == SCR_MESSAGE_ARRAY && values[i]->v.arr.properties) return;
    for (size_t j = 0; j < node->count; j++) {
      size_t target = node->properties[j].value;
      ScrMessageKind kind = message->nodes[target].kind;
      if ((kind == SCR_MESSAGE_ARRAY || kind == SCR_MESSAGE_OBJECT) && target <= i) return;
    }
  }
  if (message->nodes[0].kind != SCR_MESSAGE_ARRAY && message->nodes[0].kind != SCR_MESSAGE_OBJECT) return;
  ScrDynRegion *region = scr_dyn_region_open();
  for (size_t i = 0; i < message->count; i++) scr_dyn_region_tag(values[i], region);
  scr_dyn_region_close(region);
}

ScrDyn *scr_message_decode(const ScrMessage *message) {
  if (message->count == 1 && message->nodes[0].kind == SCR_MESSAGE_PUBLISHED)
    return scr_dyn_retain(message->nodes[0].published);
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
    case SCR_MESSAGE_PUBLISHED: values[i] = scr_dyn_retain(node->published); break;
    case SCR_MESSAGE_TYPED_REF:
      values[i] = (node->typed.traced ? scr_dyn_new_typed_ref_traced : scr_dyn_new_typed_ref)(
          node->typed.ptr, node->typed.retain, node->typed.release, node->typed.type_key,
          node->typed.type_key_len, node->typed.materialize, node->typed.commit);
      break;
    case SCR_MESSAGE_PORT:
      values[i] = scr_message_port_ops->adopt(node->channel, (int)node->number);
      break;
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
      for (size_t j = 0; j < values[i]->v.obj.len; j++) {
        ScrDynEntry *entry = &values[i]->v.obj.entries[j];
        entry->enumerable = false;
        for (size_t k = 0; k < node->count; k++) {
          const ScrMessageProperty *property = &node->properties[k];
          if (!property->hidden && property->length == entry->key_len && !memcmp(property->key, entry->key, entry->key_len))
            entry->enumerable = true;
        }
      }
      ScrError *error = scr_errdyn_err_of(values[i]);
      scr_error_commit_dyn(error, values[i]);
      scr_error_release(error);
    }
  }
  scr_message_tag_document(message, values);
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
    if (node->kind == SCR_MESSAGE_PORT) scr_message_port_ops->release(node->channel);
  }
  free(message->nodes);
  free(message);
}
