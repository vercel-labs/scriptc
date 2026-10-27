// Classes extending Node builtin bases (Writable, Transform, EventEmitter)
// used as values: through a variable, a generic factory, an object table and
// an array, with instanceof against the class and its base.
import { EventEmitter } from "node:events";
import { Readable, Transform, Writable } from "node:stream";

class Sink extends Writable {
  readonly lines: string[] = [];
  private readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.lines.push(this.tag + chunk.toString());
    cb();
  }
}

class Upper extends Transform {
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: string) => void): void {
    cb(null, chunk.toString().toUpperCase());
  }
}

class Ticker extends EventEmitter {
  count = 0;
  tick(): void {
    this.count++;
    this.emit("tick", this.count);
  }
}

class Plain extends EventEmitter {}

function build<T>(ctor: new () => T): T {
  return new ctor();
}

const SinkClass = Sink;
const s = new SinkClass("> ");
s.write("a");
s.end("b", () => console.log("sink", JSON.stringify(s.lines), s instanceof Sink, s instanceof Writable));

const t = build(Ticker);
t.on("tick", (n: number) => console.log("tick", n));
t.tick();
t.tick();
console.log("ticker", t instanceof Ticker, t instanceof EventEmitter, t.count);

const p = build(Plain);
p.on("x", () => console.log("plain x"));
p.emit("x");

const registry = { upper: Upper };
const u = new registry.upper();
u.on("data", (d: Buffer) => console.log("upper", d.toString()));
u.end("hello");

const kinds = [Ticker, Ticker];
console.log("names", kinds.map((k) => k.name).join(","), typeof Sink, Sink.name);
const r = Readable.from(["x"]);
console.log("readable", r instanceof Readable);
