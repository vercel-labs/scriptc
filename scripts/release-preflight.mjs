#!/usr/bin/env node
// Checks, before a release run spends hours building, what would otherwise
// stop it only after the builds: every published package at the CLI's
// version (the publish job's version check) and a release entry between the
// changelog's markers (the GitHub release job's body).
//
// usage: release-preflight.mjs [repository root] [--npm | --names]
//
// --npm also asks npm whether any package of the release is already published
// at its version. npm versions cannot be replaced, and a release never reuses
// one: a run that published part of a version and then failed is followed by
// a release of the next patch, never by a second run of the same version.
// (Re-running the failed jobs of the same run still finishes it: that run's
// check-release job does not run again.) 0.4.15 reused a version, and shipped
// CLIs beside runtime packs an earlier attempt had built (#4011).
//
// Prints one GitHub error annotation per problem and exits with 1 when there
// is any.
import { execFile } from "node:child_process";
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

/** The next patch version: 0.4.15 -> 0.4.16 (a prerelease suffix is dropped). */
export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`not a semver version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * What promoting `version` does to a package whose latest tag is `latest`: "move" it, leave it as "current",
 * or leave a "newer" release there (latest never moves back). A missing or malformed latest moves.
 */
export function promoteAction(latest, version) {
  if (latest === version) return "current";
  const parse = (value) =>
    /^(\d+)\.(\d+)\.(\d+)/
      .exec(value ?? "")
      ?.slice(1)
      .map(Number);
  const from = parse(latest);
  const to = parse(version);
  if (!to) throw new Error(`not a semver version: ${version}`);
  if (!from) return "move";
  for (let i = 0; i < 3; i++) if (from[i] !== to[i]) return from[i] > to[i] ? "newer" : "move";
  // The same release number with a prerelease suffix on one side: the release wins.
  return latest.includes("-") ? "move" : "newer";
}

/** Whether npm has name@version: `npm view` prints it, or fails with E404. Other failures throw. */
export function npmHas(name, version) {
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      ["view", `${name}@${version}`, "version", "--json"],
      (error, stdout, stderr) => {
        if (!error) resolve(stdout.trim() !== "");
        else if (/E404|404 Not Found/.test(`${stdout}${stderr}`)) resolve(false);
        else reject(new Error(`npm view ${name}@${version} failed: ${stderr || error.message}`));
      },
    );
  });
}

/** The problem when npm already has any package of the release at its version, else null. */
export async function npmPreflight(root, has = npmHas) {
  const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
  const names = publishedNames(root);
  const found = (
    await Promise.all(names.map(async (name) => ((await has(name, version)) ? name : null)))
  ).filter((name) => name !== null);
  if (found.length === 0) return null;
  return (
    `${found.length} of the ${names.length} packages of ${version} are already on npm (${found.join(", ")}). ` +
    `npm versions cannot be replaced, and a release never reuses one: release ${nextPatch(version)} instead ` +
    `(RELEASING.md, steps 1 to 5). If a run of ${version} is publishing right now, this run stops so it does not publish twice; ` +
    `a run of ${version} that stopped after publishing finishes only by re-running its own failed jobs.`
  );
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

/** The npm names of the release's packages, in publishedPackages order. */
export function publishedNames(root) {
  return publishedPackages(root).map(
    (dir) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).name,
  );
}

const main = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (main && process.argv.includes("--promote")) {
  // usage: release-preflight.mjs --promote <latest> <version> — prints move, current or newer (the promote job).
  const at = process.argv.indexOf("--promote");
  console.log(promoteAction(process.argv[at + 1], process.argv[at + 2]));
} else if (main && process.argv.includes("--names")) {
  // usage: release-preflight.mjs [root] --names — one package name per line (the promote job's list).
  const root = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.cwd();
  for (const name of publishedNames(root)) console.log(name);
} else if (main) {
  const root = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.cwd();
  const { version, problems } = preflight(root);
  if (process.argv.includes("--npm")) {
    const published = await npmPreflight(root);
    if (published !== null) problems.push(published);
  }
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) {
    console.log(`Release ${version} cannot publish: ${problems.length} problem(s) above.`);
    process.exit(1);
  }
  console.log(
    `Release ${version}: package versions and release notes are ready${process.argv.includes("--npm") ? ", and npm has none of its packages" : ""}`,
  );
}
