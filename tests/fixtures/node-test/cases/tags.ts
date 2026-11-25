// { tags } on tests and suites: values are lowercased and de-duplicated in
// declaration order, a suite's tags are inherited by every test under it
// (the suite's own first, then the test's), t.tags answers the frozen
// flattened set and the same array on every read, and an empty tag value
// throws Node's ERR_INVALID_ARG_VALUE at the registration site.
import assert from "node:assert";
import { beforeEach, describe, it, test, type SuiteContext, type TestContext } from "node:test";

const seen: string[] = [];
/* @types/node types every hook's context as the TestContext | SuiteContext
 * union; a beforeEach hook runs with the test's context. */
const asTest = (c: TestContext | SuiteContext): TestContext => c as unknown as TestContext;
const record = (where: string, tags: readonly string[]): void => {
  seen.push(`${where}:${tags.join(",")}:${Object.isFrozen(tags)}`);
};

test("own tags canonicalize", { tags: ["DB", "db", "Slow"] }, (t) => {
  record("own", t.tags);
  assert.strictEqual(t.tags === t.tags, true);
});

describe("database", { tags: ["DB"] }, () => {
  beforeEach((c) => {
    const t = asTest(c);
    record(`each ${t.name}`, t.tags);
  });
  it("inherits", (t) => {
    record("inherits", t.tags);
  });
  it("unions", { tags: ["Integration"] }, (t) => {
    record("unions", t.tags);
  });
  it("drops inherited duplicates", { tags: ["db", "flaky"] }, (t) => {
    record("dupe", t.tags);
  });
  describe("inner", { tags: ["nested"] }, () => {
    it("nests", (t) => {
      record("nested", t.tags);
    });
  });
});

test("empty list", { tags: [] }, (t) => {
  record("empty", t.tags);
});

test("registration errors", () => {
  const errors: string[] = [];
  try {
    test("bad tag", { tags: [""] }, () => {});
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    errors.push(`${e.name} ${e.code} ${e.message}`);
  }
  try {
    test("bad tag", { tags: ["ok", ""] }, () => {});
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    errors.push(`${e.name} ${e.code} ${e.message}`);
  }
  assert.deepStrictEqual(errors, [
    "TypeError ERR_INVALID_ARG_VALUE The property 'options.tags[0]' must not be empty. Received ''",
    "TypeError ERR_INVALID_ARG_VALUE The property 'options.tags[1]' must not be empty. Received ''",
  ]);
  assert.deepStrictEqual(seen, [
    "own:db,slow:true",
    "each inherits:db:true",
    "inherits:db:true",
    "each unions:db,integration:true",
    "unions:db,integration:true",
    "each drops inherited duplicates:db,flaky:true",
    "dupe:db,flaky:true",
    "each nests:db,nested:true",
    "nested:db,nested:true",
    "empty::true",
  ]);
});
