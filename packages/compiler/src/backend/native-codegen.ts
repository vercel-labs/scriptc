import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  buildCacheRoot,
  copyValidCachedFile,
  privateSiblingPath,
  prepareBuildCacheRoot,
  publishCachedFile,
  pruneBuildCache,
  validCachedFile,
} from "./build-cache.js";
import {
  nativeArtifactDependenciesStillMatch,
  snapshotNativeArtifactDependencies,
} from "./native/artifact-stamps.js";
import { type NativeArtifactDependency } from "./native/contracts.js";
import {
  nativeCodegenTarget,
  nativeCodegenTargetRefusal,
  nativeHelperForTarget,
  type NativeHelperSpec,
  type NativeTargetSpec,
} from "./targets.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import {
  nativeProfileHelperArgs,
  nativeProfileKey,
  type NativeProfileOptions,
} from "./native-profile.js";
import { writeTextParts } from "../text-parts.js";

import {
  NativeCodegenError,
  inlineThresholdArgs,
  nativePartitionPaths,
  validateNativeCodegenVersion as validateHelperVersion,
  type NativeCodegenVersion,
  type NativeCodegenOutputKind,
} from "./native-codegen-core.js";
export {
  NATIVE_CODEGEN_PROTOCOL_VERSION,
  NATIVE_CODEGEN_LLVM_VERSION,
  NativeCodegenError,
  type NativeCodegenVersion,
  type NativeCodegenOutputKind,
} from "./native-codegen-core.js";

const execFileAsync = promisify(execFile);

interface HelperIdentity {
  packageName: string;
  binaryDigest: string;
  version: NativeCodegenVersion;
}

interface ResolvedHelper {
  packageJsonPath: string;
  binaryPath: string;
  identity: HelperIdentity;
  dependencies: NativeArtifactDependency[];
}

export interface NativeCodegenArtifact {
  /** Exact installed inputs observed before the helper identity and emission. */
  dependencies: NativeArtifactDependency[];
  /** Every emitted file, starting with the requested output path. */
  outputPaths: string[];
}

const resolvedHelperCache = new Map<string, Promise<ResolvedHelper>>();

/** LLVM text already written to `file`, of `bytes` bytes, which a build passes on without reading it. */
export interface LlvmFile {
  readonly file: string;
  readonly bytes: number;
}

/** LLVM text as a string, as parts to concatenate, or as a file. */
export type LlvmInput = string | readonly string[] | LlvmFile;

export function isLlvmFile(llvm: LlvmInput): llvm is LlvmFile {
  return typeof llvm === "object" && !Array.isArray(llvm);
}

/** The size of `llvm` in bytes. */
export function llvmInputBytes(llvm: LlvmInput): number {
  if (isLlvmFile(llvm)) return llvm.bytes;
  return (typeof llvm === "string" ? [llvm] : llvm).reduce(
    (bytes, part) => bytes + Buffer.byteLength(part),
    0,
  );
}

export interface NativeCodegenOptions {
  outputPath: string;
  llvm: LlvmInput;
  outputKind: NativeCodegenOutputKind;
  sourcePath: string;
  optimization?: "0" | "1" | "2" | "3" | "s" | "z";
  sanitize?: boolean;
  target?: NativeTargetSpec;
  /** Test seam for package selection on a simulated host. */
  helperHost?: { platform: NodeJS.Platform; arch: string; linuxLibc?: "gnu" | "musl" };
  /** Test seam: still resolves a package path, never searches PATH. */
  resolvePackageJson?: (specifier: string) => string;
  /** Internal/test override; omitted production calls use the shared cache. */
  cacheRoot?: string | null;
  /** Program partitions, written to nativePartitionPaths(outputPath). */
  partitions?: number;
  /** Profile-guided optimization: instrumentation or an indexed profile. */
  profile?: NativeProfileOptions;
  /** The optimization pipelines' inliner threshold (nativeInlineThreshold);
   * absent: the level's default. */
  inlineThreshold?: number;
}

/** Writes LLVM text in large batches; see `writeTextParts`. */
export async function writeLlvmSource(
  path: string,
  llvm: string | readonly string[],
  mode = 0o666,
): Promise<void> {
  await writeTextParts(path, llvm, mode);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function helperFailureMessage(
  stderr: string,
  fallback: string,
): { code?: string; message: string } {
  const parsed = parseJsonObject(stderr.trim());
  return {
    ...(typeof parsed?.["code"] === "string" ? { code: parsed["code"] } : {}),
    message: typeof parsed?.["message"] === "string" ? parsed["message"] : fallback,
  };
}

async function invoke(
  binaryPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(binaryPath, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    const parsed = helperFailureMessage(stderr, failure.message);
    throw new NativeCodegenError(
      "SC3004",
      `LLVM native helper failed${parsed.code === undefined ? "" : ` (${parsed.code})`}: ${parsed.message}`,
      parsed.code,
    );
  }
}

export function validateNativeCodegenVersion(
  value: Record<string, unknown>,
  target: NativeTargetSpec,
  helper: NativeHelperSpec,
): NativeCodegenVersion {
  return validateHelperVersion(value, target, helper, compilerReleaseVersion());
}

async function resolveHelper(
  target: NativeTargetSpec,
  resolver?: (specifier: string) => string,
  host?: { platform: NodeJS.Platform; arch: string; linuxLibc?: "gnu" | "musl" },
): Promise<ResolvedHelper> {
  const helper = nativeHelperForTarget(target, host?.platform, host?.arch, host?.linuxLibc);
  if (helper === null) {
    throw new NativeCodegenError(
      "SC3002",
      `no scriptc LLVM helper supports ${target.name} on this host`,
      "unsupported_helper_host",
    );
  }
  const resolvePackageJson =
    resolver ?? ((specifier: string) => createRequire(import.meta.url).resolve(specifier));
  let packageJsonPath: string;
  try {
    packageJsonPath = resolvePackageJson(`${helper.packageName}/package.json`);
  } catch {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper package ${helper.packageName} is not installed; reinstall scriptc with optional dependencies enabled for this host`,
      "missing_package",
    );
  }
  const binaryPath = join(
    dirname(packageJsonPath),
    "bin",
    process.platform === "win32" ? "scriptc-llvm-codegen.exe" : "scriptc-llvm-codegen",
  );
  let binaryStat;
  try {
    binaryStat = await stat(binaryPath);
    if (!binaryStat.isFile()) throw new Error("not a file");
  } catch {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper package ${helper.packageName} is incomplete: ${binaryPath} is missing; reinstall scriptc`,
      "missing_binary",
    );
  }
  try {
    if (
      process.platform !== "win32" &&
      ((binaryStat.mode & 0o444) === 0 || (binaryStat.mode & 0o111) === 0)
    )
      throw new Error("missing read or execute mode bits");
    await access(binaryPath, constants.R_OK | constants.X_OK);
  } catch {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper package ${helper.packageName} is incomplete: ${binaryPath} is not readable and executable; reinstall scriptc`,
      "unusable_binary",
    );
  }
  let dependencies: NativeArtifactDependency[];
  try {
    dependencies = await snapshotNativeArtifactDependencies([packageJsonPath, binaryPath]);
  } catch {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper package ${helper.packageName} changed while its inputs were being inspected; retry the build or reinstall scriptc`,
      "helper_changed",
    );
  }
  // A single host helper can own more than one backend (for example its
  // host-native ISA plus WebAssembly). Cache only after the target backend
  // has also been checked; otherwise a prior X86 lookup could accidentally
  // bless a later WASI request against an older X86-only package.
  const cacheKey = JSON.stringify({ dependencies, targetTriple: target.llvmTriple });
  const load = async (): Promise<ResolvedHelper> => {
    let stdout: string;
    let binary: Buffer;
    try {
      [{ stdout }, binary] = await Promise.all([
        invoke(binaryPath, ["version", "--format=json"]),
        readFile(binaryPath),
      ]);
    } catch (error) {
      throw new NativeCodegenError(
        "SC3003",
        `LLVM native helper package ${helper.packageName} could not be read and executed for its identity check: ${error instanceof Error ? error.message : String(error)}; reinstall scriptc`,
        "identity_probe_failed",
      );
    }
    const rawVersion = parseJsonObject(stdout.trim());
    if (rawVersion === null) {
      throw new NativeCodegenError(
        "SC3003",
        `LLVM native helper returned an invalid version response; reinstall scriptc and ${helper.packageName}`,
        "invalid_version_response",
      );
    }
    if (!(await nativeArtifactDependenciesStillMatch(dependencies).catch(() => false))) {
      throw new NativeCodegenError(
        "SC3003",
        `LLVM native helper package ${helper.packageName} changed during its identity check; retry the build or reinstall scriptc`,
        "helper_changed",
      );
    }
    return {
      packageJsonPath,
      binaryPath,
      dependencies,
      identity: {
        packageName: helper.packageName,
        binaryDigest: createHash("sha256").update(binary).digest("hex"),
        version: validateNativeCodegenVersion(rawVersion, target, helper),
      },
    };
  };
  if (resolver !== undefined) return load();
  const cached = resolvedHelperCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = load();
  resolvedHelperCache.set(cacheKey, pending);
  void pending.catch(() => {
    if (resolvedHelperCache.get(cacheKey) === pending) resolvedHelperCache.delete(cacheKey);
  });
  return pending;
}

/** Adds the bytes of `file` to `hash`, as `hash.update` of the text written there would. */
function updateHashFromFile(hash: Hash, file: string): void {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
}

function cacheKey(
  options: NativeCodegenOptions,
  target: NativeTargetSpec,
  helper: HelperIdentity,
): string {
  const hash = createHash("sha256").update("scriptc-native-codegen-v1\0");
  if (isLlvmFile(options.llvm)) updateHashFromFile(hash, options.llvm.file);
  else
    for (const part of typeof options.llvm === "string" ? [options.llvm] : options.llvm)
      hash.update(part);
  return hash
    .update("\0")
    .update(JSON.stringify(target))
    .update("\0")
    .update(JSON.stringify(helper))
    .update("\0")
    .update(options.optimization ?? "2")
    .update("\0")
    .update(options.sanitize === true ? "sanitize" : "plain")
    .update("\0")
    .update(options.outputKind)
    .update("\0")
    .update(options.sourcePath)
    .update((options.partitions ?? 1) > 1 ? `\0partitions:${options.partitions}` : "")
    .update(options.profile === undefined ? "" : `\0${nativeProfileKey(options.profile)}`)
    .update(options.inlineThreshold === undefined ? "" : `\0inline:${options.inlineThreshold}`)
    .digest("hex");
}

function artifactMode(): number {
  return 0o666 & ~process.umask();
}

async function installVerifiedCache(source: string, destination: string): Promise<boolean> {
  const temporary = privateSiblingPath(destination, "native-cache-hit");
  try {
    if (!(await copyValidCachedFile(source, temporary))) return false;
    // Cache entries are private (0600), but caller artifacts follow the
    // process umask exactly like a freshly emitted object/assembly file.
    await chmod(temporary, artifactMode());
    await rename(temporary, destination);
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** `scriptc merge-profiles`: merges raw or indexed IR profiles into one
 * indexed profile for `--profile-use`. */
export async function mergeNativeProfiles(
  outputPath: string,
  inputPaths: readonly string[],
  sparse = false,
): Promise<void> {
  const target = nativeCodegenTarget();
  if (target === null) {
    throw new NativeCodegenError(
      "SC3002",
      nativeCodegenTargetRefusal() ?? "profile merging is unsupported for this target",
      "unsupported_target",
    );
  }
  const helper = await resolveHelper(target);
  await invoke(helper.binaryPath, [
    "merge-profiles",
    "--output",
    outputPath,
    ...(sparse ? ["--sparse"] : []),
    ...inputPaths,
  ]);
}

export async function emitNativeArtifact(
  options: NativeCodegenOptions,
): Promise<NativeCodegenArtifact> {
  const target = options.target ?? nativeCodegenTarget();
  if (target === null) {
    throw new NativeCodegenError(
      "SC3002",
      nativeCodegenTargetRefusal() ??
        "native assembly/object emission is unsupported for this target",
      "unsupported_target",
    );
  }
  if (!target.supports[options.outputKind]) {
    throw new NativeCodegenError(
      "SC3002",
      `--emit=${options.outputKind} is not supported for ${target.name}`,
      "unsupported_output_kind",
    );
  }
  if (options.sanitize === true) {
    throw new NativeCodegenError(
      "SC3002",
      `--sanitize is not supported with --emit=${options.outputKind}; AddressSanitizer instrumentation parity is not available in the LLVM native helper yet`,
      "sanitize_unsupported",
    );
  }
  const helper = await resolveHelper(target, options.resolvePackageJson, options.helperHost);
  const root = await prepareBuildCacheRoot(
    options.cacheRoot === undefined ? buildCacheRoot() : options.cacheRoot,
  );
  const key = cacheKey(options, target, helper.identity);
  const outputs = nativePartitionPaths(options.outputPath, options.partitions ?? 1);
  const suffix = options.outputKind === "obj" ? "o" : "s";
  const cached = outputs.map((_, index) =>
    root === null
      ? null
      : join(
          root,
          "native-codegen-v1",
          key.slice(0, 2),
          index === 0 ? `${key}.${suffix}` : `${key}.part${index}.${suffix}`,
        ),
  );
  await mkdir(dirname(options.outputPath), { recursive: true });
  const artifact = {
    dependencies: helper.dependencies,
    outputPaths: outputs,
  } satisfies NativeCodegenArtifact;
  if (await installCachedPartitions(cached, outputs)) return artifact;
  // Partitioned programs also reuse individual partition artifacts, so an
  // edit recompiles only the partitions it affects. The directory names the
  // exact helper build and target; the helper keys entries by content.
  const partitionCache =
    root === null || outputs.length < 2
      ? null
      : join(
          root,
          "native-partitions-v1",
          createHash("sha256")
            .update(JSON.stringify({ helper: helper.identity, target }))
            .digest("hex")
            .slice(0, 32),
        );
  if (partitionCache !== null) await mkdir(partitionCache, { recursive: true, mode: 0o700 });

  const stages = outputs.map((output) =>
    privateSiblingPath(output, `native-${options.outputKind}`),
  );
  // The helper reads a private copy: the caller's .ll may be shared with a
  // concurrent build of another entry that has the same output stem.
  const input = privateSiblingPath(options.outputPath, "native-input");
  try {
    if (isLlvmFile(options.llvm)) await copyFile(options.llvm.file, input);
    else await writeLlvmSource(input, options.llvm, 0o600);
    await invoke(helper.binaryPath, [
      "emit",
      "--input",
      input,
      ...stages.flatMap((stage) => ["--output", stage]),
      "--filetype",
      options.outputKind,
      "--target",
      target.llvmTriple,
      "--opt-level",
      options.optimization ?? "2",
      "--relocation-model",
      target.relocationModel,
      "--diagnostic-format",
      "json",
      "--source-path",
      options.sourcePath,
      ...(partitionCache === null ? [] : ["--cache-dir", partitionCache]),
      ...nativeProfileHelperArgs(options.profile),
      ...inlineThresholdArgs(options.inlineThreshold),
    ]);
    for (const stage of stages) {
      const emitted = await stat(stage).catch(() => null);
      if (emitted === null || !emitted.isFile() || emitted.size === 0) {
        throw new NativeCodegenError(
          "SC3004",
          "LLVM native helper completed without producing a non-empty regular artifact",
          "empty_output",
        );
      }
      await chmod(stage, artifactMode());
    }
    // Cache publication is an optimization boundary. The helper has already
    // produced a valid caller artifact, so a read-only/full cache must not
    // discard it or turn an otherwise successful build into an exception.
    if (
      root !== null &&
      (await nativeArtifactDependenciesStillMatch(helper.dependencies).catch(() => false))
    ) {
      for (let index = 0; index < stages.length; index++)
        await publishCachedFile(stages[index]!, cached[index]!).catch(() => undefined);
    }
    for (let index = 0; index < stages.length; index++)
      await rename(stages[index]!, outputs[index]!);
    await pruneBuildCache(root);
    return artifact;
  } finally {
    await Promise.all([
      ...stages.map((stage) => rm(stage, { force: true }).catch(() => undefined)),
      rm(input, { force: true }).catch(() => undefined),
    ]);
  }
}

/** Install a cached artifact only when every partition is present and valid. */
async function installCachedPartitions(
  cached: readonly (string | null)[],
  outputs: readonly string[],
): Promise<boolean> {
  for (const path of cached) if (path === null || !(await validCachedFile(path))) return false;
  for (let index = 0; index < outputs.length; index++)
    if (!(await installVerifiedCache(cached[index]!, outputs[index]!))) return false;
  return true;
}
