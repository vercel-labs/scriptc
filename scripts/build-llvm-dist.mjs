#!/usr/bin/env node
/* Builds the LLVM distribution the Linux release helpers link
 * (native/llvm-codegen/llvm-dist.mjs): LLVM_VERSION from its release source
 * tarball, with ThinLTO and native/llvm-codegen/llvm.profdata.gz, the
 * helper's targets, and static libraries only. clang and lld of the same
 * version must be on PATH (LLVM's release archive for the host has both).
 * Writes the install tree and, with --archive, a .tar.xz of it and its
 * .sha256. The llvm-dist workflow runs it for each Linux architecture; it
 * takes about 8 minutes on 32 cores and about an hour on 4.
 *
 * With --instrumented it builds the IR-instrumented libraries that
 * scripts/refresh-llvm-profile.mjs collects the profile with instead.
 *
 *   node scripts/build-llvm-dist.mjs --source <llvm-project-X.src> --prefix <dir>
 *     [--archive <file.tar.xz>] [--work <dir>] [--jobs N] [--instrumented]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { llvmCmakeArgs, writeLlvmProfile } from "../native/llvm-codegen/llvm-dist.mjs";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    prefix: { type: "string" },
    archive: { type: "string" },
    work: { type: "string" },
    jobs: { type: "string", default: String(cpus().length) },
    instrumented: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help || values.source === undefined || values.prefix === undefined) {
  console.log(
    "Usage: node scripts/build-llvm-dist.mjs --source <llvm-project source> --prefix <install dir> [--archive <file.tar.xz>] [--work <dir>] [--jobs N] [--instrumented]",
  );
  process.exit(values.help ? 0 : 2);
}
if (process.platform !== "linux") throw new Error("the LLVM distribution is built on Linux");
const source = resolve(values.source);
if (!existsSync(join(source, "llvm/CMakeLists.txt")))
  throw new Error(`${source} is not an llvm-project source tree`);
const prefix = resolve(values.prefix);
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), "scriptc-llvm-dist-")));
const build = join(work, values.instrumented ? "llvm-instrumented" : "llvm");
mkdirSync(build, { recursive: true });

function run(command, args, log, env = process.env) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 30, env });
  if (log !== undefined) writeFileSync(log, result.stdout + result.stderr);
  if (result.status !== 0) {
    process.stderr.write((result.stdout + result.stderr).slice(-8000));
    throw new Error(`${command} failed with status ${result.status}`);
  }
  return result.stdout + result.stderr;
}

const profile = values.instrumented ? undefined : writeLlvmProfile(work);
run("cmake", llvmCmakeArgs({ source, build, prefix, profile, instrumented: values.instrumented }));
const log = join(work, "build.log");
const output = run("ninja", ["-C", build, "-j", values.jobs, "install"], log);

if (profile !== undefined) {
  // clang reports, per file, how many of its functions the profile no longer
  // matches; on a host other than the one it was collected on, that count
  // shows how much of the profile still applies.
  let files = 0,
    functions = 0,
    mismatched = 0;
  for (const match of output.matchAll(/of (\d+) functions?, (\d+) ha(?:ve|s) mismatched data/g)) {
    files++;
    functions += Number(match[1]);
    mismatched += Number(match[2]);
  }
  console.log(
    files === 0
      ? "profile: no file reports functions with mismatched profile data"
      : `profile: ${mismatched} of ${functions} functions in ${files} files have mismatched profile data (build log ${log})`,
  );
}

if (values.archive !== undefined) {
  const archive = resolve(values.archive);
  mkdirSync(dirname(archive), { recursive: true });
  run("tar", ["-C", dirname(prefix), "-cJf", archive, basename(prefix)], undefined, {
    ...process.env,
    XZ_OPT: "-T0",
  });
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  console.log(`wrote ${archive} (${digest})`);
}
