/* scriptc runtime — the global FormData class (Node's undici webidl
 * FormData).
 *
 * A FormData is a checked-dynamic handle over a list of entries: a name
 * whose ToString conversion Node performs, and either a string value or a
 * File built from the appended Blob/File (the filename comes from the third
 * argument, the File's own name, or "blob"), which is what Node stores and
 * what get()/getAll() answer.
 *
 * The unit covers the constructor, append/set/get/getAll/has/delete, and
 * the iteration members (entries/keys/values over the live entry list, and
 * forEach over a snapshot of it). The multipart request-body encoding is
 * not implemented yet: fetch refuses a FormData body by name. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct FormEntry {
  ScrStr *name; /* owned */
  ScrDyn *value; /* +1: a string dyn or a File handle (whose name is the
                  * part's filename) */
} FormEntry;

typedef struct ScrFormData {
  size_t rc;
  FormEntry *entries;
  size_t len, cap;
  ScrDyn *own; /* +1 expando properties, or NULL */
} ScrFormData;

static void fd_oom(void) { scr_trap("scriptc: out of memory\n"); }

static void *fd_retain(void *p) {
  ((ScrFormData *)p)->rc++;
  return p;
}

static void fd_entry_drop(FormEntry *e) {
  if (e->name) scr_str_release(e->name);
  if (e->value) scr_dyn_release(e->value);
  memset(e, 0, sizeof *e);
}

static void fd_free(ScrFormData *fd) {
  for (size_t i = 0; i < fd->len; i++) fd_entry_drop(&fd->entries[i]);
  free(fd->entries);
  if (fd->own) scr_dyn_release(fd->own);
  free(fd);
}

static void fd_release(void *p) {
  ScrFormData *fd = p;
  if (--fd->rc == 0) fd_free(fd);
}

/* Node's FormData names the value it refuses in a filename-carrying append
 * with undici's Stringify: a string in double quotes, a bigint with its n,
 * anything else by String(), and an object or array through util.inspect. */
static ScrStr *fd_stringify(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_STR: {
    ScrStr *quoted = scr_str_new("\"", 1);
    ScrStr *with = scr_str_concat(quoted, value->v.str);
    scr_str_release(quoted);
    ScrStr *tail = scr_str_new("\"", 1);
    ScrStr *out = scr_str_concat(with, tail);
    scr_str_release(with);
    scr_str_release(tail);
    return out;
  }
  case SCR_DYN_NUM: {
    char buf[40];
    scr_f64_to_str(value->v.num, buf);
    return scr_str_new(buf, strlen(buf));
  }
  case SCR_DYN_BIGINT: {
    ScrStr *digits = scr_bigint_inspect(value->v.bigint);
    return digits;
  }
  case SCR_DYN_NULL: return scr_str_new("null", 4);
  case SCR_DYN_UNDEF: return scr_str_new("undefined", 9);
  case SCR_DYN_BOOL: return scr_str_new(value->v.b ? "true" : "false", value->v.b ? 4 : 5);
  default: {
    ScrStr *text = scr_insp_inspect((ScrDyn *)value, NULL, NULL, NULL, 1);
    if (text) return text;
    scr_exc_clear();
    return scr_str_new("[object Object]", 15);
  }
  }
}

/* "N arguments required, but only M found." */
static void fd_throw_arity(const char *what, size_t required, size_t given) {
  char buf[128];
  /* Node omits "only" when no argument was given at all. */
  int n = snprintf(buf, sizeof buf, "%s: %zu argument%s required, but %s%zu found.", what,
                   required, required == 1 ? "" : "s", given > 0 ? "only " : "", given);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
}

/* The name/method prefix of a WebIDL error: "FormData.<method>". */
static const char *fd_method_name(const char *method, char *buf, size_t size) {
  snprintf(buf, size, "FormData.%s", method);
  return buf;
}

static bool fd_name_eq(const ScrStr *name, const ScrStr *arg) {
  return name->len == arg->len && memcmp(name->data, arg->data, name->len) == 0;
}

/* The File Node stores for a Blob or File value: its bytes and type, the
 * filename, and a lastModified of now. +1 handle, or NULL with the
 * exception pending. */
static ScrDyn *fd_file_value(const ScrDyn *blob, ScrStr *filename) {
  /* Node keeps the Blob's type on the File it stores (a File built from a
   * Blob without options drops it), so the entry carries it over. */
  ScrStr *type = NULL;
  if (blob->kind == SCR_DYN_HANDLE) {
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(blob);
    ScrDyn *read = ops->get ? ops->get(blob->v.handle.ptr, "type", 4) : NULL;
    if (read) {
      if (read->kind == SCR_DYN_STR) type = scr_str_retain(read->v.str);
      scr_dyn_release(read);
    }
  }
  ScrDyn *bits = scr_dyn_new_arr();
  scr_dyn_arr_push(bits, scr_dyn_retain((ScrDyn *)blob));
  ScrDyn *args = scr_dyn_new_arr();
  scr_dyn_arr_push(args, bits);
  scr_dyn_arr_push(args, scr_dyn_new_str(filename));
  ScrDyn *options = scr_dyn_new_obj();
  if (type) {
    scr_dyn_obj_set(options, "type", 4, scr_dyn_new_str(type));
    scr_str_release(type);
  }
  scr_dyn_arr_push(args, options);
  ScrDyn *file = scr_file_new(args);
  scr_dyn_release(args);
  return file;
}

/* The filename a Blob or File entry takes: the append's third argument, the
 * File's own name, or "blob". +1. */
static ScrStr *fd_entry_filename(const ScrDyn *value, const ScrDyn *given) {
  if (given && given->kind != SCR_DYN_UNDEF) {
    ScrStr *text = scr_dyn_string_coerce_js((ScrDyn *)given);
    if (text) return text;
    return NULL;
  }
  if (value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_FILE) {
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(value);
    ScrDyn *name = ops->get ? ops->get(value->v.handle.ptr, "name", 4) : NULL;
    if (name) {
      ScrStr *out = NULL;
      if (name->kind == SCR_DYN_STR) out = scr_str_retain(name->v.str);
      scr_dyn_release(name);
      if (out) return out;
    }
  }
  return scr_str_new("blob", 4);
}

/* The value an append/set records for `value`: a File for a Blob or File,
 * else the value's ToString. +1, or NULL with the exception pending. */
static ScrDyn *fd_entry_value(const ScrDyn *value, const ScrDyn *filename_arg,
                              const char *what) {
  bool is_blob = value->kind == SCR_DYN_HANDLE &&
                 (value->v.handle.tag == SCR_DYNH_BLOB || value->v.handle.tag == SCR_DYNH_FILE);
  if (filename_arg && filename_arg->kind != SCR_DYN_UNDEF && !is_blob) {
    ScrStr *shown = fd_stringify(value);
    char buf[256];
    int n = snprintf(buf, sizeof buf,
                     "%s: Expected value (\"%s\") to be an instance of Blob.", what,
                     shown->data);
    scr_str_release(shown);
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    return NULL;
  }
  if (is_blob) {
    ScrStr *filename = fd_entry_filename(value, filename_arg);
    if (!filename) return NULL;
    ScrDyn *file = fd_file_value(value, filename);
    scr_str_release(filename);
    return file;
  }
  ScrStr *text = scr_dyn_string_coerce_js((ScrDyn *)value);
  if (!text) return NULL;
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}

static void fd_push(ScrFormData *fd, ScrStr *name, ScrDyn *value) {
  if (fd->len == fd->cap) {
    size_t cap = fd->cap ? fd->cap * 2 : 8;
    FormEntry *grown = realloc(fd->entries, cap * sizeof *grown);
    if (!grown) fd_oom();
    fd->entries = grown;
    fd->cap = cap;
  }
  FormEntry *e = &fd->entries[fd->len++];
  e->name = name;
  e->value = value; /* takes ownership */
}

static void fd_remove_at(ScrFormData *fd, size_t at) {
  fd_entry_drop(&fd->entries[at]);
  memmove(&fd->entries[at], &fd->entries[at + 1], (fd->len - at - 1) * sizeof *fd->entries);
  fd->len--;
}

/* The value dyn for an entry (+1): the stored string or File. */
static ScrDyn *fd_value_of(const FormEntry *e) { return scr_dyn_retain(e->value); }

static ScrDyn *fd_append(ScrFormData *fd, ScrDyn *const *args, size_t argc, bool is_set) {
  char namebuf[64];
  const char *what = fd_method_name(is_set ? "set" : "append", namebuf, sizeof namebuf);
  if (argc < 2) {
    fd_throw_arity(what, 2, argc);
    return NULL;
  }
  ScrStr *name = scr_dyn_string_coerce_js(args[0]);
  if (!name) return NULL;
  ScrDyn *value = fd_entry_value(args[1], argc > 2 ? args[2] : NULL, what);
  if (!value) {
    scr_str_release(name);
    return NULL;
  }
  if (!is_set) {
    fd_push(fd, name, value);
  } else {
    size_t first = fd->len;
    for (size_t i = 0; i < fd->len; i++) {
      if (!fd_name_eq(fd->entries[i].name, name)) continue;
      if (first == fd->len) first = i;
      else {
        fd_remove_at(fd, i);
        i--;
      }
    }
    if (first == fd->len) {
      fd_push(fd, name, value);
    } else {
      scr_str_release(fd->entries[first].name);
      fd->entries[first].name = name;
      scr_dyn_release(fd->entries[first].value);
      fd->entries[first].value = value;
    }
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrStr *fd_require_name(ScrDyn *const *args, size_t argc, const char *what) {
  if (argc < 1) {
    fd_throw_arity(what, 1, 0);
    return NULL;
  }
  return scr_dyn_string_coerce_js(args[0]);
}

static ScrDyn *fd_lookup(ScrFormData *fd, const char *method, ScrDyn *const *args,
                         size_t argc) {
  char namebuf[64];
  const char *what = fd_method_name(method, namebuf, sizeof namebuf);
  ScrStr *name = fd_require_name(args, argc, what);
  if (!name) return NULL;
  if (strcmp(method, "has") == 0) {
    bool found = false;
    for (size_t i = 0; i < fd->len && !found; i++) found = fd_name_eq(fd->entries[i].name, name);
    scr_str_release(name);
    return scr_dyn_new_bool(found);
  }
  if (strcmp(method, "delete") == 0) {
    for (size_t i = 0; i < fd->len; i++) {
      if (!fd_name_eq(fd->entries[i].name, name)) continue;
      fd_remove_at(fd, i);
      i--;
    }
    scr_str_release(name);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "get") == 0) {
    ScrDyn *out = NULL;
    for (size_t i = 0; i < fd->len; i++) {
      if (!fd_name_eq(fd->entries[i].name, name)) continue;
      out = fd_value_of(&fd->entries[i]);
      break;
    }
    scr_str_release(name);
    return out ? out : scr_dyn_new_null();
  }
  /* getAll */
  ScrDyn *all = scr_dyn_new_arr();
  for (size_t i = 0; i < fd->len; i++) {
    if (!fd_name_eq(fd->entries[i].name, name)) continue;
    scr_dyn_arr_push(all, fd_value_of(&fd->entries[i]));
  }
  scr_str_release(name);
  return all;
}

/* The live iterator step Node's entries/keys/values answer: selection 2
 * yields [name, value], 1 the names and 0 the values. */
static ScrDyn *fd_step(void *h, double *index, unsigned selection) {
  ScrFormData *fd = h;
  size_t i = (size_t)*index;
  bool done = i >= fd->len;
  ScrDyn *value;
  if (done) {
    value = scr_dyn_retain(scr_dyn_undefined());
    *index = (double)fd->len;
  } else {
    const FormEntry *e = &fd->entries[i];
    if (selection == 2) {
      value = scr_dyn_new_arr();
      scr_dyn_arr_push(value, scr_dyn_new_str(e->name));
      scr_dyn_arr_push(value, fd_value_of(e));
    } else if (selection == 1) {
      value = scr_dyn_new_str(e->name);
    } else {
      value = fd_value_of(e);
    }
    *index = (double)(i + 1);
  }
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, value);
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

static ScrDyn *fd_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                         size_t argc, const char *what) {
  ScrFormData *fd = ptr;
  (void)self; /* borrowed receiver */
  (void)what;
  if (strcmp(method, "append") == 0) return fd_append(fd, args, argc, false);
  if (strcmp(method, "set") == 0) return fd_append(fd, args, argc, true);
  if (strcmp(method, "get") == 0 || strcmp(method, "getAll") == 0 ||
      strcmp(method, "has") == 0 || strcmp(method, "delete") == 0)
    return fd_lookup(fd, method, args, argc);
  if (strcmp(method, "entries") == 0)
    return scr_dyn_native_handle_iterator(self, 2);
  if (strcmp(method, "keys") == 0) return scr_dyn_native_handle_iterator(self, 1);
  if (strcmp(method, "values") == 0) return scr_dyn_native_handle_iterator(self, 0);
  if (strcmp(method, "forEach") == 0) {
    char namebuf[64];
    const char *call = fd_method_name("forEach", namebuf, sizeof namebuf);
    if (argc < 1) {
      fd_throw_arity(call, 1, 0);
      return NULL;
    }
    if (!scr_dyn_is_callable(args[0])) {
      static const char message[] =
          "Failed to execute 'forEach' on 'FormData': parameter 1 is not of type 'Function'.";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    ScrDyn *this_arg = argc > 1 && args[1] != NULL ? args[1] : scr_dyn_undefined();
    for (size_t i = 0; i < fd->len; i++) {
      ScrDyn *value = fd_value_of(&fd->entries[i]);
      ScrDyn *key = scr_dyn_new_str(fd->entries[i].name);
      ScrDyn *argv[3] = {value, key, self};
      scr_dyn_this_push_dyn(this_arg);
      ScrDyn *result = scr_dyn_call(args[0], argv, 3, "FormData.forEach callback");
      scr_dyn_this_pop();
      scr_dyn_release(key);
      scr_dyn_release(value);
      if (!result) return NULL;
      scr_dyn_release(result);
      if (scr_exc_pending()) return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  /* A name the class does not have. */
  char buf[160];
  int n = snprintf(buf, sizeof buf, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
  return NULL;
}

static ScrDyn *fd_op_get(void *ptr, const char *key, size_t len) {
  ScrFormData *fd = ptr;
  if (len == 11 && memcmp(key, "constructor", 11) == 0)
    return scr_dyn_handle_class_value(SCR_DYNH_FORM_DATA);
  /* The class's method-value probe reads through a handle with no referent:
   * answer the prototype's members without touching the state. */
  if (fd) {
    ScrDyn *own = fd->own ? scr_dyn_obj_get(fd->own, key, len) : NULL;
    if (own) return scr_dyn_retain(own);
  }
  return scr_dyn_handle_class_member(SCR_DYNH_FORM_DATA, ptr, key, len);
}

static bool fd_op_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  ScrFormData *fd = ptr;
  if (!fd->own) fd->own = scr_dyn_new_obj();
  scr_dyn_obj_set(fd->own, key, len, scr_dyn_retain((ScrDyn *)value));
  return true;
}

/* The prototype's methods, with Node's Function.prototype.length. */
static const ScrDynHandleMethod fd_methods[] = {
    {"append", 2, false, NULL, NULL}, {"delete", 1, false, NULL, NULL},
    {"get", 1, false, NULL, NULL},    {"getAll", 1, false, NULL, NULL},
    {"has", 1, false, NULL, NULL},    {"set", 2, false, NULL, NULL},
    {NULL, 0, false, NULL, NULL},
};

static const ScrDynHandleOps fd_ops = {
    .cls = "FormData",
    .retain = fd_retain,
    .release = fd_release,
    .invoke = fd_invoke,
    .get = fd_op_get,
    .set = fd_op_set,
    .json_empty_object = true,
    .iter_step = fd_step,
    .to_string_tag = "FormData",
    .methods = fd_methods,
};

static ScrDyn *fd_construct(ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc; /* the constructor takes no arguments; extras are ignored */
  ScrFormData *fd = calloc(1, sizeof *fd);
  if (!fd) fd_oom();
  fd->rc = 1;
  ScrDyn *out = scr_dyn_new_handle(fd, SCR_DYNH_FORM_DATA);
  if (!out) {
    fd_release(fd);
    return NULL;
  }
  out->v.handle.traced = false;
  fd_release(fd);
  return out;
}

static const ScrDynHandleClass fd_class = {
    "FormData", 0, fd_construct, NULL, NULL, NULL, NULL,
};

static SCR_TL bool fd_installed;

static void fd_install(void) {
  if (fd_installed) return;
  fd_installed = true;
  scr_dyn_handle_class_install(SCR_DYNH_FORM_DATA, &fd_ops, &fd_class);
}

/* ── the multipart request-body encoding ────────────────────────────
 * undici's serializer: one recorded part per entry, CRLF line endings, the
 * name and filename escaped (\r, \n and " percent-encoded) and string
 * values with normalized line feeds, a random boundary, and the
 * multipart/form-data content type that carries it. */
typedef struct FdBuf {
  unsigned char *data;
  size_t len, cap;
} FdBuf;

static void fd_buf_add(FdBuf *b, const void *p, size_t n) {
  if (b->len + n > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->len + n) cap *= 2;
    unsigned char *grown = realloc(b->data, cap);
    if (!grown) fd_oom();
    b->data = grown;
    b->cap = cap;
  }
  if (n) memcpy(b->data + b->len, p, n);
  b->len += n;
}

static void fd_buf_str(FdBuf *b, const char *s) { fd_buf_add(b, s, strlen(s)); }

/* formdataEscape(normalizeLinefeeds(text)): a \r\n, a lone \r or a lone \n
 * becomes %0D%0A, and a double quote %22. */
static void fd_buf_escaped(FdBuf *b, const ScrStr *s) {
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (c == '\r') {
      if (i + 1 < s->len && s->data[i + 1] == '\n') i++;
      fd_buf_str(b, "%0D%0A");
    } else if (c == '\n') {
      fd_buf_str(b, "%0D%0A");
    } else if (c == '"') {
      fd_buf_str(b, "%22");
    } else {
      fd_buf_add(b, &c, 1);
    }
  }
}

/* formdataEscape(text) without the line-feed normalization: the filename's
 * form. */
static void fd_buf_escaped_raw(FdBuf *b, const ScrStr *s) {
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (c == '\r') fd_buf_str(b, "%0D");
    else if (c == '\n') fd_buf_str(b, "%0A");
    else if (c == '"') fd_buf_str(b, "%22");
    else fd_buf_add(b, &c, 1);
  }
}

/* normalizeLinefeeds(text): every line ending becomes CRLF. */
static void fd_buf_normalized(FdBuf *b, const ScrStr *s) {
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (c == '\r') {
      if (i + 1 < s->len && s->data[i + 1] == '\n') i++;
      fd_buf_str(b, "\r\n");
    } else if (c == '\n') {
      fd_buf_str(b, "\r\n");
    } else {
      fd_buf_add(b, &c, 1);
    }
  }
}

/* ── the multipart boundary ───────────────────────────────────────────
 * undici's shape, drawn from the system CSPRNG (arc4random_buf): a
 * co-resident client must not be able to predict the boundary and inject
 * parts of its own. Every part's text is checked for the boundary; a
 * conflict draws a longer boundary, and once it is longer than the longest
 * part it cannot occur inside one, so the loop always ends with a boundary
 * no part contains. */
static bool fd_bytes_contain(const unsigned char *hay, size_t n, const char *needle, size_t m) {
  if (m == 0 || n < m) return false;
  for (size_t i = 0; i + m <= n; i++)
    if (memcmp(hay + i, needle, m) == 0) return true;
  return false;
}

static bool fd_str_contains(const ScrStr *s, const char *needle, size_t m) {
  return fd_bytes_contain((const unsigned char *)s->data, s->len, needle, m);
}

/* The File handle's name (+1, or NULL). */
static ScrStr *fd_file_name(const ScrDyn *value) {
  const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(value);
  ScrDyn *read = ops->get ? ops->get(value->v.handle.ptr, "name", 4) : NULL;
  ScrStr *name = NULL;
  if (read) {
    if (read->kind == SCR_DYN_STR) name = scr_str_retain(read->v.str);
    scr_dyn_release(read);
  }
  return name;
}

/* The longest text any part can contribute, from lengths alone. */
static size_t fd_longest_part(const ScrFormData *fd) {
  size_t longest = 0;
  for (size_t i = 0; i < fd->len; i++) {
    const FormEntry *e = &fd->entries[i];
    if (e->name->len > longest) longest = e->name->len;
    if (e->value->kind == SCR_DYN_STR) {
      if (e->value->v.str->len > longest) longest = e->value->v.str->len;
      continue;
    }
    ScrStr *name = fd_file_name(e->value);
    if (name) {
      if (name->len > longest) longest = name->len;
      scr_str_release(name);
    }
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(e->value);
    ScrDyn *size = ops->get ? ops->get(e->value->v.handle.ptr, "size", 4) : NULL;
    if (size) {
      if (size->kind == SCR_DYN_NUM && size->v.num > (double)longest)
        longest = (size_t)size->v.num;
      scr_dyn_release(size);
    }
  }
  return longest;
}

static bool fd_boundary_conflicts(const ScrFormData *fd, const char *boundary, size_t len) {
  for (size_t i = 0; i < fd->len; i++) {
    const FormEntry *e = &fd->entries[i];
    if (fd_str_contains(e->name, boundary, len)) return true;
    if (e->value->kind == SCR_DYN_STR) {
      if (fd_str_contains(e->value->v.str, boundary, len)) return true;
      continue;
    }
    ScrStr *name = fd_file_name(e->value);
    bool hit = name && fd_str_contains(name, boundary, len);
    scr_str_release(name);
    if (hit) return true;
    ScrBytes *bytes = NULL;
    ScrStr *type = NULL;
    if (scr_blob_body_info(e->value, &bytes, &type)) {
      hit = fd_bytes_contain(bytes->data, bytes->len, boundary, len);
      scr_bytes_release(bytes);
      scr_str_release(type);
      if (hit) return true;
    }
  }
  return false;
}

ScrBytes *scr_formdata_encode(const ScrDyn *form, ScrStr **content_type) {
  ScrFormData *fd = form->v.handle.ptr;
  char boundary[192];
  size_t longest_part = fd_longest_part(fd);
  for (unsigned attempt = 0;; attempt++) {
    unsigned char raw[8];
    arc4random_buf(raw, sizeof raw);
    unsigned long long value = 0;
    for (size_t i = 0; i < sizeof raw; i++) value = (value << 8) | raw[i];
    size_t blen = (size_t)snprintf(boundary, sizeof boundary,
                                   "----formdata-undici-0%011llu", value % 100000000000ULL);
    /* A conflict draws a longer boundary: 8 more CSPRNG bytes per retry. */
    size_t extra = attempt == 0 ? 0 : attempt * 8;
    if (extra > 64) extra = 64;
    if (extra) {
      unsigned char more[64];
      arc4random_buf(more, extra);
      for (size_t i = 0; i < extra && blen + 2 < sizeof boundary; i++)
        blen += (size_t)snprintf(boundary + blen, sizeof boundary - blen, "%02x", more[i]);
    }
    if (blen > longest_part || !fd_boundary_conflicts(fd, boundary, blen)) break;
  }
  FdBuf out = {0};
  for (size_t i = 0; i < fd->len; i++) {
    const FormEntry *e = &fd->entries[i];
    fd_buf_str(&out, "--");
    fd_buf_str(&out, boundary);
    fd_buf_str(&out, "\r\nContent-Disposition: form-data; name=\"");
    fd_buf_escaped(&out, e->name);
    fd_buf_str(&out, "\"");
    if (e->value->kind == SCR_DYN_STR) {
      fd_buf_str(&out, "\r\n\r\n");
      fd_buf_normalized(&out, e->value->v.str);
      fd_buf_str(&out, "\r\n");
      continue;
    }
    /* Every Blob or File append stores a File, so the part carries its
     * name; the type falls back to octet-stream as undici does. */
    ScrBytes *bytes = NULL;
    ScrStr *type = NULL;
    if (!scr_blob_body_info(e->value, &bytes, &type)) {
      free(out.data);
      return NULL;
    }
    fd_buf_str(&out, "; filename=\"");
    ScrStr *filename = NULL;
    const ScrDynHandleOps *ops = scr_dyn_handle_ops_of(e->value);
    ScrDyn *read = ops->get ? ops->get(e->value->v.handle.ptr, "name", 4) : NULL;
    if (read) {
      if (read->kind == SCR_DYN_STR) filename = scr_str_retain(read->v.str);
      scr_dyn_release(read);
    }
    if (filename) {
      fd_buf_escaped_raw(&out, filename);
      scr_str_release(filename);
    } else {
      fd_buf_str(&out, "blob");
    }
    fd_buf_str(&out, "\"\r\nContent-Type: ");
    if (type && type->len > 0) fd_buf_add(&out, type->data, type->len);
    else fd_buf_str(&out, "application/octet-stream");
    fd_buf_str(&out, "\r\n\r\n");
    fd_buf_add(&out, bytes->data, bytes->len);
    fd_buf_str(&out, "\r\n");
    scr_str_release(type);
    scr_bytes_release(bytes);
  }
  fd_buf_str(&out, "--");
  fd_buf_str(&out, boundary);
  fd_buf_str(&out, "--\r\n");
  ScrBytes *encoded = scr_bytes_new(SCR_BYTES_U8, (double)out.len);
  if (out.len) memcpy(encoded->data, out.data, out.len);
  free(out.data);
  char header[128];
  int n = snprintf(header, sizeof header, "multipart/form-data; boundary=%s", boundary);
  *content_type = scr_str_new(header, (size_t)n);
  return encoded;
}

ScrDyn *scr_formdata_new(void) {
  fd_install();
  return fd_construct(NULL, 0);
}

ScrDyn *scr_formdata_class(void) {
  fd_install();
  return scr_dyn_handle_class_value(SCR_DYNH_FORM_DATA);
}

bool scr_formdata_instanceof(ScrDyn *value, double kind) {
  (void)kind;
  fd_install();
  if (value->kind == SCR_DYN_HANDLE)
    return scr_dyn_handle_class_tag_of(value) == SCR_DYNH_FORM_DATA;
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_ARR && value->kind != SCR_DYN_FUNC)
    return false;
  ScrDyn *prototype = scr_dyn_handle_class_prototype(SCR_DYNH_FORM_DATA);
  ScrDyn *current = scr_dyn_get_prototype(value);
  while (current && current->kind == SCR_DYN_OBJ) {
    if (current == prototype) return true;
    current = scr_dyn_get_prototype(current);
  }
  return false;
}
