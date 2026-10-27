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

/** LLVM text that an optimized one-partition program generates code for on
 * one thread, the LLVM text per code generation part, and the most parts. */
const SINGLE_CODEGEN_BYTES = 128 * 1024;
const CODEGEN_PART_BYTES = 64 * 1024;
const MAX_CODEGEN_PARTS = 8;

/** Code generation parts for an optimized executable object that
 * nativeProgramPartitions keeps as one partition. The helper optimizes the
 * module whole, as for a single output, and then generates code for the parts
 * concurrently (`--split codegen`), so the generated code does not change.
 * Returns 1 for modules of at most SINGLE_CODEGEN_BYTES and for partitioned
 * ones. The count is a power of two that depends only on the module's size,
 * so artifacts never vary with the host. */
export function nativeCodegenParts(llvmBytes: number): number {
  if (llvmBytes <= SINGLE_CODEGEN_BYTES || llvmBytes > SINGLE_PARTITION_BYTES) return 1;
  const required = Math.ceil(llvmBytes / CODEGEN_PART_BYTES);
  return Math.min(MAX_CODEGEN_PARTS, 2 ** Math.ceil(Math.log2(required)));
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
