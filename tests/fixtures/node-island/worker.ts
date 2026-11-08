// A call into Node from a worker thread (tests/harness/node-island.test.ts):
// the island belongs to the thread that started it (the main thread), so the
// worker's operations are posted to that thread and answered there — a
// synchronous call works. An asynchronous call, and awaiting an island value,
// would have to settle a promise on another thread's loop, so they reject by
// name instead.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { call, callSync, requireModule } from "@scriptc/node";
import { parts } from "thenable-pkg";

if (isMainThread) {
  console.log("main", callSync<number>("./helper.cjs", "answer"));
  // The island module has one instance for the whole program: the worker's
  // count continues this one (under Node a worker has an instance of its
  // own and counts from 1).
  console.log("main count", requireModule("./helper.cjs").count());
  // The island keeps a native object by reference: the export is the island
  // thread's object, so a worker asking for it back is refused by code.
  requireModule("./helper.cjs").keep({ tag: "kept" });
  requireModule("./helper.cjs").keepFunction(() => "main thread's");
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: string) => console.log("worker", message));
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  parentPort!.postMessage("called " + callSync<number>("./helper.cjs", "answer"));
  // The value the main thread kept: a native object passed by reference
  // belongs to the island's thread, so the worker's retrieval is refused.
  try {
    requireModule("./helper.cjs").get();
    parentPort!.postMessage("get taken");
  } catch (error) {
    parentPort!.postMessage("get " + (error as { code?: string }).code);
  }
  const helper = requireModule("./helper.cjs");
  parentPort!.postMessage("count " + helper.count());
  // What belongs to this thread's heap cannot cross: a function the island
  // would call back, bytes and symbols in either direction, and a native
  // error (it crosses by reference, like every native object). Each is refused by
  // code instead of being shared between two threads.
  const refused = (what: string, cross: () => unknown): void => {
    try {
      cross();
      parentPort!.postMessage(what + " crossed");
    } catch (error) {
      const refusal = error as { code?: string; message: string };
      parentPort!.postMessage(what + " " + refusal.code);
      // The message names the kind of value and the operation.
      parentPort!.postMessage("  " + refusal.message.slice(0, refusal.message.indexOf(";")));
    }
  };
  // A function the main thread passed in comes back as that thread's
  // function, which a worker must not get either.
  refused("function back", () => helper.getFunction());
  refused("callback", () => helper.callBack((n: number) => n + 1));
  refused("bytes out", () => helper.byteLength(new Uint8Array(4)));
  refused("bytes in", () => helper.bytes());
  refused("buffer out", () => helper.byteLength(new ArrayBuffer(4)));
  refused("buffer in", () => helper.buffer());
  refused("symbol out", () => helper.describe(Symbol("native")));
  refused("symbol in", () => helper.symbol());
  refused("error out", () => helper.errorName(new RangeError("native")));
  // A resolution with an island value reads its `then` on the island's
  // thread: an object without one fulfils the promise as itself, and a
  // thenable rejects by code (its job would pass this thread's resolving
  // functions to the island).
  Promise.resolve(helper.plain()).then(
    (value: { answer: number }) => parentPort!.postMessage("plain " + value.answer),
    (error: unknown) => parentPort!.postMessage("plain " + (error as { code?: string }).code),
  );
  Promise.resolve(helper.thenable()).then(
    (value: unknown) => parentPort!.postMessage("thenable " + String(value)),
    (error: unknown) => parentPort!.postMessage("thenable " + (error as { code?: string }).code),
  );
  call("./helper.cjs", "answer").then(
    () => parentPort!.postMessage("async called"),
    (error: unknown) => parentPort!.postMessage("async " + (error as { code?: string }).code),
  );
  // parts() answers a thenable: the worker holds it (a promise is refused
  // crossing into a thread, ERR_SCRIPTC_ISLAND_WORKER_VALUE), and awaiting
  // it would register the waiter in the island thread's table and settle
  // the promise there, so the await rejects by name like the call above.
  parts().then(
    (values) => parentPort!.postMessage("await " + values.length),
    (error: unknown) => parentPort!.postMessage("await " + (error as { code?: string }).code),
  );
}
