// The web -> node adapters: Writable.fromWeb's chunk shapes (decodeStrings,
// objectMode, highWaterMark), its close after the node finish, and
// Duplex.fromWeb over a TransformStream pair, its allowHalfOpen option and
// an aborted signal. Every section prints what it saw before the next one
// starts, so the order is the program's own.
import { Duplex, Writable } from "node:stream";

const out = (line: string): void => console.log(line);

function pair(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      controller.enqueue(chunk);
    },
  });
}

async function main(): Promise<void> {
  const seen: string[] = [];
  const closed: string[] = [];
  const w = Writable.fromWeb(
    new WritableStream<Uint8Array>({
      write(chunk): void {
        seen.push(`${typeof chunk} ${String(chunk)}`);
      },
      close(): void {
        closed.push("closed");
      },
    }),
  );
  const finished = new Promise<void>((resolve) => w.on("finish", () => resolve()));
  w.write("a");
  w.write("b");
  w.end("c");
  await finished;
  out(`seen ${seen.join(",")}`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  out(`closed ${closed.join(",")}`);
  out(`hwm ${w.writableHighWaterMark} objectMode ${String(w.writableObjectMode)}`);

  const raw: string[] = [];
  const noDecode = Writable.fromWeb(
    new WritableStream<string>({
      write(chunk): void {
        raw.push(`${typeof chunk} ${String(chunk)}`);
      },
    }),
    { decodeStrings: false },
  );
  const rawFinished = new Promise<void>((resolve) => noDecode.on("finish", () => resolve()));
  noDecode.end("plain");
  await rawFinished;
  out(`raw ${raw.join(",")}`);

  const objects: string[] = [];
  const objectMode = Writable.fromWeb(
    new WritableStream<unknown>({
      write(chunk): void {
        objects.push(`${typeof chunk} ${JSON.stringify(chunk)}`);
      },
    }),
    { objectMode: true, highWaterMark: 3 },
  );
  const objectFinished = new Promise<void>((resolve) => objectMode.on("finish", () => resolve()));
  objectMode.write({ id: 1 });
  objectMode.write("text");
  objectMode.end([2, 3]);
  await objectFinished;
  out(`objects ${objects.join(",")}`);
  out(`object hwm ${objectMode.writableHighWaterMark} objectMode ${String(objectMode.writableObjectMode)}`);

  const ts = pair();
  const d = Duplex.fromWeb({ readable: ts.readable, writable: ts.writable });
  const got: string[] = [];
  d.on("data", (chunk: unknown) => got.push(String(chunk)));
  const firstData = new Promise<void>((resolve) => d.once("data", () => resolve()));
  d.write("round");
  await firstData;
  const ended = new Promise<void>((resolve) => d.on("end", () => resolve()));
  d.end();
  await ended;
  out(`duplex ${got.join(",")}`);
  out(`duplex ended ${String(d.writableEnded)} ${String(d.readableEnded)} ${String(d.readableObjectMode)}`);

  const ts2 = pair();
  const d2 = Duplex.fromWeb(
    { readable: ts2.readable, writable: ts2.writable },
    { allowHalfOpen: true },
  );
  let d2Ended = false;
  d2.on("end", () => {
    d2Ended = true;
  });
  d2.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  out(
    `half open ${String(d2.writableEnded)} ${String(d2.readableEnded)} ${String(d2Ended)} ${String(d2.destroyed)}`,
  );
  d2.destroy();

  const ac = new AbortController();
  const ts3 = pair();
  const d3 = Duplex.fromWeb({ readable: ts3.readable, writable: ts3.writable }, { signal: ac.signal });
  const aborted = new Promise<void>((resolve) => d3.on("close", () => resolve()));
  d3.on("error", (e: Error) => out(`abort ${e.name} ${String(e.message)}`));
  ac.abort();
  await aborted;
  out("abort close");
}

void main();
