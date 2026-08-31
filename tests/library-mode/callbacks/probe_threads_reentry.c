/* Localized + thread-instanced SC4026 probe. Thread A re-enters from its
 * callback and is poisoned; thread B's independent instance still calls a
 * callback and completes an entry. The ordinary SC4025 isolation fixture
 * remains in probe_threads.c. */
#include <pthread.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void cbt_init(void);
extern void cbt_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern int32_t cbt_set_callback(const char *name, void (*fn)(void), void *ctx);
extern double cbt_stream(double n, double base);

typedef void (*cb_fn)(void);

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int inited = 0, a_trapped = 0;

typedef struct {
  pthread_t self;
  int reenter;
  int chunks;
  int thread_ok;
  int sink_calls;
  int sink_ctx_ok;
  char code[16];
  char symbol[64];
  double result;
  jmp_buf trap_jmp;
} Worker;

static Worker workers[2];

static void parse_field(char *out, size_t cap, const uint8_t *msg, size_t len, int wanted) {
  if (len == 0 || msg[0] != 0x01) return;
  const uint8_t *p = msg + 1, *end = msg + len;
  int field = 0;
  for (;;) {
    const uint8_t *sep = memchr(p, 0x1f, (size_t)(end - p));
    const uint8_t *stop = sep != NULL ? sep : end;
    if (field == wanted) {
      snprintf(out, cap, "%.*s", (int)(stop - p), (const char *)p);
      return;
    }
    field++;
    if (sep == NULL) return;
    p = sep + 1;
  }
}

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)addr;
  Worker *w = (Worker *)ctx;
  w->sink_calls++;
  w->sink_ctx_ok = pthread_equal(pthread_self(), w->self) ? 1 : 0;
  parse_field(w->code, sizeof w->code, msg, len, 1);
  parse_field(w->symbol, sizeof w->symbol, msg, len, 2);
  longjmp(w->trap_jmp, 1);
}

static void on_chunk(void *ctx, const uint8_t *p, size_t len, uint32_t seq) {
  (void)p; (void)len; (void)seq;
  Worker *w = (Worker *)ctx;
  if (!pthread_equal(pthread_self(), w->self)) w->thread_ok = 0;
  if (w->reenter) {
    cbt_stream(1, 1); /* rejected SC4026; never returns */
    printf("UNREACHABLE callback return\n");
  }
  w->chunks++;
}

static void on_note(void *ctx, const uint8_t *p, size_t len, uint8_t last) {
  (void)ctx; (void)p; (void)len; (void)last;
}

static void wait_for(int *value, int target) {
  pthread_mutex_lock(&mu);
  while (*value < target) pthread_cond_wait(&cv, &mu);
  pthread_mutex_unlock(&mu);
}

static void signal_value(int *value) {
  pthread_mutex_lock(&mu);
  (*value)++;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&mu);
}

static void *worker_a(void *arg) {
  Worker *w = (Worker *)arg;
  w->self = pthread_self();
  w->thread_ok = 1;
  w->reenter = 1;
  cbt_set_panic_sink(sink, w);
  cbt_set_callback("emitChunk", (cb_fn)on_chunk, w);
  cbt_set_callback("note", (cb_fn)on_note, NULL);
  cbt_init();
  fflush(stdout); /* keep the two independent init logs line-separated */
  signal_value(&inited);
  wait_for(&inited, 2);
  if (setjmp(w->trap_jmp) == 0) {
    cbt_stream(1, 2);
    printf("UNREACHABLE outer return\n");
  }
  signal_value(&a_trapped);
  return NULL;
}

static void *worker_b(void *arg) {
  Worker *w = (Worker *)arg;
  w->self = pthread_self();
  w->thread_ok = 1;
  cbt_set_panic_sink(sink, w);
  cbt_set_callback("emitChunk", (cb_fn)on_chunk, w);
  cbt_set_callback("note", (cb_fn)on_note, NULL);
  cbt_init();
  fflush(stdout); /* keep the two independent init logs line-separated */
  signal_value(&inited);
  wait_for(&inited, 2);
  wait_for(&a_trapped, 1);
  w->result = cbt_stream(1, 4);
  return NULL;
}

int main(void) {
  pthread_t a, b;
  pthread_create(&a, NULL, worker_a, &workers[0]);
  pthread_create(&b, NULL, worker_b, &workers[1]);
  pthread_join(a, NULL);
  pthread_join(b, NULL);
  printf("A: result=%g chunks=%d thread_ok=%d sink_calls=%d code=%s symbol=%s ctx_ok=%d\n",
         workers[0].result, workers[0].chunks, workers[0].thread_ok, workers[0].sink_calls,
         workers[0].code, workers[0].symbol, workers[0].sink_ctx_ok);
  printf("B: result=%g chunks=%d thread_ok=%d sink_calls=%d\n",
         workers[1].result, workers[1].chunks, workers[1].thread_ok, workers[1].sink_calls);
  return 0;
}
