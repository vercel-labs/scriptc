/* stream.setDefaultHighWaterMark/getDefaultHighWaterMark: the highWaterMark
 * a stream created without one takes. A unit of its own, so the net and http
 * units (whose streams take the same default at construction) link it without
 * the whole stream unit. */
#include "scr_runtime.h"
#include "scr_stream.h"

#include <math.h>
#include <stdio.h>

/* Node v24's stream default (lib/internal/streams/state.js — 64 KiB
 * since nodejs/node#52037, EXCEPT win32, where the very same line keeps
 * the old 16 KiB: `process.platform === 'win32' ? 16 * 1024 : 64 * 1024`.
 * The triple decides at compile time, like the path/EOL bindings). */
#ifdef _WIN32
#define SCR_STREAM_DEFAULT_HWM 16384
#else
#define SCR_STREAM_DEFAULT_HWM 65536
#endif

/* stream.setDefaultHighWaterMark changes what new streams take; both
 * defaults are process state (Node keeps them in
 * lib/internal/streams/state.js), and getDefaultHighWaterMark answers
 * them. A stream created with an explicit highWaterMark is unaffected. */
static SCR_TL double scr_default_hwm_bytes = SCR_STREAM_DEFAULT_HWM;
static SCR_TL double scr_default_hwm_objects = 16;

void scr_stream_set_default_hwm(bool object_mode, double value) {
  /* validateInteger(value, 'value', 0): a fractional, NaN or infinite
   * value names the integer it must be; an integer outside the safe
   * range names its bounds. */
  bool integer = isfinite(value) && trunc(value) == value;
  if (!integer || value < 0 || value > 9007199254740991.0) {
    char received[48];
    scr_num_received(value, received);
    char text[192];
    int n = snprintf(text, sizeof text,
                     "The value of \"value\" is out of range. It must be %s. Received %s",
                     integer ? ">= 0 && <= 9007199254740991" : "an integer", received);
    scr_throw_error_msg_code(SCR_ERR_RANGE, text, n < 0 ? 0 : (size_t)n, "ERR_OUT_OF_RANGE");
    return;
  }
  if (object_mode) scr_default_hwm_objects = value;
  else scr_default_hwm_bytes = value;
}

double scr_stream_get_default_hwm(bool object_mode) {
  return object_mode ? scr_default_hwm_objects : scr_default_hwm_bytes;
}
