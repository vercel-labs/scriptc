#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <fcntl.h> /* _O_BINARY */
#include <io.h>    /* _setmode, _fileno */
#endif

/* Set by scr_async.c at loop exhaustion; lives here (unconditionally) so
 * binaries that link the console without the async runtime still link, and
 * plain builds satisfy scr_async's reference. */
static SCR_TL long scr_abandoned_fibers = 0;
void scr_note_abandoned_fibers(long n) { scr_abandoned_fibers = n; }
/* Read back by the LIBRARY RC audit (scr_library.c), which cannot call
 * scr_async.c's own counter: that unit joins a library link only when the
 * graph reaches a promise, while this note is always present. */
long scr_abandoned_fiber_note(void) { return scr_abandoned_fibers; }

#ifndef SCR_LIB
#ifdef SCR_RC_AUDIT
extern long scr_str_live_count(void);     /* scr_string.c */
extern long scr_arr_live_count(void);     /* scr_array.c */
extern long scr_map_live_count(void);     /* scr_map.c */
extern long scr_box_live_count(void);     /* scr_closure.c */
extern long scr_closure_live_count(void); /* scr_closure.c */
extern long scr_obj_live_count(void);     /* scr_object.c */
extern long scr_union_live_count(void);   /* scr_union.c */
extern long scr_dyn_live_count(void);     /* scr_json.c */
extern long scr_bytes_live_count(void);   /* scr_bytes.c */
#ifdef SCR_DYNAMIC
extern long scr_jsval_live_count(void); /* scr_island.c */
#endif

static void scr_rc_audit_at_exit(void) {
  /* Fibers suspended forever at loop exhaustion (awaits nobody resolves —
   * Node exits 0 there too) still hold their stacks and owned values by
   * design; a strict audit would only report that deliberate abandonment. */
  if (scr_abandoned_fibers > 0) {
    fprintf(stderr, "scriptc RC audit skipped: %ld fiber(s) never resumed\n",
            scr_abandoned_fibers);
    return;
  }
  long strings = scr_str_live_count();
  long arrays = scr_arr_live_count();
  long maps = scr_map_live_count();
  long boxes = scr_box_live_count();
  long closures = scr_closure_live_count();
  long objects = scr_obj_live_count();
  long unions = scr_union_live_count();
  long dyns = scr_dyn_live_count();
  long bytes = scr_bytes_live_count();
#ifdef SCR_DYNAMIC
  long jsvals = scr_jsval_live_count();
#else
  long jsvals = 0;
#endif
  if (strings != 0 || arrays != 0 || maps != 0 || boxes != 0 || closures != 0 ||
      objects != 0 || unions != 0 || dyns != 0 || bytes != 0 || jsvals != 0) {
    fflush(stdout);
    fprintf(stderr,
            "scriptc RC AUDIT FAILED: %ld heap string(s), %ld array(s), "
            "%ld map(s), %ld box(es), %ld closure(s), %ld object(s), "
            "%ld union(s), %ld dyn value(s), %ld bytes value(s), "
            "%ld island value(s) live at exit\n",
            strings, arrays, maps, boxes, closures, objects, unions, dyns,
            bytes, jsvals);
    _Exit(99);
  }
}
#endif

static void scr_flush_at_exit(void) { fflush(stdout); }

static void scr_collect_cycles_at_exit(void) { scr_collect_cycles(); }

void scr_runtime_abi_v1(void) {}

void scr_init(void) {
#ifdef _WIN32
  /* The CRT opens std streams in TEXT mode, which writes \n as \r\n. Node
   * on Windows does NOT translate — console.log emits \n whether stdout is
   * a pipe or the console (libuv writes the bytes as given) — so the
   * streams switch to binary here or every line would differ from the
   * oracle by a byte. stdin too: readFileSync(0) must see the bytes on the
   * pipe, not a CRLF-collapsed view. */
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stderr), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  /* A private formatting buffer coalesces the several stdio calls needed to
   * render one console line. Every JavaScript-visible stdout write flushes
   * before returning, so this buffer is never observable as delayed output:
   * Node hands each console.log/process.stdout.write chunk to its backing
   * stream immediately. */
  static char outbuf[1 << 16];
  setvbuf(stdout, outbuf, _IOFBF, sizeof outbuf);
  /* atexit is LIFO; registration order makes exit run: library cleanup
   * (registered later, in scr_lib_init) → cycle collection → RC audit →
   * flush. The final collection frees cycles the program dropped, so the
   * audit (and ASan's leak check) see them as freed, not leaked. */
  atexit(scr_flush_at_exit);
#ifdef SCR_RC_AUDIT
  atexit(scr_rc_audit_at_exit);
#endif
  atexit(scr_collect_cycles_at_exit);
}
#endif /* !SCR_LIB — a library artifact never touches host stdio modes/buffering and
        * registers no atexit handlers: scr_init and its exit hooks (the
        * audit's _Exit(99) included) are executable-lane machinery; the
        * library session reset lives in scr_library.c. */

/* ONE formatter for both console streams — console.error/warn print
 * byte-identically to console.log in Node (same inspect rendering), only
 * the stream differs. */
static void scr_console_write(FILE *out, size_t n, const ScrLogArg *args) {
  char numbuf[32];
  for (size_t i = 0; i < n; i++) {
    if (i > 0) fputc(' ', out);
    const ScrLogArg *a = &args[i];
    switch (a->tag) {
    case SCR_ARG_F64: {
      /* console.log renders numbers via inspect, which distinguishes -0
       * (String(-0) is "0", but console.log(-0) prints "-0"). */
      if (a->v.f == 0 && signbit(a->v.f)) {
        fputs("-0", out);
        break;
      }
      size_t len = scr_f64_to_str(a->v.f, numbuf);
      fwrite(numbuf, 1, len, out);
      break;
    }
    case SCR_ARG_STR:
      fwrite(a->v.s->data, 1, a->v.s->len, out);
      break;
    case SCR_ARG_BOOL:
      fputs(a->v.b ? "true" : "false", out);
      break;
    }
  }
  fputc('\n', out);
  /* Console methods submit one formatted chunk to their backing stream.
   * Keep the C buffer only as a formatter coalescing detail: a caller
   * observing a live child must see this line before the next JS turn. */
  fflush(out);
}

void scr_console_log(size_t n, const ScrLogArg *args) {
  scr_console_write(stdout, n, args);
}

/* console.error and console.warn. Flush stdout first so runtime-internal
 * output that is still being assembled cannot cross this stderr line under
 * a merged redirection (2>&1); JavaScript-visible stdout writes have already
 * flushed themselves. */
void scr_console_error(size_t n, const ScrLogArg *args) {
  fflush(stdout);
  scr_console_write(stderr, n, args);
}

/* One JavaScript-visible raw write. Node's global console and process stream
 * methods hand each chunk to the backing stream when called; they do not
 * retain stdout until a later stderr write, a 64 KiB threshold, or process
 * exit. The runtime remains synchronous internally, so its backpressure
 * surface is still constantly true, but the bytes are observable promptly.
 *
 * stderr flushes any runtime-internal stdout fragment first to preserve the
 * existing merged-fd ordering convention. */
void scr_stdio_write(int fd, const void *data, size_t len) {
  FILE *out = fd == 2 ? stderr : stdout;
  if (fd == 2) fflush(stdout);
  if (len > 0) fwrite(data, 1, len, out);
  fflush(out);
}
