import type { NativeOptimization } from "./optimization.js";
import { join } from "node:path";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import {
  EXTERNAL_OBJECT_ABI_STABILITY,
  RUNTIME_ABI_MARKER,
  RUNTIME_ABI_VERSION,
} from "./runtime-abi.js";
import { executableLinkInputs } from "./link-plan-core.js";
import type {
  RuntimePackArtifact,
  RuntimePackArtifacts,
  RuntimePackManifest,
} from "./runtime-pack-core.js";
import type { NativeTargetSpec } from "./targets.js";

export interface NativeLinkFeatures {
  workers?: boolean;
  dynamic: boolean;
  regex: boolean;
  copying: boolean;
  textDecoderLegacy: boolean;
  fileHandle: boolean;
  fetch: boolean;
  netIsland: boolean;
  zlib: boolean;
  assert: boolean;
  inspect: boolean;
  dynInvoke: boolean;
  dc: boolean;
  dynAsync: boolean;
  events: boolean;
  emitter: boolean;
  symbol: boolean;
  bigint: boolean;
  searchParams: boolean;
  qs: boolean;
  parseArgs: boolean;
  stream: boolean;
  net: boolean;
  http: boolean;
  http2: boolean;
  dgram: boolean;
  watch: boolean;
  foreignFfi: boolean;
  nodeTest: boolean;
  tls: boolean;
  tlsCa: boolean;
}

export interface NativeLinkInfo {
  schema: "scriptc.native-link-info.v1";
  format: 1;
  compiler_version: string;
  object_abi: {
    stability: "experimental";
    compatibility: "exact-runtime-version";
  };
  target: {
    name: NativeTargetSpec["name"];
    llvm_triple: NativeTargetSpec["llvmTriple"];
    architecture: NativeTargetSpec["architecture"];
    object_format: NativeTargetSpec["objectFormat"];
    minimum_os: NativeTargetSpec["minimumOs"];
    relocation_model: NativeTargetSpec["relocationModel"];
  };
  program: {
    object: string;
    entry_symbol: "main";
    undefined_runtime_symbol_prefix: "scr_";
  };
  runtime_abi: {
    version: typeof RUNTIME_ABI_VERSION;
    marker: typeof RUNTIME_ABI_MARKER;
  };
  runtime_pack: {
    kind: "precompiled";
    package: string;
    version: string;
    root: string;
    path_base: "runtime_pack.root";
    flavor: NativeOptimization;
    objects: RuntimePackArtifact[];
    archives: RuntimePackArtifact[];
  };
  ffi: {
    format: number | null;
    symbols: string[];
    libraries: string[];
  };
  link: {
    input_order: string[];
    driver_flags: string[];
    system_libraries: string[];
    frameworks: string[];
  };
}

/** Format the same external-link contract after either host verifies a pack. */
export function formatNativeLinkInfo(
  options: {
    programObject: string;
    target: NativeTargetSpec;
    ffi: FfiProfile | null;
  },
  compilerVersion: string,
  pack: {
    root: string;
    manifest: RuntimePackManifest;
    selected: RuntimePackArtifacts;
    flavor: NativeOptimization;
  },
): NativeLinkInfo {
  const ffiLibraries = options.ffi?.libraries ?? [];
  const plan = executableLinkInputs({
    target: options.target,
    programObject: options.programObject,
    ffiLibraries,
    ffiSystemLibraries: options.ffi?.systemLibraries ?? [],
    ffiFrameworks: options.ffi?.frameworks ?? [],
    runtimeObjects: pack.selected.runtime.map((artifact) => join(pack.root, artifact.path)),
    runtimeArchives: pack.selected.archives.map((artifact) => join(pack.root, artifact.path)),
    runtimeSystemLibraries: pack.selected.systemLibraries,
    optimization: pack.flavor,
  });
  return {
    schema: "scriptc.native-link-info.v1",
    format: 1,
    compiler_version: compilerVersion,
    object_abi: {
      stability: EXTERNAL_OBJECT_ABI_STABILITY,
      compatibility: "exact-runtime-version",
    },
    target: {
      name: options.target.name,
      llvm_triple: options.target.llvmTriple,
      architecture: options.target.architecture,
      object_format: options.target.objectFormat,
      minimum_os: options.target.minimumOs,
      relocation_model: options.target.relocationModel,
    },
    program: {
      object: options.programObject,
      entry_symbol: "main",
      undefined_runtime_symbol_prefix: "scr_",
    },
    runtime_abi: {
      version: RUNTIME_ABI_VERSION,
      marker: RUNTIME_ABI_MARKER,
    },
    runtime_pack: {
      kind: "precompiled",
      package: pack.manifest.package,
      version: pack.manifest.version,
      root: pack.root,
      path_base: "runtime_pack.root",
      flavor: pack.flavor,
      objects: pack.selected.runtime,
      archives: pack.selected.archives,
    },
    ffi: {
      format: options.ffi?.ffiFormat ?? null,
      symbols:
        options.ffi?.functions.filter((fn) => !fn.callbackOperation).map((fn) => fn.symbol) ?? [],
      libraries: [...ffiLibraries],
    },
    link: {
      input_order: plan.inputs,
      driver_flags: plan.driverFlags,
      system_libraries: plan.systemLibraries,
      frameworks: [...(options.ffi?.frameworks ?? [])],
    },
  };
}
