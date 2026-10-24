/** Build the production CLI seed and its relocatable compiler assets. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { compile } from "../packages/compiler/src/index.js";
import { NATIVE_TARGETS, nativeCodegenTarget } from "../packages/compiler/src/backend/targets.js";
import { tsgoExecutable } from "../packages/compiler/src/frontend/ts7/rpc-api.js";
import { stageNativeCliAssets } from "./native-cli-assets.mjs";
import type { NativeToolchainManifest } from "../packages/compiler/src/native/toolchain.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, ".scriptc/native-cli"));
const optimization = process.env["SCRIPTC_NATIVE_OPTIMIZATION"] === "dev" ? "dev" : "release";
const sanitize = process.env["SCRIPTC_SAN"] === "1";
// SCRIPTC_NATIVE_PROFILE_GENERATE=<pattern> builds a compiler that writes a
// raw profile per run (scripts/refresh-cli-profile.mjs). Optimized builds
// otherwise use the committed profile, or the indexed profile that
// SCRIPTC_NATIVE_PROFILE_USE names; an empty SCRIPTC_NATIVE_PROFILE_USE
// builds without one.
const profileGenerate = process.env["SCRIPTC_NATIVE_PROFILE_GENERATE"] || undefined;
// Below this share of matching functions, the build warns that the profile
// has lost most of its gain. A profile refreshed on the same commit matched
// 92.7% of the native compiler's profiled functions, one refreshed 1.5 days
// and about 200 commits earlier 87.2%, and that one kept about half of the
// fresh profile's gain on a cold tsc-ts build.
const PROFILE_MATCH_WARNING = 0.9;
const committedProfile = join(root, "packages/compiler/native/cli.profdata.gz");
const requestedProfile = process.env["SCRIPTC_NATIVE_PROFILE_USE"];
const useProfile =
  profileGenerate === undefined &&
  optimization !== "dev" &&
  !sanitize &&
  requestedProfile !== "" &&
  (requestedProfile !== undefined || existsSync(committedProfile));
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
  profileUse = requestedProfile;
  if (profileUse === undefined) {
    profileUse = join(seed, "cli.profdata");
    writeFileSync(profileUse, gunzipSync(readFileSync(committedProfile)));
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
execFileSync(
  compiler,
  [
    ...compilerArgs,
    ...cFlags,
    "-O2",
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
const result = await compile(join(root, "packages/compiler/src/native/cli.ts"), {
  outDir: seed,
  outPath: executable,
  backend: "llvm",
  optimization,
  strip: process.env["SCRIPTC_NATIVE_KEEP_SYMBOLS"] !== "1",
  ffiProfilePath: ffi,
  sanitize,
  ...(profileGenerate === undefined ? {} : { profileGenerate }),
  ...(profileUse === undefined ? {} : { profileUse }),
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
console.log(executable);
