// t.log(message[, data]) prints its ℹ line at once, at the test's
// indentation and in execution order — ahead of the result lines the
// reporter buffers until each test finishes. The data payload rides the
// test:log event only, so the reporter prints the message alone.
import { describe, test } from "node:test";

test("outer", async (t) => {
  t.log("outer log");
  await t.test("inner", (t2) => {
    t2.log("inner log");
    t2.log("inner data", { userId: 42 });
  });
  t.log("after inner");
});

describe("suite", () => {
  test("in suite", (t) => {
    t.log("suite log");
  });
});

test("data payloads", (t) => {
  t.log("null data", null);
  t.log("undefined data", undefined);
  let calls = 0;
  const bump = (): number => ++calls;
  t.log("bump", bump());
  t.diagnostic(`calls ${calls}`);
});
