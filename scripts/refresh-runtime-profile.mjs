#!/usr/bin/env node
/* Refreshes packages/runtime-pack-common/profiles/linux-x64-gnu.profdata.gz,
 * the profile that the Linux x64 runtime pack's speed units are optimized
 * with (runtime-pack-common/scripts/build.mjs). The LLVM helper instruments,
 * annotates and optimizes those units, so the profile is in the helper's
 * format and merged by the helper's merge-profiles, like every program
 * profile.
 *
 * Builds an instrumented runtime pack (SCRIPTC_RUNTIME_PROFILE_GENERATE=1),
 * then runs the training programs built against it with --profile-generate:
 * every runtime benchmark workload at --optimization=speed (through
 * scripts/bench-runtime.mjs, with its inputs and load clients), and, with
 * --tsc-ts, an instrumented tsc-ts checking its own sources and each
 * --project. The raw profiles hold the runtime's counters beside the
 * programs'; the merged profile keeps the runtime functions that ran: the
 * instrumented pack lists its functions, and the programs' records are left
 * out. The pack is then rebuilt with the new profile. A stale profile only
 * loses part of its gain: functions whose code changed are optimized as
 * without one (the pack test reports how many).
 *
 *   node scripts/refresh-runtime-profile.mjs [--tsc-ts <checkout> [--project <dir>[:<tsconfig>]]...]
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { constants, gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    "tsc-ts": { type: "string" },
    project: { type: "string", multiple: true, default: [] },
    output: {
      type: "string",
      default: join(root, "packages/runtime-pack-common/profiles/linux-x64-gnu.profdata.gz"),
    },
    work: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/refresh-runtime-profile.mjs [--tsc-ts <checkout> [--project <dir>[:<tsconfig>]]...] [--output <profdata.gz>] [--work <dir>]",
  );
  process.exit(0);
}
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("the runtime profile is collected on Linux x64");
if (values.project.length !== 0 && values["tsc-ts"] === undefined)
  throw new Error("--project needs --tsc-ts");
const cli = join(root, "packages/cli/dist/main.js");
if (!existsSync(cli)) throw new Error("build the compiler first (pnpm build)");
const helper = join(root, "packages/llvm-linux-x64-gnu/bin/scriptc-llvm-codegen");
if (!existsSync(helper))
  throw new Error(
    "build the LLVM helper first (pnpm --filter @scriptc/llvm-linux-x64-gnu build:native)",
  );
const output = resolve(values.output);
mkdirSync(dirname(output), { recursive: true });
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), "scriptc-runtime-profile-")));
const raw = join(work, "raw");
rmSync(raw, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });
const env = { ...process.env };
delete env.SCRIPTC_LLVM_HELPER;

const buildPack = (extra) =>
  run("pnpm", ["--filter", "@scriptc/runtime-linux-x64-gnu", "build:native"], {
    cwd: root,
    env: { ...env, ...extra },
  });

const functions = join(work, "runtime-functions.txt");
console.log("building the instrumented runtime pack");
buildPack({ SCRIPTC_RUNTIME_PROFILE_GENERATE: "1", SCRIPTC_RUNTIME_PROFILE_FUNCTIONS: functions });
try {
  console.log("training on the runtime benchmark workloads");
  run(
    process.execPath,
    [
      join(root, "scripts/bench-runtime.mjs"),
      `--candidate=${root}`,
      "--candidate-optimization=speed",
      `--candidate-profile-generate=${join(raw, "bench-%m-%p.profraw")}`,
      "--runs=3",
      "--warmup=0",
      "--no-node",
      "--no-lock",
      `--json=${join(work, "bench.json")}`,
    ],
    { cwd: root, env },
  );
  if (values["tsc-ts"] !== undefined) trainTscTs(resolve(values["tsc-ts"]));
  const profiles = readdirSync(raw).map((name) => join(raw, name));
  if (profiles.length === 0) throw new Error(`no raw profiles in ${raw}`);
  // `scriptc merge-profiles` runs this merge too; called directly, it keeps
  // only the runtime's records, so the training programs' stay out of the repo.
  const merged = join(work, "runtime.profdata");
  run(
    helper,
    ["merge-profiles", "--output", merged, "--sparse", "--keep-functions", functions, ...profiles],
    { cwd: root, env },
  );
  writeFileSync(output, gzipSync(readFileSync(merged), { level: constants.Z_BEST_COMPRESSION }));
  console.log(`wrote ${output} from ${profiles.length} raw profiles`);
} finally {
  // The pack goes back to an ordinary build, now with the new profile.
  console.log("rebuilding the runtime pack");
  buildPack({});
}
if (values.work === undefined) rmSync(work, { recursive: true, force: true });

// An instrumented tsc-ts, built against the instrumented pack, checking its
// own sources and each --project at --checkers 1.
function trainTscTs(checkout) {
  const pkg = join(checkout, "packages/tsc-ts");
  if (!existsSync(join(pkg, "src/main.ts")))
    throw new Error(`${checkout} is not a tsc-ts checkout`);
  // The upstream lib files, where npm run fetch:upstream puts them (older
  // tsc-ts checkouts used the second directory).
  const lib = [
    "upstream/typescript-go/internal/bundled/libs",
    "upstream/TypeScript/tsc/internal/bundled/libs",
  ]
    .map((dir) => join(checkout, dir))
    .find((dir) => existsSync(join(dir, "lib.d.ts")));
  if (lib === undefined)
    throw new Error(
      `no lib files in ${checkout}/upstream: run npm run fetch:upstream in the tsc-ts checkout`,
    );
  const tsc = join(work, "tsc-ts");
  console.log("building an instrumented tsc-ts");
  run(
    process.execPath,
    [
      cli,
      "build",
      "src/main.ts",
      "--optimization=speed",
      "--detached-exit",
      `--profile-generate=${join(raw, "tsc-ts-%p.profraw")}`,
      "-o",
      tsc,
    ],
    { cwd: pkg, env },
  );
  const projects = [
    { dir: pkg, config: "tsconfig.json" },
    ...values.project.map((spec) => {
      const [dir, config = "tsconfig.json"] = spec.split(":");
      return { dir: resolve(dir), config };
    }),
  ];
  for (const { dir, config } of projects) {
    // Projects with type errors exit with 1 or 2; any other status is a failed run.
    const result = spawnSync(
      tsc,
      ["-p", config, "--noEmit", "--incremental", "false", "--checkers", "1"],
      {
        cwd: dir,
        stdio: "ignore",
        env: { ...env, TSC_TS_LIB_DIR: lib },
      },
    );
    if (result.status === null || result.status > 2)
      throw new Error(
        `the instrumented tsc-ts failed on ${join(dir, config)} (${result.signal ?? result.status})`,
      );
    console.log(`profiled ${join(dir, config)}`);
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}
