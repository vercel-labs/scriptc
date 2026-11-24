// ReadableStreamTee(stream, true) clones each chunk before either branch
// sees it. A chunk structuredClone refuses (a function member) errors both
// branches with the DataCloneError and cancels the source; the producer's
// object is never handed to a branch. Node's own tee throws that error out
// of its microtask instead, so this behavior is pinned here rather than
// against Node.
import { ReadableStreamTee } from "node:stream/web";

let canceled = null;
const source = new ReadableStream({
  start(controller) {
    controller.enqueue({ fn: () => 1 });
  },
  cancel(reason) {
    canceled = reason;
  },
});
const [first, second] = ReadableStreamTee(source, true);
const report = async (label, reader) => {
  try {
    const { value } = await reader.read();
    console.log(label, "value", typeof value);
  } catch (error) {
    console.log(label, "err", error.name);
  }
};
await Promise.all([report("first", first.getReader()), report("second", second.getReader())]);
await new Promise((resolve) => setTimeout(resolve, 0));
console.log("canceled", canceled !== null && canceled.name === "DataCloneError");

// A cloneable chunk still reaches branch 1 as the producer's value and
// branch 2 as its copy.
const good = new ReadableStream({
  start(controller) {
    controller.enqueue({ n: 1 });
    controller.close();
  },
});
const [left, right] = ReadableStreamTee(good, true);
const producer = (await left.getReader().read()).value;
const copy = (await right.getReader().read()).value;
console.log("cloned", producer === copy, JSON.stringify(copy));
