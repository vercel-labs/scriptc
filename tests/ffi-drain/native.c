/* The host half of the drain fixture: native code that owns the main
 * thread and re-enters the compiled program through a retained callback.
 *
 * hd_run() IS the host's loop. scriptc's own loop is not running while it
 * executes — the program is parked inside this call — so the promise jobs
 * the callbacks queue would otherwise sit until the program's main body
 * returns. scriptc_drain() is the point at which this host says "now run
 * what is ready", and it is an ordinary C call that returns. */
#include <stdbool.h>
#include <stddef.h>

/* The runtime's host entry (scr_runtime.h declares it for in-tree code;
 * an embedder declares it exactly like this). */
extern bool scriptc_drain(void);

typedef void (*hd_turn_cb)(double turn);
typedef void (*hd_resolve_cb)(double value);

static hd_turn_cb hd_handler;
static hd_resolve_cb hd_resolve;

void hd_register(hd_turn_cb handler) { hd_handler = handler; }

/* The program hands the host a resolve function; the host keeps it and
 * calls it from its own callback below. */
void hd_take_resolve(hd_resolve_cb resolve) { hd_resolve = resolve; }

double hd_run(void) {
  /* Turn 1 schedules a continuation and starts an async handler. */
  hd_handler(1);
  /* Turn 2 WITHOUT a drain in between: the continuation must still be
   * queued, because nothing has told the program it may run. */
  hd_handler(2);
  scriptc_drain();
  /* Turn 3 sees the bare microtask run — and only that one: the awaiting
   * handler is parked on a promise the host has not settled yet. */
  hd_handler(3);
  /* Now settle it from the host's own callback, exactly as a shell-owned
   * timer would, and drain again. */
  if (hd_resolve != NULL) hd_resolve(7);
  hd_handler(4); /* still parked: resolving queues, it does not resume */
  scriptc_drain();
  hd_handler(5);
  /* A drain with nothing queued is a no-op that returns. */
  scriptc_drain();
  return 5;
}
