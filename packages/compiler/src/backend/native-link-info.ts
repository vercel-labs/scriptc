import type { NativeOptimization } from "./optimization.js";
import {
  formatNativeLinkInfo,
  type NativeLinkInfo,
  type NativeLinkFeatures,
} from "./native-link-info-core.js";
export type { NativeLinkInfo, NativeLinkFeatures } from "./native-link-info-core.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { loadRuntimePack } from "./runtime-pack.js";
import type { NativeTargetSpec } from "./targets.js";

export async function createNativeLinkInfo(options: {
  programObject: string;
  target: NativeTargetSpec;
  features: NativeLinkFeatures;
  ffi: FfiProfile | null;
  optimization?: NativeOptimization;
  env?: NodeJS.ProcessEnv;
}): Promise<NativeLinkInfo> {
  if (options.ffi?.frameworks?.length && options.target.platform !== "darwin")
    throw new Error("FFI frameworks require a Darwin target");
  const pack = await loadRuntimePack({
    target: options.target,
    features: options.features,
    optimization: options.optimization ?? "release",
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return formatNativeLinkInfo(options, compilerReleaseVersion(), {
    root: pack.root,
    manifest: pack.manifest,
    flavor: pack.flavor,
    selected: {
      features: pack.features,
      runtime: pack.selectedRuntimeArtifacts,
      archives: pack.selectedArchiveArtifacts,
      systemLibraries: pack.systemLibraries,
    },
  });
}
