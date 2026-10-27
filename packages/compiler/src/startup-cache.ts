/** Small CLI-startup surface. Importing the package root eagerly loads the
 * full lowering/emitter graph; exact builds need only these cache/native
 * identity primitives before deciding whether that graph is necessary. */
export { readRoutedExecutableCache } from "./executable/executable-cache.js";
export type { EarlyExecutableRouteOptions } from "./executable/executable-cache.js";
export {
  executableNativeEnvironmentFingerprint,
  configuredTargetPlatform,
  resolveCc,
  targetPlatform,
} from "./backend/external-c.js";
export { prepareBuildCacheRoot, resolveBuildCacheRoot } from "./backend/build-cache.js";
export { executableLinkerEnvironmentFingerprint, resolvePlatformLinker } from "./backend/linker.js";
import { nativeCodegenTarget, type NativeTargetSpec } from "./backend/targets.js";

/** Whether an ordinary LLVM executable can take the helper/object plus
 * precompiled-runtime-pack route. Keep this startup-sized: the CLI bootstrap
 * needs the exact cache identity before deciding whether it must import the
 * full compiler graph. */
export function precompiledRuntimePackTarget(
  env: NodeJS.ProcessEnv = process.env,
): NativeTargetSpec | null {
  return nativeCodegenTarget(env);
}
export { checkerCacheIdentity } from "./frontend/ts7/checker-backend.js";
export { readCoverageVerdict } from "./coverage/verdict-startup.js";
export { coverageEnvelope, coveragePasses, renderCoverage } from "./coverage/report.js";
export { renderPerformanceWarnings } from "./diagnostics/dynamic-tier.js";
