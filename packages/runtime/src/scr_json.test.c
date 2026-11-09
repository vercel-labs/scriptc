#include "scr_runtime.h"
#include "scr_record_source_get.h"
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
void scr_layout_reset_idle(void);
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

/* A value for a weak entry: an object that holds `owner` (when given) and
 * the witness, whose count says how many such values are alive. */
static ScrDyn *holder(ScrDyn *owner, ScrDyn *witness) {
  ScrDyn *value = scr_dyn_new_obj();
  if (owner) scr_dyn_obj_set(value, "owner", 5, scr_dyn_retain(owner));
  scr_dyn_obj_set(value, "witness", 7, scr_dyn_retain(witness));
  return value;
}

static bool holds(ScrDyn *map, ScrDyn *key) {
  ScrDyn *result = scr_dyn_handle_ops_of(map)->invoke(map->v.handle.ptr, map, "has", &key, 1, "map.has");
  assert(result && result->kind == SCR_DYN_BOOL && !scr_exc_pending());
  bool found = result->v.b;
  scr_dyn_release(result);
  return found;
}

/* A native value without a collector header, and its capsule's callbacks. */
typedef struct { size_t rc; } Unheadered;
static void *unheadered_retain(void *ptr) {
  ((Unheadered *)ptr)->rc++;
  return ptr;
}
static void unheadered_release(void *ptr) {
  if (--((Unheadered *)ptr)->rc) return;
  scr_weak_dispose(ptr); /* native frees notify the dispose hook */
  free(ptr);
}
static ScrDyn *unheadered_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}
void scr_dyn_decl_become(ScrDyn *n, const ScrDyn *capsule);

/* A weak entry lasts while its key and its collection are alive without it:
 * scr_weak_collect_entries ends the ones only their own values keep, and
 * leaves every count of what stays as it found it. */
static void weak_entries_held_by_their_values(ScrDyn *witness) {
  size_t idle = witness->rc;
  ScrDyn *map = scr_weak_map_new(scr_dyn_undefined());
  assert(scr_weak_collect_entries() == 0);

  /* The value holds its key; the key is held elsewhere, then not. */
  ScrDyn *key = scr_dyn_new_obj();
  ScrDyn *value = holder(key, witness);
  put(map, key, value);
  scr_dyn_release(value);
  assert(scr_weak_collect_entries() == 0);
  assert(key->rc == 2 && value->rc == 1 && witness->rc == idle + 1 && holds(map, key));
  scr_dyn_release(key);
  assert(witness->rc == idle + 1);
  assert(scr_weak_collect_entries() == 1);
  assert(witness->rc == idle);

  /* The key is its own value. */
  key = scr_dyn_new_obj();
  scr_dyn_obj_set(key, "witness", 7, scr_dyn_retain(witness));
  put(map, key, key);
  scr_dyn_release(key);
  assert(witness->rc == idle + 1 && scr_weak_collect_entries() == 1 && witness->rc == idle);

  /* A value that holds nothing of its key ends with the key, as before. */
  key = scr_dyn_new_obj();
  value = holder(NULL, witness);
  put(map, key, value);
  scr_dyn_release(value);
  assert(scr_weak_collect_entries() == 0 && witness->rc == idle + 1);
  scr_dyn_release(key);
  assert(witness->rc == idle);

  /* A chain: each value holds its own key and the next key, and only the
   * first key is held elsewhere. The entries are judged in the order that
   * makes each depend on one judged later. */
  enum { CHAIN = 3000 };
  ScrDyn *head = scr_dyn_new_obj();
  ScrDyn *at = scr_dyn_retain(head);
  for (int i = 0; i < CHAIN; i++) {
    ScrDyn *next = scr_dyn_new_obj();
    value = holder(at, witness);
    scr_dyn_obj_set(value, "next", 4, scr_dyn_retain(next));
    put(map, at, value);
    scr_dyn_release(value);
    scr_dyn_release(at);
    at = next;
  }
  scr_dyn_release(at);
  assert(scr_weak_collect_entries() == 0);
  assert(witness->rc == idle + CHAIN && head->rc == 2 && holds(map, head));
  scr_dyn_release(head);
  assert(scr_weak_collect_entries() == CHAIN && witness->rc == idle);

  /* Two collections, each value holding the other's key. */
  ScrDyn *other = scr_weak_map_new(scr_dyn_undefined());
  key = scr_dyn_new_obj();
  ScrDyn *second = scr_dyn_new_obj();
  value = holder(second, witness);
  put(map, key, value);
  scr_dyn_release(value);
  value = holder(key, witness);
  put(other, second, value);
  scr_dyn_release(value);
  assert(scr_weak_collect_entries() == 0 && witness->rc == idle + 2);
  scr_dyn_release(key);
  assert(scr_weak_collect_entries() == 0 && witness->rc == idle + 2 && holds(map, key));
  scr_dyn_release(second);
  assert(scr_weak_collect_entries() == 2 && witness->rc == idle);

  /* A collection that only a dead entry's value reaches: its entries end
   * although their key is alive. */
  ScrDyn *inner = scr_weak_map_new(scr_dyn_undefined());
  ScrDyn *kept = scr_dyn_new_obj();
  value = holder(NULL, witness);
  put(inner, kept, value);
  scr_dyn_release(value);
  key = scr_dyn_new_obj();
  value = holder(key, witness);
  scr_dyn_obj_set(value, "inner", 5, inner);
  put(map, key, value);
  scr_dyn_release(value);
  assert(scr_weak_collect_entries() == 0 && witness->rc == idle + 2);
  scr_dyn_release(key);
  size_t ended = scr_weak_collect_entries();
  assert(ended == 2);
  assert(witness->rc == idle);
  assert(kept->rc == 1);
  scr_dyn_release(kept);

  /* A collection that only a live entry's value reaches stays, with its
   * entries, and every count is what it was. */
  inner = scr_weak_map_new(scr_dyn_undefined());
  kept = scr_dyn_new_obj();
  ScrDyn *filed = holder(kept, witness);
  put(inner, kept, filed);
  scr_dyn_release(filed);
  key = scr_dyn_new_obj();
  value = holder(key, witness);
  scr_dyn_obj_set(value, "inner", 5, scr_dyn_retain(inner));
  scr_dyn_obj_set(value, "kept", 4, scr_dyn_retain(kept));
  put(map, key, value);
  scr_dyn_release(value);
  scr_dyn_release(kept);
  assert(scr_weak_collect_entries() == 0);
  assert(inner->rc == 2 && filed->rc == 1 && value->rc == 1 && kept->rc == 2 && key->rc == 2);
  assert(witness->rc == idle + 2 && holds(inner, kept));
  scr_dyn_release(inner);
  assert(scr_weak_collect_entries() == 0 && filed->rc == 1 && witness->rc == idle + 2);
  scr_dyn_release(key);
  assert(scr_weak_collect_entries() == 2);
  assert(witness->rc == idle);

  /* One value under two keys: a live key keeps it, and what it holds. */
  key = scr_dyn_new_obj();
  second = scr_dyn_new_obj();
  value = holder(key, witness);
  put(map, key, value);
  put(map, second, value);
  scr_dyn_release(value);
  scr_dyn_release(key);
  assert(scr_weak_collect_entries() == 0 && value->rc == 2 && witness->rc == idle + 1);
  scr_dyn_release(second);
  assert(scr_weak_collect_entries() == 1 && witness->rc == idle);

  /* A function key that its value holds. */
  ScrClosure *closure = scr_closure_new(NULL, 0);
  key = scr_dyn_new_func(closure, nothing, 0, "", "key");
  value = holder(key, witness);
  put(map, key, value);
  scr_dyn_release(value);
  assert(scr_weak_collect_entries() == 0);
  scr_dyn_release(key);
  assert(scr_weak_collect_entries() == 1 && witness->rc == idle);

  /* A key that becomes, in place, a capsule of a native value (a checked
   * cast of a shared object does that): its entry moves to the value's
   * identity. A native value need not have a collector header, so nothing
   * may be read in front of it and the entry stays, as before. */
  Unheadered *native = malloc(sizeof *native);
  assert(native);
  native->rc = 1;
  ScrDyn *capsule = scr_dyn_new_typed_ref(native, unheadered_retain, unheadered_release, "plain", 5,
                                          unheadered_view, NULL);
  key = scr_dyn_new_obj();
  value = holder(key, witness);
  put(map, key, value);
  scr_dyn_release(value);
  scr_dyn_decl_become(key, capsule);
  scr_dyn_release(capsule);
  unheadered_release(native);
  assert(holds(map, key));
  scr_dyn_release(key);
  assert(scr_weak_collect_entries() == 0 && witness->rc == idle + 1 && native->rc >= 1);
  /* Nothing can reach that entry again; it ends with the collection. */
  ScrDyn *moved = scr_weak_map_new(scr_dyn_undefined());
  ScrDyn *swap = map;
  map = moved;
  scr_dyn_release(swap);
  assert(witness->rc == idle);

  /* A WeakSet member has no value to hold it. */
  ScrDyn *set = scr_weak_set_new(scr_dyn_undefined());
  key = scr_dyn_new_obj();
  ScrDyn *added = scr_dyn_handle_ops_of(set)->invoke(set->v.handle.ptr, set, "add", &key, 1, "set.add");
  scr_dyn_release(added);
  assert(scr_weak_collect_entries() == 0 && holds(set, key));
  scr_dyn_release(key);
  scr_dyn_release(set);

  /* Left to itself, the runtime keeps such entries bounded by the heap's
   * growth since the last analysis. */
  for (int i = 0; i < 200000; i++) {
    key = scr_dyn_new_obj();
    value = holder(key, witness);
    put(map, key, value);
    scr_dyn_release(value);
    scr_dyn_release(key);
    assert(witness->rc < idle + 10000);
  }
  scr_weak_collect_entries();
  assert(witness->rc == idle);
  scr_dyn_release(other);
  scr_dyn_release(map);
}

size_t scr_cyc_pass_at(unsigned gen);

/* Marks a weak collection (its handle and the collection itself) as having
 * survived earlier passes. A candidate is listed under its generation, so
 * each leaves its candidate list first. */
static ScrDyn *aged(ScrDyn *collection, unsigned gen) {
  void *both[2] = {collection, collection->v.handle.ptr};
  for (int i = 0; i < 2; i++) {
    scr_cyc_dead(both[i]);
    scr_cyc_set_gen(scr_cyc_hdr(both[i]), gen);
  }
  return collection;
}

/* A collector object of a type of its own (so no other test's survivors
 * decide which pass walks it) that holds itself and one value. */
typedef struct { size_t rc; void *self; ScrDyn *held; } YoungHolder;
static void young_trace(void *ptr, ScrTraceVisit visit, void *ctx) {
  visit(((YoungHolder *)ptr)->self, ctx);
  visit(((YoungHolder *)ptr)->held, ctx);
}
static void young_free(void *ptr) { scr_cyc_free(ptr); }
static YoungHolder *young_holder(ScrDyn *held) {
  static ScrCycType type = { &young_trace, &young_free, 0 };
  YoungHolder *young = scr_cyc_alloc(sizeof *young, &type);
  assert(young);
  young->rc = 2; /* its own edge and the caller */
  young->self = young;
  young->held = held;
  return young;
}

/* Hangs `collection` (given up by the caller) off a fresh object on a cycle
 * of its own, drops the object, and runs a pass over the nursery. An aged
 * collection is not walked by that pass: the edge to it is recorded, and
 * once the young cycle is freed the drain gives the edge up for real. */
static void drop_through_young_cycle(ScrDyn *collection) {
  YoungHolder *young = young_holder(collection);
  young->rc--;
  scr_cyc_on_release(young);
  scr_cyc_pass_at(SCR_CYC_NURSERY);
}

/* A weak collection older than the garbage that holds it is freed by the
 * cross-generation drain of a restricted pass (scr_xg_release): generically,
 * by a walk of its entries that releases each value, then its free.
 * Releasing a value can free keys, and a freed key ends its entries in
 * every collection, the one being walked included (scr_weak_remove's
 * invariant). Each shape must leave every value released exactly once (the
 * witness's count is back where it was) and no entry freed under the walk
 * (the address sanitizer watches the entries). This runs in both flavors;
 * the one without the count audit has the release build's parked capsules
 * and free lists. */
static void weak_collection_freed_by_drain(ScrDyn *witness) {
  size_t idle = witness->rc;
  for (unsigned gen = SCR_CYC_MATURE; gen <= SCR_CYC_OLD; gen++) {
    /* One entry whose value holds its key: the key dies inside the visit of
     * its own entry. */
    ScrDyn *map = aged(scr_weak_map_new(scr_dyn_undefined()), gen);
    ScrDyn *key = scr_dyn_new_obj();
    ScrDyn *value = holder(key, witness);
    put(map, key, value);
    scr_dyn_release(value);
    scr_dyn_release(key);
    assert(witness->rc == idle + 1);
    drop_through_young_cycle(map);
    assert(witness->rc == idle);

    /* Two entries, each value holding the other's key. The walk starts at
     * the newer entry: releasing its value frees the older entry's key
     * (an entry ends before the walk reaches it), and releasing the older
     * value then frees the newer entry's key (an entry ends after the walk
     * has passed it). */
    map = aged(scr_weak_map_new(scr_dyn_undefined()), gen);
    key = scr_dyn_new_obj();
    ScrDyn *second = scr_dyn_new_obj();
    value = holder(second, witness);
    put(map, key, value);
    scr_dyn_release(value);
    value = holder(key, witness);
    put(map, second, value);
    scr_dyn_release(value);
    scr_dyn_release(key);
    scr_dyn_release(second);
    assert(witness->rc == idle + 2);
    drop_through_young_cycle(map);
    assert(witness->rc == idle);

    /* A ring: each value holds the next entry's key, so every visit of the
     * walk frees the key of another entry, one it has passed or one it has
     * yet to reach. */
    enum { RING = 40 };
    map = aged(scr_weak_map_new(scr_dyn_undefined()), gen);
    ScrDyn *first = scr_dyn_new_obj();
    ScrDyn *at = scr_dyn_retain(first);
    for (int i = 0; i < RING; i++) {
      ScrDyn *next = i + 1 < RING ? scr_dyn_new_obj() : scr_dyn_retain(first);
      value = holder(next, witness);
      put(map, at, value);
      scr_dyn_release(value);
      scr_dyn_release(at);
      at = next;
    }
    scr_dyn_release(at);
    scr_dyn_release(first);
    assert(witness->rc == idle + RING);
    drop_through_young_cycle(map);
    assert(witness->rc == idle);

    /* Nested: the outer entry's value holds a second aged collection, whose
     * entry's value holds the outer entry's key, and then the inner entry's
     * key. The outer key dies inside the inner collection's walk, while the
     * outer walk is on its entry. */
    map = aged(scr_weak_map_new(scr_dyn_undefined()), gen);
    ScrDyn *inner = aged(scr_weak_map_new(scr_dyn_undefined()), gen);
    key = scr_dyn_new_obj();
    second = scr_dyn_new_obj();
    value = holder(key, witness);
    put(inner, second, value);
    scr_dyn_release(value);
    value = holder(NULL, witness);
    scr_dyn_obj_set(value, "inner", 5, inner);
    scr_dyn_obj_set(value, "second", 6, scr_dyn_retain(second));
    put(map, key, value);
    scr_dyn_release(value);
    scr_dyn_release(key);
    scr_dyn_release(second);
    assert(witness->rc == idle + 2);
    drop_through_young_cycle(map);
    assert(witness->rc == idle);

    /* A weak set's member is also a key of the collection whose value holds
     * the set and the member: the member dies while both are being freed. */
    map = aged(scr_weak_map_new(scr_dyn_undefined()), gen);
    ScrDyn *set = aged(scr_weak_set_new(scr_dyn_undefined()), gen);
    key = scr_dyn_new_obj();
    ScrDyn *added = scr_dyn_handle_ops_of(set)->invoke(set->v.handle.ptr, set, "add", &key, 1, "set.add");
    assert(added == set);
    scr_dyn_release(added);
    value = holder(key, witness);
    scr_dyn_obj_set(value, "set", 3, set);
    put(map, key, value);
    scr_dyn_release(value);
    scr_dyn_release(key);
    assert(witness->rc == idle + 1);
    drop_through_young_cycle(map);
    assert(witness->rc == idle);

    /* The young garbage is a key of the aged collection it holds: its free
     * ends the entry while the collection is still alive (the drain has not
     * reached it), and the value is released then. */
    map = aged(scr_weak_map_new(scr_dyn_undefined()), gen);
    key = scr_dyn_new_obj();
    value = holder(NULL, witness);
    put(map, key, value);
    scr_dyn_release(value);
    YoungHolder *young = young_holder(key);
    scr_dyn_obj_set(key, "collection", 10, map);
    assert(witness->rc == idle + 1);
    young->rc--;
    scr_cyc_on_release(young);
    scr_cyc_pass_at(SCR_CYC_NURSERY);
    assert(witness->rc == idle);
  }
  /* Nothing aged: the collection, its keys and its values are one dead set
   * (a value holds the collection), and each is freed by the pass itself,
   * the collection and its keys in whatever order the pass takes them. */
  ScrDyn *map = scr_weak_map_new(scr_dyn_undefined());
  ScrDyn *key = scr_dyn_new_obj();
  ScrDyn *second = scr_dyn_new_obj();
  ScrDyn *value = holder(second, witness);
  put(map, key, value);
  scr_dyn_release(value);
  value = holder(key, witness);
  scr_dyn_obj_set(value, "collection", 10, scr_dyn_retain(map));
  put(map, second, value);
  scr_dyn_release(value);
  scr_dyn_release(key);
  scr_dyn_release(second);
  scr_dyn_release(map);
  scr_collect_cycles();
  assert(witness->rc == idle);
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
      assert((object->v.obj.index != NULL) == (i >= (int)SCR_LAYOUT_MAX_KEYS));
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
  /* Layouts hold key references until the thread's state is torn down. */
  scr_layout_reset_idle();
  long before = scr_dyn_key_live_count();
#endif
  /* Distinct objects share bytes, not values or property attributes. Key
   * deletion, a collected owner and a caller-owned input cannot invalidate
   * the surviving entry. */
  ScrDyn *first = scr_dyn_new_obj(), *second = scr_dyn_new_obj();
  char key[] = "shared\0name";
  scr_dyn_obj_set(first, key, sizeof key - 1, scr_dyn_new_num(1));
  scr_dyn_obj_set(second, key, sizeof key - 1, scr_dyn_new_num(2));
  size_t first_len, second_len;
  assert(scr_dyn_obj_key_at(first, 0, &first_len) == scr_dyn_obj_key_at(second, 0, &second_len));
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
  scr_layout_reset_idle();
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

/* A collector pass can buffer a number or string box that it reached
 * through an owner that traces it: scr_xg_release, settling an edge a
 * restricted pass skipped, calls scr_cyc_on_release on the target. The
 * box's last release must take it out of its candidate buffer before its
 * block returns to the free list, which hands it to the next box. */
static void buffered_leaf_release(void) {
  for (uint16_t gen = SCR_CYC_NURSERY; gen < SCR_CYC_NGENS; gen++) {
    ScrStr *text = scr_str_new("buffered", 8);
    ScrDyn *leaves[2] = {scr_dyn_new_str(text), scr_dyn_new_num(0.5)};
    scr_str_release(text);
    for (int i = 0; i < 2; i++) {
      scr_cyc_set_gen(scr_cyc_hdr(leaves[i]), gen);
      scr_cyc_on_release(leaves[i]);
      scr_dyn_release(leaves[i]);
    }
    ScrDyn *fresh[2] = {scr_dyn_new_num(1.5), scr_dyn_new_num(2.5)};
    assert(!buffered(fresh[0]) && !buffered(fresh[1]));
    scr_collect_cycles();
    assert(fresh[0]->v.num == 1.5 && fresh[1]->v.num == 2.5);
    scr_dyn_release(fresh[0]);
    scr_dyn_release(fresh[1]);
  }
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

static ScrDyn *test_item_box(TestItem *item) {
  static const char key[] = "class:TestItem";
  return scr_dyn_new_typed_ref(item, test_item_retain, test_item_release, key, sizeof key - 1, NULL,
                               NULL);
}

/* The ring of parked capsules owns one reference to each capsule in it
 * (scr_typed_ref_park): a parked capsule keeps its identity and its
 * referent, is never parked twice however often it is held again, and lets
 * its referent go when it loses its slot or a collector pass flushes the
 * ring. The RC audit parks nothing. */
static void parked_capsules(void) {
  enum { MANY = 40, RING = 16 };
  long live = test_items_live;
  TestItem *one = test_item_new(), *others[MANY];
  ScrDyn *first = test_item_box(one);
  assert(first->rc == 1 && one->rc == 2);
  scr_dyn_release(first);
#ifndef SCR_RC_AUDIT
  assert(one->rc == 2);
  ScrDyn *again = test_item_box(one);
  assert(again == first);
  for (int i = 0; i < MANY; i++) scr_dyn_release(scr_dyn_retain(again));
  scr_dyn_release(again);
  for (int i = 0; i < MANY; i++) {
    ScrDyn *boxed = test_item_box(one);
    assert(boxed == first && one->rc == 2);
    scr_dyn_release(boxed);
  }
#else
  assert(one->rc == 1);
#endif
  /* More capsules than the ring has slots: the oldest ones are disposed. */
  for (int i = 0; i < MANY; i++) {
    others[i] = test_item_new();
    scr_dyn_release(test_item_box(others[i]));
  }
  assert(one->rc == 1);
#ifndef SCR_RC_AUDIT
  int parked = 0;
  for (int i = 0; i < MANY; i++) parked += others[i]->rc == 2;
  assert(parked == RING);
  /* A capsule held again when its slot's turn comes only leaves the ring,
   * and parks again when it dies. */
  ScrDyn *kept = test_item_box(others[MANY - 1]);
  for (int i = 0; i < RING + 4; i++) {
    TestItem *brief = test_item_new();
    scr_dyn_release(test_item_box(brief));
    test_item_release(brief);
  }
  assert(kept->rc == 1 && others[MANY - 1]->rc == 2);
  assert(test_item_box(others[MANY - 1]) == kept);
  scr_dyn_release(kept);
  scr_dyn_release(kept);
  assert(others[MANY - 1]->rc == 2);
#endif
  scr_collect_cycles();
  for (int i = 0; i < MANY; i++) {
    assert(others[i]->rc == 1);
    test_item_release(others[i]);
  }
  test_item_release(one);
  assert(test_items_live == live);
}

/* A candidate that is buffered and then dies leaves the inline window open
 * while the nursery buffer's capacity, not the trigger, is what bounds it
 * (scr_cyc_window_shrink): the window is at zero once per trigger, not for
 * every release past the capacity. The trigger counts arrivals, deaths or
 * not, so a pass falls due at the same arrival as before, and the cycle
 * planted here, which is garbage, is collected by exactly that pass.
 *
 * The trigger is this binary's SCR_CYCLE_THRESHOLD (scr_json.test.ts runs
 * it with 1, 7 and 256), which takes precedence over
 * scr_cyc_set_nursery_threshold. With 1 every release takes the call and
 * runs a pass, with 7 the trigger is below the capacity and the window
 * closes one round in seven; with 256 it stayed closed for 191 rounds of
 * every 256 before the window kept its slack. */
static void candidate_window_after_deaths(void) {
#if SCR_CYC_INLINE_BUFFERING
  enum { ROUNDS = 20480 };
  const char *pinned = getenv("SCR_CYCLE_THRESHOLD");
  long trigger = pinned ? strtol(pinned, NULL, 10) : 0;
  scr_collect_cycles(); /* arms the trigger over an empty nursery buffer */
  long live = test_items_live;
  TestItem *item = test_item_new();
  ScrDyn *cycle = scr_dyn_new_obj();
  scr_dyn_obj_set(cycle, "self", 4, scr_dyn_retain(cycle));
  scr_dyn_obj_set(cycle, "item", 4, test_item_box(item));
  test_item_release(item);
  scr_dyn_release(cycle); /* the first arrival; the cycle is garbage from here */
  int closed = 0, collected_after = test_items_live == live ? 0 : -1;
  for (int i = 0; i < ROUNDS; i++) {
    ScrDyn *brief = scr_dyn_new_obj();
    scr_dyn_release(scr_dyn_retain(brief)); /* one arrival */
    scr_dyn_release(brief);                 /* and its death */
    if (collected_after < 0 && test_items_live == live) collected_after = i + 1;
    closed += scr_cyc_buffers.window == 0;
  }
  /* The cycle went with the pass some arrival brought about. */
  assert(collected_after >= 0);
  if (trigger > 0) {
    /* That pass is the one the trigger's arrival runs: the cycle's own
     * release is arrival 1, round r's candidate is arrival r + 1. */
    assert(collected_after == trigger - 1);
    /* The window is at zero once per trigger (and always with a trigger of
     * one, where no append is inline). */
    assert(closed <= ROUNDS / trigger + 1);
  }
  assert(test_items_live == live);
#endif
}

static ScrArr *test_tags_new(size_t cap) { return scr_arr_new(SCR_ELEM_STR, cap); }
static ScrArr *test_list_new(size_t cap) {
  static ScrArrOps item_ops = { test_item_retain, test_item_release, NULL };
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
    size_t key_len;
    const char *key = scr_dyn_obj_key_at(view, i, &key_len);
    assert(key_len == strlen(order[i]));
    assert(memcmp(key, order[i], strlen(order[i])) == 0);
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

/* Union members: a nullable string with an undefined arm, an inline
 * number | null | undefined pair, and a boxed number | string. */
typedef struct {
  uint32_t tag;
  uint64_t bits;
} TestInline;
typedef struct {
  size_t rc;
  ScrStr *name;   /* string | undefined: the payload, NULL, or test_absent */
  TestInline age; /* number (0) | null (1) | undefined (2) */
  ScrUnion *key;  /* number (0) | string (1) */
} TestOpt;
static size_t test_absent[4] = {SIZE_MAX, 0, 0, 0};
static int test_opts_live = 0;
static void *test_opt_new(void) {
  TestOpt *opt = calloc(1, sizeof *opt);
  assert(opt);
  opt->rc = 1;
  test_opts_live++;
  return opt;
}
static void test_opt_release(void *ptr) {
  TestOpt *opt = ptr;
  if (!opt || --opt->rc) return;
  if (opt->name && opt->name != (ScrStr *)test_absent) scr_str_release(opt->name);
  scr_union_release(opt->key);
  test_opts_live--;
  scr_weak_dispose(opt);
  free(opt);
}
static void *test_key_box(uint32_t tag, uint64_t bits) {
  if (tag == 0) {
    double d;
    memcpy(&d, &bits, sizeof d);
    return scr_union_new_f64(0, d);
  }
  return scr_union_new_ref(1, (void *)(uintptr_t)bits, scr_str_retain_v, scr_str_release_v, NULL);
}
#define NO_ARM SCR_JSCHEMA_NO_ARM
static const ScrJsonUnion test_name_union = {
    SCR_JUNION_NULLABLE, {NO_ARM, NO_ARM, NO_ARM, 0, NO_ARM, NO_ARM, 1},
    {NULL, NULL, NULL, &test_str, NULL, NULL, NULL}, NULL, test_absent, NULL};
static const ScrJsonUnion test_age_union = {
    SCR_JUNION_INLINE, {1, 0, NO_ARM, NO_ARM, NO_ARM, NO_ARM, 2},
    {NULL, &test_f64, NULL, NULL, NULL, NULL, NULL}, NULL, NULL, NULL};
static const ScrJsonUnion test_key_union = {
    SCR_JUNION_BOXED, {NO_ARM, 0, NO_ARM, 1, NO_ARM, NO_ARM, NO_ARM},
    {NULL, &test_f64, NULL, &test_str, NULL, NULL, NULL}, NULL, NULL, test_key_box};
#undef NO_ARM
static const ScrJsonSchema test_name = {SCR_JSCHEMA_UNION, 0, NULL, NULL, NULL, NULL, NULL, &test_name_union};
static const ScrJsonSchema test_age = {SCR_JSCHEMA_UNION, 0, NULL, NULL, NULL, NULL, NULL, &test_age_union};
static const ScrJsonSchema test_key = {SCR_JSCHEMA_UNION, 0, NULL, NULL, NULL, NULL, NULL, &test_key_union};
static const ScrJsonSchemaField test_opt_fields[] = {
    {"name", 4, offsetof(TestOpt, name), &test_name},
    {"age", 3, offsetof(TestOpt, age), &test_age},
    {"key", 3, offsetof(TestOpt, key), &test_key},
};
static const ScrJsonSchema test_opt = {SCR_JSCHEMA_REC, 3, test_opt_fields, NULL, test_opt_new, NULL, test_opt_release};

static TestOpt *opt_parse(const char *text) {
  ScrStr *input = scr_str_new(text, strlen(text));
  TestOpt *opt = scr_json_parse_schema(input, &test_opt);
  scr_str_release(input);
  assert(!scr_exc_pending());
  return opt;
}

static void json_schema_union_members(void) {
  TestOpt *opt = opt_parse("{\"name\":\"n\",\"age\":2.5,\"key\":\"k\"}");
  assert(opt && str_is(opt->name, "n") && opt->age.tag == 0);
  double age;
  memcpy(&age, &opt->age.bits, sizeof age);
  assert(age == 2.5);
  assert(opt->key->tag == 1 && str_is(scr_union_peek(opt->key), "k"));
  assert(!scr_record_source_has(opt));
  test_opt_release(opt);
  /* Missing undefined-armed members take their ABSENT states; null lands
   * in the null arm with zero bits. */
  opt = opt_parse("{\"key\":-1}");
  assert(opt && opt->name == (ScrStr *)test_absent);
  assert(opt->age.tag == 2 && opt->age.bits == 1);
  assert(opt->key->tag == 0 && scr_union_get_f64(opt->key) == -1);
  test_opt_release(opt);
  opt = opt_parse("{\"age\":null,\"key\":0}");
  assert(opt && opt->name == (ScrStr *)test_absent && opt->age.tag == 1 && opt->age.bits == 0);
  test_opt_release(opt);
  /* A reordered member keeps the source beside the record, absent members
   * included. */
  opt = opt_parse("{\"key\":\"z\",\"name\":\"y\"}");
  assert(opt && str_is(opt->name, "y") && opt->age.tag == 2 && opt->age.bits == 1);
  assert(scr_record_source_has(opt));
  test_opt_release(opt);
  /* No arm of the value's kind, or a missing member without an undefined
   * arm, declines. */
  static const char *const declined[] = {
      "{\"name\":null,\"key\":1}",
      "{\"age\":\"1\",\"key\":1}",
      "{\"key\":true}",
      "{\"key\":null}",
      "{\"name\":\"a\"}",
      "{}",
      "{\"key\":1,\"key\":2}",
      "{\"age\":nul,\"key\":1}",
  };
  for (size_t i = 0; i < sizeof declined / sizeof *declined; i++) {
    assert(!opt_parse(declined[i]));
    assert(test_opts_live == 0);
  }
  assert(test_opts_live == 0);
}

static ScrDyn *class_member_get(void *instance, size_t index) {
  (void)instance;
  return scr_dyn_new_num(index == 0 ? 7 : 3);
}

/* A record keeps the source properties its shape does not declare beside
 * it, so a spread after the conversion reproduces them. A class member the
 * source view answers with its getter is not one of those properties. */
static void record_source_class_member(void) {
  ScrStr *member = scr_str_new("extra", 5);
  ScrDynTypedClassOps ops = {0};
  ops.accessor_count = 1;
  ops.accessor_names = &member;
  ops.accessor_get = class_member_get;
  ScrDyn *instance = scr_dyn_new_obj();
  ScrDyn *source = scr_dyn_new_obj();
  ScrStr *label = scr_str_new("label", 5);
  scr_dyn_obj_set(source, "label", 5, scr_dyn_new_str(label));
  scr_str_release(label);
  scr_dyn_obj_set(source, "count", 5, scr_dyn_new_num(2));
  scr_dyn_class_view_accessors(source, &ops, instance, scr_dyn_retain_v, scr_dyn_release_v, NULL);
  ScrDyn *read = scr_dyn_obj_read(source, "extra", 5);
  assert(read && read->kind == SCR_DYN_NUM && read->v.num == 7);
  scr_dyn_release(read);

  static const char *const names[] = {"label"};
  static const size_t lens[] = {5};
  size_t record[2] = {1, 0};
  scr_record_source_note(record, source, names, lens, 1);
  assert(!scr_exc_pending() && scr_record_source_has(record));
  const ScrDyn *view = scr_record_source_view(record);
  assert(view && view->kind == SCR_DYN_OBJ && view->v.obj.len == 2);
  size_t key_len;
  const char *key = scr_dyn_obj_key_at(view, 0, &key_len);
  assert(key_len == 5 && memcmp(key, "label", 5) == 0);
  key = scr_dyn_obj_key_at(view, 1, &key_len);
  assert(key_len == 5 && memcmp(key, "count", 5) == 0);

  scr_weak_dispose(record);
  assert(!scr_record_source_has(record));
  scr_dyn_release(source);
  scr_dyn_release(instance);
  scr_str_release(member);
}

/* scr_dyn_copy_prop_at stores a plain data property by an ordinary write
 * whichever mode the source object is in: on an array, an index key becomes
 * an element and a name goes to the array's own properties. */
static void copy_prop_modes(void) {
  for (int dictionary = 0; dictionary < 2; dictionary++) {
    ScrDyn *source = scr_dyn_new_obj();
    scr_dyn_obj_set(source, "0", 1, scr_dyn_new_num(7));
    scr_dyn_obj_set(source, "tag", 3, scr_dyn_new_num(3));
    if (dictionary) scr_dyn_to_dictionary(source);
    assert((source->v.obj.layout == NULL) == (dictionary == 1));
    ScrDyn *target = scr_dyn_new_arr();
    for (size_t i = 0; i < scr_dyn_obj_count(source); i++) scr_dyn_copy_prop_at(target, source, i);
    assert(!scr_exc_pending());
    assert(target->v.arr.len == 1);
    assert(target->v.arr.items[0]->kind == SCR_DYN_NUM && target->v.arr.items[0]->v.num == 7);
    const ScrDyn *named = target->v.arr.properties;
    assert(named && scr_dyn_obj_count(named) == 1);
    const ScrDyn *tag = scr_dyn_obj_get(named, "tag", 3);
    assert(tag && tag->kind == SCR_DYN_NUM && tag->v.num == 3);
    scr_dyn_release(target);
    scr_dyn_release(source);
  }
}

static ScrDyn *getter_seven(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  return scr_dyn_new_num(7);
}

/* The read a record→record conversion uses for a field the source type does
 * not declare: a data key answers the kept value (+1), a key the source
 * lacks answers the undefined value, an accessor the kept source carries
 * runs, and a record that keeps no source answers the undefined value too. */
static void record_source_get(void) {
  static const char *const names[] = {"label"};
  static const size_t lens[] = {5};
  size_t record[2] = {1, 0};
  ScrDyn *source = scr_dyn_new_obj();
  scr_dyn_obj_set(source, "label", 5, scr_dyn_new_num(1));
  scr_dyn_obj_set(source, "count", 5, scr_dyn_new_num(2));
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3,
                  scr_dyn_new_func(scr_closure_new(NULL, 0), getter_seven, 0, "", ""));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  ScrStr *name = scr_str_new("computed", 8);
  ScrDyn *name_value = scr_dyn_new_str(name);
  scr_dyn_release(scr_dyn_define_property(source, name_value, descriptor));
  scr_dyn_release(name_value);
  scr_dyn_release(descriptor);
  scr_str_release(name);

  scr_record_source_note(record, source, names, lens, 1);
  assert(!scr_exc_pending() && scr_record_source_has(record));
  ScrDyn *count = scr_record_source_get(record, "count", 5);
  assert(count && count->kind == SCR_DYN_NUM && count->v.num == 2);
  scr_dyn_release(count);
  ScrDyn *computed = scr_record_source_get(record, "computed", 8);
  assert(computed && computed->kind == SCR_DYN_NUM && computed->v.num == 7);
  scr_dyn_release(computed);
  /* A declared key holds a placeholder: the record is its source of truth. */
  ScrDyn *declared = scr_record_source_get(record, "label", 5);
  assert(declared && declared->kind == SCR_DYN_UNDEF);
  scr_dyn_release(declared);
  ScrDyn *missing = scr_record_source_get(record, "absent", 6);
  assert(missing && missing->kind == SCR_DYN_UNDEF);
  scr_dyn_release(missing);

  scr_weak_dispose(record);
  assert(!scr_record_source_has(record));
  ScrDyn *none = scr_record_source_get(record, "count", 5);
  assert(none && none->kind == SCR_DYN_UNDEF);
  scr_dyn_release(none);
  scr_dyn_release(source);
}

/* A declared key the source held as a non-enumerable data property stays
 * non-enumerable: the conversion keeps a view for that alone, the view's
 * entry for the key carries the attribute, and a refresh of the view from
 * the record's values keeps it. An enumerable source in declaration order
 * still keeps nothing. */
static void record_source_hidden_key(void) {
  static const char *const names[] = {"kind", "type"};
  static const size_t lens[] = {4, 4};
  ScrStr *text = scr_str_new("t", 1);

  ScrDyn *plain = scr_dyn_new_obj();
  scr_dyn_obj_set(plain, "kind", 4, scr_dyn_new_str(text));
  scr_dyn_obj_set(plain, "type", 4, scr_dyn_new_str(text));
  size_t ordinary[2] = {1, 0};
  scr_record_source_note(ordinary, plain, names, lens, 2);
  assert(!scr_record_source_has(ordinary));

  ScrDyn *source = scr_dyn_new_obj();
  scr_dyn_obj_set(source, "kind", 4, scr_dyn_new_str(text));
  scr_dyn_obj_set(source, "type", 4, scr_dyn_new_str(text));
  scr_dyn_obj_set_attrs_at(source, scr_dyn_obj_index_of(source, "kind", 4), true, false, true);
  size_t record[2] = {1, 0};
  scr_record_source_note(record, source, names, lens, 2);
  assert(!scr_exc_pending() && scr_record_source_has(record));
  const ScrDyn *view = scr_record_source_view(record);
  assert(view && view->kind == SCR_DYN_OBJ && view->v.obj.len == 2);
  ScrDynProp kind = scr_dyn_obj_prop_at(view, scr_dyn_obj_index_of(view, "kind", 4));
  assert(!kind.enumerable && kind.writable && kind.configurable && !kind.accessor);
  ScrDynProp type = scr_dyn_obj_prop_at(view, scr_dyn_obj_index_of(view, "type", 4));
  assert(type.enumerable && type.writable && type.configurable);

  /* The record's snapshot lists every field as an ordinary property; the
   * merge through the kept view hides the key again. */
  ScrDyn *snapshot = scr_dyn_new_obj();
  scr_dyn_obj_set(snapshot, "kind", 4, scr_dyn_new_str(text));
  scr_dyn_obj_set(snapshot, "type", 4, scr_dyn_new_str(text));
  ScrDyn *merged = scr_record_source_apply(snapshot, record);
  assert(merged && merged->kind == SCR_DYN_OBJ && merged->v.obj.len == 2);
  kind = scr_dyn_obj_prop_at(merged, scr_dyn_obj_index_of(merged, "kind", 4));
  assert(!kind.enumerable && kind.writable && kind.configurable);
  assert(kind.value && kind.value->kind == SCR_DYN_STR);
  type = scr_dyn_obj_prop_at(merged, scr_dyn_obj_index_of(merged, "type", 4));
  assert(type.enumerable);
  scr_dyn_release(merged);

  scr_weak_dispose(record);
  assert(!scr_record_source_has(record));
  scr_dyn_release(source);
  scr_dyn_release(plain);
  scr_str_release(text);
}

/* Freezing a record sets the frozen bit beside its count; an immortal
 * record keeps its word, which does not read as frozen. */
static void record_frozen_bit(void) {
  size_t record[2] = {3, 0};
  assert(!scr_rc_frozen(record));
  scr_record_freeze(record);
  assert(scr_rc_frozen(record) && SCR_RC_REFS(record) == 3);
  size_t immortal[2] = {SIZE_MAX, 0};
  scr_record_freeze(immortal);
  assert(immortal[0] == SIZE_MAX && !scr_rc_frozen(immortal));
}

int main(void) {
  json_string_boundaries();
  record_frozen_bit();
  json_indent_ownership();
  scr_init();
  checked_storage();
  shared_property_keys();
  checked_leaf_cycles();
  checked_number_storage();
  buffered_leaf_release();
  json_intact_regions();
  parked_capsules();
  candidate_window_after_deaths();
  json_schema_parse();
  json_schema_special_names();
  json_schema_union_members();
  record_source_class_member();
  copy_prop_modes();
  record_source_get();
  record_source_hidden_key();
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
  weak_entries_held_by_their_values(first);
  weak_collection_freed_by_drain(first);
  scr_dyn_release(first);
  assert(!scr_exc_pending());
  puts("checked storage and weak metadata lifetime checks passed");
  return 0;
}
