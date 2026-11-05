/* scriptc runtime — the kept-source read a record→record conversion makes
 * (scr_record_source_get.c). A module header of its own, not included by
 * scr_runtime.h: the entry point exists for compiler-emitted code, which
 * names the symbol directly, so no other runtime unit needs the
 * declaration — and leaving every other unit's preprocessed text untouched
 * keeps its object byte-identical (zero-cost gate). */
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

#endif
