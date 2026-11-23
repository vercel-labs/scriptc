import { arrayOf, BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The event builtin call slots. */
export const eventSignatures = defineLibFnSignatures({
  /** EventTarget / Event / CustomEvent construction (scr_event_target.c):
   * the Event constructors take the argument vector as one dyn array and
   * throw Node's validation errors; `event.is` is `v instanceof Event`
   * (kind 0), `CustomEvent` (1), `EventTarget` (2). addAbortListener
   * answers the disposer (the Disposable's [Symbol.dispose]). */
  "event.targetNew": { argTypes: [], result: DYN },
  "event.new": { argTypes: [DYN], result: DYN },
  "event.customNew": { argTypes: [DYN], result: DYN },
  "event.messageNew": { argTypes: [DYN], result: DYN },
  "event.closeNew": { argTypes: [DYN], result: DYN },
  "event.is": { argTypes: [DYN, F64], result: BOOL },
  /** Compiled EventTarget and Event subclasses: the receiver is the
   * instance (an object rooted at %EventTarget / %Event). targetInit and
   * init are super() (init takes the argument vector as one dyn array
   * and throws the constructor's validation errors; initType is the
   * super(type) form with a string); targetCall runs an EventTarget method
   * with the instance's own capsule as `self` (targetDispatch is its
   * dispatchEvent(event) form, answering the bool); call, get and set
   * reach the Event members. */
  "event.targetInit": { argTypes: [null], result: VOID },
  "event.init": { argTypes: [null, DYN], result: VOID },
  "event.initType": { argTypes: [null, STRING], result: VOID },
  /** %main hands the engine the compiled `listener.handleEvent` reader
   * (lower-event-target.ts noteEventListeners). */
  "event.handleEventReader": { argTypes: [DYN], result: VOID },
  "event.targetDispatch": { argTypes: [null, DYN, DYN], result: BOOL },
  "event.targetCall": { argTypes: [null, DYN, STRING, DYN], result: DYN },
  /** events.getEventListeners over an EventTarget: the type's listeners
   * in registration order, as a checked-dynamic array. The receiver is
   * the target as a checked-dynamic value (a plain target, an
   * AbortSignal, or a compiled subclass's capsule); `type` is the string
   * name, or the checked-dynamic form, where a value that is not a string
   * matches no type and the answer is empty. */
  "event.targetListeners": { argTypes: [DYN, STRING], result: DYN },
  "event.targetListenersDyn": { argTypes: [DYN, DYN], result: DYN },
  /** events.listenerCount over an EventTarget: the type's listeners, 0
   * for a type it has none of (the `_dyn` form answers 0 for a value that
   * is not a string). */
  "event.targetListenerCount": { argTypes: [DYN, STRING], result: F64 },
  "event.targetListenerCountDyn": { argTypes: [DYN, DYN], result: F64 },
  /** events.getMaxListeners and events.setMaxListeners over an
   * EventTarget: the target's limit, and its assignment. */
  "event.targetGetMax": { argTypes: [DYN], result: F64 },
  "event.targetSetMax": { argTypes: [DYN, F64], result: VOID },
  /** events.once over an EventTarget (scr_event_target.c): [target,
   * name] → a pending promise of the event's arguments, and the options
   * form with the checked-dynamic options value last. Never throws: a
   * receiver that is not an EventTarget, invalid options or a bad or
   * aborted options.signal reject it. */
  "event.onceTarget": {
    argTypes: [DYN, STRING],
    result: { kind: "promise", inner: arrayOf(DYN) },
  },
  "event.onceTargetSignal": {
    argTypes: [DYN, STRING, DYN],
    result: { kind: "promise", inner: arrayOf(DYN) },
  },
  /** events.on (scr_event_target.c): the async iterator over a
   * receiver's events. `event.on` resolves the protocol at runtime
   * (receiver, name and options as checked-dynamic values: the name
   * crosses as the value the receiver's `on` receives, a symbol keeping
   * its identity, and the options ladder runs in the runtime);
   * `event.onEmitter` is the same for a receiver compiled as an emitter,
   * whose registry it registers in directly; both take the receiver's
   * pause() and resume() as values (undefined when the static class has
   * none) because a compiled class's methods are not reachable through
   * its checked-dynamic view. */
  "event.on": { argTypes: [DYN, DYN, DYN], result: DYN },
  "event.onEmitter": {
    argTypes: [null, DYN, DYN, DYN, DYN, DYN],
    result: DYN,
  },
  "event.call": { argTypes: [null, STRING, DYN], result: DYN },
  "event.get": { argTypes: [null, STRING], result: DYN },
  "event.set": { argTypes: [null, STRING, DYN], result: VOID },
  "event.broadcastInstall": { argTypes: [], result: VOID },
});
