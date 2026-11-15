/** Native codegen helper protocol shared by compiler hosts. */
import { availableParallelism } from "node:os";

import type { NativeHelperSpec, NativeTargetSpec } from "./targets.js";

export const NATIVE_CODEGEN_PROTOCOL_VERSION = "1";
export const NATIVE_CODEGEN_LLVM_VERSION = "22.1.8";

export type NativeCodegenOutputKind = "asm" | "obj";

/** LLVM text that stays one module, LLVM text per partition when the module
 * is divided by size, the fewest partitions (MIN_PROGRAM_PARTITIONS, of at
 * least MIN_PARTITION_BYTES each) a divided module gets, the most one
 * executable uses, and the partitions a divided module is sized for per
 * hardware thread. */
const SINGLE_PARTITION_BYTES = 128 * 1024;
const PROGRAM_PARTITION_BYTES = 4 * 1024 * 1024;
const MIN_PARTITION_BYTES = 32 * 1024;
const MIN_PROGRAM_PARTITIONS = 8;
const MAX_PROGRAM_PARTITIONS = 64;
const PARTITIONS_PER_THREAD = 2;
/** SINGLE_PARTITION_BYTES of unoptimized (dev) executables. */
const UNOPTIMIZED_SINGLE_PARTITION_BYTES = 64 * 1024;

/** Executable objects larger than SINGLE_PARTITION_BYTES are divided into
 * partitions that the helper simplifies, optimizes and compiles concurrently,
 * importing small functions across partitions for inlining, and reuses
 * individually across builds, so an edit optimizes again only the partitions
 * it affects. The helper compiles partitions on one thread per hardware thread
 * of the host, so a divided module gets at least PARTITIONS_PER_THREAD
 * partitions for each of them, up to MAX_PROGRAM_PARTITIONS, and fewer when
 * its text cannot fill each with MIN_PARTITION_BYTES: a module of a few
 * hundred kilobytes gets MIN_PROGRAM_PARTITIONS partitions whatever the host.
 * A module larger than PARTITIONS_PER_THREAD of the host's threads can fill at
 * MIN_PARTITION_BYTES each keeps one partition per PROGRAM_PARTITION_BYTES on
 * every host, so a host with few threads divides it as finely as before. The
 * count is a power of two, so ordinary edits keep every function in its
 * partition. An optimized module whose largest partition would hold more than
 * two thirds of its function text is optimized whole by the helper instead (as
 * for one partition), and its code is generated in parts.
 *
 * Unoptimized (dev) partitions are compiled on their own with nothing
 * imported, so they cost no run time and an edit compiles only the partitions
 * whose functions it changes: dev executables are divided from
 * UNOPTIMIZED_SINGLE_PARTITION_BYTES. */
export function nativeProgramPartitions(
  llvmBytes: number,
  unoptimized = false,
  parallelism = availableParallelism(),
): number {
  if (llvmBytes <= (unoptimized ? UNOPTIMIZED_SINGLE_PARTITION_BYTES : SINGLE_PARTITION_BYTES))
    return 1;
  // The largest power of two of MIN_PARTITION_BYTES partitions the module can
  // fill, and the smallest divided module's count: enough partitions for the
  // host's threads, but never more than the module has text for.
  const fillable = 2 ** Math.floor(Math.log2(Math.max(1, llvmBytes / MIN_PARTITION_BYTES)));
  const required = Math.max(
    Math.ceil(llvmBytes / PROGRAM_PARTITION_BYTES),
    Math.min(MIN_PROGRAM_PARTITIONS, Math.ceil(llvmBytes / MIN_PARTITION_BYTES)),
    Math.min(Math.max(1, parallelism) * PARTITIONS_PER_THREAD, fillable),
  );
  return Math.min(MAX_PROGRAM_PARTITIONS, 2 ** Math.ceil(Math.log2(required)));
}

export interface NativeBuildPartitionsOptions {
  /** The link takes one native object: a native program object, or a host
   * without a native codegen target. */
  singleObject?: boolean;
  /** The build copies program functions for CPU dispatch. */
  cpuDispatch?: boolean;
  /** The executable is unoptimized (dev). */
  unoptimized?: boolean;
}

/**
 * The partitions a build compiles its module into: one when the link takes a
 * single object, and one for a build that copies program functions for CPU
 * dispatch. Cloning leaves a callee the copies share referenced by more than
 * one definition, and the helper places a definition with several referrers by
 * the hash of its name rather than with a caller (partition.cpp), so the
 * copies and the functions they call land in different objects and LLVM
 * cannot inline between them: the hot paths then pay a call that the module
 * compiled whole does not.
 */
export function nativeBuildPartitions(
  llvmBytes: number,
  options: NativeBuildPartitionsOptions = {},
): number {
  return options.singleObject === true || options.cpuDispatch === true
    ? 1
    : nativeProgramPartitions(llvmBytes, options.unoptimized);
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

/** The error a failed helper invocation rejects with: the fields
 * `execFile`/`execFileSync` attach. A build on the JavaScript host throws one
 * itself, and so does the native host, so both report a helper failure the
 * same way. */
export interface NativeHelperFailure {
  message: string;
  /** The exit status: `execFile` attaches it as `code`, `execFileSync` as
   * `status`. */
  code?: number | string;
  status?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** How the child ended. A helper killed by a signal prints nothing at all, so
 * the signal is the only description of the failure it leaves behind. */
function helperEnding(failure: NativeHelperFailure): string {
  if (typeof failure.code === "number") return `exit status ${failure.code}`;
  if (typeof failure.status === "number") return `exit status ${failure.status}`;
  if (typeof failure.signal === "string" && failure.signal !== "")
    return `signal ${failure.signal}`;
  return "";
}

/** The command line the error names, without the output it appends after it. */
function helperCommand(failure: NativeHelperFailure): string {
  const newline = failure.message.indexOf("\n");
  return newline === -1 ? failure.message : failure.message.slice(0, newline);
}

/** How much of the helper's own output a failure message carries. */
const MAX_HELPER_FAILURE_OUTPUT = 2000;

/** The message a helper failure reports: its structured diagnostic when it
 * wrote one, else how it ended and what it printed. A killed helper leaves an
 * unqualified "Command failed: <args>" from Node, so the ending is what makes
 * the diagnostic actionable (a SIGKILL of a whole-module emit, say). */
export function nativeHelperFailureMessage(failure: NativeHelperFailure): {
  code?: string;
  message: string;
} {
  const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
  const parsed = parseJsonObject(stderr.trim());
  if (typeof parsed?.["message"] === "string") {
    return {
      ...(typeof parsed["code"] === "string" ? { code: parsed["code"] } : {}),
      message: parsed["message"],
    };
  }
  // The helper did not report one of its structured diagnostics, so the child's
  // exit status, signal and output are all the evidence there is: a loader,
  // allocation or abort message names a cause that the command line alone does
  // not. The diagnostic goes to stderr; stdout only carries a profile report,
  // which a failing helper may still have written before it ended.
  const printed = (
    stderr.trim() !== "" ? stderr : typeof failure.stdout === "string" ? failure.stdout : ""
  ).trim();
  const ending = helperEnding(failure);
  const status = ending === "" ? "" : ` (${ending})`;
  const output =
    printed === ""
      ? ""
      : `: ${printed.slice(0, MAX_HELPER_FAILURE_OUTPUT)}${printed.length > MAX_HELPER_FAILURE_OUTPUT ? "…" : ""}`;
  return { message: `${helperCommand(failure)}${status}${output}` };
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
