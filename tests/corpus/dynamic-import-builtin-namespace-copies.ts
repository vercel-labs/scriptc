// A builtin's ES module namespace holds copies of its exports, and
// defaultMaxListeners is the one export a program can change: writing the
// CommonJS module property moves the module object and the default import,
// not the namespace's copy, until syncBuiltinESMExports() refreshes it.
// The awaited literal import and a const bound to it are namespaces too.
import { defaultMaxListeners as namedCopy } from "node:events";
import * as eventsNs from "node:events";
import events from "node:events";

const bound = await import("node:events");

async function report(label: string): Promise<void> {
  console.log(
    label,
    namedCopy,
    eventsNs.defaultMaxListeners,
    bound.defaultMaxListeners,
    (await import("node:events")).defaultMaxListeners,
    events.defaultMaxListeners,
  );
}

await report("start");
events.defaultMaxListeners = 20;
await report("after");
const { syncBuiltinESMExports } = await import("node:module");
syncBuiltinESMExports();
await report("synced");
