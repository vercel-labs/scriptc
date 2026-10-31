#!/usr/bin/env node
// Stamps the version from packages/cli/package.json into packages/runtime
// packages/compiler, runtime, and platform helper packages so every component
// participating in the helper protocol moves in lockstep.
// Usage: node scripts/sync-versions.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = (pkg) => `${root}packages/${pkg}/package.json`;
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

const version = read(manifest("cli")).version;
if (typeof version !== "string" || version.length === 0) {
  console.error("packages/cli/package.json has no version");
  process.exit(1);
}

for (const pkg of [
  "runtime",
  "runtime-darwin-arm64",
  "runtime-darwin-x64",
  "runtime-linux-x64-gnu",
  "runtime-linux-arm64-gnu",
  "runtime-linux-x64-musl",
  "runtime-linux-arm64-musl",
  "runtime-win32-x64-msvc",
  "runtime-wasm32-wasi",
  "runtime-ios-arm64",
  "runtime-ios-simulator-arm64",
  "runtime-android-arm64",
  "compiler",
  "experimental",
  "node",
  "threads",
  "types",
  "cli-darwin-arm64",
  "cli-darwin-x64",
  "cli-linux-x64-gnu",
  "cli-linux-arm64-gnu",
  "cli-linux-x64-musl",
  "cli-linux-arm64-musl",
  "cli-win32-x64-msvc",
  "llvm-darwin-arm64",
  "llvm-darwin-x64",
  "llvm-linux-x64-gnu",
  "llvm-linux-arm64-gnu",
  "llvm-linux-x64-musl",
  "llvm-linux-arm64-musl",
  "llvm-win32-x64-msvc",
  "libnode-linux-x64-gnu",
  "libnode-linux-arm64-gnu",
  "libnode-darwin-arm64",
  "libnode-darwin-x64",
]) {
  const path = manifest(pkg);
  const json = read(path);
  if (json.version === version) {
    console.log(`packages/${pkg}: already ${version}`);
    continue;
  }
  console.log(`packages/${pkg}: ${json.version} -> ${version}`);
  json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}
