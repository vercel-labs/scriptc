/* Deferred Node island modules (scope-B NI-7) where what the build-time
 * probe records decides the program's behaviour: a load that changes
 * another island module's exports, an export getter that runs code, a
 * file of the package that is missing when the build probes it, and stdio
 * that is a pipe at build time and a terminal when the program runs. The
 * fixtures are in tests/fixtures/node-island/deferral. Needs a libnode pack
 * in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);

/** stdout of `binary` run under a pseudo-terminal by script(1). util-linux's
 * takes the command with -c. The BSD one on macOS takes it after the
 * transcript file, needs a stdin that is not a socket, and echoes the EOF
 * it forwards from /dev/null as ^D and two backspaces. */
async function underTerminal(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== "darwin")
    return (await execFileAsync("script", ["-qec", binary, "/dev/null"], { env, encoding: "utf8" }))
      .stdout;
  const child = spawn("script", ["-q", "/dev/null", binary], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  expect(code).toBe(0);
  return stdout.replaceAll("^D\b\b", "");
}
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const fixtures = join(repoRoot, "tests/fixtures/node-island/deferral");
const corpus = join(repoRoot, "tests/corpus");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-deferral");
const skip = libnodePack() === null;

/** Builds a fixture (or a program of `root`) with the deferral trace on and
 * `set` in the build's environment, from `cwd` when given; answers the
 * binary and the build's trace lines. */
async function build(
  name: string,
  root = fixtures,
  set: Record<string, string> = {},
  entry = "main.ts",
  cwd?: string,
): Promise<{ binary: string; trace: string[] }> {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "main");
  const env = {
    ...process.env,
    SCRIPTC_NODE_ISLANDS_TRACE: "defer",
    SCRIPTC_CACHE_DIR: join(dir, "build-cache"),
    ...set,
  };
  const { stderr } = await execFileAsync(
    process.execPath,
    [cli, "build", join(root, name, entry), "-o", binary],
    { env, encoding: "utf8", cwd },
  );
  return { binary, trace: stderr.split("\n").filter((l) => l.startsWith("[node-islands] ")) };
}

async function run(binary: string): Promise<string> {
  const env = { ...process.env, XDG_CACHE_HOME: join(outDir, "cache") };
  return (await execFileAsync(binary, [], { env, encoding: "utf8" })).stdout;
}

/** The environment variables the absent-env corpus programs' packages read. */
const ABSENT_ENV = [
  "SCRIPTC_ABSENT_ENV_DEBUG",
  "SCRIPTC_ABSENT_ENV_TRACE",
  "SCRIPTC_ABSENT_ENV_LEVEL",
  "SCRIPTC_ABSENT_ENV_STRICT",
];

/** stdout, and the run-time trace lines, of `binary` run with the boot
 * trace on and `set` layered over an environment without ABSENT_ENV. */
async function runTraced(
  binary: string,
  set: Record<string, string> = {},
): Promise<{ stdout: string; trace: string[] }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CACHE_HOME: join(outDir, "cache"),
    SCRIPTC_NODE_ISLANDS_TRACE: "boot",
  };
  for (const key of ABSENT_ENV) delete env[key];
  const { stdout, stderr } = await execFileAsync(binary, [], {
    env: { ...env, ...set },
    encoding: "utf8",
  });
  return { stdout, trace: stderr.split("\n").filter((l) => l.startsWith("[node-islands] ")) };
}

/** stdout of the program under Node, in the same environment. */
async function underNode(
  name: string,
  set: Record<string, string> = {},
  entry = "main.ts",
): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ABSENT_ENV) delete env[key];
  const main = join(corpus, name, entry);
  return (
    await execFileAsync(process.execPath, [main], { env: { ...env, ...set }, encoding: "utf8" })
  ).stdout;
}

describe.skipIf(skip)("island modules whose loads read unset environment variables", () => {
  const unused = "8745-node-island-absent-env-unused";
  const late = "8747-node-island-absent-env-late";

  test("defer without a publicEnv listing, and Node never starts", async () => {
    const { binary, trace } = await build(unused, corpus);
    const decision = trace.find((l) => l.includes("quiet-pkg"));
    expect(decision).toMatch(/^\[node-islands\] defer /);
    expect(decision).toContain(
      "env guards SCRIPTC_ABSENT_ENV_DEBUG (unset),SCRIPTC_ABSENT_ENV_TRACE (unset),SCRIPTC_ABSENT_ENV_LEVEL (unset)",
    );
    const ran = await runTraced(binary);
    expect(ran.stdout).toBe(await underNode(unused));
    expect(ran.trace.some((l) => /^\[node-islands\] deferred .*quiet-pkg/.test(l))).toBe(true);
    expect(ran.trace).not.toContain("[node-islands] starting Node");
    expect(ran.trace.some((l) => l.includes("evaluating"))).toBe(false);
  }, 300_000);

  test("load at their import in a run that sets one of the variables", async () => {
    const { binary } = await build(late, corpus);
    for (const set of [
      { SCRIPTC_ABSENT_ENV_STRICT: "on" },
      { SCRIPTC_ABSENT_ENV_TRACE: "" },
      { SCRIPTC_ABSENT_ENV_LEVEL: "warn", SCRIPTC_ABSENT_ENV_STRICT: "off" },
    ]) {
      const ran = await runTraced(binary, set);
      expect(ran.stdout).toBe(await underNode(late, set));
      const [first] = Object.keys(set);
      const failed = ran.trace.indexOf(`[node-islands] boot guard failed: env ${first}`);
      expect(failed).toBeGreaterThanOrEqual(0);
      expect(ran.trace[failed + 1]).toMatch(/evaluating .* eagerly: a boot guard failed$/);
      expect(ran.trace[failed + 2]).toBe("[node-islands] starting Node");
    }
  }, 300_000);

  test("evaluate late against the environment of their import", async () => {
    const { binary, trace } = await build(late, corpus);
    expect(trace.filter((l) => l.startsWith("[node-islands] defer "))).toHaveLength(2);
    const ran = await runTraced(binary);
    expect(ran.stdout).toBe(await underNode(late));
    expect(ran.trace.filter((l) => l.startsWith("[node-islands] deferred "))).toHaveLength(2);
    expect(ran.trace.some((l) => l.includes("boot guard failed"))).toBe(false);
    // Node starts at the first call, after both imports.
    const started = ran.trace.indexOf("[node-islands] starting Node");
    expect(started).toBe(2);
  }, 300_000);
});

describe.skipIf(skip)("when deferred island modules evaluate", () => {
  test("all of them when Node starts, in import order, before the first call", async () => {
    const name = "8750-node-island-deferred-call-order";
    const { binary, trace } = await build(name, corpus);
    // The two packages, and the program's `install();`: a statement the
    // island evaluates (closed-island-init.ts), which waits with them.
    expect(trace.filter((l) => l.startsWith("[node-islands] defer "))).toHaveLength(3);
    expect(trace.every((l) => l.endsWith("evaluated when Node starts"))).toBe(true);
    const ran = await runTraced(binary);
    expect(ran.stdout).toBe(await underNode(name));
    // The module tree's install is traced where Node starts, by its own
    // unit; this test is about which deferred modules evaluate and when.
    const evaluation = ran.trace.filter((l) => l !== "[node-islands] installing the module tree");
    const short = (l: string): string =>
      l.replace(/ \S*node_modules\//, " ").replace(/closed\/main\.\w+\./, "closed/main.");
    expect(evaluation.map(short)).toEqual([
      "[node-islands] deferred patch-pkg/index.js",
      "[node-islands] deferred reader-pkg/index.js",
      "[node-islands] deferred ./.scriptc/closed/main.0.mjs",
      "[node-islands] starting Node",
      "[node-islands] Node started: evaluating 3 deferred module(s)",
      "[node-islands] evaluating deferred patch-pkg/index.js",
      "[node-islands] evaluating deferred reader-pkg/index.js",
      // After the second package, which read the state the call writes.
      "[node-islands] evaluating deferred ./.scriptc/closed/main.0.mjs",
    ]);
  }, 300_000);
});

describe.skipIf(skip)("island modules whose loads share state", () => {
  /** The trace without the module tree's install, and without the
   * directories in front of the package's files. */
  const short = (trace: string[]): string[] =>
    trace
      .filter((l) => l !== "[node-islands] installing the module tree")
      .map((l) => l.replace(/ \S*node_modules\/state-kit\//, " "));

  test("answer from their recorded loads in a run that loads them as the probe did", async () => {
    const name = "9893-node-island-load-order-as-probed";
    const { binary, trace } = await build(name, corpus, {}, "main.mjs");
    const decisions = trace.filter((l) => / (defer|eager) /.test(l));
    expect(decisions.length).toBeGreaterThanOrEqual(9);
    expect(decisions.every((l) => l.startsWith("[node-islands] defer "))).toBe(true);
    // The build saw the writes; they keep nothing eager.
    expect(decisions.some((l) => l.includes("mutates globalThis.__stateKitLevel"))).toBe(true);
    const ran = await runTraced(binary);
    expect(ran.stdout).toBe(await underNode(name, {}, "main.mjs"));
    expect(ran.stdout).toContain("libnode mapped: false\n");
    // Ten imports of nine modules, one of them from two modules of the
    // program: each registers, none evaluates, Node never starts.
    expect(short(ran.trace)).toEqual([
      "[node-islands] deferred global-writer.js",
      "[node-islands] deferred global-reader.js",
      "[node-islands] deferred global-writer.js",
      "[node-islands] deferred process-writer.js",
      "[node-islands] deferred process-reader.js",
      "[node-islands] deferred private-writer.js",
      "[node-islands] deferred private-reader.js",
      "[node-islands] deferred both-a.js",
      "[node-islands] deferred both-b.js",
      "[node-islands] deferred last-reader.js",
    ]);
  }, 300_000);

  test("evaluate at their import in a run that skipped a load the probe took", async () => {
    const name = "9891-node-island-load-order-not-taken";
    const { binary, trace } = await build(name, corpus, {}, "main.cjs");
    // Writer and reader both defer at build time: the build cannot know
    // which branch a run takes.
    for (const file of ["global-writer.js", "global-reader.js"])
      expect(trace.find((l) => l.includes(`state-kit/${file}`))).toMatch(
        /^\[node-islands\] defer /,
      );
    const ran = await runTraced(binary);
    expect(ran.stdout).toBe(await underNode(name, {}, "main.cjs"));
    // The first reader finds that the writer the probe loaded before it is
    // not registered: it evaluates there, which starts Node.
    expect(short(ran.trace).slice(0, 3)).toEqual([
      "[node-islands] boot guard failed: the loads before global-reader.js",
      "[node-islands] evaluating global-reader.js eagerly: a boot guard failed",
      "[node-islands] starting Node",
    ]);
    expect(ran.trace.some((l) => l.startsWith("[node-islands] deferred "))).toBe(false);
  }, 300_000);

  test("evaluate at their import in a run that reached a load before the probe did", async () => {
    const name = "9892-node-island-load-order-other-way";
    const { binary, trace } = await build(name, corpus, {}, "main.cjs");
    const order = trace
      .filter((l) => / (defer|eager) /.test(l))
      .map((l) => /state-kit\/([\w-]+\.js)/.exec(l)?.[1]);
    // The probe placed the operand's writer after the reader.
    expect(order.indexOf("global-reader.js")).toBeLessThan(order.indexOf("global-writer.js"));
    const ran = await runTraced(binary);
    expect(ran.stdout).toBe(await underNode(name, {}, "main.cjs"));
    // The run registers the writer first; the probe had loaded the reader
    // before it, so the writer's own record does not hold and it evaluates
    // at its import.
    expect(short(ran.trace).slice(0, 3)).toEqual([
      "[node-islands] boot guard failed: the loads before global-writer.js",
      "[node-islands] evaluating global-writer.js eagerly: a boot guard failed",
      "[node-islands] starting Node",
    ]);
  }, 300_000);
});

describe.skipIf(skip)("deferred Node island modules", () => {
  test("a build-time value another package's load cleared stays out of the program", async () => {
    const secret = "sk-build-only-7f3a9c";
    const { binary, trace } = await build("shared-secret", fixtures, {
      SCRIPTC_BUILD_SECRET: secret,
    });
    for (const pkg of ["first-pkg", "second-pkg"]) {
      const decision = trace.find((l) => l.includes(pkg));
      expect(decision).toMatch(/^\[node-islands\] eager /);
      expect(decision).toContain("SCRIPTC_BUILD_SECRET");
    }
    expect(readFileSync(binary).includes(secret)).toBe(false);
  }, 300_000);

  test("a build-time value an earlier load left where the probe compares nothing stays out of the program", async () => {
    const secret = "sk-build-only-41d8e2";
    const { binary, trace } = await build("shared-console", fixtures, {
      SCRIPTC_BUILD_SECRET: secret,
    });
    const reader = trace.find((l) => l.includes("token-reader"));
    expect(reader).toMatch(/^\[node-islands\] eager .*SCRIPTC_BUILD_SECRET/);
    const echo = trace.find((l) => l.includes("token-echo"));
    expect(echo).toMatch(/^\[node-islands\] eager .*an earlier load reads .*SCRIPTC_BUILD_SECRET/);
    expect(readFileSync(binary).includes(secret)).toBe(false);
    // The run reads its own environment, as Node does.
    const env = {
      ...process.env,
      XDG_CACHE_HOME: join(outDir, "cache"),
      SCRIPTC_BUILD_SECRET: "sk-run-5c0b17",
    };
    const { stdout } = await execFileAsync(binary, [], { env, encoding: "utf8" });
    expect(stdout).toBe("true sk-run-5c0b17\n");
  }, 300_000);

  test('a "lazy" load that read the working directory leaves nothing of it in the program', async () => {
    // Built from a directory outside the project, so no check for the
    // project's paths applies: the key of `cwd-kit`'s object and what
    // `cwd-echo` exports are left out of the snapshots as readings.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-build-cwd-")));
    try {
      const { binary, trace } = await build("lazy-cwd", fixtures, {}, "main.ts", cwd);
      expect(trace.find((l) => l.includes("cwd-kit/index.js: "))).toMatch(
        /^\[node-islands\] defer .*"evaluate": "lazy"; reads process\.cwd\(\)/,
      );
      expect(trace.find((l) => l.includes("cwd-echo/index.js: "))).toMatch(
        /^\[node-islands\] defer .*probed after a load that reads process\.cwd\(\)/,
      );
      const bytes = readFileSync(binary);
      expect(bytes.includes(cwd)).toBe(false);
      expect(bytes.includes(basename(cwd))).toBe(false);
      // The run reads its own working directory, as Node does.
      const env = { ...process.env, XDG_CACHE_HOME: join(outDir, "cache") };
      const options = { env, cwd: outDir, encoding: "utf8" as const };
      const node = await execFileAsync(
        process.execPath,
        ["--no-warnings", join(fixtures, "lazy-cwd", "main.ts")],
        options,
      );
      expect(node.stdout).toBe("cwd-kit true true\n");
      expect((await execFileAsync(binary, [], options)).stdout).toBe(node.stdout);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  test("a load that changes another island module's exports defers neither", async () => {
    const { binary, trace } = await build("mutate");
    expect(trace.some((l) => /eager .*pkg-a.*a later island module's load changes/.test(l))).toBe(
      true,
    );
    expect(
      trace.some((l) => /eager .*pkg-b.*changes another island module's exports/.test(l)),
    ).toBe(true);
    expect(await run(binary)).toBe("set by pkg-b true\n");
  }, 300_000);

  test("a load that changes an object exported through a getter defers neither", async () => {
    const { binary, trace } = await build("mutate-getter");
    expect(trace.some((l) => /eager .*pkg-a.*a later island module's load changes/.test(l))).toBe(
      true,
    );
    expect(
      trace.some((l) => /eager .*pkg-b.*changes another island module's exports/.test(l)),
    ).toBe(true);
    expect(await run(binary)).toBe("set by pkg-b true\n");
  }, 300_000);

  test("an export getter that runs code runs on every read", async () => {
    const { binary } = await build("getter");
    expect(await run(binary)).toBe("counter 1 2\n");
  }, 300_000);

  test("an export getter that reads a member runs on every read", async () => {
    const { binary } = await build("getter-member");
    expect(await run(binary)).toBe("counter 1 2\n");
  }, 300_000);

  test("a package file missing when the build probes keeps the module eager", async () => {
    const { binary, trace } = await build("missing-file");
    expect(trace.some((l) => /eager .*probe-pkg.*existsSync/.test(l))).toBe(true);
    expect(await run(binary)).toBe("extra false\n");
  }, 300_000);

  test("stdio's terminal state at run time is the program's", async () => {
    const { binary } = await build("tty");
    expect(await run(binary)).toBe("color false\n");
    // Under a pseudo-terminal the module sees a terminal, as under Node.
    const env = { ...process.env, XDG_CACHE_HOME: join(outDir, "cache") };
    expect((await underTerminal(binary, env)).replace(/\r/g, "")).toBe("color true\n");
  }, 300_000);
});
