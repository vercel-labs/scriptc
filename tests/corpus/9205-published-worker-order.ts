// A published record and a published class instance reaching a worker: the
// worker's self-append over the maximum string length throws the RangeError
// before the published write guard's TypeError (Node's right-hand-side
// order), and the shared state stays race-free.
"use strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { publish } from "@scriptc/threads";

const half = "a".repeat(268435445);

interface Rec {
  s: string;
}

class Holder {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
}

if (isMainThread) {
  console.log(half.length);
  const rec: Rec = { s: half };
  publish(rec);
  const box = new Holder(half);
  publish(box);
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { rec, box } satisfies { rec: Rec; box: Holder },
  });
  worker.on("message", (value: unknown) => console.log("worker", String(value)));
  worker.on("error", (error: Error) => console.log("worker error", error.message));
  worker.on("exit", (code: number) => console.log("worker exit", code));
} else {
  const data = workerData as { rec: Rec; box: Holder };
  try {
    data.rec.s += half + "b";
    console.log("record built");
  } catch (error) {
    const e = error as Error;
    console.log("record", e.name, e.message);
  }
  try {
    data.box.s += half + "b";
    console.log("class built");
  } catch (error) {
    const e = error as Error;
    console.log("class", e.name, e.message);
  }
  parentPort?.postMessage("done");
}
