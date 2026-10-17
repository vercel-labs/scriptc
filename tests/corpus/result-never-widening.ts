type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

function parse(value: string): Result<string, string> {
  return value.length > 0 ? ok(value) : err("empty");
}

function receive(value: Result<string, string>): void {
  console.log(JSON.stringify(value));
}

receive(parse("hello"));
receive(parse(""));
receive(ok("argument"));
receive(err("argument-error"));

const numberResult: Result<number, string> = ok(42);
const objectResult: Result<{ name: string }, string> = ok({ name: "Ada" });
const arrayResult: Result<string[], string> = ok(["a", "b"]);
const errorResult: Result<string, { code: number }> = err({ code: 7 });
console.log(JSON.stringify(numberResult));
console.log(JSON.stringify(objectResult));
console.log(JSON.stringify(arrayResult));
console.log(JSON.stringify(errorResult));

function wrapped(): { result: Result<string, string> } {
  const source = { result: ok("nested") };
  return source;
}
console.log(JSON.stringify(wrapped()));

const source: Result<string, never>[] = [ok("first"), ok("second")];
const destination: Result<string, string>[] = source;
console.log(JSON.stringify(destination));

type OptionalResult = { ok: true; value: string } | { ok: false; error?: never };
function optionalResult(): OptionalResult {
  return { ok: false };
}
console.log(JSON.stringify(optionalResult()));

function unwrap(result: Result<string, never>): string {
  if (result.ok) return result.value;
  throw result.error;
}
console.log(unwrap(ok("unreachable error")));
