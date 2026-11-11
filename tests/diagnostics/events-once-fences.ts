// events.once lowers for EventEmitter and stream instances, literal event
// names and any options expression (the runtime validates it as Node does);
// these forms stay refused.
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";

const ee = new EventEmitter();
const name: string = process.argv[2] ?? "ready";
async function main(): Promise<void> {
  await once(ee, name); // computed event name
  await once(new PassThrough(), "data"); // a stream's 'data' event
}
void main();
