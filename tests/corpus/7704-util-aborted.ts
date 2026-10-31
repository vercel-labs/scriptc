// util.aborted in TypeScript: the listener resists stopImmediatePropagation,
// and the promise settles two microtask turns after the signal's own
// promise, as an async function's result adopts it.
import { aborted } from "node:util";
const ac = new AbortController();
ac.signal.addEventListener("abort", (e) => {
  console.log("first listener stops propagation");
  e.stopImmediatePropagation();
});
const resource = { name: "job" };
const order: string[] = [];
aborted(ac.signal, resource).then(() => order.push("aborted"));
Promise.resolve().then(() => order.push("tick 1")).then(() => order.push("tick 2"));
ac.abort();
setTimeout(() => console.log(order), 0);
const done = new AbortController();
done.abort();
const seq: string[] = [];
aborted(done.signal, resource).then(() => seq.push("already"));
Promise.resolve().then(() => seq.push("a")).then(() => seq.push("b")).then(() => seq.push("c"));
setTimeout(() => console.log(seq), 0);
