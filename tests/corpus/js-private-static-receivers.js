// Static private members of a JavaScript class whose constructor object is
// materialized at run time (it has a public static accessor). The private
// members keep their native storage; every access through a receiver other
// than the class's own name checks that the receiver IS the declaring class,
// as Node does: a subclass, an object inheriting from the class, or a
// primitive throws V8's TypeError.

let calls = 0;
var Getter = class {
  static #method(a, b) {
    calls++;
    return a + b;
  }
  static get method() {
    return this.#method;
  }
};
console.log("getter method", Getter.method(1, 2), calls);

var Generators = class {
  static *#gen(n) {
    yield n;
    yield n + 1;
  }
  static async *#agen(n) {
    yield n * 2;
  }
  static get gen() {
    return this.#gen;
  }
  static get agen() {
    return this.#agen;
  }
};
console.log("generator", [...Generators.gen(3)].join(","));

class Counter {
  static #count = 5;
  static #label() {
    return "count:" + Counter.#count;
  }
  static get count() {
    return this.#count;
  }
  static set count(value) {
    this.#count = value;
  }
  static get label() {
    return this.#label;
  }
  static describe() {
    return this.#label();
  }
}
console.log("counter", Counter.count, Counter.label(), Counter.describe());
Counter.count = 9;
console.log("after write", Counter.count, Counter.describe());

class Sub extends Counter {}
const probes = [
  ["Sub.count", () => Sub.count],
  ["Sub.count =", () => {
    Sub.count = 1;
  }],
  ["Sub.label", () => Sub.label],
  ["Sub.describe()", () => Sub.describe()],
];
for (const [label, probe] of probes) {
  try {
    console.log(label, "returned", String(probe()));
  } catch (error) {
    console.log(label, error.constructor.name, error.message);
  }
}
console.log("unchanged", Counter.count);

// A private name is never a string key of the class object.
console.log("no string key", Object.hasOwn(Counter, "#count"), "#count" in Counter, Object.hasOwn(Getter, "#method"));

// Static initializers run in source order, private ones included.
const order = [];
class Ordered {
  static a = (order.push("a"), 1);
  static #b = (order.push("#b"), Ordered.a + 1);
  static c = (order.push("c"), Ordered.#b + 1);
  static {
    order.push("block " + Ordered.#b);
  }
  static get all() {
    return [this.a, this.#b, this.c].join(",");
  }
}
console.log("order", order.join(","), Ordered.all);

// A receiver passed in as a value: the same check. V8 names an anonymous
// class expression ".".
var Anonymous = class {
  static #m() {
    return "m";
  }
  static get m() {
    return this.#m;
  }
  static probe(other) {
    return typeof other.#m;
  }
};
console.log("probe self", Anonymous.probe(Anonymous), Anonymous.m());
for (const other of [{}, 1, undefined]) {
  try {
    Anonymous.probe(other);
  } catch (error) {
    console.log("probe", typeof other, error.constructor.name, error.message);
  }
}

Generators.agen(4)
  .next()
  .then((step) => console.log("async generator", step.value, step.done));

// A function-valued private static field called through `this` runs with
// `this` bound to the receiver; a receiver other than the class throws the
// field read's TypeError.
class Calls {
  static #fn = function (a) {
    return (this === Calls ? "self " : "other ") + a;
  };
  static #arrow = (a) => "arrow " + a;
  static get viaGetter() {
    return this.#fn(2) + " " + this.#arrow(2);
  }
  static viaOther(other, a) {
    return other.#fn(a);
  }
  static get fn() {
    return this.#fn;
  }
}
console.log("field call", Calls.viaGetter, Calls.viaOther(Calls, 3));
try {
  Calls.viaOther({}, 4);
} catch (error) {
  console.log("field call", error.constructor.name, error.message);
}

// Updates of a private static field through `this` update its storage.
class Updates {
  static #n = 1;
  static #s = "a";
  static get bump() {
    const a = this.#n++;
    const b = ++this.#n;
    const c = this.#n--;
    this.#n += 10;
    const d = (this.#n *= 2);
    this.#s += "b";
    return [a, b, c, d, this.#n, this.#s].join(",");
  }
}
console.log("updates", Updates.bump, Updates.bump, Object.hasOwn(Updates, "#n"));
class SubUpdates extends Updates {}
try {
  SubUpdates.bump;
} catch (error) {
  console.log("updates", error.constructor.name, error.message);
}

// A private static field holding a rest-parameter function, or one that
// reads `arguments`, receives every argument of a call through `this`.
class Rest {
  static #sum = function (...xs) {
    return (this === Rest ? "self " : "other ") + xs.length + ":" + xs.reduce((a, b) => a + b, 0);
  };
  static #arrow = (first, ...rest) => first + "|" + rest.join(",");
  static #plain = function (a, b) {
    return [a, b, arguments.length].join("/");
  };
  static get run() {
    return [this.#sum(1, 2, 3), this.#sum(), this.#arrow(1, 2, 3), this.#plain(1), this.#plain(1, 2, 3)].join(" ; ");
  }
}
console.log("rest", Rest.run);
