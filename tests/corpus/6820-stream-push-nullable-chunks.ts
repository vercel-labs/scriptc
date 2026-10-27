// Readable subclasses pushing `string | null` and `Buffer | null` chunks, a
// conditional `push(done ? null : chunk)`, and writes of `string | Buffer`
// chunks.
import { Readable, Writable } from "node:stream";

class Lines extends Readable {
  private index = 0;
  private readonly lines: string[];
  constructor(lines: string[]) {
    super();
    this.lines = lines;
  }
  next(): string | null {
    return this.index < this.lines.length ? this.lines[this.index++]! : null;
  }
  _read(): void {
    const line: string | null = this.next();
    this.push(line);
  }
}

class Blocks extends Readable {
  private sent = 0;
  _read(): void {
    const block: Buffer | null = this.sent < 3 ? Buffer.from([65 + this.sent, 10]) : null;
    this.sent++;
    this.push(block);
  }
}

class Countdown extends Readable {
  private left: number;
  constructor(left: number) {
    super({ encoding: "utf8" });
    this.left = left;
  }
  _read(): void {
    this.left--;
    this.push(this.left < 0 ? null : `t-${this.left} `);
  }
}

function collect(label: string, stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    const parts: string[] = [];
    stream.on("data", (chunk: Buffer | string) =>
      parts.push(typeof chunk === "string" ? chunk : chunk.toString()),
    );
    stream.on("end", () => {
      console.log(label, JSON.stringify(parts.join("")), parts.length);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  await collect("lines", new Lines(["a\n", "bb\n", "ccc\n"]));
  await collect("empty lines", new Lines([]));
  await collect("blocks", new Blocks());
  await collect("countdown", new Countdown(3));

  const written: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });
  const pieces: (string | Buffer)[] = ["x", Buffer.from("y"), "z"];
  for (const piece of pieces) {
    const chunk: string | Buffer = piece;
    console.log("write", Buffer.isBuffer(chunk) ? "buffer" : "string", sink.write(chunk));
  }
  sink.end(() => console.log("written", JSON.stringify(written.join(""))));
}

void main();
