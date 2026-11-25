/** Build the production CLI seed and its relocatable compiler assets. */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { compile } from "../packages/compiler/src/index.js";
import { NATIVE_TARGETS, nativeCodegenTarget } from "../packages/compiler/src/backend/targets.js";
import { tsgoExecutable } from "../packages/compiler/src/frontend/ts7/rpc-api.js";
import { PACK_VERIFIED_FILE } from "../packages/compiler/src/backend/runtime-pack-native.js";
import { prebuiltLibDiagnosticsText } from "../packages/compiler/src/frontend/ts7/lib-diagnostics.js";
import { REFRESH_COMMAND, judgeProfileMatch } from "./build-native-cli-profile.mjs";
import { stageNativeCliAssets } from "./native-cli-assets.mjs";
import type { NativeToolchainManifest } from "../packages/compiler/src/native/toolchain.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, ".scriptc/native-cli"));
// --platform-packages builds an npm platform package's distribution, which
// depends on the helper and runtime pack packages instead of bundling them.
const platformPackages = process.argv.includes("--platform-packages");
const optimization = process.env["SCRIPTC_NATIVE_OPTIMIZATION"] === "dev" ? "dev" : "release";
const sanitize = process.env["SCRIPTC_SAN"] === "1";
// SCRIPTC_NATIVE_PROFILE_GENERATE=<pattern> builds a compiler that writes a
// raw profile per run (scripts/refresh-cli-profile.mjs). With it, a
// SCRIPTC_NATIVE_PROFILE_USE profile optimizes the build too and the
// instrumentation runs after inlining: the second, context-sensitive phase
// of the profile. Optimized builds otherwise use the committed profile, or
// the indexed profile that SCRIPTC_NATIVE_PROFILE_USE names (gzip-compressed
// when the name ends in .gz, as refresh-cli-profile.mjs writes it); an empty
// SCRIPTC_NATIVE_PROFILE_USE builds without one. The block counts beside a
// profile (cli.blocks.gz beside cli.profdata.gz) annotate the functions
// whose control flow changed since the profile was collected.
const profileGenerate = process.env["SCRIPTC_NATIVE_PROFILE_GENERATE"] || undefined;
// SCRIPTC_NATIVE_PROFILE_CHECK=1 makes a build with the committed profile
// report the share of the profile's functions it matches and annotate the run
// page with it (scripts/build-native-cli-profile.mjs); CI sets it. The share
// does not fail the build. The check fails only when the profile cannot be
// judged: it is missing, cannot be read, or the build is laid out differently
// from the instrumented build that collected it.
const profileCheck = process.env["SCRIPTC_NATIVE_PROFILE_CHECK"] === "1";
const committedProfile = join(root, "packages/compiler/native/cli.profdata.gz");
const requestedProfile = process.env["SCRIPTC_NATIVE_PROFILE_USE"];
// The profile this build uses, and how its messages name it.
const profileInUse = requestedProfile ?? committedProfile;
const profileName =
  requestedProfile === undefined ? "packages/compiler/native/cli.profdata.gz" : requestedProfile;
function failProfileCheck(problem: string): never {
  console.error(`error: ${problem}`);
  process.exit(1);
}
if (profileCheck) {
  if (optimization === "dev" || sanitize)
    failProfileCheck(
      "the native compiler profile check needs an optimized build; unset SCRIPTC_SAN and SCRIPTC_NATIVE_OPTIMIZATION",
    );
  if (profileInUse === "")
    failProfileCheck(
      "the native compiler profile check needs a profile, and SCRIPTC_NATIVE_PROFILE_USE is empty",
    );
  if (!existsSync(profileInUse))
    failProfileCheck(
      `the native compiler profile ${profileName} is missing; collect it with \`${REFRESH_COMMAND} --context-sensitive\` on a Linux x64 host and commit it`,
    );
}
const useProfile =
  (profileGenerate === undefined || (requestedProfile !== undefined && requestedProfile !== "")) &&
  optimization !== "dev" &&
  !sanitize &&
  requestedProfile !== "" &&
  (requestedProfile !== undefined || existsSync(committedProfile));
// Builds lay out the compiler's functions with the committed layout
// (scripts/refresh-cli-layout.mjs), or the one SCRIPTC_NATIVE_LAYOUT names;
// an empty SCRIPTC_NATIVE_LAYOUT uses none. Instrumented builds use the same
// layout as the builds their profile is for. The layout decides which
// functions share a partition, and a function whose partition differs from
// the instrumented build's is optimized differently before its control flow
// is hashed, so the profile's record for it no longer matches.
const committedLayout = join(root, "packages/compiler/native/cli.layout.gz");
const requestedLayout = process.env["SCRIPTC_NATIVE_LAYOUT"];
const functionLayout =
  requestedLayout === ""
    ? undefined
    : (requestedLayout ?? (existsSync(committedLayout) ? committedLayout : undefined));
// Whether the build lays the compiler out with the committed layout file. The
// files are compared by their resolved paths, so another name for the same
// file, such as a relative one, still counts.
const committedLayoutInUse =
  functionLayout !== undefined &&
  existsSync(functionLayout) &&
  existsSync(committedLayout) &&
  realpathSync(functionLayout) === realpathSync(committedLayout);
// The profile describes the functions of builds laid out like the
// instrumented build that collected it. A check build with another layout
// could not report a comparable match, so it fails rather than reporting a
// lower one that a refresh would not raise.
if (profileCheck) {
  if (!existsSync(committedLayout))
    failProfileCheck(
      "the native compiler profile check needs packages/compiler/native/cli.layout.gz, which is missing; collect it with `node scripts/refresh-cli-layout.mjs` on a Linux x64 host and commit it",
    );
  if (!committedLayoutInUse)
    failProfileCheck(
      "the native compiler profile was collected with packages/compiler/native/cli.layout.gz, and this build lays the compiler out differently; a profile matches only builds laid out like the instrumented build",
    );
}
if (profileCheck && !useProfile)
  failProfileCheck(
    "the native compiler profile check needs a build that uses the profile; unset SCRIPTC_NATIVE_PROFILE_GENERATE",
  );
let target = nativeCodegenTarget();
if (target === null || target.platform === "wasi")
  throw new Error("a supported native host is required to build the compiler");
// Release executables use the runtime pack's libc baseline, even when the
// build host has a newer libc. Sanitizer builds use the host's sanitizer SDK,
// and instrumented builds the host compiler driver's profile runtime.
if (target.name.endsWith("-gnu") && !sanitize && profileGenerate === undefined) {
  const architecture = target.architecture === "x64" ? "x86_64" : "aarch64";
  process.env["SCRIPTC_TARGET"] = `${architecture}-linux-gnu.2.34`;
  target = nativeCodegenTarget()!;
}
const bin = join(output, "bin");
const lib = join(output, "lib");
const seed = join(dirname(output), ".scriptc", basename(output) + "-seed");
for (const dir of [bin, lib, seed]) mkdirSync(dir, { recursive: true });
let profileUse: string | undefined;
if (useProfile) {
  profileUse = profileInUse;
  if (profileUse.endsWith(".gz")) {
    const compressed = profileUse;
    profileUse = join(seed, "cli.profdata");
    // A check build that cannot read the profile fails with what it tried to
    // read; elsewhere the error stands as it is.
    try {
      writeFileSync(profileUse, gunzipSync(readFileSync(compressed)));
      // The compiler reads the block counts beside the profile it uses.
      const blocks = join(seed, "cli.blocks");
      const compressedBlocks = compressed.endsWith(".profdata.gz")
        ? `${compressed.slice(0, -".profdata.gz".length)}.blocks.gz`
        : `${compressed}.blocks.gz`;
      rmSync(blocks, { force: true });
      if (existsSync(compressedBlocks))
        writeFileSync(blocks, gunzipSync(readFileSync(compressedBlocks)));
    } catch (error) {
      if (profileCheck)
        failProfileCheck(
          `the native compiler profile ${profileName} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      throw error;
    }
  }
}
const compiler = process.env["SCRIPTC_CC"] ?? target.defaultLinker;
const compilerArgs = process.env["SCRIPTC_CC"] === undefined ? [...target.defaultLinkerArgs] : [];
// Zig's C debug mode otherwise inserts UBSan calls into these objects. They
// must also link through the destination host's ordinary compiler driver.
const cFlags = [
  "-std=c11",
  "-fno-sanitize=undefined",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-target",
  target.linkerTargetTriple,
];
const nativeSources = join(root, "packages/compiler/native");
const functions: unknown[] = [];
const libraries: string[] = [];
for (const name of ["ts7-process", "codegen-process", "host"]) {
  const object = join(seed, name + target.outputSuffixes.obj);
  execFileSync(
    compiler,
    [...compilerArgs, ...cFlags, "-c", join(nativeSources, name + ".c"), "-o", object],
    { stdio: "inherit" },
  );
  const manifest = JSON.parse(readFileSync(join(nativeSources, name + ".ffi.json"), "utf8")) as {
    functions: unknown[];
  };
  functions.push(...manifest.functions);
  libraries.push(object);
}
const ffi = join(seed, "compiler.ffi.json");
writeFileSync(ffi, JSON.stringify({ ffi_format: 6, functions, libraries }, null, 2) + "\n");
const executable = join(bin, "scriptc" + target.outputSuffixes.exe);
const strip = process.env["SCRIPTC_NATIVE_KEEP_SYMBOLS"] !== "1";
const result = await compile(join(root, "packages/compiler/src/native/cli.ts"), {
  outDir: seed,
  outPath: executable,
  backend: "llvm",
  optimization,
  strip,
  ffiProfilePath: ffi,
  sanitize,
  ...(profileGenerate === undefined ? {} : { profileGenerate }),
  ...(profileUse === undefined ? {} : { profileUse }),
  ...(functionLayout === undefined ? {} : { functionLayout }),
  // Most of the compiler's runs are short (an unchanged rebuild takes tens of
  // milliseconds), and a run maps every 2 MiB text window it touches whole. Text
  // on 4 KiB pages keeps an unchanged rebuild at about a third of the peak RSS,
  // and builds of tsc-ts take the same time. Executables the compiler builds
  // keep huge text.
  hugeText: false,
  emitIr: process.env["SCRIPTC_NATIVE_EMIT_IR"] === "1",
});
if (!result.ok)
  throw new Error(
    result.diagnostics
      .map(
        (item) =>
          `${item.loc ? `${item.loc.file}:${item.loc.start}: ` : ""}${item.code}: ${item.message}`,
      )
      .join("\n"),
  );
// How well the profile still describes the compiler. The profile matches
// builds laid out like the instrumented build; a build with another layout
// (the bootstrap seed uses none) matches fewer functions however fresh the
// profile is, so its summary is printed without a warning.
const match = useProfile && "artifact" in result ? result.artifact.profileMatch : undefined;
if (match !== undefined) {
  const verdict = judgeProfileMatch(match, { layoutMatchesProfile: committedLayoutInUse });
  console.log(verdict.summary);
  // The profile lane annotates the run page with the match, so a stale
  // profile is visible without opening the log. The share is reported, not
  // enforced.
  const annotate = profileCheck && process.env["GITHUB_ACTIONS"] === "true";
  if (annotate) console.log(`::notice title=native compiler profile::${verdict.summary}`);
  if (verdict.warning !== undefined) {
    console.warn(`warning: ${verdict.warning}`);
    if (annotate) console.log(`::warning title=native compiler profile::${verdict.warning}`);
  }
}
const compilerVersion = (
  JSON.parse(readFileSync(join(root, "packages/compiler/package.json"), "utf8")) as {
    version: string;
  }
).version;
const assets = stageNativeCliAssets({
  repository: root,
  output,
  target,
  ts7: tsgoExecutable(),
  compilerVersion,
  strip,
  platformPackages,
});
// A cross-libc seed may use Zig on the build host. The installed compiler
// selects the destination platform's ordinary linker and SDK.
const installedTarget = NATIVE_TARGETS.find((item) => item.name === target.name)!;
const manifest: NativeToolchainManifest = {
  schema: "scriptc.native-toolchain.v1",
  compiler_version: compilerVersion,
  target: target.name,
  ...assets,
  linker: process.env["SCRIPTC_LINKER"] ?? installedTarget.defaultLinker,
  linker_args:
    process.env["SCRIPTC_LINKER"] === undefined ? [...installedTarget.defaultLinkerArgs] : [],
  dsymutil: process.env["SCRIPTC_DSYMUTIL"] ?? "dsymutil",
};
writeFileSync(executable + ".json", JSON.stringify(manifest, null, 2) + "\n");
// The prebuilt lib diagnostics (frontend/ts7/lib-diagnostics.ts): the
// declaration file sets the distribution's tsc-ts reports no diagnostics in
// for programs without a tsconfig, recorded by the built compiler itself. A
// compiler this host cannot run ships without them.
const prebuiltKeys = recordPrebuiltLibDiagnostics(executable);
// The probes' builds record the bundled runtime pack's verified artifacts
// beside it, by this host's file identities; the distribution ships without
// that record.
rmSync(join(lib, target.runtimePackPackage.replace("@scriptc/", ""), PACK_VERIFIED_FILE), {
  force: true,
});
if (prebuiltKeys === null) {
  console.warn(
    "warning: the built compiler did not run here; it ships without prebuilt lib diagnostics",
  );
} else {
  const prebuilt = join(lib, "declarations", "lib-diagnostics.json");
  const checker = (
    JSON.parse(readFileSync(join(lib, "tsc-ts", "package.json"), "utf8")) as { version: string }
  ).version;
  writeFileSync(prebuilt, prebuiltLibDiagnosticsText(checker, prebuiltKeys));
  manifest.lib_diagnostics = relative(bin, prebuilt);
  writeFileSync(executable + ".json", JSON.stringify(manifest, null, 2) + "\n");
}
console.log(executable);

/** The content keys the built compiler records building, each in an empty
 * cache, a module without imports (the program it lowers) and a module with
 * a type error (which also checks the program without scriptc's overrides);
 * null when it cannot run. */
function recordPrebuiltLibDiagnostics(compiler: string): string[] | null {
  const work = mkdtempSync(join(tmpdir(), "scriptc-lib-diagnostics-"));
  try {
    const record = join(work, "keys.txt");
    const probes = [
      { name: "clean", source: "export {};\n", status: 0 },
      { name: "error", source: 'export const n: number = "x";\n', status: 1 },
    ];
    for (const probe of probes) {
      const dir = join(work, probe.name);
      mkdirSync(dir);
      writeFileSync(join(dir, "main.ts"), probe.source);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        SCRIPTC_CACHE_DIR: join(dir, "cache"),
        SCRIPTC_LIB_DIAGNOSTICS_RECORD: record,
      };
      delete env["SCRIPTC_TIMING"];
      const run = spawnSync(
        compiler,
        ["build", join(dir, "main.ts"), "--optimization", "dev", "-o", join(dir, "main")],
        { cwd: dir, env, encoding: "utf8" },
      );
      if (run.status !== probe.status) return null;
    }
    if (!existsSync(record)) return null;
    return readFileSync(record, "utf8")
      .split("\n")
      .filter((key) => key !== "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
