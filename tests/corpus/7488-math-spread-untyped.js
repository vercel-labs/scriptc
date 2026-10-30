// Math.max/Math.min spreading an untyped iterable (zod's
// `Math.min(...caps.map((c) => c[0]))`).
function caps(list) {
  return list.map((c) => c[0]);
}
console.log(Math.min(...caps([[5], [2], [9]])), Math.max(...caps([[5], [2], [9]])));
console.log(Math.min(...caps([])), Math.max(...caps([])));
console.log(Math.min(...caps([["3"], [true], [null]])), Math.max(...caps([["7"], [undefined]])));
console.log(Object.is(Math.max(...caps([[-0], [0]])), 0), Object.is(Math.min(...caps([[0], [-0]])), -0));
const order = [];
const valued = (n) => ({ valueOf() { order.push(n); return n; } });
console.log(Math.max(...caps([[valued(1)], [NaN], [valued(3)]])), order.join(","));
try {
  Math.min(...caps([[{ valueOf() { throw new Error("boom"); } }]]));
} catch (e) {
  console.log(e.message);
}
const sources = { none: undefined, nil: null, num: 5, obj: {}, str: "48" };
function pick(k) {
  return sources[k];
}
for (const k of Object.keys(sources)) {
  try {
    console.log(Math.max(...sources[k]));
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
  try {
    console.log(Math.min(...pick(k)));
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
}

// Iterables that step through the iterator protocol, reached through an
// untyped lookup: a generator, an object with a Symbol.iterator method, a
// Set, a Map's keys() and an iterator that ends early.
function* generate(values) {
  for (const value of values) yield value;
}
const makers = {
  generator: () => generate([4, "1", 7]),
  custom: () => ({
    *[Symbol.iterator]() {
      yield 10;
      yield -2;
    },
  }),
  set: () => new Set([3, 8, 3]),
  keys: () => new Map([[2, "a"], [6, "b"]]).keys(),
  empty: () => generate([]),
};
for (const k of Object.keys(makers)) {
  console.log(k, Math.min(...makers[k]()), Math.max(...makers[k]()));
}
const stepped = [];
const counting = {
  [Symbol.iterator]() {
    let n = 0;
    return {
      next() {
        stepped.push(n);
        return n < 3 ? { value: n++, done: false } : { value: undefined, done: true };
      },
    };
  },
};
const lookup = { counting };
console.log(Math.max(...lookup.counting), stepped.join(","));
