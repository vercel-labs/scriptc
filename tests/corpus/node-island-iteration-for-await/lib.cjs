"use strict";
const log = (s) => console.log(s);
exports.count = async function* count(label, n) {
  try {
    for (let i = 0; i < n; i++) {
      log(`${label} yields ${i}`);
      yield i;
      await null;
    }
    return `${label} done`;
  } finally {
    log(`${label} finally`);
  }
};
exports.sync = function* sync(label, n) {
  try {
    for (let i = 0; i < n; i++) yield Promise.resolve(`${label} ${i}`);
  } finally {
    log(`${label} finally`);
  }
};
exports.rejects = async function* rejects() {
  yield 1;
  throw new TypeError("island async generator rejected");
};
exports.slow = async function* slow() {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield `slow ${i}`;
  }
};
// An async iterable that is not a generator.
exports.custom = (n) => {
  const calls = { next: 0, return: 0 };
  return {
    calls,
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          calls.next++;
          return Promise.resolve(i < n ? { value: i++, done: false } : { value: undefined, done: true });
        },
        return() {
          calls.return++;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
};
exports.plain = () => ({ not: "iterable" });
