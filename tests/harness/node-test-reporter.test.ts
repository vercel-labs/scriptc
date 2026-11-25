/* A compiled node:test program takes Node's reporter options:
 * `--test-reporter=spec` (the only reporter the runtime carries) and
 * `--test-reporter-destination=stdout|stderr|<file>`, leading and in any
 * order like Node's own runtime flags. The lanes run the same command with
 * `node` and with the binary, and compare program stdout, the report
 * stream, the exit code, and the runtime flags the program sees.
 *
 * The fixtures print outside their tests (a test body's console output
 * races the reporter stream under Node — see node-test.test.ts), so program
 * output and the report are separate streams on both lanes: the report
 * follows the destination, program output stays on stdout. Exceptions are
 * Node's own, as pinned here: an unknown reporter is refused before any
 * test runs, because a binary cannot import one. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { normalizeNodeTestOutput } from "./node-test-normalize.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/node-test/reporter");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface LaneRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** One lane's run: cwd is the fixture directory, so both reporters render
 * "test at" paths relative to it. */
function runLane(cmd: string, args: string[], cwd = fixturesRoot): Promise<LaneRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`node:test program timed out\nstderr so far:\n${Buffer.concat(err)}`));
    }, 60_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`node:test program died to ${signal}\nstderr:\n${Buffer.concat(err)}`));
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

/** The executable cache: the same content builds once per flavor. */
async function build(name: string): Promise<string> {
  const entry = join(fixturesRoot, name);
  const hash = createHash("sha256");
  hash.update(entry).update(readFileSync(entry));
  const key = hash
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `node-test-reporter-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "node:test reporter fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

/** Both lanes with the same reporter arguments. The binary takes them
 * after its own path, Node before the entry, as each command line spells
 * its flags. */
async function bothLanes(name: string, flags: string[], extra: string[] = []) {
  const binary = await build(name);
  const entry = join(fixturesRoot, name);
  const [node, native] = await Promise.all([
    runLane("node", [...flags, entry, ...extra]),
    runLane(binary, [...flags, ...extra]),
  ]);
  return { node, native };
}

describe(`node:test reporter options${sanitize ? " (sanitized)" : ""}`, () => {
  test("spec to stdout matches Node", async () => {
    const { node, native } = await bothLanes("program-output.mts", [
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
    ]);
    expect(normalizeNodeTestOutput(native.stdout)).toBe(normalizeNodeTestOutput(node.stdout));
    expect(native.exitCode).toBe(1);
    expect(node.exitCode).toBe(1);
  }, 120_000);

  /* The destination takes the report off stdout and leaves program output
   * there: both lanes print "before tests" and "after tests" on stdout and
   * write the identical report into their own temporary file. */
  test("a file destination separates the report from program output", async () => {
    const dirs = {
      node: mkdtempSync(join(tmpdir(), "scriptc-reporter-node-")),
      native: mkdtempSync(join(tmpdir(), "scriptc-reporter-native-")),
    };
    const report = (lane: keyof typeof dirs) => join(dirs[lane], "report.txt");
    const binary = await build("program-output.mts");
    const entry = join(fixturesRoot, "program-output.mts");
    const [node, native] = await Promise.all([
      runLane("node", [
        "--test-reporter=spec",
        `--test-reporter-destination=${report("node")}`,
        entry,
      ]),
      runLane(binary, [`--test-reporter-destination=${report("native")}`, "--test-reporter=spec"]),
    ]);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stdout).toBe("before tests\nafter tests\n");
    expect(native.stderr).toBe("");
    expect(node.stderr).toBe("");
    expect(normalizeNodeTestOutput(readFileSync(report("native"), "utf8"))).toBe(
      normalizeNodeTestOutput(readFileSync(report("node"), "utf8")),
    );
    expect(native.exitCode).toBe(1);
    expect(node.exitCode).toBe(1);
  }, 120_000);

  test("a stderr destination matches Node", async () => {
    const { node, native } = await bothLanes("program-output.mts", [
      "--test-reporter=spec",
      "--test-reporter-destination=stderr",
    ]);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stdout).toBe("before tests\nafter tests\n");
    expect(normalizeNodeTestOutput(native.stderr)).toBe(normalizeNodeTestOutput(node.stderr));
    expect(native.exitCode).toBe(1);
    expect(node.exitCode).toBe(1);
  }, 120_000);

  /* The options are runtime flags, not program arguments, whichever order
   * they come in: process.execArgv lists them and process.argv does not. */
  const orders: [string, string[]][] = [
    ["reporter first", ["--test-reporter=spec", "--test-reporter-destination=stdout"]],
    ["destination first", ["--test-reporter-destination=stdout", "--test-reporter=spec"]],
  ];
  for (const [label, flags] of orders) {
    test(
      label,
      async () => {
        const { node, native } = await bothLanes("reporter-flags-argv.mts", flags);
        expect(normalizeNodeTestOutput(native.stdout)).toBe(normalizeNodeTestOutput(node.stdout));
        // The flag line itself: order and contents, before any normalization.
        expect(native.stdout.split("\n")[0]).toBe(node.stdout.split("\n")[0]);
        expect(native.exitCode).toBe(0);
        expect(node.exitCode).toBe(0);
      },
      120_000,
    );
  }

  /* On POSIX process.title overwrites the argument area the flags were
   * read from, so the flags must be reported from their own storage: a
   * title set before the first execArgv read changes nothing. */
  test("process.title does not lose the flags", async () => {
    const { node, native } = await bothLanes("reporter-flags-title.mts", [
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
    ]);
    // The flag line itself: the same execArgv, before any normalization.
    expect(native.stdout.split("\n")[0]).toBe(node.stdout.split("\n")[0]);
    expect(native.stdout.split("\n")[0]).toContain("--test-reporter=spec");
    expect(normalizeNodeTestOutput(native.stdout)).toBe(normalizeNodeTestOutput(node.stdout));
    expect(native.exitCode).toBe(0);
    expect(node.exitCode).toBe(0);
  }, 120_000);

  /* A binary carries only the spec reporter, so any other name is refused
   * before the program runs rather than silently reporting as spec. The
   * destination is not created either. */
  test("an unknown reporter is refused", async () => {
    const binary = await build("reporter-flags-argv.mts");
    const report = join(mkdtempSync(join(tmpdir(), "scriptc-reporter-unknown-")), "report.txt");
    const native = await runLane(binary, [
      "--test-reporter=tap",
      `--test-reporter-destination=${report}`,
    ]);
    expect(native.stdout).toBe("");
    expect(native.stderr).toBe(
      "scriptc: unknown test reporter 'tap': only the spec reporter is supported\n",
    );
    expect(native.exitCode).toBe(1);
    expect(existsSync(report)).toBe(false);
  }, 120_000);

  test("a destination that cannot be opened is refused", async () => {
    const binary = await build("reporter-flags-argv.mts");
    const missing = join(mkdtempSync(join(tmpdir(), "scriptc-reporter-missing-")), "no/report.txt");
    const native = await runLane(binary, [`--test-reporter-destination=${missing}`]);
    expect(native.stdout).toBe("");
    expect(native.stderr).toMatch(
      /^scriptc: cannot open test reporter destination '.*no\/report\.txt': .+\n$/,
    );
    expect(native.exitCode).toBe(1);
  }, 120_000);
});
