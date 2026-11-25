/* @scriptc/experimental/dual-run, end to end: the program API compares a
 * node:test program under Node.js and as its compiled executable, and the
 * reporter does the same for every file `node --test` ran.
 *
 * The fixtures are four small programs: one passes, one fails an
 * assertion, one prints process.execPath (the one value the lanes cannot
 * share), and one uses a type the compiler refuses. Every build goes
 * through the scriptc CLI and its executable cache, with SCRIPTC_BIN
 * pointing at the workspace's CLI entry (the published package ships a
 * native binary instead). Both flavors build the fixtures the way a user
 * does, without the sanitizer, so the suite costs about the same in each;
 * the runtime these programs use runs sanitized in
 * tests/harness/node-test.test.ts. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DualRunBuildError, dualRun } from "@scriptc/experimental/dual-run";

const repoRoot = join(import.meta.dirname, "../..");
const fixturesDir = join(repoRoot, "tests/fixtures/dual-run");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const reporter = join(repoRoot, "packages/experimental/dual-run/reporter.js");

/** The CLI's environment: the workspace entry replaces the installed
 * `scriptc` binary, and the test cache the vitest config chose applies. */
function cliEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, SCRIPTC_BIN: cli, ...env };
}

/** Runs files through `node --test`, optionally with the dual-run reporter,
 * the way a CI job would, and returns what it printed and its exit code. */
function runNodeTest(
  files: string[],
  { withReporter }: { withReporter: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = withReporter
    ? ["--test", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", ...files]
    : ["--test", ...files];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`node --test died to ${signal}\n${Buffer.concat(err)}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code ?? 0,
      });
    });
  });
}

describe("dualRun", () => {
  test("a passing program matches its binary", async () => {
    const result = await dualRun(join(fixturesDir, "passing.test.mts"), {
      cwd: repoRoot,
      env: cliEnv(),
    });
    expect(result.equal).toBe(true);
    expect(result.diff).toBe("");
    expect(result.node.exitCode).toBe(0);
    expect(result.native.exitCode).toBe(0);
    expect(result.native.stdout).toContain("✔ adds");
  }, 180_000);

  test("a failing assertion is part of the comparison", async () => {
    const result = await dualRun(join(fixturesDir, "failing.test.mts"), {
      cwd: repoRoot,
      env: cliEnv(),
    });
    expect(result.equal).toBe(true);
    expect(result.node.exitCode).toBe(1);
    expect(result.native.exitCode).toBe(1);
    expect(result.native.stdout).toContain("ℹ fail 1");
  }, 180_000);

  test("Node's module-type warning is not a difference", async () => {
    const result = await dualRun(join(fixturesDir, "typeless.test.ts"), {
      cwd: repoRoot,
      env: cliEnv(),
    });
    expect(result.equal).toBe(true);
    // The warning names the process, so it could never match the binary.
    expect(result.node.stderr).toBe("");
  }, 180_000);

  test("a divergence is reported at the line it starts", async () => {
    const result = await dualRun(join(fixturesDir, "diverges.test.mts"), {
      cwd: repoRoot,
      env: cliEnv(),
    });
    expect(result.equal).toBe(false);
    expect(result.diff).toContain("native stdout differs at line 1");
    // The executable paths themselves, one on each side of the diff.
    expect(result.diff).toContain(` - ${process.execPath}`);
    expect(result.diff).toContain(" + ");
  }, 180_000);

  test("a program the compiler refuses rejects with the diagnostics", async () => {
    const entry = join(fixturesDir, "refused.ts");
    const error = (await dualRun(entry, { cwd: repoRoot, env: cliEnv() }).then(
      () => null,
      (e: unknown) => e,
    )) as DualRunBuildError | null;
    expect(error).toBeInstanceOf(DualRunBuildError);
    expect(error!.entry).toBe(entry);
    expect(error!.stderr).toContain("SC2020");
  }, 180_000);

  test("a call from inside a node:test run compares the file", async () => {
    // The runner starts its test files with NODE_TEST_CONTEXT set, where
    // node:test answers with binary test events instead of the spec report;
    // the lanes must not inherit it, or every call made from a test would
    // report a divergence that is not the program's.
    const run = await runNodeTest([join(fixturesDir, "dual-run-in-test.test.mts")], {
      withReporter: false,
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("✔ dualRun inside the runner compares the file");
    expect(run.exitCode).toBe(0);
  }, 180_000);
});

describe("dual-run reporter", () => {
  test("reports every file Node ran", async () => {
    const files = [
      "passing.test.mts",
      "failing.test.mts",
      "diverges.test.mts",
      "load-failure.mts",
    ].map((name) => join(fixturesDir, name));
    const run = await runNodeTest(files, { withReporter: true });
    const lines = run.stdout.split("\n");
    const lineFor = (name: string) =>
      lines.find((line) => line.includes(`tests/fixtures/dual-run/${name}`));
    expect(lineFor("passing.test.mts")).toMatch(/^✔ .*\(2 passed\)$/);
    // The comparison agrees, and the test failure Node reported is still
    // part of the report.
    expect(lineFor("failing.test.mts")).toMatch(/^✖ .*\(1 passed, 1 failed\)$/);
    expect(run.stdout).toContain("✖ fails: Expected values to be strictly deep-equal:");
    expect(lineFor("diverges.test.mts")).toMatch(/^✖ .*native stdout differs at line 1/);
    // A file Node itself could not load still gets a line, with the failure
    // Node reported for it; the comparison found the two lanes equal.
    expect(lineFor("load-failure.mts")).toMatch(/^✖ .*load-failure\.mts$/);
    expect(run.stdout).toMatch(/ ✖ .*load-failure\.mts: test failed \(line 1\)/);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
  }, 180_000);

  test("a failure declared in an imported module stays on the entry's line", async () => {
    const entry = join(fixturesDir, "imports-helper.test.mts");
    const run = await runNodeTest([entry], { withReporter: true });
    // Node counts the imported module's tests in the entry it ran, and its
    // failure names the module as the declaring file; the report keeps one
    // line for the entry and does not compare the module as a file of its
    // own.
    expect(run.stdout).toMatch(/^✖ .*imports-helper\.test\.mts \(2 passed, 1 failed\)$/m);
    expect(run.stdout).toContain("✖ helper fails: from the helper");
    expect(run.stdout).not.toContain("helper-failure.mjs");
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(1);
  }, 180_000);
});
