#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* The parallel-loop unit needs the runtime's allocation and exception cells
 * from the rest of the runtime; the stubs here stand in for them, and the
 * exception they report is one flag the test reads. */

_Noreturn void scr_trap(const char *msg) {
  fputs(msg, stderr);
  abort();
}

static atomic_bool pending;
static char last_message[160];

bool scr_exc_pending(void) { return atomic_load_explicit(&pending, memory_order_acquire); }

void scr_throw_error_msg(int kind, const char *message, size_t len) {
  (void)kind;
  assert(len < sizeof last_message);
  memcpy(last_message, message, len);
  last_message[len] = '\0';
  atomic_store_explicit(&pending, true, memory_order_release);
}

uint64_t scr_hrtime_ns(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint64_t)now.tv_sec * 1000000000u + (uint64_t)now.tv_nsec;
}

size_t scr_bytes_elem_size(ScrBytesElem elem) {
  switch (elem) {
    case SCR_BYTES_U8:
    case SCR_BYTES_I8:
    case SCR_BYTES_U8C:
      return 1;
    case SCR_BYTES_U16:
    case SCR_BYTES_I16:
    case SCR_BYTES_F16:
      return 2;
    case SCR_BYTES_U32:
    case SCR_BYTES_I32:
    case SCR_BYTES_F32:
      return 4;
    case SCR_BYTES_F64:
      return 8;
  }
  return 0;
}

/* A target with no owner: the test's frame owns the elements. */
static ScrBytes *make_f64(size_t len) {
  ScrBytes *bytes = calloc(1, sizeof *bytes);
  bytes->rc = SIZE_MAX;
  bytes->len = len;
  bytes->elem = SCR_BYTES_F64;
  bytes->data = calloc(len == 0 ? 1 : len, sizeof(double));
  return bytes;
}

static ScrClosure closure(void *fn) {
  ScrClosure c;
  memset(&c, 0, sizeof c);
  c.rc = SIZE_MAX;
  c.fn = fn;
  return c;
}

static void clear_exception(void) {
  last_message[0] = '\0';
  atomic_store_explicit(&pending, false, memory_order_release);
}

/* Whether the calling process has helper threads: the harness runs this
 * program twice, once with SCRIPTC_THREADS=1. */
static bool has_helpers(void) {
  const char *env = getenv("SCRIPTC_THREADS");
  return env == NULL || strcmp(env, "1") != 0;
}

/* ── parallelInto: every index written once, in its chunk's view ────── */

enum { INTO_COUNT = 1000, INTO_GRAIN = 7, INTO_CHUNKS = 143 };

static ScrBytes *into_target;
static atomic_int into_chunk_runs[INTO_CHUNKS];

static void into_body(ScrClosure *env, ScrBytes *part, double start, double end) {
  (void)env;
  size_t index = (size_t)start / INTO_GRAIN;
  assert(index < INTO_CHUNKS);
  atomic_fetch_add_explicit(&into_chunk_runs[index], 1, memory_order_relaxed);
  /* The view is the frame's own header: no owner, the target's element
   * kind, and the chunk's slice of the target's storage. */
  assert(part->rc == SIZE_MAX);
  assert(part->external);
  assert(part->backing == NULL);
  assert(part->elem == SCR_BYTES_F64);
  assert(part->len == (size_t)(end - start));
  assert(part->data == into_target->data + (size_t)start * sizeof(double));
  double *elements = (double *)part->data;
  for (size_t k = 0; k < part->len; k++) elements[k] = start + (double)k * 0.5;
}

static void into_writes_each_element_once(void) {
  into_target = make_f64(INTO_COUNT);
  for (int i = 0; i < INTO_CHUNKS; i++) atomic_store(&into_chunk_runs[i], 0);
  ScrClosure body = closure((void *)into_body);
  scr_par_into(into_target, 1.0, 1.0, INTO_GRAIN, 1.0, &body, NULL, 0);
  assert(!scr_exc_pending());
  double *elements = (double *)into_target->data;
  for (size_t i = 0; i < INTO_COUNT; i++) {
    double start = (double)(i / INTO_GRAIN * INTO_GRAIN);
    assert(elements[i] == start + (double)(i % INTO_GRAIN) * 0.5);
  }
  for (int i = 0; i < INTO_CHUNKS; i++) assert(atomic_load(&into_chunk_runs[i]) == 1);
  free(into_target->data);
  free(into_target);
  into_target = NULL;
}

/* ── the default grain, and the last chunk's short view ─────────────── */

enum { FOR_COUNT = 1000 };

static atomic_char for_visited[FOR_COUNT];
static atomic_int for_chunks;

static void for_body(ScrClosure *env, double start, double end) {
  (void)env;
  atomic_fetch_add(&for_chunks, 1);
  assert(end > start);
  assert(end - start <= 4.0); /* ceil(1000 / 256) */
  for (size_t i = (size_t)start; i < (size_t)end; i++) {
    assert(i < FOR_COUNT);
    assert(atomic_exchange(&for_visited[i], 1) == 0);
  }
}

static void for_visits_every_index_once(void) {
  for (int i = 0; i < FOR_COUNT; i++) atomic_store(&for_visited[i], 0);
  atomic_store(&for_chunks, 0);
  ScrClosure body = closure((void *)for_body);
  scr_par_for(FOR_COUNT, 0.0, 0.0, 1.0, &body);
  assert(!scr_exc_pending());
  for (int i = 0; i < FOR_COUNT; i++) assert(atomic_load(&for_visited[i]) == 1);
  /* 1000 indices in chunks of 4, all of them full. */
  assert(atomic_load(&for_chunks) == 250);
}

/* ── stride: count is the target's length divided by it ─────────────── */

enum { STRIDE_LEN = 64, STRIDE = 4, STRIDE_GRAIN = 3, STRIDE_COUNT = 16 };

static ScrBytes *stride_target;
static atomic_int stride_runs[STRIDE_COUNT];

static void stride_body(ScrClosure *env, ScrBytes *part, double start, double end) {
  (void)env;
  size_t index = (size_t)start / STRIDE_GRAIN;
  assert(index < STRIDE_COUNT);
  atomic_fetch_add(&stride_runs[index], 1);
  assert(part->len == (size_t)(end - start) * STRIDE);
  assert(part->data == stride_target->data + (size_t)start * STRIDE * sizeof(double));
  double *elements = (double *)part->data;
  for (size_t k = 0; k < part->len; k++) elements[k] = (double)index + (double)k / 100.0;
}

static void stride_gives_the_whole_stride(void) {
  stride_target = make_f64(STRIDE_LEN);
  for (int i = 0; i < STRIDE_COUNT; i++) atomic_store(&stride_runs[i], 0);
  ScrClosure body = closure((void *)stride_body);
  scr_par_into(stride_target, STRIDE, 1.0, STRIDE_GRAIN, 1.0, &body, NULL, 0);
  assert(!scr_exc_pending());
  /* 16 indices in chunks of 3: six chunks, the last of them a single
   * index whose view is still one whole stride. */
  for (int i = 0; i < 6; i++) assert(atomic_load(&stride_runs[i]) == 1);
  for (int i = 6; i < STRIDE_COUNT; i++) assert(atomic_load(&stride_runs[i]) == 0);
  /* Chunk i's view covers the target's elements [i * 12, i * 12 + 12); its
   * last element of the last chunk stops at the target's length. */
  const double *elements = (const double *)stride_target->data;
  for (size_t e = 0; e < STRIDE_LEN; e++)
    assert(elements[e] == (double)(e / 12) + (double)(e % 12) / 100.0);
  free(stride_target->data);
  free(stride_target);
  stride_target = NULL;
}

/* ── parallelReduce folds left to right in chunk order ──────────────── */

enum { REDUCE_COUNT = 100, REDUCE_GRAIN = 9, REDUCE_CHUNKS = 12 };

static double reduce_part(ScrClosure *env, double start, double end) {
  (void)env;
  return start * 1000.0 + end;
}

static double reduce_combine(ScrClosure *env, double left, double right) {
  (void)env;
  return left * 2.0 + right;
}

/* The fold the Node implementation computes, chunk by chunk. */
static double reduce_expected(void) {
  double result = 7;
  for (double start = 0; start < REDUCE_COUNT; start += REDUCE_GRAIN) {
    double end = start + REDUCE_GRAIN < REDUCE_COUNT ? start + REDUCE_GRAIN : REDUCE_COUNT;
    result = reduce_combine(NULL, result, reduce_part(NULL, start, end));
  }
  return result;
}

static void reduce_folds_in_chunk_order(void) {
  ScrClosure part = closure((void *)reduce_part);
  ScrClosure combine = closure((void *)reduce_combine);
  double expected = reduce_expected();
  for (int pass = 0; pass < 2; pass++) {
    double result =
        scr_par_reduce(REDUCE_COUNT, 1.0, REDUCE_GRAIN, 7, pass == 0 ? 1.0 : 0.0, &part, &combine);
    assert(!scr_exc_pending());
    assert(result == expected);
  }
}

/* A sum of squares agrees to the bit however many threads fold it. */
static double squares_part(ScrClosure *env, double start, double end) {
  (void)env;
  double sum = 0;
  for (double i = start; i < end; i += 1.0) sum += i * i;
  return sum;
}

static double add_combine(ScrClosure *env, double left, double right) {
  (void)env;
  return left + right;
}

static void reduce_is_the_same_number_on_any_pool(void) {
  ScrClosure part = closure((void *)squares_part);
  ScrClosure combine = closure((void *)add_combine);
  double sequential = scr_par_reduce(1000000, 1.0, 4096, 0.0, 0.0, &part, &combine);
  double parallel = scr_par_reduce(1000000, 1.0, 4096, 0.0, 1.0, &part, &combine);
  assert(!scr_exc_pending());
  assert(sequential == parallel);
}

/* ── a read that overlaps the target runs on the calling thread ─────── */

enum { OVERLAP_COUNT = 4000, OVERLAP_GRAIN = 20 };

static pthread_t caller;
static atomic_int off_thread_chunks;
/* Set for the job that must use the helpers, so the calling thread waits
 * for one to claim a chunk instead of racing it to the end of the job.
 * The wait is tried a few times at most, so a pool that never wakes costs
 * the test a bounded delay rather than one per chunk. */
static bool overlap_wait_for_helper;
static int overlap_stalls;

/* Spins for about a microsecond, so the pool's "is the wake-up worth it"
 * estimate sees a job big enough to hand out. */
static void spin(void) {
  volatile unsigned long sink = 0;
  for (unsigned long i = 0; i < 3000; i++) sink += i;
}

static void overlap_body(ScrClosure *env, ScrBytes *part, double start, double end) {
  (void)env;
  if (!pthread_equal(pthread_self(), caller)) {
    atomic_fetch_add(&off_thread_chunks, 1);
  } else if (overlap_wait_for_helper && has_helpers() && start > 0 && overlap_stalls < 5 &&
             atomic_load(&off_thread_chunks) == 0) {
    overlap_stalls++;
    /* Whether a woken helper or the calling thread claims a chunk is a
     * race: the pool broadcasts, and a job of a few hundred chunks can
     * finish here before a helper is scheduled, especially on a loaded
     * machine. Which thread runs a chunk is not observable, so a helper
     * that claims none is not a fault. Yield this chunk for a bounded
     * time so a helper can claim one, since the assertion below is about
     * the pool being used at all. */
    for (int i = 0; i < 1000000 && atomic_load(&off_thread_chunks) == 0; i++) sched_yield();
  }
  double *elements = (double *)part->data;
  for (size_t k = 0; k < part->len; k++) elements[k] = start + (double)k;
  for (size_t i = (size_t)start; i < (size_t)end; i++) assert(elements[i - (size_t)start] >= start);
  spin();
}

static void overlapping_read_runs_alone(void) {
  ScrBytes *target = make_f64(OVERLAP_COUNT);
  ScrBytes *read = target; /* the body reads the target itself */
  ScrClosure body = closure((void *)overlap_body);
  caller = pthread_self();
  /* Without the read, the job is big enough to use the helpers. */
  atomic_store(&off_thread_chunks, 0);
  overlap_stalls = 0;
  overlap_wait_for_helper = true;
  scr_par_into(target, 1.0, 1.0, OVERLAP_GRAIN, 1.0, &body, NULL, 0);
  overlap_wait_for_helper = false;
  assert(!scr_exc_pending());
  if (has_helpers()) assert(atomic_load(&off_thread_chunks) > 0);
  const double *elements = (const double *)target->data;
  for (size_t i = 0; i < OVERLAP_COUNT; i++) assert(elements[i] == (double)i);
  /* With it, every chunk stays on this thread, and the result is the same. */
  atomic_store(&off_thread_chunks, 0);
  ScrBytes *reads[1] = {read};
  scr_par_into(target, 1.0, 1.0, OVERLAP_GRAIN, 1.0, &body, reads, 1);
  assert(!scr_exc_pending());
  assert(atomic_load(&off_thread_chunks) == 0);
  for (size_t i = 0; i < OVERLAP_COUNT; i++) assert(elements[i] == (double)i);
  free(target->data);
  free(target);
}

/* ── one job at a time: a nested call runs on its own thread ────────── */

static atomic_int nested_runs;

static void nested_body(ScrClosure *env, double start, double end) {
  (void)env;
  assert(end > start);
  atomic_fetch_add(&nested_runs, 1);
}

static void outer_body(ScrClosure *env, ScrBytes *part, double start, double end) {
  (void)env;
  (void)part;
  (void)start;
  (void)end;
  ScrClosure body = closure((void *)nested_body);
  scr_par_for(8, 1.0, 2.0, 1.0, &body);
  assert(!scr_exc_pending());
}

static void nested_calls_run_one_after_another(void) {
  ScrBytes *target = make_f64(64);
  ScrClosure body = closure((void *)outer_body);
  atomic_store(&nested_runs, 0);
  scr_par_into(target, 1.0, 1.0, 8.0, 1.0, &body, NULL, 0);
  assert(!scr_exc_pending());
  /* Eight chunks of the outer call, each running four chunks of its own. */
  assert(atomic_load(&nested_runs) == 8 * 4);
  free(target->data);
  free(target);
}

/* ── argument errors: the Node implementation's message, no chunk ───── */

static atomic_int error_chunks;

static void counting_body(ScrClosure *env, ScrBytes *part, double start, double end) {
  (void)env;
  (void)part;
  (void)start;
  (void)end;
  atomic_fetch_add(&error_chunks, 1);
}

static void range_body(ScrClosure *env, double start, double end) {
  (void)env;
  (void)start;
  (void)end;
  atomic_fetch_add(&error_chunks, 1);
}

static void expect_range_error(void (*call)(void)) {
  clear_exception();
  atomic_store(&error_chunks, 0);
  call();
  assert(scr_exc_pending());
  assert(atomic_load(&error_chunks) == 0);
}

static ScrBytes *error_target;
static ScrClosure error_body;
static ScrClosure error_range;

static void call_into_bad_stride(void) {
  scr_par_into(error_target, 0.0, 0.0, 1.0, 1.0, &error_body, NULL, 0);
}
static void call_into_fractional_stride(void) {
  scr_par_into(error_target, 2.5, 0.0, 1.0, 1.0, &error_body, NULL, 0);
}
static void call_into_undividing_stride(void) {
  scr_par_into(error_target, 3.0, 0.0, 1.0, 1.0, &error_body, NULL, 0);
}
static void call_into_zero_grain(void) {
  scr_par_into(error_target, 1.0, 1.0, 0.0, 1.0, &error_body, NULL, 0);
}
static void call_into_fractional_grain(void) {
  scr_par_into(error_target, 1.0, 1.0, 1.5, 1.0, &error_body, NULL, 0);
}
static void call_negative_count(void) {
  scr_par_for(-1.0, 0.0, 0.0, 1.0, &error_range);
}
static void call_fractional_count(void) {
  scr_par_for(2.5, 0.0, 0.0, 1.0, &error_range);
}
static void call_negative_grain(void) {
  scr_par_reduce(10.0, 1.0, -2.0, 0.0, 1.0, &error_range, &error_range);
}

static void bad_arguments_throw_before_the_first_chunk(void) {
  error_target = make_f64(10);
  error_body = closure((void *)counting_body);
  error_range = closure((void *)range_body);
  expect_range_error(call_into_bad_stride);
  expect_range_error(call_into_fractional_stride);
  expect_range_error(call_into_undividing_stride);
  expect_range_error(call_into_zero_grain);
  expect_range_error(call_into_fractional_grain);
  expect_range_error(call_negative_count);
  expect_range_error(call_fractional_count);
  expect_range_error(call_negative_grain);
  assert(scr_exc_pending());
  assert(strcmp(last_message, "grain must be a positive integer") == 0);
  free(error_target->data);
  free(error_target);
  error_target = NULL;
}

/* ── the empty job, and a grain larger than the count ───────────────── */

static void empty_and_single_chunk_jobs(void) {
  clear_exception();
  ScrBytes *empty = make_f64(0);
  ScrClosure body = closure((void *)counting_body);
  atomic_store(&error_chunks, 0);
  scr_par_into(empty, 1.0, 1.0, 4.0, 1.0, &body, NULL, 0);
  assert(!scr_exc_pending());
  assert(atomic_load(&error_chunks) == 0);
  ScrBytes *small = make_f64(5);
  scr_par_into(small, 1.0, 1.0, 16.0, 1.0, &body, NULL, 0);
  assert(!scr_exc_pending());
  assert(atomic_load(&error_chunks) == 1);
  free(empty->data);
  free(empty);
  free(small->data);
  free(small);
}

/* ── a sequential body that throws stops the loop ───────────────────── */

static atomic_int throwing_chunks;

static void throwing_body(ScrClosure *env, double start, double end) {
  (void)env;
  (void)end;
  atomic_fetch_add(&throwing_chunks, 1);
  if (start == 4.0) scr_throw_error_msg(SCR_ERR_ERROR, "stop", 4);
}

static void sequential_bodies_stop_at_their_throw(void) {
  ScrClosure body = closure((void *)throwing_body);
  clear_exception();
  atomic_store(&throwing_chunks, 0);
  /* parallel is 0: a body the compiler refused may throw, and its chunks
   * run here, one after another, up to the one that throws. */
  scr_par_for(40, 1.0, 4.0, 0.0, &body);
  assert(scr_exc_pending());
  assert(atomic_load(&throwing_chunks) == 2);
  assert(strcmp(last_message, "stop") == 0);
}

int main(void) {
  into_writes_each_element_once();
  for_visits_every_index_once();
  stride_gives_the_whole_stride();
  reduce_folds_in_chunk_order();
  reduce_is_the_same_number_on_any_pool();
  overlapping_read_runs_alone();
  nested_calls_run_one_after_another();
  bad_arguments_throw_before_the_first_chunk();
  empty_and_single_chunk_jobs();
  sequential_bodies_stop_at_their_throw();
  puts("parallel loops run every chunk once, in order, on any pool");
  return 0;
}
