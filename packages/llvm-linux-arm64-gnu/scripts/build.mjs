#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url))); const repo = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "linux" || process.arch !== "arm64") { process.stdout.write("@scriptc/llvm-linux-arm64-gnu: skipped on this host\n"); process.exit(0); }
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); const build = join(repo, "node_modules/.cache/scriptc-llvm-linux-arm64-gnu");
execFileSync("cmake", ["-S", join(repo, "native/llvm-codegen"), "-B", build, "-G", "Ninja", `-DLLVM_DIR=${process.env.LLVM_DIR ?? "/usr/lib/llvm-22/lib/cmake/llvm"}`, `-DSCRIPTC_PACKAGE_VERSION=${manifest.version}`, "-DSCRIPTC_DEFAULT_TARGET=aarch64-unknown-linux-gnu", "-DSCRIPTC_DEFAULT_DATA_LAYOUT=e-m:e-p270:32:32-p271:32:32-p272:64:64-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128-Fn32", "-DSCRIPTC_TARGET_BACKENDS=AArch64;WebAssembly", "-DSCRIPTC_ALLOWED_TARGETS=aarch64-unknown-linux-gnu,aarch64-unknown-linux-musl,wasm32-unknown-wasi", "-DCMAKE_BUILD_TYPE=Release"], { stdio: "inherit" });
execFileSync("cmake", ["--build", build, "--target", "scriptc-llvm-codegen"], { stdio: "inherit" }); mkdirSync(join(root, "bin"), { recursive: true }); const output = join(root, "bin", "scriptc-llvm-codegen"); copyFileSync(join(build, "scriptc-llvm-codegen"), output); execFileSync("strip", [output], { stdio: "inherit" }); chmodSync(output, 0o755);
