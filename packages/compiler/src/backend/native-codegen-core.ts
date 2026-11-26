/** Native codegen helper protocol shared by compiler hosts. */
import { readFileSync } from "node:fs";
import { availableParallelism, freemem, totalmem } from "node:os";

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

/** The memory the code generation of one build may use, as a share of what
 * the host reports available. The rest belongs to the compiler, the checker
 * and the rest of the machine. */
const CODEGEN_MEMORY_SHARE = 0.75;
/** A partition compile's peak, as a multiple of the bytes of the partition
 * it parses and optimizes; unoptimized partitions are compiled on their own
 * and peak lower. */
const OPTIMIZED_PARTITION_OVERHEAD = 16;
const UNOPTIMIZED_PARTITION_OVERHEAD = 10;
/** The least memory a lane is assumed to take, so that a small program's
 * many shallow lanes still leave the compiler room on a small host. */
const MIN_LANE_BYTES = 192 * 1024 * 1024;

export interface NativeCodegenJobsOptions {
  /** Memory the host has for this build; the process's available memory. */
  availableBytes?: number;
  /** The host's hardware threads, when they are not the process's own. */
  parallelism?: number;
  /** The build is unoptimized (dev). */
  unoptimized?: boolean;
}

/** Reads a file for the memory measurement below; undefined when it cannot
 * be read. */
export type MemoryFileReader = (path: string) => string | undefined;

function readMemoryFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** One field of a cgroup memory.stat, in bytes, or 0. */
function memoryStat(stat: string, field: string): number {
  const match = new RegExp(`^${field} (\\d+)$`, "m").exec(stat);
  return match === null ? 0 : Number(match[1]);
}

/** The reclaimable cache a cgroup v2 memory.stat reports, or undefined
 * when the cgroup's file cannot be read. */
function cgroupV2Reclaimable(read: MemoryFileReader, path: string): number | undefined {
  const stat = read(`/sys/fs/cgroup/${path}/memory.stat`) ?? read("/sys/fs/cgroup/memory.stat");
  if (stat === undefined) return undefined;
  return Math.max(
    0,
    memoryStat(stat, "inactive_file") -
      memoryStat(stat, "file_dirty") -
      memoryStat(stat, "file_writeback"),
  );
}

/** The reclaimable cache a cgroup v1 memory controller reports, or undefined
 * when its file cannot be read. */
function cgroupV1Reclaimable(read: MemoryFileReader, path: string): number | undefined {
  const stat =
    read(`/sys/fs/cgroup/memory/${path}/memory.stat`) ?? read("/sys/fs/cgroup/memory/memory.stat");
  if (stat === undefined) return undefined;
  return Math.max(
    0,
    memoryStat(stat, "total_inactive_file") -
      memoryStat(stat, "total_dirty") -
      memoryStat(stat, "total_writeback"),
  );
}

/** The page cache the process's cgroup can drop on demand: its inactive file
 * pages, less those still dirty or under writeback. A v1 memory controller
 * named in /proc/self/cgroup is the one that accounts the process's memory,
 * even on a hybrid host that also lists the v2 hierarchy (`0::`); otherwise
 * the v2 hierarchy does. 0 when the process is in no memory cgroup the files
 * describe. */
export function cgroupReclaimableBytes(read: MemoryFileReader = readMemoryFile): number {
  const cgroups = read("/proc/self/cgroup");
  if (cgroups === undefined) return 0;
  const v1 = /^\d+:[^:\n]*\bmemory\b[^:\n]*:\/(.*)$/m.exec(cgroups);
  const v2 = /^0::\/(.*)$/m.exec(cgroups);
  if (v1 !== null) {
    const reclaimable = cgroupV1Reclaimable(read, v1[1]!);
    if (reclaimable !== undefined) return reclaimable;
  }
  if (v2 !== null) return cgroupV2Reclaimable(read, v2[1]!) ?? 0;
  return 0;
}

/** What nativeCodegenAvailableBytes reads on Linux, given in tests. */
export interface LinuxMemoryMeasurement {
  /** cgroupReclaimableBytes. */
  reclaimableBytes?: number;
  /** What the host reports available (MemAvailable). */
  hostAvailableBytes?: number;
}

/** The memory a build measures its lanes against. macOS counts only free and
 * inactive pages as available, which on a Mac that has been up for a while is
 * a small share of its RAM even when the rest is page cache the kernel
 * reclaims on demand, so physical memory is the floor there. Inside a
 * memory-limited cgroup on Linux, process.availableMemory() is the limit less
 * the cgroup's usage, and that usage counts the page cache the build fills
 * itself (the sources it read, the LLVM text it wrote) though the kernel
 * drops it on demand: a build on a warm cache measured 0.26 GB where
 * /proc/meminfo reported 7.8 GB available. The cgroup's reclaimable cache
 * counts as available there, up to what the host reports available. */
export function nativeCodegenAvailableBytes(
  measuredBytes: number,
  totalBytes: number = totalmem(),
  platform: NodeJS.Platform = process.platform,
  linux: LinuxMemoryMeasurement = {},
): number {
  if (platform === "darwin") return Math.max(measuredBytes, totalBytes);
  if (platform !== "linux") return measuredBytes;
  const reclaimable = linux.reclaimableBytes ?? cgroupReclaimableBytes();
  if (reclaimable === 0) return measuredBytes;
  const host = linux.hostAvailableBytes ?? freemem();
  return Math.max(measuredBytes, Math.min(measuredBytes + reclaimable, host));
}

/** The partitions one build compiles at once: its partitions, the host's
 * hardware threads, or as many lanes as the memory available for code
 * generation can give that much peak each, whichever is fewest. A module
 * that stays one partition is optimized as one and compiles on its own. */
export function nativeCodegenJobs(
  llvmBytes: number,
  partitions: number,
  options: NativeCodegenJobsOptions = {},
): number {
  const parallelism = Math.max(1, options.parallelism ?? availableParallelism());
  if (partitions < 2) return 1;
  let availableBytes = options.availableBytes;
  if (availableBytes === undefined) {
    try {
      availableBytes = process.availableMemory();
    } catch {
      // A host without the API measures nothing; assume a small one.
    }
    if (availableBytes === undefined) availableBytes = 8 * 1024 * 1024 * 1024;
    else availableBytes = nativeCodegenAvailableBytes(availableBytes);
  }
  // Each lane parses and optimizes one partition, so its peak is a multiple
  // of that partition's bytes, not of a thread's share of the module: a host
  // that divides a large module into more partitions than it has threads
  // still gives every lane one partition at a time.
  const partitionBytes = Math.max(1, llvmBytes / partitions);
  const laneBytes = Math.max(
    partitionBytes *
      (options.unoptimized === true
        ? UNOPTIMIZED_PARTITION_OVERHEAD
        : OPTIMIZED_PARTITION_OVERHEAD),
    MIN_LANE_BYTES,
  );
  const fit = Math.floor((availableBytes * CODEGEN_MEMORY_SHARE) / laneBytes);
  return Math.max(1, Math.min(parallelism, fit));
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

/** The frame that threw, as an error's stack names it, for a failure that
 * carries no message of its own. */
function throwingFrame(error: Error): string | null {
  const stack = error.stack;
  if (stack === undefined) return null;
  for (const line of stack.split("\n").slice(1)) {
    const text = line.trim();
    if (text !== "") return text.replace(/^at\s+/, "");
  }
  return null;
}

/** The text a native-pipeline failure reports. An error thrown without a
 * message — a compiler-internal refusal has none — still names what failed
 * and where it was thrown, so an SC3004 never ends at its code alone. */
export function failureText(error: unknown): string {
  if (!(error instanceof Error)) {
    // A thrown string (or another non-Error value) can be empty; the build
    // still has to say that the failure was the compiler's own.
    const text = String(error);
    return text.trim() === "" ? "internal compiler error (a non-Error value was thrown)" : text;
  }
  if (error.message !== "") return error.message;
  const frame = throwingFrame(error);
  const what =
    error.name === "" || error.name === "Error"
      ? "internal compiler error"
      : `internal compiler error (${error.name})`;
  return frame === null ? what : `${what} at ${frame}`;
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
  if (typeof parsed?.["message"] === "string" && parsed["message"].trim() !== "") {
    return {
      ...(typeof parsed["code"] === "string" ? { code: parsed["code"] } : {}),
      message: parsed["message"],
    };
  }
  // The helper reported no structured diagnostic, or one whose message is
  // blank (a native panic that named only its code): the child's exit status,
  // signal and output are then all the evidence there is. A loader, allocation
  // or abort message names a cause that the command line alone does not. The
  // diagnostic goes to stderr; stdout only carries a profile report, which a
  // failing helper may still have written before it ended.
  const structured = parsed !== null && typeof parsed["message"] === "string";
  const printed = structured
    ? ""
    : (stderr.trim() !== ""
        ? stderr
        : typeof failure.stdout === "string"
          ? failure.stdout
          : ""
      ).trim();
  const ending = helperEnding(failure);
  const status = ending === "" ? "" : ` (${ending})`;
  const output =
    printed === ""
      ? structured
        ? ": the native helper gave no reason"
        : ""
      : `: ${printed.slice(0, MAX_HELPER_FAILURE_OUTPUT)}${printed.length > MAX_HELPER_FAILURE_OUTPUT ? "…" : ""}`;
  return {
    ...(structured && typeof parsed["code"] === "string" ? { code: parsed["code"] } : {}),
    message: `${helperCommand(failure)}${status}${output}`,
  };
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
