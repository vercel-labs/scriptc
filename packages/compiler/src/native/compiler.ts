import type { NativeOptimization } from "../backend/optimization.js";
import { compilationTiming } from "../timing.js";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeTextPartsSync } from "./text-file.js";
import type {
  AnalyzeOptions,
  AnalyzeResult,
  CompileFailure,
  CompileLibraryOptions,
  CompileLibraryResult,
  CompileRequestOptions,
  CompileRequestResult,
} from "../compile-types.js";
import { LlvmUnsupportedError } from "../backend/llvm/emitter.js";
import { executableLinkInputs, systemLibraryLinkerArgs } from "../backend/link-plan-core.js";
import { formatNativeLinkInfo } from "../backend/native-link-info-core.js";
import {
  emitNativeObject,
  requireNativeArtifact,
  runNativeTool,
  verifyNativeHelper,
  type NativeHelperVerification,
} from "../backend/native-tools.js";
import {
  type NativeRuntimeSelection,
  selectNativeRuntimePack,
  runtimePackManifest,
  stageNativeRuntimeSelection,
  type RuntimePackStore,
} from "../backend/runtime-pack-native.js";
import { RuntimePackError } from "../backend/runtime-pack-core.js";
import {
  NativeCodegenError,
  nativeCodegenParts,
  nativePartitionPaths,
  nativeProgramPartitions,
} from "../backend/native-codegen-core.js";
import { llvmRefusalDiag } from "../backend/target-diagnostics.js";
import { nativeCodegenDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { loadFfiProfile, type FfiProfile } from "../ffi/ffi-manifest.js";
import { analyzeWithFrontend } from "../frontend/analysis.js";
import { analyzeWithVerdictCache } from "../coverage/verdict-cache.js";
import type { FrontendFactory } from "../frontend/pipeline.js";
import { runNativeFrontend } from "../frontend/pipeline-native.js";
import { loadLibraryProfile } from "../library/library-profile.js";
import {
  libraryLocalizeSymbols,
  libraryWasmExports,
  libraryWasmRefusal,
} from "../library/prepare.js";
import { clearFenceEvalCaches } from "../library/fence-eval.js";
import { archiveNativeLibrary, localizeNativeLibrary, linkNativeWasmLibrary } from "./library.js";
import type { NativeToolchain } from "./toolchain.js";
import { evaluateNativeComptime } from "./comptime.js";
import { contentDigest, fileDigest, partsDigest, type NativeCache } from "./cache.js";
import {
  nativeProfileKey,
  nativeProfileRefusal,
  parseNativeProfileMatch,
  type NativeProfileMatch,
  type NativeProfileOptions,
} from "../backend/native-profile.js";
import { splitLlvmLibraryProgram } from "../backend/llvm/split.js";
import { prepareNativeExecutable, prepareNativeLibrary } from "./prepare.js";
import { buildSanitizedRuntime, sanitizerDriver, sanitizerFlags } from "./sanitizer.js";
import { inputsWithoutLld, lldLinkerArgs } from "../backend/lld.js";
import { openNativeExecutableCache } from "./executable-cache.js";
import { LinkerJobs } from "./linker-job.js";
import { nativeFileIdentity } from "./file-identity.js";
import {
  staticExecutableRefusal,
  staticLinkFailureNote,
  staticLinkMapArgs,
  staticLinkRefusal,
} from "../backend/targets.js";

/** The first partition keeps the whole-object key used before partitioning. */
function partitionCacheKey(key: string, index: number): string {
  return index === 0 ? key : contentDigest(`${key}:${index}`);
}

/** The object cache entry that holds a cached program's profile match. */
function profileMatchCacheKey(key: string): string {
  return contentDigest(`${key}:profile-match`);
}

/** A program's native objects, and how a --profile-use build's profile
 * matched its functions. */
interface NativeObjects {
  paths: string[];
  profileMatch?: NativeProfileMatch;
}

function failure(error: unknown, entry: string, sources: Map<string, string>): CompileFailure {
  return {
    ok: false,
    diagnostics: [
      nativeCodegenDiag("SC3004", error instanceof Error ? error.message : String(error), entry),
    ],
    sourceTexts: sources,
  };
}

/** The request's profile. An indexed profile is read here so every cache keys
 * its bytes. */
function nativeProfile(options: CompileRequestOptions): NativeProfileOptions | undefined {
  if (options.profileGenerate !== undefined) return { generate: options.profileGenerate };
  if (options.profileUse === undefined) return undefined;
  const path = resolve(options.profileUse);
  try {
    return { use: { path, digest: contentDigest(readFileSync(path)) } };
  } catch (error) {
    throw new NativeCodegenError(
      "SC3002",
      `cannot read --profile-use file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Shared frontend semantics with native processes for code generation and linking. */
export class NativeCompiler {
  private readonly frontend: FrontendFactory;

  constructor(
    readonly toolchain: NativeToolchain,
    private readonly cache: NativeCache | null = null,
  ) {
    const evaluator = toolchain.comptimeExecutable;
    this.frontend = (entry, npmStatic, externalTypes, libraryNpmStatic, options) =>
      runNativeFrontend(
        entry,
        toolchain.ts7Executable,
        npmStatic,
        externalTypes,
        evaluator === undefined
          ? undefined
          : (source, timeout) =>
              evaluateNativeComptime(source, timeout, toolchain.ts7Executable, evaluator),
        libraryNpmStatic,
        options,
      );
  }

  analyze(entry: string, options: AnalyzeOptions): AnalyzeResult {
    return analyzeWithFrontend(
      resolve(entry),
      options,
      this.toolchain.target.platform,
      this.frontend,
    );
  }

  /** analyze() behind the coverage verdict cache: an unchanged program
   * replays the previous verdict (exact probe replay; comment-only edits
   * relower here, since the token comparison is the Node frontend's). */
  analyzeCached(entry: string, options: AnalyzeOptions): AnalyzeResult {
    entry = resolve(entry);
    const cache = this.cache;
    if (cache === null) return this.analyze(entry, options);
    let identity: string;
    try {
      identity = `${this.toolchain.compilerVersion}\0${nativeFileIdentity(process.execPath)}`;
    } catch {
      return this.analyze(entry, options);
    }
    const { result } = analyzeWithVerdictCache(
      entry,
      options,
      {
        store: {
          read: (key) => cache.read("coverage", key)?.toString("utf8") ?? null,
          write: (key, text) => cache.write("coverage", key, text),
        },
        identity,
        platform: this.toolchain.target.platform,
      },
      () => this.analyze(entry, options),
    );
    return result;
  }

  /** Runtime pack selections and verified artifact identities, kept in the
   * cache. */
  private runtimePackStore(): RuntimePackStore | undefined {
    const cache = this.cache;
    if (cache === null) return undefined;
    return {
      read: (key) => cache.read("runtime-pack", key)?.toString("utf8") ?? null,
      write: (key, text) => cache.write("runtime-pack", key, text),
    };
  }

  /** The helpers whose `version` answer this cache recorded, by file identity:
   * the probe runs again only when the helper file changes. */
  private helperVerification(): { verified?: NativeHelperVerification } {
    const cache = this.cache;
    const toolchain = this.toolchain;
    if (cache === null) return {};
    let identity: string;
    let key: string;
    try {
      identity = nativeFileIdentity(toolchain.helperExecutable);
      key = contentDigest(
        JSON.stringify({
          schema: 1,
          helper: identity,
          compiler: nativeFileIdentity(process.execPath),
          version: toolchain.compilerVersion,
          target: toolchain.target.name,
          package: toolchain.helper.packageName,
        }),
      );
    } catch {
      return {};
    }
    return {
      verified: {
        known: () => cache.read("helper", key) !== null,
        remember: () => {
          try {
            if (nativeFileIdentity(toolchain.helperExecutable) === identity)
              cache.write("helper", key, "verified\n");
          } catch {
            /* A failed write only means probing again next time. */
          }
        },
      },
    };
  }

  private emitObject(
    input: string,
    output: string,
    source: string,
    optimization: NativeOptimization,
    outputKind: "obj" | "asm",
    partitions = 1,
    profile?: NativeProfileOptions,
    llvmDigest: () => string = () => fileDigest(input),
    splitCodegen = false,
  ): NativeObjects {
    const toolchain = this.toolchain;
    const outputs = nativePartitionPaths(output, partitions);
    const helperOptions = {
      executable: toolchain.helperExecutable,
      packageRoot: toolchain.helperPackageRoot,
      compilerVersion: toolchain.compilerVersion,
      target: toolchain.target,
      helper: toolchain.helper,
      ...this.helperVerification(),
    };
    let key: string | null = null;
    let identity: string | null = null;
    if (this.cache !== null && process.env["SCRIPTC_LLVM_HELPER"] === undefined) {
      try {
        identity = nativeFileIdentity(toolchain.helperExecutable);
        key = contentDigest(
          JSON.stringify({
            schema: 1,
            llvm: llvmDigest(),
            outputKind,
            optimization,
            source,
            target: toolchain.target,
            helper: identity,
            identity: readFileSync(join(toolchain.helperPackageRoot, "package.json"), "utf8"),
            version: toolchain.compilerVersion,
            ...(partitions > 1 ? { partitions } : {}),
            ...(splitCodegen ? { split: "codegen" } : {}),
            ...(profile === undefined ? {} : { profile: nativeProfileKey(profile) }),
          }),
        );
        const cached = outputs.map((_, index) =>
          this.cache!.read("object", partitionCacheKey(key!, index)),
        );
        if (cached.every((bytes) => bytes !== null)) {
          verifyNativeHelper(helperOptions);
          if (nativeFileIdentity(toolchain.helperExecutable) === identity) {
            cached.forEach((bytes, index) => writeFileSync(outputs[index]!, bytes!));
            if (profile?.use === undefined) return { paths: outputs };
            // Without the cached match, every partition's counts are unknown.
            const match = this.cache.read("object", profileMatchCacheKey(key));
            return {
              paths: outputs,
              profileMatch: (match === null
                ? null
                : parseNativeProfileMatch(match.toString("utf8"))) ?? {
                annotated: 0,
                mismatched: 0,
                missing: 0,
                unknownPartitions: outputs.length,
              },
            };
          }
          key = null;
        }
      } catch {
        key = null;
      }
    }
    const partitionCache =
      this.cache === null || identity === null || partitions < 2 || splitCodegen
        ? null
        : this.cache.partitionDirectory(identity);
    const { profileMatch } = emitNativeObject({
      ...helperOptions,
      inputPath: input,
      outputPath: output,
      sourcePath: source,
      optimization,
      outputKind,
      partitions,
      ...(splitCodegen ? { splitCodegen } : {}),
      ...(partitionCache === null ? {} : { partitionCache }),
      ...(profile === undefined ? {} : { profile }),
    });
    if (this.cache !== null && key !== null) {
      try {
        if (nativeFileIdentity(toolchain.helperExecutable) === identity) {
          // The match goes in first: a reader that finds every partition finds it too.
          if (profileMatch !== null)
            this.cache.write(
              "object",
              profileMatchCacheKey(key),
              `${JSON.stringify({
                profile: {
                  annotated: profileMatch.annotated,
                  mismatched: profileMatch.mismatched,
                  missing: profileMatch.missing,
                  unknown_partitions: profileMatch.unknownPartitions,
                },
              })}\n`,
            );
          outputs.forEach((path, index) =>
            this.cache!.write("object", partitionCacheKey(key!, index), readFileSync(path)),
          );
        }
      } catch {
        /* An updated helper or unavailable cache only prevents reuse. */
      }
    }
    return profileMatch === null ? { paths: outputs } : { paths: outputs, profileMatch };
  }

  private emitProgramObject(
    input: string,
    output: string,
    source: string,
    optimization: NativeOptimization,
    stage: string,
    library: boolean,
    profile?: NativeProfileOptions,
    llvmDigest?: () => string,
  ): NativeObjects {
    // Library archives merge dev shards relocatably; executables link the
    // helper's program partitions directly.
    const llvm =
      library && optimization === "dev" && this.toolchain.target.platform !== "wasi"
        ? readFileSync(input, "utf8")
        : null;
    const split = llvm === null ? null : splitLlvmLibraryProgram(llvm);
    if (split === null) {
      const size = statSync(input).size;
      // An optimized program that stays one partition is optimized whole and
      // generates code for its parts concurrently.
      const codegenParts = library || optimization === "dev" ? 1 : nativeCodegenParts(size);
      const partitions = library ? 1 : Math.max(nativeProgramPartitions(size), codegenParts);
      return this.emitObject(
        input,
        output,
        source,
        optimization,
        "obj",
        partitions,
        profile,
        llvmDigest,
        codegenParts > 1,
      );
    }
    const objects: string[] = [];
    for (const [index, shard] of split.shards.entries()) {
      const shardInput = join(stage, `shard-${index}.ll`);
      const shardOutput = join(stage, `shard-${index}` + this.toolchain.target.outputSuffixes.obj);
      writeFileSync(shardInput, shard.source());
      this.emitObject(shardInput, shardOutput, source + "." + shard.name, optimization, "obj");
      objects.push(shardOutput);
    }
    const merged = localizeNativeLibrary(this.toolchain, stage, objects, [], split.publicSymbols);
    renameSync(merged, output);
    return { paths: [output] };
  }

  compile(entry: string, options: CompileRequestOptions): CompileRequestResult {
    const sink: { warnings: ScrDiagnostic[]; sources: Map<string, string> } = {
      warnings: [],
      sources: new Map(),
    };
    const result = this.compileWithWarnings(entry, options, sink);
    // Divergence warnings ride a successful result (never a failure).
    if (!result.ok || sink.warnings.length === 0) return result;
    return { ...result, warnings: sink.warnings, sourceTexts: sink.sources };
  }

  private compileWithWarnings(
    entry: string,
    options: CompileRequestOptions,
    sink: { warnings: ScrDiagnostic[]; sources: Map<string, string> },
  ): CompileRequestResult {
    const timing = compilationTiming();
    const toolchain = this.toolchain;
    const target = toolchain.target;
    const output = resolve(options.outPath);
    const outputKind = options.outputKind ?? "exe";
    const optimization = options.optimization ?? "release";
    entry = resolve(entry);
    let sourceTexts = new Map<string, string>();
    let stage: string | null = null;
    try {
      if (entry === output) throw new Error("output path must differ from the entry source");
      if (outputKind === "exe" && !target.supports.exe)
        throw new NativeCodegenError(
          "SC3002",
          `${target.name} supports library archives, not executables`,
        );
      if (options.sanitize && (outputKind === "asm" || outputKind === "obj")) {
        throw new NativeCodegenError(
          "SC3002",
          `--sanitize is not supported with --emit=${outputKind}; AddressSanitizer instrumentation parity is not available in the LLVM native helper yet`,
        );
      }
      if (options.sanitize) sanitizerDriver(toolchain);
      const profileRefusal = nativeProfileRefusal({
        ...options,
        outputKind,
        optimization,
        sanitize: options.sanitize ?? false,
        platform: target.platform,
      });
      if (profileRefusal !== null) throw new NativeCodegenError("SC3002", profileRefusal);
      const staticRefusal = staticLinkRefusal({
        staticLink: options.staticLink,
        outputKind,
        sanitize: options.sanitize ?? false,
        target,
      });
      if (staticRefusal !== null) throw new NativeCodegenError("SC3002", staticRefusal);
      const profile = nativeProfile(options);
      let ffi: FfiProfile | null = null;
      if (options.ffiProfilePath !== undefined) {
        const loaded = loadFfiProfile(resolve(options.ffiProfilePath));
        if (!loaded.ok) return { ok: false, diagnostics: loaded.diagnostics, sourceTexts };
        ffi = loaded.profile;
      }
      const prepared = prepareNativeExecutable(
        entry,
        options,
        ffi,
        toolchain,
        this.frontend,
        this.cache,
        timing,
      );
      if (!prepared.ok) return prepared;
      sourceTexts = new Map(prepared.sources);
      if (prepared.warnings !== undefined && prepared.warnings.length > 0) {
        sink.warnings = prepared.warnings;
        sink.sources = sourceTexts;
      }
      mkdirSync(dirname(output), { recursive: true });
      stage = mkdtempSync(join(dirname(output), ".scriptc-native-"));
      const stagedOutput = join(stage, basename(output));
      const stem = basename(entry).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
      const llvmPath = join(options.outDir, `${stem}.ll`);
      if (outputKind === "ir") {
        writeTextPartsSync(stagedOutput, prepared.ir!);
        renameSync(stagedOutput, output);
        return { ok: true, artifact: { kind: "ir", path: output } };
      }
      const { llvm, features } = prepared;
      // The executable and object caches key the same LLVM text.
      let llvmDigest: string | undefined;
      const digestLlvm = (): string => (llvmDigest ??= partsDigest(llvm));
      const inputDirectory = join(stage, "input");
      mkdirSync(inputDirectory);
      const llvmInput = outputKind === "llvm" ? stagedOutput : join(inputDirectory, "program.ll");
      // In slices: the module text is never encoded whole.
      writeTextPartsSync(llvmInput, llvm);
      timing("llvm-write");
      if (outputKind === "llvm") {
        renameSync(stagedOutput, output);
        return { ok: true, artifact: { kind: "llvm", path: output } };
      }
      const object =
        outputKind === "exe"
          ? join(inputDirectory, "program" + target.outputSuffixes.obj)
          : stagedOutput;
      let executablePack: NativeRuntimeSelection | null = null;
      const selectPack = (): NativeRuntimeSelection =>
        (executablePack ??= selectNativeRuntimePack(
          toolchain.runtimePackRoot,
          target,
          toolchain.compilerVersion,
          features,
          optimization,
          "executable",
          this.runtimePackStore(),
        ));
      const executableCache =
        outputKind === "exe"
          ? openNativeExecutableCache(this.cache, toolchain, digestLlvm, options, ffi, {
              root: toolchain.runtimePackRoot,
              features,
              flavor: optimization,
              select: selectPack,
            })
          : null;
      // An unchanged rebuild keeps the executable the last build left.
      const kept = executableCache?.keep(output) ?? false;
      const restored = kept || (executableCache?.restore(stagedOutput) ?? false);
      timing(restored ? "executable-cache-hit" : "executable-cache-miss");
      // The executable cache leaves out --profile-use builds, so this is set
      // whenever the build has a profile to report.
      let profileMatch: NativeProfileMatch | undefined;
      if (!restored) {
        // A missing or invalid runtime pack fails before code generation.
        if (outputKind === "exe") selectPack();
        let programObjects = [object];
        if (options.sanitize) {
          runNativeTool(sanitizerDriver(toolchain), [
            ...sanitizerFlags(toolchain, optimization),
            "-c",
            llvmInput,
            "-o",
            object,
          ]);
          requireNativeArtifact(object);
        } else if (outputKind === "exe") {
          const objects = this.emitProgramObject(
            llvmInput,
            object,
            entry,
            optimization,
            stage,
            false,
            profile,
            digestLlvm,
          );
          programObjects = objects.paths;
          profileMatch = objects.profileMatch;
        } else
          this.emitObject(
            llvmInput,
            object,
            entry,
            optimization,
            outputKind === "asm" ? "asm" : "obj",
          );
        timing("native-object");
        if (outputKind === "asm" || outputKind === "obj") {
          const pack =
            outputKind === "obj" && options.nativeLinkInfo
              ? selectNativeRuntimePack(
                  toolchain.runtimePackRoot,
                  target,
                  toolchain.compilerVersion,
                  features,
                  optimization,
                  "executable",
                  this.runtimePackStore(),
                )
              : null;
          if (pack !== null)
            stageNativeRuntimeSelection(pack, join(stage, "runtime"), this.runtimePackStore());
          const info =
            pack === null
              ? undefined
              : formatNativeLinkInfo(
                  { programObject: output, target, ffi },
                  toolchain.compilerVersion,
                  {
                    root: pack.root,
                    manifest: runtimePackManifest(pack),
                    selected: pack.selected,
                    flavor: pack.flavor,
                  },
                );
          renameSync(stagedOutput, output);
          return {
            ok: true,
            artifact: {
              kind: outputKind,
              path: output,
              ...(info === undefined ? {} : { nativeLinkInfo: info }),
            },
          };
        }
        const pack = selectPack();
        const runtime = options.sanitize
          ? buildSanitizedRuntime(toolchain, pack, join(stage, "runtime"), "executable", this.cache)
          : stageNativeRuntimeSelection(pack, join(stage, "runtime"), this.runtimePackStore());
        timing("runtime-stage");
        const plan = executableLinkInputs({
          target,
          programObject: object,
          programPartitions: programObjects.slice(1),
          ffiLibraries: ffi?.libraries ?? [],
          ffiSystemLibraries: ffi?.systemLibraries ?? [],
          ffiFrameworks: ffi?.frameworks ?? [],
          runtimeObjects: runtime.runtimeObjects,
          runtimeArchives: runtime.archives,
          runtimeSystemLibraries: runtime.systemLibraries,
          optimization,
          strip: options.strip ?? false,
          staticLink: options.staticLink ?? false,
          ...(options.windowsSubsystem === undefined
            ? {}
            : { windowsSubsystem: options.windowsSubsystem }),
          ...(profile?.generate === undefined ? {} : { profileGenerate: true }),
        });
        // Linux links with lld when the driver finds it.
        const lld = options.sanitize ? [] : lldLinkerArgs(target.platform, toolchain.linker);
        const linkMap = join(stage, "link.map");
        const mapArgs = staticLinkMapArgs(target, options.staticLink === true, linkMap);
        const linkArgsWith = (withLld: boolean): string[] => [
          ...(options.sanitize ? ["-fsanitize=address"] : toolchain.linkerArgs),
          ...(withLld ? lld : []),
          ...plan.driverFlags,
          ...mapArgs,
          ...(withLld ? plan.inputs : inputsWithoutLld(target.platform, plan.inputs)),
          ...systemLibraryLinkerArgs(target, plan.systemLibraries),
          "-o",
          stagedOutput,
        ];
        const linkArgs = linkArgsWith(lld.length !== 0);
        // Host Linux links with lld run the linker job the driver would.
        const jobs = LinkerJobs.open(this.cache, toolchain, lld, options.sanitize ?? false);
        const job = jobs?.link(
          [...plan.inputs, stagedOutput, ...(mapArgs.length === 0 ? [] : [linkMap])],
          stage,
        );
        const cacheable = executableCache?.trace(linkArgs, stage, job) ?? false;
        timing("link-inputs");
        // A successful dependency trace already produced this executable.
        // Keep its verified output instead of asking the linker to repeat it.
        if (!cacheable && (job?.run(linkArgs, true) ?? null) === null) {
          const driver = options.sanitize ? sanitizerDriver(toolchain) : toolchain.linker;
          try {
            try {
              runNativeTool(driver, linkArgs);
            } catch (error) {
              // A failed link with lld runs again with the driver's default
              // linker, whose error (if any) is the one reported.
              if (lld.length === 0) throw error;
              runNativeTool(driver, linkArgsWith(false));
            }
          } catch (error) {
            const note = staticLinkFailureNote(target, options.staticLink === true);
            if (note === "") throw error;
            throw new Error(`${error instanceof Error ? error.message : String(error)}${note}`);
          }
        }
        timing("native-link");
        requireNativeArtifact(stagedOutput);
        if (mapArgs.length !== 0) {
          const refusal = staticExecutableRefusal(target, true, readFileSync(linkMap, "utf8"));
          if (refusal !== null) throw new NativeCodegenError("SC3002", refusal);
        }
        if (target.platform === "darwin" && optimization === "dev" && !options.strip) {
          runNativeTool(toolchain.dsymutil, [stagedOutput, "-o", stagedOutput + ".dSYM"]);
        }
        if (cacheable) executableCache?.publish(stagedOutput);
      }
      if (target.platform === "darwin" && optimization === "dev" && !options.strip) {
        rmSync(output + ".dSYM", { recursive: true, force: true });
        renameSync(stagedOutput + ".dSYM", output + ".dSYM");
      }
      mkdirSync(options.outDir, { recursive: true });
      writeTextPartsSync(llvmPath, llvm);
      let irPath: string | undefined;
      if (options.emitIr) {
        irPath = join(options.outDir, `${stem}.ir.json`);
        writeTextPartsSync(irPath, prepared.ir!);
      }
      if (!kept) {
        renameSync(stagedOutput, output);
        executableCache?.recordOutput(output);
      }
      if (target.platform === "darwin" && (optimization !== "dev" || options.strip))
        rmSync(output + ".dSYM", { recursive: true, force: true });
      return {
        ok: true,
        artifact: {
          kind: "exe",
          path: output,
          translationUnitPath: llvmPath,
          backend: "llvm",
          ...(profileMatch === undefined ? {} : { profileMatch }),
        },
        binaryPath: output,
        llvmPath,
        backend: "llvm",
        ...(irPath === undefined ? {} : { irPath }),
      };
    } catch (error) {
      // Keep subclass reads at the catch boundary, where the thrown object
      // retains its class identity and source location.
      if (error instanceof LlvmUnsupportedError)
        return { ok: false, diagnostics: [llvmRefusalDiag(error, entry)], sourceTexts };
      if (error instanceof NativeCodegenError)
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag(error.diagnosticCode, error.message, entry)],
          sourceTexts,
        };
      if (error instanceof RuntimePackError)
        return {
          ok: false,
          diagnostics: [
            nativeCodegenDiag(
              error.code === "unsupported" ? "SC3002" : "SC3003",
              error.message,
              entry,
              error.hint,
            ),
          ],
          sourceTexts,
        };
      return failure(error, entry, sourceTexts);
    } finally {
      if (stage !== null) rmSync(stage, { recursive: true, force: true });
      this.cache?.prune();
      timing("complete");
    }
  }

  compileLibrary(options: CompileLibraryOptions): CompileLibraryResult {
    const timing = compilationTiming();
    clearFenceEvalCaches();
    const toolchain = this.toolchain;
    let sourceTexts = new Map<string, string>();
    let stage: string | null = null;
    try {
      const loaded = loadLibraryProfile(resolve(options.profilePath));
      if (!loaded.ok) return { ok: false, diagnostics: loaded.diagnostics, sourceTexts };
      const profile = loaded.profile;
      const wasm = toolchain.target.platform === "wasi";
      if (wasm) {
        const refusal = libraryWasmRefusal(profile, options.sanitize ?? false);
        if (refusal !== null) return { ok: false, diagnostics: [refusal], sourceTexts };
      }
      if (options.sanitize) sanitizerDriver(toolchain);
      const stem = basename(profile.entry).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
      const archivePath = resolve(
        options.outPath ?? join(options.outDir, `${stem}${wasm ? ".wasm" : ".lib.a"}`),
      );
      const llvmPath = join(options.outDir, `${stem}.lib.ll`);
      const prepared = prepareNativeLibrary(
        profile,
        options,
        archivePath,
        toolchain,
        this.frontend,
        this.cache,
        timing,
      );
      if (!prepared.ok) return prepared;
      sourceTexts = new Map(prepared.sources);
      if (archivePath === profile.entry)
        throw new Error("output path must differ from the entry source");
      mkdirSync(dirname(archivePath), { recursive: true });
      mkdirSync(options.outDir, { recursive: true });
      stage = mkdtempSync(join(dirname(archivePath), ".scriptc-library-"));
      const llvm = prepared.llvm;
      const llvmInput = join(stage, "program.ll");
      // In slices: the module text is never encoded whole.
      writeTextPartsSync(llvmInput, llvm);
      timing("llvm-write");
      const features = prepared.features;
      const pack = selectNativeRuntimePack(
        toolchain.runtimePackRoot,
        toolchain.target,
        toolchain.compilerVersion,
        features,
        profile.optimization,
        profile.instancePerThread ? "library-thread" : "library",
        this.runtimePackStore(),
      );
      const runtime = options.sanitize
        ? buildSanitizedRuntime(
            toolchain,
            pack,
            join(stage, "runtime"),
            profile.instancePerThread ? "library-thread" : "library",
            this.cache,
          )
        : stageNativeRuntimeSelection(pack, join(stage, "runtime"), this.runtimePackStore());
      timing("runtime-stage");
      const stagedArchive = join(stage, wasm ? "output.wasm" : "output.a");
      const localizeSymbols = libraryLocalizeSymbols(profile);
      const program = join(stage, "program" + toolchain.target.outputSuffixes.obj);
      if (options.sanitize) {
        runNativeTool(sanitizerDriver(toolchain), [
          ...sanitizerFlags(toolchain, profile.optimization),
          "-c",
          llvmInput,
          "-o",
          program,
        ]);
        requireNativeArtifact(program);
      } else
        this.emitProgramObject(
          llvmInput,
          program,
          profile.entry,
          profile.optimization,
          stage,
          true,
        );
      timing("native-object");
      if (wasm) {
        linkNativeWasmLibrary({
          toolchain,
          programObject: program,
          outputPath: stagedArchive,
          runtime,
          optimization: profile.optimization,
          exports: libraryWasmExports(profile),
        });
      } else {
        archiveNativeLibrary({
          toolchain,
          programObject: program,
          outputPath: stagedArchive,
          stage,
          runtime,
          ...(localizeSymbols === undefined ? {} : { localizeSymbols }),
        });
      }
      timing("native-archive");
      writeTextPartsSync(llvmPath, llvm);
      let irPath: string | undefined;
      if (options.emitIr) {
        irPath = join(options.outDir, `${stem}.lib.ir.json`);
        writeTextPartsSync(irPath, prepared.ir!);
      }
      let sidecarPath: string | undefined;
      if (prepared.sidecarJson !== null) {
        sidecarPath =
          profile.sidecar!.path === null
            ? `${archivePath}.contract.json`
            : resolve(dirname(archivePath), profile.sidecar!.path);
        writeFileSync(sidecarPath, prepared.sidecarJson);
      }
      renameSync(stagedArchive, archivePath);
      return {
        ok: true,
        archivePath,
        llvmPath,
        backend: "llvm",
        ...(irPath === undefined ? {} : { irPath }),
        ...(sidecarPath === undefined ? {} : { sidecarPath }),
      };
    } catch (error) {
      // Keep subclass reads at the catch boundary, where the thrown object
      // retains its class identity and source location.
      if (error instanceof LlvmUnsupportedError)
        return {
          ok: false,
          diagnostics: [llvmRefusalDiag(error, options.profilePath)],
          sourceTexts,
        };
      if (error instanceof NativeCodegenError)
        return {
          ok: false,
          diagnostics: [
            nativeCodegenDiag(error.diagnosticCode, error.message, options.profilePath),
          ],
          sourceTexts,
        };
      if (error instanceof RuntimePackError)
        return {
          ok: false,
          diagnostics: [
            nativeCodegenDiag(
              error.code === "unsupported" ? "SC3002" : "SC3003",
              error.message,
              options.profilePath,
              error.hint,
            ),
          ],
          sourceTexts,
        };
      return failure(error, options.profilePath, sourceTexts);
    } finally {
      if (stage !== null) rmSync(stage, { recursive: true, force: true });
      this.cache?.prune();
      timing("complete");
    }
  }
}
