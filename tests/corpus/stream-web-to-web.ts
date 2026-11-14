// The node -> web adapters over native node streams: Readable.toWeb (the
// default stream and type 'bytes'), Writable.toWeb's writer, and
// Duplex.toWeb's pair, whose keys are Node's writable-then-readable.
import { Duplex, PassThrough, Readable, Writable } from "node:stream";

const log: string[] = [];

async function readAll(web: ReadableStream): Promise<void> {
  const reader = web.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    log.push(`chunk ${typeof value} ${String(value)}`);
  }
}

function stringsReadable(): Readable {
  return new Readable({
    read(): void {
      this.push("alpha");
      this.push("beta");
      this.push(null);
    },
  });
}

function bytesReadable(): Readable {
  return new Readable({
    read(): void {
      this.push(Buffer.from("one"));
      this.push(Buffer.from("two"));
      this.push(null);
    },
  });
}

function mkDuplex(): Duplex {
  return new Duplex({
    read(): void {
      this.push(null);
    },
    write(_chunk: Buffer, _enc: string, cb: () => void): void {
      cb();
    },
  });
}

async function main(): Promise<void> {
  const web = Readable.toWeb(stringsReadable());
  log.push(`readable locked ${String(web.locked)}`);
  await readAll(web);

  // A Buffer chunk is copied out of its pool unless the stream is in object
  // mode, so the default stream delivers a Uint8Array.
  await readAll(Readable.toWeb(bytesReadable()));
  await readAll(Readable.toWeb(bytesReadable(), { type: "bytes" }));

  const written: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void): void {
      written.push(String(chunk));
      cb();
    },
  });
  const webSink = Writable.toWeb(sink);
  const writer = webSink.getWriter();
  await writer.write(new TextEncoder().encode("one"));
  log.push(`written ${written.join(",")}`);
  await writer.close();
  log.push(`ended ${String(sink.writableEnded)} finished ${String(sink.writableFinished)}`);

  const pt = new PassThrough();
  const pair = Duplex.toWeb(pt);
  log.push(`pair keys ${Object.keys(pair).join(",")}`);
  const reader = pair.readable.getReader();
  const pairWriter = pair.writable.getWriter();
  await pairWriter.write(new TextEncoder().encode("ping"));
  const echo = await reader.read();
  log.push(`echo ${String(echo.value)}`);
  await pairWriter.close();
  const eof = await reader.read();
  log.push(`eof ${String(eof.done)}`);

  const gone = mkDuplex();
  gone.destroy();
  const gonePair = Duplex.toWeb(gone);
  const goneRead = await gonePair.readable.getReader().read();
  log.push(`destroyed eof ${String(goneRead.done)}`);

  for (const line of log) console.log(line);
}

void main();
