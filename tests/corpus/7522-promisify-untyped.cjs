// util.promisify over JavaScript functions whose types are not known:
// arrows, function expressions, methods and functions chosen at run time.
// The callback's error rejects and its first value fulfills, a
// synchronous throw rejects, the call's receiver reaches the function,
// the wrapper keeps the original's name and length, and arguments that
// are not functions throw Node's ERR_INVALID_ARG_TYPE.
"use strict";
const util = require("util");

function pick(kind) {
  if (kind === "double") return (value, callback) => setImmediate(() => callback(null, value * 2));
  if (kind === "fail") return function failing(callback) { callback(new RangeError("failed")); };
  if (kind === "throw") return () => { throw new TypeError("thrown"); };
  return null;
}

const store = {
  prefix: "item",
  read(key, callback) {
    setTimeout(() => callback(null, `${this.prefix}:${key}`, "ignored"), 1);
  },
};

async function main() {
  const double = util.promisify(pick("double"));
  console.log("double:", await double(21), double.name, double.length);
  try {
    await util.promisify(pick("fail"))();
  } catch (error) {
    console.log("rejected:", error.name, error.message);
  }
  try {
    await util.promisify(pick("throw"))();
  } catch (error) {
    console.log("sync:", error.name, error.message);
  }
  const read = util.promisify(store.read);
  console.log("unbound:", await read.call(store, "a"));
  store.readAsync = read;
  console.log("method:", await store.readAsync("b"));
  const bound = util.promisify(store.read.bind({ prefix: "bound" }));
  console.log("bound:", await bound("c"));
  const named = util.promisify(function lookup(a, b, callback) {
    callback(null, [a, b]);
  });
  console.log("named:", named.name, named.length, await named(1, 2));
  const values = [];
  for (const n of [1, 2, 3]) values.push(await double(n));
  console.log("each:", values);
  for (const value of [pick("none"), 42, "fn", {}, undefined]) {
    try {
      util.promisify(value);
    } catch (error) {
      console.log(error.name, error.code, error.message);
    }
  }
  try {
    util.promisify();
  } catch (error) {
    console.log(error.code, error.message);
  }
}

main();
