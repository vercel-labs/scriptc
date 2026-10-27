/* Three sessions of a library whose untyped code reads and writes through
 * property caches: each prints the same result, and under the sanitize
 * flavor no session reads a cache entry the previous session freed. */
#include <stdint.h>
#include <stdio.h>

extern void kj_init(void);
extern void kj_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void kj_collect(void);
extern double kj_run(void);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  printf("UNEXPECTED SINK: %.*s", (int)len, (const char *)msg);
}

int main(void) {
  kj_set_panic_sink(sink, NULL);
  for (int session = 0; session < 3; session++) {
    kj_init();
    printf("run: %.0f\n", kj_run());
    kj_collect();
  }
  return 0;
}
