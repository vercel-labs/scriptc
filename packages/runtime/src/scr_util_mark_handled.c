/* node:util's markPromiseAsHandled. Node marks the promise's rejection
 * observed so no 'unhandledRejection' is emitted for it, whether it already
 * rejected or rejects later, and rejects anything that is not a native
 * promise with ERR_INVALID_ARG_TYPE naming the value the way Node's
 * argument validation does. The checked-dynamic promise box shares its
 * identity with the promise it was made from, so marking either view keeps
 * a rejection the program handled through the other view out of the report.
 * The argument is borrowed. */
#include "scr_runtime.h"

void scr_util_mark_promise_as_handled(ScrDyn *promise) {
  ScrPromise *p = scr_dyn_promise_of(promise);
  if (p == NULL) {
    char detail[256];
    const char *received = scr_dyn_specific_type(promise, detail, sizeof detail);
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "The \"promise\" argument must be an instance of Promise. Received ");
    scr_jb_puts(&b, received);
    ScrStr *message = scr_jb_finish(&b);
    scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_TYPE");
    scr_str_release(message);
    return;
  }
  scr_promise_mark_handled(p);
}
