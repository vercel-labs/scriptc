/* Raises through the synthetic frames of test_unwind_frames.ll and
 * test_unwind_frames.S with scr_unwind.c's walk: landing pads run inner
 * first, the catching frame sees its callee-saved registers restored, every
 * frame the walk steps through has the stack pointer and callee-saved
 * registers libgcc's unwinder computes for it, and only frames with CFI the
 * plans do not express go to libgcc's unwinder.
 * Each case runs three times (the first builds plans, the others reuse
 * them), and again from several threads at once. */
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void Frame(void **chain);
extern Frame ir_raise, ir_plain, ir_plain_fp, ir_alloca, ir_pad, ir_pad_fp;
extern Frame asm_remember, asm_rbp, asm_expr;
extern int64_t ir_catch(void **chain, int64_t a, int64_t b, int64_t c, int64_t d, int64_t e,
                        int64_t f);
extern size_t scr_unwind_test_fallbacks;
extern size_t scr_unwind_test_mismatches;

static _Thread_local void **cleanup_base;
static _Thread_local int cleanups[512];
static _Thread_local int cleanup_count;

/* A landing pad of the frame at chain[-1] ran. */
void test_cleanup(void **chain) {
  if (cleanup_count < 512) cleanups[cleanup_count] = (int)(chain - cleanup_base) - 1;
  cleanup_count++;
}

void test_touch(void *p) { memset(p, 0x5a, 16); }

void test_return(void **chain) { (void)chain; }

static int64_t checksum(int64_t a, int64_t b, int64_t c, int64_t d, int64_t e, int64_t f) {
  uint64_t s = (uint64_t)a * 3 ^ (uint64_t)b * 5;
  s += (uint64_t)c * 7;
  s ^= (uint64_t)d * 11;
  s += (uint64_t)e * 13;
  s ^= (uint64_t)f * 17;
  return (int64_t)(s & INT64_MAX);
}

/* Writes over the stack the unwound frames used: in sanitized builds, a
 * redzone the unwind left poisoned would be reported here. */
static __attribute__((noinline)) void scrub(void) {
  volatile char big[32768];
  memset((char *)big, 0, sizeof big);
}

static void fail(const char *name, const char *what) {
  fprintf(stderr, "%s: %s\n", name, what);
  exit(1);
}

/* Runs frames[0..n) below ir_catch. A case that ends in test_return
 * raises nothing. Returns the case's fallbacks to libgcc. */
static size_t run(const char *name, Frame *const *frames, int n, int64_t seed) {
  void *chain[512];
  int expected[512];
  int pads = 0;
  if (n >= 511) fail(name, "too many frames");
  for (int i = 0; i < n; i++) chain[i] = (void *)frames[i];
  chain[n] = NULL;
  int raises = frames[n - 1] == ir_raise;
  if (raises)
    for (int i = n - 1; i >= 0; i--)
      if (frames[i] == ir_pad || frames[i] == ir_pad_fp) expected[pads++] = i;
  size_t before = __atomic_load_n(&scr_unwind_test_fallbacks, __ATOMIC_RELAXED);
  cleanup_base = chain;
  cleanup_count = 0;
  int64_t a = seed, b = seed ^ 0x1234, c = seed + 77, d = seed * 31, e = ~seed, f = seed << 3;
  int64_t got = ir_catch(chain, a, b, c, d, e, f);
  int64_t want = checksum(a, b, c, d, e, f) | (raises ? INT64_MIN : 0);
  if (got != want) fail(name, "the catching frame's values or raise flag differ");
  if (cleanup_count != pads) fail(name, "a different number of landing pads ran");
  for (int i = 0; i < pads; i++)
    if (cleanups[i] != expected[i]) fail(name, "landing pads ran out of order");
  scrub();
  if (__atomic_load_n(&scr_unwind_test_mismatches, __ATOMIC_RELAXED) != 0)
    fail(name, "a frame's stack pointer or callee-saved registers differ from libgcc's");
  return __atomic_load_n(&scr_unwind_test_fallbacks, __ATOMIC_RELAXED) - before;
}

typedef struct {
  const char *name;
  Frame *frames[16];
  int count;
  size_t fallbacks; /* raises or resumes that go to libgcc */
} Case;

/* Sanitized builds realign a frame with a dynamic alloca through r10 and
 * describe it with DWARF expressions, which go to libgcc. */
#if defined(__SANITIZE_ADDRESS__)
#define ALLOCA_FALLBACKS 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define ALLOCA_FALLBACKS 1
#endif
#endif
#ifndef ALLOCA_FALLBACKS
#define ALLOCA_FALLBACKS 0
#endif

static const Case cases[] = {
    {"returns", {ir_pad, ir_plain, test_return}, 3, 0},
    {"raise", {ir_raise}, 1, 0},
    {"plain frames", {ir_plain, ir_plain_fp, ir_plain, ir_raise}, 4, 0},
    {"dynamic alloca", {ir_pad, ir_alloca, ir_pad, ir_raise}, 4, ALLOCA_FALLBACKS},
    {"landing pads", {ir_pad, ir_plain, ir_pad_fp, ir_pad, ir_raise}, 5, 0},
    {"remember and rbp", {asm_remember, ir_pad, asm_rbp, asm_remember, ir_raise}, 5, 0},
    {"libgcc above a pad", {asm_expr, ir_pad, ir_raise}, 3, 1},
    {"libgcc between pads", {ir_pad, asm_expr, ir_pad_fp, ir_raise}, 4, 1},
    {"libgcc at the raise", {ir_pad, asm_expr, ir_raise}, 3, 1},
};
#define CASES (sizeof cases / sizeof cases[0])

static void run_cases(int64_t seed) {
  for (size_t i = 0; i < CASES; i++) {
    size_t fallbacks = run(cases[i].name, cases[i].frames, cases[i].count, seed + (int64_t)i);
    if (fallbacks != cases[i].fallbacks) fail(cases[i].name, "a different number of fallbacks");
  }
}

/* A deep recursion of every frame kind. */
static void run_deep(int64_t seed) {
  static Frame *const kinds[] = {ir_pad, ir_plain, asm_remember, asm_rbp, ir_pad_fp, ir_plain_fp};
  Frame *frames[301];
  for (int i = 0; i < 300; i++) frames[i] = kinds[i % 6];
  frames[300] = ir_raise;
  if (run("deep", frames, 301, seed) != 0) fail("deep", "a fallback to libgcc");
}

static void *thread_main(void *arg) {
  int64_t seed = (int64_t)(intptr_t)arg;
  for (int round = 0; round < 200; round++) {
    for (size_t i = 0; i < CASES; i++) {
      if (cases[i].fallbacks != 0) continue; /* the shared counter is checked alone */
      if (run(cases[i].name, cases[i].frames, cases[i].count, seed + round) != 0)
        fail(cases[i].name, "a fallback to libgcc in a thread");
    }
    if (round % 20 == 0) run_deep(seed);
  }
  return NULL;
}

/* With an argument, the threads run first, so they build the plans
 * concurrently. */
int main(int argc, char **argv) {
  (void)argv;
  if (argc == 1)
    for (int round = 0; round < 3; round++) {
      run_cases(round * 1000);
      run_deep(round);
    }
  pthread_t threads[8];
  for (int i = 0; i < 8; i++)
    if (pthread_create(&threads[i], NULL, thread_main, (void *)(intptr_t)(i * 7919)) != 0)
      fail("threads", "pthread_create failed");
  for (int i = 0; i < 8; i++) pthread_join(threads[i], NULL);
  puts("unwind checks passed");
  return 0;
}
