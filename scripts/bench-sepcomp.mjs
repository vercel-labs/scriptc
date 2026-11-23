/* Peak memory and wall time per compilation phase for the separate-compilation
 * Peak memory and wall time per compilation phase for app builds. Runs each
 * scenario as an ordinary app build, samples the
 * PSS of the build's whole process tree every half second, and attributes each
 * sample to the SCRIPTC_TIMING phase that was running. Partition reuse is
 * read from the helper's partition cache: entries the build touched that
 * already existed were reused, entries it created were compiled.
 *
 * The default scenarios are five builds of a native-sdk checkout's apps
 * (NATIVE_SDK_DIR, or ../native-sdk beside this repo).
 * --config names a JSON file with the same shape to measure other apps:
 *
 *   {
 *     "apps": {
 *       "name": { "dir": "/abs/app", "output": "build/name" }
 *     },
 *     "scenarios": [
 *       { "name": "counter release cold", "app": "counter", "release": true,
 *         "cold": "counter-release" },
 *       { "name": "counter dev one-line edit", "app": "counter",
 *         "setup": "counter dev cold",
 *         "edit": { "file": "app.ts", "find": "...", "replace": "..." } }
 *     ]
 *   }
 *
 * A scenario's `cold` names the cache group it starts empty. Scenarios that
 * share a group keep its cache unless they are cold. `setup` names a scenario
 * that must have run first; it is run, unmeasured, when it has not.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE_MS = 500;

const { values } = parseArgs({
  allowNegative: true,
  options: {
    config: { type: "string" },
    apps: { type: "string" },
    native: { type: "string" },
    compiler: { type: "string" },
    "cache-root": { type: "string" },
    only: { type: "string", multiple: true },
    json: { type: "string" },
    "sample-ms": { type: "string", default: String(SAMPLE_MS) },
    runs: { type: "string", default: "1" },
    keep: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const sampleMs = Number(values["sample-ms"]);
if (!Number.isFinite(sampleMs) || sampleMs < 50) throw new Error("--sample-ms must be at least 50");
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");

const nativeCli =
  values.native ??
  process.env["NATIVE_CLI"] ??
  resolve(repoRoot, "../native-sdk/packages/cli/dist/native.js");
const compiler =
  values.compiler ??
  process.env["SCRIPTC_COMPILER"] ??
  resolve(repoRoot, "packages/cli/dist/bootstrap.js");

/** The five default scenarios, on a native-sdk checkout. */
function defaultConfig() {
  const sdk = values.apps ?? process.env["NATIVE_SDK_DIR"] ?? resolve(repoRoot, "../native-sdk");
  return {
    apps: {
      counter: { dir: join(sdk, "examples/counter"), output: "build/counter" },
      "ui-settings": { dir: join(sdk, "examples/ui-settings"), output: "build/ui-settings" },
      "ui-dashboard": { dir: join(sdk, "examples/ui-dashboard"), output: "build/ui-dashboard" },
    },
    scenarios: [
      { name: "counter release cold", app: "counter", release: true, cold: "counter-release" },
      { name: "counter dev cold", app: "counter", cold: "counter-dev" },
      {
        name: "counter dev one-line edit",
        app: "counter",
        setup: "counter dev cold",
        edit: {
          file: "app.ts",
          find: '"Click a button to start."',
          replace: '"Tap a button to start."',
        },
      },
      { name: "ui-settings dev cold", app: "ui-settings", cold: "react-dev" },
      {
        name: "ui-dashboard dev warm cache",
        app: "ui-dashboard",
        setup: "ui-settings dev cold",
      },
    ],
  };
}

const config =
  values.config === undefined
    ? defaultConfig()
    : JSON.parse(readFileSync(resolve(values.config), "utf8"));
const scenarios = config.scenarios;
assert.ok(Array.isArray(scenarios) && scenarios.length > 0, "config.scenarios must be a list");
for (const scenario of scenarios) {
  assert.ok(
    config.apps[scenario.app] !== undefined,
    `${scenario.name}: unknown app ${scenario.app}`,
  );
}

if (values.help) {
  console.log(
    `Usage: node scripts/bench-sepcomp.mjs [--config=<file>] [--apps=<native-sdk dir>]
       [--native=<native CLI>] [--compiler=<scriptc bootstrap>] [--cache-root=<dir>]
       [--only=<scenario>]... [--runs=1] [--sample-ms=500] [--json=<file>] [--keep]

Runs app builds and reports each SCRIPTC_TIMING phase's wall time and the
build tree's peak PSS, plus partition cache reuse. The default scenarios are: counter release cold, counter dev cold, counter dev one-line edit,
ui-settings dev cold, and ui-dashboard dev with ui-settings' warm cache.
--config names a JSON file (see the header of this script) for other apps.`,
  );
  process.exit(0);
}

const selected = scenarios.filter(
  (scenario) => values.only === undefined || values.only.includes(scenario.name),
);
if (values.list) {
  for (const scenario of scenarios)
    console.log(`${selected.includes(scenario) ? "*" : " "} ${scenario.name}`);
  process.exit(0);
}
if (selected.length === 0)
  throw new Error(`no scenario matches ${JSON.stringify(values.only)}; --list them`);

assert.ok(existsSync(nativeCli), `native CLI not found at ${nativeCli}; build native-sdk first`);
assert.ok(existsSync(compiler), `compiler not found at ${compiler}; run pnpm build first`);

/** A shell shim the native CLI runs in place of its installed scriptc
 * (NATIVE_SCRIPTC), pointing it at this checkout's compiler. The native
 * command captures the compiler's stderr for its own tidy report, so the shim
 * also tees it to SCRIPTC_TIMING_LOG: that file is where the phases of the
 * measured build come from. */
function compilerShim(directory) {
  const shim = join(directory, process.platform === "win32" ? "scriptc.cmd" : "scriptc");
  const run = compiler.endsWith(".js") ? `exec node "${compiler}" "$@"` : `exec "${compiler}" "$@"`;
  if (process.platform === "win32") {
    writeFileSync(shim, `@echo off\r\nnode "${compiler}" %*\r\n`);
  } else {
    writeFileSync(
      shim,
      `#!/bin/bash\nlog="\${SCRIPTC_TIMING_LOG:-/dev/null}"\n${run} 2> >(tee -a "$log" >&2)\n`,
    );
    chmodSync(shim, 0o755);
  }
  return shim;
}

/** Every process under `root`, from /proc. Token 4 of /proc/<pid>/stat is the
 * parent pid; the executable name may hold spaces, so parse after the last
 * closing parenthesis. */
function processTree(root) {
  let names;
  try {
    names = readdirSync("/proc");
  } catch {
    return [root];
  }
  const parentOf = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    parentOf.set(Number(name), Number(fields[1]));
  }
  const children = new Map();
  for (const [pid, parent] of parentOf) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const tree = [];
  const pending = [root];
  while (pending.length > 0) {
    const pid = pending.pop();
    tree.push(pid);
    for (const child of children.get(pid) ?? []) pending.push(child);
  }
  return tree;
}

/** The tree's proportional set size in bytes: PSS when the kernel reports it
 * (a forked child's shared pages are counted once), else resident size. */
function treePssBytes(root) {
  let total = 0;
  for (const pid of processTree(root)) {
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      const pss = /^Pss:\s+(\d+) kB$/m.exec(rollup);
      if (pss !== null) {
        total += Number(pss[1]) * 1024;
        continue;
      }
    } catch {
      // No smaps_rollup (an old kernel or a process that just exited).
    }
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (rss !== null) total += Number(rss[1]) * 1024;
    } catch {
      // Gone since the listing.
    }
  }
  return total;
}

/** Partition cache entries under `cacheDirectory`, by path, with their
 * modification time. The helper touches an entry it looks up and creates the
 * ones it compiles, so a touched entry that existed before the build was
 * reused. */
function partitionEntries(cacheDirectory) {
  const entries = new Map();
  const walk = (directory) => {
    let names;
    try {
      names = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else entries.set(path, statSync(path).mtimeMs);
    }
  };
  walk(join(cacheDirectory, "native-partitions-v1"));
  return entries;
}

/** The partition key of a cache entry (`<key>.o`, `<key>.bc`, ...). */
function partitionKey(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

function summarizeReuse(before, after, startedAt) {
  const keys = new Set();
  for (const [path, mtime] of after) {
    if (mtime >= startedAt) keys.add(partitionKey(path));
  }
  const beforeKeys = new Set([...before.keys()].map(partitionKey));
  let reused = 0;
  for (const key of keys) if (beforeKeys.has(key)) reused++;
  return {
    partitions: keys.size,
    reused,
    compiled: keys.size - reused,
    reuse: keys.size === 0 ? null : reused / keys.size,
  };
}

function parseTimingLine(line) {
  const prefix = "scriptc timing ";
  if (!line.startsWith(prefix)) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
}

/** Runs the native build of one scenario, sampling the process tree. */
function measure(scenario, context) {
  const app = config.apps[scenario.app];
  const args = ["build", app.dir, "-o", app.output];
  if (scenario.release === true) args.push("--release");
  const env = {
    ...process.env,
    NATIVE_SCRIPTC: context.shim,
    SCRIPTC_TIMING: "1",
    SCRIPTC_CACHE_DIR: context.cacheDirectory,
    // A benchmark wants the helper for this build, not a resident server.
    SCRIPTC_CODEGEN_SERVER: "0",
    // Every measured build must run the compiler; the app build's own cache
    // would otherwise restore an executable and print no phases.
    NATIVE_NO_CACHE: "1",
    NATIVE_CACHE_DIR: join(context.cacheDirectory, "native-build"),
  };
  delete env["SCRIPTC_NO_CACHE"];
  const timingLog = join(
    context.logDirectory,
    `${scenario.name.replace(/\W+/g, "-")}-${Date.now()}.log`,
  );
  env["SCRIPTC_TIMING_LOG"] = timingLog;
  const startedAt = Date.now();
  const before = partitionEntries(context.cacheDirectory);
  const phases = [];
  let stderr = "";
  const child = spawn(process.execPath, [nativeCli, ...args], {
    cwd: app.dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  // The shim tees the compiler's stderr to `timingLog`; follow the file and
  // timestamp each phase as its line appears, so PSS samples attribute to the
  // phase that was running then.
  let offset = 0;
  let carry = "";
  const drainTiming = () => {
    let fd;
    try {
      fd = openSync(timingLog, "r");
    } catch {
      return;
    }
    try {
      const size = statSync(timingLog).size;
      if (size <= offset) return;
      const buffer = Buffer.allocUnsafe(size - offset);
      let read = 0;
      while (read < buffer.length) {
        const count = readSync(fd, buffer, read, buffer.length - read, offset + read);
        if (count <= 0) break;
        read += count;
      }
      offset += read;
      carry += buffer.toString("utf8", 0, read);
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseTimingLine(line);
        if (event !== null) phases.push({ at: Date.now(), ...event });
      }
    } finally {
      closeSync(fd);
    }
  };
  const peaks = new Map();
  let peakBytes = 0;
  let last = null;
  const sample = () => {
    drainTiming();
    const bytes = child.pid === undefined ? 0 : treePssBytes(child.pid);
    if (bytes > peakBytes) peakBytes = bytes;
    const phase = phases.length === 0 ? "(startup)" : phases[phases.length - 1].phase;
    if (process.env["SCRIPTC_BENCH_DEBUG"] === "1") {
      const tree = child.pid === undefined ? [] : processTree(child.pid);
      console.error(
        `bench sample phase=${phase} mb=${Math.round(bytes / 2 ** 20)} pids=${tree.length}`,
      );
    }
    if (last !== phase) {
      last = phase;
      if (!peaks.has(phase)) peaks.set(phase, 0);
    }
    const current = peaks.get(phase) ?? 0;
    if (bytes > current) peaks.set(phase, bytes);
  };
  const timer = setInterval(sample, Math.min(sampleMs, 200));
  sample();
  return new Promise((resolveRun, rejectRun) => {
    const timeout = setTimeout(
      () => {
        child.kill("SIGKILL");
        rejectRun(new Error(`${scenario.name} ran past 30 minutes`));
      },
      30 * 60 * 1000,
    );
    child.on("error", (error) => {
      clearTimeout(timeout);
      clearInterval(timer);
      rejectRun(error);
    });
    child.on("close", async (status) => {
      clearTimeout(timeout);
      clearInterval(timer);
      // The tee may still be flushing when the build process closes.
      await new Promise((done) => setTimeout(done, 200));
      drainTiming();
      const endedAt = Date.now();
      const after = partitionEntries(context.cacheDirectory);
      resolveRun({
        name: scenario.name,
        status,
        wall_ms: endedAt - startedAt,
        peak_mb: peakBytes / (1024 * 1024),
        phases: phases.map((event) => ({
          phase: event.phase,
          phase_ms: event.phase_ms,
          total_ms: event.total_ms,
          rss_mb: event.rss_mb,
          cpu_ms: event.cpu_ms,
          peak_mb: (peaks.get(event.phase) ?? 0) / (1024 * 1024),
        })),
        reuse: summarizeReuse(before, after, startedAt),
        stderr: stderr.length > 200_000 ? stderr.slice(-200_000) : stderr,
      });
    });
  });
}

/** Applies the scenario's edit to the app's source; returns the undo. */
function applyEdit(scenario) {
  if (scenario.edit === undefined) return () => {};
  const app = config.apps[scenario.app];
  const path = join(app.dir, scenario.edit.file);
  const original = readFileSync(path, "utf8");
  if (original.includes(scenario.edit.replace) && !original.includes(scenario.edit.find))
    return () => {};
  assert.ok(
    original.includes(scenario.edit.find),
    `${scenario.name}: ${scenario.edit.file} does not contain ${JSON.stringify(scenario.edit.find)}`,
  );
  writeFileSync(path, original.replace(scenario.edit.find, scenario.edit.replace));
  return () => writeFileSync(path, original);
}

/** Prepares an app's `.native` directory (its entry, host objects and ffi
 * manifest) with one unmeasured build, the way `native build` does before the
 * compiler starts. Its cache is the harness's own, so a cold scenario still
 * measures an empty compiler cache. */
function ensurePrepared(app, context) {
  const marker = join(app.dir, ".native", "ffi.json");
  if (existsSync(marker) && existsSync(join(app.dir, ".native", "entry.ts"))) return;
  const result = spawnSync(process.execPath, [nativeCli, "build", app.dir, "-o", app.output], {
    cwd: app.dir,
    env: {
      ...process.env,
      NATIVE_SCRIPTC: context.shim,
      NATIVE_NO_CACHE: "1",
      SCRIPTC_CODEGEN_SERVER: "0",
      SCRIPTC_CACHE_DIR: join(work, `prepare-${app.dir.replace(/\W+/g, "-")}`),
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${app.dir}: preparing .native failed with status ${result.status}`);
  }
}

function prepare(scenario, context) {
  const app = config.apps[scenario.app];
  mkdirSync(join(app.dir, dirname(app.output)), { recursive: true });
  if (scenario.cold !== undefined) {
    rmSync(context.cacheDirectory, { recursive: true, force: true });
    rmSync(join(app.dir, app.output), { force: true });
  }
  mkdirSync(context.cacheDirectory, { recursive: true, mode: 0o700 });
}

const cacheRoot = values["cache-root"] ?? mkdtempSync(join(tmpdir(), "scriptc-sepcomp-"));
mkdirSync(cacheRoot, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "scriptc-sepcomp-work-"));
const shim = compilerShim(work);
const completed = new Map();
const results = [];

/** The cache group a scenario builds into: its own `cold` group, else the
 * group of the scenario it sets up from, else one of its own. */
function cacheGroupOf(scenario) {
  if (scenario.cold !== undefined) return scenario.cold;
  if (scenario.setup !== undefined) {
    const setup = scenarios.find((candidate) => candidate.name === scenario.setup);
    if (setup !== undefined) return cacheGroupOf(setup);
  }
  return scenario.name.replace(/\W+/g, "-");
}

async function runScenario(scenario, measured) {
  const prerequisites = [];
  if (scenario.setup !== undefined) {
    const setup = scenarios.find((candidate) => candidate.name === scenario.setup);
    assert.ok(setup !== undefined, `${scenario.name}: unknown setup ${scenario.setup}`);
    prerequisites.push(setup);
  }
  for (const prerequisite of prerequisites)
    if (!completed.has(prerequisite.name)) await runScenario(prerequisite, false);
  const cacheDirectory = join(cacheRoot, cacheGroupOf(scenario));
  const logDirectory = join(work, "logs");
  mkdirSync(logDirectory, { recursive: true });
  const context = { shim, cacheDirectory, logDirectory };
  // A measured build starts from a prepared app directory; the compiler
  // cache it measures stays empty.
  if (measured) ensurePrepared(config.apps[scenario.app], context);
  prepare(scenario, context);
  const undo = applyEdit(scenario);
  try {
    for (let run = 0; run < (measured ? runs : 1); run++) {
      const result = await measure(scenario, context);
      if (!measured) {
        if (result.status !== 0) {
          process.stderr.write(result.stderr);
          throw new Error(`${scenario.name}: setup build failed with status ${result.status}`);
        }
        completed.set(scenario.name, result);
        continue;
      }
      result.run = run + 1;
      results.push(result);
    }
  } finally {
    undo();
  }
  completed.set(scenario.name, true);
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(1);
}

function printReport() {
  for (const result of results) {
    console.log(
      `\n${result.name}${runs > 1 ? ` (run ${result.run})` : ""}: ` +
        `${formatSeconds(result.wall_ms)} s wall, ${(result.peak_mb / 1024).toFixed(2)} GB peak PSS, ` +
        `status ${result.status}`,
    );
    console.log("| phase | wall s | total s | phase peak GB | rss peak MB | cpu s |");
    console.log("|---|---|---|---|---|---|");
    for (const phase of result.phases) {
      console.log(
        `| ${phase.phase} | ${formatSeconds(phase.phase_ms ?? 0)} | ` +
          `${formatSeconds(phase.total_ms ?? 0)} | ${(phase.peak_mb / 1024).toFixed(2)} | ` +
          `${phase.rss_mb ?? ""} | ${((phase.cpu_ms ?? 0) / 1000).toFixed(1)} |`,
      );
    }
    const reuse = result.reuse;
    if (reuse.partitions > 0) {
      console.log(
        `Partitions: ${reuse.reused}/${reuse.partitions} reused ` +
          `(${((reuse.reuse ?? 0) * 100).toFixed(0)}%), ${reuse.compiled} compiled.`,
      );
    }
  }
  if (runs > 1) {
    const byName = new Map();
    for (const result of results) {
      if (!byName.has(result.name)) byName.set(result.name, []);
      byName.get(result.name).push(result);
    }
    console.log("\n| scenario | median wall s | peak wall s | median peak GB |");
    console.log("|---|---|---|---|");
    for (const [name, samples] of byName) {
      const medians = (valuesOf) => {
        const sorted = [...valuesOf].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      };
      console.log(
        `| ${name} | ${formatSeconds(medians(samples.map((sample) => sample.wall_ms)))} | ` +
          `${formatSeconds(Math.max(...samples.map((sample) => sample.wall_ms)))} | ` +
          `${(medians(samples.map((sample) => sample.peak_mb)) / 1024).toFixed(2)} |`,
      );
    }
  }
}

try {
  for (const scenario of selected) await runScenario(scenario, true);
} finally {
  printReport();
  if (values.json !== undefined) {
    writeFileSync(
      resolve(values.json),
      `${JSON.stringify(
        {
          measured: {
            compiler,
            native: nativeCli,
            cpus: availableParallelism(),
            sample_ms: sampleMs,
            runs,
          },
          results,
        },
        null,
        2,
      )}\n`,
    );
  }
  if (values.keep !== true) rmSync(work, { recursive: true, force: true });
}
