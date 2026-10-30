// Untyped code calls function values with numbers: object literal
// methods, closures held in arrays and objects, `this`, missing and extra
// arguments, `arguments`, captured bindings, recursion by name, throws,
// callbacks of builtins, bound functions, proxies and non-functions.
import assert from "node:assert";

const tally = {
  total: 0,
  add(value) {
    this.total += value;
    return this.total;
  },
  scaled(value, k) {
    return value * (k ?? 2);
  },
  count() {
    return arguments.length;
  },
};
let sum = 0;
for (let i = 0; i < 500; i++) sum += tally.add((i % 7) * 0.5) % 11;
console.log(sum, tally.total);
console.log(tally.scaled(1.5), tally.scaled(1.5, 3), tally.scaled(1.5, 3, 99), tally.count(1, 2.5, 3));

let captured = 0.25;
const step = (dx) => {
  captured += dx;
  return captured;
};
const fns = [step, (v) => v * v, (a, b) => a - b];
let acc = 0;
for (let i = 0; i < 300; i++) acc += fns[i % 3](i * 0.5, 1.5);
console.log(acc, captured);

const ops = {
  inc: (v) => v + 1,
  fact: function fact(n) {
    return n <= 1 ? 1 : n * fact(n - 1);
  },
};
console.log(ops.inc(41.5), ops.fact(10), ops.fact(1.5));

const holder = { k: 3, read(v) { return this.k * v; } };
const read = holder.read;
console.log(holder.read(2.5), read.call({ k: 10 }, 2.5), read.bind({ k: 4 })(2.5));

const checked = {
  limit(v) {
    if (v > 10) throw new RangeError("too large: " + v);
    return v;
  },
};
let caught = 0;
for (let i = 0; i < 20; i++) {
  try {
    acc += checked.limit(i * 0.75);
  } catch (e) {
    if (caught++ === 0) console.log(e instanceof RangeError, e.message);
  }
}
console.log(caught, acc);

console.log([1.5, 2.5, 3.5].map((v) => ops.inc(v)).join(","), [1, 2, 3].reduce((a, b) => a + b * 0.5, 0));
const proxied = new Proxy(ops.inc, { apply: (target, self, args) => target(args[0] * 10) });
console.log(proxied(2.5));
class Point {}
const values = { notFn: 5, cls: Point, inc: ops.inc };
for (const key of ["notFn", "cls", "inc"]) {
  try {
    console.log(key, values[key](1.5));
  } catch (e) {
    console.log(key, e.constructor.name, e.message);
  }
}
const big = { mul: (v) => v * 1e308 };
console.log(big.mul(10), big.mul(-10), Object.is(big.mul(-0), -0), big.mul(NaN));


// A library call that throws inside a function value's body reaches the
// call through the value.
const succeeded = (fn) =>
  function (err, v) {
    assert.ifError(err);
    return fn(v * 2);
  };
for (const err of [null, new TypeError("boom"), 0]) {
  try {
    console.log(succeeded((v) => v + 0.5)(err, 1.25));
  } catch (e) {
    console.log(e.message);
  }
}
