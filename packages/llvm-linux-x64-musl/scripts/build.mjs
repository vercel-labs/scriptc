#!/usr/bin/env node
import { buildLinuxHelper } from "../../../native/llvm-codegen/linux-helper.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
if (process.platform !== "linux" || process.arch !== "x64") {
  process.stdout.write("@scriptc/llvm-linux-x64-musl: skipped on this host\n");
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
buildLinuxHelper({
  arch: "x64",
  libc: "musl",
  version: manifest.version,
  build: join(repo, "node_modules/.cache/scriptc-llvm-linux-x64-musl"),
  output: join(root, "bin", "scriptc-llvm-codegen"),
});
