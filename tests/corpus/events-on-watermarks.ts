// events.on's watermark controller, Node-exact: the iterator counts the
// events that arrive while no next() is parked, pauses the receiver once
// that count passes the high watermark, resumes it when next() takes the
// count below the low watermark, exposes size/low/high/isPaused through the
// nodejs.watermarkData symbol, and drops the counted event when the
// receiver's pause() throws.
import { EventEmitter, listenerCount, on } from "node:events";

function marks(it: unknown): any {
  return (it as any)[Symbol.for("nodejs.watermarkData")];
}

class Pausing extends EventEmitter {
  paused = false;
  log: string[] = [];
  pause(): void {
    this.paused = true;
    this.log.push("pause");
  }
  resume(): void {
    this.paused = false;
    this.log.push("resume");
  }
}

class Throwing extends EventEmitter {
  pause(): void {
    throw new Error("pause failed");
  }
}

async function main(): Promise<void> {
  const bus = new Pausing();
  const it = on(bus, "chunk", { highWaterMark: 2, lowWaterMark: 1 });
  const m = marks(it);
  console.log("start", m.size, m.low, m.high, m.isPaused, bus.paused, listenerCount(bus, "chunk"));

  // Two events stay below the high watermark; the third passes it.
  bus.emit("chunk", 1);
  bus.emit("chunk", 2);
  console.log("two", m.size, m.isPaused, bus.paused, bus.log.join(","));
  bus.emit("chunk", 3);
  console.log("three", m.size, m.isPaused, bus.paused, bus.log.join(","));

  // One next() per event: the count follows, the resume lands when the
  // count first falls below the low watermark.
  console.log("n1", JSON.stringify((await it.next()).value), m.size, m.isPaused, bus.paused);
  console.log("n2", JSON.stringify((await it.next()).value), m.size, m.isPaused, bus.paused);
  console.log("n3", JSON.stringify((await it.next()).value), m.size, m.isPaused, bus.paused);
  console.log("log", bus.log.join(","));

  // A parked next() takes the event directly: nothing counts, nothing
  // pauses, even past the high watermark.
  const parked = it.next();
  bus.emit("chunk", 4);
  bus.emit("chunk", 5);
  bus.emit("chunk", 6);
  console.log("parked", JSON.stringify((await parked).value), m.size, m.isPaused, bus.log.join(","));
  await it.return();

  // The defaults: no watermarks given, the high mark is MAX_SAFE_INTEGER.
  const plain = on(new EventEmitter(), "x");
  console.log("defaults", marks(plain).low, marks(plain).high, marks(plain).isPaused);
  await plain.return();

  // The alias spelling reaches the same slots.
  const aliased = on(new Pausing(), "x", { highWatermark: 4, lowWatermark: 3 });
  console.log("alias", marks(aliased).low, marks(aliased).high);
  await aliased.return();

  // A throwing pause(): the emit carries the fault, the value is dropped
  // though the count already moved.
  const throwing = new Throwing();
  const guarded = on(throwing, "chunk", { highWaterMark: 1 });
  throwing.emit("chunk", 1);
  try {
    throwing.emit("chunk", 2);
    console.log("pause resolved");
  } catch (err) {
    console.log("pause threw", (err as Error).message);
  }
  console.log("guarded", marks(guarded).size, marks(guarded).isPaused, JSON.stringify((await guarded.next()).value));
  console.log("guarded counts", listenerCount(throwing, "chunk"), listenerCount(throwing, "error"));
  await guarded.return();
  console.log("guarded after", listenerCount(throwing, "chunk"), listenerCount(throwing, "error"));
}

void main();
