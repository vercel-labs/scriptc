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
 * A pull request whose diff cannot be read is named in the output, and the
 * run exits 2 (unless it found a collision), since its claims are missing. */
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

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
      "number,title,headRefName,baseRefName",
    ])
  ).stdout,
);
const head = git("rev-parse", "--abbrev-ref", "HEAD").trim();
const here = `this branch (${head})`;

// A stack of pull requests (each based on the previous one's branch) is one
// claimant: a later PR's diff only shows what it adds to its base.
const byHead = new Map(prs.map((pr) => [pr.headRefName, pr]));
const stackOf = (pr) => {
  while (byHead.has(pr.baseRefName) && byHead.get(pr.baseRefName) !== pr)
    pr = byHead.get(pr.baseRefName);
  return pr.headRefName;
};
const stacks = new Map();
const claimant = (key) => stacks.get(key) ?? stacks.set(key, { names: [], claims: [] }).get(key);

const queue = [...prs];
// Pull requests whose diff could not be read: their claims are missing.
const unread = [];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let pr = queue.shift(); pr; pr = queue.shift()) {
      const diff = await run("gh", ["pr", "diff", String(pr.number)], { maxBuffer: 1 << 30 }).then(
        (r) => r.stdout,
        (error) => {
          const reason = String(error.stderr || error.message)
            .trim()
            .split("\n")[0];
          unread.push(`#${pr.number} (${reason})`);
          return null;
        },
      );
      const stack = claimant(stackOf(pr));
      stack.names.push({ number: pr.number, title: pr.title });
      if (diff !== null) stack.claims.push(...claimsOf(diff));
    }
  }),
);
// This branch is its own PR's claimant when it has one open.
const mine = claimant(byHead.has(head) ? stackOf(byHead.get(head)) : head);
mine.names.push({ number: Infinity, title: here });
// Committed and uncommitted changes since the branch left origin/main, and
// untracked files as wholly added.
const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
  .split("\0")
  .filter(Boolean);
mine.claims.push(
  ...claimsOf(git("diff", git("merge-base", "origin/main", "HEAD").trim())),
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
process.exitCode = check && collisions > 0 ? 1 : unread.length > 0 ? 2 : 0;
