/* scriptc runtime — node:module's SourceMap class (scr_source_map.c). */
#ifndef SCR_SOURCE_MAP_H
#define SCR_SOURCE_MAP_H

#include "scr_core.h"
#include "scr_dyn.h"

/* new SourceMap(payload[, options]): a handle holding Node's shallow copy of
 * the payload and its parsed, ordered ranges (+1); NULL with Node's
 * TypeError pending when the payload is not an object. */
ScrDyn *scr_source_map_new(ScrDyn *payload, ScrDyn *options);
/* `value instanceof SourceMap`: the handle tag, nothing else. */
bool scr_source_map_is(const ScrDyn *value);

#endif
