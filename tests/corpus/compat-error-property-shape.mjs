// The own-property shape of each standard error as Node builds it: the
// order of the own names and each property's enumerable/writable/
// configurable flags. Node's constructors assign the fields in a fixed
// order (AssertionError's generatedMessage before its name, a SystemError's
// code and name before its message), and reflection over a caught value
// sees that order.
import assert from "node:assert";
import os from "node:os";

function describe(label, make) {
  let error;
  try {
    throw make();
  } catch (caught) {
    error = caught;
  }
  const names = Object.getOwnPropertyNames(error).map((name) => {
    const d = Object.getOwnPropertyDescriptor(error, name);
    return `${name}:${d.enumerable ? "e" : "-"}${d.writable ? "w" : "-"}${d.configurable ? "c" : "-"}`;
  });
  console.log(label, "|", names.join(","), "|", error.name);
}

describe("error", () => new Error("m"));
describe("type", () => new TypeError("m"));
describe("cause", () => new Error("m", { cause: 1 }));
describe("aggregate", () => new AggregateError([new Error("x")], "m"));
describe("aggregate empty", () => new AggregateError([]));
describe("suppressed", () => new SuppressedError(new Error("e"), new Error("s"), "m"));
describe("assertion", () => new assert.AssertionError({ actual: 1, expected: 2, operator: "o" }));
describe("system", () => {
  try {
    os.setPriority(999999, 0);
  } catch (error) {
    return error;
  }
  return new Error("no system error");
});

// The DOMException options form's cause is non-enumerable, as Error's.
let domexCause;
try {
  throw new DOMException("m", { name: "AbortError", cause: 2 });
} catch (caught) {
  domexCause = caught;
}
const causeDescriptor = Object.getOwnPropertyDescriptor(domexCause, "cause");
console.log("dom cause", causeDescriptor.enumerable, causeDescriptor.writable, causeDescriptor.configurable);
