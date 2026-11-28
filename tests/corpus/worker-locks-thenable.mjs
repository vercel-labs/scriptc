// A callback result that is a thenable is resolved like a promise: with a
// signal the grant is held until the thenable settles, as Node's wrapper
// promise adopts it; without a signal the grant releases at once and the
// request still answers the thenable's value.
import { locks } from "node:worker_threads";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const controller = new AbortController();
let settle;
const held = {
  then(resolve) {
    settle = resolve;
  },
};
const first = locks.request("thenable-signal", { signal: controller.signal }, () => held);
await tick();
console.log("signal held", (await locks.query()).held.length);
const second = locks.request("thenable-signal", () => "second");
let secondState = "pending";
second.then((value) => {
  secondState = `resolved ${value}`;
});
await tick();
console.log("second before settle", secondState);
settle("thenable value");
console.log("first", await first);
await tick();
console.log("second after", secondState);

let releasePlain;
const plain = {
  then(resolve) {
    releasePlain = resolve;
  },
};
const third = locks.request("thenable-plain", () => plain);
await tick();
console.log("plain held", (await locks.query()).held.length);
console.log("fourth", await locks.request("thenable-plain", () => "fourth"));
releasePlain("plain value");
console.log("third", await third);
