import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import {
  ghArgs,
  greenTag,
  isAncestor,
  tagAction,
  tagPath,
  tagRef,
  tagRequest,
} from "../../scripts/ci/green-tag.mjs";

// The tag job lives beside CI (green-tag.yml): ci.yml is a reusable workflow the
// post-merge lanes call read-only, and a `contents: write` job inside it would make
// every such call invalid (postmerge.test.ts pins the ceiling).
const workflow = load(
  readFileSync(new URL("../../.github/workflows/green-tag.yml", import.meta.url), "utf8"),
) as {
  on: {
    workflow_run: { workflows: string[]; types: string[]; branches: string[] };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      needs?: string[];
      if?: string;
      name?: string;
      permissions?: Record<string, string>;
      steps?: { name?: string; env?: Record<string, string>; run?: string }[];
    }
  >;
};

const before = "a".repeat(40);
const after = "b".repeat(40);

test("each integration branch has its own green tag", () => {
  expect(greenTag("main")).toBe("green-main");
  expect(greenTag("canary")).toBe("green-canary");
  for (const branch of ["", "release", "main\n"])
    expect(() => greenTag(branch), JSON.stringify(branch)).toThrow();
  expect(tagRef("green-main")).toBe("refs/tags/green-main");
  expect(tagRef("green-canary")).toBe("refs/tags/green-canary");
  expect(tagPath("green-canary")).toBe("tags/green-canary");
});

test("the tag is created once, moved forward, and left alone when it already names the commit or a newer one", () => {
  expect(tagAction(undefined, after)).toBe("create");
  expect(tagAction("", after)).toBe("create");
  expect(tagAction(before, after, { ancestor: true })).toBe("update");
  expect(tagAction(after, after)).toBe("unchanged");
  // A rerun of an older push targets an older commit: it must never drag the tag back.
  expect(tagAction(after, before)).toBe("stale");
  expect(tagAction(after, before, { ancestor: false })).toBe("stale");
  // A short or non-hex value is not a commit, and must not reach the API.
  for (const value of ["abc", after.toUpperCase(), `${before}\n`])
    expect(() => tagAction(undefined, value), value).toThrow();
});

test("ancestry decides whether a commit can move the tag", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-green-tag-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q");
    const commit = (file: string) => {
      writeFileSync(join(directory, file), file);
      git("add", file);
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", file);
      return git("rev-parse", "HEAD");
    };
    const older = commit("older");
    const newer = commit("newer");
    expect(isAncestor(older, newer, directory)).toBe(true);
    expect(isAncestor(newer, older, directory)).toBe(false);
    expect(isAncestor(older, older, directory)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every request writes one green tag and nothing else", () => {
  const repo = "vercel-labs/scriptc";
  const create = tagRequest("create", repo, after, "green-main");
  expect(create.method).toBe("POST");
  expect(create.path).toBe("repos/vercel-labs/scriptc/git/refs");
  expect(create.fields).toEqual({ ref: "refs/tags/green-main", sha: after });
  const update = tagRequest("update", repo, after, "green-canary");
  expect(update.method).toBe("PATCH");
  expect(update.path).toBe(`repos/vercel-labs/scriptc/git/refs/${tagPath("green-canary")}`);
  // `force` is a boolean in the request body, not the string "true".
  expect(update.fields).toEqual({ sha: after, force: true });
  for (const request of [create, update]) {
    expect(request.path).toContain("/git/refs");
    expect(request.path).not.toContain("/git/refs/heads");
    expect(JSON.stringify(request.fields)).not.toContain("refs/heads");
  }
  expect(() => tagRequest("create", "", after, "green-main")).toThrow();
  expect(() => tagRequest("unchanged", repo, after, "green-main")).toThrow();
  // The boolean field goes through -F, so the API receives a boolean; strings keep -f.
  expect(ghArgs(update)).toEqual([
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/git/refs/${tagPath("green-canary")}`,
    "-f",
    `sha=${after}`,
    "-F",
    "force=true",
  ]);
  expect(ghArgs(create)).toEqual([
    "api",
    "--method",
    "POST",
    `repos/${repo}/git/refs`,
    "-f",
    `ref=${tagRef("green-main")}`,
    "-f",
    `sha=${after}`,
  ]);
});

test("a passing canary push moves the green-canary tag; a failing or non-push run never does", () => {
  // The CI run on a canary push moves the tag; a pull request's or merge queue's run never does, and a push's
  // run is not cancelled by the other branch's (ci.yml's per-branch pre-merge groups).
  expect(workflow.on.workflow_run).toEqual({
    workflows: ["CI"],
    types: ["completed"],
    branches: ["canary"],
  });
  expect(workflow.concurrency).toEqual({ group: "green-canary", "cancel-in-progress": false });
  const job = workflow.jobs.green_canary!;
  expect(job.name).toBe("tag green-canary");
  expect(job.if).toContain("github.event.workflow_run.event == 'push'");
  expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'");
  // The one permission is the tag write; the job is not part of the required check.
  expect(job.permissions).toEqual({ contents: "write" });
  const step = job.steps!.find((candidate) => candidate.run?.includes("green-tag.mjs"))!;
  expect(step.run).toBe('node scripts/ci/green-tag.mjs "$SHA" --branch canary');
  expect(step.env).toEqual({
    GH_TOKEN: "${{ github.token }}",
    SHA: "${{ github.event.workflow_run.head_sha }}",
  });
});
