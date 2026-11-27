/* fs.openAsBlob(path[, options]) — Node's Blob over a file's bytes
 * (scr_fs_blob.c — linked only when the program uses it). Node opens and
 * fstats the file when the call is made, so its errors throw
 * synchronously, and answers a promise of a Blob whose size is that stat's
 * size. The bytes are not read then: every read of the Blob checks that the
 * file still has the size and modification time the call saw, and reads its
 * range. A file that changed, disappeared or cannot be read rejects the
 * read with Node's NotReadableError ("The blob could not be read"), which
 * is what Node's blob reader does when the fstat it takes at each read
 * differs from the one at creation.
 *
 * The descriptor is the one the creation open took, held for the Blob's
 * life. Node closes it after the creation stat and re-opens the path with a
 * blocking open at the first read; for a FIFO with no writer that open parks
 * the event loop forever (a FIFO's stat size is 0, and Node 24.22.1 hangs
 * when its bytes are requested). Reading through the held descriptor — taken
 * with a non-blocking open — completes instead: the 0-byte Blob reports no
 * bytes and the loop keeps running. */
#include "scr_runtime.h"

#include <stdio.h>

#ifndef _WIN32
#include <fcntl.h>
#endif

typedef struct ScrFsBlob {
  /* First: the Blob unit shares this struct as the Blob's source (rc, the
   * hooks and this pointer are what it reads), and frees the allocation. */
  ScrBlobSource source;
  ScrStr *path;
  size_t size;
  uint64_t mtime_ns;
  uint64_t ctime_ns;
  /* The file the Blob reads is the one the creation open took: the
   * descriptor is held, and every read checks that the path still names
   * that file (its device and inode), so a path swapped under a Blob
   * cannot change the bytes it answers. */
  ScrFileHandle *handle; /* +1, the descriptor the creation open took */
  double dev, ino;
} ScrFsBlob;

/* `options.type` as a JavaScript property read — an accessor runs, an
 * inherited member counts, and a compiled record or proxy answers through
 * its own path (+1, or NULL with the getter's exception pending). */
static ScrDyn *scr_fs_blob_type_value(const ScrDyn *options) {
  static const char key[] = "type";
  ScrStr *name = scr_str_new(key, 4);
  ScrDyn *value;
  if (options->kind == SCR_DYN_TYPED_REF) {
    value = scr_dyn_typed_ref_key_get(options, name);
    if (value == NULL && !scr_exc_pending()) {
      /* A record capsule answers through the view it materializes; one
       * without the member is the default options (the caller then uses the
       * empty type). */
      ScrDyn *view = scr_dyn_typed_ref_materialize(options);
      if (view != NULL) {
        value = scr_dyn_obj_read(view, key, 4);
        scr_dyn_release(view);
      }
    }
  } else if (options->kind == SCR_DYN_PROXY) {
    value = scr_dyn_proxy_get(options, name);
  } else if (options->kind == SCR_DYN_OBJ) {
    value = scr_dyn_obj_read(options, key, 4);
  } else {
    value = scr_dyn_retain(scr_dyn_undefined());
  }
  scr_str_release(name);
  return value;
}

/* openAsBlob's options.type: Node's `options.type || ''` then
 * validateString, so a falsy member is the empty type and a truthy
 * non-string is the converter's TypeError. */
static ScrStr *scr_fs_blob_type(const ScrDyn *options) {
  ScrDyn *value = scr_fs_blob_type_value(options); /* +1, or NULL */
  if (value == NULL) {
    /* A getter's exception propagates; a capsule with no such member is the
     * default options. */
    if (scr_exc_pending()) return NULL;
    return scr_str_new("", 0);
  }
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL || !scr_dyn_truthy(value)) {
    scr_dyn_release(value);
    return scr_str_new("", 0);
  }
  if (value->kind != SCR_DYN_STR) {
    /* validateString: ERR_INVALID_ARG_TYPE naming the property. */
    char message[160];
    int n;
    if (value->kind == SCR_DYN_NUM) {
      n = snprintf(message, sizeof message,
                   "The \"options.type\" property must be of type string. Received type number (%g)",
                   value->v.num);
    } else {
      n = snprintf(message, sizeof message,
                   "The \"options.type\" property must be of type string.");
    }
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, "ERR_INVALID_ARG_TYPE");
    scr_dyn_release(value);
    return NULL;
  }
  /* The type reaches Content-Type on a fetch body: Node's openAsBlob keeps
   * the caller's string verbatim, including non-ASCII characters and tabs
   * (case is preserved: MIME parameters can be case-sensitive). */
  ScrStr *out = scr_blob_type_as_given(value->v.str);
  scr_dyn_release(value);
  return out;
}

static bool scr_fs_blob_options_object(const ScrDyn *options) {
  switch (options->kind) {
    case SCR_DYN_OBJ:
    case SCR_DYN_ARR:
    case SCR_DYN_TYPED_REF:
    case SCR_DYN_HANDLE:
    case SCR_DYN_PROXY:
    case SCR_DYN_FUNC:
      return true;
    default:
      return false;
  }
}

/* The stat's modification time in nanoseconds (the fraction Node's blob
 * reader compares along with the size). */
static uint64_t scr_fs_blob_mtime_ns(ScrStats *st) {
  ScrBigInt *ns = scr_stats_big_mtime_ns(st);
  uint64_t value = scr_bigint_to_u64(ns);
  scr_bigint_release(ns);
  return value;
}

/* The change time in nanoseconds. A file's owner can restore the
 * modification time it changed, but writing the contents and restoring the
 * mtime both move ctime forward and userspace cannot set it back, so the
 * pair detects a same-length rewrite of a file whose mtime was restored. */
static uint64_t scr_fs_blob_ctime_ns(ScrStats *st) {
  ScrBigInt *ns = scr_stats_big_ctime_ns(st);
  uint64_t value = scr_bigint_to_u64(ns);
  scr_bigint_release(ns);
  return value;
}

/* Keep the Blob's descriptor out of spawned children: a POSIX launch
 * inherits every descriptor without close-on-exec, and the Blob's bytes may
 * lie outside a slice or in a file no longer reachable by pathname. */
static void scr_fs_blob_close_on_exec(ScrFileHandle *h) {
#ifndef _WIN32
  int fd = (int)scr_file_handle_fd(h);
  if (fd < 0) return;
  int flags = fcntl(fd, F_GETFD);
  if (flags >= 0) (void)fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
#else
  (void)h;
#endif
}

/* ScrBlobSource.read: the file's [off, off + len) bytes, read from the
 * descriptor the creation open took (never from a path opened afterwards).
 * Every read takes the held file's stat (it must still have the size and
 * modification time the Blob was created with) and checks that the path
 * still names the same file (its device and inode). */
static bool scr_fs_blob_read(void *ctx, size_t off, size_t len, uint8_t *dst) {
  ScrFsBlob *b = ctx;
  int error = 0;
  if (b->handle == NULL) return false;
  bool ok = true;
  ScrStats *st = scr_stats_of_fd((int)scr_file_handle_fd(b->handle), &error);
  if (st == NULL) {
    ok = false;
  } else {
    if ((size_t)scr_stats_size(st) != b->size || scr_fs_blob_mtime_ns(st) != b->mtime_ns ||
        scr_fs_blob_ctime_ns(st) != b->ctime_ns)
      ok = false;
    scr_stats_release(st);
  }
  if (ok) {
    /* The path must still name the file the descriptor holds: a symlink
     * swapped to another file, or one removed, is not this Blob's file. */
    int path_error = 0;
    ScrStats *path_st = scr_stats_poll_path(b->path, &path_error);
    if (path_st == NULL || scr_stats_dev(path_st) != b->dev || scr_stats_ino(path_st) != b->ino) {
      ok = false;
    }
    if (path_st != NULL) scr_stats_release(path_st);
  }
  if (ok && len) {
    ScrBytes *buf = scr_bytes_new(SCR_BYTES_U8, (double)len);
    double got = scr_file_handle_read(b->handle, buf, 0, (double)len, (double)off, false);
    if (scr_exc_pending()) {
      scr_exc_clear();
      ok = false;
    } else if (got != (double)len) {
      ok = false; /* a short read: the file no longer holds this range */
    } else {
      memcpy(dst, buf->data, len);
    }
    scr_bytes_release(buf);
  }
  return ok;
}

/* The Blob frees the source record itself (this struct's first member is
 * it), so the hook only drops what the context owns. */
static void scr_fs_blob_source_release(void *ctx) {
  ScrFsBlob *b = ctx;
  /* An exception may already be propagating (a validator that threw after
   * reading the Blob, say): keep it across the close and put it back, so the
   * destructor does not swallow it. */
  ScrCaught *pending = scr_exc_pending() ? scr_exc_take() : NULL;
  if (b->handle != NULL) {
    scr_file_handle_close(b->handle);
    if (scr_exc_pending()) scr_exc_clear();
    scr_file_handle_release(b->handle);
  }
  scr_str_release(b->path);
  if (pending != NULL) {
    scr_rethrow(pending);
    scr_caught_release(pending);
  }
}

/* fs.openAsBlob(path[, options]) → a promise of the Blob (+1). The open
 * and stat happen here, synchronously, as Node's do (its errors throw at
 * the call), and the bytes are read per read (scr_fs_blob_read). */
ScrDyn *scr_fs_open_as_blob(ScrDyn *path, ScrDyn *options) {
  if (options != NULL && options->kind != SCR_DYN_UNDEF) {
    if (!scr_fs_blob_options_object(options)) {
      scr_dyn_arg_type_fail("options", "of type object", options);
      return NULL;
    }
  }
  ScrStr *type = NULL;
  if (options != NULL && options->kind != SCR_DYN_UNDEF) {
    type = scr_fs_blob_type(options);
  } else {
    type = scr_str_new("", 0);
  }
  if (type == NULL) return NULL;
  ScrStr *resolved = scr_fs_validated_path(path, "path");
  if (resolved == NULL) {
    scr_str_release(type);
    return NULL;
  }
  /* The creation stat opens the path without blocking and KEEPS the
   * descriptor: the Blob's reads use it instead of re-opening the path, so
   * a FIFO cannot park the loop on its first read. */
  ScrFileHandle *h = scr_file_handle_open_read_only_nonblocking(resolved);
  if (h != NULL) scr_fs_blob_close_on_exec(h);
  if (h == NULL) {
    scr_str_release(type);
    scr_str_release(resolved);
    return NULL;
  }
  int error = 0;
  ScrStats *st = scr_stats_of_fd((int)scr_file_handle_fd(h), &error);
  if (st == NULL) {
    scr_file_handle_close(h);
    scr_file_handle_release(h);
    scr_str_release(type);
    scr_fs_throw_errno_exception(error, "fstat", resolved);
    scr_str_release(resolved);
    return NULL;
  }
  ScrFsBlob *file = calloc(1, sizeof *file);
  if (file == NULL) scr_trap("scriptc: out of memory\n");
  file->source.rc = 1;
  file->source.ctx = file;
  file->source.read = scr_fs_blob_read;
  file->source.release = scr_fs_blob_source_release;
  file->path = resolved; /* moves the reference */
  file->size = (size_t)scr_stats_size(st);
  file->mtime_ns = scr_fs_blob_mtime_ns(st);
  file->ctime_ns = scr_fs_blob_ctime_ns(st);
  file->dev = scr_stats_dev(st);
  file->ino = scr_stats_ino(st);
  file->handle = h; /* the creation descriptor, held for the Blob's life */
  scr_stats_release(st);
  ScrDyn *blob = scr_blob_from_source(&file->source, (double)file->size, type);
  scr_str_release(type);
  if (blob == NULL) return NULL;
  ScrPromise *p = scr_promise_new();
  /* fulfill_ref takes the value's reference (scr_fetch_response_text does
   * not release after it either). */
  scr_promise_fulfill_ref(p, blob, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  return (ScrDyn *)p;
}
