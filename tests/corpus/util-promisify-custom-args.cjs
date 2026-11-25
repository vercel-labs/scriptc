// util.promisify.custom in JavaScript: the key is
// Symbol.for('nodejs.util.promisify.custom'). A truthy value there must be
// a function (anything else throws Node's ERR_INVALID_ARG_TYPE naming the
// property and the received type) and is what promisify answers; a falsy
// value (null, undefined, 0, '', false) leaves the wrapper. A class is a
// function and is accepted. A truthy non-function behind a getter throws
// on the same read, and a custom property that is not inherited leaves the
// wrapper alone.
"use strict";
const util = require("util");

const key = util.promisify.custom;
console.log("key:", typeof key, key === Symbol.for("nodejs.util.promisify.custom"));
console.log("description:", key.description);

const values = [42, "x", { a: 1 }, [1], true, 1n, Symbol("s")];
for (const value of values) {
  const fn = function fn(callback) {
    callback(null, 1);
  };
  Object.defineProperty(fn, key, { value, configurable: true });
  try {
    const out = util.promisify(fn);
    console.log("no throw:", out !== fn);
  } catch (error) {
    console.log("throw:", error.name, error.code, error.message);
  }
}

const falsy = [null, undefined, 0, "", false];
for (const value of falsy) {
  const fn = function fallback(callback) {
    callback(null, 2);
  };
  Object.defineProperty(fn, key, { value, configurable: true });
  const out = util.promisify(fn);
  const descriptor = Object.getOwnPropertyDescriptor(out, key);
  console.log(
    "falsy:",
    value === null ? "null" : typeof value,
    out !== fn,
    descriptor.value === out,
    descriptor.enumerable,
  );
}

class CustomClass {
  static run(value) {
    return Promise.resolve(value * 3);
  }
}
const plain = function plain(callback) {
  callback(null, 0);
};
Object.defineProperty(plain, key, { value: CustomClass, configurable: true });
const classCustom = util.promisify(plain);
console.log("class:", classCustom === CustomClass, classCustom.run(4) instanceof Promise);

let reads = 0;
const getter = function getter() {};
Object.defineProperty(getter, key, {
  get() {
    reads++;
    return "not a function";
  },
  configurable: true,
});
try {
  util.promisify(getter);
} catch (error) {
  console.log("getter:", reads, error.code, error.message);
}

// The truthiness test and the value validated are two separate reads: a
// getter that answers a function first and something else after it fails,
// and a getter that answers undefined first is falsy, leaving the wrapper.
function reading(values) {
  let index = 0;
  const fn = function reading(callback) {
    callback(null, values.length);
  };
  Object.defineProperty(fn, key, {
    get() {
      return values[Math.min(index++, values.length - 1)];
    },
    configurable: true,
  });
  return fn;
}
for (const values of [
  [function first() {}, undefined],
  [function first() {}, 7],
  [undefined, function second() {}],
]) {
  try {
    const out = util.promisify(reading(values));
    console.log("varying:", typeof out, out !== undefined);
  } catch (error) {
    console.log("varying throw:", error.code, error.message);
  }
}

function relative(a, callback) {
  callback(null, a);
}
Object.defineProperty(relative, "own", { value: 1, enumerable: true, configurable: true });
const copied = util.promisify(relative);
console.log("own copy:", copied.own, Object.getOwnPropertyNames(copied).join(","));
console.log("twice:", util.promisify(copied) === copied);
copied(9).then((value) => console.log("settled:", value));
