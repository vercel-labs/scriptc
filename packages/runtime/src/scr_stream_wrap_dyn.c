/* readable.wrap over a checked-dynamic source (Node reads any object with
 * on/pause/resume): a boxed native readable stream unwraps; any other value
 * throws the not-supported Error. A unit of its own so the typed path does
 * not link the checked-dynamic stream unit. */
#include "scr_runtime.h"
#include "scr_stream.h"

/* readable.wrap over a checked-dynamic source: a boxed native readable
 * unwraps; any other value throws the not-supported Error. */
ScrStream *scr_stream_wrap_dyn(ScrStream *self, const ScrDyn *value) {
  ScrStream *src = scr_stream_dyn_native(value, 1);
  if (!src) {
    static const char message[] =
        "readable.wrap over a checked-dynamic value that is not a native readable stream is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  ScrStream *out = scr_stream_wrap(self, src);
  scr_stream_release(src);
  return out;
}
