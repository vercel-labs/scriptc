/* Argument and result handling shared by the checked-dynamic node:crypto
 * key-exchange handles (scr_ecdh.c and scr_dh.c), as Node 24's
 * lib/internal/crypto/diffiehellman.js and lib/internal/crypto/util.js
 * read keys and encodings: getArrayBufferOrView for key inputs and
 * encode() for Buffer results. `subject` names the value in the coded
 * SC2020 error for encodings that have no lowering ("An ECDH encoding or
 * format"). All arguments are borrowed. */
#ifndef SCR_CRYPTO_ARGS_H
#define SCR_CRYPTO_ARGS_H

#include "scr_runtime.h"

#include <string.h>

/* An object's toString the program defined, as an own or inherited
 * function property. */
static bool ca_custom_to_string(ScrDyn *value) {
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_TYPED_REF) return false;
  ScrDyn *member = scr_dyn_obj_read(value, "toString", 8);
  bool custom = member && member->kind == SCR_DYN_FUNC;
  scr_dyn_release(member);
  return custom;
}

/* Whether value is a class instance whose class defines toString. */
static bool ca_class_to_string(const ScrDyn *value) {
  ScrStr *name = scr_str_new("toString", 8);
  bool method = scr_dyn_typed_ref_class_has(value, name);
  scr_str_release(name);
  return method;
}

/* `prefix` and the value as util.format's %s renders it: strings and
 * objects with a program-defined toString as String(value), numbers as
 * util.inspect does, other values inspected at depth 0. Functions and
 * class instances that define toString have no lowering. */
static void ca_throw_formatted(const char *subject, const char *code, const char *prefix, const ScrDyn *value) {
  ScrDyn *v = (ScrDyn *)value;
  if (v->kind == SCR_DYN_FUNC || ca_class_to_string(v)) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, subject);
    scr_jb_puts(&b, " that is a function or an instance of a class defining toString has no lowering; "
                    "pass the name as a string");
    ScrStr *message = scr_jb_finish(&b);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
    scr_str_release(message);
    return;
  }
  ScrStr *text;
  if (v->kind == SCR_DYN_STR || ca_custom_to_string(v)) text = scr_dyn_string_coerce_js(v);
  else if (v->kind == SCR_DYN_NUM) text = scr_insp_f64(v->v.num);
  else text = scr_insp_dyn_s(v, 0);
  if (!text) return;
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, prefix);
  scr_jb_put_str(&b, text);
  scr_str_release(text);
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, code);
  scr_str_release(message);
}

static bool ca_ascii_eq_ci(const char *a, size_t a_len, const char *b) {
  size_t b_len = strlen(b);
  if (a_len != b_len) return false;
  for (size_t i = 0; i < a_len; i++) {
    char x = a[i];
    if (x >= 'A' && x <= 'Z') x = (char)(x - 'A' + 'a');
    if (x != b[i]) return false;
  }
  return true;
}

static bool ca_str_is(const ScrStr *text, const char *literal) {
  size_t len = strlen(literal);
  return text->len == len && memcmp(text->data, literal, len) == 0;
}

/* Node's normalizeEncoding: the canonical name, or NULL. */
static const char *ca_normalize_encoding(const ScrStr *name) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"},       {"utf-8", "utf8"},          {"hex", "hex"},
    {"base64", "base64"},   {"base64url", "base64url"}, {"latin1", "latin1"},
    {"binary", "latin1"},   {"ascii", "ascii"},         {"utf16le", "utf16le"},
    {"utf-16le", "utf16le"}, {"ucs2", "utf16le"},       {"ucs-2", "utf16le"},
  };
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++)
    if (ca_ascii_eq_ci(name->data, name->len, map[i].from)) return map[i].to;
  return NULL;
}

/* The value a typed-ref box holds when it is a string, view, ArrayBuffer
 * or native handle (+1). Other values are retained as passed, so argument
 * errors describe the original value. NULL after throwing. */
static ScrDyn *ca_unbox(ScrDyn *value) {
  if (value->kind != SCR_DYN_TYPED_REF) return scr_dyn_retain(value);
  ScrDyn *view = scr_dyn_typed_ref_materialize(value);
  if (!view) return NULL;
  if (view->kind == SCR_DYN_STR || view->kind == SCR_DYN_BYTES || view->kind == SCR_DYN_HANDLE ||
      scr_buffer_storage_is(view))
    return view;
  scr_dyn_release(view);
  return scr_dyn_retain(value);
}

/* Buffer.from(text, encoding) as toBuf calls it: an encoding that is not
 * a non-empty string, or is 'buffer', reads as utf8. +1 or NULL after
 * throwing. */
static ScrBytes *ca_string_bytes(const char *subject, const ScrStr *text, const ScrDyn *encoding) {
  const char *name = "utf8";
  if (encoding->kind == SCR_DYN_STR && encoding->v.str->len > 0 && !ca_str_is(encoding->v.str, "buffer")) {
    name = ca_normalize_encoding(encoding->v.str);
    if (!name) {
      ca_throw_formatted(subject, "ERR_UNKNOWN_ENCODING", "Unknown encoding: ", encoding);
      return NULL;
    }
  }
  ScrStr *canonical = scr_str_new(name, strlen(name));
  ScrBytes *bytes = scr_bytes_from_str(text, canonical);
  scr_str_release(canonical);
  return bytes;
}

/* getArrayBufferOrView(key, 'key', encoding): a string is Buffer.from(key,
 * encoding) with 'buffer' read as utf8; views and ArrayBuffers are their
 * bytes. +1 or NULL after throwing. */
static ScrBytes *ca_key_bytes(const char *subject, const ScrDyn *key, const ScrDyn *encoding) {
  if (key->kind == SCR_DYN_STR) return ca_string_bytes(subject, key->v.str, encoding);
  if (key->kind == SCR_DYN_BYTES || scr_buffer_storage_is(key)) return scr_bytes_buffer_source(key);
  scr_dyn_arg_type_fail("key", "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", key);
  return NULL;
}

/* encode(buffer, encoding): the Buffer, or buffer.toString(encoding) for
 * a truthy encoding other than 'buffer'. Consumes bytes. */
static ScrDyn *ca_encode(const char *subject, ScrBytes *bytes, const ScrDyn *encoding) {
  if (!scr_dyn_truthy(encoding) || (encoding->kind == SCR_DYN_STR && ca_str_is(encoding->v.str, "buffer"))) {
    ScrDyn *result = scr_dyn_new_buffer(bytes);
    scr_bytes_release(bytes);
    return result;
  }
  /* toString answers "" for no bytes before it reads the encoding. */
  ScrStr *text = NULL;
  if (bytes->len == 0) {
    text = scr_str_new("", 0);
  } else {
    /* getEncodingOps reads `encoding + ''`. */
    ScrStr *name = encoding->kind == SCR_DYN_STR ? scr_str_retain(encoding->v.str) : NULL;
    if (!name) {
      if (encoding->kind == SCR_DYN_FUNC || ca_class_to_string(encoding)) {
        ca_throw_formatted(subject, "ERR_UNKNOWN_ENCODING", "Unknown encoding: ", encoding);
        scr_bytes_release(bytes);
        return NULL;
      }
      name = scr_dyn_string_coerce_js(encoding);
      if (!name) {
        scr_bytes_release(bytes);
        return NULL;
      }
    }
    const char *canonical = ca_normalize_encoding(name);
    scr_str_release(name);
    if (!canonical) {
      ca_throw_formatted(subject, "ERR_UNKNOWN_ENCODING", "Unknown encoding: ", encoding);
      scr_bytes_release(bytes);
      return NULL;
    }
    ScrStr *canonical_text = scr_str_new(canonical, strlen(canonical));
    text = scr_bytes_to_str(bytes, canonical_text);
    scr_str_release(canonical_text);
  }
  scr_bytes_release(bytes);
  if (!text) return NULL;
  ScrDyn *result = scr_dyn_new_str(text);
  scr_str_release(text);
  return result;
}

#endif
