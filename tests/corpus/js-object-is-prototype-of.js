// Object.prototype.isPrototypeOf over untyped values: the argument rules
// (a non-object argument answers false before the receiver converts), the
// wrapper-object receivers a primitive converts to, and the nullish
// receiver's TypeError, with V8's message.

function attempt(label, run) {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, "threw", error.name + ": " + error.message);
  }
}

const values = [1, "s", true, null, undefined, Symbol("x"), 1n, [], {}, function f() {}];
for (let i = 0; i < values.length; i++)
  attempt("non-object argument " + i, () => Object.prototype.isPrototypeOf(values[i]));
attempt("no argument", () => Object.prototype.isPrototypeOf());

const num = 1;
const str = "abc";
const bool = true;
attempt("primitive number receiver", () => num.isPrototypeOf({}));
attempt("primitive string receiver", () => str.isPrototypeOf({}));
attempt("primitive boolean receiver", () => bool.isPrototypeOf({}));
attempt("bigint receiver", () => 1n.isPrototypeOf({}));

attempt("null receiver", () => Object.prototype.isPrototypeOf.call(null, {}));
attempt("undefined receiver", () => Object.prototype.isPrototypeOf.call(undefined, {}));
attempt("primitive argument", () => Object.prototype.isPrototypeOf.call({}, 1));

const base = { tag: "base" };
const child = Object.create(base);
attempt("checked-dynamic record chain", () => base.isPrototypeOf(child));
attempt("checked-dynamic reverse", () => child.isPrototypeOf(base));

const shady = { isPrototypeOf: () => "shadowed" };
attempt("shadowing own member", () => shady.isPrototypeOf(base));

// The dependency-injection idiom over a function-provided prototype: a
// constructor is not its own prototype, but Object.prototype is on every
// constructor's chain.
const proto = {};
attempt("object prototype of Object", () => proto.isPrototypeOf(Object));
