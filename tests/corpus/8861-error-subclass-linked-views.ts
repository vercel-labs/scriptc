// The checked-dynamic view of a program class that extends Error is found
// through the table of views the program defines, whoever boxes the error:
// compiled code converting it to an untyped value, or the runtime settling a
// promise, building an AggregateError or reading a cause. Each class answers
// with its own view, a subclass before its base, and one instance keeps one
// view.
class AppError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "AppError";
  }
}
class NotFound extends AppError {
  readonly resource: string;
  constructor(resource: string) {
    super(`no such ${resource}`, 404);
    this.resource = resource;
  }
}
class Invalid extends TypeError {
  readonly field: string;
  constructor(field: string) {
    super(`${field} is invalid`);
    this.field = field;
  }
}
class Quiet extends Error {}

function describe(label: string, value: unknown): void {
  const view: any = value;
  console.log(
    label,
    view.name,
    view.message,
    JSON.stringify(Object.keys(view)),
    JSON.stringify(view),
    view.status,
    view.resource,
    view.field,
    "status" in view,
    "resource" in view,
    "stack" in view,
    typeof view.stack,
  );
  console.log(
    label,
    value instanceof AppError,
    value instanceof NotFound,
    value instanceof Invalid,
    value instanceof TypeError,
    value instanceof Quiet,
    value instanceof Error,
    Object.prototype.toString.call(value),
  );
}

// Boxed by compiled code.
const app = new AppError("denied", 403);
const missing = new NotFound("page");
const invalid = new Invalid("age");
const quiet = new Quiet("quiet");
describe("app", app);
describe("missing", missing);
describe("invalid", invalid);
describe("quiet", quiet);
describe("plain", new Error("plain"));
describe("builtin", new RangeError("range"));
const first: unknown = missing;
const second: unknown = missing;
console.log("one view", first === second, first === missing);
// A write through the view reaches the instance.
(first as any).status = 410;
(first as any).extra = "added";
console.log("written", missing.status, JSON.stringify(Object.keys(missing)));

// Boxed by the runtime.
async function failing(kind: number): Promise<number> {
  if (kind === 0) throw new AppError("async denied", 401);
  if (kind === 1) throw new NotFound("async page");
  if (kind === 2) throw new Invalid("async age");
  if (kind === 3) throw new Quiet("async quiet");
  return kind;
}
async function main(): Promise<void> {
  const settled = await Promise.allSettled([0, 1, 2, 3, 4].map((kind) => failing(kind)));
  for (const result of settled) {
    if (result.status === "rejected") describe("settled", result.reason);
    else console.log("settled value", result.value);
  }
  try {
    await Promise.any([0, 1].map((kind) => failing(kind)));
  } catch (error) {
    if (error instanceof AggregateError)
      for (const inner of error.errors) describe("any", inner);
  }
  const outer = new Error("outer", { cause: new NotFound("cause page") });
  describe("cause", outer.cause);
  await failing(2).catch((reason: unknown) => describe("catch", reason));
}
main();
