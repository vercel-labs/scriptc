// Stream subclasses that declare their completion callbacks with the broad
// `Function` type: the runtime's callable arrives and calls through it
// complete the chunk, pass data, or fail the stream.
import { Transform, Writable } from "node:stream";

class Prefixer extends Transform {
  _s: string;
  constructor() {
    super();
    this._s = "";
  }
  _transform(c: Buffer, _: string, cb: Function) {
    const text = c.toString();
    const lines = text.split("\n").map((line, index, all) => {
      if (index === 0) return this._s === "" || this._s.endsWith("\n") ? "> " + line : line;
      if (index === all.length - 1) return line !== "" ? "> " + line : line;
      return "> " + line;
    });
    this._s += text;
    this.push(lines.join("\n"));
    cb();
  }
}

class Upper extends Transform {
  _transform(chunk: Buffer, _encoding: string, cb: Function) {
    if (chunk.toString() === "bad") {
      cb(new Error("bad chunk"));
      return;
    }
    cb(null, chunk.toString().toUpperCase());
  }
  _flush(cb: Function) {
    this.push("!");
    cb();
  }
}

class Sink extends Writable {
  seen: string[] = [];
  _write(chunk: Buffer, _encoding: string, cb: Function) {
    this.seen.push(chunk.toString());
    cb();
  }
  _final(cb: Function) {
    this.seen.push("<final>");
    cb();
  }
}

const prefixer = new Prefixer();
prefixer.pipe(process.stdout);
prefixer.write("a\nb");
prefixer.write("c\n");
prefixer.end("d\n");

const sink = new Sink();
const upper = new Upper();
upper.pipe(sink);
sink.on("finish", () => console.log("sink", JSON.stringify(sink.seen)));
upper.write("a");
upper.end("b");

const bad = new Upper();
bad.on("error", (err: Error) => console.log("error", err.message));
bad.write("bad");
