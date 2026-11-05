"use strict";
const { EventEmitter } = require("node:events");

class Ticker extends EventEmitter {
  constructor() {
    super();
    // Each emitter carries some weight, so leaked cycles show in memory.
    this.payload = new Array(256).fill(0).map((_, i) => ({ i }));
  }
  tick(n) {
    return this.emit("tick", n);
  }
}

// Allocates and drops JavaScript garbage so V8 runs its collector.
function churn(kib) {
  let total = 0;
  for (let i = 0; i < kib; i++) total += new Array(128).fill(i).length;
  return total;
}

// Emitters island code keeps alive on its own (a registry), whose native
// listeners must keep working whatever the collector does.
const kept = new Set();
function keep(emitter) {
  kept.add(emitter);
}
function tickAll(n) {
  let delivered = 0;
  for (const e of kept) if (e.tick(n)) delivered++;
  return delivered;
}

module.exports = { Ticker, churn, keep, kept, tickAll };
