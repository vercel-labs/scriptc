// ifAvailable takes the lock while the name is free and answers a null lock
// while it is busy: the miss holds and queues nothing, and the request
// resolves with the callback's own result (a returned promise included).
import { locks } from "node:worker_threads";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const free = await locks.request("ifavail", { ifAvailable: true }, (lock) => `${lock.name} ${lock.mode}`);
console.log("free", free);
console.log("free held", (await locks.query()).held.length);

let release;
const held = new Promise((resolve) => (release = resolve));
const holder = locks.request("ifavail", () => held);
await tick();

const busy = await locks.request("ifavail", { ifAvailable: true }, (lock) => lock === null);
console.log("busy null", busy);
const late = await locks.request("ifavail", { ifAvailable: true }, () => Promise.resolve("late"));
console.log("busy promise", late);
const snapshot = await locks.query();
console.log("busy held", snapshot.held.length, "pending", snapshot.pending.length);

try {
  await locks.request("ifavail", { ifAvailable: true }, () => {
    throw new Error("ifAvailable boom");
  });
  console.log("busy throw resolved");
} catch (error) {
  console.log("busy throw", error.name, error.message);
}
const thrownSnapshot = await locks.query();
console.log("busy throw held", thrownSnapshot.held.length, "pending", thrownSnapshot.pending.length);

release();
await holder;
console.log("after", (await locks.query()).held.length);
