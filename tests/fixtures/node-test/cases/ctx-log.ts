// t.log(message[, data]) prints its ℹ line at once, at the test's
// indentation and in execution order — ahead of the result lines the
// reporter buffers until each test finishes. The data payload rides the
// test:log event only, so the reporter prints the message alone. A
// SuiteContext logs the same way from a suite body (before the suite's
// header), and its diagnostic queues until the suite's result line.
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

describe("suite body", (s) => {
  s.log("suite body log");
  s.log("suite body data", { userId: 7 });
  s.diagnostic("suite body diagnostic");
  test("in suite body", (t) => {
    t.log("child log");
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
