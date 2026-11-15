// A catch binding is a value of TypeScript's declared type for it, `unknown`
// (or `any`), and every test TypeScript narrows by answers for whatever was
// thrown: `typeof` for every kind, Array.isArray, comparisons with
// undefined and null, and a chain of class tests whose branches pass the
// binding on as a union.
class NotFound extends Error {
  path: string;
  constructor(path: string) {
    super(`no ${path}`);
    this.path = path;
  }
}
class Denied extends Error {
  user: string;
  constructor(user: string) {
    super(`denied ${user}`);
    this.user = user;
  }
}
class Plain {
  label = "plain";
}

function raise(kind: string): void {
  if (kind === "error") throw new Error("boom");
  if (kind === "not-found") throw new NotFound("/x");
  if (kind === "denied") throw new Denied("ann");
  if (kind === "class") throw new Plain();
  if (kind === "string") throw "text";
  if (kind === "number") throw 42;
  if (kind === "boolean") throw false;
  if (kind === "undefined") throw undefined;
  if (kind === "null") throw null;
  if (kind === "array") throw ["first", "second"];
  if (kind === "object") throw { code: "E_OBJ" };
  if (kind === "function") throw (): string => "called";
  if (kind === "bigint") throw 7n;
}

const KINDS = [
  "error",
  "not-found",
  "denied",
  "class",
  "string",
  "number",
  "boolean",
  "undefined",
  "null",
  "array",
  "object",
  "function",
  "bigint",
];

function kindOf(kind: string): string {
  try {
    raise(kind);
  } catch (err) {
    if (typeof err === "undefined") return "undefined";
    if (typeof err === "function") return "function";
    if (typeof err === "bigint") return "bigint";
    if (typeof err === "symbol") return "symbol";
    if (typeof err === "string") return "string " + err.length;
    if (typeof err === "number") return "number " + (err + 1);
    if (typeof err === "boolean") return "boolean " + !err;
    if (err === null) return "null";
    if (Array.isArray(err)) return "array " + err.length;
    return "object";
  }
  return "no throw";
}

function typeText(kind: string): string {
  try {
    raise(kind);
  } catch (err) {
    const expected: string = kind === "function" ? "function" : "object";
    return typeof err + " " + String(typeof err === expected) + " " + String(typeof err !== "undefined");
  }
  return "no throw";
}

function describe(failure: NotFound | Denied): string {
  return failure instanceof NotFound ? "missing " + failure.path : "refused " + failure.user;
}

function classChain(kind: string): string {
  try {
    raise(kind);
  } catch (err) {
    if (err instanceof NotFound || err instanceof Denied) return describe(err) + " | " + err.message;
    if (err === undefined || err === null) return "nullish";
    return "other";
  }
  return "no throw";
}

for (const kind of KINDS) {
  console.log(kind + ": " + kindOf(kind) + " | " + typeText(kind) + " | " + classChain(kind));
}

// The same tests on a rejected promise's reason.
async function later(kind: string): Promise<void> {
  await Promise.resolve();
  raise(kind);
}
for (const kind of ["not-found", "undefined", "function", "array"]) {
  try {
    await later(kind);
  } catch (err) {
    const what =
      typeof err === "undefined"
        ? "undefined"
        : typeof err === "function"
          ? "function"
          : Array.isArray(err)
            ? "array " + err.length
            : err instanceof NotFound || err instanceof Denied
              ? describe(err)
              : "other";
    console.log(kind + ": awaited " + what);
  }
}
