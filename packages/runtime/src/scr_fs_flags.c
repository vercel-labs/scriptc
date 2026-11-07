/* The fs/promises twin of the flag-carrying copy form: the fs.copyFile mode
 * argument rides scr_fs_cp.c's SCR_FS_FLAGS build, whose reflink helper it
 * reuses, and that form's Windows arm sits beside the Win32 path helpers in
 * scr_lib.c. */
#include "scr_runtime.h"

ScrPromise *scr_fsp_copyfile_flags(ScrStr *src, ScrStr *dest, double mode) {
  scr_fs_copyfile_flags(src, dest, mode);
  return scr_promise_settled_void();
}
