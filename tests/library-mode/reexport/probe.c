/* K15 re-export probe: the profile's four exports are supplied by two
 * other modules through the three facade forms (an export list over a
 * local import, a renamed named re-export, a star re-export). Checks:
 *   - a re-exported function is callable across the C ABI with the same
 *     marshalling a directly declared export gets;
 *   - the module that declares it is evaluated once, at the entry's module
 *     order, so the handler state the entry's top level set ("?") is what
 *     the first call sees — Node's evaluation order;
 *   - two re-exported functions share that one module instance
 *     (setSuffix changes what handle returns next), which a per-export
 *     wrapper copy would not do. */
#include <stdint.h>
#include <stdio.h>

extern void kr_init(void);
extern void kr_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void kr_collect(void);
extern void kr_handle(const uint8_t *p, size_t len, const uint8_t **out, size_t *out_len);
extern void kr_set_suffix(const uint8_t *p, size_t len);
extern double kr_doubled(double n);
extern void kr_version(const uint8_t **out, size_t *out_len);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)msg; (void)len; (void)addr;
  printf("UNEXPECTED SINK\n");
}

int main(void) {
  kr_set_panic_sink(sink, NULL);
  kr_init();

  const uint8_t *s; size_t n;
  kr_handle((const uint8_t *)"hi", 2, &s, &n);
  printf("handle: %.*s\n", (int)n, s);

  kr_set_suffix((const uint8_t *)".", 1);
  kr_handle((const uint8_t *)"ok", 2, &s, &n);
  printf("handle after setSuffix: %.*s\n", (int)n, s);

  printf("doubled: %.0f\n", kr_doubled(21.5));

  kr_version(&s, &n);
  printf("version: %.*s\n", (int)n, s);

  kr_collect();
  return 0;
}
