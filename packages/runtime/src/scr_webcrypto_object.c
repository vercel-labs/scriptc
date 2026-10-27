/* The crypto global as a value: node:crypto's dynamic Crypto object
 * (scr_crypto_native in scr_async_dyn.c, which carries subtle.digest) with
 * the Crypto object's own randomUUID and getRandomValues methods, for
 * untyped reads such as uuid's `crypto.randomUUID && crypto.randomUUID()`.
 * Node's receiver check (ERR_INVALID_THIS on a detached call) is not
 * modeled. There is one object per thread, so every spelling of the
 * global (crypto, globalThis.crypto, node:crypto's webcrypto) is the same
 * value; it is released at exit. Linked only into programs that read the
 * global as a value. */
#include "scr_runtime.h"

static ScrDyn *scr_webcrypto_random_uuid_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  ScrStr *uuid = scr_crypto_random_uuid();
  ScrDyn *result = scr_dyn_new_str(uuid);
  scr_str_release(uuid);
  return result;
}

static ScrDyn *scr_webcrypto_get_random_values_call(ScrClosure *closure, ScrDyn *const *args,
                                                   size_t argc) {
  (void)closure;
  if (argc == 0) {
    static const char message[] =
        "Failed to execute 'getRandomValues' on 'Crypto': 1 argument required, but only 0 present.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_MISSING_ARGS");
    return NULL;
  }
  return scr_crypto_get_random_values_dyn(args[0]);
}

static SCR_TL ScrDyn *scr_webcrypto_object_value;

static void scr_webcrypto_object_cleanup(void) {
  if (scr_webcrypto_object_value) scr_dyn_release(scr_webcrypto_object_value);
  scr_webcrypto_object_value = NULL;
}

ScrDyn *scr_webcrypto_object(void) {
  if (scr_webcrypto_object_value) return scr_dyn_retain(scr_webcrypto_object_value);
  ScrDyn *result = scr_crypto_native();
  scr_dyn_obj_set(result, "randomUUID", 10,
                  scr_dyn_new_func(scr_closure_new(NULL, 0), scr_webcrypto_random_uuid_call, 0,
                                   "crypto.randomUUID", "randomUUID"));
  scr_dyn_obj_set(result, "getRandomValues", 15,
                  scr_dyn_new_func(scr_closure_new(NULL, 0), scr_webcrypto_get_random_values_call, 1,
                                   "crypto.getRandomValues", "getRandomValues"));
  scr_webcrypto_object_value = result;
  scr_atexit(scr_webcrypto_object_cleanup);
  return scr_dyn_retain(result);
}
