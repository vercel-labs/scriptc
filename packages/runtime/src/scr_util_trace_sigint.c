/* node:util's setTraceSigInt(enable): toggles the SIGINT tracing hook that
 * Node's --trace-sigint diagnostics read. A compiled native program has no
 * such hook (and no --trace-sigint mode), and Node's call reads neither the
 * argument nor any other state: it answers undefined for every value. */
#include "scr_runtime.h"

void scr_util_set_trace_sig_int(ScrDyn *enable) { (void)enable; }
