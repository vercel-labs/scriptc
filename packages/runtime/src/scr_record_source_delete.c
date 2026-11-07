/* `delete` of a key a record's declared layout does not hold.
 *
 * In Node the own property is still on the one object, so here it lives in
 * the record's kept source (the undeclared properties a checked conversion
 * keeps beside a closed record, scr_json.c), and the delete removes it
 * there: Object.keys, `in`, hasOwn, JSON, spread and inspect all answer
 * from that table.
 *
 * A unit of its own, selected only by programs that delete such a key
 * (record.sourceDelete): scr_json.c keeps its layout, and a program that
 * never deletes one links none of this. It reaches the table through
 * scr_record_source_private.h.
 */
#include "scr_runtime.h"
#include "scr_record_source_private.h"

/* The entry of a record that kept a source, or NULL (also for a record
 * view's entry). */
static ScrRecordSource *scr_record_source_kept(const void *rec) {
  ScrRecordSource *entry = scr_record_source_entry(rec);
  return entry && !entry->capsule ? entry : NULL;
}

/* Answers `delete`'s boolean: true when the property is gone (removed now,
 * or never held), and false when it survives — a frozen or non-configurable
 * property, which strict code refuses with Node's TypeError instead. A
 * record view deletes from the record it views, where Node's object keeps
 * the property, and a narrowed copy deletes on the record it was copied
 * from (scr_record_link_source): Node has one object, so a key the copy's
 * own layout does not declare is the source's property. The compiler
 * refuses the delete when a record it can reach this way declares the key
 * itself (refuseSourceFieldDeletes), so the key is never a field of
 * another layout. Borrows the record and the key. */
bool scr_record_source_delete(void *rec, const char *key, size_t key_len, bool strict) {
  if (!rec || !key) return true;
  ScrRecordSource *entry = scr_record_source_entry(rec);
  bool view = entry && entry->capsule;
  const void *target = view ? entry->viewed : rec;
  ScrRecordSource *source = scr_record_source_kept(target);
  const void *copied = NULL;
  /* Copies nest (a narrower copy of a narrower copy), so follow the chain
   * of links until a record keeps a source. */
  for (const void *linked = rec; !source && (linked = scr_record_link_source(linked));) {
    source = scr_record_source_kept(linked);
    target = linked;
    copied = linked;
  }
  ScrDyn *store = source ? source->view : NULL;
  if (!store || store->kind != SCR_DYN_OBJ) return true;
  /* The store lists the record's declared names too, as placeholders that
   * fix their order: a declared name belongs to the record's slot, which
   * only the absent-state write can empty, never to this table. */
  if (scr_record_source_declared(source, key, key_len)) return true;
  bool found = false, configurable = true;
  for (size_t i = 0; i < scr_dyn_obj_count(store) && !found; i++) {
    ScrDynProp prop = scr_dyn_obj_prop_at(store, i);
    if (prop.key_len != key_len || memcmp(prop.key, key, key_len) != 0) continue;
    found = true;
    configurable = prop.configurable;
  }
  if (!found) return true;
  ScrStr *name = scr_str_new(key, key_len);
  /* Node has one object where these records are two: freezing the copy
   * freezes what the delete removes, so it refuses the removal too. */
  if (!configurable || scr_rc_frozen(target) || (copied && scr_rc_frozen(rec))) {
    if (strict) {
      ScrStr *owner = scr_str_new("#<Object>", 9);
      scr_record_throw_frozen(name, owner, 2);
      scr_str_release(owner);
    }
    scr_str_release(name);
    return false;
  }
  scr_dyn_obj_delete_field(store, name);
  scr_str_release(name);
  return true;
}
