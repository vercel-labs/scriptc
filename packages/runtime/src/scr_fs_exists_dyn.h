/* scriptc runtime — fs.existsSync over a path value that is not statically a
 * string (scr_fs_exists_dyn.c). A separate header because the declaration
 * names ScrDyn, which scr_lib.h precedes. */
#ifndef SCR_FS_EXISTS_DYN_H
#define SCR_FS_EXISTS_DYN_H

#include "scr_core.h"
#include "scr_dyn.h"

/* A string or u8 Buffer path answers like scr_fs_exists; any other value
 * answers false and reports DEP0187 once. */
bool scr_fs_exists_value(ScrDyn *value);

#endif
