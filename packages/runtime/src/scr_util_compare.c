#include "scr_runtime.h"

#include <string.h>

/* Node 24 strict comparison for values whose checked representation retains
 * their observable shape. Never materialize an opaque native object as an
 * ordinary record: doing so would discard its intrinsic brand/prototype. */
typedef struct ScrDeepFrame {
  const ScrDyn *a, *b;
  const struct ScrDeepFrame *parent;
} ScrDeepFrame;

static bool util_deep_refused(const char *kind) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "util.isDeepStrictEqual over ");
  scr_jb_puts(&message, kind);
  scr_jb_puts(&message, " is not supported yet");
  ScrStr *text = scr_jb_finish(&message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "SC2020");
  scr_str_release(text);
  return false;
}

static bool util_deep_equal(const ScrDyn *, const ScrDyn *, bool, const ScrDeepFrame *);

static size_t util_deep_key_count(const ScrDyn *table) {
  size_t count = 0;
  if (table) for (size_t i = 0; i < table->v.obj.len; i++) count += table->v.obj.entries[i].enumerable;
  return count;
}

static bool util_deep_same_keys(const ScrDyn *a, const ScrDyn *b) {
  if (util_deep_key_count(a) != util_deep_key_count(b)) return false;
  if (a) for (size_t i = 0; i < a->v.obj.len; i++) {
    const ScrDynEntry *e = &a->v.obj.entries[i];
    if (e->enumerable && (!b || !scr_dyn_obj_enumerable(b, e->key, e->key_len))) return false;
  }
  return true;
}

static ScrDyn *util_deep_constructor(const ScrDyn *value) {
  for (const ScrDyn *p = value; p; p = p->prototype) {
    const ScrDyn *table = p->kind == SCR_DYN_OBJ ? p : p->kind == SCR_DYN_ARR ? p->v.arr.properties : NULL;
    if (table) for (size_t i = 0; i < table->v.obj.len; i++) {
      const ScrDynEntry *e = &table->v.obj.entries[i];
      if (e->key_len == 11 && !memcmp(e->key, "constructor", 11)) {
        if (e->accessor) { util_deep_refused("native accessor properties"); return NULL; }
        if (p == value && e->value->kind == SCR_DYN_FUNC) {
          util_deep_refused("native own constructor functions"); return NULL;
        }
        return scr_dyn_retain(e->value);
      }
    }
    if (!p->prototype) {
      if (p->null_proto) return scr_dyn_retain(scr_dyn_undefined());
      // Object.prototype is an internal identity token here; general
      // Object.prototype reflection retains its existing native boundary.
      return p->kind == SCR_DYN_ARR ? scr_dyn_array_constructor() : scr_dyn_object_prototype();
    }
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *util_deep_tag(const ScrDyn *value) {
  bool has_symbols = false;
  for (const ScrDyn *p = value; p; p = p->prototype) has_symbols |= p->symbol_properties != NULL;
  if (!has_symbols) return scr_dyn_retain(scr_dyn_undefined());
  ScrStr *name = scr_str_new("toStringTag", 11);
  ScrSym *symbol = scr_sym_well_known(name);
  ScrDyn *key = scr_dyn_new_symbol(symbol);
  scr_str_release(name); scr_sym_release(symbol);
  for (const ScrDyn *p = value; p; p = p->prototype) {
    const ScrDyn *keys = p->symbol_keys;
    if (!keys) continue;
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      if (!scr_dyn_same_value(keys->v.arr.items[i], key)) continue;
      // General native getters retain an explicit boundary, including
      // non-enumerable Symbol.toStringTag descriptors read by Node.
      for (size_t j = 0; j < p->symbol_properties->v.obj.len; j++) {
        if (p->symbol_properties->v.obj.entries[j].accessor) {
          scr_dyn_release(key); util_deep_refused("native accessor properties"); return NULL;
        }
      }
      ScrDyn *result = scr_dyn_symbol_key_get(p, key, false);
      scr_dyn_release(key);
      return result;
    }
  }
  scr_dyn_release(key);
  return scr_dyn_retain(scr_dyn_undefined());
}

static bool util_deep_properties(const ScrDyn *a, const ScrDyn *b, bool skip,
                                  const ScrDeepFrame *frame) {
  if (util_deep_key_count(a) != util_deep_key_count(b)) return false;
  if (!a) return true;
  for (size_t i = 0; i < a->v.obj.len; i++) {
    const ScrDynEntry *x = &a->v.obj.entries[i];
    if (!x->enumerable) continue;
    const ScrDynEntry *y = NULL;
    if (b) for (size_t j = 0; j < b->v.obj.len; j++) {
      const ScrDynEntry *candidate = &b->v.obj.entries[j];
      if (candidate->enumerable && candidate->key_len == x->key_len &&
          !memcmp(candidate->key, x->key, x->key_len)) { y = candidate; break; }
    }
    if (!y) return false;
    if (x->accessor || y->accessor) return util_deep_refused("native accessor properties");
    // Materializing a cyclic typed child can refresh its ancestor table.
    // Retain the values before that refresh replaces descriptor storage.
    ScrDyn *xv = scr_dyn_retain(x->value), *yv = scr_dyn_retain(y->value);
    bool same = util_deep_equal(xv, yv, skip, frame);
    scr_dyn_release(xv); scr_dyn_release(yv);
    if (!same) return false;
  }
  return true;
}

static bool util_deep_equal(const ScrDyn *a, const ScrDyn *b, bool skip,
                             const ScrDeepFrame *parent) {
  if (scr_dyn_same_value(a, b)) return true;
  if (a->kind == SCR_DYN_PROXY || b->kind == SCR_DYN_PROXY)
    return util_deep_refused("native Proxy values");
  if (a->kind == SCR_DYN_JSVAL || b->kind == SCR_DYN_JSVAL) {
    scr_dyn_isl_fence(a->kind == SCR_DYN_JSVAL ? a : b, "util.isDeepStrictEqual");
    return false;
  }
  if (a->kind == SCR_DYN_TYPED_REF || b->kind == SCR_DYN_TYPED_REF) {
    const ScrDyn *inputs[] = { a, b };
    for (size_t i = 0; i < 2; i++) {
      const ScrDyn *v = inputs[i];
      if (v->kind == SCR_DYN_TYPED_REF &&
          strncmp(v->v.typed_ref.type_key, "record:", 7) &&
          strncmp(v->v.typed_ref.type_key, "array<", 6))
        return util_deep_refused("opaque native references");
    }
    ScrDyn *x = a->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(a) : scr_dyn_retain((ScrDyn *)a);
    ScrDyn *y = !scr_exc_pending() ? (b->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(b) : scr_dyn_retain((ScrDyn *)b)) : NULL;
    bool equal = !scr_exc_pending() && util_deep_equal(x, y, skip, parent);
    scr_dyn_release(x); scr_dyn_release(y);
    return equal;
  }
  if (a->kind == SCR_DYN_HANDLE || b->kind == SCR_DYN_HANDLE)
    return util_deep_refused("native handles");
  ScrError *error = scr_errdyn_err_of(a);
  if (!error) error = scr_errdyn_err_of(b);
  if (error) { scr_error_release(error); return util_deep_refused("native Error values"); }
  if (a->kind != b->kind) return false;
  if (a->kind != SCR_DYN_OBJ && a->kind != SCR_DYN_ARR && a->kind != SCR_DYN_BYTES) return false;
  if (!skip) {
    if (a->kind == SCR_DYN_BYTES) {
      if (a->buffer != b->buffer || a->prototype != b->prototype) return false;
    } else {
      ScrDyn *x = util_deep_constructor(a);
      ScrDyn *y = !scr_exc_pending() ? util_deep_constructor(b) : NULL;
      const ScrDyn *table = a->kind == SCR_DYN_OBJ ? a : a->v.arr.properties;
      bool inherited = !table || !scr_dyn_obj_get(table, "constructor", 11);
      bool compare_constructor = !scr_exc_pending() && x->kind != SCR_DYN_UNDEF && inherited;
      bool same = compare_constructor && scr_dyn_same_value(x, y);
      scr_dyn_release(x); scr_dyn_release(y);
      if (scr_exc_pending()) return false;
      if (!compare_constructor) {
        x = scr_dyn_get_prototype((ScrDyn *)a);
        y = !scr_exc_pending() ? scr_dyn_get_prototype((ScrDyn *)b) : NULL;
        same = !scr_exc_pending() && scr_dyn_same_value(x, y);
        scr_dyn_release(x); scr_dyn_release(y);
      }
      if (!same) return false;
    }
  }
  if (a->kind != SCR_DYN_BYTES) {
    ScrDyn *x = util_deep_tag(a);
    ScrDyn *y = !scr_exc_pending() ? util_deep_tag(b) : NULL;
    bool same = !scr_exc_pending() && scr_dyn_strict_eq(x, y);
    if (!same && !scr_exc_pending() && a->kind == SCR_DYN_OBJ &&
        (x->kind == SCR_DYN_UNDEF || y->kind == SCR_DYN_UNDEF)) {
      const ScrDyn *tag = x->kind == SCR_DYN_UNDEF ? y : x;
      same = tag->kind != SCR_DYN_STR || (tag->v.str->len == 6 && !memcmp(tag->v.str->data, "Object", 6));
    }
    scr_dyn_release(x); scr_dyn_release(y);
    if (!same) return false;
  }
  if (a->kind == SCR_DYN_ARR && a->v.arr.len != b->v.arr.len) return false;
  if (a->kind == SCR_DYN_BYTES) {
    const ScrBytes *x = a->v.bytes, *y = b->v.bytes;
    if (x->elem != y->elem || x->len != y->len) return false;
    SCR_SHARED_GUARD(x, y);
    size_t length = x->len * scr_bytes_elem_size(x->elem);
    if (length && memcmp(x->data, y->data, length)) return false;
  }
  const ScrDyn *props_a = a->kind == SCR_DYN_OBJ ? a : a->kind == SCR_DYN_ARR ? a->v.arr.properties : NULL;
  const ScrDyn *props_b = b->kind == SCR_DYN_OBJ ? b : b->kind == SCR_DYN_ARR ? b->v.arr.properties : NULL;
  if (!util_deep_same_keys(props_a, props_b) || !util_deep_same_keys(a->symbol_properties, b->symbol_properties)) return false;
  /* Match Node 24's shallow pair fast path, then its ancestor-set cycle
   * rule. These are path-local: repeated acyclic children remain structural. */
  if (parent && !parent->parent) {
    if (parent->a == a) return parent->b == b;
    if (parent->b == b) return false;
  } else if (parent) {
    bool seen_a = false, seen_b = false;
    for (const ScrDeepFrame *p = parent; p; p = p->parent) {
      seen_a |= a == p->a || a == p->b;
      seen_b |= b == p->a || b == p->b;
    }
    if (seen_a || seen_b) return seen_a && seen_b;
  }
  ScrDeepFrame frame = { a, b, parent };
  if (a->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < a->v.arr.len; i++) {
      bool present = scr_dyn_arr_has_index(a, i);
      if (present != scr_dyn_arr_has_index(b, i)) return false;
      if (present && !util_deep_equal(a->v.arr.items[i], b->v.arr.items[i], skip, &frame)) return false;
    }
    if (!util_deep_properties(a->v.arr.properties, b->v.arr.properties, skip, &frame)) return false;
  } else if (a->kind == SCR_DYN_OBJ) {
    if (!util_deep_properties(a, b, skip, &frame)) return false;
  }
  return util_deep_properties(a->symbol_properties, b->symbol_properties, skip, &frame);
}

bool scr_util_is_deep_strict_equal(const ScrDyn *a, const ScrDyn *b, const ScrDyn *skip) {
  return util_deep_equal(a, b, scr_dyn_truthy(skip), NULL);
}
