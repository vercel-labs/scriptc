#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { allOrderEntries } from "./ts7-order-fixtures.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const baseline = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/compiler/test/ts7/baselines/order-parity.json"), "utf8"),
);
const missingBaselines = allOrderEntries(repoRoot)
  .map((path) => relative(repoRoot, path).replaceAll("\\", "/"))
  .filter((path) => !Object.hasOwn(baseline.entries, `<repo>/${path}`));
if (missingBaselines.length > 0) {
  console.error(`Missing TypeScript preflight/order baselines:\n${missingBaselines.join("\n")}`);
  console.error(
    "Record the new fixtures with SCRIPTC_UPDATE_BASELINES=1 pnpm exec vitest run packages/compiler/test/ts7/order-parity.test.ts, review the diff, then run the affected parity batches before opening a PR.",
  );
  process.exit(1);
}
if (process.argv.includes("--baselines-only")) {
  console.log("Every TypeScript preflight/order fixture has a recorded baseline.");
  process.exit(0);
}

const ALLOWED_TYPESCRIPT5_IMPORTS = new Set([
  "packages/compiler/src/frontend/comptime-node.ts",
  "packages/compiler/src/frontend/ts7/world-check.ts",
  "packages/compiler/src/frontend/ts7/source-parser.test.ts",
  "packages/compiler/src/library/semantic-source.ts",
  "packages/compiler/test/ts7/harness.ts",
  "packages/compiler/test/ts7/resolver-parity.test.ts",
]);

function sourceFilesUnder(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

const importPattern = /(?:from\s+|import\s*\()\s*["']typescript5["']/;
const actualImports = new Set(
  [
    ...sourceFilesUnder(resolve(repoRoot, "packages/compiler/src")),
    ...sourceFilesUnder(resolve(repoRoot, "packages/compiler/test")),
  ]
    .filter((path) => importPattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(repoRoot, path).replaceAll("\\", "/")),
);

const missing = [...ALLOWED_TYPESCRIPT5_IMPORTS].filter((path) => !actualImports.has(path));
const unexpected = [...actualImports].filter((path) => !ALLOWED_TYPESCRIPT5_IMPORTS.has(path));
if (missing.length > 0 || unexpected.length > 0) {
  if (missing.length > 0)
    console.error(`Stale TypeScript 5 island allowlist entries:\n${missing.join("\n")}`);
  if (unexpected.length > 0)
    console.error(`Unexpected TypeScript 5 imports:\n${unexpected.join("\n")}`);
  process.exit(1);
}

const compilerPackage = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/compiler/package.json"), "utf8"),
);
if (compilerPackage.scripts?.build !== "node node_modules/typescript/bin/tsc -p tsconfig.json") {
  console.error("@scriptc/compiler must build with the TypeScript 7 toolchain");
  process.exit(1);
}

const vitest = resolve(repoRoot, "node_modules/vitest/vitest.mjs");
const schema = spawnSync(
  process.execPath,
  [resolve(repoRoot, "scripts/generate-ts7-ast-schema.mjs"), "--check"],
  { cwd: repoRoot, stdio: "inherit" },
);
if (schema.error || schema.status !== 0) process.exit(1);
const result = spawnSync(process.execPath, [vitest, "run", "packages/compiler/test/ts7"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, SCRIPTC_TS7_ALL: "1" },
});

if (result.error !== undefined) {
  console.error(result.error.message);
  process.exitCode = 1;
} else if (result.signal !== null) {
  console.error(`TypeScript 7 parity sweep terminated by ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
