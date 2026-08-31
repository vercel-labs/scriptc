/* Host-callback acceptance probe, mode-selected by argv[1]:
 *   run         — the full happy path: registration return codes (0 known,
 *                 -1 unknown/NULL name), a service-shaped export streaming
 *                 chunks through the bytes+u32 channel interleaved with
 *                 computation (contents, order, and thread identity all
 *                 recorded by the callback and asserted after the entry
 *                 returns — the calls are synchronous, on the calling
 *                 thread), string/bool and scalar channels, host RETURNS
 *                 riding i32/u32 back into compiled code, re-registration
 *                 routing to the new context, and finally a NULL-fn clear
 *                 followed by a call: the SC4025 structured trap through
 *                 the sink, exactly once, naming the entry the host called
 *   orphan      — a channel the host never registered: the first call
 *                 traps SC4025 (symbol cb_poke_orphan), the sink longjmps
 *                 out (the conforming survival pattern), and the poisoned
 *                 library aborts the next entry deterministically
 *   preregister — an unregistered-channel call BEFORE sink registration
 *                 aborts (the funnel's last resort)
 *   reenter-*   — a handler attempts the named ABI entry. SC4026 reaches
 *                 the original sink exactly once, names the INNER symbol,
 *                 leaves post-poison pure registration available, then the
 *                 next runtime-touching entry aborts.
 */
#include <pthread.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void cb_init(void);
extern void cb_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void cb_collect(void);
extern void cb_reset_results(void);
extern int32_t cb_set_callback(const char *name, void (*fn)(void), void *ctx);
extern double cb_stream(double n, double base);
extern void cb_buffered(double n, const uint8_t **out, size_t *out_len);
extern double cb_ask_host(double x);
extern double cb_poke_orphan(void);

typedef void (*cb_fn)(void);

/* ── chunk recording (the bytes+u32 channel) ─────────────────────────── */

typedef struct {
  char bytes[8];
  size_t len;
  uint32_t seq;
} ChunkRec;

typedef struct {
  const char *tag;
  ChunkRec chunks[16];
  int count;
  int thread_ok; /* every delivery arrived on the registering thread */
} ChunkLog;

static void on_chunk(void *ctx, const uint8_t *p, size_t len, uint32_t seq) {
  ChunkLog *log = (ChunkLog *)ctx;
  ChunkRec *rec = &log->chunks[log->count];
  /* Borrowed for the duration of the call only: copy out. */
  memcpy(rec->bytes, p, len < sizeof rec->bytes ? len : sizeof rec->bytes);
  rec->len = len;
  rec->seq = seq;
  log->count++;
}

static pthread_t main_thread;

static void on_chunk_thread_check(void *ctx, const uint8_t *p, size_t len, uint32_t seq) {
  ChunkLog *log = (ChunkLog *)ctx;
  on_chunk(ctx, p, len, seq);
  if (!pthread_equal(pthread_self(), main_thread)) log->thread_ok = 0;
}

static void dump_chunks(const ChunkLog *log) {
  printf("%s: %d chunk(s), thread_ok=%d\n", log->tag, log->count, log->thread_ok);
  for (int i = 0; i < log->count; i++) {
    printf("  seq=%u len=%zu bytes=%.*s\n", log->chunks[i].seq, log->chunks[i].len,
           (int)log->chunks[i].len, log->chunks[i].bytes);
  }
}

/* ── the other channels ──────────────────────────────────────────────── */

static char note_log[512];

static void on_note(void *ctx, const uint8_t *p, size_t len, uint8_t last) {
  (void)ctx;
  size_t used = strlen(note_log);
  snprintf(note_log + used, sizeof note_log - used, "[%.*s last=%d]", (int)len, (const char *)p, last != 0);
}

static int32_t on_progress(void *ctx, double done, double total) {
  (void)ctx;
  return (int32_t)(total - done);
}

static uint32_t on_mix(void *ctx, uint8_t a, int32_t b) {
  (void)ctx;
  return (uint32_t)a + (uint32_t)(-b);
}

/* ── callback-time re-entry probes ───────────────────────────────────── */

enum ReentryAction {
  REENTER_EXPORT,
  REENTER_INIT,
  REENTER_RESET,
  REENTER_COLLECT,
  REENTER_SINK,
  REENTER_CALLBACK_UNKNOWN,
};

static enum ReentryAction reentry_action;
static int replacement_sink_calls = 0;

static void replacement_sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)msg; (void)len; (void)addr;
  replacement_sink_calls++;
  printf("REPLACEMENT SINK\n");
}

static void on_reenter(void *ctx, const uint8_t *p, size_t len, uint32_t seq) {
  (void)ctx; (void)p; (void)len; (void)seq;
  switch (reentry_action) {
    case REENTER_EXPORT: cb_stream(1, 1); break;
    case REENTER_INIT: cb_init(); break;
    case REENTER_RESET: cb_reset_results(); break;
    case REENTER_COLLECT: cb_collect(); break;
    case REENTER_SINK: cb_set_panic_sink(replacement_sink, NULL); break;
    case REENTER_CALLBACK_UNKNOWN:
      /* The guard must precede even this unknown-name dispatch. */
      cb_set_callback("not-a-channel", (cb_fn)on_chunk, NULL);
      break;
  }
  printf("UNREACHABLE callback return\n");
}

/* ── the panic sink (the traps probe's parse rule) ───────────────────── */

static jmp_buf trap_jmp;
static int sink_calls = 0;

static void show(const uint8_t *msg, size_t len) {
  if (len == 0 || msg[0] != 0x01) {
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
  const char *mode = argc > 1 ? argv[1] : "run";
  main_thread = pthread_self();

  static ChunkLog log_a = {.tag = "log_a", .thread_ok = 1};
  static ChunkLog log_b = {.tag = "log_b", .thread_ok = 1};

  if (strcmp(mode, "preregister") == 0) {
    /* No sink registered: the unregistered-channel trap must abort.
     * Nothing after the call may print. */
    cb_init();
    cb_poke_orphan();
    printf("UNREACHABLE\n");
    return 0;
  }

  if (strcmp(mode, "orphan") == 0) {
    cb_set_panic_sink(sink, NULL);
    /* Everything BUT orphan registered: reaching the one unregistered
     * channel is the defined trap, whatever else is wired. */
    cb_set_callback("emitChunk", (cb_fn)on_chunk_thread_check, &log_a);
    cb_set_callback("progress", (cb_fn)on_progress, NULL);
    cb_set_callback("note", (cb_fn)on_note, NULL);
    cb_set_callback("mix", (cb_fn)on_mix, NULL);
    cb_init();
    if (setjmp(trap_jmp) == 0) {
      cb_poke_orphan();
      printf("UNREACHABLE\n");
    } else {
      printf("survived, sink_calls=%d\n", sink_calls);
      fflush(stdout);
      cb_stream(1, 1); /* must abort — the library is poisoned */
      printf("UNREACHABLE\n");
    }
    return 0;
  }

  if (strncmp(mode, "reenter-", 8) == 0) {
    const char *which = mode + 8;
    if (strcmp(which, "export") == 0) reentry_action = REENTER_EXPORT;
    else if (strcmp(which, "init") == 0) reentry_action = REENTER_INIT;
    else if (strcmp(which, "reset") == 0) reentry_action = REENTER_RESET;
    else if (strcmp(which, "collect") == 0) reentry_action = REENTER_COLLECT;
    else if (strcmp(which, "sink") == 0) reentry_action = REENTER_SINK;
    else if (strcmp(which, "callback-unknown") == 0) reentry_action = REENTER_CALLBACK_UNKNOWN;
    else return 64;
    cb_set_panic_sink(sink, NULL);
    cb_set_callback("emitChunk", (cb_fn)on_chunk, &log_a);
    cb_init();
    const uint8_t *saved = NULL;
    size_t saved_len = 0;
    cb_buffered(7, &saved, &saved_len); /* held by the explicit-reset arena */
    cb_set_callback("emitChunk", (cb_fn)on_reenter, NULL);
    if (setjmp(trap_jmp) == 0) {
      cb_buffered(8, NULL, NULL); /* callback attempts an ABI entry; no result returns */
      printf("UNREACHABLE outer return\n");
    } else {
      /* The re-entry path cleared callback-active before delivery. Pure
       * registration therefore retains its established post-poison rule. */
      printf("post-poison register: %d\n", (int)cb_set_callback("emitChunk", (cb_fn)on_chunk, &log_a));
      printf("replacement-sink-calls=%d\n", replacement_sink_calls);
      printf("saved-result=[%.*s]\n", (int)saved_len, (const char *)saved);
      fflush(stdout);
      cb_stream(1, 1); /* poisoned runtime-touching entry must abort */
      printf("UNREACHABLE poisoned entry\n");
    }
    return 0;
  }

  /* mode "run" */

  /* Registration is a pure store, legal before init; return codes are the
   * defined refusal surface (-1 unknown or NULL name, 0 stored). */
  printf("reg unknown: %d\n", (int)cb_set_callback("nope", (cb_fn)on_chunk, &log_a));
  printf("reg null-name: %d\n", (int)cb_set_callback(NULL, (cb_fn)on_chunk, &log_a));
  printf("reg emitChunk: %d\n", (int)cb_set_callback("emitChunk", (cb_fn)on_chunk_thread_check, &log_a));
  printf("reg progress: %d\n", (int)cb_set_callback("progress", (cb_fn)on_progress, NULL));
  printf("reg note: %d\n", (int)cb_set_callback("note", (cb_fn)on_note, NULL));
  printf("reg mix: %d\n", (int)cb_set_callback("mix", (cb_fn)on_mix, NULL));

  cb_set_panic_sink(sink, NULL);
  cb_init();

  /* The service-shaped stream: chunks arrive synchronously, in order, on
   * this thread, fully delivered by the time the entry returns. */
  double r1 = cb_stream(4, 3);
  printf("stream(4,3) = %g\n", r1);
  dump_chunks(&log_a);
  printf("notes: %s\n", note_log);

  log_a.count = 0;
  note_log[0] = '\0';
  double r2 = cb_stream(2, 7);
  printf("stream(2,7) = %g\n", r2);
  dump_chunks(&log_a);
  printf("notes: %s\n", note_log);

  /* Host returns ride i32/u32 back into compiled code. */
  printf("askHost(5) = %g\n", cb_ask_host(5));

  /* Re-registration: latest wins — chunks route to the NEW context. */
  printf("reg emitChunk again: %d\n", (int)cb_set_callback("emitChunk", (cb_fn)on_chunk_thread_check, &log_b));
  log_a.count = 0;
  double r3 = cb_stream(1, 9);
  printf("stream(1,9) = %g\n", r3);
  printf("log_a after reroute: %d chunk(s)\n", log_a.count);
  dump_chunks(&log_b);

  /* Buffer results and callback channels coexist: collect between calls. */
  cb_collect();

  /* NULL clears the channel; the next call through it is the SC4025
   * structured trap — exactly once, naming the entry the host called. */
  printf("reg emitChunk clear: %d\n", (int)cb_set_callback("emitChunk", NULL, NULL));
  if (setjmp(trap_jmp) == 0) {
    cb_stream(1, 1);
    printf("UNREACHABLE\n");
  } else {
    printf("survived, sink_calls=%d\n", sink_calls);
  }
  return 0;
}
