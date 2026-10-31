/* The LLVM distribution the Linux helpers link in releases: LLVM built from
 * the release sources with ThinLTO and with a profile of the helper's own
 * code generation (llvm.profdata.gz). scripts/build-llvm-dist.mjs builds it,
 * the llvm-dist workflow attaches it to the LLVM_DIST_TAG release of this
 * repository, and scripts/refresh-llvm-profile.mjs collects the profile. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const LLVM_VERSION = "22.1.8";
/** The release of this repository that holds the distribution archives. A
 * new profile or LLVM version gets a new tag. */
export const LLVM_DIST_TAG = "llvm-22.1.8-pgo.1";
export const llvmProfile = fileURLToPath(new URL("./llvm.profdata.gz", import.meta.url));

/** The archive name for a Linux architecture (`x64` or `arm64`). */
export function llvmDistAsset(arch) {
  return `scriptc-llvm-${LLVM_VERSION}-linux-${arch}.tar.xz`;
}

/** Writes the uncompressed profile into `dir` and returns its path. */
export function writeLlvmProfile(dir, profile = llvmProfile) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "llvm.profdata");
  writeFileSync(path, gunzipSync(readFileSync(profile)));
  return path;
}

/** CMake arguments for an LLVM build with the helper's targets, static,
 * without tools or tests. `profile` builds with that indexed profile and
 * ThinLTO; `instrumented` builds the IR-instrumented libraries the profile
 * is collected with. clang and lld come from PATH and must be LLVM_VERSION,
 * since the profile's format and hashes follow the compiler. */
export function llvmCmakeArgs({ source, build, prefix, profile, instrumented }) {
  const version = execFileSync("clang", ["--version"], { encoding: "utf8" });
  if (!version.includes(`clang version ${LLVM_VERSION}`))
    throw new Error(`the LLVM distribution is built with clang ${LLVM_VERSION}; found ${version}`);
  return [
    "-S",
    join(source, "llvm"),
    "-B",
    build,
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    "-DCMAKE_C_COMPILER=clang",
    "-DCMAKE_CXX_COMPILER=clang++",
    "-DLLVM_USE_LINKER=lld",
    "-DLLVM_TARGETS_TO_BUILD=X86;AArch64;WebAssembly",
    "-DLLVM_ENABLE_PROJECTS=",
    "-DLLVM_ENABLE_ASSERTIONS=OFF",
    "-DLLVM_ENABLE_ZLIB=FORCE_ON",
    "-DLLVM_ENABLE_ZSTD=FORCE_ON",
    "-DLLVM_USE_STATIC_ZSTD=ON",
    "-DLLVM_ENABLE_TERMINFO=OFF",
    "-DLLVM_ENABLE_LIBXML2=OFF",
    "-DLLVM_ENABLE_LIBEDIT=OFF",
    "-DLLVM_ENABLE_LIBPFM=OFF",
    "-DLLVM_INCLUDE_TESTS=OFF",
    "-DLLVM_INCLUDE_EXAMPLES=OFF",
    "-DLLVM_INCLUDE_BENCHMARKS=OFF",
    "-DLLVM_INCLUDE_DOCS=OFF",
    "-DLLVM_BUILD_TOOLS=OFF",
    ...(instrumented ? ["-DLLVM_BUILD_INSTRUMENTED=IR", "-DLLVM_BUILD_RUNTIME=OFF"] : []),
    ...(profile ? ["-DLLVM_ENABLE_LTO=Thin", `-DLLVM_PROFDATA_FILE=${profile}`] : []),
  ];
}

/** Extra CMake arguments for a Linux helper package build. With
 * SCRIPTC_LLVM_THINLTO=1, LLVM_DIR names a distribution from
 * scripts/build-llvm-dist.mjs: its archives hold ThinLTO bitcode, so the
 * helper compiles and links with clang, lld and ThinLTO, and its own sources
 * use the same profile. SCRIPTC_LLVM_PROFILE_GENERATE=1 instruments the
 * helper's sources against an instrumented LLVM. */
export function helperLlvmDistArgs(build) {
  const args = [];
  if (process.env.SCRIPTC_LLVM_THINLTO === "1")
    args.push(
      "-DCMAKE_C_COMPILER=clang",
      "-DCMAKE_CXX_COMPILER=clang++",
      "-DSCRIPTC_LLVM_THINLTO=ON",
      `-DSCRIPTC_LLVM_PROFILE_USE=${writeLlvmProfile(build)}`,
    );
  else args.push("-DSCRIPTC_LLVM_THINLTO=OFF", "-DSCRIPTC_LLVM_PROFILE_USE=");
  if (process.env.SCRIPTC_LLVM_PROFILE_GENERATE === "1")
    args.push(
      "-DCMAKE_C_COMPILER=clang",
      "-DCMAKE_CXX_COMPILER=clang++",
      "-DSCRIPTC_LLVM_PROFILE_GENERATE=ON",
    );
  else args.push("-DSCRIPTC_LLVM_PROFILE_GENERATE=OFF");
  return args;
}
