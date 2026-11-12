// events.on's close paths, Node-exact: the close names and the 'error'
// handler register beside the awaited event and leave when the iterator
// closes, a close event resolves parked and later next() calls as done, the
// signal's own abort listener is registered with `once` and disposed by
// return() or by the abort it receives, an abort rejects the parked next()
// with AbortError carrying the reason, awaiting 'error' itself hands back
// the error as the next value, and throw(Error) closes the iterator the way
// an 'error' emit does while throw(non-Error) is the argument-type fault.
import { EventEmitter, getEventListeners, listenerCount, on } from "node:events";

class Bus extends EventEmitter {}

function show(result: { value: unknown; done: boolean }): string {
  return `${result.done} ${JSON.stringify(result.value ?? null)}`;
}

function counts(bus: Bus): string {
  return ["chunk", "error", "end", "stop"].map((name) => listenerCount(bus, name)).join(",");
}

async function main(): Promise<void> {
  // A close name ends the iteration: the parked next() resolves done, the
  // listeners leave, and the iterator stays done.
  const bus = new Bus();
  const it = on(bus, "chunk", { close: ["end", "stop"] });
  console.log("counts", counts(bus));
  const parked = it.next();
  bus.emit("end");
  console.log("parked", show(await parked));
  console.log("after", counts(bus), show(await it.next()), show(await it.return()));

  // return() disposes the signal's abort listener along with the rest.
  const second = new Bus();
  const controller = new AbortController();
  const signaled = on(second, "chunk", { signal: controller.signal, close: ["stop"] });
  console.log("signal", getEventListeners(controller.signal, "abort").length, counts(second));
  await signaled.return();
  console.log("signal after", getEventListeners(controller.signal, "abort").length, counts(second));

  // A late abort rejects the parked next() with the reason as its cause and
  // removes every registration, the signal's included.
  const third = new Bus();
  const aborting = new AbortController();
  const waiting = on(third, "chunk", { signal: aborting.signal });
  const pending = waiting.next();
  aborting.abort(new RangeError("late"));
  try {
    await pending;
    console.log("late resolved");
  } catch (err) {
    const e = err as Error & { code?: string; cause?: { message?: string } };
    console.log("late", e.name, e.code, e.message, e.cause?.message ?? "-");
  }
  console.log(
    "late after",
    getEventListeners(aborting.signal, "abort").length,
    counts(third),
    show(await waiting.next()),
  );
  // Aborting again now has no listener to reach.
  aborting.abort(new Error("again"));
  console.log("again ok");

  // The awaited event is 'error' itself: the main listener takes the error
  // as a value instead of the absence of an 'error' handler rejecting.
  const direct = new Bus();
  const errors = on(direct, "error");
  console.log("error counts", listenerCount(direct, "error"));
  direct.emit("error", new Error("direct"));
  const got = await errors.next();
  console.log("direct", got.done, (got.value as any)[0].message);
  await errors.return();

  // An 'error' with no parked waiter is kept for the next next(), which
  // rejects once and then reports done.
  const stored = new Bus();
  const storedIt = on(stored, "chunk");
  stored.emit("error", new Error("stored"));
  try {
    await storedIt.next();
  } catch (err) {
    console.log("stored", (err as Error).message);
  }
  console.log("stored done", show(await storedIt.next()));

  // throw(): the iterator's own protocol.
  const thrown = new Bus();
  const throwing = on(thrown, "chunk");
  const waiter = throwing.next();
  const rejection = waiter.catch((err: Error) => err.message);
  await (throwing as any).throw(new Error("thrown"));
  console.log("throw", await rejection);
  console.log("throw done", show(await throwing.next()));
  try {
    await (throwing as any).throw(5);
    console.log("throw number resolved");
  } catch (err) {
    const e = err as Error & { code?: string };
    console.log("throw number", e.name, e.code, e.message);
  }

  // return() resolves a parked next() as done.
  const parkedReturn = new Bus();
  const returnIt = on(parkedReturn, "chunk");
  const returnPending = returnIt.next();
  console.log("return", show(await returnIt.return()), show(await returnPending));

  // An EventTarget's close listeners leave with the iterator too.
  const target = new EventTarget();
  const targetIt = on(target, "chunk", { close: ["end"] });
  console.log("target", getEventListeners(target, "chunk").length, getEventListeners(target, "end").length);
  await targetIt.return();
  console.log("target after", getEventListeners(target, "chunk").length, getEventListeners(target, "end").length);
}

void main();
