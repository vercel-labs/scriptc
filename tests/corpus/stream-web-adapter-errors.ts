// The five web-stream statics' argument and option validation: Node's
// message, code, and order for a wrong stream, a wrong options bag, and a
// wrong option value. Every call gets a fresh stream, because a rejected
// adaptation can still lock one.
import { Duplex, Readable, Writable } from "node:stream";

function report(label: string, f: () => unknown): void {
  try {
    const value = f();
    console.log(label, "ok", typeof value);
  } catch (e: any) {
    console.log(label, "err", e.name, e.code, "|", e.message);
  }
}

function mkReadable(): Readable {
  return new Readable({
    read(): void {
      this.push(null);
    },
  });
}

function mkWritable(): Writable {
  return new Writable({
    write(_chunk: Buffer, _enc: string, cb: () => void): void {
      cb();
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

function mkPair(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>();
}

report("readable.toWeb(number)", () => Readable.toWeb(42 as any));
report("readable.toWeb(writable)", () => Readable.toWeb(mkWritable() as any));
report("readable.toWeb(null)", () => Readable.toWeb(null as any));
report("readable.toWeb(undefined)", () => Readable.toWeb(undefined as any));
report("readable.toWeb(text type)", () => Readable.toWeb(mkReadable(), { type: "text" } as any));
report("readable.toWeb(number type)", () => Readable.toWeb(mkReadable(), { type: 1 } as any));
report("readable.toWeb(array options)", () => Readable.toWeb(mkReadable(), [] as any));
report("readable.toWeb(null options)", () => Readable.toWeb(mkReadable(), null as any));

report("writable.toWeb(readable)", () => Writable.toWeb(mkReadable() as any));
report("writable.toWeb(null)", () => Writable.toWeb(null as any));
report("writable.toWeb(number)", () => Writable.toWeb(7 as any));

report("duplex.toWeb(writable)", () => Duplex.toWeb(mkWritable() as any));
report("duplex.toWeb(readable)", () => Duplex.toWeb(mkReadable() as any));
report("duplex.toWeb(undefined)", () => Duplex.toWeb(undefined as any));
report("duplex.toWeb(text type)", () => Duplex.toWeb(mkDuplex(), { type: "text" } as any));
report("duplex.toWeb(text readableType)", () =>
  Duplex.toWeb(mkDuplex(), { readableType: "text" } as any));

report("writable.fromWeb(null)", () => Writable.fromWeb(null as any));
report("writable.fromWeb(readableStream)", () => Writable.fromWeb(new ReadableStream() as any));
report("writable.fromWeb(number objectMode)", () =>
  Writable.fromWeb(new WritableStream(), { objectMode: 1 } as any));
report("writable.fromWeb(string decodeStrings)", () =>
  Writable.fromWeb(new WritableStream(), { decodeStrings: "no" } as any));
report("writable.fromWeb(string highWaterMark)", () =>
  Writable.fromWeb(new WritableStream(), { highWaterMark: "1" } as any));
report("writable.fromWeb(array options)", () => Writable.fromWeb(new WritableStream(), [] as any));

report("duplex.fromWeb(undefined)", () => Duplex.fromWeb(undefined as any));
report("duplex.fromWeb(null)", () => Duplex.fromWeb(null as any));
report("duplex.fromWeb({})", () => Duplex.fromWeb({} as any));
report("duplex.fromWeb({readable:1})", () => Duplex.fromWeb({ readable: 1 } as any));
report("duplex.fromWeb({readable:stream})", () =>
  Duplex.fromWeb({ readable: new ReadableStream() } as any));
report("duplex.fromWeb(transformStream)", () => Duplex.fromWeb(mkPair() as any));
report("duplex.fromWeb(unknown encoding)", () => {
  const ts = mkPair();
  return Duplex.fromWeb({ readable: ts.readable, writable: ts.writable }, { encoding: "x" } as any);
});
report("duplex.fromWeb(string objectMode)", () => {
  const ts = mkPair();
  return Duplex.fromWeb(
    { readable: ts.readable, writable: ts.writable },
    { objectMode: "yes" } as any,
  );
});
