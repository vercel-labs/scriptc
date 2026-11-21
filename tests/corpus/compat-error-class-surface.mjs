// The class surface Node's errors chapter documents for the standard error
// classes and for AssertionError and DOMException: what the constructors
// take, the name/message/cause/code they answer, the constructor identity
// an instance reports, what Error.prototype's toString does with them, and
// the stack members (captureStackTrace, stackTraceLimit, stack). Written as
// a JavaScript module so the same program meets both source languages'
// restrictions; every line is Node's output.
import assert from "node:assert";

/** The own properties an error carries, in creation order. */
function ownNames(value) {
  return Object.getOwnPropertyNames(value).join(",");
}

/** A one-line description: class, name, message, and toString. */
function describe(label, error) {
  console.log(
    label,
    error.constructor === Error ? "Error" : error.constructor === TypeError ? "TypeError" : error.constructor === RangeError ? "RangeError" : error.constructor === ReferenceError ? "ReferenceError" : error.constructor === SyntaxError ? "SyntaxError" : "other",
    error.name,
    JSON.stringify(error.message),
    JSON.stringify(String(error)),
  );
}

// The message argument: undefined and no argument are the empty string, and
// everything else converts with ToString.
console.log("no argument", JSON.stringify(new Error().message), new Error().name);
console.log("undefined", JSON.stringify(new Error(undefined).message));
console.log("null", JSON.stringify(new Error(null).message));
console.log("number", JSON.stringify(new Error(42).message));
console.log(
  "object",
  JSON.stringify(
    new Error({
      toString() {
        return "converted";
      },
    }).message,
  ),
);

// Each standard class answers its own name and class identity.
describe("error", new Error("boom"));
describe("type", new TypeError("boom"));
describe("range", new RangeError("boom"));
describe("reference", new ReferenceError("boom"));
describe("syntax", new SyntaxError("boom"));

// The class graph: every standard error is an Error and only its own class.
console.log(
  "instanceof",
  new TypeError("x") instanceof Error,
  new TypeError("x") instanceof TypeError,
  new TypeError("x") instanceof RangeError,
  new Error("x") instanceof TypeError,
);
// Constructor identity, including `.constructor.name`.
console.log("constructors", new Error().constructor === Error, new TypeError().constructor === TypeError);
console.log("constructor names", new Error().constructor.name, new RangeError().constructor.name);

// cause: an own property when the options object carries the key, absent
// otherwise; enumerable neither way.
const withCause = new Error("outer", { cause: new TypeError("inner") });
console.log("cause", withCause.cause.name, withCause.cause.message, withCause.cause instanceof Error);
console.log("cause names", ownNames(withCause));
const withoutCause = new Error("plain");
console.log("no cause", withoutCause.cause, "cause" in withoutCause);
const undefinedCause = new Error("outer", { cause: undefined });
console.log("undefined cause", undefinedCause.cause, "cause" in undefinedCause, ownNames(undefinedCause));

// toString composes what the instance answers, so an assigned name or
// message shows through, and an empty name drops the prefix.
const renamed = new Error("first");
renamed.name = "Custom";
renamed.message = "second";
console.log("renamed", String(renamed), renamed.name, renamed.message);
const nameless = new Error("tail");
nameless.name = "";
console.log("nameless", JSON.stringify(String(nameless)));

// stack: the first line is the heading, and writing it replaces the value.
const stacked = new Error("stacky");
console.log("stack heading", stacked.stack.split("\n")[0], typeof stacked.stack);
stacked.stack = "replacement";
console.log("stack replaced", stacked.stack);

// Error.stackTraceLimit bounds the captured frames; 0 and a negative limit
// keep the heading alone. (Frame counts beyond the program's own functions
// are the documented divergence, so only the program's frames are asked
// about.)
function limited(limit) {
  Error.stackTraceLimit = limit;
  const error = marker();
  Error.stackTraceLimit = 10;
  return [error.stack.split("\n")[0], error.stack.includes("at marker")].join(" | ");
}
function marker() {
  return new Error("limited");
}
console.log("default limit", Error.stackTraceLimit);
console.log("two frames", limited(2));
console.log("one frame", limited(1));
console.log("no frames", limited(0));
console.log("negative frames", limited(-1));

// Error.captureStackTrace installs the heading and frames on an Error, and
// its constructorOpt leaves the frames above it out.
function captureTarget() {
  const holder = new Error("holder");
  Error.captureStackTrace(holder);
  return [holder.stack.split("\n")[0], holder.stack.includes("at captureTarget")].join(" | ");
}
console.log("capture", captureTarget());
function captureFrom() {
  const holder = new Error("holder");
  Error.captureStackTrace(holder, captureFrom);
  return [holder.stack.split("\n")[0], holder.stack.includes("at captureFrom")].join(" | ");
}
console.log("capture from call site", captureFrom());

// AssertionError: the fields assert attaches to a failure, and the options
// constructor.
try {
  assert.strictEqual(1, 2);
} catch (error) {
  console.log(
    "assertion",
    error instanceof assert.AssertionError,
    error.name,
    error.code,
    error.operator,
    error.actual,
    error.expected,
    error.generatedMessage,
  );
  console.log("assertion message", JSON.stringify(error.message.split("\n")[0]));
  console.log("assertion names", Object.getOwnPropertyNames(error).sort().join(","));
  console.log("assertion constructor", error.constructor.name);
}
const built = new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
console.log("built", built.name, built.code, built.operator, built.actual, built.expected, built.generatedMessage);
console.log("built message", JSON.stringify(built.message.split("\n")[0]));
try {
  assert(false, "custom message");
} catch (error) {
  console.log("custom", JSON.stringify(error.message), error.generatedMessage);
}

// DOMException: name, message, the legacy numeric code, toString.
for (const name of ["AbortError", "NotSupportedError", "IndexSizeError", "SyntaxError", "UnknownError"]) {
  const domex = new DOMException("message", name);
  console.log("dom", name, domex.name, JSON.stringify(domex.message), domex.code, JSON.stringify(String(domex)));
}
const domexDefault = new DOMException("plain");
console.log("dom default", domexDefault.name, domexDefault.code);
// A DOMException read as a value is the global constructor: constructing
// through it builds the same class, and the instance's constructor is that
// same value.
const Ctor = DOMException;
const made = new Ctor("message", "AbortError");
console.log("stored", made.name, made instanceof DOMException, made.constructor === DOMException);
// A call without `new` reaches the same global value and fails as Node's
// class constructors do.
const untypedCtor = /** @type {any} */ (DOMException);
try {
  untypedCtor("message");
  console.log("call without new", "no throw");
} catch (error) {
  console.log("call without new", error.name, JSON.stringify(error.message));
}
console.log("dom constructor", new DOMException("x").constructor.name);

// DOMException's name, message and code are enumerable prototype members, so
// for...in visits them; an ordinary error's prototype members are not, and
// the error's own `stack` is not enumerable either way.
function enumeratedKeys(value) {
  const keys = [];
  for (const key in value) keys.push(key);
  return keys;
}
const domexKeys = enumeratedKeys(new DOMException("m", "AbortError"));
console.log(
  "dom for-in",
  ["name", "message", "code", "stack"].filter((key) => domexKeys.includes(key)).join(","),
);
console.log("error for-in", enumeratedKeys(new Error("m")).length);

// The DOMException class carries the WebIDL legacy code constants, and the
// options form reads `name` (String of an absent member is "undefined", as
// in Node) and records `cause` only when the member is present.
console.log("dom statics", DOMException.INDEX_SIZE_ERR, DOMException.ABORT_ERR, DOMException.DATA_CLONE_ERR);
const viaOptions = new DOMException("message", { name: "NotSupportedError", cause: "why" });
console.log("dom options", viaOptions.name, viaOptions.code, viaOptions.cause, "cause" in viaOptions);
const unknownName = new DOMException("message", "NoSuchError");
console.log("dom unknown", unknownName.name, unknownName.code);
const nullName = new DOMException("message", null);
console.log("dom null name", nullName.name, nullName.code);
const missingName = new DOMException("message", {});
console.log("dom missing name", missingName.name, missingName.code);
