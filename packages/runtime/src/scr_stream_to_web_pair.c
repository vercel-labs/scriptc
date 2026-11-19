/* Duplex.toWeb (Node's newReadableWritablePairFromDuplex in
 * lib/internal/webstreams/adapters.js): the { readable, writable } pair of
 * web streams over a native Duplex. Each side is the matching adapter
 * (scr_stream_to_web.c and scr_stream_writable_to_web.c), built in Node's
 * own order — the writable first, so the returned object's keys enumerate
 * writable then readable. A destroyed Duplex adapts to a closed
 * WritableStream and a ReadableStream that ends at once, which is what the
 * two adapters build for it. Linked only by programs that use both the
 * stream and web stream units. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <stdlib.h>

/* Duplex.toWeb(duplex[, options]): the pair (+1). flags' bit 1 asks for a
 * byte readable side (options.readableType === 'bytes'). */
ScrDyn *scr_stream_to_web_duplex(ScrStream *d, double flags) {
  ScrDyn *out = scr_dyn_new_obj();
  if (!out) abort();
  ScrDyn *w = scr_stream_writable_to_web(d, flags);
  /* scr_dyn_obj_set takes ownership of the value: the field is its
   * reference. */
  if (w) scr_dyn_obj_set(out, "writable", 8, w);
  ScrDyn *r = scr_stream_to_web_readable(d, flags);
  if (r) scr_dyn_obj_set(out, "readable", 8, r);
  return out;
}
