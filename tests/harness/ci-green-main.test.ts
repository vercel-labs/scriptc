import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { TAG_PATH, TAG_REF, tagAction, tagRequest } from "../../scripts/ci/green-main.mjs";

const workflow = load(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as {
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

test("the tag is created once, moved after, and left alone when it already names the commit", () => {
  expect(tagAction(undefined, after)).toBe("create");
  expect(tagAction("", after)).toBe("create");
  expect(tagAction(before, after)).toBe("update");
  expect(tagAction(after, after)).toBe("unchanged");
  // A short or non-hex value is not a commit, and must not reach the API.
  for (const value of ["abc", after.toUpperCase(), `${before}\n`])
    expect(() => tagAction(undefined, value), value).toThrow();
});

test("every request writes the green-main tag and nothing else", () => {
  const repo = "vercel-labs/scriptc";
  expect(TAG_REF).toBe("refs/tags/green-main");
  const create = tagRequest("create", repo, after);
  expect(create.method).toBe("POST");
  expect(create.path).toBe("repos/vercel-labs/scriptc/git/refs");
  expect(create.fields).toEqual({ ref: "refs/tags/green-main", sha: after });
  const update = tagRequest("update", repo, after);
  expect(update.method).toBe("PATCH");
  expect(update.path).toBe(`repos/vercel-labs/scriptc/git/refs/${TAG_PATH}`);
  expect(update.fields).toEqual({ sha: after, force: "true" });
  for (const request of [create, update]) {
    expect(request.path).toContain("/git/refs");
    expect(request.path).not.toContain("/git/refs/heads");
    expect(JSON.stringify(request.fields)).not.toContain("refs/heads");
  }
  expect(() => tagRequest("create", "", after)).toThrow();
  expect(() => tagRequest("unchanged", repo, after)).toThrow();
});

test("a passing push to main moves the tag; a failing or non-push run never does", () => {
  const job = workflow.jobs.green_main!;
  expect(job.name).toBe("tag green-main");
  expect(job.needs).toEqual(["test"]);
  expect(job.if).toBe("${{ github.event_name == 'push' && needs.test.result == 'success' }}");
  // The one permission is the tag write; the job is not part of the required check.
  expect(job.permissions).toEqual({ contents: "write" });
  expect(workflow.jobs.test!.needs).not.toContain("green_main");
  const step = job.steps!.find((candidate) => candidate.run?.includes("green-main.mjs"))!;
  expect(step.run).toBe('node scripts/ci/green-main.mjs "$SHA"');
  expect(step.env).toEqual({ GH_TOKEN: "${{ github.token }}", SHA: "${{ github.sha }}" });
});
