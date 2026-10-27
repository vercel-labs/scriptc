#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The table unit needs only scr_trap, scr_throw_error_msg and
 * scr_sa_thread_shares from the rest of the runtime; refusals and the
 * inserting threads' shares are recorded here. */
_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  abort();
}

/* Inserts share the stored values with every thread. */
static atomic_int shares;
void scr_sa_thread_shares(void) { atomic_fetch_add(&shares, 1); }

static char refused[128];
void scr_throw_error_msg(int kind, const char *msg, size_t len) {
  assert(kind == SCR_ERR_TYPE && len < sizeof refused);
  memcpy(refused, msg, len);
  refused[len] = 0;
}

enum { THREADS = 8, KEYS = 20000, ROUNDS = 3 };

/* A stand-in for a published value: written by its creator before the
 * insert, read by every thread that finds it. */
typedef struct {
  uint64_t key;
  unsigned creator;
} Value;

static ScrStr *make_str(const char *text) {
  size_t len = strlen(text);
  ScrStr *s = calloc(1, sizeof(ScrStr) + len + 1);
  assert(s);
  s->rc = 1;
  s->len = len;
  s->cap = len;
  memcpy(s->data, text, len + 1);
  return s;
}

static ScrArr *make_f64s(const double *values, size_t n) {
  ScrArr *a = calloc(1, sizeof(ScrArr));
  assert(a);
  a->rc = 1;
  a->len = a->cap = n;
  a->filled = (uint32_t)n;
  a->elem = SCR_ELEM_F64;
  /* Values, then one state byte per slot (scr_arr_states_end). */
  a->spare = SCR_ARR_STATES;
  a->data = calloc(n ? n : 1, sizeof(uint64_t) + 1);
  for (size_t i = 0; i < n; i++) memcpy(&a->data[i], &values[i], sizeof(double));
  memset(scr_arr_state_run(a, 0, n), SCR_ARR_VALUE, n);
  return a;
}

static ScrArr *make_strs(ScrStr *const *values, size_t n) {
  ScrArr *a = make_f64s(NULL, 0);
  a->len = a->cap = n;
  a->filled = (uint32_t)n;
  a->elem = SCR_ELEM_STR;
  free(a->data);
  a->data = calloc(n ? n : 1, sizeof(uint64_t) + 1);
  for (size_t i = 0; i < n; i++) a->data[i] = (uint64_t)(uintptr_t)values[i];
  memset(scr_arr_state_run(a, 0, n), SCR_ARR_VALUE, n);
  return a;
}

static void key_text(char *out, size_t size, uint64_t k) { snprintf(out, size, "key-%llu", (unsigned long long)k); }

static ScrITable *strings, *numbers;
static const ScrITableEntry *seen_str[THREADS][KEYS];
static atomic_uint ready;

static void check_value(const ScrITableEntry *e, uint64_t k) {
  const Value *v = (const Value *)(uintptr_t)e->value;
  assert(v->key == k && v->creator < THREADS);
}

static void *run(void *arg) {
  unsigned id = (unsigned)(uintptr_t)arg;
  atomic_fetch_add_explicit(&ready, 1, memory_order_acq_rel);
  while (atomic_load_explicit(&ready, memory_order_acquire) != THREADS) sched_yield();
  char text[32];
  for (unsigned round = 0; round < ROUNDS; round++) {
    /* Every thread visits every key, from a different starting point, so
     * each key is inserted by racing threads while others look it up. */
    for (unsigned n = 0; n < KEYS; n++) {
      uint64_t k = (n * 7919u + id * (KEYS / THREADS) + round * 31u) % KEYS;
      key_text(text, sizeof text, k);
      ScrStr *key = make_str(text);
      const ScrITableEntry *e = scr_itable_find_str(strings, key);
      if (!e) {
        Value *v = malloc(sizeof *v);
        assert(v);
        v->key = k;
        v->creator = id;
        e = scr_itable_insert_str(strings, key, (uint64_t)(uintptr_t)v);
        if ((const Value *)(uintptr_t)e->value != v) free(v); /* lost the race */
      }
      check_value(e, k);
      assert(seen_str[id][k] == NULL || seen_str[id][k] == e);
      seen_str[id][k] = e;
      free(key);

      double dk = (double)k - KEYS / 2;
      const ScrITableEntry *f = scr_itable_find_f64(numbers, dk);
      if (!f) f = scr_itable_insert_f64(numbers, dk, (uint64_t)k * 3);
      /* Number entries live in the index, so a grown index answers a new
       * handle with the same value. */
      assert(f->value == k * 3);
      /* A lookup of a key no thread inserts misses. */
      assert(!scr_itable_find_f64(numbers, (double)KEYS + 0.5 + n));
    }
  }
  scr_itable_thread_exit();
  return NULL;
}

int main(void) {
  ScrStr *name = make_str("strings");
  strings = scr_itable_open(name, SCR_ITABLE_KEY_STR);
  assert(scr_itable_open(name, SCR_ITABLE_KEY_STR) == strings);
  ScrStr *other = make_str("numbers");
  numbers = scr_itable_open(other, SCR_ITABLE_KEY_F64);
  assert(numbers != strings);

  /* Number keys use SameValueZero; the first insertion wins. */
  ScrStr *zeros_name = make_str("zeros"), *texts_name = make_str("texts");
  ScrITable *zeros = scr_itable_open(zeros_name, SCR_ITABLE_KEY_F64);
  assert(scr_itable_insert_f64(zeros, -0.0, 1) == scr_itable_insert_f64(zeros, 0.0, 2));
  assert(scr_itable_find_f64(zeros, 0.0)->value == 1);
  assert(scr_itable_insert_f64(zeros, 0.0 / 0.0, 3) == scr_itable_find_f64(zeros, -(0.0 / 0.0)));
  assert(scr_itable_size(zeros) == 2);
  ScrStr *empty = make_str("");
  ScrITable *texts = scr_itable_open(texts_name, SCR_ITABLE_KEY_STR);
  assert(!scr_itable_find_str(texts, empty));
  const ScrITableEntry *e = scr_itable_insert_str(texts, empty, 9);
  assert(scr_itable_find_str(texts, empty) == e && e->value == 9);
  assert(scr_itable_insert_str(texts, empty, 10) == e && e->value == 9);
  free(empty);
  free(texts_name);
  free(zeros_name);
  free(other);
  free(name);

  /* Array keys compare by their elements: numbers by SameValueZero,
   * strings by content, holes like undefined elements. */
  ScrStr *lists_name = make_str("lists"), *paths_name = make_str("paths");
  ScrITable *lists = scr_itable_open(lists_name, SCR_ITABLE_KEY_F64S);
  ScrArr *one = make_f64s((double[]){1, -0.0, 0.0 / 0.0}, 3);
  ScrArr *same = make_f64s((double[]){1, 0.0, -(0.0 / 0.0)}, 3);
  ScrArr *shorter = make_f64s((double[]){1, 0.0}, 2);
  ScrArr *holed = make_f64s((double[]){1, 0.0, 0.0}, 3);
  holed->filled = 1;
  *scr_arr_state_ptr(holed, 2) = SCR_ARR_HOLE;
  ScrArr *empty_list = make_f64s(NULL, 0);
  const ScrITableEntry *l1 = scr_itable_insert_arr(lists, one, 1);
  assert(scr_itable_find_arr(lists, same) == l1 && scr_itable_insert_arr(lists, same, 2) == l1);
  assert(!scr_itable_find_arr(lists, shorter) && !scr_itable_find_arr(lists, holed));
  assert(scr_itable_insert_arr(lists, holed, 3)->value == 3 && scr_itable_insert_arr(lists, shorter, 4)->value == 4);
  assert(scr_itable_insert_arr(lists, empty_list, 5)->value == 5 && scr_itable_find_arr(lists, empty_list)->value == 5);
  assert(scr_itable_size(lists) == 4);
  ScrArr *big = make_f64s(NULL, 0);
  big->len = big->cap = big->filled = 100;
  big->spare = 0; /* values without states */
  free(big->data);
  big->data = calloc(100, sizeof(uint64_t));
  for (unsigned i = 0; i < 100; i++) memcpy(&big->data[i], &(double){i}, sizeof(double));
  assert(scr_itable_insert_arr(lists, big, 6)->value == 6 && scr_itable_find_arr(lists, big)->value == 6);
  /* Keys of more than 65536 elements are refused before anything is read,
   * however long their sparse length. */
  ScrArr *longest = make_f64s(NULL, 0);
  longest->len = 65536;
  assert(scr_itable_insert_arr(lists, longest, 7)->value == 7 && !refused[0]);
  ScrArr *huge = make_f64s(NULL, 0);
  huge->len = (size_t)1 << 29;
  assert(!scr_itable_find_arr(lists, huge) && !strcmp(refused, "InternTable array keys can have at most 65536 elements"));
  refused[0] = 0;
  longest->len = 65537;
  assert(!scr_itable_insert_arr(lists, longest, 8) && refused[0]);
  refused[0] = 0;
  assert(scr_itable_size(lists) == 6);
  ScrITable *paths = scr_itable_open(paths_name, SCR_ITABLE_KEY_STRS);
  ScrStr *ab = make_str("ab"), *c = make_str("c"), *a = make_str("a"), *bc = make_str("bc");
  ScrArr *p1 = make_strs((ScrStr *[]){ab, c}, 2), *p2 = make_strs((ScrStr *[]){a, bc}, 2);
  ScrArr *p3 = make_strs((ScrStr *[]){ab, c}, 2);
  const ScrITableEntry *e1 = scr_itable_insert_arr(paths, p1, 7);
  assert(scr_itable_insert_arr(paths, p2, 8) != e1 && scr_itable_find_arr(paths, p3) == e1);
  assert(scr_itable_size(paths) == 2);
  /* String keys whose encoding exceeds 2^31 - 1 bytes are refused. */
  ScrStr *wide = calloc(1, sizeof(ScrStr) + 1);
  assert(wide);
  wide->rc = 1;
  wide->len = (size_t)0x7fffffff - 2;
  ScrArr *heavy = make_strs((ScrStr *[]){wide, wide}, 2);
  assert(!scr_itable_find_arr(paths, heavy) &&
         !strcmp(refused, "InternTable array keys can encode at most 2147483647 bytes"));
  refused[0] = 0;
  free(wide);
  ScrArr *arrays[] = {one, same, shorter, holed, empty_list, big, longest, huge, p1, p2, p3, heavy};
  for (unsigned i = 0; i < sizeof arrays / sizeof *arrays; i++) {
    free(arrays[i]->data);
    free(arrays[i]);
  }
  free(ab);
  free(c);
  free(a);
  free(bc);
  free(lists_name);
  free(paths_name);

  pthread_t threads[THREADS];
  for (unsigned i = 0; i < THREADS; i++)
    assert(pthread_create(&threads[i], NULL, run, (void *)(uintptr_t)i) == 0);
  for (unsigned i = 0; i < THREADS; i++) assert(pthread_join(threads[i], NULL) == 0);

  /* Every thread received the same string entry for every key. */
  for (unsigned k = 0; k < KEYS; k++)
    for (unsigned i = 1; i < THREADS; i++) assert(seen_str[i][k] == seen_str[0][k]);
  assert(scr_itable_size(strings) == KEYS);
  assert(scr_itable_size(numbers) == KEYS);
  assert(atomic_load(&shares) >= 2 * KEYS);
  printf("intern tables share one entry per key across racing inserts and lookups\n");
  return 0;
}
