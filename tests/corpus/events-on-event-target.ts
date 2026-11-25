// events.on over an EventTarget, Node-exact: the dispatched Event arrives as
// the single next() value, a parked next() takes the next dispatch, nothing
// counts without a waiter until the watermark does, return() removes the
// target's listeners, and an AbortSignal used as the receiver delivers its
// own 'abort' Event and keeps listening (no 'error' handler is registered on
// the addEventListener protocol, and the signal's listener is not `once`).
import { getEventListeners, on } from "node:events";

async function main(): Promise<void> {
  const target = new EventTarget();
  const it = on(target, "chunk");
  console.log("regs", getEventListeners(target, "chunk").length);

  target.dispatchEvent(new Event("chunk"));
  const first = await it.next();
  const event = (first.value as any)[0];
  console.log("first", first.done, first.value.length, event.type);

  target.dispatchEvent(new Event("chunk"));
  const second = await it.next();
  console.log("second", second.done, JSON.stringify(second.value));

  const parked = it.next();
  target.dispatchEvent(new Event("chunk"));
  console.log("parked", (await parked).value.length);

  await it.return();
  console.log("after", getEventListeners(target, "chunk").length, JSON.stringify(await it.next()));

  // Two iterators over one target: each receives the dispatch.
  const shared = new EventTarget();
  const left = on(shared, "tick");
  const right = on(shared, "tick");
  shared.dispatchEvent(new Event("tick"));
  console.log("both", (await left.next()).value.length, (await right.next()).value.length);
  await left.return();
  await right.return();
  console.log("both after", getEventListeners(shared, "tick").length);

  // The signal as the receiver: aborting dispatches the 'abort' event the
  // iterator is waiting for, and the signal's registration stays.
  const controller = new AbortController();
  const aborted = on(controller.signal, "abort");
  const pending = aborted.next();
  controller.abort("stop");
  const result = await pending;
  console.log("abort", result.done, (result.value as any)[0].type, getEventListeners(controller.signal, "abort").length);
  await aborted.return();
  console.log("abort after", getEventListeners(controller.signal, "abort").length);

  // Symbols have no addEventListener form.
  try {
    on(target, Symbol("s"));
    console.log("symbol accepted");
  } catch (err) {
    const e = err as Error & { code?: string };
    console.log("symbol", e.name, e.code, e.message);
  }
}

void main();
