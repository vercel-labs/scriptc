// An interface that extends Error is the error itself seen with more members, as the intersection
// `Error & { ... }` is: an assertion to it keeps the value's identity, its class and its own keys
// (handed on as unknown it is still an instance of its class), its members destructure, and a value
// typed by either spelling converts to a record parameter member by member. Stack frames differ
// natively by design, so only the first line of a stack is printed.
interface FailureLike extends Error {
  status?: number;
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
function kind(value: unknown): string {
  return value instanceof Failure ? "failure" : value instanceof Error ? "error" : typeof value;
}
function firstLine(stack: string | undefined): string {
  return stack === undefined ? "none" : stack.split("\n")[0]!;
}
function handedOn(value: unknown, original: unknown): string {
  return [
    kind(value),
    value === original,
    JSON.stringify(value),
    Object.keys(value as object).join(","),
  ].join(" | ");
}
function advice(e: { message?: string; tag?: string }): string {
  return (e.message ?? "none") + "/" + (e.tag ?? "none");
}
function report(error: unknown): void {
  const failure = error as FailureLike;
  console.log(failure.name, "|", failure.message, "|", failure.status, "|", firstLine(failure.stack));
  console.log(handedOn(failure, error));
  console.log(JSON.stringify(failure), "|", String(failure));
  const tagged = error as Tagged;
  console.log(tagged.tag, "|", firstLine(tagged.stack), "|", advice(tagged));
  const { message, status, stack } = failure;
  console.log(message, "|", status, "|", firstLine(stack));
  const both = error as Error & { tag?: string };
  console.log(advice(both), "|", handedOn(both, error));
}
report(new Error("plain"));
report(new Failure("denied", 403));
report(new TypeError("typed"));
report(Object.assign(new Error("assigned"), { tag: "t1", status: 7 }));
try {
  throw new Failure("thrown", 500);
} catch (caught) {
  const failure = caught as FailureLike;
  console.log(failure.message, "|", failure.status, "|", kind(failure));
}
