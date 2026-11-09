// An instance of a declared subclass of Error seen through an interface that extends Error (read,
// redeclared, destructured): `stack`, and a `name` / `message` the instance does not own, answer
// what the instance answers. The program asks `instanceof` of an unknown value, so the classes
// have prototype objects. Stack frames differ natively by design, so only the first line of a
// stack is printed.
interface FailureLike extends Error {
  status?: number;
  detail?: string;
}
interface Tagged extends Error {
  stack?: string;
  tag?: string;
}
class Failure extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
class Gone extends Failure {
  detail: string;
  constructor(message: string) {
    super(message, 410);
    this.detail = message + "!";
  }
}
class Bad extends TypeError {
  status = 422;
}
class Named extends Error {
  name = "Named";
  status = 7;
}
class Renamed extends Error {
  status: number;
  constructor(message: string) {
    super(message);
    this.name = "Renamed";
    this.status = 8;
  }
}
class Quiet extends Error {
  status = 0;
  constructor() {
    super();
  }
}
function first(stack: unknown): string {
  return typeof stack === "string" ? "string:" + stack.split("\n")[0] : typeof stack;
}
function kind(value: unknown): string {
  return value instanceof Gone
    ? "gone"
    : value instanceof Failure
      ? "failure"
      : value instanceof TypeError
        ? "type"
        : value instanceof Error
          ? "error"
          : typeof value;
}
function throughInterface(error: unknown): void {
  const failure = error as FailureLike;
  console.log(
    "interface:",
    failure.name,
    "|",
    JSON.stringify(failure.message),
    "|",
    first(failure.stack),
    "|",
    failure.status,
    "|",
    failure.detail,
  );
}
function throughRedeclaredStack(error: unknown): void {
  const tagged = error as Tagged;
  console.log("redeclared:", tagged.name, "|", tagged.tag, "|", first(tagged.stack));
}
function throughDestructuring(error: unknown): void {
  const { name, message, stack, status } = error as FailureLike;
  console.log("destructured:", name, "|", JSON.stringify(message), "|", first(stack), "|", status);
}
function ownKeys(value: unknown): void {
  console.log("keys:", Object.keys(value as object).join(","), "|", JSON.stringify(value));
}
const values: unknown[] = [
  new Error("plain"),
  new TypeError("typed"),
  new Failure("denied", 403),
  new Gone("gone"),
  new Bad("bad"),
  new Named("named"),
  new Renamed("renamed"),
  new Quiet(),
];
for (const value of values) {
  console.log("--", kind(value));
  throughInterface(value);
  throughRedeclaredStack(value);
  throughDestructuring(value);
  ownKeys(value);
}
// A stack the program assigns is the one the structural read answers.
const assigned = new Failure("assigned", 1);
assigned.stack = "Replaced: stack";
throughInterface(assigned);
throughDestructuring(assigned);
