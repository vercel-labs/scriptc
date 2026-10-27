import { BroadcastChannel } from "node:worker_threads";

// BroadcastChannel within one thread: delivery to every other channel with
// the name (not the sender), per channel in creation order before
// setImmediate, MessageEvent fields, listeners, and the errors.
const a = new BroadcastChannel("o");
const b = new BroadcastChannel("o");
const c = new BroadcastChannel("o");
const other = new BroadcastChannel("p");
const log = (n: string) => (e: MessageEvent) =>
  console.log(n, JSON.stringify(e.data), e.type, e.origin === "", e.lastEventId === "", e.source, e.isTrusted, e.target === (n === "a" ? a : n === "b" ? b : c));
a.onmessage = log("a");
b.onmessage = log("b");
c.onmessage = log("c");
c.addEventListener("message", (e: Event) => console.log("c listener", JSON.stringify((e as MessageEvent).data)));
other.onmessage = () => console.log("other got (should not)");
a.postMessage("from a");
b.postMessage({ from: "b" });
console.log("name", a.name, typeof b.onmessage, b.onmessageerror);
const named = new BroadcastChannel(String(42));
console.log("coerced", named.name);
named.close();
try {
  named.postMessage(1);
} catch (err) {
  const e = err as Error;
  console.log(e.name, e.message);
}
setImmediate(() => {
  console.log("immediate");
  a.close();
  b.close();
  c.close();
  other.close();
});
