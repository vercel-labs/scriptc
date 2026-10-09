import type { WindowsSubsystem } from "./backend/targets.js";
import type { NativeLinkInfo } from "./backend/native-link-info.js";
import type { NativeOptimization } from "./backend/optimization.js";
import type { ScrDiagnostic } from "./diagnostics/diagnostic.js";
import type { CoverageInput } from "./coverage/report.js";

export type CompileOutputKind = "ir" | "llvm" | "asm" | "obj" | "exe";

export interface CompileBaseOptions {
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
  /** Embed the dynamic-island engine (--dynamic). Off = the static default:
   * island constructs are diagnostics and nothing about codegen or linking
   * changes. */
  dynamic?: boolean;
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
  /** --npm-static: package names whose shipped, unminified JS compiles
   * STATICALLY as program modules (inference types the bodies; statements
   * the lowering cannot prove become runtime fences). "auto" opts in every
   * directly-imported package passing the eligibility heuristics (own
   * .d.ts, unminified JS, no build-transform markers). A package whose
   * preflight refuses marks itself an offender and falls back to the
   * island (--dynamic) or the requires-dynamic diagnostic (static builds)
   * — never a silent misbuild. Off by default: nothing changes without
   * the flag. */
  npmStatic?: readonly string[] | "auto";
  /** Outbound native FFI manifest. Its signature-only TypeScript bindings
   * lower to direct C ABI calls. Source outputs retain those declarations;
   * archive/system-library inputs join only an executable link. */
  ffiProfilePath?: string;
  /** Attach the machine-readable external link recipe to an object result.
   * Valid only with outputKind "obj"; it never invokes a linker. */
  nativeLinkInfo?: boolean;
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
  /** Analyze as a --dynamic build (island constructs lower instead of
   * producing requires-dynamic diagnostics). */
  dynamic?: boolean;
  /** --npm-static (see CompileOptions.npmStatic): the analysis compiles
   * opted-in packages' JS as program modules and the coverage report
   * carries each package's static/fallback status. */
  npmStatic?: readonly string[] | "auto";
  /** Analyze with the outbound native bindings from this FFI manifest. */
  ffiProfilePath?: string;
  /** Coverage-only external host type surfaces: exact bare module
   * specifier → local declaration file. The checker uses the declarations
   * to analyze project code, but imported runtime values remain explicit
   * SC1010 blockers rather than being counted as executable. */
  externalTypes?: Readonly<Record<string, string>>;
}

export interface AnalyzeResult {
  coverage: CoverageInput;
  sourceTexts: Map<string, string>;
}
