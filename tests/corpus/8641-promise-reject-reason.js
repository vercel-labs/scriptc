// The executor's reject parameter rejects the promise with the program's own
// value. ECMAScript makes the rejection reason any value: `reject()` settles
// with undefined, `reject(42)` with 42, `reject("s")` with "s", and an object
// reason is the very object, not a copy. A promise whose settled value is
// unknown has no typed payload to protect, so the reason travels as the
// checked-dynamic value it was rejected with, and every observer — then's
// rejection handler, catch, await inside try/catch, finally's re-throw —
// receives that value. Error reasons keep working unchanged, first settle
// wins (a later reject, a reject after resolve, and an executor throw after
// any settle are all no-ops), and an executor throw before any settle
// rejects. Node is the oracle byte-for-byte.
"use strict";

function describe(value) {
  return typeof value + " " + String(value);
}

async function settle(promise) {
  try {
    return "fulfilled " + describe(await promise);
  } catch (reason) {
    return "rejected " + describe(reason);
  }
}

async function main() {
  const reasons = [
    ["bare", new Promise((resolve, reject) => reject())],
    ["number", new Promise((resolve, reject) => reject(42))],
    ["zero", new Promise((resolve, reject) => reject(0))],
    ["string", new Promise((resolve, reject) => reject("s"))],
    ["null", new Promise((resolve, reject) => reject(null))],
    ["false", new Promise((resolve, reject) => reject(false))],
    ["error", new Promise((resolve, reject) => reject(new Error("boom")))],
  ];
  for (const [label, promise] of reasons) {
    console.log(label, await settle(promise));
  }

  // The reason is the very object the program rejected with.
  const rejected = { tag: "identity" };
  try {
    await new Promise((resolve, reject) => reject(rejected));
    console.log("identity missed");
  } catch (reason) {
    console.log("identity", reason === rejected, reason.tag);
  }

  // First settle wins, exactly JS.
  const firstReject = new Promise((resolve, reject) => {
    reject(1);
    reject(2);
  });
  console.log("first reject", await settle(firstReject));
  const resolveThenReject = new Promise((resolve, reject) => {
    resolve("kept");
    reject(new Error("dropped"));
  });
  console.log("resolve then reject", await settle(resolveThenReject));
  const rejectThenThrow = new Promise((resolve, reject) => {
    reject("kept");
    throw new Error("dropped");
  });
  console.log("reject then throw", await settle(rejectThenThrow));
  const executorThrow = new Promise(() => {
    throw new TypeError("escape");
  });
  console.log("executor throw", await settle(executorThrow));

  // Handlers see the same value as await: then's rejection slot, catch, and
  // finally's re-throw of a non-Error reason.
  const viaThen = await new Promise((resolve, reject) => reject(7)).then(
    (value) => "fulfilled " + describe(value),
    (reason) => "rejected " + describe(reason),
  );
  console.log("then", viaThen);
  const viaCatch = await new Promise((resolve, reject) => reject("caught")).catch(
    (reason) => "rejected " + describe(reason),
  );
  console.log("catch", viaCatch);
  const viaFinally = await new Promise((resolve, reject) => reject(11))
    .finally(() => {})
    .catch((reason) => "rejected " + describe(reason));
  console.log("finally", viaFinally);

  // An async function that rejects with a non-Error value, and awaiting a
  // promise that already rejected with one, directly and through a chain.
  async function asyncReject() {
    throw "async reason";
  }
  console.log("async throw", await settle(asyncReject()));
  const already = new Promise((resolve, reject) => reject(99));
  await Promise.resolve();
  console.log("already rejected", await settle(already));
  console.log("rejected chain", await settle(already.then((value) => value)));
}

main().then(() => console.log("done"));
