import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { expect, test } from "vitest";
// @ts-expect-error -- a plain script without declarations
import {
  buildArguments,
  icuAvailable,
  requiresIcu,
  shimSource,
  verdict,
  workerPrograms,
} from "../../scripts/tsan-workers.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the lane covers the corpus programs that use worker threads", () => {
  const programs = workerPrograms() as string[];
  expect(programs.length).toBeGreaterThan(50);
  for (const program of programs) {
    expect(existsSync(program), program).toBe(true);
    const source = readFileSync(program, "utf8");
    expect(source).toMatch(/worker_threads/);
    // Programs that take hardware traps on purpose cannot run under ThreadSanitizer.
    expect(source).not.toMatch(/\bWebAssembly\b/);
  }
});

test("a build carries the directive head's defines and optimization", () => {
  const defined = buildArguments(
    `${root}/tests/corpus/define-node-env/main.ts`,
    "/tmp/program",
  ) as string[];
  expect(defined).toContain(`--define=process.env.NODE_ENV="production"`);
  expect(defined).toContain(`--define=process.env.SCRIPTC_FEATURE="on"`);
  expect(defined).not.toContain("--optimization=speed");
  // A program with no directive head builds exactly as before.
  const plain = buildArguments(`${root}/tests/corpus/1564-fs-watch.ts`, "/tmp/program") as string[];
  expect(
    plain.filter((arg) => arg.startsWith("--define") || arg.startsWith("--optimization")),
  ).toEqual([]);
});

test("a program that asks for speed compiles at --optimization=speed", () => {
  const file = `${root}/tests/corpus/4032-inline-rc-fast-paths.ts`;
  expect(buildArguments(file, "/tmp/program")).toContain("--optimization=speed");
});

test("ICU programs are skipped only where the runtime packs have no ICU", () => {
  expect(requiresIcu("// @requires-icu\n")).toBe(true);
  expect(requiresIcu("// @requires-icu-something\n")).toBe(false);
  expect(icuAvailable("linux", "x64")).toBe(true);
  expect(icuAvailable("darwin", "arm64")).toBe(false);
  expect(icuAvailable("linux", "arm64")).toBe(false);
});

test("the shim swaps the sanitizer and instruments the program's IR", () => {
  const shim = shimSource("/usr/bin/clang") as string;
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
