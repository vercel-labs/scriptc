/* node:async_hooks — AsyncLocalStorage and AsyncResource lower onto the
 * runtime's fiber-carried context snapshots and resource registry (the
 * als and ar libCalls); createHook/AsyncHook and the execution-id
 * readers lower onto the runtime's hook registry and execution state
 * (the ah libCalls). */
declare module "async_hooks" {
  /* AsyncLocalStorage: fiber-carried context snapshots — run/getStore/
   * exit/enterWith/disable lower onto the runtime's active-slot machinery
   * (als.* libCalls); values cross as dyn values. bind and snapshot bind
   * functions to the active context; the options carry the store's
   * default value and name. withScope enters the store now and answers a
   * RunScope whose disposal puts back the value getStore() answered
   * before it. */
  export interface AsyncLocalStorageOptions {
    defaultValue?: any;
    name?: string | undefined;
  }
  /* AsyncLocalStorage.withScope's scope: `dispose()` (also reached as
   * `[Symbol.dispose]()`, so a `using` declaration works) restores the
   * store; a second dispose is a no-op. */
  export interface RunScope {
    dispose(): void;
    [Symbol.dispose](): void;
  }
  export class AsyncLocalStorage<T = any> {
    constructor(options?: AsyncLocalStorageOptions);
    static bind<Func extends (...args: any[]) => any>(fn: Func): Func;
    static snapshot(): <R, TArgs extends any[]>(fn: (...args: TArgs) => R, ...args: TArgs) => R;
    readonly name: string;
    run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R;
    exit<R>(callback: (...args: any[]) => R, ...args: any[]): R;
    getStore(): T | undefined;
    enterWith(store: T): void;
    disable(): void;
    withScope(store: T): RunScope;
  }
  export interface AsyncResourceOptions {
    triggerAsyncId?: number | undefined;
    requireManualDestroy?: boolean | undefined;
  }
  /* AsyncResource: a resource keeping the store context active when it was
   * built. runInAsyncScope runs a function in that context (with the
   * resource's async ids), bind answers a function doing the same, and
   * asyncId/triggerAsyncId are the ids it was given. */
  export class AsyncResource {
    constructor(type: string, triggerAsyncId?: number | AsyncResourceOptions);
    static bind<Func extends (this: ThisArg, ...args: any[]) => any, ThisArg>(
      fn: Func,
      type?: string,
      thisArg?: ThisArg,
    ): Func;
    bind<Func extends (...args: any[]) => any>(fn: Func): Func;
    runInAsyncScope<This, Result>(
      fn: (this: This, ...args: any[]) => Result,
      thisArg?: This,
      ...args: any[]
    ): Result;
    emitDestroy(): this;
    asyncId(): number;
    triggerAsyncId(): number;
  }
  export interface AsyncHook {
    enable(): AsyncHook;
    disable(): AsyncHook;
  }
  export function createHook(callbacks: {
    init?: (asyncId: number, type: string, triggerAsyncId: number, resource: unknown) => void;
    before?: (asyncId: number) => void;
    after?: (asyncId: number) => void;
    destroy?: (asyncId: number) => void;
    promiseResolve?: (asyncId: number) => void;
  }): AsyncHook;
  export function executionAsyncId(): number;
  export function triggerAsyncId(): number;
  /* The resource the current execution belongs to: the AsyncResource whose
   * runInAsyncScope/bind scope is executing, and a plain object elsewhere
   * (timer, immediate, tick and promise executions answer that shared
   * object rather than each execution's own resource). */
  export function executionAsyncResource(): object;
}

declare module "node:async_hooks" {
  export * from "async_hooks";
}
