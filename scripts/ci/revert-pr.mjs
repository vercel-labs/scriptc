#!/usr/bin/env node
// Opens a revert pull request for a confirmed culprit (.github/workflows/bisect-main.yml). It pushes a new branch
// and opens a pull request into main; it never pushes main and never force-pushes anything.
//
// usage: node scripts/ci/revert-pr.mjs --culprit <sha> --subject <text> --green <sha> --red <sha>
//                                       --specs specs.json [--dry-run]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The `git revert` arguments for a commit: a merge commit needs its mainline parent, the first one. */
export function revertArguments(sha, parentCount = 1) {
  return parentCount > 1 ? ["revert", "--no-edit", "-m", "1", sha] : ["revert", "--no-edit", sha];
}

/** The branch the revert is pushed to: one per culprit, so a retried run finds the same one. */
export function revertBranch(sha) {
  return `ci/revert-${sha.slice(0, 9)}`;
}

/** The pull request title: a revert of the culprit's subject. */
export function revertTitle(sha, subject) {
  return `Revert "${subject}" (${sha.slice(0, 9)})`;
}

/** The short body: the failing test, and the green and red commits that bracket the culprit. */
export function revertBody({ sha, subject, green, red, specs }) {
  const tests = specs.map(
    (spec) => `- \`${spec.file}\`${spec.fullName ? ` > ${spec.fullName}` : ""}`,
  );
  return [
    `Reverts ${sha.slice(0, 9)} (${subject}).`,
    "",
    `The post-merge run on \`${red.slice(0, 9)}\` failed a test that passes on \`${green.slice(0, 9)}\`, and the` +
      ` culprit search confirmed \`${sha.slice(0, 9)}\` as the first failing commit.`,
    "",
    "Failing test:",
    ...tests,
    "",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dryRun = args.includes("--dry-run");
  const culprit = option("--culprit");
  const green = option("--green");
  const red = option("--red");
  const subject = option("--subject") ?? "the culprit commit";
  const specs = JSON.parse(readFileSync(option("--specs"), "utf8"));
  const branch = revertBranch(culprit);
  const title = revertTitle(culprit, subject);
  const body = revertBody({ sha: culprit, subject, green, red, specs });
  const run = (command, argv) => {
    if (dryRun) console.log(`${command} ${argv.join(" ")}`);
    else execFileSync(command, argv, { encoding: "utf8", stdio: "inherit" });
  };
  // A merge commit needs its mainline parent; without it git refuses to revert.
  const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", culprit], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)
    .slice(1);
  // The revert lands on top of the red commit, on a branch of its own. A conflict leaves the branch unpushed.
  run("git", ["checkout", "-B", branch, red]);
  try {
    run("git", revertArguments(culprit, parents.length));
  } catch {
    console.log(
      "::error::The revert conflicts with newer commits; open an issue instead of pushing.",
    );
    process.exitCode = 3;
    return;
  }
  run("git", ["push", "origin", branch]);
  const bodyFile = join(tmpdir(), `${branch.replaceAll("/", "-")}.md`);
  writeFileSync(bodyFile, body);
  run("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    title,
    "--body-file",
    bodyFile,
  ]);
  if (!dryRun) console.log(`Opened the revert pull request for ${culprit}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
