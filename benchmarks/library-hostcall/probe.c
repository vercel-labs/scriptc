/* Host-call microbenchmark driver. Registers the `tick` channel, warms both
 * loops, then times `hb_run(n)` (n synchronous host calls) against a
 * noinline direct C function called in the same loop with the same counter
 * argument. Prints raw nanoseconds per repetition; run.mjs computes ns/call
 * and the interval across runs. */
#define _POSIX_C_SOURCE 199309L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

extern void hb_init(void);
extern int32_t hb_set_callback(const char *name, void (*fn)(void), void *ctx);
extern double hb_run(double n);

static uint64_t host_calls;
static uint64_t host_sum;

/* The registered channel: takes the u32 argument and keeps the work
 * observable so neither side of the comparison is optimized away. */
static void on_tick(void *ctx, uint32_t seq) {
  (void)ctx;
  host_calls++;
  host_sum += seq;
}

/* Direct C baseline: one ordinary call per iteration, the shape the host
 * call lowers to minus the runtime's plumbing. noinline keeps it a real
 * call rather than a folded accumulation. */
static uint64_t c_calls;
static uint64_t c_sum;
__attribute__((noinline)) static void c_tick(uint32_t seq) {
  c_calls++;
  c_sum += seq;
}

static double c_run(int32_t n) {
  double acc = 0;
  for (int32_t i = 0; i < n; i++) {
    c_tick((uint32_t)i);
    acc += i;
  }
  return acc;
}

static uint64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

int main(int argc, char **argv) {
  const double n = argc > 1 ? atof(argv[1]) : 5000000.0;
  const int reps = argc > 2 ? atoi(argv[2]) : 7;
  hb_init();
  if (hb_set_callback("tick", (void (*)(void))on_tick, NULL) != 0) {
    fprintf(stderr, "probe: could not register the tick channel\n");
    return 2;
  }
  /* Warm both call paths and the icache/branch predictors. */
  c_run(100000);
  hb_run(100000);

  for (int r = 0; r < reps; r++) {
    uint64_t t0, t1, t2, t3;
    if (r % 2 == 0) {
      t0 = now_ns();
      hb_run(n);
      t1 = now_ns();
      t2 = now_ns();
      c_run((int32_t)n);
      t3 = now_ns();
    } else {
      t2 = now_ns();
      c_run((int32_t)n);
      t3 = now_ns();
      t0 = now_ns();
      hb_run(n);
      t1 = now_ns();
    }
    printf("lib %llu\nc %llu\n", (unsigned long long)(t1 - t0), (unsigned long long)(t3 - t2));
  }

  const double expected = n * (n - 1) / 2;
  if (hb_run(10) != 45 || c_run(10) != 45) {
    fprintf(stderr, "probe: unexpected 10-call checksum\n");
    return 2;
  }
  if (host_calls != c_calls || host_sum != c_sum) {
    fprintf(stderr, "probe: channel observed %llu calls/%llu sum, C baseline %llu/%llu\n",
            (unsigned long long)host_calls, (unsigned long long)host_sum,
            (unsigned long long)c_calls, (unsigned long long)c_sum);
    return 2;
  }
  printf("calls %llu expected %f\n", (unsigned long long)host_calls, expected);
  return 0;
}
