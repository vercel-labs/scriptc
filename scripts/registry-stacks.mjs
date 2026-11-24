#!/usr/bin/env node
/* Branch-stack keys for scripts/registry-claims.mjs.
 *
 * A stack of pull requests (each based on the previous one's branch) is one
 * claimant: a later PR's diff only shows what it adds to its base. Branch
 * names are not unique across repositories — a fork contributor can open a
 * PR whose head branch is named like a same-repository PR's — so a branch key
 * pairs the repository with the branch. A head carries its own repository
 * (`headRepository` in `gh pr list --json`); a base always lives in the
 * repository the PR list belongs to, which the caller passes.
 *
 * A branch graph can also contain a cycle (naming a branch after another open
 * PR's base). The walk tracks visited PR numbers and caps its depth, so a
 * cycle terminates and names a member of the cycle instead of hanging on
 * unrelated PRs or main pushes. */

/** `<repository>\0<branch>` for one side of a PR. */
export function branchKey(pr, side, repository = "") {
  const owner = side === "head" ? (pr?.headRepository?.nameWithOwner ?? repository) : repository;
  const branch = (side === "head" ? pr?.headRefName : pr?.baseRefName) ?? "";
  return `${owner}\0${branch}`;
}

/** The most base edges a walk follows before it stops. Longer stacks are cut
 * here; a cycle never gets this far. */
export const MAX_STACK_DEPTH = 32;

/** The oldest ancestor of `pr`'s stack in `repository`, as { key, pr }. */
export function stackHead(prs, pr, repository = "") {
  const byHead = new Map();
  for (const candidate of prs) {
    const key = branchKey(candidate, "head", repository);
    if (!byHead.has(key)) byHead.set(key, candidate);
  }
  const visited = new Set();
  for (let depth = 0; depth < MAX_STACK_DEPTH; depth++) {
    if (visited.has(pr.number)) break;
    visited.add(pr.number);
    const parent = byHead.get(branchKey(pr, "base", repository));
    if (parent === undefined || parent.number === pr.number) break;
    pr = parent;
  }
  return { key: branchKey(pr, "head", repository), pr };
}
