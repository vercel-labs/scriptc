// A listener registered through events.once or events.on under a literal
// name joins the program's event table like any other registration: a
// patterned emit whose name the pattern admits is observed, keeps its
// dispatch, and settles the wait with the arguments it carries.
import { EventEmitter, on, once } from "node:events";

function show(result: { value: any; done: boolean }): string {
  return `${result.done} ${JSON.stringify(result.value)}`;
}

async function main(): Promise<void> {
  const em = new EventEmitter();
  em.setMaxListeners(0);
  const tail = process.argv[2] ?? "-done";
  const patterned = "job" + tail;

  // The wait names 'job-done' literally; the emit's computed name starts with
  // "job", so it may be the event the wait receives.
  const waited = once(em, "job-done");
  em.emit(patterned, 1, "two");
  console.log("once", JSON.stringify(await waited));
  console.log("left", em.listenerCount("job-done"), em.listenerCount("error"));

  // The same registration through events.on: the iterator sees the patterned
  // emit's arguments, and return() drops its listeners.
  const iter = on(em, "job-done");
  em.emit("job" + tail, { step: 2 }, 3);
  console.log("on", show(await iter.next()));
  console.log("on return", show(await iter.return()));
}

void main();
