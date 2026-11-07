/* The oracle the generative and metamorphic lanes share.
 *
 * scriptc reports every documented way a compiled program can differ from
 * Node as an SC60xx warning. A program that builds with no such warning must
 * therefore print the same stdout and stderr and exit with the same status
 * natively as under Node; anything else is a silent divergence.
 *
 * Builds run with SCRIPTC_NO_CACHE=1: a cached build does not replay the
 * warnings the first build printed, and the verdict depends on them.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const comptimeShim = join(repoRoot, "tests/harness/comptime-shim.mjs");

/** Every outcome a program can have, from best to worst. The baseline stores
 * the failing ones by name. */
export const FAILURES = ["refused", "internal-error", "runtime-error", "timeout", "silent-diff"];

export function requireBuiltCompiler() {
  if (!existsSync(cli)) {
    throw new Error(`${cli} is missing: build the workspace first (pnpm install && pnpm -r build)`);
  }
}

/** Creates the directory programs are written to and marks it an ES module
 * package, as tests/corpus is: Node then loads every program the way it
 * loads a corpus program, and prints no warning about guessing the format. */
export function programDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `{ "type": "module" }\n`);
  return directory;
}

/** Runs a command with stdin closed and returns its output as latin1 text, so
 * output that is not valid UTF-8 still compares byte for byte. */
export function run(command, args, { timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? "timeout" : (code ?? `signal ${signal}`),
        stdout: Buffer.concat(stdout).toString("latin1"),
        stderr: Buffer.concat(stderr).toString("latin1"),
      });
    };
    child.on("close", finish);
    child.on("error", (error) => {
      stderr.push(Buffer.from(String(error)));
      finish(null, "spawn");
    });
  });
}

/** Syntax Node's type stripping refuses and its transform accepts, as in
 * differential.test.ts: enums, namespaces and parameter properties. */
function needsTypeTransform(source) {
  return /\benum\s+[A-Za-z_$]|\bnamespace\s+[A-Za-z_$]|constructor\([^)]*\b(public|private|protected|readonly)\s/.test(
    source,
  );
}

function nodeArgs(entry, source) {
  const transform = needsTypeTransform(source)
    ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
    : [];
  const shims = source.includes("// @no-node-shims") ? [] : ["--import", comptimeShim];
  return [...transform, ...shims, entry];
}

function codes(text, kind) {
  return [...new Set([...text.matchAll(new RegExp(`${kind} (SC\\d{4})`, "g"))].map((m) => m[1]))];
}

/** Builds `entry` to `exe`. `errors` and `warnings` are the SC codes the
 * compiler printed; `internal` marks a compiler crash or SC9001. */
export async function build(entry, exe) {
  const result = await run("node", [cli, "build", entry, "-o", exe], {
    timeoutMs: 300_000,
    env: { ...process.env, SCRIPTC_NO_CACHE: "1" },
  });
  // An uncached build leaves its LLVM module beside the executable.
  rmSync(exe.replace(/\.[^./]+$/, ".ll"), { force: true });
  const text = result.stderr + result.stdout;
  const errors = codes(text, "error");
  return {
    ok: result.code === 0,
    text,
    errors,
    warnings: codes(text, "warning"),
    internal:
      result.code !== 0 &&
      (errors.length === 0 || errors.includes("SC9001") || /InternalCompilerError/.test(text)),
  };
}

/** Whether two runs agree the way the corpus differential requires: status
 * and stdout always, stderr for programs that exit 0 (the report of an
 * uncaught throw is a documented difference). */
export function sameRun(a, b) {
  return a.code === b.code && a.stdout === b.stdout && (a.code !== 0 || a.stderr === b.stderr);
}

/** Runs `entry` under Node and as `exe`, with the environment the corpus
 * differential gives both sides. */
export async function runBoth(entry, source, exe) {
  const env = { ...process.env, SCRIPTC_TEST_ENV: "from-harness" };
  const [node, native] = await Promise.all([
    run("node", nodeArgs(entry, source), { timeoutMs: 30_000, env }),
    run(exe, [], { timeoutMs: 30_000, env }),
  ]);
  return { node, native };
}

/** The verdict for a program that built: `match`, `warned-diff` (it differs
 * and the build said it could), or one of FAILURES. */
export function verdictOf(built, node, native) {
  if (sameRun(node, native)) return "match";
  if (node.code === "timeout" || native.code === "timeout") return "timeout";
  if (node.code === 0 && native.code !== 0) return "runtime-error";
  return built.warnings.some((code) => code.startsWith("SC60")) ? "warned-diff" : "silent-diff";
}

/** Builds and runs one program. `type-error` means tsc itself rejected the
 * source, which is a fault of whoever wrote the program, not of scriptc. */
export async function differential(entry, source, exe) {
  const built = await build(entry, exe);
  if (!built.ok) {
    const verdict = built.internal
      ? "internal-error"
      : built.errors.includes("SC0001")
        ? "type-error"
        : "refused";
    return { verdict, built };
  }
  const { node, native } = await runBoth(entry, source, exe);
  rmSync(exe, { force: true });
  return { verdict: verdictOf(built, node, native), built, node, native };
}

/** The first diagnostic line of a failed build, for reports. */
export function firstDiagnostic(built) {
  const line = built.text.split("\n").find((l) => /error SC\d{4}|InternalCompilerError/.test(l));
  return (line ?? built.text.trim().split("\n")[0] ?? "").replace(/^.*?(error SC\d{4})/, "$1");
}

export function describeRun(result) {
  return `exit ${result.code}\n--- stdout\n${result.stdout}--- stderr\n${result.stderr}`;
}

/** Runs `worker` over `items` with at most `jobs` in flight. */
export async function pool(items, jobs, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, jobs) }, async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    }),
  );
}
