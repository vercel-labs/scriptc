/* K5/K6/K7 probe, mode-selected by argv[1]:
 *   trap        — the runtime's range trap arrives as ONE structured
 *                 trap-teaching message (this profile declares no
 *                 teachings, so field 0 is the runtime's own line, the
 *                 code is the detected-trap kind's, the symbol is the
 *                 export the host called, and NO remediation field
 *                 exists) plus a fault address, exactly once; the process
 *                 survives (the sink longjmps to a host frame BELOW the
 *                 entry — the conforming pattern; returning from the sink
 *                 would abort)
 *   throw       — an escaped exception reaches the sink structured the
 *                 same way, its text the baseline "Uncaught ..." line
 *   poisoned    — after a trap, any further entry aborts deterministically
 *   preregister — a trap before sink registration aborts
 *   hostleak    — the HOST leaks a block and exits: the sanitized lane's
 *                 control that its leak checker is still on (K10), so the
 *                 trap's abandoned-heap hand-off cannot pass by disabling it
 */
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void kp_init(void);
extern void kp_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern double kp_boom(double i);
extern double kp_fail(const uint8_t *p, size_t len);
extern double kp_ok(double x);

static jmp_buf trap_jmp;
static int sink_calls = 0;

/* The spec's parse rule: baseline vs structured off msg[0]; structured
 * messages split after the 0x01 marker on 0x1F into text/code/symbol/
 * remediation. The trailing text_printable pins that the human text leads
 * the buffer with a printable byte (plain-text degradation). */
static void show(const uint8_t *msg, size_t len) {
  if (len == 0 || msg[0] != 0x01) { /* baseline: the whole buffer is the text */
    printf("baseline printable=%d text=%.*s", len > 0 && msg[0] >= 0x20, (int)len, (const char *)msg);
    return;
  }
  static const char *names[4] = {"text", "code", "symbol", "remediation"};
  const uint8_t *p = msg + 1, *end = msg + len;
  int fields = 0;
  for (;;) {
    const uint8_t *sep = memchr(p, 0x1f, (size_t)(end - p));
    const uint8_t *stop = sep != NULL ? sep : end;
    if (fields < 4) printf("%s=[%.*s]\n", names[fields], (int)(stop - p), (const char *)p);
    fields++;
    if (sep == NULL) break;
    p = sep + 1;
  }
  printf("fields=%d text_printable=%d\n", fields, len > 1 && msg[1] >= 0x20);
}

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx;
  sink_calls++;
  printf("sink[%d]:\n", sink_calls);
  show(msg, len);
  printf("addr: %s\n", addr != 0 ? "nonzero" : "zero");
  longjmp(trap_jmp, 1);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "trap";

  if (strcmp(mode, "preregister") == 0) {
    /* No sink registered: the trap must abort (K6). Nothing after the
     * call may print. */
    kp_init();
    kp_boom(50);
    printf("UNREACHABLE\n");
    return 0;
  }

  kp_set_panic_sink(sink, NULL);
  kp_init();

  if (strcmp(mode, "hostleak") == 0) {
    void *leaked = malloc(64);
    if (leaked == NULL) return 3;
    printf("host leak left for LeakSanitizer\n");
    fflush(stdout); /* the leak check exits without flushing stdio */
    return 0;
  }

  if (strcmp(mode, "trap") == 0) {
    if (setjmp(trap_jmp) == 0) {
      kp_boom(9);
      printf("UNREACHABLE\n");
    } else {
      printf("survived, sink_calls=%d\n", sink_calls);
    }
    return 0;
  }

  if (strcmp(mode, "throw") == 0) {
    if (setjmp(trap_jmp) == 0) {
      kp_fail((const uint8_t *)"kaput", 5);
      printf("UNREACHABLE\n");
    } else {
      printf("survived, sink_calls=%d\n", sink_calls);
    }
    return 0;
  }

  if (strcmp(mode, "poisoned") == 0) {
    if (setjmp(trap_jmp) == 0) {
      kp_boom(9);
    } else {
      printf("poisoned now\n");
      fflush(stdout);
      kp_ok(1); /* must abort — the library is poisoned */
      printf("UNREACHABLE\n");
    }
    return 0;
  }

  fprintf(stderr, "unknown mode %s\n", mode);
  return 2;
}
