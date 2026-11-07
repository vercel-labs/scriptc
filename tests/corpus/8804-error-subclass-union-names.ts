// Program classes over every builtin error base, with and without a
// constructor, keep the base's `name`, their `message`, their string form and
// their `instanceof` answers through every way a union-typed value reaches a
// reader: a direct read, a throw, a Map, a return, a rejected promise,
// Promise.allSettled, a cause, and arguments typed `unknown` and `any`. A
// `name` a class overrides with a field, an assignment or an accessor answers
// the same way through each.
class Plain extends Error {}
class TypeBare extends TypeError {}
class TypeCtor extends TypeError {
  constructor(message: string) {
    super(message);
  }
}
class RangeBare extends RangeError {}
class RangeCtor extends RangeError {
  constructor(message: string) {
    super(message);
  }
}
class SyntaxBare extends SyntaxError {}
class SyntaxCtor extends SyntaxError {
  constructor(message: string) {
    super(message);
  }
}
class EvalBare extends EvalError {}
class EvalCtor extends EvalError {
  constructor(message: string) {
    super(message);
  }
}
class URIBare extends URIError {}
class URICtor extends URIError {
  constructor(message: string) {
    super(message);
  }
}
class ReferenceBare extends ReferenceError {}
class ReferenceCtor extends ReferenceError {
  constructor(message: string) {
    super(message);
  }
}

function all() {
  return [
    new Plain("plain"),
    new TypeBare("TypeBare"),
    new TypeCtor("TypeCtor"),
    new RangeBare("RangeBare"),
    new RangeCtor("RangeCtor"),
    new SyntaxBare("SyntaxBare"),
    new SyntaxCtor("SyntaxCtor"),
    new EvalBare("EvalBare"),
    new EvalCtor("EvalCtor"),
    new URIBare("URIBare"),
    new URICtor("URICtor"),
    new ReferenceBare("ReferenceBare"),
    new ReferenceCtor("ReferenceCtor"),
  ];
}
function bases(error: Error): string {
  return [
    error instanceof TypeError,
    error instanceof RangeError,
    error instanceof SyntaxError,
    error instanceof EvalError,
    error instanceof URIError,
    error instanceof ReferenceError,
  ]
    .map((answer) => (answer ? "1" : "0"))
    .join("");
}
function line(label: string, error: Error): string {
  return `${label} ${error.name} ${error.message} | ${String(error)} | ${Object.prototype.toString.call(error)} ${bases(error)}`;
}
function show(label: string, value: unknown): void {
  if (value instanceof Error) console.log(line(label, value));
  else console.log(label, "not an error");
}
function loose(label: string, value: any): void {
  console.log(
    label,
    value.name,
    value.message,
    String(value),
    value instanceof TypeError,
    value instanceof RangeError,
    value instanceof Error,
  );
}

// Read directly on the union and thrown from it.
for (const error of all()) {
  console.log("direct", error.name, error.message, error instanceof TypeError);
  try {
    throw error;
  } catch (caught) {
    if (caught instanceof Error) console.log(line("array-throw", caught));
  }
  show("unknown", error);
  loose("any", error);
}
// A two-arm union variable, and an optional one.
function either(i: number): Plain | RangeCtor {
  return i > 0 ? new RangeCtor("either") : new Plain("plain");
}
const pair = either(1);
console.log("pair", pair.name, pair.message);
try {
  throw pair;
} catch (caught) {
  if (caught instanceof Error) console.log(line("pair-throw", caught));
}
const maybe: SyntaxBare | undefined = either(1) instanceof RangeError ? new SyntaxBare("maybe") : undefined;
if (maybe !== undefined) console.log("optional", maybe.name, maybe.message);
show("optional-unknown", maybe);
// Through a Map and a function result.
const table = new Map<string, Plain | TypeBare | URICtor>();
table.set("plain", new Plain("plain"));
table.set("type", new TypeBare("TypeBare"));
table.set("uri", new URICtor("URICtor"));
for (const key of table.keys()) {
  try {
    throw table.get(key)!;
  } catch (caught) {
    if (caught instanceof Error) console.log(line("map", caught));
  }
}
function chosen(i: number) {
  if (i === 0) return new EvalBare("EvalBare");
  if (i === 1) return new ReferenceCtor("ReferenceCtor");
  return new Plain("fallback");
}
for (let i = 0; i < 3; i++) {
  const error = chosen(i);
  console.log("return", error.name, error.message);
  try {
    throw error;
  } catch (caught) {
    if (caught instanceof Error) console.log(line("return-throw", caught));
  }
}
// As a cause.
for (const error of all()) {
  const outer = new Error("outer", { cause: error });
  show("cause", outer.cause);
  try {
    throw outer;
  } catch (caught) {
    if (caught instanceof Error) show("cause-throw", caught.cause);
  }
}

// A name the class overrides.
class FieldName extends TypeError {
  name = "FieldName";
}
class CtorName extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "CtorName";
  }
}
class GetterName extends SyntaxError {
  override get name(): string {
    return "GetterName";
  }
}
class ReadonlyName extends URIError {
  override readonly name: string = "ReadonlyName";
}
class Deep extends FieldName {}
class DeepBare extends CtorName {}
class Two extends TypeError {}
class Three extends Two {}
function named() {
  return [
    new Plain("plain"),
    new FieldName("field"),
    new CtorName("ctor"),
    new GetterName("getter"),
    new ReadonlyName("readonly"),
    new Deep("deep"),
    new DeepBare("deepbare"),
    new Two("two"),
    new Three("three"),
  ];
}
for (const error of named()) {
  console.log("named", error.name, error.message, error instanceof TypeError);
  try {
    throw error;
  } catch (caught) {
    if (caught instanceof Error) console.log(line("named-throw", caught));
  }
  show("named-unknown", error);
}
const getter: GetterName | undefined = named().length > 0 ? new GetterName("lone") : undefined;
if (getter !== undefined) console.log("named-optional", getter.name, getter.message);

async function main(): Promise<void> {
  for (const error of all()) {
    try {
      await Promise.reject(error);
    } catch (caught) {
      show("reject", caught);
    }
  }
  async function thrower(i: number): Promise<number> {
    const list = all();
    throw list[i]!;
  }
  for (let i = 0; i < 13; i++) {
    try {
      await thrower(i);
    } catch (caught) {
      show("async-throw", caught);
    }
  }
  const settled = await Promise.allSettled(all().map((error) => Promise.reject(error)));
  for (const result of settled) if (result.status === "rejected") show("allSettled", result.reason);
}
main();
