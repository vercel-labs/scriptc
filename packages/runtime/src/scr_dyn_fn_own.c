/* `fn.constructor = value` where the compiler sees a function receiver
 * (dyn.fnOwnSet): the assignment an ordinary object takes, applied to the
 * function's own property table, which reads of the name consult first
 * (scr_dyn_fn_get). The generic write (scr_dyn_key_set) refuses the name on
 * a function it meets only at run time, because typed code may read it
 * without the table; this entry is emitted only where a JavaScript source
 * writes it on a value the checker types as a function. Linked only into
 * programs with such a write. */
#include "scr_runtime.h"

/* Whether the chain an assignment to the function walks refuses the write:
 * the first definition of `key` it meets, from the function's own table
 * up, is an accessor without a setter or a data property that is not
 * writable. A function on the chain holds its properties in its table, as
 * the walk of the write itself reads it; a link of any other kind ends the
 * question, and the write's own walk decides. */
static bool scr_dyn_fn_own_read_only(const ScrDyn *table, const ScrStr *key) {
  for (const ScrDyn *link = table; link;) {
    ScrDyn *held = link->kind == SCR_DYN_FUNC ? scr_dyn_function_properties(link) : NULL;
    const ScrDyn *holder = held ? held : link;
    if (holder->kind != SCR_DYN_OBJ) {
      scr_dyn_release(held);
      return false;
    }
    size_t index = scr_dyn_obj_index_of(holder, key->data, key->len);
    if (index != SIZE_MAX) {
      ScrDynProp found = scr_dyn_obj_prop_at(holder, index);
      scr_dyn_release(held);
      return found.accessor ? !found.setter : !found.writable;
    }
    /* The function keeps its table, so the link outlives this reference. */
    link = holder->prototype;
    scr_dyn_release(held);
  }
  return false;
}

void scr_dyn_fn_own_set(ScrDyn *recv, ScrStr *key, ScrDyn *value) {
  if (recv->kind != SCR_DYN_FUNC) {
    scr_dyn_key_set(recv, key, value);
    return;
  }
  ScrDyn *table = scr_dyn_function_properties(recv);
  if (!table) return;
  /* A write the chain refuses is a TypeError in Node that prints the
   * function's source text (strict code), or nothing at all (sloppy code):
   * that form keeps the refusal the generic write gives for the name. */
  if (scr_dyn_fn_own_read_only(table, key)) {
    static const char message[] = "scriptc: overriding builtin function properties is not supported";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    scr_dyn_release(table);
    return;
  }
  /* Every other write is the ordinary assignment with the FUNCTION as its
   * receiver, the one the generic write makes for any other name of a
   * function: one walk of the chain, through plain objects and functions
   * alike, in which a setter found at any depth runs with the function as
   * `this`, and a name no accessor answers becomes the function's own
   * property. Writing through the table as the receiver instead would hand
   * the table to such a setter. */
  scr_dyn_bag_set(table, key, value, recv);
  scr_dyn_release(table);
}
