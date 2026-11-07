/* Object.isExtensible and Object.isSealed of a checked-dynamic value.
 *
 * Only the kinds whose integrity state the runtime models have an answer of
 * their own: a plain object, an array, a function, a class instance's checked
 * view, a typed-array view, and a Map or Set (from its backing map). A native
 * handle that is not a collection, and a promise, carry no integrity state
 * that scr_json.c tracks: Object.preventExtensions and Object.seal change
 * nothing on one and Object.freeze refuses, so scriptc cannot know whether a
 * program made it non-extensible, and Node's answer may be either. main
 * answered false for every such handle, silently; the query now refuses
 * loudly, as Object.isFrozen already did for the same kinds. Node island
 * values keep their own answer (their integrity belongs to
 * scr_node_island_handle.c).
 *
 * A unit of its own, selected only by programs that query a value typed
 * dynamically (dyn.isExtensibleQuery / dyn.isSealedQuery): scr_json.c keeps
 * its layout, and a program that never asks links none of this.
 */
#include "scr_runtime.h"

static bool scr_dyn_integrity_unmodeled(const ScrDyn *object) {
  if (object->kind == SCR_DYN_PROMISE) return true;
  if (object->kind != SCR_DYN_HANDLE) return false;
  if (object->v.handle.tag == SCR_DYNH_NODE_ISLAND) return false;
  return !scr_dyn_native_map_is(object) && !scr_dyn_native_set_is(object);
}

static void scr_dyn_integrity_query_fence(const ScrDyn *object, const char *what) {
  ScrJsonBuf buffer;
  scr_jb_init(&buffer);
  scr_jb_puts(&buffer, what);
  scr_jb_puts(&buffer, " of a ");
  scr_jb_puts(&buffer, object->kind == SCR_DYN_PROMISE ? "Promise" : scr_dyn_handle_cls(object));
  scr_jb_puts(&buffer, " is not supported yet");
  ScrStr *message = scr_jb_finish(&buffer);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
}

/* A program that adds own properties to handles installs the handle
 * property table (scr_dyn_handle_props.c), which tracks the integrity state
 * of every handle tag it accepts: its answer replaces the fence below. */
#ifdef SCR_JS_OBJECT_MODEL
static bool scr_dyn_integrity_answer(const ScrDyn *object, int op, bool *answer) {
  if (object->kind != SCR_DYN_HANDLE || !scr_dyn_handle_props_hooks) return false;
  ScrDyn *unused = NULL;
  return scr_dyn_handle_props_hooks->integrity((ScrDyn *)object, op, &unused, answer);
}
#endif

bool scr_dyn_is_extensible_query(ScrDyn *object) {
#ifdef SCR_JS_OBJECT_MODEL
  bool answer;
  if (scr_dyn_integrity_answer(object, 3, &answer)) return answer;
#endif
  if (scr_dyn_integrity_unmodeled(object)) {
    scr_dyn_integrity_query_fence(object, "Object.isExtensible");
    return false;
  }
  return scr_dyn_is_extensible(object);
}

bool scr_dyn_is_sealed_query(const ScrDyn *object) {
#ifdef SCR_JS_OBJECT_MODEL
  bool answer;
  if (scr_dyn_integrity_answer(object, 4, &answer)) return answer;
#endif
  if (scr_dyn_integrity_unmodeled(object)) {
    scr_dyn_integrity_query_fence(object, "Object.isSealed");
    return false;
  }
  return scr_dyn_is_sealed(object);
}
