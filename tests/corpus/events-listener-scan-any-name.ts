// events.once and events.on given an unrestricted computed name may register
// for any string event: the listener scan counts that as a listener of every
// event name, so a patterned emit elsewhere in the program is observed and
// keeps its dispatch instead of being dropped as unobserved. Both waits
// settle with the arguments their emits carry.
import { EventEmitter, on, once } from "node:events";

function show(result: { value: any; done: boolean }): string {
  return `${result.done} ${JSON.stringify(result.value)}`;
}

async function main(): Promise<void> {
  const em = new EventEmitter();
  em.setMaxListeners(0);
  const anyName: string = process.argv[2] ?? "tick";

  // The name the wait receives is not fixed at compile time, so any patterned
  // emit may be the one that settles it: the promise resolves with the
  // emitted arguments.
  const pending = once(em, anyName);
  em.emit("t" + "ick", 1, "two");
  const values = await pending;
  console.log("any", values.length, JSON.stringify(values));

  // A second patterned emit under another name the wait does not fix either.
  const second = once(em, anyName);
  em.emit("ti" + "ck", { at: 2 });
  console.log("second", JSON.stringify(await second));
  console.log("left", em.listenerCount(anyName), em.listenerCount("error"));

  // events.on under the same unrestricted name counts the same way: the
  // iterator's registration sees the patterned emit, and return() drops it.
  const iter = on(em, anyName);
  em.emit("tic" + "k", { at: 3 }, "last");
  console.log("on", show(await iter.next()));
  console.log("on return", show(await iter.return()));
  console.log("on left", em.listenerCount(anyName), em.listenerCount("error"));
}

void main();
