import { Worker, getEnvironmentData, isMainThread, parentPort, setEnvironmentData, workerData } from "node:worker_threads";

// setEnvironmentData/getEnvironmentData: keys compare with SameValueZero,
// undefined deletes, and each new Worker starts from a clone of its
// parent's entries taken at construction, which it passes on to its own
// workers.
if (isMainThread) {
  console.log("missing", getEnvironmentData("missing"));
  setEnvironmentData("a", 1);
  setEnvironmentData("config", { list: [1, 2], name: "x" });
  setEnvironmentData(42, "number key");
  setEnvironmentData(NaN, "nan key");
  setEnvironmentData(-0, "zero key");
  const key = { k: 1 };
  setEnvironmentData(key, "object key");
  const shared = { v: 1 };
  setEnvironmentData("shared", shared);
  console.log(getEnvironmentData("a"), getEnvironmentData(42), getEnvironmentData(NaN), getEnvironmentData(0));
  console.log("object key", getEnvironmentData(key), getEnvironmentData({ k: 1 }));
  console.log("same value", getEnvironmentData("shared") === shared);
  setEnvironmentData("gone", 5);
  setEnvironmentData("gone", undefined);
  setEnvironmentData("gone too", 5);
  setEnvironmentData("gone too");
  console.log("deleted", getEnvironmentData("gone"), getEnvironmentData("gone too"));

  const first = new Worker(new URL(import.meta.url), { workerData: "first" });
  setEnvironmentData("a", 2);
  first.on("message", (m: unknown) => console.log("first", JSON.stringify(m)));
  first.on("exit", (code: number) => {
    console.log("first exit", code, getEnvironmentData("a"), getEnvironmentData("set by worker"));
    const second = new Worker(new URL(import.meta.url), { workerData: "second" });
    second.on("message", (m: unknown) => console.log("second", JSON.stringify(m)));
    second.on("exit", (c: number) => console.log("second exit", c));
  });
} else if (workerData === "first" || workerData === "second") {
  parentPort!.postMessage([
    getEnvironmentData("a"),
    getEnvironmentData("config"),
    getEnvironmentData(42),
    getEnvironmentData(NaN),
    getEnvironmentData(0),
    getEnvironmentData("gone"),
  ]);
  setEnvironmentData("set by worker", true);
  setEnvironmentData("a", 10);
  if (workerData === "second") {
    const nested = new Worker(new URL(import.meta.url), { workerData: "nested" });
    nested.on("message", (m: unknown) => parentPort!.postMessage({ nested: m }));
  }
} else {
  parentPort!.postMessage([getEnvironmentData("set by worker"), getEnvironmentData("a"), getEnvironmentData("shared")]);
}
