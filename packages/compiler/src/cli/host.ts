import type {
  TypePatchCommandRequest,
  TypePatchCommandResult,
} from "../frontend/type-patches/command.js";
import type {
  AnalyzeOptions,
  AnalyzeResult,
  CompileLibraryOptions,
  CompileLibraryResult,
  CompileRequestOptions,
  CompileRequestResult,
} from "../compile-types.js";
import type { NativeOptimization } from "../backend/optimization.js";
import type { ProvenanceSources } from "../frontend/provenance-registry.js";

export type NativeCacheWarmProfile = "runtime" | "tls";

/** Only host operations vary between the seed and installed compiler. */
export interface CliHost {
  version: () => string;
  sourceTargetPlatform: () => string;
  analyze: (entry: string, options: AnalyzeOptions) => Promise<AnalyzeResult>;
  compile: (entry: string, options: CompileRequestOptions) => Promise<CompileRequestResult>;
  compileLibrary: (options: CompileLibraryOptions) => Promise<CompileLibraryResult>;
  resolveProvenanceSources: (entry: string) => Promise<ProvenanceSources>;
  warmNativeCaches: (options: {
    optimization?: NativeOptimization;
    sanitize: boolean;
    profiles?: NativeCacheWarmProfile[];
  }) => Promise<{
    cacheRoot: string;
    profiles: { profile: NativeCacheWarmProfile; elapsedMs: number }[];
  }>;
  /** Merges raw or indexed profiles into one indexed profile; a sparse one
   * leaves out functions that never ran. */
  mergeProfiles: (outputPath: string, inputPaths: string[], sparse: boolean) => Promise<void>;
  /** `scriptc types patch|list` (frontend/type-patches/command.ts). */
  typePatches: (request: TypePatchCommandRequest) => Promise<TypePatchCommandResult>;
  run: (binary: string) => Promise<number>;
}
