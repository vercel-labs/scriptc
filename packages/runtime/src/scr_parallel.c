/* Parallel loops (parallelInto, parallelReduce, parallelFor): see
 * scr_parallel.h.
 *
 * One pool for the process: `threads - 1` helper threads parked on a
 * condition variable, the calling thread running chunks too. The job lives
 * in the caller's frame and every thread claims a chunk with one atomic
 * add, so chunks are balanced dynamically (rows of a bitmap differ in
 * cost). The call returns when every chunk has run and every helper has
 * left the job.
 *
 * Helpers hold no runtime state, allocate nothing and are detached: the
 * callbacks the compiler accepts for the parallel path contain no call
 * that reaches the runtime, so a helper never touches the allocator or the
 * exception cell. Only the calling thread runs a body the compiler
 * resolved to the sequential path, where allocation and throws are
 * ordinary. */

#include "scr_runtime.h"

#include <math.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* A library archive may reference only the target's C/math runtime and
 * system APIs, and the thread pool's pthread calls are not on that list:
 * `-DSCR_LIB` builds run every chunk on the calling thread, which is the
 * same Node.js loop with the same chunks and the same result. */
#if !defined(_WIN32) && !defined(__wasi__) && !defined(SCR_LIB)
#include <pthread.h>
#include <unistd.h>
#define SCR_PAR_THREADS 1
#endif

typedef enum ScrParKind {
  SCR_PAR_INTO,
  SCR_PAR_REDUCE,
  SCR_PAR_FOR,
} ScrParKind;

typedef struct ScrParPool ScrParPool;

typedef struct ScrParJob {
  ScrParKind kind;
#ifdef SCR_PAR_THREADS
  ScrParPool *pool;
#endif
  ScrClosure *body; /* INTO, FOR */
  ScrClosure *part; /* REDUCE */
  ScrBytes *target; /* INTO */
  uint64_t stride;  /* INTO */
  uint64_t count;
  uint64_t grain;
  uint64_t nchunks;
  double *partials; /* REDUCE: one result per chunk */
  /* The next chunk to claim, and how many chunks have not finished yet
   * (the counter is guarded by the pool lock). */
  _Atomic uint64_t next;
  uint64_t remaining;
} ScrParJob;

#ifdef SCR_PAR_THREADS
struct ScrParPool {
  pthread_mutex_t lock;
  pthread_cond_t wake; /* helpers park here between jobs */
  pthread_cond_t idle; /* the caller waits here for the job to finish */
  ScrParJob *job;
  unsigned generation; /* incremented when a job is published */
  unsigned helpers;
  unsigned active; /* helpers inside the current job */
  bool shutdown;
};
#endif

/* One job at a time for the whole process: a call made while another one
 * runs (a nested call, a parallel loop in a worker thread) takes the
 * sequential path, which is always correct. */
static _Atomic bool scr_par_busy;

static _Atomic int scr_par_thread_count;

#ifdef SCR_PAR_THREADS
static pthread_mutex_t scr_par_pool_lock = PTHREAD_MUTEX_INITIALIZER;
static ScrParPool *scr_par_pool;
#endif

static int scr_par_read_threads(void) {
#ifdef SCR_PAR_THREADS
  const char *env = getenv("SCRIPTC_THREADS");
  long n = 0;
  if (env != NULL && *env != '\0') {
    char *end = NULL;
    n = strtol(env, &end, 10);
    if (end == env || *end != '\0' || n < 1) n = 0; /* an invalid value: the default */
  }
  if (n == 0) {
    long online = sysconf(_SC_NPROCESSORS_ONLN);
    n = online > 0 ? online : 1;
  }
  /* More helper threads than hardware threads only add context switches;
   * the cap also bounds the pool's address space. */
  if (n > 64) n = 64;
  return (int)n;
#else
  return 1;
#endif
}

static int scr_par_threads(void) {
  int n = atomic_load_explicit(&scr_par_thread_count, memory_order_relaxed);
  if (n != 0) return n;
  n = scr_par_read_threads();
  atomic_store_explicit(&scr_par_thread_count, n, memory_order_relaxed);
  return n;
}

#ifdef SCR_PAR_THREADS
static void scr_par_run_chunks(ScrParJob *job);

static void *scr_par_helper(void *arg) {
  ScrParPool *pool = arg;
  pthread_mutex_lock(&pool->lock);
  unsigned seen = pool->generation;
  for (;;) {
    while (!pool->shutdown && (pool->job == NULL || pool->generation == seen))
      pthread_cond_wait(&pool->wake, &pool->lock);
    if (pool->shutdown) break;
    ScrParJob *job = pool->job;
    seen = pool->generation;
    pool->active++;
    pthread_mutex_unlock(&pool->lock);
    scr_par_run_chunks(job);
    pthread_mutex_lock(&pool->lock);
    if (--pool->active == 0) pthread_cond_broadcast(&pool->idle);
  }
  pthread_mutex_unlock(&pool->lock);
  return NULL;
}

/* The pool, created on the first call that has work worth waking it for;
 * NULL when the process runs one thread. A helper that fails to start
 * leaves a smaller pool, never an error: the calling thread runs the
 * chunks the missing helper would have taken. */
static ScrParPool *scr_par_get_pool(void) {
  if (scr_par_threads() < 2) return NULL;
  pthread_mutex_lock(&scr_par_pool_lock);
  ScrParPool *pool = scr_par_pool;
  if (pool == NULL) {
    pool = calloc(1, sizeof(*pool));
    if (pool == NULL) {
      pthread_mutex_unlock(&scr_par_pool_lock);
      return NULL;
    }
    pthread_mutex_init(&pool->lock, NULL);
    pthread_cond_init(&pool->wake, NULL);
    pthread_cond_init(&pool->idle, NULL);
    int want = scr_par_threads() - 1;
    pthread_attr_t attr;
    if (pthread_attr_init(&attr) == 0) {
      /* An explicit size keeps a body's stack independent of the C
       * library's default for threads (as small as 128 KiB with musl).
       * Pages are committed only as the stack grows. */
      pthread_attr_setstacksize(&attr, (size_t)8 << 20);
      for (int i = 0; i < want; i++) {
        pthread_t thread;
        if (pthread_create(&thread, &attr, scr_par_helper, pool) != 0) break;
        pthread_detach(thread);
        pool->helpers++;
      }
      pthread_attr_destroy(&attr);
    }
    if (pool->helpers == 0) {
      pthread_mutex_destroy(&pool->lock);
      pthread_cond_destroy(&pool->wake);
      pthread_cond_destroy(&pool->idle);
      free(pool);
      pool = NULL;
    }
    scr_par_pool = pool;
  }
  pthread_mutex_unlock(&scr_par_pool_lock);
  return pool;
}
#endif

/* ── the chunks ─────────────────────────────────────────────────────── */

/* The 64-byte header of one chunk's view on the parallel path, built in the
 * frame of the thread running the chunk: the target's element kind and
 * shared backing, no owner, and the external flag so nothing frees the
 * target's storage. Only bodies the compiler proved cannot keep `part` run
 * with it (scr_par_chunk's owned_view is false there). */
static void scr_par_view(ScrBytes *view, const ScrBytes *target, uint64_t start, uint64_t end,
                         uint64_t stride) {
  size_t width = scr_bytes_elem_size(target->elem);
  memset(view, 0, sizeof(*view));
  view->rc = SIZE_MAX;
  view->len = (size_t)((end - start) * stride);
  view->elem = target->elem;
  view->data = target->data + (size_t)(start * stride) * width;
  view->external = true;
  view->shared = target->shared;
}

/* Runs chunk `index`. `owned_view` asks for a real heap view of the chunk:
 * the sequential path runs the program's own body, which may keep `part`
 * past the call (Node keeps every subarray), so the callback owns that
 * reference and the view outlives the loop exactly when the body kept one.
 * The parallel path builds the header in the frame of the thread running
 * the chunk instead: a helper may not allocate, and its bodies cannot let
 * `part` escape. */
static void scr_par_chunk(ScrParJob *job, uint64_t index, bool owned_view) {
  uint64_t start = index * job->grain;
  uint64_t end = start + job->grain;
  if (end > job->count) end = job->count;
  switch (job->kind) {
    case SCR_PAR_INTO: {
      if (owned_view) {
        /* subarray's indices are exact in a double: a typed array's length
         * is far below 2^53. The callback owns this reference and releases
         * it when it returns, as a compiled closure releases its
         * parameters, so the view lives exactly as long as the body keeps a
         * reference. A detached buffer throws Node's subarray TypeError and
         * the chunk's body does not run, so that view is released here. */
        ScrBytes *view = scr_bytes_subarray(job->target, (double)(start * job->stride),
                                            (double)(end * job->stride));
        if (scr_exc_pending()) {
          scr_bytes_release(view);
          break;
        }
        ((ScrParBody)job->body->fn)(job->body, view, (double)start, (double)end);
        break;
      }
      ScrBytes view;
      scr_par_view(&view, job->target, start, end, job->stride);
      ((ScrParBody)job->body->fn)(job->body, &view, (double)start, (double)end);
      break;
    }
    case SCR_PAR_REDUCE:
      job->partials[index] = ((ScrParPart)job->part->fn)(job->part, (double)start, (double)end);
      break;
    case SCR_PAR_FOR:
      ((ScrParRange)job->body->fn)(job->body, (double)start, (double)end);
      break;
  }
}

#ifdef SCR_PAR_THREADS
/* Claims chunks until none are left. Called by the calling thread and by
 * every helper. No runtime call runs here: a helper thread in a worker
 * program has no runtime state of its own. */
static void scr_par_run_chunks(ScrParJob *job) {
  for (;;) {
    uint64_t index = atomic_fetch_add_explicit(&job->next, 1, memory_order_relaxed);
    if (index >= job->nchunks) return;
    scr_par_chunk(job, index, false);
    ScrParPool *pool = job->pool;
    pthread_mutex_lock(&pool->lock);
    if (--job->remaining == 0) pthread_cond_broadcast(&pool->idle);
    pthread_mutex_unlock(&pool->lock);
  }
}

/* Runs chunk `skip` on this thread, times it, and hands the rest to the
 * pool only when the estimate says the wake-up is worth it: waking seven
 * helpers costs about 20 us, and a shorter job runs here alone. The chunk
 * boundaries do not change, so neither does the result. */
static void scr_par_run_job(ScrParJob *job, uint64_t skip) {
  ScrParPool *pool = scr_par_get_pool();
  if (pool == NULL || pool->helpers == 0) {
    for (uint64_t i = skip; i < job->nchunks && !scr_exc_pending(); i++)
      scr_par_chunk(job, i, false);
    return;
  }
  uint64_t begin = scr_hrtime_ns();
  scr_par_chunk(job, skip, false);
  uint64_t first = scr_hrtime_ns() - begin;
  uint64_t rest = job->nchunks - skip - 1;
  if (scr_exc_pending() || (double)first * (double)rest < 20000.0) {
    for (uint64_t i = skip + 1; i < job->nchunks && !scr_exc_pending(); i++)
      scr_par_chunk(job, i, false);
    return;
  }
  pthread_mutex_lock(&pool->lock);
  if (pool->job != NULL) {
    /* Another thread's job owns the pool. */
    pthread_mutex_unlock(&pool->lock);
    for (uint64_t i = skip + 1; i < job->nchunks && !scr_exc_pending(); i++)
      scr_par_chunk(job, i, false);
    return;
  }
  job->pool = pool;
  atomic_store_explicit(&job->next, skip + 1, memory_order_relaxed);
  job->remaining = rest;
  pool->job = job;
  pool->generation++;
  pthread_cond_broadcast(&pool->wake);
  pthread_mutex_unlock(&pool->lock);
  scr_par_run_chunks(job);
  pthread_mutex_lock(&pool->lock);
  while (job->remaining > 0) pthread_cond_wait(&pool->idle, &pool->lock);
  /* Every helper has left the job before the caller's frame goes away. */
  while (pool->active > 0) pthread_cond_wait(&pool->idle, &pool->lock);
  pool->job = NULL;
  pthread_mutex_unlock(&pool->lock);
}
#endif

/* Runs every chunk on the calling thread, stopping at the first pending
 * exception: a sequential body may throw, allocate and call anything. */
static bool scr_par_run_sequential(ScrParJob *job, uint64_t skip) {
  for (uint64_t i = skip; i < job->nchunks; i++) {
    scr_par_chunk(job, i, true);
    if (scr_exc_pending()) return false;
  }
  return true;
}

/* Publishes the job for chunks `skip` ..: the pool when the compiler
 * allowed it, the calling thread otherwise. */
static bool scr_par_dispatch(ScrParJob *job, uint64_t skip, bool parallel) {
#ifdef SCR_PAR_THREADS
  if (parallel) {
    scr_par_run_job(job, skip);
    return !scr_exc_pending();
  }
#else
  (void)parallel;
#endif
  return scr_par_run_sequential(job, skip);
}

/* ── entry checks (the Node implementation's, in its order) ─────────── */

/* Whether `value` is an integer in [least, 2^53). */
static bool scr_par_integer(double value, double least) {
  return value == value && value >= least && value == (double)(uint64_t)value &&
         value < 9007199254740992.0;
}

/* The grain the call uses: the option when given, else 256 chunks over
 * `count` (Math.max(1, Math.ceil(count / 256)), exactly as index.js
 * computes it). Answers 0 for a grain that is not a positive integer. */
static bool scr_par_grain(double count, bool given_present, double given, uint64_t *grain) {
  double value = given_present ? given : ceil(count / 256.0);
  if (!given_present && !(value >= 1.0)) value = 1.0;
  if (!scr_par_integer(value, 1)) return false;
  *grain = (uint64_t)value;
  return true;
}

static uint64_t scr_par_chunks(uint64_t count, uint64_t grain) {
  return count == 0 ? 0 : (count - 1) / grain + 1;
}

/* `count` first, then `grain`: the Node implementation's validation order
 * and messages. */
static bool scr_par_count(double count, bool given_present, double given, uint64_t *total,
                          uint64_t *grain) {
  if (!scr_par_integer(count, 0)) {
    static const char message[] = "count must be a non-negative integer";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return false;
  }
  if (!scr_par_grain(count, given_present, given, grain)) {
    static const char message[] = "grain must be a positive integer";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return false;
  }
  *total = (uint64_t)count;
  return true;
}

/* Whether two views' element ranges overlap. A chunk that writes its part
 * of the target must not run beside a read of the same elements. */
static bool scr_par_overlaps(const ScrBytes *a, const ScrBytes *b) {
  if (a->len == 0 || b->len == 0) return false;
  uintptr_t a0 = (uintptr_t)a->data, b0 = (uintptr_t)b->data;
  return a0 < b0 + b->len * scr_bytes_elem_size(b->elem) &&
         b0 < a0 + a->len * scr_bytes_elem_size(a->elem);
}

static bool scr_par_enter(void) {
  bool idle = false;
  return atomic_compare_exchange_strong_explicit(&scr_par_busy, &idle, true, memory_order_acq_rel,
                                                 memory_order_relaxed);
}

static void scr_par_leave(void) {
  atomic_store_explicit(&scr_par_busy, false, memory_order_release);
}

/* ── the three calls ─────────────────────────────────────────────────── */

void scr_par_into(ScrBytes *target, double stride, double grain_given, double grain,
                  double parallel, ScrClosure *body, ScrBytes **reads, size_t nreads) {
  if (!scr_par_integer(stride, 1) || target->len % (uint64_t)stride != 0) {
    static const char message[] =
        "stride must be a positive integer that divides the target's length";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return;
  }
#ifdef SCR_JS_OBJECT_MODEL
  /* index.js's target.subarray() throws on a detached buffer. */
  if (!scr_js_bytes_live(target)) {
    scr_js_bytes_throw_detached("%TypedArray%.prototype.subarray");
    return;
  }
#endif
  uint64_t count = (uint64_t)target->len / (uint64_t)stride;
  uint64_t chunk = 0;
  if (!scr_par_grain((double)count, grain_given != 0.0, grain, &chunk)) {
    static const char message[] = "grain must be a positive integer";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return;
  }
  ScrParJob job;
  memset(&job, 0, sizeof job);
  job.kind = SCR_PAR_INTO;
  job.body = body;
  job.target = target;
  job.stride = (uint64_t)stride;
  job.count = count;
  job.grain = chunk;
  job.nchunks = scr_par_chunks(count, chunk);
  if (job.nchunks == 0) return;
  bool alone = !scr_par_enter();
  bool parallel_ok = parallel != 0.0 && !alone;
  for (size_t i = 0; parallel_ok && i < nreads; i++)
    if (reads[i] != NULL && scr_par_overlaps(target, reads[i])) parallel_ok = false;
  scr_par_dispatch(&job, 0, parallel_ok);
  if (!alone) scr_par_leave();
}

double scr_par_reduce(double count, double grain_given, double grain, double initial,
                      double parallel, ScrClosure *part, ScrClosure *combine) {
  uint64_t total = 0, chunk = 0;
  if (!scr_par_count(count, grain_given != 0.0, grain, &total, &chunk)) return initial;
  ScrParJob job;
  memset(&job, 0, sizeof job);
  job.kind = SCR_PAR_REDUCE;
  job.part = part;
  job.count = total;
  job.grain = chunk;
  job.nchunks = scr_par_chunks(total, chunk);
  double result = initial;
  if (job.nchunks == 0) return result;
  bool alone = !scr_par_enter();
  bool parallel_ok = parallel != 0.0 && !alone;
  if (!parallel_ok) {
    /* Node's own loop: every chunk's part runs, then its combine, in chunk
     * order. The compiler refused this call, so its callbacks may have
     * effects, share state and throw; running the parts first would reorder
     * them. */
    for (uint64_t i = 0; i < job.nchunks; i++) {
      uint64_t start = i * job.grain;
      uint64_t end = start + job.grain;
      if (end > job.count) end = job.count;
      double value = ((ScrParPart)part->fn)(part, (double)start, (double)end);
      if (scr_exc_pending()) break;
      result = ((ScrParCombine)combine->fn)(combine, result, value);
      if (scr_exc_pending()) break;
    }
    if (!alone) scr_par_leave();
    return result;
  }
  if (job.nchunks > SIZE_MAX / sizeof(double)) scr_trap("scriptc: out of memory\n");
  job.partials = malloc((size_t)job.nchunks * sizeof(double));
  if (job.partials == NULL) scr_trap("scriptc: out of memory\n");
  if (scr_par_dispatch(&job, 0, true)) {
    /* The fold runs on the calling thread, left to right in chunk order:
     * combine has no algebraic requirement and no thread of its own. The
     * callbacks are effect-free by the compiler's proof, so collecting
     * every part first is not observable. */
    for (uint64_t i = 0; i < job.nchunks; i++) {
      result = ((ScrParCombine)combine->fn)(combine, result, job.partials[i]);
      if (scr_exc_pending()) break;
    }
  }
  free(job.partials);
  if (!alone) scr_par_leave();
  return result;
}

void scr_par_for(double count, double grain_given, double grain, double parallel,
                 ScrClosure *body) {
  uint64_t total = 0, chunk = 0;
  if (!scr_par_count(count, grain_given != 0.0, grain, &total, &chunk)) return;
  ScrParJob job;
  memset(&job, 0, sizeof job);
  job.kind = SCR_PAR_FOR;
  job.body = body;
  job.count = total;
  job.grain = chunk;
  job.nchunks = scr_par_chunks(total, chunk);
  if (job.nchunks == 0) return;
  bool alone = !scr_par_enter();
  /* The general form needs a proof about the index expressions a body
   * writes through; it runs sequentially until that exists. */
  bool parallel_ok = parallel != 0.0 && !alone;
  scr_par_dispatch(&job, 0, parallel_ok);
  if (!alone) scr_par_leave();
}
