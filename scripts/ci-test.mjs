#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ciTestPlan } from "./ci-test-plan.mjs";

export async function runCiTestPlan(plan, run) {
  const failures = [];
  const execute = async (task) => {
    try {
      await run(task);
    } catch (error) {
      failures.push({ name: task.name, error });
    }
  };
  const side = async () => {
    for (const task of plan.side) await execute(task);
  };
  if (plan.sideWorkers === 0) {
    await execute(plan.corpus);
    await side();
  } else {
    await Promise.all([execute(plan.corpus), side()]);
  }
  if (failures.length)
    throw new AggregateError(
      failures.map(({ error }) => error),
      `CI tests failed: ${failures.map(({ name }) => name).join(", ")}`,
    );
}

async function main() {
  const plan = ciTestPlan({
    shard: process.env.SCRIPTC_TEST_SHARD,
    flavor: process.env.SCRIPTC_SAN === "1" ? "san" : "plain",
    workers: Number(process.env.SCRIPTC_TEST_WORKERS ?? "4"),
    suite: process.env.SCRIPTC_CI_SUITE || "full",
  });
  await runCiTestPlan(
    plan,
    (task) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        console.log(`[CI] Starting ${task.name} (${task.env.SCRIPTC_TEST_WORKERS} workers)`);
        const child = spawn("pnpm", task.args, {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: { ...process.env, ...task.env, SCRIPTC_CI_TASK: task.name },
          stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          console.log(
            `[CI] ${task.name}: ${signal ?? code} after ${((Date.now() - started) / 1000).toFixed(1)}s`,
          );
          if (code === 0) resolve();
          else reject(new Error(`${task.name} exited with ${signal ?? code}`));
        });
      }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
