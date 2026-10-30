/* X509Certificate fields read through a library export. */
#include <stdint.h>
#include <stdio.h>

extern void kx_init(void);
extern void kx_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void kx_collect(void);
extern void kx_describe(const uint8_t **out, size_t *out_len);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  printf("SINK %.*s\n", (int)len, msg);
}

int main(void) {
  kx_set_panic_sink(sink, NULL);
  kx_init();
  const uint8_t *s; size_t n;
  kx_describe(&s, &n);
  printf("%.*s\n", (int)n, s);
  kx_collect();
  return 0;
}
