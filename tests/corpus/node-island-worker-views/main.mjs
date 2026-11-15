// @requires-libnode
// Byte views and symbols on the main thread while worker threads catch
// island errors. The two share one table of paired values: a worker pairs
// an error of its own with each island error it catches and lets it go
// again, while the main thread pairs views, their buffers and symbols, and
// lets most of them go at its next island operation. Every value must keep
// its identity on its own thread whatever the other threads do meanwhile.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

// Any thread: island errors, fresh ones and one every caller gets, caught
// and thrown again by the island.
function errors(count, offset) {
  let fresh = 0;
  let again = 0;
  let shared = 0;
  for (let n = 0; n < count; n++) {
    const i = n + offset;
    try {
      lib.fail(i);
    } catch (e) {
      if (e instanceof RangeError && e.message === "bad " + i) fresh++;
      try {
        lib.rethrow(e);
      } catch (e2) {
        if (e2 === e) again++;
      }
    }
    try {
      lib.failShared();
    } catch (e) {
      if (e instanceof TypeError && e.message === "shared") shared++;
    }
  }
  return `${fresh} ${again} ${shared}`;
}

if (isMainThread) {
  // The main thread only: a view the program keeps, a registered symbol as
  // a key, an island symbol and an island buffer that come back each time.
  const held = new Uint8Array(16);
  const key = Symbol.for("views.key");
  const tagged = lib.tagged(key);
  const islandSymbol = lib.symbol();
  const kept = lib.kept();
  const views = (count) => {
    let chunks = 0;
    let young = 0;
    let same = 0;
    let symbols = 0;
    // The island cuts a chunk from its pool for each call of the listener.
    chunks += lib.feed(count, (chunk) => {
      chunks += chunk.length;
    });
    for (let i = 0; i < count; i++) {
      const fresh = new Uint8Array(8);
      fresh[0] = i + 1;
      if (lib.first(fresh) === i + 1 && lib.echo(fresh) === fresh) young++;
      if (lib.echo(held) === held && lib.kept() === kept) same++;
      if (tagged[key] === 1 && lib.symbol() === islandSymbol && lib.echo(key) === key) symbols++;
    }
    return `${chunks} ${young} ${same} ${symbols}`;
  };
  const workers = 3;
  const answers = [];
  let done = 0;
  let rounds = 0;
  let ok = true;
  // A little per turn: the main thread answers the workers' island
  // operations between its own turns, so it must not fill them.
  const timer = setInterval(() => {
    if (views(4) !== "68 4 4 4") ok = false;
    if (errors(2, rounds * 2) !== "2 2 2") ok = false;
    rounds++;
  }, 2);
  for (let w = 0; w < workers; w++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: w });
    worker.on("message", (message) => {
      answers[w] = message;
    });
    worker.on("exit", (code) => {
      if (code !== 0) console.log("worker", w, "exit", code);
      if (++done < workers) return;
      clearInterval(timer);
      for (const answer of answers) console.log(answer);
      // Once more with every worker gone: what they paired is released.
      console.log("main", rounds > 0, ok, views(8), errors(3, 0));
    });
  }
} else {
  parentPort.postMessage(`worker ${workerData} ${errors(400, workerData * 1000)}`);
}
