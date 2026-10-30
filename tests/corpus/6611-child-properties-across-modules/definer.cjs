"use strict";
// Replaces kill through Reflect.defineProperty on a child it receives, and
// defines a getter-only property with a long name.
const start = require("./spawner.cjs");
module.exports = function run() {
  const child = start();
  const original = child.kill.bind(child);
  const kill = {
    value(signal) {
      child.killedBy = "replaced " + signal;
      return original(signal);
    },
    configurable: true,
    writable: true,
  };
  Reflect.defineProperty(child, "kill", kill);
  Reflect.defineProperty(child, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", { get() { return 1; }, configurable: true });
  try {
    child.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx = 2;
  } catch (e) {
    console.log(e instanceof TypeError, e.message.length, e.message.slice(0, 30), e.message.slice(-40));
  }
  child.on("close", (code) => console.log("close", code, child.killedBy));
  child.stdout.once("data", () => child.kill("SIGTERM"));
};
