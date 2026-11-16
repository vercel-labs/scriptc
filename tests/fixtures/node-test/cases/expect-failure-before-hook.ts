// @exit: 0
// A test's own t.before throwing is the failure the flag expects, for the
// test and for the subtests it fails the same way (they inherit the flag).
import { test } from "node:test";

test("flagged", { expectFailure: true }, (t) => {
  t.before(() => {
    throw new Error("t.before");
  });
});

test("flagged with a subtest", { expectFailure: true }, (t) => {
  t.before(() => {
    throw new Error("t.before");
  });
  t.test("child", () => {});
});
