/* CB6 builtin-name collision probe: neither channel is registered. If the
 * profile incorrectly claims lib.d.ts's isNaN binding, this call traps;
 * ordinary builtin lowering returns false/true and reaches both prints. */
#include <stdint.h>
#include <stdio.h>

extern void cbb_init(void);
extern int32_t cbb_set_callback(const char *name, void (*fn)(void), void *ctx);
extern uint8_t cbb_check_builtin(double x);
extern double cbb_call_keyword(double x);

typedef void (*cb_fn)(void);

static double on_int(void *ctx, double x) {
  return x + *(const double *)ctx;
}

int main(void) {
  static const double add = 0.5;
  if (cbb_set_callback("int", (cb_fn)on_int, (void *)&add) != 0) return 2;
  cbb_init();
  printf("finite: %u\n", (unsigned)cbb_check_builtin(123));
  printf("nan: %u\n", (unsigned)cbb_check_builtin(0.0 / 0.0));
  printf("keyword: %.1f\n", cbb_call_keyword(7));
  return 0;
}
