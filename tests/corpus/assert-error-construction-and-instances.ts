// node:assert's AssertionError and Assert as values: `new AssertionError`
// takes Node's options object (message, or operator/actual/expected for the
// generated message, with ERR_ASSERTION as the code), `instanceof
// AssertionError` answers for failures the module throws, and an `Assert`
// instance carries its options (diff, skipPrototype, strict) into every
// method. Named imports and the namespace-member forms both construct.
import assert, { Assert, AssertionError } from "node:assert";

function show(label: string, e: AssertionError): void {
  // Read through a record view with optional members: the options a
  // failure did not set (operator on a message-only error) are `undefined`
  // at run time.
  const raw = e as unknown as {
    name?: string;
    message?: string;
    code?: string;
    operator?: string;
    actual?: unknown;
    expected?: unknown;
    generatedMessage?: boolean;
  };
  console.log(
    label,
    JSON.stringify({
      name: raw.name,
      message: raw.message,
      code: raw.code,
      operator: raw.operator,
      actual: raw.actual,
      expected: raw.expected,
      generated: raw.generatedMessage,
    }),
  );
  console.log(label, "classes", e instanceof Error, e instanceof AssertionError);
}

show("message", new AssertionError({ message: "boom" }));
show("generated", new AssertionError({ actual: 1, expected: 2, operator: "===" }));
show("strictEqual", new AssertionError({ actual: 1, expected: 1, operator: "strictEqual" }));
show(
  "deepStrictEqual",
  new AssertionError({ actual: { a: 1 }, expected: { a: 2 }, operator: "deepStrictEqual" }),
);
show("namespace", new assert.AssertionError({ message: "from the namespace member" }));

try {
  assert.strictEqual(1, 2);
} catch (e) {
  if (e instanceof AssertionError) console.log("caught", e.operator, JSON.stringify(e.message));
}

const strictInstance = new Assert();
try {
  strictInstance.deepStrictEqual({ a: 1 }, { a: 2 });
} catch (e) {
  console.log("instance", e instanceof AssertionError, e instanceof AssertionError ? e.operator : "?");
}

const fullDiff = new Assert({ diff: "full" });
try {
  fullDiff.deepStrictEqual({ a: 1 }, { a: 2 });
} catch (e) {
  console.log("full", e instanceof Error ? JSON.stringify(e.message) : "?");
}

const loose = new Assert({ strict: false });
loose.equal(1, "1");
console.log("loose-pass");
try {
  loose.deepStrictEqual({ a: 1 }, { a: 2 });
  console.log("loose-deep-pass");
} catch (e) {
  console.log("loose-deep-fail", e instanceof Error ? JSON.stringify(e.message) : "?");
}
