/* Oracle test for scr_json.c (the dynamic-value dyn, the RFC 8259 parser,
 * the dynCheck failure path, and the stringify output buffer). Run by
 * json.test.ts; built with ASan + the RC audit, so a clean exit also proves
 * the checked-dynamic tree's recursive ownership (parse failures mid-tree included) leaks
 * nothing and frees nothing twice.
 *
 * EXACT ERROR MESSAGES are asserted here, against OUR strings: compiled
 * programs cannot observe them (the supported catch form is bindingless),
 * and the V8-flavored parse messages are documented as approximate
 * (SEMANTICS.md) — so the C tests, not the differential corpus, are where
 * the exact texts are pinned. Each expected failure routes through
 * scr_exc_print_uncaught(), and json.test.ts asserts the stderr lines.
 */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int checks = 0;
static int failures = 0;

static void check(bool ok, const char *name) {
  checks++;
  if (!ok) {
    failures++;
    printf("FAIL %s\n", name);
  }
}

static ScrStr *S(const char *s) { return scr_str_new(s, strlen(s)); }

static bool str_is(const ScrStr *s, const char *want) {
  return s && s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

static int exact_function_calls;
static ScrDyn *exact_function_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  exact_function_calls++;
  return scr_dyn_new_num(scr_box_get_f64(closure->caps[0]));
}

static void exact_function_extraction_tests(void) {
  scr_collect_cycles();
  long dyn = scr_dyn_live_count();
  size_t headered = scr_cyc_live;
  const char *signature = "(...string[])=>number";
  char same_signature[64];
  strcpy(same_signature, signature);
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[0], 17);
  ScrDyn *value = scr_dyn_new_func(closure, exact_function_call, 0, signature, "rest");
  exact_function_calls = 0;
  ScrClosure *extracted = scr_dyn_func_unbox_exact(value, same_signature);
  check(extracted == closure, "equal signature contents extract the original native closure");
  check(closure->rc == 2, "exact extraction transfers one retained closure");
  check(!scr_dyn_func_unbox_exact(value, "(...number[])=>number"),
      "different element signature cannot extract the same closure layout");
  check(!scr_dyn_func_unbox_exact(value, "(string[])=>number"),
      "fixed and typed-rest signatures are distinct");
  check(closure->rc == 2, "signature mismatch does not retain or release the closure");
  ScrDyn *object = scr_dyn_new_obj();
  check(!scr_dyn_func_unbox_exact(object, signature), "non-callable extraction is a quiet mismatch");
  check(!scr_dyn_func_unbox_exact(scr_dyn_undefined(), signature), "undefined is not an exact closure");
  check(!scr_dyn_func_unbox_exact(NULL, signature), "missing value is not an exact closure");
  check(!scr_exc_pending() && exact_function_calls == 0, "matching never invokes a callback or throws");
  scr_dyn_release(object);

  ScrDyn *bound = scr_dyn_bind(value, NULL, 0);
  check(bound && !scr_dyn_func_unbox_exact(bound, signature),
      "a bound callable needs adaptation instead of native extraction");
  scr_dyn_release(bound);
  scr_throw_error_msg(SCR_ERR_TYPE, "prior", 5);
  check(!scr_dyn_func_unbox_exact(value, "different"), "pending error does not turn mismatch into success");
  ScrClosure *again = scr_dyn_func_unbox_exact(value, signature);
  check(again == closure, "exact extraction still owns its successful result with an error pending");
  scr_closure_release(again);
  ScrCaught *caught = scr_exc_take();
  ScrStr *message = scr_caught_to_string(caught);
  check(str_is(message, "TypeError: prior"), "extraction preserves the original pending exception");
  scr_str_release(message);
  scr_caught_release(caught);

  ScrDyn *result = scr_dyn_call(value, NULL, 0, "rest");
  check(result && result->kind == SCR_DYN_NUM && result->v.num == 17 && exact_function_calls == 1,
      "exact extraction leaves dynamic invocation intact");
  scr_dyn_release(result);
  scr_dyn_release(value);
  scr_collect_cycles();
  check(extracted->rc == 1 && scr_box_get_f64(extracted->caps[0]) == 17,
      "extracted closure and captures outlive the dynamic box");
  scr_box_set_f64(extracted->caps[0], 23);
  result = exact_function_call(extracted, NULL, 0);
  check(result->v.num == 23 && exact_function_calls == 2, "extraction preserves mutable capture identity");
  scr_dyn_release(result);
  scr_closure_release(extracted);
  scr_collect_cycles();
  check(scr_dyn_live_count() == dyn && scr_cyc_live == headered,
      "exact function extraction releases all boxes and captures");
}

static bool typed_view_fails = false;
static void *view_retain(void *value) { return scr_str_retain(value); }
static void view_release(void *value) { scr_str_release(value); }
static ScrDyn *view_materialize(void *value) {
  if (typed_view_fails) return scr_dyn_class_view_unavailable(value);
  ScrDyn *view = scr_dyn_new_obj();
  scr_dyn_obj_set(view, "value", 5, scr_dyn_new_num(7));
  return view;
}

static void typed_view_failure_tests(void) {
  ScrStr *source = S("native identity");
  ScrDyn *capsule = scr_dyn_new_typed_ref(source, view_retain, view_release,
      "test", 4, view_materialize, NULL);
  ScrDyn *first = scr_dyn_typed_ref_materialize(capsule);
  check(first->kind == SCR_DYN_OBJ && !scr_exc_pending(), "typed view begins valid");
  for (int i = 0; i < 3; i++) {
    typed_view_fails = true;
    ScrDyn *failed = scr_dyn_typed_ref_materialize(capsule);
    check(failed->kind == SCR_DYN_UNDEF && scr_exc_pending(), "typed view failure stays catchable");
    scr_exc_clear();
    scr_dyn_release(failed);
    check(first->kind == SCR_DYN_OBJ, "failed refresh preserves cached view");
    typed_view_fails = false;
    ScrDyn *next = scr_dyn_typed_ref_materialize(capsule);
    check(next == first && !scr_exc_pending(), "typed view recovers with stable identity");
    scr_dyn_release(next);
    ScrStr *roundtrip = scr_dyn_typed_ref_unbox(capsule);
    check(roundtrip == source, "failed view preserves native identity");
    scr_str_release(roundtrip);
  }
  scr_dyn_release(first);
  scr_dyn_release(capsule);
  scr_str_release(source);
}

/* Indexed operations stay on the native owner; named match metadata still
 * comes from the same snapshot-copy operation emitted by the compiler. */
static size_t live_array_materializations;
static ScrDyn *live_array_materialize(void *value) {
  live_array_materializations++;
  ScrArr *arr = value;
  ScrDyn *view = scr_dyn_new_arr();
  for (size_t i = 0; i < arr->len; i++) {
    if (scr_arr_state(arr, (double)i) == (double)SCR_ARR_VALUE)
      scr_dyn_arr_push(view, scr_dyn_new_num(scr_arr_get_f64(arr, (double)i)));
    else if (scr_arr_state(arr, (double)i) == (double)SCR_ARR_UNDEFINED)
      scr_dyn_arr_push(view, scr_dyn_retain(scr_dyn_undefined()));
    else scr_dyn_arr_push_hole(view);
  }
  scr_arr_copy_metadata(arr, view);
  return view;
}
static ScrDyn *live_array_get(void *arr, double index) {
  return scr_dyn_new_num(scr_arr_get_f64(arr, index));
}
static ScrDynArrayWrite live_array_set(void *arr, double index, const ScrDyn *value, bool strict) {
  if (value->kind != SCR_DYN_NUM) return SCR_DYN_ARRAY_TYPE_MISMATCH;
  if (!scr_arr_check_set_mode(arr, index, strict)) return SCR_DYN_ARRAY_REFUSED;
  scr_arr_set_f64(arr, index, value->v.num);
  return SCR_DYN_ARRAY_STORED;
}
static ScrDyn *live_array_box(uint64_t slot) {
  double number;
  memcpy(&number, &slot, sizeof number);
  return scr_dyn_new_num(number);
}
static bool live_array_unbox(const ScrDyn *value, uint64_t *out) {
  if (value->kind != SCR_DYN_NUM) return false;
  memcpy(out, &value->v.num, sizeof *out);
  return true;
}
static const ScrDynTypedArrayOps live_array_ops = { live_array_get, live_array_set, live_array_box, live_array_unbox };

static ScrDyn *prototype_array_view(void *value) {
  return typed_view_fails ? scr_dyn_class_view_unavailable(value) : live_array_materialize(value);
}

static ScrDyn *prototype_array_capsule(ScrArr *array, bool alias) {
  ScrDyn *value = scr_dyn_new_typed_ref_traced(array, scr_arr_retain_v, scr_arr_release_v,
      "array<f64>", 10, alias ? prototype_array_view : live_array_materialize, NULL);
  scr_dyn_typed_ref_bind_array(value, &live_array_ops);
  return value;
}

static void array_prototype_ownership_tests(void) {
  ScrDyn *builtin = scr_dyn_array_prototype_base(NULL);
  scr_collect_cycles();
  long dyn = scr_dyn_live_count();
  size_t headered = scr_cyc_live;
  for (int mode = 0; mode < 3; mode++) {
    ScrArr *array = scr_arr_new_small(SCR_ELEM_F64);
    ScrDyn *first = prototype_array_capsule(array, false);
    ScrDyn *alias = prototype_array_capsule(array, true);
    ScrDyn *prototype = mode == 0 ? scr_dyn_retain(builtin)
        : mode == 1 ? scr_dyn_new_obj() : scr_dyn_new_null();
    ScrDyn *result = scr_dyn_set_prototype(first, prototype);
    check(result == first && !scr_exc_pending(), "prototype writes retain the original array capsule");
    scr_dyn_release(result);
    if (mode == 0) check(!array->ext || !array->ext->metadata,
        "unchanged default prototype does not allocate metadata that blocks publication");
    ScrDyn *got = scr_dyn_get_prototype(alias);
    check(got && scr_dyn_strict_eq(got, prototype), "native array aliases share their prototype");
    scr_dyn_release(got);
    ScrDyn *view = scr_dyn_typed_ref_materialize(alias);
    got = scr_dyn_get_prototype(view);
    check(got && scr_dyn_strict_eq(got, prototype), "fresh array projections observe the owner prototype");
    scr_dyn_release(got);
    if (mode != 0) {
      ScrDyn *changed = mode == 1 ? scr_dyn_new_null() : scr_dyn_new_obj();
      scr_dyn_release(scr_dyn_set_prototype(first, changed));
      ScrDyn *refreshed = scr_dyn_typed_ref_materialize(alias);
      got = scr_dyn_get_prototype(refreshed);
      check(refreshed == view && got && scr_dyn_strict_eq(got, changed),
          "cached alias refresh replaces stale prototype state from the native owner");
      scr_dyn_release(got);
      scr_dyn_release(refreshed);
      scr_dyn_release(scr_dyn_set_prototype(first, prototype));
      scr_dyn_release(changed);
    }
    scr_dyn_release(view);
    result = scr_dyn_set_prototype(first, alias);
    check(!result && scr_exc_pending(), "distinct native capsules cannot form a self prototype cycle");
    scr_dyn_release(result);
    scr_exc_clear();
    scr_dyn_release(scr_dyn_set_prototype(first, prototype));
    ScrDyn *bridge = scr_dyn_new_obj();
    scr_dyn_release(scr_dyn_set_prototype(bridge, alias));
    result = scr_dyn_set_prototype(first, bridge);
    check(!result && scr_exc_pending(), "native identity rejects an indirect prototype cycle");
    scr_dyn_release(result);
    scr_exc_clear();
    scr_dyn_release(scr_dyn_set_prototype(first, prototype));
    scr_dyn_release(bridge);
    scr_dyn_release(first);
    scr_dyn_release(alias);
    scr_collect_cycles();
    first = prototype_array_capsule(array, false);
    got = scr_dyn_get_prototype(first);
    check(got && scr_dyn_strict_eq(got, prototype), "native prototype survives every capsule being released");
    scr_dyn_release(got);
    scr_native_integrity_strengthen(array, SCR_NATIVE_NON_EXTENSIBLE);
    result = scr_dyn_set_prototype(first, prototype);
    check(result == first && !scr_exc_pending(), "same effective prototype succeeds on non-extensible arrays");
    scr_dyn_release(result);
    scr_exc_clear();
    ScrDyn *different = scr_dyn_new_obj();
    result = scr_dyn_set_prototype(first, different);
    check(!result && scr_exc_pending(), "non-extensible arrays reject a changed prototype");
    scr_dyn_release(result);
    scr_exc_clear();
    scr_dyn_release(different);
    scr_dyn_release(first);
    scr_arr_release(array);
    scr_dyn_release(prototype);
    scr_collect_cycles();
  }
  ScrArr *array = scr_arr_new_small(SCR_ELEM_F64);
  ScrDyn *capsule = prototype_array_capsule(array, false), *prototype = scr_dyn_new_obj();
  scr_dyn_obj_set(prototype, "back", 4, scr_dyn_retain(capsule));
  scr_dyn_release(scr_dyn_set_prototype(capsule, prototype));
  scr_dyn_release(prototype);
  scr_dyn_release(capsule);
  scr_arr_release(array);
  scr_collect_cycles();
  array = scr_arr_new_small(SCR_ELEM_F64);
  ScrArr *parent = scr_arr_new_small(SCR_ELEM_F64);
  capsule = prototype_array_capsule(array, false);
  prototype = prototype_array_capsule(parent, true);
  typed_view_fails = true;
  live_array_materializations = 0;
  ScrDyn *result = scr_dyn_set_prototype(capsule, prototype);
  check(result == capsule && !scr_exc_pending(), "native prototype admission does not need a snapshot");
  scr_dyn_release(result);
  scr_exc_clear();
  scr_native_integrity_strengthen(array, SCR_NATIVE_NON_EXTENSIBLE);
  result = scr_dyn_set_prototype(capsule, prototype);
  check(result == capsule && !scr_exc_pending(), "same native prototype bypasses its unavailable snapshot");
  scr_dyn_release(result);
  scr_exc_clear();
  result = scr_dyn_set_prototype(prototype, capsule);
  check(!result && scr_exc_pending(), "native prototype cycles reject without rebuilding either array");
  scr_dyn_release(result);
  scr_exc_clear();
  ScrDyn *saved = builtin->prototype ? scr_dyn_retain(builtin->prototype) : NULL;
  bool saved_null = builtin->null_proto;
  result = scr_dyn_set_prototype(builtin, prototype);
  check(!result && scr_exc_pending(), "cycle walks include an array's implicit Array.prototype link");
  scr_dyn_release(result);
  scr_exc_clear();
  ScrDyn *unexpected = builtin->prototype;
  builtin->prototype = saved;
  builtin->null_proto = saved_null;
  scr_dyn_release(unexpected);
  check(live_array_materializations == 0, "native prototype operations never materialize indexed contents");
  typed_view_fails = false;
  scr_dyn_release(capsule);
  scr_dyn_release(prototype);
  scr_arr_release(array);
  scr_arr_release(parent);
  scr_collect_cycles();
  check(scr_dyn_live_count() == dyn && scr_cyc_live == headered,
      "array prototype owners release all views and prototype references");
  result = scr_dyn_set_prototype(builtin, builtin);
  check(!result && scr_exc_pending(), "Array.prototype itself cannot acquire a self prototype");
  scr_dyn_release(result);
  scr_exc_clear();
  saved = builtin->prototype ? scr_dyn_retain(builtin->prototype) : NULL;
  saved_null = builtin->null_proto;
  for (int null_prototype = 0; null_prototype < 2; null_prototype++) {
    prototype = null_prototype ? scr_dyn_new_null() : scr_dyn_new_obj();
    scr_dyn_release(scr_dyn_set_prototype(builtin, prototype));
    ScrDyn *got = scr_dyn_get_prototype(builtin);
    check(got && scr_dyn_strict_eq(got, prototype) && !scr_exc_pending(),
        "Array.prototype observes its explicit custom or null prototype");
    scr_dyn_release(got);
    scr_dyn_release(prototype);
  }
  unexpected = builtin->prototype;
  builtin->prototype = saved;
  builtin->null_proto = saved_null;
  scr_dyn_release(unexpected);
  scr_dyn_release(builtin);
}

static char array_property_error(void) {
  if (!scr_exc_pending()) return '-';
  ScrCaught *caught = scr_exc_take();
  ScrStr *text = scr_caught_to_string(caught);
  char error = strncmp(text->data, "TypeError:", 10) == 0 ? 'T'
      : strncmp(text->data, "RangeError:", 11) == 0 ? 'R' : 'E';
  scr_str_release(text);
  scr_caught_release(caught);
  return error;
}

static void array_property_state(ScrDyn *recv, ScrArr *arr) {
  bool native = recv->kind == SCR_DYN_TYPED_REF;
  size_t count = native ? arr->len : recv->v.arr.len;
  printf("%zu|", count);
  for (size_t i = 0; i < count; i++) {
    bool present = native ? scr_arr_has(arr, (double)i) : scr_dyn_arr_has_index(recv, i);
    bool undefined = native ? scr_arr_state(arr, (double)i) == SCR_ARR_UNDEFINED
        : recv->v.arr.items[i]->kind == SCR_DYN_UNDEF;
    if (!present) printf("_");
    else if (undefined) printf("u");
    else printf("%.0f", native ? scr_arr_get_f64(arr, (double)i) : recv->v.arr.items[i]->v.num);
    printf(",");
  }
  printf("\n");
}

static ScrDyn *length_receiver;
static int length_mode, length_calls;

static void length_restrict(bool freeze) {
  if (length_receiver->kind == SCR_DYN_TYPED_REF)
    scr_native_integrity_strengthen(length_receiver->v.typed_ref.ptr,
        freeze ? SCR_NATIVE_FROZEN : SCR_NATIVE_SEALED);
  else scr_dyn_release(freeze ? scr_dyn_freeze(length_receiver) : scr_dyn_seal(length_receiver));
}

static ScrDyn *length_value_of(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  length_calls++;
  if ((length_mode == 11 && length_calls == 2) || length_mode == 12) {
    scr_throw_error_msg(length_mode == 11 ? SCR_ERR_RANGE : SCR_ERR_TYPE, "coercion", 8);
    return NULL;
  }
  if (((length_mode == 5 || length_mode == 6) && length_calls == 1) ||
      ((length_mode == 7 || length_mode == 8) && length_calls == 2))
    length_restrict(true);
  if ((length_mode == 14 || length_mode == 15) && length_calls == 1) length_restrict(false);
  if ((length_mode == 9 || length_mode == 10) && length_calls == 1) {
    ScrStr *key = S(length_mode == 9 ? "length" : "0");
    ScrDyn *value = scr_dyn_new_num(length_mode == 9 ? 1 : 9);
    scr_dyn_key_set(length_receiver, key, value);
    scr_dyn_release(value);
    scr_str_release(key);
    if (scr_exc_pending()) return NULL;
  }
  double number = 2;
  if (length_mode == 1 || length_mode == 10) number = length_calls == 1 ? 2 : 1;
  else if (length_mode == 2) number = length_calls == 1 ? 4294967298.0 : 2;
  else if (length_mode == 3) number = length_calls == 1 ? 2.5 : 2;
  else if (length_mode == 4) number = length_calls == 1 ? NAN : 0;
  else if (length_mode == 5 || length_mode == 7 || length_mode == 15) number = 3;
  else if (length_mode == 6 || length_mode == 14) number = 0;
  else if (length_mode == 8) number = 1;
  return scr_dyn_new_num(number);
}

static void array_property_oracle(void) {
  const unsigned levels[] = {0, SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  for (size_t native = 0; native < 2; native++) {
    for (size_t level = 0; level < 4; level++) {
      for (size_t len = 0, shapes = 1; len <= 4; len++, shapes *= 3) {
        for (size_t shape = 0; shape < shapes; shape++) {
          for (size_t op = 0; op < 16; op++) {
            ScrArr *arr = scr_arr_new(SCR_ELEM_F64, len);
            scr_arr_set_len(arr, (double)len);
            size_t digits = shape;
            for (size_t i = 0; i < len; i++, digits /= 3) {
              if (digits % 3 == 1) scr_arr_set_f64(arr, (double)i, (double)i + 1);
              else if (digits % 3 == 2) scr_arr_set_undefined(arr, (double)i);
            }
            ScrDyn *recv = native
              ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
                    "array<f64>", 10, live_array_materialize, NULL)
              : live_array_materialize(arr);
            if (native) {
              scr_dyn_typed_ref_bind_array(recv, &live_array_ops);
              if (level) scr_native_integrity_strengthen(arr, levels[level]);
            } else if (level) {
              scr_dyn_release(level == 1 ? scr_dyn_prevent_extensions(recv)
                  : level == 2 ? scr_dyn_seal(recv) : scr_dyn_freeze(recv));
            }
            ScrStr *key;
            if (op < 9) {
              double lengths[] = {0, 1, 2, (double)len, (double)len + 1, -1, 1.5, NAN, INFINITY};
              key = S("length");
              ScrDyn *value = scr_dyn_new_num(lengths[op]);
              scr_dyn_key_set(recv, key, value);
              scr_dyn_release(value);
            } else {
              char text[32];
              size_t index = op == 9 || op == 12 ? 0 : op == 10 || op == 13 ? 1 : len;
              snprintf(text, sizeof text, "%zu", index);
              key = S(op >= 14 ? "length" : text);
              scr_dyn_key_delete(recv, key, op < 12 || op == 14);
            }
            scr_str_release(key);
            printf("%zu|%zu|%zu|%zu|%zu|%c|", native, level, len, shape, op, array_property_error());
            array_property_state(recv, arr);
            scr_dyn_release(recv);
            scr_arr_release(arr);
          }
        }
      }
    }
  }
  for (int native = 0; native < 2; native++) {
    for (length_mode = 0; length_mode < 16; length_mode++) {
      ScrArr *arr = scr_arr_new(SCR_ELEM_F64, 3);
      scr_arr_push_f64(arr, 1);
      scr_arr_push_f64(arr, 2);
      scr_arr_set_len(arr, 3);
      length_receiver = native
          ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
                "array<f64>", 10, live_array_materialize, NULL)
          : live_array_materialize(arr);
      if (native) scr_dyn_typed_ref_bind_array(length_receiver, &live_array_ops);
      if (length_mode == 13) length_restrict(true);
      ScrDyn *value = scr_dyn_new_obj();
      scr_dyn_obj_set(value, "valueOf", 7, scr_dyn_new_func(scr_closure_new(NULL, 0),
          length_value_of, 0, "length coercion", "length_value_of"));
      ScrStr *key = S("length");
      live_array_materializations = 0;
      length_calls = 0;
      scr_dyn_key_set(length_receiver, key, value);
      printf("c|%d|%d|%d|%zu|%c|", native, length_mode, length_calls,
          live_array_materializations, array_property_error());
      array_property_state(length_receiver, arr);
      scr_str_release(key);
      scr_dyn_release(value);
      scr_dyn_release(length_receiver);
      length_receiver = NULL;
      scr_arr_release(arr);
    }
  }
}


static void reflect_array_oracle(void) {
  const unsigned levels[] = {0, SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  for (int native = 0; native < 2; native++) for (int route = 0; route < 2; route++)
    for (int level = 0; level < 4; level++) for (int len = 0, shapes = 1; len < 3; len++, shapes *= 3)
      for (int shape = 0; shape < shapes; shape++) for (int index = 0; index < 4; index++)
        for (int undef = 0; undef < 2; undef++) {
          ScrArr *arr = scr_arr_new(SCR_ELEM_F64, (size_t)len); scr_arr_set_len(arr, len);
          for (int i = 0, digits = shape; i < len; i++, digits /= 3) {
            if (digits % 3 == 1) scr_arr_set_f64(arr, i, i + 1);
            else if (digits % 3 == 2) scr_arr_set_undefined(arr, i);
          }
          ScrDyn *receiver = native ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
              "array<f64>", 10, live_array_materialize, NULL) : live_array_materialize(arr);
          if (native) {
            scr_dyn_typed_ref_bind_array(receiver, &live_array_ops);
            if (level) scr_native_integrity_strengthen(arr, levels[level]);
          } else if (level) scr_dyn_release(level == 1 ? scr_dyn_prevent_extensions(receiver)
              : level == 2 ? scr_dyn_seal(receiver) : scr_dyn_freeze(receiver));
          ScrDyn *target = route ? scr_dyn_new_obj() : scr_dyn_retain(receiver);
          ScrDyn *key = scr_dyn_new_num(index), *value = undef ? scr_dyn_retain(scr_dyn_undefined()) : scr_dyn_new_num(9);
          bool ok = scr_dyn_reflect_set(target, key, value, receiver);
          printf("i|%d|%d|%d|%d|%d|%d|%d|%d|%c|", native, route, level, len, shape, index, undef, ok, array_property_error());
          array_property_state(receiver, arr);
          scr_dyn_release(value); scr_dyn_release(key); scr_dyn_release(target);
          scr_dyn_release(receiver); scr_arr_release(arr);
        }
  for (int native = 0; native < 2; native++) for (int route = 0; route < 2; route++)
    for (length_mode = 0; length_mode < 16; length_mode++) {
      ScrArr *arr = scr_arr_new(SCR_ELEM_F64, 3);
      scr_arr_push_f64(arr, 1); scr_arr_push_f64(arr, 2); scr_arr_set_len(arr, 3);
      length_receiver = native ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
          "array<f64>", 10, live_array_materialize, NULL) : live_array_materialize(arr);
      if (native) scr_dyn_typed_ref_bind_array(length_receiver, &live_array_ops);
      if (length_mode == 13) length_restrict(true);
      ScrDyn *value = scr_dyn_new_obj();
      scr_dyn_obj_set(value, "valueOf", 7, scr_dyn_new_func(scr_closure_new(NULL, 0),
          length_value_of, 0, "length coercion", "length_value_of"));
      ScrStr *name = S("length"); ScrDyn *key = scr_dyn_new_str(name); scr_str_release(name);
      ScrDyn *target = route ? scr_dyn_new_obj() : scr_dyn_retain(length_receiver);
      length_calls = 0; live_array_materializations = 0;
      bool ok = scr_dyn_reflect_set(target, key, value, length_receiver);
      printf("l|%d|%d|%d|%d|%d|%c|", native, route, length_mode, length_calls, ok, array_property_error());
      array_property_state(length_receiver, arr);
      check(!native || live_array_materializations == 0, "Reflect length uses live native storage");
      scr_dyn_release(target); scr_dyn_release(key); scr_dyn_release(value);
      scr_dyn_release(length_receiver); length_receiver = NULL; scr_arr_release(arr);
    }
}

static void array_mutation_result(ScrDyn *value, ScrDyn *receiver) {
  if (!value) { printf("!"); return; }
  if (value == receiver) { printf("self"); return; }
  if (value->kind == SCR_DYN_UNDEF) { printf("u"); return; }
  if (value->kind == SCR_DYN_NUM) { printf("%.0f", value->v.num); return; }
  if (value->kind != SCR_DYN_ARR) { printf("?"); return; }
  printf("a%zu:", value->v.arr.len);
  for (size_t i = 0; i < value->v.arr.len; i++) {
    if (!scr_dyn_arr_has_index(value, i)) printf("_");
    else if (value->v.arr.items[i]->kind == SCR_DYN_UNDEF) printf("u");
    else printf("%.0f", value->v.arr.items[i]->v.num);
    printf(",");
  }
}

static void array_mutation_oracle(void) {
  static const struct { const char *name; size_t argc; double args[5]; } cases[] = {
    {"push", 0, {0}}, {"push", 2, {9, 8}}, {"pop", 0, {0}}, {"shift", 0, {0}},
    {"unshift", 0, {0}}, {"unshift", 2, {9, 8}}, {"reverse", 0, {0}},
    {"sort", 0, {0}}, {"sort", 1, {1}}, {"fill", 3, {9, 1, 3}},
    {"fill", 0, {0}}, {"copyWithin", 3, {1, 0, 3}}, {"copyWithin", 2, {0, 2}},
    {"splice", 0, {0}}, {"splice", 1, {1}}, {"splice", 3, {1, 1, 9}},
    {"splice", 5, {1, 2, 9, 8, 7}}, {"splice", 2, {1, 2}}, {"fill", 3, {9, 0, 0}},
  };
  const unsigned levels[] = {0, SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  for (size_t native = 0; native < 2; native++) {
    for (size_t route = 0; route < 4; route++) {
      for (size_t level = 0; level < 4; level++) {
        for (size_t len = 0, shapes = 1; len <= 4; len++, shapes *= 3) {
          for (size_t shape = 0; shape < shapes; shape++) {
            for (size_t op = 0; op < sizeof cases / sizeof cases[0]; op++) {
              ScrArr *arr = scr_arr_new(SCR_ELEM_F64, len);
              scr_arr_set_len(arr, (double)len);
              for (size_t i = 0, digits = shape; i < len; i++, digits /= 3) {
                if (digits % 3 == 1) scr_arr_set_f64(arr, (double)i, (double)len - i);
                else if (digits % 3 == 2) scr_arr_set_undefined(arr, (double)i);
              }
              ScrDyn *recv = native ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v,
                  scr_arr_release_v, "array<f64>", 10, live_array_materialize, NULL)
                  : live_array_materialize(arr);
              if (native) {
                scr_dyn_typed_ref_bind_array(recv, &live_array_ops);
                if (level) scr_native_integrity_strengthen(arr, levels[level]);
              } else if (level) scr_dyn_release(level == 1 ? scr_dyn_prevent_extensions(recv)
                  : level == 2 ? scr_dyn_seal(recv) : scr_dyn_freeze(recv));
              ScrDyn *pack = scr_dyn_new_arr();
              for (size_t i = 0; i < cases[op].argc; i++)
                scr_dyn_arr_push(pack, scr_dyn_new_num(cases[op].args[i]));
              ScrStr *name = S(cases[op].name);
              ScrDyn *result;
              if (route == 0) result = scr_dyn_invoke(recv, name->data, pack->v.arr.items,
                  pack->v.arr.len, name->data);
              else if (route == 1) result = scr_dyn_array_proto_call(recv, name, pack);
              else {
                ScrDyn *prototype = scr_dyn_array_prototype();
                ScrDyn *method = scr_dyn_arr_named_get(prototype, name);
                scr_dyn_release(prototype);
                if (route == 2) {
                  scr_dyn_this_push_dyn(recv);
                  result = scr_dyn_call(method, pack->v.arr.items, pack->v.arr.len, name->data);
                  scr_dyn_this_pop();
                } else {
                  ScrDyn *args[] = {recv, pack};
                  result = scr_dyn_invoke(method, "apply", args, 2, "apply");
                }
                scr_dyn_release(method);
              }
              char error = array_property_error();
              printf("%zu|%zu|%zu|%zu|%zu|%zu|%c|", native, route, level, len, shape, op, error);
              array_mutation_result(error == '-' ? result : NULL, recv);
              printf("|");
              array_property_state(recv, arr);
              scr_dyn_release(result);
              scr_str_release(name);
              scr_dyn_release(pack);
              scr_dyn_release(recv);
              scr_arr_release(arr);
            }
          }
        }
      }
    }
  }
}

static ScrDyn *string_array_get(void *arr, double index) {
  ScrStr *text = scr_arr_get_ref(arr, index);
  ScrDyn *value = scr_dyn_new_str(text);
  scr_str_release(text);
  return value;
}

static ScrDyn *string_array_materialize(void *ptr) {
  live_array_materializations++;
  ScrArr *arr = ptr;
  ScrDyn *view = scr_dyn_new_arr();
  for (size_t i = 0; i < arr->len; i++) {
    if (scr_arr_has(arr, (double)i)) scr_dyn_arr_push(view, string_array_get(arr, (double)i));
    else scr_dyn_arr_push_hole(view);
  }
  return view;
}

static ScrDyn *string_array_box(uint64_t slot) {
  return scr_dyn_new_str((ScrStr *)(uintptr_t)slot);
}
static bool string_array_unbox(const ScrDyn *value, uint64_t *out) {
  if (value->kind != SCR_DYN_STR) return false;
  *out = (uint64_t)(uintptr_t)scr_str_retain(value->v.str);
  return true;
}

static void array_property_ownership_tests(void) {
  static const ScrDynTypedArrayOps ops = {string_array_get, NULL, string_array_box, string_array_unbox};
  const unsigned levels[] = {0, SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  ScrStr *zero = S("0"), *length = S("length");
  ScrDyn *empty = scr_dyn_new_num(0);
  for (int level = 0; level < 4; level++) {
    for (int truncate = 0; truncate < 2; truncate++) {
      ScrDyn *arr = scr_dyn_new_arr();
      scr_dyn_arr_push(arr, scr_dyn_retain(arr));
      if (level) scr_dyn_release(level == 1 ? scr_dyn_prevent_extensions(arr)
          : level == 2 ? scr_dyn_seal(arr) : scr_dyn_freeze(arr));
      if (truncate) scr_dyn_key_set(arr, length, empty);
      else scr_dyn_key_delete(arr, zero, true);
      check(array_property_error() == (level < 2 ? '-' : 'T'), "checked cyclic property outcome");
      check(arr->rc == (level < 2 ? 1 : 2), "checked cyclic property retains its external owner");
      check(arr->v.arr.len == (truncate && level < 2 ? 0 : 1) &&
          scr_dyn_arr_has_index(arr, 0) == (level >= 2), "checked cyclic property keeps presence");
      scr_dyn_release(arr);
      scr_collect_cycles();
    }
  }
  for (size_t level = 0; level < 4; level++) {
    ScrStr *left = S("left"), *right = S("right");
    ScrArr *arr = scr_arr_new(SCR_ELEM_STR, 3);
    scr_arr_push_ref(arr, scr_str_retain(left));
    scr_arr_push_ref(arr, scr_str_retain(right));
    scr_arr_set_len(arr, 3);
    ScrDyn *capsule = scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
        "array<string>", 13, string_array_materialize, NULL);
    scr_dyn_typed_ref_bind_array(capsule, &ops);
    if (level) scr_native_integrity_strengthen(arr, levels[level]);
    live_array_materializations = 0;
    scr_dyn_key_delete(capsule, zero, false);
    check(!scr_exc_pending() && left->rc == (level < 2 ? 1 : 2),
        "native non-strict delete releases only a configurable reference");
    scr_throw_error_msg(SCR_ERR_TYPE, "prior", 5);
    scr_dyn_key_delete(capsule, zero, false);
    ScrCaught *caught = scr_exc_take();
    ScrStr *message = scr_caught_to_string(caught);
    check(str_is(message, "TypeError: prior"), "non-strict delete preserves the pending exception");
    scr_str_release(message);
    scr_caught_release(caught);
    scr_dyn_key_set(capsule, length, empty);
    check(array_property_error() == (level < 2 ? '-' : 'T'), "native reference truncation outcome");
    check(arr->len == (level < 2 ? 0 : level == 2 ? 2 : 3),
        "native reference truncation keeps partial sealed length");
    check(left->rc == (level < 2 ? 1 : 2) && right->rc == (level < 2 ? 1 : 2),
        "native reference truncation retains only surviving elements");
    check(live_array_materializations == 0, "native property mutations never snapshot references");
    scr_dyn_release(capsule);
    scr_arr_release(arr);
    check(left->rc == 1 && right->rc == 1, "native property teardown releases retained references");
    scr_str_release(left);
    scr_str_release(right);
  }
  scr_dyn_release(empty);
  scr_str_release(zero);
  scr_str_release(length);
}

static ScrDyn *property_receiver;
static size_t property_gets, property_sets;
static bool property_this_ok;
static ScrDyn *property_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  property_gets++;
  ScrDyn *receiver = scr_dyn_this_get();
  property_this_ok = property_this_ok && receiver == property_receiver;
  scr_dyn_release(receiver);
  return scr_dyn_new_num(20);
}
static ScrDyn *property_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  property_sets++;
  ScrDyn *receiver = scr_dyn_this_get();
  property_this_ok = property_this_ok && receiver == property_receiver &&
      argc == 1 && args[0]->kind == SCR_DYN_NUM && args[0]->v.num == 9;
  scr_dyn_release(receiver);
  return scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *property_shrink(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrStr *key = S("length");
  ScrDyn *one = scr_dyn_new_num(1);
  scr_dyn_key_set(property_receiver, key, one);
  scr_dyn_release(one);
  scr_str_release(key);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(0);
}
static void property_define(ScrDyn *prototype, const char *name, int kind) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  if (kind < 2) {
    ScrDynThunk thunk = kind == 0 ? property_getter : property_setter;
    scr_dyn_obj_set(descriptor, kind == 0 ? "get" : "set", 3,
        scr_dyn_new_func(scr_closure_new(NULL, 0), thunk, kind, "array accessor", "property_accessor"));
  } else {
    scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(30));
    scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(kind == 3));
  }
  ScrStr *text = S(name);
  ScrDyn *key = scr_dyn_new_str(text);
  ScrDyn *defined = scr_dyn_define_property(prototype, key, descriptor);
  check(defined && !scr_exc_pending(), "prototype descriptor setup");
  scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_str_release(text);
  scr_dyn_release(descriptor);
}
static ScrDyn *property_at(ScrDyn *receiver, double index) {
  ScrStr *method = S("at");
  ScrDyn *args = scr_dyn_new_arr();
  scr_dyn_arr_push(args, scr_dyn_new_num(index));
  ScrDyn *result = scr_dyn_array_proto_call(receiver, method, args);
  scr_dyn_release(args);
  scr_str_release(method);
  return result;
}
static void array_prototype_tests(void) {
  const unsigned levels[] = {0, SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  for (int native = 0; native < 2; native++) {
    for (int level = 0; level < 4; level++) {
      ScrArr *arr = scr_arr_new(SCR_ELEM_F64, 3);
      scr_arr_push_f64(arr, 10);
      scr_arr_set_len(arr, 3);
      property_receiver = native
          ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
                "array<f64>", 10, live_array_materialize, NULL) : live_array_materialize(arr);
      if (native) scr_dyn_typed_ref_bind_array(property_receiver, &live_array_ops);
      ScrDyn *prototype = scr_dyn_new_obj();
      property_define(prototype, "0", 0);
      property_define(prototype, "1", 0);
      property_define(prototype, "2", 1);
      property_define(prototype, "3", 2);
      property_define(prototype, "4", 3);
      property_define(prototype, "extra", 1);
      scr_dyn_release(scr_dyn_set_prototype(property_receiver, prototype));
      if (level) {
        if (native) scr_native_integrity_strengthen(arr, levels[level]);
        else scr_dyn_release(level == 1 ? scr_dyn_prevent_extensions(property_receiver)
            : level == 2 ? scr_dyn_seal(property_receiver) : scr_dyn_freeze(property_receiver));
      }
      live_array_materializations = property_gets = property_sets = 0;
      property_this_ok = true;
      ScrDyn *got = property_at(property_receiver, 0);
      check(got && got->kind == SCR_DYN_NUM && got->v.num == 10 && property_gets == 0,
          "own array value precedes prototype getter");
      scr_dyn_release(got);
      got = property_at(property_receiver, 1);
      check(got && got->kind == SCR_DYN_NUM && got->v.num == 20 && property_gets == 1 &&
          property_this_ok, "inherited getter receives original array identity");
      scr_dyn_release(got);
      if (!native) {
        got = scr_dyn_index_get(property_receiver, 1);
        check(got == NULL, "numeric fast path defers inherited hole read");
        scr_dyn_release(got);
      }
      ScrStr *one = S("1"), *two = S("2"), *three = S("3"), *four = S("4");
      ScrDyn *value = scr_dyn_new_num(9);
      scr_dyn_key_set(property_receiver, two, value);
      check(!scr_exc_pending() && property_sets == 1 && property_this_ok &&
          !scr_dyn_has_own(property_receiver, two), "inherited setter precedes non-extensible refusal");
      scr_dyn_key_set(property_receiver, one, value);
      check(array_property_error() == 'T', "getter-only inherited property rejects Set");
      scr_dyn_key_set(property_receiver, three, value);
      check(array_property_error() == 'T', "inherited read-only data rejects Set");
      scr_dyn_key_set(property_receiver, four, value);
      check(array_property_error() == (level == 0 ? '-' : 'T') &&
          scr_dyn_has_own(property_receiver, four) == (level == 0),
          "inherited writable data uses receiver extensibility");
      check(live_array_materializations == 0, "native prototype actions never refresh the snapshot");
      ScrStr *extra = S("extra");
      scr_dyn_key_set(property_receiver, extra, value);
      check(!scr_exc_pending() && property_sets == 2 && property_this_ok &&
          !scr_dyn_has_own(property_receiver, extra), "named inherited setter keeps array receiver");
      scr_str_release(extra);
      if (level == 0) {
        ScrDyn *length = scr_dyn_new_num(3);
        ScrStr *key = S("length");
        scr_dyn_key_set(property_receiver, key, length);
        scr_str_release(key);
        scr_dyn_release(length);
        ScrDyn *start = scr_dyn_new_obj();
        scr_dyn_obj_set(start, "valueOf", 7, scr_dyn_new_func(scr_closure_new(NULL, 0),
            property_shrink, 0, "shrink before slice", "property_shrink"));
        ScrDyn *args = scr_dyn_new_arr();
        scr_dyn_arr_push(args, start);
        ScrStr *method = S("slice");
        got = scr_dyn_array_proto_call(property_receiver, method, args);
        check(got && got->kind == SCR_DYN_ARR && got->v.arr.len == 3 &&
            got->v.arr.items[0]->v.num == 10 && got->v.arr.items[1]->v.num == 20 &&
            got->v.arr.items[2]->kind == SCR_DYN_UNDEF && scr_dyn_arr_has_index(got, 2) &&
            property_this_ok, "captured-length traversal reads inherited indices after shrink");
        scr_dyn_release(got);
        scr_str_release(method);
        scr_dyn_release(args);
      }
      scr_dyn_release(value);
      scr_str_release(one); scr_str_release(two); scr_str_release(three); scr_str_release(four);
      scr_dyn_release(prototype);
      scr_dyn_release(property_receiver);
      property_receiver = NULL;
      scr_arr_release(arr);
    }
  }
}

static ScrDyn *opaque_receiver, *opaque_prototype, *opaque_marker;
static ScrStr *opaque_key;
static double opaque_value;
static size_t opaque_gets, opaque_sets, opaque_commits;
static int opaque_shape, opaque_mode;
static bool opaque_this_ok, opaque_materialize_fails;

/* Tuple layouts can materialize arrays without storing a ScrArr. Keep this
 * owner opaque so the fallback cannot accidentally depend on that layout. */
static ScrDyn *opaque_materialize(void *owner) {
  (void)owner;
  if (opaque_materialize_fails) {
    scr_dyn_throw(scr_dyn_retain(opaque_marker));
    return NULL;
  }
  ScrDyn *view = opaque_shape ? scr_dyn_new_obj() : scr_dyn_new_arr();
  if (opaque_shape) {
    scr_dyn_obj_set(view, "0", 1, scr_dyn_new_num(opaque_value));
    scr_dyn_obj_set(view, "length", 6, scr_dyn_new_num(3));
  } else {
    scr_dyn_arr_push(view, scr_dyn_new_num(opaque_value));
    scr_dyn_arr_push_hole(view);
    scr_dyn_arr_push_hole(view);
  }
  return view;
}
static ScrDyn *opaque_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *receiver = scr_dyn_this_get();
  opaque_this_ok = receiver == opaque_receiver;
  scr_dyn_release(receiver);
  opaque_gets++;
  if (opaque_mode == 2) scr_dyn_release(scr_dyn_typed_ref_materialize(opaque_receiver));
  if (opaque_mode == 1) {
    scr_dyn_throw(scr_dyn_retain(opaque_marker));
    return NULL;
  }
  return scr_dyn_new_num(opaque_value);
}
static void opaque_commit(void *owner, const ScrDyn *view) {
  (void)owner;
  opaque_commits++;
  const ScrDyn *value = opaque_shape ? scr_dyn_obj_get(view, "0", 1) : view->v.arr.items[0];
  check(value && value->kind == SCR_DYN_NUM, "opaque commit retains native field type");
  if (value && value->kind == SCR_DYN_NUM) opaque_value = value->v.num;
}
static ScrDyn *opaque_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *receiver = scr_dyn_this_get();
  opaque_this_ok = receiver == opaque_receiver && argc == 1 && args[0]->kind == SCR_DYN_NUM;
  scr_dyn_release(receiver);
  opaque_sets++;
  if (argc == 1 && args[0]->kind == SCR_DYN_NUM) opaque_value = args[0]->v.num;
  if (opaque_mode == 2 || opaque_mode == 6) scr_dyn_release(scr_dyn_typed_ref_materialize(opaque_receiver));
  if (opaque_mode == 3 || opaque_mode == 6) scr_dyn_key_delete(opaque_prototype, opaque_key, true);
  if (opaque_mode == 1 || opaque_mode == 3 || opaque_mode == 6) {
    scr_dyn_throw(scr_dyn_retain(opaque_marker));
    return NULL;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}
static void opaque_exception_check(void) {
  check(scr_exc_pending(), "opaque callback failure remains pending");
  ScrCaught *caught = scr_exc_take();
  ScrDyn *thrown = scr_caught_to_dyn(caught);
  check(thrown == opaque_marker, "opaque callback keeps exact thrown value");
  scr_dyn_release(thrown);
  scr_caught_release(caught);
}
static ScrDyn *borrow_bytes_materialize(void *owner) { return scr_dyn_new_bytes(owner); }
static void opaque_accessor_tests(void) {
  for (opaque_shape = 0; opaque_shape < 2; opaque_shape++) {
    for (int named = 0; named < 2; named++) {
      for (opaque_mode = 0; opaque_mode < 6; opaque_mode++) {
        ScrStr *owner = S("opaque native owner");
        opaque_value = 1;
        opaque_gets = opaque_sets = opaque_commits = 0;
        opaque_this_ok = false;
        opaque_receiver = scr_dyn_new_typed_ref(owner, view_retain, view_release,
            "record:opaque", 13, opaque_materialize, opaque_commit);
        opaque_prototype = scr_dyn_new_obj();
        opaque_marker = scr_dyn_new_obj();
        opaque_key = S(named ? "extra" : "2");
        ScrDyn *key = scr_dyn_new_str(opaque_key), *descriptor = scr_dyn_new_obj();
        if (opaque_mode < 4) scr_dyn_obj_set(descriptor, "set", 3,
            scr_dyn_new_func(scr_closure_new(NULL, 0), opaque_setter, 1,
                "opaque setter", "opaque_setter"));
        else if (opaque_mode == 4)
          scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_retain(scr_dyn_undefined()));
        else scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(30));
        if (opaque_mode < 3) scr_dyn_obj_set(descriptor, "get", 3,
            scr_dyn_new_func(scr_closure_new(NULL, 0), opaque_getter, 0,
                "opaque getter", "opaque_getter"));
        scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
        scr_dyn_release(scr_dyn_define_property(opaque_prototype, key, descriptor));
        scr_dyn_release(scr_dyn_set_prototype(opaque_receiver, opaque_prototype));
        check(!scr_exc_pending(), "opaque accessor setup");
        ScrDyn *value = scr_dyn_new_num(9);
        scr_dyn_key_set(opaque_receiver, opaque_key, value);
        if (opaque_mode == 1 || opaque_mode == 3) opaque_exception_check();
        else check(array_property_error() == (opaque_mode < 4 ? '-' : 'T'),
            "opaque Set respects the first descriptor");
        check(opaque_commits == 0 && opaque_sets == (opaque_mode < 4 ? 1 : 0) &&
            opaque_value == (opaque_mode < 4 ? 9 : 1) && (opaque_mode >= 4 || opaque_this_ok),
            "opaque accessor owns its receiver and effects without an outer commit");
        if (opaque_mode == 3) check(!scr_dyn_has_own(opaque_prototype, opaque_key),
            "opaque setter survives deleting its own descriptor");
        if (!named && opaque_mode < 3) {
          ScrDyn *got = property_at(opaque_receiver, 2);
          if (opaque_mode == 1) {
            check(got == NULL, "borrowed read stops at the opaque getter failure");
            opaque_exception_check();
          } else check(got && got->kind == SCR_DYN_NUM && got->v.num == 9 && !scr_exc_pending(),
              "borrowed read observes the opaque getter value");
          check(opaque_gets == 1 && opaque_this_ok && opaque_commits == 0,
              "borrowed getter keeps the opaque receiver across refresh and failure");
          scr_dyn_release(got);
        }
        property_define(opaque_prototype, "0", 1);
        ScrStr *zero = S("0");
        property_sets = 0;
        scr_dyn_key_set(opaque_receiver, zero, value);
        check(!scr_exc_pending() && property_sets == 0 && opaque_commits == 1 && opaque_value == 9,
            "opaque own writable data shadows an inherited setter");
        opaque_materialize_fails = true;
        ScrDyn *got = property_at(opaque_receiver, 0);
        check(got == NULL, "borrowed read stops at failed materialization");
        opaque_exception_check();
        scr_dyn_release(got);
        scr_dyn_key_set(opaque_receiver, zero, value);
        opaque_exception_check();
        check(opaque_commits == 1, "failed materialization stops before mutation and commit");
        opaque_materialize_fails = false;
        scr_str_release(zero);
        scr_dyn_release(value);
        scr_dyn_release(descriptor);
        scr_dyn_release(key);
        scr_str_release(opaque_key);
        scr_dyn_release(opaque_receiver);
        scr_dyn_release(opaque_prototype);
        scr_dyn_release(opaque_marker);
        scr_str_release(owner);
      }
    }
  }
  opaque_receiver = opaque_prototype = opaque_marker = NULL;
  opaque_key = NULL;
  property_receiver = scr_dyn_new_arr();
  property_define(property_receiver, "own", 1);
  ScrStr *own = S("own");
  ScrDyn *value = scr_dyn_new_num(9);
  property_sets = 0;
  property_this_ok = true;
  scr_dyn_key_set(property_receiver, own, value);
  check(!scr_exc_pending() && property_sets == 1 && property_this_ok,
      "own named setter receives the array rather than its property table");
  scr_dyn_release(value);
  scr_str_release(own);
  scr_dyn_release(property_receiver);
  property_receiver = NULL;
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 2);
  scr_bytes_set(bytes, 1, 42);
  ScrDyn *capsule = scr_dyn_new_typed_ref(bytes, scr_bytes_retain_v, scr_bytes_release_v,
      "bytes", 5, borrow_bytes_materialize, NULL);
  ScrDyn *got = property_at(capsule, 1);
  check(got && got->kind == SCR_DYN_NUM && got->v.num == 42 && !scr_exc_pending(),
      "borrowed reads preserve byte-view indexed access");
  scr_dyn_release(got);
  scr_dyn_release(capsule);
  scr_bytes_release(bytes);
}

static ScrDyn *mutation_receiver, *mutation_marker;
static ScrArr *mutation_storage;
static int mutation_mode, mutation_order, mutation_calls;
static bool mutation_native;

static void mutation_length(double length) {
  ScrStr *key = S("length");
  ScrDyn *value = scr_dyn_new_num(length);
  scr_dyn_key_set(mutation_receiver, key, value);
  scr_dyn_release(value);
  scr_str_release(key);
}
static void mutation_freeze(void) {
  if (mutation_native) scr_native_integrity_strengthen(mutation_storage, SCR_NATIVE_FROZEN);
  else scr_dyn_release(scr_dyn_freeze(mutation_receiver));
}
static void mutation_throw(void) { scr_dyn_throw(scr_dyn_retain(mutation_marker)); }
static void mutation_exception(void) {
  check(scr_exc_pending(), "compound callback exception remains pending");
  ScrCaught *caught = scr_exc_take();
  ScrDyn *value = scr_caught_to_dyn(caught);
  check(value == mutation_marker, "compound mutation preserves exact thrown value");
  scr_dyn_release(value);
  scr_caught_release(caught);
}
static ScrDyn *mutation_start(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  mutation_order = mutation_order * 10 + 1;
  if (mutation_mode == 1) { mutation_throw(); return NULL; }
  mutation_length(1);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(1);
}
static ScrDyn *mutation_end(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  mutation_order = mutation_order * 10 + 2;
  return scr_dyn_new_num(3);
}
static ScrDyn *mutation_getter(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  mutation_calls++;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == mutation_receiver, "compound getter keeps original receiver");
  scr_dyn_release(receiver);
  if (mutation_mode == 3) { mutation_throw(); return NULL; }
  ScrStr *key = S("1");
  scr_dyn_key_delete(mutation_receiver, key, true);
  scr_str_release(key);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(7);
}
static ScrDyn *mutation_setter(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  mutation_calls++;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == mutation_receiver && argc == 1, "compound setter keeps receiver and argument");
  scr_dyn_release(receiver);
  if (mutation_mode == 4) check(args[0] == mutation_marker, "push setter receives owned argument");
  else {
    check(args[0]->kind == SCR_DYN_NUM && args[0]->v.num == 3, "unshift moves by full argument count");
    mutation_freeze();
  }
  return scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *mutation_compare_value(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  mutation_freeze();
  return scr_dyn_new_num(-1);
}
static ScrDyn *mutation_coercion(ScrDynThunk thunk) {
  ScrDyn *value = scr_dyn_new_obj();
  scr_dyn_obj_set(value, "valueOf", 7, scr_dyn_new_func(scr_closure_new(NULL, 0),
      thunk, 0, "mutation coercion", "mutation_coercion"));
  return value;
}
static double mutation_rank(ScrDyn *value) {
  return value->kind == SCR_DYN_NUM ? value->v.num : scr_dyn_obj_get(value, "rank", 4)->v.num;
}
static ScrDyn *mutation_compare(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  mutation_calls++;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver->kind == SCR_DYN_UNDEF && argc == 2, "sort comparator this is undefined");
  scr_dyn_release(receiver);
  if (mutation_mode == 6 && mutation_calls == 1) mutation_length(0);
  if (mutation_mode == 8 && mutation_calls == 2) { mutation_throw(); return NULL; }
  if (mutation_mode == 7) return mutation_coercion(mutation_compare_value);
  return scr_dyn_new_num(mutation_rank(args[0]) - mutation_rank(args[1]));
}
static void mutation_setup(bool native, size_t len, unsigned presence) {
  mutation_native = native;
  mutation_order = mutation_calls = 0;
  mutation_storage = scr_arr_new(SCR_ELEM_F64, len);
  scr_arr_set_len(mutation_storage, (double)len);
  for (size_t i = 0; i < len; i++)
    if (presence & (1u << i)) scr_arr_set_f64(mutation_storage, (double)i, 3 - (double)i);
  mutation_receiver = native ? scr_dyn_new_typed_ref(mutation_storage, scr_arr_retain_v,
      scr_arr_release_v, "array<f64>", 10, live_array_materialize, NULL)
      : live_array_materialize(mutation_storage);
  if (native) scr_dyn_typed_ref_bind_array(mutation_receiver, &live_array_ops);
  mutation_marker = scr_dyn_new_obj();
}
static void mutation_cleanup(void) {
  scr_dyn_release(mutation_receiver);
  scr_dyn_release(mutation_marker);
  scr_arr_release(mutation_storage);
  mutation_receiver = mutation_marker = NULL;
  mutation_storage = NULL;
  scr_collect_cycles();
}
static void mutation_descriptor(const char *index, bool setter) {
  ScrDyn *prototype = scr_dyn_new_obj(), *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, setter ? "set" : "get", 3,
      scr_dyn_new_func(scr_closure_new(NULL, 0), setter ? mutation_setter : mutation_getter,
          setter, "mutation accessor", "mutation_accessor"));
  ScrStr *text = S(index);
  ScrDyn *key = scr_dyn_new_str(text);
  scr_dyn_release(scr_dyn_define_property(prototype, key, descriptor));
  scr_dyn_release(scr_dyn_set_prototype(mutation_receiver, prototype));
  scr_dyn_release(descriptor); scr_dyn_release(prototype);
  scr_dyn_release(key); scr_str_release(text);
}
static void mutation_value(size_t index, double expected) {
  ScrDyn *value = property_at(mutation_receiver, (double)index);
  check(value && mutation_rank(value) == expected, "compound mutation retains expected native value");
  scr_dyn_release(value);
}
static ScrDyn *mutation_call(const char *method, ScrDyn *const *args, size_t argc) {
  ScrStr *name = S(method);
  ScrDyn *pack = scr_dyn_new_arr();
  for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(pack, scr_dyn_retain(args[i]));
  ScrDyn *result = scr_dyn_array_proto_call(mutation_receiver, name, pack);
  scr_dyn_release(pack); scr_str_release(name);
  return result;
}
static void compound_mutation_callback_tests(void) {
  for (int native = 0; native < 2; native++) {
    for (mutation_mode = 0; mutation_mode < 2; mutation_mode++) {
      mutation_setup(native, 3, 7);
      ScrDyn *args[] = {scr_dyn_new_num(9), mutation_coercion(mutation_start), mutation_coercion(mutation_end)};
      ScrDyn *result = mutation_call("fill", args, 3);
      if (mutation_mode == 1) {
        check(result == NULL && mutation_order == 1, "failed start suppresses end coercion and stores");
        mutation_exception();
        mutation_value(1, 2);
      } else {
        check(result == mutation_receiver && mutation_order == 12, "fill captures length before ordered coercions");
        mutation_value(0, 3); mutation_value(1, 9); mutation_value(2, 9);
      }
      scr_dyn_release(result);
      for (size_t i = 0; i < 3; i++) scr_dyn_release(args[i]);
      mutation_cleanup();
    }
    mutation_mode = 2; mutation_setup(native, 2, 2);
    mutation_descriptor("0", false);
    ScrDyn *result = mutation_call("reverse", NULL, 0);
    ScrStr *zero = S("0");
    check(result == mutation_receiver && mutation_calls == 1 &&
        !scr_dyn_has_own(mutation_receiver, zero), "reverse interleaves lower Get before upper Has");
    mutation_value(1, 7);
    scr_str_release(zero); scr_dyn_release(result); mutation_cleanup();

    mutation_mode = 3; mutation_setup(native, 4, 11);
    if (!native) {
      ScrDyn *cycle = scr_dyn_new_arr();
      scr_dyn_arr_push(cycle, scr_dyn_retain(cycle));
      ScrStr *key = S("0");
      scr_dyn_key_set(mutation_receiver, key, cycle);
      scr_str_release(key); scr_dyn_release(cycle);
    }
    mutation_descriptor("2", false);
    ScrDyn *splice_args[] = {scr_dyn_new_num(0), scr_dyn_new_num(1)};
    result = mutation_call("splice", splice_args, 2);
    check(result == NULL && mutation_calls == 1, "splice stops after an earlier successful move");
    mutation_exception(); mutation_value(0, 2); mutation_value(1, 2);
    check((native ? mutation_storage->len : mutation_receiver->v.arr.len) == 4,
        "failed splice does not perform final length Set");
    scr_dyn_release(splice_args[0]); scr_dyn_release(splice_args[1]); scr_dyn_release(result);
    mutation_cleanup();

    mutation_mode = 4; mutation_setup(native, 0, 0);
    mutation_descriptor("0", true); mutation_freeze();
    ScrDyn *push_args[] = {mutation_marker};
    result = mutation_call("push", push_args, 1);
    check(result == NULL && array_property_error() == 'T' && mutation_calls == 1,
        "push calls inherited setter before frozen length failure");
    scr_dyn_release(result); mutation_cleanup();

    mutation_mode = 5; mutation_setup(native, 2, 1);
    mutation_descriptor("2", true);
    ScrDyn *unshift_args[] = {scr_dyn_new_num(9), scr_dyn_new_num(8)};
    result = mutation_call("unshift", unshift_args, 2);
    check(result == NULL && array_property_error() == 'T' && mutation_calls == 1,
        "unshift observes restrictions introduced by a setter");
    mutation_value(0, 3);
    check((native ? mutation_storage->len : mutation_receiver->v.arr.len) == 2,
        "unshift failure preserves original length");
    scr_dyn_release(unshift_args[0]); scr_dyn_release(unshift_args[1]); scr_dyn_release(result);
    mutation_cleanup();

    for (mutation_mode = 6; mutation_mode <= 8; mutation_mode++) {
      mutation_setup(native, 3, 7);
      if (!native) for (size_t i = 0; i < 3; i++) {
        ScrDyn *item = scr_dyn_new_obj();
        scr_dyn_obj_set(item, "rank", 4, scr_dyn_new_num(3 - (double)i));
        scr_dyn_obj_set(item, "self", 4, scr_dyn_retain(item));
        char text[2] = {(char)('0' + i), 0};
        ScrStr *key = S(text);
        scr_dyn_key_set(mutation_receiver, key, item);
        scr_str_release(key); scr_dyn_release(item);
      }
      ScrDyn *cmp = scr_dyn_new_func(scr_closure_new(NULL, 0), mutation_compare, 2,
          "mutation comparator", "mutation_compare");
      result = mutation_call("sort", &cmp, 1);
      if (mutation_mode == 6) {
        check(result == mutation_receiver && !scr_exc_pending(), "sort restores collected values after comparator truncation");
        mutation_value(0, 1); mutation_value(1, 2); mutation_value(2, 3);
      } else {
        check(result == NULL, "sort stops on callback or writeback failure");
        if (mutation_mode == 8) mutation_exception();
        else check(array_property_error() == 'T', "sort rereads frozen state after comparator-result coercion");
        mutation_value(0, 3); mutation_value(1, 2); mutation_value(2, 1);
      }
      scr_dyn_release(result); scr_dyn_release(cmp); mutation_cleanup();
    }
  }
}

static int function_array_gets, function_array_sets;
static double function_array_written;
static ScrDyn *function_array_get(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  function_array_gets++;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == mutation_receiver, "function array getter preserves receiver");
  scr_dyn_release(receiver);
  return scr_dyn_new_num(7);
}
static ScrDyn *function_array_set(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  function_array_sets++;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == mutation_receiver && argc == 1, "function array setter preserves receiver");
  scr_dyn_release(receiver);
  function_array_written = args[0]->v.num;
  return scr_dyn_retain(scr_dyn_undefined());
}
static void function_array_mutation_tests(void) {
  const char *methods[] = {"reverse", "sort", "copyWithin"};
  for (size_t i = 0; i < 3; i++) {
    mutation_receiver = scr_dyn_new_func(scr_closure_new(NULL, 0),
        function_array_get, 2, "array-like function", "array_like");
    function_array_gets = function_array_sets = 0;
    function_array_written = 0;
    ScrStr *zero = S("0"), *one = S("1");
    ScrDyn *key = scr_dyn_new_str(zero), *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_new_func(scr_closure_new(NULL, 0),
        function_array_get, 0, "array getter", "array_get"));
    scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_new_func(scr_closure_new(NULL, 0),
        function_array_set, 1, "array setter", "array_set"));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    scr_dyn_release(scr_dyn_define_property(mutation_receiver, key, descriptor));
    ScrDyn *three = scr_dyn_new_num(3);
    scr_dyn_key_set(mutation_receiver, one, three);
    scr_dyn_release(three);
    ScrDyn *args[] = {scr_dyn_new_num(1), scr_dyn_new_num(0), scr_dyn_new_num(1)};
    ScrDyn *result = mutation_call(methods[i], args, i == 2 ? 3 : 0);
    check(result == mutation_receiver && !scr_exc_pending(), "borrowed function mutation succeeds");
    check(function_array_gets == 1, "function Has does not invoke indexed getter");
    check(function_array_sets == (i == 2 ? 0 : 1) &&
        (i == 2 || function_array_written == 3), "function mutation writes expected indexed value");
    ScrDyn *last = scr_dyn_fn_get(mutation_receiver, "1", 1);
    check(last && last->kind == SCR_DYN_NUM && last->v.num == 7,
        "function mutation moves collected value");
    scr_dyn_release(last); scr_dyn_release(result);
    for (size_t j = 0; j < 3; j++) scr_dyn_release(args[j]);
    scr_dyn_release(key); scr_dyn_release(descriptor);
    scr_str_release(zero); scr_str_release(one); scr_dyn_release(mutation_receiver);
  }
  mutation_receiver = scr_dyn_new_func(scr_closure_new(NULL, 0),
      function_array_get, 2, "array-like function", "array_like");
  ScrDyn *prototype = scr_dyn_new_obj();
  scr_dyn_release(scr_dyn_set_prototype(mutation_receiver, prototype));
  ScrStr *one = S("1"), *zero = S("0");
  ScrDyn *three = scr_dyn_new_num(3);
  scr_dyn_key_set(mutation_receiver, one, three);
  ScrDyn *result = mutation_call("reverse", NULL, 0);
  check(result == mutation_receiver && !scr_exc_pending() &&
      !scr_dyn_has_own(mutation_receiver, one), "function prototype miss remains a hole");
  ScrDyn *first = scr_dyn_fn_get(mutation_receiver, "0", 1);
  check(first && first->kind == SCR_DYN_NUM && first->v.num == 3,
      "function reverse moves present upper value");
  scr_dyn_release(first); scr_dyn_release(result); scr_dyn_release(three);
  scr_dyn_release(prototype); scr_str_release(one); scr_str_release(zero);
  scr_dyn_release(mutation_receiver); mutation_receiver = NULL;
}

static ScrDyn *large_arraylike_view(void *owner) {
  (void)owner;
  ScrDyn *view = scr_dyn_new_obj();
  scr_dyn_obj_set(view, "length", 6, scr_dyn_new_num(9007199254740990.0));
  return view;
}
static ScrDyn *large_arraylike(int kind) {
  if (kind == 3) {
    ScrStr *owner = S("array-like owner");
    ScrDyn *value = scr_dyn_new_typed_ref(owner, view_retain, view_release,
        "record:large", 12, large_arraylike_view, NULL);
    scr_str_release(owner);
    return value;
  }
  ScrDyn *value = large_arraylike_view(NULL);
  if (kind == 0) return value;
  if (kind == 2) {
    ScrDyn *handler = scr_dyn_new_obj(), *proxy = scr_dyn_proxy_new(value, handler);
    scr_dyn_release(handler); scr_dyn_release(value);
    return proxy;
  }
  scr_dyn_release(value);
  value = scr_dyn_new_func(scr_closure_new(NULL, 0), function_array_get, 2,
      "large array-like function", "large_array_like");
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(9007199254740990.0));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  ScrStr *name = S("length");
  ScrDyn *key = scr_dyn_new_str(name);
  scr_dyn_release(scr_dyn_define_property(value, key, descriptor));
  scr_dyn_release(descriptor); scr_dyn_release(key); scr_str_release(name);
  return value;
}
static void array_scan_refused(ScrDyn *result) {
  check(result == NULL && scr_exc_pending(), "generic array-like scan refuses fabricated range");
  ScrCaught *caught = scr_exc_take();
  ScrStr *message = caught ? scr_caught_to_string(caught) : NULL;
  check(str_is(message, "Error: array-like iteration over one million entries is not supported yet"),
      "generic array-like scan keeps the named iteration refusal");
  scr_str_release(message); scr_caught_release(caught); scr_dyn_release(result);
}
static ScrDyn *array_scan_end(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo; (void)args; (void)argc;
  mutation_order = mutation_order * 10 + 2;
  return scr_dyn_new_num(9007199254740990.0);
}
static void array_mutation_scan_tests(void) {
  const char *methods[] = {"reverse", "sort", "shift", "unshift", "fill", "copyWithin", "splice"};
  const double arguments[][2] = {{0}, {0}, {0}, {9}, {9}, {1, 0}, {0, 1}};
  const size_t counts[] = {0, 0, 0, 1, 1, 2, 2};
  for (int kind = 0; kind < 4; kind++) for (size_t i = 0; i < 7; i++) {
    mutation_receiver = large_arraylike(kind);
    ScrDyn *args[] = {scr_dyn_new_num(arguments[i][0]), scr_dyn_new_num(arguments[i][1])};
    array_scan_refused(mutation_call(methods[i], args, counts[i]));
    scr_dyn_release(args[0]); scr_dyn_release(args[1]); scr_dyn_release(mutation_receiver);
  }
  const char *small_methods[] = {"push", "unshift", "fill", "copyWithin", "splice", "splice", "pop"};
  const double small_arguments[][3] = {{0}, {0}, {9, 8, 2}, {0, 7, 2}, {0}, {0, 1, 9}, {0}};
  const size_t small_counts[] = {0, 0, 3, 3, 0, 3, 0};
  for (size_t i = 0; i < 7; i++) {
    mutation_receiver = large_arraylike(0);
    ScrDyn *args[3];
    for (size_t j = 0; j < 3; j++) args[j] = scr_dyn_new_num(small_arguments[i][j]);
    ScrDyn *result = mutation_call(small_methods[i], args, small_counts[i]);
    check(result && !scr_exc_pending(), "huge array-like length allows bounded or empty mutation");
    if (i < 2) check(result && result->kind == SCR_DYN_NUM && result->v.num == 9007199254740990.0,
        "zero-argument growth preserves huge length");
    if (i == 5) {
      ScrDyn *first = scr_dyn_obj_get(mutation_receiver, "0", 1);
      check(result && result->kind == SCR_DYN_ARR && result->v.arr.len == 1 &&
          !scr_dyn_arr_has_index(result, 0) && first && first->v.num == 9,
          "equal-count splice has no fabricated tail scan");
    }
    if (i == 6) check(scr_dyn_obj_get(mutation_receiver, "length", 6)->v.num == 9007199254740989.0,
        "pop only visits the last property");
    scr_dyn_release(result);
    for (size_t j = 0; j < 3; j++) scr_dyn_release(args[j]);
    scr_dyn_release(mutation_receiver);
  }
  for (mutation_mode = 0; mutation_mode < 2; mutation_mode++) {
    mutation_receiver = large_arraylike(0); mutation_marker = scr_dyn_new_obj();
    mutation_order = 0;
    ScrDyn *args[] = {scr_dyn_new_num(9), mutation_coercion(mutation_start), mutation_coercion(array_scan_end)};
    ScrDyn *result = mutation_call("fill", args, 3);
    if (mutation_mode == 0) {
      array_scan_refused(result);
      check(mutation_order == 12 && scr_dyn_obj_get(mutation_receiver, "length", 6)->v.num == 1,
          "scan admission follows ordered coercions and preserves their effects");
    } else {
      check(result == NULL && mutation_order == 1, "coercion exception precedes scan admission");
      mutation_exception(); scr_dyn_release(result);
    }
    for (size_t j = 0; j < 3; j++) scr_dyn_release(args[j]);
    scr_dyn_release(mutation_receiver); scr_dyn_release(mutation_marker);
  }
  for (int throwing = 0; throwing < 2; throwing++) for (int splice = 0; splice < 2; splice++) {
    mutation_receiver = large_arraylike(0); mutation_marker = scr_dyn_new_obj();
    mutation_mode = 3; mutation_calls = 0;
    if (throwing) mutation_descriptor("0", false);
    else {
      ScrDyn *cycle = scr_dyn_new_arr();
      scr_dyn_arr_push(cycle, scr_dyn_retain(cycle));
      scr_dyn_obj_set(mutation_receiver, "0", 1, cycle);
    }
    ScrDyn *args[] = {scr_dyn_new_num(0), scr_dyn_new_num(1)};
    ScrDyn *result = mutation_call(splice ? "splice" : "shift", args, splice ? 2 : 0);
    if (throwing) {
      check(result == NULL && mutation_calls == 1, "first removal getter throws before tail admission");
      mutation_exception(); scr_dyn_release(result);
    } else array_scan_refused(result);
    scr_dyn_release(args[0]); scr_dyn_release(args[1]);
    scr_dyn_release(mutation_receiver); scr_dyn_release(mutation_marker);
    scr_collect_cycles();
  }
  for (int native = 0; native < 2; native++) {
    ScrArr *owner = native ? scr_arr_new(SCR_ELEM_F64, 1000001) : NULL;
    if (native) scr_arr_set_len(owner, 1000001);
    mutation_receiver = native ? scr_dyn_new_typed_ref(owner, scr_arr_retain_v,
        scr_arr_release_v, "array<f64>", 10, live_array_materialize, NULL) : scr_dyn_new_arr();
    if (native) scr_dyn_typed_ref_bind_array(mutation_receiver, &live_array_ops);
    else for (size_t i = 0; i < 1000001; i++) scr_dyn_arr_push_hole(mutation_receiver);
    ScrDyn *result = mutation_call("fill", NULL, 0);
    check(result == mutation_receiver && !scr_exc_pending(), "backed array mutation exceeds generic scan bound");
    check(native ? scr_arr_state(owner, 1000000) == SCR_ARR_UNDEFINED
        : scr_dyn_arr_has_index(mutation_receiver, 1000000), "backed fill reaches final slot");
    scr_dyn_release(result); scr_dyn_release(mutation_receiver);
    if (native) scr_arr_release(owner);
  }
  mutation_receiver = mutation_marker = NULL;
}

static void opaque_compound_mutation_tests(void) {
  for (opaque_shape = 0; opaque_shape < 2; opaque_shape++) {
    ScrStr *owner = S("opaque mutation owner");
    opaque_value = 1;
    opaque_gets = opaque_sets = opaque_commits = 0;
    opaque_mode = 6;
    opaque_this_ok = false;
    opaque_receiver = scr_dyn_new_typed_ref(owner, view_retain, view_release,
        "record:opaque", 13, opaque_materialize, opaque_commit);
    opaque_prototype = scr_dyn_new_obj();
    opaque_marker = scr_dyn_new_obj();
    opaque_key = S("1");
    ScrDyn *key = scr_dyn_new_str(opaque_key), *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_new_func(scr_closure_new(NULL, 0),
        opaque_setter, 1, "opaque setter", "opaque_setter"));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    scr_dyn_release(scr_dyn_define_property(opaque_prototype, key, descriptor));
    scr_dyn_release(scr_dyn_set_prototype(opaque_receiver, opaque_prototype));
    ScrDyn *args = scr_dyn_new_arr();
    scr_dyn_arr_push(args, scr_dyn_new_num(9));
    ScrStr *name = S("fill");
    ScrDyn *result = scr_dyn_array_proto_call(opaque_receiver, name, args);
    check(result == NULL && opaque_commits == 1 && opaque_value == 9 &&
        opaque_sets == 1 && opaque_this_ok, "opaque mutation commits each successful property before callback failure");
    opaque_exception_check();
    check(!scr_dyn_has_own(opaque_prototype, opaque_key), "opaque compound setter survives refresh and self-removal");
    scr_dyn_release(result); scr_dyn_release(args); scr_str_release(name);
    scr_dyn_release(key); scr_dyn_release(descriptor); scr_str_release(opaque_key);
    scr_dyn_release(opaque_receiver); scr_dyn_release(opaque_prototype); scr_dyn_release(opaque_marker);
    scr_str_release(owner);
  }
  opaque_receiver = opaque_prototype = opaque_marker = NULL;
  opaque_key = NULL;
  ScrDyn *array = scr_dyn_new_arr();
  ScrStr *bmp = S("\xEE\x80\x80"), *astral = S("\xF0\x90\x80\x80");
  scr_dyn_arr_push(array, scr_dyn_new_str(bmp));
  scr_dyn_arr_push(array, scr_dyn_new_str(astral));
  ScrDyn *result = scr_dyn_invoke(array, "sort", NULL, 0, "sort");
  check(result == array && !scr_exc_pending() && array->v.arr.items[0]->v.str == astral,
      "default sort compares UTF-16 units across the surrogate boundary");
  scr_dyn_release(result); scr_dyn_release(array); scr_str_release(bmp); scr_str_release(astral);
}

static void array_prototype_chain_tests(void) {
  for (int native = 0; native < 2; native++) {
    for (int native_proto = 0; native_proto < 2; native_proto++) {
      for (int function_link = 0; function_link < 2; function_link++) {
        for (int frozen = 0; frozen < 2; frozen++) {
          ScrArr *storage = scr_arr_new(SCR_ELEM_F64, 1);
          scr_arr_set_len(storage, 1);
          ScrDyn *receiver = native ? scr_dyn_new_typed_ref(storage, scr_arr_retain_v,
              scr_arr_release_v, "array<f64>", 10, live_array_materialize, NULL)
              : live_array_materialize(storage);
          if (native) scr_dyn_typed_ref_bind_array(receiver, &live_array_ops);
          ScrArr *parent_storage = scr_arr_new(SCR_ELEM_F64, 1);
          scr_arr_push_f64(parent_storage, 41);
          ScrDyn *parent = native_proto ? scr_dyn_new_typed_ref(parent_storage, scr_arr_retain_v,
              scr_arr_release_v, "array<f64>", 10, live_array_materialize, NULL)
              : live_array_materialize(parent_storage);
          if (native_proto) scr_dyn_typed_ref_bind_array(parent, &live_array_ops);
          if (frozen) {
            if (native_proto) scr_native_integrity_strengthen(parent_storage, SCR_NATIVE_FROZEN);
            else scr_dyn_release(scr_dyn_freeze(parent));
          }
          ScrDyn *link = function_link ? scr_dyn_new_func(scr_closure_new(NULL, 0),
              property_getter, 0, "prototype link", "prototype_link") : scr_dyn_new_obj();
          scr_dyn_release(scr_dyn_set_prototype(link, parent));
          scr_dyn_release(scr_dyn_set_prototype(receiver, link));
          check(!scr_exc_pending(), "mixed array prototype chain setup");
          ScrStr *zero = S("0");
          check(scr_dyn_has_key(receiver, zero), "Has follows object/function links to array elements");
          ScrDyn *got = property_at(receiver, 0);
          check(got && got->kind == SCR_DYN_NUM && got->v.num == 41,
              "Get follows object/function links to array elements");
          scr_dyn_release(got);
          ScrDyn *value = scr_dyn_new_num(9);
          scr_dyn_key_set(receiver, zero, value);
          check(array_property_error() == (frozen ? 'T' : '-') &&
              scr_dyn_has_own(receiver, zero) == !frozen,
              "Set observes inherited array descriptor through object/function links");
          scr_dyn_release(value);
          scr_str_release(zero);
          scr_dyn_release(receiver);
          scr_dyn_release(link);
          scr_dyn_release(parent);
          scr_arr_release(storage);
          scr_arr_release(parent_storage);
        }
      }
    }
  }
}

static ScrDyn *property_callback_prototype, *property_callback_marker;
static size_t property_materializations_at_throw;
static ScrDyn *property_callback_failure(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == property_receiver, "throwing accessor receives original identity");
  scr_dyn_release(receiver);
  ScrStr *key = S("0");
  scr_dyn_key_delete(property_callback_prototype, key, true);
  scr_str_release(key);
  property_materializations_at_throw = live_array_materializations;
  scr_dyn_throw(scr_dyn_retain(property_callback_marker));
  return NULL;
}

static void array_prototype_callback_tests(void) {
  for (int native = 0; native < 2; native++) {
    for (int route = 0; route < 4; route++) {
      ScrArr *arr = scr_arr_new(SCR_ELEM_F64, 1);
      scr_arr_set_len(arr, 1);
      property_receiver = native ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
          "array<f64>", 10, live_array_materialize, NULL) : live_array_materialize(arr);
      if (native) scr_dyn_typed_ref_bind_array(property_receiver, &live_array_ops);
      property_callback_prototype = scr_dyn_new_obj();
      property_callback_marker = scr_dyn_new_obj();
      ScrDyn *descriptor = scr_dyn_new_obj();
      scr_dyn_obj_set(descriptor, route == 3 ? "set" : "get", 3,
          scr_dyn_new_func(scr_closure_new(NULL, 0), property_callback_failure, route == 3,
              "remove and throw", "property_callback_failure"));
      scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
      ScrStr *key = S("0");
      ScrDyn *name = scr_dyn_new_str(key);
      scr_dyn_release(scr_dyn_define_property(property_callback_prototype, name, descriptor));
      scr_dyn_release(name);
      scr_dyn_release(descriptor);
      scr_dyn_release(scr_dyn_set_prototype(property_receiver, property_callback_prototype));
      live_array_materializations = 0;
      ScrDyn *result = NULL;
      if (route == 0) result = native ? scr_dyn_typed_ref_key_get(property_receiver, key)
          : scr_dyn_arr_named_get(property_receiver, key);
      else if (route == 1) result = property_at(property_receiver, 0);
      else if (route == 2)
        result = scr_json_stringify_value(property_receiver, scr_dyn_undefined(), scr_dyn_undefined());
      else {
        ScrDyn *value = scr_dyn_new_num(9);
        scr_dyn_key_set(property_receiver, key, value);
        scr_dyn_release(value);
      }
      check(!result && scr_exc_pending(), "accessor failure stops the property operation");
      scr_dyn_release(result);
      ScrCaught *caught = scr_exc_take();
      ScrDyn *thrown = scr_caught_to_dyn(caught);
      check(thrown == property_callback_marker &&
          live_array_materializations == property_materializations_at_throw,
          "accessor exception keeps exact payload without a later snapshot");
      scr_dyn_release(thrown);
      scr_caught_release(caught);
      check(!scr_dyn_has_own(property_callback_prototype, key),
          "accessor survives removing its own descriptor");
      scr_str_release(key);
      scr_dyn_release(property_receiver);
      scr_dyn_release(property_callback_prototype);
      scr_dyn_release(property_callback_marker);
      property_receiver = property_callback_prototype = property_callback_marker = NULL;
      scr_arr_release(arr);
    }
  }
}

static void live_array_ref_tests(void) {
  ScrArr *arr = scr_arr_new(SCR_ELEM_F64, 4);
  for (int i = 0; i < 4; i++) scr_arr_push_f64(arr, i * 10);
  scr_arr_delete(arr, 2);
  ScrDyn *capsule = scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
      "array<f64>", 10, live_array_materialize, NULL);
  scr_dyn_typed_ref_bind_array(capsule, &live_array_ops);
  live_array_materializations = 0;

  ScrStr *length = S("length"), *one = S("1"), *two = S("2"), *four = S("4"), *five = S("5"), *lead = S("01");
  ScrDyn *got = scr_dyn_typed_ref_key_get(capsule, length);
  check(got && got->kind == SCR_DYN_NUM && got->v.num == 4, "live array length");
  scr_dyn_release(got);
  got = scr_dyn_typed_ref_key_get(capsule, one);
  check(got && got->kind == SCR_DYN_NUM && got->v.num == 10, "live array element");
  scr_dyn_release(got);
  got = scr_dyn_typed_ref_key_get(capsule, two);
  check(got && got->kind == SCR_DYN_UNDEF, "live array hole resolves without the view");
  scr_dyn_release(got);
  got = scr_dyn_typed_ref_key_get(capsule, four);
  check(got && got->kind == SCR_DYN_UNDEF, "live array past length resolves without the view");
  scr_dyn_release(got);
  got = scr_dyn_typed_ref_key_get(capsule, lead);
  check(got && got->kind == SCR_DYN_UNDEF && !scr_exc_pending(), "missing named property returns owned undefined");
  scr_dyn_release(got);
  check(scr_dyn_has_key(capsule, one) && scr_dyn_has_own(capsule, one) && scr_dyn_has_own(capsule, length),
      "live array own presence");
  check(!scr_dyn_has_own(capsule, two) && !scr_dyn_has_own(capsule, four), "live array own absence");
  check(live_array_materializations == 0, "live array reads never materialize");

  ScrDyn *value = scr_dyn_new_num(7);
  scr_dyn_key_set(capsule, one, value);
  scr_dyn_key_set(capsule, two, value);
  scr_dyn_key_set(capsule, four, value);
  scr_dyn_release(value);
  check(arr->len == 5 && scr_arr_get_f64(arr, 1) == 7 && scr_arr_get_f64(arr, 2) == 7 &&
      scr_arr_get_f64(arr, 4) == 7, "live array writes and appends land natively");
  check(live_array_materializations == 0, "live array writes never materialize");

  ScrDyn *text = scr_dyn_new_str(one);
  scr_dyn_key_set(capsule, one, text);
  scr_dyn_release(text);
  check(array_property_error() == 'T' && live_array_materializations == 0 &&
      scr_arr_get_f64(arr, 1) == 7, "rejected value fails at its own native write");
  ScrStr *seven = S("7");
  value = scr_dyn_new_num(1);
  scr_dyn_key_set(capsule, seven, value);
  scr_dyn_release(value);
  check(live_array_materializations == 0 && arr->len == 8 &&
      scr_arr_get_f64(arr, 7) == 1, "growth past length stores directly with holes");
  check(!scr_dyn_has_key(capsule, five) && live_array_materializations == 0,
      "absent index resolves without the view");
  check(!scr_exc_pending(), "live array operations need no commit");

  scr_arr_ext(arr)->metadata = scr_dyn_new_obj();
  scr_dyn_obj_set(arr->ext->metadata, "index", 5, scr_dyn_new_num(2));
  scr_dyn_obj_set(arr->ext->metadata, "input", 5, scr_dyn_new_str(one));
  ScrStr *index = S("index"), *input = S("input");
  check(scr_dyn_has_key(capsule, index) && scr_dyn_has_key(capsule, input),
      "native named metadata retains its materialized Has path");
  scr_str_release(index);
  scr_str_release(input);

  scr_str_release(length); scr_str_release(one); scr_str_release(two);
  scr_str_release(four); scr_str_release(five); scr_str_release(seven); scr_str_release(lead);
  scr_dyn_release(capsule);
  scr_arr_release(arr);
}

/* Live record capsules with bound field hooks answer reads, presence and
 * key walks from the native record; once a write creates the cached view,
 * every query goes through that view (which may hold added keys). */
typedef struct LiveRecord {
  size_t rc;
  double x;
  ScrStr *label; /* NULL: the optional field is absent */
} LiveRecord;
static size_t live_record_materializations;
static void *live_record_retain(void *value) { ((LiveRecord *)value)->rc++; return value; }
static void live_record_release(void *value) {
  LiveRecord *rec = value;
  if (--rec->rc) return;
  if (rec->label) scr_str_release(rec->label);
  free(rec);
}
static ScrDyn *live_record_materialize(void *value) {
  live_record_materializations++;
  LiveRecord *rec = value;
  ScrDyn *view = scr_dyn_new_obj();
  scr_dyn_obj_set(view, "x", 1, scr_dyn_new_num(rec->x));
  if (rec->label) scr_dyn_obj_set(view, "label", 5, scr_dyn_new_str(rec->label));
  return view;
}
static bool live_record_has(void *value, size_t index) {
  return index == 0 || ((LiveRecord *)value)->label != NULL;
}
static ScrDyn *live_record_get(void *value, size_t index) {
  LiveRecord *rec = value;
  return index == 0 ? scr_dyn_new_num(rec->x) : scr_dyn_new_str(rec->label);
}

static bool dyn_keys_are(const ScrDyn *keys, const char *const *want, size_t n) {
  if (!keys || keys->kind != SCR_DYN_ARR || keys->v.arr.len != n) return false;
  for (size_t i = 0; i < n; i++) {
    const ScrDyn *key = keys->v.arr.items[i];
    if (key->kind != SCR_DYN_STR || !str_is(key->v.str, want[i])) return false;
  }
  return true;
}

static void live_record_ref_tests(void) {
  ScrStr *x = S("x"), *label = S("label"), *extra = S("extra"), *missing = S("missing");
  ScrStr *names[] = { x, label };
  const ScrDynTypedRecordOps ops = { 2, names, live_record_has, live_record_get };
  LiveRecord *rec = calloc(1, sizeof *rec);
  rec->rc = 1;
  rec->x = 3;
  ScrDyn *capsule = scr_dyn_new_typed_ref(rec, live_record_retain, live_record_release,
      "record:t", 8, live_record_materialize, NULL);
  scr_dyn_typed_ref_bind_record(capsule, &ops);
  live_record_materializations = 0;

  ScrDyn *got = scr_dyn_typed_ref_key_get(capsule, x);
  check(got && got->kind == SCR_DYN_NUM && got->v.num == 3, "live record field");
  scr_dyn_release(got);
  check(!scr_dyn_typed_ref_key_get(capsule, label), "absent optional field needs the view");
  check(!scr_dyn_typed_ref_key_get(capsule, missing), "unknown name needs the view");
  check(scr_dyn_has_key(capsule, x) && scr_dyn_has_own(capsule, x), "live record own presence");
  check(!scr_dyn_has_own(capsule, label) && !scr_dyn_has_own(capsule, missing),
      "live record own absence");
  check(scr_dyn_ref_typeof_is(capsule, "object") && !scr_dyn_ref_is_array(capsule),
      "live record is a plain object");
  const char *const only_x[] = { "x" };
  ScrDyn *keys = scr_dyn_for_in_keys(capsule);
  check(dyn_keys_are(keys, only_x, 1), "for-in skips the absent field");
  scr_dyn_release(keys);
  rec->label = S("p");
  const char *const both[] = { "x", "label" };
  keys = scr_dyn_obj_keys(capsule);
  check(dyn_keys_are(keys, both, 2), "keys follow the live record");
  scr_dyn_release(keys);
  ScrDyn *entries = scr_dyn_obj_entries(capsule);
  check(entries && entries->v.arr.len == 2 &&
      entries->v.arr.items[1]->v.arr.items[1]->kind == SCR_DYN_STR &&
      str_is(entries->v.arr.items[1]->v.arr.items[1]->v.str, "p"), "entries read live fields");
  scr_dyn_release(entries);
  ScrDyn *copy = scr_dyn_new_obj();
  ScrDyn *copied = scr_dyn_copy_data_properties(copy, capsule);
  check(copied == copy && copy->v.obj.len == 2, "spread copies present fields");
  scr_dyn_release(copied);
  scr_dyn_release(copy);
  ScrDyn *excluded = scr_dyn_new_arr();
  scr_dyn_arr_push(excluded, scr_dyn_new_str(x));
  ScrDyn *rest = scr_dyn_object_rest(capsule, excluded);
  check(rest && rest->v.obj.len == 1 && scr_dyn_obj_get(rest, "label", 5), "rest skips excluded fields");
  scr_dyn_release(rest);
  scr_dyn_release(excluded);
  check(live_record_materializations == 0, "live record reads never materialize");

  ScrDyn *value = scr_dyn_new_num(1);
  scr_dyn_key_set(capsule, extra, value);
  scr_dyn_release(value);
  check(live_record_materializations == 1, "an added key creates the view");
  const char *const with_extra[] = { "x", "label", "extra" };
  keys = scr_dyn_for_in_keys(capsule);
  check(dyn_keys_are(keys, with_extra, 3), "the view keeps the added key");
  scr_dyn_release(keys);
  got = scr_dyn_typed_ref_key_get(capsule, x);
  check(!got, "a viewed record reads through the view");
  check(scr_dyn_has_own(capsule, extra), "presence reads the view");
  check(!scr_exc_pending(), "live record queries raise nothing");

  scr_str_release(x); scr_str_release(label); scr_str_release(extra); scr_str_release(missing);
  scr_dyn_release(capsule);
  live_record_release(rec);
}

static ScrDyn *assign_source, *assign_target, *assign_symbol, *assign_added_symbol, *assign_marker;
static LiveRecord *assign_record;
static int assign_mode, assign_calls;
static double assign_symbol_value;
static int assign_symbol_commits;
static ScrDyn *assign_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == assign_target, "assign setter keeps original receiver");
  scr_dyn_release(receiver);
  assign_calls++;
  if (assign_record) assign_record->label = S("new");
  else if (assign_mode == 3) {
    ScrDyn *value = scr_dyn_new_num(9);
    scr_dyn_symbol_key_set(assign_source, assign_symbol, value);
    scr_dyn_symbol_key_set(assign_source, assign_added_symbol, value);
    ScrStr *name = S("later");
    ScrDyn *key = scr_dyn_new_str(name), *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
    scr_dyn_release(scr_dyn_define_property(assign_source, key, descriptor));
    scr_dyn_release(key); scr_dyn_release(descriptor); scr_str_release(name); scr_dyn_release(value);
  }
  else {
    ScrStr *key = S(assign_mode == 2 ? "2" : "1");
    if (assign_mode == 1) scr_dyn_key_delete(assign_source, key, true);
    else {
      ScrDyn *value = scr_dyn_new_num(9);
      scr_dyn_key_set(assign_source, key, value);
      scr_dyn_release(value);
    }
    scr_str_release(key);
  }
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *assign_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == assign_source, "copy getter keeps original function or array receiver");
  scr_dyn_release(receiver); assign_calls++;
  if (assign_mode == 10) { scr_dyn_throw(scr_dyn_retain(assign_marker)); return NULL; }
  return scr_dyn_new_num(9);
}
static ScrDyn *assign_symbol_materialize(void *owner) {
  (void)owner;
  ScrDyn *view = scr_dyn_new_obj(), *value = scr_dyn_new_num(assign_symbol_value);
  scr_dyn_symbol_key_set(view, assign_symbol, value);
  scr_dyn_release(value);
  return view;
}
static void assign_symbol_commit(void *owner, const ScrDyn *view) {
  (void)owner; assign_symbol_commits++;
  ScrDyn *value = scr_dyn_symbol_key_get(view, assign_symbol, false);
  if (value && value->kind == SCR_DYN_NUM) assign_symbol_value = value->v.num;
  scr_dyn_release(value);
}
static ScrDyn *assign_symbol_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == assign_target && argc == 1, "assign symbol setter keeps native receiver");
  scr_dyn_release(receiver); assign_calls++;
  if (argc) assign_symbol_value = args[0]->v.num;
  if (assign_mode == 10) { scr_dyn_throw(scr_dyn_retain(assign_marker)); return NULL; }
  return scr_dyn_retain(scr_dyn_undefined());
}
static void assign_install_setter(ScrDyn *target, const char *name) {
  ScrStr *text = S(name);
  ScrDyn *key = scr_dyn_new_str(text), *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_new_func(scr_closure_new(NULL, 0),
      assign_setter, 1, "assign setter", "assign_setter"));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_release(scr_dyn_define_property(target, key, descriptor));
  scr_dyn_release(descriptor); scr_dyn_release(key); scr_str_release(text);
}
static void object_assign_live_tests(void) {
  for (int native = 0; native < 2; native++) {
    for (int level = 0; level < 4; level++) {
      ScrArr *owner = scr_arr_new(SCR_ELEM_F64, 2);
      scr_arr_push_f64(owner, 1); scr_arr_push_f64(owner, 2);
      ScrDyn *target = native ? scr_dyn_new_typed_ref(owner, scr_arr_retain_v,
          scr_arr_release_v, "array<f64>", 10, live_array_materialize, NULL)
          : live_array_materialize(owner);
      if (native) {
        scr_dyn_typed_ref_bind_array(target, &live_array_ops);
        if (level) scr_native_integrity_strengthen(owner, level == 1 ? SCR_NATIVE_NON_EXTENSIBLE
            : level == 2 ? SCR_NATIVE_SEALED : SCR_NATIVE_FROZEN);
      } else if (level) scr_dyn_release(level == 1 ? scr_dyn_prevent_extensions(target)
          : level == 2 ? scr_dyn_seal(target) : scr_dyn_freeze(target));
      ScrDyn *source = scr_dyn_new_obj();
      scr_dyn_obj_set(source, "0", 1, scr_dyn_new_num(9));
      scr_dyn_obj_set(source, "2", 1, scr_dyn_new_num(8));
      ScrDyn *result = scr_dyn_assign(target, source);
      check(array_property_error() == (level ? 'T' : '-'), "assign enforces array target integrity");
      check(level ? result == NULL : result == target, "assign returns array identity or failure");
      check((native ? scr_arr_get_f64(owner, 0) : target->v.arr.items[0]->v.num) == (level == 3 ? 1 : 9),
          "assign retains successful array writes before failure");
      check((native ? owner->len : target->v.arr.len) == (level ? 2 : 3), "assign extends only permitted targets");
      scr_dyn_release(result); scr_dyn_release(source); scr_dyn_release(target); scr_arr_release(owner);
    }
    for (assign_mode = 0; assign_mode < 3; assign_mode++) {
      ScrArr *owner = scr_arr_new(SCR_ELEM_F64, 2);
      scr_arr_push_f64(owner, 1); scr_arr_push_f64(owner, 2);
      assign_source = native ? scr_dyn_new_typed_ref(owner, scr_arr_retain_v,
          scr_arr_release_v, "array<f64>", 10, live_array_materialize, NULL)
          : live_array_materialize(owner);
      if (native) scr_dyn_typed_ref_bind_array(assign_source, &live_array_ops);
      assign_target = scr_dyn_new_obj(); assign_calls = 0;
      assign_install_setter(assign_target, "0");
      live_array_materializations = 0;
      ScrDyn *result = scr_dyn_assign(assign_target, assign_source);
      check(result == assign_target && !scr_exc_pending() && assign_calls == 1,
          "assign reads array elements between target setters");
      const ScrDyn *second = scr_dyn_obj_get(assign_target, "1", 1);
      check(assign_mode == 1 ? second == NULL
          : second && second->kind == SCR_DYN_NUM && second->v.num == (assign_mode == 0 ? 9 : 2),
          "assign rereads later array presence and value");
      check(!scr_dyn_obj_get(assign_target, "2", 1), "assign snapshots keys before callbacks add an index");
      if (native) check(live_array_materializations == 1, "assign native array snapshots string keys once and reads symbols from the owner");
      scr_dyn_release(result); scr_dyn_release(assign_target); scr_dyn_release(assign_source); scr_arr_release(owner);
    }
  }
  for (opaque_shape = 0; opaque_shape < 2; opaque_shape++) {
    ScrStr *owner = S("assign opaque owner");
    opaque_value = 1; opaque_commits = opaque_sets = 0; opaque_mode = 6; opaque_this_ok = false;
    opaque_receiver = scr_dyn_new_typed_ref(owner, view_retain, view_release,
        "record:opaque", 13, opaque_materialize, opaque_commit);
    opaque_prototype = scr_dyn_new_obj(); opaque_marker = scr_dyn_new_obj(); opaque_key = S("1");
    ScrDyn *key = scr_dyn_new_str(opaque_key), *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_new_func(scr_closure_new(NULL, 0), opaque_setter,
        1, "opaque setter", "opaque_setter"));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    scr_dyn_release(scr_dyn_define_property(opaque_prototype, key, descriptor));
    scr_dyn_release(scr_dyn_set_prototype(opaque_receiver, opaque_prototype));
    ScrDyn *source = scr_dyn_new_obj();
    scr_dyn_obj_set(source, "0", 1, scr_dyn_new_num(9)); scr_dyn_obj_set(source, "1", 1, scr_dyn_new_num(8));
    ScrDyn *result = scr_dyn_assign(opaque_receiver, source);
    check(result == NULL && opaque_commits == 1 && opaque_sets == 1 && opaque_value == 8 && opaque_this_ok,
        "assign commits the successful prefix and preserves setter alias effects");
    if (scr_exc_pending()) opaque_exception_check();
    else check(false, "assign propagates opaque setter failure");
    scr_dyn_release(result); scr_dyn_release(source); scr_dyn_release(key); scr_dyn_release(descriptor);
    scr_dyn_release(opaque_receiver); scr_dyn_release(opaque_prototype); scr_dyn_release(opaque_marker);
    scr_str_release(opaque_key); scr_str_release(owner);
  }
  opaque_receiver = opaque_prototype = opaque_marker = NULL; opaque_key = NULL;
  ScrStr *x = S("x"), *label = S("label"); ScrStr *names[] = { x, label };
  const ScrDynTypedRecordOps ops = { 2, names, live_record_has, live_record_get };
  assign_record = calloc(1, sizeof *assign_record); assign_record->rc = 1; assign_record->x = 1;
  assign_source = scr_dyn_new_typed_ref(assign_record, live_record_retain, live_record_release,
      "record:assign", 13, live_record_materialize, NULL);
  scr_dyn_typed_ref_bind_record(assign_source, &ops);
  assign_target = scr_dyn_new_obj(); assign_calls = 0; assign_install_setter(assign_target, "x");
  live_record_materializations = 0;
  ScrDyn *result = scr_dyn_assign(assign_target, assign_source);
  check(result == assign_target && assign_calls == 1 && !scr_exc_pending(), "assign copies native record fields");
  check(!scr_dyn_obj_get(assign_target, "label", 5), "assign excludes optional fields created after key snapshot");
  check(live_record_materializations == 0, "assign record enumeration and reads avoid materialization");
  scr_dyn_release(result); scr_dyn_release(assign_source); scr_dyn_release(assign_target);
  live_record_release(assign_record); assign_record = NULL; assign_source = assign_target = NULL;
  scr_str_release(x); scr_str_release(label);

  for (int shape = 0; shape < 3; shape++) for (int spread = 0; spread < 2; spread++)
      for (int throwing = 0; throwing < 2; throwing++) {
    assign_source = shape == 0 ? scr_dyn_new_obj() : shape == 1
        ? scr_dyn_new_func(scr_closure_new(NULL, 0), assign_getter, 0, "source function", "source")
        : scr_dyn_new_arr();
    ScrStr *zero = S("0"), *later = S("later");
    ScrDyn *one = scr_dyn_new_num(1), *key = scr_dyn_new_str(later), *descriptor = scr_dyn_new_obj();
    scr_dyn_key_set(assign_source, zero, one);
    scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_new_func(scr_closure_new(NULL, 0),
        assign_getter, 0, "copy getter", "copy_getter"));
    scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
    scr_dyn_release(scr_dyn_define_property(assign_source, key, descriptor));
    assign_target = scr_dyn_new_obj(); assign_marker = scr_dyn_new_obj();
    assign_mode = throwing ? 10 : 0; assign_calls = 0;
    ScrDyn *copied = spread ? scr_dyn_copy_data_properties(assign_target, assign_source)
        : scr_dyn_assign(assign_target, assign_source);
    check(assign_calls == 1 && (throwing ? copied == NULL : copied == assign_target),
        "assign and spread read getters once in source order");
    check(scr_dyn_obj_get(assign_target, "0", 1) == one, "copy keeps its prefix before a later getter throws");
    if (throwing && scr_exc_pending()) {
      ScrCaught *caught = scr_exc_take(); ScrDyn *thrown = scr_caught_to_dyn(caught);
      check(thrown == assign_marker, "copy preserves exact source getter exception");
      scr_dyn_release(thrown); scr_caught_release(caught);
    } else check(!scr_exc_pending() && !throwing, "copy source getter exception status");
    scr_dyn_release(copied); scr_dyn_release(assign_marker); scr_dyn_release(assign_target);
    scr_dyn_release(assign_source); scr_dyn_release(descriptor); scr_dyn_release(key); scr_dyn_release(one);
    scr_str_release(zero); scr_str_release(later);
  }
  ScrSym *symbol = scr_sym_new(NULL), *added = scr_sym_new(NULL);
  assign_symbol = scr_dyn_new_symbol(symbol); assign_added_symbol = scr_dyn_new_symbol(added);
  scr_sym_release(symbol); scr_sym_release(added);
  assign_source = scr_dyn_new_obj(); assign_target = scr_dyn_new_obj();
  scr_dyn_obj_set(assign_source, "0", 1, scr_dyn_new_num(1));
  ScrStr *later = S("later");
  ScrDyn *key = scr_dyn_new_str(later), *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(2));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_release(scr_dyn_define_property(assign_source, key, descriptor));
  ScrDyn *value = scr_dyn_new_num(3); scr_dyn_symbol_key_set(assign_source, assign_symbol, value); scr_dyn_release(value);
  assign_mode = 3; assign_calls = 0; assign_install_setter(assign_target, "0");
  result = scr_dyn_assign(assign_target, assign_source);
  value = scr_dyn_symbol_key_get(assign_target, assign_symbol, false);
  check(result == assign_target && assign_calls == 1 && !scr_exc_pending(), "assign captures all key kinds before callbacks");
  check(value && value->kind == SCR_DYN_NUM && value->v.num == 9 &&
      !scr_dyn_has_own_computed(assign_target, assign_added_symbol), "assign rereads existing symbols and excludes added symbols");
  check(scr_dyn_obj_get(assign_target, "later", 5) != NULL, "assign rereads enumerability of initially hidden properties");
  scr_dyn_release(value); scr_dyn_release(result); scr_dyn_release(assign_source); scr_dyn_release(assign_target);
  scr_dyn_release(key); scr_dyn_release(descriptor); scr_str_release(later);

  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 2);
  scr_bytes_set(bytes, 0, 1); scr_bytes_set(bytes, 1, 2);
  assign_source = scr_dyn_new_bytes(bytes); assign_target = scr_dyn_new_obj();
  assign_mode = 0; assign_calls = 0; assign_install_setter(assign_target, "0");
  result = scr_dyn_assign(assign_target, assign_source);
  const ScrDyn *second = scr_dyn_obj_get(assign_target, "1", 1);
  check(result == assign_target && assign_calls == 1 && second && second->v.num == 9 && !scr_exc_pending(),
      "assign reads byte values after earlier target setters");
  scr_dyn_release(result); scr_dyn_release(assign_source); scr_dyn_release(assign_target); scr_bytes_release(bytes);
  ScrStr *astral = S("\xF0\x9F\x98\x80");
  assign_source = scr_dyn_new_str(astral); assign_target = scr_dyn_new_obj();
  result = scr_dyn_assign(assign_target, assign_source);
  const ScrDyn *first = scr_dyn_obj_get(assign_target, "0", 1);
  second = scr_dyn_obj_get(assign_target, "1", 1);
  check(result == assign_target && assign_target->v.obj.len == 2 && first && second &&
      scr_str_char_code_at(first->v.str, 0) == 0xD83D && scr_str_char_code_at(second->v.str, 0) == 0xDE00,
      "assign preserves UTF16 string indices");
  scr_dyn_release(result); scr_dyn_release(assign_source); scr_dyn_release(assign_target); scr_str_release(astral);
  assign_source = scr_dyn_new_arr(); scr_dyn_arr_push(assign_source, scr_dyn_new_num(1));
  assign_target = scr_dyn_new_obj(); assign_calls = 0; assign_install_setter(assign_target, "0");
  result = scr_dyn_copy_data_properties(assign_target, assign_source);
  check(result == assign_target && assign_calls == 0 && scr_dyn_obj_get(assign_target, "0", 1)->v.num == 1,
      "spread defines data instead of invoking existing setters");
  scr_dyn_release(result); scr_dyn_release(assign_source); scr_dyn_release(assign_target);

  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  ScrPromise *promise = scr_promise_new();
  ScrDyn *empty_sources[] = { scr_dyn_native_map(map), scr_dyn_new_promise(promise) };
  for (size_t i = 0; i < 2; i++) for (int spread = 0; spread < 2; spread++) {
    ScrDyn *target = scr_dyn_new_obj();
    result = spread ? scr_dyn_copy_data_properties(target, empty_sources[i])
        : scr_dyn_assign(target, empty_sources[i]);
    check(result == target && target->v.obj.len == 0 && !scr_exc_pending(),
        "empty native handles and promises copy no string properties");
    scr_dyn_release(result); scr_dyn_release(target);
  }
  value = scr_dyn_new_num(7); scr_dyn_symbol_key_set(empty_sources[0], assign_symbol, value); scr_dyn_release(value);
  ScrDyn *target = scr_dyn_new_obj(); result = scr_dyn_assign(target, empty_sources[0]);
  value = scr_dyn_symbol_key_get(target, assign_symbol, false);
  check(result == target && value && value->kind == SCR_DYN_NUM && value->v.num == 7,
      "native handles still copy attached symbol properties");
  scr_dyn_release(value); scr_dyn_release(result); scr_dyn_release(target);
  scr_dyn_release(empty_sources[0]); scr_dyn_release(empty_sources[1]);
  scr_map_release(map); scr_promise_release(promise);

  for (int setter = 0; setter < 3; setter++) {
    ScrStr *owner = S("symbol field owner"); assign_symbol_value = 1; assign_symbol_commits = 0;
    assign_target = scr_dyn_new_typed_ref(owner, view_retain, view_release, "record:symbol", 13,
        assign_symbol_materialize, assign_symbol_commit);
    assign_source = scr_dyn_new_obj(); assign_marker = scr_dyn_new_obj(); assign_calls = 0;
    assign_mode = setter == 2 ? 10 : 0;
    if (setter) {
      ScrDyn *desc = scr_dyn_new_obj();
      scr_dyn_obj_set(desc, "set", 3, scr_dyn_new_func(scr_closure_new(NULL, 0),
          assign_symbol_setter, 1, "symbol setter", "symbol_setter"));
      scr_dyn_release(scr_dyn_define_property(assign_target, assign_symbol, desc)); scr_dyn_release(desc);
    }
    check(assign_symbol_commits == (setter ? 1 : 0), "symbol descriptor setup commits before assign");
    assign_symbol_commits = 0;
    value = scr_dyn_new_num(9); scr_dyn_symbol_key_set(assign_source, assign_symbol, value); scr_dyn_release(value);
    result = scr_dyn_assign(assign_target, assign_source);
    check(assign_symbol_value == 9 && assign_symbol_commits == (setter ? 0 : 1) && assign_calls == (setter ? 1 : 0),
        "native symbol data commits once while setters own their alias effects");
    check(setter == 2 ? result == NULL : result == assign_target, "native symbol assign result");
    if (setter == 2 && scr_exc_pending()) {
      ScrCaught *caught = scr_exc_take(); ScrDyn *thrown = scr_caught_to_dyn(caught);
      check(thrown == assign_marker, "native symbol setter preserves exact exception");
      scr_dyn_release(thrown); scr_caught_release(caught);
    } else check(!scr_exc_pending() && setter != 2, "native symbol setter exception status");
    scr_dyn_release(result); scr_dyn_release(assign_source); scr_dyn_release(assign_target);
    scr_dyn_release(assign_marker); scr_str_release(owner);
  }
  scr_dyn_release(assign_symbol); scr_dyn_release(assign_added_symbol);
  assign_source = assign_target = assign_symbol = assign_added_symbol = assign_marker = NULL;
}

static ScrDyn *descriptor_receiver, *descriptor_target, *descriptor_key, *descriptor_marker;
static void *descriptor_native_owner;
static int descriptor_mode, descriptor_order;
static ScrDyn *descriptor_read(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args; (void)argc;
  int field = (int)scr_box_get_f64(closure->caps[0]);
  descriptor_order = descriptor_order * 10 + field + 1;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver == descriptor_receiver, "descriptor getter keeps original receiver");
  scr_dyn_release(receiver);
  if (field == 2) {
    if (descriptor_mode >= 2 && descriptor_mode <= 4) opaque_value = 9;
    if (descriptor_mode == 3) scr_native_integrity_strengthen(descriptor_native_owner, SCR_NATIVE_FROZEN);
    if (descriptor_mode == 4) { scr_dyn_throw(scr_dyn_retain(descriptor_marker)); return NULL; }
    if (descriptor_mode == 5) {
      ScrDyn *inner = scr_dyn_new_obj();
      scr_dyn_obj_set(inner, "value", 5, scr_dyn_new_num(7));
      scr_dyn_obj_set(inner, "configurable", 12, scr_dyn_new_bool(true));
      scr_dyn_release(scr_dyn_define_property(descriptor_target, descriptor_key, inner));
      scr_dyn_release(inner);
    }
    return scr_dyn_new_num(42);
  }
  if (field == 4 || field == 5)
    return descriptor_mode == 1 && field == 4 ? scr_dyn_new_num(1) : scr_dyn_retain(scr_dyn_undefined());
  return scr_dyn_new_bool(true);
}
static void descriptor_install(ScrDyn *holder, int field) {
  static const char *const names[] = { "enumerable", "configurable", "value", "writable", "get", "set" };
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_F64); scr_box_set_f64(closure->caps[0], field);
  ScrDyn *desc = scr_dyn_new_obj();
  scr_dyn_obj_set(desc, "get", 3, scr_dyn_new_func(closure, descriptor_read, 0, "descriptor read", "descriptor_read"));
  ScrStr *name = S(names[field]); ScrDyn *key = scr_dyn_new_str(name);
  scr_dyn_release(scr_dyn_define_property(holder, key, desc));
  scr_dyn_release(key); scr_str_release(name); scr_dyn_release(desc);
}
static ScrDyn *descriptor_key_string(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  descriptor_order = descriptor_order * 10 + 7;
  ScrStr *name = S("extra"); ScrDyn *key = scr_dyn_new_str(name); scr_str_release(name);
  return key;
}
static void descriptor_phase_tests(void) {
  ScrStr *name = S("extra"); descriptor_key = scr_dyn_new_str(name); scr_str_release(name);
  for (int inherited = 0; inherited < 2; inherited++) for (int batch = 0; batch < 2; batch++) {
    descriptor_target = scr_dyn_new_obj(); descriptor_receiver = scr_dyn_new_obj();
    ScrDyn *holder = inherited ? scr_dyn_new_obj() : scr_dyn_retain(descriptor_receiver);
    for (int field = 0; field < 4; field++) descriptor_install(holder, field);
    if (inherited) scr_dyn_release(scr_dyn_set_prototype(descriptor_receiver, holder));
    descriptor_mode = descriptor_order = 0;
    ScrDyn *bag = scr_dyn_new_obj(); scr_dyn_obj_set(bag, "extra", 5, scr_dyn_retain(descriptor_receiver));
    ScrDyn *result = batch ? scr_dyn_define_props(descriptor_target, bag)
        : scr_dyn_define_property(descriptor_target, descriptor_key, descriptor_receiver);
    const ScrDyn *value = scr_dyn_obj_get(descriptor_target, "extra", 5);
    check(result == descriptor_target && !scr_exc_pending() && descriptor_order == 1234,
        "descriptor conversion follows inherited Has/Get order");
    check(value && value->kind == SCR_DYN_NUM && value->v.num == 42, "inherited descriptor value is applied");
    scr_dyn_release(result); scr_dyn_release(bag); scr_dyn_release(holder);
    scr_dyn_release(descriptor_target); scr_dyn_release(descriptor_receiver);
  }
  for (int batch = 0; batch < 2; batch++) {
    descriptor_target = scr_dyn_new_obj(); descriptor_receiver = scr_dyn_new_obj();
    descriptor_install(descriptor_receiver, 4); descriptor_install(descriptor_receiver, 5);
    descriptor_mode = 1; descriptor_order = 0;
    ScrDyn *bag = scr_dyn_new_obj(), *valid = scr_dyn_new_obj();
    scr_dyn_obj_set(valid, "value", 5, scr_dyn_new_num(1));
    scr_dyn_obj_set(bag, "first", 5, valid); scr_dyn_obj_set(bag, "extra", 5, scr_dyn_retain(descriptor_receiver));
    ScrDyn *result = batch ? scr_dyn_define_props(descriptor_target, bag)
        : scr_dyn_define_property(descriptor_target, descriptor_key, descriptor_receiver);
    check(result == NULL && array_property_error() == 'T' && descriptor_order == 5,
        "invalid descriptor getter prevents later setter conversion");
    check(descriptor_target->v.obj.len == 0, "batch conversion failure precedes all target definitions");
    scr_dyn_release(result); scr_dyn_release(bag); scr_dyn_release(descriptor_target); scr_dyn_release(descriptor_receiver);
  }
  for (descriptor_mode = 2; descriptor_mode < 5; descriptor_mode++) {
    ScrStr *owner = S("descriptor native owner"); descriptor_native_owner = owner;
    opaque_shape = 1; opaque_value = 1; opaque_commits = 0;
    descriptor_target = scr_dyn_new_typed_ref(owner, view_retain, view_release,
        "record:descriptor", 17, opaque_materialize, opaque_commit);
    descriptor_receiver = scr_dyn_new_obj(); descriptor_marker = scr_dyn_new_obj();
    descriptor_install(descriptor_receiver, 2); descriptor_order = 0;
    ScrDyn *result = scr_dyn_define_property(descriptor_target, descriptor_key, descriptor_receiver);
    check(opaque_value == 9 && descriptor_order == 3, "descriptor effects on native aliases survive definition");
    if (descriptor_mode == 4 && scr_exc_pending()) {
      ScrCaught *caught = scr_exc_take(); ScrDyn *thrown = scr_caught_to_dyn(caught);
      check(thrown == descriptor_marker, "descriptor preserves exact callback exception");
      scr_dyn_release(thrown); scr_caught_release(caught);
    } else check(array_property_error() == (descriptor_mode == 3 ? 'T' : '-'),
        "definition checks current native restrictions after callbacks");
    check(descriptor_mode == 2 ? result == descriptor_target && opaque_commits == 1
        : result == NULL && opaque_commits == 0, "descriptor commits only the completed definition");
    scr_dyn_release(result); scr_dyn_release(descriptor_target); scr_dyn_release(descriptor_receiver);
    scr_dyn_release(descriptor_marker); scr_native_integrity_forget(owner); scr_str_release(owner);
  }
  descriptor_target = scr_dyn_new_arr(); descriptor_receiver = scr_dyn_new_obj(); descriptor_mode = 0;
  descriptor_install(descriptor_receiver, 2);
  ScrDyn *key_object = scr_dyn_new_obj();
  scr_dyn_obj_set(key_object, "toString", 8, scr_dyn_new_func(scr_closure_new(NULL, 0),
      descriptor_key_string, 0, "descriptor key", "descriptor_key"));
  descriptor_order = 0;
  ScrDyn *result = scr_dyn_define_property(descriptor_target, key_object, descriptor_receiver);
  check(result == descriptor_target && !scr_exc_pending() && descriptor_order == 73,
      "named array key coerces once before descriptor conversion");
  scr_dyn_release(result); scr_dyn_release(key_object); scr_dyn_release(descriptor_target); scr_dyn_release(descriptor_receiver);
  scr_dyn_release(descriptor_key);

  ScrSym *symbol = scr_sym_new(NULL); descriptor_key = scr_dyn_new_symbol(symbol); scr_sym_release(symbol);
  descriptor_target = scr_dyn_new_obj(); descriptor_receiver = scr_dyn_new_obj();
  descriptor_mode = 5; descriptor_order = 0; descriptor_install(descriptor_receiver, 2);
  result = scr_dyn_define_property(descriptor_target, descriptor_key, descriptor_receiver);
  ScrDyn *keys = scr_dyn_get_own_property_symbols(descriptor_target);
  check(result == descriptor_target && !scr_exc_pending() && descriptor_order == 3 && keys->v.arr.len == 1,
      "reentrant symbol definition records one key");
  scr_dyn_release(keys); scr_dyn_release(result); scr_dyn_release(descriptor_receiver); scr_dyn_release(descriptor_target);
  descriptor_target = scr_dyn_new_obj(); ScrDyn *bag = scr_dyn_new_obj(), *desc = scr_dyn_new_obj();
  scr_dyn_obj_set(desc, "value", 5, scr_dyn_new_num(42));
  scr_dyn_symbol_key_set(bag, descriptor_key, desc); scr_dyn_release(desc);
  result = scr_dyn_define_props(descriptor_target, bag);
  ScrDyn *value = scr_dyn_symbol_key_get(descriptor_target, descriptor_key, false);
  check(result == descriptor_target && !scr_exc_pending() && value && value->kind == SCR_DYN_NUM && value->v.num == 42,
      "defineProperties stages symbol descriptors");
  scr_dyn_release(value); scr_dyn_release(result); scr_dyn_release(bag); scr_dyn_release(descriptor_target); scr_dyn_release(descriptor_key);
  descriptor_receiver = descriptor_target = descriptor_key = descriptor_marker = NULL; descriptor_native_owner = NULL;
}


static ScrDyn *descriptor_native_materialize(void *owner) {
  (void)owner;
  ScrDyn *view = scr_dyn_new_obj();
  descriptor_install(view, 2);
  return view;
}
static void descriptor_variant_tests(void) {
  ScrStr *name = S("extra"); descriptor_key = scr_dyn_new_str(name); scr_str_release(name);
  descriptor_mode = 0;
  for (int shape = 0; shape < 3; shape++) for (int batch = 0; batch < 2; batch++) {
    ScrStr *owner = S("descriptor");
    descriptor_receiver = shape == 0 ? scr_dyn_new_arr() : shape == 1
        ? scr_dyn_new_func(scr_closure_new(NULL, 0), descriptor_key_string, 0, "function descriptor", "descriptor")
        : scr_dyn_new_typed_ref(owner, view_retain, view_release, "record:descriptor", 17,
            descriptor_native_materialize, NULL);
    if (shape < 2) descriptor_install(descriptor_receiver, 2);
    descriptor_target = scr_dyn_new_obj(); descriptor_order = 0;
    ScrDyn *bag = scr_dyn_new_obj(); scr_dyn_obj_set(bag, "extra", 5, scr_dyn_retain(descriptor_receiver));
    ScrDyn *result = batch ? scr_dyn_define_props(descriptor_target, bag)
        : scr_dyn_define_property(descriptor_target, descriptor_key, descriptor_receiver);
    const ScrDyn *value = scr_dyn_obj_get(descriptor_target, "extra", 5);
    check(result == descriptor_target && !scr_exc_pending() && descriptor_order == 3 &&
        value && value->kind == SCR_DYN_NUM && value->v.num == 42,
        "array function and native descriptors use original receiver");
    scr_dyn_release(result); scr_dyn_release(bag);
    scr_dyn_release(descriptor_target); scr_dyn_release(descriptor_receiver); scr_str_release(owner);
  }
  /* A failure while acquiring current target storage must release normalized
   * cyclic values, preserve the original exception, and never commit. */
  descriptor_receiver = scr_dyn_new_obj();
  ScrDyn *cycle = scr_dyn_new_obj(); scr_dyn_obj_set(cycle, "self", 4, scr_dyn_retain(cycle));
  scr_dyn_obj_set(descriptor_receiver, "value", 5, cycle);
  ScrStr *owner = S("failed descriptor target");
  descriptor_target = scr_dyn_new_typed_ref(owner, view_retain, view_release, "record:descriptor", 17,
      opaque_materialize, opaque_commit);
  opaque_marker = scr_dyn_new_obj(); opaque_materialize_fails = true; opaque_commits = 0;
  ScrDyn *result = scr_dyn_define_property(descriptor_target, descriptor_key, descriptor_receiver);
  check(result == NULL && scr_exc_pending() && opaque_commits == 0,
      "target materialization failure stops after descriptor conversion");
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take(); ScrDyn *thrown = scr_caught_to_dyn(caught);
    check(thrown == opaque_marker, "target materialization preserves exact exception");
    scr_dyn_release(thrown); scr_caught_release(caught);
  }
  opaque_materialize_fails = false;
  scr_dyn_release(result); scr_dyn_release(opaque_marker); opaque_marker = NULL;
  scr_dyn_release(descriptor_receiver); scr_dyn_release(descriptor_target); scr_str_release(owner);
  scr_collect_cycles();

  /* Both ordinary incompatibility and protected prototype names fail during
   * application, after all getters, retaining only the successful prefix. */
  for (int protected = 0; protected < 2; protected++) {
    descriptor_target = scr_dyn_new_obj(); descriptor_receiver = scr_dyn_new_obj();
    descriptor_install(descriptor_receiver, 2); descriptor_order = 0;
    ScrDyn *bag = scr_dyn_new_obj(), *fixed = scr_dyn_new_obj(), *keys = scr_dyn_new_arr();
    ScrStr *fixed_name = S("fixed"); ScrDyn *fixed_key = scr_dyn_new_str(fixed_name); scr_str_release(fixed_name);
    scr_dyn_obj_set(fixed, "value", 5, scr_dyn_new_num(1));
    scr_dyn_release(scr_dyn_define_property(descriptor_target, fixed_key, fixed));
    scr_dyn_arr_push(keys, scr_dyn_retain(fixed_key));
    scr_dyn_obj_set(bag, "first", 5, scr_dyn_retain(descriptor_receiver));
    scr_dyn_obj_set(bag, "fixed", 5, scr_dyn_retain(descriptor_receiver));
    scr_dyn_obj_set(bag, "later", 5, scr_dyn_retain(descriptor_receiver));
    result = protected ? scr_dyn_define_prototype_props(descriptor_target, bag, keys)
        : scr_dyn_define_props(descriptor_target, bag);
    const ScrDyn *first = scr_dyn_obj_get(descriptor_target, "first", 5);
    check(result == NULL && array_property_error() == (protected ? 'E' : 'T') && descriptor_order == 333,
        "batch application failure follows every descriptor getter");
    check(first && first->kind == SCR_DYN_NUM && first->v.num == 42 &&
        scr_dyn_obj_get(descriptor_target, "fixed", 5)->v.num == 1 &&
        !scr_dyn_obj_get(descriptor_target, "later", 5), "batch application retains successful prefix");
    scr_dyn_release(result); scr_dyn_release(keys); scr_dyn_release(fixed); scr_dyn_release(fixed_key);
    scr_dyn_release(bag); scr_dyn_release(descriptor_receiver); scr_dyn_release(descriptor_target);
  }
  /* Explicit undefined clears an accessor; omission leaves it unchanged. */
  descriptor_target = scr_dyn_new_obj();
  ScrDyn *getter = scr_dyn_new_func(scr_closure_new(NULL, 0), descriptor_key_string, 0, "getter", "getter");
  ScrDyn *desc = scr_dyn_new_obj(); scr_dyn_obj_set(desc, "get", 3, scr_dyn_retain(getter));
  scr_dyn_obj_set(desc, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_release(scr_dyn_define_property(descriptor_target, descriptor_key, desc)); scr_dyn_release(desc);
  desc = scr_dyn_new_obj();
  scr_dyn_release(scr_dyn_define_property(descriptor_target, descriptor_key, desc));
  ScrDyn *observed = scr_dyn_get_own_property_descriptor(descriptor_target, descriptor_key);
  check(scr_dyn_obj_get(observed, "get", 3) == getter, "omitted getter remains unchanged");
  scr_dyn_release(observed);
  scr_dyn_obj_set(desc, "get", 3, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_release(scr_dyn_define_property(descriptor_target, descriptor_key, desc));
  observed = scr_dyn_get_own_property_descriptor(descriptor_target, descriptor_key);
  check(scr_dyn_obj_get(observed, "get", 3)->kind == SCR_DYN_UNDEF &&
      !scr_dyn_obj_get(observed, "value", 5), "explicit undefined removes getter without changing descriptor kind");
  scr_dyn_release(observed); scr_dyn_release(desc); scr_dyn_release(getter); scr_dyn_release(descriptor_target);
  scr_dyn_release(descriptor_key);
  descriptor_receiver = descriptor_target = descriptor_key = NULL;
}


static void reflect_receiver_tests(void) {
  for (int native = 0; native < 2; native++) for (int named = 0; named < 2; named++) {
    ScrArr *arr = scr_arr_new(SCR_ELEM_F64, 0);
    ScrDyn *receiver = native ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
        "array<f64>", 10, live_array_materialize, NULL) : scr_dyn_new_arr();
    if (native) scr_dyn_typed_ref_bind_array(receiver, &live_array_ops);
    ScrDyn *prototype = scr_dyn_new_obj(); property_define(prototype, named ? "extra" : "0", 1);
    scr_dyn_release(scr_dyn_set_prototype(receiver, prototype));
    ScrDyn *target = scr_dyn_new_obj(), *value = scr_dyn_new_num(9);
    ScrStr *name = S(named ? "extra" : "0"); ScrDyn *key = scr_dyn_new_str(name);
    property_receiver = receiver; property_sets = 0; property_this_ok = true;
    bool ok = scr_dyn_reflect_set(target, key, value, receiver);
    bool own = scr_dyn_has_own_computed(receiver, key);
    check(ok && !scr_exc_pending() && property_sets == 0 && own,
        "Reflect receiver definition bypasses inherited array setters");
    if (!named) check(native ? arr->len == 1 && scr_arr_get_f64(arr, 0) == 9
        : receiver->v.arr.len == 1 && receiver->v.arr.items[0]->v.num == 9,
        "Reflect receiver index writes reach authoritative array storage");
    scr_exc_clear(); scr_dyn_release(key); scr_str_release(name); scr_dyn_release(value);
    scr_dyn_release(target); scr_dyn_release(prototype); scr_dyn_release(receiver); scr_arr_release(arr);
    property_receiver = NULL;
  }
  for (int native = 0; native < 2; native++) {
    ScrArr *arr = scr_arr_new(SCR_ELEM_F64, 1); scr_arr_push_f64(arr, 1);
    ScrDyn *target = native ? scr_dyn_new_typed_ref(arr, scr_arr_retain_v, scr_arr_release_v,
        "array<f64>", 10, live_array_materialize, NULL) : live_array_materialize(arr);
    if (native) {
      scr_dyn_typed_ref_bind_array(target, &live_array_ops);
      scr_native_integrity_strengthen(arr, SCR_NATIVE_FROZEN);
    } else scr_dyn_release(scr_dyn_freeze(target));
    ScrDyn *receiver = scr_dyn_new_obj(), *value = scr_dyn_new_num(9);
    ScrStr *name = S("0"); ScrDyn *key = scr_dyn_new_str(name);
    bool ok = scr_dyn_reflect_set(target, key, value, receiver);
    check(!ok && !scr_exc_pending() && !scr_dyn_has_own_computed(receiver, key),
        "Reflect target frozen element blocks distinct receiver definition");
    scr_exc_clear(); scr_dyn_release(key); scr_str_release(name); scr_dyn_release(value);
    scr_dyn_release(receiver); scr_dyn_release(target); scr_arr_release(arr);
  }
}


static void reflect_publish_array(void *array, ScrPub *ctx) { scr_pub_arr(array, ctx, NULL); }
static void reflect_lifetime_tests(void) {
  ScrStr *json = S("[]"); ScrDyn *array = scr_json_parse(json); scr_str_release(json);
  ScrStr *name = S("extra"); ScrDyn *key = scr_dyn_new_str(name), *value = scr_dyn_new_num(0);
  check(scr_dyn_region_of(array) && scr_dyn_region_of(array)->intact, "parsed array starts in an intact region");
  check(scr_dyn_reflect_define(array, key, value) && !scr_dyn_region_of(array)->intact,
      "Reflect named table creation invalidates array region before later cyclic stores");
  scr_dyn_key_set(array, name, array);
  scr_dyn_release(value); scr_dyn_release(key); scr_str_release(name); scr_dyn_release(array);
  scr_collect_cycles();

  ScrArr *storage = scr_arr_new(SCR_ELEM_F64, 1); scr_arr_push_f64(storage, 1);
  scr_publish(storage, reflect_publish_array);
  check(storage->rc == SIZE_MAX && !scr_exc_pending(), "Reflect prototype control is actually published");
  array = scr_dyn_new_typed_ref(storage, scr_arr_retain_v, scr_arr_release_v,
      "array<f64>", 10, live_array_materialize, NULL);
  scr_dyn_typed_ref_bind_array(array, &live_array_ops);
  ScrDyn *target = scr_dyn_new_obj(), *receiver = scr_dyn_new_obj();
  scr_dyn_release(scr_dyn_set_prototype(target, array)); value = scr_dyn_new_num(9);
  const char *names[] = {"0", "length"};
  for (size_t i = 0; i < 2; i++) {
    name = S(names[i]); key = scr_dyn_new_str(name);
    bool ok = scr_dyn_reflect_set(target, key, value, receiver);
    check(!ok && !scr_exc_pending() && !scr_dyn_has_own_computed(receiver, key),
        "published array prototype blocks distinct receiver writes");
    scr_dyn_release(key); scr_str_release(name);
  }
  scr_dyn_release(value); scr_dyn_release(receiver); scr_dyn_release(target); scr_dyn_release(array);
}


/* Promotion may recursively bind an array whose metadata already points back
 * to the first array. A later failed box must leave both identities reusable. */
static ScrArr *named_box_failure;
static ScrDyn *named_error;
static size_t named_prototype_views;
static ScrDyn *named_prototype_view(void *ptr) {
  named_prototype_views++;
  return scr_dyn_class_view_unavailable(ptr);
}
static const ScrDynTypedArrayOps recursive_array_ops;
static ScrDyn *recursive_array_view(void *ptr) {
  ScrDyn *out = scr_dyn_new_arr();
  scr_arr_copy_metadata(ptr, out);
  return out;
}
static ScrDyn *recursive_array_box(uint64_t slot) {
  ScrArr *array = (ScrArr *)(uintptr_t)slot;
  if (array == named_box_failure) {
    scr_dyn_throw(scr_dyn_retain(named_error));
    return NULL;
  }
  ScrDyn *out = scr_dyn_new_typed_ref(array, scr_arr_retain_v, scr_arr_release_v,
      "array<recursive>", 16, recursive_array_view, NULL);
  if (!scr_dyn_typed_ref_bind_array(out, &recursive_array_ops)) {
    scr_dyn_release(out);
    return NULL;
  }
  return out;
}
static bool recursive_array_unbox(const ScrDyn *value, uint64_t *out) {
  if (!scr_dyn_typed_ref_is(value, "array<recursive>", 16)) return false;
  *out = (uint64_t)(uintptr_t)scr_arr_retain(value->v.typed_ref.ptr);
  return true;
}
static ScrDyn *recursive_array_get(void *ptr, double index) {
  ScrArr *nested = scr_arr_get_ref(ptr, index);
  ScrDyn *out = recursive_array_box((uint64_t)(uintptr_t)nested);
  scr_arr_release(nested);
  return out;
}
static const ScrDynTypedArrayOps recursive_array_ops = {
  recursive_array_get, NULL, recursive_array_box, recursive_array_unbox
};

static void named_expect_error(const char *message) {
  check(scr_exc_pending(), message);
  ScrCaught *caught = scr_exc_take();
  ScrDyn *value = caught ? scr_caught_to_dyn(caught) : NULL;
  check(value == named_error, "named operation preserves the exact thrown object");
  scr_dyn_release(value);
  scr_caught_release(caught);
}

static void array_named_promotion_tests(void) {
  scr_collect_cycles();
  long dyn = scr_dyn_live_count();
  size_t live = scr_cyc_live;
  for (int mutual = 0; mutual < 2; mutual++) {
    ScrArr *a = scr_arr_new(SCR_ELEM_ARR, 0);
    ScrArr *b = mutual ? scr_arr_new(SCR_ELEM_ARR, 0) : a;
    ScrArr *bad = scr_arr_new(SCR_ELEM_ARR, 0);
    scr_arr_set_ref(a, -1, scr_arr_retain(b));
    if (mutual) scr_arr_set_ref(b, -1, scr_arr_retain(a));
    scr_arr_set_ref(a, -2, scr_arr_retain(bad));
    ScrArrProp *original = a->ext->props;
    named_box_failure = bad;
    named_error = scr_dyn_new_obj();
    ScrDyn *first = scr_dyn_new_typed_ref(a, scr_arr_retain_v, scr_arr_release_v,
        "array<recursive>", 16, recursive_array_view, NULL);
    check(!scr_dyn_typed_ref_bind_array(first, &recursive_array_ops),
        "late nested boxing failure refuses binding");
    named_expect_error("late promotion failure remains pending");
    check(a->ext->props == original && a->ext->prop_len == 2 && !a->ext->metadata &&
        a->ext->named_state == SCR_ARR_NAMES_UNPROMOTED,
        "failed promotion preserves typed storage and resets only its state");
    const ScrDynTypedArrayOps *recipe = first->v.typed_ref.array;
    if (mutual) {
      check(scr_arr_named_promoted(b) && b->ext->prop_len == 0,
          "nested promotion can commit before outer failure");
      ScrDyn *original_capsule = first;
      scr_dyn_release(first);
      first = scr_arr_property_get(b, -1);
      check(first == original_capsule && !scr_exc_pending(),
          "nested metadata alone keeps the failed outer capsule alive");
      ScrStr *source = S("prototype");
      a->ext->metadata = scr_dyn_new_obj();
      a->ext->metadata->prototype = scr_dyn_new_typed_ref(source, scr_str_retain_v, scr_str_release_v,
          "object:promotion", 16, named_prototype_view, NULL);
      scr_str_release(source);
      named_prototype_views = 0;
      ScrDyn *keys = scr_dyn_get_own_property_names(first);
      check(!keys, "snapshot own keys cannot bypass failed promotion readiness");
      named_expect_error("own-key snapshot preserves failed promotion error");
      for (int action = 0; action < 6; action++) {
        ScrDyn *result = NULL;
        if (action == 0) result = scr_dyn_prevent_extensions(first);
        else if (action == 1) result = scr_dyn_seal(first);
        else if (action == 2) result = scr_dyn_freeze(first);
        else if (action == 3) (void)scr_dyn_is_extensible(first);
        else if (action == 4) (void)scr_dyn_is_sealed(first);
        else (void)scr_dyn_is_frozen(first);
        check(!result && scr_arr_integrity_flags(a) == 0,
            "failed promotion cannot strengthen array integrity");
        named_expect_error("integrity entry preserves the exact promotion failure");
      }
      for (int walk = 0; walk < 3; walk++) {
        ScrDyn *values = walk == 0 ? scr_dyn_obj_keys(first)
            : walk == 1 ? scr_dyn_obj_values(first) : scr_dyn_obj_entries(first);
        check(!values, "own enumerable walk refuses partial promotion snapshots");
        named_expect_error("enumerable walk preserves original promotion failure");
      }
      ScrSym *symbol = scr_sym_new(NULL);
      ScrDyn *symbol_key = scr_dyn_new_symbol(symbol);
      scr_sym_release(symbol);
      ScrDyn *descriptor = scr_dyn_get_own_property_descriptor(first, symbol_key);
      check(!descriptor, "symbol descriptor preserves failed promotion readiness");
      named_expect_error("symbol descriptor preserves failed promotion error");
      scr_dyn_release(symbol_key);
      ScrStr *name = S("-1");
      ScrDyn *failed = scr_dyn_typed_ref_key_get(first, name);
      check(!failed && a->ext->props == original,
          "surviving capsule cannot hide a still-failing promotion behind empty metadata");
      named_expect_error("direct retry preserves the original pending failure");
      check(!scr_dyn_has_key(first, name), "failed promotion stops inherited Has lookup");
      named_expect_error("Has preserves the original pending failure");
      ScrDyn *key = scr_dyn_new_str(name), *value = scr_dyn_new_num(9);
      failed = scr_dyn_reflect_get(first, key, first);
      check(!failed, "failed promotion stops Reflect Get before prototype resolution");
      named_expect_error("Reflect Get preserves the original pending failure");
      check(!scr_dyn_reflect_set(first, key, value, first),
          "failed promotion stops Reflect Set before prototype resolution");
      named_expect_error("Reflect Set preserves the original pending failure");
      check(named_prototype_views == 0, "pending promotion errors never invoke a prototype adapter");
      scr_dyn_release(value); scr_dyn_release(key); scr_str_release(name);
    }
    named_box_failure = NULL;
    if (mutual) {
      ScrDyn *keys = scr_dyn_get_own_property_names(first);
      check(keys && keys->kind == SCR_DYN_ARR && keys->v.arr.len == 3 && scr_arr_named_promoted(a),
          "own-key snapshot retries promotion before exposing raw names");
      scr_dyn_release(keys);
      ScrStr *name = S("-1");
      ScrDyn *retry = scr_dyn_typed_ref_key_get(first, name);
      check(retry && retry->kind == SCR_DYN_TYPED_REF && retry->v.typed_ref.ptr == b &&
          scr_arr_named_promoted(a), "surviving nested capsule retries promotion before named Get");
      scr_dyn_release(retry);
      scr_str_release(name);
    }
    check(scr_dyn_typed_ref_bind_array(first, &recursive_array_ops) &&
        scr_arr_named_promoted(a) && !a->ext->props && first->v.typed_ref.array == recipe,
        "retry reuses immutable recipe and atomically detaches raw properties");
    ScrDyn *got = scr_arr_property_get(a, -1);
    check(got && got->kind == SCR_DYN_TYPED_REF && got->v.typed_ref.ptr == b,
        "promoted cyclic value preserves referent identity");
    scr_dyn_release(got);
    ScrDynTypedArrayOps incompatible = recursive_array_ops;
    incompatible.box = live_array_box;
    check(!scr_dyn_typed_ref_bind_array(first, &incompatible) && scr_exc_pending() &&
        first->v.typed_ref.array == recipe,
        "incompatible later binding cannot replace the first recipe");
    scr_exc_clear();
    scr_dyn_release(first);
    scr_arr_release(a);
    if (mutual) scr_arr_release(b);
    scr_arr_release(bad);
    scr_dyn_release(named_error);
    named_error = NULL;
    scr_collect_cycles();
    check(scr_cyc_live == live && scr_dyn_live_count() == dyn,
        "plain capsules upgraded at bind collect promoted self and mutual cycles");
  }
}

static size_t named_gets, named_sets;
static int named_result;
static ScrArr *named_receiver;
static ScrDyn *named_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  named_gets++;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver && receiver->kind == SCR_DYN_TYPED_REF && receiver->v.typed_ref.ptr == named_receiver,
      "named getter receives the original native referent");
  scr_dyn_release(receiver);
  if (named_result == 5) { fputs("FAIL raw slot invoked getter\n", stderr); abort(); }
  if (named_result == 1) return scr_dyn_retain(scr_dyn_undefined());
  if (named_result == 2) { scr_dyn_throw(scr_dyn_retain(named_error)); return NULL; }
  if (named_result == 3) {
    ScrStr *text = S("fresh value");
    ScrDyn *out = scr_dyn_new_str(text);
    scr_str_release(text);
    return out;
  }
  if (named_result == 4) return scr_dyn_new_obj();
  return scr_dyn_new_num(42);
}
static ScrDyn *named_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  named_sets++;
  ScrDyn *receiver = scr_dyn_this_get();
  check(receiver && receiver->kind == SCR_DYN_TYPED_REF && receiver->v.typed_ref.ptr == named_receiver &&
      argc == 1 && args[0]->kind == SCR_DYN_NUM && args[0]->v.num == 9,
      "frozen named setter receives the original array and value");
  scr_dyn_release(receiver);
  return scr_dyn_retain(scr_dyn_undefined());
}
static void named_accessor(ScrDyn *target, const char *name, bool setter) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3,
      scr_dyn_new_func(scr_closure_new(NULL, 0), named_getter, 0, "named getter", "named_getter"));
  if (setter) scr_dyn_obj_set(descriptor, "set", 3,
      scr_dyn_new_func(scr_closure_new(NULL, 0), named_setter, 1, "named setter", "named_setter"));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  ScrStr *text = S(name);
  ScrDyn *key = scr_dyn_new_str(text);
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  check(defined && !scr_exc_pending(), "named accessor definition succeeds");
  scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_str_release(text);
  scr_dyn_release(descriptor);
}
static void array_named_access_tests(void) {
  ScrArr *slots = scr_arr_new(SCR_ELEM_F64, 1);
  scr_arr_push_f64(slots, 7);
  scr_arr_set_f64(slots, -1, 11);
  check(scr_arr_get_slot_f64(slots, 0) == 7 && scr_arr_get_slot_f64(slots, -1) == 11,
      "raw slot numbers read canonical storage and unpromoted names");
  scr_arr_set_undefined(slots, 0);
  check(isnan(scr_arr_get_slot_number(slots, 0)) && isnan(scr_arr_get_slot_number(slots, 2)),
      "optional raw slot numbers preserve undefined and holes as NaN");
  scr_arr_release(slots);
  slots = scr_arr_new(SCR_ELEM_BOOL, 1);
  scr_arr_push_bool(slots, true);
  check(scr_arr_get_slot_bool(slots, 0), "raw boolean slot reads its exact representation");
  scr_arr_release(slots);
  slots = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(slots, S("owned slot"));
  ScrStr *owned_slot = scr_arr_get_slot_ref(slots, 0);
  size_t slot_refs = owned_slot->rc;
  check(scr_arr_borrow_slot_ref(slots, 0) == owned_slot && owned_slot->rc == slot_refs,
      "raw borrowed slot does not retain or invoke conversion");
  scr_arr_release(slots);
  check(str_is(owned_slot, "owned slot") && owned_slot->rc == slot_refs - 1,
      "owned raw slot remains alive after its array is released");
  scr_str_release(owned_slot);
  ScrArr *array = scr_arr_new(SCR_ELEM_F64, 0);
  ScrDyn *first = prototype_array_capsule(array, false);
  ScrDyn *alias = prototype_array_capsule(array, true);
  named_receiver = array;
  named_error = scr_dyn_new_obj();
  named_gets = named_sets = 0;
  ScrSym *absent = scr_sym_new(NULL);
  ScrDyn *absent_key = scr_dyn_new_symbol(absent);
  scr_sym_release(absent);
  ScrDyn *missing = scr_dyn_get_own_property_descriptor(first, absent_key);
  check(missing && missing->kind == SCR_DYN_UNDEF && !array->ext->metadata,
      "absent symbol descriptor reads no empty metadata");
  scr_dyn_release(missing);
  scr_dyn_key_delete_computed(first, absent_key, true);
  check(!scr_exc_pending() && !array->ext->metadata, "absent symbol delete needs no metadata owner");
  missing = scr_dyn_get_own_property_symbols(first);
  check(missing && missing->kind == SCR_DYN_ARR && missing->v.arr.len == 0 && !array->ext->metadata,
      "empty symbol key enumeration needs no metadata owner");
  scr_dyn_release(missing); scr_dyn_release(absent_key);
  named_accessor(first, "-1", true);
  check(isnan(scr_arr_get_slot_number(array, -1)) && named_gets == 0 && !scr_exc_pending(),
      "promoted accessor has no raw numeric slot and never runs on optional storage read");
  ScrStr *minus = S("-1");
  check(scr_arr_has(array, -1) && scr_arr_has_property(array, -1) &&
      scr_arr_state(array, -1) == SCR_ARR_VALUE && scr_dyn_has_own(alias, minus) && named_gets == 0,
      "named presence and descriptor state never invoke getters");
  size_t materializations = live_array_materializations;
  for (int mode = 0; mode < 5; mode++) {
    named_result = mode;
    size_t before = named_gets;
    ScrDyn *got = scr_arr_property_get(array, -1);
    check(named_gets == before + 1, "owned property Get invokes an accessor exactly once");
    if (mode == 2) named_expect_error("getter throw stays pending");
    else check(got && got->kind == (mode == 0 ? SCR_DYN_NUM : mode == 1 ? SCR_DYN_UNDEF :
        mode == 3 ? SCR_DYN_STR : SCR_DYN_OBJ), "owned property Get keeps fresh getter results alive");
    scr_dyn_release(got);
  }
  named_result = 0;
  for (int walk = 0; walk < 3; walk++) {
    size_t before = named_gets;
    ScrDyn *values = walk == 0 ? scr_dyn_obj_keys(alias)
        : walk == 1 ? scr_dyn_obj_values(alias) : scr_dyn_obj_entries(alias);
    check(values && values->kind == SCR_DYN_ARR && values->v.arr.len == 1 &&
        named_gets == before + (walk != 0),
        "native enumerable walks invoke getters once with the original receiver");
    scr_dyn_release(values);
  }
  materializations = live_array_materializations;
  named_result = 1;
  check(scr_arr_get_f64(array, -1) == 0 && scr_exc_pending(),
      "strict raw number Get rejects accessor undefined");
  scr_exc_clear();
  named_result = 2;
  (void)scr_arr_get_number(array, -1);
  named_expect_error("raw number coercion preserves getter throw");
  named_result = 0;
  check(scr_arr_get_f64(array, -1) == 42, "strict raw number Get reads exact numeric accessor results");
  check(live_array_materializations == materializations, "named reads never refresh the array snapshot");

  ScrDyn *prototype = scr_dyn_new_obj();
  named_accessor(prototype, "0", false);
  scr_dyn_release(scr_dyn_set_prototype(first, prototype));
  size_t before = named_gets;
  check(!scr_arr_has(array, 0) && scr_arr_has_property(array, 0) && named_gets == before,
      "canonical holes distinguish own presence from inherited getter-free in");
  ScrDyn *got = scr_arr_property_get(array, 0);
  check(got && got->v.num == 42 && named_gets == before + 1,
      "owned canonical-hole Get invokes inherited getter once");
  scr_dyn_release(got);
  scr_arr_set_undefined(array, 0);
  got = scr_arr_property_get(array, 0);
  check(got && got->kind == SCR_DYN_UNDEF && named_gets == before + 1,
      "present own undefined shadows inherited getter");
  scr_dyn_release(got);
  scr_dyn_release(prototype);

  ScrSym *symbol = scr_sym_new(NULL);
  ScrDyn *key = scr_dyn_new_symbol(symbol), *nine = scr_dyn_new_num(9);
  scr_sym_release(symbol);
  scr_dyn_symbol_key_set(first, key, nine);
  ScrDyn *view = scr_dyn_typed_ref_materialize(alias);
  scr_dyn_key_delete_computed(first, key, true);
  scr_dyn_release(scr_dyn_typed_ref_materialize(alias));
  check(!scr_dyn_has_own_computed(alias, key) && !scr_dyn_has_own_computed(view, key),
      "alias refresh cannot resurrect a deleted referent symbol");
  scr_dyn_symbol_key_set(alias, key, nine);
  got = scr_dyn_symbol_key_get(first, key, false);
  check(got && got->kind == SCR_DYN_NUM && got->v.num == 9,
      "symbol Set through another capsule updates the referent");
  scr_dyn_release(got);
  scr_dyn_release(view);
  before = named_gets;
  materializations = live_array_materializations;
  got = scr_dyn_freeze(first);
  check(got == first && !scr_dyn_is_extensible(alias) && scr_dyn_is_sealed(alias) &&
      scr_dyn_is_frozen(alias) && named_gets == before &&
      live_array_materializations == materializations,
      "Object.freeze owns native array integrity across aliases without getters or snapshots");
  scr_dyn_release(got);
  scr_arr_set_f64(array, -1, 9);
  check(!scr_exc_pending() && named_sets == 1, "frozen native arrays still dispatch accessor setters");
  check(!scr_dyn_reflect_set(first, key, nine, first) && !scr_exc_pending(),
      "frozen named data refuses Reflect writes without throwing");
  scr_dyn_release(nine); scr_dyn_release(key);
  scr_str_release(minus);
  scr_dyn_release(first); scr_dyn_release(alias); scr_arr_release(array);
  scr_dyn_release(named_error); named_error = NULL;

  static const ScrDynTypedArrayOps strings = {string_array_get, NULL, string_array_box, string_array_unbox};
  array = scr_arr_new(SCR_ELEM_STR, 0); named_receiver = array;
  first = scr_dyn_new_typed_ref(array, scr_arr_retain_v, scr_arr_release_v,
      "array<string>", 13, string_array_materialize, NULL);
  check(scr_dyn_typed_ref_bind_array(first, &strings), "string array binds exact codec");
  named_accessor(first, "-1", false); named_result = 3; before = named_gets;
  check(!scr_arr_peek_ref(array, -1) && named_gets == before && !scr_exc_pending(),
      "callback-free peek never exposes an accessor temporary");
  ScrStr *text = scr_arr_get_ref(array, -1);
  check(text && str_is(text, "fresh value") && named_gets == before + 1,
      "owned strict reference Get retains a fresh getter result");
  scr_str_release(text);
  scr_dyn_release(first); scr_arr_release(array); named_receiver = NULL;
  scr_collect_cycles();
}

static void array_named_integrity_tests(void) {
  for (int sparse = 0; sparse < 2; sparse++) {
    ScrArr *array = scr_arr_new(SCR_ELEM_F64, 0);
    double index = sparse ? 1000000 : 1;
    scr_arr_set_f64(array, index, 7);
    ScrDyn *first = prototype_array_capsule(array, false);
    ScrDyn *alias = prototype_array_capsule(array, true);
    size_t materializations = live_array_materializations, refs = first->rc;
    check(scr_dyn_is_extensible(alias) && !scr_dyn_is_sealed(alias) && !scr_dyn_is_frozen(alias),
        "fresh native indexed array has ordinary integrity state");
    ScrDyn *result = scr_dyn_prevent_extensions(first);
    check(result == first && first->rc == refs + 1 && !scr_dyn_is_extensible(alias) &&
        !scr_dyn_is_sealed(alias) && !scr_dyn_is_frozen(alias),
        "preventExtensions returns an owned identity and restricts the shared referent");
    scr_dyn_release(result);
    scr_arr_set_f64(array, index, 8);
    check(!scr_exc_pending() && scr_arr_get_slot_f64(array, index) == 8 &&
        scr_arr_set_len_mode(array, index + 3, false) &&
        !scr_arr_check_set_mode(array, index + 1, false),
        "nonextensible array permits existing data and length growth but refuses new indices");
    result = scr_dyn_seal(alias); scr_dyn_release(result);
    check(scr_dyn_is_sealed(first) && !scr_dyn_is_frozen(first) &&
        !scr_arr_delete_mode(array, index, false) &&
        !scr_arr_set_len_mode(array, 0, false) && array->len == (size_t)index + 1,
        "sealed array refuses deletion and truncates only holes above its last own index");
    scr_arr_set_f64(array, index, 9);
    check(!scr_exc_pending() && scr_arr_get_slot_f64(array, index) == 9,
        "sealed native data remains writable");
    result = scr_dyn_freeze(alias); scr_dyn_release(result);
    check(scr_dyn_is_frozen(first) && !scr_arr_check_set_mode(array, index, false) &&
        !scr_arr_set_len_mode(array, (double)array->len, false) &&
        !array->ext->metadata && live_array_materializations == materializations,
        "freeze blocks data and same-length Set without allocating metadata or snapshots");
    scr_dyn_release(scr_dyn_typed_ref_materialize(first));
    scr_dyn_release(first); scr_dyn_release(alias);
    first = prototype_array_capsule(array, true);
    check(scr_dyn_is_frozen(first), "integrity survives capsule disposal and rematerialization");
    scr_dyn_release(first); scr_arr_release(array);
  }
}

static void array_named_publication_tests(void) {
  ScrArr *array = scr_arr_new(SCR_ELEM_F64, 0);
  ScrDyn *first = prototype_array_capsule(array, false);
  ScrDyn *got = scr_arr_property_get(array, -1);
  check(got && got->kind == SCR_DYN_UNDEF && !array->ext->metadata,
      "binding and absent reads allocate no empty metadata");
  scr_dyn_release(got);
  scr_dyn_release(scr_dyn_prevent_extensions(first));
  check(!array->ext->metadata && !scr_dyn_is_extensible(first),
      "public preventExtensions leaves an empty referent publishable");
  ScrStr *name = S("-1"); ScrDyn *key = scr_dyn_new_str(name), *value = scr_dyn_new_num(9);
  check(!scr_dyn_reflect_set(first, key, value, first) && !array->ext->metadata,
      "refused named writes allocate no metadata");
  scr_publish(array, reflect_publish_array);
  check(array->rc == SIZE_MAX && !scr_exc_pending(), "hooks alone do not block publication");
  ScrArr saved = *array;
  ScrArrExt extension = *array->ext;
  ScrDyn *alias = prototype_array_capsule(array, true);
  check(!memcmp(&saved, array, sizeof saved) && !memcmp(&extension, array->ext, sizeof extension),
      "published binding performs zero writes to array or extension");
  for (int action = 0; action < 3; action++) {
    ScrDyn *result = action == 0 ? scr_dyn_prevent_extensions(alias)
        : action == 1 ? scr_dyn_seal(alias) : scr_dyn_freeze(alias);
    check(result == alias && !scr_dyn_is_extensible(alias) && scr_dyn_is_sealed(alias) &&
        scr_dyn_is_frozen(alias) && !memcmp(&saved, array, sizeof saved) &&
        !memcmp(&extension, array->ext, sizeof extension),
        "published integrity entries return identity with no referent or extension writes");
    scr_dyn_release(result);
  }
  check(!scr_dyn_reflect_set(alias, key, value, alias) && !scr_exc_pending() &&
      !memcmp(&saved, array, sizeof saved) && !memcmp(&extension, array->ext, sizeof extension),
      "published named refusal leaves exact array bytes unchanged");
  scr_dyn_release(alias); scr_dyn_release(first);
  scr_dyn_release(value); scr_dyn_release(key); scr_str_release(name);

  array = scr_arr_new(SCR_ELEM_F64, 0);
  scr_publish(array, reflect_publish_array);
  saved = *array;
  first = prototype_array_capsule(array, false);
  name = S("0");
  got = scr_dyn_typed_ref_key_get(first, name);
  check(got && got->kind == SCR_DYN_UNDEF && !memcmp(&saved, array, sizeof saved),
      "fresh published capsule reads a missing index without adding a recipe");
  scr_dyn_release(got); scr_str_release(name);
  ScrDyn *builtin = scr_dyn_array_prototype_base(NULL);
  named_receiver = array; named_result = 0;
  named_accessor(builtin, "-7", false);
  name = S("-7");
  size_t before = named_gets;
  got = scr_dyn_typed_ref_key_get(first, name);
  check(got && got->kind == SCR_DYN_NUM && got->v.num == 42 && named_gets == before + 1 &&
      !memcmp(&saved, array, sizeof saved),
      "fresh published capsule invokes an inherited getter without native writes");
  scr_dyn_release(got);
  scr_dyn_key_delete(builtin, name, true);
  scr_str_release(name);
  ScrDyn *old_prototype = builtin->prototype ? scr_dyn_retain(builtin->prototype) : NULL;
  bool old_null_prototype = builtin->null_proto;
  ScrDyn *prototype = scr_dyn_new_obj();
  named_accessor(prototype, "0", false);
  scr_dyn_release(scr_dyn_set_prototype(builtin, prototype));
  name = S("0"); before = named_gets;
  check(!scr_dyn_has_own(first, name) && scr_dyn_in(first, name) && named_gets == before,
      "fresh published capsule inherited canonical presence never calls a getter");
  got = scr_dyn_typed_ref_key_get(first, name);
  check(got && got->kind == SCR_DYN_NUM && got->v.num == 42 && named_gets == before + 1 &&
      !memcmp(&saved, array, sizeof saved),
      "fresh published capsule canonical hole calls inherited getter without native writes");
  scr_dyn_release(got);
  /* Restore the fixture's exact implicit link; explicit Object.prototype
   * mutation is deliberately fenced by the public runtime API. */
  ScrDyn *replaced = builtin->prototype;
  builtin->prototype = old_prototype;
  builtin->null_proto = old_null_prototype;
  scr_dyn_release(replaced);
  scr_dyn_release(prototype); scr_dyn_release(builtin);
  check(!scr_exc_pending(), "published prototype proof restores its fixture without pending errors");
  scr_str_release(name); scr_dyn_release(first); named_receiver = NULL;
}

/* Parse `text`, expect success, return the checked-dynamic tree (+1). */
static ScrDyn *parse_ok(const char *text, const char *name) {
  ScrStr *t = S(text);
  ScrDyn *d = scr_json_parse(t);
  scr_str_release(t);
  check(d != NULL && !scr_exc_pending(), name);
  if (scr_exc_pending()) scr_exc_clear();
  return d;
}

/* Parse `text`, expect a throw; the message prints to stderr (asserted by
 * json.test.ts) which also clears the cell. */
static void parse_fail(const char *text, const char *name) {
  ScrStr *t = S(text);
  ScrDyn *d = scr_json_parse(t);
  scr_str_release(t);
  check(d == NULL && scr_exc_pending(), name);
  if (d) scr_dyn_release(d);
  if (scr_exc_pending()) scr_exc_print_uncaught();
}

static bool dyn_str_is(const ScrDyn *d, const char *want) {
  return d && d->kind == SCR_DYN_STR && str_is(d->v.str, want);
}

/* Low-level callback contracts that typed source does not expose: cyclic
 * dyn graphs, receiver lifetime during mutation, and runtime refusal paths.
 * Every temporary remains under the existing ASan and RC audit harness. */
static size_t callback_calls;
static int callback_mode;
static ScrDyn *callback_shared;

static ScrDyn *json_test_callback(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  callback_calls++;
  check(argc == 2, "JSON callback receives key and value");
  check(args[0]->kind == SCR_DYN_STR, "JSON callback key is a string");
  ScrDyn *holder = scr_dyn_this_get();
  check(holder->kind == SCR_DYN_OBJ || holder->kind == SCR_DYN_ARR || holder->kind == SCR_DYN_BYTES, "JSON callback holder bound");
  const ScrStr *key = args[0]->v.str;
  ScrDyn *value = args[1];
  if (callback_mode == 7 && (str_is(key, "0") || str_is(key, "1"))) {
    check(holder == callback_shared, "returned bytes remain the holder for indexed callbacks");
  }
  if (callback_mode == 1 && key->len) {
    scr_dyn_release(holder);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (callback_mode == 2 && str_is(key, "a")) {
    /* Reallocating the holder's entries must not invalidate traversal. */
    for (size_t i = 0; i < 80; i++) {
      char name[32];
      int length = snprintf(name, sizeof name, "new%zu", i);
      scr_dyn_obj_set(holder, name, (size_t)length, scr_dyn_new_num((double)i));
    }
    scr_dyn_obj_set(holder, "b", 1, scr_dyn_new_num(9));
  }
  if (callback_mode == 3 && key->len) {
    scr_throw_error_msg(SCR_ERR_TYPE, "callback", 8);
    scr_dyn_release(holder);
    return NULL;
  }
  if (callback_mode == 4 && str_is(key, "a")) {
    /* Release the original parent edge while its value is borrowed by the
     * callback. The walker must still own that original value. */
    scr_dyn_obj_set(holder, "a", 1, scr_dyn_new_null());
    check(value->kind == SCR_DYN_OBJ, "replaced child survives callback");
  }
  if (callback_mode == 5) {
    ScrDyn *replacement = scr_dyn_new_obj();
    scr_dyn_obj_set(replacement, "child", 5, scr_dyn_new_null());
    scr_dyn_release(holder);
    return replacement;
  }
  if ((callback_mode == 6 && key->len) || (callback_mode == 7 && str_is(key, "replace"))) {
    scr_dyn_release(holder);
    return scr_dyn_retain(callback_shared);
  }
  scr_dyn_release(holder);
  return scr_dyn_retain(value);
}

static ScrDyn *json_test_to_json(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  check(argc == 1, "toJSON receives only the property key");
  check(dyn_str_is(args[0], "nested"), "toJSON receives containing key");
  ScrDyn *holder = scr_dyn_this_get();
  check(holder == callback_shared, "toJSON receiver is the value");
  /* Drop the only owning property reference to this callable while it is
   * executing; the invocation must retain its closure independently. */
  scr_dyn_obj_set(holder, "toJSON", 6, scr_dyn_new_null());
  scr_dyn_release(holder);
  return scr_dyn_new_num(42);
}

static ScrDyn *json_test_func(ScrDynThunk thunk) {
  return scr_dyn_new_func(scr_closure_new(NULL, 0), thunk, 2, "JSON test callback", "json_test");
}

static ScrDyn *json_test_stringify(ScrDyn *value, ScrDyn *callback, const char *gap) {
  ScrStr *indent = S(gap);
  ScrDyn *out = scr_json_stringify_replacer(value, callback, indent);
  scr_str_release(indent);
  return out;
}

static ScrDyn *json_test_parse(const char *text, ScrDyn *callback) {
  ScrStr *input = S(text);
  ScrDyn *out = scr_json_parse_reviver(input, callback);
  scr_str_release(input);
  return out;
}

static void json_callback_tests(void) {
  ScrDyn *callback = json_test_func(json_test_callback);
  callback_mode = 0;
  callback_calls = 0;
  ScrDyn *value = parse_ok("{\"10\":10,\"2\":2,\"a\":[1,true,null]}", "callback input");
  ScrDyn *out = json_test_stringify(value, callback, "  ");
  check(dyn_str_is(out, "{\n  \"2\": 2,\n  \"10\": 10,\n  \"a\": [\n    1,\n    true,\n    null\n  ]\n}"), "replacer pretty output");
  check(callback_calls == 7, "replacer invokes once per property plus root");
  scr_dyn_release(out);
  scr_dyn_release(value);

  callback_mode = 1;
  value = parse_ok("{\"a\":1,\"b\":2}", "omission input");
  out = json_test_stringify(value, callback, "  ");
  check(dyn_str_is(out, "{}"), "all omitted properties have no blank lines");
  scr_dyn_release(out);
  scr_dyn_release(value);
  out = json_test_parse("{\"a\":1,\"b\":2}", callback);
  check(out && out->kind == SCR_DYN_OBJ && out->v.obj.len == 0, "reviver deletes actual object properties");
  scr_dyn_release(out);
  out = json_test_parse("[1]", callback);
  check(!out && scr_exc_pending(), "sparse reviver result refuses instead of returning a dense undefined");
  scr_exc_clear();

  callback_mode = 2;
  callback_calls = 0;
  value = parse_ok("{\"a\":1,\"b\":2}", "mutation input");
  out = json_test_stringify(value, callback, "");
  check(dyn_str_is(out, "{\"a\":1,\"b\":9}"), "replacer snapshots keys but reads current values");
  check(callback_calls == 3, "replacer skips keys added during traversal");
  scr_dyn_release(out);
  scr_dyn_release(value);
  callback_calls = 0;
  out = json_test_parse("{\"a\":1,\"b\":2}", callback);
  check(out && scr_dyn_obj_get(out, "b", 1)->v.num == 9, "reviver reads changed sibling");
  check(out && out->v.obj.len == 82, "reviver retains new properties without visiting them");
  check(callback_calls == 3, "reviver key snapshot survives realloc");
  scr_dyn_release(out);

  callback_mode = 4;
  value = parse_ok("{\"a\":{\"x\":1}}", "parent overwrite input");
  out = json_test_stringify(value, callback, "");
  check(dyn_str_is(out, "{\"a\":{\"x\":1}}"), "replacer owns value after edge replacement");
  check(scr_dyn_obj_get(value, "a", 1)->kind == SCR_DYN_NULL, "replacer mutation reaches holder");
  scr_dyn_release(out);
  scr_dyn_release(value);
  out = json_test_parse("{\"a\":{\"x\":1}}", callback);
  check(out && scr_dyn_obj_get(out, "a", 1)->kind == SCR_DYN_OBJ, "reviver returned value wins over holder assignment");
  scr_dyn_release(out);

  callback_mode = 0;
  callback_shared = scr_dyn_new_obj();
  scr_dyn_obj_set(callback_shared, "toJSON", 6, json_test_func(json_test_to_json));
  value = scr_dyn_new_obj();
  scr_dyn_obj_set(value, "nested", 6, scr_dyn_retain(callback_shared));
  out = json_test_stringify(value, callback, "");
  check(dyn_str_is(out, "{\"nested\":42}"), "toJSON precedes replacer and owns its callable");
  scr_dyn_release(out);
  scr_dyn_release(value);
  scr_dyn_release(callback_shared);
  callback_shared = NULL;

  /* Shared subtrees are not cycles. A true back-edge throws only after
   * the replacer gets its chance to replace that edge. Break it manually
   * after the test: dyn graphs do not use the typed cycle collector. */
  value = scr_dyn_new_obj();
  ScrDyn *shared = parse_ok("{\"n\":1}", "shared subtree");
  scr_dyn_obj_set(value, "a", 1, scr_dyn_retain(shared));
  scr_dyn_obj_set(value, "b", 1, scr_dyn_retain(shared));
  out = json_test_stringify(value, callback, "");
  check(dyn_str_is(out, "{\"a\":{\"n\":1},\"b\":{\"n\":1}}"), "DAG is not circular");
  scr_dyn_release(out);
  scr_dyn_release(shared);
  scr_dyn_release(value);
  value = scr_dyn_new_obj();
  scr_dyn_obj_set(value, "self", 4, scr_dyn_retain(value));
  callback_calls = 0;
  out = json_test_stringify(value, callback, "");
  check(!out && scr_exc_pending(), "cyclic replacer output throws");
  check(callback_calls == 2, "replacer observes cyclic edge before cycle error");
  scr_exc_clear();
  callback_mode = 1;
  out = json_test_stringify(value, callback, "");
  check(dyn_str_is(out, "{}"), "replacer may remove a cycle");
  scr_dyn_release(out);
  scr_dyn_obj_set(value, "self", 4, scr_dyn_new_null());
  scr_dyn_release(value);

  callback_mode = 5;
  value = scr_dyn_new_null();
  out = json_test_stringify(value, callback, "");
  check(!out && scr_exc_pending(), "ever-growing replacements hit a catchable depth limit");
  scr_exc_clear();
  scr_dyn_release(value);

  callback_mode = 6;
  callback_shared = scr_dyn_new_num(INFINITY);
  out = json_test_parse("{\"n\":0}", callback);
  check(out && scr_dyn_obj_get(out, "n", 1) == callback_shared, "reviver retains returned shared value");
  scr_dyn_release(out);
  scr_dyn_release(callback_shared);
  callback_shared = NULL;

  /* Branded buffers can enter the dyn tree from native stream callbacks.
   * Their pre-replacer toJSON differs from a buffer returned BY a replacer. */
  const uint8_t bytes[] = { 5, 6 };
  ScrBytes *storage = scr_bytes_from_data(bytes, sizeof bytes);
  callback_shared = scr_dyn_new_buffer(storage);
  scr_bytes_release(storage);
  callback_mode = 0;
  value = scr_dyn_new_obj();
  scr_dyn_obj_set(value, "buffer", 6, scr_dyn_retain(callback_shared));
  out = json_test_stringify(value, callback, "");
  check(dyn_str_is(out, "{\"buffer\":{\"type\":\"Buffer\",\"data\":[5,6]}}"), "branded buffer toJSON precedes callback");
  scr_dyn_release(out);
  scr_dyn_release(value);
  callback_mode = 7;
  value = parse_ok("{\"replace\":0}", "buffer replacement input");
  out = json_test_stringify(value, callback, "");
  check(dyn_str_is(out, "{\"replace\":{\"0\":5,\"1\":6}}"), "returned buffer does not rerun toJSON");
  scr_dyn_release(out);
  scr_dyn_release(value);
  scr_dyn_release(callback_shared);
  callback_shared = NULL;

  for (size_t i = 0; i < 100; i++) {
    callback_mode = 3;
    out = json_test_parse("{\"a\":[1,2],\"b\":3}", callback);
    check(!out && scr_exc_pending(), "reviver exception abandons all walk frames");
    scr_exc_clear();
    value = parse_ok("{\"a\":[1,2],\"b\":3}", "throw input");
    out = json_test_stringify(value, callback, "  ");
    check(!out && scr_exc_pending(), "replacer exception abandons output and walk frames");
    scr_exc_clear();
    scr_dyn_release(value);
    ScrDyn *receiver = scr_dyn_this_get();
    check(receiver->kind == SCR_DYN_UNDEF, "receiver stack restored after exception");
    scr_dyn_release(receiver);
  }
  callback_mode = 0;
  callback_calls = 0;
  out = json_test_parse("{\"a\":1,}", callback);
  check(!out && scr_exc_pending() && callback_calls == 0, "parse error never runs reviver");
  scr_exc_clear();
  out = json_test_parse("17", callback);
  check(out && out->kind == SCR_DYN_NUM && out->v.num == 17, "callback recovery after parse error");
  scr_dyn_release(out);
  scr_dyn_release(callback);
}

static void test_class_values(void) {
  ScrStr *name = S("Stored");
  ScrClassObj template = { .rc = SIZE_MAX, .name = name, .length = 2 };
  ScrClassObj *first = scr_classobj_new(&template, 1);
  first->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(first->caps[0], 42);
  ScrClassObj *second = scr_classobj_new(&template, 0);
  ScrDyn *a = scr_dyn_new_class(first, "classval:Stored");
  ScrDyn *again = scr_dyn_new_class(first, "classval:Stored");
  ScrDyn *b = scr_dyn_new_class(second, "classval:Stored");
  scr_classobj_release(first);
  scr_classobj_release(second);
  check(scr_dyn_strict_eq(a, again) && !scr_dyn_strict_eq(a, b), "boxed class identity belongs to evaluation");
  ScrClassObj *restored = scr_dyn_class_check(a, "classval:Stored", NULL);
  check(restored && scr_box_get_f64(restored->caps[0]) == 42, "boxed class retains captured environment");
  scr_classobj_release(restored);
  check(!scr_dyn_class_check(a, "classval:Other", NULL) && scr_exc_pending(), "class casts check native constructor type");
  scr_exc_clear();
  ScrDyn *arity = scr_dyn_fn_get(a, "length", 6);
  check(arity && arity->kind == SCR_DYN_NUM && arity->v.num == 2, "boxed constructor length");
  scr_dyn_release(arity);
  check(!scr_dyn_call(a, NULL, 0, "Stored") && scr_exc_pending(), "class call requires new");
  scr_exc_clear();
  check(!scr_dyn_obj_keys(a) && scr_exc_pending(), "class reflection refuses an incomplete property view");
  scr_exc_clear();
  scr_dyn_release(a);
  scr_dyn_release(again);
  scr_dyn_release(b);
  scr_str_release(name);
}

static void test_primitive_owners(void) {
  ScrDyn *values[] = {scr_dyn_new_null(), scr_dyn_new_bool(false), scr_dyn_new_bool(true)};
  const char *texts[] = {"null", "false", "true"};
  for (size_t i = 0; i < 3; i++) {
    ScrDyn *parsed = parse_ok(texts[i], "primitive parses");
    check(parsed == values[i] && parsed->rc == SIZE_MAX, "primitive parser shares immortal owner");
    ScrDyn *array = scr_dyn_new_arr();
    scr_dyn_arr_push(array, parsed);
    scr_dyn_arr_push(array, scr_dyn_retain(values[i]));
    /* The cycle tracer must skip immortal children before reading a header. */
    scr_dyn_arr_push(array, scr_dyn_retain(array));
    scr_dyn_release(array);
    scr_collect_cycles();
    check(scr_dyn_retain(values[i]) == values[i], "primitive survives container collection");
    scr_dyn_release(values[i]);
    check(values[i]->rc == SIZE_MAX, "primitive ownership transfers preserve immortality");
    scr_dyn_release(scr_dyn_prevent_extensions(values[i]));
    scr_dyn_release(scr_dyn_seal(values[i]));
    check(!values[i]->non_extensible && !values[i]->prototype && !values[i]->symbol_properties,
          "primitive reflection leaves shared nodes unchanged");
  }
  check(!scr_dyn_strict_eq(values[1], values[2]), "boolean singleton values remain distinct");
}


static void array_named_check(bool condition, const char *operation) {
  check(condition && !scr_exc_pending(), operation);
  if (!condition || scr_exc_pending()) {
    if (scr_exc_pending()) scr_exc_print_uncaught();
    exit(EXIT_FAILURE);
  }
}
static bool array_named_has_own(ScrDyn *value, ScrDyn *key) {
  bool own = scr_dyn_has_own_computed(value, key);
  array_named_check(true, "named property presence does not throw");
  return own;
}
static void array_named_warm(ScrDyn *value) {
  ScrDyn *view = scr_dyn_typed_ref_materialize(value);
  array_named_check(view && view->kind == SCR_DYN_ARR,
      "native property alias warmup returns an array");
  scr_dyn_release(view);
}

static void array_named_value(ScrDyn *value) {
  array_named_check(value != NULL, "named property Get returns without an exception");
  if (!value) printf("null");
  else if (value->kind == SCR_DYN_NUM) printf("%.0f", value->v.num);
  else if (value->kind == SCR_DYN_UNDEF) printf("u");
  else printf("kind%d", value->kind);
  scr_dyn_release(value);
}
static void array_named_keys(ScrDyn *value) {
  ScrDyn *keys = scr_dyn_own_keys(value);
  array_named_check(keys && keys->kind == SCR_DYN_ARR, "named property ownKeys returns an array");
  if (keys && keys->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      ScrDyn *key = keys->v.arr.items[i];
      if (i) printf(",");
      if (key->kind == SCR_DYN_SYMBOL) printf("sym");
      else if (key->kind == SCR_DYN_STR) printf("%.*s", (int)key->v.str->len, key->v.str->data);
    }
  }
  scr_dyn_release(keys);
}
/* Distinct adapter identities keep two caches warm over one native referent.
 * Both those aliases and numeric typed access must observe one property owner. */
static void array_named_oracle(void) {
  const char *names[] = {"extra", "-1", "1.5", "NaN", "Infinity", "4294967295", "-0"};
  for (int native = 0; native < 2; native++) for (int route = 0; route < 3; route++)
  for (int k = 0; k < 8; k++) {
    ScrArr *storage = scr_arr_new_small(SCR_ELEM_F64);
    ScrDyn *first = native ? prototype_array_capsule(storage, false) : scr_dyn_new_arr();
    ScrDyn *alias = native ? prototype_array_capsule(storage, true) : scr_dyn_retain(first);
    if (native) {
      array_named_check(first != alias && scr_dyn_strict_eq(first, alias), "native property aliases use distinct capsules for the same referent");
      array_named_warm(first);
      array_named_warm(alias);
    }
    ScrDyn *key;
    if (k == 7) {
      ScrSym *symbol = scr_sym_new(NULL);
      key = scr_dyn_new_symbol(symbol); scr_sym_release(symbol);
    } else {
      ScrStr *name = S(names[k]); key = scr_dyn_new_str(name); scr_str_release(name);
    }
    ScrDyn *value = scr_dyn_new_num(9);
    bool ok = true;
    if (route == 0) {
      if (k == 7) scr_dyn_symbol_key_set(first, key, value);
      else scr_dyn_key_set(first, key->v.str, value);
    } else if (route == 1) {
      ScrDyn *descriptor = scr_dyn_new_obj();
      scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
      scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
      scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
      scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
      ScrDyn *defined = scr_dyn_define_property(first, key, descriptor);
      ok = defined != NULL; scr_dyn_release(defined); scr_dyn_release(descriptor);
    } else {
      ScrDyn *target = scr_dyn_new_obj();
      ok = scr_dyn_reflect_set(target, key, value, first); scr_dyn_release(target);
    }
    char error = array_property_error();
    printf("M|%d|%d|%d|%d|%c|%d|", native, route, k, ok, error, array_named_has_own(first, key));
    array_named_value(scr_dyn_reflect_get(first, key, first));
    printf("|%d|", array_named_has_own(alias, key));
    array_named_value(scr_dyn_reflect_get(alias, key, alias));
    ScrDyn *descriptor = scr_dyn_get_own_property_descriptor(alias, key);
    array_named_check(true, "named property descriptor inspection does not throw");
    if (descriptor && descriptor->kind == SCR_DYN_OBJ) {
      ScrDyn *w = scr_dyn_obj_get(descriptor, "writable", 8);
      ScrDyn *e = scr_dyn_obj_get(descriptor, "enumerable", 10);
      ScrDyn *d = scr_dyn_obj_get(descriptor, "configurable", 12);
      printf("|%d%d%d|", w && scr_dyn_truthy(w), e && scr_dyn_truthy(e), d && scr_dyn_truthy(d));
    } else printf("|---|");
    scr_dyn_release(descriptor);
    array_named_keys(alias);
    scr_dyn_key_delete_computed(alias, key, true);
    error = array_property_error();
    bool firstOwn = array_named_has_own(first, key);
    bool aliasOwn = array_named_has_own(alias, key);
    printf("|%c|%d|%d\n", error, firstOwn, aliasOwn);
    scr_dyn_release(value); scr_dyn_release(key); scr_dyn_release(alias); scr_dyn_release(first); scr_arr_release(storage);
  }
  const double numbers[] = {-1, 1.5, NAN, INFINITY, 4294967295.0};
  for (int k = 0; k < 5; k++) {
    ScrArr *storage = scr_arr_new_small(SCR_ELEM_F64);
    ScrDyn *first = prototype_array_capsule(storage, false);
    ScrDyn *alias = prototype_array_capsule(storage, true);
    array_named_check(first != alias && scr_dyn_strict_eq(first, alias), "numeric property aliases use distinct capsules for the same referent");
    array_named_warm(first);
    array_named_warm(alias);
    scr_arr_set_f64(storage, numbers[k], 7);
    array_named_check(true, "typed numeric property setup does not throw");
    ScrStr *name = S(names[k + 1]); ScrDyn *key = scr_dyn_new_str(name); scr_str_release(name);
    printf("N|%d|%d|", k, array_named_has_own(first, key));
    array_named_value(scr_dyn_reflect_get(first, key, first));
    ScrDyn *value = scr_dyn_new_num(9); scr_dyn_key_set(first, key->v.str, value);
    char error = array_property_error();
    double typedValue = scr_arr_get_f64(storage, numbers[k]);
    array_named_check(true, "typed numeric property Get does not throw");
    printf("|%c|%.0f|", error, typedValue);
    array_named_value(scr_dyn_reflect_get(alias, key, alias));
    printf("|"); array_named_keys(alias);
    scr_dyn_key_delete_computed(alias, key, true); error = array_property_error();
    bool typedOwn = scr_arr_has(storage, numbers[k]);
    array_named_check(true, "typed numeric property presence does not throw");
    printf("|%c|%d\n", error, typedOwn);
    scr_dyn_release(value); scr_dyn_release(key); scr_dyn_release(alias); scr_dyn_release(first); scr_arr_release(storage);
  }
}

static bool array_integrity_length_writable(ScrDyn *value) {
  ScrStr *name = S("length");
  ScrDyn *key = scr_dyn_new_str(name); scr_str_release(name);
  ScrDyn *descriptor = scr_dyn_get_own_property_descriptor(value, key);
  bool writable = descriptor && scr_dyn_truthy(scr_dyn_obj_get(descriptor, "writable", 8));
  scr_dyn_release(descriptor); scr_dyn_release(key);
  return writable;
}

/* Native entry points are compared against Node, including the already-frozen
 * empty/holey case whose writable length survives a later freeze call. */
static void array_integrity_oracle(void) {
  for (int kind = 0; kind < 11; kind++) for (int pre = 0; pre < 3; pre++) {
    ScrArr *array = scr_arr_new(SCR_ELEM_F64, 0);
    if (kind != 0) scr_arr_set_len(array, kind == 3 ? 1000002 : 3);
    if (kind == 2) scr_arr_set_f64(array, 0, 7);
    if (kind == 3) scr_arr_set_f64(array, 1000000, 7);
    if (kind == 4) scr_arr_set_undefined(array, 1);
    ScrDyn *first = prototype_array_capsule(array, false);
    ScrDyn *alias = prototype_array_capsule(array, true);
    named_receiver = array;
    size_t gets = named_gets, materializations = live_array_materializations;
    if (kind >= 5) {
      ScrDyn *key;
      if (kind >= 8) {
        ScrSym *symbol = scr_sym_new(NULL);
        key = scr_dyn_new_symbol(symbol); scr_sym_release(symbol);
      } else {
        ScrStr *name = S("-1"); key = scr_dyn_new_str(name); scr_str_release(name);
      }
      ScrDyn *descriptor = scr_dyn_new_obj();
      bool accessor = kind == 7 || kind == 10;
      if (accessor)
        scr_dyn_obj_set(descriptor, "get", 3,
            scr_dyn_new_func(scr_closure_new(NULL, 0), named_getter, 0, "getter", "named_getter"));
      else {
        scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(9));
        scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(kind == 5 || kind == 8));
      }
      scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
      scr_dyn_release(scr_dyn_define_property(first, key, descriptor));
      scr_dyn_release(descriptor); scr_dyn_release(key);
    }
    ScrDyn *result = pre == 0 ? NULL : pre == 1
        ? scr_dyn_prevent_extensions(first) : scr_dyn_seal(first);
    if (pre) check(result == first, "integrity mutator returns its original capsule");
    scr_dyn_release(result);
    bool extensible = scr_dyn_is_extensible(alias), sealed = scr_dyn_is_sealed(alias);
    bool frozen = scr_dyn_is_frozen(alias);
    check(live_array_materializations == materializations,
        "preventExtensions, seal and integrity queries do not materialize a snapshot");
    printf("I|%d|%d|%d%d%d%d|", kind, pre, extensible, sealed, frozen,
        array_integrity_length_writable(alias));
    materializations = live_array_materializations;
    result = scr_dyn_freeze(first);
    check(result == first, "freeze returns its original capsule");
    scr_dyn_release(result);
    extensible = scr_dyn_is_extensible(alias); sealed = scr_dyn_is_sealed(alias);
    frozen = scr_dyn_is_frozen(alias);
    check(live_array_materializations == materializations,
        "freeze and integrity queries do not materialize a snapshot");
    printf("%d%d%d%d|", extensible, sealed, frozen, array_integrity_length_writable(alias));
    ScrStr *name = S("length"); ScrDyn *key = scr_dyn_new_str(name); scr_str_release(name);
    ScrDyn *length = scr_dyn_new_num(array->len + 1);
    bool grew = scr_dyn_reflect_set(alias, key, length, alias);
    printf("%d|%zu\n", grew, array->len);
    check(!scr_exc_pending() && named_gets == gets,
        "integrity and length descriptor operations never invoke getters");
    scr_dyn_release(length); scr_dyn_release(key);
    scr_dyn_release(first); scr_dyn_release(alias); scr_arr_release(array);
  }
  named_receiver = NULL;
}

int main(int argc, char **argv) {
  test_class_values();
  scr_init();
  if (argc == 2 && strncmp(argv[1], "--array-slot-trap-", 18) == 0) {
    ScrArr *array = scr_arr_new(SCR_ELEM_F64, 0);
    ScrDyn *view = prototype_array_capsule(array, false);
    named_receiver = array;
    named_accessor(view, "-1", false);
    named_result = 5;
    if (strcmp(argv[1] + 18, "f64") == 0) (void)scr_arr_get_slot_f64(array, -1);
    else if (strcmp(argv[1] + 18, "bool") == 0) (void)scr_arr_get_slot_bool(array, -1);
    else if (strcmp(argv[1] + 18, "ref") == 0) (void)scr_arr_get_slot_ref(array, -1);
    else (void)scr_arr_borrow_slot_ref(array, -1);
    fprintf(stderr, "FAIL raw slot returned after %zu getter calls\n", named_gets);
    return 42;
  }
  if (argc == 2 && strcmp(argv[1], "--exact-function-extraction") == 0) {
    exact_function_extraction_tests();
    printf("%d/%d checks passed\n", checks - failures, checks);
    return failures == 0 ? 0 : 1;
  }
  if (argc == 2 && strcmp(argv[1], "--array-properties-oracle") == 0) {
    array_property_oracle();
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--array-mutations-oracle") == 0) {
    array_mutation_oracle();
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--array-property-ownership") == 0) {
    array_property_ownership_tests();
    printf("%d/%d checks passed\n", checks - failures, checks);
    return failures == 0 ? 0 : 1;
  }
  if (argc == 2 && strcmp(argv[1], "--array-prototype-ownership") == 0) {
    array_prototype_ownership_tests();
    printf("%d/%d checks passed\n", checks - failures, checks);
    return failures == 0 ? 0 : 1;
  }
  if (argc == 2 && strcmp(argv[1], "--array-integrity-oracle") == 0) {
    array_integrity_oracle();
    return failures == 0 ? 0 : 1;
  }
  if (argc == 2 && strcmp(argv[1], "--array-named-oracle") == 0) {
    array_named_oracle();
    return failures == 0 ? 0 : 1;
  }
  if (argc == 2 && strcmp(argv[1], "--reflect-array-oracle") == 0) {
    reflect_array_oracle();
    return failures == 0 ? 0 : 1;
  }
  if (argc == 2 && strcmp(argv[1], "--array-named-boundary") == 0) {
    array_named_promotion_tests();
    array_named_access_tests();
    array_named_integrity_tests();
    array_named_publication_tests();
    printf("%d/%d checks passed\n", checks - failures, checks);
    return failures == 0 ? 0 : 1;
  }
  test_primitive_owners();

  /* ── primitives ─────────────────────────────────────────────────── */
  ScrDyn *d = parse_ok("null", "parse null");
  check(d->kind == SCR_DYN_NULL, "null kind");
  scr_dyn_release(d);

  d = parse_ok("true", "parse true");
  check(d->kind == SCR_DYN_BOOL && d->v.b, "true value");
  scr_dyn_release(d);
  d = parse_ok("false", "parse false");
  check(d->kind == SCR_DYN_BOOL && !d->v.b, "false value");
  scr_dyn_release(d);

  d = parse_ok(" -12.5e2 ", "parse number with ws");
  check(d->kind == SCR_DYN_NUM && d->v.num == -1250.0, "number value");
  scr_dyn_release(d);
  d = parse_ok("0", "parse zero");
  check(d->kind == SCR_DYN_NUM && d->v.num == 0, "zero value");
  scr_dyn_release(d);
  d = parse_ok("1e308", "parse big");
  check(d->kind == SCR_DYN_NUM && d->v.num == 1e308, "big value");
  scr_dyn_release(d);
  d = parse_ok("1e999", "parse overflow to Infinity"); /* like JS */
  check(d->kind == SCR_DYN_NUM && isinf(d->v.num), "overflow is Infinity");
  scr_dyn_release(d);

  /* ── strings and escapes ────────────────────────────────────────── */
  d = parse_ok("\"a\\\"b\\\\c\\/d\\b\\f\\n\\r\\t\"", "parse escapes");
  check(dyn_str_is(d, "a\"b\\c/d\b\f\n\r\t"), "escape values");
  scr_dyn_release(d);

  d = parse_ok("\"\\u0041\\u00e9\\u65e5\"", "parse \\u BMP");
  check(dyn_str_is(d, "A\xC3\xA9\xE6\x97\xA5"), "\\u BMP encodes UTF-8");
  scr_dyn_release(d);

  d = parse_ok("\"\\uD83D\\uDE00\"", "parse surrogate pair");
  check(dyn_str_is(d, "\xF0\x9F\x98\x80"), "surrogate pair combines");
  scr_dyn_release(d);

  /* Lone surrogates stay lone, as WTF-8, like JS. */
  d = parse_ok("\"x\\uD800y\"", "parse lone high surrogate");
  check(dyn_str_is(d, "x\xED\xA0\x80y"), "lone high surrogate kept");
  scr_dyn_release(d);
  d = parse_ok("\"\\uDC00\"", "parse lone low surrogate");
  check(dyn_str_is(d, "\xED\xB0\x80"), "lone low surrogate kept");
  scr_dyn_release(d);
  /* High surrogate followed by a non-surrogate escape: the lone high, then
   * the escape parses normally. */
  d = parse_ok("\"\\uD800\\u0041\"", "high surrogate then BMP escape");
  check(dyn_str_is(d, "\xED\xA0\x80" "A"), "lone high then A");
  scr_dyn_release(d);
  /* A raw lone high surrogate before an escaped low one forms the pair. */
  d = parse_ok("\"\xED\xA0\xBD\\uDE00\"", "raw high then escaped low");
  check(dyn_str_is(d, "\xF0\x9F\x98\x80"), "halves form the pair");
  scr_dyn_release(d);

  /* Raw UTF-8 passes through. */
  d = parse_ok("\"caf\xC3\xA9\"", "parse raw UTF-8");
  check(dyn_str_is(d, "caf\xC3\xA9"), "raw UTF-8 preserved");
  scr_dyn_release(d);

  /* ── arrays and objects ─────────────────────────────────────────── */
  d = parse_ok("[1, [2, []], \"three\"]", "parse nested array");
  check(d->kind == SCR_DYN_ARR && d->v.arr.len == 3, "array len");
  check(d->v.arr.items[0]->v.num == 1, "arr[0]");
  check(d->v.arr.items[1]->kind == SCR_DYN_ARR && d->v.arr.items[1]->v.arr.len == 2,
        "arr[1] nested");
  check(dyn_str_is(d->v.arr.items[2], "three"), "arr[2] string");
  scr_dyn_release(d);

  d = parse_ok("{\"a\":1,\"b\":{\"c\":[true]},\"a\":2}", "parse object");
  check(d->kind == SCR_DYN_OBJ && d->v.obj.len == 2, "dup keys collapse");
  const ScrDyn *m = scr_dyn_obj_get(d, "a", 1);
  check(m != NULL && m->kind == SCR_DYN_NUM && m->v.num == 2, "later dup key wins");
  m = scr_dyn_obj_get(d, "b", 1);
  check(m != NULL && m->kind == SCR_DYN_OBJ, "nested object");
  check(scr_dyn_obj_get(d, "zz", 2) == NULL, "absent key is NULL");
  scr_dyn_release(d);

  d = parse_ok("{}", "parse empty object");
  check(d->v.obj.len == 0, "empty object");
  scr_dyn_release(d);
  d = parse_ok("[]", "parse empty array");
  check(d->v.arr.len == 0, "empty array");
  scr_dyn_release(d);

  /* ── retain/release semantics ───────────────────────────────────── */
  d = parse_ok("[1,2]", "rc probe");
  ScrDyn *alias = scr_dyn_retain(d);
  scr_dyn_release(d);
  check(alias->v.arr.len == 2, "alias survives first release");
  scr_dyn_release(alias);

  /* ── parse errors (exact OUR-string messages, printed to stderr) ── */
  parse_fail("", "empty input fails");
  parse_fail("   ", "blank input fails");
  parse_fail("{oops", "bad token fails");
  parse_fail("[1,2,", "unterminated array fails");
  parse_fail("[1 2]", "missing comma fails");
  parse_fail("{\"a\"}", "missing colon fails");
  parse_fail("{\"a\":1,}", "trailing comma fails");
  parse_fail("{1:2}", "non-string key fails");
  parse_fail("\"unterminated", "unterminated string fails");
  parse_fail("\"bad \\q\"", "bad escape fails");
  parse_fail("\"ctrl \n\"", "control char in string fails");
  parse_fail("\"\\u12G4\"", "bad unicode escape fails");
  parse_fail("-", "lone minus fails");
  parse_fail("1.", "bare fraction fails");
  parse_fail("1e+", "empty exponent fails");
  parse_fail("1 2", "trailing content fails");
  parse_fail("nul", "truncated literal fails");

  /* Depth cap: 1001 nested arrays throw (catchably) instead of smashing
   * the native stack. */
  {
    size_t n = 1001;
    char *deep = malloc(2 * n + 2);
    for (size_t i = 0; i < n; i++) deep[i] = '[';
    deep[n] = '1';
    for (size_t i = 0; i < n; i++) deep[n + 1 + i] = ']';
    deep[2 * n + 1] = '\0';
    ScrStr *t = scr_str_new(deep, 2 * n + 1);
    free(deep);
    ScrDyn *too = scr_json_parse(t);
    scr_str_release(t);
    check(too == NULL && scr_exc_pending(), "depth cap throws");
    if (scr_exc_pending()) scr_exc_print_uncaught();
  }

  /* ── dynCheck failure messages (the emitted builders' shared path) ── */
  {
    ScrDyn *got = parse_ok("\"nope\"", "fail-path operand");
    ScrDynPath root = { NULL, "items", 0 };
    ScrDynPath idx = { &root, NULL, 2 };
    ScrDynPath leaf = { &idx, "price", 0 };
    scr_dyn_check_fail(&leaf, "number", got);
    check(scr_exc_pending(), "check_fail throws");
    scr_exc_print_uncaught(); /* "TypeError: expected number at $.items[2].price, got string" */
    scr_dyn_check_fail(NULL, "object", NULL);
    scr_exc_print_uncaught(); /* "TypeError: expected object at $, got undefined" */
    scr_dyn_release(got);
  }

  /* ── stringify buffer ───────────────────────────────────────────── */
  {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_putc(&b, '[');
    scr_jb_put_f64(&b, 0.0 / 0.0);
    scr_jb_putc(&b, ',');
    scr_jb_put_f64(&b, 1.0 / 0.0);
    scr_jb_putc(&b, ',');
    scr_jb_put_f64(&b, -0.0);
    scr_jb_putc(&b, ',');
    scr_jb_put_f64(&b, 0.1 + 0.2);
    scr_jb_putc(&b, ',');
    ScrStr *tricky = S("q\" b\\ n\n t\t ctl\x01 caf\xC3\xA9");
    scr_jb_put_json_str(&b, tricky);
    scr_str_release(tricky);
    scr_jb_putc(&b, ']');
    ScrStr *out = scr_jb_finish(&b);
    check(str_is(out,
                 "[null,null,0,0.30000000000000004,"
                 "\"q\\\" b\\\\ n\\n t\\t ctl\\u0001 caf\xC3\xA9\"]"),
          "stringify buffer output");
    scr_str_release(out);
  }

  json_callback_tests();
  exact_function_extraction_tests();
  typed_view_failure_tests();
  array_property_ownership_tests();
  array_prototype_ownership_tests();
  array_prototype_tests();
  opaque_accessor_tests();
  compound_mutation_callback_tests();
  function_array_mutation_tests();
  array_mutation_scan_tests();
  opaque_compound_mutation_tests();
  array_prototype_chain_tests();
  array_prototype_callback_tests();
  live_array_ref_tests();
  live_record_ref_tests();
  object_assign_live_tests();
  descriptor_phase_tests();
  descriptor_variant_tests();
  reflect_receiver_tests();
  array_named_oracle();
  array_integrity_oracle();
  reflect_lifetime_tests();
  array_named_promotion_tests();
  array_named_access_tests();
  array_named_integrity_tests();
  array_named_publication_tests();

  printf("%d/%d checks passed\n", checks - failures, checks);
  return failures == 0 ? 0 : 1;
}
