#!/usr/bin/env node
// Usage: node scripts/verify-npm-published.mjs <local.tgz> <name@version | published.tgz>
//
// npm versions are immutable: when the release's upload of name@version is
// refused because the version already exists, the release may count it as
// published only if npm holds this release's payload. 0.4.15 did not check:
// an earlier, failed release attempt had published every runtime and LLVM
// helper package at 0.4.15 from an older commit (runtime ABI v48), the next
// run's uploads were refused, and the release shipped CLIs built for ABI v51
// beside them, so every 0.4.15 install rejected its runtime pack (#4011).
//
// This compares the two tarballs' files (path, contents and executable bit,
// not timestamps) and exits 1, naming the differences, when they differ.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Each file of a package tarball: its path under package/ -> "<sha256> <x|->". */
export function tarballFiles(tarball) {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-verify-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", dir]);
    const files = new Map();
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
          const executable = (statSync(full).mode & 0o111) !== 0 ? "x" : "-";
          // npm tarballs keep their files under one top directory, "package"
          // for packed packages; compare the paths below it.
          const name = relative(dir, full).split(/[\\/]/).slice(1).join("/");
          files.set(name, `${digest} ${executable}`);
        }
      }
    };
    walk(dir);
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The paths whose presence, contents or executable bit differ, sorted. */
export function payloadDifferences(local, published) {
  const differences = [];
  for (const path of new Set([...local.keys(), ...published.keys()]))
    if (local.get(path) !== published.get(path))
      differences.push(
        !published.has(path)
          ? `${path}: only in this release`
          : !local.has(path)
            ? `${path}: only on npm`
            : `${path}: differs`,
      );
  return differences.sort();
}

function publishedTarball(spec, dir) {
  if (spec.endsWith(".tgz")) return spec;
  const [{ filename }] = JSON.parse(
    execFileSync("npm", ["pack", spec, "--json", "--pack-destination", dir], {
      encoding: "utf8",
    }),
  );
  return join(dir, filename);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [local, spec] = process.argv.slice(2);
  if (!local || !spec) {
    console.error("usage: verify-npm-published.mjs <local.tgz> <name@version | published.tgz>");
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-published-"));
  try {
    const differences = payloadDifferences(
      tarballFiles(local),
      tarballFiles(publishedTarball(spec, dir)),
    );
    if (differences.length === 0) {
      console.log(`${spec} on npm holds this release's payload`);
    } else {
      console.error(
        `${spec} on npm was published from other contents, and npm versions cannot be replaced. ` +
          `Release a new version instead. Differences (${differences.length}):`,
      );
      for (const line of differences.slice(0, 50)) console.error(`  ${line}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
