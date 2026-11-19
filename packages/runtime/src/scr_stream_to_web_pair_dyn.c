/* Duplex.toWeb over a checked-dynamic value (Node's
 * newReadableWritablePairFromDuplex over a value only the runtime knows):
 * a boxed native Duplex unwraps and any other value throws Node's
 * ERR_INVALID_ARG_TYPE. A unit of its own so the typed path does not link
 * the checked-dynamic stream unit. */
#include "scr_runtime.h"
#include "scr_stream.h"

/* Duplex.toWeb over a checked-dynamic value: a boxed native Duplex unwraps
 * (both sides present), and any other value throws Node's
 * ERR_INVALID_ARG_TYPE. */
ScrDyn *scr_stream_to_web_duplex_dyn(const ScrDyn *value, double flags) {
  ScrStream *d = scr_stream_dyn_native(value, 1);
  if (d) {
    ScrStream *w = scr_stream_dyn_native(value, 2);
    if (w) {
      /* A duplex answers the same stream for both sides; the second read is
       * only the check, so its reference goes. */
      scr_stream_release(w);
      ScrDyn *out = scr_stream_to_web_duplex(d, flags);
      scr_stream_release(d);
      return out;
    }
    scr_stream_release(d);
  }
  scr_dyn_arg_type_fail("duplex", "an stream.Duplex", value);
  return NULL;
}
