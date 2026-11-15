// events.on's watermark controller when pause() throws, Node-exact: the
// event that crossed the high watermark is counted and then dropped, the
// iterator stays paused, and the later next() calls drain the shorter queue.
// The entries that were dropped answer null, and the next() that takes the
// count below the low watermark resumes the receiver.
import { EventEmitter, listenerCount, on } from "node:events";

function marks(it: unknown): any {
  return (it as any)[Symbol.for("nodejs.watermarkData")];
}

class ThrowingPause extends EventEmitter {
  log: string[] = [];
  pause(): void {
    this.log.push("pause");
    throw new Error("pause failed");
  }
  resume(): void {
    this.log.push("resume");
  }
}

class ThrowingResume extends EventEmitter {
  log: string[] = [];
  pause(): void {
    this.log.push("pause");
  }
  resume(): void {
    this.log.push("resume");
    throw new Error("resume failed");
  }
}

async function main(): Promise<void> {
  const ee = new ThrowingPause();
  const it = on(ee, "chunk", { highWaterMark: 1, lowWaterMark: 1 });
  const m = marks(it);
  ee.emit("chunk", 1);
  console.log("one", m.size, m.isPaused, ee.log.join(","));
  try {
    ee.emit("chunk", 2);
    console.log("pause resolved");
  } catch (err) {
    console.log("pause threw", (err as Error).message);
  }
  console.log("two", m.size, m.isPaused, ee.log.join(","));
  ee.emit("chunk", 3);
  console.log("three", m.size, m.isPaused, ee.log.join(","));

  // Two values are counted, one was dropped: the first two next() calls
  // take the queued values, the third finds no entry and answers null as
  // it takes the count below the low watermark.
  for (let i = 0; i < 3; i++) {
    const result = await it.next();
    console.log("next", i, JSON.stringify(result.value), result.done, m.size, m.isPaused, ee.log.join(","));
  }

  // The iterator keeps working after the shortfall is drained.
  ee.emit("chunk", 4);
  console.log("four", m.size, m.isPaused, ee.log.join(","));
  console.log("n4", JSON.stringify((await it.next()).value), m.size, m.isPaused);
  console.log("counts", listenerCount(ee, "chunk"), listenerCount(ee, "error"));
  await it.return();
  console.log("after", listenerCount(ee, "chunk"), listenerCount(ee, "error"));

  // A throwing resume(): the next() that crosses the low watermark throws
  // with the value already taken, and the iterator stays paused.
  const resuming = new ThrowingResume();
  const second = on(resuming, "chunk", { highWaterMark: 1, lowWaterMark: 1 });
  const sm = marks(second);
  resuming.emit("chunk", 10);
  resuming.emit("chunk", 11);
  console.log("resume start", sm.size, sm.isPaused, resuming.log.join(","));
  try {
    const first = await second.next();
    console.log("resume first", JSON.stringify(first.value), sm.size);
    const result = await second.next();
    console.log("resume next", JSON.stringify(result.value));
  } catch (err) {
    console.log("resume threw", (err as Error).message, sm.size, sm.isPaused, resuming.log.join(","));
  }
  await second.return();
}

void main();
