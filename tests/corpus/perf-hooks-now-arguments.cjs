// performance.now ignores the arguments it is given, but a call's arguments
// still evaluate, in source order, before the clock reads: a JavaScript
// source can spell that call where the declarations cannot. The clock
// itself is fractional milliseconds on the process-start origin, and
// performance.now.bind(performance) answers the same clock as a plain
// function value.
const { performance } = require("node:perf_hooks");

const order = [];
const arg = (label, value) => {
  order.push(label);
  return value;
};

const t = performance.now(arg("one", 1), arg("two", "two"), arg("three", null));
console.log(typeof t, t >= 0, order.join(","));

const throwing = (label) => {
  order.push(label);
  throw new Error("argument");
};
try {
  performance.now(arg("four", 0), throwing("five"), arg("six", 0));
  console.log("no throw");
} catch (error) {
  console.log("threw", error.message, order.join(","));
}

const clock = performance.now.bind(performance);
console.log(typeof clock(), clock() >= 0);
console.log(performance.now.name, performance.now.length, performance.now() >= t);
console.log(performance.timeOrigin > 0, Number.isFinite(performance.timeOrigin));
console.log(performance.timeOrigin === performance.timeOrigin);
