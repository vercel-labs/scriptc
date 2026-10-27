// events.once lowers for EventEmitter and stream instances, literal event
// names and a literal { signal } options object; these forms stay refused.
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";

const ee = new EventEmitter();
const name: string = process.argv[2] ?? "ready";
const options = {};
async function main(): Promise<void> {
  await once(ee, "ready", options); // options that are not an object literal
  await once(ee, name); // computed event name
  await once(new PassThrough(), "data"); // a stream's 'data' event
}
void main();
