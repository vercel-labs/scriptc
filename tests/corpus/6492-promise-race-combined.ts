// Promise.race over events.once results: entries that only reject (a
// handler that throws) fit any result, and entries of different value
// types combine into 'unknown'.
import { EventEmitter, once } from "node:events";

function waitFor(a: EventEmitter, b: EventEmitter) {
  let failed = false;
  return Promise.race([
    once(a, "done"),
    once(a, "error").then(([error]) => {
      failed = true;
      throw error;
    }),
    once(b, "close").then(() => {
      failed = true;
      throw new Error("closed early");
    }),
  ]).finally(() => {
    console.log("settled", failed);
  });
}

function waitVoid(a: EventEmitter): Promise<void> {
  return Promise.race([
    once(a, "done").then((): void => undefined),
    once(a, "error").then(([error]) => {
      throw error;
    }),
  ]);
}

function waitMixed(a: EventEmitter): Promise<unknown> {
  return Promise.race([once(a, "done").then((): void => undefined), once(a, "other")]);
}

async function main(): Promise<void> {
  const a = new EventEmitter();
  const b = new EventEmitter();
  setTimeout(() => a.emit("done", 7), 1);
  console.log("value", JSON.stringify(await waitFor(a, b)));
  setTimeout(() => b.emit("close"), 1);
  try {
    await waitFor(a, b);
  } catch (err) {
    console.log("caught", (err as Error).message);
  }
  setTimeout(() => a.emit("error", new Error("bad")), 1);
  try {
    await waitFor(a, b);
  } catch (err) {
    console.log("caught", (err as Error).message);
  }
  setTimeout(() => a.emit("done", 8), 1);
  await waitVoid(a);
  console.log("void done");
  setTimeout(() => a.emit("other", 1, "x"), 1);
  console.log("mixed", JSON.stringify(await waitMixed(a)));
  setTimeout(() => a.emit("done", 9), 1);
  console.log("mixed undefined", await waitMixed(a));
  // Turn order: the race settles one turn after its first entry.
  const c = new EventEmitter();
  void waitMixed(c).then(() => console.log("race settled"));
  void Promise.resolve()
    .then(() => console.log("u1"))
    .then(() => console.log("u2"))
    .then(() => console.log("u3"))
    .then(() => console.log("u4"))
    .then(() => console.log("u5"));
  c.emit("other", 2, "y");
}

void main();
