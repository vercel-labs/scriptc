#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciTestPlan } from "./ci-test-plan.mjs";
import { expiredEntries, loadQuarantine, quarantineVerdict, today } from "./ci-quarantine.mjs";

export async function runCiTestPlan(plan, run) {
  const failures = [];
  const execute = async (task) => {
    try {
      await run(task);
    } catch (error) {
      failures.push({ name: task.name, error });
    }
  };
  // The side queue runs one task at a time beside the corpus. Once the corpus ends, each of its workers takes
  // side tasks too, from the same queue: in a plain shard the side queue usually outlasts the corpus, and its
  // last tasks would otherwise run alone on an idle runner. Every task runs once, and no more tasks run at once
  // than the shard's worker budget allows, each side task taking one worker.
  const queue = [...plan.side];
  const side = async () => {
    while (queue.length > 0) await execute(queue.shift());
  };
  const corpusWorkers = Number(plan.corpus.env.SCRIPTC_TEST_WORKERS);
  if (plan.sideWorkers === 0) {
    await execute(plan.corpus);
    await side();
  } else {
    await Promise.all([
      execute(plan.corpus).then(() =>
        Promise.all(Array.from({ length: corpusWorkers }, () => side())),
      ),
      side(),
    ]);
  }
  if (failures.length)
    throw new AggregateError(
      failures.map(({ error }) => error),
      `CI tests failed: ${failures.map(({ name }) => name).join(", ")}`,
    );
}

/**
 * Whether a task that exited with `code` passes. A task that failed passes only when its failure report (from
 * scripts/ci-failure-reporter.mjs) names nothing but quarantined flaky tests (scripts/ci-quarantine.mjs); each of
 * those is logged as a GitHub warning. Throws for a failed task.
 */
export function settleTask({
  name,
  code,
  signal,
  report,
  entries,
  date = today(),
  log = console.log,
}) {
  if (code === 0) return;
  const verdict = signal ? { pass: false } : quarantineVerdict(report, entries, date);
  if (!verdict.pass) throw new Error(`${name} exited with ${signal ?? code}`);
  for (const { file, fullName, entry } of verdict.quarantined)
    log(
      `::warning title=Quarantined flaky test::${file} > ${fullName} failed; it is quarantined until ` +
        `${entry.expires} (owner ${entry.owner}: ${entry.reason}), so ${name} passes.`,
    );
}

async function main() {
  const plan = ciTestPlan({
    shard: process.env.SCRIPTC_TEST_SHARD,
    flavor: process.env.SCRIPTC_SAN === "1" ? "san" : "plain",
    workers: Number(process.env.SCRIPTC_TEST_WORKERS ?? "4"),
    suite: process.env.SCRIPTC_CI_SUITE || "full",
  });
  const entries = loadQuarantine();
  for (const entry of expiredEntries(entries))
    console.log(
      `::warning title=Expired flaky-test quarantine::${entry.test} (owner ${entry.owner}) expired on ` +
        `${entry.expires} and fails the run again: fix it, or renew the entry in tests/harness/flaky-quarantine.json.`,
    );
  const reports = mkdtempSync(join(tmpdir(), "scriptc-ci-failures-"));
  let taskIndex = 0;
  try {
    await runCiTestPlan(
      plan,
      (task) =>
        new Promise((resolve, reject) => {
          const started = Date.now();
          const reportPath = join(reports, `${taskIndex++}.json`);
          console.log(`[CI] Starting ${task.name} (${task.env.SCRIPTC_TEST_WORKERS} workers)`);
          const child = spawn("pnpm", task.args, {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            env: {
              ...process.env,
              ...task.env,
              SCRIPTC_CI_TASK: task.name,
              SCRIPTC_CI_FAILURES: reportPath,
            },
            stdio: "inherit",
          });
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            console.log(
              `[CI] ${task.name}: ${signal ?? code} after ${((Date.now() - started) / 1000).toFixed(1)}s`,
            );
            try {
              const report = existsSync(reportPath)
                ? JSON.parse(readFileSync(reportPath, "utf8"))
                : undefined;
              settleTask({ name: task.name, code, signal, report, entries });
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        }),
    );
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
