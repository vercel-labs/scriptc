// Promise.all, Promise.allSettled and Promise.any over an iterable whose
// next() throws, or whose step result's `done`/`value` getter throws,
// REJECT the returned promise: the throw is the combinator's own abrupt
// completion, delivered to the promise's handlers like any other reason,
// and never an escaping synchronous error. The throw arrives at the
// promise through a rejected settlement, so an observer attached after the
// synchronous call still sees it on the microtask queue. IteratorClose
// does not run for a failed step: the iterator's `return` is only called
// when a later step of a healthy iteration aborts. Node is the oracle
// byte-for-byte.
"use strict";

function makeIterable(mode) {
  const record = { returnCount: 0 };
  const step = {};
  if (mode === "done") {
    Object.defineProperty(step, "done", {
      get() {
        throw new Error("done " + mode);
      },
    });
  } else if (mode === "value") {
    step.done = false;
    Object.defineProperty(step, "value", {
      get() {
        throw new Error("value " + mode);
      },
    });
  }
  const iterable = {};
  iterable[Symbol.iterator] = function () {
    return {
      next() {
        if (mode === "next") throw new Error("next " + mode);
        return step;
      },
      return() {
        record.returnCount += 1;
        return {};
      },
    };
  };
  return { iterable, record };
}

function observe(label, promise, record) {
  promise.then(
    () => console.log(label, "fulfilled"),
    (reason) => console.log(label, "rejected", reason.message, "closed", record.returnCount),
  );
}

const modes = ["next", "done", "value"];

for (const mode of modes) {
  const all = makeIterable(mode);
  observe(`all/${mode}`, Promise.all(all.iterable), all.record);
  const settled = makeIterable(mode);
  observe(`allSettled/${mode}`, Promise.allSettled(settled.iterable), settled.record);
  const any = makeIterable(mode);
  observe(`any/${mode}`, Promise.any(any.iterable), any.record);
}

async function awaited() {
  const first = makeIterable("done");
  try {
    await Promise.all(first.iterable);
    console.log("awaited fulfilled");
  } catch (error) {
    console.log("awaited rejected", error.message, "closed", first.record.returnCount);
  }
  // The reason is the very value the step threw, not a copy.
  const identity = makeIterable("next");
  const thrown = new Error("identity");
  identity.iterable[Symbol.iterator] = function () {
    return {
      next() {
        throw thrown;
      },
      return() {
        identity.record.returnCount += 1;
        return {};
      },
    };
  };
  await Promise.all(identity.iterable).then(
    () => console.log("identity fulfilled"),
    (reason) => console.log("identity same", reason === thrown, "closed", identity.record.returnCount),
  );
}

awaited();
console.log("sync end");
