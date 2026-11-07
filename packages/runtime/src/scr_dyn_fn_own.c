/* `fn.constructor = value` where the compiler sees a function receiver
 * (dyn.fnOwnSet): the write an ordinary object takes, into the function's
 * own property table, which reads of the name consult first
 * (scr_dyn_fn_get). The generic write (scr_dyn_key_set) refuses the name on
 * a function it meets only at run time, because typed code may read it
 * without the table; this entry is emitted only where a JavaScript source
 * writes it on a value the checker types as a function. Linked only into
 * programs with such a write. */
#include "scr_runtime.h"

void scr_dyn_fn_own_set(ScrDyn *recv, ScrStr *key, ScrDyn *value) {
  if (recv->kind != SCR_DYN_FUNC) {
    scr_dyn_key_set(recv, key, value);
    return;
  }
  ScrDyn *table = scr_dyn_function_properties(recv);
  if (!table) return;
  scr_dyn_key_set(table, key, value);
  scr_dyn_release(table);
}
