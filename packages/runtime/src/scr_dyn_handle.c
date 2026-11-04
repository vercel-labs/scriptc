/* The checked-dynamic HANDLE support unit — everything the handle
 * dispatchers (scr_http.c / scr_net.c) and the emitter unit's dyn
 * registrations share BEYOND the dyn core: the listener gate over the
 * ERR_INVALID_ARG_TYPE throwers (the throwers themselves live in
 * scr_json.c beside the dyn core — the always-linked bytes/fs argument
 * validators call them too), and the runtime-built listener adapter
 * closures whose fire thunks box event tuples back into the checked-dynamic tree. Split
 * out of scr_json.c so handle-free binaries keep their exact size
 * class: native-toolchain.ts compiles this unit exactly when a user of it links (the
 * net or emitter gate — http implies net).
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

/* Node's ERR_INVALID_ARG_TYPE listener gate (errors.js's
 * determineSpecificType shapes — the scr_emitter_check_listener wording,
 * shared here so the gated units need not link the emitter unit). */
void scr_dyn_check_listener(const ScrDyn *cb, const char *argname) {
  if (cb->kind == SCR_DYN_FUNC) return;
  scr_dyn_arg_type_fail(argname, "of type function", cb);
}

/* ── runtime-built listener closures (the handle dispatchers' .on paths) ─
 * One capture: a box holding the retained dyn FUNCTION value. The fire
 * thunks box the event tuple back into the checked-dynamic tree and call through the
 * checked-dynamic machinery (scr_dyn_call — per-arg validation lives in
 * the boxed thunk). A throw from the listener stays pending, exactly like
 * a compiler-emitted listener body. */
static ScrDyn *scr_dyn_listener_peek(ScrClosure *cb) {
  return (ScrDyn *)scr_box_get_ref(cb->caps[0]); /* +1 */
}

/* The boxed dyn FUNCTION a listener closure carries (+1) — for fire
 * thunks the OWNING units define themselves (handle-boxing tuples this
 * unit cannot spell: scr_net.c's 'connection', scr_http.c's 'request'). */
ScrDyn *scr_dyn_listener_fn(ScrClosure *cb) { return scr_dyn_listener_peek(cb); }

void scr_dyn_listener_fire0(ScrClosure *cb) {
  ScrDyn *fn = scr_dyn_listener_peek(cb);
  ScrDyn *r = scr_dyn_call(fn, NULL, 0, "listener");
  scr_dyn_release(r);
  scr_dyn_release(fn);
}

void scr_dyn_listener_fire_data(ScrClosure *cb, ScrBytes *chunk) {
  ScrDyn *fn = scr_dyn_listener_peek(cb);
  ScrDyn *arg = scr_dyn_new_chunk(chunk); /* Buffer-flavored, or a string inside a setEncoding window */
  ScrDyn *args[1] = { arg };
  ScrDyn *r = scr_dyn_call(fn, args, 1, "listener");
  scr_dyn_release(r);
  scr_dyn_release(arg);
  scr_dyn_release(fn);
}

void scr_dyn_listener_fire_err(ScrClosure *cb, ScrStr *msg) {
  ScrDyn *fn = scr_dyn_listener_peek(cb);
  if (scr_event_error_payload != NULL) {
    ScrDyn *error = scr_dyn_from_error(scr_event_error_payload);
    ScrDyn *error_args[1] = { error };
    ScrDyn *result = scr_dyn_call(fn, error_args, 1, "listener");
    scr_dyn_release(result);
    scr_dyn_release(error);
    scr_dyn_release(fn);
    return;
  }
  /* The Error a typed listener receives (scr_child_err_thunk_error's):
   * the message's code, message and name as Node's own properties. */
  ScrError *e = scr_error_from_event_message(msg);
  ScrDyn *arg = scr_dyn_from_error(e);
  ScrDyn *args[1] = { arg };
  ScrDyn *r = scr_dyn_call(fn, args, 1, "listener");
  scr_dyn_release(r);
  scr_dyn_release(arg);
  scr_error_release(e);
  scr_dyn_release(fn);
}

static ScrClosure *scr_dyn_listener_closure(const ScrDyn *cb, void *fire) {
  ScrClosure *clo = scr_closure_new(fire, 1);
  ScrBox *box = scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(box, scr_dyn_retain((ScrDyn *)cb));
  clo->caps[0] = box;
  return clo;
}

ScrClosure *scr_dyn_listener_closure_fn(const ScrDyn *cb, void *fire) {
  return scr_dyn_listener_closure(cb, fire);
}
ScrClosure *scr_dyn_listener_closure0(const ScrDyn *cb) {
  return scr_dyn_listener_closure(cb, (void *)&scr_dyn_listener_fire0);
}
ScrClosure *scr_dyn_listener_closure_data(const ScrDyn *cb) {
  return scr_dyn_listener_closure(cb, (void *)&scr_dyn_listener_fire_data);
}
ScrClosure *scr_dyn_listener_closure_err(const ScrDyn *cb) {
  return scr_dyn_listener_closure(cb, (void *)&scr_dyn_listener_fire_err);
}

