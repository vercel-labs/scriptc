// Readable.toWeb's byte-mode chunks are plain Uint8Array copies: Node's
// adapter detaches each Buffer chunk from the readable's storage, so mutating
// the pushed Buffer cannot reach the web stream and Buffer.isBuffer is false.
import { Readable } from "node:stream";

const log = [];
const decoder = new TextDecoder();

const source = Buffer.from("mutate");
const readable = new Readable({ read() {} });
readable.push(source);
readable.push(null);
const result = await Readable.toWeb(readable).getReader().read();
// The value travels through an object here: Buffer.isBuffer on the read's
// `.value` directly is folded by the compiler's Buffer-producer heuristic,
// which this program is not about.
const value = result.value;
// Uint8Array's string form joins its elements; a Buffer would decode utf8.
log.push(`brand ${value.constructor.name} ${String(value)} ${value instanceof Uint8Array}`);
source[0] = 0x5a;
log.push(`detached ${decoder.decode(value)}`);
value[1] = 0x59;
log.push(`reverse ${source.toString()}`);

for (const line of log) console.log(line);
