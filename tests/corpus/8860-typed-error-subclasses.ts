// Typed code that declares classes extending Error, constructs them with a
// string message, throws, catches, narrows and reads them stays out of the
// dynamic object model: nothing here views an error as an untyped value, so
// the release executable of this program defines no dynamic-tier runtime
// symbol (tests/harness/typed-error-dynamic-tier.test.ts).
export {};

class AppError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "AppError";
  }
  describe(): string {
    return `${this.name} ${this.status}: ${this.message}`;
  }
}
class NotFound extends AppError {
  readonly resource: string;
  constructor(resource: string) {
    super(`no such ${resource}`, 404);
    this.resource = resource;
    this.name = "NotFound";
  }
}
class Invalid extends TypeError {
  readonly field: string;
  readonly at: { line: number; path: string[] };
  readonly seen: Map<string, number>;
  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.field = field;
    this.at = { line: field.length, path: ["table", field] };
    this.seen = new Map([[field, 1]]);
  }
}
class Limit extends RangeError {
  readonly max: number;
  constructor(max: number) {
    super("over " + max);
    this.max = max;
  }
}

function lookup(table: Map<string, number>, key: string): number {
  const value = table.get(key);
  if (value === undefined) throw new NotFound(key);
  if (value < 0) throw new Invalid(key, "negative");
  if (value > 100) throw new Limit(100);
  if (key.length > 8) throw new AppError("key too long", 400);
  return value;
}

const table = new Map<string, number>([
  ["a", 1],
  ["below", -1],
  ["above", 101],
  ["much-too-long", 5],
]);
for (const key of ["a", "missing", "below", "above", "much-too-long"]) {
  try {
    console.log("value", lookup(table, key));
  } catch (error) {
    if (error instanceof Error) console.log((error.stack ?? "").split("\n")[0]);
    if (error instanceof NotFound)
      console.log("not found", error.resource, error.status, error.describe());
    else if (error instanceof AppError) console.log("app", error.describe(), error.name);
    else if (error instanceof Invalid)
      console.log(
        "invalid",
        error.field,
        error.name,
        error.message,
        error instanceof TypeError,
        error.at.line,
        error.at.path.join("."),
        error.seen.get(error.field) ?? 0,
      );
    else if (error instanceof Limit) console.log("limit", error.max, error.name, error.message);
    else throw error;
  }
}

// Rethrown, through finally, and through a function that only throws.
function fail(resource: string): never {
  throw new NotFound(resource);
}
let finals = 0;
try {
  try {
    fail("page");
  } catch (inner) {
    if (inner instanceof AppError) console.log("inner", inner.status);
    throw inner;
  } finally {
    finals++;
  }
} catch (outer) {
  if (outer instanceof NotFound) console.log("outer", outer.resource, outer.message, finals);
}

// Rejected and awaited.
async function load(key: string): Promise<number> {
  return lookup(table, key);
}
async function main(): Promise<void> {
  for (const key of ["a", "missing", "above"]) {
    try {
      console.log("loaded", await load(key));
    } catch (error) {
      if (error instanceof AppError) console.log("rejected app", error.describe());
      else if (error instanceof Limit) console.log("rejected limit", error.max, error.message);
    }
  }
  let failures = 0;
  for (let round = 0; round < 1000; round++) {
    try {
      lookup(table, round % 3 === 0 ? "missing" : round % 3 === 1 ? "below" : "a");
    } catch (error) {
      if (error instanceof NotFound && error.status === 404) failures += 2;
      else if (error instanceof Error) failures++;
    }
  }
  console.log("failures", failures);
}
main();
