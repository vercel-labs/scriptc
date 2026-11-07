/* The creation order of a record's declared keys, kept per value.
 *
 * Node enumerates an object's keys in the order they were created. A record
 * type whose values are all created in one order enumerates through its
 * type's table, and one whose values take a few statically known orders
 * through an order index (key-order-witness.ts). For every other type the
 * compiler tracks the order on the value: a record whose keys were created in
 * another order than the table's keeps its own key list as its kept source
 * (scr_json.c, scr_record_source_note), which every reflective surface
 * already answers through. The literal notes that list when it builds the
 * record. The two operations here keep it current afterwards:
 *
 *  - a write that creates a declared key moves the key last;
 *  - a copy of the fields a narrower type declares (a rest binding, a record
 *    conversion) keeps its source's order over those fields.
 *
 * A copy reads its source's order from the source's own table entry
 * (scr_record_order_carry): a source without one is in its type's table
 * order, so the copy needs nothing and no view of the source is built.
 *
 * A unit of its own, selected only by programs with such a type
 * (record.orderAppend / record.orderCopy / record.orderCarry): scr_json.c
 * keeps its layout, and a program whose records are created in their
 * declared order links none of this.
 */
#include "scr_runtime.h"
#include "scr_record_source_private.h"

static void scr_record_order_placeholder(ScrDyn *keys, const char *key, size_t key_len) {
  scr_dyn_obj_set(keys, key, key_len, scr_dyn_retain(scr_dyn_undefined()));
}

/* A write is about to create the declared key `key` on `rec`, which lacks
 * it; `names` lists the shape's fields in the order the record serializes
 * them. The key becomes the record's last own key. A record that keeps a
 * source moves it to the end of the source's key list. One that keeps none
 * enumerated in the table's order until now, and the caller calls only
 * when a key the table lists after this one is present: the record then
 * keeps the table's order with the key moved last. The keys it lacks hold
 * their places until a write creates them, which moves each in turn. A
 * record view's keys belong to the record it views, and are left as they
 * are.
 *
 * `capsule` is the record's checked view (borrowed). A view boxed before the
 * record kept a source did not adopt one: it answers from the record's
 * fields, or from a snapshot of its own. It adopts the source now, as a
 * view boxed afterwards would, and a snapshot of its own moves the key last
 * too (its refresh takes every declared value from the record). */
void scr_record_order_append(void *rec, ScrDyn *capsule, const char *const *names,
                             const size_t *lens, size_t count, const char *key, size_t key_len) {
  if (!rec) return;
  ScrStr *name = scr_str_new(key, key_len);
  ScrDyn *view = scr_record_source_view(rec);
  if (view) {
    scr_dyn_obj_delete_field(view, name);
    scr_record_order_placeholder(view, key, key_len);
  } else if (!scr_record_source_has(rec)) {
    ScrDyn *keys = scr_dyn_new_obj();
    for (size_t i = 0; i < count; i++) {
      /* Internal '%'-fields are no keys of the object. */
      if (lens[i] && names[i][0] == '%') continue;
      if (lens[i] == key_len && !memcmp(names[i], key, key_len)) continue;
      scr_record_order_placeholder(keys, names[i], lens[i]);
    }
    scr_record_order_placeholder(keys, key, key_len);
    scr_record_source_note(rec, keys, names, lens, count);
    scr_dyn_release(keys);
    view = scr_record_source_view(rec);
  }
  if (view && capsule && capsule->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *cached = capsule->v.typed_ref.materialized;
    if (!cached) {
      capsule->v.typed_ref.materialized = scr_dyn_retain(view);
    } else if (cached != view && cached->kind == SCR_DYN_OBJ) {
      scr_dyn_obj_delete_field(cached, name);
      scr_record_order_placeholder(cached, key, key_len);
    }
  }
  scr_str_release(name);
}

/* The same for a key named at run time (`rec[key] = value`). A name the
 * shape does not declare is no declared key and is left to the write. */
void scr_record_order_append_key(void *rec, ScrDyn *capsule, const char *const *names,
                                 const size_t *lens, size_t count, const ScrStr *key) {
  if (!rec || !key) return;
  for (size_t i = 0; i < count; i++) {
    if (lens[i] != key->len || memcmp(names[i], key->data, key->len)) continue;
    if (key->len && key->data[0] == '%') return;
    scr_record_order_append(rec, capsule, names, lens, count, key->data, key->len);
    return;
  }
}

/* `rec` was just built from the fields of a record whose own keys `keys`
 * lists in order (a snapshot object, borrowed): it keeps that order over
 * the keys its shape declares, when it is not the table's. The other keys
 * of the source are not the copy's. */
void scr_record_order_copy(void *rec, const ScrDyn *keys, const char *const *names,
                           const size_t *lens, size_t count) {
  if (!rec || !keys || keys->kind != SCR_DYN_OBJ) return;
  ScrDyn *declared = scr_dyn_new_obj();
  size_t own = scr_dyn_obj_count(keys);
  for (size_t i = 0; i < own; i++) {
    size_t key_len;
    const char *key = scr_dyn_obj_key_at(keys, i, &key_len);
    for (size_t j = 0; j < count; j++) {
      if (lens[j] != key_len || memcmp(names[j], key, key_len)) continue;
      scr_record_order_placeholder(declared, key, key_len);
      break;
    }
  }
  scr_record_source_note(rec, declared, names, lens, count);
  scr_dyn_release(declared);
}

/* `rec` was just built from the fields of the record `src`. A record that
 * keeps no table entry holds exactly its declared keys in its type's table
 * order, which the compiler has already accounted for, so only a source
 * with an entry has an order to hand on: its kept key list, or, for a
 * record view, the keys of the record it views. */
void scr_record_order_carry(void *rec, const void *src, const char *const *names,
                            const size_t *lens, size_t count) {
  if (!rec || !src) return;
  ScrRecordSource *entry = scr_record_source_entry(src);
  if (!entry) return;
  if (entry->capsule) {
    ScrDyn *snapshot = scr_dyn_typed_ref_peek(entry->capsule);
    if (!scr_exc_pending()) scr_record_order_copy(rec, snapshot, names, lens, count);
    scr_dyn_release(snapshot);
    return;
  }
  if (entry->view) scr_record_order_copy(rec, entry->view, names, lens, count);
}
