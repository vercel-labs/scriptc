#!/usr/bin/env node
/* Lists the numbers that open pull requests claim in the repository's
 * numbered registries, and reports the ones two changes claim differently:
 *
 *   diagnostic codes   a code an added line names that origin/main has no
 *                      row for in packages/compiler/src/diagnostics/codes.ts
 *   dyn handle tags    an added pinned row X(NAME, value) in
 *                      packages/runtime/src/scr_dyn.h
 *
 * The current branch (its changes since it left origin/main) counts as one
 * more claimant. Run it before picking a number, or before pushing a change
 * that takes one; it needs `gh` access to the repository.
 *
 *   node scripts/registry-claims.mjs           every claim and every collision
 *   node scripts/registry-claims.mjs --check   only collisions with this branch;
 *                                              exits 1 when there is one
 *
 * A pull request whose diff cannot be read is named in the output. Without
 * --check the run exits 2 (unless it found a collision), since its claims are
 * missing; --check still fails only on a collision with this branch, so a
 * large unrelated PR cannot redden the mandatory gate. GitHub's 300-file diff
 * limit is worked around with the pull request files API. */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { branchKey, stackHead } from "./registry-stacks.mjs";

const run = promisify(execFile);
const check = process.argv.includes("--check");
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });

const CODES = "packages/compiler/src/diagnostics/codes.ts";
const DYN = "packages/runtime/src/scr_dyn.h";

git("fetch", "-q", "origin", "main");
// The codes origin/main has: its active and retired rows (a reserved code is
// still a claim), or, before codes.ts existed there, every code its sources name.
const baseCodes = new Map();
const codesSource = (() => {
  try {
    return git("show", `origin/main:${CODES}`);
  } catch {
    return null;
  }
})();
if (codesSource !== null) {
  const reserved = codesSource.indexOf("export const RESERVED_DIAGNOSTIC_CODES");
  for (const m of codesSource.matchAll(/^ {2}(SC\d{4}): "([^"]*)"/gm)) {
    if (reserved < 0 || m.index < reserved) baseCodes.set(m[1], m[2]);
  }
} else {
  const named = git("grep", "-ohE", "SC[0-9]{4}", "origin/main", "--", "packages/*/src/**");
  for (const code of named.split("\n").filter(Boolean)) baseCodes.set(code, "");
}
const baseTags = new Map(
  [...git("show", `origin/main:${DYN}`).matchAll(/^\s*X\(([A-Z0-9_]+), (\d+)\)/gm)].map(
    ([, name, value]) => [Number(value), name],
  ),
);

/** The claims of one unified diff: [registry, number, label] triples. */
function claimsOf(diff) {
  const claims = [];
  let file = "";
  let table = ""; // the codes.ts table the current line is in
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      continue;
    }
    const section = /^(?:@@.*@@ |[ +])export const (\w+)/.exec(line);
    if (section) table = section[1];
    if (!line.startsWith("+")) continue;
    // A reserved row holds a code for other work; it is not this change's claim.
    if (file === CODES && table === "RESERVED_DIAGNOSTIC_CODES") continue;
    if (file === DYN) {
      const tag = /^\+\s*X\(([A-Z0-9_]+), (\d+)\)/.exec(line);
      if (tag) claims.push(["dyn handle tag", Number(tag[2]), tag[1]]);
    }
    if (!file.startsWith("packages/")) continue;
    const row = file === CODES ? /^\+ {2}(SC\d{4}): "([^"]*)"/.exec(line) : null;
    if (row) {
      if (baseCodes.get(row[1]) !== row[2]) claims.push(["diagnostic code", row[1], row[2]]);
      continue;
    }
    for (const [code] of line.matchAll(/\bSC\d{4}\b/g)) {
      if (!baseCodes.has(code))
        claims.push(["diagnostic code", code, `${file}: ${line.slice(1).trim()}`]);
    }
  }
  return claims;
}

const prs = JSON.parse(
  (
    await run("gh", [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "300",
      "--json",
      "number,title,headRefName,baseRefName,headRepository",
    ])
  ).stdout,
);
const head = git("rev-parse", "--abbrev-ref", "HEAD").trim();
const here = `this branch (${head})`;

// A stack of pull requests (each based on the previous one's branch) is one
// claimant: a later PR's diff only shows what it adds to its base. A branch
// key pairs the repository with the branch, and the walk is bounded and
// cycle-aware (scripts/registry-stacks.mjs): a fork contributor's branch
// named like a same-repository branch cannot join the two stacks, and a
// branch graph with a cycle terminates instead of hanging this gate.
const repository = (() => {
  if (process.env["GITHUB_REPOSITORY"]) return process.env["GITHUB_REPOSITORY"];
  try {
    const url = git("remote", "get-url", "origin").trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? "";
  } catch {
    return "";
  }
})();
const localPr = {
  number: Infinity,
  headRefName: head,
  baseRefName: "main",
  headRepository: { nameWithOwner: repository },
};
const byHead = new Map(prs.map((pr) => [branchKey(pr, "head", repository), pr]));
const stackOf = (pr) => stackHead(prs, pr, repository).key;
const stacks = new Map();
const claimant = (key) => stacks.get(key) ?? stacks.set(key, { names: [], claims: [] }).get(key);

const queue = [...prs];
// Pull requests whose diff could not be read: their claims are missing.
const unread = [];

/** A pull request's unified diff. GitHub refuses to render a diff over 300
 * files (HTTP 406), and the mandatory gate must not fail on unrelated large
 * PRs; the files API has no such cap, so rebuild the added lines claimsOf
 * reads from each file's patch. Returns null when neither source answers. */
async function diffOf(pr) {
  try {
    return (await run("gh", ["pr", "diff", String(pr.number)], { maxBuffer: 1 << 30 })).stdout;
  } catch (error) {
    const reason = String(error.stderr || error.message)
      .trim()
      .split("\n")[0];
    if (!/exceeded the maximum number of files/.test(reason)) {
      unread.push(`#${pr.number} (${reason})`);
      return null;
    }
    try {
      const listed = await run(
        "gh",
        [
          "api",
          `repos/${repository}/pulls/${pr.number}/files`,
          "--paginate",
          "--jq",
          ".[] | {filename, patch}",
        ],
        { maxBuffer: 1 << 30 },
      );
      let diff = "";
      for (const line of listed.stdout.split("\n")) {
        if (line.trim() === "") continue;
        const file = JSON.parse(line);
        diff += `+++ b/${file.filename}\n`;
        for (const patchLine of String(file.patch ?? "").split("\n")) {
          // Hunk headers carry the `export const ...` section context that
          // tells a reserved codes.ts row from this change's claim.
          if (patchLine.startsWith("+") || patchLine.startsWith("@@")) diff += `${patchLine}\n`;
        }
      }
      return diff;
    } catch (filesError) {
      const filesReason = String(filesError.stderr || filesError.message)
        .trim()
        .split("\n")[0];
      unread.push(`#${pr.number} (${reason}; ${filesReason})`);
      return null;
    }
  }
}

await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let pr = queue.shift(); pr; pr = queue.shift()) {
      const diff = await diffOf(pr);
      const stack = claimant(stackOf(pr));
      stack.names.push({ number: pr.number, title: pr.title });
      if (diff !== null) stack.claims.push(...claimsOf(diff));
    }
  }),
);
// This branch is its own PR's claimant when it has one open.
const myPr = byHead.get(branchKey(localPr, "head", repository));
const mine = claimant(myPr === undefined ? branchKey(localPr, "head", repository) : stackOf(myPr));
mine.names.push({ number: Infinity, title: here });
// Committed and uncommitted changes since the branch left origin/main, and
// untracked files as wholly added. A merge queue group's synthetic head has
// no history of its own in the shallow checkout; the pull request it came
// from already ran this check, so the merge-group run compares the head with
// itself instead of failing to find a merge base.
const branchBase = (() => {
  try {
    return git("merge-base", "origin/main", "HEAD").trim();
  } catch (error) {
    if (process.env["GITHUB_EVENT_NAME"] === "merge_group") return "HEAD";
    throw error;
  }
})();
const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
  .split("\0")
  .filter(Boolean);
mine.claims.push(
  ...claimsOf(git("diff", branchBase)),
  ...untracked
    .map((file) => claimsOf(`+++ b/${file}\n` + readFileSync(file, "utf8").replace(/^/gm, "+")))
    .flat(),
);
// A stack reads "#1 #2 #3: <the first PR's title>".
const sources = [...stacks.values()].map(({ names, claims }) => {
  names.sort((a, b) => a.number - b.number);
  const prs = names.filter((n) => n.number !== Infinity).map((n) => `#${n.number}`);
  const title = names[0].title;
  const name = prs.length === 0 ? title : `${prs.join(" ")}: ${title}`;
  return {
    name: names.some((n) => n.title === here) && prs.length > 0 ? `${name} (${here})` : name,
    claims,
  };
});

// registry → number → label → claimants. Each claimant labels a number once:
// with the codes.ts row that claims it when it adds one, otherwise with the
// first line that names it.
const table = new Map();
for (const { name, claims } of sources) {
  const labelOf = new Map();
  for (const [registry, number, label] of claims) {
    const key = `${registry}\0${number}`;
    const row = registry === "dyn handle tag" || !label.includes(": ");
    if (!labelOf.has(key) || (row && !labelOf.get(key).row))
      labelOf.set(key, { registry, number, label, row });
  }
  for (const { registry, number, label } of labelOf.values()) {
    const numbers = table.get(registry) ?? table.set(registry, new Map()).get(registry);
    const labels = numbers.get(number) ?? numbers.set(number, new Map()).get(number);
    (labels.get(label) ?? labels.set(label, []).get(label)).push(name);
  }
}

let collisions = 0;
for (const [registry, numbers] of [...table].sort()) {
  for (const [number, labels] of [...numbers].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const onMain = registry === "dyn handle tag" ? baseTags.get(number) : undefined;
    const clash = labels.size > 1 || (onMain !== undefined && !labels.has(onMain));
    const ours = [...labels.values()].some((who) => who.some((name) => name.includes(here)));
    if (check && !(clash && ours)) continue;
    if (clash) collisions++;
    console.log(`${clash ? "COLLISION" : "claimed"}  ${registry} ${number}`);
    if (onMain !== undefined && !labels.has(onMain)) console.log(`    origin/main: ${onMain}`);
    for (const [label, who] of labels) console.log(`    ${label}\n      ${who.join("\n      ")}`);
  }
}
if (unread.length > 0) {
  console.log(
    `could not read the diff of ${unread.length} pull request${unread.length === 1 ? "" : "s"}; ${unread.length === 1 ? "its" : "their"} claims are missing:`,
  );
  for (const pr of unread.sort()) console.log(`    ${pr}`);
}
if (collisions === 0)
  console.log(
    `${check ? "no collisions with this branch" : "no collisions"}${unread.length > 0 ? " among the diffs read" : ""}`,
  );
// In --check the missing claims are a warning, not a failure: an open PR
// whose diff neither source could read must not turn the mandatory gate red
// on unrelated PRs and main pushes. The full report still exits 2 so a local
// run is never silently incomplete.
process.exitCode = check && collisions > 0 ? 1 : !check && unread.length > 0 ? 2 : 0;
