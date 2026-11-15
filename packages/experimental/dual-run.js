// @scriptc/experimental/dual-run — the program API.
//
// `dualRun` runs a program twice, once under Node.js and once as the
// executable scriptc builds from it, and compares the two runs: test names,
// pass/fail results, assertion messages, program output and the exit code,
// with the durations and stack frames both sides render differently
// normalized away. It is Node.js tooling (it spawns the compiler and the
// binary), so a scriptc-built program cannot call it; a test runner such as
// vitest or jest, which scriptc cannot compile, can.

import { compareLanes, describeDifferences, runLanes } from "./dual-run-core.js";

/**
 * Runs `entry` under Node.js and as its compiled executable, and compares
 * the runs.
 *
 * @param {string} entry The program, relative to `cwd`.
 * @param {{
 *   args?: readonly string[],
 *   stdin?: string | Uint8Array,
 *   env?: Record<string, string | undefined>,
 *   cwd?: string,
 *   timeoutMs?: number,
 * }} [options]
 *   `args` are passed to both lanes, `stdin` is written to both, and `env`
 *   is added to both lanes' environment (which always has TZ=UTC and
 *   LANG=C). `cwd` is the working directory of both lanes and of the
 *   build; `timeoutMs` bounds each lane's run.
 * @returns {Promise<{
 *   node: { stdout: string, stderr: string, exitCode: number | null },
 *   native: { stdout: string, stderr: string, exitCode: number | null },
 *   equal: boolean,
 *   diff: string,
 * }>}
 *   The two runs, `equal` when they agree, and a readable diff when they
 *   do not (`diff` is "" when `equal`). Rejects with a `DualRunBuildError`
 *   when the program does not compile, whose `stderr` holds the
 *   diagnostics.
 */
export async function dualRun(entry, options = {}) {
  const { node, native } = await runLanes(entry, options);
  const differences = compareLanes(node, native);
  return {
    node,
    native,
    equal: differences === null,
    diff: differences === null ? "" : describeDifferences(entry, differences),
  };
}

export { DualRunBuildError } from "./dual-run-core.js";
