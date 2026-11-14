import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import {
  buildArguments,
  runEnvironment,
  shimSource,
  skipReason,
  verdict,
  workerPrograms,
} from "../../scripts/tsan-workers.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the lane covers the corpus programs that use worker threads", () => {
  const programs = workerPrograms();
  expect(programs.length).toBeGreaterThan(50);
  for (const program of programs) {
    expect(existsSync(program), program).toBe(true);
    const source = readFileSync(program, "utf8");
    expect(source).toMatch(/worker_threads/);
    // Programs that take hardware traps on purpose cannot run under ThreadSanitizer.
    expect(source).not.toMatch(/\bWebAssembly\b/);
  }
});

test("the lane passes header directives that affect the build or run environment", () => {
  const definedPath = join(root, "tests", "corpus", "define-node-env", "main.ts");
  const defined = readFileSync(definedPath, "utf8");
  expect(buildArguments(defined)).toEqual([
    '--define=process.env.NODE_ENV="production"',
    '--define=process.env.SCRIPTC_FEATURE="on"',
  ]);
  expect(
    buildArguments('// @optimization: speed\n// @define: process.env.NODE_ENV="production"\n'),
  ).toEqual(["--optimization=speed", '--define=process.env.NODE_ENV="production"']);
  // Runtime-only directives are not build flags.
  expect(buildArguments("// @env: TZ=UTC\n// @exit: 1\n")).toEqual([]);
  expect(workerPrograms()).toContain(definedPath);

  const intl = readFileSync(join(root, "tests", "corpus", "intl-worker-first-use.ts"), "utf8");
  expect(
    runEnvironment(intl, { LC_ALL: "C.UTF-8", TSAN_OPTIONS: "halt_on_error=1" }),
  ).toMatchObject({
    TZ: "UTC",
    LC_ALL: "en_US.UTF-8",
    SCRIPTC_TEST_ENV: "from-harness",
    TSAN_OPTIONS: expect.stringContaining("halt_on_error=0:exitcode=66"),
  });
});

test("Intl worker programs are skipped only where the runtime pack has no ICU", () => {
  const source = readFileSync(join(root, "tests", "corpus", "intl-worker-first-use.ts"), "utf8");
  expect(skipReason(source, { platform: "linux", arch: "x64" })).toBeNull();
  expect(skipReason(source, { platform: "darwin", arch: "arm64" })).toMatch(/ICU/);
  expect(skipReason(source, { platform: "linux", arch: "arm64" })).toMatch(/ICU/);
});

test("the shim swaps the sanitizer and instruments the program's IR", () => {
  const shim = shimSource("/usr/bin/clang");
  expect(shim).toContain("-fsanitize=address) a=-fsanitize=thread");
  expect(shim).toContain("s/sanitize_address/sanitize_thread/g");
  expect(shim).toContain('"/usr/bin/clang" "$@"');
});

test("a run fails for a race report, a signal or a timeout, and for nothing else", () => {
  const fine = { status: 0, signal: null, timedOut: false, stderr: "" };
  expect(verdict(fine)).toBeNull();
  // The program's own exit status is the differential suite's business.
  expect(verdict({ ...fine, status: 1, stderr: "Uncaught Error: expected" })).toBeNull();
  const report =
    "WARNING: ThreadSanitizer: data race (pid=1)\nSUMMARY: ThreadSanitizer: data race a.c in f\n";
  expect(verdict({ ...fine, status: 66, stderr: report })).toBe(
    "ThreadSanitizer: data race a.c in f",
  );
  expect(verdict({ ...fine, status: null, signal: "SIGSEGV" })).toBe("killed by SIGSEGV");
  expect(verdict({ ...fine, status: null, signal: "SIGKILL", timedOut: true })).toBe(
    "ran out of time",
  );
});

test("every suppression is explained, and the list stays short", () => {
  const lines = readFileSync(new URL("./tsan.supp", import.meta.url), "utf8").split("\n");
  const entries = lines.flatMap((line, index) => (line.startsWith("race:") ? [index] : []));
  expect(entries.length).toBeLessThanOrEqual(5);
  for (const index of entries) expect(lines[index - 1], lines[index]).toMatch(/^# /);
  // Nothing but comments, blank lines and race entries.
  for (const line of lines) expect(line).toMatch(/^(#.*|race:\S+|)$/);
});

test("the workflow runs the lane nightly and on manual runs, not on pull requests", () => {
  const workflow = load(readFileSync(`${root}/.github/workflows/fuzz.yml`, "utf8")) as {
    jobs: Record<string, { if: string; steps: { run?: string }[] }>;
  };
  const job = workflow.jobs["tsan"]!;
  expect(job.if).toContain("github.event_name != 'pull_request'");
  expect(job.steps.some((step) => step.run?.includes("node scripts/tsan-workers.mjs"))).toBe(true);
});
