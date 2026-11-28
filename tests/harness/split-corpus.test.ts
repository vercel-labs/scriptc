/* The split-corpus harness (M0): every corpus program with an installed npm
 * package runs three ways — under Node, as a compiled binary without
 * SCRIPTC_UNITS, and as a compiled binary with `SCRIPTC_UNITS=observe` — and
 * the three must agree byte for byte on stdout, stderr and exit code.
 *
 * For each program the observe build must report a graph of at least two
 * units, and two observe builds (each from a clean cache) must produce
 * identical summaries. A program that does not reach that is marked with its
 * reason; the marked list is M1's work queue. From M1 on the same harness
 * runs `SCRIPTC_UNITS=split` and compares its output against Node.
 *
 * Programs with no installed package cannot have two units, so they are not
 * part of the corpus here. Native-sdk's todo and counter join when that
 * checkout is present (SCRIPTC_NATIVE_SDK_ROOT, default ~/nsat).
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { shardSelect } from "./shard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheRoot = join(repoRoot, "node_modules/.cache/scriptc-tests/split-corpus");
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];

interface Program {
  /** Stable name: the corpus file or directory name. */
  name: string;
  entry: string;
  cwd: string;
}

/** Every corpus program that installs at least one package. A directory
 * program's entry is its main.<ext>; a flat file's package.json sits beside
 * the corpus files, so only directories with their own node_modules count. */
function programs(): Program[] {
  const out: Program[] = [];
  const seen = new Set<string>();
  for (const manifest of globSync(join(corpusDir, "*/node_modules/*/package.json")).sort()) {
    let at = dirname(manifest);
    while (at !== dirname(at) && basename(at) !== "node_modules") at = dirname(at);
    if (basename(at) !== "node_modules") continue;
    const programDir = dirname(at);
    if (seen.has(programDir)) continue;
    seen.add(programDir);
    const entry = ENTRY_EXTS.map((ext) => join(programDir, `main.${ext}`)).find((path) =>
      existsSync(path),
    );
    if (entry === undefined) continue;
    out.push({ name: relative(corpusDir, programDir), entry, cwd: programDir });
  }
  const sdkRoot = process.env["SCRIPTC_NATIVE_SDK_ROOT"] ?? join(homedir(), "nsat");
  for (const app of ["todo", "counter"]) {
    for (const ext of ENTRY_EXTS) {
      const entry = join(sdkRoot, "apps", app, `main.${ext}`);
      if (existsSync(entry)) {
        out.push({ name: `native-sdk/${app}`, entry, cwd: dirname(entry) });
        break;
      }
    }
  }
  // A local measurement shortcut: SCRIPTC_SPLIT_CORPUS_ONLY names substrings
  // of the programs to run (comma-separated). CI sets none.
  const only = (process.env["SCRIPTC_SPLIT_CORPUS_ONLY"] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const filtered =
    only.length === 0
      ? out
      : out.filter((program) => only.some((name) => program.name.includes(name)));
  return shardSelect(filtered, (program) => program.name);
}

interface Run {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function runNode(program: Program): Promise<Run> {
  const transform = programUsesTransform(program);
  const args = [
    ...(transform
      ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
      : []),
    ...(directiveHead(program).some((line) => /^\/\/ @no-deprecation\s*$/.test(line))
      ? ["--no-deprecation"]
      : []),
    program.entry,
  ];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: program.cwd,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: Buffer.from(failed.stdout ?? ""),
      stderr: Buffer.from(failed.stderr ?? ""),
      exitCode: typeof failed.code === "number" ? failed.code : 1,
    };
  }
}

/** Enums and namespaces need Node's transform (its default strip refuses
 * them), and an enum anywhere in the program's own sources selects it. */
function programUsesTransform(program: Program): boolean {
  const files = globSync(join(program.cwd, "**/*.{ts,mts,cts,js,mjs,cjs}"), {
    exclude: (name) => name.includes("node_modules"),
  });
  return [program.entry, ...files].some((file) => {
    try {
      return /\benum\s+[A-Za-z_$]/.test(readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  });
}

async function runBinary(path: string, program: Program): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(path, [], {
      cwd: program.cwd,
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), exitCode: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: Buffer.from(failed.stdout ?? ""),
      stderr: Buffer.from(failed.stderr ?? ""),
      exitCode: typeof failed.code === "number" ? failed.code : 1,
    };
  }
}

/** A program's directive head: its first two lines. */
function directiveHead(program: Program): string[] {
  return readFileSync(program.entry, "utf8").split("\n", 2);
}

/** `// @normalize-pid`: Node's process warnings name a pid; compare with it
 * replaced on both sides (as the differential harness does). */
function comparableStderr(stderr: Buffer, program: Program): Buffer {
  if (!directiveHead(program).some((line) => /^\/\/ @normalize-pid\s*$/.test(line))) return stderr;
  return Buffer.from(stderr.toString("utf8").replace(/^\(node:\d+\) /gm, "(node:PID) "), "utf8");
}

/** `// @exit: 1`: an uncaught-throw program, whose stderr format is a
 * documented divergence, so only stdout is compared. */
function exitCodeOf(program: Program): number {
  const head = directiveHead(program);
  for (const line of head) {
    const match = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (match !== null) return Number(match[1]);
  }
  return 0;
}

function safeName(name: string): string {
  return name.replaceAll("/", "-");
}

interface BuildOutcome {
  binary: string;
  units: number;
  observeLine: string | null;
}

async function build(
  program: Program,
  cacheDir: string,
  observe: boolean,
): Promise<BuildOutcome | { failed: string }> {
  // The compiler refuses a shared cache root that a process with another
  // user's umask made visible; without a private root it stores no summary,
  // and an empty determinism comparison would pass vacuously.
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(cacheDir, 0o700);
  const outDir = join(cacheRoot, safeName(program.name), observe ? "observe" : "plain");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, observe ? "observed" : "plain");
  const previousCache = process.env["SCRIPTC_CACHE_DIR"];
  const previousUnits = process.env["SCRIPTC_UNITS"];
  process.env["SCRIPTC_CACHE_DIR"] = cacheDir;
  if (observe) process.env["SCRIPTC_UNITS"] = "observe";
  else delete process.env["SCRIPTC_UNITS"];
  const lines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  // The observation line is the build's, not the program's: capture it
  // while the compile runs so the test's own stderr stays quiet.
  process.stderr.write = ((chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    const text = String(chunk);
    if (text.startsWith("scriptc units ")) {
      lines.push(text);
      return true;
    }
    return originalWrite(chunk);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(program.entry, {
      outputKind: "exe",
      outPath,
      outDir,
      optimization: "dev",
    });
    if (!result.ok) {
      const first = result.diagnostics[0];
      return {
        failed: first === undefined ? "unknown failure" : `${first.code}: ${first.message}`,
      };
    }
    const line = lines.find((text) => text.startsWith("scriptc units "));
    let units = 0;
    if (line !== undefined) {
      const parsed = JSON.parse(line.slice("scriptc units ".length)) as { units?: unknown[] };
      units = Array.isArray(parsed.units) ? parsed.units.length : 0;
    }
    return { binary: outPath, units, observeLine: line ?? null };
  } finally {
    process.stderr.write = originalWrite;
    if (previousCache === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = previousCache;
    if (previousUnits === undefined) delete process.env["SCRIPTC_UNITS"];
    else process.env["SCRIPTC_UNITS"] = previousUnits;
  }
}

/** Each stored unit's id → summary digest, from a build's own cache. */
function unitDigests(cacheDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const store = join(cacheDir, "units-v2");
  if (!existsSync(store)) return out;
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = join(store, entry.name, "meta.json");
    if (!existsSync(meta)) continue;
    const parsed = JSON.parse(readFileSync(meta, "utf8")) as {
      unit?: { id?: string };
      summaryDigest?: string;
    };
    if (typeof parsed.unit?.id === "string" && typeof parsed.summaryDigest === "string")
      out.set(parsed.unit.id, parsed.summaryDigest);
  }
  return out;
}

const statuses: { program: string; ready: boolean; reason: string | null }[] = [];

describe("SCRIPTC_UNITS=observe over the package corpus", () => {
  for (const program of programs()) {
    test(program.name, { timeout: 600_000 }, async () => {
      const name = safeName(program.name);
      const node = await runNode(program);
      const plain = await build(program, join(cacheRoot, "cache", `${name}-plain`), false);
      if ("failed" in plain) {
        statuses.push({
          program: program.name,
          ready: false,
          reason: `plain build refused: ${plain.failed}`,
        });
        return;
      }
      const plainRun = await runBinary(plain.binary, program);
      const exit = exitCodeOf(program);
      const nodeStderr = comparableStderr(node.stderr, program);
      expect(plainRun.exitCode, "plain build exit code").toBe(node.exitCode);
      expect(plainRun.exitCode, "program exit directive").toBe(exit);
      expect(plainRun.stdout.equals(node.stdout), "plain build stdout").toBe(true);
      if (exit === 0)
        expect(
          comparableStderr(plainRun.stderr, program).equals(nodeStderr),
          "plain build stderr",
        ).toBe(true);

      const observe = await build(program, join(cacheRoot, "cache", `${name}-observe-1`), true);
      if ("failed" in observe) {
        statuses.push({
          program: program.name,
          ready: false,
          reason: `observe build refused: ${observe.failed}`,
        });
        return;
      }
      const observeRun = await runBinary(observe.binary, program);
      expect(observeRun.exitCode, "observe build exit code").toBe(node.exitCode);
      expect(observeRun.stdout.equals(node.stdout), "observe build stdout").toBe(true);
      if (exit === 0)
        expect(
          comparableStderr(observeRun.stderr, program).equals(nodeStderr),
          "observe build stderr",
        ).toBe(true);
      expect(observeLine(observe), "observe build reports its graph").not.toBeNull();
      if (observe.units < 2) {
        statuses.push({
          program: program.name,
          ready: false,
          reason: `one unit (${observe.units}); no package edge reaches an installed package`,
        });
        return;
      }
      const second = await build(program, join(cacheRoot, "cache", `${name}-observe-2`), true);
      if ("failed" in second) {
        statuses.push({
          program: program.name,
          ready: false,
          reason: `second observe build refused: ${second.failed}`,
        });
        return;
      }
      const firstDigests = unitDigests(join(cacheRoot, "cache", `${name}-observe-1`));
      const secondDigests = unitDigests(join(cacheRoot, "cache", `${name}-observe-2`));
      expect(firstDigests.size, "observe build stored its summaries").toBeGreaterThan(0);
      expect(secondDigests.size, "second observe build stored its summaries").toBeGreaterThan(0);
      const same =
        firstDigests.size === secondDigests.size &&
        [...firstDigests].every(([id, digest]) => secondDigests.get(id) === digest);
      expect(same, "two observe builds produce identical summaries").toBe(true);
      statuses.push({ program: program.name, ready: true, reason: null });
    });
  }
});

function observeLine(outcome: BuildOutcome): string | null {
  return outcome.observeLine;
}

afterAll(() => {
  const ready = statuses.filter((status) => status.ready);
  const notReady = statuses.filter((status) => !status.ready);
  console.log(
    `split-corpus: ${ready.length} split-ready, ${notReady.length} not ready of ${statuses.length} run`,
  );
  for (const status of notReady) console.log(`  not ready: ${status.program}: ${status.reason}`);
  const reportPath = process.env["SCRIPTC_SPLIT_CORPUS_REPORT"];
  if (reportPath !== undefined && reportPath !== "")
    writeFileSync(reportPath, JSON.stringify(statuses, null, 2));
});
