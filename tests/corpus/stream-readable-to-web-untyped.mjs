// Readable.toWeb in an untyped program: the readable is a checked-dynamic
// value, so the adapter unwraps it and every later read goes through the web
// stream's own handle.
import { Readable } from "node:stream";

const log = [];
const decoder = new TextDecoder();

const readable = Readable.from([Buffer.from("ab"), Buffer.from("cd")]);
const web = Readable.toWeb(readable);
log.push(`locked ${web.locked} stream ${web instanceof ReadableStream}`);
const reader = web.getReader();
const first = await reader.read();
log.push(`first ${first.done} ${first.value instanceof Uint8Array} ${decoder.decode(first.value)}`);
await reader.cancel("stop");
log.push(`cancelled destroyed ${readable.destroyed}`);

for (const line of log) console.log(line);
