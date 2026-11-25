"use strict";
exports.hello = (who) => `hello ${who}`;
exports.schedule = () => {
  setTimeout(() => console.log("NOT REACHED island timer"), 0);
  setImmediate(() => console.log("NOT REACHED island immediate"));
  process.nextTick(() => console.log("island tick queued during exit"));
  Promise.resolve().then(() => console.log("island microtask queued during exit"));
};
