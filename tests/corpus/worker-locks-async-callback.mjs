// A lock callback that returns a promise keeps the lock until that promise
// settles: the lock reads as held meanwhile, a same-name request waits, and
// the request answers with the promise's own value.
import { locks } from "node:worker_threads";

const log = [];
let release;
const first = locks.request("x", () => {
  log.push("first started");
  return new Promise((resolve) => {
    release = resolve;
  });
});
await new Promise((r) => setTimeout(r, 10));
console.log("held while pending", (await locks.query()).held.map((l) => l.name).join(","));
const second = locks.request("x", () => {
  log.push("second");
  return "second-result";
});
await new Promise((r) => setTimeout(r, 10));
const snapshot = await locks.query();
console.log("pending", snapshot.pending.map((l) => l.name).join(","), "held", snapshot.held.map((l) => l.name).join(","));
release("first-result");
console.log("first", JSON.stringify(await first));
console.log("second", JSON.stringify(await second));
console.log("log", log.join(","));
