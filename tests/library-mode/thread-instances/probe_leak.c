/* Thread-exit probe for the audit lane: every worker thread runs library
 * work whose allocations unwind (and one that traps and longjmps out of
 * its entry), then exits. An instance's lifetime is its thread's, and the
 * audit registry that names a trap's abandoned blocks is bookkeeping, not
 * state: once a thread has freed its last block — or abandoned them all —
 * nothing the registry owns may remain unreachable when that thread ends.
 * LeakSanitizer runs at its default setting here, so a single chunk left
 * behind by the bookkeeping exits non-zero with a report. */
#include <pthread.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>

extern void mt_init(void);
extern void mt_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void mt_collect(void);
extern double mt_bump(double x);
extern double mt_sum_to(double n);
extern double mt_boom(double i);

#define NTHREADS 4

/* The sink runs on the trapping thread, so its jump target has to be
 * thread-local (the trap consumes the thread's whole entry frame stack). */
static __thread jmp_buf trap_jmp;

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx;
  (void)msg;
  (void)len;
  (void)addr;
  longjmp(trap_jmp, 1);
}

static void *worker(void *arg) {
  const int id = (int)(intptr_t)arg;
  mt_set_panic_sink(sink, NULL);
  mt_init();
  for (int i = 0; i < 50; i++) {
    if (mt_sum_to(64) != 2080.0) return (void *)1;
    if (mt_bump(1) != (double)(i + 2)) return (void *)1;
    mt_collect();
  }
  /* Thread 0 poisons its instance on purpose: the trap abandons the entry's
   * heap, and the registry has to hand back its own table first. */
  if (id == 0 && setjmp(trap_jmp) == 0) {
    mt_boom(9);
    return (void *)1;
  }
  return NULL;
}

int main(void) {
  pthread_t ts[NTHREADS];
  int bad = 0;
  for (int i = 0; i < NTHREADS; i++) {
    if (pthread_create(&ts[i], NULL, worker, (void *)(intptr_t)i) != 0) return 2;
  }
  for (int i = 0; i < NTHREADS; i++) {
    void *ret = NULL;
    if (pthread_join(ts[i], &ret) != 0) return 2;
    if (ret != NULL) bad = 1;
  }
  printf("threads done bad=%d\n", bad);
  return bad;
}
