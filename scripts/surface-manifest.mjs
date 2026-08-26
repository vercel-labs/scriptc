#!/usr/bin/env tsx
// Generates packages/compiler/surface-manifest.json — the machine-readable
// manifest of the language and stdlib surface the static tier compiles at
// this release, with stable per-entry ids so tooling can diff two releases
// mechanically. The schema and the projection sources are documented in
// packages/compiler/src/coverage/surface-manifest.ts; this script owns the
// version spine and the file lifecycle.
//
// The version spine: compilerVersion is the EXACT published release version
// — the version release.yml keys on (packages/cli/package.json, the
// `scriptc` package) — so an external version pin matches the manifest's
// string verbatim. All four published workspace packages must agree (the same check
// the release workflow runs); a drifted tree fails generation instead of
// stamping an ambiguous version.
//
// Usage:
//   pnpm manifest             regenerate packages/compiler/surface-manifest.json
//   pnpm manifest --check     verify the committed file matches a fresh
//                             generation (exit 1 on drift) without writing
//
// Runs under tsx (it imports the compiler's TypeScript sources directly, no
// build step) — `pnpm manifest` wires that up.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateSurfaceManifest, renderSurfaceManifest } from "../packages/compiler/src/coverage/surface-manifest.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(root + path, "utf8"));

const version = readJson("packages/cli/package.json").version;
for (const pkg of ["runtime", "compiler"]) {
  const v = readJson(`packages/${pkg}/package.json`).version;
  if (v !== version) {
    console.error(
      `version mismatch: packages/${pkg} is ${v}, packages/cli is ${version} — run 'node scripts/sync-versions.mjs' first`,
    );
    process.exit(1);
  }
}

const outPath = root + "packages/compiler/surface-manifest.json";
const manifest = generateSurfaceManifest(version);
const rendered = renderSurfaceManifest(manifest);

const counts = new Map();
for (const e of manifest.entries) {
  const key = `${e.kind}/${e.status}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

if (process.argv.includes("--check")) {
  let committed = null;
  try {
    committed = readFileSync(outPath, "utf8");
  } catch {
    // fall through to the drift report
  }
  if (committed !== rendered) {
    console.error("surface-manifest.json is stale — run 'pnpm manifest' and commit the result");
    process.exit(1);
  }
  console.log(`surface-manifest.json is current (${manifest.entries.length} entries, version ${version})`);
} else {
  writeFileSync(outPath, rendered);
  console.log(`wrote packages/compiler/surface-manifest.json (version ${version}, ${manifest.entries.length} entries)`);
  for (const [key, n] of [...counts].sort()) console.log(`  ${key}: ${n}`);
}
