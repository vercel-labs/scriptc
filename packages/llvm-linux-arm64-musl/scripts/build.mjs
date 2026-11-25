#!/usr/bin/env node
import { buildComptimeEvaluator } from "../../../native/llvm-codegen/comptime/build.mjs";
import { buildLinuxHelper } from "../../../native/llvm-codegen/linux-helper.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "linux" || process.arch !== "arm64") {
  process.stdout.write("@scriptc/llvm-linux-arm64-musl: skipped on this host\n");
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
buildLinuxHelper({
  arch: "arm64",
  libc: "musl",
  version: manifest.version,
  build: join(repo, "node_modules/.cache/scriptc-llvm-linux-arm64-musl"),
  output: join(root, "bin", "scriptc-llvm-codegen"),
});
// Static like the helper, so one executable serves glibc and musl hosts.
buildComptimeEvaluator({
  compiler: [process.env.CC ?? "clang", "-static"],
  platform: "linux",
  build: join(repo, "node_modules/.cache/scriptc-llvm-linux-arm64-musl-comptime"),
  output: join(root, "bin", "scriptc-comptime"),
});
