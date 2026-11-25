// Computed access on instances of classes that extend Error, held as `any`,
// through every form the key can arrive in. The names the Error base keeps
// (`stack`, `cause`, `message`, `name`), a declared field, an accessor, an
// added property and a missing name answer the same for a plain read, an
// optional read, an untyped key, `in`, hasOwnProperty and Reflect.get.

class Failure extends Error {
  code = 7;
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "Failure";
  }
  get summary(): string {
    return `${this.name}(${this.code}): ${this.message}`;
  }
}

class Timeout extends Failure {
  after = 30;
}

class Plain {
  code = 1;
}

function show(value: unknown): string {
  if (typeof value === "function") return "function";
  if (value === undefined) return "undefined";
  if (value instanceof Error) return `error ${value.message}`;
  if (typeof value === "string") return JSON.stringify(value.split("\n")[0]);
  return JSON.stringify(value);
}

function attempt(action: () => unknown): string {
  try {
    return show(action());
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}

const readString = (value: any, key: string): unknown => value[key];
const readAny = (value: any, key: any): unknown => value[key];
const readOptional = (value: any, key: string): unknown => value?.[key];
const readOptionalAny = (value: any, key: any): unknown => value?.[key];
const hasIn = (value: any, key: any): boolean => key in value;
const hasOwn = (value: any, key: any): boolean => Object.prototype.hasOwnProperty.call(value, key);
const reflectGet = (value: any, key: any): unknown => Reflect.get(value, key);
const writeString = (value: any, key: string, stored: unknown): void => {
  value[key] = stored;
};
const writeAny = (value: any, key: any, stored: unknown): void => {
  value[key] = stored;
};

const names = ["message", "name", "stack", "cause", "code", "after", "summary", "added", "missing"];

function rows(title: string, make: () => any): void {
  console.log(`-- ${title}`);
  const value = make();
  writeString(value, "added", "first");
  for (const name of names) {
    console.log(
      name,
      attempt(() => readString(value, name)),
      attempt(() => readAny(value, name)),
      attempt(() => readOptional(value, name)),
      attempt(() => readOptionalAny(value, name)),
      attempt(() => reflectGet(value, name)),
      attempt(() => hasIn(value, name)),
      attempt(() => hasOwn(value, name)),
    );
  }
  writeAny(value, "added", "second");
  writeString(value, "code", 9);
  writeAny(value, "message", "rewritten");
  console.log(
    attempt(() => readString(value, "added")),
    attempt(() => readOptionalAny(value, "code")),
    attempt(() => readAny(value, "message")),
    attempt(() => readOptional(value, "summary")),
    Object.keys(value).join(","),
  );
}

rows("Failure", () => new Failure("disk full"));
rows("Failure with a cause", () => new Failure("retry failed", new Error("first try")));
rows("Timeout", () => new Timeout("too slow", "deadline"));
rows("Plain", () => new Plain());
rows("Error", () => new Error("builtin", { cause: 5 }));
console.log(attempt(() => readOptional(undefined, "stack")), attempt(() => readOptionalAny(null, "stack")));
