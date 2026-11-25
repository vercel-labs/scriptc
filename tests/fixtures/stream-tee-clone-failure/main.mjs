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

// A branch canceled before the failing chunk: the clone failure errors the
// other branch and the canceled branch's cancellation promise settles
// instead of staying pending.
{
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue({ fn: () => 1 });
    },
    cancel() {},
  });
  const [left, right] = ReadableStreamTee(source, true);
  const cancellation = left.getReader().cancel("stop");
  let settled = "pending";
  cancellation.then(() => {
    settled = "resolved";
  }, () => {
    settled = "rejected";
  });
  const other = await right.getReader().read().then(
    () => "value",
    (error) => `err ${error.name}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  console.log("cancel-left", other, settled);
}

// A canceled second branch needs no copy: the first branch reads the
// producer's own chunk.
{
  const chunk = { fn: () => 1 };
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const [left, right] = ReadableStreamTee(source, true);
  void right.getReader().cancel("stop");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const first = await left.getReader().read().then(
    ({ value }) => value,
    (error) => `err ${error.name}`,
  );
  console.log("cancel-right", first === chunk, typeof first.fn);
}

// The canceled branch settles with the source's cancellation: pending while
// its callback is pending, rejected if it rejects.
{
  let release;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue({ fn: () => 1 });
    },
    cancel() {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const [left, right] = ReadableStreamTee(source, true);
  const cancellation = left.getReader().cancel("stop");
  let state = "pending";
  cancellation.then(() => {
    state = "resolved";
  }, () => {
    state = "rejected";
  });
  await right.getReader().read().then(
    () => "value",
    (error) => `err ${error.name}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  console.log("cancel-waits", state);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  console.log("cancel-waits-after", state);
}
{
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue({ fn: () => 1 });
    },
    cancel() {
      return Promise.reject(new Error("source cancel failed"));
    },
  });
  const [left, right] = ReadableStreamTee(source, true);
  const cancellation = left.getReader().cancel("stop");
  let state = "pending";
  cancellation.then(() => {
    state = "resolved";
  }, (error) => {
    state = `rejected ${error.message}`;
  });
  await right.getReader().read().then(
    () => "value",
    (error) => `err ${error.name}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  console.log("cancel-rejects", state);
}
