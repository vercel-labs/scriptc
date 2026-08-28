/* CB6 (callback-free posture): the same signature-only ambient call under
 * a profile with NO callbacks section keeps Node's ReferenceError
 * semantics — the entry throws, and the escaped exception reaches the
 * sink as the SC4013 structured message naming the entry. */
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void cb_init(void);
extern void cb_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern double cb_stream(double n, double base);

static jmp_buf trap_jmp;
static int sink_calls = 0;

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  sink_calls++;
  printf("sink[%d]:\n", sink_calls);
  int has_referror = 0;
  if (len > 0 && msg[0] == 0x01) {
    const uint8_t *p = msg + 1, *end = msg + len;
    int field = 0;
    for (;;) {
      const uint8_t *sep = memchr(p, 0x1f, (size_t)(end - p));
      const uint8_t *stop = sep != NULL ? sep : end;
      if (field == 0) {
        for (const uint8_t *q = p; q + 14 <= stop; q++) {
          if (memcmp(q, "ReferenceError", 14) == 0) { has_referror = 1; break; }
        }
      }
      if (field == 1) printf("code=[%.*s]\n", (int)(stop - p), (const char *)p);
      if (field == 2) printf("symbol=[%.*s]\n", (int)(stop - p), (const char *)p);
      field++;
      if (sep == NULL) break;
      p = sep + 1;
    }
  }
  printf("text has ReferenceError: %d\n", has_referror);
  longjmp(trap_jmp, 1);
}

int main(void) {
  cb_set_panic_sink(sink, NULL);
  cb_init();
  if (setjmp(trap_jmp) == 0) {
    cb_stream(1, 1);
    printf("UNREACHABLE\n");
  } else {
    printf("survived, sink_calls=%d\n", sink_calls);
  }
  return 0;
}
