/* Runtime performance A/B harness for compiled programs.
 *
 * Builds every workload in benchmarks/runtime/workloads.json with one or two
 * scriptc checkouts, verifies each executable against Node byte-for-byte
 * (stdout, stderr, exit status), then times interleaved launches and reports
 * per-workload medians with bootstrap confidence intervals for the
 * candidate/baseline ratio. Executables that diverge from Node are never
 * timed. A per-host advisory lock serializes measurements so concurrent
 * agents on one machine do not disturb each other's numbers. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const suiteRoot = join(repoRoot, "benchmarks/runtime");

const { values } = parseArgs({
  allowNegative: true,
  options: {
    candidate: { type: "string", default: repoRoot },
    baseline: { type: "string" },
    workloads: { type: "string" },
    runs: { type: "string", default: "15" },
    warmup: { type: "string", default: "2" },
    timeout: { type: "string", default: "120" },
    layouts: { type: "string", default: "1" },
    "baseline-optimization": { type: "string", default: "release" },
    "candidate-optimization": { type: "string", default: "release" },
    json: { type: "string" },
    "no-lock": { type: "boolean", default: false },
    node: { type: "boolean", default: true },
    "keep": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(`Usage: node scripts/bench-runtime.mjs [--candidate=<checkout>] [--baseline=<checkout>]
       [--workloads=a,b] [--runs=15] [--warmup=2] [--timeout=120] [--layouts=1] [--json=<file>]
       [--baseline-optimization=release] [--candidate-optimization=release]
       [--no-lock] [--no-node] [--keep]

Each checkout must have a built CLI (packages/cli/dist/bootstrap.js) and native
artifacts for this host. Without --baseline, reports absolute times only. Node is
timed in the same interleaved loop as the reference to beat (--no-node skips it).

--layouts=N (macOS/Linux) links every executable N times, shifting the program
object by 0, 16, 32, ... bytes of padding, and spreads the timed runs evenly over
those layouts, so verdicts cover code-placement luck instead of one placement.
Use it for small codegen changes (e.g. --layouts=4 --runs=16).

Workload names are listed in benchmarks/runtime/workloads.json; for example
--workloads=cli-config,http-api runs only the startup and server workloads.

--baseline-optimization/--candidate-optimization pick each contender's
--optimization posture (default release). The same checkout may be both
contenders, e.g. --baseline=. --candidate-optimization=speed compares speed with
release. cold_build_ms records each contender's first, uncached build.`);
  process.exit(0);
}
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const timeoutMs = Number(values.timeout) * 1000;
assert.ok(Number.isInteger(runs) && runs >= 3 && runs <= 200, "--runs must be 3..200");
assert.ok(Number.isInteger(warmup) && warmup >= 0 && warmup <= 20, "--warmup must be 0..20");
for (const option of ["baseline-optimization", "candidate-optimization"])
  assert.ok(
    ["release", "dev", "speed"].includes(values[option]),
    `--${option} must be release, dev, or speed`,
  );
const layouts = Number(values.layouts);
assert.ok(Number.isInteger(layouts) && layouts >= 1 && layouts <= 8, "--layouts must be 1..8");
assert.ok(
  layouts === 1 || process.platform === "darwin" || process.platform === "linux",
  "--layouts needs macOS or Linux",
);

const manifest = JSON.parse(readFileSync(join(suiteRoot, "workloads.json"), "utf8"));
const selected = values.workloads ? new Set(values.workloads.split(",")) : null;
const workloads = manifest.workloads.filter((w) => selected === null || selected.has(w.name));
if (selected) {
  for (const name of selected)
    assert.ok(
      manifest.workloads.some((w) => w.name === name),
      `unknown workload ${name}`,
    );
}

const work = mkdtempSync(
  join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-bench-runtime-"),
);

/* ── code-layout perturbation ──────────────────────────────────────────── */
// Layout k > 0 links a retained k*16-byte padding object directly before the
// program object, through a SCRIPTC_LINKER wrapper that forwards to clang (the
// default linker driver on macOS and Linux). Code after that point moves as if
// earlier code had grown; any checkout's compiler can be perturbed this way.
function layoutTooling() {
  if (layouts === 1) return null;
  const root = join(work, "layouts");
  mkdirSync(root, { recursive: true });
  const symbol =
    process.platform === "darwin" ? "_scriptc_bench_layout_pad" : "scriptc_bench_layout_pad";
  const pads = [null];
  for (let k = 1; k < layouts; k++) {
    const source = join(root, `pad${k}.s`);
    const object = join(root, `pad${k}.o`);
    writeFileSync(
      source,
      process.platform === "darwin"
        ? `.section __TEXT,__text,regular,pure_instructions\n.globl ${symbol}\n.no_dead_strip ${symbol}\n.p2align 0\n${symbol}:\n.fill ${k * 16},1,0xcc\n`
        : `.section .text.scriptc_bench_layout_pad,"axR",@progbits\n.globl ${symbol}\n.p2align 0\n${symbol}:\n.fill ${k * 16},1,0xcc\n`,
    );
    const assembled = run("clang", ["-c", source, "-o", object], { timeout: 60_000 });
    assert.equal(assembled.status, 0, `cannot assemble layout padding: ${assembled.stderr}`);
    pads.push(object);
  }
  const wrapper = join(root, "link.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
const args = process.argv.slice(2);
const pad = process.env.SCRIPTC_BENCH_LAYOUT_PAD;
let out = args;
if (pad && !args.some((a) => a.startsWith("-print-prog-name"))) {
  const at = args.findIndex((a) => basename(a).startsWith(".scriptc-native-program-object-"));
  if (at < 0) {
    process.stderr.write("bench layout wrapper: no program object on the link line\\n");
    process.exit(2);
  }
  out = ["-Wl,-u,${symbol}", ...args.slice(0, at), pad, ...args.slice(at)];
}
const result = spawnSync("clang", out, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
  );
  chmodSync(wrapper, 0o755);
  return { wrapper, pads };
}
const layoutTools = layoutTooling();

/* ── inputs for file-processing applications ──────────────────────────── */
function generateInput(kind) {
  const path = join(work, `${kind}.input`);
  if (kind === "log-summary") {
    writeFileSync(
      path,
      Array.from(
        { length: 300_000 },
        (_, i) =>
          `/route/${i % 37}?request=${i} ${i % 13 === 0 ? 500 : 200} ${i % 250} ${200 + (i % 4000)}`,
      ).join("\n") + "\n",
    );
  } else if (kind === "inventory-report") {
    writeFileSync(
      path,
      Array.from({ length: 300_000 }, (_, i) =>
        ["sku-" + i, "category-" + (i % 17), "product " + i, i % 40, 199 + (i % 5000)].join("\t"),
      ).join("\n") + "\n",
    );
  } else if (kind === "cli-config") {
    writeFileSync(path, JSON.stringify(deployManifest(), null, 2) + "\n");
  } else throw new Error(`unknown input kind ${kind}`);
  return path;
}

/** A ~110 KB project manifest for the cli-config workload: 80 services in a
 * dependency DAG, with env interpolation (two undefined variables produce
 * warnings) and per-service routes. Valid, so the CLI exits 0. */
function deployManifest() {
  const random = makeRandom(0xc0ffee);
  const roles = ["api", "worker", "web", "cache", "queue", "search", "auth", "billing"];
  const methods = ["GET", "POST", "PUT", "DELETE"];
  const services = [];
  for (let i = 0; i < 80; i++) {
    const name = `${roles[i % roles.length]}-${String(i).padStart(2, "0")}`;
    const dependsOn = [];
    for (let d = 0; d < Math.floor(random() * 4) && i > 0; d++) {
      const dep = services[Math.floor(random() * i)].name;
      if (!dependsOn.includes(dep)) dependsOn.push(dep);
    }
    const env = Array.from({ length: 4 + Math.floor(random() * 7) }, (_, e) => ({
      name: `${name.toUpperCase().replace("-", "_")}_VAR_${e}`,
      value:
        e === 0
          ? `https://\${REGION}.internal/${name}`
          : e === 1 && i % 37 === 5
            ? `\${MISSING_${i}}`
            : `\${ENV}-${name}-\${VAR_${e % 12}}-${Math.floor(random() * 1e6)}`,
    }));
    const routes = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, r) => ({
      path: `/${name}/v${1 + (r % 2)}/${["items", "status", "search", "events"][r]}`,
      methods: methods
        .filter(() => random() < 0.5)
        .concat(["GET"])
        .filter((m, k, a) => a.indexOf(m) === k),
    }));
    services.push({
      name,
      image: `registry.example.com/\${ENV}/${roles[i % roles.length]}:1.${i % 9}.${Math.floor(random() * 20)}`,
      replicas: 1 + Math.floor(random() * 8),
      port: 8000 + i,
      cpu: [0.25, 0.5, 1, 2][Math.floor(random() * 4)],
      memoryMb: [256, 512, 1024, 2048][Math.floor(random() * 4)],
      dependsOn,
      env,
      routes,
    });
  }
  const variables = Array.from({ length: 12 }, (_, v) => ({
    name: `VAR_${v}`,
    value: `value-${v}-${Math.floor(random() * 1e9).toString(36)}`,
  }));
  return { project: "storefront", region: "iad1", variables, services };
}

/* ── advisory lock ─────────────────────────────────────────────────────── */
const lockDir = join(
  process.platform === "win32" ? tmpdir() : "/tmp",
  "scriptc-bench-runtime.lock",
);
function acquireLock() {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = NaN;
      try {
        owner = Number(readFileSync(join(lockDir, "pid"), "utf8"));
      } catch {}
      let alive = false;
      if (Number.isInteger(owner)) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch {}
      }
      if (!alive && Date.now() - started > 2000) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (!announced) {
        process.stderr.write(`waiting for benchmark lock held by pid ${owner}\n`);
        announced = true;
      }
      spawnSync("sleep", ["2"]);
    }
  }
}
function releaseLock() {
  rmSync(lockDir, { recursive: true, force: true });
}

/* ── process helpers ───────────────────────────────────────────────────── */
function run(command, args, options = {}) {
  const start = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? timeoutMs,
    env: options.env ?? process.env,
    cwd: options.cwd,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
    ms,
  };
}

function peakRss(binary, args) {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  if (!existsSync("/usr/bin/time")) return null;
  const timeArgs =
    process.platform === "darwin" ? ["-l", binary, ...args] : ["-f", "rss_kib=%M", binary, ...args];
  const result = run("/usr/bin/time", timeArgs);
  const match =
    process.platform === "darwin"
      ? /(\d+)\s+maximum resident set size/.exec(result.stderr)
      : /rss_kib=(\d+)/.exec(result.stderr);
  if (!match) return null;
  return Number(match[1]) * (process.platform === "darwin" ? 1 : 1024);
}

/* ── server sessions ───────────────────────────────────────────────────── */
/* A server workload binds 127.0.0.1 on port 0 and reports `PORT <n>` on
 * stderr (the protocol of tests/harness/server.test.ts). The runner then
 * starts the workload's load client, which is the same Node script for every
 * server, and waits for both to exit; the client ends the session with a
 * request that makes the server close. Compared legs: server stdout, server
 * stderr without the PORT line, server exit status, and client stdout. The
 * client reports timing on stderr as `BENCH {json}`. */
function runServer(command, args, workload, { wrap } = {}) {
  const [cmd, cmdArgs] = wrap ? [wrap[0], [...wrap.slice(1), command, ...args]] : [command, args];
  return new Promise((resolvePromise, reject) => {
    const server = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let client = null;
    let clientStdout = "";
    let clientStderr = "";
    let clientStatus = null;
    let clientDone = Promise.resolve();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      server.kill("SIGKILL");
      client?.kill("SIGKILL");
    }, timeoutMs);
    server.on("error", reject);
    server.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    server.stderr.setEncoding("utf8").on("data", (c) => {
      stderr += c;
      const port = client === null ? /^PORT (\d+)$/m.exec(stderr) : null;
      if (port === null) return;
      client = spawn(
        process.execPath,
        [join(suiteRoot, workload.client.script), `--port=${port[1]}`, ...workload.client.args],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      client.stdout.setEncoding("utf8").on("data", (c) => (clientStdout += c));
      client.stderr.setEncoding("utf8").on("data", (c) => (clientStderr += c));
      clientDone = new Promise((done) =>
        client.on("close", (code, signal) => {
          clientStatus = code ?? signal;
          // A failed client cannot shut the server down.
          if (code !== 0) server.kill("SIGKILL");
          done();
        }),
      );
    });
    server.on("close", async (status, signal) => {
      if (client !== null && clientStatus === null && !timedOut) {
        // The server exited first; give the client a moment to finish.
        const grace = setTimeout(() => client.kill("SIGKILL"), 5000);
        await clientDone;
        clearTimeout(grace);
      } else await clientDone;
      clearTimeout(timer);
      const benchLine = /^BENCH (.*)$/m.exec(clientStderr);
      resolvePromise({
        stdout,
        stderr: stderr.replace(/^PORT \d+\n/m, ""),
        status,
        signal,
        timedOut,
        clientStatus,
        clientStdout,
        clientStderr: clientStderr.replace(/^BENCH .*\n/m, ""),
        bench: benchLine ? JSON.parse(benchLine[1]) : null,
      });
    });
  });
}

/** Problems with a server session, or "" when it completed cleanly. */
function serverFailure(session) {
  if (session.timedOut) return "timed out";
  if (session.clientStatus === null) return "server exited without reporting a PORT line";
  if (session.clientStatus !== 0 || session.bench === null)
    return `load client failed (${session.clientStatus}): ${session.clientStderr.slice(0, 2000)}`;
  if (session.signal) return `server died to ${session.signal}`;
  return "";
}

/* ── statistics ────────────────────────────────────────────────────────── */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function bootstrapRatio(candidate, baseline, resamples = 2000) {
  const random = makeRandom(0x5eed);
  const ratios = [];
  const pick = (xs) =>
    Array.from({ length: xs.length }, () => xs[Math.floor(random() * xs.length)]);
  for (let i = 0; i < resamples; i++) ratios.push(median(pick(candidate)) / median(pick(baseline)));
  ratios.sort((a, b) => a - b);
  return {
    low: ratios[Math.floor(resamples * 0.025)],
    high: ratios[Math.floor(resamples * 0.975)],
  };
}

/* ── build ─────────────────────────────────────────────────────────────── */
function cliFor(root) {
  const cli = join(resolve(root), "packages/cli/dist/bootstrap.js");
  statSync(cli);
  return cli;
}
function revision(root) {
  const r = run("git", ["-C", root, "rev-parse", "--short", "HEAD"], { timeout: 10_000 });
  const dirty = run("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], {
    timeout: 10_000,
  });
  return r.stdout.trim() + (dirty.stdout.trim() ? "+dirty" : "");
}
function build(label, root, workload, layout, optimization) {
  const cli = cliFor(root);
  const out = join(work, label, layout === 0 ? workload.name : `${workload.name}.layout${layout}`);
  mkdirSync(dirname(out), { recursive: true });
  const cache = join(work, label, ".cache");
  mkdirSync(cache, { recursive: true });
  const env = { ...process.env, SCRIPTC_CACHE_DIR: cache };
  delete env.SCRIPTC_NO_CACHE;
  delete env.SCRIPTC_TIMING;
  if (layout !== 0) {
    env.SCRIPTC_LINKER = layoutTools.wrapper;
    env.SCRIPTC_BENCH_LAYOUT_PAD = layoutTools.pads[layout];
  }
  const entry = join(suiteRoot, workload.entry);
  const result = run(
    process.execPath,
    [cli, "build", entry, `--optimization=${optimization}`, "-o", out],
    {
      env,
      timeout: 900_000,
    },
  );
  if (result.status !== 0)
    return {
      ok: false,
      error: (result.stderr || result.stdout).slice(0, 4000),
      buildMs: result.ms,
    };
  return { ok: true, binary: out, bytes: statSync(out).size, buildMs: result.ms };
}

/* ── main ──────────────────────────────────────────────────────────────── */
const contenders = [
  ...(values.baseline
    ? [
        {
          label: "baseline",
          root: resolve(values.baseline),
          optimization: values["baseline-optimization"],
        },
      ]
    : []),
  {
    label: "candidate",
    root: resolve(values.candidate),
    optimization: values["candidate-optimization"],
  },
];
const report = {
  schema: 1,
  date: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  runs,
  layouts,
  contenders: contenders.map((c) => ({ ...c, revision: revision(c.root) })),
  workloads: [],
};

/* Workload kinds: "process" (default) times whole launches; `launches` > 1
 * makes each sample the median of that many sequential launches (startup-bound
 * CLIs). "server" times the measured phase of a load-client session. */
const categoryOf = (w) =>
  w.kind === "server" ? "server" : (w.launches ?? 1) > 1 ? "startup" : "cpu";
for (const w of workloads) {
  assert.ok((w.kind ?? "process") === "process" || w.kind === "server", `${w.name}: unknown kind`);
  if (w.kind === "server") assert.ok(w.client?.script, `${w.name}: server workloads need a client`);
  const launches = w.launches ?? 1;
  assert.ok(Number.isInteger(launches) && launches >= 1, `${w.name}: launches must be >= 1`);
}

/** One timing sample: { ms } on success, { failed } otherwise. */
async function sample(w, command, args) {
  if (w.kind === "server") {
    const session = await runServer(command, args, w);
    const failure = serverFailure(session) || (session.status !== 0 ? "unstable-exit" : "");
    if (failure) return { failed: session.timedOut ? "timeout" : "unstable-exit" };
    return { ms: session.bench.measured_ms, bench: session.bench };
  }
  // A startup-bound sample is the median of its launches: a few milliseconds
  // per launch is easily disturbed by unrelated activity on the host.
  const times = [];
  for (let i = 0; i < (w.launches ?? 1); i++) {
    const result = run(command, args);
    if (result.timedOut || result.status !== 0)
      return { failed: result.timedOut ? "timeout" : "unstable-exit" };
    times.push(result.ms);
  }
  return { ms: median(times) };
}

async function serverPeakRss(binary, args, w) {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  if (!existsSync("/usr/bin/time")) return null;
  const wrap =
    process.platform === "darwin" ? ["/usr/bin/time", "-l"] : ["/usr/bin/time", "-f", "rss_kib=%M"];
  const session = await runServer(binary, args, w, { wrap });
  const match =
    process.platform === "darwin"
      ? /(\d+)\s+maximum resident set size/.exec(session.stderr)
      : /rss_kib=(\d+)/.exec(session.stderr);
  if (!match) return null;
  return Number(match[1]) * (process.platform === "darwin" ? 1 : 1024);
}

function summarizeBenches(benches) {
  if (benches.length === 0) return undefined;
  const pick = (key) => median(benches.map((b) => b[key]));
  return {
    rps: Math.round(pick("rps")),
    p50_ms: Math.round(pick("p50_ms") * 1000) / 1000,
    p90_ms: Math.round(pick("p90_ms") * 1000) / 1000,
    p99_ms: Math.round(pick("p99_ms") * 1000) / 1000,
    client_cores:
      Math.round(median(benches.map((b) => b.client_cpu_ms / b.measured_ms)) * 100) / 100,
  };
}

try {
  const inputs = new Map();
  for (const w of workloads)
    if (w.input && !inputs.has(w.input)) inputs.set(w.input, generateInput(w.input));

  // Builds and the Node oracle run outside the lock: they do not need a
  // quiet machine, and holding the lock while compiling would serialize
  // every agent's slowest phase.
  const prepared = [];
  for (const w of workloads) {
    const args = w.args.map((a) => (a === "{input}" ? inputs.get(w.input) : a));
    // The application workloads are ESM without a package.json "type"; Node's
    // reparse warning is an oracle artifact, not program output.
    const nodeCommand = [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      join(suiteRoot, w.entry),
      ...args,
    ];
    const server = w.kind === "server";
    const oracle = server
      ? await runServer(process.execPath, nodeCommand, w)
      : run(process.execPath, nodeCommand);
    const entry = { name: w.name, args, results: {} };
    if (w.kind === "server") entry.kind = "server";
    if ((w.launches ?? 1) > 1) entry.launches = w.launches;
    entry.category = categoryOf(w);
    const oracleFailure = server ? serverFailure(oracle) : oracle.timedOut ? "timed out" : "";
    if (oracle.status !== 0 || oracleFailure) {
      entry.error = `node oracle failed (status ${oracle.status}${oracleFailure ? `, ${oracleFailure}` : ""}): ${oracle.stderr.slice(0, 2000)}`;
      prepared.push(entry);
      continue;
    }
    for (const c of contenders) {
      const result = { build_ms: 0 };
      entry.results[c.label] = result;
      result.binaries = [];
      for (let layout = 0; layout < layouts && result.status === undefined; layout++) {
        const built = build(c.label, c.root, w, layout, c.optimization);
        result.build_ms += Math.round(built.buildMs);
        if (layout === 0) result.cold_build_ms = Math.round(built.buildMs);
        if (!built.ok) {
          result.status = "build-failed";
          result.error = built.error;
          break;
        }
        if (layout === 0) result.bytes = built.bytes;
        result.binaries.push(built.binary);
        const check = server ? await runServer(built.binary, args, w) : run(built.binary, args);
        if (check.timedOut) {
          result.status = "timeout";
          break;
        }
        const legs = [
          ["stdout", check.stdout === oracle.stdout],
          ["stderr", check.stderr === oracle.stderr],
          ...(server ? [["client stdout", check.clientStdout === oracle.clientStdout]] : []),
        ];
        const failure = server ? serverFailure(check) : "";
        if (failure || check.status !== oracle.status || legs.some(([, same]) => !same)) {
          result.status = "mismatch";
          result.error = `${layout === 0 ? "" : `layout ${layout}: `}expected status ${oracle.status}, got ${check.status}; ${legs.map(([leg, same]) => `${leg} ${same ? "matches" : "differs"}`).join("; ")}${failure ? `; ${failure}` : ""}`;
          break;
        }
      }
      result.binary = result.binaries[0];
      if (result.status !== undefined) continue;
      result.status = "ok";
      result.samples = [];
      if (layouts > 1) result.layout_samples = result.binaries.map(() => []);
      if (server) result.benches = [];
    }
    entry.node_ms = Math.round(oracle.ms ?? oracle.bench.measured_ms);
    entry.nodeCommand = nodeCommand;
    entry.workload = w;
    prepared.push(entry);
    process.stderr.write(`prepared ${w.name}\n`);
  }

  if (!values["no-lock"]) acquireLock();
  try {
    for (const entry of prepared) {
      const w = entry.workload;
      const live = contenders.filter((c) => entry.results[c.label]?.status === "ok");
      if (live.length === 0) continue;
      // Server sessions warm up in-process (the client's untimed phase), so
      // one extra session per contender is enough to settle the machine.
      const warmupRuns = w.kind === "server" ? Math.min(warmup, 1) : warmup;
      for (const c of live)
        for (const binary of entry.results[c.label].binaries)
          for (let i = 0; i < warmupRuns; i++)
            if (w.kind === "server") await sample(w, binary, entry.args);
            else run(binary, entry.args);
      // Node is the reference the project aims to beat, so it is timed in the
      // same interleaved loop (whole-process wall time, startup included, or
      // the server's measured phase).
      const nodeSamples = [];
      const nodeBenches = [];
      if (values.node) await sample(w, process.execPath, entry.nodeCommand);
      const random = makeRandom(entry.name.length * 7919);
      for (let r = 0; r < runs; r++) {
        const order = [...live];
        if (order.length === 2 && random() < 0.5) order.reverse();
        for (const c of order) {
          const result = entry.results[c.label];
          // Runs rotate through the layouts so each gets an equal share.
          const layout = r % result.binaries.length;
          const s = await sample(w, result.binaries[layout], entry.args);
          if (s.failed) {
            result.status = s.failed;
            break;
          }
          const ms = Math.round(s.ms * 100) / 100;
          result.samples.push(ms);
          result.layout_samples?.[layout].push(ms);
          if (s.bench) result.benches.push(s.bench);
        }
        if (values.node) {
          const s = await sample(w, process.execPath, entry.nodeCommand);
          if (s.failed) entry.error = `node ${s.failed} during timing`;
          else {
            nodeSamples.push(s.ms);
            if (s.bench) nodeBenches.push(s.bench);
          }
        }
      }
      if (nodeSamples.length > 0) entry.node_ms = Math.round(median(nodeSamples) * 100) / 100;
      const reference = entry.results.candidate;
      if (reference?.status === "ok" && reference.samples.length > 0 && nodeSamples.length > 0)
        entry.vs_node = Math.round((median(reference.samples) / entry.node_ms) * 1000) / 1000;
      if (w.kind === "server") {
        entry.server = { node: summarizeBenches(nodeBenches) };
        for (const c of live) {
          const result = entry.results[c.label];
          if (result.status === "ok") entry.server[c.label] = summarizeBenches(result.benches);
          delete result.benches;
        }
      }
      if (w.kind === "server" && values.node)
        entry.node_peak_rss_bytes = await serverPeakRss(process.execPath, entry.nodeCommand, w);
      for (const c of live) {
        const result = entry.results[c.label];
        if (result.status !== "ok") continue;
        result.median_ms = Math.round(median(result.samples) * 100) / 100;
        if (result.layout_samples)
          result.layout_medians_ms = result.layout_samples.map(
            (xs) => Math.round(median(xs) * 100) / 100,
          );
        result.peak_rss_bytes =
          w.kind === "server"
            ? await serverPeakRss(result.binary, entry.args, w)
            : peakRss(result.binary, entry.args);
      }
      const base = entry.results.baseline;
      const cand = entry.results.candidate;
      if (base?.status === "ok" && cand?.status === "ok") {
        const ci = bootstrapRatio(cand.samples, base.samples);
        entry.ratio = Math.round((cand.median_ms / base.median_ms) * 10000) / 10000;
        entry.ci95 = [Math.round(ci.low * 10000) / 10000, Math.round(ci.high * 10000) / 10000];
        entry.verdict = ci.high < 1 ? "faster" : ci.low > 1 ? "slower" : "neutral";
        entry.size_ratio = Math.round((cand.bytes / base.bytes) * 10000) / 10000;
      }
      process.stderr.write(`measured ${entry.name}\n`);
    }
  } finally {
    if (!values["no-lock"]) releaseLock();
  }
  for (const entry of prepared) {
    for (const result of Object.values(entry.results)) {
      delete result.binary;
      delete result.binaries;
      delete result.benches;
    }
    delete entry.nodeCommand;
    delete entry.workload;
    report.workloads.push(entry);
  }
  const geomean = (xs, digits) =>
    Math.round(Math.exp(xs.reduce((s, r) => s + Math.log(r), 0) / xs.length) * digits) / digits;
  const vsNode = report.workloads.filter((w) => w.vs_node !== undefined);
  if (vsNode.length > 0) {
    report.geomean_vs_node = geomean(
      vsNode.map((w) => w.vs_node),
      1000,
    );
    report.geomean_vs_node_by_category = {};
    for (const category of new Set(vsNode.map((w) => w.category)))
      report.geomean_vs_node_by_category[category] = geomean(
        vsNode.filter((w) => w.category === category).map((w) => w.vs_node),
        1000,
      );
  }
  const ratios = report.workloads.filter((w) => w.ratio !== undefined).map((w) => w.ratio);
  if (ratios.length > 0) report.geomean_ratio = geomean(ratios, 10000);
} finally {
  if (!values.keep) rmSync(work, { recursive: true, force: true });
}

if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + "\n");

/* ── summary table ─────────────────────────────────────────────────────── */
const pct = (r) => `${r < 1 ? "" : "+"}${((r - 1) * 100).toFixed(1)}%`;
const lines = [];
const xNode = (w) => (w.vs_node === undefined ? "-" : `${w.vs_node.toFixed(2)}x`);
// Server rows show the measured-phase wall time for the fixed request count;
// startup rows show the mean time per launch.
const label = (w) =>
  w.kind === "server" ? `${w.name} (server)` : w.launches ? `${w.name} (per launch)` : w.name;
if (values.baseline) {
  lines.push(
    "| workload | baseline ms | candidate ms | change | 95% CI | verdict | size | node ms | candidate/node |",
  );
  lines.push("| --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |");
} else {
  lines.push("| workload | median ms | status | bytes | peak RSS MiB | node ms | scriptc/node |");
  lines.push("| --- | ---: | --- | ---: | ---: | ---: | ---: |");
}
for (const w of report.workloads) {
  const b = w.results.baseline;
  const c = w.results.candidate;
  if (w.error) {
    lines.push(`| ${label(w)} | ${w.error.split("\n")[0]} |`);
  } else if (values.baseline) {
    const show = (r) => (r?.status === "ok" ? r.median_ms.toFixed(1) : (r?.status ?? "-"));
    lines.push(
      `| ${label(w)} | ${show(b)} | ${show(c)} | ${w.ratio ? pct(w.ratio) : "-"} | ${w.ci95 ? `${pct(w.ci95[0])} .. ${pct(w.ci95[1])}` : "-"} | ${w.verdict ?? "-"} | ${w.size_ratio ? pct(w.size_ratio) : "-"} | ${w.node_ms} | ${xNode(w)} |`,
    );
  } else {
    lines.push(
      `| ${label(w)} | ${c?.median_ms?.toFixed(1) ?? "-"} | ${c?.status ?? "-"} | ${c?.bytes ?? "-"} | ${c?.peak_rss_bytes ? (c.peak_rss_bytes / 1048576).toFixed(1) : "-"} | ${w.node_ms} | ${xNode(w)} |`,
    );
  }
}
if (layouts > 1) {
  // Each layout gets only runs/layouts samples, so these spreads include run
  // noise; the verdicts above already pool every layout.
  lines.push(
    "",
    `layout spread (max/min of per-layout medians, ${layouts} layouts x ~${Math.floor(runs / layouts)} runs; includes run noise):`,
  );
  for (const w of report.workloads) {
    const spreads = Object.entries(w.results)
      .filter(([, r]) => r.layout_medians_ms)
      .map(([label, r]) => {
        const ms = r.layout_medians_ms;
        return `${label} ${((Math.max(...ms) / Math.min(...ms) - 1) * 100).toFixed(1)}%`;
      });
    if (spreads.length > 0) lines.push(`- ${w.name}: ${spreads.join(", ")}`);
  }
}
const servers = report.workloads.filter((w) => w.server);
if (servers.length > 0) {
  lines.push(
    "",
    "| server workload | server | req/s | p50 ms | p90 ms | p99 ms | client cores | peak RSS MiB |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const w of servers)
    for (const who of ["node", "baseline", "candidate"]) {
      const s = w.server[who];
      if (!s) continue;
      const rss = who === "node" ? w.node_peak_rss_bytes : w.results[who]?.peak_rss_bytes;
      lines.push(
        `| ${w.name} | ${who} | ${s.rps} | ${s.p50_ms.toFixed(2)} | ${s.p90_ms.toFixed(2)} | ${s.p99_ms.toFixed(2)} | ${s.client_cores.toFixed(2)} | ${rss ? (rss / 1048576).toFixed(1) : "-"} |`,
      );
    }
}
if (report.geomean_ratio !== undefined)
  lines.push("", `geomean change: ${pct(report.geomean_ratio)}`);
if (report.geomean_vs_node !== undefined) {
  lines.push(
    `geomean candidate/node: ${report.geomean_vs_node.toFixed(3)}x (lower is better; goal: well below 1)`,
  );
  const byCategory = Object.entries(report.geomean_vs_node_by_category);
  if (byCategory.length > 1)
    lines.push(`  by category: ${byCategory.map(([k, v]) => `${k} ${v.toFixed(3)}x`).join(", ")}`);
}
console.log(lines.join("\n"));
const broken = report.workloads.some(
  (w) => w.error || Object.values(w.results).some((r) => r.status !== "ok"),
);
process.exitCode = broken ? 1 : 0;
