// Consecutive I/O callbacks that each queue an immediate and a due timer:
// every immediate must run before its own timer, Node's poll-to-check order.
// A loop that defers its timers for the second callback while the first
// callback's deferral is still in force would run that timer first.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const file = path.join(os.tmpdir(), `scriptc-immediate-own-timer-${process.pid}.txt`);
fs.writeFileSync(file, "x");

const order = [];
let completed = 0;
for (const tag of [1, 2]) {
  fs.readFile(file, () => {
    setImmediate(() => order.push(`immediate ${tag}`));
    setTimeout(() => {
      order.push(`timer ${tag}`);
      completed += 1;
      if (completed < 2) return;
      const at = (label) => order.indexOf(label);
      console.log("immediate before timer 1:", at("immediate 1") < at("timer 1"));
      console.log("immediate before timer 2:", at("immediate 2") < at("timer 2"));
    }, 0);
  });
}
