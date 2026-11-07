"use strict";
const log = (s) => console.log(s);
exports.count = function* count(label, n) {
  try {
    for (let i = 0; i < n; i++) {
      log(`${label} yields ${i}`);
      yield i;
    }
    return `${label} done`;
  } finally {
    log(`${label} finally`);
  }
};
exports.forever = function* forever() {
  let i = 0;
  try {
    for (;;) yield i++;
  } finally {
    log(`forever finally at ${i}`);
  }
};
exports.throwsAt = function* throwsAt(n) {
  for (let i = 0; ; i++) {
    if (i === n) throw new RangeError(`island generator threw at ${i}`);
    yield i;
  }
};
// An iterable that is not a generator: its iterator object has its own
// next and return, and counts the calls.
exports.custom = (n) => {
  const calls = { open: 0, next: 0, return: 0 };
  return {
    calls,
    [Symbol.iterator]() {
      calls.open++;
      let i = 0;
      return {
        next() {
          calls.next++;
          return i < n ? { value: `v${i++}`, done: false } : { value: undefined, done: true };
        },
        return(value) {
          calls.return++;
          return { value, done: true };
        },
      };
    },
  };
};
// An iterator without return: leaving the loop early calls nothing.
exports.noReturn = (n) => {
  let i = 0;
  return {
    [Symbol.iterator]() {
      return this;
    },
    next() {
      return i < n ? { value: i++, done: false } : { value: undefined, done: true };
    },
  };
};
exports.map = () => new Map([["a", 1], ["b", 2]]);
exports.set = () => new Set(["x", "y"]);
exports.entries = () => new Map([["k1", { n: 1 }], ["k2", { n: 2 }]]).entries();
exports.plain = () => ({ not: "iterable" });
exports.pairs = function* pairs() {
  log("pairs yields first");
  yield ["one", 1];
  log("pairs yields second");
  yield ["two", 2];
  log("pairs yields third");
  yield ["three", 3];
};
