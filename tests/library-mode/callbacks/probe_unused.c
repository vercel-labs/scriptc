/* CB6 (capacity posture): no compiled code references any channel, but the
 * registration symbol still dispatches every declared name — an embedder
 * can wire callbacks ahead of the program revision that uses them. */
#include <stdint.h>
#include <stdio.h>

extern void cb_init(void);
extern int32_t cb_set_callback(const char *name, void (*fn)(void), void *ctx);
extern double cb_stream(double n, double base);

static void on_orphan(void *ctx, double x) { (void)ctx; (void)x; }

int main(void) {
  printf("reg orphan: %d\n", (int)cb_set_callback("orphan", (void (*)(void))on_orphan, NULL));
  printf("reg emitChunk: %d\n", (int)cb_set_callback("emitChunk", (void (*)(void))on_orphan, NULL));
  cb_init();
  printf("stream(3,7) = %g\n", cb_stream(3, 7));
  return 0;
}
