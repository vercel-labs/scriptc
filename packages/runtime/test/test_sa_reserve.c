/* The worker allocator's reservation under a limited address space. With
 * RLIMIT_AS at 60 GiB, too little for 32 arenas of 1 GiB class slices, the
 * region holds 4 arenas of 256 MiB slices rather than 32 arenas of 16 MiB
 * slices: 400,000 blocks of 56 bytes (more than a 16 MiB slice holds) all
 * come from the first thread's arena. Of four more threads alive at once,
 * three get the other arenas and one uses the system allocator; blocks
 * freed across threads go back to their owners. */
#include "../src/scr_runtime.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>

#define COUNT 400000
#define SIZE 56
#define THREADS 4
#define PER_THREAD 1000

_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  exit(EXIT_FAILURE);
}

static void check(bool condition, const char *message) {
  if (condition) return;
  fprintf(stderr, "reservation test failed: %s\n", message);
  exit(EXIT_FAILURE);
}

/* Whether p lies in the calling thread's arena. */
static bool in_arena(const void *p) { return (uintptr_t)p - scr_sa.base < scr_sa.span; }

static unsigned char *thread_blocks[THREADS][PER_THREAD];
static atomic_int with_arena, started;
static atomic_bool done;

/* Allocates PER_THREAD blocks, then stays alive until every thread has. */
static void *allocate(void *arg) {
  unsigned char **blocks = arg;
  for (size_t i = 0; i < PER_THREAD; i++) {
    blocks[i] = scr_mem_alloc(SIZE);
    check(blocks[i] != NULL, "allocate on another thread");
    memset(blocks[i], 0x44, SIZE);
  }
  bool owned = scr_sa.span != 0;
  for (size_t i = 0; i < PER_THREAD; i++) check(in_arena(blocks[i]) == owned, "blocks come from the thread's arena, if any");
  if (owned) atomic_fetch_add(&with_arena, 1);
  atomic_fetch_add(&started, 1);
  while (!atomic_load(&done)) {
  }
  return NULL;
}

int main(void) {
  struct rlimit limit = {(rlim_t)60 << 30, (rlim_t)60 << 30};
  check(setrlimit(RLIMIT_AS, &limit) == 0, "limit the address space");
  unsigned char **blocks = malloc(COUNT * sizeof *blocks);
  check(blocks != NULL, "block table");
  for (size_t i = 0; i < COUNT; i++) {
    blocks[i] = scr_mem_alloc(SIZE);
    check(blocks[i] != NULL, "allocate");
    memset(blocks[i], (int)(i & 0xff), SIZE);
  }
  check(scr_sa.shift == 28, "the class slices are 256 MiB");
  for (size_t i = 0; i < COUNT; i++) check(in_arena(blocks[i]), "every block comes from the arena");
  pthread_t threads[THREADS];
  for (int t = 0; t < THREADS; t++)
    check(pthread_create(&threads[t], NULL, allocate, thread_blocks[t]) == 0, "start a thread");
  while (atomic_load(&started) < THREADS) {
  }
  check(atomic_load(&with_arena) == THREADS - 1, "three more threads get arenas");
  atomic_store(&done, true);
  for (int t = 0; t < THREADS; t++) check(pthread_join(threads[t], NULL) == 0, "join a thread");
  for (int t = 0; t < THREADS; t++)
    for (size_t i = 0; i < PER_THREAD; i++) {
      check(!in_arena(thread_blocks[t][i]), "other threads' blocks are not in this arena");
      for (size_t j = 0; j < SIZE; j++) check(thread_blocks[t][i][j] == 0x44, "other threads' blocks keep their contents");
      scr_mem_free(thread_blocks[t][i]);
    }
  for (size_t i = 0; i < COUNT; i++) {
    for (size_t j = 0; j < SIZE; j++) check(blocks[i][j] == (unsigned char)(i & 0xff), "blocks keep their contents");
    scr_mem_free(blocks[i]);
  }
  free(blocks);
  printf("reservation checks passed\n");
  return 0;
}
