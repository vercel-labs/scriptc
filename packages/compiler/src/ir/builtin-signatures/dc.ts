import { BOOL, DYN, F64, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The dc builtin call slots. */
export const dcSignatures = defineLibFnSignatures({
  /** node:diagnostics_channel (scr_dc.c, linked when any dc.* appears —
   * the zlib gating precedent): a process-global name→channel registry;
   * channel values are f64 handles (type-mapper.ts maps Channel to F64, the
   * readline.Interface pattern). Names and subscribers cross as dyn values
   * so the runtime applies Node's own checks: channel()/subscribe() raise
   * ERR_INVALID_ARG_TYPE for a name that is not a string, subscribe raises
   * the "subscription" TypeError for a non-function, and
   * unsubscribe/hasSubscribers answer false there (a symbol name fences
   * with SC2020). Subscribers are identity-compared by unsubscribe and
   * called (message, name) by publish over a SNAPSHOT of the list (a
   * subscriber unsubscribing itself mid-publish still lets its siblings
   * fire, Node's behavior). A subscriber throw does not stop the dispatch
   * and does not leave publish: like Node's
   * process.nextTick(triggerUncaughtException), it surfaces as an uncaught
   * exception on a later tick. */
  "dc.channel": { argTypes: [DYN], result: F64 },
  "dc.subscribe": { argTypes: [DYN, DYN], result: VOID },
  "dc.unsubscribe": { argTypes: [DYN, DYN], result: BOOL },
  "dc.hasSubscribers": { argTypes: [DYN], result: BOOL },
  "dc.publish": { argTypes: [F64, DYN], result: VOID },
  "dc.chanSubscribe": { argTypes: [F64, DYN], result: VOID },
  "dc.chanUnsubscribe": { argTypes: [F64, DYN], result: BOOL },
  "dc.chanHasSubscribers": { argTypes: [F64], result: BOOL },
  "dc.chanName": { argTypes: [F64], result: DYN },
  "dc.tracingChannel": { argTypes: [DYN], result: F64 },
  "dc.tracingChannelOf": { argTypes: [F64, F64, F64, F64, F64], result: F64 },
  "dc.tcChannel": { argTypes: [F64, F64], result: F64 },
  "dc.tcHasSubscribers": { argTypes: [F64], result: BOOL },
  "dc.tcSubscribe": { argTypes: [F64, DYN], result: VOID },
  "dc.tcUnsubscribe": { argTypes: [F64, DYN], result: BOOL },
  "dc.tcTraceSync": { argTypes: [F64, DYN, DYN, DYN, DYN], result: DYN },
  "dc.tcTraceCallback": { argTypes: [F64, DYN, F64, DYN, DYN, DYN], result: DYN },
  /** tracePromise (scr_dc.c): start publish, the traced call, a wrap of
   * non-promise results, the end publish, and a REACTION FIBER that
   * awaits the traced promise and publishes asyncStart/asyncEnd (error
   * first on rejection) before settling the returned promise<dyn> with
   * the passed-through outcome. MAY THROW (the traced call and the
   * synchronous publishes). */
  "dc.tcTracePromise": {
    argTypes: [F64, DYN, DYN, DYN, DYN],
    result: { kind: "promise", inner: DYN },
  },
  /** Channel.bindStore/unbindStore/runStores (scr_dc.c): the
   * AsyncLocalStorage integration — set-semantics bindings per store,
   * runStores entering every bound store with transform(data) around the
   * publish and the callback (MAY THROW: transforms, subscribers, and
   * the callback all run). */
  "dc.chanBindStore": { argTypes: [F64, F64, DYN], result: VOID },
  "dc.chanUnbindStore": { argTypes: [F64, F64], result: BOOL },
  "dc.chanRunStores": { argTypes: [F64, DYN, DYN, DYN, DYN], result: DYN },
});
