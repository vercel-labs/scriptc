/* scriptc runtime — appendFileSync with a creation mode
 * (scr_fs_append_mode.c). Included by scr_runtime.h, which says where new
 * declarations go. */
#ifndef SCR_FS_APPEND_MODE_H
#define SCR_FS_APPEND_MODE_H

/* appendFileSync(path, string, { mode }) (scr_fs_append_mode.c — a unit of
 * its own, selected only by programs that pass `mode` to an append: adding
 * the function to scr_lib.c changes that unit's object, which every program
 * that links it carries into its executable). `mode` is open(2)'s O_CREAT
 * argument (it applies at CREATION only, umask applying; an existing file
 * keeps its permissions, exactly Node). A failure THROWS Node's fs error
 * catchably. */
void scr_fs_append_file_mode(ScrStr *path, ScrStr *data, double mode);

#endif
