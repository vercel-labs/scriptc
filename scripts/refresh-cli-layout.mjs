#!/usr/bin/env node
/* Refreshes packages/compiler/native/cli.layout.gz, the function layout that
 * builds of the native compiler use (scripts/build-native-cli.mts). The
 * layout lists the functions the compiler runs, in tiers: tier 1 for
 * `--version` and rebuilds of unchanged programs, then the functions of the
 * other builds by the share of training builds that run them (COLD_TIERS).
 * The emitter writes the listed functions first, by tier, so the code a build
 * runs sits together in the compiler's executable and a run maps fewer of its
 * pages: a function nearly every build runs sits with the others that do, not
 * among functions only a few programs need.
 *
 * Builds an instrumented native compiler for this Linux host (or reuses one
 * with --instrumented), builds each training program cold and then again
 * unchanged, and reads the functions each kind of run executed from the raw
 * profiles. The training programs are the runtime benchmark workloads at
 * `speed` and every seventh corpus program at the default optimization. A
 * refresh takes about 15 minutes on 16 cores, most of it for the instrumented
 * build. A stale layout lists some functions that no longer exist and misses
 * new ones, which then keep their usual order.
 *
 *   node scripts/refresh-cli-layout.mjs [--jobs 8] [--instrumented <compiler dir>]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { constants, gzipSync, inflateSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    jobs: { type: "string", default: String(Math.max(1, Math.floor(cpus().length / 2))) },
    output: { type: "string", default: join(root, "packages/compiler/native/cli.layout.gz") },
    work: { type: "string" },
    instrumented: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/refresh-cli-layout.mjs [--jobs N] [--output <layout.gz>] [--work <dir>] [--instrumented <compiler dir>]",
  );
  process.exit(0);
}
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("the compiler layout is collected on Linux x64");
const jobs = Number(values.jobs);
const output = resolve(values.output);
mkdirSync(dirname(output), { recursive: true });
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), "scriptc-cli-layout-")));
const raw = join(work, "raw");
const builds = join(work, "builds");
rmSync(raw, { recursive: true, force: true });
for (const dir of [raw, builds]) mkdirSync(dir, { recursive: true });
const log = join(work, "training.log");

const cli = resolve(values.instrumented ?? join(work, "cli"));
if (values.instrumented === undefined) {
  console.log(`building the instrumented compiler in ${cli}`);
  const built = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      "--import",
      "tsx",
      join(root, "scripts/build-native-cli.mts"),
      cli,
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, SCRIPTC_NATIVE_PROFILE_GENERATE: join(raw, "build-%4m.profraw") },
    },
  );
  if (built.status !== 0) throw new Error("the instrumented compiler did not build");
}
const scriptc = join(cli, "bin/scriptc");
// Phase timing shows whether a rebuild hit both caches. It is on for every
// run, so the rebuild's environment matches the first build's.
const baseEnv = { ...process.env, SCRIPTC_TIMING: "1" };
delete baseEnv["SCRIPTC_LLVM_HELPER"];

/** Runs the instrumented compiler, writing its profile to `options.profile`.
 * Throws when the profile runtime reports that it could not write the
 * profile (a full disk, for example): the compiler still exits with 0. */
function run(args, options) {
  return new Promise((done, fail) => {
    const child = spawn(scriptc, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...baseEnv,
        SCRIPTC_CACHE_DIR: options.cache,
        LLVM_PROFILE_FILE: options.profile,
      },
    });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("close", (code) => {
      appendFileSync(log, `$ scriptc ${args.join(" ")}\n${text}exit ${code}\n`);
      const profileError = /^LLVM Profile Error: .*$/m.exec(text)?.[0];
      if (profileError !== undefined) fail(new Error(`scriptc ${args.join(" ")}: ${profileError}`));
      else done({ ok: code === 0, text });
    });
  });
}

async function pool(tasks) {
  let next = 0;
  let passed = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < tasks.length) if (await tasks[next++]()) passed++;
    }),
  );
  return passed;
}

const programNumber = (name) => Number.parseInt(name, 10);
const training = [
  ...readdirSync(join(root, "benchmarks/runtime/workloads"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      file: join(root, "benchmarks/runtime/workloads", name),
      optimization: "speed",
    })),
  ...readdirSync(join(root, "tests/corpus"))
    .filter((name) => /^\d+-.*\.ts$/.test(name) && programNumber(name) % 7 === 0)
    .map((name) => ({ file: join(root, "tests/corpus", name), optimization: "release" })),
];

// Tier 1 collects each run that took the warm path from its own profile; a
// rebuild that missed a cache (it shows no `frontend-cache-hit` or
// `executable-cache-hit` phase) is left out. The first builds each write
// their own profile (cold-<program>-*), merged across the build's processes.
// Each profile is read and deleted when its build finishes: a profile is
// about 23 MB, and keeping every build's until the end takes about 9 GB.
const warm = new Set();
let skipped = 0;
// For each function, how many of the first builds ran it.
const runs = new Map();
let coldBuilds = 0;
function countColdRun(index) {
  const profiles = readdirSync(raw).filter((name) => name.startsWith(`cold-${index}-`));
  if (profiles.length === 0) return;
  const ran = new Set();
  for (const name of profiles) {
    for (const fn of executedFunctions(join(raw, name))) ran.add(fn);
    rmSync(join(raw, name));
  }
  for (const fn of ran) runs.set(fn, (runs.get(fn) ?? 0) + 1);
  coldBuilds++;
}
async function warmRun(args, cache, name, cacheHits) {
  const profile = join(raw, `warm-${name}.profraw`);
  const { ok, text } = await run(args, { cwd: root, cache, profile });
  if (ok && cacheHits.every((phase) => text.includes(`"phase":"${phase}"`)))
    for (const fn of executedFunctions(profile)) warm.add(fn);
  else skipped++;
  rmSync(profile, { force: true });
}

const started = Date.now();
await warmRun(["--version"], join(work, "cache-version"), "version", []);
console.log(`training: ${training.length} programs, cold then unchanged, ${jobs} at a time`);
const passed = await pool(
  training.map((program, index) => async () => {
    const cache = join(work, `cache-${index}`);
    const out = join(builds, `program-${index}`);
    const args = ["build", program.file, `--optimization=${program.optimization}`, "-o", out];
    const { ok } = await run(args, {
      cwd: root,
      cache,
      profile: join(raw, `cold-${index}-%1m.profraw`),
    });
    countColdRun(index);
    if (ok)
      await warmRun(args, cache, String(index), ["frontend-cache-hit", "executable-cache-hit"]);
    rmSync(cache, { recursive: true, force: true });
    rmSync(out, { force: true });
    return ok;
  }),
);
console.log(
  `trained in ${Math.round((Date.now() - started) / 1000)} s; ${passed} of ${training.length} programs built, ${skipped} rebuilds left out of tier 1 (see ${log})`,
);

/** Functions a raw profile (LLVM's format version 10) records as run: the
 * names whose counters are not all zero, without the file prefix of
 * internal functions. */
function executedFunctions(path) {
  const buf = readFileSync(path);
  const u64 = (offset) => Number(buf.readBigUInt64LE(offset));
  if (buf.readBigUInt64LE(0) !== 0xff6c70726f667281n)
    throw new Error(`${path} is not a 64-bit raw profile`);
  const version = Number(buf.readBigUInt64LE(8) & 0xffffffffn);
  if (version !== 10) throw new Error(`${path} has raw profile version ${version}, expected 10`);
  const [binaryIdsBytes, records, beforeCounters, counters, afterCounters] = [2, 3, 4, 5, 6].map(
    (field) => u64(field * 8),
  );
  const [bitmapBytes, afterBitmap, namesBytes] = [7, 8, 9].map((field) => u64(field * 8));
  const valueKinds = u64(15 * 8) + 1;
  const recordBytes = Math.ceil((6 * 8 + 4 + 2 * valueKinds + 4) / 8) * 8;
  const dataStart = 16 * 8 + binaryIdsBytes;
  const countersStart = dataStart + records * recordBytes + beforeCounters;
  const namesStart = countersStart + counters * 8 + afterCounters + bitmapBytes + afterBitmap;
  // The profile runtime reports a failed write (a full disk, for example) on
  // stderr, and the compiler still exits with 0, leaving a partial file.
  if (buf.length < namesStart + namesBytes)
    throw new Error(
      `${path} is ${buf.length} bytes, shorter than the ${namesStart + namesBytes} bytes its header describes`,
    );
  const countersDelta = buf.readBigInt64LE(10 * 8);
  const names = new Map();
  let at = namesStart;
  const uleb = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = buf[at++];
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
    }
  };
  while (at < namesStart + namesBytes) {
    const plain = uleb();
    const packed = uleb();
    if (plain === 0) break;
    const bytes =
      packed === 0 ? buf.subarray(at, at + plain) : inflateSync(buf.subarray(at, at + packed));
    at += packed === 0 ? plain : packed;
    for (const name of bytes.toString("latin1").split("\x01"))
      names.set(createHash("md5").update(name, "latin1").digest().readBigUInt64LE(0), name);
  }
  const ran = [];
  for (let index = 0; index < records; index++) {
    const record = dataStart + index * recordBytes;
    const counterOffset = Number(
      buf.readBigInt64LE(record + 16) - (countersDelta - BigInt(index * recordBytes)),
    );
    const count = buf.readUInt32LE(record + 48);
    for (let c = 0; c < count; c++) {
      if (buf.readBigUInt64LE(countersStart + counterOffset + c * 8) !== 0n) {
        const name = names.get(buf.readBigUInt64LE(record));
        if (name !== undefined) ran.push(name.slice(name.indexOf(";") + 1));
        break;
      }
    }
  }
  return ran;
}

// The cold tiers, by the least share of training builds that run a function:
// tier 2 for functions at least 90% of the builds run, tier 3 for 60%, and so
// on; tier 7 holds the functions fewer than 3% of the builds run.
const COLD_TIERS = [0.9, 0.6, 0.3, 0.1, 0.03];
const coldTier = (count) => {
  const share = count / coldBuilds;
  const index = COLD_TIERS.findIndex((least) => share >= least);
  return 2 + (index < 0 ? COLD_TIERS.length : index);
};
const lines = [
  ...[...warm].sort().map((name) => `1 ${name}`),
  ...[...runs]
    .filter(([name]) => !warm.has(name))
    .map(([name, count]) => [coldTier(count), name])
    .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([tier, name]) => `${tier} ${name}`),
];
writeFileSync(output, gzipSync(`${lines.join("\n")}\n`, { level: constants.Z_BEST_COMPRESSION }));
const perTier = new Map();
for (const line of lines)
  perTier.set(line.split(" ")[0], (perTier.get(line.split(" ")[0]) ?? 0) + 1);
console.log(
  `wrote ${output}: ${[...perTier].map(([tier, count]) => `tier ${tier}: ${count}`).join(", ")} functions, from ${coldBuilds} builds (${statSync(output).size} bytes)`,
);
rmSync(builds, { recursive: true, force: true });
if (values.work === undefined) rmSync(work, { recursive: true, force: true });
