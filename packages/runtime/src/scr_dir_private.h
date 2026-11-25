/* scriptc runtime — the fs.Dir handle's layout and the helpers the
 * asynchronous forms share, for the three units that carry them: the
 * synchronous operations and the entry batch (scr_lib.c), the operation
 * queue with the promise and callback forms (scr_async.c), and the
 * Dirent a callback read receives (scr_symbol.c). Runtime-internal; not
 * part of scr_runtime.h, like the other *_private headers. */
#ifndef SCR_DIR_PRIVATE_H
#define SCR_DIR_PRIVATE_H

#include "scr_runtime.h"

/* The platform directory stream: DIR* on POSIX, the Win32 find handle
 * with its pending entry on Windows. scr_lib.c owns it; the other units
 * only close it, through scr_dir_close_stream. */
typedef struct ScrDirStream ScrDirStream;

/* One queued read or close: it owns the result it was given when the call
 * ran and waits its turn in the handle's FIFO. */
typedef struct ScrDirOp {
  struct ScrDirOp *next;
  size_t rc;
  ScrDir *dir;
  bool is_close;
  bool buffered;       /* served from the batch; answers on a next tick */
  ScrDyn *callback;    /* +1, callback forms */
  ScrDyn *argument;    /* +1 entry for a read, NULL at the end */
  ScrDyn *error;       /* +1, callback forms */
  ScrPromise *promise; /* +1, promise forms */
  void *value;         /* +1 promise payload (the read entry union) */
  void *(*retain)(void *);
  void (*release)(void *);
  ScrTraceFn trace;
} ScrDirOp;

struct ScrDir {
  size_t rc;
  ScrStr *path;
  bool closed;
  double buffer_size; /* entries per readdir batch */
  ScrStr **batch;
  double *kinds;
  size_t batch_len;
  size_t batch_pos;
  bool inflight; /* an asynchronous operation waits to be cleared */
  ScrDirOp *ops_head;
  ScrDirOp *ops_tail;
  ScrDirStream *stream;
};

/* scr_lib.c: the batch every read serves, and Node's two Dir errors. */
void scr_dir_batch_clear(ScrDir *d);
bool scr_dir_take(ScrDir *d, ScrStr **name, double *kind);
bool scr_dir_fill_batch(ScrDir *d);
void scr_dir_close_stream(ScrDir *d); /* closes and frees the stream */
void scr_dir_closed(void);            /* throws ERR_DIR_CLOSED */

/* scr_async.c: the operation queue the asynchronous forms share. */
ScrDirOp *scr_dir_op_new(ScrDir *d, bool is_close);
void *scr_dir_op_retain_v(void *p);
void scr_dir_op_release_v(void *p);
void scr_dir_push(ScrDirOp *op);          /* queues, or runs when the Dir is idle */
ScrDyn *scr_dir_error_dyn(void);          /* the pending exception as a dyn (+1) */

/* scr_symbol.c: the Dirent object a read callback receives. `name` is +1
 * and is consumed. */
ScrDyn *scr_dir_dirent_dyn(ScrDir *d, ScrStr *name, double kind);

#endif /* SCR_DIR_PRIVATE_H */
