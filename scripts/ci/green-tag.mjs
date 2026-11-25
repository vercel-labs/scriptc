#!/usr/bin/env node
// Moves an integration branch's green tag to the commit of a passing post-merge run (.github/workflows/ci.yml,
// green_tag): green-main on main, green-canary on canary.
//
// The tag names the newest commit on its branch whose full post-merge verification passed: the commit a release,
// a nightly baseline or a pre-warmed sandbox image may cut from. The tag is the only ref this writes; it never
// touches a branch. The workflow grants the job `contents: write` for that one tag and the token is GitHub
// Actions' own GITHUB_TOKEN.
//
// usage: node scripts/ci/green-tag.mjs <commit-sha> --branch <main|canary> [--dry-run]
// environment: GITHUB_REPOSITORY (owner/repo), GH_TOKEN (set by the workflow's token)
import { execFileSync } from "node:child_process";

/** The branches whose post-merge runs keep a green tag. */
export const GREEN_TAG_BRANCHES = ["main", "canary"];

/** The tag an integration branch's post-merge run moves: green-main on main, green-canary on canary. */
export function greenTag(branch) {
  if (typeof branch !== "string" || !GREEN_TAG_BRANCHES.includes(branch))
    throw new Error(`no green tag for branch ${JSON.stringify(branch)}`);
  return `green-${branch}`;
}

/** The API names a tag by the path below "refs/". */
export const tagPath = (tag) => `tags/${tag}`;
/** The API creates a tag by its full ref. */
export const tagRef = (tag) => `refs/${tagPath(tag)}`;

/**
 * What moving the tag from `currentSha` to `nextSha` takes: create it, move it forward, leave it, or stale when
 * the tag already names a newer commit. `ancestor` says `nextSha` descends from `currentSha`; a rerun of an older
 * push passes an older commit and must never drag the tag back.
 */
export function tagAction(currentSha, nextSha, { ancestor = false } = {}) {
  if (typeof nextSha !== "string" || !/^[0-9a-f]{40}$/.test(nextSha))
    throw new Error(`the green tag needs a full commit sha, got ${JSON.stringify(nextSha)}`);
  if (currentSha === nextSha) return "unchanged";
  if (typeof currentSha !== "string" || currentSha.length === 0) return "create";
  return ancestor ? "update" : "stale";
}

/** The REST request that performs `action` for `sha` in `repo`: one tag ref, and nothing else. */
export function tagRequest(action, repo, sha, tag) {
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`invalid repository ${JSON.stringify(repo)}`);
  if (action === "create")
    return {
      method: "POST",
      path: `repos/${repo}/git/refs`,
      fields: { ref: tagRef(tag), sha },
    };
  if (action === "update")
    return {
      method: "PATCH",
      path: `repos/${repo}/git/refs/${tagPath(tag)}`,
      // `force` is a boolean in the API's request body; `gh api -F` sends it as one.
      fields: { sha, force: true },
    };
  throw new Error(`nothing to request for ${action}`);
}

/** The `gh api` arguments for a request: strings with `-f`, booleans and numbers with `-F`. */
export function ghArgs({ method, path, fields }) {
  const args = ["api", "--method", method, path];
  for (const [name, value] of Object.entries(fields))
    args.push(
      typeof value === "boolean" || typeof value === "number" ? "-F" : "-f",
      `${name}=${value}`,
    );
  return args;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Whether `ancestor` is an ancestor of `descendant` in the repository at `cwd`. */
export function isAncestor(ancestor, descendant, cwd = process.cwd()) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
    return true;
  } catch (error) {
    // 1 is "not an ancestor"; anything else is a missing object or a broken repository.
    if (error.status === 1) return false;
    throw error;
  }
}

/** Makes sure the commit is present locally: a rerun's checkout may not reach the tag's commit. */
function ensureCommit(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    git(["fetch", "--no-tags", "--quiet", "origin", sha]);
  }
}

/** The commit the tag names now, or undefined when it does not exist yet. */
export function currentTagSha(repo, tag) {
  try {
    const ref = JSON.parse(gh(["api", `repos/${repo}/git/ref/${tagPath(tag)}`]));
    return ref?.object?.sha;
  } catch (error) {
    const text = `${error.stderr ?? ""}${error.message ?? ""}`;
    // A 404 is the first run: the tag is created below. Any other failure is real.
    if (/HTTP 404|Not Found/.test(text)) return undefined;
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const branchOption = args.indexOf("--branch");
  const branch = branchOption >= 0 ? args[branchOption + 1] : undefined;
  const [sha] = args.filter(
    (arg, index) => !arg.startsWith("--") && (branchOption < 0 || index !== branchOption + 1),
  );
  const tag = greenTag(branch);
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  // Reading the tag is read-only; a dry run still reports whether it would create or update.
  const current = currentTagSha(repo, tag);
  let ancestor = false;
  if (typeof current === "string" && current.length > 0 && current !== sha) {
    ensureCommit(current);
    ancestor = isAncestor(current, sha);
  }
  const action = tagAction(current, sha, { ancestor });
  if (action === "unchanged") {
    console.log(`${tag} already names ${sha}`);
    return;
  }
  if (action === "stale") {
    console.log(
      `::notice::${tag} already names a newer passing commit (${current}); leaving it rather than moving ` +
        `it back to ${sha}`,
    );
    return;
  }
  const request = tagRequest(action, repo, sha, tag);
  if (dryRun) {
    console.log(`${request.method} ${request.path} ${JSON.stringify(request.fields)}`);
    return;
  }
  gh([...ghArgs(request), "--silent"]);
  console.log(`${tag} now names ${sha} (${action})`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
