// util.format %j over Error values: JSON.stringify sees an error's own
// enumerable properties, and message, stack and name are not enumerable,
// so a plain error prints "{}" while a subclass that declares fields
// prints those. Fields typed as errors and fields holding undefined
// serialize the way Node's walk does. Node is the oracle.
import { format } from "node:util";

class Bare extends Error {}
class Fielded extends Error {
  code: string;
  detail: string | undefined;
  count: number;
  constructor(message: string) {
    super(message);
    this.code = "E_FIELDED";
    this.detail = undefined;
    this.count = 2;
  }
}
class Wraps extends Error {
  inner: Error;
  list: number[];
  constructor() {
    super("outer");
    this.inner = new Error("inner");
    this.list = [1, 2];
  }
}

console.log(format("%j", new Error("boom")));
console.log(format("%j", new TypeError("boom")));
console.log(format("%j", new RangeError("out of range")));
console.log(format("%j", new Bare("boom")));
console.log(format("%j", new Fielded("boom")));
console.log(format("%j", new Wraps()));
console.log(format("%j", new Error("outer", { cause: new Error("inner") })));
console.log(format("%j %s", new Fielded("boom"), "trailing"));

// The receiver expression evaluates once, however many fields it prints.
let calls = 0;
function make(): Fielded {
  calls++;
  return new Fielded("made");
}
console.log(format("%j", make()));
console.log(`calls ${calls}`);

// The static type an argument reaches %j through can be a base class: the
// runtime class's own fields print, and its toJSON hook supplies the value.
class Leveled extends Error {
  level: number;
  constructor(message: string) {
    super(message);
    this.level = 3;
  }
}
class Hooked extends Error {
  a = 1;
  toJSON(): unknown {
    return { from: "toJSON" };
  }
}
function throughBase(e: Error): string {
  return format("%j", e);
}
console.log(throughBase(new Leveled("leveled")));
console.log(throughBase(new Hooked("hooked")));
console.log(throughBase(new Bare("bare")));

// A `name` field, or `this.name = ...` during construction, is an own
// enumerable property where it was created; a `message` field makes the
// base's non-enumerable slot enumerable.
class Named extends Error {
  name = "Named";
  extra = 5;
}
class CtorNamed extends Error {
  extra = 6;
  constructor(message: string) {
    super(message);
    this.name = "CtorNamed";
  }
}
class MessageField extends Error {
  message = "field message";
  x = 1;
}
console.log(format("%j", new Named("named")));
console.log(format("%j", new CtorNamed("ctor")));
console.log(format("%j", new MessageField("ignored")));

// A property created at run time is an own enumerable property, and a
// cycle through one prints "[Circular]".
const cyclic = new Bare("cyclic");
(cyclic as unknown as { self?: unknown }).self = cyclic;
console.log(format("%j", cyclic));

// A throwing argument expression fails before the walk begins.
function refuse(): Bare {
  throw new Error("refused");
}
try {
  format("%j", refuse());
} catch (error) {
  console.log(error instanceof Error ? error.message : "not an error");
}
