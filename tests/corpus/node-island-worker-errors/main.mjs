// @requires-libnode
// Errors a Node island throws at worker threads: fresh errors with own
// properties, and one error object the island throws at every caller. Three
// workers and the main thread catch them in the same turns. A caught error
// is read (its class, message, code, a property only the island error
// holds, `in`), passed back into the island, and thrown again by the
// island, where it must come back as the error the thread already caught.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function round(count, offset) {
  let fresh = 0;
  let own = 0;
  let back = 0;
  let again = 0;
  let shared = 0;
  for (let n = 0; n < count; n++) {
    const i = n + offset;
    try {
      lib.fail(i);
    } catch (e) {
      const code = e.code;
      const status = e.status;
      if (e instanceof RangeError && e.name === "RangeError" && e.message === "bad " + i && code === "E_BAD") fresh++;
      if (status === i % 7 && "status" in e && !("missing" in e)) own++;
      if (lib.status(e) === i % 7) back++;
      try {
        lib.rethrow(e);
      } catch (e2) {
        if (e2 === e) again++;
      }
    }
    try {
      lib.failShared();
    } catch (e) {
      if (e instanceof TypeError && e.message === "shared" && !(e instanceof RangeError)) shared++;
    }
  }
  return `${fresh} ${own} ${back} ${again} ${shared}`;
}

if (isMainThread) {
  const workers = 3;
  const answers = [];
  let done = 0;
  let rounds = 0;
  let ok = true;
  // A few catches per turn: the main thread answers the workers' island
  // operations between its own turns, so it must not fill them.
  const timer = setInterval(() => {
    if (round(2, rounds * 2) !== "2 2 2 2 2") ok = false;
    rounds++;
  }, 2);
  const finish = () => {
    clearInterval(timer);
    for (const answer of answers) console.log(answer);
    console.log("main", rounds > 0, ok);
    // An island error a worker does not catch reaches its 'error' listener.
    const last = new Worker(new URL(import.meta.url), { workerData: -1 });
    last.on("error", (e) => console.log("uncaught", e instanceof RangeError, e.name, e.message));
    last.on("exit", (code) => console.log("exit", code));
  };
  for (let w = 0; w < workers; w++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: w });
    worker.on("message", (message) => {
      answers[w] = message;
    });
    worker.on("exit", (code) => {
      if (code !== 0) console.log("worker", w, "exit", code);
      if (++done === workers) finish();
    });
  }
} else if (workerData === -1) {
  lib.fail(5);
} else {
  parentPort.postMessage(`worker ${workerData} ${round(400, workerData * 1000)}`);
}
