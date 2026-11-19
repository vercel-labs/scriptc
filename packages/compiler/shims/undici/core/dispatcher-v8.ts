import { Dispatcher as LegacyDispatcher } from "./dispatcher.ts";
import type { Profile } from "./types.ts";

/** The public v8 class supplies its protocol to inherited request() calls. */
export class Dispatcher extends LegacyDispatcher {
  __undiciProfile(): Profile {
    return { major: 8 };
  }
}

export declare namespace Dispatcher {
  export import DispatchOptions = LegacyDispatcher.DispatchOptions;
  export import DispatchHandler = LegacyDispatcher.DispatchHandler;
  export import DispatchController = LegacyDispatcher.DispatchController;
  export import DispatchInterceptor = LegacyDispatcher.DispatchInterceptor;
  export import Dispatch = LegacyDispatcher.Dispatch;
  export import HttpMethod = LegacyDispatcher.HttpMethod;
  export import UndiciHeaders = LegacyDispatcher.UndiciHeaders;
  export import RequestOptions = LegacyDispatcher.RequestOptions;
  export import ResponseData = LegacyDispatcher.ResponseData;
}
