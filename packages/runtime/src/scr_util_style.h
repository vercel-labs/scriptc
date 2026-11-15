/* scriptc runtime — util.styleText's format table (scr_util_style.c), read
 * by util.inspect for its colors object. Included by scr_inspect.c only. */
#ifndef SCR_UTIL_STYLE_H
#define SCR_UTIL_STYLE_H

#include <stddef.h>

/* The table in Node's inspect.colors order: the standard names first (its
 * enumerable properties) and the non-enumerable aliases (grey, faint, ...)
 * after them. */
size_t scr_util_style_color_count(void);
size_t scr_util_style_color_enumerable_count(void);
const char *scr_util_style_color_name(size_t index);
unsigned scr_util_style_color_open(size_t index);
unsigned scr_util_style_color_close(size_t index);

#endif
