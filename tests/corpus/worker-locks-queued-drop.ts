// A queued request whose promise the program drops still runs when the lock
// frees: the queue keeps its own reference, so draining it never settles a
// promise the program has already released.
import { locks } from "node:worker_threads";

const order: string[] = [];
let release!: () => void;
const holder = locks.request("collide", () => new Promise<void>((resolve) => (release = resolve)));
await new Promise((resolve) => setTimeout(resolve, 10));
{
  const dropped = locks.request("collide", () => {
    order.push("queued");
  });
  void dropped;
}
release();
await holder;
console.log("order", JSON.stringify(order));
