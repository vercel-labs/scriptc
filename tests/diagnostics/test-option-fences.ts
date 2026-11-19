// node:test options lower for skip, todo, only, concurrency and timeout on
// tests and suites, and plan on tests. Each other form is refused with a
// named diagnostic: a concurrency that is neither a boolean literal nor a
// number, a suite's plan, and a plan that is not a literal integer.
import { describe, test } from "node:test";

test("lowers", { plan: 1, timeout: 50, concurrency: 2 }, (t) => {
  t.assert.ok(true);
});

const parallel = process.argv.length > 2;
test("computed concurrency", { concurrency: parallel }, () => {});

describe("suite plan", { plan: 1 }, () => {});

const count = 2;
test("computed plan", { plan: count }, () => {});
