// @requires-libnode
// Weak collections keyed by island objects, on worker threads and the main
// thread. The entries of such a collection live in a collection inside the
// island, reached through a function the runtime compiles there on first
// use: a worker is the first thread to use it and ends, the main thread
// uses it after that worker, and a second worker after that. Each thread's
// collections are its own. The values are numbers and island objects (a
// native object as a value crosses by reference, which a worker refuses).
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function weak(count) {
  const map = new WeakMap();
  const set = new WeakSet();
  const kept = [];
  let found = 0;
  for (let i = 0; i < count; i++) {
    const key = lib.make(i);
    map.set(key, i);
    set.add(key);
    if (map.get(key) === i && map.has(key) && set.has(key)) found++;
    if (i % 4 === 0) kept.push(key);
    else if (i % 4 === 1) found += map.delete(key) && !map.has(key) && set.delete(key) ? 1 : 0;
  }
  let again = 0;
  for (const key of kept) if (map.get(key) === key.i && set.has(key)) again++;
  const shared = lib.shared;
  map.set(shared, lib.make(-1));
  const held = map.get(shared);
  return `${found} ${again} ${held.i} ${map.has(lib.shared)} ${set.has(lib.shared)}`;
}

if (isMainThread) {
  const first = new Worker(new URL(import.meta.url), { workerData: "first" });
  first.on("message", (message) => console.log(message));
  first.on("exit", (code) => {
    console.log("first exit", code);
    console.log("main", weak(200));
    const second = new Worker(new URL(import.meta.url), { workerData: "second" });
    second.on("message", (message) => console.log(message));
    second.on("exit", (code) => {
      console.log("second exit", code);
      console.log("main", weak(200));
    });
  });
} else {
  parentPort.postMessage(`${workerData} ${weak(300)}`);
}
