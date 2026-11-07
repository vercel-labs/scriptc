// A JavaScript call of path.join or path.resolve with an argument that is
// not a string throws Node's ERR_INVALID_ARG_TYPE under Node's parameter
// name, whether the argument's type is known or not, as the stored
// function values already do.
const path = require("path");

function shape(label, fn) {
  try {
    console.log(label, "ok", JSON.stringify(fn()));
  } catch (e) {
    console.log(label, e instanceof TypeError, e.name, e.code, JSON.stringify(e.message));
  }
}
const untyped = (value) => value;

shape("join strings", () => path.join("a", untyped("b"), "..", "c"));
shape("join none", () => path.join());
shape("join number", () => path.join("a", 1));
shape("join untyped number", () => path.join(untyped(1)));
shape("join object", () => path.join("a", {}));
shape("join null", () => path.join(untyped(null), "b"));
shape("join undefined", () => path.join("a", undefined));
shape("join array", () => path.join(["a"], "b"));
shape("join boolean last", () => path.join("a", "b", untyped(true)));

// resolve walks its arguments from the last one and stops at an absolute
// path, so only the arguments it reads are validated.
shape("resolve relative", () => path.resolve("/base", untyped("x"), "y"));
shape("resolve object", () => path.resolve({}));
shape("resolve second", () => path.resolve("/base", untyped(null)));
shape("resolve unread", () => path.resolve(untyped(7), "/absolute"));
shape("resolve number", () => path.resolve("/base", 5));

// The POSIX and win32 modules take the same checks.
shape("posix join", () => path.posix.join("a", 1));
shape("win32 join", () => path.win32.join("a", untyped(Symbol.iterator)));
shape("posix resolve", () => path.posix.resolve("/a", untyped(() => {})));
shape("win32 join strings", () => path.win32.join("a", untyped("b")));

// Arguments are evaluated once, in order, before the first check.
const order = [];
const note = (name, value) => {
  order.push(name);
  return value;
};
shape("order", () => path.join(note("first", 1), note("second", "b"), note("third", {})));
console.log(order.join(","));
