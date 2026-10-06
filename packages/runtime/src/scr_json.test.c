#include "scr_runtime.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void);
long scr_dyn_key_live_count(void);
#endif

static void put(ScrDyn *map, ScrDyn *key, ScrDyn *value) {
  ScrDyn *args[] = {key, value};
  ScrDyn *result = scr_dyn_handle_ops_of(map)->invoke(map->v.handle.ptr, map, "set", args, 2, "map.set");
  assert(result == map && !scr_exc_pending());
  scr_dyn_release(result);
}

static void erase(ScrDyn *map, ScrDyn *key) {
  ScrDyn *result = scr_dyn_handle_ops_of(map)->invoke(map->v.handle.ptr, map, "delete", &key, 1, "map.delete");
  assert(result && result->kind == SCR_DYN_BOOL && result->v.b && !scr_exc_pending());
  scr_dyn_release(result);
}

static ScrDyn *nothing(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_dyn_retain(scr_dyn_undefined());
}

static void json_string_boundaries(void) {
  /* Every escape/control at every word alignment, followed by raw UTF-8.
   * ASan also checks short tails that cannot supply a complete word. */
  const char suffix[] = "tail\xF0\x9F\x99\x82\xE9\x9B\xAA";
  for (size_t prefix = 0; prefix < 64; prefix++) {
    for (unsigned special = 0; special < 34; special++) {
      char bytes[96];
      memset(bytes, 'a', prefix);
      bytes[prefix] = special < 32 ? (char)special : special == 32 ? '"' : '\\';
      memcpy(bytes + prefix + 1, suffix, sizeof suffix - 1);
      size_t length = prefix + sizeof suffix;
      ScrStr *original = scr_str_new(bytes, length);
      ScrJsonBuf buffer;
      scr_jb_init(&buffer);
      scr_jb_put_json_str(&buffer, original);
      ScrStr *encoded = scr_jb_finish(&buffer);
      ScrDyn *parsed = scr_json_parse(encoded);
      assert(parsed && parsed->kind == SCR_DYN_STR && !scr_exc_pending());
      assert(scr_str_eq(original, parsed->v.str));
      scr_dyn_release(parsed);
      scr_str_release(encoded);
      scr_str_release(original);

      if (special < 32) {
        char invalid[68];
        invalid[0] = '"';
        memset(invalid + 1, 'a', prefix);
        invalid[prefix + 1] = (char)special;
        invalid[prefix + 2] = '"';
        ScrStr *input = scr_str_new(invalid, prefix + 3);
        assert(!scr_json_parse(input) && scr_exc_pending());
        scr_exc_clear();
        scr_str_release(input);
      }
    }
    char plain[68];
    plain[0] = '"';
    memset(plain + 1, 'z', prefix);
    plain[prefix + 1] = '"';
    ScrStr *input = scr_str_new(plain, prefix + 2);
    ScrDyn *parsed = scr_json_parse(input);
    assert(parsed && parsed->v.str->len == prefix && !scr_exc_pending());
    scr_dyn_release(parsed);
    scr_str_release(input);
    input = scr_str_new(plain, prefix + 1);
    assert(!scr_json_parse(input) && scr_exc_pending());
    scr_exc_clear();
    scr_str_release(input);
  }
}

static void json_indent_ownership(void) {
  const char compact[] = "{\"a\":[],\"b\":[1,{}]}";
  const char expected[] = "{\n  \"a\": [],\n  \"b\": [\n    1,\n    {}\n  ]\n}";
  ScrStr *input = scr_str_new(compact, sizeof compact - 1);
  ScrStr *same = scr_json_indent(input, "", 0);
  assert(same == input && input->rc == 2);
  scr_str_release(same);
  ScrStr *pretty = scr_json_indent(input, "  ", 2);
  assert(pretty->len == sizeof expected - 1);
  assert(!memcmp(pretty->data, expected, sizeof expected - 1));
  scr_str_release(input);
  assert(!memcmp(pretty->data, expected, sizeof expected - 1));
  scr_str_release(pretty);
}

static void checked_storage(void) {
  /* Reuse after deletion, changing field order, embedded NUL and escaped
   * duplicate names must leave independently owned keys and values. */
  for (int round = 0; round < 100; round++) {
    const char *text = round % 2 ? "{\"alpha\":1,\"beta\":2,\"gamma\":3}"
      : "{\"gamma\":3,\"alpha\":0,\"\\u0061lpha\":1,\"beta\":2}";
    ScrStr *input = scr_str_new(text, strlen(text));
    ScrDyn *object = scr_json_parse(input);
    scr_str_release(input);
    assert(object && object->v.obj.len == 3);
    assert(scr_dyn_obj_get(object, "alpha", 5)->v.num == 1);
    ScrStr *key = scr_str_new("beta", 4);
    scr_dyn_key_delete(object, key, true);
    scr_str_release(key);
    assert(!scr_dyn_obj_get(object, "beta", 4));
    assert(scr_dyn_obj_get(object, "gamma", 5)->v.num == 3);
    char mutable_key[] = "new\0key";
    scr_dyn_obj_set(object, mutable_key, sizeof mutable_key - 1, scr_dyn_new_num(4));
    mutable_key[0] = 'x';
    assert(scr_dyn_obj_get(object, "new\0key", 7)->v.num == 4);
    scr_dyn_release(object);
  }
  /* Larger objects and long names leave no stale pooled tail keys when a
   * later small object grows through the same capacity. */
  for (int round = 0; round < 4; round++) {
    ScrDyn *object = scr_dyn_new_obj();
    for (int i = 0; i < 80; i++) {
      char key[160];
      memset(key, 'a' + i % 20, sizeof key);
      int prefix = snprintf(key, sizeof key, "%d:", i);
      memset(key + prefix, 'a' + i % 20, sizeof key - (size_t)prefix);
      scr_dyn_obj_set(object, key, sizeof key, scr_dyn_new_num(i));
      assert(scr_dyn_obj_get(object, key, sizeof key)->v.num == i);
    }
    scr_dyn_release(object);
  }
  /* Cross index growth boundaries, invalidate moved entry positions, then
   * recreate the index from survivors. Repeat after pool reuse. */
  for (int round = 0; round < 4; round++) {
    ScrDyn *object = scr_dyn_new_obj();
    assert(!object->v.obj.index);
    for (int i = 0; i < 129; i++) {
      char key[16];
      int length = snprintf(key, sizeof key, "key-%d", i);
      scr_dyn_obj_set(object, key, (size_t)length, scr_dyn_new_num(i));
      assert((object->v.obj.index != NULL) == (i >= 31));
    }
    for (int i = 0; i < 129; i++) {
      char key[16];
      int length = snprintf(key, sizeof key, "key-%d", i);
      assert(scr_dyn_obj_get(object, key, (size_t)length)->v.num == i);
      if (i % 3 == 0) {
        ScrStr *name = scr_str_new(key, (size_t)length);
        scr_dyn_key_delete(object, name, true);
        scr_str_release(name);
        assert(!scr_dyn_obj_get(object, key, (size_t)length));
      }
    }
    scr_dyn_obj_set(object, "last", 4, scr_dyn_new_num(129));
    assert(object->v.obj.index);
    for (int i = 0; i < 129; i++) {
      char key[16];
      int length = snprintf(key, sizeof key, "key-%d", i);
      ScrDyn *value = scr_dyn_obj_get(object, key, (size_t)length);
      assert(i % 3 == 0 ? value == NULL : value && value->v.num == i);
    }
    scr_dyn_obj_set(object, "key-128", 7, scr_dyn_new_num(900));
    assert(object->v.obj.len == 87);
    assert(scr_dyn_obj_get(object, "key-128", 7)->v.num == 900);
    scr_dyn_release(object);
  }
  /* A direct step is authorized only by the captured builtin method. */
  ScrDyn *source = scr_dyn_new_arr();
  scr_dyn_arr_push(source, scr_dyn_new_num(7));
  scr_dyn_arr_push(source, scr_dyn_retain(scr_dyn_undefined()));
  ScrStr *spell = scr_str_new("source", 6);
  ScrDyn *iterator = scr_dyn_iterator(source, spell);
  scr_str_release(spell);
  ScrDyn *next = scr_dyn_handle_ops_of(iterator)->get(iterator->v.handle.ptr, "next", 4);
  assert(scr_dyn_iterator_can_step(iterator, next));
  assert(!scr_dyn_iterator_can_step(source, next));
  assert(!scr_dyn_iterator_can_step(iterator, scr_dyn_undefined()));
  ScrDyn *item = scr_dyn_iterator_step(iterator);
  assert(item->v.num == 7 && !scr_dyn_iterator_step_done(iterator));
  scr_dyn_release(item);
  item = scr_dyn_iterator_step(iterator);
  assert(item->kind == SCR_DYN_UNDEF && !scr_dyn_iterator_step_done(iterator));
  scr_dyn_release(item);
  scr_dyn_arr_push(source, scr_dyn_new_num(9));
  item = scr_dyn_iterator_step(iterator);
  assert(item->v.num == 9 && !scr_dyn_iterator_step_done(iterator));
  scr_dyn_release(item);
  item = scr_dyn_iterator_step(iterator);
  assert(item->kind == SCR_DYN_UNDEF && scr_dyn_iterator_step_done(iterator));
  scr_dyn_release(item);
  scr_dyn_arr_push(source, scr_dyn_new_num(11));
  item = scr_dyn_iterator_step(iterator);
  assert(item->kind == SCR_DYN_UNDEF && scr_dyn_iterator_step_done(iterator));
  scr_dyn_release(item);
  scr_dyn_release(next);
  scr_dyn_release(iterator);
  scr_dyn_release(source);
  assert(!scr_exc_pending());
}

static void shared_property_keys(void) {
#ifdef SCR_RC_AUDIT
  long before = scr_dyn_key_live_count();
#endif
  /* Distinct objects share bytes, not values or property attributes. Key
   * deletion, a collected owner and a caller-owned input cannot invalidate
   * the surviving entry. */
  ScrDyn *first = scr_dyn_new_obj(), *second = scr_dyn_new_obj();
  char key[] = "shared\0name";
  scr_dyn_obj_set(first, key, sizeof key - 1, scr_dyn_new_num(1));
  scr_dyn_obj_set(second, key, sizeof key - 1, scr_dyn_new_num(2));
  assert(first->v.obj.entries[0].key == second->v.obj.entries[0].key);
  key[0] = 'x';
  ScrStr *name = scr_str_new("shared\0name", sizeof key - 1);
  scr_dyn_key_delete(first, name, true);
  scr_str_release(name);
  assert(scr_dyn_obj_get(second, "shared\0name", sizeof key - 1)->v.num == 2);
  scr_dyn_obj_set(first, "shared\0name", sizeof key - 1, scr_dyn_new_num(3));
  scr_dyn_obj_set(first, "self", 4, scr_dyn_retain(first));
  scr_dyn_release(first);
  scr_collect_cycles();
  assert(scr_dyn_obj_get(second, "shared\0name", sizeof key - 1)->v.num == 2);
  scr_dyn_release(second);

  /* More distinct live names than weak slots force collisions. Releasing
   * an evicted owner must not clear or free the replacement's storage. */
  ScrDyn *objects[600];
  for (int round = 0; round < 2; round++) {
    for (int i = 0; i < 600; i++) {
      char bytes[32];
      int length = snprintf(bytes, sizeof bytes, "field-%d", i);
      objects[i] = scr_dyn_new_obj();
      scr_dyn_obj_set(objects[i], bytes, (size_t)length, scr_dyn_new_num(i));
    }
    for (int i = 0; i < 600; i++) {
      char bytes[32];
      int length = snprintf(bytes, sizeof bytes, "field-%d", i);
      assert(scr_dyn_obj_get(objects[i], bytes, (size_t)length)->v.num == i);
      scr_dyn_release(objects[i]);
    }
  }
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_key_live_count() == before);
#endif
}

static void checked_leaf_cycles(void) {
  /* Object properties omit primitives from trial deletion, while arrays and
   * captured unknown values still trace them. Exercise shared leaves through
   * both edge kinds, with and without an external owner, in either generation. */
  for (int old = 0; old < 2; old++) {
    for (int external = 0; external < 2; external++) {
#ifdef SCR_RC_AUDIT
      long before_dyns = scr_dyn_live_count();
      long before_strings = scr_str_live_count();
#endif
      ScrStr *text = scr_str_new("survives either edge", 20);
      ScrDyn *leaf = scr_dyn_new_str(text);
      scr_str_release(text);
      if (old) scr_cyc_hdr(leaf)->gen = SCR_CYC_MATURE;
      ScrDyn *first = scr_dyn_new_obj(), *second = scr_dyn_new_obj();
      ScrDyn *array = scr_dyn_new_arr();
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      scr_box_set_ref(closure->caps[0], scr_dyn_retain(leaf));
      scr_dyn_obj_set(first, "callback", 8, scr_dyn_new_func(closure, nothing, 0, "func()=>dyn", "leaf"));
      scr_dyn_obj_set(first, "leaf", 4, scr_dyn_retain(leaf));
      scr_dyn_obj_set(second, "leaf", 4, scr_dyn_retain(leaf));
      scr_dyn_obj_set(second, "number", 6, scr_dyn_new_num(42));
      scr_dyn_obj_set(second, "empty", 5, scr_dyn_new_null());
      scr_dyn_obj_set(second, "missing", 7, scr_dyn_retain(scr_dyn_undefined()));
      scr_dyn_arr_push(array, scr_dyn_retain(leaf));
      scr_dyn_arr_push(array, scr_dyn_retain(first));
      scr_dyn_obj_set(first, "next", 4, scr_dyn_retain(second));
      scr_dyn_obj_set(second, "back", 4, scr_dyn_retain(first));
      scr_dyn_obj_set(second, "array", 5, array);
      if (!external) scr_dyn_release(leaf);
      scr_dyn_release(first);
      scr_dyn_release(second);
      scr_cyc_collect_scheduled();
      scr_collect_cycles();
      if (external) {
        assert(leaf->rc == 1 && leaf->v.str->len == 20);
        scr_dyn_release(leaf);
      }
#ifdef SCR_RC_AUDIT
      assert(scr_dyn_live_count() == before_dyns);
      assert(scr_str_live_count() == before_strings);
#endif
    }
  }

  /* A previous trace snapshot must not survive a property mutation: the
   * next collection must trace a new object edge or release a new leaf. */
  for (int leaf_after = 0; leaf_after < 2; leaf_after++) {
#ifdef SCR_RC_AUDIT
    long before = scr_dyn_live_count();
#endif
    ScrDyn *object = scr_dyn_new_obj(), *child = scr_dyn_new_obj();
    scr_dyn_obj_set(object, "self", 4, scr_dyn_retain(object));
    scr_dyn_obj_set(object, "value", 5, leaf_after ? scr_dyn_retain(child) : scr_dyn_new_num(1));
    scr_dyn_release(scr_dyn_retain(object));
    scr_collect_cycles();
    scr_dyn_obj_set(object, "value", 5, leaf_after ? scr_dyn_new_num(2) : scr_dyn_retain(child));
    scr_dyn_obj_set(child, "parent", 6, scr_dyn_retain(object));
    scr_dyn_release(child);
    scr_dyn_release(object);
    scr_collect_cycles();
#ifdef SCR_RC_AUDIT
    assert(scr_dyn_live_count() == before);
#endif
  }
}

static void checked_number_storage(void) {
#ifdef SCR_RC_AUDIT
  long before = scr_dyn_live_count();
#endif
  for (int value = -130; value < 258; value++) {
    ScrDyn *first = scr_dyn_new_num(value), *second = scr_dyn_new_num(value);
    assert(first->kind == SCR_DYN_NUM && first->v.num == value);
    assert(scr_dyn_strict_eq(first, second));
    if (value >= -128 && value <= 255) assert(first == second && first->rc == SIZE_MAX);
    ScrDyn *array = scr_dyn_new_arr();
    scr_dyn_arr_push(array, first);
    scr_dyn_arr_push(array, second);
    scr_dyn_arr_push(array, scr_dyn_retain(array));
    scr_dyn_release(array);
    scr_collect_cycles();
  }
  const double special[] = {-0.0, 0.5, -0.5, NAN, INFINITY, -INFINITY, 9007199254740991.0};
  for (size_t i = 0; i < sizeof special / sizeof special[0]; i++) {
    ScrDyn *value = scr_dyn_new_num(special[i]);
    assert(value->rc != SIZE_MAX);
    assert(isnan(special[i]) ? isnan(value->v.num) : value->v.num == special[i]);
    if (special[i] == 0) assert(signbit(value->v.num));
    scr_dyn_release(value);
  }
  const char raw[] = "[-0,0,1.0,1e2,-128,255,256,1e400]";
  ScrStr *input = scr_str_new(raw, sizeof raw - 1);
  ScrDyn *parsed = scr_json_parse(input);
  assert(parsed && parsed->v.arr.len == 8);
  assert(signbit(parsed->v.arr.items[0]->v.num));
  assert(!signbit(parsed->v.arr.items[1]->v.num));
  assert(parsed->v.arr.items[2] == scr_dyn_new_num(1));
  assert(parsed->v.arr.items[3] == scr_dyn_new_num(100));
  assert(isinf(parsed->v.arr.items[7]->v.num));
  scr_dyn_release(parsed);
  scr_str_release(input);
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == before);
#endif
}

int main(void) {
  json_string_boundaries();
  json_indent_ownership();
  scr_init();
  checked_storage();
  shared_property_keys();
  checked_leaf_cycles();
  checked_number_storage();
  /* Native Set boxes may own headerless scalar/string maps. Collecting an
   * enclosing cycle must neither trace those leaves nor skip their release. */
  for (int i = 0; i < 2000; i++) {
#ifdef SCR_RC_AUDIT
    long before_maps = scr_map_live_count();
    long before_dyns = scr_dyn_live_count();
#endif
    ScrMap *numbers = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
    ScrMap *strings = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL, NULL, NULL);
    scr_map_set_f64_f64(numbers, 42, 1);
    ScrStr *text = scr_str_new("kept", 4);
    scr_map_set_str_f64(strings, text, 1);
    scr_str_release(text);
    ScrDyn *object = scr_dyn_new_obj();
    scr_dyn_obj_set(object, "numbers", 7, scr_dyn_native_set(numbers));
    scr_dyn_obj_set(object, "strings", 7, scr_dyn_native_set(strings));
    scr_dyn_obj_set(object, "self", 4, scr_dyn_retain(object));
    scr_map_release(strings); /* only the box owns this leaf */
    scr_dyn_release(object);
    scr_collect_cycles();
    assert(numbers->rc == 1 && scr_map_has_f64(numbers, 42));
    scr_map_release(numbers);
#ifdef SCR_RC_AUDIT
    assert(scr_map_live_count() == before_maps);
    assert(scr_dyn_live_count() == before_dyns);
#endif
  }
  /* A live alias survives collection; dropping it releases the entire
   * object/closure/capture cycle, including its acyclic string leaf. */
  for (int i = 0; i < 2000; i++) {
#ifdef SCR_RC_AUDIT
    long before = scr_dyn_live_count();
#endif
    ScrDyn *object = scr_dyn_new_obj();
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(closure->caps[0], scr_dyn_retain(object));
    ScrDyn *callback = scr_dyn_new_func(closure, nothing, 0, "func()=>dyn", "read");
    scr_dyn_obj_set(object, "read", 4, callback);
    ScrStr *text = scr_str_new("alive", 5);
    scr_dyn_obj_set(object, "text", 4, scr_dyn_new_str(text));
    scr_str_release(text);
    ScrDyn *alias = scr_dyn_retain(object);
    scr_dyn_release(object);
    scr_collect_cycles();
    assert(scr_dyn_obj_get(alias, "text", 4)->v.str->len == 5);
    scr_dyn_release(alias);
    scr_collect_cycles();
#ifdef SCR_RC_AUDIT
    assert(scr_dyn_live_count() == before);
#endif
  }
  /* A checked bigint owns its payload independently of the producing slot. */
  for (int i = 0; i < 2000; i++) {
    ScrStr *decimal = scr_str_new("18446744073709551615", 20);
    ScrBigInt *integer = scr_bigint_parse(decimal);
    ScrDyn *boxed = scr_dyn_new_bigint(integer);
    scr_bigint_release(integer);
    ScrDyn *copy = scr_dyn_new_bigint(boxed->v.bigint);
    assert(scr_dyn_strict_eq(boxed, copy) && scr_dyn_truthy(copy));
    scr_dyn_release(boxed);
    ScrStr *rendered = scr_dyn_to_string(copy, NULL);
    assert(scr_str_eq(decimal, rendered));
    scr_str_release(decimal);
    scr_str_release(rendered);
    scr_dyn_release(copy);
  }
  ScrDyn *snapshot = scr_dyn_mark_snapshot(scr_dyn_new_obj());
  scr_dyn_release(snapshot);
  ScrDyn *fresh = scr_dyn_new_obj();
  assert(!fresh->copied_from_native);
  scr_dyn_release(fresh);
  ScrDyn *map = scr_weak_map_new(scr_dyn_undefined());
  ScrDyn *key = scr_dyn_new_obj();
  ScrDyn *first = scr_dyn_new_obj(), *second = scr_dyn_new_obj();
  put(map, key, first);
  assert(key->rc == 1 && first->rc == 2);
  put(map, key, second);
  assert(first->rc == 1 && second->rc == 2);
  erase(map, key);
  assert(second->rc == 1);
  put(map, key, first);
  put(map, second, first);
  scr_dyn_release(key);
  assert(first->rc == 2); /* first key died; second is still alive */
  scr_dyn_release(second);
  assert(first->rc == 1);

  /* Releasing a value can dispose a second key and its value. */
  key = scr_dyn_new_obj();
  ScrDyn *inner = scr_dyn_new_obj();
  put(map, key, inner);
  put(map, inner, first);
  scr_dyn_release(inner);
  scr_dyn_release(key);
  assert(first->rc == 1);

  /* Multiple maps observe the same key without retaining it. */
  ScrDyn *other_map = scr_weak_map_new(scr_dyn_undefined());
  key = scr_dyn_new_arr();
  put(map, key, first);
  put(other_map, key, first);
  assert(key->rc == 1 && first->rc == 3);
  scr_dyn_release(other_map);
  assert(key->rc == 1 && first->rc == 2);
  scr_dyn_release(key);
  assert(first->rc == 1);

  /* View and backing buffer are distinct keys, including a root view.
   * Dropping a box cannot remove metadata while native storage survives. */
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 8);
  key = scr_dyn_new_bytes(bytes);
  ScrDyn *buffer = scr_array_buffer_from_bytes(bytes);
  put(map, key, first);
  put(map, buffer, first);
  assert(first->rc == 3 && bytes->rc == 3);
  scr_dyn_release(key);
  scr_dyn_release(buffer);
  assert(first->rc == 3 && bytes->rc == 1);
  buffer = scr_array_buffer_from_bytes(bytes);
  erase(map, buffer);
  assert(first->rc == 2);
  scr_dyn_release(buffer);
  scr_bytes_release(bytes);
  assert(first->rc == 1);

  ScrClosure *closure = scr_closure_new(NULL, 0);
  key = scr_dyn_new_func(scr_closure_retain(closure), nothing, 0, "", "key");
  put(map, key, first);
  scr_dyn_release(key);
  assert(closure->rc == 1 && first->rc == 2);
  scr_closure_release(closure);
  assert(first->rc == 1);

  /* A WeakMap can itself be a weak key. */
  other_map = scr_weak_map_new(scr_dyn_undefined());
  put(map, other_map, first);
  scr_dyn_release(other_map);
  assert(first->rc == 1);

  ScrDyn *weak_set = scr_weak_set_new(scr_dyn_undefined());
  key = scr_dyn_new_obj();
  ScrDyn *added = scr_dyn_handle_ops_of(weak_set)->invoke(weak_set->v.handle.ptr, weak_set, "add", &key, 1, "set.add");
  assert(added == weak_set && key->rc == 1);
  scr_dyn_release(added);
  scr_dyn_release(key);
  scr_dyn_release(weak_set);

  key = scr_dyn_new_obj();
  put(map, key, first);
  scr_dyn_release(map);
  assert(key->rc == 1 && first->rc == 1);
  scr_dyn_release(key);
  scr_dyn_release(first);
  assert(!scr_exc_pending());
  puts("checked storage and weak metadata lifetime checks passed");
  return 0;
}
