/** Native tool invocation without a JavaScript host or shell command construction. */
import type { NativeOptimization } from "./optimization.js";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { NativeHelperSpec, NativeTargetSpec } from "./targets.js";
import { runOnCodegenServer } from "./codegen-server.js";
import {
  nativeHelperFailureMessage,
  nativePartitionPaths,
  validateNativeCodegenVersion,
  type NativeCodegenOutputKind,
  type NativeHelperFailure,
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

/** The error a failed helper call throws, described the same way a build on
 * the JavaScript host describes it: the helper's structured diagnostic when
 * it wrote one, else how the child ended and what it printed. A killed
 * helper otherwise leaves Node's unqualified "Command failed: <args>", which
 * says nothing about the signal that ended it. */
function helperFailureError(failure: NativeHelperFailure): Error {
  const parsed = nativeHelperFailureMessage(failure);
  const described = `LLVM native helper failed${parsed.code === undefined ? "" : ` (${parsed.code})`}: ${parsed.message}`;
  const error: Error & { status?: number; signal?: string | null } = new Error(described);
  if (typeof failure.code === "number") error.status = failure.code;
  else if (typeof failure.status === "number") error.status = failure.status;
  if (typeof failure.signal === "string") error.signal = failure.signal;
  return error;
}

/** A build that has a shared code generation server sends the helper's
 * commands to it, so that the helper's libraries and target stay registered
 * between builds, and runs them as processes only when no server answers.
 * The result is the helper's standard output, as runNativeTool returns it,
 * and a failed command throws as a failed process would. */
function runHelperTool(server: string | null, executable: string, args: string[]): string {
  const result =
    server === null ? null : runOnCodegenServer(server, executable, process.cwd(), args);
  if (result === null) {
    try {
      return runNativeTool(executable, args);
    } catch (error) {
      throw helperFailureError(error as NativeHelperFailure);
    }
  }
  if (result.status !== 0) {
    throw helperFailureError({
      message: `Command failed: ${executable} ${args.join(" ")}\n${result.stderr}`,
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result.stdout;
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
  /** Shared code generation server (codegenServerName), when the build has one. */
  server?: string | null;
  inputPath: string;
  outputPath: string;
  sourcePath: string;
  optimization: NativeOptimization;
  outputKind?: NativeCodegenOutputKind;
  /** Program partitions, written to nativePartitionPaths(outputPath). */
  partitions?: number;
  /** Private directory where the helper reuses partition artifacts. */
  partitionCache?: string;
  /** Profile-guided optimization: instrumentation or an indexed profile. */
  profile?: NativeProfileOptions;
  verified?: NativeHelperVerification;
}): { outputs: string[]; profileMatch: NativeProfileMatch | null } {
  verifyNativeHelper(options);
  const outputs = nativePartitionPaths(options.outputPath, options.partitions ?? 1);
  const stdout = runHelperTool(options.server ?? null, options.executable, [
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
    ...(options.partitionCache === undefined || outputs.length < 2
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
  /** Shared code generation server (codegenServerName), when the build has one. */
  server?: string | null;
  outputPath: string;
  inputPaths: readonly string[];
  sparse: boolean;
}): void {
  verifyNativeHelper(options);
  runHelperTool(options.server ?? null, options.executable, [
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
  /** Shared code generation server (codegenServerName), when the build has one. */
  server?: string | null;
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
    runHelperTool(options.server ?? null, options.executable, ["version", "--format=json"]),
  ) as Record<string, unknown>;
  validateNativeCodegenVersion(version, options.target, options.helper, options.compilerVersion);
  options.verified?.remember();
}
