// events.on over a NodeEventTarget (a MessagePort): the receiver has an on()
// method, so the iterator registers through the target's emitter protocol,
// each emit's single argument arriving as the next() value's array, and the
// 'error' emit rejecting the parked next() and closing the iterator. The
// registrations share the port's listener store with its own on()/once().
import { listenerCount, on } from "node:events";
import { MessageChannel } from "node:worker_threads";

function show(result: { value: unknown; done: boolean }): string {
  return `${result.done} ${JSON.stringify(result.value ?? null)}`;
}

async function main(): Promise<void> {
  const { port1, port2 } = new MessageChannel();

  const it = on(port1, "msg");
  console.log("registered", listenerCount(port1, "msg"), listenerCount(port1, "error"));
  port1.emit("msg", "one");
  console.log("first", show(await it.next()));
  const parked = it.next();
  port1.emit("msg", "two");
  console.log("parked", show(await parked));
  await it.return();
  console.log("returned", listenerCount(port1, "msg"), listenerCount(port1, "error"));

  // An 'error' emit rejects the parked wait and closes the iterator, and
  // both registrations leave.
  const failing = on(port1, "work");
  const pending = failing.next();
  port1.emit("error", new Error("boom"));
  try {
    await pending;
    console.log("error resolved");
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log("error", err.name, err.code, err.message);
  }
  console.log("closed", show(await failing.next()), listenerCount(port1, "work"), listenerCount(port1, "error"));

  // The iterator's registrations share the store with the port's own.
  const shared = (value: string): void => void console.log("shared", value);
  port1.on("shared", shared);
  const sharing = on(port1, "shared");
  console.log("shared registered", port1.listenerCount("shared"), port1.listenerCount("error"));
  port1.emit("shared", "both");
  console.log("shared value", show(await sharing.next()));
  port1.off("shared", shared);
  await sharing.return();
  console.log("shared left", listenerCount(port1, "shared"), listenerCount(port1, "error"));

  port1.close();
  port2.close();
}

void main();
