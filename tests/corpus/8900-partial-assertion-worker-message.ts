import { Worker, isMainThread, parentPort } from "node:worker_threads";

// A record built by filling in an asserted empty literal, in a program that
// starts a worker. The object is completed in place on the thread that made
// it; a message carries a copy, so each side keeps its own object, and the
// worker fills in objects of its own.
type Key = "alpha" | "beta" | "gamma";
type Row = Record<Key, number>;
const ORDER: Key[] = ["gamma", "alpha", "beta"];

function fill(seed: number): Row {
  const row = {} as Row;
  for (const key of ORDER) row[key] = seed + key.length;
  return row;
}

function show(row: Row): string {
  return Object.keys(row).join(",") + ":" + JSON.stringify(row);
}

if (isMainThread) {
  const mine = fill(1);
  const alias = mine;
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (reply: Row) => {
    console.log("main got", show(reply));
    // The reply is main's own copy: writing it changes nothing else.
    reply.alpha = -1;
    console.log("main keeps", show(mine), alias === mine, Object.isFrozen(mine));
  });
  worker.postMessage(mine);
  // The worker was sent the object as it was when it was posted.
  mine.beta = 100;
  console.log("main sent", show(mine));
} else {
  parentPort!.once("message", (got: Row) => {
    const own = fill(10);
    own.gamma += got.gamma + got.beta;
    // Freezing the worker's object does not reach the main thread's.
    Object.freeze(own);
    let outcome = "wrote";
    try {
      own.alpha = 0;
    } catch (error) {
      outcome = error instanceof TypeError ? "TypeError" : "other";
    }
    got.alpha = 7;
    parentPort!.postMessage({ alpha: own.alpha, beta: got.alpha, gamma: outcome === "TypeError" ? own.gamma : -1 });
  });
}
