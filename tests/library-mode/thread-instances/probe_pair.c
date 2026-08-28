/* Composition probe: a thread-instanced AND runtime-localized archive
 * (prefix mt_) coexists with a second, different-prefix runtime-localized
 * archive (mb_) in ONE process. Two threads drive two mt_ instances; a
 * third drives the mb_ instance. Thread t0's deliberate trap reaches only
 * t0's sink, exactly once; the sibling mt_ instance AND the mb_ archive
 * keep answering through and after the trap window. Workers record
 * results; main prints after all joins. */
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

extern void mb_init(void);
extern void mb_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void mb_collect(void);
extern double mb_sum_to(double n);
extern double mb_add(double x);

/* Stages: 0 fixed loops; 1 all three done (t0 traps, others keep looping);
 * 2 trap delivered (survivors answer once more and exit). The mb_ archive's
 * init prints "multi-b ready", sequenced FIRST so stdout stays
 * deterministic (the mt_ fixture's init prints nothing). */
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int stage = 0;
static int b_ready = 0;
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

static void b_ready_set(void) {
  pthread_mutex_lock(&mu);
  b_ready = 1;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&mu);
}

static void b_ready_wait(void) {
  pthread_mutex_lock(&mu);
  while (!b_ready) pthread_cond_wait(&cv, &mu);
  pthread_mutex_unlock(&mu);
}

static void fixed_loop_done(void) {
  pthread_mutex_lock(&mu);
  fixed_loops_done++;
  if (fixed_loops_done == 3 && stage < 1) {
    stage = 1;
    pthread_cond_broadcast(&cv);
  }
  pthread_mutex_unlock(&mu);
}

typedef struct {
  int calls;
  int ctx_ok;
  char code[32];
  char symbol[64];
} SinkRec;

static SinkRec sink_t0, sink_t1, sink_b;
static jmp_buf trap_jmp;

static void copy_field(char *dst, size_t cap, const uint8_t *p, size_t len) {
  if (len >= cap) len = cap - 1;
  memcpy(dst, p, len);
  dst[len] = 0;
}

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  SinkRec *r = ctx;
  (void)addr;
  r->calls++;
  r->ctx_ok = (r == &sink_t0);
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
  }
  if (r == &sink_t0) longjmp(trap_jmp, 1);
}

typedef struct {
  int id; /* 0 = trapping mt_ thread, 1 = surviving mt_ thread */
  int iters;
  double last_bump;
  double calls_seen;
  int sums_ok;
  int trap_fell_through;
  int post_ok;
} TWorker;

static TWorker t0 = { 0, 100, 0, 0, 0, 0, 0 };
static TWorker t1 = { 1, 200, 0, 0, 0, 0, 0 };

static void *worker_t(void *arg) {
  TWorker *w = arg;
  mt_set_panic_sink(sink, w->id == 0 ? &sink_t0 : &sink_t1);
  b_ready_wait(); /* mb_'s init already printed; mt_ inits print nothing */
  mt_init();
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
      mt_boom(9);
      w->trap_fell_through = 1;
    }
    stage_set(2);
    return NULL; /* poisoned instance: no further entries on this thread */
  }
  while (stage_get() < 2) {
    if (mt_sum_to(100) != 5050.0) w->sums_ok = 0;
  }
  double post_sum = mt_sum_to(10);
  double post_bump = mt_bump(1);
  w->post_ok = post_sum == 55.0 && post_bump == 1.0 + (w->iters + 1) && mt_calls_seen() == (double)(w->iters + 1);
  return NULL;
}

static int b_sums_ok = 1, b_adds_ok = 1, b_post_ok = 0;

static void *worker_b(void *arg) {
  (void)arg;
  mb_set_panic_sink(sink, &sink_b);
  mb_init(); /* prints "multi-b ready" before anything else runs */
  b_ready_set();
  double total = 0;
  long iters = 0;
  for (;;) {
    if (mb_sum_to(100) != 5050.0) b_sums_ok = 0;
    total = mb_add(1);
    iters++;
    if (total != (double)iters) b_adds_ok = 0;
    if (iters % 25 == 0) mb_collect();
    if (iters == 150) fixed_loop_done();
    if (iters >= 150 && stage_get() >= 2) break;
  }
  double post_sum = mb_sum_to(10);
  double post_add = mb_add(5);
  mb_collect();
  b_post_ok = post_sum == 55.0 && post_add == total + 5.0;
  return NULL;
}

int main(void) {
  pthread_t ta, tb, tc;
  pthread_create(&ta, NULL, worker_t, &t0);
  pthread_create(&tb, NULL, worker_t, &t1);
  pthread_create(&tc, NULL, worker_b, NULL);
  pthread_join(ta, NULL);
  pthread_join(tb, NULL);
  pthread_join(tc, NULL);
  printf("t0: bump x%d -> %.0f, calls_seen %.0f, sums_ok=%d, trap fell through %d\n",
         t0.iters, t0.last_bump, t0.calls_seen, t0.sums_ok, t0.trap_fell_through);
  printf("t0 sink: calls=%d ctx_ok=%d code=[%s] symbol=[%s]\n", sink_t0.calls, sink_t0.ctx_ok, sink_t0.code, sink_t0.symbol);
  printf("t1: bump x%d -> %.0f, calls_seen %.0f, sums_ok=%d, post_ok=%d\n",
         t1.iters, t1.last_bump, t1.calls_seen, t1.sums_ok, t1.post_ok);
  printf("b: sums_ok=%d adds_ok=%d post_ok=%d\n", b_sums_ok, b_adds_ok, b_post_ok);
  printf("other sinks: t1=%d b=%d\n", sink_t1.calls, sink_b.calls);
  return 0;
}
