/* WHATWG TextEncoder and TextDecoder instances, and node:string_decoder
 * StringDecoder instances, as checked-dynamic values (SCR_DYNH_TEXT_ENCODER,
 * SCR_DYNH_TEXT_DECODER, SCR_DYNH_STRING_DECODER). A codec is a compiled
 * record (type-mapper.ts): the handle holds that record by reference, so
 * a codec stored in an untyped slot and read back keeps its identity and
 * a decoder keeps its streaming state. The compiler passes the record's
 * reference-count entry points and, for a TextDecoder, the byte offsets of the
 * encoding, fatal, ignoreBOM and state fields when it boxes one. A unit
 * of its own so programs that never box a codec link none of it
 * (native-toolchain gating: the textCodecDyn runtime feature). */
#include "scr_platform.h"
#include "scr_runtime.h"

#include <string.h>

typedef struct {
  void *(*retain)(void *);
  void (*release)(void *);
  size_t encoding, fatal, ignore_bom, state;
} ScrTextCodecLayout;

/* A program has one record shape per codec class, so one layout each. */
static SCR_TL ScrTextCodecLayout scr_tcd_encoder_layout, scr_tcd_decoder_layout;

static void *scr_tcd_encoder_retain(void *rec) { return scr_tcd_encoder_layout.retain(rec); }
static void scr_tcd_encoder_release(void *rec) { scr_tcd_encoder_layout.release(rec); }
static void *scr_tcd_decoder_retain(void *rec) { return scr_tcd_decoder_layout.retain(rec); }
static void scr_tcd_decoder_release(void *rec) { scr_tcd_decoder_layout.release(rec); }

static void scr_tcd_codec_not_a_function(const char *what) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

/* Boxes an owned string (+1 box; the string's reference moves in). */
static ScrDyn *scr_tcd_str(ScrStr *text) {
  ScrDyn *boxed = scr_dyn_new_str(text);
  scr_str_release(text);
  return boxed;
}

static ScrDyn *scr_tcd_codec_arg(ScrDyn *const *args, size_t argc, size_t index) {
  return index < argc ? args[index] : scr_dyn_undefined();
}

static double scr_tcd_decoder_encoding(const void *rec) {
  double encoding;
  memcpy(&encoding, (const char *)rec + scr_tcd_decoder_layout.encoding, sizeof encoding);
  return encoding;
}

static bool scr_tcd_decoder_flag(const void *rec, size_t offset) {
  return ((const unsigned char *)rec)[offset] != 0;
}

static ScrDyn *scr_tcd_encoder_invoke(void *rec, ScrDyn *self, const char *method,
                                       ScrDyn *const *args, size_t argc, const char *what) {
  (void)rec;
  (void)self;
  if (strcmp(method, "encode") == 0) {
    /* encode(input = ""): any other input converts with ToString. */
    ScrDyn *input = scr_tcd_codec_arg(args, argc, 0);
    ScrStr *text =
        input->kind == SCR_DYN_UNDEF ? scr_str_new("", 0) : scr_dyn_string_coerce_js(input);
    if (!text) return NULL;
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *bytes = scr_bytes_from_str(text, utf8);
    scr_str_release(utf8);
    scr_str_release(text);
    /* A fresh Uint8Array, not a Buffer. */
    bytes->is_buffer = false;
    ScrDyn *result = scr_dyn_new_bytes(bytes);
    scr_bytes_release(bytes);
    return result;
  }
  if (strcmp(method, "encodeInto") == 0)
    return scr_text_encode_into(scr_tcd_codec_arg(args, argc, 0),
                                scr_tcd_codec_arg(args, argc, 1));
  scr_tcd_codec_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_tcd_encoder_get(void *rec, const char *key, size_t len) {
  (void)rec;
  if (len == 8 && memcmp(key, "encoding", 8) == 0) return scr_tcd_str(scr_str_new("utf-8", 5));
  return NULL;
}

/* decode(input, options): the options object's `stream` member, read
 * with JS truthiness; undefined and null mean no options. */
static bool scr_tcd_decoder_stream_option(const ScrDyn *options, bool *stream) {
  *stream = false;
  if (options->kind == SCR_DYN_UNDEF || options->kind == SCR_DYN_NULL) return true;
  if (options->kind != SCR_DYN_OBJ && options->kind != SCR_DYN_ARR &&
      options->kind != SCR_DYN_FUNC && options->kind != SCR_DYN_TYPED_REF &&
      options->kind != SCR_DYN_HANDLE) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return false;
  }
  ScrDyn *value = scr_dyn_obj_read(options, "stream", 6);
  if (!value) return false;
  *stream = scr_dyn_truthy(value);
  scr_dyn_release(value);
  return !scr_exc_pending();
}

static ScrDyn *scr_tcd_decoder_invoke(void *rec, ScrDyn *self, const char *method,
                                       ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  if (strcmp(method, "decode") != 0) {
    scr_tcd_codec_not_a_function(what);
    return NULL;
  }
  ScrBytes *input = scr_bytes_buffer_source(scr_tcd_codec_arg(args, argc, 0));
  if (!input) return NULL;
  bool stream;
  if (!scr_tcd_decoder_stream_option(scr_tcd_codec_arg(args, argc, 1), &stream)) {
    scr_bytes_release(input);
    return NULL;
  }
  const ScrTextCodecLayout *layout = &scr_tcd_decoder_layout;
  ScrDyn *state;
  memcpy(&state, (const char *)rec + layout->state, sizeof state);
  ScrStr *text = scr_text_decode_stream(state, input, scr_tcd_decoder_encoding(rec),
                                        scr_tcd_decoder_flag(rec, layout->fatal),
                                        scr_tcd_decoder_flag(rec, layout->ignore_bom), stream);
  scr_bytes_release(input);
  return text ? scr_tcd_str(text) : NULL;
}

static ScrDyn *scr_tcd_decoder_get(void *rec, const char *key, size_t len) {
  if (len == 8 && memcmp(key, "encoding", 8) == 0)
    return scr_tcd_str(scr_text_decoder_name(scr_tcd_decoder_encoding(rec)));
  if (len == 5 && memcmp(key, "fatal", 5) == 0)
    return scr_dyn_new_bool(scr_tcd_decoder_flag(rec, scr_tcd_decoder_layout.fatal));
  if (len == 9 && memcmp(key, "ignoreBOM", 9) == 0)
    return scr_dyn_new_bool(scr_tcd_decoder_flag(rec, scr_tcd_decoder_layout.ignore_bom));
  return NULL;
}

static bool scr_tcd_codec_set(void *rec, const char *key, size_t len, const ScrDyn *value) {
  (void)rec;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static const ScrDynHandleMethod scr_tcd_encoder_methods[] = {
    {.name = "encode", .length = 0},
    {.name = "encodeInto", .length = 2},
    {.name = NULL},
};

static const ScrDynHandleMethod scr_tcd_decoder_methods[] = {
    {.name = "decode", .length = 0},
    {.name = NULL},
};

static const ScrDynHandleOps scr_tcd_encoder_ops = {
    .cls = "TextEncoder",
    .to_string_tag = "TextEncoder",
    .retain = scr_tcd_encoder_retain,
    .release = scr_tcd_encoder_release,
    .invoke = scr_tcd_encoder_invoke,
    .get = scr_tcd_encoder_get,
    .set = scr_tcd_codec_set,
    .json_empty_object = true,
    .methods = scr_tcd_encoder_methods,
    .invalid_this = "Value of \"this\" must be of type TextEncoder",
};

static const ScrDynHandleOps scr_tcd_decoder_ops = {
    .cls = "TextDecoder",
    .to_string_tag = "TextDecoder",
    .retain = scr_tcd_decoder_retain,
    .release = scr_tcd_decoder_release,
    .invoke = scr_tcd_decoder_invoke,
    .get = scr_tcd_decoder_get,
    .set = scr_tcd_codec_set,
    .json_empty_object = true,
    .methods = scr_tcd_decoder_methods,
    .invalid_this = "Value of \"this\" must be of type TextDecoder",
};

ScrDyn *scr_text_encoder_to_dyn(void *rec, void *(*retain)(void *), void (*release)(void *)) {
  if (!scr_tcd_encoder_layout.retain) {
    scr_tcd_encoder_layout.retain = retain;
    scr_tcd_encoder_layout.release = release;
    scr_dyn_handle_install(SCR_DYNH_TEXT_ENCODER, &scr_tcd_encoder_ops);
  }
  return scr_dyn_new_handle(rec, SCR_DYNH_TEXT_ENCODER);
}

ScrDyn *scr_text_decoder_to_dyn(void *rec, void *(*retain)(void *), void (*release)(void *),
                                size_t encoding, size_t fatal, size_t ignore_bom, size_t state) {
  if (!scr_tcd_decoder_layout.retain) {
    scr_tcd_decoder_layout = (ScrTextCodecLayout){retain, release, encoding, fatal, ignore_bom, state};
    scr_dyn_handle_install(SCR_DYNH_TEXT_DECODER, &scr_tcd_decoder_ops);
  }
  return scr_dyn_new_handle(rec, SCR_DYNH_TEXT_DECODER);
}

void *scr_text_codec_from_dyn(const ScrDyn *d, bool decoder, const ScrDynPath *path,
                              const char *want) {
  return scr_dyn_handle_unbox(d, decoder ? SCR_DYNH_TEXT_DECODER : SCR_DYNH_TEXT_ENCODER, path,
                              want);
}

bool scr_text_codec_is(const ScrDyn *d, bool decoder) {
  return d->kind == SCR_DYN_HANDLE &&
         d->v.handle.tag == (decoder ? SCR_DYNH_TEXT_DECODER : SCR_DYNH_TEXT_ENCODER);
}

/* node:string_decoder StringDecoder instances (SCR_DYNH_STRING_DECODER).
 * The decoder is a compiled record of its canonical encoding (a string)
 * and its pending partial sequence (an f64 packing, scr_bytes.c's
 * scr_strdec_* helpers); the compiler passes both fields' byte offsets
 * when it boxes one. */
typedef struct {
  void *(*retain)(void *);
  void (*release)(void *);
  size_t encoding, pending;
} ScrStringDecoderLayout;

static SCR_TL ScrStringDecoderLayout scr_sdd_layout;

static void *scr_sdd_retain(void *rec) { return scr_sdd_layout.retain(rec); }
static void scr_sdd_release(void *rec) { scr_sdd_layout.release(rec); }

static ScrStr *scr_sdd_encoding(const void *rec) {
  ScrStr *encoding;
  memcpy(&encoding, (const char *)rec + scr_sdd_layout.encoding, sizeof encoding);
  return encoding;
}

static double scr_sdd_pending(const void *rec) {
  double pending;
  memcpy(&pending, (const char *)rec + scr_sdd_layout.pending, sizeof pending);
  return pending;
}

static void scr_sdd_set_pending(void *rec, double pending) {
  memcpy((char *)rec + scr_sdd_layout.pending, &pending, sizeof pending);
}

/* write(buf): a string answers itself; an ArrayBuffer view decodes with
 * the pending bytes before it; other values throw Node's
 * ERR_INVALID_ARG_TYPE. +1 or NULL. */
static ScrStr *scr_sdd_write(void *rec, const ScrDyn *buf) {
  if (buf->kind == SCR_DYN_STR) return scr_str_retain(buf->v.str);
  if (buf->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("buf", "an instance of Buffer, TypedArray, or DataView", buf);
    return NULL;
  }
  ScrBytes *bytes = scr_bytes_raw_view(buf->v.bytes);
  ScrStr *encoding = scr_sdd_encoding(rec);
  double pending = scr_sdd_pending(rec);
  ScrStr *text = scr_strdec_write(encoding, pending, bytes);
  scr_sdd_set_pending(rec, scr_strdec_next(encoding, pending, bytes));
  scr_bytes_release(bytes);
  return text;
}

static ScrDyn *scr_sdd_invoke(void *rec, ScrDyn *self, const char *method, ScrDyn *const *args,
                              size_t argc, const char *what) {
  (void)self;
  ScrDyn *buf = scr_tcd_codec_arg(args, argc, 0);
  if (strcmp(method, "write") == 0) {
    ScrStr *text = scr_sdd_write(rec, buf);
    return text ? scr_tcd_str(text) : NULL;
  }
  if (strcmp(method, "end") == 0) {
    /* end(buf): write(buf) when buf is not undefined, then the pending
     * bytes' replacement text. */
    ScrStr *head = buf->kind == SCR_DYN_UNDEF ? scr_str_new("", 0) : scr_sdd_write(rec, buf);
    if (!head) return NULL;
    ScrStr *tail = scr_strdec_end(scr_sdd_encoding(rec), scr_sdd_pending(rec));
    scr_sdd_set_pending(rec, 0);
    ScrStr *text = scr_str_concat(head, tail);
    scr_str_release(head);
    scr_str_release(tail);
    return scr_tcd_str(text);
  }
  if (strcmp(method, "text") == 0) {
    static const char message[] = "StringDecoder.prototype.text is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  scr_tcd_codec_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_sdd_get(void *rec, const char *key, size_t len) {
  if (len == 8 && memcmp(key, "encoding", 8) == 0)
    return scr_dyn_new_str(scr_sdd_encoding(rec));
  if ((len == 8 && memcmp(key, "lastChar", 8) == 0) ||
      (len == 8 && memcmp(key, "lastNeed", 8) == 0) ||
      (len == 9 && memcmp(key, "lastTotal", 9) == 0)) {
    static const char message[] = "StringDecoder lastChar, lastNeed and lastTotal are not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  return NULL;
}

static const ScrDynHandleMethod scr_sdd_methods[] = {
    {.name = "write", .length = 1},
    {.name = "end", .length = 1},
    {.name = "text", .length = 2},
    {.name = NULL},
};

static const ScrDynHandleOps scr_sdd_ops = {
    .cls = "StringDecoder",
    .retain = scr_sdd_retain,
    .release = scr_sdd_release,
    .invoke = scr_sdd_invoke,
    .get = scr_sdd_get,
    .set = scr_tcd_codec_set,
    .methods = scr_sdd_methods,
};

ScrDyn *scr_string_decoder_to_dyn(void *rec, void *(*retain)(void *), void (*release)(void *),
                                  size_t encoding, size_t pending) {
  if (!scr_sdd_layout.retain) {
    scr_sdd_layout = (ScrStringDecoderLayout){retain, release, encoding, pending};
    scr_dyn_handle_install(SCR_DYNH_STRING_DECODER, &scr_sdd_ops);
  }
  return scr_dyn_new_handle(rec, SCR_DYNH_STRING_DECODER);
}

void *scr_string_decoder_from_dyn(const ScrDyn *d, const ScrDynPath *path, const char *want) {
  return scr_dyn_handle_unbox(d, SCR_DYNH_STRING_DECODER, path, want);
}
