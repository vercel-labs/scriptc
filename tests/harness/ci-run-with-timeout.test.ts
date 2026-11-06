import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("../../scripts/ci-run-with-timeout.mjs", import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("a command that finishes keeps its own exit status", () => {
  const finished = run(
    "--timeout=30",
    "--label=exit",
    "--",
    process.execPath,
    "-e",
    "process.exit(7)",
  );
  expect(finished.status).toBe(7);
  expect(finished.stderr).toContain("exit: finished in");
});

test("a command that exceeds its limit is killed and named", () => {
  const hanging = run(
    "--timeout=1",
    "--label=hang",
    "--",
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000)",
  );
  // 124 is the status GNU timeout uses for the same failure.
  expect(hanging.status).toBe(124);
  expect(hanging.stderr).toContain("::error::hang did not finish within 1s");
  expect(hanging.stderr).toContain("killed `");
});

test("a command must follow the option separator", () => {
  const usage = run("--timeout=5", "--label=missing");
  expect(usage.status).toBe(2);
  expect(usage.stderr).toContain("usage: ci-run-with-timeout.mjs");
});

test("a quiet command inside a long limit is killed by the stall guard", () => {
  const quiet = run(
    "--timeout=60",
    "--stall=1",
    "--label=quiet",
    "--",
    process.execPath,
    "-e",
    "setTimeout(() => {}, 30000)",
  );
  expect(quiet.status).toBe(124);
  expect(quiet.stderr).toContain("::error::quiet printed nothing for 1s");
});

test("a command that keeps reporting progress outlives the stall guard", () => {
  const chatting = run(
    "--timeout=60",
    "--stall=1",
    "--label=chatty",
    "--",
    process.execPath,
    "-e",
    "let n = 0; const timer = setInterval(() => { console.log('tick', ++n); if (n === 6) { clearInterval(timer); } }, 500)",
  );
  expect(chatting.status).toBe(0);
  expect(chatting.stdout).toContain("tick 6");
  expect(chatting.stderr).toContain("chatty: finished in");
});
