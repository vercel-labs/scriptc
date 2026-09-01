#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "darwin" || process.arch !== "x64") {
  process.stdout.write("@scriptc/llvm-darwin-x64: skipped on this host\n");
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const build = join(repo, "node_modules/.cache/scriptc-llvm-darwin-x64");
execFileSync("cmake", ["-S", join(repo, "native/llvm-codegen"), "-B", build, "-G", "Ninja", `-DLLVM_DIR=${process.env.LLVM_DIR ?? "/usr/local/opt/llvm@22/lib/cmake/llvm"}`, `-DSCRIPTC_PACKAGE_VERSION=${manifest.version}`, "-DSCRIPTC_HELPER_ARCH=x86_64", "-DSCRIPTC_DEFAULT_TARGET=x86_64-apple-macosx14.0.0", "-DSCRIPTC_DEFAULT_DATA_LAYOUT=e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128", "-DSCRIPTC_TARGET_BACKENDS=X86;WebAssembly", "-DSCRIPTC_ALLOWED_TARGETS=x86_64-apple-macosx14.0.0,wasm32-unknown-wasi", "-DCMAKE_BUILD_TYPE=Release"], { stdio: "inherit" });
execFileSync("cmake", ["--build", build, "--target", "scriptc-llvm-codegen"], { stdio: "inherit" });
mkdirSync(join(root, "bin"), { recursive: true });
const output = join(root, "bin", "scriptc-llvm-codegen");
copyFileSync(join(build, "scriptc-llvm-codegen"), output);
execFileSync("strip", ["-x", output], { stdio: "inherit" });
chmodSync(output, 0o755);
