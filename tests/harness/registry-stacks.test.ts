import { expect, test } from "vitest";
import { branchKey, MAX_STACK_DEPTH, stackHead } from "../../scripts/registry-stacks.mjs";

type Pr = {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRepository: { nameWithOwner: string };
  baseRepository: { nameWithOwner: string };
};

const REPO = "acme/app";

const pr = (
  number: number,
  headRefName: string,
  baseRefName: string,
  headRepository = "acme/app",
  baseRepository = "acme/app",
): Pr => ({
  number,
  headRefName,
  baseRefName,
  headRepository: { nameWithOwner: headRepository },
  baseRepository: { nameWithOwner: baseRepository },
});

test("a chain of pull requests resolves to its oldest ancestor", () => {
  const prs = [pr(3, "c", "b"), pr(2, "b", "a"), pr(1, "a", "main")];
  expect(stackHead(prs, prs[0], REPO).key).toBe(branchKey(prs[2], "head"));
  expect(stackHead(prs, prs[1], REPO).key).toBe(branchKey(prs[2], "head"));
  expect(stackHead(prs, prs[2], REPO).key).toBe(branchKey(prs[2], "head"));
});

test("a cyclic branch graph terminates on a member of the cycle", () => {
  // #1 is based on #2's branch while #2 is based on #1's: the old walk
  // looped forever and hung the whole code_quality gate.
  const prs = [pr(1, "a", "b"), pr(2, "b", "a")];
  const first = stackHead(prs, prs[0], REPO);
  expect(first.pr.number).toBe(1);
  expect(stackHead(prs, prs[1], REPO).pr.number).toBe(2);
  // A self-based branch is a cycle of one.
  const self = pr(4, "loop", "loop");
  expect(stackHead([self], self, REPO).pr.number).toBe(4);
});

test("a fork's branch does not join a same-named branch in the base repository", () => {
  const fork = pr(10, "shared", "main", "fork/app");
  const sameName = pr(11, "shared", "main");
  const prs = [fork, sameName];
  expect(stackHead(prs, fork, REPO).key).toBe(branchKey(fork, "head"));
  expect(stackHead(prs, sameName, REPO).key).toBe(branchKey(sameName, "head"));
  expect(stackHead(prs, fork, REPO).key).not.toBe(stackHead(prs, sameName, REPO).key);
});

test("a base edge follows only a head in the same repository", () => {
  // The fork PR's base is acme/app:shared, but that head lives in fork/app.
  const fork = pr(12, "topic", "shared", "fork/app");
  const sameRepoHead = pr(13, "shared", "main", "fork/app", "fork/app");
  const prs = [fork, sameRepoHead];
  // The base ref names acme/app, so it must not follow fork/app:shared.
  expect(stackHead(prs, fork, REPO).key).toBe(branchKey(fork, "head"));
});

test("a stack deeper than the cap stops at the cap", () => {
  const prs = Array.from({ length: MAX_STACK_DEPTH + 5 }, (_, index) =>
    pr(index + 1, `b${index + 1}`, `b${index + 2}`),
  );
  // The walk follows at most MAX_STACK_DEPTH base edges, so from #1 it stops
  // at #(MAX_STACK_DEPTH + 1).
  const deepest = stackHead(prs, prs[0], REPO);
  expect(deepest.pr.number).toBe(MAX_STACK_DEPTH + 1);
});
