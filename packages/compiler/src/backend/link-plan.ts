/** Ordered executable link plans for scriptc-owned program objects.
 *
 * The plan is data, not a compiler-driver command line.  Runtime-pack
 * selection owns which objects exist, target specifications own mandatory
 * driver arguments, and this module owns the observable order in which the
 * program, FFI inputs, runtime objects/archives, and system libraries meet
 * the platform linker.
 */
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import type { NativeArtifactDependency } from "./native-toolchain.js";
import { loadRuntimePack, type RuntimePackSelection } from "./runtime-pack.js";
import type { NativeTargetSpec } from "./targets.js";

export interface NativeLinkPlan {
  target: NativeTargetSpec;
  outputPath: string;
  /** Object/archive order is intentional. In particular FFI archives must
   * follow the generated program object and precede runtime archives. */
  inputs: string[];
  systemLibraries: string[];
  driverFlags: string[];
  dependencyPaths: string[];
  /** Inputs already snapshotted by the program-object emitter. */
  programObjectDependencies: NativeArtifactDependency[];
  runtimePack: RuntimePackSelection;
}

export async function createNativeLinkPlan(options: {
  target: NativeTargetSpec;
  programObject: string;
  outPath: string;
  features: NativeLinkFeatures;
  ffi: FfiProfile | null;
  optimization: "release" | "dev";
  programObjectDependencies?: readonly NativeArtifactDependency[];
  env?: NodeJS.ProcessEnv;
  resolver?: (specifier: string) => string;
}): Promise<NativeLinkPlan> {
  const runtimePack = await loadRuntimePack(options);
  return {
    target: options.target,
    outputPath: options.outPath,
    inputs: [
      options.programObject,
      ...(options.ffi?.libraries ?? []),
      ...runtimePack.runtimeObjects,
      ...runtimePack.archives,
    ],
    systemLibraries: [...new Set([
      ...(options.ffi?.systemLibraries ?? []),
      ...runtimePack.systemLibraries,
    ])],
    driverFlags: options.target.executableLinkerArgs.map((arg, index, args) =>
      index > 0 && args[index - 1] === "-target" ? options.target.linkerTargetTriple : arg
    ),
    dependencyPaths: [
      ...runtimePack.dependencyPaths,
      ...(options.ffi?.libraries ?? []),
    ],
    programObjectDependencies: [...(options.programObjectDependencies ?? [])],
    runtimePack,
  };
}
