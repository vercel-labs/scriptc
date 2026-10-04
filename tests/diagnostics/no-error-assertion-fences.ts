import assert from "node:assert";
// Static expectations require a class, regex, or validator over unknown.
assert.doesNotThrow(() => {}, { name: "Error" });
assert.doesNotThrow(() => {}, (error: Error): boolean => error.message === "boom");
void assert.doesNotReject(Promise.resolve(), (error: Error): boolean => error.message === "boom");
// Validators receive the original reason without a typed argument check.
