// Iterator helpers on TYPED receivers whose static lowering has no form
// (slice 3 of the iterator-helpers design): a generator whose yield
// channel has no step representation (a generator yielding nothing),
// non-callable or unmappable callbacks, flatMap results the typed loop
// cannot hold, helper methods read as values, `return` on builtin
// iterators, `new` of a builtin method, and a `let` generator binding
// reassigned with a stage. Each call runs the runtime's own helper over
// the boxed value, so argument validation, closing and error messages are
// Node's.
const t = (label, f) => {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, e.constructor.name + ":", e.message);
  }
};

function* nothing() {}

// A generator yielding nothing has no native step form: every helper runs
// through the runtime, lazily, closing the source as Node does.
console.log(nothing().map(() => 0).toArray().length);
console.log(JSON.stringify([...nothing().filter(() => true)]));
console.log(nothing().take(3).toArray().length, nothing().drop(2).toArray().length);
console.log(nothing().flatMap(() => [1]).toArray().length);
console.log(nothing().reduce((a, b) => a + b, 7));
console.log(nothing().some(() => true), nothing().every(() => true), nothing().find(() => true));
let visited = 0;
nothing().forEach(() => {
  visited++;
});
console.log(visited);
t("void drop", () => nothing().drop(-1).toArray());
t("void take", () => nothing().take(-1).toArray());
t("void reduce", () => nothing().reduce(() => {}));

// Non-callable callbacks: the runtime's TypeError, at the call.
function* aFew() {
  yield 1;
  yield 2;
  yield 3;
}
// @ts-expect-error the non-callable argument is the point
t("map object", () => aFew().map({}));
// @ts-expect-error the non-callable argument is the point
t("filter null", () => aFew().filter(null));
// @ts-expect-error the non-callable argument is the point
t("every number", () => aFew().every(5));
// @ts-expect-error the non-callable argument is the point
t("some string", () => aFew().some("x"));
// @ts-expect-error the non-callable argument is the point
t("find array", () => aFew().find([1]));
// @ts-expect-error the non-callable argument is the point
t("reduce string", () => aFew().reduce("x"));
// @ts-expect-error the non-callable argument is the point
t("forEach symbol", () => aFew().forEach(Symbol("s")));
// @ts-expect-error the non-callable argument is the point
t("drop object", () => aFew().drop({}));

// A filter callback's result is ToBoolean'd, and a take/drop budget goes
// through ToNumber, exactly as the runtime validates them.
console.log(aFew().filter((x) => x % 2).toArray().join(","));
console.log(aFew().take("2").toArray().join(","), aFew().drop(true).toArray().join(","));
console.log(aFew().take(Infinity).toArray().length, aFew().take(2.9).toArray().length);
t("take NaN", () => aFew().take(NaN).toArray());

// flatMap callbacks whose result the typed loop cannot hold run the
// runtime, which answers Node's TypeError for a non-iterable result.
// @ts-expect-error the unmappable flatMap result is the point
t("flatMap unknown", () => aFew().flatMap(() => JSON.parse("[1]")).toArray().join(","));
// @ts-expect-error the unmappable flatMap result is the point
t("flatMap number", () => aFew().flatMap((x) => x).toArray());
t("flatMap iterable", () => aFew().flatMap((x) => [x, -x]).toArray().join(","));

// Helper methods read as values: the interned function %Iterator.prototype%
// holds, so identity matches Node's.
console.log(nothing().map === Iterator.prototype.map, aFew().filter === Iterator.prototype.filter);
const held = aFew().take;
console.log(held === Iterator.prototype.take, held.call(aFew(), 2).toArray().join(","));
console.log(typeof aFew().map(() => 0).return, typeof aFew().map(() => 0).next);

// `return` reads on builtin iterators that have none answer undefined.
console.log([].values().return, [1, 2].values().return, aFew().flatMap((x) => [x]).return === undefined);

// `{ __proto__: value }` object literals (B.3.1): the prototype is set for
// objects, functions and null, and ignored for primitives.
const proto = { hello() { return "hi"; } };
const withProto = { __proto__: proto, a: 1 };
console.log(withProto.hello(), withProto.a, Object.getPrototypeOf(withProto) === proto);
console.log(Object.keys(withProto).join(","), JSON.stringify(withProto));
const fromPrimitive = { __proto__: 5, b: 2 };
console.log(Object.getPrototypeOf(fromPrimitive) === Object.prototype, fromPrimitive.b);
console.log(Object.getPrototypeOf({ __proto__: null, c: 3 }), Object.keys({ __proto__: null, c: 3 }).length);
function Holder() {}
const withFunction = { __proto__: Holder };
console.log(Object.getPrototypeOf(withFunction) === Holder);

// `new` of a built-in method is a TypeError naming the callee's source.
const iter = aFew();
// @ts-expect-error a method is not a constructor
t("new iter.map()", () => new iter.map());
// @ts-expect-error a method is not a constructor
t("new iter.map(0)", () => new iter.map(0));
// @ts-expect-error a method is not a constructor
t("new Iterator.prototype.map", () => new Iterator.prototype.map(() => 0));
// @ts-expect-error a method is not a constructor
t("new array map", () => new [].map(String));

// A `let` generator binding reassigned with a stage: the binding holds the
// runtime's helper object (the declared type cannot hold it), and the
// helpers keep answering.
let current = aFew();
current = current.filter((v) => v !== 2);
let count = 0;
for (const v of current) count++;
console.log(count);
const after = current.next();
console.log(after.value, after.done);
current = aFew().map((x) => x * 2);
console.log([...current].join(","), current.next().done);
