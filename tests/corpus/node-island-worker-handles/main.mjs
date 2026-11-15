// @requires-libnode
// Island values held by several threads: an object and a function every
// thread reads from the island (one island value, held and dropped by all
// of them in the same turns, so its last holder is any thread), and objects
// made for one thread. Then the operations the runtime answers through a
// function it loads from the island on first use (ToPrimitive, spread,
// inspect, structuredClone, the object tag): a worker is the first thread
// to use them and ends, the main thread uses them after it, and a second
// worker after that.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { inspect } from "node:util";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function use(count) {
  let total = 0;
  const kept = [];
  for (let i = 0; i < count; i++) {
    const shared = lib.shared;
    total += shared.name.length + shared.list.length;
    const add = lib.add;
    total += add(i) - i;
    const made = lib.make(i);
    if (made.i === i && made.tag === "t" + i) total++;
    kept.push(i % 3 === 0 ? shared : made);
    if (kept.length > 8) kept.shift();
  }
  return total + kept.length;
}

function helpers() {
  const point = new lib.Point(1, 2);
  const made = lib.make(5);
  return [
    String(point),
    `${point}`,
    [...lib.shared.list].join("+"),
    Object.keys(made).join(","),
    typeof lib.add,
    point instanceof lib.Point,
    inspect(made),
    structuredClone(made).tag,
    Object.prototype.toString.call(point),
  ].join(" | ");
}

if (isMainThread) {
  let mainTotal = 0;
  const timer = setInterval(() => {
    mainTotal += use(20);
  }, 1);
  const first = new Worker(new URL(import.meta.url), { workerData: "first" });
  first.on("message", (message) => console.log(message));
  first.on("exit", (code) => {
    console.log("first exit", code);
    console.log("main", helpers());
    const second = new Worker(new URL(import.meta.url), { workerData: "second" });
    second.on("message", (message) => console.log(message));
    second.on("exit", (code) => {
      clearInterval(timer);
      console.log("second exit", code, mainTotal > 0);
      console.log("main", helpers());
    });
  });
} else {
  parentPort.postMessage(`${workerData} ${helpers()}`);
  parentPort.postMessage(`${workerData} ${use(600)}`);
  parentPort.postMessage(`${workerData} ${helpers()}`);
}
