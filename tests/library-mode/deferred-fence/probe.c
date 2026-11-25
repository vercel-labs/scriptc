/* A deferred refusal inside a library: the export's JavaScript callee
 * reaches a construct with no lowering, catches the Error it throws and
 * answers its argument. Nothing reaches the sink. */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

extern void kd_init(void);
extern void kd_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void kd_collect(void);
extern double kd_run(double n);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)msg; (void)len; (void)addr;
  printf("UNEXPECTED SINK\n");
}

int main(void) {
  kd_set_panic_sink(sink, NULL);
  kd_init();
  printf("run: %.0f\n", kd_run(5));
  printf("run: %.0f\n", kd_run(6));
  kd_collect();
  return 0;
}
