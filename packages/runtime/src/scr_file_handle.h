/* scriptc runtime — file descriptors and fs.promises FileHandle
 * (scr_file_handle.c). Included by scr_runtime.h, which says where new
 * declarations go. */
#ifndef SCR_FILE_HANDLE_H
#define SCR_FILE_HANDLE_H

#include "scr_lib.h"

/* fs.openSync(path, flags) → the raw fd as f64 (Node's string flag
 * grammar; unknown flags throw Node's ERR_INVALID_ARG_VALUE TypeError
 * text, open(2) failures the Node fs error shape), and fs.closeSync(fd)
 * (failure throws the path-less "EBADF: bad file descriptor, close").
 * The pair behind spawn's fd-stdio form. */
double scr_fs_open(ScrStr *path, ScrStr *flags);
double scr_fs_open_numeric(ScrStr *path, double flags, double mode);
/* Engine callers supply the target OS's flags, rather than the frontend's
 * portable constant mask. Argument validation happens before this seam. */
double scr_fs_open_native(ScrStr *path, double flags, double mode);
ScrFileHandle *scr_file_handle_open(ScrStr *path, ScrStr *flags, double mode);
ScrFileHandle *scr_file_handle_retain(ScrFileHandle *h);
void scr_file_handle_release(ScrFileHandle *h);
void *scr_file_handle_retain_v(void *p);
void scr_file_handle_release_v(void *p);
double scr_file_handle_fd(ScrFileHandle *h);
void scr_file_handle_close(ScrFileHandle *h);
/* The streams over a handle (scr_fs_stream_fh.c): Node's kRef, the
 * stream close's kUnref + close() (answers the descriptor to close, or -1
 * while other references remain; a waiting close() resolves), and the
 * 'close' listeners close() runs. */
typedef struct ScrFileHandleHook ScrFileHandleHook;
void scr_file_handle_ref(ScrFileHandle *h);
int scr_file_handle_stream_unref(ScrFileHandle *h);
ScrFileHandleHook *scr_file_handle_on_close(ScrFileHandle *h, void (*fn)(void *ctx), void *ctx);
void scr_file_handle_off_close(ScrFileHandle *h, ScrFileHandleHook *hook);
/* FileHandle.createReadStream / createWriteStream(options): +1 runtime
 * streams over the handle (scr_fs_stream_fh.c, linked with the stream
 * surface); NULL with the exception pending. Borrows both. */
typedef struct ScrStream ScrStream;
ScrStream *scr_file_handle_read_stream(ScrFileHandle *h, ScrDyn *options);
ScrStream *scr_file_handle_write_stream(ScrFileHandle *h, ScrDyn *options);
ScrPromise *scr_file_handle_sync_promise(ScrFileHandle *h);
ScrPromise *scr_file_handle_datasync_promise(ScrFileHandle *h);
ScrPromise *scr_file_handle_truncate_promise(ScrFileHandle *h, double length);
ScrPromise *scr_file_handle_chmod_promise(ScrFileHandle *h, double mode);
double scr_file_handle_readv(ScrFileHandle *h, ScrArr *buffers, double position);
double scr_file_handle_writev(ScrFileHandle *h, ScrArr *buffers, double position);
double scr_file_handle_read(ScrFileHandle *h, ScrBytes *buf, double offset,
                            double length, double position, bool length_default);
double scr_file_handle_write_bytes(ScrFileHandle *h, ScrBytes *buf,
                                   double offset, double length,
                                   double position, bool length_default);
double scr_file_handle_write_str(ScrFileHandle *h, ScrStr *data,
                                 double position, ScrStr *encoding);
ScrStr *scr_file_handle_read_file(ScrFileHandle *h);
ScrBytes *scr_file_handle_read_file_bytes(ScrFileHandle *h);
void scr_file_handle_write_file(ScrFileHandle *h, ScrStr *data);
void scr_file_handle_write_file_bytes(ScrFileHandle *h, ScrBytes *data);
ScrStats *scr_file_handle_stat(ScrFileHandle *h);
/* position == -1 reads from and advances the descriptor's current offset;
 * nonnegative positions leave that offset unchanged (pread/ReadFile seam). */
double scr_fs_read_sync(double fd, ScrBytes *buf, double offset, double length,
                        double position);
/* fs.readSync's offset check; false with ERR_OUT_OF_RANGE pending. */
bool scr_fs_read_offset_chk(double offset);
/* scr_fs_read_sync after its offset and position checks, with an exact
 * position (-1 for the current offset). */
double scr_fs_read_sync_at(double fd, ScrBytes *buf, double offset, double length,
                           int64_t position);
/* writeSync's classic Buffer window and utf8 string forms. position -1 (or
 * any other non-safe/nonnegative-integer value) writes at and advances the
 * current descriptor offset; safe nonnegative positions leave it unchanged. */
double scr_fs_write_sync(double fd, ScrBytes *buf, double offset, double length,
                         double position);
double scr_fs_write_str_sync(double fd, ScrStr *data, double position,
                             ScrStr *encoding);
double scr_fs_readv_sync(double fd, ScrArr *buffers, double position);
double scr_fs_writev_sync(double fd, ScrArr *buffers, double position);
/* Unlike scalar readSync's zero-length fast path, a nonempty vector of
 * empty views still tests the descriptor and positioned-read capability. */
double scr_fs_read_zero(double fd, double position);
void scr_fs_close(double fd);

#endif /* SCR_FILE_HANDLE_H */
