#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url))); const repo = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "win32" || process.arch !== "x64") { process.stdout.write("@scriptc/llvm-win32-x64-msvc: skipped on this host\n"); process.exit(0); }
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); const build = join(repo, "node_modules/.cache/scriptc-llvm-win32-x64-msvc");
function resolveGenerator() {
  if (process.env.CMAKE_GENERATOR) return process.env.CMAKE_GENERATOR;
  const vswhereCandidates = [
    join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe"),
    join(process.env["ProgramFiles"] ?? "C:/Program Files", "Microsoft Visual Studio/Installer/vswhere.exe"),
  ];
  for (const vswhere of vswhereCandidates) {
    try {
      const ver = execFileSync(vswhere, ["-latest", "-products", "*", "-property", "installationVersion"], { encoding: "utf8" }).trim();
      const major = parseInt(ver, 10);
      if (major === 18) return "Visual Studio 18 2026";
      if (major === 17) return "Visual Studio 17 2022";
      if (major === 16) return "Visual Studio 16 2019";
    } catch {}
  }
  return "Visual Studio 17 2022";
}

// LLVM's official Windows development archive contains MSVC-built static
// libraries. Use Visual Studio's generator, rather than inheriting a caller's
// clang/ninja defaults, so it selects the matching CRT, SDK, manifest tools,
// and current MSVC standard-library implementation.
const generator = resolveGenerator();
const isMultiConfig = generator.startsWith("Visual Studio") || generator === "Ninja Multi-Config" || generator === "Xcode";
const cmakeArgs = [
  "-S", join(repo, "native/llvm-codegen"),
  "-B", build,
  "-G", generator,
  ...(generator.startsWith("Visual Studio") ? ["-A", "x64"] : []),
  ...(!isMultiConfig ? ["-DCMAKE_BUILD_TYPE=Release"] : []),
  `-DLLVM_DIR=${process.env.LLVM_DIR ?? "C:/Program Files/LLVM/lib/cmake/llvm"}`,
  `-DSCRIPTC_PACKAGE_VERSION=${manifest.version}`,
  "-DSCRIPTC_DEFAULT_TARGET=x86_64-pc-windows-msvc",
  "-DSCRIPTC_DEFAULT_DATA_LAYOUT=e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128",
  "-DSCRIPTC_TARGET_BACKENDS=X86;WebAssembly",
  "-DSCRIPTC_ALLOWED_TARGETS=x86_64-pc-windows-msvc,wasm32-unknown-wasi",
];
execFileSync("cmake", cmakeArgs, { stdio: "inherit" });
const buildArgs = ["--build", build, ...(isMultiConfig ? ["--config", "Release"] : []), "--target", "scriptc-llvm-codegen"];
execFileSync("cmake", buildArgs, { stdio: "inherit" });
const candidateOutputs = [
  join(build, "Release", "scriptc-llvm-codegen.exe"),
  join(build, "scriptc-llvm-codegen.exe"),
  join(build, "RelWithDebInfo", "scriptc-llvm-codegen.exe"),
];
const built = candidateOutputs.find(existsSync);
if (!built) throw new Error(`Could not find built scriptc-llvm-codegen.exe in ${build}`);
mkdirSync(join(root, "bin"), { recursive: true });
copyFileSync(built, join(root, "bin", "scriptc-llvm-codegen.exe"));
