// An error built by the typed constructor and one built by the checked
// constructor are the same kind of object once they reach code that reads
// them reflectively: an untyped catch binding, `unknown` and `any` views,
// key enumeration, descriptors, JSON.stringify and spread.
export {};

function describe(label: string, view: any): void {
  console.log(label, view.name, JSON.stringify(view.message), String(view));
  console.log(" class", isError(view), isTypeError(view), typeof view, Object.prototype.toString.call(view));
  console.log(" names", JSON.stringify(Object.getOwnPropertyNames(view)));
  console.log(" keys", JSON.stringify(Object.keys(view)), JSON.stringify(Object.entries(view)));
  console.log(" in", "message" in view, "name" in view);
  for (const key of ["message", "name", "cause", "stack"]) {
    const descriptor = Object.getOwnPropertyDescriptor(view, key);
    console.log(
      " " + key,
      Object.prototype.hasOwnProperty.call(view, key),
      descriptor === undefined
        ? "none"
        : `${typeof descriptor.value} w=${descriptor.writable} e=${descriptor.enumerable} c=${descriptor.configurable}`,
    );
  }
  console.log(" json", JSON.stringify(view), JSON.stringify({ ...view }), JSON.stringify([view]));
  console.log(" stack", String(view.stack).split("\n")[0]);
  const visited: string[] = [];
  for (const key in view) visited.push(key);
  console.log(" for-in", visited.join(","));
}

// Asked outside `describe`, so its `any` parameter is not narrowed.
function isError(value: unknown): boolean {
  return value instanceof Error;
}
function isTypeError(value: unknown): boolean {
  return value instanceof TypeError;
}

const dynamicMessage: any = "same text";
const typedMessage: string = "same text";

// Each pair: the typed constructor, then the checked one with equal inputs.
describe("typed", new Error(typedMessage));
describe("checked", new Error(dynamicMessage));
describe("checked options", new Error(typedMessage, {}));
describe("typed absent", new Error());
describe("checked absent", new Error(undefined, {}));
describe("typed TypeError", new TypeError("type"));
describe("checked TypeError", new TypeError("type", {}));
describe("with cause", new Error("outer", { cause: new RangeError("inner") }));
describe("undefined cause", new Error("outer", { cause: undefined }));

// Program classes: the view carries the class's own fields beside the
// error's, whichever constructor super() reached.
class HttpError extends Error {
  readonly status: number;
  detail = "none";
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
class Timeout extends HttpError {
  readonly after: number;
  constructor(after: number) {
    super(`timed out after ${after} ms`, 504);
    this.after = after;
  }
}
class Empty extends TypeError {
  constructor() {
    super();
  }
}
class Wrapped extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}
describe("HttpError", new HttpError("not found", 404));
describe("Timeout", new Timeout(30));
describe("Empty", new Empty());
describe("Wrapped", new Wrapped("wrapped", new Timeout(5)));

// Thrown from typed code, caught untyped.
function fail(kind: number): never {
  if (kind === 0) throw new Error("plain failure");
  if (kind === 1) throw new SyntaxError(`syntax ${kind}`);
  if (kind === 2) throw new Timeout(kind);
  throw new URIError();
}
for (let kind = 0; kind < 4; kind++) {
  try {
    fail(kind);
  } catch (error: unknown) {
    describe("caught " + kind, error);
  }
}

// Held in untyped containers and passed through untyped calls.
const held: unknown[] = [new Error("held"), new EvalError("held eval")];
function pass(value: any): any {
  return value;
}
for (const value of held) describe("held", pass(value));

// Writes through the untyped view land on the typed object.
const shared = new Error("before");
const sharedView: any = shared;
sharedView.message = "after";
sharedView.extra = 7;
console.log(shared.message, JSON.stringify(Object.keys(sharedView)), JSON.stringify(sharedView));
describe("written", shared);
