/* Number-keyed maps switch between linear, directly indexed and hashed
 * lookup. A randomized run compares every operation with a plain ordered
 * model (SameValueZero, insertion order), and explicit cases pin which
 * index each key shape selects. Checked-dynamic keys are checked for the
 * one identity each kind of object has (identity_keys). */
#include "scr_runtime.h"
#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MODEL_CAP 20000

typedef struct {
  double key[MODEL_CAP];
  double val[MODEL_CAP];
  size_t n;
} Model;

static bool same_value_zero(double a, double b) {
  return a == b || (a != a && b != b);
}

static long model_find(const Model *m, double k) {
  for (size_t i = 0; i < m->n; i++) if (same_value_zero(m->key[i], k)) return (long)i;
  return -1;
}

static void model_set(Model *m, double k, double v) {
  long i = model_find(m, k);
  if (i >= 0) { m->val[i] = v; return; }
  assert(m->n < MODEL_CAP);
  m->key[m->n] = k == 0 ? 0 : k; /* Map stores +0 for -0 */
  m->val[m->n++] = v;
}

static bool model_delete(Model *m, double k) {
  long i = model_find(m, k);
  if (i < 0) return false;
  memmove(&m->key[i], &m->key[i + 1], (m->n - (size_t)i - 1) * sizeof(double));
  memmove(&m->val[i], &m->val[i + 1], (m->n - (size_t)i - 1) * sizeof(double));
  m->n--;
  return true;
}

static uint64_t state = UINT64_C(0x9e3779b97f4a7c15);
static uint64_t next(void) {
  state ^= state << 13;
  state ^= state >> 7;
  state ^= state << 17;
  return state;
}

static double odd_key(void) {
  static const double odd[] = {-1, 0.5, 1e9, 4294967296.0, -0.0, 3.25, 1e300, -1e-300};
  uint64_t r = next() % 9;
  return r == 8 ? NAN : odd[r];
}

/* Every entry below head is a tombstone, and scr_map_iter_skip answers the
 * first live index at or after each index (the entry count when none is
 * left). */
static void check_skip(ScrMap *map) {
  size_t count = (size_t)scr_map_iter_count(map);
  for (size_t i = 0; i < map->head && i < count; i++) assert(!scr_map_iter_live(map, (double)i));
  double next_live = (double)count;
  for (size_t i = count + 1; i-- > 0;) {
    if (i < count && scr_map_iter_live(map, (double)i)) next_live = (double)i;
    assert(scr_map_iter_skip(map, (double)i) == next_live);
  }
}

static void check_same(const ScrMap *map, const Model *model) {
  check_skip((ScrMap *)map);
  assert((size_t)scr_map_size(map) == model->n);
  size_t j = 0;
  size_t count = (size_t)scr_map_iter_count(map);
  for (size_t i = 0; i < count; i++) {
    if (!scr_map_iter_live(map, (double)i)) continue;
    double k = scr_map_iter_key_f64(map, (double)i);
    assert(j < model->n);
    assert(same_value_zero(k, model->key[j]) && !signbit(k == 0 ? k : 1));
    assert(scr_map_iter_val_f64(map, (double)i) == model->val[j]);
    j++;
  }
  assert(j == model->n);
}

static void probe(const ScrMap *map, const Model *model, double k) {
  long i = model_find(model, k);
  double out = -12345;
  bool found = scr_map_get_f64_f64(map, k, &out);
  assert(found == (i >= 0));
  assert(scr_map_has_f64(map, k) == (i >= 0));
  const ScrMapEntry *entry = scr_map_entry_f64(map, k);
  assert((entry != NULL) == (i >= 0));
  if (i >= 0) {
    assert(out == model->val[i]);
    double v;
    memcpy(&v, &entry->val, sizeof v);
    assert(v == model->val[i]);
  }
}

/* 0: a small dense key set; 1: the same with a rare key that forces
 * hashing; 2: frequent such keys; 3: sparse keys only; 4: a moving dense
 * window that later jumps to sparse keys. */
static double random_key(unsigned flavor, size_t step) {
  uint64_t r = next();
  switch (flavor) {
  case 0: return (double)(r % 60);
  case 1: return r % 20011 == 0 ? odd_key() : (double)(r % 60);
  case 2: return r % 13 == 0 ? odd_key() : (double)(r % 300);
  case 3: return (double)(r % 64) * 1000003.0;
  default: return step < 30000 ? (double)(step / 8 + r % 50) : (double)step * 1000.0 + (double)(r % 50);
  }
}

static void fuzz(unsigned flavor) {
  static Model model;
  model.n = 0;
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  size_t dense_steps = 0, hashed_steps = 0;
  for (size_t step = 0; step < 40000; step++) {
    dense_steps += map->ndense != 0;
    hashed_steps += map->nbuckets != 0;
    uint64_t op = next() % 100;
    double k = random_key(flavor, step);
    if (op < 45) {
      double v = (double)(next() % 100000);
      scr_map_set_f64_f64(map, k, v);
      model_set(&model, k, v);
    } else if (op < 70) {
      assert(scr_map_delete_f64(map, k) == model_delete(&model, k));
    } else if (op < 99) {
      probe(map, &model, k);
      probe(map, &model, odd_key());
    } else if (next() % 20 == 0) {
      scr_map_clear(map);
      model.n = 0;
    }
    if (step % 997 == 0) check_same(map, &model);
  }
  check_same(map, &model);
  /* Each flavor must have exercised the index it targets. */
  if (flavor <= 1 || flavor == 4) assert(dense_steps > 1000);
  if (flavor >= 2) assert(hashed_steps > 1000);
  if (flavor == 0) assert(hashed_steps == 0);
  /* Copies keep order and lookups, and stay independent. */
  ScrMap *copy = scr_map_clone(map, false, NULL);
  check_same(copy, &model);
  for (size_t i = 0; i < 400; i++) probe(copy, &model, (double)i);
  scr_map_set_f64_f64(copy, 7, -1);
  check_same(map, &model);
  scr_map_release(copy);
  scr_map_release(map);
}

/* Removing and re-adding keys during an iteration: indices stay stable and
 * appended keys are visited, as Map.prototype.forEach requires. */
static void iterate_while_mutating(void) {
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (int i = 0; i < 64; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense);
  scr_map_iter_enter(map);
  size_t visited = 0;
  for (size_t i = 0; i < (size_t)scr_map_iter_count(map); i++) {
    if (!scr_map_iter_live(map, (double)i)) continue;
    double k = scr_map_iter_key_f64(map, (double)i);
    visited++;
    if (k < 32) {
      assert(scr_map_delete_f64(map, k));
      scr_map_set_f64_f64(map, k + 64, k);
    }
  }
  scr_map_iter_exit(map);
  assert(visited == 96 && scr_map_size(map) == 64);
  for (int i = 32; i < 96; i++) assert(scr_map_has_f64(map, i));
  for (int i = 0; i < 32; i++) assert(!scr_map_has_f64(map, i));
  scr_map_release(map);
}

static void modes(void) {
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  scr_map_set_f64_f64(map, 1, 1);
  assert(!map->ndense && !map->nbuckets); /* one key: still a linear scan */
  scr_map_set_f64_f64(map, 2, 2);
  assert(map->ndense >= 16 && !map->nbuckets); /* from the second small integer key */
  for (int i = 3; i <= 5; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense >= 16 && !map->nbuckets);
  for (int i = 6; i < 1000; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense >= 1000 && map->ndense <= 1000 + 1000 / 4 + 64); /* near the largest key */
  scr_map_set_f64_f64(map, -0.0, 0); /* slot 0 */
  assert(map->ndense);
  double out;
  assert(scr_map_get_f64_f64(map, -0.0, &out) && out == 0);
  assert(!scr_map_has_f64(map, 0.5) && !scr_map_has_f64(map, NAN) && !scr_map_has_f64(map, -1));
  scr_map_set_f64_f64(map, 0.5, 9); /* a fraction moves to hashing */
  assert(!map->ndense && map->nbuckets);
  assert(scr_map_get_f64_f64(map, 0.5, &out) && out == 9);
  assert(scr_map_get_f64_f64(map, 999, &out) && out == 999);
  scr_map_delete_f64(map, 0.5);
  scr_map_set_f64_f64(map, 1000, 1000);
  assert(!map->ndense); /* hashing until the bucket table must grow */
  for (int i = 1001; i < 3000 && !map->ndense; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense && !map->nbuckets); /* compact integer keys again */
  assert(scr_map_get_f64_f64(map, 1000, &out) && out == 1000 && !scr_map_has_f64(map, 0.5));
  scr_map_release(map);

  /* A key far beyond the live count hashes instead of allocating for it. */
  map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (int i = 0; i < 5; i++) scr_map_set_f64_f64(map, i, i);
  assert(map->ndense);
  scr_map_set_f64_f64(map, 100000, 1);
  assert(!map->ndense);
  scr_map_release(map);

  /* Keys that start far from zero hash until the live count makes a table
   * covering them compact, then switch to it. */
  map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (int i = 0; i < 9; i++) scr_map_set_f64_f64(map, 5000 + i, i);
  assert(!map->ndense && map->nbuckets);
  for (int i = 9; i < 2000; i++) scr_map_set_f64_f64(map, 5000 + i, i);
  assert(map->ndense && !map->nbuckets);
  for (int i = 0; i < 2000; i++) assert(scr_map_get_f64_f64(map, 5000 + i, &out) && out == i);
  assert(!scr_map_has_f64(map, 4999) && !scr_map_has_f64(map, 0));
  scr_map_release(map);

  /* Sparse keys from the start never enter the direct index. */
  map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (int i = 0; i < 10; i++) scr_map_set_f64_f64(map, i * 100000.0, i);
  assert(!map->ndense && map->nbuckets);
  scr_map_release(map);

  /* Sets built from an array use the same index. */
  ScrArr *values = scr_arr_new(SCR_ELEM_F64, 0);
  for (int i = 0; i < 50; i++) scr_arr_push_f64(values, (double)(i % 20));
  ScrMap *set = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  scr_set_add_all(set, values);
  assert(set->ndense && scr_map_size(set) == 20);
  scr_arr_release(values);
  scr_map_release(set);
}

/* Small maps keep compact storage: the entries array grows through 1, 2,
 * 3, 4, 6 and 8 slots, and maps of up to 8 entries keep no bucket table. */
static void small_storage(void) {
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  assert(!map->entries && map->ecap == 0);
  static const uint32_t caps[] = {1, 2, 3, 4, 6, 6, 8, 8};
  for (int i = 1; i <= 8; i++) {
    scr_map_set_f64_f64(map, i * 100000.0, i);
    assert(map->ecap == caps[i - 1]);
  }
  assert(!map->nbuckets && !map->ndense);
  double out;
  for (int i = 1; i <= 8; i++) assert(scr_map_get_f64_f64(map, i * 100000.0, &out) && out == i);
  assert(!scr_map_has_f64(map, 50000) && !scr_map_has_f64(map, 0));
  scr_map_set_f64_f64(map, 900000, 9);
  assert(map->nbuckets && scr_map_size(map) == 9);
  for (int i = 1; i <= 9; i++) assert(scr_map_get_f64_f64(map, i * 100000.0, &out) && out == i);
  scr_map_release(map);
}

/* clear() and delete must cost time proportional to the entries they
 * touch, not to the largest size the map ever had. Each case grows the
 * index tables to about a million slots, then times many small rounds
 * against the same rounds on a fresh map: a clear that resets the whole
 * table (megabytes per call), or iteration over the tombstones of the old
 * peak, is hundreds of times slower and exceeds the bound early. The bound
 * is relative, so machine speed and sanitizers do not matter. */
#define BIG_KEYS (1 << 20)
#define SMALL_ROUNDS 50000

typedef void (*Round)(ScrMap *map, size_t round, void *ctx);

static double cpu_seconds(void) {
  return (double)clock() / CLOCKS_PER_SEC;
}

/* CPU seconds for SMALL_ROUNDS rounds; stops early once over budget. */
static double timed_rounds(ScrMap *map, Round round, void *ctx, double budget) {
  double start = cpu_seconds();
  for (size_t r = 0; r < SMALL_ROUNDS; r++) {
    round(map, r, ctx);
    if (r % 1024 == 1023 && cpu_seconds() - start > budget) break;
  }
  return cpu_seconds() - start;
}

static void expect_proportional(const char *what, ScrMap *fresh, ScrMap *grown, Round round, void *ctx) {
  double base = timed_rounds(fresh, round, ctx, INFINITY);
  double budget = 20 * base + 0.05;
  double spent = timed_rounds(grown, round, ctx, budget);
  if (spent > budget) {
    fprintf(stderr, "%s: cost follows the peak size (%.3f s, fresh map %.3f s)\n", what, spent, base);
    exit(1);
  }
}

/* keys: 0 directly indexed integers, 1 sparse integers (hashed). */
static double cost_key(unsigned keys, size_t i) {
  return keys == 0 ? (double)i : (double)i * 1000003.0;
}

/* clear() an empty map, add up to six keys, clear() again. */
static void number_round(ScrMap *map, size_t round, void *ctx) {
  unsigned keys = *(unsigned *)ctx;
  scr_map_clear(map);
  size_t n = round % 7;
  for (size_t i = 0; i < n; i++) scr_map_set_f64_f64(map, cost_key(keys, round + i), (double)i);
  assert(scr_map_size(map) == (double)n);
  scr_map_clear(map);
}

static void clear_cost_numbers(unsigned keys) {
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (size_t i = 0; i < BIG_KEYS; i++) scr_map_set_f64_f64(map, cost_key(keys, i), (double)i);
  assert(keys == 0 ? map->ndense >= BIG_KEYS : map->nbuckets >= 2 * BIG_KEYS);
  scr_map_clear(map);
  assert(scr_map_size(map) == 0 && scr_map_iter_count(map) == 0 && !scr_map_has_f64(map, cost_key(keys, 1)));
  ScrMap *fresh = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  expect_proportional(keys == 0 ? "dense clear" : "hashed clear", fresh, map, number_round, &keys);
  scr_map_release(fresh);
  /* Storage sized for the old peak is gone; the map is reusable. */
  assert(map->ndense <= 256 && map->nbuckets <= 256 && map->ecap <= 256);
  for (size_t i = 0; i < 100; i++) scr_map_set_f64_f64(map, cost_key(keys, 99 - i), (double)i);
  size_t j = 0;
  for (size_t i = 0; i < (size_t)scr_map_iter_count(map); i++) {
    if (!scr_map_iter_live(map, (double)i)) continue;
    assert(scr_map_iter_key_f64(map, (double)i) == cost_key(keys, 99 - j));
    assert(scr_map_iter_val_f64(map, (double)i) == (double)j);
    j++;
  }
  assert(j == 100 && !scr_map_has_f64(map, cost_key(keys, 100)));
  scr_map_release(map);
}

static ScrStr *key_str(size_t i) {
  char buf[32];
  int len = snprintf(buf, sizeof buf, "k%zu", i);
  return scr_str_new(buf, (size_t)len);
}

enum { STRING_KEYS = 1 << 18 };

static void string_round(ScrMap *map, size_t round, void *ctx) {
  ScrStr **keys = ctx;
  scr_map_clear(map);
  size_t n = round % 7;
  for (size_t i = 0; i < n; i++) scr_map_set_str_f64(map, keys[(round + i) % STRING_KEYS], (double)i);
  assert(scr_map_size(map) == (double)n);
  scr_map_clear(map);
}

static void clear_cost_strings(void) {
  ScrStr **keys = malloc(STRING_KEYS * sizeof *keys);
  assert(keys);
  for (size_t i = 0; i < STRING_KEYS; i++) keys[i] = key_str(i);
  ScrMap *map = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL);
  for (size_t i = 0; i < STRING_KEYS; i++) scr_map_set_str_f64(map, keys[i], (double)i);
  assert(map->nbuckets >= 2 * STRING_KEYS);
  scr_map_clear(map);
  ScrMap *fresh = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL);
  expect_proportional("string clear", fresh, map, string_round, keys);
  scr_map_release(fresh);
  assert(map->nbuckets <= 256 && map->ecap <= 256);
  for (size_t i = 0; i < 10; i++) scr_map_set_str_f64(map, keys[i], (double)i);
  for (size_t i = 0; i < 20; i++) assert(scr_map_has_str(map, keys[i]) == (i < 10));
  scr_map_release(map);
  for (size_t i = 0; i < STRING_KEYS; i++) scr_str_release(keys[i]);
  free(keys);
}

/* Walk the entries the way the forEach desugar does. */
static void iterate_round(ScrMap *map, size_t round, void *ctx) {
  (void)round;
  size_t count = 0;
  for (size_t i = 0; i < (size_t)scr_map_iter_count(map); i++) count += scr_map_iter_live(map, (double)i);
  assert(count == *(size_t *)ctx);
}

/* Deleting almost everything compacts the entries and index tables, so
 * iteration costs O(live), and keys left far apart move back to hashing
 * instead of keeping a huge direct index. */
static void delete_shrinks(void) {
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  ScrMap *fresh = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (size_t i = 0; i < BIG_KEYS; i++) scr_map_set_f64_f64(map, (double)i, (double)i);
  for (size_t i = 0; i + 10 < BIG_KEYS; i++) assert(scr_map_delete_f64(map, (double)i));
  for (size_t i = BIG_KEYS - 10; i < BIG_KEYS; i++) scr_map_set_f64_f64(fresh, (double)i, (double)i);
  assert(scr_map_size(map) == 10);
  size_t live = 10;
  expect_proportional("iteration after deletes", fresh, map, iterate_round, &live);
  assert(scr_map_iter_count(map) <= 4 * 10 + 64);
  assert(!map->ndense); /* ten keys near 2^20: hashed */
  for (size_t i = BIG_KEYS - 10; i < BIG_KEYS; i++) assert(scr_map_has_f64(map, (double)i));
  assert(!scr_map_has_f64(map, 0) && !scr_map_has_f64(map, BIG_KEYS - 11));
  scr_map_release(fresh);
  scr_map_release(map);

  /* Small survivors keep a direct index sized for them. */
  map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (size_t i = 0; i < BIG_KEYS; i++) scr_map_set_f64_f64(map, (double)i, (double)i);
  for (size_t i = BIG_KEYS; i-- > 20;) assert(scr_map_delete_f64(map, (double)i));
  assert(scr_map_size(map) == 20 && map->ndense && map->ndense <= 64);
  for (size_t i = 0; i < 40; i++) assert(scr_map_has_f64(map, (double)i) == (i < 20));
  scr_map_release(map);

  /* A copy indexes its own keys, not the source's peak (here a quarter of
   * the entries survive, too many to compact the source yet). */
  map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (size_t i = 0; i < 4096; i++) scr_map_set_f64_f64(map, (double)i, (double)i);
  for (size_t i = 1024; i < 4096; i++) assert(scr_map_delete_f64(map, (double)i));
  assert(map->ndense >= 4096 && map->ndense <= 4096 + 4096 / 4 + 64);
  assert(scr_map_iter_count(map) == 4096);
  ScrMap *copy = scr_map_clone(map, false, NULL);
  assert(copy->ndense == 1024 && scr_map_size(copy) == 1024);
  double out;
  for (size_t i = 0; i < 1100; i++) {
    assert(scr_map_get_f64_f64(copy, (double)i, &out) == (i < 1024));
    if (i < 1024) assert(out == (double)i);
  }
  scr_map_release(copy);
  scr_map_release(map);
}

/* Grow-and-drain cycles against the ordered model: the map repeatedly
 * grows large and is drained by random deletes, deletes in insertion
 * order, clear, or deletes during an iteration that also appends, so
 * compaction on delete, index shrinking, the move back to hashing and
 * clear's storage release all run under the Map contract. */
static double drain_key(unsigned flavor, size_t cycle, size_t i) {
  switch (flavor) {
  case 0: return (double)(next() % 4000); /* dense */
  case 1: return (double)(cycle * 3000 + i); /* a moving dense window */
  default: return (double)(next() % 64) * 1000003.0 + (double)(next() % 3); /* hashed */
  }
}

static void fuzz_drain(unsigned flavor) {
  static Model model;
  model.n = 0;
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  for (size_t cycle = 0; cycle < 16; cycle++) {
    size_t grow = 1 + next() % 3000;
    for (size_t i = 0; i < grow; i++) {
      double k = drain_key(flavor, cycle, i), v = (double)(next() % 1000);
      scr_map_set_f64_f64(map, k, v);
      model_set(&model, k, v);
    }
    check_same(map, &model);
    size_t keep = next() % 40;
    switch (next() % 4) {
    case 0:
      while (model.n > keep) {
        double k = model.key[next() % model.n];
        assert(scr_map_delete_f64(map, k) && model_delete(&model, k));
      }
      break;
    case 1:
      while (model.n > keep) {
        double k = model.key[0];
        assert(scr_map_delete_f64(map, k) && model_delete(&model, k));
      }
      break;
    case 2:
      scr_map_clear(map);
      model.n = 0;
      if (next() % 2) scr_map_clear(map);
      break;
    default: {
      /* Delete the visited entry with probability 3/4 and sometimes append
       * a fresh key, which the same iteration must still visit. */
      size_t cursor = 0, added = 0;
      scr_map_iter_enter(map);
      for (size_t i = 0; i < (size_t)scr_map_iter_count(map); i++) {
        if (!scr_map_iter_live(map, (double)i)) continue;
        double k = scr_map_iter_key_f64(map, (double)i);
        assert(cursor < model.n && same_value_zero(k, model.key[cursor]));
        if (added < 200 && next() % 8 == 0) {
          double fresh = 1e7 + (double)(cycle * 1000 + added++);
          scr_map_set_f64_f64(map, fresh, 1);
          model_set(&model, fresh, 1);
        }
        if (next() % 4) {
          assert(scr_map_delete_f64(map, k) && model_delete(&model, k));
        } else {
          cursor++;
        }
      }
      assert(cursor == model.n);
      scr_map_iter_exit(map);
      break;
    }
    }
    check_same(map, &model);
    for (size_t i = 0; i < 64; i++) probe(map, &model, drain_key(flavor, cycle, i));
    for (size_t i = 0; i < model.n; i++) probe(map, &model, model.key[i]);
  }
  scr_map_release(map);
}

/* A queue that deletes its oldest entry: each walk from the start finds the
 * first live entry, inside and outside an iteration and after clear(). */
static void front_deletes(void) {
  ScrMap *map = scr_map_new(SCR_MAP_KEY_F64, SCR_MAP_VAL_F64, NULL);
  double oldest = 0, next_key = 0;
  for (int round = 0; round < 3000; round++) {
    for (int j = 0; j < 3; j++) scr_map_set_f64_f64(map, next_key * 7, next_key), next_key++;
    for (int j = 0; j < 2; j++) assert(scr_map_delete_f64(map, oldest * 7)), oldest++;
    double first = scr_map_iter_skip(map, 0);
    assert(scr_map_iter_live(map, first) && scr_map_iter_key_f64(map, first) == oldest * 7);
    if (round % 97 == 0) check_skip(map);
  }
  scr_map_iter_enter(map);
  for (int j = 0; j < 100; j++) assert(scr_map_delete_f64(map, oldest * 7)), oldest++;
  check_skip(map);
  assert(scr_map_iter_key_f64(map, scr_map_iter_skip(map, 0)) == oldest * 7);
  scr_map_clear(map); /* inside the iteration: the entries stay, all dead */
  check_skip(map);
  assert(scr_map_iter_skip(map, 0) == scr_map_iter_count(map));
  scr_map_set_f64_f64(map, -1, 1);
  assert(scr_map_iter_key_f64(map, scr_map_iter_skip(map, 0)) == -1);
  scr_map_iter_exit(map);
  scr_map_clear(map);
  assert(map->head == 0 && scr_map_iter_count(map) == 0 && scr_map_iter_skip(map, 0) == 0);
  scr_map_release(map);

  ScrMap *names = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL);
  char text[32];
  for (int i = 0; i < 500; i++) {
    snprintf(text, sizeof text, "key%d", i);
    ScrStr *key = scr_str_new(text, strlen(text));
    scr_map_set_str_f64(names, key, i);
    scr_str_release(key);
  }
  for (int i = 0; i < 400; i++) {
    snprintf(text, sizeof text, "key%d", i);
    ScrStr *key = scr_str_new(text, strlen(text));
    assert(scr_map_delete_str(names, key));
    scr_str_release(key);
    if (i % 50 == 0) check_skip(names);
  }
  check_skip(names);
  ScrStr *first = scr_map_iter_key_str(names, scr_map_iter_skip(names, 0));
  assert(first->len == 6 && memcmp(first->data, "key400", 6) == 0);
  scr_str_release(first);
  scr_map_release(names);
}

/* ── one identity for each kind of checked-dynamic key ────────────────
 * A checked-dynamic Map or Set (SCR_MAP_KEY_DYN) keys an object by its
 * identity, not by the box that carries it: two boxes of one object are
 * one key, as they are strictly equal. A second object of the kind is
 * another key. Values are keyed by value. This test is the
 * SCR_DYN_PROMISE_KEYS build of scr_map.c, the one a program with promise
 * adapters links. */

#define CHECK(what, cond)                                             \
  do {                                                                \
    if (!(cond)) {                                                    \
      fprintf(stderr, "identity keys: %s: %s\n", (what), #cond);      \
      abort();                                                        \
    }                                                                 \
  } while (0)

/* `a` and `b` are one key and `other` is another, in a table that grows
 * past its first index while it holds them. */
static void one_key(const char *what, ScrDyn *a, ScrDyn *b, ScrDyn *other) {
  ScrMap *m = scr_map_new(SCR_MAP_KEY_DYN, SCR_MAP_VAL_F64, &scr_map_dyn_set_ops);
  double v = 0;
  scr_map_set_ref_f64(m, a, 1);
  CHECK(what, scr_map_has_ref(m, a) && scr_map_has_ref(m, b));
  CHECK(what, scr_map_get_ref_f64(m, b, &v) && v == 1);
  CHECK(what, !scr_map_has_ref(m, other));
  scr_map_set_ref_f64(m, b, 2);
  CHECK(what, scr_map_size(m) == 1);
  scr_map_set_ref_f64(m, other, 3);
  CHECK(what, scr_map_size(m) == 2);
  for (int i = 0; i < 200; i++) {
    ScrDyn *filler = scr_dyn_new_num(1000 + i);
    scr_map_set_ref_f64(m, filler, i);
    scr_dyn_release(filler);
  }
  CHECK(what, scr_map_get_ref_f64(m, a, &v) && v == 2);
  CHECK(what, scr_map_get_ref_f64(m, b, &v) && v == 2);
  CHECK(what, scr_map_get_ref_f64(m, other, &v) && v == 3);
  CHECK(what, scr_map_delete_ref(m, b));
  CHECK(what, !scr_map_has_ref(m, a) && !scr_map_has_ref(m, b) && scr_map_has_ref(m, other));
  CHECK(what, scr_map_size(m) == 201);
  scr_map_release(m);
}

/* Two boxes of one object: strictly equal, one key. */
static void one_object(const char *what, ScrDyn *a, ScrDyn *b, ScrDyn *other) {
  CHECK(what, scr_dyn_strict_eq(a, b) && scr_dyn_strict_eq(b, a));
  CHECK(what, !scr_dyn_strict_eq(a, other) && !scr_dyn_strict_eq(other, b));
  one_key(what, a, b, other);
  one_key(what, b, a, other);
}

/* Two boxes of one value: equal, one key. */
static void one_value(const char *what, ScrDyn *a, ScrDyn *b, ScrDyn *other) {
  CHECK(what, scr_dyn_strict_eq(a, b) && !scr_dyn_strict_eq(a, other));
  one_key(what, a, b, other);
}

/* A native object behind boxes: a record, a class instance, a handle. */
typedef struct {
  size_t rc;
} Source;

static Source *source_new(void) {
  Source *s = malloc(sizeof *s);
  assert(s);
  s->rc = 1;
  return s;
}

static void *source_retain(void *p) {
  ((Source *)p)->rc++;
  return p;
}

static void source_release(void *p) {
  Source *s = p;
  if (--s->rc == 0) free(s);
}

static ScrDyn *source_access(void *p, bool materialize) {
  if (materialize) return scr_dyn_new_obj();
  source_release(p);
  return NULL;
}

static ScrDyn *source_materialize(void *p) {
  (void)p;
  return scr_dyn_new_obj();
}

static ScrDyn *view_of(Source *s) { return scr_dyn_new_obj_with_identity(s, source_retain, source_access); }

static ScrDyn *capsule_of(Source *s, const char *type) {
  return scr_dyn_new_typed_ref(s, source_retain, source_release, type, strlen(type), source_materialize, NULL);
}

static ScrDyn *no_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  (void)args;
  (void)argc;
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *function_of(ScrClosure *clo) {
  return scr_dyn_new_func(scr_closure_retain(clo), no_call, 0, "", "f");
}

void scr_dyn_handle_install(ScrDynHandleTag tag, const ScrDynHandleOps *ops);
static const ScrDynHandleOps source_handle_ops = {.cls = "Source", .retain = source_retain, .release = source_release};

/* A promise as the checked-dynamic core sees one: its count and its
 * identity cell (ScrPromiseHead). An adapter shares its source's cell, as
 * scr_promise_share_identity links them. */
static ScrPromiseHead *promise_new(ScrPromiseHead *source) {
  ScrPromiseHead *p = malloc(sizeof *p);
  assert(p);
  p->rc = 1;
  p->identity = NULL;
  if (source) {
    if (!source->identity) {
      source->identity = malloc(sizeof *source->identity);
      assert(source->identity);
      source->identity->rc = 1;
      source->identity->observed = false;
      source->identity->transferred = false;
    }
    p->identity = source->identity;
    p->identity->rc++;
  }
  return p;
}

static void promise_release(ScrPromise *promise) {
  ScrPromiseHead *p = (ScrPromiseHead *)promise;
  if (--p->rc) return;
  if (p->identity && --p->identity->rc == 0) free(p->identity);
  free(p);
}

/* The promise unit's key identity of a promise (scr_async.c), which this
 * test links without: the cell, made on first use. */
void *scr_promise_map_identity(void *promise) {
  ScrPromiseHead *p = promise;
  if (!p->identity) {
    p->identity = malloc(sizeof *p->identity);
    assert(p->identity);
    p->identity->rc = 1;
    p->identity->observed = false;
    p->identity->transferred = false;
  }
  return p->identity;
}

static bool promise_identity_equal(ScrPromise *a, ScrPromise *b) {
  ScrPromiseHead *x = (ScrPromiseHead *)a, *y = (ScrPromiseHead *)b;
  return x == y || (x->identity != NULL && x->identity == y->identity);
}

extern SCR_TL bool (*scr_dyn_promise_identity_fn)(ScrPromise *a, ScrPromise *b);

static ScrDyn *promise_box(ScrPromiseHead *p) {
  ScrDyn *d = scr_dyn_alloc_promise(promise_release);
  p->rc++;
  d->v.promise = (ScrPromise *)p;
  return d;
}

static void symbol_release(ScrSym *s) { (void)s; }
static ScrStr *symbol_text(ScrSym *s) {
  (void)s;
  return scr_str_new("Symbol()", 8);
}

static void identity_keys(void) {
  /* A plain checked object and array: the box is the object. */
  ScrDyn *object = scr_dyn_new_obj(), *object2 = scr_dyn_new_obj();
  one_object("object", object, object, object2);
  ScrDyn *array = scr_dyn_new_arr(), *array2 = scr_dyn_new_arr();
  one_object("array", array, array, array2);
  one_object("an object against an array", object, object, array);

  /* A typed record: each boxing is another view of it. */
  Source *s1 = source_new(), *s2 = source_new();
  ScrDyn *view1 = view_of(s1), *view1b = view_of(s1), *view2 = view_of(s2);
  CHECK("record view", view1 != view1b);
  one_object("record view", view1, view1b, view2);
  /* A class instance: a capsule at its class and one at its base class,
   * and a view and a capsule of one object. */
  ScrDyn *derived = capsule_of(s1, "object:Derived"), *base = capsule_of(s1, "object:Base");
  ScrDyn *derived2 = capsule_of(s2, "object:Derived");
  CHECK("capsule", derived != base);
  one_object("capsule", derived, base, derived2);
  one_object("a view and a capsule", view1, base, derived2);
  one_object("a capsule and a view", derived, view1b, view2);

  /* A function: each boxing of one closure, and an adapter of it. */
  ScrClosure *clo = scr_closure_new(NULL, 0), *clo2 = scr_closure_new(NULL, 0);
  ScrClosure *adapter = scr_closure_new(NULL, 0);
  scr_closure_adopt_identity(adapter, clo, 0);
  ScrDyn *fn = function_of(clo), *fnb = function_of(clo), *fn_adapter = function_of(adapter);
  ScrDyn *fn2 = function_of(clo2);
  one_object("function", fn, fnb, fn2);
  one_object("function adapter", fn, fn_adapter, fn2);

  /* A typed array: each boxing retains the one view. */
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, 4), *bytes2 = scr_bytes_new(SCR_BYTES_U8, 4);
  ScrDyn *b1 = scr_dyn_new_bytes(bytes), *b1b = scr_dyn_new_bytes(bytes), *b2 = scr_dyn_new_bytes(bytes2);
  CHECK("typed array", b1 != b1b);
  one_object("typed array", b1, b1b, b2);

  /* A native handle: the object under its tag. One address under two tags
   * is two objects. */
  scr_dyn_handle_install(SCR_DYNH_DATE, &source_handle_ops);
  scr_dyn_handle_install(SCR_DYNH_URL, &source_handle_ops);
  ScrDyn *h1 = scr_dyn_new_handle(s1, SCR_DYNH_DATE), *h1b = scr_dyn_new_handle(s1, SCR_DYNH_DATE);
  ScrDyn *h2 = scr_dyn_new_handle(s2, SCR_DYNH_DATE), *h1url = scr_dyn_new_handle(s1, SCR_DYNH_URL);
  CHECK("handle", h1 != h1b);
  one_object("handle", h1, h1b, h2);
  one_object("handle under another tag", h1, h1b, h1url);

  /* A promise: its adapters share its identity cell. A promise that was a
   * key before it had a cell keeps that key once an adapter shares it. */
  scr_dyn_promise_identity_fn = promise_identity_equal;
  ScrPromiseHead *source = promise_new(NULL);
  ScrPromiseHead *adapter1 = promise_new(source), *adapter2 = promise_new(source);
  ScrPromiseHead *another = promise_new(NULL);
  ScrDyn *p1 = promise_box(adapter1), *p2 = promise_box(adapter2), *p_source = promise_box(source);
  ScrDyn *p_other = promise_box(another);
  one_object("promise adapters", p1, p2, p_other);
  one_object("a promise and its adapter", p_source, p2, p_other);
  ScrPromiseHead *late = promise_new(NULL);
  ScrDyn *p_late = promise_box(late);
  ScrMap *keyed = scr_map_new(SCR_MAP_KEY_DYN, SCR_MAP_VAL_F64, &scr_map_dyn_set_ops);
  scr_map_set_ref_f64(keyed, p_late, 1);
  CHECK("promise keyed before its first adapter", late->identity != NULL);
  ScrPromiseHead *late_adapter = promise_new(late);
  ScrDyn *p_late_adapter = promise_box(late_adapter);
  CHECK("promise keyed before its first adapter", scr_map_has_ref(keyed, p_late_adapter));
  CHECK("promise keyed before its first adapter", !scr_map_has_ref(keyed, p_other));
  scr_map_release(keyed);

  /* Different kinds of object never share a key. */
  ScrDyn *kinds[] = {object, array, view1, derived2, fn, b1, h1, h1url, p1, p_other};
  ScrMap *all = scr_map_new(SCR_MAP_KEY_DYN, SCR_MAP_VAL_F64, &scr_map_dyn_set_ops);
  for (size_t i = 0; i < sizeof kinds / sizeof *kinds; i++) scr_map_set_ref_f64(all, kinds[i], (double)i);
  CHECK("every kind", scr_map_size(all) == sizeof kinds / sizeof *kinds);
  for (size_t i = 0; i < sizeof kinds / sizeof *kinds; i++) {
    double v = -1;
    CHECK("every kind", scr_map_get_ref_f64(all, kinds[i], &v) && v == (double)i);
  }
  scr_map_release(all);

  /* Values: equal values are one key, whichever box holds them. */
  ScrDyn *n1 = scr_dyn_new_num(1.5), *n1b = scr_dyn_new_num(3.0 / 2), *n2 = scr_dyn_new_num(2.5);
  one_value("number", n1, n1b, n2);
  ScrDyn *nan1 = scr_dyn_new_num(NAN), *nan2 = scr_dyn_new_num(NAN);
  one_key("NaN", nan1, nan2, n1);
  ScrDyn *zero = scr_dyn_new_num(0.0), *minus_zero = scr_dyn_new_num(-0.0);
  one_key("zero", zero, minus_zero, n1);
  ScrStr *text = scr_str_new("key", 3), *text_b = scr_str_new("key", 3), *text2 = scr_str_new("kex", 3);
  ScrDyn *str1 = scr_dyn_new_str(text), *str1b = scr_dyn_new_str(text_b), *str2 = scr_dyn_new_str(text2);
  one_value("string", str1, str1b, str2);
  ScrBigInt *big = scr_bigint_from_i64(INT64_C(1234567890123456789)), *big_b = scr_bigint_from_i64(INT64_C(1234567890123456789));
  ScrBigInt *big2 = scr_bigint_from_i64(7);
  ScrDyn *bi1 = scr_dyn_new_bigint(big), *bi1b = scr_dyn_new_bigint(big_b), *bi2 = scr_dyn_new_bigint(big2);
  one_value("bigint", bi1, bi1b, bi2);
  ScrDyn *yes = scr_dyn_new_bool(true), *yes_b = scr_dyn_new_bool(true), *no = scr_dyn_new_bool(false);
  one_value("boolean", yes, yes_b, no);
  ScrDyn *null1 = scr_dyn_new_null(), *null2 = scr_dyn_new_null();
  one_value("null", null1, null2, scr_dyn_undefined());
  static int symbol_a, symbol_b;
  ScrDyn *sym1 = scr_dyn_symbol_ref((ScrSym *)&symbol_a, symbol_release, symbol_text, symbol_text);
  ScrDyn *sym1b = scr_dyn_symbol_ref((ScrSym *)&symbol_a, symbol_release, symbol_text, symbol_text);
  ScrDyn *sym2 = scr_dyn_symbol_ref((ScrSym *)&symbol_b, symbol_release, symbol_text, symbol_text);
  one_value("symbol", sym1, sym1b, sym2);

  ScrDyn *boxes[] = {object, object2, array, array2, view1, view1b, view2, derived, base, derived2,
                     fn, fnb, fn_adapter, fn2, b1, b1b, b2, h1, h1b, h2, h1url,
                     p1, p2, p_source, p_other, p_late, p_late_adapter,
                     n1, n1b, n2, nan1, nan2, zero, minus_zero, str1, str1b, str2,
                     bi1, bi1b, bi2, yes, yes_b, no, null1, null2, sym1, sym1b, sym2};
  for (size_t i = 0; i < sizeof boxes / sizeof *boxes; i++) scr_dyn_release(boxes[i]);
  ScrPromiseHead *promises[] = {source, adapter1, adapter2, another, late, late_adapter};
  for (size_t i = 0; i < sizeof promises / sizeof *promises; i++) promise_release((ScrPromise *)promises[i]);
  scr_str_release(text);
  scr_str_release(text_b);
  scr_str_release(text2);
  scr_bigint_release(big);
  scr_bigint_release(big_b);
  scr_bigint_release(big2);
  scr_bytes_release(bytes);
  scr_bytes_release(bytes2);
  scr_closure_release(clo);
  scr_closure_release(clo2);
  scr_closure_release(adapter);
  source_release(s1);
  source_release(s2);
}

int main(void) {
  identity_keys();
  puts("identity keys passed");
  modes();
  small_storage();
  front_deletes();
  iterate_while_mutating();
  for (unsigned flavor = 0; flavor < 5; flavor++) fuzz(flavor);
  clear_cost_numbers(0);
  clear_cost_numbers(1);
  clear_cost_strings();
  delete_shrinks();
  for (unsigned flavor = 0; flavor < 3; flavor++) fuzz_drain(flavor);
  puts("number-key maps passed");
  return 0;
}
