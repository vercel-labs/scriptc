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
