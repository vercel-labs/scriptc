/* scriptc runtime — the kept-source read a record→record conversion makes
 * (scr_record_source_get.c). The entry point exists for compiler-emitted code,
 * which names the symbol directly, so no other runtime unit calls it; the unit
 * stays apart so that a program which never projects a record links neither it
 * nor its call into the object model. The declaration sits in the runtime
 * header list like every other module header's, so the backend's check that
 * every scr_* name it can emit is declared sees it. */
#ifndef SCR_RECORD_SOURCE_GET_H
#define SCR_RECORD_SOURCE_GET_H

#include "scr_core.h"
#include "scr_dyn.h"

/* The kept value of `key` (+1), or the undefined value when the record keeps
 * no source or its source has no such key. The view holds the source's own
 * properties with their attributes, so the answer is that property read
 * through the view: an accessor runs with the view as its receiver, as it
 * does for every other observer of the kept source. The view's prototype
 * chain is not consulted, because the note copies own properties only. */
ScrDyn *scr_record_source_get(const void *rec, const char *key, size_t key_len);

/* Whether the record's kept source holds `key` as an own property. False when
 * the record keeps no source. A conversion asks this before the read so that a
 * key the source lacks leaves the target field absent, as the erasure does,
 * rather than present with the undefined value. */
bool scr_record_source_has_key(const void *rec, const char *key, size_t key_len);

#endif
