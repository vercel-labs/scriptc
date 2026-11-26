import { BOOL, DYN, F64, STRING, SYMBOL_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The emitter builtin call slots. */
export const emitterSignatures = defineLibFnSignatures({
  /** The checked-dynamic max-listeners ladders: setMaxChk is the
   * instance form over a dyn n (non-numbers ERR_INVALID_ARG_TYPE,
   * negatives/NaN ERR_OUT_OF_RANGE; +1 receiver back — chaining);
   * setDefaultMaxChk is the static/property form, its second argument
   * naming the message slot ("setMaxListeners" for the static call,
   * "defaultMaxListeners" for the module-property assignment). */
  "emitter.setMaxChk": { argTypes: [null, DYN], result: VOID },
  "emitter.setDefaultMaxChk": { argTypes: [DYN, STRING], result: VOID },
  // node:events EventEmitter: receivers are emitter-hierarchy objects and
  // the chaining forms (on/off/removeAll/setMax) return the receiver's
  // own class — program-dependent object types, checked in the libCall
  // case. emitter.emit is the one VARIADIC libCall: args beyond
  // (recv, name) are the event's frontend-unified tuple, any borrowable
  // kind — the count check admits a longer list for it alone.
  /** node:events EventEmitter (scr_events_emitter.c, link-gated by
   * moduleUsesEmitter). The receiver of every instance form is a borrowed
   * emitter-hierarchy object (`%EventEmitter` or a user subclass — the
   * backend reinterprets to ScrEmitter*, the identical prefix); event
   * names are borrowed strings (compile-time literals — the frontend
   * fences non-literals and unifies each event's argument tuple program-
   * wide). The chaining forms (on/off/removeAll/setMax) return the
   * receiver +1 typed as its static class, Node's `return this`.
   *
   * emitter.new: `new EventEmitter()` → a +1 bare emitter. emitter.ctor:
   * super() into the prefix of an emitted subclass (borrowed receiver,
   * void — allocation already initialized the prefix). emitter.on:
   * (recv, name, cb /moves/, once, prepend) — the backend synthesizes the
   * per-signature va_list invoke adapter from the cb's func type.
   * emitter.emit: (recv, name, ...tuple) — VARIADIC, the one libCall
   * whose arg count exceeds its signature; args are borrowed, result is
   * the had-listeners bool. emitter.emitError: emit('error', err) —
   * throws err when unhandled. count/countFn/names/listeners/getMax/
   * setMax/setDefaultMax/getDefaultMax are the introspection surface. */
  "emitter.new": { argTypes: [], result: VOID },
  /** `x.constructor.name` of an emitter or stream (a borrowed object of
   * EventEmitter's hierarchy): the +1 class name the instance records. */
  "emitter.className": { argTypes: [null], result: STRING },
  "emitter.ctor": { argTypes: [null], result: VOID },
  "emitter.on": { argTypes: [null, STRING, null, BOOL, BOOL], result: VOID },
  /** emitter.on for a name whose ARGUMENT value is not the registry key
   * it converts to (`on(null)` keys the table as "null" but warns with
   * `type: null`): (recv, name key, name value dyn, cb /moves/, once,
   * prepend). Only the leak warning reads the value. */
  "emitter.onNamed": { argTypes: [null, STRING, DYN, null, BOOL, BOOL], result: VOID },
  "emitter.off": { argTypes: [null, STRING, null], result: VOID },
  // The dyn-adapted registration family (JS-lane checked-dynamic
  // listeners): checkListener has NO receiver (it validates the listener
  // argument alone); onDyn carries (recv, name, cb dyn, adapter func,
  // once, prepend), offDyn (recv, name, cb dyn).
  "emitter.checkListener": { argTypes: [DYN], result: VOID },
  "emitter.onDyn": { argTypes: [null, STRING, DYN, null, BOOL, BOOL], result: VOID },
  "emitter.onFlex": { argTypes: [null, STRING, DYN, BOOL, BOOL], result: VOID },
  /** on/once/prepend* and emit through an untyped value (the class
   * dispatch of compiled emitters): onFlex/emitFlex plus runtime typed
   * adapters under 'error' and the meta events, and Node's unhandled-'error'
   * contract. emitAny is VARIADIC like emitFlex. */
  "emitter.onAny": { argTypes: [null, STRING, DYN, BOOL, BOOL], result: VOID },
  "emitter.offDyn": { argTypes: [null, STRING, DYN], result: VOID },
  "emitter.removeAll": { argTypes: [null, STRING, BOOL], result: VOID },
  "emitter.emit": { argTypes: [null, STRING], result: BOOL },
  "emitter.emitFlex": { argTypes: [null, STRING], result: BOOL },
  "emitter.emitAny": { argTypes: [null, STRING], result: BOOL },
  /** emit('error', ...payload) with a non-Error payload: (recv, then the
   * arguments boxed) — VARIADIC like emitFlex. */
  "emitter.emitErrorValue": { argTypes: [null], result: BOOL },
  /** An untyped emit of an event with a fixed tuple: (recv, name, k, then
   * k checked-dynamic arguments as given, then the event's converted
   * tuple) — VARIADIC like emitter.emit. hasTyped answers whether a
   * listener of the name needs the converted tuple. */
  "emitter.emitMixed": { argTypes: [null, STRING, F64], result: BOOL },
  "emitter.hasTyped": { argTypes: [null, STRING], result: BOOL },
  /** The converse: whether a listener of the name was registered through
   * an untyped value with no typed form, so a typed emit's arguments must
   * also convert to checked-dynamic values. */
  "emitter.hasDyn": { argTypes: [null, STRING], result: BOOL },
  "emitter.emitError": { argTypes: [null, STRING, null], result: BOOL },
  "emitter.count": { argTypes: [null, STRING], result: F64 },
  "emitter.countFn": { argTypes: [null, STRING, null], result: F64 },
  "emitter.countDyn": { argTypes: [null, STRING, DYN], result: F64 },
  /** eventNames(): the registered event keys as a checked-dynamic array —
   * string names first in Node's _events property order, then symbols
   * (which a string array cannot carry). */
  "emitter.names": { argTypes: [null], result: DYN },
  "emitter.listeners": { argTypes: [null, STRING], result: VOID },
  /** listeners()/rawListeners() through an untyped value: a checked-
   * dynamic array (throws when a listener has typed parameters). */
  "emitter.listenersDyn": { argTypes: [null, STRING], result: DYN },
  /** rawListeners over a runtime or untyped read: the once wrapper replaces
   * a once() registration (Node's list). */
  "emitter.rawListenersDyn": { argTypes: [null, STRING], result: DYN },
  /** Stream-'data' registration twins of emitter.on/onDyn (same args):
   * chosen at registration sites whose receiver is stream-rooted, so the
   * backend emits DATA thunks — the runtime's 'data' emission carries
   * BOTH payload slots (bytes, string; exactly one non-NULL — encoded
   * streams deliver strings), and the thunk unwraps the listener's
   * declared side (typed) or boxes by tag (dyn). emitter.emitData is the
   * user-emit form: (recv, name, chunk) with a bytes OR string chunk. */
  "emitter.onData": { argTypes: [null, STRING, null, BOOL, BOOL], result: VOID },
  "emitter.onDataDyn": { argTypes: [null, STRING, DYN, null, BOOL, BOOL], result: VOID },
  "emitter.emitData": { argTypes: [null, STRING, null], result: BOOL },
  "emitter.setMax": { argTypes: [null, F64], result: VOID },
  "emitter.getMax": { argTypes: [null], result: F64 },
  "emitter.setDefaultMax": { argTypes: [F64], result: VOID },
  "emitter.getDefaultMax": { argTypes: [], result: F64 },
  // The ES module namespace's copy of defaultMaxListeners, and
  // module.syncBuiltinESMExports() refreshing it.
  "emitter.esmDefaultMax": { argTypes: [], result: F64 },
  "emitter.esmSync": { argTypes: [], result: VOID },
  /** The events.errorMonitor event key: an immortal string the runtime
   * registry matches by identity, so no string event name reaches it. */
  "emitter.errorMonitor": { argTypes: [], result: STRING },
  /** A symbol event name's registry key (the scr_str_symbol_key of
   * scr_string.h): Node's listener table is keyed by property keys, so a
   * symbol name matches by identity and never by bytes. No receiver.
   * emitter.nameDyn is the same conversion for an untyped name —
   * ToPropertyKey: a symbol's key, or ToString of every other value,
   * which runs an object name's own toString/valueOf and may throw. */
  "emitter.symName": { argTypes: [SYMBOL_T], result: STRING },
  "emitter.nameDyn": { argTypes: [DYN], result: STRING },
});
