#include "scr_runtime.h"
#include <assert.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
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
  /* Lone surrogates escape as \udXXX at every alignment and parse back
   * lone; U+D7FF shares their lead byte and stays raw. */
  scr_wtf8_note();
  static const char *const units[] = {"\xED\xA0\xBD", "\xED\xB8\x80", "\xED\x9F\xBF"};
  static const char *const escapes[] = {"\\ud83d", "\\ude00", "\xED\x9F\xBF"};
  for (size_t prefix = 0; prefix < 24; prefix++) {
    for (size_t u = 0; u < 3; u++) {
      char bytes[64];
      memset(bytes, 'b', prefix);
      memcpy(bytes + prefix, units[u], 3);
      memcpy(bytes + prefix + 3, "\xC3\xA9xyz", 5);
      ScrStr *original = scr_str_new(bytes, prefix + 8);
      ScrJsonBuf buffer;
      scr_jb_init(&buffer);
      scr_jb_put_json_str(&buffer, original);
      ScrStr *encoded = scr_jb_finish(&buffer);
      size_t escape_len = strlen(escapes[u]);
      assert(encoded->len == prefix + 7 + escape_len);
      assert(memcmp(encoded->data + 1 + prefix, escapes[u], escape_len) == 0);
      ScrDyn *parsed = scr_json_parse(encoded);
      assert(parsed && parsed->kind == SCR_DYN_STR && scr_str_eq(original, parsed->v.str));
      scr_dyn_release(parsed);
      scr_str_release(encoded);
      scr_str_release(original);
    }
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
   * both edge kinds, with and without an external owner, in every generation. */
  for (uint16_t gen = SCR_CYC_NURSERY; gen < SCR_CYC_NGENS; gen++) {
    for (int external = 0; external < 2; external++) {
#ifdef SCR_RC_AUDIT
      long before_dyns = scr_dyn_live_count();
      long before_strings = scr_str_live_count();
#endif
      ScrStr *text = scr_str_new("survives either edge", 20);
      ScrDyn *leaf = scr_dyn_new_str(text);
      scr_str_release(text);
      scr_cyc_set_gen(scr_cyc_hdr(leaf), gen);
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

/* ── intact parse regions ───────────────────────────────────────────── */

static bool buffered(ScrDyn *d) { return scr_cyc_is_buffered(scr_cyc_hdr(d)); }

/* Drop a temporary reference the way member reads do. */
static bool buffered_after_read(ScrDyn *d) {
  scr_dyn_release(scr_dyn_retain(d));
  return buffered(d);
}

static ScrDyn *parse_text(const char *text) {
  ScrStr *input = scr_str_new(text, strlen(text));
  ScrDyn *parsed = scr_json_parse(input);
  scr_str_release(input);
  assert(parsed && !scr_exc_pending());
  return parsed;
}

static const char region_doc[] = "{\"a\":{\"b\":[1,{\"c\":2}],\"s\":\"text\"},\"n\":300}";

/* Store a reference to `root` into a member of its own document through one
 * of the barriered writers. */
static void close_cycle(ScrDyn *root, int writer) {
  ScrDyn *a = scr_dyn_obj_get(root, "a", 1);
  ScrDyn *b = scr_dyn_obj_get(a, "b", 1);
  switch (writer) {
  case 0: scr_dyn_obj_set(a, "parent", 6, scr_dyn_retain(root)); break;
  case 1: scr_dyn_arr_push(b, scr_dyn_retain(root)); break;
  case 2: {
    ScrStr *key = scr_str_new("0", 1);
    scr_dyn_key_set(b, key, root);
    scr_str_release(key);
    break;
  }
  case 3: {
    ScrStr *key = scr_str_new("extra", 5);
    scr_dyn_key_set(b, key, root);
    scr_str_release(key);
    break;
  }
  case 4: scr_dyn_release(scr_dyn_set_prototype(a, root)); break;
  case 5: {
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(root));
    ScrStr *text = scr_str_new("p", 1);
    ScrDyn *key = scr_dyn_new_str(text);
    scr_str_release(text);
    scr_dyn_release(scr_dyn_define_property(a, key, descriptor));
    scr_dyn_release(key);
    scr_dyn_release(descriptor);
    break;
  }
  }
  assert(!scr_exc_pending());
}

static void json_intact_regions(void) {
#ifdef SCR_RC_AUDIT
  long before = scr_dyn_live_count();
#endif
  /* Member reads of an intact document buffer nothing, and primitive
   * stores keep it intact. */
  ScrDyn *root = parse_text(region_doc);
  ScrDyn *a = scr_dyn_obj_get(root, "a", 1);
  ScrDyn *b = scr_dyn_obj_get(a, "b", 1);
  assert(!buffered_after_read(root) && !buffered_after_read(a) && !buffered_after_read(b));
  assert(!buffered_after_read(b->v.arr.items[1]));
  scr_dyn_obj_set(a, "n", 1, scr_dyn_new_num(1000.5));
  scr_dyn_arr_push(b, scr_dyn_new_null());
  scr_dyn_obj_set(a, "u", 1, scr_dyn_retain(scr_dyn_undefined()));
  assert(!buffered_after_read(a) && !buffered_after_read(b));

  /* A store of another document's node invalidates only the written one. */
  ScrDyn *other = parse_text(region_doc);
  scr_dyn_obj_set(a, "other", 5, scr_dyn_retain(other));
  assert(!buffered_after_read(scr_dyn_obj_get(other, "a", 1)));
  assert(buffered_after_read(root));
  scr_dyn_release(other);
  scr_dyn_release(root);
  scr_collect_cycles();
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == before);
#endif

  /* The cycle runs through the root, which was never written. A pass while
   * the root is still referenced finds everything alive and drains the
   * candidates; the later release of the root alone must buffer it again. */
  for (int writer = 0; writer < 6; writer++) {
    root = parse_text(region_doc);
    close_cycle(root, writer);
    assert(buffered_after_read(scr_dyn_obj_get(root, "a", 1)));
    scr_collect_cycles();
    assert(root->rc == 2);
    scr_dyn_release(root);
    assert(buffered(root));
    scr_collect_cycles();
#ifdef SCR_RC_AUDIT
    assert(scr_dyn_live_count() == before);
#endif
  }
}

/* ── schema-directed parse ──────────────────────────────────────────── */

typedef struct {
  size_t rc;
  double qty;
  ScrStr *sku;
  uint8_t ok;
  ScrArr *tags;
} TestItem;

static long test_items_live;

static void *test_item_new(void) {
  TestItem *item = calloc(1, sizeof *item);
  assert(item);
  item->rc = 1;
  test_items_live++;
  return item;
}

static void *test_item_retain(void *ptr) {
  ((TestItem *)ptr)->rc++;
  return ptr;
}

static void test_item_release(void *ptr) {
  TestItem *item = ptr;
  if (!item || --item->rc) return;
  scr_str_release(item->sku);
  scr_arr_release(item->tags);
  test_items_live--;
  scr_weak_dispose(item); /* emitted record frees notify the dispose hook */
  free(item);
}

static ScrArr *test_tags_new(size_t cap) { return scr_arr_new(SCR_ELEM_STR, cap); }
static ScrArr *test_list_new(size_t cap) {
  static const ScrArrOps item_ops = { test_item_retain, test_item_release, NULL };
  return scr_arr_new_ops(&item_ops, cap);
}
static void test_arr_release(void *ptr) { scr_arr_release(ptr); }

static const ScrJsonSchema test_f64 = {SCR_JSCHEMA_F64, 0, NULL, NULL, NULL, NULL, NULL};
static const ScrJsonSchema test_bool = {SCR_JSCHEMA_BOOL, 0, NULL, NULL, NULL, NULL, NULL};
static const ScrJsonSchema test_str = {SCR_JSCHEMA_STR, 0, NULL, NULL, NULL, NULL, NULL};
static const ScrJsonSchema test_tags = {SCR_JSCHEMA_ARR, 0, NULL, &test_str, NULL, test_tags_new, test_arr_release};
static const ScrJsonSchemaField test_item_fields[] = {
    {"sku", 3, offsetof(TestItem, sku), &test_str},
    {"qty", 3, offsetof(TestItem, qty), &test_f64},
    {"ok", 2, offsetof(TestItem, ok), &test_bool},
    {"tags", 4, offsetof(TestItem, tags), &test_tags},
};
static const ScrJsonSchema test_item = {SCR_JSCHEMA_REC, 4, test_item_fields, NULL, test_item_new, NULL, test_item_release};
static const ScrJsonSchema test_list = {SCR_JSCHEMA_ARR, 0, NULL, &test_item, NULL, test_list_new, test_arr_release};

static bool str_is(const ScrStr *s, const char *text) {
  return s->len == strlen(text) && memcmp(s->data, text, s->len) == 0;
}

static ScrArr *schema_parse(const char *text) {
  ScrStr *input = scr_str_new(text, strlen(text));
  ScrArr *list = scr_json_parse_schema(input, &test_list);
  scr_str_release(input);
  assert(!scr_exc_pending()); /* declining never throws */
  return list;
}

/* Member names a direct text comparison must not match: a quote or a
 * backslash in a name is written escaped in JSON text. */
typedef struct {
  size_t rc;
  double quoted, slashed;
} TestPair;
static int test_pairs_live = 0;
static void *test_pair_new(void) {
  TestPair *pair = calloc(1, sizeof *pair);
  assert(pair);
  pair->rc = 1;
  test_pairs_live++;
  return pair;
}
static void test_pair_release(void *ptr) {
  TestPair *pair = ptr;
  if (!pair || --pair->rc) return;
  test_pairs_live--;
  scr_weak_dispose(pair); /* emitted record frees notify the dispose hook */
  free(pair);
}
static const ScrJsonSchemaField test_pair_fields[] = {
    {"a\"b", 3, offsetof(TestPair, quoted), &test_f64},
    {"c\\d", 3, offsetof(TestPair, slashed), &test_f64},
};
static const ScrJsonSchema test_pair = {SCR_JSCHEMA_REC, 2, test_pair_fields, NULL, test_pair_new, NULL, test_pair_release};

static TestPair *pair_parse(const char *text) {
  ScrStr *input = scr_str_new(text, strlen(text));
  TestPair *pair = scr_json_parse_schema(input, &test_pair);
  scr_str_release(input);
  assert(!scr_exc_pending());
  return pair;
}

static void json_schema_special_names(void) {
  TestPair *pair = pair_parse("{\"a\\\"b\":1,\"c\\\\d\":2}");
  assert(pair && pair->quoted == 1 && pair->slashed == 2);
  test_pair_release(pair);
  pair = pair_parse("{\"c\\\\d\":4,\"a\\u0022b\":3}");
  assert(pair && pair->quoted == 3 && pair->slashed == 4);
  assert(scr_record_source_has(pair)); /* members out of declaration order */
  test_pair_release(pair);
  /* Raw bytes equal to a name are not that name: the key ends at the
   * quote, and a lone backslash starts an escape. */
  assert(pair_parse("{\"a\"b\":1,\"c\\\\d\":2}") == NULL);
  assert(pair_parse("{\"a\\\"b\":1,\"c\\d\":2}") == NULL);
  assert(test_pairs_live == 0);
}

typedef struct IntegrityCycle { size_t rc; struct IntegrityCycle *next; } IntegrityCycle;
static unsigned integrity_cycles_freed;
static ScrArr *integrity_exit_held;
static void integrity_exit_check(void) {
  assert(scr_native_integrity_flags(integrity_exit_held) == SCR_NATIVE_FROZEN);
  scr_arr_release(integrity_exit_held);
}
static void integrity_cycle_trace(void *ptr, ScrTraceVisit visit, void *context) {
  visit(((IntegrityCycle *)ptr)->next, context);
}
static void integrity_cycle_free(void *ptr) {
  integrity_cycles_freed++;
  scr_cyc_free(ptr);
}

static void integrity_publish_array(void *ptr, ScrPub *context) {
  scr_pub_arr(ptr, context, NULL);
}

static void integrity_refuse_array(void *ptr, ScrPub *context) {
  scr_pub_arr(ptr, context, NULL);
  scr_pub_refuse(context, "integrity publication refusal");
}

typedef struct {
  size_t rc;
  ScrArr *first;
  ScrArr *refused;
} ArrayPublicationPair;

static void integrity_publish_array_pair(void *ptr, ScrPub *context) {
  ArrayPublicationPair *pair = ptr;
  scr_pub_arr(pair->first, context, NULL);
  assert(pair->first->rc == SIZE_MAX);
  scr_pub_arr(pair->refused, context, NULL);
}

static void native_array_publication_rollback(void) {
  scr_collect_cycles();
  size_t live = scr_cyc_live;
  ScrArr *first = scr_arr_new(SCR_ELEM_F64, 1);
  ScrArr *refused = scr_arr_new(SCR_ELEM_BOOL, 0);
  assert(first->cyc && refused->cyc);
  scr_arr_push_f64(first, 42);
  scr_native_integrity_strengthen(first, SCR_NATIVE_SEALED);
  scr_arr_ext(refused)->metadata = scr_dyn_new_obj();
  scr_dyn_obj_set(refused->ext->metadata, "extra", 5, scr_dyn_new_num(7));
  scr_arr_retain(first);
  scr_arr_release(first); /* real candidate entry, unless threshold 1 collected it */
  ScrCycHdr before = *scr_cyc_hdr(first);
  const char *threshold = getenv("SCR_CYCLE_THRESHOLD");
  if (threshold && strcmp(threshold, "256") == 0)
    assert(scr_cyc_is_buffered(scr_cyc_hdr(first)));
  ArrayPublicationPair pair = {1, first, refused};
  scr_publish(&pair, integrity_publish_array_pair);
  assert(scr_exc_pending() && first->rc == 1 && refused->rc == 1);
  assert(scr_native_integrity_flags(first) == SCR_NATIVE_SEALED);
  assert(memcmp(&before, scr_cyc_hdr(first), sizeof before) == 0);
  assert(scr_arr_get_f64(first, 0) == 42 && refused->ext->metadata);
  scr_exc_clear();
  scr_arr_release(first);
  scr_arr_release(refused);
  scr_collect_cycles();
  assert(scr_cyc_live == live && !scr_native_integrity_active());
}

static void native_integrity_lifetime(void) {
  assert(!scr_native_integrity_active());
  native_array_publication_rollback();
  TestPair *pair = test_pair_new();
  assert(scr_native_integrity_flags(pair) == 0);
  scr_native_integrity_strengthen(pair, SCR_NATIVE_NON_EXTENSIBLE);
  assert(scr_native_integrity_flags(pair) == SCR_NATIVE_NON_EXTENSIBLE);
  scr_native_integrity_strengthen(pair, SCR_NATIVE_SEALED);
  scr_native_integrity_strengthen(pair, SCR_NATIVE_NON_EXTENSIBLE);
  assert(scr_native_integrity_flags(pair) == SCR_NATIVE_SEALED);
  scr_native_integrity_strengthen(pair, SCR_NATIVE_FROZEN);
  scr_native_integrity_strengthen(pair, SCR_NATIVE_SEALED);
  assert(scr_native_integrity_flags(pair) == SCR_NATIVE_FROZEN);
  /* Exercise the exposed-object disposal boundary before reusing exactly
   * the same allocation, independently of allocator/ASan reuse policy. */
  scr_weak_dispose(pair);
  assert(!scr_native_integrity_flags(pair));
  scr_native_integrity_strengthen(pair, SCR_NATIVE_SEALED);
  assert(scr_native_integrity_flags(pair) == SCR_NATIVE_SEALED);
  test_pair_release(pair);
  assert(!scr_native_integrity_active());

  TestPair *pairs[512];
  for (unsigned round = 0; round < 3; round++) {
    for (unsigned i = 0; i < 512; i++) {
      pairs[i] = test_pair_new();
      assert(!scr_native_integrity_flags(pairs[i]));
      scr_native_integrity_strengthen(pairs[i], i % 2 ? SCR_NATIVE_SEALED : SCR_NATIVE_FROZEN);
    }
    for (unsigned i = 0; i < 512; i += 2) test_pair_release(pairs[i]);
    for (unsigned i = 1; i < 512; i += 2) {
      assert(scr_native_integrity_flags(pairs[i]) == SCR_NATIVE_SEALED);
      test_pair_release(pairs[i]);
    }
    assert(!scr_native_integrity_active());
  }

  /* The metadata must not displace the retained-record-view observer. */
  pair = pair_parse("{\"c\\\\d\":4,\"a\\\"b\":3}");
  assert(pair && scr_record_source_has(pair));
  scr_native_integrity_strengthen(pair, SCR_NATIVE_FROZEN);
  scr_weak_dispose(pair);
  assert(!scr_record_source_has(pair) && !scr_native_integrity_flags(pair));
  test_pair_release(pair);

  ScrArr *array = scr_arr_new(SCR_ELEM_F64, 1);
  scr_native_integrity_strengthen(array, SCR_NATIVE_FROZEN);
  scr_collect_cycles();
  assert(scr_native_integrity_flags(array) == SCR_NATIVE_FROZEN);
  scr_arr_release(array);
  assert(!scr_native_integrity_active());

  static ScrCycType type = {
    .trace = integrity_cycle_trace, .free_fn = integrity_cycle_free, .kind = SCR_CYC_KIND_EMITTED,
  };
  IntegrityCycle *first = scr_cyc_alloc(sizeof *first, &type);
  IntegrityCycle *second = scr_cyc_alloc(sizeof *second, &type);
  first->rc = second->rc = 2;
  first->next = second;
  second->next = first;
  scr_native_integrity_strengthen(first, SCR_NATIVE_FROZEN);
  scr_native_integrity_strengthen(second, SCR_NATIVE_SEALED);
  first->rc--;
  scr_cyc_on_release(first);
  second->rc--;
  scr_cyc_on_release(second);
  scr_collect_cycles();
  assert(integrity_cycles_freed == 2 && !scr_native_integrity_active());

  pair = test_pair_new();
  scr_native_integrity_strengthen(pair, SCR_NATIVE_FROZEN);
  void (*hook)(void *) = scr_weak_dispose_hook;
  scr_native_integrity_reset();
  scr_native_integrity_reset();
  assert(!scr_native_integrity_active() && scr_weak_dispose_hook == hook);
  scr_native_integrity_strengthen(pair, SCR_NATIVE_SEALED);
  assert(scr_native_integrity_flags(pair) == SCR_NATIVE_SEALED);
  test_pair_release(pair);
  assert(!scr_native_integrity_active() && test_pairs_live == 0);

  array = scr_arr_new(SCR_ELEM_F64, 0);
  scr_native_integrity_strengthen(array, SCR_NATIVE_SEALED);
  scr_publish(array, integrity_refuse_array);
  assert(scr_exc_pending() && array->rc == 1);
  assert(scr_native_integrity_flags(array) == SCR_NATIVE_SEALED);
  scr_exc_clear();
  scr_publish(array, integrity_publish_array);
  assert(!scr_exc_pending() && array->rc == SIZE_MAX);
  assert(!scr_native_integrity_active());
  scr_native_integrity_strengthen(array, SCR_NATIVE_FROZEN);
  assert(!scr_native_integrity_active());
}

static ScrDyn *integrity_child, *integrity_prototype, *integrity_accessor;
static unsigned integrity_accessor_calls;
static ScrDyn *integrity_access(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  integrity_accessor_calls++;
  return scr_dyn_retain(scr_dyn_undefined());
}
static void *integrity_pair_retain(void *ptr) {
  ((TestPair *)ptr)->rc++;
  return ptr;
}
static ScrDyn *integrity_pair_view(void *ptr) {
  ScrDyn *view = scr_dyn_new_obj();
  view->copied_from_native = true;
  scr_dyn_obj_set(view, "value", 5, scr_dyn_new_num(((TestPair *)ptr)->quoted));
  scr_dyn_obj_set(view, "child", 5, scr_dyn_retain(integrity_child));
  scr_dyn_obj_set(view, "accessor", 8, scr_dyn_retain(scr_dyn_undefined()));
  ScrDynEntry *entry = &view->v.obj.entries[2];
  entry->accessor = true;
  entry->getter = scr_dyn_retain(integrity_accessor);
  entry->setter = scr_dyn_retain(integrity_accessor);
  view->prototype = scr_dyn_retain(integrity_prototype);
  view->symbol_properties = scr_dyn_new_obj();
  scr_dyn_obj_set(view->symbol_properties, "symbol", 6, scr_dyn_new_num(3));
  return view;
}
static void *integrity_array_retain(void *ptr) { return scr_arr_retain(ptr); }
static void integrity_array_release(void *ptr) { scr_arr_release(ptr); }
static ScrDyn *integrity_array_view(void *ptr) {
  ScrArr *array = ptr;
  ScrDyn *view = scr_dyn_new_arr();
  for (size_t i = 0; i < array->len; i++)
    scr_dyn_arr_push(view, scr_dyn_new_num(scr_arr_get_f64(array, (double)i)));
  view->v.arr.properties = scr_dyn_new_obj();
  scr_dyn_obj_set(view->v.arr.properties, "label", 5, scr_dyn_new_num(4));
  return view;
}

static void native_integrity_views(void) {
  static const ScrDynNativeObjectOps binding_ops = {0};
  integrity_child = scr_dyn_new_obj();
  integrity_prototype = scr_dyn_new_obj();
  integrity_accessor = scr_dyn_new_func(scr_closure_new(NULL, 0), integrity_access, 0, "func()=>dyn", "accessor");
  TestPair *pair = test_pair_new();
  pair->quoted = 1;
  ScrDyn *first = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
      "record:first", 12, integrity_pair_view, NULL);
  ScrDyn *second = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
      "record:second", 13, integrity_pair_view, NULL);
  assert(first != second); /* Different adapters may share one native identity. */
  assert(!first->v.typed_ref.native_object && !second->v.typed_ref.native_object);
  assert(!scr_dyn_freeze(first) && scr_exc_pending());
  scr_exc_clear();
  assert(!scr_native_integrity_flags(pair)); /* Unbound capsules remain unsupported. */
  scr_dyn_typed_ref_bind_native_object(first, &binding_ops);
  scr_dyn_typed_ref_bind_native_object(second, &binding_ops);
  ScrDyn *warm = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
      "record:first", 12, integrity_pair_view, NULL);
  assert(warm == first && warm->v.typed_ref.native_object == &binding_ops);
  scr_dyn_typed_ref_bind_native_object(warm, NULL);
  assert(warm->v.typed_ref.native_object == &binding_ops);
  scr_dyn_release(warm);
  const ScrDynTypedRefRecipe recipe = {
    .retain = integrity_pair_retain, .release = test_pair_release,
    .type_key = "record:deferred", .type_key_len = 15,
    .materialize = integrity_pair_view, .kind = 1, .native_object = &binding_ops,
  };
  scr_dyn_this_push_typed(pair, &recipe);
  ScrDyn *deferred = scr_dyn_this_get();
  assert(deferred && deferred->v.typed_ref.native_object == &binding_ops);
  assert(!deferred->v.typed_ref.materialized && !deferred->v.typed_ref.array);
  scr_dyn_this_pop();
  scr_dyn_release(deferred);
  ScrDyn *held = scr_dyn_typed_ref_materialize(first);
  scr_dyn_typed_ref_bind_native_object(first, &binding_ops);
  assert(first->v.typed_ref.materialized == held && first->v.typed_ref.native_object == &binding_ops);
  assert(!held->non_extensible && held->v.obj.entries[0].writable);
  const unsigned levels[] = {SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  for (size_t level = 0; level < 3; level++) {
    scr_native_integrity_strengthen(pair, levels[level]);
    for (unsigned alias = 0; alias < 2; alias++) {
      ScrDyn *view = scr_dyn_typed_ref_materialize(alias ? second : first);
      assert(view->non_extensible && view->copied_from_native);
      if (!alias) assert(view == held);
      assert(view->v.obj.entries[0].writable == (level < 2));
      assert(view->v.obj.entries[0].configurable == (level == 0));
      assert(view->v.obj.entries[2].accessor);
      assert(view->v.obj.entries[2].getter == integrity_accessor);
      assert(view->v.obj.entries[2].setter == integrity_accessor);
      assert(view->v.obj.entries[2].configurable == (level == 0));
      assert(view->symbol_properties->v.obj.entries[0].writable == (level < 2));
      assert(view->symbol_properties->v.obj.entries[0].configurable == (level == 0));
      assert(view->prototype == integrity_prototype && !integrity_prototype->non_extensible);
      assert(scr_dyn_obj_get(view, "child", 5) == integrity_child && !integrity_child->non_extensible);
      assert(integrity_accessor_calls == 0 && !scr_exc_pending());
      scr_dyn_release(view);
    }
    if (level == 1) pair->quoted = 7; /* A sealed data field remains writable. */
  }
  assert(scr_dyn_obj_get(held, "value", 5)->v.num == 7);
  for (size_t level = 0; level < 3; level++) {
    ScrDyn *ordinary = integrity_pair_view(pair);
    ordinary->copied_from_native = false;
    ScrDyn *result = level == 0 ? scr_dyn_prevent_extensions(ordinary)
        : level == 1 ? scr_dyn_seal(ordinary) : scr_dyn_freeze(ordinary);
    assert(result == ordinary && !scr_dyn_is_extensible(ordinary));
    assert(scr_dyn_is_sealed(ordinary) == (level > 0));
    assert(scr_dyn_is_frozen(ordinary) == (level == 2));
    assert(!scr_exc_pending() && integrity_accessor_calls == 0);
    scr_dyn_release(result);
    scr_dyn_release(ordinary);
  }
  ScrStr *accessor_key = scr_str_new("accessor", 8);
  ScrDyn *next = scr_dyn_new_num(9);
  scr_dyn_key_set(held, accessor_key, next);
  assert(integrity_accessor_calls == 1 && !scr_exc_pending());
  scr_dyn_key_set(integrity_child, accessor_key, next);
  assert(scr_dyn_obj_get(integrity_child, "accessor", 8)->v.num == 9);
  scr_dyn_release(next);
  scr_str_release(accessor_key);
  scr_dyn_release(held);
  scr_dyn_release(first);
  scr_dyn_release(second);
  assert(pair->rc == 1 && scr_native_integrity_flags(pair) == SCR_NATIVE_FROZEN);
  first = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
      "record:recreated", 16, integrity_pair_view, NULL);
  held = scr_dyn_typed_ref_materialize(first);
  assert(!held->v.obj.entries[0].writable && !held->v.obj.entries[0].configurable);
  scr_dyn_release(held);
  scr_dyn_release(first);
  test_pair_release(pair);
  /* A refresh preserves the cached child's identity even when its fresh
   * alias is the first adapter to supply independent native ownership. */
  TestPair *child_pair = test_pair_new();
  pair = test_pair_new();
  scr_dyn_release(integrity_child);
  integrity_child = scr_dyn_new_typed_ref_observed(child_pair, integrity_pair_retain,
      test_pair_release, "old", 3, integrity_pair_view, NULL);
  first = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
      "parent", 6, integrity_pair_view, NULL);
  held = scr_dyn_typed_ref_materialize(first);
  ScrDyn *cached_child = scr_dyn_obj_get(held, "child", 5);
  assert(!cached_child->v.typed_ref.native_object);
  scr_dyn_release(integrity_child);
  integrity_child = scr_dyn_new_typed_ref_observed(child_pair, integrity_pair_retain,
      test_pair_release, "new", 3, integrity_pair_view, NULL);
  assert(integrity_child != cached_child);
  scr_dyn_typed_ref_bind_native_object(integrity_child, &binding_ops);
  ScrDyn *refreshed = scr_dyn_typed_ref_materialize(first);
  assert(refreshed == held && scr_dyn_obj_get(refreshed, "child", 5) == cached_child);
  assert(cached_child->v.typed_ref.native_object == &binding_ops);
  scr_dyn_release(refreshed);
  scr_dyn_release(held);
  scr_dyn_release(first);
  test_pair_release(pair);
  scr_dyn_release(integrity_accessor);
  scr_dyn_release(integrity_prototype);
  scr_dyn_release(integrity_child);
  test_pair_release(child_pair);

  ScrArr *array = scr_arr_new(SCR_ELEM_F64, 0);
  scr_arr_push_f64(array, 2);
  first = scr_dyn_new_typed_ref_observed(array, integrity_array_retain, integrity_array_release,
      "array:f64", 9, integrity_array_view, NULL);
  held = scr_dyn_typed_ref_materialize(first);
  for (size_t level = 0; level < 3; level++) {
    scr_native_integrity_strengthen(array, levels[level]);
    ScrDyn *view = scr_dyn_typed_ref_materialize(first);
    assert(view == held && view->non_extensible);
    assert(view->v.arr.sealed == (level > 0) && view->v.arr.frozen == (level == 2));
    assert(view->v.arr.properties->non_extensible);
    assert(view->v.arr.properties->v.obj.entries[0].writable == (level < 2));
    assert(view->v.arr.properties->v.obj.entries[0].configurable == (level == 0));
    assert(view->v.arr.items[0]->v.num == 2);
    scr_dyn_release(view);
  }
  scr_dyn_release(held);
  scr_dyn_release(first);
  scr_arr_release(array);
  assert(!scr_native_integrity_active() && test_pairs_live == 0);
}

static const char *const metadata_pair_names[] = {"first", "second"};
static const size_t metadata_pair_lengths[] = {5, 6};
static bool metadata_pair_has(void *ptr, size_t index) {
  return index == 0 || ((TestPair *)ptr)->slashed != -2;
}
static ScrDyn *metadata_pair_get(void *ptr, size_t index) {
  TestPair *pair = ptr;
  return index == 0 ? scr_dyn_new_num(pair->quoted)
      : pair->slashed < 0 ? scr_dyn_retain(scr_dyn_undefined()) : scr_dyn_new_num(pair->slashed);
}
static ScrDyn *metadata_pair_view(void *ptr) {
  ScrDyn *view = scr_dyn_new_obj();
  view->copied_from_native = true;
  for (size_t i = 0; i < 2; i++)
    if (metadata_pair_has(ptr, i))
      scr_dyn_obj_set(view, metadata_pair_names[i], metadata_pair_lengths[i], metadata_pair_get(ptr, i));
  return view;
}
static bool metadata_pair_field(ScrJsonBuf *buffer, void *ptr, size_t index, bool first) {
  TestPair *pair = ptr;
  if (index == 1 && pair->slashed < 0) return false;
  if (!first) scr_jb_putc(buffer, ',');
  ScrStr *name = scr_str_new(metadata_pair_names[index], metadata_pair_lengths[index]);
  scr_jb_put_json_str(buffer, name);
  scr_str_release(name);
  scr_jb_putc(buffer, ':');
  scr_jb_put_f64(buffer, index == 0 ? pair->quoted : pair->slashed);
  return true;
}
static void metadata_pair_keys(ScrDyn *value, const char *expected) {
  ScrDyn *keys = scr_dyn_obj_keys(value);
  assert(keys && !scr_exc_pending());
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  scr_jb_put_dyn(&buffer, keys);
  ScrStr *text = scr_jb_finish(&buffer);
  assert(str_is(text, expected));
  scr_str_release(text);
  scr_dyn_release(keys);
}

static ScrDyn *metadata_receiver;
static unsigned metadata_accessor_calls;
static ScrDyn *metadata_accessor(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *receiver = scr_dyn_this_get();
  assert(scr_dyn_strict_eq(receiver, metadata_receiver));
  metadata_accessor_calls++;
  if (argc) {
    ScrStr *key = scr_str_new("extra", 5);
    scr_dyn_key_set(receiver, key, args[0]);
    scr_str_release(key);
  }
  scr_dyn_release(receiver);
  return scr_dyn_new_num(42);
}

static void metadata_symbol_number(ScrDyn *object, ScrDyn *key, double expected) {
  ScrDyn *value = scr_dyn_symbol_key_get(object, key, false);
  assert(value && !scr_exc_pending() && value->kind == SCR_DYN_NUM && value->v.num == expected);
  scr_dyn_release(value);
}

static void native_property_projection(void) {
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  TestPair *pair = test_pair_new();
  pair->quoted = 1;
  pair->slashed = 2;
  ScrStr *names[] = {scr_str_new("first", 5), scr_str_new("second", 6)};
  ScrDynTypedRecordOps live = {
    .count = 2, .names = names, .has = metadata_pair_has, .get = metadata_pair_get,
  };
  ScrDyn *first = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
      "record:first", 12, metadata_pair_view, NULL);
  ScrDyn *second = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
      "record:second", 13, metadata_pair_view, NULL);
  scr_dyn_typed_ref_bind_record(first, &live);
  scr_dyn_typed_ref_bind_record(second, &live);
  ScrDyn *held = scr_dyn_typed_ref_materialize(first);
  metadata_pair_keys(second, "[\"first\",\"second\"]");
  assert(!second->v.typed_ref.materialized);

  /* Metadata arrives after one alias has a snapshot and another has used
   * its fast hooks. Its order and attributes must govern both aliases. */
  ScrDyn *source = scr_dyn_new_obj();
  scr_dyn_obj_set(source, "second", 6, scr_dyn_new_num(2));
  scr_dyn_obj_set(source, "extra", 5, scr_dyn_new_num(3));
  scr_dyn_obj_set(source, "first", 5, scr_dyn_new_num(1));
  scr_record_source_note(pair, source, metadata_pair_names, metadata_pair_lengths, 2);
  scr_dyn_release(source);
  ScrDyn *metadata = scr_record_source_view(pair);
  assert(metadata && scr_dyn_obj_get(metadata, "first", 5)->kind == SCR_DYN_UNDEF);
  metadata->prototype = scr_dyn_new_obj();
  scr_native_property_attributes(pair, "first", 5, 0);
  pair->quoted = 7;
  for (unsigned alias = 0; alias < 2; alias++) {
    ScrDyn *capsule = alias ? second : first;
    metadata_pair_keys(capsule, "[\"second\",\"extra\"]");
    ScrDyn *view = scr_dyn_typed_ref_materialize(capsule);
    assert(view != metadata && view->copied_from_native);
    if (!alias) assert(view == held);
    assert(view->prototype == metadata->prototype);
    assert(view->symbol_properties == metadata->symbol_properties);
    ScrDyn *descriptor = scr_dyn_own_descriptor(capsule, names[0]);
    assert(descriptor && scr_dyn_obj_get(descriptor, "value", 5)->v.num == 7);
    assert(!scr_dyn_obj_get(descriptor, "writable", 8)->v.b);
    assert(!scr_dyn_obj_get(descriptor, "enumerable", 10)->v.b);
    assert(!scr_dyn_obj_get(descriptor, "configurable", 12)->v.b);
    scr_dyn_release(descriptor);
    scr_dyn_release(view);
    assert(scr_dyn_obj_get(metadata, "first", 5)->kind == SCR_DYN_UNDEF);
  }
  scr_dyn_release(held);
  scr_dyn_release(first);
  ScrDyn *rejected = scr_dyn_new_num(99);
  scr_dyn_key_set(second, names[0], rejected);
  scr_dyn_release(rejected);
  assert(scr_exc_pending() && pair->quoted == 7);
  scr_exc_clear();

  /* Public writes must survive a refresh and stay visible through aliases.
   * A setter re-enters the capsule; its effects must never meet a stale commit. */
  ScrStr *extra = scr_str_new("extra", 5);
  ScrDyn *extra_key = scr_dyn_new_str(extra);
  ScrDyn *number = scr_dyn_new_num(5);
  scr_dyn_key_set(second, extra, number);
  scr_dyn_release(number);
  ScrDyn *view = scr_dyn_typed_ref_materialize(second);
  assert(scr_dyn_obj_get(view, "extra", 5)->v.num == 5);
  scr_dyn_release(view);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_release(scr_dyn_define_property(second, extra_key, descriptor));
  scr_dyn_release(descriptor);
  metadata_pair_keys(second, "[\"second\"]");
  scr_dyn_key_delete(second, extra, true);
  assert(!scr_dyn_has_own(second, extra));
  number = scr_dyn_new_num(3);
  assert(scr_dyn_reflect_set(second, extra_key, number, second));
  scr_dyn_release(number);
  metadata_pair_keys(second, "[\"second\",\"extra\"]");

  ScrDyn *prototype = scr_dyn_new_obj();
  scr_dyn_release(scr_dyn_set_prototype(second, prototype));
  ScrDyn *observed = scr_dyn_get_prototype(second);
  assert(observed == prototype && metadata->prototype == prototype);
  scr_dyn_release(observed);
  assert(!scr_dyn_set_prototype(second, second) && scr_exc_pending());
  scr_exc_clear();
  ScrDyn *accessor = scr_dyn_new_func(scr_closure_new(NULL, 0), metadata_accessor, 1,
      "func(dyn)=>dyn", "metadata accessor");
  descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_retain(accessor));
  scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_retain(accessor));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrStr *inherited = scr_str_new("inherited", 9);
  ScrDyn *inherited_key = scr_dyn_new_str(inherited);
  scr_dyn_release(scr_dyn_define_property(prototype, inherited_key, descriptor));
  metadata_receiver = second;
  metadata_accessor_calls = 0;
  number = scr_dyn_new_num(6);
  scr_dyn_key_set(second, inherited, number);
  scr_dyn_release(number);
  assert(metadata_accessor_calls == 1 && !scr_dyn_has_own(second, inherited));
  view = scr_dyn_typed_ref_materialize(second);
  assert(scr_dyn_obj_get(view, "extra", 5)->v.num == 6);
  scr_dyn_release(view);

  ScrStr *description = scr_str_new("same", 4);
  ScrDyn *symbols[3];
  for (size_t i = 0; i < 3; i++) {
    ScrSym *symbol = scr_sym_new(description);
    symbols[i] = scr_dyn_new_symbol(symbol);
    scr_sym_release(symbol);
  }
  scr_str_release(description);
  number = scr_dyn_new_num(9);
  scr_dyn_symbol_key_set(second, symbols[0], number);
  scr_dyn_release(number);
  scr_dyn_release(scr_dyn_define_property(second, symbols[1], descriptor));
  scr_dyn_release(descriptor);
  number = scr_dyn_new_num(3);
  scr_dyn_symbol_key_set(second, symbols[1], number);
  scr_dyn_release(number);
  assert(metadata_accessor_calls == 2);
  metadata_symbol_number(second, symbols[0], 9);
  assert(!scr_dyn_strict_eq(symbols[0], symbols[1]));

  ScrDyn *detached = scr_record_source_apply(metadata_pair_view(pair), pair);
  metadata_pair_keys(detached, "[\"second\",\"extra\"]");
  assert(detached != metadata && detached->prototype == metadata->prototype);
  assert(detached->symbol_properties != metadata->symbol_properties);
  assert(detached->symbol_keys != metadata->symbol_keys);
  assert(detached->symbol_keys->v.arr.len == 2 && metadata_accessor_calls == 2);
  for (size_t i = 0; i < 2; i++)
    assert(scr_dyn_strict_eq(detached->symbol_keys->v.arr.items[i], symbols[i]));
  descriptor = scr_dyn_get_own_property_descriptor(detached, symbols[1]);
  assert(scr_dyn_obj_get(descriptor, "get", 3) == accessor);
  assert(scr_dyn_obj_get(descriptor, "set", 3) == accessor);
  assert(!scr_dyn_obj_get(descriptor, "enumerable", 10)->v.b);
  assert(scr_dyn_obj_get(descriptor, "configurable", 12)->v.b);
  scr_dyn_release(descriptor);
  number = scr_dyn_new_num(11);
  scr_dyn_symbol_key_set(detached, symbols[0], number);
  scr_dyn_release(number);
  scr_dyn_key_delete_computed(detached, symbols[1], true);
  number = scr_dyn_new_num(12);
  scr_dyn_symbol_key_set(detached, symbols[2], number);
  scr_dyn_release(number);
  metadata_symbol_number(second, symbols[0], 9);
  assert(scr_dyn_has_own_computed(second, symbols[1]));
  assert(!scr_dyn_has_own_computed(second, symbols[2]));
  number = scr_dyn_new_num(13);
  assert(scr_dyn_reflect_set(second, symbols[2], number, second));
  scr_dyn_release(number);
  scr_dyn_key_delete_computed(second, symbols[0], true);
  metadata_symbol_number(detached, symbols[0], 11);
  metadata_symbol_number(detached, symbols[2], 12);
  scr_dyn_release(scr_dyn_freeze(detached->symbol_properties));
  assert(scr_dyn_is_frozen(detached->symbol_properties) && !scr_dyn_is_frozen(metadata->symbol_properties));
  ScrDyn *fresh_copy = scr_record_source_apply(metadata_pair_view(pair), pair);
  assert(fresh_copy->symbol_keys->v.arr.len == 2 && metadata_accessor_calls == 2);
  assert(scr_dyn_strict_eq(fresh_copy->symbol_keys->v.arr.items[0], symbols[1]));
  assert(scr_dyn_strict_eq(fresh_copy->symbol_keys->v.arr.items[1], symbols[2]));
  scr_dyn_release(fresh_copy);

  /* Both a known key and a fresh tail entry can be accessors. Projection
   * copies descriptors, never evaluates them or turns them into data. */
  ScrDyn *snapshot = metadata_pair_view(pair);
  descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_retain(accessor));
  scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_retain(accessor));
  ScrDyn *field_key = scr_dyn_new_str(names[0]);
  scr_dyn_release(scr_dyn_define_property(snapshot, field_key, descriptor));
  scr_dyn_release(field_key);
  ScrStr *tail = scr_str_new("tail", 4);
  field_key = scr_dyn_new_str(tail);
  scr_dyn_release(scr_dyn_define_property(snapshot, field_key, descriptor));
  scr_dyn_release(field_key);
  scr_dyn_release(descriptor);
  descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(false));
  field_key = scr_dyn_new_str(names[1]);
  scr_dyn_release(scr_dyn_define_property(snapshot, field_key, descriptor));
  scr_dyn_release(field_key);
  scr_dyn_release(descriptor);
  snapshot = scr_record_source_apply(snapshot, pair);
  for (size_t i = 0; i < 2; i++) {
    descriptor = scr_dyn_own_descriptor(snapshot, i ? tail : names[0]);
    assert(scr_dyn_obj_get(descriptor, "get", 3) == accessor);
    assert(scr_dyn_obj_get(descriptor, "set", 3) == accessor);
    assert(!scr_dyn_obj_get(descriptor, "value", 5));
    assert(!scr_dyn_obj_get(descriptor, "enumerable", 10)->v.b);
    assert(!scr_dyn_obj_get(descriptor, "configurable", 12)->v.b);
    scr_dyn_release(descriptor);
  }
  descriptor = scr_dyn_own_descriptor(snapshot, names[1]);
  assert(!scr_dyn_obj_get(descriptor, "writable", 8)->v.b);
  assert(!scr_dyn_obj_get(descriptor, "enumerable", 10)->v.b);
  assert(!scr_dyn_obj_get(descriptor, "configurable", 12)->v.b);
  scr_dyn_release(descriptor);
  assert(metadata_accessor_calls == 2 && !scr_exc_pending());
  scr_dyn_release(snapshot);
  scr_str_release(tail);
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  assert(scr_jb_try_record_source(&buffer, pair, metadata_pair_field));
  ScrStr *text = scr_jb_finish(&buffer);
  assert(str_is(text, "{\"second\":2,\"extra\":3}"));
  scr_str_release(text);

  /* Optional deletion and present undefined have different presence. A
   * successful re-add appends its placeholder after the surviving keys. */
  pair->slashed = -2;
  scr_dyn_key_delete(metadata, names[1], true);
  metadata_pair_keys(second, "[\"extra\"]");
  pair->slashed = -1;
  scr_dyn_obj_set(metadata, "second", 6, scr_dyn_retain(scr_dyn_undefined()));
  metadata_pair_keys(second, "[\"extra\",\"second\"]");
  ScrDyn *third = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
      "record:third", 12, metadata_pair_view, NULL);
  assert(!third->v.typed_ref.materialized);
  metadata_pair_keys(third, "[\"extra\",\"second\"]");
  assert(third->v.typed_ref.materialized != metadata);
  assert(scr_dyn_obj_get(metadata, "first", 5)->kind == SCR_DYN_UNDEF);
  scr_dyn_release(third);
  scr_dyn_release(second);
  test_pair_release(pair);
  metadata_symbol_number(detached, symbols[0], 11);
  metadata_symbol_number(detached, symbols[2], 12);
  scr_dyn_release(detached);
  for (size_t i = 0; i < 3; i++) scr_dyn_release(symbols[i]);
  scr_dyn_release(prototype);
  scr_dyn_release(accessor);
  metadata_receiver = NULL;
  scr_dyn_release(extra_key);
  scr_dyn_release(inherited_key);
  scr_str_release(extra);
  scr_str_release(inherited);
  scr_str_release(names[0]);
  scr_str_release(names[1]);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active() && test_pairs_live == 0);
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static unsigned metadata_prepare_facts(void *ptr, size_t index) {
  return metadata_pair_has(ptr, index == 0 ? 1 : 0) ? SCR_NATIVE_DEFAULT_DATA : 0;
}

static bool metadata_prepare(void *ptr);
static ScrDyn *metadata_prepare_properties(void *ptr) { return scr_record_source_view(ptr); }
static const char *const metadata_prepare_names[] = {"second", "first", "%call"};
static const size_t metadata_prepare_lengths[] = {6, 5, 5};
static const ScrDynNativeObjectOps metadata_prepare_ops = {
  .count = 2, .names = metadata_prepare_names, .lengths = metadata_prepare_lengths,
  .facts = metadata_prepare_facts, .properties = metadata_prepare_properties, .prepare = metadata_prepare,
};
static bool metadata_prepare(void *ptr) {
  return scr_record_source_prepare(ptr, metadata_prepare_names, metadata_prepare_lengths, 3,
                                    &metadata_prepare_ops);
}
static ScrDyn *metadata_prepared_view(void *ptr) {
  ScrDyn *view = scr_dyn_new_obj();
  view->copied_from_native = true;
  for (size_t i = 0; i < 2; i++)
    if (metadata_prepare_facts(ptr, i) & SCR_NATIVE_OWN)
      scr_dyn_obj_set(view, metadata_prepare_names[i], metadata_prepare_lengths[i],
                      metadata_pair_get(ptr, i == 0 ? 1 : 0));
  return view;
}
static bool metadata_prepared_field(ScrJsonBuf *buffer, void *ptr, size_t index, bool first) {
  assert(index < 3);
  if (index == 2) return false; /* The serializer skips its hidden raw slot. */
  return metadata_pair_field(buffer, ptr, index == 0 ? 1 : 0, first);
}

static void native_property_prepare(void) {
  for (int optional = -2; optional < 0; optional++) {
    TestPair *pair = test_pair_new();
    pair->slashed = optional;
    size_t refs = pair->rc;
    assert(!scr_record_source_has(pair));
    scr_native_property_attributes(pair, "first", 5, 0);
    assert(metadata_prepare(pair));
    ScrDyn *owner = scr_record_source_view(pair);
    assert(owner && pair->rc == refs && owner->v.obj.len == (optional == -2 ? 1 : 2));
    assert(!scr_dyn_obj_get(owner, "%call", 5));
    if (optional == -1) {
      assert(owner->v.obj.entries[0].key_len == 6);
      assert(scr_dyn_obj_get(owner, "second", 6)->kind == SCR_DYN_UNDEF);
    }
    ScrDynEntry *first = &owner->v.obj.entries[owner->v.obj.len - 1];
    assert(first->value->kind == SCR_DYN_UNDEF);
    assert(!first->writable && !first->enumerable && !first->configurable);
    scr_dyn_obj_set(owner, "extra", 5, scr_dyn_new_num(17));
    size_t length = owner->v.obj.len;
    assert(metadata_prepare(pair));
    assert(scr_record_source_view(pair) == owner && owner->v.obj.len == length);
    assert(scr_dyn_obj_get(owner, "extra", 5)->v.num == 17 && pair->rc == refs);
    test_pair_release(pair);
  }
  TestPair immutable = {.rc = SIZE_MAX};
  assert(metadata_prepare(&immutable));
  assert(!scr_record_source_has(&immutable) && test_pairs_live == 0);
}

static void native_property_first_write(void) {
  for (unsigned restricted = 0; restricted < 2; restricted++) {
    for (unsigned operation = 0; operation < 7; operation++) {
      TestPair *pair = test_pair_new();
      pair->quoted = 1;
      pair->slashed = 2;
      ScrDyn *first = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
          "record:a", 8, metadata_prepared_view, NULL);
      ScrDyn *second = scr_dyn_new_typed_ref_observed(pair, integrity_pair_retain, test_pair_release,
          "record:b", 8, metadata_prepared_view, NULL);
      scr_dyn_typed_ref_bind_native_object(first, &metadata_prepare_ops);
      scr_dyn_typed_ref_bind_native_object(second, &metadata_prepare_ops);
      metadata_pair_keys(first, "[\"second\",\"first\"]");
      metadata_pair_keys(second, "[\"second\",\"first\"]");
      assert(!scr_record_source_has(pair));
      ScrDyn *number = scr_dyn_new_num(9);
      assert(!scr_dyn_set_prototype(first, number) && scr_exc_pending());
      scr_exc_clear();
      assert(!scr_dyn_set_prototype(first, second) && scr_exc_pending());
      scr_exc_clear();
      assert(!scr_record_source_has(pair));
      ScrStr *name = scr_str_new("%call", 5);
      ScrDyn *key = scr_dyn_new_str(name);
      ScrSym *identity = scr_sym_new(name);
      ScrDyn *symbol = scr_dyn_new_symbol(identity);
      scr_sym_release(identity);
      ScrDyn *prototype = scr_dyn_new_obj();
      ScrDyn *descriptor = scr_dyn_new_obj();
      scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(number));
      scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
      scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
      scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
      if (restricted) scr_native_integrity_strengthen(pair, SCR_NATIVE_NON_EXTENSIBLE);
      bool reflected = true;
      switch (operation) {
      case 0: scr_dyn_key_set(first, name, number); break;
      case 1: scr_dyn_release(scr_dyn_define_property(first, key, descriptor)); break;
      case 2: reflected = scr_dyn_reflect_set(first, key, number, first); break;
      case 3: scr_dyn_symbol_key_set(first, symbol, number); break;
      case 4: scr_dyn_release(scr_dyn_define_property(first, symbol, descriptor)); break;
      case 5: reflected = scr_dyn_reflect_set(first, symbol, number, first); break;
      case 6: scr_dyn_release(scr_dyn_set_prototype(first, prototype)); break;
      }
      if (restricted) {
        assert(!scr_record_source_has(pair));
        if (operation == 2 || operation == 5) assert(!reflected && !scr_exc_pending());
        else { assert(scr_exc_pending()); scr_exc_clear(); }
      } else {
        assert(reflected && !scr_exc_pending() && scr_record_source_has(pair));
        scr_dyn_release(first);
        first = NULL;
        if (operation < 3) {
          ScrDyn *value = scr_dyn_reflect_get(second, key, second);
          assert(value && value->kind == SCR_DYN_NUM && value->v.num == 9);
          scr_dyn_release(value);
          ScrJsonBuf buffer;
          scr_jb_init(&buffer);
          assert(scr_jb_try_record_source(&buffer, pair, metadata_prepared_field));
          ScrStr *text = scr_jb_finish(&buffer);
          assert(str_is(text, "{\"second\":2,\"first\":1,\"%call\":9}"));
          scr_str_release(text);
          scr_dyn_key_delete(second, name, true);
          assert(!scr_dyn_has_own(second, name));
        } else if (operation < 6) {
          metadata_symbol_number(second, symbol, 9);
          scr_dyn_key_delete_computed(second, symbol, true);
          assert(!scr_dyn_has_own_computed(second, symbol));
        } else {
          ScrDyn *observed = scr_dyn_get_prototype(second);
          assert(observed == prototype);
          scr_dyn_release(observed);
        }
      }
      assert(!scr_exc_pending() && pair->quoted == 1 && pair->slashed == 2);
      scr_dyn_release(first);
      scr_dyn_release(second);
      test_pair_release(pair);
      scr_dyn_release(number);
      scr_dyn_release(key);
      scr_dyn_release(symbol);
      scr_dyn_release(prototype);
      scr_dyn_release(descriptor);
      scr_str_release(name);
    }
  }
  scr_collect_cycles();
  assert(test_pairs_live == 0 && !scr_native_integrity_active());
}

typedef struct { size_t rc; ScrStr *leaf; } MetadataCycle;
static unsigned metadata_cycles_live;
static void metadata_cycle_trace(void *ptr, ScrTraceVisit visit, void *context) {
  scr_record_source_trace(ptr, visit, context);
}
static void metadata_cycle_free(void *ptr) {
  MetadataCycle *record = ptr;
  scr_record_source_collected(record);
  assert(!scr_record_source_has(record));
  scr_str_release(record->leaf);
  metadata_cycles_live--;
  scr_cyc_free(record);
}
static void metadata_cycle_release(void *ptr) {
  MetadataCycle *record = ptr;
  if (--record->rc) { scr_cyc_released(record); return; }
  scr_cyc_dead(record);
  scr_str_release(record->leaf);
  metadata_cycles_live--;
  scr_cyc_free(record);
}
static void *metadata_cycle_retain(void *ptr) {
  ((MetadataCycle *)ptr)->rc++;
  return ptr;
}
static MetadataCycle *metadata_cycle_new(void) {
  static ScrCycType type = {
    .trace = metadata_cycle_trace, .free_fn = metadata_cycle_free, .kind = SCR_CYC_KIND_EMITTED,
  };
  MetadataCycle *record = scr_cyc_alloc(sizeof *record, &type);
  record->rc = 1;
  record->leaf = scr_str_new("owned leaf", 10);
  metadata_cycles_live++;
  return record;
}
static bool metadata_cycle_prepare(void *ptr);
static const ScrDynNativeObjectOps metadata_cycle_ops = {
  .properties = metadata_prepare_properties, .prepare = metadata_cycle_prepare,
};
static bool metadata_cycle_prepare(void *ptr) {
  return scr_record_source_prepare(ptr, NULL, NULL, 0, &metadata_cycle_ops);
}
static ScrDyn *metadata_cycle_view(void *ptr) {
  (void)ptr;
  ScrDyn *view = scr_dyn_new_obj();
  view->copied_from_native = true;
  return view;
}
static ScrDyn *metadata_cycle_box(MetadataCycle *record) {
  ScrDyn *value = scr_dyn_new_typed_ref_traced(record, metadata_cycle_retain, metadata_cycle_release,
      "record:metadata", 15, metadata_cycle_view, NULL);
  scr_dyn_typed_ref_bind_native_object(value, &metadata_cycle_ops);
  return value;
}

static ScrDyn *metadata_prepare_receiver, *metadata_prepare_prototype;
static unsigned metadata_prepare_action, metadata_prepare_calls;
static bool metadata_callback_prepare(void *ptr) {
  metadata_prepare_calls++;
  assert(metadata_cycle_prepare(ptr));
  if (metadata_prepare_action == 1)
    scr_dyn_release(scr_dyn_set_prototype(metadata_prepare_prototype, metadata_prepare_receiver));
  else {
    if (metadata_prepare_action == 2)
      scr_dyn_release(scr_dyn_set_prototype(metadata_prepare_receiver, metadata_prepare_prototype));
    scr_native_integrity_strengthen(ptr, SCR_NATIVE_NON_EXTENSIBLE);
  }
  assert(!scr_exc_pending());
  return true;
}
static void native_record_prototype_revalidation(void) {
  /* Legacy metadata has no ops table; source-free records must not create
   * one just to accept their unchanged prototype after preventExtensions. */
  for (unsigned state = 0; state < 3; state++) {
    MetadataCycle *record = metadata_cycle_new();
    ScrDynNativeObjectOps ops = metadata_cycle_ops;
    ops.prepare = metadata_callback_prepare;
    ScrDyn *value = scr_dyn_new_typed_ref_traced(record,
        metadata_cycle_retain, metadata_cycle_release, "record:default", 14, metadata_cycle_view, NULL);
    if (state < 2) scr_dyn_typed_ref_bind_native_object(value, &ops);
    if (state) assert(metadata_cycle_prepare(record));
    scr_native_integrity_strengthen(record, SCR_NATIVE_NON_EXTENSIBLE);
    metadata_prepare_action = metadata_prepare_calls = 0;
    ScrDyn *prototype = scr_dyn_object_prototype();
    ScrDyn *result = scr_dyn_set_prototype(value, prototype);
    assert(result == value && !scr_exc_pending() && !metadata_prepare_calls);
    scr_dyn_release(result);
    assert(scr_record_source_has(record) == (state != 0));
    ScrDyn *replacement = scr_dyn_new_obj();
    assert(!scr_dyn_set_prototype(value, replacement) && scr_exc_pending());
    scr_exc_clear();
    assert(!scr_dyn_set_prototype(value, scr_dyn_new_null()) && scr_exc_pending());
    scr_exc_clear();
    assert(!metadata_prepare_calls && scr_record_source_has(record) == (state != 0));
    ScrDyn *owner = scr_record_source_view(record);
    assert(!owner || (!owner->prototype && !owner->null_proto));
    scr_dyn_release(replacement); scr_dyn_release(prototype); scr_dyn_release(value);
    metadata_cycle_release(record);
    scr_collect_cycles();
    assert(metadata_cycles_live == 0 && scr_record_source_trim_empty());
  }
  for (metadata_prepare_action = 0; metadata_prepare_action < 3; metadata_prepare_action++) {
    MetadataCycle *record = metadata_cycle_new();
    ScrDynNativeObjectOps ops = metadata_cycle_ops;
    ops.prepare = metadata_callback_prepare;
    metadata_prepare_receiver = scr_dyn_new_typed_ref_traced(record,
        metadata_cycle_retain, metadata_cycle_release, "record:callback", 15, metadata_cycle_view, NULL);
    scr_dyn_typed_ref_bind_native_object(metadata_prepare_receiver, &ops);
    metadata_prepare_prototype = scr_dyn_new_obj();
    metadata_prepare_calls = 0;
    ScrDyn *result = scr_dyn_set_prototype(metadata_prepare_receiver, metadata_prepare_prototype);
    assert(metadata_prepare_calls == 1);
    ScrDyn *owner = scr_record_source_view(record);
    if (metadata_prepare_action == 2) {
      assert(result == metadata_prepare_receiver && !scr_exc_pending());
      assert(owner->prototype == metadata_prepare_prototype);
      scr_dyn_release(result);
    } else {
      assert(!result && scr_exc_pending() && !owner->prototype);
      scr_exc_clear();
    }
    scr_dyn_release(metadata_prepare_receiver);
    scr_dyn_release(metadata_prepare_prototype);
    metadata_cycle_release(record);
    scr_collect_cycles();
    assert(metadata_cycles_live == 0 && scr_record_source_trim_empty());
  }
  metadata_prepare_receiver = metadata_prepare_prototype = NULL;
}

static void native_record_metadata_cycles(void) {
  scr_collect_cycles();
#ifdef SCR_RC_AUDIT
  size_t live = scr_cyc_live;
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  for (unsigned gen = 0; gen < SCR_CYC_NGENS; gen++) {
    for (unsigned edge = 0; edge < 3; edge++) {
      for (unsigned mutual = 0; mutual < 2; mutual++) {
        for (unsigned held = 0; held < 2; held++) {
          MetadataCycle *records[2] = {metadata_cycle_new(), mutual ? metadata_cycle_new() : NULL};
          ScrDyn *boxes[2] = {metadata_cycle_box(records[0]), mutual ? metadata_cycle_box(records[1]) : NULL};
          ScrDyn *survivor = scr_dyn_new_obj();
          scr_cyc_set_gen(scr_cyc_hdr(survivor), SCR_CYC_OLD);
          ScrStr *name = scr_str_new("back", 4);
          ScrSym *identity = scr_sym_new(name);
          ScrDyn *symbol = scr_dyn_new_symbol(identity);
          scr_sym_release(identity);
          for (unsigned i = 0; i <= mutual; i++) {
            ScrDyn *back = boxes[mutual ? 1 - i : 0];
            if (edge == 0) scr_dyn_key_set(boxes[i], name, back);
            else if (edge == 1) scr_dyn_symbol_key_set(boxes[i], symbol, back);
            else {
              ScrDyn *prototype = scr_dyn_new_obj();
              scr_dyn_obj_set(prototype, "back", 4, scr_dyn_retain(back));
              scr_dyn_release(scr_dyn_set_prototype(boxes[i], prototype));
              scr_dyn_release(prototype);
            }
            assert(!scr_exc_pending());
            ScrDyn *owner = scr_record_source_view(records[i]);
            assert(owner && !scr_record_source_trim_empty());
            scr_dyn_obj_set(owner, "survivor", 8, scr_dyn_retain(survivor));
            scr_cyc_set_gen(scr_cyc_hdr(records[i]), gen);
            scr_cyc_set_gen(scr_cyc_hdr(owner), (gen + 1) % SCR_CYC_NGENS);
          }
          ScrDyn *alias = held ? scr_dyn_retain(scr_record_source_view(records[0])) : NULL;
          scr_dyn_release(symbol);
          scr_str_release(name);
          for (unsigned i = 0; i <= mutual; i++) {
            scr_dyn_release(boxes[i]);
            metadata_cycle_release(records[i]);
          }
          scr_cyc_collect_scheduled();
          scr_collect_cycles();
          if (held) {
            assert(metadata_cycles_live == mutual + 1);
            assert(scr_dyn_obj_get(alias, "survivor", 8) == survivor);
            scr_dyn_release(alias);
            scr_collect_cycles();
          }
          assert(metadata_cycles_live == 0 && survivor->rc == 1);
          scr_dyn_release(survivor);
          assert(scr_record_source_trim_empty());
#ifdef SCR_RC_AUDIT
          /* Plain builds retain reusable dyn nodes in their allocation pools. */
          assert(scr_cyc_live == live);
#endif
        }
      }
    }
  }
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

typedef struct { ScrArr *ancestor; MetadataCycle *record; } MetadataPublication;
static void metadata_publish_pair(void *ptr, ScrPub *context) {
  MetadataPublication *pair = ptr;
  scr_pub_arr(pair->ancestor, context, NULL);
  assert(pair->ancestor->rc == SIZE_MAX);
  assert(!scr_pub_mark(context, pair->record, true, SCR_PUB_KIND_OBJECT));
}
static void native_record_metadata_publication(void) {
  ScrArr *ancestor = scr_arr_new(SCR_ELEM_F64, 0);
  scr_native_integrity_strengthen(ancestor, SCR_NATIVE_SEALED);
  scr_arr_retain(ancestor);
  scr_arr_release(ancestor);
  ScrCycHdr before = *scr_cyc_hdr(ancestor);
  MetadataCycle *record = metadata_cycle_new();
  assert(metadata_cycle_prepare(record) && !scr_native_property_metadata(record));
  ScrDyn *view = scr_record_source_view(record);
  scr_dyn_obj_set(view, "extra", 5, scr_dyn_new_num(42));
  MetadataPublication pair = {ancestor, record};
  scr_publish(&pair, metadata_publish_pair);
  assert(scr_exc_pending() && ancestor->rc == 1 && record->rc == 1);
  assert(memcmp(&before, scr_cyc_hdr(ancestor), sizeof before) == 0);
  assert(scr_native_integrity_flags(ancestor) == SCR_NATIVE_SEALED);
  assert(scr_record_source_view(record) == view && scr_dyn_obj_get(view, "extra", 5)->v.num == 42);
  scr_exc_clear();
  metadata_cycle_release(record);
  scr_arr_release(ancestor);
  scr_collect_cycles();
  assert(metadata_cycles_live == 0 && scr_record_source_trim_empty());
}

static void json_schema_parse(void) {
#ifdef SCR_RC_AUDIT
  long strings = scr_str_live_count();
#endif
  ScrArr *list = schema_parse(
      " [ {\"sku\":\"a\",\"qty\":1.5,\"ok\":true,\"tags\":[\"x\",\"y\\n\"]} ,"
      "{\"tags\":[],\"ok\":false,\"extra\":{\"n\":[1,\"s\\u00e9\",null,true,-2e-3,{}]},"
      "\"qty\":-0,\"\\u0073ku\":\"\\ud83d\\ude00\"} ] ");
  assert(list && list->len == 2 && test_items_live == 2);
  TestItem *first = scr_arr_get_ref(list, 0);
  assert(first->qty == 1.5 && first->ok == 1 && str_is(first->sku, "a"));
  assert(first->tags->len == 2);
  ScrStr *tag = scr_arr_get_ref(first->tags, 1);
  assert(str_is(tag, "y\n"));
  scr_str_release(tag);
  test_item_release(first);
  TestItem *second = scr_arr_get_ref(list, 1);
  assert(second->qty == 0 && signbit(second->qty) && second->ok == 0 && second->tags->len == 0);
  assert(str_is(second->sku, "\xF0\x9F\x98\x80"));
  /* The undeclared key and the reordered members stay beside the record in
   * source order; the record in declaration order keeps nothing. */
  assert(!scr_record_source_has(first));
  assert(scr_record_source_has(second));
  const ScrDyn *view = scr_record_source_view(second);
  static const char *const order[] = {"tags", "ok", "extra", "qty", "sku"};
  assert(view->kind == SCR_DYN_OBJ && view->v.obj.len == 5);
  for (size_t i = 0; i < 5; i++) {
    assert(view->v.obj.entries[i].key_len == strlen(order[i]));
    assert(memcmp(view->v.obj.entries[i].key, order[i], strlen(order[i])) == 0);
  }
  assert(scr_dyn_obj_get(view, "extra", 5)->kind == SCR_DYN_OBJ);
  test_item_release(second);
  assert(scr_record_source_has(second)); /* the list still holds it */
  scr_arr_release(list);
  assert(test_items_live == 0);
  assert(!scr_record_source_has(second)); /* released with the record */

  list = schema_parse("[]");
  assert(list && list->len == 0);
  scr_arr_release(list);

  /* Inputs the checked-dynamic route might reject or read differently
   * decline without throwing and release every partial value. */
  static const char *const declined[] = {
      "",
      "   ",
      "{}",
      "[null]",
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true}]",                         /* missing */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[],\"qty\":2}]",   /* duplicate */
      "[{\"sku\":\"a\",\"qty\":\"1\",\"ok\":true,\"tags\":[]}]",         /* kind */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[\"t\",7]}]",      /* nested kind */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[]},{\"sku\":\"b\"",  /* truncated */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[]},]",            /* trailing comma */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[]}] x",           /* trailing content */
      "[{\"sku\":\"a\",\"qty\":01,\"ok\":true,\"tags\":[]}]",            /* number syntax */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":tru,\"tags\":[]}]",              /* literal */
      "[{\"sku\":\"a\\q\",\"qty\":1,\"ok\":true,\"tags\":[]}]",          /* escape */
      "[{\"sku\":\"a\",\"x\":\"\\u12\",\"qty\":1,\"ok\":true,\"tags\":[]}]", /* skipped escape */
      "[{\"sku\":\"a\",\"x\":[1,],\"qty\":1,\"ok\":true,\"tags\":[]}]",  /* skipped syntax */
      "[{\"sku\":\"a\",\"x\":{\"k\" 1},\"qty\":1,\"ok\":true,\"tags\":[]}]",
      "[{\"sku\":\"a\nb\",\"qty\":1,\"ok\":true,\"tags\":[]}]",          /* control */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[]} {}]",
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[]},{\"sku\"",   /* key at the end */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[]},{\"sk",       /* cut key */
      "[{\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[]},{\"sku",      /* unclosed key */
  };
  for (size_t i = 0; i < sizeof declined / sizeof *declined; i++) {
    assert(!schema_parse(declined[i]));
    assert(test_items_live == 0);
  }

  /* Nesting beyond the checked parser's limit declines (it reports the
   * RangeError); nesting within it is kept beside the record. */
  for (int depth = 999; depth <= 1001; depth++) {
    char text[2200];
    size_t n = 0;
    n += (size_t)snprintf(text + n, sizeof text - n, "[{\"x\":");
    for (int i = 0; i < depth - 2; i++) text[n++] = '[';
    for (int i = 0; i < depth - 2; i++) text[n++] = ']';
    n += (size_t)snprintf(text + n, sizeof text - n, ",\"sku\":\"a\",\"qty\":1,\"ok\":true,\"tags\":[]}]");
    ScrArr *parsed = schema_parse(text);
    assert((parsed != NULL) == (depth <= 1000));
    scr_arr_release(parsed);
  }
  assert(test_items_live == 0);
#ifdef SCR_RC_AUDIT
  assert(scr_str_live_count() == strings);
#endif
}

typedef struct {
  size_t rc;
  unsigned fields[3];
  ScrDyn *properties;
  unsigned preparations;
  bool freeze_on_prepare;
  bool accessor_on_prepare;
  ScrDyn *prepare_error;
  ScrDyn *values[3];
  unsigned conversions;
  unsigned conversion_effect;
  unsigned snapshots;
  bool reject_snapshot;
  ScrDyn *prepare_prototype;
  unsigned prepare_facts;
} IntegrityNative;
static const char *const integrity_native_names[] = {"data", "accessor", "optional"};
static const size_t integrity_native_lengths[] = {4, 8, 8};
static const ScrDynNativeObjectOps integrity_native_ops;
static ScrDyn *integrity_native_read(void *ptr, size_t index, unsigned part) {
  IntegrityNative *object = ptr;
  assert(part == 0);
  return scr_dyn_retain(object->values[index] ? object->values[index] : scr_dyn_undefined());
}
static bool integrity_native_apply(void *ptr, size_t index, ScrNativeMutation *mutation) {
  IntegrityNative *object = ptr;
  if (scr_native_mutation_delete(mutation)) {
    if (index != 2) return scr_native_mutation_refuse(mutation);
    if (!scr_native_mutation_recheck(mutation)) return false;
    ScrDyn *old = object->values[index];
    object->values[index] = NULL;
    object->fields[index] = 0;
    scr_native_mutation_finish(mutation);
    scr_dyn_release(old);
    return true;
  }
  ScrDyn *converted = NULL;
  if (scr_native_mutation_write(mutation)) {
    object->conversions++;
    converted = scr_dyn_retain((ScrDyn *)scr_native_mutation_value(mutation));
    if (object->conversion_effect) {
      scr_dyn_release(object->values[1]);
      object->values[1] = scr_dyn_new_num(99);
      if (object->conversion_effect == 1)
        scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_FROZEN);
      else if (object->conversion_effect == 2)
        scr_throw_ref(scr_dyn_retain(object->prepare_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
      else if (object->conversion_effect == 3) object->fields[index] = 0;
      else if (object->conversion_effect >= 4) {
        if (object->conversion_effect == 5) {
          scr_dyn_release(converted);
          converted = scr_dyn_new_num(7);
        }
        scr_dyn_release(object->values[index]);
        object->values[index] = scr_dyn_retain(converted);
        scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_FROZEN);
      }
    }
  }
  if (!scr_native_mutation_recheck(mutation)) { scr_dyn_release(converted); return false; }
  ScrDyn *old = NULL;
  if (scr_native_mutation_write(mutation)) {
    old = object->values[index];
    object->values[index] = converted;
    converted = NULL;
    object->fields[index] = SCR_NATIVE_DEFAULT_DATA;
  }
  scr_native_mutation_finish(mutation);
  scr_dyn_release(old);
  scr_dyn_release(converted);
  return true;
}
static unsigned integrity_native_facts(void *ptr, size_t index) {
  return ((IntegrityNative *)ptr)->fields[index];
}
static ScrDyn *integrity_native_properties(void *ptr) {
  return ((IntegrityNative *)ptr)->properties;
}
static bool integrity_native_prepare(void *ptr) {
  IntegrityNative *object = ptr;
  object->preparations++;
  if (object->prepare_error && (!object->properties || object->conversion_effect != 2)) {
    scr_throw_ref(scr_dyn_retain(object->prepare_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    return false;
  }
  if (!object->properties) {
    object->properties = scr_dyn_new_obj();
    scr_native_object_sync_properties(object, object->properties);
  }
  if (object->freeze_on_prepare)
    scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_FROZEN);
  if (object->accessor_on_prepare) object->fields[2] = SCR_NATIVE_DEFAULT_ACCESSOR;
  return true;
}
static const ScrDynNativeObjectOps integrity_native_ops = {
  .count = 3, .names = integrity_native_names, .lengths = integrity_native_lengths, .facts = integrity_native_facts,
  .properties = integrity_native_properties, .prepare = integrity_native_prepare,
  .read = integrity_native_read, .apply = integrity_native_apply,
};
static IntegrityNative *integrity_native_new(void) {
  IntegrityNative *object = calloc(1, sizeof *object);
  assert(object);
  object->rc = 1;
  return object;
}
static void integrity_native_free(IntegrityNative *object) {
  scr_weak_dispose(object);
  scr_dyn_release(object->properties);
  scr_dyn_release(object->prepare_error);
  scr_dyn_release(object->prepare_prototype);
  for (size_t i = 0; i < 3; i++) scr_dyn_release(object->values[i]);
  free(object);
}

static void *integrity_native_retain(void *ptr) {
  IntegrityNative *object = ptr;
  if (object->rc != SIZE_MAX) object->rc++;
  return object;
}
static void integrity_native_release(void *ptr) {
  IntegrityNative *object = ptr;
  if (object->rc != SIZE_MAX && --object->rc == 0) integrity_native_free(object);
}
static ScrDyn *integrity_native_snapshot(void *ptr) {
  IntegrityNative *object = ptr;
  object->snapshots++;
  assert(!object->reject_snapshot);
  ScrDyn *view = scr_dyn_new_obj();
  for (size_t i = 0; i < 3; i++)
    if (object->fields[i] & SCR_NATIVE_OWN)
      scr_dyn_obj_set(view, integrity_native_names[i], integrity_native_lengths[i],
          integrity_native_read(object, i, 0));
  return view;
}
static ScrDyn *integrity_native_box(IntegrityNative *object) {
  ScrDyn *box = scr_dyn_new_typed_ref_observed(object, integrity_native_retain, integrity_native_release,
      "record:define", 13, integrity_native_snapshot, NULL);
  scr_dyn_typed_ref_bind_native_object(box, &integrity_native_ops);
  return box;
}
static bool integrity_native_define(ScrDyn *box, const char *key, ScrDyn *descriptor) {
  ScrStr *name = scr_str_new(key, strlen(key));
  ScrDyn *property = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *result = scr_dyn_define_property(box, property, descriptor);
  bool ok = result != NULL;
  if (ok) assert(result == box && !scr_exc_pending());
  scr_dyn_release(result);
  scr_dyn_release(property);
  return ok;
}

typedef struct { size_t rc; IntegrityNative *owner; bool *observed; bool deleting; } NativeReleaseWitness;
static void *native_release_witness_retain(void *ptr) {
  ((NativeReleaseWitness *)ptr)->rc++;
  return ptr;
}
static void native_release_witness_release(void *ptr) {
  NativeReleaseWitness *witness = ptr;
  if (--witness->rc) return;
  IntegrityNative *owner = witness->owner;
  if (witness->deleting) {
    assert(!owner->values[2] && !owner->fields[2]);
    assert(!scr_native_property_metadata(owner));
    assert(!scr_native_property_bag_facts(owner->properties, "optional", 8));
  } else {
    assert(owner->values[0]->kind == SCR_DYN_NUM && owner->values[0]->v.num == 7);
    assert(!scr_native_property_declared_undefined(owner, "data", 4));
    assert(!(scr_native_property_flags(owner, "data", 4, owner->fields[0]) & SCR_NATIVE_WRITABLE));
    assert(!(scr_native_property_bag_facts(owner->properties, "data", 4) & SCR_NATIVE_WRITABLE));
  }
  *witness->observed = true;
  scr_weak_dispose(witness);
  free(witness);
}

static void native_property_define(void) {
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  for (unsigned effect = 0; effect < 6; effect++) {
    IntegrityNative *object = integrity_native_new();
    object->fields[0] = object->fields[1] = SCR_NATIVE_DEFAULT_DATA;
    object->values[0] = scr_dyn_new_num(1);
    object->values[1] = scr_dyn_new_num(2);
    ScrDyn *box = integrity_native_box(object), *descriptor = scr_dyn_new_obj();
    assert(integrity_native_define(box, "data", descriptor));
    assert(!object->preparations && !object->conversions && !object->properties);
    scr_dyn_obj_set(descriptor, "value", 5, effect == 5 ? scr_dyn_new_obj() : scr_dyn_new_num(7));
    object->conversion_effect = effect;
    /* Conversion failure is distinct from preparation failure. */
    object->prepare_error = effect == 2 ? scr_dyn_new_obj() : NULL;
    if (effect == 2) {
      ScrDyn *marker = object->prepare_error;
      assert(!integrity_native_define(box, "data", descriptor));
      ScrCaught *caught = scr_exc_take();
      assert(caught && caught->payload == marker && object->conversions == 0);
      scr_caught_release(caught);
      object->prepare_error = NULL;
      assert(integrity_native_prepare(object));
      object->prepare_error = marker;
    }
    /* Bypass the fixture's preparation throw after it has prepared once. */
    bool ok = integrity_native_define(box, "data", descriptor);
    assert(ok == (effect == 0 || effect == 3 || effect == 4));
    if (!ok) {
      ScrCaught *caught = scr_exc_take();
      assert(caught);
      if (effect == 2) assert(caught->payload == object->prepare_error);
      scr_caught_release(caught);
    }
    assert(object->values[0]->v.num == (ok || effect == 5 ? 7 : 1));
    assert(object->values[1]->v.num == (effect ? 99 : 2));
    assert(object->conversions == 1);
    if (effect == 3) {
      unsigned facts = scr_native_property_flags(object, "data", 4, object->fields[0]);
      assert(facts == (SCR_NATIVE_OWN | SCR_NATIVE_DATA));
    }
    scr_dyn_release(descriptor);
    scr_dyn_release(box);
    integrity_native_release(object);
  }
  IntegrityNative *object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  object->values[0] = scr_dyn_new_num(NAN);
  ScrDyn *box = integrity_native_box(object), *descriptor = scr_dyn_new_obj();
  scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_FROZEN);
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(NAN));
  assert(integrity_native_define(box, "data", descriptor));
  assert(!object->preparations && !object->conversions && !object->properties);
  scr_dyn_release(object->values[0]); object->values[0] = scr_dyn_new_num(0);
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(-0.0));
  assert(!integrity_native_define(box, "data", descriptor));
  scr_exc_clear();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(0));
  object->rc = SIZE_MAX;
  assert(integrity_native_define(box, "data", descriptor));
  assert(!object->preparations && !object->conversions && !object->properties);
  object->rc = 2;
  scr_dyn_release(descriptor); scr_dyn_release(box); integrity_native_release(object);

  object = integrity_native_new();
  box = integrity_native_box(object); descriptor = scr_dyn_new_obj();
  assert(integrity_native_define(box, "optional", descriptor));
  assert(object->values[2]->kind == SCR_DYN_UNDEF && object->conversions == 1);
  assert(scr_native_property_flags(object, "optional", 8, object->fields[2]) ==
      (SCR_NATIVE_OWN | SCR_NATIVE_DATA));
  assert(integrity_native_define(box, "optional", descriptor));
  assert(object->conversions == 1 && object->preparations == 1);
  scr_dyn_release(descriptor); scr_dyn_release(box); integrity_native_release(object);

  object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  bool observed = false;
  NativeReleaseWitness *witness = malloc(sizeof *witness);
  assert(witness);
  *witness = (NativeReleaseWitness){1, object, &observed, false};
  object->values[0] = scr_dyn_new_typed_ref_observed(witness, native_release_witness_retain,
      native_release_witness_release, "record:witness", 14, NULL, NULL);
  native_release_witness_release(witness);
  box = integrity_native_box(object); descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(7));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  assert(integrity_native_define(box, "data", descriptor) && observed);
  scr_dyn_release(descriptor); scr_dyn_release(box); integrity_native_release(object);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static ScrDyn *native_set_receiver, *native_set_prototype, *native_set_error;
static IntegrityNative *native_set_owner;
static unsigned native_set_calls;
static ScrDyn *native_property_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *receiver = scr_dyn_this_get();
  assert(receiver == native_set_receiver && argc == 1);
  native_set_calls++;
  ScrStr *key = scr_str_new("optional", 8);
  scr_dyn_key_delete(native_set_prototype, key, true);
  scr_str_release(key);
  key = scr_str_new("data", 4);
  scr_dyn_key_set(receiver, key, args[0]);
  scr_str_release(key);
  assert(native_set_owner->values[0]->v.num == args[0]->v.num);
  scr_dyn_release(receiver);
  if (native_set_error)
    scr_throw_ref(scr_dyn_retain(native_set_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  return scr_dyn_retain(scr_dyn_undefined());
}

static void native_property_set(void) {
  /* Initialize the shared default prototype before measuring fixture lifetime. */
  scr_dyn_release(scr_dyn_object_prototype());
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  ScrStr *name = scr_str_new("data", 4), *optional = scr_str_new("optional", 8);
  ScrDyn *key = scr_dyn_new_str(name), *optional_key = scr_dyn_new_str(optional);
  for (unsigned effect = 0; effect < 6; effect++) {
    IntegrityNative *object = integrity_native_new();
    object->fields[0] = object->fields[1] = SCR_NATIVE_DEFAULT_DATA;
    object->values[0] = scr_dyn_new_num(1);
    object->values[1] = scr_dyn_new_num(2);
    ScrDyn *box = integrity_native_box(object);
    ScrDyn *alias = scr_dyn_new_typed_ref_observed(object, integrity_native_retain, integrity_native_release,
        "record:alias", 12, integrity_native_snapshot, NULL);
    scr_dyn_typed_ref_bind_native_object(alias, &integrity_native_ops);
    scr_dyn_release(scr_dyn_typed_ref_materialize(box));
    scr_dyn_release(scr_dyn_typed_ref_materialize(alias));
    unsigned snapshots = object->snapshots;
    object->reject_snapshot = true;
    object->conversion_effect = effect;
    if (effect == 2) {
      assert(integrity_native_prepare(object));
      object->prepare_error = scr_dyn_new_obj();
    }
    ScrDyn *value = effect == 5 ? scr_dyn_new_obj() : scr_dyn_new_num(7);
    bool ok = scr_dyn_reflect_set(box, key, value, alias);
    assert(ok == (effect == 0 || effect == 3));
    assert(scr_exc_pending() == (effect == 2));
    if (effect == 2) {
      ScrCaught *caught = scr_exc_take();
      assert(caught && caught->payload == object->prepare_error);
      scr_caught_release(caught);
    }
    assert(object->values[0]->v.num == (ok || effect >= 4 ? 7 : 1));
    assert(object->values[1]->v.num == (effect ? 99 : 2));
    assert(object->conversions == 1 && object->snapshots == snapshots);
    if (effect == 3)
      assert(scr_native_property_flags(object, "data", 4, object->fields[0]) == SCR_NATIVE_DEFAULT_DATA);
    if (effect == 1 || effect >= 4) {
      scr_dyn_key_set(alias, name, object->values[0]);
      assert(scr_exc_pending() && object->conversions == 1);
      scr_exc_clear();
    }
    scr_dyn_release(value); scr_dyn_release(alias); scr_dyn_release(box); integrity_native_release(object);
  }
  IntegrityNative *object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  object->values[0] = scr_dyn_new_num(1);
  object->reject_snapshot = true;
  ScrDyn *box = integrity_native_box(object), *value = scr_dyn_new_num(8), *receiver = scr_dyn_new_obj();
  scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_NON_EXTENSIBLE);
  assert(scr_dyn_reflect_set(box, key, value, receiver));
  assert(object->values[0]->v.num == 1 && !object->conversions && !object->preparations);
  assert(receiver->v.obj.len == 1 && receiver->v.obj.entries[0].value->v.num == 8);
  scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_FROZEN);
  assert(!scr_dyn_reflect_set(box, key, object->values[0], receiver) && !scr_exc_pending());
  scr_dyn_release(receiver); scr_dyn_release(box); integrity_native_release(object);

  for (unsigned throwing = 0; throwing < 2; throwing++) {
    object = integrity_native_new();
    object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
    object->values[0] = scr_dyn_new_num(1);
    object->reject_snapshot = true;
    box = integrity_native_box(object);
    assert(integrity_native_prepare(object));
    ScrDyn *prototype = scr_dyn_new_obj(), *descriptor = scr_dyn_new_obj();
    object->properties->prototype = scr_dyn_retain(prototype);
    ScrDyn *setter = scr_dyn_new_func(scr_closure_new(NULL, 0), native_property_setter, 1,
        "func(dyn)=>dyn", "native property setter");
    scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_retain(setter));
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    scr_dyn_release(scr_dyn_define_property(prototype, optional_key, descriptor));
    native_set_owner = object; native_set_receiver = box; native_set_prototype = prototype;
    native_set_error = throwing ? scr_dyn_new_obj() : NULL;
    native_set_calls = 0;
    scr_dyn_key_set(box, optional, value);
    assert(native_set_calls == 1 && !object->fields[2] && object->conversions == 1);
    assert(scr_exc_pending() == (throwing != 0));
    if (throwing) {
      ScrCaught *caught = scr_exc_take();
      assert(caught && caught->payload == native_set_error);
      scr_caught_release(caught);
    }
    /* Receiver definition does not visit its inherited setter. */
    scr_dyn_release(scr_dyn_define_property(prototype, optional_key, descriptor));
    ScrDyn *target = scr_dyn_new_obj();
    assert(scr_dyn_reflect_set(target, optional_key, value, box));
    assert(native_set_calls == 1 && object->values[2]->v.num == 8 && object->conversions == 2);
    assert(scr_native_property_flags(object, "optional", 8, object->fields[2]) == SCR_NATIVE_DEFAULT_DATA);
    scr_native_property_attributes(object, "optional", 8, SCR_NATIVE_WRITABLE);
    ScrDyn *changed = scr_dyn_new_num(9);
    assert(scr_dyn_reflect_set(target, optional_key, changed, box));
    assert(scr_native_property_flags(object, "optional", 8, object->fields[2]) ==
        (SCR_NATIVE_OWN | SCR_NATIVE_DATA | SCR_NATIVE_WRITABLE));
    object->fields[2] = SCR_NATIVE_DEFAULT_ACCESSOR;
    assert(!scr_dyn_reflect_set(target, optional_key, value, box) && !scr_exc_pending());
    assert(native_set_calls == 1);
    scr_dyn_release(changed); scr_dyn_release(target); scr_dyn_release(setter); scr_dyn_release(descriptor);
    scr_dyn_release(prototype); scr_dyn_release(native_set_error);
    native_set_error = native_set_receiver = native_set_prototype = NULL; native_set_owner = NULL;
    scr_dyn_release(box); integrity_native_release(object);
  }
  scr_dyn_release(value); scr_dyn_release(key); scr_dyn_release(optional_key);
  scr_str_release(name); scr_str_release(optional);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static void native_property_delete(void) {
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  ScrStr *name = scr_str_new("optional", 8), *required = scr_str_new("data", 4);
  ScrDyn *key = scr_dyn_new_str(name), *value = scr_dyn_new_num(9);
  for (unsigned state = 0; state < 3; state++) {
    IntegrityNative *object = integrity_native_new();
    object->reject_snapshot = true;
    ScrDyn *box = integrity_native_box(object);
    scr_dyn_key_delete(box, name, true);
    assert(!scr_exc_pending() && !object->preparations && !object->conversions);
    bool observed = false;
    if (state == 0) {
      NativeReleaseWitness *witness = malloc(sizeof *witness);
      assert(witness);
      *witness = (NativeReleaseWitness){1, object, &observed, true};
      object->values[2] = scr_dyn_new_typed_ref_observed(witness, native_release_witness_retain,
          native_release_witness_release, "record:delete-witness", 21, NULL, NULL);
      native_release_witness_release(witness);
    } else object->values[2] = scr_dyn_retain(scr_dyn_undefined());
    object->fields[2] = SCR_NATIVE_DEFAULT_DATA;
    if (state != 2) {
      assert(integrity_native_prepare(object));
      scr_dyn_obj_set(object->properties, "first", 5, scr_dyn_new_num(1));
      scr_dyn_obj_set(object->properties, "optional", 8, scr_dyn_retain(scr_dyn_undefined()));
      scr_dyn_obj_set(object->properties, "last", 4, scr_dyn_new_num(2));
      scr_native_property_attributes(object, "optional", 8, SCR_NATIVE_ENUMERABLE | SCR_NATIVE_CONFIGURABLE);
    }
    unsigned preparations = object->preparations;
    scr_dyn_key_delete(box, name, true);
    assert(!scr_exc_pending() && !object->fields[2] && !object->values[2]);
    assert(!object->conversions && object->preparations == preparations);
    assert(state || observed);
    if (object->properties) metadata_pair_keys(object->properties, "[\"first\",\"last\"]");
    assert(scr_dyn_reflect_set(box, key, value, box));
    assert(object->values[2]->v.num == 9 && object->conversions == 1);
    assert(scr_native_property_flags(object, "optional", 8, object->fields[2]) == SCR_NATIVE_DEFAULT_DATA);
    if (state != 2) metadata_pair_keys(object->properties, "[\"first\",\"last\",\"optional\"]");
    scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_SEALED);
    scr_dyn_key_delete(box, name, false);
    assert(!scr_exc_pending() && object->values[2]->v.num == 9);
    scr_dyn_key_delete(box, name, true);
    assert(scr_exc_pending() && object->values[2]->v.num == 9);
    scr_exc_clear();
    /* A pending callback exception must never be converted to quiet refusal. */
    ScrDyn *marker = scr_dyn_new_obj();
    scr_throw_ref(scr_dyn_retain(marker), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_dyn_key_delete(box, name, false);
    ScrCaught *caught = scr_exc_take();
    assert(caught && caught->payload == marker && object->values[2]->v.num == 9);
    scr_caught_release(caught); scr_dyn_release(marker);
    scr_dyn_release(box); integrity_native_release(object);
  }
  IntegrityNative *object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  object->values[0] = scr_dyn_new_num(1);
  object->reject_snapshot = true;
  object->prepare_error = scr_dyn_new_obj();
  ScrDyn *box = integrity_native_box(object);
  scr_dyn_key_delete(box, required, false);
  assert(!scr_exc_pending() && object->values[0]->v.num == 1 && !object->preparations);
  scr_dyn_key_delete(box, required, true);
  assert(scr_exc_pending() && object->values[0]->v.num == 1 && !object->preparations);
  ScrCaught *caught = scr_exc_take();
  ScrStr *message = scr_caught_to_string(caught);
  assert(str_is(message, "TypeError: Cannot delete property 'data' of #<Object>"));
  scr_str_release(message); scr_caught_release(caught);
  scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_FROZEN);
  object->rc = SIZE_MAX;
  scr_dyn_key_delete(box, name, true);
  assert(!scr_exc_pending() && !object->properties && !object->preparations && !object->conversions);
  object->rc = 2;
  scr_dyn_release(box); integrity_native_release(object);
  scr_dyn_release(key); scr_dyn_release(value); scr_str_release(name); scr_str_release(required);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static unsigned typed_receiver_boxes, typed_value_boxes, typed_set_calls;
static ScrDyn *typed_set_value, *typed_set_receiver, *typed_set_error;
static IntegrityNative *typed_set_owner;
static unsigned typed_box_error;
static ScrDyn *typed_receiver_box(uint64_t bits) {
  typed_receiver_boxes++;
  ScrDyn *box = integrity_native_box((IntegrityNative *)(uintptr_t)bits);
  if (typed_box_error == 1)
    scr_throw_ref(scr_dyn_retain(typed_set_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  return box;
}
static ScrDyn *typed_value_box(uint64_t bits) {
  typed_value_boxes++;
  if (typed_box_error == 2)
    scr_throw_ref(scr_dyn_retain(typed_set_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  return scr_dyn_retain((ScrDyn *)(uintptr_t)bits);
}
static ScrDyn *typed_property_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *receiver = scr_dyn_this_get();
  assert(receiver == typed_set_receiver && argc == 1 && args[0] == typed_set_value);
  typed_set_calls++;
  /* Reentrant public Set defines normally, even while a typed Set is deferred. */
  ScrStr *name = scr_str_new("data", 4);
  ScrDyn *key = scr_dyn_new_str(name), *target = scr_dyn_new_obj();
  assert(scr_dyn_reflect_set(target, key, args[0], receiver));
  scr_dyn_release(target); scr_dyn_release(key); scr_str_release(name);
  assert(typed_set_owner->values[0] == args[0]);
  scr_native_object_restrict(typed_set_owner, &integrity_native_ops, SCR_NATIVE_FROZEN);
  scr_dyn_release(receiver);
  if (typed_set_error)
    scr_throw_ref(scr_dyn_retain(typed_set_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  return scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *typed_proxy_set(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  assert(argc == 4 && args[2] == typed_set_value && args[3] == typed_set_receiver);
  typed_set_calls++;
  return scr_dyn_new_bool(true);
}
static ScrDyn *typed_detach_array;
static ScrDyn *typed_proxy_detach(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  assert(argc == 4 && args[3] == typed_set_receiver);
  ScrDyn *null = scr_dyn_new_null();
  scr_dyn_release(scr_dyn_set_prototype(typed_detach_array, null));
  scr_dyn_release(null);
  return scr_dyn_new_bool(true);
}
static void *typed_array_retain(void *ptr) { return scr_arr_retain(ptr); }
static void typed_array_release(void *ptr) { scr_arr_release(ptr); }
static bool typed_array_unbox(const ScrDyn *value, uint64_t *bits) {
  assert(value->kind == SCR_DYN_NUM);
  memcpy(bits, &value->v.num, sizeof *bits);
  return true;
}
static ScrDyn *typed_array_box(uint64_t bits) {
  double value; memcpy(&value, &bits, sizeof value);
  return scr_dyn_new_num(value);
}
static const ScrDynTypedArrayOps typed_array_ops = { .box = typed_array_box, .unbox = typed_array_unbox };
typedef struct { size_t rc; IntegrityNative *owner; } TypedCleanup;
static void *typed_cleanup_retain(void *ptr) { ((TypedCleanup *)ptr)->rc++; return ptr; }
static void typed_cleanup_release(void *ptr) {
  TypedCleanup *cleanup = ptr;
  if (--cleanup->rc) return;
  scr_native_object_restrict(cleanup->owner, &integrity_native_ops, SCR_NATIVE_FROZEN);
  free(cleanup);
}
static ScrDyn *typed_cleanup_box(uint64_t bits) {
  IntegrityNative *owner = (IntegrityNative *)(uintptr_t)bits;
  ScrDyn *box = scr_dyn_new_typed_ref_observed(owner, integrity_native_retain, integrity_native_release,
      "record:cleanup", 14, integrity_native_snapshot, NULL);
  scr_dyn_typed_ref_bind_native_object(box, &integrity_native_ops);
  TypedCleanup *cleanup = malloc(sizeof *cleanup);
  assert(cleanup); *cleanup = (TypedCleanup){1, owner};
  ScrDyn *witness = scr_dyn_new_typed_ref_observed(cleanup, typed_cleanup_retain, typed_cleanup_release,
      "record:cleanup-effect", 21, NULL, NULL);
  typed_cleanup_release(cleanup);
  box->v.typed_ref.materialized = scr_dyn_new_obj();
  scr_dyn_obj_set(box->v.typed_ref.materialized, "witness", 7, witness);
  return box;
}
static ScrDyn *typed_symbol_set(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *receiver = scr_dyn_this_get();
  assert(argc == 1 && receiver == typed_set_receiver && args[0] == typed_set_value);
  typed_set_calls++;
  scr_dyn_release(receiver);
  return scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *typed_primitive_view(void *ptr) {
  IntegrityNative *owner = ptr;
  if (owner->prepare_error) {
    scr_throw_ref(scr_dyn_retain(owner->prepare_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    return NULL;
  }
  return scr_dyn_new_num(7);
}

static ScrDyn *native_accessor_invoke(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  ScrDyn *receiver = scr_dyn_this_get();
  assert(receiver == typed_set_receiver && argc <= 1);
  if (argc) assert(args[0] == typed_set_value);
  typed_set_calls++;
  return receiver;
}
static ScrDyn *native_accessor_read(void *ptr, size_t index, unsigned part) {
  IntegrityNative *object = ptr;
  assert(index == 1 && (part == 1 || part == 2));
  return scr_dyn_retain(object->values[part - 1] ? object->values[part - 1] : scr_dyn_undefined());
}
static ScrDyn *native_accessor_box(uint64_t bits) {
  assert((void *)(uintptr_t)bits == typed_set_receiver->v.typed_ref.ptr);
  return scr_dyn_retain(typed_set_receiver);
}
static void native_accessor_prototype_receivers(void) {
  ScrStr *name = scr_str_new("accessor", 8);
  ScrDyn *key = scr_dyn_new_str(name);
  typed_set_value = scr_dyn_new_num(17);
  for (unsigned route = 0; route < 3; route++) {
    IntegrityNative *object = integrity_native_new();
    object->fields[1] = SCR_NATIVE_DEFAULT_ACCESSOR;
    object->reject_snapshot = true;
    object->values[0] = scr_dyn_new_func(scr_closure_new(NULL, 0), native_accessor_invoke,
        0, "func()=>dyn", "getter");
    object->values[1] = scr_dyn_new_func(scr_closure_new(NULL, 0), native_accessor_invoke,
        1, "func(dyn)=>dyn", "setter");
    ScrDynNativeObjectOps ops = integrity_native_ops;
    ops.prepare = NULL; ops.apply = NULL; ops.read = native_accessor_read;
    ScrDyn *prototype = scr_dyn_new_typed_ref_observed(object,
        integrity_native_retain, integrity_native_release, "record:accessor", 15,
        integrity_native_snapshot, NULL);
    scr_dyn_typed_ref_bind_native_object(prototype, &ops);
    ScrDyn *receiver = route == 2 ? scr_dyn_new_arr() : scr_dyn_new_obj();
    if (route) {
      ScrDyn *middle = scr_dyn_new_obj();
      middle->prototype = scr_dyn_retain(prototype);
      receiver->prototype = middle;
    }
    scr_dyn_release(scr_dyn_freeze(receiver));
    typed_set_receiver = receiver;
    typed_set_calls = 0;
    ScrDyn *target = route ? receiver : prototype;
    ScrDyn *read = scr_dyn_reflect_get(target, key, receiver);
    assert(read == receiver && !scr_exc_pending());
    scr_dyn_release(read);
    assert(scr_dyn_reflect_set(target, key, typed_set_value, receiver));
    if (route) {
      read = scr_dyn_obj_read(receiver, "accessor", 8);
      assert(read == receiver && !scr_exc_pending());
      scr_dyn_release(read);
      scr_dyn_key_set(receiver, name, typed_set_value);
    }
    assert(!scr_exc_pending() && typed_set_calls == (route ? 4 : 2));
    assert(!scr_dyn_has_own(receiver, name) && !object->snapshots && !object->preparations);
    scr_dyn_release(object->values[1]); object->values[1] = NULL;
    assert(!scr_dyn_reflect_set(target, key, typed_set_value, receiver) && !scr_exc_pending());
    scr_dyn_key_set(route ? receiver : prototype, name, typed_set_value);
    ScrCaught *caught = scr_exc_take();
    assert(caught);
    ScrStr *message = scr_caught_to_string(caught);
    assert(str_is(message, "TypeError: Cannot set property accessor of #<Object> which has only a getter"));
    scr_str_release(message); scr_caught_release(caught);
    if (!route) {
      typed_set_receiver = prototype;
      for (unsigned sloppy = 0; sloppy < 2; sloppy++) {
        assert(!scr_native_object_check_set(object, &ops, name,
            sloppy ? SCR_NATIVE_SET_SLOPPY : SCR_NATIVE_SET,
            (uint64_t)(uintptr_t)typed_set_value, typed_value_box, native_accessor_box));
        assert(scr_exc_pending() == !sloppy);
        if (!sloppy) {
          caught = scr_exc_take(); message = scr_caught_to_string(caught);
          assert(str_is(message, "TypeError: Cannot set property accessor of #<Object> which has only a getter"));
          scr_str_release(message); scr_caught_release(caught);
        }
      }
    }
    scr_dyn_release(receiver); scr_dyn_release(prototype); integrity_native_release(object);
  }
  scr_dyn_release(typed_set_value); scr_dyn_release(key); scr_str_release(name);
  typed_set_receiver = typed_set_value = NULL;
}

static void native_property_typed_set(void) {
  ScrDyn *tagged = scr_dyn_new_obj();
  tagged->v.obj.class_name = "Temporary";
  scr_dyn_release(tagged);
  ScrDyn *reused = scr_dyn_new_obj();
  assert(!reused->v.obj.class_name);
  reused->v.obj.class_name = "";
  ScrDyn *anonymous = scr_dyn_new_obj();
  anonymous->prototype = scr_dyn_retain(reused);
  assert(!scr_dyn_class_name(anonymous));
  scr_dyn_release(anonymous);
  scr_dyn_release(reused);
  scr_dyn_release(scr_dyn_object_prototype());
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  ScrStr *name = scr_str_new("optional", 8);
  ScrDyn *key = scr_dyn_new_str(name);
  /* Setter, non-extensible setter, throwing setter, getter-only, present
   * undefined, readonly own data, null prototype, prepare-time freeze,
   * proxy trap/no-trap, native prototype, array->native prototype. */
  for (unsigned mode = 0; mode < 16; mode++) {
    for (unsigned sloppy = 0; sloppy < 2; sloppy++) {
      IntegrityNative *object = integrity_native_new(), *prototype_object = NULL;
      object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
      object->reject_snapshot = true;
      assert(integrity_native_prepare(object));
      ScrDyn *receiver = integrity_native_box(object), *prototype = scr_dyn_new_obj();
      ScrDyn *descriptor = scr_dyn_new_obj(), *value = scr_dyn_new_obj();
      ScrDyn *setter = scr_dyn_new_func(scr_closure_new(NULL, 0), typed_property_setter, 1,
          "func(dyn)=>dyn", "typed setter");
      if (mode != 3) scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_retain(setter));
      else scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_retain(setter));
      scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
      scr_dyn_release(scr_dyn_define_property(prototype, key, descriptor));
      if (mode == 8 || mode == 9) {
        ScrDyn *handler = scr_dyn_new_obj();
        if (mode == 8) scr_dyn_obj_set(handler, "set", 3,
            scr_dyn_new_func(scr_closure_new(NULL, 0), typed_proxy_set, 4, "func(dyn,dyn,dyn,dyn)=>dyn", "typed proxy"));
        ScrDyn *proxy = scr_dyn_proxy_new(prototype, handler);
        scr_dyn_release(handler); scr_dyn_release(prototype); prototype = proxy;
      } else if (mode == 10 || mode == 11) {
        prototype_object = integrity_native_new();
        prototype_object->reject_snapshot = true;
        assert(integrity_native_prepare(prototype_object));
        prototype_object->properties->prototype = scr_dyn_retain(prototype);
        ScrDyn *native = integrity_native_box(prototype_object);
        scr_dyn_release(prototype); prototype = native;
        if (mode == 11) {
          ScrDyn *array = scr_dyn_new_arr();
          array->prototype = prototype;
          prototype = array;
        }
      }
      if (mode == 6 || mode == 7) object->properties->null_proto = true;
      else object->properties->prototype = scr_dyn_retain(prototype);
      if (mode == 1) scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_NON_EXTENSIBLE);
      if (mode == 4 || mode == 5 || mode == 14) {
        object->fields[2] = SCR_NATIVE_DEFAULT_DATA;
        object->values[2] = scr_dyn_retain(scr_dyn_undefined());
        if (mode == 5) scr_native_object_restrict(object, &integrity_native_ops, SCR_NATIVE_FROZEN);
      }
      object->freeze_on_prepare = mode == 7;
      object->accessor_on_prepare = mode == 14;
      typed_receiver_boxes = typed_value_boxes = typed_set_calls = 0;
      typed_set_owner = object; typed_set_receiver = receiver; typed_set_value = value;
      typed_set_error = mode == 2 || mode == 12 || mode == 13 ? scr_dyn_new_obj() : NULL;
      typed_box_error = mode == 12 ? 1 : mode == 13 ? 2 : 0;
      ScrDynNativeObjectOps receiver_ops = integrity_native_ops;
      if (mode == 15) receiver_ops.apply = NULL;
      bool store = scr_native_object_check_set(object, &receiver_ops, name,
          sloppy ? SCR_NATIVE_SET_SLOPPY : SCR_NATIVE_SET, (uint64_t)(uintptr_t)value,
          typed_value_box, typed_receiver_box);
      assert(store == (mode == 4 || mode == 6));
      bool refused = mode == 3 || mode == 5 || mode == 7 || mode == 14;
      assert(scr_exc_pending() == (typed_set_error != NULL || (refused && !sloppy)));
      if (scr_exc_pending()) {
        ScrCaught *caught = scr_exc_take();
        assert(caught);
        if (typed_set_error) assert(caught->payload == typed_set_error);
        if (mode == 3) {
          ScrStr *message = scr_caught_to_string(caught);
          assert(str_is(message, "TypeError: Cannot set property optional of #<Object> which has only a getter"));
          scr_str_release(message);
        }
        scr_caught_release(caught);
      }
      assert(typed_set_calls == (mode <= 2 || (mode >= 8 && mode <= 11) || mode >= 15 ? 1u : 0u));
      assert(typed_receiver_boxes == (mode == 4 || mode == 5 || mode == 14 ? 0u : 1u));
      assert(typed_value_boxes == (mode == 12 ? 0u : typed_receiver_boxes) && !object->snapshots);
      if (store) {
        ScrDyn *old = object->values[2];
        object->values[2] = scr_dyn_retain(value);
        object->fields[2] = SCR_NATIVE_DEFAULT_DATA;
        scr_native_object_finish_write(object, &integrity_native_ops, name, SCR_NATIVE_SET);
        scr_dyn_release(old);
      }
      assert((object->fields[2] & SCR_NATIVE_OWN) != 0 ? mode == 4 || mode == 5 || mode == 6 || mode == 14 : true);
      scr_dyn_release(typed_set_error); typed_set_error = typed_set_receiver = typed_set_value = NULL;
      typed_set_owner = NULL;
      typed_box_error = 0;
      scr_dyn_release(setter); scr_dyn_release(descriptor); scr_dyn_release(value);
      scr_dyn_release(prototype); scr_dyn_release(receiver); integrity_native_release(object);
      if (prototype_object) integrity_native_release(prototype_object);
    }
  }
  /* The proxy is solely owned by the bound array and detaches itself in its
   * trap. Set still needs its target for post-trap invariant validation. */
  ScrArr *array = scr_arr_new(SCR_ELEM_F64, 0);
  typed_detach_array = scr_dyn_new_typed_ref_observed(array, typed_array_retain, typed_array_release,
      "array:f64", 9, NULL, NULL);
  assert(scr_dyn_typed_ref_bind_array(typed_detach_array, &typed_array_ops));
  ScrDyn *handler = scr_dyn_new_obj(), *target = scr_dyn_new_obj();
  scr_dyn_obj_set(handler, "set", 3, scr_dyn_new_func(scr_closure_new(NULL, 0), typed_proxy_detach,
      4, "func(dyn,dyn,dyn,dyn)=>dyn", "detach proxy"));
  ScrDyn *proxy = scr_dyn_proxy_new(target, handler);
  /* Proxy prototype installation remains API-fenced. Seed the canonical
   * owner directly to exercise Set's raw-link lifetime contract. */
  array->ext->metadata = scr_dyn_new_obj();
  array->ext->metadata->prototype = proxy;
  scr_dyn_release(target); scr_dyn_release(handler);
  typed_set_receiver = scr_dyn_new_obj();
  assert(scr_dyn_reflect_set(typed_detach_array, key, scr_dyn_undefined(), typed_set_receiver));
  assert(!scr_dyn_has_own(typed_set_receiver, name));
  scr_dyn_release(typed_set_receiver); scr_dyn_release(typed_detach_array); scr_arr_release(array);
  typed_set_receiver = typed_detach_array = NULL;

  for (unsigned sloppy = 0; sloppy < 2; sloppy++) {
    IntegrityNative *owner = integrity_native_new();
    assert(integrity_native_prepare(owner)); owner->properties->null_proto = true;
    assert(!scr_native_object_check_set(owner, &integrity_native_ops, name,
        sloppy ? SCR_NATIVE_SET_SLOPPY : SCR_NATIVE_SET, (uint64_t)(uintptr_t)scr_dyn_undefined(),
        typed_value_box, typed_cleanup_box));
    assert(scr_exc_pending() == !sloppy && !owner->fields[2]);
    scr_exc_clear(); integrity_native_release(owner);
  }

  ScrSym *identity = scr_sym_new(name);
  ScrDyn *symbol = scr_dyn_new_symbol(identity); scr_sym_release(identity);
  for (unsigned readonly = 0; readonly < 2; readonly++) {
    ScrDyn *prototype = scr_dyn_new_obj(), *receiver = scr_dyn_new_obj(), *descriptor = scr_dyn_new_obj();
    receiver->prototype = scr_dyn_retain(prototype);
    if (readonly) scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(1));
    else scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_new_func(scr_closure_new(NULL, 0), typed_symbol_set,
        1, "func(dyn)=>dyn", "symbol setter"));
    scr_dyn_release(scr_dyn_define_property(prototype, symbol, descriptor));
    typed_set_receiver = receiver; typed_set_value = scr_dyn_undefined(); typed_set_calls = 0;
    assert(scr_dyn_reflect_set(receiver, symbol, typed_set_value, receiver) == !readonly);
    assert(typed_set_calls == !readonly && !scr_exc_pending());
    scr_dyn_release(descriptor); scr_dyn_release(receiver); scr_dyn_release(prototype);
  }
  typed_set_receiver = typed_set_value = NULL;
  for (unsigned throwing = 0; throwing < 2; throwing++) {
    IntegrityNative *owner = integrity_native_new();
    if (throwing) owner->prepare_error = scr_dyn_new_obj();
    ScrDyn *capsule = scr_dyn_new_typed_ref_observed(owner, integrity_native_retain, integrity_native_release,
        "record:primitive-view", 21, typed_primitive_view, NULL);
    ScrDyn *receiver = scr_dyn_new_obj();
    assert(!scr_dyn_reflect_set(capsule, key, scr_dyn_undefined(), receiver));
    ScrCaught *caught = scr_exc_take();
    assert(caught && receiver->v.obj.len == 0);
    if (throwing) assert(caught->payload == owner->prepare_error);
    else {
      ScrStr *message = scr_caught_to_string(caught);
      assert(str_is(message, "TypeError: Reflect.set called on non-object"));
      scr_str_release(message);
    }
    scr_caught_release(caught); scr_dyn_release(receiver); scr_dyn_release(capsule);
    integrity_native_release(owner);
  }
  scr_dyn_release(symbol); scr_dyn_release(key); scr_str_release(name);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static unsigned native_class_facts(void *ptr, size_t index) {
  IntegrityNative *object = ptr;
  return scr_native_property_bag_facts(object->properties,
      integrity_native_names[index], integrity_native_lengths[index]);
}
static bool native_class_prepare(void *ptr) {
  IntegrityNative *object = ptr;
  bool existed = object->properties != NULL;
  if (!integrity_native_prepare(ptr)) return false;
  if (!existed) {
    if (object->prepare_prototype)
      object->properties->prototype = scr_dyn_retain(object->prepare_prototype);
    if (object->prepare_facts) {
      scr_dyn_obj_set(object->properties, "optional", 8, scr_dyn_retain(scr_dyn_undefined()));
      ScrDynEntry *entry = &object->properties->v.obj.entries[0];
      entry->writable = (object->prepare_facts & SCR_NATIVE_WRITABLE) != 0;
    }
  }
  return !scr_exc_pending();
}
static bool native_class_apply(void *ptr, size_t index, ScrNativeMutation *mutation) {
  if (!scr_native_mutation_delete(mutation)) return integrity_native_apply(ptr, index, mutation);
  if (!scr_native_mutation_recheck(mutation)) return false;
  scr_native_mutation_finish(mutation);
  return true;
}
static ScrDyn *native_class_read(void *ptr, size_t index, unsigned part) {
  if (scr_native_property_declared_undefined(ptr, integrity_native_names[index], integrity_native_lengths[index])) {
    assert(part == 0);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  return integrity_native_read(ptr, index, part);
}
static const ScrDynNativeObjectOps native_class_ops = {
  .count = 3, .names = integrity_native_names, .lengths = integrity_native_lengths,
  .facts = native_class_facts, .properties = integrity_native_properties,
  .prepare = native_class_prepare, .read = native_class_read, .apply = native_class_apply,
  .class_name = "Fixture",
};
static ScrDyn *native_class_snapshot(void *ptr) {
  IntegrityNative *object = ptr;
  object->snapshots++;
  assert(!object->reject_snapshot);
  ScrDyn *view = scr_dyn_new_obj();
  if (object->properties) {
    scr_dyn_release(scr_dyn_copy_property_descriptors(view, object->properties));
    for (size_t i = 0; i < 3; i++)
      if (native_class_facts(ptr, i) & SCR_NATIVE_DATA)
        scr_dyn_table_set_data(view, integrity_native_names[i], integrity_native_lengths[i],
            native_class_read(ptr, i, 0));
  }
  return view;
}
static ScrDyn *native_class_box(IntegrityNative *object) {
  ScrDyn *box = scr_dyn_new_typed_ref_observed(object, integrity_native_retain, integrity_native_release,
      "class:Fixture", 13, native_class_snapshot, NULL);
  scr_dyn_typed_ref_bind_native_object(box, &native_class_ops);
  return box;
}

static ScrDyn *native_default_prototype(void *ptr) {
  IntegrityNative *object = ptr;
  if (object->prepare_error) {
    scr_throw_ref(scr_dyn_retain(object->prepare_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    return NULL;
  }
  return object->prepare_prototype ? scr_dyn_retain(object->prepare_prototype)
      : scr_dyn_object_prototype();
}
static const ScrDynNativeObjectOps native_prototype_ops = {
  .count = 3, .names = integrity_native_names, .lengths = integrity_native_lengths,
  .facts = native_class_facts, .properties = integrity_native_properties,
  .prepare = integrity_native_prepare, .read = native_class_read, .apply = native_class_apply,
  .class_name = "Fixture", .prototype = native_default_prototype,
};
static ScrDyn *native_prototype_snapshot(void *ptr) {
  ScrDyn *view = native_class_snapshot(ptr);
  scr_native_object_snapshot_prototype(ptr, &native_prototype_ops, view);
  return view;
}
static ScrDyn *native_prototype_box(IntegrityNative *object) {
  ScrDyn *box = scr_dyn_new_typed_ref_observed(object, integrity_native_retain, integrity_native_release,
      "class:Fixture", 13, native_prototype_snapshot, NULL);
  scr_dyn_typed_ref_bind_native_object(box, &native_prototype_ops);
  return box;
}
static void native_prototype_publish(void *ptr, ScrPub *context) {
  IntegrityNative *object = ptr;
  scr_pub_leaf_fn(object, context);
  if (object->properties) scr_pub_dyn_fn(object->properties, context);
}
static ScrDyn *native_prototype_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; assert(argc == 0);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrStr *name = scr_str_new("data", 4);
  ScrDyn *key = scr_dyn_new_str(name);
  ScrDyn *result = scr_dyn_reflect_get(receiver, key, receiver);
  scr_dyn_release(key); scr_str_release(name); scr_dyn_release(receiver);
  return result;
}
static void native_class_prototype_ownership(void) {
  scr_dyn_release(scr_dyn_object_prototype());
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  IntegrityNative *object = integrity_native_new();
  object->reject_snapshot = true;
  object->values[0] = scr_dyn_new_num(2);
  object->prepare_prototype = scr_dyn_new_obj();
  ScrDyn *first = native_prototype_box(object), *second = native_prototype_box(object);
  ScrStr *name = scr_str_new("data", 4), *inherited = scr_str_new("read", 4);
  ScrStr *members[] = {inherited};
  const ScrDynTypedClassOps klass = {.count = 1, .names = members};
  scr_dyn_typed_ref_bind_class(first, &klass);
  scr_dyn_typed_ref_bind_class(second, &klass);
  assert(scr_dyn_typed_ref_class_has(first, inherited));
  assert(!object->snapshots && !object->preparations);
  ScrDyn *key = scr_dyn_new_str(inherited), *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3, scr_dyn_new_func(scr_closure_new(NULL, 0),
      native_prototype_getter, 0, "func()=>dyn", "native prototype getter"));
  scr_dyn_release(scr_dyn_define_property(object->prepare_prototype, key, descriptor));
  assert(integrity_native_prepare(object));
  scr_native_object_finish_write(object, &native_prototype_ops, name, SCR_NATIVE_DEFINE);
  assert(object->properties && !object->properties->prototype && !object->properties->null_proto);
  ScrDyn *value = scr_dyn_bag_get(object->properties, inherited, first);
  assert(value->kind == SCR_DYN_NUM && value->v.num == 2); scr_dyn_release(value);
  assert(scr_dyn_has_key(second, inherited) && !scr_dyn_has_own(second, inherited));
  ScrDyn *receiver = scr_dyn_new_obj(); scr_dyn_obj_set(receiver, "data", 4, scr_dyn_new_num(9));
  value = scr_dyn_reflect_get(second, key, receiver);
  assert(value->kind == SCR_DYN_NUM && value->v.num == 9); scr_dyn_release(value);
  ScrDyn *keys = scr_dyn_for_in_keys(first);
  assert(keys->v.arr.len == 1 && str_is(keys->v.arr.items[0]->v.str, "data"));
  scr_dyn_release(keys);
  assert(!object->snapshots);

  object->reject_snapshot = false;
  ScrDyn *snapshot = scr_dyn_typed_ref_materialize(first);
  assert(snapshot->prototype == object->prepare_prototype); scr_dyn_release(snapshot);
  for (unsigned mode = 0; mode < 3; mode++) {
    bool null_proto = mode == 2;
    ScrDyn *prototype = null_proto ? scr_dyn_new_null()
        : mode == 1 ? scr_dyn_object_prototype() : scr_dyn_new_obj();
    if (mode == 0) scr_dyn_obj_set(prototype, "extra", 5, scr_dyn_new_num(7));
    scr_dyn_release(scr_dyn_set_prototype(second, prototype));
    value = scr_dyn_get_prototype(first);
    assert(scr_dyn_strict_eq(value, prototype)); scr_dyn_release(value);
    assert(!scr_dyn_has_key(first, inherited));
    assert(!scr_dyn_in(second, inherited));
    assert(!scr_dyn_typed_ref_class_has(first, inherited));
    snapshot = scr_dyn_typed_ref_materialize(first);
    assert(null_proto ? snapshot->null_proto && !snapshot->prototype
        : mode == 1 ? !snapshot->null_proto && !snapshot->prototype : snapshot->prototype == prototype);
    scr_dyn_release(snapshot);
    size_t rc = object->rc, bag_rc = object->properties->rc;
    scr_publish(object, native_prototype_publish);
    assert(scr_exc_pending()); scr_caught_release(scr_exc_take());
    assert(object->rc == rc && object->properties->rc == bag_rc);
    assert(!object->properties->non_extensible);
    scr_dyn_release(prototype);
  }
  scr_dyn_release(scr_dyn_set_prototype(first, object->prepare_prototype));
  assert(scr_dyn_typed_ref_class_has(second, inherited) && scr_dyn_in(second, inherited));
  object->prepare_error = scr_dyn_new_obj();
  assert(!scr_dyn_typed_ref_class_has(first, inherited) && scr_exc_pending());
  ScrCaught *caught = scr_exc_take();
  assert(caught->payload == object->prepare_error);
  scr_caught_release(caught);
  scr_dyn_release(object->prepare_error); object->prepare_error = NULL;
  scr_dyn_release(scr_dyn_set_prototype(first, scr_dyn_new_null()));
  scr_native_object_restrict(object, &native_prototype_ops, SCR_NATIVE_NON_EXTENSIBLE);
  unsigned preparations = object->preparations;
  scr_dyn_release(scr_dyn_set_prototype(first, scr_dyn_new_null()));
  assert(!scr_exc_pending() && preparations == object->preparations);
  assert(!scr_dyn_set_prototype(second, object->prepare_prototype));
  assert(scr_exc_pending()); scr_caught_release(scr_exc_take());
  scr_dyn_release(receiver); scr_dyn_release(descriptor); scr_dyn_release(key);
  scr_str_release(name); scr_str_release(inherited);
  scr_dyn_release(first); scr_dyn_release(second); integrity_native_release(object);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static bool typed_class_freeze;
static ScrDyn *typed_class_receiver_box(uint64_t bits) {
  typed_receiver_boxes++;
  return native_class_box((IntegrityNative *)(uintptr_t)bits);
}
static ScrDyn *typed_class_setter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *result = typed_symbol_set(closure, args, argc);
  if (typed_class_freeze)
    scr_native_object_restrict(typed_set_owner, &native_class_ops, SCR_NATIVE_FROZEN);
  if (typed_set_error)
    scr_throw_ref(scr_dyn_retain(typed_set_error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  return result;
}
static void native_class_typed_set(void) {
  scr_dyn_release(scr_dyn_object_prototype());
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  enum {
    LAZY, NON_EXTENSIBLE, PREPARE_OWN, PREPARE_READONLY, PREPARE_THROW,
    PREPARE_FREEZE, EXISTING_BAG, PUBLISHED, OWN_UNDEFINED, INHERITED_READONLY,
    GETTER_ONLY, SETTER_FREEZE, SETTER_THROW, INHERITED_WRITABLE, EMPTY_PROTOTYPE, CASE_COUNT
  };
  ScrStr *name = scr_str_new("optional", 8);
  ScrDyn *key = scr_dyn_new_str(name), *value = scr_dyn_new_obj();
  for (unsigned mode = 0; mode < CASE_COUNT; mode++) {
    for (unsigned sloppy = 0; sloppy < 2; sloppy++) {
      IntegrityNative *object = integrity_native_new();
      object->reject_snapshot = true;
      object->values[2] = scr_dyn_retain(scr_dyn_undefined());
      ScrDyn *receiver = native_class_box(object), *prototype = scr_dyn_new_obj();
      ScrDyn *descriptor = scr_dyn_new_obj();
      if (mode == INHERITED_READONLY || mode == INHERITED_WRITABLE) {
        scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(1));
        scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(mode == INHERITED_WRITABLE));
      }
      else scr_dyn_obj_set(descriptor, mode == GETTER_ONLY ? "get" : "set", 3,
          scr_dyn_new_func(scr_closure_new(NULL, 0), typed_class_setter, 1,
              "func(dyn)=>dyn", "typed class setter"));
      scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
      if (mode != EMPTY_PROTOTYPE) scr_dyn_release(scr_dyn_define_property(prototype, key, descriptor));
      object->prepare_prototype = scr_dyn_retain(prototype);
      if (mode == NON_EXTENSIBLE)
        scr_native_object_restrict(object, &native_class_ops, SCR_NATIVE_NON_EXTENSIBLE);
      if (mode == PREPARE_OWN || mode == PREPARE_READONLY || mode == OWN_UNDEFINED)
        object->prepare_facts = mode == PREPARE_READONLY
            ? SCR_NATIVE_DEFAULT_DATA & ~SCR_NATIVE_WRITABLE : SCR_NATIVE_DEFAULT_DATA;
      if (mode == PREPARE_THROW) object->prepare_error = scr_dyn_new_obj();
      if (mode == PREPARE_FREEZE) {
        object->freeze_on_prepare = true;
        scr_dyn_release(object->prepare_prototype); object->prepare_prototype = NULL;
      }
      if (mode == EXISTING_BAG || mode == OWN_UNDEFINED) assert(native_class_prepare(object));
      if (mode == PUBLISHED) object->rc = SIZE_MAX;
      typed_receiver_boxes = typed_value_boxes = typed_set_calls = 0;
      typed_set_owner = object; typed_set_receiver = receiver; typed_set_value = value;
      typed_set_error = mode == SETTER_THROW ? scr_dyn_new_obj() : NULL;
      typed_class_freeze = mode == SETTER_FREEZE;
      ScrNativePropertyOperation operation = sloppy ? SCR_NATIVE_SET_SLOPPY : SCR_NATIVE_SET;
      bool store = scr_native_object_check_set(object, &native_class_ops, name, operation,
          (uint64_t)(uintptr_t)value, typed_value_box, typed_class_receiver_box);
      assert(store == (mode == PREPARE_OWN || mode == OWN_UNDEFINED ||
          mode == INHERITED_WRITABLE || mode == EMPTY_PROTOTYPE));
      bool refused = mode == PREPARE_READONLY || mode == PREPARE_FREEZE || mode == PUBLISHED ||
          mode == INHERITED_READONLY || mode == GETTER_ONLY;
      ScrDyn *error = mode == PREPARE_THROW ? object->prepare_error : typed_set_error;
      assert(scr_exc_pending() == (error != NULL || (refused && !sloppy)));
      if (scr_exc_pending()) {
        ScrCaught *caught = scr_exc_take();
        assert(caught);
        if (error) assert(caught->payload == error);
        scr_caught_release(caught);
      }
      assert(typed_set_calls == (mode == LAZY || mode == NON_EXTENSIBLE || mode == EXISTING_BAG ||
          mode == SETTER_FREEZE || mode == SETTER_THROW ? 1u : 0u));
      assert(typed_receiver_boxes == (mode == OWN_UNDEFINED ? 0u : 1u));
      assert(typed_value_boxes == typed_receiver_boxes && !object->snapshots && !object->conversions);
      assert(object->values[2]->kind == SCR_DYN_UNDEF);
      bool was_own = (native_class_facts(object, 2) & SCR_NATIVE_OWN) != 0;
      assert(was_own == (mode == PREPARE_OWN || mode == PREPARE_READONLY || mode == OWN_UNDEFINED));
      if (store) {
        ScrDyn *old = object->values[2];
        object->values[2] = scr_dyn_retain(value);
        scr_native_object_finish_write(object, &native_class_ops, name, operation);
        scr_dyn_release(old);
      }
      bool own = (native_class_facts(object, 2) & SCR_NATIVE_OWN) != 0;
      assert(own == (store || mode == PREPARE_READONLY));
      if (store) {
        assert(object->values[2] == value);
        assert(native_class_facts(object, 2) == SCR_NATIVE_DEFAULT_DATA);
      }
      if (mode == PUBLISHED) { assert(!object->properties); object->rc = 2; }
      scr_dyn_release(typed_set_error); typed_set_error = typed_set_receiver = typed_set_value = NULL;
      typed_set_owner = NULL; typed_class_freeze = false;
      scr_dyn_release(descriptor); scr_dyn_release(prototype); scr_dyn_release(receiver);
      integrity_native_release(object);
    }
  }
  /* Constructor declarations define own fields without invoking an inherited
   * setter or boxing the RHS, even when preparing the bag exposes that setter. */
  IntegrityNative *object = integrity_native_new();
  object->reject_snapshot = true;
  object->prepare_prototype = scr_dyn_new_obj();
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "set", 3, scr_dyn_new_func(scr_closure_new(NULL, 0), typed_class_setter,
      1, "func(dyn)=>dyn", "declaration setter"));
  scr_dyn_release(scr_dyn_define_property(object->prepare_prototype, key, descriptor));
  typed_receiver_boxes = typed_value_boxes = typed_set_calls = 0;
  assert(scr_native_object_check_write(object, &native_class_ops, "optional", 8, SCR_NATIVE_DEFINE));
  object->values[2] = scr_dyn_retain(value);
  scr_native_object_finish_write(object, &native_class_ops, name, SCR_NATIVE_DEFINE);
  assert(native_class_facts(object, 2) == SCR_NATIVE_DEFAULT_DATA);
  assert(!typed_receiver_boxes && !typed_value_boxes && !typed_set_calls && !object->snapshots);
  scr_dyn_release(descriptor); integrity_native_release(object);
  scr_dyn_release(value); scr_dyn_release(key); scr_str_release(name);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static void native_class_property_set(void) {
  scr_dyn_release(scr_dyn_object_prototype());
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  ScrStr *name = scr_str_new("optional", 8);
  ScrDyn *key = scr_dyn_new_str(name), *value = scr_dyn_new_num(7);
  /* Lazy prototype, non-extensible setter, preparation creating own data,
   * readonly own data, exact throw, freeze, existing bag, published absence,
   * and own-data control. No write may materialize a sibling. */
  for (unsigned mode = 0; mode < 9; mode++) {
    IntegrityNative *object = integrity_native_new();
    object->reject_snapshot = true;
    object->values[2] = scr_dyn_new_num(1);
    ScrDyn *box = native_class_box(object), *prototype = scr_dyn_new_obj();
    ScrDyn *setter = scr_dyn_new_func(scr_closure_new(NULL, 0), typed_symbol_set, 1,
        "func(dyn)=>dyn", "class setter");
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "set", 3, setter);
    scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
    scr_dyn_release(scr_dyn_define_property(prototype, key, descriptor));
    object->prepare_prototype = scr_dyn_retain(prototype);
    if (mode == 1) scr_native_object_restrict(object, &native_class_ops, SCR_NATIVE_NON_EXTENSIBLE);
    if (mode == 2 || mode == 3 || mode == 8)
      object->prepare_facts = mode == 3 ? SCR_NATIVE_DEFAULT_DATA & ~SCR_NATIVE_WRITABLE : SCR_NATIVE_DEFAULT_DATA;
    if (mode == 4) object->prepare_error = scr_dyn_new_obj();
    if (mode == 5) {
      object->freeze_on_prepare = true;
      scr_dyn_release(object->prepare_prototype); object->prepare_prototype = NULL;
    }
    if (mode == 6 || mode == 8) assert(native_class_prepare(object));
    unsigned before = object->preparations;
    if (mode == 7) object->rc = SIZE_MAX;
    typed_set_receiver = box; typed_set_value = value; typed_set_calls = 0;
    bool ok = scr_dyn_reflect_set(box, key, value, box);
    assert(ok == (mode < 3 || mode == 6 || mode == 8));
    assert(typed_set_calls == (mode == 0 || mode == 1 || mode == 6 ? 1u : 0u));
    if (mode == 4) {
      ScrCaught *caught = scr_exc_take();
      assert(caught && caught->payload == object->prepare_error);
      scr_caught_release(caught);
    }
    assert(!scr_exc_pending() && object->snapshots == 0);
    assert(object->values[2]->v.num == (mode == 2 || mode == 8 ? 7 : 1));
    assert(object->conversions == (mode == 2 || mode == 8 ? 1u : 0u));
    assert(object->preparations - before == (mode == 6 || mode == 7 ? 0u : mode == 2 ? 2u : 1u));
    if (mode == 7) { assert(!object->properties); object->rc = 2; }
    scr_dyn_release(descriptor); scr_dyn_release(prototype); scr_dyn_release(box);
    integrity_native_release(object);
  }
  scr_dyn_release(value); scr_dyn_release(key); scr_str_release(name);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static ScrDyn *native_integrity_unexpected_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  assert(!"integrity operations must not invoke getters");
  return scr_dyn_retain(scr_dyn_undefined());
}
static void native_capsule_integrity(void) {
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  const unsigned levels[] = {SCR_NATIVE_NON_EXTENSIBLE, SCR_NATIVE_SEALED, SCR_NATIVE_FROZEN};
  for (unsigned klass = 0; klass < 2; klass++) {
    const ScrDynNativeObjectOps *ops = klass ? &native_class_ops : &integrity_native_ops;
    for (unsigned mode = 0; mode < 5; mode++) {
      for (unsigned warm = 0; warm < 2; warm++) {
        for (unsigned level = 0; level < 3; level++) {
          IntegrityNative *object = integrity_native_new();
          /* Empty, own data, accessor, extra/symbol data, readonly data. */
          if (mode == 1 || mode == 4) {
            object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
            object->values[0] = scr_dyn_new_obj();
          } else if (mode == 2) object->fields[1] = SCR_NATIVE_DEFAULT_ACCESSOR;
          if ((klass && mode != 0) || mode == 3) {
            assert(native_class_prepare(object));
            if (mode == 1 || mode == 4)
              scr_dyn_obj_set(object->properties, "data", 4, scr_dyn_retain(scr_dyn_undefined()));
            else if (mode == 2) {
              scr_dyn_obj_set(object->properties, "accessor", 8, scr_dyn_retain(scr_dyn_undefined()));
              ScrDynEntry *entry = &object->properties->v.obj.entries[0];
              entry->accessor = true;
              entry->getter = scr_dyn_new_func(scr_closure_new(NULL, 0), native_integrity_unexpected_getter,
                  0, "func()=>dyn", "integrity getter");
            } else {
              scr_dyn_obj_set(object->properties, "extra", 5, scr_dyn_new_num(1));
              object->properties->symbol_properties = scr_dyn_new_obj();
              scr_dyn_obj_set(object->properties->symbol_properties, "symbol", 6, scr_dyn_new_num(2));
            }
          }
          if (mode == 4) scr_native_property_attributes(object, "data", 4, SCR_NATIVE_ENUMERABLE);
          ScrDyn *first = klass ? native_class_box(object) : integrity_native_box(object);
          ScrDyn *alias = scr_dyn_new_typed_ref_observed(object, integrity_native_retain, integrity_native_release,
              "native:alias", 12, klass ? native_class_snapshot : integrity_native_snapshot, NULL);
          scr_dyn_typed_ref_bind_native_object(alias, ops);
          assert(first != alias);
          if (warm) scr_dyn_release(scr_dyn_typed_ref_materialize(alias));
          assert(!scr_exc_pending());
          object->reject_snapshot = true;
          unsigned snapshots = object->snapshots, preparations = object->preparations;
          assert(scr_dyn_is_extensible(first) && !scr_dyn_is_sealed(first) && !scr_dyn_is_frozen(first));
          ScrDyn *result = level == 0 ? scr_dyn_prevent_extensions(first)
              : level == 1 ? scr_dyn_seal(first) : scr_dyn_freeze(first);
          if (result != first || scr_exc_pending())
            fprintf(stderr, "native capsule integrity: class=%u mode=%u warm=%u level=%u pending=%d\n",
                klass, mode, warm, level, scr_exc_pending());
          assert(result == first && !scr_exc_pending());
          scr_dyn_release(result);
          for (unsigned which = 0; which < 2; which++) {
            ScrDyn *current = which ? alias : first;
            assert(!scr_dyn_is_extensible(current));
            assert(scr_dyn_is_sealed(current) == (mode == 0 || mode == 4 || level > 0));
            assert(scr_dyn_is_frozen(current) == (mode == 0 || mode == 4 || level == 2 || (mode == 2 && level == 1)));
          }
          assert(object->snapshots == snapshots && object->preparations == preparations);
          assert(scr_native_integrity_flags(object) == levels[level]);
          if (!mode) assert(!object->properties);
          if (object->values[0]) assert(scr_dyn_is_extensible(object->values[0])); /* Shallow. */
          assert(!scr_native_object_check_write(object, ops, "new", 3, SCR_NATIVE_SET_SLOPPY));
          if (mode == 1)
            assert(scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_SET_SLOPPY) == (level < 2));
          scr_dyn_release(alias); scr_dyn_release(first);
          first = klass ? native_class_box(object) : integrity_native_box(object);
          assert(!scr_dyn_is_extensible(first));
          assert(scr_dyn_is_frozen(first) == (mode == 0 || mode == 4 || level == 2 || (mode == 2 && level == 1)));
          scr_dyn_release(first); integrity_native_release(object);
          assert(!scr_exc_pending());
        }
      }
    }
    /* Published objects need no TLS restriction entry or lazy property bag. */
    IntegrityNative *object = integrity_native_new();
    ScrDyn *capsule = klass ? native_class_box(object) : integrity_native_box(object);
    object->rc = SIZE_MAX; object->reject_snapshot = true;
    assert(!scr_dyn_is_extensible(capsule) && scr_dyn_is_sealed(capsule) && scr_dyn_is_frozen(capsule));
    scr_dyn_release(scr_dyn_prevent_extensions(capsule));
    scr_dyn_release(scr_dyn_seal(capsule));
    scr_dyn_release(scr_dyn_freeze(capsule));
    assert(!object->properties && !object->snapshots && !object->preparations);
    assert(!scr_native_integrity_flags(object));
    object->rc = 2;
    scr_dyn_release(capsule); integrity_native_release(object);
  }
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static void native_class_declarations(void) {
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  ScrStr *name = scr_str_new("data", 4);
  ScrDyn *key = scr_dyn_new_str(name);
  for (unsigned frozen = 0; frozen < 2; frozen++) {
    IntegrityNative *object = integrity_native_new();
    object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
    bool observed = false;
    if (frozen) object->values[0] = scr_dyn_new_num(11);
    else {
      NativeReleaseWitness *witness = malloc(sizeof *witness);
      assert(witness); *witness = (NativeReleaseWitness){1, object, &observed, false};
      object->values[0] = scr_dyn_new_typed_ref_observed(witness, native_release_witness_retain,
          native_release_witness_release, "record:witness", 14, NULL, NULL);
      native_release_witness_release(witness);
    }
    ScrDyn *held = object->values[0];
    scr_native_object_declare_undefined(object, &native_class_ops, name);
    scr_native_object_declare_undefined(object, &native_class_ops, name);
    assert(!scr_exc_pending() && object->values[0] == held && !observed);
    assert(native_class_facts(object, 0) == SCR_NATIVE_DEFAULT_DATA);
    assert(scr_native_property_declared_undefined(object, "data", 4));
    assert(!scr_native_property_declared_undefined(object, "data\0x", 6));
    ScrDyn *box = native_class_box(object), *alias = native_class_box(object);
    scr_dyn_release(scr_dyn_typed_ref_materialize(box));
    scr_dyn_release(scr_dyn_typed_ref_materialize(alias));
    ScrDyn *descriptor = scr_dyn_new_obj();
    scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
    assert(integrity_native_define(box, "data", descriptor));
    assert(scr_native_property_declared_undefined(object, "data", 4));
    if (frozen) scr_native_object_restrict(object, &native_class_ops, SCR_NATIVE_FROZEN);
    scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(scr_dyn_undefined()));
    assert(integrity_native_define(alias, "data", descriptor));
    assert(!object->conversions && object->values[0] == held && !observed);
    for (unsigned i = 0; i < 2; i++) {
      ScrDyn *current = scr_dyn_get_own_property_descriptor(i ? alias : box, key);
      assert(scr_dyn_obj_get(current, "value", 5)->kind == SCR_DYN_UNDEF);
      assert(!scr_dyn_obj_get(current, "enumerable", 10)->v.b);
      scr_dyn_release(current);
      ScrDyn *snapshot = scr_dyn_typed_ref_materialize(i ? alias : box);
      assert(scr_dyn_obj_get(snapshot, "data", 4)->kind == SCR_DYN_UNDEF);
      scr_dyn_release(snapshot);
    }
    if (!frozen) {
      scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(7));
      scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
      assert(integrity_native_define(box, "data", descriptor));
      assert(observed && object->conversions == 1);
      assert(!scr_native_property_declared_undefined(object, "data", 4));
      scr_native_object_declare_undefined(object, &native_class_ops, name);
      assert(!scr_exc_pending() && object->values[0]->v.num == 7);
      scr_dyn_key_delete(box, name, true);
      assert(!scr_exc_pending() && !native_class_facts(object, 0));
      assert(!scr_native_property_declared_undefined(object, "data", 4));
      assert(object->values[0]->v.num == 7);
    } else {
      scr_native_object_declare_undefined(object, &native_class_ops, name);
      assert(scr_exc_pending() && object->values[0] == held);
      scr_exc_clear();
      assert(scr_native_property_declared_undefined(object, "data", 4));
    }
    scr_dyn_release(descriptor); scr_dyn_release(alias); scr_dyn_release(box);
    integrity_native_release(object);
  }
  for (unsigned failure = 0; failure < 3; failure++) {
    IntegrityNative *object = integrity_native_new();
    object->values[0] = scr_dyn_new_num(11);
    if (failure == 0) object->freeze_on_prepare = true;
    if (failure == 1) object->prepare_error = scr_dyn_new_obj();
    if (failure == 2) object->rc = SIZE_MAX;
    scr_native_object_declare_undefined(object, &native_class_ops, name);
    assert(scr_exc_pending() && object->values[0]->v.num == 11);
    ScrCaught *caught = scr_exc_take();
    if (failure == 1) assert(caught->payload == object->prepare_error);
    scr_caught_release(caught);
    assert(!native_class_facts(object, 0));
    assert(!scr_native_property_declared_undefined(object, "data", 4));
    if (failure == 2) {
      assert(!object->preparations && !scr_native_property_metadata(object));
      object->rc = 1;
    }
    integrity_native_release(object);
  }
  IntegrityNative *installed = integrity_native_new();
  installed->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  installed->values[0] = scr_dyn_new_num(11);
  scr_native_object_declare_undefined(installed, &native_class_ops, name);
  ScrDyn *box = native_class_box(installed), *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  assert(integrity_native_define(box, "data", descriptor));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  assert(integrity_native_define(box, "data", descriptor));
  assert(scr_native_property_declared_undefined(installed, "data", 4));
  assert(scr_native_publication_refusal(installed));
  ScrDyn *previous = installed->values[0];
  installed->values[0] = scr_dyn_new_num(12);
  scr_native_object_finish_write(installed, &native_class_ops, name, SCR_NATIVE_SET);
  scr_dyn_release(previous);
  assert(!scr_native_property_declared_undefined(installed, "data", 4));
  assert(!scr_native_property_metadata(installed) && !scr_native_publication_refusal(installed));
  scr_dyn_release(descriptor); scr_dyn_release(box); integrity_native_release(installed);
  scr_dyn_release(key); scr_str_release(name);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static void native_class_property_ownership(void) {
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  IntegrityNative *object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  object->reject_snapshot = true;
  assert(native_class_prepare(object));
  scr_dyn_obj_set(object->properties, "data", 4, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(object->properties, "extra", 5, scr_dyn_new_num(2));
  bool observed = false;
  NativeReleaseWitness *witness = malloc(sizeof *witness);
  assert(witness); *witness = (NativeReleaseWitness){1, object, &observed, false};
  object->values[0] = scr_dyn_new_typed_ref_observed(witness, native_release_witness_retain,
      native_release_witness_release, "record:witness", 14, NULL, NULL);
  native_release_witness_release(witness);
  ScrDyn *box = native_class_box(object), *held = object->values[0];
  ScrStr *name = scr_str_new("data", 4);
  scr_dyn_key_delete(box, name, true);
  assert(!scr_exc_pending() && !observed && object->values[0] == held);
  assert(!native_class_facts(object, 0) && object->values[1] == NULL && object->snapshots == 0);
  object->reject_snapshot = false;
  assert(!scr_dyn_has_own(box, name));
  metadata_pair_keys(box, "[\"extra\"]");
  object->reject_snapshot = true;
  unsigned snapshots = object->snapshots;
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num(7));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  assert(integrity_native_define(box, "data", descriptor));
  assert(observed && object->values[1] == NULL && object->snapshots == snapshots);
  object->reject_snapshot = false;
  assert(scr_dyn_has_own(box, name));
  ScrDyn *alias = native_class_box(object);
  ScrDyn *key = scr_dyn_new_str(name);
  for (unsigned i = 0; i < 2; i++) {
    ScrDyn *current = scr_dyn_get_own_property_descriptor(i ? alias : box, key);
    assert(scr_dyn_obj_get(current, "value", 5)->v.num == 7);
    assert(!scr_dyn_obj_get(current, "writable", 8)->v.b);
    assert(!scr_dyn_obj_get(current, "enumerable", 10)->v.b);
    assert(!scr_dyn_obj_get(current, "configurable", 12)->v.b);
    scr_dyn_release(current);
  }
  scr_dyn_release(key); scr_dyn_release(alias);
  assert(scr_dyn_obj_get(object->properties, "data", 4)->kind == SCR_DYN_UNDEF);
  metadata_pair_keys(box, "[\"extra\"]"); /* Re-added data defaults non-enumerable. */
  object->reject_snapshot = true;
  scr_dyn_key_delete(box, name, false);
  assert(!scr_exc_pending() && native_class_facts(object, 0));
  scr_dyn_key_delete(box, name, true);
  assert(scr_exc_pending()); scr_exc_clear();
  scr_dyn_release(descriptor); scr_str_release(name); scr_dyn_release(box);
  integrity_native_release(object);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static void native_table_projection(void) {
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  ScrStr *name = scr_str_new("field", 5);
  ScrDyn *key = scr_dyn_new_str(name);
  ScrSym *identity = scr_sym_new(name);
  ScrDyn *symbol = scr_dyn_new_symbol(identity);
  scr_sym_release(identity);
  ScrDyn *bag = scr_dyn_new_obj(), *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_release(scr_dyn_define_property(bag, key, descriptor));
  scr_dyn_release(scr_dyn_define_property(bag, symbol, descriptor));
  scr_dyn_obj_set(bag, "extra", 5, scr_dyn_new_num(9));
  for (unsigned pass = 0; pass < 2; pass++) {
    ScrDyn *view = scr_dyn_new_obj();
    scr_dyn_release(scr_dyn_copy_property_descriptors(view, bag));
    scr_dyn_table_set_data(view, "field", 5, scr_dyn_new_num(7));
    assert(scr_dyn_table_has_symbol_data(view, symbol));
    scr_dyn_table_set_symbol_data(view, symbol, scr_dyn_new_num(8));
    assert(view->v.obj.len == 2 && !memcmp(view->v.obj.entries[0].key, "field", 5));
    for (unsigned sym = 0; sym < 2; sym++) {
      ScrDyn *current = scr_dyn_get_own_property_descriptor(view, sym ? symbol : key);
      assert(scr_dyn_obj_get(current, "value", 5)->v.num == (sym ? 8 : 7));
      assert(!scr_dyn_obj_get(current, "writable", 8)->v.b);
      assert(!scr_dyn_obj_get(current, "enumerable", 10)->v.b);
      assert(!scr_dyn_obj_get(current, "configurable", 12)->v.b);
      scr_dyn_release(current);
    }
    scr_dyn_table_set_data(view, "field", 5, scr_dyn_retain(scr_dyn_undefined()));
    scr_dyn_symbol_key_placeholder(view, symbol);
    assert(scr_dyn_obj_get(view, "field", 5)->kind == SCR_DYN_UNDEF);
    assert(scr_dyn_own_symbol_entry(view, symbol)->value->kind == SCR_DYN_UNDEF);
    /* Internal fill neither creates absent properties nor replaces accessors.
     * These invalid getter identities would fail if construction invoked them. */
    ScrDynEntry *field = &view->v.obj.entries[0];
    ScrDynEntry *symbol_entry = scr_dyn_own_symbol_entry(view, symbol);
    field->accessor = symbol_entry->accessor = true;
    field->getter = scr_dyn_new_num(1);
    symbol_entry->getter = scr_dyn_new_num(2);
    scr_dyn_table_set_data(view, "field", 5, scr_dyn_new_obj());
    scr_dyn_table_set_data(view, "absent", 6, scr_dyn_new_obj());
    scr_dyn_table_set_symbol_data(view, symbol, scr_dyn_new_obj());
    assert(!scr_dyn_table_has_symbol_data(view, symbol));
    assert(field->accessor && symbol_entry->accessor && view->v.obj.len == 2);
    assert(field->value->kind == SCR_DYN_UNDEF && symbol_entry->value->kind == SCR_DYN_UNDEF);
    scr_dyn_release(view);
  }
  assert(scr_dyn_obj_get(bag, "field", 5)->kind == SCR_DYN_UNDEF);
  assert(scr_dyn_own_symbol_entry(bag, symbol)->value->kind == SCR_DYN_UNDEF);
  ScrDyn *empty = scr_dyn_new_obj();
  scr_dyn_table_set_symbol_data(empty, symbol, scr_dyn_new_obj());
  assert(!empty->symbol_properties && !empty->symbol_keys);
  scr_dyn_release(empty); scr_dyn_release(bag); scr_dyn_release(descriptor);
  scr_dyn_release(key); scr_dyn_release(symbol); scr_str_release(name);
  scr_collect_cycles();
  assert(!scr_exc_pending());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static void native_property_typed_finish(const ScrDynNativeObjectOps *ops) {
#ifdef SCR_RC_AUDIT
  long dyns = scr_dyn_live_count(), strings = scr_str_live_count();
#endif
  IntegrityNative *object = integrity_native_new();
  object->fields[2] = SCR_NATIVE_DEFAULT_DATA;
  bool observed = false;
  NativeReleaseWitness *witness = malloc(sizeof *witness);
  assert(witness);
  *witness = (NativeReleaseWitness){1, object, &observed, true};
  object->values[2] = scr_dyn_new_typed_ref_observed(witness, native_release_witness_retain,
      native_release_witness_release, "record:typed-delete", 19, NULL, NULL);
  native_release_witness_release(witness);
  assert(integrity_native_prepare(object));
  scr_dyn_obj_set(object->properties, "optional", 8, scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(object->properties, "extra", 5, scr_dyn_new_num(1));
  scr_native_property_attributes(object, "optional", 8, SCR_NATIVE_ENUMERABLE | SCR_NATIVE_CONFIGURABLE);
  ScrStr *key = scr_str_new("optional", 8);
  assert(scr_native_object_check_write(object, ops, key->data, key->len, SCR_NATIVE_DELETE));
  ScrDyn *old = object->values[2];
  object->values[2] = NULL; object->fields[2] = 0;
  scr_native_object_finish_write(object, ops, key, SCR_NATIVE_DELETE);
  scr_dyn_release(old);
  assert(observed);
  metadata_pair_keys(object->properties, "[\"extra\"]");
  assert(scr_native_object_check_write(object, ops, key->data, key->len, SCR_NATIVE_SET));
  object->values[2] = scr_dyn_new_num(4); object->fields[2] = SCR_NATIVE_DEFAULT_DATA;
  scr_native_object_finish_write(object, ops, key, SCR_NATIVE_SET);
  metadata_pair_keys(object->properties, "[\"extra\",\"optional\"]");
  assert(!scr_native_property_metadata(object) && !scr_native_publication_refusal(object));
  scr_native_property_attributes(object, "optional", 8, SCR_NATIVE_WRITABLE | SCR_NATIVE_CONFIGURABLE);
  assert(scr_native_object_check_write(object, ops, key->data, key->len, SCR_NATIVE_SET));
  scr_native_object_finish_write(object, ops, key, SCR_NATIVE_SET);
  assert(scr_native_property_bag_facts(object->properties, "optional", 8) ==
      (SCR_NATIVE_OWN | SCR_NATIVE_DATA | SCR_NATIVE_WRITABLE | SCR_NATIVE_CONFIGURABLE));
  assert(scr_native_property_metadata(object) && scr_native_publication_refusal(object));
  assert(scr_native_object_check_write(object, ops, key->data, key->len, SCR_NATIVE_DEFINE));
  scr_native_object_finish_write(object, ops, key, SCR_NATIVE_DEFINE);
  assert(scr_native_property_bag_facts(object->properties, "optional", 8) == SCR_NATIVE_DEFAULT_DATA);
  assert(!scr_native_property_metadata(object) && !scr_native_publication_refusal(object));
  metadata_pair_keys(object->properties, "[\"extra\",\"optional\"]");
  scr_native_object_restrict(object, ops, SCR_NATIVE_SEALED);
  assert(scr_native_object_check_write(object, ops, key->data, key->len, SCR_NATIVE_SET));
  scr_native_object_finish_write(object, ops, key, SCR_NATIVE_SET);
  assert(!scr_native_property_metadata(object) && !scr_native_publication_refusal(object));
  assert(scr_native_integrity_flags(object) == SCR_NATIVE_SEALED);
  assert(scr_native_property_bag_facts(object->properties, "optional", 8) ==
      (SCR_NATIVE_DEFAULT_DATA & ~SCR_NATIVE_CONFIGURABLE));
  scr_str_release(key); integrity_native_release(object);
  scr_collect_cycles();
  assert(!scr_exc_pending() && !scr_native_integrity_active());
#ifdef SCR_RC_AUDIT
  assert(scr_dyn_live_count() == dyns && scr_str_live_count() == strings);
#endif
}

static void integrity_native_publish_ancestor(void *ptr, ScrPub *context) {
  IntegrityNative **pair = ptr;
  scr_pub_leaf_fn(pair[0], context);
  assert(pair[0]->rc == SIZE_MAX);
  scr_pub_leaf_fn(pair[1], context);
}

static void native_property_owner(void) {
  assert(scr_native_property_bag(NULL) == NULL);
  assert(scr_native_property_bag(scr_dyn_undefined()) == NULL);
  assert(!scr_native_property_bag_facts(NULL, "field", 5));
  assert(!scr_native_property_bag_facts(scr_dyn_undefined(), "field", 5));
  ScrDyn *bag = scr_dyn_new_obj();
  scr_dyn_obj_set(bag, "field", 5, scr_dyn_retain(scr_dyn_undefined()));
  assert(scr_native_property_bag(bag) == bag);
  assert(scr_native_property_bag_facts(bag, "field", 5) == SCR_NATIVE_DEFAULT_DATA);
  assert(!scr_native_property_bag_facts(bag, "missing", 7));
  ScrDynEntry *bag_entry = &bag->v.obj.entries[0];
  bag_entry->accessor = true;
  bag_entry->getter = scr_dyn_new_num(123); /* Calling this would throw. Facts never read its value. */
  assert(scr_native_property_bag_facts(bag, "field", 5) == SCR_NATIVE_DEFAULT_ACCESSOR);
  assert(!scr_exc_pending());
  scr_dyn_release(scr_dyn_seal(bag));
  assert(scr_native_property_bag_facts(bag, "field", 5) == (SCR_NATIVE_OWN | SCR_NATIVE_ENUMERABLE));
  scr_dyn_release(bag);
  const ScrDynNativeObjectOps *ops = &integrity_native_ops;
  IntegrityNative *object = integrity_native_new();
  scr_native_object_restrict(object, ops, SCR_NATIVE_NON_EXTENSIBLE);
  assert(scr_native_object_is_restricted(object, ops, SCR_NATIVE_SEALED));
  assert(scr_native_object_is_restricted(object, ops, SCR_NATIVE_FROZEN));
  assert(!object->properties && !object->preparations);
  integrity_native_free(object);

  object = integrity_native_new();
  object->fields[1] = SCR_NATIVE_DEFAULT_ACCESSOR;
  scr_native_object_restrict(object, ops, SCR_NATIVE_SEALED);
  assert(scr_native_object_is_restricted(object, ops, SCR_NATIVE_FROZEN));
  assert(!object->properties && !object->preparations);
  integrity_native_free(object);

  object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  scr_native_object_restrict(object, ops, SCR_NATIVE_SEALED);
  assert(scr_native_object_is_restricted(object, ops, SCR_NATIVE_SEALED));
  assert(!scr_native_object_is_restricted(object, ops, SCR_NATIVE_FROZEN));
  assert(scr_native_object_is_restricted(object, ops, SCR_NATIVE_NON_EXTENSIBLE));
  assert(scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_SET));
  assert(object->preparations == 1 && object->properties->non_extensible);
  assert(scr_native_object_check_write(object, ops, "optional", 8, SCR_NATIVE_DELETE));
  assert(!scr_native_object_check_write(object, ops, "optional", 8, SCR_NATIVE_SET_SLOPPY));
  assert(!scr_exc_pending() && object->preparations == 1);
  assert(!scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_DELETE));
  assert(scr_exc_pending());
  scr_exc_clear();
  /* A class field definition must restore configurable:true, so even a
   * writable sealed field rejects it; a plain Set above remains admitted. */
  assert(!scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_DEFINE));
  assert(scr_exc_pending());
  scr_exc_clear();
  scr_native_object_restrict(object, ops, SCR_NATIVE_FROZEN);
  assert(!scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_SET_SLOPPY));
  assert(!scr_exc_pending() && object->preparations == 1);
  assert(!scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_SET));
  assert(scr_exc_pending());
  scr_exc_clear();
  integrity_native_free(object);

  object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  scr_native_object_restrict(object, ops, SCR_NATIVE_NON_EXTENSIBLE);
  assert(scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_DELETE));
  object->fields[0] = 0;
  scr_native_property_forget(object, "data", 4);
  assert(!scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_SET_SLOPPY));
  assert(!object->preparations);
  integrity_native_free(object);

  /* Constructor-time freezing leaves no bag. Refused derived definitions
   * must neither allocate one nor publish field presence. */
  object = integrity_native_new();
  scr_native_object_restrict(object, ops, SCR_NATIVE_FROZEN);
  assert(!scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_DEFINE));
  assert(scr_exc_pending() && !object->properties && !object->preparations && !object->fields[0]);
  scr_exc_clear();
  integrity_native_free(object);

  object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  object->freeze_on_prepare = true;
  assert(!scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_SET));
  assert(scr_exc_pending() && object->preparations == 1);
  scr_exc_clear();
  assert(scr_native_object_is_restricted(object, ops, SCR_NATIVE_FROZEN));
  integrity_native_free(object);

  object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  scr_native_property_attributes(object, "data", 4, 0);
  assert(scr_native_property_flags(object, "data", 4, object->fields[0]) ==
      (SCR_NATIVE_OWN | SCR_NATIVE_DATA));
  assert(scr_native_property_flags(object, "data", 4, 0) == 0);
  scr_native_object_restrict(object, ops, SCR_NATIVE_NON_EXTENSIBLE);
  assert(scr_native_object_is_restricted(object, ops, SCR_NATIVE_FROZEN));
  IntegrityNative *ancestor = integrity_native_new();
  IntegrityNative *pair[] = {ancestor, object};
  scr_publish(pair, integrity_native_publish_ancestor);
  assert(scr_exc_pending() && object->rc == 1 && scr_native_property_metadata(object));
  assert(ancestor->rc == 1);
  scr_exc_clear();
  integrity_native_free(ancestor);
  scr_weak_dispose(object);
  assert(!scr_native_property_metadata(object) && !scr_native_integrity_flags(object));
  assert(scr_native_property_flags(object, "data", 4, object->fields[0]) == SCR_NATIVE_DEFAULT_DATA);
  scr_native_property_attributes(object, "data", 4, SCR_NATIVE_ENUMERABLE);
  scr_native_property_forget(object, "data", 4);
  assert(!scr_native_property_metadata(object));
  integrity_native_free(object);

  object = integrity_native_new();
  object->fields[0] = SCR_NATIVE_DEFAULT_DATA;
  object->prepare_error = scr_dyn_new_obj();
  assert(!scr_native_object_check_write(object, ops, "data", 4, SCR_NATIVE_SET));
  ScrCaught *caught = scr_exc_take();
  assert(caught && caught->payload == object->prepare_error && object->preparations == 1);
  scr_caught_release(caught);
  assert(!object->properties && object->fields[0] == SCR_NATIVE_DEFAULT_DATA);
  integrity_native_free(object);

  /* Names and attribute keys are length-delimited, including embedded NUL.
   * The prefix and full name must never share descriptor overrides. */
  object = integrity_native_new();
  object->fields[0] = object->fields[1] = SCR_NATIVE_DEFAULT_DATA;
  static const char *const escaped_names[] = {"nul", "nul\0key"};
  static const size_t escaped_lengths[] = {3, 7};
  ScrDynNativeObjectOps escaped = *ops;
  escaped.count = 2; escaped.names = escaped_names; escaped.lengths = escaped_lengths;
  scr_native_property_attributes(object, "nul\0key", 7, SCR_NATIVE_ENUMERABLE);
  assert(scr_native_object_check_write(object, &escaped, "nul", 3, SCR_NATIVE_SET));
  assert(!scr_native_object_check_write(object, &escaped, "nul\0key", 7, SCR_NATIVE_SET_SLOPPY));
  scr_native_property_attributes(object, "nul", 3, SCR_NATIVE_ENUMERABLE);
  scr_native_object_restrict(object, &escaped, SCR_NATIVE_NON_EXTENSIBLE);
  assert(scr_native_object_is_restricted(object, &escaped, SCR_NATIVE_FROZEN));
  integrity_native_free(object);
  assert(!scr_native_integrity_active());
}

int main(void) {
  json_string_boundaries();
  json_indent_ownership();
  scr_init();
  checked_storage();
  shared_property_keys();
  checked_leaf_cycles();
  checked_number_storage();
  json_intact_regions();
  json_schema_parse();
  json_schema_special_names();
  native_integrity_lifetime();
  native_integrity_views();
  native_property_owner();
  native_property_define();
  native_property_set();
  native_property_delete();
  native_property_typed_finish(&integrity_native_ops);
  native_property_typed_finish(&native_class_ops);
  native_property_typed_set();
  native_accessor_prototype_receivers();
  native_class_typed_set();
  native_class_property_set();
  native_capsule_integrity();
  native_class_declarations();
  native_class_property_ownership();
  native_class_prototype_ownership();
  native_table_projection();
  native_property_projection();
  native_property_prepare();
  native_property_first_write();
  native_record_metadata_cycles();
  native_record_metadata_publication();
  native_record_prototype_revalidation();
  /* Native Set boxes may own headerless scalar/string maps. Collecting an
   * enclosing cycle must neither trace those leaves nor skip their release. */
  for (int i = 0; i < 2000; i++) {
#ifdef SCR_RC_AUDIT
    long before_maps = scr_map_live_count();
    long before_dyns = scr_dyn_live_count();
#endif
    ScrMap *numbers = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
    ScrMap *strings = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL);
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
  integrity_exit_held = scr_arr_new(SCR_ELEM_F64, 0);
  scr_native_integrity_strengthen(integrity_exit_held, SCR_NATIVE_FROZEN);
  assert(atexit(integrity_exit_check) == 0);
  puts("checked storage and weak metadata lifetime checks passed");
  return 0;
}
