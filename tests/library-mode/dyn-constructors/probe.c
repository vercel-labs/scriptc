/* K16 probe: read a DOMException's `.constructor` inside the library.
 * That read answers through the base dynamic-constructor hook
 * (scr_json.c's scr_dyn_global_constructor_hook), which only the library
 * initializer's install call fills; before that the read traps. */
#include <stdint.h>
#include <stdio.h>

extern void kd_init(void);
extern void kd_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void kd_domex_ctor_name(const uint8_t **out, size_t *out_len);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)msg; (void)len; (void)addr;
  printf("UNEXPECTED SINK\n");
}

int main(void) {
  kd_set_panic_sink(sink, NULL);
  kd_init();
  const uint8_t *s; size_t n;
  kd_domex_ctor_name(&s, &n);
  printf("ctor: %.*s\n", (int)n, s);
  return 0;
}
