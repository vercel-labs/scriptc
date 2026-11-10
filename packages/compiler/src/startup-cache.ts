/** Small CLI-startup surface. Importing the package root eagerly loads the
 * full lowering/emitter graph; exact builds need only these cache/native
 * identity primitives before deciding whether that graph is necessary. */
export { readRoutedExecutableCache } from "./executable/executable-cache.js";
import { nodeCompilerPackage } from "./node-islands/compiler-package-node.js";
import { libnodeCacheKey as islandLibnodeCacheKey } from "./node-islands/libnode.js";
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
export { isPerformanceCode, renderPerformanceWarnings } from "./diagnostics/dynamic-tier.js";

/** The identity of the libnode pack a build records (node-islands/libnode.ts
 * libnodeCacheKey), as the full compiler computes it. Startup has not
 * installed the island build host (host-node.ts), so it names Node's answer
 * for a pack installed beside the compiler itself: without it, such a pack
 * would have no identity here and every cached island executable would miss. */
export function libnodeCacheKey(
  option: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  projectDir: string = process.cwd(),
): string | undefined {
  return islandLibnodeCacheKey(option, env, projectDir, nodeCompilerPackage);
}
