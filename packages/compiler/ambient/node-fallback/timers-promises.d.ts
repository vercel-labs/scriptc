/* node:timers/promises — the promisified pair the Node test harness leans
 * on (`await setTimeout(ms)` as a sleep). setTimeout and setImmediate
 * settle with their resolve value (undefined without one) from the shared
 * timer heap and the immediate queue; setInterval(delay, value) lowers to a
 * typed async iterator. The options object takes `ref`; AbortSignal
 * options remain declared surface that fences per site. */
declare module "node:timers/promises" {
  export interface TimerOptions {
    ref?: boolean;
    signal?: AbortSignal;
  }
  export function setTimeout<T = void>(
    delay?: number,
    value?: T,
    options?: TimerOptions,
  ): Promise<T>;
  export function setImmediate<T = void>(value?: T, options?: TimerOptions): Promise<T>;
  export function setInterval<T = unknown>(
    delay?: number,
    value?: T,
    options?: unknown,
  ): AsyncGenerator<T, void, undefined>;
  export const scheduler: {
    wait(delay?: number, options?: TimerOptions): Promise<void>;
    yield(): Promise<void>;
  };
}

declare module "timers/promises" {
  export * from "node:timers/promises";
}
