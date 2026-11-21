// node:assert's message argument accepts a string or an Error. An Error is
// thrown itself (its name, message and stack survive), while a string or any
// other value becomes the AssertionError's message. These are the documented
// forms of assert, ok, strictEqual/equal, fail, match and doesNotMatch.
import assert from "node:assert";
import strictAssert from "node:assert/strict";

function show(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const e = error as {
      name: string;
      code?: string;
      message: string;
      generatedMessage?: boolean;
      operator?: string;
    };
    console.log(label, e.name, e.code ?? "", JSON.stringify(e.message), e.generatedMessage, e.operator);
  }
}

show("assert error message", () => assert(false, new Error("boom")));
show("assert type error message", () => assert(false, new TypeError("typed")));
show("ok error message", () => assert.ok(false, new RangeError("range")));
show("strictEqual error message", () => assert.strictEqual(1, 2, new Error("strict")));
show("equal error message", () => assert.equal(1, 2, new Error("loose")));
show("fail error message", () => assert.fail(new Error("failed")));
show("match error message", () => assert.match("a", /b/, new Error("match")));
show("doesNotMatch error message", () => assert.doesNotMatch("a", /a/, new Error("no match")));
show("strict module error message", () => strictAssert.strictEqual(1, 2, new Error("strict module")));

show("assert plain message", () => assert(false, "plain"));
show("ok plain message", () => assert.ok(false, "ok message"));
show("strictEqual plain message", () => assert.strictEqual(1, 2, "strict message"));
show("fail plain message", () => assert.fail("failed message"));
show("match plain message", () => assert.match("a", /b/, "match message"));
show("throws plain message", () => assert.throws(() => {}, "missing expected"));

// A non-string, non-Error message is converted to its string form.
show(
  "object message",
  () =>
    assert(false, {
      toString() {
        return "object message";
      },
    } as unknown as string),
);
show("number message", () => assert(false, 0 as unknown as string));

// A message Error keeps its own class and fields.
try {
  assert.ok(false, new Error("keep"));
} catch (error) {
  const e = error as Error;
  console.log("class", e.name, e.message, "code" in e);
}
