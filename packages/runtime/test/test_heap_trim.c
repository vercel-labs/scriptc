/* scr_heap_trim: after most blocks of a class are freed, the pages holding
 * only free blocks go back to the system, the blocks still allocated keep
 * their contents, and the class serves new blocks that overlap none of
 * them. Built with and without SCR_WORKERS; with it, another thread
 * allocates and frees its own blocks throughout, and frees blocks of the
 * trimming thread before the trim (remote frees). */
#include "../src/scr_runtime.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef SCR_WORKERS
#include <pthread.h>
#include <stdatomic.h>
#endif

#define COUNT 400000
#define SIZE 48

_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  exit(EXIT_FAILURE);
}

/* One block kept per KEEP_PAGES pages of blocks, whatever the page size: a
 * kept block pins its page, so the others hold only free blocks. */
#define KEEP_PAGES 4
static size_t keep_every;

static void check(bool condition, const char *message) {
  if (condition) return;
  fprintf(stderr, "heap trim test failed: %s\n", message);
  exit(EXIT_FAILURE);
}

/* Resident bytes of this process. */
static size_t resident(void) {
  FILE *f = fopen("/proc/self/statm", "r");
  check(f != NULL, "open /proc/self/statm");
  unsigned long size = 0, pages = 0;
  check(fscanf(f, "%lu %lu", &size, &pages) == 2, "read /proc/self/statm");
  fclose(f);
  return (size_t)pages * (size_t)sysconf(_SC_PAGESIZE);
}

#ifdef SCR_WORKERS
static atomic_bool churning = true;

/* Allocates, fills and frees blocks of several sizes until told to stop. */
static void *churn(void *arg) {
  (void)arg;
  void *held[256] = {0};
  for (size_t round = 0; atomic_load(&churning); round++) {
    size_t slot = round % 256, size = 16 + (round % 7) * 24;
    if (held[slot]) scr_mem_free(held[slot]);
    held[slot] = scr_mem_alloc(size);
    check(held[slot] != NULL, "allocate on the other thread");
    memset(held[slot], 0x33, size);
  }
  for (size_t i = 0; i < 256; i++)
    if (held[i]) scr_mem_free(held[i]);
  return NULL;
}

/* Frees `count` blocks starting at `first` from another thread. */
typedef struct {
  unsigned char **blocks;
  size_t first, count;
} RemoteFree;

static void *free_remotely(void *arg) {
  RemoteFree *r = arg;
  for (size_t i = r->first; i < r->first + r->count; i++)
    if (i % keep_every != 0) {
      scr_mem_free(r->blocks[i]);
      r->blocks[i] = NULL;
    }
  return NULL;
}
#endif

static int compare(const void *a, const void *b) {
  uintptr_t x = *(const uintptr_t *)a, y = *(const uintptr_t *)b;
  return x < y ? -1 : x > y;
}

int main(void) {
  keep_every = KEEP_PAGES * ((size_t)sysconf(_SC_PAGESIZE) / SIZE + 1);
#ifdef SCR_WORKERS
  pthread_t churner;
  check(pthread_create(&churner, NULL, churn, NULL) == 0, "start the other thread");
#endif
  unsigned char **blocks = malloc(COUNT * sizeof *blocks);
  check(blocks != NULL, "block table");
  for (size_t i = 0; i < COUNT; i++) {
    blocks[i] = scr_mem_alloc(SIZE);
    check(blocks[i] != NULL, "allocate");
    memset(blocks[i], (int)(i & 0xff), SIZE);
  }
  size_t kept = 0;
  uintptr_t *keep = malloc((COUNT / keep_every + 1) * sizeof *keep);
  check(keep != NULL, "keep table");
#ifdef SCR_WORKERS
  RemoteFree remote = {blocks, 0, COUNT / 4};
  pthread_t freer;
  check(pthread_create(&freer, NULL, free_remotely, &remote) == 0, "start the freeing thread");
  check(pthread_join(freer, NULL) == 0, "join the freeing thread");
#endif
  for (size_t i = 0; i < COUNT; i++) {
    if (i % keep_every == 0) {
      keep[kept++] = (uintptr_t)blocks[i];
      continue;
    }
    if (blocks[i]) scr_mem_free(blocks[i]);
  }
  size_t before = resident();
  scr_heap_trim();
  size_t after = resident();
  check(before > after && before - after >= (size_t)8 << 20, "the free pages go back to the system");
  for (size_t i = 0; i < COUNT; i += keep_every)
    for (size_t j = 0; j < SIZE; j++) check(blocks[i][j] == (unsigned char)(i & 0xff), "kept blocks keep their contents");
  qsort(keep, kept, sizeof *keep, compare);
  for (size_t i = 0; i < COUNT; i++) {
    if (i % keep_every == 0) continue;
    unsigned char *p = scr_mem_alloc(SIZE);
    check(p != NULL, "allocate after the trim");
    uintptr_t key = (uintptr_t)p;
    check(bsearch(&key, keep, kept, sizeof *keep, compare) == NULL, "a new block is not a kept one");
    memset(p, 0x5a, SIZE);
    blocks[i] = p;
  }
  for (size_t i = 0; i < COUNT; i += keep_every)
    for (size_t j = 0; j < SIZE; j++) check(blocks[i][j] == (unsigned char)(i & 0xff), "kept blocks survive new allocations");
  for (size_t i = 0; i < COUNT; i++) scr_mem_free(blocks[i]);
#ifdef SCR_WORKERS
  atomic_store(&churning, false);
  check(pthread_join(churner, NULL) == 0, "join the other thread");
#endif
  free(keep);
  free(blocks);
  printf("heap trim checks passed\n");
  return 0;
}
