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
    listeners(eventName: string): Array<() => void>;
    rawListeners(eventName: string): Array<() => void>;
    eventNames(): string[];
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
  }
  import internal = require("node:events");
  namespace EventEmitter {
    // The class under its own name, so `import { EventEmitter }` resolves
    // (the @types/node namespace-alias pattern).
    export { internal as EventEmitter };
    // The event's arguments, as checked-dynamic values.
    export function once(
      emitter: EventEmitter | NodeJS.ReadableStream | NodeJS.WritableStream,
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
    export function getEventListeners(
      emitterOrTarget: EventEmitter | EventTarget,
      name: string | symbol,
    ): Array<() => void>;
  }
  export = EventEmitter;
}

declare module "node:events" {
  import events = require("events");
  export = events;
}
