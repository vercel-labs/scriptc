#!/usr/bin/env node
/* Refreshes native/llvm-codegen/llvm.profdata.gz, the profile the release
 * LLVM distribution and the Linux helpers' own sources are optimized with
 * (native/llvm-codegen/llvm-dist.mjs). The profile follows LLVM's sources
 * and the kind of code scriptc emits rather than scriptc's commits, so it
 * needs a refresh when LLVM is bumped, or when the emitted code changes
 * enough that the distribution check (scripts/check-llvm-dist.mjs) loses
 * much of its gain.
 *
 * Builds LLVM with IR instrumentation (scripts/build-llvm-dist.mjs
 * --instrumented) and an instrumented helper against it, then runs that
 * helper on the training inputs (scripts/llvm-helper-inputs.mjs): tsc-ts,
 * five Effect fixtures, the runtime benchmark workloads and every 50th
 * corpus program. The merged profile is written gzip-compressed. Needs a
 * built checkout on Linux x64, clang, lld and llvm-profdata of LLVM_VERSION
 * on PATH, and the LLVM release sources. About 20 minutes on 32 cores.
 *
 *   node scripts/refresh-llvm-profile.mjs --source <llvm-project-X.src>
 *     --tsc-ts <tsc-ts checkout> [--work <dir>] [--jobs N] [--output <profdata.gz>]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { constants, gzipSync } from "node:zlib";
import { llvmProfile } from "../native/llvm-codegen/llvm-dist.mjs";
import { buildLinuxHelper } from "../native/llvm-codegen/linux-helper.mjs";
import { captureHelperInputs, helperInputPrograms } from "./llvm-helper-inputs.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "tsc-ts": { type: "string" },
    work: { type: "string" },
    jobs: { type: "string", default: String(cpus().length) },
    output: { type: "string", default: llvmProfile },
    help: { type: "boolean", default: false },
  },
});
if (values.help || values.source === undefined || values["tsc-ts"] === undefined) {
  console.log(
    "Usage: node scripts/refresh-llvm-profile.mjs --source <llvm-project source> --tsc-ts <tsc-ts checkout> [--work <dir>] [--jobs N] [--output <profdata.gz>]",
  );
  process.exit(values.help ? 0 : 2);
}
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("the LLVM profile is collected on Linux x64");
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), "scriptc-llvm-profile-")));
const prefix = join(work, "llvm-instrumented-install");
const helper = join(work, "helper", "scriptc-llvm-codegen");
const raw = join(work, "raw");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} failed with status ${result.status}`);
}

console.log(`building the instrumented LLVM in ${work}`);
run(process.execPath, [
  join(root, "scripts/build-llvm-dist.mjs"),
  "--instrumented",
  "--source",
  resolve(values.source),
  "--prefix",
  prefix,
  "--work",
  work,
  "--jobs",
  values.jobs,
]);
const manifest = JSON.parse(
  readFileSync(join(root, "packages/llvm-linux-x64-gnu/package.json"), "utf8"),
);
process.env.LLVM_DIR = join(prefix, "lib/cmake/llvm");
process.env.SCRIPTC_LLVM_PROFILE_GENERATE = "1";
delete process.env.SCRIPTC_LLVM_THINLTO;
buildLinuxHelper({
  arch: "x64",
  libc: "gnu",
  version: manifest.version,
  build: join(work, "helper-build"),
  output: helper,
});

const inputs = await captureHelperInputs(
  helperInputPrograms({ tscTs: resolve(values["tsc-ts"]) }),
  join(work, "inputs"),
);
rmSync(raw, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });
const out = join(work, "objects");
for (const input of inputs) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const result = spawnSync(helper, input.args(out), {
    env: { ...process.env, LLVM_PROFILE_FILE: join(raw, "helper-%p.profraw") },
    encoding: "utf8",
  });
  console.log(`${input.name}: ${input.partitions} partitions, status ${result.status}`);
  if (result.status !== 0) throw new Error(`${input.name}: ${result.stdout}${result.stderr}`);
}

const merged = join(work, "llvm.profdata");
run("llvm-profdata", ["merge", "-o", merged, ...readdirSync(raw).map((file) => join(raw, file))]);
const output = resolve(values.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, gzipSync(readFileSync(merged), { level: constants.Z_BEST_COMPRESSION }));
console.log(`wrote ${output} from ${inputs.length} inputs`);
