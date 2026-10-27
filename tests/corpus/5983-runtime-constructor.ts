// x.constructor on instances of EventEmitter and the stream classes:
// .name is the class Node reports (fs, zlib and program subclasses
// included), === compares with the instance's own class, and the value
// is the class object for EventEmitter and the stream classes.
import { EventEmitter } from "node:events";
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";
import * as fs from "node:fs";
import * as zlib from "node:zlib";

class Bus extends EventEmitter {}

const emitter = new EventEmitter();
const bus: EventEmitter = new Bus();
console.log("emitter", emitter.constructor === EventEmitter, emitter.constructor.name);
console.log("subclass", bus.constructor === EventEmitter, bus.constructor.name);

const streams: Readable[] = [new Readable(), new Duplex(), new Transform(), new PassThrough()];
for (const s of streams) {
  console.log(
    "stream",
    s.constructor.name,
    s.constructor === Readable,
    s.constructor === Duplex,
    s.constructor === Transform,
    s.constructor === PassThrough,
    s.constructor !== Readable,
  );
}

const from = Readable.from(["a"]);
console.log("from", from.constructor.name, from.constructor === Readable);

const readStream: Readable = fs.createReadStream(import.meta.filename);
const writeStream: Writable = fs.createWriteStream("/dev/null");
console.log("fs", readStream.constructor.name, readStream.constructor === Readable);
console.log("fs", writeStream.constructor.name, writeStream.constructor === Writable);
readStream.destroy();
writeStream.destroy();

const gzip: Transform = zlib.createGzip();
const inflate: Transform = zlib.createInflateRaw();
console.log("zlib", gzip.constructor.name, inflate.constructor.name, gzip.constructor === Transform);

const kinds: EventEmitter[] = [new EventEmitter(), new Writable(), new PassThrough()];
for (const k of kinds) {
  const Kind = k.constructor as typeof EventEmitter;
  console.log("value", Kind.name, Kind === EventEmitter, k instanceof Kind, new Kind() instanceof EventEmitter);
}
