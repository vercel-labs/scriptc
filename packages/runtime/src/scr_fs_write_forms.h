/* scriptc runtime — fs writes that pass an options record
 * (scr_fs_write_forms.c). Included by scr_runtime.h, which says where new
 * declarations go. */
#ifndef SCR_FS_WRITE_FORMS_H
#define SCR_FS_WRITE_FORMS_H

#include "scr_bytes.h"

/* ── fs writes with an options record (scr_fs_write_forms.c — a unit of its
 * own, selected only by programs that pass `mode` or a write `flag`: adding
 * these functions to scr_lib.c, scr_bytes_io.c or scr_async.c changes those
 * units' objects, which every program that links them carries into its
 * executable). `mode` is open(2)'s O_CREAT argument (it applies at CREATION
 * only, umask applying; an existing file keeps its permissions, exactly Node)
 * and `exclusive` is Node's `flag: "wx"` (O_EXCL: EEXIST when the path
 * exists). Failures THROW Node's fs error catchably; a promise entry REJECTS
 * at its await, the same settled-promise shape as scr_async.c's other
 * fs/promises entries. */
void scr_fs_write_file_text_flags(ScrStr *path, ScrStr *data, double mode, double exclusive);
void scr_fs_append_file_mode(ScrStr *path, ScrStr *data, double mode);
/* fs/promises writeFile(path, Uint8Array, ...): the bytes twin of
 * scr_fs_write_file_text_flags. */
void scr_fs_write_file_bytes_flags(ScrStr *path, const ScrBytes *data, double mode,
                                   double exclusive);
ScrPromise *scr_fsp_write_file_text_flags(ScrStr *path, ScrStr *data, double mode,
                                          double exclusive);
ScrPromise *scr_fsp_write_file_bytes_flags(ScrStr *path, ScrBytes *data, double mode,
                                           double exclusive);

#endif
