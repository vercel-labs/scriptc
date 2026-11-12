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
  if (table) for (size_t i = 0; i < scr_dyn_obj_count(table); i++) count += scr_dyn_obj_prop_at(table, i).enumerable;
  return count;
}

static bool util_deep_same_keys(const ScrDyn *a, const ScrDyn *b) {
  if (util_deep_key_count(a) != util_deep_key_count(b)) return false;
  if (a) for (size_t i = 0; i < scr_dyn_obj_count(a); i++) {
    ScrDynProp e = scr_dyn_obj_prop_at(a, i);
    if (e.enumerable && (!b || !scr_dyn_obj_enumerable(b, e.key, e.key_len))) return false;
  }
  return true;
}

static ScrDyn *util_deep_constructor(const ScrDyn *value) {
  for (const ScrDyn *p = value; p; p = p->prototype) {
    const ScrDyn *table = p->kind == SCR_DYN_OBJ ? p : p->kind == SCR_DYN_ARR ? p->v.arr.properties : NULL;
    if (table) for (size_t i = 0; i < scr_dyn_obj_count(table); i++) {
      ScrDynProp e = scr_dyn_obj_prop_at(table, i);
      if (e.key_len == 11 && !memcmp(e.key, "constructor", 11)) {
        if (e.accessor) { util_deep_refused("an accessor constructor property"); return NULL; }
        if (p == value && e.value->kind == SCR_DYN_FUNC) {
          util_deep_refused("native own constructor functions"); return NULL;
        }
        return scr_dyn_retain(e.value);
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
      // Node reads Symbol.toStringTag with a Get, so an accessor tag would
      // run its getter, and its tag gates read it several times over, which
      // this comparison does not reproduce. That one descriptor stays a
      // refusal; an accessor for any other symbol takes part through the
      // property check below.
      const ScrDynEntry *tag = scr_dyn_own_symbol_entry(p, key);
      if (tag && tag->accessor) {
        scr_dyn_release(key);
        util_deep_refused("a native accessor Symbol.toStringTag");
        return NULL;
      }
      ScrDyn *result = scr_dyn_symbol_key_get(p, key, false);
      scr_dyn_release(key);
      return result;
    }
  }
  scr_dyn_release(key);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* Node's keyCheck reads each corresponding property through a Get
 * (`a[key]` and `b[key]`), so an own accessor takes part by the value its
 * getter answers, run with the object as `this`. A throwing getter
 * propagates to the caller, and a side without a getter answers undefined.
 * `owner` is the object the descriptor belongs to; the symbol-key tables
 * compare through their object so `this` is the instance, not the table. */
static ScrDyn *util_deep_property_value(const ScrDyn *owner, const ScrDynProp *prop) {
  if (!prop->accessor) return scr_dyn_retain(prop->value);
  if (!prop->getter) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *getter = scr_dyn_retain(prop->getter);
  scr_dyn_this_push_dyn(owner);
  ScrDyn *value = scr_dyn_call(getter, NULL, 0, "property getter");
  scr_dyn_this_pop();
  scr_dyn_release(getter);
  return value;
}

/* Copies the descriptor of the own key equal to (key, len) in `table` into
 * `*out`, with any enumerability: Node's keyCheck reads `b[key]` by name,
 * not through the enumerable snapshot it already took. */
static bool util_deep_find_prop(const ScrDyn *table, const char *key, size_t len,
                                ScrDynProp *out) {
  if (!table) return false;
  for (size_t j = 0; j < scr_dyn_obj_count(table); j++) {
    ScrDynProp candidate = scr_dyn_obj_prop_at(table, j);
    if (candidate.key_len == len && !memcmp(candidate.key, key, len)) {
      *out = candidate;
      return true;
    }
  }
  return false;
}

static bool util_deep_properties(const ScrDyn *a, const ScrDyn *b,
                                 const ScrDyn *owner_a, const ScrDyn *owner_b,
                                 bool skip, const ScrDeepFrame *frame) {
  if (util_deep_key_count(a) != util_deep_key_count(b)) return false;
  if (!b) return true;
  /* Node's keyCheck snapshots Object.keys(b) before any Get runs and then
   * reads `a[key]` and `b[key]` for each snapshot key, so a getter runs in
   * b's key order whichever order the two sides keep theirs in. The keys are
   * copied: a getter may add or remove b's entries, which moves, drops or
   * frees the descriptor storage the live table holds. */
  typedef struct {
    const char *key;
    size_t len;
  } DeepKey;
  size_t nb = scr_dyn_obj_count(b);
  DeepKey *keys = nb ? malloc(nb * sizeof *keys) : NULL;
  if (nb && !keys) scr_trap("scriptc: out of memory\n");
  size_t nkeys = 0;
  for (size_t i = 0; i < nb; i++) {
    ScrDynProp y = scr_dyn_obj_prop_at(b, i);
    if (!y.enumerable) continue;
    char *copy = malloc(y.key_len ? y.key_len : 1);
    if (!copy) scr_trap("scriptc: out of memory\n");
    memcpy(copy, y.key, y.key_len);
    keys[nkeys].key = copy;
    keys[nkeys].len = y.key_len;
    nkeys++;
  }
  bool same = true;
  for (size_t i = 0; same && i < nkeys; i++) {
    ScrDynProp xp;
    if (!util_deep_find_prop(a, keys[i].key, keys[i].len, &xp) || !xp.enumerable) {
      same = false;
      break;
    }
    // Materializing a cyclic typed child can refresh its ancestor table.
    // Read both values before that refresh replaces descriptor storage.
    ScrDyn *xv = util_deep_property_value(owner_a, &xp);
    /* a's getter may have deleted b's entry for this key: Node's second Get
     * reads `b[key]` as it stands at that moment, so the descriptor is
     * looked up afresh rather than carried across the callback. */
    ScrDyn *yv = NULL;
    if (xv && !scr_exc_pending()) {
      ScrDynProp yp;
      yv = util_deep_find_prop(b, keys[i].key, keys[i].len, &yp)
               ? util_deep_property_value(owner_b, &yp)
               : scr_dyn_retain(scr_dyn_undefined());
    }
    same = xv && yv && util_deep_equal(xv, yv, skip, frame);
    scr_dyn_release(xv);
    scr_dyn_release(yv);
  }
  for (size_t i = 0; i < nkeys; i++) free((void *)keys[i].key);
  free(keys);
  return same;
}

/* ── the built-in handle arms ──────────────────────────────────────────
 * internal/util/comparisons.mjs compares each built-in object by its
 * intrinsic value once the strict constructor and tag gates pass: a Date
 * by its time (an invalid date equals another invalid one), a RegExp by
 * source, flags and lastIndex, a Map or Set by its entries in any order,
 * a URL by its href, a URLSearchParams (which holds no own enumerable
 * properties) as equal to any other, an ArrayBuffer or SharedArrayBuffer by
 * its byte contents, and a WeakMap or WeakSet only by identity. A handle of
 * any other kind keeps the refusal: its own enumerable properties are not
 * modeled, so Node's key check has no honest answer here. */

static bool util_deep_handle_known(const ScrDyn *d) {
  if (d->kind != SCR_DYN_HANDLE) return false;
  switch (d->v.handle.tag) {
    case SCR_DYNH_DATE:
    case SCR_DYNH_REGEXP:
    case SCR_DYNH_MAP:
    case SCR_DYNH_SET:
    case SCR_DYNH_WEAK_MAP:
    case SCR_DYNH_WEAK_SET:
    case SCR_DYNH_URL:
    case SCR_DYNH_SEARCH_PARAMS:
    case SCR_DYNH_ARRAY_BUFFER:
    case SCR_DYNH_SHARED_ARRAY_BUFFER:
      return true;
    default:
      return false;
  }
}

/* Node's constructor gate for strict mode: both sides must answer the same
 * constructor value (a Date subclass object is not a Date). */
static bool util_deep_same_constructor(const ScrDyn *a, const ScrDyn *b) {
  ScrDyn *x = util_deep_constructor(a);
  ScrDyn *y = !scr_exc_pending() ? util_deep_constructor(b) : NULL;
  bool same = !scr_exc_pending() && scr_dyn_same_value(x, y);
  scr_dyn_release(x);
  scr_dyn_release(y);
  return same;
}

/* Node's strict-mode gate for object values (objectComparisonStart): an
 * object whose `constructor` is inherited compares that value with the
 * other side's, and one that carries its own `constructor` compares the
 * two prototypes instead. Errors run through this gate before their
 * error-specific checks, so a TypeError renamed to "Error" still differs
 * from an Error, and an Error subclass instance from a plain Error. */
static bool util_deep_strict_gate(const ScrDyn *a, const ScrDyn *b) {
  ScrDyn *x = util_deep_constructor(a);
  ScrDyn *y = !scr_exc_pending() ? util_deep_constructor(b) : NULL;
  const ScrDyn *table = a->kind == SCR_DYN_OBJ ? a : a->v.arr.properties;
  bool inherited = !table || !scr_dyn_obj_get(table, "constructor", 11);
  bool compare_constructor = !scr_exc_pending() && x->kind != SCR_DYN_UNDEF && inherited;
  bool same = compare_constructor && scr_dyn_same_value(x, y);
  scr_dyn_release(x);
  scr_dyn_release(y);
  if (scr_exc_pending()) return false;
  if (!compare_constructor) {
    x = scr_dyn_get_prototype((ScrDyn *)a);
    y = !scr_exc_pending() ? scr_dyn_get_prototype((ScrDyn *)b) : NULL;
    same = !scr_exc_pending() && scr_dyn_same_value(x, y);
    scr_dyn_release(x);
    scr_dyn_release(y);
  }
  return same;
}

static size_t util_deep_live_entries(const ScrMap *m) {
  size_t live = 0;
  for (double i = 0; i < scr_map_iter_count(m); i++) live += scr_map_iter_live(m, i);
  return live;
}

/* Grow the matched-slot bitmap so that `need` slots are addressable. The
 * collection being walked lives, so a member getter can append to it while
 * the comparison runs and the walk reaches slots past the size counted
 * before the walk began. */
static void util_deep_used_reserve(bool **used, size_t *cap, size_t need) {
  if (need <= *cap) return;
  size_t next = *cap ? *cap : 8;
  while (next < need) {
    if (next > SIZE_MAX / 2) scr_trap("scriptc: out of memory\n");
    next *= 2;
  }
  bool *grown = realloc(*used, next * sizeof *grown);
  if (!grown) scr_trap("scriptc: out of memory\n");
  memset(grown + *cap, 0, (next - *cap) * sizeof *grown);
  *used = grown;
  *cap = next;
}

/* A Set's elements or a Map's key/value pairs match member by member in any
 * order, as Node's setObjectEquiv/mapObjectEquiv decide them: each entry of
 * `b` pairs with a distinct deeply equal entry of `a`. `frame` carries the
 * pair being compared, so a collection that holds itself terminates through
 * the ancestor rule. */
static bool util_deep_collections(const ScrDyn *a, const ScrDyn *b, bool skip,
                                  const ScrDeepFrame *parent) {
  const ScrMap *ma = a->v.handle.ptr, *mb = b->v.handle.ptr;
  bool is_map = a->v.handle.tag == SCR_DYNH_MAP;
  size_t na = util_deep_live_entries(ma), nb = util_deep_live_entries(mb);
  if (na != nb) return false;
  if (!skip && !util_deep_same_constructor(a, b)) return false;
  if (nb == 0) return true;
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
  /* Both collections are walked live, as Node's iterators walk them: a
   * member getter can append to either side, and Node compares the entries
   * the iterators then reach. The matched-slot bitmap is reserved as the
   * walk of `a` grows, so an entry appended to `a` during a comparison
   * cannot outrun it. */
  bool *used = NULL;
  size_t used_cap = 0;
  ScrDeepFrame frame = { a, b, parent };
  bool same = true;
  for (double j = 0; same && j < scr_map_iter_count(mb); j++) {
    if (!scr_map_iter_live(mb, j)) continue;
    ScrDyn *kb = scr_map_dyn_key(mb, j);
    ScrDyn *vb = is_map ? scr_map_dyn_value(mb, j) : NULL;
    bool matched = false;
    size_t slot = 0;
    for (double i = 0; same && !matched && i < scr_map_iter_count(ma); i++) {
      if (!scr_map_iter_live(ma, i)) continue;
      util_deep_used_reserve(&used, &used_cap, slot + 1);
      if (used[slot++]) continue;
      ScrDyn *ka = scr_map_dyn_key(ma, i);
      ScrDyn *va = is_map ? scr_map_dyn_value(ma, i) : NULL;
      matched = util_deep_equal(ka, kb, skip, &frame) &&
                (!is_map || util_deep_equal(va, vb, skip, &frame));
      scr_dyn_release(ka);
      scr_dyn_release(va);
      if (scr_exc_pending()) same = false;
    }
    scr_dyn_release(kb);
    scr_dyn_release(vb);
    if (same && !matched) same = false;
    if (same && slot > 0 && slot <= used_cap) used[slot - 1] = true;
  }
  free(used);
  return same;
}

static bool util_deep_handles(const ScrDyn *a, const ScrDyn *b, bool skip,
                              const ScrDeepFrame *parent) {
  if (a->kind != SCR_DYN_HANDLE || b->kind != SCR_DYN_HANDLE) return false;
  if (a->v.handle.tag != b->v.handle.tag) return false;
  switch (a->v.handle.tag) {
    case SCR_DYNH_DATE: {
      if (!skip && !util_deep_same_constructor(a, b)) return false;
      double t1 = scr_dyn_native_date_value(a), t2 = scr_dyn_native_date_value(b);
      return t1 == t2 || (t1 != t1 && t2 != t2);
    }
    case SCR_DYNH_REGEXP: {
      const ScrRegex *ra = a->v.handle.ptr, *rb = b->v.handle.ptr;
      /* Read the fields directly rather than through scr_regex_source and
       * scr_regex_flags: this unit links for util.parseArgs programs that
       * do not pull in the regex unit, and the linker still needs the
       * references resolved. */
      ScrStr *sa = scr_str_retain(ra->source), *sb = scr_str_retain(rb->source);
      bool same = scr_str_eq(sa, sb);
      scr_str_release(sa);
      scr_str_release(sb);
      if (!same) return false;
      ScrStr *fa = scr_str_retain(ra->flags), *fb = scr_str_retain(rb->flags);
      same = scr_str_eq(fa, fb);
      scr_str_release(fa);
      scr_str_release(fb);
      return same && ra->last_index == rb->last_index;
    }
    case SCR_DYNH_MAP:
    case SCR_DYNH_SET:
      return util_deep_collections(a, b, skip, parent);
    case SCR_DYNH_WEAK_MAP:
    case SCR_DYNH_WEAK_SET:
      /* Node answers false for two distinct weak collections; the same
       * handle never reaches this arm (same-value returns first). */
      return false;
    case SCR_DYNH_URL: {
      if (!skip && !util_deep_same_constructor(a, b)) return false;
      ScrStr *ha = scr_url_href(a->v.handle.ptr), *hb = scr_url_href(b->v.handle.ptr);
      bool same = scr_str_eq(ha, hb);
      scr_str_release(ha);
      scr_str_release(hb);
      return same;
    }
    case SCR_DYNH_SEARCH_PARAMS:
      /* No own enumerable properties, so any two params compare equal. */
      return true;
    case SCR_DYNH_ARRAY_BUFFER:
    case SCR_DYNH_SHARED_ARRAY_BUFFER: {
      if (!skip && !util_deep_same_constructor(a, b)) return false;
      /* Node's areEqualArrayBuffers: the byte lengths agree and the bytes
       * do. The length gate runs first, so a detached buffer (which reports
       * 0) only reaches the byte comparison against another buffer that
       * also reports 0; there Node builds a Uint8Array over each buffer,
       * and V8 refuses that on a detached one, so the comparison throws.
       * The shared storage is copied before the comparison, so a worker
       * writing during it cannot tear the bytes. */
      const ScrBytes *x = a->v.handle.ptr, *y = b->v.handle.ptr;
      if (scr_bytes_byte_len(x) != scr_bytes_byte_len(y)) return false;
#ifdef SCR_JS_OBJECT_MODEL
      const ScrJsBufferOps *ops = scr_js_buffer_ops;
      if (ops && (ops->owner_detached(x) || ops->owner_detached(y))) {
        static const char message[] = "Cannot perform Construct on a detached ArrayBuffer";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return false;
      }
#endif
      SCR_BYTES_SNAPSHOT(x);
      SCR_BYTES_SNAPSHOT(y);
      size_t length = (size_t)scr_bytes_byte_len(x);
      return length == 0 || !memcmp(x->data, y->data, length);
    }
    default:
      return util_deep_refused("native handles");
  }
}

/* Two capsules of the same checked type: the backend keeps one struct and
 * one key per class, so the key answers Node's constructor gate for class
 * instances whose checked view does not carry the class prototype. */
static bool util_deep_same_type_key(const ScrDyn *a, const ScrDyn *b) {
  return a->v.typed_ref.type_key_len == b->v.typed_ref.type_key_len &&
         !memcmp(a->v.typed_ref.type_key, b->v.typed_ref.type_key,
                 a->v.typed_ref.type_key_len);
}

/* Whether a capsule holds a class instance (its key is "object:<class>"). */
static bool util_deep_class_capsule(const ScrDyn *d) {
  return d->kind == SCR_DYN_TYPED_REF &&
         d->v.typed_ref.type_key_len >= 7 &&
         !strncmp(d->v.typed_ref.type_key, "object:", 7);
}

/* Node's Date arm covers instances of classes declared `extends Date`: the
 * constructor gate separates them from a plain Date, the internal time
 * values then compare (an invalid date equals another invalid one), and
 * the instances' own enumerable properties still take part in keyCheck. */
static bool util_deep_is_date(const ScrDyn *d, double *time) {
  if (d->kind == SCR_DYN_HANDLE && d->v.handle.tag == SCR_DYNH_DATE) {
    *time = scr_dyn_native_date_value(d);
    return true;
  }
  return d->kind == SCR_DYN_TYPED_REF && scr_dyn_date_class_time(d, time);
}

static bool util_deep_date_arm(const ScrDyn *a, const ScrDyn *b, bool skip,
                               const ScrDeepFrame *parent) {
  double ta, tb;
  if (!util_deep_is_date(a, &ta) || !util_deep_is_date(b, &tb)) return false;
  /* A plain Date never matches a subclass instance: their constructors
   * differ, which the gate rejects before either time is read. */
  if ((a->kind == SCR_DYN_HANDLE) != (b->kind == SCR_DYN_HANDLE)) return false;
  ScrDyn *va = NULL, *vb = NULL;
  bool same;
  if (a->kind == SCR_DYN_HANDLE) {
    same = skip || util_deep_same_constructor(a, b);
  } else {
    /* Two subclass instances: their checked views carry the class's
     * prototype only when the class answers dynamic member reads, so the
     * capsule's type key answers the constructor gate when the views
     * cannot, and the views answer it exactly when they can. */
    bool keyed = skip || util_deep_same_type_key(a, b);
    va = keyed ? scr_dyn_typed_ref_materialize(a) : NULL;
    vb = keyed && !scr_exc_pending() ? scr_dyn_typed_ref_materialize(b) : NULL;
    same = keyed && va && vb && !scr_exc_pending();
    if (same && !skip && va->prototype && vb->prototype)
      same = util_deep_same_constructor(va, vb);
  }
  if (same && ta != tb && (ta == ta || tb == tb)) same = false;
  if (same && !scr_exc_pending() && parent && !parent->parent) {
    if (parent->a == a || parent->b == b) same = parent->a == a && parent->b == b;
  } else if (same && !scr_exc_pending() && parent) {
    bool seen_a = false, seen_b = false;
    for (const ScrDeepFrame *p = parent; p; p = p->parent) {
      seen_a |= a == p->a || a == p->b;
      seen_b |= b == p->a || b == p->b;
    }
    if (seen_a || seen_b) same = seen_a && seen_b;
  }
  if (same && !scr_exc_pending() && va) {
    ScrDeepFrame frame = { a, b, parent };
    same = util_deep_same_keys(va, vb) &&
           util_deep_same_keys(va->symbol_properties, vb->symbol_properties) &&
           util_deep_properties(va, vb, va, vb, skip, &frame) &&
           util_deep_properties(va->symbol_properties, vb->symbol_properties, va, vb, skip, &frame);
  }
  scr_dyn_release(va);
  scr_dyn_release(vb);
  return same && !scr_exc_pending();
}

/* Node's error arm: two errors match when their name and message match,
 * their `cause` presence and value match, AggregateError's `errors` lists
 * match, and their own enumerable properties match (the stack never takes
 * part). The strict constructor gate runs first, before any error slot is
 * read, as Node's objectComparisonStart orders it: an Error subclass
 * instance never matches a plain Error, and a renamed built-in keeps its
 * own constructor. `frame` carries the pair so a cause that points back
 * terminates. */
static bool util_deep_error_arm(const ScrDyn *a, const ScrDyn *b, bool skip,
                                const ScrDeepFrame *parent) {
  if (a->kind != SCR_DYN_OBJ || b->kind != SCR_DYN_OBJ) return false;
  ScrError *ea = scr_errdyn_err_of(a);
  ScrError *eb = scr_errdyn_err_of(b);
  if (!ea || !eb) {
    if (ea) scr_error_release(ea);
    if (eb) scr_error_release(eb);
    return false;
  }
  if (!skip && !util_deep_strict_gate(a, b)) {
    scr_error_release(ea);
    scr_error_release(eb);
    return false;
  }
  if (scr_exc_pending()) {
    scr_error_release(ea);
    scr_error_release(eb);
    return false;
  }
  if (parent && !parent->parent) {
    if (parent->a == a || parent->b == b) {
      scr_error_release(ea);
      scr_error_release(eb);
      return parent->a == a && parent->b == b;
    }
  } else if (parent) {
    bool seen_a = false, seen_b = false;
    for (const ScrDeepFrame *p = parent; p; p = p->parent) {
      seen_a |= a == p->a || a == p->b;
      seen_b |= b == p->a || b == p->b;
    }
    if (seen_a || seen_b) {
      scr_error_release(ea);
      scr_error_release(eb);
      return seen_a && seen_b;
    }
  }
  ScrDeepFrame frame = { a, b, parent };
  bool same = scr_str_eq(ea->name, eb->name) && scr_str_eq(ea->message, eb->message);
  /* A getter the cause comparison runs can delete the opposite error's
   * `cause`, which releases the object the walk is reading: retain both
   * causes for as long as the recursive comparison holds them. */
  ScrDyn *ca = NULL, *cb = NULL;
  if (same && ea->error_cause && eb->error_cause) {
    ca = scr_dyn_retain(ea->error_cause);
    cb = scr_dyn_retain(eb->error_cause);
    same = util_deep_equal(ca, cb, skip, &frame);
  }
  if (same && !scr_exc_pending()) {
    bool ga = ea->vt == &scr_error_vts[SCR_ERR_AGGREGATE];
    bool gb = eb->vt == &scr_error_vts[SCR_ERR_AGGREGATE];
    if (ga != gb) same = false;
    else if (ga) {
      ScrDyn *xa = scr_aggregate_errors(ea);
      ScrDyn *xb = scr_aggregate_errors(eb);
      same = xa && xb && util_deep_equal(xa, xb, skip, &frame);
      if (xa) scr_dyn_release(xa);
      if (xb) scr_dyn_release(xb);
    }
  }
  /* Node compares the two `cause` values first and only then checks that
   * both errors still own the property: a getter the comparison called can
   * delete one side's `cause`, and the errors differ then even though the
   * values read matched. */
  if (same && ((ea->error_cause != NULL) != (eb->error_cause != NULL))) same = false;
  if (same && !scr_exc_pending())
    same = util_deep_same_keys(a, b) && util_deep_same_keys(a->symbol_properties, b->symbol_properties) &&
           util_deep_properties(a, b, a, b, skip, &frame) &&
           util_deep_properties(a->symbol_properties, b->symbol_properties, a, b, skip, &frame);
  if (ca) scr_dyn_release(ca);
  if (cb) scr_dyn_release(cb);
  scr_error_release(ea);
  scr_error_release(eb);
  return same && !scr_exc_pending();
}

static bool util_deep_equal(const ScrDyn *a, const ScrDyn *b, bool skip,
                             const ScrDeepFrame *parent) {
  if (scr_dyn_same_value(a, b)) return true;
  if (a->kind == SCR_DYN_PROXY || b->kind == SCR_DYN_PROXY)
    return util_deep_refused("native Proxy values");

  if (a->kind == SCR_DYN_TYPED_REF || b->kind == SCR_DYN_TYPED_REF) {
    const ScrDyn *inputs[] = { a, b };
    for (size_t i = 0; i < 2; i++) {
      const ScrDyn *v = inputs[i];
      if (v->kind == SCR_DYN_TYPED_REF) {
        double time;
        /* A class entered before the field snapshot can be a Date
         * subclass; its time value lives outside the fields. */
        if (scr_dyn_date_class_time(v, &time))
          return util_deep_date_arm(a, b, skip, parent);
      }
      if (v->kind == SCR_DYN_TYPED_REF &&
          strncmp(v->v.typed_ref.type_key, "record:", 7) &&
          strncmp(v->v.typed_ref.type_key, "array<", 6) &&
          strncmp(v->v.typed_ref.type_key, "object:", 7))
        return util_deep_refused("opaque native references");
    }
    bool class_a = util_deep_class_capsule(a), class_b = util_deep_class_capsule(b);
    /* A class instance never matches a built-in handle or a capsule of
     * another shape (a record, an array): the constructor gate separates
     * the classes, and no check of their contents could reunite them. */
    if (!skip && (class_a || class_b)) {
      /* Node compares the constructors (or, for a class that defines its
       * own constructor property, the prototypes), and the fields cannot
       * reunite two different ones. With the gate off, only the fields
       * and tags take part, so the comparison continues below. */
      const ScrDyn *other = class_a ? b : a;
      if (other->kind == SCR_DYN_HANDLE ||
          (other->kind == SCR_DYN_TYPED_REF && !util_deep_class_capsule(other)))
        return false;
      if (class_a && class_b && !skip && !util_deep_same_type_key(a, b)) return false;
    }
    ScrDyn *x = a->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(a) : scr_dyn_retain((ScrDyn *)a);
    ScrDyn *y = !scr_exc_pending() ? (b->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(b) : scr_dyn_retain((ScrDyn *)b)) : NULL;
    bool equal = !scr_exc_pending() && util_deep_equal(x, y, skip, parent);
    /* A class view carries the class's prototype only when the class
     * answers dynamic member reads. Without it the view is a plain object,
     * and no constructor is left to compare a class instance with a value
     * of another shape -- Node's gate would, so refuse instead of
     * answering from the fields alone. */
    if (equal && !skip && class_a != class_b) {
      const ScrDyn *view = class_a ? x : y;
      const ScrDyn *other = class_a ? y : x;
      if (view && !view->prototype) {
        /* The value's constructor decides Node's gate, and the capsule
         * cannot name the class it holds. Only a class value on the other
         * side could be that same class (reached through a dynamic class
         * value); every other constructor -- Object.prototype's, Array's,
         * an ordinary function's, none -- is a different one, so the gate
         * answers false. */
        ScrDyn *ctor = util_deep_constructor(other);
        bool class_value = ctor && ctor->kind == SCR_DYN_FUNC && ctor->v.fn.class_obj;
        scr_dyn_release(ctor);
        if (class_value) equal = util_deep_refused("class instances without a prototype");
        else equal = false;
      }
    }
    scr_dyn_release(x); scr_dyn_release(y);
    return equal;
  }
  if (a->kind == SCR_DYN_HANDLE || b->kind == SCR_DYN_HANDLE) {
    if (!util_deep_handle_known(a) && !util_deep_handle_known(b))
      return util_deep_refused("native handles");
    return util_deep_handles(a, b, skip, parent);
  }
  ScrError *ea = scr_errdyn_err_of(a);
  ScrError *eb = scr_errdyn_err_of(b);
  if (ea || eb) {
    bool both = ea && eb && a->kind == SCR_DYN_OBJ && b->kind == SCR_DYN_OBJ;
    if (ea) scr_error_release(ea);
    if (eb) scr_error_release(eb);
    if (!both) return false; /* Node's error arm requires an error on both sides */
    return util_deep_error_arm(a, b, skip, parent);
  }
  if (a->kind != b->kind) return false;
  if (a->kind != SCR_DYN_OBJ && a->kind != SCR_DYN_ARR && a->kind != SCR_DYN_BYTES) return false;
  if (!skip) {
    if (a->kind == SCR_DYN_BYTES) {
      if (a->buffer != b->buffer || a->prototype != b->prototype) return false;
      /* Node's tag gate reads a typed array's Symbol.toStringTag, which a
       * DataView does not have, so a DataView never matches a numeric typed
       * array of the same width even when their bytes agree. */
      if (a->v.bytes->is_data_view != b->v.bytes->is_data_view) return false;
    } else if (!util_deep_strict_gate(a, b)) {
      return false;
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
    SCR_BYTES_SNAPSHOT(x);
    SCR_BYTES_SNAPSHOT(y);
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
      if (!present) continue;
      /* The comparison of an earlier element runs program code, which can
       * delete this one from either side: hold both elements across it. */
      ScrDyn *xa = scr_dyn_retain(a->v.arr.items[i]);
      ScrDyn *xb = scr_dyn_retain(b->v.arr.items[i]);
      bool same_element = util_deep_equal(xa, xb, skip, &frame);
      scr_dyn_release(xa);
      scr_dyn_release(xb);
      if (!same_element) return false;
    }
    if (!util_deep_properties(a->v.arr.properties, b->v.arr.properties, a, b, skip, &frame)) return false;
  } else if (a->kind == SCR_DYN_OBJ) {
    if (!util_deep_properties(a, b, a, b, skip, &frame)) return false;
  }
  return util_deep_properties(a->symbol_properties, b->symbol_properties, a, b, skip, &frame);
}

bool scr_util_is_deep_strict_equal(const ScrDyn *a, const ScrDyn *b, const ScrDyn *skip) {
  return util_deep_equal(a, b, scr_dyn_truthy(skip), NULL);
}
