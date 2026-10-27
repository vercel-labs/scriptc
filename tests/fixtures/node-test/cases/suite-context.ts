// The SuiteContext a describe body receives (name, fullName, filePath,
// attempt, passed, diagnostic), and the context hooks receive: before and
// after get the suite's, beforeEach and afterEach the test's, and a test's
// t.before and t.after hooks the test's.
import { after, afterEach, before, beforeEach, describe, it, test } from "node:test";
import * as assert from "node:assert";

const seen: string[] = [];
let outerPassed = (): boolean => false;

describe("outer", (s) => {
  const file = (s.filePath ?? "").endsWith("tests/fixtures/node-test/cases/suite-context.ts");
  seen.push(`body: ${s.name} | ${s.fullName} | ${s.passed} | ${s.attempt} | ${file}`);
  s.diagnostic("suite diagnostic");
  outerPassed = () => s.passed;
  before((c) => {
    seen.push(`before: ${c.name}`);
  });
  after((c) => {
    seen.push(`after: ${c.name} ${c.passed}`);
  });
  beforeEach((c) => {
    seen.push(`beforeEach: ${c.name}`);
  });
  afterEach((c) => {
    seen.push(`afterEach: ${c.name} ${c.passed}`);
  });
  describe("inner", (s2) => {
    seen.push(`inner: ${s2.fullName}`);
    it("x", () => {});
  });
  it("y", (t) => {
    t.before((c) => {
      seen.push(`t.before: ${c.name}`);
    });
    t.after((c) => {
      seen.push(`t.after: ${c.name} ${c.passed}`);
    });
  });
});

test("report", () => {
  seen.push(`outer afterwards: ${outerPassed()}`);
  assert.deepStrictEqual(seen, [
    "body: outer | outer | false | 0 | true",
    "inner: outer > inner",
    "before: outer",
    "beforeEach: x",
    "afterEach: x true",
    "beforeEach: y",
    "t.before: y",
    "afterEach: y true",
    "t.after: y true",
    "after: outer false",
    "outer afterwards: true",
  ]);
});
