/** Ordered executable link plans for scriptc-owned program objects.
 *
 * The plan is data, not a compiler-driver command line.  Runtime-pack
 * selection owns which objects exist, target specifications own mandatory
 * driver arguments, and this module owns the observable order in which the
 * program, FFI inputs, runtime objects/archives, and system libraries meet
 * the platform linker.
 */
import type { NativeOptimization } from "./optimization.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import type { NativeLinkFeatures } from "./native-link-info.js";
import type { NativeArtifactDependency } from "./native/contracts.js";
import { needsDarwinDebugSymbols } from "./debug-symbols.js";
import { loadRuntimePack, type RuntimePackSelection } from "./runtime-pack.js";
import { executableLinkInputs } from "./link-plan-core.js";
import type { NativeTargetSpec, WindowsSubsystem } from "./targets.js";

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
  darwinDebugSymbols?: boolean;
}

export async function createNativeLinkPlan(options: {
  target: NativeTargetSpec;
  programObject: string;
  programPartitions?: readonly string[];
  outPath: string;
  features: NativeLinkFeatures;
  ffi: FfiProfile | null;
  optimization: NativeOptimization;
  strip?: boolean;
  windowsSubsystem?: WindowsSubsystem;
  programObjectDependencies?: readonly NativeArtifactDependency[];
  env?: NodeJS.ProcessEnv;
  resolver?: (specifier: string) => string;
}): Promise<NativeLinkPlan> {
  if (options.ffi?.frameworks?.length && options.target.platform !== "darwin")
    throw new Error("FFI frameworks require a Darwin target");
  const runtimePack = await loadRuntimePack(options);
  return {
    target: options.target,
    darwinDebugSymbols: needsDarwinDebugSymbols(
      options.target.platform,
      options.optimization,
      options.strip,
    ),
    outputPath: options.outPath,
    ...executableLinkInputs({
      target: options.target,
      programObject: options.programObject,
      ...(options.programPartitions === undefined
        ? {}
        : { programPartitions: options.programPartitions }),
      ffiLibraries: options.ffi?.libraries ?? [],
      ffiSystemLibraries: options.ffi?.systemLibraries ?? [],
      ffiFrameworks: options.ffi?.frameworks ?? [],
      runtimeObjects: runtimePack.runtimeObjects,
      runtimeArchives: runtimePack.archives,
      runtimeSystemLibraries: runtimePack.systemLibraries,
      optimization: options.optimization,
      ...(options.strip === undefined ? {} : { strip: options.strip }),
      ...(options.windowsSubsystem === undefined
        ? {}
        : { windowsSubsystem: options.windowsSubsystem }),
    }),
    dependencyPaths: [...runtimePack.dependencyPaths, ...(options.ffi?.libraries ?? [])],
    programObjectDependencies: [...(options.programObjectDependencies ?? [])],
    runtimePack,
  };
}
