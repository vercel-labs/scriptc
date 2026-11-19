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
static SCR_TL double scr_perf_loop_exit_ms = -1; /* performance.now() at loop exit */
static SCR_TL double scr_perf_loop_turns = 0;    /* loop turns taken */

/* The loop's per-turn and exit hooks (scr_async.c calls them when set): one
 * turn is one iteration of the loop, its end is when the loop stops with
 * work left to do. A worker thread also publishes the snapshot its creator
 * reads through worker.performance (scr_worker.c installs the hook), which
 * advances only as the loop turns, as Node's metrics do. */
static void scr_perf_loop_turn(void) {
  scr_perf_loop_turns += 1;
  if (scr_context_publish_loop_metrics)
    scr_context_publish_loop_metrics(scr_perf_loop_start_ms, scr_perf_idle_time());
}

static void scr_perf_loop_exit_mark(void) {
  if (scr_perf_loop_exit_ms < 0) scr_perf_loop_exit_ms = scr_perf_now();
}

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
  scr_loop_set_metrics_hooks(scr_perf_loop_turn, scr_perf_loop_exit_mark);
  scr_perf_loop_cpu0_ms = scr_perf_thread_cpu_ms();
  double now = scr_perf_now();
  /* Node's loopStart is positive once set; a mark at the very first
   * microsecond still counts as started. */
  scr_perf_loop_start_ms = now > 0 ? now : 1e-6;
}

/* A program whose main never runs the loop (a synchronous program that
 * reads the milestones only from its exit listeners): the emitted main
 * calls this just before those listeners run, so the loop's end is the
 * moment Node's loop would have stopped. */
void scr_perf_loop_end(void) { scr_perf_loop_exit_mark(); }

double scr_perf_loop_start(void) { return scr_perf_loop_start_ms; }

/* performance.nodeTiming's loopStart: -1 until the loop starts, like Node. */
double scr_perf_node_loop_start(void) { return scr_perf_loop_start_ms > 0 ? scr_perf_loop_start_ms : -1; }

/* performance.nodeTiming's loopExit: -1 until the loop ends. */
double scr_perf_loop_exit(void) { return scr_perf_loop_exit_ms; }

/* performance.nodeTiming's uvMetricsInfo.loopCount: the turns taken. */
double scr_perf_loop_count(void) { return scr_perf_loop_turns; }

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
  size_t rc; /* the handle box and, while enabled, the sampling timer */
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

static void scr_histo_install(void);
/* the checked-dynamic reads of both histogram classes (defined below) */
static ScrDyn *scr_histo_get(void *ptr, const char *key, size_t length);
static ScrDyn *scr_eld_get(void *ptr, const char *key, size_t length);

static SCR_TL ScrEld **scr_elds;
static SCR_TL size_t scr_elds_len;

/* A histogram value is a refcounted runtime object behind a checked-dynamic
 * handle. The registry only finds the object a sampling tick belongs to;
 * the handle box owns the object, and the timer owns one while enabled, so
 * a dropped histogram is freed with its last reference instead of living
 * in a table until exit. */
static ScrEld *scr_eld_of(const ScrDyn *handle) {
  if (handle == NULL || handle->kind != SCR_DYN_HANDLE ||
      handle->v.handle.tag != SCR_DYNH_ELD_HISTOGRAM)
    return NULL;
  return handle->v.handle.ptr;
}

static void scr_eld_registry_remove(ScrEld *h) {
  for (size_t i = 0; i < scr_elds_len; i++) {
    if (scr_elds[i] != h) continue;
    scr_elds[i] = scr_elds[--scr_elds_len];
    return;
  }
}

static void scr_eld_free(ScrEld *h) {
  scr_eld_registry_remove(h);
  scr_closure_release(h->tick);
  free(h->counts);
  free(h);
}

static void *scr_eld_retain_v(void *p) {
  ((ScrEld *)p)->rc++;
  return p;
}

static void scr_eld_release_v(void *p) {
  ScrEld *h = p;
  if (h == NULL || --h->rc > 0) return;
  scr_eld_free(h);
}

static const ScrDynHandleOps scr_eld_ops = {
    .cls = "IntervalHistogram",
    .retain = scr_eld_retain_v,
    .release = scr_eld_release_v,
    .get = scr_eld_get,
};

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
 * JS object); when the script ends, stop their timers and drop the timer's
 * reference, leaving each object to its remaining holders (the box, a
 * reference a callback kept). Freeing them here would hand a live holder a
 * dangling pointer. */
static void scr_eld_cleanup(void) {
  ScrEld **entries = scr_elds;
  size_t count = scr_elds_len;
  scr_elds = NULL;
  scr_elds_len = 0;
  for (size_t i = 0; i < count; i++) {
    ScrEld *h = entries[i];
    if (!h->enabled) continue;
    h->enabled = false;
    scr_clear_interval(h->timer);
    h->timer = 0;
    scr_eld_release_v(h); /* the timer's reference */
  }
  free(entries);
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

ScrDyn *scr_eld_new(double resolution) {
  if (!scr_eld_resolution_ok(resolution)) return NULL;
  scr_histo_install();
  if (scr_elds_len == 0 && scr_elds == NULL) scr_atexit(scr_eld_cleanup);
  ScrEld *h = calloc(1, sizeof(ScrEld));
  ScrEld **grown = realloc(scr_elds, (scr_elds_len + 1) * sizeof(ScrEld *));
  if (h == NULL || grown == NULL) {
    free(h);
    if (grown != NULL) scr_elds = grown;
    static const char msg[] = "Memory allocation failed";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1,
                             "ERR_MEMORY_ALLOCATION_FAILED");
    return NULL;
  }
  scr_elds = grown;
  h->min_value = INT64_MAX;
  h->resolution = resolution;
  h->tick = scr_closure_new((void *)scr_eld_tick, 0);
  h->rc = 1;
  scr_elds[scr_elds_len++] = h;
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_ELD_HISTOGRAM);
  if (box == NULL) {
    scr_eld_free(h);
    return NULL;
  }
  scr_eld_release_v(h); /* the box holds the one live reference */
  return box;
}

bool scr_eld_enable(ScrDyn *handle) {
  ScrEld *h = scr_eld_of(handle);
  if (h == NULL || h->enabled) return false;
  h->enabled = true;
  h->rc++; /* the sampling timer keeps the histogram alive */
  /* Node's ELDHistogram::OnStart arms the timer and nothing else: the
   * first tick's RecordDelta has no previous reading to difference
   * against, so it records nothing, and prev_ns survives a disable (a
   * re-enabled histogram's first sample spans the disabled period), as
   * Node's does. */
  h->timer = scr_set_interval(scr_closure_retain(h->tick), h->resolution);
  scr_timer_unref(h->timer);
  return true;
}

bool scr_eld_disable(ScrDyn *handle) {
  ScrEld *h = scr_eld_of(handle);
  if (h == NULL || !h->enabled) return false;
  h->enabled = false;
  scr_clear_interval(h->timer);
  h->timer = 0;
  scr_eld_release_v(h); /* drop the timer's reference */
  return true;
}

void scr_eld_reset(ScrDyn *handle) {
  ScrEld *h = scr_eld_of(handle);
  if (h != NULL) scr_eld_clear(h);
}

/* Node's event-loop-delay histogram has a lowest discernible value of 1000 ns
 * (Histogram::Options { 1000 }): its smallest bucket spans 0..511, so an empty
 * histogram answers 511 for every percentile. Recorded deltas are at least the
 * resolution (>= 1 ms), where that layout and this one share bucket bounds. */
#define SCR_ELD_EMPTY_PERCENTILE 511

/* hdr_value_at_percentile in the bucket's exact int64 value (the BigInt
 * answer); the compiler checked Node's 0 < p <= 100 range. */
static int64_t scr_eld_percentile_i64(const ScrEld *h, double percentile) {
  if (h == NULL || h->total == 0) return SCR_ELD_EMPTY_PERCENTILE;
  double requested = percentile < 100.0 ? percentile : 100.0;
  int64_t wanted = (int64_t)((requested / 100.0) * (double)h->total + 0.5);
  if (wanted < 1) wanted = 1;
  int64_t seen = 0;
  for (size_t i = 0; i < h->counts_len; i++) {
    seen += h->counts[i];
    if (seen >= wanted) return scr_hdr_highest_equivalent(scr_hdr_value_at_index(i));
  }
  return 0;
}

double scr_eld_percentile(ScrDyn *handle, double percentile) {
  return (double)scr_eld_percentile_i64(scr_eld_of(handle), percentile);
}

/* which: 0 min, 1 max, 2 mean, 3 stddev, 4 count, 5 exceeds. */
double scr_eld_stat(ScrDyn *handle, double which) {
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
    case 6:
    case 7: {
      if (h->total == 0) return 0;
      /* Node answers kurtosis only from four samples; fewer read 0. */
      if (w == 7 && h->total < 4) return 0;
      double n = (double)h->total;
      double mean = 0;
      for (size_t i = 0; i < h->counts_len; i++) {
        if (h->counts[i] == 0) continue;
        mean += (double)h->counts[i] *
                (double)scr_hdr_median_equivalent(scr_hdr_value_at_index(i));
      }
      mean /= n;
      double m2 = 0, m3 = 0, m4 = 0;
      for (size_t i = 0; i < h->counts_len; i++) {
        if (h->counts[i] == 0) continue;
        double dev = (double)scr_hdr_median_equivalent(scr_hdr_value_at_index(i)) - mean;
        double c = (double)h->counts[i];
        m2 += c * dev * dev;
        m3 += c * dev * dev * dev;
        m4 += c * dev * dev * dev * dev;
      }
      m2 /= n;
      m3 /= n;
      m4 /= n;
      {
        double sd = scr_eld_sqrt(m2);
        if (!(sd > 0)) return 0;
        return w == 6 ? m3 / (sd * sd * sd) : m4 / (sd * sd * sd * sd) - 3.0;
      }
    }
    default:
      return 0;
  }
}

/* ── perf_hooks histograms (createHistogram) ──────────────────────────
 * Node's Histogram is an HdrHistogram: a counts array over a bucket layout
 * set by the lowest discernible value and the number of significant
 * figures. createHistogram's defaults (lowest 1, highest
 * Number.MAX_SAFE_INTEGER, figures 3) give the same 2048 sub-buckets per
 * power of two as the event-loop histogram above; other options change the
 * unit magnitude and sub-bucket count, so the layout arithmetic lives here
 * in its general form (hdr_calculate_bucket_config, counts_index_for and
 * value_at_index). Every reading answers the bucket values Node's
 * hdr_histogram answers. */

typedef struct {
  int64_t *counts; /* owned, counts_len entries */
  int64_t counts_len;
  int64_t total;      /* hdr's total_count */
  int64_t min_value;  /* INT64_MAX while empty */
  int64_t max_value;  /* 0 while empty */
  int64_t exceeds;    /* records above highest */
  int64_t lowest;
  int64_t highest;
  int32_t unit_magnitude;
  int32_t sub_bucket_half_count_magnitude;
  int32_t sub_bucket_half_count;
  int32_t sub_bucket_count;
  int64_t sub_bucket_mask;
  uint64_t prev_ns; /* RecordDelta's previous sample; 0 = none */
  bool disposed;
  /* The percentiles view: hdr_iter_percentile's (percentile, value) ticks,
   * rebuilt by scr_histo_percentiles_count and read by the two accessors. */
  double *view_key;   /* owned */
  int64_t *view_value; /* owned */
  size_t view_len;
  size_t view_cap;
  size_t rc; /* the checked-dynamic handle box */
} ScrHisto;

/* A createHistogram value is a refcounted runtime object behind a
 * checked-dynamic handle, like the event-loop histogram: its buckets are
 * freed with the last reference, so a short-lived histogram does not stay
 * in a thread table until exit. */
static ScrHisto *scr_histo_of(const ScrDyn *handle) {
  if (handle == NULL || handle->kind != SCR_DYN_HANDLE ||
      handle->v.handle.tag != SCR_DYNH_HISTOGRAM)
    return NULL;
  ScrHisto *h = handle->v.handle.ptr;
  return h == NULL || h->disposed ? NULL : h;
}

static void scr_histo_free(ScrHisto *h);

static void *scr_histo_retain_v(void *p) {
  ((ScrHisto *)p)->rc++;
  return p;
}

static void scr_histo_release_v(void *p) {
  ScrHisto *h = p;
  if (h == NULL || --h->rc > 0) return;
  scr_histo_free(h);
}

/* A checked-dynamic read (`(h: any).count`, `h["mean"]`) answers the same
 * readings as the typed lowering: the six numeric properties and the four
 * BigInt ones. Any other name is not modeled (the caller answers undefined
 * for a miss, as for every handle). */
static ScrDyn *scr_histo_reading(ScrDynHandleTag tag, void *ptr, const char *key, size_t length) {
  static const char *const names[] = {"count",    "min",   "max",      "mean",
                                     "stddev",   "exceeds", "skewness", "kurtosis"};
  static const int which[] = {0, 1, 2, 3, 4, 5, 6, 7};
  static const char *const big_names[] = {"countBigInt", "minBigInt", "maxBigInt", "exceedsBigInt"};
  static const int big_which[] = {0, 1, 2, 5};
  ScrDyn probe;
  memset(&probe, 0, sizeof probe);
  probe.kind = SCR_DYN_HANDLE;
  probe.v.handle.tag = tag;
  probe.v.handle.ptr = ptr;
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
    if (strlen(names[i]) == length && memcmp(names[i], key, length) == 0)
      return scr_dyn_new_num(scr_histo_stat(&probe, (double)which[i]));
  for (size_t i = 0; i < sizeof big_names / sizeof big_names[0]; i++) {
    if (strlen(big_names[i]) != length || memcmp(big_names[i], key, length) != 0) continue;
    ScrBigInt *reading = scr_histo_stat_big(&probe, (double)big_which[i]);
    if (reading == NULL) return NULL;
    ScrDyn *out = scr_dyn_new_bigint(reading);
    scr_bigint_release(reading);
    return out;
  }
  return NULL;
}

static ScrDyn *scr_histo_get(void *ptr, const char *key, size_t length) {
  return scr_histo_reading(SCR_DYNH_HISTOGRAM, ptr, key, length);
}

static ScrDyn *scr_eld_get(void *ptr, const char *key, size_t length) {
  return scr_histo_reading(SCR_DYNH_ELD_HISTOGRAM, ptr, key, length);
}

static const ScrDynHandleOps scr_histo_ops = {
    .cls = "RecordableHistogram",
    .retain = scr_histo_retain_v,
    .release = scr_histo_release_v,
    .get = scr_histo_get,
};

/* The dyn handle table needs each tag's ops before the first box is made
 * (scr_dyn_new_handle aborts otherwise). Both histogram classes install
 * together on the first constructor call. */
static SCR_TL bool scr_histo_ops_installed;

static void scr_histo_install(void) {
  if (scr_histo_ops_installed) return;
  scr_histo_ops_installed = true;
  scr_dyn_handle_install(SCR_DYNH_HISTOGRAM, &scr_histo_ops);
  scr_dyn_handle_install(SCR_DYNH_ELD_HISTOGRAM, &scr_eld_ops);
}

static int scr_histo_log2_floor(int64_t value) {
  int bits = 0;
  while (value > 1) {
    value >>= 1;
    bits++;
  }
  return bits;
}

static int scr_histo_log2_ceil(int64_t value) {
  int bits = scr_histo_log2_floor(value);
  return ((int64_t)1 << bits) < value ? bits + 1 : bits;
}

/* hdr_calculate_bucket_config; false for the configurations hdr_init
 * refuses (ERR_INVALID_ARG_VALUE from Node's _Histogram constructor). */
static bool scr_histo_config(ScrHisto *h, int64_t lowest, int64_t highest, int figures) {
  /* highest >= 2 * lowest, written overflow-safe (lowest may be near
   * INT64_MAX; Node's own check multiplies and can overflow). */
  if (lowest < 1 || figures < 1 || figures > 5 || lowest > highest / 2) return false;
  int64_t largest_single_unit = 2;
  for (int i = 0; i < figures; i++) largest_single_unit *= 10;
  int32_t sub_bucket_count_magnitude = scr_histo_log2_ceil(largest_single_unit);
  h->sub_bucket_half_count_magnitude =
      (sub_bucket_count_magnitude > 1 ? sub_bucket_count_magnitude : 1) - 1;
  h->unit_magnitude = scr_histo_log2_floor(lowest);
  if (h->unit_magnitude + h->sub_bucket_half_count_magnitude > 61) return false;
  h->sub_bucket_count = (int32_t)1 << (h->sub_bucket_half_count_magnitude + 1);
  h->sub_bucket_half_count = h->sub_bucket_count / 2;
  h->sub_bucket_mask = ((int64_t)h->sub_bucket_count - 1) << h->unit_magnitude;
  int64_t smallest_untrackable = ((int64_t)h->sub_bucket_count) << h->unit_magnitude;
  int64_t buckets = 1;
  while (smallest_untrackable <= highest) {
    if (smallest_untrackable > INT64_MAX / 2) {
      buckets++;
      break;
    }
    smallest_untrackable <<= 1;
    buckets++;
  }
  int64_t counts_len = (buckets + 1) * (int64_t)h->sub_bucket_half_count;
  if (counts_len <= 0 || counts_len > (INT64_MAX / (int64_t)sizeof(int64_t))) return false;
  h->counts = calloc((size_t)counts_len, sizeof(int64_t));
  if (h->counts == NULL) return false;
  h->counts_len = counts_len;
  h->lowest = lowest;
  h->highest = highest;
  h->min_value = INT64_MAX;
  return true;
}

static int32_t scr_histo_bucket_index(const ScrHisto *h, int64_t value) {
  int pow2ceiling =
      64 - __builtin_clzll((uint64_t)(value | h->sub_bucket_mask));
  return pow2ceiling - h->unit_magnitude - (h->sub_bucket_half_count_magnitude + 1);
}

static int32_t scr_histo_sub_bucket_index(const ScrHisto *h, int64_t value, int32_t bucket) {
  return (int32_t)(value >> (bucket + h->unit_magnitude));
}

static int64_t scr_histo_counts_index(const ScrHisto *h, int64_t value) {
  int32_t bucket = scr_histo_bucket_index(h, value);
  int32_t sub = scr_histo_sub_bucket_index(h, value, bucket);
  int64_t base = ((int64_t)bucket + 1) << h->sub_bucket_half_count_magnitude;
  return base + (sub - h->sub_bucket_half_count);
}

static int64_t scr_histo_value_at_index(const ScrHisto *h, int64_t index) {
  int32_t bucket = (int32_t)(index >> h->sub_bucket_half_count_magnitude) - 1;
  int32_t sub = (int32_t)(index & (h->sub_bucket_half_count - 1)) + h->sub_bucket_half_count;
  if (bucket < 0) {
    sub -= h->sub_bucket_half_count;
    bucket = 0;
  }
  return ((int64_t)sub) << (bucket + h->unit_magnitude);
}

static int64_t scr_histo_range_size(const ScrHisto *h, int64_t value) {
  int32_t bucket = scr_histo_bucket_index(h, value);
  int32_t sub = scr_histo_sub_bucket_index(h, value, bucket);
  int32_t adjusted = sub >= h->sub_bucket_count ? bucket + 1 : bucket;
  int32_t shift = h->unit_magnitude + adjusted;
  /* The top bucket's nominal width reaches 2^63: saturate rather than
   * shifting a signed 1 into the sign bit (undefined behavior). */
  if (shift >= 63) return INT64_MAX;
  return (int64_t)1 << shift;
}

static int64_t scr_histo_lowest_equivalent(const ScrHisto *h, int64_t value) {
  int32_t bucket = scr_histo_bucket_index(h, value);
  int32_t sub = scr_histo_sub_bucket_index(h, value, bucket);
  int32_t shift = bucket + h->unit_magnitude;
  if (shift >= 63 || shift < 0) return value < 0 ? 0 : INT64_MAX;
  int64_t lowest = ((int64_t)sub) << shift;
  return lowest < 0 ? INT64_MAX : lowest;
}

static int64_t scr_histo_median_equivalent(const ScrHisto *h, int64_t value) {
  return scr_histo_lowest_equivalent(h, value) + (scr_histo_range_size(h, value) >> 1);
}

static int64_t scr_histo_highest_equivalent(const ScrHisto *h, int64_t value) {
  return scr_histo_lowest_equivalent(h, value) + scr_histo_range_size(h, value) - 1;
}

/* hdr_record_values: false (and no change) when the value is outside
 * 0..highest, which the caller counts in exceeds. */
static bool scr_histo_record_value(ScrHisto *h, int64_t value, int64_t count) {
  if (value < 0 || value > h->highest) return false;
  int64_t index = scr_histo_counts_index(h, value);
  if (index < 0 || index >= h->counts_len) return false;
  h->counts[index] += count;
  h->total += count;
  if (value != 0 && value < h->min_value) h->min_value = value;
  if (value > h->max_value) h->max_value = value;
  return true;
}

/* hdr_reset_internal_counters: rebuild total, min and max from the counts
 * (Subtract leaves gaps). */
static void scr_histo_recount(ScrHisto *h) {
  int64_t total = 0, min_value = INT64_MAX, max_value = 0;
  for (int64_t i = 0; i < h->counts_len; i++) {
    if (h->counts[i] == 0) continue;
    total += h->counts[i];
    if (i != 0 && min_value == INT64_MAX) min_value = scr_histo_value_at_index(h, i);
    max_value = scr_histo_highest_equivalent(h, scr_histo_value_at_index(h, i));
  }
  h->total = total;
  h->min_value = min_value;
  h->max_value = max_value;
}

/* Node's node::Histogram::Record: an out-of-range value counts as an
 * exceed and is not recorded. */
static void scr_histo_record(ScrHisto *h, int64_t value) {
  if (!scr_histo_record_value(h, value, 1)) h->exceeds++;
}

/* hdr_record_corrected_value. */
static void scr_histo_record_corrected(ScrHisto *h, int64_t value, int64_t expected_interval) {
  if (!scr_histo_record_value(h, value, 1)) {
    h->exceeds++;
    return;
  }
  if (expected_interval <= 0 || value <= expected_interval) return;
  int64_t missing = value - expected_interval;
  for (; missing >= expected_interval; missing -= expected_interval) {
    if (!scr_histo_record_value(h, missing, 1)) {
      h->exceeds++;
      return;
    }
  }
}

static void scr_histo_clear_view(ScrHisto *h) { h->view_len = 0; }

/* Grow the two view buffers together: both new arrays are allocated and
 * filled before the old ones are released, so a failed allocation leaves
 * the existing pointers (and their contents) intact and throws Node's
 * allocation-failure error instead of leaving the histogram with a freed
 * buffer. */
static bool scr_histo_push_view(ScrHisto *h, double key, int64_t value) {
  if (h->view_len == h->view_cap) {
    size_t cap = h->view_cap ? h->view_cap * 2 : 16;
    if (cap > SIZE_MAX / sizeof(double) || cap > SIZE_MAX / sizeof(int64_t)) {
      static const char msg[] = "Memory allocation failed";
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1,
                               "ERR_MEMORY_ALLOCATION_FAILED");
      return false;
    }
    double *keys = malloc(cap * sizeof *keys);
    int64_t *values = malloc(cap * sizeof *values);
    if (keys == NULL || values == NULL) {
      free(keys);
      free(values);
      static const char msg[] = "Memory allocation failed";
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1,
                               "ERR_MEMORY_ALLOCATION_FAILED");
      return false;
    }
    if (h->view_len > 0) {
      memcpy(keys, h->view_key, h->view_len * sizeof *keys);
      memcpy(values, h->view_value, h->view_len * sizeof *values);
    }
    free(h->view_key);
    free(h->view_value);
    h->view_key = keys;
    h->view_value = values;
    h->view_cap = cap;
  }
  h->view_key[h->view_len] = key;
  h->view_value[h->view_len] = value;
  h->view_len++;
  return true;
}

static void scr_histo_free(ScrHisto *h) {
  if (h == NULL) return;
  free(h->counts);
  free(h->view_key);
  free(h->view_value);
  free(h);
}

/* Node's validateInteger(name, min, max): ERR_OUT_OF_RANGE with the range
 * text and the received number; false and the pending exception otherwise. */
static bool scr_histo_integer_ok(double value, const char *name, double min, double max) {
  bool integer = isfinite(value) && trunc(value) == value;
  if (integer && value >= min && value <= max) return true;
  char received[48];
  if (value == 0 && signbit(value))
    memcpy(received, "-0", 3);
  else
    scr_num_received(value, received);
  char range[64];
  snprintf(range, sizeof range, "%.0f", min);
  char msg[224];
  int len;
  if (!integer)
    len = snprintf(msg, sizeof msg,
                   "The value of \"%s\" is out of range. It must be an integer. Received %s", name,
                   received);
  else
    len = snprintf(msg, sizeof msg,
                   "The value of \"%s\" is out of range. It must be >= %.0f && <= %.0f. Received %s",
                   name, min, max, received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  (void)range;
  return false;
}

/* The options object's field as an integer: numbers must be integer-valued
 * and in 1..MAX_SAFE_INTEGER, bigints must fit an int64. */
static bool scr_histo_option_int(const ScrDyn *value, const char *name, int64_t *out) {
  if (value == NULL || value->kind == SCR_DYN_UNDEF) return true; /* absent */
  if (value->kind == SCR_DYN_NUM) {
    if (!scr_histo_integer_ok(value->v.num, name, 1, 9007199254740991.0)) return false;
    *out = (int64_t)value->v.num;
    return true;
  }
  if (value->kind == SCR_DYN_BIGINT) {
    int64_t v = 0;
    bool fits = scr_bigint_i64_fits(value->v.bigint);
    if (fits) v = scr_bigint_to_i64(value->v.bigint);
    if (!fits || v < 1) {
      char received[48];
      if (fits)
        snprintf(received, sizeof received, "%lldn", (long long)v);
      else
        snprintf(received, sizeof received, "%s", "a bigint outside the int64 range");
      char msg[224];
      int len = snprintf(msg, sizeof msg,
                         "The value of \"%s\" is out of range. It must be >= 1n && <= "
                         "9223372036854775807n. Received %s",
                         name, received);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
      return false;
    }
    *out = v;
    return true;
  }
  char msg[192];
  int len = snprintf(msg, sizeof msg,
                     "The \"%s\" argument must be of type number or bigint", name);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_TYPE");
  return false;
}

/* createHistogram(options?): options.lowest, options.highest and
 * options.figures with Node's defaults and validation, in Node's order
 * (lowest, highest, the highest >= 2*lowest range, figures, then the EWMA
 * options this lowering accepts). A typed options object lowers to a
 * typed-ref capsule, which is materialized once so its fields read like a
 * plain object's. */
ScrDyn *scr_histo_new(ScrDyn *options) {
  int64_t lowest = 1, highest = 9007199254740991LL;
  double figures = 3;
  ScrDyn *plain = NULL;
  bool ok = false;
  if (options == NULL || options->kind == SCR_DYN_UNDEF) {
    ok = true;
    goto create;
  }
  if (options->kind != SCR_DYN_OBJ && options->kind != SCR_DYN_TYPED_REF) {
    static const char msg[] = "The \"options\" argument must be of type object";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  if (options->kind == SCR_DYN_TYPED_REF) {
    plain = scr_dyn_typed_ref_materialize(options);
    if (scr_exc_pending()) return NULL;
  }
  {
    const ScrDyn *opts = plain != NULL ? plain : options;
    if (!scr_histo_option_int(scr_dyn_obj_get(opts, "lowest", 6), "options.lowest", &lowest))
      goto done;
    if (!scr_histo_option_int(scr_dyn_obj_get(opts, "highest", 7), "options.highest", &highest))
      goto done;
    int64_t minimum_highest = lowest > INT64_MAX / 2 ? INT64_MAX : lowest * 2;
    if (highest < minimum_highest) {
      char msg[192];
      int len = snprintf(msg, sizeof msg,
                         "The value of \"options.highest\" is out of range. It must be >= 2 * "
                         "options.lowest (%lldn). Received %lld",
                         (long long)minimum_highest, (long long)highest);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
      goto done;
    }
    const ScrDyn *fig = scr_dyn_obj_get(opts, "figures", 7);
    if (fig != NULL && fig->kind != SCR_DYN_UNDEF) {
      if (fig->kind != SCR_DYN_NUM) {
        static const char msg[] = "The \"options.figures\" argument must be of type number";
        scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
        goto done;
      }
      if (!scr_histo_integer_ok(fig->v.num, "options.figures", 1, 5)) goto done;
      figures = fig->v.num;
    }
    /* halfLife and threshold only feed the EWMA readings; they are
     * validated as Node validates them, then kept unused. */
    const char *ewma_keys[2] = {"halfLife", "threshold"};
    const char *ewma_names[2] = {"options.halfLife", "options.threshold"};
    for (int i = 0; i < 2; i++) {
      const ScrDyn *value = scr_dyn_obj_get(opts, ewma_keys[i], strlen(ewma_keys[i]));
      if (value == NULL || value->kind == SCR_DYN_UNDEF) continue;
      if (value->kind != SCR_DYN_NUM) {
        char msg[160];
        int len = snprintf(msg, sizeof msg, "The \"%s\" argument must be of type number",
                           ewma_names[i]);
        scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_INVALID_ARG_TYPE");
        goto done;
      }
      if (value->v.num < 0) {
        char received[48];
        scr_num_received(value->v.num, received);
        char msg[224];
        int len = snprintf(msg, sizeof msg,
                           "The value of \"%s\" is out of range. It must be >= 0. Received %s",
                           ewma_names[i], received);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
        goto done;
      }
    }
  }
  ok = true;
done:
  scr_dyn_release(plain);
  if (!ok) return NULL;
create:;
  scr_histo_install();
  ScrHisto *h = calloc(1, sizeof *h);
  if (h == NULL) {
    static const char msg[] = "scriptc: out of memory";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_MEMORY_ALLOCATION_FAILED");
    return NULL;
  }
  if (!scr_histo_config(h, lowest, highest, (int)figures)) {
    scr_histo_free(h);
    char msg[160];
    int len = snprintf(msg, sizeof msg,
                       "The value of \"options\" is invalid. Received lowest=%lld highest=%lld "
                       "figures=%d",
                       (long long)lowest, (long long)highest, (int)figures);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  h->rc = 1;
  ScrDyn *box = scr_dyn_new_handle(h, SCR_DYNH_HISTOGRAM);
  if (box == NULL) {
    scr_histo_free(h);
    return NULL;
  }
  scr_histo_release_v(h); /* the box holds the one live reference */
  return box;
}

/* record(val): Node validates a number as an integer >= 1; a bigint must
 * fit the histogram's int64 range (ERR_OUT_OF_RANGE otherwise). */
void scr_histo_record_checked(ScrDyn *handle, double value) {
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL) return;
  if (!scr_histo_integer_ok(value, "val", 1, 9007199254740991.0)) return;
  scr_histo_record(h, (int64_t)value);
}

void scr_histo_record_big(ScrDyn *handle, ScrBigInt *value) {
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL || value == NULL) return;
  if (!scr_bigint_i64_fits(value) || scr_bigint_to_i64(value) < 1) {
    static const char msg[] = "The value of \"value\" is out of range";
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, sizeof msg - 1, "ERR_OUT_OF_RANGE");
    return;
  }
  scr_histo_record(h, scr_bigint_to_i64(value));
}

/* recordCorrected(val, expectedInterval): both integers >= 1. */
void scr_histo_record_corrected_checked(ScrDyn *handle, double value, double expected) {
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL) return;
  if (!scr_histo_integer_ok(value, "val", 1, 9007199254740991.0)) return;
  if (!scr_histo_integer_ok(expected, "expectedInterval", 1, 9007199254740991.0)) return;
  scr_histo_record_corrected(h, (int64_t)value, (int64_t)expected);
}

/* recordDelta(): the nanoseconds since the previous call, recorded. */
void scr_histo_record_delta(ScrDyn *handle) {
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL) return;
  uint64_t now = scr_hrtime_ns();
  if (h->prev_ns > 0 && now > h->prev_ns) {
    uint64_t delta = now - h->prev_ns;
    if (delta > (uint64_t)h->highest)
      h->exceeds++;
    else
      scr_histo_record(h, (int64_t)delta);
  }
  h->prev_ns = now;
}

void scr_histo_reset(ScrDyn *handle) {
  if (scr_eld_of(handle) != NULL) {
    scr_eld_reset(handle);
    return;
  }
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL) return;
  memset(h->counts, 0, (size_t)h->counts_len * sizeof *h->counts);
  h->total = 0;
  h->min_value = INT64_MAX;
  h->max_value = 0;
  h->exceeds = 0;
  h->prev_ns = 0;
  scr_histo_clear_view(h);
}

/* add(other): every recorded value of `other` is recorded here; values this
 * histogram cannot hold are dropped (Node ignores hdr_add's dropped count). */
void scr_histo_add(ScrDyn *handle, ScrDyn *other_handle) {
  ScrHisto *h = scr_histo_of(handle);
  ScrHisto *other = scr_histo_of(other_handle);
  if (h == NULL || other == NULL) {
    static const char msg[] =
        "The \"other\" argument must be an instance of RecordableHistogram";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return;
  }
  /* Node's Histogram::Add merges the exceeds counter and the delta clock
   * before hdr_add merges the buckets. */
  h->exceeds += other->exceeds;
  if (other->prev_ns > h->prev_ns) h->prev_ns = other->prev_ns;
  for (int64_t i = 0; i < other->counts_len; i++) {
    if (other->counts[i] == 0) continue;
    scr_histo_record_value(h, scr_histo_value_at_index(other, i), other->counts[i]);
  }
}

/* subtract(other): counts clamp at zero; the internal counters are rebuilt
 * and exceeds drops to the difference, like Node's Histogram::Subtract. */
void scr_histo_subtract(ScrDyn *handle, ScrDyn *other_handle) {
  ScrHisto *h = scr_histo_of(handle);
  ScrHisto *other = scr_histo_of(other_handle);
  if (h == NULL || other == NULL) {
    static const char msg[] =
        "The \"other\" argument must be an instance of RecordableHistogram";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return;
  }
  int64_t dropped = 0;
  int64_t len = h->counts_len < other->counts_len ? h->counts_len : other->counts_len;
  for (int64_t i = 0; i < len; i++) {
    int64_t count = h->counts[i] - other->counts[i];
    if (count < 0) {
      dropped += -count;
      count = 0;
    }
    h->counts[i] = count;
  }
  (void)dropped;
  scr_histo_recount(h);
  h->exceeds = h->exceeds > other->exceeds ? h->exceeds - other->exceeds : 0;
  scr_histo_clear_view(h);
}

/* which: 0 count, 1 min, 2 max, 3 mean, 4 stddev, 5 exceeds. */
/* The createHistogram selectors (0 count, 1 min, 2 max, 3 mean, 4 stddev,
 * 5 exceeds) and the event-loop histogram's (0 min, 1 max, 2 mean,
 * 3 stddev, 4 count, 5 exceeds) name the same readings in a different
 * order; an upcast maps between them. */
static double scr_histo_eld_selector(int which) {
  switch (which) {
    case 0: return 4;
    case 1: return 0;
    case 2: return 1;
    case 3: return 2;
    case 4: return 3;
    case 6: return 6;
    case 7: return 7;
    default: return 5;
  }
}

/* hdr_mean: the buckets as int64 (count * median), divided once. */
static double scr_histo_mean_of(const ScrHisto *h) {
  int64_t sum = 0;
  for (int64_t i = 0; i < h->counts_len; i++) {
    if (h->counts[i] == 0) continue;
    sum += h->counts[i] * scr_histo_median_equivalent(h, scr_histo_value_at_index(h, i));
  }
  return (double)sum / (double)h->total;
}

/* hdr_stddev: each bucket's median measured against the mean, divided by the
 * population count. */
static double scr_histo_stddev_of(const ScrHisto *h, double mean) {
  double geo = 0;
  for (int64_t i = 0; i < h->counts_len; i++) {
    if (h->counts[i] == 0) continue;
    double dev = (double)scr_histo_median_equivalent(h, scr_histo_value_at_index(h, i)) - mean;
    geo += dev * dev * (double)h->counts[i];
  }
  return sqrt(geo / (double)h->total);
}

double scr_histo_stat(ScrDyn *handle, double which) {
  if (scr_eld_of(handle) != NULL)
    return scr_eld_stat(handle, scr_histo_eld_selector((int)which));
  ScrHisto *h = scr_histo_of(handle);
  int w = (int)which;
  if (h == NULL) return w == 1 ? (double)INT64_MAX : (w == 3 || w == 4) ? NAN : 0;
  switch (w) {
    case 0:
      return (double)h->total;
    case 1:
      if (h->counts_len > 0 && h->counts[0] > 0) return 0;
      return h->min_value == INT64_MAX ? (double)INT64_MAX
                                       : (double)scr_histo_lowest_equivalent(h, h->min_value);
    case 2:
      return h->max_value == 0 ? 0 : (double)scr_histo_highest_equivalent(h, h->max_value);
    case 3:
    case 4: {
      if (h->total == 0) return NAN;
      double mean = scr_histo_mean_of(h);
      if (w == 3) return mean;
      return scr_histo_stddev_of(h, mean);
    }
    case 6:
    case 7: {
      /* Node's shape moments over the same bucket medians its mean and
       * stddev use: skewness m3/sd^3, kurtosis m4/sd^4 - 3 (kurtosis only
       * from four samples; fewer read 0). */
      if (h->total == 0) return 0;
      if (w == 7 && h->total < 4) return 0;
      int64_t sum = 0;
      for (int64_t i = 0; i < h->counts_len; i++) {
        if (h->counts[i] == 0) continue;
        sum += h->counts[i] * scr_histo_median_equivalent(h, scr_histo_value_at_index(h, i));
      }
      double mean = (double)sum / (double)h->total;
      double m2 = 0, m3 = 0, m4 = 0;
      for (int64_t i = 0; i < h->counts_len; i++) {
        if (h->counts[i] == 0) continue;
        double dev = (double)scr_histo_median_equivalent(h, scr_histo_value_at_index(h, i)) - mean;
        double c = (double)h->counts[i];
        m2 += c * dev * dev;
        m3 += c * dev * dev * dev;
        m4 += c * dev * dev * dev * dev;
      }
      m2 /= (double)h->total;
      m3 /= (double)h->total;
      m4 /= (double)h->total;
      {
        double sd = sqrt(m2);
        if (!(sd > 0)) return 0;
        return w == 6 ? m3 / (sd * sd * sd) : m4 / (sd * sd * sd * sd) - 3.0;
      }
    }
    default:
      return (double)h->exceeds;
  }
}

ScrBigInt *scr_histo_stat_big(ScrDyn *handle, double which) {
  if (scr_eld_of(handle) != NULL) {
    ScrEld *eld = scr_eld_of(handle);
    /* This switch reads the createHistogram selector order (0 count,
     * 1 min, 2 max, 5 exceeds) directly from the event-loop histogram's
     * fields; it does not go through scr_histo_eld_selector, which maps to
     * the order scr_eld_stat's own switch uses. */
    int w = (int)which;
    if (eld == NULL) return scr_bigint_from_i64(w == 1 ? INT64_MAX : 0);
    switch (w) {
      case 0:
        return scr_bigint_from_i64((int64_t)eld->count);
      case 1:
        if (eld->counts_len > 0 && eld->counts[0] > 0) return scr_bigint_from_i64(0);
        return scr_bigint_from_i64(eld->min_value == INT64_MAX
                                       ? INT64_MAX
                                       : scr_hdr_lowest_equivalent(eld->min_value));
      case 2:
        return scr_bigint_from_i64(eld->max_value == 0
                                       ? 0
                                       : scr_hdr_highest_equivalent(eld->max_value));
      default:
        /* The ELD's highest is INT64_MAX, so nothing exceeds it. */
        return scr_bigint_from_i64(0);
    }
  }
  ScrHisto *h = scr_histo_of(handle);
  int w = (int)which;
  if (h == NULL) return scr_bigint_from_i64(w == 1 ? INT64_MAX : 0);
  switch (w) {
    case 0:
      return scr_bigint_from_i64(h->total);
    case 1: {
      if (h->counts_len > 0 && h->counts[0] > 0) return scr_bigint_from_i64(0);
      if (h->min_value == INT64_MAX) return scr_bigint_from_i64(INT64_MAX);
      return scr_bigint_from_i64(scr_histo_lowest_equivalent(h, h->min_value));
    }
    case 2:
      return scr_bigint_from_i64(
          h->max_value == 0 ? 0 : scr_histo_highest_equivalent(h, h->max_value));
    default:
      return scr_bigint_from_i64(h->exceeds);
  }
}

/* A Histogram-typed value can be either table: a value read through the
 * base Histogram interface may be a createHistogram RecordableHistogram
 * (negative handle) or a monitorEventLoopDelay IntervalHistogram (positive
 * handle). The base readings dispatch on the handle sign, so an upcast
 * answers the same values as the value's own interface. The ELD counts use
 * the default Histogram bucket layout (lowest 1, three figures), so its
 * countAt/cdf run over the generic bucket math. */
static ScrHisto *scr_histo_lookup(ScrDyn *handle, ScrHisto *tmp) {
  if (scr_eld_of(handle) != NULL) {
    ScrEld *eld = scr_eld_of(handle);
    if (eld == NULL) return NULL;
    *tmp = (ScrHisto){0};
    tmp->counts = eld->counts;
    tmp->counts_len = (int64_t)eld->counts_len;
    tmp->total = eld->total;
    tmp->min_value = eld->min_value;
    tmp->max_value = eld->max_value;
    tmp->unit_magnitude = 0;
    tmp->sub_bucket_half_count_magnitude = SCR_HDR_SUB_BUCKET_HALF_MAG;
    tmp->sub_bucket_half_count = SCR_HDR_SUB_BUCKET_HALF;
    tmp->sub_bucket_count = SCR_HDR_SUB_BUCKET_COUNT;
    tmp->sub_bucket_mask = SCR_HDR_SUB_BUCKET_MASK;
    tmp->highest = INT64_MAX;
    return tmp;
  }
  return scr_histo_of(handle);
}

/* hdr_value_at_percentile; the compiler checked Node's 0 < p <= 100. */
static int64_t scr_histo_percentile_i64(const ScrHisto *h, double percentile) {
  double requested = percentile < 100.0 ? percentile : 100.0;
  int64_t wanted = (int64_t)((requested / 100.0) * (double)h->total + 0.5);
  if (wanted < 1) wanted = 1;
  int64_t seen = 0;
  int64_t value = 0;
  for (int64_t i = 0; i < h->counts_len; i++) {
    seen += h->counts[i];
    if (seen >= wanted) {
      value = scr_histo_value_at_index(h, i);
      break;
    }
  }
  if (percentile == 0.0) return scr_histo_lowest_equivalent(h, value);
  return scr_histo_highest_equivalent(h, value);
}

double scr_histo_percentile(ScrDyn *handle, double percentile) {
  if (scr_eld_of(handle) != NULL) return scr_eld_percentile(handle, percentile);
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL) return 0;
  return (double)scr_histo_percentile_i64(h, percentile);
}

ScrBigInt *scr_histo_percentile_big(ScrDyn *handle, double percentile) {
  if (scr_eld_of(handle) != NULL)
    return scr_bigint_from_i64(scr_eld_percentile_i64(scr_eld_of(handle), percentile));
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL) return scr_bigint_from_i64(0);
  return scr_bigint_from_i64(scr_histo_percentile_i64(h, percentile));
}

/* Node's CountAt converts the double with V8's int64 truncation; a NaN or a
 * magnitude past int64 has no counts index. */
static bool scr_histo_to_i64(double value, int64_t *out) {
  if (isnan(value)) return false;
  if (value >= 9223372036854775808.0 || value <= -9223372036854775808.0) return false;
  *out = (int64_t)value;
  return true;
}

double scr_histo_count_at(ScrDyn *handle, double value) {
  ScrHisto tmp;
  ScrHisto *h = scr_histo_lookup(handle, &tmp);
  int64_t at = 0;
  if (h == NULL || !scr_histo_to_i64(value, &at)) return 0;
  if (at < 0) return 0;
  int64_t index = scr_histo_counts_index(h, at);
  if (index < 0 || index >= h->counts_len) return 0;
  return (double)h->counts[index];
}

/* Node's Histogram::Cdf: the first index whose highest equivalent value
 * reaches `value`, empty buckets included. */
double scr_histo_cdf(ScrDyn *handle, double value) {
  ScrHisto tmp;
  ScrHisto *h = scr_histo_lookup(handle, &tmp);
  int64_t at = 0;
  if (h == NULL || h->total == 0 || !scr_histo_to_i64(value, &at)) return 0.0;
  int64_t target = at;
  int64_t cumulative = 0;
  for (int64_t i = 0; i < h->counts_len; i++) {
    cumulative += h->counts[i];
    int64_t highest = scr_histo_highest_equivalent(h, scr_histo_value_at_index(h, i));
    if (highest >= target) return (double)cumulative / (double)h->total;
    if (cumulative >= h->total) break;
  }
  return 1.0;
}

double scr_histo_ccdf(ScrDyn *handle, double value) { return 1.0 - scr_histo_cdf(handle, value); }

/* The comparison methods take another Histogram: either histogram table is
 * one (the event-loop histogram extends the base interface), and anything
 * else is Node's ERR_INVALID_ARG_TYPE. */
static bool scr_histo_pair(ScrDyn *handle, ScrDyn *other_handle, ScrHisto *self_tmp,
                           ScrHisto *other_tmp, ScrHisto **self, ScrHisto **other) {
  *self = scr_histo_lookup(handle, self_tmp);
  *other = scr_histo_lookup(other_handle, other_tmp);
  if (*self != NULL && *other != NULL) return true;
  static const char msg[] = "The \"other\" argument must be an instance of Histogram";
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
  return false;
}

/* Node's Histogram::KsTest: the largest distance between the two empirical
 * CDFs, bucket index by bucket index. Comparing a histogram with itself and
 * an empty side answer 0. */
double scr_histo_ks_test(ScrDyn *handle, ScrDyn *other_handle) {
  ScrHisto self_tmp, other_tmp, *self, *other;
  if (!scr_histo_pair(handle, other_handle, &self_tmp, &other_tmp, &self, &other)) return 0.0;
  if (handle == other_handle || self == other) return 0.0;
  int64_t n1 = self->total, n2 = other->total;
  if (n1 == 0 || n2 == 0) return 0.0;
  int64_t len = self->counts_len > other->counts_len ? self->counts_len : other->counts_len;
  double max_d = 0.0;
  int64_t cum1 = 0, cum2 = 0;
  for (int64_t i = 0; i < len; i++) {
    if (i < self->counts_len) cum1 += self->counts[i];
    if (i < other->counts_len) cum2 += other->counts[i];
    double cdf1 = (double)cum1 / (double)n1;
    double cdf2 = (double)cum2 / (double)n2;
    double d = cdf1 > cdf2 ? cdf1 - cdf2 : cdf2 - cdf1;
    if (d > max_d) max_d = d;
  }
  return max_d;
}

/* Node's Histogram::CohensD: the mean difference over the pooled sample
 * standard deviation. Fewer than two samples on either side answer 0. */
double scr_histo_cohens_d(ScrDyn *handle, ScrDyn *other_handle) {
  ScrHisto self_tmp, other_tmp, *self, *other;
  if (!scr_histo_pair(handle, other_handle, &self_tmp, &other_tmp, &self, &other)) return 0.0;
  if (handle == other_handle || self == other) return 0.0;
  int64_t n1 = self->total, n2 = other->total;
  if (n1 < 2 || n2 < 2) return 0.0;
  double mean1 = scr_histo_mean_of(self);
  double mean2 = scr_histo_mean_of(other);
  double sd1 = scr_histo_stddev_of(self, mean1);
  double sd2 = scr_histo_stddev_of(other, mean2);
  /* hdr_stddev is the population deviation; Bessel's correction turns it
   * into the sample variance. */
  double var1 = sd1 * sd1 * (double)n1 / (double)(n1 - 1);
  double var2 = sd2 * sd2 * (double)n2 / (double)(n2 - 1);
  double pooled = sqrt(((double)(n1 - 1) * var1 + (double)(n2 - 1) * var2) /
                       (double)(n1 + n2 - 2));
  if (pooled == 0.0) return 0.0;
  return (mean1 - mean2) / pooled;
}

/* Node's Histogram::CliffsD: the share of concordant pairs minus the share
 * of discordant pairs, ties counting for neither. */
double scr_histo_cliffs_d(ScrDyn *handle, ScrDyn *other_handle) {
  ScrHisto self_tmp, other_tmp, *self, *other;
  if (!scr_histo_pair(handle, other_handle, &self_tmp, &other_tmp, &self, &other)) return 0.0;
  if (handle == other_handle || self == other) return 0.0;
  int64_t n1 = self->total, n2 = other->total;
  if (n1 == 0 || n2 == 0) return 0.0;
  int64_t len = self->counts_len > other->counts_len ? self->counts_len : other->counts_len;
  int64_t cum2 = 0;
  double concordant = 0.0, tied = 0.0;
  for (int64_t i = 0; i < len; i++) {
    int64_t c1 = i < self->counts_len ? self->counts[i] : 0;
    int64_t c2 = i < other->counts_len ? other->counts[i] : 0;
    concordant += (double)c1 * (double)cum2;
    tied += (double)c1 * (double)c2;
    cum2 += c2;
  }
  double discordant = (double)n1 * (double)n2 - concordant - tied;
  return (concordant - discordant) / ((double)n1 * (double)n2);
}

typedef struct {
  double u;
  double z;
  double p;
} ScrMannWhitney;

/* Node's Histogram::MannWhitneyTest: the U statistic (concordant pairs plus
 * half the ties), the tie-corrected z score and the two-tailed normal
 * approximation for p. An empty or self comparison answers {0, 0, 1}. */
static ScrMannWhitney scr_histo_mann_whitney(const ScrHisto *self, const ScrHisto *other) {
  ScrMannWhitney out = {0.0, 0.0, 1.0};
  int64_t n1 = self->total, n2 = other->total;
  if (n1 == 0 || n2 == 0 || self == other) return out;
  int64_t len = self->counts_len > other->counts_len ? self->counts_len : other->counts_len;
  int64_t cum2 = 0;
  double concordant = 0.0, tied = 0.0;
  for (int64_t i = 0; i < len; i++) {
    int64_t c1 = i < self->counts_len ? self->counts[i] : 0;
    int64_t c2 = i < other->counts_len ? other->counts[i] : 0;
    concordant += (double)c1 * (double)cum2;
    tied += (double)c1 * (double)c2;
    cum2 += c2;
  }
  double u = concordant + 0.5 * tied;
  double dn1 = (double)n1, dn2 = (double)n2;
  double mu = dn1 * dn2 / 2.0;
  double n_total = dn1 + dn2;
  double tie_correction = 0.0;
  for (int64_t i = 0; i < len; i++) {
    int64_t c1 = i < self->counts_len ? self->counts[i] : 0;
    int64_t c2 = i < other->counts_len ? other->counts[i] : 0;
    double tk = (double)(c1 + c2);
    if (tk > 1) tie_correction += tk * tk * tk - tk;
  }
  double sigma_sq = (dn1 * dn2 / 12.0) *
                    (n_total + 1.0 - tie_correction / (n_total * (n_total - 1.0)));
  if (sigma_sq <= 0.0) {
    out.u = u;
    return out;
  }
  double z = (u - mu) / sqrt(sigma_sq);
  /* 2 * NormalCdf(-|z|), Node's two-tailed normal approximation. */
  double p = 2.0 * (0.5 * erfc(fabs(z) * (1.4142135623730951 / 2.0)));
  out.u = u;
  out.z = z;
  out.p = p;
  return out;
}

double scr_histo_mann_whitney_u(ScrDyn *handle, ScrDyn *other_handle) {
  ScrHisto self_tmp, other_tmp, *self, *other;
  if (!scr_histo_pair(handle, other_handle, &self_tmp, &other_tmp, &self, &other)) return 0.0;
  if (handle == other_handle || self == other) return 0.0;
  return scr_histo_mann_whitney(self, other).u;
}

double scr_histo_mann_whitney_z(ScrDyn *handle, ScrDyn *other_handle) {
  ScrHisto self_tmp, other_tmp, *self, *other;
  if (!scr_histo_pair(handle, other_handle, &self_tmp, &other_tmp, &self, &other)) return 0.0;
  if (handle == other_handle || self == other) return 0.0;
  return scr_histo_mann_whitney(self, other).z;
}

double scr_histo_mann_whitney_p(ScrDyn *handle, ScrDyn *other_handle) {
  ScrHisto self_tmp, other_tmp, *self, *other;
  if (!scr_histo_pair(handle, other_handle, &self_tmp, &other_tmp, &self, &other)) return 1.0;
  if (handle == other_handle || self == other) return 1.0;
  return scr_histo_mann_whitney(self, other).p;
}

/* hdr_iter_percentile's ticks: the percentile thresholds 0, 50, 75, ...,
 * each emitted once the running cumulative reaches it, and 100 for the
 * last recorded bucket (or for an empty histogram). */
double scr_histo_percentiles_count(ScrDyn *handle) {
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL) return 0;
  scr_histo_clear_view(h);
  if (h->total == 0) {
    if (!scr_histo_push_view(h, 100.0, 0)) return 0;
    return (double)h->view_len;
  }
  double to = 0.0;
  int64_t cumulative = 0;
  int64_t last_value = 0;
  for (int64_t i = 0; i < h->counts_len; i++) {
    cumulative += h->counts[i];
    if (h->counts[i] == 0) continue;
    last_value = scr_histo_value_at_index(h, i);
    double current = 100.0 * (double)cumulative / (double)h->total;
    if (cumulative >= h->total) {
      /* The final bucket's next tick is the closing 100 entry, not another
       * threshold: the iterator's has_next is false after it. */
      if (to <= current && !scr_histo_push_view(h, to, last_value)) return 0;
      break;
    }
    while (to < 100.0 && to <= current) {
      if (!scr_histo_push_view(h, to, last_value)) return 0;
      to += (100.0 - to) / 2.0;
    }
  }
  if (!scr_histo_push_view(h, 100.0, last_value)) return 0;
  return (double)h->view_len;
}

double scr_histo_percentiles_key(ScrDyn *handle, double index) {
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL || index < 0 || (size_t)index >= h->view_len) return 0;
  return h->view_key[(size_t)index];
}

double scr_histo_percentiles_value(ScrDyn *handle, double index) {
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL || index < 0 || (size_t)index >= h->view_len) return 0;
  return (double)h->view_value[(size_t)index];
}

/* Symbol.dispose: Node's RecordableHistogram is not disposable, but the
 * runtime frees the counts early. */
void scr_histo_dispose(ScrDyn *handle) {
  ScrHisto *h = scr_histo_of(handle);
  if (h == NULL) return;
  /* Node's RecordableHistogram is not disposable, but the runtime frees
   * the buckets early; the handle box stays and releases nothing more. */
  h->disposed = true;
  free(h->counts);
  h->counts = NULL;
  h->counts_len = 0;
  h->total = 0;
  h->min_value = INT64_MAX;
  h->max_value = 0;
  scr_histo_clear_view(h);
}

/* ── histogram.linearBuckets / histogram.logBuckets ─────────────────────
 * Node walks the HdrHistogram buckets: a non-empty bucket is placed by its
 * lowest equivalent value, and each key is that layout's lowest equivalent
 * of the bucket boundary (an aligned value at this resolution). The count
 * entry rebuilds a per-thread view; the key and value accessors read it. */
static SCR_TL struct {
  double *key;
  int64_t *count;
  size_t len;
  size_t cap;
} scr_buckets_view;

static void scr_buckets_cleanup(void) {
  free(scr_buckets_view.key);
  free(scr_buckets_view.count);
  scr_buckets_view.key = NULL;
  scr_buckets_view.count = NULL;
  scr_buckets_view.len = scr_buckets_view.cap = 0;
}

/* The view is per thread and program-lived: its arrays are freed at exit.
 * The cleanup registers on first use, so a program that never builds a
 * bucket map allocates nothing. */
static bool scr_buckets_registered;
static void scr_buckets_ensure_cleanup(void) {
  if (scr_buckets_registered) return;
  scr_buckets_registered = true;
  scr_atexit(scr_buckets_cleanup);
}

static bool scr_buckets_push(double key, int64_t count) {
  scr_buckets_ensure_cleanup();
  if (scr_buckets_view.len == scr_buckets_view.cap) {
    size_t cap = scr_buckets_view.cap ? scr_buckets_view.cap * 2 : 32;
    double *keys = realloc(scr_buckets_view.key, cap * sizeof *keys);
    int64_t *counts = realloc(scr_buckets_view.count, cap * sizeof *counts);
    if (keys != NULL) scr_buckets_view.key = keys;
    if (counts != NULL) scr_buckets_view.count = counts;
    if (keys == NULL || counts == NULL) {
      static const char msg[] = "Memory allocation failed";
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_MEMORY_ALLOCATION_FAILED");
      return false;
    }
    scr_buckets_view.cap = cap;
  }
  scr_buckets_view.key[scr_buckets_view.len] = key;
  scr_buckets_view.count[scr_buckets_view.len] = count;
  scr_buckets_view.len++;
  return true;
}

/* The bucket layout both histogram classes record in. */
typedef struct {
  const void *owner;
  const int64_t *counts;
  size_t len;
  int64_t (*value_at)(const void *owner, size_t index);
  int64_t (*lowest)(const void *owner, int64_t value);
} ScrBucketLayout;

static int64_t scr_bucket_histo_value_at(const void *owner, size_t index) {
  return scr_histo_value_at_index((const ScrHisto *)owner, (int64_t)index);
}

static int64_t scr_bucket_histo_lowest(const void *owner, int64_t value) {
  return scr_histo_lowest_equivalent((const ScrHisto *)owner, value);
}

static int64_t scr_bucket_eld_value_at(const void *owner, size_t index) {
  (void)owner;
  return scr_hdr_value_at_index(index);
}

static int64_t scr_bucket_eld_lowest(const void *owner, int64_t value) {
  (void)owner;
  return scr_hdr_lowest_equivalent(value);
}

static bool scr_buckets_layout(ScrDyn *handle, ScrBucketLayout *layout) {
  memset(layout, 0, sizeof *layout);
  ScrEld *eld = scr_eld_of(handle);
  if (eld != NULL) {
    layout->owner = eld;
    layout->counts = eld->counts;
    layout->len = eld->counts_len;
    layout->value_at = scr_bucket_eld_value_at;
    layout->lowest = scr_bucket_eld_lowest;
    return true;
  }
  ScrHisto *h = scr_histo_of(handle);
  if (h != NULL) {
    layout->owner = h;
    layout->counts = h->counts;
    layout->len = (size_t)h->counts_len;
    layout->value_at = scr_bucket_histo_value_at;
    layout->lowest = scr_bucket_histo_lowest;
    return true;
  }
  return false;
}

/* The helper arguments' Node validation (validateInteger for stepSize and
 * firstBucket, validateNumber then > 1 for base). */
double scr_histo_bucket_arg(ScrDyn *value, double which) {
  const char *name = which == 0 ? "stepSize" : which == 1 ? "firstBucket" : "base";
  if (value == NULL || value->kind != SCR_DYN_NUM) {
    char detail[128];
    char msg[224];
    int n = snprintf(msg, sizeof msg, "The \"%s\" argument must be of type number. Received %s",
                     name, scr_dyn_specific_type(value != NULL ? value : scr_dyn_undefined(), detail,
                                                 sizeof detail));
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_ARG_TYPE");
    return 0;
  }
  double v = value->v.num;
  if (which == 2) {
    if (!(v > 1)) {
      char num[48];
      char msg[160];
      scr_num_received(v, num);
      int n = snprintf(msg, sizeof msg,
                       "The value of \"base\" is out of range. It must be > 1. Received %s", num);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
      return 0;
    }
    return v;
  }
  if (!(isfinite(v) && trunc(v) == v)) {
    char num[48];
    char msg[192];
    scr_num_received(v, num);
    int n = snprintf(msg, sizeof msg,
                     "The value of \"%s\" is out of range. It must be an integer. Received %s", name,
                     num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (!(v >= 1 && v <= 9007199254740991.0)) {
    char num[48];
    char msg[224];
    scr_num_received(v, num);
    int n = snprintf(msg, sizeof msg,
                     "The value of \"%s\" is out of range. It must be >= 1 && <= 9007199254740991. "
                     "Received %s",
                     name, num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
    return 0;
  }
  return v;
}

double scr_histo_linear_buckets_count(ScrDyn *handle, double step_d) {
  scr_buckets_view.len = 0;
  ScrBucketLayout layout;
  if (!scr_buckets_layout(handle, &layout)) return 0;
  int64_t step = (int64_t)step_d;
  /* Node emits every bucket from the first (index 1) to the last recorded
   * one, so the keys start at one step whatever the smallest value is. */
  int64_t max_index = 0;
  for (size_t i = 0; i < layout.len; i++) {
    if (layout.counts[i] <= 0) continue;
    int64_t repr = layout.value_at(layout.owner, i);
    int64_t index = (repr + step - 1) / step;
    /* A sample below the layout's lowest resolution sits in bucket zero,
     * whose representative is 0; the map starts at the first bucket. */
    if (index < 1) index = 1;
    if (index > max_index) max_index = index;
  }
  if (max_index == 0) return 0;
  size_t slots = (size_t)max_index;
  int64_t *counts = calloc(slots, sizeof *counts);
  if (counts == NULL) {
    static const char msg[] = "Memory allocation failed";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_MEMORY_ALLOCATION_FAILED");
    return 0;
  }
  for (size_t i = 0; i < layout.len; i++) {
    if (layout.counts[i] <= 0) continue;
    int64_t repr = layout.value_at(layout.owner, i);
    int64_t index = (repr + step - 1) / step;
    if (index < 1) index = 1;
    counts[index - 1] += layout.counts[i];
  }
  bool ok = true;
  for (size_t s = 0; ok && s < slots; s++) {
    int64_t index = (int64_t)s + 1;
    ok = scr_buckets_push((double)layout.lowest(layout.owner, index * step), counts[s]);
  }
  free(counts);
  return ok ? (double)scr_buckets_view.len : 0;
}

double scr_histo_log_buckets_count(ScrDyn *handle, double first_d, double base_d) {
  scr_buckets_view.len = 0;
  ScrBucketLayout layout;
  if (!scr_buckets_layout(handle, &layout)) return 0;
  int64_t first = (int64_t)first_d;
  int64_t base = (int64_t)base_d;
  if (base < 2) base = 2;
  int64_t max_repr = 0;
  bool any = false;
  for (size_t i = 0; i < layout.len; i++) {
    if (layout.counts[i] <= 0) continue;
    int64_t repr = layout.value_at(layout.owner, i);
    if (!any || repr > max_repr) max_repr = repr;
    any = true;
  }
  if (!any) return 0;
  size_t nbounds = 0, cap = 16;
  int64_t *bounds = malloc(cap * sizeof *bounds);
  if (bounds == NULL) {
    static const char msg[] = "Memory allocation failed";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_MEMORY_ALLOCATION_FAILED");
    return 0;
  }
  int64_t b = first;
  for (;;) {
    if (nbounds == cap) {
      cap *= 2;
      int64_t *grown = realloc(bounds, cap * sizeof *bounds);
      if (grown == NULL) {
        free(bounds);
        static const char msg[] = "Memory allocation failed";
        scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_MEMORY_ALLOCATION_FAILED");
        return 0;
      }
      bounds = grown;
    }
    bounds[nbounds++] = b;
    if (b >= max_repr) break;
    if (b > INT64_MAX / base) break; /* the next boundary would overflow */
    b *= base;
  }
  int64_t *counts = calloc(nbounds, sizeof *counts);
  if (counts == NULL) {
    free(bounds);
    static const char msg[] = "Memory allocation failed";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "ERR_MEMORY_ALLOCATION_FAILED");
    return 0;
  }
  for (size_t i = 0; i < layout.len; i++) {
    if (layout.counts[i] <= 0) continue;
    int64_t repr = layout.value_at(layout.owner, i);
    size_t j = 0;
    while (j + 1 < nbounds && bounds[j] < repr) j++;
    counts[j] += layout.counts[i];
  }
  bool ok = true;
  for (size_t j = 0; ok && j < nbounds; j++)
    ok = scr_buckets_push((double)layout.lowest(layout.owner, bounds[j]), counts[j]);
  free(counts);
  free(bounds);
  return ok ? (double)scr_buckets_view.len : 0;
}

double scr_histo_buckets_key(double index) {
  size_t i = (size_t)index;
  return i < scr_buckets_view.len ? scr_buckets_view.key[i] : 0;
}

double scr_histo_buckets_value(double index) {
  size_t i = (size_t)index;
  return i < scr_buckets_view.len ? (double)scr_buckets_view.count[i] : 0;
}
