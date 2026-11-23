/* Dynamic-unit probe: each export reaches a runtime unit that the archive
 * carries only when the program names it. The probe links (the archive has
 * every unit it calls) and each answer is Node's. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

extern void kd_init(void);
extern void kd_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern bool kd_cast_shares(void);
extern bool kd_slot_shares(void);
extern bool kd_class_test(void);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  printf("UNEXPECTED SINK: %.*s\n", (int)len, (const char *)msg);
}

int main(void) {
  kd_set_panic_sink(sink, NULL);
  kd_init();
  printf("cast shares: %s\n", kd_cast_shares() ? "true" : "false");
  printf("slot shares: %s\n", kd_slot_shares() ? "true" : "false");
  printf("class test: %s\n", kd_class_test() ? "true" : "false");
  return 0;
}
