/* Project-.d.ts callback probe: registration must route the call through the
 * profile channel. If the declaration file is incorrectly treated like
 * lib.d.ts/@types, compilation fails before this probe can link. */
#include <stdint.h>
#include <stdio.h>

extern void cb_init(void);
extern int32_t cb_set_callback(const char *name, void (*fn)(void), void *ctx);
extern double cb_stream(double n, double base);

typedef void (*cb_fn)(void);

static void on_chunk(void *ctx, const uint8_t *p, size_t len, uint32_t seq) {
  (void)ctx;
  printf("seq=%u len=%zu bytes=%.*s\n", seq, len, (int)len, (const char *)p);
}

int main(void) {
  if (cb_set_callback("emitChunk", (cb_fn)on_chunk, NULL) != 0) return 2;
  cb_init();
  printf("result=%g\n", cb_stream(2, 7));
  return 0;
}
