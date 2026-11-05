#!/usr/bin/env node
/* Refreshes packages/compiler/native/cli.profdata.gz, the profile that builds
 * of the native compiler optimize with (scripts/build-native-cli.mts). The
 * release workflow's cli-profile job runs it with --output on the release
 * commit, and release builds use that profile instead of the committed one.
 *
 * Builds an instrumented native compiler for this Linux host, runs it on the
 * training builds below, and merges the raw profiles it writes into one
 * indexed profile. The training builds are tsc-ts (a cold `speed`
 * build, then a rebuild after an edit), every seventh top-level corpus
 * program (by number, or by a hash of the name of a program without one) at
 * the default optimization and a further slice in `dev`, and the runtime
 * benchmark workloads. Run it on a quiet Linux x64 host after changes that
 * move much compiler code; a stale profile only loses part of its gain. A
 * refresh takes about 11 minutes on 16 cores.
 *
 * The instrumented compiler is built with the committed function layout, or
 * the one SCRIPTC_NATIVE_LAYOUT names, and the profile matches builds that
 * use the same layout. When refreshing both, refresh the layout first
 * (scripts/refresh-cli-layout.mjs).
 *
 * With --context-sensitive, a second phase follows: a compiler optimized by
 * the first profile and instrumented after inlining runs the same training,
 * and its raw profiles are merged into the first profile. The result adds
 * the counts of inlined code, by which builds also order each function's
 * blocks and move cold blocks apart. --base-profile runs only that second
 * phase on a given first profile. The second phase's compiler build also
 * writes the block counts of the functions the first profile annotates
 * (SCRIPTC_RECORD_PROFILE_BLOCKS), which both phases share, beside the
 * output (cli.blocks.gz beside cli.profdata.gz). Builds that use the profile
 * annotate the functions whose control flow changed since it was collected
 * from them.
 *
 *   node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout> [--jobs 8] [--context-sensitive]
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
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
import { constants, gunzipSync, gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    "tsc-ts": { type: "string" },
    jobs: { type: "string", default: String(Math.max(1, Math.floor(cpus().length / 2))) },
    output: { type: "string", default: join(root, "packages/compiler/native/cli.profdata.gz") },
    work: { type: "string" },
    instrumented: { type: "string" },
    "context-sensitive": { type: "boolean", default: false },
    "base-profile": { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || values["tsc-ts"] === undefined) {
  console.log(
    "Usage: node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout> [--jobs N] [--output <profdata.gz>] [--work <dir>] [--instrumented <compiler dir>] [--context-sensitive | --base-profile <profdata[.gz]>]",
  );
  process.exit(values.help ? 0 : 2);
}
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("the compiler profile is collected on Linux x64");
const tscTs = resolve(values["tsc-ts"]);
const tscTsPackage = join(tscTs, "packages/tsc-ts");
if (!existsSync(join(tscTsPackage, "src/main.ts")))
  throw new Error(`${tscTs} is not a tsc-ts checkout with installed dependencies`);
const jobs = Number(values.jobs);
if (values["context-sensitive"]) {
  if (values["base-profile"] !== undefined || values.instrumented !== undefined)
    throw new Error(
      "--context-sensitive runs both phases: it takes no --base-profile or --instrumented",
    );
  // The first phase, then the second on its profile, each by a run of this script.
  const phases = resolve(values.work ?? mkdtempSync(join(tmpdir(), "scriptc-cli-profile-phases-")));
  const first = join(phases, "first.profdata.gz");
  const common = ["--tsc-ts", tscTs, "--jobs", String(jobs)];
  for (const args of [
    [...common, "--output", first, "--work", join(phases, "first")],
    [
      ...common,
      "--output",
      resolve(values.output),
      "--work",
      join(phases, "second"),
      "--base-profile",
      first,
    ],
  ]) {
    const phase = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      stdio: "inherit",
    });
    if (phase.status !== 0) throw new Error("a profile phase failed");
  }
  if (values.work === undefined) rmSync(phases, { recursive: true, force: true });
  process.exit(0);
}
// The first profile, for a run of the second phase.
const baseProfile =
  values["base-profile"] === undefined ? undefined : resolve(values["base-profile"]);
// The output's directory is created up front, before the instrumented build.
const profileOutput = resolve(values.output);
mkdirSync(dirname(profileOutput), { recursive: true });
// The block counts beside the output, which only the second phase writes;
// those of an earlier collection would describe another profile's code.
const blocksOutput = profileOutput.endsWith(".profdata.gz")
  ? `${profileOutput.slice(0, -".profdata.gz".length)}.blocks.gz`
  : `${profileOutput}.blocks.gz`;
rmSync(blocksOutput, { force: true });
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), "scriptc-cli-profile-")));
const raw = join(work, "raw");
const blocks = join(work, "cli.blocks");
rmSync(blocks, { force: true });
const builds = join(work, "builds");
rmSync(raw, { recursive: true, force: true });
for (const dir of [raw, builds]) mkdirSync(dir, { recursive: true });
const log = join(work, "training.log");

// Every run merges its counters into one of four pooled raw profiles.
const profileFile = join(raw, "cli-%4m.profraw");
// --instrumented reuses a compiler an earlier run built in <work>/cli.
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
      env: {
        ...process.env,
        SCRIPTC_NATIVE_PROFILE_GENERATE: profileFile,
        ...(baseProfile === undefined
          ? {}
          : { SCRIPTC_NATIVE_PROFILE_USE: baseProfile, SCRIPTC_RECORD_PROFILE_BLOCKS: blocks }),
      },
    },
  );
  if (built.status !== 0) throw new Error("the instrumented compiler did not build");
}
const scriptc = join(cli, "bin/scriptc");
// The compiler trains with the helper it bundles, so a helper override in
// the environment does not apply.
const trainingEnv = { ...process.env, LLVM_PROFILE_FILE: profileFile };
delete trainingEnv["SCRIPTC_LLVM_HELPER"];

/** Runs the instrumented compiler; a failing build still profiles the
 * paths it took. */
function run(args, options) {
  return new Promise((done) => {
    const child = spawn(scriptc, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...trainingEnv, SCRIPTC_CACHE_DIR: options.cache },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      appendFileSync(log, `$ scriptc ${args.join(" ")}\n${output}exit ${code}\n`);
      done(code === 0);
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

/** A top-level corpus program's sampling key: its number, or, for a program
 * named without one, a stable hash of its name (FNV-1a). */
const programKey = (name) =>
  /^\d+-/.test(name)
    ? Number.parseInt(name, 10)
    : [...name].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
/** Numbered programs by number, then the named ones by name. */
const programOrder = (a, b) =>
  /^\d+-/.test(a) !== /^\d+-/.test(b)
    ? /^\d+-/.test(a)
      ? -1
      : 1
    : programKey(a) - programKey(b) || (a < b ? -1 : a > b ? 1 : 0);
const corpus = readdirSync(join(root, "tests/corpus"))
  .filter(
    (name) => /^[\w-]+\.ts$/.test(name) && statSync(join(root, "tests/corpus", name)).isFile(),
  )
  .sort(programOrder);
const training = [
  ...corpus
    .filter((name) => programKey(name) % 7 === 0)
    .map((name) => ({ file: join(root, "tests/corpus", name), optimization: "release" })),
  ...corpus
    .filter((name) => programKey(name) % 14 === 7)
    .map((name) => ({ file: join(root, "tests/corpus", name), optimization: "dev" })),
  ...readdirSync(join(root, "benchmarks/runtime/workloads"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      file: join(root, "benchmarks/runtime/workloads", name),
      optimization: "release",
    })),
];

const started = Date.now();
console.log("training: tsc-ts, cold and after an edit");
const tscCache = join(work, "cache-tsc-ts");
const tscArgs = [
  "build",
  "src/main.ts",
  "--optimization=speed",
  "--detached-exit",
  "-o",
  join(builds, "tsc"),
];
await run(tscArgs, { cwd: tscTsPackage, cache: tscCache });
const edited = join(tscTsPackage, "src/main.ts");
const source = readFileSync(edited, "utf8");
try {
  writeFileSync(edited, source + "\n// profile training edit\n");
  await run(tscArgs, { cwd: tscTsPackage, cache: tscCache });
} finally {
  writeFileSync(edited, source);
}

console.log(`training: ${training.length} programs, ${jobs} at a time`);
const passed = await pool(
  training.map((program, index) => () => {
    const cache = join(work, `cache-${index}`);
    return run(
      [
        "build",
        program.file,
        `--optimization=${program.optimization}`,
        "-o",
        join(builds, `program-${index}`),
      ],
      { cwd: root, cache },
    ).then((ok) => {
      rmSync(cache, { recursive: true, force: true });
      rmSync(join(builds, `program-${index}`), { force: true });
      return ok;
    });
  }),
);
console.log(
  `trained in ${Math.round((Date.now() - started) / 1000)} s; ${passed} of ${training.length} programs built (failures still profile; see ${log})`,
);

const profiles = readdirSync(raw)
  .filter((name) => name.endsWith(".profraw"))
  .map((name) => join(raw, name));
rmSync(builds, { recursive: true, force: true });
const indexed = join(work, "cli.profdata");
// The profile keeps the functions that never ran in training, with zero
// counts. Builds optimize those as cold and place them after the trained code,
// which keeps the compiler's .text smaller than a sparse profile does.
// A second phase merges its counts into the first profile, uncompressed.
const inputs = [...profiles];
if (baseProfile !== undefined) {
  const base = join(work, "base.profdata");
  const bytes = readFileSync(baseProfile);
  writeFileSync(base, baseProfile.endsWith(".gz") ? gunzipSync(bytes) : bytes);
  inputs.unshift(base);
}
const merged = spawnSync(scriptc, ["merge-profiles", "-o", indexed, ...inputs], {
  stdio: "inherit",
  env: { ...trainingEnv, LLVM_PROFILE_FILE: join(work, "merge.profraw") },
});
if (merged.status !== 0) throw new Error("merge-profiles failed");
// The indexed profile compresses to about a sixth of its size.
writeFileSync(
  profileOutput,
  gzipSync(readFileSync(indexed), { level: constants.Z_BEST_COMPRESSION }),
);
console.log(
  `wrote ${profileOutput} (${statSync(profileOutput).size} bytes; ${statSync(indexed).size} uncompressed)`,
);
if (existsSync(blocks)) {
  writeFileSync(
    blocksOutput,
    gzipSync(readFileSync(blocks), { level: constants.Z_BEST_COMPRESSION }),
  );
  console.log(`wrote ${blocksOutput} (${statSync(blocksOutput).size} bytes)`);
}
// A work directory the caller named stays for inspection.
if (values.work === undefined) rmSync(work, { recursive: true, force: true });
