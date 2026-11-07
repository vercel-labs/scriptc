// The untyped view of an instance of a program class that extends Error
// answers a key the same way whether the key is written as a literal or
// computed: the own properties its Error base holds (`stack`, `cause`,
// `message`) are present, readable and non-enumerable, the class's fields are
// enumerable, and names nothing defines are absent.
class Bare extends Error {}
class WithCtor extends Error {
  constructor(message: string) {
    super(message);
  }
}
class WithCause extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}
class WithField extends Error {
  status = 404;
  constructor(message: string) {
    super(message);
  }
}
class WithName extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WithName";
  }
}
class OfType extends TypeError {
  constructor(message: string) {
    super(message);
  }
}
class NoMessage extends Error {
  constructor() {
    super();
  }
}
const KEYS = ["message", "stack", "cause", "name", "status", "extra", "missing"];

function probe(label: string, view: any): void {
  for (const key of KEYS) {
    const dynamicKey: any = key;
    const value = view[key];
    const descriptor = Object.getOwnPropertyDescriptor(view, key);
    console.log(
      label,
      key,
      "in",
      key in view,
      dynamicKey in view,
      Reflect.has(view, key),
      "own",
      Object.prototype.hasOwnProperty.call(view, key),
      Object.prototype.hasOwnProperty.call(view, dynamicKey),
      view.hasOwnProperty(key),
      Object.hasOwn(view, dynamicKey),
      "enumerable",
      Object.prototype.propertyIsEnumerable.call(view, key),
      Object.prototype.propertyIsEnumerable.call(view, dynamicKey),
      "read",
      key === "stack" ? typeof value : value,
      typeof view[dynamicKey],
      typeof Reflect.get(view, key),
      "descriptor",
      descriptor === undefined
        ? "none"
        : `${descriptor.enumerable} ${descriptor.configurable} ${typeof descriptor.get} ${typeof descriptor.set}`,
    );
  }
  console.log(
    label,
    "literal",
    "message" in view,
    "stack" in view,
    "cause" in view,
    "name" in view,
    "status" in view,
    "toString" in view,
    "constructor" in view,
    "missing" in view,
  );
  const seen: string[] = [];
  for (const key in view) seen.push(key);
  console.log(
    label,
    "keys",
    JSON.stringify(Object.keys(view)),
    JSON.stringify(Object.getOwnPropertyNames(view)),
    JSON.stringify(Object.entries(view)),
    JSON.stringify(Reflect.ownKeys(view).map(String)),
    JSON.stringify(seen),
    JSON.stringify(view),
    JSON.stringify({ ...view }),
  );
}
const views: [string, unknown][] = [
  ["Error", new Error("x", { cause: 1 })],
  ["Bare", new Bare("x")],
  ["WithCtor", new WithCtor("x")],
  ["WithCause", new WithCause("x", 1)],
  ["WithField", new WithField("x")],
  ["WithName", new WithName("x")],
  ["OfType", new OfType("x")],
  ["NoMessage", new NoMessage()],
];
for (const [label, view] of views) {
  (view as any).extra = "added";
  probe(label, view);
}

// The stack is the native error's, with either spelling of the key, and a
// string written through a computed key replaces it.
function read(view: any, key: string): unknown {
  return view[key];
}
function write(view: any, key: string, value: unknown): void {
  view[key] = value;
}
for (const error of [new Bare("b"), new WithField("f")] as Error[]) {
  const stack = read(error, "stack");
  console.log(
    typeof stack,
    stack === error.stack,
    typeof stack === "string" && stack.startsWith(`Error: ${error.message}`),
    (error as any)["stack"] === error.stack,
    (error as any).stack === error.stack,
  );
}
{
  const error = new WithCause("m", 7);
  write(error, "stack", "custom stack");
  write(error, "status", 500);
  write(error, "message", "changed");
  write(error, "extra", "added");
  write(error, "name", "Renamed");
  console.log(error.stack, error.message, error.name, String(error));
  console.log(read(error, "stack"), read(error, "message"), read(error, "extra"), read(error, "name"), read(error, "cause"));
}
// Read through a reference typed Error (the class is also boxed as itself
// above).
{
  const error: Error = new WithField("upcast");
  const view: any = error;
  const key: string = ["st", "ack"].join("");
  console.log(
    typeof view.stack,
    typeof view[key],
    view.stack === error.stack,
    key in view,
    view.status,
    view instanceof WithField,
  );
}

// An accessor the program adds is called with the instance as `this`,
// through a computed key as through a literal one, and writes through it
// land on the instance.
function defineProbe(target: object, expected: object): void {
  Object.defineProperty(target, "probe", {
    get(this: { seen?: number }) {
      this.seen = (this.seen ?? 0) + 1;
      return this === expected;
    },
    configurable: true,
  });
}
{
  const error = new WithField("accessor");
  defineProbe(error, error);
  const key: string = ["pro", "be"].join("");
  console.log(read(error, key), read(error, "seen"), read(error, key), read(error, "seen"));
  console.log((error as any).probe, (error as any).seen, read(error, "status"), read(error, "message"));
}
