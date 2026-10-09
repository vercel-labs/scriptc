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
import { executableLinkInputs } from "../backend/link-plan-core.js";
import { formatNativeLinkInfo } from "../backend/native-link-info-core.js";
import {
  emitNativeObject,
  requireNativeArtifact,
  runNativeTool,
  verifyNativeHelper,
} from "../backend/native-tools.js";
import {
  selectNativeRuntimePack,
  stageNativeRuntimeSelection,
} from "../backend/runtime-pack-native.js";
import { RuntimePackError } from "../backend/runtime-pack-core.js";
import {
  NativeCodegenError,
  nativePartitionPaths,
  nativeProgramPartitions,
} from "../backend/native-codegen-core.js";
import { llvmRefusalDiag } from "../backend/target-diagnostics.js";
import { nativeCodegenDiag } from "../diagnostics/diagnostic.js";
import { loadFfiProfile, type FfiProfile } from "../ffi/ffi-manifest.js";
import { analyzeWithFrontend } from "../frontend/analysis.js";
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
import { contentDigest, type NativeCache } from "./cache.js";
import { splitLlvmProgram, splitLlvmLibraryProgram } from "../backend/llvm/split.js";
import { prepareNativeExecutable, prepareNativeLibrary } from "./prepare.js";
import { buildSanitizedRuntime, sanitizerDriver, sanitizerFlags } from "./sanitizer.js";
import { openNativeExecutableCache } from "./executable-cache.js";
import { nativeFileIdentity } from "./file-identity.js";

/** The first partition keeps the whole-object key used before partitioning. */
function partitionCacheKey(key: string, index: number): string {
  return index === 0 ? key : contentDigest(`${key}:${index}`);
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

/** Shared frontend semantics with native processes for code generation and linking. */
export class NativeCompiler {
  private readonly frontend: FrontendFactory;

  constructor(
    readonly toolchain: NativeToolchain,
    private readonly cache: NativeCache | null = null,
  ) {
    const evaluator = toolchain.comptimeExecutable;
    this.frontend = (entry, npmStatic, externalTypes, libraryNpmStatic) =>
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

  private emitObject(
    input: string,
    output: string,
    source: string,
    optimization: NativeOptimization,
    outputKind: "obj" | "asm",
    partitions = 1,
  ): string[] {
    const toolchain = this.toolchain;
    const outputs = nativePartitionPaths(output, partitions);
    const helperOptions = {
      executable: toolchain.helperExecutable,
      packageRoot: toolchain.helperPackageRoot,
      compilerVersion: toolchain.compilerVersion,
      target: toolchain.target,
      helper: toolchain.helper,
    };
    let key: string | null = null;
    let identity: string | null = null;
    if (this.cache !== null && process.env["SCRIPTC_LLVM_HELPER"] === undefined) {
      try {
        identity = nativeFileIdentity(toolchain.helperExecutable);
        key = contentDigest(
          JSON.stringify({
            schema: 1,
            llvm: contentDigest(readFileSync(input)),
            outputKind,
            optimization,
            source,
            target: toolchain.target,
            helper: identity,
            identity: readFileSync(join(toolchain.helperPackageRoot, "package.json"), "utf8"),
            version: toolchain.compilerVersion,
            ...(partitions > 1 ? { partitions } : {}),
          }),
        );
        const cached = outputs.map((_, index) =>
          this.cache!.read("object", partitionCacheKey(key!, index)),
        );
        if (cached.every((bytes) => bytes !== null)) {
          verifyNativeHelper(helperOptions);
          if (nativeFileIdentity(toolchain.helperExecutable) === identity) {
            cached.forEach((bytes, index) => writeFileSync(outputs[index]!, bytes!));
            return outputs;
          }
          key = null;
        }
      } catch {
        key = null;
      }
    }
    emitNativeObject({
      executable: toolchain.helperExecutable,
      packageRoot: toolchain.helperPackageRoot,
      compilerVersion: toolchain.compilerVersion,
      target: toolchain.target,
      helper: toolchain.helper,
      inputPath: input,
      outputPath: output,
      sourcePath: source,
      optimization,
      outputKind,
      partitions,
    });
    if (this.cache !== null && key !== null) {
      try {
        if (nativeFileIdentity(toolchain.helperExecutable) === identity)
          outputs.forEach((path, index) =>
            this.cache!.write("object", partitionCacheKey(key!, index), readFileSync(path)),
          );
      } catch {
        /* An updated helper or unavailable cache only prevents reuse. */
      }
    }
    return outputs;
  }

  private emitProgramObject(
    input: string,
    output: string,
    source: string,
    optimization: NativeOptimization,
    stage: string,
    library: boolean,
  ): string[] {
    const llvm =
      optimization === "dev" && this.toolchain.target.platform !== "wasi"
        ? readFileSync(input, "utf8")
        : null;
    const split =
      llvm === null ? null : library ? splitLlvmLibraryProgram(llvm) : splitLlvmProgram(llvm);
    if (split === null) {
      const partitions = library
        ? 1
        : nativeProgramPartitions(this.toolchain.target, optimization, statSync(input).size);
      return this.emitObject(input, output, source, optimization, "obj", partitions);
    }
    const objects: string[] = [];
    for (const [index, shard] of split.shards.entries()) {
      const shardInput = join(stage, `shard-${index}.ll`);
      const shardOutput = join(stage, `shard-${index}` + this.toolchain.target.outputSuffixes.obj);
      writeFileSync(shardInput, shard.source);
      this.emitObject(shardInput, shardOutput, source + "." + shard.name, optimization, "obj");
      objects.push(shardOutput);
    }
    const merged = localizeNativeLibrary(this.toolchain, stage, objects, [], split.publicSymbols);
    renameSync(merged, output);
    return [output];
  }

  compile(entry: string, options: CompileRequestOptions): CompileRequestResult {
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
      mkdirSync(dirname(output), { recursive: true });
      stage = mkdtempSync(join(dirname(output), ".scriptc-native-"));
      const stagedOutput = join(stage, basename(output));
      const stem = basename(entry).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
      const llvmPath = join(options.outDir, `${stem}.ll`);
      if (outputKind === "ir") {
        writeFileSync(stagedOutput, prepared.ir!);
        renameSync(stagedOutput, output);
        return { ok: true, artifact: { kind: "ir", path: output } };
      }
      const { llvm, features } = prepared;
      const inputDirectory = join(stage, "input");
      mkdirSync(inputDirectory);
      const llvmInput = outputKind === "llvm" ? stagedOutput : join(inputDirectory, "program.ll");
      writeFileSync(llvmInput, llvm);
      timing("llvm-write");
      if (outputKind === "llvm") {
        renameSync(stagedOutput, output);
        return { ok: true, artifact: { kind: "llvm", path: output } };
      }
      const object =
        outputKind === "exe"
          ? join(inputDirectory, "program" + target.outputSuffixes.obj)
          : stagedOutput;
      const executablePack =
        outputKind === "exe"
          ? selectNativeRuntimePack(
              toolchain.runtimePackRoot,
              target,
              toolchain.compilerVersion,
              features,
              optimization,
            )
          : null;
      const executableCache =
        executablePack === null
          ? null
          : openNativeExecutableCache(this.cache, toolchain, llvm, options, ffi, executablePack);
      const restored = executableCache?.restore(stagedOutput) ?? false;
      timing(restored ? "executable-cache-hit" : "executable-cache-miss");
      if (!restored) {
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
        } else if (outputKind === "exe")
          programObjects = this.emitProgramObject(
            llvmInput,
            object,
            entry,
            optimization,
            stage,
            false,
          );
        else
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
                )
              : null;
          if (pack !== null) stageNativeRuntimeSelection(pack, join(stage, "runtime"));
          const info =
            pack === null
              ? undefined
              : formatNativeLinkInfo(
                  { programObject: output, target, ffi },
                  toolchain.compilerVersion,
                  pack,
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
        const pack = executablePack!;
        const runtime = options.sanitize
          ? buildSanitizedRuntime(toolchain, pack, join(stage, "runtime"), "executable", this.cache)
          : stageNativeRuntimeSelection(pack, join(stage, "runtime"));
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
          ...(options.windowsSubsystem === undefined
            ? {}
            : { windowsSubsystem: options.windowsSubsystem }),
        });
        const linkArgs = [
          ...(options.sanitize ? ["-fsanitize=address"] : toolchain.linkerArgs),
          ...plan.driverFlags,
          ...plan.inputs,
          ...plan.systemLibraries.map((name) => `-l${name}`),
          "-o",
          stagedOutput,
        ];
        const cacheable = executableCache?.trace(linkArgs, stage) ?? false;
        timing("link-inputs");
        // A successful dependency trace already produced this executable.
        // Keep its verified output instead of asking the linker to repeat it.
        if (!cacheable)
          runNativeTool(options.sanitize ? sanitizerDriver(toolchain) : toolchain.linker, linkArgs);
        timing("native-link");
        requireNativeArtifact(stagedOutput);
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
      writeFileSync(llvmPath, llvm);
      let irPath: string | undefined;
      if (options.emitIr) {
        irPath = join(options.outDir, `${stem}.ir.json`);
        writeFileSync(irPath, prepared.ir!);
      }
      renameSync(stagedOutput, output);
      if (target.platform === "darwin" && (optimization !== "dev" || options.strip))
        rmSync(output + ".dSYM", { recursive: true, force: true });
      return {
        ok: true,
        artifact: { kind: "exe", path: output, translationUnitPath: llvmPath, backend: "llvm" },
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
      writeFileSync(llvmInput, llvm);
      timing("llvm-write");
      const features = prepared.features;
      const pack = selectNativeRuntimePack(
        toolchain.runtimePackRoot,
        toolchain.target,
        toolchain.compilerVersion,
        features,
        profile.optimization,
        profile.instancePerThread ? "library-thread" : "library",
      );
      const runtime = options.sanitize
        ? buildSanitizedRuntime(
            toolchain,
            pack,
            join(stage, "runtime"),
            profile.instancePerThread ? "library-thread" : "library",
            this.cache,
          )
        : stageNativeRuntimeSelection(pack, join(stage, "runtime"));
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
      writeFileSync(llvmPath, llvm);
      let irPath: string | undefined;
      if (options.emitIr) {
        irPath = join(options.outDir, `${stem}.lib.ir.json`);
        writeFileSync(irPath, prepared.ir!);
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
