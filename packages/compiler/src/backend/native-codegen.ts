import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  type NativeArtifactDependency,
} from "./native-toolchain.js";
import { nativeCodegenTarget, nativeCodegenTargetRefusal, type NativeTargetSpec } from "./targets.js";
import { compilerReleaseVersion } from "../library/sidecar.js";

const execFileAsync = promisify(execFile);
export const NATIVE_CODEGEN_PROTOCOL_VERSION = "1";
export const NATIVE_CODEGEN_LLVM_VERSION = "22.1.8";

export type NativeCodegenOutputKind = "asm" | "obj";

export class NativeCodegenError extends Error {
  constructor(
    readonly diagnosticCode: "SC3002" | "SC3003" | "SC3004",
    message: string,
    readonly detailCode?: string,
  ) {
    super(message);
    this.name = "NativeCodegenError";
  }
}

export interface NativeCodegenVersion {
  ok: true;
  protocol_version: string;
  scriptc_package_version: string;
  llvm_version: string;
  host_triple: string;
  targets: string[];
  default_target: string;
  data_layout: string;
}

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
}

const resolvedHelperCache = new Map<string, Promise<ResolvedHelper>>();

export interface NativeCodegenOptions {
  outputPath: string;
  llvm: string;
  outputKind: NativeCodegenOutputKind;
  sourcePath: string;
  optimization?: "0" | "1" | "2" | "3" | "s" | "z";
  sanitize?: boolean;
  target?: NativeTargetSpec;
  /** Test seam: still resolves a package path, never searches PATH. */
  resolvePackageJson?: (specifier: string) => string;
  /** Internal/test override; omitted production calls use the shared cache. */
  cacheRoot?: string | null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function helperFailureMessage(stderr: string, fallback: string): { code?: string; message: string } {
  const parsed = parseJsonObject(stderr.trim());
  return {
    ...(typeof parsed?.["code"] === "string" ? { code: parsed["code"] } : {}),
    message: typeof parsed?.["message"] === "string" ? parsed["message"] : fallback,
  };
}

async function invoke(binaryPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
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

function validateVersion(value: Record<string, unknown>, target: NativeTargetSpec): NativeCodegenVersion {
  const expectedPackageVersion = compilerReleaseVersion();
  const mismatch = (field: string, expected: string): never => {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper is incompatible: ${field} is ${JSON.stringify(value[field])}, expected ${JSON.stringify(expected)}; reinstall scriptc so its compiler and ${target.helperPackage} packages have matching versions`,
      "version_mismatch",
    );
  };
  if (value["ok"] !== true) mismatch("ok", "true");
  if (value["protocol_version"] !== NATIVE_CODEGEN_PROTOCOL_VERSION) {
    mismatch("protocol_version", NATIVE_CODEGEN_PROTOCOL_VERSION);
  }
  if (value["scriptc_package_version"] !== expectedPackageVersion) {
    mismatch("scriptc_package_version", expectedPackageVersion);
  }
  if (value["llvm_version"] !== NATIVE_CODEGEN_LLVM_VERSION) {
    mismatch("llvm_version", NATIVE_CODEGEN_LLVM_VERSION);
  }
  if (value["default_target"] !== target.llvmTriple) {
    mismatch("default_target", target.llvmTriple);
  }
  if (value["data_layout"] !== target.dataLayout) {
    mismatch("data_layout", target.dataLayout);
  }
  if (!Array.isArray(value["targets"]) || !value["targets"].includes("AArch64")) {
    mismatch("targets", "an array containing AArch64");
  }
  if (typeof value["host_triple"] !== "string") mismatch("host_triple", "a string");
  return value as unknown as NativeCodegenVersion;
}

async function resolveHelper(
  target: NativeTargetSpec,
  resolver?: (specifier: string) => string,
): Promise<ResolvedHelper> {
  const resolvePackageJson = resolver ?? ((specifier: string) =>
    createRequire(import.meta.url).resolve(specifier));
  let packageJsonPath: string;
  try {
    packageJsonPath = resolvePackageJson(`${target.helperPackage}/package.json`);
  } catch {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper package ${target.helperPackage} is not installed; reinstall scriptc with optional dependencies enabled for macOS arm64`,
      "missing_package",
    );
  }
  const binaryPath = join(dirname(packageJsonPath), "bin", "scriptc-llvm-codegen");
  let binaryStat;
  try {
    binaryStat = await stat(binaryPath);
    if (!binaryStat.isFile()) throw new Error("not a file");
  } catch {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper package ${target.helperPackage} is incomplete: ${binaryPath} is missing; reinstall scriptc`,
      "missing_binary",
    );
  }
  try {
    if (
      process.platform !== "win32" &&
      ((binaryStat.mode & 0o444) === 0 || (binaryStat.mode & 0o111) === 0)
    ) throw new Error("missing read or execute mode bits");
    await access(binaryPath, constants.R_OK | constants.X_OK);
  } catch {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper package ${target.helperPackage} is incomplete: ${binaryPath} is not readable and executable; reinstall scriptc`,
      "unusable_binary",
    );
  }
  let dependencies: NativeArtifactDependency[];
  try {
    dependencies = await snapshotNativeArtifactDependencies([packageJsonPath, binaryPath]);
  } catch {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper package ${target.helperPackage} changed while its inputs were being inspected; retry the build or reinstall scriptc`,
      "helper_changed",
    );
  }
  const cacheKey = JSON.stringify(dependencies);
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
        `LLVM native helper package ${target.helperPackage} could not be read and executed for its identity check: ${error instanceof Error ? error.message : String(error)}; reinstall scriptc`,
        "identity_probe_failed",
      );
    }
    const rawVersion = parseJsonObject(stdout.trim());
    if (rawVersion === null) {
      throw new NativeCodegenError(
        "SC3003",
        `LLVM native helper returned an invalid version response; reinstall scriptc and ${target.helperPackage}`,
        "invalid_version_response",
      );
    }
    if (!(await nativeArtifactDependenciesStillMatch(dependencies).catch(() => false))) {
      throw new NativeCodegenError(
        "SC3003",
        `LLVM native helper package ${target.helperPackage} changed during its identity check; retry the build or reinstall scriptc`,
        "helper_changed",
      );
    }
    return {
      packageJsonPath,
      binaryPath,
      dependencies,
      identity: {
        packageName: target.helperPackage,
        binaryDigest: createHash("sha256").update(binary).digest("hex"),
        version: validateVersion(rawVersion, target),
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

function cacheKey(options: NativeCodegenOptions, target: NativeTargetSpec, helper: HelperIdentity): string {
  return createHash("sha256")
    .update("scriptc-native-codegen-v1\0")
    .update(options.llvm)
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

export async function emitNativeArtifact(options: NativeCodegenOptions): Promise<NativeCodegenArtifact> {
  const target = options.target ?? nativeCodegenTarget();
  if (target === null) {
    throw new NativeCodegenError(
      "SC3002",
      nativeCodegenTargetRefusal() ?? "native assembly/object emission is unsupported for this target",
      "unsupported_target",
    );
  }
  if (options.sanitize === true) {
    throw new NativeCodegenError(
      "SC3002",
      `--sanitize is not supported with --emit=${options.outputKind}; AddressSanitizer instrumentation parity is not available in the LLVM native helper yet`,
      "sanitize_unsupported",
    );
  }
  const helper = await resolveHelper(target, options.resolvePackageJson);
  const root = await prepareBuildCacheRoot(
    options.cacheRoot === undefined ? buildCacheRoot() : options.cacheRoot,
  );
  const key = cacheKey(options, target, helper.identity);
  const cached = root === null
    ? null
    : join(root, "native-codegen-v1", key.slice(0, 2), `${key}.${options.outputKind === "obj" ? "o" : "s"}`);
  await mkdir(dirname(options.outputPath), { recursive: true });
  const artifact = {
    dependencies: helper.dependencies,
  } satisfies NativeCodegenArtifact;
  if (cached !== null && await validCachedFile(cached) &&
      await installVerifiedCache(cached, options.outputPath)) return artifact;

  const stage = privateSiblingPath(options.outputPath, `native-${options.outputKind}`);
  const input = privateSiblingPath(options.outputPath, "native-input");
  try {
    await writeFile(input, options.llvm, { mode: 0o600 });
    await invoke(helper.binaryPath, [
      "emit",
      "--input", input,
      "--output", stage,
      "--filetype", options.outputKind,
      "--target", target.llvmTriple,
      "--opt-level", options.optimization ?? "2",
      "--relocation-model", target.relocationModel,
      "--diagnostic-format", "json",
      "--source-path", options.sourcePath,
    ]);
    const emitted = await stat(stage).catch(() => null);
    if (emitted === null || !emitted.isFile() || emitted.size === 0) {
      throw new NativeCodegenError(
        "SC3004",
        "LLVM native helper completed without producing a non-empty regular artifact",
        "empty_output",
      );
    }
    await chmod(stage, artifactMode());
    // Cache publication is an optimization boundary. The helper has already
    // produced a valid caller artifact, so a read-only/full cache must not
    // discard it or turn an otherwise successful build into an exception.
    if (
      cached !== null &&
      await nativeArtifactDependenciesStillMatch(helper.dependencies).catch(() => false)
    ) await publishCachedFile(stage, cached).catch(() => undefined);
    await rename(stage, options.outputPath);
    await pruneBuildCache(root);
    return artifact;
  } finally {
    await Promise.all([
      rm(stage, { force: true }).catch(() => undefined),
      rm(input, { force: true }).catch(() => undefined),
    ]);
  }
}
