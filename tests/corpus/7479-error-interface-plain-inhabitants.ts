// An interface that extends Error has values that are not errors: an object literal typed by it, a
// parsed value asserted to it, an instance of a class that has the members. Each is the object it
// is: its members read and write by name, it keeps its identity and its own keys, and it is not an
// instance of Error. A real error handed to the same functions stays the error.
interface FailureLike extends Error {
  status?: number;
}
class Look {
  name = "Look";
  message = "a look-alike";
  status = 6;
}
function describe(failure: FailureLike): string {
  return failure.name + "|" + failure.message + "|" + String(failure.status);
}
function whole(value: unknown, original: unknown): string {
  return [
    value instanceof Error ? "error" : typeof value,
    value === original,
    JSON.stringify(value),
    Object.keys(value as object).join(","),
  ].join(" | ");
}
function report(value: unknown): void {
  const failure = value as FailureLike;
  console.log(describe(failure), "|", whole(failure, value));
  const { name, message, status } = failure;
  console.log(name, "|", message, "|", status);
}
function mark(failure: FailureLike, status: number): void {
  failure.status = status;
  failure.message = failure.message + "!";
}
const literal: FailureLike = { name: "Fake", message: "a literal", status: 4 };
console.log(describe(literal), "|", whole(literal, literal));
report({ name: "Plain", message: "not an error", status: 3 });
report(JSON.parse('{"name":"Parsed","message":"from json"}'));
report(new Look());
report(new Error("real"));
report(new RangeError("range"));
console.log(describe(new TypeError("handed directly")));
mark(literal, 404);
console.log(literal.message, literal.status, JSON.stringify(literal));
const real = new Error("real");
mark(real, 500);
const marked: FailureLike = real;
console.log(real.message, marked.status, Object.keys(marked).join(","));
const list: FailureLike[] = [literal, real];
console.log(list[0] === literal, list[1] === real, list.map((f) => describe(f)).join(" "));
