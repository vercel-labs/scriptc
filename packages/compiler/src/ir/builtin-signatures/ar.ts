import { DYN, F64 } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The ar builtin call slots. */
export const arSignatures = defineLibFnSignatures({
  /** AsyncResource (node:async_hooks — scr_async_dyn.c): a resource is a
   * checked-dynamic handle whose payload (its type, its captured store
   * context and its ids) lives exactly as long as the value does. ar.new
   * [type, options] applies Node's checks (MAY THROW: ERR_INVALID_ARG_TYPE
   * for a non-string type or a non-object options read,
   * ERR_INVALID_ASYNC_ID for a bad triggerAsyncId); ar.runInScope
   * [handle, fn, thisArg, args-array] runs the function in the resource's
   * store context and ids (MAY THROW: the call itself); ar.bind
   * [handle, fn, thisArg] answers Node's bound function (MAY THROW:
   * ERR_INVALID_ARG_TYPE for a non-function); ar.bindStatic
   * [fn, type, thisArg] applies the same checks plus the type defaulting
   * (MAY THROW); ar.emitDestroy answers the handle; asyncId/triggerAsyncId
   * are the ids the resource was given. */
  "ar.new": { argTypes: [DYN, DYN], result: DYN },
  "ar.runInScope": { argTypes: [DYN, DYN, DYN, DYN], result: DYN },
  "ar.bind": { argTypes: [DYN, DYN, DYN], result: DYN },
  "ar.bindStatic": { argTypes: [DYN, DYN, DYN], result: DYN },
  "ar.emitDestroy": { argTypes: [DYN], result: DYN },
  "ar.asyncId": { argTypes: [DYN], result: F64 },
  "ar.triggerAsyncId": { argTypes: [DYN], result: F64 },
});
