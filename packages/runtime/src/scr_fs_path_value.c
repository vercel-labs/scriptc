/* fs — an untyped path argument of a synchronous fs function (JavaScript
 * sources: dyn.validateFsPath).
 *
 * A separate runtime unit, selected only by programs that pass an untyped
 * value as such a path, so no other executable changes: a function added to
 * a unit other programs link renumbers the constant-pool labels of that
 * unit's later functions, which the linker carries into their symbol
 * tables. */
#include "scr_runtime.h"

/* getValidatedPath(value, name): the path (+1) of a string, a URL or a
 * Uint8Array, or NULL with Node's ERR_INVALID_ARG_TYPE pending under
 * `name`. readFileSync, writeFileSync and appendFileSync (`descriptor`)
 * first ask whether the value is a file descriptor
 * (`value === (value | 0)`), which converts it to a number: a symbol throws
 * there, and an object's own conversion runs. Borrows both. */
ScrStr *scr_value_fs_path(const ScrDyn *value, ScrStr *name, bool descriptor) {
  if (value->kind == SCR_DYN_STR) return scr_str_retain(value->v.str);
  if (scr_dyn_native_url_is(value)) return scr_url_to_path(value->v.handle.ptr);
  if (value->kind == SCR_DYN_BYTES && value->v.bytes->elem == SCR_BYTES_U8 &&
      !value->v.bytes->is_data_view) {
    /* A Uint8Array's bytes are the path (a DataView is not a Uint8Array to
     * Node's check, so it takes the type error below). Node hands the bytes
     * to the system as they are; a path here is UTF-8 text, and decoding
     * other bytes would name a different file, so they keep a named
     * refusal. */
    if (!scr_buffer_is_utf8(value)) {
      static const char message[] =
          "A path given as bytes that are not UTF-8 text is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrStr *path = scr_bytes_to_str(value->v.bytes, utf8);
    scr_str_release(utf8);
    return path;
  }
  if (descriptor) {
    if (value->kind == SCR_DYN_NUM || value->kind == SCR_DYN_BIGINT) {
      /* Node reads a number as a descriptor, and a BigInt fails its test
       * with a message of its own; the descriptor forms compile only from
       * a statically typed number. */
      static const char message[] =
          "A file descriptor passed through an untyped value is not supported yet";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
    double ignored;
    if (!scr_dyn_number_coerce_js(value, &ignored)) return NULL;
  }
  scr_dyn_arg_type_fail(name->data, "of type string or an instance of Buffer or URL", value);
  return NULL;
}
