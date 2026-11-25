/* scriptc runtime — the global FormData class (scr_formdata.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_FORMDATA_H
#define SCR_FORMDATA_H

#include "scr_dyn.h"

/* `new FormData()`: a handle with no entries (+1), or NULL with the
 * exception pending. The constructor takes no arguments. */
ScrDyn *scr_formdata_new(void);
/* The FormData class value Node's global names (+1). */
ScrDyn *scr_formdata_class(void);
/* `value instanceof FormData` (value borrowed). */
bool scr_formdata_instanceof(ScrDyn *value, double kind);
/* The multipart/form-data encoding Node sends for a FormData body: the body
 * bytes (+1) and the content type carrying the boundary (+1), or NULL with
 * the exception pending. The form is a FormData handle (borrowed). */
ScrBytes *scr_formdata_encode(const ScrDyn *form, ScrStr **content_type);

#endif /* SCR_FORMDATA_H */
