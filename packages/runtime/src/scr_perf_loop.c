/* node:perf_hooks event-loop metrics: performance.eventLoopUtilization()
 * and monitorEventLoopDelay()'s IntervalHistogram.
 *
 * Event-loop utilization. Node measures idle time as the time its loop
 * spends blocked in the poll phase. A compiled program's main thread is
 * busy exactly while it runs on the CPU (or blocks in a synchronous call),
 * so the thread's CPU time stands in for Node's active time: idle is the
 * wall time since the loop started minus that CPU time. The loop start is
 * marked by the emitted main just before the loop runs, and only in
 * programs that ask for the metric; before it, utilization is all zeros,
 * like Node during the main module's synchronous evaluation.
 *
 * Event-loop delay. Each histogram samples on an unref'd interval at its
 * resolution and records the time between samples in nanoseconds, like
 * Node's ELDHistogram (Histogram::RecordDelta). Values land in an
 * HdrHistogram-shaped counts array (lowest 1, three significant figures:
 * 2048 sub-buckets per power of two), so min, max, mean, stddev and
 * percentiles answer the bucket values Node's hdr_histogram answers. */

#include "scr_runtime.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#endif

/* ── event-loop utilization ─────────────────────────────────────────── */

static SCR_TL double scr_perf_loop_start_ms = 0; /* performance.now() at loop start */
static SCR_TL double scr_perf_loop_cpu0_ms = 0;  /* thread CPU time at loop start */

/* The calling thread's CPU time in milliseconds; 0 where unavailable. */
static double scr_perf_thread_cpu_ms(void) {
#if defined(_WIN32)
  FILETIME created, exited, kernel, user;
  if (!GetThreadTimes(GetCurrentThread(), &created, &exited, &kernel, &user)) return 0;
  ULARGE_INTEGER k, u;
  k.LowPart = kernel.dwLowDateTime;
  k.HighPart = kernel.dwHighDateTime;
  u.LowPart = user.dwLowDateTime;
  u.HighPart = user.dwHighDateTime;
  return (double)(k.QuadPart + u.QuadPart) / 1e4; /* 100ns units */
#elif defined(CLOCK_THREAD_CPUTIME_ID) && !defined(__wasi__)
  struct timespec ts;
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0) return 0;
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#else
  return 0;
#endif
}

void scr_perf_loop_mark(void) {
  if (scr_perf_loop_start_ms > 0) return;
  scr_perf_loop_cpu0_ms = scr_perf_thread_cpu_ms();
  double now = scr_perf_now();
  /* Node's loopStart is positive once set; a mark at the very first
   * microsecond still counts as started. */
  scr_perf_loop_start_ms = now > 0 ? now : 1e-6;
}

double scr_perf_loop_start(void) { return scr_perf_loop_start_ms; }

double scr_perf_idle_time(void) {
  if (scr_perf_loop_start_ms <= 0) return 0;
  double wall = scr_perf_now() - scr_perf_loop_start_ms;
  double busy = scr_perf_thread_cpu_ms() - scr_perf_loop_cpu0_ms;
  double idle = wall - busy;
  if (idle < 0) idle = 0;
  if (idle > wall) idle = wall;
  return idle;
}

/* ── HdrHistogram-shaped counts (lowest 1, 3 significant figures) ───── */

#define SCR_HDR_SUB_BUCKET_HALF_MAG 10
#define SCR_HDR_SUB_BUCKET_HALF (1 << SCR_HDR_SUB_BUCKET_HALF_MAG) /* 1024 */
#define SCR_HDR_SUB_BUCKET_COUNT (SCR_HDR_SUB_BUCKET_HALF * 2)     /* 2048 */
#define SCR_HDR_SUB_BUCKET_MASK ((int64_t)SCR_HDR_SUB_BUCKET_COUNT - 1)

typedef struct {
  int64_t *counts; /* owned, grown on demand */
  size_t counts_len;
  int64_t total;
  int64_t min_value; /* INT64_MAX while empty */
  int64_t max_value; /* 0 while empty */
  double count;      /* Node's count_ (successful records) */
  uint64_t prev_ns;  /* RecordDelta's previous sample; 0 = none */
  double resolution; /* ms */
  double timer;      /* the sampling interval's handle while enabled, else 0 */
  ScrClosure *tick;  /* owned: the sampling callback, identifies this histogram */
  bool enabled;
} ScrEld;

static int scr_hdr_bucket_index(int64_t value) {
  int pow2ceiling = 64 - __builtin_clzll((uint64_t)(value | SCR_HDR_SUB_BUCKET_MASK));
  return pow2ceiling - (SCR_HDR_SUB_BUCKET_HALF_MAG + 1);
}

static size_t scr_hdr_counts_index(int64_t value) {
  int bucket = scr_hdr_bucket_index(value);
  int64_t sub = value >> bucket;
  return (size_t)(((int64_t)(bucket + 1) << SCR_HDR_SUB_BUCKET_HALF_MAG) + (sub - SCR_HDR_SUB_BUCKET_HALF));
}

static int64_t scr_hdr_value_at_index(size_t index) {
  int bucket = (int)(index >> SCR_HDR_SUB_BUCKET_HALF_MAG) - 1;
  int64_t sub = (int64_t)(index & (SCR_HDR_SUB_BUCKET_HALF - 1)) + SCR_HDR_SUB_BUCKET_HALF;
  if (bucket < 0) {
    sub -= SCR_HDR_SUB_BUCKET_HALF;
    bucket = 0;
  }
  return sub << bucket;
}

static int64_t scr_hdr_range_size(int64_t value) {
  int bucket = scr_hdr_bucket_index(value);
  int64_t sub = value >> bucket;
  int adjusted = sub >= SCR_HDR_SUB_BUCKET_COUNT ? bucket + 1 : bucket;
  return (int64_t)1 << adjusted;
}

static int64_t scr_hdr_lowest_equivalent(int64_t value) {
  int bucket = scr_hdr_bucket_index(value);
  int64_t sub = value >> bucket;
  return sub << bucket;
}

static int64_t scr_hdr_highest_equivalent(int64_t value) {
  return scr_hdr_lowest_equivalent(value) + scr_hdr_range_size(value) - 1;
}

static int64_t scr_hdr_median_equivalent(int64_t value) {
  return scr_hdr_lowest_equivalent(value) + (scr_hdr_range_size(value) >> 1);
}

/* Newton's square root: keeps this unit free of a libm reference. */
static double scr_eld_sqrt(double x) {
  if (!(x > 0)) return x == 0 ? 0 : NAN;
  double r = x >= 1 ? x : 1;
  for (int i = 0; i < 64; i++) {
    double next = 0.5 * (r + x / r);
    if (next == r) break;
    r = next;
  }
  return r;
}

static void scr_eld_record(ScrEld *h, int64_t value) {
  if (value < 0) return;
  size_t index = scr_hdr_counts_index(value);
  if (index >= h->counts_len) {
    size_t len = h->counts_len ? h->counts_len : SCR_HDR_SUB_BUCKET_COUNT;
    while (len <= index) len *= 2;
    int64_t *grown = realloc(h->counts, len * sizeof(int64_t));
    if (grown == NULL) return;
    for (size_t i = h->counts_len; i < len; i++) grown[i] = 0;
    h->counts = grown;
    h->counts_len = len;
  }
  h->counts[index]++;
  h->total++;
  if (value != 0 && value < h->min_value) h->min_value = value;
  if (value > h->max_value) h->max_value = value;
  h->count += 1;
}

static void scr_eld_clear(ScrEld *h) {
  for (size_t i = 0; i < h->counts_len; i++) h->counts[i] = 0;
  h->total = 0;
  h->min_value = INT64_MAX;
  h->max_value = 0;
  h->count = 0;
  h->prev_ns = 0;
}

/* ── monitorEventLoopDelay ──────────────────────────────────────────── */

static SCR_TL ScrEld **scr_elds;
static SCR_TL size_t scr_elds_len;

static ScrEld *scr_eld_of(double handle) {
  if (!(handle >= 1) || handle > (double)scr_elds_len) return NULL;
  return scr_elds[(size_t)handle - 1];
}

static void scr_eld_tick(ScrClosure *self) {
  for (size_t i = 0; i < scr_elds_len; i++) {
    ScrEld *h = scr_elds[i];
    if (h->tick != self) continue;
    uint64_t now = scr_hrtime_ns();
    if (h->prev_ns > 0 && now > h->prev_ns) scr_eld_record(h, (int64_t)(now - h->prev_ns));
    h->prev_ns = now;
    return;
  }
}

/* Histograms live for the thread's lifetime (Node frees them with their
 * JS object); release them when the script ends so their callbacks and
 * counts do not outlive it. */
static void scr_eld_cleanup(void) {
  for (size_t i = 0; i < scr_elds_len; i++) {
    ScrEld *h = scr_elds[i];
    scr_closure_release(h->tick);
    free(h->counts);
    free(h);
  }
  free(scr_elds);
  scr_elds = NULL;
  scr_elds_len = 0;
}

/* Node's validateInteger(resolution, 'options.resolution', 1): a catchable
 * RangeError (ERR_OUT_OF_RANGE) for a non-integer or a value out of range,
 * with the value as util.inspect renders it ("-0" included). */
static bool scr_eld_resolution_ok(double resolution) {
  bool integer = isfinite(resolution) && trunc(resolution) == resolution;
  if (integer && resolution >= 1 && resolution <= 9007199254740991.0) return true;
  char received[48];
  if (resolution == 0 && signbit(resolution))
    memcpy(received, "-0", 3);
  else
    scr_num_received(resolution, received);
  char msg[192];
  int len = snprintf(msg, sizeof msg,
                     "The value of \"options.resolution\" is out of range. It must be %s. Received %s",
                     integer ? ">= 1 && <= 9007199254740991" : "an integer", received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

double scr_eld_new(double resolution) {
  if (!scr_eld_resolution_ok(resolution)) return 0;
  if (scr_elds_len == 0 && scr_elds == NULL) scr_atexit(scr_eld_cleanup);
  ScrEld *h = calloc(1, sizeof(ScrEld));
  ScrEld **grown = realloc(scr_elds, (scr_elds_len + 1) * sizeof(ScrEld *));
  if (h == NULL || grown == NULL) {
    free(h);
    if (grown != NULL) scr_elds = grown;
    return 0;
  }
  scr_elds = grown;
  h->min_value = INT64_MAX;
  h->resolution = resolution;
  h->tick = scr_closure_new((void *)scr_eld_tick, 0);
  scr_elds[scr_elds_len++] = h;
  return (double)scr_elds_len;
}

bool scr_eld_enable(double handle) {
  ScrEld *h = scr_eld_of(handle);
  if (h == NULL || h->enabled) return false;
  h->enabled = true;
  h->timer = scr_set_interval(scr_closure_retain(h->tick), h->resolution);
  scr_timer_unref(h->timer);
  return true;
}

bool scr_eld_disable(double handle) {
  ScrEld *h = scr_eld_of(handle);
  if (h == NULL || !h->enabled) return false;
  h->enabled = false;
  scr_clear_interval(h->timer);
  h->timer = 0;
  return true;
}

void scr_eld_reset(double handle) {
  ScrEld *h = scr_eld_of(handle);
  if (h != NULL) scr_eld_clear(h);
}

/* Node's event-loop-delay histogram has a lowest discernible value of 1000 ns
 * (Histogram::Options { 1000 }): its smallest bucket spans 0..511, so an empty
 * histogram answers 511 for every percentile. Recorded deltas are at least the
 * resolution (>= 1 ms), where that layout and this one share bucket bounds. */
#define SCR_ELD_EMPTY_PERCENTILE 511

/* hdr_value_at_percentile; the compiler checked Node's 0 < p <= 100 range. */
double scr_eld_percentile(double handle, double percentile) {
  ScrEld *h = scr_eld_of(handle);
  if (h == NULL || h->total == 0) return SCR_ELD_EMPTY_PERCENTILE;
  double requested = percentile < 100.0 ? percentile : 100.0;
  int64_t wanted = (int64_t)((requested / 100.0) * (double)h->total + 0.5);
  if (wanted < 1) wanted = 1;
  int64_t seen = 0;
  for (size_t i = 0; i < h->counts_len; i++) {
    seen += h->counts[i];
    if (seen >= wanted) return (double)scr_hdr_highest_equivalent(scr_hdr_value_at_index(i));
  }
  return 0;
}

/* which: 0 min, 1 max, 2 mean, 3 stddev, 4 count, 5 exceeds. */
double scr_eld_stat(double handle, double which) {
  ScrEld *h = scr_eld_of(handle);
  int w = (int)which;
  if (h == NULL) return w == 0 ? (double)INT64_MAX : w >= 2 && w <= 3 ? NAN : 0;
  switch (w) {
    case 0:
      if (h->counts_len > 0 && h->counts[0] > 0) return 0;
      return h->min_value == INT64_MAX ? (double)INT64_MAX
                                       : (double)scr_hdr_lowest_equivalent(h->min_value);
    case 1:
      return h->max_value == 0 ? 0 : (double)scr_hdr_highest_equivalent(h->max_value);
    case 2:
    case 3: {
      if (h->total == 0) return NAN;
      double sum = 0;
      for (size_t i = 0; i < h->counts_len; i++) {
        if (h->counts[i] == 0) continue;
        sum += (double)h->counts[i] * (double)scr_hdr_median_equivalent(scr_hdr_value_at_index(i));
      }
      double mean = sum / (double)h->total;
      if (w == 2) return mean;
      double geo = 0;
      for (size_t i = 0; i < h->counts_len; i++) {
        if (h->counts[i] == 0) continue;
        double dev = (double)scr_hdr_median_equivalent(scr_hdr_value_at_index(i)) - mean;
        geo += dev * dev * (double)h->counts[i];
      }
      return scr_eld_sqrt(geo / (double)h->total);
    }
    case 4:
      return h->count;
    default:
      return 0;
  }
}
