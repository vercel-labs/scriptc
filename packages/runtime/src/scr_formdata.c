/* WHATWG FormData (Node 24's undici, lib/web/fetch/formdata.js): an
 * ordered entry list of [name, File|string] pairs as a checked-dynamic
 * handle. Every method is undici's own step order and error text: the
 * argument-count check, then USVString name conversion, then the Blob
 * converter the third-argument form requires, then makeEntry's File
 * wrapping (a Blob becomes a File named "blob", a given filename makes a
 * new File that keeps the type and lastModified), then the entry list
 * edit.
 *
 * The same unit holds the multipart/form-data encoding the fetch body
 * path sends (lib/web/fetch/body.js, extractBody's FormData arm), so a
 * FormData body never links the streams or async units. */
#include "scr_runtime.h"
#include "scr_blob_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── entry list ──────────────────────────────────────────────────────── */

typedef struct ScrFormDataEntry {
  ScrStr *name;  /* owned; USVString */
  ScrDyn *value; /* owned; a string or a File (never a plain Blob) */
} ScrFormDataEntry;

typedef struct ScrFormData {
  size_t rc;
  size_t len, cap;
  ScrFormDataEntry *entries;
} ScrFormData;

static void *scr_formdata_retain_v(void *h) {
  ((ScrFormData *)h)->rc++;
  return h;
}

static void scr_formdata_release_v(void *h) {
  ScrFormData *f = h;
  if (--f->rc) return;
  scr_weak_dispose_inline(f);
  for (size_t i = 0; i < f->len; i++) {
    scr_str_release(f->entries[i].name);
    scr_dyn_release(f->entries[i].value);
  }
  free(f->entries);
  free(f);
}

static ScrFormData *scr_formdata_alloc(void) {
  ScrFormData *f = calloc(1, sizeof *f);
  if (!f) scr_trap("scriptc: out of memory\n");
  f->rc = 1;
  return f;
}

static ScrFormData *scr_formdata_of(const ScrDyn *value) {
  if (value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_FORM_DATA) {
    return value->v.handle.ptr;
  }
  return NULL;
}

/* Appends an entry; takes ownership of both. */
static void scr_formdata_push(ScrFormData *f, ScrStr *name, ScrDyn *value) {
  if (f->len == f->cap) {
    size_t cap = f->cap ? f->cap * 2 : 8;
    ScrFormDataEntry *grown = realloc(f->entries, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    f->entries = grown;
    f->cap = cap;
  }
  f->entries[f->len].name = name;
  f->entries[f->len].value = value;
  f->len++;
}

static void scr_formdata_remove(ScrFormData *f, size_t index) {
  scr_str_release(f->entries[index].name);
  scr_dyn_release(f->entries[index].value);
  memmove(f->entries + index, f->entries + index + 1,
          (f->len - index - 1) * sizeof *f->entries);
  f->len--;
}

static bool scr_formdata_name_is(const ScrStr *name, const ScrStr *other) {
  return name == other || (name->len == other->len && !memcmp(name->data, other->data, name->len));
}

/* ── Node's conversions and errors ───────────────────────────────────── */

/* USVString: ToString, then lone surrogates replaced (+1). */
static ScrStr *scr_formdata_usv(const ScrDyn *value) {
  ScrStr *text = scr_dyn_string_coerce_js(value);
  if (!text) return NULL;
  ScrStr *well = scr_str_to_well_formed(text);
  scr_str_release(text);
  return well;
}

/* growable text buffer, shared by the error texts and the multipart body */
typedef struct ScrFdBuf {
  uint8_t *data;
  size_t len, cap;
} ScrFdBuf;

static void scr_fd_buf_add(ScrFdBuf *b, const void *bytes, size_t len) {
  if (b->len + len > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->len + len) cap *= 2;
    uint8_t *grown = realloc(b->data, cap);
    if (!grown) scr_trap("scriptc: out of memory\n");
    b->data = grown;
    b->cap = cap;
  }
  if (len) memcpy(b->data + b->len, bytes, len);
  b->len += len;
}

static void scr_fd_buf_puts(ScrFdBuf *b, const char *text) { scr_fd_buf_add(b, text, strlen(text)); }

/* webidl.util.Stringify: the value as Node's error text spells it.
 * Non-primitives answer false, so the caller refuses by name instead of
 * printing a shape its inspector (a gated unit) would have to produce. */
static bool scr_formdata_stringify(ScrFdBuf *b, const ScrDyn *value) {
  switch (value->kind) {
    case SCR_DYN_STR:
      scr_fd_buf_puts(b, "\"");
      scr_fd_buf_add(b, value->v.str->data, value->v.str->len);
      scr_fd_buf_puts(b, "\"");
      return true;
    case SCR_DYN_NUM: {
      ScrStr *text = scr_num_to_string_radix_f64(value->v.num, 10);
      scr_fd_buf_add(b, text->data, text->len);
      scr_str_release(text);
      return true;
    }
    case SCR_DYN_BOOL:
      scr_fd_buf_puts(b, value->v.b ? "true" : "false");
      return true;
    case SCR_DYN_NULL:
      scr_fd_buf_puts(b, "null");
      return true;
    case SCR_DYN_UNDEF:
      scr_fd_buf_puts(b, "undefined");
      return true;
    case SCR_DYN_BIGINT: {
      ScrStr *text = scr_bigint_to_string(value->v.bigint, 10);
      if (!text) return false;
      scr_fd_buf_add(b, text->data, text->len);
      scr_str_release(text);
      scr_fd_buf_puts(b, "n");
      return true;
    }
    case SCR_DYN_SYMBOL: {
      scr_fd_buf_puts(b, "Symbol(");
      ScrStr *description = value->v.symbol.description
                                ? value->v.symbol.description(value->v.symbol.value)
                                : NULL;
      if (description) {
        scr_fd_buf_add(b, description->data, description->len);
        scr_str_release(description);
      } else {
        scr_fd_buf_puts(b, "undefined");
      }
      scr_fd_buf_puts(b, ")");
      return true;
    }
    default:
      return false;
  }
}

/* undici's webidl.errors.exception: a TypeError reading "<header>: <msg>". */
static void scr_formdata_fail(const char *header, ScrFdBuf *message) {
  ScrFdBuf text = {0};
  scr_fd_buf_puts(&text, header);
  scr_fd_buf_puts(&text, ": ");
  scr_fd_buf_add(&text, message->data, message->len);
  scr_throw_error_msg(SCR_ERR_TYPE, (const char *)text.data, text.len);
  free(text.data);
  free(message->data);
}

/* webidl.argumentLengthCheck: `<min> argument[s] required, but [only] <n> found.` */
static void scr_formdata_arity_fail(const char *header, size_t min, size_t found) {
  ScrFdBuf message = {0};
  char head[64];
  snprintf(head, sizeof head, "%zu argument%s required, but", min, min == 1 ? "" : "s");
  scr_fd_buf_puts(&message, head);
  if (found) {
    snprintf(head, sizeof head, " only %zu found.", found);
  } else {
    snprintf(head, sizeof head, " %zu found.", found);
  }
  scr_fd_buf_puts(&message, head);
  scr_formdata_fail(header, &message);
}

/* The Blob interface converter's TypeError. */
static void scr_formdata_blob_fail(const char *header, const ScrDyn *value) {
  ScrFdBuf message = {0};
  scr_fd_buf_puts(&message, "Expected value (\"");
  if (scr_formdata_stringify(&message, value)) {
    scr_fd_buf_puts(&message, "\") to be an instance of Blob.");
    scr_formdata_fail(header, &message);
    return;
  }
  free(message.data);
  static const char refusal[] =
      "FormData: a non-Blob value of this kind in the expected-Blob TypeError needs util.inspect, "
      "which this program does not link";
  scr_throw_error_msg_code(SCR_ERR_ERROR, refusal, sizeof refusal - 1, "SC2020");
}

/* ── makeEntry ───────────────────────────────────────────────────────── */

/* `new File([source], name, { type })` — or, for `keep_modified`, the
 * source's type and lastModified (Node's makeEntry step 3.2). +1, or NULL
 * with the exception pending. */
static ScrDyn *scr_formdata_file_of(const ScrDyn *source, ScrStr *name, bool keep_modified) {
  ScrStr *type = scr_blob_internal_type(source);
  if (!type) return NULL;
  ScrDyn *options = scr_dyn_new_obj();
  scr_dyn_obj_set(options, "type", 4, scr_dyn_new_str(type));
  scr_str_release(type);
  if (keep_modified) {
    scr_dyn_obj_set(options, "lastModified", 12, scr_dyn_new_num(scr_blob_internal_last_modified(source)));
  }
  ScrDyn *sources = scr_dyn_new_arr();
  scr_dyn_arr_push(sources, scr_dyn_retain((ScrDyn *)source));
  ScrDyn *args = scr_dyn_new_arr();
  scr_dyn_arr_push(args, sources);
  scr_dyn_arr_push(args, scr_dyn_new_str(name));
  scr_dyn_arr_push(args, options);
  ScrDyn *file = scr_file_new(args);
  scr_dyn_release(args);
  return file;
}

/* makeEntry's value: a Blob turns into a File named "blob", then a given
 * filename (USVString, owned here) wraps it in a File that keeps the type
 * and lastModified. Answers +1, or NULL with the exception pending. */
static ScrDyn *scr_formdata_entry_value(const ScrDyn *value, ScrStr *filename) {
  ScrDyn *file = NULL;
  if (!scr_blob_is(value, 1)) {
    ScrStr *blob_name = scr_str_new("blob", 4);
    file = scr_formdata_file_of(value, blob_name, false);
    scr_str_release(blob_name);
    if (!file) return NULL;
  }
  if (filename) {
    ScrDyn *wrapped = scr_formdata_file_of(file ? file : value, filename, true);
    scr_dyn_release(file);
    return wrapped;
  }
  return file ? file : scr_dyn_retain((ScrDyn *)value);
}

/* ── methods ─────────────────────────────────────────────────────────── */

/* append and set share undici's conversion steps; `set` then replaces the
 * first matching entry and drops the rest. */
static ScrDyn *scr_formdata_add(ScrFormData *f, const char *method, ScrDyn *const *args,
                                size_t argc, bool set) {
  char header[32];
  snprintf(header, sizeof header, "FormData.%s", method);
  if (argc < 2) {
    scr_formdata_arity_fail(header, 2, argc);
    return NULL;
  }
  ScrStr *name = scr_formdata_usv(args[0]);
  if (!name) return NULL;
  /* undici: `arguments.length === 3 || webidl.is.Blob(value)` takes the
   * Blob converter, whose filename is the third argument. */
  bool blob = argc == 3 || scr_blob_is(args[1], 0);
  ScrStr *filename = NULL;
  ScrDyn *value = NULL;
  if (blob) {
    if (!scr_blob_is(args[1], 0)) {
      scr_str_release(name);
      scr_formdata_blob_fail(header, args[1]);
      return NULL;
    }
    if (argc >= 3 && args[2]->kind != SCR_DYN_UNDEF) {
      filename = scr_formdata_usv(args[2]);
      if (!filename) {
        scr_str_release(name);
        return NULL;
      }
    }
    value = scr_formdata_entry_value(args[1], filename);
  } else {
    ScrStr *text = scr_formdata_usv(args[1]);
    if (text) value = scr_dyn_new_str(text);
    scr_str_release(text);
  }
  scr_str_release(filename);
  if (!value) {
    scr_str_release(name);
    return NULL;
  }
  if (set) {
    size_t first = (size_t)-1;
    for (size_t i = 0; i < f->len;) {
      if (!scr_formdata_name_is(f->entries[i].name, name)) {
        i++;
        continue;
      }
      if (first == (size_t)-1) {
        first = i;
        i++;
        continue;
      }
      scr_formdata_remove(f, i);
    }
    if (first != (size_t)-1) {
      scr_str_release(f->entries[first].name);
      scr_dyn_release(f->entries[first].value);
      f->entries[first].name = name;
      f->entries[first].value = value;
    } else {
      scr_formdata_push(f, name, value);
    }
  } else {
    scr_formdata_push(f, name, value);
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_formdata_read(ScrFormData *f, const char *method, ScrDyn *const *args,
                                 size_t argc) {
  char header[32];
  snprintf(header, sizeof header, "FormData.%s", method);
  if (argc < 1) {
    scr_formdata_arity_fail(header, 1, argc);
    return NULL;
  }
  ScrStr *name = scr_formdata_usv(args[0]);
  if (!name) return NULL;
  ScrDyn *result = NULL;
  if (!strcmp(method, "has")) {
    bool found = false;
    for (size_t i = 0; i < f->len && !found; i++) found = scr_formdata_name_is(f->entries[i].name, name);
    result = scr_dyn_new_bool(found);
  } else if (!strcmp(method, "get")) {
    for (size_t i = 0; i < f->len; i++) {
      if (!scr_formdata_name_is(f->entries[i].name, name)) continue;
      result = scr_dyn_retain(f->entries[i].value);
      break;
    }
    if (!result) result = scr_dyn_new_null();
  } else if (!strcmp(method, "getAll")) {
    result = scr_dyn_new_arr();
    for (size_t i = 0; i < f->len; i++) {
      if (!scr_formdata_name_is(f->entries[i].name, name)) continue;
      scr_dyn_arr_push(result, scr_dyn_retain(f->entries[i].value));
    }
  } else {
    for (size_t i = 0; i < f->len;) {
      if (scr_formdata_name_is(f->entries[i].name, name)) scr_formdata_remove(f, i);
      else i++;
    }
    result = scr_dyn_retain(scr_dyn_undefined());
  }
  scr_str_release(name);
  return result;
}

/* Iterator step shared by entries(), keys(), values() and `for…of`
 * (selection 2 = [name, value], 1 = name, 0 = value). */
static ScrDyn *scr_formdata_step(void *ptr, double *index, unsigned selection) {
  ScrFormData *f = ptr;
  bool done = *index >= (double)f->len;
  ScrDyn *value = scr_dyn_retain(scr_dyn_undefined());
  if (!done) {
    ScrFormDataEntry *entry = &f->entries[(size_t)*index];
    (*index)++;
    if (selection == 2) {
      value = scr_dyn_new_arr();
      scr_dyn_arr_push(value, scr_dyn_new_str(entry->name));
      scr_dyn_arr_push(value, scr_dyn_retain(entry->value));
    } else if (selection == 1) {
      value = scr_dyn_new_str(entry->name);
    } else {
      value = scr_dyn_retain(entry->value);
    }
  }
  /* { value, done }, in the iterator result's own key order. */
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "value", 5, value);
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  return result;
}

static ScrDyn *scr_formdata_for_each(ScrFormData *f, ScrDyn *self, ScrDyn *const *args, size_t argc) {
  if (argc < 1) {
    scr_formdata_arity_fail("FormData.forEach", 1, argc);
    return NULL;
  }
  if (!scr_dyn_is_callable(args[0])) {
    static const char message[] =
        "Failed to execute 'forEach' on 'FormData': parameter 1 is not of type 'Function'.";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  /* Node's forEach walks the entry list with the iterator of entries(),
   * which reads the list and its length again at every step: an entry the
   * callback appends is visited, and one it removes moves the rest down
   * under the walk's index. */
  for (size_t i = 0; i < f->len; i++) {
    ScrFormDataEntry *entry = &f->entries[i];
    ScrDyn *argv[] = {scr_dyn_retain(entry->value), scr_dyn_new_str(entry->name), self};
    scr_dyn_this_push_dyn(argc > 1 ? args[1] : NULL);
    ScrDyn *called = scr_dyn_call(args[0], argv, 3, "callback");
    scr_dyn_this_pop();
    scr_dyn_release(called);
    scr_dyn_release(argv[0]);
    scr_dyn_release(argv[1]);
    if (scr_exc_pending()) return NULL;
  }
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_formdata_invoke(void *ptr, ScrDyn *self, const char *method, ScrDyn *const *args,
                                   size_t argc, const char *what) {
  ScrFormData *f = ptr;
  if (!strcmp(method, "entries") || !strcmp(method, "keys") || !strcmp(method, "values")) {
    return scr_dyn_native_handle_iterator(self, !strcmp(method, "entries") ? 2
                                                       : !strcmp(method, "keys") ? 1
                                                                                 : 0);
  }
  if (!strcmp(method, "forEach")) return scr_formdata_for_each(f, self, args, argc);
  if (!strcmp(method, "toString")) {
    /* Object.prototype.toString with the class's @@toStringTag. */
    ScrStr *text = scr_str_new("[object FormData]", 17);
    ScrDyn *out = scr_dyn_new_str(text);
    scr_str_release(text);
    return out;
  }
  if (!strcmp(method, "append")) return scr_formdata_add(f, method, args, argc, false);
  if (!strcmp(method, "set")) return scr_formdata_add(f, method, args, argc, true);
  if (!strcmp(method, "get") || !strcmp(method, "getAll") || !strcmp(method, "has") ||
      !strcmp(method, "delete")) {
    return scr_formdata_read(f, method, args, argc);
  }
  char message[256];
  snprintf(message, sizeof message, "%s is not a function", what);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  return NULL;
}

/* Node's [util.inspect.custom] over the entry list: duplicate names reduce
 * to an array of their values, a single name keeps its value, and the
 * truthiness test is JavaScript's (an empty string does not accumulate). */
static ScrDyn *scr_formdata_inspect_view(void *ptr) {
  ScrFormData *f = ptr;
  ScrDyn *view = scr_dyn_new_obj();
  for (size_t i = 0; i < f->len; i++) {
    ScrFormDataEntry *entry = &f->entries[i];
    const ScrDyn *existing = scr_dyn_obj_get(view, entry->name->data, entry->name->len);
    if (existing && scr_dyn_truthy(existing)) {
      ScrDyn *next;
      if (existing->kind == SCR_DYN_ARR) {
        next = scr_dyn_retain((ScrDyn *)existing);
        scr_dyn_arr_push(next, scr_dyn_retain(entry->value));
      } else {
        next = scr_dyn_new_arr();
        scr_dyn_arr_push(next, scr_dyn_retain((ScrDyn *)existing));
        scr_dyn_arr_push(next, scr_dyn_retain(entry->value));
      }
      scr_dyn_obj_set(view, entry->name->data, entry->name->len, next);
    } else {
      scr_dyn_obj_set(view, entry->name->data, entry->name->len, scr_dyn_retain(entry->value));
    }
  }
  return view;
}

/* FormData exposes no own properties: every name answers undefined (the
 * methods resolve through invoke). */
static ScrDyn *scr_formdata_get(void *ptr, const char *key, size_t key_len) {
  (void)ptr;
  (void)key;
  (void)key_len;
  return NULL;
}

static const ScrDynHandleOps scr_formdata_ops = {
    .cls = "FormData",
    .to_string_tag = "FormData",
    .retain = scr_formdata_retain_v,
    .release = scr_formdata_release_v,
    .get = scr_formdata_get,
    .invoke = scr_formdata_invoke,
    .iter_step = scr_formdata_step,
    .inspect_view = scr_formdata_inspect_view,
    .json_empty_object = true,
    /* Node's @@toStringTag is the class name itself, which the class-name
     * prefix already prints: the view is what the inspector's own
     * util.inspect call answers (URL's shape). */
    .inspect_view_nested = true,
};

static void scr_formdata_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_FORM_DATA, &scr_formdata_ops);
}

/* ── entry points ────────────────────────────────────────────────────── */

ScrDyn *scr_formdata_new(ScrDyn *args) {
  scr_formdata_install();
  size_t argc = args->kind == SCR_DYN_ARR ? args->v.arr.len : 0;
  if (argc > 0 && args->v.arr.items[0]->kind != SCR_DYN_UNDEF) {
    static const char message[] =
        "FormData constructor: Argument 1 could not be converted to: undefined.";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  ScrFormData *form = scr_formdata_alloc();
  ScrDyn *box = scr_dyn_new_handle(form, SCR_DYNH_FORM_DATA);
  scr_formdata_release_v(form); /* scr_dyn_new_handle retains its own reference */
  return box;
}

bool scr_formdata_is(const ScrDyn *value) { return scr_formdata_of(value) != NULL; }

/* ── multipart/form-data (undici extractBody) ────────────────────────── */

/* normalizeLinefeeds then escape: CRLF, lone CR and lone LF all spell
 * "%0D%0A", and a quote spells "%22". */
static void scr_fd_buf_escaped_name(ScrFdBuf *b, const ScrStr *name) {
  for (size_t i = 0; i < name->len; i++) {
    char c = name->data[i];
    if (c == '\r') {
      scr_fd_buf_puts(b, "%0D%0A");
      if (i + 1 < name->len && name->data[i + 1] == '\n') i++;
    } else if (c == '\n') {
      scr_fd_buf_puts(b, "%0D%0A");
    } else if (c == '"') {
      scr_fd_buf_puts(b, "%22");
    } else {
      scr_fd_buf_add(b, &c, 1);
    }
  }
}

/* escape only (the filename takes no linefeed normalization). */
static void scr_fd_buf_escaped(ScrFdBuf *b, const ScrStr *text) {
  for (size_t i = 0; i < text->len; i++) {
    char c = text->data[i];
    if (c == '\r') scr_fd_buf_puts(b, "%0D");
    else if (c == '\n') scr_fd_buf_puts(b, "%0A");
    else if (c == '"') scr_fd_buf_puts(b, "%22");
    else scr_fd_buf_add(b, &c, 1);
  }
}

static void scr_fd_buf_linefeeds(ScrFdBuf *b, const ScrStr *text) {
  for (size_t i = 0; i < text->len; i++) {
    char c = text->data[i];
    if (c == '\r') {
      scr_fd_buf_puts(b, "\r\n");
      if (i + 1 < text->len && text->data[i + 1] == '\n') i++;
    } else if (c == '\n') {
      scr_fd_buf_puts(b, "\r\n");
    } else {
      scr_fd_buf_add(b, &c, 1);
    }
  }
}

/* `----formdata-undici-0` + 11 random decimal digits, as undici's
 * `random(1e11)` padded to 11. */
static void scr_fd_buf_boundary(ScrFdBuf *b) {
  double pick = floor(scr_math_random() * 1e11);
  char digits[32];
  if (!(pick >= 0)) pick = 0;
  snprintf(digits, sizeof digits, "%.0f", pick);
  scr_fd_buf_puts(b, "----formdata-undici-0");
  for (size_t pad = strlen(digits); pad < 11; pad++) scr_fd_buf_puts(b, "0");
  scr_fd_buf_puts(b, digits);
}

static void scr_formdata_serialize(const ScrFormData *f, ScrFdBuf *out, ScrFdBuf *boundary) {
  scr_fd_buf_boundary(boundary);
  for (size_t i = 0; i < f->len; i++) {
    const ScrFormDataEntry *entry = &f->entries[i];
    scr_fd_buf_puts(out, "--");
    scr_fd_buf_add(out, boundary->data, boundary->len);
    scr_fd_buf_puts(out, "\r\nContent-Disposition: form-data; name=\"");
    scr_fd_buf_escaped_name(out, entry->name);
    if (entry->value->kind == SCR_DYN_STR) {
      scr_fd_buf_puts(out, "\"\r\n\r\n");
      scr_fd_buf_linefeeds(out, entry->value->v.str);
      scr_fd_buf_puts(out, "\r\n");
      continue;
    }
    scr_fd_buf_puts(out, "\"");
    ScrStr *name = scr_blob_internal_file_name(entry->value);
    if (name && name->len) {
      scr_fd_buf_puts(out, "; filename=\"");
      scr_fd_buf_escaped(out, name);
      scr_fd_buf_puts(out, "\"");
    }
    scr_str_release(name);
    ScrBytes *bytes = NULL;
    ScrStr *type = NULL;
    if (!scr_blob_body_info(entry->value, &bytes, &type)) {
      /* Every entry value is a File the constructor made; a value this
       * unit cannot read is an internal error, and the body is empty. */
      scr_fd_buf_puts(out, "\r\nContent-Type: application/octet-stream\r\n\r\n\r\n");
      continue;
    }
    scr_fd_buf_puts(out, "\r\nContent-Type: ");
    if (type->len) scr_fd_buf_add(out, type->data, type->len);
    else scr_fd_buf_puts(out, "application/octet-stream");
    scr_fd_buf_puts(out, "\r\n\r\n");
    scr_fd_buf_add(out, bytes->data, bytes->len);
    scr_fd_buf_puts(out, "\r\n");
    scr_str_release(type);
    scr_bytes_release(bytes);
  }
  scr_fd_buf_puts(out, "--");
  scr_fd_buf_add(out, boundary->data, boundary->len);
  scr_fd_buf_puts(out, "--\r\n");
}

bool scr_formdata_multipart(const ScrDyn *value, ScrBytes **bytes, ScrStr **type) {
  ScrFormData *f = scr_formdata_of(value);
  if (!f) return false;
  ScrFdBuf out = {0}, boundary = {0};
  scr_formdata_serialize(f, &out, &boundary);
  ScrBytes *body = scr_bytes_new(SCR_BYTES_U8, (double)out.len);
  if (out.len) memcpy(body->data, out.data, out.len);
  free(out.data);
  ScrFdBuf kind = {0};
  scr_fd_buf_puts(&kind, "multipart/form-data; boundary=");
  scr_fd_buf_add(&kind, boundary.data, boundary.len);
  free(boundary.data);
  ScrStr *content_type = scr_str_new((const char *)kind.data, kind.len);
  free(kind.data);
  *bytes = body;
  *type = content_type;
  return true;
}
