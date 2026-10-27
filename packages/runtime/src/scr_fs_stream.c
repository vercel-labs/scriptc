/* fs.ReadStream and fs.WriteStream (lib/internal/fs/streams.js) as
 * runtime streams. fs.createReadStream/createWriteStream build them over
 * the scr_stream.c engine, with Node's _construct (the open), _read,
 * _write/_writev and _destroy (the close) as runtime hooks. Every
 * syscall runs on the shared worker pool, as Node's threadpool fs calls
 * do, and its continuation runs on the main thread. The unit references
 * only the stream unit and base units, so it links with the stream unit.
 *
 * Option checks follow Node's order: getOptions, options.fd or the path,
 * start, end, then the Readable/Writable options (highWaterMark,
 * encoding, emitClose, autoClose as autoDestroy). flags and mode are
 * checked when the open runs, so their errors arrive as 'error' events,
 * as in Node. */
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SCR_FSS_MAX_SAFE 9007199254740991.0

typedef struct ScrFsStream {
  bool readable;      /* ReadStream (else WriteStream) */
  int fd;             /* -1 = Node's `fd === null` */
  ScrDyn *path;       /* owned: the path value as given, or NULL (fd form) */
  ScrStr *cpath;      /* owned: the checked path the open uses */
  ScrDyn *flags;      /* owned: options.flags (checked at open) */
  ScrDyn *mode;       /* owned: options.mode (checked at open) */
  bool has_pos;
  double pos;         /* Node's this.pos */
  double end;         /* ReadStream: inclusive end, Infinity by default */
  double bytes;       /* bytesRead / bytesWritten */
  bool flush;         /* WriteStream: fsync before close */
  bool io;            /* kIsPerformingIO */
  bool destroy_wait;  /* _destroy waits for the in-flight read/write */
  ScrError *destroy_err; /* owned: the waiting _destroy's error */
  void *owner;        /* a FileHandle the stream reads or writes, or NULL */
  const ScrFsStreamOwnerOps *owner_ops;
} ScrFsStream;

static void scr_fss_free(void *p) {
  ScrFsStream *f = p;
  if (f->path) scr_dyn_release(f->path);
  if (f->cpath) scr_str_release(f->cpath);
  if (f->flags) scr_dyn_release(f->flags);
  if (f->mode) scr_dyn_release(f->mode);
  if (f->destroy_err) scr_error_release(f->destroy_err);
  if (f->owner) f->owner_ops->release(f->owner);
  /* a stream released before its close keeps Node's GC behavior: the fd
   * stays open (Node never closes an fd from a collected stream) */
  free(f);
}

/* The stream's fs state, or NULL for other streams (the release function
 * is the state's type tag). */
static ScrFsStream *scr_fss_of(ScrStream *s) { return scr_stream_native(s, &scr_fss_free); }

static const ScrStreamNativeOps scr_fss_ops; /* defined at the end */

static void scr_fss_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* ── worker-pool steps ────────────────────────────────────────────────── */

typedef enum { SCR_FSS_OPEN, SCR_FSS_READ, SCR_FSS_WRITE, SCR_FSS_FSYNC, SCR_FSS_CLOSE } ScrFssOpKind;

typedef struct ScrFssOp {
  ScrStream *s; /* +1 */
  ScrFssOpKind kind;
  int fd;
  char *path;   /* OPEN: owned copy */
  int oflags, mode;
  unsigned char *buf; /* READ: owned; WRITE: borrowed from chunk */
  ScrBytes *chunk;    /* WRITE: +1 */
  size_t off, len;
  double pos;         /* < 0: the current offset */
  int64_t result;     /* answer or -errno */
  int retries;        /* WRITE: zero-byte retries */
  ScrError *carry;    /* FSYNC/CLOSE: the error to pass on (+1) */
  /* The AsyncLocalStorage context the step was started in (+1): its
   * continuation runs in it, as Node runs an fs request's callback. */
  ScrAlsCtx *ctx;
} ScrFssOp;

static void scr_fss_work(void *p) {
  ScrFssOp *op = p;
  switch (op->kind) {
    case SCR_FSS_OPEN: op->result = scr_fs_raw_open(op->path, op->oflags, op->mode); break;
    case SCR_FSS_READ: op->result = scr_fs_raw_read(op->fd, op->buf, op->len, op->pos); break;
    case SCR_FSS_WRITE:
      op->result = scr_fs_raw_write(op->fd, op->chunk->data + op->off, op->len, op->pos);
      break;
    case SCR_FSS_FSYNC: op->result = scr_fs_raw_fsync(op->fd); break;
    case SCR_FSS_CLOSE: op->result = scr_fs_raw_close(op->fd); break;
  }
}

static void scr_fss_op_destroy(void *p) {
  ScrFssOp *op = p;
  scr_stream_release(op->s);
  free(op->path);
  free(op->buf);
  if (op->chunk) scr_bytes_release(op->chunk);
  if (op->carry) scr_error_release(op->carry);
  scr_als_ctx_release(op->ctx);
  free(op);
}

static ScrFssOp *scr_fss_op_new(ScrStream *s, ScrFssOpKind kind, int fd) {
  ScrFssOp *op = calloc(1, sizeof *op);
  if (!op) scr_fss_oom();
  op->s = scr_stream_retain(s);
  op->kind = kind;
  op->fd = fd;
  op->pos = -1;
  op->ctx = scr_als_capture();
  return op;
}

static void scr_fss_after(void *p);

static void scr_fss_after_in_context(void *p) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(((ScrFssOp *)p)->ctx);
  scr_fss_after(p);
  scr_als_dispatch_leave(prev);
}

static void scr_fss_submit(ScrFssOp *op) {
  scr_work_submit(op, &scr_fss_work, &scr_fss_after_in_context, &scr_fss_op_destroy);
}

/* ── close (Node's close/_close) ──────────────────────────────────────── */

/* _close: Node clears fd right after the close call. A FileHandle owner
 * answers the descriptor once its last reference goes (or -1). */
static void scr_fss_close_fd(ScrStream *s, ScrError *err /*moves*/) {
  ScrFsStream *f = scr_fss_of(s);
  int fd = f->fd;
  f->fd = -1;
  if (f->owner) fd = f->owner_ops->detach(f->owner);
  if (fd < 0) {
    scr_stream_destroy_done(s, err);
    return;
  }
  ScrFssOp *op = scr_fss_op_new(s, SCR_FSS_CLOSE, fd);
  op->carry = err;
  scr_fss_submit(op);
}

/* close(stream, err, cb): fsync first for WriteStream's flush option,
 * then close the fd; _destroy's callback gets the close error or err. */
static void scr_fss_close(ScrStream *s, ScrError *err /*moves*/) {
  ScrFsStream *f = scr_fss_of(s);
  if (f->fd < 0) {
    scr_stream_destroy_done(s, err);
    return;
  }
  if (!f->flush) {
    scr_fss_close_fd(s, err);
    return;
  }
  ScrFssOp *op = scr_fss_op_new(s, SCR_FSS_FSYNC, f->fd);
  op->carry = err;
  scr_fss_submit(op);
}

static void scr_fss_io_done(ScrStream *s, ScrError *er /*borrowed*/) {
  ScrFsStream *f = scr_fss_of(s);
  if (!f->destroy_wait) return;
  /* kIoDone: the deferred _destroy closes now */
  f->destroy_wait = false;
  ScrError *err = f->destroy_err;
  f->destroy_err = NULL;
  if (!err && er) err = scr_error_retain(er);
  scr_fss_close(s, err);
}

/* ── the continuations ────────────────────────────────────────────────── */

static ScrError *scr_fss_errno(int e, const char *op, const ScrStr *path) {
  return scr_fs_error(e, op, path);
}

static void scr_fss_after_open(ScrFssOp *op) {
  ScrStream *s = op->s;
  ScrFsStream *f = scr_fss_of(s);
  if (op->result < 0) {
    scr_stream_construct_done(s, scr_fss_errno((int)-op->result, "open", f->cpath));
    return;
  }
  f->fd = (int)op->result;
  scr_stream_construct_done(s, NULL);
  ScrStr *name = scr_str_new("open", 4);
  double fd = (double)f->fd; /* emitter arguments are slot pointers */
  scr_emitter_emit((ScrEmitter *)s, name, &fd);
  scr_str_release(name);
  if (scr_exc_pending()) return;
  name = scr_str_new("ready", 5);
  scr_emitter_emit((ScrEmitter *)s, name);
  scr_str_release(name);
}

static void scr_fss_after_read(ScrFssOp *op) {
  ScrStream *s = op->s;
  ScrFsStream *f = scr_fss_of(s);
  f->io = false;
  ScrError *er = op->result < 0 ? scr_fss_errno((int)-op->result, "read", NULL) : NULL;
  if (scr_stream_prop(s, "destroyed")) {
    scr_fss_io_done(s, er);
    if (er) scr_error_release(er);
    return;
  }
  if (er) {
    scr_stream_fail(s, er);
    scr_error_release(er);
    return;
  }
  size_t n = (size_t)op->result;
  if (n == 0) {
    scr_stream_push_null(s);
    return;
  }
  if (f->has_pos) f->pos += (double)n;
  f->bytes += (double)n;
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)n);
  memcpy(b->data, op->buf, n);
  b->is_buffer = true; /* Node's Buffer.allocUnsafeSlow chunk */
  scr_stream_push(s, b);
  scr_bytes_release(b);
}

static void scr_fss_write_finish(ScrStream *s, ScrError *er /*moves*/) {
  ScrFsStream *f = scr_fss_of(s);
  f->io = false;
  if (scr_stream_prop(s, "destroyed")) {
    ScrError *keep = er ? scr_error_retain(er) : NULL;
    scr_stream_write_done(s, er);
    if (!scr_exc_pending()) scr_fss_io_done(s, keep);
    if (keep) scr_error_release(keep);
    return;
  }
  scr_stream_write_done(s, er);
}

static ScrError *scr_fss_code_error(const char *code, const char *msg) {
  ScrStr *m = scr_str_new(msg, strlen(msg));
  ScrError *e = scr_error_new(SCR_ERR_ERROR, m);
  scr_str_release(m);
  scr_error_set_code(e, code);
  return e;
}

static void scr_fss_after_write(ScrFssOp *op) {
  ScrStream *s = op->s;
  ScrFsStream *f = scr_fss_of(s);
  int64_t r = op->result;
  ScrError *er = NULL;
  size_t written = 0;
  if (r < 0 && -r == EAGAIN) r = 0; /* retried later, as Node does */
  if (r < 0) er = scr_fss_errno((int)-r, "write", NULL);
  else written = (size_t)r;
  if (er || scr_stream_prop(s, "destroyed")) {
    if (!er) er = scr_fss_code_error("ERR_STREAM_DESTROYED", "Cannot call write after a stream was destroyed");
    scr_fss_write_finish(s, er);
    return;
  }
  f->bytes += (double)written;
  int retries = written ? 0 : op->retries + 1;
  size_t left = op->len - written;
  if (retries > 5) {
    scr_fss_write_finish(s, scr_fss_code_error("ERR_SYSTEM_ERROR", "A system error occurred: write failed"));
  } else if (left > 0) {
    ScrFssOp *next = scr_fss_op_new(s, SCR_FSS_WRITE, f->fd);
    next->chunk = scr_bytes_retain(op->chunk);
    next->off = op->off + written;
    next->len = left;
    next->pos = op->pos >= 0 ? op->pos + (double)written : -1;
    next->retries = retries;
    scr_fss_submit(next);
  } else {
    scr_fss_write_finish(s, NULL);
  }
}

static void scr_fss_after(void *p) {
  ScrFssOp *op = p;
  ScrStream *s = op->s;
  ScrFsStream *f = scr_fss_of(s);
  switch (op->kind) {
    case SCR_FSS_OPEN: scr_fss_after_open(op); break;
    case SCR_FSS_READ: scr_fss_after_read(op); break;
    case SCR_FSS_WRITE: scr_fss_after_write(op); break;
    case SCR_FSS_FSYNC: {
      ScrError *err = op->carry;
      op->carry = NULL;
      if (!err && op->result < 0) err = scr_fss_errno((int)-op->result, "fsync", NULL);
      f->flush = false;
      scr_fss_close_fd(s, err);
      break;
    }
    case SCR_FSS_CLOSE: {
      ScrError *err = op->result < 0 ? scr_fss_errno((int)-op->result, "close", NULL) : NULL;
      if (err) {
        if (op->carry) scr_error_release(op->carry);
      } else {
        err = op->carry;
      }
      op->carry = NULL;
      scr_stream_destroy_done(s, err);
      break;
    }
  }
}

/* ── the stream hooks ─────────────────────────────────────────────────── */

/* _construct: the fd form completes at once; otherwise open(path, flags,
 * mode). A flags or mode error completes the construction with it. */
static void scr_fss_construct(ScrClosure *cb, ScrStream *s) {
  (void)cb;
  ScrFsStream *f = scr_fss_of(s);
  if (f->fd >= 0) {
    scr_stream_construct_done(s, NULL);
    return;
  }
  int bits = scr_fs_stream_flags(f->flags, f->readable ? "r" : "w");
  double mode = 0;
  if (bits >= 0) scr_fs_stream_mode(f->mode, &mode);
  if (scr_exc_pending()) {
    ScrCaught *caught = scr_exc_take();
    ScrError *err = caught && caught->kind == SCR_EXC_OBJ && scr_error_is(caught->payload)
        ? scr_error_retain(caught->payload)
        : NULL;
    scr_caught_release(caught);
    scr_stream_construct_done(s, err);
    return;
  }
  ScrFssOp *op = scr_fss_op_new(s, SCR_FSS_OPEN, -1);
  op->path = malloc(f->cpath->len + 1);
  if (!op->path) scr_fss_oom();
  memcpy(op->path, f->cpath->data, f->cpath->len + 1);
  op->oflags = bits;
  op->mode = (int)mode;
  scr_fss_submit(op);
}

/* ReadStream._read(n) */
static void scr_fss_read(ScrClosure *cb, ScrStream *s, double size) {
  (void)cb;
  ScrFsStream *f = scr_fss_of(s);
  double n = f->has_pos ? fmin(f->end - f->pos + 1, size) : fmin(f->end - f->bytes + 1, size);
  if (n <= 0) {
    scr_stream_push_null(s);
    return;
  }
  ScrFssOp *op = scr_fss_op_new(s, SCR_FSS_READ, f->fd);
  op->len = (size_t)n;
  op->buf = malloc(op->len);
  if (!op->buf) scr_fss_oom();
  op->pos = f->has_pos ? f->pos : -1;
  f->io = true;
  scr_fss_submit(op);
}

/* WriteStream._write / _writev (the engine hands writev batches over as
 * one concatenated chunk). */
static void scr_fss_write(ScrClosure *cb, ScrStream *s, ScrBytes *chunk) {
  (void)cb;
  ScrFsStream *f = scr_fss_of(s);
  f->io = true;
  ScrFssOp *op = scr_fss_op_new(s, SCR_FSS_WRITE, f->fd);
  op->chunk = scr_bytes_retain(chunk);
  op->len = chunk->len;
  op->pos = f->has_pos ? f->pos : -1;
  scr_fss_submit(op);
  if (f->has_pos) f->pos += (double)chunk->len;
}

/* _destroy: wait for a read or write in flight (kIoDone), then close. */
static void scr_fss_destroy(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)cb;
  ScrFsStream *f = scr_fss_of(s);
  if (f->io) {
    f->destroy_wait = true;
    f->destroy_err = err ? scr_error_retain(err) : NULL;
    return;
  }
  scr_fss_close(s, err ? scr_error_retain(err) : NULL);
}

static ScrClosure *scr_fss_hook(void *fn) { return scr_closure_new(fn, 0); }

/* ── construction ─────────────────────────────────────────────────────── */

/* validateInteger(value, name, 0) */
static bool scr_fss_integer(const ScrDyn *v, const char *name) {
  if (v->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", v);
    return false;
  }
  double x = v->v.num;
  char recv[48], msg[200];
  int len = -1;
  scr_num_received(x, recv);
  if (!(isfinite(x) && trunc(x) == x)) {
    len = snprintf(msg, sizeof msg,
                   "The value of \"%s\" is out of range. It must be an integer. Received %s", name, recv);
  } else if (x < 0 || x > SCR_FSS_MAX_SAFE) {
    len = snprintf(msg, sizeof msg,
                   "The value of \"%s\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s",
                   name, recv);
  }
  if (len < 0) return true;
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

static void scr_fss_unsupported(const char *msg) {
  scr_throw_error_msg(SCR_ERR_ERROR, msg, strlen(msg));
}

/* The options record after getOptions: a +1 object (an empty one for
 * absent options and functions, { encoding } for a string). */
static ScrDyn *scr_fss_options(const ScrDyn *opts) {
  if (opts->kind == SCR_DYN_STR) {
    ScrDyn *o = scr_dyn_new_obj();
    scr_dyn_obj_set(o, "encoding", 8, scr_dyn_retain((ScrDyn *)opts));
    return o;
  }
  if (opts->kind == SCR_DYN_TYPED_REF) return scr_dyn_typed_ref_materialize(opts);
  if (opts->kind == SCR_DYN_OBJ) return scr_dyn_retain((ScrDyn *)opts);
  return scr_dyn_new_obj();
}

static ScrDyn *scr_fss_get(const ScrDyn *o, const char *key) {
  return scr_dyn_obj_read(o, key, strlen(key)); /* +1 */
}

/* The Readable/Writable option record the engine's dyn ladder reads:
 * the keys it consults, with Node's fs overrides (autoDestroy from
 * autoClose, the 64 KiB read default, decodeStrings forced on). */
static ScrDyn *scr_fss_engine_options(const ScrDyn *o, bool readable) {
  static const char *const keys[] = {
    "highWaterMark", "encoding", "emitClose", "objectMode", "readableObjectMode",
    "writableObjectMode", "signal", "defaultEncoding",
  };
  ScrDyn *e = scr_dyn_new_obj();
  for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++) {
    if (!readable && strcmp(keys[i], "encoding") == 0) continue;
    ScrDyn *v = scr_fss_get(o, keys[i]);
    if (v && v->kind != SCR_DYN_UNDEF) scr_dyn_obj_set(e, keys[i], strlen(keys[i]), v);
    else if (v) scr_dyn_release(v);
  }
  ScrDyn *auto_close = scr_fss_get(o, "autoClose");
  if (auto_close && auto_close->kind != SCR_DYN_UNDEF) {
    scr_dyn_obj_set(e, "autoDestroy", 11, auto_close);
  } else {
    if (auto_close) scr_dyn_release(auto_close);
    scr_dyn_obj_set(e, "autoDestroy", 11, scr_dyn_new_bool(true));
  }
  return e;
}

/* User _read/_write/_destroy/_construct overrides through the options
 * would replace the fs implementation; they are refused. */
static bool scr_fss_refuse_overrides(const ScrDyn *o) {
  static const char *const keys[] = { "read", "write", "writev", "final", "destroy", "construct" };
  for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++) {
    ScrDyn *v = scr_fss_get(o, keys[i]);
    bool fn = v && v->kind == SCR_DYN_FUNC;
    if (v) scr_dyn_release(v);
    if (fn) {
      char msg[160];
      snprintf(msg, sizeof msg,
               "the fs stream option '%s' is not supported yet (it replaces the file implementation)", keys[i]);
      scr_fss_unsupported(msg);
      return false;
    }
  }
  ScrDyn *fs = scr_fss_get(o, "fs");
  bool custom = fs && fs->kind != SCR_DYN_UNDEF && fs->kind != SCR_DYN_NULL;
  if (fs) scr_dyn_release(fs);
  if (custom) {
    scr_fss_unsupported("the fs stream option 'fs' is not supported yet (custom file system implementations)");
    return false;
  }
  ScrDyn *wh = scr_fss_get(o, "windowsHandle");
  bool handle = wh && wh->kind != SCR_DYN_UNDEF && wh->kind != SCR_DYN_NULL;
  if (wh) scr_dyn_release(wh);
  if (handle) {
    scr_fss_unsupported("the fs stream option 'windowsHandle' is not supported yet");
    return false;
  }
  return true;
}

static ScrStream *scr_fss_new(const ScrDyn *path, const ScrDyn *opts_in, bool readable,
                              int owner_fd, void *owner, const ScrFsStreamOwnerOps *owner_ops) {
  ScrDyn *o = scr_fs_stream_opts_valid(owner ? NULL : path, opts_in) ? scr_fss_options(opts_in) : NULL;
  if (!o) {
    /* The owner moves in, so a refused stream releases it too. */
    if (owner) owner_ops->release(owner);
    return NULL;
  }
  ScrStream *s = NULL;
  ScrFsStream *f = calloc(1, sizeof *f);
  if (!f) scr_fss_oom();
  f->readable = readable;
  f->fd = -1;
  f->end = INFINITY;
  ScrDyn *fd = NULL, *start = NULL, *end = NULL, *flush = NULL;
  if (!scr_fss_refuse_overrides(o)) goto fail;
  fd = owner ? NULL : scr_fss_get(o, "fd");
  if (owner) {
    f->fd = owner_fd; /* the FileHandle's descriptor (options.fd is the handle) */
  } else if (fd && fd->kind != SCR_DYN_UNDEF && fd->kind != SCR_DYN_NULL) {
    f->fd = (int)fd->v.num; /* -0 reads as 0; the range was checked */
  } else {
    f->cpath = scr_fs_stream_path(path);
    if (!f->cpath) goto fail;
    f->path = path->kind == SCR_DYN_STR || scr_dyn_bytes_is(path, SCR_BYTES_U8)
        ? scr_dyn_retain((ScrDyn *)path)
        : scr_dyn_new_str(scr_str_retain(f->cpath));
    f->flags = scr_fss_get(o, "flags");
    f->mode = scr_fss_get(o, "mode");
  }
  if (!readable) {
    flush = scr_fss_get(o, "flush");
    if (flush && flush->kind != SCR_DYN_UNDEF && flush->kind != SCR_DYN_NULL) {
      if (flush->kind != SCR_DYN_BOOL) {
        scr_dyn_prop_type_fail("options.flush", "of type boolean", flush);
        goto fail;
      }
      f->flush = flush->v.b;
    }
  }
  start = scr_fss_get(o, "start");
  if (start && start->kind != SCR_DYN_UNDEF) {
    if (!scr_fss_integer(start, "start")) goto fail;
    f->has_pos = true;
    f->pos = start->v.num;
  }
  if (readable) {
    end = scr_fss_get(o, "end");
    if (end && end->kind != SCR_DYN_UNDEF &&
        !(end->kind == SCR_DYN_NUM && isinf(end->v.num) && end->v.num > 0)) {
      if (!scr_fss_integer(end, "end")) goto fail;
      f->end = end->v.num;
      if (f->has_pos && f->pos > f->end) {
        char recv[48], msg[200];
        scr_num_received(f->pos, recv);
        char endbuf[48];
        scr_num_received(f->end, endbuf);
        int len = snprintf(msg, sizeof msg,
            "The value of \"start\" is out of range. It must be <= \"end\" (here: %s). Received %s",
            endbuf, recv);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
        goto fail;
      }
    }
  }
  {
    ScrDyn *eo = scr_fss_engine_options(o, readable);
    if (readable) {
      ScrDyn *hwm = scr_dyn_obj_get(eo, "highWaterMark", 13);
      if (hwm == NULL) scr_dyn_obj_set(eo, "highWaterMark", 13, scr_dyn_new_num(65536));
      s = scr_stream_new_readable_dyn(eo);
    } else {
      s = scr_stream_new_writable_dyn(eo);
    }
    scr_dyn_release(eo);
  }
  if (!s) goto fail;
  s->cls = readable ? "ReadStream" : "WriteStream";
  bool unknown_encoding = false;
  if (!readable) {
    /* setDefaultEncoding(options.encoding) after the Writable constructor:
     * 'buffer' is not an encoding there; utf8 is the default */
    ScrDyn *enc = scr_fss_get(o, "encoding");
    unknown_encoding = enc && enc->kind == SCR_DYN_STR && enc->v.str->len == 6 &&
        memcmp(enc->v.str->data, "buffer", 6) == 0;
    bool other = enc && enc->kind == SCR_DYN_STR && enc->v.str->len > 0 && !unknown_encoding &&
        !(enc->v.str->len == 4 && memcmp(enc->v.str->data, "utf8", 4) == 0) &&
        !(enc->v.str->len == 5 && memcmp(enc->v.str->data, "utf-8", 5) == 0);
    if (enc) scr_dyn_release(enc);
    if (other) {
      scr_fss_unsupported("the WriteStream option 'encoding' is not supported yet (utf8, the default, is the write-side string encoding)");
      scr_stream_release(s);
      s = NULL;
      goto fail;
    }
  }
  f->owner = owner;
  f->owner_ops = owner_ops;
  owner = NULL;
  scr_stream_set_native(s, f, &scr_fss_free);
  scr_stream_set_native_ops(s, &scr_fss_ops);
  f = NULL;
  if (readable) {
    scr_stream_set_read(s, scr_fss_hook((void *)&scr_fss_read), &scr_fss_read);
  } else {
    scr_stream_set_write(s, scr_fss_hook((void *)&scr_fss_write), &scr_fss_write);
    scr_stream_set_writev_concat(s);
  }
  scr_stream_set_destroy(s, scr_fss_hook((void *)&scr_fss_destroy), &scr_fss_destroy);
  scr_stream_construct(s, scr_fss_hook((void *)&scr_fss_construct), &scr_fss_construct);
  if (unknown_encoding) {
    /* Node's constructor has already scheduled _construct when
     * setDefaultEncoding throws, so the unreachable stream still opens
     * (and with the default 'w' flags truncates) its file. */
    static const char m[] = "Unknown encoding: buffer";
    scr_throw_error_msg_code(SCR_ERR_TYPE, m, sizeof m - 1, "ERR_UNKNOWN_ENCODING");
    scr_stream_release(s);
    s = NULL;
  }
fail:
  if (f) scr_fss_free(f);
  if (owner) owner_ops->release(owner);
  if (fd) scr_dyn_release(fd);
  if (start) scr_dyn_release(start);
  if (end) scr_dyn_release(end);
  if (flush) scr_dyn_release(flush);
  scr_dyn_release(o);
  return s;
}

ScrStream *scr_fs_read_stream_new(ScrDyn *path, ScrDyn *options) {
  return scr_fss_new(path, options, true, -1, NULL, NULL);
}

ScrStream *scr_fs_write_stream_new(ScrDyn *path, ScrDyn *options) {
  return scr_fss_new(path, options, false, -1, NULL, NULL);
}

ScrStream *scr_fs_stream_new_owned(ScrDyn *options, bool readable, int fd, void *owner,
                                   const ScrFsStreamOwnerOps *ops) {
  return scr_fss_new(NULL, options, readable, fd, owner, ops);
}

/* ── members ──────────────────────────────────────────────────────────── */

double scr_fs_stream_bytes(ScrStream *s) {
  ScrFsStream *f = scr_fss_of(s);
  return f ? f->bytes : 0;
}

bool scr_fs_stream_pending(ScrStream *s) {
  ScrFsStream *f = scr_fss_of(s);
  return f ? f->fd < 0 : false;
}

ScrDyn *scr_fs_stream_path_value(ScrStream *s) {
  ScrFsStream *f = scr_fss_of(s);
  return f && f->path ? scr_dyn_retain(f->path) : scr_dyn_retain(scr_dyn_undefined());
}

/* bytesRead / bytesWritten / pending / path read through an untyped
 * value: undefined off the fs streams and for the other class's counter,
 * as on Node's plain streams. +1. */
ScrDyn *scr_fs_stream_prop_dyn(ScrStream *s, ScrStr *name) {
  ScrFsStream *f = scr_fss_of(s);
  if (f == NULL) return scr_dyn_retain(scr_dyn_undefined());
  if (strcmp(name->data, f->readable ? "bytesRead" : "bytesWritten") == 0) return scr_dyn_new_num(f->bytes);
  if (strcmp(name->data, "pending") == 0) return scr_dyn_new_bool(f->fd < 0);
  if (strcmp(name->data, "path") == 0) return scr_fs_stream_path_value(s);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* The members on the stream's untyped view (scr_stream_dyn_view). */
static void scr_fss_view(ScrStream *s, ScrDyn *view) {
  ScrFsStream *f = scr_fss_of(s);
  if (f == NULL) return;
  const char *counter = f->readable ? "bytesRead" : "bytesWritten";
  scr_dyn_obj_set(view, counter, strlen(counter), scr_dyn_new_num(f->bytes));
  scr_dyn_obj_set(view, "pending", 7, scr_dyn_new_bool(f->fd < 0));
  scr_dyn_obj_set(view, "path", 4, scr_fs_stream_path_value(s));
}

/* ReadStream.close(cb): finished(this, cb) then destroy(). WriteStream
 * .close(cb): a 'close' listener (on a tick once closed), destroy at
 * 'finish' without autoClose, then end(). cb moves (NULL = absent); the
 * exported forms borrow it. */
static void scr_fss_close_cb(ScrClosure *cb, ScrStream *s, ScrError *err) {
  (void)s; (void)err;
  ScrClosure *user = scr_box_get_ref(cb->caps[0]);
  ((void (*)(ScrClosure *))user->fn)(user);
  scr_closure_release(user);
}

static ScrClosure *scr_fss_wrap(ScrClosure *user /*moves*/) {
  ScrClosure *w = scr_closure_new((void *)&scr_fss_close_cb, 1);
  w->caps[0] = scr_box_new_obj(&scr_closure_retain_v, &scr_closure_release_v, &scr_closure_trace_v);
  scr_box_set_ref(w->caps[0], user);
  return w;
}

static void scr_fss_close_member(ScrStream *s, ScrClosure *cb) {
  ScrFsStream *f = scr_fss_of(s);
  if (f == NULL || f->readable) {
    if (cb) {
      ScrClosure *cleanup = scr_stream_finished(s, scr_fss_wrap(cb), &scr_fss_close_cb);
      if (cleanup) scr_closure_release(cleanup);
    }
    scr_stream_release(scr_stream_destroy(s, NULL));
    return;
  }
  scr_stream_close_writable(s, cb);
}

void scr_fs_stream_close(ScrStream *s) { scr_fss_close_member(s, NULL); }

void scr_fs_stream_close_cb(ScrStream *s, ScrClosure *cb) {
  scr_fss_close_member(s, scr_closure_retain(cb));
}

/* aggregateTwoErrors(inner, outer): both present and distinct make an
 * AggregateError([outer, inner]) with outer's message and code; otherwise
 * whichever exists. Borrows both; +1 or NULL. */
static ScrError *scr_fss_aggregate(ScrError *inner, ScrError *outer) {
  if (inner && outer && inner != outer) {
    ScrDyn *message = scr_dyn_new_str(scr_str_retain(outer->message));
    ScrError *agg = scr_aggregate_new(message, scr_dyn_undefined());
    scr_dyn_release(message);
    if (agg == NULL) return scr_error_retain(outer);
    ScrDyn *outer_value = scr_dyn_from_error(outer);
    ScrDyn *list = scr_dyn_new_arr();
    scr_dyn_arr_push(list, scr_dyn_retain(outer_value));
    scr_dyn_arr_push(list, scr_dyn_from_error(inner));
    scr_aggregate_set_errors(agg, list);
    scr_dyn_release(list);
    /* err.code = outerError.code (a property the program may have set) */
    ScrDyn *code = scr_dyn_obj_read(outer_value, "code", 4);
    if (code && code->kind == SCR_DYN_STR) scr_error_set_code(agg, code->v.str->data);
    scr_dyn_release(code);
    scr_dyn_release(outer_value);
    return agg;
  }
  ScrError *one = outer ? outer : inner;
  return one ? scr_error_retain(one) : NULL;
}

static const ScrStreamNativeOps scr_fss_ops = {
  &scr_fss_view, &scr_fs_stream_close, &scr_fss_aggregate,
};
