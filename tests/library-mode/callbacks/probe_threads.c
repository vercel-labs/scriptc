/* Composition probe: ONE runtime-localized (abi.localize_runtime),
 * thread-instanced (abi.instance_per_thread) archive with host-callback
 * channels, driven from two embedder threads — the documented contract:
 * the calling thread IS the instance selector, and channel registrations
 * are per-instance state exactly like the sink's. Checks:
 *   - each thread registers its OWN emitChunk context and sink, inits its
 *     own instance, and streams concurrently (a barrier forces overlap);
 *     chunks route to the registering thread's log with exact contents,
 *     order, and thread identity — nothing crosses instances;
 *   - thread A then reaches the channel it never registered: the SC4025
 *     structured trap arrives at A's sink exactly once (A's ctx, symbol
 *     cbt_poke_orphan) and poisons only A's instance;
 *   - thread B keeps streaming through and after A's trap window with
 *     exact values; B's sink never fires.
 * Workers record into per-thread state; main prints after both joins, so
 * stdout is deterministic under any interleaving. */
#include <pthread.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void cbt_init(void);
extern void cbt_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern int32_t cbt_set_callback(const char *name, void (*fn)(void), void *ctx);
extern double cbt_stream(double n, double base);
extern double cbt_ask_host(double x);
extern double cbt_poke_orphan(void);

typedef void (*cb_fn)(void);

/* Stages: 0 start; 1 both instances initialized (concurrent streams run);
 * 2 both first streams done (A traps); 3 A's trap delivered (B streams
 * once more and exits). */
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int stage = 0;
static int inited = 0, streamed = 0;

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

static void arrive(int *counter, int total, int next_stage) {
  pthread_mutex_lock(&mu);
  (*counter)++;
  if (*counter == total && stage < next_stage) {
    stage = next_stage;
    pthread_cond_broadcast(&cv);
  }
  pthread_mutex_unlock(&mu);
}

typedef struct {
  char bytes[8];
  size_t len;
  uint32_t seq;
} ChunkRec;

typedef struct {
  pthread_t self;
  ChunkRec chunks[16];
  int count;
  int thread_ok;
  int sink_calls;
  int sink_ctx_ok;
  char sink_code[16];
  char sink_symbol[64];
  double r1, r2;
  jmp_buf trap_jmp;
} Worker;

static void on_chunk(void *ctx, const uint8_t *p, size_t len, uint32_t seq) {
  Worker *w = (Worker *)ctx;
  ChunkRec *rec = &w->chunks[w->count];
  memcpy(rec->bytes, p, len < sizeof rec->bytes ? len : sizeof rec->bytes);
  rec->len = len;
  rec->seq = seq;
  w->count++;
  if (!pthread_equal(pthread_self(), w->self)) w->thread_ok = 0;
}

static int32_t on_progress(void *ctx, double done, double total) {
  (void)ctx;
  return (int32_t)(total - done);
}

static void on_note(void *ctx, const uint8_t *p, size_t len, uint8_t last) {
  (void)ctx; (void)p; (void)len; (void)last;
}

static uint32_t on_mix(void *ctx, uint8_t a, int32_t b) {
  (void)ctx;
  return (uint32_t)a + (uint32_t)(-b);
}

static Worker workers[2];

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)addr;
  Worker *w = (Worker *)ctx;
  w->sink_calls++;
  w->sink_ctx_ok = pthread_equal(pthread_self(), w->self) ? 1 : 0;
  /* Structured parse: fields 1 (code) and 2 (symbol). */
  if (len > 0 && msg[0] == 0x01) {
    const uint8_t *p = msg + 1, *end = msg + len;
    int field = 0;
    for (;;) {
      const uint8_t *sep = memchr(p, 0x1f, (size_t)(end - p));
      const uint8_t *stop = sep != NULL ? sep : end;
      if (field == 1) snprintf(w->sink_code, sizeof w->sink_code, "%.*s", (int)(stop - p), (const char *)p);
      if (field == 2) snprintf(w->sink_symbol, sizeof w->sink_symbol, "%.*s", (int)(stop - p), (const char *)p);
      field++;
      if (sep == NULL) break;
      p = sep + 1;
    }
  }
  longjmp(w->trap_jmp, 1);
}

static void *worker_a(void *arg) {
  Worker *w = (Worker *)arg;
  w->self = pthread_self();
  w->thread_ok = 1;
  cbt_set_panic_sink(sink, w);
  cbt_set_callback("emitChunk", (cb_fn)on_chunk, w);
  cbt_set_callback("progress", (cb_fn)on_progress, NULL);
  cbt_set_callback("note", (cb_fn)on_note, NULL);
  cbt_set_callback("mix", (cb_fn)on_mix, NULL);
  cbt_init();
  arrive(&inited, 2, 1);
  stage_wait(1);
  w->r1 = cbt_stream(3, 2); /* concurrent with B's stream */
  arrive(&streamed, 2, 2);
  stage_wait(2);
  if (setjmp(w->trap_jmp) == 0) {
    cbt_poke_orphan(); /* A never registered 'orphan': SC4025 to A's sink */
    printf("UNREACHABLE A\n");
  }
  stage_set(3);
  return NULL;
}

static void *worker_b(void *arg) {
  Worker *w = (Worker *)arg;
  w->self = pthread_self();
  w->thread_ok = 1;
  cbt_set_panic_sink(sink, w);
  cbt_set_callback("emitChunk", (cb_fn)on_chunk, w);
  cbt_set_callback("progress", (cb_fn)on_progress, NULL);
  cbt_set_callback("note", (cb_fn)on_note, NULL);
  cbt_set_callback("mix", (cb_fn)on_mix, NULL);
  cbt_init();
  arrive(&inited, 2, 1);
  stage_wait(1);
  w->r1 = cbt_stream(3, 5); /* concurrent with A's stream */
  arrive(&streamed, 2, 2);
  stage_wait(3); /* A's instance is poisoned now; B's keeps answering */
  w->r2 = cbt_stream(1, 4);
  return NULL;
}

static void dump(const char *tag, const Worker *w) {
  printf("%s: r1=%g r2=%g chunks=%d thread_ok=%d sink_calls=%d\n",
         tag, w->r1, w->r2, w->count, w->thread_ok, w->sink_calls);
  for (int i = 0; i < w->count; i++) {
    printf("  seq=%u len=%zu bytes=%.*s\n", w->chunks[i].seq, w->chunks[i].len,
           (int)w->chunks[i].len, w->chunks[i].bytes);
  }
  if (w->sink_calls > 0) {
    printf("  sink code=%s symbol=%s ctx_ok=%d\n", w->sink_code, w->sink_symbol, w->sink_ctx_ok);
  }
}

int main(void) {
  pthread_t ta, tb;
  pthread_create(&ta, NULL, worker_a, &workers[0]);
  pthread_create(&tb, NULL, worker_b, &workers[1]);
  pthread_join(ta, NULL);
  pthread_join(tb, NULL);
  dump("A", &workers[0]);
  dump("B", &workers[1]);
  return 0;
}
