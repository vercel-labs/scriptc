// undici's dispatcher-base.js: dispatch, interceptors and lifecycle.
import { Dispatcher } from "./dispatcher-v8.ts";
import { unwrapHandler } from "./dispatcher.ts";
import { ClientClosedError, ClientDestroyedError, InvalidArgumentError } from "./errors.ts";
import type {
  DispatchFn,
  DispatchHandlers,
  DispatchInterceptor,
  DispatchOptions,
  Profile,
} from "./types.ts";

export class DispatcherBase extends Dispatcher {
  __profile: Profile;
  __destroyed: boolean;
  __closed: boolean;
  __onDestroyed: (() => void)[] | null;
  __onClosed: (() => void)[] | null;
  __interceptors: readonly DispatchInterceptor[];
  __interceptedDispatch: DispatchFn | null;

  constructor(profile: Profile) {
    super();
    this.__profile = profile;
    this.__destroyed = false;
    this.__closed = false;
    this.__onDestroyed = [];
    this.__onClosed = [];
    this.__interceptors = [];
    this.__interceptedDispatch = null;
  }

  __undiciProfile(): Profile {
    return this.__profile;
  }

  get destroyed(): boolean {
    return this.__destroyed;
  }

  __isDestroyed(): boolean {
    return this.__destroyed;
  }

  get closed(): boolean {
    return this.__closed;
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.__destroyed) {
        queueMicrotask(() => reject(new ClientDestroyedError()));
        return;
      }
      if (this.__closed) {
        const waiting = this.__onClosed;
        if (waiting !== null) waiting.push(() => resolve());
        else queueMicrotask(() => resolve());
        return;
      }
      this.__closed = true;
      this.__onClosed!.push(() => resolve());
      this.__close()
        .then(() => this.destroy())
        .then(() => {
          queueMicrotask(() => {
            const callbacks = this.__onClosed;
            this.__onClosed = null;
            if (callbacks !== null) for (const cb of callbacks) cb();
          });
        });
    });
  }

  destroy(err?: Error | null): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.__destroyed) {
        const waiting = this.__onDestroyed;
        if (waiting !== null) waiting.push(() => resolve());
        else queueMicrotask(() => resolve());
        return;
      }
      const error = err ?? new ClientDestroyedError();
      this.__destroyed = true;
      this.__onDestroyed!.push(() => resolve());
      this.__destroy(error).then(() => {
        queueMicrotask(() => {
          const callbacks = this.__onDestroyed;
          this.__onDestroyed = null;
          if (callbacks !== null) for (const cb of callbacks) cb();
        });
      });
    });
  }

  dispatch(options: DispatchOptions, handler: DispatchHandlers): boolean {
    const target = this.__profile.major === 7 ? unwrapHandler(handler, this.__profile) : handler;
    try {
      if (this.__destroyed) throw new ClientDestroyedError();
      if (this.__closed) throw new ClientClosedError();
      return this.__dispatchIntercepted(options, target);
    } catch (err) {
      if (this.__profile.major >= 8 && target.onResponseError !== undefined) {
        // undici has no controller before dispatch starts.
        target.onResponseError(null!, err as Error);
        return false;
      }
      if (target.onError === undefined) {
        if (this.__profile.major >= 7) throw err;
        throw new InvalidArgumentError("invalid onError method");
      }
      target.onError!(err as Error);
      return false;
    }
  }

  __dispatchIntercepted(options: DispatchOptions, handler: DispatchHandlers): boolean {
    let dispatch = this.__interceptedDispatch;
    if (dispatch === null) {
      dispatch = (o: DispatchOptions, h: DispatchHandlers): boolean => this.__dispatch(o, h);
      for (let i = this.__interceptors.length - 1; i >= 0; i--) {
        dispatch = this.__interceptors[i]!(dispatch);
      }
      this.__interceptedDispatch = dispatch;
    }
    return dispatch(options, handler);
  }

  __dispatch(_options: DispatchOptions, _handler: DispatchHandlers): boolean {
    throw new Error("not implemented");
  }

  __close(): Promise<void> {
    return Promise.resolve();
  }

  __destroy(_err: Error): Promise<void> {
    return Promise.resolve();
  }
}
