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
import { legacyCExecutablePathRequested } from "./backend/external-c.js";
import { nativeCodegenTarget, type NativeTargetSpec } from "./backend/targets.js";

/** Whether an ordinary LLVM executable can take the helper/object plus
 * precompiled-runtime-pack route. Keep this startup-sized: the CLI bootstrap
 * needs the exact cache identity before deciding whether it must import the
 * full compiler graph. */
export function precompiledRuntimePackTarget(
  env: NodeJS.ProcessEnv = process.env,
): NativeTargetSpec | null {
  if (env["SCRIPTC_RUNTIME_PACK"] === "0" ||
    env["SCRIPTC_FETCH_CURL"] === "1" ||
    legacyCExecutablePathRequested(env)) return null;
  return nativeCodegenTarget(env);
}
