import { expect, test } from "vitest";
import { revertBody, revertBranch, revertTitle } from "../../scripts/ci/revert-pr.mjs";

const culprit = "0123456789abcdef0123456789abcdef01234567";
const green = "1111111111111111111111111111111111111111";
const red = "2222222222222222222222222222222222222222";
const specs = [
  {
    file: "tests/harness/differential.test.ts",
    fullName: "differential corpus > 4123-open.ts",
    san: true,
  },
];

test("the revert branch is one per culprit and never main", () => {
  expect(revertBranch(culprit)).toBe("ci/revert-012345678");
  expect(revertBranch(culprit)).not.toBe("main");
  expect(revertBranch(culprit)).toBe(revertBranch(culprit));
});

test("the title names the reverted commit", () => {
  expect(revertTitle(culprit, "Break the resolver cache")).toBe(
    'Revert "Break the resolver cache" (012345678)',
  );
});

test("the body is short and names the failing test, the green commit and the red commit", () => {
  const body = revertBody({
    sha: culprit,
    subject: "Break the resolver cache",
    green,
    red,
    specs,
  });
  expect(body).toContain("Reverts 012345678 (Break the resolver cache).");
  expect(body).toContain("`222222222`");
  expect(body).toContain("`111111111`");
  expect(body).toContain("`012345678`");
  expect(body).toContain("tests/harness/differential.test.ts");
  expect(body).toContain("differential corpus > 4123-open.ts");
  // Short: a handful of lines, not a transcript.
  expect(body.trim().split("\n").length).toBeLessThanOrEqual(8);
});
