// removeAllListeners(name) and removeAllListeners() drop several listeners
// at once. Each listener captures a record that the cycle collector traces
// (it has a callback member) and that outlives the listener, so releasing a
// listener hands the collector a candidate, and after enough of them a
// collection runs in the middle of the removal. The collection walks the
// emitter's listeners: it must find only the ones still registered. The
// output is plain arithmetic; the sanitized lane fails when the collector
// reads a listener that the removal has already freed.
import { EventEmitter } from "node:events";

type Scale = { name: string; dial: EventEmitter; total: number; onTare: (() => void) | null };

let grand = 0;
let tares = 0;

function weigh(round: number, everything: boolean): void {
  const dial = new EventEmitter();
  const left: Scale = { name: "l" + round, dial, total: 0, onTare: null };
  const right: Scale = { name: "r" + round, dial, total: 0, onTare: null };
  left.onTare = () => {
    tares += right.total > 0 ? 1 : 0;
  };
  right.onTare = () => {
    tares += left.total > 0 ? 1 : 0;
  };
  dial.on("load", (grams: number) => {
    left.total += grams;
  });
  dial.on("load", (grams: number) => {
    right.total += grams + left.name.length;
  });
  dial.on("load", (grams: number) => {
    grand += grams % 3;
  });
  dial.on("tare", () => {
    if (left.onTare !== null) left.onTare();
    if (right.onTare !== null) right.onTare();
  });
  dial.emit("load", round + 1);
  dial.emit("tare");
  grand += left.total + right.total;
  if (everything) {
    dial.removeAllListeners();
  } else {
    dial.removeAllListeners("load");
  }
  grand += dial.listenerCount("load") + dial.listenerCount("tare");
}

for (let round = 0; round < 400; round++) {
  weigh(round, false);
}
console.log("by name", grand, tares);
for (let round = 0; round < 400; round++) {
  weigh(round, true);
}
console.log("all", grand, tares);
