// markAsUncloneable: structuredClone and postMessage throw DataCloneError
// for a marked object, error or class instance, also nested in an object;
// the mark has no effect on primitives, arrays and typed arrays.
import { markAsUncloneable, MessageChannel, isInternalThread } from "node:worker_threads";

console.log("isInternalThread", isInternalThread);
const { port1, port2 } = new MessageChannel();
port2.on("message", (m) => console.log("received", JSON.stringify(m)));

class Point {
  constructor(x) {
    this.x = x;
  }
}
const cases = {
  object: { a: 1 },
  error: new Error("e"),
  instance: new Point(1),
  array: [1, 2],
  bytes: new Uint8Array(2),
};
for (const [name, value] of Object.entries(cases)) {
  markAsUncloneable(value);
  let cloned;
  let posted;
  try {
    structuredClone(value);
    cloned = "cloned";
  } catch (e) {
    cloned = `${e.name} ${e.message} ${e.code}`;
  }
  try {
    port1.postMessage(value);
    posted = "posted";
  } catch (e) {
    posted = `${e.name} ${e.message}`;
  }
  console.log(name, "|", cloned, "|", posted);
}
markAsUncloneable(5);
markAsUncloneable("text");
markAsUncloneable(undefined);
console.log("primitives", structuredClone(5), structuredClone("text"));
const marked = { inner: true };
markAsUncloneable(marked);
markAsUncloneable(marked);
try {
  structuredClone({ nested: marked });
} catch (e) {
  console.log("nested", e.name, e.message);
}
try {
  port1.postMessage({ nested: marked });
} catch (e) {
  console.log("nested post", e.name, e.message);
}
const copy = { ...marked };
console.log("spread copy", JSON.stringify(structuredClone(copy)));
setTimeout(() => port1.close(), 50);
