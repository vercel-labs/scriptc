/** Build the production CLI seed and its relocatable compiler assets. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { compile } from "../packages/compiler/src/index.js";
import {
  NATIVE_TARGETS,
  executableStripLinkerArgs,
  nativeCodegenTarget,
} from "../packages/compiler/src/backend/targets.js";
import { tsgoExecutable } from "../packages/compiler/src/frontend/ts7/rpc-api.js";
import { prebuiltLibDiagnosticsText } from "../packages/compiler/src/frontend/ts7/lib-diagnostics.js";
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
// SCRIPTC_NATIVE_PROFILE_USE builds without one.
const profileGenerate = process.env["SCRIPTC_NATIVE_PROFILE_GENERATE"] || undefined;
// Below this share of matching functions, the build warns that the profile
// has lost most of its gain. A profile refreshed on the same commit, with
// the same layout, matches all of the native compiler's profiled functions.
// One refreshed 1.5 days and about 200 commits earlier matched 87.2%, and
// kept about half of the fresh profile's gain on a cold tsc-ts build.
const PROFILE_MATCH_WARNING = 0.9;
const committedProfile = join(root, "packages/compiler/native/cli.profdata.gz");
const requestedProfile = process.env["SCRIPTC_NATIVE_PROFILE_USE"];
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
  profileUse = requestedProfile ?? committedProfile;
  if (profileUse.endsWith(".gz")) {
    const compressed = profileUse;
    profileUse = join(seed, "cli.profdata");
    writeFileSync(profileUse, gunzipSync(readFileSync(compressed)));
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
for (const name of ["ts7-process", "host"]) {
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
const comptime = join(lib, "scriptc-comptime" + target.outputSuffixes.exe);
const strip = process.env["SCRIPTC_NATIVE_KEEP_SYMBOLS"] !== "1";
execFileSync(
  compiler,
  [
    ...compilerArgs,
    ...cFlags,
    "-O2",
    ...(strip ? ["-g0", ...executableStripLinkerArgs(target.platform, true)] : []),
    "-I",
    join(root, "packages/runtime/vendor/quickjs-ng"),
    join(nativeSources, "comptime.c"),
    join(
      root,
      "packages",
      target.runtimePackPackage.replace("@scriptc/", ""),
      "artifacts/vendor/quickjs/libscriptc-quickjs.a",
    ),
    "-lm",
    "-lpthread",
    "-o",
    comptime,
  ],
  { stdio: "inherit" },
);
// The Windows link writes the debug database beside the executable.
if (strip && target.platform === "win32")
  rmSync(comptime.replace(/\.exe$/, ".pdb"), { force: true });
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
// How well the profile still describes the compiler: a function whose
// control flow changed since the profile was collected is optimized as
// without one. The share falls as compiler code changes, and with it the
// profile's gain (refresh it with scripts/refresh-cli-profile.mjs).
const match = useProfile && "artifact" in result ? result.artifact.profileMatch : undefined;
if (match !== undefined) {
  const profiled = match.annotated + match.mismatched;
  const share = profiled === 0 ? 0 : match.annotated / profiled;
  console.log(
    `native compiler profile: ${match.annotated} of ${profiled} profiled functions match (${(100 * share).toFixed(1)}%); ${match.missing} functions have no profile` +
      (match.unknownPartitions > 0
        ? `; ${match.unknownPartitions} partitions reused without counts`
        : ""),
  );
  if (match.unknownPartitions === 0 && share < PROFILE_MATCH_WARNING)
    console.warn(
      `warning: the native compiler profile matches ${(100 * share).toFixed(1)}% of the functions it describes; run scripts/refresh-cli-profile.mjs`,
    );
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
  comptime: relative(bin, comptime),
};
writeFileSync(executable + ".json", JSON.stringify(manifest, null, 2) + "\n");
// The prebuilt lib diagnostics (frontend/ts7/lib-diagnostics.ts): the
// declaration file sets the distribution's tsc-ts reports no diagnostics in
// for programs without a tsconfig, recorded by the built compiler itself. A
// compiler this host cannot run ships without them.
const prebuiltKeys = recordPrebuiltLibDiagnostics(executable);
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
