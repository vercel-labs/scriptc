/* vercel CLI end-to-end: the REAL Vercel CLI (the `vercel` npm package,
 * unmodified) runs its read-only AND mutation workflows under Node
 * (dist/index.js — the acceptance oracle) AND as a scriptc --dynamic
 * binary, against the LOCAL mock api.vercel.com
 * (tests/fixtures/vercel-e2e/mock-vercel-api.ts, every shape recorded from
 * the real CLI); stdout, stderr, and exit codes must agree. Mutations are
 * safe BECAUSE of the jail: every write (env add/rm, dns add/rm, alias
 * set/rm, project add) lands in the mock, whose endpoint trace pins the
 * request body byte-for-byte. the gateway e2e suite's three-legged pattern, pointed at a CLI
 * whose network stack rides the island's native fetch. The compiled leg's
 * module-graph walls fell in sequence (node:https → smol-toml's dual
 * package → node:domain); the "reaches today" pin below records the
 * frontier — now "loaded" — and the differential arms run whenever the
 * graph loads.
 *
 * SETUP (the suite SKIPS when the scratch install is absent):
 *   mkdir -p ~/Developer/vercel-scratch && cd ~/Developer/vercel-scratch
 *   npm init -y && npm i vercel@56.2.0
 * SCRIPTC_VERCEL_ROOT overrides the location. The version is pinned:
 * committed snapshots record 56.2.0's exact output.
 *
 * THE NETWORK JAIL (verified in beforeAll, before any test's CLI run):
 * every child gets NODE_USE_ENV_PROXY=1 with http(s)_proxy at a refused
 * loopback port and no_proxy=127.0.0.1, so the mock is reachable and any
 * other origin fails fast without leaving the machine. This is the jail
 * the CLI RESPECTS: its API client uses global fetch (undici), and the
 * verification run captures `CONNECT api.vercel.com:443` arriving at a
 * loopback listener standing in as the proxy — proving escapes route into
 * the jail, not the network. Two CLI paths bypass env proxies and are
 * neutralized separately: the update-check worker (raw https.get to
 * registry.npmjs.org) never spawns under NO_UPDATE_NOTIFIER=1, and
 * telemetry (POST telemetry.vercel.com) never sends under
 * VERCEL_TELEMETRY_DISABLED=1 — and even if either regressed, both use
 * telemetry uses global fetch, so a regression there still hits the
 * refused proxy. Sentry crash reporting (unexpected-exception paths only)
 * and the update worker's raw https.get are the known env-proxy-blind
 * egresses; NO_UPDATE_NOTIFIER covers the worker and no test drives an
 * unexpected exception.
 *
 * ISOLATION: children get a MINIMAL environment built from scratch — a
 * scratch HOME per run (the CLI reads ~/.claude for its Claude-plugin
 * prompt and ~/.local/share for auth defaults; a clean HOME silences the
 * machine-state-dependent paths), --global-config into the run's scratch
 * cwd (the CLI writes config.json/telemetry ids on first run), and a
 * per-child VERCEL_TOKEN (`mockfaketoken<suffix>`, alphanumeric — the CLI
 * rejects tokens containing "-" before any request; the env-token path
 * never touches auth storage, so the @napi-rs/keyring native addon in the
 * CLI's graph stays an unloaded lazy require in BOTH lanes). The mock
 * attributes requests by bearer token, so concurrent lanes stay separable
 * and the per-command endpoint sequence is asserted per child.
 *
 * NORMALIZATIONS (both lanes, byte-exact otherwise): the lane cwd →
 * "<CWD>", the banner's Node version → "(Node.js <V>)" (a build pin, not
 * semantics), spinner elapsed "[123ms]" → "[<T>]", and relative-time
 * tokens ("932d", "50s", "842d ago") → "<T>" — they are rendered against
 * wall-clock "now" from the mock's fixed timestamps, so a day boundary
 * mid-run would flip them. Absolute dates (inspect's created line, logs'
 * TIME column) are NOT normalized: children run under TZ=UTC, so the
 * mock's fixed epochs render machine-independently and any lane skew in
 * Date formatting is a real divergence. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { shardSelect } from "./shard.js";
import { jailEnv, refusedLoopbackUrl } from "./net-jail.js";
import { MOCK_PROJECT_LINK, startMockVercelApi, type RecordedRequest } from "../fixtures/vercel-e2e/mock-vercel-api.js";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const executionTag = [
  sanitize ? "san" : "plain",
  process.env["SCRIPTC_TEST_RUN_ID"] ?? `pid-${process.pid}`,
  process.env["SCRIPTC_TEST_SHARD"] ?? "all",
]
  .join("-")
  .replace(/[^a-zA-Z0-9_.-]+/g, "-");

const vercelRoot = process.env["SCRIPTC_VERCEL_ROOT"] ?? join(homedir(), "Developer/vercel-scratch");
const vercelEntry = join(vercelRoot, "node_modules/vercel/dist/index.js");
const haveVercel = existsSync(vercelEntry);

let mockServer: import("node:http").Server;
let mockUrl = "";
let mockRequests: RecordedRequest[] = [];
let mockUnexpected: RecordedRequest[] = [];
let refusedUrl = "";
let jailCapture = "";
let driverBinary = "";
let probeBinary = "";
const driverBuildPaths = new Set<string>();
/** What the compiled leg reached in beforeAll: "loaded" once the island
 * serves the CLI's builtins, else the caught load error — today
 * "caught:ReferenceError: the island does not provide the 'node:https'
 * builtin". The differential arms key off this. */
let compiledLegProbe = "";
const compiledLegLoads = (): boolean => compiledLegProbe === "loaded";

/* ── driver generation + build (the real-CLI suite's scratch-entry shape:
 * the entry lives OUTSIDE the repo so the compiler resolves the scratch
 * install's own type surface, and imports dist/index.js relatively) ──── */

const DRIVER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      allowJs: true,
    },
  },
  null,
  2,
);

function hashInputs(entryText: string): string {
  const hash = createHash("sha256");
  hash.update(entryText).update(DRIVER_TSCONFIG);
  const inputs = [
    ...globSync(join(vercelRoot, "node_modules/vercel/dist/**/*.{js,cjs,mjs,json}")),
    join(vercelRoot, "node_modules/vercel/package.json"),
  ].sort();
  for (const f of inputs) hash.update(f).update(readFileSync(f));
  return hash.update(sanitize ? "san" : "plain").digest("hex").slice(0, 16);
}

async function buildDriver(name: string, entrySource: (rel: string) => string): Promise<string> {
  // realpath: macOS's tmpdir is a symlink (/var → /private/var), and the
  // relative import back to the scratch install must survive Node
  // resolving the entry at its REAL path.
  const dir = join(realpathSync(tmpdir()), `scriptc-vercel-e2e-${name}-${executionTag}`);
  driverBuildPaths.add(dir);
  mkdirSync(dir, { recursive: true });
  const rel = relative(dir, vercelEntry);
  const text = entrySource(rel.startsWith(".") ? rel : `./${rel}`);
  const key = hashInputs(text);
  const outDir = join(cacheDir, `vercel-e2e-${name}-${key}-${executionTag}`);
  driverBuildPaths.add(outDir);
  const entry = join(dir, "main.ts");
  writeFileSync(entry, text);
  writeFileSync(join(dir, "tsconfig.json"), DRIVER_TSCONFIG);
  const binary = join(outDir, "program");
  mkdirSync(outDir, { recursive: true });
  // Deliberately NO backend pin: the acceptance build is flagless-user-
  // shaped, so it rides the release default — today the npm embedding
  // refuses the LLVM tier and the build falls back to the C backend
  // transparently; this suite staying green IS the fallback acceptance.
  const result = await compile(entry, { outPath: binary, outDir, sanitize, dynamic: true });
  if (!result.ok) {
    throw new Error(
      "vercel e2e driver failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return binary;
}

/* ── running lanes ───────────────────────────────────────────────────── */

interface LaneResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
  cwd: string;
  token: string;
}

interface RunOptions {
  /** Override the child's VERCEL_TOKEN (still per-child-suffixed). */
  tokenBase?: string;
  /** Point --api somewhere other than the mock. */
  apiUrl?: string;
  /** Write .vercel/project.json into the lane's cwd before spawning — the
   * linked-project commands (env ls/add/rm) resolve this link before their
   * first request and error out without it. */
  linked?: boolean;
}

function runLane(cmd: string, cmdArgs: string[], args: string[], opts: RunOptions = {}): Promise<LaneResult> {
  const cwd = mkdtempSync(join(tmpdir(), "scr-vc-e2e-"));
  const home = join(cwd, "scratch-home");
  mkdirSync(home);
  if (opts.linked === true) {
    mkdirSync(join(cwd, ".vercel"));
    writeFileSync(join(cwd, ".vercel/project.json"), JSON.stringify(MOCK_PROJECT_LINK));
  }
  const token = `${opts.tokenBase ?? "mockfaketoken"}${basename(cwd).replace(/[^A-Za-z0-9]/g, "")}`;
  // Minimal env, built from scratch: nothing ambient (CLAUDECODE, CI,
  // VERCEL_*, FORCE_COLOR...) can steer the CLI. TZ is pinned to UTC:
  // inspect's created line, logs' TIME column, and domains inspect's
  // Created At render the mock's fixed epochs through the LOCAL zone, and
  // the committed snapshots must not depend on the machine's timezone.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: home,
    TZ: "UTC",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    VERCEL_TELEMETRY_DISABLED: "1",
    VERCEL_TOKEN: token,
    ...jailEnv(refusedUrl),
  };
  const argv = [...cmdArgs, ...args, "--api", opts.apiUrl ?? mockUrl, "--global-config", join(cwd, "vercel-global")];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (c: Buffer) => out.push(c));
    p.stderr.on("data", (c: Buffer) => err.push(c));
    p.stdin.end();
    p.on("error", reject);
    p.on("close", (code, signal) => {
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code, signal, cwd, token });
    });
  });
}

const runNodeLane = (args: string[], opts?: RunOptions): Promise<LaneResult> =>
  runLane(process.execPath, [vercelEntry], args, opts);
const runNativeLane = (args: string[], opts?: RunOptions): Promise<LaneResult> =>
  runLane(driverBinary, [], args, opts);

function normalize(buf: Buffer, cwd: string): string {
  let text = buf
    .toString("utf8")
    .replaceAll(cwd, "<CWD>")
    .replace(/\(Node\.js \d+\.\d+\.\d+\)/g, "(Node.js <V>)")
    .replace(/\[\d+ms\]/g, "[<T>]")
    .replace(/\b\d+(?:ms|[smhdwy])\b( ago)?/g, "<T>$1");
  if (sanitize) {
    // ASan's known ucontext-fiber noise on exit (google/sanitizers#189):
    // diagnostics, not program output — the real-CLI suite's scrub.
    text = text
      .replace(/==\d+==WARNING: ASan is ignoring requested __asan_handle_no_return[^\n]*\n/g, "")
      .replace(/False positive error reports may follow\n/g, "")
      .replace(/For details see https:\/\/github\.com\/google\/sanitizers\/issues\/189\n/g, "");
  }
  return text;
}

/** The endpoint trace of one child: "GET /path?query" attributed by its
 * bearer token — the recorded shapes made executable. Mutation requests
 * append their raw body, so the two lanes must SEND byte-identical JSON
 * payloads, not just hit identical URLs. SORTED, not arrival order: most
 * commands fetch sequentially, but certs ls races its team lookup against
 * the certs fetch (and env ls races custom-environments against the env
 * fetch), so arrival order isn't deterministic. */
function requestsOf(token: string): string[] {
  return mockRequests
    .filter((r) => r.authorization === `Bearer ${token}`)
    .map((r) => `${r.method} ${r.path}${r.search}${r.body === "" ? "" : ` ${r.body}`}`)
    .sort();
}

/** One command through the harness: the Node oracle always runs and its
 * normalized streams + endpoint trace are pinned as snapshots; once the
 * compiled leg's module graph loads (the sibling native-fetch lane's
 * landing), the scriptc binary runs the SAME argv and every byte must
 * agree — stdout, stderr, exit code, and the endpoint trace. */
async function runCase(args: string[], opts: RunOptions = {}): Promise<void> {
  const label = args.join(" ");
  const [node, native] = await Promise.all([
    runNodeLane(args, opts),
    compiledLegLoads() ? runNativeLane(args, opts) : Promise.resolve(undefined),
  ]);
  try {
    expect(normalize(node.stdout, node.cwd), `node stdout of: ${label}`).toMatchSnapshot(`${label} stdout`);
    expect(normalize(node.stderr, node.cwd), `node stderr of: ${label}`).toMatchSnapshot(`${label} stderr`);
    expect(node.code, `node exit code of: ${label}`).toMatchSnapshot(`${label} exit`);
    expect(requestsOf(node.token), `endpoints of: ${label}`).toMatchSnapshot(`${label} endpoints`);
    if (native !== undefined) {
      expect(normalize(native.stdout, native.cwd), `stdout of: ${label}`).toBe(normalize(node.stdout, node.cwd));
      expect(normalize(native.stderr, native.cwd), `stderr of: ${label}`).toBe(normalize(node.stderr, node.cwd));
      expect(native.code, `exit code of: ${label}`).toBe(node.code);
      expect(native.signal, `signal of: ${label}`).toBe(node.signal);
      expect(requestsOf(native.token), `endpoints of: ${label}`).toEqual(requestsOf(node.token));
    }
  } finally {
    rmSync(node.cwd, { recursive: true, force: true });
    if (native !== undefined) rmSync(native.cwd, { recursive: true, force: true });
  }
}

interface CliCase {
  name: string;
  args: string[];
  opts?: RunOptions;
}

// The acceptance commands are platform-neutral and independent once the
// shared driver and mock are ready. Sandbox runs split them locally because
// the external Vercel CLI oracle is deliberately not uploaded; ordinary
// `pnpm test` leaves SCRIPTC_TEST_SHARD unset and runs every command.
const allCliCases: CliCase[] = [
  { name: "whoami", args: ["whoami"] },
  { name: "whoami with an invalid token", args: ["whoami"], opts: { tokenBase: "badfaketoken" } },
  { name: "teams ls", args: ["teams", "ls"] },
  { name: "ls (deployments)", args: ["ls"] },
  { name: "project ls", args: ["project", "ls"] },
  { name: "domains ls", args: ["domains", "ls"] },
  { name: "dns ls", args: ["dns", "ls"] },
  { name: "alias ls", args: ["alias", "ls"] },
  { name: "certs ls", args: ["certs", "ls"] },
  { name: "--version", args: ["--version"] },
  { name: "help", args: ["help"] },
  { name: "help alias", args: ["help", "alias"] },
  { name: "env ls", args: ["env", "ls"], opts: { linked: true } },
  { name: "env ls production", args: ["env", "ls", "production"], opts: { linked: true } },
  {
    name: "env ls --format json",
    args: ["env", "ls", "--format", "json"],
    opts: { linked: true },
  },
  { name: "env ls without a linked project", args: ["env", "ls"] },
  {
    name: "inspect a deployment",
    args: ["inspect", "mock-app-abc123defg-mock-team.vercel.app"],
  },
  {
    name: "logs for a deployment over a fixed window",
    args: [
      "logs",
      "mock-app-abc123defg-mock-team.vercel.app",
      "--since",
      "2024-01-01T00:00:00.000Z",
      "--until",
      "2024-01-02T12:00:00.000Z",
    ],
  },
  { name: "domains inspect", args: ["domains", "inspect", "mock-example.com"] },
  { name: "teams switch", args: ["teams", "switch", "second-team"] },
  {
    name: "env add",
    args: ["env", "add", "MOCK_API_TOKEN", "production", "--value", "supersecretvalue", "--yes"],
    opts: { linked: true },
  },
  {
    name: "env rm",
    args: ["env", "rm", "NEXT_PUBLIC_BASE_URL", "production", "--yes"],
    opts: { linked: true },
  },
  { name: "dns add", args: ["dns", "add", "mock-example.com", "api", "A", "76.76.21.42"] },
  { name: "dns rm", args: ["dns", "rm", "rec_mock0000000000000000000002", "--yes"] },
  {
    name: "alias set",
    args: ["alias", "set", "mock-app-abc123defg-mock-team.vercel.app", "staging-mock.vercel.app"],
  },
  { name: "alias rm", args: ["alias", "rm", "mock-app.vercel.app", "--yes"] },
  { name: "project add", args: ["project", "add", "fresh-mock-project"] },
];
const selectedCliCases = new Set(
  shardSelect<CliCase>(allCliCases, ({ name }) => name).map(({ name }) => name),
);

/* ── the suite ───────────────────────────────────────────────────────── */

// The describe name is deliberately FLAVOR-FREE (unlike the real-CLI suite):
// snapshot keys embed it, the snapshots pin the Node oracle — which the
// sanitizer never touches — and a flavored name would fork two identical
// snapshot sets that each lane then reports as the other's obsolete
// entries (and `--update` under one flavor would delete the other's).
describe.skipIf(!haveVercel)("vercel e2e (real CLI vs Node against the mock api)", () => {
  beforeAll(async () => {
    ({ server: mockServer, baseUrl: mockUrl, requests: mockRequests, unexpected: mockUnexpected } = await startMockVercelApi());

    refusedUrl = await refusedLoopbackUrl();

    // JAIL VERIFICATION, before any test invokes the CLI: a loopback
    // listener stands in as the proxy, the Node CLI runs `whoami` with NO
    // --api (so it aims at api.vercel.com), and the escape must arrive
    // HERE as a CONNECT — proving the CLI's fetch consults the env proxy.
    // Nothing is forwarded; the child is killed on capture.
    jailCapture = await new Promise<string>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("jail verification timed out: no proxy traffic from the CLI within 60s")), 60_000);
      const trap: Server = createServer((socket) => {
        clearTimeout(guard);
        socket.once("data", (d: Buffer) => {
          const line = d.toString("utf8").split("\r\n")[0] ?? "";
          socket.destroy();
          trap.close(() => resolve(line));
        });
      });
      trap.listen(0, "127.0.0.1", () => {
        const taddr = trap.address();
        if (taddr === null || typeof taddr !== "object") return reject(new Error("no trap address"));
        const trapUrl = `http://127.0.0.1:${taddr.port}`;
        const cwd = mkdtempSync(join(tmpdir(), "scr-vc-jail-"));
        const home = join(cwd, "scratch-home");
        mkdirSync(home);
        const child = spawn(
          process.execPath,
          [vercelEntry, "whoami", "--global-config", join(cwd, "vercel-global")],
          {
            cwd,
            env: {
              PATH: process.env["PATH"],
              HOME: home,
              NO_COLOR: "1",
              NO_UPDATE_NOTIFIER: "1",
              VERCEL_TELEMETRY_DISABLED: "1",
              VERCEL_TOKEN: "mockfaketokenjail",
              // the jail shape, but with the capturing trap as the proxy
              ...jailEnv(trapUrl),
            },
            stdio: "ignore",
          },
        );
        const cleanup = (): void => {
          child.kill("SIGKILL");
          rmSync(cwd, { recursive: true, force: true });
        };
        trap.once("close", cleanup);
        child.on("error", (e) => {
          trap.close(() => reject(e));
        });
      });
    });
    if (!jailCapture.startsWith("CONNECT api.vercel.com:443")) {
      throw new Error(`jail not verified: expected a CONNECT for api.vercel.com at the proxy, saw ${JSON.stringify(jailCapture)}`);
    }

    // The differential driver (the real CLI graph) and the load probe
    // (awaits the same import and reports what the island said).
    driverBinary = await buildDriver("cli", (rel) => `import "${rel}";\n`);
    probeBinary = await buildDriver(
      "probe",
      (rel) => `async function go(): Promise<void> {
  try {
    // @ts-ignore -- the bundled CLI ships no declarations
    await import("${rel}");
    console.log("loaded");
  } catch (e) {
    console.log(\`caught:\${e instanceof Error ? \`\${e.name}: \${e.message}\` : String(e)}\`);
  }
}
void go();
`,
    );
    const probeRun = await runNativeLaneBinary(probeBinary);
    compiledLegProbe = probeRun.trim();
  }, 600_000);

  /** Runs a driver binary bare (no CLI argv) and returns its stdout. */
  async function runNativeLaneBinary(binary: string): Promise<string> {
    const res = await runLane(binary, [], []);
    rmSync(res.cwd, { recursive: true, force: true });
    return res.stdout.toString("utf8");
  }

  afterAll(async () => {
    try {
      if (mockServer !== undefined) await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      // The endpoint-drift tripwire: every request any lane made resolved to
      // a recorded route — a CLI/API drift 404s AND lands here, so it can
      // never render as a silently-empty table (dns ls does exactly that).
      expect(mockUnexpected.map((r) => `${r.method} ${r.path}${r.search}`)).toEqual([]);
    } finally {
      for (const path of driverBuildPaths) rmSync(path, { recursive: true, force: true });
    }
  });

  test("the network jail was verified before any CLI ran", () => {
    expect(jailCapture.startsWith("CONNECT api.vercel.com:443")).toBe(true);
  });

  test("what the compiled leg reaches today", () => {
    // The PIN, at its destination: the npm lane's per-edge-kind condition
    // resolution landed — a require() edge resolves smol-toml's dual
    // package with the CJS ("require") condition while import forms keep
    // the ESM entry, esbuild's shared-chunk __require attributes to the
    // chunk that DEFINED it (where Node resolves from), the island grew
    // node:domain (sentry loads it on every path, drives it only on
    // Node < 14), and the driver's relative-into-node_modules static
    // import embeds the graph instead of silently lowering to nothing.
    // The island loads and evaluates the ENTIRE CLI graph: the probe
    // prints "loaded" and every runCase in this suite runs the full
    // differential.
    expect(compiledLegProbe).toBe("loaded");
  }, 240_000);

  /* The network jail guarantees every mutating command lands in the mock;
   * its request body is pinned alongside stdout, stderr, and exit status. */
  for (const { args, name, opts } of allCliCases) {
    // Register the other shards as skipped so Vitest knows their snapshots
    // are intentional; filtering the definitions entirely makes every
    // partial run report the other shard's snapshots as obsolete.
    const shardTest = selectedCliCases.has(name) ? test : test.skip;
    shardTest(name, async () => {
      await runCase(args, opts);
    }, 240_000);
  }
});
