/* string_decoder's checked-dynamic chunk forms.
 *
 * A stream's "data" payload crosses the checked-dynamic boundary, so
 * decoder.write and decoder.end receive it as an ScrDyn: a string passes
 * through unchanged without touching the buffered state, an ArrayBufferView
 * (Buffer, TypedArray, DataView) decodes through scr_bytes.c's per-encoding
 * helpers with the packed-f64 pending state, and anything else throws Node's
 * ERR_INVALID_ARG_TYPE for "buf". They live in their own unit because the
 * static twins in scr_bytes.c belong only to programs whose chunks are
 * already typed; those programs keep that object byte for byte. */
#include "scr_runtime.h"

/* The bytes view of a checked-dynamic write chunk, or NULL for a string
 * chunk (Node's write returns it unchanged, never touching the decoder).
 * Anything that is not a string or an ArrayBufferView throws Node's
 * ERR_INVALID_ARG_TYPE for "buf". */
static ScrBytes *scr_strdec_dyn_view(const ScrDyn *chunk, bool *is_string) {
  *is_string = chunk->kind == SCR_DYN_STR;
  if (*is_string) return NULL;
  /* A capsule answers by its materialized value: a typed array or Buffer
   * decodes, and an array or record throws as below. */
  if (chunk->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(chunk);
    if (!materialized) return NULL;
    ScrBytes *view = scr_strdec_dyn_view(materialized, is_string);
    scr_dyn_release(materialized);
    return view;
  }
  /* An ArrayBuffer or SharedArrayBuffer is not a view: Node throws. */
  if (chunk->kind == SCR_DYN_BYTES) return scr_bytes_buffer_source(chunk);
  scr_dyn_arg_type_fail("buf", "an instance of Buffer, TypedArray, or DataView", chunk);
  return NULL;
}

/* decoder.write(chunk) where the chunk crossed the checked-dynamic
 * boundary (`stream.on("data", (data) => decoder.write(data))`). */
ScrStr *scr_strdec_write_dyn(const ScrStr *enc, double pending, const ScrDyn *chunk) {
  bool is_string = false;
  ScrBytes *view = scr_strdec_dyn_view(chunk, &is_string);
  if (is_string) return scr_str_retain(chunk->v.str);
  if (!view) return NULL;
  ScrStr *out = scr_strdec_write(enc, pending, view);
  scr_bytes_release(view);
  return out;
}

/* The decoder state after that write: a string chunk leaves it alone. */
double scr_strdec_next_dyn(const ScrStr *enc, double pending, const ScrDyn *chunk) {
  bool is_string = false;
  ScrBytes *view = scr_strdec_dyn_view(chunk, &is_string);
  if (is_string) return pending;
  if (!view) return 0;
  double hold = scr_strdec_next(enc, pending, view);
  scr_bytes_release(view);
  return hold;
}
