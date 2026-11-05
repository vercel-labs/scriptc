/// <reference path="./async_hooks.d.ts" />

/* node:diagnostics_channel — the in-process pub/sub core: named channels,
 * subscribe/unsubscribe (module-level and channel-level), publish with any
 * dyn-convertible message. Channel values are f64 handles into the
 * runtime's channel registry (the readline.Interface precedent — channels
 * are process-lived in Node too, its WeakRef machinery aside).
 * The store-binding surface (bindStore/unbindStore/runStores) lowers onto
 * the AsyncLocalStorage integration (dc.chan* libCalls).
 *
 * TracingChannel (tracingChannel) is the five-event-channel collection:
 * an f64 handle into the runtime's tracing registry (type-mapper.ts maps the
 * name like Channel). subscribe/unsubscribe walk a handlers object;
 * traceSync/traceCallback run Node's publish choreography in the runtime
 * (context defaults to a fresh {}); tracePromise is declared (the member
 * exists in Node) but fences at the call site — the traced function's
 * promise cannot cross the checked-dynamic tree boundary yet. */
declare module "node:diagnostics_channel" {
  export type ChannelListener = (message: unknown, name: string) => void;
  export interface Channel {
    readonly name: string;
    readonly hasSubscribers: boolean;
    publish(message: unknown): void;
    subscribe(onMessage: ChannelListener): void;
    unsubscribe(onMessage: ChannelListener): boolean;
    bindStore(
      store: import("async_hooks").AsyncLocalStorage<any>,
      transform?: (context: any) => any,
    ): void;
    unbindStore(store: import("async_hooks").AsyncLocalStorage<any>): boolean;
    runStores(context: unknown, fn: (...args: any[]) => any, thisArg?: any, ...args: any[]): any;
  }
  export function channel(name: string): Channel;
  export function subscribe(name: string, onMessage: ChannelListener): void;
  export function unsubscribe(name: string, onMessage: ChannelListener): boolean;
  export function hasSubscribers(name: string): boolean;
  export interface TracingChannelSubscribers {
    start?: (message: any) => void;
    end?: (message: any) => void;
    asyncStart?: (message: any) => void;
    asyncEnd?: (message: any) => void;
    error?: (message: any) => void;
  }
  export interface TracingChannelCollection {
    start: Channel;
    end: Channel;
    asyncStart: Channel;
    asyncEnd: Channel;
    error: Channel;
  }
  export interface TracingChannel {
    start: Channel;
    end: Channel;
    asyncStart: Channel;
    asyncEnd: Channel;
    error: Channel;
    readonly hasSubscribers: boolean;
    subscribe(subscribers: TracingChannelSubscribers): void;
    /** True when every present handler was found and removed (Node's
     * all-found conjunction; @types/node under-declares this as void). */
    unsubscribe(subscribers: TracingChannelSubscribers): boolean;
    traceSync<ThisArg = any, Args extends any[] = any[], Result = any>(
      fn: (this: ThisArg, ...args: Args) => Result,
      context?: object,
      thisArg?: ThisArg,
      ...args: Args
    ): Result;
    tracePromise<ThisArg = any, Args extends any[] = any[], Result = any>(
      fn: (this: ThisArg, ...args: Args) => Promise<Result>,
      context?: object,
      thisArg?: ThisArg,
      ...args: Args
    ): Promise<Result>;
    traceCallback<ThisArg = any, Args extends any[] = any[], Result = any>(
      fn: (this: ThisArg, ...args: Args) => Result,
      position?: number,
      context?: object,
      thisArg?: ThisArg,
      ...args: Args
    ): Result;
  }
  export function tracingChannel(nameOrChannels: string | TracingChannelCollection): TracingChannel;
}

declare module "diagnostics_channel" {
  export * from "node:diagnostics_channel";
}
