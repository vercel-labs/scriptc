#!/usr/bin/env node
// Checks, before a release run spends hours building, what would otherwise
// stop it only after the builds: every published package at the CLI's
// version (the publish job's version check) and a release entry between the
// changelog's markers (the GitHub release job's body).
//
// usage: release-preflight.mjs [repository root]
//
// Prints one GitHub error annotation per problem and exits with 1 when there
// is any.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The package directories the publish job checks and uploads. */
export function publishedPackages(root) {
  const fixed = ["runtime", "compiler", "experimental", "node", "threads", "types", "cli"];
  const prefixed = readdirSync(join(root, "packages")).filter((name) =>
    /^(runtime|llvm|cli|libnode)-/.test(name),
  );
  return [...fixed, ...prefixed.sort()]
    .map((name) => join("packages", name))
    .filter((dir) => existsSync(join(root, dir, "package.json")))
    .filter(
      (dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).private !== true,
    );
}

/** The text between `<!-- release:start -->` and `<!-- release:end -->`. */
export function releaseNotes(changelog) {
  const start = changelog.indexOf("<!-- release:start -->");
  if (start === -1) return "";
  const end = changelog.indexOf("<!-- release:end -->", start);
  return changelog
    .slice(start + "<!-- release:start -->".length, end === -1 ? undefined : end)
    .trim();
}

export function preflight(root) {
  const problems = [];
  const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
  for (const dir of publishedPackages(root)) {
    const found = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).version;
    if (found !== version)
      problems.push(
        `${dir} is at ${found}, but packages/cli is at ${version}. Run 'node scripts/sync-versions.mjs' and commit.`,
      );
  }
  const notes = releaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
  if (notes.split("\n").length < 2)
    problems.push(
      "CHANGELOG.md has no release entry between <!-- release:start --> and <!-- release:end -->; the GitHub release needs it as its body (RELEASING.md, steps 3 to 5).",
    );
  return { version, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { version, problems } = preflight(process.argv[2] ?? process.cwd());
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) {
    console.log(`Release ${version} cannot publish: ${problems.length} problem(s) above.`);
    process.exit(1);
  }
  console.log(`Release ${version}: package versions and release notes are ready`);
}
