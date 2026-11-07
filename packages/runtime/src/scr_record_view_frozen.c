/* Record views of record types whose values may also be frozen.
 *
 * A record view (scr_dyn_record_view, compiler record-views.ts) is marked by
 * the frozen bit of its rc word, which is enough while no value of the view's
 * type can be frozen. A partial record assertion (`{} as T`, completed by the
 * writes that follow) may name a type the program also freezes. A marked
 * value of such a type is then either a frozen record or a view, and the
 * record-source table tells them apart: a view has an entry that names the
 * record it views, a frozen record has none of that kind. The emitted test
 * stays the inline bit test; only a marked value asks the table, through the
 * entry points below. An unfrozen record that is no view never calls them.
 *
 * A view has no frozen state of its own. Freezing one freezes the record it
 * views, and its frozen answer is that record's, so the typed name and every
 * untyped reference agree.
 *
 * A unit of its own, selected only by programs that assert a partial record
 * literal to a freezable type: scr_json.c keeps its layout, and a program
 * without such an assertion links none of this.
 */
#include "scr_record_source_private.h"

/* The view entry of `obj`, or NULL when it is no view (a frozen record, or a
 * record that kept a source). */
static ScrRecordSource *scr_record_frozen_view_entry(const void *obj) {
  ScrRecordSource *entry = scr_record_source_entry(obj);
  return entry && entry->capsule ? entry : NULL;
}

/* Whether a marked value (frozen bit, a count, no program-lifetime bit) of a
 * freezable view target type is a view. */
bool scr_record_marked_is_view(void *obj) {
  return scr_record_frozen_view_entry(obj) != NULL;
}

/* The slot of field `position` of a marked value whose own slot is `own`:
 * the viewed record's slot for a view (NULL for a field a partial view's
 * record does not declare, as scr_record_view_slot answers), `own` for a
 * frozen record. */
void *scr_record_marked_slot(void *obj, size_t position, void *own) {
  ScrRecordSource *entry = scr_record_frozen_view_entry(obj);
  if (!entry) return own;
  size_t offset = entry->offsets[position];
  if (offset == SIZE_MAX) return NULL;
  return (char *)entry->viewed + offset;
}

/* scr_record_view_field for a freezable view target type (the unoptimized
 * builds' field address): any value of the type. */
void *scr_record_marked_field(void *value, size_t offset, size_t position) {
  size_t word = *(const size_t *)value;
#if SIZE_MAX > UINT32_MAX
  bool marked = word - SCR_RC_FROZEN < ((size_t)1 << 32);
#else
  bool marked = word - SCR_RC_FROZEN < SCR_RC_FROZEN;
#endif
  char *own = (char *)value + offset;
  return marked ? scr_record_marked_slot(value, position, own) : own;
}

/* Whether a marked value is frozen: a view answers for the record it views,
 * any other marked value is a frozen record. */
bool scr_record_marked_frozen(void *obj) {
  ScrRecordSource *entry = scr_record_frozen_view_entry(obj);
  return entry ? scr_rc_frozen(entry->viewed) : true;
}

/* Object.freeze of a value of a freezable view target type: a view freezes
 * the record it views, whose capsule freezes its untyped view when it is next
 * read (scr_dyn_typed_ref_frozen). */
void scr_record_marked_freeze(void *record) {
  if (scr_rc_frozen(record)) {
    ScrRecordSource *entry = scr_record_frozen_view_entry(record);
    if (!entry) return; /* already frozen */
    record = entry->viewed;
  }
  scr_record_freeze(record);
}

/* scr_dyn_record_view for a freezable view target type. scr_dyn_record_view
 * declines a frozen record, because a view of a type without frozen-write
 * guards could write it; its conversion then copies the record, and the
 * copy is another object. A freezable target's writes do ask
 * (scr_record_marked_frozen), so a frozen record is viewed like any other:
 * the view a capsule already has is answered first, and a capsule whose
 * views were all released gets a new one. The bit is lifted for the call
 * only; nothing in it reads the record or runs program code. */
void *scr_dyn_record_view_kept(ScrDyn *d, const ScrRecordViewSource *sources, size_t count,
                               const char *key, size_t key_len, void *(*alloc)(void)) {
  if (d->kind != SCR_DYN_TYPED_REF) return NULL;
  for (ScrDynTypedCast *cast = d->v.typed_ref.casts; cast; cast = cast->next)
    if (cast->borrowed && cast->type_key_len == key_len &&
        memcmp(cast->type_key, key, key_len) == 0)
      return cast->retain(cast->ptr);
  void *record = d->v.typed_ref.ptr;
  bool frozen = record && scr_rc_frozen(record);
  if (frozen) *(size_t *)record &= ~SCR_RC_FROZEN;
  void *view = scr_dyn_record_view(d, sources, count, key, key_len, alloc);
  if (frozen) *(size_t *)record |= SCR_RC_FROZEN;
  return view;
}
