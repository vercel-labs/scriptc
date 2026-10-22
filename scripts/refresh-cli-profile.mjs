#!/usr/bin/env node
/* Refreshes packages/compiler/native/cli.profdata.gz, the profile that release
 * builds of the native compiler optimize with (scripts/build-native-cli.mts).
 *
 * Builds an instrumented native compiler for this Linux host, runs it on the
 * training builds below, and merges the raw profiles it writes into one
 * sparse indexed profile. The training builds are tsc-ts (a cold `speed`
 * build, then a rebuild after an edit), every seventh corpus program at the
 * default optimization and a further slice in `dev`, the runtime
 * benchmark workloads, and small builds: a slice of corpus programs built
 * cold and then from the cache, whose counts are weighted (see
 * SMALL_BUILD_WEIGHT). Run it on a quiet Linux x64 host after changes that
 * move much compiler code; a stale profile only loses part of its gain. A
 * refresh takes about 11 minutes on 16 cores.
 *
 *   node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout> [--jobs 8]
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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { constants, gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    "tsc-ts": { type: "string" },
    jobs: { type: "string", default: String(Math.max(1, Math.floor(cpus().length / 2))) },
    output: { type: "string", default: join(root, "packages/compiler/native/cli.profdata.gz") },
    work: { type: "string" },
    instrumented: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || values["tsc-ts"] === undefined) {
  console.log(
    "Usage: node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout> [--jobs N] [--output <profdata.gz>] [--work <dir>] [--instrumented <compiler dir>]",
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
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), "scriptc-cli-profile-")));
const raw = join(work, "raw");
const builds = join(work, "builds");
rmSync(raw, { recursive: true, force: true });
for (const dir of [raw, builds]) mkdirSync(dir, { recursive: true });
const log = join(work, "training.log");

// Every run merges its counters into one of four pooled raw profiles.
const profileFile = join(raw, "cli-%4m.profraw");
// Small builds pool theirs apart, so the merge can weight them.
const smallProfileFile = join(raw, "small-%4m.profraw");
// The weight of the small builds' counts. tsc-ts's build counts far more
// than all the small builds together, so without a weight the linker's
// call-graph ordering places code by that one build, and the code every
// build runs (startup, the frontend, the cache) is spread over the whole
// profiled range. Weighted, the small builds' calls come first.
const SMALL_BUILD_WEIGHT = 200;
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
      env: { ...process.env, SCRIPTC_NATIVE_PROFILE_GENERATE: profileFile },
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
      env: {
        ...trainingEnv,
        SCRIPTC_CACHE_DIR: options.cache,
        ...(options.profile === undefined ? {} : { LLVM_PROFILE_FILE: options.profile }),
      },
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

const programNumber = (name) => Number.parseInt(name, 10);
const corpus = readdirSync(join(root, "tests/corpus"))
  .filter((name) => /^\d+-.*\.ts$/.test(name))
  .sort((a, b) => programNumber(a) - programNumber(b));
const training = [
  ...corpus
    .filter((name) => programNumber(name) % 7 === 0)
    .map((name) => ({ file: join(root, "tests/corpus", name), optimization: "release" })),
  ...corpus
    .filter((name) => programNumber(name) % 14 === 7)
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

// Small builds: one program in fifty, built cold and then again from the
// cache, as `scriptc build` runs on most edits.
const small = corpus.filter((name) => programNumber(name) % 50 === 3);
console.log(`training: ${small.length} small builds, cold and from the cache`);
await pool(
  small.map((name, index) => async () => {
    const cache = join(work, `cache-small-${index}`);
    const args = ["build", join(root, "tests/corpus", name), "-o", join(builds, `small-${index}`)];
    const options = { cwd: root, cache, profile: smallProfileFile };
    const ok = (await run(args, options)) && (await run(args, options));
    rmSync(cache, { recursive: true, force: true });
    rmSync(join(builds, `small-${index}`), { force: true });
    return ok;
  }),
);

const rawProfiles = readdirSync(raw).filter((name) => name.endsWith(".profraw"));
rmSync(builds, { recursive: true, force: true });
const indexed = join(work, "cli.profdata");
// The bundled helper merges, since only it takes weighted inputs.
const merged = spawnSync(
  join(cli, "lib/llvm/bin/scriptc-llvm-codegen"),
  [
    "merge-profiles",
    "--sparse",
    "--output",
    indexed,
    ...rawProfiles.flatMap((name) =>
      name.startsWith("small-")
        ? ["--weighted-input", `${SMALL_BUILD_WEIGHT},${join(raw, name)}`]
        : [join(raw, name)],
    ),
  ],
  { stdio: "inherit", env: { ...trainingEnv, LLVM_PROFILE_FILE: join(work, "merge.profraw") } },
);
if (merged.status !== 0) throw new Error("merge-profiles failed");
// The indexed profile compresses to about an eighth of its size.
const output = resolve(values.output);
writeFileSync(output, gzipSync(readFileSync(indexed), { level: constants.Z_BEST_COMPRESSION }));
console.log(
  `wrote ${output} (${statSync(output).size} bytes; ${statSync(indexed).size} uncompressed)`,
);
// A work directory the caller named stays for inspection.
if (values.work === undefined) rmSync(work, { recursive: true, force: true });
