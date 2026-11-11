/* node:events — the EventEmitter class (the module object IS the class,
 * like Node's `module.exports = EventEmitter`). Listener/emit signatures
 * mirror @types/node's untyped `...args: any[]` surface; the compiler's
 * lowering unifies each event name's argument tuple program-wide and
 * checks annotated listener parameters against it (unannotated non-empty
 * parameter lists have no static types and fence at the registration). */
declare module "events" {
  /* Generic like @types/node's class: the type argument is the listener
   * MAP, a pure typing aid with no runtime layout (Node erases it too), so
   * `class Sink extends EventEmitter<Map>` adopts the same emitter base.
   * The map stays unconstrained here — the members below are the untyped
   * `...args: any[]` surface either way. */
  class EventEmitter<EventMap = Record<string, any[]>> {
    constructor();
    static defaultMaxListeners: number;
    /* Listeners registered under this symbol observe 'error' emits first
     * (an emit with no 'error' listener still throws). */
    static readonly errorMonitor: unique symbol;
    static addAbortListener(signal: AbortSignal, listener: (event: Event) => void): Disposable;
    on(eventName: string | symbol, listener: (...args: any[]) => void): this;
    addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    once(eventName: string | symbol, listener: (...args: any[]) => void): this;
    prependListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    prependOnceListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    off(eventName: string | symbol, listener: (...args: any[]) => void): this;
    removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
    removeAllListeners(eventName?: string | symbol): this;
    emit(eventName: string | symbol, ...args: any[]): boolean;
    listenerCount(eventName: string | symbol, listener?: (...args: any[]) => void): number;
    /* Declared as zero-parameter closures so the RESULT is statically
     * consumable (.length, indexing, identity): the lowering only admits
     * these calls for events whose argument tuple is empty — a listener
     * pulled from the array is then safely callable too. Events with
     * arguments fence (their element type would lie). */
    listeners(eventName: string | symbol): Array<() => void>;
    rawListeners(eventName: string | symbol): Array<() => void>;
    /* The registered keys, symbols included (Node's `(string | symbol)[]`). */
    eventNames(): (string | symbol)[];
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
  }
  import internal = require("node:events");
  namespace EventEmitter {
    /* The async iterator events.on answers. Node's AsyncIterator subclass
     * over one event's argument tuples: next() resolves the next event's
     * arguments (the iterator answers `{ value, done }`), return() ends the
     * iteration, throwing one waiter with an Error ends it the way an
     * 'error' emit does, and the iterator is its own async iterator. The
     * class is Node's internal one, not an export: it stays private to this
     * namespace so `import { EventEmitterAsyncIterator }` keeps failing
     * the way it does in Node. */
    class EventEmitterAsyncIterator {
      next(): Promise<{ value: any; done: boolean }>;
      return(): Promise<{ value: any; done: boolean }>;
      throw(err: Error): Promise<{ value: any; done: boolean }>;
      [Symbol.asyncIterator](): EventEmitterAsyncIterator;
    }
    /* Iterates one event's argument tuples until the iterator is closed, an
     * 'error' arrives, `options.signal` aborts or one of `options.close`'s
     * events is emitted. */
    export function on(
      emitter: EventEmitter | EventTarget,
      eventName: string | symbol,
      options?: {
        signal?: AbortSignal;
        close?: string[];
        highWaterMark?: number;
        highWatermark?: number;
        lowWaterMark?: number;
        lowWatermark?: number;
      },
    ): EventEmitterAsyncIterator;
    // The class under its own name, so `import { EventEmitter }` resolves
    // (the @types/node namespace-alias pattern).
    export { internal as EventEmitter };
    // The event's arguments, as checked-dynamic values.
    export function once(
      emitter: EventEmitter | NodeJS.ReadableStream | NodeJS.WritableStream,
      eventName: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown[]>;
    /* An EventTarget has no 'error' event semantics: the promise settles
     * with the event at the front of the array, and a signal's abort
     * rejects it with an AbortError. */
    export function once(
      target: EventTarget,
      eventName: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown[]>;
    /* The emitter's own listenerCount/getMaxListeners/setMaxListeners/
     * listeners, over EventEmitter instances and EventTargets. */
    export function listenerCount(
      emitterOrTarget: EventEmitter | EventTarget,
      eventName: string | symbol,
    ): number;
    export function getMaxListeners(emitterOrTarget: EventEmitter | EventTarget): number;
    export function setMaxListeners(
      n?: number,
      ...eventTargets: Array<EventEmitter | EventTarget>
    ): void;
    /* An EventEmitter's listeners are functions, so their array is
     * statically consumable. An EventTarget's listeners come back as
     * registered (Node's `Function[]`): a listener object with
     * handleEvent is itself, not a function, so that array's elements
     * stay checked-dynamic. */
    export function getEventListeners(
      emitter: EventEmitter,
      name: string | symbol,
    ): Array<() => void>;
    export function getEventListeners(
      emitterOrTarget: EventEmitter | EventTarget,
      name: string | symbol,
    ): Array<any>;
  }
  export = EventEmitter;
}

declare module "node:events" {
  import events = require("events");
  export = events;
}
