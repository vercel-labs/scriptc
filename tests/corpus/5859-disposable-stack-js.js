// DisposableStack from JavaScript: untyped resources and callbacks, methods
// detached from the stack, and Node's TypeError and ReferenceError texts for
// invalid receivers, resources and callbacks. Node.js prints the same.
const attempt = (label, f) => {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, e.name + ": " + e.message);
  }
};
const s = new DisposableStack();
attempt("use number", () => s.use(5));
attempt("use empty object", () => s.use({}));
attempt("use null", () => s.use(null));
attempt("use undefined", () => s.use(undefined));
for (const v of ["x", 5, {}, [], null, undefined, true, Symbol("q"), 1n, new Map()]) {
  attempt("defer", () => s.defer(v));
}
attempt("adopt", () => s.adopt(1, 2));
const { defer, use, dispose, move } = s;
attempt("detached defer", () => defer(() => {}));
attempt("use on object", () => use.call({}, null));
attempt("dispose on number", () => dispose.call(5));
attempt("move on string", () => move.call("x"));
console.log(s.defer.length, s.use.length, s.adopt.length, s.move.length, s.dispose.length);
console.log(s.defer.name, s[Symbol.dispose].name, s[Symbol.dispose] === s.dispose);
console.log(typeof s.disposed, s.disposed, JSON.stringify(s), String(s), s);

const order = [];
const resource = (name) => ({
  [Symbol.dispose]() {
    order.push("dispose " + name);
  },
});
const stack = new DisposableStack();
console.log(stack.use(resource("a")) !== null, stack.adopt(7, (v) => order.push("adopt " + v)));
stack.defer(() => order.push("defer"));
stack.use(resource("b"));
const moved = stack.move();
moved.defer(() => order.push("after move"));
console.log(stack.disposed, moved.disposed, moved instanceof DisposableStack);
moved[Symbol.dispose]();
console.log(order.join(", "));
console.log(moved.dispose(), moved.disposed);
attempt("use after dispose", () => moved.use(null));
attempt("adopt after dispose", () => moved.adopt(1, () => {}));

const failing = new DisposableStack();
failing.defer(() => {
  throw new Error("one");
});
failing.defer(() => {
  throw new TypeError("two");
});
failing.defer(() => {
  throw "three";
});
try {
  failing.dispose();
} catch (e) {
  console.log(e.name, e.message, e.error.name, e.suppressed.error.message, e.suppressed.suppressed);
}
const getterResource = {
  get [Symbol.dispose]() {
    console.log("getter read");
    return () => console.log("getter resource disposed");
  },
};
const g = new DisposableStack();
g.use(getterResource);
console.log("after use");
g.dispose();
{
  using scoped = new DisposableStack();
  scoped.defer(() => console.log("scope exit"));
  console.log("in scope");
}
