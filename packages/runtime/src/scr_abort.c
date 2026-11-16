/* Portable AbortController/AbortSignal use the same implementation as native
 * fetch, without its network transport, Web Streams, or global fetch setup. */

#define SCR_FETCH_SIGNAL_ONLY 1
#include "scr_fetch.c"
