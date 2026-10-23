import type { WindowsSubsystem } from "./backend/targets.js";
import type { NativeLinkInfo } from "./backend/native-link-info.js";
import type { NativeOptimization } from "./backend/optimization.js";
import type { ScrDiagnostic } from "./diagnostics/diagnostic.js";
import type { CoverageInput } from "./coverage/report.js";
import type { TierMode } from "./frontend/tier-analysis.js";
import type { NodeIslandOptions } from "./node-islands/policy.js";

export type CompileOutputKind = "ir" | "llvm" | "asm" | "obj" | "exe";

export interface CompileBaseOptions {
  /** The Node island policy's command-line half (`--node-islands`,
   * `--node-island`, `--native`): which npm packages run in Node islands. */
  nodeIslands?: NodeIslandOptions;
  /** Primary artifact path. The CLI supplies the output-kind default. */
  outPath: string;
  /** Where generated intermediates and compatibility side artifacts land. */
  outDir: string;
  /** @deprecated This option no longer controls output cleanup; sibling artifacts are retained. */
  defaultOutputPath?: boolean;
  /** Compatibility-only additive IR side artifact for executable builds.
   * The CLI's deprecated --emit-ir flag supplies this option. */
  emitIr?: boolean;
  sanitize?: boolean;
  /** LLVM is the production code generator. */
  backend?: "llvm";
  /** Native optimization posture. Release is the shipped -O2 default; dev
   * uses -O0, source line tables, and stable multi-TU object caching for
   * large LLVM programs. Darwin executables include an adjacent .dSYM. Speed
   * is -O2 plus size-for-speed optimizations (larger executables, longer
   * builds); release output never depends on them. */
  optimization?: NativeOptimization;
  /** Remove symbol/debug payload from an executable at link time. */
  strip?: boolean;
  /** Windows PE executable subsystem. Console is the default; GUI suppresses
   * automatic console-window creation. Only valid for Windows executables. */
  windowsSubsystem?: WindowsSubsystem;
  /** On Linux, hand the address-space teardown after `process.exit` to a
   * helper process so the parent sees the exit sooner. The helper keeps the
   * executable mapped and the memory charged for up to ~100 ms after exit.
   * Executables only; no effect on other platforms. */
  detachedExit?: boolean;
  /** Where a program that calls into Node.js (@scriptc/node) loads Node
   * from: a libnode pack directory recorded into the executable, or
   * "beside" to copy the pack next to the executable. Default: the pack in
   * SCRIPTC_LIBNODE at build time. SCRIPTC_LIBNODE overrides the recorded
   * directory at run time (node-islands/libnode.ts). */
  libnode?: string;
  /** Instrument the executable for profile-guided optimization. Each run
   * writes a raw profile to this path pattern (`%p` expands to the process
   * id; `LLVM_PROFILE_FILE` overrides the pattern at run time). Linux
   * executables only. */
  profileGenerate?: string;
  /** Optimize the executable with this indexed profile (`scriptc
   * merge-profiles`). Code the profile does not describe, or describes
   * from an older version of the program, is optimized as without one. */
  profileUse?: string;

  /** Eligible packages compile automatically. Explicit names override automatic selection heuristics. */
  npmStatic?: readonly string[] | "auto";
  /** Outbound native FFI manifest. Its signature-only TypeScript bindings
   * lower to direct C ABI calls. Source outputs retain those declarations;
   * archive/system-library inputs join only an executable link. */
  ffiProfilePath?: string;
  /** Attach the machine-readable external link recipe to an object result.
   * Valid only with outputKind "obj"; it never invokes a linker. */
  nativeLinkInfo?: boolean;
  /** `--tier` (frontend/tier-analysis.ts). "static-only" keeps every demotion
   * request a refusal (design invariant I2). Until demotion lands both modes
   * compile exactly as before. */
  tier?: TierMode;
}

/** Executable compile options. This remains the compatibility type for the
 * historical compile() API, whose omitted output kind means executable. */
export interface CompileOptions extends CompileBaseOptions {
  outputKind?: "exe";
  /** Internal validation lane retained for helper-object artifact tests.
   * Supported ordinary LLVM executable builds select this path automatically. */
  nativeProgramObject?: boolean;
}

/** Source-artifact compile options, discriminated by the required kind. */
export interface CompileSourceOptions extends CompileBaseOptions {
  outputKind: Exclude<CompileOutputKind, "exe">;
}

/** Internal/dynamic request shape for callers that select the kind at runtime.
 * Statically executable/source callers should prefer the narrower interfaces. */
export interface CompileRequestOptions extends CompileBaseOptions {
  outputKind?: CompileOutputKind;
  /** Internal validation lane for executable requests. */
  nativeProgramObject?: boolean;
}

export type CompileArtifact =
  | { kind: "ir"; path: string }
  | { kind: "llvm"; path: string }
  | { kind: "asm"; path: string }
  | { kind: "obj"; path: string; nativeLinkInfo?: NativeLinkInfo }
  | {
      kind: "exe";
      path: string;
      translationUnitPath: string;
      backend: "llvm";
    };

export type CompileFailure = {
  ok: false;
  diagnostics: ScrDiagnostic[];
  sourceTexts: Map<string, string>;
};

/** Non-failing findings of a successful build: divergence warnings
 * (SC6xxx — sites that compile but can behave differently from Node), with
 * the sources they point into. Present only when the build lowered the
 * program and found at least one; a cache hit that skips lowering carries
 * none (`scriptc coverage` always reports them). */
export interface CompileWarnings {
  warnings?: ScrDiagnostic[];
  sourceTexts?: Map<string, string>;
}

export type CompileSourceResult =
  | ({
      ok: true;
      artifact: Extract<CompileArtifact, { kind: "ir" | "llvm" | "asm" | "obj" }>;
    } & CompileWarnings)
  | CompileFailure;

/** Historical executable result shape retained for source compatibility. */
export type CompileResult =
  | {
      ok: true;
      binaryPath: string;
      llvmPath: string;
      irPath?: string;
      backend: "llvm";
    }
  | CompileFailure;

export type CompileExecutableResult =
  /** The generated LLVM source is retained beside the executable. */
  | (Extract<CompileResult, { ok: true }> & {
      artifact: Extract<CompileArtifact, { kind: "exe" }>;
    } & CompileWarnings)
  | CompileFailure;

/** Result union for callers that choose outputKind dynamically. */
export type CompileRequestResult = CompileSourceResult | CompileExecutableResult;

export interface CompileLibraryOptions {
  profilePath: string;
  /** Where the archive and the kept program TU land. */
  outDir: string;
  /** Artifact path. Default: <stem>.lib.a, or <stem>.wasm for wasm32-wasi. */
  outPath?: string;
  emitIr?: boolean;
  sanitize?: boolean;
}

export type CompileLibraryResult =
  /** `sidecarPath` is present exactly when the profile declares a
   * `sidecar` section: the contract JSON written beside the archive by
   * the same invocation (ask 2). */
  | {
      ok: true;
      archivePath: string;
      llvmPath: string;
      backend: "llvm";
      irPath?: string;
      sidecarPath?: string;
    }
  | { ok: false; diagnostics: ScrDiagnostic[]; sourceTexts: Map<string, string> };

export interface AnalyzeOptions {
  /** --npm-static (see CompileOptions.npmStatic): the analysis compiles
   * opted-in packages' JS as program modules and the coverage report
   * carries each package's native/refused status. */
  npmStatic?: readonly string[] | "auto";
  /** Analyze with the outbound native bindings from this FFI manifest. */
  ffiProfilePath?: string;
  /** Coverage-only external host type surfaces: exact bare module
   * specifier → local declaration file. The checker uses the declarations
   * to analyze project code, but imported runtime values remain explicit
   * SC1010 blockers rather than being counted as executable. */
  externalTypes?: Readonly<Record<string, string>>;
  /** `--tier` (see CompileBaseOptions.tier). */
  tier?: TierMode;
  /** `--explain-dynamic`: attach the tier-assignment report
   * (CoverageInput.tiers). Such analyses bypass the verdict cache. */
  explainDynamic?: boolean;
  /** `--wasm <file>`: WebAssembly module files the program loads that its
   * sources do not name (absolute paths); reported with the discovered ones. */
  wasm?: readonly string[];
  /** The Node island policy's command-line half (report-only: coverage
   * reports which packages and modules would run in a Node island). */
  nodeIslands?: NodeIslandOptions;
}

export interface AnalyzeResult {
  coverage: CoverageInput;
  sourceTexts: Map<string, string>;
}
