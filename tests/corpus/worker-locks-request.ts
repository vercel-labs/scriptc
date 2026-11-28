// node:worker_threads' Web Locks manager: a request runs its callback while
// the lock is held, hands the callback a Lock, and the promise answers the
// callback's own result.
import { locks } from "node:worker_threads";

await locks.request("order", (lock) => console.log("held", lock.name, lock.mode));
console.log("result", JSON.stringify(await locks.request("order", () => "done")));
const order: string[] = [];
await locks.request("queue", () => {
  order.push("first");
});
await locks.request("queue", () => {
  order.push("second");
});
console.log("order", JSON.stringify(order));
