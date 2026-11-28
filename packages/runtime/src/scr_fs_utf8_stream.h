/* scriptc runtime — fs.Utf8Stream (scr_fs_utf8_stream.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_FS_UTF8_STREAM_H
#define SCR_FS_UTF8_STREAM_H

#include "scr_dyn.h"

/* fs.Utf8Stream(options): Node's buffered file writer as a checked-dynamic
 * handle — write/end/destroy/flush/flushSync/reopen, the ready/write/
 * drop/finish/close/drain events through on/once/off, and the class's
 * append/contentMode/fd/file/fsync/maxLength/minLength/mkdir/mode/
 * periodicFlush/sync/writing members. The options record carries fd or dest
 * (dest opened here, mkdir creating its directory), append (default true),
 * contentMode ("utf8" or "buffer"), fsync, maxLength (a write that would
 * exceed it is dropped with the "drop" event), minLength, mode,
 * periodicFlush and sync. +1 handle, or NULL with the exception pending. */
ScrDyn *scr_fs_utf8_stream_new(ScrDyn *options);

#endif /* SCR_FS_UTF8_STREAM_H */
