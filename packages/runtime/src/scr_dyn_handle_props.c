/* Own properties that JavaScript adds to runtime handles: a Date, RegExp,
 * Map, Set, WeakMap, WeakSet, ArrayBuffer, SharedArrayBuffer,
 * FinalizationRegistry or ChildProcess (`d.tag = 1`,
 * Object.defineProperty(map, "label", ...), execa's child mixin).
 *
 * A handle crosses into the checked-dynamic tree as a fresh box each time
 * and its identity is the native object, so its properties live in a side
 * table keyed by that object: one ordinary null-prototype checked object
 * per handle, the representation functions and byte views use for theirs.
 * The object carries the handle's integrity state too. The table keeps
 * each handle it describes alive until the thread exits (Date and RegExp
 * frees report no disposal, so the key cannot be weak).
 *
 * scr_json.c's JavaScript object model build asks this unit, through
 * scr_dyn_handle_props_hooks, about every own-property operation of a
 * handle; member calls and reads reach it through the tag's wrapped ops,
 * which scr_dyn_handle_install keeps installed when the owning unit
 * installs its ops again. A key that names a member of the handle's class
 * is refused unless the compiler routes that member through the box (the
 * child's members, all of them). Linked only by programs that add
 * properties to a handle (the compiler's handle-properties.ts). */
#include "scr_runtime.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  void *ptr;      /* retained through hp_orig[tag]->retain; NULL = empty slot */
  ScrDynHandleTag tag;
  ScrDyn *props;  /* owned null-prototype checked object */
} ScrHandleProps;

static SCR_TL ScrHandleProps *hp_slots;
static SCR_TL size_t hp_count, hp_capacity; /* capacity: 0 or a power of two */
static SCR_TL const ScrDynHandleOps *hp_orig[SCR_DYNH_CAPACITY];
static SCR_TL ScrDynHandleOps hp_ops[SCR_DYNH_CAPACITY];
static SCR_TL bool hp_wrapped[SCR_DYNH_CAPACITY];
/* Member keys a program may add for the tag: the compiler routes them
 * through the box (the child's, all of them; H2 adds per-name grants). */
static SCR_TL bool hp_members_open[SCR_DYNH_CAPACITY];

static size_t hp_bucket(const void *ptr) {
  uintptr_t x = (uintptr_t)ptr;
  x ^= x >> 33;
  x *= UINT64_C(0xff51afd7ed558ccd);
  x ^= x >> 33;
  return (size_t)x & (hp_capacity - 1);
}

static void hp_cleanup(void) {
  ScrHandleProps *slots = hp_slots;
  size_t capacity = hp_capacity;
  hp_slots = NULL;
  hp_count = hp_capacity = 0;
  scr_dyn_handle_props_hooks = NULL;
  for (size_t i = 0; i < capacity; i++) {
    if (!slots[i].ptr) continue;
    scr_dyn_release(slots[i].props);
    hp_orig[slots[i].tag]->release(slots[i].ptr);
  }
  free(slots);
}

static ScrDyn *hp_find(const void *ptr) {
  if (!hp_capacity) return NULL;
  for (size_t i = hp_bucket(ptr);; i = (i + 1) & (hp_capacity - 1)) {
    if (!hp_slots[i].ptr) return NULL;
    if (hp_slots[i].ptr == ptr) return hp_slots[i].props;
  }
}

static void hp_grow(void) {
  ScrHandleProps *old = hp_slots;
  size_t old_capacity = hp_capacity;
  hp_capacity = old_capacity ? old_capacity * 2 : 64;
  hp_slots = calloc(hp_capacity, sizeof *hp_slots);
  if (!hp_slots) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < old_capacity; i++) {
    if (!old[i].ptr) continue;
    size_t j = hp_bucket(old[i].ptr);
    while (hp_slots[j].ptr) j = (j + 1) & (hp_capacity - 1);
    hp_slots[j] = old[i];
  }
  free(old);
}

/* Own property `key` of the table object, in *out; false when absent. */
static bool hp_entry(const ScrDyn *props, const char *key, size_t key_len, ScrDynProp *out) {
  if (!props) return false;
  size_t i = scr_dyn_obj_index_of(props, key, key_len);
  if (i == SIZE_MAX) return false;
  *out = scr_dyn_obj_prop_at(props, i);
  return true;
}

static bool hp_has(const ScrDyn *props, const char *key, size_t key_len) {
  return props && scr_dyn_obj_index_of(props, key, key_len) != SIZE_MAX;
}

/* A property the program added, read with the handle as `this`: an
 * accessor's getter runs on the handle, not on the table object that holds
 * it (`Object.defineProperty(map, "x", { get() { return this.size; } })`).
 * +1, or NULL with the exception pending. */
static ScrDyn *hp_read(ScrDyn *props, ScrDyn *self, const char *key, size_t key_len) {
  ScrDynProp e;
  if (!hp_entry(props, key, key_len, &e) || !e.accessor) return scr_dyn_obj_read(props, key, key_len);
  if (!e.getter) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *getter = scr_dyn_retain(e.getter);
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(getter, NULL, 0, "getter");
  scr_dyn_this_pop();
  scr_dyn_release(getter);
  return result;
}

/* The class's methods as values (`spawned.kill.bind(spawned)`): a function
 * that calls the class's own method on the child it was read from, also
 * after a property of the same name replaces the method. */
static const char *const hp_methods[] = {
  "kill", "ref", "unref", "on", "once", "off", "addListener", "removeListener",
};

static ScrDyn *hp_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrDyn *self = scr_box_get_ref(clo->caps[0]);
  const char *method = hp_methods[(size_t)scr_box_get_f64(clo->caps[1])];
  ScrDyn *result = hp_orig[SCR_DYNH_CHILD]->invoke(self->v.handle.ptr, self, method, args, argc, method);
  scr_dyn_release(self);
  return result;
}

static ScrDyn *hp_method_value(void *h, const char *key, size_t key_len) {
  for (size_t i = 0; i < sizeof hp_methods / sizeof *hp_methods; i++) {
    if (strlen(hp_methods[i]) != key_len || memcmp(hp_methods[i], key, key_len)) continue;
    ScrClosure *clo = scr_closure_new(NULL, 2);
    clo->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(clo->caps[0], scr_dyn_new_handle(h, SCR_DYNH_CHILD));
    clo->caps[1] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(clo->caps[1], (double)i);
    return scr_dyn_new_func(clo, &hp_method_call, 0, "(...args)", hp_methods[i]);
  }
  return NULL;
}

#define HP_TAGS(X) \
  X(DATE) X(REGEXP) X(MAP) X(SET) X(WEAK_MAP) X(WEAK_SET) \
  X(ARRAY_BUFFER) X(SHARED_ARRAY_BUFFER) X(FINALIZATION_REGISTRY)

static bool hp_accepts(ScrDynHandleTag tag) {
  switch (tag) {
#define HP_CASE(name) case SCR_DYNH_##name:
  HP_TAGS(HP_CASE)
#undef HP_CASE
  case SCR_DYNH_CHILD:
    return true;
  default:
    return false;
  }
}

static ScrDyn *hp_get_tag(ScrDynHandleTag tag, void *h, const char *key, size_t key_len) {
  ScrDyn *props = hp_find(h);
  if (hp_has(props, key, key_len)) {
    ScrDyn *self = scr_dyn_new_handle(h, tag);
    ScrDyn *result = hp_read(props, self, key, key_len);
    scr_dyn_release(self);
    return result;
  }
  const ScrDynHandleOps *orig = hp_orig[tag];
  return orig->get ? orig->get(h, key, key_len) : NULL;
}

static ScrDyn *hp_invoke_tag(ScrDynHandleTag tag, void *h, ScrDyn *self, const char *method,
                             ScrDyn *const *args, size_t argc, const char *what) {
  ScrDyn *props = hp_find(h);
  size_t len = strlen(method);
  const ScrDynHandleOps *orig = hp_orig[tag];
  ScrDyn *fn = NULL;
  if (hp_has(props, method, len)) {
    fn = hp_read(props, self, method, len);
  } else if (orig->invoke) {
    return orig->invoke(h, self, method, args, argc, what);
  } else {
    /* scr_dynh_dispatch's fallback for ops without invoke. */
    fn = orig->get ? orig->get(h, method, len) : NULL;
    if (scr_exc_pending()) { scr_dyn_release(fn); return NULL; }
    if (!fn) fn = scr_dyn_retain(scr_dyn_undefined());
  }
  if (!fn) return NULL;
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

#define HP_TRAMPOLINES(name) \
  static ScrDyn *hp_get_##name(void *h, const char *k, size_t n) { \
    return hp_get_tag(SCR_DYNH_##name, h, k, n); \
  } \
  static ScrDyn *hp_invoke_##name(void *h, ScrDyn *self, const char *m, ScrDyn *const *a, \
                                  size_t c, const char *w) { \
    return hp_invoke_tag(SCR_DYNH_##name, h, self, m, a, c, w); \
  }
HP_TAGS(HP_TRAMPOLINES)
#undef HP_TRAMPOLINES

static ScrDyn *hp_get(void *h, const char *key, size_t key_len);
static ScrDyn *hp_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                         const char *what);
static bool hp_set(void *h, const char *key, size_t key_len, const ScrDyn *value);

/* Copies the tag's current ops and points get and invoke at the table. */
static void hp_refresh(ScrDynHandleTag tag, const ScrDynHandleOps *current) {
  hp_orig[tag] = current;
  hp_ops[tag] = *current;
  if (tag == SCR_DYNH_CHILD) {
    hp_ops[tag].get = &hp_get;
    hp_ops[tag].set = &hp_set;
    hp_ops[tag].invoke = &hp_invoke;
    return;
  }
  switch (tag) {
#define HP_SET_OPS(name) \
  case SCR_DYNH_##name: \
    hp_ops[tag].get = &hp_get_##name; \
    hp_ops[tag].invoke = &hp_invoke_##name; \
    break;
  HP_TAGS(HP_SET_OPS)
#undef HP_SET_OPS
  default:
    break;
  }
}

static const ScrDynHandleOps *hp_current_ops(ScrDynHandleTag tag) {
  ScrDyn probe;
  memset(&probe, 0, sizeof probe);
  probe.kind = SCR_DYN_HANDLE;
  probe.v.handle.tag = tag;
  return scr_dyn_handle_ops_of(&probe);
}

static void hp_wrap(ScrDynHandleTag tag) {
  if (hp_wrapped[tag]) return;
  hp_refresh(tag, hp_current_ops(tag));
  hp_wrapped[tag] = true;
  scr_dyn_handle_install(tag, &hp_ops[tag]);
}

/* scr_dyn_handle_install's hook: an owning unit installing its ops again
 * keeps the wrapper, which now forwards to them. */
static const ScrDynHandleOps *hp_install(ScrDynHandleTag tag, const ScrDynHandleOps *ops) {
  if (!hp_wrapped[tag] || ops == &hp_ops[tag]) return ops;
  if (ops != hp_orig[tag]) hp_refresh(tag, ops);
  return &hp_ops[tag];
}

/* The table of `handle` (borrowed), made on first use; NULL with a
 * pending SC2020 error for a tag that takes no properties. */
static ScrDyn *hp_props_of_box(const ScrDyn *handle) {
  void *h = handle->v.handle.ptr;
  ScrDyn *props = hp_find(h);
  if (props) return props;
  ScrDynHandleTag tag = handle->v.handle.tag;
  if (!hp_accepts(tag)) {
    char message[160];
    snprintf(message, sizeof message, "own properties on a %s are not supported yet",
             scr_dyn_handle_cls(handle));
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
    return NULL;
  }
  hp_wrap(tag);
  if (!hp_slots) scr_atexit(hp_cleanup);
  if ((hp_count + 1) * 2 > hp_capacity) hp_grow();
  size_t i = hp_bucket(h);
  while (hp_slots[i].ptr) i = (i + 1) & (hp_capacity - 1);
  props = scr_dyn_new_obj_null_proto();
  hp_slots[i].ptr = hp_orig[tag]->retain(h);
  hp_slots[i].tag = tag;
  hp_slots[i].props = props;
  hp_count++;
  return props;
}

static bool hp_object_proto_name(const char *key, size_t len) {
  static const char *const names[] = {
    "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
    "toString", "valueOf", "__proto__", "__defineGetter__", "__defineSetter__",
    "__lookupGetter__", "__lookupSetter__",
  };
  for (size_t i = 0; i < sizeof names / sizeof *names; i++)
    if (strlen(names[i]) == len && memcmp(names[i], key, len) == 0) return true;
  return false;
}

/* Whether `key` names a member of the handle's class: one of its methods
 * as values, a property its ops model, an inherited prototype member, or
 * an Object.prototype name. A modeled read that throws (a real but
 * unmodeled member) counts as a member. */
static bool hp_is_member(const ScrDyn *handle, const ScrStr *key) {
  if (hp_object_proto_name(key->data, key->len)) return true;
  ScrDynHandleTag tag = handle->v.handle.tag;
  const ScrDynHandleOps *ops = hp_wrapped[tag] ? hp_orig[tag] : hp_current_ops(tag);
  for (const ScrDynHandleMethod *m = ops->methods; m && m->name; m++)
    if (strlen(m->name) == key->len && memcmp(m->name, key->data, key->len) == 0) return true;
  if (ops->get) {
    ScrDyn *value = ops->get(handle->v.handle.ptr, key->data, key->len);
    if (scr_exc_pending()) { scr_exc_clear(); return true; }
    if (value) { scr_dyn_release(value); return true; }
  }
  ScrDyn *inherited = scr_dyn_inherited_read(handle, key, scr_dyn_retain(scr_dyn_undefined()));
  if (!inherited) { scr_exc_clear(); return true; }
  bool member = inherited->kind != SCR_DYN_UNDEF;
  scr_dyn_release(inherited);
  return member;
}

static void hp_member_refusal(const ScrDyn *handle, const ScrStr *key, const char *what) {
  char message[256];
  snprintf(message, sizeof message, "%s the %s member '%.*s' is not supported yet", what,
           scr_dyn_handle_cls(handle), (int)(key->len > 100 ? 100 : key->len), key->data);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
}

static ScrDyn *hp_table_of(const ScrDyn *handle) { return hp_find(handle->v.handle.ptr); }

static ScrDyn *hp_write_table(ScrDyn *handle, const ScrStr *key) {
  ScrDyn *props = hp_find(handle->v.handle.ptr);
  if (hp_has(props, key->data, key->len)) return props;
  ScrDynHandleTag tag = handle->v.handle.tag;
  if (!hp_accepts(tag)) return NULL;
  if (!hp_members_open[tag] && hp_is_member(handle, key)) return NULL; /* ordinary arm refuses */
  return hp_props_of_box(handle);
}

static bool hp_in(const ScrDyn *handle, const ScrStr *key, bool *out) {
  ScrDyn *props = hp_table_of(handle);
  if (!hp_has(props, key->data, key->len)) return false;
  *out = true;
  return true;
}

/* A canonical array index key: non-empty, all ASCII digits, no leading zero
 * unless the key is "0", below 4294967295. */
static bool hp_is_index(const ScrStr *k) {
  if (!k || k->len == 0 || k->len > 10) return false;
  if (k->len > 1 && k->data[0] == '0') return false;
  unsigned long long value = 0;
  for (size_t i = 0; i < k->len; i++) {
    if (k->data[i] < '0' || k->data[i] > '9') return false;
    value = value * 10 + (unsigned long long)(k->data[i] - '0');
  }
  return value < 4294967295ULL;
}

static bool hp_has_own(const ScrDyn *handle, const ScrStr *key, bool enumerable_only, bool *out) {
  if (!hp_accepts(handle->v.handle.tag)) return false;
  ScrDyn *props = hp_table_of(handle);
  ScrDynProp entry;
  if (hp_entry(props, key->data, key->len, &entry)) {
    *out = !enumerable_only || entry.enumerable;
    return true;
  }
  /* RegExp's own lastIndex (writable, not enumerable). */
  if (handle->v.handle.tag == SCR_DYNH_REGEXP && key->len == 9 && memcmp(key->data, "lastIndex", 9) == 0) {
    *out = !enumerable_only;
    return true;
  }
  if (hp_is_member(handle, key)) {
    *out = false; /* members live on the prototype */
    return true;
  }
  *out = false;
  return true;
}

/* V8's TypeError for a strict delete of a non-configurable own property:
 * a Date or RegExp prints by its toString tag, the other handles by class. */
static void hp_throw_unconfigurable(const ScrDyn *handle, const ScrStr *key) {
  static const char head[] = "Cannot delete property '";
  static const char mid[] = "' of ";
  static const char tag_open[] = "[object ";
  static const char tag_close[] = "]";
  static const char class_open[] = "#<";
  static const char class_close[] = ">";
  ScrDynHandleTag tag = handle->v.handle.tag;
  bool tag_form = tag == SCR_DYNH_DATE || tag == SCR_DYNH_REGEXP;
  const char *open = tag_form ? tag_open : class_open;
  const char *close = tag_form ? tag_close : class_close;
  const char *cls = scr_dyn_handle_cls(handle);
  size_t open_len = strlen(open), cls_len = strlen(cls), close_len = strlen(close);
  size_t len = sizeof head - 1 + key->len + sizeof mid - 1 + open_len + cls_len + close_len;
  char *msg = malloc(len);
  if (!msg) scr_trap("scriptc: out of memory\n");
  char *p = msg;
  memcpy(p, head, sizeof head - 1);
  p += sizeof head - 1;
  memcpy(p, key->data, key->len);
  p += key->len;
  memcpy(p, mid, sizeof mid - 1);
  p += sizeof mid - 1;
  memcpy(p, open, open_len);
  p += open_len;
  memcpy(p, cls, cls_len);
  p += cls_len;
  memcpy(p, close, close_len);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, len);
  free(msg);
}

static bool hp_delete_key(ScrDyn *handle, const ScrStr *key, bool strict) {
  ScrDyn *props = hp_table_of(handle);
  if (!hp_has(props, key->data, key->len)) return false;
  ScrDyn *desc = scr_dyn_own_descriptor(props, key);
  bool configurable = true;
  if (desc && desc->kind == SCR_DYN_OBJ) {
    ScrDyn *flag = scr_dyn_obj_get(desc, "configurable", 12);
    configurable = flag && scr_dyn_truthy(flag);
  }
  scr_dyn_release(desc);
  if (!configurable) {
    /* The table's own object would name itself in the TypeError; the
     * property belongs to the handle. */
    if (strict) hp_throw_unconfigurable(handle, key);
    return true;
  }
  scr_dyn_key_delete(props, key, strict);
  return true;
}

static bool hp_own_descriptor(ScrDyn *handle, ScrDyn *key, ScrDyn **out) {
  if (key->kind != SCR_DYN_STR) return false;
  ScrDyn *props = hp_table_of(handle);
  if (hp_has(props, key->v.str->data, key->v.str->len)) {
    *out = scr_dyn_own_descriptor(props, key->v.str);
    return true;
  }
  if (!hp_accepts(handle->v.handle.tag)) return false;
  if (handle->v.handle.tag == SCR_DYNH_REGEXP && key->v.str->len == 9 &&
      memcmp(key->v.str->data, "lastIndex", 9) == 0) {
    /* The regex unit models lastIndex as a writable, non-enumerable,
     * non-configurable own data property. */
    ScrDynHandleTag tag = handle->v.handle.tag;
    const ScrDynHandleOps *orig = hp_wrapped[tag] ? hp_orig[tag] : hp_current_ops(tag);
    ScrDyn *value = orig->get ? orig->get(handle->v.handle.ptr, "lastIndex", 9) : NULL;
    if (!value) return false;
    ScrDyn *desc = scr_dyn_new_obj();
    scr_dyn_obj_set(desc, "value", 5, value);
    scr_dyn_obj_set(desc, "writable", 8, scr_dyn_new_bool(true));
    scr_dyn_obj_set(desc, "enumerable", 10, scr_dyn_new_bool(false));
    scr_dyn_obj_set(desc, "configurable", 12, scr_dyn_new_bool(false));
    *out = desc;
    return true;
  }
  /* A member lives on the class's prototype, not on the handle: H1 does
   * not implement member reflection, so the ordinary path refuses it
   * rather than answer undefined for a property that may exist. */
  if (hp_is_member(handle, key->v.str)) return false;
  *out = scr_dyn_retain(scr_dyn_undefined());
  return true;
}

static bool hp_define(ScrDyn *handle, ScrDyn *key, ScrDyn *descriptor, ScrDyn **out) {
  if (key->kind == SCR_DYN_SYMBOL) return false;
  ScrStr *name = key->kind == SCR_DYN_STR ? scr_str_retain(key->v.str) : NULL;
  if (!name) {
    ScrDyn *k = scr_dyn_property_key_value(key);
    if (!k) { *out = NULL; return true; }
    if (k->kind == SCR_DYN_SYMBOL) { scr_dyn_release(k); return false; }
    name = scr_str_retain(k->v.str);
    scr_dyn_release(k);
  }
  ScrDyn *props = hp_find(handle->v.handle.ptr);
  ScrDynHandleTag tag = handle->v.handle.tag;
  if (!hp_has(props, name->data, name->len)) {
    if (!hp_accepts(tag)) { scr_str_release(name); return false; }
    if (!hp_members_open[tag] && hp_is_member(handle, name)) {
      hp_member_refusal(handle, name, "Object.defineProperty of");
      scr_str_release(name);
      *out = NULL;
      return true;
    }
    props = hp_props_of_box(handle);
    if (!props) { scr_str_release(name); *out = NULL; return true; }
  }
  ScrDyn *k = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *defined = scr_dyn_define_property(props, k, descriptor);
  scr_dyn_release(k);
  if (!defined) { *out = NULL; return true; }
  scr_dyn_release(defined);
  *out = scr_dyn_retain(handle);
  return true;
}

static ScrDyn *hp_names_merge(const ScrDyn *handle, const ScrDyn *props, bool enumerable_only) {
  ScrDyn *out = scr_dyn_new_arr();
  ScrDyn *names = props ? (enumerable_only ? scr_dyn_obj_keys(props) : scr_dyn_get_own_property_names(props)) : NULL;
  size_t n = names ? names->v.arr.len : 0;
  /* integer-like keys first (the table already orders them first) */
  size_t i = 0;
  for (; i < n && hp_is_index(names->v.arr.items[i]->v.str); i++)
    scr_dyn_arr_push(out, scr_dyn_retain(names->v.arr.items[i]));
  if (!enumerable_only && handle->v.handle.tag == SCR_DYNH_REGEXP) {
    ScrStr *s = scr_str_new("lastIndex", 9);
    scr_dyn_arr_push(out, scr_dyn_new_str(s));
    scr_str_release(s);
  }
  for (; i < n; i++) scr_dyn_arr_push(out, scr_dyn_retain(names->v.arr.items[i]));
  scr_dyn_release(names);
  return out;
}

static bool hp_own_names(const ScrDyn *handle, ScrDyn **out) {
  if (!hp_accepts(handle->v.handle.tag)) return false;
  *out = hp_names_merge(handle, hp_table_of(handle), false);
  return true;
}

static bool hp_for_in_keys(const ScrDyn *handle, ScrDyn **out) {
  if (!hp_accepts(handle->v.handle.tag)) return false;
  *out = hp_names_merge(handle, hp_table_of(handle), true);
  return true;
}

/* The ScrObjWalk modes scr_json.c passes (private to that unit). */
enum { HP_WALK_KEYS = 0, HP_WALK_VALUES = 1, HP_WALK_ENTRIES = 2 };

/* Object.keys/values/entries: the table's enumerable own string keys;
 * accessors run with the handle as `this`. */
static bool hp_objwalk(const ScrDyn *handle, int mode, ScrDyn **out) {
  if (!hp_accepts(handle->v.handle.tag)) return false;
  ScrDyn *props = hp_table_of(handle);
  ScrDyn *keys = hp_names_merge(handle, props, true);
  if (mode == HP_WALK_KEYS) { *out = keys; return true; }
  ScrDyn *result = scr_dyn_new_arr();
  for (size_t i = 0; i < keys->v.arr.len; i++) {
    ScrStr *k = keys->v.arr.items[i]->v.str;
    ScrDyn *value = hp_read(props, (ScrDyn *)handle, k->data, k->len);
    if (!value) { scr_dyn_release(result); scr_dyn_release(keys); *out = NULL; return true; }
    if (mode == HP_WALK_VALUES) {
      scr_dyn_arr_push(result, value);
    } else {
      ScrDyn *pair = scr_dyn_new_arr();
      scr_dyn_arr_push(pair, scr_dyn_retain(keys->v.arr.items[i]));
      scr_dyn_arr_push(pair, value);
      scr_dyn_arr_push(result, pair);
    }
  }
  scr_dyn_release(keys);
  *out = result;
  return true;
}

/* Integrity lives on the table. Freezing a RegExp would make lastIndex
 * read-only, which the regex unit does not honor: refused. Map and Set
 * also mark their collection for preventExtensions and seal (the ordinary
 * path runs after this one). */
static bool hp_integrity(ScrDyn *handle, int op, ScrDyn **out_value, bool *out_bool) {
  ScrDynHandleTag tag = handle->v.handle.tag;
  if (!hp_accepts(tag) || tag == SCR_DYNH_CHILD) return false;
  bool collection = tag == SCR_DYNH_MAP || tag == SCR_DYNH_SET;
  if (op <= 2) {
    if (op == 2 && tag == SCR_DYNH_REGEXP) {
      static const char message[] = "Object.freeze of a RegExp is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      *out_value = NULL;
      return true;
    }
    ScrDyn *props = hp_props_of_box(handle);
    if (!props) { *out_value = NULL; return true; }
    ScrDyn *r = op == 0 ? scr_dyn_prevent_extensions(props) : op == 1 ? scr_dyn_seal(props) : scr_dyn_freeze(props);
    if (!r) { *out_value = NULL; return true; }
    scr_dyn_release(r);
    /* Freezing a collection changes only its own properties, which the
     * table holds; the ordinary path has no collection branch for it. */
    if (collection && op < 2) return false;
    *out_value = scr_dyn_retain(handle);
    return true;
  }
  ScrDyn *props = hp_table_of(handle);
  if (!props) {
    if (collection) return false;
    *out_bool = op == 3; /* a handle without a table is extensible, not sealed, not frozen */
    return true;
  }
  if (op == 5 && tag == SCR_DYNH_REGEXP) {
    *out_bool = false; /* lastIndex stays writable (freeze is refused) */
    return true;
  }
  *out_bool = op == 3 ? scr_dyn_is_extensible(props) : op == 4 ? scr_dyn_is_sealed(props) : scr_dyn_is_frozen(props);
  return true;
}

static const ScrDynHandlePropsHooks hp_hooks = {
  .table = hp_table_of, .install = hp_install, .write_table = hp_write_table,
  .in = hp_in, .has_own = hp_has_own, .delete_key = hp_delete_key,
  .own_descriptor = hp_own_descriptor, .define = hp_define, .own_names = hp_own_names,
  .objwalk = hp_objwalk, .for_in_keys = hp_for_in_keys, .integrity = hp_integrity,
};

static ScrDyn *hp_get(void *h, const char *key, size_t key_len) {
  ScrDyn *props = hp_find(h);
  if (hp_has(props, key, key_len)) {
    ScrDyn *self = scr_dyn_new_handle(h, SCR_DYNH_CHILD);
    ScrDyn *result = hp_read(props, self, key, key_len);
    scr_dyn_release(self);
    return result;
  }
  const ScrDynHandleOps *orig = hp_orig[SCR_DYNH_CHILD];
  ScrDyn *value = orig->get(h, key, key_len);
  if (value || scr_exc_pending()) return value;
  return hp_method_value(h, key, key_len);
}

static bool hp_set(void *h, const char *key, size_t key_len, const ScrDyn *value) {
  ScrDyn *props = hp_find(h);
  ScrDynProp found;
  const ScrDynProp *entry = hp_entry(props, key, key_len, &found) ? &found : NULL;
  if (entry && entry->accessor) {
    /* An accessor's setter runs on the child. Without one the write throws
     * the strict-mode TypeError, as the other handle getters do. */
    if (!entry->setter) {
      /* Built at its exact length: a property name has no length limit. */
      static const char head[] = "Cannot set property ";
      static const char tail[] = " of #<ChildProcess> which has only a getter";
      size_t len = sizeof head - 1 + key_len + sizeof tail - 1;
      char *msg = malloc(len);
      if (!msg) scr_trap("scriptc: out of memory\n");
      memcpy(msg, head, sizeof head - 1);
      memcpy(msg + sizeof head - 1, key, key_len);
      memcpy(msg + sizeof head - 1 + key_len, tail, sizeof tail - 1);
      scr_throw_error_msg(SCR_ERR_TYPE, msg, len);
      free(msg);
      return true;
    }
    ScrDyn *setter = scr_dyn_retain(entry->setter);
    ScrDyn *self = scr_dyn_new_handle(h, SCR_DYNH_CHILD);
    ScrDyn *arg = (ScrDyn *)value;
    scr_dyn_this_push_dyn(self);
    ScrDyn *result = scr_dyn_call(setter, &arg, 1, "setter");
    scr_dyn_this_pop();
    scr_dyn_release(self);
    scr_dyn_release(setter);
    if (result) scr_dyn_release(result);
    return true;
  }
  return false;
}

static ScrDyn *hp_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                         const char *what) {
  ScrDyn *props = hp_find(h);
  size_t len = strlen(method);
  if (!hp_has(props, method, len)) return hp_orig[SCR_DYNH_CHILD]->invoke(h, self, method, args, argc, what);
  ScrDyn *fn = hp_read(props, self, method, len);
  if (!fn) return NULL;
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

/* Programs that add properties to handles call it at start (%main), and
 * again after the child unit reinstalls its ops (scr_child_on_dyn_hp).
 * `child` is 1 when the program adds properties to children: only then
 * does the child tag take a wrapper (its unit installs its ops before
 * %main, and a program without child additions never boxes one). */
void scr_dyn_handle_props_install(double child) {
  scr_dyn_handle_props_hooks = &hp_hooks;
  if (child == 0) return;
  hp_members_open[SCR_DYNH_CHILD] = true;
  const ScrDynHandleOps *current = hp_current_ops(SCR_DYNH_CHILD);
  if (current == &hp_ops[SCR_DYNH_CHILD]) return;
  hp_refresh(SCR_DYNH_CHILD, current);
  hp_wrapped[SCR_DYNH_CHILD] = true;
  scr_dyn_handle_install(SCR_DYNH_CHILD, &hp_ops[SCR_DYNH_CHILD]);
}

/* Object.defineProperty / Reflect.defineProperty: every accepted handle
 * target defines the property on its table (the hooks handle the rest). */
ScrDyn *scr_dyn_define_property_hp(ScrDyn *target, ScrDyn *key, ScrDyn *descriptor) {
  return scr_dyn_define_property(target, key, descriptor);
}

/* Object.getOwnPropertyDescriptor / Reflect.getOwnPropertyDescriptor. */
ScrDyn *scr_dyn_get_own_property_descriptor_hp(ScrDyn *target, ScrDyn *key) {
  return scr_dyn_get_own_property_descriptor(target, key);
}

/* Object.defineProperties in a program with handle tables: a handle
 * target defines each descriptor on its table (scr_dyn_define_props
 * lives in an always-linked unit that rejects non-objects). */
ScrDyn *scr_dyn_define_props_hp(ScrDyn *target, ScrDyn *descs) {
  if (target->kind != SCR_DYN_HANDLE || !hp_accepts(target->v.handle.tag) || descs->kind != SCR_DYN_OBJ)
    return scr_dyn_define_props(target, descs); /* its own errors and paths */
  ScrDyn *keys = scr_dyn_obj_keys(descs); /* own enumerable string keys, in order */
  if (!keys) return NULL;
  size_t n = keys->v.arr.len;
  ScrDyn **descriptors = calloc(n ? n : 1, sizeof *descriptors);
  if (!descriptors) scr_trap("scriptc: out of memory\n");
  bool ok = true;
  /* ObjectDefineProperties reads every descriptor before defining any. */
  for (size_t i = 0; i < n && ok; i++) {
    ScrStr *k = keys->v.arr.items[i]->v.str;
    descriptors[i] = scr_dyn_obj_read(descs, k->data, k->len);
    ok = descriptors[i] != NULL;
  }
  for (size_t i = 0; i < n && ok; i++) {
    ScrDyn *out = NULL;
    hp_define(target, keys->v.arr.items[i], descriptors[i], &out);
    if (!out) ok = false;
    else scr_dyn_release(out);
  }
  for (size_t i = 0; i < n; i++) if (descriptors[i]) scr_dyn_release(descriptors[i]);
  free(descriptors);
  scr_dyn_release(keys);
  return ok ? scr_dyn_retain(target) : NULL;
}

/* PromiseResolve for `await`: a child with a callable `then` property is a
 * thenable, adopted through an object whose `then` calls it with the child
 * as `this`. */
ScrPromise *scr_dyn_promise_resolve_hp(ScrDyn *value, ScrDyn *reader) {
  if (value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_CHILD) {
    ScrDyn *props = hp_find(value->v.handle.ptr);
    if (hp_has(props, "then", 4)) {
      ScrDyn *then = scr_dyn_obj_read(props, "then", 4);
      if (!then) return scr_dyn_promise_resolve(value, reader);
      if (then->kind == SCR_DYN_FUNC) {
        ScrDyn *bound = scr_dyn_bind(then, &value, 1);
        ScrDyn *thenable = scr_dyn_new_obj();
        scr_dyn_obj_set(thenable, "then", 4, bound);
        ScrPromise *promise = scr_dyn_promise_resolve(thenable, reader);
        scr_dyn_release(thenable);
        scr_dyn_release(then);
        return promise;
      }
      scr_dyn_release(then);
    }
  }
  return scr_dyn_promise_resolve(value, reader);
}

/* child.on(event, listener) from typed code reinstalls the child unit's
 * ops; wrap them again. */
void scr_child_on_dyn_hp(ScrChild *child, ScrStr *event, ScrDyn *listener) {
  scr_child_on_dyn(child, event, listener);
  scr_dyn_handle_props_install(1.0);
}

/* The graph walkers (console.log, util.inspect, JSON.stringify, deep
 * equality) cannot print or compare a handle's own properties: refuse a
 * value whose graph holds a handle with any. Mirrors scr_js_wrapper.c's
 * scr_js_wrapper_found; accessors are not called. */
static bool hp_found(const ScrDyn *value, int depth) {
  if (!value || depth > 64) return false;
  if (value->kind == SCR_DYN_HANDLE) {
    ScrDyn *props = hp_find(value->v.handle.ptr);
    return props && scr_dyn_obj_count(props) > 0;
  }
  if (value->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < value->v.arr.len; i++)
      if (value->v.arr.items[i] && hp_found(value->v.arr.items[i], depth + 1)) return true;
    return false;
  }
  if (value->kind == SCR_DYN_OBJ) {
    for (size_t i = 0, n = scr_dyn_obj_count(value); i < n; i++) {
      ScrDynProp p = scr_dyn_obj_prop_at(value, i);
      if (!p.accessor && hp_found(p.value, depth + 1)) return true;
    }
  }
  return false;
}

static void hp_refuse(const ScrStr *consumer) {
  char message[200];
  snprintf(message, sizeof message,
           "%.*s of a Date, RegExp, Map, Set or buffer with added own properties is not supported yet",
           (int)(consumer->len > 120 ? 120 : consumer->len), consumer->data);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
}

ScrDyn *scr_dyn_handle_props_guard(ScrDyn *value, ScrStr *consumer) {
  if (hp_found(value, 0)) { hp_refuse(consumer); return NULL; }
  return scr_dyn_retain(value);
}

ScrArr *scr_dyn_handle_props_guard_list(ScrArr *values, ScrStr *consumer) {
  for (size_t i = 0; i < values->len; i++) {
    ScrDyn *value = scr_arr_get_ref(values, (double)i);
    bool found = hp_found(value, 0);
    scr_dyn_release(value);
    if (found) { hp_refuse(consumer); return NULL; }
  }
  return scr_arr_retain(values);
}

/* The same check for a typed handle argument, boxed only for the check. */
void scr_dyn_handle_props_check(ScrDyn *value, ScrStr *consumer) {
  if (hp_found(value, 0)) hp_refuse(consumer);
}
