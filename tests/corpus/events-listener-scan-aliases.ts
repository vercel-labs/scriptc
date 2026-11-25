// events.once and events.on register a listener under the very name they
// receive, whatever import binding names them: the listener scan resolves an
// aliased import to the member it exports, so a computed name with a constant
// prefix joins the program's pattern table. A patterned emit of a name the
// registered pattern admits is therefore observed and keeps its dispatch
// instead of being dropped as unobserved, and the wait settles with the
// emit's arguments.
import { EventEmitter, on as watchOn, once as waitOnce } from "node:events";

function show(result: { value: any; done: boolean }): string {
  return `${result.done} ${JSON.stringify(result.value)}`;
}

async function main(): Promise<void> {
  const em = new EventEmitter();
  em.setMaxListeners(0);
  const tail = process.argv[2] ?? "-done";
  const jobName = "job" + tail;

  // The wait registers under a computed name whose prefix is "job"; the
  // emit's own computed name starts with "jo", so the two patterns can name
  // the same event. The promise resolves with the emitted arguments.
  const waited = waitOnce(em, jobName);
  em.emit("jo" + "b" + tail, 1, "two");
  console.log("once", JSON.stringify(await waited));

  // The same registration through an aliased events.on: the iterator sees the
  // patterned emit's arguments as given, and return() drops its listeners.
  const iter = watchOn(em, jobName);
  em.emit("job" + tail, { step: 2 }, 3);
  console.log("on", show(await iter.next()));
  console.log("on return", show(await iter.return()));
  console.log("left", em.listenerCount(jobName), em.listenerCount("error"));
}

void main();
