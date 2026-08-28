/* Multi-instance acceptance probe: TWO runtime-localized library archives
 * (prefixes ma_ / mb_) linked into ONE process, each instance driven from
 * its own dedicated embedder thread — the documented contract: one thread
 * per instance, an instance never entered from two threads. Checks:
 *   - both instances init, run their export families, and run their
 *     collect entries independently;
 *   - a deliberate range trap in instance A reaches ONLY A's registered
 *     sink, exactly once, as the structured message (SC4014, symbol
 *     ma_boom) with A's registration ctx and a nonzero fault address;
 *   - instance B keeps answering: its worker loops through allocation-
 *     heavy calls across A's trap window and still answers afterwards,
 *     with exact values throughout;
 *   - B's sink never fires.
 * Workers record results into per-thread state; main prints everything
 * after both joins, so stdout is deterministic under any interleaving. */
#include <pthread.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void ma_init(void);
extern void ma_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void ma_collect(void);
extern double ma_bump(double x);
extern double ma_calls_seen(void);
extern double ma_boom(double i);

extern void mb_init(void);
extern void mb_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void mb_collect(void);
extern double mb_sum_to(double n);
extern double mb_add(double x);

/* Probe stages: 0 start; 1 A initialized; 2 B initialized (both workers'
 * concurrent loops run); 3 both fixed loops finished (A traps, B keeps
 * looping); 4 A's trap delivered (B answers once more and exits). */
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int stage = 0;
static int fixed_loops_done = 0;

static void stage_set(int s) {
  pthread_mutex_lock(&mu);
  if (stage < s) stage = s;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&mu);
}

static int stage_get(void) {
  pthread_mutex_lock(&mu);
  int s = stage;
  pthread_mutex_unlock(&mu);
  return s;
}

static void stage_wait(int s) {
  pthread_mutex_lock(&mu);
  while (stage < s) pthread_cond_wait(&cv, &mu);
  pthread_mutex_unlock(&mu);
}

static void fixed_loop_done(void) {
  pthread_mutex_lock(&mu);
  fixed_loops_done++;
  if (fixed_loops_done == 2 && stage < 3) {
    stage = 3;
    pthread_cond_broadcast(&cv);
  }
  pthread_mutex_unlock(&mu);
}

/* Per-instance sink records. Both instances register the SAME sink
 * function with instance-specific ctx: delivery routing is observable as
 * which record advances. */
typedef struct {
  int calls;
  int ctx_ok;
  int fields;
  int text_printable;
  int addr_nonzero;
  char code[32];
  char symbol[64];
} SinkRec;

static SinkRec rec_a, rec_b;
static jmp_buf trap_jmp_a;

static void copy_field(char *dst, size_t cap, const uint8_t *p, size_t len) {
  if (len >= cap) len = cap - 1;
  memcpy(dst, p, len);
  dst[len] = 0;
}

static void record_structured(SinkRec *r, const uint8_t *msg, size_t len) {
  if (len == 0 || msg[0] != 0x01) return; /* fields stays 0: not structured */
  r->text_printable = len > 1 && msg[1] >= 0x20;
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

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  SinkRec *r = ctx;
  r->calls++;
  r->addr_nonzero = addr != 0;
  record_structured(r, msg, len);
  if (r == &rec_a) {
    r->ctx_ok = 1;
    longjmp(trap_jmp_a, 1); /* the conforming survival pattern */
  }
  /* B's sink must never fire; returning would abort, and main would never
   * print (the probe's failure shows as missing output). */
}

/* Instance A's dedicated thread: state-advancing calls, collects, then the
 * deliberate trap. */
static double a_last_bump, a_calls;
static int a_trap_fell_through = 0;

static void *worker_a(void *arg) {
  (void)arg;
  ma_set_panic_sink(sink, &rec_a);
  ma_init(); /* prints "multi-a ready" */
  stage_set(1);
  stage_wait(2);
  double last = 0;
  for (int i = 0; i < 200; i++) {
    last = ma_bump(1);
    if ((i + 1) % 50 == 0) ma_collect();
  }
  a_last_bump = last;
  a_calls = ma_calls_seen();
  fixed_loop_done();
  stage_wait(3);
  if (setjmp(trap_jmp_a) == 0) {
    ma_boom(9); /* xs[9] of a length-3 array: the runtime's range trap */
    a_trap_fell_through = 1;
  }
  stage_set(4);
  return NULL;
}

/* Instance B's dedicated thread: allocation-heavy calls that keep running
 * across A's trap window, then post-trap answers. */
static int b_sums_ok = 1, b_adds_ok = 1, b_reached_200 = 0, b_post_ok = 0;

static void *worker_b(void *arg) {
  (void)arg;
  mb_set_panic_sink(sink, &rec_b);
  stage_wait(1);
  mb_init(); /* prints "multi-b ready" */
  stage_set(2);
  double total = 0;
  long iters = 0;
  for (;;) {
    if (mb_sum_to(100) != 5050.0) b_sums_ok = 0;
    total = mb_add(1);
    iters++;
    if (total != (double)iters) b_adds_ok = 0;
    if (iters % 25 == 0) mb_collect();
    if (iters == 200) fixed_loop_done();
    if (iters >= 200 && stage_get() >= 4) break;
  }
  b_reached_200 = iters >= 200;
  /* A's trap has been delivered; B answers again. */
  double post_sum = mb_sum_to(10);
  double post_add = mb_add(5);
  mb_collect();
  b_post_ok = post_sum == 55.0 && post_add == total + 5.0;
  return NULL;
}

int main(void) {
  pthread_t ta, tb;
  pthread_create(&ta, NULL, worker_a, NULL);
  pthread_create(&tb, NULL, worker_b, NULL);
  pthread_join(ta, NULL);
  pthread_join(tb, NULL);
  printf("a: bump(1) x200 -> %.0f, calls_seen %.0f, trap fell through %d\n",
         a_last_bump, a_calls, a_trap_fell_through);
  printf("a sink: calls=%d ctx_ok=%d fields=%d code=[%s] symbol=[%s] text_printable=%d addr_nonzero=%d\n",
         rec_a.calls, rec_a.ctx_ok, rec_a.fields, rec_a.code, rec_a.symbol,
         rec_a.text_printable, rec_a.addr_nonzero);
  printf("b: concurrent sums_ok=%d adds_ok=%d reached_200=%d\n", b_sums_ok, b_adds_ok, b_reached_200);
  printf("b: post-trap answers ok=%d\n", b_post_ok);
  printf("b sink: calls=%d\n", rec_b.calls);
  return 0;
}
