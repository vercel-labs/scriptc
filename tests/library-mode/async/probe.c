/* K15 async-drain probe. The library's every emission is recorded through
 * the `emit` channel and printed with a "lib:" tag; the host's own
 * observations print with "host:". What the transcript has to show:
 *
 *  - a scheduled continuation does NOT run when it is scheduled, and does
 *    not run when the entry that scheduled it returns;
 *  - it runs at the drain, and only there;
 *  - settling a promise from the host QUEUES the parked fiber's
 *    continuation rather than resuming it inline (the settle entry still
 *    observes the pre-continuation state);
 *  - the drain returns after the queues are empty, so the host keeps the
 *    thread and the loop is never involved.
 *
 * Without the drain entry there is nothing to call and the last four
 * "lib:" lines never appear at all — which is the bug this fixture pins.
 */
#include <stdint.h>
#include <stdio.h>

extern void ka_init(void);
extern void ka_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void ka_collect(void);
extern void ka_drain(void);
extern int32_t ka_set_callback(const char *name, void (*fn)(void), void *ctx);
extern double ka_start(const uint8_t *p, size_t len);
extern double ka_schedule(void);
extern double ka_settle(const uint8_t *p, size_t len);
extern double ka_done(void);

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  printf("UNEXPECTED SINK: %.*s", (int)len, (const char *)msg);
}

static void on_emit(void *ctx, const uint8_t *p, size_t len) {
  (void)ctx;
  printf("lib: %.*s\n", (int)len, (const char *)p);
}

#define LIT(s) (const uint8_t *)(s), sizeof(s) - 1

int main(void) {
  ka_set_panic_sink(sink, NULL);
  ka_set_callback("emit", (void (*)(void))on_emit, NULL);
  ka_init();

  /* A bare promise continuation: queued, not run. */
  printf("host: schedule -> %.0f\n", ka_schedule());
  printf("host: still %.0f before any drain\n", ka_done());
  ka_drain();
  printf("host: after drain %.0f\n", ka_done());

  /* An async handler that awaits twice on host-settled promises. */
  printf("host: start -> %.0f\n", ka_start(LIT("job")));
  printf("host: settle -> %.0f\n", ka_settle(LIT("X")));
  ka_drain();
  printf("host: settle -> %.0f\n", ka_settle(LIT("Y")));
  ka_drain();
  printf("host: done -> %.0f\n", ka_done());

  /* Quiescent: a drain with nothing queued is a no-op that returns. */
  ka_drain();
  printf("host: quiescent drain returned\n");
  ka_collect();
  return 0;
}
