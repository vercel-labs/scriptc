// events.once and events.on lower for EventEmitter and stream instances with
// literal or computed event names and any options expression (the runtime
// validates it as Node does); these forms stay refused: a name a stream's
// fixed runtime event ABIs cannot carry, and the errorMonitor symbol, whose
// emits the promise's argument array cannot represent.
import { EventEmitter, errorMonitor, on, once } from "node:events";
import { PassThrough } from "node:stream";

const ee = new EventEmitter();
const name: string = process.argv[2] ?? "ready";
async function main(): Promise<void> {
  await once(new PassThrough(), name); // a computed name on a stream
  await once(ee, errorMonitor); // the errorMonitor symbol
  const iterator = on(new PassThrough(), name); // events.on, same rule
  void iterator;
}
void main();
