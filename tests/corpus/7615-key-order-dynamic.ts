import { MessageChannel } from "node:worker_threads";

// Object literals that write the same keys in different orders, seen
// through untyped values: their keys, JSON text, own property names, and a
// MessageChannel message.
const a = { id: 1, name: "a", ok: true };
const b = { name: "b", ok: false, id: 2 };
const c = { ok: true, id: 3, name: "c" };
const values: unknown[] = [a, b, c];
for (const value of values) {
  const object = value as Record<string, unknown>;
  console.log(Object.keys(object).join(","), JSON.stringify(object));
  console.log(Object.getOwnPropertyNames(object).join(","));
}
const { port1, port2 } = new MessageChannel();
let received = 0;
port1.on("message", (message: unknown) => {
  console.log("message", JSON.stringify(message), Object.keys(message as object).join(","));
  if (++received === 3) port1.close();
});
for (const value of [a, b, c]) port2.postMessage(value);

// A nested value seen through an untyped view keeps its identity and its
// own key order, and writes through the view reach it.
const holder = { inner: b, tag: "h" };
const view = holder as unknown as Record<string, unknown>;
const inner = view.inner as Record<string, unknown>;
console.log(view.inner === view.inner, Object.keys(inner).join(","));
inner.id = 20;
console.log(b.id, JSON.stringify(b), JSON.stringify(view));
