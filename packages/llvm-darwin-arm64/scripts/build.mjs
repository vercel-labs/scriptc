#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "darwin" || process.arch !== "arm64") {
  process.stdout.write("@scriptc/llvm-darwin-arm64: skipped on this host\n");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const buildDir = join(repoRoot, "node_modules/.cache/scriptc-llvm-darwin-arm64");
const llvmDir = process.env.LLVM_DIR ?? "/opt/homebrew/opt/llvm@22/lib/cmake/llvm";
execFileSync("cmake", [
  "-S", join(repoRoot, "native/llvm-codegen"),
  "-B", buildDir,
  "-G", "Ninja",
  `-DLLVM_DIR=${llvmDir}`,
  `-DSCRIPTC_PACKAGE_VERSION=${manifest.version}`,
  "-DSCRIPTC_TARGET_BACKENDS=AArch64;WebAssembly",
  "-DSCRIPTC_ALLOWED_TARGETS=arm64-apple-macosx14.0.0,wasm32-unknown-wasi",
  "-DCMAKE_BUILD_TYPE=Release",
], { stdio: "inherit" });
execFileSync("cmake", ["--build", buildDir, "--target", "scriptc-llvm-codegen"], {
  stdio: "inherit",
});

const binDir = join(packageRoot, "bin");
mkdirSync(binDir, { recursive: true });
const output = join(binDir, "scriptc-llvm-codegen");
copyFileSync(join(buildDir, "scriptc-llvm-codegen"), output);
execFileSync("strip", ["-x", output], { stdio: "inherit" });
chmodSync(output, 0o755);
const version = JSON.parse(execFileSync(output, ["version", "--format=json"], {
  encoding: "utf8",
}));
if (
  version.protocol_version !== "1" ||
  version.scriptc_package_version !== manifest.version ||
  version.llvm_version !== "22.1.8" ||
  !Array.isArray(version.supported_targets) ||
  !version.supported_targets.includes("arm64-apple-macosx14.0.0")
) {
  throw new Error(`built helper reported an incompatible identity: ${JSON.stringify(version)}`);
}
