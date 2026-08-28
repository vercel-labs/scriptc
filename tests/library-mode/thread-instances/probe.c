/* Thread-instanced acceptance probe: ONE archive (prefix mt_, built with
 * abi.instance_per_thread), FOUR embedder threads. Each thread registers
 * its own sink, calls the init entry (concurrently — init touches only the
 * calling thread's instance), and runs an allocation-heavy loop of a
 * DIFFERENT length, so per-thread call counters prove instance
 * independence numerically. Collects run per instance. After every fixed
 * loop finishes, thread 0 takes a deliberate range trap: its sink fires
 * exactly once with the structured message (SC4014, mt_boom) and its ctx,
 * poisoning only ITS instance, while threads 1..3 keep looping through
 * the trap window and answer again afterwards with exact values. Workers
 * record results; main prints after all joins, so stdout is deterministic
 * under any interleaving. */
#include <pthread.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void mt_init(void);
extern void mt_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void mt_collect(void);
extern double mt_bump(double x);
extern double mt_calls_seen(void);
extern double mt_sum_to(double n);
extern double mt_boom(double i);
extern double mt_uptime(void);
extern double mt_perf_now(void);

#define NTHREADS 4

/* Stages: 0 running fixed loops; 1 all fixed loops done (thread 0 traps,
 * the rest keep looping); 2 trap delivered (survivors answer once more and
 * exit). */
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int stage = 0;
static int fixed_loops_done = 0;

static int stage_get(void) {
  pthread_mutex_lock(&mu);
  int s = stage;
  pthread_mutex_unlock(&mu);
  return s;
}

static void stage_set(int s) {
  pthread_mutex_lock(&mu);
  if (stage < s) stage = s;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&mu);
}

static void stage_wait(int s) {
  pthread_mutex_lock(&mu);
  while (stage < s) pthread_cond_wait(&cv, &mu);
  pthread_mutex_unlock(&mu);
}

static void fixed_loop_done(void) {
  pthread_mutex_lock(&mu);
  fixed_loops_done++;
  if (fixed_loops_done == NTHREADS && stage < 1) {
    stage = 1;
    pthread_cond_broadcast(&cv);
  }
  pthread_mutex_unlock(&mu);
}

typedef struct {
  int calls;
  int ctx_ok;
  int fields;
  int addr_nonzero;
  char code[32];
  char symbol[64];
} SinkRec;

typedef struct {
  int id;
  int iters;      /* fixed-loop length: distinct per thread */
  SinkRec sink;
  double last_bump;
  double calls_seen;
  int sums_ok;
  int clocks_ok;
  int trap_fell_through; /* thread 0 only */
  int post_ok;           /* threads 1..3 only */
} Worker;

static Worker workers[NTHREADS];
static jmp_buf trap_jmp; /* thread 0 is the only trapping thread */

static void copy_field(char *dst, size_t cap, const uint8_t *p, size_t len) {
  if (len >= cap) len = cap - 1;
  memcpy(dst, p, len);
  dst[len] = 0;
}

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  SinkRec *r = ctx;
  r->calls++;
  r->addr_nonzero = addr != 0;
  r->ctx_ok = (r == &workers[0].sink);
  if (len > 0 && msg[0] == 0x01) {
    const uint8_t *p = msg + 1, *end = msg + len;
    int i = 0;
    for (;;) {
      const uint8_t *sep = memchr(p, 0x1f, (size_t)(end - p));
      const uint8_t *stop = sep != NULL ? sep : end;
      if (i == 1) copy_field(r->code, sizeof r->code, p, (size_t)(stop - p));
      if (i == 2) copy_field(r->symbol, sizeof r->symbol, p, (size_t)(stop - p));
      i++;
      if (sep == NULL) break;
      p = sep + 1;
    }
    r->fields = i;
  }
  if (r == &workers[0].sink) longjmp(trap_jmp, 1); /* the conforming survival pattern */
  /* Any other sink firing is a routing failure; returning aborts, and the
   * missing output shows it. */
}

static void *worker(void *arg) {
  Worker *w = arg;
  mt_set_panic_sink(sink, &w->sink);
  mt_init(); /* concurrent across all four threads: each init is instance-local */
  double uptime = mt_uptime();
  double perf_now = mt_perf_now();
  w->clocks_ok = uptime >= 0 && uptime < 60 && perf_now >= 0 && perf_now < 60000;
  w->sums_ok = 1;
  double last = 0;
  for (int i = 0; i < w->iters; i++) {
    last = mt_bump(1);
    if (mt_sum_to(100) != 5050.0) w->sums_ok = 0;
    if ((i + 1) % 25 == 0) mt_collect();
  }
  w->last_bump = last;
  w->calls_seen = mt_calls_seen();
  fixed_loop_done();
  stage_wait(1);
  if (w->id == 0) {
    if (setjmp(trap_jmp) == 0) {
      mt_boom(9); /* xs[9] of a length-3 array: the runtime's range trap */
      w->trap_fell_through = 1;
    }
    stage_set(2);
    return NULL; /* this instance is poisoned; no further entries on this thread */
  }
  /* Survivors keep answering through the trap window... */
  while (stage_get() < 2) {
    if (mt_sum_to(100) != 5050.0) w->sums_ok = 0;
  }
  /* ...and after it: exact per-instance state advances. */
  double post_sum = mt_sum_to(10);
  double post_bump = mt_bump(1);
  double post_calls = mt_calls_seen();
  mt_collect();
  w->post_ok = post_sum == 55.0 && post_bump == 1.0 + (w->iters + 1) && post_calls == (double)(w->iters + 1);
  return NULL;
}

int main(void) {
  pthread_t threads[NTHREADS];
  for (int i = 0; i < NTHREADS; i++) {
    workers[i].id = i;
    workers[i].iters = 100 + 50 * i; /* 100 / 150 / 200 / 250 */
    pthread_create(&threads[i], NULL, worker, &workers[i]);
  }
  for (int i = 0; i < NTHREADS; i++) pthread_join(threads[i], NULL);
  for (int i = 0; i < NTHREADS; i++) {
    Worker *w = &workers[i];
    printf("t%d: bump x%d -> %.0f, calls_seen %.0f, sums_ok=%d, clocks_ok=%d", i, w->iters, w->last_bump, w->calls_seen, w->sums_ok, w->clocks_ok);
    if (i == 0) {
      printf(", trap fell through %d\n", w->trap_fell_through);
      printf("t0 sink: calls=%d ctx_ok=%d fields=%d code=[%s] symbol=[%s] addr_nonzero=%d\n",
             w->sink.calls, w->sink.ctx_ok, w->sink.fields, w->sink.code, w->sink.symbol, w->sink.addr_nonzero);
    } else {
      printf(", post_ok=%d\n", w->post_ok);
    }
  }
  printf("survivor sinks: %d %d %d\n", workers[1].sink.calls, workers[2].sink.calls, workers[3].sink.calls);
  return 0;
}
