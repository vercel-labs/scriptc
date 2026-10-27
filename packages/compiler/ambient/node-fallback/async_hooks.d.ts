/* node:async_hooks — declared surface without lowering: async-hook
 * instrumentation is guarded behind env flags in harness code; a reached
 * use fences at its site. */
declare module "async_hooks" {
  /* AsyncLocalStorage: fiber-carried context snapshots — run/getStore/
   * exit/enterWith/disable lower onto the runtime's active-slot machinery
   * (als.* libCalls); values cross as dyn values. bind and snapshot bind
   * functions to the active context; the options carry the store's
   * default value and name. */
  export interface AsyncLocalStorageOptions {
    defaultValue?: any;
    name?: string | undefined;
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
  }): AsyncHook;
  export function executionAsyncId(): number;
  export function triggerAsyncId(): number;
}

declare module "node:async_hooks" {
  export * from "async_hooks";
}
