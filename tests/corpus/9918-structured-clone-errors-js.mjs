// structuredClone of an Error in JavaScript: what the copy's own properties
// are, how a name, message or stack that is not a plain string travels, and
// which values are errors at all.
function show(label, o, c) {
  const d = Object.getOwnPropertyDescriptor(c, "stack");
  const m = Object.getOwnPropertyDescriptor(c, "message");
  console.log(
    label,
    c === o,
    c instanceof Error,
    c.constructor === Error ? "Error" : c.constructor === TypeError ? "TypeError" : c.constructor === RangeError ? "RangeError" : "other",
    c.name,
    JSON.stringify(c.message),
    Object.prototype.hasOwnProperty.call(c, "name"),
    Object.prototype.hasOwnProperty.call(c, "message"),
    m ? (m.enumerable ? "e" : "-") + (m.writable ? "w" : "-") + (m.configurable ? "c" : "-") : "none",
    d ? (d.enumerable ? "e" : "-") : "none",
    typeof c.stack,
    Object.keys(c).join(","),
    Object.getOwnPropertyNames(c).join(","),
    JSON.stringify(c),
  );
}
function attempt(label, make) {
  try {
    const o = make();
    show(label, o, structuredClone(o));
  } catch (err) {
    console.log(label, "threw", err.name);
  }
}
attempt("error", () => new Error("plain"));
attempt("type", () => new TypeError("t", { cause: 1 }));
attempt("empty", () => new Error());
attempt("extras", () => {
  const e = new Error("extras");
  e.code = "E";
  e.name = "Mine";
  return e;
});
attempt("stack-number", () => {
  const e = new Error("stack number");
  e.stack = 12;
  return e;
});
attempt("message-enumerable", () => {
  const e = new RangeError("range");
  Object.defineProperty(e, "message", { value: "enumerable message", enumerable: true });
  return e;
});
attempt("message-getter", () => {
  const e = new Error("getter message");
  Object.defineProperty(e, "message", { get() { return "computed"; }, configurable: true });
  return e;
});
attempt("name-number", () => {
  const e = new Error("name obj");
  e.name = 5;
  return e;
});
attempt("extra-function", () => {
  const e = new Error("with fn");
  e.fn = () => 1;
  return e;
});
attempt("cause-function", () => new Error("cause fn", { cause: () => 1 }));
attempt("cause-null", () => new Error("cause null", { cause: null }));
class Mine extends RangeError {
  constructor(m) {
    super(m);
    this.tag = "mine";
  }
}
attempt("js-class", () => new Mine("js class"));
class Named extends Error {
  get name() {
    return "SyntaxError";
  }
}
attempt("js-class-name-getter", () => new Named("named"));

// An own `cause` that is an accessor is not a data property: the copy has
// no own cause, whether or not the error was made with one.
attempt("cause-getter", () => {
  const e = new Error("getter cause");
  Object.defineProperty(e, "cause", { get() { return 7; }, configurable: true });
  return e;
});
attempt("cause-getter-over-data", () => {
  const e = new Error("getter over data", { cause: 1 });
  Object.defineProperty(e, "cause", { get() { return 7; }, configurable: true });
  return e;
});

// Not errors: an object that looks like one, and an instance of a function
// that inherits Error.prototype, clone as plain objects.
function Legacy(message) {
  this.message = message;
}
Legacy.prototype = Object.create(Error.prototype);
Legacy.prototype.name = "Legacy";
attempt("legacy-constructor", () => new Legacy("legacy"));
attempt("fake", () => ({ name: "TypeError", message: "not an error", stack: "fake stack" }));

// A DOMException copies its name and message; the code follows the name.
{
  const o = new DOMException("dom message", "AbortError");
  const c = structuredClone(o);
  console.log("dom-exception", c === o, c instanceof Error, c instanceof DOMException, c.name, c.message, c.code, String(c));
  const held = structuredClone({ inner: o });
  console.log("dom-exception nested", held.inner === o, held.inner instanceof DOMException, held.inner.name, held.inner.message);
}

// The same error twice, and an error whose cause is itself.
{
  const twice = new TypeError("twice");
  const pair = structuredClone([twice, twice]);
  console.log("shared", pair[0] === pair[1], pair[0] === twice, pair[0] instanceof TypeError);
  const loop = new Error("loop");
  loop.cause = loop;
  const copy = structuredClone(loop);
  console.log("self cause", copy !== loop, copy.cause === copy, copy.message);
}
