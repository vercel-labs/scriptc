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
  /* The name may resolve to an accessor: on an object the function
   * inherits from (`Object.setPrototypeOf(fn, { set constructor(v) {…} })`
   * makes that object the table's prototype) or on the table itself. A
   * setter runs with the FUNCTION as its receiver, which a write into the
   * table would not give it (the table would be `this`). An accessor
   * without a setter takes no write: that form keeps the refusal the
   * generic write gives. A data property met first shadows what is above
   * it, and the write is the function's own. */
  for (const ScrDyn *holder = table; holder && holder->kind == SCR_DYN_OBJ; holder = holder->prototype) {
    ScrDyn *setter = scr_dyn_obj_accessor_fn(holder, key->data, key->len, true);
    ScrDyn *getter = scr_dyn_obj_accessor_fn(holder, key->data, key->len, false);
    bool has_setter = setter->kind != SCR_DYN_UNDEF;
    bool accessor = has_setter || getter->kind != SCR_DYN_UNDEF;
    if (has_setter) {
      ScrDyn *arguments = scr_dyn_new_arr();
      scr_dyn_arr_push(arguments, scr_dyn_retain(value));
      ScrDyn *result = scr_dyn_apply_array_like(setter, recv, arguments, "a setter");
      if (result) scr_dyn_release(result);
      scr_dyn_release(arguments);
    } else if (accessor) {
      static const char message[] = "scriptc: overriding builtin function properties is not supported";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    }
    scr_dyn_release(setter);
    scr_dyn_release(getter);
    if (accessor) {
      scr_dyn_release(table);
      return;
    }
    if (scr_dyn_obj_get(holder, key->data, key->len)) break;
  }
  scr_dyn_key_set(table, key, value);
  scr_dyn_release(table);
}
