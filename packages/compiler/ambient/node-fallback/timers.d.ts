/* node:timers — the module twins of the timer globals (Node's timers
 * module re-exports them: require('timers').setTimeout IS setTimeout).
 * Named imports, destructured requires, and namespace calls all lower to
 * the same libCalls as the globals; the surface beyond these six
 * (enroll/unenroll, promises) fences per member. */
declare module "node:timers" {
  export function setTimeout(callback: () => void, ms?: number): Timeout;
  export function setTimeout(
    callback: (...args: never[]) => void,
    ms?: number,
    ...args: unknown[]
  ): Timeout;
  export function clearTimeout(handle?: Timeout | number | null | undefined): void;
  export function setInterval(callback: () => void, ms?: number): Timeout;
  export function setInterval(
    callback: (...args: never[]) => void,
    ms?: number,
    ...args: unknown[]
  ): Timeout;
  export function clearInterval(handle?: Timeout | number | null | undefined): void;
  export function setImmediate(callback: () => void): Immediate;
  export function setImmediate(callback: (...args: never[]) => void, ...args: unknown[]): Immediate;
  export function clearImmediate(handle?: Immediate | null | undefined): void;
}

declare module "timers" {
  export * from "node:timers";
}
