#!/usr/bin/env node
import { buildComptimeEvaluator } from "../../../native/llvm-codegen/comptime/build.mjs";
import { nativeTargetCmakeArgs } from "../../../native/llvm-codegen/targets.mjs";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmakeGeneratorArgs, cmakeReleaseOutput } from "./cmake-config.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "win32" || process.arch !== "x64") {
  process.stdout.write("@scriptc/llvm-win32-x64-msvc: skipped on this host\n");
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const build = join(repo, "node_modules/.cache/scriptc-llvm-win32-x64-msvc");
const output = cmakeReleaseOutput(build);
// LLVM's official Windows development archive contains MSVC-built static
// libraries. CMake's default selects the newest installed Visual Studio and
// therefore the matching CRT, SDK, manifest tools, and MSVC standard library.
// CMAKE_GENERATOR is an advanced override whose environment must provide an
// ABI-compatible Windows compiler and SDK when it selects a non-VS generator.
execFileSync(
  "cmake",
  [
    "-S",
    join(repo, "native/llvm-codegen"),
    "-B",
    build,
    ...cmakeGeneratorArgs(),
    ...output.configureArgs,
    `-DLLVM_DIR=${process.env.LLVM_DIR ?? "C:/Program Files/LLVM/lib/cmake/llvm"}`,
    `-DSCRIPTC_PACKAGE_VERSION=${manifest.version}`,
    "-DSCRIPTC_DEFAULT_TARGET=x86_64-pc-windows-msvc",
    "-DSCRIPTC_DEFAULT_DATA_LAYOUT=e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128",
    ...nativeTargetCmakeArgs,
  ],
  { stdio: "inherit" },
);
execFileSync(
  "cmake",
  ["--build", build, "--config", "Release", "--target", "scriptc-llvm-codegen"],
  { stdio: "inherit" },
);
mkdirSync(join(root, "bin"), { recursive: true });
copyFileSync(output.executable, join(root, "bin", "scriptc-llvm-codegen.exe"));
// The engine and the runtime's math port are written for clang, so the
// evaluator is built with Zig for its Windows GNU target, as the runtime pack
// and compiled programs are, not with the MSVC compiler that builds the helper.
buildComptimeEvaluator({
  compiler: ["zig", "cc", "-target", "x86_64-windows-gnu"],
  platform: "win32",
  build: join(repo, "node_modules/.cache/scriptc-llvm-win32-x64-msvc-comptime"),
  output: join(root, "bin", "scriptc-comptime.exe"),
});
