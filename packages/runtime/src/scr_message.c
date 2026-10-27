#include "scr_message.h"
#include "scr_mailbox.h"

#include <stdio.h>
#include <stdlib.h>

const ScrMessagePortOps *scr_message_port_ops = NULL;

typedef struct {
  const char *key;
  size_t length;
  size_t value;
  bool hidden; /* an Error's non-enumerable or inherited property */
} ScrMessageProperty;

/* SCR_MESSAGE_TYPED_REF: the capsule's process-wide adapters and type key
 * (vtables, adapters and type keys are shared by every thread). */
typedef struct {
  void *ptr;
  void *(*retain)(void *);
  void (*release)(void *);
  const char *type_key;
  size_t type_key_len;
  ScrDyn *(*materialize)(void *);
  void (*commit)(void *, const ScrDyn *);
  bool traced;
} ScrMessageTyped;

typedef struct {
  unsigned char kind; /* ScrMessageKind */
  unsigned char element; /* SCR_MESSAGE_BYTES: ScrBytesElem */
  bool data_view; /* SCR_MESSAGE_BYTES */
  uint32_t count; /* properties */
  const ScrMessageProperty *properties;
  union {
    double number; /* BOOL and NUMBER; ERROR: the error kind */
    /* STRING and BIGINT: the text, in the message block. STORAGE: the
     * copied bytes (owned) or the shared backing (+1). */
    struct {
      char *data;
      ScrSharedBytes *shared;
      size_t length;
    } text;
    /* BYTES and ARRAY_BUFFER: the STORAGE node; BYTES: the view. */
    struct {
      size_t storage;
      size_t offset;
      size_t length;
    } view;
    size_t length; /* ARRAY */
    ScrDyn *published; /* PUBLISHED: immortal root, owns nothing */
    struct {
      ScrChannel *channel; /* +1 */
      int side;
    } port;
    /* HANDLE: the owning unit's hooks and its payload (+1). */
    struct {
      const ScrDynHandleTransfer *transfer;
      void *payload;
    } handle;
    const ScrMessageTyped *typed; /* TYPED_REF, in the message block */
    size_t typed_index; /* TYPED_REF while encoding */
  } v;
} ScrMessageNode;

/* A message is one allocation: this header, then the nodes, the
 * properties, the typed records and the text (keys, strings and bigints),
 * sized to the message. A queued message holds nothing else, apart from
 * the bytes of STORAGE nodes. */
struct ScrMessage {
  ScrMessageNode *nodes;
  size_t count;
  bool storage; /* has STORAGE nodes */
  bool releases; /* has STORAGE, PORT or HANDLE nodes, which own resources */
  bool readable; /* see scr_message_readable */
  ScrMailEvent event; /* the event that carries the message (scr_message_mail_event) */
};

typedef struct {
  const ScrDyn *input;
  ScrDyn *view;
  ScrDyn *keys;
  ScrStr *text; /* a STRING or BIGINT node's text, until the message is packed */
  size_t cursor;
  bool uncaught; /* an Error encoded as an uncaught exception */
} ScrMessageVisit;

typedef struct {
  ScrMessageProperty property;
  size_t owner;
} ScrMessagePending;

typedef struct {
  const void *identity;
  unsigned domain;
  size_t node;
} ScrMessageIdentity;

/* The encoder's arrays start inline, so a message of up to this many nodes
 * and properties allocates only its block. */
#define SCR_MESSAGE_INLINE 8

/* How deep live records nest before the rest of a graph encodes through
 * the visit stack (scr_message_value recurses for them). */
#define SCR_MESSAGE_RECORD_DEPTH 32

typedef struct {
  ScrMessageNode *nodes;
  ScrMessageVisit *visits;
  size_t count;
  size_t capacity;
  ScrMessagePending *properties; /* in the order they were reached */
  size_t property_count;
  size_t property_capacity;
  ScrMessageTyped *typed;
  size_t typed_count;
  size_t typed_capacity;
  size_t text; /* bytes of text in the message block */
  ScrMessageIdentity *identities;
  size_t identity_count;
  size_t identity_capacity;
  size_t *stack;
  size_t depth;
  size_t stack_capacity;
  const ScrDyn *transfer; /* the transfer list (a dyn array), or NULL */
  bool uncaught; /* the next value is an uncaught exception or its cause */
  bool storage;
  bool releases;
  bool shared; /* a node was reached twice */
  size_t record_depth; /* live records being encoded from their fields */
  bool adopts; /* has PORT or HANDLE nodes */
  ScrMessageNode inline_nodes[SCR_MESSAGE_INLINE];
  ScrMessageVisit inline_visits[SCR_MESSAGE_INLINE];
  ScrMessagePending inline_properties[SCR_MESSAGE_INLINE];
  ScrMessageIdentity inline_identities[2 * SCR_MESSAGE_INLINE];
  size_t inline_stack[SCR_MESSAGE_INLINE];
} ScrMessageEncoder;

static void scr_message_encoder_init(ScrMessageEncoder *encoder, const ScrDyn *transfer, bool uncaught) {
  encoder->nodes = encoder->inline_nodes;
  encoder->visits = encoder->inline_visits;
  encoder->count = 0;
  encoder->capacity = SCR_MESSAGE_INLINE;
  encoder->properties = encoder->inline_properties;
  encoder->property_count = 0;
  encoder->property_capacity = SCR_MESSAGE_INLINE;
  encoder->typed = NULL;
  encoder->typed_count = encoder->typed_capacity = 0;
  encoder->text = 0;
  encoder->identities = NULL;
  encoder->identity_count = encoder->identity_capacity = 0;
  encoder->stack = encoder->inline_stack;
  encoder->depth = 0;
  encoder->stack_capacity = SCR_MESSAGE_INLINE;
  encoder->transfer = transfer;
  encoder->uncaught = uncaught;
  encoder->storage = encoder->releases = encoder->shared = encoder->adopts = false;
  encoder->record_depth = 0;
}

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
  return capacity ? capacity * 2 : 4;
}

/* Moves an encoder array of count items to a new one of capacity items,
 * freeing the old one unless it is the inline array. */
static void *scr_message_regrow(void *items, size_t count, size_t capacity, size_t size,
                                const void *inline_items) {
  void *grown = scr_message_alloc(capacity, size);
  if (count) memcpy(grown, items, count * size);
  if (items != inline_items) free(items);
  return grown;
}

static char *scr_message_copy(const void *data, size_t length) {
  if (length == SIZE_MAX) scr_trap("scriptc: message too large\n");
  char *copy = scr_message_alloc(length + 1, 1);
  if (length) memcpy(copy, data, length);
  return copy;
}

/* Reserves text (and its terminator) in the message block. */
static void scr_message_text(ScrMessageEncoder *encoder, size_t length) {
  if (length >= SIZE_MAX - encoder->text) scr_trap("scriptc: message too large\n");
  encoder->text += length + 1;
}

static size_t scr_message_node(ScrMessageEncoder *encoder) {
  if (encoder->count == encoder->capacity) {
    size_t capacity = scr_message_grow(encoder->capacity);
    encoder->nodes = scr_message_regrow(encoder->nodes, encoder->count, capacity,
                                        sizeof(*encoder->nodes), encoder->inline_nodes);
    encoder->visits = scr_message_regrow(encoder->visits, encoder->count, capacity,
                                         sizeof(*encoder->visits), encoder->inline_visits);
    encoder->capacity = capacity;
  }
  size_t id = encoder->count++;
  memset(&encoder->nodes[id], 0, sizeof(encoder->nodes[id]));
  memset(&encoder->visits[id], 0, sizeof(encoder->visits[id]));
  return id;
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
  if (!encoder->identity_capacity) {
    encoder->identity_capacity = sizeof encoder->inline_identities / sizeof encoder->inline_identities[0];
    encoder->identities = encoder->inline_identities;
    memset(encoder->identities, 0, sizeof encoder->inline_identities);
  } else if (encoder->identity_count >= encoder->identity_capacity / 2) {
    size_t capacity = scr_message_grow(encoder->identity_capacity);
    ScrMessageIdentity *entries = scr_message_alloc(capacity, sizeof(*entries));
    for (size_t i = 0; i < encoder->identity_capacity; i++) {
      ScrMessageIdentity entry = encoder->identities[i];
      if (!entry.identity) continue;
      size_t slot = scr_message_hash(entry.identity, entry.domain) & (capacity - 1);
      while (entries[slot].identity) slot = (slot + 1) & (capacity - 1);
      entries[slot] = entry;
    }
    if (encoder->identities != encoder->inline_identities) free(encoder->identities);
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
    encoder->stack = scr_message_regrow(encoder->stack, encoder->depth, capacity,
                                        sizeof(*encoder->stack), encoder->inline_stack);
    encoder->stack_capacity = capacity;
  }
  encoder->stack[encoder->depth++] = node;
}

static size_t scr_message_storage(ScrMessageEncoder *encoder, const ScrBytes *bytes) {
  const ScrBytes *owner = bytes->backing ? bytes->backing : bytes;
  size_t found = scr_message_find(encoder, owner, SCR_MESSAGE_STORAGE + 1);
  if (found != SIZE_MAX) {
    encoder->shared = true;
    return found;
  }
  size_t node = scr_message_node(encoder);
  scr_message_identify(encoder, owner, SCR_MESSAGE_STORAGE + 1, node);
  ScrMessageNode *storage = &encoder->nodes[node];
  storage->kind = SCR_MESSAGE_STORAGE;
  size_t size = scr_bytes_elem_size(owner->elem);
  if (owner->len > SIZE_MAX / size) scr_trap("scriptc: message too large\n");
  storage->v.text.length = owner->len * size;
  if (owner->shared) storage->v.text.shared = scr_shared_retain(owner->shared);
  else storage->v.text.data = scr_message_copy(owner->data, storage->v.text.length);
  encoder->storage = encoder->releases = true;
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

static void scr_message_property(ScrMessageEncoder *encoder, size_t id,
                                  const ScrStr *key, size_t value, bool hidden);
static bool scr_message_drain(ScrMessageEncoder *encoder, size_t base);

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
  if (scr_uncloneable_count && scr_uncloneable_marked(input)) {
    scr_throw_domex("DataCloneError", "Cannot clone object of unsupported type.");
    return SIZE_MAX;
  }
  size_t found = scr_message_find(encoder, identity, domain);
  if (found != SIZE_MAX) {
    encoder->shared = true;
    return found;
  }
  size_t id = scr_message_node(encoder);
  scr_message_identify(encoder, identity, domain, id);
  encoder->visits[id].input = scr_dyn_retain((ScrDyn *)input);
  /* Published values (immortal) travel by pointer: a typed value as a
   * capsule over the same object, a dyn graph as itself. */
  if (input->kind == SCR_DYN_TYPED_REF && input->v.typed_ref.ptr &&
      SCR_RC_PUBLISHED(input->v.typed_ref.ptr)) {
    scr_sa_thread_shares();
    encoder->visits[id].view = (ScrDyn *)input;
    ScrMessageNode *node = &encoder->nodes[id];
    if (encoder->typed_count == encoder->typed_capacity) {
      size_t capacity = scr_message_grow(encoder->typed_capacity);
      encoder->typed = scr_message_regrow(encoder->typed, encoder->typed_count, capacity,
                                          sizeof(*encoder->typed), NULL);
      encoder->typed_capacity = capacity;
    }
    node->kind = SCR_MESSAGE_TYPED_REF;
    node->v.typed_index = encoder->typed_count;
    encoder->typed[encoder->typed_count++] = (ScrMessageTyped){
      input->v.typed_ref.ptr, input->v.typed_ref.retain, input->v.typed_ref.release,
      input->v.typed_ref.type_key, input->v.typed_ref.type_key_len, input->v.typed_ref.materialize,
      input->v.typed_ref.commit, input->v.typed_ref.traced,
    };
    if (getenv("SCRIPTC_PUBLISH_TRACE"))
      fprintf(stderr, "scriptc: published %.*s shared by reference\n", (int)input->v.typed_ref.type_key_len,
              input->v.typed_ref.type_key);
    return id;
  }
  if ((input->kind == SCR_DYN_OBJ || input->kind == SCR_DYN_ARR) && input->rc == SIZE_MAX) {
    scr_sa_thread_shares();
    encoder->visits[id].view = (ScrDyn *)input;
    ScrMessageNode *node = &encoder->nodes[id];
    node->kind = SCR_MESSAGE_PUBLISHED;
    node->v.published = (ScrDyn *)input;
    return id;
  }
  /* A live record capsule (scr_dyn_typed_ref_bind_record) whose view was
   * never created encodes its fields from the record: the view would hold
   * exactly those keys, in that order, with the values its ops box. Nested
   * records encode the same way up to a depth, then through their views
   * and the visit stack. */
  const ScrDynTypedRecordOps *record =
      input->kind == SCR_DYN_TYPED_REF && encoder->record_depth < SCR_MESSAGE_RECORD_DEPTH
          ? scr_dyn_typed_ref_live_record(input) : NULL;
  if (record) {
    encoder->visits[id].view = (ScrDyn *)input;
    encoder->nodes[id].kind = SCR_MESSAGE_OBJECT;
    void *rec = input->v.typed_ref.ptr;
    encoder->record_depth++;
    size_t result = id;
    /* A field's value encodes completely, its containers' properties
     * included, before the next field's: getters run in Node's order. */
    size_t base = encoder->depth;
    for (size_t i = 0; i < record->count; i++) {
      if (!record->fixed && !record->has(rec, i)) continue;
      ScrDyn *child = record->get(rec, i);
      if (!child || scr_exc_pending()) {
        scr_dyn_release(child);
        result = SIZE_MAX;
        break;
      }
      size_t next = scr_message_value(encoder, child);
      scr_dyn_release(child);
      if (next == SIZE_MAX) {
        result = SIZE_MAX;
        break;
      }
      scr_message_property(encoder, id, record->names[i], next, false);
      if (encoder->depth > base && !scr_message_drain(encoder, base)) {
        result = SIZE_MAX;
        break;
      }
    }
    encoder->record_depth--;
    return result;
  }
  ScrDyn *value = input->kind == SCR_DYN_TYPED_REF
      ? scr_dyn_typed_ref_materialize(input) : (ScrDyn *)input;
  encoder->visits[id].view = value;
  if (!value || scr_exc_pending()) return SIZE_MAX;
  ScrMessageNode *node = &encoder->nodes[id];
  ScrError *error = scr_errdyn_err_of(input);
  if (!error && value != input) error = scr_errdyn_err_of(value);
  if (error && uncaught && error->vt != &scr_error_vts[SCR_ERR_DOMEX]) {
    node->kind = SCR_MESSAGE_ERROR;
    node->v.number = scr_message_error_kind(error);
    scr_error_release(error);
    encoder->visits[id].uncaught = true;
    encoder->visits[id].keys = scr_message_uncaught_keys(value);
    if (!encoder->visits[id].keys) return SIZE_MAX;
    scr_message_push(encoder, id);
    return id;
  }
  if (error) {
    node->kind = SCR_MESSAGE_ERROR;
    node->v.number = SCR_ERR_ERROR;
    static const char *const names[] = {
      "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError",
    };
    static const int kinds[] = {
      SCR_ERR_ERROR, SCR_ERR_TYPE, SCR_ERR_RANGE, SCR_ERR_SYNTAX, SCR_ERR_REFERENCE, SCR_ERR_EVAL, SCR_ERR_URI,
    };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
      if (error->name->len == strlen(names[i]) && !memcmp(error->name->data, names[i], error->name->len))
        node->v.number = kinds[i];
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
  case SCR_DYN_BOOL: node->kind = SCR_MESSAGE_BOOL; node->v.number = value->v.b; break;
  case SCR_DYN_NUM: node->kind = SCR_MESSAGE_NUMBER; node->v.number = value->v.num; break;
  case SCR_DYN_STR:
    /* The text is copied into the message block when it is packed. */
    node->kind = SCR_MESSAGE_STRING;
    encoder->visits[id].text = scr_str_retain(value->v.str);
    node->v.text.length = value->v.str->len;
    scr_message_text(encoder, node->v.text.length);
    break;
  case SCR_DYN_BIGINT: {
    ScrStr *text = scr_bigint_to_string(value->v.bigint, 10);
    if (!text) return SIZE_MAX;
    node->kind = SCR_MESSAGE_BIGINT;
    encoder->visits[id].text = text;
    node->v.text.length = text->len;
    scr_message_text(encoder, node->v.text.length);
    break;
  }
  case SCR_DYN_ARR:
  case SCR_DYN_OBJ:
    node->kind = value->kind == SCR_DYN_ARR ? SCR_MESSAGE_ARRAY : SCR_MESSAGE_OBJECT;
    if (value->kind == SCR_DYN_ARR) node->v.length = value->v.arr.len;
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
      node->v.port.channel = channel;
      node->v.port.side = side;
      encoder->releases = encoder->adopts = true;
      break;
    }
    bool buffer = scr_buffer_storage_is(value);
    if (value->kind == SCR_DYN_HANDLE && !buffer) {
      const ScrDynHandleTransfer *transfer = scr_dyn_handle_ops_of(value)->transfer;
      if (!transfer) goto unsupported;
      void *payload = transfer->share(value->v.handle.ptr);
      if (!payload) {
        if (scr_exc_pending()) return SIZE_MAX;
        goto unsupported;
      }
      node = &encoder->nodes[id];
      node->kind = SCR_MESSAGE_HANDLE;
      node->v.handle.transfer = transfer;
      node->v.handle.payload = payload;
      encoder->releases = encoder->adopts = true;
      break;
    }
    const ScrBytes *bytes = buffer ? value->v.handle.ptr : value->v.bytes;
    size_t storage = scr_message_storage(encoder, bytes);
    /* Adding the storage node can reallocate the node array. */
    node = &encoder->nodes[id];
    node->kind = buffer ? SCR_MESSAGE_ARRAY_BUFFER : SCR_MESSAGE_BYTES;
    node->v.view.storage = storage;
    node->element = (unsigned char)bytes->elem;
    node->v.view.length = bytes->len;
    node->v.view.offset = (size_t)(bytes->data - (bytes->backing ? bytes->backing : bytes)->data);
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
  if (encoder->property_count == encoder->property_capacity) {
    size_t capacity = scr_message_grow(encoder->property_capacity);
    encoder->properties = scr_message_regrow(encoder->properties, encoder->property_count, capacity,
                                             sizeof(*encoder->properties), encoder->inline_properties);
    encoder->property_capacity = capacity;
  }
  ScrMessageNode *node = &encoder->nodes[id];
  if (node->count == UINT32_MAX) scr_trap("scriptc: message too large\n");
  node->count++;
  scr_message_text(encoder, key->len);
  /* The key stays alive in the owner's key list until the message is packed. */
  encoder->properties[encoder->property_count++] = (ScrMessagePending){{key->data, key->len, value, hidden}, id};
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
  for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
    ScrDynProp e = scr_dyn_obj_prop_at(d, i);
    if (e.accessor || !e.enumerable) return false;
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
      for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
        ScrDyn *child = scr_dyn_obj_value_at(d, i);
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
  /* Most messages are not frozen: check the root before collecting. */
  if (value->rc == SIZE_MAX || (scr_publish_container_ok(value) && scr_publish_collect(&p, (ScrDyn *)value))) {
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
        /* A layout names a node of this thread's transition tree
         * (scr_dyn.h), which other threads cannot use and which ends with
         * this thread: the object moves to dictionary mode. */
        if (d->kind == SCR_DYN_OBJ) scr_dyn_to_dictionary(d);
#ifdef SCR_RC_AUDIT
        scr_dyn_live_forget();
#endif
        scr_lsan_immortal(d);
      }
    }
    scr_sa_thread_shares();
    message = scr_message_alloc(1, sizeof(*message) + sizeof(*message->nodes));
    message->nodes = (ScrMessageNode *)(message + 1);
    message->count = 1;
    message->readable = true;
    message->nodes[0].kind = SCR_MESSAGE_PUBLISHED;
    message->nodes[0].v.published = (ScrDyn *)value;
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
static ScrMessage *scr_message_encode_run(ScrMessageEncoder *encoder, const ScrDyn *value);

ScrMessage *scr_message_encode(const ScrDyn *value) { return scr_message_encode_with(value, NULL); }

ScrMessage *scr_message_encode_uncaught(const ScrDyn *value) {
  ScrMessageEncoder encoder;
  scr_message_encoder_init(&encoder, NULL, true);
  return scr_message_encode_run(&encoder, value);
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
  ScrMessageEncoder encoder;
  scr_message_encoder_init(&encoder, transfer, false);
  return scr_message_encode_run(&encoder, value);
}

/* Releases what a node owns: a STORAGE node's bytes, a PORT node's
 * channel end and a HANDLE node's payload. */
static void scr_message_drop(ScrMessageNode *node) {
  switch (node->kind) {
  case SCR_MESSAGE_STORAGE:
    free(node->v.text.data);
    scr_shared_release(node->v.text.shared);
    break;
  case SCR_MESSAGE_PORT: scr_message_port_ops->release(node->v.port.channel); break;
  case SCR_MESSAGE_HANDLE: node->v.handle.transfer->drop(node->v.handle.payload); break;
  default: break;
  }
}

/* Copies the encoded nodes into one block: the header, the nodes, the
 * properties grouped by node (in the order they were reached), the typed
 * records and the text. */
static ScrMessage *scr_message_pack(ScrMessageEncoder *encoder) {
  size_t count = encoder->count;
  size_t properties = encoder->property_count;
  size_t typed = encoder->typed_count;
  size_t size = sizeof(ScrMessage);
  size_t sizes[] = {
    count, sizeof(ScrMessageNode), properties, sizeof(ScrMessageProperty), typed, sizeof(ScrMessageTyped),
  };
  for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i += 2) {
    if (sizes[i] > (SIZE_MAX - size) / sizes[i + 1]) scr_trap("scriptc: message too large\n");
    size += sizes[i] * sizes[i + 1];
  }
  if (encoder->text > SIZE_MAX - size) scr_trap("scriptc: message too large\n");
  ScrMessage *message = malloc(size + encoder->text);
  if (!message) scr_trap("scriptc: out of memory\n");
  ScrMessageNode *nodes = (ScrMessageNode *)(message + 1);
  ScrMessageProperty *slots = (ScrMessageProperty *)(nodes + count);
  ScrMessageTyped *records = (ScrMessageTyped *)(slots + properties);
  char *text = (char *)(records + typed);
  *message = (ScrMessage){.nodes = nodes, .count = count, .storage = encoder->storage,
                          .releases = encoder->releases, .readable = !encoder->shared && !encoder->adopts};
  memcpy(nodes, encoder->nodes, count * sizeof(*nodes));
  if (typed) memcpy(records, encoder->typed, typed * sizeof(*records));
  size_t first = 0;
  for (size_t i = 0; i < count; i++) {
    ScrMessageNode *node = &nodes[i];
    node->properties = slots + first;
    first += node->count;
    node->count = 0;
    if (node->kind == SCR_MESSAGE_STRING || node->kind == SCR_MESSAGE_BIGINT) {
      memcpy(text, encoder->visits[i].text->data, node->v.text.length);
      text[node->v.text.length] = 0;
      node->v.text.data = text;
      text += node->v.text.length + 1;
    } else if (node->kind == SCR_MESSAGE_TYPED_REF) {
      node->v.typed = &records[node->v.typed_index];
    }
  }
  for (size_t i = 0; i < properties; i++) {
    const ScrMessagePending *pending = &encoder->properties[i];
    ScrMessageNode *node = &nodes[pending->owner];
    ScrMessageProperty *slot = (ScrMessageProperty *)&node->properties[node->count++];
    *slot = pending->property;
    memcpy(text, pending->property.key, pending->property.length);
    text[pending->property.length] = 0;
    slot->key = text;
    text += pending->property.length + 1;
  }
  return message;
}

/* Encodes the properties of the containers on the visit stack above
 * `base`, depth first, as Node's serializer visits them (getters run in
 * that order). False when a property could not be read or encoded. */
static bool scr_message_drain(ScrMessageEncoder *encoder, size_t base) {
  while (encoder->depth > base && !scr_exc_pending()) {
    size_t id = encoder->stack[encoder->depth - 1];
    ScrMessageVisit *visit = &encoder->visits[id];
    if (visit->cursor == visit->keys->v.arr.len) { encoder->depth--; continue; }
    ScrDyn *key = visit->keys->v.arr.items[visit->cursor++];
    bool error = encoder->nodes[id].kind == SCR_MESSAGE_ERROR;
    if (key->kind != SCR_DYN_STR || (!error && !scr_dyn_property_is_enumerable(visit->view, key->v.str))) continue;
    ScrDyn *child = scr_dyn_bag_get(visit->view, key->v.str, visit->view);
    if (!child || scr_exc_pending()) { scr_dyn_release(child); return false; }
    bool hidden = error;
    if (visit->uncaught) {
      /* Node keeps an uncaught Error's data properties except functions
       * and symbols, and serializes its cause the same way. */
      if (child->kind == SCR_DYN_FUNC || child->kind == SCR_DYN_SYMBOL) { scr_dyn_release(child); continue; }
      hidden = !scr_dyn_has_own(visit->view, key->v.str) || !scr_dyn_property_is_enumerable(visit->view, key->v.str);
      encoder->uncaught = key->v.str->len == 5 && !memcmp(key->v.str->data, "cause", 5);
    }
    size_t next = scr_message_value(encoder, child);
    scr_dyn_release(child);
    if (next == SIZE_MAX) return false;
    scr_message_property(encoder, id, key->v.str, next, hidden);
  }
  return !scr_exc_pending();
}

static ScrMessage *scr_message_encode_run(ScrMessageEncoder *encoder, const ScrDyn *value) {
  ScrMessage *message = NULL;
  if (scr_message_value(encoder, value) != SIZE_MAX) scr_message_drain(encoder, 0);
  if (!scr_exc_pending()) message = scr_message_pack(encoder);
  else
    for (size_t i = 0; i < encoder->count; i++) scr_message_drop(&encoder->nodes[i]);
  for (size_t i = 0; i < encoder->count; i++) {
    ScrMessageVisit *visit = &encoder->visits[i];
    scr_dyn_release(visit->keys);
    if (visit->view != visit->input) scr_dyn_release(visit->view);
    scr_dyn_release((ScrDyn *)visit->input);
    scr_str_release(visit->text);
  }
  if (encoder->nodes != encoder->inline_nodes) free(encoder->nodes);
  if (encoder->visits != encoder->inline_visits) free(encoder->visits);
  if (encoder->properties != encoder->inline_properties) free(encoder->properties);
  if (encoder->identities != encoder->inline_identities) free(encoder->identities);
  if (encoder->stack != encoder->inline_stack) free(encoder->stack);
  free(encoder->typed);
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
    return scr_dyn_retain(message->nodes[0].v.published);
  ScrDyn *inline_values[SCR_MESSAGE_INLINE];
  ScrDyn **values = message->count <= SCR_MESSAGE_INLINE
      ? inline_values : scr_message_alloc(message->count, sizeof(*values));
  memset(values, 0, message->count * sizeof(*values));
  ScrBytes **storage = message->storage ? scr_message_alloc(message->count, sizeof(*storage)) : NULL;
  for (size_t i = 0; storage && i < message->count; i++) {
    const ScrMessageNode *node = &message->nodes[i];
    if (node->kind != SCR_MESSAGE_STORAGE) continue;
    storage[i] = node->v.text.shared ? scr_shared_wrap(node->v.text.shared)
                                     : scr_bytes_new(SCR_BYTES_U8, (double)node->v.text.length);
    if (!storage[i]) goto done;
    if (!node->v.text.shared && node->v.text.length)
      memcpy(storage[i]->data, node->v.text.data, node->v.text.length);
  }
  for (size_t i = 0; i < message->count; i++) {
    const ScrMessageNode *node = &message->nodes[i];
    switch (node->kind) {
    case SCR_MESSAGE_UNDEFINED: values[i] = scr_dyn_retain(scr_dyn_undefined()); break;
    case SCR_MESSAGE_NULL: values[i] = scr_dyn_new_null(); break;
    case SCR_MESSAGE_BOOL: values[i] = scr_dyn_new_bool(node->v.number != 0); break;
    case SCR_MESSAGE_NUMBER: values[i] = scr_dyn_new_num(node->v.number); break;
    case SCR_MESSAGE_STRING:
    case SCR_MESSAGE_BIGINT: {
      ScrStr *text = scr_str_new(node->v.text.data, node->v.text.length);
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
      for (size_t j = 0; j < node->v.length; j++) scr_dyn_arr_push_hole(values[i]);
      break;
    case SCR_MESSAGE_OBJECT: values[i] = scr_dyn_new_obj(); break;
    case SCR_MESSAGE_ERROR: {
      scr_error_set_traced();
      ScrError *error = scr_error_new((int)node->v.number, NULL);
      values[i] = scr_dyn_from_error(error);
      scr_error_release(error);
      break;
    }
    case SCR_MESSAGE_BYTES: {
      ScrBytes *bytes = scr_bytes_buffer_view(storage[node->v.view.storage], (ScrBytesElem)node->element,
          (double)node->v.view.offset, true, (double)node->v.view.length);
      if (bytes) {
        bytes->is_data_view = node->data_view;
        values[i] = scr_dyn_new_bytes(bytes);
        scr_bytes_release(bytes);
      }
      break;
    }
    case SCR_MESSAGE_ARRAY_BUFFER:
      values[i] = scr_array_buffer_from_bytes(storage[node->v.view.storage]);
      break;
    case SCR_MESSAGE_STORAGE: continue;
    case SCR_MESSAGE_PUBLISHED: values[i] = scr_dyn_retain(node->v.published); break;
    case SCR_MESSAGE_TYPED_REF: {
      const ScrMessageTyped *typed = node->v.typed;
      values[i] = (typed->traced ? scr_dyn_new_typed_ref_traced : scr_dyn_new_typed_ref)(
          typed->ptr, typed->retain, typed->release, typed->type_key, typed->type_key_len,
          typed->materialize, typed->commit);
      break;
    }
    case SCR_MESSAGE_PORT:
      values[i] = scr_message_port_ops->adopt(node->v.port.channel, node->v.port.side);
      break;
    case SCR_MESSAGE_HANDLE: values[i] = node->v.handle.transfer->adopt(node->v.handle.payload); break;
    }
    if (!values[i] || scr_exc_pending()) goto done;
  }
  for (size_t i = 0; i < message->count; i++) {
    const ScrMessageNode *node = &message->nodes[i];
    for (size_t j = 0; j < node->count; j++) {
      const ScrMessageProperty *property = &node->properties[j];
      ScrDyn *value = scr_dyn_retain(values[property->value]);
      if (node->kind == SCR_MESSAGE_ARRAY) {
        size_t index = scr_message_array_index(property->key, property->length, node->v.length);
        if (index != SIZE_MAX) {
          values[i]->v.arr.items[index] = value;
          values[i]->v.arr.presence[index] = 1;
          continue;
        }
        if (!values[i]->v.arr.properties) values[i]->v.arr.properties = scr_dyn_new_obj();
        scr_dyn_obj_set(values[i]->v.arr.properties, property->key, property->length, value);
      } else if (node->kind == SCR_MESSAGE_ERROR && property->length == 5 && !memcmp(property->key, "stack", 5)) {
        /* The new error's own `stack` accessor stores the value. */
        ScrStr *key = scr_str_new(property->key, property->length);
        scr_dyn_key_set(values[i], key, value);
        scr_str_release(key);
        scr_dyn_release(value);
      } else scr_dyn_obj_set(values[i], property->key, property->length, value);
    }
    if (node->kind == SCR_MESSAGE_ERROR) {
      for (size_t j = 0; j < scr_dyn_obj_count(values[i]); j++) {
        ScrDynProp entry = scr_dyn_obj_prop_at(values[i], j);
        bool enumerable = false;
        for (size_t k = 0; k < node->count; k++) {
          const ScrMessageProperty *property = &node->properties[k];
          if (!property->hidden && property->length == entry.key_len && !memcmp(property->key, entry.key, entry.key_len))
            enumerable = true;
        }
        scr_dyn_obj_set_attrs_at(values[i], j, entry.writable, enumerable, entry.configurable);
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
    if (storage) scr_bytes_release(storage[i]);
  }
  if (values != inline_values) free(values);
  free(storage);
  return result;
}

bool scr_message_readable(const ScrMessage *message) { return message->readable; }

ScrMailEvent *scr_message_mail_event(ScrMessage *message) {
  message->event = (ScrMailEvent){.message = message, .in_message = true};
  return &message->event;
}

int32_t scr_message_kind(const ScrMessage *message, size_t node) { return message->nodes[node].kind; }

double scr_message_number(const ScrMessage *message, size_t node) { return message->nodes[node].v.number; }

ScrStr *scr_message_string(const ScrMessage *message, size_t node) {
  return scr_str_new(message->nodes[node].v.text.data, message->nodes[node].v.text.length);
}

bool scr_message_fields(const ScrMessage *message, size_t node, const char *const *names,
                        const size_t *lengths, size_t count, size_t *values) {
  const ScrMessageNode *object = &message->nodes[node];
  if (object->kind != SCR_MESSAGE_OBJECT || object->count != count) return false;
  for (size_t i = 0; i < count; i++) {
    const ScrMessageProperty *property = &object->properties[i];
    if (property->length != lengths[i] || memcmp(property->key, names[i], lengths[i])) return false;
    values[i] = property->value;
  }
  return true;
}

void scr_message_free(ScrMessage *message) {
  if (!message) return;
  if (message->releases)
    for (size_t i = 0; i < message->count; i++) scr_message_drop(&message->nodes[i]);
  free(message);
}
