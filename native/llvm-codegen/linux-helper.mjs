/* The static Linux helper build shared by the four Linux helper packages,
 * scripts/refresh-llvm-profile.mjs and scripts/check-llvm-dist.mjs. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { helperLlvmDistArgs } from "./llvm-dist.mjs";
import { nativeTargetCmakeArgs } from "./targets.mjs";

const DATA_LAYOUTS = {
  x64: "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128",
  arm64:
    "e-m:e-p270:32:32-p271:32:32-p272:64:64-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128-Fn32",
};

/** Configures and builds the helper for `arch` (`x64` or `arm64`) and `libc`
 * (`gnu` or `musl`) in `build` against LLVM_DIR, and writes the stripped
 * executable to `output`. musl builds take the compilers from CC and CXX. */
export function buildLinuxHelper({ arch, libc, version, build, output }) {
  const triple = `${arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-${libc}`;
  // CMake drops the other definitions when a reconfigure changes the
  // compiler, so a build directory configured for another LLVM or build
  // kind starts over.
  const kind = JSON.stringify({
    llvm: process.env.LLVM_DIR ?? null,
    thinLTO: process.env.SCRIPTC_LLVM_THINLTO === "1",
    profileGenerate: process.env.SCRIPTC_LLVM_PROFILE_GENERATE === "1",
    cc: process.env.CC ?? null,
    cxx: process.env.CXX ?? null,
  });
  const stamp = join(build, "scriptc-helper-build.json");
  if (existsSync(build) && (!existsSync(stamp) || readFileSync(stamp, "utf8") !== kind))
    rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  writeFileSync(stamp, kind);
  execFileSync(
    "cmake",
    [
      "-S",
      fileURLToPath(new URL(".", import.meta.url)),
      "-B",
      build,
      "-G",
      "Ninja",
      ...(libc === "musl"
        ? [
            `-DCMAKE_C_COMPILER=${process.env.CC ?? "cc"}`,
            `-DCMAKE_CXX_COMPILER=${process.env.CXX ?? "c++"}`,
          ]
        : []),
      `-DLLVM_DIR=${process.env.LLVM_DIR ?? "/usr/lib/llvm-22/lib/cmake/llvm"}`,
      `-DSCRIPTC_PACKAGE_VERSION=${version}`,
      `-DSCRIPTC_DEFAULT_TARGET=${triple}`,
      `-DSCRIPTC_DEFAULT_DATA_LAYOUT=${DATA_LAYOUTS[arch]}`,
      ...nativeTargetCmakeArgs,
      "-DSCRIPTC_STATIC_LINUX_BUILD=ON",
      "-DCMAKE_EXE_LINKER_FLAGS=-static",
      "-DCMAKE_BUILD_TYPE=Release",
      // Later definitions win, so these can select clang for musl builds.
      ...helperLlvmDistArgs(build),
    ],
    { stdio: "inherit" },
  );
  execFileSync("cmake", ["--build", build, "--target", "scriptc-llvm-codegen"], {
    stdio: "inherit",
  });
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(join(build, "scriptc-llvm-codegen"), output);
  execFileSync("strip", [output], { stdio: "inherit" });
  chmodSync(output, 0o755);
}
