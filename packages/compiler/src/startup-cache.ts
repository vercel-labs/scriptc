/** Small CLI-startup surface. Importing the package root eagerly loads the
 * full lowering/emitter graph; exact builds need only these cache/native
 * identity primitives before deciding whether that graph is necessary. */
export { readRoutedExecutableCache } from "./executable/executable-cache.js";
export type { EarlyExecutableRouteOptions } from "./executable/executable-cache.js";
export {
  executableNativeEnvironmentFingerprint,
  prepareBuildCacheRoot,
  resolveBuildCacheRoot,
  resolveCc,
  targetPlatform,
} from "./backend/native-toolchain.js";
