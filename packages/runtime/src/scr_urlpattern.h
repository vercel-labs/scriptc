/* scriptc runtime — the global URLPattern class (scr_urlpattern.c).
 * Included by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_URLPATTERN_H
#define SCR_URLPATTERN_H

#include "scr_dyn.h"

/* new URLPattern(input[, baseURL][, options]): `input` is a pattern string,
 * a component record, undefined (an empty pattern) or a URLPattern handle
 * (copied); `baseURL` a string or undefined; `options` a record with
 * ignoreCase or undefined. The runtime validates and compiles the pattern
 * as the standard does. +1 handle, or NULL with Node's TypeError pending. */
ScrDyn *scr_urlpattern_new(ScrDyn *input, ScrDyn *base_url, ScrDyn *options);

/* `value instanceof URLPattern`: true for the runtime's pattern handles. */
bool scr_urlpattern_is(const ScrDyn *value);

/* Installs the URLPattern handle ops for the calling thread's dynamic
 * registry: the emitted entry point calls it for every execution context
 * (the main thread and each worker), where a process constructor alone
 * leaves a worker without them. */
void scr_urlpattern_install(void);

#endif /* SCR_URLPATTERN_H */
