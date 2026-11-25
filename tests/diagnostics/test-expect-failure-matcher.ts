// node:test's expectFailure takes true, false or a string reason; Node's
// matcher forms (RegExp, function, object, Error, { label, match }) follow
// assert.throws and have no lowering, so a use is refused by name.
import { test } from "node:test";

test("regexp matcher", { expectFailure: /boom/ as any }, () => {});
test("function matcher", { expectFailure: ((): boolean => true) as any }, () => {});
test("object matcher", { expectFailure: { code: "E_X" } as any }, () => {});
// End with a nonblank context line so diagnostic snapshots carry no trailing whitespace.
