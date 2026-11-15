/* The kept-source read of a record→record conversion
 * (record-sources.ts carryAbsentFieldsFromSource): a target field the source
 * type does not declare answers the key the source object carries, as Node
 * does when it erases the assertion.
 *
 * The read is a unit of its own rather than a scr_json.c entry point so that
 * a program which never projects a record links nothing of it: the compiler
 * emits scr_record_source_get only for such a projection, and that libCall is
 * the unit's link switch (runtime-pack-matrix OPTIONAL_RUNTIME_SOURCES,
 * feature recordSourceGet; the from-source lane's RUNTIME_UNITS and the
 * library archive gate on the same fact). A program that only casts records
 * keeps scr_json.o's default object — and every other unit — byte for byte. */
#include "scr_record_source_get.h"

ScrDyn *scr_record_source_get(const void *rec, const char *key, size_t key_len) {
  const ScrDyn *view = scr_record_source_view(rec);
  if (view == NULL || view->kind != SCR_DYN_OBJ) return scr_dyn_retain(scr_dyn_undefined());
  /* The view holds the source's own properties, in source order, and links
   * no prototype (scr_dyn_new_obj): this read answers an own key or
   * undefined, and an accessor runs with the view as its receiver. */
  return scr_dyn_obj_read(view, key, key_len);
}

bool scr_record_source_has_key(const void *rec, const char *key, size_t key_len) {
  const ScrDyn *view = scr_record_source_view(rec);
  if (view == NULL || view->kind != SCR_DYN_OBJ) return false;
  /* Own-ness only: the view links no prototype, and a key the source lacks
   * must leave the converted field absent rather than hold undefined. */
  ScrStr *name = scr_str_new(key, key_len);
  bool present = scr_dyn_has_own(view, name);
  scr_str_release(name);
  return present;
}
