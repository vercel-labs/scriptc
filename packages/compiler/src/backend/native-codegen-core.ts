/** Native codegen helper protocol shared by compiler hosts. */
import type { NativeHelperSpec, NativeTargetSpec } from "./targets.js";

export const NATIVE_CODEGEN_PROTOCOL_VERSION = "1";
export const NATIVE_CODEGEN_LLVM_VERSION = "22.1.8";

export type NativeCodegenOutputKind = "asm" | "obj";

/** LLVM text that stays one module, LLVM text per partition, the fewest
 * partitions (MIN_PROGRAM_PARTITIONS, of at least MIN_PARTITION_BYTES each)
 * a divided module gets, and the most one executable uses. */
const SINGLE_PARTITION_BYTES = 1024 * 1024;
const PROGRAM_PARTITION_BYTES = 4 * 1024 * 1024;
const MIN_PARTITION_BYTES = 512 * 1024;
const MIN_PROGRAM_PARTITIONS = 8;
const MAX_PROGRAM_PARTITIONS = 64;

/** Executable objects larger than SINGLE_PARTITION_BYTES are divided into
 * partitions that the helper simplifies, optimizes and compiles concurrently,
 * importing small functions across partitions for inlining, and reuses
 * individually across builds. A divided module gets at least
 * MIN_PROGRAM_PARTITIONS so that mid-size programs use several cores. The
 * count is a power of two that depends only on the module's size, on every
 * target, so artifacts never vary with the host and ordinary edits keep every
 * function in its partition. */
export function nativeProgramPartitions(llvmBytes: number): number {
  if (llvmBytes <= SINGLE_PARTITION_BYTES) return 1;
  const required = Math.max(
    Math.ceil(llvmBytes / PROGRAM_PARTITION_BYTES),
    Math.min(MIN_PROGRAM_PARTITIONS, Math.ceil(llvmBytes / MIN_PARTITION_BYTES)),
  );
  return Math.min(MAX_PROGRAM_PARTITIONS, 2 ** Math.ceil(Math.log2(required)));
}

/** Programs divided into at least this many partitions (more than 32 MiB of
 * LLVM text) build with a lower inliner threshold in the release posture. At
 * the -O2 default, inlining in such a program grows its machine code by up to
 * two thirds, and code generation, the larger half of the build, follows code
 * size; at this threshold optimization and code generation take 20% to 40%
 * less time. Speed builds keep the default, as do smaller programs. */
const REDUCED_INLINING_PARTITIONS = 16;
const REDUCED_INLINE_THRESHOLD = 100;

/** The helper's --inline-threshold for a program build, or undefined for the
 * optimization level's default. */
export function nativeInlineThreshold(
  optimization: "release" | "dev" | "speed" | undefined,
  partitions: number,
): number | undefined {
  return (optimization ?? "release") === "release" && partitions >= REDUCED_INLINING_PARTITIONS
    ? REDUCED_INLINE_THRESHOLD
    : undefined;
}

/** The helper arguments for an inliner threshold. */
export function inlineThresholdArgs(threshold: number | undefined): string[] {
  return threshold === undefined ? [] : ["--inline-threshold", String(threshold)];
}

/** Output paths for each partition; the first is the requested path. */
export function nativePartitionPaths(path: string, count: number): string[] {
  const dot = path.lastIndexOf(".");
  const stem = dot > Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) ? dot : path.length;
  const paths = [path];
  for (let index = 1; index < count; index++)
    paths.push(`${path.slice(0, stem)}.part${index}${path.slice(stem)}`);
  return paths;
}

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
  supported_targets: string[];
  default_target: string;
  data_layout: string;
}

export function validateNativeCodegenVersion(
  value: Record<string, unknown>,
  target: NativeTargetSpec,
  helper: NativeHelperSpec,
  expectedPackageVersion: string,
): NativeCodegenVersion {
  const mismatch = (field: string, expected: string): never => {
    throw new NativeCodegenError(
      "SC3003",
      `LLVM native helper is incompatible: ${field} is ${JSON.stringify(value[field])}, expected ${JSON.stringify(expected)}; reinstall scriptc so its compiler and ${helper.packageName} packages have matching versions`,
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
  if (value["default_target"] !== helper.defaultTarget) {
    mismatch("default_target", helper.defaultTarget);
  }
  if (value["data_layout"] !== helper.defaultDataLayout) {
    mismatch("data_layout", helper.defaultDataLayout);
  }
  if (!Array.isArray(value["targets"]) || !value["targets"].includes(target.llvmBackend)) {
    mismatch("targets", `an array containing ${target.llvmBackend}`);
  }
  if (
    !Array.isArray(value["supported_targets"]) ||
    !value["supported_targets"].includes(target.llvmTriple)
  ) {
    mismatch("supported_targets", `an array containing ${target.llvmTriple}`);
  }
  if (typeof value["host_triple"] !== "string") mismatch("host_triple", "a string");
  return value as unknown as NativeCodegenVersion;
}
