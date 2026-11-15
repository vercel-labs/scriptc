/** One program's run in one lane. `exitCode` is null when a signal ended
 * the process. */
export interface DualRunLane {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface DualRunOptions {
  /** Arguments passed to both lanes. */
  args?: readonly string[];
  /** Written to both lanes' standard input, which is closed afterwards. */
  stdin?: string | Uint8Array;
  /** Added to both lanes' environment. The environment always sets TZ=UTC
   * and LANG=C, and never carries NODE_TEST_CONTEXT, which would make a
   * node:test program write binary test events instead of its report. An
   * entry left undefined removes the variable. */
  env?: Record<string, string | undefined>;
  /** Working directory of both lanes and of the build. Defaults to
   * process.cwd(). */
  cwd?: string;
  /** Bound on each lane's run, in milliseconds. Defaults to 120000. */
  timeoutMs?: number;
}

export interface DualRunResult {
  node: DualRunLane;
  native: DualRunLane;
  /** Whether the runs agree after the documented node:test normalization:
   * durations are replaced by a placeholder on both sides, stack frames,
   * the "N lines matching cause stack trace" fold and the inspect property
   * block are dropped, stderr is compared only when both runs exit 0, and
   * everything else matches byte-exactly. */
  equal: boolean;
  /** A readable diff of the first difference, "" when `equal`. */
  diff: string;
}

/** A build that did not produce an executable: the CLI's diagnostics are in
 * `stderr`. */
export declare class DualRunBuildError extends Error {
  readonly name: "DualRunBuildError";
  /** The program's absolute path. */
  readonly entry: string;
  /** The `scriptc` executable the build ran. */
  readonly cli: string;
  /** The build's stderr, whole. */
  readonly stderr: string;
  /** The build's exit code, null when a signal ended it. */
  readonly exitCode: number | null;
}

/** Runs `entry` once under Node.js and once as the executable scriptc
 * builds from it, and compares the two runs: test names, pass/fail results,
 * assertion messages, program output and the exit code. The build goes
 * through the scriptc CLI and its executable cache, and the CLI is found
 * through SCRIPTC_BIN, the nearest node_modules/.bin/scriptc from `cwd`
 * upward, or PATH. Rejects with a DualRunBuildError when the program does
 * not compile. */
export declare function dualRun(entry: string, options?: DualRunOptions): Promise<DualRunResult>;
