/** Native tool invocation without a JavaScript host or shell command construction. */
import type { NativeOptimization } from "./optimization.js";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { NativeHelperSpec, NativeTargetSpec } from "./targets.js";
import {
  nativePartitionPaths,
  validateNativeCodegenVersion,
  type NativeCodegenOutputKind,
} from "./native-codegen-core.js";
import {
  nativeProfileHelperArgs,
  parseNativeProfileMatch,
  type NativeProfileMatch,
  type NativeProfileOptions,
} from "./native-profile.js";

export function runNativeTool(
  executable: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): string {
  return execFileSync(executable, args, {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
    cwd: cwd ?? process.cwd(),
    env: env ?? process.env,
  });
}

export function requireNativeArtifact(path: string): void {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0)
    throw new Error(`native tool produced no artifact: ${path}`);
}

export function emitNativeObject(options: {
  executable: string;
  packageRoot: string;
  compilerVersion: string;
  target: NativeTargetSpec;
  helper: NativeHelperSpec;
  inputPath: string;
  outputPath: string;
  sourcePath: string;
  optimization: NativeOptimization;
  outputKind?: NativeCodegenOutputKind;
  /** Program partitions, written to nativePartitionPaths(outputPath). */
  partitions?: number;
  /** With several partitions: optimize the module whole and divide only its
   * code generation among them. */
  splitCodegen?: boolean;
  /** Private directory where the helper reuses partition artifacts. */
  partitionCache?: string;
  /** Profile-guided optimization: instrumentation or an indexed profile. */
  profile?: NativeProfileOptions;
  verified?: NativeHelperVerification;
}): { outputs: string[]; profileMatch: NativeProfileMatch | null } {
  verifyNativeHelper(options);
  const outputs = nativePartitionPaths(options.outputPath, options.partitions ?? 1);
  const stdout = runNativeTool(options.executable, [
    "emit",
    "--input",
    options.inputPath,
    ...outputs.flatMap((output) => ["--output", output]),
    "--filetype",
    options.outputKind ?? "obj",
    "--target",
    options.target.llvmTriple,
    "--opt-level",
    options.optimization === "dev" ? "0" : "2",
    "--relocation-model",
    options.target.relocationModel,
    "--diagnostic-format",
    "json",
    "--source-path",
    options.sourcePath,
    ...(options.splitCodegen === true && outputs.length > 1
      ? ["--split", "codegen"]
      : options.partitionCache === undefined || outputs.length < 2
        ? []
        : ["--cache-dir", options.partitionCache]),
    ...nativeProfileHelperArgs(options.profile),
  ]);
  for (const output of outputs) requireNativeArtifact(output);
  return {
    outputs,
    profileMatch: options.profile?.use === undefined ? null : parseNativeProfileMatch(stdout),
  };
}

/** Merges raw or indexed IR profiles into one indexed profile. */
export function mergeNativeProfiles(options: {
  executable: string;
  packageRoot: string;
  compilerVersion: string;
  target: NativeTargetSpec;
  helper: NativeHelperSpec;
  outputPath: string;
  inputPaths: readonly string[];
  sparse: boolean;
}): void {
  verifyNativeHelper(options);
  runNativeTool(options.executable, [
    "merge-profiles",
    "--output",
    options.outputPath,
    ...(options.sparse ? ["--sparse"] : []),
    ...options.inputPaths,
  ]);
}

/** Helpers that answered `version` as expected: `known` is true when the
 * helper file, as it is now, already did, and `remember` records that this
 * one just did. */
export interface NativeHelperVerification {
  known(): boolean;
  remember(): void;
}

/** Verify installed identity even when a caller can reuse a cached object.
 * With `verified`, the version probe runs only for a helper it does not
 * know yet. */
export function verifyNativeHelper(options: {
  executable: string;
  packageRoot: string;
  compilerVersion: string;
  target: NativeTargetSpec;
  helper: NativeHelperSpec;
  verified?: NativeHelperVerification;
}): void {
  const identity = JSON.parse(readFileSync(options.packageRoot + "/package.json", "utf8")) as {
    name: string;
    version: string;
  };
  if (
    identity.name !== options.helper.packageName ||
    identity.version !== options.compilerVersion
  ) {
    throw new Error(
      `LLVM helper package mismatch: expected ${options.helper.packageName}@${options.compilerVersion}`,
    );
  }
  if (options.verified?.known() === true) return;
  const version = JSON.parse(
    runNativeTool(options.executable, ["version", "--format=json"]),
  ) as Record<string, unknown>;
  validateNativeCodegenVersion(version, options.target, options.helper, options.compilerVersion);
  options.verified?.remember();
}
