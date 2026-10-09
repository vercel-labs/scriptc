/** Native codegen helper protocol shared by compiler hosts. */
import type { NativeOptimization } from "./optimization.js";
import type { NativeHelperSpec, NativeTargetSpec } from "./targets.js";

export const NATIVE_CODEGEN_PROTOCOL_VERSION = "1";
export const NATIVE_CODEGEN_LLVM_VERSION = "22.1.8";

export type NativeCodegenOutputKind = "asm" | "obj";

/** LLVM text per partition, and the most partitions one executable uses. */
const PROGRAM_PARTITION_BYTES = 1024 * 1024;
const MAX_PROGRAM_PARTITIONS = 8;

/** Optimized executable objects this large keep whole-program simplification
 * and inlining, then optimize and generate code in concurrent partitions. The
 * count depends only on the module, so artifacts never vary with the host. */
export function nativeProgramPartitions(
  target: NativeTargetSpec,
  optimization: NativeOptimization,
  llvmBytes: number,
): number {
  if (optimization === "dev" || target.platform === "wasi") return 1;
  const count = Math.floor(llvmBytes / PROGRAM_PARTITION_BYTES);
  return Math.max(1, Math.min(MAX_PROGRAM_PARTITIONS, count));
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
