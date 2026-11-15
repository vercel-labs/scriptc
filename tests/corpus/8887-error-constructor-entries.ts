// The checked constructor still runs wherever the typed one cannot answer:
// a message that is not a string converts with ToString, in order and with
// its side effects, before the options are read; an options argument
// installs `cause` only when the key is present; and subclasses reach the
// same two constructors through super().
export {};

let events: string[] = [];
function note<T>(tag: string, value: T): T {
  events.push(tag);
  return value;
}
function flush(label: string): void {
  console.log(label, events.join(" "));
  events = [];
}
function show(label: string, error: Error): void {
  console.log(
    label,
    error.name,
    JSON.stringify(error.message),
    Object.prototype.hasOwnProperty.call(error, "message"),
    "cause" in error,
    String(error.cause),
  );
}

// Arguments evaluate once, left to right.
show("ordered", new Error(note("message", "text"), note("options", { cause: 1 })));
flush("order");
show("ordered typed", new Error(note("message", "text")));
flush("order");

// Messages that are not strings.
const spoken = {
  toString(): string {
    events.push("toString");
    return "spoken";
  },
};
const numeric: any = 42;
const nothing: any = null;
const flag: any = false;
const list: any = [1, 2];
show("object", new Error(spoken as any, note("options", {})));
flush("object");
show("number", new Error(numeric));
show("null", new Error(nothing));
show("boolean", new TypeError(flag));
show("array", new RangeError(list));
const maybe: string | undefined = events.length > 100 ? "set" : undefined;
show("maybe absent", new Error(maybe));
const present: string | undefined = events.length > 100 ? undefined : "present";
show("maybe present", new Error(present));

// A message whose conversion throws: nothing is constructed.
const hostile: any = {
  toString(): string {
    throw new SyntaxError("refused");
  },
};
try {
  show("unreachable", new Error(hostile, note("options", { cause: 2 })));
} catch (error) {
  if (error instanceof Error) show("hostile", error);
}
flush("hostile");
try {
  const symbol: any = Symbol("s");
  show("unreachable", new Error(symbol));
} catch (error) {
  if (error instanceof Error) console.log("symbol", error.name);
}

// Options.
show("cause", new Error("with cause", { cause: "root" }));
show("cause undefined", new Error("with cause", { cause: undefined }));
show("no cause key", new Error("with options", {}));
const options: ErrorOptions | undefined = events.length > 100 ? undefined : { cause: 3 };
show("options variable", new TypeError("typed message", options));

// Subclasses: super(message) with a string, super() and the forwarded pair.
class Plain extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Plain";
  }
}
class Bare extends Error {
  readonly code = 7;
  constructor() {
    super();
  }
}
class Fixed extends TypeError {
  readonly field: string;
  constructor(field: string) {
    super(`invalid ${field}`);
    this.field = field;
  }
}
class Forwarding extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "Forwarding";
  }
}
class Implicit extends RangeError {}
class Deep extends Plain {
  constructor() {
    super(note("deep", "deep message"));
  }
}
show("Plain", new Plain("plain message"));
show("Bare", new Bare());
show("Fixed", new Fixed("email"));
show("Forwarding", new Forwarding("forwarded", { cause: 4 }));
show("Forwarding absent", new Forwarding());
show("Implicit", new Implicit("implicit message"));
show("Implicit absent", new Implicit());
show("Implicit cause", new Implicit("implicit", { cause: 5 }));
show("Deep", new Deep());
flush("deep");
const fixed = new Fixed("name");
console.log(fixed instanceof TypeError, fixed instanceof Error, fixed.field, fixed.toString());
console.log(new Bare().code, JSON.stringify(new Bare().message), new Plain("p").toString());
function raise(kind: number): never {
  if (kind === 0) throw new Plain("thrown");
  if (kind === 1) throw new Bare();
  if (kind === 2) throw new Fixed("age");
  throw new Implicit("i");
}
for (let kind = 0; kind < 4; kind++) {
  try {
    raise(kind);
  } catch (caught) {
    if (caught instanceof Error)
      console.log(
        caught.message,
        caught instanceof Plain,
        caught instanceof TypeError,
        caught instanceof RangeError,
      );
  }
}
