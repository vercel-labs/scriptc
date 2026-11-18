/* fs.openAsBlob(path[, options]) — Node's Blob over a file's bytes
 * (scr_fs_blob.c — linked only when the program uses it). Node opens and
 * fstats the file when the call is made, so its errors throw
 * synchronously, and answers a promise of a Blob whose size is that stat's
 * size. The bytes are not read then: every read of the Blob opens the path
 * again, checks that the file still has the size and modification time the
 * call saw, and reads its range. A file that changed, disappeared or
 * cannot be read rejects the read with Node's NotReadableError
 * ("The blob could not be read"), which is what Node's blob reader does
 * when the fstat it takes at each read differs from the one at creation. */
#include "scr_runtime.h"

#include <stdio.h>

typedef struct ScrFsBlob {
  /* First: the Blob unit shares this struct as the Blob's source (rc, the
   * hooks and this pointer are what it reads), and frees the allocation. */
  ScrBlobSource source;
  ScrStr *path;
  size_t size;
  uint64_t mtime_ns;
} ScrFsBlob;

/* openAsBlob's options.type: Node's `options.type || ''` then
 * validateString, so a falsy member is the empty type and a truthy
 * non-string is the converter's TypeError. */
static ScrStr *scr_fs_blob_type(const ScrDyn *options) {
  const ScrDyn *value = scr_dyn_obj_get(options, "type", 4); /* borrowed */
  if (value == NULL || value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL ||
      !scr_dyn_truthy(value)) {
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
    return NULL;
  }
  return scr_str_retain(value->v.str);
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

/* ScrBlobSource.read: the file's [off, off + len) bytes, opened fresh and
 * checked against the stat the Blob was created with. */
static bool scr_fs_blob_read(void *ctx, size_t off, size_t len, uint8_t *dst) {
  ScrFsBlob *b = ctx;
  ScrStr *flags = scr_str_new("r", 1);
  ScrFileHandle *h = scr_file_handle_open(b->path, flags, 0);
  scr_str_release(flags);
  if (h == NULL) {
    scr_exc_clear(); /* the read reports NotReadableError instead */
    return false;
  }
  bool ok = true;
  int error = 0;
  ScrStats *st = scr_stats_of_fd((int)scr_file_handle_fd(h), &error);
  if (st == NULL) {
    ok = false;
  } else {
    if ((size_t)scr_stats_size(st) != b->size || scr_fs_blob_mtime_ns(st) != b->mtime_ns) ok = false;
    scr_stats_release(st);
  }
  if (ok && len) {
    ScrBytes *buf = scr_bytes_new(SCR_BYTES_U8, (double)len);
    double got = scr_file_handle_read(h, buf, 0, (double)len, (double)off, false);
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
  scr_file_handle_close(h);
  scr_file_handle_release(h);
  return ok;
}

/* The Blob frees the source record itself (this struct's first member is
 * it), so the hook only drops what the context owns. */
static void scr_fs_blob_source_release(void *ctx) {
  ScrFsBlob *b = ctx;
  scr_str_release(b->path);
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
  ScrStr *flags = scr_str_new("r", 1);
  ScrFileHandle *h = scr_file_handle_open(resolved, flags, 0);
  scr_str_release(flags);
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
  scr_stats_release(st);
  scr_file_handle_close(h);
  scr_file_handle_release(h);
  ScrDyn *blob = scr_blob_from_source(&file->source, (double)file->size, type);
  scr_str_release(type);
  if (blob == NULL) return NULL;
  ScrPromise *p = scr_promise_new();
  /* fulfill_ref takes the value's reference (scr_fetch_response_text does
   * not release after it either). */
  scr_promise_fulfill_ref(p, blob, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  return (ScrDyn *)p;
}
