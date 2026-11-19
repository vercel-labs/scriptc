/* Blob and File (node:buffer, also globals): Node 24's lib/internal/blob.js
 * and lib/internal/file.js over immutable native storage.
 *
 * A Blob is a window over a shared, immutable byte store plus the byte
 * length of every part it holds. Node keeps one data-queue entry per
 * source part (a Blob part contributes its own entries) and reads one
 * entry per pull, so the part list decides how many microtask turns
 * arrayBuffer(), text() and bytes() take to settle; slice() keeps the
 * entries Node's queue slice keeps. Sources are copied when the Blob is
 * built, so later writes to a source buffer are not observed. */
#include "scr_runtime.h"

#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct ScrBlobStore {
  /* Atomic: a message carries a Blob to another thread, which shares these
   * bytes and counts its reference from there. */
  _Atomic size_t rc;
  size_t len;
  uint8_t data[];
} ScrBlobStore;

typedef struct ScrBlob {
  size_t rc;
  ScrBlobStore *store;
  /* Set instead of store when the bytes are produced on demand
   * (fs.openAsBlob's file); off is then the byte offset in the source. */
  ScrBlobSource *source;
  size_t off, len; /* this Blob's window into store */
  size_t nparts;
  size_t *parts; /* byte length of each part, in order; they sum to len */
  ScrStr *type;
  ScrStr *name; /* File only; NULL for a Blob */
  double last_modified;
} ScrBlob;

static void scr_blob_store_release(ScrBlobStore *s) {
  if (s && atomic_fetch_sub_explicit(&s->rc, 1, memory_order_acq_rel) == 1) free(s);
}

static ScrBlobStore *scr_blob_store_retain(ScrBlobStore *s) {
  atomic_fetch_add_explicit(&s->rc, 1, memory_order_relaxed);
  return s;
}

static void *scr_blob_retain_v(void *h) {
  ((ScrBlob *)h)->rc++;
  return h;
}

static void scr_blob_release_v(void *h) {
  ScrBlob *b = h;
  if (--b->rc) return;
  scr_weak_dispose_inline(b);
  scr_blob_store_release(b->store);
  if (b->source && --b->source->rc == 0) {
    if (b->source->release) b->source->release(b->source->ctx);
    free(b->source);
  }
  free(b->parts);
  scr_str_release(b->type);
  if (b->name) scr_str_release(b->name);
  free(b);
}

static ScrBlob *scr_blob_alloc(void) {
  ScrBlob *b = calloc(1, sizeof *b);
  if (!b) scr_trap("scriptc: out of memory\n");
  b->rc = 1;
  return b;
}

/* ── building the part list ──────────────────────────────────────────── */

typedef struct {
  uint8_t *data;
  size_t len, cap;
  size_t *parts;
  size_t nparts, pcap;
} ScrBlobBuild;

static void scr_blob_build_bytes(ScrBlobBuild *bb, const uint8_t *data, size_t len) {
  if (bb->len + len > bb->cap) {
    size_t cap = bb->cap ? bb->cap : 64;
    while (cap < bb->len + len) cap *= 2;
    uint8_t *grown = realloc(bb->data, cap);
    if (!grown) scr_trap("scriptc: out of memory\n");
    bb->data = grown;
    bb->cap = cap;
  }
  if (len) memcpy(bb->data + bb->len, data, len);
  bb->len += len;
}

static void scr_blob_build_part(ScrBlobBuild *bb, size_t len) {
  if (bb->nparts == bb->pcap) {
    size_t cap = bb->pcap ? bb->pcap * 2 : 8;
    size_t *grown = realloc(bb->parts, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    bb->parts = grown;
    bb->pcap = cap;
  }
  bb->parts[bb->nparts++] = len;
}

static void scr_blob_build_free(ScrBlobBuild *bb) {
  free(bb->data);
  free(bb->parts);
}

/* A Blob from the finished build (the build's buffers move in). */
static ScrBlob *scr_blob_from_build(ScrBlobBuild *bb, ScrStr *type) {
  ScrBlobStore *store = malloc(sizeof *store + bb->len);
  if (!store) scr_trap("scriptc: out of memory\n");
  store->rc = 1;
  store->len = bb->len;
  if (bb->len) memcpy(store->data, bb->data, bb->len);
  free(bb->data);
  ScrBlob *b = scr_blob_alloc();
  b->store = store;
  b->len = bb->len;
  b->nparts = bb->nparts;
  b->parts = bb->parts;
  b->type = type;
  return b;
}

static ScrBlob *scr_blob_of(const ScrDyn *d) {
  if (d && d->kind == SCR_DYN_HANDLE &&
      (d->v.handle.tag == SCR_DYNH_BLOB || d->v.handle.tag == SCR_DYNH_FILE)) {
    return d->v.handle.ptr;
  }
  return NULL;
}

/* `${value}`, with the leading undefined default applied by the caller. */
static ScrStr *scr_blob_to_string(const ScrDyn *value) { return scr_dyn_string_coerce_js(value); }

/* The type rule: any character outside U+0020..U+007E clears the type,
 * otherwise it is lowercased. Consumes s. */
static ScrStr *scr_blob_type_of(ScrStr *s) {
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (c < 0x20 || c > 0x7e) {
      scr_str_release(s);
      return scr_str_new("", 0);
    }
  }
  char *lower = malloc(s->len + 1);
  if (!lower) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < s->len; i++) {
    char c = s->data[i];
    lower[i] = c >= 'A' && c <= 'Z' ? (char)(c - 'A' + 'a') : c;
  }
  ScrStr *out = scr_str_new(lower, s->len);
  free(lower);
  scr_str_release(s);
  return out;
}

/* Node's openAsBlob keeps the type the caller gave it; only the characters
 * that could not travel in a header are dropped (the empty type then).
 * Case is preserved: MIME parameters can be case-sensitive. */
ScrStr *scr_blob_type_printable(ScrStr *raw) {
  for (size_t i = 0; i < raw->len; i++) {
    unsigned char c = (unsigned char)raw->data[i];
    if (c < 0x20 || c > 0x7e) return scr_str_new("", 0);
  }
  return scr_str_retain(raw);
}

/* One source part: a Blob contributes its own parts, an ArrayBuffer or
 * view its bytes, and anything else its UTF-8 string (line endings
 * rewritten to the platform's when `native`). */
static ScrBytes *scr_blob_copy_bytes(const ScrBlob *b);

static bool scr_blob_add_source(ScrBlobBuild *bb, const ScrDyn *source, bool native) {
  ScrBlob *inner = scr_blob_of(source);
  if (inner) {
    const uint8_t *at = inner->store->data + inner->off;
    for (size_t i = 0; i < inner->nparts; i++) {
      scr_blob_build_bytes(bb, at, inner->parts[i]);
      scr_blob_build_part(bb, inner->parts[i]);
      at += inner->parts[i];
    }
    return true;
  }
  if (source->kind == SCR_DYN_BYTES || scr_array_buffer_is(source) ||
      scr_shared_array_buffer_is(source)) {
    ScrBytes *view = scr_bytes_buffer_source(source);
    if (!view) return false;
    scr_blob_build_bytes(bb, view->data, view->len);
    scr_blob_build_part(bb, view->len);
    scr_bytes_release(view);
    return true;
  }
  ScrStr *text = scr_blob_to_string(source);
  if (!text) return false;
  ScrStr *well = scr_str_to_well_formed(text);
  scr_str_release(text);
  size_t start = bb->len;
  if (native) {
#ifdef _WIN32
    static const char eol[] = "\r\n";
#else
    static const char eol[] = "\n";
#endif
    /* Node's /\r\n|\r|\n/g: CRLF, a lone CR and a lone LF each become one
     * platform line break. */
    size_t run = 0;
    for (size_t i = 0; i < well->len;) {
      size_t skip = well->data[i] == '\n'   ? 1
                    : well->data[i] != '\r' ? 0
                    : i + 1 < well->len && well->data[i + 1] == '\n' ? 2
                                                                     : 1;
      if (skip == 0) {
        i++;
        continue;
      }
      scr_blob_build_bytes(bb, (const uint8_t *)well->data + run, i - run);
      scr_blob_build_bytes(bb, (const uint8_t *)eol, sizeof eol - 1);
      i += skip;
      run = i;
    }
    scr_blob_build_bytes(bb, (const uint8_t *)well->data + run, well->len - run);
  } else {
    scr_blob_build_bytes(bb, (const uint8_t *)well->data, well->len);
  }
  scr_blob_build_part(bb, bb->len - start);
  scr_str_release(well);
  return true;
}

static bool scr_blob_is_primitive(const ScrDyn *d) {
  return d->kind == SCR_DYN_NUM || d->kind == SCR_DYN_STR || d->kind == SCR_DYN_BOOL ||
         d->kind == SCR_DYN_BIGINT || d->kind == SCR_DYN_SYMBOL;
}

static bool scr_blob_absent(const ScrDyn *d) {
  return d == NULL || d->kind == SCR_DYN_UNDEF;
}

/* A property of the options dictionary (+1; NULL with nothing pending
 * when there is no dictionary). */
static ScrDyn *scr_blob_option(const ScrDyn *options, const char *key) {
  if (scr_blob_absent(options) || options->kind == SCR_DYN_NULL) return NULL;
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(options);
    ScrDyn *value = view ? scr_dyn_obj_read(view, key, strlen(key)) : NULL;
    scr_dyn_release(view);
    return value;
  }
  return scr_dyn_obj_read(options, key, strlen(key));
}

/* The TypeErrors of Node's Web IDL converters (lib/internal/webidl.js
 * makeException): "<context> <message>" with code ERR_INVALID_ARG_TYPE. */
static void scr_blob_webidl_fail(const char *context, const char *message) {
  char text[160];
  snprintf(text, sizeof text, "%s %s", context, message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text, strlen(text), "ERR_INVALID_ARG_TYPE");
}

static void scr_blob_not_sequence(void) {
  scr_blob_webidl_fail("Value", "cannot be converted to sequence.");
}

/* The sources sequence as a dyn array (+1): absent is empty; arrays, typed
 * arrays and the native collections (Set, Map) drain in iteration order.
 * Other iterables (generators, user iterators) throw the SC2020 refusal,
 * like new Map(entries); primitives (strings included), null and
 * non-iterable objects throw Node's sequence TypeError. NULL with the
 * exception pending. */
static ScrDyn *scr_blob_source_list(const ScrDyn *sources) {
  if (scr_blob_absent(sources)) return scr_dyn_new_arr();
  if (sources->kind == SCR_DYN_ARR) return scr_dyn_retain((ScrDyn *)sources);
  if (sources->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(sources)) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(sources);
    if (view && view->kind == SCR_DYN_ARR) return view;
    scr_dyn_release(view);
    if (scr_exc_pending()) return NULL;
  }
  if (sources->kind == SCR_DYN_BYTES ||
      (sources->kind == SCR_DYN_HANDLE && scr_dyn_handle_ops_of(sources)->iter_pack)) {
    return scr_dyn_iter_pack(sources, NULL);
  }
  if (sources->kind != SCR_DYN_NULL && !scr_blob_is_primitive(sources)) {
    ScrDyn *iterator = scr_dyn_iterator_optional(sources);
    if (iterator) {
      scr_dyn_release(iterator);
      static const char message[] = "new Blob(sources) over this iterable has no lowering; pass an array";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    if (scr_exc_pending()) return NULL;
  }
  scr_blob_not_sequence();
  return NULL;
}

/* The sequence's element conversion: Blobs, ArrayBuffers and views stay as
 * they are (copied later), everything else becomes a DOMString through JS
 * ToString, in order. A Symbol throws "Value[i] is a Symbol ...". +1 array
 * of converted parts, or NULL with the exception pending. */
static ScrDyn *scr_blob_convert_parts(const ScrDyn *list) {
  ScrDyn *out = scr_dyn_new_arr();
  for (size_t i = 0; i < list->v.arr.len; i++) {
    const ScrDyn *item = scr_dyn_arr_has_index(list, i) ? list->v.arr.items[i] : scr_dyn_undefined();
    if (scr_blob_of(item) || item->kind == SCR_DYN_BYTES || scr_array_buffer_is(item) ||
        scr_shared_array_buffer_is(item)) {
      scr_dyn_arr_push(out, scr_dyn_retain((ScrDyn *)item));
      continue;
    }
    if (item->kind == SCR_DYN_SYMBOL) {
      char context[32];
      snprintf(context, sizeof context, "Value[%zu]", i);
      scr_blob_webidl_fail(context, "is a Symbol and cannot be converted to a string.");
      scr_dyn_release(out);
      return NULL;
    }
    ScrStr *text = scr_blob_to_string(item);
    if (!text) {
      scr_dyn_release(out);
      return NULL;
    }
    scr_dyn_arr_push(out, scr_dyn_new_str(text));
    scr_str_release(text);
  }
  return out;
}

/* The Blob constructor's steps, shared by File: sources convert as a Web
 * IDL sequence (absent is []) with each non-buffer part converted to a
 * string, then options must be a dictionary; endings and type are read in
 * that order, endings converted and checked, the parts encoded and
 * copied, then the type converted. NULL with the exception pending. */
/* ── parts of a Blob built from several sources ───────────────────────
 * A Blob built from more than one part can hold file-backed parts too. Its
 * bytes then come from a chain of segments in part order: the copied parts
 * live in one store, and a file part reads from the file's own source when
 * the Blob is read, so building the Blob does not read (or copy) the file.
 * Slices, clone refusal and the readers all see the chain as the Blob's
 * single on-demand source. */
typedef struct ScrBlobSeg {
  size_t len;
  ScrBlobSource *source; /* NULL when the bytes live in the chain's store */
  size_t source_off;
  size_t store_off;
} ScrBlobSeg;

typedef struct ScrBlobChain {
  ScrBlobStore *store;
  ScrBlobSeg *segs;
  size_t nsegs;
  size_t len;
} ScrBlobChain;

static bool scr_blob_chain_read(void *ctx, size_t off, size_t len, uint8_t *dst) {
  ScrBlobChain *c = ctx;
  /* A read of the whole Blob asks every file part, an empty one included:
   * the part's own check is what turns a changed or removed file into
   * NotReadableError. A read of a window inside it (a slice, which shares
   * this chain) asks only the file parts the window covers, so a slice of
   * copied bytes does not depend on a file outside it. */
  bool whole = off == 0 && len == c->len;
  size_t at = 0;
  for (size_t i = 0; i < c->nsegs; i++) {
    ScrBlobSeg *seg = &c->segs[i];
    bool asked = whole || (seg->len != 0 && at < off + len && off < at + seg->len);
    if (asked && seg->source != NULL &&
        !seg->source->read(seg->source->ctx, seg->source_off, 0, NULL)) {
      return false;
    }
    at += seg->len;
  }
  size_t pos = 0, done = 0;
  for (size_t i = 0; i < c->nsegs && done < len; i++) {
    ScrBlobSeg *seg = &c->segs[i];
    if (off >= pos + seg->len) {
      pos += seg->len;
      continue;
    }
    size_t skip = off > pos ? off - pos : 0;
    size_t take = seg->len - skip;
    if (take > len - done) take = len - done;
    if (seg->source != NULL) {
      if (!seg->source->read(seg->source->ctx, seg->source_off + skip, take, dst + done)) return false;
    } else if (take) {
      memcpy(dst + done, c->store->data + seg->store_off + skip, take);
    }
    done += take;
    pos += seg->len;
  }
  return done == len;
}

/* The Blob's release: the store, every file part's share, the segments. */
static void scr_blob_chain_release(void *ctx) {
  ScrBlobChain *c = ctx;
  scr_blob_store_release(c->store);
  for (size_t i = 0; i < c->nsegs; i++) {
    ScrBlobSource *source = c->segs[i].source;
    if (source != NULL && --source->rc == 0) {
      if (source->release) source->release(source->ctx);
      free(source);
    }
  }
  free(c->segs);
  free(c);
}

static ScrBlob *scr_blob_construct(const ScrDyn *sources, const ScrDyn *options) {
  ScrDyn *raw = scr_blob_source_list(sources);
  if (!raw) return NULL;
  ScrDyn *list = scr_blob_convert_parts(raw);
  scr_dyn_release(raw);
  if (!list) return NULL;
  if (!scr_blob_absent(options) && scr_blob_is_primitive(options)) {
    scr_dyn_release(list);
    scr_dyn_arg_type_fail("options", "a dictionary", options);
    return NULL;
  }
  ScrDyn *endings_raw = scr_blob_option(options, "endings");
  if (!endings_raw && scr_exc_pending()) {
    scr_dyn_release(list);
    return NULL;
  }
  ScrDyn *type_raw = scr_blob_option(options, "type");
  if (!type_raw && scr_exc_pending()) {
    scr_dyn_release(endings_raw);
    scr_dyn_release(list);
    return NULL;
  }
  bool native = false;
  if (!scr_blob_absent(endings_raw)) {
    ScrStr *endings = scr_blob_to_string(endings_raw);
    if (!endings) goto fail;
    bool transparent = endings->len == 11 && memcmp(endings->data, "transparent", 11) == 0;
    native = endings->len == 6 && memcmp(endings->data, "native", 6) == 0;
    if (!transparent && !native) {
      ScrDyn *shown = scr_dyn_new_str(endings);
      scr_str_release(endings);
      scr_dyn_arg_value_fail("options.endings", NULL, shown);
      scr_dyn_release(shown);
      goto fail;
    }
    scr_str_release(endings);
  }
  ScrStr *type = scr_blob_absent(type_raw) ? scr_str_new("", 0) : scr_blob_to_string(type_raw);
  if (!type) goto fail;
  /* A single file-backed part stays lazy: the new Blob shares the file's
   * source instead of copying its bytes, so it reads (and rejects a changed
   * file) exactly like the Blob it was built from, as Node's data queue
   * does. */
  if (!native && list->v.arr.len == 1) {
    const ScrDyn *only_value =
        scr_dyn_arr_has_index(list, 0) ? list->v.arr.items[0] : scr_dyn_undefined();
    ScrBlob *only = scr_blob_of(only_value);
    if (only != NULL && only->source != NULL) {
      ScrBlob *out = scr_blob_alloc();
      only->source->rc++;
      out->source = only->source;
      out->off = only->off;
      out->len = only->len;
      out->nparts = only->nparts;
      if (only->nparts) {
        out->parts = malloc(only->nparts * sizeof *out->parts);
        if (!out->parts) scr_trap("scriptc: out of memory\n");
        memcpy(out->parts, only->parts, only->nparts * sizeof *out->parts);
      }
      out->last_modified = only->last_modified;
      out->type = scr_blob_type_of(type); /* consumes the type */
      scr_dyn_release(endings_raw);
      scr_dyn_release(type_raw);
      scr_dyn_release(list);
      return out;
    }
  }
  ScrBlobBuild bb = {0};
  ScrBlobSeg *segs = NULL;
  size_t nsegs = 0, nsegs_cap = 0;
  bool lazy = false;
  for (size_t i = 0; i < list->v.arr.len; i++) {
    const ScrDyn *item = scr_dyn_arr_has_index(list, i) ? list->v.arr.items[i] : scr_dyn_undefined();
    ScrBlob *inner = scr_blob_of(item);
    if (inner != NULL && inner->source != NULL) {
      /* A file-backed part keeps its bytes lazy: the chain asks the file's
       * source when the Blob is read. */
      if (nsegs == nsegs_cap) {
        size_t cap = nsegs_cap ? nsegs_cap * 2 : 4;
        ScrBlobSeg *grown = realloc(segs, cap * sizeof *segs);
        if (!grown) scr_trap("scriptc: out of memory\n");
        segs = grown;
        nsegs_cap = cap;
      }
      lazy = true;
      segs[nsegs].len = inner->len;
      segs[nsegs].source = inner->source;
      inner->source->rc++;
      segs[nsegs].source_off = inner->off;
      segs[nsegs].store_off = 0;
      nsegs++;
      continue;
    }
    size_t at = bb.len;
    if (!scr_blob_add_source(&bb, item, native)) {
      scr_blob_build_free(&bb);
      for (size_t k = 0; k < nsegs; k++) {
        ScrBlobSource *source = segs[k].source;
        if (source != NULL && --source->rc == 0) {
          if (source->release) source->release(source->ctx);
          free(source);
        }
      }
      free(segs);
      scr_str_release(type);
      goto fail;
    }
    if (nsegs == nsegs_cap) {
      size_t cap = nsegs_cap ? nsegs_cap * 2 : 4;
      ScrBlobSeg *grown = realloc(segs, cap * sizeof *segs);
      if (!grown) scr_trap("scriptc: out of memory\n");
      segs = grown;
      nsegs_cap = cap;
    }
    segs[nsegs].len = bb.len - at;
    segs[nsegs].source = NULL;
    segs[nsegs].source_off = 0;
    segs[nsegs].store_off = at;
    nsegs++;
  }
  scr_dyn_release(endings_raw);
  scr_dyn_release(type_raw);
  scr_dyn_release(list);
  if (!lazy) {
    free(segs);
    return scr_blob_from_build(&bb, scr_blob_type_of(type));
  }
  ScrBlobChain *chain = calloc(1, sizeof *chain);
  if (!chain) scr_trap("scriptc: out of memory\n");
  if (bb.len) {
    ScrBlobStore *store = malloc(sizeof *store + bb.len);
    if (!store) scr_trap("scriptc: out of memory\n");
    store->rc = 1;
    store->len = bb.len;
    memcpy(store->data, bb.data, bb.len);
    chain->store = store;
  }
  scr_blob_build_free(&bb);
  chain->segs = segs;
  chain->nsegs = nsegs;
  for (size_t i = 0; i < nsegs; i++) chain->len += segs[i].len;
  ScrBlobSource *source = malloc(sizeof *source);
  if (!source) scr_trap("scriptc: out of memory\n");
  source->rc = 1;
  source->ctx = chain;
  source->read = scr_blob_chain_read;
  source->release = scr_blob_chain_release;
  ScrBlob *built = scr_blob_alloc();
  built->source = source;
  built->len = chain->len;
  built->nparts = nsegs;
  if (nsegs) {
    built->parts = malloc(nsegs * sizeof *built->parts);
    if (!built->parts) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < nsegs; i++) built->parts[i] = segs[i].len;
  }
  built->type = scr_blob_type_of(type);
  return built;
fail:
  scr_dyn_release(endings_raw);
  scr_dyn_release(type_raw);
  scr_dyn_release(list);
  return NULL;
}

/* ── handle operations ───────────────────────────────────────────────── */

static void scr_blob_install(void);

static ScrDyn *scr_blob_box(ScrBlob *b) {
  ScrDyn *out = scr_dyn_new_handle(b, b->name ? SCR_DYNH_FILE : SCR_DYNH_BLOB);
  scr_blob_release_v(b);
  return out;
}

static void scr_blob_invalid_this(const char *cls) {
  char message[64];
  snprintf(message, sizeof message, "Value of \"this\" must be of type %s", cls);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), "ERR_INVALID_THIS");
}

/* Web IDL's [Clamp] long long for slice(): ToNumber (a BigInt or Symbol
 * throws the converter's TypeError naming `context`), NaN answers 0, other
 * values clamp to +/-(2^53 - 1) and round half to even. */
static bool scr_blob_to_int(const ScrDyn *value, const char *context, double *out) {
  if (value->kind == SCR_DYN_BIGINT || value->kind == SCR_DYN_SYMBOL) {
    scr_blob_webidl_fail(context, value->kind == SCR_DYN_BIGINT
                                      ? "is a BigInt and cannot be converted to a number."
                                      : "is a Symbol and cannot be converted to a number.");
    return false;
  }
  double x;
  if (!scr_dyn_number_coerce_js(value, &x)) return false;
  if (x != x) {
    *out = 0;
    return true;
  }
  x = fmin(fmax(x, -9007199254740991.0), 9007199254740991.0);
  double i = trunc(x);
  double rem = fabs(x - i);
  double sign = x < 0 ? -1 : 1;
  double r = rem == 0.5 ? (fmod(i, 2) == 0 ? i : i + sign) : rem < 0.5 ? i : i + sign;
  *out = r == 0 ? 0 : r;
  return true;
}

static ScrBlob *scr_blob_slice_of(ScrBlob *b, ScrDyn *const *args, size_t argc) {
  double start = 0, end = (double)b->len;
  if (argc > 0 && !scr_blob_absent(args[0]) && !scr_blob_to_int(args[0], "start", &start)) {
    return NULL;
  }
  if (argc > 1 && !scr_blob_absent(args[1]) && !scr_blob_to_int(args[1], "end", &end)) return NULL;
  double len = (double)b->len;
  start = start < 0 ? fmax(len + start, 0) : fmin(start, len);
  end = end < 0 ? fmax(len + end, 0) : fmin(end, len);
  ScrStr *type = NULL;
  if (argc > 2 && !scr_blob_absent(args[2])) {
    ScrStr *raw = scr_blob_to_string(args[2]);
    if (!raw) return NULL;
    type = scr_blob_type_of(raw);
  } else {
    type = scr_str_new("", 0);
  }
  size_t from = (size_t)start;
  size_t span = end > start ? (size_t)(end - start) : 0;
  ScrBlob *out = scr_blob_alloc();
  if (span == 0) {
    /* An empty window carries no bytes, so it is an ordinary empty Blob
     * rather than a view of the file: it reads and clones freely even after
     * the file is gone, as Node's empty slices do. */
    ScrBlobStore *empty = malloc(sizeof *empty);
    if (!empty) scr_trap("scriptc: out of memory\n");
    empty->rc = 1;
    empty->len = 0;
    out->store = empty;
    out->off = 0;
  } else if (b->source) {
    b->source->rc++;
    out->source = b->source;
    out->off = b->off + from;
  } else {
    b->store->rc++;
    out->store = b->store;
    out->off = b->off + from;
  }
  out->len = span;
  out->type = type;
  /* Node's queue slice: nothing for an empty span, otherwise every part
   * that ends at or after the start and begins before the end (a part
   * ending exactly at the start stays as an empty entry). */
  if (span > 0) {
    out->parts = malloc(b->nparts * sizeof *out->parts);
    if (!out->parts) scr_trap("scriptc: out of memory\n");
    size_t pos = 0, to = from + span;
    for (size_t i = 0; i < b->nparts; i++) {
      size_t lo = pos, hi = pos + b->parts[i];
      pos = hi;
      if (hi < from || lo >= to) continue;
      size_t keep_lo = lo > from ? lo : from;
      size_t keep_hi = hi < to ? hi : to;
      out->parts[out->nparts++] = keep_hi - keep_lo;
    }
  }
  return out;
}

/* A fresh Blob handle over the same bytes and type, as
 * buffer.resolveObjectURL rebuilds one from its registration: each call
 * answers a new object, not the registered handle itself. */
static ScrDyn *scr_blob_fresh_copy(const ScrDyn *blob) {
  ScrBlob *b = scr_blob_of(blob);
  if (b == NULL) return scr_dyn_undefined();
  ScrStr *type = scr_str_retain(b->type);
  ScrDyn *type_value = scr_dyn_new_str(type);
  scr_str_release(type);
  ScrDyn *args[3] = { scr_dyn_undefined(), scr_dyn_undefined(), type_value };
  ScrBlob *out = scr_blob_slice_of(b, args, 3);
  scr_dyn_release(type_value);
  return out ? scr_blob_box(out) : NULL;
}

/* buffer.resolveObjectURL(id): Node coerces the argument to a string
 * (the template-literal form, which throws its TypeError for a symbol),
 * reads the registration out of the URL's pathname, and answers a fresh
 * Blob handle over the registered bytes and type — a new object per call —
 * or undefined when the id names nothing. */
ScrDyn *scr_buffer_resolve_object_url(const ScrDyn *id) {
  if (id == NULL) id = scr_dyn_undefined();
  ScrStr *text = scr_dyn_string_coerce_js(id);
  if (text == NULL) return NULL;
  ScrDyn *found = scr_url_resolve_object_url(text);
  scr_str_release(text);
  if (found == NULL) return scr_dyn_undefined();
  ScrDyn *out = scr_blob_fresh_copy(found);
  scr_dyn_release(found);
  return out;
}

/* NotReadableError: the source of a file-backed Blob changed or could not
 * be read (Node's DOMException for exactly this). */
static void scr_blob_not_readable(void) {
  scr_throw_domex("NotReadableError", "The blob could not be read");
}

/* The blob's bytes (+1), or NULL with NotReadableError pending when a
 * file-backed source no longer answers its range. */
static ScrBytes *scr_blob_copy_bytes(const ScrBlob *b) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)b->len);
  if (b->source) {
    /* The source is asked even for an empty Blob: its check is what turns
     * a changed or removed file into NotReadableError. */
    if (!b->source->read(b->source->ctx, b->off, b->len, bytes->len ? bytes->data : NULL)) {
      scr_bytes_release(bytes);
      scr_blob_not_readable();
      return NULL;
    }
  } else if (b->len) {
    memcpy(bytes->data, b->store->data + b->off, b->len);
  }
  return bytes;
}

/* extractBody's Blob/File arm: the body is the blob's bytes, not the
 * "[object Blob]" string the USVString fallback would send. */
bool scr_blob_body_info(const ScrDyn *value, ScrBytes **bytes, ScrStr **type) {
  ScrBlob *b = scr_blob_of(value);
  if (!b) return false;
  ScrBytes *copied = scr_blob_copy_bytes(b);
  if (copied == NULL) return false; /* NotReadableError pending */
  *bytes = copied;
  *type = b->type ? scr_str_retain(b->type) : NULL;
  return true;
}

/* A Blob over bytes another unit produces on demand (fs.openAsBlob): one
 * part, Node's file blob shape — the size the source reported when the
 * Blob was created. */
ScrDyn *scr_blob_from_source(ScrBlobSource *source, double size, ScrStr *type) {
  scr_blob_install();
  ScrBlob *b = scr_blob_alloc();
  b->source = source; /* moves the source's reference */
  b->len = size > 0 ? (size_t)size : 0;
  if (b->len) {
    b->nparts = 1;
    b->parts = malloc(sizeof *b->parts);
    if (!b->parts) scr_trap("scriptc: out of memory\n");
    b->parts[0] = b->len;
  }
  b->type = type ? scr_str_retain(type) : scr_str_new("", 0);
  return scr_blob_box(b);
}

/* Settled `p` seen `turns` microtask turns later (consumes p). */
static ScrPromise *scr_blob_after_turns(ScrPromise *p, size_t turns) {
  for (size_t i = 0; i < turns; i++) {
    ScrPromise *next = scr_promise_new();
    scr_promise_race_join(next, p, scr_promise_adapt_copy);
    scr_promise_release(p);
    p = next;
  }
  return p;
}

/* Node pulls one part per read and queues a microtask between reads, so
 * arrayBuffer() settles 2n - 1 turns after the call for n parts (at once
 * for none); text() and bytes() convert in one more turn. */
static size_t scr_blob_read_turns(const ScrBlob *b) { return b->nparts ? 2 * b->nparts - 1 : 0; }

typedef enum { SCR_BLOB_READ_BUFFER, SCR_BLOB_READ_TEXT, SCR_BLOB_READ_BYTES } ScrBlobRead;

/* The read's promise (the settled_* constructors take the payload), with a dyn payload when `boxed` (the dyn dispatch
 * path) and the typed payload otherwise. */
static ScrPromise *scr_blob_read(const ScrDyn *self, ScrBlobRead mode, bool boxed) {
  ScrBlob *b = scr_blob_of(self);
  if (!b) {
    scr_blob_invalid_this("Blob");
    ScrPromise *p = scr_promise_new();
    scr_promise_reject_pending(p);
    return p;
  }
  ScrBytes *bytes = scr_blob_copy_bytes(b);
  if (bytes == NULL) {
    /* A file-backed source that changed: Node rejects the read. */
    ScrPromise *failed = scr_promise_new();
    scr_promise_reject_pending(failed);
    return failed;
  }
  ScrPromise *p;
  size_t turns = scr_blob_read_turns(b);
  if (mode == SCR_BLOB_READ_TEXT) {
    ScrStr *text = scr_text_decode(bytes);
    scr_bytes_release(bytes);
    if (boxed) {
      ScrDyn *value = scr_dyn_new_str(text);
      scr_str_release(text);
      p = scr_promise_settled_ref(value, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
    } else {
      p = scr_promise_settled_str(text);
    }
    turns++;
  } else if (mode == SCR_BLOB_READ_BYTES && !boxed) {
    p = scr_promise_settled_ref(bytes, &scr_bytes_retain_v, &scr_bytes_release_v, NULL);
    turns++;
  } else {
    ScrDyn *value =
        mode == SCR_BLOB_READ_BUFFER ? scr_array_buffer_from_bytes(bytes) : scr_dyn_new_bytes(bytes);
    scr_bytes_release(bytes);
    p = scr_promise_settled_ref(value, &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
    if (mode == SCR_BLOB_READ_BYTES) turns++;
  }
  return scr_blob_after_turns(p, turns);
}

static ScrDyn *scr_blob_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                               size_t argc, const char *what) {
  ScrBlob *b = ptr;
  if (strcmp(method, "toString") == 0) {
    /* Object.prototype.toString with the class's @@toStringTag. */
    const char *tag = b->name ? "[object File]" : "[object Blob]";
    ScrStr *text = scr_str_new(tag, strlen(tag));
    ScrDyn *out = scr_dyn_new_str(text);
    scr_str_release(text);
    return out;
  }
  if (strcmp(method, "slice") == 0) {
    ScrBlob *out = scr_blob_slice_of(b, args, argc);
    return out ? scr_blob_box(out) : NULL;
  }
  ScrBlobRead mode;
  if (strcmp(method, "arrayBuffer") == 0) {
    mode = SCR_BLOB_READ_BUFFER;
  } else if (strcmp(method, "text") == 0) {
    mode = SCR_BLOB_READ_TEXT;
  } else if (strcmp(method, "bytes") == 0) {
    mode = SCR_BLOB_READ_BYTES;
  } else if (strcmp(method, "stream") == 0 || strcmp(method, "textStream") == 0) {
    char message[64];
    snprintf(message, sizeof message, "Blob.%s() is not supported yet", method);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
    return NULL;
  } else {
    char message[256];
    snprintf(message, sizeof message, "%s is not a function", what);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return NULL;
  }
  ScrPromise *p = scr_blob_read(self, mode, true);
  ScrDyn *out = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return out;
}

static ScrDyn *scr_blob_get(void *ptr, const char *key, size_t key_len) {
  ScrBlob *b = ptr;
  if (key_len == 4 && memcmp(key, "size", 4) == 0) return scr_dyn_new_num((double)b->len);
  if (key_len == 4 && memcmp(key, "type", 4) == 0) return scr_dyn_new_str(b->type);
  if (b->name && key_len == 4 && memcmp(key, "name", 4) == 0) return scr_dyn_new_str(b->name);
  if (b->name && key_len == 12 && memcmp(key, "lastModified", 12) == 0) {
    return scr_dyn_new_num(b->last_modified);
  }
  return NULL;
}

static bool scr_blob_set(void *ptr, const char *key, size_t key_len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)key_len;
  (void)value;
  return false;
}

/* Node's [kInspect]: `Blob { size, type }` and `File { size, type, name,
 * lastModified }`. */
static ScrDyn *scr_blob_inspect_view(void *ptr) {
  ScrBlob *b = ptr;
  ScrDyn *view = scr_dyn_new_obj();
  scr_dyn_obj_set(view, "size", 4, scr_dyn_new_num((double)b->len));
  scr_dyn_obj_set(view, "type", 4, scr_dyn_new_str(b->type));
  if (b->name) {
    scr_dyn_obj_set(view, "name", 4, scr_dyn_new_str(b->name));
    scr_dyn_obj_set(view, "lastModified", 12, scr_dyn_new_num(b->last_modified));
  }
  return view;
}

/* structuredClone: a new Blob (or File) over the same immutable store. */
/* Node's structured clone and postMessage both refuse a Blob backed by a
 * file: "Invalid state: File-backed Blobs are not cloneable". */
static void scr_blob_not_cloneable(void) {
  static const char message[] = "Invalid state: File-backed Blobs are not cloneable";
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_STATE");
}

static ScrDyn *scr_blob_clone(void *ptr) {
  ScrBlob *b = ptr;
  if (b->source) {
    scr_blob_not_cloneable();
    return NULL;
  }
  ScrBlob *out = scr_blob_alloc();
  b->store->rc++;
  out->store = b->store;
  out->off = b->off;
  out->len = b->len;
  out->nparts = b->nparts;
  if (b->nparts) {
    out->parts = malloc(b->nparts * sizeof *out->parts);
    if (!out->parts) scr_trap("scriptc: out of memory\n");
    memcpy(out->parts, b->parts, b->nparts * sizeof *out->parts);
  }
  out->type = scr_str_retain(b->type);
  if (b->name) out->name = scr_str_retain(b->name);
  out->last_modified = b->last_modified;
  return scr_blob_box(out);
}

/* ── Blob and File in a message ───────────────────────────────────────
 * A message shares a Blob with another thread: the payload is self-contained
 * (the immutable store by reference, the rest copied) so the receiving thread
 * builds its own Blob over the same bytes, as Node's serializer does. */
typedef struct {
  ScrBlobStore *store;
  size_t off, len;
  size_t nparts;
  size_t *parts;
  char *type;
  size_t type_len, name_len;
  char *name;
  double last_modified;
} ScrBlobPayload;

static char *scr_blob_payload_text(const ScrStr *text, size_t *length) {
  *length = text ? text->len : 0;
  if (!text) return NULL;
  char *copy = malloc(text->len ? text->len : 1);
  if (!copy) scr_trap("scriptc: out of memory\n");
  memcpy(copy, text->data, text->len);
  return copy;
}

static void *scr_blob_share(void *h) {
  ScrBlob *b = h;
  ScrBlobPayload *payload = calloc(1, sizeof *payload);
  if (!payload) scr_trap("scriptc: out of memory\n");
  if (b->store) {
    payload->store = scr_blob_store_retain(b->store);
    payload->off = b->off;
    payload->len = b->len;
    payload->last_modified = b->last_modified;
    payload->nparts = b->nparts;
    if (b->nparts && b->parts) {
      payload->parts = malloc(b->nparts * sizeof *payload->parts);
      if (!payload->parts) scr_trap("scriptc: out of memory\n");
      memcpy(payload->parts, b->parts, b->nparts * sizeof *payload->parts);
    }
  } else {
    /* A file-backed Blob cannot cross a message: its bytes live in the
     * file, which the receiving thread would have to re-open and re-check.
     * The encoder reads a NULL with the exception pending (scr_message.c). */
    free(payload);
    scr_blob_not_cloneable();
    return NULL;
  }
  payload->type = scr_blob_payload_text(b->type, &payload->type_len);
  payload->name = scr_blob_payload_text(b->name, &payload->name_len);
  return payload;
}

static ScrDyn *scr_blob_adopt(void *payload) {
  ScrBlobPayload *p = payload;
  scr_blob_install();
  ScrBlob *b = scr_blob_alloc();
  b->store = p->store; /* moves the share's reference */
  p->store = NULL;
  b->off = p->off;
  b->len = p->len;
  b->last_modified = p->last_modified;
  b->nparts = p->nparts;
  b->parts = p->parts;
  p->parts = NULL;
  if (p->type) b->type = scr_str_new(p->type, p->type_len);
  if (p->name) b->name = scr_str_new(p->name, p->name_len);
  ScrDyn *out = scr_dyn_new_handle(b, p->name ? SCR_DYNH_FILE : SCR_DYNH_BLOB);
  scr_blob_release_v(b);
  return out;
}

static void scr_blob_transfer_drop(void *payload) {
  ScrBlobPayload *p = payload;
  if (!p) return;
  scr_blob_store_release(p->store);
  free(p->parts);
  free(p->type);
  free(p->name);
  free(p);
}

static const ScrDynHandleTransfer scr_blob_transfer = {
    scr_blob_share, scr_blob_adopt, scr_blob_transfer_drop,
};

static const ScrDynHandleOps scr_blob_ops = {
    .cls = "Blob",
    .retain = scr_blob_retain_v,
    .release = scr_blob_release_v,
    .invoke = scr_blob_invoke,
    .get = scr_blob_get,
    .set = scr_blob_set,
    .inspect_view = scr_blob_inspect_view,
    .clone = scr_blob_clone,
    .transfer = &scr_blob_transfer,
    .json_empty_object = true,
    .inspect_bracketed_past_depth = true,
};

static const ScrDynHandleOps scr_file_ops = {
    .cls = "File",
    .retain = scr_blob_retain_v,
    .release = scr_blob_release_v,
    .invoke = scr_blob_invoke,
    .get = scr_blob_get,
    .set = scr_blob_set,
    .inspect_view = scr_blob_inspect_view,
    .clone = scr_blob_clone,
    .transfer = &scr_blob_transfer,
    .json_empty_object = true,
    .inspect_bracketed_past_depth = true,
};

static void scr_blob_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_BLOB, &scr_blob_ops);
  scr_dyn_handle_install(SCR_DYNH_FILE, &scr_file_ops);
}

/* ── entry points ────────────────────────────────────────────────────── */

ScrDyn *scr_blob_new(ScrDyn *args) {
  scr_blob_install();
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrDyn *const *items = argc ? args->v.arr.items : NULL;
  ScrBlob *b = scr_blob_construct(argc > 0 ? items[0] : NULL, argc > 1 ? items[1] : NULL);
  return b ? scr_blob_box(b) : NULL;
}

/* The stream/consumers blob() result: `new Blob([bytes])`, whose type is
 * "" and whose size counts the bytes. */
ScrDyn *scr_sc_blob_value(ScrBytes *all) {
  /* The constructor's first argument is the list of parts, so the bytes
   * ride in a one-element array inside the args. */
  ScrDyn *list = scr_dyn_new_arr();
  scr_dyn_arr_push(list, scr_dyn_new_bytes(all));
  ScrDyn *args = scr_dyn_new_arr();
  scr_dyn_arr_push(args, list);
  ScrDyn *blob = scr_blob_new(args);
  scr_dyn_release(args);
  return blob;
}

ScrDyn *scr_file_new(ScrDyn *args) {
  scr_blob_install();
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  if (argc < 2) {
    static const char message[] = "The \"fileBits\" and \"fileName\" arguments must be specified";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
    return NULL;
  }
  ScrDyn *const *items = args->v.arr.items;
  const ScrDyn *options = argc > 2 ? items[2] : NULL;
  ScrBlob *b = scr_blob_construct(items[0], options);
  if (!b) return NULL;
  /* lastModified: +value with NaN as 0, Date.now() when absent; then the
   * name's ToString with lone surrogates replaced. */
  double last_modified = 0;
  ScrDyn *raw = scr_blob_option(options, "lastModified");
  if (!raw && scr_exc_pending()) {
    scr_blob_release_v(b);
    return NULL;
  }
  if (scr_blob_absent(raw)) {
    last_modified = scr_date_now();
  } else if (!scr_dyn_number_coerce_js(raw, &last_modified)) {
    scr_dyn_release(raw);
    scr_blob_release_v(b);
    return NULL;
  } else if (last_modified != last_modified) {
    last_modified = 0;
  }
  scr_dyn_release(raw);
  ScrStr *name = scr_blob_to_string(items[1]);
  if (!name) {
    scr_blob_release_v(b);
    return NULL;
  }
  /* A constructor path may have carried a name (a lazy file source): the
   * new File's name replaces it, so the old string is released first. */
  scr_str_release(b->name);
  b->name = scr_str_to_well_formed(name);
  scr_str_release(name);
  b->last_modified = last_modified;
  return scr_blob_box(b);
}

ScrDyn *scr_blob_slice(ScrDyn *self, ScrDyn *args) {
  ScrBlob *b = scr_blob_of(self);
  if (!b) {
    scr_blob_invalid_this("Blob");
    return NULL;
  }
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  ScrBlob *out = scr_blob_slice_of(b, argc ? args->v.arr.items : NULL, argc);
  return out ? scr_blob_box(out) : NULL;
}

ScrPromise *scr_blob_text(ScrDyn *self) { return scr_blob_read(self, SCR_BLOB_READ_TEXT, false); }

ScrPromise *scr_blob_bytes(ScrDyn *self) { return scr_blob_read(self, SCR_BLOB_READ_BYTES, false); }

ScrPromise *scr_blob_array_buffer(ScrDyn *self) {
  return scr_blob_read(self, SCR_BLOB_READ_BUFFER, false);
}

bool scr_blob_is(const ScrDyn *value, double kind) {
  ScrBlob *b = scr_blob_of(value);
  return b && (kind == 0 || b->name != NULL);
}
