/* filehandle.readableWebStream([options]) — Node's type: "bytes" web stream
 * over a FileHandle's own reads (scr_fs_web_stream.c — linked only when the
 * program uses it). Semantics, matched against Node
 * (internal/fs/promises.js readableWebStream + webstreams/readablestream):
 * - The handle is locked while the stream lives, and a handle that is
 *   closed throws Node's ERR_INVALID_STATE at the call.
 * - Each pull reads up to 16 KiB at the handle's CURRENT position
 *   (FileHandle.read with no position), so successive pulls advance the
 *   file offset; the chunks are written into the pending read's view by the
 *   bytes-type adapter (scr_webstreams.c), which is what a BYOB reader
 *   hands the stream.
 * - EOF closes the stream once its queued bytes drain. cancel() ends the
 *   read side; options.autoClose closes the handle when the stream is
 *   cancelled or finishes.
 * - The read is issued synchronously and delivered on the next tick, so the
 *   stream's pull settles the way a loop-driven file read does. */
#include "scr_runtime.h"

#define SCR_FS_WS_CHUNK 16384

typedef struct ScrFsWebStream {
  size_t rc;
  ScrFileHandle *handle; /* +1 */
  bool auto_close;
  bool closed;
  /* Whether the stream took the handle's stream reference (an autoClose
   * stream does) and has not dropped it yet. */
  bool handle_ref;
  /* What the next read may produce, when the pending read's view is
   * smaller than a whole chunk (0: the whole chunk). */
  size_t read_limit;
  /* The handle's close hook: a close() ends an autoClose stream, so the
   * reference it holds goes and the close can finish. NULL once unhooked. */
  ScrFileHandleHook *close_hook;
} ScrFsWebStream;

/* The stream's end: an autoClose stream drops the handle's stream
 * reference, and the descriptor closes only when no other stream still
 * holds it. A read stream on the same handle that is still live keeps its
 * descriptor — closing it underneath would hand that stream a descriptor
 * number the process may already have reused. */
static void scr_fs_web_stream_drop_handle(ScrFsWebStream *st) {
  if (!st->handle_ref) return;
  st->handle_ref = false;
  if (st->close_hook) {
    ScrFileHandleHook *hook = st->close_hook;
    st->close_hook = NULL;
    scr_file_handle_off_close(st->handle, hook);
  }
  /* autoClose ends the handle the way Node's close() does: the stream drops
   * its own reference and asks for the close, the attached streams are closed
   * through their hooks (a paused read stream included), and the descriptor
   * closes when the last reference goes. */
  int fd = scr_file_handle_stream_unref(st->handle);
  if (fd >= 0) {
    scr_fs_close((double)fd);
    if (scr_exc_pending()) scr_exc_clear();
  }
}

/* FileHandle.close() ends an autoClose stream: the stream stops reading (its
 * next pull answers EOF) and gives up the handle's reference, so the close
 * that waits for it finishes and the descriptor closes. */
static void scr_fs_web_stream_handle_closed(void *ctx) {
  ScrFsWebStream *st = ctx;
  st->closed = true;
  st->close_hook = NULL;
  scr_fs_web_stream_drop_handle(st);
}

/* One read in flight: the chunk copied out of the handle (or the EOF / error
 * answer) delivered to the stream's sink on the next tick. */
typedef struct ScrFsWebRead {
  size_t rc;
  ScrFsWebStream *stream; /* +1 */
  const ScrFetchReadSink *sink;
  void *sink_ctx;   /* the +1 the source handed over */
  ScrBytes *chunk;  /* +1; NULL at EOF */
  ScrDyn *error;    /* +1 when the read failed */
} ScrFsWebRead;

static void scr_fs_web_stream_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* The pending exception as the dyn value a stream error answers with. */
static ScrDyn *scr_fs_web_take_pending(void) {
  ScrCaught *c = scr_exc_take();
  ScrDyn *d = scr_caught_to_dyn(c);
  scr_caught_release(c);
  return d;
}

static ScrFsWebStream *scr_fs_web_stream_retain(ScrFsWebStream *st) {
  if (st->rc != SIZE_MAX) st->rc++;
  return st;
}

static void scr_fs_web_stream_release(ScrFsWebStream *st) {
  if (!st || st->rc == SIZE_MAX) return;
  if (--st->rc == 0) {
    scr_fs_web_stream_drop_handle(st);
    if (st->close_hook) {
      ScrFileHandleHook *hook = st->close_hook;
      st->close_hook = NULL;
      scr_file_handle_off_close(st->handle, hook);
    }
    scr_file_handle_release(st->handle);
    free(st);
  }
}

static void *scr_fs_web_read_retain(void *p) {
  ScrFsWebRead *r = p;
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

static void scr_fs_web_read_release(void *p) {
  ScrFsWebRead *r = p;
  if (r == NULL || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    scr_fs_web_stream_release(r->stream);
    scr_bytes_release(r->chunk);
    scr_dyn_release(r->error);
    free(r);
  }
}

static void scr_fs_web_read_deliver(ScrClosure *cb) {
  ScrFsWebRead *r = scr_box_get_ref(cb->caps[0]); /* +1 */
  if (r != NULL) {
    if (r->error != NULL) {
      r->sink->error(r->sink_ctx, r->error);
    } else if (r->chunk == NULL) {
      /* EOF: an autoClose stream closes the handle it read from, as Node's
       * done handler does — through the handle's stream reference count, so
       * a descriptor another stream still holds stays open. */
      if (!r->stream->closed) {
        r->stream->closed = true;
        scr_fs_web_stream_drop_handle(r->stream);
      }
      r->sink->close(r->sink_ctx);
    }
    else {
      /* The sink borrows the chunk; the reference the delivery made is
       * dropped once it answers. */
      ScrDyn *chunk = scr_dyn_new_bytes(r->chunk);
      r->sink->chunk(r->sink_ctx, chunk);
      scr_dyn_release(chunk);
    }
    scr_fs_web_read_release(r);
  }
}

/* The stream's read side (ScrWebStreamSource.read_into): every request is
 * answered on the next tick. */
static bool scr_fs_web_stream_read_into(void *ctx, const ScrFetchReadSink *sink, void *sink_ctx) {
  ScrFsWebStream *st = ctx;
  ScrFsWebRead *r = calloc(1, sizeof *r);
  if (r == NULL) scr_fs_web_stream_oom();
  r->rc = 1;
  r->stream = scr_fs_web_stream_retain(st);
  r->sink = sink;
  r->sink_ctx = sink_ctx;
  if (!st->closed && scr_file_handle_fd(st->handle) >= 0) {
    /* Read only what the pending read's view holds, so its tail is not
     * read off the handle and lost. */
    size_t want = st->read_limit > 0 && st->read_limit < SCR_FS_WS_CHUNK
                      ? st->read_limit
                      : SCR_FS_WS_CHUNK;
    st->read_limit = 0;
    ScrBytes *buf = scr_bytes_new(SCR_BYTES_U8, want);
    if (buf == NULL) scr_fs_web_stream_oom();
    double got = scr_file_handle_read(st->handle, buf, 0, want, -1, false);
    if (scr_exc_pending()) {
      r->error = scr_fs_web_take_pending();
    } else if (!(got > 0)) {
      r->chunk = NULL; /* EOF */
    } else if (got < want) {
      r->chunk = scr_bytes_subarray(buf, 0, got);
    } else {
      r->chunk = scr_bytes_retain(buf);
    }
    scr_bytes_release(buf);
  }
  ScrClosure *cb = scr_closure_new((void *)&scr_fs_web_read_deliver, 1);
  cb->caps[0] = scr_box_new_obj(scr_fs_web_read_retain, scr_fs_web_read_release, NULL);
  scr_box_set_ref(cb->caps[0], r);
  scr_next_tick(cb);
  return true;
}

/* cancel(): the read side ends, and an autoClose stream closes the handle. */
static ScrPromise *scr_fs_web_stream_cancel(void *ctx, ScrDyn *reason) {
  (void)reason;
  ScrFsWebStream *st = ctx;
  st->closed = true;
  scr_fs_web_stream_drop_handle(st);
  return scr_promise_settled_void();
}

static void scr_fs_web_stream_source_release(void *ctx) { scr_fs_web_stream_release(ctx); }

/* The pending read's view size: the next read asks for no more than it. */
static void scr_fs_web_stream_set_read_limit(void *ctx, size_t bytes) {
  ((ScrFsWebStream *)ctx)->read_limit = bytes;
}

static const ScrWebStreamSource scr_fs_web_stream_source = {
    .read_into = scr_fs_web_stream_read_into,
    .cancel = scr_fs_web_stream_cancel,
    .release = scr_fs_web_stream_source_release,
    .set_read_limit = scr_fs_web_stream_set_read_limit,
};

/* FileHandle.readableWebStream([options]) — the options record's
 * `autoClose` (default false); a `type` other than "bytes" has no effect,
 * as Node's byte-oriented stream is always created. A closed handle throws
 * Node's ERR_INVALID_STATE at the call. */
ScrDyn *scr_file_handle_readable_web_stream(ScrFileHandle *h, ScrDyn *options) {
  if (scr_file_handle_fd(h) < 0) {
    static const char message[] = "Invalid state: The FileHandle is closed";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_INVALID_STATE");
    return NULL;
  }
  if (scr_file_handle_is_locked(h)) {
    /* One stream per handle, as Node's lock: a second stream would split
     * the file's contents between competing readers. */
    static const char message[] = "Invalid state: The FileHandle is locked";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_INVALID_STATE");
    return NULL;
  }
  bool auto_close = false;
  if (options != NULL && options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL &&
      options->kind != SCR_DYN_FUNC) {
    if (options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_ARR ||
        options->kind == SCR_DYN_TYPED_REF || options->kind == SCR_DYN_HANDLE ||
        options->kind == SCR_DYN_PROXY || options->kind == SCR_DYN_BYTES) {
      const ScrDyn *value = scr_dyn_obj_get(options, "autoClose", 9); /* borrowed */
      if (value != NULL && value->kind != SCR_DYN_UNDEF && value->kind != SCR_DYN_NULL) {
        if (value->kind != SCR_DYN_BOOL) {
          scr_dyn_arg_type_fail("options.autoClose", "of type boolean", value);
          return NULL;
        }
        auto_close = scr_dyn_truthy(value);
      }
    } else {
      scr_dyn_arg_type_fail("options", "of type object", options);
      return NULL;
    }
  }
  ScrFsWebStream *st = calloc(1, sizeof *st);
  if (st == NULL) scr_fs_web_stream_oom();
  st->rc = 1; /* the stream source owns it; its release frees it */
  st->handle = scr_file_handle_retain(h);
  st->auto_close = auto_close;
  /* An autoClose stream takes the handle's stream reference: its end drops
   * it and the descriptor closes when it was the last holder. A stream that
   * does not close the handle takes no reference, so a later close() never
   * waits for it. */
  if (auto_close) {
    scr_file_handle_ref(h);
    st->handle_ref = true;
    st->close_hook = scr_file_handle_on_close(h, &scr_fs_web_stream_handle_closed, st);
  }
  scr_file_handle_lock(h);
  ScrDyn *stream = scr_webstream_bytes_over(&scr_fs_web_stream_source, st);
  return stream;
}
