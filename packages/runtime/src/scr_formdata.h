/* scriptc runtime — WHATWG FormData (scr_formdata.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_FORMDATA_H
#define SCR_FORMDATA_H

#include "scr_dyn.h"

/* ── FormData (scr_formdata.c) ─────────────────────────────────────────
 * Node 24's undici FormData: an ordered list of [name, File|string]
 * entries. The value is a checked-dynamic handle whose methods are
 * undici's, with its entry list in C. `args` is the constructor's
 * argument vector (borrowed): Node's FormData takes no form element, and
 * any argument but undefined throws Node's conversion TypeError.
 * Answers +1, or NULL with the exception pending. */
ScrDyn *scr_formdata_new(ScrDyn *args);
/* `v instanceof FormData`. */
bool scr_formdata_is(const ScrDyn *value);
/* The multipart/form-data encoding undici sends for a FormData body:
 * +1 bytes and the +1 `multipart/form-data; boundary=…` type. False
 * (touching neither output) for every other value. */
bool scr_formdata_multipart(const ScrDyn *value, ScrBytes **bytes, ScrStr **type);

#endif /* SCR_FORMDATA_H */
