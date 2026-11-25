// @requires-libnode
// Island packages whose load reads a clock. Node evaluates each load where
// it is required, so what the load read is never after the program's own
// reading taken on the next line. A load that waits for Node to start reads
// its clock then, after the program's readings (Date.now(),
// process.hrtime(), `new Date()`: the build once deferred these without
// constants), and one whose reading the build kept as a constant answers
// with the build's clock (performance.now(), which the load recorder did
// not list). A load that reads a clock evaluates where it is imported.
function nanoseconds() {
  const t = process.hrtime();
  return t[0] * 1e9 + t[1];
}

const stamp = require("stamp-kit");
const afterStamp = Date.now();
const made = require("made-kit");
const afterMade = Date.now();
const tick = require("tick-kit");
const afterTick = nanoseconds();
const timer = require("timer-kit");
const afterTimer = performance.now();

// Time passes before the program looks at what the loads read.
const until = Date.now() + 30;
while (Date.now() < until) {}

console.log("Date.now() at load, then the program's:", stamp.at <= afterStamp);
console.log("new Date() at load, then the program's:", made.at <= afterMade);
console.log("process.hrtime() at load, then the program's:", tick.at <= afterTick);
console.log("performance.now() at load, then the program's:", timer.at <= afterTimer);
