"use strict";
console.log("lib evaluating");
exports.hello = (who) => `hello ${who}`;
exports.schedule = () => {
  setTimeout(() => console.log("NOT REACHED island timer"), 0);
  process.nextTick(() => console.log("NOT REACHED tick"));
  Promise.resolve().then(() => console.log("NOT REACHED microtask"));
  process.on("exit", () => console.log("NOT REACHED: exit listener added during exit"));
};
