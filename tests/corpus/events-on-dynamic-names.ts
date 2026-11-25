// events.on over names the program does not fix to a typed event tuple: a
// computed string and a symbol. The iterator registers one checked-dynamic
// listener through the emitter's registry, so the events' arguments arrive
// as given, an 'error' emit rejects the parked next() and closes the
// iterator, and return() removes the registrations.
import { EventEmitter, listenerCount, on } from "node:events";

class Bus extends EventEmitter {}

function show(result: { value: any; done: boolean }): string {
  return `${result.done} ${JSON.stringify(result.value)}`;
}

async function main(): Promise<void> {
  const bus = new Bus();
  bus.setMaxListeners(0);
  const name = process.argv[2] ?? "tick";

  const it = on(bus, name);
  console.log("registered", listenerCount(bus, name), listenerCount(bus, "error"));
  bus.emit(name, 1, "two");
  bus.emit(name, { x: 3 });
  console.log("first", show(await it.next()));
  console.log("second", show(await it.next()));

  // A symbol name keeps its identity on both sides.
  const sym = Symbol("sig");
  const symbolic = on(bus, sym);
  console.log("symbol registered", bus.listenerCount(sym));
  bus.emit(sym, "s");
  console.log("symbol", show(await symbolic.next()));
  console.log("symbol return", show(await symbolic.return()));

  // An 'error' emit while a next() is parked rejects it and closes the
  // iterator.
  const failing = on(bus, name);
  const parked = failing.next();
  bus.emit("error", new Error("bad"));
  try {
    await parked;
    console.log("parked resolved");
  } catch (error) {
    console.log("parked rejected", (error as Error).message);
  }
  console.log("closed", show(await failing.next()));

  // return() removes the registrations the iterator holds.
  console.log("return", show(await it.return()));
  console.log("left", listenerCount(bus, name), listenerCount(bus, "error"));
}

void main();
