/* Number-keyed maps switch between linear, directly indexed and hashed
 * lookup. A randomized run compares every operation with a plain ordered
 * model (SameValueZero, insertion order), and explicit cases pin which
 * index each key shape selects. */
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

int main(void) {
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
