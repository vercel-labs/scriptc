/* Own properties that JavaScript adds to a native ChildProcess (execa's
 * Promise mixin: `spawned.kill = ...`, Reflect.defineProperty(spawned,
 * 'then', ...), then `await spawned`).
 *
 * A child crosses into the checked-dynamic tree as a fresh handle box each
 * time, so the properties live in a side table keyed by the native child,
 * one ordinary checked object per child. Wrapper ops for the child tag
 * consult that object first: reads and member calls find an added
 * property before the class's own members, and a write the class does not
 * model lands in it. The table keeps each child it describes alive until
 * the program exits. Linked only by programs that add properties to a
 * child (the compiler's handle-properties.ts). */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
  void *child; /* retained through the original ops */
  ScrDyn *props; /* owned checked object */
} ScrHandleProps;

static SCR_TL ScrHandleProps *hp_table;
static SCR_TL size_t hp_len, hp_cap;
static SCR_TL const ScrDynHandleOps *hp_orig;
static SCR_TL ScrDynHandleOps hp_ops;

static void hp_cleanup(void) {
  ScrHandleProps *table = hp_table;
  size_t len = hp_len;
  hp_table = NULL;
  hp_len = hp_cap = 0;
  for (size_t i = 0; i < len; i++) {
    scr_dyn_release(table[i].props);
    hp_orig->release(table[i].child);
  }
  free(table);
}

static ScrDyn *hp_find(void *child) {
  for (size_t i = 0; i < hp_len; i++)
    if (hp_table[i].child == child) return hp_table[i].props;
  return NULL;
}

/* The child's property object (borrowed), created on first use. */
static ScrDyn *hp_props_of(void *child) {
  ScrDyn *props = hp_find(child);
  if (props) return props;
  if (hp_len == hp_cap) {
    if (!hp_table) scr_atexit(hp_cleanup);
    hp_cap = hp_cap ? hp_cap * 2 : 8;
    hp_table = realloc(hp_table, hp_cap * sizeof *hp_table);
    if (!hp_table) scr_trap("scriptc: out of memory\n");
  }
  props = scr_dyn_new_obj();
  hp_table[hp_len].child = hp_orig->retain(child);
  hp_table[hp_len].props = props;
  hp_len++;
  return props;
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

/* A property the program added, read with the child as `this`: an
 * accessor's getter runs on the child, not on the table object that holds
 * it (`Object.defineProperty(child, "x", { get() { return this.pid; } })`).
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
  ScrDyn *result = hp_orig->invoke(self->v.handle.ptr, self, method, args, argc, method);
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

static ScrDyn *hp_get(void *h, const char *key, size_t key_len) {
  ScrDyn *props = hp_find(h);
  if (hp_has(props, key, key_len)) {
    ScrDyn *self = scr_dyn_new_handle(h, SCR_DYNH_CHILD);
    ScrDyn *result = hp_read(props, self, key, key_len);
    scr_dyn_release(self);
    return result;
  }
  ScrDyn *value = hp_orig->get(h, key, key_len);
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
  if (!entry) {
    if (hp_orig->set && hp_orig->set(h, key, key_len, value)) return true;
    props = hp_props_of(h);
  }
  ScrStr *name = scr_str_new(key, key_len);
  scr_dyn_key_set(props, name, (ScrDyn *)value);
  scr_str_release(name);
  return true;
}

static ScrDyn *hp_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                         const char *what) {
  ScrDyn *props = hp_find(h);
  size_t len = strlen(method);
  if (!hp_has(props, method, len)) return hp_orig->invoke(h, self, method, args, argc, what);
  ScrDyn *fn = hp_read(props, self, method, len);
  if (!fn) return NULL;
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

/* Wraps the child tag's ops (again after the child unit reinstalls its
 * own). Programs call it at start, after the child unit's install. */
void scr_dyn_handle_props_install(void) {
  ScrDyn probe;
  memset(&probe, 0, sizeof probe);
  probe.kind = SCR_DYN_HANDLE;
  probe.v.handle.tag = SCR_DYNH_CHILD;
  const ScrDynHandleOps *current = scr_dyn_handle_ops_of(&probe);
  if (current == &hp_ops) return;
  hp_orig = current;
  hp_ops = *current;
  hp_ops.get = &hp_get;
  hp_ops.set = &hp_set;
  hp_ops.invoke = &hp_invoke;
  scr_dyn_handle_install(SCR_DYNH_CHILD, &hp_ops);
}

static bool hp_is_child(const ScrDyn *d) {
  return d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_CHILD;
}

/* Object.defineProperty / Reflect.defineProperty: a child target defines
 * the property on its property object, with the descriptor's attributes. */
ScrDyn *scr_dyn_define_property_hp(ScrDyn *target, ScrDyn *key, ScrDyn *descriptor) {
  if (!hp_is_child(target) || key->kind == SCR_DYN_SYMBOL)
    return scr_dyn_define_property(target, key, descriptor);
  ScrDyn *defined = scr_dyn_define_property(hp_props_of(target->v.handle.ptr), key, descriptor);
  if (!defined) return NULL;
  scr_dyn_release(defined);
  return scr_dyn_retain(target);
}

/* Object.getOwnPropertyDescriptor / Reflect.getOwnPropertyDescriptor: a
 * property added to a child answers its descriptor. */
ScrDyn *scr_dyn_get_own_property_descriptor_hp(ScrDyn *target, ScrDyn *key) {
  if (hp_is_child(target) && key->kind == SCR_DYN_STR) {
    ScrDyn *props = hp_find(target->v.handle.ptr);
    if (hp_has(props, key->v.str->data, key->v.str->len))
      return scr_dyn_get_own_property_descriptor(props, key);
  }
  return scr_dyn_get_own_property_descriptor(target, key);
}

/* PromiseResolve for `await`: a child with a callable `then` property is a
 * thenable, adopted through an object whose `then` calls it with the child
 * as `this`. */
ScrPromise *scr_dyn_promise_resolve_hp(ScrDyn *value, ScrDyn *reader) {
  if (hp_is_child(value)) {
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
  scr_dyn_handle_props_install();
}
