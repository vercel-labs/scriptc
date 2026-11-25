// @requires-libnode
// Worker threads that end while they use a Node island: one is terminated
// by the main thread while it calls the island in a loop, one ends itself
// between two calls, and one is still calling when the main thread ends
// the process. Each end is the one Node reports, and none of them hangs.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

if (isMainThread) {
  const start = (kind) => new Worker(new URL(import.meta.url), { workerData: kind });
  const first = start("loop");
  first.once("message", () => {
    first.terminate();
  });
  first.on("exit", (code) => {
    console.log("terminated", code);
    const second = start("leave");
    second.on("exit", (code) => {
      console.log("left", code);
      const third = start("loop");
      third.once("message", () => {
        console.log("main", lib.echo("ends"));
        process.exit(0);
      });
    });
  });
} else if (workerData === "loop") {
  let calls = 0;
  for (;;) {
    calls += lib.echo("x").length;
    if (calls === 100) parentPort.postMessage("calling");
  }
} else {
  let calls = 0;
  for (let i = 0; i < 200; i++) calls += lib.echo("y").length;
  process.exit(calls === 200 ? 3 : 4);
}
