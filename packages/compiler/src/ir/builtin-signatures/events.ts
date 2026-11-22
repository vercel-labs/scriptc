import { arrayOf, BOOL, DYN, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The events builtin call slots. */
export const eventsSignatures = defineLibFnSignatures({
  /** events.on over a receiver compiled as an emitter: [emitter, receiver,
   * pauseFn, resumeFn, name, boxer, errorBoxer, listenForError, options] —
   * the boxers turn the event's tuple and 'error''s into the iterator's
   * arguments array (scr_events_on_typed, beside scr_events_on). */
  "events.onTyped": {
    argTypes: [null, DYN, DYN, DYN, DYN, null, null, BOOL, DYN],
    result: DYN,
  },
  "events.addAbortListener": { argTypes: [DYN, DYN], result: DYN },
  /** events.once (scr_events_emitter.c): [emitter, name, boxer,
   * errorBoxer, listenForError] → a pending promise of any[]; the boxers
   * turn the event's and the 'error' tuple into that array. */
  "events.once": { argTypes: [null, STRING, null, null, BOOL], result: VOID },
  /** events.once(emitter, name, options) (scr_events_once_signal.c):
   * events.once's arguments plus the checked-dynamic options value, whose
   * `signal` the runtime validates as Node does. */
  "events.onceSignal": { argTypes: [null, STRING, null, null, BOOL, DYN], result: VOID },
  /** events.once over a name the program does not resolve to one of its
   * typed tuples (scr_events_once_signal.c): [emitter, name, options] → a
   * pending promise of the event's arguments. The listeners are
   * checked-dynamic function values, so the name crosses as the value the
   * receiver's once() receives and the promise carries the emit's
   * arguments as the emit provides them. Never throws: invalid options, a
   * name that cannot key the registry, an aborted signal, a throwing
   * 'newListener' listener and every event failure reject it. */
  "events.onceAny": {
    argTypes: [null, DYN, DYN],
    result: { kind: "promise", inner: arrayOf(DYN) },
  },
  /** A promise that never settles (events.once of an event that cannot
   * occur, e.g. 'drain' on a synchronous process stream). The result is
   * events.once's own Promise<any[]> type. */
  "events.pendingForever": { argTypes: [], result: { kind: "promise", inner: arrayOf(DYN) } },
});
