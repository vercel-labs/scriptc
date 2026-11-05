// @requires-libnode
// Cross-heap cycles through an island emitter (scope-B NI-8): a native
// object holds an island EventEmitter whose listener is a native closure
// capturing that object. Neither heap alone can free such a pair; the
// collector frees the pairs nothing holds and keeps the ones either side
// still holds, which keep working.
import { requireModule } from "@scriptc/node";

const { churn, keep, kept, Ticker, tickAll } = requireModule("./lib.cjs");

class Counter {
  constructor(name) {
    this.name = name;
    this.hits = 0;
    this.ticker = new Ticker();
    this.ticker.on("tick", (n) => {
      this.hits += n;
    });
  }
}

// Pairs held by native code, and pairs held by island code only.
const nativeKept = [];
let islandHeld = 0;
let total = 0;
for (let i = 0; i < 4000; i++) {
  const c = new Counter(`c${i}`);
  c.ticker.tick(1);
  total += c.hits;
  if (i % 500 === 0) nativeKept.push(c);
  if (i % 700 === 0) {
    keep(c.ticker);
    islandHeld++;
  }
  churn(4);
}
console.log("total", total, "native kept", nativeKept.length, "island kept", islandHeld);

// After the churn, every kept pair still works from both sides.
for (const c of nativeKept) c.ticker.tick(10);
console.log("native kept hits", nativeKept.map((c) => c.hits).join(","));
console.log("island delivered", tickAll(100), "registry", kept.size);
console.log("native kept hits", nativeKept.map((c) => c.hits).join(","));
