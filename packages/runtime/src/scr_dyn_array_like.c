/* Array.prototype's generic algorithms over array-like receivers.
 *
 * `Array.prototype.<method>.call(obj, ...)` (and a stored method value
 * called on an object) reaches scr_dyn_array_proto_call, which runs
 * at/slice/indexOf/lastIndexOf/includes and the higher-order methods over
 * any receiver. Every other method answered "not supported yet", so a call
 * on an array-like — an ordinary object with a length, or a primitive's
 * ToObject wrapper — threw instead of running the algorithm.
 *
 * This unit runs those methods the way the specification writes them, as
 * Get/HasProperty/Set/DeletePropertyOrThrow steps bounded by ToLength, and
 * hands every other name back to scr_dyn_array_proto_call so the two units
 * keep one implementation each. It links only into programs that use the
 * dynamic array-like path (the frontend marks dyn.arrayLikeProtoCall for
 * JavaScript sources), so typed programs keep their exact executables and
 * scr_dyn_invoke.c is not touched: a program that only uses the older
 * borrow methods links exactly what it linked before.
 *
 * The algorithms only use the checked-dynamic tree's public surface; the
 * few helpers they share (an index key, Get/Has/Set at an index, the
 * array-like length, a callback gate) are private to this unit. */
#include "scr_runtime.h"
#include "scr_dyn_methods.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

/* One million indexed steps per call: past it the iteration reports
 * SC2020 rather than running an unbounded loop over a length property the
 * program chose. */
static bool al_iteration(size_t step) {
  if (step < 1000000) return true;
  static const char msg[] = "array-like iteration over one million entries is not supported yet";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  return false;
}

static bool al_is(const ScrStr *method, const char *name) {
  size_t len = strlen(name);
  return method->len == len && memcmp(method->data, name, len) == 0;
}

/* The canonical array index a property key spells, if it does. */
static bool al_index(const ScrStr *key, size_t *out) {
  if (!key->len || (key->len > 1 && key->data[0] == '0')) return false;
  size_t n = 0;
  for (size_t i = 0; i < key->len; i++) {
    unsigned digit = (unsigned)(key->data[i] - '0');
    if (digit > 9 || n > (SIZE_MAX - digit) / 10) return false;
    n = n * 10 + digit;
  }
  *out = n;
  return true;
}

/* Get(receiver, key) through the receiver's checked-dynamic kind. A
 * primitive answers an ordinary property read on its ToObject wrapper,
 * which is fresh and unobservable: an absent member is undefined. The
 * result is owned (+1). */
static ScrDyn *al_get(ScrDyn *recv, const ScrStr *key) {
  if (recv->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *snapshot = scr_dyn_typed_ref_materialize(recv);
    if (!snapshot) return NULL;
    ScrDyn *result = al_get(snapshot, key);
    scr_dyn_release(snapshot);
    return result;
  }
  if (recv->kind == SCR_DYN_OBJ) return scr_dyn_obj_read(recv, key->data, key->len);
  if (recv->kind == SCR_DYN_PROXY) return scr_dyn_proxy_get(recv, key);
  if (recv->kind == SCR_DYN_FUNC) {
    ScrDyn *value = scr_dyn_fn_get(recv, key->data, key->len);
    return value ? value : scr_dyn_retain(scr_dyn_undefined());
  }
  if (recv->kind == SCR_DYN_ARR || recv->kind == SCR_DYN_STR || recv->kind == SCR_DYN_BYTES) {
    if (key->len == 6 && memcmp(key->data, "length", 6) == 0) {
      double length = recv->kind == SCR_DYN_ARR ? (double)scr_dyn_arr_length(recv)
        : recv->kind == SCR_DYN_STR ? scr_str_utf16_len(recv->v.str)
        : (double)recv->v.bytes->len;
      return scr_dyn_new_num(length);
    }
    size_t index;
    if (!al_index(key, &index)) {
      if (recv->kind == SCR_DYN_ARR && recv->v.arr.properties)
        return scr_dyn_arr_named_get(recv, key);
      return scr_dyn_retain(scr_dyn_undefined());
    }
    if (recv->kind == SCR_DYN_ARR && index >= recv->v.arr.len && recv->v.arr.properties)
      return scr_dyn_arr_named_get(recv, key);
    if (recv->kind == SCR_DYN_ARR) return scr_dyn_arr_at(recv, (double)index);
    if (recv->kind == SCR_DYN_BYTES) {
      return index < recv->v.bytes->len
        ? scr_dyn_new_num(scr_bytes_get(recv->v.bytes, (double)index))
        : scr_dyn_retain(scr_dyn_undefined());
    }
    if ((double)index >= scr_str_utf16_len(recv->v.str))
      return scr_dyn_retain(scr_dyn_undefined());
    ScrStr *unit = scr_str_slice(recv->v.str, (double)index, (double)index + 1);
    ScrDyn *value = scr_dyn_new_str(unit);
    scr_str_release(unit);
    return value;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

/* HasProperty(receiver, key). */
static bool al_has(ScrDyn *recv, const ScrStr *key) {
  if (recv->kind == SCR_DYN_STR || recv->kind == SCR_DYN_BYTES) {
    size_t index;
    return al_index(key, &index) &&
      (recv->kind == SCR_DYN_STR
        ? (double)index < scr_str_utf16_len(recv->v.str)
        : index < recv->v.bytes->len);
  }
  if (recv->kind == SCR_DYN_FUNC) {
    ScrDyn *value = scr_dyn_fn_get(recv, key->data, key->len);
    bool present = value != NULL;
    scr_dyn_release(value);
    return present;
  }
  return scr_dyn_has_key(recv, key);
}

static ScrStr *al_key(size_t index) {
  char text[32];
  int n = snprintf(text, sizeof text, "%zu", index);
  return scr_str_new(text, (size_t)n);
}

/* ToLength(Get(receiver, "length")). */
static bool al_length(ScrDyn *recv, size_t *out) {
  ScrStr *key = scr_str_new("length", 6);
  ScrDyn *value = al_get(recv, key);
  scr_str_release(key);
  if (!value) return false;
  double number;
  bool ok = scr_dyn_number_coerce_js(value, &number);
  scr_dyn_release(value);
  if (!ok) return false;
  if (isnan(number) || number <= 0) { *out = 0; return true; }
  number = fmin(trunc(number), 9007199254740991.0);
  if (number > (double)SIZE_MAX) {
    static const char msg[] = "array-like length exceeds the native index range";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return false;
  }
  *out = (size_t)number;
  return true;
}

/* ToIntegerOrInfinity of an argument, truncated. */
static bool al_number(const ScrDyn *value, double *out) {
  if (!scr_dyn_number_coerce_js(value, out)) return false;
  if (isnan(*out)) *out = 0;
  else if (isfinite(*out)) *out = trunc(*out);
  return true;
}

static bool al_present(ScrDyn *recv, size_t index) {
  ScrStr *key = al_key(index);
  bool found = al_has(recv, key);
  scr_str_release(key);
  return found;
}

static ScrDyn *al_item(ScrDyn *recv, size_t index) {
  ScrStr *key = al_key(index);
  ScrDyn *value = al_get(recv, key);
  scr_str_release(key);
  return value;
}

/* A primitive receiver's ToObject wrapper is fresh and unobservable: the
 * generic array algorithms read through it, and a write the wrapper accepts
 * is discarded with it. */
static bool al_primitive(const ScrDyn *recv) {
  switch (recv->kind) {
    case SCR_DYN_BOOL:
    case SCR_DYN_NUM:
    case SCR_DYN_STR:
    case SCR_DYN_BIGINT:
    case SCR_DYN_SYMBOL:
      return true;
    default:
      return false;
  }
}

/* The "not supported yet" Error for a method whose result would be a
 * primitive receiver's wrapper object. */
static void al_refuse_primitive(const ScrStr *method) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "Array.prototype.");
  scr_jb_write(&b, method->data, method->len);
  scr_jb_puts(&b, " on a primitive receiver is not supported yet");
  scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
}

/* A String wrapper's indexes below its UTF-16 length are read-only and
 * non-configurable, so Set throws on them and DeletePropertyOrThrow does
 * too; an index at or past the length is an ordinary property of the
 * wrapper. Number, boolean, bigint and symbol wrappers carry no index. */
static bool al_string_index(const ScrDyn *recv, size_t index) {
  return recv->kind == SCR_DYN_STR && (double)index < scr_str_utf16_len(recv->v.str);
}

/* V8's TypeError for a write or delete the String wrapper refuses; `key`
 * is the property's name. */
static void al_string_refuse(const char *key, bool deleting) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, deleting ? "Cannot delete property '" : "Cannot assign to read only property '");
  scr_jb_puts(&b, key);
  scr_jb_puts(&b, deleting ? "' of [object String]" : "' of object '[object String]'");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

static void al_string_refuse_index(size_t index, bool deleting) {
  char text[32];
  snprintf(text, sizeof text, "%zu", index);
  al_string_refuse(text, deleting);
}

/* Set(O, index, value, true): a failing write throws from scr_dyn_key_set
 * and the caller checks scr_exc_pending(). */
static void al_set(ScrDyn *recv, size_t index, ScrDyn *value) {
  if (al_primitive(recv)) {
    if (al_string_index(recv, index)) al_string_refuse_index(index, false);
    return;
  }
  ScrStr *key = al_key(index);
  scr_dyn_key_set(recv, key, value);
  scr_str_release(key);
}

/* DeletePropertyOrThrow(O, index). */
static void al_delete(ScrDyn *recv, size_t index) {
  if (al_primitive(recv)) {
    if (al_string_index(recv, index)) al_string_refuse_index(index, true);
    return;
  }
  ScrStr *key = al_key(index);
  scr_dyn_key_delete(recv, key, true);
  scr_str_release(key);
}

/* Set(O, "length", length, true). A String wrapper's length is read-only
 * whatever the value. */
static void al_set_length(ScrDyn *recv, size_t length) {
  if (al_primitive(recv)) {
    if (recv->kind == SCR_DYN_STR) al_string_refuse("length", false);
    return;
  }
  ScrStr *key = scr_str_new("length", 6);
  ScrDyn *value = scr_dyn_new_num((double)length);
  scr_dyn_key_set(recv, key, value);
  scr_dyn_release(value);
  scr_str_release(key);
}

/* fill, copyWithin and reverse return O, which for a primitive receiver is
 * its ToObject wrapper. A compiled program has no wrapper object to return,
 * so for a primitive the method throws the "not supported yet" Error. */
static ScrDyn *al_receiver_result(ScrDyn *recv, const ScrStr *method) {
  if (!al_primitive(recv)) return scr_dyn_retain(recv);
  al_refuse_primitive(method);
  return NULL;
}

/* The receiver's elements in index order as a fresh dyn array, each read
 * with Get alone (an index the receiver does not carry reads undefined), as
 * toSorted and with read through holes; the element at `skip` (SIZE_MAX:
 * none) is `replacement` and is never read. Owned (+1), NULL with the
 * exception pending. */
static ScrDyn *al_snapshot(ScrDyn *recv, size_t len, size_t skip, ScrDyn *replacement) {
  ScrDyn *out = scr_dyn_new_arr();
  for (size_t i = 0; i < len; i++) {
    if (len > 1000000 && !al_iteration(i)) { scr_dyn_release(out); return NULL; }
    ScrDyn *item = i == skip ? scr_dyn_retain(replacement) : al_item(recv, i);
    if (!item) { scr_dyn_release(out); return NULL; }
    scr_dyn_arr_push(out, item);
  }
  return out;
}

/* CreateDataProperty(out, index, Get(receiver, index)) — an ordinary
 * property read, with an absent index kept as a hole. */
static bool al_copy_item(ScrDyn *out, ScrDyn *recv, size_t index) {
  if (!al_present(recv, index)) {
    if (scr_exc_pending()) return false;
    scr_dyn_arr_push_hole(out);
    return true;
  }
  ScrDyn *item = al_item(recv, index);
  if (!item) return false;
  scr_dyn_arr_push(out, item);
  return true;
}

/* JS relative-index normalization (slice's rule). */
static size_t al_rel_index(double rel, size_t len) {
  if (rel < 0) {
    double r = (double)len + rel;
    return r < 0 ? 0 : (size_t)r;
  }
  return rel > (double)len ? len : (size_t)rel;
}

/* The callable-callback gate: JS's "<String(cb)> is not a function". */
static bool al_cb_check(ScrDyn *const *args, size_t argc) {
  ScrDyn *cb = argc > 0 ? args[0] : scr_dyn_undefined();
  if (scr_dyn_is_callable(cb)) return true;
  ScrJsonBuf b;
  scr_jb_init(&b);
  ScrStr *text = scr_dyn_string_coerce_js(cb);
  if (text) {
    scr_jb_write(&b, text->data, text->len);
    scr_str_release(text);
  }
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
  return false;
}

/* The methods this unit runs; every other name is the invoke unit's. */
static bool al_owns(const ScrStr *method) {
  static const char *const names[] = {
    "concat", "copyWithin", "fill", "flat", "flatMap", "join", "pop", "push", "reverse",
    "shift", "splice", "toReversed", "toSorted", "toSpliced", "unshift", "with",
  };
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
    if (al_is(method, names[i])) return true;
  return false;
}

/* One packed argument list, borrowed: the array dispatch hands the
 * algorithm its arguments as a dyn array. */
ScrDyn *scr_dyn_array_like_call(ScrDyn *recv, ScrStr *method, ScrDyn *args) {
  if (recv->kind == SCR_DYN_ARR ||
      (recv->kind == SCR_DYN_TYPED_REF && scr_dyn_typed_ref_array_ops(recv))) {
    /* An array receiver runs this unit's methods through the array
     * dispatch, which implements each of them for arrays. */
    char name[16];
    if (al_owns(method) && args && args->kind == SCR_DYN_ARR) {
      memcpy(name, method->data, method->len);
      name[method->len] = '\0';
      return scr_dyn_invoke(recv, name, args->v.arr.items, args->v.arr.len, name);
    }
    return scr_dyn_array_proto_call(recv, method, args);
  }
  /* Step 1 of each of these algorithms: `? ToObject(this value)`. The
   * array dispatch answers it for its own receivers; a nullish one never
   * reaches a length read. */
  if (recv->kind == SCR_DYN_NULL || recv->kind == SCR_DYN_UNDEF) {
    static const char msg[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return NULL;
  }
  if (!args || args->kind != SCR_DYN_ARR) scr_trap("scriptc: invalid Array.prototype arguments\n");
  ScrDyn *const *argv = args->v.arr.items;
  size_t argc = args->v.arr.len;
  if (al_is(method, "concat")) {
    /* A receiver that is not an array is not spreadable: it is the result's
     * first element, and its length is never read. The arguments then
     * spread as they do for an array receiver, so the array dispatch
     * answers `[receiver].concat(...args)`. A primitive receiver's first
     * element would be its wrapper object. */
    if (al_primitive(recv)) { al_refuse_primitive(method); return NULL; }
    ScrDyn *head = scr_dyn_new_arr();
    scr_dyn_arr_push(head, scr_dyn_retain(recv));
    ScrDyn *out = scr_dyn_invoke(head, "concat", argv, argc, "concat");
    scr_dyn_release(head);
    return out;
  }
  size_t len;
  if (!al_length(recv, &len)) return NULL;

  if (al_is(method, "pop")) {
    if (len == 0) {
      al_set_length(recv, 0);
      return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
    }
    ScrDyn *item = al_item(recv, len - 1);
    if (!item) return NULL;
    al_delete(recv, len - 1);
    if (!scr_exc_pending()) al_set_length(recv, len - 1);
    if (scr_exc_pending()) { scr_dyn_release(item); return NULL; }
    return item;
  }
  if (al_is(method, "push") || al_is(method, "unshift")) {
    if (al_is(method, "push")) {
      for (size_t i = 0; i < argc; i++) {
        if (len > 1000000 && !al_iteration(i)) return NULL;
        al_set(recv, len + i, argv[i]);
        if (scr_exc_pending()) return NULL;
      }
      al_set_length(recv, len + argc);
      if (scr_exc_pending()) return NULL;
      return scr_dyn_new_num((double)(len + argc));
    }
    if (argc > 0) {
      /* Right to left, so each element lands one `argc` slot further. */
      for (size_t k = len; k > 0; k--) {
        size_t from = k - 1;
        size_t to = from + argc;
        if (len > 1000000 && !al_iteration(len - k)) return NULL;
        if (scr_exc_pending()) return NULL;
        if (!al_present(recv, from)) { al_delete(recv, to); }
        else {
          ScrDyn *item = al_item(recv, from);
          if (!item) return NULL;
          al_set(recv, to, item);
          scr_dyn_release(item);
        }
        if (scr_exc_pending()) return NULL;
      }
      for (size_t j = 0; j < argc; j++) {
        al_set(recv, j, argv[j]);
        if (scr_exc_pending()) return NULL;
      }
    }
    al_set_length(recv, len + argc);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_new_num((double)(len + argc));
  }
  if (al_is(method, "shift")) {
    if (len == 0) {
      al_set_length(recv, 0);
      return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
    }
    ScrDyn *first = al_item(recv, 0);
    if (!first) return NULL;
    for (size_t k = 1; k < len; k++) {
      if (len > 1000000 && !al_iteration(k - 1)) { scr_dyn_release(first); return NULL; }
      size_t to = k - 1;
      if (scr_exc_pending()) { scr_dyn_release(first); return NULL; }
      if (!al_present(recv, k)) { al_delete(recv, to); }
      else {
        ScrDyn *item = al_item(recv, k);
        if (!item) { scr_dyn_release(first); return NULL; }
        al_set(recv, to, item);
        scr_dyn_release(item);
      }
      if (scr_exc_pending()) { scr_dyn_release(first); return NULL; }
    }
    al_delete(recv, len - 1);
    if (!scr_exc_pending()) al_set_length(recv, len - 1);
    if (scr_exc_pending()) { scr_dyn_release(first); return NULL; }
    return first;
  }
  if (al_is(method, "reverse")) {
    size_t middle = len / 2;
    for (size_t lower = 0; lower < middle; lower++) {
      if (len > 1000000 && !al_iteration(lower)) return NULL;
      size_t upper = len - lower - 1;
      bool has_lower = al_present(recv, lower);
      if (scr_exc_pending()) return NULL;
      ScrDyn *lower_value = has_lower ? al_item(recv, lower) : NULL;
      if (has_lower && !lower_value) return NULL;
      bool has_upper = al_present(recv, upper);
      ScrDyn *upper_value = has_upper && !scr_exc_pending() ? al_item(recv, upper) : NULL;
      if (scr_exc_pending() || (has_upper && !upper_value)) {
        scr_dyn_release(lower_value);
        return NULL;
      }
      if (has_lower && has_upper) {
        al_set(recv, lower, upper_value);
        if (!scr_exc_pending()) al_set(recv, upper, lower_value);
      } else if (has_upper) {
        al_set(recv, lower, upper_value);
        if (!scr_exc_pending()) al_delete(recv, upper);
      } else if (has_lower) {
        al_delete(recv, lower);
        if (!scr_exc_pending()) al_set(recv, upper, lower_value);
      }
      scr_dyn_release(lower_value);
      scr_dyn_release(upper_value);
      if (scr_exc_pending()) return NULL;
    }
    return al_receiver_result(recv, method);
  }
  if (al_is(method, "join")) {
    ScrStr *sep = argc > 0 && argv[0]->kind != SCR_DYN_UNDEF
      ? scr_dyn_string_coerce_js(argv[0])
      : scr_str_new(",", 1);
    if (!sep) return NULL;
    /* Get alone at each index: a missing index reads undefined, which
     * joins as the empty string. */
    ScrJsonBuf buffer;
    scr_jb_init(&buffer);
    for (size_t i = 0; i < len; i++) {
      if (i) scr_jb_write(&buffer, sep->data, sep->len);
      ScrDyn *item = len > 1000000 && !al_iteration(i) ? NULL : al_item(recv, i);
      if (!item) {
        scr_str_release(scr_jb_finish(&buffer));
        scr_str_release(sep);
        return NULL;
      }
      if (item->kind != SCR_DYN_UNDEF && item->kind != SCR_DYN_NULL) {
        ScrStr *text = scr_dyn_string_coerce_js(item);
        if (text) {
          scr_jb_write(&buffer, text->data, text->len);
          scr_str_release(text);
        }
      }
      scr_dyn_release(item);
      if (scr_exc_pending()) {
        scr_str_release(scr_jb_finish(&buffer));
        scr_str_release(sep);
        return NULL;
      }
    }
    scr_str_release(sep);
    ScrStr *text = scr_jb_finish(&buffer);
    ScrDyn *answer = scr_dyn_new_str(text);
    scr_str_release(text);
    return answer;
  }
  if (al_is(method, "fill")) {
    ScrDyn *value = argc > 0 ? argv[0] : scr_dyn_undefined();
    double start_d = 0;
    double end_d = (double)len;
    if (argc > 1 && !al_number(argv[1], &start_d)) return NULL;
    if (argc > 2 && argv[2]->kind != SCR_DYN_UNDEF && !al_number(argv[2], &end_d)) return NULL;
    size_t start = al_rel_index(trunc(start_d), len);
    size_t end = al_rel_index(trunc(end_d), len);
    for (size_t i = start; i < end; i++) {
      if (len > 1000000 && !al_iteration(i - start)) return NULL;
      al_set(recv, i, value);
      if (scr_exc_pending()) return NULL;
    }
    return al_receiver_result(recv, method);
  }
  if (al_is(method, "copyWithin")) {
    double target_d = 0;
    double start_d = 0;
    double end_d = (double)len;
    if (argc > 0 && !al_number(argv[0], &target_d)) return NULL;
    if (argc > 1 && !al_number(argv[1], &start_d)) return NULL;
    if (argc > 2 && argv[2]->kind != SCR_DYN_UNDEF && !al_number(argv[2], &end_d)) return NULL;
    size_t to = al_rel_index(trunc(target_d), len);
    size_t from = al_rel_index(trunc(start_d), len);
    size_t end = al_rel_index(trunc(end_d), len);
    if (from >= end || to >= len) return al_receiver_result(recv, method);
    size_t count = end - from < len - to ? end - from : len - to;
    bool backwards = from < to && to < from + count;
    for (size_t step = 0; step < count; step++) {
      if (len > 1000000 && !al_iteration(step)) return NULL;
      size_t i = backwards ? count - 1 - step : step;
      size_t source = from + i;
      size_t target = to + i;
      if (!al_present(recv, source)) { al_delete(recv, target); }
      else {
        ScrDyn *item = al_item(recv, source);
        if (!item) return NULL;
        al_set(recv, target, item);
        scr_dyn_release(item);
      }
      if (scr_exc_pending()) return NULL;
    }
    return al_receiver_result(recv, method);
  }
  if (al_is(method, "splice")) {
    /* No arguments is the one form whose actualStart is len, not 0: it
     * deletes nothing and only rewrites the same length. Starting at 0
     * would delete — and copy out — the whole receiver. */
    size_t start = len;
    size_t removed = 0;
    if (argc > 0) {
      double start_d = 0;
      if (!al_number(argv[0], &start_d)) return NULL;
      start = al_rel_index(trunc(start_d), len);
      removed = len - start;
      if (argc > 1) {
        double count_d = 0;
        if (!al_number(argv[1], &count_d)) return NULL;
        double clamped = count_d < 0 ? 0 : count_d;
        removed = clamped > (double)removed ? removed : (size_t)clamped;
      }
    }
    size_t items = argc > 2 ? argc - 2 : 0;
    /* ArraySpeciesCreate(O, actualDeleteCount) runs before any index is
     * read or written, and ArrayCreate refuses a length past 2^32-1. */
    if (removed > 4294967295u) {
      static const char msg[] = "Invalid array length";
      scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
      return NULL;
    }
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t i = 0; i < removed; i++) {
      if (len > 1000000 && !al_iteration(i)) { scr_dyn_release(out); return NULL; }
      if (!al_copy_item(out, recv, start + i)) { scr_dyn_release(out); return NULL; }
    }
    if (items < removed) {
      for (size_t k = start; k < len - removed; k++) {
        if (len > 1000000 && !al_iteration(k - start)) { scr_dyn_release(out); return NULL; }
        size_t target = k + items;
        if (!al_present(recv, k + removed)) { al_delete(recv, target); }
        else {
          ScrDyn *item = al_item(recv, k + removed);
          if (!item) { scr_dyn_release(out); return NULL; }
          al_set(recv, target, item);
          scr_dyn_release(item);
        }
        if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
      }
      for (size_t k = len; k > len - removed + items; k--) {
        al_delete(recv, k - 1);
        if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
      }
    } else if (items > removed) {
      for (size_t k = len - removed; k > start; k--) {
        if (len > 1000000 && !al_iteration(len - k)) { scr_dyn_release(out); return NULL; }
        size_t source = k + removed - 1;
        size_t target = k + items - 1;
        if (!al_present(recv, source)) { al_delete(recv, target); }
        else {
          ScrDyn *item = al_item(recv, source);
          if (!item) { scr_dyn_release(out); return NULL; }
          al_set(recv, target, item);
          scr_dyn_release(item);
        }
        if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
      }
    }
    for (size_t j = 0; j < items; j++) {
      al_set(recv, start + j, argv[2 + j]);
      if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
    }
    al_set_length(recv, len - removed + items);
    if (scr_exc_pending()) { scr_dyn_release(out); return NULL; }
    return out;
  }
  if (al_is(method, "with")) {
    double index_d = 0;
    if (!al_number(argc > 0 ? argv[0] : scr_dyn_undefined(), &index_d)) return NULL;
    double index = index_d < 0 ? (double)len + index_d : index_d;
    if (index < 0 || index >= (double)len) {
      static const char msg[] = "Invalid index";
      scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
      return NULL;
    }
    return al_snapshot(recv, len, (size_t)index, argc > 1 ? argv[1] : scr_dyn_undefined());
  }
  if (al_is(method, "toReversed")) {
    /* Get(O, len - k - 1) for k ascending: the reads go from the last
     * index down. */
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t k = 0; k < len; k++) {
      if (len > 1000000 && !al_iteration(k)) { scr_dyn_release(out); return NULL; }
      ScrDyn *item = al_item(recv, len - k - 1);
      if (!item) { scr_dyn_release(out); return NULL; }
      scr_dyn_arr_push(out, item);
    }
    return out;
  }
  if (al_is(method, "toSorted")) {
    ScrDyn *cmp = argc > 0 ? argv[0] : scr_dyn_undefined();
    if (cmp->kind != SCR_DYN_UNDEF && !scr_dyn_is_callable(cmp)) {
      static const char msg[] = "The comparison function must be either a function or undefined";
      scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      return NULL;
    }
    ScrDyn *out = al_snapshot(recv, len, SIZE_MAX, NULL);
    if (!out) return NULL;
    if (out->v.arr.len < 2) return out;
    ScrDyn *sorted = scr_dyn_invoke(out, "sort", argv, argc, "toSorted");
    scr_dyn_release(out);
    return sorted;
  }
  if (al_is(method, "toSpliced")) {
    double start_d = 0;
    if (argc > 0 && !al_number(argv[0], &start_d)) return NULL;
    size_t start = al_rel_index(trunc(start_d), len);
    /* Without `start` nothing is skipped: the result is a copy. */
    size_t removed = argc > 0 ? len - start : 0;
    if (argc > 1) {
      double count_d = 0;
      if (!al_number(argv[1], &count_d)) return NULL;
      double clamped = count_d < 0 ? 0 : count_d;
      removed = clamped > (double)removed ? removed : (size_t)clamped;
    }
    size_t items = argc > 2 ? argc - 2 : 0;
    /* The result array is created up front: a length past 2^53-1 is a
     * TypeError of its own, and ArrayCreate refuses anything past
     * 2^32-1 with a RangeError — both before any index is read. */
    double new_len = (double)len - (double)removed + (double)items;
    if (new_len > 9007199254740991.0) {
      static const char msg[] = "Invalid array length";
      scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      return NULL;
    }
    if (new_len > 4294967295.0) {
      static const char msg[] = "Invalid array length";
      scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
      return NULL;
    }
    /* Every copied index is read with Get and defined on the result, so a
     * missing one becomes an own undefined, not a hole. */
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t i = 0; i < start; i++) {
      if (len > 1000000 && !al_iteration(i)) { scr_dyn_release(out); return NULL; }
      ScrDyn *item = al_item(recv, i);
      if (!item) { scr_dyn_release(out); return NULL; }
      scr_dyn_arr_push(out, item);
    }
    for (size_t j = 2; j < argc; j++) scr_dyn_arr_push(out, scr_dyn_retain(argv[j]));
    for (size_t i = start + removed; i < len; i++) {
      if (len > 1000000 && !al_iteration(i)) { scr_dyn_release(out); return NULL; }
      ScrDyn *item = al_item(recv, i);
      if (!item) { scr_dyn_release(out); return NULL; }
      scr_dyn_arr_push(out, item);
    }
    return out;
  }
  if (al_is(method, "flat") || al_is(method, "flatMap")) {
    /* FlattenIntoArray: after the length, flat converts its depth and
     * flatMap checks its callback. Then each present index is read and,
     * for flatMap, mapped, and its value is flattened into the result
     * before the next index is read. The array dispatch flattens each
     * value as `[value].flat(depth)`, so the flattening rules (nested
     * arrays and wrapped array views) keep one implementation. */
    bool mapping = al_is(method, "flatMap");
    double depth = 1;
    if (mapping) {
      if (!al_cb_check(argv, argc)) return NULL;
    } else if (argc > 0 && argv[0]->kind != SCR_DYN_UNDEF) {
      if (!al_number(argv[0], &depth)) return NULL;
      if (depth < 0) depth = 0;
    }
    ScrDyn *depth_arg = scr_dyn_new_num(depth);
    ScrDyn *out = scr_dyn_new_arr();
    for (size_t i = 0; i < len; i++) {
      if (len > 1000000 && !al_iteration(i)) goto flat_failed;
      if (!al_present(recv, i)) {
        if (scr_exc_pending()) goto flat_failed;
        continue;
      }
      ScrDyn *item = al_item(recv, i);
      if (!item) goto flat_failed;
      if (mapping) {
        ScrDyn *index = scr_dyn_new_num((double)i);
        ScrDyn *cbargs[3] = { item, index, recv };
        scr_dyn_this_push_dyn(argc > 1 ? argv[1] : scr_dyn_undefined());
        ScrDyn *result = scr_dyn_call(argv[0], cbargs, 3, "callback");
        scr_dyn_this_pop();
        scr_dyn_release(index);
        scr_dyn_release(item);
        if (!result) goto flat_failed;
        item = result;
      }
      ScrDyn *one = scr_dyn_new_arr();
      scr_dyn_arr_push(one, item);
      ScrDyn *flattened = scr_dyn_invoke(one, "flat", &depth_arg, 1, mapping ? "flatMap" : "flat");
      scr_dyn_release(one);
      if (!flattened) goto flat_failed;
      for (size_t j = 0; j < flattened->v.arr.len; j++)
        scr_dyn_arr_push(out, scr_dyn_retain(flattened->v.arr.items[j]));
      scr_dyn_release(flattened);
    }
    scr_dyn_release(depth_arg);
    return out;
  flat_failed:
    scr_dyn_release(depth_arg);
    scr_dyn_release(out);
    return NULL;
  }
  /* Every other name keeps the one implementation in the invoke unit
   * (at, slice, indexOf, the higher-order methods, and the "not supported
   * yet" answers). */
  return scr_dyn_array_proto_call(recv, method, args);
}
