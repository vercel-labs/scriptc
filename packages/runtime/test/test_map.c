/* Unit tests for the map runtime (scr_map.c). Built with ASan +
 * -DSCR_RC_AUDIT by map.test.ts. Prints "N/N cases passed" to stderr.
 *
 * Focus areas the differential corpus cannot reach directly:
 * - SameValueZero exactness at the C level (canonical-NaN hashing, the
 *   stored -0 key normalizing to +0);
 * - RC accounting: string keys/values counted live, overwrite releasing the
 *   old value, delete releasing key+value, clear releasing everything;
 * - tombstone/compaction behavior under churn (entries stay bounded);
 * - live-iteration index stability while iter_depth is held.
 */
#include "../src/scr_runtime.h"
#include "../src/scr_key.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void); /* provided by scr_string.c */
long scr_map_live_count(void); /* provided by scr_map.c */
long scr_arr_live_count(void);
long scr_union_live_count(void);
#endif

static long total = 0, failed = 0;

static void check(bool ok, const char *what) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

static ScrStr *S(const char *s) { return scr_str_new(s, strlen(s)); }

/* Exact-sized allocations leave no readable terminator or tail padding.
 * Exercise the load boundaries at each alignment, including embedded zero
 * bytes and a mismatch at every position. */
static void test_key_bytes(void) {
  for (size_t length = 0; length <= 65; length++) {
    for (size_t offset = 0; offset < 8; offset++) {
      char *allocation = malloc(offset + length + 1);
      char *a = allocation + offset + 1;
      char *b = malloc(length ? length : 1);
      for (size_t i = 0; i < length; i++) a[i] = b[i] = (char)(i * 71);
      uint64_t hash = scr_key_hash(a, length);
      check(hash == scr_key_hash(b, length) && scr_key_equal(a, b, length),
            "unaligned content-equal byte keys agree");
      for (size_t i = 0; i < length; i++) {
        b[i] ^= 1;
        check(!scr_key_equal(a, b, length), "every key byte participates in equality");
        b[i] ^= 1;
      }
      free(b);
      free(allocation);
    }
  }
}

static void test_string_bucket_collisions(void) {
  ScrMap *m = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  ScrStr *keys[12];
  size_t count = 0;
  for (unsigned i = 0; i < 65536 && count < 12; i++) {
    char bytes[9];
    snprintf(bytes, sizeof bytes, "%08x", i);
    if ((scr_key_hash(bytes, 8) & 127) != 0) continue;
    keys[count] = scr_str_new(bytes, 8);
    scr_map_set_str_f64(m, keys[count], (double)count);
    count++;
  }
  check(count == 12 && m->nbuckets == 32, "colliding keys promote to bucket storage");
  scr_map_iter_enter(m);
  for (size_t i = 0; i < count; i += 2) {
    check(scr_map_delete_str(m, keys[i]), "collision chain deletion");
  }
  for (size_t i = 0; i < count; i++) {
    ScrStr *probe = scr_str_new(keys[i]->data, keys[i]->len);
    double out = -1;
    bool found = scr_map_get_str_f64(m, probe, &out);
    check(found == (i % 2 != 0) && (!found || out == (double)i),
          "content probe crosses collision-chain tombstones");
    scr_map_set_str_f64(m, probe, (double)i + 100);
    check(scr_map_has_str(m, probe), "collision-chain overwrite or reinsertion");
    scr_str_release(probe);
    scr_str_release(keys[i]);
  }
  scr_map_iter_exit(m);
  scr_map_clear(m);
  ScrStr *empty = S("");
  check(!scr_map_has_str(m, empty), "cleared bucket table misses without hashing");
  scr_str_release(empty);
  scr_map_release(m);
}

static void test_string_keys(void) {
  ScrMap *m = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  ScrStr *ka = S("alpha");
  ScrStr *kb = S("beta");
  scr_map_set_str_f64(m, ka, 1);
  scr_map_set_str_f64(m, kb, 2);
  check(scr_map_size(m) == 2, "size after two sets");
  scr_map_set_str_f64(m, ka, 10);
  check(scr_map_size(m) == 2, "overwrite keeps size");
  double out = 0;
  check(scr_map_get_str_f64(m, ka, &out) && out == 10, "overwritten value reads back");
  /* content equality: a DIFFERENT ScrStr with the same bytes hits */
  ScrStr *ka2 = S("alpha");
  check(scr_map_has_str(m, ka2), "content-equal key found");
  check(scr_map_delete_str(m, ka2), "delete by content-equal key");
  check(!scr_map_delete_str(m, ka2), "second delete misses");
  check(!scr_map_has_str(m, ka), "deleted key gone");
  scr_str_release(ka2);
  scr_map_clear(m);
  check(scr_map_size(m) == 0 && !scr_map_has_str(m, kb), "clear empties");
  scr_str_release(ka);
  scr_str_release(kb);
  scr_map_release(m);
}

static void test_same_value_zero(void) {
  ScrMap *m = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_BOOL, NULL, NULL, NULL);
  scr_map_set_f64_bool(m, 0.0 / 0.0, true); /* NaN key */
  check(scr_map_has_f64(m, NAN), "NaN finds NaN");
  check(scr_map_has_f64(m, -NAN), "any NaN bit pattern finds NaN");
  check(scr_map_size(m) == 1, "one NaN entry");
  scr_map_set_f64_bool(m, -0.0, true);
  check(scr_map_has_f64(m, 0.0), "-0 and +0 are one key");
  /* the STORED key normalized to +0 (JS: [...m.keys()] shows 0) */
  double k1 = scr_map_iter_key_f64(m, 1);
  check(k1 == 0.0 && !signbit(k1), "stored -0 key normalized to +0");
  scr_map_set_f64_bool(m, 0.0, false);
  check(scr_map_size(m) == 2, "set(+0) overwrote the -0 entry");
  bool b = true;
  check(scr_map_get_f64_bool(m, -0.0, &b) && !b, "get(-0) reads the +0 entry");
  check(scr_map_delete_f64(m, 0.0 / 0.0), "delete by NaN");
  check(scr_map_size(m) == 1, "NaN entry deleted");
  scr_map_release(m);
}

#ifdef SCR_RC_AUDIT
static void test_rc_accounting(void) {
  long strings0 = scr_str_live_count();
  long maps0 = scr_map_live_count();
  ScrMap *m = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_REF,
                           scr_str_retain_v, scr_str_release_v, NULL);
  check(scr_map_live_count() == maps0 + 1, "map counted live");
  ScrStr *k = S("key");
  scr_map_set_str_ref(m, k, S("v1")); /* value +1 moves in; key retained */
  scr_str_release(k);                 /* map keeps its own key reference */
  check(scr_str_live_count() == strings0 + 2, "key + value live");
  k = S("key");
  ScrStr *v2 = S("v2");
  scr_map_set_str_ref(m, k, scr_str_retain(v2)); /* replaces AND releases v1 */
  check(scr_str_live_count() == strings0 + 3, "overwrite released the old value");
  ScrStr *got = scr_map_get_str_ref(m, k);
  check(got != NULL && scr_str_eq(got, v2), "get returns the new value");
  scr_str_release(got);
  scr_str_release(v2);
  check(scr_map_delete_str(m, k), "delete");
  scr_str_release(k);
  check(scr_str_live_count() == strings0, "delete released key and value");
  k = S("a");
  scr_map_set_str_ref(m, k, S("1"));
  scr_str_release(k);
  k = S("b");
  scr_map_set_str_ref(m, k, S("2"));
  scr_str_release(k);
  scr_map_release(m); /* releasing the map releases every entry */
  check(scr_str_live_count() == strings0, "map release freed all entries");
  check(scr_map_live_count() == maps0, "map freed");
}
#endif

static void test_churn_stays_bounded(void) {
  ScrMap *m = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  for (int i = 0; i < 100000; i++) {
    double k = (double)(i % 13);
    scr_map_set_f64_f64(m, k, i);
    if (i % 2) scr_map_delete_f64(m, k);
  }
  check(scr_map_size(m) <= 13, "churn size bounded");
  /* compaction on growth keeps the dense array proportional to the live
   * set, not to the 100k total insertions */
  check(m->nentries <= 64, "tombstones compacted under churn");
  scr_map_release(m);
}

static void test_live_iteration_indices(void) {
  ScrMap *m = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  for (int i = 0; i < 4; i++) scr_map_set_f64_f64(m, i, i * 10);
  scr_map_iter_enter(m);
  int visited = 0;
  double sum = 0;
  for (double i = 0; i < scr_map_iter_count(m); i += 1) {
    if (!scr_map_iter_live(m, i)) continue;
    visited++;
    sum += scr_map_iter_val_f64(m, i);
    if (i == 0) {
      scr_map_delete_f64(m, 2);        /* pending: skipped */
      scr_map_set_f64_f64(m, 99, 990); /* appended: visited */
      /* force growth while iterating: indices must stay stable */
      for (int g = 0; g < 50; g++) scr_map_set_f64_f64(m, 1000 + g, 0);
    }
  }
  scr_map_iter_exit(m);
  check(visited == 4 + 50, "adds visited, delete skipped, indices stable");
  check(sum == 0 + 10 + 30 + 990, "values read at stable indices");
  /* clear during iteration keeps indices; adds after it are visited */
  scr_map_iter_enter(m);
  int seen = 0;
  for (double i = 0; i < scr_map_iter_count(m); i += 1) {
    if (!scr_map_iter_live(m, i)) continue;
    seen++;
    if (seen == 1) {
      scr_map_clear(m);
      scr_map_set_f64_f64(m, 7, 7);
    }
  }
  scr_map_iter_exit(m);
  check(seen == 2, "clear stops the walk; the post-clear add is visited");
  check(scr_map_size(m) == 1, "one live entry after clear+add");
  scr_map_release(m);
}

static void test_small_storage_transitions(void) {
  ScrMap *m = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  for (int i = 0; i < 4; i++) scr_map_set_f64_f64(m, i, i + 10);
  check(m->nbuckets == 0 && m->buckets == NULL, "small map has no bucket allocation");
  for (int i = 0; i < 100; i++) {
    scr_map_delete_f64(m, 3);
    scr_map_set_f64_f64(m, 3, i);
  }
  check(m->nbuckets == 0 && m->nentries == 4, "small churn compacts without buckets");
  ScrMap *copy = scr_map_clone(m, false);
  check(copy->nbuckets == 0, "small clone preserves compact storage");
  scr_map_iter_enter(m);
  scr_map_delete_f64(m, 1);
  scr_map_set_f64_f64(m, 4, 14);
  check(m->nbuckets > 0, "live iteration promotes without moving entry indices");
  check(!scr_map_iter_live(m, 1) && scr_map_iter_key_f64(m, 4) == 4,
        "promotion preserves tombstones and append position");
  for (int i = 5; i < 64; i++) scr_map_set_f64_f64(m, i, i + 10);
  double out = 0;
  check(scr_map_get_f64_f64(m, 0, &out) && out == 10, "original key survives promotion and growth");
  check(!scr_map_has_f64(m, 1), "deleted small key stays absent after rehash");
  scr_map_iter_exit(m);
  check(scr_map_has_f64(copy, 1) && !scr_map_has_f64(copy, 4), "small clone remains independent");
  scr_map_clear(copy);
  scr_map_iter_enter(copy);
  for (int i = 0; i < 6; i++) {
    scr_map_clear(copy);
    scr_map_set_f64_f64(copy, i, i);
  }
  check(copy->nbuckets > 0 && copy->nentries == 6 && copy->nlive == 1,
        "clear and append preserve active small iterator positions");
  scr_map_iter_exit(copy);
  check(scr_map_has_f64(copy, 5), "post-clear entry survives iterator compaction");
  scr_map_release(copy);
  scr_map_release(m);
}

static void test_identity_key_ownership(void) {
  ScrArr *a = scr_arr_new(SCR_ELEM_F64, 0);
  ScrArr *b = scr_arr_new(SCR_ELEM_F64, 0);
  ScrMap *m = scr_map_new_typed(SCR_MAP_KEY_REF, SCR_MAP_VAL_REF,
      scr_arr_retain_v, scr_arr_release_v, NULL,
      scr_str_retain_v, scr_str_release_v, NULL);
  scr_map_set_ref_ref(m, a, S("first"));
  scr_map_set_ref_ref(m, b, S("second"));
  check(a->rc == 2 && b->rc == 2, "identity keys retained on insertion");
  check(scr_map_size(m) == 2, "structurally equal arrays remain distinct keys");
  scr_arr_push_f64(a, 42);
  ScrStr *value = scr_map_get_ref_ref(m, a);
  check(value && value->len == 5, "mutation does not change reference hash");
  scr_str_release(value);
  scr_map_set_ref_ref(m, a, S("replacement"));
  check(a->rc == 2, "overwrite does not retain the existing key twice");
  void *key = scr_map_iter_key_ref(m, 0);
  check(key == a && a->rc == 3, "iteration returns the original key with ownership");
  scr_arr_release(key);
  ScrArr *absent = scr_arr_new(SCR_ELEM_F64, 0);
  check(scr_map_get_ref_ref(m, absent) == NULL, "missing reference value returns NULL");
  check(!scr_map_delete_ref(m, absent), "missing identity delete has no effect");
  check(scr_map_delete_ref(m, a) && a->rc == 1, "delete releases its key immediately");
  scr_map_clear(m);
  check(b->rc == 1 && scr_map_size(m) == 0, "clear releases remaining reference keys");
  scr_arr_release(a);
  scr_arr_release(b);
  scr_arr_release(absent);
  scr_map_release(m);
}

static void test_identity_scalar_values(void) {
  ScrArr *key = scr_arr_new(SCR_ELEM_F64, 0);
  ScrArr *other = scr_arr_new(SCR_ELEM_F64, 0);
  ScrMap *numbers = scr_map_new_typed(SCR_MAP_KEY_REF, SCR_MAP_VAL_F64,
      scr_arr_retain_v, scr_arr_release_v, NULL, NULL, NULL, NULL);
  ScrMap *flags = scr_map_new_typed(SCR_MAP_KEY_REF, SCR_MAP_VAL_BOOL,
      scr_arr_retain_v, scr_arr_release_v, NULL, NULL, NULL, NULL);
  double number = 99;
  bool flag = true;
  check(!scr_map_get_ref_f64(numbers, key, &number) && number == 99, "numeric miss preserves out parameter");
  check(!scr_map_get_ref_bool(flags, key, &flag) && flag, "boolean miss preserves out parameter");
  scr_map_set_ref_f64(numbers, key, -0.0);
  check(scr_map_get_ref_f64(numbers, key, &number) && signbit(number), "reference-key numeric values preserve negative zero");
  scr_map_set_ref_bool(flags, key, false);
  check(scr_map_get_ref_bool(flags, key, &flag) && !flag, "false is present, not a missing entry");
  scr_map_set_ref_bool(flags, key, true);
  check(scr_map_get_ref_bool(flags, key, &flag) && flag, "boolean overwrite");
  check(!scr_map_has_ref(numbers, other), "equal-content reference misses");
  scr_map_release(numbers);
  scr_map_release(flags);
  check(key->rc == 1, "all scalar-valued maps release their keys");
  scr_arr_release(key);
  scr_arr_release(other);
}

static ScrUnion *wrap_key(uint32_t tag, ScrArr *key, ScrTraceFn trace) {
  return scr_union_new_ref(tag, scr_arr_retain(key), scr_arr_retain_v, scr_arr_release_v, trace);
}

static void test_reboxed_keys_and_rehash(void) {
  ScrMap *m = scr_map_new_typed(SCR_MAP_KEY_UNION_REF, SCR_MAP_VAL_F64,
      scr_union_retain_v, scr_union_release_v, NULL, NULL, NULL, NULL);
  ScrArr *keys[128];
  for (int i = 0; i < 128; i++) {
    keys[i] = scr_arr_new(SCR_ELEM_F64, 0);
    ScrUnion *box = wrap_key((uint32_t)(i % 3), keys[i], NULL);
    scr_map_set_ref_f64(m, box, i);
    scr_union_release(box);
  }
  check(scr_map_size(m) == 128, "union-key growth keeps all entries");
  for (int i = 0; i < 128; i++) {
    /* Tags and wrapper allocations are representation details. */
    ScrUnion *probe = wrap_key(999, keys[i], NULL);
    double value = -1;
    check(scr_map_get_ref_f64(m, probe, &value) && value == i, "rehash uses payload identity");
    if (i % 2 == 0) check(scr_map_delete_ref(m, probe), "delete through a fresh union wrapper");
    scr_union_release(probe);
  }
  for (int i = 0; i < 128; i += 2) {
    ScrUnion *box = wrap_key(7, keys[i], NULL);
    scr_map_set_ref_f64(m, box, -i);
    scr_union_release(box);
  }
  ScrUnion *first = scr_map_iter_key_ref(m, 0);
  check(scr_union_peek(first) == keys[1], "reinserted union keys follow surviving insertion order");
  scr_union_release(first);
  ScrUnion *probe = wrap_key(55, keys[1], NULL);
  ScrUnion *original = scr_map_iter_key_ref(m, 0);
  scr_map_set_ref_f64(m, probe, 700);
  ScrUnion *stored = scr_map_iter_key_ref(m, 0);
  check(stored == original && stored != probe, "overwrite keeps the first stored key representation");
  scr_union_release(stored);
  scr_union_release(original);
  scr_union_release(probe);
  scr_map_clear(m);
  for (int i = 0; i < 128; i++) {
    check(keys[i]->rc == 1, "clear releases each stored box and its payload");
    scr_arr_release(keys[i]);
  }
  scr_map_release(m);
}

static void test_value_keys_and_copies(void) {
  static const uint8_t kinds[] = { SCR_MAP_KEY_F64, SCR_MAP_KEY_BOOL, SCR_MAP_KEY_REF, SCR_MAP_KEY_REF };
  ScrMap *m = scr_map_new_typed(SCR_MAP_KEY_UNION_VALUE, SCR_MAP_VAL_F64,
    scr_union_retain_v, scr_union_release_v, NULL, NULL, NULL, NULL);
  scr_map_union_keys(m, kinds);
  ScrUnion *negative_zero = scr_union_new_f64(0, -0.0);
  ScrUnion *zero = scr_union_new_f64(0, 0.0);
  ScrUnion *flag = scr_union_new_bool(1, false);
  scr_map_set_ref_f64(m, negative_zero, 10);
  scr_map_set_ref_f64(m, flag, 20);
  check(m->entries[0].hash == 1 && m->entries[1].hash == 1, "zero hashes remap without conflating key kinds");
  check(signbit(scr_union_get_f64(negative_zero)), "normalization leaves caller's union unchanged");
  ScrUnion *stored = scr_map_iter_key_ref(m, 0);
  check(!signbit(scr_union_get_f64(stored)), "stored numeric union has positive zero");
  scr_union_release(stored);
  double out = 0;
  check(scr_map_get_ref_f64(m, zero, &out) && out == 10, "value-equal union probe finds zero");
  check(scr_map_get_ref_f64(m, flag, &out) && out == 20, "same full hash still checks primitive kind");
  ScrArr *key = scr_arr_new(SCR_ELEM_F64, 0);
  ScrUnion *left = wrap_key(2, key, NULL), *right = wrap_key(3, key, NULL);
  scr_map_set_ref_f64(m, left, 30);
  check(scr_map_has_ref(m, right), "reference identity survives different union arm tags");
  scr_map_delete_ref(m, flag);
  ScrMap *copy = scr_map_clone(m, false);
  ScrMap *keys = scr_map_clone(m, true);
  check(copy->nentries == 2 && copy->nlive == 2 && copy->ecap == 2, "copy allocates only live entries");
  check(keys->nentries == 2 && keys->val_kind == SCR_MAP_VAL_F64, "key copy keeps compact Set storage");
  scr_map_clear(m);
  check(scr_map_get_ref_f64(copy, right, &out) && out == 30, "copy owns the original reference key");
  scr_map_set_ref_f64(copy, flag, 40);
  check(!scr_map_has_ref(keys, flag), "copy insertion leaves its sibling independent");
  scr_union_release(negative_zero); scr_union_release(zero); scr_union_release(flag);
  scr_union_release(left); scr_union_release(right);
  scr_map_release(m); scr_map_release(copy); scr_map_release(keys);
  check(key->rc == 1, "all copied union key owners released");
  scr_arr_release(key);

  ScrStr *decimal = S("18446744073709551616"), *hex = S("0x10000000000000000");
  ScrBigInt *a = scr_bigint_parse(decimal), *b = scr_bigint_parse(hex);
  scr_str_release(decimal); scr_str_release(hex);
  check(scr_bigint_eq(a, b) && scr_bigint_hash(a) == scr_bigint_hash(b), "equal parsed bigint values hash alike");
  ScrMap *big = scr_map_new_typed(SCR_MAP_KEY_BIGINT, SCR_MAP_VAL_F64,
    scr_bigint_retain_v, scr_bigint_release_v, NULL, NULL, NULL, NULL);
  scr_map_set_ref_f64(big, a, 1);
  scr_map_set_ref_f64(big, b, 2);
  scr_bigint_release(a);
  check(big->nlive == 1 && scr_map_get_ref_f64(big, b, &out) && out == 2, "bigint keys compare values across owners");
  scr_bigint_release(b);
  scr_map_release(big);
}

#ifdef SCR_RC_AUDIT
static void test_identity_cycles(void) {
  scr_collect_cycles();
  long maps = scr_map_live_count();
  long arrays = scr_arr_live_count();
  long strings = scr_str_live_count();
  long unions = scr_union_live_count();
  for (int mode = 0; mode < 5; mode++) {
    for (int i = 0; i < 100; i++) {
      ScrArr *key = scr_arr_new_ref(scr_map_retain_v, scr_map_release_v, scr_map_trace_v, 0);
      bool wrapped = mode >= 3;
      ScrMapValKind value_kind = mode == 0 ? SCR_MAP_VAL_F64 : SCR_MAP_VAL_REF;
      ScrTraceFn value_trace = mode == 2 ? scr_arr_trace_v : NULL;
      ScrMap *m = scr_map_new_typed(mode == 4 ? SCR_MAP_KEY_UNION_VALUE : wrapped ? SCR_MAP_KEY_UNION_REF : SCR_MAP_KEY_REF, value_kind,
          wrapped ? scr_union_retain_v : scr_arr_retain_v,
          wrapped ? scr_union_release_v : scr_arr_release_v,
          wrapped ? scr_union_trace_v : scr_arr_trace_v,
          mode == 2 ? scr_arr_retain_v : scr_str_retain_v,
          mode == 2 ? scr_arr_release_v : scr_str_release_v, value_trace);
      static const uint8_t union_kinds[] = { SCR_MAP_KEY_REF };
      if (mode == 4) scr_map_union_keys(m, union_kinds);
      ScrUnion *box = wrapped ? wrap_key(0, key, scr_arr_trace_v) : NULL;
      void *stored_key = wrapped ? (void *)box : (void *)key;
      if (mode == 0) scr_map_set_ref_f64(m, stored_key, i);
      else if (mode == 2) scr_map_set_ref_ref(m, stored_key, scr_arr_retain(key));
      else scr_map_set_ref_ref(m, stored_key, S("untraced value must be freed"));
      scr_arr_push_ref(key, scr_map_retain(m));
      if (box) scr_union_release(box);
      scr_arr_release(key);
      scr_map_release(m);
    }
    scr_collect_cycles();
    check(scr_map_live_count() == maps, "key-cycle maps collected");
    check(scr_arr_live_count() == arrays, "key-cycle payload arrays collected");
    check(scr_str_live_count() == strings, "collector releases untraced values beside traced keys");
    check(scr_union_live_count() == unions, "key-cycle union wrappers collected");
  }
}
#endif

int main(void) {
  test_key_bytes();
  test_string_bucket_collisions();
  test_string_keys();
  test_same_value_zero();
#ifdef SCR_RC_AUDIT
  test_rc_accounting();
#endif
  test_churn_stays_bounded();
  test_live_iteration_indices();
  test_small_storage_transitions();
  test_identity_key_ownership();
  test_identity_scalar_values();
  test_reboxed_keys_and_rehash();
  test_value_keys_and_copies();
#ifdef SCR_RC_AUDIT
  test_identity_cycles();
  scr_collect_cycles();
  check(scr_map_live_count() == 0, "all maps reclaimed");
  check(scr_arr_live_count() == 0, "all key arrays reclaimed");
  check(scr_str_live_count() == 0, "all owned strings reclaimed");
  check(scr_union_live_count() == 0, "all key wrappers reclaimed");
#endif

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
