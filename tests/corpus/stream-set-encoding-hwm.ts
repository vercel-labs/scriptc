// The highWaterMark a Readable reports after setEncoding: buffered and read
// lengths count decoded string units, so the byte highWaterMark bounds
// characters once a decoder is installed (Node's documented discrepancy).
import { Readable } from "node:stream";

const log: string[] = [];

function state(r: Readable, label: string): void {
  log.push(`${label} length ${r.readableLength} hwm ${r.readableHighWaterMark} enc ${r.readableEncoding}`);
}

const r = new Readable({ read(): void {}, highWaterMark: 4 });
state(r, "before");
r.setEncoding("utf8");
state(r, "encoded");
// Six UTF-8 bytes are three characters: under the four-character bound even
// though the pushed bytes are over it.
r.push(Buffer.from("ééé"));
state(r, "pushed");
log.push(`read0 ${r.read(0)}`);
state(r, "read0");
log.push(`read2 ${String(r.read(2))}`);
state(r, "read2");
r.push("ab");
state(r, "more");
log.push(`rest ${String(r.read())}`);
state(r, "drained");

for (const line of log) console.log(line);
