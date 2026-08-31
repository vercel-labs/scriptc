/* K4 init-rerun-determinism probe: two identical sessions. Under the
 * sanitize flavor (the harness's ASan + RC-audit build), the second init's
 * reset seam additionally asserts zero live heap — a leak across re-init
 * would trap to the sink and fail the expected output. */
#include <stdint.h>
#include <stdio.h>

extern void kr_init(void);
extern void kr_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void kr_collect(void);
extern double kr_bump(void);
extern double kr_note(const uint8_t *p, size_t len);
extern double kr_indexed_unicode(void);
extern void kr_recall(const uint8_t **out, size_t *out_len);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  printf("UNEXPECTED SINK: %.*s", (int)len, (const char *)msg);
}

static void session(void) {
  kr_init();
  double b1 = kr_bump(); /* sequenced — C argument order is unspecified */
  double b2 = kr_bump();
  printf("bump: %.0f %.0f\n", b1, b2);
  double n1 = kr_note((const uint8_t *)"a", 1);
  double n2 = kr_note((const uint8_t *)"b", 1);
  printf("note: %.0f %.0f\n", n1, n2);
  printf("indexed: %.0f\n", kr_indexed_unicode());
  const uint8_t *s; size_t n;
  kr_recall(&s, &n);
  printf("recall: %.*s\n", (int)n, s);
}

int main(void) {
  kr_set_panic_sink(sink, NULL);
  session();
  session(); /* byte-identical to the first, or re-init is not deterministic */
  session();
  kr_collect();
  return 0;
}
