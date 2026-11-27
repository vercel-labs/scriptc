// read(size) grows the readable highWaterMark to the next power of two above
// size (Node's computeNewHighWaterMark), and a highWaterMark of 0 still grows
// to 1: read(1) on it answers null (no data yet) instead of standing still.
import { Readable } from "node:stream";

const empty = new Readable({ read() {}, highWaterMark: 0 });
console.log(`empty before ${empty.readableHighWaterMark}`);
console.log(`empty read(1) ${empty.read(1)}`);
console.log(`empty after ${empty.readableHighWaterMark}`);

const data = new Readable({ read() {}, highWaterMark: 0 });
data.push("abcd");
console.log(`data read(4) ${String(data.read(4))}`);
console.log(`data after ${data.readableHighWaterMark}`);

const zero = new Readable({ read() {}, highWaterMark: 0 });
console.log(`zero read(0) ${zero.read(0)}`);
console.log(`zero after ${zero.readableHighWaterMark}`);

const one = new Readable({ read() {}, highWaterMark: 1 });
one.push("xyz");
console.log(`one read(3) ${String(one.read(3))}`);
console.log(`one after ${one.readableHighWaterMark}`);
