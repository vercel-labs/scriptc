#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url))); const repo = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "win32" || process.arch !== "x64") { process.stdout.write("@scriptc/llvm-win32-x64-msvc: skipped on this host\n"); process.exit(0); }
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); const build = join(repo, "node_modules/.cache/scriptc-llvm-win32-x64-msvc");
// LLVM's official Windows development archive contains MSVC-built static
// libraries. Use Visual Studio's generator, rather than inheriting a caller's
// clang/ninja defaults, so it selects the matching CRT, SDK, manifest tools,
// and current MSVC standard-library implementation.
execFileSync("cmake", ["-S", join(repo, "native/llvm-codegen"), "-B", build, "-G", "Visual Studio 17 2022", "-A", "x64", `-DLLVM_DIR=${process.env.LLVM_DIR ?? "C:/Program Files/LLVM/lib/cmake/llvm"}`, `-DSCRIPTC_PACKAGE_VERSION=${manifest.version}`, "-DSCRIPTC_DEFAULT_TARGET=x86_64-pc-windows-msvc", "-DSCRIPTC_DEFAULT_DATA_LAYOUT=e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128", "-DSCRIPTC_TARGET_BACKENDS=X86;WebAssembly", "-DSCRIPTC_ALLOWED_TARGETS=x86_64-pc-windows-msvc,wasm32-unknown-wasi"], { stdio: "inherit" });
execFileSync("cmake", ["--build", build, "--config", "Release", "--target", "scriptc-llvm-codegen"], { stdio: "inherit" }); mkdirSync(join(root, "bin"), { recursive: true }); copyFileSync(join(build, "Release", "scriptc-llvm-codegen.exe"), join(root, "bin", "scriptc-llvm-codegen.exe"));
