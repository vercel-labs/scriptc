// Batched writes in typed code: the writev option and the _writev method
// on Writable and Duplex. Writes buffered behind a write in flight or a
// cork reach writev as one [{ chunk, encoding }] batch whose callback
// runs the writes' callbacks in order; a stream with only writev sends
// each lone write as a batch of one; a later `stream._writev = fn`
// takes over; an object-mode side batches its values.
import { EventEmitter } from "node:events";
import { Duplex, Writable } from "node:stream";

interface Entry {
  chunk: Buffer;
  encoding: string;
}

interface ValueEntry {
  chunk: unknown;
  encoding: string | undefined;
}

const log: string[] = [];

function finished(stream: EventEmitter): Promise<void> {
  return new Promise((resolve) => stream.on("finish", () => resolve()));
}

class Batcher extends Writable {
  _write(chunk: Buffer, _enc: string, cb: (error?: Error | null) => void): void {
    log.push("batcher write " + chunk.toString());
    setTimeout(cb, 1);
  }
  _writev(chunks: Entry[], cb: (error?: Error | null) => void): void {
    log.push(`batcher writev ${chunks.map((c) => c.chunk.toString() + "/" + c.encoding).join(",")}`);
    setTimeout(cb, 1);
  }
}

class Echo extends Duplex {
  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: (error?: Error | null) => void): void {
    this.push(chunk);
    cb();
  }
  _writev(chunks: Entry[], cb: (error?: Error | null) => void): void {
    this.push(Buffer.concat(chunks.map((c) => c.chunk)));
    cb();
  }
  _final(cb: (error?: Error | null) => void): void {
    this.push(null);
    cb();
  }
}

async function main(): Promise<void> {
  const batcher = new Batcher();
  batcher.write("a", () => log.push("a done"));
  batcher.write("b", () => log.push("b done"));
  batcher.write("c");
  batcher.write(Buffer.from("d"), () => log.push("d done"));
  batcher.end(() => log.push("batcher end"));
  await finished(batcher);

  const corked = new Writable({
    writev(chunks: Entry[], cb: (error?: Error | null) => void) {
      log.push(`corked ${chunks.length}: ${chunks.map((c) => c.chunk.toString("hex")).join(" ")}`);
      cb();
    },
  });
  corked.cork();
  corked.write("x");
  corked.write("ff", "hex");
  corked.write("y");
  corked.uncork();
  corked.write("z", () => log.push("z done"));
  corked.end();
  await finished(corked);

  const late = new Writable({
    write(c: Buffer, _e: string, cb: () => void) {
      log.push("late write " + c.toString());
      cb();
    },
  });
  late._writev = (chunks: Entry[], cb: (error?: Error | null) => void) => {
    log.push("late writev " + chunks.length);
    cb();
  };
  late.cork();
  late.write("1");
  late.write("2");
  late.uncork();
  late.end();
  await finished(late);

  const echo = new Echo();
  const echoed: string[] = [];
  echo.on("data", (c: Buffer) => echoed.push(c.toString()));
  echo.cork();
  echo.write("e1");
  echo.write("e2");
  process.nextTick(() => {
    echo.uncork();
    echo.end("e3");
  });
  await new Promise((resolve) => echo.on("end", resolve));
  log.push("echoed " + echoed.join(","));

  const values = new Writable({
    objectMode: true,
    writev(chunks: ValueEntry[], cb: (error?: Error | null) => void) {
      log.push(
        "values " + chunks.map((c) => `${JSON.stringify(c.chunk)}/${String(c.encoding)}`).join(","),
      );
      cb();
    },
  });
  values.cork();
  values.write({ n: 1 });
  values.write([2], "utf8");
  values.uncork();
  values.end();
  await finished(values);
  console.log(log.join("\n"));
}
main();
