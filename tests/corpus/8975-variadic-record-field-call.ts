// A record FIELD holding a variadic callable. Its lowered type is the
// checked variadic ABI (declared parameters plus one hidden dynamic
// array the boxed call thunk fills) — the same ABI a JavaScript rest
// closure has, and the one a generic member's ERASED instance keeps
// when the erased signature cannot pin its rest tuple
// (`...args: EventArguments<…>`, a conditional over the member's own
// type parameters). A native fixed-arity call cannot spell that hidden
// slot, so a call through the field rides the boxed thunk: zero,
// matching and surplus arguments all deliver JavaScript's arity.
interface Handlers {
  label: string;
  count: (start: number, ...rest: any[]) => number;
  on: (...args: any[]) => void;
  describe: (...args: any[]) => string;
}

const h: Handlers = {
  label: "handlers",
  count: (start, ...rest) => start + rest.length,
  on: (...args) => {
    console.log("on", args.length, args.join(","));
  },
  describe: (...args) => args.join("|"),
};

// Surplus arguments by every scalar kind, and no arguments at all.
h.on(1, 2, 3);
h.on();
h.on("a", true, 1.5, null, undefined);
console.log(h.label, h.count(10), h.count(10, "x", "y"));

// A variadic field beside fixed parameters: the fixed slots keep their
// types and the tail is the dynamic array.
console.log(h.count(1, [2], { three: 3 }), h.describe("p", "q"));

// The result of a variadic field call converts back to its declared type
// like any checked result.
const n: number = h.count(5, 1, 1);
console.log(n + 1, typeof h.describe().toUpperCase());

// The same field read as a value and called through the binding: the value
// lane's own thunk lane agrees with the field lane.
const bound = h.on;
bound(9, 8);
bound();

// A record nested in a record: the field lane applies at every depth.
const nested = { inner: h, name: "nested" };
nested.inner.on("deep", 1);
console.log(nested.inner.count(2, 3), nested.name);

// A method-syntax variadic member has the same ABI as the arrow field.
const methods = {
  emit(...parts: any[]): number {
    console.log("emit", parts.length, parts.join("+"));
    return parts.length;
  },
};
console.log(methods.emit(), methods.emit("a"), methods.emit("a", "b", "c"));
