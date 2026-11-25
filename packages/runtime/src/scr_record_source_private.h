/* The kept-source table's entry layout, for the gated units that add
 * table operations.
 *
 * scr_json.c owns the table (the undeclared properties of checked records
 * and the entries of record views, described there) and every entry point
 * compiled programs call today. That unit is linked by most programs, and
 * any edit to it moves its object in all of them, so an operation only some
 * programs call belongs in a unit of its own, selected by its library
 * function. Such a unit needs the table's entries, which were private to
 * scr_json.c: this header holds the entry type both sides share, and
 * scr_record_source_entry is the one lookup scr_json.c exports for them.
 * Nothing outside scr_json.c and those units includes it.
 */
#ifndef SCR_RECORD_SOURCE_PRIVATE_H
#define SCR_RECORD_SOURCE_PRIVATE_H

#include "scr_runtime.h"
#include <string.h>

typedef struct {
  void *rec;
  ScrDyn *view;
  /* The shape's declared names in declaration order, as static strided
   * tables: the compiler's name/length arrays, or a JSON schema's fields. */
  const char *names;
  const char *lens;
  size_t name_stride, len_stride, count;
  /* A record view (scr_dyn_record_view) has an entry with no view and
   * this: the capsule of the record it views (+1). Boxing the view answers
   * that capsule (scr_dyn_typed_ref_new), and the view type's reflective
   * surfaces go through it (scr_record_source_has). NULL for an ordinary
   * source. */
  ScrDyn *capsule;
  /* A view's record (borrowed: the capsule holds it) and its byte offsets
   * for the view type's fields. */
  void *viewed;
  const size_t *offsets;
  /* The view holds properties a partial view's writes added, in the order
   * the writes happened; reflection and serialization answer them after the
   * record's own keys. */
  bool extras;
} ScrRecordSource;

/* The table entry of `rec`, or NULL. A record that kept a source has an
 * entry with no `capsule`; a record view's entry has one, and names the
 * record it views in `viewed`, whose own entry (if any) holds the
 * properties. Borrowed: an insertion or a free can move or drop it. */
ScrRecordSource *scr_record_source_entry(const void *rec);

/* The key's position in the shape's declaration order, or count. */
__attribute__((unused)) static size_t scr_record_source_index(
    const ScrRecordSource *source, const char *key, size_t key_len) {
  for (size_t i = 0; i < source->count; i++) {
    size_t len;
    memcpy(&len, source->lens + i * source->len_stride, sizeof len);
    if (len != key_len) continue;
    const char *name;
    memcpy(&name, source->names + i * source->name_stride, sizeof name);
    if (memcmp(name, key, key_len) == 0) return i;
  }
  return source->count;
}

__attribute__((unused)) static bool scr_record_source_declared(
    const ScrRecordSource *source, const char *key, size_t key_len) {
  return scr_record_source_index(source, key, key_len) < source->count;
}

#endif
