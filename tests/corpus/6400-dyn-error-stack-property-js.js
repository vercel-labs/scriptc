// In JavaScript sources, errors have an own `stack` like Node's: a
// non-enumerable accessor that every error shares. The first read formats
// "Name: message" from the error's name and message at that point, and
// later reads answer the same string. Assigning a value replaces it,
// `delete` removes it, Object.keys, spread, Object.assign and
// JSON.stringify leave it out, `in` and Object.hasOwn find it, objects
// that inherit from an error read the error's stack. Typed and dynamic
// reads answer the same string, and a stack read through `any` captures
// frames. Only the first line is printed: frame lines differ between
// runtimes.

class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseError";
  }
}

class PlainSubclass extends Error {}

function dyn(value) {
  return value;
}

function firstLine(value) {
  return typeof value === "string" ? JSON.stringify(value.split("\n")[0]) : `(${typeof value} ${String(value)})`;
}

function describe(label, error) {
  console.log(
    label,
    "|",
    typeof error.stack,
    firstLine(error.stack),
    "|",
    Object.keys(error).join(","),
    JSON.stringify(error),
    "|",
    "stack" in error,
    Object.hasOwn(error, "stack"),
    error.propertyIsEnumerable("stack"),
  );
}

try {
  throw new RangeError("thrown");
} catch (error) {
  describe("caught", error);
}

const unknownError = new TypeError("bad thing");
describe("unknown", unknownError);
describe("plain", dyn(new Error("plain")));
describe("no message", dyn(new SyntaxError()));
describe("subclass", dyn(new ParseError("line 3")));
describe("plain subclass", dyn(new PlainSubclass("inherited name")));

const coded = dyn(new Error("with code"));
coded.code = "E_CODE";
describe("own property", coded);

const descriptor = dyn(Object.getOwnPropertyDescriptor(dyn(new Error("a")), "stack"));
const other = dyn(Object.getOwnPropertyDescriptor(dyn(new TypeError("b")), "stack"));
console.log("descriptor", Object.keys(descriptor).join(","), descriptor.enumerable, descriptor.configurable);
console.log("shared accessors", typeof descriptor.get, descriptor.get === other.get, descriptor.set === other.set);
console.log("foreign receiver", descriptor.get.call({}), firstLine(descriptor.get.call(dyn(new TypeError("b")))));
const subclassDescriptor = dyn(Object.getOwnPropertyDescriptor(dyn(new PlainSubclass("s")), "stack"));
console.log("subclass descriptor", Object.keys(subclassDescriptor).join(","), subclassDescriptor.get === descriptor.get);

const renamed = dyn(new Error("before"));
renamed.message = "after";
renamed.name = "Renamed";
console.log("first read", firstLine(renamed.stack));
renamed.message = "later";
console.log("later read", firstLine(renamed.stack));
const subclassRenamed = dyn(new PlainSubclass("before"));
subclassRenamed.message = "after";
console.log("subclass first read", firstLine(subclassRenamed.stack));

const replaced = dyn(new Error("replaced"));
replaced.stack = "custom stack\n    at nowhere";
describe("assigned", replaced);
console.log("assigned descriptor", Object.keys(Object.getOwnPropertyDescriptor(replaced, "stack")).join(","));
const subclassReplaced = dyn(new ParseError("replaced"));
subclassReplaced.stack = "subclass stack";
console.log("subclass assigned", subclassReplaced.stack);
const typedReplaced = new ParseError("typed write");
typedReplaced.stack = "typed subclass stack";
console.log("typed subclass assigned", typedReplaced.stack, dyn(typedReplaced).stack);
const subclassNumbered = dyn(new PlainSubclass("numbered"));
subclassNumbered.stack = 7;
console.log("subclass number", subclassNumbered.stack, typeof subclassNumbered.stack);
subclassNumbered.stack = "string again";
console.log("subclass string again", subclassNumbered.stack);
const numbered = dyn(new Error("numbered"));
numbered.stack = 5;
console.log("number", numbered.stack, typeof numbered.stack);
const removed = dyn(new Error("removed"));
delete removed.stack;
console.log("deleted", removed.stack, "stack" in removed, Object.hasOwn(removed, "stack"));

const spreadSource = dyn(new Error("spread"));
console.log("spread", Object.keys({ ...spreadSource }).length, Object.keys(Object.assign({}, spreadSource)).length);
console.log("inherited", firstLine(Object.create(dyn(new RangeError("prototype"))).stack));

const typed = new Error("typed");
const view = dyn(typed);
console.log("typed and dynamic", view.stack === typed.stack, firstLine(typed.stack));
const typedSubclass = new ParseError("typed subclass");
console.log("typed subclass", firstLine(dyn(typedSubclass).stack), dyn(typedSubclass).stack === typedSubclass.stack);
const assignedThroughView = new Error("typed");
dyn(assignedThroughView).stack = "through the view";
console.log("assigned through view", assignedThroughView.stack);

function inner() {
  return dyn(new Error("deep"));
}
function outer() {
  return inner();
}
const deep = outer().stack;
console.log("frames", deep.split("\n").length > 1, deep.includes("at inner"), deep.includes("at outer"));
function makeSubclass() {
  return dyn(new PlainSubclass("deep"));
}
console.log("subclass frames", makeSubclass().stack.includes("at makeSubclass"));

const formatted = dyn(new Error("formatted"));
console.log("formatted before clone", firstLine(formatted.stack));
console.log("clone keeps a formatted stack", firstLine(dyn(structuredClone(formatted)).stack));

class GrumpyError extends Error {
  /** @returns {string} */
  get name() {
    throw new Error("no name today");
  }
}
try {
  console.log("throwing name getter", firstLine(dyn(new GrumpyError("grumpy")).stack));
} catch (error) {
  console.log("throwing name getter threw", error.message);
}

function readKey(target, key) {
  return target[key];
}
const computed = readKey(inner(), ["sta", "ck"].join(""));
console.log("computed key", firstLine(computed), computed.includes("at inner"));
