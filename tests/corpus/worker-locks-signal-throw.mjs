// A request with a signal releases its grant before the callback's throw
// reaches the request (Node's wrapped callback settles the lock), so a later
// same-name request runs; the same holds for a callback that returns a
// rejecting promise.
import { locks } from "node:worker_threads";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const first = new AbortController();
try {
  await locks.request("signal-throw", { signal: first.signal }, () => {
    throw new Error("signal boom");
  });
  console.log("throw resolved");
} catch (error) {
  console.log("throw rejected", error.name, error.message);
}
console.log("throw held", (await locks.query()).held.length);
console.log("throw later", await locks.request("signal-throw", () => "later"));

const second = new AbortController();
try {
  await locks.request("signal-async", { signal: second.signal }, () => Promise.reject(new Error("async boom")));
  console.log("async resolved");
} catch (error) {
  console.log("async rejected", error.name, error.message);
}
console.log("async held", (await locks.query()).held.length);
console.log("async later", await locks.request("signal-async", () => "later"));

let release;
const pending = new Promise((resolve) => (release = resolve));
const third = new AbortController();
const holder = locks.request("signal-abort", { signal: third.signal }, (lock) => {
  console.log("held callback", lock.name);
  return pending;
});
await tick();
third.abort();
console.log("abort busy", await locks.request("signal-abort", { ifAvailable: true }, (lock) => lock === null));
release();
await holder;
console.log("abort end", (await locks.query()).held.length);
