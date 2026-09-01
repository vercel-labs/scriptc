/** Small CLI-startup surface. Importing the package root eagerly loads the
 * full lowering/emitter graph; exact builds need only these cache/native
 * identity primitives before deciding whether that graph is necessary. */
export { readRoutedExecutableCache } from "./executable/executable-cache.js";
export type { EarlyExecutableRouteOptions } from "./executable/executable-cache.js";
export {
  executableNativeEnvironmentFingerprint,
  configuredTargetPlatform,
  legacyCExecutablePathRequested,
  resolveCc,
  targetPlatform,
} from "./backend/external-c.js";
export { prepareBuildCacheRoot, resolveBuildCacheRoot } from "./backend/build-cache.js";
export {
  executableLinkerEnvironmentFingerprint,
  resolvePlatformLinker,
} from "./backend/linker.js";
