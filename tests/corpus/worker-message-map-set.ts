import { MessageChannel, Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
const self = fileURLToPath(import.meta.url);

// A message carries a Map or a Set like Node's serializer: entries in
// insertion order, deep values cloned, and a collection reached twice arriving
// as one instance. (A RegExp in a message still throws DataCloneError.)
if (isMainThread) {
  const worker = new Worker(self);
  let round = 0;
  worker.on("message", (value: any) => {
    round += 1;
    if (round === 1) {
      const map = value as Map<string, number>;
      console.log("map", map.size, JSON.stringify([...map.entries()]));
    } else if (round === 2) {
      const list = value as Map<object, object>[];
      const [first, second] = list;
      const entry = [...first!.entries()][0]!;
      console.log("same instance", first === second, entry[0] === entry[1]);
    } else if (round === 3) {
      const set = value as Set<string>;
      console.log("set", set.size, JSON.stringify([...set]));
    } else if (round === 4) {
      const set = value as Set<Map<string, number>>;
      const inner = [...set][0]!;
      console.log("set of maps", inner instanceof Map, inner.size, JSON.stringify([...inner.entries()]));
    }
  });
  worker.on("online", () => {
    worker.postMessage(new Map<string, number>([["a", 1], ["b", 2]]));
    const shared = { s: 1 };
    const twice = new Map<object, object>([[shared, shared]]);
    worker.postMessage([twice, twice]);
    worker.postMessage(new Set<string>(["x", "y", "x"]));
    worker.postMessage(new Set<Map<string, number>>([new Map<string, number>([["k", 1]])]));
  });

  // The same format carries a channel's messages.
  const { port1, port2 } = new MessageChannel();
  port1.on("message", (value: any) => {
    const map = value as Map<number, string>;
    console.log("channel map", map.size, JSON.stringify([...map.entries()]));
    port1.close();
    port2.close();
  });
  port1.start();
  port2.postMessage(new Map<number, string>([[1, "one"]]));
  setTimeout(() => worker.terminate(), 200);
} else {
  parentPort!.on("message", (value: any) => parentPort!.postMessage(value));
}
