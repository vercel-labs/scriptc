// The dual-run engine: one program run twice, under Node.js and as the
// compiled binary, and the two runs compared. @scriptc/experimental's
// `dualRun` and the `dual-run/reporter` module are thin layers over it; the
// module itself is not reachable through the package's exports.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** Node runs the oracle with these flags: TypeScript's transform-only
 * features (enums, namespaces) need --experimental-transform-types, the
 * code-generation flag makes `eval` and `Function` throw the way a compiled
 * program always does, and the warning the transform flag prints is
 * silenced so both lanes have the same stderr. A .ts file in a package
 * without "type": "module" also warns about its module type, with the
 * process id in the warning, which neither lane should be compared on. */
const NODE_ORACLE_FLAGS = [
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
  "--disallow-code-generation-from-strings",
];

/** Both lanes run with this environment: a fixed time zone and locale keep
 * dates and collation out of the diff, as the repository's differential
 * harness does. */
const BASE_ENV = { TZ: "UTC", LANG: "C" };

/** The documented normalization, identical to tests/harness/node-test-normalize.ts:
 * Node's spec reporter embeds real durations in every line, and the stack
 * frames, the "N lines matching cause stack trace" fold and the inspect
 * property block are runner-internal output the compiled runtime omits.
 * Everything else must match byte-exactly. */
function normalizeNodeTestOutput(stdout) {
  const out = [];
  let inPropBlock = false;
  for (const line of stdout.split("\n")) {
    if (inPropBlock) {
      if (/^\s*\}\s*$/.test(line)) inPropBlock = false;
      continue;
    }
    if (/^\s+\.\.\. \d+ lines? matching cause stack trace \.\.\.$/.test(line)) continue;
    if (/^\s+at /.test(line)) {
      if (line.trimEnd().endsWith("{")) inPropBlock = true;
      continue;
    }
    out.push(
      line
        .replace(/\(\d+(?:\.\d+)?ms\)/g, "(Xms)")
        .replace(/^ℹ duration_ms .*$/, "ℹ duration_ms X"),
    );
  }
  return out.join("\n");
}

/** Thrown when the CLI cannot build a program: its diagnostics are the
 * build's own stderr, kept whole so a runner can print them. */
export class DualRunBuildError extends Error {
  constructor(entry, cli, stderr, exitCode) {
    super(
      `scriptc could not build ${entry}\n${stderr.trim()}` +
        (exitCode === null ? "" : `\n(build exited with code ${exitCode})`),
    );
    this.name = "DualRunBuildError";
    this.entry = entry;
    this.cli = cli;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/** The CLI as a command line: a JavaScript file runs under this Node, a
 * Windows .cmd shim needs a shell, anything else runs as it is. */
function commandFor(bin) {
  if (/\.(?:js|mjs|cjs)$/.test(bin))
    return { command: process.execPath, prefix: [bin], shell: false };
  if (process.platform === "win32" && /\.(?:cmd|bat)$/.test(bin))
    return { command: bin, prefix: [], shell: true };
  return { command: bin, prefix: [], shell: false };
}

/** The `scriptc` CLI: SCRIPTC_BIN when set, else the nearest
 * node_modules/.bin/scriptc from cwd upward, else PATH. */
function resolveScriptcBin({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.SCRIPTC_BIN) {
    const bin = isAbsolute(env.SCRIPTC_BIN) ? env.SCRIPTC_BIN : resolve(cwd, env.SCRIPTC_BIN);
    if (existsSync(bin)) return bin;
    throw new Error(`scriptc: SCRIPTC_BIN names ${bin}, which does not exist`);
  }
  const names =
    process.platform === "win32" ? ["scriptc.cmd", "scriptc.exe", "scriptc"] : ["scriptc"];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    for (const name of names) {
      const bin = join(dir, "node_modules", ".bin", name);
      if (existsSync(bin)) return bin;
    }
    if (dirname(dir) === dir) break;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const bin = join(dir, name);
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error(
    "scriptc: no scriptc executable found: install the scriptc package in this project, put it on PATH, or set SCRIPTC_BIN",
  );
}

/** Variables that would make a lane behave as a node:test child rather than
 * as a plain `node <file>` run. Node's test runner sets NODE_TEST_CONTEXT for
 * every test file it starts, and node:test then writes binary test events
 * instead of the spec report; a compiled program never does that, so a lane
 * that inherited the variable would differ for reasons the program does not
 * control. `dualRun` is often called from inside a test, so both lanes drop
 * it even when the caller names it. */
const LANE_ENV_DROPPED = ["NODE_TEST_CONTEXT"];

/** The merged environment both lanes run with. The fixed variables win over
 * the caller's, since a diff that depends on the machine's locale or time
 * zone would not be about the program. */
function laneEnv(env) {
  const merged = { ...process.env, ...env, ...BASE_ENV };
  for (const key of LANE_ENV_DROPPED) delete merged[key];
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

/** Runs a command to completion, capturing both streams. A spawn failure or
 * timeout rejects; a nonzero exit code does not. */
function runCommand(command, args, { cwd, env, stdin, timeoutMs = 120_000, shell = false }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    if (stdin !== undefined) {
      child.stdin.on("error", () => {}); // A program may exit before reading.
      child.stdin.end(stdin);
    }
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} did not finish within ${timeoutMs}ms`));
        return;
      }
      resolveRun({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code === null ? null : code,
        signal: signal ?? null,
      });
    });
  });
}

/** Builds one program through the `scriptc` CLI, whose executable cache
 * makes a repeated build a cache hit. The CLI prints the artifact path as
 * the last line of stdout. */
async function buildExecutable(entry, { cwd, env, timeoutMs } = {}) {
  const bin = resolveScriptcBin({ cwd, env });
  const { command, prefix, shell } = commandFor(bin);
  const absoluteEntry = resolve(cwd ?? process.cwd(), entry);
  if (!existsSync(absoluteEntry)) throw new Error(`scriptc: ${absoluteEntry} does not exist`);
  const build = await runCommand(command, [...prefix, "build", absoluteEntry], {
    cwd,
    env,
    timeoutMs,
    shell,
  });
  if (build.exitCode !== 0) {
    throw new DualRunBuildError(absoluteEntry, bin, build.stderr, build.exitCode);
  }
  const path = build.stdout.trim().split("\n").at(-1) ?? "";
  if (path === "" || !existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`scriptc: the build of ${absoluteEntry} did not print an artifact path`);
  }
  return { binaryPath: path, cli: bin };
}

/** One program under Node.js alone, in the oracle lane's environment: the
 * reporter runs it a second time to tell a flaky program from a divergent
 * one. */
export function runNodeLane(entry, { args = [], stdin, env = {}, cwd, timeoutMs = 120_000 } = {}) {
  const laneCwd = resolve(cwd ?? process.cwd());
  return runCommand(process.execPath, [...NODE_ORACLE_FLAGS, resolve(laneCwd, entry), ...args], {
    cwd: laneCwd,
    env: laneEnv(env),
    stdin,
    timeoutMs,
  });
}

/** Both lanes for one program: Node.js runs the entry with the oracle
 * flags, the binary runs as it was built. */
export async function runLanes(
  entry,
  { args = [], stdin, env = {}, cwd, timeoutMs = 120_000 } = {},
) {
  const laneCwd = resolve(cwd ?? process.cwd());
  const absoluteEntry = resolve(laneCwd, entry);
  const mergedEnv = laneEnv(env);
  const { binaryPath } = await buildExecutable(absoluteEntry, {
    cwd: laneCwd,
    env: mergedEnv,
    timeoutMs,
  });
  const [node, native] = await Promise.all([
    runCommand(process.execPath, [...NODE_ORACLE_FLAGS, absoluteEntry, ...args], {
      cwd: laneCwd,
      env: mergedEnv,
      stdin,
      timeoutMs,
    }),
    runCommand(binaryPath, args, { cwd: laneCwd, env: mergedEnv, stdin, timeoutMs }),
  ]);
  return { node, native, binaryPath, entry: absoluteEntry, cwd: laneCwd };
}

/** How the two runs differ, or null when they agree. stdout is compared
 * after the node:test normalization; stderr only when both runs exited 0,
 * because a nonzero run's stderr carries the uncaught-throw report, whose
 * format is a documented divergence (tests/harness/differential.test.ts
 * states the same rule). */
export function compareLanes(node, native) {
  const differences = [];
  if (node.exitCode !== native.exitCode) {
    differences.push({
      stream: "exit code",
      node: `${node.exitCode}`,
      native: `${native.exitCode}`,
    });
  }
  const nodeOut = normalizeNodeTestOutput(node.stdout);
  const nativeOut = normalizeNodeTestOutput(native.stdout);
  if (nodeOut !== nativeOut)
    differences.push({ stream: "stdout", node: nodeOut, native: nativeOut });
  if (node.exitCode === 0 && native.exitCode === 0) {
    const nodeErr = normalizeNodeTestOutput(node.stderr);
    const nativeErr = normalizeNodeTestOutput(native.stderr);
    if (nodeErr !== nativeErr)
      differences.push({ stream: "stderr", node: nodeErr, native: nativeErr });
  }
  return differences.length === 0 ? null : differences;
}

/** The first line index (0-based) where two texts differ, or -1. */
function firstDifference(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) if (al[i] !== bl[i]) return i;
  return -1;
}

/** The test line a differing report line belongs to: the nearest preceding
 * "<symbol> <name>" line, so a diff names the test it broke. */
function testNameAt(text, lineIndex) {
  const lines = text.split("\n");
  const result = /^\s*(?:✔|✖|▶|⚠)\s+(.*?)(?:\s+\((?:X|\d*\.?\d+)ms\))?(?:\s+#.*)?\s*$/;
  for (let i = Math.min(lineIndex, lines.length - 1); i >= 0; i--) {
    const match = result.exec(lines[i]);
    if (match && match[1] !== "") return match[1];
  }
  return null;
}

const DIFF_CONTEXT = 3;
const DIFF_MAX_LINES = 40;

/** A compact line diff: the differing line with a few lines of context on
 * each side, marked - for Node and + for the binary. */
function formatDiff(stream, node, native) {
  const line = firstDifference(node, native);
  if (line < 0) return "";
  const al = node.split("\n");
  const bl = native.split("\n");
  const start = Math.max(0, line - DIFF_CONTEXT);
  const end = Math.min(Math.max(al.length, bl.length), line + DIFF_CONTEXT + 1);
  const out = [`@@ ${stream} line ${line + 1}`];
  for (let i = start; i < end; i++) {
    if (al[i] === bl[i]) {
      out.push(`   ${al[i] ?? ""}`);
      continue;
    }
    out.push(` - ${al[i] ?? ""}`);
    out.push(` + ${bl[i] ?? ""}`);
  }
  if (end < Math.max(al.length, bl.length))
    out.push(`   … ${Math.max(al.length, bl.length) - end} more lines`);
  if (out.length > DIFF_MAX_LINES) out.length = DIFF_MAX_LINES;
  return out.join("\n");
}

/** One readable sentence and diff for the first difference. `name` is the
 * compared program as the caller wants it shown. */
export function describeDifferences(name, differences) {
  const first = differences[0];
  if (first.stream === "exit code")
    return `${name}: native exit code ${first.native}, node ${first.node}`;
  const where = firstDifference(first.node, first.native) + 1;
  const test = testNameAt(first.node, where - 1);
  const heading = `${name}${test === null ? "" : ` ${JSON.stringify(test)}`}: native ${first.stream} differs at line ${where}`;
  return `${heading}\n${formatDiff(first.stream, first.node, first.native)}`;
}
