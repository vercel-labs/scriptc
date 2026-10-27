#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

/* The slots unit needs scr_trap, scr_exit_frees and the context's exit
 * registration from the rest of the runtime; the exit callback is run
 * here at the end of each thread. */
_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  abort();
}
bool scr_exit_frees(void) { return true; }
static _Thread_local void (*exit_fn)(void);
int scr_context_atexit(void (*fn)(void)) {
  assert(exit_fn == NULL || exit_fn == fn);
  exit_fn = fn;
  return 0;
}

enum { THREADS = 8, KEYS = 5000 };

/* A stand-in for a key object: the count word first, the slot word after. */
typedef struct {
  size_t rc;
  uint32_t word;
} Key;

/* A stand-in for a value: its owner thread and key. */
typedef struct {
  unsigned thread;
  unsigned key;
} Value;

static atomic_size_t released;
static void release(void *v) {
  free(v);
  atomic_fetch_add(&released, 1);
}

static Value *value(unsigned thread, unsigned key) {
  Value *v = malloc(sizeof *v);
  assert(v);
  v->thread = thread;
  v->key = key;
  return v;
}

static Key shared[KEYS];
static _Thread_local ScrSlots states;
static _Thread_local ScrSlots others;

/* Every thread sets its own value for every shared key, in its own order,
 * so threads race to assign each key's index, then reads its values back. */
static void *run(void *arg) {
  unsigned t = (unsigned)(uintptr_t)arg;
  for (unsigned i = 0; i < KEYS; i++) {
    unsigned k = (i * 7919u + t * 104729u) % KEYS;
    scr_slots_set(&states, &shared[k], &shared[k].word, value(t, k), release);
  }
  for (unsigned k = 0; k < KEYS; k++) {
    Value *v = scr_slots_get(&states, &shared[k].word);
    assert(v && v->thread == t && v->key == k);
    assert(scr_slots_get(&others, &shared[k].word) == NULL);
  }
  /* Replacing releases the old value; deleting releases and reports. */
  scr_slots_set(&states, &shared[0], &shared[0].word, value(t, 0), release);
  assert(scr_slots_delete(&states, &shared[1].word));
  assert(!scr_slots_delete(&states, &shared[1].word));
  assert(scr_slots_get(&states, &shared[1].word) == NULL);

  /* Unpublished keys: forget releases a freed key's values in every block
   * of the thread. */
  Key *local = calloc(KEYS, sizeof *local);
  assert(local);
  for (unsigned k = 0; k < KEYS; k++) {
    local[k].rc = 1;
    scr_slots_set(&states, &local[k], &local[k].word, value(t, k), release);
    if (k % 2 == 0) scr_slots_set(&others, &local[k], &local[k].word, value(t, k), release);
  }
  for (unsigned k = 0; k < KEYS; k += 3) scr_slots_forget(local[k].word);
  for (unsigned k = 0; k < KEYS; k++) {
    Value *v = scr_slots_get(&states, &local[k].word);
    assert(k % 3 == 0 ? v == NULL : v != NULL && v->key == k);
    Value *o = scr_slots_get(&others, &local[k].word);
    assert(k % 3 == 0 || k % 2 != 0 ? o == NULL : o != NULL && o->key == k);
  }
  free(local);

  /* Thread exit releases the rest and leaves the blocks empty. */
  assert(exit_fn != NULL);
  exit_fn();
  assert(states.npages == 0 && others.npages == 0);
  assert(scr_slots_get(&states, &shared[2].word) == NULL);
  return NULL;
}

int main(void) {
  for (unsigned k = 0; k < KEYS; k++) shared[k].rc = SIZE_MAX;
  pthread_t threads[THREADS];
  for (unsigned t = 0; t < THREADS; t++)
    assert(pthread_create(&threads[t], NULL, run, (void *)(uintptr_t)t) == 0);
  for (unsigned t = 0; t < THREADS; t++) assert(pthread_join(threads[t], NULL) == 0);
  /* Every key got one index, and every value set was released. */
  for (unsigned k = 0; k < KEYS; k++) assert(shared[k].word != 0);
  size_t sets = THREADS * ((size_t)KEYS + 1 + KEYS + (KEYS + 1) / 2);
  assert(atomic_load(&released) == sets);
  printf("thread slots keep one value per thread and key\n");
  return 0;
}
