#!/usr/bin/env node
// Moves the green-main tag to the commit of a passing post-merge run (.github/workflows/ci.yml, green_main).
//
// green-main names the newest commit on main whose full post-merge verification passed: the commit a release, a
// nightly baseline or a pre-warmed sandbox image may cut from. The tag is the only ref this writes; it never
// touches a branch, and in particular never main. The workflow grants the job `contents: write` for that one tag
// and the token is GitHub Actions' own GITHUB_TOKEN.
//
// usage: node scripts/ci/green-main.mjs <commit-sha> [--dry-run]
// environment: GITHUB_REPOSITORY (owner/repo), GH_TOKEN (set by the workflow's token)
import { execFileSync } from "node:child_process";

export const GREEN_MAIN_TAG = "green-main";
// The API names a tag by the path below "refs/", and creates one by its full ref.
export const TAG_PATH = `tags/${GREEN_MAIN_TAG}`;
export const TAG_REF = `refs/${TAG_PATH}`;

/** What moving the tag from `currentSha` to `nextSha` takes: create it, update it, or leave it alone. */
export function tagAction(currentSha, nextSha) {
  if (typeof nextSha !== "string" || !/^[0-9a-f]{40}$/.test(nextSha))
    throw new Error(`green-main needs a full commit sha, got ${JSON.stringify(nextSha)}`);
  if (currentSha === nextSha) return "unchanged";
  return typeof currentSha === "string" && currentSha.length > 0 ? "update" : "create";
}

/** The REST request that performs `action` for `sha` in `repo`: a tag ref, and nothing else. */
export function tagRequest(action, repo, sha) {
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`invalid repository ${JSON.stringify(repo)}`);
  if (action === "create")
    return {
      method: "POST",
      path: `repos/${repo}/git/refs`,
      fields: { ref: TAG_REF, sha },
    };
  if (action === "update")
    return {
      method: "PATCH",
      path: `repos/${repo}/git/refs/${TAG_PATH}`,
      fields: { sha, force: "true" },
    };
  throw new Error(`nothing to request for ${action}`);
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The commit the tag names now, or undefined when it does not exist yet. */
export function currentTagSha(repo) {
  try {
    const ref = JSON.parse(gh(["api", `repos/${repo}/git/ref/${TAG_PATH}`]));
    return ref?.object?.sha;
  } catch (error) {
    const text = `${error.stderr ?? ""}${error.message ?? ""}`;
    // A 404 is the first run: the tag is created below. Any other failure is real.
    if (/HTTP 404|Not Found/.test(text)) return undefined;
    throw error;
  }
}

function main() {
  const [sha] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const dryRun = process.argv.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  // Reading the tag is read-only; a dry run still reports whether it would create or update.
  const action = tagAction(currentTagSha(repo), sha);
  if (action === "unchanged") {
    console.log(`green-main already names ${sha}`);
    return;
  }
  const request = tagRequest(action, repo, sha);
  if (dryRun) {
    console.log(`${request.method} ${request.path} ${JSON.stringify(request.fields)}`);
    return;
  }
  const args = ["api", "--method", request.method, request.path];
  for (const [name, value] of Object.entries(request.fields)) args.push("-f", `${name}=${value}`);
  gh([...args, "--silent"]);
  console.log(`green-main now names ${sha} (${action})`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
