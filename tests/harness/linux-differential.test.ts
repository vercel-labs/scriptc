import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import ts5 from "typescript";
import { compile } from "@scriptc/compiler";
import { npmCases } from "./npm-cases.js";
import { normalizeNodeTestOutput } from "./node-test-normalize.js";
import { eventLoopCases, type StdinScript } from "./event-loop-cases.js";
import { tscJsxOracleEntry, wantsTscJsx } from "./jsx-oracle.js";

const execFileAsync = promisify(execFile);
const enabled = process.env["SCRIPTC_LINUX"] === "1";

const repoRoot = join(import.meta.dirname, "../..");
const corpusDir = join(repoRoot, "tests/corpus");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const target = process.env["SCRIPTC_LINUX_TARGET"] ?? "aarch64-linux-gnu.2.36";
const muslTarget = target.includes("linux-musl");
// The repo mounts at its OWN absolute path inside the container: compiled
// binaries bake build-host paths (module URLs in dynamic-import errors,
// __dirname/__filename), and the oracle must see the SAME strings — a
// neutral mount point like /scr makes every path-carrying output diverge
// by construction (the Windows lane skip-classifies that whole class as
// unreachable; a bind mount makes it just work here).
const mountPoint = repoRoot;
const containerName = `scr-linux-lane-${process.pid}`;

// The lane compiles the whole corpus natively and compares it with the
// Linux Node oracle. Any future target capability refusal is visible below.
function directiveHead(file: string): string[] {
  return readFileSync(file, "utf8").split("\n", 2);
}

/** `// @transform-types` (differential.test.ts's directive): the Node
 * oracle needs --experimental-transform-types for non-erasable syntax
 * (namespaces). Enum-declaring programs ride the same flag without a
 * directive, exactly like the macOS lane (the flags stay a pure function
 * of the program bytes). */
function wantsTransformTypes(file: string): boolean {
  if (directiveHead(file).some((l) => /^\/\/ @transform-types\s*$/.test(l))) return true;
  return programInputs(file).some((f) => /\benum\s+[A-Za-z_$]/.test(readFileSync(f, "utf8")));
}

/** `// @tsc-decorators` (differential.test.ts's directive): Node cannot
 * execute decorators at all, so the oracle runs tsc's ES2022 downlevel of
 * the program — materialized under the test cache, which lives inside the
 * repo mount, so the container reads it like any other corpus file. */
function wantsTscDecorators(file: string): boolean {
  return directiveHead(file).some((l) => /^\/\/ @tsc-decorators\s*$/.test(l));
}

/** The file the Node oracle executes: the program itself, or (decorator
 * programs) its deterministic ES2022 downlevel — differential.test.ts's
 * nodeOracleFile, with the identical transform and cache key. */
function nodeOracleFile(file: string): string {
  if (wantsTscJsx(directiveHead(file))) return tscJsxOracleEntry(file, cacheDir);
  if (!wantsTscDecorators(file)) return file;
  const src = readFileSync(file, "utf8");
  const out = ts5.transpileModule(src, {
    compilerOptions: { target: ts5.ScriptTarget.ES2022, module: ts5.ModuleKind.ESNext },
    fileName: file,
  }).outputText;
  const key = createHash("sha256")
    .update(ts5.version)
    .update("\0")
    .update(src)
    .digest("hex")
    .slice(0, 16);
  const path = join(cacheDir, `dec-oracle-${key}.mjs`);
  mkdirSync(cacheDir, { recursive: true });
  // Atomic publish: concurrent suites (the other flavor's full run, or
  // another lane over the same program) write this same content-keyed
  // path; rename keeps readers from ever seeing a truncated oracle.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
  return path;
}

/* Programs whose expected output depends on spawn EXEC-FAILURE errno
 * reporting — child_process must see ENOENT through posix_spawn(p)'s
 * return (Node's shape: error event / error property, never an exit).
 * Rosetta's amd64 emulation does not preserve libc's spawn errno relay:
 * posix_spawn returns 0 and the doomed child exits 127, so under
 * an EMULATED x86_64 container the runtime diverges from Node (whose
 * fork+CLOEXEC-pipe relay survives translation). Verified NOT a Linux
 * gap, twice over: the same programs pass byte-equal in the NATIVE
 * aarch64 container, and the mechanism probe (posix_spawn of a missing
 * path) returns ENOENT on real x86_64 hardware — a glibc-2.34 Vercel
 * sandbox — while returning 0/exit-127 only under Rosetta. Skipped only
 * when the x86_64 container is emulated (arm64-mac host); a real x86_64
 * host runs them. */
const ROSETTA_SPAWN_SKIP_REASON =
  "spawn exec-failure errno: Rosetta drops posix_spawn's libc errno relay (rc 0, child exits 127); passes on native aarch64 and real x86_64";
const ROSETTA_SPAWN_SKIPS = new Set([
  "1360-spawn-sync.ts",
  "1361-spawn-events.ts",
  "1363-spawn-unhandled-error.ts",
  "1462-exec-sync.ts",
  "1470-child-lifecycle.ts",
  "1472-errno-code.ts",
  "1473-promisify-execfile.ts",
  "1482-spawnsync-error.ts",
  "1522-spawnsync-options.ts",
  "1523-spawn-options.ts",
  "1565-spawn-pipe-streams.ts",
  "1655-spawnsync-neutral.ts",
  "1656-execsync-neutral.ts",
  "1657-spawn-async-neutral.ts",
]);
const emulatedX64 =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  (process.env["SCRIPTC_LINUX_TARGET"] ?? "").startsWith("x86_64");

const filter = process.env["SCRIPTC_LINUX_FILTER"];
const ENTRY_EXTS = ["ts", "js", "mjs", "cjs"];
const files = enabled
  ? ENTRY_EXTS.flatMap((ext) => [
      ...globSync(join(corpusDir, `*.${ext}`)),
      ...globSync(join(corpusDir, `*/main.${ext}`)),
    ])
      .sort()
      .filter((f) => filter === undefined || new RegExp(filter).test(f))
  : [];

if (enabled) {
  // compileC reads these at call time; this file runs in its own worker
  // process, so the macOS lanes never see them.
  process.env["SCRIPTC_CC"] = "zigcc";
  process.env["SCRIPTC_TARGET"] = target;
}
process.env["SCRIPTC_TEST_ENV"] = "from-harness";

interface RunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function expectedExitCode(file: string): number {
  for (const line of directiveHead(file)) {
    const m = /^\/\/ @exit:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Runs a command INSIDE the lane container via docker exec, stdin ended
 * immediately (differential.test.ts's contract: fd-0 readers see an empty
 * closed stream), cwd = the mounted repo root, the harness env marker set.
 * `env` adds per-run variables (the fetch legs' proxy poison / opt-in). */
async function runInContainer(
  argv: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const pending = execFileAsync(
    "docker",
    [
      "exec",
      "-i",
      "-w",
      mountPoint,
      "-e",
      "SCRIPTC_TEST_ENV=from-harness",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      containerName,
      ...argv,
    ],
    { encoding: "buffer" },
  );
  pending.child.stdin?.end();
  try {
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer; stderr?: Buffer };
    if (typeof e.code !== "number" || !Buffer.isBuffer(e.stdout) || !Buffer.isBuffer(e.stderr)) {
      throw err;
    }
    return { stdout: e.stdout, stderr: e.stderr, exitCode: e.code };
  }
}

/** Host path → the same file inside the container (the repo is bind-mounted
 * whole at mountPoint). */
function inContainer(hostPath: string): string {
  if (!hostPath.startsWith(repoRoot)) throw new Error(`not under the repo mount: ${hostPath}`);
  return mountPoint + hostPath.slice(repoRoot.length);
}

async function runLinuxNode(file: string): Promise<RunResult> {
  return runInContainer([
    "node",
    ...(wantsTransformTypes(file)
      ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"]
      : []),
    ...(directiveHead(file).some((l) => /^\/\/ @no-deprecation\s*$/.test(l))
      ? ["--no-deprecation"]
      : []),
    ...(directiveHead(file).some((l) => /^\/\/ @disallow-code-generation\s*$/.test(l))
      ? ["--disallow-code-generation-from-strings"]
      : []),
    ...(directiveHead(file).includes("// @no-node-shims")
      ? []
      : ["--import", inContainer(join(repoRoot, "tests/harness/comptime-shim.mjs")), "--import"]),
    inContainer(nodeOracleFile(file)),
  ]);
}

function programInputs(file: string): string[] {
  if (!/\/main\.(ts|js|mjs|cjs)$/.test(file)) return [file];
  return [
    ...[...ENTRY_EXTS, "tsx", "jsx"].flatMap((ext) => globSync(join(file, `../**/*.${ext}`))),
    ...globSync(join(file, "../**/tsconfig.json")),
    ...globSync(join(file, "../**/package.json")),
  ].sort();
}

async function crossCompileAndRun(file: string): Promise<RunResult> {
  const hash = createHash("sha256");
  for (const f of programInputs(file)) hash.update(f).update(readFileSync(f));
  const key = hash.update("linux\0").update(target).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "corpus program failed to cross-compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return runInContainer([inContainer(result.binaryPath)]);
}

/* ── the LISTENING-fixture legs (tests/fixtures/server, tests/fixtures/dgram)
 * — server.test.ts's three-legged contract with every process in the
 * container: the fixture program (Node lane and cross-compiled lane), and
 * the per-case driver script that talks to it over the PORT protocol
 * (`PORT <n>` on stderr; stderr is never compared, so ephemeral ports
 * stay out of every compared stream). */

interface FixtureRun {
  stdout: Buffer;
  exitCode: number;
  /** The driver's stdout, "" for driver-less cases. */
  driverStdout: string;
}

/** Runs one lane inside the container: spawn the fixture via docker exec,
 * follow the PORT protocol when the case has a driver (the driver is the
 * container's node), and collect all three compared legs. */
function runFixtureLane(argv: string[], driver: string | null): Promise<FixtureRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-w", mountPoint, containerName, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let errText = "";
    let driverStarted = false;
    let driverStdout = "";
    let driverDone: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture timed out\nstderr so far:\n${errText}`));
    }, 60_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      errText += c.toString("utf8");
      if (driver !== null && !driverStarted) {
        const m = /^PORT (\d+)$/m.exec(errText);
        if (m) {
          driverStarted = true;
          driverDone = new Promise<void>((res, rej) => {
            const d = spawn(
              "docker",
              ["exec", "-w", mountPoint, containerName, "node", inContainer(driver), m[1]!],
              { stdio: ["ignore", "pipe", "inherit"] },
            );
            d.stdout.on("data", (c: Buffer) => (driverStdout += c.toString("utf8")));
            d.on("close", (code) => {
              if (code === 0) res();
              else rej(new Error(`driver exited ${code}`));
            });
          });
        }
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`fixture died to ${signal}\nstderr:\n${errText}`));
        return;
      }
      if (driver !== null && !driverStarted) {
        reject(new Error(`fixture exited without a PORT line\nstderr:\n${errText}`));
        return;
      }
      driverDone.then(
        () => resolve({ stdout: Buffer.concat(out), exitCode: code ?? 0, driverStdout }),
        reject,
      );
    });
  });
}

async function crossCompileFixture(entry: string): Promise<string> {
  const hash = createHash("sha256");
  for (const f of programInputs(entry)) hash.update(f).update(readFileSync(f));
  const key = hash.update("linux\0").update(target).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "fixture failed to cross-compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

function fixtureCases(root: string): { name: string; entry: string; driver: string | null }[] {
  if (!enabled) return [];
  return globSync(join(root, "cases/*/main.ts"))
    .sort()
    .filter((f) => filter === undefined || new RegExp(filter).test(f))
    .map((entry) => ({
      name: entry.split("/").at(-2)!,
      entry,
      driver: existsSync(join(entry, "../driver.mjs")) ? join(entry, "../driver.mjs") : null,
    }));
}

const serverCases = fixtureCases(join(repoRoot, "tests/fixtures/server"));
const dgramCases = fixtureCases(join(repoRoot, "tests/fixtures/dgram"));

const fetchCases = fixtureCases(join(repoRoot, "tests/fixtures/fetch"));
const fetchServersScript = join(repoRoot, "tests/fixtures/fetch/servers.mjs");

const linuxNpmCases = enabled
  ? npmCases(join(repoRoot, "tests/fixtures")).filter(
      (c) => filter === undefined || new RegExp(filter).test(c.entry),
    )
  : [];

/* ── the node:test differential (tests/fixtures/node-test) —
 * node-test.test.ts's contract: both lanes run in-container (cwd = the
 * repo root, so the reporters' "test at" paths agree), stdout compared
 * after the documented normalization (node-test-normalize.ts — durations,
 * runner-internal frames, the property block), exit codes against the
 * fixture's `// @exit:` line. */

const nodeTestCases = enabled
  ? globSync(join(repoRoot, "tests/fixtures/node-test/cases/*.ts"))
      .sort()
      .filter((f) => filter === undefined || new RegExp(filter).test(f))
      .map((entry) => ({ name: entry.split("/").at(-1)!.replace(/\.ts$/, ""), entry }))
  : [];

/* ── the piped-stdin differential (tests/harness/event-loop-cases.ts —
 * event-loop.test.ts's exact fixtures and stdin scripts): the corpus arm
 * closes stdin immediately, so the stdin DATA paths run here, the pipe
 * carried by docker exec -i (closing the client end propagates EOF; the
 * held-open script ends when the program destroys its stdin and exits). */

const linuxStdinCases = enabled
  ? eventLoopCases.filter(
      (c) =>
        filter === undefined ||
        new RegExp(filter).test(join(repoRoot, "tests/fixtures/event-loop", c.fixture)),
    )
  : [];

/** Runs one lane with a scripted stdin through docker exec -i. */
function runWithStdinInContainer(
  argv: string[],
  script: StdinScript,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "-w",
        mountPoint,
        "-e",
        "SCRIPTC_TEST_ENV=from-harness",
        containerName,
        ...argv,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    let errText = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`stdin fixture timed out\nstderr so far:\n${errText}`));
    }, 60_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (errText += c.toString("utf8")));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`stdin fixture died to ${signal}\nstderr:\n${errText}`));
        return;
      }
      resolve({ stdout: Buffer.concat(out).toString("utf8"), exitCode: code ?? 0 });
    });
    void (async () => {
      for (const w of script.writes) {
        await new Promise((r) => setTimeout(r, w.delayMs));
        child.stdin.write(w.data);
      }
      if (script.end) child.stdin.end();
      // Held-open pipes close when the child exits (spawn cleans up).
    })();
  });
}

async function crossCompileNpmCase(entry: string): Promise<string> {
  const hash = createHash("sha256");
  const fixtureDir = join(entry, "../..");
  const inputs = [
    entry,
    ...globSync(join(fixtureDir, "**/node_modules/**/*.{js,mjs,cjs,json,d.ts}")).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash.update("linux\0").update(target).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "npm case failed to cross-compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

async function crossCompileFetchFixture(entry: string): Promise<string> {
  const hash = createHash("sha256");
  const inputs = [
    entry,
    ...globSync(
      join(repoRoot, "tests/fixtures/fetch/node_modules/**/*.{js,mjs,cjs,json,d.ts}"),
    ).sort(),
  ];
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  const key = hash.update("linux\0").update(target).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, key);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "fetch fixture failed to cross-compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

describe.skipIf(!enabled)(`linux differential (${target})`, () => {
  beforeAll(async () => {
    // Fail instead of skipping: SCRIPTC_LINUX=1 promises a Linux verdict.
    await execFileAsync("zig", ["version"]).catch(() => {
      throw new Error(
        "SCRIPTC_LINUX=1 needs zig on PATH (zigup) — the lane cross-compiles with `zig cc`.",
      );
    });
    await execFileAsync("docker", ["info"]).catch(() => {
      throw new Error("SCRIPTC_LINUX=1 needs the Docker daemon running (`open -a Docker`).");
    });
    const nodeVersion = readFileSync(join(repoRoot, ".node-version"), "utf8").trim();
    const image = `node:${nodeVersion}-${muslTarget ? "alpine" : "bookworm"}`;
    await execFileAsync("docker", [
      "run",
      "-d",
      "--rm",
      // The container's CPU arch follows the TARGET triple, so
      // SCRIPTC_LINUX_TARGET selects the container architecture from the
      // triple: x86_64 targets run the whole lane under linux/amd64
      // (Rosetta/qemu on Apple-silicon Docker), while AArch64 targets use
      // linux/arm64. The oracle Node and cross binaries always share it.
      "--platform",
      target.startsWith("x86_64") ? "linux/amd64" : "linux/arm64",
      "--name",
      containerName,
      "-v",
      `${repoRoot}:${mountPoint}`,
      "--init",
      image,
      "sleep",
      "infinity",
    ]);
  }, 300_000);

  afterAll(async () => {
    await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
  });

  // skipIf(empty): a SCRIPTC_LINUX_FILTER narrowing to fixtures only must not
  // fail the corpus suite for having no tests (and vice versa).
  describe.skipIf(files.length === 0)(`corpus (${files.length} programs)`, () => {
    test.for(files.map((f) => [f.slice(corpusDir.length + 1), f] as const))(
      "%s",
      async ([rel, file], ctx) => {
        if (emulatedX64 && ROSETTA_SPAWN_SKIPS.has(rel)) ctx.skip(ROSETTA_SPAWN_SKIP_REASON);
        let results: [RunResult, RunResult];
        try {
          results = await Promise.all([runLinuxNode(file), crossCompileAndRun(file)]);
        } catch (err) {
          // Programs whose IR needs a cross-gated feature (tls/zlib/... —
          // see native-toolchain.ts) SKIP with the gate's reason: they are follow-up
          // scope, not Linux failures. Everything else is a real failure.
          if (err instanceof Error && err.message.includes("not supported under a cross target")) {
            ctx.skip(
              err.message.split("\n").find((l) => l.includes("not supported")) ?? err.message,
            );
          }
          throw err;
        }
        const [nodeRes, nativeRes] = results;
        if (!nodeRes.stdout.equals(nativeRes.stdout)) {
          expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
          expect.unreachable("stdout differed at byte level but not after utf8 decode");
        }
        const expectedExit = expectedExitCode(file);
        if (expectedExit === 0) {
          if (!nodeRes.stderr.equals(nativeRes.stderr)) {
            expect(nativeRes.stderr.toString("utf8")).toBe(nodeRes.stderr.toString("utf8"));
            expect.unreachable("stderr differed at byte level but not after utf8 decode");
          }
        }
        expect(nodeRes.exitCode).toBe(expectedExit);
        expect(nativeRes.exitCode).toBe(expectedExit);
      },
    );
  });

  for (const [label, cases] of [
    ["server", serverCases],
    ["dgram", dgramCases],
  ] as const) {
    describe.skipIf(cases.length === 0)(`${label} fixtures (${cases.length} cases)`, () => {
      test.for(cases.map((c) => [c.name, c] as const))(
        "%s",
        async ([, c], ctx) => {
          let binary: string;
          try {
            binary = await crossCompileFixture(c.entry);
          } catch (err) {
            // A case needing a still-gated feature skips with the gate's
            // reason (nothing in these fixture sets does today).
            if (
              err instanceof Error &&
              err.message.includes("not supported under a cross target")
            ) {
              ctx.skip(
                err.message.split("\n").find((l) => l.includes("not supported")) ?? err.message,
              );
            }
            throw err;
          }
          // Sequential, not parallel: both lanes bind ephemeral ports and
          // drive real sockets — parallelism buys little and interleaves
          // kernel state (server.test.ts's stance).
          const nodeRes = await runFixtureLane(["node", inContainer(c.entry)], c.driver);
          const nativeRes = await runFixtureLane([inContainer(binary)], c.driver);
          expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
          if (!nodeRes.stdout.equals(nativeRes.stdout)) {
            expect.unreachable("stdout differed at byte level but not after utf8 decode");
          }
          expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
          expect(nativeRes.driverStdout).toBe(nodeRes.driverStdout);
        },
        120_000,
      );
    });
  }

  describe.skipIf(fetchCases.length === 0)(`fetch fixtures (${fetchCases.length} cases)`, () => {
    let serversChild: ReturnType<typeof spawn> | undefined;
    let base = "";
    let refused = "";
    let proxyBase = "";
    /** The poisoned proxy env every fetch child inherits (fetch.test.ts's
     * stance: both fetches must IGNORE it without the opt-in — any that
     * consulted it would fail with a connection error against the refused
     * port). */
    const poison = (): Record<string, string> => ({
      http_proxy: refused,
      https_proxy: refused,
      HTTP_PROXY: refused,
      HTTPS_PROXY: refused,
    });

    beforeAll(async () => {
      const child = spawn(
        "docker",
        ["exec", "-w", mountPoint, containerName, "node", inContainer(fetchServersScript)],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      serversChild = child;
      await new Promise<void>((resolve, reject) => {
        let errText = "";
        const timer = setTimeout(() => {
          reject(new Error(`fetch servers never reported their ports\nstderr so far:\n${errText}`));
        }, 60_000);
        child.stderr!.on("data", (c: Buffer) => {
          errText += c.toString("utf8");
          const b = /^BASE (\S+)$/m.exec(errText);
          const r = /^REFUSED (\S+)$/m.exec(errText);
          const p = /^PROXY (\S+)$/m.exec(errText);
          if (b && r && p) {
            [base, refused, proxyBase] = [b[1]!, r[1]!, p[1]!];
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`fetch servers exited ${code} before reporting ports`));
        });
      });
    }, 120_000);

    afterAll(() => {
      // Kills the docker exec CLIENT; the in-container node dies with the
      // container (docker rm -f in the outer afterAll).
      serversChild?.kill("SIGKILL");
    });

    /** The proxy's relay count, read over the wire (the /__count query —
     * a relative-path request the counting branch never counts). */
    async function proxiedCount(): Promise<number> {
      const res = await runInContainer([
        "node",
        "-e",
        'fetch(process.argv[1] + "/__count").then((r) => r.text()).then((t) => process.stdout.write(t))',
        proxyBase,
      ]);
      expect(res.exitCode).toBe(0);
      return Number(res.stdout.toString("utf8"));
    }

    /** One case, both lanes, byte-compared (fetch.test.ts's contract). */
    async function runFetchCase(
      c: { name: string; entry: string },
      env: Record<string, string>,
    ): Promise<void> {
      const binary = await crossCompileFetchFixture(c.entry);
      const argv = [base, refused];
      // redirect-resolution's server keeps one-hop fragment state by key.
      // The lanes run sequentially, so give each a distinct key just like
      // fetch.test.ts or the native lane would consume Node's state.
      const nodeArgv =
        c.name === "redirect-resolution" ? [...argv, "redirect-resolution-node"] : argv;
      const nativeArgv =
        c.name === "redirect-resolution" ? [...argv, "redirect-resolution-native"] : argv;
      // Sequential, not parallel (the server-fixture stance): both lanes
      // drive real sockets against the same in-container servers.
      const nodeRes = await runInContainer(["node", inContainer(c.entry), ...nodeArgv], env);
      const nativeRes = await runInContainer([inContainer(binary), ...nativeArgv], env);
      if (!nodeRes.stdout.equals(nativeRes.stdout)) {
        expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
        expect.unreachable("stdout differed at byte level but not after utf8 decode");
      }
      expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    }

    // Every case under the POISON (proxy-optin's not-opted-in half
    // included) — fetch.test.ts's differential describe, exactly.
    test.for(fetchCases.map((c) => [c.name, c] as const))(
      "%s",
      async ([, c]) => {
        await runFetchCase(c, poison());
      },
      120_000,
    );

    // The opt-in arm: NODE_USE_ENV_PROXY=1 routes both lanes through the
    // counting proxy — byte-equal outputs AND exactly one relayed request
    // per lane (fetch.test.ts's separate opt-in test).
    test.skipIf(fetchCases.every((c) => c.name !== "proxy-optin"))(
      "proxy-optin routes through http_proxy when opted in",
      async () => {
        const c = fetchCases.find((candidate) => candidate.name === "proxy-optin")!;
        const before = await proxiedCount();
        await runFetchCase(c, {
          ...poison(),
          NODE_USE_ENV_PROXY: "1",
          http_proxy: proxyBase,
          HTTP_PROXY: proxyBase,
        });
        expect((await proxiedCount()) - before).toBe(2);
      },
      120_000,
    );
  });

  describe.skipIf(linuxNpmCases.length === 0)(
    `npm differential (${linuxNpmCases.length} programs)`,
    () => {
      test.for(linuxNpmCases.map((c) => [c.name, c] as const))(
        "%s",
        async ([, c]) => {
          const binary = await crossCompileNpmCase(c.entry);
          for (const argv of c.argvs ?? [[]]) {
            const [nodeRes, nativeRes] = await Promise.all([
              runInContainer(["node", inContainer(c.entry), ...argv]),
              runInContainer([inContainer(binary), ...argv]),
            ]);
            const label = argv.join(" ");
            if (!nodeRes.stdout.equals(nativeRes.stdout)) {
              expect(nativeRes.stdout.toString("utf8"), label).toBe(
                nodeRes.stdout.toString("utf8"),
              );
              expect.unreachable("stdout differed at byte level but not after utf8 decode");
            }
            expect(nativeRes.exitCode, label).toBe(nodeRes.exitCode);
          }
        },
        120_000,
      );
    },
  );

  describe.skipIf(nodeTestCases.length === 0)(
    `node:test differential (${nodeTestCases.length} programs)`,
    () => {
      test.for(nodeTestCases.map((c) => [c.name, c] as const))(
        "%s",
        async ([, c]) => {
          const binary = await crossCompileFixture(c.entry);
          const [nodeRes, nativeRes] = await Promise.all([
            runInContainer(["node", inContainer(c.entry)]),
            runInContainer([inContainer(binary)]),
          ]);
          expect(normalizeNodeTestOutput(nativeRes.stdout.toString("utf8"))).toBe(
            normalizeNodeTestOutput(nodeRes.stdout.toString("utf8")),
          );
          const wanted = expectedExitCode(c.entry);
          expect(nodeRes.exitCode).toBe(wanted); // keeps `// @exit:` honest
          expect(nativeRes.exitCode).toBe(wanted);
        },
        120_000,
      );
    },
  );

  describe.skipIf(linuxStdinCases.length === 0)(
    `piped stdin (${linuxStdinCases.length} cases)`,
    () => {
      test.for(linuxStdinCases.map((c) => [c.title, c] as const))(
        "%s",
        async ([, c]) => {
          const entry = join(repoRoot, "tests/fixtures/event-loop", c.fixture);
          const binary = await crossCompileFixture(entry);
          const [nodeRes, nativeRes] = await Promise.all([
            runWithStdinInContainer(["node", inContainer(entry)], c.script),
            runWithStdinInContainer([inContainer(binary)], c.script),
          ]);
          expect(nativeRes.stdout).toBe(nodeRes.stdout);
          expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
        },
        120_000,
      );
    },
  );
});
