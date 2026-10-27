"use strict";
// Adds properties to a child it receives, without loading child_process:
// a replaced method, an accessor pair and a getter-only accessor, which
// run with the child as `this`.
const start = require("./spawner.cjs");
module.exports = function patched() {
  const child = start();
  const kill = child.kill.bind(child);
  child.kill = (signal) => {
    child.killedBy = "patched " + signal;
    return kill(signal);
  };
  Reflect.defineProperty(child, "label", {
    get() {
      return typeof this.pid + " " + this.killed;
    },
    set(value) {
      this.stored = "set " + value;
    },
    enumerable: false,
    configurable: true,
  });
  Reflect.defineProperty(child, "same", {
    get() {
      return this === child;
    },
    configurable: true,
  });
  return child;
};
