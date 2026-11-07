/* The Blob layout, shared by the always-linked blob unit (scr_blob.c) and
 * the link-gated FormData unit (scr_formdata.c — compiled only when the IR
 * uses the formdata surface): FormData's makeEntry reads a Blob's type and
 * a File's name and lastModified to build the File it stores. Everything
 * else about a Blob stays private to scr_blob.c. */
#ifndef SCR_BLOB_INTERNAL_H
#define SCR_BLOB_INTERNAL_H

#include "scr_blob.h"

struct ScrBlobStore;

typedef struct ScrBlob {
  size_t rc;
  struct ScrBlobStore *store;
  size_t off, len; /* this Blob's window into store */
  size_t nparts;
  size_t *parts; /* byte length of each part, in order; they sum to len */
  ScrStr *type;
  ScrStr *name; /* File only; NULL for a Blob */
  double last_modified;
} ScrBlob;

/* The ScrBlob `value` holds, or NULL for anything that is not a Blob or a
 * File (the same test scr_blob_is makes). */
static inline ScrBlob *scr_blob_internal_of(const ScrDyn *value) {
  if (value && value->kind == SCR_DYN_HANDLE &&
      (value->v.handle.tag == SCR_DYNH_BLOB || value->v.handle.tag == SCR_DYNH_FILE))
    return value->v.handle.ptr;
  return NULL;
}

/* The Blob's type (+1); NULL for a value that is not a Blob. */
static inline ScrStr *scr_blob_internal_type(const ScrDyn *value) {
  ScrBlob *b = scr_blob_internal_of(value);
  return b ? scr_str_retain(b->type) : NULL;
}

/* A File's name (+1); NULL for a Blob or any other value. */
static inline ScrStr *scr_blob_internal_file_name(const ScrDyn *value) {
  ScrBlob *b = scr_blob_internal_of(value);
  return b && b->name ? scr_str_retain(b->name) : NULL;
}

/* A File's lastModified (0 for a Blob, which has none). */
static inline double scr_blob_internal_last_modified(const ScrDyn *value) {
  ScrBlob *b = scr_blob_internal_of(value);
  return b ? b->last_modified : 0;
}

#endif /* SCR_BLOB_INTERNAL_H */
