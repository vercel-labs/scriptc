/* The kept-source read of a record→record conversion
 * (record-sources.ts carryAbsentFieldsFromSource): a target field the source
 * type does not declare answers the key the source object carries, as Node
 * does when it erases the assertion.
 *
 * The read is its own unit rather than a scr_json.c entry point so that a
 * program which never projects a record links neither it nor its call into
 * the object model: the compiler emits scr_record_source_get only for such a
 * projection, and the archive member is pulled in by that reference alone. A
 * program that only casts records keeps scr_json.o's default object — and
 * every other unit's — byte for byte. */
#include "scr_record_source_get.h"

ScrDyn *scr_record_source_get(const void *rec, const char *key, size_t key_len) {
  const ScrDyn *view = scr_record_source_view(rec);
  if (view == NULL || view->kind != SCR_DYN_OBJ) return scr_dyn_retain(scr_dyn_undefined());
  /* The view holds the source's own properties, in source order, and links
   * no prototype (scr_dyn_new_obj): this read answers an own key or
   * undefined, and an accessor runs with the view as its receiver. */
  return scr_dyn_obj_read(view, key, key_len);
}
