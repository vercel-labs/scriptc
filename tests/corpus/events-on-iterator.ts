// events.on over a compiled emitter: the async iterator over one event's
// argument tuples. Each event becomes the next() value's array, an event
// that arrives while no next() waits counts in the iterator's size, and a
// parked next() takes the next one. The iterator registers the event, the
// 'error' handler (unless the awaited event is 'error') and its close
// names, and return() removes them; a 'for await' loop reads the same
// values and closes the iterator when it breaks.
import { EventEmitter, listenerCount, on } from "node:events";
import * as events from "node:events";

class Bus extends EventEmitter {}

function show(result: { value: any; done: boolean }): string {
  return `${result.done} ${JSON.stringify(result.value)}`;
}

async function main(): Promise<void> {
  const bus = new Bus();
  const it = on(bus, "tick");
  console.log("registered", listenerCount(bus, "tick"), listenerCount(bus, "error"));
  bus.emit("tick", 1);
  bus.emit("tick", 2);
  console.log("first", show(await it.next()));
  console.log("second", show(await it.next()));
  const parked = it.next();
  bus.emit("tick", 3);
  console.log("parked", show(await parked));

  // A second listener of the same event is unaffected by return().
  const other = on(bus, "tick");
  console.log("two", listenerCount(bus, "tick"));
  console.log("return", show(await it.return()));
  console.log("removed", listenerCount(bus, "tick"), listenerCount(bus, "error"));
  bus.emit("tick", 4);
  console.log("other", show(await other.next()));
  await other.return();

  // The awaited event's own name is not 'error': an error emit rejects the
  // pending next() and closes the iterator.
  const failing = new Bus();
  const waits = on(failing, "tick");
  const rejected = waits.next();
  failing.emit("error", new Error("boom"));
  try {
    await rejected;
    console.log("error resolved");
  } catch (error) {
    console.log("error", (error as Error).message);
  }
  console.log("closed", show(await waits.next()));

  // A 'for await' loop reads the same tuples and closes on break.
  const stream = new Bus();
  const seen: string[] = [];
  const loop = (async (): Promise<string> => {
    for await (const args of on(stream, "chunk")) {
      seen.push(String(args[0]));
      if (seen.length === 3) break;
    }
    return seen.join(",");
  })();
  stream.emit("chunk", "a");
  stream.emit("chunk", "b");
  stream.emit("chunk", "c");
  console.log("loop", await loop, listenerCount(stream, "chunk"), listenerCount(stream, "error"));

  // Node's documented loop: the close name ends the iteration.
  const doc = new Bus();
  const collected: number[] = [];
  const documented = (async (): Promise<void> => {
    for await (const args of on(doc, "foo", { close: ["close"] })) {
      collected.push(args[0] as number);
    }
  })();
  doc.emit("foo", 1);
  doc.emit("foo", 42);
  doc.emit("close");
  await documented;
  console.log(
    "documented",
    collected.join(","),
    listenerCount(doc, "foo"),
    listenerCount(doc, "close"),
    listenerCount(doc, "error"),
  );

  // The module namespace spelling reaches the same helper.
  const ns = new Bus();
  const nsIt = events.on(ns, "tick");
  ns.emit("tick", 9);
  console.log("namespace", JSON.stringify((await nsIt.next()).value));
  await nsIt.return();

  // So does the class static.
  const stat = new Bus();
  const statIt = EventEmitter.on(stat, "tick");
  stat.emit("tick", 11);
  console.log("static", JSON.stringify((await statIt.next()).value));
  await statIt.return();
}

void main();
