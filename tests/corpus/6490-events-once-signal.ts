// events.once(emitter, name, { signal }) follows Node's lib/events.js: an
// abort removes the event's and the 'error' listener and rejects with an
// AbortError whose cause is signal.reason, an aborted signal rejects
// without registering anything, and a settled once removes its abort
// listener. The result settles on Node's microtask turn: once is an async
// function returning the executor's promise.
import { EventEmitter, once } from "node:events";

async function main(): Promise<void> {
  const ee = new EventEmitter();
  const ac = new AbortController();
  setTimeout(() => ee.emit("ready", 1, "two"), 1);
  const args = await once(ee, "ready", { signal: ac.signal });
  console.log("fulfilled", JSON.stringify(args), ee.listenerCount("ready"), ee.listenerCount("error"));

  const ac2 = new AbortController();
  const pending = once(ee, "ready", { signal: ac2.signal });
  console.log("before abort", ee.listenerCount("ready"), ee.listenerCount("error"));
  ac2.abort();
  console.log("after abort", ee.listenerCount("ready"), ee.listenerCount("error"));
  try {
    await pending;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log("rejected", e.name, e.message, e.code, (e.cause as Error).name);
  }

  const ac3 = new AbortController();
  ac3.abort(new Error("already"));
  try {
    await once(ee, "ready", { signal: ac3.signal });
  } catch (err) {
    const e = err as Error;
    console.log("pre-aborted", e.name, (e.cause as Error).message, ee.listenerCount("ready"));
  }

  const ac4 = new AbortController();
  setTimeout(() => ee.emit("error", new Error("boom")), 1);
  try {
    await once(ee, "ready", { signal: ac4.signal });
  } catch (err) {
    console.log("error event", (err as Error).message, ee.listenerCount("ready"));
  }
  ac4.abort();
  console.log("late abort changes nothing");

  const errs = once(ee, "error", { signal: ac.signal });
  ee.emit("error", new Error("as value"));
  const [first] = await errs;
  console.log("error as value", (first as Error).message);

  // An undefined signal is the plain form.
  const maybe: AbortSignal | undefined = undefined;
  setTimeout(() => ee.emit("ready", 3, "four"), 1);
  console.log("undefined signal", JSON.stringify(await once(ee, "ready", { signal: maybe })));

  // Listeners registered before and after the once's abort listener.
  const ac5 = new AbortController();
  const ee5 = new EventEmitter();
  ac5.signal.addEventListener("abort", () => {
    console.log("first abort listener", ee5.listenerCount("z"));
  });
  const p5 = once(ee5, "z", { signal: ac5.signal });
  ac5.signal.addEventListener("abort", () => {
    console.log("second abort listener", ee5.listenerCount("z"));
  });
  ac5.abort("why");
  await p5.catch((err: Error) => console.log("p5", err.name, String(err.cause)));

  // The abort's removals emit 'removeListener'.
  const ee6 = new EventEmitter();
  ee6.on("removeListener", (name: string) => console.log("removed", name));
  const ac6 = new AbortController();
  const p6 = once(ee6, "w", { signal: ac6.signal });
  ac6.abort();
  await p6.catch(() => console.log("p6 rejected"));

  // A 'newListener' listener that throws rejects the promise.
  const ee7 = new EventEmitter();
  ee7.on("newListener", (name: string) => {
    if (name === "go") throw new Error("no " + name);
  });
  await once(ee7, "go", { signal: new AbortController().signal }).then(
    () => console.log("fulfilled"),
    (err: Error) => console.log("newListener rejected", err.message, ee7.listenerCount("go")),
  );

  // Settlement turns against plain promise chains.
  const ee8 = new EventEmitter();
  const ac8 = new AbortController();
  void once(ee8, "x").then(() => console.log("plain"));
  void once(ee8, "x", { signal: ac8.signal }).then(() => console.log("signal"));
  void Promise.resolve()
    .then(() => console.log("t1"))
    .then(() => console.log("t2"))
    .then(() => console.log("t3"))
    .then(() => console.log("t4"));
  ee8.emit("x");
  const ac9 = new AbortController();
  void once(ee8, "y", { signal: ac9.signal }).then(
    () => console.log("fulfilled"),
    () => console.log("aborted"),
  );
  ac9.abort();
  const ac10 = new AbortController();
  ac10.abort();
  void once(ee8, "y", { signal: ac10.signal }).then(
    () => console.log("fulfilled"),
    () => console.log("pre-aborted turn"),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Pending onces whose signal never aborts keep their listeners.
  const idle = new AbortController();
  void once(ee, "never", { signal: idle.signal });
  void once(new EventEmitter(), "never", { signal: idle.signal });
  console.log("pending", ee.listenerCount("never"), ee.listenerCount("error"));
}

void main();
