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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct ScrBlobStore {
  size_t rc;
  size_t len;
  uint8_t data[];
} ScrBlobStore;

typedef struct ScrBlob {
  size_t rc;
  ScrBlobStore *store;
  size_t off, len; /* this Blob's window into store */
  size_t nparts;
  size_t *parts; /* byte length of each part, in order; they sum to len */
  ScrStr *type;
  ScrStr *name; /* File only; NULL for a Blob */
  double last_modified;
} ScrBlob;

static void scr_blob_store_release(ScrBlobStore *s) {
  if (s && --s->rc == 0) free(s);
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

/* One source part: a Blob contributes its own parts, an ArrayBuffer or
 * view its bytes, and anything else its UTF-8 string (line endings
 * rewritten to the platform's when `native`). */
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
  ScrBlobBuild bb = {0};
  for (size_t i = 0; i < list->v.arr.len; i++) {
    const ScrDyn *item = scr_dyn_arr_has_index(list, i) ? list->v.arr.items[i] : scr_dyn_undefined();
    if (!scr_blob_add_source(&bb, item, native)) {
      scr_blob_build_free(&bb);
      goto fail;
    }
  }
  ScrStr *type = scr_blob_absent(type_raw) ? scr_str_new("", 0) : scr_blob_to_string(type_raw);
  if (!type) {
    scr_blob_build_free(&bb);
    goto fail;
  }
  scr_dyn_release(endings_raw);
  scr_dyn_release(type_raw);
  scr_dyn_release(list);
  return scr_blob_from_build(&bb, scr_blob_type_of(type));
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
  b->store->rc++;
  out->store = b->store;
  out->off = b->off + from;
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

static ScrBytes *scr_blob_copy_bytes(const ScrBlob *b) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)b->len);
  if (b->len) memcpy(bytes->data, b->store->data + b->off, b->len);
  return bytes;
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
    scr_throw_error_msg(SCR_ERR_ERROR, message, strlen(message));
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
static ScrDyn *scr_blob_clone(void *ptr) {
  ScrBlob *b = ptr;
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

static const ScrDynHandleOps scr_blob_ops = {
    .cls = "Blob",
    .retain = scr_blob_retain_v,
    .release = scr_blob_release_v,
    .invoke = scr_blob_invoke,
    .get = scr_blob_get,
    .set = scr_blob_set,
    .inspect_view = scr_blob_inspect_view,
    .clone = scr_blob_clone,
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
